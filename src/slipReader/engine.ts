// Runs the slip reader in the browser: the picture is prepared, read several times by an OCR engine (Tesseract, Apache-2.0, served from this site's own /ocr folder: no AI service, no third
// party, the picture never leaves the device), and its QR is decoded. The engine is only downloaded when a slip is really read (about 5 MB the first time, then cached by the browser).
import jsQR from 'jsqr';
import { interpretPayload } from '../../supabase/functions/slip-analyze/qrPayload.ts';
import { readSlip, type Reading, type SlipQr } from './parse';

export const ENGINE = 'browser-ocr/1';
const asset = (f: string) => new URL(`ocr/${f}`, document.baseURI).href;
interface Ocr { setParameters(p: Record<string, string>): Promise<unknown>; recognize(i: HTMLCanvasElement): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> }

/** Is the engine there at all? (a build opened from a file, or a deploy without the /ocr folder, has none) */
export const readerAvailable = (): boolean => typeof WebAssembly === 'object' && typeof Worker === 'function' && /^https?:$/.test(window.location.protocol);

async function start(langs: string[]): Promise<Ocr> {
  // a deploy without the /ocr folder must end in a clear error at once: the engine itself would only report it as an uncaught error of its worker, and never answer
  const there = await fetch(asset('worker.min.js'), { method: 'HEAD' }).then((r) => r.ok && /javascript/.test(r.headers.get('content-type') ?? '')).catch(() => false);
  if (!there) throw new ReaderError('NOT_AVAILABLE', 'The reader files are not on this site');
  const { createWorker, OEM } = await import('tesseract.js');
  return (await createWorker(langs, OEM.LSTM_ONLY, {
    workerPath: asset('worker.min.js'), corePath: asset('tesseract-core-simd-lstm.wasm.js'), langPath: asset('').replace(/\/$/, ''), gzip: true, logger: () => undefined, errorHandler: () => undefined,
  })) as unknown as Ocr;
}
let shared: { key: string; worker: Promise<Ocr> } | null = null;
function worker(langs: string[]): Promise<Ocr> {
  const key = langs.join('+');
  if (shared?.key !== key) { void shared?.worker.then((w) => w.terminate()).catch(() => undefined); shared = { key, worker: start(langs) }; shared.worker.catch(() => { if (shared?.key === key) shared = null; }); }
  return shared!.worker;
}
export function stopReader(): void { const s = shared; shared = null; void s?.worker.then((w) => w.terminate()).catch(() => undefined); }

function canvas(w: number, h: number) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return { c, g: c.getContext('2d', { willReadFrequently: true })! }; }
/** The picture at a width the engine reads well, on white, in grey with the contrast stretched; light text on a dark picture is turned around. */
export function prepare(bmp: ImageBitmap, width: number): HTMLCanvasElement {
  const k = Math.min(Math.max(width / bmp.width, 0.2), 4); const { c, g } = canvas(bmp.width * k, Math.min(bmp.height * k, 6000));
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, bmp.width * k, bmp.height * k);
  const im = g.getImageData(0, 0, c.width, c.height); const d = im.data; const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; d[i] = y; hist[y]++; }
  const total = d.length / 4; let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < total * 0.01; lo++); acc = 0; for (; hi > 0 && (acc += hist[hi]) < total * 0.05; hi--);
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  const flip = sum / total < 100; const span = Math.max(hi - lo, 40);
  for (let i = 0; i < d.length; i += 4) { let y = Math.min(255, Math.max(0, ((d[i] - lo) * 255) / span)); if (flip) y = 255 - y; d[i] = d[i + 1] = d[i + 2] = y; d[i + 3] = 255; }
  g.putImageData(im, 0, 0); return c;
}
/** Black and white by comparing each point with its own neighbourhood: brings back pale text on a tinted background, which one contrast for the whole picture loses. */
export function localBlackWhite(c: HTMLCanvasElement): HTMLCanvasElement {
  const g = c.getContext('2d', { willReadFrequently: true })!; const { width: w, height: h } = c; const im = g.getImageData(0, 0, w, h); const d = im.data;
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += d[(y * w + x) * 4]; sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row; } }
  const r = Math.max(8, Math.round(w / 48));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    const mean = (sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    const i = (y * w + x) * 4; const v = d[i] < mean - 10 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(im, 0, 0); return c;
}
const NO_QR: SlipQr = { found: false, crc_ok: null, sending_bank: null, trans_ref: null };
/** The QR every Thai transfer slip carries (sending bank, reference, checksum). Tried at a few sizes. */
export function slipQr(bmp: ImageBitmap): SlipQr {
  for (const side of [1000, 1600, 700, 2200]) {
    const k = Math.min(side / Math.max(bmp.width, bmp.height), 3); const { c, g } = canvas(bmp.width * k, bmp.height * k);
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const r = jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return interpretPayload(r.data);
  }
  return { ...NO_QR };
}

export class ReaderError extends Error { constructor(public code: 'NOT_AVAILABLE' | 'NOT_A_PICTURE' | 'TIMEOUT' | 'FAILED', message: string) { super(message); } }
const within = <T,>(p: Promise<T>, ms: number): Promise<T> => { let h: ReturnType<typeof setTimeout>; return Promise.race([p, new Promise<never>((_, rej) => { h = setTimeout(() => rej(new ReaderError('TIMEOUT', 'The reader took too long')), ms); })]).finally(() => clearTimeout(h)); };

/**
 * Reads one slip picture. `full` (staff): Thai and English, three readings that must agree. `quick` (a customer's phone, only to warn): Thai model only, two readings.
 * A PDF is not read here. Throws ReaderError; never hangs.
 */
export async function readPicture(file: Blob, mode: 'full' | 'quick' = 'full', now = new Date(), timeoutMs = 60_000): Promise<Reading & { qr: SlipQr }> {
  if (!readerAvailable()) throw new ReaderError('NOT_AVAILABLE', 'This browser cannot run the reader');
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new ReaderError('NOT_A_PICTURE', 'The file is not a picture'); }
  try {
    if (bmp.width * bmp.height > 40_000_000 || Math.min(bmp.width, bmp.height) < 40) throw new ReaderError('NOT_A_PICTURE', 'The picture has an unusable size');
    const qr = slipQr(bmp);
    const passes: [number, string, boolean][] = mode === 'full' ? [[1200, '4', false], [1200, '6', true], [1000, '4', true]] : [[1100, '4', false], [1100, '6', true]];
    const texts = await within((async () => {
      const w = await worker(mode === 'full' ? ['tha', 'eng'] : ['tha']); const out: string[] = [];
      for (const [width, psm, local] of passes) {
        await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
        const pic = prepare(bmp, width); out.push((await w.recognize(local ? localBlackWhite(pic) : pic)).data.text);
      }
      return out;
    })(), timeoutMs).catch((e) => { stopReader(); throw e instanceof ReaderError ? e : new ReaderError('FAILED', String((e as Error)?.message ?? e)); });
    return { ...readSlip(texts, qr, now), qr };
  } finally { bmp.close(); }
}
