import type { DB, GRNLine, ID, PayMethod, POEvent, PurchaseOrder, SupplierInvoice } from './types';
import { Ctx, audit, docNo, fail, nid, product, guard } from './core';
import { cashAccount, cr, dr, invAccount, post, purchaseVatRate, reverseJournal } from './accounting';
import { moveStock, onHand } from './inventory';
import { addDays, r2, r3 } from '../lib/util';

// ---------- amounts
/** What is still owed on a supplier invoice. A voided invoice (its goods receipt was reversed) owes nothing. */
export const apOpen = (i: SupplierInvoice) => (i.status === 'void' ? 0 : r2(i.amount - i.paid - i.creditNotes));
/** Supplier invoices that count: voided ones are history, not documents (VAT, payables). */
export const liveAp = (d: DB) => d.apInvoices.filter((i) => i.status !== 'void');
/** A PO line's value after the supplier's discount (for `qty` units; default the ordered quantity). */
export const lineNet = (l: { qty: number; unitCost: number; discountPct?: number }, qty = l.qty) => r2(qty * l.unitCost * (1 - (l.discountPct ?? 0) / 100));
export const poTotal = (po: PurchaseOrder) => r2(po.lines.reduce((s, l) => s + lineNet(l), 0));
const netUnit = (l: { unitCost: number; discountPct?: number }) => l.unitCost * (1 - (l.discountPct ?? 0) / 100);

const stamp = (po: PurchaseOrder, ctx: Ctx, action: POEvent['action'], note?: string) => { (po.history ||= []).push({ ts: ctx.now, by: ctx.userId, action, ...(note ? { note } : {}) }); };
const getPO = (d: DB, id: ID) => d.purchaseOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'PO not found');
const money = (n: unknown): n is number => typeof n === 'number' && isFinite(n);

type LineIn = { productId: ID; qty: number; unitCost: number; discountPct?: number };
/** The lines of a purchase order, checked: real items, a quantity and a price, a sensible discount, each item once (receiving works per item, so a repeated item would never be receivable). */
function cleanLines(d: DB, input: LineIn[]) {
  const lines = input.filter((l) => l.productId && l.qty > 0);
  if (!lines.length) fail('INVALID', 'Add at least one line');
  const seen = new Set<ID>();
  return lines.map((l) => {
    const p = product(d, l.productId);
    if (!money(l.qty) || !money(l.unitCost) || l.unitCost < 0) fail('INVALID', `${p.name}: enter a quantity and a price (zero or more)`);
    const disc = l.discountPct ?? 0;
    if (!money(disc) || disc < 0 || disc > 100) fail('INVALID', `${p.name}: the discount must be between 0 and 100%`);
    if (seen.has(l.productId)) fail('DUPLICATE_LINE', `${p.name} is on the order twice: put the whole quantity on one line`);
    seen.add(l.productId);
    return { productId: l.productId, qty: r3(l.qty), unitCost: l.unitCost, receivedQty: 0, ...(disc ? { discountPct: disc } : {}) };
  });
}
/** The supplier's usual items learn from what is ordered, so the next order offers them first. */
function learnItems(d: DB, supplierId: ID, lines: { productId: ID }[]) {
  const s = d.suppliers.find((x) => x.id === supplierId);
  if (!s) return;
  for (const l of lines) if (!s.productIds.includes(l.productId)) s.productIds.push(l.productId);
}

// ---------- purchase orders
export function createPO(
  d: DB, ctx: Ctx, p: { supplierId: ID; warehouseId: ID; lines: LineIn[]; expectedAt?: string; note?: string; send?: boolean },
): ID {
  guard(d, ctx, 'purchasing:create');
  if (!d.suppliers.some((s) => s.id === p.supplierId)) fail('NOT_FOUND', 'Supplier not found');
  if (!d.warehouses.some((w) => w.id === p.warehouseId)) fail('NOT_FOUND', 'Choose the warehouse the goods are delivered to');
  const lines = cleanLines(d, p.lines);
  const id = nid(d, 'PO');
  const send = p.send !== false;
  const po: PurchaseOrder = {
    id, no: docNo(d, 'PO'), supplierId: p.supplierId, warehouseId: p.warehouseId, status: send ? 'sent' : 'draft',
    lines, createdAt: ctx.now, expectedAt: p.expectedAt, note: p.note, createdBy: ctx.userId,
  };
  stamp(po, ctx, 'created');
  if (send) { po.approvedBy = ctx.userId; po.approvedAt = ctx.now; stamp(po, ctx, 'approved'); }
  d.purchaseOrders.push(po);
  if (send) learnItems(d, p.supplierId, lines);                              // a draft changes nothing else; the supplier learns the items when the order is sent
  return id;
}

