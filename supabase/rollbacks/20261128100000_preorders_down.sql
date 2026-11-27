-- Rolls back 20261128100000_preorders.sql: the replaced functions return to their previous definitions (verbatim, as the live database printed them just before this migration), the preorder
-- functions, tables, columns, the cron job and the LINE switches go. REFUSES once any preorder exists (orders are financial records and are never deleted), or a preorder LINE message is queued.
-- Afterwards delete version 20261128100000 from supabase_migrations.schema_migrations.
do $$ begin
  if exists (select 1 from public.shop_orders where order_type = 'preorder') then raise exception 'REFUSING: preorders exist (orders are never deleted); switch the feature off instead'; end if;
  if exists (select 1 from public.line_outbox where event = 'preorder') then raise exception 'REFUSING: preorder LINE messages are in the queue'; end if;
end $$;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'preorder-sweep') then perform cron.unschedule('preorder-sweep'); end if;
end $$;

-- the order of the old world: first the functions that mention the new columns, then the columns
drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text, timestamptz);
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

  ono := public.next_doc_no('ORDER');
  perform set_config('finance.defer_gl', 'on', true);          -- the receivable is queued when staff confirm the order (or when a payment is verified)
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref, created_by)
    values (public.next_doc_no('INVOICE'),
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
revoke execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text) from public, anon;
grant execute on function public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text) to authenticated;

CREATE OR REPLACE FUNCTION public.shop_guard_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.order_no is distinct from old.order_no or new.profile_id is distinct from old.profile_id or new.customer_id is distinct from old.customer_id
     or new.invoice_id is distinct from old.invoice_id or new.subtotal is distinct from old.subtotal or new.discount is distinct from old.discount
     or new.shipping_fee is distinct from old.shipping_fee or new.total is distinct from old.total or new.fulfilment is distinct from old.fulfilment
     or new.idempotency_key is distinct from old.idempotency_key or new.request_hash is distinct from old.request_hash then
    raise exception 'An order''s number, customer and amounts cannot be changed (cancel it and place a new one)'; end if;
  return new;
end $function$;

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
    'subtotal', o.subtotal, 'discount', o.discount, 'shipping_fee', o.shipping_fee, 'total', o.total, 'payment_pref', o.payment_pref,
    'created_at', o.created_at, 'updated_at', o.updated_at, 'status_note', o.status_note, 'cancel_reason', o.cancel_reason, 'cancelled_at', o.cancelled_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'sku_code', i.sku_code, 'name', i.name, 'unit', i.unit, 'unit_price', i.unit_price,
        'qty', i.qty, 'line_total', i.line_total,
        'image_url', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = i.sku_code)) order by i.line_no), '[]'::jsonb)
      from public.shop_order_items i where i.order_id = o.id),
    'invoice', (select jsonb_build_object('id', v.id, 'invoice_no', v.invoice_no, 'issue_date', v.issue_date, 'due_date', v.due_date,
        'description', v.description, 'customer_name', c.name) || coalesce(st, '{}'::jsonb)
      from public.finance_invoices v join public.finance_customers c on c.id = v.customer_id where v.id = o.invoice_id));
end $function$;

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
  if exists (select 1 from public.finance_payment_evidence where invoice_id = o.invoice_id and status in ('submitted', 'confirmed', 'more_evidence')) then
    raise exception 'SLIP_PENDING'; end if;
  update public.finance_invoices set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = 'Order cancelled: ' || left(p_reason, 200)
    where id = o.invoice_id and status = 'open';
  update public.finance_payment_requests set status = 'cancelled' where invoice_id = o.invoice_id and status = 'awaiting';
  update public.shop_orders set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(p_reason, 200), updated_at = now() where id = o.id;
  perform public.finance_log('invoice', o.invoice_id, 'invoice.cancel', jsonb_build_object('reason', left(p_reason, 200), 'order', o.order_no, 'source', 'shop'));
  perform public.shop_log('order', o.id::text, 'order.cancel', jsonb_build_object('by', case when p_by_customer then 'customer' else 'staff' end, 'reason', left(p_reason, 200)));
end $function$;

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
  perform public.finance_gl_ensure_invoice_issue(o.invoice_id);        -- a confirmed sale: the receivable goes to the accountant's queue (once)
  perform public.shop_log('order', o.id::text, 'order.status', jsonb_build_object('from', o.status, 'to', p_status, 'note', v_note,
    'payment_override', overridden, 'override_reason', case when overridden then v_why end));
  return public.shop_order_json(o.id);
end $function$;

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
      when 'unpaid' then m.status <> 'cancelled' and m.pay in (0, 1, 3, 4, 7, 9, 10)
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

