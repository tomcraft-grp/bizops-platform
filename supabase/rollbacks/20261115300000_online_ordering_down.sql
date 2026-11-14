-- Rolls back 20261115300000_online_ordering.sql (back to the shop + wallet behaviour: the receivable is queued the moment an invoice is created,
-- an overpayment waits for staff to resolve it, place_order has no payment-choice parameter).
-- Refuses to run once the new columns hold data: a wallet credit made from an overpayment (receipts.credit_txn_id) and the payment choice a customer
-- made (shop_orders.payment_pref) are records and are never dropped. The pre-change function bodies below were read from the live database.
do $guard$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_receipts' and column_name = 'credit_txn_id')
     and exists (select 1 from public.finance_receipts where credit_txn_id is not null) then
    raise exception 'Overpayments were credited to wallets: those receipts cannot be rolled back.'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shop_orders' and column_name = 'payment_pref')
     and exists (select 1 from public.shop_orders where payment_pref is not null) then
    raise exception 'Orders carry a payment choice: they cannot be rolled back.'; end if;
end $guard$;

-- 1) the receivable of every open invoice goes to the queue now (the old behaviour queued at creation; the deferred ones would otherwise be lost)
do $q$ declare r record; begin
  if to_regprocedure('public.finance_gl_ensure_invoice_issue(uuid)') is not null then
    for r in select id from public.finance_invoices where status = 'open' loop perform public.finance_gl_ensure_invoice_issue(r.id); end loop;
  end if;
end $q$;

-- 2) the functions as they were before
drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text);

-- finance_invoice_state_raw(p_invoice uuid)
CREATE OR REPLACE FUNCTION public.finance_invoice_state_raw(p_invoice uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare inv public.finance_invoices; paid numeric; outstanding numeric; review boolean; pending integer; req public.finance_payment_requests;
        last_ev public.finance_payment_evidence; code integer; credit numeric;
begin
  select * into inv from public.finance_invoices where id = p_invoice;
  if not found then return null; end if;
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
end $function$;

-- finance_gl_invoice_trigger()
CREATE OR REPLACE FUNCTION public.finance_gl_invoice_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_issue uuid;
begin
  if tg_op = 'INSERT' then
    perform public.finance_gl_enqueue('INVOICE_ISSUE', 'invoice', new.id, new.invoice_no, new.customer_id, new.amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', new.amount), jsonb_build_object('side', 'cr', 'role', 'sales', 'amount', new.amount, 'vat', 'split')));
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    select id into v_issue from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = new.id;
    if v_issue is not null and (select status from public.finance_gl_queue where id = v_issue) = 'pending' then
      update public.finance_gl_queue set status = 'void', void_reason = 'The invoice was cancelled before it was posted' where id = v_issue;
    elsif v_issue is not null then
      perform public.finance_gl_enqueue('INVOICE_CANCEL', 'invoice', new.id, new.invoice_no, new.customer_id, new.amount,
        jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'sales', 'amount', new.amount, 'vat', 'split'), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', new.amount)), v_issue);
    end if;
  end if;
  return new;
end $function$;

-- finance_gl_issue_dep(p_invoice uuid)
CREATE OR REPLACE FUNCTION public.finance_gl_issue_dep(p_invoice uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = p_invoice and status = 'pending'
$function$;

-- shop_order_json(p_order uuid)
CREATE OR REPLACE FUNCTION public.shop_order_json(p_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.shop_orders; st jsonb;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  st := public.finance_invoice_state_raw(o.invoice_id);
  return jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'status', o.status, 'fulfilment', o.fulfilment, 'channel', o.channel,
    'contact_name', o.contact_name, 'contact_phone', o.contact_phone, 'delivery_address', o.delivery_address, 'note', o.note,
    'subtotal', o.subtotal, 'discount', o.discount, 'shipping_fee', o.shipping_fee, 'total', o.total,
    'created_at', o.created_at, 'updated_at', o.updated_at, 'status_note', o.status_note, 'cancel_reason', o.cancel_reason, 'cancelled_at', o.cancelled_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'sku_code', i.sku_code, 'name', i.name, 'unit', i.unit, 'unit_price', i.unit_price,
        'qty', i.qty, 'line_total', i.line_total,
        'image_url', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = i.sku_code)) order by i.line_no), '[]'::jsonb)
      from public.shop_order_items i where i.order_id = o.id),
    'invoice', (select jsonb_build_object('id', v.id, 'invoice_no', v.invoice_no, 'issue_date', v.issue_date, 'due_date', v.due_date,
        'description', v.description, 'customer_name', c.name) || coalesce(st, '{}'::jsonb)
      from public.finance_invoices v join public.finance_customers c on c.id = v.customer_id where v.id = o.invoice_id));
