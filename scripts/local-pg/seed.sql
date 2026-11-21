-- Seed of the LOCAL throw-away PostgreSQL (scripts/local-pg): a small, invented but production-shaped dataset that the existing SQL suites
-- (supabase/tests/*.sql) expect to find in "real" data. Runs once, after stubs.sql and every migration, when the template database is built.
-- Everything here is fake: no real customers, no real prices. Do NOT run this against the Supabase project.
--
-- What the suites assume about production, and where it comes from here:
--   profiles        1 SUPER_ADMIN (S), 1 ADMIN, 4 active USER members (A, B, C, D: wallet_payments.sql needs four); the suites pick them
--                   by `role / status / created_at order`, so the creation times below are strictly increasing.
--                   finance_staff_roles is left EMPTY on purpose: the suites grant C (verifier) and D (manager) themselves, a pre-seeded row would collide.
--   sku_registry    145 finished goods FG-000001..FG-000145 like the real import (POD / vape 1-120, kratom drinks 121-145; "catalogue > 100"):
--                   FG-000001 and FG-000020 cost 320 (suite order totals), FG-000002/3/10/11/13 priced and active (the suites sold-out / limit /
--                   deactivate / hide / re-price them), FG-000122 has NO price, FG-000123 has only a retail price of 40, exactly 2 'SaltNic' products,
--                   'Coil' products, brands INFY (more than 10 products), RELX, KS, Vozol, Lana, Elfbar, kratom drinks without a brand,
--                   a few inactive rows, a few names carrying the sheet row-number prefix that the shop view strips.
--   shop_settings   the single row, shop open with pickup and delivery, slip required (production defaults after go-live).
--   payment         the two bank accounts SCB / BBL come from the wallet migration itself. NO PromptPay account is seeded: customer_shop.sql
--                   ("open but no payment account") and online_ordering.sql ("QR refused while no PromptPay account is set up") assert its absence.

-- ---------------------------------------------------------------------------------------------------------------- people
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@seed.test',  '', now(), '{"provider":"email"}', '{"display_name":"Seed Owner (SUPER_ADMIN)"}', '2026-11-01 09:00+07', '2026-11-01 09:00+07'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@seed.test',  '', now(), '{"provider":"email"}', '{"display_name":"Seed Admin"}',            '2026-11-01 09:05+07', '2026-11-01 09:05+07'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@seed.test',      '', now(), '{"provider":"line"}',  '{"display_name":"Member A"}',               '2026-11-02 10:00+07', '2026-11-02 10:00+07'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@seed.test',      '', now(), '{"provider":"line"}',  '{"display_name":"Member B"}',               '2026-11-02 11:00+07', '2026-11-02 11:00+07'),
  ('cccccccc-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@seed.test',      '', now(), '{"provider":"line"}',  '{"display_name":"Member C"}',               '2026-11-02 12:00+07', '2026-11-02 12:00+07'),
  ('dddddddd-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'd@seed.test',      '', now(), '{"provider":"line"}',  '{"display_name":"Member D"}',               '2026-11-02 13:00+07', '2026-11-02 13:00+07');
-- the auth.users trigger has created one USER profile per row; fix roles, times and contact data (the role guard trigger only lets a SUPER_ADMIN do that)
alter table public.profiles disable trigger protect_profile_columns_trg;
update public.profiles p set
  role = case p.id when '11111111-1111-4111-8111-111111111111' then 'SUPER_ADMIN' when '22222222-2222-4222-8222-222222222222' then 'ADMIN' else 'USER' end,
  status = 'active', created_at = u.created_at, updated_at = u.created_at,
  phone = case p.id when 'aaaaaaaa-0000-4000-8000-00000000000a' then '0811111111' when 'bbbbbbbb-0000-4000-8000-00000000000b' then '0822222222'
                    when 'cccccccc-0000-4000-8000-00000000000c' then '0833333333' when 'dddddddd-0000-4000-8000-00000000000d' then '0844444444' end,
  line_user_id = case when p.id in ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b', 'cccccccc-0000-4000-8000-00000000000c', 'dddddddd-0000-4000-8000-00000000000d')
                      then 'U' || replace(p.id::text, '-', '') end
from auth.users u where u.id = p.id;
alter table public.profiles enable trigger protect_profile_columns_trg;

-- ---------------------------------------------------------------------------------------------------------------- shop
update public.shop_settings set shop_open = true, delivery_enabled = true, pickup_enabled = true, shipping_fee = 50, free_shipping_min = null,
  closed_message = null, require_payment_slip = true, updated_at = '2026-11-15 12:00+07';

-- ---------------------------------------------------------------------------------------------------------------- SKU registry
-- The real rows came from the workbook import BEFORE the later migrations, so they must not look like changes made after them:
-- user triggers are switched off while the registry is filled (a feed/audit trigger added by a later migration must not see this as history).
set session_replication_role = replica;
insert into public.sku_registry (sku_code, sku_category, sku_seq, legacy_sku_code, origin, source_code, migration_key, domain, brand, name_en, name_th, name_full,
                                 product_type, pack_qty, unit_en, unit_th, cost_price, retail_price, selling_price, friend_price, wholesale_price, ecommerce_price,
                                 status, source_sheet, source_row, imported_at, updated_at)
select public.sku_format('FG', g), 'FG', g, 'LEG-' || lpad(g::text, 5, '0'), 'import', 'SRC-' || lpad(g::text, 5, '0'), 'SKU-MK-' || lpad(g::text, 5, '0'),
       d.domain, d.brand, d.name_en, d.name_th,
       case when g in (5, 6, 7) then g::text || ' ' else '' end || d.name_en || ' ' || d.name_th,       -- a few rows carry the sheet row number, as the workbook did
       d.product_type, d.pack_qty, d.unit_en, d.unit_th,
       d.cost, d.retail, d.selling, d.friend, d.wholesale, d.ecom,
       case when g in (30, 31, 32, 141) then 'inactive' else 'active' end,
       case when g <= 120 then 'POD' else 'Kratom' end, g, '2026-11-13 08:00+07', '2026-11-13 08:00+07'
from generate_series(1, 145) g
cross join lateral (select
  case when g <= 120 then 'POD / vape (Ref POD)' else 'Kratom drink (Stock FG)' end as domain,
  case when g <= 40 then 'INFY' when g <= 70 then 'RELX' when g <= 85 then 'KS' when g <= 100 then 'Vozol' when g <= 118 then 'Elfbar' when g <= 120 then 'Lana' else null end as brand,
  case when g <= 40 then 'Puff' when g <= 70 then 'Pod' when g <= 85 then 'Pod' when g <= 100 then 'Puff' when g <= 118 then 'Coil' when g <= 120 then 'SaltNic' else null end as product_type,
  case when g <= 40 then 'INFY 6000 Puffs #' || g when g <= 70 then 'RELX Pod #' || g when g <= 85 then 'KS Pod #' || g when g <= 100 then 'Vozol Puffs #' || g
       when g <= 118 then 'Replacement Coil #' || g when g <= 120 then 'Salt Nic Juice #' || g else 'Kratom drink #' || g end as name_en,
  case when g = 1 then 'ผลไม้รวม' when g <= 40 then 'รสผลไม้ ' || g when g <= 120 then 'พอต ' || g else 'น้ำกระท่อม ' || g end as name_th,
  case when g <= 120 then 'pcs' else 'bottle' end as unit_en,
  case when g <= 120 then 'ชิ้น' else 'ขวด' end as unit_th,
  case when g <= 120 then 1 else 6 end as pack_qty,
  -- prices: FG-000001 and FG-000020 sell at exactly 320; FG-000122 has no price at all; FG-000123 only a retail price of 40
  case when g = 122 then null when g <= 120 then 150 + (g % 7) * 10 else 15 end as cost,
  case when g = 122 then null when g in (1, 20) then 350 when g <= 120 then 330 + (g % 5) * 10 else 40 end as retail,
  case when g = 122 or g = 123 then null when g in (1, 20) then 320 when g <= 120 then 300 + (g % 5) * 10 else 35 end as selling,
  case when g = 122 then null when g <= 120 then 280 + (g % 5) * 10 else 30 end as friend,
  case when g = 122 then null when g <= 120 then 250 + (g % 5) * 10 else 25 end as wholesale,
  case when g in (50, 51) then 290 else null end as ecom
) d;
-- the guard against hand-typed codes is on; the counter must agree with the rows so sku_issue() hands out FG-000146 next
update public.sku_counters set last_seq = 145, updated_at = '2026-11-14 09:00+07' where category = 'FG';
set session_replication_role = origin;
analyze public.sku_registry;
