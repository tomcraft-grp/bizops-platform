// The text inside the QR of a Thai transfer slip: what it says and whether its checksum is right. Pure (no libraries), shared by the Edge Function (qr.ts decodes the picture there)
// and by the reader that runs in the staff browser (src/slipReader), so both judge a QR the same way. See qr.ts for what the results mean to the database.
export interface QrResult { found: boolean; crc_ok: boolean | null; sending_bank: string | null; trans_ref: string | null }

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
