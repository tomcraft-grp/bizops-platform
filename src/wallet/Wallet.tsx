// The customer's wallet: balance, totals, deposits (bank transfer + slip, verified by the shop before any money is added),
// the ledger of every movement, and the payment methods. The balance and every status shown here come from the database.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Banknote, ChevronRight, Plus, Receipt, Undo2, Upload, Wallet as WalletIcon } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import { cx } from '../lib/util';
import { attemptKey, forgetAttempt } from '../shop/cart';
import { baht, shopDate, shopDateTime } from '../shop/format';
import { K, useShopLang, useT } from '../shop/i18n';
import { useShopHost } from '../shop/nav';
import { ConfirmSheet, ErrorBox } from '../shop/ui';
import { Banner, Empty } from '../ui/kit';
import { Deposit, DepositStatus, newKey, wallet, WalletSummary, WalletTxn } from './api';
import { BankCard, CopyButton, useMethods, walletErrText } from './ui';
import { copyableAccountNo, formatAccountNo } from './bank';

const DEP_TONE: Record<DepositStatus, 'good' | 'warn' | 'bad' | 'info' | ''> = { pending: 'warn', submitted: 'info', under_review: 'info', verified: 'good', rejected: 'bad', cancelled: '' };
export const DepositPill = ({ status }: { status: DepositStatus }) => { const t = useT(); return <span className={cx('sp-pill', DEP_TONE[status])}>{t(`dep.${status}` as K)}</span>; };

export function TxnRow({ x }: { x: WalletTxn }) {
  const t = useT();
  const lang = useShopLang();
  const credit = x.direction === 'credit';
  const Icon = x.txn_type === 'DEPOSIT' ? ArrowDownLeft : x.txn_type === 'INVOICE_PAYMENT' ? Receipt : x.txn_type === 'REFUND' || x.txn_type === 'REVERSAL' ? Undo2 : credit ? ArrowDownLeft : ArrowUpRight;
  const sub = [x.ref_no, x.bank ? (lang === 'en' ? x.bank.bank_name_en : x.bank.bank_name_th) : null].filter(Boolean).join(' · ');
  return (
    <li className="wl-txn" data-type={x.txn_type}>
      <span className={cx('wl-txn-ic', credit ? 'in' : 'out')} aria-hidden><Icon size={18} /></span>
      <span className="wl-txn-main"><b>{t(`w.t.${x.txn_type}` as K)}{x.bank ? ` · ${x.bank.code}` : ''}</b><small>{sub}{sub ? ' · ' : ''}{shopDateTime(x.txn_date, lang)}</small>{x.note && <small>{x.note}</small>}</span>
      <span className="wl-txn-amt"><b className={credit ? 'in' : 'out'}>{credit ? '+' : '−'}{baht(x.amount)}</b><small>{t('w.balanceAfter', { amount: baht(x.balance_after) })}</small></span>
    </li>
  );
}

