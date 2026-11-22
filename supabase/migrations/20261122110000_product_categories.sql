-- Product categories: one central, structured list that every SKU points at with a real foreign key (owner's decision 2026-11-22: a NEW separate table,
-- one level of nesting: group -> category). Design: docs/superpowers/specs/2026-11-22-categories-and-central-receivables-design.md section 2.
--
-- What it adds
--   * public.product_categories          the master list. code (unique, never changes), Thai/English name, description, optional group (parent), active flag,
--                                         sort order, created/updated by/at. A row is either a GROUP (is_group: it only groups categories, no SKU may point at it,
--                                         it has no parent) or a CATEGORY (SKUs point at it; its parent, if any, must be a group). Never deleted (trigger).
--   * public.product_category_changes    append-only audit of every create / change / (de)activation: who, when, what changed, the reason.
--   * sku_registry.category_id           foreign key (on delete restrict). A trigger refuses a category that is missing, a group, or inactive when it is newly chosen,
--                                         and keeps sku_registry.product_type equal to the category code. Because the shop derives its category with
--                                         shop_category_of(product_type, domain), which returns product_type when it is set, every shop / catalogue / facet / rewards
--                                         function keeps working UNCHANGED and shows exactly the same categories (the backfill only writes the same text it derives today).
--   * the SKU change feed carries category_id (devices receive category changes like price changes); the feed rows show category_id, category_code, category_name.
--   * sku_set_details accepts "category_id".
--   * shop_categories.category_id         the storefront settings (picture, sort, visible) of a category point at the master row.
--   * staff functions: product_categories_list, product_category_save, product_category_set_active. Clients cannot read or write the tables directly.
-- Deactivating a category: products that already use it keep it (nothing is rewritten); it can no longer be chosen. A reason is required and logged.
-- A group can only be deactivated once its categories are inactive.
--
-- Backfill (same transaction): a group "POD" for the POD / vape domain; one category per distinct shop_category_of(product_type, domain) of the registry, under POD when
-- all its SKUs are in that domain; any shop_categories row is linked by code; every SKU gets its category_id. Codes are exactly today's shop codes, so the reward rules
-- that name 'Kratom drink' and the shop's category links keep working.
--
-- Error contract: 'CODE: detail' (BAD_VALUE, BAD_FIELD, NOT_FOUND, CODE_TAKEN, CATEGORY_INACTIVE, CATEGORY_IS_GROUP, BAD_PARENT, REASON_REQUIRED, HAS_ACTIVE_CHILDREN);
-- non-staff = errcode 42501.
-- Rollback: supabase/rollbacks/20261122110000_product_categories_down.sql (refuses once staff created or changed a category).

-- 1. Tables ------------------------------------------------------------------------------------------------------------------------------------------------
create table public.product_categories (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Za-z0-9][A-Za-z0-9 ._&/-]{0,59}$'),
  name_th     text not null check (length(btrim(name_th)) between 1 and 80),
  name_en     text check (name_en is null or length(name_en) <= 80),
  description text check (description is null or length(description) <= 500),
  parent_id   uuid references public.product_categories (id) on delete restrict,
  is_group    boolean not null default false,
  is_active   boolean not null default true,
  sort_order  integer not null default 100 check (sort_order between -100000 and 100000),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  check (parent_id is null or parent_id <> id),
  check (not (is_group and parent_id is not null))
);
create index product_categories_parent_idx on public.product_categories (parent_id) where parent_id is not null;
alter table public.product_categories enable row level security;     -- no policy: read through the functions
revoke all on public.product_categories from public, anon, authenticated;
comment on table public.product_categories is 'Central product category list (groups and categories). SKUs point at categories through sku_registry.category_id. Never deleted.';
-- the SKU side of the relationship (the trigger that validates it is in section 3)
alter table public.sku_registry add column category_id uuid references public.product_categories (id) on delete restrict;
create index sku_registry_category_id_idx on public.sku_registry (category_id);

