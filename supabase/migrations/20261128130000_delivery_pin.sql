-- Delivery location pin: the customer pins the delivery destination on a map, the order keeps it, the shop opens it in Google Maps.
-- What it adds (nothing that exists is removed; a pick-up order and an order placed without a pin behave exactly as before):
--   A. shop_settings: the store's location (store_name / store_lat / store_lng / store_maps_url, default = หมู่บ้านสิวารัตน์ 2 as resolved from the shop's own Google Maps link
--      https://maps.app.goo.gl/tT5NXeciaU2tuFyc9, which redirects to 13.745952,100.292734) and the switch delivery_pin_required (default on: a delivery order needs a confirmed pin).
--   B. shop_order_delivery: ONE frozen row per delivery order that has a pin: recipient, address parts, instructions, latitude / longitude, the two Google Maps links (built here, never taken from
--      the client), the store the route started from (a copy, so a later change of the store location does not rewrite old orders), the straight-line distance (computed here) and the driving
--      distance / time when the client brought them from a routing service AND they are plausible. Nothing can update or delete such a row.
--   C. shop_addresses: the customer's saved delivery addresses (up to 10, one default). Saving, editing or deleting one never touches an order: an order holds its own copy (B).
--   D. shop_place_order gets ONE optional last parameter, p_delivery (jsonb). Without it the function behaves as before, except that a delivery order without a pin is refused while
--      shop_settings.delivery_pin_required is on (DELIVERY_PIN_REQUIRED). shop_order_json gains the key "delivery" (null when the order has no pin).
-- Maps and routing providers are called by the browser only (OpenStreetMap / Nominatim / OSRM, no key). The database never calls them and never trusts a distance it cannot check.
-- Rollback: supabase/rollbacks/20261128130000_delivery_pin_down.sql (refuses while delivery pins or saved addresses exist: they would be lost).

-- ================================================================================================ A. the store location and the switch
alter table public.shop_settings add column if not exists store_name text not null default 'หมู่บ้านสิวารัตน์ 2' check (length(btrim(store_name)) between 1 and 100);
alter table public.shop_settings add column if not exists store_lat numeric(9, 6) not null default 13.745952 check (store_lat between 5.5 and 20.6);
alter table public.shop_settings add column if not exists store_lng numeric(9, 6) not null default 100.292734 check (store_lng between 97.3 and 105.7);
alter table public.shop_settings add column if not exists store_maps_url text default 'https://maps.app.goo.gl/tT5NXeciaU2tuFyc9' check (store_maps_url is null or (length(store_maps_url) <= 300 and store_maps_url ~ '^https://'));
alter table public.shop_settings add column if not exists delivery_pin_required boolean not null default true;

-- ================================================================================================ B. the frozen delivery snapshot of an order, C. the customer's saved addresses
create table if not exists public.shop_addresses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  label text check (label is null or length(label) between 1 and 40),
  recipient_name text not null check (length(recipient_name) between 1 and 100),
  recipient_phone text not null check (recipient_phone ~ '^0[0-9]{8,9}$'),
  address_line text not null check (length(address_line) between 5 and 300),
  unit_no text check (unit_no is null or length(unit_no) between 1 and 60),
  village text check (village is null or length(village) between 1 and 100),
  floor_no text check (floor_no is null or length(floor_no) between 1 and 20),
  landmark text check (landmark is null or length(landmark) between 1 and 120),
  directions text check (directions is null or length(directions) between 1 and 300),
  driver_note text check (driver_note is null or length(driver_note) between 1 and 300),
  place_label text check (place_label is null or length(place_label) between 1 and 200),
  lat numeric(9, 6) not null check (lat between 5.5 and 20.6),
  lng numeric(9, 6) not null check (lng between 97.3 and 105.7),
  pin_source text not null check (pin_source in ('search', 'tap', 'drag', 'gps', 'link', 'saved')),
  confirmed_at timestamptz not null default now(),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shop_addresses_one_default on public.shop_addresses (profile_id) where is_default;
create index if not exists shop_addresses_profile_idx on public.shop_addresses (profile_id, updated_at desc);

