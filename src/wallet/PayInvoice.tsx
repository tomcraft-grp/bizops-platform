// Paying an invoice from the customer's wallet, and the "bank transfer" summary shown above the slip form.
// The amount is checked by the database (never above what is owed, never above the balance); a retry of the same payment is safe.
import { useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import type { InvoiceRow } from '../finance/api';
import { attemptKey, forgetAttempt } from '../shop/cart';
import { baht } from '../shop/format';
import { useT } from '../shop/i18n';
import { useShopHost, useShopNav } from '../shop/nav';
import { ConfirmSheet } from '../shop/ui';
import { newKey, wallet } from './api';
import { clearMethodsCache, CopyButton, walletErrText } from './ui';

export function WalletPayPanel({ inv, balance, onPaid }: { inv: InvoiceRow; balance: number; onPaid: () => void }) {
  const t = useT();
  const host = useShopHost();
  const { session } = useAuth();
  const uid = session?.user.id ?? '';
  const max = Math.min(balance, inv.outstanding);
  const [amount, setAmount] = useState(String(Math.max(0, Math.floor(max * 100) / 100)));
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inflight = useRef(false);
  const n = Number(amount);
  const cents = Math.round(n * 100);
  const valid = isFinite(n) && n > 0 && Math.abs(n * 100 - cents) < 1e-6 && cents <= Math.round(max * 100);   // whole satang, within the balance and what is owed
  const short = inv.outstanding - balance;

  const pay = async () => {
    if (inflight.current) return;
    inflight.current = true; setBusy(true); setErr(null);
    try {
      const key = attemptKey(sessionStorage, uid, JSON.stringify({ i: inv.id, n }), newKey, 'walletpay');   // same payment, same key: a retry never charges twice
      await wallet.payInvoice(inv.id, n, key);
      forgetAttempt(sessionStorage, uid, 'walletpay'); clearMethodsCache();
      setAsking(false); toast('success', t('wp.done')); onPaid();
    } catch (e) { setAsking(false); setErr(walletErrText(t, e)); } finally { inflight.current = false; setBusy(false); }
  };
  return (
    <div className="col gap-8 wl-pay" data-testid="wallet-pay">
      <div className="wl-amount"><span className="wl-k">{t('pm.walletBalance', { amount: baht(balance) })}</span></div>
      {short > 0.004 && <div className="sp-note bad" role="status">{t('wp.short', { amount: baht(short) })}
        {' '}<button type="button" className="sp-link" onClick={() => { useShopNav.setState({ pendingWallet: true }); host.goTab('profile'); }}>{t('w.add')}</button></div>}
      {max > 0 && (
        <div className="sp-form">
          <label>{t('wp.amount')}<input type="number" inputMode="decimal" min={0.01} max={max} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <small className="muted">{t('wp.max', { amount: baht(max) })}</small>
        </div>
      )}
      {err && <div className="sp-note bad" role="alert">{err}</div>}
      <button type="button" className="btn primary lg block" disabled={busy || !valid || max <= 0} onClick={() => setAsking(true)}>{t('wp.pay', { amount: valid ? baht(n) : baht(0) })}</button>
      {asking && <ConfirmSheet title={t('wp.confirmTitle')} body={t('wp.confirmBody', { amount: baht(n) })} confirmLabel={t('wp.pay', { amount: baht(n) })} cancelLabel={t('common.back')} busy={busy} onConfirm={() => void pay()} onCancel={() => setAsking(false)} />}
    </div>
  );
}

/** Above the slip form for a bank transfer: exactly how much to send (from the database), nothing to type. */
export function TransferAmount({ amount, reference }: { amount: number; reference?: string }) {
  const t = useT();
  return (
    <>
      <div className="wl-amount"><span className="wl-k">{t('bank.amount')}</span><b data-testid="transfer-amount">{baht(amount)}</b></div>
      {reference && <div className="wl-refbox"><span className="wl-k">{t('bank.ref')}</span><b className="mono" data-testid="payment-ref">{reference}</b><CopyButton text={reference} label={t('bank.copyRef')} doneKey="bank.refCopied" /><small>{t('bank.refHint')}</small></div>}
    </>
  );
}
