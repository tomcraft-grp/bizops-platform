import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Lock, Plus, Settings2, Trash2, Unlock, X } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { addExpense, balancesBetween, closePeriod, expenseAccounts, natBal, reopenPeriod, reverseJournal, sumAccounts, isControl, isFs, roleLabel } from '../domain/accounting';
import { MOVEMENT_LABEL, MovementKind, approveDraft, decideMapping, postMovement, reconDrill, reconciliationMatrix, rejectDraft, saveDraft, submitDraft } from '../domain/setup';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun, useUser, Tx } from '../ui/kit';
import { dateFmt, dateTimeFmt, dayKey, money, money0, r2, addDays } from '../lib/util';
import type { Journal } from '../domain/types';
import { BalanceSheet, CashFlow, ExpenseAnalysis, GeneralLedger, InventoryCogs, ProfitLoss, SettlementRecon, TrialBalance, VatReport } from './AccountingReports';
import { t as tl } from '../lib/i18n';

type Tab = 'journal' | 'approvals' | 'tb' | 'pl' | 'bs' | 'gl' | 'cashflow' | 'vat' | 'settle' | 'inv' | 'expenses' | 'exp-an' | 'cash' | 'movements' | 'recon' | 'periods';
const REF_LABEL: Record<string, string> = { order: 'Sale', receipt: 'Receipt', grn: 'Goods receipt', supplier_payment: 'Supplier payment', production: 'Production', transfer: 'Transfer', settlement: 'Settlement', expense: 'Expense', manual: 'Manual', reversal: 'Reversal', return: 'Return', stock_adjust: 'Stock adj.', count: 'Count', opening: 'Opening', opening_balance: 'Opening balance', credit_applied: 'Credit applied', refund_paid: 'Refund', refund_credit: 'Refund → credit', cancel_credit: 'Cancellation', supplier_return: 'Supplier return' };
const refLabel = (r: string) => (r.startsWith('movement:') ? MOVEMENT_LABEL[r.slice(9) as MovementKind] ?? r : REF_LABEL[r] ?? r);