/** Change a draft (nothing has been sent to the supplier yet). A sent order is cancelled and made again instead, so the supplier's copy never differs from ours. */
export function updatePO(
  d: DB, ctx: Ctx, id: ID, p: { supplierId?: ID; warehouseId?: ID; lines?: LineIn[]; expectedAt?: string; note?: string },
) {
  guard(d, ctx, 'purchasing:create');
  const po = getPO(d, id);
  if (po.status !== 'draft') fail('INVALID', 'Only a draft can be edited. Cancel a sent order and make a new one');
  if (p.supplierId && !d.suppliers.some((s) => s.id === p.supplierId)) fail('NOT_FOUND', 'Supplier not found');
  if (p.warehouseId && !d.warehouses.some((w) => w.id === p.warehouseId)) fail('NOT_FOUND', 'Choose the warehouse the goods are delivered to');
  const lines = p.lines ? cleanLines(d, p.lines) : po.lines;
  if (p.supplierId) po.supplierId = p.supplierId;
  if (p.warehouseId) po.warehouseId = p.warehouseId;
  if (p.expectedAt !== undefined) po.expectedAt = p.expectedAt;
  if (p.note !== undefined) po.note = p.note;
  po.lines = lines;
  stamp(po, ctx, 'edited');
}

/** Approve a draft and send it to the supplier: stamps who approved and when. It is a stamp, not a second person's gate (a one-person shop approves its own order). */
export function approvePO(d: DB, ctx: Ctx, id: ID) {
  guard(d, ctx, 'purchasing:create');
  const po = getPO(d, id);
  if (po.status !== 'draft') fail('INVALID', 'Only a draft order can be sent');
  po.status = 'sent'; po.approvedBy = ctx.userId; po.approvedAt = ctx.now;
  stamp(po, ctx, 'approved');
  learnItems(d, po.supplierId, po.lines);
}
export const sendPO = approvePO;

export function cancelPO(d: DB, ctx: Ctx, id: ID, reason = '') {
  guard(d, ctx, 'purchasing:edit');
  const po = getPO(d, id);
  if (po.lines.some((l) => l.receivedQty > 0)) fail('INVALID', 'Goods were already received — close the PO instead');
  if (po.status !== 'draft' && po.status !== 'sent') fail('INVALID', `A ${po.status} order cannot be cancelled`);
  po.status = 'cancelled';
  if (reason.trim()) po.closedReason = reason.trim();
  stamp(po, ctx, 'cancelled', reason.trim() || undefined);
  audit(d, ctx, 'purchase.cancel', 'purchase_order', po.id, `${po.no} cancelled${reason.trim() ? ': ' + reason.trim() : ''}`, 'warn');
}
/** Close an order that was only partly delivered: the rest will not come. */
export function closePO(d: DB, ctx: Ctx, id: ID, reason = '') {
  guard(d, ctx, 'purchasing:edit');
  const po = getPO(d, id);
  if (po.status !== 'partial') fail('INVALID', 'Only an order that is partly received can be closed. Cancel one that has nothing received');
  po.status = 'closed';
  if (reason.trim()) po.closedReason = reason.trim();
  stamp(po, ctx, 'closed', reason.trim() || undefined);
  audit(d, ctx, 'purchase.close', 'purchase_order', po.id, `${po.no} closed short${reason.trim() ? ': ' + reason.trim() : ''}`, 'warn');
}
const poStatusAfter = (po: PurchaseOrder): PurchaseOrder['status'] =>
  po.lines.every((l) => l.receivedQty >= l.qty - 1e-6) ? 'received' : po.lines.some((l) => l.receivedQty > 1e-6) ? 'partial' : 'sent';

