-- Tests for 20261121100000_rewards_core.sql (rules, promotion packs, points ledger, per-bill board picks, settle), run inside ONE transaction that is rolled back:
--   <migration> ; <this file>      (scripts/run-rewards-core-sql-tests.sh on the Supabase project, or node scripts/local-pg/run.mjs on the local PostgreSQL)
-- Nothing persists: the last statement raises an exception that carries the result table.
-- Customers A, B, C, D are real shop members, S is a SUPER_ADMIN (also the finance manager that posts and reverses payments), AD is an ADMIN.
-- Orders are written straight into the tables by pg_temp.mk_order (exact bill amounts such as 299.99); payments always go through the REAL finance
-- functions (finance_record_payment + finance_post_evidence, finance_reverse_receipt), so the triggers are tested the way production fires them.
-- Sections: R0 structure, R1 switched off, R2 settings, R3 saving rules (R3b partial patches and frozen rules), R4 per-bill picks, R5 scope, R6 packs, R7 reversal,
--           R9 windows / inactive rules / caps / cumulative / inactive SKUs, R10 searches, R11 preview and simulate, R8 settle again and again, R12 a failing settle never blocks a payment,
--           R1b switched off again, R13 security, R14 pack options at creation.
-- Test-side note: a function and a table read in ONE statement see the same snapshot, so results of state-changing calls are read back in a following statement.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
create temp sequence t_seq;
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;

create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; d text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then
    get stacked diagnostics d = pg_exception_detail; m := sqlerrm || coalesce(' | ' || d, ''); perform pg_temp.chk(p_test, m ilike p_pat, m);
  end;
end $$;
create or replace function pg_temp.err_state(p_test text, p_sql text, p_state text) returns void language plpgsql as $$
declare m text; s text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_state || ')');
  exception when others then get stacked diagnostics m = message_text; s := sqlstate; perform pg_temp.chk(p_test, s = p_state, s || ' ' || m);
  end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.act(k text) returns void language sql as $$ select pg_temp.as_user(pg_temp.c($1)::uuid) $$;
-- the customer's own view (acts as that profile; the function is SECURITY DEFINER so it also works from the owner session)
create or replace function pg_temp.my(k text) returns jsonb language plpgsql as $$
begin perform pg_temp.act(k); return public.rw_my_rewards(); end $$;
-- the entry of one rule in a rewards document / one bill of it
create or replace function pg_temp.pick(doc jsonb, p_rule text) returns jsonb language sql as $$
  select e from jsonb_array_elements(doc -> 'picks') e where e ->> 'rule_id' = p_rule $$;
create or replace function pg_temp.bill(doc jsonb, p_rule text, p_order text) returns jsonb language sql as $$
  select b from jsonb_array_elements(pg_temp.pick(doc, p_rule) -> 'bills') b where b ->> 'order_id' = p_order $$;
-- owner-side counters
create or replace function pg_temp.rights(p_profile uuid, p_rule uuid, p_order uuid) returns int language sql as $$
  select count(*)::int from public.rw_entitlements where profile_id = $1 and rule_id = $2 and source_order_id = $3 and status in ('available', 'used') $$;
create or replace function pg_temp.pts(p_profile uuid, p_key text, p_order uuid) returns int language sql as $$
  select coalesce(sum(points), 0)::int from public.rw_points_ledger where profile_id = $1 and source_key = $2 and order_id is not distinct from $3 $$;
create or replace function pg_temp.balance(p_profile uuid) returns int language sql as $$
  select coalesce(sum(points), 0)::int from public.rw_points_ledger where profile_id = $1 $$;
create or replace function pg_temp.total_rows() returns bigint language sql as $$
  select (select count(*) from public.rw_points_ledger) + (select count(*) from public.rw_entitlements) $$;
-- a rule created by an ADMIN (proves ADMIN may write rules)
create or replace function pg_temp.mkrule(p jsonb) returns uuid language plpgsql as $$
begin perform pg_temp.act('AD'); return (public.rw_admin_save_rule(null, p) ->> 'id')::uuid; end $$;
-- an order straight into the tables: p_lines = [{"sku": code, "qty": n, "price": unit price}], the invoice bills items + shipping
create or replace function pg_temp.mk_order(p_profile uuid, p_lines jsonb, p_created timestamptz default now(), p_ship numeric default 0) returns uuid language plpgsql as $$
declare fin uuid; inv uuid; oid uuid := gen_random_uuid(); sub numeric; n int := nextval('pg_temp.t_seq'); ln int := 0; l jsonb; ono text := 'SO-T-' || lpad(n::text, 6, '0');
begin
  select id into fin from public.finance_customers where profile_id = p_profile;
  if fin is null then
    insert into public.finance_customers (code, name, profile_id) values ('T-' || substr(replace(p_profile::text, '-', ''), 1, 12), 'Test ' || substr(p_profile::text, 1, 4), p_profile) returning id into fin;
  end if;
  select sum((x ->> 'price')::numeric * (x ->> 'qty')::int) into sub from jsonb_array_elements(p_lines) x;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref)
    values ('INV-T-' || lpad(n::text, 6, '0'), fin, (p_created at time zone 'Asia/Bangkok')::date, (p_created at time zone 'Asia/Bangkok')::date + 30, sub + p_ship, 'Test order ' || ono, ono) returning id into inv;
  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone, subtotal, shipping_fee, total, invoice_id, created_at)
    values (oid, ono, p_profile, fin, 'test-key-' || lpad(n::text, 8, '0'), 'x', 'pickup', 'Test', '0811111111', sub, p_ship, sub + p_ship, inv, p_created);
  for l in select * from jsonb_array_elements(p_lines) loop
    ln := ln + 1;
    insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total)
      values (oid, ln, l ->> 'sku', 'Test ' || (l ->> 'sku'), 'pcs', (l ->> 'price')::numeric, (l ->> 'qty')::int, (l ->> 'price')::numeric * (l ->> 'qty')::int);
  end loop;
  return oid;
end $$;
-- pay the invoice of an order in full (or p_amount) through the real finance functions, acting as the finance manager S; returns the receipt id
create or replace function pg_temp.pay(p_order uuid, p_amount numeric default null) returns uuid language plpgsql as $$
declare o public.shop_orders; ev jsonb; rid uuid;
begin
  select * into o from public.shop_orders where id = p_order;
  perform pg_temp.act('S');
  ev := public.finance_record_payment(o.invoice_id, 'transfer', coalesce(p_amount, o.total), now(), 'REF' || replace(gen_random_uuid()::text, '-', ''), null, 'test payment');
  perform public.finance_post_evidence((ev ->> 'evidence_id')::uuid, null);
  select id into rid from public.finance_receipts where invoice_id = o.invoice_id and status = 'posted' order by created_at desc limit 1;
  return rid;
end $$;
create or replace function pg_temp.reverse(p_receipt uuid) returns void language plpgsql as $$
begin perform pg_temp.act('S'); perform public.finance_reverse_receipt(p_receipt, 'test reversal'); end $$;
create or replace function pg_temp.inv_code(p_order uuid) returns int language sql as $$
  select (public.finance_invoice_state_raw(o.invoice_id) ->> 'status_code')::int from public.shop_orders o where o.id = $1 $$;
-- fingerprint of every finance / order row of one order (settle must never touch them)
create or replace function pg_temp.fin_fp(p_order uuid) returns text language sql as $$
  select md5(coalesce((select jsonb_agg(to_jsonb(x) order by x.id)::text from public.finance_receipts x where x.invoice_id = o.invoice_id), '')
    || coalesce((select jsonb_agg(to_jsonb(x) order by x.id)::text from public.finance_allocations x where x.invoice_id = o.invoice_id), '')
    || (select to_jsonb(i)::text from public.finance_invoices i where i.id = o.invoice_id) || to_jsonb(o)::text)
  from public.shop_orders o where o.id = $1 $$;
create or replace function pg_temp.price(p_sku text) returns numeric language sql as $$
  select public.shop_price_of(s.ecommerce_price, s.selling_price, s.retail_price) from public.sku_registry s where s.sku_code = $1 $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'C', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 2 limit 1;
insert into t_ctx select 'D', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 3 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'AD', id::text from public.profiles where role = 'ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx values ('EV', gen_random_uuid()::text);
insert into t_ctx values ('lt0', current_setting('lock_timeout'));
insert into public.shop_settings (id) values (true) on conflict (id) do nothing;
update public.shop_settings set require_payment_slip = false;
select pg_temp.chk('R0 four shop members, a super admin and an admin are there to act as', (select count(*) from t_ctx where k in ('A', 'B', 'C', 'D', 'S', 'AD')) = 6, (select string_agg(k, ',') from t_ctx));
select pg_temp.chk('R0 the priced real SKUs the tests use exist', pg_temp.price('FG-000001') = 320 and pg_temp.price('FG-000041') > 0 and pg_temp.price('FG-000105') > 0 and pg_temp.price('FG-000124') > 0, null);

-- =========================================================================================== R0 structure
select pg_temp.chk('R0 all seven tables exist, each with row-level security and NO policy',
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
     and c.relname in ('rw_settings', 'promo_packs', 'promo_pack_items', 'rw_rules', 'rw_points_ledger', 'rw_entitlements', 'rw_events_log')) = 7
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('rw_settings', 'promo_packs', 'promo_pack_items', 'rw_rules', 'rw_points_ledger', 'rw_entitlements', 'rw_events_log')), null);
select pg_temp.chk('R0 neither anon nor signed-in members have any privilege on them',
  not exists (select 1 from unnest(array['rw_settings', 'promo_packs', 'promo_pack_items', 'rw_rules', 'rw_points_ledger', 'rw_entitlements', 'rw_events_log']) t(n),
                unnest(array['anon', 'authenticated']) r(role_name), unnest(array['select', 'insert', 'update', 'delete']) p(priv)
              where has_table_privilege(r.role_name, 'public.' || t.n, p.priv)), null);
select pg_temp.chk('R0 every rw_ function is security definer with search_path = public',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' and not (p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}')))), (select string_agg(p.proname, ',') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' and not (p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}')))));
select pg_temp.chk('R0 anon can execute no rw_ function and members only the client-callable ones',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' and has_function_privilege('anon', p.oid, 'execute'))
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('rw_settle_profile', 'rw_rule_amount', 'rw_bills', 'rw_points_targets', 'rw_log', 'rw_is_staff', 'rw_is_super', 'rw_require_staff', 'rw_require_super') and has_function_privilege('authenticated', p.oid, 'execute'))
  and has_function_privilege('authenticated', 'public.rw_my_rewards()', 'execute') and has_function_privilege('authenticated', 'public.rw_admin_rules()', 'execute')
  and has_function_privilege('authenticated', 'public.rw_settings_public()', 'execute'),
  (select string_agg(p.proname, ',') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' and has_function_privilege('anon', p.oid, 'execute')));
select pg_temp.chk('R0 the settings row exists and everything ships switched off', (select enabled is false and boards_enabled is false from public.rw_settings where id), null);

-- =========================================================================================== R1 switched off: zero effect
-- the rules exist (staff can prepare them while the master switch is off), a customer pays, nothing happens
insert into t_ctx select 'R_PICK', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T pick per bill', 'spend_step', 300, 'reward_amount', 1, 'event_id', pg_temp.c('EV'),
  'only_profile_ids', jsonb_build_array(pg_temp.c('B'), pg_temp.c('C'), pg_temp.c('D'))))::text;
insert into t_ctx select 'R_PT', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points per 100', 'spend_step', 100, 'reward_amount', 1,
  'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'oDark', pg_temp.mk_order(pg_temp.c('A')::uuid, '[{"sku":"FG-000001","qty":1,"price":350}]')::text;
insert into t_ctx select 'rcDark', pg_temp.pay(pg_temp.c('oDark')::uuid)::text;
select pg_temp.chk('R1 the payment went through the real finance functions: invoice fully paid', pg_temp.inv_code(pg_temp.c('oDark')::uuid) = 5, null);
select pg_temp.chk('R1 with rewards switched off a paid order creates no point, no right and no log row',
  pg_temp.total_rows() = 0 and not exists (select 1 from public.rw_events_log where action like 'settle%'), pg_temp.total_rows()::text);
select pg_temp.chk('R1 rw_settle_profile does nothing while off', public.rw_settle_profile(pg_temp.c('A')::uuid) = 0 and pg_temp.total_rows() = 0, null);
select pg_temp.chk('R1 a customer sees "off" and no data', (pg_temp.my('A') ->> 'enabled')::boolean is false and (pg_temp.my('A') ->> 'points')::int = 0 and jsonb_array_length(pg_temp.my('A') -> 'picks') = 0, pg_temp.my('A')::text);
select pg_temp.chk('R1 the cart preview is empty while off', (public.rw_preview_cart('[{"sku_code":"FG-000001","qty":2}]') ->> 'enabled')::boolean is false and jsonb_array_length(public.rw_preview_cart('[{"sku_code":"FG-000001","qty":2}]') -> 'lines') = 0, null);
select pg_temp.act('AD');
select pg_temp.err_like('R1 staff re-settle says rewards are off', $q$select public.rw_admin_resettle(null)$q$, '%REWARDS_OFF%');
insert into t_ctx select 'fpDark', pg_temp.fin_fp(pg_temp.c('oDark')::uuid);

-- =========================================================================================== R2 settings
select pg_temp.act('AD');
select pg_temp.err_state('R2 an ADMIN cannot change the master switch', $q$select public.rw_admin_save_settings('{"enabled": true}')$q$, '42501');
select pg_temp.act('A');
select pg_temp.err_state('R2 a customer cannot change the master switch', $q$select public.rw_admin_save_settings('{"enabled": true}')$q$, '42501');
select pg_temp.act('S');
select pg_temp.err_like('R2 an unknown setting is refused', $q$select public.rw_admin_save_settings('{"turbo": true}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R2 a non-boolean value is refused', $q$select public.rw_admin_save_settings('{"enabled": "yes"}')$q$, '%BAD_RULE%');
insert into t_ctx select 'sw', public.rw_admin_save_settings('{"enabled": true, "boards_enabled": true}')::text;
select pg_temp.chk('R2 a SUPER_ADMIN switches rewards and boards on and gets both flags back', pg_temp.c('sw')::jsonb = '{"enabled": true, "boards_enabled": true}'::jsonb and (select enabled and boards_enabled from public.rw_settings where id), pg_temp.c('sw'));
select pg_temp.act('A');
select pg_temp.chk('R2 every signed-in member can read the two flags', public.rw_settings_public() = '{"enabled": true, "boards_enabled": true}'::jsonb, public.rw_settings_public()::text);
select pg_temp.chk('R2 the switch is audited', exists (select 1 from public.rw_events_log where action = 'settings.save' and actor = pg_temp.c('S')::uuid), null);
-- enabling settles the dark-period bill of A only when something asks: staff asks, and the finance rows stay byte-identical
select pg_temp.act('AD');
select pg_temp.chk('R2 staff re-settle of A grants the points of the bill that was paid while off (350 -> 3)', (public.rw_admin_resettle(pg_temp.c('A')::uuid) ->> 'changed')::int >= 1 and pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PT'), pg_temp.c('oDark')::uuid) = 3,
  pg_temp.balance(pg_temp.c('A')::uuid)::text);
select pg_temp.chk('R2 settling never touches the order, invoice, receipt or allocation rows (fingerprint identical)', pg_temp.fin_fp(pg_temp.c('oDark')::uuid) = pg_temp.c('fpDark'), null);

-- =========================================================================================== R3 saving rules
select pg_temp.act('AD');
select pg_temp.err_like('R3 a rule needs a name', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"  ","spend_step":100,"reward_amount":1}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 a step of 0 is refused', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":0,"reward_amount":1}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 a negative step is refused', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":-5,"reward_amount":1}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 reward_amount must be at least 1', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":0}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 reward_amount must be a whole number', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1.5}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 max_per_order must be at least 1', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"max_per_order":0}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 max_per_order must be a whole number', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"max_per_order":2.5}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 number picks cannot be cumulative', format($q$select public.rw_admin_save_rule(null, '{"kind":"board_pick","name":"x","spend_step":300,"reward_amount":1,"basis":"cumulative","event_id":"%s"}')$q$, pg_temp.c('EV')), '%BAD_RULE%');
select pg_temp.err_like('R3 number picks need an event', $q$select public.rw_admin_save_rule(null, '{"kind":"board_pick","name":"x","spend_step":300,"reward_amount":1}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 points rules take no event', format($q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"event_id":"%s"}')$q$, pg_temp.c('EV')), '%BAD_RULE%');
select pg_temp.err_like('R3 board_slots must be 1..3', format($q$select public.rw_admin_save_rule(null, '{"kind":"board_pick","name":"x","spend_step":300,"reward_amount":1,"event_id":"%s","board_slots":[4]}')$q$, pg_temp.c('EV')), '%BAD_RULE%');
select pg_temp.err_like('R3 an unknown key is refused', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"flavour":"mint"}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 an unknown kind is refused', $q$select public.rw_admin_save_rule(null, '{"kind":"coupon","name":"x","spend_step":100,"reward_amount":1}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 an allow-list entry that is not a uuid is refused', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"only_profile_ids":["nope"]}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 an allow-list entry that is not a member is refused', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"only_profile_ids":["00000000-0000-4000-8000-000000000001"]}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 an empty allow-list is refused (null means everyone)', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"only_profile_ids":[]}')$q$, '%BAD_RULE%');
select pg_temp.err_like('R3 the end cannot be before the start', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"starts_at":"2026-01-10T00:00:00Z","ends_at":"2026-01-01T00:00:00Z"}')$q$, '%BAD_RULE%');
select pg_temp.chk('R3 FG-000030 really is inactive in the data these tests run on', (select status from public.sku_registry where sku_code = 'FG-000030') = 'inactive', null);
select pg_temp.err_like('R3 an INACTIVE SKU cannot be put in a rule (include list)', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"include_skus":["FG-000001","FG-000030"]}')$q$, '%INACTIVE_SKU: FG-000030%');
select pg_temp.err_like('R3 a SKU that does not exist cannot be put in a rule either', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"include_skus":["FG-999999"]}')$q$, '%INACTIVE_SKU: FG-999999%');
select pg_temp.chk('R3 nothing was saved by the refused calls', (select count(*) from public.rw_rules) = 2, (select count(*) from public.rw_rules)::text);
-- clarification 1: a new rule never reaches back
select pg_temp.chk('R3 a new rule without a start gets starts_at = now()', (select abs(extract(epoch from (r ->> 'starts_at')::timestamptz - now())) < 2 from (select public.rw_admin_save_rule(null, '{"kind":"points","name":"T start check","spend_step":100,"reward_amount":1,"only_profile_ids":null,"active":false}') r) x), null);
select pg_temp.chk('R3 the saved rule comes back in the contract shape',
  (select r ?& array['id', 'kind', 'name', 'active', 'starts_at', 'ends_at', 'spend_step', 'reward_amount', 'basis', 'max_per_order', 'category_codes', 'include_skus', 'exclude_skus', 'include_packs', 'only_profile_ids', 'event_id', 'board_slots', 'stats']
     and r -> 'stats' ?& array['bills', 'granted'] and r ->> 'basis' = 'per_bill' and jsonb_typeof(r -> 'category_codes') = 'array' and (r ->> 'spend_step')::numeric = 100
   from (select (select e from jsonb_array_elements(public.rw_admin_rules()) e where e ->> 'name' = 'T start check') r) x), null);
