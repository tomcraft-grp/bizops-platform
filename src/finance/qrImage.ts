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

export interface QrCard { payload: string; amount: number; ref: string; merchant: string; invoiceNo: string; expiresAt: string; lang: 'th' | 'en' }

/** A 1080px-wide PNG: QR with a white quiet zone, amount, reference, merchant and expiry, so the saved picture is self-explanatory. */
export async function renderQrCard(c: QrCard): Promise<Blob> {
  const W = 1080, H = 1500, qr = 760;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0b2a4a'; g.fillRect(0, 0, W, 150);
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = '700 56px "Noto Sans Thai", "Sarabun", system-ui, sans-serif';
  g.fillText(c.lang === 'th' ? 'สแกนเพื่อชำระเงิน' : 'Scan to pay', W / 2, 95);
  const dataUrl = await QRCode.toDataURL(c.payload, { errorCorrectionLevel: 'M', margin: 4, width: qr, color: { dark: '#000000', light: '#ffffff' } });
  const img = new Image(); img.src = dataUrl; await img.decode();
  g.drawImage(img, (W - qr) / 2, 190, qr, qr);
  g.fillStyle = '#0b0b0b';
  g.font = '800 120px "Noto Sans Thai", system-ui, sans-serif';
  g.fillText('฿' + c.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), W / 2, 1105);
  g.font = '600 46px "Noto Sans Thai", system-ui, sans-serif';
  g.fillStyle = '#333'; g.fillText(c.merchant, W / 2, 1180);
  g.font = '500 42px "Noto Sans Thai", system-ui, sans-serif';
  g.fillText(`${c.lang === 'th' ? 'ใบแจ้งหนี้' : 'Invoice'} ${c.invoiceNo}`, W / 2, 1250);
  g.fillText(`${c.lang === 'th' ? 'อ้างอิง' : 'Ref'} ${c.ref}`, W / 2, 1312);
  g.fillStyle = '#b42318';
  g.font = '500 36px "Noto Sans Thai", system-ui, sans-serif';
  g.fillText(`${c.lang === 'th' ? 'ใช้ได้ถึง' : 'Valid until'} ${new Date(c.expiresAt).toLocaleString(c.lang === 'th' ? 'th-TH' : 'en-GB')}`, W / 2, 1375);
  g.fillStyle = '#666'; g.font = '400 32px "Noto Sans Thai", system-ui, sans-serif';
  g.fillText(c.lang === 'th' ? 'เปิดแอปธนาคารใดก็ได้ แล้วเลือกสแกนจากรูปในเครื่อง' : 'Open any banking app and scan from your photo gallery', W / 2, 1440);
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the QR picture'))), 'image/png'));
}

/** Save a PNG. In-app browsers (LINE) often ignore downloads, so the caller also shows the picture to long-press. */
export function downloadBlob(b: Blob, name: string) {
  const url = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
