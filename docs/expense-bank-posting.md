# Daily expenses v2: products, one-step "approve & post", bank accounts and bank balances

Migration `supabase/migrations/20261128160000_expense_bank_posting.sql`, rollback `supabase/rollbacks/20261128160000_expense_bank_posting_down.sql`.

## What changed

| Area | Before | Now |
|---|---|---|
| Expense item | free text or a category name | also any **active product of the central catalogue** (`sku_registry`), stored as `expense_claims.sku_code` |
| Category of a product | chosen by hand | **from the catalogue class**: RM / WIP → "Raw materials & packaging" (posting role `inv_materials`), FG → "Goods for resale" (`inv_goods`). Being on sale never changes the class, so fresh coconut sugar registered as RM stays a raw material. The employee can still change the category before saving. |
| Workflow | draft → submit → manager approves → accountant reviews → device posts | **draft → (optional "reviewed" mark) → approve & post**, one step, in bulk. Capability `approve_post` = manager, accountant, admin. Old `submitted` / `approved` claims are posted the same way. |
| Posting | journal posted on the accounting device first, then `expense_mark_posted` | **in the database, one transaction per expense**: claim → `posted`, journal queued in `finance_gl_queue` (`EXPENSE_PAYMENT`, posted on the device from Payments & wallet → Accounting ledger with the existing engine), bank movement, audit row |
| Bank transfer / QR | no bank account | the **bank account is required** (`expense_claims.bank_account_id`, active `finance_bank_accounts` only; the picker shows bank, account name, last 4 digits) |
| Bank balance | did not exist | append-only ledger `finance_bank_transactions` + projection `finance_bank_balances` (only `finance_bank_apply()` writes it). Posting deducts the money that left (amount − withholding tax); reversal puts it back. Key `EXPENSE:<claim id>` = one deduction per expense, whatever the clicks, retries or concurrent runs. |
| Reversal | device journal reversal + `expense_mark_reversed` | `expense_reverse()`: claim → cancelled, queue row voided (not yet in the ledger) or an `EXPENSE_REVERSAL` row queued after it, bank reversal movement pointing at the original. Claims posted the old way are still reversed on the device. |

Balances and movements are visible to finance staff and to people who post expenses (`finance_bank_can_view()`); never to customers. Opening balance and statement adjustments: finance manager (SUPER_ADMIN) only, with a reason.

## Not included (on purpose)

* Customer transfers INTO a bank account (verified slips, wallet deposits) are **not** fed into the bank ledger yet. Until they are, match the statement with "Adjust to statement". Feeding them in touches the live payment verification flow and is a separate change.
* A product purchase posts to inventory **value** only; the quantity is still received in Inventory / Purchasing.

## Deploy order

1. Apply the migration (owner approval needed): `scripts/apply-migrations.sh` as for earlier migrations.
2. Publish the app (gh-pages procedure). The app before the migration keeps working with the database after it: the 11-argument `expense_save`, `expense_submit`, `expense_approve`, `expense_mark_posted` are kept.
3. In Daily expenses → Bank accounts, enter the opening balance of SCB and BBL as of a chosen day.

## Checks run

| Check | Where | Result |
|---|---|---|
| `scripts/run-expense-bank-sql-tests.sh` | live database, one transaction, always rolled back; real profiles, real SCB / BBL, real products | 71 / 71 |
| `scripts/run-expense-bank-down-proof.sh clean / control / guard` | live database, rolled back | 10 / 10 proven; control finds the differences; guard refuses once a bank movement exists |
| `node scripts/local-pg/expense-bank-concurrency.mjs` | local PostgreSQL only (see the script header for the skip list) | 14 / 14 |
| `npx vitest run` | unit | 1742 / 1742 |
| `tests/shop-e2e/dailyExpenses.spec.ts`, `payments-admin.spec.ts`, `paymentPolicy.spec.ts` | browser, fake backend | 21 / 21, 32 / 32 |

## Rollback

Run the rollback file, then delete version `20261128160000` from `supabase_migrations.schema_migrations`. It refuses while any claim names a product, bank account or queued journal, any bank movement or expense queue row exists, or a claim sits in a product category: those are financial records. Reverse them first.