export default function Accounting() {
  const db = useDB();
  const [tab, setTab] = useState<Tab>('journal');
  const bal = useMemo(() => balancesBetween(db.journals), [db.journals]);
  const canCreate = useHas('accounting:create');
  const [draft, setDraft] = useState<string | 'new' | null>(null);
  const pending = db.journalDrafts.filter((x) => x.status === 'submitted').length + db.mappingChanges.filter((x) => x.status === 'pending').length + db.openingSets.filter((x) => x.status === 'reviewed').length;
  const diffs = reconciliationMatrix(db).filter((r) => r.status === 'diff').length;
  return (
    <>
      <PageHead title="Accounting" desc="Double-entry ledger posted through the approved account mapping. Mistakes are fixed with reversal entries — nothing is silently overwritten; manual journals need a second person's approval."
        actions={<><Link to="/accounting/setup"><Button><Settings2 size={15} />{' '}<Tx>Accounting setup</Tx></Button></Link>{canCreate && <Button variant="primary" onClick={() => setDraft('new')}><Plus size={15} />{' '}<Tx>New journal draft</Tx></Button>}</>} />
      {db.setup.status !== 'approved' && <div className="mb16"><Banner tone="bad"><b><Tx>Accounting setup is not approved.</Tx></b>{' '}<Tx>Live posting should not start until the setup is approved.</Tx>{' '}<Link to="/accounting/setup"><Tx>Open the setup wizard</Tx></Link></Banner></div>}
      {db.setup.status === 'approved' && !db.setup.accountantReviewed && <div className="mb16"><Banner tone="warn"><b><Tx>For review by a qualified Thai accountant before production use:</Tx></b>{' '}<Tx>chart of accounts, VAT / tax-invoice handling, withholding tax and period-close practice are illustrative in this prototype.</Tx></Banner></div>}
      <div className="grid g4 mb16">
        <Kpi label="Cash & bank" value={money0(sumAccounts(db, bal, isFs('cash')))} sub="all cash accounts" />
        <Kpi label="Receivables" value={money0(sumAccounts(db, bal, (a) => a.control === 'ar' || a.control === 'platform'))} sub="customers + platforms" />
        <Kpi label="Payables" value={money0(sumAccounts(db, bal, isControl('ap')))} sub="suppliers" />
        <Kpi label="Reconciliation" value={diffs ? `${diffs} diff` : <Tx>{'Clean'}</Tx>} tone={diffs ? 'bad' : 'good'} sub={db.meta.lockedUntil ? <Tx vars={{ date: dateFmt(db.meta.lockedUntil) }}>{'closed through {date}'}</Tx> : 'no period closed'} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { v: 'journal', label: 'Journal' }, { v: 'approvals', label: 'Approvals', count: pending || '' }, { v: 'tb', label: 'Trial balance' }, { v: 'pl', label: 'Profit & loss' }, { v: 'bs', label: 'Balance sheet' }, { v: 'gl', label: 'General ledger' },
        { v: 'cashflow', label: 'Cash flow' }, { v: 'vat', label: 'VAT' }, { v: 'settle', label: 'Settlements' }, { v: 'inv', label: 'Inventory & COGS' }, { v: 'expenses', label: 'Expenses' }, { v: 'exp-an', label: 'Expense analysis' },
        { v: 'cash', label: 'Cash & bank' }, { v: 'movements', label: 'Transfers, loans & owner' }, { v: 'recon', label: 'Reconciliation', count: diffs || '' }, { v: 'periods', label: 'Periods' },
      ]} />
      {tab === 'journal' && <JournalList />}
      {tab === 'approvals' && <Approvals onEdit={(id) => setDraft(id)} />}
      {tab === 'tb' && <TrialBalance />}
      {tab === 'pl' && <ProfitLoss />}
      {tab === 'bs' && <BalanceSheet />}
      {tab === 'gl' && <GeneralLedger />}
      {tab === 'cashflow' && <CashFlow />}
      {tab === 'vat' && <VatReport />}
      {tab === 'settle' && <SettlementRecon />}
      {tab === 'inv' && <InventoryCogs />}
      {tab === 'expenses' && <Expenses />}
      {tab === 'exp-an' && <ExpenseAnalysis />}
      {tab === 'cash' && <Cash />}
      {tab === 'movements' && <Movements />}
      {tab === 'recon' && <Recon />}
      {tab === 'periods' && <Periods />}
      {draft && <DraftModal id={draft === 'new' ? undefined : draft} onClose={() => setDraft(null)} />}
    </>
  );
}

