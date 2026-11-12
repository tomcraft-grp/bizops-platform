# Security Test Checklist

Addendum §6 (security, privacy, authorization), §9 (concurrency), §10 (auditability), §19. Status vocabulary: **Passed** (automated, last run green) · **Failed** · **Not run** · **Not applicable** (prototype has no such component) · **Blocked** (needs environment/credentials).

> **Boundary of this evidence.** The prototype has no server, no accounts and no network API. Authorization is enforced inside the browser-side engine. A user who can open the browser developer tools can alter local data directly. Every "Passed" below therefore proves the *rules* (what a backend must enforce) and the UI behaviour — **not** a security boundary. A penetration test and server-side enforcement are required before any real use.

## 1. Role and permission model
| # | Scenario | Evidence | Status |
|---|---|---|---|
| S-01 | Owner holds every permission; module wildcards cover only their module | `platform.test.ts` | Passed |
| S-02 | Role matrix: cashier cannot see cost/profit, accounting, cancel orders, edit team/settings; warehouse cannot approve accounting; marketing has no cost data; kitchen only kitchen display; manager cannot close periods or edit settings; accountant can close periods but cannot sell | `platform.test.ts` (25 role/permission cases) | Passed |
| S-03 | **Engine-level enforcement:** each of 70 guarded operations is denied to every role without the permission and never wrongly denied to roles that have it (all 10 seeded users × 70 operations) | `authz.test.ts` | Passed |
| S-04 | A denied call changes nothing (no journal, audit or order created) | `authz.test.ts` | Passed |
| S-05 | Unknown/deleted acting user is denied; only explicit seeding mode bypasses | `authz.test.ts` | Passed |
| S-06 | Separation of duties: preparer ≠ reviewer ≠ approver for manual journals, mapping changes, opening balances; a disabled user is not an authority | `accounting.test.ts`, `platform.test.ts`, E2E J12 | Passed |
| S-07 | UI: cashier sees only permitted modules; direct URL to a forbidden module is blocked; cost columns hidden | E2E J3 | Passed |
| S-08 | `act({perm})` refuses and rolls back (transaction layer) | `platform.test.ts` | Passed |
| S-09 | **Operations without an engine-level guard** (see BUG-002 residual list) | — | **Open risk** — High for production |
| S-10 | Server-side authorization, session/token handling, tenant isolation (row-level security), IDOR tests across customers | — | **Not applicable / Not run** (no backend) |

## 2. Customer data isolation
| # | Scenario | Evidence | Status |
|---|---|---|---|
| S-11 | Customer app shows only the signed-in customer's balance, orders, slips and points | E2E J14 | Passed (UI level) |
| S-12 | Cross-customer access through API/IDs | — | Not applicable (no API) |

## 3. Input, files and injection
| # | Scenario | Evidence | Status |
|---|---|---|---|
| S-13 | Uploaded file type is detected from content, not extension or declared MIME; disguised, infected-signature and duplicate files rejected | `platform.test.ts`, E2E J17 | Passed (simulated scanner; real antivirus **not run**) |
| S-14 | CSV import/export round-trips quotes, commas, newlines, Thai text; COA import is all-or-nothing | `platform.test.ts`, `accounting.test.ts` | Passed |
| S-15 | XSS: React escapes rendered text; no `dangerouslySetInnerHTML` of user data | Code inspection only | **Not run** as a dedicated automated test |
| S-16 | SQL injection / SSRF / path traversal / CSRF | — | Not applicable (no database, no server) |
| S-17 | Dependency vulnerability audit, secrets scan | — | **Not run** |

## 4. Financial and business-rule abuse
| # | Scenario | Evidence | Status |
|---|---|---|---|
| S-18 | Same idempotency key creates one order; double-click on *Complete sale* creates exactly one order | `engine.test.ts`, E2E J7 | Passed |
| S-19 | Payment slip duplicates blocked; approval creates exactly one receipt; reversal/void keeps the original and is audited | `engine.test.ts` | Passed |
| S-20 | Event number: 20 simultaneous claims → exactly one winner (unique index); two cashiers selling the last unit → one succeeds | `engine.test.ts` | Passed (single-process simulation; real DB concurrency **not run**) |
| S-21 | Period lock blocks posting; reopening requires a reason and is audited as critical | `accounting.test.ts` | Passed |
| S-22 | Atomicity: failing transaction rolls back completely (no order/stock/journal left) | `engine.test.ts`, `platform.test.ts` | Passed |
| S-23 | Points: redemption with insufficient balance rejected; redeem→cancel restores exactly once | `engine.test.ts` | Passed |

## 5. Audit trail (§10)
| # | Scenario | Evidence | Status |
|---|---|---|---|
| S-24 | Journal reversal, receipt void, order cancel, manual points, event reset, period reopen record actor, time and reason | `platform.test.ts` | Passed |
| S-25 | Mandatory reasons enforced; audit log bounded and never drops newest entry | `platform.test.ts` | Passed |
| S-26 | Tamper-evidence of the audit log (append-only storage, hash chain) | — | Not applicable (local storage) — requires backend |

## 6. Not covered at all
Authentication (MFA, lockout, password policy), session management, rate limiting, webhook signature verification, secret handling, encryption at rest/in transit, backup encryption, log redaction, privacy requests (export/erase), penetration test. Independent security testing before launch is an open decision (§21).
