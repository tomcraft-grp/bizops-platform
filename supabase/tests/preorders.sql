-- Tests for 20261128100000_preorders.sql, run after the migration in ONE transaction that always rolls back (scripts/run-preorders-sql-tests.sh).
-- Real data: S = a real SUPER_ADMIN, A / B / C = real USER profiles (customers), U = a real USER who is never a staff member, the first sellable SKU of the real catalogue and the shop's real payment accounts.
-- Every order, invoice, notice, queue row and setting changed here disappears with the rollback. Time is relative to now (Asia/Bangkok), never hard-coded.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, m ilike p_pat, m); end;
end $$;
create or replace function pg_temp.ok_run(p_test text, p_sql text) returns void language plpgsql as $$
declare m text; begin
  begin execute p_sql; perform pg_temp.chk(p_test, true);
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, false, m); end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into t_ctx values (k, v) on conflict (k) do update set v = excluded.v $$;
-- read / write the tables as the owner whatever role the test is acting as
create or replace function pg_temp.sv(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.sx(p_sql text) returns void language plpgsql security definer as $$ begin execute p_sql; end $$;
-- a slot: the day offset from today (Bangkok) and a wall-clock time
create or replace function pg_temp.sq(off integer, hhmm text) returns timestamptz language sql as $$ select (((now() at time zone 'Asia/Bangkok')::date + off + hhmm::time) at time zone 'Asia/Bangkok') $$;
create or replace function pg_temp.items(n int) returns jsonb language sql as $$ select jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', n)) $$;
-- a pickup order (regular when p_at is null)
create or replace function pg_temp.place(p_key text, p_qty int, p_at timestamptz, p_note text default null, p_f text default 'pickup') returns jsonb language sql as $$
  select public.shop_place_order(p_key, pg_temp.items(p_qty), p_f, 'Test Customer', '0812345678', null, p_note, null, null, null, null, null, null, null, p_at) $$;
-- the internal functions, read as the owner (no client can call them)
create or replace function pg_temp.oj(p_id text) returns jsonb language sql as $$ select pg_temp.sv(format('select public.shop_order_json(%L::uuid)::text', p_id))::jsonb $$;
create or replace function pg_temp.row(p_id text, p_items boolean default false) returns jsonb language sql as $$ select pg_temp.sv(format('select public.preorder_row(%L::uuid, %s)::text', p_id, p_items::text))::jsonb $$;
create or replace function pg_temp.card(p_id text) returns jsonb language sql as $$ select pg_temp.sv(format('select public.line_card_data(%L::uuid)::text', p_id))::jsonb $$;
create or replace function pg_temp.sweep() returns jsonb language sql as $$ select pg_temp.sv('select public.preorder_sweep()::text')::jsonb $$;
-- read an order as its customer (the staff member acting in the test is not the owner)
create or replace function pg_temp.my(p_cust text, p_order text) returns jsonb language plpgsql as $$
declare prev text := current_setting('request.jwt.claims', true); r jsonb;
begin
  perform pg_temp.as_user(pg_temp.c(p_cust)::uuid); r := public.shop_my_order(p_order::uuid); perform set_config('request.jwt.claims', coalesce(prev, ''), true); return r;
end $$;
create or replace function pg_temp.oid(p_res jsonb) returns text language sql as $$ select p_res -> 'order' ->> 'id' $$;
create or replace function pg_temp.notices(p_order text, p_kind text, p_aud text default null) returns integer language sql as $$
  select pg_temp.sv(format('select count(*) from public.preorder_notices where order_id = %L and kind = %L and (%L is null or audience = %L)', p_order, p_kind, p_aud, p_aud))::int $$;
create or replace function pg_temp.status_of(p_order text) returns text language sql as $$ select pg_temp.sv(format('select status from public.shop_orders where id = %L', p_order)) $$;

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('S2', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' and id <> pg_temp.c('S')::uuid order by created_at limit 1));
select pg_temp.put('A', (select id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1));
select pg_temp.put('B', (select id::text from public.profiles where role = 'USER' and status = 'active' and id <> pg_temp.c('A')::uuid order by created_at limit 1));
select pg_temp.put('C', (select id::text from public.profiles where role = 'USER' and status = 'active' and id not in (pg_temp.c('A')::uuid, pg_temp.c('B')::uuid) order by created_at limit 1));
select pg_temp.put('D', (select id::text from public.profiles where role = 'USER' and status = 'active' and id not in (pg_temp.c('A')::uuid, pg_temp.c('B')::uuid, pg_temp.c('C')::uuid) order by created_at limit 1));
select pg_temp.put('U', (select p.id::text from public.profiles p where p.role = 'USER' and p.status = 'active' and p.id not in (pg_temp.c('A')::uuid, pg_temp.c('B')::uuid, pg_temp.c('C')::uuid, pg_temp.c('D')::uuid)
                           and not exists (select 1 from public.shop_orders o where o.profile_id = p.id) order by p.created_at limit 1));
select pg_temp.put('sku', (select sku_code from public.shop_sellable where available and coalesce(max_qty, 99) >= 6 order by sku_seq limit 1));
select pg_temp.chk('F0 fixtures: a super admin, three customers, one non-customer user and a sellable product',
  (select count(*) from t_ctx where k in ('S', 'A', 'B', 'C', 'D', 'U', 'sku') and v is not null) = 7, (select string_agg(k || '=' || coalesce(v, 'NULL'), ',') from t_ctx));
-- the shop is open for pick-up and takes orders without a slip in this transaction (the slip path is covered by the ordering suites)
update public.shop_settings set shop_open = true, pickup_enabled = true, delivery_enabled = true, require_payment_slip = false, shipping_fee = 0, free_shipping_min = null where id;
-- customer A has a LINE account in this transaction (set before any user is acting: a person can never change line_user_id)
update public.profiles set line_user_id = 'U-test-customer-a' where id = pg_temp.c('A')::uuid;
select pg_temp.put('orders_before', (select count(*) from public.shop_orders)::text);
select pg_temp.put('regular_before', (select count(*) from public.shop_orders where order_type = 'regular')::text);

-- ================================================================================================ M. what the migration did
select pg_temp.chk('M1 the feature is OFF and unconfigured after the migration', (select not enabled and configured_at is null from public.preorder_settings where id));
select pg_temp.chk('M1 every order that existed is a regular order without a pickup time', (select count(*) from public.shop_orders where order_type <> 'regular' or pickup_at is not null) = 0);
select pg_temp.chk('M1 the sweep is scheduled every 5 minutes', exists (select 1 from cron.job where jobname = 'preorder-sweep' and schedule = '*/5 * * * *'));
select pg_temp.chk('M1 the LINE events know the three new switches', (select coalesce(bool_and(events ? 'preorder' and events ? 'preorder_staff' and events ? 'preorder_customer'), true) from public.line_settings));
select pg_temp.chk('M1 the outbox accepts the new event', pg_get_constraintdef((select oid from pg_constraint where conname = 'line_outbox_event_check')) like '%preorder%');
select pg_temp.chk('M1 default hours exist for all 7 days', (select jsonb_array_length(weekly_hours) = 7 from public.preorder_settings where id));
select pg_temp.err_like('M1 the order type cannot be changed afterwards', format($q$update public.shop_orders set order_type = 'preorder', pickup_at = now() + interval '3 days' where id = (select id from public.shop_orders order by created_at limit 1)$q$), '%cannot be changed%');
select pg_temp.err_like('M1 a preorder needs a pickup time (constraint)', $q$alter table public.shop_orders drop constraint if exists nothing_here; select 1 where false; update public.shop_orders set pickup_at = now() where id = (select id from public.shop_orders order by created_at limit 1)$q$, '%shop_orders_preorder_chk%');
set local role anon;
select pg_temp.chk('M2 anon can run none of the preorder functions', not has_function_privilege('anon', 'public.preorder_options()', 'execute') and not has_function_privilege('anon', 'public.preorder_admin_dashboard(date)', 'execute')
  and not has_function_privilege('anon', 'public.preorder_prep_set(uuid, integer, boolean)', 'execute'));
reset role;
select pg_temp.chk('M2 the internal helpers are callable by no client',
  not has_function_privilege('authenticated', 'public.preorder_check_slot(timestamptz, integer, uuid, boolean, boolean)', 'execute') and not has_function_privilege('authenticated', 'public.preorder_notify(text, uuid, text, text, jsonb, uuid, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.preorder_sweep()', 'execute') and not has_function_privilege('authenticated', 'public.preorder_row(uuid, boolean)', 'execute'));
select pg_temp.chk('M2 no client can read or write the preorder tables directly',
  not has_table_privilege('authenticated', 'public.preorder_notices', 'select') and not has_table_privilege('authenticated', 'public.preorder_settings', 'update')
  and not has_table_privilege('anon', 'public.preorder_assignments', 'select') and not has_table_privilege('authenticated', 'public.preorder_prep_checks', 'insert'));

-- ================================================================================================ O. while the feature is off
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('O1 the options say the feature is off', (public.preorder_options() ->> 'enabled')::boolean = false);
select pg_temp.chk('O1 the public shop settings say so too', (public.shop_settings_public() ->> 'preorder_enabled')::boolean = false);
select pg_temp.err_like('O1 slots are refused while it is off', format($q$select public.preorder_slots(%L::date, 1)$q$, (now() at time zone 'Asia/Bangkok')::date + 3), 'PREORDER_OFF%');
select pg_temp.err_like('O1 a preorder cannot be placed while it is off', format($q$select pg_temp.place('pre-test-off-1', 1, %L::timestamptz)$q$, pg_temp.sq(3, '10:00')), 'PREORDER_OFF%');
select pg_temp.chk('O2 a regular pick-up order still works (the new parameter is optional)', (pg_temp.place('pre-test-reg-1', 1, null) -> 'order' ->> 'order_type') = 'regular');
select pg_temp.put('R1', pg_temp.oid(pg_temp.place('pre-test-reg-1', 1, null)));
select pg_temp.chk('O2 a regular delivery order still works', (pg_temp.place('pre-test-reg-2', 1, null, null, 'delivery') -> 'order' ->> 'pickup_at') is null);
select pg_temp.put('R2', pg_temp.oid(pg_temp.place('pre-test-reg-2', 1, null, null, 'delivery')));

-- ================================================================================================ S. settings
select pg_temp.err_like('S1 a customer cannot save the settings', $q$select public.preorder_admin_save_settings('{"max_orders_per_slot": 9}'::jsonb)$q$, '%SUPER_ADMIN%');
select pg_temp.err_like('S1 a customer cannot read the settings', $q$select public.preorder_admin_settings()$q$, '%not allowed%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('S2 it cannot be switched on before the hours are saved', $q$select public.preorder_admin_save_settings('{"enabled": true}'::jsonb)$q$, 'PREORDER_NOT_CONFIGURED%');
select pg_temp.err_like('S2 an unknown setting is refused', $q$select public.preorder_admin_save_settings('{"colour": "red"}'::jsonb)$q$, 'INVALID_SETTING%');
select pg_temp.err_like('S2 a slot of 3 minutes is refused', $q$select public.preorder_admin_save_settings('{"slot_minutes": 3}'::jsonb)$q$, 'INVALID_SETTING%');
select pg_temp.err_like('S2 hours for 6 days only are refused', $q$select public.preorder_admin_save_settings('{"weekly_hours": [{"dow":0,"closed":true}]}'::jsonb)$q$, 'INVALID_SETTING%');
select pg_temp.err_like('S2 an opening time after the closing time is refused', $q$select public.preorder_admin_save_settings(jsonb_build_object('weekly_hours',
  (select jsonb_agg(jsonb_build_object('dow', d, 'closed', false, 'open', '18:00', 'close', '09:00')) from generate_series(0, 6) d)))$q$, 'INVALID_SETTING%');
select pg_temp.err_like('S2 two entries for one weekday are refused', $q$select public.preorder_admin_save_settings(jsonb_build_object('weekly_hours',
  (select jsonb_agg(jsonb_build_object('dow', 1, 'closed', false, 'open', '09:00', 'close', '18:00')) from generate_series(0, 6) d)))$q$, 'INVALID_SETTING%');
-- the real configuration of this test: 30-minute slots 09:00-18:00 every day, 2 orders and 8 units per slot, large order from 5 units
select pg_temp.ok_run('S3 a SUPER_ADMIN saves hours, capacity and the rest', $q$select public.preorder_admin_save_settings(jsonb_build_object(
  'weekly_hours', (select jsonb_agg(jsonb_build_object('dow', d, 'closed', false, 'open', '09:00', 'close', '18:00')) from generate_series(0, 6) d),
  'slot_minutes', 30, 'lead_minutes', 120, 'max_advance_days', 14, 'max_orders_per_slot', 2, 'max_units_per_slot', 8, 'change_cutoff_minutes', 180,
  'prep_lead_minutes', 90, 'reminder_minutes', 120, 'grace_minutes', 30, 'large_order_units', 5, 'customer_note', 'Please arrive within your slot'))$q$);
select pg_temp.chk('S3 the settings now count as configured', (public.preorder_admin_settings() ->> 'configured')::boolean and (public.preorder_admin_settings() ->> 'max_units_per_slot')::int = 8);
select pg_temp.sx($q$update public.shop_settings set pickup_enabled = false where id$q$);
select pg_temp.err_like('S3 it cannot be switched on while the shop offers no pick-up', $q$select public.preorder_admin_save_settings('{"enabled": true}'::jsonb)$q$, 'PICKUP_DISABLED%');
select pg_temp.sx($q$update public.shop_settings set pickup_enabled = true where id$q$);
select pg_temp.chk('S3 a SUPER_ADMIN switches it on', (public.preorder_admin_save_settings('{"enabled": true}'::jsonb) ->> 'enabled')::boolean);
select pg_temp.chk('S3 the change is in the audit trail', pg_temp.sv($q$select count(*) from public.shop_events where action = 'preorder.settings'$q$)::int >= 2);
select pg_temp.chk('S3 the staff list holds active admins only', (select bool_and(x ->> 'role' in ('ADMIN', 'SUPER_ADMIN')) and count(*) >= 1 from jsonb_array_elements(public.preorder_admin_staff()) x));

-- ================================================================================================ H. closures and special hours (any staff)
select pg_temp.err_like('H1 a past date is refused', format($q$select public.preorder_admin_save_day(%L::date, 'closed', null, null, 'x')$q$, (now() at time zone 'Asia/Bangkok')::date - 1), 'INVALID_DAY%');
select pg_temp.err_like('H1 special hours need an opening before the closing time', format($q$select public.preorder_admin_save_day(%L::date, 'special', '12:00', '10:00', 'x')$q$, (now() at time zone 'Asia/Bangkok')::date + 5), 'INVALID_DAY%');
select pg_temp.err_like('H1 special hours need real times', format($q$select public.preorder_admin_save_day(%L::date, 'special', 'noon', '15:00', 'x')$q$, (now() at time zone 'Asia/Bangkok')::date + 5), 'INVALID_DAY%');
select pg_temp.ok_run('H2 a closure', format($q$select public.preorder_admin_save_day(%L::date, 'closed', null, null, 'Holiday')$q$, (now() at time zone 'Asia/Bangkok')::date + 4));
select pg_temp.ok_run('H2 special hours', format($q$select public.preorder_admin_save_day(%L::date, 'special', '10:00', '12:00', 'Short day')$q$, (now() at time zone 'Asia/Bangkok')::date + 5));
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('H3 a customer cannot change the calendar', format($q$select public.preorder_admin_save_day(%L::date, 'closed', null, null, 'x')$q$, (now() at time zone 'Asia/Bangkok')::date + 6), '%not allowed%');
select pg_temp.err_like('H3 a customer cannot remove a closure', format($q$select public.preorder_admin_remove_day(%L::date)$q$, (now() at time zone 'Asia/Bangkok')::date + 4), '%not allowed%');

-- ================================================================================================ O. options and slots
select pg_temp.chk('O3 the options are on, with the shop''s slot length and a day list covering today and the furthest day', (public.preorder_options() ->> 'enabled')::boolean
  and (public.preorder_options() ->> 'slot_minutes')::int = 30 and jsonb_array_length(public.preorder_options() -> 'days') = 15 and public.preorder_options() ->> 'note' = 'Please arrive within your slot');
select pg_temp.chk('O3 the public shop settings say the feature is on', (public.shop_settings_public() ->> 'preorder_enabled')::boolean);
select pg_temp.chk('O3 the closed day is closed with its reason and no free slots', (select (x ->> 'closed')::boolean and x ->> 'reason' = 'Holiday' and (x ->> 'free_slots')::int = 0
  from jsonb_array_elements(public.preorder_options() -> 'days') x where x ->> 'day' = ((now() at time zone 'Asia/Bangkok')::date + 4)::text));
select pg_temp.chk('O3 the special day shows its own hours', (select x ->> 'open' = '10:00' and x ->> 'close' = '12:00' and (x ->> 'free_slots')::int = 4
  from jsonb_array_elements(public.preorder_options() -> 'days') x where x ->> 'day' = ((now() at time zone 'Asia/Bangkok')::date + 5)::text));
select pg_temp.chk('O3 an ordinary day has 18 free slots', (select (x ->> 'free_slots')::int = 18 from jsonb_array_elements(public.preorder_options() -> 'days') x where x ->> 'day' = ((now() at time zone 'Asia/Bangkok')::date + 3)::text));
select pg_temp.put('sl3', public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 3, 1)::text);
select pg_temp.chk('O4 a day has a slot every 30 minutes from 09:00 to 17:30', jsonb_array_length(pg_temp.c('sl3')::jsonb -> 'slots') = 18 and pg_temp.c('sl3')::jsonb -> 'slots' -> 0 ->> 'time' = '09:00'
  and pg_temp.c('sl3')::jsonb -> 'slots' -> 17 ->> 'time' = '17:30');
select pg_temp.chk('O4 every slot of a future day is ok while nothing is booked', (select bool_and(x ->> 'state' = 'ok') from jsonb_array_elements(pg_temp.c('sl3')::jsonb -> 'slots') x));
select pg_temp.chk('O4 a closed day has no slots', jsonb_array_length(public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 4, 1) -> 'slots') = 0 and (public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 4, 1) ->> 'closed')::boolean);
select pg_temp.chk('O4 special hours give 4 slots', jsonb_array_length(public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 5, 1) -> 'slots') = 4);
select pg_temp.chk('O4 today''s slots inside the lead time are marked soon, none earlier than now + 2 h is ok',
  not exists (select 1 from jsonb_array_elements(public.preorder_slots((now() at time zone 'Asia/Bangkok')::date, 1) -> 'slots') x where x ->> 'state' = 'ok' and (x ->> 'at')::timestamptz < now() + interval '120 minutes'));
