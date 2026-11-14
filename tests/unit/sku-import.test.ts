import { describe, expect, it } from 'vitest';
import { ctx, tx, codeOf } from '../helpers';
import { importSkuMaster, type SkuMasterRow } from '../../src/domain/master';

// `sku_code` is the NEW automatic code issued by the database; `legacy_sku_code` is the original code.
const row = (o: Partial<SkuMasterRow>): SkuMasterRow => ({
  sku_code: 'FG-000001', legacy_sku_code: 'FG-202310-001', sku_category: 'FG', source_code: 'FG-202310-001', domain: 'POD / vape (Ref POD)', brand: 'BRAND', name_full: '1 BRAND Grape 6000 คำ (องุ่น)', product_type: 'Puff',
  pack_qty: 6000, unit_en: 'Puff', unit_th: 'คำ', barcode: null, status: 'active', cost_price: 237, retail_price: 350, selling_price: 320,
  friend_price: 300, wholesale_price: 290, ecommerce_price: null, needs_review: false, review_notes: null, ...o,
});

describe('SKU registry import into the local catalogue', () => {
  it('creates products with selling price, cost, tiers in the description, the legacy code, and strips the row number from the name', () => {
    tx((d) => {
      const r = importSkuMaster(d, ctx, [row({})]);
      expect(r).toMatchObject({ created: 1, updated: 0, inactive: 0, recoded: 0, failed: [] });
      const p = d.products.find((x) => x.sku === 'FG-000001')!;
      expect(p).toMatchObject({ name: 'BRAND Grape 6000 คำ (องุ่น)', price: 320, stdCost: 237, kind: 'resale', active: true, legacySku: 'FG-202310-001' });
      expect(p.description).toContain('ราคาเพื่อน 300');
      expect(p.description).toContain('ราคาส่ง 290');
    });
  });
  it('is idempotent: a second pull updates the same product instead of duplicating it', () => {
    tx((d) => {
      importSkuMaster(d, ctx, [row({})]);
      const n = d.products.length;
      const r = importSkuMaster(d, ctx, [row({ selling_price: 330 })]);
      expect(r).toMatchObject({ created: 0, updated: 1, recoded: 0 });
      expect(d.products.length).toBe(n);
      expect(d.products.find((x) => x.sku === 'FG-000001')!.price).toBe(330);
    });
  });
  it('finds a product pulled earlier under its OLD code, re-codes it and keeps the old code: same id, no duplicate, stock untouched', () => {
    tx((d) => {
      // a device that pulled before the automatic system: the product carries the old code as its SKU
      const p = d.products.find((x) => x.kind === 'resale')!;
      p.sku = 'FG-202310-001'; p.legacySku = undefined;
      const before = { id: p.id, n: d.products.length, balances: JSON.stringify(d.balances) };
      const r = importSkuMaster(d, ctx, [row({})]);
      expect(r).toMatchObject({ created: 0, updated: 1, recoded: 1, failed: [] });
      expect(d.products.length).toBe(before.n);
      expect(d.products.find((x) => x.id === before.id)).toMatchObject({ sku: 'FG-000001', legacySku: 'FG-202310-001' });
      expect(JSON.stringify(d.balances)).toBe(before.balances);
      expect(d.audit.some((a) => a.action === 'product.sku' && a.entityId === before.id)).toBe(true);
    });
  });
  it('falls back to the sticker price, and makes a SKU without any price inactive', () => {
    tx((d) => {
      const r = importSkuMaster(d, ctx, [
        row({ sku_code: 'FG-000010', legacy_sku_code: 'K-1', domain: 'Kratom drink (Stock FG)', selling_price: null, retail_price: 50, ecommerce_price: 80 }),
        row({ sku_code: 'FG-000011', legacy_sku_code: 'K-2', domain: 'Kratom drink (Stock FG)', selling_price: null, retail_price: null, cost_price: null, needs_review: true, review_notes: 'No selling price' }),
      ]);
      expect(r).toMatchObject({ created: 2, inactive: 1 });
      expect(d.products.find((x) => x.sku === 'FG-000010')).toMatchObject({ price: 50, kind: 'finished', active: true, channelPrices: { SHOPEE: 80, LAZADA: 80, TIKTOK: 80 } });
      expect(d.products.find((x) => x.sku === 'FG-000011')).toMatchObject({ price: 0, active: false });
      expect(d.products.find((x) => x.sku === 'FG-000011')!.description).toContain('ต้องตรวจสอบ');
    });
  });
  it('requires catalog edit permission', () => {
    tx((d) => {
      const cashier = d.users.find((u) => !['U1', 'U2'].includes(u.id) && u.roleId && /cash/i.test(u.roleId))?.id;
      if (!cashier) return; // seed without a cashier: nothing to check
      expect(codeOf(() => importSkuMaster(d, { ...ctx, userId: cashier }, [row({})]))).toBe('FORBIDDEN');
    });
  });
});
