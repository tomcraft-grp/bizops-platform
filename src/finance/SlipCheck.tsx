// What the customer sees while their slip is checked (finance_my_slip_check, migration 20261124100000). It says only what the customer can see on their own slip (the amount, the day,
// an unreadable picture, a slip already used); everything else, also a slip that looks edited, reads "a person at the shop checks it". It never says "verified": the customer sees
// that the payment is complete only when the shop has posted it against its bank record (invoice state 5). Nothing to say (the reader is off, an older database) = nothing is drawn.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, Upload } from 'lucide-react';
import { Lang } from '../lib/i18n';
import { dateFmt } from '../lib/util';
import { baht } from '../shop/format';
import { K, tr } from '../shop/i18n';
import { finance, SlipCheckState } from './api';

const POLL_MS = 4000;
const GIVE_UP_MS = 120_000;

export function slipCheckText(s: SlipCheckState, lang: Lang): { title: string; body: string; detail?: string } | null {
  if (s.state === 'processing') return { title: tr(lang, 'sc.processing'), body: tr(lang, 'sc.processingBody') };
  if (s.state === 'review') return { title: tr(lang, 'sc.review'), body: tr(lang, 'sc.reviewBody') };
  if (s.state !== 'attention') return null;
  const detail = s.code === 'AMOUNT' && s.slip_amount != null && s.expected_amount != null ? tr(lang, 'sc.amount', { slip: baht(Number(s.slip_amount)), want: baht(Number(s.expected_amount)) })
    : (s.code === 'DATE_PAST' || s.code === 'DATE_FUTURE') && s.slip_date ? tr(lang, s.code === 'DATE_PAST' ? 'sc.datePast' : 'sc.dateFuture', { date: dateFmt(s.slip_date) })
      : tr(lang, (({ DUPLICATE: 'sc.used', NOT_A_SLIP: 'sc.notSlip', UNREADABLE: 'sc.unreadable' } as Record<string, K>)[s.code ?? ''] ?? 'sc.generic'));
  return { title: tr(lang, 'sc.attention'), body: tr(lang, 'sc.attentionBody'), detail };
}

export function SlipCheck({ invoiceId, refresh, lang, onResend }: { invoiceId: string; refresh: string; lang: Lang; onResend?: () => void }) {
  const [st, setSt] = useState<SlipCheckState | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    try { const r = await finance.mySlipCheck(invoiceId); if (alive.current) setSt(r ?? null); return r?.state ?? 'none'; }
    catch { if (alive.current) setSt(null); return 'none'; }                     // an older database, or no connection: the invoice's own status is on the page anyway
  }, [invoiceId]);
  useEffect(() => {
    let on = true; let h: ReturnType<typeof setTimeout> | undefined;
    const began = Date.now();
    const step = async () => {
      const s = await load();
      if (on && s === 'processing' && Date.now() - began < GIVE_UP_MS) h = setTimeout(() => void step(), POLL_MS);
    };
    void step();
    return () => { on = false; clearTimeout(h); };
  }, [load, refresh]);

  const text = st && slipCheckText(st, lang);
  if (!st || !text) return null;
  return (
    <div className={`sc-card ${st.state}`} data-testid="slip-check" data-state={st.state} role="status" aria-live="polite">
      <span className="sc-ic" aria-hidden>{st.state === 'processing' ? <i className="sc-spin" /> : st.state === 'attention' ? <AlertTriangle size={20} /> : <Clock size={20} />}</span>
      <div className="sc-main">
        <b>{text.title}</b>
        {text.detail && <span className="sc-detail" data-testid="slip-check-detail">{text.detail}</span>}
        <span>{text.body}</span>
        {st.state === 'attention' && onResend && <button type="button" className="btn sm" onClick={onResend}><Upload size={14} /> {tr(lang, 'sc.resend')}</button>}
      </div>
    </div>
  );
}
