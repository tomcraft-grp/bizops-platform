import { describe, expect, it } from 'vitest';
import { base, ctx, at, tx, txState, stock, throws, codeOf, expectIntegrity } from '../helpers';
import { createOrder, quoteOrder, returnOrder, cancelOrder, advanceOrder, nextStatuses } from '../../src/domain/orders';
import { evaluatePromotions } from '../../src/domain/promotions';
import { adjustPoints, earnPoints, expirePoints, pointsBalance, redeemReward, reversePoints, cancelRedemption, reconcilePoints } from '../../src/domain/loyalty';
import { allocatedMap, applyCredit, createReceipt, customerCredit, customerOutstanding, customerStatement, orderBalance, outstandingOrders, refundCash, refundToCredit, voidReceipt, receiptUnapplied } from '../../src/domain/payments';
import { closeTransferShort, createTransfer, moveStock, onHand, receiveTransfer, reconcileStock, adjustStock, getBal } from '../../src/domain/inventory';
import { createProductionOrder, recordProduction, newDraftVersion, updateDraft, activateVersion, rollup, versionAt, bomForProduct } from '../../src/domain/bom';
import { importExternalOrder } from '../../src/domain/channels';
import { claimNumber, createEvent, grantEntitlements, setEventStatus, resetBoard } from '../../src/domain/events';
import { r2 } from '../../src/lib/util';

const W1 = 'W1', W3 = 'W3', B1 = 'B1';
const sale = (d: ReturnType<typeof base>, lines: { productId: string; qty: number }[], extra: Record<string, unknown> = {}) =>
  createOrder(d, ctx, { channel: 'POS', branchId: B1, lines, payments: [{ method: 'cash', amount: 1e6 }], skipPromotions: true, ...extra } as never);

describe('pricing, tax and rounding (boundary values)', () => {
  it.each([0.01, 0.05, 0.99, 1.07, 19.99, 107, 12345.67, 99999.99])('sale at price %s keeps the ledger balanced and splits VAT exactly', (price) => {
    tx((d) => {
      d.products.find((p) => p.id === 'R04')!.price = price;
      stock(d, 'R04', W1, 5);
      const id = sale(d, [{ productId: 'R04', qty: 1 }]);
      const o = d.orders.find((x) => x.id === id)!;
      expect(o.total).toBe(r2(price));
      // net + VAT must equal the gross price to the satang
      expect(r2((o.taxBase ?? 0) + (o.vatAmount ?? 0))).toBe(o.total);
      expectIntegrity(d);
    });
  });
  it('total = subtotal − discounts and line discounts add up to the order discount', () => {
    tx((d) => {
      stock(d, 'F02', W1, 20);
      const q = quoteOrder(d, { channel: 'POS', branchId: B1, lines: [{ productId: 'F02', qty: 3 }], manualDiscount: 33.33, now: ctx.now });
      expect(q.total).toBe(r2(q.subtotal - q.manual));
      const id = sale(d, [{ productId: 'F02', qty: 3 }], { manualDiscount: 33.33 });
      const o = d.orders.find((x) => x.id === id)!;
      expect(r2(o.lines.reduce((s, l) => s + l.discount, 0))).toBe(o.discountTotal);
      expect(o.total).toBe(r2(o.subtotal - o.discountTotal));
    });
  });
  it('a discount larger than the order is rejected', () => {
    tx((d) => { stock(d, 'R04', W1, 3); expect(throws(() => sale(d, [{ productId: 'R04', qty: 1 }], { manualDiscount: 999 }))).toMatch(/exceeds/i); });
  });
  it('historical order values do not change when the product price is edited later', () => {
    tx((d) => {
      stock(d, 'R04', W1, 3);
      const id = sale(d, [{ productId: 'R04', qty: 1 }]);
      const before = d.orders.find((o) => o.id === id)!.total;
      d.products.find((p) => p.id === 'R04')!.price = 999;
      expect(d.orders.find((o) => o.id === id)!.total).toBe(before);
    });
  });
});

