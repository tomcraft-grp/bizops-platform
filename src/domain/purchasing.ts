import type { DB, GRNLine, ID, PayMethod, PurchaseOrder, SupplierInvoice } from './types';
import { Ctx, audit, docNo, fail, nid, product, guard } from './core';
import { cashAccount, cr, dr, invAccount, post, purchaseVatRate } from './accounting';
import { moveStock } from './inventory';
import { addDays, r2, r3 } from '../lib/util';

export const apOpen = (i: SupplierInvoice) => r2(i.amount - i.paid - i.creditNotes);
export const poTotal = (po: PurchaseOrder) => r2(po.lines.reduce((s, l) => s + l.qty * l.unitCost, 0));

export function createPO(
  d: DB, ctx: Ctx, p: { supplierId: ID; warehouseId: ID; lines: { productId: ID; qty: number; unitCost: number }[]; expectedAt?: string; note?: string; send?: boolean },
): ID {
  guard(d, ctx, 'purchasing:create');
  const lines = p.lines.filter((l) => l.qty > 0);
  if (!lines.length) fail('INVALID', 'Add at least one line');
  if (!d.suppliers.some((s) => s.id === p.supplierId)) fail('NOT_FOUND', 'Supplier not found');
  const id = nid(d, 'PO');
  d.purchaseOrders.push({
    id, no: docNo(d, 'PO'), supplierId: p.supplierId, warehouseId: p.warehouseId, status: p.send === false ? 'draft' : 'sent',
    lines: lines.map((l) => ({ ...l, receivedQty: 0 })), createdAt: ctx.now, expectedAt: p.expectedAt, note: p.note, createdBy: ctx.userId,
  });
  return id;
}
export function sendPO(d: DB, id: ID) {
  const po = d.purchaseOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'PO not found');
  if (po.status !== 'draft') fail('INVALID', 'Only draft POs can be sent');
  po.status = 'sent';
}
export function cancelPO(d: DB, ctx: Ctx, id: ID) {
  guard(d, ctx, 'purchasing:edit');
  const po = d.purchaseOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'PO not found');
  if (po.lines.some((l) => l.receivedQty > 0)) fail('INVALID', 'Goods were already received — close the PO instead');
  po.status = 'cancelled';
}
export function closePO(d: DB, ctx: Ctx, id: ID) {
  guard(d, ctx, 'purchasing:edit');
  const po = d.purchaseOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'PO not found');
  po.status = 'closed';
}

export function receiveGoods(
  d: DB, ctx: Ctx,
  p: { poId: ID; lines: { productId: ID; qty: number; lot?: string; expiry?: string }[]; freight?: number; handling?: number; invoiceNo?: string; date?: string },
): ID {
  guard(d, ctx, 'purchasing:edit');
  const po = d.purchaseOrders.find((x) => x.id === p.poId) || fail('NOT_FOUND', 'PO not found');
  if (['received', 'closed', 'cancelled'].includes(po.status)) fail('INVALID', `PO is ${po.status}`);
  const sup = d.suppliers.find((s) => s.id === po.supplierId)!;
  const lines = p.lines.filter((l) => l.qty > 0);
  if (!lines.length) fail('INVALID', 'Enter at least one received quantity');
  const freight = p.freight ?? 0, handling = p.handling ?? 0;
  const landed = r2(freight + handling);
  const goods = lines.reduce((s, l) => {
    const pl = po.lines.find((x) => x.productId === l.productId) || fail('INVALID', 'Product is not on this PO');
    return s + l.qty * pl.unitCost;
  }, 0);
  const grnId = nid(d, 'GR');
  const invId = nid(d, 'AI');
  const debits: Record<string, number> = {};
  const grnLines: GRNLine[] = [];
  let allocated = 0;
  lines.forEach((l, i) => {
    const pl = po.lines.find((x) => x.productId === l.productId)!;
    const remaining = r3(pl.qty - pl.receivedQty);
    if (l.qty > remaining + 1e-6) fail('OVER_RECEIPT', `${product(d, l.productId).name}: receiving ${l.qty} exceeds outstanding ${remaining}`);
    const base = r2(l.qty * pl.unitCost);
    const share = i === lines.length - 1 ? r2(landed - allocated) : goods > 0 ? r2((landed * base) / goods) : 0;
    allocated = r2(allocated + share);
    const value = r2(base + share);
    moveStock(d, ctx, { productId: l.productId, warehouseId: po.warehouseId, qty: l.qty, type: 'receipt', refType: 'grn', refId: grnId, value, lot: l.lot, expiry: l.expiry });
    pl.receivedQty = r3(pl.receivedQty + l.qty);
    const a = invAccount(product(d, l.productId).kind);
    debits[a] = (debits[a] || 0) + value;
    grnLines.push({ productId: l.productId, qty: l.qty, unitCost: pl.unitCost, landedUnit: r2(share / l.qty), lot: l.lot, expiry: l.expiry });
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
    id: invId, no: docNo(d, 'AP'), supplierId: sup.id, poId: po.id, grnId, invoiceNo: p.invoiceNo || `INV-${sup.code}-${grnId}`, date,
    dueDate: addDays(date, sup.termsDays).toISOString(), net, vat, landed, amount, paid: 0, creditNotes: 0, status: 'open',
  });
  d.grns.push({ id: grnId, no: docNo(d, 'GRN'), poId: po.id, supplierId: sup.id, warehouseId: po.warehouseId, ts: date, lines: grnLines, freight, handling, invoiceNo: p.invoiceNo || '', invoiceId: invId, journalId: jid, createdBy: ctx.userId });
  po.status = po.lines.every((l) => l.receivedQty >= l.qty - 1e-6) ? 'received' : 'partial';
  return grnId;
}

