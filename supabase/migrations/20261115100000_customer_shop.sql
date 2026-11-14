-- Customer shop (server-authoritative): storefront catalogue, categories, product content, central orders and the
-- link from an order to the finance ledger (invoice -> Thai QR -> slip -> staff verification -> receipt).
--
-- Principles
--   * Additive and backward compatible: new tables and functions only. Existing data is never touched. The only changes to
--     existing objects are (1) the customer-app catalogue view gains columns and a stricter "customer-facing" rule,
--     (2) finance_invoice_state is split into a gated wrapper + an internal body (same output), (3) the DEV APP layout
--     validator accepts the new "cart" page, (4) internal finance helpers are no longer callable by customers.
--   * The database decides everything that matters: which SKU is sellable, its price, the totals, the shipping fee, the order
--     number, the invoice amount and the payment status. The app only sends "sku + quantity" and contact details.
--   * Payment is NOT reinvented: an order owns exactly one finance invoice. The customer pays it with the existing
--     finance_request_payment (QR for the exact outstanding amount) and finance_submit_evidence (slip); only staff
--     verification (finance_verify_evidence) records a receipt. Uploading a slip never marks anything paid.
--   * Clients have SELECT (RLS: own orders, or staff) and nothing else. Every write goes through the SECURITY DEFINER
--     functions below. Order and audit rows are never deleted; amounts and ownership cannot be edited in place.
--   * There is no central stock ledger (inventory lives only in the staff browser), so stock is an availability flag
--     (sold out) plus an optional per-order limit, set by staff. Quantities on hand are NOT validated.
--
-- Customer-facing SKU rule (one definition, used by the catalogue, the quote, the order and the DEV APP data source):
--   sku_registry.status = 'active' AND sku_category = 'FG' (finished goods; never raw materials / WIP)
--   AND a price > 0 AND not hidden by staff (shop_sku_content.visible) AND its category is not hidden.
--   price = ecommerce_price, else selling_price, else retail_price.

-- ---------------------------------------------------------------------------------------------- audit-log hardening
-- finance_log / finance_require are internal helpers (called only from the SECURITY DEFINER functions, which run as the
-- owner). They were executable by every signed-in user, so a customer could write forged rows into finance_events.
revoke execute on function public.finance_log(text, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.finance_require(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------- helpers
create or replace function public.shop_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role in ('ADMIN', 'SUPER_ADMIN'))
$$;

create or replace function public.shop_require_staff(p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.shop_is_staff() then raise exception 'You are not allowed to %', p_what using errcode = '42501'; end if;
end $$;

create or replace function public.shop_require_user()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = v and status = 'active') then raise exception 'This account is not active' using errcode = '42501'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------- finance: one ledger function
-- finance_invoice_state keeps its exact output and its access check; the body moves to an internal function so that the
-- shop (which has already checked who may see an order) reads payment status from the SAME ledger logic.
create or replace function public.finance_invoice_state_raw(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare inv public.finance_invoices; paid numeric; outstanding numeric; review boolean; pending integer; req public.finance_payment_requests;
        last_ev public.finance_payment_evidence; code integer; credit numeric;
begin
  select * into inv from public.finance_invoices where id = p_invoice;
  if not found then return null; end if;
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

create or replace function public.finance_invoice_state(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare inv public.finance_invoices;
begin
  select * into inv from public.finance_invoices where id = p_invoice;
  if not found then return null; end if;
  -- callable by clients: only the invoice's own customer or finance staff
  if inv.customer_id is distinct from public.finance_my_customer() and not public.finance_can('view') then return null; end if;
  return public.finance_invoice_state_raw(p_invoice);
end $$;
revoke execute on function public.finance_invoice_state_raw(uuid) from public, anon, authenticated;

-- The customer's own invoice list also says which order (or other document) an invoice bills, so the shop can show its own
-- invoices with the order and leave the rest in the generic list. Same function, one more key.
create or replace function public.finance_my_invoices()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'issue_date', i.issue_date, 'due_date', i.due_date,
      'description', i.description, 'customer_name', c.name, 'source_ref', i.source_ref) || public.finance_invoice_state(i.id) order by i.issue_date desc, i.invoice_no desc), '[]'::jsonb)
  from public.finance_invoices i join public.finance_customers c on c.id = i.customer_id
  where i.customer_id = public.finance_my_customer()
$$;

-- ---------------------------------------------------------------------------------------------- configuration tables
create table if not exists public.shop_settings (
  id boolean primary key default true check (id),                       -- a single row
  shop_open boolean not null default false,                             -- staff switch: no orders until staff have reviewed the settings
  closed_message text check (closed_message is null or length(closed_message) <= 200),
  delivery_enabled boolean not null default true,
  pickup_enabled boolean not null default false,
  pickup_note text check (pickup_note is null or length(pickup_note) <= 200),
  shipping_fee numeric(10, 2) not null default 0 check (shipping_fee >= 0),
  free_shipping_min numeric(10, 2) check (free_shipping_min is null or free_shipping_min > 0),
  image_base_url text not null default 'https://hlvravynjalculvplrxc.supabase.co/storage/v1/object/public/shop-products/',
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.shop_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.shop_categories (
  code text primary key check (length(code) between 1 and 60),         -- = the category as derived from sku_registry (product_type)
  name_th text check (name_th is null or length(name_th) <= 60),
  name_en text check (name_en is null or length(name_en) <= 60),
  image_path text,
  sort_order integer not null default 100,
  visible boolean not null default true,
  updated_by uuid, updated_at timestamptz not null default now()
);

create table if not exists public.shop_sku_content (
  sku_code text primary key references public.sku_registry (sku_code) on update cascade on delete restrict,
  description_th text check (description_th is null or length(description_th) <= 2000),
  description_en text check (description_en is null or length(description_en) <= 2000),
  image_paths text[] not null default '{}' check (cardinality(image_paths) <= 6),
  specs jsonb not null default '[]'::jsonb check (jsonb_typeof(specs) = 'array' and jsonb_array_length(specs) <= 12),
  family text check (family is null or length(family) between 1 and 80),   -- SKUs of one family show each other as options on the product page
  badge text check (badge is null or length(badge) <= 30),
  featured boolean not null default false,
  visible boolean not null default true,                                   -- false: hidden from customers
  available boolean not null default true,                                 -- false: shown as sold out, cannot be ordered
  max_qty integer check (max_qty is null or max_qty between 1 and 99),     -- per order
  sort_order integer not null default 100,
  updated_by uuid, updated_at timestamptz not null default now()
);
create index if not exists shop_sku_content_family_idx on public.shop_sku_content (family) where family is not null;

-- ---------------------------------------------------------------------------------------------- orders
create sequence if not exists public.shop_order_seq;

create table if not exists public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  request_hash text not null,
  channel text not null default 'LINE',
  -- same vocabulary as the back-office order statuses (domain/meta.ts OrderStatus)
  status text not null default 'new' check (status in ('new', 'confirmed', 'preparing', 'packed', 'ready', 'shipped', 'completed', 'cancelled', 'returned')),
  fulfilment text not null check (fulfilment in ('delivery', 'pickup')),
  contact_name text not null check (length(contact_name) between 1 and 100),
  contact_phone text not null check (contact_phone ~ '^0[0-9]{8,9}$'),
  delivery_address text check (delivery_address is null or length(delivery_address) between 10 and 400),
  note text check (note is null or length(note) <= 300),
  subtotal numeric(14, 2) not null check (subtotal > 0),
  discount numeric(14, 2) not null default 0 check (discount >= 0),
  shipping_fee numeric(14, 2) not null default 0 check (shipping_fee >= 0),
  total numeric(14, 2) not null check (total > 0),
  invoice_id uuid not null unique references public.finance_invoices (id) on delete restrict,
  status_note text,
  cancelled_by uuid, cancelled_at timestamptz, cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, idempotency_key),
  check (total = subtotal - discount + shipping_fee),
  check ((fulfilment = 'delivery') = (delivery_address is not null))
);
create index if not exists shop_orders_profile_idx on public.shop_orders (profile_id, created_at desc);
create index if not exists shop_orders_status_idx on public.shop_orders (status, created_at desc);

