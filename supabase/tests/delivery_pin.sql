-- Tests for 20261128130000_delivery_pin.sql, run after the migration in ONE transaction that always rolls back (scripts/run-delivery-pin-sql-tests.sh).
-- Real data: S = a real SUPER_ADMIN (staff), A / B = real USER profiles (customers), the first sellable SKU of the real catalogue and the shop's real payment accounts.
-- Every order, saved address and setting changed here disappears with the rollback. No seed data: the pins below are coordinates in Sam Phran / Bangkok chosen for the test only.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, m ilike p_pat, m); end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into t_ctx values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.sv(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.sx(p_sql text) returns void language plpgsql security definer as $$ begin execute p_sql; end $$;
create or replace function pg_temp.items(n int) returns jsonb language sql as $$ select jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', n)) $$;
-- a valid delivery object (Sam Phran, a few km from the shop) with extra keys merged over it
create or replace function pg_temp.pin(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('lat', 13.7700, 'lng', 100.3300, 'confirmed', true, 'pin_source', 'tap', 'recipient_name', 'Somchai Tester', 'recipient_phone', '0891234567',
    'address_line', '99/9 Test Road, Sam Phran, Nakhon Pathom', 'unit_no', '12/3', 'village', 'Test Village', 'floor_no', '3', 'landmark', 'Opposite the 7-Eleven',
    'directions', 'Enter by the main gate', 'driver_note', 'Call before arriving', 'place_label', 'Test place',
    'route', jsonb_build_object('distance_m', 6200, 'duration_s', 900, 'source', 'osrm')) || p_extra $$;
-- place an order as the current user; p_dl null = the old way (no pin)
create or replace function pg_temp.place(p_key text, p_f text, p_dl jsonb, p_addr text default null) returns jsonb language sql as $$
  select public.shop_place_order(p_key, pg_temp.items(1), p_f, 'Test Customer', '0812345678', p_addr, null, null, null, null, null, null, null, null, null, p_dl) $$;
create or replace function pg_temp.dj(p_order text) returns jsonb language sql as $$ select pg_temp.sv(format('select public.shop_delivery_json(%L::uuid)::text', p_order))::jsonb $$;
create or replace function pg_temp.oid(p_res jsonb) returns text language sql as $$ select p_res -> 'order' ->> 'id' $$;
create or replace function pg_temp.orders_n() returns integer language sql as $$ select pg_temp.sv('select count(*) from public.shop_orders')::int $$;
create or replace function pg_temp.drows() returns integer language sql as $$ select pg_temp.sv('select count(*) from public.shop_order_delivery')::int $$;

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('A', (select id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1));
select pg_temp.put('B', (select id::text from public.profiles where role = 'USER' and status = 'active' and id <> pg_temp.c('A')::uuid order by created_at limit 1));
select pg_temp.put('sku', (select sku_code from public.shop_sellable where available and coalesce(max_qty, 99) >= 2 order by sku_seq limit 1));
select pg_temp.chk('F0 fixtures: a super admin, two customers and a sellable product', (select count(*) from t_ctx where v is not null) = 4, (select string_agg(k || '=' || coalesce(v, 'NULL'), ',') from t_ctx));
update public.shop_settings set shop_open = true, pickup_enabled = true, delivery_enabled = true, require_payment_slip = false, shipping_fee = 0, free_shipping_min = null where id;
select pg_temp.put('orders_before', pg_temp.orders_n()::text);
select pg_temp.put('old_order', (select id::text from public.shop_orders where fulfilment = 'delivery' order by created_at limit 1));

-- ================================================================================================ M. what the migration did
select pg_temp.chk('M1 the store is the shop''s own Google Maps location (as resolved from its short link)',
  (select store_name = 'หมู่บ้านสิวารัตน์ 2' and store_lat = 13.745952 and store_lng = 100.292734 and store_maps_url = 'https://maps.app.goo.gl/tT5NXeciaU2tuFyc9' from public.shop_settings where id));
select pg_temp.chk('M1 a delivery order needs a pin by default', (select delivery_pin_required from public.shop_settings where id));
select pg_temp.chk('M1 no order that existed has a pin and every order keeps its old keys',
  (select count(*) from public.shop_orders o where public.shop_order_json(o.id) -> 'delivery' <> 'null'::jsonb) = 0
  and (select bool_and(public.shop_order_json(o.id) ?& array['id', 'order_no', 'status', 'fulfilment', 'contact_name', 'contact_phone', 'delivery_address', 'items', 'invoice', 'order_type', 'pickup_at']) from public.shop_orders o));
select pg_temp.chk('M1 the order json says "delivery": null for an order without a pin', pg_temp.sv(format($q$select (public.shop_order_json(%L::uuid) ? 'delivery')::text$q$, pg_temp.c('old_order'))) = 'true'
  and pg_temp.sv(format($q$select jsonb_typeof(public.shop_order_json(%L::uuid) -> 'delivery')$q$, pg_temp.c('old_order'))) = 'null');
select pg_temp.chk('M1 the old 15-argument shop_place_order is gone (one function, no ambiguity)',
  (select count(*) from pg_proc where proname = 'shop_place_order' and pronamespace = 'public'::regnamespace) = 1);
set local role anon;
select pg_temp.chk('M2 anon can call none of the new functions', not has_function_privilege('anon', 'public.shop_address_list()', 'execute') and not has_function_privilege('anon', 'public.shop_address_save(uuid, jsonb, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.shop_address_delete(uuid)', 'execute') and not has_function_privilege('anon', 'public.shop_address_set_default(uuid)', 'execute'));
reset role;
set local role authenticated;
select pg_temp.chk('M2 a customer can call the address functions but none of the internal helpers',
  has_function_privilege('authenticated', 'public.shop_address_list()', 'execute') and has_function_privilege('authenticated', 'public.shop_address_save(uuid, jsonb, text, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.shop_delivery_clean(jsonb, boolean)', 'execute') and not has_function_privilege('authenticated', 'public.shop_delivery_json(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.shop_haversine_m(double precision, double precision, double precision, double precision)', 'execute')
  and not has_function_privilege('authenticated', 'public.shop_route_accept(integer, jsonb)', 'execute'));
select pg_temp.chk('M2 nobody can write the two tables directly', not has_table_privilege('authenticated', 'public.shop_order_delivery', 'insert') and not has_table_privilege('authenticated', 'public.shop_order_delivery', 'update')
  and not has_table_privilege('authenticated', 'public.shop_order_delivery', 'delete') and not has_table_privilege('authenticated', 'public.shop_addresses', 'insert') and not has_table_privilege('authenticated', 'public.shop_addresses', 'update')
  and not has_table_privilege('authenticated', 'public.shop_addresses', 'delete') and not has_table_privilege('anon', 'public.shop_order_delivery', 'select') and not has_table_privilege('anon', 'public.shop_addresses', 'select'));
reset role;

-- ================================================================================================ P. the helpers (internal functions: read as the owner)
select pg_temp.chk('P1 straight-line distance: zero for the same point', public.shop_haversine_m(13.745952, 100.292734, 13.745952, 100.292734) = 0);
select pg_temp.chk('P1 one degree of latitude is about 111.2 km', abs(public.shop_haversine_m(13, 100, 14, 100) - 111195) < 100, public.shop_haversine_m(13, 100, 14, 100)::text);
select pg_temp.chk('P1 the shop to the test pin is about 4.8 km', public.shop_haversine_m(13.745952, 100.292734, 13.7700, 100.3300) between 4700 and 4950, public.shop_haversine_m(13.745952, 100.292734, 13.7700, 100.3300)::text);
select pg_temp.chk('P1 it is symmetric', public.shop_haversine_m(13.745952, 100.292734, 13.77, 100.33) = public.shop_haversine_m(13.77, 100.33, 13.745952, 100.292734));
select pg_temp.chk('P2 the destination link is the exact Google Maps search URL', public.shop_maps_url(13.745952, 100.292734) = 'https://www.google.com/maps/search/?api=1&query=13.745952,100.292734');
select pg_temp.chk('P2 the route link starts at the store and ends at the pin', public.shop_maps_dir_url(13.745952, 100.292734, 13.77, 100.33)
  = 'https://www.google.com/maps/dir/?api=1&origin=13.745952,100.292734&destination=13.77,100.33&travelmode=driving');
select pg_temp.chk('P3 the delivery area is Thailand', public.shop_pin_area_ok(13.7563, 100.5018) and public.shop_pin_area_ok(18.7883, 98.9853) and not public.shop_pin_area_ok(0, 0) and not public.shop_pin_area_ok(35.68, 139.69));
select pg_temp.chk('P4 control characters are removed and an empty text is null', public.shop_clean_text(E'  a\u0001b\u0007c  ', 20) = 'a b c' and public.shop_clean_text('   ', 20) is null and public.shop_clean_text(null, 20) is null);
select pg_temp.chk('P4 a multi-line text keeps its line breaks', public.shop_clean_text(E'line one\r\nline two', 50, true) = E'line one\nline two' and public.shop_clean_text(E'line one\nline two', 50) = 'line one line two');
select pg_temp.err_like('P4 a text that is too long is refused, never cut', $q$select public.shop_clean_text(repeat('x', 21), 20)$q$, 'INVALID_DETAILS');
select pg_temp.chk('P5 a plausible route is kept', public.shop_route_accept(4800, '{"distance_m":6200,"duration_s":900,"source":"osrm"}') = '{"distance_m":6200,"duration_s":900,"source":"osrm"}'::jsonb);
select pg_temp.chk('P5 a road cannot be shorter than the straight line', public.shop_route_accept(4800, '{"distance_m":2000,"duration_s":900,"source":"osrm"}') is null);
select pg_temp.chk('P5 nor absurdly longer', public.shop_route_accept(4800, '{"distance_m":900000,"duration_s":90000,"source":"osrm"}') is null);
select pg_temp.chk('P5 nor faster than a vehicle can drive', public.shop_route_accept(4800, '{"distance_m":6200,"duration_s":30,"source":"osrm"}') is null and public.shop_route_accept(4800, '{"distance_m":6200,"duration_s":9000000,"source":"osrm"}') is null);
select pg_temp.chk('P5 only a known provider counts, and zero or missing values are dropped', public.shop_route_accept(4800, '{"distance_m":6200,"duration_s":900,"source":"made-up"}') is null
  and public.shop_route_accept(4800, '{"distance_m":0,"duration_s":900,"source":"osrm"}') is null and public.shop_route_accept(4800, null) is null and public.shop_route_accept(4800, '{"source":"osrm"}') is null);
select pg_temp.chk('P6 the order address text is made from the parts', public.shop_delivery_text('{"address_line":"99/9 Test Road","unit_no":"12/3","village":"Test Village","floor_no":"3","landmark":"By the gate"}')
  = E'99/9 Test Road\nเลขที่/ห้อง 12/3 · Test Village · ชั้น 3\nจุดสังเกต: By the gate' and public.shop_delivery_text('{"address_line":"99/9 Test Road"}') = '99/9 Test Road');

-- ================================================================================================ V. every refusal of the delivery details (checked before an order is touched)
select pg_temp.chk('V0 a valid object is accepted, trimmed and rounded', (public.shop_delivery_clean(pg_temp.pin('{"lat": 13.7700004, "recipient_phone": "089-123 4567", "unit_no": "  12/3  "}'::jsonb)) ->> 'lat') = '13.770000'
  and (public.shop_delivery_clean(pg_temp.pin('{"recipient_phone": "089-123 4567"}'::jsonb)) ->> 'recipient_phone') = '0891234567');
select pg_temp.err_like('V1 no coordinates', $q$select public.shop_delivery_clean('{"confirmed":true,"pin_source":"tap","recipient_name":"a","recipient_phone":"0891234567","address_line":"12345"}')$q$, 'PIN_INVALID');
select pg_temp.err_like('V1 a coordinate that is not a number', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"lat":"abc"}'::jsonb)), 'PIN_INVALID');
select pg_temp.err_like('V1 a latitude beyond 90', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"lat":95}'::jsonb)), 'PIN_INVALID');
select pg_temp.err_like('V1 an exponent is not a coordinate', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"lat":"1e1"}'::jsonb)), 'PIN_INVALID');
select pg_temp.err_like('V1 an unknown way of pinning', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"pin_source":"guess"}'::jsonb)), 'PIN_INVALID');
select pg_temp.err_like('V1 a delivery that is not an object', $q$select public.shop_delivery_clean('[1,2]'::jsonb)$q$, 'PIN_INVALID');
select pg_temp.err_like('V2 the middle of the ocean (0, 0)', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"lat":0,"lng":0}'::jsonb)), 'PIN_OUTSIDE_AREA');
select pg_temp.err_like('V2 Tokyo', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"lat":35.68,"lng":139.69}'::jsonb)), 'PIN_OUTSIDE_AREA');
select pg_temp.err_like('V3 a pin that was not confirmed', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"confirmed":false}'::jsonb)), 'PIN_NOT_CONFIRMED');
select pg_temp.err_like('V3 "confirmed" as the text "yes" is not a confirmation either', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"confirmed":"yes"}'::jsonb)), 'PIN_NOT_CONFIRMED');
select pg_temp.err_like('V4 no recipient name', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"recipient_name":"  "}'::jsonb)), 'INVALID_RECIPIENT');
select pg_temp.err_like('V4 a phone number that is not a Thai number', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"recipient_phone":"12345"}'::jsonb)), 'INVALID_RECIPIENT');
select pg_temp.err_like('V5 an address that is too short', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin('{"address_line":"abc"}'::jsonb)), 'INVALID_ADDRESS');
select pg_temp.err_like('V5 an address that is too long', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin(jsonb_build_object('address_line', repeat('x', 301)))), 'INVALID_DETAILS');
select pg_temp.err_like('V6 a landmark that is too long', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin(jsonb_build_object('landmark', repeat('x', 121)))), 'INVALID_DETAILS');
select pg_temp.err_like('V6 driver instructions that are too long', format($q$select public.shop_delivery_clean(%L::jsonb)$q$, pg_temp.pin(jsonb_build_object('driver_note', repeat('x', 301)))), 'INVALID_DETAILS');
select pg_temp.chk('V7 optional parts may be missing', (public.shop_delivery_clean('{"lat":13.77,"lng":100.33,"confirmed":true,"pin_source":"gps","recipient_name":"A","recipient_phone":"0891234567","address_line":"12345"}') -> 'unit_no') = 'null'::jsonb);
select pg_temp.chk('V7 a client-sent link is not even carried', not (public.shop_delivery_clean(pg_temp.pin('{"maps_url":"https://evil.example","directions_url":"https://evil.example"}'::jsonb)) ?| array['maps_url', 'directions_url']));
select pg_temp.chk('V7 a route that is not made of numbers is dropped, not fatal', (public.shop_delivery_clean(pg_temp.pin('{"route":{"distance_m":"far","duration_s":"long","source":"osrm"}}'::jsonb)) -> 'route') = 'null'::jsonb);