create table public.product_category_changes (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default clock_timestamp(),
  category_id uuid not null references public.product_categories (id) on delete restrict,
  actor       uuid,                                                     -- auth.uid(); null for the migration backfill
  action      text not null check (action in ('created', 'changed', 'activated', 'deactivated')),
  changes     jsonb not null default '{}'::jsonb,
  reason      text check (reason is null or length(reason) <= 500)
);
create index product_category_changes_cat_idx on public.product_category_changes (category_id, id desc);
alter table public.product_category_changes enable row level security;
revoke all on public.product_category_changes from public, anon, authenticated;

create or replace function public.product_category_changes_guard() returns trigger language plpgsql as $$
begin
  raise exception 'The category change log is append-only' using errcode = '23001';
end $$;
create trigger product_category_changes_guard before update or delete on public.product_category_changes for each row execute function public.product_category_changes_guard();
create trigger product_category_changes_truncate before truncate on public.product_category_changes for each statement execute function public.product_category_changes_guard();

-- 2. Rules on the category table ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.product_categories_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare p public.product_categories;
begin
  if tg_op = 'DELETE' then raise exception 'Categories are never deleted: deactivate it instead' using errcode = '23001'; end if;
  if tg_op = 'UPDATE' and new.code is distinct from old.code then raise exception 'BAD_VALUE: a category code never changes (rename it instead)'; end if;
  if new.parent_id is not null then
    select * into p from public.product_categories where id = new.parent_id;
    if not found then raise exception 'BAD_PARENT: the group does not exist'; end if;
    if not p.is_group then raise exception 'BAD_PARENT: % is a category, not a group (only one level: group -> category)', p.code; end if;
  end if;
  if new.is_group then
    if new.parent_id is not null then raise exception 'BAD_PARENT: a group cannot be inside another group'; end if;
    if tg_op = 'UPDATE' and not old.is_group and exists (select 1 from public.sku_registry s where s.category_id = new.id) then
      raise exception 'CATEGORY_IS_GROUP: % has products, so it cannot become a group', new.code; end if;
  elsif tg_op = 'UPDATE' and old.is_group and exists (select 1 from public.product_categories c where c.parent_id = new.id) then
    raise exception 'BAD_PARENT: % still contains categories, so it must stay a group', new.code;
  end if;
  if tg_op = 'UPDATE' and old.is_active and not new.is_active and new.is_group
     and exists (select 1 from public.product_categories c where c.parent_id = new.id and c.is_active) then
    raise exception 'HAS_ACTIVE_CHILDREN: deactivate the categories of group % first', new.code;
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); new.updated_by := auth.uid(); end if;
  return new;
end $$;
create trigger product_categories_guard before insert or update or delete on public.product_categories for each row execute function public.product_categories_guard();
create trigger product_categories_truncate before truncate on public.product_categories for each statement execute function public.product_category_changes_guard();

create or replace function public.product_category_json(c public.product_categories) returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', c.id, 'code', c.code, 'name_th', c.name_th, 'name_en', c.name_en, 'description', c.description, 'parent_id', c.parent_id,
    'is_group', c.is_group, 'is_active', c.is_active, 'sort_order', c.sort_order, 'created_at', c.created_at, 'updated_at', c.updated_at,
    'product_count', (select count(*) from public.sku_registry s where s.category_id = c.id),
    'active_product_count', (select count(*) from public.sku_registry s where s.category_id = c.id and s.status = 'active'))
$$;
revoke all on function public.product_category_json(public.product_categories) from public, anon, authenticated;

-- 3. The SKU side ------------------------------------------------------------------------------------------------------------------------------------------

-- Runs before sku_registry_touch (alphabetical), so updated_at and the feed see the result.
create or replace function public.sku_registry_category() returns trigger language plpgsql security definer set search_path = public as $$
declare c public.product_categories;
begin
  if new.category_id is null then return new; end if;
  select * into c from public.product_categories where id = new.category_id;
  if not found then raise exception 'NOT_FOUND: category % does not exist', new.category_id; end if;
  if tg_op = 'INSERT' or new.category_id is distinct from old.category_id then     -- only a NEW choice is checked: products keep a category that was deactivated later
    if c.is_group then raise exception 'CATEGORY_IS_GROUP: % is a group; choose one of its categories', c.code; end if;
    if not c.is_active then raise exception 'CATEGORY_INACTIVE: % is inactive and cannot be chosen', c.code; end if;
  end if;
  new.product_type := c.code;                                  -- the shop derives its category from product_type: keep them identical
  return new;