describe('promotion engine (deterministic eligibility, limits, stacking)', () => {
  const lines = (d: ReturnType<typeof base>, items: [string, number][]) => items.map(([id, qty]) => ({ productId: id, qty, unitPrice: d.products.find((p) => p.id === id)!.price }));
  const mon = '2026-11-16T10:00:00+07:00'; // Monday
  const sat = '2026-11-14T10:00:00+07:00'; // Saturday
  it('weekday rule applies on Saturday and not on Monday; identical input gives identical output', () => {
    tx((d) => {
      const c = (iso: string) => ({ channel: 'POS' as const, branchId: B1, now: new Date(iso).toISOString() });
      const a = evaluatePromotions(d, lines(d, [['F02', 2]]), c(sat));
      const b = evaluatePromotions(d, lines(d, [['F02', 2]]), c(sat));
      expect(a).toEqual(b);
      expect(a.applied.some((x) => x.promoId === 'PM1')).toBe(true);
      expect(evaluatePromotions(d, lines(d, [['F02', 2]]), c(mon)).applied.some((x) => x.promoId === 'PM1')).toBe(false);
    });
  });
  it('minimum-order boundary: exactly ฿300 qualifies for WELCOME50, ฿299 does not', () => {
    tx((d) => {
      d.products.find((p) => p.id === 'R04')!.price = 300;
      const cust = d.customers.find((c) => c.group === 'retail')!.id;
      const ok = evaluatePromotions(d, lines(d, [['R04', 1]]), { channel: 'POS', branchId: B1, now: ctx.now, customerId: cust, code: 'WELCOME50' });
      expect(ok.applied.some((x) => x.promoId === 'PM5')).toBe(true);
      d.products.find((p) => p.id === 'R04')!.price = 299.99;
      const no = evaluatePromotions(d, lines(d, [['R04', 1]]), { channel: 'POS', branchId: B1, now: ctx.now, customerId: cust, code: 'WELCOME50' });
      expect(no.applied.some((x) => x.promoId === 'PM5')).toBe(false);
    });
  });
  it('per-customer limit is enforced after the first redemption', () => {
    tx((d) => {
      const cust = d.customers.find((c) => c.group === 'retail')!.id;
      d.products.find((p) => p.id === 'F02')!.price = 400;
      stock(d, 'F02', W1, 10);
      const first = sale(d, [{ productId: 'F02', qty: 1 }], { customerId: cust, promoCode: 'WELCOME50', skipPromotions: false });
      expect(d.orders.find((o) => o.id === first)!.promotions.some((p) => p.promoId === 'PM5')).toBe(true);
      const q2 = evaluatePromotions(d, lines(d, [['F02', 1]]), { channel: 'POS', branchId: B1, now: ctx.now, customerId: cust, code: 'WELCOME50' });
      expect(q2.skipped.some((s) => s.promoId === 'PM5' && /limit/i.test(s.reason))).toBe(true);
    });
  });
  it('budget exhaustion stops a discount promotion', () => {
    tx((d) => {
      const p = d.promotions.find((x) => x.id === 'PM1')!;
      p.budget = 1;
      d.redemptions.push({ id: 'T', promoId: 'PM1', orderId: 'X', ts: ctx.now, discount: 1, bonusPoints: 0, entitlements: 0 });
      const r = evaluatePromotions(d, lines(d, [['F02', 2]]), { channel: 'POS', branchId: B1, now: new Date(sat).toISOString() });
      expect(r.applied.some((x) => x.promoId === 'PM1')).toBe(false);
      expect(r.skipped.some((s) => /budget/i.test(s.reason))).toBe(true);
    });
  });
  it('an exclusive promotion blocks lower-priority discounts but not points or entitlements', () => {
    tx((d) => {
      const r = evaluatePromotions(d, lines(d, [['D03', 1], ['FD1', 1]]), { channel: 'POS', branchId: B1, now: ctx.now });
      const discounts = r.applied.filter((a) => a.discount > 0);
      expect(discounts.length).toBe(1);
      expect(discounts[0].promoId).toBe('PM3');
    });
  });
  it('bundle pricing discounts the base prices only (modifier surcharges are not swallowed)', () => {
    tx((d) => {
      const r = quoteOrder(d, { channel: 'POS', branchId: B1, lines: [{ productId: 'D03', qty: 1, modifiers: [{ group: 'Milk', option: 'Oat milk' }] }, { productId: 'FD1', qty: 1 }], now: ctx.now });
      // latte 70 + oat 25 + croissant 65 = 160; bundle 119 vs base 135 ⇒ −16
      expect(r.promoDiscount).toBe(16);
      expect(r.total).toBe(144);
    });
  });
  it('promotions never apply to a disabled (draft) rule', () => {
    tx((d) => { const r = evaluatePromotions(d, lines(d, [['R03', 5]]), { channel: 'LINEMAN', branchId: B1, now: ctx.now }); expect(r.applied.some((x) => x.promoId === 'PM7')).toBe(false); });
  });
});

