# Payment policy, wallet QR top-up, recent orders, purchasing: design and what was verified (2026-11-27)

Owner's four requests. Branch `feat/payment-policy-reorder-purchasing` (worktree `.claude/worktrees/policy-purchasing`). Fable (a second model) reviewed the design; what was accepted and rejected is in section 6.

## 0. What the two tickets really were (read from `bizops_feedback_issues`, read-only)
- **FB-001042** (staff, 26 Nov): "topping up a customer's wallet has no PromptPay QR option". Not a wrong-balance bug, so there was no balance to repair (the wallet ledger is append-only and the balance is changed only by `finance_wallet_apply`).
- **FB-001002** (staff, 14 Nov): "after the shop rejects an order the customer cannot do it again / wants the latest cart items". "Order again" for cancelled and returned orders already existed; what was missing is quick access (Home, empty cart) and a reorder for every finished order.

## 1. Customer payment policy (migration `20261127100000_customer_payment_policy.sql`)
- `finance_customers.payment_policy` (`partial` default, `full`), NOT NULL with a CHECK. Every existing customer became `partial` = exactly today's behaviour (live: 9 customers).
- Enforced in the database at the two ways a customer pays an invoice themselves:
  - `finance_submit_evidence` (slip): under `full` the claimed amount may not be LESS than the outstanding amount, and no second slip may be waiting (`submitted`/`confirmed`). A claim for MORE is accepted: money already sent is never refused at the door and the excess is credited to the wallet by the owner's earlier rule (also a QR made before a staff part payment stays usable). `more_evidence` is deliberately not counted as waiting: the customer must be able to upload what the shop asked for.
  - `finance_pay_invoice_with_wallet`: under `full` the wallet pays exactly the outstanding amount.
  - Both already took the invoice row lock (`FOR UPDATE`) before reading the outstanding amount, so concurrent payments are serialised and the second sees the first.
- Staff entries (`finance_record_payment`, `finance_receive_payment`) are NOT blocked: staff record money that was physically received (cash, split tenders). Two read-only triggers write `policy.partial_by_staff` and `policy.balance_left` to `finance_events`; they can never stop a payment (errors become warnings). The staff form shows a warning.
- `finance_set_payment_policy(customer, policy, reason)` (finance manager only, reason required, old/new/reason/who/when in `finance_events`), `finance_my_payment_policy()` (never null), `finance_customer_policies(ids, search, limit)` (staff, with what is still owed).
- Screens: the customer invoice card shows the rule and locks the amount; the wallet panel pays the exact amount and stays off when the balance is short; staff: Payments & wallet → Customers tab (change with a reason), warning on Record payment.
- Safety guard inside the migration: it refuses if the live text of the two replaced functions differs from the copy it was written from (another session also changes finance functions).

## 2. Wallet top-up with PromptPay QR (migration `20261127110000_wallet_deposit_qr.sql`)
- A deposit is booked to one of the shop's bank accounts (`finance_wallet_deposits.bank_account_id`, required). The shop's QR (`finance_payment_accounts`) has no link to a bank account; live on 2026-11-27 the QR is a KASIKORN e-wallet while the bank accounts are SCB and BBL. A QR shown under a bank the customer picked would book the money to the wrong account.
- So: `finance_payment_accounts.bank_account_id` (nullable), set by a manager (`finance_set_payment_account_bank`); `finance_deposit_qr_bank()`; `finance_deposit_qr(deposit)` builds the QR for the caller's own pending deposit with the same function the invoice QR uses and refuses unless the deposit was created with the QR's own bank account.
- The QR option appears in the top-up only after the manager adds the receiving bank account under Bank accounts and links the QR to it (card on the same tab). Until then nothing changes for customers. **This is a required manual step.**
- Slips of QR top-ups are checked as before; the slip checker already accepts the QR account as a receiver.

## 3. Recent orders
- `RecentOrders` on Home and on an empty cart: last 3 orders (newest first) from `shop_my_orders` (owner-scoped in the database, the app sends no customer id), badges, items, total, one tap to the detail page.
- Action per order: finished (completed, cancelled, returned) → Order again; running and a payment is due → Pay; otherwise View. A running order is not offered a repeat (it would create a second order).
- Order again merges into the cart (quantities add up), skips free gift lines and says how many were skipped; the cart re-prices every line with the server.