export function WalletView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const lang = useShopLang();
  const host = useShopHost();
  const { methods, reload: reloadMethods } = useMethods();
  const [sum, setSum] = useState<WalletSummary | null>(null);
  const [txns, setTxns] = useState<{ items: WalletTxn[]; total: number } | null>(null);
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<Deposit | 'new' | null>(null);
  const [full, setFull] = useState(false);
  const [more, setMore] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const [s, x, d] = await Promise.all([wallet.summary(), wallet.transactions(full ? 20 : 5, 0), wallet.deposits(20)]);
      if (alive.current) { setSum(s); setTxns(x); setDeposits(d); setError(null); }
    } catch (e) { if (alive.current) setError(e); }
  }, [full]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {   // the shop verifies deposits while the customer waits: look again when they come back to the page
    const vis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [load]);

  const loadMore = async () => {
    if (!txns) return;
    setMore(true);
    try { const x = await wallet.transactions(20, txns.items.length); if (alive.current) setTxns({ total: x.total, items: [...txns.items, ...x.items] }); } catch (e) { toast('error', walletErrText(t, e)); } finally { setMore(false); }
  };
  const changed = () => { reloadMethods(); void load(); };

  if (adding) return <DepositFlow resume={adding === 'new' ? null : adding} onClose={() => { setAdding(null); changed(); }} onChanged={changed} />;
  const open = (deposits ?? []).filter((d) => ['pending', 'submitted', 'under_review'].includes(d.status));
  return (
    <div className="sp-page wl-page">
      <button type="button" className="sp-back" onClick={onBack}><ArrowLeft size={18} /> {t('w.back')}</button>
      <h2 className="sp-h2">{t('w.title')}</h2>
      {error != null && !sum && <ErrorBox message={walletErrText(t, error)} onRetry={() => void load()} />}

      <section className="wl-balance" aria-label={t('w.balance')}>
        <span className="wl-bal-k"><WalletIcon size={16} /> {t('w.balance')}</span>
        <b className="wl-bal-v" data-testid="wallet-balance">{sum ? baht(sum.balance) : '…'}</b>
        {sum && sum.pending_deposits > 0 && <span className="wl-bal-pending">{t('w.pending', { amount: baht(sum.pending_deposits) })}</span>}
        <div className="wl-bal-btns">
          <button type="button" className="btn primary" onClick={() => setAdding('new')}><Plus size={16} /> {t('w.add')}</button>
          <button type="button" className="btn" onClick={() => host.goTab('pay')}><Receipt size={16} /> {t('w.payInvoice')}</button>
        </div>
      </section>
      <div className="sp-stats">
        <div><b>{sum ? baht(sum.total_deposits) : '–'}</b><span>{t('w.totalDeposits')}</span></div>
        <div><b>{sum ? baht(sum.total_payments) : '–'}</b><span>{t('w.totalPayments')}</span></div>
      </div>
      <p className="sp-note">{t('w.about')}</p>

      {open.length > 0 && (
        <section className="sp-sec"><h3>{t('w.deposits')}</h3>
          <ul className="wl-deps">{open.map((d) => (
            <li key={d.id}>
              <button type="button" className="wl-dep" onClick={() => setAdding(d)}>
                <span className="wl-dep-main"><b>{baht(d.amount)} · {d.bank?.code}</b><small>{d.deposit_no} · {shopDate(d.created_at, lang)}</small></span>
                <DepositPill status={d.status} /><ChevronRight size={16} aria-hidden />
              </button>
            </li>))}</ul>
        </section>
      )}

      <section className="sp-sec"><div className="sp-sec-h"><h3>{full ? t('w.history') : t('w.recent')}</h3>
        <button type="button" className="sp-link" onClick={() => setFull((f) => !f)}>{full ? t('w.recent') : t('w.history')} <ChevronRight size={14} /></button></div>
        {!txns ? <div className="sp-list-skel" aria-busy="true"><i /><i /></div> : !txns.items.length ? <Empty icon={<Banknote size={26} />} title={t('w.noTxn')} />
          : <ul className="wl-txns">{txns.items.map((x) => <TxnRow key={x.id} x={x} />)}</ul>}
        {full && txns && txns.items.length < txns.total && <button type="button" className="btn block" disabled={more} onClick={() => void loadMore()}>{more ? '…' : t('w.loadMore')}</button>}
      </section>

      {deposits && deposits.some((d) => ['verified', 'rejected', 'cancelled'].includes(d.status)) && (
        <section className="sp-sec"><h3>{t('w.deposits')}</h3>
          <ul className="wl-deps">{deposits.filter((d) => ['verified', 'rejected', 'cancelled'].includes(d.status)).slice(0, 6).map((d) => (
            <li key={d.id} className="wl-dep static">
              <span className="wl-dep-main"><b>{baht(d.verified_amount ?? d.amount)} · {d.bank?.code}</b><small>{d.deposit_no} · {shopDate(d.created_at, lang)}{d.reject_reason ? ` · ${t('dep.reason')}: ${d.reject_reason}` : ''}</small></span>
              <DepositPill status={d.status} />
            </li>))}</ul>
        </section>
      )}

      {methods && methods.banks.length > 0 && (
        <section className="sp-sec"><h3>{t('w.methods')}</h3>
          <div className="wl-methods">{methods.banks.map((b) => <BankCard key={b.id} bank={b} readOnly />)}</div>
        </section>
      )}
    </div>
  );
}

