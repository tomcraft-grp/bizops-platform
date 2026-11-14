-- DEV APP Customer: every page editable + database-backed components.
--
-- 1. Pages. A layout may now hold `pages` (one section list per app tab: shop, rewards, pay, events, profile) and
--    `customPages` (staff-made pages opened from links) next to `home`. Each tab page keeps exactly one built-in
--    "core" block (shopCore, …) so ordering, payments, redemptions and the profile form keep working. Both keys are
--    optional: layouts stored before this migration stay valid and render exactly as before.
--
-- 2. Data sources. Components can show data from APPROVED database views only:
--      * views live in schema customer_app_views. The API does not expose that schema and no client role has USAGE on it.
--        A new view (with customer-safe columns only) is added by a developer in a migration;
--      * an administrator registers a view and picks which of its columns components may use
--        (public.customer_app_data_sources), through customer_app_save_source;
--      * the customer app and the designer read data ONLY through public.customer_app_query, which checks the source,
--        audience, every column and every operator against that allow-list, binds all values as parameters, and caps
--        the rows. No SQL text is accepted from clients.

-- ---------------------------------------------------------------------------------------------- 1. validation
create or replace function public.customer_app_validate(p_config jsonb)
returns text language plpgsql immutable set search_path = public as $$
declare
  allowed constant text[] := array['memberCard', 'outstandingNotice', 'myCoupons', 'offers', 'categories', 'couponStrip', 'banner', 'heading',
    'text', 'image', 'button', 'card', 'spacer', 'divider', 'announcement', 'sectionHeader', 'carousel',
    'dataCard', 'productCard', 'productImage', 'dataTable', 'dataList', 'kpi', 'chart', 'search', 'filter'];
  core_of constant jsonb := '{"shop": "shopCore", "rewards": "rewardsCore", "pay": "payCore", "events": "eventsCore", "profile": "profileCore"}';
  secs jsonb;
  r record;
  cp jsonb;
  cp_ids text[] := '{}';
  ids text[] := '{}';
  k text;
  v jsonb;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then return 'config must be an object'; end if;
  if (p_config ->> 'schemaVersion') is distinct from '1' then return 'unsupported schemaVersion'; end if;
  if pg_column_size(p_config) > 400000 then return 'config is too large'; end if;
  if jsonb_typeof(p_config -> 'theme') is distinct from 'object' then return 'theme is missing'; end if;
  if jsonb_typeof(p_config -> 'brand') is distinct from 'object' then return 'brand is missing'; end if;
  if jsonb_typeof(p_config -> 'nav') is distinct from 'array' or jsonb_array_length(p_config -> 'nav') = 0 then return 'nav is missing'; end if;
  if jsonb_typeof(p_config -> 'home') is distinct from 'array' then return 'home sections are missing'; end if;
  if jsonb_typeof(p_config -> 'onboarding') is distinct from 'object' or jsonb_typeof(p_config -> 'onboarding' -> 'slides') is distinct from 'array'
     or jsonb_array_length(p_config -> 'onboarding' -> 'slides') > 8 then return 'intro pop-up settings are invalid'; end if;
  if p_config::text ~* '(<\s*script|javascript:|\mon[a-z]+\s*=\s*\\?["'']|<\s*iframe)' then return 'markup or script is not allowed'; end if;

  if p_config ? 'pages' then
    if jsonb_typeof(p_config -> 'pages') <> 'object' then return 'pages must be an object'; end if;
    for k, v in select * from jsonb_each(p_config -> 'pages') loop
      if not core_of ? k then return 'unknown page ' || k; end if;
      if jsonb_typeof(v) <> 'array' then return 'page ' || k || ' must be a list of sections'; end if;
      if (select count(*) from jsonb_array_elements(v) e where e ->> 'type' = core_of ->> k) <> 1 then
        return 'page ' || k || ' must keep its built-in block exactly once'; end if;
    end loop;
  end if;

  if p_config ? 'customPages' then
    if jsonb_typeof(p_config -> 'customPages') <> 'array' or jsonb_array_length(p_config -> 'customPages') > 20 then return 'custom pages are invalid (max 20)'; end if;
    for cp in select * from jsonb_array_elements(p_config -> 'customPages') loop
      if jsonb_typeof(cp) <> 'object' or coalesce(cp ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{1,30}$' or (cp ->> 'id') = any (cp_ids) then
        return 'custom page ids must be unique'; end if;
      cp_ids := cp_ids || (cp ->> 'id');
      if jsonb_typeof(cp -> 'title') is distinct from 'string' or length(cp ->> 'title') not between 1 and 40 then return 'custom page title is invalid'; end if;
      if jsonb_typeof(cp -> 'sections') is distinct from 'array' then return 'custom page sections are missing'; end if;
    end loop;
  end if;

  -- every section of every page
  select coalesce(jsonb_agg(jsonb_build_object('page', x.page, 's', x.s)), '[]'::jsonb) into secs from (
    select 'home'::text as page, e as s from jsonb_array_elements(p_config -> 'home') e
    union all
    select p.key, e from jsonb_each(case when jsonb_typeof(p_config -> 'pages') = 'object' then p_config -> 'pages' else '{}'::jsonb end) p,
      jsonb_array_elements(p.value) e
    union all
    select 'page:' || (c ->> 'id'), e from jsonb_array_elements(coalesce(p_config -> 'customPages', '[]'::jsonb)) c, jsonb_array_elements(c -> 'sections') e
  ) x;

  if exists (select 1 from jsonb_array_elements(secs) x group by x ->> 'page' having count(*) > 60) then return 'too many sections on a page (max 60)'; end if;
  for r in select x ->> 'page' as page, x -> 's' as s from jsonb_array_elements(secs) x loop
    if jsonb_typeof(r.s) is distinct from 'object' or (r.s ->> 'type') is null
       or not ((r.s ->> 'type') = any (allowed) or (core_of ->> r.page) is not distinct from (r.s ->> 'type')) then
      return 'section type ' || coalesce(r.s ->> 'type', 'null') || ' is not allowed on ' || r.page; end if;
    if (r.s ->> 'id') is null or (r.s ->> 'id') = any (ids) then return 'section ids must be unique'; end if;
    ids := ids || (r.s ->> 'id');
    -- data bindings may only name a source; columns are checked on every query by customer_app_query
    if r.s -> 'props' ? 'data' and (jsonb_typeof(r.s -> 'props' -> 'data') <> 'object'
       or coalesce(r.s -> 'props' -> 'data' ->> 'source', '') !~ '^(local|db):[a-z0-9_]{2,40}$') then
      return 'section ' || (r.s ->> 'id') || ' has an invalid data source'; end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------- 2. approved views
create schema if not exists customer_app_views;
revoke all on schema customer_app_views from public, anon, authenticated;
comment on schema customer_app_views is
  'Customer-safe views for DEV APP Customer components. Read only through public.customer_app_query. Never put cost, margin or personal data here.';

-- SKU catalogue for customers: active SKUs that have a price. ONLY code, names, brand, type, unit and the
-- selling/sticker price. cost_price, friend_price, wholesale_price, review notes and import metadata are never exposed.
-- Source: public.sku_registry (the central SKU table since 20261114200000; sku_code is the NEW automatic code), or the
-- original public.sku_master TABLE when this runs on a database that has not had that migration yet (the view keeps
-- following the table when it is renamed later). public.sku_master is a compatibility VIEW with legacy codes once the
-- SKU migration has run, so it is never used as the source then. Skipped when neither exists.
do $$
declare src regclass := coalesce(to_regclass('public.sku_registry'), to_regclass('public.sku_master'));
begin
  if src is null then
    raise notice 'no SKU table found: customer_app_views.sku_catalog not created';
    return;
  end if;
  execute format($v$
    create or replace view customer_app_views.sku_catalog with (security_barrier = true) as
      select s.sku_code, s.name_full, s.name_th, s.name_en, s.brand, s.product_type,
             coalesce(s.unit_th, s.unit_en) as unit,
             coalesce(s.selling_price, s.retail_price) as price,
             s.retail_price
      from %s s
      where s.status = 'active' and coalesce(s.selling_price, s.retail_price) is not null
  $v$, src);
  execute 'revoke all on customer_app_views.sku_catalog from public, anon, authenticated';
  if (select relkind from pg_class where oid = src) = 'r' then  -- an index can only be created on a real table
    execute format('create index if not exists sku_status_name_idx on %s (status, name_full)', src);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------- registry
create table if not exists public.customer_app_data_sources (
  id text primary key check (id ~ '^db:[a-z0-9_]{2,40}$'),
  label text not null check (length(label) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  schema_name text not null default 'customer_app_views' check (schema_name = 'customer_app_views'),
  view_name text not null check (view_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  columns jsonb not null check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) between 1 and 40),
  audience text not null default 'authenticated' check (audience in ('authenticated', 'staff')),
  max_rows integer not null default 50 check (max_rows between 1 and 50),
  enabled boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.customer_app_data_sources enable row level security;
drop policy if exists "staff read data sources" on public.customer_app_data_sources;
create policy "staff read data sources" on public.customer_app_data_sources for select to authenticated using (public.customer_app_can('view'));
-- no write policies: changes go through customer_app_save_source (administrators only)
revoke insert, update, delete, truncate on public.customer_app_data_sources from anon, authenticated;
revoke all on public.customer_app_data_sources from anon;

-- Views an administrator can register, with their columns read from the catalogue.
create or replace function public.customer_app_available_views()
returns table (schema_name text, view_name text, columns jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.customer_app_can('admin') then raise exception 'Only an administrator can register data sources' using errcode = '42501'; end if;
  return query
    select c.table_schema::text, c.table_name::text,
      jsonb_agg(jsonb_build_object(
        'key', c.column_name,
        'label', initcap(replace(c.column_name, '_', ' ')),
        'type', case
          when c.data_type in ('numeric', 'integer', 'bigint', 'smallint', 'real', 'double precision') and c.column_name ~ '(price|amount|total|cost)' then 'money'
          when c.data_type in ('numeric', 'integer', 'bigint', 'smallint', 'real', 'double precision') then 'number'
          when c.data_type = 'boolean' then 'boolean'
          when c.data_type = 'date' or c.data_type like 'timestamp%' then 'date'
          when c.column_name ~ '(image|photo|picture)_?url' then 'image'
          else 'text' end) order by c.ordinal_position)
    from information_schema.columns c
    where c.table_schema = 'customer_app_views' and c.column_name ~ '^[a-z_][a-z0-9_]{0,62}$'
    group by c.table_schema, c.table_name
    order by 2;
end $$;

create or replace function public.customer_app_save_source(p_id text, p_label text, p_description text, p_view text, p_columns jsonb, p_audience text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  real_cols text[];
  col jsonb;
  seen text[] := '{}';
begin
  if not public.customer_app_can('admin') then raise exception 'Only an administrator can register data sources' using errcode = '42501'; end if;
  if coalesce(p_id, '') !~ '^db:[a-z0-9_]{2,40}$' then raise exception 'The id must look like db:my_view (lowercase letters, digits, _)'; end if;
  if coalesce(trim(p_label), '') = '' or length(p_label) > 80 then raise exception 'A label is required (max 80 characters)'; end if;
  if p_audience not in ('authenticated', 'staff') then raise exception 'Unknown audience %', p_audience; end if;
  real_cols := array(select column_name::text from information_schema.columns where table_schema = 'customer_app_views' and table_name = p_view);
  if cardinality(real_cols) = 0 then raise exception 'View customer_app_views.% does not exist', p_view; end if;
  if jsonb_typeof(p_columns) is distinct from 'array' or jsonb_array_length(p_columns) not between 1 and 40 then raise exception 'Choose 1–40 columns'; end if;
  for col in select * from jsonb_array_elements(p_columns) loop
    if not ((col ->> 'key') = any (real_cols)) then raise exception 'Column % is not in the view', col ->> 'key'; end if;
    if (col ->> 'key') = any (seen) then raise exception 'Column % is listed twice', col ->> 'key'; end if;
    seen := seen || (col ->> 'key');
    if (col ->> 'type') is null or (col ->> 'type') not in ('text', 'number', 'money', 'boolean', 'date', 'image', 'emoji') then raise exception 'Unknown column type for %', col ->> 'key'; end if;
    if coalesce(trim(col ->> 'label'), '') = '' or length(col ->> 'label') > 60 then raise exception 'Column % needs a label (max 60 characters)', col ->> 'key'; end if;
  end loop;
  insert into public.customer_app_data_sources as d (id, label, description, view_name, columns, audience, enabled)
  values (p_id, trim(p_label), nullif(trim(p_description), ''), p_view,
          (select jsonb_agg(jsonb_build_object('key', c ->> 'key', 'label', trim(c ->> 'label'), 'type', c ->> 'type')) from jsonb_array_elements(p_columns) c),
          p_audience, coalesce(p_enabled, true))
  on conflict (id) do update set label = excluded.label, description = excluded.description, view_name = excluded.view_name, columns = excluded.columns,
    audience = excluded.audience, enabled = excluded.enabled, updated_by = auth.uid(), updated_at = now();
end $$;

-- ---------------------------------------------------------------------------------------------- query
-- Records:   p_fields = columns to return, p_filters = [{field, op, value}], p_sort = {field, dir}, p_limit ≤ 50, p_search
-- Aggregate: p_agg = {fn: count|sum|avg|min|max, field, groupBy} → rows [{group, value}], largest value first
-- Same semantics as applyQuery() in src/devapp/datasources.ts.
create or replace function public.customer_app_query(
  p_source text, p_fields text[], p_filters jsonb default '[]'::jsonb, p_sort jsonb default null,
  p_limit integer default 20, p_search text default null, p_agg jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  src public.customer_app_data_sources;
  types jsonb;
  vals jsonb := '[]'::jsonb;   -- bound values, referenced as ($1->>n)
  conds text[] := '{}';
  f jsonb; fld text; op text; typ text; val text; n integer;
  lhs text; rhs text;
  whr text; sel text; sql text; lim integer; res jsonb; cols jsonb;
  fn text; afield text; agroup text;
  srch text; parts text[];
  sort_field text; sort_dir text;
begin
  if auth.uid() is null then raise exception 'Please sign in to see this content' using errcode = '42501'; end if;
  select * into src from public.customer_app_data_sources where id = p_source and enabled;
  if not found then raise exception 'Unknown data source %', p_source using errcode = '22023'; end if;
  if src.audience = 'staff' and not public.customer_app_can('view') then raise exception 'This data is for staff only' using errcode = '42501'; end if;
  select jsonb_object_agg(c ->> 'key', c ->> 'type') into types from jsonb_array_elements(src.columns) c;
  lim := least(greatest(coalesce(p_limit, 20), 1), src.max_rows, 50);

  -- filters: allow-listed columns and operators; values are bound parameters, never part of the SQL text
  if p_filters is not null and jsonb_typeof(p_filters) = 'array' then
    if jsonb_array_length(p_filters) > 12 then raise exception 'Too many filters' using errcode = '22023'; end if;
    for f in select * from jsonb_array_elements(p_filters) loop
      fld := f ->> 'field'; op := f ->> 'op'; typ := types ->> fld; val := coalesce(f ->> 'value', '');
      if typ is null then raise exception 'Unknown field %', fld using errcode = '22023'; end if;
      if length(val) > 200 then raise exception 'Filter value is too long' using errcode = '22023'; end if;
      if op in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte') and val <> '' then
        if typ in ('number', 'money') and val !~ '^-?[0-9]+(\.[0-9]+)?$' then raise exception 'Filter on % needs a number', fld using errcode = '22023'; end if;
        if typ = 'date' and val !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then raise exception 'Filter on % needs a date (YYYY-MM-DD)', fld using errcode = '22023'; end if;
      end if;
      vals := vals || jsonb_build_array(val);
      n := jsonb_array_length(vals) - 1;
      if typ in ('number', 'money') then lhs := format('%I', fld); rhs := format('nullif(($1->>%s), '''')::numeric', n);
      elsif typ = 'date' then lhs := format('%I::date', fld); rhs := format('nullif(left(($1->>%s), 10), '''')::date', n);
      else lhs := format('%I::text', fld); rhs := format('($1->>%s)', n);
      end if;
      if op in ('gt', 'gte', 'lt', 'lte') and typ not in ('number', 'money', 'date') then raise exception 'Operator % needs a number or date field', op using errcode = '22023'; end if;
      if op in ('is_true', 'is_false') and typ <> 'boolean' then raise exception 'Operator % needs a yes/no field', op using errcode = '22023'; end if;
      conds := conds || case op
        when 'eq' then format('%s = %s', lhs, rhs)
        when 'neq' then format('%s is distinct from %s', lhs, rhs)
        when 'contains' then format('strpos(lower(coalesce(%I::text, '''')), lower(($1->>%s))) > 0', fld, n)
        when 'gt' then format('%s > %s', lhs, rhs)
        when 'gte' then format('%s >= %s', lhs, rhs)
        when 'lt' then format('%s < %s', lhs, rhs)
        when 'lte' then format('%s <= %s', lhs, rhs)
        when 'is_true' then format('%I is true', fld)
        when 'is_false' then format('%I is false', fld)
        when 'not_empty' then format('coalesce(%I::text, '''') <> ''''', fld)
        else null end;
      if conds[cardinality(conds)] is null then raise exception 'Unknown operator %', op using errcode = '22023'; end if;
    end loop;
  end if;

  if p_fields is not null then
    if cardinality(p_fields) > 16 then raise exception 'Too many fields' using errcode = '22023'; end if;
    foreach fld in array p_fields loop
      if types ->> fld is null then raise exception 'Unknown field %', fld using errcode = '22023'; end if;
    end loop;
  end if;

  -- search box: any requested text column contains the text
  srch := left(trim(coalesce(p_search, '')), 100);
  if srch <> '' and p_fields is not null then
    vals := vals || jsonb_build_array(srch);
    n := jsonb_array_length(vals) - 1;
    select array_agg(format('strpos(lower(coalesce(%I::text, '''')), lower(($1->>%s))) > 0', k, n)) into parts
      from (select distinct k from unnest(p_fields) k) d where (types ->> k) not in ('number', 'money', 'boolean');
    if parts is not null then conds := conds || ('(' || array_to_string(parts, ' or ') || ')'); end if;
  end if;
  whr := case when cardinality(conds) > 0 then ' where ' || array_to_string(conds, ' and ') else '' end;

  if p_agg is not null and jsonb_typeof(p_agg) = 'object' then
    fn := p_agg ->> 'fn'; afield := nullif(p_agg ->> 'field', ''); agroup := nullif(p_agg ->> 'groupBy', '');
    if fn is null or fn not in ('count', 'sum', 'avg', 'min', 'max') then raise exception 'Unknown calculation %', fn using errcode = '22023'; end if;
    if fn <> 'count' and (afield is null or (types ->> afield) not in ('number', 'money')) then raise exception 'Calculation % needs a number field', fn using errcode = '22023'; end if;
    if agroup is not null and types ->> agroup is null then raise exception 'Unknown field %', agroup using errcode = '22023'; end if;
    sel := case when fn = 'count' then 'count(*)' else format('%s(%I)', fn, afield) end;
    if agroup is null then
      sql := format('select jsonb_build_array(jsonb_build_object(''group'', null, ''value'', %s)) from %I.%I%s', sel, src.schema_name, src.view_name, whr);
    else
      sql := format('select coalesce(jsonb_agg(jsonb_build_object(''group'', g, ''value'', v) order by v desc nulls last), ''[]''::jsonb) from '
        || '(select coalesce(%I::text, ''—'') as g, %s as v from %I.%I%s group by 1 order by 2 desc nulls last limit %s) t',
        agroup, sel, src.schema_name, src.view_name, whr, lim);
    end if;
    cols := jsonb_build_array(
      jsonb_build_object('key', 'group', 'label', coalesce(agroup, ''), 'type', 'text'),
      jsonb_build_object('key', 'value', 'label', fn, 'type', case when fn = 'count' then 'number' else types ->> afield end));
  else
    if p_fields is null or cardinality(p_fields) = 0 then raise exception 'Choose at least one field' using errcode = '22023'; end if;
    sort_field := nullif(p_sort ->> 'field', '');
    if sort_field is not null and types ->> sort_field is null then raise exception 'Unknown field %', sort_field using errcode = '22023'; end if;
    sort_dir := case when p_sort ->> 'dir' = 'desc' then 'desc' else 'asc' end;
    select string_agg(format('%I', k), ', ') into sel from (select distinct k from unnest(p_fields || coalesce(sort_field, p_fields[1])) k) d;
    sql := format('select coalesce(jsonb_agg(to_jsonb(t)%s), ''[]''::jsonb) from (select %s from %I.%I%s%s limit %s) t',
      case when sort_field is null then '' else format(' order by t.%I %s nulls last', sort_field, sort_dir) end,
      sel, src.schema_name, src.view_name, whr,
      case when sort_field is null then '' else format(' order by %I %s nulls last', sort_field, sort_dir) end, lim);
    select jsonb_agg(c) into cols from jsonb_array_elements(src.columns) c where (c ->> 'key') = any (p_fields);
  end if;

  execute sql into res using vals;
  return jsonb_build_object('columns', coalesce(cols, '[]'::jsonb), 'rows', coalesce(res, '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------- privileges
revoke execute on function
  public.customer_app_validate(jsonb),
  public.customer_app_available_views(),
  public.customer_app_save_source(text, text, text, text, jsonb, text, boolean),
  public.customer_app_query(text, text[], jsonb, jsonb, integer, text, jsonb)
from public, anon;
grant execute on function
  public.customer_app_validate(jsonb),
  public.customer_app_available_views(),
  public.customer_app_save_source(text, text, text, text, jsonb, text, boolean),
  public.customer_app_query(text, text[], jsonb, jsonb, integer, text, jsonb)
to authenticated;

-- ---------------------------------------------------------------------------------------------- seed
insert into public.customer_app_data_sources (id, label, description, view_name, columns, audience)
select * from (values ('db:sku_catalog', 'SKU catalogue',
  'Active SKUs from the central SKU master: code, names, brand, type, unit and price. Cost, friend and wholesale prices are never included.',
  'sku_catalog',
  '[{"key": "sku_code", "label": "SKU code", "type": "text"},
    {"key": "name_full", "label": "Product name", "type": "text"},
    {"key": "name_th", "label": "Name (Thai)", "type": "text"},
    {"key": "name_en", "label": "Name (English)", "type": "text"},
    {"key": "brand", "label": "Brand", "type": "text"},
    {"key": "product_type", "label": "Product type", "type": "text"},
    {"key": "unit", "label": "Unit", "type": "text"},
    {"key": "price", "label": "Price", "type": "money"},
    {"key": "retail_price", "label": "Sticker price", "type": "money"}]'::jsonb,
  'authenticated')) as v(id, label, description, view_name, columns, audience)
where to_regclass('customer_app_views.sku_catalog') is not null
on conflict (id) do nothing;