// ---------- goods receipt
export function receiveGoods(
  d: DB, ctx: Ctx,
  p: { poId: ID; lines: { productId: ID; qty: number; lot?: string; expiry?: string }[]; freight?: number; handling?: number; invoiceNo?: string; date?: string; key?: string },
): ID {
  guard(d, ctx, 'purchasing:edit');
  // the same request again (a double click, a retry): the first receipt, never a second one
  const idemKey = p.key ? 'grn:' + p.key : null;
  if (idemKey && d.meta.idem[idemKey]) {
    const g = d.grns.find((x) => x.id === d.meta.idem[idemKey]);
    if (g && !g.reversal) return g.id;
    fail('DUPLICATE_KEY', 'This request was already used for a receipt that has since been reversed. Reload the page and try again');
  }
  const po = getPO(d, p.poId);
  if (po.status !== 'sent' && po.status !== 'partial') fail('INVALID', po.status === 'draft' ? 'Send (approve) the order before receiving goods' : `PO is ${po.status}`);
  const sup = d.suppliers.find((s) => s.id === po.supplierId) || fail('NOT_FOUND', 'Supplier not found');
  const lines = p.lines.filter((l) => l.qty > 0);
  if (!lines.length) fail('INVALID', 'Enter at least one received quantity');
  const freight = p.freight ?? 0, handling = p.handling ?? 0;
  if (!money(freight) || !money(handling) || freight < 0 || handling < 0) fail('INVALID', 'Freight and handling must be zero or more');
  if (new Set(lines.map((l) => l.productId)).size !== lines.length) fail('DUPLICATE_LINE', 'An item is on the receipt twice');
  const invoiceNo = (p.invoiceNo ?? '').trim();
  if (invoiceNo && d.apInvoices.some((i) => i.supplierId === sup.id && i.status !== 'void' && i.invoiceNo.trim().toLowerCase() === invoiceNo.toLowerCase())) {
    fail('DUPLICATE_INVOICE', `Supplier invoice ${invoiceNo} from ${sup.name} was already recorded`);
  }
  const landed = r2(freight + handling);
  const goods = lines.reduce((s, l) => {
    const pl = po.lines.find((x) => x.productId === l.productId) || fail('INVALID', 'Product is not on this PO');
    return s + lineNet(pl, l.qty);
  }, 0);
  const grnId = nid(d, 'GR');
  const invId = nid(d, 'AI');
  const debits: Record<string, number> = {};
  const grnLines: GRNLine[] = [];
  let allocated = 0;
  lines.forEach((l, i) => {
    const pl = po.lines.find((x) => x.productId === l.productId)!;
    const remaining = r3(pl.qty - pl.receivedQty);
    if (!money(l.qty)) fail('INVALID', 'Quantity must be a number');
    if (l.qty > remaining + 1e-6) fail('OVER_RECEIPT', `${product(d, l.productId).name}: receiving ${l.qty} exceeds outstanding ${remaining}`);
    const base = lineNet(pl, l.qty);
    const share = i === lines.length - 1 ? r2(landed - allocated) : goods > 0 ? r2((landed * base) / goods) : 0;
    allocated = r2(allocated + share);
    const value = r2(base + share);
    moveStock(d, ctx, { productId: l.productId, warehouseId: po.warehouseId, qty: l.qty, type: 'receipt', refType: 'grn', refId: grnId, value, lot: l.lot, expiry: l.expiry });
    pl.receivedQty = r3(pl.receivedQty + l.qty);
    const a = invAccount(product(d, l.productId).kind);
    debits[a] = (debits[a] || 0) + value;
    grnLines.push({ productId: l.productId, qty: l.qty, unitCost: pl.unitCost, landedUnit: r2(share / l.qty), lot: l.lot, expiry: l.expiry, ...(pl.discountPct ? { discountPct: pl.discountPct } : {}) });
  });
  const net = r2(goods);
  const vat = sup.vatable ? r2(net * purchaseVatRate(d, p.date ?? ctx.now)) : 0;
  const amount = r2(net + vat + landed);
  const date = p.date ?? ctx.now;
  const jid = post(d, ctx, {
    date, memo: `Goods receipt from ${sup.name}`, refType: 'grn', refId: grnId,
    lines: [...Object.entries(debits).map(([a, v]) => dr(a, v)), dr('input_vat', vat), cr('ap', amount)],
  });
  d.apInvoices.push({
    id: invId, no: docNo(d, 'AP'), supplierId: sup.id, poId: po.id, grnId, invoiceNo: invoiceNo || `INV-${sup.code}-${grnId}`, date,
    dueDate: addDays(date, sup.termsDays).toISOString(), net, vat, landed, amount, paid: 0, creditNotes: 0, status: 'open',
  });
  const grnNo = docNo(d, 'GRN');
  d.grns.push({ id: grnId, no: grnNo, poId: po.id, supplierId: sup.id, warehouseId: po.warehouseId, ts: date, lines: grnLines, freight, handling, invoiceNo, invoiceId: invId, journalId: jid, createdBy: ctx.userId });
  po.status = poStatusAfter(po);
  stamp(po, ctx, 'received', grnNo);
  learnItems(d, sup.id, lines);
  if (idemKey) d.meta.idem[idemKey] = grnId;
  return grnId;
}

