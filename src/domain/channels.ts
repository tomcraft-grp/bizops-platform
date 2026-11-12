import type { ChannelCode, DB, ID } from './types';
import { Ctx, fail, nid } from './core';
import { createOrder } from './orders';
import { CHANNELS } from './meta';
import { r2 } from '../lib/util';

export interface ExtLine { sku: string; name: string; qty: number; price: number }
export interface ExtOrder { externalId: string; createdAt?: string; buyer?: string; lines: ExtLine[]; voucher?: number; raw?: Record<string, unknown> }

/** Which branch/warehouse fulfils orders from a channel */
export function routeFor(d: DB, channel: ChannelCode) {
  const want = channel === 'LINEMAN' ? 'kitchen' : 'online';
  const b = d.branches.find((x) => x.type === want) ?? d.branches[0];
  return { branchId: b.id, warehouseId: b.defaultWarehouseId };
}

/**
 * Import one external order into the unified order model.
 * - idempotent on (channel, externalId)
 * - unmapped SKUs park the order in the error queue (no partial orders)
 */
export function importExternalOrder(d: DB, ctx: Ctx, channel: ChannelCode, ex: ExtOrder, source: 'sync' | 'csv' | 'webhook' = 'sync'): 'imported' | 'duplicate' | 'error' {
  const existing = d.externalOrders.find((e) => e.channel === channel && e.externalId === ex.externalId);
  if (existing && existing.status === 'imported') {
    d.externalOrders.push({ id: nid(d, 'XO'), channel, externalId: ex.externalId, receivedAt: ctx.now, status: 'duplicate', raw: ex.raw ?? ex as unknown as Record<string, unknown>, source });
    return 'duplicate';
  }
  const rec = existing ?? { id: nid(d, 'XO'), channel, externalId: ex.externalId, receivedAt: ctx.now, status: 'error' as const, raw: ex.raw ?? (ex as unknown as Record<string, unknown>), source };
  if (!existing) d.externalOrders.push(rec);
  const missing: string[] = [];
  const lines = [];
  for (const l of ex.lines) {
    let m = d.mappings.find((x) => x.channel === channel && x.externalSku === l.sku);
    if (!m) { m = { id: nid(d, 'MP'), channel, externalSku: l.sku, productId: null, externalName: l.name }; d.mappings.push(m); }
    if (!m.productId) { missing.push(l.sku); continue; }
    lines.push({ productId: m.productId, qty: l.qty, unitPrice: l.price, externalSku: l.sku });
  }
  const rec2 = d.externalOrders.find((e) => e.id === rec.id)!;
  if (missing.length) {
    rec2.status = 'error';
    rec2.error = `Unmapped SKU: ${missing.join(', ')}`;
    return 'error';
  }
  const r = routeFor(d, channel);
  try {
    const oid = createOrder(d, { ...ctx, userId: ctx.userId }, {
      channel, branchId: r.branchId, warehouseId: r.warehouseId, lines, externalId: ex.externalId, platformVoucher: ex.voucher ?? 0,
      skipStockCheck: true, skipPromotions: true, orderType: channel === 'LINEMAN' ? 'delivery' : 'online',
      shipping: ex.buyer ? { recipient: ex.buyer } : undefined, note: source === 'csv' ? 'Imported from CSV' : undefined,
    });
    const o = d.orders.find((x) => x.id === oid)!;
    if (ex.createdAt) { o.createdAt = ex.createdAt; o.statusLog[0].ts = ex.createdAt; }
    rec2.status = 'imported';
    rec2.error = undefined;
    rec2.orderId = oid;
    return 'imported';
  } catch (e) {
    rec2.status = 'error';
    rec2.error = (e as Error).message;
    return 'error';
  }
}

export function mapSku(d: DB, ctx: Ctx, mappingId: ID, productId: ID | null) {
  const m = d.mappings.find((x) => x.id === mappingId) || fail('NOT_FOUND', 'Mapping not found');
  m.productId = productId;
  const p = productId ? d.products.find((x) => x.id === productId) : undefined;
  if (p) (p.listingMap ||= {})[m.channel] = m.externalSku;
  // retry parked orders for this channel that were waiting on this SKU
  let retried = 0;
  if (productId) {
    for (const e of d.externalOrders.filter((x) => x.channel === m.channel && x.status === 'error' && x.error?.includes(m.externalSku))) {
      const raw = e.raw as unknown as ExtOrder;
      if (raw.lines) { const r = importExternalOrder(d, ctx, m.channel, raw, e.source); if (r === 'imported') retried++; }
    }
  }
  return retried;
}
export function retryExternal(d: DB, ctx: Ctx, id: ID) {
  const e = d.externalOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'Record not found');
  return importExternalOrder(d, ctx, e.channel, e.raw as unknown as ExtOrder, e.source);
}

