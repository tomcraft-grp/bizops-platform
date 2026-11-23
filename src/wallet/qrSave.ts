// Getting the QR picture onto the customer's device. Why this is not just <a download>: LINE's (and other apps') in-app browsers ignore downloads of a picture the page made itself,
// and on an iPhone a downloaded file lands in Files, where banking apps do not look. So, per device:
//   share     the phone's own share sheet with a real PNG file ("Save Image")          iPhone / iPad, and in-app browsers that can share files
//   download  a normal file download                                                    desktop and Android browsers
//   sheet     the picture full screen: press and hold to save, or open a real https link in the phone's own browser     in-app browsers that can do neither
import liff from '@line/liff';
import { supabase } from '../lib/supabase';

export type SaveWay = 'share' | 'download' | 'sheet';
export interface SaveEnv { ua: string; touch: boolean; canShareFiles: boolean }

/** A browser inside another app (LINE, Facebook, Instagram, TikTok, WeChat, or a bare Android WebView): downloads are unreliable there. */
export const isInApp = (ua: string): boolean => /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|BytedanceWebview|TikTok|; wv\)/i.test(ua);
/** iPhone / iPad (an iPad says it is a Mac, but a Mac has no touch screen). */
export const isIos = (ua: string, touch: boolean): boolean => /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touch);

export function saveWay(e: SaveEnv): SaveWay {
  if (isInApp(e.ua) || isIos(e.ua, e.touch)) return e.canShareFiles ? 'share' : 'sheet';
  return 'download';
}
export function currentEnv(file?: File): SaveEnv {
  let canShareFiles = false;
  try { canShareFiles = !!file && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }); } catch { /* not supported */ }
  return { ua: navigator.userAgent, touch: (navigator.maxTouchPoints ?? 0) > 1, canShareFiles };
}

/** A safe file name: payment-qr-ORD-000123.png */
export const qrFileName = (id: string): string => `payment-qr-${id.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'shop'}.png`;

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'sheet';
/** Must be called straight from the tap (the browser only shares / downloads during one), so the picture is made beforehand. Never throws. */
export async function saveQr(file: File, download: (b: Blob, name: string) => void, env = currentEnv(file)): Promise<SaveOutcome> {
  const way = saveWay(env);
  if (way === 'download') { try { download(file, file.name); return 'downloaded'; } catch { return 'sheet'; } }
  if (way === 'share') {
    try { await navigator.share({ files: [file] }); return 'shared'; }
    catch (e) { return (e as Error)?.name === 'AbortError' ? 'cancelled' : 'sheet'; }       // the customer closed the sheet, or this browser promised more than it can do
  }
  return 'sheet';
}

/** Puts the picture into the customer's own private folder (one file, overwritten) and returns a link that works for ten minutes in any browser. null when that is not possible. */
export async function hostedQrLink(file: File): Promise<string | null> {
  try {
    const { data: u } = await supabase.auth.getUser();
    const uid = u.user?.id; if (!uid) return null;
    const path = `${uid}/payment-qr.png`;
    const up = await supabase.storage.from('payment-qr').upload(path, file, { contentType: 'image/png', upsert: true, cacheControl: '0' });
    if (up.error) return null;
    // iPhone: shown, so that a press and hold saves it to Photos; elsewhere: downloaded under its name
    const s = await supabase.storage.from('payment-qr').createSignedUrl(path, 600, isIos(navigator.userAgent, (navigator.maxTouchPoints ?? 0) > 1) ? undefined : { download: file.name });
    return s.error ? null : s.data.signedUrl;
  } catch { return null; }
}

/** Opens a link in the phone's own browser instead of the in-app one. */
export function openOutside(url: string): void {
  if (/\bLine\//i.test(navigator.userAgent)) {
    try { liff.openWindow({ url, external: true }); return; } catch { /* the page was not opened through LIFF */ }
    window.location.href = `${url}${url.includes('?') ? '&' : '?'}openExternalBrowser=1`;
    return;
  }
  window.open(url, '_blank', 'noopener');
}
