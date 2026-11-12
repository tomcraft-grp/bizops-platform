import { useMemo, useState } from 'react';
import { Download, Info } from 'lucide-react';
import { useDB } from '../domain/store';
import { RANGES, Range, rangeOf, useBranchIds, useEcon } from '../ui/data';
import { Badge, Banner, Button, Card, ChannelChip, DataTable, Kpi, PageHead, Select, Seg, useHas } from '../ui/kit';
import { Waterfall, HBars } from '../ui/charts';
import { businessCosts, completeness, groupEcon, groupLines, totalsOf } from '../domain/economics';
import { CHANNEL_LIST } from '../domain/meta';
import { download, money, money0, pct, shortDay, toCSV } from '../lib/util';
import { Gate } from '../ui/Shell';

type Dim = 'channel' | 'branch' | 'product' | 'category' | 'day' | 'customer';
export default function Profit() {
  return <Gate perm="finance:profit"><Inner /></Gate>;
}
function Inner() {
  const db = useDB();
  const canExport = useHas('reports:export');
  const [range, setRange] = useState<Range>('30d');
  const [dim, setDim] = useState<Dim>('channel');
  const [alloc, setAlloc] = useState<'none' | 'revenue'>(db.org.allocateOpex);
  const branchIds = useBranchIds();
  const r = rangeOf(range);
  const { orders, lines } = useEcon({ ...r, branchIds });
  const t = useMemo(() => totalsOf(orders), [orders]);
  const comp = completeness(db, t);
  const biz = useMemo(() => businessCosts(db, r.from, r.to), [db.journals, r.from, r.to]);
  const netProfit = t.contribution - biz.waste - biz.adjustments - biz.opex;
  const rows = useMemo(() => {
    if (dim === 'product' || dim === 'category') {
      const g = groupLines(lines, (l) => (dim === 'product' ? l.productId : l.category));
      return Object.entries(g).map(([k, v]) => ({ key: k, label: dim === 'product' ? v.name ?? k : k, orders: 0, qty: v.qty, net: v.net, cogs: v.cogs, gp: v.net - v.cogs, fees: v.feeShare, contrib: v.contribution }));
    }
    const kf = (e: typeof orders[number]) => (dim === 'channel' ? e.channel : dim === 'branch' ? e.branchId : dim === 'day' ? e.day : e.customerId ?? 'walk-in');
    const g = groupEcon(orders, kf);
    const nm = (k: string) => (dim === 'channel' ? CHANNEL_LIST.find((c) => c.code === k)?.label ?? k : dim === 'branch' ? db.branches.find((b) => b.id === k)?.name ?? k : dim === 'day' ? shortDay(k) : k === 'walk-in' ? 'Walk-in / no customer' : db.customers.find((c) => c.id === k)?.name ?? k);
    return Object.entries(g).map(([k, v]) => ({ key: k, label: nm(k), orders: v.orders, qty: v.units, net: v.net, cogs: v.cogs, gp: v.grossProfit, fees: v.channelCosts, contrib: v.contribution }));
  }, [orders, lines, dim, db.branches, db.customers]);
  const opexShare = (net: number) => (alloc === 'revenue' && t.net ? ((biz.opex + biz.waste + biz.adjustments) * net) / t.net : 0);
  const wf = [
    { label: 'Gross sales (ex VAT)', value: t.gross, kind: 'total' as const },
    { label: 'Discounts (business-funded)', value: t.discount, kind: 'minus' as const },
    { label: 'Returns & credit notes', value: t.returns, kind: 'minus' as const },
    { label: 'Net sales', value: t.net, kind: 'total' as const },
    { label: 'Cost of goods sold', value: t.cogs, kind: 'minus' as const },
    { label: 'Gross profit', value: t.grossProfit, kind: 'total' as const },
    { label: `Commission${t.provisionalOrders ? ' *' : ''}`, value: t.commission, kind: 'minus' as const, note: 'Marketplace / delivery commission' },
    { label: `Payment fees${t.provisionalOrders ? ' *' : ''}`, value: t.paymentFee, kind: 'minus' as const },
    { label: `Shipping subsidy${t.provisionalOrders ? ' *' : ''}`, value: t.shipping, kind: 'minus' as const },
    { label: 'Net contribution', value: t.contribution, kind: 'total' as const },
    { label: 'Waste, spoilage & shrinkage', value: biz.waste + biz.adjustments, kind: 'minus' as const },
    { label: 'Operating expenses', value: biz.opex, kind: 'minus' as const },
    { label: 'Net profit (business level)', value: Math.max(0, netProfit), kind: 'total' as const },
  ];
  return (
    <>
      <PageHead title="Profit engine" desc="Real profitability from traceable costs: weighted-average COGS snapshots, BOM-based cost for recipes, channel commissions, payment fees, shipping subsidies, returns and business-level expenses."
        actions={<>{canExport && <Button onClick={() => download('profit.csv', toCSV([['Dimension', 'Orders', 'Units', 'Net sales', 'COGS', 'Gross profit', 'Channel costs', 'Contribution'], ...rows.map((x) => [x.label, x.orders, x.qty, x.net, x.cogs, x.gp, x.fees, x.contrib])]))}><Download size={15} /> CSV</Button>}<Seg value={range} onChange={setRange} options={RANGES.map((x) => ({ v: x.v, label: x.label }))} /></>} />
      <div className="mb16">
        <Banner tone={comp.label === 'Final' ? 'good' : 'warn'} icon={<Info size={16} />}>
          <b>Data completeness: {comp.label}.</b> {comp.reasons.length ? comp.reasons.join('. ') + '. ' : 'All costs and fees are final. '}
          <b>Method:</b> costs are weighted-average snapshots taken when each order shipped (recipe items use the BOM version effective that day); net sales exclude VAT; “contribution” = gross profit − channel fees; “net profit” also deducts waste, shrinkage and operating expenses from the ledger. {comp.label === 'Provisional' && <>Figures marked * use <b>estimated</b> fees and are not “actual net profit” until settlements are received.</>}
        </Banner>
      </div>
      <div className="grid g4 mb16">
        <Kpi label="Net sales" value={money0(t.net)} sub={`${t.orders} orders · ${t.units.toLocaleString()} units`} />
        <Kpi label="Gross profit" value={money0(t.grossProfit)} sub={`${pct(t.net ? t.grossProfit / t.net : 0)} margin`} />
        <Kpi label={<>Net contribution <Badge tone={comp.label === 'Final' ? 'good' : 'warn'}>{comp.label}</Badge></>} value={money0(t.contribution)} sub={`${pct(t.net ? t.contribution / t.net : 0)} of net sales`} />
        <Kpi label="Net profit (business)" value={money0(netProfit)} tone={netProfit < 0 ? 'bad' : undefined} sub={`after ${money0(biz.opex)} opex + ${money0(biz.waste + biz.adjustments)} waste/shrink`} />
      </div>
      <div className="grid g-main mb16">
        <Card title="From gross sales to net profit"><Waterfall rows={wf} fmt={money0} /></Card>
        <Card title="Where the money goes" sub="share of net sales">
          <HBars color="var(--s2)" items={[{ label: 'Cost of goods', value: t.cogs }, { label: 'Channel fees', value: t.channelCosts }, { label: 'Operating expenses', value: biz.opex }, { label: 'Waste & shrinkage', value: biz.waste + biz.adjustments }, { label: 'Net profit', value: Math.max(0, netProfit), color: 'var(--s3)' }].map((x) => ({ ...x, sub: pct(t.net ? x.value / t.net : 0, 0) }))} fmt={money0} />
        </Card>
      </div>
      <Card flush title="Profit by dimension" actions={<><Select sm style={{ width: 'auto' }} value={alloc} onChange={(e) => setAlloc(e.target.value as 'none' | 'revenue')}><option value="none">Do not allocate opex</option><option value="revenue">Allocate opex & waste by revenue share</option></Select><Seg value={dim} onChange={setDim} options={[{ v: 'channel', label: 'Channel' }, { v: 'branch', label: 'Branch' }, { v: 'product', label: 'Product' }, { v: 'category', label: 'Category' }, { v: 'day', label: 'Day' }, { v: 'customer', label: 'Customer' }]} /></>}>
        <DataTable rows={rows} rowKey={(x) => x.key} pageSize={12} initialSort={{ key: 'net', dir: 'desc' }}
          cols={[
            { key: 'l', header: dim[0].toUpperCase() + dim.slice(1), sort: (x) => x.label, render: (x) => (dim === 'channel' ? <ChannelChip c={x.key as never} /> : <b>{x.label}</b>) },
            ...(dim === 'product' || dim === 'category' ? [] : [{ key: 'o', header: 'Orders', num: true, render: (x: typeof rows[number]) => x.orders }]),
            { key: 'q', header: 'Units', num: true, render: (x) => x.qty.toLocaleString() },
            { key: 'net', header: 'Net sales', num: true, sort: (x) => x.net, render: (x) => money0(x.net) },
            { key: 'c', header: 'COGS', num: true, render: (x) => money0(x.cogs) },
            { key: 'gp', header: 'Gross profit', num: true, sort: (x) => x.gp, render: (x) => money0(x.gp) },
            { key: 'gpp', header: 'GP %', num: true, render: (x) => pct(x.net ? x.gp / x.net : 0) },
            { key: 'f', header: 'Channel fees', num: true, render: (x) => money0(x.fees) },
            { key: 'k', header: 'Contribution', num: true, sort: (x) => x.contrib, render: (x) => <b className={x.contrib < 0 ? 'bad' : ''}>{money0(x.contrib)}</b> },
            ...(alloc === 'revenue' ? [{ key: 'np', header: 'After opex share', num: true, render: (x: typeof rows[number]) => <b>{money0(x.contrib - opexShare(x.net))}</b> }] : []),
          ]} />
      </Card>
    </>
  );
}
