// "Transfer points": the customer's screen for sending loyalty points to another member and for answering points sent to them.
// The rules live in the database (supabase/migrations/20261127120000_points_transfer.sql): a request HOLDS the sender's points, the recipient must press Accept
// (a second press changes nothing), Decline / Cancel / running out of time frees the points. This screen only shows what rw_transfer_overview says and sends
// requests; it never decides a balance. No primary button is ever greyed out: a wrong entry is explained when the button is pressed, and while a request is
// on its way the button keeps its colour and says so (aria-busy).
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, CheckCircle2, Clock, Coins, Copy, Gift, RefreshCw, Send, Share2, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { cx } from '../lib/util';
import { transfers, type Transfer, type TransferOverview } from '../rewards/transferApi';
import { ShopError } from './api';
import { attemptKey, forgetAttempt, newKey } from './cart';
import { shopDateTime } from './format';
import { useShopLang, useT, type K } from './i18n';
import { useShopHost, useShopNav } from './nav';
import * as V from './pointsView';
import { ErrorBox, errText } from './ui';

interface Msg { tone: 'good' | 'bad' | 'info'; text: string }
type Enabled = Extract<TransferOverview, { enabled: true }>;

/** The question sheet of this screen (the shared one greys its buttons out while busy; here the button keeps its colour and says what is happening). */
function Sheet({ title, children, confirmLabel, busyLabel, cancelLabel, busy, danger, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; busyLabel: string; cancelLabel: string; busy: boolean; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => { card.current?.focus(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [busy, onCancel]);
  return (
    <div className="sp-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="sp-sheet-card" tabIndex={-1} ref={card}>
        <h3>{title}</h3>
        <div className="sp-sheet-body">{children}</div>
        <div className="sp-sheet-btns">
          <button type="button" className="btn lg pt-btn" onClick={() => { if (!busy) onCancel(); }} aria-disabled={busy} data-testid="pt-sheet-cancel">{cancelLabel}</button>
          <button type="button" className={cx('btn lg pt-btn', danger ? 'danger' : 'primary')} aria-busy={busy} onClick={() => { if (!busy) onConfirm(); }} data-testid="pt-sheet-confirm">
            {busy ? <><span className="spinner sm" aria-hidden /> {busyLabel}</> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const initial = (name: string) => (name.trim().slice(0, 1) || '?').toUpperCase();

export function PointTransferView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const lang = useShopLang();
  const { session } = useAuth();
  const uid = session?.user.id ?? 'anon';
  const [ov, setOv] = useState<TransferOverview | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  // send form
  const [codeIn, setCodeIn] = useState('');
  const [codeErr, setCodeErr] = useState<K | null>(null);
  const [checking, setChecking] = useState(false);
  const [rcpt, setRcpt] = useState<{ code: string; name: string; mask: string } | null>(null);
  const [amountIn, setAmountIn] = useState('');
  const [amountErr, setAmountErr] = useState<{ key: K; vars?: Record<string, number> } | null>(null);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState<K | null>(null);
  const [ask, setAsk] = useState<{ points: number; text: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  // answers
  const [busyId, setBusyId] = useState<string | null>(null);
  const [askReject, setAskReject] = useState<Transfer | null>(null);
  const [askCancel, setAskCancel] = useState<Transfer | null>(null);
  const [histAll, setHistAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const seq = useRef(0);
  const sendingRef = useRef(false);
  const answering = useRef(false);
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { headRef.current?.focus({ preventScroll: true }); headRef.current?.closest('.phone-body')?.scrollTo({ top: 0 }); }, []);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const o = await transfers.overview();
      if (!alive.current || n !== seq.current) return;
      setOv(o); setLoadErr(null);
      if (o.enabled && o.unread > 0) {          // opening the screen is reading the news; a failure here changes nothing but the little number
        transfers.markRead().then(() => { if (alive.current) setOv((cur) => (cur && cur.enabled ? { ...cur, unread: 0 } : cur)); }).catch(() => undefined);
      }
    } catch (e) { if (alive.current && n === seq.current) setLoadErr(e); }
  }, []);
  useEffect(() => {
    void load();
    const onFocus = () => { if (document.visibilityState !== 'hidden') void load(); };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [load]);

  const on: Enabled | null = ov && ov.enabled ? ov : null;
  const say = (tone: Msg['tone'], text: string) => setMsg({ tone, text });

  // ---------------------------------------------------------------- step 1: who gets the points
  const check = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!on || checking) return;
    const c = V.checkCode(codeIn, on.member_code);
    if (!c.ok) { setCodeErr(c.key); return; }
    setChecking(true); setCodeErr(null);
    try {
      const r = await transfers.lookup(c.code);
      if (!alive.current) return;
      if (!r.found) setCodeErr('pt.err.notFound');
      else if (r.is_self) setCodeErr('pt.err.self');
      else setRcpt({ code: c.code, name: r.name, mask: r.code });
    } catch (err) {
      if (!alive.current) return;
      const code = err instanceof ShopError ? err.code : 'ERROR';
      const plan = V.errorPlan(code, 'answer');
      setCodeErr(plan.key);
      if (plan.refresh) void load();
    } finally { if (alive.current) setChecking(false); }
  };
  const changeRcpt = () => { setRcpt(null); setAmountErr(null); setNoteErr(null); setAsk(null); };

  // ---------------------------------------------------------------- step 2: how many, then the question
  const onReview = () => {
    if (!on || !rcpt) return;
    const a = V.checkAmount(amountIn, { available: on.available, limits: on.limits });
    const m = V.checkMessage(note);
    setAmountErr(a.ok ? null : { key: a.key, vars: a.vars }); setNoteErr(m.ok ? null : m.key);
    if (!a.ok || !m.ok) return;
    setSheetErr(null); setAsk({ points: a.points, text: m.text });
  };
  const send = async () => {
    if (!on || !rcpt || !ask || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setSheetErr(null);
    // the same request keeps the same key (also after a reload), so a lost answer followed by another press can never send twice
    const key = attemptKey(window.localStorage, uid, `${rcpt.code}|${ask.points}|${ask.text ?? ''}`, newKey, 'pt');
    try {
      const r = await transfers.create(rcpt.code, ask.points, key, ask.text);
      forgetAttempt(window.localStorage, uid, 'pt');
      if (!alive.current) return;
      say('good', r.replay ? t('pt.sentReplay') : t('pt.sent', { name: rcpt.name, n: ask.points }));
      setAsk(null); setRcpt(null); setCodeIn(''); setAmountIn(''); setNote('');
      void load();
    } catch (err) {
      if (!alive.current) return;
      const code = err instanceof ShopError ? err.code : 'ERROR';
      const plan = V.errorPlan(code, 'send', { available: err instanceof ShopError && err.detail ? Number(err.detail) : on.available, dailyLeft: V.dailyLeft(on.limits) });
      if (!plan.keepKey) forgetAttempt(window.localStorage, uid, 'pt');
      if (plan.keepKey) setSheetErr(t(plan.key));                 // the question stays open: pressing confirm again is the SAME request
      else { setAsk(null); say('bad', t(plan.key, plan.vars)); }
      if (plan.refresh) void load();
    } finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };

  // ---------------------------------------------------------------- answering
  const answer = async (tr: Transfer, kind: 'accept' | 'reject' | 'cancel') => {
    if (answering.current) return;
    answering.current = true; setBusyId(tr.id); setMsg(null);
    try {
      const r = kind === 'accept' ? await transfers.accept(tr.id) : kind === 'reject' ? await transfers.reject(tr.id) : await transfers.cancel(tr.id);
      if (!alive.current) return;
      if (kind === 'accept') {
        if (r.status === 'accepted') say('good', r.replay ? t('pt.acceptedReplay') : t('pt.accepted', { n: r.points, total: r.balance ?? (on ? on.balance + r.points : r.points) }));
        else say('info', t(r.status === 'expired' ? 'pt.expiredNow' : 'pt.cancelledNow'));
      } else if (kind === 'reject') say('good', t('pt.rejected'));
      else say('good', t('pt.cancelDone'));
    } catch (err) {
      if (!alive.current) return;
      const code = err instanceof ShopError ? err.code : 'ERROR';
      const plan = V.errorPlan(code, 'answer');
      say('bad', t(plan.key, plan.vars));
    } finally {
      answering.current = false;
      if (alive.current) { setBusyId(null); setAskReject(null); setAskCancel(null); }
      void load();
    }
  };

  // ---------------------------------------------------------------- my member ID
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => { if (alive.current) setCopied(false); }, 2000); }
    catch { say('info', t('pt.copyFailed')); }
  };
  const share = async (code: string) => {
    try { await navigator.share({ text: t('pt.shareText', { code }) }); } catch { /* the sheet was closed: nothing to do */ }
  };

  // ---------------------------------------------------------------- render
  const live = on ? on.incoming.filter((x) => V.isLive(x)) : [];
  const out = on ? on.outgoing.filter((x) => V.isLive(x)) : [];
  const history = on ? on.history : [];
  const shown = histAll ? history : history.slice(0, 8);
  const maxNow = on ? V.maxSendable(on.available, on.limits) : 0;

  return (
    <div className="sp-page pt-page">
      <button type="button" className="sp-back" onClick={onBack}><ArrowLeft size={18} /> {t('common.back')}</button>
      <div className="pt-head">
        <h2 className="sp-h2" tabIndex={-1} ref={headRef}>{t('pt.title')}</h2>
        <button type="button" className="btn ghost sm" onClick={() => void load()} aria-label={t('common.refresh')}><RefreshCw size={15} /></button>
      </div>

      {!ov && !loadErr && <div className="pt-skel" aria-busy="true" aria-label={t('pt.updating')}><i /><i /><i /></div>}
      {loadErr != null && !ov && <ErrorBox message={`${t('pt.loadError')} · ${errText(t, loadErr)}`} onRetry={() => void load()} />}
      {ov && !ov.enabled && <p className="sp-note" data-testid="pt-off">{t('pt.off')}</p>}

      {on && (
        <>
          <section className="pt-hero" aria-label={t('pt.available')}>
            <span className="pt-hero-ic" aria-hidden><Coins size={22} /></span>
            <div className="pt-hero-main">
              <span>{t('pt.available')}</span>
              <p><b data-testid="pt-available">{on.available}</b> <small>{t('pt.unit')}</small></p>
            </div>
            <div className="pt-hero-sub">
              <span>{t('pt.balance')}: <b data-testid="pt-balance">{on.balance}</b></span>
              {on.reserved > 0 && <span className="pt-held" data-testid="pt-reserved">{t('pt.reserved', { n: on.reserved })}</span>}
            </div>
            {on.reserved > 0 && <p className="pt-note">{t('pt.reservedNote')}</p>}
          </section>

          {live.length > 0 && (
            <section className="sp-sec" aria-labelledby="pt-in-h" data-testid="pt-incoming-list">
              <div className="sp-sec-h"><h3 id="pt-in-h">{t('pt.incoming')}</h3><span className="sp-count-badge">{live.length}</span></div>
              <ul className="pt-list">
                {live.map((tr) => (
                  <li key={tr.id} className="pt-req" data-testid="pt-incoming" data-transfer={tr.transfer_no}>
                    <div className="pt-req-top">
                      <span className="pt-avatar" aria-hidden>{initial(tr.counterparty.name)}</span>
                      <div className="pt-who"><b>{tr.counterparty.name}</b><small>{tr.counterparty.code}</small></div>
                      <span className="pt-pts"><b>+{tr.points}</b><small>{t('pt.unit')}</small></span>
                    </div>
                    {tr.message && <p className="pt-quote">{tr.message}</p>}
                    <small className="pt-exp"><Clock size={13} aria-hidden /> {t('pt.expiresOn', { time: shopDateTime(tr.expires_at, lang) })}</small>
                    <div className="pt-actions">
                      <button type="button" className="btn lg primary pt-btn" data-testid="pt-accept" aria-busy={busyId === tr.id} onClick={() => void answer(tr, 'accept')}>
                        {busyId === tr.id ? <><span className="spinner sm" aria-hidden /> {t('pt.sending')}</> : <><Check size={17} aria-hidden /> {t('pt.accept')}</>}
                      </button>
                      <button type="button" className="btn lg pt-btn" data-testid="pt-reject" aria-disabled={busyId === tr.id} onClick={() => { if (!answering.current) setAskReject(tr); }}>{t('pt.reject')}</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="pt-card" aria-labelledby="pt-send-h">
            <h3 id="pt-send-h"><Send size={16} aria-hidden /> {t('pt.send')}</h3>
            {!rcpt ? (
              <form className="sp-form" onSubmit={(e) => void check(e)} noValidate>
                <label>{t('pt.codeLabel')}
                  <input className="pt-code" value={codeIn} maxLength={14} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder={t('pt.codePh')}
                    aria-invalid={!!codeErr} aria-describedby={codeErr ? 'pt-code-err' : undefined} data-testid="pt-code"
                    onChange={(e) => { setCodeIn(e.target.value); setCodeErr(null); }} />
                </label>
                {codeErr && <small id="pt-code-err" className="bad" role="alert" data-testid="pt-code-err">{t(codeErr)}</small>}
                <button type="submit" className="btn lg primary pt-btn" aria-busy={checking} data-testid="pt-check">
                  {checking ? <><span className="spinner sm" aria-hidden /> {t('pt.checking')}</> : t('pt.check')}
                </button>
              </form>
            ) : (
              <div className="sp-form">
                <div className="pt-rcpt" data-testid="pt-rcpt">
                  <span className="pt-avatar" aria-hidden>{initial(rcpt.name)}</span>
                  <div className="pt-who"><b data-testid="pt-rcpt-name">{rcpt.name}</b><small>{rcpt.mask}</small><span className="pt-found"><CheckCircle2 size={13} aria-hidden /> {t('pt.found')}</span></div>
                  <button type="button" className="btn ghost sm" onClick={changeRcpt} data-testid="pt-change">{t('pt.changeRcpt')}</button>
                </div>
                <label>{t('pt.amountLabel')}
                  <input className="pt-amount" value={amountIn} inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={9} aria-invalid={!!amountErr}
                    aria-describedby={amountErr ? 'pt-amount-err' : 'pt-amount-hint'} data-testid="pt-amount"
                    onChange={(e) => { setAmountIn(e.target.value); setAmountErr(null); }} />
                </label>
                {amountErr ? <small id="pt-amount-err" className="bad" role="alert" data-testid="pt-amount-err">{t(amountErr.key, amountErr.vars)}</small>
                  : <small id="pt-amount-hint" className="sp-note">{t('pt.amountHint', { min: on.limits.min, max: on.limits.max, left: V.dailyLeft(on.limits) })}</small>}
                {maxNow > 0 && <button type="button" className="pt-chip-btn" onClick={() => { setAmountIn(String(maxNow)); setAmountErr(null); }} data-testid="pt-all">{t('pt.all')} · {maxNow}</button>}
                <label>{t('pt.msgLabel')}
                  <textarea rows={2} value={note} maxLength={V.MESSAGE_MAX + 40} placeholder={t('pt.msgPh')} aria-invalid={!!noteErr} data-testid="pt-note" onChange={(e) => { setNote(e.target.value); setNoteErr(null); }} />
                </label>
                {noteErr && <small className="bad" role="alert">{t(noteErr)}</small>}
                <button type="button" className="btn lg primary pt-btn" onClick={onReview} data-testid="pt-review"><Send size={16} aria-hidden /> {t('pt.review')}</button>
              </div>
            )}
            <p className="pt-note">{t('pt.how', { days: on.limits.expire_days })}</p>
          </section>

          {out.length > 0 && (
            <section className="sp-sec" aria-labelledby="pt-out-h" data-testid="pt-outgoing-list">
              <div className="sp-sec-h"><h3 id="pt-out-h">{t('pt.outgoing')}</h3></div>
              <ul className="pt-list">
                {out.map((tr) => (
                  <li key={tr.id} className="pt-req out" data-testid="pt-outgoing" data-transfer={tr.transfer_no}>
                    <div className="pt-req-top">
                      <span className="pt-avatar" aria-hidden>{initial(tr.counterparty.name)}</span>
                      <div className="pt-who"><b>{tr.counterparty.name}</b><small>{tr.counterparty.code} · {t('pt.ref', { no: tr.transfer_no })}</small></div>
                      <span className="pt-pts held"><b>{tr.points}</b><small>{t('pt.unit')}</small></span>
                    </div>
                    <small className="pt-exp"><Clock size={13} aria-hidden /> {t('pt.expiresOn', { time: shopDateTime(tr.expires_at, lang) })}</small>
                    <div className="pt-actions">
                      <button type="button" className="btn lg pt-btn" data-testid="pt-cancel" aria-disabled={busyId === tr.id} onClick={() => { if (!answering.current) setAskCancel(tr); }}>{t('pt.cancel')}</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="pt-card pt-id" aria-labelledby="pt-id-h">
            <h3 id="pt-id-h"><Gift size={16} aria-hidden /> {t('pt.myId')}</h3>
            <p className="pt-idcode" data-testid="pt-mycode">{on.member_code}</p>
            <small className="sp-note">{t('pt.myIdHint')}</small>
            <div className="pt-actions">
              <button type="button" className="btn pt-btn" onClick={() => void copy(on.member_code)} data-testid="pt-copy"><Copy size={15} aria-hidden /> {copied ? t('pt.copied') : t('pt.copy')}</button>
              {typeof navigator !== 'undefined' && 'share' in navigator && <button type="button" className="btn pt-btn" onClick={() => void share(on.member_code)}><Share2 size={15} aria-hidden /> {t('pt.share')}</button>}
            </div>
          </section>

          <section className="sp-sec" aria-labelledby="pt-hist-h">
            <div className="sp-sec-h"><h3 id="pt-hist-h">{t('pt.history')}</h3></div>
            {history.length === 0 ? <p className="sp-note" data-testid="pt-hist-none">{t('pt.histNone')}</p> : (
              <ul className="rw-hist pt-hist" data-testid="pt-history">
                {shown.map((tr) => {
                  const mv = V.movement(tr); const why = V.reasonKey(tr);
                  return (
                    <li key={tr.id} data-testid="pt-hist" data-status={tr.status} data-transfer={tr.transfer_no}>
                      <span className={cx('pt-dir', tr.direction)} aria-hidden>{tr.direction === 'in' ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span>
                      <span className="rw-hist-main">
                        <span>{t(tr.direction === 'in' ? 'pt.in' : 'pt.out', { name: tr.counterparty.name })}</span>
                        <small>{shopDateTime(tr.decided_at ?? tr.created_at, lang)} · {t('pt.ref', { no: tr.transfer_no })}</small>
                        {why && <small>{t(why)}</small>}
                        {tr.message && <small>{t('pt.noteQuote', { text: tr.message })}</small>}
                      </span>
                      <span className="pt-hist-r">
                        <b className={cx('rw-hist-pts', mv < 0 && 'neg', mv === 0 && 'none')}>{mv > 0 ? `+${mv}` : mv < 0 ? `−${-mv}` : tr.points}</b>
                        <span className={cx('pt-chip', V.statusTone(tr.status))}>{t(V.STATUS_KEY[tr.status])}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {history.length > shown.length && <button type="button" className="btn pt-btn" onClick={() => setHistAll(true)}>{t('pt.showAll', { n: history.length })}</button>}
          </section>
        </>
      )}

      <div className="rw-dock" aria-live="polite">
        {msg && (
          <div className={cx('rw-msg', msg.tone)} role={msg.tone === 'bad' ? 'alert' : 'status'} data-testid="pt-msg" data-tone={msg.tone}>
            <span>{msg.text}</span>
            <button type="button" aria-label={t('common.close')} onClick={() => setMsg(null)}><X size={16} /></button>
          </div>
        )}
      </div>

      {ask && rcpt && on && (
        <Sheet title={t('pt.confirmTitle')} confirmLabel={t('pt.confirmGo')} busyLabel={t('pt.sending')} cancelLabel={t('common.cancel')} busy={sending}
          onConfirm={() => void send()} onCancel={() => { if (!sendingRef.current) setAsk(null); }}>
          <p data-testid="pt-confirm-line"><b>{t('pt.confirmLine', { n: ask.points, name: rcpt.name, code: rcpt.mask })}</b></p>
          {ask.text && <p>{t('pt.noteQuote', { text: ask.text })}</p>}
          <p>{t('pt.confirmHold', { days: on.limits.expire_days })}</p>
          <p>{t('pt.confirmAfter', { n: Math.max(0, on.available - ask.points) })}</p>
          {sheetErr && <p className="bad" role="alert" data-testid="pt-sheet-err">{sheetErr}</p>}
        </Sheet>
      )}
      {askReject && (
        <Sheet title={t('pt.rejectQ', { n: askReject.points, name: askReject.counterparty.name })} confirmLabel={t('pt.reject')} busyLabel={t('pt.sending')} cancelLabel={t('pt.keep')} busy={busyId === askReject.id} danger
          onConfirm={() => void answer(askReject, 'reject')} onCancel={() => { if (!answering.current) setAskReject(null); }}>
          <p>{t('pt.rejectBody')}</p>
        </Sheet>
      )}
      {askCancel && (
        <Sheet title={t('pt.cancelQ', { n: askCancel.points, name: askCancel.counterparty.name })} confirmLabel={t('pt.cancel')} busyLabel={t('pt.sending')} cancelLabel={t('pt.keep')} busy={busyId === askCancel.id} danger
          onConfirm={() => void answer(askCancel, 'cancel')} onCancel={() => { if (!answering.current) setAskCancel(null); }}>
          <p>{t('pt.cancelBody')}</p>
        </Sheet>
      )}
    </div>
  );
}

/** Home: one line when somebody has sent points that wait for this customer's answer. Quiet (nothing at all) when transfers are off, the call fails, or nothing waits. */
export function TransferHomeBanner() {
  const t = useT();
  const host = useShopHost();
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    transfers.overview().then((o) => { if (on && o.enabled) setN(V.waitingForMe(o)); }).catch(() => undefined);
    return () => { on = false; };
  }, []);
  if (n <= 0) return null;
  return (
    <button type="button" className="sp-topay pt-homecard" onClick={() => { useShopNav.setState({ pendingTransfer: true }); host.goTab('profile'); }} data-testid="home-transfer">
      <Coins size={18} aria-hidden /><span>{t('pt.homeBanner', { n })}</span>
    </button>
  );
}

