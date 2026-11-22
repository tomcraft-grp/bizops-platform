-- Before 20261122120000: the definitions the rollback must restore.
create temp table t_pre (k text primary key, v text);
insert into t_pre select 'fn_' || p.proname || '_' || pronargs, md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('finance_record_payment', 'finance_payments_overview');
insert into t_pre select 'grant_record', has_function_privilege('authenticated', 'public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text)', 'execute')::text;
