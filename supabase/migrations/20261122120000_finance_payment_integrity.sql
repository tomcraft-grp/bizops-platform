-- Payment integrity for the Supabase receivables (invoices, payment evidence, receipts, allocations). Design: docs/superpowers/specs/2026-11-22-categories-and-central-receivables-design.md §3.3.
-- Nothing that exists is rewritten except two functions, copied from 20261120100000_slip_review.sql and changed only where marked:
--   1. finance_record_payment takes p_idempotency_key: a retry of the same staff entry (double click, lost answer) returns the first result instead of a second payment.
--      The key is checked AFTER the invoice row lock, so two concurrent twins are serialised and the second finds the first. Reusing a key for a DIFFERENT payment is refused.
--      The old 10-argument signature is replaced (the app calls it by argument names, so a caller without the key keeps working).
--   2. finance_payments_overview: a bank/cash payment whose receipt was reversed shows as "reversed" (it showed "verified"); a reversed wallet payment shows "reversed".
-- Added:
--   3. Customer-match triggers: a payment record can never point at another customer's invoice (evidence and receipt customer = invoice customer; an allocation's invoice
--      belongs to the receipt's customer). The live data had 0 mismatches on 2026-11-22, so no existing row is affected.
--   4. finance_customer_payment_log(p_customer, p_limit, p_offset): one time-ordered history per customer across invoice payments (evidence), receipts (posted, reversed,
--      with the reversal as its own line), wallet deposits and the finance event trail: who, when, method, amount, status (pending / completed / failed / cancelled /
--      reversed, derived, never stored) and remarks. Read only; staff with the finance "view" capability.
-- Split payments are unchanged: one invoice still takes several payments (transfer, cash, wallet) and the server keeps computing what is left (finance_invoice_state_raw).
-- Rollback: supabase/rollbacks/20261122120000_finance_payment_integrity_down.sql

-- 1 ------------------------------------------------------------------------------------------------------------------------------------------------------
alter table public.finance_payment_evidence add column if not exists idempotency_key text check (idempotency_key is null or length(idempotency_key) between 8 and 80);
create unique index if not exists finance_evidence_idem_once on public.finance_payment_evidence (recorded_by, idempotency_key) where idempotency_key is not null;

drop function public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text);
create function public.finance_record_payment(p_invoice uuid, p_method text, p_amount numeric, p_received_at timestamptz, p_bank_trans_ref text, p_bank_account uuid, p_note text,
  p_file_path text default null, p_sha256 text default null, p_file_type text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices; st jsonb; v_ref text := nullif(trim(p_bank_trans_ref), ''); v_note text := nullif(trim(p_note), ''); v_limit numeric; v_id uuid;
        v_cash boolean := p_method = 'cash'; v_bank uuid := p_bank_account; v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), ''); v_prev public.finance_payment_evidence;
