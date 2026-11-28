# The shop's own slip reader (no AI service)

Builds on [slip-review.md](slip-review.md) and [premium-qr-slip-check.md](premium-qr-slip-check.md). Owner's decision (2026-11-23): own code instead of an AI key.
Since 20261128150000 the receiver is found by its place on the slip and is a critical check, with three outcomes and staff feedback: see [slip-recipient-check.md](slip-recipient-check.md).

## How it works

```
a verifier opens a slip (or presses "Read all waiting slips")
  -> the picture is downloaded with the verifier's own permission and read IN THE BROWSER
       Tesseract OCR (Apache-2.0, files in /ocr of this site), three readings of the picture that must agree
       the slip's own QR: sending bank, reference, checksum
       fingerprint of the file
  -> finance_store_reading: the database finds the receiver in the text, then the SAME rules as the AI reader judge it
  -> the same log, dashboard, reasons and customer messages
  -> a person compares with the bank record: Confirm -> Post (unchanged)
```

Nothing is sent to anyone. A browser test fails if a single request leaves the site.

## Safety rules

* A doubtful value is left empty: two readings disagree, a number is cut in two, or a leading 8 could be the baht sign. A person then looks.
* The browser never decides the receiver or the expected amount. The database looks for one of the shop's names or account endings in the text; if none is there, the result can never be "match".
* The text that was read is not stored.
* `match` still means "check the bank". Nothing is confirmed automatically.
* The customer is told about an amount or a date only when the reader was sure of that value. "Unreadable" from OCR is never blamed on the customer.
* On the customer's phone see "The check before ordering".

## Accuracy

Measured in Chrome on 60 **invented** slips (5 layouts, 3 fonts, 3 sizes, JPEG 60 to 90, no bank's real design):

| | right | left empty | wrong |
|---|---|---|---|
| amount | 54 | 6 | 0 |
| date | 58 | 2 | 0 |
| reference | 59 | 1 | 0 |
| slip QR | 60 | 0 | 0 |

36 of 60 were sure enough for `match`. About 9 seconds each on the test machine. **Real slips may do worse.** Measure before relying on it: Payment review -> "Measure it on posted slips" reads up to 20
posted slips again and compares with what staff recorded from the bank. It stores nothing. Real customer slips were not used to build this.

It cannot: prove money arrived, see an edited picture whose QR is untouched, or read a PDF (a person does).

## The check before ordering

Its own switch on the same card: **Check the slip for the customer before they order** (`finance_settings.checkout_check_enabled`, migration `20261124120000`; it started with the reader's value).

| The phone finds | The customer sees | Ordering |
|---|---|---|
| still reading | "Checking your slip" | asked to wait, never longer than 20 seconds |
| amount and day agree | green, both values | goes on |
| surely another amount or day, or no slip | what differs | must tick "I have checked it" (owner's choice, 2026-11-24) |
| not clear | "our staff will check it" | goes on |
| PDF, old browser, data saver, weak phone, engine missing | nothing | goes on |

The tick counts for that picture and that total only. The same check runs when a slip is sent for an existing order; its date may be as old as the order. The date rule is the two numbers of the Review settings card.
It runs on the customer's own phone and proves nothing: it stores and sends nothing, and staff check every slip against the bank.

## Switching it on

1. Apply `20261124110000_own_slip_reader.sql`, then publish the app **and the `/ocr` folder** (`public/ocr`, about 8 MB) to gh-pages. Without the folder the reader says so and nothing else changes.
2. Payment review -> "Slip reader (no AI)": press **Measure it on posted slips** first (works while off). Look at the **Read wrongly** column.
3. Turn the switch on. It is off until a manager does. Off again = everything as before.

With the AI reader also on, a slip the AI is reading is left to it.

## Database

`finance_settings.own_reader_enabled`, `finance_own_reader`, `finance_set_own_reader` (manager, audited), `finance_store_reading` (verifier; at most 5 attempts per slip, shared with the AI reader), and
`finance_my_slip_check` (sure values only). Rollback: `supabase/rollbacks/20261124110000_own_slip_reader_down.sql`, proved exact; stored readings stay.

A finished own reading does not send the LINE alert of an AI reading: the person who pressed the button is looking at it.

## Files and tests

`src/slipReader/` (`parse.ts` text to values, `engine.ts` the picture, `store.ts`, `ReaderCard.tsx`, `SlipLive.tsx`), `supabase/functions/slip-analyze/qrPayload.ts` (shared by browser and Edge Function).
`tests/unit/slipParse.test.ts`, `tests/shop-e2e/own-reader.spec.ts` (the real engine reads real pictures of invented slips), `supabase/tests/own_slip_reader.sql`:

```
node scripts/local-pg/run.mjs --skip own_slip_reader --skip line_order_notifications supabase/migrations/20261124110000_own_slip_reader.sql supabase/tests/own_slip_reader.sql
```

`public/ocr`: `worker.min.js` and `tesseract-core-simd-lstm.wasm.js` from tesseract.js 6.0.1 / tesseract.js-core 6.1.2, `tha` and `eng` from @tesseract.js-data 1.0.0 (`4.0.0_best_int`), all Apache-2.0.
To update: copy the same files from the new packages and run the browser test.
