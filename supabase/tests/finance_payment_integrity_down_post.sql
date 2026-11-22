-- Rollback proof for 20261122120000: pre -> migration -> rollback -> this file, ONE transaction that always rolls back.
create temp table t_res (n serial, test text, ok boolean, detail text);
insert into t_res (test, ok, detail) select 'D1 functions identical to before: ' || x.k, md5(pg_get_functiondef(p.oid)) = x.v, null
  from t_pre x join pg_proc p on 'fn_' || p.proname || '_' || p.pronargs = x.k join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' where x.k like 'fn_%';
insert into t_res (test, ok, detail) select 'D1 both functions were compared', (select count(*) from t_pre where k like 'fn_%') = 2, null;
insert into t_res (test, ok, detail) select 'D2 record payment grant as before', has_function_privilege('authenticated', 'public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text)', 'execute')::text = (select v from t_pre where k = 'grant_record'), null;
insert into t_res (test, ok, detail) select 'D3 log function, triggers and key column gone',
  not exists (select 1 from pg_proc where proname in ('finance_customer_payment_log', 'finance_customer_match'))
  and not exists (select 1 from pg_trigger where tgname like 'finance_%_customer_match')
  and not exists (select 1 from information_schema.columns where table_name = 'finance_payment_evidence' and column_name = 'idempotency_key'), null;
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'PAYMENT_INTEGRITY_DOWN % of % passed\n%', tot - bad, tot, r;
end $$;
