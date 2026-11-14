// Small hand-off between the customer app's tabs: opening a product or an order from somewhere else (a layout's product
// card, "buy now", a freshly placed order) and the catalogue filters, which have to survive going to a product and back.
import { createContext, useContext } from 'react';
import { create } from 'zustand';
import type { SortKey } from './api';

export interface CatalogFilter { q: string; category: string; brand: string; sort: SortKey }
export const EMPTY_FILTER: CatalogFilter = { q: '', category: '', brand: '', sort: 'recommended' };

interface NavState {
  pendingSku: string | null; pendingOrder: string | null; pendingWallet: boolean; catalog: CatalogFilter;
  openProduct: (sku: string) => void; openOrder: (id: string) => void; takeSku: () => string | null; takeOrder: () => string | null;
  setCatalog: (patch: Partial<CatalogFilter>) => void; resetCatalog: () => void;
}
export const useShopNav = create<NavState>((set, get) => ({
  pendingSku: null, pendingOrder: null, pendingWallet: false, catalog: EMPTY_FILTER,
  openProduct: (sku) => set({ pendingSku: sku }), openOrder: (id) => set({ pendingOrder: id }),
  takeSku: () => { const v = get().pendingSku; if (v) set({ pendingSku: null }); return v; },
  takeOrder: () => { const v = get().pendingOrder; if (v) set({ pendingOrder: null }); return v; },
  setCatalog: (patch) => set({ catalog: { ...get().catalog, ...patch } }),
  resetCatalog: () => set({ catalog: EMPTY_FILTER }),
}));

/** What the host (pages/CustomerApp.tsx) gives the shop screens: switching tabs. */
export interface ShopHostApi { goTab: (tab: 'home' | 'shop' | 'cart' | 'pay' | 'profile') => void }
export const ShopHost = createContext<ShopHostApi>({ goTab: () => undefined });
export const useShopHost = () => useContext(ShopHost);
