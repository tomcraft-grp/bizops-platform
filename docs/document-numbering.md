# Document numbering and the transactional reset (2026-11-15)

Migration `supabase/migrations/20261115500000_document_numbering.sql`, rollback `supabase/rollbacks/20261115500000_document_numbering_down.sql`.

## The rules

* **The database decides every number.** The app never builds a number (a unit test checks that); `next_doc_no()` is not callable by clients.
* **Gap-free and never twice.** The next number is taken with a row lock **inside the transaction of the document itself**. If that transaction fails (a refused slip, a bad cart, a crash), the number is not used and the next document gets it. Two concurrent requests can never get the same number.
* **One independent series per document type**, in `doc_counters`, with the format in `doc_number_formats`:

| Document | Type | Format | Used by |
|---|---|---|---|
| Online order | `ORDER` | `ORD-000001` | `shop_place_order` |
| Invoice / payment request | `INVOICE` | `INV-000001` | `shop_place_order`, `finance_create_invoice` (staff) |
| Customer payment (receipt) | `PAYMENT` | `PAY-000001` | `finance_verify_evidence`, `finance_pay_invoice_with_wallet` |
| Wallet transaction | `WALLET` | `WAL-000001` | `finance_wallet_apply` (every wallet movement) |
| Wallet deposit | `DEPOSIT` | `DEP-000001` | `finance_deposit_create` |
| Receipt against opening receivables | `AR_RECEIPT` | `AR-RC-000001` | `ar_receive_payment` |

* **Formats are data, not code.** Each type has a prefix, a period rule and a digit count. Period rules: `none` (one continuous series), `year` (`ORD-2026-000001`), `month` (`ORD-202611-000001`), `fiscal_year` (`ORD-FY2027-000001`, the fiscal year is named after the year it ends; set the start month with `fiscal_year_start_month`, 1 = calendar year). A manager changes a format with `finance_save_doc_format(type, prefix, period, digits [, fiscal_start])`; it applies to the **next** document, old numbers are never rewritten, and the change is audit-logged. `doc_numbering_overview()` shows the formats and where each counter stands (finance viewers and up). A number longer than its width is never cut off.
* **Counters only move forward.** A trigger refuses to lower, jump or delete a counter; only a deliberate, logged reset (`finance.counter_reset`) can.
* **No deadlocks.** Where a function takes several numbers it takes them in one fixed order: payment number, then the wallet row, then the wallet number.
* **Backstop.** Order, invoice, receipt and wallet numbers also have unique constraints.
* The old sequences (`shop_order_seq`, `finance_invoice_seq`, `finance_receipt_seq`, `finance_wallet_txn_seq`, `finance_deposit_seq`, `ar_receipt_seq`) were **dropped**; the migration fails if any function still mentions one.

Not covered by this mechanism (and why): **daily expenses** already have their own gap-free yearly counter (`EXP-2026-000001`, same pattern); the **staff device modules** (POS, inventory, purchasing and purchase orders, production, accounting journals) live in the browser database of each staff device and number their own documents there (`PO-000001`, `JV-…`): they are not in Supabase, so a central database reset cannot reach them.

## The reset that was performed

| Item | Result |
|---|---|
| Numbering | The six sequences were retired; the new counters start at **zero**, so the next order is `ORD-000001`, the next invoice `INV-000001`, and so on |
| Rows deleted | **None.** Finance and shop records are immutable by design (no deletes) and, more importantly, one **real customer order** already exists |
| The real order | `SO-202611-00181` (invoice `INV-202611-00268`, ฿1,220, placed by a customer through the live app before the slip rule, unpaid, no payment recorded) is kept exactly as it is. To remove it from circulation the owner cancels it in *Online shop → Orders → Cancel order* (with a reason): that keeps the audit trail |
| Test data | Everything the tests created was rolled back; production contains no test rows |
| Master data preserved | products and SKUs (145), SKU history, customers (23), opening receivables (339 items, 1 import batch), chart of accounts and accounting settings (on the staff devices), bank accounts, payment methods and shop settings, expense categories and settings, authentication, employee profiles and roles, the migration history, audit logs |
| Recovery point | `scripts/backup-tables.mjs` exported all 23 non-empty tables, the function definitions and the migration history to a folder **outside the repository** (personal data), then re-counted every table and wrote a manifest with SHA-256 checksums. Supabase's managed backups and point-in-time recovery are **not available on this project's plan** (checked), so this export is the recovery point |

## Rolling back

`scripts/run-numbering-down-proof.sh` (valid only before the migration is applied; it passed 13 of 13, and its `guard` mode refuses) proved that the rollback restores the exact previous function bodies and brings the six sequences back, continuing after the highest old number. The rollback **refuses once the central numbering has issued any number** (otherwise a later re-apply would start again at 1).

## Tests

`scripts/run-numbering-sql-tests.sh` (47 checks, real data, rolled back): formats, first numbers of a fresh system for every type, period rules and fiscal year, digits, every document type taking its number, a failed checkout leaving no gap, counters moving forward only, privileges, formats changed by managers only, 60 invoices in a row unique and consecutive. `node scripts/numbering-concurrency-test.mjs` (throw-away schema): 40 parallel orders are exactly 1–40; 30 invoices with 10 rolled back leave exactly 1–20; 30 concurrent payments in the fixed lock order do not deadlock.
