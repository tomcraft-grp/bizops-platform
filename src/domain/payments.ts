import type { ChannelCode, DB, ID, Order, PayMethod, Receipt, Settlement, SlipRequest } from './types';
import { Ctx, audit, docNo, fail, nid, guard } from './core';
import { cashAccount, cr, dr, post, reverseJournal } from './accounting';
import { r2 } from '../lib/util';

// ---------- derived views over the receipt/allocation ledger
export function allocatedMap(d: DB): Record<ID, number> {
  const m: Record<ID, number> = {};
  for (const a of d.allocations) if (a.active) m[a.orderId] = (m[a.orderId] || 0) + a.amount;
  return m;
}
/** What the customer still owes on an order (negative = we owe them a refund) */
export function orderBalance(o: Order, allocated: number): number {
  if (o.collectedBy === 'platform' || o.status === 'cancelled') return 0;
  return r2(o.total - o.creditNoted - allocated + o.refundsPaid);
}
export type PayStatus = 'unpaid' | 'partial' | 'paid' | 'overpaid' | 'platform' | 'void';
export function payStatus(o: Order, allocated: number): PayStatus {
  if (o.status === 'cancelled') return 'void';
  if (o.collectedBy === 'platform') return 'platform';
  const bal = orderBalance(o, allocated);
  if (bal < -0.004) return 'overpaid';
  if (bal <= 0.004) return 'paid';
  return allocated > 0.004 ? 'partial' : 'unpaid';
}
export function receiptAllocated(d: DB, receiptId: ID): number {
  let s = 0;
  for (const a of d.allocations) if (a.receiptId === receiptId && a.active) s += a.amount;
  return r2(s);
}
export const receiptUnapplied = (d: DB, r: Receipt) => (r.status === 'void' ? 0 : r2(r.amount - receiptAllocated(d, r.id)));
export function customerCredit(d: DB, cid: ID): number {
  let s = 0;
  for (const r of d.receipts) if (r.customerId === cid && r.status === 'posted') s += receiptUnapplied(d, r);
  return r2(s);
}
export function outstandingOrders(d: DB, cid: ID, alloc = allocatedMap(d)) {
  return d.orders
    .filter((o) => o.customerId === cid && o.collectedBy === 'merchant' && o.status !== 'cancelled')
    .map((o) => ({ order: o, balance: orderBalance(o, alloc[o.id] || 0) }))
    .filter((x) => x.balance > 0.004)
    .sort((a, b) => a.order.createdAt.localeCompare(b.order.createdAt));
}
export function customerOutstanding(d: DB, cid: ID, alloc = allocatedMap(d)) {
  return r2(outstandingOrders(d, cid, alloc).reduce((s, x) => s + x.balance, 0));
}

// ---------- receipts
export function createReceipt(
  d: DB, ctx: Ctx,
  p: { customerId?: ID; amount: number; method: PayMethod; reference?: string; slipId?: ID; allocations?: { orderId: ID; amount: number }[] | 'fifo'; note?: string },
): ID {
  guard(d, ctx, 'receivables:create');
  if (!(p.amount > 0)) fail('INVALID', 'Payment amount must be greater than zero');
  const alloc = allocatedMap(d);
  let allocs: { orderId: ID; amount: number }[] = [];
  if (p.allocations === 'fifo') {
    if (!p.customerId) fail('INVALID', 'FIFO allocation needs a customer');
    let left = p.amount;
    for (const x of outstandingOrders(d, p.customerId!, alloc)) {
      if (left <= 0.004) break;
      const a = r2(Math.min(left, x.balance));
      allocs.push({ orderId: x.order.id, amount: a });
      left = r2(left - a);
    }
  } else allocs = (p.allocations ?? []).filter((a) => a.amount > 0);
  const allocTotal = r2(allocs.reduce((s, a) => s + a.amount, 0));
  if (allocTotal > p.amount + 0.004) fail('OVER_ALLOCATION', 'Allocated amount exceeds the payment');
  for (const a of allocs) {
    const o = d.orders.find((x) => x.id === a.orderId) || fail('NOT_FOUND', 'Order not found');
    if (p.customerId && o!.customerId !== p.customerId) fail('INVALID', `${o!.no} belongs to another customer`);
    const bal = orderBalance(o!, alloc[o!.id] || 0);
    if (a.amount > bal + 0.004) fail('OVER_ALLOCATION', `${o!.no}: allocation ${a.amount} exceeds outstanding ${bal}`);
  }
  const unapplied = r2(p.amount - allocTotal);
  if (unapplied > 0.004 && !p.customerId) fail('NEEDS_CUSTOMER', 'An overpayment can only be kept as credit for a known customer');
  const id = nid(d, 'RC');
  const jid = post(d, ctx, {
    memo: `Receipt${p.reference ? ' ' + p.reference : ''} (${p.method})`, refType: 'receipt', refId: id,
    lines: [dr(cashAccount(p.method), p.amount), cr('ar', allocTotal), cr('customer_credit', unapplied)],
  });
  d.receipts.push({ id, no: docNo(d, 'RCP'), ts: ctx.now, customerId: p.customerId, amount: p.amount, method: p.method, reference: p.reference, slipId: p.slipId, status: 'posted', journalId: jid, note: p.note, createdBy: ctx.userId });
  for (const a of allocs) d.allocations.push({ id: nid(d, 'AL'), receiptId: id, orderId: a.orderId, amount: a.amount, ts: ctx.now, active: true, kind: 'payment' });
  return id;
}

