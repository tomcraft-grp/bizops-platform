-- First half of the proof that 20261119100000_shop_no_brand_filter_down.sql undoes its migration: a fingerprint of EVERY function in schema public
-- (definition + privileges) and of the tables, views and sequences, taken before the migration runs. Second half: shop_brand_down_post.sql.
create temp table d_funcs as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h, coalesce(p.proacl::text, '') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_rels as
  select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_cols as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public';
create temp table d_pol as select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public';
