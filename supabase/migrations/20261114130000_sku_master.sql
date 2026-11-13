-- Central SKU master (product catalogue with all price tiers), imported from 01_MASTER_DATA.xlsx > SKU_Master.
-- Cost and wholesale prices are confidential: the table is readable only by staff (ADMIN / SUPER_ADMIN), never by
-- customers or anon, and the data itself is NOT stored in this (public) repository — only the structure is.
-- Back-office POS devices pull these rows into their local catalogue (Products > "Pull SKUs from central database").

create table if not exists public.sku_master (
  sku_code        text primary key,                       -- unique business code used by the app (duplicates suffixed -01, -02…)
  source_code     text not null,                          -- the code exactly as in the source workbook
  migration_key   text not null unique,                   -- SKU-MK-xxxxx, stable key for re-imports
  domain          text not null,                          -- e.g. 'POD / vape (Ref POD)', 'Kratom drink (Stock FG)'
  brand           text,
  name_en         text,
  name_th         text,
  name_full       text not null,
  product_type    text,
  pack_qty        numeric,
  unit_en         text,
  unit_th         text,
  cost_price          numeric(12, 2) check (cost_price is null or cost_price >= 0),
  retail_price        numeric(12, 2) check (retail_price is null or retail_price >= 0),     -- sticker price
  selling_price       numeric(12, 2) check (selling_price is null or selling_price >= 0),   -- actual selling price
  friend_price        numeric(12, 2) check (friend_price is null or friend_price >= 0),
  wholesale_price     numeric(12, 2) check (wholesale_price is null or wholesale_price >= 0),
  ecommerce_price     numeric(12, 2) check (ecommerce_price is null or ecommerce_price >= 0),
  barcode         text,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  tax_category    text,
  needs_review    boolean not null default false,
  review_notes    text,
  source_sheet    text,
  source_row      integer,
  imported_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists sku_master_domain_idx on public.sku_master (domain, brand);
create unique index if not exists sku_master_barcode_key on public.sku_master (barcode) where barcode is not null;

alter table public.sku_master enable row level security;
drop policy if exists "sku_master: staff read" on public.sku_master;
create policy "sku_master: staff read" on public.sku_master for select to authenticated using (public.feedback_is_staff());

-- No client writes yet: imports run server-side. Customers and anon get nothing.
revoke all on public.sku_master from anon;
revoke insert, update, delete, truncate on public.sku_master from authenticated;