create table if not exists public.shop_order_delivery (
  order_id uuid primary key references public.shop_orders (id) on delete restrict,
  recipient_name text not null check (length(recipient_name) between 1 and 100),
  recipient_phone text not null check (recipient_phone ~ '^0[0-9]{8,9}$'),
  address_line text not null check (length(address_line) between 5 and 300),
  unit_no text check (unit_no is null or length(unit_no) between 1 and 60),
  village text check (village is null or length(village) between 1 and 100),
  floor_no text check (floor_no is null or length(floor_no) between 1 and 20),
  landmark text check (landmark is null or length(landmark) between 1 and 120),
  directions text check (directions is null or length(directions) between 1 and 300),
  driver_note text check (driver_note is null or length(driver_note) between 1 and 300),
  place_label text check (place_label is null or length(place_label) between 1 and 200),
  lat numeric(9, 6) not null check (lat between 5.5 and 20.6),
  lng numeric(9, 6) not null check (lng between 97.3 and 105.7),
  pin_source text not null check (pin_source in ('search', 'tap', 'drag', 'gps', 'link', 'saved')),
  confirmed_at timestamptz not null default now(),
  address_id uuid,                                           -- the saved address it was copied from (it may be gone or changed since: this row is the truth)
  origin_name text not null, origin_lat numeric(9, 6) not null, origin_lng numeric(9, 6) not null,
  maps_url text not null, directions_url text not null,
  straight_m integer not null check (straight_m >= 0),
  route_m integer check (route_m is null or route_m > 0), route_s integer check (route_s is null or route_s > 0),
  route_source text check (route_source is null or route_source = 'osrm'), route_at timestamptz,
  created_at timestamptz not null default now(),
  check ((route_m is null) = (route_s is null) and (route_m is null) = (route_source is null))
);

-- a delivery destination is a record of what was agreed when the order was placed: nothing changes or removes it
create or replace function public.shop_delivery_frozen() returns trigger language plpgsql set search_path = public as $$
begin raise exception 'DELIVERY_FROZEN' using errcode = '22023'; end $$;
drop trigger if exists shop_order_delivery_frozen on public.shop_order_delivery;
create trigger shop_order_delivery_frozen before update or delete on public.shop_order_delivery for each row execute function public.shop_delivery_frozen();

alter table public.shop_addresses enable row level security;
alter table public.shop_order_delivery enable row level security;
drop policy if exists "shop addresses: own" on public.shop_addresses;
create policy "shop addresses: own" on public.shop_addresses for select to authenticated using (profile_id = auth.uid());
drop policy if exists "shop delivery: own or staff" on public.shop_order_delivery;
create policy "shop delivery: own or staff" on public.shop_order_delivery for select to authenticated
  using (exists (select 1 from public.shop_orders o where o.id = order_id and (o.profile_id = auth.uid() or public.shop_is_staff())));
revoke all on public.shop_addresses, public.shop_order_delivery from anon;
revoke insert, update, delete, truncate on public.shop_addresses, public.shop_order_delivery from authenticated;

-- ================================================================================================ helpers (internal: no client can call them)
-- great-circle distance in metres (the "straight line", never presented as a driving distance)
create or replace function public.shop_haversine_m(p_lat1 double precision, p_lng1 double precision, p_lat2 double precision, p_lng2 double precision) returns integer
language sql immutable set search_path = public as $$
  select round(2 * 6371008.8 * asin(least(1.0, sqrt(power(sin(radians(p_lat2 - p_lat1) / 2), 2)
    + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2)))))::integer
$$;

-- the delivery area is Thailand: a pin outside it is a slip of the finger (or a map that never loaded), not a destination
create or replace function public.shop_pin_area_ok(p_lat numeric, p_lng numeric) returns boolean language sql immutable set search_path = public as $$
  select p_lat between 5.5 and 20.6 and p_lng between 97.3 and 105.7
$$;

-- the two Google Maps links, built from the coordinates only (the client never supplies a link)
create or replace function public.shop_maps_url(p_lat numeric, p_lng numeric) returns text language sql immutable set search_path = public as $$
  select 'https://www.google.com/maps/search/?api=1&query=' || trim_scale(p_lat)::text || ',' || trim_scale(p_lng)::text
