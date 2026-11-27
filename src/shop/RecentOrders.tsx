// "Recent orders" (FB-001002): the customer's last few orders on the Home tab and on an empty cart, each one tap from its detail page, with "Order again" for a finished order.
// The data is the customer's own list (shop_my_orders: the database only ever returns the signed-in customer's orders); nothing here can change an order.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from '../domain/store';
import { shop, type ShopOrder } from './api';
import { useCart } from './cart';
import { baht, shopDate } from './format';
import { useShopLang, useT } from './i18n';
import { useShopHost, useShopNav } from './nav';
import { newestFirst, RECENT_COUNT, recentAction, reorderPlan } from './orderAgain';
import { ErrorBox, errText, OrderBadge, PayBadge, ProductImage } from './ui';

export function RecentOrders({ title = true }: { title?: boolean }) {
  const t = useT();
  const lang = useShopLang();
  const host = useShopHost();
  const [st, setSt] = useState<{ orders: ShopOrder[] | null; error: unknown }>({ orders: null, error: null });
  const req = useRef(0);
  const load = useCallback(() => {
    const id = ++req.current;                                                          // an answer for an older request must not replace a newer one
    shop.myOrders('all', RECENT_COUNT, 0)
      .then((r) => { if (id === req.current) setSt({ orders: newestFirst(r.orders).slice(0, RECENT_COUNT), error: null }); })
      .catch((error) => { if (id === req.current) setSt((s) => ({ orders: s.orders, error })); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {                                                                    // the shop moves orders along while the customer is away: look again on return
    const vis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [load]);

  const open = (o: ShopOrder) => { useShopNav.getState().openOrder(o.id); host.goTab('pay'); };
  const again = (o: ShopOrder) => {
    const plan = reorderPlan(o.items);
    const added = plan.ok.length ? useCart.getState().reorder(plan.ok) : 0;            // merged into what is already in the cart; the cart page re-checks every price
    if (!added) { toast('error', t('od.againNone')); return; }
    toast('success', plan.skipped ? t('ro.addedSome', { n: added, skipped: plan.skipped }) : t('od.againDone'));
    host.goTab('cart');
  };

  return (
    <section className="sp-sec" data-testid="recent-orders">
      {title && <div className="sp-sec-h"><h3>{t('ro.title')}</h3>{st.orders && st.orders.length > 0 && <button type="button" className="sp-link" onClick={() => host.goTab('pay')}>{t('ro.all')} <ChevronRight size={14} /></button>}</div>}
      {st.error != null && !st.orders ? <ErrorBox message={`${t('ro.error')} · ${errText(t, st.error)}`} onRetry={load} />
        : !st.orders ? <div className="sp-list-skel" aria-busy="true" data-testid="recent-loading"><i /><i /></div>
          : !st.orders.length ? <p className="sp-note" data-testid="recent-empty">{t('ro.empty')}</p>
            : (
              <>
                <ul className="sp-orders">{st.orders.map((o) => {
                  const act = recentAction(o);
                  const qty = o.items.reduce((s, i) => s + i.qty, 0);
                  return (
                    <li key={o.id} data-testid="recent-order" data-order={o.order_no}>
                      <div className="sp-order">
                        <button type="button" className="sp-order-open" onClick={() => open(o)} aria-label={`${t('ro.view')} ${o.order_no}`}>
                          <div className="row between"><b>{o.order_no}</b><OrderBadge status={o.status} /></div>
                          <div className="sp-order-items">
                            <div className="sp-thumbs-row">{o.items.slice(0, 3).map((i) => <ProductImage key={i.line_no} src={i.image_url} alt={i.name} />)}</div>
                            <div className="grow"><span className="sp-clamp">{o.items[0]?.name}</span><small>{o.items.length > 1 ? `+${o.items.length - 1} · ` : ''}{t('ord.n', { n: qty })} · {shopDate(o.created_at, lang)}</small></div>
                          </div>
                          <div className="row between" style={{ gap: 8 }}><PayBadge code={o.invoice.status_code} /><b>{baht(o.total)}</b></div>
                        </button>
                        <button type="button" className={act === 'view' ? 'btn block' : 'btn primary block'} data-testid={`recent-${act}`} onClick={() => (act === 'again' ? again(o) : open(o))}>
                          {act === 'again' && <RefreshCw size={14} aria-hidden />} {t(act === 'again' ? 'ro.again' : act === 'pay' ? 'ro.pay' : 'ro.view')}
                        </button>
                      </div>
                    </li>
                  );
                })}</ul>
              </>
            )}
    </section>
  );
}
