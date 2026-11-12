import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useDB } from '../domain/store';
import { balancesBetween, netDebit, sumNetDebit } from '../domain/accounting';
import { cashFlowReport, expenseAnalysis, inventoryRollforward, settlementRecon, vatReport } from '../domain/setup';
import type { Account, ChannelCode, DB, FsLine } from '../domain/types';
import { Badge, Button, Card, ChannelChip, DataTable, Empty, Field, Input, Kpi, ReportHead, Select } from '../ui/kit';
import { CHANNEL_LIST } from '../domain/meta';
import { dateFmt, dayKey, download, money, r2, toCSV, addDays } from '../lib/util';

const monthStart = () => dayKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
const Range = ({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) => (
  <><Input type="date" sm value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" /><Input type="date" sm value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" /></>
);

export function TrialBalance() {
  const db = useDB();
  const [asOf, setAsOf] = useState(dayKey(new Date()));
  const bal = useMemo(() => balancesBetween(db.journals, undefined, asOf), [db.journals, asOf]);
  const rows = db.accounts.filter((a) => a.posting).map((a) => { const net = netDebit(bal[a.code]); return { a, dr: net > 0 ? net : 0, cr: net < 0 ? -net : 0 }; }).filter((r) => r.dr || r.cr);
  const td = r2(rows.reduce((s, r) => s + r.dr, 0)), tc = r2(rows.reduce((s, r) => s + r.cr, 0));
  return (
    <Card flush title="Trial balance" actions={<><Input type="date" sm value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="As of date" /><Button size="sm" onClick={() => download('trial-balance.csv', toCSV([['Code', 'Account', 'Debit', 'Credit'], ...rows.map((r) => [r.a.code, r.a.name, r.dr, r.cr])]))}><Download size={14} /> CSV</Button></>}>
      <ReportHead title="Trial balance" to={asOf} />
      <table className="t compact"><thead><tr><th>Code</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.a.code}><td className="mono">{r.a.code}</td><td>{r.a.name}<div className="sub">{r.a.nameTh}</div></td><td className="num">{r.dr ? money(r.dr) : ''}</td><td className="num">{r.cr ? money(r.cr) : ''}</td></tr>)}</tbody>
        <tfoot><tr className="total"><td colSpan={2}>Total {Math.abs(td - tc) < 0.005 ? <Badge tone="good">balanced</Badge> : <Badge tone="bad">OUT OF BALANCE</Badge>}</td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td></tr></tfoot></table>
    </Card>
  );
}

