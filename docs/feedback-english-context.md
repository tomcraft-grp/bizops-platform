# Feedback: screenshots, English technical context and copy buttons (2026-11-15)

Migrations `20261115600000_feedback_english_context.sql` and `20261115610000_feedback_english_context_limits.sql` (both applied to production on 2026-11-15; rollbacks in `supabase/rollbacks/`). The browser code and the Edge Function are on branch `feat/feedback-english-context` and are **not committed, pushed or deployed yet**.

## What the user gets

1. **Screenshots without saving a file.** In the feedback form (staff button, customer app, and replies): press `Win+Shift+S`, select an area, press `Ctrl+V` in the form. Drag and drop and click-to-browse work too. Every picture gets a thumbnail with its own remove button, an "N attached" indicator, and a full-size preview. Up to 5 files; PNG, JPG, WebP (and PDF as before), 10 MB each. Pictures over 1.5 MB or 2560 px are shrunk in the browser before upload (so a 4K screenshot that is 15 MB as PNG still goes in).
2. **English technical context** next to the original text, generated after the issue is saved (never blocks submitting). Nine sections: Issue Title, Background, Problem Description, Expected Behavior, Actual Behavior, Impact, Technical Evidence, Implementation Requirements, Acceptance Criteria; `Not provided` where the report says nothing.
3. **Issue Detail (back office)**: A) *Original feedback* (exact text, original language, reporter, date), B) *English technical context* (status, text, Copy, Regenerate/Retry, Edit/Write by hand), C) *Evidence & attachments* (thumbnails, preview, download, upload date).
4. **Copy English Context** (the stored text, headings and bullets) and **Copy Context + Attachments** (the text plus a numbered list of the files with private links, and a sentence saying the images are *not* embedded and when the links stop working: 24 hours).

## Data model (nothing destructive)

| Column on `bizops_feedback_issues` | Meaning |
|---|---|
| `english_context text` | the English text (null until produced); `description` is never touched |
| `english_context_status` | `pending` (default) · `processing` · `completed` · `failed` |
| `english_context_error` | short code + message of the last failure (`AI_NOT_CONFIGURED`, `AI_HTTP_429`, `RATE_LIMITED` …), never a secret |
| `english_context_source` / `_model` / `_at` | `ai` or `manual`; model name; when it was produced |
| `english_context_attempts`, `english_context_started_at` | for the attempt limit and the 5-minute "a run that died" rule |

Attachments reuse what already existed: table `feedback_attachments` (file name, mime type, size, storage path, uploader via the issue/comment, `created_at`), private bucket `feedback-attachments` (10 MB, png/jpeg/webp/pdf), signed URLs. **No image is ever stored as Base64 in the database.** History kind `english_context` records who/what produced or changed a text (staff only).

## Who may do what

* **Read**: the reporter and staff, by the issue's row-level security (same as the description). The customer screens do not show the English text.
* **Generate**: Edge Function `feedback-english-context` verifies the caller's JWT, then calls `feedback_english_context_begin` (callable by `service_role` only). Only the reporter or staff; one run at a time; the reporter cannot regenerate a finished text (staff can). **Customers: at most 3 attempts per issue and 10 starts per hour** (cost control; staff are not limited).
* **Write by hand**: `feedback_set_english_context`, staff only.
* **Files**: unchanged storage policies: a user can upload into `<issue id>/…` only for an issue they reported (or staff), and read only those. A copied link is a bearer link for 24 hours: anyone who has the copied text can open those files until it expires.

## Turning the generation on (needs an administrator, not done yet)

No AI key or AI function exists in the project today, so generation ends as `failed: AI_NOT_CONFIGURED` / `AI_NOT_DEPLOYED` (the issue is saved normally; staff can Retry later or write the text by hand).

