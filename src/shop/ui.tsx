// Small shared pieces of the customer shop: product picture with fallback, quantity stepper, product card, status badges,
// error text. Text is always rendered as text (React escapes it); pictures come only from https URLs the server returns.
import './shop.css';
import { ReactNode, useEffect, useState } from 'react';
import { AlertTriangle, Minus, Package, Plus, RefreshCw } from 'lucide-react';
import { toast } from '../domain/store';
import { cx } from '../lib/util';
import type { StatusCode } from '../finance/api';
import { CategoryFacet, Facets, OrderStatus, shop, ShopError, ShopItem } from './api';
import { MAX_QTY, useCart } from './cart';
import { baht, packLabel } from './format';
import { K, ShopLang, useShopLang, useT } from './i18n';

export function ProductImage({ src, alt, className }: { src?: string | null; alt: string; className?: string }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  const ok = !!src && /^https:\/\//.test(src) && !bad;
  return ok
    ? <img className={cx('sp-pic', className)} src={src!} alt={alt} loading="lazy" decoding="async" onError={() => setBad(true)} />
    : <div className={cx('sp-pic sp-pic-ph', className)} {...(alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': true })}><Package size={32} strokeWidth={1.5} /></div>;
}

export function Stepper({ value, min = 0, max = MAX_QTY, onChange, size = 'md' }: { value: number; min?: number; max?: number; onChange: (n: number) => void; size?: 'sm' | 'md' }) {
  const t = useT();
  const cap = Math.min(max, MAX_QTY);
  return (
    <div className={cx('sp-step', size === 'sm' && 'sm')}>
      <button type="button" aria-label={t('p.minus')} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={size === 'sm' ? 14 : 16} /></button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label={t('p.plus')} disabled={value >= cap} onClick={() => onChange(value + 1)}><Plus size={size === 'sm' ? 14 : 16} /></button>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="sp-error" role="alert">
      <AlertTriangle size={20} /><span>{message}</span>
      {onRetry && <button type="button" className="btn sm" onClick={onRetry}><RefreshCw size={13} /> {t('common.retry')}</button>}
    </div>
  );
}

export function GridSkeleton({ n = 6 }: { n?: number }) {
  return <div className="sp-grid" aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} className="sp-card sp-skel"><div className="sp-pic" /><div className="sp-body"><i /><i /><i style={{ width: '40%' }} /></div></div>)}</div>;
}

/** User-facing text for a failed call (never the raw database message). */
export function errText(t: ReturnType<typeof useT>, e: unknown): string {
  if (!(e instanceof ShopError)) return t('err.generic');
  switch (e.code) {
    case 'SHOP_CLOSED': return t('err.closed');
    case 'NO_PAYMENT_ACCOUNT': return t('err.noAccount');
    case 'PRICE_CHANGED': return t('err.priceChanged');
    case 'CART_INVALID': case 'CART_EMPTY': case 'CART_TOO_LARGE': return t('err.cartInvalid');
    case 'TOO_MANY_ORDERS': return t('err.tooMany');
    case 'NETWORK': return t('err.network');
    case 'INVALID_PHONE': return t('err.phone');
    case 'INVALID_ADDRESS': return t('err.address');
    case 'SLIP_REQUIRED': return t('err.slipRequired');
    case 'SLIP_ALREADY_USED': return t('err.slipUsed');
    case 'BAD_FILE': case 'BAD_FILE_TYPE': return t('err.slipBad');
    case 'FILE_TOO_BIG': return t('err.slipBig');
    case 'UPLOAD_FAILED': return t('err.slipUpload');
    case 'INVALID_PAYMENT_METHOD': return t('err.method');
    case 'INVALID_NAME': return t('err.name');
    case 'FORBIDDEN': return t('err.signin');
    default: return t('err.generic');
  }
}

// ---------------------------------------------------------------- categories (names come from the database)
export function useFacets(): { facets: Facets | null; error: boolean; reload: () => void } {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [error, setError] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    shop.facets().then((f) => { if (on) { setFacets(f); setError(false); } }).catch(() => { if (on) setError(true); });
    return () => { on = false; };
  }, [n]);
  return { facets, error, reload: () => setN((x) => x + 1) };
}
export const categoryName = (c: Pick<CategoryFacet, 'code' | 'name_th' | 'name_en'>, lang: ShopLang): string =>
  (lang === 'en' ? c.name_en || c.name_th : c.name_th || c.name_en) || c.code;
export function useCategoryLabel(facets: Facets | null): (code: string) => string {
  const lang = useShopLang();
  return (code) => { const c = facets?.categories.find((x) => x.code === code); return c ? categoryName(c, lang) : code; };
}

// ---------------------------------------------------------------- cart actions
export function useAddToCart() {
  const t = useT();
  const add = useCart((s) => s.add);
  return (it: ShopItem, qty = 1) => {
    if (!it.available) return;
    add({ sku_code: it.sku_code, name: it.name, price: it.price, image_url: it.image_url, max_qty: it.max_qty }, qty);
    toast('success', t('p.added'));
  };
}

