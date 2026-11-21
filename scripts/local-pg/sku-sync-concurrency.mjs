// Real-concurrency proof for the SKU registry change feed (migration 20261121120000_sku_registry_sync): a device that syncs with a cursor can never miss a committed change.
//   node scripts/local-pg/sku-sync-concurrency.mjs        (run from the repo root; local PostgreSQL only, never the Supabase project)
// The migration is read from supabase/migrations/ when it has been moved there, otherwise from supabase/wip/.
//   A. CONTROL   a plain bigserial cursor DOES skip a row that commits after a later id was read (the hazard is real).
//   B. FEED      same shape with the real trigger: the second writer waits for the first (advisory lock), the reader never sees change 2 without change 1.
//   C. STRESS    24 sessions write 12 SKUs (two writers per SKU, 3 rounds) while a reader polls in a loop: its union equals every change, intervals chain, cursor monotonic,
//                no id gap, and its local copy equals the registry at the end.
//   D. MIXED     sku_set_status, sku_set_details and sku_reserve (new app SKUs) in parallel: no deadlock, no error, every change delivered, new app SKUs in the feed.
//   E. IDEMPOTENT six sessions flip the same SKU to inactive at once: exactly one change row and one history row.
//   F. NEGATIVE  with the lock switched off, the reader of scenario B DOES miss a committed change: proof that B/C would catch a broken design.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withRunDb, ok, msg, sqlstate, check } from './concurrency-lib.mjs';

const FINAL = 'supabase/migrations/20261121120000_sku_registry_sync.sql';
const WIP = 'supabase/wip/20261121120000_sku_registry_sync.sql';
const MIG = existsSync(FINAL) ? FINAL : WIP;
const ADMIN = '22222222-2222-4222-8222-222222222222';          // seed.sql: the ADMIN profile
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = (n) => 'FG-' + String(n).padStart(6, '0');
console.log(`migration under test: ${MIG}`);

// ---- a reader that behaves like the app: first call null cursor, then the cursor it was given; remembers every poll
function startReader(client) {
  const st = { cursor: null, polls: [], replica: new Map(), firstSeen: new Map(), stop: false, error: null };
  st.done = (async () => {
    try {
      for (;;) {
        const stopping = st.stop;                                   // a poll that STARTS after stop was raised sees everything the writers committed
        await pollOnce(client, st);
        if (stopping) break;
        await sleep(2);
      }
    } catch (e) { st.error = e; }
  })();
  return st;
}
async function pollOnce(client, st) {
  const j = (await client.query('select public.sku_changes_since($1::bigint) as j', [st.cursor])).rows[0].j;
  const p = { i: st.polls.length, t: Date.now(), from: st.cursor, to: Number(j.cursor), full: j.full, skus: new Set(j.rows.map((r) => r.sku_code)) };
  st.polls.push(p);
  for (const r of j.rows) { st.replica.set(r.sku_code, r); if (!st.firstSeen.has(r.sku_code)) st.firstSeen.set(r.sku_code, p.i); }
  st.cursor = p.to;
  return p;
}
async function finish(st) { st.stop = true; await st.done; if (st.error) throw st.error; }

/** Everything the reader must satisfy, checked against the committed change log. */
async function auditReader(db, st, label) {
  const changes = await db.query('select id::bigint as id, sku_code from public.sku_registry_changes order by id');
  const first = st.polls[0];
  const mono = st.polls.every((p, i) => p.to >= (p.from ?? 0) && (i === 0 || (p.from === st.polls[i - 1].to && p.to >= st.polls[i - 1].to)));
  check(`${label}: the cursor never goes backwards and every poll continues from the last one (${st.polls.length} polls)`, mono && first.full === true && st.polls.slice(1).every((p) => p.full === false));
  const missed = [];
  for (const c of changes) {
    const id = Number(c.id);
    if (id <= first.to) continue;                                    // inside the first full snapshot
    const p = st.polls.find((q) => q.from < id && id <= q.to);
    if (!p || !p.skus.has(c.sku_code)) missed.push(`${id}:${c.sku_code}` + (p ? ` (poll ${p.i} ${p.from}..${p.to})` : ' (no poll)'));
  }
  check(`${label}: the reader's union covers EVERY committed change (${changes.length} changes, ${st.polls.length} polls)`, missed.length === 0, `missed ${missed.length}: ${missed.slice(0, 5).join(', ')}`);
  const ids = changes.map((c) => Number(c.id));
  check(`${label}: change ids have no gap (${ids.length ? ids[0] : '-'}..${ids.length ? ids[ids.length - 1] : '-'})`, ids.length > 0 && ids[ids.length - 1] - ids[0] + 1 === ids.length, `${ids.length} ids between ${ids[0]} and ${ids[ids.length - 1]}`);
  const db_ = await db.query('select public.sku_registry_row_json(r) as j from public.sku_registry r order by r.sku_category, r.sku_seq');
  const diff = db_.filter((x) => JSON.stringify(st.replica.get(x.j.sku_code)) !== JSON.stringify(x.j)).map((x) => x.j.sku_code);
  check(`${label}: the reader's local copy equals the registry (${db_.length} SKUs)`, diff.length === 0 && st.replica.size === db_.length, `${diff.length} differ: ${diff.slice(0, 5).join(', ')}`);
}

