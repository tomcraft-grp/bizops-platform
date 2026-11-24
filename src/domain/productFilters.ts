// Filters of the Products page. The summary cards and the boxes above the table are the SAME filter, so they can never disagree.
// A card's number is taken from the whole catalogue (no box or search changes it) and equals the length of the list its click opens.
import { onSale } from './orders';
import { skuCategoryOf, type SkuCategory } from './sku';
import type { Product, ProductKind } from './types';

/** '' = all. `onsale` is the POS rule (orders.ts `onSale`); `raw` is raw materials and packaging together. */
export type ProductStatus = '' | 'active' | 'inactive' | 'unsynced' | 'onsale';
export type ProductKindFilter = '' | ProductKind | 'raw';
export interface ProductFilter { status: ProductStatus; kind: ProductKindFilter; skuType: '' | SkuCategory; category: string; q: string }
export const EMPTY_PRODUCT_FILTER: ProductFilter = { status: '', kind: '', skuType: '', category: '', q: '' };

/** What the page knows and a product does not say by itself. */
export interface ProductFilterCtx { notSynced: (p: Product) => boolean; inCategory: (p: Product, categoryId: string) => boolean; text: (p: Product) => string }

const isRaw = (p: Product) => p.kind === 'material' || p.kind === 'packaging';
const matchesStatus = (p: Product, s: ProductStatus, notSynced: ProductFilterCtx['notSynced']): boolean => {
  switch (s) {
    case '': return true;
    case 'onsale': return onSale(p);
    case 'unsynced': return notSynced(p);
    default: return (s === 'active') === p.active;
  }
};
const matchesKind = (p: Product, k: ProductKindFilter) => !k || (k === 'raw' ? isRaw(p) : p.kind === k);

export function filterProducts(rows: Product[], f: ProductFilter, ctx: ProductFilterCtx): Product[] {
  const q = f.q.toLowerCase();
  return rows.filter((p) => matchesStatus(p, f.status, ctx.notSynced) && matchesKind(p, f.kind) && (!f.skuType || skuCategoryOf(p.kind) === f.skuType)
    && (!f.category || ctx.inCategory(p, f.category)) && (!q || ctx.text(p).toLowerCase().includes(q)));
}

export type ProductCardId = 'all' | 'onsale' | 'menu' | 'raw' | 'inactive';
export interface ProductCard { id: ProductCardId; label: string; sub?: string; set: Pick<ProductFilter, 'status' | 'kind'> }
export const PRODUCT_CARDS: ProductCard[] = [
  { id: 'all', label: 'Products', set: { status: '', kind: '' } },
  { id: 'onsale', label: 'Active Products', sub: 'active and available for sale', set: { status: 'onsale', kind: '' } },
  { id: 'menu', label: 'Menu items (recipes)', sub: 'stock deducted by BOM', set: { status: '', kind: 'menu' } },
  { id: 'raw', label: 'Raw & packaging', sub: 'inventory-only items', set: { status: '', kind: 'raw' } },
  { id: 'inactive', label: 'Inactive', sub: 'hidden from POS', set: { status: 'inactive', kind: '' } },
];
/** The number on each card: always the whole catalogue. */
export function cardCounts(rows: Product[]): Record<ProductCardId, number> {
  const n: Record<ProductCardId, number> = { all: rows.length, onsale: 0, menu: 0, raw: 0, inactive: 0 };
  for (const p of rows) { if (onSale(p)) n.onsale++; if (p.kind === 'menu') n.menu++; if (isRaw(p)) n.raw++; if (!p.active) n.inactive++; }
  return n;
}
/** The card the filter stands for. A card narrowed further by a box or the search stays selected; no card when only other boxes are set. */
export function selectedCard(f: ProductFilter): ProductCardId | null {
  if (f.status === 'onsale' || f.status === 'inactive') return f.status;
  if (f.status) return null;
  if (f.kind === 'menu' || f.kind === 'raw') return f.kind;
  return f.kind || f.skuType || f.category ? null : 'all';
}
/** Pressing a card: exactly its products (the boxes are cleared, so the list is as long as its number); pressing the selected card again: everything. The search text stays. */
export function pressProductCard(f: ProductFilter, id: ProductCardId): ProductFilter {
  const card = PRODUCT_CARDS.find((c) => c.id === (selectedCard(f) === id ? 'all' : id))!;
  return { ...EMPTY_PRODUCT_FILTER, q: f.q, ...card.set };
}
export const STATUS_LABEL: Record<Exclude<ProductStatus, ''>, string> = { onsale: 'Active & on sale', active: 'Active', inactive: 'Inactive', unsynced: 'Not synced yet' };