select pg_temp.err_like('O4 a past day is refused', format($q$select public.preorder_slots(%L::date, 1)$q$, (now() at time zone 'Asia/Bangkok')::date - 1), 'SLOT_PAST%');
select pg_temp.err_like('O4 a day beyond the booking window is refused', format($q$select public.preorder_slots(%L::date, 1)$q$, (now() at time zone 'Asia/Bangkok')::date + 20), 'SLOT_TOO_FAR%');

-- ================================================================================================ P. placing a preorder
select pg_temp.put('P1res', pg_temp.place('pre-test-a-1', 3, pg_temp.sq(3, '10:00'), 'Please pack separately')::text);
select pg_temp.put('P1', pg_temp.oid(pg_temp.c('P1res')::jsonb));
select pg_temp.chk('P1 the order is a preorder in the pending state, pick-up, at the chosen time', pg_temp.c('P1res')::jsonb -> 'order' ->> 'order_type' = 'preorder' and pg_temp.c('P1res')::jsonb -> 'order' ->> 'status' = 'new'
  and pg_temp.c('P1res')::jsonb -> 'order' ->> 'fulfilment' = 'pickup' and (pg_temp.c('P1res')::jsonb -> 'order' ->> 'pickup_at')::timestamptz = pg_temp.sq(3, '10:00'));
select pg_temp.chk('P1 the quantity and the instruction are stored as ordered', (pg_temp.c('P1res')::jsonb -> 'order' -> 'items' -> 0 ->> 'qty')::int = 3 and pg_temp.c('P1res')::jsonb -> 'order' ->> 'note' = 'Please pack separately'
  and pg_temp.c('P1res')::jsonb -> 'order' -> 'items' -> 0 ->> 'sku_code' = pg_temp.c('sku'));
