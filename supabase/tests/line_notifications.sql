-- LINE OA order notifications, tested against REAL data (real catalogue, real profiles, real bank accounts) inside ONE transaction that is rolled back
-- (scripts/run-line-sql-tests.sh sends prod_dry_run_prelude.sql, the new migration and this file). Nothing persists: the last statement raises an exception
-- that carries the result table.
-- People: S = the oldest active SUPER_ADMIN (finance manager), ADM = the ADMIN promoted by the prelude (shop staff, NO finance role), A = a customer.
-- Sections: L1 settings / credentials / linking / webhook dedupe, L2 finance (optional reference, quick confirm), L3 card data, line_act, queue.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon, service_role; grant usage on sequence t_res_n_seq to authenticated, anon, service_role;
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
declare s text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected SQLSTATE ' || p_state || ')');
  exception when others then get stacked diagnostics s = returned_sqlstate; perform pg_temp.chk(p_test, s = p_state, s || ' ' || sqlerrm);
  end;
end $$;
create or replace function pg_temp.q(p_test text, p_sql text) returns void language plpgsql as $$
declare b boolean; m text;
begin
  begin execute p_sql into b; perform pg_temp.chk(p_test, b, case when b is true then null else 'returned ' || coalesce(b::text, 'null') end);
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, false, m);
  end;
end $$;
-- auth.uid() reads request.jwt.claim.sub FIRST, then request.jwt.claims; line_redeem_code / line_act set both (transaction-local), so the helper sets both too
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true), set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
-- the code a staff member would read on the screen (the function returns it in clear once; only its hash is stored)
create or replace function pg_temp.code(p_kind text) returns text language plpgsql as $$
declare r jsonb; begin r := public.line_link_code(p_kind); return r ->> 'code'; end $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'ADM', id::text from public.profiles where role = 'ADMIN' and status = 'active' order by created_at limit 1;
delete from public.finance_staff_roles where user_id = pg_temp.c('ADM')::uuid;      -- ADM is shop staff only (no finance role) in every scenario below

-- ================================================================================================= L1 settings, credentials, linking, webhook dedupe
select pg_temp.q('L1.1 defaults: off, quick approve off, cap 3000, four reasons, app url',
  $q$ select enabled = false and quick_approve_enabled = false and quick_approve_max_amount = 3000
       and reject_reasons = array['สลิปไม่ถูกต้อง','ยอดเงินไม่ตรง','สินค้าหมด','ลูกค้าขอยกเลิก']
       and app_url = 'https://tomcraft-grp.github.io/bizops-platform/' and group_id is null from public.line_settings $q$);

set local role authenticated;
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_state('L1.2 a customer cannot read the LINE settings', 'select public.line_admin_settings()', '42501');
select pg_temp.as_user(pg_temp.c('ADM')::uuid);
select pg_temp.q('L1.2 staff read the settings: credential flags only, no credential keys',
  $q$ select (s ? 'secret_set') and (s ? 'token_set') and not (s ? 'channel_secret') and not (s ? 'access_token') and (s ->> 'secret_set') = 'false'
       and (s ->> 'can_edit') = 'false' and s -> 'links' = 'null'::jsonb from (select public.line_admin_settings() s) x $q$);
select pg_temp.err_state('L1.3 ADMIN cannot change settings', $q$ select public.line_admin_save_settings('{"quick_approve_enabled": true}') $q$, '42501');
select pg_temp.err_state('L1.3 ADMIN cannot set credentials', $q$ select public.line_admin_set_credentials('s', 't') $q$, '42501');

select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.line_admin_set_credentials('0123456789abcdef0123456789abcdef', 'TESTTOKEN-line-0123456789-abcdefghij');
select pg_temp.q('L1.4 credentials set: flags true, values never in the settings answer',
  $q$ select (s ->> 'secret_set') = 'true' and (s ->> 'token_set') = 'true' and s::text not like '%TESTTOKEN%' and s::text not like '%0123456789abcdef0123%'
       from (select public.line_admin_settings() s) x $q$);
select pg_temp.err_state('L1.4 a client cannot read the credentials', 'select public.line_credentials_internal()', '42501');
reset role;
set local role service_role;
select pg_temp.q('L1.4 the service role reads the credentials (and a dispatch secret exists)',
  $q$ select c ->> 'channel_secret' = '0123456789abcdef0123456789abcdef' and c ->> 'access_token' = 'TESTTOKEN-line-0123456789-abcdefghij'
       and length(c ->> 'dispatch_secret') >= 32 from (select public.line_credentials_internal() c) x $q$);
