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

export interface QrResult { found: boolean; crc_ok: boolean | null; sending_bank: string | null; trans_ref: string | null }
export const NO_QR: QrResult = Object.freeze({ found: false, crc_ok: null, sending_bank: null, trans_ref: null });

const MAX_SIDE = 1000;                    // the picture is scaled down to this on its longer side before the QR is searched
const MAX_PIXELS = 8_000_000;             // a bigger picture is not decoded (CPU and memory of an Edge Function): the slip is then not QR-checked
const MAX_DECODED_BYTES = 48 * 1024 * 1024;   // what a PNG would take once inflated: width x height x channels x bit depth / 8
const MAX_PAYLOAD_CHARS = 4000;           // a QR code holds under 3000 bytes: anything longer is not read

/** CRC-16/CCITT-FALSE (polynomial 0x1021, initial value 0xFFFF, no reflection) of the characters of a string, as four upper-case hex digits. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= (s.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

interface Tlv { tag: string; value: string; valueStart: number }
/** Splits "TTLLvalue..." (two-digit tag, two-digit length) into its fields; null when the text is not made of such fields from start to end. */
function parseTlv(s: string): Tlv[] | null {
  const out: Tlv[] = [];
  let i = 0;
  while (i < s.length) {
    const tag = s.slice(i, i + 2), len = s.slice(i + 2, i + 4);
    if (!/^[0-9]{2}$/.test(tag) || !/^[0-9]{2}$/.test(len)) return null;
    const valueStart = i + 4, end = valueStart + Number(len);
    if (end > s.length) return null;
    out.push({ tag, value: s.slice(valueStart, end), valueStart });
    i = end;
  }
  return out;
}

const cleanRef = (v: string | undefined, max: number) => { const t = (v ?? '').replace(/[^\x21-\x7e]/g, '').slice(0, max); return t === '' ? null : t; };

const UNRECOGNISED: QrResult = Object.freeze({ found: true, crc_ok: null, sending_bank: null, trans_ref: null });

/**
 * The slip-verify payload: top-level fields, field 00 holds nested fields (00 api marker, 01 sending bank = 3 digits, 02 transaction reference),
 * field 51 is the country (TH) and field 91 is the CRC-16 of everything before its value, up to and including "9104". Compared in upper case.
 * Only a payload with that structure (00 with 01 and 02, 51 = TH, 91 present) is judged: its checksum is right (crc_ok true) or wrong (crc_ok false).
 * Anything else that decoded is a QR of another kind and is not recognised (crc_ok null, no bank, no reference): it is neither checked nor flagged.
 */
export function interpretPayload(payload: string): QrResult {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_CHARS) return { ...UNRECOGNISED };
  const top = parseTlv(payload);
  if (!top) return { ...UNRECOGNISED };
  const inner = parseTlv(top.find((f) => f.tag === '00')?.value ?? '');
  if (!inner) return { ...UNRECOGNISED };
  const bank = inner.find((f) => f.tag === '01')?.value;
  const sendingBank = bank !== undefined && /^[0-9]{3}$/.test(bank) ? bank : null;
  const transRef = cleanRef(inner.find((f) => f.tag === '02')?.value, 64);
  const crcField = top.find((f) => f.tag === '91');
  if (sendingBank === null || transRef === null || top.find((f) => f.tag === '51')?.value !== 'TH' || !crcField) return { ...UNRECOGNISED };
  const crcOk = crcField === top[top.length - 1] && crcField.value.length === 4 && crcField.value.toUpperCase() === crc16(payload.slice(0, crcField.valueStart));
  return { found: true, crc_ok: crcOk, sending_bank: sendingBank, trans_ref: transRef };
}

interface Rgba { data: Uint8Array; width: number; height: number }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };           // grey, RGB, palette, grey + alpha, RGBA
const BIT_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/**
 * Reads the 13-byte IHDR of a PNG and says whether it is safe to hand to the decoder. pngjs inflates an INTERLACED picture with no output limit (a few KB of
 * deflated zeros becomes gigabytes and kills the worker, leaving the attempt "running"), so an interlaced picture is never decoded; for the rest the size is
 * limited in pixels and in the bytes the picture takes once inflated.
 */
export function inspectPng(bytes: Uint8Array): { ok: true; width: number; height: number; decodedBytes: number } | { ok: false; reason: string } {
  if (!bytes || bytes.length < 33) return { ok: false, reason: 'too short' };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return { ok: false, reason: 'not a PNG' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(8) !== 13 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return { ok: false, reason: 'no IHDR' };
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