-- ================================================================================================ O. placing orders with a pin (as the real customer A)
select pg_temp.put('n0', pg_temp.orders_n()::text);
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('oa', pg_temp.oid(pg_temp.place('dl-test-a-0001', 'delivery', pg_temp.pin())));
reset role;
select pg_temp.chk('O1 a delivery order with a confirmed pin is placed', pg_temp.orders_n() = pg_temp.c('n0')::int + 1 and pg_temp.drows() = 1);
select pg_temp.chk('O1 the pin, recipient and instructions are saved with the order',
  (pg_temp.dj(pg_temp.c('oa')) ->> 'lat') = '13.770000' and (pg_temp.dj(pg_temp.c('oa')) ->> 'lng') = '100.330000' and (pg_temp.dj(pg_temp.c('oa')) ->> 'recipient_name') = 'Somchai Tester'
  and (pg_temp.dj(pg_temp.c('oa')) ->> 'recipient_phone') = '0891234567' and (pg_temp.dj(pg_temp.c('oa')) ->> 'driver_note') = 'Call before arriving' and (pg_temp.dj(pg_temp.c('oa')) ->> 'directions') = 'Enter by the main gate'
  and (pg_temp.dj(pg_temp.c('oa')) ->> 'unit_no') = '12/3' and (pg_temp.dj(pg_temp.c('oa')) ->> 'village') = 'Test Village' and (pg_temp.dj(pg_temp.c('oa')) ->> 'floor_no') = '3'
  and (pg_temp.dj(pg_temp.c('oa')) ->> 'landmark') = 'Opposite the 7-Eleven' and (pg_temp.dj(pg_temp.c('oa')) ->> 'pin_source') = 'tap');
