-- Rolls back 20261115200000_wallet_payments.sql.
-- Refuses to run once the wallet has been used: wallet transactions, deposits, wallet receipts, posted ledger rows and the bank a customer
-- chose on a slip are financial records and are never deleted. Close the wallet instead (switch the bank accounts off in Payments & wallet).
-- The pre-wallet bodies of the finance_* and shop_* functions below were read from the live database before the wallet migration was applied.
do $guard$ begin
  if to_regclass('public.finance_wallet_transactions') is not null and exists (select 1 from public.finance_wallet_transactions) then
    raise exception 'Wallet transactions exist: they are financial records and cannot be rolled back.'; end if;
  if to_regclass('public.finance_wallet_deposits') is not null and exists (select 1 from public.finance_wallet_deposits) then
    raise exception 'Wallet deposits exist: they are financial records and cannot be rolled back.'; end if;
  if to_regclass('public.finance_wallets') is not null and exists (select 1 from public.finance_wallets where balance <> 0) then
    raise exception 'A wallet holds money: it cannot be rolled back.'; end if;
  if to_regclass('public.finance_gl_queue') is not null and exists (select 1 from public.finance_gl_queue where status = 'posted') then
    raise exception 'Ledger rows were already posted to the accounting ledger: they cannot be rolled back.'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_receipts' and column_name = 'wallet_txn_id')
     and exists (select 1 from public.finance_receipts where wallet_txn_id is not null or evidence_id is null) then
    raise exception 'Receipts paid from a wallet exist: they cannot be rolled back.'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_receipts' and column_name = 'bank_account_id')
     and exists (select 1 from public.finance_receipts where bank_account_id is not null) then
    raise exception 'Receipts record which bank account was paid: they cannot be rolled back.'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_payment_evidence' and column_name = 'bank_account_id')
     and exists (select 1 from public.finance_payment_evidence where bank_account_id is not null) then
    raise exception 'Payment slips record which bank account the customer chose: they cannot be rolled back.'; end if;
  if to_regclass('public.finance_bank_accounts') is not null and exists (select 1 from public.finance_bank_accounts where code not in ('SCB', 'BBL')) then
    raise exception 'Bank accounts were added after the migration: write them down first, then roll back.'; end if;
end $guard$;

-- 1) the queue trigger on invoices, then the functions the wallet migration REPLACED: back to their pre-wallet bodies
drop trigger if exists finance_invoices_gl on public.finance_invoices;
drop function if exists public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text, uuid);

-- finance_submit_evidence(p_invoice uuid, p_file_path text, p_sha256 text, p_file_type text, p_claimed_amount numeric, p_transfer_at timestamp with time zone, p_bank text, p_ref text)
CREATE OR REPLACE FUNCTION public.finance_submit_evidence(p_invoice uuid, p_file_path text, p_sha256 text, p_file_type text, p_claimed_amount numeric, p_transfer_at timestamp with time zone, p_bank text, p_ref text)
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
end $function$;

-- finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamp with time zone, p_note text, p_via text)
CREATE OR REPLACE FUNCTION public.finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamp with time zone, p_note text DEFAULT NULL::text, p_via text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

-- finance_resolve_overpayment(p_receipt uuid, p_note text)
CREATE OR REPLACE FUNCTION public.finance_resolve_overpayment(p_receipt uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

-- finance_reverse_receipt(p_receipt uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.finance_reverse_receipt(p_receipt uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

-- shop_settings_public()
CREATE OR REPLACE FUNCTION public.shop_settings_public()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.shop_settings;
begin
  perform public.shop_require_user();
  select * into s from public.shop_settings where id;
  return jsonb_build_object('shop_open', s.shop_open and exists (select 1 from public.finance_payment_accounts where is_default and active),
    'closed_message', s.closed_message, 'delivery_enabled', s.delivery_enabled, 'pickup_enabled', s.pickup_enabled, 'pickup_note', s.pickup_note,
    'shipping_fee', s.shipping_fee, 'free_shipping_min', s.free_shipping_min);
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
  if not exists (select 1 from public.finance_payment_accounts where is_default and active) then raise exception 'NO_PAYMENT_ACCOUNT'; end if;
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

-- shop_admin_settings()
CREATE OR REPLACE FUNCTION public.shop_admin_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.shop_settings;
begin
  perform public.shop_require_staff('see the shop settings');
  select * into s from public.shop_settings where id;
  return to_jsonb(s) - 'id' - 'updated_by' || jsonb_build_object(
    'payment_account_ready', exists (select 1 from public.finance_payment_accounts where is_default and active),
    'visible_products', (select count(*) from public.shop_sellable),
    'products_with_image', (select count(*) from public.shop_sellable where cardinality(image_urls) > 0));
end $function$;

revoke execute on function public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text) from public, anon;
grant execute on function public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text) to authenticated;

-- 2) columns the migration added to existing tables
alter table public.finance_receipts drop column if exists bank_account_id, drop column if exists wallet_txn_id;
alter table public.finance_receipts alter column evidence_id set not null;
alter table public.finance_payment_evidence drop column if exists bank_account_id;

-- 3) the new functions first (several return the new tables' row types), then the tables (their triggers, policies and indexes go with them),
--    then the trigger functions those triggers used, then the sequences
do $drop$ declare f text; begin
  foreach f in array array[
    'finance_payment_methods()', 'finance_save_bank_account(uuid, text, text, text, text, text, text, text, text, text, text, integer, boolean)', 'finance_save_settings(jsonb)',
    'finance_deposit_create(uuid, numeric, text, text)', 'finance_deposit_submit_slip(uuid, text, text, text, timestamptz, text)', 'finance_deposit_cancel(uuid)',
    'finance_deposit_start_review(uuid)', 'finance_deposit_verify(uuid, numeric, text, timestamptz, text)', 'finance_deposit_reject(uuid, text)',
    'finance_pay_invoice_with_wallet(uuid, numeric, text)', 'finance_wallet_refund(uuid, numeric, text, text)', 'finance_wallet_adjust(uuid, text, numeric, text, text, text)',
    'finance_wallet_reverse(uuid, text)', 'finance_my_wallet()', 'finance_my_wallet_transactions(integer, integer)', 'finance_my_deposits(integer)',
    'finance_payments_overview(text, text, uuid, text, integer, integer)', 'finance_wallets_overview(text, integer, integer)', 'finance_wallet_ledger(uuid, integer, integer)',
    'finance_wallet_reconcile()', 'finance_bank_daily_report(date, date, uuid)', 'finance_gl_pending(text, integer)', 'finance_gl_mark_posted(uuid, text, text)',
    'finance_gl_void(uuid, text)', 'finance_gl_reconciliation()',
    'finance_wallet_apply(uuid, text, text, numeric, text, text, uuid, text, text, uuid, text, uuid, uuid, text, text, uuid)',
    'finance_gl_enqueue(text, text, uuid, text, uuid, numeric, jsonb, uuid)', 'finance_gl_issue_dep(uuid)', 'finance_gl_invoice_trigger()', 'finance_ensure_customer()'] loop
    execute format('drop function if exists public.%s', f);
  end loop;
end $drop$;
drop table if exists public.finance_gl_queue, public.finance_wallet_deposits, public.finance_wallet_transactions, public.finance_wallets, public.finance_bank_accounts, public.finance_settings;
drop function if exists public.finance_guard_wallet();
drop function if exists public.finance_wallet_txn_immutable();
drop function if exists public.finance_guard_deposit();
drop function if exists public.finance_guard_gl_queue();
drop sequence if exists public.finance_wallet_txn_seq, public.finance_deposit_seq;
