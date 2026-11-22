-- Rolls back 20261122110000_product_categories.sql.
-- REFUSES once staff created, changed or (de)activated a category, or assigned one by hand (those are business records: export them first if they are really unwanted).
-- What stays: sku_registry.product_type keeps the text the backfill wrote (the category code). It is exactly what the shop derived before (shop_category_of returned the
-- same text), so the shop, the catalogue and the reward rules behave as before. The SKU change log keeps its rows (it is append-only by design).
-- Afterwards delete version 20261122110000 from supabase_migrations.schema_migrations.
do $guard$ begin
  if exists (select 1 from public.product_category_changes where actor is not null) then
    raise exception 'Staff have created or changed categories: they cannot be rolled back. Export public.product_categories and product_category_changes first.'; end if;
  if exists (select 1 from public.sku_registry_changes where changes ? 'category_id' and actor is not null) then
    raise exception 'Staff have assigned categories to SKUs by hand: they cannot be rolled back.'; end if;
end $guard$;

drop function if exists public.product_categories_list(boolean);
drop function if exists public.product_category_save(uuid, jsonb);
drop function if exists public.product_category_set_active(uuid, boolean, text);

-- the three SKU functions exactly as 20261121120000 defined them
create or replace function public.sku_registry_log() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new  jsonb := to_jsonb(new);
  v_diff jsonb;
begin
  select jsonb_object_agg(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k)) into v_diff
    from unnest(array['name_full', 'brand', 'product_type', 'domain', 'pack_qty', 'unit_en', 'unit_th', 'barcode', 'status',
                      'cost_price', 'retail_price', 'selling_price', 'friend_price', 'wholesale_price', 'ecommerce_price', 'needs_review', 'review_notes']) as k
   where coalesce(v_old -> k, 'null'::jsonb) is distinct from coalesce(v_new -> k, 'null'::jsonb);
  if v_diff is null then return null; end if;                  -- nothing the feed carries changed
  perform public.sku_changes_lock();                           -- BEFORE nextval: ids are handed out in lock order, the lock lasts until commit
  insert into public.sku_registry_changes (id, at, sku_code, actor, changes)
  values (nextval('public.sku_registry_changes_id_seq'), clock_timestamp(), new.sku_code, auth.uid(), v_diff);
  return null;
end $$;

create or replace function public.sku_registry_row_json(r public.sku_registry) returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'sku_code', r.sku_code, 'legacy_sku_code', r.legacy_sku_code, 'sku_category', r.sku_category, 'origin', r.origin, 'name_full', r.name_full,
    'brand', r.brand, 'product_type', r.product_type, 'domain', r.domain, 'pack_qty', r.pack_qty, 'unit_en', r.unit_en, 'unit_th', r.unit_th,
    'barcode', r.barcode, 'status', r.status, 'cost_price', r.cost_price, 'retail_price', r.retail_price, 'selling_price', r.selling_price,
    'friend_price', r.friend_price, 'wholesale_price', r.wholesale_price, 'ecommerce_price', r.ecommerce_price,
    'needs_review', r.needs_review, 'review_notes', r.review_notes, 'updated_at', r.updated_at)
$$;
revoke all on function public.sku_registry_row_json(public.sku_registry) from public, anon, authenticated;

create or replace function public.sku_set_details(p_code text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_text  constant text[] := array['name_full', 'brand', 'unit_th', 'barcode', 'product_type'];
  v_money constant text[] := array['cost_price', 'selling_price', 'retail_price', 'ecommerce_price'];
  r public.sku_registry;
  k text; j jsonb; s text; n numeric; v_other text;
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can change SKU details' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_VALUE: the patch must be a JSON object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (v_text) or k = any (v_money) or k = 'pack_qty') then raise exception 'BAD_FIELD: "%" cannot be changed here', k; end if;
  end loop;
  perform public.sku_changes_lock();                           -- first, before the row lock below
  select * into r from public.sku_registry where sku_code = p_code for no key update;
  if not found then raise exception 'NOT_FOUND: %', coalesce(p_code, '(none)'); end if;

  for k, j in select e.key, e.value from jsonb_each(p_patch) e loop
    if k = any (v_text) then
      if jsonb_typeof(j) = 'null' then s := null;
      elsif jsonb_typeof(j) = 'string' then s := nullif(btrim(j #>> '{}'), '');
      else raise exception 'BAD_VALUE: % must be text', k;
      end if;
      if s is not null and length(s) > 500 then raise exception 'BAD_VALUE: % is too long (500 characters at most)', k; end if;
      if k = 'name_full' and s is null then raise exception 'BAD_VALUE: the name cannot be empty'; end if;
      if    k = 'name_full'    then r.name_full := s;
      elsif k = 'brand'        then r.brand := s;
      elsif k = 'unit_th'      then r.unit_th := s;
      elsif k = 'barcode'      then r.barcode := s;
      else                          r.product_type := s;
      end if;
    elsif k = any (v_money) then
      if jsonb_typeof(j) <> 'number' then raise exception 'BAD_VALUE: % must be a number (a price cannot be cleared)', k; end if;
      n := (j #>> '{}')::numeric;
      if n < 0 or n > 9999999999.99 then raise exception 'BAD_VALUE: % must be between 0 and 9999999999.99', k; end if;
      if n <> round(n, 2) then raise exception 'BAD_VALUE: % must have at most 2 decimals (baht and satang), it is never rounded silently', k; end if;
      if    k = 'cost_price'    then r.cost_price := n;
      elsif k = 'selling_price' then r.selling_price := n;
      elsif k = 'retail_price'  then r.retail_price := n;
      else                           r.ecommerce_price := n;
      end if;
    else                                                       -- pack_qty
      if jsonb_typeof(j) = 'null' then r.pack_qty := null;
      elsif jsonb_typeof(j) = 'number' and (j #>> '{}')::numeric > 0 and (j #>> '{}')::numeric <= 1000000 then r.pack_qty := (j #>> '{}')::numeric;
      else raise exception 'BAD_VALUE: pack_qty must be a number above 0';
      end if;
    end if;
  end loop;

  if p_patch ? 'barcode' and r.barcode is not null then
    select s2.sku_code into v_other from public.sku_registry s2 where s2.barcode = r.barcode and s2.sku_code <> p_code limit 1;
    if found then raise exception 'BARCODE_TAKEN: % is already used by %', r.barcode, v_other; end if;
  end if;

  begin
    update public.sku_registry s set
      name_full = r.name_full, brand = r.brand, unit_th = r.unit_th, barcode = r.barcode, product_type = r.product_type, pack_qty = r.pack_qty,
      cost_price = r.cost_price, selling_price = r.selling_price, retail_price = r.retail_price, ecommerce_price = r.ecommerce_price
     where s.sku_code = p_code returning * into r;
  exception when unique_violation then
    raise exception 'BARCODE_TAKEN: % is already used by another product', r.barcode;
  end;
  return public.sku_registry_row_json(r);
end $$;

drop trigger if exists sku_registry_category on public.sku_registry;
drop function if exists public.sku_registry_category();
alter table public.shop_categories drop column if exists category_id;
drop index if exists public.sku_registry_category_id_idx;
alter table public.sku_registry drop column if exists category_id;
drop function if exists public.product_category_json(public.product_categories);
drop trigger if exists product_categories_guard on public.product_categories;
drop trigger if exists product_categories_truncate on public.product_categories;
drop table if exists public.product_category_changes;
drop table if exists public.product_categories;
drop function if exists public.product_categories_guard();
drop function if exists public.product_category_changes_guard();
