# Error alerts in Thai and English (FB-001004)

Every error staff see, as a toast or a red box in a page, has two lines: the language of the screen first, the other one under it. The English line is the system's own text, so it can be quoted to support.

| Where | What |
|---|---|
| `src/lib/errorMessages.app.ts` | messages raised by the app and the accounting engine |
| `src/lib/errorMessages.db.ts` | messages raised by the database, the meaning of each code (`SLIP_ALREADY_USED`, …), and Postgres / Supabase failures |
| `src/lib/errorText.ts` | finds the explanation, in both directions (a sentence the screen already put in Thai gets its English back) |
| `ErrText`, `Banner tone="bad"`, `Toasts` in `src/ui/kit.tsx` | show it |

**Adding a message.** A new `raise exception`, `fail(…)`, `new Error(…)` or `toast('error', tl(…))` needs a line in one of the two files. `tests/unit/bilingualErrors.test.ts` reads the source and the migrations and
fails, with the list, when one is missing. `{1}`, `{2}` are the values in a message; `{1:w}` is a single word (use it in short sentences, so they do not swallow a longer one).

**A reason nobody has translated** shows "ทำรายการไม่สำเร็จ ระบบแจ้งเหตุผลเป็นภาษาอังกฤษดังนี้" with the original text. Nothing is guessed and nothing is hidden.

**Time on screen.** An error toast stays 7 to 20 seconds depending on its length and can be closed with its X.

**Not changed.** The customer app keeps its own one-language sentences (`src/shop/i18n.ts`). Hints under form fields stay in the language of the screen. No database change.
