-- First half of the proof that 20261121100000_rewards_core_down.sql undoes its migration: a fingerprint of EVERY function in schema public (definition + privileges),
-- of the tables, views and sequences, their columns, row-level-security policies and settings, constraints, indexes and every non-internal trigger, taken before
-- the migration runs. Second half: rewards_core_down_post.sql. The three triggers the migration adds to finance_receipts, finance_allocations and shop_orders are
-- the part of this proof that matters most: the existing payment tables must come back exactly as they were.
create temp table d_funcs as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h, coalesce(p.proacl::text, '') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_rels as
  select c.relname, c.relkind, c.relrowsecurity as rls, coalesce(c.relacl::text, '') as acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_cols as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public';
create temp table d_pol as select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public';
create temp table d_trg as
  select c.relname, t.tgname, md5(pg_get_triggerdef(t.oid)) as h from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal;
create temp table d_con as
  select c.conrelid::regclass::text as rel, c.conname, md5(pg_get_constraintdef(c.oid)) as h from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public';
create temp table d_idx as select tablename, indexname, md5(indexdef) as h from pg_indexes where schemaname = 'public';
