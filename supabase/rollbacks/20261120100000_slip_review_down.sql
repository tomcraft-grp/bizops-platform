-- Rolls back 20261120100000_slip_review.sql: drops the slip-analysis table and every column, index and constraint the migration added, and puts the
-- earlier checks back (evidence statuses submitted/verified/rejected, ledger-queue event types without CASH_RECEIPT, file columns NOT NULL).
-- The sections undo the migration in REVERSE order: the section of a later task (5 customer order list, 4 reads, 3 workflow, 2 analysis) goes ABOVE "1 schema" in this file, so
-- the functions and triggers that use the new columns are removed before the columns are.
--
-- REFUSES to run once the new objects hold records, because dropping them would destroy financial history: any analysis row, any staff-recorded
-- payment, any evidence that is confirmed / waiting for more evidence, or that carries a confirm / post / request / recorder stamp (a posted slip that
-- went through Confirm keeps who confirmed it and when), and any CASH_RECEIPT ledger row (the old check could not take it back).

do $guard$ begin
  if to_regclass('public.finance_slip_analysis') is not null then
    if exists (select 1 from public.finance_slip_analysis) then
      raise exception 'Slip analyses exist: they are records and cannot be rolled back.'; end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_payment_evidence' and column_name = 'source') then
    if exists (select 1 from public.finance_payment_evidence
                where source = 'staff_entry' or status in ('confirmed', 'more_evidence')
                   or confirmed_by is not null or posted_by is not null or requested_by is not null or recorded_by is not null) then
      raise exception 'Payments were recorded, confirmed or sent back for more evidence: they cannot be rolled back.'; end if;
  end if;
  if exists (select 1 from public.finance_gl_queue where event_type = 'CASH_RECEIPT') then
    raise exception 'Cash receipts are queued for the ledger: they cannot be rolled back.'; end if;
end $guard$;

-- ================================================================================================= 5 customer order list (undo)
-- shop_my_orders goes back to the definition that was LIVE before this migration (pg_get_functiondef of 2026-11-20): the "To pay" chip without state 10.
CREATE OR REPLACE FUNCTION public.shop_my_orders(p_filter text DEFAULT 'all'::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid; lim integer := least(greatest(coalesce(p_limit, 20), 1), 50); off integer := greatest(coalesce(p_offset, 0), 0); res jsonb;
begin
  uid := public.shop_require_user();
  with mine as (
    select o.id, o.created_at, o.status, (public.finance_invoice_state_raw(o.invoice_id) ->> 'status_code')::int as pay
    from public.shop_orders o where o.profile_id = uid),
  f as (
    select m.*, count(*) over () as total from mine m
    where case coalesce(p_filter, 'all')
      when 'unpaid' then m.status <> 'cancelled' and m.pay in (0, 1, 3, 4, 7, 9)
      when 'to_ship' then m.status in ('new', 'confirmed', 'preparing', 'packed') and m.pay in (5, 6)
      when 'to_receive' then m.status in ('shipped', 'ready')
      when 'done' then m.status = 'completed'
      when 'cancelled' then m.status in ('cancelled', 'returned')
      else true end
    order by m.created_at desc limit lim offset off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0),
    'orders', coalesce(jsonb_agg(public.shop_order_json(f.id) order by f.created_at desc), '[]'::jsonb)) into res from f;
  return res;
end $function$;

