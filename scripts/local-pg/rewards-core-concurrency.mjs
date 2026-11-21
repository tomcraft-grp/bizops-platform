// REAL concurrency checks of the rewards core (migration 20261121100000_rewards_core.sql) on the local throw-away PostgreSQL. Never touches the Supabase project.
//   node scripts/local-pg/rewards-core-concurrency.mjs
// Uses supabase/migrations/20261121100000_rewards_core.sql when it exists (it is then already in the template database), otherwise the work-in-progress copy
// supabase/wip/20261121100000_rewards_core.sql, which is applied to the run database. Everything committed here lives only in that run's database, dropped at the end.
//   C1  10 parallel rw_settle_profile of ONE customer with real work to do      -> exactly the expected rows, one worker did the work, no unique-violation, no deadlock
//   C2  settle x4 + rw_my_rewards x4 + rw_admin_resettle x2 at the same instant -> same: no duplicate right or ledger row, every reader sees the final state
//   C3  a payment REVERSAL racing settles and reads (light and heavy)          -> rights revoked / points taken back exactly once, nothing aborted
//   C4  a PAYMENT racing the same crowd (light and heavy)                       -> exactly the expected rights and points, nothing aborted
//   C5  the customer's settle lock is held by someone else while a payment is posted -> the payment still completes quickly, the failure is logged
//       as settle_error (55P03), and the next read heals it
//   C6  parallel pack creation (same key / different keys), parallel partial rule patches (no lost update), parallel point adjustments (never below zero)
import fs from 'node:fs';
import { withRunDb, ok, msg, sqlstate, check } from './concurrency-lib.mjs';

const FINAL = 'supabase/migrations/20261121100000_rewards_core.sql';
const WIP = 'supabase/wip/20261121100000_rewards_core.sql';
// This script tests the core on its own and uses a made-up event id, so the event-boards migration (which adds the foreign key to rw_events) is left out of its database.
const opts = fs.existsSync(FINAL) ? { skip: ['event_boards'] } : { files: [WIP] };
const EV = '00000000-0000-4000-8000-0000000000e1';                 // the event id of the picks rules (a plain uuid until the event-boards migration exists)

const HELPERS = `
create function public.t_mk_order(p_profile uuid, p_price numeric) returns uuid language plpgsql as $$
declare fin uuid; inv uuid; oid uuid := gen_random_uuid(); sfx text := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
begin
  select id into fin from public.finance_customers where profile_id = p_profile;
  if fin is null then
    insert into public.finance_customers (code, name, profile_id) values ('C-' || substr(replace(p_profile::text, '-', ''), 1, 12), 'Conc ' || substr(p_profile::text, 1, 4), p_profile) returning id into fin;
  end if;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref)
    values ('INV-C-' || sfx, fin, current_date, current_date + 30, p_price, 'Concurrency order', 'SO-C-' || sfx) returning id into inv;
  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone, subtotal, total, invoice_id)
    values (oid, 'SO-C-' || sfx, p_profile, fin, 'conc-key-' || sfx, 'x', 'pickup', 'Conc', '0811111111', p_price, p_price, inv);
  insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total) values (oid, 1, 'FG-000001', 'Conc', 'pcs', p_price, 1, p_price);
  return oid;
end $$;
create function public.t_pay(p_order uuid) returns uuid language plpgsql as $$
declare o public.shop_orders; ev jsonb; rid uuid;
begin
  select * into o from public.shop_orders where id = p_order;
  ev := public.finance_record_payment(o.invoice_id, 'transfer', o.total, now(), 'REF' || replace(gen_random_uuid()::text, '-', ''), null, 'concurrency payment');
  perform public.finance_post_evidence((ev ->> 'evidence_id')::uuid, null);
  select id into rid from public.finance_receipts where invoice_id = o.invoice_id and status = 'posted' order by created_at desc limit 1;
  return rid;
end $$;
grant execute on function public.t_mk_order(uuid, numeric), public.t_pay(uuid) to authenticated;`;

