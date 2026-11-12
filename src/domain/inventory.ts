import type { Balance, DB, ID, Movement, MoveType, Transfer, StockCount } from './types';
import { Ctx, audit, docNo, fail, nid, product } from './core';
import { cr, dr, invAccount, post } from './accounting';
import { r2, r3 } from '../lib/util';

export const bkey = (wh: ID, pid: ID) => `${wh}|${pid}`;
export function getBal(d: DB, wh: ID, pid: ID): Balance {
  return d.balances[bkey(wh, pid)] || { qty: 0, value: 0, lastCost: 0 };
}
export const onHand = (d: DB, wh: ID, pid: ID) => getBal(d, wh, pid).qty;
export function avgCost(d: DB, wh: ID, pid: ID): number {
  const b = getBal(d, wh, pid);
  if (b.qty > 0.0001) return b.value / b.qty;
  return b.lastCost || product(d, pid).stdCost;
}
/** Weighted-average cost across all warehouses (fallback to std cost) */
export function globalAvgCost(d: DB, pid: ID): number {
  let q = 0, v = 0, last = 0;
  for (const k in d.balances) {
    if (k.endsWith('|' + pid)) {
      const b = d.balances[k];
      if (b.qty > 0) { q += b.qty; v += b.value; }
      last = b.lastCost || last;
    }
  }
  return q > 0 ? v / q : last || product(d, pid).stdCost;
}

export interface MoveParams {
  productId: ID; warehouseId: ID; qty: number; type: MoveType; refType: string; refId: ID;
  unitCost?: number; value?: number; note?: string; lot?: string; expiry?: string; allowNegative?: boolean;
}

/** The ONLY way stock changes. Appends an immutable movement and updates the balance projection. */
export function moveStock(d: DB, ctx: Ctx, p: MoveParams): Movement {
  if (!p.qty || !isFinite(p.qty)) fail('INVALID', 'Quantity must be non-zero');
  const prod = product(d, p.productId);
  const k = bkey(p.warehouseId, p.productId);
  const bal = (d.balances[k] ||= { qty: 0, value: 0, lastCost: 0 });
  const q = r3(p.qty);
  let value: number;
  let unitCost: number;
  if (q > 0) {
    if (p.value != null) { value = r2(p.value); unitCost = value / q; }
    else {
      unitCost = p.unitCost ?? (bal.qty > 0 ? bal.value / bal.qty : bal.lastCost || prod.stdCost);
      value = r2(q * unitCost);
    }
    bal.lastCost = unitCost;
  } else {
    const out = -q;
    const wh = d.warehouses.find((w) => w.id === p.warehouseId);
    if (bal.qty + 1e-6 < out && !p.allowNegative && !d.org.allowNegativeStock) {
      fail('INSUFFICIENT_STOCK', `Insufficient stock for ${prod.name} at ${wh?.name ?? p.warehouseId}: need ${out}, have ${r3(bal.qty)} ${prod.unit}`);
    }
    if (Math.abs(bal.qty - out) < 1e-6) value = -r2(bal.value);
    else {
      const avg = bal.qty > 0 ? bal.value / bal.qty : bal.lastCost || prod.stdCost;
      value = -r2(out * avg);
    }
    unitCost = Math.abs(value) / out;
  }
  bal.qty = r3(bal.qty + q);
  bal.value = r2(bal.value + value);
  if (Math.abs(bal.qty) < 1e-9) { bal.qty = 0; }
  const m: Movement = {
    id: nid(d, 'MV'), ts: ctx.now, productId: p.productId, warehouseId: p.warehouseId, qty: q, unitCost, value,
    type: p.type, refType: p.refType, refId: p.refId, note: p.note, lot: p.lot, expiry: p.expiry, userId: ctx.userId,
  };
  d.movements.push(m);
  return m;
}

