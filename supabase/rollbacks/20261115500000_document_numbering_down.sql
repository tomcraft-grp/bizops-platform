-- Rolls back 20261115500000_document_numbering.sql (back to six separate sequences with the old formats SO-/INV-/RC-/WT-/DP-/AR-RC-).
-- Refuses to run once the central numbering has issued any document (a counter above zero): rolling back would forget the last number, and a later
-- re-apply would hand out ORD-000001 again. Documents that exist keep their numbers in every case.
-- The previous function bodies below were read from the live database before this migration was applied.
do $guard$ begin
  if to_regclass('public.doc_counters') is not null and exists (select 1 from public.doc_counters where last_seq > 0) then
    raise exception 'The central numbering has already issued document numbers: it cannot be rolled back.'; end if;
end $guard$;

-- 1) the six old sequences come back, continuing AFTER the highest old-format number that exists (so a restored sequence can never repeat one)
do $seq$ declare n bigint; begin
  select coalesce(max(substring(order_no from '[0-9]+$')::bigint), 0) + 1 into n from public.shop_orders where order_no ~ '^SO-[0-9]{6}-[0-9]{5}$';
  execute format('create sequence if not exists public.shop_order_seq start with %s', n);
  select coalesce(max(substring(invoice_no from '[0-9]+$')::bigint), 0) + 1 into n from public.finance_invoices where invoice_no ~ '^INV-[0-9]{6}-[0-9]{5}$';
  execute format('create sequence if not exists public.finance_invoice_seq start with %s', n);
  select coalesce(max(substring(receipt_no from '[0-9]+$')::bigint), 0) + 1 into n from public.finance_receipts where receipt_no ~ '^RC-[0-9]{6}-[0-9]{5}$';
  execute format('create sequence if not exists public.finance_receipt_seq start with %s', n);
  select coalesce(max(substring(txn_no from '[0-9]+$')::bigint), 0) + 1 into n from public.finance_wallet_transactions where txn_no ~ '^WT-[0-9]{6}-[0-9]{5}$';
  execute format('create sequence if not exists public.finance_wallet_txn_seq start with %s', n);
  select coalesce(max(substring(deposit_no from '[0-9]+$')::bigint), 0) + 1 into n from public.finance_wallet_deposits where deposit_no ~ '^DP-[0-9]{6}-[0-9]{5}$';
  execute format('create sequence if not exists public.finance_deposit_seq start with %s', n);
  select coalesce(max(substring(receipt_no from '[0-9]+$')::bigint), 0) + 1 into n from public.ar_receipts where receipt_no ~ '^AR-RC-[0-9]{6}$';
  execute format('create sequence if not exists public.ar_receipt_seq start with %s', n);
end $seq$;
revoke all on sequence public.shop_order_seq, public.finance_invoice_seq, public.finance_receipt_seq, public.finance_wallet_txn_seq, public.finance_deposit_seq, public.ar_receipt_seq from anon, authenticated;

