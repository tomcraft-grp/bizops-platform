// The orders tab: my orders (with the same chips as the reference app: all / to pay / to ship / to receive / completed),
// and one order with its progress, items, delivery details and the payment panel. Payment status is read from the finance
// ledger through the server; nothing here can change it (a slip is only evidence, staff verification records the payment).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, ClipboardList, RefreshCw } from 'lucide-react';
import { toast } from '../domain/store';
import { CustomerInvoices, InvoiceCard } from '../finance/CustomerInvoices';
import { cx } from '../lib/util';
import { Empty } from '../ui/kit';
import { OrderFilter, OrdersPage, ShopError, ShopOrder, shop } from './api';
import { baht } from './format';
import { shopDate, shopDateTime } from './format';
import { K, useShopLang, useT } from './i18n';
import { useShopHost, useShopNav } from './nav';
import { ConfirmSheet, ErrorBox, errText, OrderBadge, orderSteps, PayBadge, ProductImage } from './ui';

const FILTERS: OrderFilter[] = ['all', 'unpaid', 'to_ship', 'to_receive', 'done', 'cancelled'];
const PAGE = 20;

export function OrdersCore() {
  const nav = useShopNav();
  // peek (a pure read) for the first render, then consume in an effect: an initializer must not have side effects (StrictMode runs it twice)
  const [openId, setOpenId] = useState<string | null>(() => useShopNav.getState().pendingOrder);
  useEffect(() => { if (nav.pendingOrder) { const id = useShopNav.getState().takeOrder(); if (id) setOpenId(id); } }, [nav.pendingOrder]);
  return openId ? <OrderDetail id={openId} onBack={() => setOpenId(null)} /> : <OrderList onOpen={setOpenId} />;
}

