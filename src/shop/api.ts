// Customer shop data access. Everything goes through the signed-in user's Supabase session and the SECURITY DEFINER
// functions of supabase/migrations/20261115100000_customer_shop.sql: the database decides what is sellable, every price,
// the totals, the order and its payment status. The app only ever sends "SKU + quantity" and contact details.
import { supabase } from '../lib/supabase';
import type { InvoiceRow } from '../finance/api';

// ---------------------------------------------------------------- types
export interface ShopSpec { label: string; value: string }
export interface ShopItem {
  sku_code: string; name: string; name_th: string | null; name_en: string | null; brand: string | null; category: string; unit: string | null; pack_qty: number | null;
  price: number; barcode: string | null; description_th: string | null; description_en: string | null; specs: ShopSpec[]; family: string | null; badge: string | null;
  featured: boolean; available: boolean; max_qty: number | null; image_url: string | null; image_urls: string[];
}
export interface ShopProduct extends ShopItem { siblings: ShopItem[]; related: ShopItem[] }
export interface CategoryFacet { code: string; name_th: string | null; name_en: string | null; count: number; image_url: string | null }
export interface BrandFacet { brand: string; count: number }
export interface Facets { categories: CategoryFacet[]; brands: BrandFacet[] }
export interface ShopSettings {
  shop_open: boolean; closed_message: string | null; delivery_enabled: boolean; pickup_enabled: boolean; pickup_note: string | null;
  shipping_fee: number; free_shipping_min: number | null;
}
export type SortKey = 'recommended' | 'newest' | 'price_asc' | 'price_desc' | 'name';
export interface CatalogQuery { search?: string; category?: string; brand?: string; sort?: SortKey; limit?: number; offset?: number; featured?: boolean }
export interface CatalogPage { total: number; items: ShopItem[] }
export interface HomeData { featured: ShopItem[]; newest: ShopItem[]; popular: ShopItem[] }

export type LineProblem = 'bad_qty' | 'not_found' | 'sold_out' | 'over_limit';
export interface QuoteLine {
  sku_code: string; qty: number; ok: boolean; problem?: LineProblem; name?: string; unit?: string | null; pack_qty?: number | null; unit_price?: number;
  line_total?: number; max_qty?: number | null; image_url?: string | null;
}
export type Fulfilment = 'delivery' | 'pickup';
export interface Quote {
  lines: QuoteLine[]; subtotal: number; discount: number; shipping_fee: number; total: number; fulfilment: Fulfilment; free_shipping_min: number | null; ok: boolean;
  problems: { sku_code?: string; problem: string; max_qty?: number }[];
}
export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'packed' | 'ready' | 'shipped' | 'completed' | 'cancelled' | 'returned';
export interface OrderItem { line_no: number; sku_code: string; name: string; unit: string | null; unit_price: number; qty: number; line_total: number; image_url: string | null }
export interface ShopOrder {
  id: string; order_no: string; status: OrderStatus; fulfilment: Fulfilment; channel: string; contact_name: string; contact_phone: string; delivery_address: string | null; note: string | null;
  subtotal: number; discount: number; shipping_fee: number; total: number; created_at: string; updated_at: string; status_note: string | null; cancel_reason: string | null;
  cancelled_at: string | null; payment_pref?: string | null; items: OrderItem[]; invoice: InvoiceRow;
  events?: { at: string; action: string; to?: string | null }[];
}
export type OrderFilter = 'all' | 'unpaid' | 'to_ship' | 'to_receive' | 'done' | 'cancelled';
export interface OrdersPage { total: number; orders: ShopOrder[] }
export interface PlaceOrderInput { key: string; items: { sku_code: string; qty: number }[]; fulfilment: Fulfilment; name: string; phone: string; address: string; note: string; paymentMethod?: string | null; expectedTotal: number | null }