reset role;

set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('L1.5 switching on without a bound group is refused', $q$ select public.line_admin_save_settings('{"enabled": true}') $q$, 'LINE_NOT_READY%');
select pg_temp.err_like('L1.5 an unknown setting is refused', $q$ select public.line_admin_save_settings('{"group_id": "x"}') $q$, 'INVALID_SETTING%');
select pg_temp.err_like('L1.5 a cap of zero is refused', $q$ select public.line_admin_save_settings('{"quick_approve_max_amount": 0}') $q$, '%amount%');

select pg_temp.as_user(pg_temp.c('ADM')::uuid);
insert into t_ctx select 'code_adm', pg_temp.code('staff');
select pg_temp.chk('L1.6 a staff link code is 6 digits', pg_temp.c('code_adm') ~ '^[0-9]{6}$', pg_temp.c('code_adm'));
select pg_temp.err_state('L1.6 ADMIN cannot make a group code', $q$ select public.line_link_code('group') $q$, '42501');
reset role;
set local role service_role;
select pg_temp.q('L1.6 redeeming the code in a 1:1 chat links the LINE account',
  format($q$ select public.line_redeem_code('Uadm00000000000000000000000000001', 'Adm on LINE', %L) ->> 'result' = 'linked' $q$, pg_temp.c('code_adm')));
select pg_temp.q('L1.6 the same code cannot be used twice',
  format($q$ select public.line_redeem_code('Uother000000000000000000000000002', 'Other', %L) ->> 'result' = 'bad_code' $q$, pg_temp.c('code_adm')));
reset role;
set local role authenticated;
select pg_temp.as_user(pg_temp.c('ADM')::uuid);
select pg_temp.q('L1.6 the staff member sees their link', $q$ select public.line_admin_settings() -> 'my_link' ->> 'display_name' = 'Adm on LINE' $q$);
reset role;

set local role service_role;
do $$ declare i int; begin for i in 1..5 loop perform public.line_redeem_code('Ubad0000000000000000000000000000x', null, '000000'); end loop; end $$;
select pg_temp.q('L1.7 the sixth wrong code within the hour is rate limited',
  $q$ select public.line_redeem_code('Ubad0000000000000000000000000000x', null, '000001') ->> 'result' = 'rate_limited' $q$);
reset role;

set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'code_grp', pg_temp.code('group');
reset role;
set local role service_role;
select pg_temp.q('L1.8 a group code typed in the group binds that group',
  format($q$ select public.line_redeem_code('Usup00000000000000000000000000003', 'Shop admins', %L, 'Cgroup0000000000000000000000000001') ->> 'result' = 'group_bound' $q$, pg_temp.c('code_grp')));
select pg_temp.q('L1.8 the bound group is stored', $q$ select group_id = 'Cgroup0000000000000000000000000001' and group_name = 'Shop admins' from public.line_settings $q$);
select public.line_group_left('Cgroup0000000000000000000000000001');
select pg_temp.q('L1.8 the bot leaving the group unbinds it', $q$ select group_id is null and group_left_at is not null from public.line_settings $q$);
select pg_temp.q('L1.9 a webhook event is new the first time', $q$ select public.line_webhook_seen('ev-test-1', 'postback', 'group') $q$);
select pg_temp.q('L1.9 the same webhook event is a duplicate the second time', $q$ select not public.line_webhook_seen('ev-test-1', 'postback', 'group') $q$);
reset role;

set local role authenticated;
select pg_temp.as_user(pg_temp.c('ADM')::uuid);
insert into t_ctx select 'code_old', pg_temp.code('staff');
reset role;
update public.line_bind_codes set expires_at = now() - interval '1 minute' where used_at is null;
set local role service_role;
select pg_temp.q('L1.10 an expired code is refused',
  format($q$ select public.line_redeem_code('Uadm00000000000000000000000000001', 'Adm', %L) ->> 'result' = 'bad_code' $q$, pg_temp.c('code_old')));
reset role;

-- L2 and L3 sections are appended above this line by later tasks.

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'LINE_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
