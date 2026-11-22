// Central product categories (supabase/migrations/20261122110000_product_categories.sql): the list every SKU points at. Staff read and change it only through
// SECURITY DEFINER functions that check the role again; the tables themselves are closed to clients. A database without the migration answers "function not
// found": the store then says `missing` and the screens keep the old free-text category, so the app works before and after the migration is applied.
import { useEffect } from 'react';
import { create } from 'zustand';
import { rpc, ShopError } from '../shop/api';
import { DEMO_SEED } from '../domain/demo';

export interface ProductCategory {
  id: string; code: string; name_th: string; name_en: string | null; description: string | null; parent_id: string | null;
  is_group: boolean; is_active: boolean; sort_order: number; product_count: number; active_product_count: number; created_at: string; updated_at: string;
}
export type CategoryPatch = Partial<{ code: string; name_th: string; name_en: string; description: string; parent_id: string | null; is_group: boolean; sort_order: number }>;

export const categoryApi = {
  list: (includeInactive = true) => rpc<ProductCategory[]>('product_categories_list', { p_include_inactive: includeInactive }),
  save: (id: string | null, patch: CategoryPatch) => rpc<ProductCategory>('product_category_save', { p_id: id, p_patch: patch }),
  setActive: (id: string, active: boolean, reason: string) => rpc<ProductCategory>('product_category_set_active', { p_id: id, p_active: active, p_reason: reason }),
};

/** True when the database has no category functions yet (the migration is not applied). */
export const isMissingFunction = (e: unknown) => /could not find the function|schema cache|does not exist/i.test((e as Error)?.message ?? '');
/** The server's "CODE: detail" errors as one readable sentence (English; screens pass it through t()). */
export function describeCategoryError(e: unknown): string {
  const m = ((e as Error)?.message ?? '').trim();
  if (e instanceof ShopError && e.code === 'NETWORK') return 'Cannot reach the central database. Check the connection and try again.';
  if (e instanceof ShopError && e.code === 'FORBIDDEN' && !/^[A-Z_]{3,}:/.test(m)) return 'Only staff (Admin or Super admin) can manage categories.';
  return m.replace(/^[A-Z][A-Z_]{2,}:\s*/, '') || 'The category service returned an error.';
}

type Status = 'idle' | 'loading' | 'ready' | 'missing' | 'error';
interface State { items: ProductCategory[]; status: Status; error: string | null; loadedAt: number }
export const useCategoryStore = create<State>(() => ({ items: [], status: 'idle', error: null, loadedAt: 0 }));

let inflight: Promise<void> | null = null;
/** Load (or reload) the list. Resolves, never rejects. Reuses a fresh list for 60 s unless forced. */
export function loadCategories(force = false): Promise<void> {
  if (DEMO_SEED) return Promise.resolve();                          // the demo build must not call the real project
  const s = useCategoryStore.getState();
  if (!force && s.status === 'ready' && Date.now() - s.loadedAt < 60_000) return Promise.resolve();
  if (inflight) return inflight;
  if (s.status !== 'ready') useCategoryStore.setState({ status: 'loading' });
  inflight = categoryApi.list(true)
    .then((items) => useCategoryStore.setState({ items: Array.isArray(items) ? items : [], status: 'ready', error: null, loadedAt: Date.now() }))
    .catch((e) => useCategoryStore.setState(isMissingFunction(e) ? { status: 'missing', error: null } : { status: s.status === 'ready' ? 'ready' : 'error', error: describeCategoryError(e) }))
    .finally(() => { inflight = null; });
  return inflight;
}
/** Put a row the server just returned into the list (create or update) without a reload. */
export function upsertCategory(c: ProductCategory) {
  useCategoryStore.setState((s) => ({ items: s.items.some((x) => x.id === c.id) ? s.items.map((x) => (x.id === c.id ? c : x)) : [...s.items, c] }));
}

export function useCategories(enabled = true) {
  const s = useCategoryStore();
  useEffect(() => { if (enabled) void loadCategories(); }, [enabled]);
  return s;
}

export const categoryName = (c: Pick<ProductCategory, 'name_th' | 'name_en'>, lang: 'th' | 'en') => (lang === 'en' ? c.name_en || c.name_th : c.name_th);

/**
 * What a product may be put in: active categories (never a group), arranged under their group for an <optgroup> list. `keep` adds a category the product
 * already has even when it is inactive, so an edit never silently drops it.
 */
export function categoryChoices(items: ProductCategory[], keep?: string | null): { group: ProductCategory | null; items: ProductCategory[] }[] {
  const byId = new Map(items.map((c) => [c.id, c]));
  const pick = items.filter((c) => !c.is_group && (c.is_active || c.id === keep));
  const out = new Map<string, { group: ProductCategory | null; items: ProductCategory[] }>();
  for (const c of pick) {
    const g = c.parent_id ? byId.get(c.parent_id) ?? null : null;
    const k = g?.id ?? '';
    if (!out.has(k)) out.set(k, { group: g, items: [] });
    out.get(k)!.items.push(c);
  }
  const sorted = [...out.values()].sort((a, b) => (a.group?.sort_order ?? 1e9) - (b.group?.sort_order ?? 1e9) || (a.group?.name_th ?? '').localeCompare(b.group?.name_th ?? ''));
  for (const g of sorted) g.items.sort((a, b) => a.sort_order - b.sort_order || a.name_th.localeCompare(b.name_th));
  return sorted;
}
