-- Second half of the proof that supabase/rollbacks/20261122140000_line_order_notifications_down.sql undoes the LINE migration. The first half is the generic
-- fingerprint of the public schema, supabase/tests/slip_review_down_pre.sql. Run through scripts/run-line-down-proof.sh inside ONE transaction that always rolls back.
-- The schema after "migration + rollback" must equal the schema before, object by object; the LINE cron job and Vault secrets must be gone too.
create temp table d_funcs_now as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h, coalesce(p.proacl::text, '') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_rels_now as
  select c.relname, c.relkind, c.relrowsecurity as rls, coalesce(c.relacl::text, '') as acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_cols_now as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public';
create temp table d_cons_now as
  select c.conrelid::regclass::text as tbl, c.conname, c.contype, pg_get_constraintdef(c.oid) as def
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public';
create temp table d_idx_now as
  select tablename, indexname, indexdef from pg_indexes where schemaname = 'public';
create temp table d_trg_now as
  select c.relname, t.tgname, md5(replace(pg_get_triggerdef(t.oid), chr(13), '')) as h
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal;
create temp table d_pol_now as
  select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public';
do $$ declare r text; bad int; tot int;
begin
  create temp table d_res (n serial, test text, ok boolean, detail text);
  insert into d_res (test, ok, detail)
  select 'every one of the ' || count(*) || ' public functions has exactly its old definition (the four finance functions are restored)',
    count(*) > 0 and count(*) filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.h = f.h)) = 0,
    string_agg(f.sig, ', ') filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.h = f.h)) from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'every function has exactly its old privileges (the 2-argument Post has its grant back)', count(*) filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.acl = f.acl)) = 0,
    string_agg(f.sig, ', ') filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.acl = f.acl)) from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'no function was added or lost (every line_* function and the 3-argument Post are gone)',
    (select count(*) from d_funcs_now) = (select count(*) from d_funcs) and not exists (select 1 from d_funcs_now x where not exists (select 1 from d_funcs f where f.sig = x.sig)),
    (select string_agg(x.sig, ', ') from d_funcs_now x where not exists (select 1 from d_funcs f where f.sig = x.sig));
  insert into d_res (test, ok, detail)
  select 'the ' || (select count(*) from d_rels) || ' tables, views and sequences are exactly as before (the six line_* tables are gone)',
    not exists (select 1 from (select * from d_rels except select * from d_rels_now) a) and not exists (select 1 from (select * from d_rels_now except select * from d_rels) b),
    (select string_agg(relname, ', ') from (select relname from d_rels_now except select relname from d_rels) z);
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_cols) || ' columns are exactly as before (confirmed_via is gone)',
    not exists (select 1 from (select * from d_cols except select * from d_cols_now) a) and not exists (select 1 from (select * from d_cols_now except select * from d_cols) b),
    (select string_agg(table_name || '.' || column_name, ', ') from (select table_name, column_name from d_cols_now except select table_name, column_name from d_cols) z);
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_cons) || ' constraints are exactly as before',
    not exists (select 1 from (select * from d_cons except select * from d_cons_now) a) and not exists (select 1 from (select * from d_cons_now except select * from d_cons) b),
    coalesce((select string_agg('+' || tbl || '.' || conname, ', ') from (select tbl, conname from d_cons_now except select tbl, conname from d_cons) z), '')
      || coalesce((select string_agg('-' || tbl || '.' || conname, ', ') from (select tbl, conname from d_cons except select tbl, conname from d_cons_now) z), '');
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_idx) || ' indexes are exactly as before',
    not exists (select 1 from (select * from d_idx except select * from d_idx_now) a) and not exists (select 1 from (select * from d_idx_now except select * from d_idx) b),
    (select string_agg(indexname, ', ') from (select indexname from d_idx_now except select indexname from d_idx) z);
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_trg) || ' triggers are exactly as before (the four LINE triggers are gone)',
    not exists (select 1 from (select * from d_trg except select * from d_trg_now) a) and not exists (select 1 from (select * from d_trg_now except select * from d_trg) b),
    (select string_agg(tgname, ', ') from (select tgname from d_trg_now except select tgname from d_trg) z);
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_pol) || ' row-level-security policies are exactly as before',
    not exists (select 1 from (select * from d_pol except select * from d_pol_now) a) and not exists (select 1 from (select * from d_pol_now except select * from d_pol) b),
    (select string_agg(policyname, ', ') from (select policyname from d_pol_now except select policyname from d_pol) z);
  insert into d_res (test, ok, detail)
  select 'the LINE dispatch job is unscheduled', not exists (select 1 from cron.job where jobname = 'line-dispatch'), null;
  insert into d_res (test, ok, detail)
  select 'the LINE Vault secrets are deleted', not exists (select 1 from vault.secrets where name in ('line_channel_secret', 'line_channel_token', 'line_dispatch_secret')), null;

  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'LINE_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