$$;
create or replace function public.shop_maps_dir_url(p_olat numeric, p_olng numeric, p_lat numeric, p_lng numeric) returns text language sql immutable set search_path = public as $$
  select 'https://www.google.com/maps/dir/?api=1&origin=' || trim_scale(p_olat)::text || ',' || trim_scale(p_olng)::text
    || '&destination=' || trim_scale(p_lat)::text || ',' || trim_scale(p_lng)::text || '&travelmode=driving'
$$;

-- one text field: control characters removed, trimmed, empty -> null, longer than p_max -> INVALID_DETAILS (never silently cut)
create or replace function public.shop_clean_text(p text, p_max integer, p_multiline boolean default false) returns text
language plpgsql stable set search_path = public as $$
declare v text := coalesce(p, '');
begin
  v := replace(replace(v, E'\r\n', E'\n'), E'\r', E'\n');
  v := case when p_multiline then regexp_replace(v, '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g') else regexp_replace(v, '[\x01-\x1f\x7f]+', ' ', 'g') end;
  if not p_multiline then v := regexp_replace(v, ' {2,}', ' ', 'g'); end if;
  v := nullif(btrim(v), '');
  if v is not null and length(v) > p_max then raise exception 'INVALID_DETAILS' using errcode = '22023'; end if;
  return v;
end $$;

-- the delivery details the client sent, checked and normalised. Every refusal is a code the apps explain.
create or replace function public.shop_delivery_clean(p jsonb, p_need_confirm boolean default true) returns jsonb
language plpgsql stable set search_path = public as $$
declare v_lat numeric; v_lng numeric; v_name text; v_phone text; v_addr text; v_src text; v_route jsonb := null; v_aid text; v_rd text; v_rs text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'PIN_INVALID' using errcode = '22023'; end if;
  if coalesce(p ->> 'lat', '') !~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$' or coalesce(p ->> 'lng', '') !~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$' then raise exception 'PIN_INVALID' using errcode = '22023'; end if;
  v_lat := round((p ->> 'lat')::numeric, 6); v_lng := round((p ->> 'lng')::numeric, 6);
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 then raise exception 'PIN_INVALID' using errcode = '22023'; end if;
  if not public.shop_pin_area_ok(v_lat, v_lng) then raise exception 'PIN_OUTSIDE_AREA' using errcode = '22023'; end if;
  -- the customer must have said "this is the place" (a typed address is not a pin)
  if p_need_confirm and (p ->> 'confirmed') is distinct from 'true' then raise exception 'PIN_NOT_CONFIRMED' using errcode = '22023'; end if;
  v_src := coalesce(p ->> 'pin_source', '');
  if v_src not in ('search', 'tap', 'drag', 'gps', 'link', 'saved') then raise exception 'PIN_INVALID' using errcode = '22023'; end if;
  v_name := public.shop_clean_text(p ->> 'recipient_name', 100);
  v_phone := regexp_replace(coalesce(p ->> 'recipient_phone', ''), '[^0-9]', '', 'g');
  if v_name is null or v_phone !~ '^0[0-9]{8,9}$' then raise exception 'INVALID_RECIPIENT' using errcode = '22023'; end if;
  v_addr := public.shop_clean_text(p ->> 'address_line', 300);
  if v_addr is null or length(v_addr) < 5 then raise exception 'INVALID_ADDRESS' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'route') = 'object' then
    v_rd := p -> 'route' ->> 'distance_m'; v_rs := p -> 'route' ->> 'duration_s';
    if v_rd ~ '^[0-9]{1,7}(\.[0-9]+)?$' and v_rs ~ '^[0-9]{1,6}(\.[0-9]+)?$' then
      v_route := jsonb_build_object('distance_m', round(v_rd::numeric)::integer, 'duration_s', round(v_rs::numeric)::integer, 'source', p -> 'route' ->> 'source');
    end if;
  end if;
  v_aid := case when lower(coalesce(p ->> 'address_id', '')) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then lower(p ->> 'address_id') end;
  return jsonb_build_object('recipient_name', v_name, 'recipient_phone', v_phone, 'address_line', v_addr,
    'unit_no', public.shop_clean_text(p ->> 'unit_no', 60), 'village', public.shop_clean_text(p ->> 'village', 100), 'floor_no', public.shop_clean_text(p ->> 'floor_no', 20),
    'landmark', public.shop_clean_text(p ->> 'landmark', 120), 'directions', public.shop_clean_text(p ->> 'directions', 300, true), 'driver_note', public.shop_clean_text(p ->> 'driver_note', 300, true),
    'place_label', public.shop_clean_text(p ->> 'place_label', 200), 'lat', v_lat, 'lng', v_lng, 'pin_source', v_src, 'address_id', v_aid, 'route', v_route);
