# Local PostgreSQL harness

A real PostgreSQL 17 on your machine (no Docker, nothing from the Supabase project) to verify SQL migrations and their test suites,
including true multi-connection concurrency tests. **It never connects to production**: it does not read `~/.supabase-token` and
does not call `api.supabase.com`.

| File | Purpose |
|---|---|
| `run.mjs` | `node scripts/local-pg/run.mjs <file.sql>...` – local twin of `scripts/run-sql-tests.sh` |
| `concurrency-lib.mjs` | `withRunDb`, `db.parallel`, `check`, `ok` for tests with N real connections |
| `concurrency-demo.mjs` | small proof (unique-index race, real `sku_issue()` under 10 parallel callers) |
| `harness.mjs` | shared plumbing (server, template database, run databases) |
| `stubs.sql` | the Supabase parts a plain PostgreSQL lacks: roles, `auth.users` + `auth.uid()/role()/jwt()/email()`, `storage.*`, extensions, default grants |
| `seed.sql` | invented, production-shaped data the existing suites expect (see its header) |

## 1. Install (once, OUTSIDE the repo)

The Postgres binaries (about 105 MB on disk, 70 MB for the cluster) live in a scratch folder, never in the repo's `package.json` / `node_modules`.

```bash
export LOCAL_PG_HOME="/path/to/scratch/pg"          # default: see harness.mjs (the session scratchpad)
mkdir -p "$LOCAL_PG_HOME" && cd "$LOCAL_PG_HOME"
echo '{"name":"local-pg-scratch","private":true,"type":"module"}' > package.json
npm install --cache "$LOCAL_PG_HOME/npm-cache" --no-audit --no-fund embedded-postgres@17.12.0-beta.19 pg
rm -rf "$LOCAL_PG_HOME/npm-cache"                   # the cache is about 45 MB; it is not needed afterwards
```

Windows PowerShell: `$env:LOCAL_PG_HOME = 'C:\scratch\pg'`. Optional: `LOCAL_PG_PORT` (default 54329). The server listens on 127.0.0.1 only, user `postgres`, trust auth, so no password exists.

## 2. Use

```bash
# the existing suites (same marker / closing rollback as the production runners; run from the repo root)
node scripts/local-pg/run.mjs supabase/tests/shop_no_brand.sql
node scripts/local-pg/run.mjs supabase/tests/customer_shop.sql
node scripts/local-pg/run.mjs supabase/tests/online_ordering.sql
node scripts/local-pg/run.mjs supabase/tests/wallet_payments.sql
node scripts/local-pg/run.mjs supabase/migrations/20261120100000_slip_review.sql supabase/tests/slip_review.sql

# a migration under development: leave it out of the template, send it with its test (what scripts/run-*-sql-tests.sh do)
node scripts/local-pg/run.mjs --skip rewards_core supabase/migrations/20261121100000_rewards_core.sql supabase/tests/rewards_core.sql

node scripts/local-pg/run.mjs --rebuild              # force a new template (also done automatically, see below)
node scripts/local-pg/run.mjs --keep <files>         # keep the run database (keep_*) and print its URL to poke around with any client
node scripts/local-pg/run.mjs --query "select count(*) from sku_registry"   # ad-hoc statement on a fresh clone
node scripts/local-pg/run.mjs --status               # server up? which databases exist
node scripts/local-pg/run.mjs --stop                 # stop the server (data kept; the next run starts it again)
node scripts/local-pg/concurrency-demo.mjs           # concurrency demo
```

What a run does: ensures the server is running (starts it, `initdb` the first time), ensures the **template database** exists, clones it into a
fresh `run_*` database (about 1 s), sends the files concatenated as ONE query (one implicit transaction, like `run-sql-tests.sh`), prints the
exception message that carries the result table, drops the database.

* The template = `stubs.sql` + **every** `supabase/migrations/*.sql` in file-name order + `seed.sql`. It is cached under the name `tpl_<hash>`; the
  hash covers the contents of all those files, so it is rebuilt automatically (5-10 s) whenever a migration, the stubs or the seed change. The 4 newest
  templates are kept, older ones are dropped.
