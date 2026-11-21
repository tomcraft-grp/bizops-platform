-- First half of the proof that 20261121110000_event_boards_down.sql undoes 20261121110000_event_boards.sql (second half: event_boards_down_post.sql).
-- A fingerprint taken BEFORE the migration runs (with the rewards core already in place): every function in schema public (definition + privileges), tables / views / sequences,
-- columns, row-level-security policies, constraints, triggers and indexes of schema public.
create temp table d_funcs as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h, coalesce(p.proacl::text, '') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_rels as
  select c.relname, c.relkind, c.relrowsecurity as rls, coalesce(c.relacl::text, '') as acl from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_cols as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public';
create temp table d_pol as select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public';
create temp table d_cons as
  select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as typ, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public';
create temp table d_trg as
  select t.tgrelid::regclass::text as tbl, t.tgname, md5(pg_get_triggerdef(t.oid)) as h from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal;
create temp table d_idx as select tablename, indexname, indexdef from pg_indexes where schemaname = 'public';