end $function$;

-- shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric)
CREATE OR REPLACE FUNCTION public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid; prof public.profiles; s public.shop_settings; q jsonb; norm jsonb; hash text; existing public.shop_orders;
        fin uuid; ono text; oid uuid := gen_random_uuid(); inv public.finance_invoices; phone text; nm text; addr text; nt text; n integer; ln integer := 0; l jsonb;
begin
  uid := public.shop_require_user();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_key, 0));    -- serialises retries of the same checkout

  select * into s from public.shop_settings where id;
  nm := btrim(coalesce(p_name, '')); phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  addr := nullif(btrim(coalesce(p_address, '')), ''); nt := nullif(btrim(coalesce(p_note, '')), '');
  select coalesce(jsonb_agg(jsonb_build_object('sku', k, 'qty', t) order by k), '[]'::jsonb) into norm from (
    select e ->> 'sku_code' k, sum(case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::int else 0 end) t
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e group by 1) z;
  hash := md5(jsonb_build_object('items', norm, 'f', p_fulfilment, 'n', nm, 'p', phone, 'a', addr, 'note', nt)::text);

  -- a retry of the same checkout returns the order it already created (never a second one)
  select * into existing from public.shop_orders where profile_id = uid and idempotency_key = p_key;
  if found then
    if existing.request_hash <> hash then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return jsonb_build_object('replay', true, 'order', public.shop_order_json(existing.id));
  end if;

  if not s.shop_open then raise exception 'SHOP_CLOSED'; end if;
  if not (exists (select 1 from public.finance_payment_accounts where is_default and active) or exists (select 1 from public.finance_bank_accounts where active)) then raise exception 'NO_PAYMENT_ACCOUNT'; end if;
  if (select count(*) from public.shop_orders where profile_id = uid and created_at > now() - interval '1 hour') >= 10 then raise exception 'TOO_MANY_ORDERS'; end if;

  if length(nm) not between 1 and 100 then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if phone !~ '^0[0-9]{8,9}$' then raise exception 'INVALID_PHONE' using errcode = '22023'; end if;
  if p_fulfilment = 'delivery' and (addr is null or length(addr) < 10 or length(addr) > 400) then raise exception 'INVALID_ADDRESS' using errcode = '22023'; end if;
  if p_fulfilment = 'pickup' then addr := null; end if;
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
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref, created_by)
    values ('INV-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_invoice_seq')::text, 5, '0'),
            fin, (now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date, (q ->> 'total')::numeric,
            'Online order ' || ono, ono, uid)
    returning * into inv;
  perform public.finance_log('invoice', inv.id, 'invoice.issue', jsonb_build_object('no', inv.invoice_no, 'amount', inv.amount, 'customer', fin, 'order', ono, 'source', 'shop'));

  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone,
      delivery_address, note, subtotal, discount, shipping_fee, total, invoice_id)
    values (oid, ono, uid, fin, p_key, hash, p_fulfilment, nm, phone, addr, nt, (q ->> 'subtotal')::numeric, (q ->> 'discount')::numeric,
            (q ->> 'shipping_fee')::numeric, (q ->> 'total')::numeric, inv.id);
  for l in select * from jsonb_array_elements(q -> 'lines') loop
    ln := ln + 1;
    insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total)
      values (oid, ln, l ->> 'sku_code', l ->> 'name', l ->> 'unit', (l ->> 'unit_price')::numeric, (l ->> 'qty')::int, (l ->> 'line_total')::numeric);
  end loop;
  perform public.shop_log('order', oid::text, 'order.place', jsonb_build_object('no', ono, 'total', q -> 'total', 'lines', ln, 'invoice', inv.invoice_no, 'fulfilment', p_fulfilment));
  return jsonb_build_object('replay', false, 'order', public.shop_order_json(oid));
end $function$;