select pg_temp.chk('R3 rw_admin_rules lists every rule', jsonb_array_length(public.rw_admin_rules()) = 3, null);
select pg_temp.chk('R3 rule saves are audited', (select count(*) from public.rw_events_log where action = 'rule.save') >= 3, null);

-- =========================================================================================== R3b partial patches (the UI sends only the keys it changed)
create or replace function pg_temp.rule(p_id text) returns jsonb language sql as $$ select e from jsonb_array_elements(public.rw_admin_rules()) e where e ->> 'id' = $1 $$;
create or replace function pg_temp.same_but(a jsonb, b jsonb, variadic p_keys text[]) returns boolean language sql as $$ select (a - p_keys - 'stats') = (b - p_keys - 'stats') $$;
select pg_temp.act('AD');
insert into t_ctx select 'R_EXT', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T extendable window', 'spend_step', 100, 'reward_amount', 1,
  'ends_at', now() + interval '10 days', 'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'rs0', public.rw_admin_resettle(pg_temp.c('A')::uuid)::text;
select pg_temp.chk('R3b the rule has an end date, and A paid bill gives it its first ledger row (350 -> 3): the rule is now USED',
  (pg_temp.c('rs0')::jsonb ->> 'changed')::int >= 1 and public.rw_rule_used(pg_temp.c('R_EXT')::uuid) and pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_EXT'), pg_temp.c('oDark')::uuid) = 3, pg_temp.c('rs0'));
insert into t_ctx select 'b1', pg_temp.rule(pg_temp.c('R_PT'))::text;
insert into t_ctx select 'a1', public.rw_admin_save_rule(pg_temp.c('R_PT')::uuid, '{"active": false}')::text;
select pg_temp.chk('R3b {active:false} alone switches a USED rule off and changes nothing else', (pg_temp.c('a1')::jsonb ->> 'active') = 'false' and pg_temp.same_but(pg_temp.c('a1')::jsonb, pg_temp.c('b1')::jsonb, 'active'), pg_temp.c('a1'));
select pg_temp.chk('R3b {active:true} alone switches it on again', (public.rw_admin_save_rule(pg_temp.c('R_PT')::uuid, '{"active": true}') ->> 'active') = 'true', null);
insert into t_ctx select 'a2', public.rw_admin_save_rule(pg_temp.c('R_PT')::uuid, '{"name": "T points per 100 renamed"}')::text;
select pg_temp.chk('R3b {name} alone renames a USED rule and changes nothing else', (pg_temp.c('a2')::jsonb ->> 'name') = 'T points per 100 renamed' and pg_temp.same_but(pg_temp.c('a2')::jsonb, pg_temp.c('b1')::jsonb, 'name'), pg_temp.c('a2'));
select pg_temp.chk('R3b the old name comes back the same way', (public.rw_admin_save_rule(pg_temp.c('R_PT')::uuid, '{"name": "T points per 100"}') ->> 'name') = 'T points per 100', null);
select pg_temp.chk('R3b a used rule takes a patch that re-sends a frozen value unchanged', (public.rw_admin_save_rule(pg_temp.c('R_PT')::uuid, '{"spend_step": 100, "reward_amount": 1, "basis": "per_bill", "include_skus": []}') ->> 'spend_step')::numeric = 100, null);
insert into t_ctx select 'e0', pg_temp.rule(pg_temp.c('R_EXT'))::text;
insert into t_ctx select 'e1', public.rw_admin_save_rule(pg_temp.c('R_EXT')::uuid, jsonb_build_object('ends_at', now() + interval '20 days'))::text;
select pg_temp.chk('R3b {ends_at: later} alone EXTENDS a used rule and changes nothing else', (pg_temp.c('e1')::jsonb ->> 'ends_at')::timestamptz > (pg_temp.c('e0')::jsonb ->> 'ends_at')::timestamptz and pg_temp.same_but(pg_temp.c('e1')::jsonb, pg_temp.c('e0')::jsonb, 'ends_at'), null);
select pg_temp.err_like('R3b {ends_at: earlier} on a used rule is refused (RULE_USED)', format($q$select public.rw_admin_save_rule(%L, jsonb_build_object('ends_at', now() + interval '5 days'))$q$, pg_temp.c('R_EXT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b adding an end to a used rule that had none is a shortening: refused', format($q$select public.rw_admin_save_rule(%L, jsonb_build_object('ends_at', now() + interval '50 days'))$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.chk('R3b {ends_at: null} removes the end of a used rule (an extension)', (public.rw_admin_save_rule(pg_temp.c('R_EXT')::uuid, '{"ends_at": null}') -> 'ends_at')::text = 'null', null);
-- clarification 2: a used rule is frozen
select pg_temp.err_like('R3b used rule: spend_step cannot change (RULE_USED)', format($q$select public.rw_admin_save_rule(%L, '{"spend_step": 200}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: reward_amount cannot change', format($q$select public.rw_admin_save_rule(%L, '{"reward_amount": 2}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: basis cannot change', format($q$select public.rw_admin_save_rule(%L, '{"basis": "cumulative"}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: max_per_order cannot change', format($q$select public.rw_admin_save_rule(%L, '{"max_per_order": 5}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: the category list cannot change', format($q$select public.rw_admin_save_rule(%L, '{"category_codes": ["Puff"]}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: the include list cannot change', format($q$select public.rw_admin_save_rule(%L, '{"include_skus": ["FG-000001"]}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: the exclude list cannot change', format($q$select public.rw_admin_save_rule(%L, '{"exclude_skus": ["FG-000001"]}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: include_packs cannot change', format($q$select public.rw_admin_save_rule(%L, '{"include_packs": true}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: the customer list cannot change', format($q$select public.rw_admin_save_rule(%L, '{"only_profile_ids": null}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b used rule: the start cannot change', format($q$select public.rw_admin_save_rule(%L, '{"starts_at": "2020-01-01T00:00:00Z"}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: RULE_USED%');
select pg_temp.err_like('R3b a rule is never deleted', format($q$delete from public.rw_rules where id = %L$q$, pg_temp.c('R_PT')), '%never deleted%');
select pg_temp.err_like('R3b the kind of a rule never changes', format($q$select public.rw_admin_save_rule(%L, '{"kind": "board_pick"}')$q$, pg_temp.c('R_PT')), '%BAD_RULE%');
select pg_temp.err_like('R3b an unknown key names itself in the error (rule)', format($q$select public.rw_admin_save_rule(%L, '{"colour": "red"}')$q$, pg_temp.c('R_PT')), '%BAD_RULE: unknown field colour%');
-- an UNUSED rule: any key alone, the rest untouched; null only where the column may be null
insert into t_ctx select 'Rtmp', pg_temp.mkrule('{"kind":"points","name":"T unused","spend_step":250,"reward_amount":2,"max_per_order":4,"category_codes":["Puff"],"active":false}')::text;
insert into t_ctx select 'u0', pg_temp.rule(pg_temp.c('Rtmp'))::text;
select pg_temp.chk('R3b unused rule {name} alone', pg_temp.same_but(public.rw_admin_save_rule(pg_temp.c('Rtmp')::uuid, '{"name":"T unused 2"}'), pg_temp.c('u0')::jsonb, 'name'), null);
select pg_temp.chk('R3b unused rule {spend_step} alone', (public.rw_admin_save_rule(pg_temp.c('Rtmp')::uuid, '{"spend_step":300}') ->> 'spend_step')::numeric = 300
  and (pg_temp.rule(pg_temp.c('Rtmp')) ->> 'reward_amount')::int = 2 and (pg_temp.rule(pg_temp.c('Rtmp')) ->> 'max_per_order')::int = 4
  and pg_temp.rule(pg_temp.c('Rtmp')) -> 'category_codes' = '["Puff"]'::jsonb and (pg_temp.rule(pg_temp.c('Rtmp')) ->> 'active') = 'false', null);
select pg_temp.chk('R3b unused rule {max_per_order: null} clears only the limit', (public.rw_admin_save_rule(pg_temp.c('Rtmp')::uuid, '{"max_per_order": null}') -> 'max_per_order')::text = 'null'
  and (pg_temp.rule(pg_temp.c('Rtmp')) ->> 'spend_step')::numeric = 300 and pg_temp.rule(pg_temp.c('Rtmp')) -> 'category_codes' = '["Puff"]'::jsonb, null);
select pg_temp.chk('R3b unused rule {only_profile_ids} then {only_profile_ids: null} touch only that list',
  (public.rw_admin_save_rule(pg_temp.c('Rtmp')::uuid, jsonb_build_object('only_profile_ids', jsonb_build_array(pg_temp.c('B')))) -> 'only_profile_ids') = jsonb_build_array(pg_temp.c('B'))
  and (public.rw_admin_save_rule(pg_temp.c('Rtmp')::uuid, '{"only_profile_ids": null}') -> 'only_profile_ids')::text = 'null' and (pg_temp.rule(pg_temp.c('Rtmp')) ->> 'name') = 'T unused 2', null);
select pg_temp.chk('R3b unused rule: starts_at keeps its value when absent from the patch', (pg_temp.rule(pg_temp.c('Rtmp')) ->> 'starts_at')::timestamptz = (pg_temp.c('u0')::jsonb ->> 'starts_at')::timestamptz, null);
-- master switch: partial as well
select pg_temp.act('S');
select pg_temp.chk('R2b {boards_enabled:false} alone leaves enabled alone', public.rw_admin_save_settings('{"boards_enabled": false}') = '{"enabled": true, "boards_enabled": false}'::jsonb, null);
select pg_temp.chk('R2b {boards_enabled:true} alone puts it back', public.rw_admin_save_settings('{"boards_enabled": true}') = '{"enabled": true, "boards_enabled": true}'::jsonb, null);
select pg_temp.chk('R2b an empty patch changes nothing', public.rw_admin_save_settings('{}') = '{"enabled": true, "boards_enabled": true}'::jsonb, null);
select pg_temp.err_like('R2b an unknown setting names itself', $q$select public.rw_admin_save_settings('{"turbo": true}')$q$, '%unknown setting turbo%');

-- =========================================================================================== R4 per-bill picks (owner's requirement: floor(eligible bill / step) x reward, bills never combined)
select pg_temp.act('AD');
insert into t_ctx select 'ob_' || a, pg_temp.mk_order(pg_temp.c('B')::uuid, jsonb_build_array(jsonb_build_object('sku', 'FG-000001', 'qty', 1, 'price', a::numeric)))::text
  from unnest(array['299', '300', '599', '600', '850', '900', '1000', '1200', '299.99', '300.00', '599.99']) a;
select pg_temp.pay(v::uuid) from t_ctx where k like 'ob\_%';
select pg_temp.chk('R4 bill of ' || e.a || ' pays out ' || e.n || ' pick(s)', pg_temp.rights(pg_temp.c('B')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('ob_' || e.a)::uuid) = e.n,
  pg_temp.rights(pg_temp.c('B')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('ob_' || e.a)::uuid)::text)
  from (values ('299', 0), ('300', 1), ('599', 1), ('600', 2), ('850', 2), ('900', 3), ('1000', 3), ('1200', 4), ('299.99', 0), ('300.00', 1), ('599.99', 1)) e(a, n);
insert into t_ctx select 'myB', pg_temp.my('B')::text;
select pg_temp.chk('R4 B: earned 18, used 0, remaining 18 (the sum of the bills above)',
  (pg_temp.pick(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK')) ->> 'earned')::int = 18 and (pg_temp.pick(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK')) ->> 'used')::int = 0
  and (pg_temp.pick(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK')) ->> 'remaining')::int = 18, pg_temp.pick(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK'))::text);
select pg_temp.chk('R4 the customer sees, per bill, the eligible amount and the rights it gave (850 -> 2, 299.99 -> 0)',
  (pg_temp.bill(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK'), pg_temp.c('ob_850')) ->> 'eligible_amount')::numeric = 850 and (pg_temp.bill(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK'), pg_temp.c('ob_850')) ->> 'rights')::int = 2
  and (pg_temp.bill(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK'), pg_temp.c('ob_299.99')) ->> 'eligible_amount')::numeric = 299.99 and (pg_temp.bill(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK'), pg_temp.c('ob_299.99')) ->> 'rights')::int = 0
  and pg_temp.bill(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK'), pg_temp.c('ob_850')) ->> 'state' = 'counted', pg_temp.bill(pg_temp.c('myB')::jsonb, pg_temp.c('R_PICK'), pg_temp.c('ob_850'))::text);
select pg_temp.chk('R4 B has exactly one row per right: the numbered places of one bill are 1..n', (select count(*) from public.rw_entitlements where profile_id = pg_temp.c('B')::uuid) = 18
  and (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('ob_1200')::uuid and seq in (1, 2, 3, 4)) = 4, null);
select pg_temp.err_like('R4 a second right for the same rule, bill and place is impossible (unique)', format($q$insert into public.rw_entitlements (rule_id, profile_id, source_order_id, seq) values (%L, %L, %L, 1)$q$, pg_temp.c('R_PICK'), pg_temp.c('B'), pg_temp.c('ob_300')), '%rw_entitlements_once%');
-- two bills of 200 are two bills of 200
insert into t_ctx select 'oc1', pg_temp.mk_order(pg_temp.c('C')::uuid, '[{"sku":"FG-000001","qty":1,"price":200}]')::text;
insert into t_ctx select 'oc2', pg_temp.mk_order(pg_temp.c('C')::uuid, '[{"sku":"FG-000001","qty":1,"price":200}]')::text;
select pg_temp.pay(pg_temp.c('oc1')::uuid), pg_temp.pay(pg_temp.c('oc2')::uuid);
select pg_temp.chk('R4 two bills of 200 earn NOTHING (bills are never combined)', not exists (select 1 from public.rw_entitlements where profile_id = pg_temp.c('C')::uuid)
  and (pg_temp.pick(pg_temp.my('C'), pg_temp.c('R_PICK')) ->> 'earned')::int = 0, null);
-- 700 + 200 = 2 (not 3)
insert into t_ctx select 'od1', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":700}]')::text;
insert into t_ctx select 'od2', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":200}]')::text;
select pg_temp.pay(pg_temp.c('od1')::uuid), pg_temp.pay(pg_temp.c('od2')::uuid);
select pg_temp.chk('R4 a bill of 700 and a bill of 200 earn 2 (700 -> 2, 200 -> 0)', (pg_temp.pick(pg_temp.my('D'), pg_temp.c('R_PICK')) ->> 'earned')::int = 2
  and pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('od1')::uuid) = 2 and pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('od2')::uuid) = 0, null);
-- shipping is not counted: 250 of goods + 50 shipping = an invoice of 300, but the bill is 250
insert into t_ctx select 'od3', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":250}]', now(), 50)::text;
select pg_temp.pay(pg_temp.c('od3')::uuid);
select pg_temp.chk('R4 shipping is not counted: goods 250 + shipping 50 = 300 paid, still 0 picks, and the eligible amount shown is 250',
  (select total from public.shop_orders where id = pg_temp.c('od3')::uuid) = 300 and pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('od3')::uuid) = 0
  and (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('od3')) ->> 'eligible_amount')::numeric = 250, null);
-- an unpaid bill, a part-paid bill: waiting for payment; paid in full: counted
insert into t_ctx select 'od4', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":900}]')::text;
insert into t_ctx select 'od5', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":1200}]')::text;
select pg_temp.pay(pg_temp.c('od4')::uuid, 400);
select pg_temp.chk('R4 a bill that is only part paid (400 of 900) is "waiting_payment" with 0 rights', (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('od4')) ->> 'state') = 'waiting_payment'
  and (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('od4')) ->> 'rights')::int = 0 and pg_temp.inv_code(pg_temp.c('od4')::uuid) = 4, null);
select pg_temp.chk('R4 an unpaid bill is "waiting_payment" and shows what it will earn once paid', (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('od5')) ->> 'state') = 'waiting_payment'
  and (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('od5')) ->> 'eligible_amount')::numeric = 1200 and pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('od5')::uuid) = 0, null);
select pg_temp.pay(pg_temp.c('od4')::uuid, 500);
select pg_temp.chk('R4 once the rest is paid the 900 bill counts: 3 picks', pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('od4')::uuid) = 3
  and (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('od4')) ->> 'state') = 'counted', null);

-- =========================================================================================== R5 scope: exclude list, category, include list (simulate = settle = preview: one function)
create or replace function pg_temp.sim(p_items text, p_rule text) returns jsonb language sql as $$ select e from jsonb_array_elements(public.rw_admin_simulate($1::jsonb)) e where e ->> 'rule_id' = $2 $$;
select pg_temp.act('AD');
insert into t_ctx select 'Rs_cat', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T scope category', 'spend_step', 100, 'reward_amount', 1, 'category_codes', jsonb_build_array('Puff'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'Rs_ex', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T scope exclude', 'spend_step', 100, 'reward_amount', 1, 'exclude_skus', jsonb_build_array('FG-000001'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'Rs_inc', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T scope include', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000041'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'Rs_union', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T scope include plus category', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000041'), 'category_codes', jsonb_build_array('Coil'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'Rs_incex', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T scope include and exclude the same', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000041'), 'exclude_skus', jsonb_build_array('FG-000041'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'Rs_all', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T scope everything', 'spend_step', 100, 'reward_amount', 1, 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx values ('cart', '[{"sku_code":"FG-000001","qty":1},{"sku_code":"FG-000041","qty":1},{"sku_code":"FG-000105","qty":2}]');
select pg_temp.chk('R5 a cart of FG-000001 (Puff), FG-000041 (Pod) and 2 x FG-000105 (Coil) can be priced from the shop view', pg_temp.price('FG-000001') = 320 and pg_temp.price('FG-000041') > 0 and pg_temp.price('FG-000105') > 0, null);
select pg_temp.chk('R5 category scope counts only the Puff line', (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_cat')) ->> 'eligible_amount')::numeric = pg_temp.price('FG-000001'), pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_cat'))::text);
select pg_temp.chk('R5 the exclude list removes FG-000001 and keeps the rest', (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_ex')) ->> 'eligible_amount')::numeric = pg_temp.price('FG-000041') + 2 * pg_temp.price('FG-000105'), null);
select pg_temp.chk('R5 the include list counts only FG-000041', (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_inc')) ->> 'eligible_amount')::numeric = pg_temp.price('FG-000041'), null);
select pg_temp.chk('R5 include list + category are a union (FG-000041 and the Coil lines)', (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_union')) ->> 'eligible_amount')::numeric = pg_temp.price('FG-000041') + 2 * pg_temp.price('FG-000105'), null);
select pg_temp.chk('R5 an SKU in both lists is excluded (the exclude list wins)', (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_incex')) ->> 'eligible_amount')::numeric = 0, null);
select pg_temp.chk('R5 no lists = every line', (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_all')) ->> 'eligible_amount')::numeric = pg_temp.price('FG-000001') + pg_temp.price('FG-000041') + 2 * pg_temp.price('FG-000105'), null);
select pg_temp.chk('R5 the simulated reward is floor(amount / step) x reward', (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_cat')) ->> 'reward')::int = 3 and (pg_temp.sim(pg_temp.c('cart'), pg_temp.c('Rs_cat')) ->> 'next_reward_in')::numeric = 80, null);
-- the same scope through the real settle, for A
insert into t_ctx select 'R_CATPICK', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T pick Puff only', 'spend_step', 100, 'reward_amount', 1, 'event_id', pg_temp.c('EV'),
  'category_codes', jsonb_build_array('Puff'), 'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'R_EX', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points excluding FG-000001', 'spend_step', 100, 'reward_amount', 1, 'exclude_skus', jsonb_build_array('FG-000001'), 'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'R_INC', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points only FG-000041', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000041'), 'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'oScope', pg_temp.mk_order(pg_temp.c('A')::uuid, '[{"sku":"FG-000001","qty":1,"price":400},{"sku":"FG-000041","qty":1,"price":400}]')::text;
select pg_temp.pay(pg_temp.c('oScope')::uuid);
select pg_temp.chk('R5 settle: Puff-only picks count the 400 of Puff (4 picks), not the 400 of Pod', pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_CATPICK')::uuid, pg_temp.c('oScope')::uuid) = 4, null);
select pg_temp.chk('R5 settle: the exclude rule gives 4 points (the Pod line only)', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_EX'), pg_temp.c('oScope')::uuid) = 4, null);
select pg_temp.chk('R5 settle: the include rule gives 4 points (FG-000041 only)', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_INC'), pg_temp.c('oScope')::uuid) = 4, null);
select pg_temp.chk('R5 settle: the unrestricted rule counts both lines (800 -> 8)', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PT'), pg_temp.c('oScope')::uuid) = 8, null);

-- =========================================================================================== R6 promotion packs
create or replace function pg_temp.mkpack(p_name text, p_patch jsonb default '{}') returns text language plpgsql as $$
begin perform pg_temp.act('AD'); return public.rw_admin_create_pack(gen_random_uuid(), p_name, 300, '[{"sku_code":"FG-000124","qty":4}]', p_patch) ->> 'pack_sku_code'; end $$;
select pg_temp.act('AD');
insert into t_ctx values ('pkkey', gen_random_uuid()::text);
insert into t_ctx select 'PK1', public.rw_admin_create_pack(pg_temp.c('pkkey')::uuid, 'T Kratom 4-pack', 300, '[{"sku_code":"FG-000124","qty":4}]', '{}')::text;
insert into t_ctx select 'PK1c', (pg_temp.c('PK1')::jsonb) ->> 'pack_sku_code';
select pg_temp.chk('R6 a pack is created with its own FG code, its price, its contents and the contract shape',
  pg_temp.c('PK1c') ~ '^FG-[0-9]{6}$' and (pg_temp.c('PK1')::jsonb) ?& array['pack_sku_code', 'name', 'price', 'status', 'active', 'eligible_value', 'points_per_pack', 'items', 'sold_packs']
  and ((pg_temp.c('PK1')::jsonb) ->> 'price')::numeric = 300 and (pg_temp.c('PK1')::jsonb) ->> 'status' = 'active' and ((pg_temp.c('PK1')::jsonb) ->> 'sold_packs')::int = 0
  and (pg_temp.c('PK1')::jsonb) -> 'items' -> 0 ->> 'sku_code' = 'FG-000124' and ((pg_temp.c('PK1')::jsonb) -> 'items' -> 0 ->> 'qty')::int = 4 and (pg_temp.c('PK1')::jsonb) ->> 'name' = 'T Kratom 4-pack', pg_temp.c('PK1'));
select pg_temp.chk('R6 the pack is an app-origin finished-goods SKU priced 300 that the shop sells, in the same category as its component',
  (select s.origin = 'app' and s.sku_category = 'FG' and s.selling_price = 300 and public.shop_category_of(s.product_type, s.domain) = public.shop_category_of(c.product_type, c.domain)
          and s.brand is not distinct from c.brand and s.unit_th is not distinct from c.unit_th
     from public.sku_registry s, public.sku_registry c where s.sku_code = pg_temp.c('PK1c') and c.sku_code = 'FG-000124')
  and (select v.price = 300 and v.category = (select category from public.shop_sellable where sku_code = 'FG-000124') from public.shop_sellable v where v.sku_code = pg_temp.c('PK1c')), null);
select pg_temp.chk('R6 the same key again returns the same pack and burns no new code',
  public.rw_admin_create_pack(pg_temp.c('pkkey')::uuid, 'T Kratom 4-pack', 300, '[{"sku_code":"FG-000124","qty":4}]', '{}') ->> 'pack_sku_code' = pg_temp.c('PK1c') and (select count(*) from public.sku_registry where client_ref = pg_temp.c('pkkey')::uuid) = 1, null);
select pg_temp.err_like('R6 the same key with another name is KEY_REUSED', format($q$select public.rw_admin_create_pack(%L, 'Another name', 300, '[{"sku_code":"FG-000124","qty":4}]', '{}')$q$, pg_temp.c('pkkey')), '%KEY_REUSED%');
select pg_temp.err_like('R6 the same key with other contents is KEY_REUSED', format($q$select public.rw_admin_create_pack(%L, 'T Kratom 4-pack', 300, '[{"sku_code":"FG-000124","qty":5}]', '{}')$q$, pg_temp.c('pkkey')), '%KEY_REUSED%');
select pg_temp.err_like('R6 no key -> INVALID_KEY', $q$select public.rw_admin_create_pack(null, 'x', 300, '[{"sku_code":"FG-000124","qty":4}]', '{}')$q$, '%INVALID_KEY%');
select pg_temp.err_like('R6 a pack inside a pack is refused', format($q$select public.rw_admin_create_pack(gen_random_uuid(), 'Pack of packs', 500, '[{"sku_code":"%s","qty":1}]', '{}')$q$, pg_temp.c('PK1c')), '%BAD_PACK%pack%');
select pg_temp.err_like('R6 an inactive component is refused (INACTIVE_SKU)', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-000030","qty":1}]', '{}')$q$, '%INACTIVE_SKU: FG-000030%');
select pg_temp.err_like('R6 an unknown component is refused (INACTIVE_SKU)', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-999999","qty":1}]', '{}')$q$, '%INACTIVE_SKU: FG-999999%');
insert into t_ctx select 'RM1', code from public.sku_issue('RM', 'T raw material', gen_random_uuid(), null);
select pg_temp.err_like('R6 a raw material cannot be a component', format($q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"%s","qty":1}]', '{}')$q$, pg_temp.c('RM1')), '%BAD_PACK%');
select pg_temp.err_like('R6 a product listed twice is refused', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-000124","qty":1},{"sku_code":"FG-000124","qty":2}]', '{}')$q$, '%BAD_PACK%twice%');
select pg_temp.err_like('R6 quantity 0 is refused', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-000124","qty":0}]', '{}')$q$, '%BAD_PACK%');
select pg_temp.err_like('R6 no products is refused', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[]', '{}')$q$, '%BAD_PACK%');
select pg_temp.err_like('R6 a price of 0 is refused', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 0, '[{"sku_code":"FG-000124","qty":1}]', '{}')$q$, '%BAD_PACK%');
select pg_temp.err_like('R6 an eligible value above the price is refused', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 300, '[{"sku_code":"FG-000124","qty":1}]', '{"eligible_value": 400}')$q$, '%BAD_PACK%');
select pg_temp.err_like('R6 points_per_pack must be a whole number >= 0 (-1)', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 300, '[{"sku_code":"FG-000124","qty":1}]', '{"points_per_pack": -1}')$q$, '%BAD_PACK%');
select pg_temp.err_like('R6 points_per_pack must be a whole number (1.5)', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 300, '[{"sku_code":"FG-000124","qty":1}]', '{"points_per_pack": 1.5}')$q$, '%BAD_PACK%');
select pg_temp.err_like('R6 an unknown option names itself in the error (create)', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 300, '[{"sku_code":"FG-000124","qty":1}]', '{"colour": "red"}')$q$, '%BAD_PACK: unknown option colour%');
select pg_temp.err_like('R6 a pack cannot be made part of another pack by a direct insert either', format($q$insert into public.promo_pack_items (pack_sku_code, component_sku_code, qty) select pack_sku_code, %L, 1 from public.promo_packs limit 1$q$, pg_temp.c('PK1c')), '%BAD_PACK%');
select pg_temp.err_like('R6 a pack is never deleted', format($q$delete from public.promo_packs where pack_sku_code = %L$q$, pg_temp.c('PK1c')), '%BAD_PACK%never deleted%');
insert into t_ctx select 'PK2', pg_temp.mkpack('T Kratom 4-pack 3pts', '{"points_per_pack": 3}');
insert into t_ctx select 'PK3', pg_temp.mkpack('T Kratom 4-pack no points', '{"points_per_pack": 0}');
insert into t_ctx select 'PK4', pg_temp.mkpack('T Kratom 4-pack eligible 250', '{"eligible_value": 250}');
insert into t_ctx select 'PK5', pg_temp.mkpack('T Kratom unsold pack');
select pg_temp.chk('R6 rw_admin_packs lists the packs with their contents', jsonb_array_length(public.rw_admin_packs()) = 5, null);
select pg_temp.chk('R6 points_per_pack 0 is kept as 0 (earns nothing), not turned into null', (select (e ->> 'points_per_pack')::int = 0 from jsonb_array_elements(public.rw_admin_packs()) e where e ->> 'pack_sku_code' = pg_temp.c('PK3')), null);
-- rules and orders for A
insert into t_ctx select 'R_PK', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points incl packs', 'spend_step', 100, 'reward_amount', 1, 'category_codes', jsonb_build_array('Kratom drink'),
  'include_packs', true, 'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'R_PKPICK', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T pick incl packs', 'spend_step', 300, 'reward_amount', 1, 'event_id', pg_temp.c('EV'),
  'category_codes', jsonb_build_array('Kratom drink'), 'include_packs', true, 'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'R_NOPACK', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T pick without packs', 'spend_step', 300, 'reward_amount', 1, 'event_id', pg_temp.c('EV'),
  'category_codes', jsonb_build_array('Kratom drink'), 'only_profile_ids', jsonb_build_array(pg_temp.c('A'))))::text;
insert into t_ctx select 'oP1a', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK1c'), 'qty', 1, 'price', 300)))::text;
insert into t_ctx select 'oP1b', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK1c'), 'qty', 2, 'price', 300)))::text;
insert into t_ctx select 'oBott', pg_temp.mk_order(pg_temp.c('A')::uuid, '[{"sku":"FG-000124","qty":4,"price":35}]')::text;
insert into t_ctx select 'oP2a', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK2'), 'qty', 1, 'price', 300)))::text;
insert into t_ctx select 'oP2b', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK2'), 'qty', 2, 'price', 300)))::text;
insert into t_ctx select 'oP3', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK3'), 'qty', 1, 'price', 300)))::text;
insert into t_ctx select 'oP4a', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK4'), 'qty', 1, 'price', 300)))::text;
insert into t_ctx select 'oP4b', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK4'), 'qty', 2, 'price', 300)))::text;
select pg_temp.pay(v::uuid) from t_ctx where k in ('oP1a', 'oP1b', 'oBott', 'oP2a', 'oP2b', 'oP3', 'oP4a', 'oP4b');
create or replace function pg_temp.allpts(p_order text) returns int language sql as $$ select coalesce(sum(points), 0)::int from public.rw_points_ledger where order_id = pg_temp.c($1)::uuid $$;
select pg_temp.chk('R6 1 pack (4 bottles, 300) = 3 points on a 1-per-100 rule, 2 packs = 6, never 4 or 8',
  pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PK'), pg_temp.c('oP1a')::uuid) = 3 and pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PK'), pg_temp.c('oP1b')::uuid) = 6
  and pg_temp.allpts('oP1a') = 3 and pg_temp.allpts('oP1b') = 6, pg_temp.allpts('oP1a')::text || ' / ' || pg_temp.allpts('oP1b')::text);
select pg_temp.chk('R6 the bottles of the pack are not counted again; bottles sold on their own count as themselves (4 x 35 = 140 -> 1)',
  pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PK'), pg_temp.c('oBott')::uuid) = 1 and pg_temp.allpts('oBott') >= 1, null);
select pg_temp.chk('R6 a rule that does not include packs gives a pack line nothing (R_PT: everything, no packs)', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PT'), pg_temp.c('oP1a')::uuid) = 0
  and pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_NOPACK')::uuid, pg_temp.c('oP1b')::uuid) = 0, null);
select pg_temp.chk('R6 points_per_pack = 3: exactly 3 for 1 pack and 6 for 2, as its own ledger source "pack:<sku>", and the points rule adds nothing on top',
  pg_temp.pts(pg_temp.c('A')::uuid, 'pack:' || pg_temp.c('PK2'), pg_temp.c('oP2a')::uuid) = 3 and pg_temp.pts(pg_temp.c('A')::uuid, 'pack:' || pg_temp.c('PK2'), pg_temp.c('oP2b')::uuid) = 6
  and pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PK'), pg_temp.c('oP2a')::uuid) = 0 and pg_temp.allpts('oP2a') = 3 and pg_temp.allpts('oP2b') = 6, pg_temp.allpts('oP2a')::text || ' / ' || pg_temp.allpts('oP2b')::text);
select pg_temp.chk('R6 points_per_pack = 0: the pack earns no points at all (the points rule skips it too)', pg_temp.allpts('oP3') = 0 and not exists (select 1 from public.rw_points_ledger where order_id = pg_temp.c('oP3')::uuid), null);
select pg_temp.chk('R6 eligible_value 250 counts instead of the price 300: 1 pack = 2 points, 2 packs = 5', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PK'), pg_temp.c('oP4a')::uuid) = 2
  and pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PK'), pg_temp.c('oP4b')::uuid) = 5, null);
select pg_temp.chk('R6 picks: a pack counts only in a rule that includes packs (300 -> 1, 600 -> 2, eligible 250 -> 0, 2 x 250 = 500 -> 1)',
  pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_PKPICK')::uuid, pg_temp.c('oP1a')::uuid) = 1 and pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_PKPICK')::uuid, pg_temp.c('oP1b')::uuid) = 2
  and pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_PKPICK')::uuid, pg_temp.c('oP4a')::uuid) = 0 and pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_PKPICK')::uuid, pg_temp.c('oP4b')::uuid) = 1
  and pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_NOPACK')::uuid, pg_temp.c('oP1a')::uuid) = 0, null);
-- after the first sale: only active / name / price may change; locked fields may be re-sent unchanged
select pg_temp.act('AD');
select pg_temp.chk('R6 the sold pack counts its sales', (select (e ->> 'sold_packs')::int = 3 from jsonb_array_elements(public.rw_admin_packs()) e where e ->> 'pack_sku_code' = pg_temp.c('PK1c')), null);
select pg_temp.err_like('R6 sold pack: its contents are locked (BAD_PACK)', format($q$select public.rw_admin_save_pack(%L, '{"items": [{"sku_code":"FG-000124","qty":6}]}')$q$, pg_temp.c('PK1c')), '%BAD_PACK%sold%');
select pg_temp.err_like('R6 sold pack: the eligible value is locked', format($q$select public.rw_admin_save_pack(%L, '{"eligible_value": 200}')$q$, pg_temp.c('PK1c')), '%BAD_PACK%sold%');
select pg_temp.err_like('R6 sold pack: the points per pack are locked', format($q$select public.rw_admin_save_pack(%L, '{"points_per_pack": 1}')$q$, pg_temp.c('PK1c')), '%BAD_PACK%sold%');
select pg_temp.err_like('R6 sold pack: contents cannot be changed behind the function either', format($q$update public.promo_pack_items set qty = 9 where pack_sku_code = %L$q$, pg_temp.c('PK1c')), '%BAD_PACK%sold%');
select pg_temp.err_like('R6 sold pack: nor can its points', format($q$update public.promo_packs set points_per_pack = 9 where pack_sku_code = %L$q$, pg_temp.c('PK1c')), '%BAD_PACK%sold%');
select pg_temp.chk('R6 sold pack: re-sending the same locked values is fine',
  public.rw_admin_save_pack(pg_temp.c('PK1c'), '{"items": [{"sku_code":"FG-000124","qty":4}], "eligible_value": null, "points_per_pack": null}') ->> 'pack_sku_code' = pg_temp.c('PK1c'), null);
insert into t_ctx select 'pk_b', (select e::text from jsonb_array_elements(public.rw_admin_packs()) e where e ->> 'pack_sku_code' = pg_temp.c('PK1c'));
insert into t_ctx select 'pk_a', public.rw_admin_save_pack(pg_temp.c('PK1c'), '{"price": 310}')::text;
select pg_temp.chk('R6 sold pack: {price} alone changes only the price (shop price 310 too)', ((pg_temp.c('pk_a')::jsonb) ->> 'price')::numeric = 310 and pg_temp.same_but(pg_temp.c('pk_a')::jsonb, pg_temp.c('pk_b')::jsonb, 'price')
  and pg_temp.price(pg_temp.c('PK1c')) = 310, pg_temp.c('pk_a'));
select pg_temp.chk('R6 the price of a bill already placed is untouched by the new pack price', (select unit_price from public.shop_order_items where order_id = pg_temp.c('oP1a')::uuid) = 300, null);
select pg_temp.chk('R6 sold pack: {name} alone', pg_temp.same_but(public.rw_admin_save_pack(pg_temp.c('PK1c'), '{"name": "T Kratom 4-pack (renamed)"}'), pg_temp.c('pk_a')::jsonb, 'name'), null);
select pg_temp.chk('R6 sold pack: {active:false} alone', (public.rw_admin_save_pack(pg_temp.c('PK1c'), '{"active": false}') ->> 'active') = 'false', null);
insert into t_ctx select 'oP1c', pg_temp.mk_order(pg_temp.c('A')::uuid, jsonb_build_array(jsonb_build_object('sku', pg_temp.c('PK1c'), 'qty', 1, 'price', 310)))::text;
select pg_temp.pay(pg_temp.c('oP1c')::uuid);
select pg_temp.chk('R6 a pack switched off is still recognised as a pack by settle (clarification 4): its eligible value counts, 310 paid -> 3 points', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PK'), pg_temp.c('oP1c')::uuid) = 3, null);
select pg_temp.chk('R6 {active:true} alone', (public.rw_admin_save_pack(pg_temp.c('PK1c'), '{"active": true}') ->> 'active') = 'true', null);
select pg_temp.err_like('R6 {price: 0} is refused', format($q$select public.rw_admin_save_pack(%L, '{"price": 0}')$q$, pg_temp.c('PK1c')), '%BAD_PACK%');
select pg_temp.err_like('R6 {price: null} is refused', format($q$select public.rw_admin_save_pack(%L, '{"price": null}')$q$, pg_temp.c('PK1c')), '%BAD_PACK%');
select pg_temp.err_like('R6 a price below the eligible value is refused', format($q$select public.rw_admin_save_pack(%L, '{"price": 200}')$q$, pg_temp.c('PK4')), '%BAD_PACK%eligible%');
select pg_temp.err_like('R6 an unknown field names itself in the error (save)', format($q$select public.rw_admin_save_pack(%L, '{"colour": "red"}')$q$, pg_temp.c('PK1c')), '%BAD_PACK: unknown field colour%');
select pg_temp.err_like('R6 an unknown pack is NOT_FOUND', $q$select public.rw_admin_save_pack('FG-999999', '{"active": true}')$q$, '%NOT_FOUND%');
-- an unsold pack is free to change
insert into t_ctx select 'pk5', public.rw_admin_save_pack(pg_temp.c('PK5'), '{"items": [{"sku_code":"FG-000124","qty":2},{"sku_code":"FG-000125","qty":1}], "eligible_value": 200, "points_per_pack": 2}')::text;
select pg_temp.chk('R6 unsold pack: contents, eligible value and points can still change',
  (pg_temp.c('pk5')::jsonb -> 'items')::text like '%FG-000125%' and ((pg_temp.c('pk5')::jsonb) ->> 'eligible_value')::numeric = 200 and ((pg_temp.c('pk5')::jsonb) ->> 'points_per_pack')::int = 2, pg_temp.c('pk5'));
select pg_temp.chk('R6 unsold pack: {points_per_pack: null} alone makes it follow the rules again (eligible value untouched)',
  (public.rw_admin_save_pack(pg_temp.c('PK5'), '{"points_per_pack": null}') -> 'points_per_pack')::text = 'null' and (select eligible_value = 200 from public.promo_packs where pack_sku_code = pg_temp.c('PK5')), null);
select pg_temp.act('A');
select pg_temp.err_state('R6 a customer cannot create a pack', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-000124","qty":1}]', '{}')$q$, '42501');
select pg_temp.err_state('R6 a customer cannot change a pack', format($q$select public.rw_admin_save_pack(%L, '{"active": false}')$q$, pg_temp.c('PK1c')), '42501');
select pg_temp.err_state('R6 a customer cannot list packs', $q$select public.rw_admin_packs()$q$, '42501');

-- =========================================================================================== R7 reversal: payment reversed, order returned / cancelled
select pg_temp.act('AD');
-- (a) a bill of 900 -> 3 rights; one is already USED on a number; the payment is reversed
insert into t_ctx select 'oR1', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":900}]')::text;
insert into t_ctx select 'rcR1', pg_temp.pay(pg_temp.c('oR1')::uuid)::text;
select pg_temp.chk('R7 the bill paid: 3 rights available', pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oR1')::uuid) = 3, null);
insert into t_ctx select 'selR1', gen_random_uuid()::text;
update public.rw_entitlements set status = 'used', used_selection_id = pg_temp.c('selR1')::uuid where rule_id = pg_temp.c('R_PICK')::uuid and source_order_id = pg_temp.c('oR1')::uuid and seq = 1;
select pg_temp.reverse(pg_temp.c('rcR1')::uuid);
select pg_temp.act('AD');
select pg_temp.chk('R7 the reversal really made the invoice unpaid again', pg_temp.inv_code(pg_temp.c('oR1')::uuid) in (0, 1, 9), pg_temp.inv_code(pg_temp.c('oR1')::uuid)::text);
select pg_temp.chk('R7 the two UNUSED rights were revoked', (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('oR1')::uuid and status = 'revoked') = 2
  and (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('oR1')::uuid and seq in (2, 3) and status = 'revoked' and revoked_reason is not null) = 2, null);
select pg_temp.chk('R7 the USED right is flagged needs_review and its number (selection) is untouched, not released',
  (select status = 'used' and needs_review and used_selection_id = pg_temp.c('selR1')::uuid and review_since is not null from public.rw_entitlements where source_order_id = pg_temp.c('oR1')::uuid and seq = 1), null);
select pg_temp.chk('R7 the customer sees the bill as taken back, with 0 rights', (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('oR1')) ->> 'state') = 'taken_back'
  and (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('oR1')) ->> 'rights')::int = 0, pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('oR1'))::text);
select pg_temp.act('AD');
select pg_temp.chk('R7 staff see it in the review queue and in the customer view', exists (select 1 from jsonb_array_elements(public.rw_admin_review_queue()) e where e ->> 'rule_name' = 'T pick per bill' and e ->> 'profile_id' = pg_temp.c('D'))
  and jsonb_array_length(public.rw_admin_customer(pg_temp.c('D')::uuid) -> 'needs_review') = 1
  and (public.rw_admin_customer(pg_temp.c('D')::uuid) -> 'profile' ->> 'id') = pg_temp.c('D'), null);
select pg_temp.chk('R7 settle again changes nothing (the flag stays, nothing is revoked twice)', public.rw_settle_profile(pg_temp.c('D')::uuid) = 0, null);
insert into t_ctx select 'rcR1b', pg_temp.pay(pg_temp.c('oR1')::uuid)::text;
select pg_temp.chk('R7 paid again: the 2 revoked rights come back, NO duplicates (3 rows for the bill), the flag is cleared and the used right stays used',
  (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('oR1')::uuid) = 3
  and (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('oR1')::uuid and status = 'available') = 2
  and (select status = 'used' and not needs_review from public.rw_entitlements where source_order_id = pg_temp.c('oR1')::uuid and seq = 1)
  and (pg_temp.bill(pg_temp.my('D'), pg_temp.c('R_PICK'), pg_temp.c('oR1')) ->> 'state') = 'counted', null);
-- (b) review decisions by a Super Admin
insert into t_ctx select 'oR2', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":600}]')::text;
insert into t_ctx select 'rcR2', pg_temp.pay(pg_temp.c('oR2')::uuid)::text;
update public.rw_entitlements set status = 'used', used_selection_id = gen_random_uuid() where rule_id = pg_temp.c('R_PICK')::uuid and source_order_id = pg_temp.c('oR2')::uuid;
select pg_temp.reverse(pg_temp.c('rcR2')::uuid);
select pg_temp.act('AD');
select pg_temp.chk('R7 both used rights of the reversed 600 bill are flagged, none revoked', (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('oR2')::uuid and status = 'used' and needs_review) = 2, null);
insert into t_ctx select 'rv1', (select id::text from public.rw_entitlements where source_order_id = pg_temp.c('oR2')::uuid and seq = 1);
insert into t_ctx select 'rv2', (select id::text from public.rw_entitlements where source_order_id = pg_temp.c('oR2')::uuid and seq = 2);
select pg_temp.err_state('R7 an ADMIN cannot resolve a review (Super Admin only)', format($q$select public.rw_admin_resolve_review(%L, 'keep', 'looks fine to me')$q$, pg_temp.c('rv1')), '42501');
select pg_temp.act('S');
select pg_temp.err_like('R7 resolving needs a reason', format($q$select public.rw_admin_resolve_review(%L, 'keep', ' ')$q$, pg_temp.c('rv1')), '%REASON_REQUIRED%');
select pg_temp.err_like('R7 resolving needs a known action', format($q$select public.rw_admin_resolve_review(%L, 'delete', 'because')$q$, pg_temp.c('rv1')), '%BAD_RULE%');
select pg_temp.err_like('R7 resolving something that is not flagged is NOT_FOUND', format($q$select public.rw_admin_resolve_review(%L, 'keep', 'because')$q$, (select id::text from public.rw_entitlements where source_order_id = pg_temp.c('oR1')::uuid and seq = 2)), '%NOT_FOUND%');
insert into t_ctx select 'kp', jsonb_array_length(public.rw_admin_resolve_review(pg_temp.c('rv1')::uuid, 'keep', 'customer kept the number'))::text;
select pg_temp.chk('R7 "keep" clears the flag and the right stays used', (select status = 'used' and not needs_review and kept from public.rw_entitlements where id = pg_temp.c('rv1')::uuid), pg_temp.c('kp'));
insert into t_ctx select 'rl', jsonb_array_length(public.rw_admin_resolve_review(pg_temp.c('rv2')::uuid, 'release', 'refund confirmed'))::text;
select pg_temp.chk('R7 "release" revokes that right', (select status = 'revoked' and not needs_review from public.rw_entitlements where id = pg_temp.c('rv2')::uuid), pg_temp.c('rl'));
select pg_temp.chk('R7 both decisions are audited with their reason', (select count(*) from public.rw_events_log where action in ('review.keep', 'review.release') and reason is not null) = 2, null);
select pg_temp.chk('R7 settle afterwards does not flag the kept right again', public.rw_settle_profile(pg_temp.c('D')::uuid) = 0 and (select not needs_review from public.rw_entitlements where id = pg_temp.c('rv1')::uuid), null);
select pg_temp.chk('R7 the review queue no longer holds them', not exists (select 1 from jsonb_array_elements(public.rw_admin_review_queue()) e where e ->> 'entitlement_id' in (pg_temp.c('rv1'), pg_temp.c('rv2'))), null);
-- (c) order returned / cancelled
select pg_temp.act('AD');
insert into t_ctx select 'oC3', pg_temp.mk_order(pg_temp.c('C')::uuid, '[{"sku":"FG-000001","qty":1,"price":600}]')::text;
insert into t_ctx select 'oC4', pg_temp.mk_order(pg_temp.c('C')::uuid, '[{"sku":"FG-000001","qty":1,"price":300}]')::text;
select pg_temp.pay(pg_temp.c('oC3')::uuid), pg_temp.pay(pg_temp.c('oC4')::uuid);
select pg_temp.chk('R7 C: 600 -> 2 and 300 -> 1 once paid', pg_temp.rights(pg_temp.c('C')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oC3')::uuid) = 2 and pg_temp.rights(pg_temp.c('C')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oC4')::uuid) = 1, null);
update public.shop_orders set status = 'returned' where id = pg_temp.c('oC3')::uuid;
update public.shop_orders set status = 'cancelled' where id = pg_temp.c('oC4')::uuid;
select pg_temp.chk('R7 a RETURNED bill and a CANCELLED bill take their unused rights back', pg_temp.rights(pg_temp.c('C')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oC3')::uuid) = 0
  and pg_temp.rights(pg_temp.c('C')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oC4')::uuid) = 0 and (select count(*) from public.rw_entitlements where profile_id = pg_temp.c('C')::uuid and status = 'revoked') = 3, null);
select pg_temp.chk('R7 the customer sees both as taken back', (pg_temp.bill(pg_temp.my('C'), pg_temp.c('R_PICK'), pg_temp.c('oC3')) ->> 'state') = 'taken_back'
  and (pg_temp.bill(pg_temp.my('C'), pg_temp.c('R_PICK'), pg_temp.c('oC4')) ->> 'state') = 'taken_back', null);
-- (d) points: reversed -> a 'reverse' ledger row, paid again -> a new 'earn' row, the balance follows the money
select pg_temp.act('AD');
insert into t_ctx select 'rcScope', (select id::text from public.finance_receipts where invoice_id = (select invoice_id from public.shop_orders where id = pg_temp.c('oScope')::uuid) and status = 'posted');
select pg_temp.chk('R7 before: the 800 bill gave 8 points on R_PT', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PT'), pg_temp.c('oScope')::uuid) = 8, null);
insert into t_ctx select 'balBefore', pg_temp.balance(pg_temp.c('A')::uuid)::text;
select pg_temp.reverse(pg_temp.c('rcScope')::uuid);
select pg_temp.chk('R7 reversed: the points of that bill are taken back by a "reverse" row (net 0), history keeps both rows',
  pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PT'), pg_temp.c('oScope')::uuid) = 0
  and (select count(*) from public.rw_points_ledger where source_key = 'rule:' || pg_temp.c('R_PT') and order_id = pg_temp.c('oScope')::uuid and kind = 'earn' and points = 8) = 1
  and (select count(*) from public.rw_points_ledger where source_key = 'rule:' || pg_temp.c('R_PT') and order_id = pg_temp.c('oScope')::uuid and kind = 'reverse' and points = -8) = 1
  and pg_temp.balance(pg_temp.c('A')::uuid) = pg_temp.c('balBefore')::int + (select coalesce(sum(points), 0) from public.rw_points_ledger where order_id = pg_temp.c('oScope')::uuid and kind = 'reverse'),
  pg_temp.balance(pg_temp.c('A')::uuid)::text || ' vs ' || pg_temp.c('balBefore'));
select pg_temp.chk('R7 reversed: every rule that paid on that bill is back to 0', (select coalesce(sum(points), 0) from public.rw_points_ledger where order_id = pg_temp.c('oScope')::uuid) = 0, null);
select pg_temp.pay(pg_temp.c('oScope')::uuid);
select pg_temp.chk('R7 paid again: 8 points again, and the balance is where it was before the reversal', pg_temp.pts(pg_temp.c('A')::uuid, 'rule:' || pg_temp.c('R_PT'), pg_temp.c('oScope')::uuid) = 8
  and pg_temp.balance(pg_temp.c('A')::uuid) = pg_temp.c('balBefore')::int, pg_temp.balance(pg_temp.c('A')::uuid)::text || ' vs ' || pg_temp.c('balBefore'));

-- =========================================================================================== R7b code 6 is not "fully paid" while money is outstanding (review round 1, item 9)
-- In the ledger a posted receipt flagged needs_review beats the outstanding test, so status_code 6 can be answered with money still owed (legacy overpayment flows).
select pg_temp.act('AD');
insert into t_ctx select 'oN1', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":600}]')::text;
insert into t_ctx select 'rcN1', pg_temp.pay(pg_temp.c('oN1')::uuid)::text;
select pg_temp.act('AD');
select pg_temp.chk('R7b paid in full: 2 rights', pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oN1')::uuid) = 2, null);
update public.finance_receipts set needs_review = true where id = pg_temp.c('rcN1')::uuid;
update public.finance_allocations set active = false, deactivated_at = now(), deactivate_reason = 'test: legacy partial allocation' where receipt_id = pg_temp.c('rcN1')::uuid and active;
insert into public.finance_allocations (receipt_id, invoice_id, amount) select r.id, r.invoice_id, 300 from public.finance_receipts r where r.id = pg_temp.c('rcN1')::uuid;
select pg_temp.chk('R7b the ledger now answers code 6 with 300 still outstanding (the legacy case)',
  pg_temp.inv_code(pg_temp.c('oN1')::uuid) = 6 and (select (public.finance_invoice_state_raw(o.invoice_id) ->> 'outstanding')::numeric from public.shop_orders o where o.id = pg_temp.c('oN1')::uuid) = 300,
  pg_temp.inv_code(pg_temp.c('oN1')::uuid)::text);
select public.rw_settle_profile(pg_temp.c('D')::uuid);
select pg_temp.chk('R7b code 6 with money outstanding does NOT count: the 2 rights are taken back',
  pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oN1')::uuid) = 0
  and (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('oN1')::uuid and status = 'revoked') = 2, null);
-- the same code 6 with nothing outstanding (a real overpayment under review) still counts
update public.finance_allocations set active = false, deactivated_at = now(), deactivate_reason = 'test: allocate the rest' where receipt_id = pg_temp.c('rcN1')::uuid and active;
insert into public.finance_allocations (receipt_id, invoice_id, amount) select r.id, r.invoice_id, 600 from public.finance_receipts r where r.id = pg_temp.c('rcN1')::uuid;
select public.rw_settle_profile(pg_temp.c('D')::uuid);
select pg_temp.chk('R7b code 6 with nothing outstanding counts again: the 2 rights come back (re-activated, no duplicates)',
  pg_temp.inv_code(pg_temp.c('oN1')::uuid) in (5, 6) and pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oN1')::uuid) = 2
  and (select count(*) from public.rw_entitlements where source_order_id = pg_temp.c('oN1')::uuid) = 2, null);

-- =========================================================================================== R7c fulfilment steps do not run settle; only cancelled / returned do (review round 1, item 12)
select pg_temp.act('AD');
insert into t_ctx select 'oN2', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":300}]')::text;
insert into t_ctx select 'rcN2', pg_temp.pay(pg_temp.c('oN2')::uuid)::text;
select pg_temp.act('AD');
insert into t_ctx select 'logN', count(*)::text from public.rw_events_log;
update public.shop_orders set status = 'confirmed' where id = pg_temp.c('oN2')::uuid;
update public.shop_orders set status = 'preparing' where id = pg_temp.c('oN2')::uuid;
select pg_temp.chk('R7c ordinary fulfilment steps leave the rewards exactly as they were (1 right, nothing logged)',
  pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oN2')::uuid) = 1 and (select count(*) from public.rw_events_log)::text = pg_temp.c('logN'), null);
update public.shop_orders set status = 'returned' where id = pg_temp.c('oN2')::uuid;
select pg_temp.chk('R7c a return still takes the right back at once (the trigger fires for returned)',
  pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oN2')::uuid) = 0, null);

-- =========================================================================================== R9 windows, inactive rules, caps, cumulative, inactive SKUs (customer S, rules limited to S)
select pg_temp.act('AD');
-- clarification 1: no retroactive rewards
insert into t_ctx select 'oOld', pg_temp.mk_order(pg_temp.c('D')::uuid, '[{"sku":"FG-000001","qty":1,"price":600}]', now() - interval '2 days')::text;
insert into t_ctx select 'R_NEW', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T pick new rule', 'spend_step', 300, 'reward_amount', 1, 'event_id', pg_temp.c('EV'), 'only_profile_ids', jsonb_build_array(pg_temp.c('D'))))::text;
insert into t_ctx select 'R_BACK', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T pick back-dated rule', 'spend_step', 300, 'reward_amount', 1, 'event_id', pg_temp.c('EV'),
  'starts_at', (now() - interval '5 days')::text, 'only_profile_ids', jsonb_build_array(pg_temp.c('D'))))::text;
select pg_temp.pay(pg_temp.c('oOld')::uuid);
select pg_temp.chk('R9 a rule created now does not reach a bill made 2 days ago (starts_at defaulted to now)', pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_NEW')::uuid, pg_temp.c('oOld')::uuid) = 0
  and pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oOld')::uuid) = 0, null);
select pg_temp.chk('R9 only an explicit earlier starts_at reaches back (600 -> 2)', pg_temp.rights(pg_temp.c('D')::uuid, pg_temp.c('R_BACK')::uuid, pg_temp.c('oOld')::uuid) = 2, null);
-- the window of a rule that has ended: the bill made inside it keeps its points, a bill made after it earns nothing
insert into t_ctx select 'R_WIN', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points ended window', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000005'),
  'starts_at', (now() - interval '3 days')::text, 'ends_at', (now() - interval '1 day')::text, 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'oW1', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000005","qty":1,"price":400}]', now() - interval '2 days')::text;
insert into t_ctx select 'oW2', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000005","qty":1,"price":400}]')::text;
select pg_temp.pay(pg_temp.c('oW1')::uuid), pg_temp.pay(pg_temp.c('oW2')::uuid);
select pg_temp.chk('R9 a bill made inside the window earns (400 -> 4), one made after it earns nothing', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_WIN'), pg_temp.c('oW1')::uuid) = 4
  and pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_WIN'), pg_temp.c('oW2')::uuid) = 0, null);
select pg_temp.chk('R9 an ended window does not revoke past bills (settle again, still 4)', public.rw_admin_resettle(pg_temp.c('S')::uuid) is not null and pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_WIN'), pg_temp.c('oW1')::uuid) = 4, null);
-- clarification 3: an inactive rule may only LOWER a bill's target
insert into t_ctx select 'R_ACT', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points to be switched off', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000004'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'R_ACTP', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T picks to be switched off', 'spend_step', 300, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000004'),
  'event_id', pg_temp.c('EV'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'oI1', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000004","qty":1,"price":900}]')::text;
insert into t_ctx select 'oI2', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000004","qty":1,"price":900}]')::text;
insert into t_ctx select 'rcI1', pg_temp.pay(pg_temp.c('oI1')::uuid)::text;
select pg_temp.chk('R9 before switching off: 900 -> 9 points and 3 picks', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_ACT'), pg_temp.c('oI1')::uuid) = 9 and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_ACTP')::uuid, pg_temp.c('oI1')::uuid) = 3, null);
select pg_temp.act('AD');
select pg_temp.chk('R9 switching a rule off returns the rule with active = false', (public.rw_admin_set_rule_active(pg_temp.c('R_ACT')::uuid, false) ->> 'active') = 'false' and (public.rw_admin_set_rule_active(pg_temp.c('R_ACTP')::uuid, false) ->> 'active') = 'false', null);
select pg_temp.chk('R9 switched off: settle keeps what was earned', public.rw_admin_resettle(pg_temp.c('S')::uuid) is not null and pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_ACT'), pg_temp.c('oI1')::uuid) = 9
  and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_ACTP')::uuid, pg_temp.c('oI1')::uuid) = 3, null);
select pg_temp.pay(pg_temp.c('oI2')::uuid);
select pg_temp.chk('R9 switched off: a NEW paid bill earns nothing from it', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_ACT'), pg_temp.c('oI2')::uuid) = 0
  and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_ACTP')::uuid, pg_temp.c('oI2')::uuid) = 0, null);
select pg_temp.reverse(pg_temp.c('rcI1')::uuid);
select pg_temp.chk('R9 switched off: a reversal still takes the reward back (target lowered to 0)', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_ACT'), pg_temp.c('oI1')::uuid) = 0
  and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_ACTP')::uuid, pg_temp.c('oI1')::uuid) = 0, null);
select pg_temp.pay(pg_temp.c('oI1')::uuid);
select pg_temp.chk('R9 switched off: paid again, the target is NEVER raised: still nothing', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_ACT'), pg_temp.c('oI1')::uuid) = 0
  and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_ACTP')::uuid, pg_temp.c('oI1')::uuid) = 0, null);
-- max_per_order and the allow-list
insert into t_ctx select 'R_MAXP', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points capped at 2', 'spend_step', 100, 'reward_amount', 1, 'max_per_order', 2, 'include_skus', jsonb_build_array('FG-000006'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'R_MAXK', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T picks capped at 2', 'spend_step', 100, 'reward_amount', 1, 'max_per_order', 2, 'include_skus', jsonb_build_array('FG-000006'),
  'event_id', pg_temp.c('EV'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'oM1', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000006","qty":1,"price":900}]')::text;
insert into t_ctx select 'oM2', pg_temp.mk_order(pg_temp.c('B')::uuid, '[{"sku":"FG-000006","qty":1,"price":900}]')::text;
insert into t_ctx select 'oM3', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000006","qty":1,"price":150}]')::text;
select pg_temp.pay(pg_temp.c('oM1')::uuid), pg_temp.pay(pg_temp.c('oM2')::uuid), pg_temp.pay(pg_temp.c('oM3')::uuid);
select pg_temp.chk('R9 max_per_order 2: a bill of 900 (would be 9) earns 2 points and 2 picks', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_MAXP'), pg_temp.c('oM1')::uuid) = 2
  and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_MAXK')::uuid, pg_temp.c('oM1')::uuid) = 2, null);
select pg_temp.chk('R9 max_per_order only caps: a bill of 150 still earns 1', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_MAXP'), pg_temp.c('oM3')::uuid) = 1 and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_MAXK')::uuid, pg_temp.c('oM3')::uuid) = 1, null);
select pg_temp.chk('R9 only_profile_ids: B paid the same bill and earns nothing from rules limited to S', pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('R_MAXP'), pg_temp.c('oM2')::uuid) = 0
  and pg_temp.rights(pg_temp.c('B')::uuid, pg_temp.c('R_MAXK')::uuid, pg_temp.c('oM2')::uuid) = 0 and not exists (select 1 from public.rw_entitlements where rule_id = pg_temp.c('R_MAXK')::uuid and profile_id <> pg_temp.c('S')::uuid), null);
select pg_temp.chk('R9 only_profile_ids: A (not on the picks list) got no pick from the 350 bill', pg_temp.rights(pg_temp.c('A')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oDark')::uuid) = 0 and not exists (select 1 from public.rw_entitlements where rule_id = pg_temp.c('R_PICK')::uuid and profile_id = pg_temp.c('A')::uuid), null);
-- cumulative points: counted on total spend, not per bill
insert into t_ctx select 'R_CUM', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points cumulative', 'basis', 'cumulative', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000003'),
  'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'oK1', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000003","qty":1,"price":150}]')::text;
insert into t_ctx select 'oK2', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000003","qty":1,"price":150}]')::text;
select pg_temp.pay(pg_temp.c('oK1')::uuid);
insert into t_ctx select 'rcK2', pg_temp.pay(pg_temp.c('oK2')::uuid)::text;
select pg_temp.chk('R9 cumulative: two bills of 150 = 300 in total = 3 points (per bill it would have been 2)', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_CUM'), null) = 3, pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_CUM'), null)::text);
select pg_temp.reverse(pg_temp.c('rcK2')::uuid);
select pg_temp.chk('R9 cumulative: one payment reversed -> 150 in total = 1 point', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_CUM'), null) = 1, null);
-- clarification: an inactive or voided SKU cannot enter a new rule, but an old paid bill that contains it still counts
insert into t_ctx select 'R_OLDSKU', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T points for FG-000002', 'spend_step', 100, 'reward_amount', 1, 'include_skus', jsonb_build_array('FG-000002'),
  'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'oV1', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000002","qty":1,"price":300}]')::text;
insert into t_ctx select 'oV2', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000030","qty":1,"price":400}]')::text;
select pg_temp.pay(pg_temp.c('oV1')::uuid);
select pg_temp.chk('R9 FG-000002 is active when the bill is paid: 3 points', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_OLDSKU'), pg_temp.c('oV1')::uuid) = 3, null);
update public.sku_registry set status = 'inactive' where sku_code = 'FG-000002';
select pg_temp.act('AD');
select pg_temp.err_like('R9 now FG-000002 is inactive: it cannot enter a NEW rule', $q$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1,"include_skus":["FG-000002"]}')$q$, '%INACTIVE_SKU: FG-000002%');
select pg_temp.err_like('R9 nor a new pack', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-000002","qty":1}]', '{}')$q$, '%INACTIVE_SKU: FG-000002%');
select pg_temp.chk('R9 the old paid bill with it still counts after the SKU went inactive (settle again: 3 points stay)', public.rw_admin_resettle(pg_temp.c('S')::uuid) is not null and pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_OLDSKU'), pg_temp.c('oV1')::uuid) = 3, null);
select pg_temp.chk('R9 the rule that lists it can still be renamed (the list is unchanged, so it is not re-checked)', (public.rw_admin_save_rule(pg_temp.c('R_OLDSKU')::uuid, '{"name": "T points for FG-000002 (old)", "include_skus": ["FG-000002"]}') ->> 'name') like '%(old)', null);
select pg_temp.pay(pg_temp.c('oV2')::uuid);
select pg_temp.chk('R9 an old paid bill with an INACTIVE SKU (FG-000030) counts for a rule that takes everything (400 -> 4)', pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('Rs_all'), pg_temp.c('oV2')::uuid) = 4, null);

-- =========================================================================================== R10 staff searches
select pg_temp.act('AD');
select pg_temp.chk('R10 sku search: the contract shape (sku_code, name, status, price, category, brand, is_pack, origin)', (select e ?& array['sku_code', 'name', 'status', 'price', 'category', 'brand', 'is_pack', 'origin'] from jsonb_array_elements(public.rw_admin_sku_search('FG-000001')) e limit 1), null);
select pg_temp.chk('R10 sku search: an exact code comes first and carries the shop price and category', (public.rw_admin_sku_search('FG-000001') -> 0 ->> 'sku_code') = 'FG-000001' and ((public.rw_admin_sku_search('FG-000001') -> 0 ->> 'price')::numeric) = 320
  and (public.rw_admin_sku_search('FG-000001') -> 0 ->> 'category') = 'Puff' and (public.rw_admin_sku_search('FG-000001') -> 0 ->> 'is_pack') = 'false', public.rw_admin_sku_search('FG-000001')::text);
select pg_temp.chk('R10 sku search: inactive SKUs are hidden by default and shown on request (clarification: status is visible)', jsonb_array_length(public.rw_admin_sku_search('FG-000030')) = 0
  and (public.rw_admin_sku_search('FG-000030', false) -> 0 ->> 'status') = 'inactive', null);
select pg_temp.chk('R10 sku search returns finished goods only: the raw material is never offered, even when inactive ones are asked for', jsonb_array_length(public.rw_admin_sku_search(pg_temp.c('RM1'), false)) = 0
  and jsonb_array_length(public.rw_admin_sku_search('T raw material', false)) = 0
  and not exists (select 1 from jsonb_array_elements(public.rw_admin_sku_search('', false, 50)) e where e ->> 'sku_code' like 'RM-%' or e ->> 'sku_code' like 'WIP-%'), null);
select pg_temp.chk('R10 sku search: a pack is flagged and shows its current price', (select (e ->> 'is_pack')::boolean and (e ->> 'price')::numeric = 310 from jsonb_array_elements(public.rw_admin_sku_search(pg_temp.c('PK1c'))) e limit 1), null);
select pg_temp.chk('R10 sku search: the limit is honoured and an empty query lists from the start', jsonb_array_length(public.rw_admin_sku_search('Pod', true, 3)) = 3 and jsonb_array_length(public.rw_admin_sku_search(null, true, 5)) = 5, null);
select pg_temp.chk('R10 sku search: % and _ are plain characters, not wildcards', jsonb_array_length(public.rw_admin_sku_search('%')) = 0 and jsonb_array_length(public.rw_admin_sku_search('FG-0000_1')) = 0, null);
select pg_temp.chk('R10 customer search: by name (any case)', (public.rw_admin_customer_search('member a') -> 0 ->> 'id') = pg_temp.c('A') and jsonb_array_length(public.rw_admin_customer_search('member a')) = 1, public.rw_admin_customer_search('member a')::text);
select pg_temp.chk('R10 customer search: by phone digits, with or without separators', (public.rw_admin_customer_search('0822222222') -> 0 ->> 'id') = pg_temp.c('B') and (public.rw_admin_customer_search('082-222') -> 0 ->> 'id') = pg_temp.c('B'), null);
select pg_temp.chk('R10 customer search: by e-mail', (public.rw_admin_customer_search('c@seed.test') -> 0 ->> 'id') = pg_temp.c('C'), null);
select pg_temp.chk('R10 customer search: the answer is {id, name, phone, email} and nothing else', (select (select array_agg(k order by k) from jsonb_object_keys(e) k) = array['email', 'id', 'name', 'phone'] from jsonb_array_elements(public.rw_admin_customer_search('Member D')) e limit 1), null);
select pg_temp.chk('R10 customer search: fewer than 2 characters answers an empty list (documented choice), also blanks', public.rw_admin_customer_search('M') = '[]'::jsonb and public.rw_admin_customer_search(' ') = '[]'::jsonb and public.rw_admin_customer_search(null) = '[]'::jsonb, null);
select pg_temp.chk('R10 customer search: the limit applies and is capped at 20', jsonb_array_length(public.rw_admin_customer_search('Member', 2)) = 2 and jsonb_array_length(public.rw_admin_customer_search('Member', 1000)) = 4
  and jsonb_array_length(public.rw_admin_customer_search('Member')) = 4, null);
select pg_temp.chk('R10 customer search: wildcard characters are literal (%% finds nobody)', public.rw_admin_customer_search('%%') = '[]'::jsonb and public.rw_admin_customer_search('__') = '[]'::jsonb, null);
select pg_temp.act('A');
select pg_temp.err_state('R10 customer search: a customer gets 42501', $q$select public.rw_admin_customer_search('Member')$q$, '42501');
select pg_temp.err_state('R10 sku search: a customer gets 42501', $q$select public.rw_admin_sku_search('FG')$q$, '42501');

-- =========================================================================================== R11 preview (customer) and simulate (staff): read-only, same arithmetic as settle
create or replace function pg_temp.pv(p_user text, p_items text, p_name text) returns jsonb language plpgsql as $$
begin perform pg_temp.act(p_user); return (select l from jsonb_array_elements(public.rw_preview_cart(p_items::jsonb) -> 'lines') l where l ->> 'name' = p_name); end $$;
create or replace function pg_temp.cart(p_sku text, p_qty int) returns text language sql as $$ select jsonb_build_array(jsonb_build_object('sku_code', p_sku, 'qty', p_qty))::text $$;
select pg_temp.act('AD');
insert into t_ctx select 'R_P450', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T prev step 300 x2', 'spend_step', 300, 'reward_amount', 2, 'include_skus', jsonb_build_array('FG-000124'),
  'event_id', pg_temp.c('EV'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'R_PCAP', pg_temp.mkrule(jsonb_build_object('kind', 'board_pick', 'name', 'T prev step 300 x2 cap 3', 'spend_step', 300, 'reward_amount', 2, 'max_per_order', 3, 'include_skus', jsonb_build_array('FG-000124'),
  'event_id', pg_temp.c('EV'), 'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
insert into t_ctx select 'R_PPTS', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T prev points cap 3', 'spend_step', 100, 'reward_amount', 1, 'max_per_order', 3, 'include_skus', jsonb_build_array('FG-000124'),
  'only_profile_ids', jsonb_build_array(pg_temp.c('S'))))::text;
select pg_temp.chk('R11 the bottle costs 35 in the seed (the examples below are written for it)', pg_temp.price('FG-000124') = 35, pg_temp.price('FG-000124')::text);
insert into t_ctx select 'logs0', (select count(*) from public.rw_events_log)::text;
insert into t_ctx select 'rows0', pg_temp.total_rows()::text;
-- step 300, reward 2, a bill of 13 x 35 = 455
insert into t_ctx select 'p1', pg_temp.pv('S', pg_temp.cart('FG-000124', 13), 'T prev step 300 x2')::text;
select pg_temp.chk('R11 step 300 x2, bill 455: eligible 455, reward 2, 145 more for the next step, which would make 4', (pg_temp.c('p1')::jsonb ->> 'eligible_amount')::numeric = 455 and (pg_temp.c('p1')::jsonb ->> 'reward')::int = 2
  and (pg_temp.c('p1')::jsonb ->> 'next_reward_in')::numeric = 145 and (pg_temp.c('p1')::jsonb ->> 'next_reward_total')::int = 4 and pg_temp.c('p1')::jsonb ->> 'kind' = 'board_pick', pg_temp.c('p1'));
insert into t_ctx select 'p2', pg_temp.pv('S', pg_temp.cart('FG-000124', 8), 'T prev step 300 x2')::text;
select pg_temp.chk('R11 bill 280: nothing yet, 20 more earns 2', (pg_temp.c('p2')::jsonb ->> 'reward')::int = 0 and (pg_temp.c('p2')::jsonb ->> 'next_reward_in')::numeric = 20 and (pg_temp.c('p2')::jsonb ->> 'next_reward_total')::int = 2, pg_temp.c('p2'));
insert into t_ctx select 'p3', pg_temp.pv('S', pg_temp.cart('FG-000124', 13), 'T prev step 300 x2 cap 3')::text;
select pg_temp.chk('R11 the same with max_per_order 3: reward 2, 145 more, and the next total is capped at 3', (pg_temp.c('p3')::jsonb ->> 'reward')::int = 2 and (pg_temp.c('p3')::jsonb ->> 'next_reward_in')::numeric = 145
  and (pg_temp.c('p3')::jsonb ->> 'next_reward_total')::int = 3, pg_temp.c('p3'));
insert into t_ctx select 'p4', pg_temp.pv('S', pg_temp.cart('FG-000124', 26), 'T prev step 300 x2 cap 3')::text;
select pg_temp.chk('R11 beyond the cap (910 would be 6): reward 3, next_reward_in and next_reward_total are null', (pg_temp.c('p4')::jsonb ->> 'reward')::int = 3 and (pg_temp.c('p4')::jsonb -> 'next_reward_in')::text = 'null'
  and (pg_temp.c('p4')::jsonb -> 'next_reward_total')::text = 'null', pg_temp.c('p4'));
insert into t_ctx select 'p5', pg_temp.pv('S', pg_temp.cart('FG-000124', 9), 'T prev points cap 3')::text;
select pg_temp.chk('R11 points cap 3, bill 315: exactly at the cap: reward 3, both next values null', (pg_temp.c('p5')::jsonb ->> 'reward')::int = 3 and (pg_temp.c('p5')::jsonb -> 'next_reward_in')::text = 'null'
  and (pg_temp.c('p5')::jsonb -> 'next_reward_total')::text = 'null' and pg_temp.c('p5')::jsonb ->> 'kind' = 'points', pg_temp.c('p5'));
insert into t_ctx select 'p6', pg_temp.pv('S', pg_temp.cart('FG-000124', 5), 'T prev points cap 3')::text;
select pg_temp.chk('R11 points cap 3, bill 175: reward 1, 25 more, next total 2', (pg_temp.c('p6')::jsonb ->> 'reward')::int = 1 and (pg_temp.c('p6')::jsonb ->> 'next_reward_in')::numeric = 25 and (pg_temp.c('p6')::jsonb ->> 'next_reward_total')::int = 2, pg_temp.c('p6'));
select pg_temp.chk('R11 a line has exactly kind, name, eligible_amount, reward, next_reward_in, next_reward_total: no rule id, no customer list', (select (select array_agg(k order by k) from jsonb_object_keys(l) k) = array['eligible_amount', 'kind', 'name', 'next_reward_in', 'next_reward_total', 'reward']
   from jsonb_array_elements(public.rw_preview_cart(pg_temp.cart('FG-000124', 13)::jsonb) -> 'lines') l limit 1), null);
select pg_temp.chk('R11 preview wrote nothing (no ledger, right or log row)', pg_temp.total_rows() = pg_temp.c('rows0')::bigint and (select count(*) from public.rw_events_log) = pg_temp.c('logs0')::bigint, null);
-- who sees what
select pg_temp.chk('R11 rules limited to S are invisible to B', pg_temp.pv('B', pg_temp.cart('FG-000124', 13), 'T prev step 300 x2') is null, null);
insert into t_ctx select 'p7', pg_temp.pv('B', pg_temp.cart('FG-000001', 1), 'T pick per bill')::text;
select pg_temp.chk('R11 B sees the rule of the three customers: 320 -> 1, 280 more, next total 2', (pg_temp.c('p7')::jsonb ->> 'reward')::int = 1 and (pg_temp.c('p7')::jsonb ->> 'next_reward_in')::numeric = 280 and (pg_temp.c('p7')::jsonb ->> 'next_reward_total')::int = 2, pg_temp.c('p7'));
select pg_temp.chk('R11 a rule that is switched off is not previewed', pg_temp.pv('S', pg_temp.cart('FG-000004', 3), 'T points to be switched off') is null and pg_temp.pv('S', pg_temp.cart('FG-000004', 3), 'T picks to be switched off') is null, null);
select pg_temp.chk('R11 a rule whose window has ended is not previewed', pg_temp.pv('S', pg_temp.cart('FG-000005', 3), 'T points ended window') is null, null);
select pg_temp.chk('R11 a cart no rule applies to gives no line for it, and no error', jsonb_array_length(public.rw_preview_cart(pg_temp.cart('FG-000090', 1)::jsonb) -> 'lines') >= 0
  and pg_temp.pv('S', pg_temp.cart('FG-000090', 1), 'T prev points cap 3') is null, null);
select pg_temp.chk('R11 junk in the cart is ignored: unknown SKU, unpriced SKU FG-000122, quantity 0 and 1000, text instead of a list',
  (public.rw_preview_cart('[{"sku_code":"NOPE","qty":1},{"sku_code":"FG-000122","qty":1},{"sku_code":"FG-000124","qty":0},{"sku_code":"FG-000124","qty":1000},"x",5,{"sku_code":"FG-000124"}]') -> 'lines') is not null
  and (public.rw_preview_cart('"x"') ->> 'enabled')::boolean and (public.rw_preview_cart(null) ->> 'enabled')::boolean and (public.rw_preview_cart('[]') -> 'lines') = '[]'::jsonb, null);
select pg_temp.chk('R11 the same SKU on two lines adds up (5 + 8 bottles = 13)', (pg_temp.pv('S', '[{"sku_code":"FG-000124","qty":5},{"sku_code":"FG-000124","qty":8}]', 'T prev step 300 x2') ->> 'eligible_amount')::numeric = 455, null);
-- pack points in the preview
select pg_temp.chk('R11 a pack with points_per_pack shows its own points line (2 packs -> 6)', (pg_temp.pv('S', pg_temp.cart(pg_temp.c('PK2'), 2), 'T Kratom 4-pack 3pts') ->> 'reward')::int = 6 and (pg_temp.pv('S', pg_temp.cart(pg_temp.c('PK2'), 2), 'T Kratom 4-pack 3pts') ->> 'kind') = 'points', null);
-- boards switched off hide pick rules, not points rules
select pg_temp.act('S');
select pg_temp.chk('R11 with the boards off the pick rule disappears from the preview, the points rule stays', public.rw_admin_save_settings('{"boards_enabled": false}') is not null
  and pg_temp.pv('S', pg_temp.cart('FG-000124', 13), 'T prev step 300 x2') is null and pg_temp.pv('S', pg_temp.cart('FG-000124', 13), 'T prev points cap 3') is not null, null);
select pg_temp.chk('R11 with the boards off a customer sees no picks, still sees points', jsonb_array_length(pg_temp.my('B') -> 'picks') = 0 and (pg_temp.my('B') ->> 'boards_enabled')::boolean is false, null);
select pg_temp.act('S');
select pg_temp.chk('R11 boards back on', (public.rw_admin_save_settings('{"boards_enabled": true}') ->> 'boards_enabled')::boolean, null);
-- picks[] carry the rule's step and reward
select pg_temp.chk('R11 picks[] entries carry spend_step and reward_amount as numbers', (pg_temp.pick(pg_temp.my('B'), pg_temp.c('R_PICK')) ->> 'spend_step')::numeric = 300 and (pg_temp.pick(pg_temp.my('B'), pg_temp.c('R_PICK')) ->> 'reward_amount')::int = 1
  and jsonb_typeof(pg_temp.pick(pg_temp.my('B'), pg_temp.c('R_PICK')) -> 'spend_step') = 'number' and jsonb_typeof(pg_temp.pick(pg_temp.my('S'), pg_temp.c('R_P450')) -> 'reward_amount') = 'number'
  and (pg_temp.pick(pg_temp.my('S'), pg_temp.c('R_P450')) ->> 'reward_amount')::int = 2, pg_temp.pick(pg_temp.my('B'), pg_temp.c('R_PICK'))::text);
select pg_temp.chk('R11 a customer sees a pick rule they qualify for even before the first right', (pg_temp.pick(pg_temp.my('S'), pg_temp.c('R_P450')) ->> 'earned')::int = 0 and (pg_temp.pick(pg_temp.my('S'), pg_temp.c('R_P450')) ->> 'remaining')::int = 0, null);
select pg_temp.chk('R11 ... and not a rule that is only for others (B does not see the S-only rule)', pg_temp.pick(pg_temp.my('B'), pg_temp.c('R_P450')) is null, null);
select pg_temp.chk('R11 the contract shape of rw_my_rewards', (pg_temp.my('B')) ?& array['enabled', 'boards_enabled', 'points', 'points_history', 'picks', 'selections'] and jsonb_typeof(pg_temp.my('B') -> 'selections') = 'array'
  and (pg_temp.pick(pg_temp.my('B'), pg_temp.c('R_PICK'))) ?& array['rule_id', 'rule_name', 'event_id', 'earned', 'used', 'remaining', 'bills'], null);
-- simulate (staff)
select pg_temp.act('AD');
insert into t_ctx select 'sc1', '[{"sku_code":"FG-000004","qty":3}]';
select pg_temp.chk('R11 simulate: a rule that is switched off is listed with its amount, reward 0 and the note "inactive"', (select (e ->> 'eligible_amount')::numeric = 3 * pg_temp.price('FG-000004') and (e ->> 'reward')::int = 0 and e ->> 'note' = 'inactive'
   from jsonb_array_elements(public.rw_admin_simulate(pg_temp.c('sc1')::jsonb)) e where e ->> 'rule_id' = pg_temp.c('R_ACT')), null);
select pg_temp.chk('R11 simulate: the contract shape', (select e ?& array['rule_id', 'rule_name', 'kind', 'eligible_amount', 'reward', 'next_reward_in', 'note'] from jsonb_array_elements(public.rw_admin_simulate(pg_temp.c('sc1')::jsonb)) e limit 1), null);
select pg_temp.chk('R11 simulate: "for this customer" removes what the customer is not entitled to', (select e ->> 'note' = 'not for this customer' and (e ->> 'reward')::int = 0
   from jsonb_array_elements(public.rw_admin_simulate(pg_temp.c('cart')::jsonb, pg_temp.c('B')::uuid)) e where e ->> 'rule_id' = pg_temp.c('Rs_all')), null);
select pg_temp.chk('R11 simulate: a rule that has ended says so', (select e ->> 'note' = 'ended' from jsonb_array_elements(public.rw_admin_simulate('[{"sku_code":"FG-000005","qty":1}]')) e where e ->> 'rule_id' = pg_temp.c('R_WIN')), null);
select pg_temp.chk('R11 simulate: pack points come as their own row', (select (e ->> 'reward')::int = 3 and e ->> 'kind' = 'points' from jsonb_array_elements(public.rw_admin_simulate(pg_temp.cart(pg_temp.c('PK2'), 1)::jsonb)) e where e ->> 'rule_id' = 'pack:' || pg_temp.c('PK2')), null);
select pg_temp.chk('R11 simulate: junk gives zero amounts and no error', (select bool_and((e ->> 'eligible_amount')::numeric = 0) from jsonb_array_elements(public.rw_admin_simulate('"x"')) e)
  and (select bool_and((e ->> 'reward')::int = 0) from jsonb_array_elements(public.rw_admin_simulate('[{"sku_code":"NOPE","qty":2}]')) e), null);
select pg_temp.chk('R11 simulate wrote nothing', pg_temp.total_rows() = pg_temp.c('rows0')::bigint, null);
select pg_temp.chk('R11 rw_admin_rules: stats count the bills and rights a rule has granted', (select (e -> 'stats' ->> 'granted')::int = (select count(*) from public.rw_entitlements where rule_id = pg_temp.c('R_PICK')::uuid and status in ('available', 'used'))
   and (e -> 'stats' ->> 'bills')::int = (select count(distinct source_order_id) from public.rw_entitlements where rule_id = pg_temp.c('R_PICK')::uuid and status in ('available', 'used'))
   from jsonb_array_elements(public.rw_admin_rules()) e where e ->> 'id' = pg_temp.c('R_PICK')), null);

-- =========================================================================================== R8 settle twice, again and again: no new rows
create or replace function pg_temp.fp() returns text language sql as $$
  select md5(coalesce((select string_agg(id::text || ':' || points || ':' || source_key || ':' || coalesce(order_id::text, ''), ',' order by id) from public.rw_points_ledger), '')
          || coalesce((select string_agg(id::text || ':' || status || ':' || needs_review::text || ':' || kept::text, ',' order by id) from public.rw_entitlements), '')) $$;
insert into t_ctx select 'fp0', pg_temp.fp();
insert into t_ctx select 'n0', pg_temp.total_rows()::text;
insert into t_ctx select 'sl0', (select count(*) from public.rw_events_log where action = 'settle')::text;
insert into t_ctx select 'ch1', (select sum(public.rw_settle_profile(x))::text from unnest(array[pg_temp.c('A'), pg_temp.c('B'), pg_temp.c('C'), pg_temp.c('D'), pg_temp.c('S'), pg_temp.c('AD')]::uuid[]) x);
insert into t_ctx select 'ch2', (select sum(public.rw_settle_profile(x))::text from unnest(array[pg_temp.c('A'), pg_temp.c('B'), pg_temp.c('C'), pg_temp.c('D'), pg_temp.c('S'), pg_temp.c('AD')]::uuid[]) x);
select pg_temp.chk('R8 settling every customer twice changes nothing: 0 and 0 rows changed, identical ledger and rights', pg_temp.c('ch1') = '0' and pg_temp.c('ch2') = '0' and pg_temp.fp() = pg_temp.c('fp0') and pg_temp.total_rows() = pg_temp.c('n0')::bigint,
  pg_temp.c('ch1') || '/' || pg_temp.c('ch2') || ' ' || pg_temp.total_rows()::text || ' vs ' || pg_temp.c('n0'));
insert into t_ctx select 'rs1', public.rw_admin_resettle(null)::text;
select pg_temp.chk('R8 the staff re-settle of every recent customer changes nothing either', (pg_temp.c('rs1')::jsonb ->> 'changed')::int = 0 and (pg_temp.c('rs1')::jsonb ->> 'profiles')::int >= 5 and pg_temp.fp() = pg_temp.c('fp0'), pg_temp.c('rs1'));
select pg_temp.chk('R8 re-settle of everyone is bounded (at most 100 customers per call) and says how many are left (review round 1, item 12)',
  (pg_temp.c('rs1')::jsonb ->> 'profiles')::int <= 100 and (pg_temp.c('rs1')::jsonb ? 'remaining')
  and (pg_temp.c('rs1')::jsonb ->> 'remaining')::int = greatest((select count(distinct o.profile_id) from public.shop_orders o where o.created_at > now() - interval '90 days') - (pg_temp.c('rs1')::jsonb ->> 'profiles')::int, 0),
  pg_temp.c('rs1'));
select pg_temp.chk('R8 re-settle of ONE customer reports nothing remaining', (public.rw_admin_resettle(pg_temp.c('A')::uuid) ->> 'remaining')::int = 0, null);
insert into t_ctx select 'my1', pg_temp.my('B')::text;
select pg_temp.my('B'), pg_temp.my('B'), pg_temp.my('D'), pg_temp.my('S'), pg_temp.my('A');
select pg_temp.chk('R8 reading the rewards over and over (self-heal) adds no row and gives the same answer', pg_temp.fp() = pg_temp.c('fp0') and pg_temp.my('B') = pg_temp.c('my1')::jsonb, null);
select pg_temp.chk('R8 and the settle log only grows when something changed (no "settle" row for the no-op runs)', (select count(*) from public.rw_events_log where action = 'settle') = pg_temp.c('sl0')::bigint, null);

-- =========================================================================================== R12 a failing settle NEVER blocks a payment
-- A CHECK (false) added to the ledger (inside this rolled-back transaction) makes every ledger insert fail: settle raises, the trigger must log "settle_error" and let the payment through.
select pg_temp.act('AD');
insert into t_ctx select 'oF1', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000007","qty":1,"price":500}]')::text;
insert into t_ctx select 'oF2', pg_temp.mk_order(pg_temp.c('B')::uuid, '[{"sku":"FG-000001","qty":1,"price":600}]')::text;
insert into t_ctx select 'errs0', (select count(*) from public.rw_events_log where action = 'settle_error')::text;
alter table public.rw_points_ledger add constraint rw_test_break check (false) not valid;
select pg_temp.err_like('R12 the fault is in place: a ledger insert is refused', format($q$insert into public.rw_points_ledger (profile_id, points, kind, source_key) values (%L, 1, 'earn', 'x')$q$, pg_temp.c('S')), '%rw_test_break%');
insert into t_ctx select 'rcF1', pg_temp.pay(pg_temp.c('oF1')::uuid)::text;
select pg_temp.chk('R12 the payment went through although settle failed: receipt posted, invoice fully paid',
  (select count(*) from public.finance_receipts r join public.shop_orders o on o.invoice_id = r.invoice_id where o.id = pg_temp.c('oF1')::uuid and r.status = 'posted' and r.amount = 500) = 1 and pg_temp.inv_code(pg_temp.c('oF1')::uuid) = 5
  and (select e.status from public.finance_payment_evidence e join public.shop_orders o on o.invoice_id = e.invoice_id where o.id = pg_temp.c('oF1')::uuid) = 'verified', null);
select pg_temp.chk('R12 ... and the failure was logged as "settle_error" with the database message and the source',
  (select count(*) from public.rw_events_log where action = 'settle_error') > pg_temp.c('errs0')::bigint
  and exists (select 1 from public.rw_events_log where action = 'settle_error' and detail ->> 'message' like '%rw_test_break%' and detail ->> 'sqlstate' = '23514' and detail ->> 'source' like 'finance_%' and profile_id = pg_temp.c('S')::uuid), null);
select pg_temp.chk('R12 nothing of the failed settle stayed behind (no ledger row for that bill)', not exists (select 1 from public.rw_points_ledger where order_id = pg_temp.c('oF1')::uuid), null);
insert into t_ctx select 'errs1', (select count(*) from public.rw_events_log where action = 'settle_error')::text;
update public.shop_orders set status = 'completed' where id = pg_temp.c('oF1')::uuid;
select pg_temp.chk('R12 an ordinary fulfilment step (completed) carries on and does not even run settle: nothing new is logged (review round 1, item 12)', (select status from public.shop_orders where id = pg_temp.c('oF1')::uuid) = 'completed'
  and (select count(*) from public.rw_events_log where action = 'settle_error')::text = pg_temp.c('errs1'), null);
-- a RETURN does run settle: with settle failing it still carries on and the failure is logged with its source
insert into t_ctx select 'oF3', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000007","qty":1,"price":500}]')::text;
update public.shop_orders set status = 'returned' where id = pg_temp.c('oF3')::uuid;
select pg_temp.chk('R12 a return carries on when settle fails (and logs it with source shop_orders)', (select status from public.shop_orders where id = pg_temp.c('oF3')::uuid) = 'returned'
  and (select count(*) from public.rw_events_log where action = 'settle_error') > pg_temp.c('errs1')::bigint and exists (select 1 from public.rw_events_log where action = 'settle_error' and detail ->> 'source' = 'shop_orders'), null);
select pg_temp.chk('R12 a customer reading their rewards while settle fails still gets an answer', (pg_temp.my('S') ->> 'enabled')::boolean, null);
alter table public.rw_points_ledger drop constraint rw_test_break;
-- the same for rights
alter table public.rw_entitlements add constraint rw_test_break2 check (false) not valid;
insert into t_ctx select 'rcF2', pg_temp.pay(pg_temp.c('oF2')::uuid)::text;
select pg_temp.chk('R12 rights: the payment of B went through although creating the rights failed', pg_temp.inv_code(pg_temp.c('oF2')::uuid) = 5
  and exists (select 1 from public.rw_events_log where action = 'settle_error' and detail ->> 'message' like '%rw_test_break2%' and profile_id = pg_temp.c('B')::uuid) and pg_temp.rights(pg_temp.c('B')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oF2')::uuid) = 0, null);
alter table public.rw_entitlements drop constraint rw_test_break2;
select pg_temp.chk('R12 once the fault is gone a re-settle heals both customers (5 points, 2 picks)', (public.rw_admin_resettle(pg_temp.c('S')::uuid) ->> 'changed')::int >= 1 and (public.rw_admin_resettle(pg_temp.c('B')::uuid) ->> 'changed')::int >= 1
  and pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('Rs_all'), pg_temp.c('oF1')::uuid) = 5 and pg_temp.rights(pg_temp.c('B')::uuid, pg_temp.c('R_PICK')::uuid, pg_temp.c('oF2')::uuid) = 2, null);
select pg_temp.chk('R12 the faults are removed again', not exists (select 1 from pg_constraint where conname in ('rw_test_break', 'rw_test_break2')), null);

-- =========================================================================================== R1b the master switch off again: nothing moves, then it catches up
select pg_temp.act('S');
select public.rw_admin_save_settings('{"enabled": false}');
insert into t_ctx select 'fpOff', pg_temp.fp();
insert into t_ctx select 'oOff', pg_temp.mk_order(pg_temp.c('S')::uuid, '[{"sku":"FG-000008","qty":1,"price":700}]')::text;
insert into t_ctx select 'rcM1', (select id::text from public.finance_receipts where invoice_id = (select invoice_id from public.shop_orders where id = pg_temp.c('oM1')::uuid) and status = 'posted');
select pg_temp.pay(pg_temp.c('oOff')::uuid);
select pg_temp.reverse(pg_temp.c('rcM1')::uuid);
select pg_temp.chk('R1b switched off: a payment and a reversal change nothing in the ledger or the rights', pg_temp.fp() = pg_temp.c('fpOff') and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_MAXK')::uuid, pg_temp.c('oM1')::uuid) = 2, null);
select pg_temp.chk('R1b switched off: the customer sees nothing, the preview is empty', (pg_temp.my('S') ->> 'enabled')::boolean is false and (pg_temp.my('S') ->> 'points')::int = 0 and (public.rw_preview_cart(pg_temp.cart('FG-000124', 13)::jsonb) -> 'lines') = '[]'::jsonb, null);
insert into t_ctx select 'fpFin', pg_temp.fin_fp(pg_temp.c('oOff')::uuid);
select pg_temp.act('S');
select public.rw_admin_save_settings('{"enabled": true}');
select pg_temp.act('AD');
insert into t_ctx select 'rsOn', public.rw_admin_resettle(pg_temp.c('S')::uuid)::text;
select pg_temp.chk('R1b switched on and re-settled: it catches up (the 700 bill pays 7 points, the reversed 900 bill gives its rewards back)',
  (pg_temp.c('rsOn')::jsonb ->> 'changed')::int > 0 and pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('Rs_all'), pg_temp.c('oOff')::uuid) = 7
  and pg_temp.pts(pg_temp.c('S')::uuid, 'rule:' || pg_temp.c('R_MAXP'), pg_temp.c('oM1')::uuid) = 0 and pg_temp.rights(pg_temp.c('S')::uuid, pg_temp.c('R_MAXK')::uuid, pg_temp.c('oM1')::uuid) = 0, pg_temp.c('rsOn'));
select pg_temp.chk('R1b settling did not touch the order, invoice or receipt of the bill that was paid while off', pg_temp.fin_fp(pg_temp.c('oOff')::uuid) = pg_temp.c('fpFin'), null);

-- =========================================================================================== R13 security (acting through the real "authenticated" / "anon" roles, so EXECUTE and table grants are checked)
-- the set of client-callable functions is exactly this list
reset role;
select pg_temp.chk('R13 exactly the 18 client-callable functions are executable by signed-in members',
  (select array_agg(p.proname::text order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' and has_function_privilege('authenticated', p.oid, 'execute'))
  = array['rw_admin_adjust_points', 'rw_admin_create_pack', 'rw_admin_customer', 'rw_admin_customer_search', 'rw_admin_packs', 'rw_admin_resettle', 'rw_admin_resolve_review', 'rw_admin_review_queue', 'rw_admin_rules',
          'rw_admin_save_pack', 'rw_admin_save_rule', 'rw_admin_save_settings', 'rw_admin_set_rule_active', 'rw_admin_simulate', 'rw_admin_sku_search', 'rw_my_rewards', 'rw_preview_cart', 'rw_settings_public'],
  (select string_agg(p.proname, ',') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' and has_function_privilege('authenticated', p.oid, 'execute')));
select pg_temp.chk('R13 anon can execute none of the rw_ functions', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' and has_function_privilege('anon', p.oid, 'execute')), null);
set local role anon;
select pg_temp.err_state('R13 anon: rw_my_rewards', $q$select public.rw_my_rewards()$q$, '42501');
select pg_temp.err_state('R13 anon: rw_preview_cart', $q$select public.rw_preview_cart('[]')$q$, '42501');
select pg_temp.err_state('R13 anon: rw_settings_public', $q$select public.rw_settings_public()$q$, '42501');
reset role; set local role authenticated; select pg_temp.act('A');
select pg_temp.chk('R13 a customer can read the flags, their own rewards and a preview', (public.rw_settings_public() ->> 'enabled')::boolean and (public.rw_my_rewards() ->> 'enabled')::boolean and (public.rw_preview_cart('[]') ->> 'enabled')::boolean, null);
select pg_temp.err_state('R13 customer gets 42501 on ' || t.f, t.q, '42501') from (values
  ('rw_admin_rules', 'select public.rw_admin_rules()'),
  ('rw_admin_save_rule', $$select public.rw_admin_save_rule(null, '{"kind":"points","name":"x","spend_step":100,"reward_amount":1}')$$),
  ('rw_admin_set_rule_active', format($$select public.rw_admin_set_rule_active(%L, false)$$, pg_temp.c('R_PT'))),
  ('rw_admin_packs', 'select public.rw_admin_packs()'),
  ('rw_admin_create_pack', $$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-000124","qty":1}]', '{}')$$),
  ('rw_admin_save_pack', format($$select public.rw_admin_save_pack(%L, '{"active": false}')$$, pg_temp.c('PK1c'))),
  ('rw_admin_sku_search', $$select public.rw_admin_sku_search('FG')$$),
  ('rw_admin_customer_search', $$select public.rw_admin_customer_search('Member')$$),
  ('rw_admin_simulate', $$select public.rw_admin_simulate('[]')$$),
  ('rw_admin_customer', format($$select public.rw_admin_customer(%L)$$, pg_temp.c('B'))),
  ('rw_admin_adjust_points', format($$select public.rw_admin_adjust_points(%L, 5, 'because')$$, pg_temp.c('A'))),
  ('rw_admin_resettle', 'select public.rw_admin_resettle(null)'),
  ('rw_admin_review_queue', 'select public.rw_admin_review_queue()'),
  ('rw_admin_resolve_review', format($$select public.rw_admin_resolve_review(%L, 'keep', 'because')$$, pg_temp.c('rv1'))),
  ('rw_admin_save_settings', $$select public.rw_admin_save_settings('{"enabled": true}')$$),
  ('rw_settle_profile (internal)', format($$select public.rw_settle_profile(%L)$$, pg_temp.c('B'))),
  ('rw_bills (internal)', format($$select * from public.rw_bills(%L)$$, pg_temp.c('B'))),
  ('rw_points_targets (internal)', format($$select * from public.rw_points_targets(%L)$$, pg_temp.c('B'))),
  ('rw_log (internal)', $$select public.rw_log('x', 'y', 'z', null, null, '{}')$$),
  ('rw_trigger_settle (internal)', format($$select public.rw_trigger_settle(%L, null, 'x')$$, pg_temp.c('B')))
) t(f, q);
select pg_temp.err_like('R13 a customer cannot read ' || t || ' directly', 'select count(*) from public.' || t, '%permission denied%')
  from unnest(array['rw_settings', 'promo_packs', 'promo_pack_items', 'rw_rules', 'rw_points_ledger', 'rw_entitlements', 'rw_events_log']) t;
select pg_temp.err_like('R13 a customer cannot write a point', format($q$insert into public.rw_points_ledger (profile_id, points, kind, source_key) values (%L, 100, 'earn', 'x')$q$, pg_temp.c('A')), '%permission denied%');
select pg_temp.err_like('R13 a customer cannot create a right', format($q$insert into public.rw_entitlements (rule_id, profile_id, source_order_id, seq) values (%L, %L, gen_random_uuid(), 1)$q$, pg_temp.c('R_PICK'), pg_temp.c('A')), '%permission denied%');
select pg_temp.err_like('R13 a customer cannot flip the master switch with an update', $q$update public.rw_settings set enabled = false$q$, '%permission denied%');
-- a customer reads only their own rows
select pg_temp.act('B');
insert into t_ctx select 'myB2', public.rw_my_rewards()::text;
reset role;
select pg_temp.chk('R13 B''s rewards mention only B''s bills (no order number of anybody else) and no profile id of anybody else',
  not exists (select 1 from public.shop_orders o where o.profile_id <> pg_temp.c('B')::uuid and pg_temp.c('myB2') like '%' || o.order_no || '%')
  and not exists (select 1 from public.profiles p where p.id <> pg_temp.c('B')::uuid and pg_temp.c('myB2') like '%' || p.id::text || '%')
  and exists (select 1 from public.shop_orders o where o.profile_id = pg_temp.c('B')::uuid and pg_temp.c('myB2') like '%' || o.order_no || '%'), null);
select pg_temp.chk('R13 B''s points and rights are B''s own', (pg_temp.c('myB2')::jsonb ->> 'points')::int = pg_temp.balance(pg_temp.c('B')::uuid)
  and (pg_temp.pick(pg_temp.c('myB2')::jsonb, pg_temp.c('R_PICK')) ->> 'earned')::int = (select count(*) from public.rw_entitlements where rule_id = pg_temp.c('R_PICK')::uuid and profile_id = pg_temp.c('B')::uuid and status in ('available', 'used')), null);
select pg_temp.chk('R13 A''s answer is A''s: a different points total and different bills', (pg_temp.my('A') ->> 'points')::int = pg_temp.balance(pg_temp.c('A')::uuid) and (pg_temp.my('A') ->> 'points')::int <> (pg_temp.c('myB2')::jsonb ->> 'points')::int, null);
-- staff through the real role
set local role authenticated; select pg_temp.act('AD');
select pg_temp.chk('R13 an ADMIN can use the staff functions (rules, packs, searches, simulate, customer, re-settle)', jsonb_array_length(public.rw_admin_rules()) > 5 and jsonb_array_length(public.rw_admin_packs()) = 5
  and jsonb_array_length(public.rw_admin_customer_search('Member')) = 4 and jsonb_array_length(public.rw_admin_sku_search('FG-000001')) = 1 and jsonb_array_length(public.rw_admin_simulate('[]')) > 5
  and (public.rw_admin_customer(pg_temp.c('B')::uuid) -> 'profile' ->> 'id') = pg_temp.c('B') and public.rw_admin_resettle(pg_temp.c('B')::uuid) is not null, null);
select pg_temp.err_state('R13 an ADMIN cannot adjust points', format($q$select public.rw_admin_adjust_points(%L, 5, 'a good reason')$q$, pg_temp.c('B')), '42501');
select pg_temp.err_state('R13 an ADMIN cannot switch rewards off', $q$select public.rw_admin_save_settings('{"enabled": false}')$q$, '42501');
select pg_temp.err_state('R13 an ADMIN cannot resolve a review', format($q$select public.rw_admin_resolve_review(%L, 'keep', 'a good reason')$q$, pg_temp.c('rv1')), '42501');
-- Super Admin: adjust points
select pg_temp.act('S');
select pg_temp.err_like('R13 adjusting needs a reason', format($q$select public.rw_admin_adjust_points(%L, 50, '  ')$q$, pg_temp.c('B')), '%REASON_REQUIRED%');
select pg_temp.err_like('R13 adjusting by 0 is refused', format($q$select public.rw_admin_adjust_points(%L, 0, 'because')$q$, pg_temp.c('B')), '%LIMIT_REACHED%');
select pg_temp.err_like('R13 adjusting by a silly amount is refused', format($q$select public.rw_admin_adjust_points(%L, 1000000, 'because')$q$, pg_temp.c('B')), '%LIMIT_REACHED%');
select pg_temp.err_like('R13 the balance cannot go below zero', format($q$select public.rw_admin_adjust_points(%L, -5, 'because')$q$, pg_temp.c('B')), '%LIMIT_REACHED%');
select pg_temp.err_like('R13 an unknown customer is NOT_FOUND', $q$select public.rw_admin_adjust_points('00000000-0000-4000-8000-000000000001', 5, 'because')$q$, '%NOT_FOUND%');
insert into t_ctx select 'adj1', public.rw_admin_adjust_points(pg_temp.c('B')::uuid, 50, 'goodwill after a complaint')::text;
insert into t_ctx select 'adj2', public.rw_admin_adjust_points(pg_temp.c('B')::uuid, -20, 'correction')::text;
reset role;
select pg_temp.chk('R13 a Super Admin adjusts points: +50 then -20 leaves 30, as "adjust" ledger rows with who and why', pg_temp.c('adj1') = '50' and pg_temp.c('adj2') = '30' and pg_temp.balance(pg_temp.c('B')::uuid) = 30
  and (select count(*) from public.rw_points_ledger where profile_id = pg_temp.c('B')::uuid and kind = 'adjust' and created_by = pg_temp.c('S')::uuid and note is not null) = 2
  and exists (select 1 from public.rw_events_log where action = 'points.adjust' and reason = 'goodwill after a complaint' and actor = pg_temp.c('S')::uuid), null);
select pg_temp.chk('R13 settle never reverses or counts an adjustment', public.rw_settle_profile(pg_temp.c('B')::uuid) = 0 and pg_temp.balance(pg_temp.c('B')::uuid) = 30, null);
select pg_temp.chk('R13 staff see the reason of an adjustment, the customer does not', (select e ->> 'note' from jsonb_array_elements(public.rw_admin_customer(pg_temp.c('B')::uuid) -> 'points_history') e where (e ->> 'points')::int = 50) = 'goodwill after a complaint'
  and (select e ->> 'note' from jsonb_array_elements(pg_temp.my('B') -> 'points_history') e where (e ->> 'points')::int = 50) is null, null);
-- the guards: ledger, rights, audit are never edited or deleted
select pg_temp.err_like('R13 a ledger row cannot be edited', $q$update public.rw_points_ledger set points = points + 1 where id = (select min(id) from public.rw_points_ledger)$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 a ledger row cannot be deleted', $q$delete from public.rw_points_ledger where id = (select min(id) from public.rw_points_ledger)$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 the ledger cannot be truncated', $q$truncate public.rw_points_ledger$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 a right cannot be deleted', $q$delete from public.rw_entitlements where id = (select id from public.rw_entitlements limit 1)$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 a right''s bill cannot be re-pointed', $q$update public.rw_entitlements set source_order_id = gen_random_uuid() where id = (select id from public.rw_entitlements limit 1)$q$, '%cannot be changed%');
select pg_temp.err_like('R13 a right''s place cannot be renumbered', $q$update public.rw_entitlements set seq = seq + 100 where id = (select id from public.rw_entitlements limit 1)$q$, '%cannot be changed%');
select pg_temp.err_like('R13 an audit row cannot be edited', $q$update public.rw_events_log set reason = 'x' where id = (select min(id) from public.rw_events_log)$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 an audit row cannot be deleted', $q$delete from public.rw_events_log where id = (select min(id) from public.rw_events_log)$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 the audit log cannot be truncated', $q$truncate public.rw_events_log$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 rights cannot be truncated', $q$truncate public.rw_entitlements$q$, '%never deleted or edited%');
select pg_temp.err_like('R13 a pack cannot be deleted by anyone', $q$delete from public.promo_packs$q$, '%BAD_PACK%');
select pg_temp.chk('R13 every state-changing call left an audit trail (rules, packs, settings, adjustments, reviews, settles)',
  (select count(distinct action) from public.rw_events_log where action in ('rule.save', 'rule.active', 'pack.create', 'pack.save', 'settings.save', 'points.adjust', 'review.keep', 'review.release', 'settle', 'resettle', 'settle_error')) = 11, (select string_agg(distinct action, ',') from public.rw_events_log));

-- =========================================================================================== R15 a counted bill is frozen: a catalogue edit cannot rewrite its rewards (review round 1, item 7)
reset role; update public.rw_settings set enabled = true;
select pg_temp.act('AD');
insert into t_ctx select 'ZcatK', public.shop_category_of(s.product_type, s.domain) from public.sku_registry s where s.sku_code = 'FG-000007';
insert into t_ctx select 'ZR_CAT', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T frozen category', 'spend_step', 100, 'reward_amount', 1,
  'category_codes', jsonb_build_array(pg_temp.c('ZcatK')), 'only_profile_ids', jsonb_build_array(pg_temp.c('B'))))::text;
insert into t_ctx select 'ZoS1', pg_temp.mk_order(pg_temp.c('B')::uuid, '[{"sku":"FG-000007","qty":1,"price":500}]')::text;
insert into t_ctx select 'ZrcS1', pg_temp.pay(pg_temp.c('ZoS1')::uuid)::text;
select pg_temp.act('AD');
select pg_temp.chk('R15 the bill counts at payment: 5 points, and its eligible amount (500) is stored once',
  pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_CAT'), pg_temp.c('ZoS1')::uuid) = 5
  and (select eligible_amount from public.rw_bill_eligible where rule_id = pg_temp.c('ZR_CAT')::uuid and order_id = pg_temp.c('ZoS1')::uuid) = 500, null);
-- staff fix a typo in the SKU's product type: the SKU leaves the category
update public.sku_registry set product_type = 'T moved type', domain = 'T moved domain' where sku_code = 'FG-000007';
select public.rw_settle_profile(pg_temp.c('B')::uuid);
select pg_temp.chk('R15 after the catalogue edit the counted bill still has its 5 points (nothing is taken back)',
  pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_CAT'), pg_temp.c('ZoS1')::uuid) = 5
  and not exists (select 1 from public.rw_points_ledger where order_id = pg_temp.c('ZoS1')::uuid and kind = 'reverse'), null);
insert into t_ctx select 'ZoS2', pg_temp.mk_order(pg_temp.c('B')::uuid, '[{"sku":"FG-000007","qty":1,"price":500}]')::text;
select pg_temp.pay(pg_temp.c('ZoS2')::uuid);
select pg_temp.chk('R15 a NEW bill of the moved SKU is judged by today''s catalogue: out of the category, 0 points, and its snapshot is 0',
  pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_CAT'), pg_temp.c('ZoS2')::uuid) = 0
  and (select eligible_amount from public.rw_bill_eligible where rule_id = pg_temp.c('ZR_CAT')::uuid and order_id = pg_temp.c('ZoS2')::uuid) = 0, null);
-- reversal and re-payment of the first bill use the stored amount, not the moved catalogue
select pg_temp.reverse(pg_temp.c('ZrcS1')::uuid);
select pg_temp.act('AD');
select pg_temp.chk('R15 a payment reversal still takes the 5 points back', pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_CAT'), pg_temp.c('ZoS1')::uuid) = 0, null);
select pg_temp.pay(pg_temp.c('ZoS1')::uuid);
select pg_temp.chk('R15 paid again: the 5 points come back from the stored amount although the SKU is out of the category today',
  pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_CAT'), pg_temp.c('ZoS1')::uuid) = 5, null);
select pg_temp.chk('R15 the snapshot table is append-only and invisible to clients',
  exists (select 1 from pg_class c where c.relname = 'rw_bill_eligible' and c.relrowsecurity) and not has_table_privilege('authenticated', 'public.rw_bill_eligible', 'select'), null);
select pg_temp.err_like('R15 a snapshot cannot be edited', $q$update public.rw_bill_eligible set eligible_amount = 1$q$, '%never deleted or edited%');
select pg_temp.err_like('R15 a snapshot cannot be deleted', $q$delete from public.rw_bill_eligible$q$, '%never deleted or edited%');

-- =========================================================================================== R16 switching a rule off and on again does not reward the bills made while it was off (review round 1, item 8)
select pg_temp.act('AD');
insert into t_ctx select 'ZR_ACT', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T pause and resume', 'spend_step', 100, 'reward_amount', 1,
  'include_skus', jsonb_build_array('FG-000008'), 'only_profile_ids', jsonb_build_array(pg_temp.c('B')), 'starts_at', (now() - interval '3 hours')))::text;
insert into t_ctx select 'ZoA0', pg_temp.mk_order(pg_temp.c('B')::uuid, '[{"sku":"FG-000008","qty":1,"price":200}]', now() - interval '2 hours')::text;
select pg_temp.pay(pg_temp.c('ZoA0')::uuid);
select pg_temp.act('AD');
select pg_temp.chk('R16 a bill paid while the rule is on earns: 2 points', pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_ACT'), pg_temp.c('ZoA0')::uuid) = 2, null);
insert into t_ctx select 'ZoA1', pg_temp.mk_order(pg_temp.c('B')::uuid, '[{"sku":"FG-000008","qty":1,"price":300}]', now() - interval '1 hour')::text;
select public.rw_admin_set_rule_active(pg_temp.c('ZR_ACT')::uuid, false);
select pg_temp.pay(pg_temp.c('ZoA1')::uuid);
select pg_temp.act('AD');
select pg_temp.chk('R16 a bill paid while the rule is OFF earns nothing', pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_ACT'), pg_temp.c('ZoA1')::uuid) = 0, null);
select public.rw_admin_set_rule_active(pg_temp.c('ZR_ACT')::uuid, true);
select public.rw_settle_profile(pg_temp.c('B')::uuid);
select pg_temp.chk('R16 switched on again: the window restarts now, so the bill made (and paid) while it was off still earns nothing',
  pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_ACT'), pg_temp.c('ZoA1')::uuid) = 0
  and (select starts_at >= now() from public.rw_rules where id = pg_temp.c('ZR_ACT')::uuid), (select starts_at::text from public.rw_rules where id = pg_temp.c('ZR_ACT')::uuid));
select pg_temp.chk('R16 ... and the bill counted BEFORE the pause keeps its 2 points (the restarted window does not push it out)',
  pg_temp.pts(pg_temp.c('B')::uuid, 'rule:' || pg_temp.c('ZR_ACT'), pg_temp.c('ZoA0')::uuid) = 2, null);
-- a draft rule (created off) is stamped when it is switched on
insert into t_ctx select 'ZR_DRAFT', pg_temp.mkrule(jsonb_build_object('kind', 'points', 'name', 'T draft rule', 'spend_step', 100, 'reward_amount', 1, 'active', false,
  'include_skus', jsonb_build_array('FG-000008'), 'only_profile_ids', jsonb_build_array(pg_temp.c('B')), 'starts_at', (now() - interval '5 hours')))::text;
select public.rw_admin_set_rule_active(pg_temp.c('ZR_DRAFT')::uuid, true);
select pg_temp.chk('R16 a draft rule switched on starts at that moment, not at its old explicit start', (select starts_at >= now() from public.rw_rules where id = pg_temp.c('ZR_DRAFT')::uuid), (select starts_at::text from public.rw_rules where id = pg_temp.c('ZR_DRAFT')::uuid));

-- =========================================================================================== R14 pack options at creation are partial too; the trigger leaves the session as it found it
select pg_temp.act('AD');
insert into t_ctx select 'pc1', public.rw_admin_create_pack(gen_random_uuid(), 'T pack options none', 300, '[{"sku_code":"FG-000124","qty":2}]', '{}')::text;
insert into t_ctx select 'pc2', public.rw_admin_create_pack(gen_random_uuid(), 'T pack option active only', 300, '[{"sku_code":"FG-000124","qty":2}]', '{"active": false}')::text;
insert into t_ctx select 'pc3', public.rw_admin_create_pack(gen_random_uuid(), 'T pack option points only', 300, '[{"sku_code":"FG-000124","qty":2}]', '{"points_per_pack": 5}')::text;
insert into t_ctx select 'pc4', public.rw_admin_create_pack(gen_random_uuid(), 'T pack option nulls', 300, '[{"sku_code":"FG-000124","qty":2}]', '{"eligible_value": null, "points_per_pack": null}')::text;
insert into t_ctx select 'pc5', public.rw_admin_create_pack(gen_random_uuid(), 'T pack option null patch', 300, '[{"sku_code":"FG-000124","qty":2}]', null)::text;
select pg_temp.chk('R14 create_pack with no options: active, eligible value and points follow the rules (null)', (pg_temp.c('pc1')::jsonb ->> 'active')::boolean and (pg_temp.c('pc1')::jsonb -> 'eligible_value')::text = 'null' and (pg_temp.c('pc1')::jsonb -> 'points_per_pack')::text = 'null', pg_temp.c('pc1'));
select pg_temp.chk('R14 create_pack {active:false} alone changes only that', not (pg_temp.c('pc2')::jsonb ->> 'active')::boolean and (pg_temp.c('pc2')::jsonb -> 'eligible_value')::text = 'null' and (pg_temp.c('pc2')::jsonb -> 'points_per_pack')::text = 'null', pg_temp.c('pc2'));
select pg_temp.chk('R14 create_pack {points_per_pack:5} alone changes only that', (pg_temp.c('pc3')::jsonb ->> 'active')::boolean and (pg_temp.c('pc3')::jsonb ->> 'points_per_pack')::int = 5 and (pg_temp.c('pc3')::jsonb -> 'eligible_value')::text = 'null', pg_temp.c('pc3'));
select pg_temp.chk('R14 create_pack accepts explicit nulls for the two nullable options', (pg_temp.c('pc4')::jsonb ->> 'active')::boolean and (pg_temp.c('pc4')::jsonb -> 'points_per_pack')::text = 'null', pg_temp.c('pc4'));
select pg_temp.chk('R14 create_pack accepts a null patch (all defaults)', (pg_temp.c('pc5')::jsonb ->> 'active')::boolean and (pg_temp.c('pc5')::jsonb -> 'points_per_pack')::text = 'null', pg_temp.c('pc5'));
select pg_temp.err_like('R14 create_pack: {active: null} is refused (not nullable)', $q$select public.rw_admin_create_pack(gen_random_uuid(), 'x', 100, '[{"sku_code":"FG-000124","qty":1}]', '{"active": null}')$q$, '%BAD_PACK%');
select pg_temp.chk('R14 the settle triggers left lock_timeout exactly as they found it (the 400 ms is local to the trigger)', current_setting('lock_timeout') = pg_temp.c('lt0'), current_setting('lock_timeout') || ' vs ' || pg_temp.c('lt0'));
select pg_temp.chk('R14 no settle_error is left unexplained: every one in this run came from a fault the tests injected on purpose', not exists (select 1 from public.rw_events_log where action = 'settle_error' and detail ->> 'message' not like '%rw_test_break%'), (select string_agg(detail ->> 'message', ' | ') from public.rw_events_log where action = 'settle_error' and detail ->> 'message' not like '%rw_test_break%'));

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'REWARDS_CORE_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
