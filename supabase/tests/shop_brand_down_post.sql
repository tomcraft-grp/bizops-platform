-- Second half of the proof that 20261119100000_shop_no_brand_filter_down.sql undoes its migration (fingerprint: shop_brand_down_pre.sql).
create temp table d_funcs_now as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h, coalesce(p.proacl::text, '') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
do $$ declare r text; bad int; tot int;
begin
  create temp table d_res (n serial, test text, ok boolean, detail text);
  insert into d_res (test, ok, detail)
  select 'every one of the ' || count(*) || ' public functions has exactly its old definition', count(*) filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.h = f.h)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.h = f.h))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'every function has exactly its old privileges', count(*) filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.acl = f.acl)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.acl = f.acl))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'no function was added or lost', (select count(*) from d_funcs_now) = (select count(*) from d_funcs) and not exists (select 1 from d_funcs_now x where not exists (select 1 from d_funcs f where f.sig = x.sig)), null;
  insert into d_res (test, ok, detail)
  select 'tables, views and sequences are exactly as before',
    not exists (select 1 from (select relname, relkind from d_rels except select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm')) a)
    and not exists (select 1 from (select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm') except select relname, relkind from d_rels) b), null;
  insert into d_res (test, ok, detail)
  select 'every column is exactly as before',
    not exists (select 1 from (select * from d_cols except select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public') a)
    and not exists (select 1 from (select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public' except select * from d_cols) b), null;
  insert into d_res (test, ok, detail)
  select 'every row-level-security policy is exactly as before',
    not exists (select 1 from (select * from d_pol except select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public') a)
    and not exists (select 1 from (select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' except select * from d_pol) b), null;
  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'SHOP_NO_BRAND_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
