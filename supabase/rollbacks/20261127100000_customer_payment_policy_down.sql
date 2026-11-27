-- Rolls back 20261127100000_customer_payment_policy.sql: the two functions return to their previous definitions (verbatim, as the live database printed them),
-- the trigger, the new functions and the column go. Refuses once a customer is on the full-payment policy (that setting would be lost); the change history stays in finance_events.
-- Afterwards delete version 20261127100000 from supabase_migrations.schema_migrations.
do $$ begin
  if exists (select 1 from public.finance_customers where payment_policy <> 'partial') then raise exception 'REFUSING: a customer is on the full-payment policy (set it back to partial first)'; end if;
end $$;

drop trigger if exists finance_allocation_policy_note on public.finance_allocations;
drop function if exists public.finance_policy_short_note();
drop trigger if exists finance_evidence_policy_note on public.finance_payment_evidence;
drop function if exists public.finance_policy_note();

CREATE OR REPLACE FUNCTION public.finance_submit_evidence(p_invoice uuid, p_file_path text, p_sha256 text, p_file_type text, p_claimed_amount numeric, p_transfer_at timestamp with time zone, p_bank text, p_ref text, p_bank_account uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare i public.finance_invoices; e uuid; req uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into i from public.finance_invoices where id = p_invoice for update;
  if not found or (i.customer_id is distinct from public.finance_my_customer() and not public.finance_can('invoice')) then
    raise exception 'Invoice not found' using errcode = '42501'; end if;
  if i.status <> 'open' then raise exception 'This invoice is %', i.status; end if;
  if p_bank_account is not null and not exists (select 1 from public.finance_bank_accounts where id = p_bank_account and active) then raise exception 'BANK_NOT_AVAILABLE'; end if;
  if p_file_path is null or split_part(p_file_path, '/', 1) <> auth.uid()::text or p_file_path ~ '\.\.' then raise exception 'Invalid file' using errcode = '22023'; end if;
  if (select count(*) from public.finance_payment_evidence where invoice_id = p_invoice and status = 'submitted') >= 5 then
    raise exception 'Several slips for this invoice are already waiting to be checked'; end if;
  if exists (select 1 from public.finance_payment_evidence where file_sha256 = lower(p_sha256) and status <> 'rejected')
     or exists (select 1 from public.finance_wallet_deposits where file_sha256 = lower(p_sha256) and status not in ('rejected', 'cancelled')) then
    raise exception 'This slip was already submitted' using errcode = '23505'; end if;
  if p_transfer_at is not null and p_transfer_at > now() + interval '10 minutes' then raise exception 'The transfer time is in the future'; end if;
  select id into req from public.finance_payment_requests where invoice_id = p_invoice order by created_at desc limit 1;
  insert into public.finance_payment_evidence (invoice_id, customer_id, request_id, file_path, file_sha256, file_type, claimed_amount,
      claimed_transfer_at, claimed_bank, claimed_ref, bank_account_id)
    values (p_invoice, i.customer_id, req, p_file_path, lower(p_sha256), p_file_type, p_claimed_amount, p_transfer_at, nullif(trim(p_bank), ''), nullif(trim(p_ref), ''), p_bank_account)
    returning id into e;
  perform public.finance_log('evidence', e, 'evidence.submit', jsonb_build_object('invoice', p_invoice, 'claimed_amount', p_claimed_amount, 'bank_account', p_bank_account));
  return e;
end $function$;

CREATE OR REPLACE FUNCTION public.finance_pay_invoice_with_wallet(p_invoice uuid, p_amount numeric, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cust uuid; v_i public.finance_invoices; v_st jsonb; v_out numeric; v_t public.finance_wallet_transactions; v_rc public.finance_receipts; v_key text; v_existing public.finance_receipts; v_rno text;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  v_cust := public.finance_my_customer();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  v_key := 'INVPAY:' || coalesce(v_cust::text, '-') || ':' || p_key;
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  select * into v_i from public.finance_invoices where id = p_invoice for update;                       -- invoice first, wallet last (one lock order everywhere)
  if not found or v_cust is null or v_i.customer_id is distinct from v_cust then raise exception 'Invoice not found' using errcode = '42501'; end if;
  select r.* into v_existing from public.finance_receipts r join public.finance_wallet_transactions t on t.id = r.wallet_txn_id where t.idempotency_key = v_key;
  if found then
    return jsonb_build_object('replay', true, 'receipt_no', v_existing.receipt_no, 'state', public.finance_invoice_state_raw(p_invoice),
      'balance', (select balance from public.finance_wallets where customer_id = v_cust));
  end if;
  if v_i.status <> 'open' then raise exception 'INVOICE_NOT_OPEN: this invoice is %', v_i.status; end if;
  v_st := public.finance_invoice_state_raw(p_invoice);
  v_out := (v_st ->> 'outstanding')::numeric;
  if (v_st ->> 'status_code')::int = 6 then raise exception 'PAYMENT_UNDER_REVIEW'; end if;
  if v_out <= 0 then raise exception 'NOTHING_OUTSTANDING'; end if;
  if p_amount is null then p_amount := v_out; end if;
  if p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT' using errcode = '22023'; end if;
  if p_amount > v_out then raise exception 'AMOUNT_EXCEEDS_OUTSTANDING' using detail = v_out::text; end if;
  v_rno := public.next_doc_no('PAYMENT');          -- numbers are always taken in one fixed order (payment, wallet row, wallet number): no deadlock between concurrent payments
  v_t := public.finance_wallet_apply(v_cust, 'INVOICE_PAYMENT', 'debit', p_amount, v_key, 'invoice', v_i.id, v_i.invoice_no, 'wallet', null, 'not_required', auth.uid(), null, 'Paid from the wallet', null);
  insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, wallet_txn_id, amount, method, received_at, needs_review)
    values (v_rno, v_cust, v_i.id, null, v_t.id, p_amount, 'wallet', now(), false)
    returning * into v_rc;
  insert into public.finance_allocations (receipt_id, invoice_id, amount) values (v_rc.id, v_i.id, p_amount);
  perform public.finance_gl_enqueue('WALLET_PAYMENT', 'wallet_txn', v_t.id, v_t.txn_no, v_cust, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', p_amount)),
    public.finance_gl_issue_dep(v_i.id));
  perform public.finance_log('receipt', v_rc.id, 'receipt.post', jsonb_build_object('invoice', v_i.id, 'amount', p_amount, 'outstanding_before', v_out, 'result', 'wallet', 'wallet_txn', v_t.txn_no));
  return jsonb_build_object('replay', false, 'receipt_no', v_rc.receipt_no, 'txn_no', v_t.txn_no, 'balance', v_t.balance_after, 'state', public.finance_invoice_state_raw(p_invoice));
end $function$;

drop function public.finance_customer_policies(uuid[], text, integer);
drop function public.finance_my_payment_policy();
drop function public.finance_set_payment_policy(uuid, text, text);
alter table public.finance_customers drop constraint if exists finance_customers_payment_policy_chk;
alter table public.finance_customers drop column if exists payment_policy;
