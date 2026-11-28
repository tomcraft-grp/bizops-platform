# The receiver of a slip, three outcomes, and learning from staff

Builds on [slip-review.md](slip-review.md), [premium-qr-slip-check.md](premium-qr-slip-check.md) and [own-slip-reader.md](own-slip-reader.md).
Migration `20261128150000_slip_recipient_check.sql`. No payment or order status was added, and **nothing confirms, posts or rejects a payment by itself**: a person still
checks the bank record (Confirm, then Post).

## What was wrong before

| Found | Effect |
|---|---|
| The own reader looked for the shop's first name **anywhere** in the text | The shop's name in the sender line or in a memo made a slip "ours". On 13 real slips it found the receiver 0 times. |
| An unread receiver was only a note | The AI reader could say `match` without ever reading who was paid. |
| Names were compared as "the start of an account name" | "ณัฐพร" alone passed. OCR errors (a lost tone mark, ธ for ร) were neither tolerated nor flagged. |
| A visible account number was enough even when the name was someone else's | A masked number shows 4 or 5 digits, and many accounts share them. The invented test slip pays "ทดสอบ ผู้รับ" to xxx-xxx2625-1, which matches the last digits of the shop's SCB account. |

## Who may be paid

The **authorized recipients** are the names of the shop's active accounts: `finance_bank_accounts.account_name` (today SCB **ณัฐพล อยู่ยิ้ม**, BBL **ณัฐพร อยู่ยิ้ม**)
and the default payment account's `merchant_name` / `slip_name_alt` (the KASIKORN QR, **ณัฐพร อยู่ยิ้ม**). A manager adds a recipient by adding an account, as before.
**Spellings** of a holder (English, another legal spelling, what the reader keeps reading) are kept in `finance_slip_name_variants`; only a manager adds or retires one.
Nothing is hard-coded: `finance_slip_holders()` builds the list.

## Finding and comparing the receiver

1. **Where** (`finance_recipient_candidates`, the database, from the text the staff browser read): after a receiver label at the **start of a line** (ไปยัง, ถึง, ผู้รับ, ผู้รับเงิน,
   ชื่อบัญชีผู้รับ, To, ...), or, with no label, the **second** of exactly two titled names (Thai slips print the sender first). One candidate per reading (the browser reads the
   picture three times and sends the readings apart, engine `browser-ocr/2`). Lines of the slip's own fields (จำนวนเงิน, เลขที่รายการ, ...) are never a name; OCR noise after a name is cut.
2. **Compare** (`finance_recipient_match`): titles, spaces, sara am and zero-width marks are tidied first.

   | Verdict | When | Example |
   |---|---|---|
   | match | the same name; a surname the bank masked or cut whose start agrees; an approved spelling; or digits of one of our accounts | `น.ส. ณัฐพร อ***`, `ณัฐพรอยู่ยิ้ม` |
   | partial | our first name only | `ณัฐพร` |
   | near | 1 or 2 letters away (a lost tone mark or a look-alike letter costs ½) | `ณัฐพธ อยู่ยิ้ม`, `ณัฐพง อยู่ยิ้ม` |
   | conflict | the name is clearly someone else's, the visible digits look like ours | |
   | other | a name of the same script that is none of ours | `นาย สมชาย ใจดี`, `ณัฐพร ใจดี` |

3. **Together** (`finance_recipient_check`): **match** when a reading is ours and none is someone else; **mismatch** when no reading is ours and at least two readings
   (the AI reader: its one reading) say someone else; **uncertain** otherwise; **unclear** when nothing was read. One bad OCR reading can never reject a slip.

## The three outcomes (`finance_slip_decision`)

| Outcome | When | What staff do |
|---|---|---|
| **rejected** "ไม่ผ่านเงื่อนไขสำคัญ" | the receiver is not ours (`RECEIVER_MISMATCH`), the reference or the file was used before, the file or the slip's QR is not genuine, the slip says the transfer failed, or, read with certainty (0.9+), another amount or another day | Do not confirm without the bank record. **No confidence outweighs these.** |
| **review_required** "ต้องให้เจ้าหน้าที่ตรวจ" | anything not read, only near (`RECEIVER_UNCERTAIN`, `RECEIVER_UNCLEAR`), a QR reference that differs (OCR misreads them), low confidence, unusual time | Look at the slip. |
| **verified** "ผ่านการตรวจ" | the classifier says match, the receiver is ours, nothing else is in doubt | **Still check the bank record before Confirm.** |

The classifier's own result codes are unchanged, except that an unclear or uncertain receiver is now `manual_review`.
What the customer is told by the database (`finance_my_slip_check`) is unchanged: a receiver that is not ours gets the same words as a clean slip, so a forger learns nothing.

## The customer's phone (before ordering)

