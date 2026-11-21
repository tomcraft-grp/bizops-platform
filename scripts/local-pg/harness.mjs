// Shared plumbing of the local PostgreSQL harness (see README.md). Local only: it never talks to the Supabase project.
//   * finds the scratch install (LOCAL_PG_HOME: embedded-postgres + pg installed by `npm install` outside the repo)
//   * initialises / starts a real PostgreSQL server there (data dir LOCAL_PG_HOME/data, 127.0.0.1:LOCAL_PG_PORT, trust auth)
//   * builds (once, cached by a content hash) a TEMPLATE database = stubs.sql + every supabase/migrations/*.sql + seed.sql
//   * creates a fresh database from that template for every run and drops it afterwards
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOME = path.resolve(process.env.LOCAL_PG_HOME || 'C:\\Users\\NB-184\\AppData\\Local\\Temp\\claude\\da199795aca9990c\\b91f4d3b-273b-432e-8248-ad06726d1edb\\scratchpad\\pg');
export const PORT = Number(process.env.LOCAL_PG_PORT || 54329);
export const HOST = '127.0.0.1';
export const DATA = path.join(HOME, 'data');
const HARNESS_VERSION = '1';      // bump when the way the template is built changes

// ------------------------------------------------------------------------------------------------------------- pg driver
let _pg;
export function pgModule() {
  if (_pg) return _pg;
  if (!existsSync(path.join(HOME, 'node_modules', 'pg'))) {
    throw new Error(`The pg driver / embedded-postgres are not installed in LOCAL_PG_HOME=${HOME}\n` +
      `Install them OUTSIDE the repo:  mkdir -p "${HOME}" && cd "${HOME}" && npm init -y && npm install embedded-postgres@17.12.0-beta.19 pg`);
  }
  _pg = createRequire(path.join(HOME, 'package.json'))('pg');
  return _pg;
}
export const log = (...a) => console.error('[local-pg]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newClient(database = 'postgres', extra = {}) {
  const { Client } = pgModule();
  const c = new Client({ host: HOST, port: PORT, user: 'postgres', database, application_name: 'local-pg', ...extra });
  c.on('error', () => { /* a dropped connection is reported by the query that was running */ });
  return c;
}
export const urlFor = (database) => `postgresql://postgres@${HOST}:${PORT}/${database}`;

// ------------------------------------------------------------------------------------------------------------- binaries
function binDir() {
  const base = path.join(HOME, 'node_modules', '@embedded-postgres');
  const want = `${os.platform() === 'win32' ? 'windows' : os.platform()}-${os.arch()}`;
  const dirs = existsSync(base) ? readdirSync(base) : [];
  const d = dirs.find((x) => x === want) ?? dirs[0];
  if (!d) throw new Error(`no @embedded-postgres/* binary package in ${base}`);
  return path.join(base, d, 'native', 'bin');
}
const exe = (n) => path.join(binDir(), n + (os.platform() === 'win32' ? '.exe' : ''));