export function supplierDeposit(d: DB, supplierId: ID): number {
  let v = 0;
  for (const p of d.supplierPayments) if (p.supplierId === supplierId) v += p.method === 'deposit' ? -p.amount : p.deposit;
  return r2(v);
}

export function paySupplier(
  d: DB, ctx: Ctx,
  p: { supplierId: ID; amount: number; method: PayMethod | 'deposit'; allocations?: { invoiceId: ID; amount: number }[] | 'fifo'; note?: string },
): ID {
  guard(d, ctx, 'purchasing:approve');
  if (!(p.amount > 0)) fail('INVALID', 'Amount must be greater than zero');
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

export function returnToSupplier(
  d: DB, ctx: Ctx, p: { supplierId: ID; warehouseId: ID; lines: { productId: ID; qty: number }[]; invoiceId?: ID; reason: string },
): ID {
  guard(d, ctx, 'purchasing:approve');
  const sup = d.suppliers.find((s) => s.id === p.supplierId) || fail('NOT_FOUND', 'Supplier not found');
  const id = nid(d, 'SR');
  const rl = [];
  const credits: Record<string, number> = {};
  let value = 0;
  for (const l of p.lines.filter((x) => x.qty > 0)) {
    const m = moveStock(d, ctx, { productId: l.productId, warehouseId: p.warehouseId, qty: -l.qty, type: 'return_out', refType: 'supplier_return', refId: id, note: p.reason });
    const a = invAccount(product(d, l.productId).kind);
    credits[a] = (credits[a] || 0) + -m.value;
    value += -m.value;
    rl.push({ productId: l.productId, qty: l.qty, unitCost: m.unitCost });
  }
  if (!rl.length) fail('INVALID', 'Add at least one line');
  value = r2(value);
  const vat = sup.vatable ? r2(value * purchaseVatRate(d, ctx.now)) : 0;
  const amount = r2(value + vat);
  post(d, ctx, { memo: `Supplier credit note ${sup.name}: ${p.reason}`, refType: 'supplier_return', refId: id, lines: [dr('ap', amount), ...Object.entries(credits).map(([a, v]) => cr(a, v)), cr('input_vat', vat)] });
  if (p.invoiceId) {
    const inv = d.apInvoices.find((i) => i.id === p.invoiceId);
    if (inv) {
      inv.creditNotes = r2(inv.creditNotes + Math.min(amount, apOpen(inv)));
      inv.status = apOpen(inv) <= 0.004 ? 'paid' : inv.paid > 0 ? 'partial' : 'open';
    }
  }
  d.supplierReturns.push({ id, no: docNo(d, 'SRT'), supplierId: sup.id, warehouseId: p.warehouseId, ts: ctx.now, reason: p.reason, lines: rl, amount, vat, invoiceId: p.invoiceId });
  audit(d, ctx, 'purchase.return', 'supplier', sup.id, `Return ${amount} to ${sup.name}: ${p.reason}`, 'warn');
  return id;
}

/** Purchase price history per product from goods receipts */
export function priceHistory(d: DB, pid: ID) {
  return d.grns
    .flatMap((g) => g.lines.filter((l) => l.productId === pid).map((l) => ({ ts: g.ts, unitCost: l.unitCost, landed: l.landedUnit, supplierId: g.supplierId })))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
