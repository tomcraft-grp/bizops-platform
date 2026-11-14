-- Second half of the numbering rollback proof (the first half is checkout_down_pre.sql, a generic fingerprint): the schema after
-- "migration 5 + its rollback" must equal the schema before it.
create temp table d_now as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
do $$ declare r text; bad int; tot int;
begin
  create temp table d_res (n serial, test text, ok boolean, detail text);
  insert into d_res (test, ok, detail)
  select 'every function that issued numbers is back to exactly its previous body: ' || f.sig, exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h), null
  from d_funcs f where f.sig ~ '(ar_receive_payment|finance_create_invoice|finance_deposit_create|finance_pay_invoice_with_wallet|finance_verify_evidence|finance_wallet_apply|shop_place_order)';
  insert into d_res (test, ok, detail)
  select 'no function was lost or changed (all ' || count(*) || ' public functions)', count(*) filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h)) = 0,
         string_agg(f.sig, ', ') filter (where not exists (select 1 from d_now x where x.sig = f.sig and x.h = f.h))
  from d_funcs f;
  insert into d_res (test, ok, detail)
  select 'no function is left over from migration 5', count(*) = 0, string_agg(x.sig, ', ') from d_now x where not exists (select 1 from d_funcs f where f.sig = x.sig);
  insert into d_res (test, ok, detail)
  select 'tables, sequences and views are exactly as before (the six sequences are back, the numbering tables are gone)',
    not exists (select 1 from (select relname from d_rels except select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m')) a)
    and not exists (select 1 from (select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m') except select relname from d_rels) b),
    (select string_agg(x, ', ') from (select 'lost: ' || relname as x from d_rels where relname not in (select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')
       union all select 'left over: ' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m') and c.relname not in (select relname from d_rels)) q);
  insert into d_res (test, ok, detail)
  select 'triggers are exactly as before', not exists (select 1 from (select relname, tgname from d_trg except select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal) a)
    and not exists (select 1 from (select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal except select relname, tgname from d_trg) b), null;
  insert into d_res (test, ok, detail)
  select 'clients cannot use the restored sequences directly', not has_sequence_privilege('authenticated', 'public.shop_order_seq', 'usage') and not has_sequence_privilege('anon', 'public.finance_invoice_seq', 'usage'), null;
  insert into d_res (test, ok, detail)
  select 'the central numbering is gone', to_regclass('public.doc_counters') is null and to_regprocedure('public.next_doc_no(text, date)') is null, null;

  select count(*) filter (where ok is not true), count(*) into bad, tot from d_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from d_res;
  raise exception E'NUMBERING_DOWN_PROOF % of % passed\n%', tot - bad, tot, r;
end $$;
