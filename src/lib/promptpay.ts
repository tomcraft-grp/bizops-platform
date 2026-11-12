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
