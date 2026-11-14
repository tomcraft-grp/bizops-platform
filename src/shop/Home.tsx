// The built-in Home (used when no DEV APP layout is published; a layout's Home replaces it). Every section is real data from the
// database, and a section with nothing to show is not drawn at all (no empty headings).
import { FormEvent, useEffect, useState } from 'react';
import { ChevronRight, Search, Wallet } from 'lucide-react';
import { wallet } from '../wallet/api';
import { Banner, Empty } from '../ui/kit';
import { useAuth } from '../auth/AuthProvider';
import { HomeData, SortKey, shop } from './api';
import { baht } from './format';
import { useSettings } from './hooks';
import { useShopLang, useT } from './i18n';
import { EMPTY_FILTER, useShopHost, useShopNav } from './nav';
import { categoryName, ErrorBox, errText, ProductCard, ProductImage, useCategoryLabel, useFacets } from './ui';

export function ShopHome() {
  const t = useT();
  const lang = useShopLang();
  const host = useShopHost();
  const { profile, session } = useAuth();
  const settings = useSettings();
  const { facets } = useFacets();
  const label = useCategoryLabel(facets);
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [toPay, setToPay] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [n, setN] = useState(0);

  useEffect(() => {
    let on = true;
    setError(null);
    shop.home().then((d) => { if (on) setData(d); }).catch((e) => { if (on) setError(e); });
    shop.myOrders('unpaid', 1, 0).then((r) => { if (on) setToPay(r.total); }).catch(() => undefined);
    wallet.summary().then((r) => { if (on) setBalance(r.balance); }).catch(() => undefined);
    return () => { on = false; };
  }, [n]);

  const name = profile?.display_name || (session?.user.user_metadata as { display_name?: string } | undefined)?.display_name || '';
  const openProduct = (sku: string) => { useShopNav.getState().openProduct(sku); host.goTab('shop'); };
  const browse = (patch: { category?: string; sort?: SortKey; q?: string }) => { useShopNav.setState({ catalog: { ...EMPTY_FILTER, ...patch } }); host.goTab('shop'); };
  const search = (e: FormEvent) => { e.preventDefault(); browse({ q: q.trim() }); };
  const closed = !!settings && !settings.shop_open;
  const orderable = !closed;
  const nothing = data && !data.featured.length && !data.newest.length && !data.popular.length && !(facets?.categories.length);

  const rail = (title: string, items: HomeData['featured'], sort: SortKey) => items.length > 0 && (
    <section className="sp-sec" key={title}>
      <div className="sp-sec-h"><h3>{title}</h3><button type="button" className="sp-link" onClick={() => browse({ sort })}>{t('home.seeAll')} <ChevronRight size={14} /></button></div>
      <div className="sp-hscroll">{items.map((it) => <div className="sp-hitem" key={it.sku_code}><ProductCard item={it} onOpen={openProduct} categoryLabel={label(it.category)} orderable={orderable} /></div>)}</div>
    </section>
  );

  return (
    <div className="sp-page sp-home">
      <header className="sp-welcome">
        <div><h2>{t('home.hello', { name: name || '' }).trim()}</h2><p>{t('home.sub')}</p></div>
      </header>
      <form className="sp-search" role="search" onSubmit={search}>
        <Search size={17} aria-hidden />
        <input type="search" value={q} maxLength={80} placeholder={t('cat.search')} aria-label={t('cat.search')} onChange={(e) => setQ(e.target.value)} />
      </form>
      {closed && <Banner tone="warn">{settings?.closed_message || t('shop.closed')}</Banner>}
      {toPay > 0 && <button type="button" className="sp-topay" onClick={() => host.goTab('pay')}><Wallet size={18} /><span>{lang === 'en' ? `${toPay} order(s) waiting for payment` : `มี ${toPay} คำสั่งซื้อที่รอชำระเงิน`}</span><ChevronRight size={16} /></button>}
      {balance != null && <button type="button" className="sp-topay wl-homecard" onClick={() => { useShopNav.setState({ pendingWallet: true }); host.goTab('profile'); }} data-testid="home-wallet"><Wallet size={18} /><span>{t('home.wallet')}: <b>{baht(balance)}</b></span><ChevronRight size={16} /></button>}
      {error != null && !data && <ErrorBox message={`${t('common.loadError')} · ${errText(t, error)}`} onRetry={() => setN((x) => x + 1)} />}

      {facets && facets.categories.length > 0 && (
        <section className="sp-sec"><div className="sp-sec-h"><h3>{t('home.categories')}</h3></div>
          <div className="sp-hscroll sp-cats">
            {facets.categories.map((c) => (
              <button key={c.code} type="button" className="sp-cat" onClick={() => browse({ category: c.code })}>
                <span className="sp-cat-img"><ProductImage src={c.image_url} alt="" /></span>
                <span className="sp-cat-name">{categoryName(c, lang)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {data && rail(t('home.featured'), data.featured, 'recommended')}
      {data && rail(t('home.new'), data.newest, 'newest')}
      {data && rail(t('home.popular'), data.popular, 'recommended')}
      {nothing && <Empty title={t('cat.empty')} />}
      {data && !nothing && <button type="button" className="btn block" onClick={() => browse({})}>{t('home.allProducts')}</button>}
    </div>
  );
}
