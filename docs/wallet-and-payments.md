# Payment methods, bank accounts and the customer wallet

Migration: `supabase/migrations/20261115200000_wallet_payments.sql` (rollback: `supabase/rollbacks/20261115200000_wallet_payments_down.sql`).
It builds on the central finance module (`finance_invoices`, `finance_payment_evidence`, `finance_receipts`, roles viewer / clerk / verifier / manager)
and on the customer shop (`docs/customer-shop.md`). Nothing in the existing mappings was changed.

## What a customer sees

* **Pay an invoice**: choose a bank account card (SCB, BBL), the wallet, or the PromptPay QR. A bank card shows the logo (or a colour badge), the Thai and English
  name, the account number, the account name, the bank's instructions and a **copy** button (digits only). The amount to transfer is the invoice's outstanding
  amount, computed by the database. After paying they attach the slip; the slip names the bank they chose.
* **Wallet** (Account tab → wallet card, or the Home shortcut): available balance, total deposits, total payments, recent transactions, full history, open deposits,
  `[Add money]` and `[Pay invoice]`.
* **Add money**: bank + amount → transfer details with a reference (`DEP-…`) → slip → *waiting for the shop*. **The wallet is credited only after staff verify the
  transfer, with the amount the bank shows.**
* **Pay from the wallet**: never more than the balance or the invoice's outstanding amount; confirmation sheet; one tap = one charge (idempotent key).

## What staff see (Payments & wallet, `/payments`)

| Tab | Purpose |
|---|---|
| Payments | every deposit, invoice slip and wallet payment; filter by type, status, bank; search customer / invoice / payment no. / bank reference; view the slip (signed link); review a deposit (approve with the bank amount + bank reference, or reject with a reason) |
| Wallets | wallets, balances, ledger per customer, **adjust** (reason ≥ 10 chars, optional customer note), **reverse** a row, **refund** a reversed bank receipt into the wallet — managers only |
| Bank accounts | add / edit / switch off accounts (managers), optional ledger account code per bank, wallet limits |
| Accounting ledger | queue of events for the general ledger, one-click posting on the accountant's device, reconciliation wallet ↔ GL, tax setting for invoices |
| Reports | daily report per bank (what should be on the bank statement) with "in the ledger / waiting", CSV export |

## Tables

| Table | Role |
|---|---|
| `finance_bank_accounts` | the payment methods. Configuration lives here only (seeded: SCB 5194026251 ณัฐพล อยู่ยิ้ม, BBL 9380319542 ณัฐพร อยู่ยิ้ม). Account number is unique; an account with payments cannot change number — add a new one and switch the old one off. |
| `finance_wallets` | one per customer; `balance` is a **projection** of the ledger, written only by `finance_wallet_apply` (a trigger blocks every other write). |
| `finance_wallet_transactions` | the immutable ledger (no update, no delete, enforced by trigger). `seq` identity orders the chain; `balance_before/after` chain unbroken; unique idempotency key. |
| `finance_wallet_deposits` | a deposit request: `pending → submitted → under_review → verified / rejected / cancelled`. A slip hash can be used once. |
| `finance_gl_queue` | events for the general ledger, written in the same transaction as the money event. |
| `finance_settings` | limits (min / max deposit, open deposits, adjustment limit), adjustment account role, invoice VAT mode. |
| `finance_payment_evidence.bank_account_id`, `finance_receipts.bank_account_id / wallet_txn_id` | which bank a payment belongs to; a wallet payment is a receipt without a slip. |

## Wallet ledger rules (all enforced in the database)

1. A balance changes only through `finance_wallet_apply`, which locks the wallet row, refuses a negative result and writes one ledger row per change.
2. Ledger rows are never updated or deleted. A correction is a **reversal** (an opposite row pointing at the original; refused if it would make the balance negative) or an **adjustment**.
3. Every request carries an idempotency key. Same key + same payload returns the first result; same key + different payload is refused (`KEY_REUSED`).
4. Lock order is always invoice → wallet, so concurrent payments cannot deadlock or overspend (proved by `scripts/wallet-concurrency-test.mjs` against a throw-away schema).
5. `finance_wallet_reconcile()` proves `balance = Σ ledger` and an unbroken chain for every wallet. `finance_gl_reconciliation()` compares the wallet total with the liability posted to the GL.
6. Customers can read their own wallet only (RLS + functions filtered by `finance_my_customer()`); they never see staff ids or internal remarks.
7. A bank transfer is not a wallet transaction. A slip never credits anything. A verified invoice slip settles the invoice; it is never also credited to the wallet.

Transaction types: `DEPOSIT`, `INVOICE_PAYMENT`, `REFUND`, `ADJUSTMENT`, `REVERSAL`. `WITHDRAWAL` exists in the enum but no function or screen uses it (not supported).

