// Customer shop data access. Everything goes through the signed-in user's Supabase session and the SECURITY DEFINER
// functions of supabase/migrations/20261115100000_customer_shop.sql: the database decides what is sellable, every price,
// the totals, the order and its payment status. The app only ever sends "SKU + quantity" and contact details.
import { supabase } from '../lib/supabase';
import type { InvoiceRow } from '../finance/api';
import { TimeoutError, withTimeout } from './timeout';
import type { PinSource } from './geo/geo';

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
/** `no_brand_count` is only sent by a database that has migration 20261119100000 (the "no brand" filter): an older database leaves it out and the app then simply offers no such choice. */
export interface Facets { categories: CategoryFacet[]; brands: BrandFacet[]; no_brand_count?: number }
/** The brand filter value meaning "products that have no brand" (what shop_catalog's p_brand understands). No real brand uses this text. */
export const NO_BRAND = '__none__';
export interface ShopSettings {
  shop_open: boolean; closed_message: string | null; delivery_enabled: boolean; pickup_enabled: boolean; pickup_note: string | null;
  shipping_fee: number; free_shipping_min: number | null; require_payment_slip?: boolean;
  /** Only a database with the preorder migration sends it: without it the app simply offers no preorder. */
  preorder_enabled?: boolean;
  /** Only a database with the delivery-pin migration sends these: without them the app keeps the typed delivery address and offers no map. */
  store?: { name: string; lat: number; lng: number };
  delivery_pin_required?: boolean;
}
/** What the customer confirmed for a delivery (sent with the order). The database checks it again and builds the Google Maps links itself. */
export interface DeliveryInput {
  lat: number; lng: number; confirmed: true; pin_source: PinSource; recipient_name: string; recipient_phone: string; address_line: string;
  unit_no?: string; village?: string; floor_no?: string; landmark?: string; directions?: string; driver_note?: string; place_label?: string; address_id?: string;
  /** Measured by the routing service in the customer's browser; the database keeps it only when it is plausible. */
  route?: { distance_m: number; duration_s: number; source: 'osrm' } | null;
}
/** The delivery destination an order keeps (frozen when the order was placed). */
export interface DeliveryInfo {
  recipient_name: string; recipient_phone: string; address_line: string; unit_no: string | null; village: string | null; floor_no: string | null; landmark: string | null;
  directions: string | null; driver_note: string | null; place_label: string | null; lat: number; lng: number; pin_source: PinSource; confirmed_at: string;
  origin: { name: string; lat: number; lng: number }; maps_url: string; directions_url: string; straight_m: number;
  route: { distance_m: number; duration_s: number; source: 'osrm'; at: string | null } | null;
}
/** A delivery address the customer saved for later. */
export interface SavedAddress {
  id: string; label: string | null; recipient_name: string; recipient_phone: string; address_line: string; unit_no: string | null; village: string | null; floor_no: string | null; landmark: string | null;
  directions: string | null; driver_note: string | null; place_label: string | null; lat: number; lng: number; pin_source: PinSource; confirmed_at: string; is_default: boolean; updated_at: string;
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
/** The PromptPay QR of the cart about to be ordered (migration 20261123100000): the amount is the database's own total of that cart. */
export interface CheckoutQr { amount: number; qr_payload: string; account_label: string; merchant_name: string | null }
/** A day of the preorder calendar (shop time). `free_slots` counts the times still open for a new order. */
export interface PreorderDay { day: string; closed: boolean; open: string | null; close: string | null; reason: string | null; free_slots: number }
export interface PreorderOptions {
  enabled: boolean; slot_minutes?: number; lead_minutes?: number; max_advance_days?: number; change_cutoff_minutes?: number; note?: string | null; now?: string; days?: PreorderDay[];
}
export type SlotState = 'ok' | 'soon' | 'full' | 'units';
export interface PreorderSlot { at: string; time: string; state: SlotState; orders_left: number; units_left: number | null }
export interface PreorderSlots { day: string; closed: boolean; open: string | null; close: string | null; reason: string | null; slots: PreorderSlot[] }
/** What the customer may still do with their preorder (decided by the server). */
export interface ChangeRules { deadline: string; can_reschedule: boolean; can_cancel_time: boolean; reschedules_left: number }
export interface OrderNotice { at: string; kind: string; data: Record<string, unknown>; text_th: string | null }
export type OrderType = 'regular' | 'preorder';
export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'packed' | 'ready' | 'shipped' | 'completed' | 'cancelled' | 'returned';
export interface OrderItem { line_no: number; sku_code: string; name: string; unit: string | null; unit_price: number; qty: number; line_total: number; image_url: string | null }
export interface ShopOrder {
  id: string; order_no: string; status: OrderStatus; fulfilment: Fulfilment; channel: string; contact_name: string; contact_phone: string; delivery_address: string | null; note: string | null;
  subtotal: number; discount: number; shipping_fee: number; total: number; created_at: string; updated_at: string; status_note: string | null; cancel_reason: string | null;
  cancelled_at: string | null; payment_pref?: string | null; items: OrderItem[]; invoice: InvoiceRow;
  events?: { at: string; action: string; to?: string | null }[];
  // preorder (all absent from a database without the preorder migration)
  order_type?: OrderType; pickup_at?: string | null; confirmed_at?: string | null; preparing_at?: string | null; ready_at?: string | null; completed_at?: string | null;
  cancel_kind?: 'customer' | 'rejected' | 'staff' | null; reschedule_count?: number; prep?: { checked: number; total: number } | null; change?: ChangeRules | null; notices?: OrderNotice[];
  /** The pinned destination (a database with the delivery-pin migration; null for pick-up and for orders placed without a pin). */
  delivery?: DeliveryInfo | null;
}
export type OrderFilter = 'all' | 'unpaid' | 'to_ship' | 'to_receive' | 'done' | 'cancelled' | 'preorder';
export interface OrdersPage { total: number; orders: ShopOrder[] }
export interface PlaceOrderInput { key: string; items: { sku_code: string; qty: number }[]; fulfilment: Fulfilment; name: string; phone: string; address: string; note: string; paymentMethod?: string | null; slip?: { path: string; sha256: string; type: string; transferAt?: string | null; ref?: string | null } | null; expectedTotal: number | null;
  /** A preorder: the start of the chosen pickup slot (ISO). Pick-up only. */
  pickupAt?: string | null;
  /** The confirmed pin and the details around it (delivery only). */
  delivery?: DeliveryInput | null }

// staff
export interface AdminOrder extends ShopOrder {
  customer?: { code: string; name: string; phone: string | null; line_user_id: string | null };
  events?: { at: string; actor_email: string | null; action: string; detail: Record<string, unknown> }[];
}
export interface AdminOrdersPage { total: number; counts: Partial<Record<OrderStatus, number>>; orders: AdminOrder[] }
export interface AdminSettings extends ShopSettings {
  image_base_url: string; updated_at: string; payment_account_ready: boolean; visible_products: number; products_with_image: number;
  store_name?: string; store_lat?: number; store_lng?: number; store_maps_url?: string | null;
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
  if (/slip was already submitted/i.test(m)) throw new ShopError(m, 'SLIP_ALREADY_USED');
  if (/invalid file/i.test(m)) throw new ShopError(m, 'BAD_FILE');
  if (e.code === '42501' || /sign in|not allowed|permission denied/i.test(m)) throw new ShopError(m, 'FORBIDDEN');
  throw new ShopError(m || 'Request failed', 'ERROR');
}
/** Reads give up after 25 s, placing an order after 45 s: a stalled phone connection becomes a retryable NETWORK error instead of a button that never comes back. */
export const READ_TIMEOUT_MS = 25_000;
export const WRITE_TIMEOUT_MS = 45_000;
export async function rpc<T>(name: string, args?: Record<string, unknown>, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  let r;
  try { r = await withTimeout((signal) => supabase.rpc(name, args).abortSignal(signal), timeoutMs); }
  catch (e) { throw new ShopError(e instanceof TimeoutError ? 'timeout' : (e as Error).message || 'network', 'NETWORK'); }
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
  checkoutQr: (items: { sku_code: string; qty: number }[], fulfilment: Fulfilment) => rpc<CheckoutQr>('shop_checkout_qr', { p_items: items, p_fulfilment: fulfilment }),
  async placeOrder(i: PlaceOrderInput): Promise<{ replay: boolean; order: ShopOrder }> {
    const r = await rpc<{ replay: boolean; order: ShopOrder }>('shop_place_order', {
      p_key: i.key, p_items: i.items, p_fulfilment: i.fulfilment, p_name: i.name, p_phone: i.phone, p_address: i.fulfilment === 'delivery' ? i.address : null,
      p_note: i.note || null, p_expected_total: i.expectedTotal, ...(i.paymentMethod ? { p_payment_method: i.paymentMethod } : {}),
      ...(i.slip ? { p_slip_path: i.slip.path, p_slip_sha256: i.slip.sha256, p_slip_type: i.slip.type, p_slip_transfer_at: i.slip.transferAt ?? null, p_slip_ref: i.slip.ref || null } : {}),
      ...(i.pickupAt ? { p_pickup_at: i.pickupAt } : {}),
      ...(i.delivery ? { p_delivery: i.delivery } : {}),
    }, WRITE_TIMEOUT_MS);
    clearShopCache();
    return r;
  },
  myOrders: (filter: OrderFilter = 'all', limit = 20, offset = 0) => rpc<OrdersPage>('shop_my_orders', { p_filter: filter, p_limit: limit, p_offset: offset }),
  myOrder: (id: string) => rpc<ShopOrder>('shop_my_order', { p_id: id }),
  cancelMyOrder: (id: string, reason?: string) => rpc<ShopOrder>('shop_cancel_my_order', { p_id: id, p_reason: reason ?? null }),
  // saved delivery addresses (a database with the delivery-pin migration)
  addresses: {
    list: () => rpc<SavedAddress[]>('shop_address_list'),
    /** id null = a new address. The pin must be confirmed. */
    save: (id: string | null, data: Omit<DeliveryInput, 'route' | 'address_id'>, label: string | null, makeDefault?: boolean) =>
      rpc<SavedAddress>('shop_address_save', { p_id: id, p_data: data, p_label: label, p_default: makeDefault ?? null }, WRITE_TIMEOUT_MS),
    setDefault: (id: string) => rpc<SavedAddress>('shop_address_set_default', { p_id: id }, WRITE_TIMEOUT_MS),
    remove: (id: string) => rpc<null>('shop_address_delete', { p_id: id }, WRITE_TIMEOUT_MS),
  },
  // preorders
  preorderOptions: () => rpc<PreorderOptions>('preorder_options'),
  preorderSlots: (day: string, units: number) => rpc<PreorderSlots>('preorder_slots', { p_day: day, p_units: Math.max(1, units) }),
  /** Change the pickup time and / or the instructions of my preorder; only the keys given are changed. */
  changePreorder: (id: string, patch: { pickup_at?: string; note?: string }) => rpc<ShopOrder>('preorder_change_my_order', { p_id: id, p_patch: patch }, WRITE_TIMEOUT_MS),
  requestPreorderChange: (id: string, message: string) => rpc<{ ok: boolean }>('preorder_request_change', { p_id: id, p_message: message }, WRITE_TIMEOUT_MS),
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
    let blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/webp', 0.86));
    if (blob && blob.type !== 'image/webp') { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.86)); }   // a photo as PNG would be far too big
    if (!blob) throw new Error('Could not process this picture');
    if (blob.size > 2 * 1024 * 1024) throw new Error('The picture is still over 2 MB after shrinking: use a smaller one');
    return blob;
  } finally { bmp.close(); }
}
/** `name`: a name made from the content, so sending the same picture again finds it there instead of storing it twice. */
async function uploadPublic(folder: string, file: File, name?: string): Promise<string> {
  const blob = await prepareImage(file);
  const type = blob.type === 'image/png' || blob.type === 'image/jpeg' ? blob.type : 'image/webp';      // a browser that cannot make WebP (older Safari) answers with a PNG
  const path = `${folder}/${name ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 6)}.${type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp'}`;
  const { error } = await supabase.storage.from('shop-products').upload(path, blob, { contentType: type, upsert: false, cacheControl: '31536000' });
  if (error && !(name && (String((error as { statusCode?: string }).statusCode) === '409' || /already exists/i.test(error.message)))) throw new Error(error.message);
  return path;
}