select pg_temp.chk('P1 the total is the server''s quote and the invoice carries it', (pg_temp.c('P1res')::jsonb -> 'order' ->> 'total')::numeric = (public.shop_quote(pg_temp.items(3), 'pickup') ->> 'total')::numeric
  and (pg_temp.c('P1res')::jsonb -> 'order' -> 'invoice' ->> 'amount')::numeric = (pg_temp.c('P1res')::jsonb -> 'order' ->> 'total')::numeric);
select pg_temp.chk('P1 an order number was issued and the checklist starts empty', pg_temp.c('P1res')::jsonb -> 'order' ->> 'order_no' like 'ORD-%' and (pg_temp.c('P1res')::jsonb -> 'order' -> 'prep' ->> 'checked')::int = 0
  and (pg_temp.c('P1res')::jsonb -> 'order' -> 'prep' ->> 'total')::int = 1);
select pg_temp.chk('P1 the audit trail records the pickup time', pg_temp.sv(format($q$select detail ->> 'pickup_at' from public.shop_events where entity_id = %L and action = 'order.place'$q$, pg_temp.c('P1'))) is not null);
select pg_temp.chk('P1 the customer got an in-app "placed" notice and the staff a "new" notice', pg_temp.notices(pg_temp.c('P1'), 'placed', 'customer') = 1 and pg_temp.notices(pg_temp.c('P1'), 'new', 'staff') >= 1);
select pg_temp.chk('P1 a replay of the same checkout returns the same order and books nothing more', (pg_temp.place('pre-test-a-1', 3, pg_temp.sq(3, '10:00'), 'Please pack separately') ->> 'replay')::boolean
  and pg_temp.oid(pg_temp.place('pre-test-a-1', 3, pg_temp.sq(3, '10:00'), 'Please pack separately')) = pg_temp.c('P1') and pg_temp.sv(format($q$select count(*) from public.shop_orders where idempotency_key = 'pre-test-a-1'$q$))::int = 1);
select pg_temp.err_like('P1 the same checkout key with another pickup time is refused', format($q$select pg_temp.place('pre-test-a-1', 3, %L::timestamptz, 'Please pack separately')$q$, pg_temp.sq(3, '11:00')), 'KEY_REUSED%');
select pg_temp.err_like('P2 a preorder is pick-up only', format($q$select pg_temp.place('pre-test-a-2', 1, %L::timestamptz, null, 'delivery')$q$, pg_temp.sq(3, '12:00')), 'PREORDER_PICKUP_ONLY%');
select pg_temp.err_like('P2 a time sooner than the lead time is refused', $q$select pg_temp.place('pre-test-a-3', 1, now() + interval '10 minutes')$q$, 'SLOT_TOO_SOON%');
select pg_temp.err_like('P2 a day beyond the window is refused', format($q$select pg_temp.place('pre-test-a-4', 1, %L::timestamptz)$q$, pg_temp.sq(20, '10:00')), 'SLOT_TOO_FAR%');
select pg_temp.err_like('P2 a time that is not on the slot grid is refused', format($q$select pg_temp.place('pre-test-a-5', 1, %L::timestamptz)$q$, pg_temp.sq(3, '10:10')), 'SLOT_INVALID%');
select pg_temp.err_like('P2 a closed day is refused', format($q$select pg_temp.place('pre-test-a-6', 1, %L::timestamptz)$q$, pg_temp.sq(4, '10:00')), 'SLOT_CLOSED%');
select pg_temp.err_like('P2 a time outside the special hours is refused', format($q$select pg_temp.place('pre-test-a-7', 1, %L::timestamptz)$q$, pg_temp.sq(5, '14:00')), 'SLOT_INVALID%');
select pg_temp.err_like('P2 a time after closing is refused', format($q$select pg_temp.place('pre-test-a-8', 1, %L::timestamptz)$q$, pg_temp.sq(3, '18:00')), 'SLOT_INVALID%');
select pg_temp.err_like('P2 an unsellable cart is refused before anything is booked', format($q$select public.shop_place_order('pre-test-a-9', '[{"sku_code":"NOPE-1","qty":1}]'::jsonb, 'pickup', 'T', '0812345678', null, null, null, null, null, null, null, null, null, %L::timestamptz)$q$, pg_temp.sq(3, '12:00')), 'CART_INVALID%');
select pg_temp.chk('P2 none of the refused attempts created an order', pg_temp.sv($q$select count(*) from public.shop_orders where idempotency_key ~ '^pre-test-a-[2-9]$'$q$)::int = 0);
-- capacity: 2 orders per slot, 8 units per slot
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('P3', pg_temp.oid(pg_temp.place('pre-test-b-1', 2, pg_temp.sq(3, '10:00'))));
select pg_temp.chk('P3 a second order fits the slot', pg_temp.c('P3') is not null);
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('P3 a third order for the same slot is refused (2 orders per slot)', format($q$select pg_temp.place('pre-test-c-1', 1, %L::timestamptz)$q$, pg_temp.sq(3, '10:00')), 'SLOT_FULL%');
select pg_temp.chk('P3 the slot list shows it as full, with nothing left', (select x ->> 'state' = 'full' and (x ->> 'orders_left')::int = 0 from jsonb_array_elements(public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 3, 1) -> 'slots') x where x ->> 'time' = '10:00'));
select pg_temp.chk('P3 the neighbouring slot is still ok', (select x ->> 'state' = 'ok' from jsonb_array_elements(public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 3, 1) -> 'slots') x where x ->> 'time' = '10:30'));
select pg_temp.chk('P3 the day list counts one slot fewer', (select (x ->> 'free_slots')::int = 17 from jsonb_array_elements(public.preorder_options() -> 'days') x where x ->> 'day' = ((now() at time zone 'Asia/Bangkok')::date + 3)::text));
select pg_temp.chk('P3 "slot full" reached the staff inbox exactly once', pg_temp.sv($q$select count(*) from public.preorder_notices where kind = 'slot_full' and audience = 'staff'$q$)::int = 1);
-- a regular order never takes a place (same time of day, no pickup time)
select pg_temp.put('R3', pg_temp.oid(pg_temp.place('pre-test-c-r1', 1, null)));
select pg_temp.chk('P3 regular orders do not count against a slot', (pg_temp.sv(format($q$select public.preorder_load(%L::timestamptz, null)::text$q$, pg_temp.sq(3, '10:00')))::jsonb ->> 'orders')::int = 2);
-- units
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('P4', pg_temp.oid(pg_temp.place('pre-test-a-u1', 5, pg_temp.sq(3, '11:00'))));
select pg_temp.chk('P4 a 5-unit order fits an empty slot', pg_temp.c('P4') is not null);
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('P4 another 4 units would pass the 8-unit limit of the slot', format($q$select pg_temp.place('pre-test-b-u1', 4, %L::timestamptz)$q$, pg_temp.sq(3, '11:00')), 'SLOT_UNITS_FULL%');
select pg_temp.chk('P4 the slot list says "units" for a 4-unit cart and "ok" for a 3-unit cart', (select x ->> 'state' from jsonb_array_elements(public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 3, 4) -> 'slots') x where x ->> 'time' = '11:00') = 'units'
  and (select x ->> 'state' from jsonb_array_elements(public.preorder_slots((now() at time zone 'Asia/Bangkok')::date + 3, 3) -> 'slots') x where x ->> 'time' = '11:00') = 'ok');
select pg_temp.put('P5', pg_temp.oid(pg_temp.place('pre-test-b-u2', 3, pg_temp.sq(3, '11:00'))));
select pg_temp.chk('P4 exactly 8 units in the slot is allowed', pg_temp.c('P5') is not null);
select pg_temp.chk('P4 a large order (5 units) was flagged to the staff', pg_temp.notices(pg_temp.c('P4'), 'large', 'staff') >= 1);
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.ok_run('P5 a day limit of 10 units', $q$select public.preorder_admin_save_settings('{"max_units_per_day": 10}'::jsonb)$q$);
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.put('P6', pg_temp.oid(pg_temp.place('pre-test-c-d1', 6, pg_temp.sq(6, '10:00'))));
select pg_temp.err_like('P5 5 more units on that day would pass the day limit', format($q$select pg_temp.place('pre-test-c-d2', 5, %L::timestamptz)$q$, pg_temp.sq(6, '12:00')), 'DAY_UNITS_FULL%');
select pg_temp.chk('P5 4 more units still fit the day', pg_temp.oid(pg_temp.place('pre-test-c-d3', 4, pg_temp.sq(6, '12:00'))) is not null);
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.ok_run('P5 the day limit is lifted again', $q$select public.preorder_admin_save_settings('{"max_units_per_day": null}'::jsonb)$q$);

-- ================================================================================================ L. LINE and notification reliability
-- (LINE is configured and on in the live project; inside this transaction it is set up explicitly so nothing depends on it)
select pg_temp.sx($q$update public.line_settings set enabled = false$q$);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('L0', pg_temp.sv($q$select count(*) from public.line_outbox where event = 'preorder'$q$));
select pg_temp.put('L1', pg_temp.oid(pg_temp.place('pre-test-a-l1', 1, pg_temp.sq(7, '10:00'))));
select pg_temp.chk('L1 LINE off: the notice is kept in the app, nothing is queued', pg_temp.notices(pg_temp.c('L1'), 'placed', 'customer') = 1 and pg_temp.sv($q$select count(*) from public.line_outbox where event = 'preorder'$q$) = pg_temp.c('L0'));
select pg_temp.sx($q$update public.line_settings set enabled = true, group_id = coalesce(group_id, 'C-test-group'), events = events || '{"preorder": true, "preorder_staff": true, "preorder_customer": true}'::jsonb$q$);
select pg_temp.put('L2', pg_temp.oid(pg_temp.place('pre-test-a-l2', 5, pg_temp.sq(7, '11:00'))));
select pg_temp.chk('L2 LINE on: the customer message is queued for the customer''s LINE', pg_temp.sv(format($q$select count(*) from public.line_outbox where event = 'preorder' and order_id = %L and target_type = 'user' and target_id = 'U-test-customer-a'$q$, pg_temp.c('L2')))::int = 1);
select pg_temp.chk('L2 LINE on: a large-order alert is queued for the group', pg_temp.sv(format($q$select count(*) from public.line_outbox where event = 'preorder' and order_id = %L and target_type = 'group' and payload ->> 'kind' = 'large'$q$, pg_temp.c('L2')))::int = 1);
select pg_temp.chk('L2 the message carries the order number and the pickup time in Thai', pg_temp.sv(format($q$select payload ->> 'text' from public.line_outbox where event = 'preorder' and order_id = %L and target_type = 'user'$q$, pg_temp.c('L2'))) ~ 'ORD-.*นัดรับ \d\d/\d\d 11:00');
select pg_temp.chk('L2 the in-app notice links to its queue row', pg_temp.sv(format($q$select count(*) from public.preorder_notices where order_id = %L and kind = 'placed' and outbox_id is not null$q$, pg_temp.c('L2')))::int = 1);
select pg_temp.chk('L2 the order card of the group is still sent by the existing trigger', pg_temp.sv(format($q$select count(*) from public.line_outbox where event = 'order_new' and order_id = %L$q$, pg_temp.c('L2')))::int = 1);
select pg_temp.sx($q$update public.line_settings set events = events || '{"preorder_customer": false}'::jsonb$q$);
select pg_temp.put('L3', pg_temp.oid(pg_temp.place('pre-test-a-l3', 1, pg_temp.sq(7, '12:00'))));
select pg_temp.chk('L3 customer switch off: the in-app notice exists, no customer LINE message', pg_temp.notices(pg_temp.c('L3'), 'placed', 'customer') = 1
  and pg_temp.sv(format($q$select count(*) from public.line_outbox where event = 'preorder' and order_id = %L and target_type = 'user'$q$, pg_temp.c('L3')))::int = 0);
