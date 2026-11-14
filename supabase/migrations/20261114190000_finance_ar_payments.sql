-- Finance (server-authoritative): customer invoices, Universal Thai QR payment requests, payment evidence (slips),
-- verification, receipts, allocations and an append-only audit trail.
--
-- Principles
--   * The database is the only authority for amounts. Outstanding = invoice.amount − active allocations, computed here.
--     Nothing the app sends (amount on a QR, amount a customer types) settles an invoice.
--   * Three levels of payment information are kept apart:
--       evidence  (customer-submitted slip; never settles anything on its own)
--       verified  (checked by authorised staff, later by a slip-verification provider: verified_via = staff | provider | bank)
--       receipt   (money recorded as received; only created from verified evidence)
--   * Financial rows are never deleted or edited in place: receipts are reversed, allocations are deactivated,
--     invoices are cancelled (only while nothing is allocated). Every change writes finance_events.
--   * Clients have SELECT only (RLS: staff see all, a customer sees their own). Every write goes through the
--     SECURITY DEFINER functions below, which check the caller's finance role, lock rows and run in one transaction.
--   * Overpayment is never applied automatically: the receipt is recorded unallocated and flagged for review.
--
-- Roles (finance_staff_roles; a SUPER_ADMIN profile is always 'manager'). Each includes the ones before it:
--   viewer    see invoices, payments, evidence
--   clerk     + customers, invoices, payment requests on a customer's behalf
--   verifier  + verify / reject evidence, resolve overpayments
--   manager   + reverse receipts, cancel invoices, payment account (QR), roles

-- ---------------------------------------------------------------------------------------------- roles
create table if not exists public.finance_staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer', 'clerk', 'verifier', 'manager')),
  granted_by uuid default auth.uid(),
  granted_at timestamptz not null default now()
);

create or replace function public.finance_role()
returns text language sql stable security definer set search_path = public as $$
  select case when p.role = 'SUPER_ADMIN' then 'manager'
              else (select r.role from public.finance_staff_roles r where r.user_id = p.id) end
  from public.profiles p where p.id = auth.uid() and p.status = 'active'
$$;

