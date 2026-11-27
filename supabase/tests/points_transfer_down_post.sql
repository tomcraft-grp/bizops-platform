-- Rollback proof for 20261127120000: pre -> migration -> rollback -> this file, ONE transaction that always rolls back.
create temp table t_res (n serial, test text, ok boolean, detail text);
insert into t_res (test, ok, detail) select 'D1 rw_admin_adjust_points identical to before', md5(pg_get_functiondef('public.rw_admin_adjust_points(uuid, integer, text)'::regprocedure)) = (select v from t_pre where k = 'fn_adjust'), null;
insert into t_res (test, ok, detail) select 'D1 its grant as before', has_function_privilege('authenticated', 'public.rw_admin_adjust_points(uuid, integer, text)', 'execute')::text = (select v from t_pre where k = 'grant_adjust'), null;
insert into t_res (test, ok, detail) select 'D2 the same rw_ functions as before', (select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'rw\_%') = (select v from t_pre where k = 'rw_fns'), null;
insert into t_res (test, ok, detail) select 'D2 the same rw_ tables and sequences as before', (select string_agg(relname, ',' order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S') and relname like 'rw\_%') = (select v from t_pre where k = 'rw_tables'), null;
insert into t_res (test, ok, detail) select 'D3 the points ledger is untouched (triggers and columns)', (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.rw_points_ledger'::regclass and not tgisinternal) = (select v from t_pre where k = 'ledger_triggers')
  and (select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'rw_points_ledger') = (select v from t_pre where k = 'ledger_cols'), null;
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'POINTS_TRANSFER_DOWN % of % passed\n%', tot - bad, tot, r;
end $$;