// staff
export interface AdminOrder extends ShopOrder {
  customer?: { code: string; name: string; phone: string | null; line_user_id: string | null };
  events?: { at: string; actor_email: string | null; action: string; detail: Record<string, unknown> }[];
}
export interface AdminOrdersPage { total: number; counts: Partial<Record<OrderStatus, number>>; orders: AdminOrder[] }
export interface AdminSettings extends ShopSettings {
  image_base_url: string; updated_at: string; payment_account_ready: boolean; visible_products: number; products_with_image: number;
}
export interface AdminCategory { code: string; count: number; name_th: string | null; name_en: string | null; image_path: string | null; image_url: string | null; sort_order: number; visible: boolean }
export interface AdminProduct {
  sku_code: string; name: string; brand: string | null; status: string; category: string; price: number | null; description_th: string | null; description_en: string | null;
  image_paths: string[]; image_urls: string[]; specs: ShopSpec[]; family: string | null; badge: string | null; featured: boolean; visible: boolean; available: boolean;
  max_qty: number | null; sort_order: number; on_sale: boolean; why_hidden: 'inactive' | 'no_price' | 'hidden_by_staff' | 'category_hidden' | null;
}
export type ContentPatch = Partial<{
  description_th: string; description_en: string; image_paths: string[]; specs: ShopSpec[]; family: string; badge: string; featured: boolean; visible: boolean;
  available: boolean; max_qty: number | string; sort_order: number;
}>;

// ---------------------------------------------------------------- errors
/** A failed shop call. `code` is the database's machine-readable reason (SHOP_CLOSED, PRICE_CHANGED, …) when there is one. */
export class ShopError extends Error {
  constructor(message: string, public code: string, public detail?: string) { super(message); }
}
const CODE = /^([A-Z][A-Z_]{2,})(?::|$)/;   // "SHOP_CLOSED" or "DEPOSIT_NOT_REVIEWABLE: this deposit is rejected"
function fail(e: { message?: string; details?: string | null; code?: string }): never {
  const m = (e.message ?? '').trim();
  const code = CODE.exec(m);
  if (code) throw new ShopError(m, code[1], e.details ?? undefined);
  // a dropped connection is not a business error: the checkout is idempotent, so the customer may simply retry
  if (/fetch|network|failed to load|timeout/i.test(m)) throw new ShopError(m, 'NETWORK');
  if (e.code === '42501' || /sign in|not allowed|permission denied/i.test(m)) throw new ShopError(m, 'FORBIDDEN');
  throw new ShopError(m || 'Request failed', 'ERROR');
}
export async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  let r;
  try { r = await supabase.rpc(name, args); } catch (e) { throw new ShopError((e as Error).message || 'network', 'NETWORK'); }
  if (r.error) fail(r.error);
  return r.data as T;
}

// small time-boxed cache for data that changes rarely (facets, shop settings), so tab switches do not refetch
const cache = new Map<string, { at: number; v: unknown }>();
async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await load();
  cache.set(key, { at: Date.now(), v });
  return v;
}
export const clearShopCache = () => cache.clear();

