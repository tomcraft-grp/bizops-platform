# Release Checklist

Addendum §13, §17, §20. Status values: **Done (evidence)** · **Not done** · **Not applicable yet** · **Partial**. A box is ticked only where recorded evidence exists in this repository.

## 0. Verdict
**This build is a prototype and is NOT approved for production use.** Gates E (Business) and F (Production) are not met. The release target (Addendum §22) is *zero known open Critical/High defects*, which holds for the known defect list (`DEFECT_LOG.md`), but known defects ≠ all defects: large areas below were not tested.

## 1. Production Release Readiness (§17)
| # | Item | Status | Evidence / gap |
|---|---|---|---|
| 1 | Release scope and acceptance criteria approved | **Not done** | Acceptance criteria exist as tests/cases; no approver named (§21) |
| 2 | No open Critical or High defects | **Done for known defects** | `DEFECT_LOG.md` (BUG-001…006 closed). Residual High *risk* for production: operations without engine-level guard (BUG-002 residual) |
| 3 | Unit, integration, E2E, affected regression tests pass | **Done (local)** | `qa/results/summary.json`; `qa/TEST_CASES/*.md` |
| 4 | Payment, inventory, customer, accounting reconciliations pass | **Done on demo data** | `reconciliation and report integrity`, `integrity` checks, `docs/accounting/ACCOUNTING_RECONCILIATION_MATRIX.md`. Not run on real data |
| 5 | Role and cross-customer access tests pass | **Partial** | Engine matrix 70 operations × 10 users; customer UI isolation (J14). No server-side/IDOR tests (no server) |
| 6 | Responsive and visual checks pass on supported viewports | **Partial** | 10 viewports × 25 screens + 14 baselines — Chrome only; "supported viewports" not yet defined by an owner |
| 7 | Supported browser/device checks pass | **Not done** | Chrome (Windows) only; Edge headless failed to launch on the test machine (environment), Safari/Firefox/Android/iOS not run |
| 8 | Performance targets meet approved thresholds | **Not done** | No targets agreed; measurements in `PERFORMANCE_TEST_REPORT.md` |
| 9 | Logs, monitoring and alerts operational | **Not applicable yet** | No server. In-app audit log and *System health* page exist |
| 10 | Backup and restore evidence is current | **Partial** | Local export → wipe → restore → integrity (J18). No infrastructure backup/DR |
| 11 | Migration and rollback/forward-fix plans approved | **Not applicable yet** | No database. Local data model has a `VERSION` counter that resets stored data on a version bump (**destructive for any real local data — must become a migration before real use**) |
| 12 | UAT signed off | **Not done** | `UAT_SIGNOFF.md` blank by design |
| 13 | Release notes and known limitations documented | **Done** | Section 4 below; `README.md` |
| 14 | Post-deployment smoke tests ready | **Partial** | Journeys J6/J15 + `scripts/seedtest.ts` are the intended smoke set; not wired to a deployment |

## 2. Governance steps (§13)
| Step | Status |
|---|---|
| 1 Code branch and review | Local git history only; **no peer review** |
| 2 Static checks and unit tests | Done (type-check + 217 unit tests) |
| 3 Build and migration validation | Build done; migration N/A |
| 4 Integration and E2E tests | Done (local) |
| 5 Staging deployment | Not applicable yet (no staging) |
| 6 Business UAT | **Not done** |
| 7 Visual/responsive review | Automated only; no human design review |
| 8 Security/permission review | Automated rules only; **no security review** |
| 9 Backup and recovery/rollback readiness | Prototype level only |
| 10 Authorised production approval | **Not done** |
| 11–12 Production deployment and smoke tests | Not applicable |

## 3. Quality gates (§20)
| Gate | Status | Why |
|---|---|---|
| A Design ready | Partial | Rules, permissions, failure states documented; §21 decisions open |
| B Implementation ready | Partial | Type-check + unit pass; no independent code review |
| C Integration ready | Partial | Atomicity/idempotency tested; no real API or provider |
| D User-experience ready | Partial | E2E/responsive/visual/axe pass in Chrome; no manual accessibility/usability, no other browsers |
| E Business ready | **Not met** | No UAT; no accountant review |
| F Production ready | **Not met** | No server, security review, monitoring, restore evidence, approval |

Live view of the same table: *Blueprint → Quality & release gates* (numbers come from the last recorded runs).

## 4. Release notes and known limitations
- Client-only prototype; data lives in the browser (IndexedDB). Clearing site data deletes it. Use *Settings → Data & backup*.
- No authentication: the "current user" is chosen from a menu. Permissions are enforced by the in-browser engine (70 operations) — **not a security boundary**.
- Marketplace, LINE, payment and printer connectors are simulated.
- Accounting set-up was **not reviewed by a qualified Thai accountant**; the app flags this on the Setup page. Not implemented: withholding tax, e-Tax invoice/PP.30 formats, fixed-asset depreciation schedules, a separate work-in-process stage (production posts raw material → finished goods directly).
- Event/prize features may fall under Thai gambling/lottery/consumer-promotion rules — legal review required before launch.
- Demo-data version bumps clear local data.

## 5. Deployment evidence (to be filled per release)
| Field | Value |
|---|---|
| Release version / commit | |
| Environment | |
| Approver (name, role, date) | |
| Pre-deploy backup reference | |
| Migration plan / rollback or forward-fix statement | |
| Post-deploy smoke result | |
| Monitoring check | |

## 6. Re-verification commands (copy/paste)
```
npm run build
npx vitest run
npx tsx scripts/seedtest.ts && npx tsx scripts/scenarios.ts
PW_CHANNEL=chrome npx playwright test
npx tsx scripts/perf.ts
npx tsx scripts/qa-evidence.ts && npm run build   # refresh evidence, then embed it in the app
```