const SEC: { fs: FsLine[]; title: string }[] = [];
void SEC;
function sectionRows(d: DB, bal: ReturnType<typeof balancesBetween>, fs: FsLine[], sign: 1 | -1) {
  return d.accounts.filter((a) => a.posting && fs.includes(a.fsLine)).map((a) => ({ a, v: r2(sign * netDebit(bal[a.code])) })).filter((x) => Math.abs(x.v) > 0.004);
}
export function ProfitLoss() {
  const db = useDB();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const [branch, setBranch] = useState('');
  const [channel, setChannel] = useState('');
  const b = useMemo(() => balancesBetween(db.journals, from, to, { branchId: branch || undefined, channel: (channel || undefined) as ChannelCode | undefined }), [db.journals, from, to, branch, channel]);
  const rev = sectionRows(db, b, ['revenue'], -1), contra = sectionRows(db, b, ['contra_revenue'], 1), cogs = sectionRows(db, b, ['cogs'], 1), chan = sectionRows(db, b, ['channel_costs'], 1), opex = sectionRows(db, b, ['opex'], 1), oi = sectionRows(db, b, ['other_income'], -1), oe = sectionRows(db, b, ['other_expense'], 1);
  const sum = (x: { v: number }[]) => r2(x.reduce((s, y) => s + y.v, 0));
  const net = r2(sum(rev) - sum(contra)), gp = r2(net - sum(cogs)), op = r2(gp - sum(chan) - sum(opex)), np = r2(op + sum(oi) - sum(oe));
  const Sub = ({ t, x }: { t: string; x: { a: Account; v: number }[] }) => <>{x.map((y) => <tr key={y.a.code}><td style={{ paddingLeft: 28 }}><span className="mono muted">{y.a.code}</span> {y.a.name}</td><td className="num">{money(y.v)}</td><td className="num muted">{net ? ((y.v / net) * 100).toFixed(1) + '%' : ''}</td></tr>)}{!x.length && <tr><td style={{ paddingLeft: 28 }} className="muted">{t}: none in this period</td><td /><td /></tr>}</>;
  const Tot = ({ l, v }: { l: string; v: number }) => <tr className="total"><td>{l}</td><td className="num">{money(v)}</td><td className="num muted">{net ? ((v / net) * 100).toFixed(1) + '%' : ''}</td></tr>;
  return (
    <Card flush title="Profit & loss" actions={<><Select sm style={{ width: 'auto' }} value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch"><option value="">All branches</option>{db.branches.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select><Select sm style={{ width: 'auto' }} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel"><option value="">All channels</option>{CHANNEL_LIST.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select><Range from={from} to={to} setFrom={setFrom} setTo={setTo} /></>}>
      <ReportHead title="Profit & loss" from={from} to={to} scope={branch || channel ? `filtered: ${[db.branches.find((x) => x.id === branch)?.name, channel].filter(Boolean).join(' / ')} (dimension-tagged postings only)` : 'all branches & channels, ex VAT'} />
      <table className="t"><thead><tr><th>Line (by financial-statement line mapping)</th><th className="num">Amount</th><th className="num">% of net sales</th></tr></thead><tbody>
        <Sub t="Revenue" x={rev} /><Sub t="Contra revenue" x={contra.map((y) => ({ ...y, v: -y.v }))} /><Tot l="Net sales" v={net} />
        <Sub t="Cost of sales" x={cogs.map((y) => ({ ...y, v: -y.v }))} /><Tot l="Gross profit" v={gp} />
        <Sub t="Channel costs" x={chan.map((y) => ({ ...y, v: -y.v }))} /><Sub t="Operating expenses" x={opex.map((y) => ({ ...y, v: -y.v }))} /><Tot l="Operating profit" v={op} />
        <Sub t="Other income" x={oi} /><Sub t="Other expenses" x={oe.map((y) => ({ ...y, v: -y.v }))} /><Tot l="Net profit" v={np} />
      </tbody></table>
    </Card>
  );
}

export function BalanceSheet() {
  const db = useDB();
  const [asOf, setAsOf] = useState(dayKey(new Date()));
  const b = useMemo(() => balancesBetween(db.journals, undefined, asOf), [db.journals, asOf]);
  // contra accounts (accumulated depreciation, drawings…) must reduce their section: assets = debit − credit, liabilities & equity = credit − debit
  const nat = (fs: FsLine[], sign: 1 | -1) => db.accounts.filter((a) => a.posting && fs.includes(a.fsLine)).map((a) => ({ a, v: r2(sign * netDebit(b[a.code])) })).filter((x) => Math.abs(x.v) > 0.004);
  const assets = nat(['cash', 'receivables', 'inventory', 'tax_asset', 'other_assets', 'fixed_assets'], 1);
  const liab = nat(['payables', 'tax_payable', 'customer_liabilities', 'loans'], -1);
  const eq = nat(['equity'], -1);
  const earnings = r2(-sumNetDebit(db, b, (a) => (a.type === 'revenue' || a.type === 'expense') && a.posting));
  const A = r2(assets.reduce((s, x) => s + x.v, 0)), L = r2(liab.reduce((s, x) => s + x.v, 0)), E = r2(eq.reduce((s, x) => s + x.v, 0) + earnings);
  const Block = ({ title, rows, extra, total }: { title: string; rows: { a: Account; v: number }[]; extra?: [string, number][]; total: number }) => (
    <Card title={title} flush><table className="t compact"><tbody>{rows.map((x) => <tr key={x.a.code}><td><span className="mono muted">{x.a.code}</span> {x.a.name}</td><td className="num">{money(x.v)}</td></tr>)}{extra?.map(([l, x]) => <tr key={l}><td>{l}</td><td className="num">{money(x)}</td></tr>)}</tbody><tfoot><tr className="total"><td>Total {title.toLowerCase()}</td><td className="num">{money(total)}</td></tr></tfoot></table></Card>
  );
  return (
    <div className="col gap-16">
      <div className="card"><ReportHead title="Balance sheet" to={asOf} />
        <div className="row card-b"><Field label="As of"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><div style={{ alignSelf: 'flex-end' }}>{Math.abs(A - L - E) < 0.05 ? <Badge tone="good">Assets = Liabilities + Equity</Badge> : <Badge tone="bad">does not balance by {money(A - L - E)}</Badge>}</div></div></div>
      <div className="grid g3"><Block title="Assets" rows={assets} total={A} /><Block title="Liabilities" rows={liab} total={L} /><Block title="Equity" rows={eq} extra={[['Current earnings (P&L to date)', earnings]]} total={E} /></div>
    </div>
  );
}

export function GeneralLedger() {
  const db = useDB();
  const [acct, setAcct] = useState('1110');
  const [from, setFrom] = useState(dayKey(addDays(new Date(), -14)));
  const [to, setTo] = useState(dayKey(new Date()));
  const a = db.accounts.find((x) => x.code === acct) ?? db.accounts[0];
  const { rows, opening } = useMemo(() => {
    let run = 0;
    for (const j of db.journals) if (dayKey(j.date) < from) for (const l of j.lines) if (l.account === a.code) run += a.normal === 'debit' ? l.debit - l.credit : l.credit - l.debit;
    const opening = r2(run);
    const rows: { jn: string; memo: string; date: string; dr: number; cr: number; bal: number; key: string }[] = [];
    for (const j of db.journals) {
      const k = dayKey(j.date);
      if (k < from || k > to) continue;
      j.lines.forEach((l, i) => { if (l.account === a.code) { run += a.normal === 'debit' ? l.debit - l.credit : l.credit - l.debit; rows.push({ jn: j.no, memo: j.memo, date: j.date, dr: l.debit, cr: l.credit, bal: r2(run), key: j.id + i }); } });
    }
    return { rows, opening };
  }, [db.journals, a, from, to]);
  return (
    <Card flush title="General ledger" actions={<><Select sm style={{ width: 260 }} value={acct} onChange={(e) => setAcct(e.target.value)} aria-label="Account">{db.accounts.filter((x) => x.posting).map((x) => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}</Select><Range from={from} to={to} setFrom={setFrom} setTo={setTo} /></>}>
      <ReportHead title={`General ledger — ${a.code} ${a.name}`} from={from} to={to} />
      <DataTable rows={rows} rowKey={(r) => r.key} pageSize={15} empty={<Empty title="No postings in this period" />}
        cols={[{ key: 'd', header: 'Date', render: (r) => dayKey(r.date) }, { key: 'j', header: 'Journal', render: (r) => <>{r.jn}<div className="sub">{r.memo}</div></> }, { key: 'dr', header: 'Debit', num: true, render: (r) => (r.dr ? money(r.dr) : '') }, { key: 'cr', header: 'Credit', num: true, render: (r) => (r.cr ? money(r.cr) : '') }, { key: 'b', header: 'Balance', num: true, render: (r) => money(r.bal) }]} />
      <div className="card-f">Opening balance {money(opening)} · {a.nameTh} · {a.normal}-normal</div>
    </Card>
  );
}

export function CashFlow() {
  const db = useDB();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const r = useMemo(() => cashFlowReport(db, from, to), [db.journals, from, to]); // eslint-disable-line
  const groups: { cls: 'operating' | 'financing' | 'investing' | 'internal'; title: string }[] = [{ cls: 'operating', title: 'Operating activities' }, { cls: 'financing', title: 'Financing activities (loans, owner funds)' }, { cls: 'investing', title: 'Investing activities' }, { cls: 'internal', title: 'Transfers between own accounts (no net effect)' }];
  return (
    <Card flush title="Cash flow (direct method)" actions={<Range from={from} to={to} setFrom={setFrom} setTo={setTo} />}>
      <ReportHead title="Cash flow" from={from} to={to} scope="cash & bank accounts, classified by source document" />
      <table className="t compact"><thead><tr><th>Source</th><th className="num">Inflow</th><th className="num">Outflow</th><th className="num">Net</th></tr></thead>
        <tbody>
          <tr className="total"><td>Opening cash & bank</td><td /><td /><td className="num">{money(r.opening)}</td></tr>
          {groups.map((g) => { const rows = r.rows.filter((x) => x.cls === g.cls); if (!rows.length) return null; return (<>
            <tr key={g.cls}><td colSpan={4} style={{ fontWeight: 650, background: 'var(--surface-2)' }}>{g.title}</td></tr>
            {rows.map((x) => <tr key={g.cls + x.label}><td style={{ paddingLeft: 28 }}>{x.label}</td><td className="num">{x.inflow ? money(x.inflow) : ''}</td><td className="num">{x.outflow ? money(x.outflow) : ''}</td><td className="num">{money(x.inflow - x.outflow)}</td></tr>)}
          </>); })}
          <tr className="total"><td>Net cash from operating</td><td /><td /><td className="num">{money(r.operating)}</td></tr>
          <tr className="total"><td>Net cash from financing</td><td /><td /><td className="num">{money(r.financing)}</td></tr>
          <tr className="total"><td>Closing cash & bank</td><td /><td /><td className="num">{money(r.closing)}</td></tr>
        </tbody></table>
      <div className="card-f">{Math.abs(r.check) < 0.01 ? <Badge tone="good">Opening + movements = closing</Badge> : <Badge tone="bad">unexplained difference {money(r.check)}</Badge>} · Loan principal, owner funds and transfers are never shown as revenue or expense.</div>
    </Card>
  );
}

export function VatReport() {
  const db = useDB();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const r = useMemo(() => vatReport(db, from, to), [db.orders, db.returns, db.apInvoices, db.expenses, from, to]); // eslint-disable-line
  return (
    <div className="col gap-16">
      <div className="card"><ReportHead title="VAT report" from={from} to={to} scope="tax code, rate and rule version are read from each transaction (not today's setting)" />
        <div className="row wrap card-b"><Range from={from} to={to} setFrom={setFrom} setTo={setTo} /><Button size="sm" onClick={() => download('vat-report.csv', toCSV([['Type', 'Document', 'Date', 'Tax code', 'Base', 'VAT'], ...r.sales.map((s) => ['Sale', s.doc, dayKey(s.date), s.code, s.base, s.vat]), ...r.returns.map((s) => ['Return', s.doc, dayKey(s.date), '', s.base, s.vat]), ...r.purchases.map((s) => ['Purchase', s.doc, dayKey(s.date), 'VAT7', s.base, s.vat]), ...r.expenses.map((s) => ['Expense', s.doc, dayKey(s.date), 'VAT7', s.base, s.vat])]))}><Download size={14} /> CSV</Button></div></div>
      <div className="grid g4">
        <Kpi label="Output VAT (net of returns)" value={money(r.outputVat)} sub={`${r.sales.length} sales · ${r.returns.length} returns`} />
        <Kpi label="Input VAT (purchases + expenses)" value={money(r.inputVat)} sub={`${r.purchases.length + r.expenses.length} documents`} />
        <Kpi label="Net VAT payable / (refundable)" value={money(r.netPayable)} tone={r.netPayable < 0 ? 'good' : undefined} sub="before any adjustments" />
        <Kpi label="Tax codes used" value={Object.keys(r.byCode).length} sub={Object.keys(r.byCode).join(', ') || '–'} />
      </div>
      <Card title="Taxable sales by tax code" flush><table className="t compact"><thead><tr><th>Tax code</th><th className="num">Documents</th><th className="num">Taxable base</th><th className="num">VAT</th></tr></thead><tbody>{Object.entries(r.byCode).map(([k, v]) => <tr key={k}><td><b>{k}</b></td><td className="num">{v.n}</td><td className="num">{money(r2(v.base))}</td><td className="num">{money(r2(v.vat))}</td></tr>)}</tbody></table></Card>
      <Card title="Purchase & expense VAT listing" flush>
        <DataTable rows={[...r.purchases, ...r.expenses]} rowKey={(x) => x.doc} pageSize={8} empty={<Empty title="No input VAT in this period" />} compact
          cols={[{ key: 'd', header: 'Document', render: (x) => <><b>{x.doc}</b><div className="sub">{x.kind} · {dateFmt(x.date)}</div></> }, { key: 'b', header: 'Base', num: true, render: (x) => money(x.base) }, { key: 'v', header: 'VAT', num: true, render: (x) => money(x.vat) }]} />
      </Card>
    </div>
  );
}

export function SettlementRecon() {
  const db = useDB();
  const rows = useMemo(() => settlementRecon(db), [db.orders, db.settlements]); // eslint-disable-line
  return (
    <Card flush title="Marketplace & delivery settlement reconciliation">
      <ReportHead title="Settlement reconciliation" to={dayKey(new Date())} scope="platform receivable cleared against bank receipts; fees and differences shown separately" />
      <table className="t compact"><thead><tr><th>Channel</th><th className="num">Billed (net of returns)</th><th className="num">Settled gross</th><th className="num">Fees deducted</th><th className="num">Received in bank</th><th className="num">Variance</th><th className="num">Awaiting bank</th><th className="num">Not yet settled</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.channel}><td><ChannelChip c={r.channel as ChannelCode} /></td><td className="num">{money(r.billed)}</td><td className="num">{money(r.settledGross)}</td><td className="num">−{money(r.fees)}</td><td className="num">{money(r.received)}</td><td className={r.variance ? 'num bad' : 'num'}>{money(r.variance)}</td><td className="num">{money(r.pendingNet)}</td><td className="num"><b>{money(r.outstanding)}</b><div className="sub">{r.unsettledOrders} orders</div></td></tr>)}</tbody></table>
      <div className="card-f">Billed − settled gross = platform receivable (GL control account). Received = settled gross − fees ± variance.</div>
    </Card>
  );
}

