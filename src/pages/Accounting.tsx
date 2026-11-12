import { useMemo, useState } from 'react';
import { Lock, Plus, Trash2, Unlock } from 'lucide-react';
import { useDB } from '../domain/store';
import { EXPENSE_ACCOUNTS, addExpense, balancesBetween, closePeriod, natBal, netDebit, postManualJournal, reopenPeriod, reverseJournal } from '../domain/accounting';
import { Badge, Banner, Button, Card, Check, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun } from '../ui/kit';
import { dateFmt, dateTimeFmt, dayKey, money, money0, r2, addDays, download, toCSV } from '../lib/util';
import type { Journal } from '../domain/types';
import { Link } from 'react-router-dom';

type Tab = 'journal' | 'tb' | 'pl' | 'bs' | 'gl' | 'expenses' | 'cash' | 'periods';
const REF_LABEL: Record<string, string> = { order: 'Sale', receipt: 'Receipt', grn: 'Goods receipt', supplier_payment: 'Supplier payment', production: 'Production', transfer: 'Transfer', settlement: 'Settlement', expense: 'Expense', manual: 'Manual', reversal: 'Reversal', return: 'Return', stock_adjust: 'Stock adj.', count: 'Count', opening: 'Opening' };

export default function Accounting() {
  const db = useDB();
  const [tab, setTab] = useState<Tab>('journal');
  const bal = useMemo(() => balancesBetween(db.journals), [db.journals]);
  const a = (c: string) => natBal(db.accounts.find((x) => x.code === c)!, bal[c]);
  const canCreate = useHas('accounting:create');
  const [manual, setManual] = useState(false);
  return (
    <>
      <PageHead title="Accounting" desc="Double-entry ledger posted automatically by sales, receipts, purchases, production, settlements and stock events. Mistakes are fixed with reversal entries — nothing is silently overwritten."
        actions={canCreate && <Button variant="primary" onClick={() => setManual(true)}><Plus size={15} /> Manual journal</Button>} />
      <div className="mb16"><Banner tone="warn"><b>For review by a qualified Thai accountant before production use:</b> chart of accounts, VAT / tax-invoice handling, withholding tax, and period-close practice are simplified in this prototype.</Banner></div>
      <div className="grid g4 mb16">
        <Kpi label="Cash & bank" value={money0(a('1100') + a('1110'))} sub="1100 + 1110" />
        <Kpi label="Receivables" value={money0(a('1130') + a('1120'))} sub="customers + platforms" />
        <Kpi label="Payables" value={money0(a('2100'))} sub="suppliers" />
        <Kpi label="Period locked through" value={db.meta.lockedUntil ? dateFmt(db.meta.lockedUntil) : 'None'} sub={`${db.journals.length.toLocaleString()} journals`} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'journal', label: 'Journal' }, { v: 'tb', label: 'Trial balance' }, { v: 'pl', label: 'Profit & loss' }, { v: 'bs', label: 'Balance sheet' }, { v: 'gl', label: 'General ledger' }, { v: 'expenses', label: 'Expenses' }, { v: 'cash', label: 'Cash & bank' }, { v: 'periods', label: 'Periods' }]} />
      {tab === 'journal' && <JournalList />}
      {tab === 'tb' && <TrialBalance />}
      {tab === 'pl' && <ProfitLoss />}
      {tab === 'bs' && <BalanceSheet />}
      {tab === 'gl' && <GeneralLedger />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'cash' && <Cash />}
      {tab === 'periods' && <Periods />}
      {manual && <ManualJournal onClose={() => setManual(false)} />}
    </>
  );
}

