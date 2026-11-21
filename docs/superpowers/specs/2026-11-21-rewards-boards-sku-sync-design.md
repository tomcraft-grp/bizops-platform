# Rewards, promotion packs, Tom-Craft event boards and SKU sync — design

Status: draft for owner approval (direction "Supabase" approved 2026-11-21). Follows the non-goals list of [the slip-review design](2026-11-19-slip-review-eod-design.md) ("loyalty points and rewards in checkout, the 300-for-4 bundle SKU"). Builds on [customer-shop.md](../../customer-shop.md), [wallet-and-payments.md](../../wallet-and-payments.md).

## Intent

Online-shop customers earn **points** and **board picks** from what they buy, can buy **promotion packs** ("4 bottles for ฿300, 3 points"), and pick numbers on **three shared event boards** that every user sees identically and that two people can never both claim. Staff configure all of it in the back office without code. The Products page stops asking staff to re-pull SKUs by hand and shows which products are inactive or out of sync.

Why server-side: today promotions, points, events and the product catalogue live in each browser's IndexedDB (`src/domain/store.ts`). A "unique index" held in browser memory cannot stop two devices claiming number 07, and the online shop has no discount, points or event code at all (`shop_quote_internal` returns discount 0).

## Goals

1. **Type A, category points.** Every `spend_step` baht of eligible spend earns `reward_amount` points; eligible = SKUs in the rule's categories / include list, minus the exclude list. Only qualifying amounts count.
2. **Type B, promotion packs.** A pack is a normal sellable SKU (own code, own price) mapped to underlying SKUs and quantities, with an optional eligible value and points-per-pack override. 1 pack = 4 bottles, ฿300, 3 points; 2 packs = 8 bottles, ฿600, 6 points. The order line carries the pack SKU, so it is traceable. Nothing is double counted.
3. **Type C, board picks, per bill.** Each eligible bill earns `floor(eligible bill amount / spend_step) × reward_amount` picks (defaults: step ฿300, 1 pick). 299 → 0, 300 → 1, 599 → 1, 600 → 2, 850 → 2, 1,000 → 3, 1,200 → 4. Bills are never combined: two bills of ฿200 earn nothing. The eligible bill amount counts only in-scope lines (SKU include/exclude, categories, packs at their eligible value); shipping is not counted. The rule also has a customer allow-list, validity window and allowed boards. The customer sees, per bill, the eligible amount and picks earned, and overall earned / used / remaining.
4. **Three boards per event**, exclusive (a number belongs to one account) or shared (several accounts may hold a number), with explicit, separate Super Admin operations: lock / unlock, change mode, release one number, reset board (reversible), undo reset.
5. **Race-proof claims.** The database decides: row lock per board plus a partial unique index. The frontend only displays the server's answer.
6. **Reversals follow money.** Points and picks are recomputed from what is currently paid and not cancelled/returned. A payment reversal, cancellation or return takes them back; a pick already used on a number is flagged for Super Admin, never silently released.
7. **SKU sync.** `sku_registry` stays the authority. Devices sync incrementally and automatically, every registry change is logged, app-created SKUs reach other devices, status has one owner, and the Products and rule screens show active / inactive / sync age.
8. **Ships dark.** With `rw_settings.enabled = false` the live system behaves exactly as today.

## Non-goals

Cart-level discounts (percent, fixed, coupons, free item) in the shop; spending points on rewards (redemption catalogue); POS / in-store integration (the POS stays on its local engine); partial refunds (the shop has none); changing `shop_quote_internal` or `shop_place_order`; legal sign-off of purchase-linked prize events.

## Anti-goals

Any change to the price, total or invoice of an existing order; a reward bug blocking a payment; deleting or rewriting financial, ledger, selection or audit rows; a customer learning another customer's identity; two accounts holding one exclusive number "because the screen was stale".

## Constraints

Single Supabase project = production. Migration + `supabase/rollbacks/` file + SQL tests per migration; tests run only in rollback mode; applying to the live project needs the owner's separate go. Existing roles: `profiles.role` USER < ADMIN < SUPER_ADMIN; finance roles untouched. Static frontend, so no secrets in the browser. Customer UI Thai-first (`src/shop/i18n.ts`), staff UI `Tx` + `TH_BACKOFFICE`. Hash router.

