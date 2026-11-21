# Rewards, promotion packs, event boards and SKU sync

Server-side points, promotion packs, per-bill number picks and three shared event boards for online-shop customers, plus automatic SKU sync for the back office.
Design: [superpowers/specs/2026-11-21-rewards-boards-sku-sync-design.md](superpowers/specs/2026-11-21-rewards-boards-sku-sync-design.md). Plan and exact contract: [superpowers/plans/2026-11-21-rewards-boards-sku-sync.md](superpowers/plans/2026-11-21-rewards-boards-sku-sync.md).
Migrations: `20261121100000_rewards_core.sql`, `20261121110000_event_boards.sql`, `20261121120000_sku_registry_sync.sql` (each has a file in `supabase/rollbacks/`).
Code: `src/rewards/*` (back office), `src/shop/Rewards.tsx` (customer), `src/domain/skuSync.ts` (sync).

**Status: ships DARK.** Until a Super Admin switches it on (Promotions → Online shop → master switch) nothing changes for customers, orders, invoices or payments.

## What it does

| Need | How |
|---|---|
| Points per amount spent (category or SKU based) | A **points rule**: every complete `spend_step` of eligible spend on one bill earns `reward_amount` points. Eligible = SKUs in the rule's categories / include list, minus the exclude list. |
| "Buy 4 pay 3" packs | A **promotion pack** is a normal sellable SKU (own code, own price, e.g. ฿300) mapped to its underlying SKUs and quantities (4 × bottle). It can earn a fixed number of points per pack (3) or count at an **eligible value** instead of its price. 1 pack = 3 points, 2 packs = 6; never 4 / 8. The order line carries the pack SKU, so every sale is traceable. |
| Number picks on the event boards | A **board-pick rule**: each eligible **bill** earns `floor(eligible bill amount / spend_step) × reward_amount` picks (default step ฿300, 1 pick). |
| Three shared boards | Each event has 3 boards (numbers 0–99 by default), **exclusive** (a number belongs to one account) or **shared** (several accounts may hold it). |
| Product data in sync | The Products page syncs incrementally from the central registry and shows what is inactive or not yet synced. |

### The 300 THB rule (picks), per bill

`picks = FLOOR(eligible bill amount / 300)` for every bill separately, never rounded up, bills are never added together.

| Eligible bill | 299 | 300 | 599 | 600 | 850 | 900 | 1,000 | 1,200 |
|---|---|---|---|---|---|---|---|---|
| Picks | 0 | 1 | 1 | 2 | 2 | 3 | 3 | 4 |

* Two bills of ฿200 earn **nothing**; one of ฿700 plus one of ฿200 earn **2**.
* Only in-scope lines count (include / exclude lists, categories, packs at their eligible value). Shipping never counts.
* The step, the number of picks per step, a cap per bill (`max_per_order`), the dates, the boards and a customer allow-list are all settings of the rule. Nothing is hard-coded.
* Rights are earned when the bill is **fully paid** (invoice status paid / overpaid) and the order is not cancelled or returned. An unpaid bill shows "counts once paid" to the customer.

### How rights are tracked and spent

* One right = one row, unique per `(rule, bill, seq)`. A repeated request, refresh, retry or parallel settle cannot create a second right for the same bill.
* The customer sees: eligible amount per bill, picks **earned**, **used**, **remaining**. A claim always spends the customer's oldest available right; with none left the server refuses (`NO_ENTITLEMENT`).
* A payment reversal, cancellation or return takes back unused rights. A right already **used on a number** is never silently taken: it is flagged **Needs review** and a Super Admin decides to keep it or release the number.
* Rules are **not retroactive**: a new rule starts when it is created unless staff pick an earlier date. A rule that has already given rewards is **frozen** (only its name, on/off and a later end date can change): duplicate it to change how it works. Switching a rule off or letting it end never takes back what was earned.

## Setting it up (staff)