function JournalList() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canRev = useHas('accounting:approve');
  const [ref, setRef] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => db.journals.filter((j) => !ref || j.refType === ref).slice().reverse(), [db.journals, ref]);
  const refs = Array.from(new Set(db.journals.map((j) => j.refType)));
  const j = open ? db.journals.find((x) => x.id === open) : undefined;
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(x) => x.id} pageSize={15} onRow={(x) => setOpen(x.id)} search={(x) => x.no + x.memo}
        toolbar={<Select sm style={{ width: 'auto' }} value={ref} onChange={(e) => setRef(e.target.value)}><option value="">All sources</option>{refs.map((r) => <option key={r} value={r}>{REF_LABEL[r] ?? r}</option>)}</Select>}
        cols={[
          { key: 'no', header: 'Journal', sort: (x) => x.no, render: (x) => <><b>{x.no}</b><div className="sub">{dateTimeFmt(x.date)}</div></> },
          { key: 'm', header: 'Memo', render: (x) => x.memo }, { key: 'r', header: 'Source', hideSm: true, render: (x) => <Badge tone={x.refType === 'manual' ? 'warn' : x.refType === 'reversal' ? 'bad' : ''}>{REF_LABEL[x.refType] ?? x.refType}</Badge> },
          { key: 'a', header: 'Amount', num: true, render: (x) => money(x.lines.reduce((s, l) => s + l.debit, 0)) }, { key: 's', header: '', render: (x) => (x.status === 'reversed' ? <Badge tone="bad">reversed</Badge> : null) },
        ]} />
      {j && (
        <Modal title={`${j.no} — ${j.memo}`} desc={`${dateTimeFmt(j.date)} · ${REF_LABEL[j.refType] ?? j.refType} · by ${db.users.find((u) => u.id === j.createdBy)?.name ?? j.createdBy}`} onClose={() => setOpen(null)}
          footer={canRev && j.status === 'posted' && !j.reverses ? <Button variant="danger" onClick={async () => { const x = await confirm({ title: `Reverse ${j.no}?`, body: 'A new journal with debits and credits swapped is posted. The original is kept and marked reversed.', reason: true, danger: true, confirmLabel: 'Post reversal' }); if (x.ok) run((d, c) => reverseJournal(d, c, j.id, x.reason), { ok: 'Reversal posted', perm: 'accounting:approve', onOk: () => setOpen(null) }); }}>Reverse entry</Button> : undefined}>
          <table className="t compact"><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>{j.lines.map((l, i) => <tr key={i}><td><b>{l.account}</b> {db.accounts.find((a) => a.code === l.account)?.name}</td><td className="num">{l.debit ? money(l.debit) : ''}</td><td className="num">{l.credit ? money(l.credit) : ''}</td></tr>)}</tbody>
            <tfoot><tr className="total"><td>Total</td><td className="num">{money(j.lines.reduce((s, l) => s + l.debit, 0))}</td><td className="num">{money(j.lines.reduce((s, l) => s + l.credit, 0))}</td></tr></tfoot></table>
          {j.status === 'reversed' && <div className="mt8"><Badge tone="bad">Reversed by {db.journals.find((x) => x.id === j.reversedBy)?.no}</Badge></div>}
          {j.reverses && <div className="mt8"><Badge>Reversal of {db.journals.find((x) => x.id === j.reverses)?.no}</Badge></div>}
        </Modal>
      )}
    </Card>
  );
}

function ManualJournal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [date, setDate] = useState(dayKey(new Date()));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<{ account: string; debit: number; credit: number }[]>([{ account: '6300', debit: 0, credit: 0 }, { account: '1100', debit: 0, credit: 0 }]);
  const td = r2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const tc = r2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  return (
    <Modal title="Manual journal entry" size="lg" onClose={onClose} footer={<><div className="grow">{Math.abs(td - tc) < 0.005 && td > 0 ? <Badge tone="good">balanced</Badge> : <Badge tone="bad">out of balance by {money(td - tc)}</Badge>}</div><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!memo.trim() || Math.abs(td - tc) > 0.005 || td <= 0} onClick={() => run((d, c) => postManualJournal(d, c, { date: new Date(date + 'T12:00:00').toISOString(), memo, lines: lines.map((l) => ({ account: l.account, debit: l.debit || 0, credit: l.credit || 0 })) }), { ok: 'Journal posted (audited)', perm: 'accounting:create', onOk: onClose })}>Post</Button></>}>
      <div className="form-grid"><Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Field label="Memo"><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field></div>
      <table className="t compact mt16"><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={i}><td><Select sm value={l.account} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, account: e.target.value } : x)))}>{db.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</Select></td><td className="num"><NumInput style={{ width: 120 }} value={l.debit || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, debit: n || 0, credit: n ? 0 : x.credit } : x)))} /></td><td className="num"><NumInput style={{ width: 120 }} value={l.credit || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, credit: n || 0, debit: n ? 0 : x.debit } : x)))} /></td><td><Button size="sm" variant="ghost" icon onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 size={13} /></Button></td></tr>)}</tbody>
        <tfoot><tr className="total"><td>Total</td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td><td /></tr></tfoot></table>
      <div className="mt8"><Button size="sm" onClick={() => setLines([...lines, { account: '6300', debit: 0, credit: 0 }])}><Plus size={13} /> Add line</Button></div>
    </Modal>
  );
}

