// Small proof that the local harness gives REAL concurrency (separate backend processes, real locks and unique indexes).
//   node scripts/local-pg/concurrency-demo.mjs
//   A. 10 sessions insert the same key into a table with a unique index                 -> exactly 1 succeeds, 9 get 23505
//   B. 10 sessions call the real sku_issue() with the same client_ref (migration code)  -> exactly 1 registry row, every caller gets that one code
//   C. 12 sessions call sku_issue() with different refs                                  -> 12 distinct, gap-free codes, counter = last code
import { randomUUID } from 'node:crypto';
import { withRunDb, ok, msg, sqlstate, check } from './concurrency-lib.mjs';

await withRunDb(async (db) => {
  // A. unique index race
  await db.query('create table demo_unique (k int primary key, who text)');
  const a = await db.parallel(Array.from({ length: 10 }, (_, i) => `insert into demo_unique values (1, 'session ${i}')`));
  check('A. exactly 1 of 10 concurrent inserts of the same key succeeds', a.filter(ok).length === 1, `${a.filter(ok).length} succeeded`);
  check('A. the other 9 fail with unique_violation (23505) and nothing else', a.filter((r) => !ok(r) && sqlstate(r) === '23505').length === 9, a.filter((r) => !ok(r)).map(msg).join(' | '));
  check('A. the table holds exactly one row', (await db.query('select count(*)::int n from demo_unique'))[0].n === 1);

  // B. the real, shipped function under real concurrency: same idempotency reference
  const [{ before }] = await db.query("select last_seq as before from sku_counters where category = 'FG'");
  const ref = randomUUID();
  const b = await db.parallel(Array.from({ length: 10 }, () => `select code, reused from public.sku_issue('FG', 'Concurrency demo', '${ref}', null)`));
  const codes = new Set(b.filter(ok).map((r) => r.value[0].code));
  const [{ rows }] = await db.query(`select count(*)::int as rows from sku_registry where client_ref = '${ref}'`);
  const [{ after }] = await db.query("select last_seq as after from sku_counters where category = 'FG'");
  check('B. all 10 same-ref calls succeed', b.every(ok), b.filter((r) => !ok(r)).map(msg).join(' | '));
  check('B. they all return the same code', codes.size === 1, [...codes].join(','));
  check('B. exactly one registry row and exactly one number burned', rows === 1 && Number(after) === Number(before) + 1, `rows=${rows} counter ${before} -> ${after}`);

  // C. distinct refs: distinct numbers, no gap, no duplicate
  const c = await db.parallel(Array.from({ length: 12 }, () => `select code, seq from public.sku_issue('FG', 'Concurrency demo C', '${randomUUID()}', null)`));
  const seqs = c.filter(ok).map((r) => Number(r.value[0].seq)).sort((x, y) => x - y);
  const [{ last }] = await db.query("select last_seq as last from sku_counters where category = 'FG'");
  check('C. 12 concurrent issues give 12 distinct numbers', new Set(seqs).size === 12, seqs.join(','));
  check('C. the numbers are consecutive (no gap) and the counter equals the last one', seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1) && Number(last) === seqs[11], `${seqs.join(',')} counter=${last}`);
});
