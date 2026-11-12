# Accounting Setup Guide

Version 1.0 · Implements Addendum §23.1–§23.10 in the screen **Accounting → Setup** (`#/accounting/setup`). Rules for AI agents: §23.14.

> **Not accountant-approved.** The demo business ships with a configured and *approved* setup, but the setup state carries `accountantReviewed = false` and the page says so. Chart of accounts, tax codes, mappings and policies are **proposals** until a qualified Thai accountant has reviewed and approved them. Nothing here is legal, tax or accounting advice.

## 1. Principles built into the system
1. **No hard-coded accounts or tax rates in business logic.** Transactions post to *posting roles* (`cash`, `ar`, `sales`, `output_vat`, …); a versioned, effective-dated mapping turns a role into an account at posting time.
2. **Unmapped or unusable roles block the transaction** with a clear error; nothing is posted to an arbitrary or suspense account (suspense account 8100 exists, is inactive, and is not used by any rule).
3. **Posting is balanced and idempotent**; unbalanced journals are rejected; source documents are preserved; corrections are reversals that link to the original.
4. **Every subledger reconciles to a control account** (`ACCOUNTING_RECONCILIATION_MATRIX.md`). A difference is a release-blocking exception, never hidden.
5. **Maker–checker**: mapping changes, manual journals and opening-balance sets need a preparer and a *different* approver; opening balances also need a distinct reviewer.
6. **Draft / estimated / posted / reconciled are labelled.** Marketplace fees are *estimated* (profit shows "Provisional") until the settlement is received ("Final").

## 2. The seven setup stages (checklist on the Setup page)
| Stage | What you do | Controls enforced by the system | Who |
|---|---|---|---|
| 1 Business profile | Legal name, tax ID, currency (THB), financial-year start, branches, accounting basis, VAT registration, tax-inclusive pricing | Missing profile fields fail the check | Owner/Accountant |
| 2 Chart of accounts | Review the hierarchical chart, add/edit accounts, import CSV (`CHART_OF_ACCOUNTS.csv` format) | Unique codes; posting accounts need a header parent; header/inactive accounts cannot receive postings; a used account cannot change type/normal balance or be deleted; an account mapped to a role or holding a balance cannot be deactivated; CSV import is all-or-nothing | `accounting:create` |
| 3 Tax configuration | Maintain tax codes (VAT 7 %, zero, exempt, out-of-scope, non-creditable) with effective dates | A new rate is a **new version** effective from a date; earlier sales keep their tax snapshot; non-registered business posts no output VAT | `accounting:create` |
| 4 Transaction mapping | Map each posting role to an account | Account kind must match the role (e.g. `sales` → revenue); change after approval needs a proposal with effective date and reason, approved by another user; cannot be effective inside a closed period | propose `accounting:create`, decide `accounting:approve` |
| 5 Opening balances | Enter or import opening balances with a **source reference**; review; approve (posts one balanced opening journal) | Balanced; control accounts (receivables, payables, inventory, VAT, …) are refused because those balances must come from documents; preparer ≠ reviewer ≠ approver | preparer `accounting:create`, reviewer `accounting:view`, approver `accounting:approve` |
| 6 Reconciliation | Open the matrix; every row must agree | Any non-zero difference blocks setup approval | — |
| 7 Approval & lock | Approve the setup for live posting; tick *Reviewed by a qualified accountant* only when that is true | Blocked while any structural check fails; re-opening requires a reason | `accounting:approve` |

Stage owners can be assigned per stage (accountability), shown on the checklist.

## 3. Step-by-step: configure a new business
1. **Reset** to a clean database (*Settings → Data & backup*) — for a real company start with an empty chart and import yours.
2. Fill the **business profile** (stage 1). Choose accrual basis, VAT status, price-inclusive pricing.
3. **Import the chart** (stage 2): prepare it from `CHART_OF_ACCOUNTS.csv` (columns: `code, name, name_th, type, normal, parent, posting, fs_line, cash_flow, tax_code, control, contra`). Mark control accounts with their `control` kind (`ar`, `ap`, `inventory`, `vat`, `customer_credit`, `supplier_deposit`, `cash_bank`, `platform_ar`).
4. Configure **tax codes** (stage 3) with the accountant; confirm the default code.
5. Review **mapping** (stage 4): `TRANSACTION_ACCOUNT_MAPPING.csv` shows every posting role, its default and current account, and the business events that use it. Any role whose account does not fit is flagged.
6. Enter **opening balances** (stage 5) using `OPENING_BALANCE_TEMPLATE.csv`; keep the evidence reference (trial balance date, statement, asset register). Subledger balances (customer invoices, supplier invoices, stock) are entered through *documents*, not through the opening journal.
7. Check the **reconciliation** matrix (stage 6): all rows `ok`.
8. Have the **accountant review**, then approve the setup (stage 7). Only then tick the accountant-reviewed flag.
9. From then on, change mappings/tax/accounts only through the controlled workflows (proposal → approval → effective date), and re-run the ACC regression suite and the reconciliation after each change.

## 4. Changing an approved setting (change control, §23.13)
- Mapping or tax change = new version with **effective date**, **reason**, **second approver**, **audit-log entry**; past postings are never rewritten.
- Direct mapping edits are refused once the setup is approved.
- Regression evidence required for every mapping or posting-rule change: run `npx vitest run tests/unit/accounting.test.ts` and attach the result to the change record.

## 5. Current state of the demo data (generated from the live seed)
<!-- BEGIN:setup -->
_Generated by scripts/gen-accounting-docs.ts from the seeded demo business (fixed date 2026-11-13). Do not edit by hand._

| Stage | Check | Status | Detail |
|---|---|---|---|
| profile | Legal entity, tax ID, currency, financial year, branches | ok | Sabaidee Roasters Co., Ltd. · THB · FY starts 01-01 · 3 branches · accrual basis |
| coa | Chart of accounts is structurally valid | ok | 54 accounts · 41 postable |
| tax | Tax codes configured and effective | ok | 5 tax code versions · default VAT7 · tax-inclusive prices |
| mapping | Every posting role maps to a valid account | warn | 1 change(s) awaiting approval |
| opening | Opening balances approved and posted | warn | 1 posted, 1 still in progress |
| recon | Subledgers reconcile to control accounts | ok | All control accounts agree with their subledgers |
| approval | Setup approved for live posting | warn | v0 approved 2026-10-17 by Naree Wongsakul — NOT yet reviewed by a qualified Thai accountant |
<!-- END:setup -->

## 6. What is NOT implemented (state it to the accountant)
Withholding tax (WHT) and PND forms, e-Tax invoice / PP.30 filing formats, fixed-asset registry and depreciation schedules, payroll, multi-currency revaluation, a separate work-in-process stage (production moves cost from raw materials straight to finished goods with an absorbed-conversion account), platform-funded vs business-funded discount split for marketplace vouchers (only business-funded discounts have their own contra account), bank-feed automation. These are listed in the Blueprint page and must be decided with the accountant.
