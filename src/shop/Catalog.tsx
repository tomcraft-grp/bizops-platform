// The product catalogue (the "shop" tab): search, category / brand / sort, paged product list, and the product page.
// Products come from the database through shop_catalog: only active, customer-facing SKUs ever reach this screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PackageSearch, Search, X } from 'lucide-react';
import { Banner, Empty } from '../ui/kit';
import { cx } from '../lib/util';
import { CatalogPage, NO_BRAND, ShopItem, SortKey, shop } from './api';
import { EMPTY_FILTER, useShopNav } from './nav';
import { useDebounced, useSettings } from './hooks';
import { useShopLang, useT } from './i18n';
import { categoryName, ErrorBox, errText, GridSkeleton, ProductCard, useCategoryLabel, useFacets } from './ui';
import { ProductDetail } from './ProductDetail';

const PAGE = 24;
const SORTS: SortKey[] = ['recommended', 'newest', 'price_asc', 'price_desc', 'name'];

/** The "shop" tab. `preview` is the designer's read-only view: no buying controls. */
export function CatalogCore({ preview = false }: { preview?: boolean }) {
  const nav = useShopNav();
  // peek (a pure read) for the first render, then consume in an effect: an initializer must not have side effects (StrictMode runs it twice)
  const [sku, setSku] = useState<string | null>(() => useShopNav.getState().pendingSku);
  useEffect(() => { if (nav.pendingSku) { const s = useShopNav.getState().takeSku(); if (s) setSku(s); } }, [nav.pendingSku]);
  return sku && !preview ? <ProductDetail sku={sku} onBack={() => setSku(null)} onOpen={setSku} /> : <CatalogList onOpen={setSku} preview={preview} />;
}

function useCatalog(f: { q: string; category: string; brand: string; sort: SortKey }) {
  const [st, setSt] = useState<{ items: ShopItem[]; total: number; loading: boolean; error: unknown }>({ items: [], total: 0, loading: true, error: null });
  const req = useRef(0);
  const q = useDebounced(f.q, 300);
  const load = useCallback((offset: number) => {
    const id = ++req.current;
    setSt((s) => ({ ...s, loading: true, error: null, ...(offset === 0 ? {} : {}) }));
    shop.catalog({ search: q, category: f.category, brand: f.brand, sort: f.sort, limit: PAGE, offset })
      .then((r: CatalogPage) => { if (id === req.current) setSt((s) => ({ items: offset === 0 ? r.items : [...s.items, ...r.items], total: r.total, loading: false, error: null })); })
      .catch((error) => { if (id === req.current) setSt((s) => ({ ...s, loading: false, error })); });
  }, [q, f.category, f.brand, f.sort]);
  useEffect(() => { load(0); }, [load]);
  return { ...st, loadMore: () => load(st.items.length), reload: () => load(0) };
}

function CatalogList({ onOpen, preview }: { onOpen: (sku: string) => void; preview: boolean }) {
  const t = useT();
  const lang = useShopLang();
  const settings = useSettings();
  const filter = useShopNav((s) => s.catalog);
  const setFilter = useShopNav((s) => s.setCatalog);
  const { facets } = useFacets();
  const label = useCategoryLabel(facets);
  const { items, total, loading, error, loadMore, reload } = useCatalog(filter);
  const filtered = !!(filter.q || filter.category || filter.brand);
  const noBrand = facets?.no_brand_count ?? 0;      // 0 on a database without the "no brand" filter: the choice is not offered
  const closed = settings && !settings.shop_open;

  return (
    <div className="sp-page">
      {closed && !preview && <Banner tone="warn">{settings?.closed_message || t('shop.closed')}</Banner>}
      <div className="sp-search">
        <Search size={17} aria-hidden />
        <input type="search" inputMode="search" value={filter.q} placeholder={t('cat.search')} aria-label={t('cat.search')} maxLength={80} onChange={(e) => setFilter({ q: e.target.value })} />
        {filter.q && <button type="button" aria-label={t('cat.clear')} onClick={() => setFilter({ q: '' })}><X size={16} /></button>}
      </div>
      {facets && facets.categories.length > 0 && (
        <div className="sp-chips" role="tablist" aria-label={t('p.category')}>
          <button type="button" role="tab" aria-selected={!filter.category} className={cx(!filter.category && 'on')} onClick={() => setFilter({ category: '' })}>{t('common.all')}</button>
          {facets.categories.map((c) => <button key={c.code} type="button" role="tab" aria-selected={filter.category === c.code} className={cx(filter.category === c.code && 'on')} onClick={() => setFilter({ category: c.code })}>{categoryName(c, lang)}</button>)}
        </div>
      )}
      <div className="sp-filters">
        {facets && (facets.brands.length > 1 || (noBrand > 0 && facets.brands.length > 0)) && (
          <select aria-label={t('cat.brand')} value={filter.brand} onChange={(e) => setFilter({ brand: e.target.value })}>
            <option value="">{t('cat.allBrands')}</option>
            {facets.brands.map((b) => <option key={b.brand} value={b.brand}>{b.brand} ({b.count})</option>)}
            {/* products with no brand (e.g. the kratom drinks) could never be found through this list before (FB-001018) */}
            {noBrand > 0 && <option value={NO_BRAND}>{t('cat.noBrand')} ({noBrand})</option>}
          </select>
        )}
        <select aria-label={t('cat.sort')} value={filter.sort} onChange={(e) => setFilter({ sort: e.target.value as SortKey })}>
          {SORTS.map((s) => <option key={s} value={s}>{t(`sort.${s}` as const)}</option>)}
        </select>
      </div>
      {!error && !(loading && !items.length) && items.length > 0 && <div className="sp-count" aria-live="polite">{t('cat.count', { n: total.toLocaleString('en-US') })}</div>}

      {error ? <ErrorBox message={`${t('common.loadError')} · ${errText(t, error)}`} onRetry={reload} />
        : loading && !items.length ? <GridSkeleton />
          : !items.length ? <Empty icon={<PackageSearch size={28} />} title={filtered ? t('cat.none') : t('cat.empty')} hint={filtered ? t('cat.noneHint') : undefined}
              action={filtered ? <button type="button" className="btn" onClick={() => useShopNav.setState({ catalog: EMPTY_FILTER })}>{t('cat.clear')}</button> : undefined} />
            : <div className="sp-grid">{items.map((it) => <ProductCard key={it.sku_code} item={it} onOpen={onOpen} categoryLabel={label(it.category)} orderable={!preview && !closed} />)}</div>}
      {!error && items.length > 0 && items.length < total && <button type="button" className="btn block sp-more" disabled={loading} onClick={loadMore}>{loading ? '…' : t('common.loadMore')}</button>}
    </div>
  );
}
