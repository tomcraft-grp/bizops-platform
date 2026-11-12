import { produce } from 'immer';
import type { DB } from './types';
import { balancesBetween } from './accounting';
import { reconciliationMatrix } from './setup';
import { inTransitValue, reconcileStock, stockValue } from './inventory';
import { reconcilePoints } from './loyalty';
import { verifyEventUniqueness, claimNumber, grantEntitlements, createEvent, setEventStatus } from './events';
import { allocatedMap, orderBalance, receiptUnapplied } from './payments';
import { apOpen } from './purchasing';
import { redeemReward, adjustPoints } from './loyalty';
import { createOrder } from './orders';
import { r2 } from '../lib/util';
import type { Ctx } from './core';

export interface Check { id: string; title: string; what: string; status: 'pass' | 'warn' | 'fail'; detail: string; evidence?: string[] }

export function runIntegrityChecks(d: DB, now: string): Check[] {
  const out: Check[] = [];
  const ok = (cond: boolean, warn = false): Check['status'] => (cond ? 'pass' : warn ? 'warn' : 'fail');

  // 1. trial balance
  const bal = balancesBetween(d.journals);
  const td = r2(Object.values(bal).reduce((s, b) => s + b.debit, 0));
  const tc = r2(Object.values(bal).reduce((s, b) => s + b.credit, 0));
  const unbalanced = d.journals.filter((j) => Math.abs(j.lines.reduce((s, l) => s + l.debit - l.credit, 0)) > 0.011);
  out.push({ id: 'tb', title: 'Trial balance balances', what: 'Σ debits = Σ credits across all journals; every journal individually balanced', status: ok(Math.abs(td - tc) < 0.02 && !unbalanced.length), detail: `Debits ${td.toLocaleString()} · Credits ${tc.toLocaleString()} · ${d.journals.length} journals · ${unbalanced.length} unbalanced`, evidence: unbalanced.slice(0, 5).map((j) => j.no) });

  // 2. stock ledger → balances
  const rs = reconcileStock(d);
  out.push({ id: 'stock', title: 'Stock balances reconcile to the movement ledger', what: 'Projection (balances) must equal Σ movements per product/warehouse', status: ok(!rs.diffs.length), detail: `${rs.checked} product-warehouse balances checked · ${d.movements.length} movements · ${rs.diffs.length} differences`, evidence: rs.diffs.slice(0, 5).map((x) => `${x.key}: ledger ${x.ledgerQty} vs balance ${x.balQty}`) });

  // 4. negative stock
  const neg = Object.entries(d.balances).filter(([, b]) => b.qty < -0.0005);
  out.push({ id: 'neg', title: 'No negative stock balances', what: 'Negative quantities indicate unrecorded receipts or overselling', status: ok(!neg.length, true), detail: neg.length ? `${neg.length} negative balances` : 'None', evidence: neg.slice(0, 5).map(([k, b]) => `${k}: ${b.qty}`) });

  // 3/5/6/8. every control account reconciles to its subledger (single source: reconciliationMatrix)
  const alloc = allocatedMap(d);
  for (const r of reconciliationMatrix(d)) {
    if (r.key === 'cash_bank') continue;
    out.push({ id: 'recon-' + r.key, title: r.title + ': subledger = GL control', what: r.subLabel + ' vs accounts ' + r.accounts, status: ok(Math.abs(r.diff) < 0.05, r.key === 'ap'), detail: 'GL ' + r.gl.toLocaleString() + ' · subledger ' + r.sub.toLocaleString() + ' · difference ' + r.diff });
  }

  // 7. allocations never exceed receipt / order
  const overRcpt = d.receipts.filter((r) => r.status === 'posted' && receiptUnapplied(d, r) < -0.005);
  const overOrder = d.orders.filter((o) => o.collectedBy === 'merchant' && o.status !== 'cancelled' && orderBalance(o, alloc[o.id] || 0) < -0.005 && o.creditNoted === 0 && o.refundsPaid === 0);
  out.push({ id: 'alloc', title: 'Payment allocations never exceed receipt or order value', what: 'Receipt ↔ allocation integrity', status: ok(!overRcpt.length && !overOrder.length), detail: `${overRcpt.length} over-allocated receipts · ${overOrder.length} over-paid orders`, evidence: [...overRcpt, ...overOrder].slice(0, 5).map((x) => x.no) });

  // 9. points
  const pr = reconcilePoints(d);
  out.push({ id: 'points', title: 'Points balances reconcile to the ledger', what: 'Customer balance = Σ ledger = Σ remaining batches (no double spend)', status: ok(!pr.diffs.length), detail: `${pr.checked} customers · ${d.pointsLedger.length} ledger entries · ${pr.diffs.length} differences` });
  const negPts = Object.entries(d.pointsLedger.reduce((m, e) => ((m[e.customerId] = (m[e.customerId] || 0) + e.points), m), {} as Record<string, number>)).filter(([, v]) => v < 0);
  out.push({ id: 'points-neg', title: 'No customer has a negative points balance', what: 'Concurrent redemption must never overspend', status: ok(!negPts.length), detail: negPts.length ? `${negPts.length} negative` : 'None' });

  // 10. events
  const ev = verifyEventUniqueness(d, now);
  out.push({ id: 'event', title: 'Event numbers are unique per (event, board, number)', what: 'Unique-index invariant over active selections', status: ok(!ev.duplicates.length && !ev.indexMismatch.length), detail: `${ev.checked} active numbers · ${ev.duplicates.length} duplicates · ${ev.indexMismatch.length} index mismatches` });

  // 11. order arithmetic & external duplicates
  const badOrders = d.orders.filter((o) => Math.abs(o.subtotal - o.discountTotal - o.total) > 0.011 || Math.abs(o.lines.reduce((s, l) => s + l.discount, 0) - o.discountTotal) > 0.02);
  out.push({ id: 'orders', title: 'Order totals are internally consistent', what: 'subtotal − discounts = total; line discounts sum to order discount', status: ok(!badOrders.length), detail: `${d.orders.length} orders · ${badOrders.length} inconsistent`, evidence: badOrders.slice(0, 5).map((o) => o.no) });
  const seen = new Set<string>();
  let dups = 0;
  for (const o of d.orders) if (o.externalId) { const k = o.channel + o.externalId; if (seen.has(k)) dups++; seen.add(k); }
  out.push({ id: 'ext', title: 'No duplicate external orders', what: 'Idempotent channel imports on (channel, external id)', status: ok(!dups), detail: `${seen.size} external orders · ${dups} duplicates` });

  // 12. cost snapshots
  const noSnap = d.orders.filter((o) => o.recognizedAt && o.lines.some((l) => !l.isFree && l.cost <= 0)).length;
  out.push({ id: 'snap', title: 'Every recognised order line carries a cost snapshot', what: 'Historical profit must not depend on today’s costs', status: ok(!noSnap, true), detail: noSnap ? `${noSnap} orders with a zero-cost line` : 'All lines snapshotted' });

  // 13. print idempotency
  const keys = new Set<string>();
  let dupJobs = 0;
  for (const j of d.printJobs) { if (keys.has(j.idempotencyKey)) dupJobs++; keys.add(j.idempotencyKey); }
  out.push({ id: 'print', title: 'Print jobs are idempotent', what: 'No duplicate job keys (kitchen tickets are not printed twice)', status: ok(!dupJobs), detail: `${d.printJobs.length} jobs · ${dupJobs} duplicate keys` });

  // 14. period lock
  out.push({ id: 'lock', title: 'Accounting period lock is active', what: 'Closed periods reject new postings', status: ok(!!d.meta.lockedUntil, true), detail: d.meta.lockedUntil ? `Locked through ${d.meta.lockedUntil}` : 'No period is locked' });
  return out;
}

