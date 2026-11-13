import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, CircleDashed, Download, FileUp, History, Lock, Plus, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { useDB, toast, useLang } from '../domain/store';
import { COA_HEADERS, SETUP_STAGES, approveOpening, approveSetup, assignStageOwner, coaToRows, deactivateAccount, deleteAccount, importCoaRows, proposeMapping, reactivateAccount, reopenSetup, reviewOpening, saveAccount, saveOpeningSet, saveTaxCode, setMappingDirect, setupChecks, validateCoa, validateOpening } from '../domain/setup';
import { ROLE_DEFS, balancesBetween, findAcct, netDebit, roleCode, taxAt } from '../domain/accounting';
import { updateOrg } from '../domain/master';
import { Badge, Banner, Button, Card, Check, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun, useUser, Tx } from '../ui/kit';
import { Gate } from '../ui/Shell';
import { dateFmt, dateTimeFmt, dayKey, download, money, parseCSV, r2, toCSV } from '../lib/util';
import type { Account, FsLine, OpeningSet, TaxCode } from '../domain/types';
import { t as tl } from '../lib/i18n';

type Tab = 'overview' | 'coa' | 'mapping' | 'tax' | 'opening';
export default function AccountingSetup() {
  return <Gate perm="accounting:view"><Inner /></Gate>;
}
function Inner() {
  const db = useDB();
  const [tab, setTab] = useState<Tab>('overview');
  const checks = setupChecks(db);
  const bad = checks.filter((c) => c.status === 'fail').length;
  return (
    <>
      <Link to="/accounting" className="row gap-6 mb8"><ArrowLeft size={15} />{' '}<Tx>Back to accounting</Tx></Link>
      <PageHead title="Accounting setup" desc="Configure the chart of accounts, tax treatment, transaction-to-account mapping and opening balances before live posting. Nothing is mapped silently: an unmapped event blocks the transaction instead of posting to an arbitrary account." />
      <div className="mb16"><Banner tone={db.setup.status === 'approved' ? (db.setup.accountantReviewed ? 'good' : 'warn') : 'bad'}>
        {db.setup.status === 'approved' ? <><Tx>Setup</Tx>{' '}<b>v{db.setup.version}</b>{' '}<Tx>approved</Tx>{' '}{dateFmt(db.setup.approvedAt)}{' '}<Tx>by</Tx>{' '}{db.users.find((u) => u.id === db.setup.approvedBy)?.name}. {db.setup.accountantReviewed ? <Tx>{'Accountant review recorded.'}</Tx> : <b><Tx>Not yet reviewed by a qualified Thai accountant — the codes, names, tax setup and policies here are illustrative.</Tx></b>}</> : <b><Tx>Setup is in draft — live posting should not start until it is approved.</Tx></b>}
      </Banner></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'overview', label: 'Setup checklist', count: bad || '' }, { v: 'coa', label: 'Chart of accounts', count: db.accounts.length }, { v: 'mapping', label: 'Transaction mapping' }, { v: 'tax', label: 'Tax configuration' }, { v: 'opening', label: 'Opening balances', count: db.openingSets.filter((x) => x.status !== 'posted').length || '' }]} />
      {tab === 'overview' && <Overview />}
      {tab === 'coa' && <Coa />}
      {tab === 'mapping' && <Mapping />}
      {tab === 'tax' && <Tax />}
      {tab === 'opening' && <Opening />}
    </>
  );
}

const STATUS_ICON = { ok: <CheckCircle2 size={18} color="var(--good)" />, warn: <ShieldAlert size={18} color="var(--warn)" />, fail: <XCircle size={18} color="var(--crit)" />, pending: <CircleDashed size={18} color="var(--muted)" /> };