create table if not exists public.shop_order_items (
  order_id uuid not null references public.shop_orders (id) on delete restrict,
  line_no integer not null check (line_no > 0),
  sku_code text not null references public.sku_registry (sku_code) on update cascade on delete restrict,
  name text not null,
  unit text,
  unit_price numeric(14, 2) not null check (unit_price > 0),
  qty integer not null check (qty between 1 and 99),
  line_total numeric(14, 2) not null check (line_total = unit_price * qty),
  primary key (order_id, line_no)
);
create index if not exists shop_order_items_sku_idx on public.shop_order_items (sku_code);

create table if not exists public.shop_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  actor_email text,
  entity text not null,
  entity_id text not null,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists shop_events_entity_idx on public.shop_events (entity, entity_id, at);

-- Order identity and amounts are fixed once written; only the fulfilment status fields move.
create or replace function public.shop_guard_order()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.order_no is distinct from old.order_no or new.profile_id is distinct from old.profile_id or new.customer_id is distinct from old.customer_id
     or new.invoice_id is distinct from old.invoice_id or new.subtotal is distinct from old.subtotal or new.discount is distinct from old.discount
     or new.shipping_fee is distinct from old.shipping_fee or new.total is distinct from old.total or new.fulfilment is distinct from old.fulfilment
     or new.idempotency_key is distinct from old.idempotency_key or new.request_hash is distinct from old.request_hash then
    raise exception 'An order''s number, customer and amounts cannot be changed (cancel it and place a new one)'; end if;
  return new;
end $$;
drop trigger if exists shop_orders_guard on public.shop_orders;
create trigger shop_orders_guard before update on public.shop_orders for each row execute function public.shop_guard_order();

create or replace function public.shop_no_change()
returns trigger language plpgsql as $$ begin raise exception 'Shop order records are never deleted or edited in place'; end $$;
do $$ declare t text; begin
  foreach t in array array['shop_orders', 'shop_order_items', 'shop_events'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_delete', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.shop_no_change()', t || '_no_delete', t);
  end loop;
  execute 'drop trigger if exists shop_order_items_no_update on public.shop_order_items';
  execute 'create trigger shop_order_items_no_update before update on public.shop_order_items for each row execute function public.shop_no_change()';
  execute 'drop trigger if exists shop_events_no_update on public.shop_events';
  execute 'create trigger shop_events_no_update before update on public.shop_events for each row execute function public.shop_no_change()';
end $$;

create or replace function public.shop_log(p_entity text, p_id text, p_action text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.shop_events (entity, entity_id, action, detail, actor_email)
  values (p_entity, p_id, p_action, coalesce(p_detail, '{}'::jsonb), (select email from public.profiles where id = auth.uid()))
$$;

-- ---------------------------------------------------------------------------------------------- the customer-facing SKU rule
create or replace function public.shop_category_of(p_product_type text, p_domain text)
returns text language sql immutable set search_path = public as $$
  select coalesce(nullif(btrim(p_product_type), ''), nullif(btrim(regexp_replace(coalesce(p_domain, ''), '\s*\(.*\)\s*$', '')), ''), 'Other')
$$;

create or replace function public.shop_price_of(p_ecommerce numeric, p_selling numeric, p_retail numeric)
returns numeric language sql immutable as $$
  select coalesce(nullif(p_ecommerce, 0), nullif(p_selling, 0), nullif(p_retail, 0))
$$;

create or replace function public.shop_image_url(p_path text)
returns text language sql stable security definer set search_path = public as $$
  select case when p_path is null or p_path = '' then null else (select image_base_url from public.shop_settings where id) || p_path end
$$;

-- Internal view (not readable by clients): every SKU a customer may see, with its storefront content.
create or replace view public.shop_sellable with (security_barrier = true) as
select s.sku_code,
       btrim(regexp_replace(s.name_full, '^[0-9]+\s+', '')) as name_full,       -- the source sheets prefix a row number
       s.name_th, s.name_en, s.brand, s.product_type, s.retail_price,
       public.shop_category_of(s.product_type, s.domain) as category,
       coalesce(s.unit_th, s.unit_en) as unit,
       s.pack_qty,
       public.shop_price_of(s.ecommerce_price, s.selling_price, s.retail_price) as price,
       s.sku_seq, s.barcode,
       c.description_th, c.description_en,
       coalesce(c.specs, '[]'::jsonb) as specs,
       c.family, c.badge,
       coalesce(c.featured, false) as featured,
       coalesce(c.available, true) as available,
       c.max_qty,
       coalesce(c.sort_order, 100) as sort_order,
       coalesce((select array_agg(public.shop_image_url(p) order by o) from unnest(c.image_paths) with ordinality as t(p, o)), '{}'::text[]) as image_urls
from public.sku_registry s
left join public.shop_sku_content c on c.sku_code = s.sku_code
left join public.shop_categories g on g.code = public.shop_category_of(s.product_type, s.domain)
where s.status = 'active' and s.sku_category = 'FG'
  and public.shop_price_of(s.ecommerce_price, s.selling_price, s.retail_price) > 0
  and coalesce(c.visible, true) and coalesce(g.visible, true);
revoke all on public.shop_sellable from public, anon, authenticated;

create or replace function public.shop_item_json(v public.shop_sellable)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'sku_code', v.sku_code, 'name', v.name_full, 'name_th', v.name_th, 'name_en', v.name_en, 'brand', v.brand,
    'category', v.category, 'unit', v.unit, 'pack_qty', v.pack_qty, 'price', v.price, 'barcode', v.barcode,
    'description_th', v.description_th, 'description_en', v.description_en, 'specs', v.specs, 'family', v.family, 'badge', v.badge,
    'featured', v.featured, 'available', v.available, 'max_qty', v.max_qty,
    'image_url', v.image_urls[1], 'image_urls', to_jsonb(v.image_urls))