select pg_temp.chk('O1 the links are made by the database from the coordinates and the store',
  (pg_temp.dj(pg_temp.c('oa')) ->> 'maps_url') = 'https://www.google.com/maps/search/?api=1&query=13.77,100.33'
  and (pg_temp.dj(pg_temp.c('oa')) ->> 'directions_url') = 'https://www.google.com/maps/dir/?api=1&origin=13.745952,100.292734&destination=13.77,100.33&travelmode=driving');
select pg_temp.chk('O1 the route starts at the store as it was when the order was placed', pg_temp.dj(pg_temp.c('oa')) -> 'origin' = '{"name":"หมู่บ้านสิวารัตน์ 2","lat":13.745952,"lng":100.292734}'::jsonb);
select pg_temp.chk('O1 the straight line is the database''s own and the driving route is kept (plausible)', (pg_temp.dj(pg_temp.c('oa')) ->> 'straight_m')::int between 4700 and 4950
  and (pg_temp.dj(pg_temp.c('oa')) -> 'route' ->> 'distance_m') = '6200' and (pg_temp.dj(pg_temp.c('oa')) -> 'route' ->> 'duration_s') = '900' and (pg_temp.dj(pg_temp.c('oa')) -> 'route' ->> 'source') = 'osrm');
select pg_temp.chk('O1 the pin time is recorded', (pg_temp.dj(pg_temp.c('oa')) ->> 'confirmed_at')::timestamptz > now() - interval '1 minute');
select pg_temp.chk('O1 the order itself carries the address text built from the parts (every older screen still shows it)',
  pg_temp.sv(format($q$select delivery_address from public.shop_orders where id = %L$q$, pg_temp.c('oa'))) = E'99/9 Test Road, Sam Phran, Nakhon Pathom\nเลขที่/ห้อง 12/3 · Test Village · ชั้น 3\nจุดสังเกต: Opposite the 7-Eleven');
