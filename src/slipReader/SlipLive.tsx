// The slip check the customer sees the moment they attach a slip: it reads the picture on their own phone and shows whether the amount and the day agree with what they are about to pay.
// When it is sure something differs they tick "I have checked it" before going on (owner's choice, 2026-11-24). It stores, sends and decides nothing: what a customer's phone says about their
// own slip proves nothing, and the shop checks every slip against its bank record whatever is shown here.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, HelpCircle, X } from 'lucide-react';
import { baht, shopDate } from '../shop/format';
import { useShopLang, useT } from '../shop/i18n';
import type { Reading, SlipQr } from './parse';
import { ownReader, type OwnReaderStatus } from './store';

export type LiveReading = Reading & { qr: SlipQr };
export type RowState = 'ok' | 'differs' | 'unsure';
export interface LiveResult { isSlip: boolean; amount: { state: RowState; value: number | null }; date: { state: RowState; value: string | null; future: boolean } }
const SURE = 0.9;
const bkkDay = (ms: number) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);

/** Compares a reading with what the customer is about to pay. "differs" only for a value the reader is sure of; a doubtful one is "unsure" and asks nothing of the customer. `earliest`: the day of an order that already exists (its transfer may be older than today). */
export function judge(r: LiveReading, total: number, now: number, rule: { before: number; after: number }, earliest?: string): LiveResult {
  const e = r.extracted; const fc = e.field_confidence;
  const same = e.amount !== null && Math.round(e.amount * 100) === Math.round(total * 100);
  const day = e.transfer_at ? e.transfer_at.slice(0, 10) : null;
  const start = bkkDay(now - rule.before * 60_000); const from = earliest && earliest < start ? earliest : start, to = bkkDay(now + rule.after * 60_000);
  const inRange = day !== null && day >= from && day <= to;
  return {
    isSlip: e.is_slip || r.qr.found || e.amount !== null,
    amount: { value: e.amount, state: e.amount === null ? 'unsure' : same ? 'ok' : fc.amount >= SURE ? 'differs' : 'unsure' },
    date: { value: day, future: day !== null && day > to, state: day === null ? 'unsure' : inRange ? 'ok' : fc.date >= SURE ? 'differs' : 'unsure' },
  };
}
export const needsConfirm = (x: LiveResult) => !x.isSlip || x.amount.state === 'differs' || x.date.state === 'differs';
/** Is the customer's check switched on? (a database without the separate switch: it follows the reader) */
export const checkoutOn = (s: OwnReaderStatus | null): boolean => !!s && (s.checkout ?? s.enabled);
/** Do not spend a customer's data or a weak phone's memory on it. */
export function worthTrying(n: { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number } = navigator as never): boolean {
  return !n.connection?.saveData && !/^(slow-)?2g$/.test(n.connection?.effectiveType ?? '') && (n.deviceMemory ?? 4) >= 2;
}
/** Going on is never held up longer than this, however slow the phone. */
export const MAX_WAIT_MS = 20_000;

/** off = no check here; reading; done (with or without something to confirm) */
export interface LiveState { phase: 'off' | 'reading' | 'done'; since: number; mustConfirm: boolean; confirmed: boolean }
export const IDLE: LiveState = { phase: 'off', since: 0, mustConfirm: false, confirmed: false };
/** Why the customer cannot go on yet, or null. */
export const holdUp = (s: LiveState, now = Date.now()): 'sv.wait' | 'sv.must' | null => (s.phase === 'reading' && now - s.since < MAX_WAIT_MS ? 'sv.wait' : s.phase === 'done' && s.mustConfirm && !s.confirmed ? 'sv.must' : null);

const readings = new WeakMap<File, { reading: LiveReading; rule: { before: number; after: number } }>();      // going to another page and back does not read the same picture again

