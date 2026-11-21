-- Second half of the proof that 20261121110000_event_boards_down.sql undoes its migration (fingerprint: event_boards_down_pre.sql).
-- Run as:  core ; event_boards_down_pre.sql ; migration ; rollback ; this file   (all in ONE transaction that ends in the exception below, so nothing persists).
create temp table d_funcs_now as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h, coalesce(p.proacl::text, '') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_rels_now as
  select c.relname, c.relkind, c.relrowsecurity as rls, coalesce(c.relacl::text, '') as acl from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_cols_now as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema = 'public';
create temp table d_pol_now as select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public';
create temp table d_cons_now as
  select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as typ, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public';
create temp table d_trg_now as
  select t.tgrelid::regclass::text as tbl, t.tgname, md5(pg_get_triggerdef(t.oid)) as h from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal;
create temp table d_idx_now as select tablename, indexname, indexdef from pg_indexes where schemaname = 'public';
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
  select 'no function was added or lost', (select count(*) from d_funcs_now) = (select count(*) from d_funcs) and not exists (select 1 from d_funcs_now x where not exists (select 1 from d_funcs f where f.sig = x.sig)),
         (select string_agg(x.sig, ', ') from d_funcs_now x where not exists (select 1 from d_funcs f where f.sig = x.sig));
  insert into d_res (test, ok, detail)
  select 'tables, views and sequences are exactly as before (kind, row-level security, privileges)',
    not exists (select 1 from (select * from d_rels except select * from d_rels_now) a) and not exists (select 1 from (select * from d_rels_now except select * from d_rels) b),
    (select string_agg(relname, ', ') from (select relname from d_rels_now except select relname from d_rels) z);
  insert into d_res (test, ok, detail)
  select 'every column is exactly as before',
    not exists (select 1 from (select * from d_cols except select * from d_cols_now) a) and not exists (select 1 from (select * from d_cols_now except select * from d_cols) b), null;
  insert into d_res (test, ok, detail)
  select 'every row-level-security policy is exactly as before',
    not exists (select 1 from (select * from d_pol except select * from d_pol_now) a) and not exists (select 1 from (select * from d_pol_now except select * from d_pol) b), null;
  insert into d_res (test, ok, detail)
  select 'every constraint (keys, checks, the three foreign keys) is exactly as before',
    not exists (select 1 from (select * from d_cons except select * from d_cons_now) a) and not exists (select 1 from (select * from d_cons_now except select * from d_cons) b),
    (select string_agg(conname, ', ') from (select conname from d_cons_now except select conname from d_cons) z);
  insert into d_res (test, ok, detail)
  select 'every trigger is exactly as before',
    not exists (select 1 from (select * from d_trg except select * from d_trg_now) a) and not exists (select 1 from (select * from d_trg_now except select * from d_trg) b), null;
  insert into d_res (test, ok, detail)
  select 'every index is exactly as before',
    not exists (select 1 from (select * from d_idx except select * from d_idx_now) a) and not exists (select 1 from (select * from d_idx_now except select * from d_idx) b), null;
  insert into d_res (test, ok, detail)
  select 'the four board tables are gone', to_regclass('public.rw_events') is null and to_regclass('public.rw_boards') is null and to_regclass('public.rw_selections') is null and to_regclass('public.rw_board_resets') is null, null;
  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'EVENT_BOARDS_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