select pg_temp.chk('O1 the order json the customer app reads has the delivery', pg_temp.sv(format($q$select (public.shop_order_json(%L::uuid) -> 'delivery' ->> 'maps_url')$q$, pg_temp.c('oa'))) = 'https://www.google.com/maps/search/?api=1&query=13.77,100.33');
select pg_temp.chk('O1 the audit log says a pin was given, not where', pg_temp.sv(format($q$select (detail ->> 'pin_source') || ':' || (detail ? 'lat')::text from public.shop_events where entity = 'order' and entity_id = %L and action = 'order.delivery_pin'$q$, pg_temp.c('oa'))) = 'tap:false');

-- a retry of the same checkout gives the same order and no second delivery row; the route being measured again does not make it another order
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('O2 a retry returns the same order (replay) and no second pin', (pg_temp.place('dl-test-a-0001', 'delivery', pg_temp.pin()) ->> 'replay') = 'true');
select pg_temp.chk('O2 also when the route was measured again', (pg_temp.place('dl-test-a-0001', 'delivery', pg_temp.pin('{"route":{"distance_m":6300,"duration_s":950,"source":"osrm"}}'::jsonb)) ->> 'replay') = 'true');
reset role;
select pg_temp.chk('O2 still one delivery row and one order from that key', pg_temp.drows() = 1 and pg_temp.orders_n() = pg_temp.c('n0')::int + 1);
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('O3 the same key with another pin is a different request', format($q$select pg_temp.place('dl-test-a-0001', 'delivery', %L::jsonb)$q$, pg_temp.pin('{"lat":13.80,"lng":100.40}'::jsonb)), '%KEY_REUSED%');
-- refusals leave nothing behind
select pg_temp.err_like('O4 an unconfirmed pin is refused', format($q$select pg_temp.place('dl-test-a-0002', 'delivery', %L::jsonb)$q$, pg_temp.pin('{"confirmed":false}'::jsonb)), '%PIN_NOT_CONFIRMED%');
select pg_temp.err_like('O4 a pin outside Thailand is refused', format($q$select pg_temp.place('dl-test-a-0003', 'delivery', %L::jsonb)$q$, pg_temp.pin('{"lat":35.68,"lng":139.69}'::jsonb)), '%PIN_OUTSIDE_AREA%');
select pg_temp.err_like('O4 a delivery without any pin is refused while a pin is required', $q$select pg_temp.place('dl-test-a-0004', 'delivery', null, 'a typed address only, 12 Some Road')$q$, '%DELIVERY_PIN_REQUIRED%');
select pg_temp.err_like('O4 a JSON null is the same as no pin', $q$select pg_temp.place('dl-test-a-0005', 'delivery', 'null'::jsonb, 'a typed address only, 12 Some Road')$q$, '%DELIVERY_PIN_REQUIRED%');
select pg_temp.err_like('O4 a bad recipient is refused', format($q$select pg_temp.place('dl-test-a-0006', 'delivery', %L::jsonb)$q$, pg_temp.pin('{"recipient_phone":"1"}'::jsonb)), '%INVALID_RECIPIENT%');
select pg_temp.err_like('O5 a pin cannot be sent with a pick-up order', format($q$select pg_temp.place('dl-test-a-0007', 'pickup', %L::jsonb)$q$, pg_temp.pin()), '%DELIVERY_PICKUP_CONFLICT%');
reset role;
select pg_temp.chk('O4 none of those refusals created an order or a pin', pg_temp.orders_n() = pg_temp.c('n0')::int + 1 and pg_temp.drows() = 1);