$$;

-- DEV APP Customer data source: same rule, plus images, description, category and availability.
drop view if exists customer_app_views.sku_catalog;
create view customer_app_views.sku_catalog with (security_barrier = true) as
select v.sku_code, v.name_full, v.name_th, v.name_en, v.brand, v.product_type, v.unit, v.price, v.retail_price,
       v.category, coalesce(v.description_th, v.description_en) as description, v.image_urls[1] as image_url,
       v.available, v.featured, v.badge
from public.shop_sellable v;
revoke all on customer_app_views.sku_catalog from public, anon, authenticated;

update public.customer_app_data_sources set
  description = 'Customer-facing SKUs (active finished goods with a price that staff have not hidden): code, names, brand, category, price, picture, description and availability. Cost, friend and wholesale prices are never included.',
  columns = '[{"key": "sku_code", "label": "SKU code", "type": "text"},
    {"key": "name_full", "label": "Product name", "type": "text"},
    {"key": "name_th", "label": "Name (Thai)", "type": "text"},
    {"key": "name_en", "label": "Name (English)", "type": "text"},
    {"key": "brand", "label": "Brand", "type": "text"},
    {"key": "product_type", "label": "Product type", "type": "text"},
    {"key": "unit", "label": "Unit", "type": "text"},
    {"key": "price", "label": "Price", "type": "money"},
    {"key": "retail_price", "label": "Sticker price", "type": "money"},
    {"key": "category", "label": "Category", "type": "text"},
    {"key": "description", "label": "Description", "type": "text"},
    {"key": "image_url", "label": "Picture", "type": "image"},
    {"key": "available", "label": "Available to order", "type": "boolean"},
    {"key": "featured", "label": "Featured", "type": "boolean"},
    {"key": "badge", "label": "Badge", "type": "text"}]'::jsonb,
  updated_at = now()
where id = 'db:sku_catalog';

-- ---------------------------------------------------------------------------------------------- customer: browse
create or replace function public.shop_settings_public()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.shop_settings;
begin
  perform public.shop_require_user();
  select * into s from public.shop_settings where id;
  return jsonb_build_object('shop_open', s.shop_open and exists (select 1 from public.finance_payment_accounts where is_default and active),
    'closed_message', s.closed_message, 'delivery_enabled', s.delivery_enabled, 'pickup_enabled', s.pickup_enabled, 'pickup_note', s.pickup_note,
    'shipping_fee', s.shipping_fee, 'free_shipping_min', s.free_shipping_min);
end $$;

create or replace function public.shop_facets()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_user();
  return jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('code', x.category, 'name_th', g.name_th, 'name_en', g.name_en, 'count', x.n,
        'image_url', coalesce(public.shop_image_url(g.image_path), x.img)) order by coalesce(g.sort_order, 100), x.category), '[]'::jsonb)
      from (select v.category, count(*) n, (array_agg(v.image_urls[1] order by v.featured desc, v.sku_seq) filter (where v.image_urls[1] is not null))[1] img
            from public.shop_sellable v group by v.category) x
      left join public.shop_categories g on g.code = x.category),
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('brand', b.brand, 'count', b.n) order by b.n desc, b.brand), '[]'::jsonb)
      from (select v.brand, count(*) n from public.shop_sellable v where v.brand is not null group by v.brand) b));
end $$;

