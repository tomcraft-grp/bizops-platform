-- Before 20261127100000 / 20261127110000: what the rollbacks must restore exactly.
create temp table t_pre (k text primary key, v text);
insert into t_pre select 'fn_' || p.proname, md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('finance_submit_evidence', 'finance_pay_invoice_with_wallet');
insert into t_pre select 'grant_' || p.proname, has_function_privilege('authenticated', p.oid, 'execute')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('finance_submit_evidence', 'finance_pay_invoice_with_wallet');
insert into t_pre select 'cols_customers', string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'finance_customers';
insert into t_pre select 'triggers_evidence', string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.finance_payment_evidence'::regclass and not tgisinternal;
insert into t_pre select 'constraints_customers', string_agg(conname, ',' order by conname) from pg_constraint where conrelid = 'public.finance_customers'::regclass;
insert into t_pre select 'finance_fns', string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'finance\_%';
