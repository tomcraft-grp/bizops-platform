// REAL concurrency proof for the event boards (separate backend processes, committed rows, real locks and unique indexes) on the LOCAL throw-away PostgreSQL.
// Never the Supabase project. Every scenario gets its own fresh database cloned from the template and drops it afterwards.
//   node scripts/local-pg/boards-concurrency.mjs          (ONLY=6 runs just scenario 6; ONLY=1,2 several)
//   6. lock order: settles + claims + confirms + review "release" + admin release / reset + sweep of lapsed holds, all at once -> no deadlock (40P01)
//   7. a REAL payment reversal (finance functions + settle trigger) + a second payment + claims + settles of the same customer -> no deadlock, rights end consistent
// It loads the rewards core and the event boards migration into each run database: the files under supabase/migrations/ when they exist, else the work-in-progress
// copies under supabase/wip/ (override with BOARDS_CORE=<file> BOARDS_MIGRATION=<file>).
//   1. 20 customers (one right each) claim ONE exclusive number at the same instant          -> exactly 1 success, 19 NUMBER_TAKEN, 1 row, 19 rights untouched
//   2. ONE customer with 5 rights fires 20 claims on 20 different numbers at once             -> exactly 5 succeed, 15 NO_ENTITLEMENT, 5 rights used
//   3. claims racing rw_board_reset and rw_board_set_mode, then an undo racing new claims     -> no deadlock, no lost / doubled right, no number held twice, reset bookkeeping exact
//   4. one customer sends the SAME key 15 times at once; and one key with two payloads        -> one selection, one right, replays return it; the other payload is KEY_REUSED
//   5. two readers of rw_board_state while 20 customers claim                                 -> every snapshot internally consistent (rev, taken and cells agree)
import { existsSync } from 'node:fs';
import { openRunDb, ok, msg, sqlstate, asUser } from './concurrency-lib.mjs';

const exists = (p) => existsSync(new URL('../../' + p, import.meta.url));
const pick = (final, wip) => (exists(final) ? final : wip);
const CORE = process.env.BOARDS_CORE || pick('supabase/migrations/20261121100000_rewards_core.sql', 'supabase/wip/20261121100000_rewards_core.sql');
const BOARDS = process.env.BOARDS_MIGRATION || pick('supabase/migrations/20261121110000_event_boards.sql', 'supabase/wip/20261121110000_event_boards.sql');
const SUPER = '11111111-1111-4111-8111-111111111111';          // the seed's SUPER_ADMIN

let total = 0, failed = 0;
const want = (n) => !process.env.ONLY || process.env.ONLY.split(",").includes(String(n));          // ONLY=6 runs one scenario
function check(name, cond, detail = '') {
  total++; if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  => ' + detail}`);
}
const tally = (rs) => { const t = {}; for (const r of rs) { const k = ok(r) ? 'ok' : msg(r).split(/[:\n]/)[0] || `sqlstate ${sqlstate(r)}`; t[k] = (t[k] || 0) + 1; } return t; };
const show = (t) => Object.entries(t).map(([k, v]) => `${k} x${v}`).join(', ');

