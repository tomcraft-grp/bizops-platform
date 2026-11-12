# Accounting Policy Register

Version 1.0 · Addendum §23.9, §23.13. Each row is a policy **as implemented by the prototype**. Status "Proposed" means it is the implementation default awaiting accountant/owner approval — **no policy below has been approved by a qualified accountant.** The approval columns are intentionally blank.

Change rule: a policy change needs authorisation, an effective date, an audit-log entry and regression tests (§23.13). Record every change as a new row; never overwrite history.

| ID | Policy | Implementation | Effective from | Status | Approved by / date |
|---|---|---|---|---|---|
| POL-01 | Accounting basis | Accrual (configurable: accrual / cash flag in profile) | 2020-01-01 (demo) | Proposed | |
| POL-02 | Functional currency | THB, satang precision; each journal balances to 0.01 (rounding plug only for sub-satang splits) | 2020-01-01 | Proposed | |
| POL-03 | Financial year | Starts 01-01 (configurable) | 2020-01-01 | Proposed | |
| POL-04 | Inventory costing | Weighted average cost (WAC), perpetual; inbound at a new cost re-averages; outbound at the average; returns restock at the original cost | 2020-01-01 | Proposed | |
| POL-05 | Negative stock | Not allowed by default (setting `allowNegativeStock`); a failing sale rolls back completely | 2020-01-01 | Proposed | |
| POL-06 | Revenue recognition | POS: at sale. Delivery/LINE/marketplace channels: when the order is shipped/delivered (`recognizedAt`); cost of sales is recognised at the same moment | 2020-01-01 | Proposed | |
| POL-07 | Receipts are not revenue | Customer payments reduce receivables (or create customer credit); only the sale creates revenue | 2020-01-01 | Proposed | |
| POL-08 | Purchases | Goods received increase inventory (raw & packaging vs goods & finished) and input VAT, credit payables; they are not expensed | 2020-01-01 | Proposed | |
| POL-09 | Production | Components consumed at WAC; output valued at consumed cost + absorbed conversion cost; waste is expensed (account *Waste & spoilage*), not capitalised; no separate WIP stage | 2020-01-01 | Proposed — **accountant to confirm WIP treatment** | |
| POL-10 | Sales tax (VAT) | Standard rate from the effective-dated tax register; prices tax-inclusive by default; each sale stores a tax snapshot (code, rate, base, amount, rule version); non-registered businesses post no output VAT | 2020-01-01 | Proposed — **rates and registration to be confirmed** | |
| POL-11 | Discounts | Business-funded discounts post to *Sales discounts (contra revenue)*; platform-funded discounts are **not separately modelled** | 2020-01-01 | Proposed — **gap** | |
| POL-12 | Returns and credit notes | Reverse revenue (contra *Sales returns*), output VAT, payment/credit and stock effects; points earned are reversed but never below the balance | 2020-01-01 | Proposed | |
| POL-13 | Marketplace and delivery platforms | Gross sale to *Platform receivable*; fees (commission, payment, shipping subsidy) **estimated** at sale and replaced by actuals at settlement; difference to *Settlement variance*; profit labelled Provisional until settled | 2020-01-01 | Proposed | |
| POL-14 | Customer credit and prepayments | Overpayments / refunds kept as credit are a liability (*Customer credit liability*), applied to invoices later; wallet/stored value treatment needs legal and accounting review before launch | 2020-01-01 | Proposed — **review required** | |
| POL-15 | Non-revenue money | Transfers between own accounts, loan principal, owner contributions/withdrawals never touch profit and loss; interest is the only expense/income part | 2020-01-01 | Proposed | |
| POL-16 | Expenses | Must use an expense account; the VAT amount entered is always posted to *Input VAT*. A non-creditable tax code (VAT7NC) exists in the register but is **not yet applied by the posting rules** (it would need to be capitalised into the expense) | 2020-01-01 | Proposed — **gap: non-creditable input VAT** | |
| POL-17 | Periods | Closing sets a lock date (inclusive); postings on or before it are rejected; reopening needs `accounting:close` and a reason and is audited as critical | 2020-01-01 | Proposed | |
| POL-18 | Corrections | Original entries are never edited or deleted; reversal journals link to the original and net to zero; a reversal cannot itself be reversed | 2020-01-01 | Proposed | |
| POL-19 | Manual journals | Prepared by one user, approved by a different one (`requireJournalApproval` setting); must balance; cannot post into a locked period | 2020-01-01 | Proposed | |
| POL-20 | Mapping and tax changes | Four-eyes, effective-dated, reasoned, audited; never rewrite earlier postings; refused inside a closed period | 2020-01-01 | Proposed | |
| POL-21 | Loyalty points | Points are a ledger with expiring batches; **no financial liability is accrued for unredeemed points** in the prototype (deferred-revenue treatment requires an accountant decision) | 2020-01-01 | Proposed — **gap** | |
| POL-22 | Dimensions | Journals carry branch (warehouse-derived) and channel dimensions for P&L by dimension; totals of dimensions equal the all-branch figure (tested) | 2020-01-01 | Proposed | |
| POL-23 | Suspense | Suspense account 8100 exists but is inactive; no rule posts to it; an unmapped event is an exception, not a suspense posting | 2020-01-01 | Proposed | |

## Change log
| Date | Policy | Change | Reason | Approved by | Regression evidence |
|---|---|---|---|---|---|
| 2026-11-13 | all | Initial register generated from the implemented behaviour | Addendum §23.13 | _pending_ | `qa/TEST_CASES/ACCOUNTING.md` |
