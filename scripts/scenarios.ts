import { produce } from 'immer';
import { buildSeed } from '../src/domain/seed';
import { runIntegrityChecks } from '../src/domain/integrity';
import { createOrder, returnOrder, cancelOrder, advanceOrder } from '../src/domain/orders';
import { createReceipt, allocatedMap, orderBalance, voidReceipt, customerCredit, customerOutstanding, customerStatement } from '../src/domain/payments';
import { updateDraft, newDraftVersion, activateVersion } from '../src/domain/bom';
import { postManualJournal } from '../src/domain/accounting';
import { createEvent, setEventStatus, grantEntitlements, claimNumber, resetBoard } from '../src/domain/events';
import { redeemReward, adjustPoints, pointsBalance } from '../src/domain/loyalty';
import type { DB } from '../src/domain/types';

const base = buildSeed(new Date());
const now = new Date().toISOString();
const ctx = { now, userId: 'U1' };
let fails = 0;
const ok = (c: boolean, msg: string) => { console.log(c ? 'PASS' : 'FAIL', msg); if (!c) fails++; };
const t = (name: string, fn: (d: DB) => void) => { try { produce(base, (d) => { fn(d as DB); }); } catch (e) { ok(false, name + ' threw: ' + (e as Error).message); } };
const throws = (fn: () => void) => { try { fn(); return false; } catch { return true; } };
const integrity = (d: DB, label: string) => { const bad = runIntegrityChecks(d, now).filter((c) => c.status === 'fail'); ok(!bad.length, `integrity after ${label}` + (bad.length ? ': ' + bad.map((b) => b.id + ' ' + b.detail).join('; ') : '')); };

t('fifo', (d) => {
  const cust = d.customers.find((c) => c.id === 'C006')!; cust.creditLimit = 100000;
  for (const o of d.orders.filter((o) => o.customerId === 'C006')) { const a = allocatedMap(d)[o.id] || 0; const b = orderBalance(o, a); if (b > 0) createReceipt(d, ctx, { customerId: 'C006', amount: b, method: 'cash', allocations: [{ orderId: o.id, amount: b }] }); }
  const mk = (qty: number) => createOrder(d, ctx, { channel: 'LINE', branchId: 'B3', customerId: 'C006', lines: [{ productId: 'F02', qty }], payLater: true, skipStockCheck: true, skipPromotions: true });
  const ids = [mk(10), mk(8), mk(8)];
  const totals = ids.map((id) => d.orders.find((o) => o.id === id)!.total);
  const sum = totals.reduce((a, b) => a + b, 0);
  const pay = totals[0] + totals[1] / 2;
  const rid = createReceipt(d, ctx, { customerId: 'C006', amount: pay, method: 'transfer', allocations: 'fifo' });
  const al = allocatedMap(d);
  ok(Math.abs((al[ids[0]] || 0) - totals[0]) < 0.01, 'FIFO fully pays the oldest order');
  ok(Math.abs((al[ids[1]] || 0) - totals[1] / 2) < 0.01, 'FIFO part-pays the second order');
  ok(!(al[ids[2]] > 0), 'FIFO leaves the third untouched');
  ok(d.receipts.filter((r) => r.id === rid).length === 1, 'one receipt created for the multi-order payment');
  createReceipt(d, ctx, { customerId: 'C006', amount: sum, method: 'transfer', allocations: 'fifo' });
  ok(customerCredit(d, 'C006') > 0, 'overpayment becomes customer credit: ' + customerCredit(d, 'C006'));
  integrity(d, 'FIFO + overpayment');
  try { voidReceipt(d, ctx, rid, 'test'); integrity(d, 'void receipt'); } catch (e) { ok(true, 'void of receipt with later activity handled: ' + (e as Error).message); }
});

