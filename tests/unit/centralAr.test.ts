// Central receivables on the device side (src/domain/centralAr.ts): which orders are sent, how the receivable leaves the device's books when the central invoice
// exists (and the books still reconcile), what the customer still owes for the credit limit, and what can no longer be done locally to a central order.
// The server side (one open invoice per device + order, customer isolation, split payments, no wallet on store invoices) is proven against the real database by
// supabase/tests/central_receivables.sql.
import { describe, expect, it } from 'vitest';
import { codeOf, ctx, expectIntegrity, tx } from '../helpers';
import { createOrder, returnOrder } from '../../src/domain/orders';
import { allocatedMap, createReceipt, customerOutstanding, orderBalance, payStatus, voidReceipt } from '../../src/domain/payments';
import { applyCentralStates, centralCandidates, centralOwing, ensureCentralAccount, localOwing, markOrderCentral } from '../../src/domain/centralAr';
import { reconciliationMatrix } from '../../src/domain/setup';
import { CHART, ROLE_DEFS } from '../../src/domain/accounting';
import { TH } from '../../src/lib/i18n';
import type { DB } from '../../src/domain/types';

const CID = 'C006';
const credit = (d: DB) => { d.customers.find((c) => c.id === CID)!.creditLimit = 1e6; };
/** a POS sale left fully on account for the customer (recognised at once) */
const sale = (d: DB, qty = 2) => createOrder(d, ctx, { channel: 'POS', branchId: 'B1', customerId: CID, lines: [{ productId: 'F02', qty }], payments: [], skipStockCheck: true, skipPromotions: true } as never);
const inv = (d: DB, orderId: string, amount?: number) => ({ invoiceId: 'inv-' + orderId, invoiceNo: 'INV-T-' + orderId, customerId: 'central-1', amount: amount ?? localOwing(d, d.orders.find((o) => o.id === orderId)!) });

describe('which orders go to the central ledger', () => {
  it('a recognised sale left owing for a customer is a candidate; paid, walk-in and already-central orders are not', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const paid = createOrder(d, ctx, { channel: 'POS', branchId: 'B1', customerId: CID, lines: [{ productId: 'F02', qty: 1 }], payments: [{ method: 'cash', amount: 1e6 }], skipStockCheck: true, skipPromotions: true } as never);
      const ids = centralCandidates(d).map((x) => x.order.id);
      expect(ids).toContain(id);
      expect(ids).not.toContain(paid);
      markOrderCentral(d, ctx, id, inv(d, id));
      expect(centralCandidates(d).map((x) => x.order.id)).not.toContain(id);
    });
  });
  it('an order not recognised yet (pay later, not delivered) waits: it has no receivable in the books to move', () => {
    tx((d) => {
      credit(d);
      const id = createOrder(d, ctx, { channel: 'LINE', branchId: 'B3', customerId: CID, lines: [{ productId: 'F02', qty: 1 }], payLater: true, skipStockCheck: true, skipPromotions: true });
      expect(d.orders.find((o) => o.id === id)!.recognizedAt).toBeUndefined();
      expect(centralCandidates(d).map((x) => x.order.id)).not.toContain(id);
    });
  });
  it('"since" keeps orders made before central receivables began out of the automatic sending (the one-time import sends them)', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const later = new Date(Date.parse(ctx.now) + 60_000).toISOString();
      expect(centralCandidates(d, { since: later }).map((x) => x.order.id)).not.toContain(id);
      expect(centralCandidates(d, { since: ctx.now }).map((x) => x.order.id)).toContain(id);
    });
  });
  it('a partly paid order is sent for what it still owes', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const total = d.orders.find((o) => o.id === id)!.total;
      createReceipt(d, ctx, { customerId: CID, amount: 100, method: 'cash', allocations: [{ orderId: id, amount: 100 }] });
      expect(centralCandidates(d).find((x) => x.order.id === id)!.owing).toBeCloseTo(total - 100, 2);
    });
  });
});

