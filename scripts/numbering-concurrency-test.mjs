// Concurrency test of the central document numbering, in a THROW-AWAY schema (never the real counters).
// It builds the tables and the exact source of next_doc_no() + the counter guard from the migration FILE in schema ct_num_<random>, then fires parallel
// requests, each its own database connection and transaction:
//   1. 40 parallel orders                                  -> exactly ORD-000001 .. ORD-000040: no duplicate, no gap
//   2. 30 parallel invoices, 10 of them rolled back        -> the 20 that committed are exactly INV-000001 .. INV-000020 (the rolled-back ones gave their number back)
//   3. 30 parallel "payment, wallet row, wallet number" transactions on ONE wallet row (the fixed lock order) -> no deadlock, all numbers distinct and gap-free
//   4. several document types at once                      -> each series is independent and complete
// Needs a Supabase management token in ~/.supabase-token. The schema is dropped at the end, also on failure.
//   node scripts/numbering-concurrency-test.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const REF = 'hlvravynjalculvplrxc';
const token = readFileSync(`${homedir()}/.supabase-token`, 'utf8').trim();
const S = 'ct_num_' + randomBytes(4).toString('hex');

// the management API throttles bursts (HTTP 429): wait and retry; a retry is a new request, the concurrency being tested is between the requests of one batch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sql(query) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    const j = await r.json();
    if (r.ok) return j;
    if (/Too Many Requests/i.test(j.message ?? '') && attempt < 8) { await sleep(4000 * attempt); continue; }
    throw new Error(j.message ?? JSON.stringify(j));
  }
}
const settle = (queries) => Promise.allSettled(queries.map((q) => sql(q)));
const ok = (r) => r.status === 'fulfilled';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  => ' + detail}`); if (!cond) failed++; };
const nums = (rs, col = 'n') => rs.filter(ok).map((r) => r.value[0][col]);
const expectSeries = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(6, '0')}`);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

try {
  const mig = readFileSync(new URL('../supabase/migrations/20261115500000_document_numbering.sql', import.meta.url), 'utf8');
  const grab = (startRe, endMark) => { const i = mig.search(startRe); if (i < 0) throw new Error('not found: ' + startRe); const rest = mig.slice(i); return rest.slice(0, rest.indexOf(endMark) + endMark.length); };
  const toSchema = (t) => t.replace(/public\./g, S + '.');
  const ddl = ['doc_number_settings', 'doc_number_formats', 'doc_counters'].map((t) => toSchema(grab(new RegExp(`create table if not exists public\\.${t} \\(`), '\n);'))).join('\n');
  const guard = toSchema(grab(/create or replace function public\.doc_counter_guard\(/, 'end $$;'));
  const trigger = `create trigger doc_counters_guard before update or delete on ${S}.doc_counters for each row execute function ${S}.doc_counter_guard();`;
  const fnNext = toSchema(grab(/create or replace function public\.next_doc_no\(/, 'end $$;'));
  await sql(`create schema ${S}; ${ddl}`);
  await sql(guard); await sql(trigger); await sql(fnNext);
  await sql(`insert into ${S}.doc_number_settings (id) values (true);
    insert into ${S}.doc_number_formats (doc_type, prefix, period_mode, digits) values ('ORDER', 'ORD', 'none', 6), ('INVOICE', 'INV', 'none', 6), ('PAYMENT', 'PAY', 'none', 6), ('WALLET', 'WAL', 'none', 6);
    create table ${S}.wallet (id int primary key, balance int not null default 0); insert into ${S}.wallet values (1, 0);`);

  // 1. forty parallel orders
  const r1 = await settle(Array.from({ length: 40 }, () => `select ${S}.next_doc_no('ORDER') as n`));
  check('1. all 40 parallel orders succeed', r1.every(ok), r1.filter((r) => !ok(r)).map((r) => r.reason.message.slice(0, 100)).join(' | '));
  check('1. they got exactly ORD-000001 .. ORD-000040 (no duplicate, no gap)', sameSet(nums(r1), expectSeries('ORD', 1, 40)), nums(r1).sort().join(','));

  // 2. thirty parallel invoices, ten roll back after taking a number
  const r2 = await settle(Array.from({ length: 30 }, (_, i) => i % 3 === 0
    ? `do $$ begin perform ${S}.next_doc_no('INVOICE'); raise exception 'ROLLED_BACK'; end $$;`
    : `select ${S}.next_doc_no('INVOICE') as n`));
  const committed = r2.filter((r) => ok(r) && r.value[0]?.n);
  const rolled = r2.filter((r) => !ok(r) && /ROLLED_BACK/.test(r.reason.message));
  check('2. 20 invoices committed and 10 rolled back (and nothing failed for another reason)', committed.length === 20 && rolled.length === 10, `${committed.length} committed, ${rolled.length} rolled back, ${r2.filter((r) => !ok(r) && !/ROLLED_BACK/.test(r.reason.message)).map((r) => r.reason.message.slice(0, 80)).join(' | ')}`);
  check('2. the committed ones are exactly INV-000001 .. INV-000020: the rolled-back numbers were given back', sameSet(nums(committed), expectSeries('INV', 1, 20)), nums(committed).sort().join(','));
  const [c2] = await sql(`select last_seq from ${S}.doc_counters where doc_type = 'INVOICE'`);
  check('2. the invoice counter stands at 20', Number(c2.last_seq) === 20, JSON.stringify(c2));

  // 3. the fixed lock order (payment number, wallet row, wallet number) on one wallet row, thirty at once
  const r3 = await settle(Array.from({ length: 30 }, () => `select p, w from (
      select ${S}.next_doc_no('PAYMENT') as p
    ) a, lateral (select (select ${S}.next_doc_no('WALLET') from ${S}.wallet where id = 1 for update) as w) b`));
  check('3. thirty payments in the fixed lock order: no deadlock, all succeed', r3.every(ok), r3.filter((r) => !ok(r)).map((r) => r.reason.message.slice(0, 100)).join(' | '));
  check('3. payment numbers PAY-000001 .. 000030 and wallet numbers WAL-000001 .. 000030, each once', sameSet(nums(r3, 'p'), expectSeries('PAY', 1, 30)) && sameSet(nums(r3, 'w'), expectSeries('WAL', 1, 30)), '');

  // 4. several types at once: independent, complete series
  const mix = [];
  for (let i = 0; i < 12; i++) mix.push(`select 'ORDER' t, ${S}.next_doc_no('ORDER') n`, `select 'INVOICE' t, ${S}.next_doc_no('INVOICE') n`, `select 'PAYMENT' t, ${S}.next_doc_no('PAYMENT') n`);
  const r4 = await settle(mix);
  const got = (t) => r4.filter(ok).map((r) => r.value[0]).filter((x) => x.t === t).map((x) => x.n);
  check('4. a mixed burst: every request succeeded', r4.every(ok), r4.filter((r) => !ok(r)).map((r) => r.reason.message.slice(0, 100)).join(' | '));
  check('4. each series continues without a gap or a repeat (ORD 41-52, INV 21-32, PAY 31-42)', sameSet(got('ORDER'), expectSeries('ORD', 41, 52)) && sameSet(got('INVOICE'), expectSeries('INV', 21, 32)) && sameSet(got('PAYMENT'), expectSeries('PAY', 31, 42)), '');

  // the guard: a counter cannot be lowered or deleted
  let lowered = ''; try { await sql(`update ${S}.doc_counters set last_seq = 0 where doc_type = 'ORDER'`); lowered = 'allowed'; } catch (e) { lowered = e.message; }
  check('5. a counter cannot be lowered', /only moves forward/.test(lowered), lowered.slice(0, 120));
} catch (e) {
  console.log('ERROR ', e.message); failed++;
} finally {
  try { await sql(`drop schema if exists ${S} cascade`); console.log(`throw-away schema ${S} dropped`); } catch (e) { console.log('could not drop ' + S + ': ' + e.message); failed++; }
}
process.exit(failed ? 1 : 0);
