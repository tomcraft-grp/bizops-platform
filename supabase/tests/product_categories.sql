-- Tests for 20261122110000_product_categories.sql. Run order (scripts/run-product-categories-sql-tests.sh), ONE transaction that always rolls back:
--   product_categories_pre.sql -> the migration -> this file.  L1 = a customer (role USER), STAFF = a SUPER_ADMIN of the live project.
create temp table t_res (n serial, test text, ok boolean, detail text);
grant all on t_res to authenticated; grant usage on sequence t_res_n_seq to authenticated;
create temp table t_ids (k text primary key, id uuid, code text);
grant all on t_ids to authenticated;

-- ------------------------------------------------------------------------------------------------ backfill
insert into t_res (test, ok, detail) select 'P1 every SKU has a category', count(*) filter (where category_id is null) = 0, count(*) filter (where category_id is null) || ' without' from public.sku_registry;
insert into t_res (test, ok, detail) select 'P1 categories = the shop codes in use (+ group POD)',
  string_agg(code || case when is_group then '(group)' else '' end, ',' order by code) = 'Coil,Device,Finished goods,Kratom drink,POD(group),Puff,SaltNic', string_agg(code, ',' order by code) from public.product_categories;
insert into t_res (test, ok, detail) select 'P1 POD group holds Coil, Device, Puff, SaltNic; others have no group',
  (select string_agg(c.code, ',' order by c.code) from public.product_categories c join public.product_categories g on g.id = c.parent_id where g.code = 'POD') = 'Coil,Device,Puff,SaltNic'
  and (select count(*) from public.product_categories where code in ('Kratom drink', 'Finished goods') and parent_id is null) = 2, null;
insert into t_res (test, ok, detail) select 'P1 backfill is in the category audit log', (select count(*) from public.product_category_changes where action = 'created') = (select count(*) from public.product_categories), null;
insert into t_res (test, ok, detail) select 'P2 the shop derives exactly the same category for every SKU',
  (select string_agg(sku_code || '=' || public.shop_category_of(product_type, domain), ',' order by sku_code) from public.sku_registry) = (select v from t_pre where k = 'derived'), null;
insert into t_res (test, ok, detail) select 'P2 product_type equals the category code everywhere',
  count(*) filter (where s.product_type is distinct from c.code) = 0, null from public.sku_registry s join public.product_categories c on c.id = s.category_id;
insert into t_res (test, ok, detail) select 'P4 reward rules naming Kratom drink still match 24 SKUs',
  (select count(*) from public.sku_registry s join public.product_categories c on c.id = s.category_id where c.code = 'Kratom drink') = 24
  and exists (select 1 from public.rw_rules where 'Kratom drink' = any (category_codes)), null;

