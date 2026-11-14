-- Second half of the proof that 20261115610000_feedback_english_context_limits_down.sql undoes its migration (fingerprint: feedback_down_pre.sql).
create temp table d_now as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_cols_now as
  select table_name, column_name, is_nullable, data_type, column_default from information_schema.columns
  where table_schema = 'public' and table_name like 'feedback\_%' or table_schema = 'public' and table_name = 'bizops_feedback_issues';
create temp table d_con_now as
  select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace;
create temp table d_pol_now as
  select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and (tablename like 'feedback\_%' or tablename = 'bizops_feedback_issues');
do $$ declare r text; bad int; tot int;
begin
  create temp table d_res (n serial, test text, ok boolean, detail text);
  insert into d_res (test, ok, detail)
  select 'no function was lost or changed (all ' || count(*) || ' public functions)', count(*) filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'no function was added by the migration', count(*) = 0, string_agg(x.sig, ', ') from d_now x where not exists (select 1 from d_funcs f where f.sig = x.sig);
  insert into d_res (test, ok, detail)
  select 'tables, sequences and views are exactly as before',
    not exists (select 1 from (select relname, relkind from d_rels except select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m')) a)
    and not exists (select 1 from (select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m') except select relname, relkind from d_rels) b), null;
  insert into d_res (test, ok, detail)
  select 'every column of the feedback tables is exactly as before (nothing changed)',
    not exists (select 1 from (select * from d_cols except select * from d_cols_now) a) and not exists (select 1 from (select * from d_cols_now except select * from d_cols) b),
    (select string_agg(column_name, ', ') from (select column_name from d_cols_now except select column_name from d_cols) z);
  insert into d_res (test, ok, detail)
  select 'triggers are exactly as before',
    not exists (select 1 from (select relname, tgname from d_trg except select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal) a)
    and not exists (select 1 from (select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal except select relname, tgname from d_trg) b), null;
  insert into d_res (test, ok, detail)
  select 'all constraints are exactly as before (including the history-kind list)',
    not exists (select 1 from (select * from d_con except select * from d_con_now) a) and not exists (select 1 from (select * from d_con_now except select * from d_con) b),
    (select string_agg(conname, ', ') from (select conname from d_con_now except select conname from d_con) z);
  insert into d_res (test, ok, detail)
  select 'row-level security policies are exactly as before',
    not exists (select 1 from (select * from d_pol except select * from d_pol_now) a) and not exists (select 1 from (select * from d_pol_now except select * from d_pol) b), null;
  insert into d_res (test, ok, detail)
  select 'every existing issue is byte for byte as before (title, description, status, root cause, resolution)',
    (select count(*) from d_fingerprint f join public.bizops_feedback_issues i on i.id = f.id and md5(i.title || '|' || i.description || '|' || i.status || '|' || coalesce(i.root_cause, '') || '|' || coalesce(i.resolution, '')) = f.h) = (select count(*) from d_fingerprint)
    and (select count(*) from public.bizops_feedback_issues) = (select count(*) from d_fingerprint), null;
  insert into d_res (test, ok, detail)
  select 'the begin function is still callable by the service role only (grants kept)',
    has_function_privilege('service_role', 'public.feedback_english_context_begin(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'public.feedback_english_context_begin(text, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.feedback_english_context_begin(text, uuid)', 'execute'), null;
  insert into d_res (test, ok, detail)
  select 'the three functions of the first migration are still there', to_regprocedure('public.feedback_english_context_begin(text, uuid)') is not null
    and to_regprocedure('public.feedback_english_context_finish(text, text, text, text)') is not null and to_regprocedure('public.feedback_set_english_context(text, text)') is not null, null;

  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'FEEDBACK_LIMITS_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
