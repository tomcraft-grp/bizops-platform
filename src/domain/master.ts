import type { Customer, DB, ID, Org, Product, ProductKind, Supplier } from './types';
import { Ctx, audit, fail, nid, guard } from './core';
import { versionAt, bomForProduct } from './bom';
import { onHand } from './inventory';
import { r3 } from '../lib/util';

export function addCustomer(d: DB, ctx: Ctx, p: { name: string; phone: string; email?: string; group?: Customer['group']; creditLimit?: number; creditDays?: number; address?: string; marketing?: boolean }): ID {
  if (!p.name.trim()) fail('INVALID', 'Name is required');
  if (p.phone && d.customers.some((c) => c.phone === p.phone)) fail('DUPLICATE', 'A customer with this phone number already exists');
  const n = d.customers.length + 1;
  const id = nid(d, 'C');
  d.customers.push({
    id, code: `${p.group === 'wholesale' ? 'W' : 'M'}-${String(n).padStart(4, '0')}`, name: p.name.trim(), phone: p.phone, email: p.email, group: p.group ?? 'retail',
    creditLimit: p.creditLimit ?? 0, creditDays: p.creditDays ?? 0, consent: { pdpa: true, marketing: !!p.marketing, at: ctx.now }, createdAt: ctx.now, address: p.address,
  });
  return id;
}
/**
 * Find or create the customer record for a LINE member (identity and phone come from Supabase `profiles`), and
 * refresh its name and phone. Used by the customer app (the member themself) and by POS lookup (staff).
 * The phone is assigned directly rather than through updateCustomer: a demo customer may already use the same
 * number, and that must not block the real member.
 */
export function linkLineMember(d: DB, ctx: Ctx, m: { lineUserId: string; name?: string | null; phone?: string | null }): ID {
  if (!m.lineUserId) fail('INVALID', 'LINE user ID is required');
  const name = m.name?.trim() || 'LINE member';
  const phone = m.phone ?? '';
  const found = d.customers.find((x) => x.lineUserId === m.lineUserId);
  if (found) { found.name = name; found.phone = phone; return found.id; }
  const id = addCustomer(d, ctx, { name, phone: '' });
  Object.assign(d.customers.find((x) => x.id === id)!, { lineUserId: m.lineUserId, phone });
  return id;
}
export function updateCustomer(d: DB, ctx: Ctx, id: ID, patch: Partial<Customer>) {
  const c = d.customers.find((x) => x.id === id) || fail('NOT_FOUND', 'Customer not found');
  if (patch.phone && patch.phone !== c.phone && d.customers.some((x) => x.phone === patch.phone && x.id !== id)) fail('DUPLICATE', 'Another customer already uses this phone number');
  const credit = patch.creditLimit != null && patch.creditLimit !== c.creditLimit;
  Object.assign(c, patch);
  if (credit) audit(d, ctx, 'customer.credit_limit', 'customer', id, `Credit limit → ${patch.creditLimit}`, 'warn');
}

export function saveProduct(d: DB, ctx: Ctx, p: Partial<Product> & { name: string; sku: string; kind: ProductKind }): ID {
  guard(d, ctx, 'catalog:edit');
  if (!p.name.trim() || !p.sku.trim()) fail('INVALID', 'Name and SKU are required');
  const dup = d.products.find((x) => x.sku.toLowerCase() === p.sku.toLowerCase() && x.id !== p.id);
  if (dup) fail('DUPLICATE', `SKU ${p.sku} is already used by ${dup.name}`);
  if (p.barcode && d.products.some((x) => x.barcode === p.barcode && x.id !== p.id)) fail('DUPLICATE', 'Barcode is already used by another product');
  if (p.id) {
    const cur = d.products.find((x) => x.id === p.id) || fail('NOT_FOUND', 'Product not found');
    if (p.price != null && p.price !== cur.price) audit(d, ctx, 'product.price', 'product', cur.id, `${cur.name}: price ${cur.price} → ${p.price}`, 'info');
    Object.assign(cur, p);
    return cur.id;
  }
  const id = nid(d, 'PX');
  d.products.push({
    id: 'N' + id, sku: p.sku, name: p.name, category: p.category ?? 'General', kind: p.kind, unit: p.unit ?? 'pcs', price: p.price ?? 0, channelPrices: p.channelPrices ?? {},
    barcode: p.barcode, active: true, emoji: p.emoji ?? '📦', color: p.color ?? '#2a78d6', stdCost: p.stdCost ?? 0, levels: p.levels ?? {}, station: p.station ?? null,
    supplierId: p.supplierId, mediaIds: [], description: p.description, modifiers: p.modifiers,
  });
  return 'N' + id;
}

export function saveSupplier(d: DB, ctx: Ctx, p: Partial<Supplier> & { name: string }): ID {
  guard(d, ctx, 'purchasing:edit');
  if (!p.name.trim()) fail('INVALID', 'Supplier name is required');
  if (p.id) { Object.assign(d.suppliers.find((s) => s.id === p.id) || fail('NOT_FOUND', 'Supplier not found'), p); return p.id; }
  const id = 'S' + (d.suppliers.length + 1);
  d.suppliers.push({ id, code: p.name.slice(0, 3).toUpperCase(), name: p.name, contact: p.contact ?? '', phone: p.phone ?? '', email: p.email, termsDays: p.termsDays ?? 30, vatable: p.vatable ?? true, rating: 3, productIds: p.productIds ?? [], taxId: p.taxId });
  return id;
}

export function updateOrg(d: DB, ctx: Ctx, patch: Partial<Org>) {
  guard(d, ctx, 'settings:edit');
  const before = JSON.stringify(d.org);
  Object.assign(d.org, patch);
  if (JSON.stringify(d.org) !== before) audit(d, ctx, 'settings.org', 'settings', undefined, `Organization settings changed: ${Object.keys(patch).join(', ')}`, 'warn');
}

/** How many servings of a menu item can be made from the stock on hand (min over recipe components) */
export function servingsPossible(d: DB, wh: ID, productId: ID, nowIso: string): number {
  const bom = bomForProduct(d, productId);
  const v = bom && versionAt(bom, nowIso);
  if (!v) return 0;
  let n = Infinity;
  for (const c of v.components) n = Math.min(n, onHand(d, wh, c.productId) / (c.qty / v.yieldQty));
  return Number.isFinite(n) ? Math.max(0, Math.floor(r3(n))) : 0;
}
