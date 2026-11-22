-- Rolls back 20261122120000_finance_payment_integrity.sql: the two functions return to their 20261120100000 definitions (verbatim), the triggers and the log function go,
-- and the idempotency column is dropped. Refuses once a payment was recorded WITH a request key (the key is part of that record's history).
-- Afterwards delete version 20261122120000 from supabase_migrations.schema_migrations.
do $guard$ begin
  if exists (select 1 from public.finance_payment_evidence where idempotency_key is not null) then
    raise exception 'Payments were recorded with request keys: roll back is refused (the keys are part of their history).'; end if;
end $guard$;

drop function if exists public.finance_customer_payment_log(uuid, integer, integer);
drop trigger if exists finance_evidence_customer_match on public.finance_payment_evidence;
drop trigger if exists finance_receipt_customer_match on public.finance_receipts;
drop trigger if exists finance_allocation_customer_match on public.finance_allocations;
drop function if exists public.finance_customer_match();

drop function if exists public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text, text);
create or replace function public.finance_record_payment(p_invoice uuid, p_method text, p_amount numeric, p_received_at timestamptz, p_bank_trans_ref text, p_bank_account uuid, p_note text,
  p_file_path text default null, p_sha256 text default null, p_file_type text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices; st jsonb; v_ref text := nullif(trim(p_bank_trans_ref), ''); v_note text := nullif(trim(p_note), ''); v_limit numeric; v_id uuid;
        v_cash boolean := p_method = 'cash'; v_bank uuid := p_bank_account;
begin
  perform public.finance_require('verify', 'record payments');
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
      status, source, method, recorded_by, confirmed_by, confirmed_at, confirmed_amount, confirmed_bank_ref, confirmed_transfer_at, confirm_note)
    values (i.id, i.customer_id, p_file_path, lower(p_sha256), p_file_type, p_amount, p_received_at, v_ref, v_bank,
      'confirmed', 'staff_entry', p_method, auth.uid(), auth.uid(), now(), p_amount, v_ref, p_received_at, v_note)
    returning id into v_id;
  perform public.finance_log('evidence', v_id, 'evidence.record', jsonb_build_object('invoice', i.id, 'method', p_method, 'amount', p_amount, 'trans_ref', v_ref, 'bank_account', v_bank,
    'file', p_file_path is not null, 'note', v_note));
  return jsonb_build_object('evidence_id', v_id, 'status', 'confirmed');
end $$;
revoke execute on function public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text) to authenticated;

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
           case e.status when 'submitted' then 'submitted' when 'verified' then 'verified' when 'confirmed' then 'confirmed' when 'more_evidence' then 'more_evidence' else 'rejected' end, e.bank_account_id, e.created_at, e.file_path, e.bank_trans_ref
      from public.finance_payment_evidence e join public.finance_invoices i on i.id = e.invoice_id
    union all
    select 'wallet_payment', r.id, r.receipt_no, r.customer_id, i.invoice_no, r.amount, r.amount, case r.status when 'posted' then 'verified' else 'cancelled' end, null, r.created_at, null, null
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

drop index if exists public.finance_evidence_idem_once;
alter table public.finance_payment_evidence drop column if exists idempotency_key;
