-- First half of the proof that the rollback of 20261121120000_sku_registry_sync.sql (supabase/rollbacks/20261121120000_sku_registry_sync_down.sql) really undoes its migration.
-- Run through scripts/run-sku-registry-sync-down-proof.sh inside ONE transaction that always rolls back (nothing persists):
--   THIS FILE (a fingerprint of the whole public schema) -> the migration -> [a guard scenario] -> the rollback -> sku_registry_sync_down_post.sql (compare).
-- The fingerprint covers everything the migration touches and a little more: every function (full text and privileges), every table / sequence / view (with the row-level-security
-- flag and privileges), every column (type, nullability, default), every constraint (name and definition: the history action check comes back under its original name), every
-- index, every trigger and every row-level-security policy.
create temp table d_funcs as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h, coalesce(p.proacl::text, '') as acl   -- line-ending style is ignored
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_rels as
  select c.relname, c.relkind, c.relrowsecurity as rls, coalesce(c.relacl::text, '') as acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_cols as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public';
create temp table d_cons as
  select c.conrelid::regclass::text as tbl, c.conname, c.contype, pg_get_constraintdef(c.oid) as def
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public';
create temp table d_idx as
  select tablename, indexname, indexdef from pg_indexes where schemaname = 'public';
create temp table d_trg as
  select c.relname, t.tgname, md5(replace(pg_get_triggerdef(t.oid), chr(13), '')) as h
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal;
create temp table d_pol as
  select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public';
