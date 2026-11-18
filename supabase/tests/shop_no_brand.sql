-- Tests for 20261119100000_shop_no_brand_filter.sql, run against REAL data inside one transaction that is rolled back (scripts/run-shop-no-brand-sql-tests.sh):
--   <migration> ; <this file>
-- Nothing persists: the last statement raises an exception that carries the result table. Read-only apart from the two functions the migration replaces (also rolled back).
-- The expected numbers are counted straight from the internal view (as the database owner) before acting as a shop member, so the tests keep passing when the
-- business later gives its kratom SKUs a brand (then the "no brand" group is simply empty).
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;

create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text;
begin
  begin execute p_sql; insert into t_res (test, ok, detail) values (p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; insert into t_res (test, ok, detail) values (p_test, m ilike p_pat, m);
  end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'sellable', count(*)::text from public.shop_sellable;
insert into t_ctx select 'nobrand', count(*)::text from public.shop_sellable where brand is null;
insert into t_ctx select 'branded', count(*)::text from public.shop_sellable where brand is not null;
insert into t_ctx select 'kratom_nobrand', count(*)::text from public.shop_sellable where brand is null and name_full ilike '%กระท่อม%';
insert into t_ctx select 'a_brand', coalesce((select brand from public.shop_sellable where brand is not null group by brand order by count(*) desc limit 1), '') ;
insert into t_ctx select 'a_brand_n', count(*)::text from public.shop_sellable where brand = (select v from t_ctx where k = 'a_brand');
insert into t_ctx select 'cat_nb', coalesce((select category from public.shop_sellable where brand is null limit 1), '');
insert into t_ctx select 'cat_nb_n', count(*)::text from public.shop_sellable where brand is null and category = (select v from t_ctx where k = 'cat_nb');
insert into t_res (test, ok, detail) select 'N0 there is a shop member to act as', pg_temp.c('A') is not null, null;

-- =========================================================================================== access: unchanged
set local role anon;
select pg_temp.err_like('N1 anon still cannot browse', $q$select public.shop_catalog(p_brand => '__none__')$q$, '%permission denied%');
select pg_temp.err_like('N1 anon still cannot read the facets', $q$select public.shop_facets()$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);

-- =========================================================================================== facets
insert into t_res (test, ok, detail) select 'N2 facets report how many products have no brand', (public.shop_facets() ->> 'no_brand_count')::int = pg_temp.c('nobrand')::int, (public.shop_facets() ->> 'no_brand_count');
insert into t_res (test, ok, detail) select 'N2 facets keep their two original keys',
  jsonb_typeof(public.shop_facets() -> 'categories') = 'array' and jsonb_typeof(public.shop_facets() -> 'brands') = 'array', null;
insert into t_res (test, ok, detail) select 'N2 listed brands never include a null brand',
  not exists (select 1 from jsonb_array_elements(public.shop_facets() -> 'brands') b where b ->> 'brand' is null), null;
insert into t_res (test, ok, detail) select 'N2 branded counts + no-brand count = every sellable product',
  (select sum((b ->> 'count')::int) from jsonb_array_elements(public.shop_facets() -> 'brands') b) + (public.shop_facets() ->> 'no_brand_count')::int = pg_temp.c('sellable')::int, null;

-- =========================================================================================== the "no brand" filter
insert into t_res (test, ok, detail) select 'N3 "no brand" lists exactly the products without a brand',
  (public.shop_catalog(p_brand => '__none__', p_limit => 60) ->> 'total')::int = pg_temp.c('nobrand')::int, (public.shop_catalog(p_brand => '__none__', p_limit => 60) ->> 'total');
insert into t_res (test, ok, detail) select 'N3 every item it returns has no brand',
  not exists (select 1 from jsonb_array_elements(public.shop_catalog(p_brand => '__none__', p_limit => 60) -> 'items') e where e ->> 'brand' is not null), null;
insert into t_res (test, ok, detail) select 'N3 the kratom drinks without a brand are found with it',
  (public.shop_catalog('กระท่อม', p_brand => '__none__', p_limit => 60) ->> 'total')::int = pg_temp.c('kratom_nobrand')::int, (public.shop_catalog('กระท่อม', p_brand => '__none__', p_limit => 60) ->> 'total');
insert into t_res (test, ok, detail) select 'N3 it combines with a category',
  pg_temp.c('cat_nb') = '' or (public.shop_catalog(p_category => pg_temp.c('cat_nb'), p_brand => '__none__', p_limit => 60) ->> 'total')::int = pg_temp.c('cat_nb_n')::int,
  pg_temp.c('cat_nb') || ' = ' || pg_temp.c('cat_nb_n');
insert into t_res (test, ok, detail) select 'N3 the same product cannot be in both a named brand and "no brand"',
  pg_temp.c('a_brand') = '' or (select count(*) from jsonb_array_elements(public.shop_catalog(p_brand => pg_temp.c('a_brand'), p_limit => 60) -> 'items') e
      where e ->> 'sku_code' in (select e2 ->> 'sku_code' from jsonb_array_elements(public.shop_catalog(p_brand => '__none__', p_limit => 60) -> 'items') e2)) = 0, null;

-- =========================================================================================== everything else behaves as before
insert into t_res (test, ok, detail) select 'N4 no filter: the whole catalogue', (public.shop_catalog() ->> 'total')::int = pg_temp.c('sellable')::int, (public.shop_catalog() ->> 'total');
insert into t_res (test, ok, detail) select 'N4 an empty brand value means no brand filter', (public.shop_catalog(p_brand => '') ->> 'total')::int = pg_temp.c('sellable')::int, null;
insert into t_res (test, ok, detail) select 'N4 a named brand filters exactly as before',
  pg_temp.c('a_brand') = '' or (public.shop_catalog(p_brand => pg_temp.c('a_brand'), p_limit => 60) ->> 'total')::int = pg_temp.c('a_brand_n')::int, pg_temp.c('a_brand') || ' = ' || pg_temp.c('a_brand_n');
insert into t_res (test, ok, detail) select 'N4 an unknown brand finds nothing', (public.shop_catalog(p_brand => 'no such brand zz') ->> 'total')::int = 0, null;
insert into t_res (test, ok, detail) select 'N4 a brand that merely looks like the marker finds nothing', (public.shop_catalog(p_brand => '__NONE__') ->> 'total')::int = 0 and (public.shop_catalog(p_brand => '__none__ ') ->> 'total')::int = 0, null;
insert into t_res (test, ok, detail) select 'N4 search by brand still works', pg_temp.c('a_brand') = '' or (public.shop_catalog(pg_temp.c('a_brand')) ->> 'total')::int >= 1, null;
insert into t_res (test, ok, detail) select 'N4 an item never exposes cost / friend / wholesale prices',
  not (public.shop_catalog(p_brand => '__none__', p_limit => 60)::text ~* 'cost_price|friend_price|wholesale_price'), null;

-- =========================================================================================== the two functions keep their shape
reset role;
insert into t_res (test, ok, detail) select 'N5 shop_facets is still stable, security definer, with a fixed search path',
  p.provolatile = 's' and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public'), null from pg_proc p where p.oid = 'public.shop_facets()'::regprocedure;
insert into t_res (test, ok, detail) select 'N5 shop_catalog is still stable, security definer, with a fixed search path',
  p.provolatile = 's' and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public'), null
  from pg_proc p where p.proname = 'shop_catalog' and p.pronamespace = 'public'::regnamespace;
insert into t_res (test, ok, detail) select 'N5 only signed-in members may execute them (no public / anon grant)',
  not has_function_privilege('anon', 'public.shop_facets()', 'execute') and has_function_privilege('authenticated', 'public.shop_facets()', 'execute')
  and not has_function_privilege('anon', (select p.oid from pg_proc p where p.proname = 'shop_catalog' and p.pronamespace = 'public'::regnamespace), 'execute')
  and has_function_privilege('authenticated', (select p.oid from pg_proc p where p.proname = 'shop_catalog' and p.pronamespace = 'public'::regnamespace), 'execute'), null;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'SHOP_NO_BRAND_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
