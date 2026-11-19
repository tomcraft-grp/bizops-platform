# AI-assisted slip review with end-of-day approval: going live, daily routine, limits

Builds on [online-ordering.md](online-ordering.md) (orders, slips, verification), [wallet-and-payments.md](wallet-and-payments.md) (bank accounts, wallet, ledger queue) and [customer-shop.md](customer-shop.md).
Design: `docs/superpowers/specs/2026-11-19-slip-review-eod-design.md`; plan: `docs/superpowers/plans/2026-11-19-slip-review-eod.md`.
Migration `supabase/migrations/20261120100000_slip_review.sql`, rollback `supabase/rollbacks/20261120100000_slip_review_down.sql`, Edge Function `supabase/functions/slip-analyze/`.

**Status at the time of writing (2026-11-20): built and tested on branch `feat/slip-review-eod`, NOT applied to the live database, NOT deployed.** The AI and the database behaviour ship dark (two switches, both off), but **the staff screens do not**: they change the moment the app is deployed, whatever the switches say. Read the next section before deploying. The Anthropic request was never made for real (no API key was available), so the first real call is part of the go-live checklist.

## What is dark and what is not

**Dark (nothing is different until a manager switches it on, `ai_review_enabled` and `post_requires_manager` both off):**

* **The AI reader.** Nothing is queued, the Edge Function and the staff "Run AI check" answer `AI_DISABLED`, and the button is not shown while the switch is off.
* **The manager-only Post of transfers.** With `post_requires_manager` off a verifier Posts a transfer as before.
* **The database with the migration applied and the app NOT yet deployed.** The old one-step `finance_verify_evidence` answers exactly as before and a customer's slip is handled as before (apart from the small output changes listed under "Known limits"). The old app keeps working on the new schema.

**NOT dark: visible as soon as the new app is deployed (no switch controls any of it, and no new setting was added for it):**

* **Staff lose the one-step "Verify and record payment" screen.** *Payment review → Slips to check* is the new dashboard: Confirm, Confirm & Post (the one-step equivalent while the manager rule is off), Post, Reject, Request more evidence, the filters and the KPI strip.
* **Record payment appears on every open invoice row** (tab *Invoices*) and on the slip detail, **including cash**, for every verifier and above.
* **Customers see the new copy**: "Pending payment verification – awaiting staff confirmation", the paid / remaining line of a part-paid order, the "more evidence requested" banner and the history line for a slip replaced by a newer one.

So deploying the app is the real go-live for staff and customers: do it at a quiet time and tell the staff first. Because of this, the rollback is different from what "dark" suggests: see "Rollback".

## What it does

1. **The customer** places an order and attaches the transfer slip in one step (already true before this change). The order says **"Pending payment verification – awaiting staff confirmation"** (Thai: รอตรวจสอบการชำระเงิน – รอเจ้าหน้าที่ยืนยัน). It never says "paid" because of a slip, and the customer is never blocked by staff.
2. **The AI pre-check.** When `ai_review_enabled` is on, every new slip is queued for an AI reader as soon as it is stored. The reader (Edge Function `slip-analyze`, Claude Haiku 5.5) reads the amount, date, time, sender, receiver, bank, reference and any tamper signs, and decodes the QR printed on the slip. A deterministic SQL classifier then labels the result (`match`, `amount_mismatch`, ...) and records **every** rule that applied. The reading is stored append-only; staff can re-run it (a new attempt, the old ones stay).
3. **End of day: Confirm.** An authorised administrator opens **Payment review → Slips to check**, compares each slip with its order, checks the **bank record**, and presses **Confirm** with the amount, reference and time **the bank shows**. Confirm touches no receipt and no invoice: the customer still sees "pending".
4. **Post.** **Post** is what makes the money officially received: it creates the receipt, allocates it to the invoice, queues the ledger entry and credits any excess to the customer's wallet (exactly what the old one-step verify did). Only now the customer sees "paid" / "partly paid". Posting twice is harmless (the second call answers `replay: true`).
5. **Other outcomes.** **Reject** (reason required; the customer can send a new slip) and **Request more evidence** (a short message the customer sees; they upload another slip to the same invoice, no second order).
6. **Partial and back-office payments.** One order can be paid in several parts: each Posted slip adds to "paid", the customer sees "Paid ฿200 · remaining ฿150". Staff can **Record payment** for the remainder (on the slip detail, and on each invoice row): by **bank transfer** (bank reference required, optional slip file) or by **cash** (a note is required, no reference, no file). A recorded payment is created already *confirmed* and still needs **Post**; **a cash entry can only be posted by a manager**, whatever the settings (cash has no bank record to check, so the person who records it and the person who posts it are two people). A payment above what is still owed (counting entries confirmed but not yet posted) is refused; a cash entry can never create a wallet credit.

