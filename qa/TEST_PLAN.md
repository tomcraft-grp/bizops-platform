# Test Plan

Version 1.0 · See `QA_STRATEGY.md` for approach. Statuses are **Passed / Failed / Not run / Blocked**. Numbers are those of the last recorded run (see `qa/results/summary.json`; per-case detail in `qa/TEST_CASES/`).

## 1. Suites and how to execute
| # | Suite | Command | Needs |
|---|---|---|---|
| 1 | Type-check + production build | `npm run build` | Node 20+ |
| 2 | Unit / integration / authorization | `npx vitest run` | — |
| 3 | Seed integrity + scenarios | `npx tsx scripts/seedtest.ts` · `npx tsx scripts/scenarios.ts` | — |
| 4 | E2E, responsive, accessibility, visual | `PW_CHANNEL=chrome npx playwright test` | Google Chrome installed; builds the app and serves it on :4173 |
| 5 | Performance (engine) | `npx tsx scripts/perf.ts` | — |
| 6 | Evidence refresh | `npx tsx scripts/qa-evidence.ts` then `npm run build` | after 2–5 |

Suites 2–5 are deterministic (pinned clock, fixed seed, fixed time zone). Playwright runs with 3–4 workers; the full suite takes about two minutes on the development machine.

## 2. Plan by module
| Module | Automated coverage (suite) | Manual / not covered | Status |
|---|---|---|---|
| Orders & POS | engine.test (orders, pricing, idempotency), E2E J6/J7, responsive POS dialogs | Real barcode scanner, tablet ergonomics | Automated: passed · Manual: **not run** |
| Channels / marketplace | E2E J7b (sync, duplicates, unmapped SKU), engine.test (imports) | Real marketplace APIs/webhooks | Simulated only · **not run** against real providers |
| Payments & receivables | engine.test (FIFO allocation, overpayment, void, statement), E2E J8/J9 | Real bank/QR statements | Automated: passed |
| Customers / app (LIFF) | E2E J14 (customer sees only own data), axe on customer app | Real LINE login | Automated: passed · real LINE **not run** |
| Loyalty / promotions / events | engine.test (points ledger, promotion engine, 20-way number race), E2E J10/J13 | Legal review of purchase-linked prize events | Automated: passed · legal **not done** |
| Inventory / purchasing / BOM | engine.test (WAC, negative stock, transfers, 200 random operations, BOM versions, production atomicity), seedtest | Physical stock counts | Automated: passed |
| Accounting setup & reports (§23) | accounting.test (journals, COA, mapping, opening balances, non-revenue money, tax versions, reconciliation), E2E J12/J15/accounting-setup | **Accountant review**, Thai statutory formats | Automated: passed · review **not done** |
| Authorization & audit | authz.test (matrix), platform.test (roles, audit), E2E J3 (cashier UI) | Server-side enforcement, session management | Engine: passed · server **not applicable yet** |
| Printing | platform.test (routing, idempotency, reprint), E2E J16 | Real printers (58/80 mm, A4, Thai fonts) | Simulated: passed · hardware **not run** |
| Media / files | platform.test (content-sniffing), E2E J17 | Real antivirus/storage | Simulated: passed |
| Backup & recovery | E2E J18 (export → wipe → restore → integrity) | Infrastructure backup, RPO/RTO drill | Prototype level: passed · infrastructure **not run** |
| UI / responsive / a11y / visual | responsive.spec, a11y-visual.spec | Real devices, Safari/Firefox/Edge, screen readers | Chrome automated: passed · rest **not run** |
| Performance | scripts/perf.ts, perf.spec | Load/soak, large datasets, real network | Measured for 1 dataset · load **not run** |

## 3. Entry / exit criteria
- **Entry:** `npm run build` succeeds (type-check clean); seed produces zero warnings and passes integrity checks.
- **Exit for the prototype milestone:** zero failing tests in suites 1–5; no known open Critical/High defect; every skipped area above is stated as *not run*.
- **Exit for production (not met):** Gates A–F of Addendum §20, including UAT sign-off, accountant approval, security review, backup/restore evidence and monitoring.

## 4. Schedule / execution record
| Date (local) | Event | Result |
|---|---|---|
| 2026-11-13 | Full automated run before this report (commit shown in `qa/results/summary.json`) | See `qa/TEST_CASES/*.md` header lines |
| — | Manual exploratory session (Addendum §3.5) | **Not run** |
| — | UAT | **Not run** |

## 5. Test data
Deterministic demo business ("Sabaidee Roasters", 3 branches, ~900 orders, 4 sales channels, 12 control accounts). Boundary data: prices 0.01, 0.05, 0.99, 1.07, 19.99, 107, 12 345.67, 99 999.99; exact promotion thresholds (฿300 vs ฿299); month-end and leap-day dates; midnight 00:00/23:59 Bangkok boundaries.