create or replace function public.shop_catalog(p_search text default null, p_category text default null, p_brand text default null,
  p_sort text default 'recommended', p_limit integer default 24, p_offset integer default 0, p_featured boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare lim integer := least(greatest(coalesce(p_limit, 24), 1), 60); off integer := greatest(coalesce(p_offset, 0), 0);
        q text := nullif(btrim(coalesce(p_search, '')), ''); pat text; res jsonb;
begin
  perform public.shop_require_user();
  if q is not null then
    if length(q) > 80 then q := left(q, 80); end if;
    pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  with m as (
    select v.* from public.shop_sellable v
    where (q is null or v.sku_code ilike pat or v.name_full ilike pat or v.name_th ilike pat or v.name_en ilike pat or v.brand ilike pat or v.barcode ilike pat)
      and (nullif(p_category, '') is null or v.category = p_category)
      and (nullif(p_brand, '') is null or v.brand = p_brand)
      and (not coalesce(p_featured, false) or v.featured)),
  pg as (
    select * from m
    order by
      case when p_sort = 'price_asc' then price end asc,
      case when p_sort = 'price_desc' then price end desc,
      case when p_sort = 'newest' then sku_seq end desc,
      case when p_sort = 'name' then name_full end asc,
      case when coalesce(p_sort, 'recommended') = 'recommended' then featured end desc,
      available desc, sort_order, sku_seq
    limit lim offset off)
  select jsonb_build_object('total', (select count(*) from m),
    'items', coalesce((select jsonb_agg(public.shop_item_json(pg::public.shop_sellable)) from pg), '[]'::jsonb)) into res;
  return res;
end $$;

create or replace function public.shop_product(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v public.shop_sellable;
begin
  perform public.shop_require_user();
  select * into v from public.shop_sellable where sku_code = p_sku;
  if not found then return null; end if;
  return public.shop_item_json(v) || jsonb_build_object(
    'siblings', case when v.family is null then '[]'::jsonb else (select coalesce(jsonb_agg(public.shop_item_json(s) order by s.sort_order, s.sku_seq), '[]'::jsonb)
      from public.shop_sellable s where s.family = v.family and s.sku_code <> v.sku_code) end,
    'related', (select coalesce(jsonb_agg(public.shop_item_json(r)), '[]'::jsonb) from (
      select * from public.shop_sellable r where r.category = v.category and r.sku_code <> v.sku_code
      order by (r.brand is not distinct from v.brand) desc, r.featured desc, r.sku_seq limit 6) r));
end $$;

create or replace function public.shop_home()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_user();
  return jsonb_build_object(
    'featured', (select coalesce(jsonb_agg(public.shop_item_json(x)), '[]'::jsonb) from (select * from public.shop_sellable where featured order by sort_order, sku_seq limit 8) x),
    'newest', (select coalesce(jsonb_agg(public.shop_item_json(x)), '[]'::jsonb) from (select * from public.shop_sellable order by sku_seq desc limit 8) x),
    -- best sellers from real orders of the last 90 days (empty, and hidden by the app, until orders exist)
    'popular', (select coalesce(jsonb_agg(public.shop_item_json(s) order by p.qty desc), '[]'::jsonb) from (
      select i.sku_code, sum(i.qty) qty from public.shop_order_items i
        join public.shop_orders o on o.id = i.order_id and o.status <> 'cancelled' and o.created_at > now() - interval '90 days'
      group by i.sku_code order by sum(i.qty) desc limit 8) p
      join public.shop_sellable s on s.sku_code = p.sku_code));
end $$;

-- ---------------------------------------------------------------------------------------------- customer: quote and order
-- p_items: [{"sku_code": "FG-000001", "qty": 2}, ...]. Prices, availability, limits and shipping come from the database.
create or replace function public.shop_quote_internal(p_items jsonb, p_fulfilment text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.shop_settings; lines jsonb := '[]'::jsonb; problems jsonb := '[]'::jsonb; subtotal numeric := 0; ship numeric := 0;
        r record; v public.shop_sellable; n integer; fee_free boolean;
begin
  select * into s from public.shop_settings where id;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'CART_EMPTY'; end if;
  if jsonb_array_length(p_items) > 40 then raise exception 'CART_TOO_LARGE'; end if;
  for r in
    select e ->> 'sku_code' as sku, sum(case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::int else 0 end) as qty
    from jsonb_array_elements(p_items) e where jsonb_typeof(e) = 'object' group by e ->> 'sku_code' order by e ->> 'sku_code'
  loop
    select * into v from public.shop_sellable where sku_code = r.sku;
    if r.qty < 1 or r.qty > 99 then
      lines := lines || jsonb_build_object('sku_code', r.sku, 'qty', r.qty, 'ok', false, 'problem', 'bad_qty', 'name', v.name_full);
      problems := problems || jsonb_build_array(jsonb_build_object('sku_code', r.sku, 'problem', 'bad_qty'));
    elsif v.sku_code is null then
      lines := lines || jsonb_build_object('sku_code', r.sku, 'qty', r.qty, 'ok', false, 'problem', 'not_found');
      problems := problems || jsonb_build_array(jsonb_build_object('sku_code', r.sku, 'problem', 'not_found'));
    elsif not v.available then
      lines := lines || jsonb_build_object('sku_code', r.sku, 'qty', r.qty, 'ok', false, 'problem', 'sold_out', 'name', v.name_full, 'unit_price', v.price, 'image_url', v.image_urls[1]);
      problems := problems || jsonb_build_array(jsonb_build_object('sku_code', r.sku, 'problem', 'sold_out'));
    elsif v.max_qty is not null and r.qty > v.max_qty then
      lines := lines || jsonb_build_object('sku_code', r.sku, 'qty', r.qty, 'ok', false, 'problem', 'over_limit', 'max_qty', v.max_qty, 'name', v.name_full, 'unit_price', v.price, 'image_url', v.image_urls[1]);
      problems := problems || jsonb_build_array(jsonb_build_object('sku_code', r.sku, 'problem', 'over_limit', 'max_qty', v.max_qty));
    else
      subtotal := subtotal + v.price * r.qty;
      lines := lines || jsonb_build_object('sku_code', r.sku, 'qty', r.qty, 'ok', true, 'name', v.name_full, 'unit', v.unit, 'pack_qty', v.pack_qty,
        'unit_price', v.price, 'line_total', v.price * r.qty, 'max_qty', v.max_qty, 'image_url', v.image_urls[1]);
    end if;
  end loop;
  if p_fulfilment = 'delivery' then
    if not s.delivery_enabled then problems := problems || jsonb_build_array(jsonb_build_object('problem', 'delivery_off')); end if;
    fee_free := s.free_shipping_min is not null and subtotal >= s.free_shipping_min;
    ship := case when fee_free then 0 else s.shipping_fee end;
  elsif p_fulfilment = 'pickup' then
    if not s.pickup_enabled then problems := problems || jsonb_build_array(jsonb_build_object('problem', 'pickup_off')); end if;
  else
    problems := problems || jsonb_build_array(jsonb_build_object('problem', 'bad_fulfilment'));
  end if;
  return jsonb_build_object('lines', lines, 'subtotal', subtotal, 'discount', 0, 'shipping_fee', ship, 'total', subtotal + ship,
    'fulfilment', p_fulfilment, 'free_shipping_min', s.free_shipping_min, 'ok', jsonb_array_length(problems) = 0 and subtotal > 0, 'problems', problems);
end $$;

create or replace function public.shop_quote(p_items jsonb, p_fulfilment text default 'delivery')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_user();
  return public.shop_quote_internal(p_items, p_fulfilment);
end $$;

create or replace function public.shop_order_json(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; st jsonb;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  st := public.finance_invoice_state_raw(o.invoice_id);
  return jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'status', o.status, 'fulfilment', o.fulfilment, 'channel', o.channel,
    'contact_name', o.contact_name, 'contact_phone', o.contact_phone, 'delivery_address', o.delivery_address, 'note', o.note,
    'subtotal', o.subtotal, 'discount', o.discount, 'shipping_fee', o.shipping_fee, 'total', o.total,
    'created_at', o.created_at, 'updated_at', o.updated_at, 'status_note', o.status_note, 'cancel_reason', o.cancel_reason, 'cancelled_at', o.cancelled_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'sku_code', i.sku_code, 'name', i.name, 'unit', i.unit, 'unit_price', i.unit_price,
        'qty', i.qty, 'line_total', i.line_total,
        'image_url', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = i.sku_code)) order by i.line_no), '[]'::jsonb)
      from public.shop_order_items i where i.order_id = o.id),
    'invoice', (select jsonb_build_object('id', v.id, 'invoice_no', v.invoice_no, 'issue_date', v.issue_date, 'due_date', v.due_date,
        'description', v.description, 'customer_name', c.name) || coalesce(st, '{}'::jsonb)
      from public.finance_invoices v join public.finance_customers c on c.id = v.customer_id where v.id = o.invoice_id));
end $$;
revoke execute on function public.shop_order_json(uuid) from public, anon, authenticated;

create or replace function public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text,
  p_note text, p_expected_total numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; prof public.profiles; s public.shop_settings; q jsonb; norm jsonb; hash text; existing public.shop_orders;
        fin uuid; ono text; oid uuid := gen_random_uuid(); inv public.finance_invoices; phone text; nm text; addr text; nt text; n integer; ln integer := 0; l jsonb;
