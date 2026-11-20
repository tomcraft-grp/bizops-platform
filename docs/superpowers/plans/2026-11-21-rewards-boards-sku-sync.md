# Rewards, promotion packs, event boards and SKU sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side points, promotion packs, per-bill board picks and three shared event boards for online-shop customers, plus automatic incremental SKU sync, all shipped dark.

**Architecture:** Three additive Supabase migrations (rewards core, event boards, SKU registry sync) exposing SECURITY DEFINER RPCs; a typed client module `src/rewards/api.ts`; back-office tabs on Promotions / Events / Products; a Rewards area in the customer shop. Rewards are a pure reconcile of "paid, not cancelled" orders into append-only ledgers; claims are serialised by a board row lock with a partial unique index as backstop.

**Tech Stack:** PostgreSQL (Supabase, plpgsql), React 18 + TypeScript + zustand, Vite, vitest, Playwright (fake backend), bash SQL runners.

**Spec:** [docs/superpowers/specs/2026-11-21-rewards-boards-sku-sync-design.md](../specs/2026-11-21-rewards-boards-sku-sync-design.md) — read it first; this plan only adds what the spec leaves to the implementer.

## Global Constraints

* Single Supabase project = production. **Never apply a migration, run a non-rollback test, or write data to it.** SQL is verified only (a) by `scripts/run-sql-tests.sh` in rollback mode when `~/.supabase-token` is valid, or (b) on a local throw-away Postgres. Applying to production needs the owner's separate explicit go.
* Additive and backward compatible: no change to `shop_quote_internal`, `shop_place_order`, finance functions or existing columns. Existing orders, invoices, receipts unchanged byte for byte. With `rw_settings.enabled = false` everything behaves as today.
* Never delete or edit in place: ledger, entitlement, selection, reset, audit rows (guard triggers). Corrections are new rows.
* Every new function: `security definer set search_path = public`; `revoke all … from public, anon`; `grant execute … to authenticated` only for client-callable ones; internal helpers get no grant. Every new table: RLS enabled, **no client policies** (clients read through RPCs only).
* Error contract: `raise exception 'CODE'` or `'CODE: detail'` with CODE from the list below (the client maps `^[A-Z][A-Z_]{2,}`); permission failures use `errcode = '42501'`.
* Roles: `profiles.role` USER < ADMIN < SUPER_ADMIN, active status only. Helpers (created in the core migration): `rw_is_staff()` = ADMIN or SUPER_ADMIN, `rw_is_super()` = SUPER_ADMIN, `rw_require_staff(what)`, `rw_require_super(what)`.
* Customer UI Thai-first with English (`src/shop/i18n.ts`); staff UI wraps text in `Tx`/`t()` and Thai goes in the new `src/lib/i18n.rewards.ts` / `src/lib/i18n.skusync.ts` (never in `i18n.backoffice.ts`).
* Legacy local engine (`src/domain/promotions.ts`, `events.ts`, `loyalty.ts`) and its tests are not modified.
* Do not commit; leave changes in the working tree for the coordinator. Do not touch `qa/results/*`, `dist/`, `package.json`, `package-lock.json`. Run only your own test files (`npx vitest run tests/unit/<file>`); Playwright with `--workers=1` and only your own spec.
* Dates `YYYY-MM-DD`; money `numeric(14,2)`; Bangkok time for display.

**Error codes:** `REWARDS_OFF`, `BOARDS_OFF`, `NOT_FOUND`, `BAD_RULE`, `INACTIVE_SKU`, `BAD_PACK`, `EVENT_NOT_ACTIVE`, `BOARD_LOCKED`, `NUMBER_OUT_OF_RANGE`, `NUMBER_TAKEN`, `NO_ENTITLEMENT`, `LIMIT_REACHED`, `HOLD_EXPIRED`, `REASON_REQUIRED`, `CONFIRM_MISMATCH`, `RESET_CONFLICT`, `INVALID_KEY`, `KEY_REUSED`.

## Review Focus