export interface StoredImage { path: string; at: string; url: string }
export const shopAdmin = {
  orders: (p: { status?: string; search?: string; limit?: number; offset?: number }) =>
    rpc<AdminOrdersPage>('shop_admin_orders', { p_status: p.status || null, p_search: p.search || null, p_limit: p.limit ?? 30, p_offset: p.offset ?? 0 }),
  order: (id: string) => rpc<AdminOrder>('shop_admin_order', { p_id: id }),
  setStatus: (id: string, status: OrderStatus, note?: string, overrideReason?: string) =>
    rpc<ShopOrder>('shop_admin_set_status', { p_order: id, p_status: status, p_note: note || null, p_override_reason: overrideReason || null }),
  settings: () => rpc<AdminSettings>('shop_admin_settings'),
  saveSettings: (patch: Partial<Omit<ShopSettings, 'free_shipping_min' | 'store'>> & { free_shipping_min?: number | null } & Partial<{ store_name: string; store_lat: number; store_lng: number; store_maps_url: string | null }>) => rpc<AdminSettings>('shop_admin_save_settings', { p_patch: patch }),
  categories: () => rpc<AdminCategory[]>('shop_admin_categories'),
  saveCategory: (code: string, patch: Partial<{ name_th: string; name_en: string; image_path: string; sort_order: number; visible: boolean }>) => rpc<void>('shop_admin_save_category', { p_code: code, p_patch: patch }),
  products: (p: { search?: string; filter?: string; limit?: number; offset?: number }) =>
    rpc<{ total: number; items: AdminProduct[] }>('shop_admin_products', { p_search: p.search || null, p_filter: p.filter ?? 'all', p_limit: p.limit ?? 40, p_offset: p.offset ?? 0 }),
  saveContent: (sku: string, patch: ContentPatch) => rpc<void>('shop_admin_save_content', { p_sku: sku, p_patch: patch }),
  uploadProductImage: (sku: string, file: File, name?: string) => uploadPublic(sku, file, name),
  /** Every picture stored for a SKU, whether customers see it or not. */
  storedImages: async (sku: string): Promise<StoredImage[]> => {
    const b = supabase.storage.from('shop-products');
    const { data, error } = await b.list(sku, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
    if (error) throw new Error(error.message);
    return (data ?? []).filter((x) => x.id && /\.(webp|jpe?g|png)$/i.test(x.name)).map((x) => ({ path: `${sku}/${x.name}`, at: x.created_at ?? '', url: b.getPublicUrl(`${sku}/${x.name}`).data.publicUrl }));
  },
  uploadCategoryImage: (file: File) => uploadPublic('categories', file),
};
