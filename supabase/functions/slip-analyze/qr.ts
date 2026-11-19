// The QR code of a Thai transfer slip: decode it from a PNG / JPEG, and check it is a Bank of Thailand slip-verify payload with a valid checksum.
// The libraries are imported by bare name (jsqr, pngjs, jpeg-js): deno.json maps them for Deno, node_modules resolves them for the unit tests.
//
// What is returned feeds finance_classify_slip as p_qr:
//   { found: false }                      no QR, a PDF, a picture that cannot be decoded (the slip is then simply not QR-checked)
//   { found: true, crc_ok: true,  ... }   a slip-verify QR whose checksum is right: sending_bank and trans_ref are what the bank printed in it
//   { found: true, crc_ok: false, ... }   a QR was decoded but it is not a valid slip QR (another kind of QR, no country tag, wrong checksum); the database
//                                         records QR_BAD_CRC and treats the slip as suspicious
// This function never throws.
import { Buffer } from 'node:buffer';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { decode as decodeJpeg } from 'jpeg-js';

export interface QrResult { found: boolean; crc_ok: boolean | null; sending_bank: string | null; trans_ref: string | null }
export const NO_QR: QrResult = Object.freeze({ found: false, crc_ok: null, sending_bank: null, trans_ref: null });

const MAX_SIDE = 1000;                    // the picture is scaled down to this on its longer side before the QR is searched
const MAX_PIXELS = 12_000_000;            // a bigger picture is not decoded (CPU and memory of an Edge Function): the slip is then not QR-checked

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

/**
 * The slip-verify payload: top-level fields, field 00 holds nested fields (00 api marker, 01 sending bank = 3 digits, 02 transaction reference),
 * field 51 is the country (TH) and field 91 is the CRC-16 of everything before its value, up to and including "9104". Compared in upper case.
 */
export function interpretPayload(payload: string): QrResult {
  const top = parseTlv(payload);
  if (!top) return { found: true, crc_ok: false, sending_bank: null, trans_ref: null };
  const inner = parseTlv(top.find((f) => f.tag === '00')?.value ?? '') ?? [];
  const bank = inner.find((f) => f.tag === '01')?.value;
  const ref = inner.find((f) => f.tag === '02')?.value;
  const sendingBank = bank !== undefined && /^[0-9]{3}$/.test(bank) ? bank : null;
  const transRef = cleanRef(ref, 64);
  const crcField = top.find((f) => f.tag === '91');
  const crcOk = !!crcField && crcField === top[top.length - 1] && crcField.value.length === 4
    && crcField.value.toUpperCase() === crc16(payload.slice(0, crcField.valueStart))
    && top.find((f) => f.tag === '51')?.value === 'TH'
    && sendingBank !== null && transRef !== null;
  return { found: true, crc_ok: crcOk, sending_bank: sendingBank, trans_ref: transRef };
}

interface Rgba { data: Uint8Array; width: number; height: number }

function decodePng(bytes: Uint8Array): Rgba | null {
  // the size is in the IHDR chunk right after the 8-byte signature: refuse an enormous picture before inflating it
  if (bytes.length < 33) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  if (w === 0 || h === 0 || w * h > MAX_PIXELS) return null;
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { data: png.data, width: png.width, height: png.height };
}

function readJpeg(bytes: Uint8Array): Rgba | null {
  const img = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 160 });
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
