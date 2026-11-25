import { useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardList, Coins, Factory, Info, ListChecks, X } from 'lucide-react';
import { useDB } from '../domain/store';
import { overview } from '../domain/productionAnalysis';
import { Button, Card, Kpi } from '../ui/kit';
import { cx, money, money0, qtyFmt } from '../lib/util';
import { ORDER_CARDS, orderMatches, usableBoms, type OrderView } from './forms';
import { useMay, useT, type Go } from './parts';
import { BomList, NewBomButton } from './BomList';
import { NewOrderButton, OrderTable } from './Orders';

type CardId = OrderView | 'boms';
const CARD: Record<Exclude<CardId, 'all'>, { label: string; icon: ReactNode }> = {
  boms: { label: 'BOMs in use', icon: <ClipboardList size={15} /> }, open: { label: 'Open orders', icon: <ListChecks size={15} /> }, progress: { label: 'In production', icon: <Factory size={15} /> },
  short: { label: 'Orders short of materials', icon: <AlertTriangle size={15} /> }, done: { label: 'Completed orders', icon: <CheckCircle2 size={15} /> }, costed: { label: 'Actual cost of completed orders', icon: <Coins size={15} /> },
};
export function Overview({ go }: { go: Go }) {
  const db = useDB(), T = useT(), may = useMay(), o = useMemo(() => overview(db), [db]);
  const [card, setCard] = useState<CardId>('all'), list = useRef<HTMLDivElement>(null);
  const n = (v: OrderView) => db.productionOrders.filter((x) => orderMatches(db, x, v)).length;
  const num: Record<string, number> = { boms: o.activeBoms, ...Object.fromEntries(ORDER_CARDS.map((v) => [v, n(v)])), costed: n('costed') };
  const pick = (id: CardId) => {
    setCard((c) => (c === id ? 'all' : id));
    if (window.matchMedia('(max-width: 900px)').matches) setTimeout(() => list.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  // a figure without reliable data has no card: no completed order with a known estimate means there is nothing to compare
  const cards: Exclude<CardId, 'all'>[] = ['boms', ...(ORDER_CARDS as Exclude<OrderView, 'all'>[]), ...(may.cost && o.actualCost != null ? ['costed' as const] : [])];
  const sub: Partial<Record<CardId, string>> = { boms: T('{n} in total', { n: o.boms }), done: T('{n} units made so far', { n: qtyFmt(o.outputUnits) }), costed: T('estimated {e}, difference {d}', { e: money(o.estimatedCost), d: `${(o.variance ?? 0) > 0 ? '+' : ''}${money(o.variance)}` }), short: T('materials to buy or transfer'), progress: T('not finished yet'), open: T('from draft to production') };
  const active = cards.includes(card as 'open') ? card : 'all', total = active === 'boms' ? db.boms.length : db.productionOrders.length, shown = active === 'all' ? total : num[active];
  return (
    <div data-testid="tab-overview">
      {(!db.boms.length || !db.productionOrders.length) && <Start go={go} />}
      <div className={cx('grid mfg-cards mb16', cards.length === 6 && 'six')} role="group" aria-label={T('Filter by summary card')} data-testid="prod-cards">
        {cards.map((c) => <Kpi key={c} label={CARD[c].label} icon={CARD[c].icon} value={c === 'costed' ? money0(o.actualCost) : num[c]} tone={c === 'short' && num[c] ? 'bad' : undefined} sub={sub[c]} active={active === c} onClick={() => pick(c)} />)}
      </div>
      <div ref={list} style={{ scrollMarginTop: 70 }}>
        <div className="row between wrap mb8" style={{ gap: 8, minHeight: 30 }} role="status" data-testid="prod-showing">
          <span>{T('Showing')}: <b>{T(active === 'all' ? 'All production orders' : CARD[active].label)}</b> · {active === 'boms' ? T('{n} of {m} BOMs', { n: shown, m: total }) : T('{n} of {m} orders', { n: shown, m: total })}</span>
          {active !== 'all' && <Button size="sm" onClick={() => setCard('all')}><X size={13} /> {T('Show all production orders')}</Button>}
        </div>
        {active === 'boms' ? <BomList go={go} only="active" /> : <OrderTable go={go} view={active} />}
      </div>
      {may.cost && o.completedWithoutEstimate > 0 && <div className="muted mt8">{T('{n} completed orders have no complete estimate (a cost was unknown), so they are not part of the cost figures.', { n: o.completedWithoutEstimate })}</div>}
      <div className="muted mt16 row top" data-testid="device-note"><Info size={15} style={{ flex: 'none', marginTop: 2 }} /><span>{T('BOMs, production orders and stock are kept in this browser on this device. Other devices do not see them. Please make a backup regularly in Settings.')}</span></div>
    </div>
  );
}
/** The way in for a business that has only bought and resold so far: what to do, in order, and what is done already. */
function Start({ go }: { go: Go }) {
  const db = useDB(), T = useT(), may = useMay();
  const stock = Object.values(db.balances).some((b) => b.qty > 0), ready = usableBoms(db).length > 0;
  const steps: { done: boolean; title: string; hint: string; action?: ReactNode }[] = [
    { done: stock, title: 'Put the materials into stock', hint: 'With a quantity and a cost. Products you resell today can be materials too.', action: <Button size="sm" onClick={() => window.location.assign('#/inventory')}>{T('Open inventory')}</Button> },
    { done: ready, title: 'Create a BOM', hint: 'Say what goes into the product and how much, then activate it.', action: may.edit ? <NewBomButton go={go} /> : undefined },
    { done: db.productionOrders.length > 0, title: 'Create a production order', hint: 'Say how many to make and from which warehouse.', action: may.create && ready ? <NewOrderButton go={go} /> : undefined },
    { done: db.productionOrders.some((o) => o.status === 'completed'), title: 'Approve it and record production', hint: 'Materials leave stock, finished goods enter stock, and the accounting entries are posted.' },
  ];
  const now = steps.findIndex((s) => !s.done);
  return (
    <Card className="mb16" title="How to start" sub="Four steps from buying to producing">
      <ol className="mfg-start" data-testid="prod-start">{steps.map((s, i) => (
        <li key={s.title} className={cx(s.done && 'done', i === now && 'now')}><span className="mfg-no" aria-hidden>{s.done ? <CheckCircle2 size={16} /> : i + 1}</span><div><b>{T(s.title)}</b>{s.done && <span className="sub"> · {T('Step done')}</span>}<div className="muted">{T(s.hint)}</div>{i === now && s.action && <div className="mt8">{s.action}</div>}</div></li>))}</ol>
    </Card>
  );
}
