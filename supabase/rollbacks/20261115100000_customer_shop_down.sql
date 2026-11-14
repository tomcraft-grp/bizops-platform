-- Rolls back 20261115100000_customer_shop.sql.
-- Refuses to run once any online order exists: orders and their invoices are financial records and are never deleted.
-- It does NOT restore the old execute rights on finance_log / finance_require (a customer being able to forge audit rows was a bug).
do $guard$ begin
  if to_regclass('public.shop_orders') is not null and exists (select 1 from public.shop_orders) then
    raise exception 'Online orders exist: they are financial records and cannot be rolled back. Close the shop instead (Online shop > Settings).';
  end if;
end $guard$;

-- layout validator: back to the live definition from before the cart page
CREATE OR REPLACE FUNCTION public.customer_app_validate(p_config jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
end $function$;

-- DEV APP data source and its view: back to the pre-shop definition
drop view if exists customer_app_views.sku_catalog;
create view customer_app_views.sku_catalog with (security_barrier = true) as
  select s.sku_code, s.name_full, s.name_th, s.name_en, s.brand, s.product_type,
         coalesce(s.unit_th, s.unit_en) as unit,
         coalesce(s.selling_price, s.retail_price) as price,
         s.retail_price
  from public.sku_registry s
  where s.status = 'active' and coalesce(s.selling_price, s.retail_price) is not null;
revoke all on customer_app_views.sku_catalog from public, anon, authenticated;
update public.customer_app_data_sources set
  description = 'Active SKUs from the central SKU master: code, names, brand, type, unit and price. Cost, friend and wholesale prices are never included.',
  columns = '[{"key": "sku_code", "label": "SKU code", "type": "text"},
    {"key": "name_full", "label": "Product name", "type": "text"},
    {"key": "name_th", "label": "Name (Thai)", "type": "text"},
    {"key": "name_en", "label": "Name (English)", "type": "text"},
    {"key": "brand", "label": "Brand", "type": "text"},
    {"key": "product_type", "label": "Product type", "type": "text"},
    {"key": "unit", "label": "Unit", "type": "text"},
    {"key": "price", "label": "Price", "type": "money"},
    {"key": "retail_price", "label": "Sticker price", "type": "money"}]'::jsonb,
  updated_at = now()
where id = 'db:sku_catalog';

-- finance: original function bodies
create or replace function public.finance_invoice_state(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare inv public.finance_invoices; paid numeric; outstanding numeric; review boolean; pending integer; req public.finance_payment_requests;
        last_ev public.finance_payment_evidence; code integer; credit numeric;
begin
  select * into inv from public.finance_invoices where id = p_invoice;
  if not found then return null; end if;
  -- callable by clients: only the invoice's own customer or finance staff
  if inv.customer_id is distinct from public.finance_my_customer() and not public.finance_can('view') then return null; end if;
  select coalesce(sum(a.amount), 0) into paid from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id
    where a.invoice_id = p_invoice and a.active and r.status = 'posted';
  outstanding := inv.amount - paid;
  select exists (select 1 from public.finance_receipts where invoice_id = p_invoice and status = 'posted' and needs_review) into review;
  select coalesce(sum(r.amount - coalesce((select sum(a.amount) from public.finance_allocations a where a.receipt_id = r.id and a.active), 0)), 0) into credit
    from public.finance_receipts r where r.invoice_id = p_invoice and r.status = 'posted';
  select count(*) into pending from public.finance_payment_evidence where invoice_id = p_invoice and status = 'submitted';
  select * into req from public.finance_payment_requests where invoice_id = p_invoice and status = 'awaiting' order by created_at desc limit 1;
  select * into last_ev from public.finance_payment_evidence where invoice_id = p_invoice order by created_at desc limit 1;
  code := case
    when inv.status = 'cancelled' then 8
    when review then 6
    when outstanding <= 0 then 5
    when pending > 0 then 3
    when paid > 0 then 4
    when last_ev.id is not null and last_ev.status = 'rejected' and (req.id is null or req.created_at < last_ev.reviewed_at) then 7
    when req.id is not null and req.expires_at > now() then 1
    when req.id is not null then 9
    else 0 end;
  return jsonb_build_object('invoice_id', inv.id, 'amount', inv.amount, 'paid', paid, 'outstanding', greatest(outstanding, 0),
    'unapplied', credit, 'status_code', code,
    'status', (array['unpaid', 'awaiting_payment', 'payment_submitted', 'pending_verification', 'partially_paid', 'fully_paid', 'overpaid', 'rejected', 'cancelled', 'expired'])[code + 1],
    'pending_evidence', pending,
    'request', case when req.id is null then null else jsonb_build_object('ref', req.ref, 'amount', req.amount, 'qr_payload', req.qr_payload, 'expires_at', req.expires_at, 'expired', req.expires_at <= now()) end);
end $$;
create or replace function public.finance_my_invoices()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'issue_date', i.issue_date, 'due_date', i.due_date,
      'description', i.description, 'customer_name', c.name) || public.finance_invoice_state(i.id) order by i.issue_date desc, i.invoice_no desc), '[]'::jsonb)
  from public.finance_invoices i join public.finance_customers c on c.id = i.customer_id
  where i.customer_id = public.finance_my_customer()
$$;
drop function if exists public.finance_invoice_state_raw(uuid);

-- shop objects (functions first, then tables)
drop policy if exists "shop products: staff upload" on storage.objects;
drop policy if exists "shop products: staff read" on storage.objects;
drop policy if exists "shop products: staff replace" on storage.objects;
do $drop$ declare r record; begin
  for r in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'shop\_%' loop
    execute 'drop function if exists ' || r.sig || ' cascade';   -- (cascade may already have removed a later one: "if exists" makes that fine)
  end loop;
end $drop$;
drop view if exists public.shop_sellable;
drop table if exists public.shop_events, public.shop_order_items, public.shop_orders, public.shop_sku_content, public.shop_categories, public.shop_settings;
drop sequence if exists public.shop_order_seq;
drop function if exists public.shop_category_of(text, text);
drop function if exists public.shop_price_of(numeric, numeric, numeric);
-- the product-picture bucket is left in place on purpose (deleting a bucket needs it to be empty; remove it in the dashboard if wanted)
