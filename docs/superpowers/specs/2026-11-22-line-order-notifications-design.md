# LINE OA order notifications with in-LINE approval — design

Status: approved by the owner on 2026-11-22 ("1+2 together", "use the transfer date/time instead of a reference", "group", "proceed, I authorise"; on review: the bank reference is optional everywhere, at Confirm and at Post too; the other designer's calls accepted). Builds on [online-ordering.md](../../online-ordering.md), [slip-review.md](../../slip-review.md), [wallet-and-payments.md](../../wallet-and-payments.md).

## Intent

When a customer places an online order (usually with a transfer slip), the shop's administrators see a clear order card in their LINE group within seconds and can act on it from the card: accept the order, accept it and approve the money in one go, or reject it with a reason. Details and the full slip open the existing back office on that exact order. Only one person can act on an order; everyone in the group sees who did what. The database stays the source of truth and every action goes through the same rules and audit trail as the web app.

Why: staff should not have to keep the back office open to notice new orders; LINE is where they already are. The goal is an operational interface, not just another notification.

## Goals

1. A Flex card in one admin LINE group for every new online order, sent asynchronously after the order is saved, with retries and a visible delivery log.
2. Buttons on the card:
   * **รับออเดอร์ (Accept)**: order `new → confirmed`, nothing about money (option 1).
   * **รับ + อนุมัติเงิน (Accept + approve payment)**: order confirmed **and** the slip moved to *Confirmed* at the amount and transfer time the customer gave, without a bank reference (option 2). Shown only when the guards below pass. The money is still not official until **Post** in the web app at end of day.
   * **Bank reference optional everywhere (owner's decision):** for a transfer slip on an order, the reference is optional at web Confirm, at Confirm & Post and at Post, not only in LINE. When it is given, today's reused-reference check runs as before; when it is missing, the duplicate check below (amount + receiving account + transfer minute) runs instead. Wallet deposits and cash are out of scope and unchanged.
   * **ปฏิเสธ (Reject)**: pick a reason, then the slip is rejected (if one is waiting) and the order cancelled.
   * **ดูรายละเอียด / ตรวจสลิป / โทรหาลูกค้า**: links to the back office on that order / that slip, and a `tel:` link.
3. Exactly one successful action per order, whatever the number of admins, taps, or duplicated webhooks. Late tappers get "already accepted by A at 14:05".
4. Follow-up messages in the group when status changes (from LINE or from the web), and when a slip arrives or is replaced, or a payment problem occurs. Each event type can be switched on or off.
5. A LINE section in Settings: on/off, credentials (write-only), connection test, bind the group, link my LINE, event switches, quick-approve rules, reject reasons, delivery log with "send again".
6. Ships **dark**: with LINE switched off (default) nothing is queued and nothing behaves differently.

## Non-goals (this round)

Individual (1:1) delivery of cards and per-admin event preferences (the schema allows a user target later); LIFF; editing a sent message (LINE cannot); a rich menu; customer-initiated order edits (no such feature exists); changes to the AI slip reader; payment providers or slip-lookup APIs; actions beyond the first step of the order lifecycle (preparing, packed, shipped stay in the web app).

## Anti-goals

* A LINE outage, bad credentials or a full message quota ever making an order fail or slow down checkout.
* Receiving a card, or holding a forwarded link, being treated as permission. Permission comes only from a linked, active staff account with the right role, checked by the same database functions the web uses.
* A one-tap LINE action making money official (Post) or skipping the end-of-day bank check.
* A second, LINE-only copy of order logic or order status.
* Credentials reaching the browser, git, or logs.

## Constraints (from the project)

* One Supabase project = production. SQL tests run in a single transaction that always rolls back (`scripts/run-*-sql-tests.sh` pattern). Migration + `supabase/rollbacks/` file + SQL tests; applying to the live project is a separate step.
* Static frontend on GitHub Pages (HashRouter); secrets live only server-side.
* There is **no background job infrastructure** today: no `pg_net`, no `pg_cron`, three Edge Functions (`line-auth`, `slip-analyze`, `feedback-english-context`). This work enables `pg_net` and `pg_cron`.
* Staff sign in with email + password and have no LINE ID. Customers' `profiles.line_user_id` comes from the LINE Login channel `2012605932` (LIFF `2012605932-nfC3frpA`).
* Roles: shop staff = `profiles.role in ('ADMIN','SUPER_ADMIN')` (`shop_is_staff`); money = `finance_can('verify')` (verifier or manager; SUPER_ADMIN is manager).
* Existing order rules: `shop_admin_set_status` (`new → confirmed` needs staff, no payment); `shop_cancel_order_internal` refuses while a slip is `submitted` (`SLIP_PENDING`) or a receipt is posted. Slip rules: `finance_confirm_evidence` needs amount, bank reference and time; `finance_post_evidence` → `finance_verify_core`, which requires a bank reference for a transfer. Slip file reuse is already blocked by the unique index on `file_sha256`.
* Staff UI strings go through `Tx` + `TH_BACKOFFICE`; LINE cards are Thai.
* Message cost (Thailand, prices before VAT, check the current table before go-live): Free 300 messages/month, Basic ฿1,280 for 15,000, Pro ฿1,780 for 35,000. A push into a group counts **once per member**; replies (answering a tap) are not counted. Example: 30 orders/day to a group of 4 ≈ 3,600 cards/month + web-originated follow-ups → Basic plan.

## Approaches considered

1. **Everything in LINE (Flex + webhook only).** Fastest for simple taps, but the full slip and order detail do not fit a card, and a private slip image cannot be shown safely in LINE.
2. **Card + secure link only.** Simplest and safest; every action needs a page load and sign-in, which loses most of the speed the owner wants.
3. **Hybrid (chosen).** Simple, guarded actions run from the card through a signed webhook; anything needing judgement (full slip, other reasons, later statuses) opens the existing back office on that record.
4. **LIFF.** Nice in-LINE pages, but staff sign in by email, so LIFF adds a second identity path and a second LINE app to maintain for little gain now. Can be added later on top of 3.

Distribution: **one admin group** (chosen) over individual messages or both. One card everyone sees, coordination happens in the chat, the "already done by A" reply is visible to all, and it costs fewer messages than sending each admin their own card plus "taken" notices.

## Design

### Identity and binding

* **Messaging API channel** created under the **same LINE provider** as the existing Login channel, so a customer's user ID is the same in both (needed only for the optional customer notification).
* **Link my LINE (staff):** Settings → *Link my LINE* shows the OA's add-friend QR and a 6-digit code (valid 10 minutes, single use, stored hashed). The admin sends the code to the OA in a 1:1 chat; the webhook binds `line_staff_links (profile_id, line_user_id)`. A separate table, not `profiles.line_user_id`, because that column is the customer login identity with a unique index. Unlink: self or SUPER_ADMIN. Wrong codes: at most 5 per LINE user per hour.
* **Bind the group (SUPER_ADMIN):** invite the OA to the group, generate a group code in Settings, type it in the group. Exactly one bound group. Events from any other group or chat are ignored (except link codes in 1:1). A `leave` event unbinds the group and shows a warning in Settings.
* **Who tapped:** the webhook's `source.userId`, trusted only after the `X-Line-Signature` HMAC-SHA256 check with the channel secret. If `userId` is missing or not linked, the bot replies "บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ" and does nothing.

### Acting as the staff member (no bypass)

The webhook Edge Function calls one service-role-only RPC, `line_act(p_line_user, p_action, p_order, p_card, p_reason, p_event_id)`. It resolves the linked active profile, then sets the transaction-local JWT claims (`set_config('request.jwt.claims', {sub, role:'authenticated', email}, true)`) so that `auth.uid()` is that staff member, and calls the **existing** functions: `shop_admin_set_status`, `finance_reject_evidence`, and the new quick-confirm below. Every existing role check, lock, and audit row (`shop_events`, `finance_events`, `cancelled_by`, `confirmed_by`) therefore applies unchanged; LINE adds `via: 'line'` to the event detail. `line_act` returns a structured result (`done`, `already_done {by, at, status}`, `not_allowed {why}`, `refused {code}`) that the webhook turns into a reply.

### Actions

| Button | Who | What happens (one transaction) |
|---|---|---|
| รับออเดอร์ | linked ADMIN / SUPER_ADMIN | `shop_admin_set_status(order, 'confirmed')`. If the order is no longer `new`: `already_done`. |
| รับ + อนุมัติเงิน | linked staff who is also verifier+ | Tap → bot replies a confirm card "อนุมัติ ฿2,500 · โอนเข้า SCB · 22 พ.ย. 14:05 ?" [ยืนยัน] [ยกเลิก]. On ยืนยัน: re-check every guard, then `finance_quick_confirm_evidence(slip)` and `shop_admin_set_status(order, 'confirmed')`. |
| ปฏิเสธ | linked staff (+ verifier if a slip is waiting) | Tap → bot replies a reasons card (reasons from Settings, plus "อื่น ๆ" which opens the web order). On a reason: `finance_reject_evidence(slip, reason)` if a slip is `submitted`/`confirmed`, then `shop_admin_set_status(order, 'cancelled', reason)`. Existing refusals apply (posted payment → refused). |
| ดูรายละเอียด | anyone (link) | Opens `…/?openExternalBrowser=1#/shop-admin?order=<id>`; sign-in and role checks as today. |
| ตรวจสลิป | anyone (link) | Opens `…/?openExternalBrowser=1#/payment-review?evidence=<id>`. |
| โทรหาลูกค้า | anyone | `tel:` the order's contact phone. |

`openExternalBrowser=1` sends the link to the phone's normal browser, where staff are usually already signed in, instead of LINE's in-app browser. `ShopAdmin` and the payment review page learn to open a record from these query parameters.

### Quick approve (option 2) guards and effect

The card is shared by the whole group, so the button's presence can depend only on the order (guards 1 and 3 to 8, evaluated when the card is rendered); the tapper's role (guard 2) is checked on the tap. The action succeeds only if **all** hold at the moment of the tap (checked again on ยืนยัน):

1. `line_settings.quick_approve_enabled` (off by default).
2. The tapper is linked, active, shop staff and `finance_can('verify')`.
3. The order is `new`; it has exactly one slip in `submitted`, method transfer, from the customer.
4. The slip has a customer-given transfer date/time (`claimed_transfer_at`). Checkout keeps this field optional; without it the card shows only รับออเดอร์.
5. The claimed amount ≤ `quick_approve_max_amount` (default ฿3,000) and equals what the invoice still owes.
6. The transfer time is within the existing slip windows (`slip_window_before_min`, `slip_future_tolerance_min`) and not older than the invoice.
7. **Duplicate check without a reference:** no other evidence in `confirmed`/`verified` with the same amount, the same receiving bank account, and a transfer time within the same minute (`finance_quick_dup`). A match refuses and says "อาจเป็นสลิปซ้ำ ตรวจในเว็บ". The same file is already blocked by `file_sha256`.
8. If an AI analysis exists for the slip and is not a clean match, refuse (send to the web). With the AI switched off this check is skipped.

Effect: `finance_quick_confirm_evidence` sets the slip to `confirmed` with `confirmed_amount = claimed_amount`, `confirmed_transfer_at = claimed_transfer_at`, `confirmed_bank_ref = null`, `confirm_note = 'LINE quick approve'`, a new column `confirmed_via = 'line_quick'`, and logs `evidence.confirm` with `via: 'line_quick'`. The customer still sees "awaiting verification" until Post.

**Reference optional at Confirm and Post (web):** `finance_confirm_evidence` accepts an empty reference for a transfer; `finance_post_evidence` gains an optional `p_bank_ref` (Post may add the reference if the person has it, never required); `finance_verify_core` accepts a null reference for a transfer. With a reference: the existing normalised reused-reference checks and the unique index apply unchanged. Without one: `finance_quick_dup` (same amount, same receiving bank account, transfer time in the same minute, against other `confirmed`/`verified` evidence and posted receipts) refuses with "อาจเป็นสลิปซ้ำ" and the person can still proceed only by entering a reference. The transfer date/time stays required at Confirm (it is the key of that check). The web Confirm form and the Post dialog mark the reference field "ไม่บังคับ". The slip review dashboard shows a "อนุมัติด่วนจาก LINE" badge and filter on quick-approved slips, and a "ไม่มีเลขอ้างอิง" marker on any slip posted without one, so the end-of-day check against the bank statement can focus on them.

### Events, queue, delivery

* `line_settings` (singleton): `enabled`, `group_id`, `events jsonb` (`order_new`, `slip_new`, `order_status`, `payment_issue`, `customer_notify`), `quick_approve_enabled`, `quick_approve_max_amount`, `reject_reasons text[]`, credential presence flags and timestamps. Written by SUPER_ADMIN through RPCs; read by staff.
* `line_outbox`: `id, event, order_id, evidence_id, target_type ('group'|'user'), target_id, status ('queued'|'sending'|'sent'|'failed'|'dead'|'skipped'), attempts, next_attempt_at, last_error, line_request_id, created_at, sent_at`. It is also the delivery log. Unique `(event, order_id, evidence_id, target_id)` for card events so a trigger firing twice cannot send two cards.
* **Enqueue (cheap, in the same transaction, can't fail on LINE):**
  * `order_new`: deferred constraint trigger on `shop_orders` insert (fires at commit, so the slip created in the same call exists).
  * `slip_new`: trigger on `finance_payment_evidence` insert for a shop order's invoice, skipped when the order was created in the same transaction (`order.created_at = now()`).
  * `order_status`: trigger on `shop_orders` status change to `confirmed` or `cancelled`, skipped when the change came from `line_act` (a transaction-local flag), because the tapper's reply already announced it.
  * `payment_issue`: slip rejected (from the web), more evidence requested, or an AI result that is not a match.
  * `customer_notify`: on confirm/cancel, to the customer's LINE user ID, only when switched on; a "not a friend of the OA" answer ends as `dead` with no retry.
  * Nothing is enqueued while `enabled` is off or no group is bound.
* **Send:** Edge Function `line-dispatch` claims due rows (`for update skip locked`), renders each card from the **current** order state at send time (an order already accepted before the card goes out gets the status line, not live buttons), pushes it, and records the result. Triggered right away by `pg_net` from an `AFTER INSERT` on `line_outbox` (the HTTP call only happens after commit), and every minute by `pg_cron` for retries. Auth: a random shared secret header (stored like the credentials).
* **Retry policy:** back-off 1, 2, 5, 15, 60 minutes, then `dead` after 6 attempts. `429` and `5xx` retry; other `4xx` go straight to `dead` with the error. A retry key (`X-Line-Retry-Key` = outbox id) stops LINE from delivering a retried push twice.
* **Replies:** answers to taps use the reply token (free, single use, short-lived); if replying fails, fall back to a push.

### Card content (Thai, mobile)

Header "ออเดอร์ใหม่" + status chip (รอยืนยัน / รับแล้ว / ยกเลิก). Order number, customer name, date and time, item count, total. Up to 3 lines of items with thumbnail (`shop_image_url`, public catalogue pictures), name, qty × price; "+ อีก N รายการ" beyond that. A payment line: "โอน SCB · แนบสลิปแล้ว · เวลาโอน 14:05" or "ชำระด้วยกระเป๋าเงิน". The slip **picture is not put in the card**: it lives in a private bucket and LINE copies images to its own servers; ตรวจสลิป opens it behind sign-in. Buttons as in the table. Follow-ups are a one-line card: "✅ ORD-… รับแล้วโดย คุณ A · 14:05" / "❌ ORD-… ยกเลิกโดย คุณ B · เหตุผล: …".

### Webhook

Edge Function `line-webhook` (`verify_jwt = false`): reject a bad signature with 401; return 200 quickly. Each event's `webhookEventId` is inserted into `line_webhook_events` (primary key; duplicates skipped; rows kept 30 days). Handles: `postback` (actions, by `p_card` = outbox id + action + order id; the card must exist and match the order), `message` in 1:1 (link code) and in the bound group (group code only), `join`/`leave`. Everything else is ignored. Actions are idempotent anyway because the order row is locked and its state checked.

### Credentials

Channel secret and channel access token are entered in Settings and stored in **Supabase Vault** through a SUPER_ADMIN-only RPC; they are never returned to any client (Settings shows "set · changed 22 พ.ย. by A"). Edge Functions read them through a service-role-only RPC. Errors and logs never include them (the dispatcher redacts known secrets the way `slip-analyze` does). *Test connection* calls LINE's bot-info endpoint and shows the OA name. If Vault is not available on the project, fall back to Edge Function secrets and show the credentials as "managed by the developer".

### Settings UI

A new **LINE notifications** card set on the Settings page, backed by the database (the rest of that page is local prototype data). Edit: SUPER_ADMIN; view: staff. Sections: Connection (switch, credentials, test, webhook URL to copy), Group (bind / status), My LINE (link / unlink; the list of linked staff for SUPER_ADMIN), Events (switches), Quick approve (switch, maximum amount), Reject reasons (list), Delivery log (last 100, filter failed, "ส่งใหม่").

### Rollout

1. Migration (dark): tables, triggers, RPCs, extensions, quick-confirm and Post change; rollback file. With `enabled` off nothing is queued and the old app works unchanged.
2. Deploy `line-webhook` and `line-dispatch`; publish the app (Settings card, deep links, reference optional in Confirm and Post, badges).
3. Owner: create the Messaging API channel, paste credentials, set the webhook URL, bind the group, staff link their LINE, switch on. Quick approve stays off until the owner is comfortable.
4. A configuration guide in `docs/line-notifications.md` (LINE Developers console steps, auto-reply off, group joins allowed, plan and quota, daily routine, rollback).

## Testing

* **SQL (rolled back):** enqueue on order / slip / status; no enqueue when off; deferred trigger sees the slip; dedupe of cards; `line_act` accept, concurrent accept (two sessions, one wins, other gets `already_done`), quick-approve each guard failing, duplicate minute match, amount cap, AI mismatch, reject with and without slip, reject after posted payment refused, unlinked / disabled / non-verifier actors, actor recorded in `shop_events` and `finance_events`; webhook event dedupe; Confirm and Post with no reference succeed, and a same-amount / same-account / same-minute slip is refused; with a reference the old reuse checks still fire; rollback restores the schema.
* **Edge Function units (Deno):** signature check (valid, tampered, missing), postback parsing, card rendering (1, 3, 12 items; wallet; no transfer time; already accepted), retry classification (429, 500, 400), secret redaction, reply-then-push fallback.
* **Browser (fake backend):** Settings card, link flow, delivery log and resend, deep links open the right order and slip, Confirm and Post accept an empty reference and show the duplicate warning.
* **Live smoke test after go-live:** a real order to the real group; two phones tapping Accept together; turn the token wrong to see failed → retry → resend; a forwarded card tapped by an unlinked account.

## Calls to check (the designer's, not the owner's)

* (Decided by the owner on review: the bank reference is optional at every step; duplicates without a reference are caught by amount + receiving account + transfer minute.)
* Quick-approve cap default ฿3,000; reject reasons default: สลิปไม่ถูกต้อง, ยอดเงินไม่ตรง, สินค้าหมด, ลูกค้าขอยกเลิก.
* Links open in the phone's browser (`openExternalBrowser=1`).
* The slip picture is not embedded in the card.
* Credentials in Vault, edited in Settings.

## Left to the builder

Exact Flex JSON and colours, table and index details, back-off constants, code format, how the dispatcher batches, Thai copy wording, migration split.

Verify first (read-only on the live project): `pg_net`, `pg_cron` and Vault can be enabled; `auth.uid()` reads `request.jwt.claims`; `shop_log` / `finance_log` take the actor and e-mail from `auth.uid()` / the claims (so the claims set by `line_act` are what gets recorded). If any of these is not true, stop and report rather than work around it.
