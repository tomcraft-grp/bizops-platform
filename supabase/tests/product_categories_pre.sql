-- Runs BEFORE 20261122110000_product_categories.sql in the same rolled-back transaction: records what the shop shows today, so the tests can prove it is unchanged.
create temp table t_pre (k text primary key, v text);
grant all on t_pre to authenticated;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;
insert into t_pre select 'derived', string_agg(sku_code || '=' || public.shop_category_of(product_type, domain), ',' order by sku_code) from public.sku_registry;
set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
do $$ begin
  begin insert into t_pre select 'facets', md5(public.shop_facets()::text); exception when others then insert into t_pre values ('facets', 'ERR ' || sqlerrm); end;
  begin insert into t_pre select 'catalog', md5(public.shop_catalog(null, null, null, 'name', 100, 0, false)::text); exception when others then insert into t_pre values ('catalog', 'ERR ' || sqlerrm); end;
  begin insert into t_pre select 'catalog_kratom', md5(public.shop_catalog(null, 'Kratom drink', null, 'name', 100, 0, false)::text); exception when others then insert into t_pre values ('catalog_kratom', 'ERR ' || sqlerrm); end;
end $$;
reset role;
-- for the rollback proof: the SKU functions the migration replaces
insert into t_pre select 'fn_' || p.proname, md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('sku_registry_log', 'sku_registry_row_json', 'sku_set_details');
-- the migration must run as a real apply does: with no signed-in user
select set_config('request.jwt.claims', '', true);