-- 2) the functions as they were before
-- ar_receive_payment(p_customer uuid, p_amount numeric, p_method text, p_date date, p_reference text, p_note text, p_allocations jsonb, p_idempotency_key text)
CREATE OR REPLACE FUNCTION public.ar_receive_payment(p_customer uuid, p_amount numeric, p_method text, p_date date DEFAULT CURRENT_DATE, p_reference text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_allocations jsonb DEFAULT NULL::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me        public.profiles;
  v_rc        public.ar_receipts;
  v_amount    numeric(14, 2) := round(coalesce(p_amount, 0), 2);
  v_left      numeric(14, 2);
  v_take      numeric(14, 2);
  v_total_bal numeric(14, 2);
  v_item      record;
  v_alloc     jsonb;
  v_sum       numeric(14, 2) := 0;
  v_out       jsonb := '[]'::jsonb;
begin
  select * into v_me from public.profiles where id = auth.uid() and status = 'active' and role in ('ADMIN', 'SUPER_ADMIN');
  if v_me.id is null then raise exception 'Only staff can record payments' using errcode = '42501'; end if;
  if v_amount <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  if p_method not in ('cash', 'transfer', 'promptpay', 'other') then raise exception 'Unknown payment method %', p_method; end if;
  if p_date is null or p_date > current_date then raise exception 'Payment date cannot be in the future'; end if;
  if not exists (select 1 from public.customers where id = p_customer) then raise exception 'Unknown customer'; end if;

  perform pg_advisory_xact_lock(hashtext('ar_customer:' || p_customer::text));

  if p_idempotency_key is not null then
    select * into v_rc from public.ar_receipts where idempotency_key = p_idempotency_key;
    if v_rc.id is not null then
      return jsonb_build_object('receipt_id', v_rc.id, 'receipt_no', v_rc.receipt_no, 'amount', v_rc.amount, 'already_recorded', true);
    end if;
  end if;

  select coalesce(sum(balance_amount), 0) into v_total_bal from public.ar_open_item_status where customer_id = p_customer;
  if v_amount > v_total_bal then
    raise exception 'Payment of % is more than the customer owes (%). Overpayment/credit is not supported yet.', v_amount, v_total_bal;
  end if;

  insert into public.ar_receipts (receipt_no, customer_id, received_date, amount, method, reference, note, idempotency_key, created_by, created_by_label)
  values ('AR-RC-' || lpad(nextval('public.ar_receipt_seq')::text, 6, '0'), p_customer, p_date, v_amount, p_method,
          left(nullif(trim(p_reference), ''), 120), left(nullif(trim(p_note), ''), 500), left(p_idempotency_key, 80),
          v_me.id, coalesce(v_me.display_name, v_me.email))
  returning * into v_rc;

  if p_allocations is null then
    -- FIFO: oldest document first (undated last), then source row order.
    v_left := v_amount;
    for v_item in
      select id, balance_amount from public.ar_open_item_status
      where customer_id = p_customer and balance_amount > 0
      order by doc_date asc nulls last, source_row asc
    loop
      exit when v_left <= 0;
      v_take := least(v_left, v_item.balance_amount);
      insert into public.ar_receipt_allocations (receipt_id, open_item_id, amount) values (v_rc.id, v_item.id, v_take);
      v_out := v_out || jsonb_build_object('open_item_id', v_item.id, 'amount', v_take);
      v_left := v_left - v_take;
    end loop;
    v_sum := v_amount - v_left;
  else
    for v_alloc in select * from jsonb_array_elements(p_allocations) loop
      v_take := round((v_alloc->>'amount')::numeric, 2);
      if v_take is null or v_take <= 0 then raise exception 'Each allocation must be greater than zero'; end if;
      insert into public.ar_receipt_allocations (receipt_id, open_item_id, amount) values (v_rc.id, (v_alloc->>'open_item_id')::uuid, v_take);
      v_out := v_out || jsonb_build_object('open_item_id', v_alloc->>'open_item_id', 'amount', v_take);
      v_sum := v_sum + v_take;
    end loop;
  end if;

  if v_sum <> v_amount then raise exception 'Allocations (%) must add up to the payment amount (%)', v_sum, v_amount; end if;

  insert into public.auth_audit_logs (actor_id, action, detail)
  values (v_me.id, 'ar.receipt.posted', jsonb_build_object('receipt_no', v_rc.receipt_no, 'customer_id', p_customer, 'amount', v_amount, 'method', p_method));

  return jsonb_build_object('receipt_id', v_rc.id, 'receipt_no', v_rc.receipt_no, 'amount', v_amount, 'allocations', v_out, 'already_recorded', false);
end $function$;

-- finance_create_invoice(p_customer uuid, p_amount numeric, p_issue date, p_due date, p_description text, p_source_ref text)
CREATE OR REPLACE FUNCTION public.finance_create_invoice(p_customer uuid, p_amount numeric, p_issue date, p_due date, p_description text, p_source_ref text)
 RETURNS finance_invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

-- finance_deposit_create(p_bank uuid, p_amount numeric, p_key text, p_customer_ref text)
CREATE OR REPLACE FUNCTION public.finance_deposit_create(p_bank uuid, p_amount numeric, p_key text, p_customer_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cust uuid; v_s public.finance_settings; v_d public.finance_wallet_deposits; v_bank public.finance_bank_accounts;
begin
  v_cust := public.finance_ensure_customer();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('deposit:' || v_cust::text || ':' || p_key, 0));
  select * into v_d from public.finance_wallet_deposits where customer_id = v_cust and idempotency_key = p_key;
  if found then
    if v_d.amount <> p_amount or v_d.bank_account_id <> p_bank then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return to_jsonb(v_d) - 'created_by' - 'reviewed_by' - 'review_note';
  end if;
  select * into v_s from public.finance_settings where id;
  select * into v_bank from public.finance_bank_accounts where id = p_bank and active;
  if not found then raise exception 'BANK_NOT_AVAILABLE'; end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount < v_s.min_deposit or p_amount > v_s.max_deposit then
    raise exception 'AMOUNT_OUT_OF_RANGE' using detail = v_s.min_deposit::text || '-' || v_s.max_deposit::text; end if;
  if (select count(*) from public.finance_wallet_deposits where customer_id = v_cust and status in ('pending', 'submitted', 'under_review')) >= v_s.max_open_deposits then
    raise exception 'TOO_MANY_OPEN_DEPOSITS'; end if;
  insert into public.finance_wallet_deposits (deposit_no, customer_id, bank_account_id, amount, idempotency_key, customer_ref)
    values ('DP-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_deposit_seq')::text, 5, '0'), v_cust, p_bank, p_amount, p_key, nullif(btrim(p_customer_ref), ''))
    returning * into v_d;
  perform public.finance_log('deposit', v_d.id, 'deposit.create', jsonb_build_object('no', v_d.deposit_no, 'amount', p_amount, 'bank', v_bank.code));
  return to_jsonb(v_d) - 'created_by' - 'reviewed_by' - 'review_note';
