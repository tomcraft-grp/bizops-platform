# Production module: design and plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. The owner asked for agents and for one job at a time. Do not commit, push or deploy: the lead does that after the owner says so.

**Goal:** a working BOM → production order → consumption → finished goods receipt → journal → cost and profit flow, for any catalogue product.

**Architecture:** extends the existing in-browser engine (`src/domain`, one `act()` = one all-or-nothing transaction, saved in IndexedDB on that device). New engine file `src/domain/production.ts`; `bom.ts` keeps BOM logic. Screens under `src/production/`, with `src/pages/Production.tsx` as the shell.

**Tech Stack:** React 18, TypeScript, zustand + immer, Vitest, Playwright (shop suite). No new dependency.

## What the audit found

1. `NewBom` crashes when no product has kind `material` (the live catalogue has 0): `find(...)!.id`. `NewOrder` crashes with no BOM (`boms[0].id`) and hardcodes `W3` and `F02`. `BomDrawer` "Add component" has the same crash.
2. Outputs limited to finished/menu/wip: resale products (almost the whole live catalogue) cannot have a BOM.
3. Buttons are shown for `production:create`, but `createBom` needs `production:edit`.
4. `recordProduction` has no idempotency key; consumption is always exactly the BOM; no reversal; `discardDraft` has no `guard`; complete and cancel write no audit.
5. No WIP account. Policy POL-09: "no separate WIP stage".
6. Margins hardcode `/ 1.07`.

## Global Constraints

- NEVER change `LIVE_DB_VERSION` (7) or `VERSION` in `store.ts`: `boot()` replaces the whole database when it differs. All new fields are optional; a saved database without them must load and work.
- Do not touch Supabase, migrations, or call the live project.
- Do not change behaviour of `recordProduction`, `consumeRecipe`, `versionAt`: existing tests and the demo seed use them.
- Accounts only through posting roles (`ROLE_DEFS`, `post()`); never an account code outside `CHART` and `ROLE_DEFS`.
- No hard delete of posted records. Corrections are reversals with a reason.
- Every new message raised with `fail(...)` needs a Thai line in `src/lib/errorMessages.app.ts` (guard test `tests/unit/bilingualErrors.test.ts`). Every new UI text needs Thai (`src/lib/i18n.production.ts`, registered as the other `i18n.*.ts` files are). Formal Thai.
- A missing cost is "unknown", never 0.
- TDD: failing test first, and report that it was seen failing.

## Decisions

**Accounts (added to `CHART` and `ROLE_DEFS`)**

| Role | Account | fsLine / control |
|---|---|---|
| `wip` | 1220 Work in progress / งานระหว่างทำ | inventory / new ControlKind `wip` |
| `prod_var_material` | 5310 Production variance: material / ผลต่างการผลิต: วัตถุดิบ | cogs |
| `prod_var_labor` | 5320 Production variance: labour / ผลต่างการผลิต: ค่าแรง | cogs |
| `prod_var_overhead` | 5330 Production variance: overhead / ผลต่างการผลิต: ค่าโสหุ้ย | cogs |

Reused: `inv_materials`, `inv_goods`, `waste` (5100), `conversion_absorbed` (5400). `ensureProductionAccounts(d)` runs at boot on existing databases: adds only what is missing, never edits or removes. If a code is already used by the owner for something else (different name), that role stays unmapped and posting fails with the existing UNMAPPED_ACCOUNT message.

**Journals**

| Event | Debit | Credit |
|---|---|---|
| Material issue | `wip` | inventory role of each component |
| Labour, overhead, utilities, other | `wip` | `conversion_absorbed` |
| Finished goods receipt | inventory role of the output | `wip` |
| Rejected units, abnormal loss | `waste` | `wip` |
| Cost left in WIP when an order is closed or cancelled | `prod_var_*` by cost element | `wip` (either sign) |
| Reversal | the mirror entry, linked | |

