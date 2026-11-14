// One product: pictures, names (Thai / English), price, size, availability, options (same family), quantity and Add to cart.
// Everything shown comes from shop_product; nothing is invented (no description or spec appears unless staff entered it).
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Empty } from '../ui/kit';
import { cx } from '../lib/util';
import { ShopProduct, shop } from './api';
import { MAX_QTY, useCart } from './cart';
import { baht, packLabel } from './format';
import { useShopLang, useT } from './i18n';
import { useShopHost } from './nav';
import { useSettings } from './hooks';
import { ErrorBox, errText, itemDescription, ProductCard, ProductImage, Stepper, useAddToCart, useCategoryLabel, useFacets } from './ui';

export function ProductDetail({ sku, onBack, onOpen }: { sku: string; onBack: () => void; onOpen: (sku: string) => void }) {
  const t = useT();
  const lang = useShopLang();
  const host = useShopHost();
  const settings = useSettings();
  const { facets } = useFacets();
  const label = useCategoryLabel(facets);
  const [p, setP] = useState<ShopProduct | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [pic, setPic] = useState(0);
  const [qty, setQty] = useState(1);
  const [n, setN] = useState(0);
  const inCart = useCart((s) => s.lines.find((l) => l.sku === sku)?.qty ?? 0);
  const add = useAddToCart();

  useEffect(() => {
    let on = true;
    setP(undefined); setError(null); setPic(0); setQty(1);
    shop.product(sku).then((r) => { if (on) setP(r); }).catch((e) => { if (on) setError(e); });
    return () => { on = false; };
  }, [sku, n]);

  const back = <button type="button" className="sp-back" onClick={onBack}><ArrowLeft size={18} /> {t('common.back')}</button>;
  if (error) return <div className="sp-page">{back}<ErrorBox message={`${t('common.loadError')} · ${errText(t, error)}`} onRetry={() => setN((x) => x + 1)} /></div>;
  if (p === undefined) return <div className="sp-page">{back}<div className="sp-detail-skel" aria-busy="true"><div className="sp-pic" /><i /><i /><i style={{ width: '50%' }} /></div></div>;
  if (p === null) return <div className="sp-page">{back}<Empty title={t('p.gone')} /></div>;

  const closed = !!settings && !settings.shop_open;
  const max = Math.min(p.max_qty ?? MAX_QTY, MAX_QTY);
  const size = packLabel(p.pack_qty, p.unit);
  const desc = itemDescription(p, lang);
  const pics = p.image_urls.length ? p.image_urls : [null];
  const buy = (go: boolean) => { add(p, qty); if (go) host.goTab('cart'); };

  return (
    <div className="sp-page sp-detail">
      {back}
      <div className="sp-gallery">
        <div className="sp-gallery-main"><ProductImage src={pics[Math.min(pic, pics.length - 1)]} alt={p.name} />{p.badge && <span className="sp-badge">{p.badge}</span>}{!p.available && <span className="sp-soldtag">{t('p.soldOut')}</span>}</div>
        {pics.length > 1 && <div className="sp-thumbs">{pics.map((u, i) => <button key={i} type="button" className={cx(i === pic && 'on')} aria-label={`${i + 1}/${pics.length}`} onClick={() => setPic(i)}><ProductImage src={u} alt="" /></button>)}</div>}
      </div>

      <div className="sp-info">
        <div className="sp-sku">{t('p.sku')} {p.sku_code}</div>
        <h2 className="sp-title">{p.name}</h2>
        {(p.name_th || p.name_en) && <div className="sp-names">{p.name_th && <div><span>{t('p.nameTh')}</span>{p.name_th}</div>}{p.name_en && <div><span>{t('p.nameEn')}</span>{p.name_en}</div>}</div>}
        <div className="sp-price big">{baht(p.price)}<small> / {t('p.unit')}</small></div>
        <div className="sp-avail" data-ok={p.available}>{p.available ? t('p.available') : t('p.soldOut')}{p.available && p.max_qty ? ` · ${t('p.maxPer', { n: p.max_qty })}` : ''}</div>
        <dl className="sp-facts">
          <div><dt>{t('p.category')}</dt><dd>{label(p.category)}</dd></div>
          {p.brand && <div><dt>{t('p.brand')}</dt><dd>{p.brand}</dd></div>}
          {size && <div><dt>{t('p.size')}</dt><dd>{size}</dd></div>}
        </dl>

        {p.siblings.length > 0 && (
          <div className="sp-options">
            <b>{t('p.options')}</b>
            <div className="sp-chips wrap">
              <button type="button" className="on" aria-pressed="true">{p.name_th || p.name_en || p.name}</button>
              {p.siblings.map((s) => <button key={s.sku_code} type="button" className={cx(!s.available && 'off')} aria-pressed="false" onClick={() => onOpen(s.sku_code)}>{s.name_th || s.name_en || s.name}{!s.available ? ` · ${t('p.soldOut')}` : ''}</button>)}
            </div>
          </div>
        )}

        {!closed && p.available && (
          <div className="sp-buy">
            <div className="sp-buy-row"><span>{t('p.qty')}</span><Stepper value={qty} min={1} max={max} onChange={setQty} /></div>
            {inCart > 0 && <div className="sp-note">{t('p.inCart', { n: inCart })}</div>}
            <div className="sp-buy-btns">
              <button type="button" className="btn lg" onClick={() => buy(false)}>{t('p.add')}</button>
              <button type="button" className="btn primary lg" onClick={() => buy(true)}>{t('p.buyNow')}</button>
            </div>
          </div>
        )}
        {desc && <section className="sp-sec"><h3>{t('p.desc')}</h3><p className="sp-text">{desc}</p></section>}
        {p.specs.length > 0 && <section className="sp-sec"><h3>{t('p.specs')}</h3><table className="sp-specs"><tbody>{p.specs.map((s, i) => <tr key={i}><th>{s.label}</th><td>{s.value}</td></tr>)}</tbody></table></section>}
      </div>

      {p.related.length > 0 && (
        <section className="sp-sec"><h3>{t('p.related')}</h3>
          <div className="sp-hscroll">{p.related.map((r) => <div key={r.sku_code} className="sp-hitem"><ProductCard item={r} onOpen={onOpen} categoryLabel={label(r.category)} orderable={!closed} /></div>)}</div>
        </section>
      )}
    </div>
  );
}