end $function$;

-- finance_pay_invoice_with_wallet(p_invoice uuid, p_amount numeric, p_key text)
CREATE OR REPLACE FUNCTION public.finance_pay_invoice_with_wallet(p_invoice uuid, p_amount numeric, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cust uuid; v_i public.finance_invoices; v_st jsonb; v_out numeric; v_t public.finance_wallet_transactions; v_rc public.finance_receipts; v_key text; v_existing public.finance_receipts;
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
  v_t := public.finance_wallet_apply(v_cust, 'INVOICE_PAYMENT', 'debit', p_amount, v_key, 'invoice', v_i.id, v_i.invoice_no, 'wallet', null, 'not_required', auth.uid(), null, 'Paid from the wallet', null);
  insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, wallet_txn_id, amount, method, received_at, needs_review)
    values ('RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0'), v_cust, v_i.id, null, v_t.id, p_amount, 'wallet', now(), false)
    returning * into v_rc;
  insert into public.finance_allocations (receipt_id, invoice_id, amount) values (v_rc.id, v_i.id, p_amount);
  perform public.finance_gl_enqueue('WALLET_PAYMENT', 'wallet_txn', v_t.id, v_t.txn_no, v_cust, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', p_amount)),
    public.finance_gl_issue_dep(v_i.id));
  perform public.finance_log('receipt', v_rc.id, 'receipt.post', jsonb_build_object('invoice', v_i.id, 'amount', p_amount, 'outstanding_before', v_out, 'result', 'wallet', 'wallet_txn', v_t.txn_no));
  return jsonb_build_object('replay', false, 'receipt_no', v_rc.receipt_no, 'txn_no', v_t.txn_no, 'balance', v_t.balance_after, 'state', public.finance_invoice_state_raw(p_invoice));
end $function$;

-- finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamp with time zone, p_note text, p_via text)
CREATE OR REPLACE FUNCTION public.finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamp with time zone, p_note text DEFAULT NULL::text, p_via text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.finance_payment_evidence; i public.finance_invoices; st jsonb; outstanding numeric; rc public.finance_receipts; result text; v_alloc numeric := 0;
        v_rid uuid := gen_random_uuid(); v_rno text; v_excess numeric := 0; v_t public.finance_wallet_transactions;
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
  if exists (select 1 from public.finance_receipts where bank_trans_ref = trim(p_bank_trans_ref)) or exists (select 1 from public.finance_wallet_deposits where bank_trans_ref = trim(p_bank_trans_ref) and status = 'verified') then
    raise exception 'Bank transaction % was already recorded (reused slip?)', trim(p_bank_trans_ref) using errcode = '23505'; end if;
  if p_transfer_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The transfer is older than the invoice'; end if;

  st := public.finance_invoice_state_raw(i.id);
  outstanding := (st ->> 'outstanding')::numeric;
  v_alloc := least(p_amount, outstanding);
  v_excess := p_amount - v_alloc;
  v_rno := 'RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0');
  update public.finance_payment_evidence set status = 'verified', verified_via = p_via, verified_amount = p_amount, bank_trans_ref = trim(p_bank_trans_ref),
    transfer_at = p_transfer_at, review_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now() where id = e.id;
  -- the part above what the invoice owes is the customer's money: it goes to their wallet (one ledger row, same transaction)
  if v_excess > 0 then
    v_t := public.finance_wallet_apply(i.customer_id, 'DEPOSIT', 'credit', v_excess, 'OVR:' || v_rid::text, 'receipt', v_rid, v_rno, 'bank_transfer', e.bank_account_id, 'verified',
                                       auth.uid(), auth.uid(), 'Paid above invoice ' || i.invoice_no || ' (receipt ' || v_rno || ')',
                                       'โอนเกินยอดใบแจ้งหนี้ เข้ากระเป๋าเงิน / Paid above the invoice, credited to your wallet');
  end if;
  insert into public.finance_receipts (id, receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at, needs_review, method, bank_account_id, credit_txn_id)
    values (v_rid, v_rno, i.customer_id, i.id, e.id, p_amount, trim(p_bank_trans_ref), p_transfer_at, false, 'bank_transfer', e.bank_account_id, v_t.id)
    returning * into rc;
  if v_alloc > 0 then
    insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, i.id, v_alloc);
  end if;
  result := case when v_excess > 0 then 'overpaid_credited' when p_amount = outstanding then 'fully_paid' else 'partially_paid' end;
  -- ledger: money in the bank; the applied part settles the receivable, any overpayment is customer credit (wallet liability)
  perform public.finance_gl_enqueue('BANK_RECEIPT', 'receipt', rc.id, rc.receipt_no, i.customer_id, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', e.bank_account_id))
      || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
      || case when v_excess > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', v_excess, 'wallet', true)) else '[]'::jsonb end,
    public.finance_gl_issue_dep(i.id));
  perform public.finance_log('evidence', e.id, 'evidence.verify', jsonb_build_object('via', p_via, 'amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', trim(p_bank_trans_ref), 'bank_account', e.bank_account_id));
  perform public.finance_log('receipt', rc.id, 'receipt.post', jsonb_build_object('invoice', i.id, 'amount', p_amount, 'outstanding_before', outstanding, 'result', result, 'credited_to_wallet', v_excess));
  return jsonb_build_object('result', result, 'receipt_no', rc.receipt_no, 'credited_to_wallet', v_excess, 'state', public.finance_invoice_state_raw(i.id));
end $function$;

-- finance_wallet_apply(p_customer uuid, p_type text, p_direction text, p_amount numeric, p_key text, p_ref_type text, p_ref_id uuid, p_ref_no text, p_method text, p_bank uuid, p_status text, p_by uuid, p_approved_by uuid, p_remarks text, p_note text, p_reversal_of uuid)
CREATE OR REPLACE FUNCTION public.finance_wallet_apply(p_customer uuid, p_type text, p_direction text, p_amount numeric, p_key text, p_ref_type text, p_ref_id uuid, p_ref_no text, p_method text, p_bank uuid, p_status text, p_by uuid, p_approved_by uuid, p_remarks text, p_note text DEFAULT NULL::text, p_reversal_of uuid DEFAULT NULL::uuid)
 RETURNS finance_wallet_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_w public.finance_wallets; v_t public.finance_wallet_transactions; v_after numeric;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT' using errcode = '22023'; end if;
  insert into public.finance_wallets (customer_id) values (p_customer) on conflict (customer_id) do nothing;
  select * into v_w from public.finance_wallets where customer_id = p_customer for update;           -- serialises every movement of this wallet
  select * into v_t from public.finance_wallet_transactions where idempotency_key = p_key;
  if found then
    if v_t.customer_id <> p_customer or v_t.amount <> p_amount or v_t.txn_type <> p_type then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return v_t;
  end if;
  v_after := case when p_direction = 'credit' then v_w.balance + p_amount else v_w.balance - p_amount end;
  if v_after < 0 then raise exception 'INSUFFICIENT_FUNDS' using errcode = '23514', detail = v_w.balance::text; end if;
  perform set_config('finance.wallet_write', '1', true);
  update public.finance_wallets set balance = v_after, updated_at = now() where id = v_w.id;
  perform set_config('finance.wallet_write', '0', true);
  insert into public.finance_wallet_transactions (txn_no, wallet_id, customer_id, txn_type, direction, amount, balance_before, balance_after, ref_type, ref_id, ref_no, payment_method,
      bank_account_id, verification_status, idempotency_key, reversal_of, created_by, approved_by, remarks, customer_note)
    values ('WT-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_wallet_txn_seq')::text, 5, '0'), v_w.id, p_customer, p_type, p_direction, p_amount,
            v_w.balance, v_after, p_ref_type, p_ref_id, p_ref_no, p_method, p_bank, p_status, p_key, p_reversal_of, p_by, p_approved_by, nullif(btrim(p_remarks), ''), nullif(btrim(p_note), ''))
    returning * into v_t;
  perform public.finance_log('wallet', v_t.id, 'wallet.' || lower(p_type), jsonb_build_object('no', v_t.txn_no, 'direction', p_direction, 'amount', p_amount, 'before', v_w.balance, 'after', v_after,
    'customer', p_customer, 'ref', p_ref_no));
  return v_t;
