# Preorders (scheduled pickup): how it works, going live, daily routine, rollback

Builds on [online-ordering.md](online-ordering.md) (orders, payment, slips) and [line-notifications.md](line-notifications.md) (the LINE queue).
Design and the reasons behind each choice: `docs/superpowers/specs/2026-11-27-preorders-design.md`.
Migration `supabase/migrations/20261128100000_preorders.sql`, rollback `supabase/rollbacks/20261128100000_preorders_down.sql`.
Code: `src/shop/Preorder.tsx` (customer), `src/preorders/` (Preorders page, Pickup prep board), `supabase/functions/line-dispatch` + `_shared/lineCards.ts` (LINE).

**Status (2026-11-28, about 00:20 Bangkok): LIVE but DARK.** Edge Function `line-dispatch` redeployed (version 2, JWT verification off, answers 401 / 403 without credentials as before); migration `20261128100000` **applied to the live project** (one transaction, after a rolled-back rehearsal of the same file; the 22 existing orders read through the new functions, `preorder_settings.enabled = false`, not configured, sweep job `preorder-sweep` every 5 minutes, LINE switches `preorder*` added); merged into `main` (a2aff3e), dist rebuilt (2e53531), `gh-pages` deployed as `df3f8cc` (the page serves build `0.1.0+a2aff3e`; app rollback target: `gh-pages` `c786501`, keep `ocr/`; Edge Function rollback: redeploy `line-dispatch` from commit `cc613b8`). **What remains is the owner's step 4 and 5 below:** customers see nothing new until a SUPER_ADMIN saves the opening hours and switches preorders on.

## What a preorder is

A **pick-up order with a schedule**: `shop_orders.order_type = 'preorder'` plus `pickup_at` (the start of the chosen slot). It uses the existing invoice, slip, wallet, rewards, status engine, audit trail (`shop_events`) and the LINE group card, so payment, accounting and the order list behave exactly as they do today. Every existing order is `regular`; nothing about them changes.

| Preorder meaning | Stored as |
|---|---|
| Pending confirmation | `new` |
| Confirmed | `confirmed` |
| Preparing | `preparing` (whoever starts it is assigned, unless someone was named) |
| Ready for pickup | `ready` (straight from `preparing`; **every checklist line must be ticked**) |
| Picked up | `completed` |
| Cancelled | `cancelled`, `cancel_kind = customer` or `staff` |
| Rejected | `cancelled` while still `new`, `cancel_kind = rejected` |

Payment rules are unchanged: nothing after *confirmed* without a verified payment, or a recorded reason ("continue without verified payment"). Confirming a preorder whose pickup time has passed is refused (`PICKUP_PASSED`): move it first.

## Customer app

Checkout offers a third way, **Preorder (pick up later)**, only while the shop offers it. The customer chooses a **day** (closed and full days are disabled), then a **time** (full, too soon and "too many items for this slot" are shown disabled), may add the quick instructions, and sees a confirmation with the items and quantities the shop will prepare, the date and time, the instructions, the payment method and the total. The order page then shows the schedule, preparation progress ("2 of 3 items prepared"), what the shop told them, and:

* **change the time / instructions** (status new or confirmed, before the cut-off, at most 3 times; capacity is checked again);
* **cancel** (only while new, unpaid, before the cut-off: the existing rule);
* **ask the shop** (a message to the staff, once per 10 minutes) for anything else: other quantities, cancelling after paying. Items and amounts are frozen records, so a different basket is "cancel and order again".

My orders has a *Scheduled pickups* chip, soonest first. All times are shown in shop time (Asia/Bangkok).

## Back office