```bash
# 1. secrets (never in git, never in the browser)
supabase secrets set ANTHROPIC_API_KEY=...            --project-ref hlvravynjalculvplrxc
supabase secrets set AI_MODEL=claude-sonnet-5-5       --project-ref hlvravynjalculvplrxc   # optional, this is the default
#    any OpenAI-compatible service instead:
#    supabase secrets set AI_PROVIDER=openai AI_API_KEY=... AI_MODEL=... AI_BASE_URL=https://.../v1
# 2. deploy (verify_jwt stays ON)
supabase functions deploy feedback-english-context --project-ref hlvravynjalculvplrxc
# 3. deploy the web app (build + gh-pages, as for earlier releases)
```

What is sent to the AI service: the issue text, title, category, priority, page/module/app/version/browser/OS details and the **attachment file names, types and sizes**. **Images are not sent**, and the English text says screenshots were not analysed. The report is passed as quoted data, so instructions written inside a report are not followed. The answer is validated (nine headings in order, English, ≤ 20,000 characters); a wrong shape is retried once, then recorded as `failed`.

## Validation queries (read-only)

```sql
-- columns and defaults
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_schema = 'public' and table_name = 'bizops_feedback_issues' and column_name like 'english_context%' order by ordinal_position;
-- existing issues untouched (md5 of the description was recorded before the migration)
select id, md5(description), english_context is null as no_ctx, english_context_status from bizops_feedback_issues order by id;
-- who can call what (begin/finish: service_role only; set: authenticated)
select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') service
  from pg_proc p where p.proname like 'feedback_%english_context%' or p.proname = 'feedback_set_english_context';
-- monitoring
select english_context_status, count(*) from bizops_feedback_issues group by 1;
select id, english_context_error from bizops_feedback_issues where english_context_status = 'failed';
```

## Rollback

`scripts/run-feedback-down-proof.sh` and `scripts/run-feedback-limits-down-proof.sh` proved, before each migration was applied, that its rollback restores functions, tables, columns, constraints, triggers, policies and every existing issue exactly (they refuse to run once the migration is applied). Order: first `20261115610000_…_limits_down.sql`, then `20261115600000_…_down.sql`. The second **refuses** while any English context, failed attempt or history entry exists (those are records): export them first. Nothing in the original feedback, comments or attachments is affected either way.

## Tests

| Layer | Where | What |
|---|---|---|
| SQL against the real data (rolled back) | `scripts/run-feedback-sql-tests.sh` → `supabase/tests/feedback_english_context.sql` (50 checks); `feedback_permissions.sql` as regression | the five real issues unchanged; customers/anon cannot call or write; claim/finish/retry/stale rules; attempt and hourly limits; RLS; storage policies |
| Edge Function logic | `tests/unit/feedbackContext.test.ts` | prompt, injection, providers, timeouts, secret scrubbing, validation, handler (fake AI) |
| Browser helpers | `tests/unit/feedbackImages.test.ts`, `feedbackEnglishUi.test.ts` | clipboard images, resize math, copy text, states, Thai coverage |
| Real Chrome | `tests/shop-e2e/feedback.spec.ts` (26 tests, fake backend) | real Ctrl+V, drop, browse, remove, big-image compression, Thai/English submit, reopen with attachments, preview/download, generate/retry/failed/not installed, manual text, copy and paste back, axe, phone layout |

`npx playwright test -c playwright.shop.config.ts tests/shop-e2e/feedback.spec.ts` and `npx vitest run`.

## Limitations

* The AI function has **never run against a real model** (no key). Its logic is tested with a fake provider; the quality of real answers is untested.
* Browser tests use a fake backend that mirrors the SQL contract; the database rules themselves are proven by the SQL suite, not by the browser.
* The customer-app form shares the same picker component but is not driven in a browser test (it needs a LINE-linked login).
* Concurrency of two simultaneous generations relies on the row lock in `feedback_english_context_begin` (`for update`); it is covered by a sequential test, not a two-connection test.
* Rolled-back test runs advance `feedback_issue_seq`, so the next real issue number skips some values (cosmetic).
* Old issues are not back-filled: they show "Not generated yet" and staff can press Generate (one AI call each) when the function is live.
