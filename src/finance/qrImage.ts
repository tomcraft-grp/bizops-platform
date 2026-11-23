// QR pictures: read the shop's QR from an uploaded photo, and draw a payment QR as a PNG that customers save and scan
// from their gallery. Everything runs in the browser; nothing is uploaded here.
import jsQR from 'jsqr';
import QRCode from 'qrcode';

/** Decode a QR from an image file (photo or screenshot). Tries a few scales because phone photos are large and noisy. */
export async function decodeQrFromImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG or JPG picture of the QR');
  const bmp = await createImageBitmap(file);
  try {
    for (const max of [1400, 900, 600, 1920]) {
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
      const res = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
      if (res?.data) return res.data;
    }
  } finally { bmp.close(); }
  throw new Error('No QR code was found in this picture. Use a sharp, straight-on picture with the whole QR inside.');
}

/** `orderNo`, `ref` and `expiresAt` exist only for an invoice's QR; the QR at checkout has none of them yet. */
export interface QrCard { payload: string; amount: number; merchant: string; account?: string; orderNo?: string; ref?: string; expiresAt?: string; lang: 'th' | 'en' }

const FONT = '"Noto Sans Thai", "Sarabun", system-ui, sans-serif';
/** The font size at which the text fits the width (a long name must not run off the card). */
function fit(g: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number): void {
  let px = size;
  do { g.font = `${weight} ${px}px ${FONT}`; px -= 2; } while (px > 24 && g.measureText(text).width > max);
}
/** A 1080px-wide PNG: the QR black on white with its quiet zone on a dark card, so the saved picture explains itself and still scans. */
export async function renderQrCard(c: QrCard): Promise<Blob> {
  const W = 1080, H = 1600, plate = 800, px = (W - plate) / 2, py = 250, th = c.lang === 'th';
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  // straight down on purpose: every row is one colour, so the PNG stays small
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0b1d36'); bg.addColorStop(0.55, '#14315a'); bg.addColorStop(1, '#091628');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const gold = g.createLinearGradient(0, 0, W, 0); gold.addColorStop(0, '#b98f45'); gold.addColorStop(0.5, '#f1dca7'); gold.addColorStop(1, '#b98f45');
  g.fillStyle = gold; g.fillRect(0, 0, W, 10); g.fillRect(0, H - 10, W, 10);
  g.textAlign = 'center';
  g.fillStyle = '#f1dca7'; g.font = `600 40px ${FONT}`; g.fillText(th ? 'พร้อมเพย์ · Thai QR' : 'PromptPay · Thai QR', W / 2, 105);
  g.fillStyle = '#ffffff'; g.font = `800 60px ${FONT}`; g.fillText(th ? 'สแกนเพื่อชำระเงิน' : 'Scan to pay', W / 2, 190);
  // the QR: pure black on white, its own quiet zone inside a white plate; nothing decorative touches it
  g.fillStyle = gold; roundRect(g, px - 8, py - 8, plate + 16, plate + 16, 44); g.fill();
  g.fillStyle = '#ffffff'; roundRect(g, px, py, plate, plate, 38); g.fill();
  const qr = 740;
  const img = new Image(); img.src = await QRCode.toDataURL(c.payload, { errorCorrectionLevel: 'M', margin: 4, width: qr, color: { dark: '#000000', light: '#ffffff' } }); await img.decode();
  g.imageSmoothingEnabled = false; g.drawImage(img, px + (plate - qr) / 2, py + (plate - qr) / 2, qr, qr);
  g.fillStyle = '#c7d3e6'; g.font = `500 38px ${FONT}`; g.fillText(th ? 'ยอดที่ต้องชำระ' : 'Amount to pay', W / 2, 1140);
  g.fillStyle = '#ffffff'; fit(g, '฿' + fmt(c.amount), 800, 124, W - 120); g.fillText('฿' + fmt(c.amount), W / 2, 1262);
  if (c.merchant) { g.fillStyle = '#f1dca7'; fit(g, c.merchant, 700, 48, W - 140); g.fillText(c.merchant, W / 2, 1340); }
  if (c.account) { g.fillStyle = '#c7d3e6'; fit(g, c.account, 500, 36, W - 140); g.fillText(c.account, W / 2, 1396); }
  const line = [c.orderNo, c.ref ? `${th ? 'อ้างอิง' : 'Ref'} ${c.ref}` : ''].filter(Boolean).join('  ·  ');
  g.fillStyle = '#c7d3e6';
  if (line) { fit(g, line, 500, 34, W - 140); g.fillText(line, W / 2, 1458); }
  g.font = `500 32px ${FONT}`;
  if (c.expiresAt) g.fillText(`${th ? 'ใช้ได้ถึง' : 'Valid until'} ${new Date(c.expiresAt).toLocaleString(th ? 'th-TH' : 'en-GB', { timeZone: 'Asia/Bangkok' })}`, W / 2, 1506);
  g.fillText(th ? 'ตรวจสอบชื่อผู้รับและยอดเงินก่อนยืนยันการโอน' : 'Check the recipient and the amount before you confirm', W / 2, 1556);
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the QR picture'))), 'image/png'));
}
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** A normal file download (desktop and Android browsers; in-app browsers ignore it, see wallet/qrSave.ts). */
export function downloadBlob(b: Blob, name: string) {
  const url = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
