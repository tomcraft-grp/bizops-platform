import type { ShopLang } from './i18n';

/** ฿1,010 / ฿1,010.50 — whole baht without decimals, satang only when there are some. */
export const baht = (n: number | null | undefined): string => {
  const v = Number.isFinite(n as number) ? (n as number) : 0;
  return '฿' + v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
};
/** "6,000 คำ" from pack quantity + unit, '' when either is missing. */
export const packLabel = (pack: number | null | undefined, unit: string | null | undefined): string =>
  pack && unit ? `${Number(pack).toLocaleString('en-US')} ${unit}` : '';
export const shopDate = (iso: string | undefined, lang: ShopLang): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const shopDateTime = (iso: string | undefined, lang: ShopLang): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
/** Thai mobile numbers as typed by people: keep digits only. */
export const digits = (s: string): string => s.replace(/\D/g, '');
export const validPhone = (s: string): boolean => /^0\d{8,9}$/.test(digits(s));