function JournalList() {
  const lang = useLang();
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
        toolbar={<Select sm style={{ width: 'auto' }} value={ref} onChange={(e) => setRef(e.target.value)} aria-label={tl(lang, 'Source filter')}><option value="">All sources</option>{refs.map((r) => <option key={r} value={r}>{refLabel(r)}</option>)}</Select>}
        cols={[
          { key: 'no', header: 'Journal', sort: (x) => x.no, render: (x) => <><b>{x.no}</b><div className="sub">{dateTimeFmt(x.date)}</div></> },
          { key: 'm', header: 'Memo', render: (x) => x.memo }, { key: 'r', header: 'Source', hideSm: true, render: (x) => <Badge tone={x.refType === 'manual' ? 'warn' : x.refType === 'reversal' ? 'bad' : ''}>{refLabel(x.refType)}</Badge> },
          { key: 'dim', header: 'Dimensions', hideSm: true, render: (x) => <span className="muted">{[x.dim?.branchId && db.branches.find((b) => b.id === x.dim!.branchId)?.code, x.dim?.channel].filter(Boolean).join(' · ') || '–'}</span> },
          { key: 'a', header: 'Amount', num: true, render: (x) => money(x.lines.reduce((s, l) => s + l.debit, 0)) }, { key: 's', header: '', render: (x) => (x.status === 'reversed' ? <Badge tone="bad"><Tx>reversed</Tx></Badge> : null) },
        ]} />
      {j && <JournalModal j={j} canRev={canRev} onClose={() => setOpen(null)} onReverse={async () => { const x = await confirm({ title: `Reverse ${j.no}?`, body: 'A new journal with debits and credits swapped is posted. The original is kept and marked reversed.', reason: true, danger: true, confirmLabel: 'Post reversal' }); if (x.ok) run((d, c) => reverseJournal(d, c, j.id, x.reason), { ok: 'Reversal posted', perm: 'accounting:approve', onOk: () => setOpen(null) }); }} />}
    </Card>
  );
}
function JournalModal({ j, canRev, onClose, onReverse }: { j: Journal; canRev: boolean; onClose: () => void; onReverse: () => void }) {
  const db = useDB();
  return (
    <Modal title={`${j.no} — ${j.memo}`} desc={`${dateTimeFmt(j.date)} · ${refLabel(j.refType)} · by ${db.users.find((u) => u.id === j.createdBy)?.name ?? j.createdBy}${j.approvedBy ? ` · approved by ${db.users.find((u) => u.id === j.approvedBy)?.name}` : ''}`} onClose={onClose}
      footer={canRev && j.status === 'posted' && !j.reverses ? <Button variant="danger" onClick={onReverse}><Tx>Reverse entry</Tx></Button> : undefined}>
      <table className="t compact"><thead><tr><th><Tx>Account</Tx></th><th className="num"><Tx>Debit</Tx></th><th className="num"><Tx>Credit</Tx></th></tr></thead>
        <tbody>{j.lines.map((l, i) => <tr key={i}><td><b>{l.account}</b> {db.accounts.find((a) => a.code === l.account)?.name}<div className="sub">{db.accounts.find((a) => a.code === l.account)?.nameTh}</div></td><td className="num">{l.debit ? money(l.debit) : ''}</td><td className="num">{l.credit ? money(l.credit) : ''}</td></tr>)}</tbody>
        <tfoot><tr className="total"><td><Tx>Total</Tx></td><td className="num">{money(j.lines.reduce((s, l) => s + l.debit, 0))}</td><td className="num">{money(j.lines.reduce((s, l) => s + l.credit, 0))}</td></tr></tfoot></table>
      {j.status === 'reversed' && <div className="mt8"><Badge tone="bad"><Tx>Reversed by</Tx>{' '}{db.journals.find((x) => x.id === j.reversedBy)?.no}</Badge></div>}
      {j.reverses && <div className="mt8"><Badge><Tx>Reversal of</Tx>{' '}{db.journals.find((x) => x.id === j.reverses)?.no}</Badge></div>}
    </Modal>
  );
}

