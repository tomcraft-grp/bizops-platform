// Image helpers for the feedback attachments: take screenshots from the clipboard (Win+Shift+S, then Ctrl+V), give them a readable name,
// and shrink very large pictures before they are uploaded. The pure parts are unit-tested (tests/unit/feedbackImages.test.ts); the canvas
// part runs in the browser and is covered by the Playwright spec (tests/shop-e2e/feedback.spec.ts).

export const MAX_IMAGE_DIMENSION = 2560;               // longest side after resizing (a 4K screenshot stays readable)
export const COMPRESS_ABOVE_BYTES = 1.5 * 1024 * 1024; // smaller pictures are uploaded exactly as they are

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const extensionFor = (mime: string) => EXT[mime] ?? 'png';

/** The size that fits inside a max x max box, same proportions, never enlarged. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_DIMENSION): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: Math.max(1, Math.round(width) || 1), height: Math.max(1, Math.round(height) || 1) };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** screenshot-20261115-014500-1.png (local time, so it matches what the person sees on their clock). */
export function pastedName(index: number, mime: string, now = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `screenshot-${stamp}-${index + 1}.${extensionFor(mime)}`;
}

// Browsers name every pasted screenshot "image.png"; a file copied in Explorer keeps its own name, which is more useful than a generated one.
const GENERIC_NAME = /^(image|blob|screenshot|clipboard|pasted[- ]?image)?(\s?\(\d+\))?(\.(png|jpe?g|webp|gif|bmp))?$/i;
export const isGenericName = (name: string) => !name || GENERIC_NAME.test(name.trim());

type ClipboardLike = { items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>; files?: ArrayLike<File>; getData?(format: string): string };

/** The pictures on the clipboard (a screenshot, or image files copied in a file manager), renamed when the browser gave them a generic name. */
export function clipboardImages(data: ClipboardLike | null | undefined, now = new Date()): File[] {
  if (!data) return [];
  const found: File[] = [];
  for (const it of Array.from(data.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) found.push(f); }
  }
  if (!found.length) for (const f of Array.from(data.files ?? [])) if (f.type.startsWith('image/')) found.push(f);
  return found.map((f, i) => (isGenericName(f.name) ? new File([f], pastedName(i, f.type, now), { type: f.type, lastModified: f.lastModified }) : f));
}

/** True when the clipboard also carries plain text (copied from Word/Excel/a web page): then Ctrl+V is meant for the text field, not for attaching. */
export const clipboardHasText = (data: ClipboardLike | null | undefined) => !!data?.getData && data.getData('text/plain').trim() !== '';

export interface PrepareOptions { maxDimension?: number; compressAbove?: number }

/**
 * Resizes (longest side <= 2560 px) and re-encodes a PNG/JPEG/WebP picture that is large, and returns it as a new File. Pictures that are already
 * small are returned untouched. If anything goes wrong the original file is returned (the caller still enforces the 10 MB limit).
 */
export async function prepareImage(file: File, o: PrepareOptions = {}): Promise<File> {
  const maxDimension = o.maxDimension ?? MAX_IMAGE_DIMENSION, compressAbove = o.compressAbove ?? COMPRESS_ABOVE_BYTES;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  try {
    const { width, height } = fitWithin(bmp.width, bmp.height, maxDimension);
    const resized = width !== bmp.width || height !== bmp.height;
    if (!resized && file.size <= compressAbove) return file;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    const encode = (type: string, quality?: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
    const candidates: [string, number | undefined][] = file.type === 'image/png' ? [['image/png', undefined], ['image/webp', 0.9], ['image/jpeg', 0.85]] : [['image/webp', 0.9], ['image/jpeg', 0.85]];
    let best: Blob | null = null;
    for (const [type, quality] of candidates) {
      ctx.clearRect(0, 0, width, height);
      if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); }   // JPEG has no transparency
      ctx.drawImage(bmp, 0, 0, width, height);
      const blob = await encode(type, quality);
      if (!blob || blob.type !== type) continue;                                                        // the browser cannot write this format
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= compressAbove) { best = blob; break; }                                           // good enough: prefer the lossless / first choice
    }
    if (!best || (!resized && best.size >= file.size)) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([best], `${base}.${extensionFor(best.type)}`, { type: best.type, lastModified: Date.now() });
  } catch { return file; } finally { bmp.close?.(); }
}
