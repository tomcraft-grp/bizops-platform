// REAL concurrency test of "approve & post" and the bank ledger (20261128160000_expense_bank_posting.sql) on the LOCAL PostgreSQL only
// (scripts/local-pg: stubs + every migration + invented seed; it never connects to the Supabase project). Each request is its own connection
// and transaction, all released at the same instant:
//   1. 10 sessions approve & post the SAME bank-transfer expense            -> posted once, ONE bank movement, ONE queued journal, balance -2,500 once
//   2. 12 sessions post 12 DIFFERENT transfers from the same bank account   -> all posted, balance = opening - sum, the before/after chain is unbroken
//   3. 6 sessions reverse the same posted expense                           -> reversed once, the money comes back once
//   4. bulk runs with overlapping sets in different orders                  -> every expense posted exactly once, no movement twice, ledger = balance
//   LOCAL_PG_HOME=<scratch with embedded-postgres + pg> node scripts/local-pg/expense-bank-concurrency.mjs
// On 2026-11-28 the local template could not build the newest migrations (pg_net is missing locally; customer_payment_policy's live-definition guard
// trips on the local chain), none of which this migration depends on. It passed 14/14 with:
//   LOCAL_PG_SKIP="line_order_notifications,line_multi_link,line_card_map,preorders,delivery_pin,backoffice_access,customer_payment_policy,wallet_deposit_qr,points_transfer"
import { withRunDb, ok, msg, check } from './concurrency-lib.mjs';

await withRunDb(async (db) => {
  const [{ s }] = await db.query("select id::text s from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1");
  const [{ scb }] = await db.query("select id::text scb from public.finance_bank_accounts where code = 'SCB'");
  const [{ cat }] = await db.query("select id::text cat from public.expense_categories where code = 'office_supplies'");
  const as = (sql) => `select set_config('request.jwt.claims', '${JSON.stringify({ sub: s, role: 'authenticated' })}', true); ${sql}`;
  const save = async (desc, amount) => (await db.query(as(`select (public.expense_save(null, (now() at time zone 'Asia/Bangkok')::date, '${cat}', '${desc}', ${amount}, 'none', 'bank_transfer', null, null, null, null, null, '${scb}')).id::text id`)))[0].id;
  const bal = async () => Number((await db.query(`select balance from public.finance_bank_balances where bank_account_id = '${scb}'`))[0].balance);
  const count = async (sql) => Number((await db.query(sql))[0].n);
  await db.query(as(`select public.finance_bank_opening('${scb}', 100000, (now() at time zone 'Asia/Bangkok')::date - 1, 'test opening')`));

  // 1. the same expense, 10 times at once
  const one = await save('Concurrency same', 2500);
  const r1 = await db.parallel(Array.from({ length: 10 }, () => as(`select public.expense_post_bulk(array['${one}'::uuid], 'race-${Math.random()}') r`)));
  const res1 = r1.filter(ok).map((r) => r.value[0].r);
  check('1. all 10 requests answer without an error', r1.every(ok), r1.filter((r) => !ok(r)).map(msg).join(' | '));
  check('1. exactly one of them posted it, the other 9 report it as already posted', res1.filter((x) => x.posted.length === 1).length === 1 && res1.filter((x) => x.skipped.length === 1).length === 9,
    JSON.stringify(res1.map((x) => [x.posted.length, x.skipped.length, x.failed.length])));
  check('1. one bank movement, one queued journal', await count(`select count(*) n from public.finance_bank_transactions where ref_id = '${one}'`) === 1 && await count(`select count(*) n from public.finance_gl_queue where ref_id = '${one}'`) === 1);
  check('1. the balance moved once: 100,000 -> 97,500', await bal() === 97500, String(await bal()));

  // 2. different expenses from the same account, all at once
  const many = [];
  for (let i = 0; i < 12; i++) many.push(await save(`Concurrency many ${i}`, 100 + i));
  const sum = many.reduce((x, _, i) => x + 100 + i, 0);
  const r2 = await db.parallel(many.map((id) => as(`select public.expense_post_bulk(array['${id}'::uuid]) r`)));
  check('2. all 12 posted', r2.every(ok) && r2.every((r) => r.value[0].r.posted.length === 1), r2.map((r) => (ok(r) ? JSON.stringify(r.value[0].r.failed) : msg(r))).join(' | '));
  check('2. balance = 97,500 - the 12 amounts', await bal() === 97500 - sum, `${await bal()} vs ${97500 - sum}`);
  const rec = (await db.query(as('select public.finance_bank_reconcile() r')))[0].r.find((x) => x.code === 'SCB');
  check('2. the balance equals the ledger and the before/after chain is unbroken', rec.ok && rec.chain_breaks === 0, JSON.stringify(rec));

  // 3. the same reversal, 6 times at once
  const r3 = await db.parallel(Array.from({ length: 6 }, () => as(`select public.expense_reverse('${one}', 'Concurrent reversal test') r`)));
  check('3. exactly one reversal succeeds, the others are refused as already reversed', r3.filter(ok).length === 1 && r3.filter((r) => !ok(r)).every((r) => /already reversed|Only posted/.test(msg(r))), r3.map((r) => (ok(r) ? 'ok' : msg(r))).join(' | '));
  check('3. the money came back once (+2,500)', await bal() === 100000 - sum, `${await bal()} vs ${100000 - sum}`);
  check('3. one reversal movement', await count(`select count(*) n from public.finance_bank_transactions where ref_id = '${one}' and txn_type = 'EXPENSE_REVERSAL'`) === 1);

  // 4. overlapping bulk runs
  const set = [];
  for (let i = 0; i < 8; i++) set.push(await save(`Concurrency overlap ${i}`, 50));
  const b0 = await bal();
  const runs = [set, [...set].reverse(), set.slice(2, 7), [set[0], set[7], set[3]], set.slice().sort()];
  const r4 = await db.parallel(runs.map((ids) => as(`select public.expense_post_bulk(array[${ids.map((x) => `'${x}'::uuid`).join(',')}]) r`)));
  const posted = r4.filter(ok).flatMap((r) => r.value[0].r.posted.map((p) => p.id));
  const failedRetry = r4.filter(ok).flatMap((r) => r.value[0].r.failed);
  check('4. no request crashed', r4.every(ok), r4.filter((r) => !ok(r)).map(msg).join(' | '));
  check('4. each expense was posted by exactly one run', posted.length === 8 && new Set(posted).size === 8 || (failedRetry.length > 0 && new Set(posted).size === posted.length), `posted ${posted.length}, distinct ${new Set(posted).size}, failed ${JSON.stringify(failedRetry)}`);
  check('4. one movement per posted expense, and the balance fell by exactly that', await count(`select count(*) n from public.finance_bank_transactions where ref_id in (${set.map((x) => `'${x}'`).join(',')})`) === new Set(posted).size
    && await bal() === b0 - 50 * new Set(posted).size, `${await bal()} vs ${b0 - 50 * new Set(posted).size}`);
  const rec4 = (await db.query(as('select public.finance_bank_reconcile() r')))[0].r.find((x) => x.code === 'SCB');
  check('4. ledger = balance, chain unbroken, after everything', rec4.ok && rec4.chain_breaks === 0, JSON.stringify(rec4));
});
