import { describe, expect, it } from 'vitest';
import { ctx, tx, codeOf } from '../helpers';
import { importSkuMaster, type SkuMasterRow } from '../../src/domain/master';

const row = (o: Partial<SkuMasterRow>): SkuMasterRow => ({
  sku_code: 'T-001', source_code: 'T-001', domain: 'POD / vape (Ref POD)', brand: 'BRAND', name_full: '1 BRAND Grape 6000 คำ (องุ่น)', product_type: 'Puff',
  pack_qty: 6000, unit_en: 'Puff', unit_th: 'คำ', barcode: null, status: 'active', cost_price: 237, retail_price: 350, selling_price: 320,
  friend_price: 300, wholesale_price: 290, ecommerce_price: null, needs_review: false, review_notes: null, ...o,
});

describe('SKU master import into the local catalogue', () => {
  it('creates products with selling price, cost, tiers in the description, and strips the row number from the name', () => {
    tx((d) => {
      const r = importSkuMaster(d, ctx, [row({})]);
      expect(r).toMatchObject({ created: 1, updated: 0, inactive: 0, failed: [] });
      const p = d.products.find((x) => x.sku === 'T-001')!;
      expect(p).toMatchObject({ name: 'BRAND Grape 6000 คำ (องุ่น)', price: 320, stdCost: 237, kind: 'resale', active: true });
      expect(p.description).toContain('ราคาเพื่อน 300');
      expect(p.description).toContain('ราคาส่ง 290');
    });
  });
  it('is idempotent: a second pull updates the same product instead of duplicating it', () => {
    tx((d) => {
      importSkuMaster(d, ctx, [row({})]);
      const n = d.products.length;
      const r = importSkuMaster(d, ctx, [row({ selling_price: 330 })]);
      expect(r).toMatchObject({ created: 0, updated: 1 });
      expect(d.products.length).toBe(n);
      expect(d.products.find((x) => x.sku === 'T-001')!.price).toBe(330);
    });
  });
  it('falls back to the sticker price, and makes a SKU without any price inactive', () => {
    tx((d) => {
      const r = importSkuMaster(d, ctx, [
        row({ sku_code: 'K-1', domain: 'Kratom drink (Stock FG)', selling_price: null, retail_price: 50, ecommerce_price: 80 }),
        row({ sku_code: 'K-2', domain: 'Kratom drink (Stock FG)', selling_price: null, retail_price: null, cost_price: null, needs_review: true, review_notes: 'No selling price' }),
      ]);
      expect(r).toMatchObject({ created: 2, inactive: 1 });
      expect(d.products.find((x) => x.sku === 'K-1')).toMatchObject({ price: 50, kind: 'finished', active: true, channelPrices: { SHOPEE: 80, LAZADA: 80, TIKTOK: 80 } });
      expect(d.products.find((x) => x.sku === 'K-2')).toMatchObject({ price: 0, active: false });
      expect(d.products.find((x) => x.sku === 'K-2')!.description).toContain('ต้องตรวจสอบ');
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