end $$;
create trigger sku_registry_category before insert or update on public.sku_registry for each row execute function public.sku_registry_category();

-- the feed carries category_id (same function as 20261121120000 plus one column)
create or replace function public.sku_registry_log() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new  jsonb := to_jsonb(new);
  v_diff jsonb;
begin
  select jsonb_object_agg(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k)) into v_diff
    from unnest(array['name_full', 'brand', 'product_type', 'domain', 'pack_qty', 'unit_en', 'unit_th', 'barcode', 'status',
                      'cost_price', 'retail_price', 'selling_price', 'friend_price', 'wholesale_price', 'ecommerce_price', 'needs_review', 'review_notes',
                      'category_id']) as k
   where coalesce(v_old -> k, 'null'::jsonb) is distinct from coalesce(v_new -> k, 'null'::jsonb);
  if v_diff is null then return null; end if;
  perform public.sku_changes_lock();
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
    'needs_review', r.needs_review, 'review_notes', r.review_notes, 'updated_at', r.updated_at,
    'category_id', r.category_id,
    'category_code', (select c.code from public.product_categories c where c.id = r.category_id),
    'category_name', (select c.name_th from public.product_categories c where c.id = r.category_id))
$$;
revoke all on function public.sku_registry_row_json(public.sku_registry) from public, anon, authenticated;

-- sku_set_details: as in 20261121120000, plus "category_id" (a uuid string; it cannot be cleared). The trigger above validates it.
create or replace function public.sku_set_details(p_code text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_text  constant text[] := array['name_full', 'brand', 'unit_th', 'barcode', 'product_type'];
  v_money constant text[] := array['cost_price', 'selling_price', 'retail_price', 'ecommerce_price'];
  r public.sku_registry;
  k text; j jsonb; s text; n numeric; v_other text; v_cat uuid;
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can change SKU details' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_VALUE: the patch must be a JSON object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (v_text) or k = any (v_money) or k = 'pack_qty' or k = 'category_id') then raise exception 'BAD_FIELD: "%" cannot be changed here', k; end if;
  end loop;
  if p_patch ? 'category_id' then
    if jsonb_typeof(p_patch -> 'category_id') <> 'string' or (p_patch ->> 'category_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'BAD_VALUE: category_id must be the id of a category (it cannot be cleared)'; end if;
    v_cat := (p_patch ->> 'category_id')::uuid;
  end if;
  perform public.sku_changes_lock();
  select * into r from public.sku_registry where sku_code = p_code for no key update;
  if not found then raise exception 'NOT_FOUND: %', coalesce(p_code, '(none)'); end if;

  for k, j in select e.key, e.value from jsonb_each(p_patch) e loop
    if k = 'category_id' then
      r.category_id := v_cat;
    elsif k = any (v_text) then
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
      else                          r.product_type := s;           -- ignored when the SKU has a category: the trigger keeps product_type = category code
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
      cost_price = r.cost_price, selling_price = r.selling_price, retail_price = r.retail_price, ecommerce_price = r.ecommerce_price,
      category_id = r.category_id
     where s.sku_code = p_code returning * into r;
  exception when unique_violation then
    raise exception 'BARCODE_TAKEN: % is already used by another product', r.barcode;
  end;
  return public.sku_registry_row_json(r);
end $$;

-- storefront settings of a category point at the master row
alter table public.shop_categories add column category_id uuid unique references public.product_categories (id) on delete restrict;

-- 4. Staff functions ---------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.product_categories_list(p_include_inactive boolean default true)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can read the category list' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.product_category_json(c) order by coalesce(g.sort_order, c.sort_order), coalesce(g.name_th, c.name_th), c.is_group desc, c.sort_order, c.name_th)
    from public.product_categories c left join public.product_categories g on g.id = c.parent_id
    where coalesce(p_include_inactive, true) or c.is_active), '[]'::jsonb);
