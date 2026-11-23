// The QR code of a Thai transfer slip: decode it from a PNG / JPEG, and check it is a Bank of Thailand slip-verify payload with a valid checksum.
// The libraries are imported by bare name (jsqr, pngjs, jpeg-js): deno.json maps them for Deno, node_modules resolves them for the unit tests.
//
// What is returned feeds finance_classify_slip as p_qr:
//   { found: false }                      no QR, a PDF, a picture that cannot be decoded (the slip is then simply not QR-checked)
//   { found: true, crc_ok: true,  ... }   a slip-verify QR whose checksum is right: sending_bank and trans_ref are what the bank printed in it
//   { found: true, crc_ok: false, ... }   a slip-STRUCTURED QR (field 00 with 01 and 02, 51 = TH, 91 present) whose checksum is wrong; the database records
//                                         QR_BAD_CRC and treats the slip as suspicious
//   { found: true, crc_ok: null,  ... }   a QR was decoded but it is not a slip-verify QR (a link, a payment QR, another kind of code): not recognised, so
//                                         nothing is checked and nothing is flagged (the SQL only reacts to crc_ok = false)
// This function never throws.
import { Buffer } from 'node:buffer';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { decode as decodeJpeg } from 'jpeg-js';

import { interpretPayload, type QrResult } from './qrPayload.ts';
export { crc16, interpretPayload } from './qrPayload.ts';
export type { QrResult } from './qrPayload.ts';
export const NO_QR: QrResult = Object.freeze({ found: false, crc_ok: null, sending_bank: null, trans_ref: null });

const MAX_SIDE = 1000;                    // the picture is scaled down to this on its longer side before the QR is searched
const MAX_PIXELS = 8_000_000;             // a bigger picture is not decoded (CPU and memory of an Edge Function): the slip is then not QR-checked
const MAX_DECODED_BYTES = 48 * 1024 * 1024;   // what a PNG would take once inflated: width x height x channels x bit depth / 8

interface Rgba { data: Uint8Array; width: number; height: number }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };           // grey, RGB, palette, grey + alpha, RGBA
const BIT_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/**
 * Reads the IHDR of a PNG and says whether it is safe to hand to the decoder. pngjs inflates an INTERLACED picture with no output limit (a few KB of
 * deflated zeros becomes gigabytes and kills the worker, leaving the attempt "running"), so an interlaced picture is never decoded; for the rest the size is
 * limited in pixels and in the bytes the picture takes once inflated.
 *
 * The header is only a guard if it is the header pngjs will use. pngjs requires the FIRST chunk to be an IHDR but does not reject a second one: it then
 * takes the interlace flag and the size from the LAST one it saw. So the whole chunk list is walked here (type and length of each chunk, skipping the data
 * and the CRC, never past the end of the file) and the picture is refused unless the first chunk is the IHDR, there is exactly one IHDR, every chunk
 * length stays inside the file, and an IEND ends the list. pngjs stops parsing at IEND too (and then refuses a file that has anything after it), so what
 * follows IEND is never used and is not judged here.
 */
export function inspectPng(bytes: Uint8Array): { ok: true; width: number; height: number; decodedBytes: number } | { ok: false; reason: string } {
  if (!bytes || bytes.length < 33) return { ok: false, reason: 'too short' };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return { ok: false, reason: 'not a PNG' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const is = (at: number, a: number, b: number, c: number, d: number) => bytes[at] === a && bytes[at + 1] === b && bytes[at + 2] === c && bytes[at + 3] === d;
  let pos = 8, ihdrs = 0, sawEnd = false;
  while (pos + 12 <= bytes.length) {                                              // a chunk is length (4) + type (4) + data + CRC (4)
    const length = dv.getUint32(pos), end = pos + 12 + length;
    if (end > bytes.length) return { ok: false, reason: 'chunk runs past the end' };
    const isIhdr = is(pos + 4, 0x49, 0x48, 0x44, 0x52);
    if (pos === 8 && (!isIhdr || length !== 13)) return { ok: false, reason: 'no IHDR' };
    if (isIhdr && ++ihdrs > 1) return { ok: false, reason: 'duplicate IHDR' };
    if (is(pos + 4, 0x49, 0x45, 0x4e, 0x44)) { sawEnd = true; break; }              // IEND
    pos = end;
  }
  if (ihdrs !== 1) return { ok: false, reason: 'no IHDR' };
  if (!sawEnd) return { ok: false, reason: pos < bytes.length ? 'chunk runs past the end' : 'no IEND' };
  const width = dv.getUint32(16), height = dv.getUint32(20), depth = bytes[24], colorType = bytes[25], compression = bytes[26], filter = bytes[27], interlace = bytes[28];
  if (width === 0 || height === 0) return { ok: false, reason: 'empty picture' };
  if (width * height > MAX_PIXELS) return { ok: false, reason: 'too many pixels' };
  if (!BIT_DEPTHS[colorType]?.includes(depth)) return { ok: false, reason: 'unknown colour type or bit depth' };
  if (compression !== 0 || filter !== 0) return { ok: false, reason: 'unknown method' };
  if (interlace !== 0) return { ok: false, reason: 'interlaced' };
  const decodedBytes = Math.ceil((width * height * CHANNELS[colorType] * depth) / 8);
  if (decodedBytes > MAX_DECODED_BYTES) return { ok: false, reason: 'too large once decoded' };
  return { ok: true, width, height, decodedBytes };
}

function decodePng(bytes: Uint8Array): Rgba | null {
  if (!inspectPng(bytes).ok) return null;
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { data: png.data, width: png.width, height: png.height };
}

function readJpeg(bytes: Uint8Array): Rgba | null {
  const img = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 96 });
  return { data: img.data, width: img.width, height: img.height };
}

/** Scales an RGBA picture so its longer side is at most MAX_SIDE (area average, so thin QR modules stay clean) and flattens transparency onto white. */
function shrink(img: Rgba): { data: Uint8ClampedArray; width: number; height: number } {
  const { data: src, width: w, height: h } = img;
  const k = Math.max(1, Math.max(w, h) / MAX_SIDE);
  const tw = Math.max(1, Math.round(w / k)), th = Math.max(1, Math.round(h / k));
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4, a = src[i + 3];
          if (a === 255) { r += src[i]; g += src[i + 1]; b += src[i + 2]; }
          else { const inv = 255 - a; r += (src[i] * a + 255 * inv) / 255; g += (src[i + 1] * a + 255 * inv) / 255; b += (src[i + 2] * a + 255 * inv) / 255; }
          n++;
        }
      }
      const o = (ty * tw + tx) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: tw, height: th };
}

/** Decodes the slip QR of a JPEG / PNG. PDF, unknown types, unreadable or oversize pictures give { found: false }. Never throws. */
export function decodeSlipQr(bytes: Uint8Array, mediaType: string): QrResult {
  try {
    let img: Rgba | null = null;
    if (mediaType === 'image/png') img = decodePng(bytes);
    else if (mediaType === 'image/jpeg') img = readJpeg(bytes);
    if (!img || img.width < 1 || img.height < 1) return { ...NO_QR };
    const small = shrink(img);
    const code = jsQR(small.data, small.width, small.height, { inversionAttempts: 'dontInvert' });
    if (!code || typeof code.data !== 'string') return { ...NO_QR };
    return interpretPayload(code.data);
  } catch {
    return { ...NO_QR };
  }
}