/** Use existing unapplied credit (overpayments / refunds-to-credit) against an order */
export function applyCredit(d: DB, ctx: Ctx, p: { customerId: ID; orderId: ID; amount: number }) {
  guard(d, ctx, 'receivables:create');
  const o = d.orders.find((x) => x.id === p.orderId) || fail('NOT_FOUND', 'Order not found');
  const alloc = allocatedMap(d);
  const bal = orderBalance(o!, alloc[o!.id] || 0);
  const credit = customerCredit(d, p.customerId);
  const amt = r2(Math.min(p.amount, bal, credit));
  if (amt <= 0.004) fail('INVALID', 'No credit available or nothing outstanding on this order');
  let left = amt;
  for (const r of d.receipts.filter((x) => x.customerId === p.customerId && x.status === 'posted').sort((a, b) => a.ts.localeCompare(b.ts))) {
    const un = receiptUnapplied(d, r);
    if (un <= 0.004) continue;
    const take = r2(Math.min(un, left));
    d.allocations.push({ id: nid(d, 'AL'), receiptId: r.id, orderId: o!.id, amount: take, ts: ctx.now, active: true, kind: 'credit' });
    left = r2(left - take);
    if (left <= 0.004) break;
  }
  post(d, ctx, { memo: `Customer credit applied to ${o!.no}`, refType: 'credit_applied', refId: o!.id, lines: [dr('customer_credit', amt), cr('ar', amt)] });
  return amt;
}

export function voidReceipt(d: DB, ctx: Ctx, id: ID, reason: string) {
  guard(d, ctx, 'receivables:cancel');
  if (!reason.trim()) fail('REASON', 'A reason is required to void a receipt');
  const r = d.receipts.find((x) => x.id === id) || fail('NOT_FOUND', 'Receipt not found');
  if (r.status === 'void') fail('ALREADY', 'Receipt is already void');
  if (d.allocations.some((a) => a.receiptId === id && a.active && a.kind !== 'payment')) fail('INVALID', 'Credit from this receipt has been applied or refunded — reverse that first');
  for (const a of d.allocations) if (a.receiptId === id) a.active = false;
  if (r.journalId) reverseJournal(d, ctx, r.journalId, reason);
  r.status = 'void';
  r.voidReason = reason;
  if (r.slipId) { const s = d.slips.find((x) => x.id === r.slipId); if (s) { s.status = 'pending'; s.receiptId = undefined; } }
  audit(d, ctx, 'receipt.void', 'receipt', id, `${r.no} voided: ${reason}`, 'critical');
}