end $$;

-- the address text kept on the order itself (what every older screen, card and invoice already shows)
create or replace function public.shop_delivery_text(d jsonb) returns text language sql immutable set search_path = public as $$
  select left(concat_ws(E'\n', d ->> 'address_line',
    nullif(concat_ws(' · ', case when d ->> 'unit_no' is not null then 'เลขที่/ห้อง ' || (d ->> 'unit_no') end, d ->> 'village', case when d ->> 'floor_no' is not null then 'ชั้น ' || (d ->> 'floor_no') end), ''),
    case when d ->> 'landmark' is not null then 'จุดสังเกต: ' || (d ->> 'landmark') end), 400)
$$;

-- a driving route is kept only when it could be real: never shorter than the straight line, not absurdly longer, at a speed a vehicle can drive. Otherwise null (the order is never refused for it).
create or replace function public.shop_route_accept(p_straight integer, p_route jsonb) returns jsonb language plpgsql immutable set search_path = public as $$
declare d integer; s integer;
begin
  if p_route is null or jsonb_typeof(p_route) <> 'object' or p_route ->> 'source' is distinct from 'osrm' then return null; end if;
  d := (p_route ->> 'distance_m')::integer; s := (p_route ->> 'duration_s')::integer;
  if d is null or s is null or d < 1 or s < 1 then return null; end if;
  if d < floor(p_straight * 0.9) or d > p_straight * 8 + 3000 then return null; end if;
  if d::numeric / s < 0.8 or d::numeric / s > 38 then return null; end if;
  return jsonb_build_object('distance_m', d, 'duration_s', s, 'source', 'osrm');
end $$;

-- the delivery of an order as the apps read it (null when the order has no pin: every order placed before this migration, and every pick-up)
create or replace function public.shop_delivery_json(p_order uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('recipient_name', d.recipient_name, 'recipient_phone', d.recipient_phone, 'address_line', d.address_line, 'unit_no', d.unit_no, 'village', d.village,
    'floor_no', d.floor_no, 'landmark', d.landmark, 'directions', d.directions, 'driver_note', d.driver_note, 'place_label', d.place_label,
    'lat', d.lat, 'lng', d.lng, 'pin_source', d.pin_source, 'confirmed_at', d.confirmed_at,
    'origin', jsonb_build_object('name', d.origin_name, 'lat', d.origin_lat, 'lng', d.origin_lng), 'maps_url', d.maps_url, 'directions_url', d.directions_url, 'straight_m', d.straight_m,
    'route', case when d.route_m is null then null else jsonb_build_object('distance_m', d.route_m, 'duration_s', d.route_s, 'source', d.route_source, 'at', d.route_at) end)
  from public.shop_order_delivery d where d.order_id = p_order
$$;

create or replace function public.shop_address_json(a public.shop_addresses) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', a.id, 'label', a.label, 'recipient_name', a.recipient_name, 'recipient_phone', a.recipient_phone, 'address_line', a.address_line, 'unit_no', a.unit_no,
    'village', a.village, 'floor_no', a.floor_no, 'landmark', a.landmark, 'directions', a.directions, 'driver_note', a.driver_note, 'place_label', a.place_label,
    'lat', a.lat, 'lng', a.lng, 'pin_source', a.pin_source, 'confirmed_at', a.confirmed_at, 'is_default', a.is_default, 'updated_at', a.updated_at)
$$;

