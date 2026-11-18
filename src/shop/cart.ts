// The shopping cart. It lives on the customer's device (per signed-in user) and holds only "which SKU, how many" plus a
// display snapshot (name / picture / price as last seen). The snapshot is never used for money: the cart page and the
// checkout show what the server quotes (shop_quote) and the order is priced by the database (shop_place_order).
import { create } from 'zustand';

export interface CartLine { sku: string; qty: number; name: string; price: number; image: string | null; max: number | null }
export const MAX_QTY = 99;
export const MAX_LINES = 40;

export const clampQty = (q: number, max?: number | null): number => {
  const n = Math.floor(Number.isFinite(q) ? q : 1);
  return Math.max(1, Math.min(MAX_QTY, max ?? MAX_QTY, n));
};

export interface CartSource { sku_code: string; name: string; price: number; image_url: string | null; max_qty: number | null }

/** Add `qty` of an item (merging into an existing line, never above the per-order limit or 99). */
export function addLine(lines: CartLine[], it: CartSource, qty = 1): CartLine[] {
  const have = lines.find((l) => l.sku === it.sku_code);
  if (have) return lines.map((l) => (l.sku === it.sku_code ? { ...l, qty: clampQty(l.qty + qty, it.max_qty), name: it.name, price: it.price, image: it.image_url, max: it.max_qty } : l));
  if (lines.length >= MAX_LINES) return lines;
  return [...lines, { sku: it.sku_code, qty: clampQty(qty, it.max_qty), name: it.name, price: it.price, image: it.image_url, max: it.max_qty }];
}
/**
 * Put the items of an earlier order (e.g. one the shop cancelled) back into the cart: "order again" (FB-001002). The prices are only a display
 * snapshot: the cart page re-quotes every line with the server, so an item that has since been hidden or repriced shows up there, never here.
 * Returns how many order lines could be added (the cart holds at most MAX_LINES lines).
 */
export function addOrderItems(lines: CartLine[], items: Array<{ sku_code: string; name: string; unit_price: number; qty: number; image_url: string | null }>): { lines: CartLine[]; added: number } {
  let next = lines; let added = 0;
  for (const it of items) {
    const before = next;
    next = addLine(next, { sku_code: it.sku_code, name: it.name, price: it.unit_price, image_url: it.image_url, max_qty: null }, it.qty);
    if (next !== before) added++;
  }
  return { lines: next, added };
}
/** Set a line's quantity; 0 (or less) removes it. */
export function setLineQty(lines: CartLine[], sku: string, qty: number): CartLine[] {
  if (!(qty >= 1)) return lines.filter((l) => l.sku !== sku);
  return lines.map((l) => (l.sku === sku ? { ...l, qty: clampQty(qty, l.max) } : l));
}
export const removeLine = (lines: CartLine[], sku: string): CartLine[] => lines.filter((l) => l.sku !== sku);
export const cartCount = (lines: CartLine[]): number => lines.reduce((s, l) => s + l.qty, 0);
export const toQuoteItems = (lines: CartLine[]) => lines.map((l) => ({ sku_code: l.sku, qty: l.qty }));

/** Parse what localStorage holds. It is untrusted (another tab, an old build, hand-edited): anything odd is dropped. */
export function parseStored(raw: string | null): CartLine[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: CartLine[] = [];
    for (const x of v) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const sku = typeof o.sku === 'string' ? o.sku.slice(0, 40) : '';
      const qty = o.qty;
      if (!sku || seen.has(sku) || typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) continue;
      seen.add(sku);
      const max = typeof o.max === 'number' && o.max >= 1 && o.max <= MAX_QTY ? Math.floor(o.max) : null;
      out.push({
        sku, qty: clampQty(qty, max), name: typeof o.name === 'string' ? o.name.slice(0, 200) : sku, price: typeof o.price === 'number' && isFinite(o.price) && o.price >= 0 ? o.price : 0,
        image: typeof o.image === 'string' && /^https:\/\//.test(o.image) ? o.image : null, max,
      });
      if (out.length >= MAX_LINES) break;
    }
    return out;
  } catch { return []; }
}

const keyOf = (uid: string) => `tc.cart.v1:${uid}`;
const read = (uid: string): CartLine[] => { try { return parseStored(localStorage.getItem(keyOf(uid))); } catch { return []; } };
const write = (uid: string | null, lines: CartLine[]) => { if (!uid) return; try { if (lines.length) localStorage.setItem(keyOf(uid), JSON.stringify(lines)); else localStorage.removeItem(keyOf(uid)); } catch { /* storage unavailable: the cart still works for this visit */ } };

interface CartState {
  uid: string | null; lines: CartLine[];
  /** Load the cart of the signed-in user (call when the session is known). */
  hydrate: (uid: string | null) => void;
  add: (it: CartSource, qty?: number) => void;
  /** Add the items of an earlier order; returns how many lines were added. */
  reorder: (items: Parameters<typeof addOrderItems>[1]) => number;
  setQty: (sku: string, qty: number) => void;
  remove: (sku: string) => void;
  removeMany: (skus: string[]) => void;
  clear: () => void;
}
export const useCart = create<CartState>((set, get) => {
  const commit = (lines: CartLine[]) => { write(get().uid, lines); set({ lines }); };
  return {
    uid: null, lines: [],
    hydrate: (uid) => { if (get().uid === uid) return; set({ uid, lines: uid ? read(uid) : [] }); },
    add: (it, qty = 1) => commit(addLine(get().lines, it, qty)),
    reorder: (items) => { const r = addOrderItems(get().lines, items); commit(r.lines); return r.added; },
    setQty: (sku, qty) => commit(setLineQty(get().lines, sku, qty)),
    remove: (sku) => commit(removeLine(get().lines, sku)),
    removeMany: (skus) => commit(get().lines.filter((l) => !skus.includes(l.sku))),
    clear: () => commit([]),
  };
});
export const useCartCount = () => useCart((s) => cartCount(s.lines));

// ---------------------------------------------------------------- checkout attempts (duplicate-order protection)
/** A fresh idempotency key for one checkout attempt (8–64 chars of letters, digits, - and _, as the database requires). */
export const newKey = (): string => {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID(); } catch { /* fall through */ }
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
};
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const attemptStoreKey = (uid: string, ns: string) => `tc.${ns}.attempt:${uid}`;
/**
 * The idempotency key for submitting `payload` (cart + contact details). The SAME payload keeps the SAME key, also across a
 * page reload, so a retry after a dropped connection (or a double tap) returns the order that was already created. A different
 * payload (the customer changed the cart) gets a new key.
 */
export function attemptKey(store: KV, uid: string, payload: string, gen: () => string = newKey, ns = 'shop'): string {
  try {
    const raw = store.getItem(attemptStoreKey(uid, ns));
    const v = raw ? (JSON.parse(raw) as { key?: string; payload?: string }) : null;
    if (v && typeof v.key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v.key) && v.payload === payload) return v.key;
  } catch { /* corrupted: make a new one */ }
  const key = gen();
  try { store.setItem(attemptStoreKey(uid, ns), JSON.stringify({ key, payload })); } catch { /* private mode: the in-memory attempt still protects this visit */ }
  return key;
}
export const forgetAttempt = (store: KV, uid: string, ns = 'shop') => { try { store.removeItem(attemptStoreKey(uid, ns)); } catch { /* ignore */ } };