/** Move an order's overpayment onto the customer's credit balance */
export function refundToCredit(d: DB, ctx: Ctx, orderId: ID, amount: number) {
  guard(d, ctx, 'receivables:approve');
  const o = d.orders.find((x) => x.id === orderId) || fail('NOT_FOUND', 'Order not found');
  if (!o!.customerId) fail('NEEDS_CUSTOMER', 'Credit requires a customer');
  const bal = orderBalance(o!, allocatedMap(d)[orderId] || 0);
  if (amount > -bal + 0.004) fail('INVALID', 'Amount exceeds the refundable overpayment');
  let left = amount;
  const paid = d.allocations.filter((a) => a.orderId === orderId && a.active && a.amount > 0).sort((a, b) => b.ts.localeCompare(a.ts));
  for (const a of paid) {
    const take = r2(Math.min(left, a.amount));
    d.allocations.push({ id: nid(d, 'AL'), receiptId: a.receiptId, orderId, amount: -take, ts: ctx.now, active: true, kind: 'reversal' });
    left = r2(left - take);
    if (left <= 0.004) break;
  }
  post(d, ctx, { memo: `Overpayment on ${o!.no} moved to customer credit`, refType: 'refund_credit', refId: orderId, lines: [dr('ar', amount), cr('customer_credit', amount)] });
}
export function refundCash(d: DB, ctx: Ctx, orderId: ID, amount: number, method: 'cash' | 'transfer') {
  guard(d, ctx, 'receivables:approve');
  const o = d.orders.find((x) => x.id === orderId) || fail('NOT_FOUND', 'Order not found');
  const bal = orderBalance(o!, allocatedMap(d)[orderId] || 0);
  if (amount > -bal + 0.004) fail('INVALID', 'Amount exceeds the refundable overpayment');
  o!.refundsPaid = r2(o!.refundsPaid + amount);
  post(d, ctx, { memo: `Refund paid for ${o!.no} (${method})`, refType: 'refund_paid', refId: orderId, lines: [dr('ar', amount), cr(cashAccount(method), amount)] });
}

// ---------- payment evidence (slips)
export function slipDuplicates(d: DB, s: SlipRequest) {
  const exact = s.checksum ? d.slips.filter((x) => x.id !== s.id && x.checksum === s.checksum && x.status !== 'rejected') : [];
  const business = d.slips.filter(
    (x) => x.id !== s.id && x.status !== 'rejected' && x.customerId === s.customerId && Math.abs(x.amount - s.amount) < 0.005 &&
      (x.reference && x.reference === s.reference || Math.abs(new Date(x.createdAt).getTime() - new Date(s.createdAt).getTime()) < 86400000),
  );
  return { exact, business };
}
export function submitSlip(
  d: DB, ctx: Ctx, p: { customerId: ID; amount: number; orderIds?: ID[]; reference?: string; mediaId?: ID; checksum?: string; transferAt?: string; note?: string },
): ID {
  if (!(p.amount > 0)) fail('INVALID', 'Enter the transferred amount');
  if (p.checksum && d.slips.some((x) => x.checksum === p.checksum && x.status !== 'rejected')) fail('DUPLICATE_SLIP', 'This exact slip image was already submitted');
  const id = nid(d, 'SL');
  d.slips.push({ id, customerId: p.customerId, orderIds: p.orderIds ?? [], amount: p.amount, reference: p.reference, mediaId: p.mediaId, checksum: p.checksum, createdAt: ctx.now, status: 'pending', transferAt: p.transferAt, note: p.note });
  return id;
}
export function approveSlip(d: DB, ctx: Ctx, id: ID, p?: { allocations?: { orderId: ID; amount: number }[] | 'fifo'; amount?: number }): ID {
  guard(d, ctx, 'receivables:approve');
  const s = d.slips.find((x) => x.id === id) || fail('NOT_FOUND', 'Slip not found');
  if (s.status !== 'pending') fail('INVALID', `Slip is already ${s.status}`);
  const amount = p?.amount ?? s.amount;
  let allocations = p?.allocations;
  if (!allocations) {
    if (s.orderIds.length) {
      const alloc = allocatedMap(d);
      let left = amount;
      allocations = [];
      for (const oid of s.orderIds) {
        const o = d.orders.find((x) => x.id === oid);
        if (!o) continue;
        const bal = orderBalance(o, alloc[oid] || 0);
        const a = r2(Math.min(left, Math.max(0, bal)));
        if (a > 0) { allocations.push({ orderId: oid, amount: a }); left = r2(left - a); }
      }
    } else allocations = 'fifo';
  }
  const rid = createReceipt(d, ctx, { customerId: s.customerId, amount, method: 'transfer', reference: s.reference, slipId: s.id, allocations, note: 'Verified from payment slip' });
  s.status = 'approved';
  s.reviewerId = ctx.userId;
  s.reviewedAt = ctx.now;
  s.receiptId = rid;
  audit(d, ctx, 'slip.approve', 'slip', id, `Approved slip ${id} for ${amount}`);
  return rid;
}
export function rejectSlip(d: DB, ctx: Ctx, id: ID, reason: string) {
  guard(d, ctx, 'receivables:approve');
  if (!reason.trim()) fail('REASON', 'A rejection reason is required');
  const s = d.slips.find((x) => x.id === id) || fail('NOT_FOUND', 'Slip not found');
  if (s.status !== 'pending') fail('INVALID', `Slip is already ${s.status}`);
  s.status = 'rejected';
  s.reviewerId = ctx.userId;
  s.reviewedAt = ctx.now;
  s.rejectReason = reason;
  audit(d, ctx, 'slip.reject', 'slip', id, reason, 'warn');
}