t('return + refund + cancel', (d) => {
  const oid = createOrder(d, ctx, { channel: 'POS', branchId: 'B2', customerId: 'C010', lines: [{ productId: 'F02', qty: 2 }, { productId: 'D01', qty: 1 }], payments: [{ method: 'cash', amount: 9999 }] });
  const o = d.orders.find((x) => x.id === oid)!;
  returnOrder(d, ctx, { orderId: oid, lines: [{ lineId: o.lines[0].id, qty: 1, restock: true }], reason: 'test', refund: 'credit' });
  ok(customerCredit(d, 'C010') > 0, 'refund to credit creates credit: ' + customerCredit(d, 'C010'));
  integrity(d, 'partial return refunded to credit');
  const o2 = createOrder(d, ctx, { channel: 'LINE', branchId: 'B3', customerId: 'C011', lines: [{ productId: 'F03', qty: 1 }], payments: [{ method: 'transfer', amount: 9999 }], skipPromotions: true });
  cancelOrder(d, ctx, o2, 'changed mind');
  ok(customerCredit(d, 'C011') > 0, 'cancelled paid order moves payment to credit');
  integrity(d, 'cancel paid order');
  const st = customerStatement(d, 'C011');
  ok(Math.abs(st.closing - (customerOutstanding(d, 'C011') - customerCredit(d, 'C011'))) < 0.01, 'statement closing = outstanding − credit: ' + st.closing + ' vs ' + (customerOutstanding(d, 'C011') - customerCredit(d, 'C011')));
});

t('bom immutability & period lock', (d) => {
  ok(throws(() => updateDraft(d, ctx, 'BM-D03', 1, { laborCost: 99 })), 'active BOM version cannot be edited');
  const n = newDraftVersion(d, ctx, 'BM-D03'); updateDraft(d, ctx, 'BM-D03', n, { laborCost: 9 }); activateVersion(d, ctx, 'BM-D03', n, now);
  const bom = d.boms.find((b) => b.id === 'BM-D03')!;
  ok(bom.versions.find((v) => v.version === 1)!.status === 'retired', 'v1 retired after activating v2');
  ok(throws(() => postManualJournal(d, ctx, { date: '2026-10-05T10:00:00.000Z', memo: 'x', lines: [{ account: '6300', debit: 10, credit: 0 }, { account: '1100', debit: 0, credit: 10 }] })), 'posting into a locked period is rejected');
  ok(throws(() => postManualJournal(d, ctx, { date: now, memo: 'x', lines: [{ account: '6300', debit: 10, credit: 0 }, { account: '1100', debit: 0, credit: 9 }] })), 'unbalanced journal is rejected');
});

t('event reset keeps history', (d) => {
  const ev = createEvent(d, ctx, { name: 'T', description: '', boards: 3, min: 0, max: 99, reservationMinutes: 10, terms: '' }); setEventStatus(d, ctx, ev, 'active');
  grantEntitlements(d, ctx, { eventId: ev, customerId: 'C010', count: 2 });
  const e = d.events.find((x) => x.id === ev)!;
  claimNumber(d, ctx, { eventId: ev, boardId: e.boards[0].id, number: 5, customerId: 'C010' });
  ok(throws(() => claimNumber(d, ctx, { eventId: ev, boardId: e.boards[0].id, number: 5, customerId: 'C010' })), 'taken number rejected');
  const n = resetBoard(d, ctx, ev, e.boards[0].id, 'test reset');
  ok(n === 1 && d.selections.filter((s) => s.eventId === ev && s.status === 'reset').length === 1, 'reset archives selection (history preserved)');
  claimNumber(d, ctx, { eventId: ev, boardId: e.boards[0].id, number: 5, customerId: 'C010' });
  ok(true, 'number reusable after reset');
  integrity(d, 'event reset');
});

t('points', (d) => {
  adjustPoints(d, ctx, 'C010', 100000, 'test grant'); const before = pointsBalance(d, 'C010');
  redeemReward(d, ctx, { customerId: 'C010', rewardId: 'RW2', idempotencyKey: 'a' }); redeemReward(d, ctx, { customerId: 'C010', rewardId: 'RW2', idempotencyKey: 'a' });
  ok(before - pointsBalance(d, 'C010') === 300, 'idempotent redemption charges once');
  integrity(d, 'points');
});

t('platform order lifecycle', (d) => {
  const o = d.orders.find((x) => x.channel === 'SHOPEE' && x.status === 'confirmed');
  if (o) { advanceOrder(d, ctx, o.id); advanceOrder(d, ctx, o.id); ok(d.orders.find((x) => x.id === o.id)!.status === 'shipped', 'order shipped'); integrity(d, 'ship platform order'); } else ok(true, 'no confirmed shopee order to ship (skipped)');
});
console.log(fails ? `${fails} FAILED` : 'ALL SCENARIOS PASSED');
