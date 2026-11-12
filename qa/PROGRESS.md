# QA & Accounting Addendum — working notes (paused 2026-11-13 ~03:40, resume 04:30)

Source documents: `Business_System_QA_Testing_Release_Governance_Addendum_v1.0.md` (§3–§6, §18, §23).
These are working notes, not release evidence. Nothing here is a sign-off.

## Verified so far (last executed results)
| Area | Result | How to rerun |
|---|---|---|
| Unit/integration (vitest) | 143/143 passed (before the latest UI-only edits) | `npx vitest run` |
| E2E journeys (Playwright, Chrome) | 16/16 passed | `PW_CHANNEL=chrome npx playwright test tests/e2e/journeys.spec.ts` |
| Responsive matrix | 15/15 passed (10 viewports × 25 routes, dialogs, touch targets, long text) | `.../responsive.spec.ts` |
| Axe (WCAG A/AA) | **FAILING** – see below | `.../a11y-visual.spec.ts -g "axe\|labels"` |
| "forms have labels" | passed | same |
| Visual baselines | **not yet created** | `-g visual --update-snapshots`, then rerun to confirm stable |

## In-flight: accessibility fixes (patch 7 applied, rebuilt, axe re-run)
Fixed by patch 7: avatar contrast (`readablePair` in `src/ui/kit.tsx`), `--muted` darkened to `#6a6963`, `aria-label` on POS branch select and Events selector, LIFF green darkened to `#047a3b`.

Remaining `color-contrast` (serious) after patch 7, light theme only listed so far; dark theme not yet seen:
- `.primary` buttons (white on `--brand #2a78d6` = 4.42:1) → darken `--brand` for button backgrounds (~`#2370c8`), check `.primary.sm`
- `.mb8` on `/accounting/setup` (2 nodes) – inspect
- Banner link `.banner > div > a[href="#/channels?tab=settlements"]` on `/` (link colour on banner background)
- `/blueprint`: `.row > a[href$="#/pos"]` (10 nodes, links)
- `/events`: `button[title="Kritsada Saelim (confirmed)"]` (9 nodes; number-grid status colours)
Then rerun axe light + dark + LIFF until no critical/serious.

## Still to do (in order)
1. Finish axe fixes above → visual baselines (create, then rerun to confirm stable).
2. Authorization audit: many `run()` calls in UI lack the `perm` option (UI-only gating). Add `perm` to sensitive actions (advance/cancel/return/void/reject slip, close period…) and add vitest cases for engine-level permission denial.
3. Performance measurements (real numbers: seed time, action latency, dataset size) → PERFORMANCE_TEST_REPORT.
4. Write §18 + §23.13 deliverables honestly under `qa/` and `docs/accounting/` (QA_STRATEGY, TEST_PLAN, TEST_CASES, BUG_REPORT_TEMPLATE, REGRESSION_MATRIX, SECURITY_TEST_CHECKLIST, PERFORMANCE_TEST_REPORT, UAT_SIGNOFF, RELEASE_CHECKLIST, INCIDENT_RUNBOOK; ACCOUNTING_SETUP_GUIDE, CHART_OF_ACCOUNTS.csv, ACCOUNTING_POLICY_REGISTER, TAX_CONFIGURATION_REGISTER, TRANSACTION_ACCOUNT_MAPPING.csv, OPENING_BALANCE_TEMPLATE.csv, ACCOUNTING_RECONCILIATION_MATRIX, ACCOUNTING_UAT_CASES, PERIOD_CLOSE_CHECKLIST). Statuses must be passed / failed / not run / blocked — no fabricated results. State limits: no backend, no real auth, simulated connectors, accountant review NOT done, UAT unsigned.
5. Optional in-app "Quality & release gates" tab (Blueprint) from `qa/results/*.json`; npm scripts (`test`, `test:e2e`, `qa:evidence`); README update.
6. Full re-verification (tsc, vitest, seedtest/scenarios scripts, Playwright), rebuild `dist/index.html`, commit (message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), final honest report in Thai (changed files, behaviour changes, tests executed/results, known issues, next steps).
7. Ask the user before deleting the ~25 leftover PNG screenshots in `C:\Users\ASUS\` (exact names only).

## Practical notes
- E2E needs system Chrome: `PW_CHANNEL=chrome` (Edge headless fails here). Build first: `npm run build` (tests run against `vite preview` on :4173).
- Patch scripts: write to `scripts/_patchN.cjs` with the Write tool, run, then delete that exact file (`node -e` quoting breaks in bash).
- Bump `VERSION` in `src/domain/store.ts` and `version` in `seedData.ts` when seed/shape changes (currently 5).
