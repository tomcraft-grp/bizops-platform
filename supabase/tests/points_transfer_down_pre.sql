-- Before 20261127120000: what the rollback must restore exactly.
create temp table t_pre (k text primary key, v text);
insert into t_pre select 'fn_adjust', md5(pg_get_functiondef('public.rw_admin_adjust_points(uuid, integer, text)'::regprocedure));
insert into t_pre select 'grant_adjust', has_function_privilege('authenticated', 'public.rw_admin_adjust_points(uuid, integer, text)', 'execute')::text;
insert into t_pre select 'rw_fns', string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'rw\_%';
insert into t_pre select 'rw_tables', string_agg(relname, ',' order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S') and relname like 'rw\_%';
insert into t_pre select 'ledger_triggers', string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.rw_points_ledger'::regclass and not tgisinternal;
insert into t_pre select 'ledger_cols', string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'rw_points_ledger';
