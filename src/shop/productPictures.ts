// The pictures customers see, kept apart from the pictures that are stored:
//   stored      every file of the SKU in the shop's storage (bucket shop-products, folder = SKU). Never deleted from here.
//   displayed   shop_sku_content.image_paths, the ones the customer app shows, in order
//   waiting     a picture of this browser (IndexedDB) the shop does not have yet; it is sent by itself (AutoPictures) unless staff pressed X
// "Remove" only takes a path out of `displayed`. A picture of this browser is stored under a name made from its content (m-<checksum>), so the same picture is never sent twice (a second tab,
// another computer, a retry after a lost answer) and one that staff removed is recognised as already stored: it does not come back.
import type { DB, MediaFile, Product } from '../domain/types';
import { isStandardSku, skuCategoryOfCode } from '../domain/sku';
import { blobGet } from '../lib/idb';
import { type AdminProduct, shopAdmin, type StoredImage } from './api';

export const MAX_PICTURES = 6;
/** Only a finished-goods SKU of the central registry is sold in the online shop (the database refuses any other). */
export const isShopSku = (sku: string | null | undefined): sku is string => isStandardSku(sku) && skuCategoryOfCode(sku) === 'FG';

const CHANGED = 'shop-pictures-changed';
/** Tell the open screens that the shop's pictures of a SKU changed. */
export const picturesChanged = (sku: string) => window.dispatchEvent(new CustomEvent(CHANGED, { detail: sku }));
export function onPicturesChanged(fn: (sku: string) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(CHANGED, h);
  return () => window.removeEventListener(CHANGED, h);
}

// One change at a time on this computer (all tabs where the browser can): a change reads the list, then writes it.
let chain: Promise<unknown> = Promise.resolve();
function alone<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => (navigator.locks ? navigator.locks.request('shop-pictures', fn) as Promise<T> : fn()));
  chain = run.catch(() => undefined);
  return run;
}

/** What the online shop has for one SKU; null = the SKU is not in the shop's list. */
export async function shopPictures(sku: string): Promise<AdminProduct | null> {
  return (await shopAdmin.products({ search: sku, limit: 20 })).items.find((x) => x.sku_code === sku) ?? null;
}
export interface ShopState { product: AdminProduct; stored: StoredImage[] }
export async function shopState(sku: string): Promise<ShopState | null> {
  const [product, stored] = await Promise.all([shopPictures(sku), shopAdmin.storedImages(sku)]);
  return product ? { product, stored } : null;
}
/** Stored but not displayed, newest first. */
export const notDisplayed = (s: ShopState): StoredImage[] => s.stored.filter((x) => !s.product.image_paths.includes(x.path)).sort((a, b) => b.at.localeCompare(a.at));