await withRunDb(opts, async (db) => {
  const one = async (sql, params) => (await db.query(sql, params))[0];
  const who = async (role, n) => (await one(`select id from public.profiles where role = $1 and status = 'active' order by created_at offset $2 limit 1`, [role, n])).id;
  const S = await who('SUPER_ADMIN', 0);
  const [A, B, C, D] = [await who('USER', 0), await who('USER', 1), await who('USER', 2), await who('USER', 3)];
  const actAs = async (uid) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.query(HELPERS);
  await actAs(S);                                                          // the admin session now acts as the Super Admin (it stays a superuser)
  const sql = (s) => db.query(s);
  const mkOrder = async (p, price) => (await one(`select public.t_mk_order($1, $2) id`, [p, price])).id;
  const pay = async (oid) => (await one(`select public.t_pay($1) id`, [oid])).id;
  const rule = (o) => sql(`select public.rw_admin_save_rule(null, '${JSON.stringify(o)}'::jsonb)`);
  const settleAll = (p) => `select public.rw_settle_profile('${p}') changed`;
  const myRewards = `select public.rw_my_rewards() doc`;

  await rule({ kind: 'points', name: 'C points per 100', spend_step: 100, reward_amount: 1 });
  await rule({ kind: 'board_pick', name: 'C pick per 300', spend_step: 300, reward_amount: 1, event_id: EV });
  const rows = async (p) => ({
    rights: Number((await one(`select count(*) n from public.rw_entitlements where profile_id = $1 and status in ('available', 'used')`, [p])).n),
    allRights: Number((await one(`select count(*) n from public.rw_entitlements where profile_id = $1`, [p])).n),
    distinct: Number((await one(`select count(distinct (rule_id, source_order_id, seq)) n from public.rw_entitlements where profile_id = $1`, [p])).n),
    ledger: Number((await one(`select count(*) n from public.rw_points_ledger where profile_id = $1`, [p])).n),
    points: Number((await one(`select coalesce(sum(points), 0) n from public.rw_points_ledger where profile_id = $1`, [p])).n),
  });
  const errors = async () => Number((await one(`select count(*) n from public.rw_events_log where action = 'settle_error'`)).n);
  const bad = (rs) => rs.filter((r) => !ok(r)).map((r) => `${sqlstate(r)} ${msg(r)}`).join(' | ');

  // ---------------------------------------------------------------------------------------------- C1
  await sql(`update public.rw_settings set enabled = true, boards_enabled = true`);
  await sql(`update public.rw_settings set enabled = false`);               // the bills are paid while the switch is off: nothing is settled yet
  for (const price of [900, 600, 300, 299]) await pay(await mkOrder(B, price));
  check('C1 setup: nothing settled while off', (await rows(B)).allRights === 0 && (await rows(B)).ledger === 0);
  await sql(`update public.rw_settings set enabled = true`);
  const c1 = await db.parallel(Array.from({ length: 10 }, () => settleAll(B)));
  const changed = c1.filter(ok).map((r) => Number(r.value[0].changed));
  const r1 = await rows(B);
  check('C1 all 10 parallel settles succeed (no unique violation, no deadlock)', c1.every(ok), bad(c1));
  check('C1 exactly one worker did the work (the others found nothing to do)', changed.filter((n) => n > 0).length === 1 && changed.reduce((a, b) => a + b, 0) === 10, changed.join(','));
  check('C1 B has exactly 6 rights (900 -> 3, 600 -> 2, 300 -> 1, 299 -> 0), one row per (rule, bill, place)', r1.rights === 6 && r1.allRights === 6 && r1.distinct === 6, JSON.stringify(r1));
  check('C1 B has exactly 4 ledger rows and 20 points (9 + 6 + 3 + 2)', r1.ledger === 4 && r1.points === 20, JSON.stringify(r1));
  check('C1 one more settle changes nothing', Number((await one(settleAll(B))).changed) === 0);

  // ---------------------------------------------------------------------------------------------- C2
  await sql(`update public.rw_settings set enabled = false`);
  for (const price of [900, 600, 300, 299]) await pay(await mkOrder(C, price));
  await sql(`update public.rw_settings set enabled = true`);
  const mix = [
    ...Array.from({ length: 4 }, () => ({ sql: settleAll(C), as: null })),
    ...Array.from({ length: 4 }, () => ({ sql: myRewards, as: C })),
    ...Array.from({ length: 2 }, () => ({ sql: `select public.rw_admin_resettle('${C}') doc`, as: S })),
  ];
  const c2 = await Promise.all([
    db.parallel(mix.filter((m) => !m.as).map((m) => m.sql)),
    db.parallel(mix.filter((m) => m.as === C).map((m) => m.sql), { as: C }),
    db.parallel(mix.filter((m) => m.as === S).map((m) => m.sql), { as: S }),
  ]);
  const all2 = c2.flat();
  const r2 = await rows(C);
  check('C2 all 10 mixed calls succeed', all2.every(ok), bad(all2));
  check('C2 C has exactly 6 rights and 20 points, no duplicate row', r2.rights === 6 && r2.allRights === 6 && r2.distinct === 6 && r2.ledger === 4 && r2.points === 20, JSON.stringify(r2));
  const seen = c2[1].filter(ok).map((r) => r.value[0].doc.picks[0]?.earned);
  check('C2 every customer read already saw the final state (earned = 6)', seen.length === 4 && seen.every((n) => n === 6), seen.join(','));

  // ---------------------------------------------------------------------------------------------- C3 reversal race / C4 payment race
  // "light" = one settle and one read race the money movement: the trigger's own settle gets the customer's lock within its 400 ms, so the result must be EXACT
  // without any later help. "heavy" = a crowd (3 settles + 2 reads): a trigger that queues behind the crowd for more than 400 ms gives up (logged as settle_error 55P03,
  // by design: a payment must never wait longer than the deadlock timeout) and the NEXT settle/read heals it; the invariant is then "no abort, no duplicate, correct after
  // one more settle". Anything else (23505, 40P01, a wrong final state) fails.
  const rounds = [{ name: 'light', settles: 1, reads: 1 }, { name: 'heavy', settles: 3, reads: 2 }];
  const crowdOf = (first, rd) => Promise.all([
    db.parallel([first], { as: S }),
    db.parallel(Array.from({ length: rd.settles }, () => settleAll(D))),
    db.parallel(Array.from({ length: rd.reads }, () => myRewards), { as: D }),
  ]).then((x) => x.flat());
  const logged = async (since) => (await db.query(`select detail ->> 'sqlstate' as st from public.rw_events_log where action = 'settle_error' and id > $1`, [since])).map((r) => r.st);
  const lastLog = async () => Number((await one(`select coalesce(max(id), 0) n from public.rw_events_log`)).n);
  for (const rd of rounds) {
    // C3 reversal
    const oid = await mkOrder(D, 900);
    const rc = await pay(oid);
    const mark = await lastLog();
    const all = await crowdOf(`select public.finance_reverse_receipt('${rc}', 'race ${rd.name}') doc`, rd);
    const errsSt = await logged(mark);
    const live0 = (await one(`select count(*) filter (where status in ('available', 'used'))::int live, count(*)::int total from public.rw_entitlements where source_order_id = $1`, [oid]));
    const extra = Number((await one(settleAll(D))).changed);
    const live1 = (await one(`select count(*) filter (where status in ('available', 'used'))::int live, count(*)::int total from public.rw_entitlements where source_order_id = $1`, [oid]));
    const net = Number((await one(`select coalesce(sum(points), 0) n from public.rw_points_ledger where order_id = $1`, [oid])).n);
    const exact = live0.live === 0 && net === 0 && extra === 0 && errsSt.length === 0;
    const healed = live1.live === 0 && live1.total === 3 && net === 0 && errsSt.every((s) => s === '55P03');
    check(`C3 ${rd.name}: reversal racing ${rd.settles} settle(s) and ${rd.reads} read(s): every call succeeds, never more than 3 right rows, ends revoked with points net 0`, all.every(ok) && healed, `${bad(all)} live=${live1.live} total=${live1.total} net=${net} errs=${errsSt.join(',')}`);
    if (rd.name === 'light') check('C3 light: the reversal\'s own settle already did it (exact without a later settle, nothing logged)', exact, `live=${live0.live} net=${net} extra=${extra} errs=${errsSt.join(',')}`);
    else console.log(`INFO  C3 heavy: needed a later settle: ${extra > 0 ? 'yes (' + extra + ' rows)' : 'no'}; skipped trigger settles logged: ${errsSt.length}`);
    // C4 payment
    const oid4 = await mkOrder(D, 900);
    const mark4 = await lastLog();
    const all4 = await crowdOf(`select public.t_pay('${oid4}') doc`, rd);
    const errs4 = await logged(mark4);
    const b0 = await one(`select count(*) filter (where status in ('available', 'used'))::int live from public.rw_entitlements where source_order_id = $1`, [oid4]);
    const extra4 = Number((await one(settleAll(D))).changed);
    const b1 = await one(`select count(*) filter (where status in ('available', 'used'))::int live, count(*)::int total, count(distinct seq)::int places from public.rw_entitlements where source_order_id = $1`, [oid4]);
    const earn = await one(`select count(*)::int n, coalesce(sum(points), 0)::int pts from public.rw_points_ledger where order_id = $1`, [oid4]);
    check(`C4 ${rd.name}: payment racing ${rd.settles} settle(s) and ${rd.reads} read(s): the payment succeeds, exactly 3 rights (places 1..3) and one 9-point ledger row`,
      all4.every(ok) && b1.live === 3 && b1.total === 3 && b1.places === 3 && earn.n === 1 && earn.pts === 9 && errs4.every((s) => s === '55P03'), `${bad(all4)} live=${b1.live} total=${b1.total} earn=${earn.n}/${earn.pts} errs=${errs4.join(',')}`);
    if (rd.name === 'light') check('C4 light: exact without a later settle (3 rights at once, nothing logged)', b0.live === 3 && extra4 === 0 && errs4.length === 0, `live=${b0.live} extra=${extra4} errs=${errs4.join(',')}`);
    else console.log(`INFO  C4 heavy: needed a later settle: ${extra4 > 0 ? 'yes (' + extra4 + ' rows)' : 'no'}; skipped trigger settles logged: ${errs4.length}`);
  }

  // ---------------------------------------------------------------------------------------------- C5 the payment is never blocked
  const holder = (await db.connect(1))[0];
  const oid5 = await mkOrder(A, 900);
  await holder.query(`select pg_advisory_lock(hashtextextended('rw:' || $1::text, 0))`, [A]);       // somebody else is "settling" customer A and does not let go
  const errs5 = await errors();
  const [pay5] = await db.parallel([`select public.t_pay('${oid5}') id`], { as: S });
  const rcpt = await one(`select count(*)::int n from public.finance_receipts r join public.shop_orders o on o.invoice_id = r.invoice_id where o.id = $1 and r.status = 'posted'`, [oid5]);
  check('C5 a payment posted while the customer\'s settle lock is held elsewhere still succeeds', ok(pay5) && rcpt.n === 1, bad([pay5]));
  check('C5 ... and does not sit in the lock queue (under 3 s: two 400 ms waits, then it carries on)', pay5.ms < 3000, `${pay5.ms} ms`);
  const lockErr = await one(`select count(*)::int n from public.rw_events_log where action = 'settle_error' and profile_id = $1 and detail ->> 'sqlstate' = '55P03'`, [A]);
  check('C5 the skipped settle was logged as settle_error with SQLSTATE 55P03 (lock not available)', lockErr.n >= 1 && (await errors()) > errs5, `${lockErr.n} logged`);
  check('C5 no right exists yet (nothing was settled)', (await rows(A)).allRights === 0);
  await holder.query('select pg_advisory_unlock_all()');
  const [heal] = await db.parallel([myRewards], { as: A });
  check('C5 the next read of the customer heals it: 3 rights and 9 points', ok(heal) && (await rows(A)).rights === 3 && (await rows(A)).points === 9 && heal.value[0].doc.picks[0].earned === 3, bad([heal]));

  // ---------------------------------------------------------------------------------------------- C6 claim-free parallel checks
  const KEY = '00000000-0000-4000-8000-00000000aa01';
  const packSql = (key, n) => `select public.rw_admin_create_pack('${key}', 'C pack ${n}', 300, '[{"sku_code":"FG-000124","qty":4}]', '{}') pack`;
  const c6a = await db.parallel(Array.from({ length: 6 }, () => packSql(KEY, 0)), { as: S });
  const codes = new Set(c6a.filter(ok).map((r) => r.value[0].pack.pack_sku_code));
  const cnt = await one(`select (select count(*) from public.promo_packs)::int packs, (select count(*) from public.sku_registry where client_ref = $1)::int skus`, [KEY]);
  check('C6 6 parallel creations of the same pack (same key): all succeed, one pack, one SKU row, one code', c6a.every(ok) && codes.size === 1 && cnt.packs === 1 && cnt.skus === 1, bad(c6a) + ' ' + JSON.stringify(cnt));
  const before = Number((await one(`select last_seq n from public.sku_counters where category = 'FG'`)).n);
  const c6b = await db.parallel(Array.from({ length: 5 }, (_, i) => packSql(`00000000-0000-4000-8000-00000000bb0${i}`, i + 1)), { as: S });
  const after = Number((await one(`select last_seq n from public.sku_counters where category = 'FG'`)).n);
  const seqs = c6b.filter(ok).map((r) => Number(r.value[0].pack.pack_sku_code.slice(3))).sort((x, y) => x - y);
  check('C6 5 parallel pack creations with different keys: 5 distinct, consecutive codes, 5 numbers burned', c6b.every(ok) && new Set(seqs).size === 5 && seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1) && after === before + 5, bad(c6b) + ' ' + seqs.join(','));
  // partial patches of ONE rule at the same instant: every key must survive (no lost update)
  const r = (await one(`select public.rw_admin_save_rule(null, '{"kind":"points","name":"C patch me","spend_step":100,"reward_amount":1,"active":true}'::jsonb) r`)).r;
  const patches = [{ name: 'C patched' }, { active: false }, { ends_at: '2099-01-01T00:00:00Z' }, { max_per_order: 5 }, { spend_step: 250 }, { category_codes: ['Puff'] }, { include_packs: true }];
  const c6c = await db.parallel(patches.map((p) => `select public.rw_admin_save_rule('${r.id}', '${JSON.stringify(p)}'::jsonb) r`), { as: S });
  const fin = await one(`select name, active, ends_at is not null as has_end, max_per_order, spend_step::numeric, category_codes, include_packs from public.rw_rules where id = $1`, [r.id]);
  check('C6 7 parallel partial patches of one rule: all succeed and every key is applied (no lost update)', c6c.every(ok) && fin.name === 'C patched' && fin.active === false && fin.has_end && fin.max_per_order === 5 && Number(fin.spend_step) === 250
    && fin.category_codes.join() === 'Puff' && fin.include_packs === true, bad(c6c) + ' ' + JSON.stringify(fin));
  // point adjustments serialise per customer: balances are distinct, and the balance never goes below zero
  const c6d = await db.parallel(Array.from({ length: 5 }, () => `select public.rw_admin_adjust_points('${D}', 10, 'c adjust') bal`), { as: S });
  const bals = c6d.filter(ok).map((x) => Number(x.value[0].bal)).sort((x, y) => x - y);
  const base = (await rows(D)).points;
  check('C6 5 parallel +10 adjustments: each sees the one before it (5 distinct balances in steps of 10)', c6d.every(ok) && new Set(bals).size === 5 && bals.every((b, i) => i === 0 || b === bals[i - 1] + 10) && bals[4] === base, bad(c6d) + ' ' + bals.join(','));
  const bal0 = base;
  const c6e = await db.parallel(Array.from({ length: 5 }, () => `select public.rw_admin_adjust_points('${D}', -${Math.floor(bal0 / 3)}, 'c take') bal`), { as: S });
  const okN = c6e.filter(ok).length;
  const final = (await rows(D)).points;
  check('C6 parallel debits: only as many succeed as the balance allows, the rest fail with LIMIT_REACHED, the balance never goes below zero', okN === 3 && c6e.filter((x) => !ok(x)).every((x) => /LIMIT_REACHED/.test(msg(x))) && final >= 0 && final === bal0 - 3 * Math.floor(bal0 / 3), `${okN} ok, balance ${final} (was ${bal0})`);
});
