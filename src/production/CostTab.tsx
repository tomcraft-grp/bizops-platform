import { useMemo, useState, type ReactNode } from 'react';
import { Coins } from 'lucide-react';
import { useDB } from '../domain/store';
import { orderTotals } from '../domain/production';
import { orderCost, productCost, profitability, type ProfitCostSource, type Variances } from '../domain/productionAnalysis';
import { Banner, Card, DataTable, Empty, Seg, Select } from '../ui/kit';
import { RANGES, rangeOf, useEcon, type Range } from '../ui/data';
import { money, pct, qtyFmt, r2 } from '../lib/util';
import type { CostElems, ID } from '../domain/types';
import { Cost, Facts, NoData, OrderBadge, nameOf, prodOf, useT, type Go } from './parts';

const SOURCE: Record<ProfitCostSource, string> = { average: 'average in stock', actual: 'last production', estimated: 'BOM estimate', standard: 'standard cost' };
const Amt = ({ v }: { v: number | null | undefined }) => (v == null ? <NoData /> : <>{money(v)}</>);
const Pct = ({ v }: { v: number | null | undefined }) => (v == null ? <NoData /> : <span className={v < 0 ? 'bad' : ''}>{pct(v)}</span>);
/** More cost than expected is a plus and unfavourable. */
function Var({ v }: { v: number | null }) { return v == null ? <NoData /> : <span className={v > 0 ? 'bad' : v < 0 ? 'good' : ''}>{v > 0 ? '+' : ''}{money(v)}</span>; }

export function VarianceTable({ v, waste, leftover }: { v: Variances; waste: number; leftover: CostElems }) {
  const T = useT(), posted = r2(leftover.materials + leftover.labor + leftover.overhead);
  const rows: [string, number | null][] = [['Material price', v.materialPrice], ['Material usage', v.materialUsage], ['Labour', v.labor], ['Overhead', v.overhead], ['Rejected units', v.waste]];
  return (
    <div>
      <h3 className="mb8">{T('Variances (actual − estimated)')}</h3>
      <table className="t compact" data-testid="order-variances"><tbody>{rows.map(([k, x]) => <tr key={k}><td>{T(k)}</td><td className="num"><Var v={x} /></td></tr>)}<tr className="total"><td>{T('Total')}</td><td className="num"><Var v={v.total} /></td></tr></tbody></table>
      <div className="sub muted mt8">{T('Variances are for analysis and are not posted. Posted to the ledger: {a} as waste and {b} as cost left in the order at its last receipt or when it was closed.', { a: money(waste), b: money(posted) })}</div>
    </div>
  );
}

