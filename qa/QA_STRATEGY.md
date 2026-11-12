# QA Strategy

Version 1.0 · Applies to: BizOps prototype (`bizops-platform`) · Source requirements: *Business Operations & Commerce Requirements Scope v1.0* and *QA, Testing & Release Governance Addendum v1.0* (§1–§23)

> **Status statement.** This is a client-side prototype with a transactional in-browser domain engine. It has **no server, no real authentication and simulated connectors**. The strategy below is what was applied to the prototype and what must still be done before production. Results are recorded in `qa/results/` and summarised in `qa/TEST_CASES/`; nothing in this repository claims a result that was not produced by a recorded run.

## 1. Quality principles applied (Addendum §1)
| Principle | How it is applied here |
|---|---|
| Business rules are testable | Rules live in pure domain functions (`src/domain/*`), not in components; each rule has a titled test whose title is the specification. |
| Financial and stock data are consistent and traceable | Append-only ledgers + balanced journals; `runIntegrityChecks` and the reconciliation matrix are asserted after state-changing tests (`expectIntegrity`). |
| Customer and staff data isolation | Role/permission matrix tested for every guarded operation × every seeded user (`authz.test.ts`); customer-app view tested at UI level (E2E J14). **Tenant isolation at database level is not testable without a database.** |
| Screens verified on supported devices | 10-viewport matrix × 25 screens, dialogs/drawers, touch targets, long content, visual baselines (Chrome only). |
| Defects reproduced, prioritised, fixed, regression-tested | `qa/DEFECT_LOG.md`; each fixed defect has a regression test or suite. |
| Releases are evidence-based | `qa/RELEASE_CHECKLIST.md` and the in-app *Blueprint → Quality & release gates* tab show gate status computed from recorded runs. |
| Recoverability | Backup/restore journey (E2E J18) proves export → wipe → import → integrity at prototype level. Infrastructure backup/DR is **not tested**. |

## 2. Scope
**In scope (tested):** pricing/tax/rounding, promotions, points, payments & FIFO allocation, receivables, inventory ledger & WAC, BOM/production, orders & idempotency, event-number uniqueness under concurrency, accounting setup (§23: COA, mapping, tax versions, opening balances, period lock, four-eyes, reconciliation, reports), authorization, audit trail, time-zone/report boundaries, printing routing/idempotency (simulated agent), backup/restore, UI responsiveness, accessibility (automated), visual regression, performance of the engine and the browser build.

**Out of scope / not testable in the prototype:** multi-user concurrency on a shared database, network failure modes of real APIs, webhook signature verification against real providers, real printers, authentication/session security, infrastructure security, monitoring and alerting, production data migration.

## 3. Test levels and tools (Addendum §3)
| Level | Tool | Location | Run |
|---|---|---|---|
| Static analysis / build | TypeScript strict (`tsc --noEmit`), Vite production build | — | `npm run build` |
| Unit + integration (engine) | Vitest, Node, `TZ=Asia/Bangkok` pinned, fixed "now" (2026-11-13 10:30 +07) | `tests/unit/*.test.ts` | `npx vitest run` |
| Authorization matrix | Vitest | `tests/unit/authz.test.ts` | same |
| End-to-end journeys | Playwright (system Chrome), production build via `vite preview`, clock pinned | `tests/e2e/journeys.spec.ts` | `PW_CHANNEL=chrome npx playwright test` |
| Responsive / touch / long content | Playwright | `tests/e2e/responsive.spec.ts` | same |
| Accessibility | `@axe-core/playwright` (WCAG 2.0/2.1 A & AA), light + dark theme, customer app | `tests/e2e/a11y-visual.spec.ts` | same |
| Visual regression | Playwright `toHaveScreenshot` (1 % pixel-ratio tolerance) | baselines in `qa/VISUAL_BASELINES/` | same; update only with `--update-snapshots` after review |
| Performance | Node engine benchmark; Playwright browser timings | `scripts/perf.ts`, `tests/e2e/perf.spec.ts` | `npx tsx scripts/perf.ts`, Playwright |
| Seed integrity / scenarios | scripts | `scripts/seedtest.ts`, `scripts/scenarios.ts` | `npx tsx scripts/seedtest.ts` |
| Evidence generation | script | `scripts/qa-evidence.ts` | writes `qa/TEST_CASES/*`, `qa/results/summary.json` |

## 4. Determinism
- The clock is pinned (`page.clock.setFixedTime` in E2E; fixed `NOW` in unit tests), the demo business is seeded deterministically, time zone is fixed to Asia/Bangkok. Two runs on the same machine produce identical screenshots (verified: baselines created, then re-run green).
- Immer auto-freeze is ON in tests exactly as in the app, so an accidental in-place mutation of committed state fails a test instead of silently corrupting the ledger.

## 5. Environments and test data (Addendum §14)
| Environment | Exists? |
|---|---|
| Local development | Yes (`npm run dev`) |
| Automated test | Yes (local; no CI pipeline configured — **gap**) |
| Staging / UAT | **No** (no server) |
| Production | **No** |

Test data is synthetic, reproducible and contains Thai/English mixed names, THB amounts, VAT cases and boundary values. No production data or credentials exist anywhere in the repository; tests have no network access to payment or marketplace endpoints (connectors are simulated in-process).

## 6. Defect handling (Addendum §12)
Severity definitions and the "no informal waiver of Critical/High" rule are in `BUG_REPORT_TEMPLATE.md`. Release target: **zero known open Critical/High defects** — not "zero bugs".

## 7. Ownership
| Activity | Owner | Status |
|---|---|---|
| Test authoring and execution (automated) | Implementation agent (Claude) | Done for the prototype |
| Code review | **Unassigned** | Not done |
| UAT approvers | **Unassigned** (decision §21) | Not done |
| Accountant review of COA/tax/policies | **Unassigned** | Not done |
| Security review / penetration test | **Unassigned** | Not done |
| Release approval | **Unassigned** | Not done |

## 8. Known strategic gaps (to close before production)
1. A real backend: enforce authorization, idempotency and uniqueness in the database (the engine's guards are the executable specification for that).
2. CI that runs type-check, unit, E2E, axe and visual suites on every change, on at least Chromium + WebKit + Firefox and a real mobile device matrix.
3. Load/soak/concurrency tests against the real stack with agreed targets (§21).
4. Independent security review; dependency and secrets scanning.
5. UAT, accountant review, backup/restore drills, monitoring and alerting evidence.