// ---------- platform settlements
export const settleable = (d: DB, channel: ChannelCode) =>
  d.orders.filter((o) => o.channel === channel && o.collectedBy === 'platform' && o.recognizedAt && !o.settlementId && ['completed', 'returned'].includes(o.status));

export function createSettlement(
  d: DB, ctx: Ctx, p: { channel: ChannelCode; orderIds: ID[]; actual?: { commission: number; paymentFee: number; shippingSubsidy: number } },
): ID {
  guard(d, ctx, 'receivables:approve');
  const orders = p.orderIds.map((id) => d.orders.find((o) => o.id === id)).filter(Boolean) as Order[];
  if (!orders.length) fail('INVALID', 'Select at least one order');
  if (orders.some((o) => o.settlementId || o.channel !== p.channel)) fail('INVALID', 'An order is already settled or belongs to another channel');
  const gross = r2(orders.reduce((s, o) => s + o.total - o.creditNoted, 0));
  const est = {
    commission: r2(orders.reduce((s, o) => s + o.fees.commission, 0)),
    paymentFee: r2(orders.reduce((s, o) => s + o.fees.paymentFee, 0)),
    shippingSubsidy: r2(orders.reduce((s, o) => s + o.fees.shippingSubsidy, 0)),
  };
  const a = p.actual ?? est;
  const id = nid(d, 'ST');
  const dates = orders.map((o) => o.createdAt).sort();
  const st: Settlement = {
    id, no: docNo(d, 'STL'), channel: p.channel, createdAt: ctx.now, periodFrom: dates[0], periodTo: dates[dates.length - 1], orderIds: p.orderIds,
    gross, commission: r2(a.commission), paymentFee: r2(a.paymentFee), shippingSubsidy: r2(a.shippingSubsidy),
    net: r2(gross - a.commission - a.paymentFee - a.shippingSubsidy), status: 'pending',
  };
  d.settlements.push(st);
  for (const o of orders) { o.settlementId = id; o.settledAmount = r2(o.total - o.creditNoted); }
  return id;
}
export function receiveSettlement(d: DB, ctx: Ctx, id: ID, receivedAmount?: number) {
  guard(d, ctx, 'receivables:approve');
  const st = d.settlements.find((x) => x.id === id) || fail('NOT_FOUND', 'Settlement not found');
  if (st.status === 'received') fail('ALREADY', 'Settlement already received');
  const received = r2(receivedAmount ?? st.net);
  const variance = r2(received - st.net);
  post(d, ctx, {
    memo: `Settlement ${st.no} (${st.channel})`, refType: 'settlement', refId: st.id, dim: { channel: st.channel },
    lines: [
      dr('bank', received), dr('fee_commission', st.commission), dr('fee_payment', st.paymentFee), dr('fee_shipping', st.shippingSubsidy),
      cr('platform_ar', st.gross), variance < 0 ? dr('settlement_variance', -variance) : cr('settlement_variance', variance),
    ],
  });
  // make order-level economics final: distribute actual fees over the settled orders by value
  const orders = st.orderIds.map((oid) => d.orders.find((o) => o.id === oid)!).filter(Boolean);
  const base = orders.reduce((s, o) => s + o.total - o.creditNoted, 0) || 1;
  let cLeft = st.commission, pLeft = st.paymentFee, sLeft = st.shippingSubsidy;
  orders.forEach((o, i) => {
    const w = (o.total - o.creditNoted) / base;
    const last = i === orders.length - 1;
    const c = last ? cLeft : r2(st.commission * w), pf = last ? pLeft : r2(st.paymentFee * w), sh = last ? sLeft : r2(st.shippingSubsidy * w);
    cLeft = r2(cLeft - c); pLeft = r2(pLeft - pf); sLeft = r2(sLeft - sh);
    o.fees = { commission: c, paymentFee: pf, shippingSubsidy: sh, estimated: false };
  });
  st.status = 'received';
  st.receivedAt = ctx.now;
  st.receivedAmount = received;
  st.variance = variance;
}