/** Units of a lot on hand in a warehouse, from the movement ledger (balances are kept per item and warehouse, not per lot). */
export function lotOnHand(d: DB, wh: ID, pid: ID, lot: string): number {
  let q = 0;
  for (const m of d.movements) if (m.warehouseId === wh && m.productId === pid && m.lot === lot) q += m.qty;
  return r3(q);
}

/**
 * Reverse a goods receipt that was wrong (wrong quantity, wrong supplier, never arrived). Nothing is deleted: the stock goes back out, the receipt's journal is mirrored,
 * the supplier invoice is voided and the order's received quantities roll back.
 *  - The stock leaves at the CURRENT average cost (that is what keeps the stock records right). The receipt journal is mirrored at its ORIGINAL value; the difference between the two
 *    (what the receipt was worth less what left) goes to the inventory adjustment account, so the ledger and the stock records still agree.
 *  - It is refused when the goods are no longer there (used, sold, moved), or when the invoice has a payment, a credit note or a supplier return: reverse or finish those first.
 */
export function reverseGoodsReceipt(d: DB, ctx: Ctx, grnId: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'purchasing:approve');
  const why = reason.trim();
  if (why.length < 3) fail('REASON', 'A reason is required to reverse a goods receipt');
  const idemKey = key ? 'grnrev:' + key : null;
  if (idemKey && d.meta.idem[idemKey] && d.meta.idem[idemKey] !== grnId) fail('DUPLICATE_KEY', 'This request was already used for another receipt. Reload the page and try again');
  const g = d.grns.find((x) => x.id === grnId) || fail('NOT_FOUND', 'Goods receipt not found');
  if (g.reversal) { if (idemKey && d.meta.idem[idemKey] === grnId) return grnId; fail('ALREADY', `${g.no} was already reversed`); }
  const inv = d.apInvoices.find((i) => i.id === g.invoiceId);
  if (inv) {
    if (inv.paid > 0.004 || inv.creditNotes > 0.004) fail('IN_USE', `${inv.no} has a payment or a credit note: reverse the payment first (a returned item is a supplier return, not a reversal)`);
    if (d.supplierReturns.some((r) => r.invoiceId === inv.id)) fail('IN_USE', `A supplier return refers to ${inv.no}: a receipt with returns cannot be reversed`);
  }
  const whName = d.warehouses.find((w) => w.id === g.warehouseId)?.name ?? g.warehouseId;
  for (const l of g.lines) {
    const prod = product(d, l.productId), have = onHand(d, g.warehouseId, l.productId);
    if (have + 1e-6 < l.qty) fail('INSUFFICIENT_STOCK', `Only ${have} of the ${l.qty} ${prod.unit} of ${prod.name} received with ${g.no} are still in ${whName}. The rest was used, sold or moved`);
    if (l.lot && lotOnHand(d, g.warehouseId, l.productId, l.lot) + 1e-6 < l.qty) fail('INSUFFICIENT_STOCK', `Lot ${l.lot} of ${prod.name} has less than the ${l.qty} ${prod.unit} received with ${g.no}`);
  }
  const original = d.movements.filter((m) => m.refType === 'grn' && m.refId === g.id);
  const diffs: Record<string, number> = {};
  for (const l of g.lines) {
    const prod = product(d, l.productId);
    const out = moveStock(d, ctx, { productId: l.productId, warehouseId: g.warehouseId, qty: -l.qty, type: 'adjust', refType: 'grn_reversal', refId: g.id, note: `Reversal of ${g.no}: ${why}`, lot: l.lot });
    const was = original.find((m) => m.productId === l.productId)?.value ?? 0;
    const a = invAccount(prod.kind);
    diffs[a] = r2((diffs[a] || 0) + was + out.value);                       // out.value is negative: what the receipt was worth less what left
  }
  // the receipt's journal, mirrored at its original value (a journal somebody reversed by hand is not reversed twice)
  const j = g.journalId ? d.journals.find((x) => x.id === g.journalId) : undefined;
  const mirrorId = j && j.status !== 'reversed' ? reverseJournal(d, ctx, j.id, `${g.no}: ${why}`, { fromPurchasing: true }) : j?.reversedBy;
  const list = Object.entries(diffs).filter(([, x]) => x), stockDiff = r2(list.reduce((s, [, x]) => s + x, 0));
  let diffJournalId: ID | undefined;
  if (list.length) {
    diffJournalId = post(d, ctx, {
      memo: `Reversal of ${g.no}: average cost difference`, refType: 'grn', refId: g.id,
      lines: [...list.map(([a, x]) => (x > 0 ? dr(a, x) : cr(a, -x))), stockDiff > 0 ? cr('inv_adjust', stockDiff) : dr('inv_adjust', -stockDiff)],
    });
  }
  if (inv) inv.status = 'void';
  const po = d.purchaseOrders.find((x) => x.id === g.poId);
  if (po) {
    for (const l of g.lines) { const pl = po.lines.find((x) => x.productId === l.productId); if (pl) pl.receivedQty = r3(Math.max(0, pl.receivedQty - l.qty)); }
    if (po.status !== 'cancelled') { po.status = poStatusAfter(po); po.closedReason = undefined; }
    stamp(po, ctx, 'receipt_reversed', `${g.no}: ${why}`);
  }
  g.reversal = { ts: ctx.now, by: ctx.userId, reason: why, journalId: mirrorId, diffJournalId, stockDiff };
  audit(d, ctx, 'purchase.reverse_receipt', 'goods_receipt', g.id, `${g.no} reversed: ${why}`, 'warn');
  if (idemKey) d.meta.idem[idemKey] = grnId;
  return grnId;
}

