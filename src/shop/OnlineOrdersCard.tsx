// FB-001013: orders placed in the online shop (the LINE app) are stored in Supabase, not in the order list the Orders page reads, so they never showed up there.
// This read-only card brings the latest ones onto that page. It changes nothing: moving an order along and checking its payment stay on the Online shop page
// and the Payment review page, where the rules live.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DEMO_SEED } from '../domain/demo';
import { STATUS_LABEL } from '../domain/meta';
import { useLang } from '../domain/store';
import { STATUS as PAY_STATUS } from '../finance/api';
import { t as tl } from '../lib/i18n';
import { dateTimeFmt, money } from '../lib/util';
import { Badge, Banner, Button, Card, Skeleton } from '../ui/kit';
import { AdminOrdersPage, ShopError, shopAdmin } from './api';
import { ORDER_TONE } from './ShopAdmin';

const LATEST = 6;

export function OnlineOrdersCard() {
  const lang = useLang();
  const T = (s: string, v?: Record<string, string | number>) => tl(lang, s, v);
  const [page, setPage] = useState<AdminOrdersPage | null>(null);
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState(false);
  const load = useCallback(() => {
    setError(false);
    shopAdmin.orders({ limit: LATEST })
      .then((p) => { setPage(p); })
      // someone who is not allowed to see the shop's orders just does not get this card; a dropped connection gets a retry button
      .catch((e) => { if (e instanceof ShopError && e.code === 'FORBIDDEN') setHidden(true); else setError(true); });
  }, []);
  useEffect(() => { if (!DEMO_SEED) load(); }, [load]);

  if (DEMO_SEED || hidden) return null;      // the demo business has no online shop
  const fresh = page?.counts.new ?? 0;
  return (
    <Card className="mb16" title="Online shop (LINE app)" sub={page ? (fresh ? T('{n} new order(s) to look at', { n: fresh }) : T('No new orders waiting')) : undefined}
      actions={<Link className="btn sm" to="/shop-admin"><span>{T('Open Online shop')}</span></Link>} flush>
      {error && <div style={{ padding: 12 }}><Banner tone="warn">{T('Could not load the online shop orders.')} <Button size="sm" onClick={load}>{T('Try again')}</Button></Banner></div>}
      {!page && !error && <div style={{ padding: 12 }}><Skeleton h={90} /></div>}
      {page && !page.orders.length && <div className="muted" style={{ padding: 14 }}>{T('No online orders yet')}</div>}
      {page && page.orders.length > 0 && (
        <div className="table-wrap">
          <table className="t"><thead><tr><th>{T('Order')}</th><th>{T('Date')}</th><th>{T('Customer')}</th><th className="r">{T('Total')}</th><th>{T('Payment')}</th><th>{T('Status')}</th></tr></thead>
            <tbody>{page.orders.map((o) => {
              const pay = PAY_STATUS[o.invoice.status_code];
              return (
                <tr key={o.id}>
                  <td><b className="mono">{o.order_no}</b></td><td>{dateTimeFmt(o.created_at)}</td><td>{o.contact_name}<div className="muted">{o.contact_phone}</div></td>
                  <td className="r">{money(o.total)}</td>
                  <td><Badge tone={pay.tone} dot>{lang === 'th' ? pay.th : pay.en}</Badge></td>
                  <td><Badge tone={ORDER_TONE[o.status]}>{T(STATUS_LABEL[o.status])}</Badge></td>
                </tr>
              );
            })}</tbody></table>
        </div>
      )}
      {page && page.total > page.orders.length && <div className="muted" style={{ padding: '8px 14px 12px' }}>{T('Showing the latest {n} of {total} online orders.', { n: page.orders.length, total: page.total })}</div>}
    </Card>
  );
}
