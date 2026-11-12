# Regression Matrix

Feature → regression tests that must be re-run when that feature (or anything it depends on) changes. "Suite" names refer to files: **ENG** `tests/unit/engine.test.ts`, **ACC** `accounting.test.ts`, **PLT** `platform.test.ts`, **AUZ** `authz.test.ts`, **J** `tests/e2e/journeys.spec.ts` (J-numbers = Addendum §3.4 journeys), **RSP** `responsive.spec.ts`, **A11Y/VIS** `a11y-visual.spec.ts`, **PRF** performance. Titles are the executable specification; the generated, per-test list with last result is in `qa/TEST_CASES/`.

**Always run before any change is merged:** `npm run build` (type-check) + ENG + ACC + PLT + AUZ (≈30 s). **Run when UI/CSS/markup changes:** J + RSP + A11Y/VIS (≈2 min). Any change to financial, inventory, points or accounting behaviour must update the invariant/reconciliation tests (`expectIntegrity`, `reconciliation and report integrity`) in the same change (Addendum §19).

| Feature / rule | Regression tests (title keywords) | Suites |
|---|---|---|
| Price, discount, VAT split, rounding to the satang | *pricing, tax and rounding (boundary values)* — 8 price points; discount ≤ order; historical price immutability | ENG |
| Promotions (eligibility, limits, budget, stacking, bundles, disabled rules) | *promotion engine …* | ENG, J6 |
| POS checkout, idempotent double click, receipt, persistence after refresh | *J6*, *J7*, *same idempotency key creates one order* | J, ENG |
| Order state machine, cancellation, returns | *allowed transitions…*, *shipped order cannot be cancelled*, *cancelling a paid, unshipped order keeps money as credit*, *return restocks at original cost* | ENG |
| Marketplace import (idempotent per channel+external id; unmapped SKU parked) | *external imports are idempotent…*, *J7b* | ENG, J |
| Payments: FIFO allocation, overpayment credit, void, refund limits, statement identity, slips | *payments, allocation and receivables* (9), *J8*, *J9* | ENG, J |
| Receivables control account = Σ customer balances | *every control account agrees with its subledger…* | ACC |
| Inventory ledger, WAC, negative-stock policy, transfers, 200 random operations | *inventory ledger, costing and reconciliation* (6) | ENG |
| BOM versions, recipe consumption, production atomicity, waste, snapshots | *BOM, recipes, production and cost snapshots* (7) | ENG |
| Points: earn/expiry/redeem/reverse, batches = balance | *points ledger …*, *J10* | ENG, J |
| Event numbers: uniqueness, race, expiry, reset history | *event numbers and concurrency invariants*, *J13* | ENG, J |
| Journals balanced, rejected when unbalanced, reversal links, period lock | *journals: balance, posting rules and corrections* | ACC |
| Chart of accounts, role-based mapping, effective-dated versions, unmapped = exception | *chart of accounts and mapping controls* (12) | ACC, J (accounting setup) |
| Four-eyes: manual journals, mapping changes, opening balances | *manual journals need a different approver*, *opening balances*, *J12* | ACC, J |
| Non-revenue money (transfers, loans, owner funding, interest) | *money that is NOT revenue or expense* (9) | ACC |
| Tax code versions, sale tax snapshot, VAT report | *tax configuration and snapshots* (4) | ACC |
| Reports reconcile (TB = BS = P&L, cash flow, inventory roll-forward, settlements, dimensions) | *reconciliation and report integrity* (9), *Yesterday → Today → Now*, *J15* | ACC, PLT, J |
| Authorization (matrix, engine-level guard, separation of duties, UI gating) | *authorization: roles…*, *engine-level authorization* (74), *J3* | PLT, AUZ, J |
| Audit trail and mandatory reasons | *audit trail …* (3) | PLT |
| Time zones, day boundaries, month-end, leap day | *dates, time zones and reporting boundaries* (4) | PLT |
| Printing routing, duplicate prevention, reprint audit, offline printer | *printing …*, *J16* | PLT, J |
| Files: content sniffing, malicious/duplicate rejection | *file type is detected from content…*, *J17* | PLT, J |
| Backup / restore | *J18* | J |
| Layout at 10 viewports, dialogs on-screen, touch targets, long text | RSP (15) | RSP |
| Accessibility (light, dark, customer app, labels) | A11Y (4) | A11Y |
| Visual appearance of critical screens (7 screens × desktop/mobile) | VIS (14) | VIS |
| Performance guard (cold start, routes, checkout) | PRF (1) + `scripts/perf.ts` | PRF |
| Seed integrity and scenario scripts | `scripts/seedtest.ts`, `scripts/scenarios.ts` | scripts |

## Impact rules of thumb
| If you change … | Also re-run … |
|---|---|
| `src/domain/accounting.ts`, `setup.ts`, posting roles, chart of accounts | ACC + PLT + J12/J15 + `seedtest` |
| `core.ts` permissions, roles, `guard()` | AUZ + PLT + J3 (and update the `GUARDED` table when adding an operation) |
| `store.ts` (`act`, persistence, freezing) | everything, plus J6/J18 and PRF |
| `styles.css`, `ui/kit.tsx`, any screen | RSP + A11Y/VIS; update baselines **only** after viewing the diff |
| Seed data or `VERSION` | everything (the seed is shared by all suites) |

## Visual baselines
Policy in `qa/VISUAL_BASELINES/README.md`. A baseline change is an approved design change, never a way to silence a failing test.