-- ================================================================================================ C. saved addresses (a customer's own; the function checks the owner every time)
create or replace function public.shop_address_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid;
begin
  uid := public.shop_require_user();
  return coalesce((select jsonb_agg(public.shop_address_json(a) order by a.is_default desc, a.updated_at desc) from public.shop_addresses a where a.profile_id = uid), '[]'::jsonb);
end $$;

-- p_id null = a new address. The pin must be confirmed. p_default true makes it the default (the first address is the default anyway).
create or replace function public.shop_address_save(p_id uuid, p_data jsonb, p_label text default null, p_default boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; d jsonb; lbl text; a public.shop_addresses; n integer; mk boolean;
begin
  uid := public.shop_require_user();
  perform pg_advisory_xact_lock(hashtextextended('shop_addr:' || uid::text, 0));       -- one default per customer, also for two taps at once
  d := public.shop_delivery_clean(p_data, true);
  lbl := public.shop_clean_text(p_label, 40);
  if p_id is null then
    select count(*) into n from public.shop_addresses where profile_id = uid;
    if n >= 10 then raise exception 'ADDRESS_LIMIT' using errcode = '22023'; end if;
    mk := coalesce(p_default, false) or n = 0;
    if mk then update public.shop_addresses set is_default = false, updated_at = now() where profile_id = uid and is_default; end if;
    insert into public.shop_addresses (profile_id, label, recipient_name, recipient_phone, address_line, unit_no, village, floor_no, landmark, directions, driver_note, place_label, lat, lng, pin_source, is_default)
      values (uid, lbl, d ->> 'recipient_name', d ->> 'recipient_phone', d ->> 'address_line', d ->> 'unit_no', d ->> 'village', d ->> 'floor_no', d ->> 'landmark', d ->> 'directions', d ->> 'driver_note',
              d ->> 'place_label', (d ->> 'lat')::numeric, (d ->> 'lng')::numeric, d ->> 'pin_source', mk)
      returning * into a;
  else
    select * into a from public.shop_addresses where id = p_id and profile_id = uid for update;
    if not found then raise exception 'ADDRESS_NOT_FOUND' using errcode = '22023'; end if;
    mk := coalesce(p_default, false);
    if mk then update public.shop_addresses set is_default = false, updated_at = now() where profile_id = uid and is_default and id <> p_id; end if;
    update public.shop_addresses set label = lbl, recipient_name = d ->> 'recipient_name', recipient_phone = d ->> 'recipient_phone', address_line = d ->> 'address_line', unit_no = d ->> 'unit_no',
      village = d ->> 'village', floor_no = d ->> 'floor_no', landmark = d ->> 'landmark', directions = d ->> 'directions', driver_note = d ->> 'driver_note', place_label = d ->> 'place_label',
      lat = (d ->> 'lat')::numeric, lng = (d ->> 'lng')::numeric, pin_source = d ->> 'pin_source', confirmed_at = now(), is_default = a.is_default or mk, updated_at = now()
      where id = p_id returning * into a;
  end if;
  return public.shop_address_json(a);
end $$;

create or replace function public.shop_address_set_default(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; a public.shop_addresses;
begin
  uid := public.shop_require_user();
  perform pg_advisory_xact_lock(hashtextextended('shop_addr:' || uid::text, 0));
  select * into a from public.shop_addresses where id = p_id and profile_id = uid for update;
  if not found then raise exception 'ADDRESS_NOT_FOUND' using errcode = '22023'; end if;
  update public.shop_addresses set is_default = false, updated_at = now() where profile_id = uid and is_default and id <> p_id;
  update public.shop_addresses set is_default = true, updated_at = now() where id = p_id returning * into a;
  return public.shop_address_json(a);
end $$;

-- deleting a saved address never touches an order (an order keeps its own copy); when the default goes, the most recently used one becomes the default
create or replace function public.shop_address_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid; was boolean;
begin
  uid := public.shop_require_user();
  perform pg_advisory_xact_lock(hashtextextended('shop_addr:' || uid::text, 0));
  delete from public.shop_addresses where id = p_id and profile_id = uid returning is_default into was;
  if not found then raise exception 'ADDRESS_NOT_FOUND' using errcode = '22023'; end if;
  if was then update public.shop_addresses set is_default = true where id = (select id from public.shop_addresses where profile_id = uid order by updated_at desc limit 1); end if;
end $$;

-- ================================================================================================ D. the order
-- every existing key is unchanged; "delivery" is new
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
    'cancel_kind', o.cancel_kind, 'reschedule_count', o.reschedule_count, 'delivery', public.shop_delivery_json(o.id),
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


-- shop_place_order gains the last optional parameter p_delivery. Without it the function behaves as before (a delivery order then needs delivery_pin_required to be off).
drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text, timestamptz);
create or replace function public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric default null,
  p_payment_method text default null, p_slip_path text default null, p_slip_sha256 text default null, p_slip_type text default null, p_slip_transfer_at timestamptz default null, p_slip_ref text default null,
  p_pickup_at timestamptz default null, p_delivery jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; prof public.profiles; s public.shop_settings; q jsonb; norm jsonb; hash text; existing public.shop_orders; pm text;
        fin uuid; ono text; oid uuid := gen_random_uuid(); inv public.finance_invoices; phone text; nm text; addr text; nt text; n integer; ln integer := 0; l jsonb;
        v_bank_id uuid; v_bank_code text; v_units integer; dl jsonb; v_straight integer; v_route jsonb; v_aid uuid;
begin
  uid := public.shop_require_user();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_key, 0));    -- serialises retries of the same checkout

  select * into s from public.shop_settings where id;
  nm := btrim(coalesce(p_name, '')); phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  addr := nullif(btrim(coalesce(p_address, '')), ''); nt := nullif(btrim(coalesce(p_note, '')), ''); pm := nullif(btrim(coalesce(p_payment_method, '')), '');
  if p_pickup_at is not null and p_fulfilment is distinct from 'pickup' then raise exception 'PREORDER_PICKUP_ONLY' using errcode = '22023'; end if;
  -- the delivery pin: checked and normalised before anything else (a refusal is a code the app explains)
  if p_delivery is not null and jsonb_typeof(p_delivery) <> 'null' then
    if p_fulfilment is distinct from 'delivery' then raise exception 'DELIVERY_PICKUP_CONFLICT' using errcode = '22023'; end if;
    dl := public.shop_delivery_clean(p_delivery, true);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('sku', k, 'qty', t) order by k), '[]'::jsonb) into norm from (
    select e ->> 'sku_code' k, sum(case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::int else 0 end) t
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e group by 1) z;
  -- (the payment choice, the slip and the pickup time join the hash only when given, so a checkout without them hashes exactly as before)
  hash := md5((jsonb_build_object('items', norm, 'f', p_fulfilment, 'n', nm, 'p', phone, 'a', addr, 'note', nt)
               || case when pm is null then '{}'::jsonb else jsonb_build_object('pm', pm) end
               || case when p_slip_sha256 is null then '{}'::jsonb else jsonb_build_object('slip', lower(p_slip_sha256)) end
               || case when p_pickup_at is null then '{}'::jsonb else jsonb_build_object('pu', extract(epoch from p_pickup_at)::bigint) end
               || case when dl is null then '{}'::jsonb else jsonb_build_object('dl', md5((dl - 'route')::text)) end)::text);          -- (the route is only information: a retry that measured it again is still the same order)

  -- a retry of the same checkout returns the order it already created (never a second one)
  select * into existing from public.shop_orders where profile_id = uid and idempotency_key = p_key;
  if found then
    if existing.request_hash <> hash then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return jsonb_build_object('replay', true, 'order', public.shop_order_json(existing.id));
  end if;

  if not s.shop_open then raise exception 'SHOP_CLOSED'; end if;
  if p_fulfilment = 'delivery' and dl is null and s.delivery_pin_required then raise exception 'DELIVERY_PIN_REQUIRED' using errcode = '22023'; end if;
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
  if dl is not null then addr := public.shop_delivery_text(dl); end if;                        -- the order's own address text is made from the structured address
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
  -- the delivery snapshot: frozen with the order. The links and the straight-line distance are made here; a driving route is kept only when it is plausible.
  if dl is not null then
    v_straight := public.shop_haversine_m(s.store_lat::double precision, s.store_lng::double precision, (dl ->> 'lat')::double precision, (dl ->> 'lng')::double precision);
    v_route := public.shop_route_accept(v_straight, dl -> 'route');
    v_aid := (select a.id from public.shop_addresses a where a.id = nullif(dl ->> 'address_id', '')::uuid and a.profile_id = uid);
    insert into public.shop_order_delivery (order_id, recipient_name, recipient_phone, address_line, unit_no, village, floor_no, landmark, directions, driver_note, place_label, lat, lng, pin_source,
        address_id, origin_name, origin_lat, origin_lng, maps_url, directions_url, straight_m, route_m, route_s, route_source, route_at)
      values (oid, dl ->> 'recipient_name', dl ->> 'recipient_phone', dl ->> 'address_line', dl ->> 'unit_no', dl ->> 'village', dl ->> 'floor_no', dl ->> 'landmark', dl ->> 'directions', dl ->> 'driver_note',
        dl ->> 'place_label', (dl ->> 'lat')::numeric, (dl ->> 'lng')::numeric, dl ->> 'pin_source', v_aid, s.store_name, s.store_lat, s.store_lng,
        public.shop_maps_url((dl ->> 'lat')::numeric, (dl ->> 'lng')::numeric), public.shop_maps_dir_url(s.store_lat, s.store_lng, (dl ->> 'lat')::numeric, (dl ->> 'lng')::numeric), v_straight,
        (v_route ->> 'distance_m')::integer, (v_route ->> 'duration_s')::integer, v_route ->> 'source', case when v_route is null then null else now() end);
  end if;
  -- the slip: checked by the same function a customer uses on the payment screen (own folder, no path tricks, one use per file), with the
  -- amount the SERVER priced. Any refusal rolls back the whole order. The invoice becomes "awaiting verification", never "paid".
  if p_slip_path is not null then
    if pm like 'bank:%' then select id, code into v_bank_id, v_bank_code from public.finance_bank_accounts where active and code = substr(pm, 6); end if;
    perform public.finance_submit_evidence(inv.id, p_slip_path, p_slip_sha256, coalesce(p_slip_type, 'image/jpeg'), (q ->> 'total')::numeric, p_slip_transfer_at,
      coalesce(v_bank_code, case when pm = 'qr' then 'PromptPay' end), p_slip_ref, v_bank_id);
  end if;
  perform public.shop_log('order', oid::text, 'order.place', jsonb_build_object('no', ono, 'total', q -> 'total', 'lines', ln, 'invoice', inv.invoice_no, 'fulfilment', p_fulfilment,
    'payment_pref', pm, 'slip', p_slip_path is not null) || case when p_pickup_at is null then '{}'::jsonb else jsonb_build_object('pickup_at', p_pickup_at, 'order_type', 'preorder') end);
  if dl is not null then perform public.shop_log('order', oid::text, 'order.delivery_pin', jsonb_build_object('pin_source', dl ->> 'pin_source', 'straight_m', v_straight, 'route', v_route is not null)); end if;
  if p_pickup_at is not null then perform public.preorder_after_place(oid); end if;
  return jsonb_build_object('replay', false, 'order', public.shop_order_json(oid));