CREATE OR REPLACE FUNCTION public.shop_my_order(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid; o public.shop_orders;
begin
  uid := public.shop_require_user();
  select * into o from public.shop_orders where id = p_id and profile_id = uid;
  if not found then raise exception 'Order not found' using errcode = '42501'; end if;
  -- only the milestones: staff notes and override reasons in the audit detail are internal
  return public.shop_order_json(o.id) || jsonb_build_object('events', (
    select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'action', e.action, 'to', e.detail ->> 'to') order by e.at), '[]'::jsonb)
    from public.shop_events e where e.entity = 'order' and e.entity_id = o.id::text and e.action in ('order.place', 'order.status', 'order.cancel')));
end $function$;

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
    'require_payment_slip', s.require_payment_slip, 'closed_message', s.closed_message, 'delivery_enabled', s.delivery_enabled, 'pickup_enabled', s.pickup_enabled, 'pickup_note', s.pickup_note,
    'shipping_fee', s.shipping_fee, 'free_shipping_min', s.free_shipping_min);
end $function$;

CREATE OR REPLACE FUNCTION public.shop_admin_order(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.shop_orders;
begin
  perform public.shop_require_staff('see online orders');
  select * into o from public.shop_orders where id = p_id;
  if not found then raise exception 'Order not found'; end if;
  return public.shop_order_json(o.id) || jsonb_build_object(
    'customer', (select jsonb_build_object('code', c.code, 'name', c.name, 'phone', p.phone, 'line_user_id', p.line_user_id)
      from public.finance_customers c left join public.profiles p on p.id = o.profile_id where c.id = o.customer_id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor_email', e.actor_email, 'action', e.action, 'detail', e.detail) order by e.at), '[]'::jsonb)
      from public.shop_events e where e.entity = 'order' and e.entity_id = o.id::text));
end $function$;

CREATE OR REPLACE FUNCTION public.line_admin_save_settings(p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare k text; s public.line_settings; v_amount numeric; v_reasons text[]; ev text;
begin
  perform public.line_require_super('change the LINE settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_SETTING: send an object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('enabled', 'events', 'quick_approve_enabled', 'quick_approve_max_amount', 'reject_reasons') then raise exception 'INVALID_SETTING: unknown setting %', k; end if;
  end loop;
  select * into s from public.line_settings where id for update;
  if p_patch ? 'events' then
    if jsonb_typeof(p_patch -> 'events') <> 'object' then raise exception 'INVALID_SETTING: events must be an object'; end if;
    for ev in select jsonb_object_keys(p_patch -> 'events') loop
      if ev not in ('order_new', 'slip_new', 'order_status', 'payment_issue', 'customer_notify') or jsonb_typeof(p_patch -> 'events' -> ev) <> 'boolean' then
        raise exception 'INVALID_SETTING: unknown event %', ev; end if;
    end loop;
    s.events := s.events || (p_patch -> 'events');
  end if;
  if p_patch ? 'quick_approve_max_amount' then
    v_amount := (p_patch ->> 'quick_approve_max_amount')::numeric;
    if v_amount is null or v_amount <= 0 or v_amount > 1000000 or v_amount <> round(v_amount, 2) then raise exception 'INVALID_SETTING: the maximum amount must be between 0.01 and 1,000,000'; end if;
    s.quick_approve_max_amount := v_amount;
  end if;
  if p_patch ? 'reject_reasons' then
    if jsonb_typeof(p_patch -> 'reject_reasons') <> 'array' then raise exception 'INVALID_SETTING: reject_reasons must be a list'; end if;
    select array_agg(btrim(x) order by o) into v_reasons from jsonb_array_elements_text(p_patch -> 'reject_reasons') with ordinality r(x, o);
    if coalesce(array_length(v_reasons, 1), 0) not between 1 and 10 or exists (select 1 from unnest(v_reasons) x where x = '' or length(x) > 80) then
      raise exception 'INVALID_SETTING: give 1 to 10 reasons of at most 80 characters'; end if;
    s.reject_reasons := v_reasons;
  end if;
  if p_patch ? 'quick_approve_enabled' then s.quick_approve_enabled := (p_patch ->> 'quick_approve_enabled')::boolean; end if;
  if p_patch ? 'enabled' then
    s.enabled := (p_patch ->> 'enabled')::boolean;
    if s.enabled and (s.secret_set_at is null or s.token_set_at is null or s.group_id is null) then
      raise exception 'LINE_NOT_READY: enter the channel secret and access token and bind the admin group first'; end if;
  end if;
  update public.line_settings set enabled = s.enabled, events = s.events, quick_approve_enabled = s.quick_approve_enabled,
    quick_approve_max_amount = s.quick_approve_max_amount, reject_reasons = s.reject_reasons, updated_at = now(), updated_by = auth.uid() where id;
  perform public.shop_log('line', 'settings', 'line.settings', p_patch);
  return public.line_admin_settings();
end $function$;

CREATE OR REPLACE FUNCTION public.line_card_data(p_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.shop_orders; e public.finance_payment_evidence; s public.line_settings; n int; q jsonb; v_bank text; v_method text;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  select * into s from public.line_settings where id;
  select * into e from public.finance_payment_evidence where invoice_id = o.invoice_id and source = 'customer_slip' and status <> 'rejected'
    order by created_at desc, id desc limit 1;
  select count(*) into n from public.shop_order_items where order_id = o.id;
  v_method := case when o.payment_pref = 'wallet' then 'wallet' when o.payment_pref = 'qr' then 'qr' when o.payment_pref like 'bank:%' or e.id is not null then 'transfer' else 'unpaid' end;
  v_bank := coalesce((select b.code from public.finance_bank_accounts b where b.id = e.bank_account_id), case when o.payment_pref like 'bank:%' then substr(o.payment_pref, 6) end);
  q := public.line_quick_check(o.id);
  return jsonb_build_object(
    'order_id', o.id, 'order_no', o.order_no, 'customer_name', o.contact_name, 'phone', o.contact_phone, 'created_at', o.created_at,
    'item_count', (select coalesce(sum(qty), 0) from public.shop_order_items where order_id = o.id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', it.name, 'qty', it.qty, 'price', it.unit_price,
               'image', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = it.sku_code)) order by it.line_no)
             from (select * from public.shop_order_items where order_id = o.id order by line_no limit 3) it), '[]'::jsonb),
    'more_count', greatest(n - 3, 0),
    'total', o.total, 'fulfilment', o.fulfilment,
    'payment', jsonb_build_object('method', v_method, 'bank', v_bank, 'has_slip', e.id is not null, 'transfer_at', e.claimed_transfer_at, 'evidence_id', e.id),
    'status', o.status, 'quick', jsonb_build_object('ok', (q ->> 'ok')::boolean, 'why', q ->> 'why'), 'app_url', s.app_url);