// ---------- payables
export function supplierDeposit(d: DB, supplierId: ID): number {
  let v = 0;
  for (const p of d.supplierPayments) if (p.supplierId === supplierId && !p.reversal) v += p.method === 'deposit' ? -p.amount : p.deposit;
  for (const r of d.supplierReturns) if (r.supplierId === supplierId) v += r.deposit ?? 0;     // a credit note for an invoice that was already paid
  return r2(v);
}

export function paySupplier(
  d: DB, ctx: Ctx,
  p: { supplierId: ID; amount: number; method: PayMethod | 'deposit'; allocations?: { invoiceId: ID; amount: number }[] | 'fifo'; note?: string },
): ID {
  guard(d, ctx, 'purchasing:approve');
  if (!money(p.amount) || !(p.amount > 0)) fail('INVALID', 'Amount must be greater than zero');
  const open = d.apInvoices.filter((i) => i.supplierId === p.supplierId && apOpen(i) > 0.004).sort((a, b) => a.date.localeCompare(b.date));
  let allocs: { invoiceId: ID; amount: number }[] = [];
  if (!p.allocations || p.allocations === 'fifo') {
    let left = p.amount;
    for (const i of open) {
      if (left <= 0.004) break;
      const a = Math.min(left, apOpen(i));
      allocs.push({ invoiceId: i.id, amount: r2(a) });
      left = r2(left - a);
    }
  } else allocs = p.allocations.filter((a) => a.amount > 0);
  const allocTotal = r2(allocs.reduce((s, a) => s + a.amount, 0));
  if (allocTotal > p.amount + 0.004) fail('OVER_ALLOCATION', 'Allocated amount exceeds payment amount');
  for (const a of allocs) {
    const inv = d.apInvoices.find((i) => i.id === a.invoiceId && i.supplierId === p.supplierId) || fail('INVALID', 'Invoice not found for supplier');
    if (a.amount > apOpen(inv!) + 0.004) fail('OVER_ALLOCATION', `${inv!.no}: allocation exceeds outstanding ${apOpen(inv!)}`);
  }
  if (p.method === 'deposit') {
    if (p.amount > supplierDeposit(d, p.supplierId) + 0.004) fail('INSUFFICIENT_DEPOSIT', 'Not enough supplier deposit balance');
    if (allocTotal < p.amount - 0.004) fail('INVALID', 'Deposit can only be applied to open invoices');
  }
  const deposit = p.method === 'deposit' ? 0 : r2(p.amount - allocTotal);
  for (const a of allocs) {
    const inv = d.apInvoices.find((i) => i.id === a.invoiceId)!;
    inv.paid = r2(inv.paid + a.amount);
    inv.status = apOpen(inv) <= 0.004 ? 'paid' : 'partial';
  }
  const id = nid(d, 'SP');
  const jid = post(d, ctx, {
    memo: `Supplier payment ${d.suppliers.find((s) => s.id === p.supplierId)?.name}`, refType: 'supplier_payment', refId: id,
    lines: p.method === 'deposit'
      ? [dr('ap', allocTotal), cr('supplier_deposit', allocTotal)]
      : [dr('ap', allocTotal), dr('supplier_deposit', deposit), cr(cashAccount(p.method), p.amount)],
  });
  d.supplierPayments.push({ id, no: docNo(d, 'SPY'), supplierId: p.supplierId, ts: ctx.now, amount: p.amount, method: p.method, allocations: allocs, deposit, note: p.note, journalId: jid });
  return id;
}