-- a LINE queue that fails must not fail or roll back the order
select pg_temp.sx($q$create function pg_temp.boom() returns trigger language plpgsql as 'begin raise exception ''queue is broken''; end'$q$);
select pg_temp.sx($q$create trigger boom before insert on public.line_outbox for each row when (new.event = 'preorder') execute function pg_temp.boom()$q$);
select pg_temp.sx($q$update public.line_settings set events = events || '{"preorder_customer": true}'::jsonb$q$);
select pg_temp.put('L4res', pg_temp.place('pre-test-a-l4', 1, pg_temp.sq(7, '12:30'))::text);
select pg_temp.chk('L4 a broken LINE queue does not stop the order', pg_temp.c('L4res')::jsonb -> 'order' ->> 'order_type' = 'preorder' and pg_temp.status_of(pg_temp.oid(pg_temp.c('L4res')::jsonb)) = 'new');
select pg_temp.chk('L4 the in-app notice survives, without a queue link', pg_temp.sv(format($q$select count(*) from public.preorder_notices where order_id = %L and kind = 'placed' and outbox_id is null$q$, pg_temp.oid(pg_temp.c('L4res')::jsonb)))::int = 1);
select pg_temp.sx($q$drop trigger boom on public.line_outbox$q$);
select pg_temp.sx($q$update public.line_settings set enabled = false$q$);

-- ================================================================================================ C. the customer changes or cancels
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('C1res', public.preorder_change_my_order(pg_temp.c('P1')::uuid, jsonb_build_object('pickup_at', pg_temp.sq(3, '14:00'), 'note', 'Ring me on arrival'))::text);
select pg_temp.chk('C1 the pickup time and the instruction changed', (pg_temp.c('C1res')::jsonb ->> 'pickup_at')::timestamptz = pg_temp.sq(3, '14:00') and pg_temp.c('C1res')::jsonb ->> 'note' = 'Ring me on arrival');
select pg_temp.chk('C1 the reschedule is counted and shown', (pg_temp.c('C1res')::jsonb ->> 'reschedule_count')::int = 1 and (pg_temp.c('C1res')::jsonb -> 'change' ->> 'reschedules_left')::int = 2);
select pg_temp.chk('C1 the audit trail has the old and the new time', pg_temp.sv(format($q$select detail ->> 'pickup_from' is not null and detail ->> 'pickup_to' is not null and detail ->> 'note_from' = 'Please pack separately' from public.shop_events where entity_id = %L and action = 'preorder.change'$q$, pg_temp.c('P1')))::boolean);
select pg_temp.chk('C1 the staff were told (in the app)', pg_temp.notices(pg_temp.c('P1'), 'changed', 'staff') >= 1);
select pg_temp.chk('C1 the old slot is free again, the new one is taken', (pg_temp.sv(format($q$select public.preorder_load(%L::timestamptz, null)::text$q$, pg_temp.sq(3, '10:00')))::jsonb ->> 'orders')::int = 1
  and (pg_temp.sv(format($q$select public.preorder_load(%L::timestamptz, null)::text$q$, pg_temp.sq(3, '14:00')))::jsonb ->> 'orders')::int = 1);
select pg_temp.chk('C2 changing nothing changes nothing', (public.preorder_change_my_order(pg_temp.c('P1')::uuid, jsonb_build_object('pickup_at', pg_temp.sq(3, '14:00'))) ->> 'reschedule_count')::int = 1);
select pg_temp.err_like('C2 moving into a slot that already holds 2 orders is refused', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('pickup_at', %L::timestamptz))$q$, pg_temp.c('P1'), pg_temp.sq(3, '11:00')), 'SLOT_FULL%');
select pg_temp.err_like('C2 moving 3 units next to a 6-unit order (limit 8) is refused for units', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('pickup_at', %L::timestamptz))$q$, pg_temp.c('P1'), pg_temp.sq(6, '10:00')), 'SLOT_UNITS_FULL%');
select pg_temp.err_like('C2 moving to a closed day is refused', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('pickup_at', %L::timestamptz))$q$, pg_temp.c('P1'), pg_temp.sq(4, '10:00')), 'SLOT_CLOSED%');
select pg_temp.err_like('C2 moving to a time that is too soon is refused', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('pickup_at', %L::timestamptz))$q$, pg_temp.c('P1'), now() + interval '5 minutes'), 'SLOT_TOO_SOON%');
select pg_temp.err_like('C2 an instruction over 300 characters is refused', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('note', repeat('x', 301)))$q$, pg_temp.c('P1')), 'INVALID_NOTE%');
select pg_temp.chk('C2 only the instruction can change without using a reschedule', (public.preorder_change_my_order(pg_temp.c('P1')::uuid, jsonb_build_object('note', 'Back door please')) ->> 'reschedule_count')::int = 1);
select pg_temp.chk('C2 the instruction can be removed', (public.preorder_change_my_order(pg_temp.c('P1')::uuid, jsonb_build_object('note', '  ')) ->> 'note') is null);
select pg_temp.chk('C3 the second and third reschedule work', (public.preorder_change_my_order(pg_temp.c('P1')::uuid, jsonb_build_object('pickup_at', pg_temp.sq(3, '14:30'))) ->> 'reschedule_count')::int = 2
  and (public.preorder_change_my_order(pg_temp.c('P1')::uuid, jsonb_build_object('pickup_at', pg_temp.sq(3, '15:00'))) ->> 'reschedule_count')::int = 3);
select pg_temp.err_like('C3 a fourth reschedule is refused', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('pickup_at', %L::timestamptz))$q$, pg_temp.c('P1'), pg_temp.sq(3, '15:30')), 'RESCHEDULE_LIMIT%');
select pg_temp.chk('C3 the rules now say no more reschedules', not (public.shop_my_order(pg_temp.c('P1')::uuid) -> 'change' ->> 'can_reschedule')::boolean);
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('C4 another customer cannot change this order', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('note', 'hijack'))$q$, pg_temp.c('P1')), '%Order not found%');
select pg_temp.err_like('C4 a regular order cannot be "changed" this way', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('note', 'x'))$q$, pg_temp.c('R3')), '%not found%');
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('C4 a regular order of the customer is refused with its own code', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('note', 'x'))$q$, pg_temp.c('R1')), 'NOT_PREORDER%');
-- the cut-off
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.ok_run('C5 a cut-off of 7 days', $q$select public.preorder_admin_save_settings('{"change_cutoff_minutes": 10080}'::jsonb)$q$);
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('C5 inside the cut-off a change is refused', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('note', 'late'))$q$, pg_temp.c('P3')), 'TOO_LATE_TO_CHANGE%');
select pg_temp.err_like('C5 inside the cut-off a cancellation is refused', format($q$select public.shop_cancel_my_order(%L::uuid, 'late')$q$, pg_temp.c('P3')), 'TOO_LATE_TO_CHANGE%');
select pg_temp.chk('C5 the rules say so', not (public.shop_my_order(pg_temp.c('P3')::uuid) -> 'change' ->> 'can_cancel_time')::boolean and not (public.shop_my_order(pg_temp.c('P3')::uuid) -> 'change' ->> 'can_reschedule')::boolean);
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.ok_run('C5 back to 3 hours', $q$select public.preorder_admin_save_settings('{"change_cutoff_minutes": 180}'::jsonb)$q$);
-- a request to the shop
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('C6 a request needs a real message', format($q$select public.preorder_request_change(%L::uuid, 'x')$q$, pg_temp.c('P1')), 'INVALID_MESSAGE%');
select pg_temp.chk('C6 a request reaches the staff', (public.preorder_request_change(pg_temp.c('P1')::uuid, 'Please make it 5 pieces instead of 3') ->> 'ok')::boolean and pg_temp.notices(pg_temp.c('P1'), 'request', 'staff') >= 1);
select pg_temp.err_like('C6 a second request within 10 minutes is refused', format($q$select public.preorder_request_change(%L::uuid, 'And one more thing')$q$, pg_temp.c('P1')), 'TOO_MANY_REQUESTS%');
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('C6 another customer cannot send a request for it', format($q$select public.preorder_request_change(%L::uuid, 'not mine to change')$q$, pg_temp.c('P1')), '%Order not found%');
-- cancelling (new + unpaid + before the cut-off)
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.put('C7', pg_temp.oid(pg_temp.place('pre-test-c-x1', 1, pg_temp.sq(3, '16:00'))));
select pg_temp.chk('C7 the customer cancels their own new preorder', public.shop_cancel_my_order(pg_temp.c('C7')::uuid, 'Plans changed') ->> 'status' = 'cancelled');
select pg_temp.chk('C7 and it is recorded as cancelled by the customer', public.shop_my_order(pg_temp.c('C7')::uuid) ->> 'cancel_kind' = 'customer');
select pg_temp.chk('C7 the staff were told', pg_temp.notices(pg_temp.c('C7'), 'cancelled_by_customer', 'staff') >= 1);
select pg_temp.chk('C7 the slot is free again', (pg_temp.sv(format($q$select public.preorder_load(%L::timestamptz, null)::text$q$, pg_temp.sq(3, '16:00')))::jsonb ->> 'orders')::int = 0);
select pg_temp.err_like('C7 cancelling twice is refused', format($q$select public.shop_cancel_my_order(%L::uuid, 'again')$q$, pg_temp.c('C7')), '%already cancelled%');
select pg_temp.err_like('C7 a cancelled order cannot be changed', format($q$select public.preorder_change_my_order(%L::uuid, jsonb_build_object('note', 'x'))$q$, pg_temp.c('C7')), 'ORDER_IN_PROGRESS%');
select pg_temp.chk('C7 cancelled places stop counting: the slot takes new orders again', pg_temp.oid(pg_temp.place('pre-test-c-x2', 1, pg_temp.sq(3, '16:00'))) is not null);