function DraftModal({ id, onClose }: { id?: string; onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const ex = id ? db.journalDrafts.find((x) => x.id === id) : undefined;
  const [date, setDate] = useState(dayKey(ex?.date ?? new Date()));
  const [memo, setMemo] = useState(ex?.memo ?? '');
  const [lines, setLines] = useState<{ account: string; debit: number; credit: number }[]>(ex?.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit })) ?? [{ account: '6300', debit: 0, credit: 0 }, { account: '1100', debit: 0, credit: 0 }]);
  const td = r2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const tc = r2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  const payload = () => ({ id, date: new Date(date + 'T12:00:00').toISOString(), memo, lines: lines.map((l) => ({ account: l.account, debit: l.debit || 0, credit: l.credit || 0 })) });
  return (
    <Modal title={id ? 'Edit journal draft' : 'New journal draft'} desc="Drafts are posted only after a second authorized person approves them." size="lg" onClose={onClose}
      footer={<><div className="grow">{Math.abs(td - tc) < 0.005 && td > 0 ? <Badge tone="good"><Tx>balanced</Tx></Badge> : <Badge tone="bad"><Tx>out of balance by</Tx>{' '}{money(td - tc)}</Badge>}</div><Button onClick={onClose}><Tx>Cancel</Tx></Button>
        <Button disabled={!memo.trim()} onClick={() => run((d, c) => saveDraft(d, c, payload()), { ok: 'Draft saved', perm: 'accounting:create', onOk: onClose })}><Tx>Save draft</Tx></Button>
        <Button variant="primary" disabled={!memo.trim() || Math.abs(td - tc) > 0.005 || td <= 0} onClick={() => run((d, c) => { const x = saveDraft(d, c, payload()); submitDraft(d, c, x); }, { ok: 'Submitted for approval', perm: 'accounting:create', onOk: onClose })}><Tx>Submit for approval</Tx></Button></>}>
      <div className="form-grid"><Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Field label="Memo (reason / reference)"><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field></div>
      <table className="t compact mt16"><thead><tr><th><Tx>Account</Tx></th><th className="num"><Tx>Debit</Tx></th><th className="num"><Tx>Credit</Tx></th><th /></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={i}><td><Select sm value={l.account} aria-label={tl(lang, 'Account')} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, account: e.target.value } : x)))}>{db.accounts.filter((a) => a.posting && a.active).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</Select></td><td className="num"><NumInput style={{ width: 120 }} aria-label={tl(lang, 'Debit')} value={l.debit || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, debit: n || 0, credit: n ? 0 : x.credit } : x)))} /></td><td className="num"><NumInput style={{ width: 120 }} aria-label={tl(lang, 'Credit')} value={l.credit || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, credit: n || 0, debit: n ? 0 : x.debit } : x)))} /></td><td><Button size="sm" variant="ghost" icon aria-label={tl(lang, 'Remove line')} onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 size={13} /></Button></td></tr>)}</tbody>
        <tfoot><tr className="total"><td><Tx>Total</Tx></td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td><td /></tr></tfoot></table>
      <div className="mt8"><Button size="sm" onClick={() => setLines([...lines, { account: '6300', debit: 0, credit: 0 }])}><Plus size={13} />{' '}<Tx>Add line</Tx></Button></div>
    </Modal>
  );
}