/**
 * Cancel a supplier payment that was wrong. The payment stays on record (marked reversed); its journal is mirrored and the invoices it paid owe that money again.
 * Refused when the part of it that was kept as a supplier deposit has already been used, or when an invoice it paid was voided meanwhile.
 */
export function voidSupplierPayment(d: DB, ctx: Ctx, paymentId: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'purchasing:approve');
  const why = reason.trim();
  if (why.length < 3) fail('REASON', 'A reason is required to cancel a supplier payment');
  const idemKey = key ? 'sprev:' + key : null;
  if (idemKey && d.meta.idem[idemKey] && d.meta.idem[idemKey] !== paymentId) fail('DUPLICATE_KEY', 'This request was already used for another payment. Reload the page and try again');
  const pay = d.supplierPayments.find((x) => x.id === paymentId) || fail('NOT_FOUND', 'Supplier payment not found');
  if (pay.reversal) { if (idemKey && d.meta.idem[idemKey] === paymentId) return paymentId; fail('ALREADY', `${pay.no} was already cancelled`); }
  if (pay.method !== 'deposit' && supplierDeposit(d, pay.supplierId) + 1e-6 < pay.deposit) fail('IN_USE', `The ${pay.deposit} of ${pay.no} that was kept as a supplier deposit has already been used`);
  for (const a of pay.allocations) {
    const inv = d.apInvoices.find((i) => i.id === a.invoiceId);
    if (inv?.status === 'void') fail('IN_USE', `${inv.no} was voided after this payment: the money cannot be put back on it`);
  }
  for (const a of pay.allocations) {
    const inv = d.apInvoices.find((i) => i.id === a.invoiceId);
    if (!inv) continue;
    inv.paid = r2(Math.max(0, inv.paid - a.amount));
    inv.status = apOpen(inv) <= 0.004 ? 'paid' : inv.paid > 0.004 ? 'partial' : 'open';
  }
  const mirrorId = pay.journalId && d.journals.find((j) => j.id === pay.journalId)?.status !== 'reversed' ? reverseJournal(d, ctx, pay.journalId, `${pay.no}: ${why}`, { fromPurchasing: true }) : undefined;
  pay.reversal = { ts: ctx.now, by: ctx.userId, reason: why, journalId: mirrorId };
  audit(d, ctx, 'purchase.void_payment', 'supplier_payment', pay.id, `${pay.no} cancelled: ${why}`, 'warn');
  if (idemKey) d.meta.idem[idemKey] = paymentId;
  return paymentId;
}

/** The price the supplier invoiced for an item: on the given invoice's receipt, else on the last receipt from that supplier (after its discount). */
function invoicedPrice(d: DB, supplierId: ID, productId: ID, invoiceId?: ID): number | undefined {
  const lastFirst = [...d.grns].filter((g) => g.supplierId === supplierId && !g.reversal && (!invoiceId || g.invoiceId === invoiceId)).reverse();
  for (const g of lastFirst) { const l = g.lines.find((x) => x.productId === productId); if (l) return netUnit(l); }
  return invoiceId ? invoicedPrice(d, supplierId, productId) : undefined;
}

/**
 * Send goods back to a supplier and take a credit note.
 *  - The credit is at the price the supplier invoiced; the stock leaves at the current average cost; the difference goes to the inventory adjustment account.
 *  - The credit takes down the chosen invoice (or the oldest open ones when none is chosen). What no open invoice can take (the invoice was already paid) is kept as a supplier deposit,
 *    so the payables in the ledger and the supplier invoices always agree.
 */