function TrialBalance() {
  const db = useDB();
  const [asOf, setAsOf] = useState(dayKey(new Date()));
  const bal = useMemo(() => balancesBetween(db.journals, undefined, asOf), [db.journals, asOf]);
  const rows = db.accounts.map((a) => { const b = bal[a.code]; const net = netDebit(b); return { a, dr: net > 0 ? net : 0, cr: net < 0 ? -net : 0 }; }).filter((r) => r.dr || r.cr);
  const td = r2(rows.reduce((s, r) => s + r.dr, 0)), tc = r2(rows.reduce((s, r) => s + r.cr, 0));
  return (
    <Card flush title="Trial balance" actions={<><Input type="date" sm value={asOf} onChange={(e) => setAsOf(e.target.value)} /><Button size="sm" onClick={() => download('trial-balance.csv', toCSV([['Code', 'Account', 'Debit', 'Credit'], ...rows.map((r) => [r.a.code, r.a.name, r.dr, r.cr])]))}>CSV</Button></>}>
      <table className="t compact"><thead><tr><th>Code</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.a.code}><td className="mono">{r.a.code}</td><td>{r.a.name}</td><td className="num">{r.dr ? money(r.dr) : ''}</td><td className="num">{r.cr ? money(r.cr) : ''}</td></tr>)}</tbody>
        <tfoot><tr className="total"><td colSpan={2}>Total {Math.abs(td - tc) < 0.02 ? <Badge tone="good">balanced</Badge> : <Badge tone="bad">OUT OF BALANCE</Badge>}</td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td></tr></tfoot></table>
    </Card>
  );
}

