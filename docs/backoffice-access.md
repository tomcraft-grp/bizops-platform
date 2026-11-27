# Giving a LINE member back-office access

**Status: built and tested, NOT applied or published** (2026-11-28). Migration `supabase/migrations/20261128110000_backoffice_access.sql`, rollback `supabase/rollbacks/20261128110000_backoffice_access_down.sql`, code `src/pages/LineMembers.tsx` and `src/lib/lineMemberAccess.ts`.

## Why

Opening the shop's address inside the LINE app signs the person in as their **customer** account (role `USER`), and the back office (`#/`) is for `ADMIN` / `SUPER_ADMIN` only, so a staff member who opens it in LINE lands on the customer page. A **SUPER_ADMIN** can now give that person's LINE account the `ADMIN` role, after which the same link opens the back office for them in LINE.

(The *Team & access* page is a local simulation kept in the browser; it never changed a real role. The only real role is `profiles.role`, changed here.)

## What it does

*Back office → LINE members* (`#/members`) lists every LINE account with its access (customer / back office (ADMIN) / owner (SUPER_ADMIN)). A SUPER_ADMIN sees, per row:

* **ให้สิทธิ์หลังบ้าน** (give access) on an active customer: a confirmation says what it means (manager level, whole set; the person's orders and points stay), an optional reason, then the database function `line_member_set_access(profile, true, reason)`;
* **ถอนสิทธิ์หลังบ้าน** (take back) on an ADMIN: the person is a customer again at once.

Everyone else (an ADMIN, a customer) sees the table without buttons.

## Rules (all in the database; the screen only mirrors them)

* Only a **SUPER_ADMIN** may call it.
* Only between `USER` and `ADMIN`: never a SUPER_ADMIN, never yourself, never an account without a LINE id, never a disabled member (a disabled ADMIN can still be taken back).
* Every real change writes `auth_audit_logs` (`action = 'role_change'`, who, whom, from, to, reason, `via = 'line_members'`); asking for the role the person already has changes nothing and writes nothing.
* The role is read by the database on every call, so **taking access back works at once**. After being given access, the person closes and re-opens the app (the screen reads the role when it opens).
* `ADMIN` is the manager level with the whole set of back-office menus; there is no per-menu choice. Finance roles (verifier, manager) are separate and are not given by this.

## Rollback

Drop the function (`supabase/rollbacks/20261128110000_backoffice_access_down.sql`), then delete version `20261128110000` from `supabase_migrations.schema_migrations`. Roles already given and the audit rows stay (they are data); a SUPER_ADMIN can still change a role by hand as before.

## How it is tested (real results, 2026-11-28)

* `bash scripts/run-backoffice-access-sql-tests.sh`: the migration and **36 checks against the live project's real data, rolled back**: who may call it, give / take back, the audit rows, that the new ADMIN reaches the staff functions at once and loses them at once, every refusal, that nothing else changed.
* `bash scripts/run-backoffice-access-down-proof.sh` (+ `control`): the rollback restores all public functions, tables, columns, constraints, indexes, triggers and policies exactly.
* Unit tests (`tests/unit/lineMemberAccess.test.ts`) and browser tests (`tests/shop-e2e/line-members.spec.ts`, 10 tests: give, take back, cancel, optional reason, no button for a disabled member / yourself / another owner / an ADMIN, a refusal in words, a database without the migration, accessibility, phone width). The browser tests use a fake backend: they prove the screen, not the database.
* **Not tested:** the screen against the real database (the migration is not applied), and a real LINE sign-in of a promoted member.