// ---------- availability
export function reservedMap(d: DB): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of d.orders) {
    if (o.channel === 'POS') continue;
    if (!['new', 'confirmed', 'packed'].includes(o.status)) continue;
    for (const l of o.lines) {
      const p = d.products.find((x) => x.id === l.productId);
      if (!p || (p.kind !== 'resale' && p.kind !== 'finished')) continue;
      const k = bkey(o.warehouseId, l.productId);
      out[k] = (out[k] || 0) + l.qty - l.returnedQty;
    }
  }
  return out;
}

export function stockValue(d: DB, wh?: ID): number {
  let v = 0;
  for (const k in d.balances) if (!wh || k.startsWith(wh + '|')) v += d.balances[k].value;
  return r2(v);
}

// ---------- reconciliation (ledger → balances)
export function reconcileStock(d: DB) {
  const calc: Record<string, { qty: number; value: number }> = {};
  for (const m of d.movements) {
    const c = (calc[bkey(m.warehouseId, m.productId)] ||= { qty: 0, value: 0 });
    c.qty += m.qty;
    c.value += m.value;
  }
  const diffs: { key: string; ledgerQty: number; balQty: number; ledgerValue: number; balValue: number }[] = [];
  const keys = new Set([...Object.keys(calc), ...Object.keys(d.balances)]);
  for (const key of keys) {
    const c = calc[key] || { qty: 0, value: 0 };
    const b = d.balances[key] || { qty: 0, value: 0 };
    if (Math.abs(c.qty - b.qty) > 0.001 || Math.abs(c.value - b.value) > 0.05) {
      diffs.push({ key, ledgerQty: r3(c.qty), balQty: r3(b.qty), ledgerValue: r2(c.value), balValue: r2(b.value) });
    }
  }
  return { checked: keys.size, diffs };
}

// ---------- adjustments / waste
export function adjustStock(
  d: DB, ctx: Ctx,
  p: { productId: ID; warehouseId: ID; qty: number; reason: string; kind?: 'adjust' | 'waste'; unitCost?: number; lot?: string; expiry?: string },
): ID {
  const prod = product(d, p.productId);
  const type: MoveType = p.kind === 'waste' ? 'waste' : 'adjust';
  const m = moveStock(d, ctx, {
    productId: p.productId, warehouseId: p.warehouseId, qty: p.qty, type, refType: 'adjustment', refId: 'ADJ',
    note: p.reason, unitCost: p.unitCost, lot: p.lot, expiry: p.expiry,
  });
  const loss = p.kind === 'waste' ? '5100' : '5200';
  post(d, ctx, {
    memo: `${p.kind === 'waste' ? 'Waste' : 'Stock adjustment'}: ${prod.name} (${p.reason})`, refType: 'stock_adjust', refId: m.id,
    lines: m.value < 0 ? [dr(loss, -m.value), cr(invAccount(prod.kind), -m.value)] : [dr(invAccount(prod.kind), m.value), cr(loss, m.value)],
  });
  audit(d, ctx, 'stock.' + (p.kind ?? 'adjust'), 'product', p.productId, `${p.qty > 0 ? '+' : ''}${p.qty} ${prod.unit} — ${p.reason}`, 'warn');
  return m.id;
}

// ---------- transfers (with in-transit & partial receipt)
export function createTransfer(
  d: DB, ctx: Ctx, p: { fromWh: ID; toWh: ID; lines: { productId: ID; qty: number }[]; note?: string },
): ID {
  if (p.fromWh === p.toWh) fail('INVALID', 'Source and destination warehouses must differ');
  const lines = p.lines.filter((l) => l.qty > 0);
  if (!lines.length) fail('INVALID', 'Add at least one line');
  const id = nid(d, 'TR');
  const tl: Transfer['lines'] = [];
  const byAcct: Record<string, number> = {};
  for (const l of lines) {
    const prod = product(d, l.productId);
    const m = moveStock(d, ctx, { productId: l.productId, warehouseId: p.fromWh, qty: -l.qty, type: 'transfer_out', refType: 'transfer', refId: id });
    tl.push({ productId: l.productId, qty: l.qty, receivedQty: 0, unitCost: m.unitCost, value: -m.value, valueReceived: 0 });
    const a = invAccount(prod.kind);
    byAcct[a] = (byAcct[a] || 0) + -m.value;
  }
  const t: Transfer = { id, no: docNo(d, 'TRF'), fromWh: p.fromWh, toWh: p.toWh, status: 'in_transit', lines: tl, createdAt: ctx.now, note: p.note, createdBy: ctx.userId };
  d.transfers.push(t);
  const total = Object.values(byAcct).reduce((s, v) => s + v, 0);
  post(d, ctx, { memo: `Transfer ${t.no} dispatched`, refType: 'transfer', refId: id, lines: [dr('1250', total), ...Object.entries(byAcct).map(([a, v]) => cr(a, v))] });
  return id;
}