// ---------------------------------------------------------------- customer
export const shop = {
  settings: () => memo('settings', 30_000, () => rpc<ShopSettings>('shop_settings_public')),
  facets: () => memo('facets', 60_000, () => rpc<Facets>('shop_facets')),
  catalog: (q: CatalogQuery) => rpc<CatalogPage>('shop_catalog', {
    p_search: q.search?.trim() || null, p_category: q.category || null, p_brand: q.brand || null, p_sort: q.sort ?? 'recommended',
    p_limit: q.limit ?? 24, p_offset: q.offset ?? 0, p_featured: !!q.featured,
  }),
  product: (sku: string) => rpc<ShopProduct | null>('shop_product', { p_sku: sku }),
  home: () => memo('home', 30_000, () => rpc<HomeData>('shop_home')),
  quote: (items: { sku_code: string; qty: number }[], fulfilment: Fulfilment) => rpc<Quote>('shop_quote', { p_items: items, p_fulfilment: fulfilment }),
  async placeOrder(i: PlaceOrderInput): Promise<{ replay: boolean; order: ShopOrder }> {
    const r = await rpc<{ replay: boolean; order: ShopOrder }>('shop_place_order', {
      p_key: i.key, p_items: i.items, p_fulfilment: i.fulfilment, p_name: i.name, p_phone: i.phone, p_address: i.fulfilment === 'delivery' ? i.address : null,
      p_note: i.note || null, p_expected_total: i.expectedTotal, ...(i.paymentMethod ? { p_payment_method: i.paymentMethod } : {}),
    });
    clearShopCache();
    return r;
  },
  myOrders: (filter: OrderFilter = 'all', limit = 20, offset = 0) => rpc<OrdersPage>('shop_my_orders', { p_filter: filter, p_limit: limit, p_offset: offset }),
  myOrder: (id: string) => rpc<ShopOrder>('shop_my_order', { p_id: id }),
  cancelMyOrder: (id: string, reason?: string) => rpc<ShopOrder>('shop_cancel_my_order', { p_id: id, p_reason: reason ?? null }),
};

// ---------------------------------------------------------------- staff
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Shrink a picture in the browser (max 1200 px, WebP) before it goes to the public product-picture bucket (2 MB limit). */
export async function prepareImage(file: File, max = 1200): Promise<Blob> {
  if (!IMG_TYPES.includes(file.type)) throw new Error('Choose a JPG, PNG or WebP picture');
  const bmp = await createImageBitmap(file);
  try {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d')!; g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/webp', 0.86));
    if (!blob) throw new Error('Could not process this picture');
    if (blob.size > 2 * 1024 * 1024) throw new Error('The picture is still over 2 MB after shrinking: use a smaller one');
    return blob;
  } finally { bmp.close(); }
}
async function uploadPublic(folder: string, file: File): Promise<string> {
  const blob = await prepareImage(file);
  const path = `${folder}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.webp`;
  const { error } = await supabase.storage.from('shop-products').upload(path, blob, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' });
  if (error) throw new Error(error.message);
  return path;
}

export const shopAdmin = {
  orders: (p: { status?: string; search?: string; limit?: number; offset?: number }) =>
    rpc<AdminOrdersPage>('shop_admin_orders', { p_status: p.status || null, p_search: p.search || null, p_limit: p.limit ?? 30, p_offset: p.offset ?? 0 }),
  order: (id: string) => rpc<AdminOrder>('shop_admin_order', { p_id: id }),
  setStatus: (id: string, status: OrderStatus, note?: string, overrideReason?: string) =>
    rpc<ShopOrder>('shop_admin_set_status', { p_order: id, p_status: status, p_note: note || null, p_override_reason: overrideReason || null }),
  settings: () => rpc<AdminSettings>('shop_admin_settings'),
  saveSettings: (patch: Partial<Omit<ShopSettings, 'free_shipping_min'>> & { free_shipping_min?: number | null }) => rpc<AdminSettings>('shop_admin_save_settings', { p_patch: patch }),
  categories: () => rpc<AdminCategory[]>('shop_admin_categories'),
  saveCategory: (code: string, patch: Partial<{ name_th: string; name_en: string; image_path: string; sort_order: number; visible: boolean }>) => rpc<void>('shop_admin_save_category', { p_code: code, p_patch: patch }),
  products: (p: { search?: string; filter?: string; limit?: number; offset?: number }) =>
    rpc<{ total: number; items: AdminProduct[] }>('shop_admin_products', { p_search: p.search || null, p_filter: p.filter ?? 'all', p_limit: p.limit ?? 40, p_offset: p.offset ?? 0 }),
  saveContent: (sku: string, patch: ContentPatch) => rpc<void>('shop_admin_save_content', { p_sku: sku, p_patch: patch }),
  uploadProductImage: (sku: string, file: File) => uploadPublic(sku, file),
  uploadCategoryImage: (file: File) => uploadPublic('categories', file),
};
