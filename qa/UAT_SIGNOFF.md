# UAT Sign-off

Addendum §16. **Status: NOT PERFORMED. No business acceptance has been given.** Nothing in this file may be read as acceptance; every result cell below is intentionally empty. No tester, date, result or approver has been invented.

## 1. Required roles (§16)
Owner/Admin · Manager · Cashier · Warehouse/Purchasing · Accountant · Kitchen/Production staff · Customer.

## 2. Approvers (decision §21 — not yet named)
| Role | Name | Authority | Date |
|---|---|---|---|
| Business owner / UAT approver | _unassigned_ | accepts business workflows | |
| Qualified Thai accountant | _unassigned_ | accepts chart of accounts, tax set-up, policies, opening balances | |
| Release approver | _unassigned_ | production release | |

## 3. How to run UAT in the prototype
1. Open the app, *Settings → Reset demo data* (or use a fresh browser profile) so every tester starts from the same synthetic data.
2. Sign in as the tester's role through the user menu (top right). The cases below say which role.
3. Execute the steps; record **test case, tester, date, result, defect ID (if failed)**. Failed Critical/High cases block acceptance (`BUG_REPORT_TEMPLATE.md`).
4. Business sign-off requires every case *Passed* or an approved, documented exception.

## 4. Cases (script) — Result / Tester / Date / Defect to be filled by real testers
| ID | Role | Task and expected outcome | Result | Tester | Date | Defect |
|---|---|---|---|---|---|---|
| UAT-01 | Cashier | Ring up a latte with oat milk and a croissant, pay cash, see the combo discount and a receipt; the order appears in *Orders* | | | | |
| UAT-02 | Cashier | Try to open *Accounting*, *Profit*, *Team* (direct URL too): access is denied; product cost is not visible | | | | |
| UAT-03 | Manager | Cancel an unshipped paid order with a reason; the money stays as customer credit | | | | |
| UAT-04 | Cashier | Try to cancel an order or approve a payment slip: action is refused with a clear message | | | | |
| UAT-05 | Accountant | Approve a payment slip; one receipt is created and allocated oldest-invoice-first; the customer's statement agrees | | | | |
| UAT-06 | Accountant | Walk the *Accounting setup* checklist; read every warning; confirm the accountant-review flag is NOT ticked until the real review happens | | | | |
| UAT-07 | Accountant | Prepare a manual journal, have another user approve it; try to approve your own: refused | | | | |
| UAT-08 | Accountant | Close a period, try to post into it (blocked), reopen with a reason (audited) | | | | |
| UAT-09 | Accountant | Run Trial Balance, Balance Sheet, P&L, VAT report; control-account reconciliation shows no unexplained difference | | | | |
| UAT-10 | Warehouse | Receive stock, transfer between warehouses, count stock; negative stock is refused | | | | |
| UAT-11 | Purchasing | Create a PO, receive goods, record a supplier invoice and payment; payables agree | | | | |
| UAT-12 | Kitchen | Use the kitchen display to advance a ticket; cannot cancel orders | | | | |
| UAT-13 | Customer | In the customer app, see only your own points, orders and slips; redeem a reward once | | | | |
| UAT-14 | Customer | Pick an event number; a number already taken by someone else cannot be selected | | | | |
| UAT-15 | Owner | Export a backup, reset, restore; data is back | | | | |
| UAT-16 | Owner | Import a marketplace sync; duplicates are ignored, unmapped SKUs are parked for mapping | | | | |
| UAT-17 | Any | Use the app on a phone (portrait) for POS and orders: nothing overflows, buttons are tappable | | | | |
| UAT-18 | Any | Print a receipt on the real printer model(s) in use (when hardware exists) | | | | |

Accounting-specific UAT (20 scenarios from Addendum §23.12): `docs/accounting/ACCOUNTING_UAT_CASES.md`.

## 5. Acceptance statement (to be completed by approvers)
> "I have reviewed the results above and accept / accept with listed exceptions / reject the release scope."

| Decision | Name | Role | Signature | Date |
|---|---|---|---|---|
| | | | | |