1. **Products** page: let the sync run (banner "Synced … ago"). Inactive SKUs are labelled and cannot be added to new rules or packs.
2. **Promotions → Online shop**: create a rule from a template ("Points per baht spent" or "Number picks per bill"); packs under the Packs tab; the simulator shows what a cart or bill amount earns.
3. **Events → Online shop**: create an event (window, number range, hold minutes, max per customer), link the board-pick rule to it, set the event to *active*.
4. A **Super Admin** switches **Rewards** (and **Event boards**) on, after one real test order.

## Event board controls (Super Admin only, each needs a reason, all audited)

| Operation | Changes | Never does |
|---|---|---|
| Lock / Unlock board | whether customers can pick on it | touch numbers or the mode |
| Switch mode (exclusive ⇄ shared) | the mode for **new** picks | rewrite or delete existing selections |
| Release one number | that selection → released, the pick goes back to its owner | affect other numbers |
| Reset board | every active selection → reset (history kept); picks returned if ticked; you type the board name to confirm | delete anything; **Undo reset** is possible while no number was taken since |
| Needs review | keep or release a number whose bill was taken back | happen silently |

ADMIN staff can see owners and edit event details (not close an event or change the range once numbers are taken); the server enforces every rule. Customers never see other customers' identities.

## SKU sync

* `sku_registry` (central) is the authority for name, price, cost, barcode, brand and active status. The device keeps stock, recipes, reorder levels, images and prep station.
* After sign-in and when Products opens (if the last sync is older than 5 minutes) the device asks only for what changed since its cursor. First sync is a full snapshot. "Re-sync everything" is the manual fallback.
* A failed sync keeps the old cursor and shows an error banner; rows the catalogue refuses are listed and retried at the next sync.
* The Active switch and drawer edits are sent to the registry first and saved on the device only if the registry accepts them, so a later sync never reverts them.

## Security model

* Every table has RLS and **no client policy**; clients only call `SECURITY DEFINER` functions that re-check the caller. Staff = ADMIN / SUPER_ADMIN; board operations, point adjustments, review decisions and the master switch = SUPER_ADMIN.
* Claims lock the board row and the customer; two partial unique indexes are the backstop, so even a bypass of the function cannot give one exclusive number to two accounts.
* Ledger, rights, selections, resets and the audit log are never deleted or edited (guard triggers).
* A reward error never blocks a payment: the three triggers (`finance_receipts`, `finance_allocations`, `shop_orders`) call settle inside an exception block and log `settle_error`. When many payments of one customer collide, a reward update can be skipped (logged) and is healed the next time the customer opens Rewards or staff press re-settle.

## Go-live (in this order; every step after the first needs the owner's explicit go)

1. **Before anything**: run the three SQL suites and the three down-proofs once more on a fresh checkout (`node scripts/local-pg/run.mjs …`, see `scripts/local-pg/README.md`), or in rollback mode against the live project once a valid `~/.supabase-token` exists (`scripts/run-rewards-core-sql-tests.sh` and its two siblings; they were only syntax-checked, never run, because production is off limits to the build). Note that the invented local data cannot prove behaviour on real data: the existing suites fail a few checks on production for the same reason (real orders and wallets).
2. **Read-only before-picture** (`scripts/db-readonly.sh`): counts of `shop_orders`, `finance_invoices`, `finance_receipts`, `finance_allocations`; the md5 of `shop_catalog(...)`; `select count(*) from sku_registry`.
3. **Apply the migrations BEFORE publishing the app**, in one transaction, in this order (one command; it refuses anything already recorded):
   `scripts/apply-migrations.sh 20261121100000:rewards_core:supabase/migrations/20261121100000_rewards_core.sql 20261121110000:event_boards:supabase/migrations/20261121110000_event_boards.sql 20261121120000:sku_registry_sync:supabase/migrations/20261121120000_sku_registry_sync.sql`
   The migration waits at most 3 seconds for the locks of the busy finance and order tables and otherwise rolls the whole batch back; if that happens, retry at a quiet moment. Do it outside opening hours.