// ---------- customer statement (running ledger) & aging
export interface StatementRow { date: string; type: 'invoice' | 'credit_note' | 'receipt' | 'refund'; ref: string; note?: string; debit: number; credit: number; balance: number; orderId?: ID }
export function customerStatement(d: DB, cid: ID, fromDay?: string, toDay?: string) {
  const raw: Omit<StatementRow, 'balance'>[] = [];
  for (const o of d.orders) {
    if (o.customerId !== cid || o.collectedBy !== 'merchant' || o.status === 'cancelled') continue;
    raw.push({ date: o.createdAt, type: 'invoice', ref: o.no, note: o.channel, debit: o.total, credit: 0, orderId: o.id });
  }
  for (const r of d.returns) {
    const o = d.orders.find((x) => x.id === r.orderId);
    if (o?.customerId === cid && o.collectedBy === 'merchant') raw.push({ date: r.ts, type: 'credit_note', ref: r.no, note: `for ${o.no}`, debit: 0, credit: r.amount, orderId: o.id });
  }
  for (const rc of d.receipts) if (rc.customerId === cid && rc.status === 'posted') raw.push({ date: rc.ts, type: 'receipt', ref: rc.no, note: rc.method + (rc.reference ? ' ' + rc.reference : ''), debit: 0, credit: rc.amount });
  for (const j of d.journals) {
    if (j.refType !== 'refund_paid' || j.status === 'reversed') continue;
    const o = d.orders.find((x) => x.id === j.refId);
    if (o?.customerId === cid) raw.push({ date: j.date, type: 'refund', ref: j.no, note: `refund ${o.no}`, debit: j.lines.reduce((s, l) => s + l.credit, 0), credit: 0, orderId: o.id });
  }
  raw.sort((a, b) => a.date.localeCompare(b.date));
  const dk = (s: string) => { const x = new Date(s); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  let bal = 0;
  let opening = 0;
  const rows: StatementRow[] = [];
  for (const r of raw) {
    const k = dk(r.date);
    if (fromDay && k < fromDay) { bal = r2(bal + r.debit - r.credit); opening = bal; continue; }
    if (toDay && k > toDay) continue;
    bal = r2(bal + r.debit - r.credit);
    rows.push({ ...r, balance: bal });
  }
  return { opening, rows, closing: bal };
}

export const AGING_BUCKETS = ['Current', '1–30', '31–60', '61–90', '90+'] as const;
export function agingFor(d: DB, now: string, dueDays: (cid?: ID) => number = () => 0) {
  const alloc = allocatedMap(d);
  const out: Record<ID, number[]> = {};
  const t = new Date(now).getTime();
  for (const o of d.orders) {
    if (!o.customerId || o.collectedBy !== 'merchant' || o.status === 'cancelled') continue;
    const bal = orderBalance(o, alloc[o.id] || 0);
    if (bal <= 0.004) continue;
    const due = new Date(o.createdAt).getTime() + dueDays(o.customerId) * 86400000;
    const late = Math.floor((t - due) / 86400000);
    const idx = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    (out[o.customerId] ||= [0, 0, 0, 0, 0])[idx] += bal;
  }
  return out;
}