1. A bill of exactly ฿299.99 / ฿300.00 / ฿599.99: floor in `numeric`, never float or rounding up.
2. Two bills of ฿200 must earn nothing (bills are never combined); one of ฿700 and one of ฿200 earn 2.
3. Settle called twice, in parallel, or after a retry creates no extra right or ledger row.
4. Payment reversed, order cancelled/returned after a pick was already used: unused rights revoked, used ones flagged `needs_review`, number untouched.
5. Exclusive claim of a number held by a *shared* participant (and vice versa) after a mode switch; claims with a reused key; claim on a locked board / non-active event / outside the window.
6. A customer can never read another customer's identity or entitlements, nor call any `rw_admin_*`/board operation; ADMIN cannot reset.
7. Inactive or voided SKU: cannot be added to a new rule/pack, but old paid orders that contain it still count.
8. Sync: first sync, no-change sync, status flip, price change, new app-origin SKU, failed sync keeps the old cursor and shows an error.

## Contract (all tasks rely on this; do not rename)

Types are mirrored in `src/rewards/api.ts` (foundation task). JSON keys snake_case.

**Settings** `rw_settings_public() → {enabled, boards_enabled}` (authenticated); `rw_admin_save_settings(p_patch jsonb) → same` (SUPER_ADMIN; keys `enabled`, `boards_enabled`).

**Rules** `Rule = {id, kind:'points'|'board_pick', name, active, starts_at|null, ends_at|null, spend_step, reward_amount, basis:'per_bill'|'cumulative', max_per_order|null, category_codes:text[], include_skus:text[], exclude_skus:text[], include_packs, only_profile_ids:uuid[]|null, event_id|null, board_slots:int[]|null, stats:{bills, granted}}`.
`rw_admin_rules() → Rule[]`; `rw_admin_save_rule(p_id uuid, p_patch jsonb) → Rule` (null id creates; `board_pick` requires `basis='per_bill'` and `event_id`; include SKUs must be active and exist → `INACTIVE_SKU: <code>`); `rw_admin_set_rule_active(p_id uuid, p_active boolean) → Rule`. Rules are never deleted.

**Scope rule (one SQL function `rw_rule_amount(rule, items)` used by settle, simulate and preview):** a line is in scope when its SKU is not in `exclude_skus` and (both `include_skus` and `category_codes` are empty, or the SKU is in `include_skus`, or its `shop_category_of(product_type, domain)` is in `category_codes`). A pack line (SKU in an active `promo_packs`) is in scope only if `include_packs`; its amount is `coalesce(eligible_value, line price) × packs`; a pack whose `points_per_pack` is set is excluded from every `points` rule's step math. Shipping is never counted. Amounts are `numeric`; per bill `reward = least(floor(amount / spend_step) × reward_amount, coalesce(max_per_order, ∞))`.

**Packs** `Pack = {pack_sku_code, name, price, status:'active'|'inactive', active, eligible_value|null, points_per_pack|null, items:[{sku_code, name, qty, status}], sold_packs}`.
`rw_admin_packs() → Pack[]`; `rw_admin_create_pack(p_key uuid, p_name text, p_price numeric, p_items jsonb, p_patch jsonb) → Pack` (issues an FG code via `sku_issue` with `p_key` as client_ref, sets `selling_price`, copies `product_type/domain/brand/unit` from the first component so the shop category matches, `origin='app'`; items = `[{sku_code, qty}]`; no pack inside a pack; components must be active FG); `rw_admin_save_pack(p_pack text, p_patch jsonb) → Pack` (patch: `active`, `eligible_value`, `points_per_pack`, `price`, `name`, `items` — items refused with `BAD_PACK` once sold). Pack points are their own ledger source (`source_key = 'pack:<sku>'`), independent of rules.
`rw_admin_sku_search(p_q text, p_only_active boolean default true, p_limit int default 20) → [{sku_code, name, status, price|null, category, brand|null, is_pack, origin}]` (staff).

**Preview / simulate (read-only, no writes)** `rw_preview_cart(p_items jsonb) → {enabled, lines:[{kind, name, eligible_amount, reward, next_reward_in|null}]}` (customer; only active rules, no ids). `rw_admin_simulate(p_items jsonb, p_profile uuid default null) → [{rule_id, rule_name, kind, eligible_amount, reward, next_reward_in|null, note|null}]`. `p_items = [{sku_code, qty}]`.

**Customer** `rw_my_rewards() → {enabled, boards_enabled, points, points_history:[{at, points, kind:'earn'|'reverse'|'adjust', note, order_no|null}] (last 20), picks:[{rule_id, rule_name, event_id|null, earned, used, remaining, bills:[{order_id, order_no, created_at, eligible_amount, rights, state:'counted'|'waiting_payment'|'taken_back'}]}], selections:[{id, event_id, board_id, board_name, number, status:'reserved'|'confirmed', expires_at|null}]}`. Runs `rw_settle_profile(auth.uid())` first. `earned` = rights not revoked, `used` = status used, `remaining` = available; `rights` per bill = currently counted rights (0 when waiting or taken back).

