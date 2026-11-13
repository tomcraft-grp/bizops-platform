import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, Boxes, CircleDollarSign, Hash, Heart, Landmark, Package, Percent, ReceiptText, ShoppingBag, TrendingUp, Wallet } from 'lucide-react';
import { useDB } from '../domain/store';
import { RANGES, Range, lowStock, previousRange, rangeOf, useAlerts, useBranchIds, useEcon } from '../ui/data';
import { Badge, Banner, Button, Card, ChannelChip, DataTable, Empty, Kpi, PageHead, Seg, StatusBadge, useHas, useUser, Tx } from '../ui/kit';
import { BarChart, Donut, HBars, SERIES_COLORS } from '../ui/charts';
import { CHANNEL_LIST, CHANNELS } from '../domain/meta';
import { addDays, compact, dateTimeFmt, dayKey, money, money0, pct, shortDay, sum } from '../lib/util';
import { balancesBetween, isControl, isFs, sumAccounts } from '../domain/accounting';
import { completeness, groupEcon, groupLines, totalsOf } from '../domain/economics';
import { eventStats } from '../domain/events';
import { pointsMap } from '../domain/loyalty';
import { qtyFmt } from '../lib/util';

export default function Dashboard() {
  const db = useDB();
  const nav = useNavigate();
  const user = useUser();
  const canProfit = useHas('finance:profit');
  const canAcct = useHas('accounting:view');
  const [range, setRange] = useState<Range>('7d');
  const branchIds = useBranchIds();
  const r = rangeOf(range);
  const pr = previousRange(range);
  const cur = useEcon({ ...r, branchIds });
  const prev = useEcon(pr ? { ...pr, branchIds } : { from: '2000-01-01', to: '2000-01-01' });
  const alerts = useAlerts();
  const t = useMemo(() => totalsOf(cur.orders), [cur]);
  const tp = useMemo(() => totalsOf(prev.orders), [prev]);
  const delta = (a: number, b: number) => (pr && b ? (a - b) / Math.abs(b) : null);
  const comp = completeness(db, t);

  // chart: last N days stacked by channel
  const nDays = range === 'all' || range === '30d' ? 30 : range === 'mtd' ? Math.max(14, new Date().getDate()) : 14;
  const chartEcon = useEcon({ from: dayKey(addDays(new Date(), -(nDays - 1))), to: dayKey(new Date()), branchIds });
  const chart = useMemo(() => {
    const days = Array.from({ length: nDays }, (_, i) => dayKey(addDays(new Date(), -(nDays - 1 - i))));
    const m: Record<string, Record<string, number>> = Object.fromEntries(days.map((d) => [d, {}]));
    for (const e of chartEcon.orders) m[e.day] && (m[e.day][e.channel] = (m[e.day][e.channel] || 0) + e.net);
    return days.map((d) => ({ label: shortDay(d), values: m[d] }));
  }, [chartEcon, nDays]);
  const byChannel = useMemo(() => groupEcon(cur.orders, (e) => e.channel), [cur]);
  const prods = useMemo(() => Object.entries(groupLines(cur.lines, (l) => l.productId)).sort((a, b) => b[1].net - a[1].net).slice(0, 7), [cur]);

  // balance-sheet-ish KPIs (as of now, GL based)
  const bal = useMemo(() => balancesBetween(db.journals), [db.journals]);
  const cash = sumAccounts(db, bal, isFs('cash'));
  const ar = sumAccounts(db, bal, (a) => a.control === 'ar' || a.control === 'platform');
  const ap = sumAccounts(db, bal, isControl('ap'));
  const inv = sumAccounts(db, bal, isControl('inventory'));

  const low = useMemo(() => lowStock(db), [db]);
  const activeEvent = db.events.find((e) => e.status === 'active');
  const es = activeEvent ? eventStats(db, activeEvent.id, new Date().toISOString()) : null;
  const pts = useMemo(() => Object.values(pointsMap(db)).reduce((s, x) => s + x, 0), [db.pointsLedger]);
  const recent = useMemo(() => [...db.orders].filter((o) => !branchIds || branchIds.includes(o.branchId)).slice(-9).reverse(), [db.orders, branchIds]);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHead title={<Tx vars={{ name: user.name.split(' ')[0] }}>{greet + ', {name}'}</Tx>} desc={<Tx vars={{ org: db.org.name, ch: CHANNEL_LIST.length, br: db.branches.length }}>{'{org} · {ch} sales channels · {br} branches. Figures are net of VAT unless stated.'}</Tx>}
        actions={<Seg value={range} onChange={setRange} options={RANGES.map((x) => ({ v: x.v, label: x.label }))} />} />

      {canProfit && comp.label === 'Provisional' && (
        <div className="mb16"><Banner tone="warn"><b><Tx>Profit figures are provisional.</Tx></b> {comp.reasons.join('. ')}<Tx>. They become final as platform settlements are received (</Tx><Link to="/channels?tab=settlements"><Tx>Channels → Settlements</Tx></Link>).</Banner></div>
      )}

      <div className="grid g4 mb16">
        <Kpi icon={<CircleDollarSign size={15} />} label="Net sales" value={money0(t.net)} delta={delta(t.net, tp.net)} sub={pr ? 'vs previous period' : `${t.orders} orders`} />
        {canProfit ? <Kpi icon={<TrendingUp size={15} />} label="Gross profit" value={money0(t.grossProfit)} delta={delta(t.grossProfit, tp.grossProfit)} sub={<Tx vars={{ p: pct(t.net ? t.grossProfit / t.net : 0) }}>{'{p} margin'}</Tx>} /> : <Kpi icon={<ShoppingBag size={15} />} label="Items sold" value={qtyFmt(t.units)} sub={<Tx vars={{ n: t.orders }}>{'{n} orders'}</Tx>} />}
        {canProfit ? <Kpi icon={<Percent size={15} />} label={<><Tx>Net contribution</Tx>{' '}<Badge tone={comp.label === 'Final' ? 'good' : 'warn'}><Tx>{comp.label}</Tx></Badge></>} value={money0(t.contribution)} delta={delta(t.contribution, tp.contribution)} sub={`after ${money0(t.channelCosts)} channel fees`} /> : <Kpi icon={<Percent size={15} />} label="Discounts given" value={money0(t.discount)} sub="promotions & coupons" />}
        <Kpi icon={<ReceiptText size={15} />} label="Orders" value={t.orders.toLocaleString()} delta={delta(t.orders, tp.orders)} sub={`avg ${money0(t.orders ? t.net / t.orders : 0)} / order`} />
      </div>
      {canAcct && (
        <div className="grid g4 mb16">
          <Kpi icon={<Banknote size={15} />} label="Cash & bank" value={money0(cash)} sub="all cash accounts" />
          <Kpi icon={<Wallet size={15} />} label="Receivables" value={money0(ar)} sub={<Link to="/receivables"><Tx>customers + platforms</Tx></Link>} />
          <Kpi icon={<Landmark size={15} />} label="Payables" value={money0(ap)} sub={<Link to="/purchasing?tab=payables"><Tx>supplier invoices</Tx></Link>} />
          <Kpi icon={<Boxes size={15} />} label="Inventory value" value={money0(inv)} sub={<Link to="/inventory"><Tx>weighted average cost</Tx></Link>} />
        </div>
      )}

      <div className="grid g-main mb16">
        <Card title="Net sales by day" sub={<Tx vars={{ n: nDays }}>{'Last {n} days · stacked by channel'}</Tx>}>
          <BarChart data={chart} series={CHANNEL_LIST.map((c) => ({ key: c.code, label: c.short, color: c.color }))} fmt={compact} />
        </Card>
        <Card title="Sales by channel" sub={RANGES.find((x) => x.v === range)?.label}>
          {t.orders ? <Donut items={CHANNEL_LIST.map((c) => ({ label: c.short, value: byChannel[c.code]?.net || 0, color: c.color })).filter((i) => i.value > 0)} center={compact(t.net)} sub="net sales" /> : <Empty title="No sales in this period" hint="Create a sale in POS or switch the period." />}
        </Card>
      </div>

      <div className="grid g3 mb16">
        <Card title="Top products" sub="by net sales">
          {prods.length ? <HBars items={prods.map(([id, v], i) => ({ label: db.products.find((p) => p.id === id)?.emoji + ' ' + v.name, value: v.net, sub: canProfit ? `${pct(v.net ? (v.net - v.cogs) / v.net : 0, 0)} GP` : `${v.qty} sold`, color: SERIES_COLORS[0] }))} fmt={(n) => money0(n)} /> : <Empty title="No sales yet" />}
        </Card>
        <Card title="Needs attention" actions={<Badge tone={alerts.total ? 'warn' : 'good'}>{alerts.total || <Tx>{'All clear'}</Tx>}</Badge>}>
          <div className="col gap-6">
            {[
              { n: alerts.slips.length, t: 'payment slips to review', to: '/receivables?tab=slips', tone: 'warn' as const },
              { n: alerts.newOrders, t: 'new online orders to confirm', to: '/orders', tone: 'info' as const },
              { n: alerts.syncErrors.length, t: 'channel sync errors', to: '/channels?tab=errors', tone: 'bad' as const },
              { n: alerts.failedPrints.length, t: 'failed print jobs', to: '/printing', tone: 'bad' as const },
              { n: low.length, t: 'items below reorder level', to: '/inventory', tone: 'warn' as const },
              { n: alerts.pendingSettle.length, t: 'settlements awaiting bank receipt', to: '/channels?tab=settlements', tone: 'info' as const },
            ].map((x) => (
              <Link key={x.t} to={x.to} className="row between" style={{ padding: '7px 2px', color: 'var(--text)', textDecoration: 'none', borderBottom: '1px solid var(--hairline)' }}>
                <span className="row gap-6"><Badge tone={x.n ? x.tone : ''}>{x.n}</Badge><Tx>{x.t}</Tx></span><span className="muted">→</span>
              </Link>
            ))}
          </div>
        </Card>
        <Card title="Customers & campaigns">
          <div className="col">
            <div className="row between"><span className="row gap-6"><Heart size={15} />{' '}<Tx>Members</Tx></span><b>{db.customers.length}</b></div>
            <div className="row between"><span className="row gap-6"><Heart size={15} />{' '}<Tx>Points outstanding</Tx></span><b>{pts.toLocaleString()} <span className="muted">≈ {money0(pts * db.org.pointValue)}</span></b></div>
            <div className="row between"><span className="row gap-6"><Percent size={15} />{' '}<Tx>Active promotions</Tx></span><b>{db.promotions.filter((p) => p.status === 'active' && dayKey(p.endAt) >= dayKey(new Date())).length}</b></div>
            {activeEvent && es && (
              <div>
                <div className="row between"><span className="row gap-6"><Hash size={15} /> {activeEvent.name.replace('Lucky Draw – ', 'Draw: ')}</span><b>{es.taken}/{es.total}</b></div>
                <div className="progress mt8"><i style={{ width: `${(es.taken / es.total) * 100}%` }} /></div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{es.issued - es.used}{' '}<Tx>entitlements unused ·</Tx>{' '}<Link to="/events"><Tx>open board</Tx></Link></div>
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid g-main">
        <Card title="Recent orders" flush actions={<Link to="/orders"><Tx>View all</Tx></Link>}>
          <DataTable pageSize={9} rows={recent} rowKey={(o) => o.id} onRow={(o) => nav(`/orders?o=${o.id}`)} compact
            cols={[
              { key: 'no', header: 'Order', render: (o) => <><b>{o.no}</b><div className="sub">{dateTimeFmt(o.createdAt)}</div></> },
              { key: 'ch', header: 'Channel', render: (o) => <ChannelChip c={o.channel} /> },
              { key: 'st', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
              { key: 'tot', header: 'Total', num: true, render: (o) => money(o.total) },
            ]} />
        </Card>
        <Card title="Low stock" flush actions={<Link to="/inventory"><Tx>Inventory</Tx></Link>}>
          {low.length ? (
            <DataTable pageSize={7} rows={low} rowKey={(l) => l.productId + l.warehouseId} compact
              cols={[
                { key: 'p', header: 'Item', render: (l) => { const p = db.products.find((x) => x.id === l.productId)!; return <><b>{p.name}</b><div className="sub">{db.warehouses.find((w) => w.id === l.warehouseId)?.name}</div></>; } },
                { key: 'q', header: 'On hand', num: true, render: (l) => <span className="bad">{qtyFmt(l.qty)}</span> },
                { key: 'm', header: 'Min', num: true, render: (l) => qtyFmt(l.min) },
              ]} />
          ) : <Empty icon={<Package size={22} />} title="Stock levels are healthy" />}
        </Card>
      </div>
      {canProfit && (
        <Card className="mt16" title="Profit by channel" sub="Net sales → gross profit → contribution after channel fees" flush>
          <DataTable rows={CHANNEL_LIST.map((c) => ({ c, v: byChannel[c.code] })).filter((x) => x.v)} rowKey={(x) => x.c.code} compact
            cols={[
              { key: 'c', header: 'Channel', render: (x) => <ChannelChip c={x.c.code} /> },
              { key: 'o', header: 'Orders', num: true, render: (x) => x.v.orders },
              { key: 'n', header: 'Net sales', num: true, render: (x) => money0(x.v.net) },
              { key: 'g', header: 'Gross profit', num: true, render: (x) => money0(x.v.grossProfit) },
              { key: 'gp', header: 'GP %', num: true, render: (x) => pct(x.v.net ? x.v.grossProfit / x.v.net : 0) },
              { key: 'f', header: 'Channel fees', num: true, render: (x) => money0(x.v.channelCosts) },
              { key: 'k', header: 'Contribution', num: true, render: (x) => <b>{money0(x.v.contribution)}</b> },
              { key: 'cp', header: 'Contr. %', num: true, render: (x) => pct(x.v.net ? x.v.contribution / x.v.net : 0) },
              { key: 'st', header: 'Fees', render: (x) => (x.v.provisionalOrders ? <Badge tone="warn">{x.v.provisionalOrders}{' '}<Tx>est.</Tx></Badge> : <Badge tone="good"><Tx>final</Tx></Badge>) },
            ]} />
        </Card>
      )}
    </>
  );
}
export const _icons = { AlertTriangle, Hash };
