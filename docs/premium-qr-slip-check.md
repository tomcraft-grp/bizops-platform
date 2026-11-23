# Payment card, saving the QR, and the slip check the customer sees

Builds on [checkout-payment-ux.md](checkout-payment-ux.md) and [slip-review.md](slip-review.md). No new payment or order status was added.

## Root causes

| Problem | Cause | Where |
|---|---|---|
| Two QR codes on the screen | After "save", the page drew the saved picture under the QR | `QrPanel` in `src/wallet/PayTo.tsx` |
| Saving did nothing in LINE | The only method was `<a download>` on a picture made in the page. In-app browsers ignore it, and nothing else was tried | `downloadBlob` in `src/finance/qrImage.ts` |
| "Pay to KASIKORN BANK" | The QR account has no recipient name; the label staff typed was shown as if it were one | `finance_payment_accounts.merchant_name` |
| A QR payment could be flagged once the AI is on | Same missing name: when the holder is not also the holder of a listed bank account, a correct slip read `RECEIVER_MISMATCH` (test R2). Live, the BBL account has the same holder, so a Thai-name slip would have matched; the English spelling would not | `finance_slip_receivers` |
| A reused slip could pass the "already submitted" check | The browser's own fingerprint of the file was trusted | `finance_submit_evidence` |
| A wrong file was refused only after "place order" | Type and size were checked late | `src/shop/CartPage.tsx` |

## The payment card

One QR, black on white with its quiet zone, 1024 px. Around it: amount, recipient, account (last four digits read from the QR itself), status, three steps, save. Before showing anything the
page reads the QR text: a wrong checksum, or an amount that is not the amount on the card, means no QR.

## Saving the QR (`src/wallet/qrSave.ts`)

| Device | Way |
|---|---|
| Desktop, Android browser | File download, `payment-qr-<order>.png` (`payment-qr-checkout-<amount>.png` before the order exists) |
| iPhone / iPad, LINE that can share files | The phone's share sheet with a real PNG ("Save Image") |
| LINE and other in-app browsers that cannot | The picture full screen (press and hold), and a button that opens a private 10-minute link in the phone's own browser |

"Cannot save it?" opens the full-screen picture on any device. While it is open the QR on the card is taken away, so there is never more than one.

## Slip verification: what exists

```
customer attaches slip -> private storage -> order + slip saved in ONE database call
   -> Edge Function slip-analyze (asynchronous, never blocks the order)
        Claude reads the picture (extraction only; never sees the expected amount, date or receiver)
        the slip's own QR is decoded; the stored bytes are fingerprinted
   -> finance_classify_slip (database rules, exact decimals, Asia/Bangkok): amount, date, time, receiver, duplicate, tampering, confidence
   -> finance_slip_analysis (append-only log of every attempt)
   -> staff dashboard "Slips to check": Confirm (against the bank record) -> Post
   -> customer: finance_my_slip_check
```

The reader is behind one interface (`Provider` in `core.ts`) and the decision is in the database, so either can be replaced. The status words asked for map onto what exists:

| Asked | Existing |
|---|---|
| PENDING / PROCESSING | analysis `queued` / `running` |
| VERIFIED | evidence `verified` = posted by staff after the bank record. **Never from a reading** |
| REJECTED | evidence `rejected` (staff, with a reason) |
| MANUAL_REVIEW | stage `manual_review`, and every result that is not `match` |

### Two kinds of information

* **Read from the picture:** amount, date, names, reference, confidence, signs of editing. Shown to staff as a hint ("AI check passed, not proof of payment").
* **Verified against the bank:** what a verifier enters at Confirm from the bank record. Only this makes an order paid. **There is no automatic approval**, at any confidence.

### What the customer sees

| Finding | Customer |
|---|---|
| being read | checking the amount and the date |
| amount differs | both amounts; attach another slip |
| earlier day / future day | the date on the slip |
| already used, not a slip, unreadable | said plainly |
| clean, low confidence, provider down, **or suspicious** | "staff will check" — on purpose the same words |

The last row is a security decision. If a suspicious slip got a different answer, a forger could try edits until the answer changed. Fraud signals, confidence, receiver and reference never leave
the database. This replaces the earlier rule that a customer sees nothing of the check (owner's request, 2026-11-23).

### Dates

A transfer may be dated from `slip_window_before_min` (120) before the order to `slip_future_tolerance_min` (10) after the upload, because customers pay first. Another Bangkok day is `date_mismatch`; the same day
outside the window is `time_anomaly`. Managers change both numbers on the Review settings card.

## Database: `20261124100000_slip_check_customer.sql`

`finance_my_slip_check`, `finance_set_payment_account_name` (manager, audited), `finance_payment_accounts.slip_name_alt`, the second name in `finance_slip_receivers`, two rules in `finance_classify_slip`
(`FILE_HASH_MISMATCH`, `DUPLICATE_FILE`), bucket `payment-qr`. Nothing changes while `ai_review_enabled` is off. Rollback: `supabase/rollbacks/20261124100000_slip_check_customer_down.sql` (proved exact).

## Go-live

1. Apply the migration. Publish the app. (Card, saving and labels work from here.)
2. Recipient name: written on the live account on 2026-11-23 (owner). Add the English spelling on Payment review -> Payment account if slips use it.
3. To switch the AI on: create an Anthropic API key with billing; set the secret `ANTHROPIC_API_KEY`; deploy `slip-analyze` (verify_jwt ON); update the privacy notice (slip images go to the AI provider);
   turn on `ai_review_enabled`; send real slips of each kind (table in slip-review.md) and look at the dashboard.

## External services

| Service | Needed for | State |
|---|---|---|
| Anthropic API key | reading slips | **missing**; the request has never been made for real |
| Bank / slip-verification API (bank, or a licensed provider) | authoritative automatic verification | **not connected**; needs a contract and credentials. It belongs at Confirm, which already records where a confirmation came from |

## Limits

* A slip edited with its QR untouched can pass any image reader. That is why staff check the bank.
* Sharing and the outside link were tested in an emulated LINE, not in the LINE app. Try both on a real iPhone and a real Android phone.
* `payment-qr` keeps one picture per customer (the amount and the shop's account), overwritten every time.
* The reader calls the API with `fetch`, as before.

## Tests

`tests/unit/qrSave.test.ts`, `tests/unit/slipAnalyze.test.ts`, `tests/shop-e2e/premium-qr.spec.ts`, `supabase/tests/slip_check_customer.sql`:

```
node scripts/local-pg/run.mjs --skip slip_check_customer --skip line_order_notifications supabase/migrations/20261124100000_slip_check_customer.sql supabase/tests/slip_check_customer.sql
```