begin
  perform public.finance_require('verify', 'record payments');
  if v_key is not null and (length(v_key) < 8 or length(v_key) > 80) then raise exception 'INVALID_KEY: the request key must be 8 to 80 characters'; end if;
  if p_method is null or p_method not in ('transfer', 'cash') then raise exception 'INVALID_METHOD: choose transfer or cash'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT: enter the amount in baht and satang'; end if;
  if p_received_at is null then raise exception 'The payment date and time are required'; end if;
  if p_received_at > now() + interval '10 minutes' then raise exception 'The payment time is in the future'; end if;
  if length(v_note) > 500 then raise exception 'The note is too long (500 characters at most)'; end if;
  if v_cash then
    if v_note is null or length(v_note) < 3 then raise exception 'NOTE_REQUIRED: say where the cash was received (at least 3 characters)'; end if;
    if p_file_path is not null or p_sha256 is not null or p_file_type is not null then raise exception 'FILE_NOT_ALLOWED: a cash payment has no slip file'; end if;
    v_ref := null; v_bank := null;                      -- cash has no bank reference and no bank account
  else
    if v_ref is null or length(public.finance_slip_ref(v_ref)) < 4 or length(v_ref) > 80 then
      raise exception 'REFERENCE_REQUIRED: enter the bank transaction reference (4 to 80 letters or digits)'; end if;
    if v_bank is not null and not exists (select 1 from public.finance_bank_accounts where id = v_bank and active) then raise exception 'BANK_NOT_AVAILABLE'; end if;
    if p_file_path is not null or p_sha256 is not null or p_file_type is not null then
      if p_file_path is null or p_sha256 is null or p_file_type is null or split_part(p_file_path, '/', 1) <> auth.uid()::text or p_file_path ~ '\.\.'
         or p_file_type not in ('image/jpeg', 'image/png', 'application/pdf') or p_sha256 !~ '^[0-9a-fA-F]{64}$' then raise exception 'Invalid file' using errcode = '22023'; end if;
    end if;
  end if;
  select * into i from public.finance_invoices where id = p_invoice for update;      -- serialises with every other payment on the invoice
  if not found then raise exception 'Invoice not found'; end if;
  -- a retry of the same request (double click, lost answer): after the invoice lock, so a concurrent twin waits and then finds the first one
  if v_key is not null then
    select * into v_prev from public.finance_payment_evidence where recorded_by = auth.uid() and idempotency_key = v_key;
    if found then
      if v_prev.invoice_id <> i.id or v_prev.confirmed_amount <> p_amount or v_prev.method <> p_method then raise exception 'KEY_REUSED: this request key was already used for a different payment'; end if;
      return jsonb_build_object('evidence_id', v_prev.id, 'status', v_prev.status, 'replay', true);
    end if;
  end if;
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  if p_received_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The payment is older than the invoice'; end if;
  st := public.finance_invoice_state_raw(i.id);
  v_limit := (st ->> 'outstanding')::numeric - (st ->> 'confirmed_pending')::numeric;   -- what the invoice owes, less what is confirmed and waits to be posted
  if p_amount > v_limit then
    raise exception 'EXCEEDS_OUTSTANDING: % is more than the % that can still be added to this invoice', p_amount, greatest(v_limit, 0); end if;
  if not v_cash then
    if public.finance_ref_in_use(v_ref, null) is not null then raise exception 'Bank transaction % was already recorded (reused slip?)', v_ref using errcode = '23505'; end if;
    if p_file_path is not null and (exists (select 1 from public.finance_payment_evidence where file_sha256 = lower(p_sha256) and status <> 'rejected')
         or exists (select 1 from public.finance_wallet_deposits where file_sha256 = lower(p_sha256) and status not in ('rejected', 'cancelled'))) then
      raise exception 'This slip was already submitted' using errcode = '23505'; end if;
  end if;
  insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, claimed_transfer_at, claimed_ref, bank_account_id,
      status, source, method, recorded_by, confirmed_by, confirmed_at, confirmed_amount, confirmed_bank_ref, confirmed_transfer_at, confirm_note, idempotency_key)
    values (i.id, i.customer_id, p_file_path, lower(p_sha256), p_file_type, p_amount, p_received_at, v_ref, v_bank,
      'confirmed', 'staff_entry', p_method, auth.uid(), auth.uid(), now(), p_amount, v_ref, p_received_at, v_note, v_key)
    returning id into v_id;
  perform public.finance_log('evidence', v_id, 'evidence.record', jsonb_build_object('invoice', i.id, 'method', p_method, 'amount', p_amount, 'trans_ref', v_ref, 'bank_account', v_bank,
    'file', p_file_path is not null, 'note', v_note, 'key', v_key is not null));
  return jsonb_build_object('evidence_id', v_id, 'status', 'confirmed');
end $$;
revoke execute on function public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text, text) from public, anon;
grant execute on function public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text, text) to authenticated;

-- 2 ------------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.finance_payments_overview(p_kind text default null, p_status text default null, p_bank uuid default null, p_search text default null,
  p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0); v_q text := nullif(btrim(coalesce(p_search, '')), ''); v_pat text; v_res jsonb;
