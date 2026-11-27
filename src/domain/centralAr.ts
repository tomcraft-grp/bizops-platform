// Store credit sales billed in the central ledger (Supabase finance_invoices, migration 20261122130000). Owner's decision (2026-11-22): the invoice and its payments
// are booked by the accountant's ledger queue, so this device moves the receivable OUT of its own books when the central invoice exists
// (Dr "Due from the central ledger" / Cr customer receivable) and never books the cash of a central payment itself (that would count it twice).
// From then on the order owes nothing locally (no local receipt can be made for it); what the customer still owes comes from the server (order.central.outstanding),
// and it still counts towards the customer's credit limit here.
import type { DB, ID, Order } from './types';
import { Ctx, audit, fail } from './core';
import { cr, dr, post, roleCode } from './accounting';
import { r2 } from '../lib/util';

export const CENTRAL_AR_ACCOUNT = '1135';
export const CENTRAL_AR_ROLE = 'ar_central';

export interface CentralInvoiceRef { invoiceId: string; invoiceNo: string; customerId: string; amount: number }
export interface CentralState { order_id: string; invoice_id: string; invoice_no: string; customer_id: string; amount: number; status: string; outstanding: number; confirmed_pending: number }

/** Devices seeded before this change have no "due from the central ledger" account or mapping: add them once (new devices get them from the chart). */
export function ensureCentralAccount(d: DB) {
  if (!d.accounts.some((a) => a.code === CENTRAL_AR_ACCOUNT)) {
    d.accounts.push({ code: CENTRAL_AR_ACCOUNT, name: 'Due from the central ledger (store credit sales)', nameTh: 'ลูกหนี้ที่โอนไปบัญชีกลาง (ขายเชื่อหน้าร้าน)', type: 'asset', normal: 'debit',
      group: 'Receivables', fsLine: 'receivables', posting: true, active: true, effectiveFrom: '2020-01-01T00:00:00.000Z', parent: '1020', control: CENTRAL_AR_ROLE, system: true });
  }
  if (!roleCode(d, CENTRAL_AR_ROLE, '2020-01-02T00:00:00.000Z') && !(d.postingMap[CENTRAL_AR_ROLE]?.length)) {
    d.postingMap[CENTRAL_AR_ROLE] = [{ code: CENTRAL_AR_ACCOUNT, from: '2020-01-01T00:00:00.000Z' }];
  }
}

const LOCAL_ALLOC = (d: DB, orderId: ID) => r2(d.allocations.filter((a) => a.active && a.orderId === orderId).reduce((s, a) => s + a.amount, 0));
/** What the order owes in THIS device's books, ignoring the central flag (the amount a central invoice must have). */
export const localOwing = (d: DB, o: Order) => (o.collectedBy === 'platform' || o.status === 'cancelled' ? 0 : r2(o.total - o.creditNoted - LOCAL_ALLOC(d, o.id) + o.refundsPaid));

/** The order is billed by central invoice `inv`: move its receivable out of the local books once. A second call for the same invoice changes nothing. */
export function markOrderCentral(d: DB, ctx: Ctx, orderId: ID, inv: CentralInvoiceRef) {
  const o = d.orders.find((x) => x.id === orderId) || fail('NOT_FOUND', 'Order not found');
  if (o!.central) {
    if (o!.central.invoiceId === inv.invoiceId) return;
    fail('ALREADY_CENTRAL', `${o!.no} is already billed by central invoice ${o!.central.invoiceNo}`);
  }
  const owing = localOwing(d, o!);
  if (Math.abs(owing - inv.amount) > 0.009) fail('AMOUNT_CHANGED', `${o!.no} now owes ${owing}, but the central invoice is for ${inv.amount}. Check the order and send it again.`);
  ensureCentralAccount(d);
  post(d, ctx, { memo: `${o!.no} moved to the central ledger (${inv.invoiceNo})`, refType: 'central_invoice', refId: o!.id, lines: [dr(CENTRAL_AR_ROLE, inv.amount), cr('ar', inv.amount)] });
  o!.central = { invoiceId: inv.invoiceId, invoiceNo: inv.invoiceNo, customerId: inv.customerId, amount: inv.amount, outstanding: inv.amount, pending: 0, at: ctx.now };
  audit(d, ctx, 'order.central', 'order', o!.id, `${o!.no}: ${inv.amount} billed by central invoice ${inv.invoiceNo}`);
}

/** What the server says the central invoices of this device's orders still owe. Only orders already marked central are touched; returns how many changed. */
export function applyCentralStates(d: DB, ctx: Ctx, states: CentralState[]): number {
  let n = 0;
  for (const s of states) {
    const o = d.orders.find((x) => x.id === s.order_id && x.central?.invoiceId === s.invoice_id);
    if (!o?.central) continue;
    const outstanding = s.status === 'cancelled' ? 0 : r2(Number(s.outstanding) || 0);
    const pending = r2(Number(s.confirmed_pending) || 0);
    if (o.central.outstanding !== outstanding || o.central.pending !== pending || (o.central.cancelled ?? false) !== (s.status === 'cancelled')) {
      o.central = { ...o.central, outstanding, pending, cancelled: s.status === 'cancelled' || undefined };
      n++;
    }
    o.central.syncedAt = ctx.now;
  }
  return n;
}

/** Orders that should be billed centrally: merchant-collected, for a customer, recognised (the sale is booked: delivered / served), not cancelled, owing something
 *  locally and not central yet. An order not recognised yet has no receivable in the books to move; it is sent once it is. */
export function centralCandidates(d: DB, opts: { since?: string; customerId?: ID } = {}) {
  return d.orders
    .filter((o) => !o.central && o.customerId && o.recognizedAt && o.collectedBy === 'merchant' && o.status !== 'cancelled' && (!opts.customerId || o.customerId === opts.customerId) && (!opts.since || o.createdAt >= opts.since))
    .map((o) => ({ order: o, owing: localOwing(d, o) }))
    .filter((x) => x.owing > 0.004)
    .sort((a, b) => a.order.createdAt.localeCompare(b.order.createdAt));
}

/** What a customer still owes on central invoices of this device's orders (as last synced). */
export function centralOwing(d: DB, cid: ID) {
  let s = 0;
  for (const o of d.orders) if (o.customerId === cid && o.central && !o.central.cancelled) s += o.central.outstanding;
  return r2(s);
}
