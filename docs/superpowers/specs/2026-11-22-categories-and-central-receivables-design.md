# Product categories (new table) and central receivables: design

Status: DRAFT for the owner's approval (2026-11-22). Nothing here is built or applied yet.
Owner's choices so far: categories in a **new separate table**; receivables **moved to Supabase**.

## 1. Facts this design rests on (checked, not assumed)

Read-only queries against the live project on 2026-11-22, plus code reading by two investigation agents (file:line evidence kept in the session notes):

- **No category table exists.** The back office keeps `Product.category` as free text in each device's IndexedDB (`src/domain/types.ts:42`). The shop derives a code with `shop_category_of(product_type, domain)`. Both are text, with no foreign key, and they disagree for the same SKU ("POD · Puff" locally, "Puff" in the shop).
- **Live registry:** 147 SKUs, all FG. Real groups: Puff 115, Kratom drink 24, Coil 2, Device 2, SaltNic 2, and Finished goods 2 (app-issued, `product_type` empty).
- `shop_categories` has **0 rows**. Two reward rules use the code `'Kratom drink'` (`rw_rules.category_codes`).
- **Category readers:**
  - the local category string: Products, POS tabs, Inventory filter, Profit by category, local Promotions, Loyalty multipliers, DEV APP
  - the derived code: shop SQL (catalog, facets, related, admin), shop UI, rewards
- **Supabase AR is live**, used by the online shop: 4 `finance_customers`, 14 `finance_invoices`, 7 `finance_receipts`. It already supports split payments: several receipts or evidence rows per invoice, with methods transfer, cash and wallet. Its remaining balance is computed by `finance_invoice_state_raw`.
  - `finance_customers.local_customer_id` exists as a bridge, but it is unused (0 rows linked).
- **Back-office receivables are device-only:**
  - `/receivables` → `createReceipt` in IndexedDB.
  - Customers (`db.customers`) and orders (`db.orders`) are device-only too.
  - Two tabs or devices overwrite each other (whole-DB write, last one wins).
  - The local audit log is capped at 4000 rows and the oldest rows are deleted.
  - A voided receipt is changed in place.
- **Confirmed screen defect:** in "Receive payment", changing the customer resets only the amount and the manual split. Method, reference and mode carry over (`src/pages/Receivables.tsx:90`).

## 2. Product categories

### 2.1 Schema (migration `…_product_categories.sql`, with a rollback)
```
public.product_categories
  id            uuid primary key default gen_random_uuid()
  code          text not null unique check (code ~ '^[A-Za-z0-9 ._-]{1,60}$')   -- never changes once created (trigger)
  name_th       text not null check (length between 1 and 80)
  name_en       text          check (length <= 80)
  description   text          check (length <= 500)
  parent_id     uuid references product_categories(id) on delete restrict      -- optional, one level of nesting is enough today
  is_active     boolean not null default true
  sort_order    integer not null default 100
  created_by uuid default auth.uid(), created_at timestamptz default now(),
  updated_by uuid, updated_at timestamptz default now()
sku_registry.category_id uuid references product_categories(id) on delete restrict   + index
shop_categories.category_id uuid unique references product_categories(id)            -- storefront settings (picture, sort, visible) point at the master
```

**Rules, enforced in SQL:**
- No DELETE is granted to clients, and a trigger refuses deleting any category.
- Deactivating a category that still has products is allowed: existing products keep it, but it can no longer be picked for new or changed SKUs. Deactivating needs a reason, which is logged.
- A parent cannot be its own ancestor.
- `code` cannot change.
- Writes go only through staff functions:
  - `category_save(p_id, p_patch)`
  - `category_set_active(p_id, p_active, p_reason)`
  - `categories_list(p_include_inactive)`
  - all logged to the existing `sku_registry_log` / `finance_events`-style audit (to decide: reuse `shop_log`).
