-- Rollback proof for 20261122130000: pre -> migration -> rollback -> this file, ONE transaction that always rolls back.
create temp table t_res (n serial, test text, ok boolean, detail text);
insert into t_res (test, ok, detail) select 'D1 finance_my_invoices identical to before', md5(pg_get_functiondef('public.finance_my_invoices()'::regprocedure)) = (select v from t_pre where k = 'fn_my_invoices'), null;
insert into t_res (test, ok, detail) select 'D1 its grant as before', has_function_privilege('authenticated', 'public.finance_my_invoices()', 'execute')::text = (select v from t_pre where k = 'grant_my_invoices'), null;
insert into t_res (test, ok, detail) select 'D2 customer columns as before', (select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'finance_customers') = (select v from t_pre where k = 'cols_customers'), null;
insert into t_res (test, ok, detail) select 'D2 invoice columns as before', (select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'finance_invoices') = (select v from t_pre where k = 'cols_invoices'), null;
insert into t_res (test, ok, detail) select 'D3 triggers as before', (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid in ('public.finance_invoices'::regclass, 'public.finance_receipts'::regclass, 'public.finance_customers'::regclass) and not tgisinternal) = (select v from t_pre where k = 'triggers'), null;
insert into t_res (test, ok, detail) select 'D3 the same finance functions as before', (select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'finance\_%') = (select v from t_pre where k = 'finance_fns'), null;
insert into t_res (test, ok, detail) select 'D4 link table, sequence and phone function gone', to_regclass('public.finance_customer_links') is null and to_regclass('public.finance_customer_code_seq') is null and to_regprocedure('public.finance_norm_phone(text)') is null, null;
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'CENTRAL_RECEIVABLES_DOWN % of % passed\n%', tot - bad, tot, r;
end $$;
