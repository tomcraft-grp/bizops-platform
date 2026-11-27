# Customer-to-customer loyalty points transfer: design and what was verified (2026-11-27)

Branch `feat/points-transfer` (worktree `.claude/worktrees/points-transfer`, from `origin/main` c445742). Migration `20261127120000_points_transfer.sql`. **Applied to the live project on 2026-11-27 with the owner's OK (dry run first, one transaction), and it ships dark: `transfers_enabled = false` until a Super Admin switches it on.**

## 0. What exists (read from the live project, read-only, 2026-11-27)
Two loyalty systems exist in the codebase:
- **A, local per-device loyalty** (`src/domain/loyalty.ts`, IndexedDB customers, `redeemReward`, `pointsBalance`). A customer lives in one browser, so one customer cannot address another device's customer. **Not used for transfers.**
- **B, server-side rewards** (migration `20261121100000`, ON since 2026-11-21: `rw_settings.enabled = true`, 2 rules, 2 ledger rows). `rw_points_ledger` is append-only and a customer's balance is `SUM(points)` per `profile_id` (kinds `earn` / `reverse` / `adjust`). `rw_settle_profile` rewrites every source that is not exactly `adjust` so that the ledger matches the paid bills, so any other source key would be **reversed** by the next settle. The Super Admin adjustment (`rw_admin_adjust_points`) writes `adjust` rows under the advisory lock `hashtextextended('rw:' || profile, 0)` and refuses a balance below zero. There is **no redemption function in B yet** (points are shown; number picks come from bills, not from points).
Customers are signed-in shop users (`shop_require_user`); `profiles` has `display_name`, `phone`, `role`, `status` (`active` / `disabled`), no picture. There was no customer notification centre.

## 1. Decisions
| Question | Decision | Why |
|---|---|---|
| Which system | B (server) | A cannot reach another customer |
| How a customer is identified | A **new member ID** (`rw_members`, 8 characters from an alphabet without I, O, 0, 1, shown `ABCD-EFGH`) | No existing customer-facing ID; an e-mail or phone would leak personal data; 32^8 is not guessable |
| Preview before sending | Short name (`Somchai J.`) + masked ID (`AB••••GH`) | No phone, e-mail or full name of another person |
| Reservation | **Option A**, as table state: a pending transfer reserves its points; `available = balance - reserved` | The owner's preference; the ledger stays a record of real movements, so a request that is never accepted leaves no trace |
| Ledger rows of an accepted transfer | Two rows, kind `adjust`, source key `adjust` (sender −n, recipient +n) | `settle` ignores exactly `adjust`; no change to the earning rules |
| Recipient decision | Explicit Accept / Decline; the sender can Cancel; unanswered requests expire (default 7 days, lazy: no cron) | Required |
| Locking | `FOR UPDATE` on the transfer, then the advisory locks of **both** profiles in sorted order | Same lock the settle function and the Super Admin adjustment take: no race with earning or adjusting, no deadlock between two transfers |
| Idempotency | `(sender, key)` unique; same key + same request = same answer (`replay`); same key + another recipient or amount = `KEY_REUSED`; accept / reject / cancel are replays by status | Double tap, lost answer, two devices |
| Notices | Table `rw_transfer_notices`, written in an exception-safe block **after** the points move, unique per (transfer, customer, kind) | A failed or repeated notice can never change a point |
| Dark launch | `rw_transfer_settings.transfers_enabled` defaults to false; also needs the rewards master switch | Nothing changes for customers until a Super Admin switches it on |

## 2. Database (migration `20261127120000_points_transfer.sql`)
Tables (RLS on, **no client grant**; reachable only through the SECURITY DEFINER functions): `rw_transfer_settings` (single row: switch, min 1, max 1000 per transfer, 5000 per day, 10 pending, 7 days), `rw_members`, `rw_point_transfers` (immutable parties / amount / times, never deleted or truncated, `accepted` requires both ledger ids), `rw_transfer_notices`.
Customer functions: `rw_transfer_overview`, `rw_transfer_lookup`, `rw_transfer_create`, `rw_transfer_accept`, `rw_transfer_reject`, `rw_transfer_cancel`, `rw_transfer_mark_read`. Staff: `rw_admin_transfer_settings`, `rw_admin_save_transfer_settings` (Super Admin), `rw_admin_transfers` (audit), `rw_admin_cancel_transfer` (Super Admin, reason required, pending only). Internal: `rw_points_balance`, `rw_points_reserved`, **`rw_points_available`** (the one number any future redemption must spend from), `rw_transfer_expire`, `rw_transfer_note`, and others.
`rw_admin_adjust_points` is replaced by a copy of the live function that also refuses to take away points that a pending transfer holds (`POINTS_RESERVED`). The migration **refuses to run** if the live text of that function is not the one the copy was made from (md5 guard; another session also changes rewards functions).
A recipient who is disabled is "not found", exactly like an unknown ID. Unknown-ID lookups are limited to 20 an hour per customer.

