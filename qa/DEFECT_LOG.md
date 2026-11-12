# Defect Log

Format: `BUG_REPORT_TEMPLATE.md`. Environment for all entries: local development machine (Windows 11, Google Chrome headless via Playwright / Node 20 Vitest), seeded demo business, commit history of this repository. **Open Critical/High defects known to the author: none.** That is a statement about *known* defects only; see `RELEASE_CHECKLIST.md` for what was not tested.

| ID | Sev. | Module | Title | Status |
|---|---|---|---|---|
| BUG-001 | High | Accounting reports | Balance sheet mis-stated contra accounts (sign) | Closed (fixed + regression test) — **closure approval: not given by a designated owner** |
| BUG-002 | High | Authorization | Sensitive operations were permission-checked only in the UI | Closed for 70 operations; residual list below |
| BUG-003 | High | Engine performance | Every transaction re-walked the whole ledger (≈173–195 ms per sale, growing with data) | Closed (≈20 ms) |
| BUG-004 | Critical | Persistence | Last action lost if the page was refreshed within 600 ms (debounced save) | Closed (save is immediate) |
| BUG-005 | Medium | Responsive UI | Horizontal overflow ≤ 430 px on several screens; small touch targets | Closed |
| BUG-006 | Medium | Accessibility | axe-core: contrast, unlabeled selects, label association, QR role, non-focusable scroll region | Closed |

## BUG-001 — Balance sheet contra-account sign (High)
- **Reproduction:** seeded business → build balance sheet and P&L → compare with trial balance (test *trial balance, balance sheet and P&L reconcile to one another*).
- **Expected:** assets = liabilities + equity (+ current-period earnings) with contra accounts (discounts, returns, accumulated depreciation) carried with their natural sign.
- **Actual:** contra accounts were added with the sign of their parent type, so the sheet did not balance when a contra balance existed.
- **Root cause:** statement lines summed `natural balance` instead of `signed net debit`. **Fix:** `nat(fs, sign)` via `netDebit` and earnings computed from signed revenue/expense balances (`src/pages/AccountingReports.tsx`).
- **Regression test:** `accounting.test.ts :: trial balance, balance sheet and P&L reconcile to one another`.

## BUG-002 — UI-only permission checks (High; Addendum §19 "never rely on UI-only permission checks")
- **Reproduction (before):** call `approveSlip`, `voidReceipt`, `closePeriod`, `decideMapping`, refunds, stock counts… as any user through the engine; only screens passed `perm` to `act()`.
- **Fix:** `guard(d, ctx, permission)` (src/domain/core.ts) as the first statement of 70 state-changing operations. It uses the acting user from `ctx`, denies unknown users, and is bypassed only in seeding mode. Maker-checker rules (preparer ≠ reviewer ≠ approver) still apply after the permission check.
- **Regression test:** `authz.test.ts` — every guarded operation × every seeded user must match the role definitions exactly (denied when the role lacks the permission, never denied when it has it), plus no-partial-write, unknown-user and separation-of-duties cases.
- **Residual (not fixed — would be High for production):** these operations are still callable by any signed-in user at engine level: `createOrder`, `advanceOrder` (the cashier/customer entry points), `importExternalOrder` (webhook path), `moveStock`/`adjustStock`/`createTransfer`/`receiveTransfer`, `earnPoints`/`reversePoints`/`expirePoints`/`issueCoupon`/`redeemReward`, `addCustomer`/`updateCustomer`, `submitSlip`, event customer flows (`claimNumber`, `confirmSelection`, `releaseSelection`, `sweepReservations`), `consumeRecipe`, print-queue internals (`enqueue*`, `processPrintQueue`, `markPrinted`), `reverseJournal`/`post` (internal posting primitives, reachable only through guarded entry points in the UI). Several are legitimately used by customer-facing or system flows and need a distinct "actor type" model that only a real backend can give. **In a production backend every one of these must be authorised server-side.**

## BUG-003 — Immer auto-freeze disabled (High, performance)
- **Reproduction:** `npx tsx scripts/perf.ts` — one POS sale on the seeded dataset (≈920 orders, 1 630 journals, 3 900 stock movements).
- **Expected:** a sale posts in tens of milliseconds. **Actual:** ≈173 ms (p50, freeze off) — immer deep-walked the whole unfrozen ledger on every transaction, so cost grew with data volume.
- **Fix:** `setAutoFreeze(true)` in `src/domain/store.ts` (state is read-only outside `act()`; unit tests now run frozen too). After: ≈20 ms p50. The whole E2E suite passes with frozen state, i.e. no code mutates committed state outside a transaction.
- **Evidence:** `qa/results/perf-engine.json` (both modes recorded).

## BUG-004 — Last action lost on refresh (Critical per §12: "data loss")
- **Reproduction:** E2E *J6 POS sale … persistence after refresh* failed repeatedly: complete a sale, reload immediately → the order was missing.
- **Root cause:** persistence to IndexedDB was debounced by 600 ms; a reload inside that window discarded the pending write.
- **Fix:** persist immediately after every transaction (`src/domain/store.ts`; ≈35 ms serialisation on the seeded dataset). Found and fixed by a second agent session working in parallel; verified again in the final run.
- **Regression test:** the same journey J6 (and J18 backup/restore).
- **Residual:** IndexedDB is per-browser and per-device storage; clearing site data deletes the business. This is a prototype property, not a defect — see *Known limitations*.

## BUG-005 — Responsive overflow and touch targets (Medium)
- Found by `responsive.spec.ts`: page-level horizontal overflow ≤ 430 px on /profit, dashboard, channels, settings, health; POS category chips 10 px high; inline links under 24 px.
- Fixed in `src/styles.css` (flex-shrink, `minmax(0, 1fr)` grids, scrollable card bodies, touch-friendly link rules). Suite: 10 viewports × 25 screens + dialogs + target size + long text.

## BUG-006 — Accessibility (Medium)
- Found by axe-core (WCAG 2.0/2.1 A & AA): colour contrast of muted text, primary buttons, links on tinted banners, avatars, taken-number cells in dark theme; selects without accessible names (POS branch, Events); label/field association; QR code without role; scrollable customer-app region not keyboard-focusable.
- Fixed with design tokens (`--muted`, `--brand`, `--link`, `--on-brand`), computed readable avatar colours, `aria-label`s and `tabIndex`. Suite: axe light + dark on 11 screens, customer app, label check.
- **Residual:** axe finds only part of all accessibility problems; no manual screen-reader or full keyboard audit has been done.

## Test-side corrections (not product defects, recorded for honesty)
Playwright Edge headless crashes on the development machine → suite runs on Google Chrome (`PW_CHANNEL`). An axe scan of the customer app raced a React commit and was stabilised with a short wait. Several early unit tests asserted wrong expectations (credit application limits, order-recognition timing, contra-account sign in the test's own formula) and were corrected after analysis — no test was deleted, skipped or weakened to obtain a green run.