-- what the client sends is not trusted
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('ob', pg_temp.oid(pg_temp.place('dl-test-a-0010', 'delivery', pg_temp.pin('{"maps_url":"https://evil.example/x","directions_url":"https://evil.example/y","lat":13.7400,"lng":100.3000,"address_line":"line one\u0001 with a control char","route":{"distance_m":10,"duration_s":900,"source":"osrm"}}'::jsonb))));
reset role;
select pg_temp.chk('O6 links sent by the client are ignored', (pg_temp.dj(pg_temp.c('ob')) ->> 'maps_url') = 'https://www.google.com/maps/search/?api=1&query=13.74,100.3'
  and (pg_temp.dj(pg_temp.c('ob')) ->> 'directions_url') like 'https://www.google.com/maps/dir/?api=1&origin=13.745952,100.292734&destination=13.74,100.3%');
select pg_temp.chk('O6 an impossible driving distance (10 m for a 3 km trip) is dropped, the order is still placed', (pg_temp.dj(pg_temp.c('ob')) -> 'route') = 'null'::jsonb and (pg_temp.dj(pg_temp.c('ob')) ->> 'straight_m')::int > 0);
select pg_temp.chk('O6 control characters are removed from the address', (pg_temp.dj(pg_temp.c('ob')) ->> 'address_line') = 'line one with a control char');
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('oc', pg_temp.oid(pg_temp.place('dl-test-a-0011', 'delivery', pg_temp.pin('{"route":{"distance_m":6200,"duration_s":900,"source":"google"}}'::jsonb))));
select pg_temp.put('od', pg_temp.oid(pg_temp.place('dl-test-a-0012', 'delivery', (pg_temp.pin() - 'route'))));
reset role;
select pg_temp.chk('O7 a route from an unknown provider is dropped', (pg_temp.dj(pg_temp.c('oc')) -> 'route') = 'null'::jsonb);
select pg_temp.chk('O7 no route at all (the mapping service was down): the order is still placed, with the pin and both links', (pg_temp.dj(pg_temp.c('od')) -> 'route') = 'null'::jsonb
  and (pg_temp.dj(pg_temp.c('od')) ->> 'maps_url') is not null and (pg_temp.dj(pg_temp.c('od')) ->> 'directions_url') is not null and (pg_temp.dj(pg_temp.c('od')) ->> 'straight_m')::int between 4700 and 4950);