## 3. Reservation logic
`available = SUM(ledger) - SUM(points of own pending, unexpired transfers)`. A new request needs `points <= available`, so with 10 points, a request of 6 leaves 4: a second request of 5 is refused. A pending transfer stops reserving the moment it is not pending any more (accepted, rejected, cancelled, expired) or its time passes. Accept re-checks, under the locks, that the sender still has the points in the ledger; if staff removed them behind the request, the request is cancelled with `SENDER_BALANCE_CHANGED` instead of making a negative balance.
Not changed on purpose: no earning rule, no settle, no bill, no payment, no local (A) loyalty.

## 4. Screens
- **Customer** (`src/shop/PointTransfer.tsx`, helpers `src/shop/pointsView.ts`, texts `src/shop/i18n.points.ts`, client `src/rewards/transferApi.ts`): Account → "Transfer points" (only when the server says transfers are on; badge for unread news / waiting requests) and a Home banner for a waiting request. The screen: points you can send / total / held; waiting requests with **Accept** and **Decline** (a question first); send form (member ID → preview → amount → optional message of 140 characters → confirm sheet with what happens and what stays available); sent requests with **Cancel request**; your member ID with Copy / Share; history (incoming, outgoing, accepted, declined, cancelled, expired, with the reference no.). Thai and English.
- **Buttons**: no primary button is ever disabled or greyed out. A wrong entry is explained when the button is pressed; while a request is on its way the button keeps its colour and says "Sending…" (`aria-busy`), and presses during that time send nothing more. At least 44 px high; the layout works from 320 px to desktop.
- **Staff** (`src/rewards/TransfersPanel.tsx`, tab "Point transfers" in Promotions): switch (Super Admin, one inline confirmation to turn on), limits (checked before sending; only what changed is sent), audit list (status filter, search by number or name, both ledger row numbers of an accepted transfer), cancel a waiting transfer with a reason. An Admin can read but sees no change controls.
- A request that may have been processed (lost connection) keeps its idempotency key: pressing confirm again is the same request and never a second transfer; a clear refusal drops the key.

## 5. Tests and what they prove
| Area | Where | Data |
|---|---|---|
| Database rules | `supabase/tests/points_transfer.sql` **98/98**, `points_transfer_down_pre/post.sql` **5/5** | the REAL Supabase project (real profiles, rewards ledger and settings) inside one transaction that always rolls back (`scripts/run-points-transfer-sql-tests.sh`) |
| Pure screen rules, texts in both languages, staff limits, Thai for database messages | `tests/unit/pointsTransfer.test.ts` (29), `bilingualErrors.test.ts` | none |
| Screens | `tests/shop-e2e/pointsTransfer.spec.ts` (44) | a FAKE backend (`fakeTransfers.ts`) that mirrors the SQL contract |
The SQL suite covers: normal, partial, insufficient, reservation (6 + 5 refused), rejected, cancelled, expired (lazy), self transfer, double accept (the points move once), replayed create, key reuse, reward arithmetic 7 + 3 = 10, invalid / disabled recipient, lookup rate limit, limits, a forced failure inside accept that must roll back everything, a failing notice that must not touch points, `settle` leaving the transfer rows alone, one customer unable to read another's transfers, staff-only functions refusing customers, and `rw_admin_adjust_points` refusing reserved points.

## 6. Not verified, and risks
- **No true parallel-session concurrency test.** SQL tests run in one session, one after another; the locking (row lock plus the two advisory locks in a fixed order) is reviewed by reading, and its outcomes (a second accept is a replay, a reserved point cannot be spent twice) are proven sequentially, not by two real connections at the same instant.
- **Screens never ran against the real functions before publishing**: the SQL ran on the real project in rollback mode (before the migration was applied); the screens ran against a fake. After applying, only read-only checks were made on the live project (tables with RLS and no client grants, functions present, switch off, ledger untouched). The first real transfer is the first time the real functions run outside a rolled-back transaction: try it with two test accounts and a few points before telling customers.
- **Notices are in-app only** (no LINE push). The LINE notification system belongs to another session.
- **There is no points redemption in system B**, so "redeem at 10 points" does not exist server-side yet. `rw_points_available` is ready for it; any future redemption must use it.
- Expiry is lazy: an unanswered request stays "pending" in the table until somebody looks, but it stops reserving at the moment it expires.
- Switching on needs a Super Admin (and the rewards master switch). Once it is on, a customer gets a member ID (one small row in `rw_members`) the first time the app asks for their transfer overview, which Home (for the banner) and Account (for the row) do; while it is off the overview answers `enabled: false` without writing anything.

## 7. Apply and roll back
Applied 2026-11-27: `DRY_RUN=1 scripts/apply-migrations.sh 20261127120000:points_transfer:supabase/migrations/20261127120000_points_transfer.sql`, then the same without `DRY_RUN`. Roll back: `supabase/rollbacks/20261127120000_points_transfer_down.sql` (restores `rw_admin_adjust_points` verbatim; **refuses once a transfer exists**: cancel or keep the history instead), then delete the version from `supabase_migrations.schema_migrations`. The roll-back is proven byte-identical in rollback mode (5/5).
