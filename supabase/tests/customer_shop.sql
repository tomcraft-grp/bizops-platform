-- Tests for 20261115100000_customer_shop.sql, run against REAL data inside one transaction that is rolled back.
-- Run as: <migration> ; <this file>   (scripts/run-shop-sql-tests.sh). Nothing persists: the last statement raises an
-- exception that carries the result table, and the invoices / receipts / orders created here disappear with the rollback
-- (finance rows can never be deleted for real, which is why this is never run against production without that rollback).
-- Uses real profile ids of the live project: two LINE members (A, B) and a SUPER_ADMIN (S).
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;

create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
-- run p_sql and expect it to fail with a message (or detail) like p_pat
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; d text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    m := sqlerrm || coalesce(' | ' || d, '');
    perform pg_temp.chk(p_test, m ilike p_pat, m);
  end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.tlv(id text, v text) returns text language sql immutable as $$ select id || lpad(length(v)::text, 2, '0') || v $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_res (test, ok, detail) select 'test users found', count(*) = 3, string_agg(k, ',') from t_ctx;
insert into t_ctx select 'expected', count(*)::text from public.sku_registry
  where status = 'active' and sku_category = 'FG' and coalesce(nullif(ecommerce_price, 0), nullif(selling_price, 0), nullif(retail_price, 0)) > 0;

-- expectations computed as the owner (members cannot read sku_registry directly, which is intended)
insert into t_ctx select 'relx', count(*)::text from public.sku_registry where brand = 'RELX' and status = 'active' and sku_category = 'FG'
  and coalesce(nullif(ecommerce_price, 0), nullif(selling_price, 0), nullif(retail_price, 0)) > 0;
insert into t_ctx select 'newest', sku_code from public.sku_registry where sku_category = 'FG' and status = 'active'
  and coalesce(nullif(ecommerce_price, 0), nullif(selling_price, 0), nullif(retail_price, 0)) > 0 order by sku_seq desc limit 1;
-- =========================================================================================== S1 the customer-facing SKU rule
insert into t_res (test, ok, detail) select 'S1 sellable = active FG SKUs with a price', (select count(*) from public.shop_sellable) = pg_temp.c('expected')::int,
  (select count(*) from public.shop_sellable) || ' of ' || pg_temp.c('expected');
insert into t_res (test, ok, detail) select 'S1 sellable is not empty (real catalogue)', (select count(*) from public.shop_sellable) > 100, null;
insert into t_res (test, ok, detail) select 'S1 names carry no sheet row number', count(*) = 0, string_agg(name_full, '; ') from public.shop_sellable where name_full ~ '^[0-9]+\s';
insert into t_res (test, ok, detail) select 'S1 SKUs without any price are excluded (FG-000122)', not exists (select 1 from public.shop_sellable where sku_code = 'FG-000122'), null;
-- raw material / WIP are never sold, even when active and priced
insert into public.sku_registry (sku_code, domain, name_full, status, sku_category, sku_seq, origin, selling_price)
  values (public.sku_format('RM', 990001), 'test', 'RM raw material', 'active', 'RM', 990001, 'app', 100);
insert into t_res (test, ok, detail) select 'S1 raw material excluded', not exists (select 1 from public.shop_sellable where sku_code like 'RM-%'), null;
-- inactive
update public.sku_registry set status = 'inactive' where sku_code = 'FG-000010';
insert into t_res (test, ok, detail) select 'S1 inactive SKU excluded', not exists (select 1 from public.shop_sellable where sku_code = 'FG-000010'), null;
insert into t_res (test, ok, detail) select 'S1 inactive SKU excluded from the DEV APP data source too', not exists (select 1 from customer_app_views.sku_catalog where sku_code = 'FG-000010'), null;
-- hidden by staff
insert into public.shop_sku_content (sku_code, visible) values ('FG-000011', false);
insert into t_res (test, ok, detail) select 'S1 hidden by staff', not exists (select 1 from public.shop_sellable where sku_code = 'FG-000011'), null;
-- category hidden
insert into t_ctx select 'coil', count(*)::text from public.shop_sellable where category = 'Coil';
insert into public.shop_categories (code, visible) values ('Coil', false);
insert into t_res (test, ok, detail) select 'S1 hidden category removes its products', (select count(*) from public.shop_sellable where category = 'Coil') = 0 and pg_temp.c('coil')::int > 0, pg_temp.c('coil') || ' hidden';
update public.shop_categories set visible = true where code = 'Coil';
-- price rule: e-commerce price first, then selling price; a zero price never wins
update public.sku_registry set ecommerce_price = 111 where sku_code = 'FG-000013';
insert into t_res (test, ok, detail) select 'S1 e-commerce price wins', (select price from public.shop_sellable where sku_code = 'FG-000013') = 111, null;
update public.sku_registry set ecommerce_price = 0 where sku_code = 'FG-000013';
insert into t_res (test, ok, detail) select 'S1 zero e-commerce price falls back to selling price', (select price from public.shop_sellable where sku_code = 'FG-000013') = (select selling_price from public.sku_registry where sku_code = 'FG-000013'), null;
insert into t_res (test, ok, detail) select 'S1 kratom with only a retail price is priced from it', (select price from public.shop_sellable where sku_code = 'FG-000123') = 40, null;

