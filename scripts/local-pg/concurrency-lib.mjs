// Helpers for REAL concurrency tests on the local PostgreSQL (scripts/local-pg). Local only, never the Supabase project.
// Every test gets its own fresh database cloned from the template (stubs + all migrations + seed), with N independent connections (= N backend
// processes), so the locks, unique indexes and isolation of real PostgreSQL are exercised for real.
//
//   import { withRunDb, ok, check, asUser } from './concurrency-lib.mjs';          // from a script next to this file
//   await withRunDb({ files: ['supabase/tests/fixtures/x.sql'] }, async (db) => {
//     await db.query('create table t (k int primary key)');
//     const r = await db.parallel(Array.from({ length: 10 }, () => 'insert into t values (1)'));
//     check('exactly one insert wins', r.filter(ok).length === 1, r.length + ' results');
//   });                                                                           // prints the summary, sets the exit code, drops the database
import * as H from './harness.mjs';

let failed = 0;
let total = 0;

/** wallet-concurrency-test.mjs style printer: `PASS  name` / `FAIL  name  => detail`. */
export function check(name, cond, detail = '') {
  total++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  => ' + detail}`);
  if (!cond) failed++;
}
export const ok = (r) => r.status === 'fulfilled';
/** The message of a rejected result ('' for a fulfilled one). */
export const msg = (r) => (r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : '');
/** The SQLSTATE of a rejected result (e.g. '23505' unique violation, '40001' serialization failure, '40P01' deadlock). */
export const sqlstate = (r) => (r.status === 'rejected' ? r.reason?.code : undefined);
export const failures = () => failed;

/** SQL that makes a session act as a signed-in shop member / staff (what PostgREST does): claims + `set role authenticated`. */
export function asUser(uid, role = 'authenticated') {
  const claims = JSON.stringify({ sub: uid, role }).replace(/'/g, "''");
  return `select set_config('request.jwt.claims', '${claims}', false); set role ${role};`;
}

const lastRows = (res) => (Array.isArray(res) ? res[res.length - 1] : res);

/**
 * Creates a fresh run database from the template (building the template first when needed) and returns a handle:
 *   db.name / db.url          the database of this run
 *   db.query(sql, params?)    rows of the last statement, on one shared admin session (autocommit, superuser)
 *   db.apply(...files)        run SQL files, each as its own committed query (fixtures, a migration under development)
 *   db.connect(n, {as})       n NEW independent sessions (optionally acting as a user, see asUser); closed by db.close()
 *   db.parallel(sqls, {as, gate})   one statement per connection, all started together, resolved like Promise.allSettled:
 *                             {status:'fulfilled', value: rows, ms} | {status:'rejected', reason: Error, ms}.
 *                             Each string is sent as one query (several statements in it = one implicit transaction).
 *                             gate (default true): every session first blocks on a shared advisory lock that the coordinator releases
 *                             once ALL are waiting, so the work really starts at the same instant inside the server.
 *   db.close()                closes every session and drops the database (keep: true leaves it)
 */
export async function openRunDb({ files = [], rebuild = false, keep = false, skip = [] } = {}) {
  // skip: migration file-name fragments left out of the template (a migration under development that `files` applies instead)
  if (skip.length) process.env.LOCAL_PG_SKIP = [process.env.LOCAL_PG_SKIP, ...skip].filter(Boolean).join(',');
  const { template, name } = await H.newRunDb({ rebuild, keep, verbose: false });
  const sessions = [];
  const open = async (as) => {
    const c = H.newClient(name); await c.connect(); sessions.push(c);
    if (as) await c.query(as.startsWith('select set_config') ? as : asUser(as));
    return c;
  };
  const admin = await open();
  const db = {
    name, url: H.urlFor(name), template,
    async query(sql, params) { const r = await admin.query(sql, params); return (Array.isArray(r) ? lastRows(r) : r).rows; },
    async apply(...fs) { for (const f of fs) { try { await admin.query(H.readSql(f)); } catch (e) { throw new Error(`${f}: ${H.describeError(e)}`); } } },
    async connect(n, { as } = {}) { return Promise.all(Array.from({ length: n }, () => open(as))); },
    async parallel(sqls, { as, gate = true } = {}) {
      const clients = await db.connect(sqls.length, { as });
      const key = 1000 + Math.floor(Math.random() * 1e6);
      const useGate = gate && sqls.length > 1;
      if (useGate) await admin.query('select pg_advisory_lock($1)', [key]);          // exclusive: the gate is shut
      const t0 = Date.now();
      const runs = clients.map((c, i) => {
        const text = useGate ? `select pg_advisory_lock_shared(${key}); ${sqls[i]}` : sqls[i];
        return c.query(text).then((r) => ({ status: 'fulfilled', value: lastRows(r).rows, ms: Date.now() - t0 }),
                                  (e) => ({ status: 'rejected', reason: e, ms: Date.now() - t0 }));
      });
      if (useGate) {
        for (let i = 0; i < 400; i++) {                                              // wait until every session is parked on the gate
          const w = await admin.query('select count(*)::int n from pg_locks where locktype = $1 and classid = 0 and objid = $2 and not granted', ['advisory', key]);
          if (w.rows[0].n >= sqls.length) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        await admin.query('select pg_advisory_unlock($1)', [key]);                    // open the gate: all start together
      }
      return Promise.all(runs);
    },
    async close() {
      for (const c of sessions) { try { await c.end(); } catch { /* ignore */ } }
      if (!keep) { try { await H.dropRunDb(name); } catch (e) { console.error('[local-pg] could not drop ' + name + ': ' + e.message); } }
    },
  };
  for (const f of files) await db.apply(f);
  return db;
}

/** Opens a run database, runs the test body, always cleans up, prints the summary and sets process.exitCode (1 on any FAIL or error). */
export async function withRunDb(opts, body) {
  if (typeof opts === 'function') { body = opts; opts = {}; }
  let db;
  try {
    db = await openRunDb(opts);
    await body(db);
  } catch (e) {
    failed++; total++;
    console.error('ERROR', e.stack || e.message);
  } finally {
    if (db) await db.close();
  }
  console.log(`\n${total - failed} of ${total} concurrency checks passed${failed ? '  (' + failed + ' FAILED)' : ''}`);
  process.exitCode = failed ? 1 : 0;
}