begin
  uid := public.shop_require_user();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_key, 0));    -- serialises retries of the same checkout

  select * into s from public.shop_settings where id;
  nm := btrim(coalesce(p_name, '')); phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  addr := nullif(btrim(coalesce(p_address, '')), ''); nt := nullif(btrim(coalesce(p_note, '')), '');
  select coalesce(jsonb_agg(jsonb_build_object('sku', k, 'qty', t) order by k), '[]'::jsonb) into norm from (
    select e ->> 'sku_code' k, sum(case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::int else 0 end) t
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e group by 1) z;
  hash := md5(jsonb_build_object('items', norm, 'f', p_fulfilment, 'n', nm, 'p', phone, 'a', addr, 'note', nt)::text);

  -- a retry of the same checkout returns the order it already created (never a second one)
  select * into existing from public.shop_orders where profile_id = uid and idempotency_key = p_key;
  if found then
    if existing.request_hash <> hash then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return jsonb_build_object('replay', true, 'order', public.shop_order_json(existing.id));
  end if;

  if not s.shop_open then raise exception 'SHOP_CLOSED'; end if;
  if not exists (select 1 from public.finance_payment_accounts where is_default and active) then raise exception 'NO_PAYMENT_ACCOUNT'; end if;
  if (select count(*) from public.shop_orders where profile_id = uid and created_at > now() - interval '1 hour') >= 10 then raise exception 'TOO_MANY_ORDERS'; end if;

  if length(nm) not between 1 and 100 then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if phone !~ '^0[0-9]{8,9}$' then raise exception 'INVALID_PHONE' using errcode = '22023'; end if;
  if p_fulfilment = 'delivery' and (addr is null or length(addr) < 10 or length(addr) > 400) then raise exception 'INVALID_ADDRESS' using errcode = '22023'; end if;
  if p_fulfilment = 'pickup' then addr := null; end if;
  if nt is not null and length(nt) > 300 then raise exception 'INVALID_NOTE' using errcode = '22023'; end if;

  q := public.shop_quote_internal(p_items, p_fulfilment);
  if not (q ->> 'ok')::boolean then raise exception 'CART_INVALID' using detail = (q -> 'problems')::text; end if;
  if p_expected_total is not null and p_expected_total <> (q ->> 'total')::numeric then
    raise exception 'PRICE_CHANGED' using detail = (q ->> 'total'); end if;

  select * into prof from public.profiles where id = uid;
  select id into fin from public.finance_customers where profile_id = uid;
  if fin is null then
    insert into public.finance_customers (code, name, profile_id, created_by)
      values ('LINE-' || upper(substr(replace(uid::text, '-', ''), 1, 10)), coalesce(nullif(btrim(prof.display_name), ''), nm), uid, uid)
      returning id into fin;
    perform public.shop_log('customer', fin::text, 'customer.create', jsonb_build_object('profile', uid));
  end if;

  ono := 'SO-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.shop_order_seq')::text, 5, '0');
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref, created_by)
    values ('INV-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_invoice_seq')::text, 5, '0'),
            fin, (now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date, (q ->> 'total')::numeric,
            'Online order ' || ono, ono, uid)
    returning * into inv;
  perform public.finance_log('invoice', inv.id, 'invoice.issue', jsonb_build_object('no', inv.invoice_no, 'amount', inv.amount, 'customer', fin, 'order', ono, 'source', 'shop'));

  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone,
      delivery_address, note, subtotal, discount, shipping_fee, total, invoice_id)
    values (oid, ono, uid, fin, p_key, hash, p_fulfilment, nm, phone, addr, nt, (q ->> 'subtotal')::numeric, (q ->> 'discount')::numeric,
            (q ->> 'shipping_fee')::numeric, (q ->> 'total')::numeric, inv.id);
  for l in select * from jsonb_array_elements(q -> 'lines') loop
    ln := ln + 1;
    insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total)
      values (oid, ln, l ->> 'sku_code', l ->> 'name', l ->> 'unit', (l ->> 'unit_price')::numeric, (l ->> 'qty')::int, (l ->> 'line_total')::numeric);
  end loop;
  perform public.shop_log('order', oid::text, 'order.place', jsonb_build_object('no', ono, 'total', q -> 'total', 'lines', ln, 'invoice', inv.invoice_no, 'fulfilment', p_fulfilment));
  return jsonb_build_object('replay', false, 'order', public.shop_order_json(oid));
end $$;

-- ---------------------------------------------------------------------------------------------- customer: my orders
-- p_filter: all | unpaid | to_ship | to_receive | done | cancelled   (the same chips the app shows)
create or replace function public.shop_my_orders(p_filter text default 'all', p_limit integer default 20, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid; lim integer := least(greatest(coalesce(p_limit, 20), 1), 50); off integer := greatest(coalesce(p_offset, 0), 0); res jsonb;
begin
  uid := public.shop_require_user();
  with mine as (
    select o.id, o.created_at, o.status, (public.finance_invoice_state_raw(o.invoice_id) ->> 'status_code')::int as pay
    from public.shop_orders o where o.profile_id = uid),
  f as (
    select m.*, count(*) over () as total from mine m
    where case coalesce(p_filter, 'all')
      when 'unpaid' then m.status <> 'cancelled' and m.pay in (0, 1, 3, 4, 7, 9)
      when 'to_ship' then m.status in ('new', 'confirmed', 'preparing', 'packed') and m.pay in (5, 6)
      when 'to_receive' then m.status in ('shipped', 'ready')
      when 'done' then m.status = 'completed'
      when 'cancelled' then m.status in ('cancelled', 'returned')
      else true end
    order by m.created_at desc limit lim offset off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0),
    'orders', coalesce(jsonb_agg(public.shop_order_json(f.id) order by f.created_at desc), '[]'::jsonb)) into res from f;
  return res;
end $$;

create or replace function public.shop_my_order(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid; o public.shop_orders;
begin
  uid := public.shop_require_user();
  select * into o from public.shop_orders where id = p_id and profile_id = uid;
  if not found then raise exception 'Order not found' using errcode = '42501'; end if;
  -- only the milestones: staff notes and override reasons in the audit detail are internal
  return public.shop_order_json(o.id) || jsonb_build_object('events', (
    select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'action', e.action, 'to', e.detail ->> 'to') order by e.at), '[]'::jsonb)
    from public.shop_events e where e.entity = 'order' and e.entity_id = o.id::text and e.action in ('order.place', 'order.status', 'order.cancel')));
end $$;