function Approvals({ onEdit }: { onEdit: (id: string) => void }) {
  const db = useDB();
  const run = useRun();
  const me = useUser();
  const confirm = useConfirm();
  const canApprove = useHas('accounting:approve');
  const name = (id?: string) => db.users.find((u) => u.id === id)?.name ?? '—';
  const drafts = db.journalDrafts.slice().reverse();
  const changes = db.mappingChanges.slice().reverse();
  return (
    <div className="col gap-16">
      <Banner><b><Tx>Four-eyes control.</Tx></b>{' '}<Tx>The person who prepares a manual journal, a mapping change or opening balances cannot approve it. You are signed in as</Tx>{' '}<b>{me.name}</b><Tx>; switch user (top right) to approve what another person submitted.</Tx></Banner>
      <Card title="Manual journals" flush>
        <DataTable rows={drafts} rowKey={(x) => x.id} pageSize={8} empty={<Empty title="No journal drafts" hint="Use “New journal draft”. Journals do not post until approved." />}
          cols={[
            { key: 'n', header: 'Draft', render: (x) => <><b>{x.no}</b><div className="sub">{dayKey(x.date)}{' '}<Tx>· by</Tx>{' '}{name(x.createdBy)}</div></> }, { key: 'm', header: 'Memo', render: (x) => x.memo },
            { key: 'a', header: 'Amount', num: true, render: (x) => money(x.lines.reduce((s, l) => s + l.debit, 0)) },
            { key: 's', header: 'Status', render: (x) => <Badge tone={x.status === 'approved' ? 'good' : x.status === 'rejected' ? 'bad' : x.status === 'submitted' ? 'warn' : ''} dot>{x.status}</Badge> },
            { key: 'x', header: '', render: (x) => <div className="row gap-4">
              {(x.status === 'draft' || x.status === 'rejected') && x.createdBy === me.id && <Button size="sm" onClick={() => onEdit(x.id)}><Tx>Edit</Tx></Button>}
              {x.status === 'draft' && x.createdBy === me.id && <Button size="sm" variant="primary" onClick={() => run((d, c) => submitDraft(d, c, x.id), { ok: 'Submitted' })}><Tx>Submit</Tx></Button>}
              {x.status === 'submitted' && canApprove && <><Button size="sm" variant="primary" onClick={() => run((d, c) => approveDraft(d, c, x.id), { ok: 'Approved and posted', perm: 'accounting:approve' })}><Check size={13} />{' '}<Tx>Approve</Tx></Button><Button size="sm" onClick={async () => { const r = await confirm({ title: `Reject ${x.no}?`, reason: true, danger: true, confirmLabel: 'Reject' }); if (r.ok) run((d, c) => rejectDraft(d, c, x.id, r.reason), { ok: 'Rejected' }); }}><X size={13} />{' '}<Tx>Reject</Tx></Button></>}
              {x.reason && <span className="muted" style={{ fontSize: 12 }}>{x.reason}</span>}</div> },
          ]} />
      </Card>
      <Card title="Account-mapping changes" sub="Changes to which account a posting role uses are versioned with an effective date and need approval once the setup is approved." flush>
        <DataTable rows={changes} rowKey={(x) => x.id} pageSize={8} empty={<Empty title="No mapping changes proposed" hint="Propose one in Accounting setup → Transaction mapping." />}
          cols={[
            { key: 'r', header: 'Role', render: (x) => <><b>{roleLabel(x.role)}</b><div className="sub"><Tx>proposed by</Tx>{' '}{name(x.proposedBy)} · {dateTimeFmt(x.proposedAt)}</div></> },
            { key: 'c', header: 'Change', render: (x) => <>→ <b>{x.toCode}</b> {db.accounts.find((a) => a.code === x.toCode)?.name}<div className="sub"><Tx>from</Tx>{' '}{dayKey(x.effectiveFrom)} · {x.reason}</div></> },
            { key: 's', header: 'Status', render: (x) => <Badge tone={x.status === 'approved' ? 'good' : x.status === 'rejected' ? 'bad' : 'warn'} dot>{x.status}</Badge> },
            { key: 'a', header: '', render: (x) => x.status === 'pending' && canApprove ? <div className="row gap-4"><Button size="sm" variant="primary" onClick={() => run((d, c) => decideMapping(d, c, x.id, true, ''), { ok: 'Mapping change approved', perm: 'accounting:approve' })}><Tx>Approve</Tx></Button><Button size="sm" onClick={async () => { const r = await confirm({ title: 'Reject this mapping change?', reason: true, danger: true }); if (r.ok) run((d, c) => decideMapping(d, c, x.id, false, r.reason), { ok: 'Rejected' }); }}><Tx>Reject</Tx></Button></div> : <span className="muted" style={{ fontSize: 12 }}>{x.decidedBy ? `${name(x.decidedBy)}${x.decisionNote ? ': ' + x.decisionNote : ''}` : ''}</span> },
          ]} />
      </Card>
      <div className="muted"><Tx>Opening balances awaiting review/approval are handled in</Tx>{' '}<Link to="/accounting/setup"><Tx>Accounting setup → Opening balances</Tx></Link>.</div>
    </div>
  );
}