-- pick-up orders and the old way are unchanged
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('op', pg_temp.oid(pg_temp.place('dl-test-a-0020', 'pickup', null)));
reset role;
select pg_temp.chk('O8 a pick-up order is placed as before: no pin, no address', pg_temp.dj(pg_temp.c('op')) is null
  and pg_temp.sv(format($q$select (delivery_address is null)::text from public.shop_orders where id = %L$q$, pg_temp.c('op'))) = 'true');
update public.shop_settings set delivery_pin_required = false where id;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('ol', pg_temp.oid(pg_temp.place('dl-test-a-0021', 'delivery', null, 'a typed address only, 12 Some Road')));
reset role;
select pg_temp.chk('O8 with the switch off, the old way still works (typed address, no pin)', pg_temp.dj(pg_temp.c('ol')) is null
  and pg_temp.sv(format($q$select delivery_address from public.shop_orders where id = %L$q$, pg_temp.c('ol'))) = 'a typed address only, 12 Some Road');
update public.shop_settings set delivery_pin_required = true where id;

-- ================================================================================================ I. a delivery snapshot is frozen
select pg_temp.err_like('I1 nobody can change a delivery destination', format($q$select pg_temp.sx(%L)$q$, format($s$update public.shop_order_delivery set lat = 13.9 where order_id = %L$s$, pg_temp.c('oa'))), 'DELIVERY_FROZEN');
select pg_temp.err_like('I1 nor erase it', format($q$select pg_temp.sx(%L)$q$, format($s$delete from public.shop_order_delivery where order_id = %L$s$, pg_temp.c('oa'))), 'DELIVERY_FROZEN');
select pg_temp.err_like('I1 not even the links', format($q$select pg_temp.sx(%L)$q$, format($s$update public.shop_order_delivery set maps_url = 'https://x.example' where order_id = %L$s$, pg_temp.c('oa'))), 'DELIVERY_FROZEN');
select pg_temp.err_like('I2 an order with a pin cannot be deleted either', format($q$select pg_temp.sx(%L)$q$, format($s$delete from public.shop_orders where id = %L$s$, pg_temp.c('oa'))), '%never deleted%');

-- ================================================================================================ R. who can see what
select pg_temp.put('snap', pg_temp.dj(pg_temp.c('oa'))::text);
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('R1 the customer reads their own delivery (table and order)', (select count(*) from public.shop_order_delivery) = 4
  and (public.shop_my_order(pg_temp.c('oa')::uuid) -> 'delivery' ->> 'lat') = '13.770000', (select count(*)::text from public.shop_order_delivery));
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.chk('R2 another customer sees no delivery of theirs at all', (select count(*) from public.shop_order_delivery) = 0);
select pg_temp.err_like('R2 and cannot open the order', format($q$select public.shop_my_order(%L::uuid)$q$, pg_temp.c('oa')), '%Order not found%');
select pg_temp.err_like('R2 cannot write a delivery row', format($q$insert into public.shop_order_delivery (order_id, recipient_name, recipient_phone, address_line, lat, lng, pin_source, origin_name, origin_lat, origin_lng, maps_url, directions_url, straight_m) values (%L, 'x', '0891234567', '12345', 13.7, 100.3, 'tap', 'x', 13.7, 100.3, 'u', 'u', 1)$q$, pg_temp.c('oa')), '%permission denied%');
select pg_temp.err_like('R2 cannot update one', $q$update public.shop_order_delivery set lat = 13.9$q$, '%permission denied%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('R3 staff see every delivery and the order with its delivery', (select count(*) from public.shop_order_delivery) = 4
  and (public.shop_admin_order(pg_temp.c('oa')::uuid) -> 'delivery' ->> 'directions_url') like 'https://www.google.com/maps/dir/%'
  and (select count(*) from jsonb_array_elements(public.shop_admin_orders(null, null, 100, 0) -> 'orders') o where o -> 'delivery' <> 'null'::jsonb) = 4);
reset role;
set local role anon;
select pg_temp.err_like('R4 anon cannot read a delivery', $q$select count(*) from public.shop_order_delivery$q$, '%permission denied%');
select pg_temp.err_like('R4 nor a saved address', $q$select count(*) from public.shop_addresses$q$, '%permission denied%');
reset role;

-- ================================================================================================ S. saved addresses
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('a1', (public.shop_address_save(null, pg_temp.pin(), 'Home') ->> 'id'));
select pg_temp.put('a2', (public.shop_address_save(null, pg_temp.pin('{"lat":13.8,"lng":100.4,"address_line":"Office, 1 Work Road"}'::jsonb), 'Office') ->> 'id'));
select pg_temp.chk('S1 the first saved address is the default, the second is not', (select is_default from public.shop_addresses where id = pg_temp.c('a1')::uuid) and not (select is_default from public.shop_addresses where id = pg_temp.c('a2')::uuid));
select pg_temp.chk('S1 the list is the customer''s own, default first', (select jsonb_array_length(public.shop_address_list())) = 2 and (public.shop_address_list() -> 0 ->> 'id') = pg_temp.c('a1'));
select pg_temp.put('r_default', (public.shop_address_set_default(pg_temp.c('a2')::uuid) ->> 'is_default'));
select pg_temp.chk('S1 setting another default moves it (only one at a time)', pg_temp.c('r_default') = 'true'
  and (select count(*) from public.shop_addresses where is_default) = 1 and (select is_default from public.shop_addresses where id = pg_temp.c('a2')::uuid));