-- Cancel an order: customers only while it is new and nothing has been paid or submitted; staff with a reason.
create or replace function public.shop_cancel_order_internal(p_order uuid, p_reason text, p_by_customer boolean)
returns void language plpgsql security definer set search_path = public as $$
declare o public.shop_orders;
begin
  select * into o from public.shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('cancelled', 'completed', 'returned') then raise exception 'This order is already %', o.status; end if;
  if p_by_customer and o.status <> 'new' then raise exception 'ORDER_IN_PROGRESS'; end if;
  perform 1 from public.finance_invoices where id = o.invoice_id for update;          -- serialises with payment verification
  if exists (select 1 from public.finance_receipts where invoice_id = o.invoice_id and status = 'posted') then
    raise exception 'PAYMENT_RECORDED'; end if;
  if exists (select 1 from public.finance_payment_evidence where invoice_id = o.invoice_id and status = 'submitted') then
    raise exception 'SLIP_PENDING'; end if;
  update public.finance_invoices set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = 'Order cancelled: ' || left(p_reason, 200)
    where id = o.invoice_id and status = 'open';
  update public.finance_payment_requests set status = 'cancelled' where invoice_id = o.invoice_id and status = 'awaiting';
  update public.shop_orders set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(p_reason, 200), updated_at = now() where id = o.id;
  perform public.finance_log('invoice', o.invoice_id, 'invoice.cancel', jsonb_build_object('reason', left(p_reason, 200), 'order', o.order_no, 'source', 'shop'));
  perform public.shop_log('order', o.id::text, 'order.cancel', jsonb_build_object('by', case when p_by_customer then 'customer' else 'staff' end, 'reason', left(p_reason, 200)));
end $$;
revoke execute on function public.shop_cancel_order_internal(uuid, text, boolean) from public, anon, authenticated;