export function SlipLive({ file, total, earliest, onState }: { file: File; total: number; earliest?: string; onState: (s: LiveState) => void }) {
  const t = useT();
  const lang = useShopLang();
  const [r, setR] = useState(() => { const x = readings.get(file); return x ? { file, ...x } : null; });
  const [phase, setPhase] = useState<'off' | 'reading' | 'done'>(r ? 'done' : 'off');
  const [ticked, setTicked] = useState('');
  const since = useRef(Date.now());
  useEffect(() => {
    let on = true;
    const have = readings.get(file);
    if (have) { setR({ file, ...have }); setPhase('done'); return; }
    setR(null); setPhase('off');
    if (!file.type.startsWith('image/') || !worthTrying()) return;
    void (async () => {
      try {
        const s = await ownReader.status(); if (!on || !checkoutOn(s)) return;
        const { readPicture, readerAvailable } = await import('./engine'); if (!on || !readerAvailable()) return;
        since.current = Date.now(); setPhase('reading');
        const reading = await readPicture(file, 'quick', new Date(), 45_000);
        const x = { reading, rule: { before: s?.before_min ?? 120, after: s?.after_min ?? 10 } };
        readings.set(file, x); if (on) { setR({ file, ...x }); setPhase('done'); }
      } catch { if (on) { setR(null); setPhase('off'); } }        // could not be read here: no word is better than a wrong one
    })();
    return () => { on = false; };
  }, [file]);

  const res = r?.file === file ? judge(r.reading, total, Date.now(), r.rule, earliest) : null;
  const must = !!res && needsConfirm(res);
  // the tick belongs to this picture and what was found: another picture or another total must be confirmed again
  const key = res ? JSON.stringify([total, res.isSlip, res.amount.state, res.amount.value, res.date.state, res.date.value]) : '';
  const confirmed = must && ticked === key;
  const shown = phase === 'done' && !res ? 'off' : phase;
  const tell = useRef(onState); tell.current = onState;
  useEffect(() => { tell.current({ phase: shown, since: since.current, mustConfirm: must, confirmed }); }, [shown, must, confirmed, file]);
  useEffect(() => () => { tell.current(IDLE); }, []);

  if (shown === 'off') return null;
  if (shown === 'reading' || !res) return <div className="sc-card processing" role="status" aria-live="polite" data-testid="slip-live" data-state="reading"><span className="sc-ic" aria-hidden><i className="sc-spin" /></span><div className="sc-main"><b>{t('sv.reading')}</b><span>{t('sv.readingBody')}</span></div></div>;
  const icon = (s: RowState) => (s === 'ok' ? <Check size={16} /> : s === 'differs' ? <X size={16} /> : <HelpCircle size={16} />);
  const row = (s: RowState, label: string, text: string, id: string) => <li className={`sv-row ${s}`} data-row={id} data-row-state={s}><span className="sv-ic" aria-hidden>{icon(s)}</span><span className="sv-k">{label}</span><span className="sv-v">{text}</span></li>;
  const date = res.date.value ? shopDate(`${res.date.value}T12:00:00+07:00`, lang) : '';
  const good = !must && res.amount.state === 'ok' && res.date.state === 'ok';
  return (
    <div className={`sv-card ${must ? 'warn' : good ? 'good' : ''}`} role="status" aria-live="polite" data-testid="slip-live" data-state={must ? 'differs' : good ? 'ok' : 'unsure'}>
      <b className="sv-title">{must && <AlertTriangle size={18} aria-hidden />}{t(!res.isSlip ? 'sv.notSlip' : must ? 'sv.differs' : good ? 'sv.ok' : 'sv.unsure')}</b>
      {res.isSlip && <ul className="sv-rows">
        {row(res.amount.state, t('sv.amount'), res.amount.state === 'ok' ? t('sv.amountOk', { a: baht(total) }) : res.amount.state === 'differs' ? t('sv.amountDiff', { slip: baht(res.amount.value ?? 0), want: baht(total) }) : t('sv.notClear'), 'amount')}
        {row(res.date.state, t('sv.date'), res.date.state === 'ok' ? t('sv.dateOk', { d: date }) : res.date.state === 'differs' ? t(res.date.future ? 'sv.dateFuture' : 'sv.datePast', { d: date }) : t('sv.notClear'), 'date')}
      </ul>}
      {must && <label className="sv-tick"><input type="checkbox" checked={confirmed} onChange={(e) => setTicked(e.target.checked ? key : '')} /> <span>{t('sv.tick')}</span></label>}
      <small>{t('sv.note')}</small>
    </div>
  );
}