- `sku_set_details` accepts `category_id`, and refuses one that does not exist or is inactive.
- `sku_reserve`/`sku_issue` keep their signature; the category is sent right after, through `sku_set_details`, exactly like price today.
- The feed (`sku_registry_log` columns, `sku_registry_row_json`) carries `category_id` and `category_code`, so devices receive changes automatically.

### 2.2 Backfill (in the same transaction)
1. Insert one category per distinct `shop_category_of(product_type, domain)`. Today that gives Puff, Coil, Device, SaltNic, Kratom drink and Finished goods. `code` is that text and `name_th` starts equal to it; staff can rename later.
2. `update sku_registry set category_id = (match by code)`, so all 147 rows are linked. Check `count(*) where category_id is null` = 0.
3. The shop and rewards keep working on the **same codes**: `shop_category_of` is replaced by a join on `category_id` → `code`. So `rw_rules` 'Kratom drink' and the shop links are unchanged.
4. Later, once every device has synced: `category_id not null` for FG (a separate, tiny migration).

### 2.3 App
- **Category becomes registry-owned for SKUs with a registry code.** `Product.categoryId` is optional; there is no local DB version bump, because that would wipe devices.
  - `importSkuMaster` writes it on every sync.
  - `registryEditPatch`/`newSkuDetails` send it.
  - The free-text `category` stays only as a display copy (the name), for old readers.
- **Products:** New and Edit use a searchable dropdown of active categories (never free text), and the list gets a category filter and column. Products without a registry code (device-only) pick from the same list.
- **New Categories admin page:** search, create, edit, activate/deactivate with a reason, parent, and how many products use each category. Only `catalog:edit` staff can open it, and the server checks the role again.
- POS tabs, Inventory filter, Profit, Promotions and Loyalty read the name through `categoryId` (falling back to the old text).
  - Local promotions and loyalty multipliers keyed by the old strings get a one-time re-key, and staff see a list of anything that could not be matched.
- The ShopAdmin categories card edits only the storefront settings of a master category.

### 2.4 Tests
- **SQL, rolled back on the live project:**
  - backfill complete
  - delete refused
  - inactive category cannot be assigned
  - nonexistent id refused
  - code immutable
  - cycle refused
  - shop facets and catalog md5 unchanged before vs after
  - rewards rule still matches 'Kratom drink'
  - non-staff refused
- **Unit and browser tests:** dropdown only (no free text), edit shows the saved category, filter, admin create/edit/deactivate, deactivated category hidden from pickers but still shown on its products.

## 3. Central receivables

### 3.1 The real problem
Receipts cannot be central while the **customers and the orders they pay for** exist only on one device. So the design moves the *money* to Supabase and gives each credit sale a central invoice there. Stock, the order lines and POS stay local as today.

### 3.2 Design: reuse the live finance AR (no parallel ledger)
- **Central customer:** `finance_customers` is the master for anyone who buys on credit. Each device's local customer is linked through a new mapping table `finance_customer_links(local_customer_id, device_db_id, customer_id)`, because two devices give the same person different local ids. The existing `local_customer_id` column is kept for the first link.
  - Linking happens when staff first sell on credit or receive a payment for that customer. Staff choose an existing central customer (search by phone or name) or create one, so duplicates are a human decision, not a guess.
- **Credit sale → central invoice.** When a local order is completed with an unpaid balance for a customer, the app calls a new staff function:
  ```
  finance_issue_order_invoice(p_customer, p_order_no, p_amount, p_due_date, p_idempotency_key)
  ```
  It creates a `finance_invoices` row with `source_ref` = the order number.
  - Unique on (source_ref, device) plus the idempotency key, so a retry never creates two invoices.
  - If offline, it is queued and re-sent, like the SKU uploads.
