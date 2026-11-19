-- Second half of the proof that supabase/rollbacks/20261120100000_slip_review_down.sql undoes the slip-review migration (fingerprint: slip_review_down_pre.sql).
-- The schema after "migration + rollback" must equal the schema before, object by object. The closing exception carries the result table and also rolls everything back.
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

  -- functions: text, privileges, and nothing added or lost
  insert into d_res (test, ok, detail)
  select 'every one of the ' || count(*) || ' public functions has exactly its old definition', count(*) > 0 and count(*) filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.h = f.h)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.h = f.h))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'every function has exactly its old privileges (the replaced ones keep their grants, the new ones are gone)', count(*) filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.acl = f.acl)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_funcs_now x where x.sig = f.sig and x.acl = f.acl))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'no function was added or lost', (select count(*) from d_funcs_now) = (select count(*) from d_funcs) and not exists (select 1 from d_funcs_now x where not exists (select 1 from d_funcs f where f.sig = x.sig)),
         (select string_agg(x.sig, ', ') from d_funcs_now x where not exists (select 1 from d_funcs f where f.sig = x.sig));

  -- tables, sequences, views (with the row-level-security flag and the table privileges)
  insert into d_res (test, ok, detail)
  select 'the ' || (select count(*) from d_rels) || ' tables, views and sequences are exactly as before (the analysis table is gone), with the same row-level-security flag and privileges',
    not exists (select 1 from (select * from d_rels except select * from d_rels_now) a) and not exists (select 1 from (select * from d_rels_now except select * from d_rels) b),
    (select string_agg(relname, ', ') from (select relname from d_rels_now except select relname from d_rels) z);

  -- columns: the 5 settings and 14 evidence columns are gone, the three file columns are NOT NULL again
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_cols) || ' columns are exactly as before (type, nullability, default): the 19 new columns are gone and the file columns are NOT NULL again',
    not exists (select 1 from (select * from d_cols except select * from d_cols_now) a) and not exists (select 1 from (select * from d_cols_now except select * from d_cols) b),
    (select string_agg(table_name || '.' || column_name, ', ') from (select table_name, column_name from d_cols_now except select table_name, column_name from d_cols) z);

  -- constraints: names and definitions (the old status and event-type checks are back under their original names)
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_cons) || ' constraints are exactly as before (names and definitions, so the old three-value status check and the old event-type check are back)',
    not exists (select 1 from (select * from d_cons except select * from d_cons_now) a) and not exists (select 1 from (select * from d_cons_now except select * from d_cons) b),
    coalesce((select string_agg('+' || tbl || '.' || conname, ', ') from (select tbl, conname from d_cons_now except select tbl, conname from d_cons) z), '')
      || coalesce((select string_agg('-' || tbl || '.' || conname, ', ') from (select tbl, conname from d_cons except select tbl, conname from d_cons_now) z), '');
  insert into d_res (test, ok, detail)
  select 'the evidence status check is the original three-value one and the ledger-queue event-type check is the original ten-value one',
    exists (select 1 from d_cons_now where tbl like '%finance_payment_evidence' and conname = 'finance_payment_evidence_status_check' and def not like '%confirmed%')
    and exists (select 1 from d_cons_now where tbl like '%finance_gl_queue' and conname = 'finance_gl_queue_event_type_check' and def not like '%CASH_RECEIPT%')
    and not exists (select 1 from d_cons_now where conname in ('finance_payment_evidence_status_chk', 'finance_gl_queue_event_type_chk', 'finance_evidence_file_required_chk')), null;

  -- indexes, triggers, policies
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_idx) || ' indexes are exactly as before (the new indexes are gone)',
    not exists (select 1 from (select * from d_idx except select * from d_idx_now) a) and not exists (select 1 from (select * from d_idx_now except select * from d_idx) b),
    (select string_agg(indexname, ', ') from (select indexname from d_idx_now except select indexname from d_idx) z);
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_trg) || ' triggers are exactly as before (the analysis queue trigger and the analysis guard are gone)',
    not exists (select 1 from (select * from d_trg except select * from d_trg_now) a) and not exists (select 1 from (select * from d_trg_now except select * from d_trg) b),
    (select string_agg(tgname, ', ') from (select tgname from d_trg_now except select tgname from d_trg) z);
  insert into d_res (test, ok, detail)
  select 'all ' || (select count(*) from d_pol) || ' row-level-security policies are exactly as before (the analysis policy is gone)',
    not exists (select 1 from (select * from d_pol except select * from d_pol_now) a) and not exists (select 1 from (select * from d_pol_now except select * from d_pol) b),
    (select string_agg(policyname, ', ') from (select policyname from d_pol_now except select policyname from d_pol) z);

  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'SLIP_REVIEW_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
