-- Rolls back 20261115400000_checkout_slip_pickup.sql (back to: address required for delivery, the slip is a separate step on the payment screen).
-- Refuses to run once an order exists that the old rules would not allow: a delivery order WITHOUT an address, or with one shorter than 10 characters.
-- The previous function bodies below were read from the live database before this migration was applied.
do $guard$ begin
  if exists (select 1 from public.shop_orders where fulfilment = 'delivery' and (delivery_address is null or length(delivery_address) < 10)) then
    raise exception 'Delivery orders without a full address exist: they cannot be rolled back under the old rule.'; end if;
end $guard$;

drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text);

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
  return jsonb_build_object('shop_open', s.shop_open and (exists (select 1 from public.finance_payment_accounts where is_default and active) or exists (select 1 from public.finance_bank_accounts where active)),
    'closed_message', s.closed_message, 'delivery_enabled', s.delivery_enabled, 'pickup_enabled', s.pickup_enabled, 'pickup_note', s.pickup_note,
    'shipping_fee', s.shipping_fee, 'free_shipping_min', s.free_shipping_min);
end $function$;

-- shop_admin_save_settings(p_patch jsonb)
CREATE OR REPLACE FUNCTION public.shop_admin_save_settings(p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cur public.shop_settings; fee numeric; fmin numeric;
begin
  perform public.shop_require_staff('change the shop settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Nothing to save'; end if;
  select * into cur from public.shop_settings where id for update;
  fee := case when p_patch ? 'shipping_fee' then (p_patch ->> 'shipping_fee')::numeric else cur.shipping_fee end;
  fmin := case when p_patch ? 'free_shipping_min' then nullif(p_patch ->> 'free_shipping_min', '')::numeric else cur.free_shipping_min end;
  if fee < 0 or fee <> round(fee, 2) then raise exception 'The shipping fee must be an amount in baht'; end if;
  if fmin is not null and (fmin <= 0 or fmin <> round(fmin, 2)) then raise exception 'The free-shipping amount must be a positive amount'; end if;
  update public.shop_settings set
    shop_open = case when p_patch ? 'shop_open' then (p_patch ->> 'shop_open')::boolean else shop_open end,
    closed_message = case when p_patch ? 'closed_message' then nullif(btrim(p_patch ->> 'closed_message'), '') else closed_message end,
    delivery_enabled = case when p_patch ? 'delivery_enabled' then (p_patch ->> 'delivery_enabled')::boolean else delivery_enabled end,
    pickup_enabled = case when p_patch ? 'pickup_enabled' then (p_patch ->> 'pickup_enabled')::boolean else pickup_enabled end,
    pickup_note = case when p_patch ? 'pickup_note' then nullif(btrim(p_patch ->> 'pickup_note'), '') else pickup_note end,
    shipping_fee = fee, free_shipping_min = fmin, updated_by = auth.uid(), updated_at = now()
  where id;
  perform public.shop_log('settings', 'shop', 'settings.save', p_patch);
  return public.shop_admin_settings();
end $function$;

-- shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric, p_payment_method text)
CREATE OR REPLACE FUNCTION public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric DEFAULT NULL::numeric, p_payment_method text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

revoke execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text) from public, anon;
grant execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text) to authenticated;

alter table public.shop_orders drop constraint if exists shop_orders_address_only_delivery;
alter table public.shop_orders drop constraint if exists shop_orders_delivery_address_len;
alter table public.shop_orders add constraint shop_orders_check1 check ((fulfilment = 'delivery') = (delivery_address is not null));
alter table public.shop_orders add constraint shop_orders_delivery_address_check check (delivery_address is null or (length(delivery_address) >= 10 and length(delivery_address) <= 400));
alter table public.shop_settings drop column if exists require_payment_slip;