The AI is a reader and a risk flagger, never the decision maker: it never confirms, posts, rejects or changes any status, and customers never see anything it found.

## Roles and settings

Roles are the existing finance roles `viewer < clerk < verifier < manager` (a SUPER_ADMIN acts as manager). Every rule is enforced in the database; the buttons only mirror it.

| Action | Minimum role |
|---|---|
| See the dashboard, the slips and the settings | viewer |
| Confirm, Reject, Request more evidence, Record payment, Run AI check | verifier |
| Post a **transfer** (and the old one-step verify, which is transfer-only) | verifier; **manager** while `post_requires_manager` is on |
| Post a **cash** payment | **manager always**, whatever `post_requires_manager` says |
| Change the review settings; reverse a receipt; cancel an invoice | manager |
| Customers | never read an analysis or call an analysis function |

Five settings, on the existing `finance_settings` row. A manager changes them on the **Review settings** card at the bottom of Payment review → Slips to check (shown to managers only; they apply from the next slip or action):

| Setting | Default | Meaning |
|---|---|---|
| `ai_review_enabled` | off | The AI reads every new slip. While off, nothing is queued and the Edge Function (and the staff "Run AI check") answers `AI_DISABLED` / does nothing. |
| `post_requires_manager` | off | Only a manager may Post a transfer (and so also use the old one-step verify). Cash is always a manager's, with this on or off. |
| `ai_min_confidence` | 0.80 (0 to 1) | Below this overall confidence an AI result is "manual review". |
| `slip_window_before_min` | 120 (0 to 1440) | A transfer may be dated this many minutes before its order was created. |
| `slip_future_tolerance_min` | 10 (0 to 1440) | ...and this many minutes after the slip was uploaded (clock differences). |

A slip is "in the window" when its time lies in [order created − `slip_window_before_min`, slip uploaded + `slip_future_tolerance_min`].

## Statuses

