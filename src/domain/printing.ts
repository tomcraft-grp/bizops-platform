import type { DB, DocType, ID, Order, OrderType, PrintJob, Station } from './types';
import { Ctx, audit, fail, nid } from './core';
import { dateTimeFmt, money, qtyFmt, r2 } from '../lib/util';

// ---------- routing: Organization → Branch → Station → Order type → Document type
export function resolvePrinter(d: DB, p: { docType: DocType; station?: Station; branchId?: ID; orderType?: OrderType }): ID | null {
  let best: { id: ID; score: number } | null = null;
  for (const r of d.printRules) {
    if (r.docType !== p.docType) continue;
    if (r.station && r.station !== p.station) continue;
    if (r.branchId && r.branchId !== p.branchId) continue;
    if (r.orderType && r.orderType !== p.orderType) continue;
    const score = (r.station ? 4 : 0) + (r.branchId ? 2 : 0) + (r.orderType ? 1 : 0) + r.priority / 100;
    if (!best || score > best.score) best = { id: r.printerId, score };
  }
  return best?.id ?? null;
}

/** Idempotent: the same (doc, ref, station) never produces two jobs unless explicitly reprinted */
export function enqueueJob(
  d: DB, ctx: Ctx,
  p: { docType: DocType; refType: string; refId: ID; station?: Station; branchId?: ID; orderType?: OrderType; reprintOf?: ID; reason?: string; copies?: number },
): ID {
  const base = `${p.docType}:${p.refId}:${p.station ?? ''}`;
  const key = p.reprintOf ? `${base}#R${d.printJobs.filter((j) => j.idempotencyKey.startsWith(base)).length}` : base;
  const dup = d.printJobs.find((j) => j.idempotencyKey === key);
  if (dup) return dup.id;
  const id = nid(d, 'PJ');
  d.printJobs.push({
    id, docType: p.docType, refType: p.refType, refId: p.refId, printerId: resolvePrinter(d, p), status: 'queued', attempts: 0, idempotencyKey: key,
    reprintOf: p.reprintOf, reprintReason: p.reason, createdAt: ctx.now, copies: p.copies ?? 1, station: p.station, createdBy: ctx.userId, branchId: p.branchId,
  });
  return id;
}

export function enqueueOrderPrints(d: DB, ctx: Ctx, o: Order) {
  const common = { refType: 'order', refId: o.id, branchId: o.branchId, orderType: o.orderType };
  if (o.channel === 'POS') enqueueJob(d, ctx, { ...common, docType: 'receipt' });
  else if (CHANNEL_PACKS.includes(o.channel)) enqueueJob(d, ctx, { ...common, docType: 'picking_list' });
  for (const st of ['kitchen', 'beverage'] as Station[]) {
    if (o.lines.some((l) => l.station === st)) enqueueJob(d, ctx, { ...common, docType: st === 'kitchen' ? 'kitchen_ticket' : 'beverage_ticket', station: st });
  }
}
const CHANNEL_PACKS = ['LINE', 'SHOPEE', 'LAZADA', 'TIKTOK'];

/** Simulated Local Print Agent: delivers queued jobs to ONLINE agent printers; browser/PDF printers need a person. */
export function processPrintQueue(d: DB, ctx: Ctx): number {
  let n = 0;
  for (const j of d.printJobs) {
    if (j.status !== 'queued') continue;
    const pr = j.printerId ? d.printers.find((p) => p.id === j.printerId) : undefined;
    if (!pr) { j.status = 'failed'; j.attempts++; j.error = 'No printer routed for this document'; n++; continue; }
    if (pr.connection !== 'agent') continue;
    j.attempts++;
    if (pr.status === 'online') { j.status = 'printed'; j.printedAt = ctx.now; j.error = undefined; pr.lastSeen = ctx.now; }
    else { j.status = 'failed'; j.error = `Printer "${pr.name}" is offline`; }
    n++;
  }
  return n;
}
export function retryJob(d: DB, ctx: Ctx, id: ID) {
  const j = d.printJobs.find((x) => x.id === id) || fail('NOT_FOUND', 'Job not found');
  if (j.status !== 'failed' && j.status !== 'cancelled') fail('INVALID', 'Only failed jobs can be retried');
  j.status = 'queued';
  j.error = undefined;
  j.printerId = resolvePrinter(d, { docType: j.docType, station: j.station, branchId: j.branchId }) ?? j.printerId;
}
export function markPrinted(d: DB, ctx: Ctx, id: ID) {
  const j = d.printJobs.find((x) => x.id === id) || fail('NOT_FOUND', 'Job not found');
  j.status = 'printed';
  j.printedAt = ctx.now;
  j.attempts++;
  j.error = undefined;
}
export function cancelJob(d: DB, id: ID) {
  const j = d.printJobs.find((x) => x.id === id) || fail('NOT_FOUND', 'Job not found');
  j.status = 'cancelled';
}
export function reprintJob(d: DB, ctx: Ctx, id: ID, reason: string): ID {
  if (!reason.trim()) fail('REASON', 'A reprint reason is required');
  const j = d.printJobs.find((x) => x.id === id) || fail('NOT_FOUND', 'Job not found');
  audit(d, ctx, 'print.reprint', 'print_job', id, reason);
  return enqueueJob(d, ctx, { docType: j.docType, refType: j.refType, refId: j.refId, station: j.station, branchId: j.branchId, reprintOf: j.id, reason });
}

