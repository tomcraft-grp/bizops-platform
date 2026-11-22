-- Rollback proof for 20261122110000_product_categories.sql: pre snapshot -> migration -> rollback -> this file, ONE transaction that always rolls back.
create temp table t_res (n serial, test text, ok boolean, detail text);
grant all on t_res to authenticated; grant usage on sequence t_res_n_seq to authenticated;
insert into t_res (test, ok, detail) select 'D1 tables gone', (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('product_categories', 'product_category_changes')) = 0, null;
insert into t_res (test, ok, detail) select 'D1 sku_registry.category_id gone', (select count(*) from information_schema.columns where table_name = 'sku_registry' and column_name = 'category_id') = 0, null;
insert into t_res (test, ok, detail) select 'D1 shop_categories.category_id gone', (select count(*) from information_schema.columns where table_name = 'shop_categories' and column_name = 'category_id') = 0, null;
insert into t_res (test, ok, detail) select 'D2 SKU functions identical to before: ' || x.k, md5(pg_get_functiondef(p.oid)) = x.v, null
  from t_pre x join pg_proc p on 'fn_' || p.proname = x.k join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' where x.k like 'fn_%';
insert into t_res (test, ok, detail) select 'D3 the shop still derives the same category for every SKU',
  (select string_agg(sku_code || '=' || public.shop_category_of(product_type, domain), ',' order by sku_code) from public.sku_registry) = (select v from t_pre where k = 'derived'), null;
insert into t_res (test, ok, detail) select 'D4 no category trigger left on sku_registry', not exists (select 1 from pg_trigger where tgrelid = 'public.sku_registry'::regclass and tgname = 'sku_registry_category'), null;
set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
do $$ declare f text; begin
  begin f := md5(public.shop_facets()::text); exception when others then f := 'ERR ' || sqlerrm; end;
  insert into t_res (test, ok, detail) values ('D3 shop facets identical to before', f = (select v from t_pre where t_pre.k = 'facets'), f);
end $$;
reset role;
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'PRODUCT_CATEGORY_DOWN % of % passed\n%', tot - bad, tot, r;
end $$;