## 4. Purchasing and perpetual accounting (local book, `src/domain/purchasing.ts`)
Audit of what existed: purchase orders, partial receipts with landed cost, a payable per receipt, perpetual journals (Dr inventory by kind + Dr input VAT / Cr payables; payment Dr payables / Cr cash or bank; return as credit note), moving-average stock ledger, production WIP and cost of goods sold. **The accounting was already perpetual.** What was broken or missing:
- The order form crashed in a book with no supplier; items were limited to the supplier's list and a new supplier had no way to get items; the warehouse was a fixed id.
- A draft order had no action at all; a draft could be received (bypassing approval); a closed order could be cancelled, any order closed.
- Repeated product lines, bad numbers, no duplicate supplier-invoice check, no idempotency on receiving.
- No way to reverse a wrong receipt or a wrong payment; a journal reversed by hand from Accounting left stock and payables behind.
- Returns: credit at the average cost instead of the invoiced price, and the credit was not applied when no invoice was chosen or the invoice was already paid, so the payables account and the supplier invoices disagreed.
Implemented:
- Orders: validation, line discount %, draft → edit → approve (a stamp, never a gate: a one-person shop must be able to approve its own order, a lesson of the expense approvals), history, cancel / short-close with a reason, receiving only after approval.
- Receiving: request key (double click = one receipt), duplicate supplier-invoice number refused, net-of-discount stock value and payable, optional "paid now" in the same transaction.
- `reverseGoodsReceipt`: stock out at the CURRENT average cost, the receipt journal mirrored at its original value, the difference to the inventory adjustment account so the ledger still equals the stock; refused when the goods are gone, or the invoice has a payment/credit note/return; invoice voided (kept), order quantities rolled back, idempotent.
- `voidSupplierPayment`: payment stays on record, journal mirrored, invoices owe again; refused if the part kept as deposit was spent.
- `returnToSupplier`: credit at the invoiced price, stock at average cost, difference to adjustment, FIFO application, excess kept as supplier deposit.
- `reverseJournal` refuses receipt/payment/return journals ("reverse it in Purchasing"); void invoices are excluded from VAT reports.
- Screens: supplier form with usual items, order form with usual items first and every active item available, order detail drawer with receipts and a Reverse button, Payables with a payments list and Cancel.
- BOM: any purchased item can already be a BOM component (the production module accepts any product); a unit test runs purchase → BOM → production → sale and checks every control account reconciles.
Not done on purpose: a goods-received-not-invoiced clearing account and price-variance accounts (receipt = invoice by construction; differences are handled with a return/credit note), VAT on freight billed by the supplier (freight and handling carry no VAT), lot tracking in balances (the lot check reads the movement ledger).

## 5. Tests and what they prove
| Area | Where | Data |
|---|---|---|
| Policy, QR (SQL) | `supabase/tests/payment_policy.sql` 65/65 and rollback proof 9/9 | the REAL Supabase project (real profiles, customers, invoices, bank and QR rows) inside a transaction that always rolls back |
| Policy/QR/orders screens | `tests/shop-e2e/paymentPolicy.spec.ts`, `recentOrders.spec.ts` | a FAKE backend that mirrors the SQL contract |
| Purchasing rules | `tests/unit/purchasing.test.ts` (34) + authz matrix | seeded test book |
| Purchasing screens | `tests/shop-e2e/purchasing.spec.ts` | the app's real IndexedDB in Chrome, products from a fake SKU feed |
The local purchasing book lives in each browser (IndexedDB), not in Supabase, so there is no Supabase data to validate it against.

## 6. Fable's review: accepted and rejected
Accepted: over-claims accepted under `full`; the staff-list "still owed" bug; md5 guard of the copied functions; a QR needs a bank link; reversal at the current average cost with a difference journal; return price and payables fixes; receiving key; duplicate lines; optional approval stamp; no GRNI/PPV. Rejected: counting `more_evidence` as a slip waiting (it would stop the customer uploading what the shop asked for).

## 7. Rollback
`supabase/rollbacks/20261127110000_wallet_deposit_qr_down.sql` then `20261127100000_customer_payment_policy_down.sql` (they refuse while a customer is on `full` or a QR is linked), then delete the two versions from `supabase_migrations.schema_migrations`. Both proven byte-identical in rollback mode.