When the check before ordering is on, `finance_own_reader()` also returns the holders' names (the ones the payment card shows; never an OCR spelling, never a number).
The phone runs the same rules (`src/slipReader/recipient.ts`, kept equal to the SQL by shared tests) and shows a third row, **ผู้รับเงิน**: green with the name, or
"ผู้รับเงินในหลักฐานไม่ใช่บัญชีของร้าน" when two readings agree it is someone else; then the customer must tick before ordering (as for amount and date). A near or unreadable name asks nothing of
the customer. The phone stores and decides nothing.

## Feedback and learning (controlled; nothing learns by itself)

* **Truth comes from people only**: a payment *posted after the bank check* was genuine and paid to us; one *rejected by staff* was not acceptable; a *staff judgement* of a reading.
  A reading that said "verified" is never truth.
* **Feedback**: in a slip's detail, a verifier presses **ถูกต้อง** or **ไม่ถูกต้อง แก้ไข** (the right outcome, who the slip really pays, the name as printed). Append-only
  (`finance_slip_feedback`), audited, changes nothing on the payment.
* **Accuracy card** (Payment review, "การตรวจผู้รับเงินและความแม่นยำ"): outcomes of the newest reading of each slip against what staff finally did (the dangerous mistake,
  *passed but rejected*, is shown on its own), amount read right on posted slips, confidence bands against the bank, weeks, receivers not ours / unreadable.
* **Spellings are proposed, never applied**: a misreading becomes a proposal only when staff corrected it on **two or more slips, at least two posted after the bank check,
  none rejected**, within three letters of the holder. A manager sees how many past slips showed it (posted / rejected / open) and approves it, or not. A spelling ever read on a
  slip staff rejected cannot be approved (it may be what a forger writes). Retiring one stops it at the next reading; old readings keep what they said.
* **Confidence threshold**: the card shows calibration; the threshold (Review settings) is never changed automatically.

## Audit trail

Each new reading (`finance_slip_analysis`, append-only) also stores `decision`, `recipient` (status, holder, method, confidence, each reading's candidate with its verdict) and
`rules_version` (`rules-2026-11-28`). The OCR text itself is still not stored; the sender's name is not stored. Readings made before this migration are not rewritten
(their outcome is computed from their stored reasons when shown). Feedback, spellings and every approval are in `finance_events`.

## Security

Staff-only reads (RLS `finance_can('view')`); feedback needs a verifier; spellings need a manager; the matcher, the holders with account numbers and the classifier cannot be
called from the API at all. The browser cannot hand in a receiver (the database reads the text); the AI reader cannot hand in receiver candidates (they are stripped).

## Go-live

1. Apply `20261128150000_slip_recipient_check.sql` (owner's approval). Publish the app.
2. Nothing to switch on: from the next reading the receiver is checked. The phone shows the receiver row while "Check the slip for the customer before they order" is on.
3. Ask staff to press ถูกต้อง / แก้ไข on readings for the first weeks: that is what the accuracy card and the proposals are made of.
4. If real slips print an English name, add it on the card ("ชื่อภาษาอังกฤษ").

The app can be published before the migration: an older database gives no names (no receiver row) and reads the separated text as one.

## Rollback

`supabase/rollbacks/20261128150000_slip_recipient_check_down.sql`: the four functions get back their exact previous text (test `slip_recipient_check_down_post.sql`), the
added functions are dropped. The tables and columns are kept when anything was recorded in them (nothing is lost), dropped when empty.

## Tests

```
node scripts/local-pg/run.mjs supabase/tests/slip_recipient_check.sql                       # 121: scenarios A to J, layouts, outcomes, learning, security
node scripts/local-pg/run.mjs supabase/rollbacks/20261128150000_slip_recipient_check_down.sql supabase/tests/slip_recipient_check_down_post.sql
npx vitest run tests/unit/slipRecipient.test.ts                                              # the TypeScript twin on the same cases (fixtures/recipient-cases.json)
npx playwright test -c playwright.shop.config.ts tests/shop-e2e/own-reader.spec.ts           # the real OCR engine on invented slips; the staff card and feedback
```

Changed on purpose in older suites (each marked in the file): `slip_review.sql` (an unclear receiver is now manual_review; name someone else's + our digits is now a conflict;
20 keys of an analysis), `own_slip_reader.sql` (slip texts with the line break OCR prints), `checkout_slip_check.sql` (`recipients` in `finance_own_reader`).

## Limits

* The layouts were designed from known Thai bank slips and checked on **invented** slips with the real engine; no real customer slip was used. Watch the accuracy card.
* Slips that print the receiver only in English need the English spelling approved; until then such a receiver is "not comparable" → review.
* A slip edited with care can still show our name: only the bank record proves money arrived.