* **Preorders** (`#/preorders`): *Overview* (today's numbers from the orders, the attention list), *Schedule* (a day as a timeline: free slots, orders under their time, each slot's load), *All preorders* (search, status / payment / date / time / assignee filters, sorting, paging), *Alerts* (every notice and its LINE delivery state), *Settings* (hours, interval, lead time, capacity, change cut-off, reminders; holidays and special hours).
* **Pickup prep** (`#/prep`): the employee's phone board. Orders by pickup time, overdue ones on top, customer phone and instructions, one big checklist per order, one big button for the next step, "Take this order", "Only my orders". Refreshes every 30 seconds; an order that was cancelled meanwhile is announced.
* The order drawer (also reachable from **Online shop**) confirms, assigns, moves the time (with a reason, over capacity only with an explicit tick), ticks, starts, marks ready, hands over, rejects / cancels.

Roles: staff (`ADMIN`, `SUPER_ADMIN`) run the day and manage closures; **only a SUPER_ADMIN** changes the settings and switches the feature on. There is no separate employee role in the database: an employee who prepares orders is an `ADMIN` account. Customers can only act on their own orders. Every rule is enforced by the database functions; the screens only show it.

## Scheduling and capacity

* A slot is bookable when: its day is open (weekly hours, or a special-hours / closure date), the slot fits inside the hours, it is not sooner than **now + lead time**, not beyond the **furthest day**, and capacity is left.
* Capacity counts **orders and units** (the sum of the quantities) per slot, and optionally units per day. A fixed workload per order would not suit a shop where one order can be 3 or 300 items; the unit limit absorbs that. Per-product workload is a documented extension (there is no data to base it on today).
* Default configuration (nothing is served until a SUPER_ADMIN saves the hours): 30-minute slots, 09:00–18:00 every day, lead time 120 min, 14 days ahead, 4 orders per slot, change cut-off 180 min, large order from 50 units.
* **Concurrency:** placing, rescheduling and staff moves take a transaction lock for the pickup *day* before counting, so two customers can never take the last place (proved with parallel connections, below).
* Closing a day (or special hours) that already has active preorders needs an explicit "save anyway"; those orders then show **Day closed** on the attention list.

## Notifications

One pipeline, `preorder_notify`: it writes the **in-app notice** once (unique key, so nothing is said twice) and, when LINE is on and the switch for that audience is on, queues a LINE message in the existing outbox (delivery log, retries after 1/2/5/15/60 minutes, resend). Both steps are best effort in their own sub-transaction: **a notification problem can never fail or roll back an order** (tested with a deliberately broken queue).

| Who | Events |
|---|---|
| Customer (order page + LINE) | received, confirmed, preparing, ready, picked up, rejected, cancelled by the shop, time changed by the shop, reminder |
| Admin group (Alerts + LINE) | new preorder (the existing order card, now showing the pickup time), customer changed the schedule, customer cancelled, customer asked for a change, not started in time, late, waiting for pickup, slot nearly full / full, large order |
| Assigned employee (Alerts + LINE) | assigned to you, time changed, cancelled, plus the due-soon / late alerts of their orders |

A 5-minute `pg_cron` job (`preorder_sweep`) writes the time-based ones; a rescheduled order starts its alerts again. LINE switches (Settings → LINE notifications): `preorder` (group), `preorder_staff`, `preorder_customer`; all on once the migration is applied, and nothing is sent while the preorder feature or LINE is off. **Not available because nothing is configured:** push notifications and e-mail; the in-app notices are the fallback when a person has no LINE.

## Stock

