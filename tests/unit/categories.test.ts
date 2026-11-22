// Central product categories on the device side: the sync makes the registry's category the product's category (every device the same), keeps local promotions and
// loyalty multipliers matching after a rename, sends the chosen category to the registry, and the picker offers only registered, active, non-group categories.
// The SQL rules (foreign key, never deleted, inactive cannot be chosen, ...) are proven against the real database by supabase/tests/product_categories.sql.
import { describe, expect, it } from 'vitest';
import { ctx, tx } from '../helpers';
import { importSkuMaster, type SkuMasterRow } from '../../src/domain/master';
import { newSkuDetails, registryEditPatch } from '../../src/domain/skuSync';
import { categoryChoices, type ProductCategory } from '../../src/lib/categoryApi';
import { TH } from '../../src/lib/i18n';

const PUFF = '11111111-1111-4111-8111-111111111111';
const COIL = '22222222-2222-4222-8222-222222222222';
const row = (o: Partial<SkuMasterRow>): SkuMasterRow => ({
  sku_code: 'FG-000001', legacy_sku_code: null, sku_category: 'FG', origin: 'import', domain: 'POD / vape (Ref POD)', brand: 'BRAND', name_full: '1 BRAND Grape', product_type: 'Puff',
  pack_qty: null, unit_en: null, unit_th: null, barcode: null, status: 'active', cost_price: 200, retail_price: 350, selling_price: 320,
  friend_price: null, wholesale_price: null, ecommerce_price: null, needs_review: false, review_notes: null, ...o,
});
const cat = (o: Partial<ProductCategory>): ProductCategory => ({
  id: 'x', code: 'X', name_th: 'X', name_en: null, description: null, parent_id: null, is_group: false, is_active: true, sort_order: 100, product_count: 0, active_product_count: 0,
  created_at: '', updated_at: '', ...o,
});

describe('sync: the registry category becomes the product category', () => {
  it('without a registry category the old device text stays (database before the migration)', () => {
    tx((d) => {
      importSkuMaster(d, ctx, [row({})]);
      const p = d.products.find((x) => x.sku === 'FG-000001')!;
      expect(p.category).toBe('POD · Puff');
      expect(p.categoryId).toBeUndefined();
    });
  });
  it('a later sync (preserveLocal) still brings the central category: id and name', () => {
    tx((d) => {
      importSkuMaster(d, ctx, [row({})]);
      importSkuMaster(d, ctx, [row({ category_id: PUFF, category_name: 'Puff', category_code: 'Puff' })], { preserveLocal: true });
      const p = d.products.find((x) => x.sku === 'FG-000001')!;
      expect(p).toMatchObject({ categoryId: PUFF, category: 'Puff' });
    });
  });
  it('a new product from the registry is created in its central category', () => {
    tx((d) => {
      importSkuMaster(d, ctx, [row({ sku_code: 'FG-000009', category_id: COIL, category_name: 'คอยล์', category_code: 'Coil' })]);
      expect(d.products.find((x) => x.sku === 'FG-000009')).toMatchObject({ categoryId: COIL, category: 'คอยล์' });
    });
  });
  it('re-keys local promotions and loyalty multipliers that named the old text, and logs it', () => {
    tx((d) => {
      importSkuMaster(d, ctx, [row({}), row({ sku_code: 'FG-000002', name_full: '2 BRAND Mint' })]);
      d.promotions.push({ ...(d.promotions[0] ?? {}), id: 'PRM-T', name: 'Puff week', categories: ['POD · Puff'] } as (typeof d.promotions)[number]);
      d.loyalty.categoryMultipliers['POD · Puff'] = 2;
      importSkuMaster(d, ctx, [row({ category_id: PUFF, category_name: 'Puff' }), row({ sku_code: 'FG-000002', name_full: '2 BRAND Mint', category_id: PUFF, category_name: 'Puff' })], { preserveLocal: true });
      expect(d.promotions.find((p) => p.id === 'PRM-T')!.categories).toEqual(['Puff']);
      expect(d.loyalty.categoryMultipliers).toMatchObject({ Puff: 2 });
      expect('POD · Puff' in d.loyalty.categoryMultipliers).toBe(false);
      expect(d.audit.some((a) => a.action === 'category.rekey')).toBe(true);
    });
  });
  it('leaves an ambiguous rename alone (old text became two categories) and warns', () => {
    tx((d) => {
      importSkuMaster(d, ctx, [row({}), row({ sku_code: 'FG-000002', name_full: '2 BRAND Mint' })]);
      d.loyalty.categoryMultipliers['POD · Puff'] = 2;
      importSkuMaster(d, ctx, [row({ category_id: PUFF, category_name: 'Puff' }), row({ sku_code: 'FG-000002', name_full: '2 BRAND Mint', category_id: COIL, category_name: 'Coil' })], { preserveLocal: true });
      expect(d.loyalty.categoryMultipliers['POD · Puff']).toBe(2);
      expect(d.audit.some((a) => a.action === 'category.rekey_skipped' && a.severity === 'warn')).toBe(true);
    });
  });
});

describe('sending the category to the registry', () => {
  it('a drawer edit sends category_id only when it changed', () => {
    const p = { name: 'A', brand: undefined, barcode: undefined, stdCost: 1, price: 2, unit: 'pcs', categoryId: PUFF } as unknown as Parameters<typeof registryEditPatch>[0];
    expect(registryEditPatch(p, { ...p })).toEqual({});
    expect(registryEditPatch(p, { ...p, categoryId: COIL })).toEqual({ category_id: COIL });
  });
  it('a new product sends its category with the other details', () => {
    expect(newSkuDetails({ name: 'A', price: 10, stdCost: 0, barcode: '', brand: '', unit: '', categoryId: COIL })).toMatchObject({ name_full: 'A', category_id: COIL });
    expect(newSkuDetails({ name: 'A', price: 0, stdCost: 0, barcode: '', brand: '', unit: '' })).not.toHaveProperty('category_id');
  });
});

describe('the category picker', () => {
  const pod = cat({ id: 'g', code: 'POD', name_th: 'POD', is_group: true, sort_order: 10 });
  const items = [pod, cat({ id: 'a', code: 'Puff', name_th: 'Puff', parent_id: 'g' }), cat({ id: 'b', code: 'Coil', name_th: 'Coil', parent_id: 'g', is_active: false }),
    cat({ id: 'c', code: 'Kratom drink', name_th: 'Kratom drink' })];
  it('offers only active categories, never a group, under their group', () => {
    const ch = categoryChoices(items);
    expect(ch.map((g) => [g.group?.code ?? null, g.items.map((x) => x.code)])).toEqual([['POD', ['Puff']], [null, ['Kratom drink']]]);
  });
  it('keeps the product\'s own category even when it was deactivated', () => {
    expect(categoryChoices(items, 'b').find((g) => g.group?.code === 'POD')!.items.map((x) => x.code)).toEqual(['Coil', 'Puff']);
  });
  it('the category screens have Thai text', () => {
    for (const k of ['Product categories', 'New category', 'New group', 'Choose a category…', 'Choose a category from the list', 'Reason (kept in the category history)']) expect(TH[k], k).toBeTruthy();
  });
});