export const itemDescription = (it: ShopItem, lang: ShopLang): string => ((lang === 'en' ? it.description_en || it.description_th : it.description_th || it.description_en) ?? '').trim();

export function ProductCard({ item, onOpen, categoryLabel, orderable = true }: { item: ShopItem; onOpen: (sku: string) => void; categoryLabel: string; orderable?: boolean }) {
  const t = useT();
  const lang = useShopLang();
  const line = useCart((s) => s.lines.find((l) => l.sku === item.sku_code));
  const setQty = useCart((s) => s.setQty);
  const add = useAddToCart();
  const desc = itemDescription(item, lang);
  const size = packLabel(item.pack_qty, item.unit);
  return (
    <article className={cx('sp-card', !item.available && 'sold')} data-sku={item.sku_code}>
      <button type="button" className="sp-imgbtn" onClick={() => onOpen(item.sku_code)} aria-label={`${t('p.details')}: ${item.name}`}>
        <ProductImage src={item.image_url} alt={item.name} />
        {item.badge && <span className="sp-badge">{item.badge}</span>}
        {!item.available && <span className="sp-soldtag">{t('p.soldOut')}</span>}
      </button>
      <div className="sp-body">
        <div className="sp-sku">{item.sku_code}</div>
        <button type="button" className="sp-name" onClick={() => onOpen(item.sku_code)}>{item.name}</button>
        <div className="sp-meta">{categoryLabel}{size ? ` · ${size}` : ''}</div>
        {desc && <p className="sp-desc">{desc}</p>}
        <div className="sp-price">{baht(item.price)}<small> / {t('p.unit')}</small></div>
        <div className="sp-avail" data-ok={item.available}>{item.available ? t('p.available') : t('p.soldOut')}</div>
        <div className="sp-actions">
          <button type="button" className="btn sm" onClick={() => onOpen(item.sku_code)}>{t('p.details')}</button>
          {!orderable ? null : !item.available ? <button type="button" className="btn sm" disabled>{t('p.soldOut')}</button>
            : line ? <Stepper size="sm" value={line.qty} min={0} max={item.max_qty ?? MAX_QTY} onChange={(n) => setQty(item.sku_code, n)} />
              : <button type="button" className="btn primary sm" onClick={() => add(item)}>{t('p.add')}</button>}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- statuses
export const PAY_LABEL: Record<StatusCode, { k: K; tone: 'good' | 'warn' | 'bad' | 'info' | '' }> = {
  0: { k: 'pay.unpaid', tone: 'warn' }, 1: { k: 'pay.unpaid', tone: 'warn' }, 9: { k: 'pay.unpaid', tone: 'warn' },
  3: { k: 'pay.pending', tone: 'info' }, 4: { k: 'pay.partial', tone: 'warn' }, 5: { k: 'pay.paid', tone: 'good' },
  6: { k: 'pay.review', tone: 'info' }, 7: { k: 'pay.rejected', tone: 'bad' }, 8: { k: 'pay.cancelled', tone: '' },
};
export function PayBadge({ code }: { code: StatusCode }) {
  const t = useT();
  const p = PAY_LABEL[code] ?? PAY_LABEL[0];
  return <span className={cx('sp-pill', p.tone)}>{t(p.k)}</span>;
}
export const ORDER_TONE: Record<OrderStatus, 'good' | 'warn' | 'bad' | 'info' | ''> = {
  new: 'info', confirmed: 'info', preparing: 'info', packed: 'info', ready: 'good', shipped: 'good', completed: 'good', cancelled: '', returned: 'bad',
};
export function OrderBadge({ status }: { status: OrderStatus }) {
  const t = useT();
  return <span className={cx('sp-pill', ORDER_TONE[status])}>{t(`st.${status}` as K)}</span>;
}
export const orderSteps = (f: 'delivery' | 'pickup'): OrderStatus[] => (f === 'pickup' ? ['new', 'confirmed', 'preparing', 'packed', 'ready', 'completed'] : ['new', 'confirmed', 'preparing', 'packed', 'shipped', 'completed']);

export function Section({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <section className="sp-sec"><div className="sp-sec-h"><h3>{title}</h3>{action}</div>{children}</section>;
}

/** A small confirmation sheet in the shop's own language and theme (the staff app's confirm dialog is bilingual by staff setting). */
export function ConfirmSheet({ title, body, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel }: {
  title: string; body?: ReactNode; confirmLabel: string; cancelLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  return (
    <div className="sp-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="sp-sheet-card">
        <h3>{title}</h3>
        {body && <div className="sp-sheet-body">{body}</div>}
        <div className="sp-sheet-btns">
          <button type="button" className="btn lg" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={cx('btn lg', danger ? 'danger' : 'primary')} onClick={onConfirm} disabled={busy}>{busy ? '…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
