-- Before 20261122130000: what the rollback must restore exactly.
create temp table t_pre (k text primary key, v text);
insert into t_pre select 'fn_my_invoices', md5(pg_get_functiondef('public.finance_my_invoices()'::regprocedure));
insert into t_pre select 'grant_my_invoices', has_function_privilege('authenticated', 'public.finance_my_invoices()', 'execute')::text;
insert into t_pre select 'cols_customers', string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'finance_customers';
insert into t_pre select 'cols_invoices', string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'finance_invoices';
insert into t_pre select 'triggers', string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid in ('public.finance_invoices'::regclass, 'public.finance_receipts'::regclass, 'public.finance_customers'::regclass) and not tgisinternal;
insert into t_pre select 'finance_fns', string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'finance\_%';
