# LINE OA order notifications: setting up, going live, daily routine, rollback

Builds on [online-ordering.md](online-ordering.md) (orders and slips) and [slip-review.md](slip-review.md) (Confirm, then Post at end of day).
Design: `docs/superpowers/specs/2026-11-22-line-order-notifications-design.md`; plan: `docs/superpowers/plans/2026-11-22-line-order-notifications.md`.
Migration `supabase/migrations/20261122130000_line_order_notifications.sql`, rollback `supabase/rollbacks/20261122130000_line_order_notifications_down.sql`,
Edge Functions `supabase/functions/line-webhook/` and `supabase/functions/line-dispatch/` (shared code in `supabase/functions/_shared/`).

**Status (2026-11-22): built and tested on branch `feat/line-order-notifications`. NOT applied to the live database, NOT deployed, NOT published.**

## What it does

* A new online order shows up in **one admin LINE group** as a card: order number, customer, date, up to 3 items with pictures (`+ อีก N รายการ` beyond), total, how it was paid, status.
* Buttons on the card: **รับออเดอร์** (confirm the order), **รับ + อนุมัติเงิน** (confirm the order and the slip at the amount and transfer time the customer gave, after a confirm step), **ปฏิเสธ** (pick a reason: the slip is rejected and the order cancelled), and links **ดูรายละเอียด**, **ตรวจสลิป** (open the back office on that order / slip in the phone's browser, sign-in required) and **โทรหาลูกค้า**.
* Only the first tap works. Everyone else gets "ออเดอร์ ORD-… ถูกรับแล้วโดย คุณ A เมื่อ 14:05". Each tap is checked by the database with the same rules as the web, **as the staff member whose LINE is linked**, and recorded in the order and finance history under that person.
* Follow-ups in the group when an order is confirmed or cancelled on the web, when a slip arrives or is replaced, and when a slip is rejected / more evidence is requested / the AI check fails. Each kind can be switched off. Optionally the customer gets a LINE message when the order is accepted or cancelled.
* Sending never blocks an order: messages wait in a queue (`line_outbox`), are retried after 1, 2, 5, 15 and 60 minutes, and end as "ส่งไม่สำเร็จ" after 6 attempts. **Settings → LINE notifications → Delivery log** shows every message with its error and a **ส่งใหม่** button.

## What is dark and what is not

* **Dark until a SUPER_ADMIN switches it on:** everything LINE. With the switch off nothing is queued, no button works, nothing is sent. **Quick approve** has its own switch (off) and a maximum per order (฿3,000 by default).
* **Not dark: the bank reference is optional** (owner's decision, 2026-11-22). As soon as the migration is live, *Payment review → Confirm* accepts an empty reference, and *Post* accepts one typed then (from the statement) or none. Without a reference, a payment with **the same amount, to the same account, in the same minute** as one already confirmed or posted is refused as a possible duplicate (`อาจเป็นสลิปซ้ำ`); entering the reference lets it through. The legacy one-step verify still requires a reference. As soon as the app is published, the dashboard shows the badges **อนุมัติด่วนจาก LINE** and **ไม่มีเลขอ้างอิง** and a filter chip for LINE quick approvals.

## Setting up LINE (once)

1. **LINE Developers console** (developers.line.biz) → the **same provider** that holds the existing LINE Login channel `2012605932` (the LIFF app). Create a **Messaging API** channel there (this creates the LINE Official Account). Using the same provider keeps a customer's LINE user ID identical in both channels, which the optional customer message needs.
2. In the Messaging API channel:
   * **Channel secret** (tab *Basic settings*) and a **long-lived channel access token** (tab *Messaging API* → *Issue*). Keep both private.
   * **Webhook URL**: `https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-webhook`, then **Use webhook: on**. (*Verify* works only once the function is deployed and the secret is saved.)
   * **Allow bot to join group chats: on.**
3. **LINE Official Account Manager** → *Response settings*: **Chat: off**, **auto-reply messages: off**, **greeting message: off or short** (otherwise the OA answers every message in the group).
4. **Plan and quota** (Thailand, before 7% VAT, check the current price list): **Free** 300 messages/month, **Basic** ฿1,280 for 15,000, **Pro** ฿1,780 for 35,000. A message pushed into a group counts **once per member**; the bot's replies to a tap are not counted. Example: 30 orders a day into a group of 4 ≈ 3,600 cards a month plus follow-ups, which needs **Basic**. When the quota is used up, LINE refuses pushes (HTTP 429): orders are unaffected, messages retry and then show as failed in the delivery log.

## Go-live (in this order; each step after testing needs the owner's go)

1. **Apply the migration** (after `bash scripts/run-line-sql-tests.sh` reports all passed, at a quiet time):
   `bash scripts/apply-migrations.sh 20261122130000:line_order_notifications:supabase/migrations/20261122130000_line_order_notifications.sql`
   It enables `pg_net` and `pg_cron`, creates the tables, the queue and a job `line-dispatch` that runs every minute. Nothing is sent while LINE is off.
2. **Deploy the two functions** (signature / shared secret are their credentials, so JWT verification is off):
   `supabase functions deploy line-webhook --no-verify-jwt --project-ref hlvravynjalculvplrxc`
   `supabase functions deploy line-dispatch --no-verify-jwt --project-ref hlvravynjalculvplrxc`
3. **Publish the app** (same procedure as in [rewards.md](rewards.md): build, commit `dist/index.html`, push `main`, then `gh-pages`). Tell staff first: Confirm no longer requires a reference.
4. **Settings → LINE notifications** (SUPER_ADMIN): paste the channel secret and the access token → *Save credentials* → *Test connection* (shows the OA's name). Copy the webhook URL into the console if not done.
5. **Bind the group**: invite the OA to the admin group → *Make a group code* → type the 6 digits in the group within 10 minutes → the bot answers "ผูกกลุ่มนี้เรียบร้อย".
6. **Every staff member who will tap cards**: *Link my LINE* → add the OA as a friend → send the 6 digits to the OA in a private chat → "เชื่อมบัญชีเรียบร้อย". Unlinked people can see cards but taps answer "บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ".
7. **Switch LINE on.** Place a real test order (see "Smoke test"). **Quick approve last**, when the team is used to it.

## Daily routine

* Cards come in; whoever is free taps **รับออเดอร์**. A finance verifier or manager may use **รับ + อนุมัติเงิน** for an order within the maximum when the customer gave the transfer time. That only *confirms* the payment.
* **End of day**: *Payment review → Slips to check* → filter **อนุมัติด่วนจาก LINE** and look for **ไม่มีเลขอ้างอิง**: compare each with the bank statement, type the bank reference when Post asks (optional), and **Post**. Only Post makes the money official. A slip that is not on the statement is rejected there (the order can then be cancelled).
* *Settings → LINE notifications → Delivery log → Failed*: anything red was not delivered (wrong token, quota, LINE down). Fix the cause and press **ส่งใหม่**.

## Smoke test after go-live

1. Place an order with a slip from a customer account → the card appears in the group within seconds.
2. Two phones tap **รับออเดอร์** at the same moment → one gets "✅ รับออเดอร์…", the other "…ถูกรับแล้วโดย…". The web order shows *confirmed* with the first person in its history.
3. Forward a card to another chat and tap it there, or tap with an unlinked account → nothing changes.
4. With quick approve on: **รับ + อนุมัติเงิน** → confirm → the slip shows *Confirmed* with the badge; Post it at the end of the day.
5. **ปฏิเสธ** → pick a reason → the slip is rejected and the order cancelled; the customer sees the reason.
6. Change the token to a wrong value → place an order → the delivery log shows the error (no token in it) → put the right token back → **ส่งใหม่** → delivered.

## Security model

* The webhook trusts a request only with a valid `X-Line-Signature` (HMAC-SHA256 with the channel secret). Each event's `webhookEventId` is handled once.
* Receiving a card proves nothing. A tap acts only for a **linked, active ADMIN or SUPER_ADMIN**, and the existing database functions check the role again: money actions (quick approve, rejecting a waiting slip) need the finance **verifier** role or above. Every action takes the order row lock, so concurrent taps cannot both succeed.
* Credentials live in **Supabase Vault**, are written by a SUPER_ADMIN through the Settings card and never returned to any browser; errors stored in the delivery log are redacted.
* Links in cards open the normal back office, which requires sign-in and the usual permissions.

## Rollback

1. Switch LINE off in Settings (stops everything at once).
2. Undeploy the functions: `supabase functions delete line-webhook` and `supabase functions delete line-dispatch` (project `hlvravynjalculvplrxc`).
3. Run `supabase/rollbacks/20261122130000_line_order_notifications_down.sql`, then delete version `20261122130000` from `supabase_migrations.schema_migrations`. It **refuses while a transfer is confirmed without a bank reference** (the restored Post needs one): Post those with a reference, or reject them, first. LINE settings, links and the delivery log are dropped; the audit trail of every action stays in the order and finance history.
4. Restore the previous app build if wanted (the old app works with the new database and with the rolled-back one).

## How it is tested

* `bash scripts/run-line-sql-tests.sh`: 84 checks against the live project in one rolled-back transaction: settings and credentials, linking codes and rate limit, webhook dedupe, optional reference and the minute duplicate rule, quick confirm, card data, every `line_act` path (accept, second tap, web-cancelled order, quick approve and each guard, a replaced slip, reject with and without the finance role, reject after a posted payment), queue triggers, retries, dead letters, send again, customer message, grants.
* `bash scripts/run-line-down-proof.sh` (+ `guard`, `control`): the rollback restores the public schema exactly, unschedules the job, deletes the Vault secrets, and refuses while a confirmed transfer has no reference.
* Unit tests (`npm test`): signature, postback data, Flex cards, retry classification, redaction, the webhook and dispatcher handlers with fakes, the Settings helpers, the optional reference in the slip screens.
* Browser tests (`npx playwright test -c playwright.shop.config.ts`): the Settings card, deep links to an order and a slip, Confirm without a reference, the duplicate message, the badge and filter, Post with an optional reference.
* **Not tested before go-live:** a real LINE delivery and tap (no channel yet), two phones tapping at the same moment (a rolled-back transaction cannot hold two sessions; the order row lock is what serialises them), and the Deno entry files (`index.ts`, thin wiring) are only checked when deployed.

## Known limits

* One admin group; no per-person delivery or per-person event choice yet (the queue already supports user targets).
* A sent card cannot be edited (LINE has no such API): its buttons stay, and late taps get the "already done" answer.
* The slip picture is not shown inside LINE (it is private); **ตรวจสลิป** opens it behind sign-in.
* The older SQL suites `supabase/tests/slip_review.sql` and `online_ordering.sql` hard-code SKU `FG-000001`, which is no longer sellable, so they abort on `main` too. Run on copies with a sellable SKU, they pass on top of this migration except three intended differences in `slip_review.sql`: a blank reference is no longer refused, Post has the new 3-argument signature, and a list row has 30 keys instead of 28.