-- ================================================================================================ T. the lifecycle (staff)
select pg_temp.as_user(pg_temp.c('U')::uuid);
select pg_temp.err_like('T0 a user who is not staff cannot move an order', format($q$select public.shop_admin_set_status(%L::uuid, 'confirmed')$q$, pg_temp.c('P3')), '%not allowed%');
select pg_temp.err_like('T0 nor see the schedule', format($q$select public.preorder_admin_schedule(%L::date)$q$, (now() at time zone 'Asia/Bangkok')::date + 3), '%not allowed%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('T1 a new order cannot jump to ready', format($q$select public.shop_admin_set_status(%L::uuid, 'ready')$q$, pg_temp.c('P3')), '%cannot become%');
select pg_temp.chk('T1 staff confirm the preorder', public.shop_admin_set_status(pg_temp.c('P3')::uuid, 'confirmed') ->> 'status' = 'confirmed');
select pg_temp.chk('T1 and the confirmation time is recorded', (public.shop_admin_order(pg_temp.c('P3')::uuid) ->> 'confirmed_at') is not null);
select pg_temp.chk('T1 the customer got the "confirmed" notice', pg_temp.notices(pg_temp.c('P3'), 'confirmed', 'customer') = 1);
select pg_temp.err_like('T1 preparing needs a verified payment (as for every order)', format($q$select public.shop_admin_set_status(%L::uuid, 'preparing')$q$, pg_temp.c('P3')), 'PAYMENT_REQUIRED%');
select pg_temp.chk('T1 or a recorded reason', public.shop_admin_set_status(pg_temp.c('P3')::uuid, 'preparing', null, 'owner agreed: pays at pickup') ->> 'status' = 'preparing');
select pg_temp.chk('T1 whoever starts the preparation is assigned', pg_temp.sv(format($q$select assigned_to::text from public.preorder_assignments where order_id = %L$q$, pg_temp.c('P3'))) = pg_temp.c('S'));
select pg_temp.chk('T1 the customer sees the progress', pg_temp.notices(pg_temp.c('P3'), 'preparing', 'customer') = 1 and pg_temp.my('B', pg_temp.c('P3')) ->> 'preparing_at' is not null);
select pg_temp.err_like('T2 ready is refused while the checklist is incomplete', format($q$select public.shop_admin_set_status(%L::uuid, 'ready', null, 'x')$q$, pg_temp.c('P3')), 'PREP_INCOMPLETE%');
select pg_temp.chk('T2 ticking the line works and is reported', (public.preorder_prep_set(pg_temp.c('P3')::uuid, 1, true) -> 'prep' ->> 'checked')::int = 1 and (pg_temp.row(pg_temp.c('P3'), true) is null) = false);
select pg_temp.chk('T2 the checklist shows who ticked it', pg_temp.sv(format($q$select checked_by::text from public.preorder_prep_checks where order_id = %L and line_no = 1$q$, pg_temp.c('P3'))) = pg_temp.c('S'));
select pg_temp.chk('T2 un-ticking works', (public.preorder_prep_set(pg_temp.c('P3')::uuid, 1, false) -> 'prep' ->> 'checked')::int = 0 and (public.preorder_prep_set(pg_temp.c('P3')::uuid, null, true) -> 'prep' ->> 'checked')::int = 1);
select pg_temp.err_like('T2 an unknown line is refused', format($q$select public.preorder_prep_set(%L::uuid, 99, true)$q$, pg_temp.c('P3')), '%Line not found%');
select pg_temp.chk('T2 the customer can see the preparation progress', (pg_temp.my('B', pg_temp.c('P3')) -> 'prep' ->> 'checked')::int = 1 and (pg_temp.my('B', pg_temp.c('P3')) -> 'items' -> 0 ->> 'line_no') is not null);
select pg_temp.chk('T3 a preorder goes straight from preparing to ready', public.shop_admin_set_status(pg_temp.c('P3')::uuid, 'ready', null, 'owner agreed: pays at pickup') ->> 'status' = 'ready' and pg_temp.notices(pg_temp.c('P3'), 'ready', 'customer') = 1);
select pg_temp.err_like('T3 ticks are refused once the order is ready', format($q$select public.preorder_prep_set(%L::uuid, 1, false)$q$, pg_temp.c('P3')), 'NOT_PREPARING%');
select pg_temp.chk('T3 the handover completes it', public.shop_admin_set_status(pg_temp.c('P3')::uuid, 'completed', null, 'owner agreed: pays at pickup') ->> 'status' = 'completed' and pg_temp.notices(pg_temp.c('P3'), 'completed', 'customer') = 1);
select pg_temp.chk('T3 every step left a timestamp', (select confirmed_at is not null and preparing_at is not null and ready_at is not null and completed_at is not null from (select public.shop_admin_order(pg_temp.c('P3')::uuid) j) x,
  lateral (select (j ->> 'confirmed_at') confirmed_at, (j ->> 'preparing_at') preparing_at, (j ->> 'ready_at') ready_at, (j ->> 'completed_at') completed_at) y));
select pg_temp.chk('T3 who did what is in the history', pg_temp.sv(format($q$select count(*) from public.shop_events where entity_id = %L and action = 'order.status' and actor_email is not null$q$, pg_temp.c('P3')))::int >= 4);
select pg_temp.err_like('T3 a completed order cannot be cancelled by the shop', format($q$select public.shop_admin_set_status(%L::uuid, 'cancelled', 'oops')$q$, pg_temp.c('P3')), '%already completed%');
select pg_temp.chk('T3 and a completed order stops counting against its slot', (pg_temp.sv(format($q$select public.preorder_load(%L::timestamptz, null)::text$q$, pg_temp.sq(3, '10:00')))::jsonb ->> 'orders')::int = 1);
-- a pickup time that has passed cannot be confirmed
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.put('T4', pg_temp.oid(pg_temp.place('pre-test-c-t4', 1, pg_temp.sq(8, '10:00'))));
select pg_temp.sx(format($q$update public.shop_orders set pickup_at = now() - interval '1 hour' where id = %L$q$, pg_temp.c('T4')));
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('T4 a preorder whose pickup time has passed cannot be confirmed', format($q$select public.shop_admin_set_status(%L::uuid, 'confirmed')$q$, pg_temp.c('T4')), 'PICKUP_PASSED%');
-- rejected vs cancelled by the shop
select pg_temp.err_like('T5 a reason is required', format($q$select public.shop_admin_set_status(%L::uuid, 'cancelled')$q$, pg_temp.c('T4')), '%reason is required%');
select pg_temp.chk('T5 the shop rejects a new preorder', public.shop_admin_set_status(pg_temp.c('T4')::uuid, 'cancelled', 'We are out of stock that day') ->> 'cancel_kind' = 'rejected' and pg_temp.notices(pg_temp.c('T4'), 'rejected', 'customer') = 1);
select pg_temp.chk('T5 the customer notice carries the reason', pg_temp.sv(format($q$select data ->> 'reason' from public.preorder_notices where order_id = %L and kind = 'rejected'$q$, pg_temp.c('T4'))) = 'We are out of stock that day');
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('T6', pg_temp.oid(pg_temp.place('pre-test-b-t6', 1, pg_temp.sq(8, '11:00'))));
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.ok_run('T6 confirm it', format($q$select public.shop_admin_set_status(%L::uuid, 'confirmed')$q$, pg_temp.c('T6')));
select pg_temp.chk('T6 cancelling a confirmed preorder is a cancellation by the shop', public.shop_admin_set_status(pg_temp.c('T6')::uuid, 'cancelled', 'Shop closed unexpectedly') ->> 'cancel_kind' = 'staff' and pg_temp.notices(pg_temp.c('T6'), 'cancelled_by_shop', 'customer') = 1);
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('T7', pg_temp.oid(pg_temp.place('pre-test-b-t7', 1, pg_temp.sq(8, '12:00'))));
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.ok_run('T7 confirm it', format($q$select public.shop_admin_set_status(%L::uuid, 'confirmed')$q$, pg_temp.c('T7')));
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('T7 once confirmed the customer can neither cancel nor reschedule', format($q$select public.shop_cancel_my_order(%L::uuid, 'x')$q$, pg_temp.c('T7')), 'ORDER_IN_PROGRESS%');
select pg_temp.chk('T7 but a confirmed order can still be rescheduled by the customer', (public.preorder_change_my_order(pg_temp.c('T7')::uuid, jsonb_build_object('pickup_at', pg_temp.sq(8, '12:30'))) ->> 'reschedule_count')::int = 1);

-- ================================================================================================ A. assignment and staff reschedule
select pg_temp.as_user(pg_temp.c('U')::uuid);
select pg_temp.err_like('A1 a non-staff user cannot assign', format($q$select public.preorder_admin_assign(%L::uuid, %L::uuid)$q$, pg_temp.c('T7'), pg_temp.c('S')), '%not allowed%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('A1 a customer cannot be the assignee', format($q$select public.preorder_admin_assign(%L::uuid, %L::uuid)$q$, pg_temp.c('T7'), pg_temp.c('A')), 'INVALID_ASSIGNEE%');
select pg_temp.chk('A1 staff assign an employee', (public.preorder_admin_assign(pg_temp.c('T7')::uuid, pg_temp.c('S')::uuid) ->> 'assigned_to') = pg_temp.c('S'));
select pg_temp.chk('A1 the assignee''s name is shown to staff', (pg_temp.row(pg_temp.c('T7')) ->> 'assigned_name') is not null);
select pg_temp.chk('A1 customers never see who it is assigned to', (pg_temp.oj(pg_temp.c('T7')) ->> 'assigned_to') is null and (pg_temp.my('B', pg_temp.c('T7')) ->> 'assigned_name') is null);
select pg_temp.chk('A2 assigning someone else notifies them', pg_temp.c('S2') is null or ((public.preorder_admin_assign(pg_temp.c('T7')::uuid, pg_temp.c('S2')::uuid) ->> 'assigned_to') = pg_temp.c('S2')
  and pg_temp.sv(format($q$select count(*) from public.preorder_notices where order_id = %L and kind = 'assigned' and profile_id = %L$q$, pg_temp.c('T7'), pg_temp.c('S2')))::int = 1));
select pg_temp.chk('A2 the change of assignee is in the audit trail', pg_temp.sv(format($q$select count(*) from public.shop_events where entity_id = %L and action = 'preorder.assign'$q$, pg_temp.c('T7')))::int >= 1);
select pg_temp.chk('A2 un-assigning works', (public.preorder_admin_assign(pg_temp.c('T7')::uuid, null) ->> 'assigned_to') is null);
select pg_temp.err_like('A3 staff need a reason to move a pickup', format($q$select public.preorder_admin_reschedule(%L::uuid, %L::timestamptz, ' ')$q$, pg_temp.c('T7'), pg_temp.sq(8, '14:00')), '%reason is required%');
select pg_temp.err_like('A3 not into the past', format($q$select public.preorder_admin_reschedule(%L::uuid, %L::timestamptz, 'because')$q$, pg_temp.c('T7'), now() - interval '2 hours'), 'SLOT_PAST%');
select pg_temp.err_like('A3 a pickup time off the grid is refused for staff too', format($q$select public.preorder_admin_reschedule(%L::uuid, %L::timestamptz, 'because')$q$, pg_temp.c('T7'), pg_temp.sq(8, '14:10')), 'SLOT_INVALID%');
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.put('FULL1', pg_temp.oid(pg_temp.place('pre-test-c-f1', 1, pg_temp.sq(9, '10:00'))));
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('FULL2', pg_temp.oid(pg_temp.place('pre-test-b-f2', 1, pg_temp.sq(9, '10:00'))));
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('A3 moving a third order into a full slot is refused without force', format($q$select public.preorder_admin_reschedule(%L::uuid, %L::timestamptz, 'VIP')$q$, pg_temp.c('T7'), pg_temp.sq(9, '10:00')), 'SLOT_FULL%');
select pg_temp.chk('A3 with force it goes through and the override is recorded', (public.preorder_admin_reschedule(pg_temp.c('T7')::uuid, pg_temp.sq(9, '10:00'), 'VIP customer', true) ->> 'pickup_at')::timestamptz = pg_temp.sq(9, '10:00')
  and pg_temp.sv(format($q$select detail ->> 'capacity_override' from public.shop_events where entity_id = %L and action = 'preorder.reschedule'$q$, pg_temp.c('T7'))) = 'true');
select pg_temp.chk('A3 the customer was told with the reason', pg_temp.sv(format($q$select data ->> 'reason' from public.preorder_notices where order_id = %L and kind = 'rescheduled_by_shop'$q$, pg_temp.c('T7'))) = 'VIP customer');
select pg_temp.err_like('A3 nothing to change', format($q$select public.preorder_admin_reschedule(%L::uuid, %L::timestamptz, 'same')$q$, pg_temp.c('T7'), pg_temp.sq(9, '10:00')), 'NOTHING_TO_CHANGE%');
select pg_temp.chk('A3 a normal move without force within capacity works', (public.preorder_admin_reschedule(pg_temp.c('T7')::uuid, pg_temp.sq(9, '15:00'), 'back to normal') ->> 'pickup_at')::timestamptz = pg_temp.sq(9, '15:00'));
select pg_temp.chk('A3 a staff move does not use up the customer''s reschedules', pg_temp.sv(format($q$select reschedule_count::text from public.shop_orders where id = %L$q$, pg_temp.c('T7')))::int = 1);

-- ================================================================================================ D. dashboard, list, schedule, board
select pg_temp.put('d3', ((now() at time zone 'Asia/Bangkok')::date + 3)::text);
select pg_temp.put('dash', public.preorder_admin_dashboard(pg_temp.c('d3')::date)::text);
select pg_temp.chk('D1 the dashboard counts come from the orders (total of the day)', (pg_temp.c('dash')::jsonb ->> 'total')::int = pg_temp.sv(format($q$select count(*) from public.shop_orders where order_type = 'preorder' and (pickup_at at time zone 'Asia/Bangkok')::date = %L::date$q$, pg_temp.c('d3')))::int);
select pg_temp.chk('D1 each state of the day matches a direct count', (pg_temp.c('dash')::jsonb ->> 'pending')::int = pg_temp.sv(format($q$select count(*) from public.shop_orders where order_type = 'preorder' and status = 'new' and (pickup_at at time zone 'Asia/Bangkok')::date = %L::date$q$, pg_temp.c('d3')))::int
  and (pg_temp.c('dash')::jsonb ->> 'completed')::int = pg_temp.sv(format($q$select count(*) from public.shop_orders where order_type = 'preorder' and status = 'completed' and (pickup_at at time zone 'Asia/Bangkok')::date = %L::date$q$, pg_temp.c('d3')))::int
  and (pg_temp.c('dash')::jsonb ->> 'cancelled')::int = pg_temp.sv(format($q$select count(*) from public.shop_orders where order_type = 'preorder' and status in ('cancelled', 'returned') and (pickup_at at time zone 'Asia/Bangkok')::date = %L::date$q$, pg_temp.c('d3')))::int);
select pg_temp.chk('D1 upcoming = active preorders after that day', (pg_temp.c('dash')::jsonb ->> 'upcoming')::int = pg_temp.sv(format($q$select count(*) from public.shop_orders where order_type = 'preorder' and status not in ('cancelled', 'returned', 'completed') and (pickup_at at time zone 'Asia/Bangkok')::date > %L::date$q$, pg_temp.c('d3')))::int);
select pg_temp.chk('D1 units of the day = what the orders carry', (pg_temp.c('dash')::jsonb ->> 'units_today')::int = pg_temp.sv(format($q$select coalesce(sum(i.qty), 0) from public.shop_orders o join public.shop_order_items i on i.order_id = o.id where o.order_type = 'preorder' and o.status not in ('cancelled', 'returned') and (o.pickup_at at time zone 'Asia/Bangkok')::date = %L::date$q$, pg_temp.c('d3')))::int);
select pg_temp.chk('D1 the capacity block is there', (pg_temp.c('dash')::jsonb -> 'capacity' ->> 'max_orders_per_slot')::int = 2);
-- attention flags
select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.put('F1', pg_temp.oid(pg_temp.place('pre-test-a-fl1', 1, pg_temp.sq(10, '10:00'))));
select pg_temp.sx(format($q$update public.shop_orders set pickup_at = now() - interval '5 minutes', created_at = now() - interval '2 hours' where id = %L$q$, pg_temp.c('F1')));
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('D2 a new order past its pickup time and unconfirmed for over 30 minutes is "unconfirmed", "late" and "unpaid_soon"',
  (select (f ? 'unconfirmed') and (f ? 'late') and (f ? 'unpaid_soon') from (select pg_temp.row(pg_temp.c('F1')) -> 'flags' f) x));
select pg_temp.chk('D2 the dashboard lists it under attention', exists (select 1 from jsonb_array_elements(public.preorder_admin_dashboard(null) -> 'attention') a where a ->> 'id' = pg_temp.c('F1')));
select pg_temp.chk('D2 a healthy order is not on the attention list', not exists (select 1 from jsonb_array_elements(public.preorder_admin_dashboard(null) -> 'attention') a where a ->> 'id' = pg_temp.c('T7') and jsonb_array_length(a -> 'flags') = 0));
select pg_temp.put('F2', pg_temp.oid((select public.shop_place_order('pre-test-s-fl2', pg_temp.items(1), 'pickup', 'Test', '0812345678', null, null, null, null, null, null, null, null, null, pg_temp.sq(11, '10:00')))));
select pg_temp.err_like('D2 closing a day that has active preorders needs force', format($q$select public.preorder_admin_save_day(%L::date, 'closed', null, null, 'Water cut')$q$, (now() at time zone 'Asia/Bangkok')::date + 11), 'DAY_HAS_ORDERS%');
select pg_temp.chk('D2 with force the day closes and the order is flagged', (public.preorder_admin_save_day((now() at time zone 'Asia/Bangkok')::date + 11, 'closed', null, null, 'Water cut', true) ->> 'orders_affected')::int = 1
  and (pg_temp.row(pg_temp.c('F2')) -> 'flags') ? 'closed_day');
select pg_temp.err_like('D2 special hours that exclude a booked time are refused without force', format($q$select public.preorder_admin_save_day(%L::date, 'special', '12:00', '15:00', 'Short')$q$, (now() at time zone 'Asia/Bangkok')::date + 6), 'DAY_HAS_ORDERS%');
select pg_temp.chk('D2 a closure can be removed again', (public.preorder_admin_remove_day((now() at time zone 'Asia/Bangkok')::date + 11) ->> 'ok')::boolean and not ((pg_temp.row(pg_temp.c('F2')) -> 'flags') ? 'closed_day'));
-- list
select pg_temp.put('all', public.preorder_admin_list()::text);
select pg_temp.chk('D3 the list holds every preorder and only preorders', (pg_temp.c('all')::jsonb ->> 'total')::int = pg_temp.sv($q$select count(*) from public.shop_orders where order_type = 'preorder'$q$)::int
  and not exists (select 1 from jsonb_array_elements(pg_temp.c('all')::jsonb -> 'orders') o where o ->> 'id' in (pg_temp.c('R1'), pg_temp.c('R2'), pg_temp.c('R3'))));
select pg_temp.chk('D3 each row carries what the table needs', (select bool_and(o ? 'order_no' and o ? 'contact_name' and o ? 'contact_phone' and o ? 'pickup_at' and o ? 'lines' and o ? 'units' and o ? 'total' and o ? 'pay_code' and o ? 'status' and o ? 'prep' and o ? 'flags' and o ? 'created_at' and o ? 'note')
  from jsonb_array_elements(pg_temp.c('all')::jsonb -> 'orders') o));
select pg_temp.chk('D3 the default order is the soonest pickup first', (select array_agg(o ->> 'pickup_at' order by ord) from jsonb_array_elements(pg_temp.c('all')::jsonb -> 'orders') with ordinality t(o, ord))
  = (select array_agg(o ->> 'pickup_at' order by o ->> 'pickup_at') from jsonb_array_elements(pg_temp.c('all')::jsonb -> 'orders') o));
select pg_temp.chk('D3 filter by status', (select bool_and(o ->> 'status' = 'new') and count(*) > 0 from jsonb_array_elements(public.preorder_admin_list(null, 'new') -> 'orders') o));
select pg_temp.chk('D3 filter by pickup date', (select bool_and((o ->> 'pickup_at')::timestamptz >= pg_temp.sq(3, '00:00') and (o ->> 'pickup_at')::timestamptz < pg_temp.sq(4, '00:00')) and count(*) > 0
  from jsonb_array_elements(public.preorder_admin_list(null, null, null, pg_temp.c('d3')::date, pg_temp.c('d3')::date) -> 'orders') o));
select pg_temp.chk('D3 filter by pickup time of day', (select bool_and(((o ->> 'pickup_at')::timestamptz at time zone 'Asia/Bangkok')::time between '10:00' and '11:00') and count(*) > 0
  from jsonb_array_elements(public.preorder_admin_list(null, null, null, pg_temp.c('d3')::date, pg_temp.c('d3')::date, '10:00', '11:00') -> 'orders') o));
select pg_temp.chk('D3 search by order number', (select count(*) = 1 and bool_and(o ->> 'id' = pg_temp.c('P4')) from jsonb_array_elements(public.preorder_admin_list(pg_temp.sv(format($q$select order_no from public.shop_orders where id = %L$q$, pg_temp.c('P4')))) -> 'orders') o));
select pg_temp.chk('D3 search by customer name or phone', (public.preorder_admin_list('0812345678') ->> 'total')::int >= 1 and (public.preorder_admin_list('zzzzqqqq') ->> 'total')::int = 0);
select pg_temp.chk('D3 filter by payment: nothing here is paid', (public.preorder_admin_list(null, null, 'paid') ->> 'total')::int = 0 and (public.preorder_admin_list(null, null, 'unpaid') ->> 'total')::int >= 1);
select pg_temp.chk('D3 filter by assigned employee: unassigned and a named one', (public.preorder_admin_list(null, null, null, null, null, null, null, 'none') ->> 'total')::int >= 1
  and (select bool_and(o ->> 'assigned_to' = pg_temp.c('S')) and count(*) >= 1 from jsonb_array_elements(public.preorder_admin_list(null, null, null, null, null, null, null, pg_temp.c('S')) -> 'orders') o));
select pg_temp.chk('D3 an assignee filter that is not an id finds nothing and does not fail', (public.preorder_admin_list(null, null, null, null, null, null, null, 'not-an-id') ->> 'total')::int = 0
  and (public.preorder_admin_list(null, null, null, null, null, null, null, repeat('-', 36)) ->> 'total')::int = 0);
select pg_temp.chk('D3 sort by total, newest and latest pickup', (select (o ->> 'total')::numeric from jsonb_array_elements(public.preorder_admin_list(null, null, null, null, null, null, null, null, 'total_desc', 1) -> 'orders') o)
  = pg_temp.sv($q$select max(total) from public.shop_orders where order_type = 'preorder'$q$)::numeric
  and (select o ->> 'id' from jsonb_array_elements(public.preorder_admin_list(null, null, null, null, null, null, null, null, 'created_desc', 1) -> 'orders') o) is not null
  and (select (o ->> 'pickup_at')::timestamptz from jsonb_array_elements(public.preorder_admin_list(null, null, null, null, null, null, null, null, 'pickup_desc', 1) -> 'orders') o) = pg_temp.sv($q$select max(pickup_at)::text from public.shop_orders where order_type = 'preorder'$q$)::timestamptz);
select pg_temp.chk('D3 paging gives the rest', jsonb_array_length(public.preorder_admin_list(null, null, null, null, null, null, null, null, 'pickup_asc', 2, 0) -> 'orders') = 2
  and (public.preorder_admin_list(null, null, null, null, null, null, null, null, 'pickup_asc', 2, 2) ->> 'total')::int = (pg_temp.c('all')::jsonb ->> 'total')::int
  and (public.preorder_admin_list(null, null, null, null, null, null, null, null, 'pickup_asc', 2, 0) -> 'orders' -> 0 ->> 'id') <> (public.preorder_admin_list(null, null, null, null, null, null, null, null, 'pickup_asc', 2, 2) -> 'orders' -> 0 ->> 'id'));
select pg_temp.chk('D3 a search with LIKE characters is taken literally', (public.preorder_admin_list('%') ->> 'total')::int = 0 and (public.preorder_admin_list('_') ->> 'total')::int = 0);
-- schedule
select pg_temp.put('sch', public.preorder_admin_schedule(pg_temp.c('d3')::date)::text);
select pg_temp.chk('D4 the schedule shows every slot of the day, free ones too', jsonb_array_length(pg_temp.c('sch')::jsonb -> 'slots') >= 18 and (pg_temp.c('sch')::jsonb -> 'hours' ->> 'open') = '09:00');
select pg_temp.chk('D4 the orders sit under their pickup time', (select count(*) = 1 from jsonb_array_elements(pg_temp.c('sch')::jsonb -> 'slots') s, jsonb_array_elements(s -> 'orders') o where o ->> 'id' = pg_temp.c('P4') and s ->> 'time' = '11:00'));
select pg_temp.chk('D4 the slot carries its load', (select (s -> 'load' ->> 'orders')::int = 2 and (s -> 'load' ->> 'units')::int = 8 from jsonb_array_elements(pg_temp.c('sch')::jsonb -> 'slots') s where s ->> 'time' = '11:00'));
select pg_temp.chk('D4 cancelled orders are not on the timeline but are counted', (pg_temp.c('sch')::jsonb ->> 'cancelled')::int >= 1 and not exists (select 1 from jsonb_array_elements(pg_temp.c('sch')::jsonb -> 'slots') s, jsonb_array_elements(s -> 'orders') o where o ->> 'id' = pg_temp.c('C7')));
-- the board
select pg_temp.put('board', public.preorder_prep_board(false, 5)::text);
select pg_temp.chk('D5 the board lists open preorders with their lines and quantities', (select count(*) >= 1 and bool_and(jsonb_array_length(o -> 'items') >= 1 and (o -> 'items' -> 0 ? 'qty') and (o -> 'items' -> 0 ? 'checked')) from jsonb_array_elements(pg_temp.c('board')::jsonb -> 'orders') o));
select pg_temp.chk('D5 the board quantities equal what the customer ordered', (select (o -> 'items' -> 0 ->> 'qty')::int = 5 from jsonb_array_elements(pg_temp.c('board')::jsonb -> 'orders') o where o ->> 'id' = pg_temp.c('P4')));
select pg_temp.chk('D5 the board shows the customer''s phone and instruction, and finished orders are left out', (select bool_and(o ->> 'contact_phone' is not null) from jsonb_array_elements(pg_temp.c('board')::jsonb -> 'orders') o)
  and not exists (select 1 from jsonb_array_elements(pg_temp.c('board')::jsonb -> 'orders') o where o ->> 'status' in ('completed', 'cancelled', 'returned')));
select pg_temp.chk('D5 the overdue order is on the board even though its day is behind us', exists (select 1 from jsonb_array_elements(pg_temp.c('board')::jsonb -> 'orders') o where o ->> 'id' = pg_temp.c('F1')));
select pg_temp.chk('D5 "mine" lists only my orders', (select count(*) = 0 or bool_and(o ->> 'assigned_to' = pg_temp.c('S')) from jsonb_array_elements(public.preorder_prep_board(true, 14) -> 'orders') o));
select pg_temp.chk('D5 a short window leaves later days out', not exists (select 1 from jsonb_array_elements(public.preorder_prep_board(false, 1) -> 'orders') o where (o ->> 'pickup_at')::timestamptz > pg_temp.sq(1, '00:00') and o ->> 'id' = pg_temp.c('P4')));

-- ================================================================================================ N. time-based notices (the sweep)
select pg_temp.sx($q$update public.line_settings set enabled = false$q$);
-- build four orders in known states: confirmed soon (reminder + due), late (pickup passed), ready and uncollected (overdue), and a distant one (nothing)
select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.put('N1', pg_temp.oid(pg_temp.place('pre-test-a-n1', 1, pg_temp.sq(12, '10:00'))));
select pg_temp.put('N2', pg_temp.oid(pg_temp.place('pre-test-a-n2', 1, pg_temp.sq(12, '11:00'))));
select pg_temp.put('N3', pg_temp.oid(pg_temp.place('pre-test-a-n3', 1, pg_temp.sq(12, '12:00'))));
select pg_temp.put('N4', pg_temp.oid(pg_temp.place('pre-test-a-n4', 1, pg_temp.sq(12, '13:00'))));
select pg_temp.sx(format($q$update public.shop_orders set status = 'confirmed', pickup_at = now() + interval '60 minutes' where id = %L$q$, pg_temp.c('N1')));
select pg_temp.sx(format($q$update public.shop_orders set status = 'preparing', pickup_at = now() - interval '10 minutes' where id = %L$q$, pg_temp.c('N2')));
select pg_temp.sx(format($q$update public.shop_orders set status = 'ready', pickup_at = now() - interval '2 hours' where id = %L$q$, pg_temp.c('N3')));
select pg_temp.sx(format($q$update public.shop_orders set status = 'confirmed' where id = %L$q$, pg_temp.c('N4')));
select pg_temp.put('sw1', pg_temp.sweep()::text);
select pg_temp.chk('N1 the customer gets a reminder before the pickup', pg_temp.notices(pg_temp.c('N1'), 'reminder', 'customer') = 1);
select pg_temp.chk('N1 staff are warned when it is not started', pg_temp.notices(pg_temp.c('N1'), 'due_soon', 'staff') = 1);
select pg_temp.chk('N1 an order that is already late is reported', pg_temp.notices(pg_temp.c('N2'), 'late', 'staff') = 1);
select pg_temp.chk('N1 a ready order nobody collected is reported', pg_temp.notices(pg_temp.c('N3'), 'overdue_pickup', 'staff') = 1 and pg_temp.notices(pg_temp.c('N3'), 'late', 'staff') = 0);
select pg_temp.chk('N1 a distant order gets nothing', pg_temp.notices(pg_temp.c('N4'), 'reminder', 'customer') = 0 and pg_temp.notices(pg_temp.c('N4'), 'due_soon', 'staff') = 0);
select pg_temp.put('n_before', pg_temp.sv('select count(*) from public.preorder_notices'));
select pg_temp.sweep();
select pg_temp.sweep();
select pg_temp.chk('N2 running the sweep again says nothing twice', pg_temp.sv($q$select count(*) from public.preorder_notices$q$) = pg_temp.c('n_before'));
select pg_temp.sx(format($q$update public.shop_orders set pickup_at = now() + interval '90 minutes' where id = %L$q$, pg_temp.c('N1')));
select pg_temp.sweep();
select pg_temp.chk('N2 a rescheduled order is a new occasion: its reminder is due again', pg_temp.notices(pg_temp.c('N1'), 'reminder', 'customer') = 2);
select pg_temp.sx(format($q$insert into public.preorder_assignments (order_id, assigned_to) values (%L, %L)$q$, pg_temp.c('N2'), pg_temp.c('S')));
select pg_temp.sx(format($q$update public.shop_orders set pickup_at = now() - interval '20 minutes' where id = %L$q$, pg_temp.c('N2')));
select pg_temp.sweep();
select pg_temp.chk('N2 the assignee gets their own copy of the "late" alert', pg_temp.sv(format($q$select count(*) from public.preorder_notices where order_id = %L and kind = 'late' and profile_id = %L$q$, pg_temp.c('N2'), pg_temp.c('S')))::int = 1);
select pg_temp.sx($q$update public.preorder_settings set enabled = false where id$q$);
select pg_temp.chk('N3 the sweep does nothing while the feature is off', pg_temp.sweep() ->> 'skipped' = 'off');
select pg_temp.sx($q$update public.preorder_settings set enabled = true where id$q$);
-- the staff inbox
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('N4 the staff inbox lists the latest notices with their order number', jsonb_array_length(public.preorder_admin_notices(10)) = 10 and (public.preorder_admin_notices(10) -> 0 ? 'order_no'));
select pg_temp.chk('N4 the inbox is newest first', (select bool_and((a ->> 'at')::timestamptz >= (b ->> 'at')::timestamptz) from (select public.preorder_admin_notices(5) n) x, lateral (select n -> 0 a, n -> 1 b) y));
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('N4 a customer cannot read the staff inbox', $q$select public.preorder_admin_notices(5)$q$, '%not allowed%');

-- ================================================================================================ X. isolation, security and the order pages
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('X1 a customer cannot open someone else''s order', format($q$select public.shop_my_order(%L::uuid)$q$, pg_temp.c('P4')), '%Order not found%');
select pg_temp.chk('X1 "my scheduled pickups" holds only my future preorders, soonest first', (select count(*) >= 1 and bool_and(o ->> 'order_type' = 'preorder' and o ->> 'status' not in ('completed', 'cancelled', 'returned')) from jsonb_array_elements(public.shop_my_orders('preorder', 50, 0) -> 'orders') o)
  and not exists (select 1 from jsonb_array_elements(public.shop_my_orders('preorder', 50, 0) -> 'orders') o where o ->> 'id' in (pg_temp.c('P1'), pg_temp.c('P4'))));
select pg_temp.chk('X1 the other filters still work and see regular and preorders alike', (public.shop_my_orders('all', 50, 0) ->> 'total')::int >= (public.shop_my_orders('preorder', 50, 0) ->> 'total')::int
  and (public.shop_my_orders('done', 50, 0) ->> 'total')::int >= 1 and (public.shop_my_orders('cancelled', 50, 0) ->> 'total')::int >= 1);
select pg_temp.chk('X1 a customer''s order page shows their own notices and never the staff''s', (select bool_and(n ->> 'kind' in ('placed', 'confirmed', 'preparing', 'ready', 'completed', 'rejected', 'cancelled_by_shop', 'rescheduled_by_shop', 'reminder')) and count(*) >= 1
  from jsonb_array_elements(public.shop_my_order(pg_temp.c('P3')::uuid) -> 'notices') n));
select pg_temp.chk('X1 no staff-only key reaches the customer', not ((public.shop_my_order(pg_temp.c('P3')::uuid) ? 'assigned_to') or (public.shop_my_order(pg_temp.c('P3')::uuid) ? 'customer') or (public.shop_my_order(pg_temp.c('P3')::uuid) ? 'preorder')));
select pg_temp.err_like('X2 a customer cannot run the dashboard', $q$select public.preorder_admin_dashboard(null)$q$, '%not allowed%');
select pg_temp.err_like('X2 a customer cannot run the list', $q$select public.preorder_admin_list()$q$, '%not allowed%');
select pg_temp.err_like('X2 a customer cannot open the board', $q$select public.preorder_prep_board()$q$, '%not allowed%');
select pg_temp.err_like('X2 a customer cannot tick the checklist', format($q$select public.preorder_prep_set(%L::uuid, 1, true)$q$, pg_temp.c('P4')), '%not allowed%');
select pg_temp.err_like('X2 a customer cannot move a pickup as staff', format($q$select public.preorder_admin_reschedule(%L::uuid, %L::timestamptz, 'x')$q$, pg_temp.c('P4'), pg_temp.sq(3, '13:00')), '%not allowed%');
select pg_temp.err_like('X2 a customer cannot read the staff order view', format($q$select public.shop_admin_order(%L::uuid)$q$, pg_temp.c('P1')), '%not allowed%');
select pg_temp.err_like('X2 a customer cannot call an internal helper', $q$select public.preorder_notify('placed', gen_random_uuid(), 'staff', 'x')$q$, '%permission denied%');
select pg_temp.err_like('X2 a customer cannot read the notices table', $q$select * from public.preorder_notices$q$, '%permission denied%');
select pg_temp.err_like('X2 a customer cannot write the settings table', $q$update public.preorder_settings set enabled = true$q$, '%permission denied%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('X3 the staff order view carries the preorder block, the customer and the notices with LINE delivery state', (public.shop_admin_order(pg_temp.c('P4')::uuid) -> 'preorder' ->> 'order_no') is not null
  and (public.shop_admin_order(pg_temp.c('P4')::uuid) -> 'customer' ->> 'name') is not null and jsonb_array_length(public.shop_admin_order(pg_temp.c('P4')::uuid) -> 'notices') >= 1
  and (public.shop_admin_order(pg_temp.c('P4')::uuid) -> 'notices' -> 0 ? 'line'));
select pg_temp.chk('X3 the Online shop order list still works and now carries the pickup time', (select bool_and(o ? 'order_type' and o ? 'pickup_at') and count(*) > 0 from jsonb_array_elements(public.shop_admin_orders(null, null, 100, 0) -> 'orders') o)
  and (public.shop_admin_orders(null, null, 100, 0) ->> 'total')::int = pg_temp.sv('select count(*) from public.shop_orders')::int);
select pg_temp.chk('X3 the order card data for LINE tells a preorder from a regular order', (pg_temp.card(pg_temp.c('P4')) ->> 'order_type') = 'preorder' and (pg_temp.card(pg_temp.c('P4')) ->> 'pickup_at') is not null
  and (pg_temp.card(pg_temp.c('R1')) ->> 'order_type') = 'regular');
select pg_temp.chk('X3 the LINE settings accept the new switches and still refuse unknown ones', (public.line_admin_save_settings('{"events": {"preorder": false}}'::jsonb) -> 'events' ->> 'preorder') = 'false');
select pg_temp.err_like('X3 an unknown LINE event is still refused', $q$select public.line_admin_save_settings('{"events": {"nope": true}}'::jsonb)$q$, 'INVALID_SETTING%');

-- ================================================================================================ B. regular orders behave as before
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('B1 a regular pick-up order walks the old path: new, confirmed, preparing, packed, ready, completed',
  public.shop_admin_set_status(pg_temp.c('R1')::uuid, 'confirmed') ->> 'status' = 'confirmed');
select pg_temp.chk('B1 ...preparing', public.shop_admin_set_status(pg_temp.c('R1')::uuid, 'preparing', null, 'test') ->> 'status' = 'preparing');
select pg_temp.err_like('B1 a regular order cannot skip "packed"', format($q$select public.shop_admin_set_status(%L::uuid, 'ready', null, 'test')$q$, pg_temp.c('R1')), '%cannot become%');
select pg_temp.chk('B1 ...packed, ready, completed', public.shop_admin_set_status(pg_temp.c('R1')::uuid, 'packed', null, 'test') ->> 'status' = 'packed' and public.shop_admin_set_status(pg_temp.c('R1')::uuid, 'ready', null, 'test') ->> 'status' = 'ready'
  and public.shop_admin_set_status(pg_temp.c('R1')::uuid, 'completed', null, 'test') ->> 'status' = 'completed');
select pg_temp.chk('B1 a regular order has no preorder notices and no assignment', pg_temp.sv(format($q$select count(*) from public.preorder_notices where order_id in (%L, %L, %L)$q$, pg_temp.c('R1'), pg_temp.c('R2'), pg_temp.c('R3')))::int = 0
  and pg_temp.sv(format($q$select count(*) from public.preorder_assignments where order_id = %L$q$, pg_temp.c('R1')))::int = 0);
select pg_temp.chk('B1 a regular order''s JSON has no schedule', (pg_temp.oj(pg_temp.c('R1')) ->> 'pickup_at') is null and (pg_temp.oj(pg_temp.c('R1')) -> 'change') = 'null'::jsonb and (pg_temp.oj(pg_temp.c('R1')) ->> 'prep') is null);
select pg_temp.chk('B1 confirming a regular order after hours is not blocked by any pickup rule', public.shop_admin_set_status(pg_temp.c('R2')::uuid, 'confirmed') ->> 'status' = 'confirmed');
select pg_temp.chk('B1 a regular delivery order is cancelled by the shop with the old kind logic', public.shop_admin_set_status(pg_temp.c('R2')::uuid, 'cancelled', 'Cannot deliver') ->> 'cancel_kind' = 'staff');
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.chk('B2 a customer cancels a regular new order as before', public.shop_cancel_my_order(pg_temp.c('R3')::uuid, 'changed my mind') ->> 'cancel_kind' = 'customer');
select pg_temp.chk('B2 the old nine-argument style call (named, no pickup) still resolves to one function', (select count(*) from pg_proc where proname = 'shop_place_order' and pronamespace = 'public'::regnamespace) = 1);
select pg_temp.chk('B3 existing orders are untouched', pg_temp.sv($q$select count(*) from public.shop_orders where order_type = 'regular'$q$)::int >= pg_temp.c('regular_before')::int);

-- the result
do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'PREORDERS_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
