// Concurrency test of the preorder slot rule, in a THROW-AWAY schema (never the real orders or settings).
// It builds minimal copies of the tables and the exact source of the slot functions from the migration FILE in schema ct_pre_<random>, then fires parallel requests,
// each its own database connection and transaction ("check the slot, then insert the order", exactly what shop_place_order does):
//   1. 12 parallel orders for ONE slot with room for 3              -> exactly 3 commit, 9 are refused SLOT_FULL: never an over-booking
//   2. 12 parallel orders spread over 4 slots (room for 3 each)    -> all 12 commit (different slots of one day still queue on the day lock, but all fit)
//   3. 10 parallel 3-unit orders for a slot with 8 units           -> exactly 2 commit (6 units), the rest SLOT_UNITS_FULL
//   4. CONTROL: the same race as 1 with the day lock removed       -> the test must see an over-booking, proving it can fail
// Needs a Supabase management token in ~/.supabase-token. The schema is dropped at the end, also on failure.
//   node scripts/preorder-concurrency-test.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const REF = 'hlvravynjalculvplrxc';
const token = readFileSync(`${homedir()}/.supabase-token`, 'utf8').trim();
const S = 'ct_pre_' + randomBytes(4).toString('hex');

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
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  => ' + detail}`); if (!cond) failed++; };
const refusals = (rs) => rs.filter((r) => r.status === 'rejected').map((r) => (/(SLOT_[A-Z_]+|DAY_UNITS_FULL)/.exec(String(r.reason.message)) ?? ['OTHER: ' + r.reason.message])[0]);

try {
  const mig = readFileSync(new URL('../supabase/migrations/20261128100000_preorders.sql', import.meta.url), 'utf8');
  const grab = (name) => {
    const i = mig.search(new RegExp(`create or replace function public\\.${name}\\(`));
    if (i < 0) throw new Error('not found: ' + name);
    const rest = mig.slice(i);
    return rest.slice(0, rest.indexOf('end $$;') + 7);
  };
  const toSchema = (t) => t.replace(/public\./g, S + '.').replace(/set search_path = public/g, `set search_path = ${S}, pg_catalog`);
  await sql(`create schema ${S};
    create table ${S}.preorder_settings (id boolean primary key default true, enabled boolean not null default true, slot_minutes int not null default 30, lead_minutes int not null default 0,
      max_advance_days int not null default 14, weekly_hours jsonb not null, max_orders_per_slot int not null default 3, max_units_per_slot int, max_units_per_day int);
    create table ${S}.preorder_days (day date primary key, kind text not null, open_time time, close_time time, reason text);
    create table ${S}.shop_orders (id uuid primary key default gen_random_uuid(), order_type text not null default 'preorder', status text not null default 'new', pickup_at timestamptz not null);
    create table ${S}.shop_order_items (order_id uuid not null, line_no int not null default 1, qty int not null);
    insert into ${S}.preorder_settings (id, weekly_hours) values (true, (select jsonb_agg(jsonb_build_object('dow', d, 'closed', false, 'open', '09:00', 'close', '18:00')) from generate_series(0, 6) d));`);
  for (const f of ['preorder_local_day', 'preorder_hours', 'preorder_grid', 'preorder_load', 'preorder_day_units', 'preorder_check_slot']) await sql(toSchema(grab(f)));
  const slot = (hhmm) => `(((now() at time zone 'Asia/Bangkok')::date + 2 + '${hhmm}'::time) at time zone 'Asia/Bangkok')`;
  // what shop_place_order does: the slot rule (takes the day lock), then the insert, in one transaction (a short pause in between makes the race as bad as it can get)
  const place = (hhmm, qty, check = `${S}.preorder_check_slot`) => `do $$ declare o uuid := gen_random_uuid(); begin
    perform ${check}(${slot(hhmm)}, ${qty}, null, false, false);
    perform pg_sleep(0.25);                  -- widen the window between "counted" and "inserted": every unprotected transaction would count before any insert
    insert into ${S}.shop_orders (id, pickup_at) values (o, ${slot(hhmm)}); insert into ${S}.shop_order_items (order_id, qty) values (o, ${qty}); end $$;`;
  const booked = async (hhmm) => Number((await sql(`select count(*) n from ${S}.shop_orders where pickup_at = ${slot(hhmm)}`))[0].n);

  // 1. one slot, room for 3
  let rs = await settle(Array.from({ length: 12 }, () => place('10:00', 1)));
  check('1. 12 parallel orders for a slot with room for 3: exactly 3 booked', (await booked('10:00')) === 3, `booked ${await booked('10:00')}`);
  check('1. the other 9 were told SLOT_FULL', refusals(rs).filter((x) => x === 'SLOT_FULL').length === 9 && rs.filter((r) => r.status === 'fulfilled').length === 3, JSON.stringify(refusals(rs)));

  // 2. four slots
  rs = await settle(Array.from({ length: 12 }, (_, i) => place(['11:00', '11:30', '12:00', '12:30'][i % 4], 1)));
  check('2. 12 parallel orders over 4 slots with room for 3 each: all 12 booked', rs.every((r) => r.status === 'fulfilled'), JSON.stringify(refusals(rs)));
  const per = await Promise.all(['11:00', '11:30', '12:00', '12:30'].map(booked));
  check('2. every slot holds exactly 3', per.every((n) => n === 3), per.join(','));

  // 3. units: 8 per slot, 3-unit orders -> 2 fit (6), a third would make 9
  await sql(`update ${S}.preorder_settings set max_orders_per_slot = 50, max_units_per_slot = 8`);
  rs = await settle(Array.from({ length: 10 }, () => place('14:00', 3)));
  const units = Number((await sql(`select coalesce(sum(i.qty), 0) n from ${S}.shop_orders o join ${S}.shop_order_items i on i.order_id = o.id where o.pickup_at = ${slot('14:00')}`))[0].n);
  check('3. 10 parallel 3-unit orders for 8 units: exactly 2 booked, never more than 8 units', (await booked('14:00')) === 2 && units === 6, `orders ${await booked('14:00')}, units ${units}`);
  check('3. the others were told SLOT_UNITS_FULL', refusals(rs).every((x) => x === 'SLOT_UNITS_FULL') && refusals(rs).length === 8, JSON.stringify(refusals(rs)));

  // 4. control: no day lock -> the same race over-books (proves the test can fail)
  await sql(`update ${S}.preorder_settings set max_orders_per_slot = 3, max_units_per_slot = null`);
  const noLock = toSchema(grab('preorder_check_slot')).replace('preorder_check_slot', 'preorder_check_slot_nolock').replace(/perform pg_advisory_xact_lock\([^;]*;/, 'perform pg_sleep(0.3);');
  await sql(noLock);
  rs = await settle(Array.from({ length: 12 }, () => place('16:00', 1, `${S}.preorder_check_slot_nolock`)));
  const over = await booked('16:00');
  check('4. CONTROL without the lock the race over-books (the test is able to fail)', over > 3, `booked ${over}`);
} catch (e) {
  console.error('ERROR', e.message); failed++;
} finally {
  try { await sql(`drop schema if exists ${S} cascade`); console.log(`(schema ${S} dropped)`); } catch (e) { console.error('could not drop the schema', S, e.message); failed++; }
}
process.exit(failed ? 1 : 0);