There is **no central stock** (inventory lives in the staff browser's local store). Availability is the *sold out* switch and *max per order* per SKU, plus the slot capacity above. Nothing is reserved or deducted, so no duplicate inventory transaction is possible. When a central stock exists, reservation belongs at *confirmed* and deduction at *ready* / *picked up*.

## Go-live (steps 1 to 3 are done; 4 and 5 are the owner's)

1. **Deploy `line-dispatch`** (backward compatible; renders the new `preorder` event and the pickup line on the order card):
   `supabase functions deploy line-dispatch --no-verify-jwt --project-ref hlvravynjalculvplrxc`
2. **Apply the migration** (after `bash scripts/run-preorders-sql-tests.sh` reports all passed, at a quiet time):
   `bash scripts/apply-migrations.sh 20261128100000:preorders:supabase/migrations/20261128100000_preorders.sql`
   It adds columns and tables, replaces the order functions, schedules the sweep. **The feature stays off.**
3. **Publish the app** (same procedure as in [rewards.md](rewards.md): build, commit `dist/index.html`, push `main`, then `gh-pages`).
4. **Preorders → Settings** (SUPER_ADMIN): set the opening hours and capacity, save, then switch *Customers can order ahead* on. The checklist on that page shows what is missing (hours saved, pick-up offered, shop open).
5. Place a real test preorder with a customer account; walk it through Pickup prep; check the LINE messages.

## Daily routine

Preorders → Overview in the morning (attention list); employees work from **Pickup prep**; Alerts shows what was said and whether LINE delivered it (resend failures in Settings → LINE notifications → Delivery log). Add holidays under Settings → Holidays before they happen.

## Rollback

1. Switch the feature off (Settings) — customers stop seeing it at once; preorders already placed continue.
2. `supabase/rollbacks/20261128100000_preorders_down.sql`, then delete version `20261128100000` from `supabase_migrations.schema_migrations`. It **refuses once any preorder exists** (orders are never deleted) or a preorder LINE message is queued. It restores the eleven replaced functions verbatim, the old 14-argument `shop_place_order`, drops the preorder tables / columns / job / LINE switches.
3. The old app works with the new database and with the rolled-back one (it asks for nothing the old database lacks).

## How it is tested (real results, 2026-11-27)

* `bash scripts/run-preorders-sql-tests.sh`: the migration and **255 checks against the live project's real data in one rolled-back transaction**: settings and permissions, hours and closures, slots in every state, placing (idempotent replay, key reuse, every refusal code, capacity in orders / units / per day), LINE on / off / switch off / a broken queue, customer change / request / cancel and the cut-off, the whole lifecycle with payment gate and checklist, assignment, staff reschedule with capacity override, dashboard / list / schedule / board against direct counts, the time-based sweep (once only, new occasion after a reschedule), isolation between customers, grants, and that regular orders still walk the old path.
* `node scripts/preorder-concurrency-test.mjs`: parallel real connections in a throw-away schema using the migration's own slot functions: 12 parallel orders for a slot with room for 3 book exactly 3; 3-unit orders against an 8-unit slot book exactly 2; the **control** (the lock removed) over-books, proving the test can fail.
* `bash scripts/run-preorders-down-proof.sh` (+ `guard`, `control`): the rollback restores all 414 public functions, 104 tables, 1091 columns, 575 constraints, 233 indexes, 86 triggers and 61 policies exactly, and refuses while a preorder exists.
* Unit tests (`npx vitest run`): Bangkok date boundaries, the day list, quick instructions, change window, coded errors in both apps, Thai coverage of every text, the LINE messages and cards.
* Browser tests (`npx playwright test -c playwright.shop.config.ts tests/shop-e2e/preorders*.spec.ts`): the customer journey, picker states, race on the last slot, change / ask / cancel / locked, fallbacks (shop without preorders, database without the migration), the Preorders page (numbers, timeline, filters and paging, alerts, drawer, settings, closures), the mobile Pickup prep board, accessibility (axe), phone width, Thai. They use a fake backend: they prove the screens, not the database.
* **Not tested:** a real LINE delivery and tap (the dispatcher and cards are tested with fakes), the preorder pages against the real database from a browser (the migration is not applied), two real phones tapping at once in the app, and the pg_cron job actually firing (its function is tested directly; the job is scheduled inside the rolled-back test).

## Limits

* No central stock (above). Per-product capacity / workload is not modelled.
* Items and amounts cannot be changed after ordering (cancel and re-order, or ask the shop).
* No push or e-mail. Customer LINE messages need the same LINE provider as the login channel (see line-notifications.md) and the `preorder_customer` switch.
* The employee board shows the customer's phone to every staff account (staff already see it on every order).
