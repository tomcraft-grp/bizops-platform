# Preorder / scheduled pickup: design (2026-11-27)

Written after reading the live system (not from assumptions). All choices below are the builder's own calls, made under the owner's instruction to decide technical, UX and
reasonable business-rule questions without asking. What stays with the owner: applying the migration to the one production database, deploying the Edge Function, publishing the app,
and switching the feature on.

## What exists today (and is reused, not duplicated)

* **Orders**: `shop_orders` + `shop_order_items`; a status engine `new → confirmed → preparing → packed → ready (pickup) / shipped (delivery) → completed`, plus `cancelled`, `returned`; payment is the order's finance invoice
  (verified by staff against a slip; moves after *confirmed* need a verified payment or a recorded override); every change goes through a `SECURITY DEFINER` function and is written to `shop_events` (who, when, detail).
  Amounts, customer and fulfilment are frozen by a trigger. Orders are never deleted.
* **Pick-up** already exists as `fulfilment = 'pickup'` (collect at the shop), with no time.
* **Roles**: the database has `SUPER_ADMIN`, `ADMIN` (both are "staff": `shop_is_staff()`) and `USER` (customers). There is no separate employee role; an employee who prepares orders is an `ADMIN` account.
* **Notifications**: LINE only. A queue (`line_outbox`, retries after 1/2/5/15/60 min, delivery log, resend) drained by the `line-dispatch` Edge Function every minute; one admin group plus per-user targets; switches in `line_settings.events`.
  LINE is switched on in production. There is no push, e-mail or in-app notification for shop orders.
* **Stock**: there is **no central stock** (inventory is local to the staff browser). Availability = the *sold out* switch and a *max per order* per SKU. Prices are decided by the server.
* **Scheduler**: `pg_cron` is installed (job `line-dispatch`).

## Decision

A **preorder is a pick-up order with a schedule**, not a new kind of order table: `shop_orders.order_type = 'preorder'` with `pickup_at` (the start of the chosen slot). It rides on the existing
invoice, slip, wallet, rewards, status engine, audit trail and LINE group card. Nothing is copied.

Approaches considered: (a) a separate `preorders` table family (rejected: duplicates payment, status, audit, rewards and the LINE card, and the two lists would drift); (b) a free-text note on a pick-up order
(rejected by the request: it must be structured, capacity-checked and schedulable); (c) **extend `shop_orders` (chosen)**.

### Lifecycle (no second status system)

| Preorder meaning | Stored as | Who |
|---|---|---|
| Pending confirmation | `new` | customer placed it (paid first, as for every order) |
| Confirmed | `confirmed` | staff (or the LINE card) |
| Preparing | `preparing` | staff; auto-assigned to the person who starts it when nobody is |
| Ready for pickup | `ready` (from `preparing` or `packed`) | staff, **only when every line of the checklist is ticked** |
| Picked up / completed | `completed` | staff hands over |
| Cancelled | `cancelled`, `cancel_kind = customer` | customer (only while `new`, unpaid, before the cut-off) or staff |
| Rejected | `cancelled`, `cancel_kind = rejected` | staff cancelling an order that was still `new` |

Payment rules are unchanged: nothing after *confirmed* without a verified payment (or a recorded override). Confirming a preorder whose pickup time has already passed is refused.

### Scheduling

* `preorder_settings` (one row, **off until a SUPER_ADMIN saves the opening hours and switches it on**): slot length (default 30 min), earliest pickup = now + lead time (120 min), furthest day (14), opening hours per weekday,
  capacity per slot (4 orders; optional unit limit per slot and per day), customer cut-off for changes (180 min before pickup), alert lead times, and a "large order" threshold.
* `preorder_days`: closures (holidays) and special hours for single dates, managed by any staff member. Closing a day that already has orders needs an explicit "force" and puts those orders on the attention list.
* A slot is available when: it is on the grid of an open day, not earlier than now + lead, not later than the furthest day, and capacity is left. Capacity counts **orders and units** (units = sum of quantities) and every active
  preorder in the slot, not a fixed workload per order; the unit limit is what absorbs big orders. Per-product workload is a documented extension (no data to base it on today).
* All times are `Asia/Bangkok` (no daylight saving). The database stores `timestamptz`; the app formats in Bangkok time.
* Race safety: placing, rescheduling and staff moves take a transaction advisory lock per **pickup day** before counting, so two customers can never take the last slot.

### Changes and cancellation

* Items, quantities and amounts are frozen after ordering (existing rule, and it protects payment and rewards). So the customer **can change the pickup time and the instructions** (status `new` or `confirmed`, before the cut-off, at most 3 times)
  and **cancel while the order is new and unpaid**; any other change ("different quantity", cancel after payment) is a **request to the shop** (`preorder_request_change`) that lands in the staff alerts and LINE group; the shop cancels
  (reversing the payment on Payment review first, the existing rule) and the customer orders again ("order again" already exists).
* Staff may move a preorder to another slot with a reason (capacity can be overridden explicitly), assign it to an employee, tick the checklist, and move the status.

### Notifications (one pipeline, reusing LINE)

* `preorder_notices`: the in-app inbox and the history. Unique `dedupe_key` per (order, kind, occasion) so nothing is sent twice. Audience `customer` (shown on the order page) or `staff` (shown on the Preorders page).
* LINE delivery reuses `line_outbox` (new event `preorder`, plain text built in Thai in the database; three switches `preorder` (group), `preorder_staff` (the assigned employee), `preorder_customer` (the customer)).
  Sending is best effort in a sub-transaction: a LINE problem can never fail or roll back an order. Delivery status, errors and resend are the existing delivery log; the notice links to its queue row.
* A 5-minute `pg_cron` job (`preorder_sweep`) writes the time-based notices: customer pickup reminder, "should be started" / "late" / "waiting for pickup" for staff.
* Not available because nothing is configured: push notifications and e-mail. The in-app inbox is the fallback when LINE is off or a person has no LINE.

### Screens

* **Customer app**: checkout gets a third way, *Preorder (pick up later)*, shown only when the shop offers it: choose a day (chips), then a time (grid showing full / too soon slots as disabled), instructions with quick phrases, and the
  confirmation sheet shows date, time, items, quantities and total. Orders list: a "scheduled pickups" chip and the pickup time on each card; order page: schedule, preparation progress, updates, change time, request a change, cancel.
* **Back office**: *Preorders* (dashboard cards + attention list, list with search/filters/sort/paging, day schedule timeline, alerts, settings & closures) and *Pickup prep* (mobile-first employee board: due today and upcoming,
  checklist per order, customer note and phone, Start / Ready / Handed over). The existing Online shop order drawer shows the pickup schedule and supports the preorder moves.

### Non-goals / limits (stated, not hidden)

* No central stock exists, so nothing is reserved or deducted; "stock" is the sold-out switch, max per order and the slot capacity. No duplicate inventory transaction is possible because none is made.
* No push / e-mail. Customer LINE messages need the same LINE provider (existing LINE setup note) and the owner's `preorder_customer` switch.
* Changing items after ordering is cancel + re-order by design (amounts are frozen records).

## Go-live (needs the owner)

1. Deploy `line-dispatch` (new `preorder` event renders; backward compatible). 2. Apply `20261128100000_preorders.sql` (adds columns/tables/functions; feature stays off). 3. Publish the app.
4. Back office → Preorders → Settings: opening hours, capacity, then switch on. Rollback: switch off; `supabase/rollbacks/20261128100000_preorders_down.sql` refuses once a preorder exists.
