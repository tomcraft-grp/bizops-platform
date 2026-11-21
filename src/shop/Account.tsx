// The top of the Account tab: who the customer is, how many orders / payments are open, shortcuts and the language choice.
// (The name / phone / consent form and the feedback centre below it stay in pages/CustomerApp.tsx.)
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ClipboardList, Gift, ShoppingBag, ShoppingCart, Wallet as WalletIcon } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { cx } from '../lib/util';
import { shop } from './api';
import { wallet } from '../wallet/api';
import { rewards } from '../rewards/api';
import { RewardsView } from './Rewards';
import { baht } from './format';
import { useCartCount } from './cart';
import { useShopHost } from './nav';
import { useShopLangStore, useT } from './i18n';

export function AccountSummary({ onOpenWallet }: { onOpenWallet?: () => void } = {}) {
  const t = useT();
  const host = useShopHost();
  const { profile, session } = useAuth();
  const lang = useShopLangStore((s) => s.lang);
  const setLang = useShopLangStore((s) => s.set);
  const cartN = useCartCount();
  const [orders, setOrders] = useState<number | null>(null);
  const [toPay, setToPay] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [rewardsOn, setRewardsOn] = useState(false);          // the "Rewards & event" row: only when the server says rewards are on (ships dark; an older database simply has none)
  const [inRewards, setInRewards] = useState(false);
  const rewardsRow = useRef<HTMLButtonElement>(null);
  const wasInRewards = useRef(false);
  const picture = (session?.user.user_metadata as { picture?: string } | undefined)?.picture;

  useEffect(() => {
    let on = true;
    shop.myOrders('all', 1, 0).then((r) => { if (on) setOrders(r.total); }).catch(() => undefined);
    shop.myOrders('unpaid', 1, 0).then((r) => { if (on) setToPay(r.total); }).catch(() => undefined);
    wallet.summary().then((r) => { if (on) setBalance(r.balance); }).catch(() => undefined);   // hidden when the wallet is not available
    rewards.settings().then((r) => { if (on) setRewardsOn(!!r.enabled); }).catch(() => undefined);   // hidden when rewards are off or the call fails
    return () => { on = false; };
  }, []);

  useEffect(() => { if (wasInRewards.current && !inRewards) rewardsRow.current?.focus(); wasInRewards.current = inRewards; }, [inRewards]);   // Back lands on the row that opened the screen

  const row = (icon: JSX.Element, title: string, hint: string, to: 'pay' | 'cart' | 'shop', badge?: number) => (
    <button type="button" className="sp-linkrow" onClick={() => host.goTab(to)}>
      <span className="sp-linkrow-ic">{icon}</span>
      <span className="grow"><b>{title}</b><small>{hint}</small></span>
      {!!badge && <span className="sp-count-badge">{badge}</span>}
      <ChevronRight size={18} aria-hidden />
    </button>
  );
  // The Rewards screen takes the place of this page (shop.css hides what the host renders after it: the member form, the feedback centre).
  if (inRewards) return <div className="sp-account rw-open"><RewardsView onBack={() => setInRewards(false)} /></div>;
  return (
    <div className="sp-account">
      <div className="sp-me">
        {picture ? <img src={picture} alt="" width={56} height={56} /> : <span className="sp-me-ph" aria-hidden>{(profile?.display_name || '?').slice(0, 1)}</span>}
        <div><b>{profile?.display_name || '—'}</b><small>{profile?.phone || ''}</small></div>
      </div>
      {balance != null && onOpenWallet && (
        <button type="button" className="wl-account-card" onClick={onOpenWallet} data-testid="wallet-card">
          <span className="sp-linkrow-ic"><WalletIcon size={20} /></span>
          <span className="grow"><small>{t('w.balance')}</small><b data-testid="account-wallet-balance">{baht(balance)}</b></span>
          <span className="btn sm primary" aria-hidden>{t('w.title')}</span>
        </button>
      )}
      <div className="sp-stats">
        <div><b>{orders ?? '–'}</b><span>{t('acc.orders')}</span></div>
        <div><b>{toPay ?? '–'}</b><span>{t('acc.toPay')}</span></div>
      </div>
      <div className="sp-links">
        {row(<ClipboardList size={20} />, t('acc.myOrders'), t('acc.myOrdersHint'), 'pay', toPay || 0)}
        {row(<ShoppingCart size={20} />, t('acc.cart'), t('acc.cartHint'), 'cart', cartN)}
        {row(<ShoppingBag size={20} />, t('acc.shop'), t('acc.shopHint'), 'shop')}
        {rewardsOn && (
          <button type="button" className="sp-linkrow" ref={rewardsRow} onClick={() => setInRewards(true)} data-testid="rewards-row">
            <span className="sp-linkrow-ic"><Gift size={20} /></span>
            <span className="grow"><b>{t('acc.rewards')}</b><small>{t('acc.rewardsHint')}</small></span>
            <ChevronRight size={18} aria-hidden />
          </button>
        )}
      </div>
      <div className="sp-lang" role="group" aria-label={t('acc.language')}>
        <span>{t('acc.language')}</span>
        <div className="sp-seg">
          <button type="button" className={cx(lang === 'th' && 'on')} aria-pressed={lang === 'th'} onClick={() => setLang('th')}>ไทย</button>
          <button type="button" className={cx(lang === 'en' && 'on')} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
        </div>
      </div>
    </div>
  );
}