-- ================================================================================================= 4 reads (undo)
-- The cancel goes back to the definition that was LIVE before this migration (pg_get_functiondef of 2026-11-19: no check for a confirmed payment), then the four reads,
-- the helpers they call (callers first) and the two indexes go. No data lives in any of these (the guard above has already refused if a confirmed payment exists, which
-- is what the removed cancel check was about).
CREATE OR REPLACE FUNCTION public.finance_cancel_invoice(p_invoice uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

drop function if exists public.finance_review_settings();
drop function if exists public.finance_review_detail(uuid);
drop function if exists public.finance_review_summary(date, date);
drop function if exists public.finance_review_list(jsonb, integer, integer);
drop function if exists public.finance_review_expected(uuid);
drop function if exists public.finance_review_date(jsonb, text);
drop function if exists public.finance_review_arr(jsonb, text, text[]);
drop function if exists public.finance_evidence_stage(text, text, text);
drop index if exists public.finance_evidence_invoice_idx;
drop index if exists public.finance_evidence_created_idx;

-- ================================================================================================= 3 workflow (undo)
-- The replaced functions go back to the definitions that were LIVE before this migration (pg_get_functiondef of 2026-11-19: the migrations of 2026-11-14/15 with the
-- numbering swap of 20261115500000 applied, so the one-step verify takes its receipt number from next_doc_no('PAYMENT')), then the new functions are dropped, callers before
-- the core and helpers they use. The guard at the top has already refused if a cash receipt, a staff entry or a confirmed / posted slip of the new flow exists, so no
-- record is lost here. (Customer slips that went through the one-step verify are untouched: they are exactly what the old function makes.)

-- finance_verify_evidence: the one-step verify as it was: the whole body again, no core
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
  v_rno := public.next_doc_no('PAYMENT');
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

-- finance_reject_evidence: reject: a submitted slip only
CREATE OR REPLACE FUNCTION public.finance_reject_evidence(p_evidence uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.finance_payment_evidence;
begin
  perform public.finance_require('verify', 'reject payments');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> 'submitted' then raise exception 'This slip is already %', e.status; end if;
  update public.finance_payment_evidence set status = 'rejected', reject_reason = trim(p_reason), reviewed_by = auth.uid(), reviewed_at = now() where id = p_evidence;
  perform public.finance_log('evidence', p_evidence, 'evidence.reject', jsonb_build_object('reason', trim(p_reason)));
end $function$;

-- finance_reverse_receipt: reverse: always against the bank
CREATE OR REPLACE FUNCTION public.finance_reverse_receipt(p_receipt uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare rc public.finance_receipts; v_alloc numeric; v_unapplied numeric; v_orig public.finance_wallet_transactions; v_t public.finance_wallet_transactions;
begin
  perform public.finance_require('manage', 'reverse receipts');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into rc from public.finance_receipts where id = p_receipt for update;
  if not found then raise exception 'Receipt not found'; end if;
  if rc.status <> 'posted' then raise exception 'Receipt is already %', rc.status; end if;
  perform 1 from public.finance_invoices where id = rc.invoice_id for update;
  v_alloc := coalesce((select sum(amount) from public.finance_allocations where receipt_id = rc.id and active), 0);
  v_unapplied := rc.amount - v_alloc;
  update public.finance_allocations set active = false, deactivated_by = auth.uid(), deactivated_at = now(), deactivate_reason = 'receipt reversed: ' || trim(p_reason)
    where receipt_id = rc.id and active;
  update public.finance_receipts set status = 'reversed', needs_review = false, reversed_by = auth.uid(), reversed_at = now(), reverse_reason = trim(p_reason) where id = rc.id;
  if rc.wallet_txn_id is not null then
    select * into v_orig from public.finance_wallet_transactions where id = rc.wallet_txn_id;
    v_t := public.finance_wallet_apply(rc.customer_id, 'REVERSAL', 'credit', rc.amount, 'REV:' || v_orig.id::text, 'wallet_txn', v_orig.id, v_orig.txn_no, 'wallet', null, 'not_required',
                                       auth.uid(), auth.uid(), 'Receipt ' || rc.receipt_no || ' reversed: ' || trim(p_reason), 'ยกเลิกการชำระ / Payment reversed', v_orig.id);
    perform public.finance_gl_enqueue('WALLET_REVERSAL', 'wallet_txn', v_t.id, v_t.txn_no, rc.customer_id, rc.amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', rc.amount), jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', rc.amount, 'wallet', true)));
  else
    if rc.credit_txn_id is not null then
      select * into v_orig from public.finance_wallet_transactions where id = rc.credit_txn_id;
      begin
        v_t := public.finance_wallet_apply(rc.customer_id, 'REVERSAL', 'debit', v_orig.amount, 'REV:' || v_orig.id::text, 'wallet_txn', v_orig.id, v_orig.txn_no, 'wallet', null, 'not_required',
                                           auth.uid(), auth.uid(), 'Receipt ' || rc.receipt_no || ' reversed: ' || trim(p_reason), 'ยกเลิกยอดเกินที่เข้ากระเป๋า / Overpayment credit reversed', v_orig.id);
      exception when sqlstate '23514' then
        raise exception 'CREDIT_ALREADY_USED: the customer already spent the wallet credit made from this receipt (%): correct the wallet first', v_orig.amount using errcode = '23514';
      end;
    end if;
    perform public.finance_gl_enqueue('RECEIPT_REVERSAL', 'receipt', rc.id, rc.receipt_no, rc.customer_id, rc.amount,
      jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'bank', 'amount', rc.amount, 'bank_account_id', rc.bank_account_id))
        || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
        || case when v_unapplied > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', v_unapplied) || case when rc.credit_txn_id is not null then jsonb_build_object('wallet', true) else '{}'::jsonb end) else '[]'::jsonb end);
  end if;
  perform public.finance_log('receipt', rc.id, 'receipt.reverse', jsonb_build_object('reason', trim(p_reason), 'amount', rc.amount));
  return public.finance_invoice_state_raw(rc.invoice_id);
