// The pictures customers see. A picture added on the Products page used to stay in the browser it was added in (IndexedDB), while the online shop reads pictures from the shop's own public
// storage (shop_sku_content.image_paths), so it never appeared. Adding a picture now also puts it there, and pictures that are still only on this device can be sent in one go.
import type { DB, MediaFile, Product } from '../domain/types';
import { isStandardSku, skuCategoryOfCode } from '../domain/sku';
import { blobGet } from '../lib/idb';
import { type AdminProduct, shopAdmin } from './api';

export const MAX_PICTURES = 6;
/** Only a finished-goods SKU of the central registry is sold in the online shop (the database refuses any other). */
export const isShopSku = (sku: string | null | undefined): sku is string => isStandardSku(sku) && skuCategoryOfCode(sku) === 'FG';

/** What the online shop has for one SKU; null = the SKU is not in the shop's list. */
export async function shopPictures(sku: string): Promise<AdminProduct | null> {
  return (await shopAdmin.products({ search: sku, limit: 20 })).items.find((x) => x.sku_code === sku) ?? null;
}
/** Adds pictures behind the ones the shop already has (read again right before saving, so two people do not undo each other). Returns how many were added. */
export async function addShopPictures(sku: string, files: File[]): Promise<{ added: number; full: boolean }> {
  const have = await shopPictures(sku);
  if (!have) throw new Error('This SKU is not in the online shop');
  const room = Math.max(0, MAX_PICTURES - have.image_paths.length); const paths: string[] = [];
  for (const f of files.slice(0, room)) paths.push(await shopAdmin.uploadProductImage(sku, f));
  if (paths.length) {
    const now = (await shopPictures(sku))?.image_paths ?? have.image_paths;
    await shopAdmin.saveContent(sku, { image_paths: [...now.filter((x) => !paths.includes(x)), ...paths].slice(0, MAX_PICTURES) });
  }
  return { added: paths.length, full: files.length > room };
}
export const setShopPictures = (sku: string, paths: string[]) => shopAdmin.saveContent(sku, { image_paths: paths.slice(0, MAX_PICTURES) });

/** Every finished-goods SKU of the shop (the server answers at most 100 at a time). */
async function allShopProducts(): Promise<AdminProduct[]> {
  const out: AdminProduct[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await shopAdmin.products({ limit: 100, offset }); out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) break;
  }
  return out;
}
export interface Waiting { product: Product; files: () => Promise<File[]> }
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** Products whose pictures are on this device while the online shop has none for them. */
export async function picturesOnlyHere(db: Pick<DB, 'products' | 'media'>): Promise<Waiting[]> {
  const mine = db.products.filter((p) => isShopSku(p.sku) && p.mediaIds.length > 0);
  if (!mine.length) return [];
  const inShop = new Map((await allShopProducts()).map((x) => [x.sku_code, x])); const out: Waiting[] = [];
  for (const product of mine) {
    const shop = inShop.get(product.sku); if (!shop || shop.image_paths.length > 0) continue;
    const media = product.mediaIds.map((id) => db.media.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m && m.status !== 'quarantined' && !!EXT[m.mime]);
    const there: MediaFile[] = []; for (const m of media) if (m.dataUrl || (await blobGet(m.id))) there.push(m);
    if (!there.length) continue;
    out.push({ product, files: async () => {
      const fs: File[] = [];
      for (const m of there.slice(0, MAX_PICTURES)) { const b = m.dataUrl ? await (await fetch(m.dataUrl)).blob() : await blobGet(m.id); if (b) fs.push(new File([b], `${m.id}.${EXT[m.mime]}`, { type: m.mime })); }
      return fs;
    } });
  }
  return out;
}
