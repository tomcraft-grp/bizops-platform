// Customer-facing pieces shared by the wallet screens and the invoice payment panel: bank logo / badge, selectable bank cards
// (name in Thai and English, account number, holder, copy button, instructions), the payment-method picker, error text.
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Check, Copy, QrCode, Wallet as WalletIcon } from 'lucide-react';
import { toast } from '../domain/store';
import { cx } from '../lib/util';
import { baht } from '../shop/format';
import { K, ShopLang, useShopLang, useT } from '../shop/i18n';
import { Fold, focusFold } from '../shop/ui';
import { walletCode, wallet, Bank, PaymentMethods } from './api';
import { useAuth } from '../auth/AuthProvider';
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

/** The PromptPay QR as a choice in the wallet top-up (shown only when the shop linked its QR to a bank account). */
export function QrTopUpCard({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  const t = useT();
  return (
    <div className={cx('wl-method', selected && 'on')} data-method="qr">
      <label className="wl-card">
        <input type="radio" name="dep-method" className="wl-radio" checked={selected} onChange={onSelect} aria-label={t('pm.qr')} />
        <span className="wl-logo wl-badge wl-qr" aria-hidden><QrCode size={22} /></span>
        <span className="wl-card-main"><b>{t('pm.qr')}</b><span className="wl-en">{t('pm.qrHint')}</span></span>
      </label>
    </div>
  );
}

/** The chosen method in one line, for the closed picker: its badge, its name and the detail that tells it apart. */
export function ChoiceSummary({ methods, value }: { methods: PaymentMethods; value: Choice }) {
  const t = useT();
  const lang = useShopLang();
  const bank = value?.kind === 'bank' ? methods.banks.find((x) => x.id === value.id) : undefined;
  const row = (key: string, badge: ReactNode, name: string, detail: string) => <span className="wl-sum" data-testid="chosen-method" data-chosen={key}>{badge}<span className="wl-sum-t"><b>{name}</b><small>{detail}</small></span></span>;
  if (bank) return row(bank.code, <BankBadge bank={bank} />, lang === 'en' ? bank.bank_name_en : bank.bank_name_th, `${formatAccountNo(bank.account_no)} · ${bank.account_name}`);
  if (value?.kind === 'wallet') return row('wallet', <span className="wl-logo wl-badge wl-wallet" aria-hidden><WalletIcon size={20} /></span>, t('pm.wallet'), t('pm.walletBalance', { amount: baht(methods.wallet.balance) }));
  if (value?.kind === 'qr') return row('qr', <span className="wl-logo wl-badge wl-qr" aria-hidden><QrCode size={20} /></span>, t('pm.qr'), t('pm.qrHint'));
  return <span data-testid="chosen-method" data-chosen="">{t('pm.title')}</span>;
}

/**
 * The payment methods behind one line. Closed it shows the chosen method; tapping it lists them all; tapping a method picks it and closes the list again.
 * Arrow keys move between the methods without closing (a keyboard user must be able to pass over one); Enter closes.
 */
export function PayMethodPicker({ id = 'payment', title, methods, value, onChange, open, setOpen, wallet = true, qr = true, hint }: {
  id?: string; title: string; methods: PaymentMethods; value: Choice; onChange: (c: Choice) => void; open: boolean; setOpen: (o: boolean) => void; wallet?: boolean; qr?: boolean; hint?: ReactNode;
}) {
  const t = useT();
  const byTap = useRef(false);
  const done = () => { setOpen(false); focusFold(id); };
  // a tap on a card is a click on its label and then one the browser sends to the radio inside: only the second closes (the radio must still exist to take it)
  const click = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement && el.type === 'radio') { const tap = byTap.current; byTap.current = false; if (tap) done(); }
    else byTap.current = e.detail > 0 && !!el.closest('label.wl-card');
  };
  return (
    <Fold id={id} title={title} open={open} onToggle={() => setOpen(!open)} action={value ? t('pm.change') : t('pm.choose')} summary={<ChoiceSummary methods={methods} value={value} />}>
      <div onClick={click} onKeyDown={(e) => { if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); done(); } }}>
        <MethodCards methods={methods} value={value} onChange={onChange} wallet={wallet} qr={qr} />
      </div>
      {hint && <div className="sp-note">{hint}</div>}
    </Fold>
  );
}

// Keyed by the signed-in user: on a shared device the next person must never see the previous customer's wallet balance.
let cache: { at: number; v: PaymentMethods; uid: string | null } | null = null;
export const clearMethodsCache = () => { cache = null; };
/** The payment methods (banks, wallet balance, QR availability), cached briefly; `reload` after the balance changes. */
export function useMethods(): { methods: PaymentMethods | null; error: boolean; reload: () => void } {
  const uid = useAuth().profile?.id ?? null;
  const fresh = () => !!cache && cache.uid === uid && Date.now() - cache.at < 20_000;
  const [methods, setMethods] = useState<PaymentMethods | null>(fresh() ? cache!.v : null);
  const [error, setError] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    if (n === 0 && fresh()) { setMethods(cache!.v); return; }
    setMethods(null);
    wallet.methods().then((v) => { cache = { at: Date.now(), v, uid }; if (on) { setMethods(v); setError(false); } }).catch(() => { if (on) setError(true); });
    return () => { on = false; };
  }, [n, uid]); // eslint-disable-line react-hooks/exhaustive-deps
  return { methods, error, reload: () => { clearMethodsCache(); setN((x) => x + 1); } };
}

/** Customer text for a failed wallet call (never the raw database message). */
export function walletErrText(t: ReturnType<typeof useT>, e: unknown, vars?: Record<string, string | number>): string {
  const c = walletCode(e);
  const k = `we.${c}` as K;
  try { return t(k, vars); } catch { return t('we.ERROR'); }
}
