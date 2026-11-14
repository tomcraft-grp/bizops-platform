import { describe, expect, it } from 'vitest';
import { ctx, tx, codeOf, expectIntegrity } from '../helpers';
import { applySkuCodes, isUsable, saveProduct, setProductActive } from '../../src/domain/master';
import { KINDS_OF_CATEGORY, SKU_CODE_RE, isStandardSku, skuCategoryOf, skuCategoryOfCode } from '../../src/domain/sku';
import { sellable } from '../../src/domain/orders';
import { invAccount } from '../../src/domain/accounting';
import { PRODUCT_KIND_LABEL } from '../../src/domain/meta';
import type { ProductKind } from '../../src/domain/types';

const base = { name: 'Test product', category: 'General', unit: 'pcs', price: 10, stdCost: 4 };
const cashierId = (d: Parameters<Parameters<typeof tx>[0]>[0]) => d.users.find((u) => u.roleId === 'role-cashier')!.id;

describe('SKU code format and product-type mapping', () => {
  it('accepts FG-/RM-/WIP- followed by at least six digits, and nothing else', () => {
    for (const ok of ['FG-000001', 'RM-000123', 'WIP-999999', 'FG-1000000']) expect(isStandardSku(ok), ok).toBe(true);
    for (const bad of ['', 'FG000001', 'FG-1', 'FG-00001', 'fg-000001', 'XX-000001', 'FG-000001 ', 'FG-202310-001', 'RM-GB-ETH']) expect(isStandardSku(bad), bad).toBe(false);
    expect(SKU_CODE_RE.test('WIP-000001')).toBe(true);
    expect(skuCategoryOfCode('WIP-000007')).toBe('WIP');
    expect(skuCategoryOfCode('FG-202310-001')).toBeNull();
  });
  it('maps every product kind onto exactly one SKU category, and the three categories cover all kinds', () => {
    const kinds = Object.keys(PRODUCT_KIND_LABEL) as ProductKind[];
    expect(kinds.sort()).toEqual(['finished', 'material', 'menu', 'packaging', 'resale', 'wip']);
    for (const k of kinds) expect(KINDS_OF_CATEGORY[skuCategoryOf(k)]).toContain(k);
    expect(skuCategoryOf('resale')).toBe('FG'); expect(skuCategoryOf('finished')).toBe('FG'); expect(skuCategoryOf('menu')).toBe('FG');
    expect(skuCategoryOf('material')).toBe('RM'); expect(skuCategoryOf('packaging')).toBe('RM'); expect(skuCategoryOf('wip')).toBe('WIP');
  });
});

