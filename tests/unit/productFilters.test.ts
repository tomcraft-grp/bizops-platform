// The summary cards of the Products page are filters: a card's number is always the length of the list its click opens, and "Active Products" is exactly what the POS sells.
import { describe, expect, it } from 'vitest';
import { onSale } from '../../src/domain/orders';
import { EMPTY_PRODUCT_FILTER as NONE, PRODUCT_CARDS, cardCounts, filterProducts, pressProductCard, selectedCard, type ProductFilter } from '../../src/domain/productFilters';
import { t } from '../../src/lib/i18n';
import type { Product, ProductKind } from '../../src/domain/types';

const KINDS: ProductKind[] = ['material', 'packaging', 'wip', 'finished', 'resale', 'menu'];
const mk = (o: Partial<Product>): Product => ({ id: 'x', sku: 'X', name: 'X', category: 'Pod', kind: 'resale', unit: 'pcs', price: 100, channelPrices: {}, active: true, emoji: '', color: '', stdCost: 0, levels: {}, mediaIds: [], ...o });
// every kind x on/off x priced/unpriced, in two categories
const ALL = KINDS.flatMap((kind) => [true, false].flatMap((active) => [100, 0].map((price, i) => mk({ id: `${kind}-${active}-${price}`, sku: `${kind}-${active}-${price}`, name: `${kind} item`, kind, active, price, categoryId: i ? 'c2' : 'c1' }))));
const ctx = { notSynced: (p: Product) => p.sku.startsWith('wip'), inCategory: (p: Product, c: string) => (c === '__none__' ? !p.categoryId : p.categoryId === c), text: (p: Product) => `${p.name} ${p.sku}` };
const list = (f: Partial<ProductFilter>) => filterProducts(ALL, { ...NONE, ...f }, ctx).map((p) => p.id);

describe('Active Products: what can be sold now', () => {
  it('switched on AND priced AND a kind that is sold; nothing else', () => {
    expect(ALL.filter(onSale).map((p) => p.id)).toEqual(['finished-true-100', 'resale-true-100', 'menu-true-100']);
    expect(list({ status: 'onsale' })).toEqual(['finished-true-100', 'resale-true-100', 'menu-true-100']);
  });
});

describe('cards as filters', () => {
  const DIRTY: ProductFilter[] = [NONE, { ...NONE, status: 'inactive' }, { ...NONE, kind: 'wip', skuType: 'RM', category: 'c2', status: 'unsynced' }];
  it('the number on a card is the length of the list its click opens, whatever was filtered before', () => {
    const n = cardCounts(ALL);
    for (const from of DIRTY) for (const c of PRODUCT_CARDS) { if (selectedCard(from) === c.id) continue; expect(filterProducts(ALL, pressProductCard(from, c.id), ctx).length, `${c.id} from ${JSON.stringify(from)}`).toBe(n[c.id]); }
    expect(n).toEqual({ all: 24, onsale: 3, menu: 4, raw: 8, inactive: 12 });
  });
  it('only one card is selected: the one pressed; with no filter it is "Products"', () => {
    expect(selectedCard(NONE)).toBe('all');
    for (const c of PRODUCT_CARDS) expect(selectedCard(pressProductCard(NONE, c.id))).toBe(c.id);
  });
  it('pressing the selected card again, or Products, shows the full list; the search text stays', () => {
    for (const c of PRODUCT_CARDS) expect(pressProductCard(pressProductCard({ ...NONE, q: 'abc' }, c.id), c.id)).toEqual({ ...NONE, q: 'abc' });
    expect(pressProductCard({ ...NONE, status: 'onsale', category: 'c1', q: 'a' }, 'all')).toEqual({ ...NONE, q: 'a' });
  });
  it('the boxes above the table and the cards are the same filter, so they cannot disagree', () => {
    expect(selectedCard({ ...NONE, status: 'inactive' })).toBe('inactive'); expect(selectedCard({ ...NONE, kind: 'menu' })).toBe('menu');
    expect(selectedCard({ ...NONE, status: 'onsale', kind: 'menu' })).toBe('onsale');      // a card narrowed by a box stays selected
    expect(selectedCard({ ...NONE, status: 'active' })).toBeNull(); expect(selectedCard({ ...NONE, category: 'c1' })).toBeNull();
    expect(selectedCard({ ...NONE, q: 'abc' })).toBe('all');
  });
  it('search and the boxes work inside the selected card', () => {
    expect(list({ status: 'onsale', q: 'RESALE' })).toEqual(['resale-true-100']); expect(list({ status: 'onsale', q: 'wip' })).toEqual([]);
    expect(list({ status: 'onsale', kind: 'menu' })).toEqual(['menu-true-100']); expect(list({ status: 'onsale', category: 'c2' })).toEqual([]);
    expect(list({ kind: 'raw' }).every((id) => /^(material|packaging)-/.test(id))).toBe(true);
  });
  it('the filters the page had before still work', () => {
    expect(list({ status: 'active' })).toHaveLength(12); expect(list({ status: 'inactive' })).toHaveLength(12); expect(list({ status: 'unsynced' })).toHaveLength(4);
    expect(list({ skuType: 'FG' })).toEqual(ALL.filter((p) => ['finished', 'resale', 'menu'].includes(p.kind)).map((p) => p.id)); expect(list({ category: 'c1' })).toHaveLength(12); expect(list({ category: '__none__' })).toHaveLength(0);
  });
  it('an empty catalogue counts zero', () => { expect(cardCounts([])).toEqual({ all: 0, onsale: 0, menu: 0, raw: 0, inactive: 0 }); });
  it('every card reads in Thai', () => { for (const c of PRODUCT_CARDS) { expect(t('th', c.label), c.label).not.toBe(c.label); if (c.sub) expect(t('th', c.sub), c.sub).not.toBe(c.sub); } });
});