/** A fresh database with both migrations committed, rewards and boards switched on, N shop members, and one active event. */
async function world(members, { hold = 0, rightsEach = 1 } = {}) {
  const db = await openRunDb({ skip: ['rewards_core', 'event_boards'], files: [CORE, BOARDS] });
  await db.query(`update public.rw_settings set enabled = true, boards_enabled = true`);
  await db.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c' || g || '@race.test', '', now(), '{"provider":"line"}',
           json_build_object('display_name', 'Racer ' || g), now(), now() from generate_series(1, ${members}) g`);
  const people = (await db.query(`select id, email from public.profiles where email like 'c%@race.test'`))
    .sort((a, b) => parseInt(a.email.slice(1)) - parseInt(b.email.slice(1))).map((r) => r.id);
  const [{ id: event }] = await db.query(`insert into public.rw_events (name, status, hold_minutes) values ('Race', 'active', ${hold}) returning id`);
  const boards = Object.fromEntries((await db.query(`select slot, id, name from public.rw_boards where event_id = '${event}'`)).map((r) => [r.slot, r]));
  const [{ id: rule }] = await db.query(`insert into public.rw_rules (kind, name, spend_step, reward_amount, event_id) values ('board_pick', 'race rule', 300, 1, '${event}') returning id`);
  const giveRights = async (uid, n) => db.query(`insert into public.rw_entitlements (rule_id, profile_id, event_id, source_order_id, seq) select '${rule}', '${uid}', '${event}', gen_random_uuid(), g from generate_series(1, ${n}) g`);
  for (const uid of people) if (rightsEach > 0) await giveRights(uid, rightsEach);
  return { db, people, event, boards, rule, giveRights };
}
/** a statement run as a signed-in member (claims + role), sent as one query */
const as = (uid, sql) => `${asUser(uid)} ${sql}`;
const claim = (w, board, n, key) => `select public.rw_claim_number('${w.event}', '${board}', ${n}, '${key}') as r`;
const q = (w, sql) => w.db.query(sql);
/** random 0-150 ms pause after the start gate, so that the two sides of a race take turns winning it */
const jit = (sql) => `select pg_sleep(random() * 0.15); ${sql}`;
const one = async (w, sql) => Object.values((await q(w, sql))[0])[0];

// ===================================================================================================================== 1
if (want("1")) {
  const w = await world(20);
  const { db } = w;
  const rev0 = Number(await one(w, `select rev from public.rw_boards where id = '${w.boards[1].id}'`));
  const rs = await db.parallel(w.people.map((uid, i) => as(uid, claim(w, w.boards[1].id, 7, `race1-key-${String(i).padStart(3, '0')}`))));
  const t = tally(rs);
  check('1. 20 customers claim the same exclusive number at once: exactly 1 succeeds', rs.filter(ok).length === 1, show(t));
  check('1. the other 19 get NUMBER_TAKEN and nothing else (no deadlock, no unique-violation leak, no serialization error)', (t.NUMBER_TAKEN || 0) === 19, show(t));
  check('1. exactly one active selection holds number 7', Number(await one(w, `select count(*) from public.rw_selections where board_id = '${w.boards[1].id}' and number = 7 and status in ('reserved','confirmed')`)) === 1);
  check('1. exactly one right is spent, the 19 losers still have theirs', Number(await one(w, `select count(*) from public.rw_entitlements where status = 'used'`)) === 1
    && Number(await one(w, `select count(*) from public.rw_entitlements where status = 'available'`)) === 19);
  check('1. the winner\'s right points at the winning row', Number(await one(w, `select count(*) from public.rw_selections s join public.rw_entitlements e on e.used_selection_id = s.id and e.id = s.entitlement_id and e.profile_id = s.profile_id where s.number = 7`)) === 1);
  check('1. the board revision moved by exactly 1 (one change)', Number(await one(w, `select rev from public.rw_boards where id = '${w.boards[1].id}'`)) === rev0 + 1);
  // the same race again, but hitting the DATABASE directly (a writer that bypasses the function) - the partial unique index alone must hold
  const spare = (await q(w, `select profile_id from public.rw_entitlements where status = 'available' order by profile_id limit 10`)).map((r) => r.profile_id);      // ten customers that still have a right
  const raw = await db.parallel(spare.map((uid) => `insert into public.rw_selections (event_id, board_id, number, profile_id, entitlement_id, exclusive, status)
    select '${w.event}', '${w.boards[2].id}', 9, '${uid}', e.id, true, 'confirmed' from public.rw_entitlements e where e.profile_id = '${uid}' and e.status = 'available' limit 1`));
  check('1. bypassing the function: 10 raw inserts of one exclusive number -> exactly 1 row (index backstop), the rest 23505', raw.filter(ok).length === 1 && raw.filter((r) => !ok(r) && sqlstate(r) === '23505').length === 9, show(tally(raw)));
  await db.close();
}

// ===================================================================================================================== 2
if (want("2")) {
  const w = await world(1, { rightsEach: 5 });
  const { db } = w;
  const me = w.people[0];
  const rs = await db.parallel(Array.from({ length: 20 }, (_, i) => as(me, claim(w, w.boards[1].id, 30 + i, `race2-key-${String(i).padStart(3, '0')}`))));
  const t = tally(rs);
  check('2. one customer with 5 rights fires 20 claims on 20 different numbers: exactly 5 succeed', rs.filter(ok).length === 5, show(t));
  check('2. the other 15 get NO_ENTITLEMENT and nothing else', (t.NO_ENTITLEMENT || 0) === 15, show(t));
  check('2. 5 active selections, 5 rights used, 0 left (never more selections than rights)', Number(await one(w, `select count(*) from public.rw_selections where status in ('reserved','confirmed')`)) === 5
    && Number(await one(w, `select count(*) from public.rw_entitlements where status = 'used'`)) === 5 && Number(await one(w, `select count(*) from public.rw_entitlements where status = 'available'`)) === 0);
  check('2. every right backs exactly one selection (no right used twice)', Number(await one(w, `select count(distinct entitlement_id) from public.rw_selections where status in ('reserved','confirmed')`)) === 5);
  await db.close();
}

// ===================================================================================================================== 3
// Each round is a new event on the same database. Four numbers are held BEFORE the race (so the reset always has something to clear), then 8 more claims, a reset
// (returning the picks) and a mode switch start together; afterwards an undo of that reset races 4 other customers who grab numbers it freed.
// Which side wins a race is up to the server, so the round is repeated and the outcomes are counted.
if (want("3")) {
  const ROUNDS = 10;
  let bad = '', undoOk = 0, undoConflict = 0, resetBefore = 0, claimedAfterReset = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const w = await world(16);                      // a fresh database per round: every parallel call keeps its sessions open until the database is closed
    const { db, event, boards } = w;
    const A = boards[1];
    const cl = (n, key) => `select public.rw_claim_number('${event}', '${A.id}', ${n}, '${key}') as r`;
    await db.parallel([0, 1, 2, 3].map((i) => as(w.people[i], cl(10 + i, `r3-${round}-pre-${i}-key`))));              // held before the race
    const sqls = [];
    for (let i = 4; i < 12; i++) sqls.push(as(w.people[i], jit(cl(10 + i, `r3-${round}-race-${i}-key`))));
    sqls.push(as(SUPER, jit(`select public.rw_board_reset('${A.id}', 'race: reset in the middle of claims', true, '${A.name}') as r`)));
    sqls.push(as(SUPER, jit(`select public.rw_board_set_mode('${A.id}', 'shared', 'race: switch in the middle of claims') as r`)));
    const rs = await db.parallel(sqls);
    const note = (m) => { bad ||= `round ${round}: ${m}`; };
    if (!rs.every(ok)) note('a call failed: ' + show(tally(rs)));
    const rows = await db.query(`select s.id, s.profile_id, s.number, s.status, s.exclusive, s.reset_id, s.pick_returned, e.status as ent_status, e.used_selection_id
                                   from public.rw_selections s join public.rw_entitlements e on e.id = s.entitlement_id where s.board_id = '${A.id}'`);
    const active = rows.filter((r) => r.status === 'confirmed'), reset = rows.filter((r) => r.status === 'reset');
    if (rows.length !== 12) note(`${rows.length} rows for 12 claims`);
    if (!active.every((r) => r.ent_status === 'used' && r.used_selection_id === r.id)) note('an active row whose right is not used by it');
    if (!reset.every((r) => r.ent_status === 'available' && r.pick_returned === 'available' && r.used_selection_id === null)) note('a reset row whose pick was not returned');
    const [rec] = await db.query(`select id, affected from public.rw_board_resets where board_id = '${A.id}'`);
    if (!rec || Number(rec.affected) !== reset.length || Number(rec.affected) < 4) note(`reset record ${rec && rec.affected} vs ${reset.length} rows`);
    const dup = Number((await db.query(`select count(*) n from (select number from public.rw_selections where board_id = '${A.id}' and status in ('reserved','confirmed') group by number having count(*) > 1 and bool_or(exclusive)) x`))[0].n)
      + Number((await db.query(`select count(*) n from (select number from public.rw_selections where board_id = '${A.id}' and status in ('reserved','confirmed') group by number having bool_or(exclusive) and bool_or(not exclusive)) x`))[0].n);
    if (dup) note('a number is held twice');
    const [{ used, avail }] = await db.query(`select count(*) filter (where status = 'used') used, count(*) filter (where status = 'available') avail from public.rw_entitlements where event_id = '${event}'`);
    if (Number(used) !== active.length || Number(avail) !== 16 - active.length) note(`rights not conserved: used ${used} available ${avail} active ${active.length}`);
    const [{ mode, rev }] = await db.query(`select mode, rev from public.rw_boards where id = '${A.id}'`);
    if (mode !== 'shared') note('mode is ' + mode);
    if (Number(rev) !== 4 + 8 + 2) note(`revision ${rev}, expected 14 (4 earlier claims + 8 racing claims + reset + switch)`);
    resetBefore += reset.filter((r) => Number(r.number) >= 14).length;               // claims that landed BEFORE the reset (so it cleared them too)
    claimedAfterReset += active.filter((r) => Number(r.number) >= 14).length;         // claims that landed AFTER the reset (so they stayed)

    // the undo, racing four customers that go for numbers the reset freed
    const nums = reset.map((r) => Number(r.number));
    const sqls2 = [as(SUPER, jit(`select public.rw_board_undo_reset('${rec.id}', 'race: undo while the numbers are being taken') as r`))];
    for (let i = 0; i < 4; i++) sqls2.push(as(w.people[12 + i], jit(cl(nums[i % nums.length], `r3-${round}-late-${i}-key`))));
    const rs2 = await db.parallel(sqls2);
    const undo = rs2[0], claims2 = rs2.slice(1), undone = ok(undo);
    if (!(undone || msg(undo).startsWith('RESET_CONFLICT'))) note('undo said ' + msg(undo));
    if (!claims2.every((r) => ok(r) || msg(r) === 'NUMBER_TAKEN')) note('a late claim said ' + show(tally(claims2)));
    undone ? undoOk++ : undoConflict++;
    const left = Number((await db.query(`select count(*) n from public.rw_selections where reset_id = '${rec.id}' and status = 'reset'`))[0].n);
    if (undone ? left !== 0 : left !== reset.length) note(`undo is not all-or-nothing: undone=${undone}, still reset ${left} of ${reset.length}`);
    const q2 = async (s) => Number((await db.query(s))[0].n);
    if (await q2(`select count(*) n from (select number from public.rw_selections where board_id = '${A.id}' and status in ('reserved','confirmed') group by number having count(*) > 1 and bool_or(exclusive)) x`)) note('after the undo race a number is held twice');
    if (await q2(`select count(*) n from (select entitlement_id from public.rw_selections where status in ('reserved','confirmed') group by entitlement_id having count(*) > 1) x`)) note('a right backs two selections');
    if (await q2(`select count(*) n from public.rw_entitlements e where e.status = 'used' and not exists (select 1 from public.rw_selections s where s.id = e.used_selection_id and s.status in ('reserved','confirmed'))`)) note('a used right has no active selection');
    if (await q2(`select count(*) n from public.rw_entitlements e where e.status = 'available' and exists (select 1 from public.rw_selections s where s.entitlement_id = e.id and s.status in ('reserved','confirmed'))`)) note('an available right has an active selection');
    await db.close();
  }
  check(`3. ${ROUNDS} rounds of (8 claims + reset + mode switch) then (undo + 4 claims on the freed numbers): no deadlock, no lost or doubled right, no number held twice, reset records exact, undo all-or-nothing, revisions exact`, bad === '', bad);
  console.log(`      (info, not a check: the server decides who wins each race, jitter makes both orders occur) racing claims cleared by the reset: ${resetBefore}, racing claims that landed after it: ${claimedAfterReset}; undo succeeded ${undoOk}x, RESET_CONFLICT ${undoConflict}x`);
}

// ===================================================================================================================== 4
if (want("4")) {
  const w = await world(1, { rightsEach: 3 });
  const { db } = w;
  const me = w.people[0];
  const key = 'race4-same-key-0001';
  const rs = await db.parallel(Array.from({ length: 15 }, () => as(me, claim(w, w.boards[1].id, 42, key))));
  const replies = rs.filter(ok).map((r) => r.value[0].r);
  check('4. 15 identical requests (same key, same payload) at once: all 15 succeed', rs.every(ok), show(tally(rs)));
  check('4. exactly one of them did the work (replay=false), 14 are replays', replies.filter((x) => x.replay === false).length === 1 && replies.filter((x) => x.replay === true).length === 14);
  check('4. they all return the same selection', new Set(replies.map((x) => x.selection.id)).size === 1);
  check('4. one selection, one right used (a retried claim never spends a second pick)', Number(await one(w, `select count(*) from public.rw_selections`)) === 1 && Number(await one(w, `select count(*) from public.rw_entitlements where status = 'used'`)) === 1
    && Number(await one(w, `select count(*) from public.rw_entitlements where status = 'available'`)) === 2);
  // one key, two different payloads
  const key2 = 'race4-mixed-key-001';
  const rs2 = await db.parallel(Array.from({ length: 10 }, (_, i) => as(me, claim(w, w.boards[2].id, i % 2 ? 60 : 61, key2))));
  const t2 = tally(rs2);
  const okIds = new Set(rs2.filter(ok).map((r) => r.value[0].r.selection.id));
  check('4. one key with two different payloads at once: one payload wins, the other is KEY_REUSED', okIds.size === 1 && rs2.filter(ok).length === 5 && (t2.KEY_REUSED || 0) === 5, show(t2));
  check('4. ... and only the winner\'s selection exists (2 in total, 2 rights used)', Number(await one(w, `select count(*) from public.rw_selections`)) === 2 && Number(await one(w, `select count(*) from public.rw_entitlements where status = 'used'`)) === 2);
  await db.close();
}

// ===================================================================================================================== 5
if (want("5")) {
  const w = await world(22, { rightsEach: 0 });
  for (const uid of w.people.slice(0, 20)) await w.giveRights(uid, 1);
  const { db } = w;
  const claimers = w.people.slice(0, 20), readers = w.people.slice(20, 22);
  const boardIds = [1, 2, 3].map((s) => w.boards[s].id);
  const rev0 = Object.fromEntries((await q(w, `select id, rev from public.rw_boards where event_id = '${w.event}'`)).map((r) => [r.id, Number(r.rev)]));
  let done = false;
  const snaps = [];
  const readerLoop = async (uid, idx) => {
    const [c] = await db.connect(1, { as: uid });
    let n = 0;
    while (!done && n < 4000) {
      const { rows } = await c.query(`select public.rw_board_state('${w.event}') as s`);
      snaps.push({ idx, s: rows[0].s }); n++;
    }
  };
  const loops = readers.map((uid, i) => readerLoop(uid, i));
  const burst = await db.parallel(claimers.map((uid, i) => as(uid, claim(w, boardIds[i % 3], 10 + Math.floor(i / 3), `race5-key-${String(i).padStart(3, '0')}`))));
  done = true; await Promise.all(loops);
  check('5. 20 customers claim distinct numbers across the three boards while two readers poll: every claim succeeds', burst.every(ok), show(tally(burst)));
  let bad = '', seenTaken = new Set();
  const last = {};
  for (const { idx, s } of snaps) {
    for (const b of s.boards) {
      const taken = b.numbers.filter((c) => c.c > 0).length;
      const claimsSeen = b.rev - rev0[b.id];
      if (b.taken !== taken) bad ||= `taken ${b.taken} != cells ${taken} on ${b.name}`;
      if (claimsSeen !== b.taken) bad ||= `rev moved by ${claimsSeen} but ${b.taken} numbers are taken on ${b.name}`;            // one claim = +1 rev and +1 taken, so a torn snapshot shows here
      if (b.numbers.length !== 100 || new Set(b.numbers.map((c) => c.n)).size !== 100) bad ||= 'cell list is not 100 distinct numbers';
      if (b.numbers.some((c) => c.s !== 'free' && c.s !== 'taken')) bad ||= 'a reader saw a cell that is neither free nor taken (they hold nothing)';
      if (b.numbers.some((c) => (c.s === 'free') !== (c.c === 0))) bad ||= 'a cell\'s state disagrees with its count';
      const k = idx + ':' + b.id; if (last[k] && (b.rev < last[k].rev || b.taken < last[k].taken)) bad ||= 'a reader saw a board go backwards';
      last[k] = { rev: b.rev, taken: b.taken }; seenTaken.add(b.taken);
    }
    if (s.rights.earned !== 0 || s.rights.used !== 0 || s.rights.remaining !== 0) bad ||= 'readers without rights saw rights';
    const stateTotal = s.boards.reduce((a, b) => a + b.taken, 0); if (stateTotal < 0 || stateTotal > 20) bad ||= 'taken out of range';
  }
  check(`5. ${snaps.length} snapshots read during the burst are all internally consistent (revision, taken and every cell agree; nothing goes backwards)`, snaps.length > 0 && bad === '', bad);
  check('5. the readers really saw the boards fill up (more than one distinct state)', seenTaken.size > 1, `${[...seenTaken].sort((a, b) => a - b).join(',')}`);
  const fin = (await q(w, `select count(*) from public.rw_selections where status = 'confirmed'`))[0].count;
  check('5. at the end all 20 numbers are held and the boards add up (20)', Number(fin) === 20);
  await db.close();
}

// ===================================================================================================================== 6
// Lock order: every path takes the customer's advisory lock (the one settle takes), THEN the board rows, THEN the entitlement rows. The mix below used to be the
// recipe for a deadlock: settles and a Super Admin's review resolution (customer lock -> right -> board) against claims, releases, resets and the sweep of lapsed
// holds (board -> right). Postgres aborts one side of a deadlock with 40P01; this scenario must never see one.
const deadlocks = (rs) => rs.filter((r) => !ok(r) && (sqlstate(r) === '40P01' || /deadlock/i.test(msg(r)))).length;
const settle = (uid) => `select public.rw_settle_profile('${uid}')`;
const entOf = async (w, selId) => (await q(w, `select id from public.rw_entitlements where used_selection_id = '${selId}'`))[0].id;
const selOf = async (w, uid, number, board) => (await q(w, `select id from public.rw_selections where profile_id = '${uid}' and number = ${number} and board_id = '${board}' and status in ('reserved','confirmed')`))[0].id;
const invariants = async (w, event) => {
  const n = async (s) => Number((await q(w, s))[0].n);
  const bad = [];
  if (await n(`select count(*) n from (select board_id, number from public.rw_selections where status in ('reserved','confirmed') group by 1, 2 having count(*) > 1 and bool_or(exclusive)) x`)) bad.push('a number is held twice');
  if (await n(`select count(*) n from public.rw_entitlements e where e.status = 'used' and not exists (select 1 from public.rw_selections s where s.id = e.used_selection_id and s.entitlement_id = e.id and s.status in ('reserved','confirmed'))`)) bad.push('a used right has no active selection');
  if (await n(`select count(*) n from public.rw_selections s join public.rw_entitlements e on e.id = s.entitlement_id where s.status in ('reserved','confirmed') and (e.status <> 'used' or e.used_selection_id is distinct from s.id)`)) bad.push('an active selection whose right is not used by it');
  if (await n(`select count(*) n from (select entitlement_id from public.rw_selections where status in ('reserved','confirmed') group by 1 having count(*) > 1) x`)) bad.push('a right backs two active selections');
  if (await n(`select count(*) n from public.rw_board_resets r where r.affected <> (select count(*) from public.rw_selections s where s.reset_id = r.id)`)) bad.push('a reset record miscounts');
  return bad;
};
if (want("6")) {
  const ROUNDS = 8;
  let bad = '', dl = 0, outcomes = {};
  for (let round = 0; round < ROUNDS; round++) {
    const w = await world(8, { rightsEach: 0 });
    const { db, people: P, boards } = w;
    const [A] = P;
    await w.giveRights(A, 6);
    for (const uid of P.slice(1, 6)) await w.giveRights(uid, 2);
    await db.parallel([1, 2, 3].map((n, i) => as(A, claim(w, boards[1].id, n, `r6-${round}-A-pre-${i}-key`))));
    await db.parallel([as(P[1], claim(w, boards[2].id, 10, `r6-${round}-B-pre-key`)), as(P[2], claim(w, boards[2].id, 11, `r6-${round}-C-pre-key`))]);
    const a1 = await selOf(w, A, 1, boards[1].id), a2 = await selOf(w, A, 2, boards[1].id), entA1 = await entOf(w, a1);
    await q(w, `update public.rw_entitlements set needs_review = true, review_since = now() where id = '${entA1}'`);          // A's first number: its bill was taken back
    const sqls = [];
    for (let i = 0; i < 6; i++) sqls.push(jit(settle(A)));
    sqls.push(jit(settle(P[1])), jit(settle(P[2])));
    for (let i = 0; i < 3; i++) sqls.push(as(A, jit(claim(w, boards[3].id, 20 + i, `r6-${round}-A-race-${i}-key`))));
    for (let i = 3; i < 6; i++) sqls.push(as(P[i], jit(claim(w, boards[1].id, 30 + i, `r6-${round}-P${i}-race-key`))));
    sqls.push(as(SUPER, jit(`select public.rw_admin_resolve_review('${entA1}', 'release', 'race: the bill was reversed')`)));
    sqls.push(as(SUPER, jit(`select public.rw_release_selection('${a2}', 'race: release while the customer is settling')`)));
    sqls.push(as(SUPER, jit(`select public.rw_board_reset('${boards[2].id}', 'race: reset while its owners settle', true, '${boards[2].name}')`)));
    const rs = await db.parallel(sqls);
    dl += deadlocks(rs);
    for (const r of rs) { const k = ok(r) ? 'ok' : msg(r).split(/[:\n]/)[0]; outcomes[k] = (outcomes[k] || 0) + 1; }
    const unexpected = rs.filter((r) => !ok(r) && !/^(NUMBER_TAKEN|NO_ENTITLEMENT|NOT_FOUND)/.test(msg(r)));
    if (unexpected.length) bad ||= `round ${round}: ${show(tally(unexpected))}`;
    const inv = await invariants(w, w.event);
    if (inv.length) bad ||= `round ${round}: ${inv.join('; ')}`;
    const st = (await q(w, `select (select status from public.rw_entitlements where id = '${entA1}') as e1, (select status from public.rw_selections where id = '${a1}') as s1, (select status from public.rw_selections where id = '${a2}') as s2`))[0];
    if (st.e1 !== 'revoked' || st.s1 !== 'released') bad ||= `round ${round}: the review "release" left right=${st.e1}, selection=${st.s1}`;
    if (st.s2 !== 'released') bad ||= `round ${round}: the admin release left selection=${st.s2}`;
    await db.close();
  }
  check(`6a. ${ROUNDS} rounds of settles + claims + a review "release" + an admin release + a board reset at once: no deadlock (40P01), nothing unexpected`, dl === 0 && bad === '', `deadlocks=${dl} ${bad} outcomes ${JSON.stringify(outcomes)}`);
  console.log(`      (info) outcomes over all rounds: ${JSON.stringify(outcomes)}`);
}
if (want("6")) {
  const ROUNDS = 8;
  let bad = '', dl = 0, outcomes = {};
  for (let round = 0; round < ROUNDS; round++) {
    const w = await world(8, { hold: 10, rightsEach: 2 });
    const { db, people: P, boards } = w;
    await db.parallel(P.slice(0, 4).map((uid, i) => as(uid, claim(w, boards[1].id, i + 1, `r6b-${round}-pre-${i}-key`))));              // four holds on board A
    const holds = []; for (let i = 0; i < 4; i++) holds.push(await selOf(w, P[i], i + 1, boards[1].id));
    const entP3 = await entOf(w, holds[2]);
    await q(w, `update public.rw_selections set expires_at = now() - interval '1 minute' where id in ('${holds[2]}', '${holds[3]}')`);   // the holds of P3 and P4 lapse
    await q(w, `update public.rw_entitlements set needs_review = true, review_since = now() where id = '${entP3}'`);                      // and P3's bill was taken back meanwhile
    const sqls = [
      as(P[0], jit(`select public.rw_confirm_selection('${holds[0]}')`)), as(P[1], jit(`select public.rw_confirm_selection('${holds[1]}')`)), as(P[2], jit(`select public.rw_confirm_selection('${holds[2]}')`)),
      as(SUPER, jit(`select public.rw_admin_resolve_review('${entP3}', 'release', 'race: bill reversed while the hold ran out')`)),
      as(P[4], jit(claim(w, boards[1].id, 3, `r6b-${round}-P4-key`))), as(P[5], jit(claim(w, boards[1].id, 4, `r6b-${round}-P5-key`))),
      as(SUPER, jit(`select public.rw_sweep_holds('${w.event}')`)),
      ...P.slice(0, 4).flatMap((uid) => [jit(settle(uid)), jit(settle(uid))]),
    ];
    const rs = await db.parallel(sqls);
    dl += deadlocks(rs);
    for (const r of rs) { const k = ok(r) ? 'ok' : msg(r).split(/[:\n]/)[0]; outcomes[k] = (outcomes[k] || 0) + 1; }
    const unexpected = rs.filter((r) => !ok(r) && !/^(HOLD_EXPIRED|NOT_FOUND|NUMBER_TAKEN)/.test(msg(r)));
    if (unexpected.length) bad ||= `round ${round}: ${show(tally(unexpected))}`;
    // the owner's late confirm of a lapsed hold: HOLD_EXPIRED, or NOT_FOUND when the Super Admin's review release freed the number first (it is not held any more); never success
    if (!rs[2] || ok(rs[2]) || !/^(HOLD_EXPIRED|NOT_FOUND)/.test(msg(rs[2]))) bad ||= `round ${round}: confirming a lapsed hold said ${ok(rs[2]) ? 'ok' : msg(rs[2])}`;
    if (!ok(rs[0]) || !ok(rs[1])) bad ||= `round ${round}: confirming a valid hold failed: ${[rs[0], rs[1]].map((r) => (ok(r) ? 'ok' : msg(r))).join(' | ')}`;
    const inv = await invariants(w, w.event);
    if (inv.length) bad ||= `round ${round}: ${inv.join('; ')}`;
    const st = (await q(w, `select (select status from public.rw_entitlements where id = '${entP3}') as e3, (select status from public.rw_selections where id = '${holds[2]}') as s3`))[0];
    if (st.e3 !== 'revoked' || !['released', 'expired'].includes(st.s3)) bad ||= `round ${round}: P3's flagged right ended ${st.e3} / selection ${st.s3}`;
    await db.close();
  }
  check(`6b. ${ROUNDS} rounds of confirms + settles + claims that sweep lapsed holds + a review "release" of a lapsed hold + a staff sweep at once: no deadlock (40P01), valid holds confirm, the lapsed one never confirms (HOLD_EXPIRED, or NOT_FOUND if staff freed it first), the flagged right ends revoked`, dl === 0 && bad === '', `deadlocks=${dl} ${bad} outcomes ${JSON.stringify(outcomes)}`);
  console.log(`      (info) outcomes over all rounds: ${JSON.stringify(outcomes)}`);
}