await withRunDb({ skip: ['sku_registry_sync'], files: [MIG] }, async (db) => {
  // ------------------------------------------------------------------------------------------------------ A. control: a plain bigserial cursor skips
  await db.query('create table ctl (id bigserial primary key, who text)');
  {
    const [s1, s2, rd] = await db.connect(3);
    const slow = s1.query("insert into ctl (who) values ('slow'); select pg_sleep(0.6)");      // takes id 1 now, commits after 0.6 s
    await sleep(150);
    await s2.query("insert into ctl (who) values ('fast')");                                  // takes id 2, commits at once
    const cursor = (await rd.query('select max(id)::int as m from ctl')).rows[0].m;           // the reader sees only id 2 ...
    await slow;
    const later = (await rd.query('select who from ctl where id > $1', [cursor])).rows;       // ... and asks for what is above 2
    const total = (await db.query('select count(*)::int as n from ctl'))[0].n;
    check('A. control: with a plain bigserial the reader holding cursor 2 never gets the row id 1 that committed later', cursor === 2 && later.length === 0 && total === 2, `cursor=${cursor} later=${later.length} total=${total}`);
  }

  // ------------------------------------------------------------------------------------------------------ B. the real feed, same shape
  {
    const [w1, w2, rdc] = await db.connect(3, { as: ADMIN });
    const st = startReader(rdc);
    await sleep(60);
    const t0 = Date.now();
    const p1 = w1.query(`select public.sku_set_details('${code(10)}', '{"selling_price": 501}'); select pg_sleep(0.6)`).then(() => Date.now() - t0);   // id 1: lock held until commit at ~0.6 s
    await sleep(150);
    const p2 = w2.query(`select public.sku_set_details('${code(11)}', '{"selling_price": 502}')`).then(() => Date.now() - t0);                              // id 2: must wait
    const [d1, d2] = await Promise.all([p1, p2]);
    await sleep(40);
    await finish(st);
    const ids = await db.query(`select sku_code, id::bigint as id from public.sku_registry_changes where sku_code in ('${code(10)}', '${code(11)}') order by id`);
    check('B. the second writer waited for the first to commit (advisory lock held until commit)', d2 >= d1 - 60 && d2 >= 450, `first done ${d1} ms, second done ${d2} ms`);
    check('B. ids follow commit order: the first committed write has the lower id', ids.length === 2 && ids[0].sku_code === code(10) && Number(ids[0].id) < Number(ids[1].id), JSON.stringify(ids));
    const [a, b] = [st.firstSeen.get(code(10)), st.firstSeen.get(code(11))];
    check('B. the reader never saw change 2 before change 1', a !== undefined && b !== undefined && a <= b, `first seen in poll ${a} and ${b}`);
    const during = st.polls.filter((p) => p.t > t0 + 100 && p.t < t0 + 450);                  // the first writer has written but not committed; the second is waiting
    check(`B. while the first writer was written-but-uncommitted the reader got nothing and kept its cursor (${during.length} polls)`, during.length >= 5 && during.every((p) => p.skus.size === 0 && p.to === st.polls[0].to), JSON.stringify(during.slice(0, 5).map((p) => [p.from, p.to, p.skus.size])));
    await auditReader(db, st, 'B');
  }

  // ------------------------------------------------------------------------------------------------------ C. stress: 24 writers on 12 SKUs, 3 rounds, a reader polling
  {
    const writers = await db.connect(24, { as: ADMIN });
    const [rdc] = await db.connect(1, { as: ADMIN });
    const st = startReader(rdc);
    await sleep(60);
    const results = [];
    for (let round = 1; round <= 3; round++) {
      const rs = await Promise.allSettled(writers.map((c, i) =>
        c.query(`select public.sku_set_details('${code(21 + (i % 12))}', '{"selling_price": ${round * 1000 + i}}'::jsonb); select pg_sleep(${(Math.random() * 0.04).toFixed(3)})`)));
      results.push(...rs);
    }
    await sleep(30);
    await finish(st);
    check('C. all 72 concurrent updates succeeded (no deadlock, no error)', results.every((r) => r.status === 'fulfilled'), results.filter((r) => r.status === 'rejected').map((r) => r.reason?.code + ' ' + r.reason?.message).slice(0, 3).join(' | '));
    const n = (await db.query(`select count(*)::int as n from public.sku_registry_changes where sku_code between '${code(21)}' and '${code(32)}'`))[0].n;
    check('C. every one of the 72 writes left exactly one change row', n === 72, `${n} rows`);
    await auditReader(db, st, 'C');
  }

  // ------------------------------------------------------------------------------------------------------ D. mixed workload: status, details, new app SKUs
  {
    const [rdc] = await db.connect(1, { as: ADMIN });
    const st = startReader(rdc);
    await sleep(60);
    const sqls = [
      ...Array.from({ length: 4 }, (_, i) => `select public.sku_set_status('${code(40 + i)}', 'inactive', 'concurrency D')`),
      ...Array.from({ length: 4 }, (_, i) => `select public.sku_set_details('${code(50)}', '{"selling_price": ${700 + i}, "brand": "D${i}"}'::jsonb)`),
      ...Array.from({ length: 4 }, (_, i) => `select code from public.sku_reserve('FG', 'Concurrent app SKU ${i}', '${randomUUID()}')`),
    ];
    const rs = await db.parallel(sqls, { as: ADMIN });
    await sleep(30);
    await finish(st);
    check('D. 12 mixed concurrent calls all succeed (no deadlock 40P01, nothing else)', rs.every(ok), rs.filter((r) => !ok(r)).map((r) => `${sqlstate(r)} ${msg(r)}`).join(' | '));
    const codes = rs.slice(8).filter(ok).map((r) => r.value[0].code);
    check('D. the 4 new app SKUs got 4 distinct codes', new Set(codes).size === 4, codes.join(','));
    check('D. every new app SKU reached the reader (origin app, active)', codes.every((c) => st.replica.get(c)?.origin === 'app' && st.replica.get(c)?.status === 'active'), codes.map((c) => c + ':' + st.replica.get(c)?.origin).join(' '));
    check('D. the 4 status flips of 4 different SKUs reached the reader as inactive', [40, 41, 42, 43].every((k) => st.replica.get(code(k))?.status === 'inactive'));
    await auditReader(db, st, 'D');
  }

  // ------------------------------------------------------------------------------------------------------ E. the same status flip from six sessions at once
  {
    const rs = await db.parallel(Array.from({ length: 6 }, () => `select public.sku_set_status('${code(60)}', 'inactive', 'race E')`), { as: ADMIN });
    const [{ c }] = await db.query(`select count(*)::int as c from public.sku_registry_changes where sku_code = '${code(60)}'`);
    const [{ h }] = await db.query(`select count(*)::int as h from public.sku_code_history where sku_code = '${code(60)}' and action = 'deactivated'`);
    check('E. six simultaneous identical flips all succeed', rs.every(ok) && rs.every((r) => r.value[0].sku_set_status.status === 'inactive'), rs.filter((r) => !ok(r)).map(msg).join(' | '));
    check('E. exactly ONE change row and ONE history row (idempotent under concurrency)', c === 1 && h === 1, `change rows ${c}, history rows ${h}`);
  }

  // ------------------------------------------------------------------------------------------------------ F. negative control: the same scenario as B with the lock switched off
  {
    await db.query('create or replace function public.sku_changes_lock() returns void language plpgsql security definer set search_path = public as $$ begin return; end $$');
    const [w1, w2, rdc] = await db.connect(3, { as: ADMIN });
    const st = startReader(rdc);
    await sleep(60);
    const p1 = w1.query(`select public.sku_set_details('${code(70)}', '{"selling_price": 801}'); select pg_sleep(0.6)`);   // takes the lower id, commits late
    await sleep(150);
    await w2.query(`select public.sku_set_details('${code(71)}', '{"selling_price": 802}')`);                                // takes the higher id, commits at once
    await p1;
    await sleep(60);
    await finish(st);
    check('F. negative control: WITHOUT the lock the reader misses the late-committing change (so scenarios B and C can fail)', st.replica.get(code(71))?.selling_price == 802 && st.replica.get(code(70))?.selling_price != 801,
      `71 -> ${st.replica.get(code(71))?.selling_price}, 70 -> ${st.replica.get(code(70))?.selling_price}`);
  }
});
