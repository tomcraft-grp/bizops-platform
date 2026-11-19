# AI-assisted slip review with end-of-day approval — design

Status: approved by the owner on 2026-11-19 ("proceed, everything authorised"). Builds on [online-ordering.md](../../online-ordering.md), [wallet-and-payments.md](../../wallet-and-payments.md), [customer-shop.md](../../customer-shop.md).

## Intent

Customers place an online order and attach their transfer slip in one step and are never blocked by staff. The order says **"Pending Payment Verification – Awaiting Staff Confirmation"**. An AI reads each slip as soon as it arrives and records what it found. At the end of the day an authorised administrator opens one dashboard, compares each slip with its order, **Confirms** the payment and then **Posts** it. Only Post makes money officially received (customer sees "paid"). One order (SO) may be paid in several parts; an administrator may record the remaining payment at the back office (bank transfer or **cash**) until the order is fully paid.

Why: less manual checking, no waiting for the customer, and the owner keeps full financial control. The AI is a reader and a risk flagger, never the decision maker.

## Goals

1. Order + slip in one customer step (already true); clearer customer status copy.
2. Every slip is analysed automatically; results are stored append-only with confidence, reasons and what was read.
3. One review dashboard: KPIs, filters, slip beside order, discrepancies in red, actions Confirm / Post / Reject / Request more evidence / Record payment.
4. Two-step control: Confirm (verifier+) then Post (manager when `post_requires_manager`), each audited with who and when.
5. Partial payments and staff-recorded payments (transfer or cash) against one order.
6. Everything ships **dark**: with the new settings off the live system behaves exactly as today.

## Non-goals (not in this round)

Loyalty points and rewards in checkout, the 300-for-4 bundle SKU, fulfilment quantity and central stock, checkout screen redesign, QR changes, bank/gateway/slip-lookup API integration, LINE push messages, perceptual-hash duplicate detection, cash-drawer reconciliation, redesign of refunds, wallet deposit review. A future proof source (slip-lookup API or bank alerts) plugs in by calling the same Confirm path; nothing here blocks it.

## Anti-goals

* The AI result changing any money state, order status or invoice, or auto-rejecting anything.
* The AI result being shown to customers (it would teach people how to beat it).
* A confidence score being presented as proof that money arrived.
* Any change that makes the existing one-step verification behave differently while the new settings are off.

## Constraints

* Single Supabase project = production, no test DB. SQL tests run only through `scripts/run-sql-tests.sh` (one transaction that always rolls back). Migration + `supabase/rollbacks/` file + SQL tests. Applying to the live project is a separate, deliberate step after all suites pass.
* Frontend is static (GitHub Pages): no secret may exist in browser code. The AI key lives only as a Supabase secret read by an Edge Function.
* Financial rows are never deleted or edited in place; corrections are reversals.
* Existing roles: viewer < clerk < verifier < manager (`finance_can`). Customer UI is Thai-first with English (`src/shop/i18n.ts`); staff UI uses `Tx` + `TH_BACKOFFICE`.

## Approaches considered

1. **Slip-lookup service behind the AI** (auto-PAID, per-slip fee, KYC) — deferred: owner wants zero recurring fee and an in-house AI.
2. **Bank credit alerts as proof** — deferred: unverified for personal SCB/BBL accounts.
3. **Human confirmation with AI pre-check (chosen by the owner).** Zero recurring fee beyond the model call; matches the owner's end-of-day routine. The proof source stays a plug-in point.

Owner decisions: Option 3; customer sees "paid" only at **Post Invoice**; an order may be paid in several parts and staff can record further payments at the back office; the back-office entry accepts **cash as well as transfer**.

## Design

### What a slip image can and cannot prove
A slip's QR holds only the sending bank, a transaction reference and a checksum; amount, time and names are pixels. So the AI can read, cross-check and flag, but cannot prove money arrived. Hence: AI never confirms; a human confirms using the bank record; reuse is caught by the transaction reference (survives screenshots) in addition to the existing file hash. With a plain PromptPay QR the slip carries no order reference: a slip is tied to its order by amount and time window.

### Data model (migration `20261120100000_slip_review.sql`)
* `finance_settings` + `ai_review_enabled` (false), `post_requires_manager` (false), `ai_min_confidence` (0.80), `slip_window_before_min` (120), `slip_future_tolerance_min` (10).
* `finance_payment_evidence` (one row = one payment event) gains: `source` (`customer_slip`|`staff_entry`), `method` (`transfer`|`cash`), `recorded_by`, `confirmed_by/at/amount/bank_ref/transfer_at`, `confirm_note`, `posted_by/at`, `request_message`, `requested_by/at`; status adds `confirmed`, `more_evidence`; `file_path/file_sha256/file_type` become nullable only for `staff_entry`. Unique partial index on `confirmed_bank_ref` for statuses confirmed/verified. Status `verified` means **posted**.
* `finance_slip_analysis`: append-only analysis attempts per evidence (status queued/running/done/failed; engine; prompt_version; `extracted`, `qr`, `expected` snapshot, `overall_confidence`, `signals`, `result`, `reasons`, `error`). A finished row never changes; a new attempt is a new row (history kept). Staff-only RLS.
* `finance_gl_queue.event_type` adds `CASH_RECEIPT` (Dr cash role / Cr AR, using the existing role `cash` = account 1100). `finance_receipts.method` accepts `cash`.