// ---------- executable concurrency / invariant self-tests (run on a throw-away copy of the DB)
export interface TestResult { id: string; title: string; expectation: string; passed: boolean; detail: string }

export function runSelfTests(db: DB, ctx: Ctx): TestResult[] {
  const res: TestResult[] = [];
  const t = (id: string, title: string, expectation: string, fn: (d: DB) => string | { ok: boolean; detail: string }) => {
    let passed = false, detail = '';
    try {
      produce(db, (d) => {
        const r = fn(d as DB);
        if (typeof r === 'string') { passed = true; detail = r; } else { passed = r.ok; detail = r.detail; }
      });
    } catch (e) { detail = 'Test crashed: ' + (e as Error).message; }
    res.push({ id, title, expectation, passed, detail });
  };

  t('event-dup', '20 simultaneous claims of the same event number', 'exactly 1 succeeds, 19 rejected with NUMBER_TAKEN', (d) => {
    const evId = createEvent(d, ctx, { name: 'TEST', description: '', boards: 3, min: 0, max: 99, reservationMinutes: 10, terms: '' });
    setEventStatus(d, ctx, evId, 'active');
    const ev = d.events.find((e) => e.id === evId)!;
    let ok = 0, taken = 0;
    for (let i = 0; i < 20; i++) {
      const cid = d.customers[i % d.customers.length].id;
      grantEntitlements(d, ctx, { eventId: evId, customerId: cid, count: 1 });
      const en = d.entitlements[d.entitlements.length - 1];
      try { claimNumber(d, ctx, { eventId: evId, boardId: ev.boards[0].id, number: 7, customerId: cid, entitlementId: en.id }); ok++; } catch (e) { if ((e as { code?: string }).code === 'NUMBER_TAKEN') taken++; }
    }
    return { ok: ok === 1 && taken === 19, detail: `${ok} succeeded · ${taken} rejected` };
  });

  t('points-race', '10 simultaneous redemptions with points for only one', 'exactly 1 succeeds; balance never negative', (d) => {
    const reward = d.rewards.find((r) => r.active && r.stock !== 0 && r.cost > 0)!;
    const cid = d.customers[0].id;
    const cur = d.pointsLedger.filter((e) => e.customerId === cid).reduce((s, e) => s + e.points, 0);
    if (reward.cost - cur !== 0) adjustPoints(d, ctx, cid, reward.cost - cur, 'self-test setup');
    let ok = 0;
    for (let i = 0; i < 10; i++) { try { redeemReward(d, ctx, { customerId: cid, rewardId: reward.id, idempotencyKey: 'k' + i }); ok++; } catch { /* rejected */ } }
    const bal = d.pointsLedger.filter((e) => e.customerId === cid).reduce((s, e) => s + e.points, 0);
    return { ok: ok === 1 && bal >= 0, detail: `${ok} succeeded · final balance ${bal}` };
  });

  t('stock-race', '5 orders for the last unit in stock', 'exactly 1 succeeds; stock never negative', (d) => {
    const p = d.products.find((x) => x.kind === 'resale' && x.active)!;
    const wh = d.branches[0].defaultWarehouseId;
    const k = `${wh}|${p.id}`;
    d.balances[k] = { qty: 1, value: p.stdCost, lastCost: p.stdCost };
    let ok = 0;
    for (let i = 0; i < 5; i++) { try { createOrder(d, ctx, { channel: 'POS', branchId: d.branches[0].id, lines: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: p.price }] }); ok++; } catch { /* insufficient */ } }
    return { ok: ok === 1 && d.balances[k].qty >= 0, detail: `${ok} succeeded · remaining ${d.balances[k].qty}` };
  });

  t('idem-order', 'Double-tap checkout with the same idempotency key', 'only 1 order is created', (d) => {
    const p = d.products.find((x) => x.kind === 'resale' && x.active)!;
    const wh = d.branches[0].defaultWarehouseId;
    const before = d.orders.length;
    const ids = new Set<string>();
    const k = `${wh}|${p.id}`;
    if ((d.balances[k]?.qty ?? 0) < 3) d.balances[k] = { qty: 5, value: 5 * p.stdCost, lastCost: p.stdCost };
    for (let i = 0; i < 4; i++) ids.add(createOrder(d, ctx, { channel: 'POS', branchId: d.branches[0].id, lines: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amount: p.price }], idempotencyKey: 'dbl-tap-1' }));
    return { ok: d.orders.length - before === 1 && ids.size === 1, detail: `${d.orders.length - before} order(s) created from 4 submits` };
  });

  t('ar-gl', 'Posting a sale and a partial payment keeps AR tied to GL', 'sub-ledger equals control account after posting', (d) => {
    const cust = d.customers.find((c) => c.creditLimit > 1000)!;
    const p = d.products.find((x) => x.kind === 'resale' && x.active)!;
    const wh = d.branches[0].defaultWarehouseId;
    d.balances[`${wh}|${p.id}`] = { qty: 50, value: 50 * p.stdCost, lastCost: p.stdCost };
    const id = createOrder(d, ctx, { channel: 'POS', branchId: d.branches[0].id, customerId: cust.id, lines: [{ productId: p.id, qty: 2 }], payments: [{ method: 'cash', amount: 10 }], payLater: true });
    const o = d.orders.find((x) => x.id === id)!;
    const checks = runIntegrityChecks(d as DB, ctx.now).filter((c) => c.id === 'recon-ar' || c.id === 'tb');
    return { ok: checks.every((c) => c.status === 'pass') && o.total > 10, detail: checks.map((c) => `${c.id}: ${c.status}`).join(' · ') };
  });
  return res;
}
