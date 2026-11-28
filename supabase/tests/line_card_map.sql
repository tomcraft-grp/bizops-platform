-- Tests for 20261128140000_line_card_map.sql, run after the migration in ONE transaction that always rolls back (scripts/run-line-card-map-sql-tests.sh).
-- Real data: A = a real USER profile (customer), the first sellable SKU of the real catalogue and the shop's real payment accounts and LINE settings.
-- Every order, queue row and setting changed here disappears with the rollback. Needs the delivery-pin migration (20261128130000) to be applied (it is live).
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into t_ctx values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.sv(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.items(n int) returns jsonb language sql as $$ select jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', n)) $$;
create or replace function pg_temp.pin(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('lat', 13.7700, 'lng', 100.3300, 'confirmed', true, 'pin_source', 'tap', 'recipient_name', 'Somchai Tester', 'recipient_phone', '0891234567',
    'address_line', '99/9 Test Road, Sam Phran, Nakhon Pathom', 'route', jsonb_build_object('distance_m', 6200, 'duration_s', 900, 'source', 'osrm')) || p_extra $$;
create or replace function pg_temp.place(p_key text, p_f text, p_dl jsonb) returns jsonb language sql as $$
  select public.shop_place_order(p_key, pg_temp.items(1), p_f, 'Test Customer', '0812345678', case when p_dl is null and p_f = 'delivery' then 'a typed address only, 12 Some Road' end, null, null, null, null, null, null, null, null, null, p_dl) $$;
create or replace function pg_temp.oid(p_res jsonb) returns text language sql as $$ select p_res -> 'order' ->> 'id' $$;
create or replace function pg_temp.card(p_id text) returns jsonb language sql as $$ select pg_temp.sv(format('select public.line_card_data(%L::uuid)::text', p_id))::jsonb $$;

select pg_temp.put('A', (select id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1));
select pg_temp.put('sku', (select sku_code from public.shop_sellable where available and coalesce(max_qty, 99) >= 2 order by sku_seq limit 1));
select pg_temp.chk('F0 fixtures: a customer and a sellable product', (select count(*) from t_ctx where v is not null) = 2);
update public.shop_settings set shop_open = true, pickup_enabled = true, delivery_enabled = true, require_payment_slip = false, shipping_fee = 0, free_shipping_min = null, delivery_pin_required = true where id;

-- four real orders (as customer A): a pin to somebody else, a pin to the customer themselves, a typed address (the old way) and a pick-up
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('pinned', pg_temp.oid(pg_temp.place('card-map-0001', 'delivery', pg_temp.pin())));
select pg_temp.put('self', pg_temp.oid(pg_temp.place('card-map-0002', 'delivery', pg_temp.pin('{"recipient_name":"Test Customer","recipient_phone":"0812345678","route":null}'::jsonb))));
reset role;
update public.shop_settings set delivery_pin_required = false where id;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('typed', pg_temp.oid(pg_temp.place('card-map-0003', 'delivery', null)));
select pg_temp.put('pickup', pg_temp.oid(pg_temp.place('card-map-0004', 'pickup', null)));
reset role;

-- ================================================================================================ the card data
select pg_temp.chk('C1 an order with a pin: the card carries both links the database built',
  (pg_temp.card(pg_temp.c('pinned')) -> 'delivery' ->> 'maps_url') = 'https://www.google.com/maps/search/?api=1&query=13.77,100.33'
  and (pg_temp.card(pg_temp.c('pinned')) -> 'delivery' ->> 'directions_url') = 'https://www.google.com/maps/dir/?api=1&origin=13.745952,100.292734&destination=13.77,100.33&travelmode=driving');
select pg_temp.chk('C1 ... the straight line, the driving route and the recipient',
  (pg_temp.card(pg_temp.c('pinned')) -> 'delivery' ->> 'straight_m')::int = public.shop_haversine_m(13.745952, 100.292734, 13.77, 100.33)
  and (pg_temp.card(pg_temp.c('pinned')) -> 'delivery' ->> 'route_m') = '6200' and (pg_temp.card(pg_temp.c('pinned')) -> 'delivery' ->> 'route_s') = '900'
  and (pg_temp.card(pg_temp.c('pinned')) -> 'delivery' ->> 'recipient_name') = 'Somchai Tester' and (pg_temp.card(pg_temp.c('pinned')) -> 'delivery' ->> 'recipient_phone') = '0891234567');
select pg_temp.chk('C1 ... and nothing else (no address, no coordinates field, no note)', (select array_agg(k order by k) from jsonb_object_keys(pg_temp.card(pg_temp.c('pinned')) -> 'delivery') k)
  = array['directions_url', 'maps_url', 'recipient_name', 'recipient_phone', 'route_m', 'route_s', 'straight_m']);
select pg_temp.chk('C2 an order whose pin came without a route: the route is null, the rest is there', (pg_temp.card(pg_temp.c('self')) -> 'delivery' -> 'route_m') = 'null'::jsonb
  and (pg_temp.card(pg_temp.c('self')) -> 'delivery' ->> 'maps_url') is not null and (pg_temp.card(pg_temp.c('self')) -> 'delivery' ->> 'recipient_phone') = '0812345678');
select pg_temp.chk('C3 an order with a typed address only has "delivery": null (the key is there)', (pg_temp.card(pg_temp.c('typed')) ? 'delivery') and jsonb_typeof(pg_temp.card(pg_temp.c('typed')) -> 'delivery') = 'null');
select pg_temp.chk('C3 a pick-up order too', (pg_temp.card(pg_temp.c('pickup')) ? 'delivery') and jsonb_typeof(pg_temp.card(pg_temp.c('pickup')) -> 'delivery') = 'null' and (pg_temp.card(pg_temp.c('pickup')) ->> 'fulfilment') = 'pickup');
select pg_temp.chk('C4 every key the card had before is still there with its value',
  pg_temp.card(pg_temp.c('pinned')) ?& array['order_id', 'order_no', 'customer_name', 'phone', 'created_at', 'item_count', 'items', 'more_count', 'total', 'fulfilment', 'order_type', 'pickup_at', 'payment', 'status', 'quick', 'app_url']
  and (pg_temp.card(pg_temp.c('pinned')) ->> 'order_id') = pg_temp.c('pinned') and (pg_temp.card(pg_temp.c('pinned')) ->> 'customer_name') = 'Test Customer' and (pg_temp.card(pg_temp.c('pinned')) ->> 'phone') = '0812345678'
  and (pg_temp.card(pg_temp.c('pinned')) ->> 'fulfilment') = 'delivery' and (pg_temp.card(pg_temp.c('pinned')) ->> 'status') = 'new' and (pg_temp.card(pg_temp.c('pinned')) ->> 'item_count') = '1'
  and jsonb_array_length(pg_temp.card(pg_temp.c('pinned')) -> 'items') = 1 and (pg_temp.card(pg_temp.c('pinned')) ->> 'order_type') = 'regular'
  and (pg_temp.card(pg_temp.c('pinned')) ->> 'app_url') is not distinct from (select app_url from public.line_settings where id)
  and (pg_temp.card(pg_temp.c('pinned')) ->> 'total')::numeric = (select total from public.shop_orders where id = pg_temp.c('pinned')::uuid));
select pg_temp.chk('C5 an unknown order has no card (as before)', pg_temp.sv($q$select (public.line_card_data('00000000-0000-4000-8000-000000000000'::uuid) is null)::text$q$) = 'true');

-- ================================================================================================ who can call it, and the real queue path
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('P1 no client can call the card function (as before)', not has_function_privilege('authenticated', 'public.line_card_data(uuid)', 'execute') and not has_function_privilege('anon', 'public.line_card_data(uuid)', 'execute'));
reset role;
update public.line_settings set enabled = true where id;
insert into public.line_outbox (event, order_id, target_type, target_id, payload) values ('order_new', pg_temp.c('pinned')::uuid, 'group', 'Ctest-card-map', '{}'::jsonb);
select pg_temp.put('claimed', pg_temp.sv($q$select (select e -> 'card' -> 'delivery' ->> 'maps_url' from jsonb_array_elements(public.line_claim_outbox(50)) e where e ->> 'target_id' = 'Ctest-card-map' limit 1)$q$));
select pg_temp.chk('P2 the outbox claim (what line-dispatch really reads) carries the link inside the card', pg_temp.c('claimed') = 'https://www.google.com/maps/search/?api=1&query=13.77,100.33', pg_temp.c('claimed'));

-- the real card JSON of the pinned order, for the browser-free contract check of the card builder (tests/unit/lineCardMap.test.ts holds the same shape)
select pg_temp.put('sample', pg_temp.card(pg_temp.c('pinned'))::text);

-- the result
do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'LINE_CARD_MAP_TESTS % of % passed\n%\nSAMPLE %', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r, (select v from t_ctx where k = 'sample');
end $$;