end $function$;

-- finance_invoice_state_raw: the state of an invoice with its 10 statuses and no confirmed / more-evidence keys
CREATE OR REPLACE FUNCTION public.finance_invoice_state_raw(p_invoice uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare inv public.finance_invoices; paid numeric; outstanding numeric; review boolean; pending integer; req public.finance_payment_requests;
        last_ev public.finance_payment_evidence; code integer; credit numeric; refunded numeric;
begin
  select * into inv from public.finance_invoices where id = p_invoice;
  if not found then return null; end if;
  select coalesce(sum(a.amount), 0) into paid from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id
    where a.invoice_id = p_invoice and a.active and r.status = 'posted';
  outstanding := inv.amount - paid;
  select exists (select 1 from public.finance_receipts where invoice_id = p_invoice and status = 'posted' and needs_review) into review;
  select coalesce(sum(r.amount - coalesce((select sum(a.amount) from public.finance_allocations a where a.receipt_id = r.id and a.active), 0)), 0) into credit
    from public.finance_receipts r where r.invoice_id = p_invoice and r.status = 'posted';
  -- money given back to the customer's wallet: refunds of reversed bank receipts + wallet payments that were reversed
  select coalesce((select sum(t.amount) from public.finance_wallet_transactions t join public.finance_receipts r on r.id = t.ref_id
                    where t.txn_type = 'REFUND' and t.ref_type = 'receipt' and r.invoice_id = p_invoice), 0)
       + coalesce((select sum(r.amount) from public.finance_receipts r where r.invoice_id = p_invoice and r.status = 'reversed' and r.wallet_txn_id is not null), 0)
    into refunded;
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
    'unapplied', credit, 'refunded', refunded, 'status_code', code,
    'status', (array['unpaid', 'awaiting_payment', 'payment_submitted', 'pending_verification', 'partially_paid', 'fully_paid', 'overpaid', 'rejected', 'cancelled', 'expired'])[code + 1],
    'pending_evidence', pending,
    'request', case when req.id is null then null else jsonb_build_object('ref', req.ref, 'amount', req.amount, 'qr_payload', req.qr_payload, 'expires_at', req.expires_at, 'expired', req.expires_at <= now()) end);
end $function$;