## Audit findings that drive the design

| Area | Finding (from the code) |
|---|---|
| Storage | Promotions, loyalty, events, products: per-browser IndexedDB; live build seeds them empty. |
| Legacy engine | `bonus_points` and `event_entitlement` divide the whole-order subtotal, not the in-scope amount (`promotions.ts:115,122`). `bundle_price` cannot express "4 of the same". The form has no SKU picker (engine supports `productIds`). **Left unchanged** (anti-goal: no silent change); superseded for live customers by the new engine. |
| Pull SKUs | Manual button per device; re-pulls every row; no cursor; **filters `origin = 'import'`, so SKUs created in the app never reach other devices**; overwrites local price/status/category; row failures only in the console. |
| App-created SKUs | `sku_issue` inserts name only; price/cost/barcode stay on one device, so the shop cannot sell them. |
| Status | Three unrelated layers: `sku_registry.status`, `shop_sku_content.visible/available`, local `products.active`. The Products switch changes only the local one and the next pull reverts it. |
| Registry | `updated_at` exists but is not maintained by a trigger; no change log; rows never deleted (trigger). |

## Approaches considered

* **Pack = a SKU with a mapping table (chosen).** Price stays in the registry, the order item already stores the SKU, no change to checkout. A pack is a real registry row (one per pack, as you asked for "dedicated Promotion SKUs"); no underlying product is duplicated.
* Pack = a discount rule on the underlying SKU ("4 for ฿300"). Needs discount logic inside `shop_quote_internal` (price of every order), and the pack is invisible in order lines. Rejected.
* **Reconcile (chosen) vs event hooks.** Points/picks = a pure function of "paid, not cancelled" orders, applied as deltas to an append-only ledger, run by safe triggers and on demand. Hooks that add/subtract on each event drift when a payment is reversed twice or a retry repeats. Rejected.
* Product sync: pull-all button (today) vs **change feed with a cursor + auto-sync (chosen)** vs moving the whole catalogue to Supabase (rejected: inventory, BOM and POS depend on the local catalogue).

## Design

### Data (three migrations, all additive)