function Overview() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canClose = useHas('accounting:close');
  const checks = setupChecks(db);
  const [appr, setAppr] = useState(false);
  const [pol, setPol] = useState({ fiscalYearStart: db.org.fiscalYearStart, accountingBasis: db.org.accountingBasis, taxInclusivePricing: db.org.taxInclusivePricing, defaultTaxCode: db.org.defaultTaxCode, requireJournalApproval: db.org.requireJournalApproval, vatRegistered: db.org.vatRegistered });
  return (
    <div className="grid g-main">
      <div className="col gap-16">
        {SETUP_STAGES.map((s) => {
          const c = checks.filter((x) => x.stage === s.id);
          const worst = c.some((x) => x.status === 'fail') ? 'fail' : c.some((x) => x.status === 'warn') ? 'warn' : c.some((x) => x.status === 'pending') ? 'pending' : 'ok';
          const owner = db.users.find((u) => u.id === db.setup.stageOwners[s.id]);
          return (
            <Card key={s.id}>
              <div className="row between top wrap">
                <div className="row top" style={{ flex: 1, minWidth: 220 }}><Tx>{STATUS_ICON[worst]}</Tx><div><b><Tx>{s.title}</Tx></b>{c.map((x) => <div key={x.id} className="text2" style={{ fontSize: 13 }}><Tx>{x.title}</Tx><div className="muted"><Tx>{x.detail}</Tx></div></div>)}</div></div>
                <div className="row gap-6"><span className="muted" style={{ fontSize: 12 }}><Tx>Responsible</Tx></span>
                  <Select sm style={{ width: 170 }} value={db.setup.stageOwners[s.id] ?? ''} disabled={!canClose} aria-label={`Owner of ${s.title}`} onChange={(e) => run((d, ctx) => assignStageOwner(d, ctx, s.id, e.target.value), { ok: `${s.title} owner updated`, perm: 'accounting:close' })}>{db.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
                  {!owner && <Badge tone="warn"><Tx>unassigned</Tx></Badge>}</div>
              </div>
            </Card>
          );
        })}
      </div>
      <div className="col gap-16">
        <Card title="Accounting policies">
          <div className="col">
            <div className="form-grid"><Field label="Financial year starts (MM-DD)"><Input value={pol.fiscalYearStart} onChange={(e) => setPol({ ...pol, fiscalYearStart: e.target.value })} /></Field>
              <Field label="Accounting basis"><Select value={pol.accountingBasis} onChange={(e) => setPol({ ...pol, accountingBasis: e.target.value as 'accrual' | 'cash' })}><option value="accrual">Accrual</option><option value="cash">Cash</option></Select></Field></div>
            <Field label="Default sales tax code"><Select value={pol.defaultTaxCode} onChange={(e) => setPol({ ...pol, defaultTaxCode: e.target.value })}>{Array.from(new Set(db.taxCodes.map((t) => t.code))).map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
            <Check checked={pol.vatRegistered} onChange={(v) => setPol({ ...pol, vatRegistered: v })}><Tx>VAT-registered (otherwise sales use the out-of-scope code)</Tx></Check>
            <Check checked={pol.taxInclusivePricing} onChange={(v) => setPol({ ...pol, taxInclusivePricing: v })}><Tx>Selling prices include tax</Tx></Check>
            <Check checked={pol.requireJournalApproval} onChange={(v) => setPol({ ...pol, requireJournalApproval: v })}><Tx>Manual journals need a different person to approve</Tx></Check>
            <Button variant="primary" disabled={!canClose} onClick={() => run((d, c) => updateOrg(d, c, pol), { ok: 'Policies saved (audited) — apply to new transactions', perm: 'accounting:close' })}><Tx>Save policies</Tx></Button>
          </div>
        </Card>
        <Card title="Approval & lock">
          <div className="col">
            {db.setup.status === 'approved' ? (
              <>
                <div className="text2"><Tx>Changes now go through change control: mapping changes need a second approver; COA edits are audited. Reopen only for structural changes.</Tx></div>
                <Button disabled={!canClose} onClick={async () => { const x = await confirm({ title: 'Reopen the setup for editing?', body: 'While in draft, mappings can be changed directly and live posting should be paused. This is a critical audit event.', reason: true, danger: true, confirmLabel: 'Reopen setup' }); if (x.ok) run((d, c) => reopenSetup(d, c, x.reason), { ok: 'Setup reopened', perm: 'accounting:close' }); }}><Lock size={14} />{' '}<Tx>Reopen setup</Tx></Button>
              </>
            ) : <Button variant="primary" disabled={!canClose} onClick={() => setAppr(true)}><Tx>Approve setup for live posting</Tx></Button>}
            {db.setup.status === 'approved' && canClose && <Button size="sm" onClick={() => setAppr(true)}><Tx>Re-approve / record accountant review</Tx></Button>}
            {!canClose && <div className="muted" style={{ fontSize: 12 }}><Tx>Only roles with “accounting:close” can approve or reopen the setup.</Tx></div>}
          </div>
        </Card>
        <Card title="History" flush>{db.setup.history.length ? <div className="col" style={{ padding: 14 }}>{db.setup.history.slice().reverse().map((h, i) => <div key={i} style={{ fontSize: 13 }}><b>{h.action}</b> <span className="muted">{dateTimeFmt(h.ts)} · {db.users.find((u) => u.id === h.by)?.name}</span><div className="text2">{h.detail}</div></div>)}</div> : <Empty icon={<History size={20} />} title="No setup history" />}</Card>
      </div>
      {appr && <ApproveModal onClose={() => setAppr(false)} />}
    </div>
  );
}
function ApproveModal({ onClose }: { onClose: () => void }) {
  const run = useRun();
  const [note, setNote] = useState('');
  const [rev, setRev] = useState(false);
  const [evid, setEvid] = useState('');
  return (
    <Modal title="Approve accounting setup" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!note.trim() || (rev && !evid.trim())} onClick={() => run((d, c) => approveSetup(d, c, { note: note + (rev ? ` [accountant evidence: ${evid}]` : ''), accountantReviewed: rev }), { ok: 'Setup approved and versioned', perm: 'accounting:close', onOk: onClose })}><Tx>Approve</Tx></Button></>}>
      <div className="col">
        <Field label="Approval note (what was reviewed)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Check checked={rev} onChange={setRev}><Tx>A qualified Thai accountant has reviewed and approved the chart, tax setup, mappings and policies</Tx></Check>
        {rev && <Field label="Evidence reference (document / email / sign-off id)"><Input value={evid} onChange={(e) => setEvid(e.target.value)} /></Field>}
        <div className="muted" style={{ fontSize: 12 }}><Tx>Do not tick the box unless it is true — the approval is recorded with your name and shown on every accounting screen.</Tx></div>
      </div>
    </Modal>
  );
}

