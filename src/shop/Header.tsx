import { Search, ShoppingBag, UserRound } from 'lucide-react';
import { useCartCount } from './cart';
import { useShopHost } from './nav';
import { useT } from './i18n';

/** The built-in header (used when no DEV APP layout is published): shop name, search, cart with its count, account. */
export function ShopHeader({ title }: { title?: string }) {
  const t = useT();
  const host = useShopHost();
  const n = useCartCount();
  return (
    <div className="phone-top sp-top">
      <b className="sp-top-title">{title || t('hdr.title')}</b>
      <span className="row gap-6">
        <button type="button" className="ca-hicon" aria-label={t('hdr.search')} onClick={() => host.goTab('shop')}><Search size={18} /></button>
        <span className="sp-cartbtn"><button type="button" className="ca-hicon" aria-label={`${t('hdr.cart')}${n ? ` (${n})` : ''}`} onClick={() => host.goTab('cart')}><ShoppingBag size={18} /></button>{n > 0 && <i aria-hidden>{n}</i>}</span>
        <button type="button" className="ca-hicon" aria-label={t('hdr.account')} onClick={() => host.goTab('profile')}><UserRound size={18} /></button>
      </span>
    </div>
  );
}