begin
  perform public.finance_require('view', 'see payments');
  if v_q is not null then v_pat := '%' || replace(replace(replace(left(v_q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with u as (
    select 'deposit'::text kind, d.id, d.deposit_no no, d.customer_id, null::text invoice_no, d.amount, d.verified_amount, d.status, d.bank_account_id, d.created_at, d.file_path, d.bank_trans_ref
      from public.finance_wallet_deposits d
    union all
    select 'invoice_slip', e.id, i.invoice_no, e.customer_id, i.invoice_no, e.claimed_amount, e.verified_amount,
           case when e.status = 'verified' and exists (select 1 from public.finance_receipts rr where rr.evidence_id = e.id and rr.status = 'reversed') then 'reversed'
                else case e.status when 'submitted' then 'submitted' when 'verified' then 'verified' when 'confirmed' then 'confirmed' when 'more_evidence' then 'more_evidence' else 'rejected' end end, e.bank_account_id, e.created_at, e.file_path, e.bank_trans_ref
      from public.finance_payment_evidence e join public.finance_invoices i on i.id = e.invoice_id
    union all
    select 'wallet_payment', r.id, r.receipt_no, r.customer_id, i.invoice_no, r.amount, r.amount, case r.status when 'posted' then 'verified' else 'reversed' end, null, r.created_at, null, null
      from public.finance_receipts r join public.finance_invoices i on i.id = r.invoice_id where r.wallet_txn_id is not null),
  f as (
    select u.*, c.name customer_name, c.code customer_code, b.code bank_code, b.bank_name_th, b.bank_name_en, count(*) over () total
    from u join public.finance_customers c on c.id = u.customer_id left join public.finance_bank_accounts b on b.id = u.bank_account_id
    where (nullif(p_kind, '') is null or u.kind = p_kind) and (nullif(p_status, '') is null or u.status = p_status) and (p_bank is null or u.bank_account_id = p_bank)
      and (v_q is null or c.name ilike v_pat or c.code ilike v_pat or u.no ilike v_pat or u.invoice_no ilike v_pat or u.bank_trans_ref ilike v_pat)
    order by u.created_at desc limit v_lim offset v_off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0), 'items', coalesce(jsonb_agg(to_jsonb(f) - 'total' order by f.created_at desc), '[]'::jsonb)) into v_res from f;
  return v_res;
end $$;

-- 3 ------------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.finance_customer_match() returns trigger language plpgsql security definer set search_path = public as $$
declare v_inv uuid; v_rec uuid;
begin
  if tg_table_name = 'finance_allocations' then
    select customer_id into v_rec from public.finance_receipts where id = new.receipt_id;
    select customer_id into v_inv from public.finance_invoices where id = new.invoice_id;
    if v_rec is distinct from v_inv then raise exception 'CUSTOMER_MISMATCH: a payment of one customer cannot be allocated to another customer''s invoice' using errcode = '23514'; end if;
  else
    select customer_id into v_inv from public.finance_invoices where id = new.invoice_id;
    if new.customer_id is distinct from v_inv then raise exception 'CUSTOMER_MISMATCH: the payment''s customer is not the invoice''s customer' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.finance_customer_match() from public, anon, authenticated;
create trigger finance_evidence_customer_match before insert or update of customer_id, invoice_id on public.finance_payment_evidence for each row execute function public.finance_customer_match();
create trigger finance_receipt_customer_match before insert or update of customer_id, invoice_id on public.finance_receipts for each row execute function public.finance_customer_match();
create trigger finance_allocation_customer_match before insert or update of receipt_id, invoice_id on public.finance_allocations for each row execute function public.finance_customer_match();

-- 4 ------------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.finance_customer_payment_log(p_customer uuid, p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 500); v_off integer := greatest(coalesce(p_offset, 0), 0); c public.finance_customers; v_res jsonb;
begin
  perform public.finance_require('view', 'see a customer''s payment history');
  select * into c from public.finance_customers where id = p_customer;
  if not found then raise exception 'NOT_FOUND: customer %', p_customer; end if;
  with who as (select id, coalesce(nullif(btrim(display_name), ''), split_part(email, '@', 1)) as name from public.profiles),
  u as (
    -- invoice payments (customer slips, staff entries)
    select e.created_at as at, 'payment'::text as kind, e.id as txn_id, coalesce(e.confirmed_bank_ref, e.bank_trans_ref, e.claimed_ref) as reference, i.invoice_no,
           coalesce(e.verified_amount, e.confirmed_amount, e.claimed_amount) as amount, e.method, e.source,
           case when e.status in ('submitted', 'confirmed', 'more_evidence') then 'pending' when e.status = 'rejected' then 'failed'
                when exists (select 1 from public.finance_receipts r where r.evidence_id = e.id and r.status = 'reversed') then 'reversed' else 'completed' end as status,
           e.status as detail_status, coalesce(e.recorded_by, e.created_by) as actor, coalesce(e.confirm_note, e.reject_reason, e.review_note, e.request_message) as remark, e.posted_at as completed_at
      from public.finance_payment_evidence e join public.finance_invoices i on i.id = e.invoice_id where e.customer_id = p_customer
    union all
    -- receipts (what was actually received and allocated)
    select r.created_at, 'receipt', r.id, r.receipt_no, i.invoice_no, r.amount, r.method, case when r.wallet_txn_id is not null then 'wallet' else 'receipt' end,
           case r.status when 'reversed' then 'reversed' else 'completed' end, r.status, r.created_by, null, r.created_at
      from public.finance_receipts r join public.finance_invoices i on i.id = r.invoice_id where r.customer_id = p_customer
    union all
    -- the reversal itself, as its own line (the receipt row is never rewritten except for its status)
    select r.reversed_at, 'reversal', r.id, r.receipt_no, i.invoice_no, -r.amount, r.method, 'reversal', 'reversed', 'reversed', r.reversed_by, r.reverse_reason, r.reversed_at
      from public.finance_receipts r join public.finance_invoices i on i.id = r.invoice_id where r.customer_id = p_customer and r.status = 'reversed' and r.reversed_at is not null
    union all
    -- wallet top-ups
    select d.created_at, 'wallet_deposit', d.id, coalesce(d.bank_trans_ref, d.customer_ref, d.deposit_no), null, coalesce(d.verified_amount, d.amount), 'transfer', 'wallet',
           case when d.status in ('verified') then 'completed' when d.status = 'rejected' then 'failed' when d.status = 'cancelled' then 'cancelled' else 'pending' end, d.status,
           coalesce(d.reviewed_by, d.created_by), coalesce(d.reject_reason, d.review_note), d.reviewed_at
      from public.finance_wallet_deposits d where d.customer_id = p_customer),
  f as (select u.*, w.name as actor_name, count(*) over () as total from u left join who w on w.id = u.actor order by u.at desc nulls last, u.kind limit v_lim offset v_off)
  select jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name),
    'total', coalesce((select max(total) from f), 0),
    'items', coalesce((select jsonb_agg(to_jsonb(f) - 'total' - 'actor' order by f.at desc nulls last, f.kind) from f), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', ev.at, 'action', ev.action, 'entity', ev.entity, 'entity_id', ev.entity_id, 'by', ev.actor_email, 'detail', ev.detail) order by ev.at desc)
        from (select * from public.finance_events ev
               where (ev.entity = 'evidence' and ev.entity_id in (select e.id from public.finance_payment_evidence e where e.customer_id = p_customer))
                  or (ev.entity = 'receipt' and ev.entity_id in (select r.id from public.finance_receipts r where r.customer_id = p_customer))
               order by ev.at desc limit 200) ev), '[]'::jsonb)) into v_res;
  return v_res;
end $$;
revoke all on function public.finance_customer_payment_log(uuid, integer, integer) from public, anon;
grant execute on function public.finance_customer_payment_log(uuid, integer, integer) to authenticated;
