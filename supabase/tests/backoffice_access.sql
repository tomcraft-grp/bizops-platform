-- Tests for 20261128110000_backoffice_access.sql, run after the migration in ONE transaction that always rolls back (scripts/run-backoffice-access-sql-tests.sh).
-- Real data: S / S2 = the two real SUPER_ADMINs, M1..M4 = real LINE members (USER). Roles, audit rows and members changed here disappear with the rollback.
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
create or replace function pg_temp.role_of(p uuid) returns text language sql as $$ select pg_temp.sv(format('select role from public.profiles where id = %L', p)) $$;
create or replace function pg_temp.audits(p uuid) returns integer language sql as $$
  select pg_temp.sv(format($q$select count(*) from public.auth_audit_logs where action = 'role_change' and detail ->> 'target' = %L and detail ->> 'via' = 'line_members'$q$, p))::int $$;

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('S2', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' and id <> pg_temp.c('S')::uuid order by created_at limit 1));
select pg_temp.put('M1', (select id::text from public.profiles where role = 'USER' and status = 'active' and line_user_id is not null order by created_at limit 1));
select pg_temp.put('M2', (select id::text from public.profiles where role = 'USER' and status = 'active' and line_user_id is not null and id <> pg_temp.c('M1')::uuid order by created_at limit 1));
select pg_temp.put('M3', (select id::text from public.profiles where role = 'USER' and status = 'active' and line_user_id is not null and id not in (pg_temp.c('M1')::uuid, pg_temp.c('M2')::uuid) order by created_at limit 1));
select pg_temp.put('M4', (select id::text from public.profiles where role = 'USER' and status = 'active' and line_user_id is not null and id not in (pg_temp.c('M1')::uuid, pg_temp.c('M2')::uuid, pg_temp.c('M3')::uuid) order by created_at limit 1));
select pg_temp.chk('F0 fixtures: two super admins and four LINE members', (select count(*) from t_ctx where v is not null) = 6, (select string_agg(k || '=' || coalesce(v, 'NULL'), ',') from t_ctx));
select pg_temp.put('before_roles', pg_temp.sv($q$select string_agg(id || ':' || role, ',' order by id) from public.profiles$q$));
select pg_temp.put('before_orders', pg_temp.sv($q$select count(*) from public.shop_orders$q$));
select pg_temp.put('admins_before', pg_temp.sv($q$select count(*) from public.profiles where role = 'ADMIN'$q$));
select pg_temp.put('members_audit_before', pg_temp.sv($q$select count(*) from public.auth_audit_logs where action = 'role_change' and detail ->> 'via' = 'line_members'$q$));
select pg_temp.put('before_audit', pg_temp.sv($q$select count(*) from public.auth_audit_logs$q$));
-- M2 is disabled and M3 has no LINE id, set up the way the app does (a SUPER_ADMIN acting; a person can never change line_user_id, the database owner can)
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.sx(format($q$update public.profiles set status = 'disabled' where id = %L$q$, pg_temp.c('M2')));
select set_config('request.jwt.claims', '', true);
select pg_temp.sx(format($q$update public.profiles set line_user_id = null where id = %L$q$, pg_temp.c('M3')));

-- ================================================================================================ who may call it
set local role anon;
select pg_temp.chk('A1 anon cannot call it', not has_function_privilege('anon', 'public.line_member_set_access(uuid, boolean, text)', 'execute'));
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{}', true);
select pg_temp.err_like('A1 without a signed-in user it refuses', format($q$select public.line_member_set_access(%L::uuid, true)$q$, pg_temp.c('M1')), '%sign in%');
select pg_temp.as_user(pg_temp.c('M2')::uuid);
select pg_temp.err_like('A2 a member cannot give anybody access', format($q$select public.line_member_set_access(%L::uuid, true)$q$, pg_temp.c('M4')), '%Only a SUPER_ADMIN%');
select pg_temp.err_like('A2 nor give themselves access', format($q$select public.line_member_set_access(%L::uuid, true)$q$, pg_temp.c('M2')), '%Only a SUPER_ADMIN%');
select pg_temp.err_like('A2 a member cannot change a role with a direct update either (the old guard still holds)', format($q$update public.profiles set role = 'ADMIN' where id = %L$q$, pg_temp.c('M2')), '%cannot change%');
reset role;

-- ================================================================================================ giving access
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('G1 a SUPER_ADMIN gives a LINE member back-office access', (public.line_member_set_access(pg_temp.c('M1')::uuid, true, 'Shop manager') ->> 'role') = 'ADMIN'
  and (public.line_member_set_access(pg_temp.c('M1')::uuid, true) ->> 'changed')::boolean = false);
reset role;
select pg_temp.chk('G1 the member is now ADMIN (and nobody else changed)', pg_temp.role_of(pg_temp.c('M1')::uuid) = 'ADMIN'
  and pg_temp.sv($q$select count(*) from public.profiles where role = 'ADMIN'$q$)::int = pg_temp.c('admins_before')::int + 1);
select pg_temp.chk('G1 exactly one audit row: who, whom, from, to, why', pg_temp.audits(pg_temp.c('M1')::uuid) = 1
  and pg_temp.sv(format($q$select (actor_id::text = %L and detail ->> 'from' = 'USER' and detail ->> 'to' = 'ADMIN' and detail ->> 'reason' = 'Shop manager' and detail ->> 'target_name' is not distinct from (select display_name from public.profiles where id = %L))::text from public.auth_audit_logs where action = 'role_change' and detail ->> 'target' = %L and detail ->> 'via' = 'line_members'$q$, pg_temp.c('S'), pg_temp.c('M1'), pg_temp.c('M1')))::boolean);
select pg_temp.chk('G1 giving it again changed nothing and wrote nothing more', pg_temp.audits(pg_temp.c('M1')::uuid) = 1);
select pg_temp.chk('G1 the member''s customer data is untouched', pg_temp.sv($q$select count(*) from public.shop_orders$q$) = pg_temp.c('before_orders'));
-- what the new ADMIN can and cannot do
set local role authenticated; select pg_temp.as_user(pg_temp.c('M1')::uuid);
select pg_temp.chk('G2 the new ADMIN reaches the staff functions at once', public.shop_is_staff() and (public.shop_admin_orders(null, null, 1, 0) ->> 'total')::int >= 0);
select pg_temp.chk('G2 the new ADMIN can read the members list', (select count(*) from public.profiles where line_user_id is not null) >= 4);
select pg_temp.err_like('G2 but cannot give access to another member', format($q$select public.line_member_set_access(%L::uuid, true)$q$, pg_temp.c('M4')), '%Only a SUPER_ADMIN%');
select pg_temp.err_like('G2 nor make themselves SUPER_ADMIN', format($q$update public.profiles set role = 'SUPER_ADMIN' where id = %L$q$, pg_temp.c('M1')), '%cannot change%');
select pg_temp.err_like('G2 nor change another member''s role directly', format($q$update public.profiles set role = 'ADMIN' where id = %L$q$, pg_temp.c('M4')), '%only SUPER_ADMIN%');
reset role;
select pg_temp.chk('G2 none of those attempts changed a role', pg_temp.role_of(pg_temp.c('M4')::uuid) = 'USER' and pg_temp.role_of(pg_temp.c('M1')::uuid) = 'ADMIN');

-- ================================================================================================ refusals
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('R1 an unknown member', $q$select public.line_member_set_access(gen_random_uuid(), true)$q$, 'NOT_FOUND%');
select pg_temp.err_like('R1 yourself', format($q$select public.line_member_set_access(%L::uuid, false)$q$, pg_temp.c('S')), 'SELF_CHANGE%');
select pg_temp.err_like('R1 another SUPER_ADMIN, either way', format($q$select public.line_member_set_access(%L::uuid, false)$q$, pg_temp.c('S2')), 'SUPER_ADMIN_FIXED%');
select pg_temp.err_like('R1 an account without a LINE id', format($q$select public.line_member_set_access(%L::uuid, true)$q$, pg_temp.c('M3')), 'NOT_LINE_MEMBER%');
select pg_temp.err_like('R1 a disabled member cannot be given access', format($q$select public.line_member_set_access(%L::uuid, true)$q$, pg_temp.c('M2')), 'MEMBER_DISABLED%');
select pg_temp.err_like('R1 a reason over 200 characters', format($q$select public.line_member_set_access(%L::uuid, true, repeat('x', 201))$q$, pg_temp.c('M4')), 'REASON_TOO_LONG%');
select pg_temp.err_like('R1 a missing answer', format($q$select public.line_member_set_access(%L::uuid, null)$q$, pg_temp.c('M4')), 'BAD_VALUE%');
reset role;
select pg_temp.chk('R2 none of the refusals changed a role or wrote an audit row', pg_temp.role_of(pg_temp.c('M4')::uuid) = 'USER' and pg_temp.role_of(pg_temp.c('M2')::uuid) = 'USER' and pg_temp.role_of(pg_temp.c('M3')::uuid) = 'USER'
  and pg_temp.role_of(pg_temp.c('S2')::uuid) = 'SUPER_ADMIN' and pg_temp.sv($q$select count(*) from public.auth_audit_logs where action = 'role_change' and detail ->> 'via' = 'line_members'$q$)::int = pg_temp.c('members_audit_before')::int + 1);

-- ================================================================================================ taking access back
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('T1 a SUPER_ADMIN takes the access back', (public.line_member_set_access(pg_temp.c('M1')::uuid, false, 'Left the shop') ->> 'role') = 'USER');
reset role;
select pg_temp.chk('T1 the member is a customer again, and it was recorded', pg_temp.role_of(pg_temp.c('M1')::uuid) = 'USER' and pg_temp.audits(pg_temp.c('M1')::uuid) = 2
  and pg_temp.sv(format($q$select count(*) from public.auth_audit_logs where action = 'role_change' and detail ->> 'target' = %L and detail ->> 'from' = 'ADMIN' and detail ->> 'to' = 'USER' and detail ->> 'reason' = 'Left the shop'$q$, pg_temp.c('M1')))::int = 1);
set local role authenticated; select pg_temp.as_user(pg_temp.c('M1')::uuid);
select pg_temp.chk('T2 the staff functions are closed to them at once (no need to wait for a new sign-in)', not public.shop_is_staff());
select pg_temp.err_like('T2 the order list refuses them', $q$select public.shop_admin_orders(null, null, 1, 0)$q$, '%not allowed%');
select pg_temp.chk('T2 they still see their own customer data', (select count(*) from public.profiles where id = pg_temp.c('M1')::uuid) = 1);
reset role;
-- a member who was given access and is then disabled can still be taken back
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('T3 give M4 access', (public.line_member_set_access(pg_temp.c('M4')::uuid, true) ->> 'role') = 'ADMIN');
select pg_temp.sx(format($q$update public.profiles set status = 'disabled' where id = %L$q$, pg_temp.c('M4')));
select pg_temp.chk('T3 a disabled ADMIN can still be taken back', (public.line_member_set_access(pg_temp.c('M4')::uuid, false) ->> 'role') = 'USER');
reset role;
select pg_temp.chk('T3 the audit trail has both steps', pg_temp.audits(pg_temp.c('M4')::uuid) = 2);

-- ================================================================================================ nothing else changed
select pg_temp.chk('Z1 the earlier audit rows are unchanged (only ours were added)', pg_temp.sv($q$select count(*) from public.auth_audit_logs$q$)::int = pg_temp.c('before_audit')::int + 4);
select pg_temp.chk('Z1 customer data and orders are untouched', pg_temp.sv($q$select count(*) from public.shop_orders$q$) = pg_temp.c('before_orders'));
select pg_temp.chk('Z1 only the two profiles we set up differ from before (M2 disabled, M3 without a LINE id are test setup, not roles)', pg_temp.sv($q$select string_agg(id || ':' || role, ',' order by id) from public.profiles$q$) = pg_temp.c('before_roles'));

do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'BACKOFFICE_ACCESS_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
