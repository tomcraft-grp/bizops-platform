import { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { useDB } from '../domain/store';
import { AGING_BUCKETS, agingFor } from '../domain/payments';
import { apOpen } from '../domain/purchasing';
import { balancesBetween, natBal, isControl, isFs, taxAt } from '../domain/accounting';
import type { Account } from '../domain/types';
import { Badge, Banner, Button, Card, DataTable, Field, Input, PageHead, Select, Tabs, useHas, Tx } from '../ui/kit';
import { stockValue } from '../domain/inventory';
import { addDays, dayKey, dateFmt, daysBetween, download, money, money0, parseDay, toCSV, r2 } from '../lib/util';
import { CHANNEL_LIST } from '../domain/meta';
import { useEcon } from '../ui/data';
import { groupEcon } from '../domain/economics';
import { Gate } from '../ui/Shell';
import type { DB } from '../domain/types';

type Tab = 'daily' | 'sales' | 'ar' | 'ap' | 'inventory';
export default function Reports() {
  return <Gate perm="reports:view"><Inner /></Gate>;
}
function Inner() {
  const db = useDB();
  const [tab, setTab] = useState<Tab>('daily');
  const canCost = useHas('finance:cost');
  return (
    <>
      <PageHead title="Reports" desc="Every report states its period, currency, scope, costing method and whether figures are provisional or posted/closed." />
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'daily', label: 'Daily: yesterday → today → now' }, { v: 'sales', label: 'Sales' }, { v: 'ar', label: 'Receivables aging' }, { v: 'ap', label: 'Payables aging' }, ...(canCost ? [{ v: 'inventory' as Tab, label: 'Inventory valuation' }] : [])]} />
      {tab === 'daily' && <Daily />}
      {tab === 'sales' && <Sales />}
      {tab === 'ar' && <AR />}
      {tab === 'ap' && <AP />}
      {tab === 'inventory' && <Inventory />}
      <div className="muted mt16" style={{ fontSize: 12 }}><Tx>Currency THB · costing method</Tx>{' '}{db.org.costingMethod === 'WAC' ? <Tx>{'weighted average'}</Tx> : db.org.costingMethod}{' '}<Tx>· VAT</Tx>{' '}{db.org.vatRegistered ? <Tx vars={{ rate: db.org.vatRate * 100 }}>{'{rate}% (sales shown ex-VAT unless stated)'}</Tx> : <Tx>{'not registered'}</Tx>}{' '}<Tx>· periods through</Tx>{' '}{db.meta.lockedUntil ?? '—'}{' '}<Tx>are closed; later figures are provisional.</Tx></div>
    </>
  );
}