/** CSV fallback. Columns: order_id, sku, name, qty, price, voucher(optional), created_at(optional) */
export function importCSVRows(d: DB, ctx: Ctx, channel: ChannelCode, rows: string[][]) {
  if (rows.length < 2) fail('INVALID', 'The file has no data rows');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  for (const need of ['order_id', 'sku', 'qty', 'price']) if (col(need) < 0) fail('INVALID', `Missing required column "${need}"`);
  const groups = new Map<string, ExtOrder>();
  for (const r of rows.slice(1)) {
    const id = r[col('order_id')]?.trim();
    if (!id) continue;
    const g = groups.get(id) ?? { externalId: id, lines: [], voucher: 0, createdAt: col('created_at') >= 0 && r[col('created_at')] ? new Date(r[col('created_at')]).toISOString() : undefined };
    g.lines.push({ sku: r[col('sku')].trim(), name: r[col('name')] ?? r[col('sku')], qty: Number(r[col('qty')]) || 1, price: Number(r[col('price')]) || 0 });
    if (col('voucher') >= 0) g.voucher = (g.voucher || 0) + (Number(r[col('voucher')]) || 0);
    groups.set(id, g);
  }
  const res = { imported: 0, duplicates: 0, errors: 0 };
  for (const g of groups.values()) {
    const r = importExternalOrder(d, ctx, channel, { ...g, raw: { source: 'csv', ...g } }, 'csv');
    if (r === 'imported') res.imported++; else if (r === 'duplicate') res.duplicates++; else res.errors++;
  }
  d.syncJobs.push({ id: nid(d, 'SJ'), channel, ts: ctx.now, source: 'csv', fetched: groups.size, ...res, durationMs: 40 + groups.size * 3 });
  const acct = d.channelAccounts.find((a) => a.channel === channel);
  if (acct) acct.lastSyncAt = ctx.now;
  return res;
}

/** Simulated connector: pulls a batch of "new" orders as a real API poll would (incl. a duplicate delivery and an unmapped SKU) */
export function simulateSync(d: DB, ctx: Ctx, channel: ChannelCode, rnd: () => number, count = 6) {
  const maps = d.mappings.filter((m) => m.channel === channel && m.productId);
  if (!maps.length) fail('NO_MAPPINGS', 'No SKU mappings exist for this channel');
  const res = { imported: 0, duplicates: 0, errors: 0 };
  const prefix = { SHOPEE: 'SP', LAZADA: 'LZ', TIKTOK: 'TT', LINEMAN: 'LM', LINE: 'LN', POS: 'PS' }[channel];
  const made: ExtOrder[] = [];
  for (let i = 0; i < count; i++) {
    const n = 1 + Math.floor(rnd() * 3);
    const lines: ExtLine[] = [];
    for (let k = 0; k < n; k++) {
      const m = maps[Math.floor(rnd() * maps.length)];
      const p = d.products.find((x) => x.id === m.productId)!;
      lines.push({ sku: m.externalSku, name: m.externalName, qty: 1 + Math.floor(rnd() * 2), price: p.channelPrices[channel] ?? p.price });
    }
    if (i === count - 1 && rnd() < 0.9) lines.push({ sku: `NEW-${100 + Math.floor(rnd() * 800)}`, name: 'Limited bundle (not yet mapped)', qty: 1, price: 299 });
    const ext: ExtOrder = { externalId: `${prefix}${Date.now().toString(36).toUpperCase().slice(-5)}${Math.floor(rnd() * 9000 + 1000)}`, createdAt: ctx.now, buyer: ['Somchai K.', 'Anong P.', 'Pim S.', 'Nattapon R.', 'Kanya L.'][Math.floor(rnd() * 5)], lines, voucher: rnd() < 0.3 ? 20 : 0 };
    ext.raw = { order_sn: ext.externalId, status: 'READY_TO_SHIP', buyer_username: ext.buyer, items: lines, created: ctx.now };
    made.push(ext);
  }
  for (const e of made) { const r = importExternalOrder(d, ctx, channel, e, 'sync'); res[r === 'imported' ? 'imported' : r === 'duplicate' ? 'duplicates' : 'errors']++; }
  // webhook retry delivers the first order a second time → must be ignored (idempotency)
  const r2x = importExternalOrder(d, ctx, channel, made[0], 'webhook');
  if (r2x === 'duplicate') res.duplicates++;
  d.syncJobs.push({ id: nid(d, 'SJ'), channel, ts: ctx.now, source: 'sync', fetched: made.length + 1, ...res, durationMs: 220 + Math.floor(rnd() * 600) });
  const acct = d.channelAccounts.find((a) => a.channel === channel);
  if (acct) acct.lastSyncAt = ctx.now;
  return res;
}
export const channelLabel = (c: ChannelCode) => CHANNELS[c].label;
export const _r2 = r2;
