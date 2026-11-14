import { describe, expect, it } from 'vitest';
import { ctx, tx } from '../helpers';
import { reservedMap, bkey } from '../../src/domain/inventory';
import { saveProduct } from '../../src/domain/master';
import { EMPTY_STOCK_FILTERS, activeFilterCount, buildStockRows, filterOptions, matchingProducts, type StockFilters } from '../../src/domain/stockFilters';
import { skuCategoryOf } from '../../src/domain/sku';
import type { DB, Product } from '../../src/domain/types';

const F = (o: Partial<StockFilters>): StockFilters => ({ ...EMPTY_STOCK_FILTERS, ...o });
const rowsOf = (d: DB, f: Partial<StockFilters>) => buildStockRows(d, F(f), reservedMap(d));
const ids = (rows: ReturnType<typeof rowsOf>) => rows.map((r) => `${r.p.id}@${r.w?.id ?? '-'}`).sort();

/** What the page showed before the filters existed: every stock-holding or levelled (product, warehouse) pair, recipes excluded. */
const legacyRows = (d: DB) => {
  const out: string[] = [];
  for (const p of d.products) {
    if (p.kind === 'menu') continue;
    for (const w of d.warehouses) { const b = d.balances[bkey(w.id, p.id)]; if (!b?.qty && !p.levels[w.id]) continue; out.push(`${p.id}@${w.id}`); }
  }
  return out.sort();
};

/** Give the seeded catalogue the optional fields the filters use (brand, creation date) and one inactive product. */
function decorate(d: DB) {
  const stocked = d.products.filter((p) => p.kind !== 'menu');
  stocked.forEach((p, i) => {
    p.brand = i % 3 === 0 ? 'Alpha' : i % 3 === 1 ? 'Beta' : undefined;
    p.createdAt = i % 4 === 3 ? undefined : new Date(Date.UTC(2026, 0, 1 + i)).toISOString(); // every 4th product has no date (saved before the field existed)
  });
  stocked[0].active = false;
  return stocked;
}