/** Opening → movements → closing, straight from the ledger so every number is traceable */
function Daily() {
  const db = useDB();
  const [day, setDay] = useState(dayKey(new Date()));
  const prev = dayKey(addDays(parseDay(day), -1));
  const open = useMemo(() => balancesBetween(db.journals, undefined, prev), [db.journals, prev]);
  const act = useMemo(() => balancesBetween(db.journals, day, day), [db.journals, day]);
  const close = useMemo(() => balancesBetween(db.journals, undefined, day), [db.journals, day]);
  const acc = (pred: (a: Account) => boolean) => ({ o: sumA(db, open, pred), a: sumA(db, act, pred), c: sumA(db, close, pred) });
  // detailed movements by source for the chosen day
  const bySrc = (pred: (a: Account) => boolean) => {
    const m: Record<string, number> = {};
    for (const j of db.journals) {
      if (dayKey(j.date) !== day) continue;
      for (const l of j.lines) { const a = db.accounts.find((x) => x.code === l.account)!; if (!pred(a)) continue; m[j.refType] = (m[j.refType] || 0) + (a.normal === 'debit' ? l.debit - l.credit : l.credit - l.debit); }
    }
    return Object.entries(m).filter(([, v]) => Math.abs(v) > 0.004);
  };
  const sections: { title: string; pred: (a: Account) => boolean; note: string }[] = [
    { title: 'Customer receivables', pred: isControl('ar'), note: 'charges from sales less receipts, credit notes and refunds' },
    { title: 'Platform receivables', pred: isControl('platform'), note: 'marketplace / delivery sales awaiting payout' },
    { title: 'Cash & bank', pred: isFs('cash'), note: 'cash sales, transfers, settlements, supplier payments, expenses' },
    { title: 'Inventory (at cost)', pred: isControl('inventory'), note: 'purchases, production, cost of goods sold, adjustments' },
    { title: 'Supplier payables', pred: isControl('ap'), note: 'goods received less payments and credit notes' },
  ];
  const sales = useEcon({ from: day, to: day });
  const t = useMemo(() => groupEcon(sales.orders, () => 'x').x, [sales]);
  const label = (r: string) => ({ order: 'Sales / cost of sales', receipt: 'Customer receipts', grn: 'Goods received', supplier_payment: 'Supplier payments', production: 'Production', settlement: 'Platform settlements', expense: 'Expenses', return: 'Returns & credit notes', transfer: 'Transfers', stock_adjust: 'Stock adjustments', count: 'Stock count', credit_applied: 'Credit applied', refund_paid: 'Refunds paid', refund_credit: 'Refund to credit', cancel_credit: 'Cancellations', supplier_return: 'Supplier returns', opening: 'Opening capital', manual: 'Manual journals', reversal: 'Reversals' } as Record<string, string>)[r] ?? r;
  const closed = db.meta.lockedUntil && day <= db.meta.lockedUntil;
  return (
    <div className="col gap-16">
      <div className="row wrap"><Field label="Business day"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field><div style={{ alignSelf: 'flex-end' }}><Badge tone={closed ? 'good' : 'warn'} dot>{closed ? <Tx>{'Posted & closed'}</Tx> : <Tx>{'Provisional (period open)'}</Tx>}</Badge></div></div>
      <Banner><Tx>Brought-forward from</Tx>{' '}<b>{dateFmt(prev)}</b>{' '}<Tx>→ movements on</Tx>{' '}<b>{dateFmt(day)}</b>{' '}<Tx>→ carried-forward closing. Sales, receipts, settlement and profit are kept separate — never mixed into one figure.</Tx></Banner>
      <div className="grid g3">
        {sections.map((s) => { const x = acc(s.pred); const det = bySrc(s.pred); return (
          <Card key={s.title} title={s.title} sub={s.note}>
            <div className="row between"><span className="muted"><Tx>Brought forward</Tx></span><b>{money(x.o)}</b></div>
            {det.map(([k, v]) => <div key={k} className="row between" style={{ fontSize: 13, paddingLeft: 12 }}><span>{v >= 0 ? '+' : '−'} <Tx>{label(k)}</Tx></span><span className="num">{money(Math.abs(v))}</span></div>)}
            {!det.length && <div className="muted" style={{ fontSize: 13, paddingLeft: 12 }}><Tx>No movements</Tx></div>}
            <div className="divider" style={{ margin: '8px 0' }} />
            <div className="row between"><b><Tx>Carried forward</Tx></b><b>{money(x.c)}</b></div>
            <div className="muted" style={{ fontSize: 11.5 }}><Tx>check:</Tx>{' '}{money(x.o)} {x.a >= 0 ? '+' : '−'} {money(Math.abs(x.a))} = {money(r2(x.o + x.a))}</div>
          </Card>); })}
        <Card title="Sales for the day" sub="recognised orders, ex VAT">
          {t ? (<div className="col gap-6"><div className="row between"><span className="muted"><Tx>Orders</Tx></span><b>{t.orders}</b></div><div className="row between"><span className="muted"><Tx>Gross sales</Tx></span><span>{money(t.gross)}</span></div><div className="row between"><span className="muted"><Tx>Discounts</Tx></span><span>−{money(t.discount)}</span></div><div className="row between"><span className="muted"><Tx>Returns</Tx></span><span>−{money(t.returns)}</span></div><div className="row between"><b><Tx>Net sales</Tx></b><b>{money(t.net)}</b></div></div>) : <div className="muted"><Tx>No recognised sales on this day.</Tx></div>}
        </Card>
      </div>
    </div>
  );
}
function sumA(db: DB, b: ReturnType<typeof balancesBetween>, pred: (a: Account) => boolean) {
  return r2(db.accounts.filter((a) => a.posting && pred(a)).reduce((s, a) => s + natBal(a, b[a.code]), 0));
}