select pg_temp.put('r_third', (public.shop_address_save(null, pg_temp.pin('{"address_line":"Third place, 3 Road"}'::jsonb), 'Third', true) ->> 'is_default'));
select pg_temp.chk('S1 saving a new default takes the default over', pg_temp.c('r_third') = 'true' and (select count(*) from public.shop_addresses where is_default) = 1);
select pg_temp.err_like('S2 an unconfirmed pin is not saved', format($q$select public.shop_address_save(null, %L::jsonb, 'x')$q$, pg_temp.pin('{"confirmed":false}'::jsonb)), '%PIN_NOT_CONFIRMED%');
select pg_temp.err_like('S2 a label that is too long', format($q$select public.shop_address_save(null, %L::jsonb, %L)$q$, pg_temp.pin(), repeat('x', 41)), '%INVALID_DETAILS%');
-- a saved address is reused for an order, then edited and deleted: the order keeps what it had
select pg_temp.put('oe', pg_temp.oid(pg_temp.place('dl-test-a-0030', 'delivery', pg_temp.pin(jsonb_build_object('address_id', pg_temp.c('a1'), 'pin_source', 'saved')))));
reset role;
select pg_temp.chk('S3 an order placed from a saved address remembers which one', pg_temp.dj(pg_temp.c('oe')) is not null
  and pg_temp.sv(format($q$select address_id::text from public.shop_order_delivery where order_id = %L$q$, pg_temp.c('oe'))) = pg_temp.c('a1') and (pg_temp.dj(pg_temp.c('oe')) ->> 'pin_source') = 'saved');
select pg_temp.put('snap_oe', pg_temp.dj(pg_temp.c('oe'))::text);
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('r_moved', (public.shop_address_save(pg_temp.c('a1')::uuid, pg_temp.pin('{"lat":13.9,"lng":100.5,"address_line":"Moved house, 5 New Road","recipient_name":"New Name"}'::jsonb), 'Home 2') ->> 'lat'));
select pg_temp.chk('S4 repositioning and rewriting the saved address works', pg_temp.c('r_moved') = '13.900000'
  and (select address_line from public.shop_addresses where id = pg_temp.c('a1')::uuid) = 'Moved house, 5 New Road' and (select label from public.shop_addresses where id = pg_temp.c('a1')::uuid) = 'Home 2');
reset role;
select pg_temp.chk('S4 ... and the order placed from it is exactly as it was (history is not rewritten)', pg_temp.dj(pg_temp.c('oe'))::text = pg_temp.c('snap_oe')
  and (pg_temp.dj(pg_temp.c('oe')) ->> 'lat') = '13.770000' and (pg_temp.dj(pg_temp.c('oe')) ->> 'recipient_name') = 'Somchai Tester');