-- =========================================================================================== S2 access control
set local role anon;
select pg_temp.err_like('S2 anon cannot browse', $q$select public.shop_catalog()$q$, '%permission denied%');
select pg_temp.err_like('S2 anon cannot read orders', $q$select count(*) from public.shop_orders$q$, '%permission denied%');
select pg_temp.err_like('S2 anon cannot place orders', $q$select public.shop_place_order('anon-key-0001', '[]', 'delivery', 'x', '0812345678', 'abc', null)$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('S2 member cannot read the internal sellable view', $q$select count(*) from public.shop_sellable$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot call shop_order_json', $q$select public.shop_order_json(gen_random_uuid())$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot call shop_log', $q$select public.shop_log('order', 'x', 'order.status', '{}')$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot call finance_log (audit forgery closed)', $q$select public.finance_log('receipt', gen_random_uuid(), 'receipt.post', '{}')$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot call finance_invoice_state_raw', $q$select public.finance_invoice_state_raw(gen_random_uuid())$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot call the internal cancel', $q$select public.shop_cancel_order_internal(gen_random_uuid(), 'x', false)$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot insert orders directly', $q$insert into public.shop_orders (order_no) values ('X')$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot change the shop settings directly', $q$update public.shop_settings set shop_open = true$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot change content directly', $q$insert into public.shop_sku_content (sku_code) values ('FG-000001')$q$, '%permission denied%');
select pg_temp.err_like('S2 member cannot call staff order list', $q$select public.shop_admin_orders()$q$, '%not allowed%');
select pg_temp.err_like('S2 member cannot save shop settings', $q$select public.shop_admin_save_settings('{"shop_open": true}')$q$, '%not allowed%');
select pg_temp.err_like('S2 member cannot save product content', $q$select public.shop_admin_save_content('FG-000001', '{"featured": true}')$q$, '%not allowed%');
select pg_temp.err_like('S2 member cannot change order status', $q$select public.shop_admin_set_status(gen_random_uuid(), 'confirmed')$q$, '%not allowed%');
select pg_temp.err_like('S2 member cannot upload product pictures', $q$insert into storage.objects (bucket_id, name) values ('shop-products', 'FG-000001/x.webp')$q$, '%row-level security%');
insert into t_res (test, ok, detail) select 'S2 member sees no settings rows directly', (select count(*) from public.shop_settings) = 0, null;

-- =========================================================================================== S3 browsing (member A)
insert into t_ctx select 'cat', (public.shop_catalog() )::text;
insert into t_res (test, ok, detail) select 'S3 catalogue total = sellable', ((v::jsonb) ->> 'total')::int = pg_temp.c('expected')::int - 2, ((v::jsonb) ->> 'total') || ' (-1 inactive -1 hidden)' from t_ctx where k = 'cat';
insert into t_res (test, ok, detail) select 'S3 default page is 24 items', jsonb_array_length((v::jsonb) -> 'items') = 24, null from t_ctx where k = 'cat';
insert into t_res (test, ok, detail) select 'S3 item never exposes cost / friend / wholesale prices',
  not (v ~* 'cost_price|friend_price|wholesale_price|cost'), null from t_ctx where k = 'cat';
insert into t_res (test, ok, detail) select 'S3 inactive and hidden SKUs are not listed', v !~ 'FG-000010' and v !~ 'FG-000011', null from t_ctx where k = 'cat';
insert into t_res (test, ok, detail) select 'S3 search by SKU code', (public.shop_catalog('FG-000001') ->> 'total')::int = 1 and public.shop_catalog('fg-000001') -> 'items' -> 0 ->> 'sku_code' = 'FG-000001', null;
insert into t_res (test, ok, detail) select 'S3 search by Thai name', (public.shop_catalog('ผลไม้รวม') ->> 'total')::int >= 1, (public.shop_catalog('ผลไม้รวม') ->> 'total');
insert into t_res (test, ok, detail) select 'S3 search by brand', (public.shop_catalog('infy') ->> 'total')::int > 10, (public.shop_catalog('infy') ->> 'total');
insert into t_res (test, ok, detail) select 'S3 search treats % and _ literally', (public.shop_catalog('%') ->> 'total')::int = 0 and (public.shop_catalog('_') ->> 'total')::int = 0, null;
insert into t_res (test, ok, detail) select 'S3 search with SQL metacharacters is harmless', (public.shop_catalog($$' or 1=1 --$$) ->> 'total')::int = 0, null;
insert into t_res (test, ok, detail) select 'S3 category filter', (public.shop_catalog(p_category => 'SaltNic') ->> 'total')::int = 2, (public.shop_catalog(p_category => 'SaltNic') ->> 'total');
insert into t_res (test, ok, detail) select 'S3 brand filter', (public.shop_catalog(p_brand => 'RELX') ->> 'total')::int = pg_temp.c('relx')::int, (public.shop_catalog(p_brand => 'RELX') ->> 'total') || ' vs ' || pg_temp.c('relx');
insert into t_res (test, ok, detail) select 'S3 price ascending', (select bool_and(p >= lag_p) from (select (e ->> 'price')::numeric p, lag((e ->> 'price')::numeric, 1, 0) over (order by o) lag_p
  from jsonb_array_elements(public.shop_catalog(p_sort => 'price_asc', p_limit => 60) -> 'items') with ordinality t(e, o)) x), null;
insert into t_res (test, ok, detail) select 'S3 price descending', (select bool_and(p <= lag_p) from (select (e ->> 'price')::numeric p, lag((e ->> 'price')::numeric, 1, 1e9) over (order by o) lag_p
  from jsonb_array_elements(public.shop_catalog(p_sort => 'price_desc', p_limit => 60) -> 'items') with ordinality t(e, o)) x), null;
insert into t_res (test, ok, detail) select 'S3 newest first', public.shop_catalog(p_sort => 'newest', p_limit => 1) -> 'items' -> 0 ->> 'sku_code' = pg_temp.c('newest'), pg_temp.c('newest');
insert into t_res (test, ok, detail) select 'S3 pagination has no overlap and a stable total',
  (public.shop_catalog(p_limit => 5, p_offset => 0) ->> 'total') = (public.shop_catalog(p_limit => 5, p_offset => 5) ->> 'total')
  and public.shop_catalog(p_limit => 5, p_offset => 0) -> 'items' -> 0 ->> 'sku_code' <> public.shop_catalog(p_limit => 5, p_offset => 5) -> 'items' -> 0 ->> 'sku_code', null;
insert into t_res (test, ok, detail) select 'S3 limit is capped at 60', jsonb_array_length(public.shop_catalog(p_limit => 100000) -> 'items') = 60, null;
insert into t_res (test, ok, detail) select 'S3 facets: category counts add up', (select sum((c ->> 'count')::int) from jsonb_array_elements(public.shop_facets() -> 'categories') c) = (public.shop_catalog() ->> 'total')::int, null;
insert into t_res (test, ok, detail) select 'S3 facets: brands listed', jsonb_array_length(public.shop_facets() -> 'brands') >= 5, null;
insert into t_res (test, ok, detail) select 'S3 product detail', (public.shop_product('FG-000001') ->> 'price')::numeric = 320 and public.shop_product('FG-000001') ->> 'name' is not null, public.shop_product('FG-000001') ->> 'name';
insert into t_res (test, ok, detail) select 'S3 product detail has related products', jsonb_array_length(public.shop_product('FG-000001') -> 'related') > 0, null;
insert into t_res (test, ok, detail) select 'S3 inactive product has no detail page', public.shop_product('FG-000010') is null, null;
insert into t_res (test, ok, detail) select 'S3 unknown product has no detail page', public.shop_product('nope') is null, null;
insert into t_res (test, ok, detail) select 'S3 home: new arrivals filled, best sellers empty until orders exist',
  jsonb_array_length(public.shop_home() -> 'newest') = 8 and jsonb_array_length(public.shop_home() -> 'popular') = 0 and jsonb_array_length(public.shop_home() -> 'featured') = 0, null;
insert into t_res (test, ok, detail) select 'S3 shop starts closed', (public.shop_settings_public() ->> 'shop_open')::boolean = false, null;

-- =========================================================================================== S4 quote (the server prices everything)
insert into t_res (test, ok, detail) select 'S4 a price sent by the client is ignored',
  (public.shop_quote('[{"sku_code":"FG-000001","qty":2,"unit_price":1,"price":1,"line_total":1}]') ->> 'subtotal')::numeric = 640, public.shop_quote('[{"sku_code":"FG-000001","qty":2,"unit_price":1}]')::text;
insert into t_res (test, ok, detail) select 'S4 duplicate lines are merged', (public.shop_quote('[{"sku_code":"FG-000001","qty":1},{"sku_code":"FG-000001","qty":2}]') -> 'lines' -> 0 ->> 'qty')::int = 3
  and jsonb_array_length(public.shop_quote('[{"sku_code":"FG-000001","qty":1},{"sku_code":"FG-000001","qty":2}]') -> 'lines') = 1, null;
insert into t_res (test, ok, detail) select 'S4 bad quantities are rejected: ' || q, (public.shop_quote(('[{"sku_code":"FG-000001","qty":' || q || '}]')::jsonb) ->> 'ok')::boolean = false
  and public.shop_quote(('[{"sku_code":"FG-000001","qty":' || q || '}]')::jsonb) -> 'lines' -> 0 ->> 'problem' = 'bad_qty', null from unnest(array['0', '-1', '100', '"abc"', '1.5', 'null']) q;
insert into t_res (test, ok, detail) select 'S4 unknown / inactive / hidden SKUs are not orderable', (public.shop_quote('[{"sku_code":"NOPE","qty":1}]') -> 'lines' -> 0 ->> 'problem') = 'not_found'
  and (public.shop_quote('[{"sku_code":"FG-000010","qty":1}]') -> 'lines' -> 0 ->> 'problem') = 'not_found'
  and (public.shop_quote('[{"sku_code":"FG-000011","qty":1}]') -> 'lines' -> 0 ->> 'problem') = 'not_found', null;
select pg_temp.err_like('S4 empty cart', $q$select public.shop_quote('[]')$q$, '%CART_EMPTY%');
select pg_temp.err_like('S4 not a list', $q$select public.shop_quote('{"a":1}')$q$, '%CART_EMPTY%');
select pg_temp.err_like('S4 too many lines', $q$select public.shop_quote((select jsonb_agg(jsonb_build_object('sku_code', 'FG-' || lpad(g::text, 6, '0'), 'qty', 1)) from generate_series(1, 41) g))$q$, '%CART_TOO_LARGE%');
insert into t_res (test, ok, detail) select 'S4 quote with a cost never leaks it', public.shop_quote('[{"sku_code":"FG-000001","qty":1}]')::text !~* 'cost', null;
-- staff configure shipping
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_save_settings('{"shipping_fee": 50, "free_shipping_min": 1000, "pickup_enabled": false}');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S4 delivery fee applied below the free-shipping amount', (public.shop_quote('[{"sku_code":"FG-000001","qty":2}]', 'delivery') ->> 'shipping_fee')::numeric = 50
  and (public.shop_quote('[{"sku_code":"FG-000001","qty":2}]', 'delivery') ->> 'total')::numeric = 690, public.shop_quote('[{"sku_code":"FG-000001","qty":2}]')::text;
insert into t_res (test, ok, detail) select 'S4 free shipping at the threshold', (public.shop_quote('[{"sku_code":"FG-000001","qty":4}]', 'delivery') ->> 'shipping_fee')::numeric = 0
  and (public.shop_quote('[{"sku_code":"FG-000001","qty":4}]', 'delivery') ->> 'total')::numeric = 1280, null;
insert into t_res (test, ok, detail) select 'S4 pickup not offered until enabled', (public.shop_quote('[{"sku_code":"FG-000001","qty":2}]', 'pickup') ->> 'ok')::boolean = false
  and public.shop_quote('[{"sku_code":"FG-000001","qty":2}]', 'pickup') -> 'problems' -> 0 ->> 'problem' = 'pickup_off', null;
insert into t_res (test, ok, detail) select 'S4 unknown fulfilment', (public.shop_quote('[{"sku_code":"FG-000001","qty":2}]', 'drone') ->> 'ok')::boolean = false, null;
-- availability and per-order limits (staff set them)
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_save_content('FG-000002', '{"available": false}');
select public.shop_admin_save_content('FG-000003', '{"max_qty": 2}');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S4 sold-out SKU cannot be ordered', public.shop_quote('[{"sku_code":"FG-000002","qty":1}]') -> 'lines' -> 0 ->> 'problem' = 'sold_out'
  and (public.shop_quote('[{"sku_code":"FG-000002","qty":1}]') ->> 'ok')::boolean = false, null;
insert into t_res (test, ok, detail) select 'S4 sold-out SKU is still listed (as sold out)', (public.shop_catalog('FG-000002') -> 'items' -> 0 ->> 'available')::boolean = false, null;
insert into t_res (test, ok, detail) select 'S4 per-order limit', public.shop_quote('[{"sku_code":"FG-000003","qty":3}]') -> 'lines' -> 0 ->> 'problem' = 'over_limit'
  and (public.shop_quote('[{"sku_code":"FG-000003","qty":2}]') ->> 'ok')::boolean = true, null;

-- =========================================================================================== S5 placing orders (member A)
select pg_temp.err_like('S5 shop closed (staff have not opened it)', $q$select public.shop_place_order('key-closed-0001', '[{"sku_code":"FG-000001","qty":2}]', 'delivery', 'Somchai', '0812345678', '99 Test Road Bangkok 10110', null)$q$, '%SHOP_CLOSED%');
-- an active bank account (wallet migration) also counts as a way to get paid: switch the banks off to test "no payment account" at all
reset role;
do $$ begin if to_regclass('public.finance_bank_accounts') is not null then update public.finance_bank_accounts set active = false; end if; end $$;
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_save_settings('{"shop_open": true}');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S5 open but no payment account: still reported closed', (public.shop_settings_public() ->> 'shop_open')::boolean = false, null;
select pg_temp.err_like('S5 no payment account', $q$select public.shop_place_order('key-noacct-0001', '[{"sku_code":"FG-000001","qty":2}]', 'delivery', 'Somchai', '0812345678', '99 Test Road Bangkok 10110', null)$q$, '%NO_PAYMENT_ACCOUNT%');
-- the shop's payment account (a valid PromptPay QR with a made-up number; rolled back)
reset role;
insert into t_ctx select 'qr', b || public.finance_crc16(b) from (select pg_temp.tlv('00', '01') || pg_temp.tlv('01', '11') ||
  pg_temp.tlv('29', pg_temp.tlv('00', 'A000000677010111') || pg_temp.tlv('01', '0066800000000')) || pg_temp.tlv('53', '764') || pg_temp.tlv('58', 'TH') || pg_temp.tlv('59', 'TEST SHOP') || '6304' as b) x;
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_save_payment_account(pg_temp.c('qr'), 'Test shop account', true);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S5 shop is open once an account exists', (public.shop_settings_public() ->> 'shop_open')::boolean = true, null;
select pg_temp.err_like('S5 invalid idempotency key', $q$select public.shop_place_order('x', '[{"sku_code":"FG-000001","qty":2}]', 'delivery', 'Somchai', '0812345678', '99 Test Road Bangkok 10110', null)$q$, '%INVALID_KEY%');
select pg_temp.err_like('S5 invalid phone', $q$select public.shop_place_order('key-phone-0001', '[{"sku_code":"FG-000001","qty":2}]', 'delivery', 'Somchai', '12345', '99 Test Road Bangkok 10110', null)$q$, '%INVALID_PHONE%');
select pg_temp.err_like('S5 delivery needs an address', $q$select public.shop_place_order('key-addr-00001', '[{"sku_code":"FG-000001","qty":2}]', 'delivery', 'Somchai', '0812345678', 'short', null)$q$, '%INVALID_ADDRESS%');
select pg_temp.err_like('S5 name required', $q$select public.shop_place_order('key-name-00001', '[{"sku_code":"FG-000001","qty":2}]', 'delivery', '  ', '0812345678', '99 Test Road Bangkok 10110', null)$q$, '%INVALID_NAME%');
select pg_temp.err_like('S5 sold-out item blocks the order', $q$select public.shop_place_order('key-sold-00001', '[{"sku_code":"FG-000002","qty":1}]', 'delivery', 'Somchai', '0812345678', '99 Test Road Bangkok 10110', null)$q$, '%CART_INVALID%');
select pg_temp.err_like('S5 price changed since the customer looked', $q$select public.shop_place_order('key-price-00001', '[{"sku_code":"FG-000001","qty":2}]', 'delivery', 'Somchai', '0812345678', '99 Test Road Bangkok 10110', null, 1)$q$, '%PRICE_CHANGED%');
insert into t_ctx select 'oA1', public.shop_place_order('key-order-A001', '[{"sku_code":"FG-000001","qty":2},{"sku_code":"FG-000020","qty":1}]', 'delivery', 'Somchai', '081-234-5678', '99 Test Road Bangkok 10110', 'leave at the door', 1010)::text;
insert into t_res (test, ok, detail) select 'S5 order created with server totals (2x320 + 1x320 + 50 shipping = 1010)', ((v::jsonb) -> 'order' ->> 'total')::numeric = 1010 and ((v::jsonb) -> 'order' ->> 'subtotal')::numeric = 960 and ((v::jsonb) -> 'order' ->> 'shipping_fee')::numeric = 50, v from t_ctx where k = 'oA1';
insert into t_ctx select 'oA1id', (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'oA1';
insert into t_res (test, ok, detail) select 'S5 new order starts as new / unpaid', (v::jsonb) -> 'order' ->> 'status' = 'new' and ((v::jsonb) -> 'order' -> 'invoice' ->> 'status_code')::int = 0, null from t_ctx where k = 'oA1';
insert into t_res (test, ok, detail) select 'S5 order number SO-YYYYMM-#####', (v::jsonb) -> 'order' ->> 'order_no' ~ '^SO-[0-9]{6}-[0-9]{5}$', (v::jsonb) -> 'order' ->> 'order_no' from t_ctx where k = 'oA1';
insert into t_res (test, ok, detail) select 'S5 phone normalised to digits', (v::jsonb) -> 'order' ->> 'contact_phone' = '0812345678', null from t_ctx where k = 'oA1';
insert into t_res (test, ok, detail) select 'S5 two item lines snapshotted', jsonb_array_length((v::jsonb) -> 'order' -> 'items') = 2, null from t_ctx where k = 'oA1';
-- idempotency: a retry (double click, network retry) returns the same order and creates nothing new
insert into t_ctx select 'oA1r', public.shop_place_order('key-order-A001', '[{"sku_code":"FG-000020","qty":1},{"sku_code":"FG-000001","qty":2}]', 'delivery', 'Somchai', '081-234-5678', '99 Test Road Bangkok 10110', 'leave at the door', 1010)::text;
insert into t_res (test, ok, detail) select 'S5 retry returns the same order', ((select v::jsonb from t_ctx where k = 'oA1r') ->> 'replay')::boolean and (select v::jsonb -> 'order' ->> 'id' from t_ctx where k = 'oA1r') = (select v::jsonb -> 'order' ->> 'id' from t_ctx where k = 'oA1'), null;
select pg_temp.err_like('S5 same key with a different cart is refused', $q$select public.shop_place_order('key-order-A001', '[{"sku_code":"FG-000001","qty":9}]', 'delivery', 'Somchai', '081-234-5678', '99 Test Road Bangkok 10110', 'leave at the door')$q$, '%KEY_REUSED%');
reset role;
insert into t_res (test, ok, detail) select 'S5 exactly one order and one invoice for that checkout', (select count(*) from public.shop_orders where idempotency_key = 'key-order-A001') = 1
  and (select count(*) from public.finance_invoices where source_ref = (select v::jsonb -> 'order' ->> 'order_no' from t_ctx where k = 'oA1')) = 1, null;
insert into t_res (test, ok, detail) select 'S5 invoice amount = order total, linked by order number', (select i.amount from public.finance_invoices i join public.shop_orders o on o.invoice_id = i.id where o.idempotency_key = 'key-order-A001') = 1010, null;
insert into t_res (test, ok, detail) select 'S5 a finance customer was linked to member A', (select count(*) from public.finance_customers where profile_id = pg_temp.c('A')::uuid) = 1, (select code from public.finance_customers where profile_id = pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S5 audit events written (order + invoice)', (select count(*) from public.shop_events where action = 'order.place') = 1
  and (select count(*) from public.finance_events where action = 'invoice.issue' and detail ->> 'source' = 'shop') = 1, null;
-- an order keeps the price it was sold at
update public.sku_registry set selling_price = 999 where sku_code = 'FG-000001';
insert into t_res (test, ok, detail) select 'S5 later price change does not touch the placed order', (select (public.shop_order_json(id) -> 'items' -> 0 ->> 'unit_price')::numeric from public.shop_orders where idempotency_key = 'key-order-A001') = 320, null;
update public.sku_registry set selling_price = 320 where sku_code = 'FG-000001';
-- pickup order
update public.shop_settings set pickup_enabled = true;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'oA2', public.shop_place_order('key-order-A002', '[{"sku_code":"FG-000123","qty":3}]', 'pickup', 'Somchai', '0812345678', 'ignored for pickup', null, 120)::text;
insert into t_res (test, ok, detail) select 'S5 pickup order: no address, no shipping', (v::jsonb) -> 'order' ->> 'delivery_address' is null and ((v::jsonb) -> 'order' ->> 'shipping_fee')::numeric = 0 and ((v::jsonb) -> 'order' ->> 'total')::numeric = 120, v from t_ctx where k = 'oA2';
-- abuse guard: at most 10 orders per hour
do $$ begin for i in 1..8 loop perform public.shop_place_order('bulk-key-000' || i, '[{"sku_code":"FG-000123","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null); end loop; end $$;
select pg_temp.err_like('S5 the 11th order within an hour is refused', $q$select public.shop_place_order('bulk-key-0009', '[{"sku_code":"FG-000123","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null)$q$, '%TOO_MANY_ORDERS%');
insert into t_ctx select 'oA3', id::text from public.shop_orders where idempotency_key = 'bulk-key-0008';

-- =========================================================================================== S6 payment pipeline (A pays, staff verify)
insert into t_ctx select 'invA1', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'oA1';
insert into t_ctx select 'req', public.finance_request_payment(pg_temp.c('invA1')::uuid)::text;
reset role;
insert into t_res (test, ok, detail) select 'S6 QR carries the exact order amount (tag 54 = 1010.00)', (select val from public.finance_qr_fields((v::jsonb) ->> 'qr_payload') where tag = '54') = '1010.00', (select val from public.finance_qr_fields((v::jsonb) ->> 'qr_payload') where tag = '54') from t_ctx where k = 'req';
insert into t_res (test, ok, detail) select 'S6 QR has a valid checksum and the shop account', public.finance_crc16(left((v::jsonb) ->> 'qr_payload', length((v::jsonb) ->> 'qr_payload') - 4)) = right((v::jsonb) ->> 'qr_payload', 4)
  and public.finance_qr_describe((v::jsonb) ->> 'qr_payload') ->> 'target' = '0066800000000', null from t_ctx where k = 'req';
insert into t_res (test, ok, detail) select 'S6 QR is dynamic (point of initiation 12)', (select val from public.finance_qr_fields((v::jsonb) ->> 'qr_payload') where tag = '01') = '12', null from t_ctx where k = 'req';
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S6 order shows awaiting payment (1) after the QR', (public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'status_code')::int = 1, public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'status';
insert into t_ctx select 'ev', public.finance_submit_evidence(pg_temp.c('invA1')::uuid, pg_temp.c('A') || '/slip-1.jpg', repeat('a', 64), 'image/jpeg', 1010, now(), 'KBank', 'REF-1')::text;
insert into t_res (test, ok, detail) select 'S6 uploading a slip makes it pending verification (3), NOT paid', (public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'status_code')::int = 3
  and (public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'paid')::numeric = 0 and (public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'outstanding')::numeric = 1010, public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'status';
select pg_temp.err_like('S6 the same slip cannot be submitted twice', format($q$select public.finance_submit_evidence(%L, %L, repeat('a', 64), 'image/jpeg', 1010, now(), 'KBank', 'REF-2')$q$, pg_temp.c('invA1'), pg_temp.c('A') || '/slip-1b.jpg'), '%already submitted%');
select pg_temp.err_like('S6 slip must live in the member''s own folder', format($q$select public.finance_submit_evidence(%L, %L, repeat('b', 64), 'image/jpeg', 1010, now(), 'KBank', 'REF-3')$q$, pg_temp.c('invA1'), pg_temp.c('B') || '/slip-x.jpg'), '%Invalid file%');
select pg_temp.err_like('S6 member cannot write receipts', $q$insert into public.finance_receipts (receipt_no) values ('RC-X')$q$, '%permission denied%');
select pg_temp.err_like('S6 member cannot edit the invoice', $q$update public.finance_invoices set status = 'cancelled'$q$, '%permission denied%');
select pg_temp.err_like('S6 member cannot verify their own payment', format($q$select public.finance_verify_evidence(%L, 1010, 'BANKREF-FAKE', now(), null, 'staff')$q$, pg_temp.c('ev')), '%not allowed%');
select pg_temp.err_like('S6 cannot cancel while a slip is waiting', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oA1id')), '%SLIP_PENDING%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_verify_evidence(pg_temp.c('ev')::uuid, 1010, 'BANKREF-0001', now(), null, 'staff');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S6 staff verification marks the order paid (5)', (public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'status_code')::int = 5 and (public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'outstanding')::numeric = 0, public.shop_my_order(pg_temp.c('oA1id')::uuid) -> 'invoice' ->> 'status';
select pg_temp.err_like('S6 a paid order cannot be cancelled by the member', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oA1id')), '%PAYMENT_RECORDED%');
insert into t_res (test, ok, detail) select 'S6 payment history is visible to the owner (receipt)', (select count(*) from public.finance_receipts) = 1, null;

-- =========================================================================================== S7 customer isolation (member B)
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'S7 B has no orders', (public.shop_my_orders() ->> 'total')::int = 0, null;
select pg_temp.err_like('S7 B cannot open A''s order', format($q$select public.shop_my_order(%L)$q$, pg_temp.c('oA1id')), '%Order not found%');
select pg_temp.err_like('S7 B cannot cancel A''s order', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oA1id')), '%Order not found%');
insert into t_res (test, ok, detail) select 'S7 B cannot read A''s rows directly', (select count(*) from public.shop_orders) = 0 and (select count(*) from public.shop_order_items) = 0
  and (select count(*) from public.finance_invoices) = 0 and (select count(*) from public.finance_receipts) = 0 and (select count(*) from public.finance_payment_evidence) = 0
  and (select count(*) from public.finance_payment_requests) = 0 and (select count(*) from public.finance_customers) = 0 and (select count(*) from public.shop_events) = 0, null;
insert into t_res (test, ok, detail) select 'S7 B gets nothing for A''s invoice state', public.finance_invoice_state(pg_temp.c('invA1')::uuid) is null, null;
select pg_temp.err_like('S7 B cannot create a QR for A''s invoice', format($q$select public.finance_request_payment(%L)$q$, pg_temp.c('invA1')), '%Invoice not found%');
select pg_temp.err_like('S7 B cannot attach a slip to A''s invoice', format($q$select public.finance_submit_evidence(%L, %L, repeat('c', 64), 'image/jpeg', 1, now(), null, null)$q$, pg_temp.c('invA1'), pg_temp.c('B') || '/s.jpg'), '%Invoice not found%');
select pg_temp.err_like('S7 B cannot list invoices of others (only own)', $q$select 1 / (select count(*) from jsonb_array_elements(public.finance_my_invoices()))$q$, '%division by zero%');
insert into t_ctx select 'oB1', public.shop_place_order('key-order-B001', '[{"sku_code":"FG-000020","qty":1}]', 'delivery', 'Malee', '0891112222', '5 Another Road Chiang Mai 50000', null, 370)::text;
insert into t_res (test, ok, detail) select 'S7 B can place their own order', ((v::jsonb) -> 'order' ->> 'total')::numeric = 370, v from t_ctx where k = 'oB1';
insert into t_ctx select 'oB1id', (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'oB1';
insert into t_res (test, ok, detail) select 'S7 B sees exactly their own order', (public.shop_my_orders() ->> 'total')::int = 1, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S7 A does not see B''s order', not (public.shop_my_orders('all', 50, 0)::text like '%' || (select v::jsonb -> 'order' ->> 'order_no' from t_ctx where k = 'oB1') || '%'), null;
select pg_temp.err_like('S7 A cannot open B''s order', format($q$select public.shop_my_order(%L)$q$, pg_temp.c('oB1id')), '%Order not found%');

-- =========================================================================================== S8 staff workflow
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'S8 staff list all orders', (public.shop_admin_orders() ->> 'total')::int >= 11, public.shop_admin_orders() ->> 'total';
insert into t_res (test, ok, detail) select 'S8 staff search by order number', (public.shop_admin_orders(p_search => (select v::jsonb -> 'order' ->> 'order_no' from t_ctx where k = 'oB1')) ->> 'total')::int = 1, null;
insert into t_res (test, ok, detail) select 'S8 staff filter by status', (public.shop_admin_orders('new') ->> 'total')::int >= 11 and (public.shop_admin_orders('shipped') ->> 'total')::int = 0, null;
insert into t_res (test, ok, detail) select 'S8 staff see customer contact in the order', public.shop_admin_order(pg_temp.c('oA1id')::uuid) -> 'customer' ->> 'name' is not null, public.shop_admin_order(pg_temp.c('oA1id')::uuid) -> 'customer'::text;
select pg_temp.err_like('S8 cannot skip steps (new -> preparing)', format($q$select public.shop_admin_set_status(%L, 'preparing')$q$, pg_temp.c('oA1id')), '%cannot become%');
select public.shop_admin_set_status(pg_temp.c('oA1id')::uuid, 'confirmed');
select public.shop_admin_set_status(pg_temp.c('oA1id')::uuid, 'preparing');
select public.shop_admin_set_status(pg_temp.c('oA1id')::uuid, 'packed');
select pg_temp.err_like('S8 a delivery order cannot become "ready" (pickup only)', format($q$select public.shop_admin_set_status(%L, 'ready')$q$, pg_temp.c('oA1id')), '%cannot become%');
select public.shop_admin_set_status(pg_temp.c('oA1id')::uuid, 'shipped', 'Kerry TH0123456789');
select public.shop_admin_set_status(pg_temp.c('oA1id')::uuid, 'completed');
insert into t_res (test, ok, detail) select 'S8 paid order walked through to completed', (select status from public.shop_orders where id = pg_temp.c('oA1id')::uuid) = 'completed', null;
select pg_temp.err_like('S8 a completed order cannot be cancelled', format($q$select public.shop_admin_set_status(%L, 'cancelled', 'x')$q$, pg_temp.c('oA1id')), '%already completed%');
-- unpaid order B1: confirm is fine, production needs payment or a recorded reason
select public.shop_admin_set_status(pg_temp.c('oB1id')::uuid, 'confirmed');
select pg_temp.err_like('S8 unpaid order cannot go to preparing', format($q$select public.shop_admin_set_status(%L, 'preparing')$q$, pg_temp.c('oB1id')), '%PAYMENT_REQUIRED%');
select public.shop_admin_set_status(pg_temp.c('oB1id')::uuid, 'preparing', 'We are packing it', 'Customer is a regular, pays on delivery');
insert into t_res (test, ok, detail) select 'S8 payment override is recorded in the internal log', (select count(*) from public.shop_events where action = 'order.status' and (detail ->> 'payment_override')::boolean and detail ->> 'override_reason' like 'Customer is a regular%') = 1, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'S8 the customer sees the message but never the internal reason', public.shop_my_order(pg_temp.c('oB1id')::uuid) ->> 'status_note' = 'We are packing it'
  and public.shop_my_order(pg_temp.c('oB1id')::uuid)::text !~ 'regular|override|pays on delivery', null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('S8 staff cancel needs a reason', format($q$select public.shop_admin_set_status(%L, 'cancelled')$q$, pg_temp.c('oB1id')), '%reason is required%');
select public.shop_admin_set_status(pg_temp.c('oB1id')::uuid, 'cancelled', 'Customer asked to cancel');
reset role;
insert into t_res (test, ok, detail) select 'S8 cancelling an order cancels its invoice (8) and open QR requests', (select status from public.finance_invoices where id = (select invoice_id from public.shop_orders where id = pg_temp.c('oB1id')::uuid)) = 'cancelled'
  and (select status_code from (select (public.finance_invoice_state_raw(invoice_id) ->> 'status_code')::int status_code from public.shop_orders where id = pg_temp.c('oB1id')::uuid) x) = 8, null;
-- customer self-service cancel: only a new, unpaid order
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S8 member cancels a new unpaid order', public.shop_cancel_my_order(pg_temp.c('oA3')::uuid, 'changed my mind') ->> 'status' = 'cancelled', null;
select pg_temp.err_like('S8 cancelling twice is refused', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oA3')), '%already cancelled%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_set_status((select id from public.shop_orders where idempotency_key = 'bulk-key-0001'), 'confirmed');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('S8 member cannot cancel once the shop has confirmed', format($q$select public.shop_cancel_my_order(%L)$q$, (select id from public.shop_orders where idempotency_key = 'bulk-key-0001')), '%ORDER_IN_PROGRESS%');
insert into t_res (test, ok, detail) select 'S8 customer filters: done / cancelled / unpaid',
  (public.shop_my_orders('done') ->> 'total')::int = 1 and (public.shop_my_orders('cancelled') ->> 'total')::int = 1 and (public.shop_my_orders('unpaid') ->> 'total')::int >= 8
  and (public.shop_my_orders('to_ship') ->> 'total')::int = 0 and (public.shop_my_orders('to_receive') ->> 'total')::int = 0,
  (public.shop_my_orders('done') ->> 'total') || '/' || (public.shop_my_orders('cancelled') ->> 'total') || '/' || (public.shop_my_orders('unpaid') ->> 'total');

-- =========================================================================================== S9 immutability
reset role;
select pg_temp.err_like('S9 an order total cannot be edited', format($q$update public.shop_orders set total = 1, subtotal = 1, shipping_fee = 0 where id = %L$q$, pg_temp.c('oA1id')), '%cannot be changed%');
select pg_temp.err_like('S9 an order cannot change owner', format($q$update public.shop_orders set profile_id = %L where id = %L$q$, pg_temp.c('B'), pg_temp.c('oA1id')), '%cannot be changed%');
select pg_temp.err_like('S9 orders are never deleted', format($q$delete from public.shop_orders where id = %L$q$, pg_temp.c('oA1id')), '%never deleted%');
select pg_temp.err_like('S9 order lines are never edited', $q$update public.shop_order_items set qty = 99$q$, '%never deleted or edited%');
select pg_temp.err_like('S9 order lines are never deleted', $q$delete from public.shop_order_items$q$, '%never deleted or edited%');
select pg_temp.err_like('S9 the audit trail is append-only', $q$update public.shop_events set action = 'x'$q$, '%never deleted or edited%');
select pg_temp.err_like('S9 the audit trail cannot be erased', $q$delete from public.shop_events$q$, '%never deleted or edited%');
insert into t_res (test, ok, detail) select 'S9 order amounts always add up', (select bool_and(total = subtotal - discount + shipping_fee) from public.shop_orders), null;
insert into t_res (test, ok, detail) select 'S9 order total = sum of its lines + shipping', (select bool_and(o.subtotal = (select sum(line_total) from public.shop_order_items i where i.order_id = o.id)) from public.shop_orders o), null;
insert into t_res (test, ok, detail) select 'S9 invoice amount = order total for every order', (select bool_and(i.amount = o.total) from public.shop_orders o join public.finance_invoices i on i.id = o.invoice_id), null;

-- =========================================================================================== S10 storefront content, categories, DEV APP
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_save_content('FG-000001', '{"description_th":"รสผลไม้รวม","description_en":"Mixed fruit","image_paths":["FG-000001/main.webp","FG-000001/side.webp"],"featured":true,"badge":"ขายดี","family":"INFY 6000","specs":[{"label":"ขนาด","value":"6000 คำ"}]}');
select public.shop_admin_save_content('FG-000020', '{"family":"INFY 6000"}');
select pg_temp.err_like('S10 picture of another SKU is refused', $q$select public.shop_admin_save_content('FG-000001', '{"image_paths":["FG-000002/x.webp"]}')$q$, '%Invalid picture%');
select pg_temp.err_like('S10 path tricks are refused', $q$select public.shop_admin_save_content('FG-000001', '{"image_paths":["FG-000001/../x.webp"]}')$q$, '%Invalid picture%');
select pg_temp.err_like('S10 more than 6 pictures refused', $q$select public.shop_admin_save_content('FG-000001', '{"image_paths":["FG-000001/1.webp","FG-000001/2.webp","FG-000001/3.webp","FG-000001/4.webp","FG-000001/5.webp","FG-000001/6.webp","FG-000001/7.webp"]}')$q$, '%At most 6%');
select pg_temp.err_like('S10 unknown SKU refused', $q$select public.shop_admin_save_content('NOPE', '{"featured":true}')$q$, '%Unknown product%');
select pg_temp.err_like('S10 raw-material SKU is not a shop product', format($q$select public.shop_admin_save_content(%L, '{"featured":true}')$q$, public.sku_format('RM', 990001)), '%Unknown product%');
select pg_temp.err_like('S10 negative shipping refused', $q$select public.shop_admin_save_settings('{"shipping_fee": -5}')$q$, '%shipping fee%');
select public.shop_admin_save_category('Puff', '{"name_th":"พอตใช้แล้วทิ้ง","name_en":"Disposable pods","sort_order":1}');
select pg_temp.err_like('S10 category picture path validated', $q$select public.shop_admin_save_category('Puff', '{"image_path":"../x.png"}')$q$, '%Invalid picture%');
insert into storage.objects (bucket_id, name) values ('shop-products', 'FG-000001/main.webp');
insert into t_res (test, ok, detail) select 'S10 staff can upload product pictures', true, null;
insert into t_res (test, ok, detail) select 'S10 admin product list includes hidden ones with the reason', (select (i ->> 'why_hidden') from jsonb_array_elements(public.shop_admin_products('FG-000010') -> 'items') i limit 1) = 'inactive'
  and (select (i ->> 'why_hidden') from jsonb_array_elements(public.shop_admin_products('FG-000011') -> 'items') i limit 1) = 'hidden_by_staff', null;
insert into t_res (test, ok, detail) select 'S10 admin filter no_image', (public.shop_admin_products(p_filter => 'no_image') ->> 'total')::int > 100, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S10 product detail: pictures, description, spec, badge', public.shop_product('FG-000001') ->> 'image_url' like 'https://%/shop-products/FG-000001/main.webp'
  and jsonb_array_length(public.shop_product('FG-000001') -> 'image_urls') = 2 and public.shop_product('FG-000001') ->> 'description_th' = 'รสผลไม้รวม'
  and public.shop_product('FG-000001') -> 'specs' -> 0 ->> 'value' = '6000 คำ' and public.shop_product('FG-000001') ->> 'badge' = 'ขายดี', public.shop_product('FG-000001') ->> 'image_url';
insert into t_res (test, ok, detail) select 'S10 product options: same family appear as siblings', public.shop_product('FG-000001') -> 'siblings' -> 0 ->> 'sku_code' = 'FG-000020', null;
insert into t_res (test, ok, detail) select 'S10 featured SKU appears on the home page', public.shop_home() -> 'featured' -> 0 ->> 'sku_code' = 'FG-000001', null;
insert into t_res (test, ok, detail) select 'S10 best sellers now come from real orders', jsonb_array_length(public.shop_home() -> 'popular') > 0 and public.shop_home() -> 'popular' -> 0 ->> 'sku_code' is not null, public.shop_home() -> 'popular' -> 0 ->> 'sku_code';
insert into t_res (test, ok, detail) select 'S10 category display names reach the shop', (select c ->> 'name_th' from jsonb_array_elements(public.shop_facets() -> 'categories') c where c ->> 'code' = 'Puff') = 'พอตใช้แล้วทิ้ง'
  and (public.shop_facets() -> 'categories' -> 0 ->> 'code') = 'Puff', null;
insert into t_res (test, ok, detail) select 'S10 category tile falls back to a product picture', (select c ->> 'image_url' from jsonb_array_elements(public.shop_facets() -> 'categories') c where c ->> 'code' = 'Puff') like '%FG-000001/main.webp', null;
-- DEV APP Customer data source
insert into t_ctx select 'dq', public.customer_app_query('db:sku_catalog', array['sku_code', 'name_full', 'price', 'image_url', 'category', 'available', 'featured', 'badge'],
  '[{"field":"sku_code","op":"eq","value":"FG-000001"}]', null, 5, null, null)::text;
insert into t_res (test, ok, detail) select 'S10 DEV APP source returns the new columns', (v::jsonb) -> 'rows' -> 0 ->> 'image_url' like '%FG-000001/main.webp' and (v::jsonb) -> 'rows' -> 0 ->> 'category' = 'Puff', left(v, 200) from t_ctx where k = 'dq';
insert into t_res (test, ok, detail) select 'S10 DEV APP source hides inactive and staff-hidden SKUs', jsonb_array_length(public.customer_app_query('db:sku_catalog', array['sku_code'], '[{"field":"sku_code","op":"eq","value":"FG-000010"}]', null, 5, null, null) -> 'rows') = 0
  and jsonb_array_length(public.customer_app_query('db:sku_catalog', array['sku_code'], '[{"field":"sku_code","op":"eq","value":"FG-000011"}]', null, 5, null, null) -> 'rows') = 0, null;
insert into t_res (test, ok, detail) select 'S10 DEV APP source never offers cost fields', not exists (select 1 from jsonb_array_elements(public.customer_app_query('db:sku_catalog', array['sku_code'], '[]', null, 1, null, null) -> 'columns') c where c ->> 'key' ~* 'cost|friend|wholesale'), null;
select pg_temp.err_like('S10 DEV APP source rejects an unknown column', $q$select public.customer_app_query('db:sku_catalog', array['cost_price'], '[]', null, 1, null, null)$q$, '%Unknown%');
-- layout validation accepts the new cart page and still rejects unknown pages
reset role;
insert into t_ctx select 'cfg', jsonb_build_object('schemaVersion', 1, 'theme', '{}'::jsonb, 'brand', '{}'::jsonb, 'nav', '[{"key":"home"}]'::jsonb, 'home', '[]'::jsonb,
  'onboarding', '{"slides":[]}'::jsonb, 'pages', jsonb_build_object('cart', jsonb_build_array(jsonb_build_object('id', 'c1', 'type', 'cartCore', 'props', '{}'::jsonb))))::text;
insert into t_res (test, ok, detail) select 'S10 layout validator accepts a cart page with its core block', public.customer_app_validate(v::jsonb) is null, public.customer_app_validate(v::jsonb) from t_ctx where k = 'cfg';
insert into t_res (test, ok, detail) select 'S10 layout validator requires the cart core block', public.customer_app_validate(jsonb_set(v::jsonb, '{pages,cart}', '[]'::jsonb)) like '%must keep its built-in block%', public.customer_app_validate(jsonb_set(v::jsonb, '{pages,cart}', '[]'::jsonb)) from t_ctx where k = 'cfg';
insert into t_res (test, ok, detail) select 'S10 layout validator still rejects unknown pages', public.customer_app_validate(jsonb_set(v::jsonb, '{pages,foo}', '[]'::jsonb)) like 'unknown page foo', null from t_ctx where k = 'cfg';
insert into t_res (test, ok, detail) select 'S10 existing layouts (no cart page) still validate', public.customer_app_validate(((v::jsonb) - 'pages')) is null, public.customer_app_validate(((v::jsonb) - 'pages')) from t_ctx where k = 'cfg';

-- =========================================================================================== S11 finance refactor keeps its behaviour
reset role; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'S11 finance_invoice_state (staff) equals the internal state for every invoice',
  (select bool_and(public.finance_invoice_state(id) = public.finance_invoice_state_raw(id)) from public.finance_invoices), (select count(*) from public.finance_invoices) || ' invoices';
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'S11 member sees state only for their own invoices', (select count(*) from public.finance_invoices) > 0
  and public.finance_invoice_state(pg_temp.c('invA1')::uuid) is not null and public.finance_invoice_state((select invoice_id from public.shop_orders where id = pg_temp.c('oB1id')::uuid)) is null, null;
insert into t_res (test, ok, detail) select 'S11 finance_my_invoices tells which order an invoice bills', (select count(*) from jsonb_array_elements(public.finance_my_invoices()) i where i ->> 'source_ref' like 'SO-%') = jsonb_array_length(public.finance_my_invoices()), null;
insert into t_res (test, ok, detail) select 'S11 finance_my_invoices lists the member''s own invoices', jsonb_array_length(public.finance_my_invoices()) >= 10, jsonb_array_length(public.finance_my_invoices())::text;

-- =========================================================================================== result
reset role;
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'SHOP_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
