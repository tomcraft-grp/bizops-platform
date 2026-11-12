import type { MediaFile } from '../domain/types';
import { blobGet, blobPut } from './idb';

export const MAX_UPLOAD = 8 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  try {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // very small non-crypto fallback (insecure contexts)
    let x = 5381;
    const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i++) x = ((x << 5) + x + u[i]) | 0;
    return 'weak' + (x >>> 0).toString(16);
  }
}
/** Detect the REAL type from magic bytes — never trust the extension or the browser-reported MIME */
export function sniffMime(u: Uint8Array): string | null {
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'image/png';
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return 'image/webp';
  if (u[0] === 0x25 && u[1] === 0x50 && u[2] === 0x44 && u[3] === 0x46) return 'application/pdf';
  return null;
}
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

async function resize(file: Blob, max: number, type = 'image/webp', q = 0.82): Promise<{ blob: Blob; w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, type, q));
    return blob ? { blob, w, h } : null;
  } catch { return null; }
}

export interface Ingest { meta: Omit<MediaFile, 'id' | 'uploadedBy' | 'createdAt' | 'kind' | 'linkedType' | 'linkedId' | 'private'>; blob: Blob; thumb?: Blob; web?: Blob }

/** Validation + checksum + malware (EICAR) check + optimisation. Returns what to store. */
export async function ingest(file: File): Promise<Ingest> {
  if (file.size === 0) throw new Error('The file is empty');
  if (file.size > MAX_UPLOAD) throw new Error(`File is too large (${(file.size / 1048576).toFixed(1)} MB). Limit is ${MAX_UPLOAD / 1048576} MB`);
  const buf = await file.arrayBuffer();
  const u = new Uint8Array(buf);
  const real = sniffMime(u);
  if (!real || !ALLOWED.includes(real)) throw new Error(`Unsupported or disguised file type (declared "${file.type || 'unknown'}"). Allowed: JPEG, PNG, WebP, PDF`);
  const declared = file.type;
  if (declared && declared !== real && !(declared === 'image/jpg' && real === 'image/jpeg')) throw new Error(`File content is ${real} but it was declared as ${declared}. Upload rejected.`);
  const checksum = await sha256Hex(buf);
  const text = new TextDecoder('latin1').decode(u.slice(0, 4096));
  const infected = text.includes(EICAR);
  let width: number | undefined, height: number | undefined;
  let thumb: Blob | undefined, web: Blob | undefined;
  const variants: MediaFile['variants'] = [];
  if (real.startsWith('image/') && !infected) {
    const t = await resize(file, 256);
    const w = await resize(file, 1280);
    if (t) { thumb = t.blob; variants.push({ name: 'thumb', width: t.w, height: t.h, size: t.blob.size }); }
    if (w) { web = w.blob; width = undefined; variants.push({ name: 'web', width: w.w, height: w.h, size: w.blob.size }); }
    try { const bmp = await createImageBitmap(file); width = bmp.width; height = bmp.height; } catch { /* ignore */ }
  }
  return {
    meta: { name: file.name, mime: real, size: file.size, checksum, status: infected ? 'quarantined' : 'scanning', width, height, variants, scanNote: infected ? 'EICAR test signature detected — quarantined' : undefined },
    blob: file, thumb, web,
  };
}
export async function storeIngest(id: string, r: Ingest) {
  await blobPut(id, r.blob);
  if (r.thumb) await blobPut(id + ':thumb', r.thumb);
  if (r.web) await blobPut(id + ':web', r.web);
}
export async function loadMediaUrl(m: MediaFile, variant: 'thumb' | 'web' | 'original' = 'web'): Promise<string | null> {
  if (m.dataUrl) return m.dataUrl;
  const key = variant === 'original' ? m.id : m.id + ':' + variant;
  const b = (await blobGet(key)) ?? (await blobGet(m.id));
  return b ? URL.createObjectURL(b) : null;
}
export const retentionYears: Record<MediaFile['kind'], number> = {
  product_image: 0, customer_upload: 2, payment_slip: 7, supplier_doc: 10, purchase_invoice: 10, accounting_doc: 10, production_image: 2, event_image: 1,
};