describe('creating products: codes are never typed in', () => {
  it('rejects a hand-typed or non-standard SKU, and a code from the wrong category', () => {
    tx((d) => {
      expect(codeOf(() => saveProduct(d, ctx, { ...base, sku: 'MY-OWN-CODE', kind: 'resale' }))).toBe('INVALID');
      expect(codeOf(() => saveProduct(d, ctx, { ...base, sku: 'FG000001', kind: 'resale' }))).toBe('INVALID');
      expect(codeOf(() => saveProduct(d, ctx, { ...base, sku: 'FG-000001', kind: 'material' }))).toBe('INVALID'); // FG code on a raw material
      expect(codeOf(() => saveProduct(d, ctx, { ...base, sku: 'RM-000001', kind: 'wip' }))).toBe('INVALID');
    });
  });
  it('creates FG, RM and WIP products with their issued codes, active by default', () => {
    tx((d) => {
      const fg = saveProduct(d, ctx, { ...base, sku: 'FG-900001', kind: 'finished' });
      const rm = saveProduct(d, ctx, { ...base, sku: 'RM-900001', kind: 'material' });
      const pk = saveProduct(d, ctx, { ...base, sku: 'RM-900002', kind: 'packaging' });
      const wip = saveProduct(d, ctx, { ...base, sku: 'WIP-900001', kind: 'wip' });
      expect(d.products.find((p) => p.id === fg)).toMatchObject({ sku: 'FG-900001', kind: 'finished', active: true, legacySku: undefined });
      expect(d.products.find((p) => p.id === rm)).toMatchObject({ sku: 'RM-900001', active: true });
      expect(d.products.find((p) => p.id === pk)).toMatchObject({ sku: 'RM-900002', active: true });
      expect(d.products.find((p) => p.id === wip)).toMatchObject({ sku: 'WIP-900001', kind: 'wip', active: true });
    });
  });
  it('never allows the same code twice (case-insensitive) or the same barcode twice', () => {
    tx((d) => {
      saveProduct(d, ctx, { ...base, sku: 'FG-900010', kind: 'resale', barcode: '8850000000011' });
      expect(codeOf(() => saveProduct(d, ctx, { ...base, name: 'Other', sku: 'FG-900010', kind: 'resale' }))).toBe('DUPLICATE');
      expect(codeOf(() => saveProduct(d, ctx, { ...base, name: 'Other', sku: 'FG-900011', kind: 'resale', barcode: '8850000000011' }))).toBe('DUPLICATE');
    });
  });
  it('a WIP product is stocked and usable in BOMs but is never sellable, and sits in the goods inventory account', () => {
    tx((d) => {
      const id = saveProduct(d, ctx, { ...base, sku: 'WIP-900002', kind: 'wip' });
      const p = d.products.find((x) => x.id === id)!;
      expect(sellable(p)).toBe(false);
      expect(invAccount(p.kind)).toBe('inv_goods');
    });
  });
  it('requires catalog edit permission', () => {
    tx((d) => { expect(codeOf(() => saveProduct(d, { ...ctx, userId: cashierId(d) }, { ...base, sku: 'FG-900020', kind: 'resale' }))).toBe('FORBIDDEN'); });
  });
});

describe('editing products: the code and the legacy code are immutable', () => {
  it('rejects changing SKU, changing the FG/RM/WIP type, or editing the legacy code; other edits still work', () => {
    tx((d) => {
      const p = d.products.find((x) => x.kind === 'resale')!;
      expect(codeOf(() => saveProduct(d, ctx, { ...p, sku: 'FG-900030' }))).toBe('IMMUTABLE');
      expect(codeOf(() => saveProduct(d, ctx, { ...p, kind: 'material' }))).toBe('IMMUTABLE');
      expect(codeOf(() => saveProduct(d, ctx, { ...p, legacySku: 'HACK' }))).toBe('IMMUTABLE');
      saveProduct(d, ctx, { ...p, name: 'Renamed', price: p.price + 1 });
      expect(d.products.find((x) => x.id === p.id)).toMatchObject({ name: 'Renamed', sku: p.sku });
    });
  });
  it('lets a product keep an old-style code on edit (existing local data keeps working until it is re-coded)', () => {
    tx((d) => {
      const p = d.products.find((x) => x.kind === 'resale')!;
      expect(isStandardSku(p.sku)).toBe(false); // seeded demo products still have old codes
      expect(codeOf(() => saveProduct(d, ctx, { ...p, description: 'edited' }))).toBeNull();
    });
  });
});