select pg_temp.chk('S4 ... and so is the first order', pg_temp.dj(pg_temp.c('oa'))::text = pg_temp.c('snap'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('S5 deleting the default address makes the latest one the default', (select pg_temp.sv(format($q$select count(*) from public.shop_addresses where profile_id = %L$q$, pg_temp.c('A')))::int) = 3);
select public.shop_address_set_default(pg_temp.c('a1')::uuid);
select public.shop_address_delete(pg_temp.c('a1')::uuid);
select pg_temp.chk('S5 ... one default remains', (select count(*) from public.shop_addresses) = 2 and (select count(*) from public.shop_addresses where is_default) = 1);
reset role;
select pg_temp.chk('S5 ... and the order placed from the deleted address is untouched', pg_temp.dj(pg_temp.c('oe'))::text = pg_temp.c('snap_oe') and pg_temp.drows() = 5);
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.chk('S6 another customer sees none of these addresses', (select count(*) from public.shop_addresses) = 0 and public.shop_address_list() = '[]'::jsonb);
select pg_temp.err_like('S6 cannot edit one', format($q$select public.shop_address_save(%L::uuid, %L::jsonb, 'x')$q$, pg_temp.c('a2'), pg_temp.pin()), '%ADDRESS_NOT_FOUND%');
select pg_temp.err_like('S6 cannot delete one', format($q$select public.shop_address_delete(%L::uuid)$q$, pg_temp.c('a2')), '%ADDRESS_NOT_FOUND%');
select pg_temp.err_like('S6 cannot make one the default', format($q$select public.shop_address_set_default(%L::uuid)$q$, pg_temp.c('a2')), '%ADDRESS_NOT_FOUND%');
-- B uses A's saved-address id in an order: it is not stored
select pg_temp.put('of', pg_temp.oid(pg_temp.place('dl-test-b-0001', 'delivery', pg_temp.pin(jsonb_build_object('address_id', pg_temp.c('a2'))))));
reset role;
select pg_temp.chk('S7 another customer''s address id is not kept on an order', pg_temp.sv(format($q$select (address_id is null)::text from public.shop_order_delivery where order_id = %L$q$, pg_temp.c('of'))) = 'true');
-- the limit of 10 saved addresses
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
do $$ begin for i in 1..10 loop perform public.shop_address_save(null, pg_temp.pin(jsonb_build_object('address_line', 'Address number ' || i)), 'n' || i); end loop; end $$;
select pg_temp.err_like('S8 the eleventh saved address is refused', format($q$select public.shop_address_save(null, %L::jsonb, 'too many')$q$, pg_temp.pin()), '%ADDRESS_LIMIT%');
reset role;

-- ================================================================================================ T. the store location and the switch
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('T1 the customer app learns the store and the switch', (public.shop_settings_public() -> 'store' ->> 'name') = 'หมู่บ้านสิวารัตน์ 2' and (public.shop_settings_public() -> 'store' ->> 'lat') = '13.745952'
  and (public.shop_settings_public() ->> 'delivery_pin_required') = 'true' and (public.shop_settings_public() ? 'preorder_enabled') and (public.shop_settings_public() ? 'shipping_fee'));
select pg_temp.err_like('T2 a customer cannot change the shop settings', $q$select public.shop_admin_save_settings('{"store_lat": 13.9}'::jsonb)$q$, '%not allowed%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.put('r_store', (public.shop_admin_save_settings('{"store_name":"New shop","store_lat":13.8,"store_lng":100.4,"store_maps_url":"https://maps.app.goo.gl/abc"}'::jsonb) ->> 'store_name'));
select pg_temp.chk('T3 staff move the store location (name, coordinates, link)', pg_temp.c('r_store') = 'New shop'
  and (select store_lat = 13.8 and store_lng = 100.4 and store_maps_url = 'https://maps.app.goo.gl/abc' from public.shop_settings where id));
select pg_temp.chk('T3 a save of something else leaves the store alone', (public.shop_admin_save_settings('{"shipping_fee": 0}'::jsonb) ->> 'store_name') = 'New shop');
select pg_temp.err_like('T4 a store outside Thailand', $q$select public.shop_admin_save_settings('{"store_lat": 35.6, "store_lng": 139.6}'::jsonb)$q$, '%INVALID_STORE_LOCATION%');
select pg_temp.err_like('T4 a store latitude that is not a number', $q$select public.shop_admin_save_settings('{"store_lat": "abc"}'::jsonb)$q$, '%INVALID_STORE_LOCATION%');
select pg_temp.err_like('T4 a store link that is not https', $q$select public.shop_admin_save_settings('{"store_maps_url": "http://insecure.example"}'::jsonb)$q$, '%INVALID_STORE_URL%');
select pg_temp.err_like('T4 an empty store name', $q$select public.shop_admin_save_settings('{"store_name": "  "}'::jsonb)$q$, '%INVALID_STORE%');
select pg_temp.chk('T5 the link may be cleared', (public.shop_admin_save_settings('{"store_maps_url": ""}'::jsonb) ->> 'store_maps_url') is null);
select pg_temp.put('r_off', (public.shop_admin_save_settings('{"delivery_pin_required": false}'::jsonb) ->> 'delivery_pin_required'));
select pg_temp.put('r_on', (public.shop_admin_save_settings('{"delivery_pin_required": true}'::jsonb) ->> 'delivery_pin_required'));
select pg_temp.chk('T5 staff switch the pin requirement off and on', pg_temp.c('r_off') = 'false' and pg_temp.c('r_on') = 'true');
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('og', pg_temp.oid(pg_temp.place('dl-test-a-0040', 'delivery', pg_temp.pin())));
reset role;
select pg_temp.chk('T6 a new order starts its route at the NEW store ...', (pg_temp.dj(pg_temp.c('og')) -> 'origin' ->> 'name') = 'New shop'
  and (pg_temp.dj(pg_temp.c('og')) ->> 'directions_url') = 'https://www.google.com/maps/dir/?api=1&origin=13.8,100.4&destination=13.77,100.33&travelmode=driving');
select pg_temp.chk('T6 ... while the earlier orders keep the store they were placed with', (pg_temp.dj(pg_temp.c('oa')) -> 'origin' ->> 'name') = 'หมู่บ้านสิวารัตน์ 2' and pg_temp.dj(pg_temp.c('oa'))::text = pg_temp.c('snap'));

-- ================================================================================================ Z. nothing else moved
select pg_temp.chk('Z1 the old orders were not touched', (select count(*) from public.shop_orders where created_at < now() - interval '1 minute') = pg_temp.c('n0')::int);
select pg_temp.chk('Z1 every delivery row belongs to an order this test placed', (select count(*) from public.shop_order_delivery d join public.shop_orders o on o.id = d.order_id where o.created_at < now() - interval '1 minute') = 0);

-- the result
do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'DELIVERY_PIN_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