describe('the receivable leaves this device\'s books once', () => {
  it('Dr due from the central ledger / Cr customer receivable; the order owes nothing locally; the books still reconcile', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const owing = localOwing(d, d.orders.find((o) => o.id === id)!);
      markOrderCentral(d, ctx, id, inv(d, id));
      const o = d.orders.find((x) => x.id === id)!;
      expect(orderBalance(o, allocatedMap(d)[id] || 0)).toBe(0);
      expect(payStatus(o, 0)).toBe('central');
      expect(o.central).toMatchObject({ invoiceNo: 'INV-T-' + id, amount: owing, outstanding: owing });
      const j = d.journals.filter((x) => x.refType === 'central_invoice' && x.refId === id);
      expect(j).toHaveLength(1);
      expect(j[0].lines.find((l) => l.account === '1135')!.debit).toBeCloseTo(owing, 2);
      expect(j[0].lines.find((l) => l.account === '1130')!.credit).toBeCloseTo(owing, 2);
      const rec = reconciliationMatrix(d);
      expect(rec.find((r) => r.key === 'ar')!.status).toBe('ok');
      expect(rec.find((r) => r.key === 'ar_central')).toMatchObject({ status: 'ok', sub: owing });
      expectIntegrity(d);
    });
  });
  it('the same invoice again changes nothing; another invoice for the same order is refused', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const ref = inv(d, id);
      markOrderCentral(d, ctx, id, ref);
      markOrderCentral(d, ctx, id, ref);
      expect(d.journals.filter((x) => x.refType === 'central_invoice' && x.refId === id)).toHaveLength(1);
      expect(codeOf(() => markOrderCentral(d, ctx, id, { ...ref, invoiceId: 'other', invoiceNo: 'INV-OTHER' }))).toBe('ALREADY_CENTRAL');
    });
  });
  it('an invoice for another amount than the order owes is refused (the order changed meanwhile)', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      expect(codeOf(() => markOrderCentral(d, ctx, id, inv(d, id, 1)))).toBe('AMOUNT_CHANGED');
      expect(d.orders.find((o) => o.id === id)!.central).toBeUndefined();
    });
  });
  it('a device seeded before this change gets the account and its mapping on first use', () => {
    tx((d) => {
      d.accounts = d.accounts.filter((a) => a.code !== '1135');
      delete d.postingMap.ar_central;
      credit(d);
      const id = sale(d);
      markOrderCentral(d, ctx, id, inv(d, id));
      expect(d.accounts.some((a) => a.code === '1135' && a.control === 'ar_central')).toBe(true);
      expect(d.postingMap.ar_central?.[0]?.code).toBe('1135');
      ensureCentralAccount(d);
      expect(d.accounts.filter((a) => a.code === '1135')).toHaveLength(1);
    });
  });
  it('new devices have the account in the chart and the posting role', () => {
    expect(CHART.some((a) => a.code === '1135' && a.control === 'ar_central')).toBe(true);
    expect(ROLE_DEFS.some((r) => r.key === 'ar_central' && r.def === '1135')).toBe(true);
  });
});

describe('after it is central', () => {
  it('what the server says is still owed: shown on the order and counted for the credit limit', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const ref = inv(d, id);
      const before = customerOutstanding(d, CID);
      markOrderCentral(d, ctx, id, ref);
      expect(customerOutstanding(d, CID)).toBeCloseTo(before - ref.amount, 2);   // local ledger: the order no longer counts there
      expect(centralOwing(d, CID)).toBeCloseTo(ref.amount, 2);
      const n = applyCentralStates(d, ctx, [{ order_id: id, invoice_id: ref.invoiceId, invoice_no: ref.invoiceNo, customer_id: 'central-1', amount: ref.amount, status: 'open', outstanding: 40, confirmed_pending: 10 }]);
      expect(n).toBe(1);
      expect(d.orders.find((o) => o.id === id)!.central).toMatchObject({ outstanding: 40, pending: 10 });
      expect(centralOwing(d, CID)).toBe(40);
      applyCentralStates(d, ctx, [{ order_id: id, invoice_id: ref.invoiceId, invoice_no: ref.invoiceNo, customer_id: 'central-1', amount: ref.amount, status: 'open', outstanding: 0, confirmed_pending: 0 }]);
      expect(payStatus(d.orders.find((o) => o.id === id)!, 0)).toBe('paid');
    });
  });
  it('a state for another invoice (a cancelled one replaced later) does not touch the order', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const ref = inv(d, id);
      markOrderCentral(d, ctx, id, ref);
      expect(applyCentralStates(d, ctx, [{ order_id: id, invoice_id: 'some-other', invoice_no: 'X', customer_id: 'c', amount: 1, status: 'cancelled', outstanding: 0, confirmed_pending: 0 }])).toBe(0);
      expect(d.orders.find((o) => o.id === id)!.central!.outstanding).toBeCloseTo(ref.amount, 2);
    });
  });
  it('the credit limit counts central invoices still owing', () => {
    tx((d) => {
      const c = d.customers.find((x) => x.id === CID)!;
      c.creditLimit = 1e6;
      const id = sale(d);
      const ref = inv(d, id);
      markOrderCentral(d, ctx, id, ref);
      c.creditLimit = r(customerOutstanding(d, CID) + ref.amount + 1);
      expect(codeOf(() => sale(d, 50))).toBe('CREDIT_LIMIT');
    });
  });
  it('no local receipt for a central order (it owes nothing here); a local return or voiding its earlier receipt is refused', () => {
    tx((d) => {
      credit(d);
      const id = sale(d);
      const rc = createReceipt(d, ctx, { customerId: CID, amount: 50, method: 'cash', allocations: [{ orderId: id, amount: 50 }] });
      markOrderCentral(d, ctx, id, inv(d, id));
      expect(codeOf(() => createReceipt(d, ctx, { customerId: CID, amount: 10, method: 'cash', allocations: [{ orderId: id, amount: 10 }] }))).toBe('OVER_ALLOCATION');
      const o = d.orders.find((x) => x.id === id)!;
      expect(codeOf(() => returnOrder(d, ctx, { orderId: id, lines: [{ lineId: o.lines[0].id, qty: 1, restock: false }], reason: 'test', refund: 'credit' }))).toBe('CENTRAL_INVOICE');
      expect(codeOf(() => voidReceipt(d, ctx, rc, 'test'))).toBe('CENTRAL_INVOICE');
      expectIntegrity(d);
    });
  });
});

describe('Thai', () => {
  it('the new screens are translated', () => {
    for (const k of ['Central ledger', 'Send open balances to the central ledger', 'Link customer', 'Record payment', 'Billed in the central ledger by invoice', 'Due from the central ledger (store credit sales)']) expect(TH[k], k).toBeTruthy();
  });
});

const r = (n: number) => Math.round(n * 100) / 100;