**20261121100000_rewards_core**
* `rw_settings` (single row): `enabled` false, `boards_enabled` false.
* `promo_packs` (`pack_sku_code` PK → `sku_registry`, `active`, `eligible_value` null = payable, `points_per_pack` null = use rules) and `promo_pack_items` (`pack_sku_code`, `component_sku_code` → `sku_registry`, `qty` > 0). A pack cannot contain a pack. Contents are frozen once the pack has been sold (new contents = new pack SKU).
* `rw_rules`: `kind` (`points` | `board_pick`), `name`, `active`, `starts_at/ends_at` (checked against the order's creation time), `spend_step`, `reward_amount`, `basis` (`per_bill`, the default; `cumulative` exists for points rules only and is refused for board picks), `max_per_order`, `category_codes[]`, `include_skus[]`, `exclude_skus[]`, `include_packs`, `only_profile_ids[]` (null = everyone), `event_id`, `board_slots[]`. Include SKUs must be active when the rule is saved.
* `rw_points_ledger` (append-only): `profile_id`, `points`, `kind` (earn | reverse | adjust), `rule_id`, `order_id`, `note`, `created_by`. Balance = sum.
* `rw_entitlements` (one row = one right to pick): `rule_id`, `profile_id`, `event_id`, `source_order_id`, `seq` (1..n within the bill), `status` (available | used | revoked), `used_selection_id`, `revoked_reason`, `needs_review`. **Unique `(rule_id, source_order_id, seq)`**: a repeated request, refresh or concurrent settle can never create a second right for the same bill; a right that was revoked and whose bill is paid again is re-activated, not duplicated.
* `rw_events_log` (append-only audit of every reward and board action).

**Settle** `rw_settle_profile(profile)`, idempotent: under a per-profile advisory lock, for each active rule and each of the profile's *currently eligible* bills (invoice fully paid per `finance_invoice_state_raw`, order not cancelled/returned, inside the window): eligible bill amount = Σ in-scope `line_total` (numeric arithmetic, no float). Pack lines count at `eligible_value × packs`; a pack with `points_per_pack` earns exactly that × packs and is left out of step math (no double count); underlying SKUs count only when sold as themselves. Target per bill = `floor(amount / step) × reward_amount`, capped by `max_per_order`. For a bill that is no longer eligible the target is 0. The difference from what that bill already earned is written as an `earn` or `reverse` ledger row (points) or by activating or revoking that bill's rights, newest-unused first (picks). If a right to revoke is already used on a number, it is marked `needs_review` and Super Admin decides; the number is not released silently. `cumulative` points rules use the profile-level total instead. Triggers on `finance_receipts` (insert, status) and `shop_orders` (status) call it inside an exception block that logs and never aborts the payment; each customer reading their rewards runs it too (self-heal). With `enabled = false` the trigger returns at once.

**20261121110000_event_boards**
* `rw_events` (name, status draft | active | paused | closed, window, `number_min/max` default 0–99, `hold_minutes` 0 = confirm at once, `max_per_customer`).
* `rw_boards` (3 slots per event: name, colour, `mode` exclusive | shared, `state` open | locked, `rev` incremented on every change).
* `rw_selections` (never deleted): `status` reserved | confirmed | released | reset | expired, `exclusive` copied from the board at claim time, `entitlement_id`, `reset_id`, who/when/why. **Partial unique index** `(board_id, number)` where `exclusive` and status in (reserved, confirmed); a second one `(board_id, number, profile_id)` for shared.
* `rw_board_resets` (reset id, board, actor, reason, returned_picks, affected, undone_at).

**Claim** `rw_claim_number(event, board, number, entitlement, key)`: lock the board row, sweep expired holds, check event/board state and window, number range, entitlement ownership and availability, then occupancy: an exclusive claim needs no active holder; a shared claim needs no *exclusive* holder. Insert, bump `rev`, log, return the authoritative board. The same key returns the same result.

**Operations (all separate functions, all audited, all Super Admin; each requires a reason)**

| Operation | What it changes | What it never does |
|---|---|---|
| Lock / unlock board | `state` | touch selections or mode |
| Switch mode | `mode` | delete or rewrite existing selections |
| Release one number | one selection → `released` (pick returned to the owner) | affect others |
| Reset board | active selections → `reset` with a reset id; picks returned only if the box is ticked; typed confirmation = board name | delete history |
| Undo reset | restores that reset's rows if every number is still free | run if anything conflicts |

A number held by an exclusive row cannot be joined by others even after switching to shared; shared rows block new exclusive claims on that number until released or reset.

**Reads.** `rw_my_rewards()` (points; per rule: **earned / used / remaining** picks, a per-bill list of order no, eligible amount, rights earned and whether it counts yet or was taken back, and my selections), `rw_preview_cart(items)` (read-only: what a cart would earn once paid and how much more earns the next right; it does not touch `shop_quote_internal`), `rw_board_state(event)` (numbers as free / taken / mine / shared count, no identities), `rw_board_rev(event)` (three integers; the customer screen polls it every 5 s while visible, and after each action). Staff reads show owners, history, resets and the audit log.

**20261121120000_sku_registry_sync**
* Trigger sets `updated_at` and writes `sku_registry_changes` (`id` bigserial = cursor, `sku_code`, changed fields old → new, actor). `sku_changes_since(cursor)` returns the changed rows plus the new cursor (first call = full snapshot, all origins). `sku_set_status(code, status, reason)` and `sku_set_details(code, patch)` (name, prices, cost, barcode, unit, brand) are staff-only and audited; the New-product flow calls the latter, so app-created SKUs have a price centrally.
* `rw_admin_sku_search(q, only_active, limit)`: SKU or name search with status, price, pack flag, category.

### Client
* **Sync** (`src/domain/skuSync.ts`): runs at staff sign-in and when Products opens (one tiny call when nothing changed). Registry owns name, price, cost, barcode, brand, channel prices, active; the device keeps stock, BOM, levels, images, station. Cursor, last success and last error are stored with the device data; a failed sync shows a visible banner. The Products switch calls `sku_set_status`. The manual button remains as "Re-sync everything".
* **Products page**: sync banner, "Inactive" and "Not in registry yet" filters, pack badge.
* **Promotions page**: tabs "Online shop" (rules, packs, simulator that calls the server) and "POS on this device" (the legacy page, unchanged).
* **Events page**: tabs "Online shop" (three boards, rules summary, selections, history, Super Admin controls, audit) and "POS on this device" (legacy).
* **Shop** (`src/shop`): Account → Rewards: one summary line ("Earned 4 · Used 1 · **3 left to pick**"), the bills that earned them ("Order SO-… ฿850 eligible → 2 picks"), and the board as a responsive 10 × 10 grid. Tapping a free number opens an inline confirm bar (no modal): "Use 1 pick on Board A #07?" Confirm / Cancel; the grid then shows the server's answer. The cart shows "฿850 of eligible items: you will earn 2 picks once paid; ฿50 more for a third" (from `rw_preview_cart`, hidden when no rule applies). Pack lines show "contains 4 × …".
* **Admin simplicity**: the rule form starts from two templates ("Points per baht spent", "Number picks per bill") with the common values prefilled (step 300, 1 pick, per bill); the simulator takes a bill amount or a cart and shows the picks it earns. Only reset asks for typed confirmation; lock, unlock, mode and release take an inline reason field, not a dialog chain.

## Testing

Per migration: SQL tests in rollback mode (`scripts/run-rewards-sql-tests.sh` etc.) and a "down proof"; vitest for client helpers; Playwright with the fake backend extended to the new RPC contract (the fake proves screens, not the database). Cases: every item in your lists (promotion, board, product); the per-bill table (299 → 0, 300 → 1, 599 → 1, 600 → 2, 850 → 2, 900 → 3, 1,000 → 3, 1,200 → 4; two bills of 200 → 0; a bill of 700 plus one of 200 → 2); claiming more than the rights earned fails; settle run twice or in parallel creates no extra right; a payment reversal revokes unused rights and flags used ones; plus regression that an order, invoice and receipt created with the switch off are byte-identical. **Real concurrency** (N parallel claims on one number, parallel settles) needs separate connections and committed rows; that cannot happen in a rolled-back transaction, so it runs on a throw-away local Postgres (Docker) loaded with the migration files.

## Calls I made (change any of them)

1. Points and picks count when the invoice is **fully paid**, not when the order is completed; reversed with the payment. Window uses the order's creation time.
2. Customers never see other customers' identities; staff do.
3. Picks are used at claim time; board number range defaults to 00–99; `hold_minutes` defaults to 0.
4. Rules and packs: ADMIN and SUPER_ADMIN. Lock, mode, release, reset, undo, point adjustments: SUPER_ADMIN only.
5. Reset's "return picks" box defaults to ticked.
6. Legacy local Promotions / Events / Loyalty code and tests stay untouched.
7. Sync policy: the registry owns price and status; the device never overwrites the registry except through `sku_set_status` / `sku_set_details`.
8. Your second message ("every 300 THB on an eligible **bill**") is taken as the rule for board picks and replaces the earlier "accumulates" wording: bills are never combined. Cumulative accrual stays available for points rules only.
9. The eligible bill amount excludes shipping and is the line total after any future order discount, spread across lines in proportion (the shop's discount is 0 today).
10. Rights are earned when the bill is fully paid, as for points (call 1); the customer sees an unpaid bill as "counts once paid".

## Blockers found (not design questions)

* `~/.supabase-token` returns "Invalid access token", so no live diagnostics or rollback-mode SQL tests can run until it is renewed.
* Docker Desktop is installed but its engine is not running; the concurrency proof needs it started.
* Purchase-linked prize boards can fall under Thai lottery / consumer-promotion rules (the existing Events page already warns). Legal sign-off is the owner's before go-live.

## Rollout

Dark by default. Apply order: migration, then publish the app. Each migration is applied only after your explicit go, with before/after read-only checks (order, invoice, receipt counts unchanged; `rw_settings.enabled = false`). Rollback files refuse once any ledger row, pick or selection exists. Switching `enabled` on is a separate step after one real test order.