**Payment (slip) stage** is derived, not stored (the dashboard's "Stage" filter and column):

| Stage id | English | Thai | When |
|---|---|---|---|
| `slip_submitted` | Slip Submitted | ส่งสลิปแล้ว | status `submitted`, and no analysis yet / queued / running |
| `ai_completed` | AI Verification Completed | AI ตรวจแล้ว | `submitted` and the newest analysis finished with `match` |
| `manual_review` | Manual Review Required | ต้องตรวจสอบด้วยตนเอง | `submitted` and the newest analysis finished with any other result, or failed |
| `confirmed` | Payment Confirmed | ยืนยันการชำระแล้ว | status `confirmed` (waits for Post) |
| `posted` | Invoice Posted | ลงรายการแล้ว | status `verified` (= posted) |
| `rejected` | Payment Rejected | ปฏิเสธการชำระ | status `rejected` |
| `more_evidence` | More Evidence Requested | ขอหลักฐานเพิ่ม | status `more_evidence` |

Evidence statuses in the table: `submitted`, `confirmed`, `more_evidence`, `verified` (= posted), `rejected`. When a customer sends a **new slip** after "more evidence", the older slips of the same invoice that are still waiting for more evidence are closed by a database trigger as `rejected` with the reason "Replaced by a newer slip" (audit event `evidence.superseded`, no reviewer): left open they would stay in the unresolved list for ever and block the order's cancel. The invoice state follows the newest slip; the customer's history says "replaced by the slip you sent after", not "rejected". Order status is unchanged (the shop's enum); "Pending payment verification" is derived (order not fully paid with a slip waiting).

**AI result codes** (`finance_slip_analysis.result`; the classifier applies the first matching rule and records all reasons):

| Code | Meaning |
|---|---|
| `manual_review` | not a slip, unreadable, amount or date missing, or confidence below `ai_min_confidence` |
| `duplicate_suspected` | the bank transaction reference was already seen on another analysis, receipt, slip or wallet deposit (letters and digits compared, so dashes, case and spaces do not hide it). A customer re-sending the same transfer after their slip on the SAME order was rejected or sent back for more evidence only gets an info reason, `RESUBMITTED_TRANSFER`. |
| `suspicious_slip` | a high tamper signal, QR reference different from the printed one, wrong QR checksum on a slip-structured QR, receiver clearly not the shop's, or the slip does not say the transfer succeeded |
| `amount_mismatch` | amount differs from what the order expects, exact to the satang (`AMOUNT_UNDER` / `AMOUNT_OVER`) |
| `date_mismatch` / `time_anomaly` | date, or time of day, outside the window / missing |
| `match` | shown as "Verified / Match", with the hint **"AI check passed — not proof of payment"** |

The expected amount is the payment request's amount if there is one, else what the invoice still owes. All reason codes and their Thai/English texts are in `src/finance/review.ts` (`REASON_TEXT`); a test fails if the SQL emits a code the screen does not know.

**Invoice state codes** (`finance_invoice_state_raw().status_code`, shown to customers by their order screen): 0 Unpaid, 1 Awaiting payment (QR), 3 Pending verification, 4 Partially paid, 5 Fully paid, 6 Overpaid – under review, 7 Payment rejected, 8 Cancelled, 9 QR expired, **10 More evidence requested** (new). Code 2 is not used. Precedence: cancelled, overpaid-review, fully paid, pending (a slip `submitted` or `confirmed` waits), more evidence, partly paid, rejected, QR, unpaid. The state also carries `confirmed_pending` (money confirmed but not yet posted) and `more_evidence_message` (only at code 10).

## The daily routine for the owner

1. Open **Payment review → Slips to check**. The strip at the top counts what is waiting: awaiting, AI verified, manual review, suspicious, confirmed, posted, rejected, more evidence. (The three AI tiles do not overlap; a slip still waiting for the reader is only in "awaiting".)
2. Look at the **suspicious** slips first (duplicate or suspicious result).
3. Open a slip: the picture beside the order, a comparison table (what the order expects against what the AI found, red where different, with the reasons in plain words), the history of AI attempts, and the buttons. If a slip shows "Slip Submitted" for a long time, press **Run AI check** (it also covers a customer who closed the app before the reader was called).
4. Open **the bank app or statement** and find the transfer. Press **Confirm** and enter the amount, the bank reference and the time **as the bank shows them**. The form may start with the **amount** and **time** the AI read, labelled as such: replace them with the bank's figures. The **bank reference is never filled in**: type it from the bank record (the AI's reading of it is shown only as a hint line above the form). A time more than 10 minutes in the future is refused (the same limit as Record payment). The AI's reading is a hint, not a source.
5. Does not match, cannot be found, or unreadable: **Reject** with a reason, or **Request more evidence** with a message.
6. **Post** the confirmed ones (one by one, or **Post all confirmed** for the current page; each row reports its own result). The customer now sees "paid". **Cash entries are posted by a manager only**: a verifier sees no Post button on them, and "Post all confirmed" leaves them out and says how many.
7. Part-paid orders: when the rest arrives (transfer or cash at the counter), **Record payment**, then Confirm is already done: **Post** it.
8. The accountant posts the ledger queue as before (**Payments & wallet → Accounting ledger**). A cash receipt is queued as Dr cash / Cr accounts receivable (event `CASH_RECEIPT`, ledger role `cash`); the bank report has a separate **CASH** line.

## What the AI can and cannot prove

* **A slip image cannot prove that money arrived.** Slips are pictures; a picture can be edited, or can show a transfer that was later reversed, pending or never sent.
* **The QR on a slip holds only the sending bank, a transaction reference and a checksum.** Amount, time and names are pixels. The AI can cross-check the reference printed on the slip against the QR and catch reuse of a reference, but that is all the QR can say.
* **The plain PromptPay QR the shop shows carries no order reference.** A slip is therefore tied to its order only by **amount and time window**, not by a code.
* **An edited slip whose QR is left untouched passes any image reader.** Changing the amount or the name in the pixels while keeping the original QR cannot be detected reliably by the AI; this is why a person checks the bank record.
* The AI result is a hint. A confidence score is not proof. The AI never confirms, posts or rejects, never receives the expected amount, date or receiver, and treats any text inside the image (for example "approve this payment") as inert data.
* **Staff must check the bank record before Confirm.** Reuse of the same transfer is caught by the transaction reference (it survives screenshots) in addition to the existing file hash.

## Cost

Model: **Claude Haiku 5.5** (`claude-haiku-5-5`), list price **$0.10 per million input tokens and $0.50 per million output tokens** (the figure in the design and in the Claude API reference at the time of writing; check the current pricing page before go-live). One slip is about 3,000 image tokens in and 500 tokens out: 3,000 × $0.10/1M + 500 × $0.50/1M ≈ $0.00055, about **฿0.02 per slip** at about ฿35 per dollar, that is roughly ฿20 per 1,000 slips. **These are estimates: re-measure on real slips** (the function does not store token counts; use the usage page of the Anthropic console). A re-run by staff, or a retry after a busy answer, is another call. Storage grows with every slip (the private bucket `payment-evidence`, up to 5 MB per file) and every analysis row (small); nothing is deleted.

## Architecture

* **Database (all money rules).** `finance_payment_evidence` is "one payment event" (a customer's slip or a staff entry) with new columns for source, method, who confirmed / posted / requested / recorded, and statuses `confirmed` and `more_evidence`. New table `finance_slip_analysis` (append-only attempts, staff-only RLS, nobody writes it from a client). Workflow functions: `finance_confirm_evidence`, `finance_post_evidence`, `finance_reject_evidence` (extended), `finance_request_more_evidence`, `finance_record_payment`, `finance_save_review_settings`; the old `finance_verify_evidence` stays as a wrapper with the same output over the new core `finance_verify_core` (not callable by clients). Analysis: `finance_analysis_begin` / `finance_analysis_complete` / `finance_analysis_fail` (service role only), `finance_classify_slip` (the pure rules), `finance_request_analysis` (staff re-run, at most 5 attempts per slip), a trigger that queues attempt 1 for every new slip with a file while `ai_review_enabled` is on, and a second trigger (`finance_evidence_supersede_old`) that closes the older "more evidence" slips of an invoice when the customer sends a new one. A unique index on the **normalised** confirmed reference (`finance_slip_ref(confirmed_bank_ref)`, letters and digits only, upper case) keeps one bank transaction to one confirmed or posted payment whatever its spelling. `finance_slip_ref` is closed to clients but granted to the service role (index entries are computed as the writing role). Reads for staff: `finance_review_list`, `finance_review_summary`, `finance_review_detail`, `finance_review_settings`. `finance_cancel_invoice` and `shop_cancel_order_internal` refuse while a slip is confirmed (the shop one also while submitted or waiting for more evidence); `shop_my_orders`' "To pay" chip includes state 10.
* **Edge Function `slip-analyze`** (Deno; `core.ts`, `qr.ts`, `handler.ts`, `index.ts`, `deno.json`). `POST {evidence_id | invoice_id}` with the caller's JWT (verify_jwt stays ON; allowed origins `https://tomcraft-grp.github.io`, `http://localhost:5173`). The database function `finance_analysis_begin` alone decides who may call (a customer for their own order, or staff). It downloads the slip from the private bucket by the path stored in the database (JPEG, PNG or PDF, at most 5 MB), decodes the slip QR in the function (JPEG and PNG only; a PDF is not QR-checked; pictures over 8 megapixels are not decoded), sends the picture to the model with an extraction-only prompt and a JSON schema (no tools, never the expected values), validates the reply and normalises it (Buddhist Era years, Thai month names, two-digit years, Asia/Bangkok). It writes **only** through the three RPCs. The answer to the caller is only `{status: completed | failed | nothing_to_do}`: never the verdict. A missing key, an outage, a refusal or a bad reply stores a `failed` attempt that shows as manual review; nobody is blocked.
* **UI.** Staff: `src/finance/SlipReview.tsx` (the "Slips to check" tab), `RecordPayment.tsx`, `review.ts` (client and labels). Customer: status copy in `src/shop/i18n.ts`, paid / remaining and "more evidence" banner in `src/finance/CustomerInvoices.tsx` and `src/shop/Orders.tsx`; the customer app calls `slip-analyze` once after an order is placed with a slip, and again when a slip is re-sent to an existing invoice (best effort, never awaited, never blocks anything).
* **Proof-source socket.** Confirm records what the **bank** shows (amount, reference, time) and Post is the only place money becomes received. A future slip-lookup service or a bank credit-alert feed (approaches 1 and 2 in the design, deferred) is meant to plug in by calling the same Confirm path; nothing in Post or the dashboard has to change.

## Go-live conditions and checklist

**Conditions that must hold before real use:**

* **Cash is posted by managers only** (built in, no setting). A shop whose only staff are verifiers cannot post cash until a manager exists (a SUPER_ADMIN counts as a manager).
* **Set `post_requires_manager` before any verifier who is not the owner exists.** With it off, one verifier can Confirm and Post a transfer alone; the two-person rule for transfers exists only while it is on. (Cash needs no setting.)
* **Decide when to deploy the app**: that is when staff and customers see the change (see "What is dark and what is not"). Keep the previous app build (a copy of `dist/` or the previous commit) so that the realistic rollback below is one deploy away.

Everything below that changes the live database or the live site is a deliberate step of the owner; none of it was done by the build.

1. **All suites green** (see "Tests"): `bash scripts/run-slip-review-sql-tests.sh`, `bash scripts/run-slip-review-regression.sh`, `bash scripts/run-slip-review-down-proof.sh` (and `guard`), `npx vitest run`, `npx tsc --noEmit`, the build check, the Playwright shop suite. Run the down-proof and the regression script BEFORE step 2: both are before / after comparisons and refuse or become meaningless once the migration is live.
2. **Apply the migration (dark).** `scripts/apply-migrations.sh 20261120100000:slip_review:supabase/migrations/20261120100000_slip_review.sql`. Both settings are off, so nothing changes for customers or staff **as long as the old app is still the one that is live** (the new app is not dark, see "What is dark and what is not"). Check read-only: `bash scripts/db-readonly.sh "select ai_review_enabled, post_requires_manager, ai_min_confidence, slip_window_before_min, slip_future_tolerance_min from public.finance_settings"` should read `false, false, 0.80, 120, 10`.
3. **Deploy the app** (merge, then rebuild `dist/` and publish as usual). **This is the moment staff lose the one-step verify screen and see the dashboard and Record payment (cash included), and customers see the new copy: no switch hides it.** **The app must NOT be deployed before the migration:** a customer's order history falls back gracefully (it retries the evidence read without the new columns), but the staff dashboard banner then says the finance part is not set up.
4. **Create the AI key and deploy the function.** Create an Anthropic API key and billing, then: `supabase secrets set ANTHROPIC_API_KEY=...` and `supabase functions deploy slip-analyze --project-ref hlvravynjalculvplrxc` (verify_jwt stays ON). Never put the key in the browser or in git.
5. **Switch the AI on and do ONE real smoke test.** The function does nothing while `ai_review_enabled` is off (the database refuses with `AI_DISABLED`, also for the staff "Run AI check"), so the test needs the switch on: a manager turns it on in the **Review settings** card. The switch is global (no per-user test mode): real customers' slips arriving meanwhile are read too, harmlessly (they never see it). Place test orders and send real slips of each kind, then check each result on the dashboard and, read-only, `bash scripts/db-readonly.sh "select attempt, status, result, error, engine from public.finance_slip_analysis order by created_at desc limit 20"`:

   | Slip kind | What to look for |
   |---|---|
   | a genuine **SCB** slip, a **BBL** slip, a **KBank** slip | amount, date, time, reference, receiver read correctly; QR found; `match` when the order amount is right |
   | a slip with a **Buddhist Era date** (for example 2569) | date read as the right Gregorian day, not `date_mismatch` |
   | a **PDF** slip | read by the model; a PDF is not QR-checked; nothing blocks |
   | a **screenshot** of a slip | read; QR still decodes |
   | an **edited** slip (change the amount) | at best a tamper or QR signal; remember an edit with an untouched QR can pass |
   | a **duplicate** (the same transfer sent again, also as a screenshot) | `duplicate_suspected` |
   | a slip file over about **3.7 MB** (try a 4.5 MB photo) | the picture is sent as base64, which is about 4/3 of its size, so the model's per-image limit may reject it. The attempt then ends as `failed` with `AI_HTTP_400` and shows as manual review; nothing blocks, a person checks it. The 5 MB upload limit is therefore not the AI's limit: if this happens often, ask customers for smaller pictures or resize them before sending |

   What this test settles and nothing else has: (a) whether the Anthropic endpoint accepts the exact request and JSON schema the function sends (if not, every attempt is stored as `failed` with an `AI_HTTP_400: ...` message, visible and harmless); (b) whether the QR layout implemented from the brief matches real bank slips (a decodable QR that is not slip-structured is ignored, only a slip-structured one with a wrong checksum is flagged); (c) the **CPU and memory limits of the Edge runtime**, which were never measured (locally a large phone screenshot took roughly 0.2 to 0.9 s to decode, the hosted limit may be tighter; an attempt that dies stays `running` until the 5-minute reclaim and then shows as failed with `WORKER_STOPPED`); (d) real token use and cost. If it goes badly, switch `ai_review_enabled` off again: nothing else depends on it.
6. **Leave `ai_review_enabled` on** after a good smoke test and watch the first days.
7. **Turn on `post_requires_manager`** when only a manager should be able to Post a transfer: at the latest before the first verifier who is not the owner starts work (see the conditions above).

Also before real use: **update the privacy notice** (slip images, which show names and account numbers, are sent to the model provider) and **confirm the provider's data-retention terms** for the account used.

## Rollback

**The realistic rollback is to redeploy the previous app and keep the schema.** The first Confirm (or Record payment, or analysis) writes records the database rollback refuses to destroy (see the guard below), and from then on the schema stays. The old app's one-step verify still runs on the new schema (`finance_verify_evidence` keeps its signature and answer). Order:

1. Switch the two settings off (a manager, in the Review settings card).
2. Clear what the old app does not know: Post or Reject every **confirmed** slip and every slip waiting for **more evidence** (the old screens do not show those statuses, and a confirmed payment is not money until it is posted).
3. Redeploy the previous app build. Customers go back to the old copy; their open orders and slips are untouched.
4. Keep the schema. The extra columns, the analysis table and the triggers are harmless to the old app.

The database rollback below is only possible **before** any of those records exist (for instance right after applying the migration, before the app is deployed and before the first Confirm).

`supabase/rollbacks/20261120100000_slip_review_down.sql` drops the analysis table and every column, index, constraint, trigger and function the migration added, and puts the earlier function bodies and checks back (the sections undo the migration in reverse order). Proven by `scripts/run-slip-review-down-proof.sh`: after migration + rollback the whole public schema is identical to before (every function's text and privileges, tables, columns, constraint names and definitions, indexes, triggers, policies).

**The guard.** The rollback REFUSES to run once the new objects hold records, because dropping them would destroy financial history: any analysis row, any staff-recorded payment, any evidence that is confirmed or waiting for more evidence or carries a confirm / post / request / recorder stamp, and any `CASH_RECEIPT` ledger row. Proven for each of the six kinds (`run-slip-review-down-proof.sh guard`). A slip closed by the "Replaced by a newer slip" trigger keeps its request stamp, so it counts too. Once any of those exists, do not roll back the database: use the app rollback above, with the two settings off.

**Order if the database rollback is ever needed:** switch the two settings off; check the guard would pass (no analyses, no staff entries, no confirmed slips); put the previous app back first (the staff dashboard calls review functions the rollback removes); then send the rollback file deliberately as one transaction. There is no script that applies a rollback; afterwards the migration's row in `supabase_migrations.schema_migrations` has to be removed before `apply-migrations.sh` will accept the migration again (it refuses a recorded version). This order and the removal of the row were not exercised against the live database.

## Tests

All SQL goes through `scripts/run-sql-tests.sh`, one transaction that always rolls back (the live database is the only one, there is no test copy); read-only look-ups only through `scripts/db-readonly.sh`. Last recorded results (2026-11-20, machine under load from other processes; everything below was re-run on the final code; the SQL suite and the down-proof were re-run once more after the last commit):

| Command | What it proves | Last recorded result |
|---|---|---|
| `bash scripts/run-slip-review-sql-tests.sh` | schema, classifier, queue, Confirm / Post / Reject / Request / Record payment, one-step verify unchanged, reports, reads, the "To pay" chip, RLS and grants, against real data | **1000 of 1000 checks passed** (also with the migration sent twice, and migration, rollback, migration) |
| `bash scripts/run-slip-review-regression.sh` | the three older SQL suites run before and with the migration; fails if a check that passed before fails with it, or the number of checks changes | **REGRESSION OK**: ordering 98 of 99, wallet 153 of 162, shop 176 of 180, identical before and with the migration |
| `bash scripts/run-slip-review-down-proof.sh` | migration + rollback leaves the schema identical | **10 of 10** |
| `bash scripts/run-slip-review-down-proof.sh guard` | the rollback refuses for an analysis, a staff entry, a confirmed slip, a slip waiting for more evidence, a confirm stamp, a cash ledger row | **6 of 6 refused** |
| `bash scripts/run-slip-review-down-proof.sh control` | sanity check: without the rollback the comparison must find differences | 1 of 10 passed (expected: it sees the migration) |
| `npx vitest run` | unit tests (client, labels, Edge Function with fakes, UI helpers, hygiene) | **26 files, 720 tests passed** |
| `npx playwright test -c playwright.shop.config.ts` | screens against a fake backend: customer copy and flows, staff dashboard, record payment, widths, accessibility | full suite on the final code, two shards (2026-11-20): shard 1/2 **103 passed**; shard 2/2 **101 passed and 1 failed** (`shop.spec.ts:350` "orders: list, filters, detail and self-service cancel rules", a timing race in its tab-count helper under load: it shows the previous tab's list for a moment; run alone 8 of 8 passed) |
| `npx tsc --noEmit` | types | clean (exit 0) |
| `npx vite build --outDir .superpowers/dist-check --emptyOutDir` | the production build compiles | built on the final code (2026-11-20; index.html about 2.2 MB); `dist/` untouched |

Notes on how to read these:

* **The three older SQL suites already fail some checks on production data, with or without this work**, because they were written for an empty database and production now holds real orders, wallets and ledger rows: ORDERING 1 check (98 of 99), WALLET 9 (153 of 162; it was 11 / 151 of 162 on a run where the test's bank-report window also covered a real SCB day: that count depends on the clock), SHOP 4 (176 of 180). They are NOT caused by the slip-review migration: the regression script proves the pass/fail result of every check is the same before and with it. For the wallet suite, the script patches a scratch copy only (three single-row look-ups on the ledger queue, and check W9's bank-report window narrowed to the one Bangkok day of the test); no committed test file is changed. The stock wrappers `run-ordering-sql-tests.sh`, `run-wallet-sql-tests.sh`, `run-shop-sql-tests.sh` can no longer run against the live database (they re-send migrations that are live).
* **Never use `npm run build` to verify**: it rewrites the tracked `dist/`. Use the build check above.
* Test runs rewrite tracked files under `qa/results/`, `src/generated/` and `test-results/`: discard them (`git checkout -- qa/results src/generated`) before committing.
* Browser tests use a fake backend that mirrors the database contract: they prove the screens, not the database. Playwright was run in two shards (`--shard=1/2`, `--shard=2/2`) because a loaded machine times out on the single run.
* **Not run (could not be):** the real Anthropic call; the Edge Function under Deno on the hosted runtime (the unit tests run its modules under Node with fakes); real slips from any bank; the real LINE app; real concurrency (two administrators at once: the SQL tests are single-transaction, so concurrency is argued by lock order, evidence row first and then the invoice, and not tested); list performance with tens of thousands of rows.

## Known limits and deferred items

An honest list; none of these blocks the go-live, each has an owner decision or a follow-up.

* **No proof of money.** See "What the AI can and cannot prove". The control is the human check against the bank record.
* **A stuck analysis.** An analysis left `running` (for example the Edge isolate was killed) is reclaimed by `finance_analysis_begin`, or closed as failed by a staff re-run after 5 minutes. A corner: a slip that already has 5 attempts and whose 5th is stuck `running` cannot be closed by a re-run (the cap refuses); the screen should be read as "in progress", and `begin` can still claim it.
* **Concurrency is argued, not tested** (single-transaction tests): Confirm, Post and the old verify lock the evidence row and then the invoice. Two Confirms or Records of one transfer typed differently (`ABC-123`, `abc123`) on different invoices at the same moment are stopped by the unique index on the normalised `confirmed_bank_ref` (the second waits for the first and fails with 23505); that was tested as the index refusing the second write, not as a real race. **That index covers `confirmed_bank_ref` only, that is Confirm and Record payment.** One narrow race stays a known limit: the old one-step verify does not set `confirmed_bank_ref` and compares references by exact string, so it racing a Confirm or Post of the same transfer typed differently, on a different invoice, is not closed by the index.
* **The old one-step verify compares references by exact string** (pre-existing); the new Confirm and Post use the normalised check (letters and digits only). A slip Posted first and the same transfer then verified one-step with a differently typed reference is not caught by the old path. **The wallet-deposit verify (`finance_deposit_verify`) also compares references by exact string** (pre-existing; wallet deposits are not part of this work), so a deposit and an invoice slip of one transfer typed differently are only caught when the invoice side runs the normalised check.
* **List performance.** The review list computes all matching rows before paging; the screen shows the unresolved stages by default (a "show all" switch widens it), and a date window can be added. Fine for thousands of rows; at tens of thousands consider pushing the status filter earlier and an index for the posted-in-range count.
* **Customers can read their own evidence row through RLS**, including the staff-only columns (confirm note, who confirmed or recorded, request message). The customer screens use an explicit column list and never show them, but a customer using the browser tools could read them. Hardening candidate: column privileges or a view.
* **Time zones.** The staff screens read typed times as Bangkok (+07:00). Other `datetime-local` screens (customer invoices, wallet, wallet payments admin, cart, promotions) still read them in the browser's time zone (pre-existing).
* **Deliberate exceptions to "unchanged output with the switches off":** `finance_invoice_state_raw` now counts `submitted` and `confirmed` slips in `pending_evidence` (identical until a slip is confirmed) and gains `confirmed_pending` and `more_evidence_message` keys and state 10; `finance_gl_pending` output gained the five settings keys; `finance_bank_daily_report` gains a `CASH` line and `finance_payments_overview` labels confirmed slips as themselves (only for data the new flow creates); `shop_my_orders`' "To pay" chip includes state 10. The existing suites show nothing else changed.
* **Privacy.** Slip images are sent to the model provider. Update the privacy notice and confirm the provider's retention terms before turning the AI on.
* **Pre-existing failing checks on production data** in the three older SQL suites (ORDERING 1, WALLET 9, SHOP 4), see "Tests". They are unrelated to this work.
* **Future proof source.** A slip-lookup API or bank-alert integration is the way to get real proof of money; it is out of scope here and plugs into Confirm.
* **Smaller deferred items** (reviewed, parked): a KPI "Suspicious" chip count can differ from the list it filters; "Posted today" is computed when the screen opens or refreshes (stale after Bangkok midnight on a long-open page); Esc closes both of two stacked dialogs (pre-existing global handler); the Thai "Run AI check" says "again" for a slip never analysed; the wallet-credit hint on a cash row's Post dialog can show after the outstanding dropped (the database then refuses the post with `CASH_OVERPAY`); a dark-mode (inverted) QR is not read (fails safe); duplicated paid / remaining figures on the order detail.
