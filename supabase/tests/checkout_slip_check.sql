-- Tests for 20261124120000_checkout_slip_check.sql, run inside one transaction that is rolled back: <migration> ; <this file>
create temp table t_res (n serial, test text, ok boolean, detail text);
grant all on t_res to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text;
begin begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error'); exception when others then m := sqlerrm; perform pg_temp.chk(p_test, m ilike p_pat, m); end; end $$;
create temp table t_who (r text primary key, id uuid); grant all on t_who to authenticated;
insert into t_who select distinct on (role) role, id from public.profiles where status = 'active' order by role, created_at;
create or replace function pg_temp.as_user(p_r text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', (select id from t_who where r = p_r), 'role', 'authenticated')::text, true) $$;

select pg_temp.chk('S1 the new switch starts as the reader is', (select checkout_check_enabled = own_reader_enabled from public.finance_settings where id));
set local role anon;
select pg_temp.err_like('S2 anon cannot change it', $q$select public.finance_set_checkout_check(true)$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user('USER');
select pg_temp.err_like('S3 nor can a customer', $q$select public.finance_set_checkout_check(true)$q$, '%allowed%');
-- (since 20261128150000 also "recipients": the names the payment card shows, only while the check before ordering is on; see slip_recipient_check.sql S09/S10)
select pg_temp.chk('S4 a customer learns the switch, the date rule and the receiver names, and no more', (select array_agg(k order by k) from jsonb_object_keys(public.finance_own_reader()) k) = array['after_min', 'before_min', 'can_manage', 'can_read', 'checkout', 'enabled', 'recipients'] and not (public.finance_own_reader() ->> 'can_manage')::boolean, public.finance_own_reader()::text);
select pg_temp.as_user('SUPER_ADMIN');
select pg_temp.chk('S5 a manager turns it on without the staff reader', (public.finance_set_checkout_check(true) ->> 'checkout')::boolean);
select pg_temp.chk('S6 and the two are independent', (public.finance_own_reader() ->> 'checkout')::boolean and not (public.finance_set_own_reader(false) ->> 'enabled')::boolean);
select pg_temp.err_like('S7 null is not a setting', $q$select public.finance_set_checkout_check(null)$q$, 'INVALID_SETTING%');
reset role;
select pg_temp.chk('S8 audited', exists (select 1 from public.finance_events where action = 'settings.checkout_check'));
select pg_temp.chk('S9 the date rule is the shop''s own', (select (public.finance_own_reader() ->> 'before_min')::int = slip_window_before_min and (public.finance_own_reader() ->> 'after_min')::int = slip_future_tolerance_min from public.finance_settings where id));
do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'CHECKOUT_CHECK_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