describe('re-coding existing products keeps every relationship intact', () => {
  it('changes only sku/legacySku: product id, stock balances, movements, order lines and journals are untouched', () => {
    tx((d) => {
      const p = d.products.find((x) => x.kind === 'resale' && d.orders.some((o) => o.lines.some((l) => l.productId === x.id)))!;
      const oldSku = p.sku;
      const snapshot = JSON.stringify({ balances: d.balances, movements: d.movements, orders: d.orders, journals: d.journals, lines: d.orders.flatMap((o) => o.lines.map((l) => [l.productId, l.sku])) });
      const n = d.products.length;
      expect(applySkuCodes(d, ctx, [{ productId: p.id, sku: 'FG-900040' }])).toBe(1);
      expect(d.products.length).toBe(n);
      expect(d.products.find((x) => x.id === p.id)).toMatchObject({ sku: 'FG-900040', legacySku: oldSku });
      expect(JSON.stringify({ balances: d.balances, movements: d.movements, orders: d.orders, journals: d.journals, lines: d.orders.flatMap((o) => o.lines.map((l) => [l.productId, l.sku])) })).toBe(snapshot); // order snapshots keep the code at time of sale
      expect(d.audit.some((a) => a.action === 'product.sku' && a.entityId === p.id)).toBe(true);
      expectIntegrity(d);
    });
  });
  it('keeps the FIRST legacy code if a product is re-coded again, skips no-ops, and rejects bad input', () => {
    tx((d) => {
      const [a, b] = d.products.filter((x) => x.kind === 'resale');
      const old = a.sku;
      applySkuCodes(d, ctx, [{ productId: a.id, sku: 'FG-900050' }]);
      expect(applySkuCodes(d, ctx, [{ productId: a.id, sku: 'FG-900050' }])).toBe(0);
      applySkuCodes(d, ctx, [{ productId: a.id, sku: 'FG-900051' }]);
      expect(d.products.find((x) => x.id === a.id)!.legacySku).toBe(old);
      expect(codeOf(() => applySkuCodes(d, ctx, [{ productId: b.id, sku: 'FG-900051' }]))).toBe('DUPLICATE');
      expect(codeOf(() => applySkuCodes(d, ctx, [{ productId: b.id, sku: 'RM-900052' }]))).toBe('INVALID'); // wrong category for a resale product
      expect(codeOf(() => applySkuCodes(d, ctx, [{ productId: b.id, sku: 'free-text' }]))).toBe('INVALID');
      expect(codeOf(() => applySkuCodes(d, { ...ctx, userId: cashierId(d) }, [{ productId: b.id, sku: 'FG-900053' }]))).toBe('FORBIDDEN');
    });
  });
});

describe('Active / Inactive status', () => {
  it('defaults new products to Active and toggles both ways, auditing each real change only', () => {
    tx((d) => {
      const id = saveProduct(d, ctx, { ...base, sku: 'FG-900060', kind: 'resale' });
      expect(d.products.find((p) => p.id === id)!.active).toBe(true);
      const audits = () => d.audit.filter((a) => a.action === 'product.status' && a.entityId === id).length;
      expect(setProductActive(d, ctx, id, false)).toBe(1);
      expect(d.products.find((p) => p.id === id)!.active).toBe(false);
      expect(setProductActive(d, ctx, id, false)).toBe(0); // already inactive: no change, no audit
      expect(audits()).toBe(1);
      expect(setProductActive(d, ctx, id, true)).toBe(1);
      expect(d.products.find((p) => p.id === id)!.active).toBe(true);
      expect(audits()).toBe(2);
    });
  });
  it('is audited when changed through the product form too, and needs catalog edit permission', () => {
    tx((d) => {
      const p = d.products.find((x) => x.kind === 'resale' && x.active)!;
      saveProduct(d, ctx, { ...p, active: false });
      expect(d.audit.some((a) => a.action === 'product.status' && a.entityId === p.id)).toBe(true);
      expect(codeOf(() => setProductActive(d, { ...ctx, userId: cashierId(d) }, p.id, true))).toBe('FORBIDDEN');
      expect(codeOf(() => setProductActive(d, ctx, 'NOPE', true))).toBe('NOT_FOUND');
    });
  });
  it('an inactive product is never deleted and history that references it stays intact', () => {
    tx((d) => {
      const p = d.products.find((x) => x.kind === 'resale' && d.orders.some((o) => o.lines.some((l) => l.productId === x.id)))!;
      const orders = JSON.stringify(d.orders); const mv = JSON.stringify(d.movements); const n = d.products.length;
      setProductActive(d, ctx, p.id, false);
      expect(d.products.length).toBe(n);
      expect(JSON.stringify(d.orders)).toBe(orders);
      expect(JSON.stringify(d.movements)).toBe(mv);
      expectIntegrity(d);
    });
  });
  it('pickers for new documents exclude inactive products except the value already selected', () => {
    expect(isUsable({ id: 'a', active: true })).toBe(true);
    expect(isUsable({ id: 'a', active: false })).toBe(false);
    expect(isUsable({ id: 'a', active: false }, 'a')).toBe(true);
    expect(isUsable({ id: 'a', active: false }, 'b')).toBe(false);
  });
});
