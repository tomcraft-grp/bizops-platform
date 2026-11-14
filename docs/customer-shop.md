# Customer shop (LINE LIFF)

Real products, a real cart, real orders and payments for customers, and the back-office page that runs it.
Migration: `supabase/migrations/20261115100000_customer_shop.sql`. Code: `src/shop/`, `src/pages/CustomerApp.tsx`.

## How it fits together

```
customer (LINE LIFF → Supabase session)
  Home / Products / Cart / Orders / Account         src/shop/*  (Thai default, English optional)
        │  only "SKU + quantity" and contact details are ever sent
        ▼
  shop_catalog · shop_quote · shop_place_order · shop_my_orders …      SECURITY DEFINER functions
        │  price, totals, shipping, order number, invoice amount are decided here
        ▼
  shop_orders / shop_order_items ──► finance_invoices ──► finance_payment_requests (Thai QR, exact amount)
                                                    └──► finance_payment_evidence (slip)  ──► staff verify ──► finance_receipts
```

* **Catalogue** = `sku_registry` rows that are `status = 'active'`, `sku_category = 'FG'`, have a price and are not hidden by staff.
  Price = `ecommerce_price`, else `selling_price`, else `retail_price`. The same rule feeds the DEV APP data source
  `db:sku_catalog` (now with picture, category, description, availability) and the shop screens (`public.shop_sellable`).
* **Payment is not reinvented.** An order owns one finance invoice. The customer pays it with `finance_request_payment`
  (QR for what the ledger says is outstanding) and `finance_submit_evidence` (slip). A slip never marks anything paid:
  only staff verification on **Payment review** records a receipt. Order payment status = the invoice status from the ledger.
* **Order status** uses the back-office vocabulary: new → confirmed → preparing → packed → shipped/ready → completed
  (cancelled, returned). Anything after "confirmed" needs a verified payment, unless staff continue with a recorded reason.
* **DEV APP**: the cart is a page of its own (`cartCore`); shop, cart, orders and profile cannot be hidden by a layout.
  A layout saved before the cart existed gets the cart tab automatically.

## What does not exist in the central database (and what the shop does about it)

| Missing | Consequence |
|---|---|
| Stock quantities (inventory lives in the staff browser's local store) | Quantities are **not** validated. Staff set *sold out* and an optional *max per order* per SKU. |
| Promotions / coupons | Discount line exists (always 0 today) and is hidden when 0. |
| Refund workflow | No "refunded" status. A verified payment is reversed on Payment review (finance). |
| Product pictures, descriptions, categories, options | Added: `shop_sku_content`, `shop_categories`, public bucket `shop-products`, edited on **Online shop → Products**. |

## Go-live checklist (the shop starts CLOSED)

1. Apply the migration (see below).
2. **Payment review → set up the shop's PromptPay QR** (a payment account). Without it customers cannot order.
3. **Online shop → Settings**: set the shipping fee (it is 0 until you set it), free-shipping amount, delivery / pick-up, pick-up information.
4. **Online shop → Products**: add pictures and descriptions, hide anything that should not be sold, mark sold-out items, optionally group flavours as "options".
5. **Online shop → Settings**: switch *The shop takes online orders* on. The checklist on that page shows what is still missing.
6. Optionally publish a layout in DEV APP Customer (Draft → Preview → Apply → Deploy).

Day to day: **Online shop → Orders** (confirm, pack, ship with a tracking message) and **Payment review** (verify slips).

## Security model

* Clients can only `SELECT` (RLS: own orders, or staff). Every write is a function that re-checks the caller.
* Orders, items and the audit trail are never deleted or edited in place (triggers); order amounts and ownership are frozen.
* One checkout = one order: idempotency key per `(customer, key)`; a retry of the same checkout returns the same order.
* A customer sees only their own orders, invoices, QR requests, evidence and receipts (tested with a second customer).
* `finance_log` / `finance_require` were callable by every signed-in user (anyone could write forged audit rows); the migration revokes that.

## Tests

| What | How |
|---|---|
| Database rules, RLS, payment pipeline, immutability (180 checks, real data, always rolled back) | `scripts/run-shop-sql-tests.sh` |
| Cart, checkout keys, translations, status coverage, layout rules | `npx vitest run` |
| Screens against a fake backend (39 browser tests: customer flow, payment, layouts, responsive, axe, staff page) | `npx playwright test -c playwright.shop.config.ts` |

The browser tests use `tests/shop-e2e/fakeBackend.ts`, which mirrors the database contract; they prove the screens, not the database.
Do not run the SQL tests without their closing rollback: finance rows can never be deleted.

## Applying the migration

Additive and backward compatible. It creates `shop_*` tables/functions and the `shop-products` bucket, extends `customer_app_views.sku_catalog`
(more columns, stricter customer-facing rule), splits `finance_invoice_state` into a gated wrapper + internal body (identical output),
adds the `cart` page to the layout validator, adds `source_ref` to `finance_my_invoices`, and revokes two internal finance helpers from clients.
Rollback: `supabase/rollbacks/20261115100000_customer_shop_down.sql` restores the previous view, layout validator and finance functions and drops the `shop_*` objects.
It refuses to run once any online order exists (orders and invoices are financial records). The empty `shop-products` bucket is left in place. It does not re-open the audit-log hole.
Never send the migration to the production database without a closing rollback unless you mean to apply it: `scripts/run-shop-sql-tests.sh` has that guard built in.