-- shop_admin_set_status(p_order uuid, p_status text, p_note text, p_override_reason text)
CREATE OR REPLACE FUNCTION public.shop_admin_set_status(p_order uuid, p_status text, p_note text DEFAULT NULL::text, p_override_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.shop_orders; st jsonb; code integer; ok boolean; overridden boolean := false;
        v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_why text := nullif(btrim(coalesce(p_override_reason, '')), '');
begin
  perform public.shop_require_staff('change an order');
  if p_status = 'cancelled' then
    if v_note is null then raise exception 'A reason is required'; end if;
    perform public.shop_cancel_order_internal(p_order, v_note, false);
    return public.shop_order_json(p_order);
  end if;
  select * into o from public.shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  ok := case o.status
    when 'new' then p_status = 'confirmed'
    when 'confirmed' then p_status = 'preparing'
    when 'preparing' then p_status = 'packed'
    when 'packed' then (p_status = 'shipped' and o.fulfilment = 'delivery') or (p_status = 'ready' and o.fulfilment = 'pickup')
    when 'ready' then p_status = 'completed'
    when 'shipped' then p_status in ('completed', 'returned')
    when 'completed' then p_status = 'returned'
    else false end;
  if not ok then raise exception 'An order that is % cannot become %', o.status, p_status; end if;
  if p_status = 'returned' and v_note is null then raise exception 'A reason is required'; end if;
  if p_status <> 'confirmed' and p_status <> 'returned' then
    st := public.finance_invoice_state_raw(o.invoice_id);
    code := (st ->> 'status_code')::int;
    if code not in (5, 6) then
      if v_why is null then raise exception 'PAYMENT_REQUIRED'; end if;
      overridden := true;
    end if;
  end if;
  update public.shop_orders set status = p_status, status_note = coalesce(v_note, status_note), updated_at = now() where id = o.id;
  perform public.shop_log('order', o.id::text, 'order.status', jsonb_build_object('from', o.status, 'to', p_status, 'note', v_note,
    'payment_override', overridden, 'override_reason', case when overridden then v_why end));
  return public.shop_order_json(o.id);
end $function$;

-- finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamp with time zone, p_note text, p_via text)
CREATE OR REPLACE FUNCTION public.finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamp with time zone, p_note text DEFAULT NULL::text, p_via text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.finance_payment_evidence; i public.finance_invoices; st jsonb; outstanding numeric; rc public.finance_receipts; result text; v_alloc numeric := 0;
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
  update public.finance_payment_evidence set status = 'verified', verified_via = p_via, verified_amount = p_amount, bank_trans_ref = trim(p_bank_trans_ref),
    transfer_at = p_transfer_at, review_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now() where id = e.id;
  insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at, needs_review, method, bank_account_id)
    values ('RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0'),
            i.customer_id, i.id, e.id, p_amount, trim(p_bank_trans_ref), p_transfer_at, p_amount > outstanding, 'bank_transfer', e.bank_account_id)
    returning * into rc;
  if p_amount <= outstanding then
    insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, i.id, p_amount);
    v_alloc := p_amount;
    result := case when p_amount = outstanding then 'fully_paid' else 'partially_paid' end;
  else
    result := 'overpaid_review';
  end if;
  -- ledger: money in the bank; the applied part settles the receivable, any overpayment is a customer credit until staff decide
  perform public.finance_gl_enqueue('BANK_RECEIPT', 'receipt', rc.id, rc.receipt_no, i.customer_id, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', e.bank_account_id))
      || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
      || case when p_amount - v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', p_amount - v_alloc)) else '[]'::jsonb end,
    public.finance_gl_issue_dep(i.id));
  perform public.finance_log('evidence', e.id, 'evidence.verify', jsonb_build_object('via', p_via, 'amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', trim(p_bank_trans_ref), 'bank_account', e.bank_account_id));
  perform public.finance_log('receipt', rc.id, 'receipt.post', jsonb_build_object('invoice', i.id, 'amount', p_amount, 'outstanding_before', outstanding, 'result', result));
  return jsonb_build_object('result', result, 'receipt_no', rc.receipt_no, 'state', public.finance_invoice_state_raw(i.id));
end $function$;

-- finance_reverse_receipt(p_receipt uuid, p_reason text)
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
    perform public.finance_gl_enqueue('RECEIPT_REVERSAL', 'receipt', rc.id, rc.receipt_no, rc.customer_id, rc.amount,
      jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'bank', 'amount', rc.amount, 'bank_account_id', rc.bank_account_id))
        || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
        || case when v_unapplied > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', v_unapplied)) else '[]'::jsonb end);
  end if;
  perform public.finance_log('receipt', rc.id, 'receipt.reverse', jsonb_build_object('reason', trim(p_reason), 'amount', rc.amount));
  return public.finance_invoice_state_raw(rc.invoice_id);
end $function$;

revoke execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric) from public, anon;
grant execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric) to authenticated;

-- 3) the new helper and the new columns
drop function if exists public.finance_gl_ensure_invoice_issue(uuid);
alter table public.finance_receipts drop column if exists credit_txn_id;
alter table public.shop_orders drop column if exists payment_pref;
