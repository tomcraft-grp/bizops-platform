// How the QR picture reaches each kind of device, and what the screen checks before it shows a QR at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseThaiQr, promptPayPayload } from '../../src/lib/promptpay';
vi.mock('@line/liff', () => ({ default: { openWindow: vi.fn() } }));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
const { currentEnv, isInApp, isIos, qrFileName, saveQr, saveWay } = await import('../../src/wallet/qrSave');

const UA = {
  lineIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.8.0',
  lineAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Line/14.9.0/IAB',
  facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/450.0]',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
const env = (ua: string, canShareFiles: boolean, touch = true) => ({ ua, canShareFiles, touch });

describe('which way to save', () => {
  it('in-app browsers are recognised', () => {
    for (const k of ['lineIos', 'lineAndroid', 'facebook'] as const) expect(isInApp(UA[k]), k).toBe(true);
    for (const k of ['safariIos', 'ipad', 'chromeAndroid', 'desktop'] as const) expect(isInApp(UA[k]), k).toBe(false);
  });
  it('an iPad is an iPad, a Mac is not', () => { expect(isIos(UA.ipad, true)).toBe(true); expect(isIos(UA.ipad, false)).toBe(false); expect(isIos(UA.safariIos, true)).toBe(true); expect(isIos(UA.desktop, true)).toBe(false); });
  it('LINE never gets a plain download (it ignores one)', () => {
    expect(saveWay(env(UA.lineIos, true))).toBe('share'); expect(saveWay(env(UA.lineIos, false))).toBe('sheet'); expect(saveWay(env(UA.lineAndroid, false))).toBe('sheet'); expect(saveWay(env(UA.facebook, false))).toBe('sheet');
  });
  it('iPhone: the share sheet (Photos), not the Files folder', () => { expect(saveWay(env(UA.safariIos, true))).toBe('share'); expect(saveWay(env(UA.safariIos, false))).toBe('sheet'); expect(saveWay(env(UA.ipad, true))).toBe('share'); });
  it('desktop and Android browsers download', () => { expect(saveWay(env(UA.desktop, true, false))).toBe('download'); expect(saveWay(env(UA.chromeAndroid, true))).toBe('download'); });
});

describe('saving', () => {
  const file = new File(['x'], 'payment-qr-ORD-1.png', { type: 'image/png' });
  afterEach(() => vi.unstubAllGlobals());
  const share = (fn: () => Promise<void>) => vi.stubGlobal('navigator', { userAgent: UA.lineIos, maxTouchPoints: 5, share: vi.fn(fn), canShare: () => true });
  it('downloads the file under its own name', async () => { const d = vi.fn(); expect(await saveQr(file, d, env(UA.desktop, false, false))).toBe('downloaded'); expect(d).toHaveBeenCalledWith(file, 'payment-qr-ORD-1.png'); });
  it('a browser that cannot download falls back to the picture', async () => { expect(await saveQr(file, () => { throw new Error('no'); }, env(UA.desktop, false, false))).toBe('sheet'); });
  it('shares a real PNG file', async () => { share(async () => undefined); expect(await saveQr(file, vi.fn())).toBe('shared'); expect(navigator.share).toHaveBeenCalledWith({ files: [file] }); });
  it('closing the share sheet is not an error', async () => { share(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }); expect(await saveQr(file, vi.fn())).toBe('cancelled'); });
  it('a share that is refused falls back to the picture', async () => { share(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }); expect(await saveQr(file, vi.fn())).toBe('sheet'); });
  it('a browser without sharing, or whose check throws, is told apart safely', () => {
    vi.stubGlobal('navigator', { userAgent: UA.lineIos, maxTouchPoints: 5 }); expect(currentEnv(file).canShareFiles).toBe(false);
    vi.stubGlobal('navigator', { userAgent: UA.lineIos, maxTouchPoints: 5, share: () => undefined, canShare: () => { throw new Error('x'); } }); expect(currentEnv(file).canShareFiles).toBe(false);
  });
  it('file names are safe', () => { expect(qrFileName('ORD-000123')).toBe('payment-qr-ORD-000123.png'); expect(qrFileName('../../a b/ค?')).toBe('payment-qr-..-..-a-b.png'); expect(qrFileName('')).toBe('payment-qr-shop.png'); });
});

describe('parseThaiQr: what is checked before a QR is shown', () => {
  it('reads the amount and the account and checks the checksum', () => {
    expect(parseThaiQr(promptPayPayload('0812345678', 370))).toEqual({ crcOk: true, amount: 370, target: '0066812345678' });
    expect(parseThaiQr(promptPayPayload('0812345678', 0.5))?.amount).toBe(0.5);
  });
  it('an e-wallet account like the shop\'s', () => {
    const body = '000201010212' + '29390016A0000006770101110315004999000000001' + '5303764' + '5406430.00' + '5802TH' + '6304';
    expect(parseThaiQr(body + '0000')).toEqual({ crcOk: false, amount: 430, target: '004999000000001' });
  });
  it('one changed digit of the amount breaks the checksum', () => { expect(parseThaiQr(promptPayPayload('0812345678', 370).replace('370.00', '970.00'))?.crcOk).toBe(false); });
  it('anything else is not a payment QR', () => { for (const x of ['', 'https://evil.test', '000201', '5303764', promptPayPayload('0812345678', 1).slice(0, 40), undefined as unknown as string]) expect(parseThaiQr(x)).toBeNull(); });
  it('a QR without an amount has none (it is then not shown)', () => { expect(parseThaiQr(promptPayPayload('0812345678'))?.amount).toBeNull(); });
});