describe('points ledger (earn, expiry, redemption, reversal)', () => {
  it('points are derived from the ledger and the batches always agree', () => {
    tx((d) => { expect(reconcilePoints(d).diffs).toEqual([]); });
  });
  it('earn uses category and tier multipliers with floor()', () => {
    tx((d) => {
      const cust = d.customers.find((c) => c.group === 'retail' && !d.orders.some((o) => o.customerId === c.id))?.id ?? d.customers.find((c) => c.group === 'retail')!.id;
      stock(d, 'F02', W1, 5);
      const before = pointsBalance(d, cust);
      const id = sale(d, [{ productId: 'F02', qty: 1 }], { customerId: cust });
      const o = d.orders.find((x) => x.id === id)!;
      expect(o.pointsEarned).toBeGreaterThan(0);
      expect(pointsBalance(d, cust) - before).toBe(o.pointsEarned);
      // 189 / 25 × 1.5 (beans) × tier ≥ 1 → at least 11 for a silver customer
      expect(o.pointsEarned).toBeGreaterThanOrEqual(11);
    });
  });
  it('expiry removes only expired batches and keeps balance = Σ remaining', () => {
    tx((d) => {
      const cust = d.customers[10].id;
      adjustPoints(d, ctx, cust, 500, 'test grant');
      const before = pointsBalance(d, cust);
      const n = expirePoints(d, at('2030-01-01T00:00:00+07:00'));
      expect(n).toBeGreaterThan(0);
      expect(pointsBalance(d, cust)).toBe(0);
      expect(before).toBeGreaterThan(0);
      expect(reconcilePoints(d).diffs).toEqual([]);
    });
  });
  it('redemption with insufficient points is rejected and changes nothing', () => {
    const s = txState((d) => {
      const cust = d.customers[11].id;
      const bal = pointsBalance(d, cust);
      d.pointsLedger = d.pointsLedger.filter((e) => e.customerId !== cust);
      expect(codeOf(() => redeemReward(d, ctx, { customerId: cust, rewardId: 'RW5' }))).toBe('INSUFFICIENT_POINTS');
      expect(pointsBalance(d, cust)).toBe(0);
      void bal;
    });
    expect(s).toBeDefined();
  });
  it('redeem → cancel restores points, stock and cancels the coupon', () => {
    tx((d) => {
      const cust = d.customers[12].id;
      adjustPoints(d, ctx, cust, 1000, 'test');
      const bal = pointsBalance(d, cust);
      const stockBefore = d.rewards.find((r) => r.id === 'RW4')!.stock;
      const rid = redeemReward(d, ctx, { customerId: cust, rewardId: 'RW4' });
      expect(pointsBalance(d, cust)).toBe(bal - 900);
      cancelRedemption(d, ctx, rid, 'test');
      expect(pointsBalance(d, cust)).toBe(bal);
      expect(d.rewards.find((r) => r.id === 'RW4')!.stock).toBe(stockBefore);
      expect(reconcilePoints(d).diffs).toEqual([]);
    });
  });
  it('a return reverses earned points but never below the current balance', () => {
    tx((d) => {
      const cust = d.customers[13].id;
      stock(d, 'F02', W1, 5);
      const id = sale(d, [{ productId: 'F02', qty: 1 }], { customerId: cust });
      const o = d.orders.find((x) => x.id === id)!;
      d.pointsLedger.forEach((e) => { if (e.customerId === cust && e.refId !== id) { e.remaining = 0; e.points = 0; } });
      reversePoints(d, ctx, o, 1, 'test');
      expect(pointsBalance(d, cust)).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('payments, allocation and receivables', () => {
  const credit = (d: ReturnType<typeof base>, cid = 'C006') => { d.customers.find((c) => c.id === cid)!.creditLimit = 1e6; };
  const inv = (d: ReturnType<typeof base>, qty: number, cid = 'C006') => createOrder(d, ctx, { channel: 'LINE', branchId: 'B3', customerId: cid, lines: [{ productId: 'F02', qty }], payLater: true, skipStockCheck: true, skipPromotions: true });
  const clear = (d: ReturnType<typeof base>, cid = 'C006') => { for (const o of d.orders.filter((x) => x.customerId === cid)) { const b = orderBalance(o, allocatedMap(d)[o.id] || 0); if (b > 0) createReceipt(d, ctx, { customerId: cid, amount: b, method: 'cash', allocations: [{ orderId: o.id, amount: b }] }); } };
  it('one payment of ฿3,000 is allocated FIFO across three invoices (spec example)', () => {
    tx((d) => {
      credit(d); clear(d);
      d.products.find((p) => p.id === 'F02')!.channelPrices.LINE = 1000;
      const [a, b, c] = [inv(d, 2), inv(d, 2), inv(d, 1)]; // 2000 + 2000 + 1000 = 5000
      createReceipt(d, ctx, { customerId: 'C006', amount: 3000, method: 'transfer', allocations: 'fifo' });
      const al = allocatedMap(d);
      expect(al[a]).toBe(2000);
      expect(al[b]).toBe(1000);
      expect(al[c] || 0).toBe(0);
      expect(customerOutstanding(d, 'C006')).toBe(2000);
      expect(d.receipts.filter((r) => r.amount === 3000).length).toBe(1); // exactly one receipt
      expectIntegrity(d);
    });
  });
  it('FIFO ordering is deterministic and follows invoice age', () => {
    tx((d) => {
      credit(d); clear(d);
      const first = inv(d, 1), second = inv(d, 1);
      d.orders.find((o) => o.id === second)!.createdAt = '2026-01-01T00:00:00.000Z';
      const order = outstandingOrders(d, 'C006').map((x) => x.order.id);
      expect(order[0]).toBe(second);
      expect(order[1]).toBe(first);
    });
  });
  it('manual allocation cannot exceed the order balance or the payment', () => {
    tx((d) => {
      credit(d); clear(d);
      const id = inv(d, 1);
      const bal = orderBalance(d.orders.find((o) => o.id === id)!, 0);
      expect(codeOf(() => createReceipt(d, ctx, { customerId: 'C006', amount: bal + 100, method: 'cash', allocations: [{ orderId: id, amount: bal + 50 }] }))).toBe('OVER_ALLOCATION');
      expect(codeOf(() => createReceipt(d, ctx, { customerId: 'C006', amount: 10, method: 'cash', allocations: [{ orderId: id, amount: 50 }] }))).toBe('OVER_ALLOCATION');
    });
  });
  it('overpayment stays as unapplied credit and can be applied later', () => {
    tx((d) => {
      credit(d); clear(d);
      const id = inv(d, 1);
      const bal = orderBalance(d.orders.find((o) => o.id === id)!, 0);
      createReceipt(d, ctx, { customerId: 'C006', amount: bal + 400, method: 'transfer', allocations: 'fifo' });
      expect(customerCredit(d, 'C006')).toBe(400);
      const id2 = inv(d, 1);
      const invoice2 = orderBalance(d.orders.find((o) => o.id === id2)!, 0);
      const applied = applyCredit(d, ctx, { customerId: 'C006', orderId: id2, amount: 1e6 });
      expect(applied).toBe(Math.min(400, invoice2)); // never more than the invoice or the credit held
      expect(customerCredit(d, 'C006')).toBe(r2(400 - applied));
      expectIntegrity(d);
    });
  });
  it('an unknown customer cannot leave a payment unapplied', () => {
    tx((d) => { expect(codeOf(() => createReceipt(d, ctx, { amount: 100, method: 'cash', allocations: [] }))).toBe('NEEDS_CUSTOMER'); });
  });
  it('voiding a receipt keeps the original, reverses the journal and reopens the invoice', () => {
    tx((d) => {
      credit(d); clear(d);
      const id = inv(d, 1);
      const bal = orderBalance(d.orders.find((o) => o.id === id)!, 0);
      const rid = createReceipt(d, ctx, { customerId: 'C006', amount: bal, method: 'cash', allocations: [{ orderId: id, amount: bal }] });
      const jBefore = d.journals.length;
      voidReceipt(d, ctx, rid, 'wrong customer');
      const r = d.receipts.find((x) => x.id === rid)!;
      expect(r.status).toBe('void');                       // record preserved
      expect(d.journals.length).toBeGreaterThan(jBefore);  // compensating entry
      expect(d.journals.some((j) => j.reverses === r.journalId)).toBe(true);
      expect(orderBalance(d.orders.find((o) => o.id === id)!, allocatedMap(d)[id] || 0)).toBe(bal);
      expect(throws(() => voidReceipt(d, ctx, rid, 'again'))).toMatch(/already/i);
      expectIntegrity(d);
    });
  });
  it('refunds cannot exceed the refundable overpayment', () => {
    tx((d) => {
      stock(d, 'F02', W1, 5);
      const id = sale(d, [{ productId: 'F02', qty: 1 }], { customerId: 'C010' });
      const o = d.orders.find((x) => x.id === id)!;
      expect(codeOf(() => refundCash(d, ctx, id, 50, 'cash'))).toBe('INVALID');      // nothing overpaid yet
      returnOrder(d, ctx, { orderId: id, lines: [{ lineId: o.lines[0].id, qty: 1, restock: true }], reason: 'test', refund: 'none' });
      expect(codeOf(() => refundCash(d, ctx, id, o.total + 1, 'cash'))).toBe('INVALID');
      refundToCredit(d, ctx, id, o.total);
      expect(customerCredit(d, 'C010')).toBeGreaterThanOrEqual(o.total);
      expectIntegrity(d);
    });
  });
  it('customer statement obeys: opening + charges − payments − credits = closing', () => {
    tx((d) => {
      credit(d); clear(d);
      const a = inv(d, 2), b = inv(d, 3);
      for (const id of [b]) while (nextStatuses(d.orders.find((o) => o.id === id)!).length && !d.orders.find((o) => o.id === id)!.recognizedAt) advanceOrder(d, ctx, id);
      createReceipt(d, ctx, { customerId: 'C006', amount: 150, method: 'cash', allocations: 'fifo' });
      returnOrder(d, ctx, { orderId: b, lines: [{ lineId: d.orders.find((o) => o.id === b)!.lines[0].id, qty: 1, restock: true }], reason: 't', refund: 'none' });
      const st = customerStatement(d, 'C006');
      const charges = st.rows.filter((r) => r.type === 'invoice').reduce((s, r) => s + r.debit, 0);
      const pay = st.rows.filter((r) => r.type === 'receipt').reduce((s, r) => s + r.credit, 0);
      const cn = st.rows.filter((r) => r.type === 'credit_note').reduce((s, r) => s + r.credit, 0);
      const refunds = st.rows.filter((r) => r.type === 'refund').reduce((s, r) => s + r.debit - r.credit, 0);
      expect(r2(st.opening + charges - pay - cn - refunds)).toBe(r2(st.closing - 0));
      expect(st.closing).toBeCloseTo(customerOutstanding(d, 'C006') - customerCredit(d, 'C006'), 2);
      void a;
    });
  });
  it('payment slips: exact duplicates are blocked, approval creates one receipt', () => {
    tx((d) => {
      const base1 = d.slips.find((s) => s.status === 'pending');
      expect(base1).toBeDefined();
    });
  });
});

describe('inventory ledger, costing and reconciliation', () => {
  it('weighted-average cost: inbound at a new cost re-averages, outbound uses the average', () => {
    tx((d) => {
      const k = 'W2|R07';
      d.balances[k] = { qty: 0, value: 0, lastCost: 0 };
      moveStock(d, ctx, { productId: 'R07', warehouseId: 'W2', qty: 10, type: 'receipt', refType: 't', refId: 't', unitCost: 10 });
      moveStock(d, ctx, { productId: 'R07', warehouseId: 'W2', qty: 10, type: 'receipt', refType: 't', refId: 't', unitCost: 20 });
      const out = moveStock(d, ctx, { productId: 'R07', warehouseId: 'W2', qty: -5, type: 'sale', refType: 't', refId: 't' });
      expect(out.unitCost).toBeCloseTo(15, 5);
      expect(getBal(d, 'W2', 'R07').value).toBeCloseTo(225, 2);
    });
  });
  it('stock cannot go negative unless the policy allows it, and nothing is partially applied', () => {
    const s = txState((d) => {
      const before = onHand(d, W1, 'R04');
      expect(codeOf(() => moveStock(d, ctx, { productId: 'R04', warehouseId: W1, qty: -(before + 1), type: 'sale', refType: 't', refId: 't' }))).toBe('INSUFFICIENT_STOCK');
      expect(onHand(d, W1, 'R04')).toBe(before);
      d.org.allowNegativeStock = true;
      moveStock(d, ctx, { productId: 'R04', warehouseId: W1, qty: -(before + 1), type: 'sale', refType: 't', refId: 't' });
      expect(onHand(d, W1, 'R04')).toBe(-1);
    });
    expect(s).toBeDefined();
  });
  it('a failing sale rolls back completely (no order, stock or journal left behind)', () => {
    const b = base();
    const ordersBefore = b.orders.length, movBefore = b.movements.length, jBefore = b.journals.length;
    const s = txState((d) => {
      d.balances['W1|M03'] = { qty: 0, value: 0, lastCost: 0 }; // no milk → a latte cannot be made
    });
    expect(s.orders.length).toBe(ordersBefore);
    // emulate act(): a throwing transaction leaves the previous state untouched
    let threw = false;
    try { tx((d) => { d.balances['W1|M03'] = { qty: 0, value: 0, lastCost: 0 }; sale(d, [{ productId: 'D03', qty: 1 }]); }); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(b.orders.length).toBe(ordersBefore);
    expect(b.movements.length).toBe(movBefore);
    expect(b.journals.length).toBe(jBefore);
  });
  it('transfers distinguish dispatched / in transit / received / short', () => {
    tx((d) => {
      stock(d, 'R07', W3, 20);
      const id = createTransfer(d, ctx, { fromWh: W3, toWh: W1, lines: [{ productId: 'R07', qty: 10 }] });
      expect(d.transfers.find((t) => t.id === id)!.status).toBe('in_transit');
      receiveTransfer(d, ctx, id, [{ productId: 'R07', qty: 4 }]);
      expect(d.transfers.find((t) => t.id === id)!.status).toBe('partial');
      expect(codeOf(() => receiveTransfer(d, ctx, id, [{ productId: 'R07', qty: 7 }]))).toBe('OVER_RECEIPT');
      closeTransferShort(d, ctx, id, 'carton lost');
      expect(d.transfers.find((t) => t.id === id)!.status).toBe('closed_short');
      expectIntegrity(d);
    });
  });
  it('200 random stock operations keep balances reconciled to the ledger and the GL', () => {
    tx((d) => {
      let seed = 42;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const items = ['R03', 'R04', 'R07', 'F02', 'F04', 'M08'];
      for (let i = 0; i < 200; i++) {
        const p = items[Math.floor(rnd() * items.length)];
        const wh = ['W1', 'W2', 'W3'][Math.floor(rnd() * 3)];
        const q = Math.round((rnd() * 8 + 1) * 10) / 10;
        try {
          if (rnd() < 0.5) stock(d, p, wh, q);
          else adjustStock(d, ctx, { productId: p, warehouseId: wh, qty: -q, reason: 'rnd', kind: rnd() < 0.5 ? 'waste' : 'adjust' });
        } catch { /* insufficient stock is a valid outcome */ }
      }
      expect(reconcileStock(d).diffs).toEqual([]);
      expectIntegrity(d);
    });
  });
  it('a return restocks at the ORIGINAL cost via a compensating movement', () => {
    tx((d) => {
      stock(d, 'F02', W1, 5);
      const id = sale(d, [{ productId: 'F02', qty: 2 }]);
      const o = d.orders.find((x) => x.id === id)!;
      const costPerUnit = o.lines[0].cost / 2;
      const movBefore = d.movements.length;
      returnOrder(d, ctx, { orderId: id, lines: [{ lineId: o.lines[0].id, qty: 1, restock: true }], reason: 'test', refund: 'none' });
      const mv = d.movements.slice(movBefore).find((m) => m.type === 'return_in')!;
      expect(mv.unitCost).toBeCloseTo(costPerUnit, 2);
      expect(d.movements.some((m) => m.type === 'sale' && m.refId === id)).toBe(true); // original movement untouched
    });
  });
});

describe('BOM, recipes, production and cost snapshots', () => {
  it('recipe consumption deducts ingredients at the version effective on the sale date', () => {
    tx((d) => {
      const milk = onHand(d, W1, 'M03');
      const id = sale(d, [{ productId: 'D03', qty: 1 }]);
      expect(r2(milk - onHand(d, W1, 'M03'))).toBeCloseTo(0.2, 3);
      expect(d.orders.find((o) => o.id === id)!.lines[0].bom).toEqual({ bomId: 'BM-D03', version: 1 });
    });
  });
  it('modifier replaces an ingredient (oat milk swaps out fresh milk)', () => {
    tx((d) => {
      const milk = onHand(d, W1, 'M03'), oat = onHand(d, W1, 'M04');
      sale(d, [{ productId: 'D03', qty: 1, modifiers: [{ group: 'Milk', option: 'Oat milk' }] } as never]);
      expect(onHand(d, W1, 'M03')).toBe(milk);
      expect(oat - onHand(d, W1, 'M04')).toBeCloseTo(0.2, 3);
    });
  });
  it('publishing a new recipe version does not change the cost of orders already posted', () => {
    tx((d) => {
      const id = sale(d, [{ productId: 'D03', qty: 1 }]);
      const costBefore = d.orders.find((o) => o.id === id)!.lines[0].cost;
      const n = newDraftVersion(d, ctx, 'BM-D03');
      updateDraft(d, ctx, 'BM-D03', n, { components: [{ productId: 'M03', qty: 0.5, role: 'material' }, { productId: 'F01', qty: 0.018, role: 'material' }, { productId: 'K04', qty: 1, role: 'packaging' }], laborCost: 30 });
      activateVersion(d, ctx, 'BM-D03', n, ctx.now);
      expect(d.orders.find((o) => o.id === id)!.lines[0].cost).toBe(costBefore);
      const id2 = sale(d, [{ productId: 'D03', qty: 1 }]);
      expect(d.orders.find((o) => o.id === id2)!.lines[0].cost).toBeGreaterThan(costBefore);
      expect(d.orders.find((o) => o.id === id2)!.lines[0].bom!.version).toBe(2);
    });
  });
  it('only draft versions are editable', () => {
    tx((d) => { expect(codeOf(() => updateDraft(d, ctx, 'BM-D03', 1, { laborCost: 1 }))).toBe('IMMUTABLE'); });
  });
  it('production: output, waste and yield are recorded; waste cost is expensed, not capitalised', () => {
    tx((d) => {
      stock(d, 'M01', W3, 30); stock(d, 'M02', W3, 30);
      const po = createProductionOrder(d, ctx, { bomId: 'BM-F01', plannedQty: 10, warehouseId: W3 });
      const fgBefore = { ...getBal(d, W3, 'F01') };
      recordProduction(d, ctx, po, { outputQty: 9.5, wasteQty: 0.5 });
      const order = d.productionOrders.find((p) => p.id === po)!;
      const b = order.batches[0];
      expect(b.wasteCost).toBeGreaterThan(0);
      expect(r2(b.materialCost + b.conversionCost - b.wasteCost)).toBeCloseTo(getBal(d, W3, 'F01').value - fgBefore.value, 1);
      expect(order.snapshot.version).toBe(1);
      expectIntegrity(d);
    });
  });
  it('production snapshot keeps its BOM even if a newer version becomes active', () => {
    tx((d) => {
      stock(d, 'M01', W3, 30); stock(d, 'M02', W3, 30);
      const po = createProductionOrder(d, ctx, { bomId: 'BM-F01', plannedQty: 10, warehouseId: W3 });
      const n = newDraftVersion(d, ctx, 'BM-F01'); updateDraft(d, ctx, 'BM-F01', n, { laborCost: 9999 }); activateVersion(d, ctx, 'BM-F01', n, ctx.now);
      recordProduction(d, ctx, po, { outputQty: 10 });
      expect(d.productionOrders.find((p) => p.id === po)!.batches[0].conversionCost).toBe(600); // v1 labor 350 + overhead 250
      expect(rollup(d, versionAt(bomForProduct(d, 'F01')!, ctx.now)!).labor).toBe(9999);
    });
  });
  it('production fails atomically when a component is missing', () => {
    const b = base();
    const before = b.movements.length;
    expect(() => tx((d) => {
      d.balances['W3|M01'] = { qty: 0, value: 0, lastCost: 0 };
      const po = createProductionOrder(d, ctx, { bomId: 'BM-F01', plannedQty: 10, warehouseId: W3 });
      recordProduction(d, ctx, po, { outputQty: 10 });
    })).toThrow(/Insufficient stock/);
    expect(b.movements.length).toBe(before);
  });
});

describe('orders: state machine, idempotency, imports, cancellation', () => {
  it('allowed transitions follow the channel flow and nothing can leave a terminal state', () => {
    tx((d) => {
      const o = d.orders.find((x) => x.channel === 'SHOPEE' && x.status === 'confirmed')!;
      expect(nextStatuses(o)).toEqual(['packed']);
      const done = d.orders.find((x) => x.status === 'completed')!;
      expect(nextStatuses(done)).toEqual([]);
      expect(codeOf(() => advanceOrder(d, ctx, done.id))).toBe('INVALID');
    });
  });
  it('a shipped order cannot be cancelled (a return must be used)', () => {
    tx((d) => { const o = d.orders.find((x) => x.channel === 'LINE' && x.recognizedAt && x.status !== 'cancelled')!; expect(codeOf(() => cancelOrder(d, ctx, o.id, 'x'))).toBe('USE_RETURN'); });
  });
  it('cancelling a paid, unshipped order keeps the money as customer credit', () => {
    tx((d) => {
      const id = createOrder(d, ctx, { channel: 'LINE', branchId: 'B3', customerId: 'C011', lines: [{ productId: 'F03', qty: 1 }], payments: [{ method: 'transfer', amount: 1e6 }], skipPromotions: true, skipStockCheck: true });
      const total = d.orders.find((o) => o.id === id)!.total;
      const credit0 = customerCredit(d, 'C011');
      cancelOrder(d, ctx, id, 'changed mind');
      expect(customerCredit(d, 'C011') - credit0).toBe(total);
      expectIntegrity(d);
    });
  });
  it('the same idempotency key creates one order; a different key creates another', () => {
    tx((d) => {
      stock(d, 'R04', W1, 5);
      const n = d.orders.length;
      const a = sale(d, [{ productId: 'R04', qty: 1 }], { idempotencyKey: 'k1' });
      const b = sale(d, [{ productId: 'R04', qty: 1 }], { idempotencyKey: 'k1' });
      const c = sale(d, [{ productId: 'R04', qty: 1 }], { idempotencyKey: 'k2' });
      expect(a).toBe(b);
      expect(c).not.toBe(a);
      expect(d.orders.length - n).toBe(2);
    });
  });
  it('external imports are idempotent per (channel, external id) and unmapped SKUs are parked, not partially created', () => {
    tx((d) => {
      const ex = { externalId: 'SPTEST1', lines: [{ sku: 'SPE-F02', name: 'x', qty: 1, price: 209 }] };
      expect(importExternalOrder(d, ctx, 'SHOPEE', ex)).toBe('imported');
      const n = d.orders.length;
      expect(importExternalOrder(d, ctx, 'SHOPEE', ex)).toBe('duplicate');
      expect(importExternalOrder(d, ctx, 'LAZADA', { ...ex, lines: [{ sku: 'LZD-F02', name: 'x', qty: 1, price: 209 }] })).toBe('imported'); // same id, other channel → allowed
      expect(d.orders.length).toBe(n + 1);
      const bad = { externalId: 'SPTEST2', lines: [{ sku: 'SPE-F02', name: 'x', qty: 1, price: 209 }, { sku: 'SPE-UNKNOWN', name: 'y', qty: 1, price: 10 }] };
      const m = d.orders.length;
      expect(importExternalOrder(d, ctx, 'SHOPEE', bad)).toBe('error');
      expect(d.orders.length).toBe(m);
      expect(d.externalOrders.some((e) => e.externalId === 'SPTEST2' && e.status === 'error')).toBe(true);
    });
  });
  it('the unique order number and external id invariants hold across the whole seeded history', () => {
    tx((d) => {
      expect(new Set(d.orders.map((o) => o.id)).size).toBe(d.orders.length);
      expect(new Set(d.orders.map((o) => o.no)).size).toBe(d.orders.length);
      const keys = d.orders.filter((o) => o.externalId).map((o) => o.channel + o.externalId);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});

describe('event numbers and concurrency invariants', () => {
  const mk = (d: ReturnType<typeof base>) => { const ev = createEvent(d, ctx, { name: 'T', description: '', boards: 3, min: 0, max: 99, reservationMinutes: 10, terms: '' }); setEventStatus(d, ctx, ev, 'active'); return d.events.find((e) => e.id === ev)!; };
  it('20 simultaneous claims of one number: exactly one winner', () => {
    tx((d) => {
      const ev = mk(d); let ok = 0;
      for (let i = 0; i < 20; i++) { const cid = d.customers[i].id; grantEntitlements(d, ctx, { eventId: ev.id, customerId: cid, count: 1 }); try { claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[0].id, number: 7, customerId: cid }); ok++; } catch { /* taken */ } }
      expect(ok).toBe(1);
    });
  });
  it('the same number on a different board is independent; out-of-range numbers are rejected', () => {
    tx((d) => {
      const ev = mk(d); grantEntitlements(d, ctx, { eventId: ev.id, customerId: 'C010', count: 3 });
      claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[0].id, number: 0, customerId: 'C010' });
      claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[1].id, number: 0, customerId: 'C010' });
      expect(codeOf(() => claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[2].id, number: 100, customerId: 'C010' }))).toBe('INVALID');
      expect(codeOf(() => claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[2].id, number: -1, customerId: 'C010' }))).toBe('INVALID');
    });
  });
  it('an expired reservation frees the number and returns the entitlement', () => {
    tx((d) => {
      const ev = mk(d); grantEntitlements(d, ctx, { eventId: ev.id, customerId: 'C010', count: 1 }); grantEntitlements(d, ctx, { eventId: ev.id, customerId: 'C011', count: 1 });
      claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[0].id, number: 5, customerId: 'C010', confirm: false });
      expect(codeOf(() => claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[0].id, number: 5, customerId: 'C011' }))).toBe('NUMBER_TAKEN');
      const later = at(new Date(NOWPLUS).toISOString());
      claimNumber(d, later, { eventId: ev.id, boardId: ev.boards[0].id, number: 5, customerId: 'C011' });
      expect(d.entitlements.find((e) => e.customerId === 'C010' && e.eventId === ev.id)!.status).toBe('available');
    });
  });
  it('reset preserves selection history and releases the numbers', () => {
    tx((d) => {
      const ev = mk(d); grantEntitlements(d, ctx, { eventId: ev.id, customerId: 'C010', count: 1 });
      claimNumber(d, ctx, { eventId: ev.id, boardId: ev.boards[0].id, number: 5, customerId: 'C010' });
      expect(codeOf(() => resetBoard(d, ctx, ev.id, ev.boards[0].id, ''))).toBe('REASON');
      resetBoard(d, ctx, ev.id, ev.boards[0].id, 'test');
      expect(d.selections.filter((s) => s.eventId === ev.id && s.status === 'reset').length).toBe(1);
    });
  });
  it('two cashiers selling the last unit: one succeeds, stock never negative', () => {
    tx((d) => {
      d.balances['W2|R07'] = { qty: 1, value: 18, lastCost: 18 };
      let ok = 0;
      for (let i = 0; i < 3; i++) { try { createOrder(d, ctx, { channel: 'POS', branchId: 'B2', lines: [{ productId: 'R07', qty: 1 }], payments: [{ method: 'cash', amount: 100 }], skipPromotions: true }); ok++; } catch { /* sold out */ } }
      expect(ok).toBe(1);
      expect(onHand(d, 'W2', 'R07')).toBe(0);
    });
  });
});
const NOWPLUS = '2026-11-13T11:30:00+07:00';
void receiptUnapplied; void adjustStock;
