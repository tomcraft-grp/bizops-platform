-- Rollback of 20261128130000_delivery_pin.sql: the previous definitions of the four functions come back verbatim, then the new objects go.
-- It REFUSES while any delivery pin or saved address exists (dropping them would lose what customers entered and what staff use to deliver): export them first.
do $$ begin
  if exists (select 1 from public.shop_order_delivery) then raise exception 'REFUSING: % orders carry a delivery pin; export public.shop_order_delivery before rolling back', (select count(*) from public.shop_order_delivery); end if;
  if exists (select 1 from public.shop_addresses) then raise exception 'REFUSING: % saved delivery addresses exist; export public.shop_addresses before rolling back', (select count(*) from public.shop_addresses); end if;
end $$;

drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text, timestamptz, jsonb);
create or replace function public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric default null,
  p_payment_method text default null, p_slip_path text default null, p_slip_sha256 text default null, p_slip_type text default null, p_slip_transfer_at timestamptz default null, p_slip_ref text default null,
  p_pickup_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; prof public.profiles; s public.shop_settings; q jsonb; norm jsonb; hash text; existing public.shop_orders; pm text;
        fin uuid; ono text; oid uuid := gen_random_uuid(); inv public.finance_invoices; phone text; nm text; addr text; nt text; n integer; ln integer := 0; l jsonb;
        v_bank_id uuid; v_bank_code text; v_units integer;
begin
  uid := public.shop_require_user();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_key, 0));    -- serialises retries of the same checkout

  select * into s from public.shop_settings where id;
  nm := btrim(coalesce(p_name, '')); phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  addr := nullif(btrim(coalesce(p_address, '')), ''); nt := nullif(btrim(coalesce(p_note, '')), ''); pm := nullif(btrim(coalesce(p_payment_method, '')), '');
  if p_pickup_at is not null and p_fulfilment is distinct from 'pickup' then raise exception 'PREORDER_PICKUP_ONLY' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sku', k, 'qty', t) order by k), '[]'::jsonb) into norm from (
    select e ->> 'sku_code' k, sum(case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::int else 0 end) t
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e group by 1) z;
  -- (the payment choice, the slip and the pickup time join the hash only when given, so a checkout without them hashes exactly as before)
  hash := md5((jsonb_build_object('items', norm, 'f', p_fulfilment, 'n', nm, 'p', phone, 'a', addr, 'note', nt)
               || case when pm is null then '{}'::jsonb else jsonb_build_object('pm', pm) end
               || case when p_slip_sha256 is null then '{}'::jsonb else jsonb_build_object('slip', lower(p_slip_sha256)) end
               || case when p_pickup_at is null then '{}'::jsonb else jsonb_build_object('pu', extract(epoch from p_pickup_at)::bigint) end)::text);

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
  -- the pickup time: the day lock is taken here and held to the end of this transaction, so the place counted below is really this order's
  if p_pickup_at is not null then
    select coalesce(sum((x ->> 'qty')::int), 0) into v_units from jsonb_array_elements(q -> 'lines') x;
    perform public.preorder_check_slot(p_pickup_at, v_units, null, false, false);
  end if;

  select * into prof from public.profiles where id = uid;
  select id into fin from public.finance_customers where profile_id = uid;
  if fin is null then
    insert into public.finance_customers (code, name, profile_id, created_by)
      values ('LINE-' || upper(substr(replace(uid::text, '-', ''), 1, 10)), coalesce(nullif(btrim(prof.display_name), ''), nm), uid, uid)
      returning id into fin;
    perform public.shop_log('customer', fin::text, 'customer.create', jsonb_build_object('profile', uid));
  end if;

  ono := public.next_doc_no('ORDER');
  perform set_config('finance.defer_gl', 'on', true);          -- the receivable is queued when staff confirm the order (or when a payment is verified)
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref, created_by)
    values (public.next_doc_no('INVOICE'),
            fin, (now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date, (q ->> 'total')::numeric,
            case when p_pickup_at is null then 'Online order ' else 'Online preorder ' end || ono, ono, uid)
    returning * into inv;
  perform set_config('finance.defer_gl', 'off', true);
  perform public.finance_log('invoice', inv.id, 'invoice.issue', jsonb_build_object('no', inv.invoice_no, 'amount', inv.amount, 'customer', fin, 'order', ono, 'source', 'shop'));

  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone,
      delivery_address, note, subtotal, discount, shipping_fee, total, invoice_id, payment_pref, order_type, pickup_at)
    values (oid, ono, uid, fin, p_key, hash, p_fulfilment, nm, phone, addr, nt, (q ->> 'subtotal')::numeric, (q ->> 'discount')::numeric,
            (q ->> 'shipping_fee')::numeric, (q ->> 'total')::numeric, inv.id, pm, case when p_pickup_at is null then 'regular' else 'preorder' end, p_pickup_at);
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
    'payment_pref', pm, 'slip', p_slip_path is not null) || case when p_pickup_at is null then '{}'::jsonb else jsonb_build_object('pickup_at', p_pickup_at, 'order_type', 'preorder') end);
  if p_pickup_at is not null then perform public.preorder_after_place(oid); end if;
  return jsonb_build_object('replay', false, 'order', public.shop_order_json(oid));
