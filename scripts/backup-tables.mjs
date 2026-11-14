// A verified, READ-ONLY recovery point: exports every row of every non-empty table in schema public (and the migration history) to JSON files in a
// folder OUTSIDE the repository (the data is personal: it must never be committed), then re-counts the rows in the database and writes a manifest with
// row counts and SHA-256 checksums. It only ever sends generated SELECT statements and refuses to continue if an export does not match the live count.
//   node scripts/backup-tables.mjs "C:/Users/me/bizops-backups/20261115-before-numbering"
// The Supabase plan of this project has no managed backups / point-in-time recovery (checked through the management API), so this is the recovery point.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const REF = 'hlvravynjalculvplrxc';
const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: node scripts/backup-tables.mjs <folder outside the repository>'); process.exit(2); }
const repo = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (out.toLowerCase().startsWith(repo.toLowerCase())) { console.error('REFUSING: the backup folder must be outside the repository'); process.exit(2); }
if (existsSync(out) && readdirSync(out).length) { console.error('REFUSING: the folder is not empty: never overwrite a recovery point'); process.exit(2); }
mkdirSync(out, { recursive: true });
const token = readFileSync(`${homedir()}/.supabase-token`, 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function select(query) {
  if (!/^\s*select\s/i.test(query) || /;\s*\S/.test(query) || /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(query.replace(/'[^']*'/g, ''))) throw new Error('not a plain SELECT: ' + query.slice(0, 80));
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, read_only: true }) });
    const j = await r.json();
    if (r.ok) return j;
    if (/Too Many Requests/i.test(j.message ?? '') && attempt < 8) { await sleep(3000 * attempt); continue; }
    throw new Error(j.message ?? JSON.stringify(j));
  }
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

const tables = (await select(`select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`));
const manifest = { taken_at: new Date().toISOString(), project: REF, git_commit: (() => { try { return execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(); } catch { return null; } })(), tables: [], all_tables: tables.map((t) => `${t.table_name}:${t.n}`) };
let bad = 0;
for (const t of tables.filter((x) => x.n > 0)) {
  const rows = await select(`select to_jsonb(t) as r from public."${t.table_name.replace(/"/g, '')}" t`);
  const body = JSON.stringify(rows.map((x) => x.r), null, 1);
  writeFileSync(join(out, `${t.table_name}.json`), body);
  const [again] = await select(`select count(*)::int as n from public."${t.table_name}"`);
  const okRows = rows.length === t.n && again.n === t.n;
  if (!okRows) bad++;
  manifest.tables.push({ table: t.table_name, rows_exported: rows.length, rows_in_database: again.n, sha256: sha(body), ok: okRows });
  console.log(`${okRows ? 'OK  ' : 'BAD '} ${t.table_name.padEnd(30)} ${String(rows.length).padStart(5)} rows`);
}
const hist = await select(`select version, name, created_by from supabase_migrations.schema_migrations order by version`);
const histBody = JSON.stringify(hist, null, 1); writeFileSync(join(out, '_schema_migrations.json'), histBody);
manifest.migration_history = { versions: hist.length, last: hist.at(-1)?.version, sha256: sha(histBody) };
const defs = await select(`select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' order by 1`);
const defsBody = JSON.stringify(defs, null, 1); writeFileSync(join(out, '_function_definitions.json'), defsBody);
manifest.functions = { count: defs.length, sha256: sha(defsBody) };
manifest.verified = bad === 0;
writeFileSync(join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 1));
console.log(`\n${manifest.tables.length} tables with data exported to ${out}\n${manifest.verified ? 'VERIFIED: every export matches the live row count' : 'NOT VERIFIED: ' + bad + ' table(s) differ'}`);
process.exit(bad ? 1 : 0);