// ===================================================================================================================== 7
// A REAL payment reversal: the customer's bill of 900 was paid through the finance functions and earned 3 rights, two of them are on numbers. Now the payment is reversed (the
// finance trigger runs settle for that customer), a second bill is paid, and the customer claims and settles at the same time; another customer goes for the held numbers.
if (want('7')) {
  const ROUNDS = 6;
  let bad = '', dl = 0, outcomes = {}, deferredTriggers = 0, healedRounds = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const w = await world(3, { rightsEach: 0 });
    const { db, people: [P, Q], boards } = w;
    await w.giveRights(Q, 2);
    await db.query('create sequence public.zz_order_seq');
    await db.query(`create function public.zz_mk_order(p_profile uuid, p_amount numeric) returns uuid language plpgsql as $f$
      declare fin uuid; inv uuid; oid uuid := gen_random_uuid(); n bigint := nextval('public.zz_order_seq'); ono text; sku text;
      begin
        ono := 'SO-T-' || lpad(n::text, 6, '0'); select sku_code into sku from public.sku_registry where sku_category = 'FG' and status = 'active' order by sku_code limit 1;
        select id into fin from public.finance_customers where profile_id = p_profile;
        if fin is null then insert into public.finance_customers (code, name, profile_id) values ('T-' || substr(replace(p_profile::text, '-', ''), 1, 12), 'Test ' || substr(p_profile::text, 1, 4), p_profile) returning id into fin; end if;
        insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref) values ('INV-T-' || lpad(n::text, 6, '0'), fin, current_date, current_date + 30, p_amount, 'Test order ' || ono, ono) returning id into inv;
        insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone, subtotal, shipping_fee, total, invoice_id)
          values (oid, ono, p_profile, fin, 'test-key-' || lpad(n::text, 8, '0'), 'x', 'pickup', 'Test', '0811111111', p_amount, 0, p_amount, inv);
        insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total) values (oid, 1, sku, 'Test ' || sku, 'pcs', p_amount, 1, p_amount);
        return oid;
      end $f$`);
    const mk = async (amount) => { const [{ id }] = await q(w, `select public.zz_mk_order('${P}', ${amount}) as id`); const [{ invoice_id }] = await q(w, `select invoice_id from public.shop_orders where id = '${id}'`); return { id, inv: invoice_id }; };
    const payStmt = (o, amount) => `select public.finance_post_evidence((public.finance_record_payment('${o.inv}', 'transfer', ${amount}, now(), 'REF${round}${o.id.replace(/-/g, '').slice(0, 12)}', null, 'race payment') ->> 'evidence_id')::uuid, null)`;
    const A = await mk(900), B = await mk(300);
    const paidA = await db.parallel([as(SUPER, payStmt(A, 900))]);
    if (!ok(paidA[0])) { bad ||= `round ${round}: paying bill A failed: ${msg(paidA[0])}`; await db.close(); continue; }
    const earned = Number((await q(w, `select count(*) n from public.rw_entitlements where profile_id = '${P}' and source_order_id = '${A.id}' and status = 'available'`))[0].n);
    if (earned !== 3) bad ||= `round ${round}: the paid bill of 900 earned ${earned} rights, expected 3`;
    await db.parallel([1, 2].map((n) => as(P, claim(w, boards[1].id, n, `r7-${round}-pre-${n}-key`))));                                     // two of them go on numbers
    const [{ id: receiptA }] = await q(w, `select id from public.finance_receipts where invoice_id = '${A.inv}' and status = 'posted'`);
    const sqls = [
      as(SUPER, jit(`select public.finance_reverse_receipt('${receiptA}', 'race: the payment is reversed')`)),
      as(SUPER, jit(payStmt(B, 300))),
      ...[0, 1].map((i) => as(P, jit(claim(w, boards[2].id, 5 + i, `r7-${round}-P-race-${i}-key`)))),
      ...[0, 1, 2, 3].map(() => jit(settle(P))),
      as(Q, jit(claim(w, boards[1].id, 1, `r7-${round}-Q-race-key`))),
    ];
    const rs = await db.parallel(sqls);
    dl += deadlocks(rs);
    for (const r of rs) { const k = ok(r) ? 'ok' : msg(r).split(/[:\n]/)[0]; outcomes[k] = (outcomes[k] || 0) + 1; }
    if (!ok(rs[0])) bad ||= `round ${round}: the reversal failed: ${msg(rs[0])}`;
    if (!ok(rs[1])) bad ||= `round ${round}: the second payment failed: ${msg(rs[1])}`;
    const unexpected = rs.filter((r) => !ok(r) && !/^(NO_ENTITLEMENT|NUMBER_TAKEN)/.test(msg(r)));
    if (unexpected.length) bad ||= `round ${round}: ${show(tally(unexpected))}`;
    // The core's settle TRIGGERS wait at most 400 ms for the customer lock and then give up, log a 'settle_error' (55P03 lock timeout) and let the payment through: a payment
    // never queues. In a burst like this one a trigger may therefore be deferred; the next settle (a read of the rewards, a claim, rw_admin_resettle) heals it. So what must hold:
    // every divergence is explained by a logged lock timeout, ONE settle heals it completely, and a further settle changes nothing.
    const healed = await db.parallel([settle(P), settle(P)]);
    const changed = healed.map((r) => (ok(r) ? Number(Object.values(r.value[0])[0]) : -1));
    const cnt = async (s) => Number((await q(w, s))[0].n);
    const timeouts = await cnt(`select count(*) n from public.rw_events_log where action = 'settle_error' and detail ->> 'message' like '%lock timeout%'`);
    const otherErrors = await cnt(`select count(*) n from public.rw_events_log where action = 'settle_error' and detail ->> 'message' not like '%lock timeout%'`);
    if (changed.some((c) => c < 0)) bad ||= `round ${round}: a healing settle failed: ${show(tally(healed))}`;
    if (otherErrors) bad ||= `round ${round}: a settle failed for another reason than the lock timeout: ${JSON.stringify(await q(w, "select detail ->> 'message' as m from public.rw_events_log where action = 'settle_error'"))}`;
    if (changed.reduce((a, b) => a + Math.max(b, 0), 0) > 0 && timeouts === 0) bad ||= `round ${round}: the state was NOT settled after the race and no settle_error explains it (rows changed ${changed.join(',')})`;
    deferredTriggers += timeouts; if (changed.some((c) => c > 0)) healedRounds++;
    const again = await db.parallel([settle(P), settle(P)]);
    if (again.some((r) => !ok(r) || Number(Object.values(r.value[0])[0]) !== 0)) bad ||= `round ${round}: settle does not converge: a second settle still changed rows`;
    const rows = await q(w, `select source_order_id, status, needs_review from public.rw_entitlements where profile_id = '${P}'`);
    const ofA = rows.filter((r) => r.source_order_id === A.id), ofB = rows.filter((r) => r.source_order_id === B.id);
    if (!ofA.every((r) => r.status === 'revoked' || (r.status === 'used' && r.needs_review))) bad ||= `round ${round}: a right of the reversed bill is still counted: ${JSON.stringify(ofA)}`;
    if (ofB.filter((r) => r.status !== 'revoked').length !== 1) bad ||= `round ${round}: the second bill should count exactly one right: ${JSON.stringify(ofB)}`;
    const inv = await invariants(w, w.event);
    if (inv.length) bad ||= `round ${round}: ${inv.join('; ')}`;
    await db.close();
  }
  check(`7. ${ROUNDS} rounds of a real payment reversal + a second payment + the customer's claims and settles + a rival claim at once: no deadlock (40P01), every unsettled leftover is explained by a logged trigger lock timeout, one settle heals it and the next changes nothing, the reversed bill's rights end revoked or flagged, the second bill counts one right`, dl === 0 && bad === '', `deadlocks=${dl} ${bad} outcomes ${JSON.stringify(outcomes)}`);
  console.log(`      (info) outcomes over all rounds: ${JSON.stringify(outcomes)}; deferred trigger-settles (lock timeouts) ${deferredTriggers}, rounds that needed the healing settle ${healedRounds}`);
}

