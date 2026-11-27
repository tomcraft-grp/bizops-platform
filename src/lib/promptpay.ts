// PromptPay (Thai QR payment) EMV payload — generated locally; nothing is sent anywhere.
const tlv = (id: string, v: string) => id + String(v.length).padStart(2, '0') + v;

function crc16(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function promptPayPayload(id: string, amount?: number): string {
  const digits = id.replace(/\D/g, '');
  const isPhone = digits.length <= 10;
  const target = isPhone ? '0066' + digits.replace(/^0/, '') : digits;
  const merchant = tlv('00', 'A000000677010111') + tlv(isPhone ? '01' : '02', target);
  let p = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('29', merchant) + tlv('53', '764');
  if (amount && amount > 0) p += tlv('54', amount.toFixed(2));
  p += tlv('58', 'TH') + '6304';
  return p + crc16(p);
}

export interface ThaiQr { crcOk: boolean; amount: number | null; target: string | null }
/** Reads a Thai payment QR text: is its checksum right, for how much, to which account. null = not a payment QR at all. */
export function parseThaiQr(p: string): ThaiQr | null {
  const fields = (s: string): Map<string, string> | null => {
    const m = new Map<string, string>(); let i = 0;
    while (i < s.length) {
      const head = s.slice(i, i + 4); if (!/^\d{4}$/.test(head)) return null;
      const n = Number(head.slice(2)); const v = s.slice(i + 4, i + 4 + n); if (v.length !== n) return null;
      m.set(head.slice(0, 2), v); i += 4 + n;
    }
    return m;
  };
  const f = typeof p === 'string' ? fields(p) : null;
  if (!f || f.get('00') !== '01' || f.get('53') !== '764' || f.get('58') !== 'TH') return null;
  const acct = f.get('29') ?? f.get('30'); const sub = acct ? fields(acct) : null;
  if (!sub) return null;
  const amt = f.get('54');
  return { crcOk: p.slice(-8, -4) === '6304' && crc16(p.slice(0, -4)) === p.slice(-4), amount: amt && /^\d+(\.\d{1,2})?$/.test(amt) ? Number(amt) : null, target: sub.get('01') ?? sub.get('02') ?? sub.get('03') ?? null };
}
