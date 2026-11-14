// SKU codes are issued by the central database (public.sku_reserve), never typed or generated in the browser:
//   FG-000001  finished goods   RM-000001  raw materials   WIP-000001  work in process
// This file only describes the format and how product kinds map onto the three SKU categories.
import type { Product, ProductKind } from './types';

export type SkuCategory = 'FG' | 'RM' | 'WIP';
export const SKU_CATEGORIES: SkuCategory[] = ['FG', 'RM', 'WIP'];
export const SKU_CATEGORY_LABEL: Record<SkuCategory, string> = { FG: 'FG – Finished goods', RM: 'RM – Raw materials', WIP: 'WIP – Work in process' };

/** Mirror of the database format (public.sku_format): prefix, dash, at least six digits. */
export const SKU_CODE_RE = /^(FG|RM|WIP)-\d{6,}$/;
export const isStandardSku = (s?: string | null): boolean => !!s && SKU_CODE_RE.test(s);
export const skuCategoryOfCode = (s?: string | null): SkuCategory | null => (s && SKU_CODE_RE.exec(s)?.[1]) as SkuCategory | null || null;

/** Product kinds that belong to each SKU category (a kind decides POS / BOM / stock-account behaviour; the category decides the code). */
export const KINDS_OF_CATEGORY: Record<SkuCategory, ProductKind[]> = { FG: ['finished', 'resale', 'menu'], RM: ['material', 'packaging'], WIP: ['wip'] };
export const skuCategoryOf = (kind: ProductKind): SkuCategory => (kind === 'material' || kind === 'packaging' ? 'RM' : kind === 'wip' ? 'WIP' : 'FG');
export const productSkuCategory = (p: Pick<Product, 'kind'>): SkuCategory => skuCategoryOf(p.kind);
