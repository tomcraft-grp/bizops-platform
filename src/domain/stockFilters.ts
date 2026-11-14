// Filters for the Inventory > Stock levels list. Pure functions over the in-browser DB so they can be unit-tested and
// stay fast on large catalogues: product-level filters run first, per-warehouse rows are only built for the survivors.
import type { DB, ID, Product, ProductKind, Warehouse } from './types';
import { bkey } from './inventory';
import { skuCategoryOf, type SkuCategory } from './sku';
import { dayKey } from '../lib/util';

export interface StockFilters {
  q: string;                         // keywords: every word must appear in name / SKU / legacy SKU / barcode / brand / category / description
  skuType: '' | SkuCategory;         // FG / RM / WIP
  kind: '' | ProductKind;
  category: string;
  brand: string;
  unit: string;
  status: '' | 'active' | 'inactive';
  stock: '' | 'in' | 'out';          // on hand > 0 / on hand <= 0 (per warehouse row)
  warehouse: ID | '';
  low: boolean;                      // below reorder level
  from: string;                      // created on/after (yyyy-mm-dd)
  to: string;                        // created on/before
}
export const EMPTY_STOCK_FILTERS: StockFilters = { q: '', skuType: '', kind: '', category: '', brand: '', unit: '', status: '', stock: '', warehouse: '', low: false, from: '', to: '' };

export interface StockRow {
  p: Product; w: Warehouse | null;   // w is null only for "out of stock" products that have never been stocked anywhere
  qty: number; value: number; res: number; min?: number; max?: number;
}

/** How many filters are switched on (the keyword box counts when it is not blank). */
export function activeFilterCount(f: StockFilters): number {
  return (f.q.trim() ? 1 : 0) + (['skuType', 'kind', 'category', 'brand', 'unit', 'status', 'stock', 'warehouse', 'from', 'to'] as const).filter((k) => f[k] !== '').length + (f.low ? 1 : 0);
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const haystack = (p: Product) => `${p.name} ${p.sku} ${p.legacySku ?? ''} ${p.barcode ?? ''} ${p.brand ?? ''} ${p.category} ${p.description ?? ''}`.toLowerCase();

/** Product-level part of the filters (everything except warehouse / stock / low, which depend on balances). */
export function productMatches(p: Product, f: StockFilters, kw: string[] = words(f.q)): boolean {
  if (f.skuType && skuCategoryOf(p.kind) !== f.skuType) return false;
  if (f.kind && p.kind !== f.kind) return false;
  if (f.category && p.category !== f.category) return false;
  if (f.brand && (p.brand ?? '') !== f.brand) return false;
  if (f.unit && p.unit !== f.unit) return false;
  if (f.status && (f.status === 'active') !== p.active) return false;
  if (f.from || f.to) { // products saved before creation dates existed have none: they cannot satisfy a date filter
    const day = p.createdAt ? dayKey(p.createdAt) : '';
    if (!day || (f.from && day < f.from) || (f.to && day > f.to)) return false;
  }
  if (kw.length) { const h = haystack(p); for (const w of kw) if (!h.includes(w)) return false; }
  return true;
}

/**
 * One row per (product, warehouse) that holds stock or has a reorder level, as before. Recipes (menu items) hold no stock.
 * "Out of stock" lists zero-or-negative rows; for a chosen warehouse it also lists products that never had stock there, and
 * with all warehouses it lists a product that has no stock rows at all once (warehouse "–").
 */
export function buildStockRows(d: DB, f: StockFilters, reserved: Record<string, number>): StockRow[] {
  const kw = words(f.q);
  const out: StockRow[] = [];
  for (const p of d.products) {
    if (p.kind === 'menu' || !productMatches(p, f, kw)) continue;
    const rows: StockRow[] = [];
    for (const w of d.warehouses) {
      if (f.warehouse && w.id !== f.warehouse) continue;
      const b = d.balances[bkey(w.id, p.id)];
      const lv = p.levels[w.id];
      if (!b?.qty && !lv && !(f.warehouse && f.stock === 'out')) continue;
      rows.push({ p, w, qty: b?.qty ?? 0, value: b?.value ?? 0, res: reserved[bkey(w.id, p.id)] || 0, min: lv?.min, max: lv?.max });
    }
    let keep = rows;
    if (f.stock === 'in') keep = rows.filter((r) => r.qty > 0);
    else if (f.stock === 'out') {
      keep = rows.filter((r) => r.qty <= 0);
      if (!f.warehouse && !rows.length) keep = [{ p, w: null, qty: 0, value: 0, res: 0 }];
    }
    if (f.low) keep = keep.filter((r) => r.min != null && r.qty < r.min);
    for (const r of keep) out.push(r);
  }
  return out;
}

export const matchingProducts = (rows: StockRow[]) => new Set(rows.map((r) => r.p.id)).size;

/** Values offered by the dropdowns, taken from the data (no separate reference tables). */
export function filterOptions(d: DB) {
  const uniq = (xs: (string | undefined)[]) => Array.from(new Set(xs.filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b));
  const stocked = d.products.filter((p) => p.kind !== 'menu');
  return { categories: uniq(stocked.map((p) => p.category)), brands: uniq(stocked.map((p) => p.brand)), units: uniq(stocked.map((p) => p.unit)) };
}