function Expenses() {
  const db = useDB();
  const run = useRun();
  const canCreate = useHas('accounting:create');
  const [open, setOpen] = useState(false);
  const accts = expenseAccounts(db);
  const [f, setF] = useState({ date: dayKey(new Date()), account: '6300', vendor: '', amount: 0, vat: 0, paidFrom: 'bank' as 'cash' | 'bank', branchId: '', note: '' });
  return (
    <Card flush>
      <DataTable rows={[...db.expenses].reverse()} rowKey={(e) => e.id} pageSize={12} toolbar={canCreate && <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} />{' '}<Tx>Add expense</Tx></Button>}
        cols={[{ key: 'd', header: 'Date', render: (e) => dateFmt(e.date) }, { key: 'v', header: 'Vendor', render: (e) => <><b>{e.vendor}</b><div className="sub">{e.note}</div></> }, { key: 'a', header: 'Category', render: (e) => db.accounts.find((a) => a.code === e.account)?.name }, { key: 'b', header: 'Branch', hideSm: true, render: (e) => (e.branchId ? db.branches.find((b) => b.id === e.branchId)?.code : '–') }, { key: 'p', header: 'Paid from', render: (e) => <Badge>{e.paidFrom}</Badge> }, { key: 'm', header: 'Amount', num: true, render: (e) => <>{money(e.amount)}{e.vat > 0 && <div className="sub"><Tx>VAT</Tx>{' '}{money(e.vat)}</div>}</> }]} />
      {open && (
        <Modal title="Add expense" size="sm" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!f.vendor || !(f.amount > 0)} onClick={() => run((d, c) => addExpense(d, c, { ...f, date: new Date(f.date + 'T12:00:00').toISOString(), branchId: f.branchId || undefined }), { ok: 'Expense posted', perm: 'accounting:create', onOk: () => setOpen(false) })}><Tx>Post</Tx></Button></>}>
          <div className="col"><Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field><Field label="Vendor"><Input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></Field>
            <Field label="Category (account)"><Select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</Select></Field>
            <div className="form-grid"><Field label="Amount (incl. VAT)"><NumInput value={f.amount || ''} onChange={(n) => setF({ ...f, amount: n || 0 })} /></Field><Field label="of which VAT"><NumInput value={f.vat || ''} onChange={(n) => setF({ ...f, vat: n || 0 })} /></Field></div>
            <Field label="Branch (analysis dimension)"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">Unallocated</option>{db.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Paid from"><Select value={f.paidFrom} onChange={(e) => setF({ ...f, paidFrom: e.target.value as 'cash' | 'bank' })}><option value="bank">Bank</option><option value="cash">Cash</option></Select></Field></div>
        </Modal>
      )}
    </Card>
  );
}

function Cash() {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const cashAccts = db.accounts.filter((a) => a.fsLine === 'cash' && a.posting);
  const [acct, setAcct] = useState(cashAccts[1]?.code ?? cashAccts[0]?.code);
  const [stmt, setStmt] = useState<number>(0);
  const lines = useMemo(() => { const out: { j: Journal; i: number; dr: number; cr: number; key: string }[] = []; for (const j of db.journals) j.lines.forEach((l, i) => { if (l.account === acct) out.push({ j, i, dr: l.debit, cr: l.credit, key: `${j.id}:${i}` }); }); return out.reverse(); }, [db.journals, acct]);
  const glBal = r2(lines.reduce((s, l) => s + l.dr - l.cr, 0));
  const unrec = lines.filter((l) => !db.reconciled[l.key]);
  const recBal = r2(lines.filter((l) => db.reconciled[l.key]).reduce((s, l) => s + l.dr - l.cr, 0));
  return (
    <div className="col gap-16">
      <div className="grid g3">
        <Kpi label="Ledger balance" value={money(glBal)} sub={db.accounts.find((a) => a.code === acct)?.name} />
        <Kpi label="Reconciled to statement" value={money(recBal)} sub={<Tx vars={{ n: lines.length - unrec.length }}>{'{n} lines ticked'}</Tx>} />
        <Kpi label="Unreconciled lines" value={unrec.length} sub={money(r2(unrec.reduce((s, l) => s + l.dr - l.cr, 0)))} />
      </div>
      <Card flush title="Reconcile" sub="Tick lines that appear on the bank statement. Automated bank feeds are out of scope for this release." actions={<><Select sm style={{ width: 'auto' }} value={acct} onChange={(e) => setAcct(e.target.value)} aria-label={tl(lang, 'Account')}>{cashAccts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}</Select><span className="muted"><Tx>Statement balance</Tx></span><NumInput style={{ width: 130 }} aria-label={tl(lang, 'Statement balance')} value={stmt || ''} onChange={(n) => setStmt(n || 0)} />{stmt ? <Badge tone={Math.abs(stmt - recBal) < 0.01 ? 'good' : 'warn'}><Tx>diff</Tx>{' '}{money(r2(stmt - recBal))}</Badge> : null}</>}>
        <DataTable rows={lines} rowKey={(l) => l.key} pageSize={14}
          cols={[{ key: 'c', header: '✓', width: 40, render: (l) => <input type="checkbox" checked={!!db.reconciled[l.key]} onChange={(e) => run((d) => { if (e.target.checked) d.reconciled[l.key] = true; else delete d.reconciled[l.key]; })} aria-label={`Reconciled: ${l.j.memo}`} /> }, { key: 'd', header: 'Date', render: (l) => dateTimeFmt(l.j.date) }, { key: 'm', header: 'Memo', render: (l) => l.j.memo }, { key: 'in', header: 'In', num: true, render: (l) => (l.dr ? money(l.dr) : '') }, { key: 'out', header: 'Out', num: true, render: (l) => (l.cr ? money(l.cr) : '') }]} />
      </Card>
    </div>
  );
}