export function CostTab({ go }: { go: Go }) {
  const db = useDB(), T = useT();
  const [by, setBy] = useState<'product' | 'order'>('product'), [range, setRange] = useState<Range>('30d'), [pick, setPick] = useState<ID | null>(null);
  const r = useMemo(() => rangeOf(range), [range]), { lines } = useEcon(r);
  const products = useMemo(() => {
    const ids = [...new Set([...db.boms.map((b) => b.productId), ...db.productionOrders.map((o) => o.productId)])].filter((id) => prodOf(db, id));
    return ids.map((id) => ({ id, c: productCost(db, id), p: profitability(db, id, r.from, r.to, lines) }));
  }, [db, r, lines]);
  const orders = useMemo(() => db.productionOrders.filter((o) => o.status !== 'cancelled' && o.status !== 'draft').map((o) => ({ o, c: orderCost(db, o), t: orderTotals(o), net: profitability(db, o.productId, r.from, r.to, lines).netPrice })).reverse(), [db, r, lines]);
  const cur = by === 'product' ? products.find((x) => x.id === pick) : undefined;
  return (
    <div className="col gap-16" data-testid="cost-tab">
      <Banner>{T('Three different figures: the estimate comes from the BOM at today’s costs, the standard is the cost written on the product, and the actual is what production really cost. They are never mixed.')}</Banner>
      <Card flush title={by === 'product' ? 'Cost and profit by product' : 'Cost and variances by production order'} sub={by === 'product' ? 'Products with a BOM or a production order. Sales are net of VAT, discounts and returns, for the period chosen here.' : 'Select an order number to see its variances by element.'}
        actions={<><Seg value={by} onChange={setBy} options={[{ v: 'product', label: 'By product' }, { v: 'order', label: 'By production order' }]} />{by === 'product' && <Select sm style={{ width: 'auto' }} value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label={T('Sales period')}>{RANGES.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</Select>}</>}>
        {by === 'product' ? (
          <DataTable key="p" compact rows={products} rowKey={(x) => x.id} pageSize={12} onRow={(x) => setPick(x.id)} search={(x) => `${nameOf(db, x.id)} ${prodOf(db, x.id)?.sku ?? ''}`}
            empty={<Empty icon={<Coins size={22} />} title="No cost data yet" hint="Costs appear when a product has a BOM or a production order." />}
            cols={[
              { key: 'n', header: 'Product', sort: (x) => nameOf(db, x.id), render: (x) => <><button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); setPick(x.id); }}>{nameOf(db, x.id)}</button><div className="sub mono">{prodOf(db, x.id)?.sku}</div></> },
              { key: 'e', header: 'Estimated', num: true, render: (x) => (x.c.bomId ? <Cost v={x.c.estimated} /> : <NoData />) }, { key: 's', header: 'Standard', num: true, render: (x) => <Amt v={x.c.standard} /> }, { key: 'a', header: 'Actual (last)', num: true, render: (x) => <Amt v={x.c.lastActual} /> },
              { key: 'p', header: 'Price before VAT', num: true, render: (x) => <Amt v={x.p.netPrice} /> }, { key: 'g', header: 'Profit per unit', num: true, render: (x) => <Amt v={x.p.gpPerUnit} /> }, { key: 'm', header: 'Margin', num: true, render: (x) => <Pct v={x.p.margin} /> },
              { key: 'r', header: 'Revenue', num: true, render: (x) => <Amt v={x.p.sold?.net} /> }, { key: 'c', header: 'Cost of sales', num: true, render: (x) => <Amt v={x.p.sold?.cogs} /> }, { key: 'x', header: 'Gross profit', num: true, render: (x) => <Amt v={x.p.sold?.gp} /> },
            ]} />
        ) : (
          <DataTable key="o" compact rows={orders} rowKey={(x) => x.o.id} pageSize={12} onRow={(x) => go({ tab: 'orders', order: x.o.id })} search={(x) => `${x.o.no} ${nameOf(db, x.o.productId)}`}
            empty={<Empty icon={<Coins size={22} />} title="No cost data yet" hint="Costs appear when a product has a BOM or a production order." />}
            cols={[
              { key: 'n', header: 'Production order no.', render: (x) => <><button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); go({ tab: 'orders', order: x.o.id }); }}>{x.o.no}</button><div className="sub">{nameOf(db, x.o.productId)}</div></> }, { key: 's', header: 'Status', render: (x) => <OrderBadge s={x.o.status} /> },
              { key: 'q', header: 'Made / planned', num: true, render: (x) => `${qtyFmt(x.t.good)} / ${qtyFmt(x.o.plannedQty)}` },
              { key: 'e', header: 'Estimated per unit', num: true, render: (x) => (x.o.estimate ? <Cost v={x.c.estimatedPerUnit} /> : <NoData />) }, { key: 'd', header: 'Standard per unit', num: true, render: (x) => <Amt v={x.c.standardPerUnit} /> }, { key: 'a', header: 'Actual per unit', num: true, render: (x) => (x.c.actualPerUnit == null ? <NoData /> : <Cost v={x.c.actualPerUnit > 0 ? x.c.actualPerUnit : null} />) },
              { key: 't', header: 'Actual total', num: true, render: (x) => (x.c.actual.total > 0 ? money(x.c.actual.total) : <NoData />) }, { key: 'v', header: 'Variance', num: true, render: (x) => <Var v={x.c.variances?.total ?? null} /> },
              { key: 'p', header: 'Price before VAT', num: true, render: (x) => <Amt v={x.net} /> }, { key: 'g', header: 'Profit per unit', num: true, render: (x) => <Amt v={x.net == null || !(x.c.actualPerUnit! > 0) ? null : r2(x.net - x.c.actualPerUnit!)} /> }, { key: 'm', header: 'Margin', num: true, render: (x) => <Pct v={x.net == null || !(x.c.actualPerUnit! > 0) ? null : (x.net - x.c.actualPerUnit!) / x.net} /> },
            ]} />
        )}
      </Card>
      {by === 'order' && <div className="muted">{T('Sales are not shown per order: goods of different orders are mixed in stock at their average cost. Revenue, cost of sales and gross profit are under “By product”.')}</div>}
      {cur && (
        <Card title={nameOf(db, cur.id)} sub="All figures of this product, per unit unless stated">
          <div className="mfg-3" data-testid="cost-product">
            <div><h3 className="mb8">{T('Cost per unit')}</h3><Facts items={[[T('Estimated (BOM)'), cur.c.bomId ? <Cost key="e" v={cur.c.estimated} /> : <NoData key="e" />], [T('Standard'), <Amt key="s" v={cur.c.standard} />], [T('Average in stock'), <Amt key="a" v={cur.c.average} />], [T('Actual (last production)'), <Amt key="l" v={cur.c.lastActual} />]] as [ReactNode, ReactNode][]} />
              {cur.c.missing.length > 0 && <div className="sub mt8 warn">{T('Cost not known:')} {cur.c.missing.map((m) => T(m)).join(', ')}</div>}</div>
            <div><h3 className="mb8">{T('Profit per unit at today’s price')}</h3><Facts items={[[T('Price with VAT'), cur.p.price == null ? <NoData key="p" /> : money(cur.p.price)], [T('VAT rate'), pct(cur.p.taxRate, 0)], [T('Price before VAT'), <Amt key="n" v={cur.p.netPrice} />], [cur.p.costSource ? T('Cost used ({s})', { s: T(SOURCE[cur.p.costSource]) }) : T('Cost used'), <Cost key="c" v={cur.p.cost} />], [<b key="gl">{T('Gross profit per unit')}</b>, <b key="g"><Amt v={cur.p.gpPerUnit} /></b>], [T('Margin'), <Pct key="m" v={cur.p.margin} />]]} /></div>
            <div><h3 className="mb8">{T('Sales in the period')}</h3>{cur.p.sold ? <Facts items={[[T('Units sold'), qtyFmt(cur.p.sold.qty)], [T('Revenue (net of VAT)'), <Amt key="r" v={cur.p.sold.net} />], [T('Cost of sales'), <Amt key="c" v={cur.p.sold.cogs} />], [<b key="gl">{T('Gross profit')}</b>, <b key="g"><Amt v={cur.p.sold.gp} /></b>], [T('Margin'), <Pct key="m" v={cur.p.sold.margin} />]]} /> : <div className="muted">{T('No sale in this period')}</div>}</div>
          </div>
        </Card>
      )}
    </div>
  );
}