// 7b. Deterministic: the reversal's trigger-settle is deferred (another transaction holds the customer lock for 1.5 s, the trigger gives up after 400 ms), so the reversed bill's
// UNUSED right is still 'available' when the payment has already been reversed. A claim settles FIRST, so it can never spend that right.
if (want('7')) {
  const w = await world(2, { rightsEach: 0 });
  const { db, people: [P], boards } = w;
  await db.query('create sequence public.zz_order_seq');
  await db.query(`create function public.zz_mk_order(p_profile uuid, p_amount numeric) returns uuid language plpgsql as $f$
    declare fin uuid; inv uuid; oid uuid := gen_random_uuid(); n bigint := nextval('public.zz_order_seq'); ono text; sku text;
    begin
      ono := 'SO-T-' || lpad(n::text, 6, '0'); select sku_code into sku from public.sku_registry where sku_category = 'FG' and status = 'active' order by sku_code limit 1;
      insert into public.finance_customers (code, name, profile_id) values ('T-' || substr(replace(p_profile::text, '-', ''), 1, 12), 'Test ' || substr(p_profile::text, 1, 4), p_profile) returning id into fin;
      insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref) values ('INV-T-' || lpad(n::text, 6, '0'), fin, current_date, current_date + 30, p_amount, 'Test order ' || ono, ono) returning id into inv;
      insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone, subtotal, shipping_fee, total, invoice_id)
        values (oid, ono, p_profile, fin, 'test-key-' || lpad(n::text, 8, '0'), 'x', 'pickup', 'Test', '0811111111', p_amount, 0, p_amount, inv);
      insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total) values (oid, 1, sku, 'Test ' || sku, 'pcs', p_amount, 1, p_amount);
      return oid;
    end $f$`);
  const [{ id: oid }] = await q(w, `select public.zz_mk_order('${P}', 900) as id`);
  const [{ invoice_id }] = await q(w, `select invoice_id from public.shop_orders where id = '${oid}'`);
  const paid = await db.parallel([as(SUPER, `select public.finance_post_evidence((public.finance_record_payment('${invoice_id}', 'transfer', 900, now(), 'REF7B', null, 'payment') ->> 'evidence_id')::uuid, null)`)]);
  const [{ id: receipt }] = await q(w, `select id from public.finance_receipts where invoice_id = '${invoice_id}' and status = 'posted'`);
  await db.parallel([as(P, claim(w, boards[1].id, 1, 'r7b-first-claim-key'))]);                                  // one of the 3 rights goes on a number
  const lockKey = `hashtextextended('rw:' || '${P}', 0)`;
  const held = await db.parallel([
    `select pg_advisory_lock(${lockKey}); select pg_sleep(1.5); select pg_advisory_unlock(${lockKey})`,         // another transaction keeps the customer lock for 1.5 s ...
    as(SUPER, `select pg_sleep(0.3); select public.finance_reverse_receipt('${receipt}', 'reversal while the customer lock is busy')`),  // ... so the reversal's settle trigger gives up after 400 ms
  ]);
  const st = (await q(w, `select count(*) filter (where status = 'available') avail, count(*) filter (where status = 'used') used, count(*) filter (where status = 'revoked') revoked from public.rw_entitlements where profile_id = '${P}'`))[0];
  const timedOut = Number((await q(w, `select count(*) n from public.rw_events_log where action = 'settle_error' and detail ->> 'message' like '%lock timeout%'`))[0].n);
  check('7b. setup: the payment was reversed while the customer lock was busy, the trigger gave up (logged lock timeout) and the reversed bill still shows 2 unused rights', ok(paid[0]) && held.slice(1).every(ok) && timedOut >= 1 && Number(st.avail) === 2, JSON.stringify({ st, timedOut, held: held.map((r) => (ok(r) ? 'ok' : msg(r))) }));
  const late = await db.parallel([as(P, claim(w, boards[1].id, 2, 'r7b-late-claim-key'))]);
  check('7b. the next claim settles FIRST: the reversed bill\'s unused rights are taken back and it is refused with NO_ENTITLEMENT (a reversed payment cannot be spent)', !ok(late[0]) && /^NO_ENTITLEMENT/.test(msg(late[0])), ok(late[0]) ? 'the claim succeeded: a reversed bill\'s pick was spent' : msg(late[0]));
  // The refused claim raised, so its own settle was rolled back with it: the stored rows are still stale. That is safe (every claim settles first, so the stale right can never be
  // spent, however often it is tried) until a call that COMMITS a settle heals them: rw_my_rewards (what the customer's Account page runs), a payment trigger, rw_admin_resettle.
  const again2 = await db.parallel([as(P, claim(w, boards[1].id, 3, 'r7b-late-claim-2-key'))]);
  check('7b. a second attempt is refused as well (the stale right is never spendable)', !ok(again2[0]) && /^NO_ENTITLEMENT/.test(msg(again2[0])), ok(again2[0]) ? 'spent' : msg(again2[0]));
  const stale = (await q(w, `select count(*) filter (where status = 'available') avail from public.rw_entitlements where profile_id = '${P}'`))[0];
  await db.parallel([as(P, 'select public.rw_my_rewards()')]);
  const after = (await q(w, `select count(*) filter (where status = 'available') avail, count(*) filter (where status = 'used' and needs_review) flagged, count(*) filter (where status = 'revoked') revoked from public.rw_entitlements where profile_id = '${P}'`))[0];
  check('7b. rw_my_rewards commits the heal: 0 available, the right already on a number is flagged for review (number untouched), 2 revoked', Number(stale.avail) === 2 && Number(after.avail) === 0 && Number(after.flagged) === 1 && Number(after.revoked) === 2, JSON.stringify({ stale, after }));
  await db.close();
}

console.log(`\n${total - failed} of ${total} boards concurrency checks passed${failed ? '  (' + failed + ' FAILED)' : ''}`);
process.exitCode = failed ? 1 : 0;