export function InventoryCogs() {
  const db = useDB();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const r = useMemo(() => inventoryRollforward(db, from, to), [db.journals, from, to]); // eslint-disable-line
  return (
    <Card flush title="Inventory roll-forward & cost of sales" actions={<Range from={from} to={to} setFrom={setFrom} setTo={setTo} />}>
      <ReportHead title="Inventory roll-forward" from={from} to={to} scope="inventory control accounts at weighted-average cost" />
      <table className="t compact"><thead><tr><th>Movement</th><th className="num">Amount</th></tr></thead>
        <tbody><tr className="total"><td>Opening inventory</td><td className="num">{money(r.opening)}</td></tr>{r.movements.map((m) => <tr key={m.key}><td style={{ paddingLeft: 28 }}>{m.amount >= 0 ? '+' : '−'} {m.label}</td><td className="num">{money(Math.abs(m.amount))}</td></tr>)}<tr className="total"><td>Closing inventory</td><td className="num">{money(r.closing)}</td></tr></tbody></table>
      <div className="card-f">Cost-of-sales accounts in the period (COGS, waste, adjustments, net of absorbed conversion): <b>{money(r.cogsAccounts)}</b> · {Math.abs(r.check) < 0.01 ? <Badge tone="good">roll-forward ties</Badge> : <Badge tone="bad">difference {money(r.check)}</Badge>}</div>
    </Card>
  );
}

export function ExpenseAnalysis() {
  const db = useDB();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const rows = useMemo(() => expenseAnalysis(db, from, to), [db.journals, from, to]); // eslint-disable-line
  const total = r2(rows.reduce((s, r) => s + r.amount, 0));
  return (
    <Card flush title="Expense analysis by account and branch" actions={<Range from={from} to={to} setFrom={setFrom} setTo={setTo} />}>
      <ReportHead title="Expense analysis" from={from} to={to} scope="operating, channel and other expense accounts" />
      <DataTable rows={rows} rowKey={(r) => r.account + r.branch} pageSize={14} empty={<Empty title="No expenses in this period" />}
        cols={[{ key: 'a', header: 'Account', render: (r) => <><span className="mono muted">{r.account}</span> {db.accounts.find((a) => a.code === r.account)?.name}</> }, { key: 'b', header: 'Branch', render: (r) => (r.branch ? db.branches.find((b) => b.id === r.branch)?.name : <span className="muted">unallocated</span>) }, { key: 'm', header: 'Amount', num: true, sort: (r) => r.amount, render: (r) => money(r.amount) }]}
        footerRow={<tr className="total"><td colSpan={2}>Total</td><td className="num">{money(total)}</td></tr>} />
    </Card>
  );
}