set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
do $$ declare f text; c text; kr text; begin
  begin f := md5(public.shop_facets()::text); exception when others then f := 'ERR ' || sqlerrm; end;
  begin c := md5(public.shop_catalog(null, null, null, 'name', 100, 0, false)::text); exception when others then c := 'ERR ' || sqlerrm; end;
  begin kr := md5(public.shop_catalog(null, 'Kratom drink', null, 'name', 100, 0, false)::text); exception when others then kr := 'ERR ' || sqlerrm; end;
  insert into t_res (test, ok, detail) values ('P3 shop facets unchanged for a customer', f = (select v from t_pre where t_pre.k = 'facets'), f);
  insert into t_res (test, ok, detail) values ('P3 shop catalogue unchanged for a customer', c = (select v from t_pre where t_pre.k = 'catalog'), c);
  insert into t_res (test, ok, detail) values ('P3 shop catalogue filtered by Kratom drink unchanged', kr = (select v from t_pre where t_pre.k = 'catalog_kratom'), kr);
  -- non-staff
  begin perform public.product_categories_list(); insert into t_res (test, ok, detail) values ('P9 customer cannot list categories', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P9 customer cannot list categories', sqlstate = '42501', sqlerrm); end;
  begin perform public.product_category_save(null, '{"code":"Hack","name_th":"x"}'); insert into t_res (test, ok, detail) values ('P9 customer cannot create a category', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P9 customer cannot create a category', sqlstate = '42501', sqlerrm); end;
  begin perform 1 from public.product_categories limit 1; insert into t_res (test, ok, detail) values ('P9 customer cannot read the table directly', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P9 customer cannot read the table directly', true, sqlerrm); end;
end $$;
reset role;

-- ------------------------------------------------------------------------------------------------ staff manage categories and assign them
-- TEST-ONLY (rolled back with everything else): lets the checks below read the tables while acting as staff. P9 above already proved a customer cannot.
grant select on public.sku_registry to authenticated;
insert into t_ids select 'pod', id, code from public.product_categories where code = 'POD';   -- as the owner: the category tables have RLS and no read policy
insert into t_ids select 'puff', id, code from public.product_categories where code = 'Puff';
grant execute on function public.shop_category_of(text, text) to authenticated;
set local role authenticated;
select pg_temp.as_user('d6bd07da-8481-47cb-88b6-9f176d8b9105');
insert into t_res (test, ok, detail) select 'P5 staff list shows 7 rows with product counts',
  jsonb_array_length(l) = 7 and (select (x ->> 'product_count')::int from jsonb_array_elements(l) x where x ->> 'code' = 'Puff') = 115, null
  from (select public.product_categories_list() as l) q;
insert into t_res (test, ok, detail) select 'P5 the SKU feed carries category_id and code',
  (select count(*) from jsonb_array_elements(public.sku_changes_since(null) -> 'rows') r where r ->> 'category_id' is not null and r ->> 'category_code' is not null) = 147, null;
insert into t_ids select 'new', (x ->> 'id')::uuid, x ->> 'code' from (select public.product_category_save(null, jsonb_build_object('code', 'Disposable', 'name_th', 'แบบใช้แล้วทิ้ง', 'parent_id', (select id from t_ids where k = 'pod')))) q(x);
insert into t_res (test, ok, detail) select 'P6 staff created a category under POD', exists (select 1 from t_ids where k = 'new' and id is not null), null;
insert into t_ids select 'sku', null, (select sku_code from public.sku_registry where product_type = 'Puff' order by sku_code limit 1);
select public.sku_set_details((select code from t_ids where k = 'sku'), jsonb_build_object('category_id', (select id from t_ids where k = 'new')));
insert into t_res (test, ok, detail) select 'P6 assigning moves the SKU and its shop code',
  s.category_id = (select id from t_ids where k = 'new') and s.product_type = 'Disposable' and public.shop_category_of(s.product_type, s.domain) = 'Disposable', s.product_type
  from public.sku_registry s where s.sku_code = (select code from t_ids where k = 'sku');
select public.sku_set_details((select code from t_ids where k = 'sku'), '{"product_type":"Typed by hand"}');
insert into t_res (test, ok, detail) select 'P6 product_type cannot drift from the category', product_type = 'Disposable', product_type from public.sku_registry where sku_code = (select code from t_ids where k = 'sku');
do $$ begin
  begin perform public.sku_set_details((select code from t_ids where k = 'sku'), jsonb_build_object('category_id', gen_random_uuid()));
    insert into t_res (test, ok, detail) values ('P7 nonexistent category refused', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P7 nonexistent category refused', sqlerrm like 'NOT_FOUND%' or sqlstate = '23503', sqlerrm); end;
  begin perform public.sku_set_details((select code from t_ids where k = 'sku'), jsonb_build_object('category_id', (select id from t_ids where k = 'pod')));
    insert into t_res (test, ok, detail) values ('P7 a group cannot be assigned', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P7 a group cannot be assigned', sqlerrm like 'CATEGORY_IS_GROUP%', sqlerrm); end;
  begin perform public.sku_set_details((select code from t_ids where k = 'sku'), '{"category_id": null}');
    insert into t_res (test, ok, detail) values ('P10 category cannot be cleared', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P10 category cannot be cleared', sqlerrm like 'BAD_VALUE%', sqlerrm); end;
  begin perform public.product_category_set_active((select id from t_ids where k = 'new'), false, '  ');
    insert into t_res (test, ok, detail) values ('P7 deactivating needs a reason', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P7 deactivating needs a reason', sqlerrm like 'REASON_REQUIRED%', sqlerrm); end;
  begin perform public.product_category_save(null, '{"code":"puff","name_th":"dup"}');
    insert into t_res (test, ok, detail) values ('P11 duplicate code (any case) refused', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P11 duplicate code (any case) refused', sqlerrm like 'CODE_TAKEN%', sqlerrm); end;
  begin perform public.product_category_save(null, jsonb_build_object('code', 'Inner', 'name_th', 'x', 'parent_id', (select id from t_ids where k = 'puff')));
    insert into t_res (test, ok, detail) values ('P8 a category cannot sit inside a category (one level)', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P8 a category cannot sit inside a category (one level)', sqlerrm like 'BAD_PARENT%', sqlerrm); end;
  begin perform public.product_category_save((select id from t_ids where k = 'pod'), jsonb_build_object('parent_id', (select id from t_ids where k = 'pod')));
    insert into t_res (test, ok, detail) values ('P8 a group cannot sit inside a group', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P8 a group cannot sit inside a group', true, sqlerrm); end;
  begin perform public.product_category_save((select id from t_ids where k = 'new'), '{"code":"Renamed"}');
    insert into t_res (test, ok, detail) values ('P8 code never changes', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P8 code never changes', sqlerrm like 'BAD_VALUE%', sqlerrm); end;
  begin perform public.product_category_set_active((select id from t_ids where k = 'pod'), false, 'tidy up');
    insert into t_res (test, ok, detail) values ('P8 a group with active categories cannot be deactivated', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P8 a group with active categories cannot be deactivated', sqlerrm like 'HAS_ACTIVE_CHILDREN%', sqlerrm); end;
end $$;
select public.product_category_save((select id from t_ids where k = 'new'), '{"name_th":"ใช้แล้วทิ้ง (ใหม่)","description":"Single-use devices"}');
select public.product_category_set_active((select id from t_ids where k = 'new'), false, 'Merged into Puff');
insert into t_res (test, ok, detail) select 'P7 deactivated: the SKU keeps its category', category_id = (select id from t_ids where k = 'new'), null from public.sku_registry where sku_code = (select code from t_ids where k = 'sku');
select public.sku_set_details((select code from t_ids where k = 'sku'), '{"selling_price": 999}');
insert into t_res (test, ok, detail) select 'P7 a SKU in a deactivated category can still be edited', selling_price = 999, null from public.sku_registry where sku_code = (select code from t_ids where k = 'sku');
do $$ begin
  begin perform public.sku_set_details((select sku_code from public.sku_registry where product_type = 'Puff' order by sku_code offset 1 limit 1), jsonb_build_object('category_id', (select id from t_ids where k = 'new')));
    insert into t_res (test, ok, detail) values ('P7 an inactive category cannot be newly chosen', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('P7 an inactive category cannot be newly chosen', sqlerrm like 'CATEGORY_INACTIVE%', sqlerrm); end;
end $$;
insert into t_res (test, ok, detail) select 'P5 inactive categories can be left out of the list',
  not exists (select 1 from jsonb_array_elements(public.product_categories_list(false)) x where x ->> 'code' = 'Disposable'), null;
reset role;

-- ------------------------------------------------------------------------------------------------ the audit log (read as the owner)
insert into t_res (test, ok, detail) select 'P6 rename is logged with old and new', exists (select 1 from public.product_category_changes c where c.category_id = (select id from t_ids where k = 'new') and c.action = 'changed' and c.changes ? 'name_th' and c.actor is not null), null;
insert into t_res (test, ok, detail) select 'P7 deactivation is logged with its reason', exists (select 1 from public.product_category_changes where category_id = (select id from t_ids where k = 'new') and action = 'deactivated' and reason = 'Merged into Puff'), null;

-- ------------------------------------------------------------------------------------------------ direct database writes (owner role)
do $$ begin
  begin delete from public.product_categories where code = 'Disposable'; insert into t_res (test, ok, detail) values ('P8 a category is never deleted', false, 'DELETED');
  exception when others then insert into t_res (test, ok, detail) values ('P8 a category is never deleted', true, sqlerrm); end;
  begin delete from public.product_category_changes; insert into t_res (test, ok, detail) values ('P8 the category log is append-only', false, 'DELETED');
  exception when others then insert into t_res (test, ok, detail) values ('P8 the category log is append-only', true, sqlerrm); end;
end $$;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'PRODUCT_CATEGORY_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
