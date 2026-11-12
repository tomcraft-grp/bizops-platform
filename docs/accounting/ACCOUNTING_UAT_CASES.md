# Accounting UAT Cases

Version 1.0 · Addendum §23.12. The 20 mandatory scenarios, each with its expected outcome, the **automated evidence that already exists** (test title in `tests/unit/*.test.ts` / `tests/e2e/journeys.spec.ts`; last result in `qa/TEST_CASES/`), and the **accountant's own run** — which has **not happened**. Automated tests prove the engine behaves as designed on synthetic data; they do not prove the *design* is the right Thai accounting treatment. That is what the accountant column is for.

Legend — Automated: **Covered** (a test asserts the outcome) · **Partial** · **Gap** (the system does not do this). Accountant run: **Not run** until a named accountant signs.

Any unexplained reconciliation difference, wrong classification, duplicate posting or unbalanced journal found here is **release-blocking** for that workflow.

| # | Scenario | Expected outcome | Automated evidence | Auto | Accountant run (name / date / result) |
|---|---|---|---|---|---|
| 1 | Cash sale | Revenue + output VAT + cost of sales recognised; cash/bank increases (POS recognises to receivable and clears it with the receipt) | `pricing, tax and rounding (boundary values)` (8 price points keep the ledger balanced and split VAT exactly); journey *J6 POS sale*; observed journal patterns in `TRANSACTION_ACCOUNT_MAPPING.md` | Covered | Not run |
| 2 | Credit sale | Customer receivable increases; revenue and VAT posted | `payments, allocation and receivables`; `every control account agrees with its subledger…` | Covered | Not run |
| 3 | Later customer payment | Receivable decreases; **no** new revenue | `a later customer payment is not revenue (only the sale is)` | Covered | Not run |
| 4 | One payment over several invoices | Allocated FIFO; customer subledger = control account | `one payment of ฿3,000 is allocated FIFO across three invoices`; `FIFO ordering is deterministic…`; journey *J8* | Covered | Not run |
| 5 | Inventory purchase | Inventory increases (not expensed); input VAT; payable | observed `grn` journals; `inventory roll-forward ties to the GL`; reconciliation matrix | Partial (no dedicated purchase-posting assertion) | Not run |
| 6 | Sale reduces stock and recognises cost | Stock out at weighted-average cost; COGS posted | `weighted-average cost: inbound at a new cost re-averages, outbound uses the average`; `recipe consumption deducts ingredients at the version effective on the sale date` | Covered | Not run |
| 7 | Production through raw materials → WIP → finished goods | Cost flows correctly through each stage | `production: output, waste and yield are recorded; waste cost is expensed`; `production snapshot keeps its BOM…`. **No WIP stage exists** — cost goes raw → finished goods with absorbed conversion | **Gap (WIP)** / Covered (raw → FG) | Not run |
| 8 | Marketplace fees and settlement differences | Commission, payment fee, shipping subsidy and variance are separate lines | `settlements: received = gross − fees ± variance, and the platform receivable clears`; `estimated fees never produce a "Final" profit label until the settlement is received` | Covered | Not run |
| 9 | Refunds and returns | Revenue, tax, payment and inventory effects all reversed | `a return restocks at the ORIGINAL cost…`; `VAT report: … a return reverses output VAT`; `voiding a receipt keeps the original, reverses the journal and reopens the invoice`; `refunds cannot exceed the refundable overpayment` | Covered | Not run |
| 10 | Transfer between own bank accounts | No effect on revenue or expense | `transfer leaves profit and loss untouched`; `a transfer between own accounts needs two different accounts` | Covered | Not run |
| 11 | Loan principal and interest | Principal on balance sheet; only interest is expense | `loan_received …`, `loan_repaid …`, `interest is the only part of a loan payment that is an expense` | Covered | Not run |
| 12 | Customer advances, wallet / credit balances | Liability treatment per approved policy | `overpayment stays as unapplied credit and can be applied later`; `cancelling a paid, unshipped order keeps the money as customer credit`. Stored-value **wallet** accounting and legal treatment are **not implemented** (POL-14) | Partial | Not run |
| 13 | Business-funded vs platform-funded discounts | Distinguishable in reports | Business-funded discounts post to contra revenue. **Platform-funded discount is not modelled** (POL-11) | **Gap** | Not run |
| 14 | Expense mapping and tax | Correct account; VAT in input VAT | `expenses must use an expense account and keep VAT in input VAT`. Non-creditable VAT not applied (POL-16) | Partial | Not run |
| 15 | Journal balance and invalid posting | Debits = credits; invalid posting rejected | `every posted journal balances to the satang`; `an unbalanced journal is rejected`; `header accounts and inactive accounts cannot receive postings`; `an unmapped posting role blocks the transaction…` | Covered | Not run |
| 16 | Opening balances | Reconcile; traceable to source evidence | `opening balances (§23.10)`: source required, balanced, preparer ≠ reviewer ≠ approver, control accounts refused | Covered | Not run |
| 17 | TB, GL, BS, P&L reconcile | One consistent set of numbers | `trial balance, balance sheet and P&L reconcile to one another`; `cash-flow opening + movements = closing…`; journey *J15* | Covered | Not run |
| 18 | Locked period | Posting blocked, or authorised reopening | `postings into a locked period are blocked; the lock date itself is inclusive`; `reopening a period needs a reason and is audited as critical`; journey *accounting setup … locked period rejects postings* | Covered | Not run |
| 19 | Corrections | Original preserved; auditable reversal/adjustment | `a reversal preserves the original, links to it and nets to zero; a reversal cannot be reversed`; `manual journals need a different approver…` | Covered | Not run |
| 20 | Yesterday → Today → Now | Balances carry forward, no unexplained difference | `Yesterday → Today → Now: opening + movements = closing for every control family on 14 consecutive days` | Covered | Not run |

## Setup-process UAT (Addendum §23.2, §23.10)
| ID | Case | Expected | Evidence | Accountant run |
|---|---|---|---|---|
| AS-01 | Setup checklist reflects reality | Warnings shown for pending mapping change, in-flight opening set, un-reviewed accountant flag | journey *accounting setup: checklist shows the honest state…*; `the demo setup is approved but honestly flagged as not accountant-reviewed` | Not run |
| AS-02 | COA protections | Used account cannot change type / be deleted / be deactivated while mapped or holding a balance | `chart of accounts and mapping controls` (12 tests) | Not run |
| AS-03 | COA import | All-or-nothing, clear error | `COA import is all-or-nothing` | Not run |
| AS-04 | Mapping change control | Four-eyes, effective-dated, none inside a closed period, no direct edits after approval | `mapping changes are four-eyes…`, `once approved, direct mapping edits are refused…` | Not run |
| AS-05 | Setup cannot be approved while a check fails | Approval blocked | `setup approval is blocked while a structural check fails` | Not run |

## Acceptance
> "The accounting set-up, mappings, policies and the results above were reviewed and are accepted / accepted with exceptions / rejected."

| Decision | Accountant (name, licence/registration) | Date | Exceptions |
|---|---|---|---|
| _pending_ | | | |