* The suite must end with `raise exception E'<MARKER> n of m passed ...'`. Exit code 0 only when no row starts with `FAIL`, `n = m`, and the
  suite reached its closing rollback. Exit 1 for a failed row, an unexpected error (printed with DETAIL / WHERE / POSITION), or a payload that
  committed instead of rolling back. Exit 2 for bad usage (missing file, wrong marker, harness not installed).
* Several people / agents may run at the same time: every run has its own database, the template build is serialised by a lock, abandoned `run_*`
  databases (older than 15 minutes, nobody connected) are swept at the next template build.
* Re-sending an already applied migration (as the older `run-shop-sql-tests.sh` / `run-ordering-...` / `run-wallet-...` scripts do) fails for
  `20261115500000_document_numbering.sql` (its function swap expects the pre-numbering source). That is true on production too; run those three suites
  with the test file alone, the migrations are already in the template.

### Concurrency tests

```js
import { withRunDb, ok, check, asUser } from './concurrency-lib.mjs';             // a script next to the lib
await withRunDb({ skip: ['rewards_core'], files: ['supabase/migrations/20261121100000_rewards_core.sql'] }, async (db) => {
  const r = await db.parallel(Array.from({ length: 20 }, () => `select public.some_rpc(...)`), { as: someProfileUuid });
  check('exactly one of 20 succeeds', r.filter(ok).length === 1, r.map((x) => x.reason?.message).join(' | '));
});
```

`db.parallel(sqls, { as, gate })` opens one **new connection per statement**, optionally acting as a signed-in user (`as` = profile uuid, claims
+ `set role authenticated`), parks them on an advisory-lock gate until all are connected and waiting, then opens the gate so that all statements
start at the same instant inside the server. Results are `Promise.allSettled`-shaped (`status`, `value` rows / `reason` error, `ms`); use `sqlstate(r)`
and `msg(r)` to classify failures. `db.query` / `db.apply(file)` use a separate admin session. Anything committed by the test lives only in that
run's database, which is dropped at the end. `check(name, cond, detail)` prints `PASS  name` / `FAIL  name  => detail` like
`scripts/wallet-concurrency-test.mjs`; the process exit code is 1 when any check failed.

## 3. Limits (read before trusting a green run)

* **Seed data is invented.** The suites were written against production's real data; here they find 145 fake SKUs, 6 fake people, no orders, no wallets.
  Checks that production fails because of real orders / wallets / ledger rows (documented in `docs/slip-review.md`: ordering 98 of 99, wallet 153 of
  162, shop 176 of 180) pass here, so a green local run is *not* a statement about production data. Conversely the real catalogue size, brands and
  prices are not reproduced beyond what the checks assert.
* **No PromptPay account is seeded on purpose** (two suites assert that none exists); the bank accounts SCB / BBL come from the wallet migration.
* `finance_staff_roles` is empty on purpose: the suites grant C / D their roles themselves.
* **Not Supabase.** Plain PostgreSQL 17.12 (production version may differ), superuser `postgres` instead of Supabase's restricted `postgres`, C locale
  / UTF-8 (collation-dependent ordering can differ from production's), `fsync = off`. Stubs reproduce `auth.uid()`, roles and default grants, but not
  PostgREST (JWT verification, the `authenticator` role switch, request limits), GoTrue, Storage's API, Realtime, Edge Functions, pg_cron, pg_net,
  Vault, the real `supabase_admin` event triggers. Extensions available: pgcrypto, uuid-ossp, pg_trgm (+ whatever ships with the binary).
* Row-level security IS enforced (the suites switch to `anon` / `authenticated` with `set local role`), but only as far as the claims you set.
* `now()` is the real clock; the data has no time travel.
* A suite that commits (no closing rollback) only changes its own throw-away database.

## 4. Stop / clean up

```bash
node scripts/local-pg/run.mjs --stop                 # stops the server; `--status` shows whether it is up
rm -rf "$LOCAL_PG_HOME"                              # removes everything (server, data, binaries) when you are done for good
```
