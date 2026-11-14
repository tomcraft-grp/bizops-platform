// Concurrency test of the wallet ledger writer, in a THROW-AWAY schema (never the real wallet tables).
// It builds the tables and the exact source of finance_wallet_apply() from the migration FILE in schema ct_wallet_<random> (only the schema
// name changes; no foreign keys, a no-op audit call), then fires parallel requests, each its own database connection and transaction:
//   1. 8 different payments of 300 against a wallet holding 1000  -> exactly 3 succeed, balance 100, never negative
//   2. 6 identical retries (same idempotency key)                  -> exactly 1 debit
//   3. a burst of deposits and spends                              -> ledger sums to the balance, the chain balance_before/after is unbroken
// Needs a Supabase management token in ~/.supabase-token. The schema is dropped at the end, also on failure.
//   node scripts/wallet-concurrency-test.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';

const REF = 'hlvravynjalculvplrxc';
const token = readFileSync(`${homedir()}/.supabase-token`, 'utf8').trim();
const S = 'ct_wallet_' + randomBytes(4).toString('hex');
const cust = randomUUID();

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message ?? JSON.stringify(j));
  return j;
}
const settle = (queries) => Promise.allSettled(queries.map((q) => sql(q)));
const ok = (r) => r.status === 'fulfilled';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  => ' + detail}`); if (!cond) failed++; };

try {
  // the exact source that ships: the two tables and the writer function, taken from the migration file
  const mig = readFileSync(new URL('../supabase/migrations/20261115200000_wallet_payments.sql', import.meta.url), 'utf8');
  const grab = (startRe, endMark) => { const i = mig.search(startRe); if (i < 0) throw new Error('not found: ' + startRe); const rest = mig.slice(i); return rest.slice(0, rest.indexOf(endMark) + endMark.length); };
  const toSchema = (t) => t.replace(/public\./g, S + '.').replace(/\s*references [a-z0-9_.]+ \(id\)( on delete restrict)?/g, '');   // no foreign keys in the throw-away copy
  const ddlWallet = toSchema(grab(/create table if not exists public\.finance_wallets \(/, '\n);'));
  const ddlTxn = toSchema(grab(/create table if not exists public\.finance_wallet_transactions \(/, '\n);'));
  const fnApply = toSchema(grab(/create or replace function public\.finance_wallet_apply\(/, 'end $$;'));
  await sql(`create schema ${S}; ${ddlWallet} ${ddlTxn} create sequence ${S}.finance_wallet_txn_seq;
    create function ${S}.finance_log(text, uuid, text, jsonb) returns void language sql as 'select 1';`);
  await sql(fnApply);
  await sql(`
    create function ${S}.spend(c uuid, amt numeric, k text) returns numeric language sql as $f$
      select balance_after from ${S}.finance_wallet_apply(c, 'INVOICE_PAYMENT', 'debit', amt, k, 'invoice', null, 'T', 'wallet', null, 'not_required', null, null, 'ct') $f$;
    create function ${S}.deposit(c uuid, amt numeric, k text) returns numeric language sql as $f$
      select balance_after from ${S}.finance_wallet_apply(c, 'DEPOSIT', 'credit', amt, k, 'deposit', null, 'T', 'bank_transfer', null, 'verified', null, null, 'ct') $f$;
    select ${S}.deposit('${cust}', 1000, 'seed-key-0001');`);

  // 1. eight different payments of 300 against 1000
  const r1 = await settle(Array.from({ length: 8 }, (_, i) => `select ${S}.spend('${cust}', 300, 'conc-pay-000${i}')::text as b`));
  const won = r1.filter(ok).length;
  const lost = r1.filter((r) => !ok(r) && /INSUFFICIENT_FUNDS/.test(r.reason.message)).length;
  const [b1] = await sql(`select balance::text b, (select count(*) from ${S}.finance_wallet_transactions where txn_type = 'INVOICE_PAYMENT') n from ${S}.finance_wallets where customer_id = '${cust}'`);
  check('1. exactly 3 of 8 concurrent payments succeed', won === 3, `${won} succeeded`);
  check('1. the other 5 are refused for insufficient funds (not for any other reason)', lost === 5, r1.filter((r) => !ok(r)).map((r) => r.reason.message.slice(0, 80)).join(' | '));
  check('1. balance is 100.00 and never went below zero', Number(b1.b) === 100 && Number(b1.n) === 3, JSON.stringify(b1));

  // 2. six identical retries
  const r2 = await settle(Array.from({ length: 6 }, () => `select ${S}.spend('${cust}', 50, 'same-key-retry-1')::text as b`));
  const [b2] = await sql(`select balance::text b, (select count(*) from ${S}.finance_wallet_transactions where idempotency_key = 'same-key-retry-1') n from ${S}.finance_wallets where customer_id = '${cust}'`);
  check('2. six identical concurrent retries debit exactly once', Number(b2.n) === 1 && Number(b2.b) === 50, JSON.stringify(b2));
  check('2. every retry got the same answer (no errors)', r2.every(ok), r2.filter((r) => !ok(r)).map((r) => r.reason.message.slice(0, 80)).join(' | '));

  // 3. a burst of deposits and spends
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push(`select ${S}.deposit('${cust}', 200, 'burst-dep-000${i}')::text`);
  for (let i = 0; i < 4; i++) burst.push(`select ${S}.spend('${cust}', 250, 'burst-pay-000${i}')::text`);
  await settle(burst);
  const [b3] = await sql(`select w.balance::text b, coalesce(sum(case when t.direction = 'credit' then t.amount else -t.amount end), 0)::text l, count(*)::text n,
      (select count(*) from (select t2.balance_before, lag(t2.balance_after, 1, 0::numeric) over (order by t2.seq) prev from ${S}.finance_wallet_transactions t2) x where x.balance_before <> x.prev)::text broken,
      (select count(*) from ${S}.finance_wallet_transactions where balance_after < 0)::text negative
    from ${S}.finance_wallets w join ${S}.finance_wallet_transactions t on t.wallet_id = w.id where w.customer_id = '${cust}' group by w.balance`);
  check('3. after the burst the ledger sums exactly to the balance', Number(b3.b) === Number(b3.l), JSON.stringify(b3));
  check('3. the chain balance_before = previous balance_after is unbroken', Number(b3.broken) === 0, JSON.stringify(b3));
  check('3. no ledger row ever shows a negative balance', Number(b3.negative) === 0 && Number(b3.b) >= 0, JSON.stringify(b3));
  console.log(`      (${b3.n} ledger rows, final balance ${b3.b})`);
} catch (e) {
  failed++;
  console.error('ERROR', e.message);
} finally {
  try { await sql(`drop schema if exists ${S} cascade`); console.log(`throw-away schema ${S} dropped`); } catch (e) { console.error('COULD NOT DROP ' + S + ': ' + e.message); failed++; }
}
process.exit(failed ? 1 : 0);
