// Customer-facing pieces shared by the wallet screens and the invoice payment panel: bank logo / badge, selectable bank cards
// (name in Thai and English, account number, holder, copy button, instructions), the payment-method picker, error text.
import { useEffect, useState } from 'react';
import { Check, Copy, QrCode, Wallet as WalletIcon } from 'lucide-react';
import { toast } from '../domain/store';
import { cx } from '../lib/util';
import { baht } from '../shop/format';
import { K, ShopLang, useShopLang, useT } from '../shop/i18n';
import { walletCode, wallet, Bank, PaymentMethods } from './api';
import { bankBrand, copyableAccountNo, copyText, formatAccountNo } from './bank';

export function BankBadge({ bank }: { bank: Pick<Bank, 'code' | 'logo_url' | 'bank_name_en'> }) {
  const [bad, setBad] = useState(false);
  const b = bankBrand(bank.code);
  if (bank.logo_url && !bad) return <img className="wl-logo" src={bank.logo_url} alt="" width={44} height={44} onError={() => setBad(true)} />;
  return <span className="wl-logo wl-badge" style={{ background: b.bg, color: b.fg }} aria-hidden>{bank.code.slice(0, 4)}</span>;
}
export const bankInstructions = (b: Bank, lang: ShopLang) => (lang === 'en' ? b.instructions_en || b.instructions_th : b.instructions_th || b.instructions_en) ?? '';

/** Copy button for the account number (digits only) or any text. Says what happened, also when the webview blocks copying. */
export function CopyButton({ text, label, doneKey = 'bank.copied', size = 'sm' }: { text: string; label: string; doneKey?: K; size?: 'sm' | 'md' }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const click = async () => {
    const ok = await copyText(text);
    if (ok) { setDone(true); toast('success', t(doneKey)); setTimeout(() => setDone(false), 2000); } else toast('error', t('bank.copyFailed'));
  };
  return <button type="button" className={cx('btn', size === 'sm' && 'sm')} onClick={() => void click()} aria-label={label}>{done ? <Check size={14} /> : <Copy size={14} />} {label}</button>;
}

/** One bank account as a selectable card. The copy button sits next to the radio (never inside it). */
export function BankCard({ bank, name, selected, onSelect, readOnly = false }: { bank: Bank; name?: string; selected?: boolean; onSelect?: () => void; readOnly?: boolean }) {
  const t = useT();
  const lang = useShopLang();
  const ins = bankInstructions(bank, lang);
  const body = (
    <>
      <BankBadge bank={bank} />
      <span className="wl-card-main">
        <b>{bank.bank_name_th} <small>({bank.code})</small></b>
        <span className="wl-en">{bank.bank_name_en}</span>
        <span className="wl-acct"><span className="wl-k">{t('bank.account')}</span> <span className="wl-no" data-testid="account-no">{formatAccountNo(bank.account_no)}</span></span>
        <span className="wl-holder"><span className="wl-k">{t('bank.holder')}</span> {bank.account_name}</span>
        {ins && <span className="wl-ins">{ins}</span>}
      </span>
    </>
  );
  return (
    <div className={cx('wl-method', selected && 'on')} data-bank={bank.code}>
      {readOnly
        ? <div className="wl-card">{body}</div>
        : <label className="wl-card"><input type="radio" name="pay-method" className="wl-radio" checked={!!selected} onChange={() => onSelect?.()} aria-label={`${name ?? bank.bank_name_th} (${bank.code})`} />{body}</label>}
      <div className="wl-copy"><CopyButton text={copyableAccountNo(bank.account_no)} label={t('bank.copy')} /></div>
    </div>
  );
}

export type Choice = { kind: 'bank'; id: string } | { kind: 'wallet' } | { kind: 'qr' } | null;
export const sameChoice = (a: Choice, b: Choice) => !!a && !!b && a.kind === b.kind && (a.kind !== 'bank' || (b.kind === 'bank' && a.id === b.id));

/** Payment methods as selectable cards: every active bank, the wallet and (for invoices) the PromptPay QR. */
export function MethodCards({ methods, value, onChange, wallet: showWallet = true, qr = false }: { methods: PaymentMethods; value: Choice; onChange: (c: Choice) => void; wallet?: boolean; qr?: boolean }) {
  const t = useT();
  return (
    <div className="wl-methods" role="radiogroup" aria-label={t('pm.title')}>
      {methods.banks.map((b) => <BankCard key={b.id} bank={b} selected={sameChoice(value, { kind: 'bank', id: b.id })} onSelect={() => onChange({ kind: 'bank', id: b.id })} />)}
      {showWallet && (
        <div className={cx('wl-method', value?.kind === 'wallet' && 'on')} data-method="wallet">
          <label className="wl-card">
            <input type="radio" name="pay-method" className="wl-radio" checked={value?.kind === 'wallet'} onChange={() => onChange({ kind: 'wallet' })} aria-label={t('pm.wallet')} />
            <span className="wl-logo wl-badge wl-wallet" aria-hidden><WalletIcon size={22} /></span>
            <span className="wl-card-main"><b>{t('pm.wallet')}</b><span className="wl-en">{t('pm.walletBalance', { amount: baht(methods.wallet.balance) })}</span></span>
          </label>
        </div>
      )}
      {qr && methods.promptpay && (
        <div className={cx('wl-method', value?.kind === 'qr' && 'on')} data-method="qr">
          <label className="wl-card">
            <input type="radio" name="pay-method" className="wl-radio" checked={value?.kind === 'qr'} onChange={() => onChange({ kind: 'qr' })} aria-label={t('pm.qr')} />
            <span className="wl-logo wl-badge wl-qr" aria-hidden><QrCode size={22} /></span>
            <span className="wl-card-main"><b>{t('pm.qr')}</b></span>
          </label>
        </div>
      )}
    </div>
  );
}

let cache: { at: number; v: PaymentMethods } | null = null;
export const clearMethodsCache = () => { cache = null; };
/** The payment methods (banks, wallet balance, QR availability), cached briefly; `reload` after the balance changes. */
export function useMethods(): { methods: PaymentMethods | null; error: boolean; reload: () => void } {
  const [methods, setMethods] = useState<PaymentMethods | null>(cache && Date.now() - cache.at < 20_000 ? cache.v : null);
  const [error, setError] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    if (n === 0 && cache && Date.now() - cache.at < 20_000) return;
    wallet.methods().then((v) => { cache = { at: Date.now(), v }; if (on) { setMethods(v); setError(false); } }).catch(() => { if (on) setError(true); });
    return () => { on = false; };
  }, [n]);
  return { methods, error, reload: () => { clearMethodsCache(); setN((x) => x + 1); } };
}

/** Customer text for a failed wallet call (never the raw database message). */
export function walletErrText(t: ReturnType<typeof useT>, e: unknown, vars?: Record<string, string | number>): string {
  const c = walletCode(e);
  const k = `we.${c}` as K;
  try { return t(k, vars); } catch { return t('we.ERROR'); }
}
