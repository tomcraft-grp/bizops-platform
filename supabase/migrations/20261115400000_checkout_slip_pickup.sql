-- Checkout: pay first, attach the transfer slip, delivery address optional (builds on 20261115100000..300000).
--
-- * Every online order that is paid by bank transfer (or QR) must come WITH its transfer slip. The database enforces it, not just the screen:
--   shop_place_order refuses with SLIP_REQUIRED when shop_settings.require_payment_slip is on (the default) and no slip is given. Only an order
--   paid from the customer's wallet needs none. The order, its invoice and the slip are created in ONE transaction: a bad slip (someone else's
--   folder, a slip already used, a wrong file) creates nothing. The slip makes the invoice "awaiting verification"; it never marks it paid.
-- * The delivery address is optional (staff ask by phone). Pick-up orders have no address, as before.
-- * shop_settings.require_payment_slip is a switch staff can change (Online shop -> Settings) and the app reads it to show the slip step.
-- shop_place_order keeps its first nine parameters and gains five OPTIONAL slip parameters.

alter table public.shop_settings add column if not exists require_payment_slip boolean not null default true;

-- the address is optional for delivery; if given it must be 1-400 characters
alter table public.shop_orders drop constraint if exists shop_orders_check1;
alter table public.shop_orders drop constraint if exists shop_orders_delivery_address_check;
alter table public.shop_orders drop constraint if exists shop_orders_address_only_delivery;
alter table public.shop_orders drop constraint if exists shop_orders_delivery_address_len;
alter table public.shop_orders add constraint shop_orders_address_only_delivery check (fulfilment = 'delivery' or delivery_address is null);
alter table public.shop_orders add constraint shop_orders_delivery_address_len check (delivery_address is null or length(delivery_address) between 1 and 400);

-- the app learns the switch from the public settings; staff change it through the existing settings functions
do $p$ declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.shop_settings_public()'::regprocedure);
  a := $a$'closed_message', s.closed_message,$a$; b := $b$'require_payment_slip', s.require_payment_slip, 'closed_message', s.closed_message,$b$;
  if position(a in d) = 0 then raise exception 'shop_settings_public changed: anchor not found'; end if;
  execute replace(d, a, b);
  d := pg_get_functiondef('public.shop_admin_save_settings(jsonb)'::regprocedure);
  a := $a$shipping_fee = fee, free_shipping_min = fmin, updated_by = auth.uid(), updated_at = now()$a$;
  b := $b$require_payment_slip = case when p_patch ? 'require_payment_slip' then (p_patch ->> 'require_payment_slip')::boolean else require_payment_slip end,
    shipping_fee = fee, free_shipping_min = fmin, updated_by = auth.uid(), updated_at = now()$b$;
  if position(a in d) = 0 then raise exception 'shop_admin_save_settings changed: anchor not found'; end if;
  execute replace(d, a, b);
end $p$;

drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text);
create or replace function public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text,
  p_note text, p_expected_total numeric default null, p_payment_method text default null,
  p_slip_path text default null, p_slip_sha256 text default null, p_slip_type text default null, p_slip_transfer_at timestamptz default null, p_slip_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;
revoke execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text) from public, anon;
grant execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text) to authenticated;