-- shop_cancel_order_internal: cancel: SLIP_PENDING for a submitted slip only
CREATE OR REPLACE FUNCTION public.shop_cancel_order_internal(p_order uuid, p_reason text, p_by_customer boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.shop_orders;
begin
  select * into o from public.shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('cancelled', 'completed', 'returned') then raise exception 'This order is already %', o.status; end if;
  if p_by_customer and o.status <> 'new' then raise exception 'ORDER_IN_PROGRESS'; end if;
  perform 1 from public.finance_invoices where id = o.invoice_id for update;          -- serialises with payment verification
  if exists (select 1 from public.finance_receipts where invoice_id = o.invoice_id and status = 'posted') then
    raise exception 'PAYMENT_RECORDED'; end if;
  if exists (select 1 from public.finance_payment_evidence where invoice_id = o.invoice_id and status = 'submitted') then
    raise exception 'SLIP_PENDING'; end if;
  update public.finance_invoices set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = 'Order cancelled: ' || left(p_reason, 200)
    where id = o.invoice_id and status = 'open';
  update public.finance_payment_requests set status = 'cancelled' where invoice_id = o.invoice_id and status = 'awaiting';
  update public.shop_orders set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(p_reason, 200), updated_at = now() where id = o.id;
  perform public.finance_log('invoice', o.invoice_id, 'invoice.cancel', jsonb_build_object('reason', left(p_reason, 200), 'order', o.order_no, 'source', 'shop'));
  perform public.shop_log('order', o.id::text, 'order.cancel', jsonb_build_object('by', case when p_by_customer then 'customer' else 'staff' end, 'reason', left(p_reason, 200)));
end $function$;

-- finance_payments_overview: the payments list as it was
CREATE OR REPLACE FUNCTION public.finance_payments_overview(p_kind text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_bank uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0); v_q text := nullif(btrim(coalesce(p_search, '')), ''); v_pat text; v_res jsonb;
begin
  perform public.finance_require('view', 'see payments');
  if v_q is not null then v_pat := '%' || replace(replace(replace(left(v_q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with u as (
    select 'deposit'::text kind, d.id, d.deposit_no no, d.customer_id, null::text invoice_no, d.amount, d.verified_amount, d.status, d.bank_account_id, d.created_at, d.file_path, d.bank_trans_ref
      from public.finance_wallet_deposits d
    union all
    select 'invoice_slip', e.id, i.invoice_no, e.customer_id, i.invoice_no, e.claimed_amount, e.verified_amount,
           case e.status when 'submitted' then 'submitted' when 'verified' then 'verified' else 'rejected' end, e.bank_account_id, e.created_at, e.file_path, e.bank_trans_ref
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
end $function$;

-- finance_bank_daily_report: the bank report as it was
CREATE OR REPLACE FUNCTION public.finance_bank_daily_report(p_from date, p_to date, p_bank uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.finance_require('view', 'see the bank report');
  return coalesce((select jsonb_agg(r order by r ->> 'day' desc, r ->> 'bank_code') from (
    select jsonb_build_object('day', (x.at at time zone 'Asia/Bangkok')::date, 'bank_code', coalesce(b.code, 'PROMPTPAY/OTHER'), 'bank_account_id', x.bank,
      'deposits', count(*) filter (where x.kind = 'deposit'), 'deposit_amount', coalesce(sum(x.amount) filter (where x.kind = 'deposit'), 0),
      'invoice_transfers', count(*) filter (where x.kind = 'receipt'), 'invoice_amount', coalesce(sum(x.amount) filter (where x.kind = 'receipt'), 0),
      'total', sum(x.amount), 'in_ledger', coalesce(sum(x.amount) filter (where x.posted), 0), 'waiting_for_ledger', coalesce(sum(x.amount) filter (where not x.posted), 0)) r
    from (
      select 'deposit' kind, d.transfer_at at, d.bank_account_id bank, d.verified_amount amount,
             coalesce((select q.status = 'posted' from public.finance_gl_queue q where q.event_type = 'WALLET_DEPOSIT' and q.ref_id = d.wallet_txn_id), false) posted
        from public.finance_wallet_deposits d where d.status = 'verified'
      union all
      select 'receipt', rc.received_at, rc.bank_account_id, rc.amount,
             coalesce((select q.status = 'posted' from public.finance_gl_queue q where q.event_type = 'BANK_RECEIPT' and q.ref_id = rc.id), false)
        from public.finance_receipts rc where rc.status = 'posted' and rc.wallet_txn_id is null) x
    left join public.finance_bank_accounts b on b.id = x.bank
    where (x.at at time zone 'Asia/Bangkok')::date between p_from and p_to and (p_bank is null or x.bank = p_bank)
    group by (x.at at time zone 'Asia/Bangkok')::date, b.code, x.bank) q), '[]'::jsonb);
end $function$;

-- the trigger that closes older "more evidence" slips when a customer sends a new one goes first (it writes to the evidence table and calls finance_log), then its function.
-- It leaves no object of its own: what it changed (a closed slip) keeps requested_by, so the guard at the top has already refused if one exists.
drop trigger if exists finance_evidence_supersede_old on public.finance_payment_evidence;
drop function if exists public.finance_evidence_supersede_old();
drop function if exists public.finance_save_review_settings(jsonb);
drop function if exists public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text);
drop function if exists public.finance_request_more_evidence(uuid, text);
drop function if exists public.finance_post_evidence(uuid, text);
drop function if exists public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text);
drop function if exists public.finance_verify_core(uuid, numeric, text, timestamptz, text, text, text, text);
drop function if exists public.finance_ref_in_use(text, uuid);

-- ================================================================================================= 2 analysis (undo)
-- the queue trigger first (it writes to the analysis table that section 1c drops below), then the functions, callers before the helpers they use.
-- No data lives in these objects (the guard above has already refused if any analysis row exists), so nothing is lost.
-- (the duplicate-scan indexes, and the unique index on the normalised confirmed reference, use finance_slip_ref, so they go before it)
drop index if exists public.finance_evidence_confirmed_refnorm_once;
drop index if exists public.finance_receipts_slipref_idx;
drop index if exists public.finance_evidence_slipref_idx;
drop index if exists public.finance_evidence_confslipref_idx;
drop index if exists public.finance_deposits_slipref_idx;
drop index if exists public.finance_analysis_slipref_idx;
drop index if exists public.finance_analysis_qrslipref_idx;
drop trigger if exists finance_evidence_queue_analysis on public.finance_payment_evidence;
drop function if exists public.finance_evidence_queue_analysis();
drop function if exists public.finance_request_analysis(uuid);
drop function if exists public.finance_analysis_fail(uuid, text, text);
drop function if exists public.finance_analysis_complete(uuid, jsonb, jsonb, numeric, jsonb, text, text);
drop function if exists public.finance_analysis_begin(uuid, uuid, uuid);
drop function if exists public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb);
drop function if exists public.finance_slip_receivers();
drop function if exists public.finance_slip_reason(text, text, text, jsonb, jsonb, text);
drop function if exists public.finance_slip_name(text);
drop function if exists public.finance_slip_ref(text);
drop function if exists public.finance_can_as(uuid, text);

-- ================================================================================================= 1 schema (undo)
-- 1d ledger queue: the event types as they were (the original check had the generated name finance_gl_queue_event_type_check)
alter table public.finance_gl_queue drop constraint if exists finance_gl_queue_event_type_chk;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_gl_queue_event_type_check' and conrelid = 'public.finance_gl_queue'::regclass) then
    alter table public.finance_gl_queue add constraint finance_gl_queue_event_type_check
      check (event_type in ('INVOICE_ISSUE', 'INVOICE_CANCEL', 'BANK_RECEIPT', 'RECEIPT_REAPPLY', 'RECEIPT_REVERSAL', 'WALLET_DEPOSIT', 'WALLET_PAYMENT',
                            'WALLET_REFUND', 'WALLET_ADJUSTMENT', 'WALLET_REVERSAL'));
  end if;
end $$;

-- 1c the analysis table (its trigger, policy and constraints go with it)
drop table if exists public.finance_slip_analysis;
drop function if exists public.finance_guard_slip_analysis();

-- 1b evidence: checks, file columns, new columns (dropping a column drops the checks that only used it). (The unique index on the confirmed reference is section 2g: gone above.)
alter table public.finance_payment_evidence drop constraint if exists finance_payment_evidence_status_chk;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_payment_evidence_status_check' and conrelid = 'public.finance_payment_evidence'::regclass) then
    alter table public.finance_payment_evidence add constraint finance_payment_evidence_status_check check (status in ('submitted', 'verified', 'rejected'));
  end if;
end $$;
alter table public.finance_payment_evidence drop constraint if exists finance_evidence_file_required_chk;
alter table public.finance_payment_evidence alter column file_path set not null, alter column file_sha256 set not null, alter column file_type set not null;
alter table public.finance_payment_evidence
  drop column if exists source, drop column if exists method, drop column if exists recorded_by,
  drop column if exists confirmed_by, drop column if exists confirmed_at, drop column if exists confirmed_amount, drop column if exists confirmed_bank_ref,
  drop column if exists confirmed_transfer_at, drop column if exists confirm_note,
  drop column if exists posted_by, drop column if exists posted_at,
  drop column if exists request_message, drop column if exists requested_by, drop column if exists requested_at;

-- 1a settings
alter table public.finance_settings
  drop column if exists ai_review_enabled, drop column if exists post_requires_manager, drop column if exists ai_min_confidence,
  drop column if exists slip_window_before_min, drop column if exists slip_future_tolerance_min;

-- 1e receipts: nothing was changed (finance_receipts.method has no check), so there is nothing to undo.