create or replace function public.shop_cancel_my_order(p_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  uid := public.shop_require_user();
  if not exists (select 1 from public.shop_orders where id = p_id and profile_id = uid) then raise exception 'Order not found' using errcode = '42501'; end if;
  perform public.shop_cancel_order_internal(p_id, coalesce(nullif(btrim(p_reason), ''), 'Cancelled by customer'), true);
  return public.shop_order_json(p_id);
end $$;

-- ---------------------------------------------------------------------------------------------- staff: orders
create or replace function public.shop_admin_orders(p_status text default null, p_search text default null, p_limit integer default 30, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare lim integer := least(greatest(coalesce(p_limit, 30), 1), 100); off integer := greatest(coalesce(p_offset, 0), 0);
        q text := nullif(btrim(coalesce(p_search, '')), ''); pat text; res jsonb;
begin
  perform public.shop_require_staff('see online orders');
  if q is not null then pat := '%' || replace(replace(replace(left(q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with f as (
    select o.id, o.created_at, count(*) over () as total from public.shop_orders o
    where (nullif(p_status, '') is null or o.status = p_status)
      and (q is null or o.order_no ilike pat or o.contact_name ilike pat or o.contact_phone ilike pat)
    order by o.created_at desc limit lim offset off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0),
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.shop_orders group by status) c),
    'orders', coalesce(jsonb_agg(public.shop_order_json(f.id) order by f.created_at desc), '[]'::jsonb)) into res from f;
  return res;
end $$;

create or replace function public.shop_admin_order(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders;
begin
  perform public.shop_require_staff('see online orders');
  select * into o from public.shop_orders where id = p_id;
  if not found then raise exception 'Order not found'; end if;
  return public.shop_order_json(o.id) || jsonb_build_object(
    'customer', (select jsonb_build_object('code', c.code, 'name', c.name, 'phone', p.phone, 'line_user_id', p.line_user_id)
      from public.finance_customers c left join public.profiles p on p.id = o.profile_id where c.id = o.customer_id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor_email', e.actor_email, 'action', e.action, 'detail', e.detail) order by e.at), '[]'::jsonb)
      from public.shop_events e where e.entity = 'order' and e.entity_id = o.id::text));
end $$;

-- Allowed moves. p_note is a message the customer can see (e.g. a tracking number). Everything after "confirmed" needs the
-- order to be paid; staff can continue without payment only by giving p_override_reason, which stays in the internal log.
create or replace function public.shop_admin_set_status(p_order uuid, p_status text, p_note text default null, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.shop_orders; st jsonb; code integer; ok boolean; overridden boolean := false;
        v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_why text := nullif(btrim(coalesce(p_override_reason, '')), '');
begin
  perform public.shop_require_staff('change an order');
  if p_status = 'cancelled' then
    if v_note is null then raise exception 'A reason is required'; end if;
    perform public.shop_cancel_order_internal(p_order, v_note, false);
    return public.shop_order_json(p_order);
  end if;
  select * into o from public.shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  ok := case o.status
    when 'new' then p_status = 'confirmed'
    when 'confirmed' then p_status = 'preparing'
    when 'preparing' then p_status = 'packed'
    when 'packed' then (p_status = 'shipped' and o.fulfilment = 'delivery') or (p_status = 'ready' and o.fulfilment = 'pickup')
    when 'ready' then p_status = 'completed'
    when 'shipped' then p_status in ('completed', 'returned')
    when 'completed' then p_status = 'returned'
    else false end;
  if not ok then raise exception 'An order that is % cannot become %', o.status, p_status; end if;
  if p_status = 'returned' and v_note is null then raise exception 'A reason is required'; end if;
  if p_status <> 'confirmed' and p_status <> 'returned' then
    st := public.finance_invoice_state_raw(o.invoice_id);
    code := (st ->> 'status_code')::int;
    if code not in (5, 6) then
      if v_why is null then raise exception 'PAYMENT_REQUIRED'; end if;
      overridden := true;
    end if;
  end if;
  update public.shop_orders set status = p_status, status_note = coalesce(v_note, status_note), updated_at = now() where id = o.id;
  perform public.shop_log('order', o.id::text, 'order.status', jsonb_build_object('from', o.status, 'to', p_status, 'note', v_note,
    'payment_override', overridden, 'override_reason', case when overridden then v_why end));
  return public.shop_order_json(o.id);
end $$;

-- ---------------------------------------------------------------------------------------------- staff: storefront content
create or replace function public.shop_admin_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.shop_settings;
begin
  perform public.shop_require_staff('see the shop settings');
  select * into s from public.shop_settings where id;
  return to_jsonb(s) - 'id' - 'updated_by' || jsonb_build_object(
    'payment_account_ready', exists (select 1 from public.finance_payment_accounts where is_default and active),
    'visible_products', (select count(*) from public.shop_sellable),
    'products_with_image', (select count(*) from public.shop_sellable where cardinality(image_urls) > 0));
end $$;

create or replace function public.shop_admin_save_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cur public.shop_settings; fee numeric; fmin numeric;
begin
  perform public.shop_require_staff('change the shop settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Nothing to save'; end if;
  select * into cur from public.shop_settings where id for update;
  fee := case when p_patch ? 'shipping_fee' then (p_patch ->> 'shipping_fee')::numeric else cur.shipping_fee end;
  fmin := case when p_patch ? 'free_shipping_min' then nullif(p_patch ->> 'free_shipping_min', '')::numeric else cur.free_shipping_min end;
  if fee < 0 or fee <> round(fee, 2) then raise exception 'The shipping fee must be an amount in baht'; end if;
  if fmin is not null and (fmin <= 0 or fmin <> round(fmin, 2)) then raise exception 'The free-shipping amount must be a positive amount'; end if;
  update public.shop_settings set
    shop_open = case when p_patch ? 'shop_open' then (p_patch ->> 'shop_open')::boolean else shop_open end,
    closed_message = case when p_patch ? 'closed_message' then nullif(btrim(p_patch ->> 'closed_message'), '') else closed_message end,
    delivery_enabled = case when p_patch ? 'delivery_enabled' then (p_patch ->> 'delivery_enabled')::boolean else delivery_enabled end,
    pickup_enabled = case when p_patch ? 'pickup_enabled' then (p_patch ->> 'pickup_enabled')::boolean else pickup_enabled end,
    pickup_note = case when p_patch ? 'pickup_note' then nullif(btrim(p_patch ->> 'pickup_note'), '') else pickup_note end,
    shipping_fee = fee, free_shipping_min = fmin, updated_by = auth.uid(), updated_at = now()
  where id;
  perform public.shop_log('settings', 'shop', 'settings.save', p_patch);
  return public.shop_admin_settings();
end $$;

create or replace function public.shop_admin_categories()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_staff('see the categories');
  return (select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'count', x.n, 'name_th', g.name_th, 'name_en', g.name_en,
      'image_path', g.image_path, 'image_url', public.shop_image_url(g.image_path), 'sort_order', coalesce(g.sort_order, 100), 'visible', coalesce(g.visible, true))
      order by coalesce(g.sort_order, 100), x.code), '[]'::jsonb)
    from (select public.shop_category_of(s.product_type, s.domain) code, count(*) n from public.sku_registry s
          where s.status = 'active' and s.sku_category = 'FG' group by 1) x
    left join public.shop_categories g on g.code = x.code);
end $$;

create or replace function public.shop_admin_save_category(p_code text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare ip text;
begin
  perform public.shop_require_staff('change a category');
  if p_code is null or length(btrim(p_code)) not between 1 and 60 then raise exception 'Unknown category'; end if;
  ip := nullif(btrim(p_patch ->> 'image_path'), '');
  if ip is not null and ip !~ '^categories/[A-Za-z0-9._-]{1,80}\.(webp|jpg|jpeg|png)$' then raise exception 'Invalid picture'; end if;
  insert into public.shop_categories (code) values (p_code) on conflict (code) do nothing;
  update public.shop_categories set
    name_th = case when p_patch ? 'name_th' then nullif(btrim(p_patch ->> 'name_th'), '') else name_th end,
    name_en = case when p_patch ? 'name_en' then nullif(btrim(p_patch ->> 'name_en'), '') else name_en end,
    image_path = case when p_patch ? 'image_path' then ip else image_path end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::int else sort_order end,
    visible = case when p_patch ? 'visible' then (p_patch ->> 'visible')::boolean else visible end,
    updated_by = auth.uid(), updated_at = now()
  where code = p_code;
  perform public.shop_log('category', p_code, 'category.save', p_patch);
end $$;

-- All finished-goods SKUs (any status) with what customers see. p_filter: all | visible | hidden | no_image
create or replace function public.shop_admin_products(p_search text default null, p_filter text default 'all', p_limit integer default 40, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare lim integer := least(greatest(coalesce(p_limit, 40), 1), 100); off integer := greatest(coalesce(p_offset, 0), 0);
        q text := nullif(btrim(coalesce(p_search, '')), ''); pat text; res jsonb;
begin
  perform public.shop_require_staff('manage the shop products');
  if q is not null then pat := '%' || replace(replace(replace(left(q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with base as (
    select s.sku_code, btrim(regexp_replace(s.name_full, '^[0-9]+\s+', '')) as name, s.brand, s.status,
           public.shop_category_of(s.product_type, s.domain) as category,
           public.shop_price_of(s.ecommerce_price, s.selling_price, s.retail_price) as price,
           c.description_th, c.description_en, coalesce(c.image_paths, '{}') as image_paths, coalesce(c.specs, '[]'::jsonb) as specs,
           c.family, c.badge, coalesce(c.featured, false) as featured, coalesce(c.visible, true) as visible, coalesce(c.available, true) as available,
           c.max_qty, coalesce(c.sort_order, 100) as sort_order,
           exists (select 1 from public.shop_sellable v where v.sku_code = s.sku_code) as on_sale
    from public.sku_registry s left join public.shop_sku_content c on c.sku_code = s.sku_code
    where s.sku_category = 'FG'
      and (q is null or s.sku_code ilike pat or s.name_full ilike pat or s.name_th ilike pat or s.name_en ilike pat or s.brand ilike pat)),
  f as (
    select b.*, count(*) over () as total from base b
    where case coalesce(p_filter, 'all') when 'visible' then b.on_sale when 'hidden' then not b.on_sale when 'no_image' then b.on_sale and cardinality(b.image_paths) = 0 else true end
    order by b.sku_code limit lim offset off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0),
    'items', coalesce(jsonb_agg(to_jsonb(f) - 'total' || jsonb_build_object('image_urls', (select coalesce(jsonb_agg(public.shop_image_url(p)), '[]'::jsonb) from unnest(f.image_paths) p),
      'why_hidden', case when f.on_sale then null when f.status <> 'active' then 'inactive' when f.price is null then 'no_price' when not f.visible then 'hidden_by_staff' else 'category_hidden' end) order by f.sku_code), '[]'::jsonb)) into res from f;
  return res;
end $$;

create or replace function public.shop_admin_save_content(p_sku text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare imgs text[]; sp jsonb; e jsonb; fam text;
begin
  perform public.shop_require_staff('change a product');
  if not exists (select 1 from public.sku_registry where sku_code = p_sku and sku_category = 'FG') then raise exception 'Unknown product'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Nothing to save'; end if;
  if p_patch ? 'image_paths' then
    select coalesce(array_agg(x), '{}') into imgs from jsonb_array_elements_text(p_patch -> 'image_paths') x;
    if cardinality(imgs) > 6 then raise exception 'At most 6 pictures'; end if;
    if exists (select 1 from unnest(imgs) p where p !~ ('^' || p_sku || '/[A-Za-z0-9._-]{1,80}\.(webp|jpg|jpeg|png)$')) then raise exception 'Invalid picture'; end if;
  end if;
  if p_patch ? 'specs' then
    sp := p_patch -> 'specs';
    if jsonb_typeof(sp) <> 'array' or jsonb_array_length(sp) > 12 then raise exception 'At most 12 specifications'; end if;
    for e in select * from jsonb_array_elements(sp) loop
      if jsonb_typeof(e) <> 'object' or length(coalesce(e ->> 'label', '')) not between 1 and 40 or length(coalesce(e ->> 'value', '')) not between 1 and 120 then
        raise exception 'Each specification needs a label (max 40) and a value (max 120)'; end if;
    end loop;
    sp := (select coalesce(jsonb_agg(jsonb_build_object('label', btrim(x ->> 'label'), 'value', btrim(x ->> 'value'))), '[]'::jsonb) from jsonb_array_elements(sp) x);
  end if;
  fam := case when p_patch ? 'family' then nullif(btrim(p_patch ->> 'family'), '') else null end;
  insert into public.shop_sku_content (sku_code) values (p_sku) on conflict (sku_code) do nothing;
  update public.shop_sku_content set
    description_th = case when p_patch ? 'description_th' then nullif(btrim(p_patch ->> 'description_th'), '') else description_th end,
    description_en = case when p_patch ? 'description_en' then nullif(btrim(p_patch ->> 'description_en'), '') else description_en end,
    image_paths = case when p_patch ? 'image_paths' then imgs else image_paths end,
    specs = case when p_patch ? 'specs' then sp else specs end,
    family = case when p_patch ? 'family' then fam else family end,
    badge = case when p_patch ? 'badge' then nullif(btrim(p_patch ->> 'badge'), '') else badge end,
    featured = case when p_patch ? 'featured' then (p_patch ->> 'featured')::boolean else featured end,
    visible = case when p_patch ? 'visible' then (p_patch ->> 'visible')::boolean else visible end,
    available = case when p_patch ? 'available' then (p_patch ->> 'available')::boolean else available end,
    max_qty = case when p_patch ? 'max_qty' then nullif(p_patch ->> 'max_qty', '')::int else max_qty end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::int else sort_order end,
    updated_by = auth.uid(), updated_at = now()
  where sku_code = p_sku;
  perform public.shop_log('product', p_sku, 'product.save', p_patch);
end $$;

-- ---------------------------------------------------------------------------------------------- DEV APP: the "cart" page
-- Same validator as before (copied from the live definition), with the cart page added to the pages that own a core block.
do $$
declare def text := pg_get_functiondef('public.customer_app_validate(jsonb)'::regprocedure);
begin
  if position('"cart": "cartCore"' in def) = 0 then
    def := replace(def, '"profile": "profileCore"}', '"profile": "profileCore", "cart": "cartCore"}');
    if position('"cart": "cartCore"' in def) = 0 then raise exception 'customer_app_validate has an unexpected shape: cart page not added'; end if;
    execute def;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------- product pictures (public bucket)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-products', 'shop-products', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "shop products: staff upload" on storage.objects;
create policy "shop products: staff upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-products' and public.shop_is_staff());
drop policy if exists "shop products: staff read" on storage.objects;
create policy "shop products: staff read" on storage.objects for select to authenticated
  using (bucket_id = 'shop-products' and public.shop_is_staff());
drop policy if exists "shop products: staff replace" on storage.objects;
create policy "shop products: staff replace" on storage.objects for update to authenticated
  using (bucket_id = 'shop-products' and public.shop_is_staff()) with check (bucket_id = 'shop-products' and public.shop_is_staff());

-- ---------------------------------------------------------------------------------------------- RLS and grants
alter table public.shop_settings enable row level security;
alter table public.shop_categories enable row level security;
alter table public.shop_sku_content enable row level security;
alter table public.shop_orders enable row level security;
alter table public.shop_order_items enable row level security;
alter table public.shop_events enable row level security;

drop policy if exists "shop settings: staff" on public.shop_settings;
create policy "shop settings: staff" on public.shop_settings for select to authenticated using (public.shop_is_staff());
drop policy if exists "shop categories: staff" on public.shop_categories;
create policy "shop categories: staff" on public.shop_categories for select to authenticated using (public.shop_is_staff());
drop policy if exists "shop content: staff" on public.shop_sku_content;
create policy "shop content: staff" on public.shop_sku_content for select to authenticated using (public.shop_is_staff());
drop policy if exists "shop orders: own or staff" on public.shop_orders;
create policy "shop orders: own or staff" on public.shop_orders for select to authenticated using (profile_id = auth.uid() or public.shop_is_staff());
drop policy if exists "shop items: own or staff" on public.shop_order_items;
create policy "shop items: own or staff" on public.shop_order_items for select to authenticated
  using (exists (select 1 from public.shop_orders o where o.id = order_id and (o.profile_id = auth.uid() or public.shop_is_staff())));
drop policy if exists "shop events: staff" on public.shop_events;
create policy "shop events: staff" on public.shop_events for select to authenticated using (public.shop_is_staff());

do $$ declare t text; begin
  foreach t in array array['shop_settings', 'shop_categories', 'shop_sku_content', 'shop_orders', 'shop_order_items', 'shop_events'] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;
revoke all on sequence public.shop_order_seq from anon, authenticated;

-- Functions: nothing for anon. Internal ones are not callable by clients at all; the client API is granted to authenticated.
do $$ declare f text; begin
  foreach f in array array[
    'shop_require_staff(text)', 'shop_require_user()', 'shop_guard_order()', 'shop_no_change()', 'shop_log(text, text, text, jsonb)',
    'shop_category_of(text, text)', 'shop_price_of(numeric, numeric, numeric)', 'shop_image_url(text)', 'shop_item_json(public.shop_sellable)',
    'shop_quote_internal(jsonb, text)', 'shop_order_json(uuid)', 'shop_cancel_order_internal(uuid, text, boolean)', 'finance_invoice_state_raw(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'shop_is_staff()', 'shop_settings_public()', 'shop_facets()', 'shop_catalog(text, text, text, text, integer, integer, boolean)', 'shop_product(text)', 'shop_home()',
    'shop_quote(jsonb, text)', 'shop_place_order(text, jsonb, text, text, text, text, text, numeric)', 'shop_my_orders(text, integer, integer)', 'shop_my_order(uuid)',
    'shop_cancel_my_order(uuid, text)', 'shop_admin_orders(text, text, integer, integer)', 'shop_admin_order(uuid)',
    'shop_admin_set_status(uuid, text, text, text)', 'shop_admin_settings()', 'shop_admin_save_settings(jsonb)', 'shop_admin_categories()',
    'shop_admin_save_category(text, jsonb)', 'shop_admin_products(text, text, integer, integer)', 'shop_admin_save_content(text, jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