export function returnToSupplier(
  d: DB, ctx: Ctx, p: { supplierId: ID; warehouseId: ID; lines: { productId: ID; qty: number }[]; invoiceId?: ID; reason: string },
): ID {
  guard(d, ctx, 'purchasing:approve');
  const sup = d.suppliers.find((s) => s.id === p.supplierId) || fail('NOT_FOUND', 'Supplier not found');
  if (!p.reason.trim()) fail('REASON', 'A reason is required for a return');
  const wanted = p.lines.filter((x) => x.qty > 0);
  if (!wanted.length) fail('INVALID', 'Add at least one line');
  if (new Set(wanted.map((x) => x.productId)).size !== wanted.length) fail('DUPLICATE_LINE', 'An item is on the return twice');
  if (p.invoiceId && !d.apInvoices.some((i) => i.id === p.invoiceId && i.supplierId === sup.id && i.status !== 'void')) fail('INVALID', 'Invoice not found for this supplier');
  const id = nid(d, 'SR');
  const rl: { productId: ID; qty: number; unitCost: number }[] = [];
  const stockCredits: Record<string, number> = {};
  let credit = 0, stockOut = 0;
  for (const l of wanted) {
    if (!money(l.qty)) fail('INVALID', 'Quantity must be a number');
    const m = moveStock(d, ctx, { productId: l.productId, warehouseId: p.warehouseId, qty: -l.qty, type: 'return_out', refType: 'supplier_return', refId: id, note: p.reason });
    const price = invoicedPrice(d, sup.id, l.productId, p.invoiceId) ?? m.unitCost;
    const a = invAccount(product(d, l.productId).kind);
    stockCredits[a] = r2((stockCredits[a] || 0) - m.value);
    stockOut = r2(stockOut - m.value);
    credit = r2(credit + l.qty * price);
    rl.push({ productId: l.productId, qty: l.qty, unitCost: price });
  }
  const vat = sup.vatable ? r2(credit * purchaseVatRate(d, ctx.now)) : 0;
  const amount = r2(credit + vat);
  // what the credit takes off: the chosen invoice, else the oldest open ones; the rest becomes a supplier deposit
  const targets = p.invoiceId ? d.apInvoices.filter((i) => i.id === p.invoiceId) : d.apInvoices.filter((i) => i.supplierId === sup.id && apOpen(i) > 0.004).sort((a, b) => a.date.localeCompare(b.date));
  const applied: { invoiceId: ID; amount: number }[] = [];
  let left = amount;
  for (const inv of targets) {
    const take = r2(Math.min(left, apOpen(inv)));
    if (take <= 0.004) continue;
    inv.creditNotes = r2(inv.creditNotes + take);
    inv.status = apOpen(inv) <= 0.004 ? 'paid' : inv.paid > 0.004 || inv.creditNotes > 0.004 ? 'partial' : 'open';
    applied.push({ invoiceId: inv.id, amount: take });
    left = r2(left - take);
  }
  const deposit = r2(left);
  const priceDiff = r2(credit - stockOut);                                  // credited at the invoiced price, stock left at average cost
  post(d, ctx, {
    memo: `Supplier credit note ${sup.name}: ${p.reason}`, refType: 'supplier_return', refId: id,
    lines: [dr('ap', amount - deposit), dr('supplier_deposit', deposit), ...Object.entries(stockCredits).map(([a, v]) => cr(a, v)), cr('input_vat', vat),
      priceDiff > 0 ? cr('inv_adjust', priceDiff) : dr('inv_adjust', -priceDiff)],
  });
  d.supplierReturns.push({ id, no: docNo(d, 'SRT'), supplierId: sup.id, warehouseId: p.warehouseId, ts: ctx.now, reason: p.reason, lines: rl, amount, vat, invoiceId: p.invoiceId, applied, deposit });
  audit(d, ctx, 'purchase.return', 'supplier', sup.id, `Return ${amount} to ${sup.name}: ${p.reason}`, 'warn');
  return id;
}

/** Purchase price history per product from goods receipts (after the supplier's discount; reversed receipts are left out) */
export function priceHistory(d: DB, pid: ID) {
  return d.grns
    .filter((g) => !g.reversal)
    .flatMap((g) => g.lines.filter((l) => l.productId === pid).map((l) => ({ ts: g.ts, unitCost: netUnit(l), landed: l.landedUnit, supplierId: g.supplierId })))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
