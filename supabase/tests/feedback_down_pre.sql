-- Proof that supabase/rollbacks/20261115600000_feedback_english_context_down.sql really undoes the migration. Run through
-- scripts/run-feedback-down-proof.sh inside ONE transaction that always rolls back (nothing persists):
--   THIS FILE (fingerprint of the live schema) -> the migration -> the rollback -> feedback_down_post.sql (compare).
create temp table d_funcs as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h   -- line-ending style is ignored; the text of every function must be identical
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_cols as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns
  where table_schema = 'public' and table_name like 'feedback\_%' or table_schema = 'public' and table_name = 'bizops_feedback_issues';
create temp table d_rels as
  select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_trg as
  select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal;
create temp table d_con as
  select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace;
create temp table d_pol as
  select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and (tablename like 'feedback\_%' or tablename = 'bizops_feedback_issues');
create temp table d_fingerprint as   -- the five real issues, byte for byte
  select id, md5(title || '|' || description || '|' || status || '|' || coalesce(root_cause, '') || '|' || coalesce(resolution, '')) as h from public.bizops_feedback_issues;
