-- Online ordering, ready to open (builds on 20261115100000_customer_shop and 20261115200000_wallet_payments).
--
-- 1. Accounting: an online order is NOT an accounting event. The receivable (INVOICE_ISSUE) is queued for the accountant only when staff
--    CONFIRM the order, or when the first payment on the invoice is verified (money received means the sale stands). Before that the invoice
--    exists as a payment request and nothing reaches the ledger queue; an order cancelled before confirmation leaves no accounting trace.
-- 2. Overpayment: the part of a verified bank transfer that is above what the invoice owes is credited to the customer's wallet in the same
--    transaction (Dr bank / Cr accounts receivable for the owed part / Cr customer wallet liability for the rest). Reversing the receipt reverses
--    that credit too, and refuses if the customer has already spent it.
-- 3. The customer's payment choice at checkout (a bank, the wallet or the QR) is stored on the order for staff and pre-selects the payment screen.
-- 4. Invoice state reports how much was refunded (to the wallet), so the customer sees a "refunded" status.
-- Every function keeps its signature except shop_place_order, which gains an OPTIONAL last parameter (older app builds keep working).

alter table public.shop_orders add column if not exists payment_pref text
  check (payment_pref is null or payment_pref ~ '^(wallet|qr|bank:[A-Za-z0-9]{2,12})$');
alter table public.finance_receipts add column if not exists credit_txn_id uuid;     -- the wallet credit made from an overpayment on this receipt

-- ---------------------------------------------------------------------------------------------- invoice state: + refunded
create or replace function public.finance_invoice_state_raw(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
end $$;

-- ---------------------------------------------------------------------------------------------- ledger queue: the receivable follows confirmation
-- an invoice is a sale on credit: Dr receivable / Cr sales. Cancelled before it was posted: both rows disappear; after: reversed.
-- Invoices created by the shop set finance.defer_gl for the length of their INSERT: they are queued later, by finance_gl_ensure_invoice_issue.
create or replace function public.finance_gl_invoice_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_issue uuid;
begin
  if tg_op = 'INSERT' then
    if coalesce(current_setting('finance.defer_gl', true), '') <> 'on' then
      perform public.finance_gl_enqueue('INVOICE_ISSUE', 'invoice', new.id, new.invoice_no, new.customer_id, new.amount,
        jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', new.amount), jsonb_build_object('side', 'cr', 'role', 'sales', 'amount', new.amount, 'vat', 'split')));
    end if;
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
end $$;

-- queue the receivable of an open invoice (once). Called when staff confirm an order and before any payment row that depends on it.
create or replace function public.finance_gl_ensure_invoice_issue(p_invoice uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv public.finance_invoices; v_id uuid;
begin
  select * into v_inv from public.finance_invoices where id = p_invoice;
  if not found or v_inv.status <> 'open' then return null; end if;
  select id into v_id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = p_invoice;
  if v_id is not null then return v_id; end if;
  return public.finance_gl_enqueue('INVOICE_ISSUE', 'invoice', v_inv.id, v_inv.invoice_no, v_inv.customer_id, v_inv.amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', v_inv.amount), jsonb_build_object('side', 'cr', 'role', 'sales', 'amount', v_inv.amount, 'vat', 'split')));
end $$;
revoke execute on function public.finance_gl_ensure_invoice_issue(uuid) from public, anon, authenticated;

-- the invoice row that must be in the ledger before a payment on it can be (null when it is already posted). A payment needs the receivable,
-- so asking for it queues the receivable when it was still waiting for confirmation.
create or replace function public.finance_gl_issue_dep(p_invoice uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.finance_gl_ensure_invoice_issue(p_invoice);
  select id into v_id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = p_invoice and status = 'pending';
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------- orders
create or replace function public.shop_order_json(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; st jsonb;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  st := public.finance_invoice_state_raw(o.invoice_id);
  return jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'status', o.status, 'fulfilment', o.fulfilment, 'channel', o.channel,
    'contact_name', o.contact_name, 'contact_phone', o.contact_phone, 'delivery_address', o.delivery_address, 'note', o.note,
    'subtotal', o.subtotal, 'discount', o.discount, 'shipping_fee', o.shipping_fee, 'total', o.total, 'payment_pref', o.payment_pref,
    'created_at', o.created_at, 'updated_at', o.updated_at, 'status_note', o.status_note, 'cancel_reason', o.cancel_reason, 'cancelled_at', o.cancelled_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'sku_code', i.sku_code, 'name', i.name, 'unit', i.unit, 'unit_price', i.unit_price,
        'qty', i.qty, 'line_total', i.line_total,
        'image_url', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = i.sku_code)) order by i.line_no), '[]'::jsonb)
      from public.shop_order_items i where i.order_id = o.id),
    'invoice', (select jsonb_build_object('id', v.id, 'invoice_no', v.invoice_no, 'issue_date', v.issue_date, 'due_date', v.due_date,
        'description', v.description, 'customer_name', c.name) || coalesce(st, '{}'::jsonb)
      from public.finance_invoices v join public.finance_customers c on c.id = v.customer_id where v.id = o.invoice_id));
end $$;

-- place an order: the same function plus an OPTIONAL payment choice ('wallet', 'qr' or 'bank:<CODE>'). Prices and totals are still the server's.
drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric);
create or replace function public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text,
  p_note text, p_expected_total numeric default null, p_payment_method text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; prof public.profiles; s public.shop_settings; q jsonb; norm jsonb; hash text; existing public.shop_orders; pm text;
        fin uuid; ono text; oid uuid := gen_random_uuid(); inv public.finance_invoices; phone text; nm text; addr text; nt text; n integer; ln integer := 0; l jsonb;
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
  -- (the payment choice joins the hash only when given, so a checkout without one hashes exactly as before)
  hash := md5((jsonb_build_object('items', norm, 'f', p_fulfilment, 'n', nm, 'p', phone, 'a', addr, 'note', nt)
               || case when pm is null then '{}'::jsonb else jsonb_build_object('pm', pm) end)::text);

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
  perform public.shop_log('order', oid::text, 'order.place', jsonb_build_object('no', ono, 'total', q -> 'total', 'lines', ln, 'invoice', inv.invoice_no, 'fulfilment', p_fulfilment, 'payment_pref', pm));
  return jsonb_build_object('replay', false, 'order', public.shop_order_json(oid));
end $$;
revoke execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text) from public, anon;
grant execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text) to authenticated;

-- staff move an order along. Confirming it (or any later step) is what puts the receivable into the ledger queue.
create or replace function public.shop_admin_set_status(p_order uuid, p_status text, p_note text default null, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
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
  perform public.finance_gl_ensure_invoice_issue(o.invoice_id);        -- a confirmed sale: the receivable goes to the accountant's queue (once)
  perform public.shop_log('order', o.id::text, 'order.status', jsonb_build_object('from', o.status, 'to', p_status, 'note', v_note,
    'payment_override', overridden, 'override_reason', case when overridden then v_why end));
  return public.shop_order_json(o.id);
end $$;

-- ---------------------------------------------------------------------------------------------- verification: overpayment goes to the wallet
create or replace function public.finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz,
  p_note text default null, p_via text default 'staff')
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

-- Reversing a receipt: a wallet payment returns the money to the wallet (a REVERSAL row); a bank receipt is reversed in the ledger, and so is
-- the wallet credit it made from an overpayment (refused when the customer already spent that credit).
create or replace function public.finance_reverse_receipt(p_receipt uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;