export function receiveTransfer(d: DB, ctx: Ctx, id: ID, recv: { productId: ID; qty: number }[]) {
  const t = d.transfers.find((x) => x.id === id) || fail('NOT_FOUND', 'Transfer not found');
  if (t.status === 'received' || t.status === 'closed_short') fail('INVALID', 'Transfer is already complete');
  const byAcct: Record<string, number> = {};
  let any = false;
  for (const r of recv) {
    if (!(r.qty > 0)) continue;
    const l = t.lines.find((x) => x.productId === r.productId) || fail('INVALID', 'Line not in transfer');
    const remaining = r3(l.qty - l.receivedQty - (l.shortClosed || 0));
    if (r.qty > remaining + 1e-6) fail('OVER_RECEIPT', `Cannot receive ${r.qty}; only ${remaining} outstanding`);
    const last = Math.abs(r.qty - remaining) < 1e-6;
    const value = last ? r2(l.value - l.valueReceived) : r2(r.qty * l.unitCost);
    moveStock(d, ctx, { productId: r.productId, warehouseId: t.toWh, qty: r.qty, type: 'transfer_in', refType: 'transfer', refId: t.id, value });
    l.receivedQty = r3(l.receivedQty + r.qty);
    l.valueReceived = r2(l.valueReceived + value);
    const a = invAccount(product(d, r.productId).kind);
    byAcct[a] = (byAcct[a] || 0) + value;
    any = true;
  }
  if (!any) fail('INVALID', 'Enter a received quantity');
  const total = Object.values(byAcct).reduce((s, v) => s + v, 0);
  post(d, ctx, { memo: `Transfer ${t.no} received`, refType: 'transfer', refId: t.id, lines: [...Object.entries(byAcct).map(([a, v]) => dr(a, v)), cr('1250', total)] });
  const done = t.lines.every((l) => l.qty - l.receivedQty - (l.shortClosed || 0) < 1e-6);
  t.status = done ? 'received' : 'partial';
  if (done) t.receivedAt = ctx.now;
}

export function closeTransferShort(d: DB, ctx: Ctx, id: ID, reason: string) {
  const t = d.transfers.find((x) => x.id === id) || fail('NOT_FOUND', 'Transfer not found');
  if (t.status === 'received' || t.status === 'closed_short') fail('INVALID', 'Transfer is already complete');
  if (!reason.trim()) fail('REASON', 'A reason is required to close short');
  let loss = 0;
  for (const l of t.lines) {
    const rem = r3(l.qty - l.receivedQty - (l.shortClosed || 0));
    if (rem > 0) {
      l.shortClosed = rem;
      loss += r2(l.value - l.valueReceived);
      l.valueReceived = l.value;
    }
  }
  post(d, ctx, { memo: `Transfer ${t.no} closed short: ${reason}`, refType: 'transfer', refId: t.id, lines: [dr('5200', loss), cr('1250', loss)] });
  t.status = 'closed_short';
  t.receivedAt = ctx.now;
  audit(d, ctx, 'transfer.close_short', 'transfer', t.id, `${t.no}: ${reason} (loss ${loss})`, 'warn');
}