- **Receive payment** (the `/receivables` screen) becomes a Supabase screen.
  1. Pick the central customer.
  2. See their open invoices from all devices and the online shop.
  3. Record one payment or several (split: cash + QR + transfer) through `finance_record_payment`, extended as below.
  4. Allocate FIFO or manually.
  5. The remaining balance comes from the server.
  - The form is keyed by customer and invoice, so changing the customer starts a fresh form.
  - Every request carries the customer id, and the server rejects an invoice of another customer.
- **POS split tender** for an immediate sale stays local, because it is paid at once and no receivable exists. Only the unpaid part becomes a central invoice.
- **Old local receipts:** read-only history on the device where they were made. A one-time "Send open balances to the central ledger" action turns each still-unpaid local order into a central invoice for its amount still owing, with the local order number as the reference. Paid history is not copied: it stays readable locally, and the central log notes the import.

### 3.3 Server hardening (same migration family)
- `finance_record_payment(…, p_idempotency_key)`: unique on (key, created_by), and a replay returns the first result.
- **Constraint triggers:**
  - receipt.customer_id = invoice.customer_id
  - allocation.invoice_id belongs to the receipt's customer
  - evidence.customer_id = invoice.customer_id
- **New method `qr` (PromptPay at the counter)** and `card`, so the 400 cash + 300 QR + 300 transfer example is recorded with its true methods.
- **Overpay:** `finance_record_payment` refuses an amount above the remaining balance (as today). `finance_confirm_evidence` also checks it. Wallet credit for an excess transfer stays as it is, the existing business rule; an owner switch to block it is listed as optional.
- **`finance_customer_payment_log(p_customer)`:** one time-ordered list over evidence, receipts (posted/reversed), wallet movements and `finance_events`. Each entry has: customer, invoice, transaction id, amount, method, time, status, who, and remarks.
  - Status is derived: pending (submitted/confirmed evidence), completed (posted receipt), failed (rejected evidence), cancelled (cancelled request/deposit), reversed (reversed receipt).
  - Nothing is overwritten: reversals stay as new events, and the existing guard triggers already block changing amounts and deleting.
- `finance_payments_overview` shows reversed receipts as *reversed*, not as verified.

### 3.4 Screen fixes that ship first (no DB change)
- Receive payment: reset method, reference and mode when the customer changes, and show a clear customer header.
- POS: clear the coupon and discount when the customer changes or a sale is recalled; capture a reference per tender line.
- PaymentsAdmin: request-sequence guards on list and wallet loads; one idempotency key per opened adjust or refund dialog.
- Wallet methods cache keyed by user id.
- Local receipts write an audit row, and the audit cap stops deleting history.
- A second open tab of the back office shows a warning (BroadcastChannel) until receivables are central.

### 3.5 Tests
- **SQL, rolled back on the live project:**
  - split 400/300/300 on one invoice leaves 0 remaining, and a fourth payment is refused
  - an invoice of customer B cannot be paid in A's receipt
  - concurrent double submit with the same key → one receipt
  - a different key over the limit is refused (row lock)
  - reversal keeps the original row and adds a reversed event, and the log shows both
  - non-staff refused
  - an order invoice is issued once per idempotency key
- **Browser tests:** switching customers clears the form; split payment UI; history view.

## 4. Order of work and approvals
1. Screen fixes (§3.4): code only.
2. Categories migration, backfill and tests (rollback mode) → owner approves the apply → app screens → publish.
3. Payments hardening migration (§3.3) and tests → owner approves the apply.
4. Central receivables screens, customer linking, credit-sale invoices, and the import of open balances → owner approves → publish.

Each apply follows the existing procedure: rehearsal in rollback mode, explicit "อนุญาต", `scripts/apply-migrations.sh`, read-only verification, and a rollback file ready.

## 5. Owner's decisions (2026-11-22)
1. **Customer master:** credit customers are linked to a central `finance_customers` record by staff choosing or creating it (search by phone or name). All customers are NOT moved this round.
2. **Category nesting:** one level (group → category).
3. **Excess transfer:** keep crediting the excess to the customer's wallet (today's rule, unchanged).
