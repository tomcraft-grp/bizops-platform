// Small pure helpers for showing a bank account to a customer.
import type { Bank } from './api';

/** 1234567890 -> 123-4-56789-0 (the usual Thai 10-digit layout); other lengths are grouped by 4. */
export function formatAccountNo(no: string): string {
  const d = no.replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 4)}-${d.slice(4, 9)}-${d.slice(9)}`;
  return d.replace(/(.{4})(?=.)/g, '$1-');
}
/** What is copied: digits only, so it pastes straight into any banking app. */
export const copyableAccountNo = (no: string): string => no.replace(/\D/g, '');

/** Brand colours for the badge shown when a bank has no logo picture (these are colours, not the banks' logos). */
const BRAND: Record<string, { bg: string; fg: string }> = {
  SCB: { bg: '#4e2e7f', fg: '#ffffff' }, BBL: { bg: '#1e4598', fg: '#ffffff' }, KBANK: { bg: '#138f2d', fg: '#ffffff' }, KTB: { bg: '#00a4e4', fg: '#ffffff' },
  BAY: { bg: '#fec43b', fg: '#3b3b3b' }, TTB: { bg: '#ee5a24', fg: '#ffffff' }, GSB: { bg: '#eb198d', fg: '#ffffff' },
};
export const bankBrand = (code: string) => BRAND[code.toUpperCase()] ?? { bg: '#475569', fg: '#ffffff' };

export const bankTitle = (b: Pick<Bank, 'bank_name_th' | 'bank_name_en' | 'code'>) => `${b.bank_name_th} (${b.code})`;

/** Copy text to the clipboard; falls back to a hidden textarea for webviews (LINE) that block the async API. */
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
  } catch { return false; }
}