end $$;
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
    'order_type', o.order_type, 'pickup_at', o.pickup_at, 'confirmed_at', o.confirmed_at, 'preparing_at', o.preparing_at, 'ready_at', o.ready_at, 'completed_at', o.completed_at,
    'cancel_kind', o.cancel_kind, 'reschedule_count', o.reschedule_count,
    'prep', case when o.order_type = 'preorder' then jsonb_build_object('checked', (select count(*) from public.preorder_prep_checks c where c.order_id = o.id),
        'total', (select count(*) from public.shop_order_items i where i.order_id = o.id)) end,
    'change', public.preorder_change_rules(o.id),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'sku_code', i.sku_code, 'name', i.name, 'unit', i.unit, 'unit_price', i.unit_price,
        'qty', i.qty, 'line_total', i.line_total,
        'image_url', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = i.sku_code)) order by i.line_no), '[]'::jsonb)
      from public.shop_order_items i where i.order_id = o.id),
    'invoice', (select jsonb_build_object('id', v.id, 'invoice_no', v.invoice_no, 'issue_date', v.issue_date, 'due_date', v.due_date,
        'description', v.description, 'customer_name', c.name) || coalesce(st, '{}'::jsonb)
      from public.finance_invoices v join public.finance_customers c on c.id = v.customer_id where v.id = o.invoice_id));
end $$;
create or replace function public.shop_settings_public()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.shop_settings; p public.preorder_settings;
begin
  perform public.shop_require_user();
  select * into s from public.shop_settings where id;
  select * into p from public.preorder_settings where id;
  return jsonb_build_object('shop_open', s.shop_open and (exists (select 1 from public.finance_payment_accounts where is_default and active) or exists (select 1 from public.finance_bank_accounts where active)),
    'require_payment_slip', s.require_payment_slip, 'closed_message', s.closed_message, 'delivery_enabled', s.delivery_enabled, 'pickup_enabled', s.pickup_enabled, 'pickup_note', s.pickup_note,
    'shipping_fee', s.shipping_fee, 'free_shipping_min', s.free_shipping_min,
    'preorder_enabled', coalesce(p.enabled, false) and s.pickup_enabled and s.shop_open);
end $$;
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
    require_payment_slip = case when p_patch ? 'require_payment_slip' then (p_patch ->> 'require_payment_slip')::boolean else require_payment_slip end,
    shipping_fee = fee, free_shipping_min = fmin, updated_by = auth.uid(), updated_at = now()
  where id;
  perform public.shop_log('settings', 'shop', 'settings.save', p_patch);
  return public.shop_admin_settings();
end $function$;
do $$ declare f text; begin
  foreach f in array array['shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text, timestamptz)', 'shop_settings_public()', 'shop_admin_save_settings(jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

drop function if exists public.shop_address_list();
drop function if exists public.shop_address_save(uuid, jsonb, text, boolean);
drop function if exists public.shop_address_set_default(uuid);
drop function if exists public.shop_address_delete(uuid);
drop function if exists public.shop_address_json(public.shop_addresses);
drop table if exists public.shop_order_delivery;
drop table if exists public.shop_addresses;
drop function if exists public.shop_delivery_frozen();
drop function if exists public.shop_delivery_json(uuid);
drop function if exists public.shop_route_accept(integer, jsonb);
drop function if exists public.shop_delivery_text(jsonb);
drop function if exists public.shop_delivery_clean(jsonb, boolean);
drop function if exists public.shop_clean_text(text, integer, boolean);
drop function if exists public.shop_maps_dir_url(numeric, numeric, numeric, numeric);
drop function if exists public.shop_maps_url(numeric, numeric);
drop function if exists public.shop_pin_area_ok(numeric, numeric);
drop function if exists public.shop_haversine_m(double precision, double precision, double precision, double precision);
alter table public.shop_settings drop column if exists delivery_pin_required, drop column if exists store_maps_url, drop column if exists store_lng, drop column if exists store_lat, drop column if exists store_name;