end $function$;

-- shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric, p_payment_method text, p_slip_path text, p_slip_sha256 text, p_slip_type text, p_slip_transfer_at timestamp with time zone, p_slip_ref text)
CREATE OR REPLACE FUNCTION public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric DEFAULT NULL::numeric, p_payment_method text DEFAULT NULL::text, p_slip_path text DEFAULT NULL::text, p_slip_sha256 text DEFAULT NULL::text, p_slip_type text DEFAULT NULL::text, p_slip_transfer_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_slip_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid; prof public.profiles; s public.shop_settings; q jsonb; norm jsonb; hash text; existing public.shop_orders; pm text;
        fin uuid; ono text; oid uuid := gen_random_uuid(); inv public.finance_invoices; phone text; nm text; addr text; nt text; n integer; ln integer := 0; l jsonb;
        v_bank_id uuid; v_bank_code text;
begin
  uid := public.shop_require_user();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_key, 0));    -- serialises retries of the same checkout

  select * into s from public.shop_settings where id;
  nm := btrim(coalesce(p_name, '')); phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  addr := nullif(btrim(coalesce(p_address, '')), ''); nt := nullif(btrim(coalesce(p_note, '')), ''); pm := nullif(btrim(coalesce(p_payment_method, '')), '');
  select coalesce(jsonb_agg(jsonb_build_object('sku', k, 'qty', t) order by k), '[]'::jsonb) into norm from (
    select e ->> 'sku_code' k, sum(case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::int else 0 end) t
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e group by 1) z;
  -- (the payment choice and the slip join the hash only when given, so a checkout without them hashes exactly as before)
  hash := md5((jsonb_build_object('items', norm, 'f', p_fulfilment, 'n', nm, 'p', phone, 'a', addr, 'note', nt)
               || case when pm is null then '{}'::jsonb else jsonb_build_object('pm', pm) end
               || case when p_slip_sha256 is null then '{}'::jsonb else jsonb_build_object('slip', lower(p_slip_sha256)) end)::text);

  -- a retry of the same checkout returns the order it already created (never a second one)
  select * into existing from public.shop_orders where profile_id = uid and idempotency_key = p_key;
  if found then
    if existing.request_hash <> hash then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return jsonb_build_object('replay', true, 'order', public.shop_order_json(existing.id));
  end if;

  if not s.shop_open then raise exception 'SHOP_CLOSED'; end if;
  if not (exists (select 1 from public.finance_payment_accounts where is_default and active) or exists (select 1 from public.finance_bank_accounts where active)) then raise exception 'NO_PAYMENT_ACCOUNT'; end if;
  if pm is not null and not (pm = 'wallet'
       or (pm = 'qr' and exists (select 1 from public.finance_payment_accounts where is_default and active))
       or (pm like 'bank:%' and exists (select 1 from public.finance_bank_accounts where active and code = substr(pm, 6)))) then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023'; end if;
  -- the transfer slip comes with the order (only an order paid from the wallet needs none)
  if s.require_payment_slip and pm is distinct from 'wallet' and (p_slip_path is null or p_slip_sha256 is null) then
    raise exception 'SLIP_REQUIRED' using errcode = '22023'; end if;
  if (select count(*) from public.shop_orders where profile_id = uid and created_at > now() - interval '1 hour') >= 10 then raise exception 'TOO_MANY_ORDERS'; end if;

  if length(nm) not between 1 and 100 then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if phone !~ '^0[0-9]{8,9}$' then raise exception 'INVALID_PHONE' using errcode = '22023'; end if;
  if p_fulfilment = 'pickup' then addr := null; end if;
  if addr is not null and length(addr) > 400 then raise exception 'INVALID_ADDRESS' using errcode = '22023'; end if;     -- optional, but not unbounded
  if nt is not null and length(nt) > 300 then raise exception 'INVALID_NOTE' using errcode = '22023'; end if;

  q := public.shop_quote_internal(p_items, p_fulfilment);
  if not (q ->> 'ok')::boolean then raise exception 'CART_INVALID' using detail = (q -> 'problems')::text; end if;
  if p_expected_total is not null and p_expected_total <> (q ->> 'total')::numeric then
    raise exception 'PRICE_CHANGED' using detail = (q ->> 'total'); end if;

  select * into prof from public.profiles where id = uid;
  select id into fin from public.finance_customers where profile_id = uid;
  if fin is null then
    insert into public.finance_customers (code, name, profile_id, created_by)
      values ('LINE-' || upper(substr(replace(uid::text, '-', ''), 1, 10)), coalesce(nullif(btrim(prof.display_name), ''), nm), uid, uid)
      returning id into fin;
    perform public.shop_log('customer', fin::text, 'customer.create', jsonb_build_object('profile', uid));
  end if;

  ono := 'SO-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.shop_order_seq')::text, 5, '0');
  perform set_config('finance.defer_gl', 'on', true);          -- the receivable is queued when staff confirm the order (or when a payment is verified)
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref, created_by)
    values ('INV-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_invoice_seq')::text, 5, '0'),
            fin, (now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date, (q ->> 'total')::numeric,
            'Online order ' || ono, ono, uid)
    returning * into inv;
  perform set_config('finance.defer_gl', 'off', true);
  perform public.finance_log('invoice', inv.id, 'invoice.issue', jsonb_build_object('no', inv.invoice_no, 'amount', inv.amount, 'customer', fin, 'order', ono, 'source', 'shop'));

  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone,
      delivery_address, note, subtotal, discount, shipping_fee, total, invoice_id, payment_pref)
    values (oid, ono, uid, fin, p_key, hash, p_fulfilment, nm, phone, addr, nt, (q ->> 'subtotal')::numeric, (q ->> 'discount')::numeric,
            (q ->> 'shipping_fee')::numeric, (q ->> 'total')::numeric, inv.id, pm);
  for l in select * from jsonb_array_elements(q -> 'lines') loop
    ln := ln + 1;
    insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total)
      values (oid, ln, l ->> 'sku_code', l ->> 'name', l ->> 'unit', (l ->> 'unit_price')::numeric, (l ->> 'qty')::int, (l ->> 'line_total')::numeric);
  end loop;
  -- the slip: checked by the same function a customer uses on the payment screen (own folder, no path tricks, one use per file), with the
  -- amount the SERVER priced. Any refusal rolls back the whole order. The invoice becomes "awaiting verification", never "paid".
  if p_slip_path is not null then
    if pm like 'bank:%' then select id, code into v_bank_id, v_bank_code from public.finance_bank_accounts where active and code = substr(pm, 6); end if;
    perform public.finance_submit_evidence(inv.id, p_slip_path, p_slip_sha256, coalesce(p_slip_type, 'image/jpeg'), (q ->> 'total')::numeric, p_slip_transfer_at,
      coalesce(v_bank_code, case when pm = 'qr' then 'PromptPay' end), p_slip_ref, v_bank_id);
  end if;
  perform public.shop_log('order', oid::text, 'order.place', jsonb_build_object('no', ono, 'total', q -> 'total', 'lines', ln, 'invoice', inv.invoice_no, 'fulfilment', p_fulfilment,
    'payment_pref', pm, 'slip', p_slip_path is not null));
  return jsonb_build_object('replay', false, 'order', public.shop_order_json(oid));
end $function$;

-- 3) the central numbering itself
drop function if exists public.finance_save_doc_format(text, text, text, integer, integer);
drop function if exists public.doc_numbering_overview();
drop function if exists public.next_doc_no(text, date);
drop table if exists public.doc_counters, public.doc_number_formats, public.doc_number_settings;
drop function if exists public.doc_counter_guard();