// ---------------- Chart of accounts ----------------
const FS_LABEL: Record<FsLine, string> = { cash: 'Cash & bank', receivables: 'Receivables', inventory: 'Inventory', tax_asset: 'Tax asset', other_assets: 'Other assets', fixed_assets: 'Fixed assets', payables: 'Payables', tax_payable: 'Tax payable', customer_liabilities: 'Customer balances', loans: 'Loans', equity: 'Equity', revenue: 'Revenue', contra_revenue: 'Contra revenue', cogs: 'Cost of sales', channel_costs: 'Channel costs', opex: 'Operating expenses', other_income: 'Other income', other_expense: 'Other expense' };
function Coa() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canEdit = useHas('accounting:close');
  const [edit, setEdit] = useState<Account | 'new' | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const issues = useMemo(() => validateCoa(db), [db.accounts, db.postingMap]); // eslint-disable-line
  const bal = useMemo(() => balancesBetween(db.journals), [db.journals]);
  const depth = (a: Account) => { let n = 0, p = a.parent; while (p) { n++; p = findAcct(db, p)?.parent; } return n; };
  const used = useMemo(() => { const s = new Set<string>(); for (const j of db.journals) for (const l of j.lines) s.add(l.account); return s; }, [db.journals]);
  return (
    <div className="col gap-16">
      {issues.filter((i) => i.level === 'error').length > 0 && <Banner tone="bad"><b>{issues.filter((i) => i.level === 'error').length}{' '}<Tx>structural error(s):</Tx></b> {issues.filter((i) => i.level === 'error').slice(0, 3).map((i) => i.msg).join(' · ')}</Banner>}
      <Card flush title="Chart of accounts" sub="Hierarchical, bilingual, with normal balance, posting eligibility and financial-statement mapping. Used accounts cannot be deleted — only deactivated."
        actions={<><Button size="sm" onClick={() => download('chart-of-accounts.csv', toCSV(coaToRows(db)))}><Download size={14} />{' '}<Tx>Export</Tx></Button><Button size="sm" onClick={() => download('chart-of-accounts-template.csv', toCSV([[...COA_HEADERS], ['6350', 'Software subscriptions', 'ค่าซอฟต์แวร์', 'expense', 'debit', '6000', 'yes', 'opex', '', '', '', '']]))}><Tx>Template</Tx></Button>
          {canEdit && <><input ref={file} type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const rows = parseCSV(await f.text()); run((d, c) => importCoaRows(d, c, rows), { perm: 'accounting:close', ok: 'Chart imported' }); }} /><Button size="sm" onClick={() => file.current?.click()}><FileUp size={14} />{' '}<Tx>Import CSV</Tx></Button><Button size="sm" variant="primary" onClick={() => setEdit('new')}><Plus size={14} />{' '}<Tx>Add account</Tx></Button></>}</>}>
        <DataTable rows={db.accounts} rowKey={(a) => a.code} pageSize={20} search={(a) => `${a.code} ${a.name} ${a.nameTh}`}
          cols={[
            { key: 'c', header: 'Code', sort: (a) => a.code, render: (a) => <span className="mono" style={{ paddingLeft: depth(a) * 16, fontWeight: a.posting ? 400 : 700 }}>{a.code}</span> },
            { key: 'n', header: 'Account', render: (a) => <div style={{ paddingLeft: depth(a) * 16 }}><b style={{ fontWeight: a.posting ? 560 : 750 }}>{a.name}</b><div className="sub">{a.nameTh}</div></div> },
            { key: 't', header: 'Type', hideSm: true, render: (a) => <>{a.type}<div className="sub">{a.normal}<Tx>-normal</Tx>{a.contra ? <Tx>{' · contra'}</Tx> : ''}</div></> },
            { key: 'f', header: 'Statement line', hideSm: true, render: (a) => <Tx>{FS_LABEL[a.fsLine]}</Tx> },
            { key: 'fl', header: 'Flags', render: (a) => <div className="row wrap gap-4">{!a.posting && <Badge><Tx>header</Tx></Badge>}{a.control && <Badge tone="info">{a.control}</Badge>}{a.system && <Badge><Tx>system</Tx></Badge>}{a.dims?.length ? <Badge>{a.dims.join('/')}</Badge> : null}{!a.active && <Badge tone="bad"><Tx>inactive</Tx></Badge>}</div> },
            { key: 'b', header: 'Balance', num: true, hideSm: true, render: (a) => (a.posting && Math.abs(netDebit(bal[a.code])) > 0.004 ? money(Math.abs(netDebit(bal[a.code]))) : '') },
            { key: 'x', header: '', render: (a) => canEdit && <div className="row gap-4"><Button size="sm" variant="ghost" onClick={() => setEdit(a)}><Tx>Edit</Tx></Button>
              {a.active && a.posting && !a.system && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: `Deactivate ${a.code}?`, body: 'The account stays in history but can no longer receive postings.', reason: true, danger: true, confirmLabel: 'Deactivate' }); if (x.ok) run((d, c) => deactivateAccount(d, c, a.code, x.reason), { ok: 'Deactivated', perm: 'accounting:close' }); }}><Tx>Deactivate</Tx></Button>}
              {!a.active && !a.system && <Button size="sm" variant="ghost" onClick={() => run((d, c) => reactivateAccount(d, c, a.code), { ok: 'Reactivated', perm: 'accounting:close' })}><Tx>Reactivate</Tx></Button>}
              {!used.has(a.code) && !a.system && <Button size="sm" variant="ghost" icon aria-label={`Delete ${a.code}`} onClick={async () => { const x = await confirm({ title: `Delete ${a.code}?`, body: 'Only unused accounts can be deleted.', danger: true, confirmLabel: 'Delete' }); if (x.ok) run((d, c) => deleteAccount(d, c, a.code), { ok: 'Deleted', perm: 'accounting:close' }); }}><Trash2 size={13} /></Button>}</div> },
          ]} />
      </Card>
      {edit && <AccountModal a={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function AccountModal({ a, onClose }: { a: Account | null; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const used = a ? db.journals.some((j) => j.lines.some((l) => l.account === a.code)) : false;
  const [f, setF] = useState<Partial<Account> & { code: string; name: string }>(a ? { ...a } : { code: '', name: '', nameTh: '', type: 'expense', normal: 'debit', fsLine: 'opex', posting: true, parent: '6000', group: 'Operating expenses' });
  const headers = db.accounts.filter((x) => !x.posting);
  return (
    <Modal title={a ? `Edit ${a.code}` : 'Add account'} size="lg" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!f.code || !f.name} onClick={() => run((d, c) => saveAccount(d, c, f, !a), { ok: 'Account saved (audited)', perm: 'accounting:close', onOk: onClose })}><Tx>Save</Tx></Button></>}>
      {used && <div className="mb16"><Banner><Tx>This account has postings: its code, type, normal balance and posting status are locked.</Tx></Banner></div>}
      <div className="form-grid">
        <Field label="Code"><Input value={f.code} disabled={!!a} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Parent (header account)"><Select value={f.parent ?? ''} onChange={(e) => setF({ ...f, parent: e.target.value || undefined })}><option value="">— none —</option>{headers.map((h) => <option key={h.code} value={h.code}>{h.code} {h.name}</option>)}</Select></Field>
        <Field label="Name (English)"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="ชื่อบัญชี (ไทย)"><Input value={f.nameTh ?? ''} onChange={(e) => setF({ ...f, nameTh: e.target.value })} /></Field>
        <Field label="Type"><Select value={f.type} disabled={used} onChange={(e) => setF({ ...f, type: e.target.value as Account['type'] })}>{['asset', 'liability', 'equity', 'revenue', 'expense'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="Normal balance"><Select value={f.normal} disabled={used} onChange={(e) => setF({ ...f, normal: e.target.value as 'debit' | 'credit' })}><option>debit</option><option>credit</option></Select></Field>
        <Field label="Financial-statement line"><Select value={f.fsLine} onChange={(e) => setF({ ...f, fsLine: e.target.value as FsLine })}>{Object.entries(FS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Cash-flow class"><Select value={f.cashFlow ?? ''} onChange={(e) => setF({ ...f, cashFlow: (e.target.value || undefined) as Account['cashFlow'] })}><option value="">—</option><option value="cash">Cash</option><option value="operating">Operating</option><option value="investing">Investing</option><option value="financing">Financing</option></Select></Field>
        <Field label="Default tax code"><Select value={f.taxCode ?? ''} onChange={(e) => setF({ ...f, taxCode: e.target.value || undefined })}><option value="">—</option>{Array.from(new Set(db.taxCodes.map((t) => t.code))).map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Analysis dimensions"><div className="row">{(['branch', 'channel'] as const).map((k) => <Check key={k} checked={!!f.dims?.includes(k)} onChange={(v) => setF({ ...f, dims: v ? [...(f.dims ?? []), k] : (f.dims ?? []).filter((x) => x !== k) })}>{k}</Check>)}</div></Field>
        <div className="full row wrap"><Check checked={f.posting ?? true} onChange={(v) => !used && setF({ ...f, posting: v })}><Tx>Posting allowed (untick for a header/grouping account)</Tx></Check><Check checked={!!f.contra} onChange={(v) => setF({ ...f, contra: v || undefined })}><Tx>Contra account</Tx></Check></div>
      </div>
    </Modal>
  );
}

// ---------------- Transaction mapping ----------------
const EVENTS: { event: string; dr: string[]; cr: string[]; note: string }[] = [
  { event: 'Cash / bank sale', dr: ['cash|bank', 'sales_discount'], cr: ['sales', 'output_vat'], note: 'Plus cost of sales: Dr cogs, Cr inventory (+ conversion absorbed)' },
  { event: 'Credit sale', dr: ['ar', 'sales_discount'], cr: ['sales', 'output_vat'], note: 'Receivable is cleared later by a receipt — never new revenue' },
  { event: 'Customer payment of an old invoice', dr: ['cash|bank'], cr: ['ar'], note: 'Overpayment: Cr customer_credit' },
  { event: 'Customer deposit / advance', dr: ['cash|bank'], cr: ['customer_credit'], note: 'Liability until applied to an order' },
  { event: 'Purchase of inventory', dr: ['inv_materials|inv_goods', 'input_vat'], cr: ['ap'], note: 'Landed cost is added to inventory, not expensed' },
  { event: 'Supplier payment', dr: ['ap'], cr: ['bank'], note: 'Deposit: Dr supplier_deposit' },
  { event: 'Raw material issued / finished goods completed', dr: ['inv_goods', 'waste'], cr: ['inv_materials', 'conversion_absorbed'], note: 'Production order; waste is expensed' },
  { event: 'Marketplace sale', dr: ['platform_ar', 'sales_discount'], cr: ['sales', 'output_vat'], note: 'Platform-funded vouchers do not reduce revenue' },
  { event: 'Marketplace settlement', dr: ['bank', 'fee_commission', 'fee_payment', 'fee_shipping', 'settlement_variance'], cr: ['platform_ar'], note: 'Fees and differences posted separately' },
  { event: 'Sales return / credit note', dr: ['sales_returns', 'output_vat', 'inv_goods'], cr: ['ar|platform_ar', 'cogs'], note: 'Restocked goods reverse cost of sales' },
  { event: 'Expense payment', dr: ['(expense account)', 'input_vat'], cr: ['cash|bank'], note: 'Expense category chosen per transaction' },
  { event: 'Transfer between own bank accounts', dr: ['bank|cash'], cr: ['cash|bank'], note: 'Never income or expense' },
  { event: 'Loan received / principal repaid', dr: ['cash|bank (received) · loans (repaid)'], cr: ['loans (received) · cash|bank (repaid)'], note: 'Interest posts to interest_expense' },
  { event: 'Owner contribution / withdrawal', dr: ['bank (contribution) · owner_drawings (withdrawal)'], cr: ['owner_capital (contribution) · bank (withdrawal)'], note: 'Equity, not revenue or operating expense' },
];
function Mapping() {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const me = useUser();
  const canClose = useHas('accounting:close');
  const [edit, setEdit] = useState<string | null>(null);
  const [hist, setHist] = useState<string | null>(null);
  const issues = validateCoa(db).filter((i) => i.msg.startsWith('Role '));
  const resolve = (s: string) => s.split('|').map((r) => { const c = roleCode(db, r); return c ? c : r; }).join('/');
  return (
    <div className="col gap-16">
      {issues.length > 0 && <Banner tone="bad"><b><Tx>Unmapped or invalid roles block posting:</Tx></b> {issues.map((i) => i.msg).join(' · ')}</Banner>}
      <Banner><Tx>The posting engine never hard-codes an account. Each business event posts to</Tx>{' '}<b><Tx>roles</Tx></b><Tx>; this table maps roles to accounts, versioned by effective date.</Tx>{' '}{db.setup.status === 'approved' ? <><Tx>Setup is approved, so changes are</Tx>{' '}<b><Tx>proposed</Tx></b>{' '}<Tx>and need a second approver (you are</Tx>{' '}<b>{me.name}</b>).</> : <><Tx>Setup is in draft, so changes apply directly.</Tx></>}</Banner>
      <Card flush title="Role → account mapping">
        <DataTable rows={ROLE_DEFS} rowKey={(r) => r.key} pageSize={12} search={(r) => r.label + r.events}
          cols={[
            { key: 'l', header: 'Posting role', render: (r) => <><b><Tx>{r.label}</Tx></b><div className="sub">{r.events}</div></> },
            { key: 'a', header: 'Mapped account', render: (r) => { const c = roleCode(db, r.key); const a = c ? findAcct(db, c) : undefined; return a ? <><span className="mono">{a.code}</span> {a.name}<div className="sub">{a.nameTh}</div></> : <Badge tone="bad"><Tx>UNMAPPED</Tx></Badge>; } },
            { key: 'f', header: 'Versions', hideSm: true, render: (r) => <Button size="sm" variant="ghost" onClick={() => setHist(r.key)}>{(db.postingMap[r.key] ?? []).length}{' '}<Tx>· history</Tx></Button> },
            { key: 'p', header: '', render: (r) => { const pend = db.mappingChanges.find((c) => c.role === r.key && c.status === 'pending'); return pend ? <Badge tone="warn"><Tx>pending →</Tx>{' '}{pend.toCode}</Badge> : canClose ? <Button size="sm" onClick={() => setEdit(r.key)}>{db.setup.status === 'approved' ? <Tx>{'Propose change'}</Tx> : <Tx>{'Change'}</Tx>}</Button> : null; } },
          ]} />
      </Card>
      <Card flush title="Posting rules (event → debit / credit)" sub="Resolved through the mapping above. Every rule is balanced and posts idempotently.">
        <div className="table-wrap" role="region" aria-label={tl(lang, 'Scrollable table')} tabIndex={0}><table className="t compact"><thead><tr><th><Tx>Business event</Tx></th><th><Tx>Debit</Tx></th><th><Tx>Credit</Tx></th><th><Tx>Note</Tx></th></tr></thead>
          <tbody>{EVENTS.map((e) => <tr key={e.event}><td><b><Tx>{e.event}</Tx></b></td><td>{e.dr.map((x) => <div key={x}><span className="mono">{resolve(x)}</span> <span className="muted">{x}</span></div>)}</td><td>{e.cr.map((x) => <div key={x}><span className="mono">{resolve(x)}</span> <span className="muted">{x}</span></div>)}</td><td className="muted"><Tx>{e.note}</Tx></td></tr>)}</tbody></table></div>
      </Card>
      {edit && <MapModal role={edit} onClose={() => setEdit(null)} />}
      {hist && <Modal title={`Mapping history — ${ROLE_DEFS.find((r) => r.key === hist)?.label}`} size="sm" onClose={() => setHist(null)}>
        <table className="t compact"><thead><tr><th><Tx>Effective from</Tx></th><th><Tx>Account</Tx></th></tr></thead><tbody>{(db.postingMap[hist] ?? []).slice().reverse().map((e, i) => <tr key={i}><td>{dateFmt(e.from)}</td><td><span className="mono">{e.code}</span> {findAcct(db, e.code)?.name}</td></tr>)}</tbody></table>
        <div className="mt8">{db.mappingChanges.filter((c) => c.role === hist).slice().reverse().map((c) => <div key={c.id} className="muted" style={{ fontSize: 12.5 }}>{dayKey(c.proposedAt)} · → {c.toCode} · <b>{c.status}</b> · {c.reason}</div>)}</div></Modal>}
    </div>
  );
}
function MapModal({ role, onClose }: { role: string; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const def = ROLE_DEFS.find((r) => r.key === role)!;
  const cur = roleCode(db, role);
  const options = db.accounts.filter((a) => a.posting && a.active && def.expect.includes(a.fsLine));
  const [to, setTo] = useState(options.find((o) => o.code !== cur)?.code ?? '');
  const [eff, setEff] = useState(dayKey(new Date(Date.now() + 86400000)));
  const [reason, setReason] = useState('');
  const direct = db.setup.status !== 'approved';
  return (
    <Modal title={`${direct ? 'Change' : 'Propose change to'} “${def.label}” mapping`} size="sm" onClose={onClose}
      footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!to || (!direct && !reason.trim())} onClick={() => run((d, c) => (direct ? setMappingDirect(d, c, role, to) : proposeMapping(d, c, { role, toCode: to, effectiveFrom: new Date(eff + 'T00:00:00').toISOString(), reason })), { ok: direct ? 'Mapping updated (audited)' : 'Proposed — waiting for a second approver (Accounting → Approvals)', perm: 'accounting:close', onOk: onClose })}>{direct ? <Tx>{'Apply'}</Tx> : <Tx>{'Submit for approval'}</Tx>}</Button></>}>
      <div className="col">
        <div className="muted"><Tx>Currently:</Tx>{' '}<span className="mono">{cur}</span> {cur && findAcct(db, cur)?.name}<Tx>. Allowed accounts:</Tx>{' '}{def.expect.map((f, i) => <span key={f}>{i ? ' / ' : ''}<Tx>{FS_LABEL[f]}</Tx></span>)}.</div>
        <Field label="New account"><Select value={to} onChange={(e) => setTo(e.target.value)}>{options.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</Select></Field>
        {!direct && <><Field label="Effective from" hint="Must be after the last closed period; earlier postings keep their account"><Input type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></Field><Field label="Reason (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>}
      </div>
    </Modal>
  );
}

// ---------------- Tax configuration ----------------
function Tax() {
  const db = useDB();
  const run = useRun();
  const canClose = useHas('accounting:close');
  const [open, setOpen] = useState<string | null>(null);
  const codes = Array.from(new Set(db.taxCodes.map((t) => t.code)));
  const now = new Date().toISOString();
  return (
    <div className="col gap-16">
      <Banner tone="warn"><b><Tx>Tax treatment is configuration, versioned by effective date.</Tx></b>{' '}<Tx>Each sale stores the tax code, rate, taxable base, tax amount and rule version at the time, so history never changes when a rate is edited. Confirm rates, tax-invoice formats, withholding tax and non-creditable cases with a Thai accountant.</Tx></Banner>
      <div className="grid g3">
        <Kpi label="VAT registration" value={<Tx>{db.org.vatRegistered ? 'Registered' : 'Not registered'}</Tx>} sub={<Tx vars={{ code: db.org.defaultTaxCode }}>{'default sales code {code}'}</Tx>} />
        <Kpi label="Price basis" value={<Tx>{db.org.taxInclusivePricing ? 'Tax-inclusive' : 'Tax-exclusive'}</Tx>} sub="change in Setup checklist → policies" />
        <Kpi label="Rate in force today" value={`${((taxAt(db, db.org.defaultTaxCode, now)?.rate ?? 0) * 100).toFixed(2)}%`} sub={`${db.org.defaultTaxCode} v${taxAt(db, db.org.defaultTaxCode, now)?.version ?? '–'}`} />
      </div>
      <Card flush title="Tax code register" actions={canClose && <Button size="sm" variant="primary" onClick={() => setOpen('')}><Plus size={14} />{' '}<Tx>New version / code</Tx></Button>}>
        <DataTable rows={[...db.taxCodes].sort((a, b) => a.code.localeCompare(b.code) || b.version - a.version)} rowKey={(t) => t.id} pageSize={12}
          cols={[{ key: 'c', header: 'Code', render: (t) => <><b>{t.code}</b> <Badge>v{t.version}</Badge><div className="sub">{t.name}</div></> }, { key: 'k', header: 'Kind', render: (t) => t.kind.replace('_', ' ') }, { key: 'r', header: 'Rate', num: true, render: (t) => `${(t.rate * 100).toFixed(2)}%` }, { key: 'cr', header: 'Creditable', render: (t) => (t.creditable ? 'yes' : 'no') },
            { key: 'e', header: 'Effective', render: (t) => <>{dateFmt(t.effectiveFrom)}{t.effectiveTo ? ` → ${dateFmt(t.effectiveTo)}` : <Tx>{' → open'}</Tx>}{!t.effectiveTo && <Badge tone="good">{' '}<Tx>current</Tx></Badge>}</> }]} />
      </Card>
      {open != null && <TaxModal code={open} codes={codes} onClose={() => setOpen(null)} />}
    </div>
  );
}
function TaxModal({ code, codes, onClose }: { code: string; codes: string[]; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const cur = db.taxCodes.filter((t) => t.code === code).sort((a, b) => b.version - a.version)[0];
  const [f, setF] = useState({ code: code || 'VAT7', name: cur?.name ?? '', kind: (cur?.kind ?? 'vat') as TaxCode['kind'], rate: (cur?.rate ?? 0.07) * 100, creditable: cur?.creditable ?? true, effectiveFrom: dayKey(new Date(Date.now() + 86400000)), note: '' });
  return (
    <Modal title="New tax code version" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" onClick={() => run((d, c) => saveTaxCode(d, c, { ...f, rate: f.rate / 100, effectiveFrom: new Date(f.effectiveFrom + 'T00:00:00').toISOString() }), { ok: 'Tax version created (audited)', perm: 'accounting:close', onOk: onClose })}><Tx>Save</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Code"><Input value={f.code} list="taxcodes" onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field><datalist id="taxcodes">{codes.map((c) => <option key={c} value={c} />)}</datalist>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TaxCode['kind'] })}>{['vat', 'zero', 'exempt', 'out_of_scope', 'non_creditable'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</Select></Field>
        <Field label="Rate %"><NumInput value={f.rate} onChange={(n) => setF({ ...f, rate: n || 0 })} /></Field>
        <Field label="Effective from" hint="Previous version ends the day before"><Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
        <div style={{ alignSelf: 'flex-end' }}><Check checked={f.creditable} onChange={(v) => setF({ ...f, creditable: v })}><Tx>Input tax is creditable</Tx></Check></div>
      </div>
    </Modal>
  );
}

// ---------------- Opening balances ----------------
function Opening() {
  const db = useDB();
  const run = useRun();
  const me = useUser();
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const canClose = useHas('accounting:close');
  const canCreate = useHas('accounting:create');
  const name = (id?: string) => db.users.find((u) => u.id === id)?.name ?? '—';
  return (
    <div className="col gap-16">
      <Banner><Tx>Opening balances need a</Tx>{' '}<b><Tx>source document</Tx></b><Tx>, a preparer, a reviewer and an approver (different people). Control accounts — receivables, payables, inventory, customer credit — cannot be typed here: their opening balances come from customer invoices, supplier bills and stock counts so the subledger reconciles. You are</Tx>{' '}<b>{me.name}</b>.</Banner>
      <Card flush title="Opening-balance sets" actions={canCreate && <Button size="sm" variant="primary" onClick={() => setEdit('new')}><Plus size={14} />{' '}<Tx>New set</Tx></Button>}>
        <DataTable rows={[...db.openingSets].reverse()} rowKey={(x) => x.id} empty={<Empty title="No opening balances yet" />}
          cols={[
            { key: 'n', header: 'Set', render: (x) => <><b>{x.no}</b><div className="sub"><Tx>as of</Tx>{' '}{dayKey(x.asOf)}{' '}<Tx>· prepared by</Tx>{' '}{name(x.preparedBy)}</div></> }, { key: 's', header: 'Source', render: (x) => <>{x.source}{x.note && <div className="sub">{x.note}</div>}</> },
            { key: 'a', header: 'Debits', num: true, render: (x) => money(x.lines.reduce((s, l) => s + l.debit, 0)) },
            { key: 'st', header: 'Status', render: (x) => <><Badge tone={x.status === 'posted' ? 'good' : x.status === 'reviewed' ? 'info' : 'warn'} dot>{x.status}</Badge>{x.reviewedBy && <div className="sub"><Tx>reviewed by</Tx>{' '}{name(x.reviewedBy)}</div>}{x.approvedBy && <div className="sub"><Tx>approved by</Tx>{' '}{name(x.approvedBy)}</div>}</> },
            { key: 'x', header: '', render: (x) => <div className="row gap-4">
              {x.status === 'draft' && x.preparedBy === me.id && <Button size="sm" onClick={() => setEdit(x.id)}><Tx>Edit</Tx></Button>}
              {x.status === 'draft' && canClose && <Button size="sm" onClick={() => run((d, c) => reviewOpening(d, c, x.id), { ok: 'Reviewed', perm: 'accounting:close' })}><Tx>Review</Tx></Button>}
              {x.status === 'reviewed' && canClose && <Button size="sm" variant="primary" onClick={() => run((d, c) => approveOpening(d, c, x.id), { ok: 'Approved and posted', perm: 'accounting:close' })}><Tx>Approve & post</Tx></Button>}</div> },
          ]} />
      </Card>
      {edit && <OpeningModal id={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function OpeningModal({ id, onClose }: { id?: string; onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const ex = id ? db.openingSets.find((x) => x.id === id) : undefined;
  const [asOf, setAsOf] = useState(dayKey(ex?.asOf ?? new Date()));
  const [source, setSource] = useState(ex?.source ?? '');
  const [note, setNote] = useState(ex?.note ?? '');
  const [lines, setLines] = useState<OpeningSet['lines']>(ex?.lines ?? [{ account: '1500', debit: 0, credit: 0 }, { account: '3010', debit: 0, credit: 0 }]);
  const td = r2(lines.reduce((s, l) => s + (l.debit || 0), 0)), tc = r2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  const preview: OpeningSet = { id: '', no: '', asOf, source, preparedBy: '', createdAt: '', status: 'draft', lines };
  const issues = validateOpening(db, preview);
  return (
    <Modal title={id ? 'Edit opening set' : 'New opening-balance set'} size="lg" onClose={onClose} footer={<><div className="grow">{issues.length ? <Badge tone="bad">{issues[0].slice(0, 70)}{issues[0].length > 70 ? '…' : ''}</Badge> : <Badge tone="good"><Tx>balanced ·</Tx>{' '}{money(td)}</Badge>}</div><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!source.trim()} onClick={() => run((d, c) => saveOpeningSet(d, c, { id, asOf: new Date(asOf + 'T00:00:00').toISOString(), source, lines: lines.map((l) => ({ ...l, debit: l.debit || 0, credit: l.credit || 0 })), note }), { ok: 'Saved as draft', perm: 'accounting:create', onOk: onClose })}><Tx>Save draft</Tx></Button></>}>
      <div className="form-grid"><Field label="As-of date"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><Field label="Source document / reference (required)"><Input value={source} onChange={(e) => setSource(e.target.value)} placeholder={tl(lang, 'e.g. bank statement 30 Sep, asset register v3')} /></Field></div>
      <table className="t compact mt16"><thead><tr><th><Tx>Account</Tx></th><th className="num"><Tx>Debit</Tx></th><th className="num"><Tx>Credit</Tx></th><th /></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={i}><td><Select sm aria-label={tl(lang, 'Account')} value={l.account} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, account: e.target.value } : x)))}>{db.accounts.filter((a) => a.posting && a.active).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}{a.control ? ' (control)' : ''}</option>)}</Select></td>
          <td className="num"><NumInput style={{ width: 120 }} aria-label={tl(lang, 'Debit')} value={l.debit || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, debit: n || 0, credit: n ? 0 : x.credit } : x)))} /></td><td className="num"><NumInput style={{ width: 120 }} aria-label={tl(lang, 'Credit')} value={l.credit || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, credit: n || 0, debit: n ? 0 : x.debit } : x)))} /></td><td><Button size="sm" variant="ghost" icon aria-label={tl(lang, 'Remove line')} onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 size={13} /></Button></td></tr>)}</tbody>
        <tfoot><tr className="total"><td><Tx>Total</Tx></td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td><td /></tr></tfoot></table>
      <div className="row mt8"><Button size="sm" onClick={() => setLines([...lines, { account: '1100', debit: 0, credit: 0 }])}><Plus size={13} />{' '}<Tx>Add line</Tx></Button></div>
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}
export const _as = [toast, r2];
