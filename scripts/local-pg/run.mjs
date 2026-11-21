#!/usr/bin/env node
// Local replacement for scripts/run-sql-tests.sh: sends SQL files to a THROW-AWAY local PostgreSQL instead of the Supabase project.
//   node scripts/local-pg/run.mjs [options] <file.sql> [<file.sql> ...]
// The files are concatenated and sent as ONE query (one implicit transaction, exactly like run-sql-tests.sh). A test suite ends with
//   raise exception E'<MARKER> n of m passed ...';
// so the whole run rolls back and the exception message carries the result table, which is printed as run-sql-tests.sh prints it.
// Exit code: 0 when the result table has no FAIL row (and "n of m passed" has n = m), 1 on a failed test, an unexpected error, or a
// closing rollback that never happened, 2 on bad usage.
//   --rebuild        rebuild the cached template database (stubs + all migrations + seed) before running
//   --keep           do not drop the run database afterwards (its name and URL are printed)
//   --skip <text>    leave migrations whose file name contains <text> out of the template (repeatable; also LOCAL_PG_SKIP=a,b). Use it for a
//                    migration under development that you pass on the command line together with its test, like scripts/run-*-sql-tests.sh do
//   --marker <M>     expect the payload to end with raise exception E'<M>... (default: detected from the tail of the payload)
//   --notices        also print server NOTICE / WARNING messages
//   --query "<sql>"  run an ad-hoc statement (no marker needed) and print its rows as JSON; may be combined with files (run first)
//   --status         print the server state and the template name, then exit
//   --stop           stop the local server (data is kept), then exit
// Environment: LOCAL_PG_HOME (scratch install, default see harness.mjs), LOCAL_PG_PORT (default 54329).
import * as H from './harness.mjs';

const args = process.argv.slice(2);
const opts = { rebuild: false, keep: false, notices: false, marker: null, query: null };
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--rebuild') opts.rebuild = true;
  else if (a === '--keep') opts.keep = true;
  else if (a === '--notices') opts.notices = true;
  else if (a === '--marker') opts.marker = args[++i];
  else if (a === '--query') opts.query = args[++i];
  else if (a === '--skip') process.env.LOCAL_PG_SKIP = [process.env.LOCAL_PG_SKIP, args[++i]].filter(Boolean).join(',');
  else if (a === '--status') opts.status = true;
  else if (a === '--stop') opts.stop = true;
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
  else files.push(a);
}

try { H.pgModule(); } catch (e) { console.error(e.message); process.exit(2); }
if (opts.stop) { console.log(H.stopServer() || 'stopped'); process.exit(0); }
if (opts.status) {
  const up = await H.serverRunning();
  console.log(`server ${up ? 'RUNNING' : 'not running'} on ${H.HOST}:${H.PORT} (home ${H.HOME})`);
  if (up) console.log('databases:', await currentTemplate());
  process.exit(0);
}
async function currentTemplate() {
  const c = H.newClient(); await c.connect();
  try { return (await c.query("select string_agg(datname, ', ') t from pg_database where datname like 'tpl\\_%' or datname like 'run\\_%'")).rows[0].t || '(none yet)'; } finally { await c.end(); }
}
if (!files.length && opts.query == null && !opts.rebuild) {
  console.error('usage: node scripts/local-pg/run.mjs [--rebuild] [--keep] [--marker M] [--notices] [--query "sql"] <file.sql>...\n       node scripts/local-pg/run.mjs --status | --stop');
  process.exit(2);
}

let payload = '';
try { for (const f of files) payload += H.readSql(f) + '\n'; }
catch (e) { console.error('REFUSING TO RUN: ' + e.message); process.exit(2); }

// the same guard as run-sql-tests.sh: a suite must end with its closing rollback
let marker = opts.marker;
if (files.length) {
  const tail = payload.slice(-600);
  if (marker) { if (!tail.includes(`raise exception E'${marker}`)) { console.error(`REFUSING TO RUN: the payload does not end with the closing rollback (${marker})`); process.exit(2); } }
  else { const m = [...tail.matchAll(/raise exception E'([A-Za-z][A-Za-z0-9_]*)/g)].pop(); marker = m ? m[1] : null; }
}

const t0 = Date.now();
let runDb = null;
let code = 0;
try {
  if (!files.length && opts.query == null) { console.log(`template ${await H.ensureTemplate({ rebuild: opts.rebuild })} is ready`); process.exit(0); }
  const made = await H.newRunDb({ rebuild: opts.rebuild, keep: opts.keep });
  runDb = made.name;
  const c = H.newClient(runDb); await c.connect();
  if (opts.notices) c.on('notice', (n) => console.log(`${n.severity}: ${n.message}`));

  if (opts.query != null) {
    const res = await c.query(opts.query);
    for (const r of Array.isArray(res) ? res : [res]) console.log(JSON.stringify(r.rows ?? [], null, 1));
    if (!files.length) { await c.end(); throw Object.assign(new Error('done'), { quiet: true }); }
  }

  let err = null;
  try { await c.query(payload); } catch (e) { err = e; }
  try { await c.end(); } catch { /* ignore */ }

  if (!marker) {
    if (err) { console.log('ERROR\n' + H.describeError(err)); code = 1; }
    else console.log(`OK: ${files.length} file(s) applied without error (no closing rollback marker, so the run database was committed and is dropped now)`);
  } else if (!err) {
    console.log(`UNEXPECTED: the transaction COMMITTED, the closing rollback (${marker}) never ran`);
    code = 1;
  } else if (!err.message.startsWith(marker)) {
    console.log('UNEXPECTED ERROR (the suite did not reach its closing rollback)\n' + H.describeError(err));
    code = 1;
  } else {
    console.log(err.message);                                     // the result table, as run-sql-tests.sh prints it
    const fails = (err.message.match(/^FAIL\b/gm) || []).length;
    const sum = err.message.match(/(\d+) of (\d+) passed/);
    const short = sum && Number(sum[1]) !== Number(sum[2]);
    if (fails || short || !sum) { code = 1; console.error(`\n[local-pg] ${fails} failed test row(s)${sum ? ` (${sum[1]} of ${sum[2]} passed)` : ' and no "n of m passed" summary found'}`); }
    else console.error(`\n[local-pg] ${sum[1]} of ${sum[2]} passed`);
  }
} catch (e) {
  if (!e.quiet) { console.error('ERROR: ' + (e.message || e)); code = 1; }
} finally {
  if (runDb) {
    if (opts.keep) console.error(`[local-pg] kept run database ${runDb}: ${H.urlFor(runDb)}`);
    else { try { await H.dropRunDb(runDb); } catch (e) { console.error('[local-pg] could not drop ' + runDb + ': ' + e.message); } }
  }
  console.error(`[local-pg] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
process.exit(code);