**Staff** `rw_admin_customer(p_profile uuid) → MyRewards + {profile:{id,name,phone}, needs_review:[ReviewItem]}`; `rw_admin_adjust_points(p_profile uuid, p_points int, p_reason text) → int` (SUPER_ADMIN, reason required); `rw_admin_resettle(p_profile uuid default null) → {profiles, changed}` (staff; null = profiles with a shop order in the last 90 days); `rw_admin_review_queue() → ReviewItem[]`, `ReviewItem = {entitlement_id, profile_id, profile_name, rule_name, selection_id|null, board_name|null, number|null, since}`; `rw_admin_resolve_review(p_entitlement uuid, p_action text /* 'keep'|'release' */, p_reason text) → ReviewItem[]` (SUPER_ADMIN).

**Settle (internal)** `rw_settle_profile(p_profile uuid) → int` (rows changed). Order counts when `rw_settings.enabled`, order status not in (cancelled, returned), `finance_invoice_state_raw(invoice_id) ->> 'status_code'` in (5, 6), and `created_at` inside the rule window. Advisory lock `pg_advisory_xact_lock(hashtextextended('rw:' || profile, 0))`. Triggers (after insert/update of status on `finance_receipts`; after update of status on `shop_orders`) call it inside `begin … exception when others then insert into rw_events_log (…'settle_error'…) end` — a reward error must never abort a payment. Ledger: `rw_points_ledger(id, profile_id, points, kind, source_key, order_id, note, created_by, created_at)`; reconcile writes the difference per `(profile, source_key, order_id)`. Entitlements are unique `(rule_id, source_order_id, seq)`; settle upserts `seq 1..n`, re-activates revoked rows, revokes unused rows newest first, flags used ones `needs_review`.