create or replace function public.finance_can(p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(array_position(array['viewer', 'clerk', 'verifier', 'manager'], public.finance_role())
    >= case p_cap when 'view' then 1 when 'invoice' then 2 when 'verify' then 3 when 'manage' then 4 else 99 end, false)
$$;

create or replace function public.finance_require(p_cap text, p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.finance_can(p_cap) then raise exception 'You are not allowed to %', p_what using errcode = '42501'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------- Thai QR (EMVCo) helpers
-- CRC-16/CCITT-FALSE over the UTF-8 bytes, as used by Thai QR Payment / PromptPay.
create or replace function public.finance_crc16(p text)
returns text language plpgsql immutable set search_path = public as $$
declare b bytea := convert_to(p, 'UTF8'); crc integer := 65535; i integer; j integer;
begin
  for i in 0 .. length(b) - 1 loop
    crc := crc # (get_byte(b, i) << 8);
    for j in 1 .. 8 loop
      if (crc & 32768) <> 0 then crc := ((crc << 1) # 4129) & 65535; else crc := (crc << 1) & 65535; end if;
    end loop;
  end loop;
  return upper(lpad(to_hex(crc), 4, '0'));
end $$;

-- Top-level TLV fields of a QR payload, in order.
create or replace function public.finance_qr_fields(p text)
returns table (pos integer, tag text, val text) language plpgsql immutable set search_path = public as $$
declare i integer := 1; n integer := length(p); l integer; k integer := 0;
begin
  while i <= n loop
    if i + 3 > n or substr(p, i, 4) !~ '^[0-9]{4}$' then raise exception 'Not a Thai QR payment code' using errcode = '22023'; end if;
    l := substr(p, i + 2, 2)::integer;
    if i + 3 + l > n then raise exception 'Not a Thai QR payment code' using errcode = '22023'; end if;
    k := k + 1; pos := k; tag := substr(p, i, 2); val := substr(p, i + 4, l);
    return next;
    i := i + 4 + l;
  end loop;
end $$;

-- Validate a shop payment QR (decoded from the uploaded picture) and describe the receiving account.
create or replace function public.finance_qr_describe(p text)
returns jsonb language plpgsql immutable set search_path = public as $$
declare f jsonb; acct text; kind text; sub jsonb; target text;
begin
  if p is null or length(p) not between 20 and 512 or p !~ '^[\x20-\x7E]+$' then raise exception 'Not a Thai QR payment code' using errcode = '22023'; end if;
  if left(p, 6) <> '000201' or right(p, 8) !~ '^6304[0-9A-F]{4}$' then raise exception 'Not a Thai QR payment code' using errcode = '22023'; end if;
  if public.finance_crc16(left(p, length(p) - 4)) <> right(p, 4) then
    raise exception 'The QR checksum is wrong (the picture may be damaged or edited)' using errcode = '22023'; end if;
  select jsonb_object_agg(tag, val) into f from public.finance_qr_fields(p);
  if f ->> '00' is distinct from '01' or f ->> '53' is distinct from '764' or f ->> '58' is distinct from 'TH' then
    raise exception 'This is not a Thai baht payment QR' using errcode = '22023'; end if;
  if f ? '29' then acct := f ->> '29'; kind := 'promptpay';
  elsif f ? '30' then acct := f ->> '30'; kind := 'bill_payment';
  else raise exception 'This QR has no PromptPay or Thai QR bill payment account' using errcode = '22023'; end if;
  select jsonb_object_agg(tag, val) into sub from public.finance_qr_fields(acct);
  if kind = 'promptpay' and (sub ->> '00') is distinct from 'A000000677010111' then raise exception 'Unknown PromptPay application id' using errcode = '22023'; end if;
  if kind = 'bill_payment' and (sub ->> '00') is distinct from 'A000000677010112' then raise exception 'Unknown Thai QR bill payment application id' using errcode = '22023'; end if;
  target := coalesce(sub ->> '01', sub ->> '02', sub ->> '03');
  if target is null then raise exception 'The QR has no receiving account' using errcode = '22023'; end if;
  return jsonb_build_object('kind', kind, 'target', target,
    'target_type', case when kind = 'bill_payment' then 'biller_id' when sub ? '01' then 'phone' when sub ? '02' then 'national_id' else 'e_wallet' end,
    'ref1', sub ->> '02', 'merchant_name', f ->> '59', 'has_amount', f ? '54');
end $$;

-- The shop's QR with a fixed amount: same account fields, point of initiation = dynamic (12), tag 54 = amount, new CRC.
create or replace function public.finance_qr_with_amount(p text, p_amount numeric)
returns text language plpgsql immutable set search_path = public as $$
declare body text;
begin
  perform public.finance_qr_describe(p);
  if p_amount is null or p_amount <= 0 or p_amount > 9999999999.99 or p_amount <> round(p_amount, 2) then raise exception 'Invalid QR amount' using errcode = '22023'; end if;
  select string_agg(t || lpad(length(v)::text, 2, '0') || v, '' order by t) into body from (
    select tag as t, val as v from public.finance_qr_fields(p) where tag not in ('01', '54', '63')
    union all select '01', '12'
    union all select '54', to_char(p_amount, 'FM9999999990.00')
  ) x;
  body := body || '6304';
  return body || public.finance_crc16(body);
end $$;

-- ---------------------------------------------------------------------------------------------- tables
create table if not exists public.finance_payment_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(label) between 1 and 80),
  qr_payload text not null,
  kind text not null check (kind in ('promptpay', 'bill_payment')),
  target text not null,
  target_type text not null,
  merchant_name text,
  is_default boolean not null default false,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists finance_payment_accounts_default on public.finance_payment_accounts ((true)) where is_default and active;

create table if not exists public.finance_customers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(code) between 1 and 40),
  name text not null check (length(name) between 1 and 200),
  tax_id text check (tax_id is null or tax_id ~ '^[0-9]{13}$'),
  billing_address text check (billing_address is null or length(billing_address) <= 500),
  profile_id uuid unique references public.profiles(id) on delete set null,  -- the customer's app sign-in, if any
  local_customer_id text,                                                     -- record id in the app's local store (migration bridge)
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create sequence if not exists public.finance_invoice_seq;
create sequence if not exists public.finance_receipt_seq;

create table if not exists public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_no text not null unique,
  customer_id uuid not null references public.finance_customers(id) on delete restrict,
  issue_date date not null,
  due_date date not null,
  amount numeric(14, 2) not null check (amount > 0),        -- original amount: never changed
  description text check (description is null or length(description) <= 500),
  source_ref text check (source_ref is null or length(source_ref) <= 80),  -- e.g. the order number it bills
  status text not null default 'open' check (status in ('open', 'cancelled')),
  cancelled_by uuid, cancelled_at timestamptz, cancel_reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (due_date >= issue_date)
);
create index if not exists finance_invoices_customer_idx on public.finance_invoices (customer_id, issue_date desc);

create table if not exists public.finance_payment_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,                                   -- unguessable payment reference shown on the QR image
  invoice_id uuid not null references public.finance_invoices(id) on delete restrict,
  customer_id uuid not null references public.finance_customers(id) on delete restrict,
  account_id uuid not null references public.finance_payment_accounts(id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),         -- outstanding when the QR was made (expectation only)
  qr_payload text not null,
  status text not null default 'awaiting' check (status in ('awaiting', 'superseded', 'cancelled')),
  expires_at timestamptz not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists finance_payment_requests_invoice_idx on public.finance_payment_requests (invoice_id, created_at desc);

