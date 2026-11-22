# LINE OA Order Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New online orders appear as Flex cards in one admin LINE group; admins accept, accept + approve payment, or reject from the card; the bank reference becomes optional at Confirm and Post.

**Architecture:** One dark migration adds LINE tables, an outbox queue fed by triggers, service-role RPCs and the finance changes. Two Edge Functions do the network work: `line-webhook` receives signed events and calls `line_act`, which acts *as the linked staff member* through the existing order and finance functions, and `line-dispatch` drains the outbox with retries. `pg_net` kicks the dispatcher and `pg_cron` runs it every minute. A Settings card configures it all, and deep links open the existing back office on the right record.

**Tech Stack:** Supabase Postgres (plpgsql, Vault, pg_net, pg_cron), Supabase Edge Functions (Deno, `npm:@supabase/supabase-js@2.49.1`), React 18 + react-router 6 (HashRouter), vitest, Playwright (fake backend).

**Spec:** [docs/superpowers/specs/2026-11-22-line-order-notifications-design.md](../specs/2026-11-22-line-order-notifications-design.md)

## Global Constraints

- Work on branch `feat/line-order-notifications` in a new worktree from `main` (superpowers:using-git-worktrees). The main checkout carries other in-progress work (categories, payment integrity, feedback closure): never touch it. Copy the spec and this plan into the worktree and commit them first.
- One Supabase project = production. SQL is only sent through `scripts/run-sql-tests.sh` (one transaction that ends in a forced rollback). Do **not** apply the migration, deploy functions or publish the app in this plan: that is a separate step the owner triggers (Task 10 writes the checklist).
- Migration `supabase/migrations/20261122130000_line_order_notifications.sql`; rollback `supabase/rollbacks/20261122130000_line_order_notifications_down.sql`; SQL tests `supabase/tests/line_notifications.sql`, marker `LINE_TESTS`.
- Finance functions that change are **copied from `supabase/migrations/20261120100000_slip_review.sql` and changed only where marked** with `-- LINE:` comments (the convention of `20261122120000_finance_payment_integrity.sql`).
- Dark by default: `line_settings.enabled = false`, `quick_approve_enabled = false`. With LINE off, nothing is queued. The optional bank reference is **not** behind a switch (owner's decision), so the docs list it under "not dark".
- Credentials (channel secret, access token, dispatch secret) live only in Vault under the names `line_channel_secret`, `line_channel_token`, `line_dispatch_secret`. They never reach the browser or logs, and the Edge Functions redact them from every error they store or return.
- Defaults: `quick_approve_max_amount = 3000`; `reject_reasons = {'สลิปไม่ถูกต้อง','ยอดเงินไม่ตรง','สินค้าหมด','ลูกค้าขอยกเลิก'}`; `app_url = 'https://tomcraft-grp.github.io/bizops-platform/'`; retry back-off minutes `{1,2,5,15,60}`, `dead` after 6 attempts; link codes are 6 digits, valid 10 minutes, single use, stored as sha256; at most 5 wrong codes per LINE user per hour.
- Deep links: `{app_url}?openExternalBrowser=1#/shop-admin?order={id}` and `{app_url}?openExternalBrowser=1#/payment-review?evidence={id}`.
- LINE cards and replies are in Thai. Staff UI strings go through `Tx` and the back-office Thai dictionary, following `src/lib/i18n.categories.ts`.
- Edge Function CORS origins: `['https://tomcraft-grp.github.io', 'http://localhost:5173']` (the same as `slip-analyze`). Both new functions are deployed with `verify_jwt = false`.
- Dispatcher URL: `https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-dispatch`. Webhook URL: `https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-webhook`.

## Review Focus

1. **A card tapped after the order changed on the web** (cancelled, or confirmed by someone in the back office): the reply must say who did it and when, and nothing may change. Pinned in Task 3 (`L3.6`).
2. **Two webhook deliveries of the same tap** (LINE redelivers on timeout): exactly one action and one reply. Pinned in Task 1 (`L1.9`) and Task 6 (`dedupes redelivered event`).
3. **The quick-approve button is visible but the tapper is only an ADMIN without the finance verifier role**: the reply says why and nothing changes. Pinned in Task 3 (`L3.9`).
4. **The order total or slip was edited/replaced between card and tap** (the customer sent a new slip): the guards run on the current slip, not the one the card showed. Pinned in Task 3 (`L3.12`).
5. **The LINE token is wrong or the quota is full** (LINE answers 401 or 429): the order is saved, the row ends `dead` (401) or retries (429), and the error is visible in Settings with the token redacted. Pinned in Task 7 (`401 is dead and redacted`, `429 retries`).

---

### Task 1: Migration part A: LINE tables, settings, credentials, linking, webhook dedupe

**Files:**
- Create: `supabase/migrations/20261122130000_line_order_notifications.sql` (section A)
- Create: `supabase/tests/line_notifications.sql`, `scripts/run-line-sql-tests.sh`

**Interfaces:**
- Produces (tables): `line_settings` (singleton `id boolean primary key default true check (id)`; columns `enabled, group_id, group_name, group_bound_at, group_bound_by, events jsonb default '{"order_new":true,"slip_new":true,"order_status":true,"payment_issue":true,"customer_notify":false}', quick_approve_enabled, quick_approve_max_amount numeric(14,2), reject_reasons text[], app_url, secret_set_at, secret_set_by, token_set_at, token_set_by, updated_at`); `line_staff_links (profile_id uuid pk → profiles, line_user_id text unique not null, display_name text, linked_at)`; `line_bind_codes (id, kind 'staff'|'group', profile_id, code_hash, expires_at, used_at)`; `line_code_attempts (line_user_id, at)`; `line_webhook_events (webhook_event_id text pk, received_at, type, source_type)`; `line_outbox` (spec columns + `payload jsonb` for follow-up data). RLS on, no client policies: clients use RPCs only.
- Produces (client RPCs, `authenticated`): `line_admin_settings() returns jsonb` (staff; never secrets; includes `secret_set`, `token_set`, `group`, `my_link`, `links` (SUPER_ADMIN only), `webhook_url`); `line_admin_save_settings(p_patch jsonb) returns jsonb` (SUPER_ADMIN; keys `enabled, events, quick_approve_enabled, quick_approve_max_amount, reject_reasons`; `enabled=true` needs both credentials and a bound group, else `LINE_NOT_READY`); `line_admin_set_credentials(p_channel_secret text, p_access_token text) returns void` (SUPER_ADMIN; null keeps the current value); `line_link_code(p_kind text) returns jsonb {code, expires_at}` ('staff' = any active staff for themselves, 'group' = SUPER_ADMIN); `line_unlink(p_profile uuid default null) returns void` (self, or SUPER_ADMIN for anyone).
- Produces (service-role only): `line_credentials_internal() returns jsonb {channel_secret, access_token, dispatch_secret}`; `line_webhook_seen(p_event_id text, p_type text, p_source text) returns boolean` (true = first time); `line_redeem_code(p_line_user text, p_display_name text, p_code text, p_group text default null) returns jsonb {result: 'linked'|'group_bound'|'bad_code'|'rate_limited', name}`; `line_group_left(p_group text) returns void`.

- [ ] **Step 1: Pre-flight (read-only) on the live project with `scripts/db-readonly.sh`**: `select pg_get_functiondef('auth.uid'::regproc)` reads `request.jwt.claims`; `select name from pg_available_extensions where name in ('pg_net','pg_cron','supabase_vault')` returns three rows. If any check fails, stop and report to the owner (spec, "Verify first").
- [ ] **Step 2: Write the failing tests** in `supabase/tests/line_notifications.sql`. Copy the helper block (`t_res`, `chk`, `err_like`, `err_state`, `as_user`) from `supabase/tests/slip_review.sql`, and copy its result block with the marker `LINE_TESTS`. Use STAFF = the oldest active SUPER_ADMIN and ADMIN = the profile promoted by `prod_dry_run_prelude.sql`. Tests:
  - `L1.1` defaults: `enabled=false`, `quick_approve_enabled=false`, `quick_approve_max_amount=3000`, `reject_reasons` = the four defaults, `app_url` as in the constraints.
  - `L1.2` a customer calling `line_admin_settings()` gets `42501`; ADMIN gets a result with no key containing `secret`/`token` values, only `secret_set`/`token_set` booleans.
  - `L1.3` ADMIN calling `line_admin_save_settings` / `line_admin_set_credentials` gets `42501`.
  - `L1.4` STAFF sets credentials: `secret_set` and `token_set` become true, `line_credentials_internal()` as `service_role` returns them, and as `authenticated` it gets `42501`.
  - `L1.5` `enabled=true` without a bound group raises `LINE_NOT_READY`.
  - `L1.6` ADMIN `line_link_code('staff')` returns 6 digits; `line_redeem_code('Uabc…', 'Name', code)` as service role → `linked`; a second redeem of the same code → `bad_code`; `line_admin_settings()` as ADMIN shows `my_link`.
  - `L1.7` six wrong codes from one LINE user → the 6th answers `rate_limited`.
  - `L1.8` STAFF `line_link_code('group')`, redeem with `p_group='Cgrp…'` → `group_bound`, `group_id` stored; `line_group_left('Cgrp…')` clears it.
  - `L1.9` `line_webhook_seen('ev1', …)` true then false.
  - `L1.10` an expired code (set `expires_at` in the past) → `bad_code`.
- [ ] **Step 3: Write `scripts/run-line-sql-tests.sh`**: `exec "$(dirname "$0")/run-sql-tests.sh" LINE_TESTS supabase/tests/prod_dry_run_prelude.sql supabase/migrations/20261122130000_line_order_notifications.sql supabase/tests/line_notifications.sql`. Run it and confirm FAIL (the functions do not exist).
- [ ] **Step 4: Implement section A** of the migration: `create extension if not exists pg_net; create extension if not exists pg_cron;` (Vault is already present), the tables, the RPCs and the grants above. Credentials go through `vault.create_secret` / `vault.update_secret`, and are read from `vault.decrypted_secrets`. Code hashing: `encode(extensions.digest(code, 'sha256'), 'hex')`.
- [ ] **Step 5: Run `bash scripts/run-line-sql-tests.sh`.** Expected: `LINE_TESTS 10 of 10 passed`.
- [ ] **Step 6: Commit** `feat(line): settings, credentials in Vault, staff and group linking, webhook dedupe (dark)`.

### Task 2: Migration part B: optional bank reference and LINE quick confirm (finance)

**Files:**
- Modify: `supabase/migrations/20261122130000_line_order_notifications.sql` (section B)
- Modify: `supabase/tests/line_notifications.sql`

**Interfaces:**
- Produces: column `finance_payment_evidence.confirmed_via text check (confirmed_via in ('web','line_quick'))`, set to `'web'` by `finance_confirm_evidence`.
- Produces: `finance_quick_dup(p_amount numeric, p_bank_account uuid, p_transfer_at timestamptz, p_except uuid) returns text` (internal; returns `'evidence'`/`'receipt'` or null; a match = same amount, same `bank_account_id`, `date_trunc('minute', transfer)` equal, against evidence in `confirmed`/`verified` and posted receipts).
- Changes (same signatures except Post): `finance_confirm_evidence(p_evidence, p_amount, p_bank_trans_ref, p_transfer_at, p_note)`: the reference may be empty. When given, validation and reuse checks are as today. When empty, `finance_quick_dup` runs and a match raises `DUPLICATE_SUSPECT: …` with errcode `23505`. `finance_post_evidence(p_evidence uuid, p_note text default null, p_bank_ref text default null)`: drop the 2-argument version. An optional reference fills `confirmed_bank_ref` when that is empty; with no reference at all, `finance_quick_dup` runs again. `finance_verify_core`: a null reference for a transfer is allowed **only** when `p_from_status = 'confirmed'`, so the legacy one-step `finance_verify_evidence` still requires one.
- Changes: `finance_review_list`: each row gains `confirmed_via` and `no_ref` (transfer with no `confirmed_bank_ref` and no `bank_trans_ref`). The filter key `via` (`'line_quick'`) joins the allowed keys.
- Produces: `finance_quick_confirm_evidence(p_evidence uuid) returns jsonb {status:'confirmed', evidence_id, amount}` (revoked from clients; called by `line_act`). It requires `finance_can('verify')` via `auth.uid()` and sets `confirmed_amount = claimed_amount`, `confirmed_transfer_at = claimed_transfer_at`, `confirmed_bank_ref = null`, `confirm_note = 'LINE quick approve'`, `confirmed_via = 'line_quick'`, and logs `evidence.confirm` with `{"via":"line_quick"}`. The guards are Task 3's `line_quick_check`; this function only re-checks `status = 'submitted'`, invoice open, and `finance_quick_dup`.

- [ ] **Step 1: Write the failing tests** (build slips the way `pg_temp.mkev` does in `slip_review.sql`):
  - `L2.1` Confirm with `p_bank_trans_ref = ''` succeeds; `confirmed_bank_ref is null`, `confirmed_via = 'web'`.
  - `L2.2` a second slip with the same amount, same bank account, transfer 30 s later in the same minute, empty reference → `DUPLICATE_SUSPECT`, `23505`.
  - `L2.3` the same second slip **with** a fresh reference → succeeds (the reference overrides the minute check).
  - `L2.4` Confirm with a reference already used → the old message `Bank transaction % was already recorded`.
  - `L2.5` Post of the L2.1 slip with no reference → receipt created, slip `verified`, receipt `bank_trans_ref is null`, and one bank-receipt row queued for the ledger.
  - `L2.6` Post with `p_bank_ref => 'TX123456'` on a confirmed-without-reference slip → `confirmed_bank_ref = 'TX123456'` and the receipt carries it.
  - `L2.7` legacy `finance_verify_evidence` with an empty reference still raises `The bank transaction reference is required`.
  - `L2.8` `finance_quick_confirm_evidence` as an `authenticated` client → permission denied (not granted).
  - `L2.9` `finance_review_list('{"via":"line_quick"}')` accepted; rows carry `confirmed_via` and `no_ref`.
- [ ] **Step 2: Run** `bash scripts/run-line-sql-tests.sh`. Expected: the L2 tests FAIL, the L1 tests pass.
- [ ] **Step 3: Implement section B**: copy the four functions from `20261120100000_slip_review.sql`, mark each change `-- LINE:`, and reissue the grants and revokes exactly as that file does (the 3-argument Post gets the same grant as the old one).
- [ ] **Step 4: Run.** Expected: `LINE_TESTS 19 of 19 passed`. Then run the existing slip-review and ordering test files **on top of this migration**. Send only the new migration, never the old ones: re-sending `20261120100000_slip_review.sql` would put the old functions back.
  - `bash scripts/run-sql-tests.sh SLIPREVIEW_TESTS supabase/tests/prod_dry_run_prelude.sql supabase/migrations/20261122130000_line_order_notifications.sql supabase/tests/slip_review.sql`
  - The same with the ordering suite's marker and `supabase/tests/online_ordering.sql`.
  - The only failures allowed are tests asserting that the reference is *required* at Confirm or Post. Change those expectations in this task to the new rule, and list them in the commit message.
- [ ] **Step 5: Commit** `feat(finance): bank reference optional at Confirm and Post; duplicate check by amount, account and minute; LINE quick confirm`.

### Task 3: Migration part C: card data, `line_act`, queue triggers, dispatcher RPCs, kick and schedule

**Files:**
- Modify: `supabase/migrations/20261122130000_line_order_notifications.sql` (section C)
- Modify: `supabase/tests/line_notifications.sql`

**Interfaces:**
- Consumes: Task 1 tables, Task 2 `finance_quick_confirm_evidence`, existing `shop_admin_set_status`, `finance_reject_evidence`.
- Produces: `line_quick_check(p_order uuid) returns jsonb {ok boolean, why text, evidence_id, amount, bank, transfer_at}`. These are the order-level guards 1 and 3 to 8 of the spec; `why` is one of `QUICK_OFF|NOT_NEW|NO_SLIP|NOT_TRANSFER|NO_TRANSFER_TIME|OVER_CAP|AMOUNT_MISMATCH|OUT_OF_WINDOW|DUPLICATE_SUSPECT|AI_MISMATCH`.
- Produces: `line_card_data(p_order uuid) returns jsonb` with keys `order_id, order_no, customer_name, phone, created_at, item_count, items (≤3: {name, qty, price, image}), more_count, total, payment {method, bank, has_slip, transfer_at, evidence_id}, status, quick {ok, why}, app_url`.
- Produces: `line_act(p_line_user text, p_action text, p_order uuid, p_card uuid, p_reason int default null, p_event_id text default null) returns jsonb`. `p_action` is one of `accept|quick_ask|quick_confirm|reject_ask|reject`, and `p_reason` is an index into `reject_reasons`. Results: `{result:'not_linked'}`, `{result:'not_allowed', why:'not_staff'|'not_verifier'}`, `{result:'already_done', order_no, status, by, at}`, `{result:'refused', code, message}`, `{result:'ask_quick', order_no, amount, bank, transfer_at}`, `{result:'ask_reason', order_no, reasons}`, `{result:'done', action, order_no, by, at, amount?, reason?}`. Mechanics: check that the card exists in `line_outbox` for that order; resolve the active linked profile; `set_config('request.jwt.claims', {sub, role:'authenticated', email}, true)` and `set_config('line.via_line','on',true)`; lock the order `for update`; call the existing functions; translate known exceptions (`PAYMENT_RECORDED`, `42501`) into results. `by` = `coalesce(display_name, email)` of the actor, taken for `already_done` from the latest `shop_events` row of the order.
- Produces (triggers): `line_enqueue(p_event text, p_order uuid, p_evidence uuid, p_payload jsonb default '{}')` (no-op unless `enabled`, a group is bound, and `events->>p_event` is true; `customer_notify` targets the customer's `profiles.line_user_id` and is skipped when that is null). The triggers are `line_order_new` (deferred constraint trigger after insert on `shop_orders`), `line_evidence_new` (after insert on `finance_payment_evidence`; skipped when the order's `created_at = now()`), `line_order_status` (after update of status on `shop_orders` to `confirmed`/`cancelled`; skipped when `line.via_line = 'on'`; also enqueues `customer_notify`) and `line_payment_issue` (after update of status on evidence to `rejected`/`more_evidence`, and on a `finance_slip_analysis` result that is not a match).
- Produces (service role): `line_claim_outbox(p_limit int default 20) returns jsonb` (an array of `{id, event, target_type, target_id, attempts, card: line_card_data(order), payload}`; claims `queued`/`failed` rows that are due, plus `sending` rows older than 5 minutes, with `for update skip locked`); `line_complete_outbox(p_id uuid, p_ok boolean, p_retryable boolean, p_error text, p_request_id text) returns void` (applies the back-off; `dead` when not retryable or at 6 attempts); `line_kick() returns void` (`net.http_post` to the dispatcher URL with header `x-line-dispatch-secret`, only when due rows exist). An after-insert statement trigger on `line_outbox` calls `line_kick()`, and `cron.schedule('line-dispatch', '* * * * *', 'select public.line_kick()')` runs it every minute.
- Produces (client RPCs): `line_admin_outbox(p_filter text default 'all', p_limit int default 100) returns jsonb` (staff; `'failed'` = `failed`/`dead`); `line_admin_resend(p_id uuid) returns void` (staff; sets `queued`, `attempts = 0`, `next_attempt_at = now()`).

- [ ] **Step 1: Write the failing tests.** Place orders as a customer the way `supabase/tests/online_ordering.sql` does, with a slip and a `p_slip_transfer_at`. Bind a fake group and turn LINE on directly as STAFF first.
  - `L3.1` with LINE off, placing an order queues nothing.
  - `L3.2` with LINE on, one `order_new` row per order; no `slip_new` row for the slip placed with the order (deferred trigger + `created_at = now()` rule). A second slip on an existing order → one `slip_new`.
  - `L3.3` `line_card_data`: 5 items → `items` length 3, `more_count = 2`; the total equals the order total; `payment.has_slip = true`.
  - `L3.4` `line_act(unlinked user, 'accept', …)` → `not_linked`; no change.
  - `L3.5` ADMIN (linked) `accept` → `done`; the order is `confirmed`; `shop_events` latest row `actor = ADMIN`, `detail->>'from' = 'new'`; no `order_status` row queued (via LINE).
  - `L3.6` STAFF `accept` on the same card → `already_done`, `by` = ADMIN's name, status `confirmed`. Also: an order cancelled on the web → the tap gives `already_done` with status `cancelled`.
  - `L3.7` confirming from the web (no LINE flag) → one `order_status` row queued.
  - `L3.8` quick approve with `quick_approve_enabled = false` → `refused`/`QUICK_OFF`.
  - `L3.9` enabled; ADMIN (not a verifier) `quick_confirm` → `not_allowed`/`not_verifier`; nothing changed.
  - `L3.10` STAFF `quick_ask` → `ask_quick` with amount and transfer time; `quick_confirm` → `done`; slip `confirmed`, `confirmed_via='line_quick'`, order `confirmed`, `finance_events` row `actor = STAFF`, `detail->>'via' = 'line_quick'`.
  - `L3.11` guards: amount 3,000.01 → `OVER_CAP`; slip without transfer time → `NO_TRANSFER_TIME`; a second order whose slip matches L3.10 by amount, account and minute → `DUPLICATE_SUSPECT`; for each, `line_card_data(...).quick.ok = false`.
  - `L3.12` the customer replaces the slip after the card: `quick_confirm` checks the new slip (its transfer time is missing → `NO_TRANSFER_TIME`).
  - `L3.13` `reject_ask` → `ask_reason` with the four reasons; ADMIN `reject` while a slip is `submitted` → `not_allowed`/`not_verifier`; STAFF `reject` with reason 1 → `done`; slip `rejected` with reason `ยอดเงินไม่ตรง`; order `cancelled`.
  - `L3.14` `reject` on an order with a posted payment → `refused`/`PAYMENT_RECORDED`.
  - `L3.15` `line_claim_outbox` claims the rows and sets them `sending`; `line_complete_outbox(id, false, true, 'HTTP 500', null)` → `failed`, `attempts = 1`, `next_attempt_at` ≈ now + 1 min; at the 6th failure → `dead`; `(false, false, 'HTTP 400')` → `dead` at once; `line_admin_resend` → `queued`.
  - `L3.16` customer notify on and the customer has a `line_user_id` → a `customer_notify` row with `target_type='user'`.
  - `L3.17` `cron.job` has `line-dispatch`; `line_act`, `line_claim_outbox`, `line_complete_outbox`, `line_kick` are not executable by `authenticated`.
- [ ] **Step 2: Run.** Expected: the L3 tests FAIL.
- [ ] **Step 3: Implement section C.** Two sessions tapping at the same moment are serialised by the order row lock; the second sees status ≠ `new` and returns `already_done`. A single rolled-back transaction cannot prove this with two sessions, so it is covered by L3.6 sequentially and by the live smoke test (Task 10).
- [ ] **Step 4: Run.** Expected: `LINE_TESTS 36 of 36 passed` (count the inserted rows; the number must match the tests written).
- [ ] **Step 5: Commit** `feat(line): card data, line_act acting as the linked staff member, outbox triggers, dispatcher RPCs, pg_net kick and pg_cron`.

### Task 4: Rollback and its proof

**Files:**
- Create: `supabase/rollbacks/20261122130000_line_order_notifications_down.sql`, `scripts/run-line-down-proof.sh`, `supabase/tests/line_down_post.sql`

**Interfaces:**
- The rollback refuses (raise) while any evidence has `status = 'confirmed' and method = 'transfer' and confirmed_bank_ref is null` (the old Post could not post it). Otherwise it unschedules the cron job, drops the triggers, LINE functions, tables and Vault secrets, and the `confirmed_via` column, and restores the four finance functions verbatim from `20261120100000_slip_review.sql` (including the 2-argument Post and its grants). It leaves the extensions in place.

- [ ] **Step 1: Write `scripts/run-line-down-proof.sh`** by copying `scripts/run-slip-review-down-proof.sh` (modes `clean`, `guard`, `control`; the "already applied" probe checks for table `line_settings`). It uses one guard kind: a confirmed transfer slip without a reference; the expected refusal text is `Confirmed transfers without a bank reference exist`.
- [ ] **Step 2: Run** `bash scripts/run-line-down-proof.sh` → FAIL (no rollback yet).
- [ ] **Step 3: Write the rollback.**
- [ ] **Step 4: Run** `clean` → `LINE_DOWN_PROOF n of n passed`; `guard` → `LINE_DOWN_GUARD 1 of 1 refused`; `control` → reports differences.
- [ ] **Step 5: Commit** `feat(line): rollback with guard and schema proof`.

### Task 5: Shared LINE module: signature, postback, cards, client

**Files:**
- Create: `supabase/functions/_shared/line.ts`, `supabase/functions/_shared/lineCards.ts`
- Test: `tests/unit/lineCore.test.ts`

**Interfaces:**
- Produces (`line.ts`): `verifySignature(secret: string, rawBody: string, signature: string | null): Promise<boolean>` (HMAC-SHA256, base64, constant-time compare, using WebCrypto); `type Postback = { a: 'accept'|'quick_ask'|'quick_confirm'|'reject_ask'|'reject'; o: string; c: string; r?: number }`; `encodePostback(p: Postback): string` (URLSearchParams, ≤ 300 chars); `parsePostback(data: string): Postback | null` (rejects unknown `a`, non-uuid `o`/`c`, non-integer `r`); `type SendResult = { ok: boolean; status: number; requestId: string | null; error: string | null }`; `lineClient(token: string, fetchFn: typeof fetch)` returning `{ push(to: string, messages: unknown[], retryKey: string): Promise<SendResult>; reply(replyToken: string, messages: unknown[]): Promise<SendResult>; botInfo(): Promise<SendResult & { name?: string }> }` (endpoints `https://api.line.me/v2/bot/message/push`, `/reply`, `/v2/bot/info`; the `X-Line-Retry-Key` header carries `retryKey`); `classify(status: number): 'sent'|'retry'|'dead'` (2xx sent; 409 sent, meaning LINE already accepted that retry key; 429 and ≥ 500 retry; other 4xx dead; 0/network retry); `redact(text: string, secrets: (string | undefined)[]): string`.
- Produces (`lineCards.ts`): `type CardData` (= Task 3 `line_card_data`); `orderCard(d: CardData): object` (Flex bubble; buttons as in the spec table, ✅ quick only when `d.quick.ok`, live buttons only when `d.status === 'new'`, otherwise a status line; links built from `d.app_url` per the Global Constraints; `tel:` from `d.phone`); `followUpCard(p: { order_no: string; status: 'confirmed'|'cancelled'; by: string; at: string; reason?: string; quick?: boolean }): object`; `quickAskCard(r: AskQuick, card: string, order: string): object`; `reasonsCard(reasons: string[], card: string, order: string, orderUrl: string): object` (one postback button per reason, plus "อื่น ๆ" as a uri to the order); `resultText(r: ActResult): string` (Thai sentence per result; `already_done` → `ออเดอร์ {order_no} ถูก{รับ|ยกเลิก}แล้วโดย {by} เมื่อ {HH:mm}`; `not_linked` → `บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ`); `type ActResult` (= Task 3 `line_act` results).

- [ ] **Step 1: Write the failing tests** in `tests/unit/lineCore.test.ts`:
  - `verifySignature` true for the body signed with the secret (compute the expected value with `node:crypto` `createHmac`), false when 1 byte of the body changes, false for a null header.
  - `parsePostback(encodePostback(p))` round-trips; `a=drop` → null; `o=not-a-uuid` → null.
  - `classify`: 200 → sent, 409 → sent, 429 → retry, 500 → retry, 400 → dead, 401 → dead.
  - `redact('token abc123 failed', ['abc123'])` → `'token *** failed'`.
  - `orderCard` with 1, 3 and 12 items: the contents include at most 3 item rows and `+ อีก 9 รายการ` for 12; status `confirmed` → no postback buttons; `quick.ok=false` → no `quick_ask` postback; the ดูรายละเอียด uri equals `https://tomcraft-grp.github.io/bizops-platform/?openExternalBrowser=1#/shop-admin?order=<id>`; a wallet order shows `ชำระด้วยกระเป๋าเงิน` and no ตรวจสลิป button.
  - `JSON.stringify(orderCard(...)).length < 30000` for 12 items (LINE bubble limit).
  - `resultText` for `already_done` / `not_linked` gives the exact sentences above.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lineCore.test.ts` → FAIL.
- [ ] **Step 3: Implement both files.** No imports outside the standard library, so the same file runs in Deno and in vitest.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(line): shared signature, postback, Flex cards and LINE client`.

### Task 6: Edge Function `line-webhook`

**Files:**
- Create: `supabase/functions/line-webhook/handler.ts`, `supabase/functions/line-webhook/index.ts`
- Test: `tests/unit/lineWebhook.test.ts`

**Interfaces:**
- Consumes: Task 5 module; Task 1/3 RPCs.
- Produces: `type WebhookDeps = { channelSecret(): Promise<string | null>; seen(eventId: string, type: string, source: string): Promise<boolean>; redeem(lineUser: string, name: string | null, code: string, group: string | null): Promise<{ result: string; name?: string }>; groupLeft(group: string): Promise<void>; boundGroup(): Promise<string | null>; act(a: { lineUser: string; action: Postback['a']; order: string; card: string; reason: number | null; eventId: string }): Promise<ActResult>; reply(token: string, messages: unknown[]): Promise<SendResult>; push(to: string, messages: unknown[]): Promise<SendResult>; log(msg: string): void }`; `handleWebhook(req: Request, deps: WebhookDeps): Promise<Response>`. `index.ts` wires the deps to `admin.rpc(...)` (service role) and `lineClient`; the user display name comes from `GET /v2/bot/profile/{userId}` on link.

- [ ] **Step 1: Write the failing tests** with fakes:
  - `bad signature → 401 and act not called`; `missing secret → 503`.
  - `dedupes redelivered event`: the same `webhookEventId` twice → `act` called once, `reply` once.
  - `postback from bound group calls act with the tapper` (`source.userId`), and the reply uses `resultText`.
  - `ask_quick → reply is quickAskCard`, `ask_reason → reasonsCard`.
  - `postback from another group is ignored` (no act, 200).
  - `group event without userId → reply not_linked text, no act`.
  - `6-digit text in 1:1 → redeem; linked → reply 'เชื่อมบัญชีเรียบร้อย'`; the same in the bound group with a group code → `group_bound`.
  - `leave event → groupLeft`.
  - `reply failure falls back to push` to the group (or the user in 1:1).
  - `act throws → 200, reply 'เกิดข้อผิดพลาด ลองใหม่หรือทำในเว็บ', error logged redacted`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/lineWebhook.test.ts` → FAIL.
- [ ] **Step 3: Implement** `handler.ts` (read the raw body once with `req.text()`, verify it, then `JSON.parse`; always answer 200 after a good signature) and `index.ts` (header comment in the style of `slip-analyze/index.ts`: purpose, deploy command `supabase functions deploy line-webhook --no-verify-jwt --project-ref hlvravynjalculvplrxc`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(line): webhook function (signature, dedupe, actions, linking)`.

### Task 7: Edge Function `line-dispatch`

**Files:**
- Create: `supabase/functions/line-dispatch/handler.ts`, `supabase/functions/line-dispatch/index.ts`
- Test: `tests/unit/lineDispatch.test.ts`

**Interfaces:**
- Produces: `type DispatchDeps = { dispatchSecret(): Promise<string | null>; token(): Promise<string | null>; claim(limit: number): Promise<OutboxRow[]>; complete(id: string, ok: boolean, retryable: boolean, error: string | null, requestId: string | null): Promise<void>; push(to: string, messages: unknown[], retryKey: string): Promise<SendResult>; botInfo(): Promise<SendResult & { name?: string }>; isSuperAdmin(jwt: string): Promise<boolean>; secrets(): (string | undefined)[] }`; `handleDispatch(req: Request, deps: DispatchDeps): Promise<Response>`. Draining needs the header `x-line-dispatch-secret` and returns `{sent, retried, dead}`. `{op:'test'}` with `Authorization: Bearer <jwt>` of a SUPER_ADMIN returns `{ok, name}` from `botInfo`.
- Message per event: `order_new`/`slip_new` → `orderCard(card)` (for `slip_new` the header reads `สลิปใหม่`); `order_status` → `followUpCard(payload)`; `payment_issue` → a text line with a ตรวจสลิป link; `customer_notify` → a Thai text line (`ร้านรับออเดอร์ {no} แล้ว` / `ออเดอร์ {no} ถูกยกเลิก: {reason}`). Retry key = outbox `id`.

- [ ] **Step 1: Write the failing tests**:
  - `wrong secret → 401, nothing claimed`.
  - `sends each claimed row and completes ok` (2 rows → 2 pushes with retry keys = ids).
  - `429 retries`: `complete(id, false, true, …)`.
  - `401 is dead and redacted`: `complete(id, false, false, error)` where the error does not contain the token.
  - `network error → retry`.
  - `no token configured → every row completes retryable with 'LINE_NOT_CONFIGURED'`.
  - `op test: non-admin → 403; admin → {ok:true, name}`.
  - `order_status row renders followUpCard`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(line): dispatcher function with retry classification and connection test`.

### Task 8: Settings card (LINE notifications)

**Files:**
- Create: `src/lib/lineApi.ts`, `src/pages/LineSettings.tsx`, `src/lib/i18n.line.ts`
- Modify: `src/pages/Admin.tsx` (render `<LineSettingsCard />` at the end of `SettingsInner`)
- Test: `tests/unit/lineSettings.test.ts`, `tests/shop-e2e/fakeLine.ts`, `tests/shop-e2e/line-settings.spec.ts`

**Interfaces:**
- Produces (`lineApi.ts`): `type LineSettings` (= `line_admin_settings()` JSON); `line.settings(): Promise<LineSettings>`; `line.save(patch: Partial<Pick<LineSettings,'enabled'|'events'|'quick_approve_enabled'|'quick_approve_max_amount'|'reject_reasons'>>): Promise<LineSettings>`; `line.setCredentials(p: { secret?: string; token?: string }): Promise<void>`; `line.linkCode(kind: 'staff'|'group'): Promise<{ code: string; expires_at: string }>`; `line.unlink(profileId?: string): Promise<void>`; `line.outbox(filter: 'all'|'failed'): Promise<OutboxEntry[]>`; `line.resend(id: string): Promise<void>`; `line.test(): Promise<{ ok: boolean; name?: string; error?: string }>` (`supabase.functions.invoke('line-dispatch', { body: { op: 'test' } })`); `lineErrorText(lang, e): string` (maps `LINE_NOT_READY`, `42501`).
- Produces (`LineSettings.tsx`): `export function LineSettingsCard()`. Sections per the spec (Connection, Group, My LINE, Events, Quick approve, Reject reasons, Delivery log). Credential inputs are `type="password"` and are cleared after saving; the card shows `ตั้งค่าแล้ว` plus the date, never the value. Non-SUPER_ADMIN sees everything read-only except My LINE. A missing migration (RPC 404 / `PGRST202`) shows "ยังไม่ได้ติดตั้งฐานข้อมูลส่วน LINE" instead of an error, the way `isMissingMigration` does in `src/finance/review.ts`.

- [ ] **Step 1: Write the failing unit tests** (`lineSettings.test.ts`): `lineErrorText` for `LINE_NOT_READY` (Thai `ต้องใส่ข้อมูลเชื่อมต่อและผูกกลุ่มก่อนเปิดใช้`) and for `42501`; validation helper `validMaxAmount('3000') === true`, `('0')`/`('-1')`/`('abc') === false`; `validReasons([''])` false, `(['a'])` true, 11 reasons false.
- [ ] **Step 2: Write the failing e2e** with `fakeLine.ts` (a route-level fake like `fakeReview.ts`): as SUPER_ADMIN, save a token → the input is cleared and `ตั้งค่าแล้ว` is shown; the switch is refused with the LINE_NOT_READY text when no group is bound; *Link my LINE* shows a 6-digit code; the delivery log lists a `dead` row with its error and *ส่งใหม่* turns it `queued`; as ADMIN the credential inputs are disabled; axe passes; 360 px width has no horizontal scroll.
- [ ] **Step 3: Run** `npx vitest run tests/unit/lineSettings.test.ts` and `npx playwright test -c playwright.shop.config.ts tests/shop-e2e/line-settings.spec.ts` → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run both** → PASS; `npm run typecheck` → no errors.
- [ ] **Step 6: Commit** `feat(line): Settings card for LINE notifications`.

### Task 9: Deep links, optional reference in the slip screens, badges

**Files:**
- Modify: `src/shop/ShopAdmin.tsx` (`open` initial value from `useSearchParams().get('order')`), `src/pages/Finance.tsx` (with `evidence` in the query, open the slip review tab and pass `initialOpenId`), `src/finance/SlipReview.tsx` (`initialOpenId` prop; the Confirm form's reference becomes optional; Post asks for an optional reference when the slip has none; badges `อนุมัติด่วนจาก LINE` and `ไม่มีเลขอ้างอิง`; a filter chip for `via: 'line_quick'`), `src/finance/review.ts`
- Test: `tests/unit/slipReviewUi.test.ts`, `tests/shop-e2e/slip-review.spec.ts`, `tests/shop-e2e/fakeReview.ts`, `tests/shop-e2e/admin.spec.ts`

**Interfaces:**
- Produces (`review.ts`): `refOk(ref: string): boolean` (empty → true; otherwise ≥ 4 letters or digits and ≤ 80 characters); `review.post(evidenceId: string, note?: string, bankRef?: string)` passes `p_bank_ref`; `reviewErrorText` maps `DUPLICATE_SUSPECT` to `อาจเป็นสลิปซ้ำ: มีสลิปยอดเดียวกัน เข้าบัญชีเดียวกัน ในนาทีเดียวกันแล้ว ใส่เลขอ้างอิงธนาคารเพื่อยืนยันต่อ` (English: `Possible duplicate: a slip with the same amount, account and minute exists. Enter the bank reference to continue.`); the review row type gains `confirmed_via?: 'web'|'line_quick'` and `no_ref?: boolean`.
- `formOk` in `SlipReview.tsx` uses `refOk(form.ref)` instead of the ≥ 4 rule; the toast text becomes `Enter the amount and the transfer date and time from your bank record`; the reference field label gets `(ไม่บังคับ)`.

- [ ] **Step 1: Write the failing unit tests**: `refOk('') === true`, `refOk('ab-1') === false`, `refOk('TX12') === true`, `refOk('x'.repeat(81)) === false`; `reviewErrorText('th', new Error('DUPLICATE_SUSPECT: …'))` returns the Thai text above.
- [ ] **Step 2: Write the failing e2e**: `#/payment-review?evidence=<id>` opens that slip's detail; Confirm with an empty reference sends `p_bank_trans_ref: ''` and succeeds; the fake answering `DUPLICATE_SUSPECT` shows the Thai text; a `line_quick` row shows the badge; the filter chip sends `{"via":"line_quick"}`; `#/shop-admin?order=<id>` opens that order's drawer (in `admin.spec.ts`).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** the unit tests, `npx playwright test -c playwright.shop.config.ts`, `npm run typecheck` → PASS, no errors.
- [ ] **Step 6: Commit** `feat(line): deep links to order and slip; bank reference optional in Confirm and Post; LINE quick-approve badge and filter`.

### Task 10: Docs, full verification, go-live checklist

**Files:**
- Create: `docs/line-notifications.md`
- Modify: `docs/slip-review.md` (one paragraph: the reference is optional; the duplicate rule), `docs/online-ordering.md` ("Limits": LINE notifications now exist)

**Interfaces:**
- `docs/line-notifications.md` sections, in the style of `docs/slip-review.md`: what is dark and what is not (the optional reference and badges are live once the app is published); **LINE Developers setup** (Messaging API channel under the **same provider** as the Login channel `2012605932`; webhook URL; turn "Use webhook" on; turn auto-reply and greeting off in the OA Manager; allow the bot to join groups; where to find the channel secret and a long-lived channel access token); **plan and quota** (Free 300 / Basic ฿1,280 for 15,000 / Pro ฿1,780 for 35,000, before VAT; a group push counts per member; replies are free; the 30 orders × 4 members example; check the current price list); **go-live order** (apply the migration through `scripts/apply-migrations.sh`, deploy both functions with `--no-verify-jwt`, publish the app as in `docs/rewards.md`, paste credentials, Test connection, bind the group, staff link, switch on, quick approve last); **daily routine** (quick-approved and reference-less slips are checked against the statement at Post); **live smoke test** (the list in the spec's Testing section, including two phones tapping Accept together); **rollback** (functions undeployed first, then the rollback SQL, and its guard).

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Full verification**: `bash scripts/run-line-sql-tests.sh` (all pass), `bash scripts/run-line-down-proof.sh` + `guard` + `control`, the slip-review and ordering files on top of the new migration exactly as in Task 2 Step 4 (all pass), `npm test`, `npx playwright test -c playwright.shop.config.ts`, `npm run build`.
- [ ] **Step 3: Commit** `docs(line): configuration guide, quota, go-live and rollback`.
- [ ] **Step 4: Stop.** Report to the owner with the go-live checklist; do not apply, deploy or publish without their explicit go.
