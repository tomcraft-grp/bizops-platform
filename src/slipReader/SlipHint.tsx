// A word of caution on the customer's own phone before they place the order: "the amount on this slip looks like ฿300, but ฿370 is to be transferred". It only warns. It never blocks, stores
// or sends anything, and nobody at the shop relies on it: what a customer's phone says about their own slip proves nothing.
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { baht } from '../shop/format';
import { useT } from '../shop/i18n';
import type { Reading, SlipQr } from './parse';
import { ownReader } from './store';

/** What to warn about, or null. Only what both readings of the phone agree on; a doubtful reading says nothing. */
export function hintFor(r: Reading & { qr: SlipQr }, total: number): { kind: 'amount'; amount: number } | { kind: 'notSlip' } | null {
  const e = r.extracted;
  if (e.amount !== null && e.field_confidence.amount >= 0.9 && Math.round(e.amount * 100) !== Math.round(total * 100)) return { kind: 'amount', amount: e.amount };
  if (!e.is_slip && e.amount === null && !r.qr.found) return { kind: 'notSlip' };
  return null;
}
/** Do not spend a customer's data or a weak phone's memory on a courtesy. */
export function worthTrying(n: { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number } = navigator as never): boolean {
  return !n.connection?.saveData && !/^(slow-)?2g$/.test(n.connection?.effectiveType ?? '') && (n.deviceMemory ?? 4) >= 2;
}

export function SlipHint({ file, total }: { file: File; total: number }) {
  const t = useT();
  const [r, setR] = useState<{ file: File; reading: Reading & { qr: SlipQr } } | null>(null);
  useEffect(() => {
    let on = true;
    if (!file.type.startsWith('image/') || !worthTrying()) return;
    void (async () => {
      try {
        const s = await ownReader.status(); if (!on || !s?.enabled) return;
        const { readPicture, readerAvailable } = await import('./engine'); if (!on || !readerAvailable()) return;
        const reading = await readPicture(file, 'quick', new Date(), 45_000);
        if (on) setR({ file, reading });
      } catch { /* a courtesy: no word is better than a wrong one */ }
    })();
    return () => { on = false; };
  }, [file]);
  const h = r?.file === file ? hintFor(r.reading, total) : null;
  if (!h) return null;
  return (
    <div className="sc-card attention" role="status" data-testid="slip-hint" data-kind={h.kind}>
      <span className="sc-ic" aria-hidden><AlertTriangle size={20} /></span>
      <div className="sc-main"><b>{h.kind === 'amount' ? t('sh.amount', { slip: baht(h.amount), want: baht(total) }) : t('sh.notSlip')}</b><span>{t('sh.body')}</span></div>
    </div>
  );
}