/** Add money: choose the bank, the amount, then transfer and attach the slip. The wallet is credited only after the shop verifies it. */
export function DepositFlow({ resume, onClose, onChanged }: { resume: Deposit | null; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const { session } = useAuth();
  const uid = session?.user.id ?? '';
  const { methods } = useMethods();
  const [bankId, setBankId] = useState<string>(resume?.bank?.id ?? '');
  const [amount, setAmount] = useState(resume ? String(resume.amount) : '');
  const [dep, setDep] = useState<Deposit | null>(resume);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ file: File; url: string | null } | null>(null);
  const [when, setWhen] = useState('');
  const [ref, setRef] = useState('');
  const [askCancel, setAskCancel] = useState(false);
  const inflight = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  useEffect(() => { if (methods && !bankId && methods.banks.length === 1) setBankId(methods.banks[0].id); }, [methods, bankId]);

  const min = methods?.wallet.min_deposit ?? 1, max = methods?.wallet.max_deposit ?? 500000;
  const n = Number(amount);
  const amountOk = amount.trim() !== '' && isFinite(n) && n >= min && n <= max && Math.round(n * 100) === n * 100;
  const bank = methods?.banks.find((b) => b.id === (dep?.bank?.id ?? bankId));

  const create = async () => {
    if (inflight.current || !bankId || !amountOk) return;
    inflight.current = true; setBusy(true); setErr(null);
    try {
      const key = attemptKey(sessionStorage, uid, JSON.stringify({ bankId, n }), newKey, 'wallet');   // the same request keeps the same key: a retry never creates a second deposit
      const d = await wallet.createDeposit(bankId, n, key);
      forgetAttempt(sessionStorage, uid, 'wallet');
      setDep(d); onChanged();
    } catch (e) { setErr(walletErrText(t, e)); } finally { inflight.current = false; setBusy(false); }
  };
  const pick = (f: File | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = f && f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
    urlRef.current = url; setPicked(f ? { file: f, url } : null);
  };
  const submit = async () => {
    if (inflight.current || !dep || !picked) return;
    inflight.current = true; setBusy(true); setErr(null);
    try {
      const d = await wallet.submitSlip({ depositId: dep.id, file: picked.file, transferAt: when ? new Date(when).toISOString() : null, ref });
      setDep({ ...dep, ...d }); pick(null); toast('success', t('dep.sent')); onChanged();
    } catch (e) { setErr(walletErrText(t, e)); } finally { inflight.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (!dep) return;
    setBusy(true);
    try { await wallet.cancelDeposit(dep.id); toast('success', t('dep.cancelledToast')); onChanged(); onClose(); } catch (e) { setAskCancel(false); setErr(walletErrText(t, e)); } finally { setBusy(false); }
  };

  const back = <button type="button" className="sp-back" onClick={onClose}><ArrowLeft size={18} /> {t('w.back')}</button>;
  // ---- step 2: transfer details + slip
  if (dep) {
    const active = dep.status === 'pending';
    return (
      <div className="sp-page wl-page">
        {back}
        <div className="row between"><h2 className="sp-h2">{t('dep.title')}</h2><DepositPill status={dep.status} /></div>
        {err && <Banner tone="bad">{err}</Banner>}
        {dep.status === 'rejected' && <Banner tone="bad">{t('dep.reason')}: {dep.reject_reason}</Banner>}
        {dep.status === 'verified' && <Banner tone="good">{t('dep.verified')} · {baht(dep.verified_amount ?? dep.amount)}</Banner>}
        <div className="wl-transfer">
          <div className="wl-amount"><span className="wl-k">{t('bank.amount')}</span><b data-testid="transfer-amount">{baht(dep.amount)}</b></div>
          <div className="wl-refbox"><span className="wl-k">{t('bank.ref')}</span><b className="mono" data-testid="deposit-ref">{dep.deposit_no}</b><CopyButton text={dep.deposit_no} label={t('bank.copyRef')} doneKey="bank.refCopied" /><small>{t('bank.refHint')}</small></div>
        </div>
        {bank ? <BankCard bank={bank} readOnly /> : dep.bank && (
          <div className="wl-method on"><div className="wl-card"><span className="wl-card-main"><b>{dep.bank.bank_name_th} ({dep.bank.code})</b><span className="wl-acct"><span className="wl-k">{t('bank.account')}</span> {formatAccountNo(dep.bank.account_no)}</span>
            <span className="wl-holder"><span className="wl-k">{t('bank.holder')}</span> {dep.bank.account_name}</span></span></div><div className="wl-copy"><CopyButton text={copyableAccountNo(dep.bank.account_no)} label={t('bank.copy')} /></div></div>
        )}
        {active && (
          <section className="sp-sec"><h3>{t('dep.slip')}</h3>
            <div className="sp-form">
              <input ref={file} type="file" hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) pick(f); }} />
              {picked ? (
                <div className="col gap-8" data-testid="slip-preview">
                  {picked.url ? <img src={picked.url} alt={t('dep.preview')} className="wl-slip" /> : <div className="muted wl-slip-file">{picked.file.name}</div>}
                  <label>{t('dep.transferTime')}<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
                  <label>{t('dep.ref')}<input value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} /></label>
                  <button type="button" className="btn primary lg block" disabled={busy} onClick={() => void submit()}><Upload size={16} /> {busy ? '…' : t('dep.submit')}</button>
                  <button type="button" className="btn block" disabled={busy} onClick={() => file.current?.click()}>{t('dep.another')}</button>
                </div>
              ) : <button type="button" className="btn primary lg block" disabled={busy} onClick={() => file.current?.click()}><Upload size={16} /> {t('dep.choose')}</button>}
              <p className="sp-note">{t('dep.slipNote')}</p>
            </div>
          </section>
        )}
        {(dep.status === 'submitted' || dep.status === 'under_review') && <Banner tone="info">{t('dep.sent')}</Banner>}
        {(dep.status === 'pending' || dep.status === 'submitted') && <button type="button" className="btn block danger-outline" disabled={busy} onClick={() => setAskCancel(true)}>{t('dep.cancel')}</button>}
        {askCancel && <ConfirmSheet danger title={t('dep.cancel')} confirmLabel={t('dep.cancel')} cancelLabel={t('common.cancel')} busy={busy} onConfirm={() => void cancel()} onCancel={() => setAskCancel(false)} />}
      </div>
    );
  }
  // ---- step 1: bank + amount
  return (
    <div className="sp-page wl-page">
      {back}
      <h2 className="sp-h2">{t('dep.title')}</h2>
      {err && <Banner tone="bad">{err}</Banner>}
      <section className="sp-sec"><h3>{t('dep.pickBank')}</h3>
        {!methods ? <div className="sp-list-skel" aria-busy="true"><i /><i /></div> : !methods.banks.length ? <Empty title={t('pm.none')} />
          : <div className="wl-methods" role="radiogroup" aria-label={t('dep.pickBank')}>{methods.banks.map((b) => <BankCard key={b.id} bank={b} selected={bankId === b.id} onSelect={() => setBankId(b.id)} />)}</div>}
      </section>
      <section className="sp-sec"><h3>{t('dep.amount')}</h3>
        <div className="sp-form">
          <input type="number" inputMode="decimal" min={min} max={max} step="0.01" value={amount} aria-label={t('dep.amount')} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          <div className="sp-chips wrap">{[500, 1000, 2000, 5000].filter((q) => q >= min && q <= max).map((q) => <button key={q} type="button" onClick={() => setAmount(String(q))}>{baht(q)}</button>)}</div>
          <small className="muted">{t('dep.amountHint', { min: baht(min), max: baht(max) })}</small>
        </div>
      </section>
      <button type="button" className="btn primary lg block" disabled={busy || !bankId || !amountOk} onClick={() => void create()}>{busy ? '…' : t('dep.create')}</button>
      <p className="sp-note">{t('dep.slipNote')}</p>
    </div>
  );
}