/** The name (without extension) a picture of this browser has in the shop's storage. */
export const stemOf = (m: Pick<MediaFile, 'checksum'>): string => `m-${m.checksum.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`;
const stem = (path: string) => (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
export const storedAs = (m: Pick<MediaFile, 'checksum'>, stored: StoredImage[]): StoredImage | undefined => stored.find((x) => stem(x.path) === stemOf(m));

const MIMES = ['image/jpeg', 'image/png', 'image/webp'];
export const usable = (m: MediaFile | undefined): m is MediaFile => !!m && m.status !== 'quarantined' && MIMES.includes(m.mime) && !!m.checksum;
export type LocalState = 'shown' | 'removed' | 'waiting' | 'earlier' | 'full';
/**
 * Where a picture of this browser stands in the shop. `earlier`: the shop got pictures of this SKU after it was added, under names that cannot be matched (sent before 2026-11-24, or chosen on
 * the Online shop page): it is never sent by itself.
 */
export function localState(m: MediaFile, s: ShopState): LocalState {
  const at = storedAs(m, s.stored);
  if (at) return s.product.image_paths.includes(at.path) ? 'shown' : 'removed';
  if (m.shopHidden) return 'removed';
  if (s.stored.some((x) => !stem(x.path).startsWith('m-') && Date.parse(x.at) >= Date.parse(m.createdAt))) return 'earlier';
  return s.product.image_paths.length >= MAX_PICTURES ? 'full' : 'waiting';
}

async function fileOf(m: MediaFile): Promise<File | null> {
  const b = m.dataUrl ? await (await fetch(m.dataUrl)).blob() : await blobGet(m.id);
  return b ? new File([b], m.name || m.id, { type: m.mime }) : null;
}
export interface SendResult { added: number; full: boolean; unreadable: number }
/** Stores pictures of this browser in the shop and displays them behind the ones already there. Safe to repeat. `still` is asked right before and after each picture: false = leave it out. */
export function sendPictures(sku: string, media: MediaFile[], still: (m: MediaFile) => boolean = () => true): Promise<SendResult> {
  return alone(async () => {
    const before = await shopState(sku);
    if (!before) throw new Error('This SKU is not in the online shop');
    let room = MAX_PICTURES - before.product.image_paths.length; let full = false; let unreadable = 0; const paths: string[] = [];
    for (const m of media) {
      const had = storedAs(m, before.stored);
      if ((had && before.product.image_paths.includes(had.path)) || !still(m)) continue;
      if (room <= 0) { full = true; break; }
      let path = had?.path;
      if (!path) {
        const f = await fileOf(m); if (!f) { unreadable++; continue; }
        path = await shopAdmin.uploadProductImage(sku, f, stemOf(m));
        if (!still(m)) continue;                                 // X while it was on its way: stored, not displayed
      }
      if (!paths.includes(path)) { paths.push(path); room--; }
    }
    if (paths.length) {
      const now = (await shopPictures(sku))?.image_paths ?? before.product.image_paths;                // read again: somebody else may have changed the list meanwhile
      await shopAdmin.saveContent(sku, { image_paths: [...now.filter((x) => !paths.includes(x)), ...paths].slice(0, MAX_PICTURES) });
      picturesChanged(sku);
    }
    return { added: paths.length, full, unreadable };
  });
}
function change(sku: string, fn: (paths: string[]) => string[]): Promise<void> {
  return alone(async () => {
    const now = await shopPictures(sku);
    if (!now) throw new Error('This SKU is not in the online shop');
    const next = fn(now.image_paths);
    if (next.length > MAX_PICTURES) throw new Error('TOO_MANY');
    if (next.join('|') !== now.image_paths.join('|')) await shopAdmin.saveContent(sku, { image_paths: next });
    picturesChanged(sku);
  });
}
/** Customers stop seeing it; the file stays stored and can be shown again. */
export const removeFromShop = (sku: string, path: string) => change(sku, (x) => x.filter((y) => y !== path));
export const showInShop = (sku: string, path: string) => change(sku, (x) => (x.includes(path) ? x : [...x, path]));
export const makeMain = (sku: string, path: string) => change(sku, (x) => (x.includes(path) ? [path, ...x.filter((y) => y !== path)] : x));

export interface Waiting { product: Product; media: MediaFile[] }
/** Pictures of this browser the shop is still to get. Nothing is asked of the server when this browser has no picture of a shop product. */
export async function picturesWaiting(db: Pick<DB, 'products' | 'media'>): Promise<Waiting[]> {
  const out: Waiting[] = [];
  for (const product of db.products) {
    if (!isShopSku(product.sku) || !product.mediaIds.length) continue;
    const media = product.mediaIds.map((id) => db.media.find((m) => m.id === id)).filter(usable).filter((m) => !m.shopHidden);
    const here: MediaFile[] = []; for (const m of media) if (m.dataUrl || (await blobGet(m.id))) here.push(m);
    if (!here.length) continue;
    const s = await shopState(product.sku); if (!s) continue;
    const wait = here.filter((m) => localState(m, s) === 'waiting').slice(0, Math.max(0, MAX_PICTURES - s.product.image_paths.length));
    if (wait.length) out.push({ product, media: wait });
  }
  return out;
}
