# Period-Close Checklist

Version 1.0 · Addendum §23.8, §23.13. Use monthly (and at year end). Tick only with evidence. The system enforces the lock; the checklist is the human procedure around it. **Not yet reviewed or adopted by an accountant.**

| Period | Preparer | Reviewer | Close date | Locked through |
|---|---|---|---|---|
| | | | | |

## A. Before closing
- [ ] All sales/shifts for the period are completed; no orders stuck in a non-terminal state that should be terminal (*Orders → filters*).
- [ ] Marketplace/delivery **settlements** received or explicitly accrued; open platform receivable aged and explained (estimated fees are labelled *Provisional* until the settlement arrives).
- [ ] Customer payments and **payment slips** reviewed (none pending that belong to the period); unapplied credit understood.
- [ ] Supplier **goods receipts and invoices** entered; supplier payments recorded; payables aged.
- [ ] **Stock count / cycle count** posted; variances explained (`inv_adjust` / `waste`); transfers in transit resolved or explained.
- [ ] **Production orders** completed or cancelled; waste recorded.
- [ ] **Expenses** entered with the right account, VAT and branch; receipts attached.
- [ ] **Manual journals** prepared and *approved by a different person*; drafts cleared.
- [ ] **Bank and cash**: statement lines matched; cash-on-hand count recorded; differences explained.
- [ ] Money movements (transfers, loans, owner funding) recorded as such — not as revenue/expense.

## B. Reconcile (Accounting → Reconciliation)
- [ ] Customer receivables = Σ customer balances
- [ ] Platform receivables = Σ unsettled platform orders
- [ ] Supplier payables = Σ open supplier invoices
- [ ] Inventory GL = stock ledger value (+ in transit)
- [ ] Customer credit and supplier deposits agree
- [ ] VAT account = tax base × rates; VAT report reviewed (output − input)
- [ ] Cash & bank reconciled to statements
- [ ] Trial Balance balances; Balance Sheet balances; P&L agrees with TB; cash-flow closes
- [ ] System health: all integrity checks green

## C. Review
- [ ] P&L and balance sheet reviewed for unusual movements (margin, returns, discounts, fees, waste)
- [ ] Provisional (estimated) figures listed and their expected settlement dates noted
- [ ] Tax: VAT summary agreed to the filing workpapers (the prototype report is **not** a filing format)
- [ ] Any change to mapping/tax/accounts this period had approval, effective date and regression evidence

## D. Close
- [ ] *Accounting → Periods → Close period* through the last day of the period (lock date is inclusive). Postings on or before it are now rejected.
- [ ] Export reports/backup for the period (*Settings → Data & backup*).
- [ ] Record sign-off in `ACCOUNTING_RECONCILIATION_MATRIX.md` §4.

## E. Corrections after close
Do not edit. Use *Accounting → Periods → Reopen* (needs `accounting:close`, mandatory reason; audited as critical), post the correction as a reversal + new entry, reconcile again, close again, and record why.

## F. Year end (additionally)
- [ ] Opening balances for the new year carried from the closed trial balance (no unexplained difference)
- [ ] Fixed assets / depreciation, accruals, prepayments, WHT and other items **outside this prototype's scope** handled in the accountant's own workpapers