**Costing.** Actual cost, weighted average, and costs follow the physical material. WIP is tracked per order and per element `{ materials, labor, overhead }` (utilities and other count as overhead). The **pool** of an order is derived, never stored: per product the quantity and actual value issued, less returned, less what live receipts, losses and close/cancel variances consumed (each records `consumed: { productId, qty, value }[]`); Σ pool value = `wip.materials` exactly, always.

- A partial receipt of U units (good + rejected) takes, per BOM component, min(pool, gross quantity per unit × U) at the pool's average cost; of a product that is not in the BOM the fraction U / max(U, units left), units left = planned − good so far. Labour and overhead separately: min(pool, estimate per unit × U) when that element has an estimate, else the same fraction.
- One-step run: the run's own issue lines and own conversions belong wholly to its receipt; from the earlier pool it takes only what the BOM (or the estimate) needs beyond that.
- A final receipt takes everything. When earlier receipts are still live, the excess over the need of these U units (per BOM component, and per conversion element with an estimate; never the run's own) is carried only as excess × U / (U + units of the earlier live receipts); the rest goes to `prod_var_*` in the same journal entry (`receipt.variance`), so the mirror of the receipt takes it back too. The first and only receipt carries all actual cost. Rounding dust (0.001 per receipt, 0.01 per receipt) is not an excess.
- Cost splits between good and rejected units pro rata; rejected units never enter stock. An abnormal loss is stated in money and takes material pro rata by value.
- Estimated (made at creation, made again at approval), standard (`stdCost`) and actual are shown apart; variances (material price, material usage, labour, overhead, waste) are analysis. Posted variances: cost left at close or cancel (`order.variances[]`, one entry each time, reversed by reopening), the excess of a final receipt, and the average-cost difference when a receipt or a return is reversed (material variance).
- The profit page deducts production variances and adds back the labour and overhead absorbed into cost (role `conversion_absorbed`), so it ties to the ledger (the only difference left is marketplace fees that are still estimates).

**Status flow.** draft → planned → approved → in_progress → partially_completed → completed; cancelled from any state before a live receipt exists. First issue or cost moves approved to in_progress; a non-final receipt to partially_completed; a final receipt or close to completed (`closedBy`). A closed or cancelled order can be reopened (approve permission, reason): its variances are reversed into WIP and it goes back to partially_completed, in_progress, approved, or planned when it was never approved. An order finished by its last receipt is opened by reversing that receipt; reversing a receipt of a closed order takes the close variance back as well. Old `planned` / `in_progress` orders stay valid; issuing on a `planned` order needs approval first.

**Rules.** Output: any active product. Component: any product except the output itself, a menu item (it holds no stock), or one that would make a circular BOM (the version in effect and any scheduled version of every BOM below are checked). No duplicate component lines. A menu output is a recipe made at sale: it can have a BOM but not a production order, no waste allowance and no other costs, and its BOM cannot be made inactive while the menu item is active. One BOM per product (as today); "Duplicate" copies a BOM to another product as a draft. Creating a BOM as active, activating a version and making a BOM active again need `production:approve`; drafts need `production:edit`. A version that starts in the future cannot be used for an order before its date. Quantities are kept in the product's stock unit; a component may be typed in another unit with a factor (`entry`).

What is left to make = planned − good (rejects have to be made again); shortages and run defaults = gross need for it − pool. Unused material goes back with `returnMaterials` (pool average, reversible). An issue is reversed at its original value only while all of it is still there and what stays behind keeps a cost that material really had; otherwise return. Goods at zero cost need a confirmation, or an issue line marked `unknownCost` before any receipt took cost. An idempotency key is remembered as action + id and refused for another action, order, or a result that was undone. Quantities up to 1e9, amounts up to 1e12. Journals of an order can only be reversed on the order. Audit texts carry no money. The `wip` role needs an account with control `wip`; reconciliation sums every account with that control.

## Review Focus

- Old saved database (no new accounts, no new fields) opens, and a journal posts.
- Same button pressed twice, or the same key sent again: one movement, one journal.
- Owner reverses a receipt after some of the goods were sold (stock short): refused with a clear reason, nothing changed.
- A component with no known cost: refused unless the person confirms, and shown as unknown in the BOM cost.
- Locked accounting period, or an unmapped role: nothing changes, meaningful message in both languages.

## Task 1: model, accounts, reconciliation

**Files:** `src/domain/types.ts`, `src/domain/accounting.ts`, `src/domain/setup.ts`, `src/domain/integrity.ts`, `src/domain/store.ts` (boot call only), `src/pages/AccountingSetup.tsx` (event table row), docs/accounting/ACCOUNTING_POLICY_REGISTER.md (new row, POL-09 kept); test `tests/unit/productionAccounts.test.ts`

Produces (types, all additions optional on saved records):
```ts
interface BomComponent { productId; qty; role; wastePct?: number; entry?: { qty: number; unit: string; factor: number } }
interface BomVersion { ...; laborKnown?: boolean; overheadKnown?: boolean; otherCosts?: { kind: 'utilities' | 'other'; label: string; amount: number }[] }
interface Bom { ...; status?: 'active' | 'inactive' | 'archived' }
interface CostElems { materials: number; labor: number; overhead: number }
interface MaterialIssue { id: ID; no: string; ts: string; userId: ID; lines: { productId: ID; warehouseId: ID; qty: number; unitCost: number; value: number; movementId: ID }[]; value: number; journalId?: ID; reversal?: { ts: string; userId: ID; reason: string; journalId?: ID } }
interface ConversionEntry { id: ID; ts: string; userId: ID; kind: 'labor' | 'overhead' | 'utilities' | 'other'; amount: number; note?: string; journalId?: ID; reversal?: MaterialIssue['reversal'] }
interface LossEntry { id: ID; ts: string; userId: ID; amount: number; note: string; journalId?: ID }
interface GoodsProduced { id: ID; no: string; ts: string; userId: ID; warehouseId: ID; good: number; rejected: number; cost: CostElems; goodValue: number; rejectedValue: number; unitCost: number; final: boolean; movementId?: ID; journalId?: ID; reversal?: MaterialIssue['reversal'] }
ProductionOrder.status adds 'draft' | 'approved' | 'partially_completed'; adds issues?, conversions?, losses?, receipts?: GoodsProduced[], wip?: CostElems, estimate?: { materialsPerUnit: number | null; laborPerUnit: number | null; overheadPerUnit: number | null }, events?: { ts; userId; from; to; note? }[], approvedBy?, varianceJournalId?
```
`ensureProductionAccounts(d: DB): string[]` (codes added). `reconciliationMatrix` gains row `wip` (GL of control `wip` vs Σ order WIP) only when either is non-zero. Integrity picks it up through the matrix.

Tests: default chart valid (`validateCoa`); the four roles resolve; a database stripped of the new accounts and roles gets them once, second run adds nothing; an owner-made 1220 with another name is left alone and `post` on `wip` fails UNMAPPED_ACCOUNT; recon row equal.

## Task 2: BOM engine (`src/domain/bom.ts`)

Produces:
- `validateBom(d, productId, v): string[]` used by create, draft save and activation: no component, qty ≤ 0, waste outside 0–99, duplicate, self, menu component, missing product, circular, negative cost, yield ≤ 0.
- `createBom(...)` accepts `wastePct`, `entry`, `otherCosts`, `laborKnown`, `overheadKnown`, `asDraft?: boolean`; perm `production:edit`; audit `bom.create`.
- `duplicateBom(d, ctx, bomId, productId): ID` (draft version 1), `setBomStatus(d, ctx, bomId, status, reason)`, audit on update, duplicate, status; `discardDraft(d, ctx, bomId, version)` guarded (update the caller).
- `bomRequirement(v, outputQty): { productId; qty }[]` including waste allowance `qty * (1 + wastePct/100)`.
- `bomCost(d, v, warehouseId?)`: `{ lines: { productId; name; unit; qty; unitCost: number | null; cost: number | null; source: 'average' | 'standard' | 'unknown' }[]; materials; packaging; labor: number | null; overhead: number | null; other; batch: number | null; perUnit: number | null; missing: string[] }`. `rollup` stays for existing callers.

Tests: every kind as output and as component (menu component refused), each validation, requirement with waste, unknown cost gives null and is listed in `missing`, cost example 100 units: 10×100 + 5×80 + 100×2 = 1600, 16 per unit, duplicate and status keep history, revision does not change an open order's snapshot.

## Task 3: production engine (`src/domain/production.ts`)

Produces (all take `key?: string`, stored in `d.meta.idem['prod:' + key]`, a repeated key returns the first id):
`createOrder(d, ctx, { bomId, plannedQty, warehouseId, note, dueAt?, draft? })`, `updateDraftOrder`, `planOrder`, `approveOrder` (perm approve), `issueMaterials(d, ctx, id, { lines: { productId; qty; warehouseId? }[]; confirmUnknownCost? }, key)`, `addConversion`, `recordLoss`, `receiveGoods(d, ctx, id, { good; rejected; warehouseId; final; note }, key)`, `runProduction(d, ctx, id, { lines; conversions; good; rejected; warehouseId; final }, key)` (issue + costs + receipt, one transaction), `closeOrder`, `cancelOrder(reason)`, `reverseIssue`, `reverseConversion`, `reverseReceipt` (perm approve, reason required), `orderTotals(po)`, `shortages(d, po)`.

Receipt movement type `prod_output`, refType `production`, refId order id, note carries order no and BOM version. `reverseReceipt`: takes the goods out with `moveStock`; a difference between today's average and the receipt value goes to `prod_var_material`; WIP gets the original cost back and a completed order reopens to partially_completed or in_progress. `reverseIssue` is refused when the order's WIP materials are below the issue value.

Tests: the ten owner scenarios at engine level (create, issue, partial, final, reject, loss, close leftover to variances, cancel, reversals, idempotency, atomic failure on short stock, locked period and unmapped role change nothing, invalid transitions, permissions); after every scenario `expectIntegrity(d)`, all journals balanced, order WIP 0 after completion, stock value = GL.

## Task 4: analysis (`src/domain/productionAnalysis.ts`)

`productCost(d, productId)`, `orderCost(d, po)` (estimated, standard, actual per element, variances, waste), `profitability(d, productId, from?, to?)` using `saleTax` and real order lines (`computeEcon`), returning null where data is missing. `overview(d)`: BOMs, active BOMs, open, in progress, completed, output units, estimated and actual cost, variance, orders with shortages. Tests pin the formulas: GP/unit = net price − cost, margin = GP / net price, price 107 incl. VAT 7% and cost 60 gives 40 and 40%.

## Task 5: screens

`src/pages/Production.tsx` (shell, tabs in the URL `?tab=`): overview, boms, orders, consumption, receipts, costs, history. `src/production/ProductPicker.tsx` (search by name, SKU, legacy SKU, barcode, brand; shows SKU, kind, unit, category, on hand; keyboard; only 50 rows rendered), `BomList`, `BomEditor` (full-width page section, not a modal in a modal; live cost; preview before save), `OrderForm`, `OrderDetail` (record production, issue, costs, receive, reverse, history with journal numbers), `CostTab`, `HistoryTab`. Cards on the overview filter the list below (`Kpi` with `onClick` / `active`, as on Products). A confirmation before posting shows the stock and journal effect. Mapping problems show a banner naming the role. No crash with an empty catalogue, no BOM, or no warehouse. Costs hidden without `finance:cost`.

## Task 6: browser tests and docs

`tests/shop-e2e/production.spec.ts` against the fake backend with a resale-only catalogue (the live situation) at 1440, 820 and 390: scenarios 1–10 through the screens, reload persistence, both languages, axe, no console error, no sideways scrolling. `docs/production.md` for staff and the accountant.