function ProfitLoss() {
  const db = useDB();
  const [from, setFrom] = useState(dayKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [to, setTo] = useState(dayKey(new Date()));
  const b = useMemo(() => balancesBetween(db.journals, from, to), [db.journals, from, to]);
  const v = (c: string) => { const a = db.accounts.find((x) => x.code === c)!; return natBal(a, b[c]); };
  const sales = v('4000'), disc = v('4100'), ret = v('4200');
  const net = r2(sales - disc - ret);
  const cogs = r2(v('5000') - v('5400')), waste = v('5100'), adj = v('5200');
  const gp = r2(net - cogs - waste - adj);
  const chan = r2(v('6100') + v('6110') + v('6120'));
  const opex = r2(v('6130') + v('6200') + v('6210') + v('6220') + v('6300') + v('6400'));
  const np = r2(gp - chan - opex);
  const Row = ({ l, v: x, bold, indent }: { l: string; v: number; bold?: boolean; indent?: boolean }) => <tr className={bold ? 'total' : ''}><td style={{ paddingLeft: indent ? 28 : undefined }}>{l}</td><td className="num">{money(x)}</td><td className="num muted">{net ? ((x / net) * 100).toFixed(1) + '%' : ''}</td></tr>;
  return (
    <Card flush title="Profit & loss (posted ledger)" sub="Excludes VAT. Based on journals in the selected dates." actions={<><Input type="date" sm value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" sm value={to} onChange={(e) => setTo(e.target.value)} /></>}>
      <table className="t"><thead><tr><th>Line</th><th className="num">Amount</th><th className="num">% of net sales</th></tr></thead><tbody>
        <Row l="Sales revenue" v={sales} indent /><Row l="Less: discounts" v={-disc} indent /><Row l="Less: returns & credit notes" v={-ret} indent /><Row l="Net sales" v={net} bold />
        <Row l="Cost of goods sold (materials + labor & overhead absorbed)" v={-cogs} indent /><Row l="Production waste & spoilage" v={-waste} indent /><Row l="Inventory adjustments & shrinkage" v={-adj} indent /><Row l="Gross profit" v={gp} bold />
        <Row l="Marketplace commission, payment fees, shipping subsidy" v={-chan} indent /><Row l="Operating expenses" v={-opex} indent /><Row l="Net profit" v={np} bold />
      </tbody></table>
    </Card>
  );
}

function BalanceSheet() {
  const db = useDB();
  const [asOf, setAsOf] = useState(dayKey(new Date()));
  const b = useMemo(() => balancesBetween(db.journals, undefined, asOf), [db.journals, asOf]);
  const v = (c: string) => natBal(db.accounts.find((x) => x.code === c)!, b[c]);
  const section = (type: 'asset' | 'liability' | 'equity') => db.accounts.filter((a) => a.type === type).map((a) => ({ a, v: v(a.code) })).filter((x) => Math.abs(x.v) > 0.004);
  const rev = db.accounts.filter((a) => a.type === 'revenue' || a.type === 'expense').reduce((s, a) => s + (a.type === 'revenue' ? 1 : -1) * natBal({ ...a, normal: 'credit' }, b[a.code]), 0);
  const assets = section('asset'), liab = section('liability'), eq = section('equity');
  const A = r2(assets.reduce((s, x) => s + x.v, 0)), L = r2(liab.reduce((s, x) => s + x.v, 0)), E = r2(eq.reduce((s, x) => s + x.v, 0) + rev);
  const Block = ({ title, rows, extra, total }: { title: string; rows: { a: { code: string; name: string }; v: number }[]; extra?: [string, number][]; total: number }) => (
    <Card title={title} flush><table className="t compact"><tbody>{rows.map((x) => <tr key={x.a.code}><td>{x.a.name}</td><td className="num">{money(x.v)}</td></tr>)}{extra?.map(([l, x]) => <tr key={l}><td>{l}</td><td className="num">{money(x)}</td></tr>)}</tbody><tfoot><tr className="total"><td>Total {title.toLowerCase()}</td><td className="num">{money(total)}</td></tr></tfoot></table></Card>
  );
  return (
    <div className="col gap-16">
      <div className="row"><Field label="As of"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><div style={{ alignSelf: 'flex-end' }}>{Math.abs(A - L - E) < 0.05 ? <Badge tone="good">Assets = Liabilities + Equity</Badge> : <Badge tone="bad">does not balance by {money(A - L - E)}</Badge>}</div></div>
      <div className="grid g3"><Block title="Assets" rows={assets} total={A} /><Block title="Liabilities" rows={liab} total={L} /><Block title="Equity" rows={eq} extra={[['Current earnings (all P&L to date)', rev]]} total={E} /></div>
    </div>
  );
}

function GeneralLedger() {
  const db = useDB();
  const [acct, setAcct] = useState('1110');
  const [from, setFrom] = useState(dayKey(addDays(new Date(), -14)));
  const [to, setTo] = useState(dayKey(new Date()));
  const a = db.accounts.find((x) => x.code === acct)!;
  const { rows, opening } = useMemo(() => {
    let run = 0;
    for (const j of db.journals) if (dayKey(j.date) < from) for (const l of j.lines) if (l.account === acct) run += a.normal === 'debit' ? l.debit - l.credit : l.credit - l.debit;
    const opening = r2(run);
    const rows: { j: Journal; dr: number; cr: number; bal: number }[] = [];
    for (const j of db.journals) {
      const k = dayKey(j.date);
      if (k < from || k > to) continue;
      for (const l of j.lines) if (l.account === acct) { run += a.normal === 'debit' ? l.debit - l.credit : l.credit - l.debit; rows.push({ j, dr: l.debit, cr: l.credit, bal: r2(run) }); }
    }
    return { rows, opening };
  }, [db.journals, acct, from, to, a]);
  return (
    <Card flush title="General ledger" actions={<><Select sm style={{ width: 240 }} value={acct} onChange={(e) => setAcct(e.target.value)}>{db.accounts.map((x) => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}</Select><Input type="date" sm value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" sm value={to} onChange={(e) => setTo(e.target.value)} /></>}>
      <DataTable rows={rows} rowKey={(r) => r.j.id + r.dr + r.cr + r.bal} pageSize={15} empty={<Empty title="No postings in this period" />}
        cols={[{ key: 'd', header: 'Date', render: (r) => dateTimeFmt(r.j.date) }, { key: 'j', header: 'Journal', render: (r) => <>{r.j.no}<div className="sub">{r.j.memo}</div></> }, { key: 'dr', header: 'Debit', num: true, render: (r) => (r.dr ? money(r.dr) : '') }, { key: 'cr', header: 'Credit', num: true, render: (r) => (r.cr ? money(r.cr) : '') }, { key: 'b', header: 'Balance', num: true, render: (r) => money(r.bal) }]}
        footerRow={undefined} />
      <div className="card-f">Opening balance {money(opening)} · {a.name} ({a.normal} normal)</div>
    </Card>
  );
}

function Expenses() {
  const db = useDB();
  const run = useRun();
  const canCreate = useHas('accounting:create');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ date: dayKey(new Date()), account: '6300', vendor: '', amount: 0, vat: 0, paidFrom: 'bank' as 'cash' | 'bank', note: '' });
  return (
    <Card flush>
      <DataTable rows={[...db.expenses].reverse()} rowKey={(e) => e.id} pageSize={12} toolbar={canCreate && <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add expense</Button>}
        cols={[{ key: 'd', header: 'Date', render: (e) => dateFmt(e.date) }, { key: 'v', header: 'Vendor', render: (e) => <><b>{e.vendor}</b><div className="sub">{e.note}</div></> }, { key: 'a', header: 'Category', render: (e) => db.accounts.find((a) => a.code === e.account)?.name }, { key: 'p', header: 'Paid from', render: (e) => <Badge>{e.paidFrom}</Badge> }, { key: 'm', header: 'Amount', num: true, render: (e) => <>{money(e.amount)}{e.vat > 0 && <div className="sub">VAT {money(e.vat)}</div>}</> }]} />
      {open && (
        <Modal title="Add expense" size="sm" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!f.vendor || !(f.amount > 0)} onClick={() => run((d, c) => addExpense(d, c, { ...f, date: new Date(f.date + 'T12:00:00').toISOString() }), { ok: 'Expense posted', perm: 'accounting:create', onOk: () => setOpen(false) })}>Post</Button></>}>
          <div className="col"><Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field><Field label="Vendor"><Input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></Field>
            <Field label="Category"><Select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}>{EXPENSE_ACCOUNTS.map((c) => <option key={c} value={c}>{db.accounts.find((a) => a.code === c)?.name}</option>)}</Select></Field>
            <div className="form-grid"><Field label="Amount (incl. VAT)"><NumInput value={f.amount || ''} onChange={(n) => setF({ ...f, amount: n || 0 })} /></Field><Field label="of which VAT"><NumInput value={f.vat || ''} onChange={(n) => setF({ ...f, vat: n || 0 })} /></Field></div>
            <Field label="Paid from"><Select value={f.paidFrom} onChange={(e) => setF({ ...f, paidFrom: e.target.value as 'cash' | 'bank' })}><option value="bank">Bank</option><option value="cash">Cash</option></Select></Field></div>
        </Modal>
      )}
    </Card>
  );
}