end $$;

-- p_id null = create (code and name_th required). Allowed keys: code (create only), name_th, name_en, description, parent_id (uuid or null), is_group, sort_order.
create or replace function public.product_category_save(p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.product_categories; before jsonb; k text; v text; diff jsonb;
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can manage categories' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_VALUE: the patch must be a JSON object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('code', 'name_th', 'name_en', 'description', 'parent_id', 'is_group', 'sort_order') then raise exception 'BAD_FIELD: "%" cannot be set here', k; end if;
  end loop;
  if p_patch ? 'parent_id' and jsonb_typeof(p_patch -> 'parent_id') not in ('null', 'string') then raise exception 'BAD_VALUE: parent_id must be a group id or null'; end if;
  if p_patch ? 'is_group' and jsonb_typeof(p_patch -> 'is_group') <> 'boolean' then raise exception 'BAD_VALUE: is_group must be true or false'; end if;
  if p_patch ? 'sort_order' and jsonb_typeof(p_patch -> 'sort_order') <> 'number' then raise exception 'BAD_VALUE: sort_order must be a number'; end if;

  if p_id is null then
    v := btrim(coalesce(p_patch ->> 'code', ''));
    if v = '' then raise exception 'BAD_VALUE: a new category needs a code'; end if;
    if v !~ '^[A-Za-z0-9][A-Za-z0-9 ._&/-]{0,59}$' then raise exception 'BAD_VALUE: the code uses letters A-Z, digits, space and . _ & / - (60 at most)'; end if;
    if exists (select 1 from public.product_categories where lower(code) = lower(v)) then raise exception 'CODE_TAKEN: % is already used', v; end if;
    if nullif(btrim(coalesce(p_patch ->> 'name_th', '')), '') is null then raise exception 'BAD_VALUE: the Thai name is required'; end if;
    insert into public.product_categories (code, name_th, name_en, description, parent_id, is_group, sort_order)
    values (v, btrim(p_patch ->> 'name_th'), nullif(btrim(coalesce(p_patch ->> 'name_en', '')), ''), nullif(btrim(coalesce(p_patch ->> 'description', '')), ''),
            nullif(p_patch ->> 'parent_id', '')::uuid, coalesce((p_patch ->> 'is_group')::boolean, false), coalesce((p_patch ->> 'sort_order')::int, 100))
    returning * into c;
    insert into public.product_category_changes (category_id, actor, action, changes) values (c.id, auth.uid(), 'created', public.product_category_json(c) - 'product_count' - 'active_product_count');
    return public.product_category_json(c);
  end if;

  select * into c from public.product_categories where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: category %', p_id; end if;
  if p_patch ? 'code' and (p_patch ->> 'code') is distinct from c.code then raise exception 'BAD_VALUE: a category code never changes (rename it instead)'; end if;
  if p_patch ? 'name_th' and nullif(btrim(coalesce(p_patch ->> 'name_th', '')), '') is null then raise exception 'BAD_VALUE: the Thai name cannot be empty'; end if;
  before := to_jsonb(c);
  update public.product_categories set
    name_th     = case when p_patch ? 'name_th' then btrim(p_patch ->> 'name_th') else name_th end,
    name_en     = case when p_patch ? 'name_en' then nullif(btrim(coalesce(p_patch ->> 'name_en', '')), '') else name_en end,
    description = case when p_patch ? 'description' then nullif(btrim(coalesce(p_patch ->> 'description', '')), '') else description end,
    parent_id   = case when p_patch ? 'parent_id' then nullif(p_patch ->> 'parent_id', '')::uuid else parent_id end,
    is_group    = case when p_patch ? 'is_group' then (p_patch ->> 'is_group')::boolean else is_group end,
    sort_order  = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::int else sort_order end
  where id = p_id returning * into c;
  select jsonb_object_agg(x.key, jsonb_build_object('old', before -> x.key, 'new', x.value)) into diff
    from jsonb_each(to_jsonb(c)) x where x.key in ('name_th', 'name_en', 'description', 'parent_id', 'is_group', 'sort_order') and (before -> x.key) is distinct from x.value;
  if diff is not null then insert into public.product_category_changes (category_id, actor, action, changes) values (c.id, auth.uid(), 'changed', diff); end if;
  return public.product_category_json(c);
end $$;

create or replace function public.product_category_set_active(p_id uuid, p_active boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.product_categories; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can manage categories' using errcode = '42501'; end if;
  if p_active is null then raise exception 'BAD_VALUE: say whether the category is active'; end if;
  if not p_active and v_reason is null then raise exception 'REASON_REQUIRED: say why the category is deactivated'; end if;
  select * into c from public.product_categories where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: category %', p_id; end if;
  if c.is_active = p_active then return public.product_category_json(c); end if;
  update public.product_categories set is_active = p_active where id = p_id returning * into c;
  insert into public.product_category_changes (category_id, actor, action, reason) values (c.id, auth.uid(), case when p_active then 'activated' else 'deactivated' end, left(v_reason, 500));
  return public.product_category_json(c);
end $$;

revoke all on function public.product_categories_list(boolean), public.product_category_save(uuid, jsonb), public.product_category_set_active(uuid, boolean, text) from public, anon;
grant execute on function public.product_categories_list(boolean), public.product_category_save(uuid, jsonb), public.product_category_set_active(uuid, boolean, text) to authenticated;
revoke all on function public.product_categories_guard(), public.sku_registry_category() from public, anon, authenticated;

-- 5. Backfill ----------------------------------------------------------------------------------------------------------------------------------------------
insert into public.product_categories (code, name_th, name_en, description, is_group, sort_order, created_by, updated_by)
select 'POD', 'POD / บุหรี่ไฟฟ้า', 'POD / vape', 'Group created from the registry domain "POD / vape (Ref POD)"', true, 10, null, null
where exists (select 1 from public.sku_registry where domain = 'POD / vape (Ref POD)');

insert into public.product_categories (code, name_th, name_en, parent_id, sort_order, created_by, updated_by)
select x.code, coalesce(sc.name_th, x.code), coalesce(sc.name_en, x.code),
       case when x.all_pod then (select id from public.product_categories where code = 'POD') end,
       coalesce(sc.sort_order, 100), null, null
from (select public.shop_category_of(s.product_type, s.domain) as code, bool_and(s.domain = 'POD / vape (Ref POD)') as all_pod
        from public.sku_registry s group by 1) x
left join public.shop_categories sc on sc.code = x.code
where x.code is not null;

-- storefront rows that exist (none on 2026-11-22) are linked, and any storefront code no SKU uses yet becomes a category too
insert into public.product_categories (code, name_th, name_en, sort_order, created_by, updated_by)
select sc.code, coalesce(sc.name_th, sc.code), sc.name_en, sc.sort_order, null, null from public.shop_categories sc
where not exists (select 1 from public.product_categories c where c.code = sc.code) and sc.code ~ '^[A-Za-z0-9][A-Za-z0-9 ._&/-]{0,59}$';
update public.shop_categories sc set category_id = c.id from public.product_categories c where c.code = sc.code and sc.category_id is null;

insert into public.product_category_changes (category_id, actor, action, changes, reason)
select id, null, 'created', jsonb_build_object('code', code, 'name_th', name_th, 'parent_id', parent_id, 'is_group', is_group), 'Backfill from the SKU registry (migration 20261122110000)'
from public.product_categories;

update public.sku_registry s set category_id = c.id
from public.product_categories c
where c.code = public.shop_category_of(s.product_type, s.domain) and not c.is_group and s.category_id is null;

do $$ declare n int; begin
  select count(*) into n from public.sku_registry where category_id is null;
  if n > 0 then raise exception 'Backfill incomplete: % SKUs have no category', n; end if;
end $$;