function Sales() {
  const db = useDB();
  const [from, setFrom] = useState(dayKey(addDays(new Date(), -13)));
  const [to, setTo] = useState(dayKey(new Date()));
  const [ch, setCh] = useState('');
  const canCost = useHas('finance:profit');
  const { orders } = useEcon({ from, to, channels: ch ? [ch as never] : undefined });
  const byDay = useMemo(() => Object.entries(groupEcon(orders, (e) => e.day)).sort((a, b) => a[0].localeCompare(b[0])), [orders]);
  const rows = byDay.map(([d, v]) => ({ d, ...v }));
  return (
    <Card flush title="Daily sales" actions={<><Select sm style={{ width: 'auto' }} value={ch} onChange={(e) => setCh(e.target.value)}><option value="">All channels</option>{CHANNEL_LIST.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select><Input type="date" sm value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" sm value={to} onChange={(e) => setTo(e.target.value)} /><Button size="sm" onClick={() => download('sales.csv', toCSV([['Day', 'Orders', 'Gross', 'Discount', 'Returns', 'Net', ...(canCost ? ['COGS', 'Gross profit'] : [])], ...rows.map((r) => [r.d, r.orders, r.gross, r.discount, r.returns, r.net, ...(canCost ? [r.cogs, r.grossProfit] : [])])]))}><Download size={14} />{' '}<Tx>CSV</Tx></Button></>}>
      <DataTable rows={rows} rowKey={(r) => r.d} pageSize={16}
        cols={[{ key: 'd', header: 'Day', sort: (r) => r.d, render: (r) => dateFmt(r.d) }, { key: 'o', header: 'Orders', num: true, render: (r) => r.orders }, { key: 'g', header: 'Gross', num: true, render: (r) => money0(r.gross) }, { key: 'di', header: 'Discounts', num: true, render: (r) => money0(r.discount) }, { key: 'r', header: 'Returns', num: true, render: (r) => money0(r.returns) }, { key: 'n', header: 'Net sales', num: true, sort: (r) => r.net, render: (r) => <b>{money0(r.net)}</b> },
          ...(canCost ? [{ key: 'c', header: 'COGS', num: true, render: (r: typeof rows[number]) => money0(r.cogs) }, { key: 'gp', header: 'Gross profit', num: true, render: (r: typeof rows[number]) => money0(r.grossProfit) }] : [])]} />
    </Card>
  );
}

function AR() {
  const db = useDB();
  const aging = useMemo(() => agingFor(db, new Date().toISOString(), (cid) => db.customers.find((c) => c.id === cid)?.creditDays ?? 0), [db.orders, db.allocations]);
  const rows = Object.entries(aging).map(([id, b]) => ({ id, b, total: b.reduce((s, x) => s + x, 0) })).filter((r) => r.total > 0.004);
  const tot = AGING_BUCKETS.map((_, i) => rows.reduce((s, r) => s + r.b[i], 0));
  return (
    <Card flush title="Customer receivables aging" sub="Buckets are days past each customer's credit terms">
      <DataTable rows={rows} rowKey={(r) => r.id} pageSize={14} footerRow={<tr className="total"><td><Tx>Total</Tx></td>{tot.map((x, i) => <td key={i} className="num">{money0(x)}</td>)}<td className="num">{money0(tot.reduce((s, x) => s + x, 0))}</td></tr>}
        cols={[{ key: 'c', header: 'Customer', render: (r) => <b>{db.customers.find((c) => c.id === r.id)?.name}</b> }, ...AGING_BUCKETS.map((b, i) => ({ key: 'b' + i, header: b, num: true, render: (r: typeof rows[number]) => (r.b[i] ? money0(r.b[i]) : '–') })), { key: 't', header: 'Total', num: true, render: (r) => <b>{money0(r.total)}</b> }]} />
    </Card>
  );
}
function AP() {
  const db = useDB();
  const open = db.apInvoices.filter((i) => apOpen(i) > 0.004);
  const bucket = (i: typeof open[number]) => { const late = daysBetween(i.dueDate, new Date()); return late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4; };
  const by: Record<string, number[]> = {};
  for (const i of open) (by[i.supplierId] ||= [0, 0, 0, 0, 0])[bucket(i)] += apOpen(i);
  const rows = Object.entries(by).map(([id, b]) => ({ id, b, total: b.reduce((s, x) => s + x, 0) }));
  return (
    <Card flush title="Supplier payables aging" sub="Buckets are days past due date">
      <DataTable rows={rows} rowKey={(r) => r.id} cols={[{ key: 's', header: 'Supplier', render: (r) => <b>{db.suppliers.find((s) => s.id === r.id)?.name}</b> }, ...AGING_BUCKETS.map((b, i) => ({ key: 'b' + i, header: b, num: true, render: (r: typeof rows[number]) => (r.b[i] ? money0(r.b[i]) : '–') })), { key: 't', header: 'Total', num: true, render: (r) => <b>{money0(r.total)}</b> }]} />
    </Card>
  );
}
function Inventory() {
  const db = useDB();
  const rows = db.warehouses.map((w) => ({ w, v: stockValue(db, w.id) }));
  const byKind: Record<string, number> = {};
  for (const k in db.balances) { const p = db.products.find((x) => x.id === k.split('|')[1]); if (p) byKind[p.kind] = (byKind[p.kind] || 0) + db.balances[k].value; }
  return (
    <div className="grid g2">
      <Card flush title="By warehouse"><DataTable rows={rows} rowKey={(r) => r.w.id} cols={[{ key: 'w', header: 'Warehouse', render: (r) => r.w.name }, { key: 'v', header: 'Value', num: true, render: (r) => money(r.v) }]} footerRow={<tr className="total"><td><Tx>Total</Tx></td><td className="num">{money(stockValue(db))}</td></tr>} /></Card>
      <Card flush title="By type"><DataTable rows={Object.entries(byKind)} rowKey={(r) => r[0]} cols={[{ key: 'k', header: 'Type', render: (r) => r[0] }, { key: 'v', header: 'Value', num: true, render: (r) => money(r[1]) }]} /></Card>
    </div>
  );
}
export const _rp = [Printer, Button];
