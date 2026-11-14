-- Second half of the rollback proof (see checkout_down_pre.sql): the schema after "migration 4 + its rollback" must equal the schema before.
create temp table d_now as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
do $$ declare r text; bad int; tot int;
begin
  create temp table d_res (n serial, test text, ok boolean, detail text);
  insert into d_res (test, ok, detail)
  select 'every function is back to exactly its previous body: ' || f.sig, exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h), null
  from d_funcs f where f.sig ~ '(shop_place_order|shop_settings_public|shop_admin_save_settings)';
  insert into d_res (test, ok, detail)
  select 'no function was lost or changed (all ' || count(*) || ' public functions)', count(*) filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'no function is left over from migration 4', count(*) = 0, string_agg(x.sig, ', ') from d_now x where not exists (select 1 from d_funcs f where f.sig = x.sig);
  insert into d_res (test, ok, detail)
  select 'tables, sequences and views are exactly as before', not exists (select 1 from (select relname from d_rels except select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m')) a)
    and not exists (select 1 from (select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m') except select relname from d_rels) b), null;
  insert into d_res (test, ok, detail)
  select 'columns are exactly as before (the new settings column is gone)',
    not exists (select 1 from (select table_name, column_name, is_nullable, data_type from d_cols except select table_name, column_name, is_nullable, data_type from information_schema.columns where table_schema = 'public' and table_name in ('shop_orders', 'shop_settings', 'finance_payment_evidence')) a)
    and not exists (select 1 from (select table_name, column_name, is_nullable, data_type from information_schema.columns where table_schema = 'public' and table_name in ('shop_orders', 'shop_settings', 'finance_payment_evidence') except select table_name, column_name, is_nullable, data_type from d_cols) b), null;
  insert into d_res (test, ok, detail)
  select 'check constraints are exactly as before (address required for delivery again)',
    not exists (select 1 from (select tbl, conname, def from d_con except select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint where conrelid in ('public.shop_orders'::regclass, 'public.shop_settings'::regclass)) a)
    and not exists (select 1 from (select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid in ('public.shop_orders'::regclass, 'public.shop_settings'::regclass) except select tbl, conname, def from d_con) b), null;
  insert into d_res (test, ok, detail)
  select 'triggers are exactly as before', not exists (select 1 from (select relname, tgname from d_trg except select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal) a)
    and not exists (select 1 from (select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal except select relname, tgname from d_trg) b), null;
  insert into d_res (test, ok, detail)
  select 'the 9-argument shop_place_order is callable by customers again and the 14-argument one is gone',
    has_function_privilege('authenticated', 'public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text)', 'execute')
    and not has_function_privilege('anon', 'public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text)', 'execute')
    and to_regprocedure('public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text)') is null, null;

  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'CHECKOUT_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
