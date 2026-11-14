# Tom-Craft Platform

Business operations and commerce management: POS, orders, inventory, purchasing, accounting, daily expenses, customer app (LINE).

> The platform name is defined in one place, `src/brand.ts`. The repository / folder / web path is still called `bizops-platform` on purpose (Supabase redirect URLs and the LINE LIFF endpoint point at `/bizops-platform/`), and so are the internal browser database and `bizops.*` storage keys: renaming them would orphan data that already exists.

A working prototype of the platform described in *Business_Operations_Commerce_Requirements_Scope_v1.0.md*.
It is a real, clickable application running on a **transactional domain engine** — not a mock-up.
Every screen reads and writes the same ledgers (stock, journal, receipts/allocations, points, event numbers).

> Demo business: **Sabaidee Roasters & Café** — roastery + café + retail shop selling through POS, LINE, Shopee, Lazada, TikTok Shop and LINE MAN.
> UI language: English. Currency: THB. All data is fictional and lives only in your browser (IndexedDB).

## Run it

```bash
cd bizops-platform
npm install          # first time only
npm run dev          # http://localhost:5173
```

Or just open the pre-built single file (no server needed):

```
dist/index.html      # double-click; rebuild with `npm run build`
```

First start generates 26 days of trading history (~850 orders, 1,600 journals) in well under a second.
**Settings → Reset demo data** regenerates it; **Export / Restore backup** are also there.

## 10-minute tour

Open **Blueprint & scope → Try these workflows** in the app for guided scripts. Highlights:

| Try | Where |
|---|---|
| Sell a latte with oat milk + extra shot; combo promo applies; pay by PromptPay QR; receipt + kitchen/bar tickets queue | POS |
| Receive ฿3,000 against three open invoices (FIFO or manual); overpay → customer credit | Receivables |
| Approve / reject a payment slip (duplicate detection) | Receivables → Payment slips |
| “Sync” Shopee: orders arrive, an unmapped SKU is parked, a webhook duplicate is ignored; map the SKU → order imports; create & receive a settlement → profit goes Provisional → Final | Channels |
| Pick lucky-draw numbers; try to take a taken number; release/reset with audit | Events, Customer app |
| Change a recipe: active BOM versions are locked, create a new version with an effective date | BOM & production |
| Short transfer: partial receipt, close-short loss | Inventory → Transfers |
| Switch user (top right) to *Cashier*: cost, profit and accounting disappear | Team & access |
| Run the concurrency self-tests and reconciliation checks | System health |
| Be the customer in LINE (redeem, pay with slip upload, shop, pick numbers) | Customer app (LIFF) |

## What is inside

* **POS** (modifiers, barcode, split payments, PromptPay QR, pay-on-account, park/recall), **Orders** (unified model, status flows, returns, credit notes), **Channels** (mapping, fees, error queue, CSV import, settlements), **KDS**.
* **Customers & receivables** (statements, aging, FIFO/manual allocation, credit, slips), **Loyalty** (points ledger, expiry, rewards), **Promotions** (rule engine + “why not applied” simulator), **Events** (boards 00–99).
* **Catalog, Inventory** (movement ledger, transfers with in-transit, counts, lots/expiry), **Purchasing** (PO → partial GRN → landed cost → AP → payments/returns), **BOM & production** (versioned BOM, snapshots, waste, standard vs actual).
* **Accounting** (role-based, versioned posting map; hierarchical chart of accounts; tax-code versions; opening balances with four-eyes; control-account reconciliation; double-entry auto-posting, reversals, period lock, TB / P&L / balance sheet / GL / cash flow / VAT, bank reconciliation), **Profit engine** (waterfall, by channel/branch/product/category/day/customer, Provisional vs Final), **Reports** (Yesterday → Today → Now from the ledger).
* **Printing** (routing, queue, retry, reprint with reason, 58/80 mm/A4 templates, real browser printing), **Media** (type sniffing, checksum, thumbnails, quarantine, signed links + access log), **Team & access** (RBAC matrix, audit log), **Settings**, **System health**, **Blueprint & scope**.

## Architecture (prototype)