function OrderList({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const lang = useShopLang();
  const host = useShopHost();
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [st, setSt] = useState<{ orders: ShopOrder[]; total: number; loading: boolean; error: unknown }>({ orders: [], total: 0, loading: true, error: null });
  const req = useRef(0);
  const load = useCallback((offset: number) => {
    const id = ++req.current;
    setSt((s) => ({ ...s, loading: true, error: null }));
    shop.myOrders(filter, PAGE, offset)
      .then((r: OrdersPage) => { if (id === req.current) setSt((s) => ({ orders: offset === 0 ? r.orders : [...s.orders, ...r.orders], total: r.total, loading: false, error: null })); })
      .catch((error) => { if (id === req.current) setSt((s) => ({ ...s, loading: false, error })); });
  }, [filter]);
  useEffect(() => { load(0); }, [load]);

  return (
    <div className="sp-page">
      <h2 className="sp-h2">{t('ord.title')}</h2>
      <div className="sp-chips" role="tablist">
        {FILTERS.map((f) => <button key={f} type="button" role="tab" aria-selected={filter === f} className={cx(filter === f && 'on')} onClick={() => setFilter(f)}>{t(`ord.f.${f}` as K)}</button>)}
      </div>
      {st.error ? <ErrorBox message={`${t('common.loadError')} · ${errText(t, st.error)}`} onRetry={() => load(0)} />
        : st.loading && !st.orders.length ? <div className="sp-list-skel" aria-busy="true"><i /><i /><i /></div>
          : !st.orders.length ? (filter === 'all'
            ? <Empty icon={<ClipboardList size={28} />} title={t('ord.empty')} hint={t('ord.emptyHint')} action={<button type="button" className="btn primary" onClick={() => host.goTab('shop')}>{t('ord.start')}</button>} />
            : <Empty icon={<ClipboardList size={28} />} title={t('ord.emptyFilter')} />)
            : <ul className="sp-orders">{st.orders.map((o) => (
              <li key={o.id}>
                <button type="button" className="sp-order" onClick={() => onOpen(o.id)}>
                  <div className="row between"><b>{o.order_no}</b><OrderBadge status={o.status} /></div>
                  <div className="sp-order-items">
                    <div className="sp-thumbs-row">{o.items.slice(0, 3).map((i) => <ProductImage key={i.line_no} src={i.image_url} alt={i.name} />)}</div>
                    <div className="grow"><span className="sp-clamp">{o.items[0]?.name}</span><small>{o.items.length > 1 ? `+${o.items.length - 1} · ` : ''}{t('ord.n', { n: o.items.reduce((s, i) => s + i.qty, 0) })} · {shopDate(o.created_at, lang)}</small></div>
                    <ChevronRight size={18} aria-hidden />
                  </div>
                  <div className="row between"><PayBadge code={o.invoice.status_code} /><b>{baht(o.total)}</b></div>
                </button>
              </li>))}</ul>}
      {!st.error && st.orders.length > 0 && st.orders.length < st.total && <button type="button" className="btn block sp-more" disabled={st.loading} onClick={() => load(st.orders.length)}>{st.loading ? '…' : t('common.loadMore')}</button>}
      {/* invoices the shop issued by hand (not for a shop order) keep their own payment cards here */}
      {(filter === 'all' || filter === 'unpaid') && <CustomerInvoices lang={lang} hide={(r) => r.source_ref?.startsWith('SO-') ?? false} />}
    </div>
  );
}

function OrderDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT();
  const lang = useShopLang();
  const [o, setO] = useState<ShopOrder | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);   // set on mount too: StrictMode mounts, unmounts and mounts again

  const load = useCallback(async () => {
    try { const r = await shop.myOrder(id); if (alive.current) { setO(r); setError(null); } }
    catch (e) { if (alive.current) { if (e instanceof ShopError && e.code === 'FORBIDDEN') setO(null); else setError(e); } }
  }, [id]);
  useEffect(() => { setO(undefined); void load(); }, [load]);
  // the shop verifies payments and moves the order along while the customer has the page open: look again on return / every minute
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', vis);
    const h = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => { document.removeEventListener('visibilitychange', vis); clearInterval(h); };
  }, [load]);

  const back = <button type="button" className="sp-back" onClick={onBack}><ArrowLeft size={18} /> {t('common.back')}</button>;
  if (error && !o) return <div className="sp-page">{back}<ErrorBox message={`${t('common.loadError')} · ${errText(t, error)}`} onRetry={() => void load()} /></div>;
  if (o === undefined) return <div className="sp-page">{back}<div className="sp-list-skel" aria-busy="true"><i /><i /><i /></div></div>;
  if (o === null) return <div className="sp-page">{back}<Empty title={t('od.notFound')} /></div>;

  const code = o.invoice.status_code;
  const canCancel = o.status === 'new' && [0, 1, 7, 9].includes(code);
  const steps = orderSteps(o.fulfilment);
  const at = steps.indexOf(o.status);
  const cancel = async () => {
    setBusy(true);
    try { const r = await shop.cancelMyOrder(o.id); setO(r); toast('success', t('od.cancelled')); setAsking(false); }
    catch (e) {
      setAsking(false);
      const c = e instanceof ShopError ? e.message : '';
      toast('error', ['PAYMENT_RECORDED', 'SLIP_PENDING', 'ORDER_IN_PROGRESS'].includes(c) ? t(`od.err.${c}` as K) : errText(t, e));
      void load();
    } finally { setBusy(false); }
  };

  return (
    <div className="sp-page sp-order-detail">
      {back}
      <div className="row between"><div><h2 className="sp-h2" style={{ margin: 0 }}>{o.order_no}</h2><small className="muted">{shopDateTime(o.created_at, lang)}</small></div><button type="button" className="sp-iconbtn" aria-label={t('od.refresh')} onClick={() => void load()}><RefreshCw size={17} /></button></div>
      <div className="row gap-6 wrap"><OrderBadge status={o.status} /><PayBadge code={code} /></div>
      {o.status === 'cancelled' && <div className="sp-note bad">{t('st.cancelled')}{o.cancel_reason ? ` · ${t('od.cancelReason')}: ${o.cancel_reason}` : ''}</div>}
      {o.status_note && <section className="sp-sec"><h3>{t('od.shopNote')}</h3><p className="sp-text">{o.status_note}</p></section>}

      {o.status !== 'cancelled' && o.status !== 'returned' && (
        <section className="sp-sec"><h3>{t('od.progress')}</h3>
          <ol className="sp-steps">{steps.map((s, i) => <li key={s} className={cx(i < at && 'done', i === at && 'now')}><span aria-hidden>{i < at ? '✓' : i + 1}</span>{t(`st.${s}` as K)}</li>)}</ol>
        </section>
      )}

      <section className="sp-sec"><h3>{t('od.payment')}</h3>
        <InvoiceCard inv={o.invoice} lang={lang} defaultOpen={[0, 1, 7, 9].includes(code) && o.status !== 'cancelled'} onChanged={() => void load()} />
      </section>

      <section className="sp-sec"><h3>{t('od.items')}</h3>
        <ul className="sp-mini">{o.items.map((i) => <li key={i.line_no}><ProductImage src={i.image_url} alt={i.name} /><span className="grow">{i.name}<small> {baht(i.unit_price)} × {i.qty}</small></span><b>{baht(i.line_total)}</b></li>)}</ul>
        <div className="sp-summary flat">
          <div className="row between"><span>{t('od.subtotal')}</span><span>{baht(o.subtotal)}</span></div>
          {o.discount > 0 && <div className="row between good"><span>{t('cart.discount')}</span><span>−{baht(o.discount)}</span></div>}
          <div className="row between"><span>{t('cart.shipping')}</span><span>{o.shipping_fee > 0 ? baht(o.shipping_fee) : t('cart.free')}</span></div>
          <div className="row between sp-total"><b>{t('ord.total')}</b><b>{baht(o.total)}</b></div>
        </div>
      </section>

      <section className="sp-sec"><h3>{o.fulfilment === 'pickup' ? t('od.pickup') : t('od.delivery')}</h3>
        <div className="sp-kv"><span>{o.contact_name}</span><span>{o.contact_phone}</span></div>
        {o.delivery_address && <p className="sp-text">{o.delivery_address}</p>}
        {o.note && <p className="sp-note">{t('od.note')}: {o.note}</p>}
      </section>

      {canCancel && <button type="button" className="btn block danger-outline" onClick={() => setAsking(true)}>{t('od.cancel')}</button>}
      {asking && <ConfirmSheet danger title={t('od.cancelTitle')} body={t('od.cancelBody')} confirmLabel={t('od.confirmYes')} cancelLabel={t('common.cancel')} busy={busy} onConfirm={cancel} onCancel={() => setAsking(false)} />}
    </div>
  );
}