function Cash() {
  const db = useDB();
  const run = useRun();
  const [acct, setAcct] = useState('1110');
  const [stmt, setStmt] = useState<number>(0);
  const lines = useMemo(() => { const out: { j: Journal; i: number; dr: number; cr: number; key: string }[] = []; for (const j of db.journals) j.lines.forEach((l, i) => { if (l.account === acct) out.push({ j, i, dr: l.debit, cr: l.credit, key: `${j.id}:${i}` }); }); return out.reverse(); }, [db.journals, acct]);
  const glBal = r2(lines.reduce((s, l) => s + l.dr - l.cr, 0));
  const unrec = lines.filter((l) => !db.reconciled[l.key]);
  const recBal = r2(lines.filter((l) => db.reconciled[l.key]).reduce((s, l) => s + l.dr - l.cr, 0));
  return (
    <div className="col gap-16">
      <div className="grid g3">
        <Kpi label="Ledger balance" value={money(glBal)} sub={db.accounts.find((a) => a.code === acct)?.name} />
        <Kpi label="Reconciled to statement" value={money(recBal)} sub={`${lines.length - unrec.length} lines ticked`} />
        <Kpi label="Unreconciled lines" value={unrec.length} sub={money(r2(unrec.reduce((s, l) => s + l.dr - l.cr, 0)))} />
      </div>
      <Card flush title="Reconcile" sub="Tick lines that appear on the bank statement. Automated bank feeds are out of scope for this release." actions={<><Select sm style={{ width: 'auto' }} value={acct} onChange={(e) => setAcct(e.target.value)}><option value="1110">Bank – operating</option><option value="1100">Cash on hand</option></Select><span className="muted">Statement balance</span><NumInput style={{ width: 130 }} value={stmt || ''} onChange={(n) => setStmt(n || 0)} />{stmt ? <Badge tone={Math.abs(stmt - recBal) < 0.01 ? 'good' : 'warn'}>diff {money(r2(stmt - recBal))}</Badge> : null}</>}>
        <DataTable rows={lines} rowKey={(l) => l.key} pageSize={14}
          cols={[{ key: 'c', header: '✓', width: 40, render: (l) => <input type="checkbox" checked={!!db.reconciled[l.key]} onChange={(e) => run((d) => { if (e.target.checked) d.reconciled[l.key] = true; else delete d.reconciled[l.key]; })} aria-label="Reconciled" /> }, { key: 'd', header: 'Date', render: (l) => dateTimeFmt(l.j.date) }, { key: 'm', header: 'Memo', render: (l) => l.j.memo }, { key: 'in', header: 'In', num: true, render: (l) => (l.dr ? money(l.dr) : '') }, { key: 'out', header: 'Out', num: true, render: (l) => (l.cr ? money(l.cr) : '') }]} />
      </Card>
    </div>
  );
}