function Movements() {
  const db = useDB();
  const run = useRun();
  const canCreate = useHas('accounting:create');
  const [f, setF] = useState({ kind: 'transfer' as MovementKind, amount: 0, account: 'bank' as 'cash' | 'bank', toAccount: 'cash' as 'cash' | 'bank', date: dayKey(new Date()), memo: '' });
  const kinds = Object.keys(MOVEMENT_LABEL) as MovementKind[];
  const rows = db.journals.filter((j) => j.refType.startsWith('movement:')).slice().reverse();
  const hint: Record<MovementKind, string> = {
    transfer: 'Debit receiving account, credit sending account. Never revenue or expense.', loan_received: 'Debit bank, credit loans payable. Principal is not income.', loan_repaid: 'Debit loans payable, credit bank. Principal is not an expense.',
    interest_paid: 'Interest is the only part of a loan payment that is an expense.', interest_received: 'Debit bank, credit interest income.', owner_contribution: 'Debit bank, credit owner’s capital — not revenue.', owner_withdrawal: 'Debit owner drawings — not an operating expense (confirm treatment with your accountant).',
  };
  return (
    <div className="grid g-main">
      <Card flush title="Posted movements"><DataTable rows={rows} rowKey={(j) => j.id} pageSize={8} empty={<Empty title="No transfers, loans or owner movements yet" />} cols={[{ key: 'd', header: 'Date', render: (j) => dateFmt(j.date) }, { key: 'm', header: 'Movement', render: (j) => <><b>{refLabel(j.refType)}</b><div className="sub">{j.memo}</div></> }, { key: 'a', header: 'Amount', num: true, render: (j) => money(j.lines.reduce((s, l) => s + l.debit, 0)) }]} /></Card>
      <Card title="Record a movement">
        <div className="col">
          <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as MovementKind })}>{kinds.map((k) => <option key={k} value={k}>{MOVEMENT_LABEL[k]}</option>)}</Select></Field>
          <div className="muted" style={{ fontSize: 12.5 }}><Tx>{hint[f.kind]}</Tx></div>
          <div className="form-grid"><Field label={f.kind === 'transfer' ? 'From' : 'Cash / bank'}><Select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value as 'cash' | 'bank' })}><option value="bank">Bank</option><option value="cash">Cash</option></Select></Field>
            {f.kind === 'transfer' && <Field label="To"><Select value={f.toAccount} onChange={(e) => setF({ ...f, toAccount: e.target.value as 'cash' | 'bank' })}><option value="cash">Cash</option><option value="bank">Bank</option></Select></Field>}</div>
          <div className="form-grid"><Field label="Amount"><NumInput value={f.amount || ''} onChange={(n) => setF({ ...f, amount: n || 0 })} /></Field><Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field></div>
          <Field label="Reference / memo"><Input value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
          <Button variant="primary" disabled={!canCreate || !(f.amount > 0)} onClick={() => run((d, c) => postMovement(d, c, { ...f, date: new Date(f.date + 'T12:00:00').toISOString() }), { ok: 'Posted', perm: 'accounting:create', onOk: () => setF({ ...f, amount: 0, memo: '' }) })}><Tx>Post</Tx></Button>
        </div>
      </Card>
    </div>
  );
}