end $function$;

drop function if exists public.preorder_options(), public.preorder_slots(date, integer), public.preorder_change_my_order(uuid, jsonb), public.preorder_request_change(uuid, text),
  public.preorder_admin_staff(), public.preorder_admin_dashboard(date), public.preorder_admin_list(text, text, text, date, date, text, text, text, text, integer, integer),
  public.preorder_admin_schedule(date), public.preorder_prep_board(boolean, integer), public.preorder_admin_assign(uuid, uuid), public.preorder_admin_reschedule(uuid, timestamptz, text, boolean),
  public.preorder_prep_set(uuid, integer, boolean), public.preorder_admin_notices(integer), public.preorder_admin_settings(), public.preorder_admin_save_settings(jsonb),
  public.preorder_admin_save_day(date, text, text, text, text, boolean), public.preorder_admin_remove_day(date), public.preorder_sweep(), public.preorder_after_place(uuid),
  public.preorder_change_rules(uuid), public.preorder_row(uuid, boolean), public.preorder_flags(shop_orders, preorder_settings, integer, integer),
  public.preorder_notify_staff(text, uuid, text, jsonb, boolean, text), public.preorder_assignee(uuid), public.preorder_notify(text, uuid, text, text, jsonb, uuid, boolean),
  public.preorder_msg(text, uuid, jsonb), public.preorder_check_slot(timestamptz, integer, uuid, boolean, boolean), public.preorder_day_units(date, uuid), public.preorder_load(timestamptz, uuid),
  public.preorder_grid(date), public.preorder_hours(date), public.preorder_local_day(timestamptz);

alter table public.line_outbox drop constraint if exists line_outbox_event_check;
alter table public.line_outbox add constraint line_outbox_event_check check (event in ('order_new', 'slip_new', 'order_status', 'payment_issue', 'customer_notify'));
update public.line_settings set events = events - 'preorder' - 'preorder_staff' - 'preorder_customer';

drop table if exists public.preorder_notices, public.preorder_prep_checks, public.preorder_assignments, public.preorder_days, public.preorder_settings;
drop index if exists public.shop_orders_pickup_idx;
alter table public.shop_orders drop constraint if exists shop_orders_preorder_chk, drop constraint if exists shop_orders_order_type_chk, drop constraint if exists shop_orders_cancel_kind_chk;
alter table public.shop_orders drop column if exists order_type, drop column if exists pickup_at, drop column if exists confirmed_at, drop column if exists preparing_at, drop column if exists ready_at,
  drop column if exists completed_at, drop column if exists cancel_kind, drop column if exists reschedule_count;