// ---------- document rendering (shared by on-screen preview, browser print and the agent)
export type Block =
  | { t: 'title'; text: string; sub?: string }
  | { t: 'center'; text: string; bold?: boolean; big?: boolean }
  | { t: 'text'; text: string; bold?: boolean }
  | { t: 'row'; l: string; r: string; bold?: boolean }
  | { t: 'hr'; dashed?: boolean }
  | { t: 'blank' }
  | { t: 'qr'; data: string }
  | { t: 'table'; head: string[]; rows: string[][]; align?: ('l' | 'r' | 'c')[] };
export interface PrintDoc { title: string; paper: '58mm' | '80mm' | 'A4'; blocks: Block[] }

export function renderDoc(d: DB, docType: DocType, refId: ID, opts: { station?: Station; paper?: '58mm' | '80mm' | 'A4' } = {}): PrintDoc {
  const org = d.org;
  const head = (): Block[] => [
    { t: 'center', text: org.name, bold: true, big: true }, { t: 'center', text: org.address }, { t: 'center', text: `Tax ID ${org.taxId}  Tel ${org.phone}` }, { t: 'hr', dashed: true },
  ];
  const paper = opts.paper ?? '80mm';
  switch (docType) {
    case 'receipt': {
      const o = d.orders.find((x) => x.id === refId) || fail('NOT_FOUND', 'Order not found');
      const cust = o.customerId ? d.customers.find((c) => c.id === o.customerId) : undefined;
      const pays = d.allocations.filter((a) => a.orderId === o.id && a.active).map((a) => ({ a, r: d.receipts.find((r) => r.id === a.receiptId)! }));
      const paid = r2(pays.reduce((s, x) => s + x.a.amount, 0));
      const b: Block[] = [...head(), { t: 'text', text: `RECEIPT / TAX INVOICE (ABB)`, bold: true }, { t: 'row', l: o.no, r: dateTimeFmt(o.createdAt) }];
      if (cust) b.push({ t: 'text', text: `Member: ${cust.name}` });
      b.push({ t: 'hr', dashed: true });
      for (const l of o.lines) {
        b.push({ t: 'row', l: `${qtyFmt(l.qty)} x ${l.name}`, r: money(l.isFree ? 0 : l.qty * l.unitPrice) });
        for (const m of l.modifiers) b.push({ t: 'text', text: `   + ${m.option}${m.priceDelta ? ' ' + money(m.priceDelta) : ''}` });
        if (l.discount > 0) b.push({ t: 'row', l: '   discount', r: '-' + money(l.discount) });
      }
      b.push({ t: 'hr', dashed: true }, { t: 'row', l: 'Subtotal', r: money(o.subtotal) });
      if (o.discountTotal) b.push({ t: 'row', l: 'Discount', r: '-' + money(o.discountTotal) });
      b.push({ t: 'row', l: 'TOTAL', r: money(o.total), bold: true });
      if (o.vatRate) b.push({ t: 'row', l: `incl. VAT ${(o.vatRate * 100).toFixed(0)}%`, r: money(r2(o.total - o.total / (1 + o.vatRate))) });
      for (const x of pays) b.push({ t: 'row', l: x.r?.method?.toUpperCase() ?? 'PAY', r: money(x.a.amount) });
      if (o.total - paid > 0.004) b.push({ t: 'row', l: 'On account (unpaid)', r: money(o.total - paid), bold: true });
      if (o.pointsEarned) b.push({ t: 'text', text: `Points earned: +${o.pointsEarned}` });
      b.push({ t: 'hr', dashed: true }, { t: 'qr', data: `${org.taxId}|${o.no}|${o.total}` }, { t: 'center', text: org.receiptFooter });
      return { title: `Receipt ${o.no}`, paper, blocks: b };
    }
    case 'kitchen_ticket':
    case 'beverage_ticket': {
      const o = d.orders.find((x) => x.id === refId) || fail('NOT_FOUND', 'Order not found');
      const st = opts.station ?? (docType === 'kitchen_ticket' ? 'kitchen' : 'beverage');
      const b: Block[] = [{ t: 'center', text: st === 'kitchen' ? 'KITCHEN' : 'BEVERAGE BAR', bold: true, big: true }, { t: 'center', text: `${o.channel} · ${o.orderType.replace('_', ' ')}${o.tableNo ? ' · Table ' + o.tableNo : ''}` }, { t: 'row', l: o.no, r: dateTimeFmt(o.createdAt), bold: true }, { t: 'hr', dashed: true }];
      for (const l of o.lines.filter((x) => x.station === st)) {
        b.push({ t: 'text', text: `${qtyFmt(l.qty)} x ${l.name.toUpperCase()}`, bold: true });
        for (const m of l.modifiers) b.push({ t: 'text', text: `   - ${m.group}: ${m.option}` });
        if (l.note) b.push({ t: 'text', text: `   NOTE: ${l.note}` });
      }
      if (o.note) b.push({ t: 'hr', dashed: true }, { t: 'text', text: `ORDER NOTE: ${o.note}`, bold: true });
      return { title: `${st === 'kitchen' ? 'Kitchen' : 'Beverage'} ticket ${o.no}`, paper, blocks: b };
    }
    case 'packing_slip':
    case 'picking_list': {
      const o = d.orders.find((x) => x.id === refId) || fail('NOT_FOUND', 'Order not found');
      const cust = o.customerId ? d.customers.find((c) => c.id === o.customerId) : undefined;
      const wh = d.warehouses.find((w) => w.id === o.warehouseId);
      const b: Block[] = [
        { t: 'title', text: docType === 'packing_slip' ? 'Packing slip' : 'Picking list', sub: org.name },
        { t: 'row', l: `Order ${o.no}${o.externalId ? ' · ' + o.externalId : ''}`, r: `${o.channel} · ${dateTimeFmt(o.createdAt)}`, bold: true },
        { t: 'text', text: `Warehouse: ${wh?.name ?? ''}` },
      ];
      if (docType === 'packing_slip') b.push({ t: 'text', text: `Ship to: ${o.shipping?.recipient ?? cust?.name ?? 'Customer'} — ${o.shipping?.address ?? cust?.address ?? ''}` });
      b.push({ t: 'table', head: ['SKU', 'Item', 'Qty', ''], rows: o.lines.map((l) => [l.sku, l.name, qtyFmt(l.qty), '☐']), align: ['l', 'l', 'r', 'c'] });
      return { title: `${docType === 'packing_slip' ? 'Packing slip' : 'Picking list'} ${o.no}`, paper: 'A4', blocks: b };
    }
    case 'purchase_order': {
      const po = d.purchaseOrders.find((x) => x.id === refId) || fail('NOT_FOUND', 'PO not found');
      const sup = d.suppliers.find((s) => s.id === po.supplierId);
      const total = po.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
      return {
        title: `PO ${po.no}`, paper: 'A4',
        blocks: [
          { t: 'title', text: 'Purchase order', sub: org.legalName }, { t: 'row', l: `PO ${po.no}`, r: dateTimeFmt(po.createdAt), bold: true },
          { t: 'text', text: `Supplier: ${sup?.name} · ${sup?.contact} · ${sup?.phone}` }, { t: 'text', text: `Deliver to: ${d.warehouses.find((w) => w.id === po.warehouseId)?.name}` },
          { t: 'table', head: ['Item', 'Qty', 'Unit cost', 'Amount'], align: ['l', 'r', 'r', 'r'], rows: po.lines.map((l) => { const p = d.products.find((x) => x.id === l.productId); return [p?.name ?? l.productId, `${qtyFmt(l.qty)} ${p?.unit ?? ''}`, money(l.unitCost), money(l.qty * l.unitCost)]; }) },
          { t: 'row', l: 'Total (excl. VAT)', r: money(total), bold: true },
        ],
      };
    }
    case 'goods_receipt': {
      const g = d.grns.find((x) => x.id === refId) || fail('NOT_FOUND', 'Receipt not found');
      return {
        title: `GRN ${g.no}`, paper: 'A4',
        blocks: [
          { t: 'title', text: 'Goods receipt note', sub: org.legalName }, { t: 'row', l: g.no, r: dateTimeFmt(g.ts), bold: true },
          { t: 'text', text: `Supplier: ${d.suppliers.find((s) => s.id === g.supplierId)?.name} · Invoice ${g.invoiceNo || '–'}` },
          { t: 'table', head: ['Item', 'Qty', 'Unit cost', 'Landed/unit', 'Lot'], align: ['l', 'r', 'r', 'r', 'l'], rows: g.lines.map((l) => { const p = d.products.find((x) => x.id === l.productId); return [p?.name ?? '', qtyFmt(l.qty), money(l.unitCost), money(l.landedUnit), l.lot ?? '']; }) },
          { t: 'text', text: `Freight ${money(g.freight)} · Handling ${money(g.handling)}` },
        ],
      };
    }
    case 'payment_receipt': {
      const r = d.receipts.find((x) => x.id === refId) || fail('NOT_FOUND', 'Receipt not found');
      const cust = r.customerId ? d.customers.find((c) => c.id === r.customerId) : undefined;
      const allocs = d.allocations.filter((a) => a.receiptId === r.id && a.active);
      const b: Block[] = [...head(), { t: 'text', text: 'PAYMENT RECEIPT', bold: true }, { t: 'row', l: r.no, r: dateTimeFmt(r.ts) }];
      if (cust) b.push({ t: 'text', text: `Received from: ${cust.name}` });
      b.push({ t: 'row', l: `Method: ${r.method}`, r: money(r.amount), bold: true }, { t: 'hr', dashed: true });
      for (const a of allocs) b.push({ t: 'row', l: `Applied to ${d.orders.find((o) => o.id === a.orderId)?.no}`, r: money(a.amount) });
      const un = r2(r.amount - allocs.reduce((s, a) => s + a.amount, 0));
      if (un > 0.004) b.push({ t: 'row', l: 'Kept as customer credit', r: money(un) });
      b.push({ t: 'center', text: 'Thank you' });
      return { title: `Payment ${r.no}`, paper, blocks: b };
    }
    case 'statement': {
      const cust = d.customers.find((c) => c.id === refId) || fail('NOT_FOUND', 'Customer not found');
      return { title: `Statement ${cust.name}`, paper: 'A4', blocks: [{ t: 'title', text: 'Customer statement', sub: `${cust.name} (${cust.code})` }, { t: 'text', text: 'Open the Receivables page for the full running statement.' }] };
    }
    case 'event_report': {
      const ev = d.events.find((x) => x.id === refId) || fail('NOT_FOUND', 'Event not found');
      const act = d.selections.filter((s) => s.eventId === ev.id && s.status === 'confirmed');
      return {
        title: `Event ${ev.name}`, paper: 'A4',
        blocks: [
          { t: 'title', text: ev.name, sub: 'Event report' },
          { t: 'table', head: ['Board', 'No.', 'Customer', 'Confirmed'], align: ['l', 'c', 'l', 'l'], rows: act.sort((a, b) => a.boardId.localeCompare(b.boardId) || a.number - b.number).map((s) => [ev.boards.find((b) => b.id === s.boardId)?.name ?? '', String(s.number).padStart(2, '0'), d.customers.find((c) => c.id === s.customerId)?.name ?? '', dateTimeFmt(s.confirmedAt)]) },
        ],
      };
    }
  }
}

export const jobSummary = (j: PrintJob) => `${j.docType}${j.station ? ' · ' + j.station : ''}`;