### Functions
* `finance_verify_core(...)` = the body of today's `finance_verify_evidence` (no role check, not client-callable; handles `p_method` transfer|cash); `finance_verify_evidence` stays as a wrapper with identical output (role `verify`, or `manage` when `post_requires_manager`).
* `finance_confirm_evidence(evidence, amount, bank_ref, transfer_at, note)` — verifier+. Records the bank-shown values; touches no receipt.
* `finance_post_evidence(evidence, note)` — verifier+, or manager when `post_requires_manager`. Locks the evidence row, calls the core, idempotent (second call returns `replay: true`).
* `finance_reject_evidence` (extended to confirmed / more_evidence), `finance_request_more_evidence(evidence, message)`.
* `finance_record_payment(invoice, method, amount, received_at, bank_ref, bank_account, note, file…)` — verifier+; creates a `staff_entry` evidence already `confirmed`; refuses more than the outstanding (counting confirmed-unposted entries); cash needs a note, transfer needs a bank reference.
* Analysis: `finance_analysis_begin(evidence|invoice, actor)`, `finance_analysis_complete(analysis, extracted, qr, confidence, signals, engine, prompt_version)`, `finance_analysis_fail(analysis, error, engine)` (service role only); `finance_classify_slip(...)` pure rules; `finance_request_analysis(evidence)` (staff re-run, max 5 attempts); trigger queues an attempt for each new evidence that has a file when `ai_review_enabled`.
* Reads (staff): `finance_review_list(filter, limit, offset)`, `finance_review_summary(from, to)`, `finance_review_detail(evidence)`; `finance_save_review_settings(patch)` (manager).
* `finance_invoice_state_raw` adds `confirmed_pending`, `more_evidence_message`, code `10` = more evidence requested; pending now counts `submitted` and `confirmed`. `shop_cancel_order_internal` also refuses while a slip is `confirmed`.

### AI result rules (`finance_classify_slip`, first match wins, all reasons recorded)
Expected amount = payment-request amount if any, else the invoice's posted outstanding. Window = [order created − `slip_window_before_min`, evidence created + `slip_future_tolerance_min`].
1. not a slip / unreadable / amount or date missing → `manual_review`
2. transaction reference already seen (other analysis, receipt, evidence, deposit) → `duplicate_suspected`
3. high tamper signal, QR reference ≠ printed reference, bad QR checksum, receiver clearly not ours, status not success → `suspicious_slip`
4. amount ≠ expected (exact to the satang; reasons AMOUNT_UNDER / AMOUNT_OVER) → `amount_mismatch`
5. date outside window → `date_mismatch`; time outside window or missing → `time_anomaly`
6. confidence < `ai_min_confidence` → `manual_review`
7. otherwise `match` (displayed as "AI check passed — not proof of payment").
Receiver match: visible account digits are an ordered subsequence (≥3) of an expected account number or PromptPay target, or the name prefix (titles stripped) matches the account name.

### AI reader (Edge Function `slip-analyze`)
`POST {evidence_id | invoice_id}` with the caller's JWT. Loads the file from the private bucket by the path stored in the database, decodes the slip QR in the function (JPG/PNG; PDF is not QR-checked), sends the image to **claude-haiku-5-5** with an extraction-only prompt and a JSON schema, **never** the expected values, no tools. The reply is schema-validated; dates are normalised on the server (Buddhist Era → CE, Thai month, two-digit years, Asia/Bangkok). Text inside the image is data. Failure or missing key never blocks anyone: the attempt is marked failed and the slip shows as manual review. The customer's browser triggers the function after submitting (best effort); staff can re-run from the dashboard.
Cost (list price in the Claude API docs, 2026-11): $0.10 / $0.50 per million input/output tokens → about 3k image tokens + 0.5k output ≈ $0.0006 ≈ ฿0.02 per slip (to be re-measured with real slips).

### Screens
* Staff: the "Slips to check" tab becomes the end-of-day dashboard (`src/finance/SlipReview.tsx`): KPI strip, filters (stage, AI result, date, discrepancy, source/method, search), suspicious section, table, detail with slip beside order and a comparison table (expected vs found, red where different, per-field confidence), history of analyses, actions. "Record payment" on the detail and on each invoice row. A manager-only settings card for the five settings.
* Customer: status copy; paid/remaining; "more evidence requested" banner with upload; rejection reason (exists). AI results never exposed.

### Statuses
Order status stays the existing enum; the label "Pending Payment Verification" is derived (status `new` and not fully paid). Per-payment stage is derived, not stored: Awaiting Payment Slip · Slip Submitted · AI Verification Completed · Manual Review Required · Payment Confirmed · Invoice Posted · Payment Rejected (+ More Evidence Requested). Fulfilment gating is unchanged (staff cannot advance past "confirmed" without full payment or a recorded override).

### Rollout and rollback
Ship dark (`ai_review_enabled=false`, `post_requires_manager=false`). Order: apply migration → deploy app → set secret + deploy function → turn on AI for a test → turn on `post_requires_manager`. Rollback file drops new objects and restores previous function bodies; it refuses once any `staff_entry`/confirmed evidence or analysis exists.

## Left to the builder
Exact SQL, UI layout details, Thai wording of the new strings, regression of the three existing SQL suites with the new migration, down-proof scripts modelled on the existing ones.

## Risks / external dependencies
Anthropic API key and billing (not yet created); slip images go to the model provider (PDPA notice, retention terms to confirm); Edge Function CPU limit for QR decoding (documents disagree: measure; fallback = decode skipped, reason `QR_NOT_CHECKED`); real slips from each bank are needed to tune the prompt.