## Accounting

The general ledger lives on the accountant's device (local engine with the existing roles `bank` 1110, `ar` 1130, `customer_credit` 2300, `sales` 4010, `output_vat` 2200,
`settlement_variance` 6400, period lock and audit). So the central database **queues** each money event in `finance_gl_queue` in the same transaction, and the
accountant's device posts the journal with the existing posting engine and confirms the journal number back (`finance_gl_mark_posted`, unique `FINQ:<id>`), the same pattern as
daily expenses. A row can be posted once from any device; re-posting returns the journal that exists.

| Event | Journal |
|---|---|
| Wallet deposit verified (THB 5,000, SCB) | Dr Bank (SCB's ledger account, else role `bank`) 5,000 / Cr Customer wallet liability (`customer_credit` 2300) 5,000 |
| Invoice paid from the wallet (THB 2,000) | Dr Customer wallet liability 2,000 / Cr Accounts receivable 2,000 |
| Bank transfer verified against an invoice | Dr Bank (that bank) / Cr Accounts receivable |
| Refund of a reversed receipt into the wallet | Dr Bank / Cr Customer wallet liability |
| Staff adjustment +300 | Dr adjustment account (`finance_settings.adjustment_role`, default `settlement_variance`) / Cr Customer wallet liability |
| Reversal of a wallet transaction | the opposite of the original |
| Invoice issued | Dr AR / Cr Sales (and Output VAT when the accountant chose "prices include VAT") |

**Gaps found and how they are handled**

* The chart has one bank account (1110). Each bank account has an optional `gl_account_code`; empty means "use role bank". The code is validated when posting (unknown or header accounts are refused with a clear reason). Existing mappings are untouched.
* Central invoices (online orders) were not recognised in the ledger at all. They now queue `INVOICE_ISSUE` / `INVOICE_CANCEL`. Whether prices include VAT is an accountant's decision, so posting an invoice is blocked until *Payments & wallet → Accounting ledger → Accounting settings* is set (payments and wallet entries are not blocked). A wallet payment waits for its invoice to be posted first (`depends_on`).
* No central refund workflow, stock or promotions existed; refunds into the wallet are manager-only and tied to a reversed receipt, capped at what was received.

## Security

* Customers never send a balance, a status, a customer id or a credit; amounts for invoices are read from the database.
* Slips: private bucket `payment-evidence`, path `<user id>/deposit/<date>/<key>.<ext>` (storage policy = own folder), type sniffed from the first bytes (JPG / PNG / PDF), ≤ 5 MB, SHA-256 stored, same slip cannot be used twice. Staff open slips through a short-lived signed link.
* All writes go through SECURITY DEFINER functions with a pinned `search_path` and a role check (`finance_require`); tables are read-only for clients; sequences and helper functions are not executable by clients.
* Adjustments need the manager role; above `adjustment_limit` (default 5,000) they need a SUPER_ADMIN. Every adjustment, reversal, refund, approval and rejection writes `finance_log`.

## Tests

| What | How |
|---|---|
| Database rules (162 checks: bank methods exact, deposit lifecycle, slip never credits, duplicate / replay, insufficient funds, immutability, authorization, reversal / refund, reconciliation, GL queue, privacy, customer B isolation) | `scripts/run-wallet-sql-tests.sh` — one transaction against the real data, always rolled back |
| Concurrency (many parallel wallet payments never overspend; duplicate keys apply once) | `node scripts/wallet-concurrency-test.mjs` — throw-away schema, always dropped |
| Posting engine (roles → accounts, bank override, idempotent, period lock, ledger = GL) | `tests/unit/finance-ledger.test.ts` |
| Screens (customer + staff, Thai/English, axe, responsive) | `npx playwright test -c playwright.shop.config.ts` (fake backend; proves the screens, not the database) |
| Rollback | `scripts/run-wallet-down-proof.sh` (restores the schema exactly) and `... guard` (refuses once data exists) |

## Operations

* Apply: through a guarded script only, then record the version in `supabase_migrations.schema_migrations`. Never pipe files to the production database with a bare `cat`.
* After applying: `select * from public.finance_wallet_reconcile()` must return no problems; `finance_gl_reconciliation()` difference must be 0 once the queue is posted.
* Open items for the business: choose the invoice VAT treatment, set a dedicated ledger account per bank if wanted, assign finance roles to staff (nobody can verify until a role is granted).

## Not built / limits

* Withdrawals, automatic bank-statement matching, overpayment-to-wallet conversion, two-person approval for adjustments (permission + limit only), real LINE / LIFF end-to-end.
* Bank logos are colour badges unless a staff member provides a `logo_url`.