4. **After-picture** (read-only): the counts and the catalogue md5 from step 2 are unchanged; `select enabled, boards_enabled from rw_settings` is `false, false`; `rw_settings` has exactly one row; no `rw_*` row exists in the ledger, rights or selections.
5. **Publish the app** (same procedure as the slip review: build, commit `dist/index.html`, push `main`, then `gh-pages`). Until a Super Admin switches rewards on, customers see nothing new; staff see the new "Online shop" tabs and the sync banner on Products (which starts working at once: the first sync is a full snapshot).
6. **Set up** (staff): create the event, its three boards, the pick rule and any packs; use the simulator; check the Products page shows no sync error.
7. **One real test order** paid end to end; confirm the rewards show on the customer's Rewards screen and a reversal takes them back.
8. **Switch on** rewards first (points and picks accrue), the event boards later (a separate switch). Before that, the owner's legal review of purchase-linked prize events (see the Events page notice) must be done.

Rolling the app back does not need the database to move: the screens only call functions that remain. Rolling the database back uses the files below, in reverse order (SKU sync, boards, core).

## Rollback

Each rollback file refuses to run once it would destroy history: core (any ledger, right or sold pack, or while boards are installed), boards (any selection), sync (any change-log row). The sync rollback also restores one widened check constraint on `sku_code_history`.

## Verification (2026-11-21, branch `feat/rewards-boards-sku-sync`; nothing was applied to production)

Run on a local PostgreSQL 17 (`scripts/local-pg/`, invented data, not Supabase) and a fake backend for the screens:

| What | Result |
|---|---|
| SQL suites: rewards core / event boards / SKU sync | 369 / 341 / 119 checks, all passed |
| Rollback proofs (schema identical after rollback) | 10 of 10, for each of the three |
| Existing SQL suites with the new migrations installed | 180, 99, 162, 22, 1000: identical to before |
| Real-concurrency checks (separate connections, committed rows) | core 25, boards 29, SKU sync 29: all passed |
| Unit tests | 972 passed (720 before this work); `tsc` clean |
| Shop browser tests (Playwright, fake backend, one worker) | 317 of 317 passed |
| Production build | built; the page grew by about 192 kB (8.3%) |

Mutation checks show the new tests can fail: removing the activation stamp, the eligibility snapshot or the "nothing outstanding" condition each makes the matching tests fail.

**Not verified**: the six `scripts/run-*.sh` production runners (syntax-checked only: production is off limits to the build, and `~/.supabase-token` was invalid); anything on the real Supabase project, real data or real roles (PostgREST); a real phone or Safari (Chrome at 390 px only); the Thai wording has had no native-speaker review.

## Known limitations

* **Legal review** of purchase-linked prize boards is the owner's responsibility before go-live (the Events page says so).
* **Late rewards under load**: when many payments of one customer collide, the reward update of one of them can be skipped (logged as `settle_error`) and arrives the next time the customer opens Rewards or staff press re-settle. There is no scheduled reconcile.
* **A lapsed hold** is physically released by the next claim, reset, release or staff sweep; readers already treat it as free and the pick as returned.
* **Staff powers kept as built**: any ADMIN can edit central SKU prices (audited in `sku_registry_changes`) and pause an event; closing an event, the number range once numbers are taken, and the six board operations need SUPER_ADMIN.
* **Admin screens**: a customer on a rule's allow-list shows as a short id when the rule is reopened; the staff simulator shows "฿X more" without the resulting total; a held number in "Your numbers" has no Confirm button (the customer confirms at the moment of picking).
* **SKU sync**: names imported from the workbook that start with digits lose them on every sync (as before); friend and wholesale prices stay in the product description, which the device owns.
* **Status of an old customer app**: an app build from before this release keeps working (nothing it calls changed).