create table if not exists public.finance_payment_evidence (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.finance_invoices(id) on delete restrict,
  customer_id uuid not null references public.finance_customers(id) on delete restrict,
  request_id uuid references public.finance_payment_requests(id) on delete restrict,
  file_path text not null,                                    -- private bucket payment-evidence
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_type text not null check (file_type in ('image/jpeg', 'image/png', 'application/pdf')),
  claimed_amount numeric(14, 2) not null check (claimed_amount > 0),   -- what the customer says: never used to settle
  claimed_transfer_at timestamptz,
  claimed_bank text check (claimed_bank is null or length(claimed_bank) <= 60),
  claimed_ref text check (claimed_ref is null or length(claimed_ref) <= 80),
  status text not null default 'submitted' check (status in ('submitted', 'verified', 'rejected')),
  verified_via text check (verified_via in ('staff', 'provider', 'bank')),
  verified_amount numeric(14, 2) check (verified_amount > 0),
  bank_trans_ref text check (bank_trans_ref is null or length(bank_trans_ref) between 4 and 80),
  transfer_at timestamptz,
  sender_name text, receiver_account text,
  review_note text, reject_reason text,
  reviewed_by uuid, reviewed_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
-- the same file can be pending or accepted only once; the same bank transaction can be accepted only once
create unique index if not exists finance_evidence_file_once on public.finance_payment_evidence (file_sha256) where status <> 'rejected';
create unique index if not exists finance_evidence_transref_once on public.finance_payment_evidence (bank_trans_ref) where status = 'verified';
create index if not exists finance_evidence_queue_idx on public.finance_payment_evidence (status, created_at);

create table if not exists public.finance_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_no text not null unique,
  customer_id uuid not null references public.finance_customers(id) on delete restrict,
  invoice_id uuid not null references public.finance_invoices(id) on delete restrict,  -- the invoice it was paid for
  evidence_id uuid not null unique references public.finance_payment_evidence(id) on delete restrict,  -- one receipt per evidence (idempotent)
  amount numeric(14, 2) not null check (amount > 0),          -- actual amount received (verified)
  method text not null default 'promptpay_transfer',
  bank_trans_ref text unique,
  received_at timestamptz not null,
  needs_review boolean not null default false,                -- overpayment waiting for a decision
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  reversed_by uuid, reversed_at timestamptz, reverse_reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.finance_allocations (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.finance_receipts(id) on delete restrict,
  invoice_id uuid not null references public.finance_invoices(id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  deactivated_by uuid, deactivated_at timestamptz, deactivate_reason text
);
create index if not exists finance_allocations_invoice_idx on public.finance_allocations (invoice_id) where active;

create table if not exists public.finance_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  actor_email text,
  entity text not null,
  entity_id uuid not null,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists finance_events_entity_idx on public.finance_events (entity, entity_id, at);

-- Original amounts and identities are fixed once written (defence in depth: there are no client write policies anyway).
-- (one function per table: PL/pgSQL resolves every record field in an IF, so a shared function cannot mix columns)
create or replace function public.finance_guard_invoice()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.amount is distinct from old.amount or new.customer_id is distinct from old.customer_id or new.invoice_no is distinct from old.invoice_no then
    raise exception 'An invoice amount, customer or number cannot be changed (cancel and re-issue instead)'; end if;
  return new;
end $$;
create or replace function public.finance_guard_receipt()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.amount is distinct from old.amount or new.invoice_id is distinct from old.invoice_id or new.customer_id is distinct from old.customer_id then
    raise exception 'A receipt amount cannot be changed (reverse it instead)'; end if;
  return new;
end $$;
create or replace function public.finance_guard_allocation()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.amount is distinct from old.amount or new.receipt_id is distinct from old.receipt_id or new.invoice_id is distinct from old.invoice_id
     or (old.active = false and new.active = true) then
    raise exception 'An allocation cannot be changed (deactivate it and allocate again)'; end if;
  return new;
end $$;
drop trigger if exists finance_invoices_guard on public.finance_invoices;
create trigger finance_invoices_guard before update on public.finance_invoices for each row execute function public.finance_guard_invoice();
drop trigger if exists finance_receipts_guard on public.finance_receipts;
create trigger finance_receipts_guard before update on public.finance_receipts for each row execute function public.finance_guard_receipt();
drop trigger if exists finance_allocations_guard on public.finance_allocations;
create trigger finance_allocations_guard before update on public.finance_allocations for each row execute function public.finance_guard_allocation();

create or replace function public.finance_no_delete()
returns trigger language plpgsql as $$ begin raise exception 'Financial records are never deleted'; end $$;
do $$ declare t text; begin
  foreach t in array array['finance_invoices', 'finance_payment_requests', 'finance_payment_evidence', 'finance_receipts', 'finance_allocations', 'finance_events'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.finance_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------- helpers
create or replace function public.finance_log(p_entity text, p_id uuid, p_action text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.finance_events (entity, entity_id, action, detail, actor_email)
  values (p_entity, p_id, p_action, coalesce(p_detail, '{}'::jsonb), (select email from public.profiles where id = auth.uid()))
$$;

create or replace function public.finance_my_customer()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.finance_customers where profile_id = auth.uid()
$$;

-- Paid / outstanding / status of an invoice, from the ledger. Status codes follow the agreed 0–9 list:
-- 0 unpaid, 1 awaiting payment (QR made), 3 pending verification, 4 partially paid, 5 fully paid, 6 overpaid (review),
-- 7 last evidence rejected, 8 cancelled, 9 QR expired. (2 "submitted" is the moment of upload; it is shown as 3.)
create or replace function public.finance_invoice_state(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare inv public.finance_invoices; paid numeric; outstanding numeric; review boolean; pending integer; req public.finance_payment_requests;
        last_ev public.finance_payment_evidence; code integer; credit numeric;
begin
  select * into inv from public.finance_invoices where id = p_invoice;
  if not found then return null; end if;
  -- callable by clients: only the invoice's own customer or finance staff
  if inv.customer_id is distinct from public.finance_my_customer() and not public.finance_can('view') then return null; end if;
  select coalesce(sum(a.amount), 0) into paid from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id
    where a.invoice_id = p_invoice and a.active and r.status = 'posted';
  outstanding := inv.amount - paid;
  select exists (select 1 from public.finance_receipts where invoice_id = p_invoice and status = 'posted' and needs_review) into review;
  select coalesce(sum(r.amount - coalesce((select sum(a.amount) from public.finance_allocations a where a.receipt_id = r.id and a.active), 0)), 0) into credit
    from public.finance_receipts r where r.invoice_id = p_invoice and r.status = 'posted';
  select count(*) into pending from public.finance_payment_evidence where invoice_id = p_invoice and status = 'submitted';
  select * into req from public.finance_payment_requests where invoice_id = p_invoice and status = 'awaiting' order by created_at desc limit 1;
  select * into last_ev from public.finance_payment_evidence where invoice_id = p_invoice order by created_at desc limit 1;
  code := case
    when inv.status = 'cancelled' then 8
    when review then 6
    when outstanding <= 0 then 5
    when pending > 0 then 3
    when paid > 0 then 4
    when last_ev.id is not null and last_ev.status = 'rejected' and (req.id is null or req.created_at < last_ev.reviewed_at) then 7
    when req.id is not null and req.expires_at > now() then 1
    when req.id is not null then 9
    else 0 end;
  return jsonb_build_object('invoice_id', inv.id, 'amount', inv.amount, 'paid', paid, 'outstanding', greatest(outstanding, 0),
    'unapplied', credit, 'status_code', code,
    'status', (array['unpaid', 'awaiting_payment', 'payment_submitted', 'pending_verification', 'partially_paid', 'fully_paid', 'overpaid', 'rejected', 'cancelled', 'expired'])[code + 1],
    'pending_evidence', pending,
    'request', case when req.id is null then null else jsonb_build_object('ref', req.ref, 'amount', req.amount, 'qr_payload', req.qr_payload, 'expires_at', req.expires_at, 'expired', req.expires_at <= now()) end);
end $$;

-- ---------------------------------------------------------------------------------------------- staff: setup
create or replace function public.finance_save_payment_account(p_payload text, p_label text, p_make_default boolean default true)
returns public.finance_payment_accounts language plpgsql security definer set search_path = public as $$
declare d jsonb; a public.finance_payment_accounts;
begin
  perform public.finance_require('manage', 'set the shop payment account');
  d := public.finance_qr_describe(trim(p_payload));
  if coalesce(trim(p_label), '') = '' then raise exception 'Give the account a name'; end if;
  if p_make_default then update public.finance_payment_accounts set is_default = false where is_default; end if;
  insert into public.finance_payment_accounts (label, qr_payload, kind, target, target_type, merchant_name, is_default)
    values (trim(p_label), trim(p_payload), d ->> 'kind', d ->> 'target', d ->> 'target_type', d ->> 'merchant_name', p_make_default)
    returning * into a;
  perform public.finance_log('account', a.id, 'account.create', d || jsonb_build_object('label', a.label, 'default', p_make_default));
  return a;
end $$;

create or replace function public.finance_disable_payment_account(p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_require('manage', 'change the shop payment account');
  update public.finance_payment_accounts set active = false, is_default = false where id = p_account;
  if not found then raise exception 'Account not found'; end if;
  perform public.finance_log('account', p_account, 'account.disable');
end $$;

create or replace function public.finance_save_customer(p_id uuid, p_code text, p_name text, p_tax_id text, p_address text, p_profile uuid, p_local_id text)
returns public.finance_customers language plpgsql security definer set search_path = public as $$
declare c public.finance_customers;
begin
  perform public.finance_require('invoice', 'manage customers');
  if p_id is null then
    insert into public.finance_customers (code, name, tax_id, billing_address, profile_id, local_customer_id)
      values (trim(p_code), trim(p_name), nullif(trim(p_tax_id), ''), nullif(trim(p_address), ''), p_profile, nullif(trim(p_local_id), ''))
      returning * into c;
    perform public.finance_log('customer', c.id, 'customer.create', to_jsonb(c));
  else
    update public.finance_customers set code = trim(p_code), name = trim(p_name), tax_id = nullif(trim(p_tax_id), ''),
      billing_address = nullif(trim(p_address), ''), profile_id = p_profile, local_customer_id = nullif(trim(p_local_id), '')
      where id = p_id returning * into c;
    if not found then raise exception 'Customer not found'; end if;
    perform public.finance_log('customer', c.id, 'customer.update', to_jsonb(c));
  end if;
  return c;
end $$;

create or replace function public.finance_create_invoice(p_customer uuid, p_amount numeric, p_issue date, p_due date, p_description text, p_source_ref text)
returns public.finance_invoices language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices;
begin
  perform public.finance_require('invoice', 'issue invoices');
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Invoice amount must be a positive amount in baht and satang'; end if;
  if p_source_ref is not null and exists (select 1 from public.finance_invoices where source_ref = trim(p_source_ref) and status = 'open') then
    raise exception 'An open invoice already exists for %', p_source_ref using errcode = '23505'; end if;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref)
    values ('INV-' || to_char(coalesce(p_issue, current_date), 'YYYYMM') || '-' || lpad(nextval('public.finance_invoice_seq')::text, 5, '0'),
            p_customer, coalesce(p_issue, current_date), coalesce(p_due, coalesce(p_issue, current_date)), p_amount,
            nullif(trim(p_description), ''), nullif(trim(p_source_ref), ''))
    returning * into i;
  perform public.finance_log('invoice', i.id, 'invoice.issue', jsonb_build_object('no', i.invoice_no, 'amount', i.amount, 'customer', i.customer_id));
  return i;
end $$;

create or replace function public.finance_cancel_invoice(p_invoice uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices;
begin
  perform public.finance_require('manage', 'cancel invoices');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into i from public.finance_invoices where id = p_invoice for update;
  if not found then raise exception 'Invoice not found'; end if;
  if i.status <> 'open' then raise exception 'Invoice is already %', i.status; end if;
  if exists (select 1 from public.finance_allocations where invoice_id = p_invoice and active)
     or exists (select 1 from public.finance_receipts where invoice_id = p_invoice and status = 'posted') then
    raise exception 'Payments are recorded on this invoice: reverse them first'; end if;
  update public.finance_invoices set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = trim(p_reason) where id = p_invoice;
  update public.finance_payment_requests set status = 'cancelled' where invoice_id = p_invoice and status = 'awaiting';
  perform public.finance_log('invoice', p_invoice, 'invoice.cancel', jsonb_build_object('reason', trim(p_reason)));
end $$;

-- ---------------------------------------------------------------------------------------------- customer (or clerk on their behalf)
-- Make a payment QR for what is still owed. The amount comes from the ledger, never from the caller.
create or replace function public.finance_request_payment(p_invoice uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices; st jsonb; acct public.finance_payment_accounts; r public.finance_payment_requests; amt numeric;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into i from public.finance_invoices where id = p_invoice for update;
  if not found or (i.customer_id is distinct from public.finance_my_customer() and not public.finance_can('invoice')) then
    raise exception 'Invoice not found' using errcode = '42501'; end if;
  if i.status <> 'open' then raise exception 'This invoice is %', i.status; end if;
  st := public.finance_invoice_state(p_invoice);
  amt := (st ->> 'outstanding')::numeric;
  if amt <= 0 then raise exception 'Nothing is outstanding on this invoice'; end if;
  if (st ->> 'status_code')::int = 6 then raise exception 'A payment on this invoice is being reviewed'; end if;
  select * into acct from public.finance_payment_accounts where is_default and active;
  if not found then raise exception 'The shop has not set up a payment account yet'; end if;
  update public.finance_payment_requests set status = 'superseded' where invoice_id = p_invoice and status = 'awaiting';
  insert into public.finance_payment_requests (ref, invoice_id, customer_id, account_id, amount, qr_payload, expires_at)
    values ('PR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 14)), p_invoice, i.customer_id, acct.id, amt,
            public.finance_qr_with_amount(acct.qr_payload, amt), now() + interval '24 hours')
    returning * into r;
  perform public.finance_log('request', r.id, 'request.create', jsonb_build_object('invoice', p_invoice, 'ref', r.ref, 'amount', amt));
  return jsonb_build_object('ref', r.ref, 'amount', r.amount, 'qr_payload', r.qr_payload, 'expires_at', r.expires_at,
    'account_label', acct.label, 'merchant_name', acct.merchant_name);
end $$;

-- Submit payment evidence. Only records what the customer claims; it settles nothing.
create or replace function public.finance_submit_evidence(p_invoice uuid, p_file_path text, p_sha256 text, p_file_type text,
  p_claimed_amount numeric, p_transfer_at timestamptz, p_bank text, p_ref text)
returns uuid language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices; e uuid; req uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into i from public.finance_invoices where id = p_invoice for update;
  if not found or (i.customer_id is distinct from public.finance_my_customer() and not public.finance_can('invoice')) then
    raise exception 'Invoice not found' using errcode = '42501'; end if;
  if i.status <> 'open' then raise exception 'This invoice is %', i.status; end if;
  -- the file must be in the caller's own folder of the private bucket
  if p_file_path is null or split_part(p_file_path, '/', 1) <> auth.uid()::text or p_file_path ~ '\.\.' then raise exception 'Invalid file' using errcode = '22023'; end if;
  if (select count(*) from public.finance_payment_evidence where invoice_id = p_invoice and status = 'submitted') >= 5 then
    raise exception 'Several slips for this invoice are already waiting to be checked'; end if;
  if exists (select 1 from public.finance_payment_evidence where file_sha256 = lower(p_sha256) and status <> 'rejected') then
    raise exception 'This slip was already submitted' using errcode = '23505'; end if;
  if p_transfer_at is not null and p_transfer_at > now() + interval '10 minutes' then raise exception 'The transfer time is in the future'; end if;
  select id into req from public.finance_payment_requests where invoice_id = p_invoice order by created_at desc limit 1;
  insert into public.finance_payment_evidence (invoice_id, customer_id, request_id, file_path, file_sha256, file_type, claimed_amount,
      claimed_transfer_at, claimed_bank, claimed_ref)
    values (p_invoice, i.customer_id, req, p_file_path, lower(p_sha256), p_file_type, p_claimed_amount, p_transfer_at, nullif(trim(p_bank), ''), nullif(trim(p_ref), ''))
    returning id into e;
  perform public.finance_log('evidence', e, 'evidence.submit', jsonb_build_object('invoice', p_invoice, 'claimed_amount', p_claimed_amount));
  return e;
end $$;

-- ---------------------------------------------------------------------------------------------- staff: verification & settlement
-- Verify evidence against the bank record (staff now; a slip-verification provider later uses the same path with
-- p_via = 'provider'). The amount used is the verified amount from the bank, not the customer's claim.
--   verified = outstanding → allocated in full (fully paid)
--   verified < outstanding → allocated (partially paid)
--   verified > outstanding → receipt recorded, NOT allocated, flagged for review (overpaid)
create or replace function public.finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz,
  p_note text default null, p_via text default 'staff')
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; st jsonb; outstanding numeric; rc public.finance_receipts; result text;
begin
  perform public.finance_require('verify', 'verify payments');
  if p_via not in ('staff', 'provider', 'bank') then raise exception 'Unknown verification source'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if coalesce(trim(p_bank_trans_ref), '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> 'submitted' then raise exception 'This slip is already %', e.status; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;   -- serialises settlement of one invoice
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  if exists (select 1 from public.finance_receipts where bank_trans_ref = trim(p_bank_trans_ref)) then
    raise exception 'Bank transaction % was already recorded (reused slip?)', trim(p_bank_trans_ref) using errcode = '23505'; end if;
  if p_transfer_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The transfer is older than the invoice'; end if;

  st := public.finance_invoice_state(i.id);
  outstanding := (st ->> 'outstanding')::numeric;
  update public.finance_payment_evidence set status = 'verified', verified_via = p_via, verified_amount = p_amount, bank_trans_ref = trim(p_bank_trans_ref),
    transfer_at = p_transfer_at, review_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now() where id = e.id;
  insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at, needs_review)
    values ('RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0'),
            i.customer_id, i.id, e.id, p_amount, trim(p_bank_trans_ref), p_transfer_at, p_amount > outstanding)
    returning * into rc;
  if p_amount <= outstanding then
    insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, i.id, p_amount);
    result := case when p_amount = outstanding then 'fully_paid' else 'partially_paid' end;
  else
    result := 'overpaid_review';
  end if;
  perform public.finance_log('evidence', e.id, 'evidence.verify', jsonb_build_object('via', p_via, 'amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', trim(p_bank_trans_ref)));
  perform public.finance_log('receipt', rc.id, 'receipt.post', jsonb_build_object('invoice', i.id, 'amount', p_amount, 'outstanding_before', outstanding, 'result', result));
  return jsonb_build_object('result', result, 'receipt_no', rc.receipt_no, 'state', public.finance_invoice_state(i.id));
end $$;

create or replace function public.finance_reject_evidence(p_evidence uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence;
begin
  perform public.finance_require('verify', 'reject payments');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> 'submitted' then raise exception 'This slip is already %', e.status; end if;
  update public.finance_payment_evidence set status = 'rejected', reject_reason = trim(p_reason), reviewed_by = auth.uid(), reviewed_at = now() where id = p_evidence;
  perform public.finance_log('evidence', p_evidence, 'evidence.reject', jsonb_build_object('reason', trim(p_reason)));
end $$;

-- Overpayment decision: apply up to what is outstanding; the rest stays as the customer's unapplied credit
-- (a refund or applying it to another invoice is a separate, explicit staff action).
create or replace function public.finance_resolve_overpayment(p_receipt uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rc public.finance_receipts; outstanding numeric; apply numeric;
begin
  perform public.finance_require('verify', 'resolve overpayments');
  if coalesce(trim(p_note), '') = '' then raise exception 'Write what was agreed with the customer'; end if;
  select * into rc from public.finance_receipts where id = p_receipt for update;
  if not found or rc.status <> 'posted' or not rc.needs_review then raise exception 'Nothing to resolve on this receipt'; end if;
  perform 1 from public.finance_invoices where id = rc.invoice_id for update;
  outstanding := (public.finance_invoice_state(rc.invoice_id) ->> 'outstanding')::numeric;
  apply := least(outstanding, rc.amount - coalesce((select sum(amount) from public.finance_allocations where receipt_id = rc.id and active), 0));
  if apply > 0 then insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, rc.invoice_id, apply); end if;
  update public.finance_receipts set needs_review = false where id = rc.id;
  perform public.finance_log('receipt', rc.id, 'receipt.resolve_overpayment', jsonb_build_object('applied', apply, 'credit', rc.amount - apply, 'note', trim(p_note)));
  return public.finance_invoice_state(rc.invoice_id);
end $$;

create or replace function public.finance_reverse_receipt(p_receipt uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rc public.finance_receipts;
begin
  perform public.finance_require('manage', 'reverse receipts');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into rc from public.finance_receipts where id = p_receipt for update;
  if not found then raise exception 'Receipt not found'; end if;
  if rc.status <> 'posted' then raise exception 'Receipt is already %', rc.status; end if;
  update public.finance_allocations set active = false, deactivated_by = auth.uid(), deactivated_at = now(), deactivate_reason = 'receipt reversed: ' || trim(p_reason)
    where receipt_id = rc.id and active;
  update public.finance_receipts set status = 'reversed', needs_review = false, reversed_by = auth.uid(), reversed_at = now(), reverse_reason = trim(p_reason) where id = rc.id;
  perform public.finance_log('receipt', rc.id, 'receipt.reverse', jsonb_build_object('reason', trim(p_reason), 'amount', rc.amount));
  return public.finance_invoice_state(rc.invoice_id);
end $$;


-- Roles: managers grant or remove finance roles (never their own, never a SUPER_ADMIN's).
create or replace function public.finance_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_require('manage', 'manage finance access');
  if p_user = auth.uid() then raise exception 'You cannot change your own finance role'; end if;
  if exists (select 1 from public.profiles where id = p_user and role = 'SUPER_ADMIN') then raise exception 'A SUPER_ADMIN always has full access'; end if;
  if not exists (select 1 from public.profiles where id = p_user and role in ('ADMIN', 'SUPER_ADMIN') and status = 'active') then raise exception 'Only active back-office staff can have a finance role'; end if;
  if p_role is null then delete from public.finance_staff_roles where user_id = p_user;
  else
    if p_role not in ('viewer', 'clerk', 'verifier', 'manager') then raise exception 'Unknown role %', p_role; end if;
    insert into public.finance_staff_roles (user_id, role) values (p_user, p_role)
      on conflict (user_id) do update set role = excluded.role, granted_by = auth.uid(), granted_at = now();
  end if;
  perform public.finance_log('role', p_user, 'role.set', jsonb_build_object('role', p_role));
end $$;

create or replace function public.finance_staff()
returns table (user_id uuid, email text, display_name text, profile_role text, finance_role text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('manage', 'manage finance access');
  return query select p.id, p.email, p.display_name, p.role, case when p.role = 'SUPER_ADMIN' then 'manager' else r.role end
    from public.profiles p left join public.finance_staff_roles r on r.user_id = p.id
    where p.role in ('ADMIN', 'SUPER_ADMIN') order by p.email;
end $$;

-- ---------------------------------------------------------------------------------------------- reads
create or replace function public.finance_my_invoices()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'issue_date', i.issue_date, 'due_date', i.due_date,
      'description', i.description, 'customer_name', c.name) || public.finance_invoice_state(i.id) order by i.issue_date desc, i.invoice_no desc), '[]'::jsonb)
  from public.finance_invoices i join public.finance_customers c on c.id = i.customer_id
  where i.customer_id = public.finance_my_customer()
$$;

create or replace function public.finance_invoice_overview(p_status integer default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see invoices');
  return (select coalesce(jsonb_agg(x order by x ->> 'issue_date' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'issue_date', i.issue_date, 'due_date', i.due_date, 'customer_id', c.id,
      'customer_code', c.code, 'customer_name', c.name, 'description', i.description, 'source_ref', i.source_ref) || public.finance_invoice_state(i.id) as x
    from public.finance_invoices i join public.finance_customers c on c.id = i.customer_id) s
    where p_status is null or (x ->> 'status_code')::int = p_status);
end $$;

-- ---------------------------------------------------------------------------------------------- RLS (read only; all writes via the functions above)
alter table public.finance_staff_roles enable row level security;
alter table public.finance_payment_accounts enable row level security;
alter table public.finance_customers enable row level security;
alter table public.finance_invoices enable row level security;
alter table public.finance_payment_requests enable row level security;
alter table public.finance_payment_evidence enable row level security;
alter table public.finance_receipts enable row level security;
alter table public.finance_allocations enable row level security;
alter table public.finance_events enable row level security;

drop policy if exists "finance roles: own or manager" on public.finance_staff_roles;
create policy "finance roles: own or manager" on public.finance_staff_roles for select to authenticated using (user_id = auth.uid() or public.finance_can('manage'));
drop policy if exists "finance accounts: staff" on public.finance_payment_accounts;
create policy "finance accounts: staff" on public.finance_payment_accounts for select to authenticated using (public.finance_can('view'));
drop policy if exists "finance customers: staff or self" on public.finance_customers;
create policy "finance customers: staff or self" on public.finance_customers for select to authenticated using (public.finance_can('view') or profile_id = auth.uid());
drop policy if exists "finance invoices: staff or own" on public.finance_invoices;
create policy "finance invoices: staff or own" on public.finance_invoices for select to authenticated using (public.finance_can('view') or customer_id = public.finance_my_customer());
drop policy if exists "finance requests: staff or own" on public.finance_payment_requests;
create policy "finance requests: staff or own" on public.finance_payment_requests for select to authenticated using (public.finance_can('view') or customer_id = public.finance_my_customer());
drop policy if exists "finance evidence: staff or own" on public.finance_payment_evidence;
create policy "finance evidence: staff or own" on public.finance_payment_evidence for select to authenticated using (public.finance_can('view') or customer_id = public.finance_my_customer());
drop policy if exists "finance receipts: staff or own" on public.finance_receipts;
create policy "finance receipts: staff or own" on public.finance_receipts for select to authenticated using (public.finance_can('view') or customer_id = public.finance_my_customer());
drop policy if exists "finance allocations: staff or own" on public.finance_allocations;
create policy "finance allocations: staff or own" on public.finance_allocations for select to authenticated
  using (public.finance_can('view') or invoice_id in (select id from public.finance_invoices where customer_id = public.finance_my_customer()));
drop policy if exists "finance events: staff" on public.finance_events;
create policy "finance events: staff" on public.finance_events for select to authenticated using (public.finance_can('view'));

do $$ declare t text; begin
  foreach t in array array['finance_staff_roles', 'finance_payment_accounts', 'finance_customers', 'finance_invoices', 'finance_payment_requests',
                           'finance_payment_evidence', 'finance_receipts', 'finance_allocations', 'finance_events'] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;

-- Functions: nothing for anon; internal helpers not callable by clients at all.
do $$ declare f text; begin
  foreach f in array array[
    'finance_role()', 'finance_can(text)', 'finance_require(text, text)', 'finance_crc16(text)', 'finance_qr_fields(text)', 'finance_qr_describe(text)',
    'finance_qr_with_amount(text, numeric)', 'finance_guard_invoice()', 'finance_guard_receipt()', 'finance_guard_allocation()', 'finance_no_delete()', 'finance_log(text, uuid, text, jsonb)', 'finance_my_customer()',
    'finance_invoice_state(uuid)', 'finance_save_payment_account(text, text, boolean)', 'finance_disable_payment_account(uuid)',
    'finance_save_customer(uuid, text, text, text, text, uuid, text)', 'finance_create_invoice(uuid, numeric, date, date, text, text)',
    'finance_cancel_invoice(uuid, text)', 'finance_request_payment(uuid)',
    'finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text)',
    'finance_verify_evidence(uuid, numeric, text, timestamptz, text, text)', 'finance_reject_evidence(uuid, text)',
    'finance_resolve_overpayment(uuid, text)', 'finance_reverse_receipt(uuid, text)', 'finance_my_invoices()', 'finance_invoice_overview(integer)', 'finance_set_role(uuid, text)', 'finance_staff()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
  end loop;
  -- finance_can / finance_my_customer are used inside RLS policies, which run as the signed-in user
  foreach f in array array[
    'finance_role()', 'finance_can(text)', 'finance_my_customer()', 'finance_qr_describe(text)', 'finance_invoice_state(uuid)', 'finance_save_payment_account(text, text, boolean)', 'finance_disable_payment_account(uuid)',
    'finance_save_customer(uuid, text, text, text, text, uuid, text)', 'finance_create_invoice(uuid, numeric, date, date, text, text)',
    'finance_cancel_invoice(uuid, text)', 'finance_request_payment(uuid)',
    'finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text)',
    'finance_verify_evidence(uuid, numeric, text, timestamptz, text, text)', 'finance_reject_evidence(uuid, text)',
    'finance_resolve_overpayment(uuid, text)', 'finance_reverse_receipt(uuid, text)', 'finance_my_invoices()', 'finance_invoice_overview(integer)', 'finance_set_role(uuid, text)', 'finance_staff()'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------- slip files (private bucket)
-- Images and PDF up to 5 MB. A customer uploads only into their own folder (<auth uid>/...); finance staff can read all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-evidence', 'payment-evidence', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "payment evidence: upload own folder" on storage.objects;
create policy "payment evidence: upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-evidence' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "payment evidence: read own or finance staff" on storage.objects;
create policy "payment evidence: read own or finance staff" on storage.objects for select to authenticated
  using (bucket_id = 'payment-evidence' and ((storage.foldername(name))[1] = auth.uid()::text or public.finance_can('view')));