function Periods() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canClose = useHas('accounting:close');
  const [day, setDay] = useState(dayKey(addDays(new Date(), -1)));
  return (
    <div className="grid g2">
      <Card title="Period lock" sub="Postings dated on or before the lock are rejected">
        <div className="row mb16">{db.meta.lockedUntil ? <Badge tone="warn" dot><Lock size={11} /> Locked through {dateFmt(db.meta.lockedUntil)}</Badge> : <Badge tone="info"><Unlock size={11} /> No period locked</Badge>}</div>
        {canClose ? (
          <div className="col">
            <Field label="Close periods through"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
            <div className="row"><Button variant="primary" onClick={() => run((d, c) => closePeriod(d, c, day), { ok: 'Period closed', perm: 'accounting:close' })}><Lock size={14} /> Close period</Button><Button onClick={async () => { const x = await confirm({ title: 'Reopen accounting period?', body: 'Reopening allows edits to closed periods. It is recorded as a critical audit event.', reason: true, danger: true, confirmLabel: 'Reopen' }); if (x.ok) run((d, c) => reopenPeriod(d, c, day, x.reason), { ok: 'Lock moved', perm: 'accounting:close' }); }}><Unlock size={14} /> Move lock to date…</Button></div>
          </div>
        ) : <div className="muted">Only an Owner (or role with “accounting:close”) can close or reopen periods.</div>}
      </Card>
      <Card title="Why it matters"><div className="muted">Closing a period freezes reported figures. Corrections after close must be posted as <b>reversal or adjustment entries in the current period</b>. Try it: lock through yesterday, then attempt a manual journal dated last week — it is rejected with a clear message.</div><div className="mt8"><Link to="/health">See the integrity checks →</Link></div></Card>
    </div>
  );
}
export const _ac = [Check, Textarea, money0];