end $$;


-- what the customer app may know about the shop: + the store location (the map starts there) and whether a pin is required
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
    'preorder_enabled', coalesce(p.enabled, false) and s.pickup_enabled and s.shop_open,
    'delivery_pin_required', s.delivery_pin_required, 'store', jsonb_build_object('name', s.store_name, 'lat', s.store_lat, 'lng', s.store_lng));
end $$;


-- staff: + the store location and the switch
CREATE OR REPLACE FUNCTION public.shop_admin_save_settings(p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cur public.shop_settings; fee numeric; fmin numeric; v_sname text; v_slat numeric; v_slng numeric; v_surl text;
begin
  perform public.shop_require_staff('change the shop settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Nothing to save'; end if;
  select * into cur from public.shop_settings where id for update;
  fee := case when p_patch ? 'shipping_fee' then (p_patch ->> 'shipping_fee')::numeric else cur.shipping_fee end;
  fmin := case when p_patch ? 'free_shipping_min' then nullif(p_patch ->> 'free_shipping_min', '')::numeric else cur.free_shipping_min end;
  if fee < 0 or fee <> round(fee, 2) then raise exception 'The shipping fee must be an amount in baht'; end if;
  if fmin is not null and (fmin <= 0 or fmin <> round(fmin, 2)) then raise exception 'The free-shipping amount must be a positive amount'; end if;
  v_sname := case when p_patch ? 'store_name' then btrim(coalesce(p_patch ->> 'store_name', '')) else cur.store_name end;
  if length(v_sname) not between 1 and 100 then raise exception 'INVALID_STORE' using errcode = '22023'; end if;
  if (p_patch ? 'store_lat' and coalesce(p_patch ->> 'store_lat', '') !~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$') or (p_patch ? 'store_lng' and coalesce(p_patch ->> 'store_lng', '') !~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$') then raise exception 'INVALID_STORE_LOCATION' using errcode = '22023'; end if;
  v_slat := round(case when p_patch ? 'store_lat' then (p_patch ->> 'store_lat')::numeric else cur.store_lat end, 6);
  v_slng := round(case when p_patch ? 'store_lng' then (p_patch ->> 'store_lng')::numeric else cur.store_lng end, 6);
  if not public.shop_pin_area_ok(v_slat, v_slng) then raise exception 'INVALID_STORE_LOCATION' using errcode = '22023'; end if;
  v_surl := case when p_patch ? 'store_maps_url' then nullif(btrim(coalesce(p_patch ->> 'store_maps_url', '')), '') else cur.store_maps_url end;
  if v_surl is not null and (length(v_surl) > 300 or v_surl !~ '^https://') then raise exception 'INVALID_STORE_URL' using errcode = '22023'; end if;
  update public.shop_settings set
    shop_open = case when p_patch ? 'shop_open' then (p_patch ->> 'shop_open')::boolean else shop_open end,
    closed_message = case when p_patch ? 'closed_message' then nullif(btrim(p_patch ->> 'closed_message'), '') else closed_message end,
    delivery_enabled = case when p_patch ? 'delivery_enabled' then (p_patch ->> 'delivery_enabled')::boolean else delivery_enabled end,
    pickup_enabled = case when p_patch ? 'pickup_enabled' then (p_patch ->> 'pickup_enabled')::boolean else pickup_enabled end,
    pickup_note = case when p_patch ? 'pickup_note' then nullif(btrim(p_patch ->> 'pickup_note'), '') else pickup_note end,
    require_payment_slip = case when p_patch ? 'require_payment_slip' then (p_patch ->> 'require_payment_slip')::boolean else require_payment_slip end,
    delivery_pin_required = case when p_patch ? 'delivery_pin_required' then (p_patch ->> 'delivery_pin_required')::boolean else delivery_pin_required end,
    store_name = v_sname, store_lat = v_slat, store_lng = v_slng, store_maps_url = v_surl,
    shipping_fee = fee, free_shipping_min = fmin, updated_by = auth.uid(), updated_at = now()
  where id;
  perform public.shop_log('settings', 'shop', 'settings.save', p_patch);
  return public.shop_admin_settings();
end $function$;


-- ================================================================================================ grants
do $$ declare f text; begin
  foreach f in array array[
    'shop_haversine_m(double precision, double precision, double precision, double precision)', 'shop_pin_area_ok(numeric, numeric)', 'shop_maps_url(numeric, numeric)',
    'shop_maps_dir_url(numeric, numeric, numeric, numeric)', 'shop_clean_text(text, integer, boolean)', 'shop_delivery_clean(jsonb, boolean)', 'shop_delivery_text(jsonb)',
    'shop_route_accept(integer, jsonb)', 'shop_delivery_json(uuid)', 'shop_address_json(public.shop_addresses)', 'shop_delivery_frozen()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'shop_address_list()', 'shop_address_save(uuid, jsonb, text, boolean)', 'shop_address_set_default(uuid)', 'shop_address_delete(uuid)',
    'shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text, timestamptz, jsonb)', 'shop_settings_public()', 'shop_admin_save_settings(jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
