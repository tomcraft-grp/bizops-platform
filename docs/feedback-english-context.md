# Feedback: screenshots, English version and copy buttons (2026-11-15)

Migrations `20261115600000_feedback_english_context.sql` and `20261115610000_feedback_english_context_limits.sql` are applied to production; `20261115620000_feedback_translation_source.sql` adds the source `translation` (rollbacks in `supabase/rollbacks/`).

**Decision (2026-11-15): no AI service and no API key.** The English version is a plain translation made on the staff member's own computer with Chrome's built-in translator. It costs nothing, needs no account, and the report text is not sent to any server. The earlier design (an Edge Function that asks an AI service for a nine-section brief) is written and tested but **dormant**: nothing in the app calls it and it is not deployed (see the last section).

## What the user gets

1. **Screenshots without saving a file.** In the feedback form (staff button, customer app, and replies): press `Win+Shift+S`, select an area, press `Ctrl+V` in the form. Drag and drop and click-to-browse work too. Every picture gets a thumbnail with its own remove button, an "N attached" indicator, and a full-size preview. Up to 5 files; PNG, JPG, WebP (and PDF as before), 10 MB each. Pictures over 1.5 MB or 2560 px are shrunk in the browser before upload.
2. **English version** next to the original text, saved in the `english_context` column: `Title: <English title>`, a blank line, then the English description. Identifiers (SKU/order codes such as `FG-000001`), URLs, routes (`/orders`), code in backticks and quoted messages (`"permission denied"`) are kept word for word; the translation of a line is checked for them and, if one was damaged, only the Thai runs between them are translated.
   * When the Thai language pack is **already on the computer**, it happens by itself: right after a staff member submits feedback, and when staff open an untranslated issue (once per issue).
   * The **first time** Chrome must download the Thai language pack, which it only allows right after a click: the issue screen shows **Translate to English** with a progress percentage. After that it is automatic.
   * Browsers without the translator (not Chrome, or older than 138, or a phone) see a clear message, an **Open in Google Translate** link (opens only when clicked) and **Write by hand**.
3. **Issue Detail (back office)**: A) *Original feedback* (exact text, original language, reporter, date), B) *English version* (status, text, Translate/Translate again, Copy, Edit/Write by hand), C) *Evidence & attachments* (thumbnails, preview, download, upload date).
4. **Copy English Context** (the stored text) and **Copy Context + Attachments** (the text plus a numbered list of the files with private links, and a sentence saying the images are *not* embedded and when the links stop working: 24 hours).

## Data model (nothing destructive)

| Column on `bizops_feedback_issues` | Meaning |
|---|---|
| `english_context text` | the English text (null until produced); `description` is never touched |
| `english_context_source` | `translation` (made in the browser), `manual` (typed by staff) or `ai` (only if the dormant AI path is ever switched on) |
| `english_context_status` / `_at` | `pending` (default) / `completed`; when it was saved |
| `english_context_error`, `_model`, `_attempts`, `_started_at` | used only by the dormant AI path |

`feedback_set_english_context(issue, text, source = 'manual')` (staff only) saves it and records a staff-only history entry: "Translated on the staff computer" or "Written by hand". Attachments reuse the existing table `feedback_attachments` and private bucket `feedback-attachments` (signed links); **no image is ever stored as Base64 in the database**.

## Who may do what

* **Read**: the reporter and staff, by the issue's row-level security (same as the description). The customer screens do not show the English version.
* **Save the English version**: staff only (customers and anonymous visitors are refused by the database). The translation runs in the staff member's browser; the browser sends only the finished text to the database.
* **Files**: unchanged storage policies. A copied link is a bearer link for 24 hours: anyone who has the copied text can open those files until it expires.

## Limitations

* **Translation quality is unverified.** Chrome's real Thai→English model could not be downloaded in the test browser, so the tests use a fake translator: they prove the logic around it (protecting identifiers, line handling, saving, progress, failures), not how good the English is. Try it on a few real reports.
* Only **Thai → English** is handled; text in other scripts is passed through unchanged. Lines that are already English are left exactly as they are.
* Customers' own devices (LINE in-app browser) do not translate; their issues are translated when staff open them (or by the staff member's click).
* Browser tests use a fake backend that mirrors the SQL contract; the database rules are proven by the SQL suite, not by the browser. The customer-app form shares the same picker but is not driven in a browser test (it needs a LINE-linked login).
* Rolled-back test runs advance `feedback_issue_seq`, so the next real issue number skips some values (cosmetic).

## Validation queries (read-only)

```sql
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_schema = 'public' and table_name = 'bizops_feedback_issues' and column_name like 'english_context%' order by ordinal_position;
-- existing issues untouched
select id, md5(description), english_context is null as no_ctx, english_context_status, english_context_source from bizops_feedback_issues order by id;
-- who can call what (set: signed-in users, refused inside for non-staff; begin/finish: service_role only)
select p.proname, pg_get_function_identity_arguments(p.oid) args, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') service
  from pg_proc p where p.proname like 'feedback_%english_context%' or p.proname = 'feedback_set_english_context';
-- monitoring
select english_context_source, count(*) from bizops_feedback_issues group by 1;
select issue_id, note, created_at from feedback_events where kind = 'english_context' order by id desc limit 20;
```

## Rollback

Each migration has a proof that its rollback restores functions, tables, columns, constraints, triggers, policies and every existing issue exactly (they refuse to run once the migration is applied): `scripts/run-feedback-down-proof.sh`, `run-feedback-limits-down-proof.sh`, `run-feedback-translation-down-proof.sh`. Order: `…620000…_down.sql`, then `…610000…_down.sql`, then `…600000…_down.sql`. The first and last **refuse** while a translation, an English text, a failed attempt or a history entry exists (those are records): export them first. Nothing in the original feedback, comments or attachments is affected either way.

## Tests

| Layer | Where | What |
|---|---|---|
| SQL against the real data (rolled back) | `scripts/run-feedback-sql-tests.sh` → `supabase/tests/feedback_english_context.sql` (63 checks); `feedback_permissions.sql` as regression | the original issues unchanged; customers/anon cannot save; staff save a translation or a hand-written text with the right source and history; limits; RLS; storage policies |
| Translation logic | `tests/unit/feedbackTranslate.test.ts` | identifier protection, a translator that damages them, line breaks, empty/failed translator, browser glue, Google link |
| Browser helpers | `tests/unit/feedbackImages.test.ts`, `feedbackEnglishUi.test.ts` | clipboard images, resize math, copy text, Thai coverage |
| Real Chrome | `tests/shop-e2e/feedback.spec.ts` (29 tests, fake backend + fake translator) | real Ctrl+V, drop, browse, remove, big-image compression, Thai/English submit with automatic translation, pack to download with progress, failures without retry loops, no translator, hand-written text, confirm before overwriting, copy and paste back, axe, phone layout |

## The dormant AI path (optional, not used)

`supabase/functions/feedback-english-context/` (Edge Function), its SQL functions `feedback_english_context_begin/finish` and `tests/unit/feedbackContext.test.ts` remain in the repository. Nothing in the app calls the function and it is not deployed. To switch it on someone would have to create an Anthropic (or OpenAI-compatible) API key, set it as a Supabase secret, deploy the function and add a button that calls `requestEnglishContext` (`src/lib/feedbackApi.ts`); that call is pay-as-you-go (roughly 1 US cent per report on Sonnet 5.5, an estimate). Customers would be limited to 3 attempts per issue and 10 per hour by `20261115610000`. It has never run against a real model.