**Events & boards** `Event = {id, name, description|null, status:'draft'|'active'|'paused'|'closed', starts_at|null, ends_at|null, number_min, number_max, hold_minutes, max_per_customer|null, boards:[Board]}`, `Board = {id, event_id, slot:1|2|3, name, color, mode:'exclusive'|'shared', state:'open'|'locked', rev, taken, total, last_reset_id|null}`.
`rw_admin_events() → Event[]`; `rw_admin_save_event(p_id uuid, p_patch jsonb) → Event` (null id creates + 3 boards "Board A/B/C", range 0–99, `hold_minutes` 0); `rw_admin_set_event_status(p_id uuid, p_status text, p_reason text) → Event`; `rw_admin_save_board(p_board uuid, p_patch jsonb) → Board` (name, colour only). `rw_admin_board(p_board uuid) → AdminBoard = {board, numbers:[{n, holders:[{selection_id, profile_id, name, phone_tail, status, exclusive, at}]}], resets:[{id, at, by_name, reason, returned_picks, affected, undone_at|null}], log:[{at, actor_name, action, reason, detail}]}` (staff). `rw_admin_log(p_event uuid, p_limit int default 50, p_offset int default 0) → [...same log row]`.
**Operations (SUPER_ADMIN, reason required, each returns `AdminBoard`, each writes `rw_events_log` and bumps `rev`):** `rw_board_lock(p_board, p_reason)`, `rw_board_unlock(p_board, p_reason)`, `rw_board_set_mode(p_board, p_mode, p_reason)`, `rw_release_selection(p_selection, p_reason)`, `rw_board_reset(p_board, p_reason, p_return_picks boolean, p_confirm text)` (`p_confirm` must equal the board name, else `CONFIRM_MISMATCH`), `rw_board_undo_reset(p_reset, p_reason)` (`RESET_CONFLICT` if any number is taken since).
**Customer** `rw_board_rev(p_event uuid default null) → {event_status, boards:[{id, rev, state}]}` (null event = the active one); `rw_board_state(p_event uuid default null) → {event:{id,name,status,number_min,number_max,hold_minutes,starts_at,ends_at}|null, boards:[{id, slot, name, color, mode, state, rev, taken, numbers:[{n, s:'free'|'taken'|'mine'|'shared', c}]}], rights:{earned, used, remaining}}`; `rw_claim_number(p_event uuid, p_board uuid, p_number int, p_key text) → {replay, selection:{id, board_id, number, status, expires_at|null}, board:<one board of rw_board_state>, rights}` (server picks the customer's oldest available entitlement allowed for that board slot); `rw_confirm_selection(p_selection uuid) → same without replay`. Exclusive claim needs no active holder on the number; shared claim needs no active *exclusive* holder and none by the same customer; a switch of mode never rewrites selections; `exclusive` is copied to each selection at claim time.

**SKU sync** `RegistryRow = {sku_code, legacy_sku_code|null, sku_category, origin, name_full, brand|null, product_type|null, domain, pack_qty|null, unit_en|null, unit_th|null, barcode|null, status:'active'|'inactive', cost_price|null, retail_price|null, selling_price|null, friend_price|null, wholesale_price|null, ecommerce_price|null, needs_review, review_notes|null, updated_at}`.
`sku_changes_since(p_cursor bigint default null) → {cursor, full, rows:[RegistryRow]}` (staff; null cursor = every row of every origin, `full=true`; cursor = last `sku_registry_changes.id` seen); `sku_set_status(p_code text, p_status text, p_reason text) → RegistryRow`; `sku_set_details(p_code text, p_patch jsonb) → RegistryRow` (keys `name_full, brand, unit_th, barcode, cost_price, selling_price, retail_price, ecommerce_price, product_type, pack_qty`; codes never change); `sku_change_log(p_code text default null, p_limit int default 50, p_offset int default 0) → [{id, at, sku_code, actor_name, changes:{field:{old,new}}}]`.

## File structure

| Path | Owner task | Responsibility |
|---|---|---|
| `src/rewards/api.ts`, `src/lib/i18n.rewards.ts`, `src/lib/i18n.skusync.ts`, `tests/shop-e2e/fakeRewards.ts` (stub) | Foundation | typed contract, i18n files wired into `i18n.ts`, fake hook |
| `supabase/migrations/20261121100000_rewards_core.sql`, rollback, `supabase/tests/rewards_core.sql`, `scripts/run-rewards-core-sql-tests.sh`, `…-down-proof.sh` | T1 | rules, packs, ledger, entitlements, settle, triggers |
| `…20261121110000_event_boards.sql` (+rollback, tests, scripts) | T2 | events, boards, selections, claim, operations |
| `…20261121120000_sku_registry_sync.sql` (+rollback, tests, scripts) | T3 | change feed, status/details RPCs |
| local Postgres harness `scripts/local-pg/*` | T4 | runs migrations + tests (+ concurrency) without production |
| `src/domain/skuSync.ts`, `src/ui/PullSkuButton.tsx`, `src/pages/Products.tsx`, `tests/unit/skuSync.test.ts` | T5 | auto incremental sync, status/ sync banner |
| `src/pages/Promotions.tsx`, `src/rewards/PromotionsOnline.tsx`, `src/rewards/PackEditor.tsx`, `src/rewards/RuleEditor.tsx`, tests | T6 | rules, packs, simulator UI |
| `src/pages/Events.tsx`, `src/rewards/EventsOnline.tsx`, `src/rewards/BoardAdmin.tsx`, tests | T7 | boards and Super Admin controls UI |
| `src/shop/Rewards.tsx`, `src/shop/Account.tsx`, `src/shop/CartPage.tsx`, `src/shop/i18n.ts`, `src/shop/shop.css`, `tests/shop-e2e/fakeRewards.ts`, `tests/shop-e2e/rewards.spec.ts` | T8 | customer rewards, board, cart preview |
| `docs/rewards.md`, `docs/customer-shop.md` row | T9 | operator guide, go-live, rollback |

## Tasks

### Task 0: Foundation (coordinator)

**Files:** Create `src/rewards/api.ts`, `src/lib/i18n.rewards.ts`, `src/lib/i18n.skusync.ts`, `tests/shop-e2e/fakeRewards.ts`; Modify `src/lib/i18n.ts` (merge the two new records after `TH_BACKOFFICE`), `tests/shop-e2e/fakeBackend.ts` (one `FakeRewards` hook line like `FakeWallet`).
**Produces:** `export type Rule/Pack/MyRewards/BoardState/AdminBoard/RegistryRow/…`, `export const rewards = {…}` and `rewardsAdmin = {…}` wrappers over `rpc` from `src/shop/api.ts`, one method per contract function with the exact parameter names above (camelCase args), plus `export class RewardsError`-free reuse of `ShopError`.
- [ ] Write the file from the Contract; `npx tsc --noEmit` passes; `npx vitest run` still 720 passing.

### Task 1: Rewards core migration (SQL)

**Files:** Create `supabase/migrations/20261121100000_rewards_core.sql`, `supabase/rollbacks/20261121100000_rewards_core_down.sql`, `supabase/tests/rewards_core.sql`, `supabase/tests/rewards_core_down_pre.sql`, `…_down_post.sql`, `scripts/run-rewards-core-sql-tests.sh`, `scripts/run-rewards-core-down-proof.sh` (copy the shape of `run-shop-no-brand-*.sh` and `supabase/tests/shop_no_brand.sql`).
**Consumes:** `sku_registry`, `shop_orders`, `shop_order_items`, `finance_invoice_state_raw`, `finance_receipts`, `shop_category_of`, `sku_issue`, `profiles`, `shop_require_user`. **Produces:** the Settings, Rules, Packs, SKU search, Preview/simulate, Customer, Staff and Settle parts of the Contract; tables `rw_settings, promo_packs, promo_pack_items, rw_rules, rw_points_ledger, rw_entitlements, rw_events_log`; `rw_entitlements.event_id` is a plain uuid here (T2 adds the FK).
- [ ] Tests first (`supabase/tests/rewards_core.sql`, rolled back, acts as real shop members like `shop_no_brand.sql`): the per-bill table — 299→0, 300→1, 599→1, 600→2, 850→2, 900→3, 1000→3, 1200→4; two bills of 200→0; 700 plus 200→2; exclude list, category scope, include-SKU scope, pack at eligible value (1 pack ฿300→3 pts, 2 packs→6, never 4/8), `points_per_pack` override not double counted with a points rule, shipping not counted; unpaid bill → `waiting_payment`; receipt reversed → rights revoked, used right → `needs_review` and number unchanged; settle twice → no new rows; `max_per_order`; `only_profile_ids`; inactive SKU rejected on save but old order still counts; customers cannot call `rw_admin_*` (42501) nor read each other's data; ADMIN cannot adjust points; `enabled=false` → zero effect and an order/invoice/receipt created meanwhile are unchanged; trigger error path logs `settle_error` and does not abort a payment.
- [ ] Run (rollback mode) and see them fail; implement the migration; run until `REWARDS_CORE_TESTS n of n passed`.
- [ ] Rollback file refuses when any ledger/entitlement row exists; down-proof script shows schema fingerprint identical before/after.

### Task 2: Event boards migration (SQL)

**Files:** Create `…20261121110000_event_boards.sql` + rollback + `supabase/tests/event_boards.sql` + down-proof files + scripts `run-event-boards-sql-tests.sh`, `run-event-boards-down-proof.sh`.
**Consumes:** Task 1 tables (tests insert entitlements directly as owner, not through settle). **Produces:** Events & boards part of the Contract; tables `rw_events, rw_boards, rw_selections, rw_board_resets`; adds FK `rw_entitlements.event_id → rw_events`; indexes `rw_selections_exclusive_once unique (board_id, number) where exclusive and status in ('reserved','confirmed')` and `rw_selections_shared_once unique (board_id, number, profile_id) where not exclusive and status in ('reserved','confirmed')`; guard trigger forbidding delete and identity edits on `rw_selections`.
- [ ] Tests first: claim happy path; second claim of the same exclusive number → `NUMBER_TAKEN` (also by direct insert bypassing the function → unique violation); more claims than rights → `NO_ENTITLEMENT`; same key replays, different payload `KEY_REUSED`; locked board `BOARD_LOCKED`; event not active / out of window; number out of range; hold expiry sweeps and frees the number and the pick; mode switch keeps rows and blocks cross-mode claims as specified; release one number returns the pick; reset with and without returned picks, wrong confirm text → `CONFIRM_MISMATCH`, ADMIN → 42501; undo reset ok and `RESET_CONFLICT`; `rev` bumps on every change; customers see no identities in `rw_board_state`; board state identical for two different customers apart from `mine`.
- [ ] Implement; run to green; rollback refuses when selections exist; down-proof.

### Task 3: SKU registry sync migration (SQL)

**Files:** Create `…20261121120000_sku_registry_sync.sql` + rollback + `supabase/tests/sku_registry_sync.sql` + scripts.
**Produces:** SKU sync part of the Contract; table `sku_registry_changes(id bigserial, at, sku_code, actor, changes jsonb)` (append-only, staff-only); trigger on `sku_registry` after insert/update writing diffs of the registry-owned columns and setting `updated_at`; must coexist with `sku_registry_guard`.
- [ ] Tests first: full snapshot includes app-origin rows; no-change call returns an empty `rows` and the same cursor; status flip and price change appear once with correct diff; cursor never skips a row written by a later transaction (ids from the sequence, read with the committed max); non-staff 42501; `sku_set_status` writes a log row and is idempotent; codes cannot change; `sku_issue` insert (new app SKU) appears in the feed.
- [ ] Implement, green, rollback, down-proof.

### Task 4: Local Postgres harness (coordinator, after disk is freed)

**Files:** Create `scripts/local-pg/README.md`, `scripts/local-pg/run.mjs`, `scripts/local-pg/concurrency.mjs` (outside the repo's dependency tree: the Postgres binary package is installed in a scratch folder, not in `package.json`).
- [ ] Start a real Postgres, create Supabase stubs (`auth.users`, `auth.uid()` reading `request.jwt.claims`, roles `anon authenticated service_role`, `storage.buckets/objects`), apply migrations 1..N in order, run the three SQL test files, then the concurrency script: 20 parallel `rw_claim_number` on one number → exactly 1 success; 8 parallel settles of one profile → no duplicate rights; 20 claims on 20 distinct numbers with 5 rights → exactly 5 succeed.
- [ ] Output pass/fail counts; exit non-zero on any failure.

### Task 5: Client SKU sync + Products page

**Files:** Create `src/domain/skuSync.ts`, `tests/unit/skuSync.test.ts`; Modify `src/ui/PullSkuButton.tsx`, `src/pages/Products.tsx`, `src/lib/i18n.skusync.ts`.
**Consumes:** `sku_changes_since`, `sku_set_status`, `sku_set_details`, `rewardsAdmin.packs()` (to flag packs). **Produces:** `syncSkus(opts?: { full?: boolean }): Promise<SyncResult>`, `useSkuSync(): { state: 'idle'|'syncing'|'ok'|'error'; lastOkAt: string|null; error: string|null; run(full?: boolean): void }`, `importSkuMaster` extended to accept `RegistryRow[]` of any origin (existing exports unchanged; existing `sku-import.test.ts` stays green).
- [ ] Tests first (supabase client mocked): first sync = full, stores cursor; second sync with no change sends the cursor and applies nothing; a changed price updates the product but not stock/BOM/levels/images/station; a status change to inactive deactivates the local product, reactivation re-activates it; failed sync leaves the cursor and sets `error`; two concurrent calls run once; a SKU that exists locally under its legacy code is re-coded, not duplicated; an app-origin SKU creates a product.
- [ ] Implement: cursor and `lastOkAt` live in `kvGet/kvSet('skuSync')` (not in the main `db`, so no local DB version bump). Run once after staff sign-in and when Products mounts if the last success is older than 5 minutes. Products switch calls `sku_set_status` then re-syncs; the New-product flow calls `sku_set_details` after `reserveSku` so price/cost/barcode exist centrally. Banner "Synced 2 min ago" / "Sync failed — retry" + filters "Inactive", "Not synced yet" and a pack badge. Button text becomes "Re-sync everything".
- [ ] `npx tsc --noEmit`, `npx vitest run tests/unit/skuSync.test.ts tests/unit/sku-import.test.ts tests/unit/sku-codes.test.ts` pass.

### Task 6: Back-office Promotions (Online shop tab)

**Files:** Create `src/rewards/PromotionsOnline.tsx`, `RuleEditor.tsx`, `PackEditor.tsx`, `tests/unit/rewardsRuleForm.test.ts`, optional `tests/shop-e2e/rewards-admin.spec.ts`; Modify `src/pages/Promotions.tsx` (tab bar: "Online shop" default | "POS on this device" = today's page, code unchanged), `src/lib/i18n.rewards.ts`.
**Consumes:** the Rules, Packs, SKU search, simulate and Settings Contract.
- [ ] Pure form logic in `src/rewards/ruleForm.ts` (templates "Points per baht spent" and "Number picks per bill": step 300, reward 1, per bill; validation mirroring the server; `previewRights(amount, step, reward, max)` = floor) with tests: 299→0 … 1200→4.
- [ ] UI: rules table (status, window, usage), 2-template "New rule" flow, SKU picker with search, active/inactive badges and inactive disabled, category checkboxes from the registry, packs tab (create = name, price, components, points per pack, eligible value; shows "sold" and locks contents once sold), simulator (cart or bill amount → rewards per rule, "next reward in ฿X"), master switch card for `rw_settings` (SUPER_ADMIN only). Permission hints only; server enforces.
- [ ] Checks: tsc, own vitest, `npx playwright test -c playwright.shop.config.ts tests/shop-e2e/rewards-admin.spec.ts --workers=1` if written.

### Task 7: Back-office Events (Online shop tab) and Super Admin controls

**Files:** Create `src/rewards/EventsOnline.tsx`, `BoardAdmin.tsx`, tests; Modify `src/pages/Events.tsx` (tab bar as in Task 6), `src/lib/i18n.rewards.ts`.
**Consumes:** the Events & boards Contract, `rw_admin_review_queue/resolve_review`.
- [ ] Event list/editor (window, range, hold, max per customer, rules summary), three board cards (mode badge, lock state, taken/total), board detail (100-cell grid with owner names for staff, holders for shared numbers), tabs History / Resets / Audit / Needs review. Five clearly separate controls with the wording and effects from the spec table; reset opens one confirm panel (reason, "return picks to customers" ticked by default, type the board name); lock/unlock/mode/release use an inline reason field. Buttons hidden for non-SUPER_ADMIN and also fail safely on `42501`. Poll `rw_board_rev` every 5 s while visible; refresh a board only when its `rev` changed.
- [ ] Pure helpers with unit tests (cell status mapping, polling decision); tsc and own tests pass.

### Task 8: Customer shop — Rewards, board, cart preview

**Files:** Create `src/shop/Rewards.tsx`, `tests/shop-e2e/fakeRewards.ts`, `tests/shop-e2e/rewards.spec.ts`; Modify `src/shop/Account.tsx` (entry row "Rewards & event", hidden when `enabled=false`), `src/shop/CartPage.tsx` (preview line from `rw_preview_cart`, failure-silent), `src/shop/i18n.ts`, `src/shop/shop.css`, `tests/shop-e2e/fakeBackend.ts` (one line).
**Consumes:** Customer Contract.
- [ ] Fake first (`FakeRewards.rpc(fn,args)` returning `NOT_HANDLED` otherwise): implements the contract in memory including exclusivity and rights, with the per-bill arithmetic copied from the spec table.
- [ ] Specs: summary shows "Earned 4 · Used 1 · 3 left"; per-bill list; tapping a free number shows the inline confirm bar, Confirm calls claim once (double tap → one call), the grid then reflects the server answer; taken number shows disabled with reason; no rights → board read-only with the hint "฿X more on a bill earns a pick"; locked board banner; server `NUMBER_TAKEN` after a stale tap refreshes the board and shows the Thai message; two customers see the same board; polling updates a number taken elsewhere without reload; 390 px viewport, no horizontal scroll; axe passes.
- [ ] Implement the screen (10 × 10 grid, big tap targets, colours with text/shape not colour alone), cart preview ("฿850 eligible → 2 picks once paid; ฿50 more for a third"). Run `npx playwright test -c playwright.shop.config.ts tests/shop-e2e/rewards.spec.ts --workers=1`, tsc, vitest for shop i18n coverage.

### Task 9: Integration, docs, review (coordinator)

**Files:** Create `docs/rewards.md`; Modify `docs/customer-shop.md` ("Promotions / coupons" row).
- [ ] Merge tracks, `npx tsc --noEmit`, full `npx vitest run` (≥ 720 + new), full shop Playwright suite, `npx vite build --outDir .superpowers/dist-check --emptyOutDir`.
- [ ] SQL: run all three suites + down-proofs on the harness (or rollback mode if the token is renewed); concurrency script.
- [ ] Code review with `superpowers:requesting-code-review`; fix findings; final report to the owner with honest verification status. **Stop before any production apply** and ask.

## Self-review

Spec coverage: Goals 1–3 → T1, T6, T8; 4–5 → T2, T7, T8; 6 → T1/T2 tests; 7 → T3, T5; 8 → Global Constraints + T1 test. Non-goals untouched. The owner's per-bill requirement is the scope rule and test table in T1. Names are single-sourced in the Contract.