```
src/domain/    business rules — pure TypeScript, no UI. One function = one business transaction.
  types.ts       canonical model       core.ts        ids, errors, permissions, audit
  accounting.ts  chart, post(), reversal, period lock     inventory.ts   moveStock() ledger, transfers, counts, lots
  orders.ts      pricing, recognition (stock + revenue + COGS), returns   payments.ts   receipts, allocations, credit, slips, settlements
  promotions.ts  deterministic rule engine      loyalty.ts / events.ts   points ledger, unique number claims
  bom.ts         versions, snapshots, production    purchasing.ts   PO → GRN → AP     printing.ts   routing, queue, documents
  economics.ts   profit engine                  integrity.ts   reconciliations + concurrency self-tests
  seed*.ts       deterministic demo history generated by running the engine
  store.ts       zustand + immer: act(fn) = atomic transaction (throws → nothing changes), IndexedDB persistence
src/pages/     one file per module        src/ui/   design system, charts, shared widgets
scripts/       seedtest.ts, scenarios.ts, perf.ts, qa-evidence.ts, gen-accounting-docs.ts  (npx tsx scripts/<name>.ts)
tests/         unit/ (vitest) and e2e/ (Playwright)        qa/ docs/   QA and accounting deliverables
```

Principles carried over from the requirements: immutable ledgers, balances as projections that must reconcile, cost/BOM snapshots, reversals instead of edits, idempotency keys, deterministic promotions, role-based access with financial sensitivity.

## Quality assurance (QA addendum v1.0) and accounting setup (§23)

| What | Where |
|---|---|
| QA strategy, test plan, defect log, regression matrix, security checklist, performance report, UAT sign-off (blank by design), release checklist, incident runbook | `qa/` |
| Per-test, traceable case lists with the last recorded result (generated) | `qa/TEST_CASES/` |
| Approved screenshots for 7 critical screens × desktop/mobile | `qa/VISUAL_BASELINES/` |
| Raw results of the last runs (vitest, Playwright, performance, summary) | `qa/results/` |
| Accounting deliverables: setup guide, chart of accounts CSV, policy and tax registers, mapping, opening-balance template, reconciliation matrix, UAT cases, period-close checklist | `docs/accounting/` |
| Live gate view | in the app: **Blueprint → Quality & release gates** |

**Status: not production-ready.** Gates E (business: no UAT, no accountant review) and F (production: no server, security review, monitoring, restore evidence, approval) are not met. Nothing in the repo claims a result that was not produced by a recorded run; everything that was not tested is listed as *not run*.

## Verify

```bash
npm run build                  # type-check + production build (dist/index.html)
npm test                       # vitest: unit, integration, accounting, authorization matrix
npm run test:seed              # seed integrity checks + business scenarios
npm run test:e2e               # Playwright (needs Google Chrome; set PW_CHANNEL=msedge for Edge): journeys, 10-viewport responsive matrix, axe accessibility, visual baselines, browser timings
npm run perf                   # engine performance benchmark -> qa/results/perf-engine.json
npm run qa:evidence            # regenerate qa/TEST_CASES, qa/results/summary.json and the in-app gate data; then npm run build
npm run docs:accounting        # regenerate the CSV templates and generated tables in docs/accounting
```

Authorization is enforced **inside the domain engine** for 70 money/approval/accounting/master-data operations (`guard()` in `src/domain/core.ts`), not only in the UI; the remaining operations are listed in `qa/DEFECT_LOG.md`. This is still a client-side prototype: it is **not** a security boundary.

## Honest limits

* **Not multi-user, no server, no real authentication.** It proves workflows and invariants; production needs PostgreSQL constraints/locks (the Blueprint page maps each prototype mechanism to its database equivalent).
* **Marketplace / LINE MAN connectors, the print agent, R2 storage and malware scanning are simulated.** CSV import and browser printing are real.
* **Legal / tax items need professionals:** stored-value wallet (deliberately *not* enabled — only a non-cash credit ledger), prize-event legality, Thai VAT/tax-invoice/WHT rules, PDPA retention.
* **Accounting set-up is not accountant-approved.** Not implemented: withholding tax, e-Tax/PP.30 formats, fixed assets and depreciation, a work-in-process stage, platform-funded discount split, loyalty-points liability, non-creditable VAT posting.
* **Tested on Chrome only**, on one machine, with a ~900-order demo dataset; no real devices, printers, integrations, load test, penetration test, CI or UAT.
* Stored data is cleared when the data `VERSION` changes (no migrations yet).
* Not included from Phase 0: full ERD document, Prisma schema, SQL migrations, API contracts, printer test plan.

See **Blueprint & scope** inside the app for the full coverage matrix, improvements made to the plan, gaps found in the plan, and decisions awaiting owner approval.