function Recon() {
  const db = useDB();
  const rows = useMemo(() => reconciliationMatrix(db), [db.journals, db.orders, db.allocations, db.receipts, db.apInvoices, db.balances, db.reconciled]); // eslint-disable-line
  const [open, setOpen] = useState<string | null>(null);
  const drill = open ? reconDrill(db, open) : [];
  return (
    <div className="col gap-16">
      <Card flush title="Subledger ↔ control-account reconciliation" sub="Differences are never hidden by an unexplained journal. Click a row to drill into the subledger.">
        <table className="t"><thead><tr><th><Tx>Control account</Tx></th><th className="num"><Tx>General ledger</Tx></th><th className="num"><Tx>Subledger</Tx></th><th className="num"><Tx>Difference</Tx></th><th><Tx>Status</Tx></th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key} className="click" onClick={() => setOpen(open === r.key ? null : r.key)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === r.key ? null : r.key)}>
            <td><b><Tx>{r.title}</Tx></b><div className="sub"><Tx>accounts</Tx>{' '}{r.accounts} · {r.subLabel}</div></td><td className="num">{money(r.gl)}</td><td className="num">{money(r.sub)}</td><td className="num">{money(r.diff)}</td>
            <td><Badge tone={r.status === 'ok' ? 'good' : r.status === 'pending' ? 'warn' : 'bad'} dot>{r.status === 'ok' ? <Tx>{'agrees'}</Tx> : r.status === 'pending' ? <Tx>{'needs statement'}</Tx> : <Tx>{'DIFFERENCE'}</Tx>}</Badge>{r.note && r.status !== 'ok' && <div className="sub"><Tx>{r.note}</Tx></div>}</td></tr>)}</tbody></table>
      </Card>
      {open && (
        <Card title={`Drill-down — ${rows.find((r) => r.key === open)?.title}`} flush>
          {open === 'cash_bank' ? <div style={{ padding: 16 }} className="muted"><Tx>{'Open the Cash & bank tab to tick lines against the statement.'}</Tx></div> : (
            <DataTable rows={drill} rowKey={(x) => x.label} pageSize={10} compact empty={<Empty title="No subledger entries" />} cols={[{ key: 'l', header: 'Subledger item', render: (x) => <Tx>{x.label}</Tx> }, { key: 'a', header: 'Balance', num: true, render: (x) => money(x.amount) }]} />
          )}
        </Card>
      )}
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
        <div className="row mb16">{db.meta.lockedUntil ? <Badge tone="warn" dot><Lock size={11} />{' '}<Tx>Locked through</Tx>{' '}{dateFmt(db.meta.lockedUntil)}</Badge> : <Badge tone="info"><Unlock size={11} />{' '}<Tx>No period locked</Tx></Badge>}</div>
        {canClose ? (
          <div className="col">
            <Field label="Close periods through"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
            <div className="row"><Button variant="primary" onClick={() => run((d, c) => closePeriod(d, c, day), { ok: 'Period closed', perm: 'accounting:close' })}><Lock size={14} />{' '}<Tx>Close period</Tx></Button><Button onClick={async () => { const x = await confirm({ title: 'Reopen accounting period?', body: 'Reopening allows edits to closed periods. It is recorded as a critical audit event.', reason: true, danger: true, confirmLabel: 'Reopen' }); if (x.ok) run((d, c) => reopenPeriod(d, c, day, x.reason), { ok: 'Lock moved', perm: 'accounting:close' }); }}><Unlock size={14} />{' '}<Tx>Move lock to date…</Tx></Button></div>
          </div>
        ) : <div className="muted"><Tx>Only an Owner (or role with “accounting:close”) can close or reopen periods.</Tx></div>}
      </Card>
      <Card title="Why it matters"><div className="muted"><Tx>Closing a period freezes reported figures. Corrections after close must be posted as</Tx>{' '}<b><Tx>reversal or adjustment entries in the current period</Tx></b><Tx>. Try it: lock through yesterday, then attempt a journal draft dated last week and approve it — it is rejected with a clear message.</Tx></div></Card>
    </div>
  );
}
export const _acc = [natBal, Textarea];