describe('stock filters', () => {
  it('with no filter the list is exactly what the page showed before (nothing lost, nothing added)', () => {
    tx((d) => { expect(ids(rowsOf(d, {}))).toEqual(legacyRows(d)); expect(activeFilterCount(EMPTY_STOCK_FILTERS)).toBe(0); });
  });

  it('each filter works on its own', () => {
    tx((d) => {
      const stocked = decorate(d);
      const all = rowsOf(d, {});
      const only = (f: Partial<StockFilters>, pred: (p: Product) => boolean) => {
        const got = rowsOf(d, f);
        expect(got.length, JSON.stringify(f)).toBeGreaterThan(0);
        expect(ids(got), JSON.stringify(f)).toEqual(ids(all.filter((r) => pred(r.p))));
      };
      only({ skuType: 'RM' }, (p) => skuCategoryOf(p.kind) === 'RM');
      only({ skuType: 'FG' }, (p) => skuCategoryOf(p.kind) === 'FG');
      only({ kind: 'material' }, (p) => p.kind === 'material');
      only({ kind: 'packaging' }, (p) => p.kind === 'packaging');
      const cat = stocked.find((p) => p.category)!.category;
      only({ category: cat }, (p) => p.category === cat);
      only({ brand: 'Alpha' }, (p) => p.brand === 'Alpha');
      only({ brand: 'Beta' }, (p) => p.brand === 'Beta');
      const unit = stocked[1].unit;
      only({ unit }, (p) => p.unit === unit);
      only({ status: 'inactive' }, (p) => !p.active);
      only({ status: 'active' }, (p) => p.active);
      const wh = d.warehouses[0].id;
      expect(rowsOf(d, { warehouse: wh }).every((r) => r.w?.id === wh)).toBe(true);
      expect(rowsOf(d, { warehouse: wh }).length).toBeGreaterThan(0);
      expect(rowsOf(d, { stock: 'in' }).every((r) => r.qty > 0)).toBe(true);
      expect(rowsOf(d, { low: true }).every((r) => r.min != null && r.qty < r.min)).toBe(true);
      only({ from: '2026-01-05', to: '2026-01-20' }, (p) => !!p.createdAt && p.createdAt.slice(0, 10) >= '2026-01-05' && p.createdAt.slice(0, 10) <= '2026-01-20');
    });
  });

  it('keyword search: name, SKU, legacy SKU, barcode, brand, description; every word must match; case-insensitive', () => {
    tx((d) => {
      const stocked = decorate(d);
      const p = stocked[2]; p.legacySku = 'OLD-CODE-777'; p.barcode = '8851234567890'; p.description = 'Imported premium lot';
      const hit = (q: string) => rowsOf(d, { q }).some((r) => r.p.id === p.id);
      expect(hit(p.name.toUpperCase())).toBe(true);
      expect(hit(p.sku.toLowerCase())).toBe(true);
      expect(hit('old-code-777')).toBe(true);
      expect(hit('8851234567890')).toBe(true);
      expect(hit('premium lot')).toBe(true);
      expect(hit(`${p.name.split(' ')[0]} premium`)).toBe(true);        // words from different fields
      expect(hit('premium zzz-nomatch')).toBe(false);                    // one word missing -> no match
      expect(rowsOf(d, { q: '   ' }).length).toBe(rowsOf(d, {}).length); // blank search = no filter
    });
  });

  it('several filters at once give the intersection; clearing them restores the full list', () => {
    tx((d) => {
      const stocked = decorate(d);
      const f = F({ skuType: 'RM', status: 'active', stock: 'in', brand: 'Alpha', from: '2026-01-01' });
      const manual = rowsOf(d, {}).filter((r) => skuCategoryOf(r.p.kind) === 'RM' && r.p.active && r.qty > 0 && r.p.brand === 'Alpha' && !!r.p.createdAt && r.p.createdAt.slice(0, 10) >= '2026-01-01');
      expect(ids(buildStockRows(d, f, reservedMap(d)))).toEqual(ids(manual));
      expect(activeFilterCount(f)).toBe(5);
      expect(ids(buildStockRows(d, EMPTY_STOCK_FILTERS, reservedMap(d)))).toEqual(legacyRows(d));
      expect(stocked.length).toBeGreaterThan(5);
    });
  });

  it('"Out of stock": rows at zero or below; a chosen warehouse also lists products never stocked there; all warehouses lists never-stocked products once', () => {
    tx((d) => {
      decorate(d);
      const never = d.products.find((p) => p.kind === 'resale' && !Object.keys(d.balances).some((k) => k.endsWith('|' + p.id) && d.balances[k].qty) && !Object.keys(p.levels).length);
      const w0 = d.warehouses[0].id;
      const target = saveProduct(d, ctx, { name: 'Never stocked', sku: 'FG-910001', kind: 'resale' });
      const outAll = rowsOf(d, { stock: 'out' });
      expect(outAll.every((r) => r.qty <= 0)).toBe(true);
      const mine = outAll.filter((r) => r.p.id === target);
      expect(mine).toHaveLength(1);
      expect(mine[0].w).toBeNull();                                    // one row, no warehouse
      const outWh = rowsOf(d, { stock: 'out', warehouse: w0 });
      expect(outWh.filter((r) => r.p.id === target)).toHaveLength(1);
      expect(outWh.find((r) => r.p.id === target)!.w?.id).toBe(w0);   // listed for the chosen warehouse
      expect(rowsOf(d, { stock: 'in' }).some((r) => r.p.id === target)).toBe(false);
      if (never) expect(outAll.some((r) => r.p.id === never.id)).toBe(true);
      // a product that has stock somewhere never shows up as "never stocked"
      const stockedPid = Object.keys(d.balances).find((k) => d.balances[k].qty > 0)!.split('|')[1];
      expect(outAll.filter((r) => r.p.id === stockedPid).every((r) => r.w !== null)).toBe(true);
    });
  });

  it('date filter is inclusive, and products without a creation date can never satisfy it', () => {
    tx((d) => {
      const stocked = decorate(d);
      const dated = stocked.find((p) => p.createdAt)!;
      const day = dated.createdAt!.slice(0, 10);
      expect(rowsOf(d, { from: day, to: day }).some((r) => r.p.id === dated.id)).toBe(true);
      const undated = stocked.find((p) => !p.createdAt)!;
      expect(rowsOf(d, { from: '2000-01-01' }).some((r) => r.p.id === undated.id)).toBe(false);
      expect(rowsOf(d, { to: '2100-01-01' }).some((r) => r.p.id === undated.id)).toBe(false);
      expect(rowsOf(d, {}).some((r) => r.p.id === undated.id)).toBe(true);   // still listed without a date filter
    });
  });

  it('counts matching products (not rows) and offers dropdown values taken from the data', () => {
    tx((d) => {
      const stocked = decorate(d);
      const rows = rowsOf(d, {});
      expect(matchingProducts(rows)).toBe(new Set(rows.map((r) => r.p.id)).size);
      expect(matchingProducts(rows)).toBeLessThanOrEqual(rows.length);
      const o = filterOptions(d);
      expect(o.brands).toEqual(['Alpha', 'Beta']);
      expect(o.categories).toEqual(Array.from(new Set(stocked.map((p) => p.category))).sort((a, b) => a.localeCompare(b)));
      expect(o.units).toContain(stocked[0].unit);
    });
  });

  it('new products record their creation date and brand', () => {
    tx((d) => {
      const id = saveProduct(d, ctx, { name: 'Dated', sku: 'FG-910002', kind: 'finished', brand: '  Gamma  ' });
      expect(d.products.find((p) => p.id === id)).toMatchObject({ brand: 'Gamma', createdAt: ctx.now });
    });
  });

  it('stays fast on a large catalogue (20,000 products x 3 warehouses, every filter on)', () => {
    const warehouses = ['W1', 'W2', 'W3'].map((id) => ({ id, code: id, name: id, branchId: 'B1', kind: 'store' as const }));
    const products: Product[] = []; const balances: DB['balances'] = {};
    for (let i = 0; i < 20000; i++) {
      const kind = (['resale', 'finished', 'material', 'packaging', 'wip'] as const)[i % 5];
      products.push({ id: 'P' + i, sku: `${skuCategoryOf(kind)}-${String(i + 1).padStart(6, '0')}`, name: `Product number ${i}`, category: `Cat ${i % 40}`, kind, unit: i % 2 ? 'pcs' : 'kg', price: 10, channelPrices: {}, active: i % 7 !== 0, emoji: '', color: '', stdCost: 1, levels: i % 3 === 0 ? { W1: { min: 5, max: 50 } } : {}, mediaIds: [], brand: `Brand ${i % 25}`, createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString() } as Product);
      if (i % 2 === 0) balances[bkey('W' + (1 + (i % 3)), 'P' + i)] = { qty: i % 11, value: (i % 11) * 3, lastCost: 3 };
    }
    const d = { products, warehouses, balances } as unknown as DB;
    const t0 = performance.now();
    const all = buildStockRows(d, EMPTY_STOCK_FILTERS, {});
    const filtered = buildStockRows(d, F({ q: 'product number 1', skuType: 'FG', status: 'active', stock: 'in', brand: 'Brand 3', unit: 'pcs', from: '2026-02-01', to: '2026-10-01' }), {});
    const out = buildStockRows(d, F({ stock: 'out' }), {});
    const ms = performance.now() - t0;
    expect(all.length).toBeGreaterThan(10000);
    expect(filtered.length).toBeLessThan(all.length);
    expect(out.length).toBeGreaterThan(0);
    expect(ms, `three full passes took ${ms.toFixed(0)} ms`).toBeLessThan(1500);
  });
});