export function inTransitQty(d: DB, pid: ID, toWh?: ID): number {
  let q = 0;
  for (const t of d.transfers) {
    if (t.status === 'received' || t.status === 'closed_short') continue;
    if (toWh && t.toWh !== toWh) continue;
    const l = t.lines.find((x) => x.productId === pid);
    if (l) q += l.qty - l.receivedQty - (l.shortClosed || 0);
  }
  return r3(q);
}
export function inTransitValue(d: DB): number {
  let v = 0;
  for (const t of d.transfers) for (const l of t.lines) v += l.value - l.valueReceived;
  return r2(v);
}

// ---------- stock counts
export function startCount(d: DB, ctx: Ctx, warehouseId: ID, note?: string): ID {
  const id = nid(d, 'SC');
  const lines = d.products
    .filter((p) => p.kind !== 'menu' && (getBal(d, warehouseId, p.id).qty !== 0 || p.levels[warehouseId]))
    .map((p) => ({ productId: p.id, systemQty: getBal(d, warehouseId, p.id).qty, countedQty: null as number | null }));
  d.counts.push({ id, no: docNo(d, 'CNT'), warehouseId, createdAt: ctx.now, status: 'open', lines, note });
  return id;
}
export function postCount(d: DB, ctx: Ctx, id: ID, counted: Record<ID, number | null>) {
  const c: StockCount = d.counts.find((x) => x.id === id) || fail('NOT_FOUND', 'Count not found');
  if (c.status === 'posted') fail('INVALID', 'Count already posted');
  let adj = 0;
  for (const l of c.lines) {
    const v = counted[l.productId];
    l.countedQty = v ?? l.countedQty;
    if (l.countedQty == null) continue;
    const sysNow = getBal(d, c.warehouseId, l.productId).qty;
    const diff = r3(l.countedQty - sysNow);
    if (Math.abs(diff) < 0.0005) continue;
    const prod = product(d, l.productId);
    const m = moveStock(d, ctx, { productId: l.productId, warehouseId: c.warehouseId, qty: diff, type: 'count', refType: 'count', refId: c.id, note: `Count ${c.no}`, allowNegative: true });
    post(d, ctx, {
      memo: `Stock count ${c.no}: ${prod.name}`, refType: 'count', refId: c.id,
      lines: m.value < 0 ? [dr('5200', -m.value), cr(invAccount(prod.kind), -m.value)] : [dr(invAccount(prod.kind), m.value), cr('5200', m.value)],
    });
    adj++;
  }
  c.status = 'posted';
  c.postedAt = ctx.now;
  audit(d, ctx, 'count.post', 'count', c.id, `${c.no} posted with ${adj} adjustment(s)`, adj ? 'warn' : 'info');
  return adj;
}

// ---------- lots / expiry (FEFO view derived from the movement ledger)
export interface LotRow { lot: string; expiry?: string; received: number; remaining: number; productId: ID; warehouseId: ID }
export function lotsFor(d: DB, productId?: ID): LotRow[] {
  const rows: LotRow[] = [];
  const byProdWh: Record<string, { lots: LotRow[]; out: number }> = {};
  for (const m of d.movements) {
    if (productId && m.productId !== productId) continue;
    const k = bkey(m.warehouseId, m.productId);
    const g = (byProdWh[k] ||= { lots: [], out: 0 });
    if (m.qty > 0 && m.lot) g.lots.push({ lot: m.lot, expiry: m.expiry, received: m.qty, remaining: m.qty, productId: m.productId, warehouseId: m.warehouseId });
    else if (m.qty < 0) g.out += -m.qty;
  }
  for (const g of Object.values(byProdWh)) {
    g.lots.sort((a, b) => (a.expiry || '9').localeCompare(b.expiry || '9'));
    let out = g.out;
    for (const l of g.lots) {
      const take = Math.min(out, l.remaining);
      l.remaining = r3(l.remaining - take);
      out -= take;
    }
    rows.push(...g.lots.filter((l) => l.remaining > 0.0005));
  }
  return rows.sort((a, b) => (a.expiry || '9').localeCompare(b.expiry || '9'));
}
