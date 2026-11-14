-- Second half of the rollback proof (see wallet_down_pre.sql). Compares the schema after "migration + rollback" with the schema before.
create temp table d_now as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
do $$ declare r text; bad int; tot int;
begin
  create temp table d_res (n serial, test text, ok boolean, detail text);
  insert into d_res (test, ok, detail)
  select 'every function is back to exactly its pre-wallet body: ' || f.sig, exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h), null
  from d_funcs f where f.sig ~ '(finance_submit_evidence|finance_verify_evidence|finance_resolve_overpayment|finance_reverse_receipt|shop_settings_public|shop_place_order|shop_admin_settings)';
  insert into d_res (test, ok, detail)
  select 'no function was lost or changed (all ' || count(*) || ' public functions)', count(*) filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'no function is left over from the wallet migration', count(*) = 0, string_agg(x.sig, ', ')
  from d_now x where not exists (select 1 from d_funcs f where f.sig = x.sig);
  insert into d_res (test, ok, detail)
  select 'no table, sequence or view is left over, none was lost', not exists (select 1 from (select relname from d_rels except select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m')) a)
    and not exists (select 1 from (select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m') except select relname from d_rels) b),
    (select string_agg(x, ', ') from (select 'left over: ' || c.relname as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m') and c.relname not in (select relname from d_rels)
       union all select 'lost: ' || relname from d_rels where relname not in (select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')) q);
  insert into d_res (test, ok, detail)
  select 'columns of the finance tables are exactly as before (names, types, nullability)',
    not exists (select 1 from (select table_name, column_name, is_nullable, data_type from d_cols except select table_name, column_name, is_nullable, data_type from information_schema.columns where table_schema = 'public' and table_name in ('finance_receipts', 'finance_payment_evidence', 'finance_invoices', 'finance_customers')) a)
    and not exists (select 1 from (select table_name, column_name, is_nullable, data_type from information_schema.columns where table_schema = 'public' and table_name in ('finance_receipts', 'finance_payment_evidence', 'finance_invoices', 'finance_customers') except select table_name, column_name, is_nullable, data_type from d_cols) b), null;
  insert into d_res (test, ok, detail)
  select 'triggers are exactly as before (the invoice queue trigger is gone)', not exists (select 1 from (select relname, tgname from d_trg except select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal) a)
    and not exists (select 1 from (select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal except select relname, tgname from d_trg) b), null;
  insert into d_res (test, ok, detail)
  select 'row-level-security policies are exactly as before', not exists (select 1 from (select tablename, policyname from d_pol except select tablename, policyname from pg_policies where schemaname = 'public') a)
    and not exists (select 1 from (select tablename, policyname from pg_policies where schemaname = 'public' except select tablename, policyname from d_pol) b), null;
  insert into d_res (test, ok, detail)
  select 'the original 8-argument finance_submit_evidence is callable by customers again and the 9-argument one is gone',
    has_function_privilege('authenticated', 'public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text)', 'execute')
    and to_regprocedure('public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text, uuid)') is null, null;
  insert into d_res (test, ok, detail)
  select 'the wallet tables are gone', to_regclass('public.finance_wallets') is null and to_regclass('public.finance_wallet_transactions') is null and to_regclass('public.finance_wallet_deposits') is null
    and to_regclass('public.finance_bank_accounts') is null and to_regclass('public.finance_gl_queue') is null and to_regclass('public.finance_settings') is null, null;

  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'WALLET_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
