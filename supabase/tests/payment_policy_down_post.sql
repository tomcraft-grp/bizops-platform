-- Rollback proof for 20261127100000 and 20261127110000: pre -> migrations -> rollbacks -> this file, ONE transaction that always rolls back.
create temp table t_res (n serial, test text, ok boolean, detail text);
insert into t_res (test, ok, detail) select 'D1 ' || x.k || ' identical to before', md5(pg_get_functiondef(p.oid)) = x.v, null
  from t_pre x join pg_proc p on 'fn_' || p.proname = x.k join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' where x.k like 'fn\_%';
insert into t_res (test, ok, detail) select 'D1 both functions were compared', (select count(*) from t_pre where k like 'fn\_%' and k <> 'fn_x' and k in ('fn_finance_submit_evidence', 'fn_finance_pay_invoice_with_wallet')) = 2, null;
insert into t_res (test, ok, detail) select 'D2 grants as before ' || p.proname, has_function_privilege('authenticated', p.oid, 'execute')::text = (select v from t_pre where k = 'grant_' || p.proname), null
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('finance_submit_evidence', 'finance_pay_invoice_with_wallet');
insert into t_res (test, ok, detail) select 'D3 customer columns as before', (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'finance_customers') = (select v from t_pre where k = 'cols_customers'), null;
insert into t_res (test, ok, detail) select 'D3 customer constraints as before', (select string_agg(conname, ',' order by conname) from pg_constraint where conrelid = 'public.finance_customers'::regclass) = (select v from t_pre where k = 'constraints_customers'), null;
insert into t_res (test, ok, detail) select 'D3 evidence triggers as before', (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.finance_payment_evidence'::regclass and not tgisinternal) = (select v from t_pre where k = 'triggers_evidence'), null;
insert into t_res (test, ok, detail) select 'D4 the same finance functions as before', (select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'finance\_%') = (select v from t_pre where k = 'finance_fns'), null;
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'PAYMENT_POLICY_DOWN % of % passed\n%', tot - bad, tot, r;
end $$;