// ------------------------------------------------------------------------------------------------------------- server
async function canConnect() {
  const c = newClient('postgres', { connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.query('select 1'); return true; } catch { return false; } finally { try { await c.end(); } catch { /* ignore */ } }
}
async function withDirLock(name, fn, waitMs = 120000) {
  const dir = path.join(HOME, name);
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(dir).mtimeMs > 300000) { rmSync(dir, { recursive: true, force: true }); continue; } } catch { /* raced */ }
      if (Date.now() - t0 > waitMs) throw new Error(`timeout waiting for ${dir}`);
      await sleep(300);
    }
  }
  try { return await fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function serverRunning() { return canConnect(); }

export async function ensureServer() {
  if (await canConnect()) return false;
  return withDirLock('boot.lock', async () => {
    if (await canConnect()) return false;
    if (!existsSync(path.join(DATA, 'PG_VERSION'))) {
      log('initialising a new cluster in', DATA);
      const pw = path.join(HOME, '.pgpw'); writeFileSync(pw, 'postgres');
      const r = spawnSync(exe('initdb'), ['-D', DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-instructions'], { encoding: 'utf8' });
      rmSync(pw, { force: true });
      if (r.status !== 0) throw new Error('initdb failed:\n' + (r.stdout || '') + (r.stderr || ''));
      // a throw-away server: speed and a small footprint matter, durability does not
      appendFileSync(path.join(DATA, 'postgresql.conf'), [
        '', '# --- local-pg harness ---',
        `listen_addresses = '${HOST}'`, 'max_connections = 100', 'shared_buffers = 64MB',
        'fsync = off', 'synchronous_commit = off', 'full_page_writes = off',
        'min_wal_size = 32MB', 'max_wal_size = 128MB', 'log_min_messages = warning', "timezone = 'UTC'", ''].join('\n'));
    }
    log(`starting PostgreSQL on ${HOST}:${PORT}`);
    // detached + ignored stdio: with pipes the child server would keep them open and this process (and its caller) would wait for it forever
    const child = spawn(exe('pg_ctl'), ['start', '-D', DATA, '-l', path.join(HOME, 'server.log'), '-o', `-p ${PORT}`], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 120; i++) { if (await canConnect()) return true; await sleep(500); }
    throw new Error('could not start PostgreSQL, see ' + path.join(HOME, 'server.log'));
  });
}

export function stopServer() {
  if (!existsSync(path.join(DATA, 'PG_VERSION'))) return 'no cluster';
  const r = spawnSync(exe('pg_ctl'), ['stop', '-D', DATA, '-m', 'fast', '-w', '-t', '60'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '') + (r.stderr || '');
}

// ------------------------------------------------------------------------------------------------------------- template
/** Substrings (LOCAL_PG_SKIP, comma separated; run.mjs --skip) of migration file names left OUT of the template, e.g. a migration under
 *  development that is sent together with its test on the command line, exactly as the production runners do. */
export const skipList = () => (process.env.LOCAL_PG_SKIP || '').split(',').map((x) => x.trim()).filter(Boolean);
export function migrationFiles() {
  const dir = path.join(REPO, 'supabase', 'migrations');
  const skip = skipList();
  return readdirSync(dir).filter((f) => f.endsWith('.sql') && !skip.some((x) => f.includes(x))).sort().map((f) => path.join(dir, f));
}
function templateHash(extraFiles = []) {
  const h = createHash('sha256');
  h.update('v' + HARNESS_VERSION + '\n');
  for (const f of [path.join(HERE, 'stubs.sql'), ...migrationFiles(), path.join(HERE, 'seed.sql'), ...extraFiles]) {
    h.update(path.basename(f) + '\n'); h.update(readFileSync(f)); h.update('\n');
  }
  return h.digest('hex').slice(0, 12);
}

async function oneShot(database, fn) {
  const c = newClient(database); await c.connect();
  try { return await fn(c); } finally { try { await c.end(); } catch { /* ignore */ } }
}
async function dropDb(name, force = true) {
  await oneShot('postgres', (c) => c.query(`drop database if exists "${name}"${force ? ' with (force)' : ''}`));
}
export const dbExists = (name) => oneShot('postgres', async (c) => (await c.query('select 1 from pg_database where datname = $1', [name])).rowCount > 0);

function describeError(e) {
  const bits = [e.message];
  if (e.detail) bits.push('DETAIL: ' + e.detail);
  if (e.hint) bits.push('HINT: ' + e.hint);
  if (e.where) bits.push('WHERE: ' + e.where);
  if (e.position) bits.push('POSITION: ' + e.position);
  return bits.join('\n');
}
export { describeError };

/** Returns the template database name; builds it when missing, when its inputs changed, or when rebuild = true. */
export async function ensureTemplate({ rebuild = false, verbose = true } = {}) {
  await ensureServer();
  const name = 'tpl_' + templateHash();
  if (!rebuild && await dbExists(name)) return name;
  return withDirLock('template.lock', async () => {
    if (!rebuild && await dbExists(name)) return name;
    const t0 = Date.now();
    // The newest 4 templates are kept (differently configured callers, see --skip, would otherwise delete each other's). Run databases are
    // left alone unless clearly abandoned (older than 15 minutes and nobody connected): another process may be running a suite on its own
    // run_* database right now. keep_* databases are never touched.
    const stale = `select datname from (
          select d.datname, row_number() over (order by coalesce(substring(shobj_description(d.oid, 'pg_database') from 5)::bigint, 0) desc) rn
            from pg_database d where d.datname ~ '^tpl_[0-9a-f]{12}$') x where rn > 4
        union all select datname from pg_database where datname ~ '^tpl_[0-9a-f]{12}_b$'
        union all select d.datname from pg_database d
          where d.datname ~ '^run_[0-9]+_' and substring(d.datname from 5 for 10)::bigint < extract(epoch from now())::bigint - 900
            and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`;
    const old = await oneShot('postgres', async (c) => (await c.query(stale)).rows.map((r) => r.datname));
    for (const d of old) { try { await dropDb(d, false); } catch { /* in use by a live run: leave it */ } }
    const build = name + '_b';
    await dropDb(build);
    await oneShot('postgres', (c) => c.query(`create database "${build}" template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`));
    const steps = [path.join(HERE, 'stubs.sql'), ...migrationFiles(), path.join(HERE, 'seed.sql')];
    const c = newClient(build); await c.connect();
    c.on('notice', () => { /* migrations are chatty */ });
    try {
      for (const f of steps) {
        if (verbose) log('template:', path.basename(f));
        try { await c.query(readFileSync(f, 'utf8')); }
        catch (e) { throw new Error(`template build failed in ${path.relative(REPO, f)}:\n${describeError(e)}`); }
      }
      await c.query('analyze');
    } catch (e) { try { await c.end(); } catch { /* ignore */ } try { await dropDb(build); } catch { /* ignore */ } throw e; }
    await c.end();
    if (await dbExists(name)) {                      // --rebuild of a template with identical inputs: replace it only now that the new one is complete
      for (let i = 0; ; i++) { try { await dropDb(name, false); break; } catch (e) { if (i >= 20) throw e; await sleep(250); } }
    }
    await oneShot('postgres', (cc) => cc.query(`alter database "${build}" rename to "${name}"`));
    await oneShot('postgres', (cc) => cc.query(`comment on database "${name}" is 'tpl ${Math.floor(Date.now() / 1000)}'`));
    if (verbose) log(`template ${name} built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return name;
  });
}

// ------------------------------------------------------------------------------------------------------------- run databases
/** A fresh database cloned from the template. Names: run_<epoch seconds>_<random> (swept when abandoned) or keep_... (never swept). */
export async function createRunDb(template, { keep = false } = {}) {
  const name = `${keep ? 'keep' : 'run'}_${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString('hex')}`;
  for (let i = 0; ; i++) {
    try { await oneShot('postgres', (c) => c.query(`create database "${name}" template "${template}"`)); return name; }
    catch (e) {
      if (e.code === '55006' && i < 40) { await sleep(250); continue; }   // another CREATE DATABASE is copying the same template right now
      throw e;
    }
  }
}
/** ensureTemplate + createRunDb, retried when a concurrent rebuild replaced the template between the two. */
export async function newRunDb({ rebuild = false, keep = false, verbose = true } = {}) {
  for (let i = 0; ; i++) {
    const template = await ensureTemplate({ rebuild: rebuild && i === 0, verbose });
    try { return { template, name: await createRunDb(template, { keep }) }; }
    catch (e) { if ((e.code === '3D000' || e.code === '42704') && i < 3) continue; throw e; }
  }
}
export async function dropRunDb(name) {
  for (let i = 0; i < 5; i++) { try { await dropDb(name); return; } catch (e) { if (i === 4) throw e; await sleep(300); } }
}
export function readSql(file) {
  const p = [path.resolve(file), path.resolve(REPO, file)].find((x) => existsSync(x));
  if (!p) throw new Error(`file not found: ${file}`);
  const s = readFileSync(p, 'utf8');
  if (!s.trim()) throw new Error(`file is empty: ${file}`);
  return s;
}
