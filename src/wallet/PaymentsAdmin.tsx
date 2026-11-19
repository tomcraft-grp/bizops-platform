// Back office: every customer payment, customer wallets and their ledgers, bank accounts (payment methods), the queue that carries
// money events to the general ledger on this device, and the daily bank / reconciliation reports.
// Every action is a server function that checks the caller's finance role again; verification, refunds, adjustments and
// reversals are never possible for a customer, and nothing here edits a balance directly.
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Eye, Plus } from 'lucide-react';
import { act, toast, useDB, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { dateTimeFmt, money } from '../lib/util';
import { roleCode } from '../domain/accounting';
import { eventLabel, financeNetCredit, planFinanceRow, postFinanceRow, verifyPosted } from '../domain/financeLedger';
import { Badge, Banner, Button, Drawer, Empty, Field, Input, Modal, PageHead, SearchBox, Select, Skeleton, Switch, Tabs, Textarea, useHas } from '../ui/kit';
import { canFinance, finance, FinanceRole } from '../finance/api';
import { ShopError } from '../shop/api';
import { BankAccountRow, BankReportRow, FinanceSettings, GlRow, LedgerRow, newKey, PaymentRow, Reconciliation, walletAdmin, WalletReconcile, WalletRow } from './api';
import { BankBadge } from './ui';
import { formatAccountNo } from './bank';

type Tab = 'payments' | 'wallets' | 'banks' | 'ledger' | 'reports';
type TFn = (s: string, v?: Record<string, string | number>) => string;
const msg = (e: unknown) => (e instanceof ShopError ? e.message.replace(/^[A-Z_]{3,}:\s*/, '') : e instanceof Error ? e.message : String(e));
const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | ''> = { pending: 'warn', submitted: 'info', under_review: 'info', verified: 'good', rejected: 'bad', cancelled: '' };
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', submitted: 'Submitted', under_review: 'Under review', verified: 'Verified', rejected: 'Rejected', cancelled: 'Cancelled' };
const KIND_LABEL: Record<string, string> = { deposit: 'Wallet deposit', invoice_slip: 'Invoice slip', wallet_payment: 'Wallet payment' };
const TYPE_LABEL: Record<string, string> = { DEPOSIT: 'Deposit', INVOICE_PAYMENT: 'Invoice payment', REFUND: 'Refund', ADJUSTMENT: 'Adjustment', WITHDRAWAL: 'Withdrawal', REVERSAL: 'Reversal' };
const StatusBadge = ({ s, T }: { s: string; T: TFn }) => <Badge tone={STATUS_TONE[s] ?? ''} dot>{T(STATUS_LABEL[s] ?? s)}</Badge>;
const num = (v: unknown) => Number(v ?? 0);

export default function PaymentsAdmin() {
  const lang = useLang();
  const T: TFn = (s, v) => tl(lang, s, v);
  const [tab, setTab] = useState<Tab>('payments');
  const [role, setRole] = useState<FinanceRole | null>(null);
  const [roleLoaded, setRoleLoaded] = useState(false);
  useEffect(() => { finance.myRole().then(setRole).catch(() => setRole(null)).finally(() => setRoleLoaded(true)); }, []);
  return (
    <>
      <PageHead title="Payments & wallet" desc="Customer payments, wallets and their ledger, bank accounts, and the entries that go to the accounting ledger. A slip never adds money: staff verify it against the bank record first." />
      {roleLoaded && !role && <Banner tone="warn">{T('You can look around, but you have no finance role. Ask a manager to give you one (Payment review → Access).')}</Banner>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ v: 'payments', label: 'Payments' }, { v: 'wallets', label: 'Wallets' }, { v: 'banks', label: 'Bank accounts' }, { v: 'ledger', label: 'Accounting ledger' }, { v: 'reports', label: 'Reports' }]} />
      {tab === 'payments' && <PaymentsPanel T={T} role={role} />}
      {tab === 'wallets' && <WalletsPanel T={T} role={role} />}
      {tab === 'banks' && <BanksPanel T={T} role={role} />}
      {tab === 'ledger' && <LedgerPanel T={T} role={role} />}
      {tab === 'reports' && <ReportsPanel T={T} />}
    </>
  );
}

// ================================================================================================ payments
function PaymentsPanel({ T, role }: { T: TFn; role: FinanceRole | null }) {
  const [f, setF] = useState({ kind: '', status: '', bank: '', search: '' });
  const [limit, setLimit] = useState(50);
  const [data, setData] = useState<{ total: number; items: PaymentRow[] } | null>(null);
  const [banks, setBanks] = useState<BankAccountRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<PaymentRow | null>(null);
  const load = useCallback(() => { walletAdmin.payments({ ...f, limit }).then((r) => { setData(r); setError(null); }).catch((e) => setError(msg(e))); }, [f, limit]);
  useEffect(() => { const h = setTimeout(load, f.search ? 300 : 0); return () => clearTimeout(h); }, [load, f.search]);
  useEffect(() => { walletAdmin.banks().then(setBanks).catch(() => undefined); }, []);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <div className="row wrap">
        <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label={T('Type')}>
          <option value="">{T('All types')}</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{T(v)}</option>)}
        </Select>
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label={T('Status')}>
          <option value="">{T('All statuses')}</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{T(v)}</option>)}
        </Select>
        <Select value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} aria-label={T('Bank account')}>
          <option value="">{T('All bank accounts')}</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.bank_name_th}</option>)}
        </Select>
        <div style={{ marginLeft: 'auto', minWidth: 240 }}><SearchBox value={f.search} onChange={(v) => setF({ ...f, search: v })} placeholder="Customer, invoice no., payment no. or bank reference" /></div>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      {!data && !error ? <Skeleton h={160} /> : data && !data.items.length ? <Empty title={T('No payments match')} /> : data && (
        <div className="card table-wrap">
          <table className="t"><thead><tr><th>{T('Date')}</th><th>{T('Type')}</th><th>{T('No.')}</th><th>{T('Customer')}</th><th>{T('Invoice')}</th><th>{T('Bank account')}</th><th className="r">{T('Amount')}</th><th>{T('Status')}</th><th /></tr></thead>
            <tbody>{data.items.map((p) => (
              <tr key={p.kind + p.id}>
                <td>{dateTimeFmt(p.created_at)}</td><td>{T(KIND_LABEL[p.kind])}</td><td className="mono">{p.no}</td><td>{p.customer_name}<div className="sub muted">{p.customer_code}</div></td>
                <td className="mono">{p.invoice_no ?? '—'}</td><td>{p.bank_code ?? '—'}</td>
                <td className="r">{money(p.verified_amount ?? p.amount)}{p.verified_amount != null && p.verified_amount !== p.amount && <div className="sub muted">{T('claimed')} {money(p.amount)}</div>}</td>
                <td><StatusBadge s={p.status} T={T} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {p.kind === 'deposit' && ['submitted', 'under_review'].includes(p.status) && <Button size="sm" variant="primary" onClick={() => setReview(p)}>{T('Review')}</Button>}
                  {p.kind === 'invoice_slip' && p.status === 'submitted' && <Link className="btn sm" to="/payment-review">{T('Review in Payment review')}</Link>}
                  {p.file_path && p.kind !== 'wallet_payment' && <SlipButton path={p.file_path} T={T} />}
                </td>
              </tr>))}</tbody></table>
        </div>
      )}
      {data && data.items.length < data.total && <Button onClick={() => setLimit(limit + 50)}>{T('Show more')} ({data.items.length}/{data.total})</Button>}
      {review && <DepositReview p={review} T={T} role={role} onClose={() => setReview(null)} onDone={() => { setReview(null); load(); }} />}
    </div>
  );
}

function SlipButton({ path, T }: { path: string; T: TFn }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try { const url = await finance.slipUrl(path); window.open(url, '_blank', 'noopener'); } catch (e) { toast('error', msg(e)); } finally { setBusy(false); }
  };
  return <Button size="sm" variant="ghost" loading={busy} onClick={() => void open()}><Eye size={13} /> {T('View slip')}</Button>;
}

function DepositReview({ p, T, role, onClose, onDone }: { p: PaymentRow; T: TFn; role: FinanceRole | null; onClose: () => void; onDone: () => void }) {
  const [img, setImg] = useState<string | null>(null);
  const [form, setForm] = useState({ amount: String(p.amount), ref: '', when: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), note: '' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const can = canFinance(role, 'verify');
  useEffect(() => { if (p.file_path && !p.file_path.endsWith('.pdf')) finance.slipUrl(p.file_path).then(setImg).catch(() => undefined); }, [p.file_path]);
  const run = async (what: string, fn: () => Promise<unknown>, ok: string) => { setBusy(what); setErr(null); try { await fn(); toast('success', T(ok)); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(''); } };
  return (
    <Modal title={`${T('Review deposit')} ${p.no}`} onClose={onClose} size="lg" footer={<Button onClick={onClose}>{T('Close')}</Button>}>
      <div className="col gap-12">
        {err && <Banner tone="bad">{err}</Banner>}
        {!can && <Banner tone="warn">{T('Only a verifier or manager can approve or reject payments.')}</Banner>}
        <div className="row wrap" style={{ alignItems: 'flex-start' }}>
          <div className="col gap-4" style={{ minWidth: 220, flex: 1 }}>
            <b>{p.customer_name}</b><span className="muted">{p.customer_code}</span>
            <span>{T('Bank account')}: <b>{p.bank_code}</b> {p.bank_name_th}</span>
            <span>{T('Claimed amount')}: <b>{money(p.amount)}</b></span>
            <span className="muted">{dateTimeFmt(p.created_at)}</span>
            {p.status === 'submitted' && can && <Button size="sm" onClick={() => void run('review', () => walletAdmin.startReview(p.id), 'Marked as under review')} loading={busy === 'review'}>{T('Mark as under review')}</Button>}
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>{img ? <img src={img} alt={T('Slip')} style={{ width: '100%', maxHeight: 300, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 8 }} /> : p.file_path ? <SlipButton path={p.file_path} T={T} /> : null}</div>
        </div>
        <Banner tone="info">{T('Check the slip against the bank statement. The wallet is credited with the amount the BANK shows, and only after you approve.')}</Banner>
        <div className="row wrap">
          <Field label={T('Amount received (฿)')}><Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label={T('Bank transaction reference')}><Input value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></Field>
          <Field label={T('Transfer date and time')}><Input type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} /></Field>
        </div>
        <Field label={T('Note (optional)')}><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        <div className="row wrap">
          <Button variant="primary" disabled={!can || !!busy || !form.ref.trim() || !(Number(form.amount) > 0)} loading={busy === 'verify'}
            onClick={() => void run('verify', () => walletAdmin.verifyDeposit({ id: p.id, amount: Number(form.amount), bankTransRef: form.ref, transferAt: new Date(form.when).toISOString(), note: form.note }), 'Deposit verified: the wallet was credited')}>{T('Approve and credit the wallet')}</Button>
        </div>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label={T('Reason for rejecting (the customer sees it)')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button variant="danger" disabled={!can || !!busy || !reason.trim()} loading={busy === 'reject'} onClick={() => void run('reject', () => walletAdmin.rejectDeposit(p.id, reason), 'Deposit rejected: nothing was credited')}>{T('Reject')}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ================================================================================================ wallets
function WalletsPanel({ T, role }: { T: TFn; role: FinanceRole | null }) {
  const [search, setSearch] = useState('');
  const [data, setData] = useState<{ total: number; sum_balance: number; items: WalletRow[] } | null>(null);
  const [rec, setRec] = useState<WalletReconcile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<WalletRow | null>(null);
  const load = useCallback(() => {
    walletAdmin.wallets(search, 100, 0).then((r) => { setData(r); setError(null); }).catch((e) => setError(msg(e)));
    walletAdmin.reconcile().then(setRec).catch(() => setRec(null));
  }, [search]);
  useEffect(() => { const h = setTimeout(load, search ? 300 : 0); return () => clearTimeout(h); }, [load, search]);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <div className="row wrap">
        {rec && (rec.problems.length ? <Badge tone="bad">{T('Ledger check: {n} problem(s)', { n: rec.problems.length })}</Badge> : <Badge tone="good" dot>{T('Ledger check: every balance equals its ledger')}</Badge>)}
        {data && <span className="muted">{T('Total in wallets')}: <b>{money(data.sum_balance)}</b></span>}
        <div style={{ marginLeft: 'auto', minWidth: 240 }}><SearchBox value={search} onChange={setSearch} placeholder="Customer name or code" /></div>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      {!data && !error ? <Skeleton h={120} /> : data && !data.items.length ? <Empty title={T('No wallets yet')} hint={T('A wallet is created when a customer first adds money.')} /> : data && (
        <div className="card table-wrap"><table className="t"><thead><tr><th>{T('Customer')}</th><th className="r">{T('Balance')}</th><th className="r">{T('Total deposits')}</th><th className="r">{T('Total payments')}</th><th>{T('Last activity')}</th></tr></thead>
          <tbody>{data.items.map((w) => (
            <tr key={w.wallet_id} className="click" tabIndex={0} onClick={() => setOpen(w)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(w); }}>
              <td>{w.name}<div className="sub muted">{w.code}</div></td><td className="r"><b>{money(w.balance)}</b></td><td className="r">{money(w.total_deposits)}</td><td className="r">{money(w.total_payments)}</td><td>{w.last_activity ? dateTimeFmt(w.last_activity) : '—'}</td>
            </tr>))}</tbody></table></div>
      )}
      {open && <WalletDrawer w={open} T={T} role={role} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function WalletDrawer({ w, T, role, onClose, onChanged }: { w: WalletRow; T: TFn; role: FinanceRole | null; onClose: () => void; onChanged: () => void }) {
  const [led, setLed] = useState<{ balance: number; total: number; items: LedgerRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adj, setAdj] = useState({ direction: 'credit' as 'credit' | 'debit', amount: '', reason: '', note: '' });
  const [refunds, setRefunds] = useState<{ id: string; receipt_no: string; amount: number }[]>([]);
  const [rf, setRf] = useState({ receipt: '', amount: '', reason: '' });
  const [busy, setBusy] = useState('');
  const manage = canFinance(role, 'manage');
  const load = useCallback(() => {
    walletAdmin.ledger(w.customer_id, 100, 0).then((r) => { setLed(r); setError(null); }).catch((e) => setError(msg(e)));
    walletAdmin.refundable(w.customer_id).then(setRefunds).catch(() => setRefunds([]));
  }, [w.customer_id]);
  useEffect(load, [load]);
  const reversed = useMemo(() => new Set((led?.items ?? []).map((x) => x.reversal_of).filter(Boolean) as string[]), [led]);
  const run = async (what: string, fn: () => Promise<{ balance: number }>, ok: string, reset?: () => void) => {
    setBusy(what); setError(null);
    try { const r = await fn(); toast('success', `${T(ok)} · ${T('Balance')} ${money(r.balance)}`); reset?.(); load(); onChanged(); } catch (e) { setError(msg(e)); } finally { setBusy(''); }
  };
  return (
    <Drawer title={w.name} sub={`${w.code} · ${T('Balance')} ${money(led?.balance ?? w.balance)}`} onClose={onClose}>
      <div className="col gap-12">
        {error && <Banner tone="bad">{error}</Banner>}
        {!manage && <Banner tone="info">{T('Adjustments, reversals and refunds need a finance manager.')}</Banner>}
        {manage && (
          <div className="card card-b col gap-8"><b>{T('Adjust the balance')}</b>
            <div className="row wrap"><Select value={adj.direction} onChange={(e) => setAdj({ ...adj, direction: e.target.value as 'credit' | 'debit' })} aria-label={T('Direction')}><option value="credit">{T('Add money (credit)')}</option><option value="debit">{T('Take money (debit)')}</option></Select>
              <Input type="number" step="0.01" min="0" placeholder="0.00" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} aria-label={T('Amount')} /></div>
            <Field label={T('Reason (at least 10 characters, kept in the audit log)')}><Textarea rows={2} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
            <Field label={T('Note the customer will see (optional)')}><Input maxLength={200} value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></Field>
            <div><Button variant="primary" loading={busy === 'adj'} disabled={!!busy || !(Number(adj.amount) > 0) || adj.reason.trim().length < 10}
              onClick={() => void run('adj', () => walletAdmin.adjust({ customer: w.customer_id, direction: adj.direction, amount: Number(adj.amount), reason: adj.reason, customerNote: adj.note, key: newKey() }), 'Wallet adjusted', () => setAdj({ ...adj, amount: '', reason: '', note: '' }))}>{T('Apply adjustment')}</Button></div>
          </div>
        )}
        {manage && refunds.length > 0 && (
          <div className="card card-b col gap-8"><b>{T('Refund a reversed receipt into the wallet')}</b>
            <div className="row wrap"><Select value={rf.receipt} onChange={(e) => { const r = refunds.find((x) => x.id === e.target.value); setRf({ ...rf, receipt: e.target.value, amount: r ? String(r.amount) : '' }); }} aria-label={T('Receipt')}>
              <option value="">{T('Choose a receipt')}</option>{refunds.map((r) => <option key={r.id} value={r.id}>{r.receipt_no} · {money(r.amount)}</option>)}</Select>
              <Input type="number" step="0.01" min="0" value={rf.amount} onChange={(e) => setRf({ ...rf, amount: e.target.value })} aria-label={T('Amount')} /></div>
            <Field label={T('Reason')}><Input value={rf.reason} onChange={(e) => setRf({ ...rf, reason: e.target.value })} /></Field>
            <div><Button loading={busy === 'rf'} disabled={!!busy || !rf.receipt || !(Number(rf.amount) > 0) || !rf.reason.trim()}
              onClick={() => void run('rf', () => walletAdmin.refund({ receipt: rf.receipt, amount: Number(rf.amount), reason: rf.reason, key: newKey() }), 'Refunded into the wallet', () => setRf({ receipt: '', amount: '', reason: '' }))}>{T('Refund to wallet')}</Button></div>
          </div>
        )}
        <b>{T('Ledger')}</b>
        {!led ? <Skeleton h={120} /> : !led.items.length ? <Empty title={T('No transactions')} /> : (
          <div className="table-wrap"><table className="t compact"><thead><tr><th>{T('Date')}</th><th>{T('Type')}</th><th className="r">{T('Amount')}</th><th className="r">{T('Balance')}</th><th>{T('Details')}</th><th /></tr></thead>
            <tbody>{led.items.map((x) => (
              <tr key={x.id}>
                <td>{dateTimeFmt(x.txn_date)}<div className="sub muted mono">{x.txn_no}</div></td><td>{T(TYPE_LABEL[x.txn_type] ?? x.txn_type)}</td>
                <td className="r" style={{ color: x.direction === 'credit' ? 'var(--good-text)' : undefined }}>{x.direction === 'credit' ? '+' : '−'}{money(x.amount)}</td>
                <td className="r">{money(x.balance_after)}<div className="sub muted">{T('before')} {money(x.balance_before)}</div></td>
                <td style={{ maxWidth: 220 }}>{[x.bank_code, x.ref_no].filter(Boolean).join(' · ')}<div className="sub muted">{x.remarks}</div><div className="sub muted">{x.created_by_email ?? ''}{x.approved_by_email && x.approved_by_email !== x.created_by_email ? ` → ${x.approved_by_email}` : ''}</div></td>
                <td>{manage && !['REVERSAL', 'INVOICE_PAYMENT'].includes(x.txn_type) && !reversed.has(x.id) && <ReverseButton x={x} T={T} onDone={() => { load(); onChanged(); }} />}</td>
              </tr>))}</tbody></table></div>
        )}
      </div>
    </Drawer>
  );
}

function ReverseButton({ x, T, onDone }: { x: LedgerRow; T: TFn; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setBusy(true); setErr(null); try { await walletAdmin.reverse(x.id, reason); toast('success', T('Reversed')); setOpen(false); onDone(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{T('Reverse')}</Button>
      {open && (
        <Modal size="sm" title={`${T('Reverse')} ${x.txn_no}`} onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>{T('Cancel')}</Button><Button variant="danger" loading={busy} disabled={busy || reason.trim().length < 10} onClick={() => void go()}>{T('Reverse')}</Button></>}>
          <div className="col gap-8">{err && <Banner tone="bad">{err}</Banner>}<span>{T('This adds an opposite ledger row. The original stays. It is refused if it would make the balance negative.')}</span>
            <Field label={T('Reason (at least 10 characters)')}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
        </Modal>
      )}
    </>
  );
}

// ================================================================================================ bank accounts
function BanksPanel({ T, role }: { T: TFn; role: FinanceRole | null }) {
  const [rows, setRows] = useState<BankAccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<BankAccountRow> | null>(null);
  const [settings, setSettings] = useState<FinanceSettings | null>(null);
  const manage = canFinance(role, 'manage');
  const load = useCallback(() => {
    walletAdmin.banks().then((r) => { setRows(r); setError(null); }).catch((e) => setError(msg(e)));
    walletAdmin.glQueue('pending', 1).then((r) => setSettings(r.settings)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <Banner tone="info">{T('These accounts are shown to customers as payment methods. Details are kept here only: the app has no copy. An account that has payments cannot get a new number: add a new one and switch the old one off.')}</Banner>
      {error && <Banner tone="bad">{error}</Banner>}
      {manage && <div><Button variant="primary" onClick={() => setEdit({ active: true, sort_order: 100 })}><Plus size={14} /> {T('Add a bank account')}</Button></div>}
      {!rows ? <Skeleton h={120} /> : (
        <div className="card table-wrap"><table className="t"><thead><tr><th /><th>{T('Bank')}</th><th>{T('Account number')}</th><th>{T('Account name')}</th><th>{T('Ledger account')}</th><th>{T('Status')}</th><th /></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}><td style={{ width: 54 }}><BankBadge bank={b} /></td><td><b>{b.bank_name_th}</b> ({b.code})<div className="sub muted">{b.bank_name_en}</div></td><td className="mono">{formatAccountNo(b.account_no)}</td><td>{b.account_name}</td>
              <td>{b.gl_account_code ?? <span className="muted">{T('default bank account')}</span>}</td><td><Badge tone={b.active ? 'good' : ''} dot>{b.active ? T('Active') : T('Inactive')}</Badge></td>
              <td>{manage && <Button size="sm" onClick={() => setEdit(b)}>{T('Edit')}</Button>}</td></tr>))}</tbody></table></div>
      )}
      {settings && manage && <SettingsCard s={settings} T={T} onSaved={load} />}
      {edit && <BankEditor b={edit} T={T} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function BankEditor({ b, T, onClose, onSaved }: { b: Partial<BankAccountRow>; T: TFn; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ code: b.code ?? '', bank_name_en: b.bank_name_en ?? '', bank_name_th: b.bank_name_th ?? '', account_no: b.account_no ?? '', account_name: b.account_name ?? '', branch: b.branch ?? '', logo_url: b.logo_url ?? '',
    instructions_th: b.instructions_th ?? '', instructions_en: b.instructions_en ?? '', gl_account_code: b.gl_account_code ?? '', sort_order: String(b.sort_order ?? 100), active: b.active ?? true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setErr(null);
    try { await walletAdmin.saveBank({ id: b.id, ...f, sort_order: Number(f.sort_order) || 100, branch: f.branch || null, logo_url: f.logo_url || null, instructions_th: f.instructions_th || null, instructions_en: f.instructions_en || null, gl_account_code: f.gl_account_code || null }); toast('success', T('Saved')); onSaved(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={b.id ? T('Edit bank account') : T('Add a bank account')} onClose={onClose} size="lg" footer={<><Button onClick={onClose}>{T('Cancel')}</Button><Button variant="primary" loading={busy} disabled={busy} onClick={() => void save()}>{T('Save')}</Button></>}>
      <div className="col gap-8">
        {err && <Banner tone="bad">{err}</Banner>}
        <div className="row wrap"><Field label={T('Code')} hint={T('e.g. SCB, BBL, KBANK')}><Input value={f.code} maxLength={12} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field label={T('Thai name')}><Input value={f.bank_name_th} onChange={(e) => set('bank_name_th', e.target.value)} /></Field><Field label={T('English name')}><Input value={f.bank_name_en} onChange={(e) => set('bank_name_en', e.target.value)} /></Field></div>
        <div className="row wrap"><Field label={T('Account number')}><Input inputMode="numeric" value={f.account_no} onChange={(e) => set('account_no', e.target.value)} /></Field>
          <Field label={T('Account name')}><Input value={f.account_name} onChange={(e) => set('account_name', e.target.value)} /></Field><Field label={T('Branch (optional)')}><Input value={f.branch} onChange={(e) => set('branch', e.target.value)} /></Field></div>
        <Field label={T('Logo picture link (optional, https)')} hint={T('Without one, a coloured badge with the bank code is shown.')}><Input value={f.logo_url} onChange={(e) => set('logo_url', e.target.value)} /></Field>
        <Field label={T('Instructions for customers (Thai)')}><Textarea rows={2} maxLength={500} value={f.instructions_th} onChange={(e) => set('instructions_th', e.target.value)} /></Field>
        <Field label={T('Instructions for customers (English)')}><Textarea rows={2} maxLength={500} value={f.instructions_en} onChange={(e) => set('instructions_en', e.target.value)} /></Field>
        <div className="row wrap"><Field label={T('Ledger account code')} hint={T('Leave empty to use the ledger\'s default bank account. The code must exist in the chart of accounts.')}><Input inputMode="numeric" value={f.gl_account_code} onChange={(e) => set('gl_account_code', e.target.value)} /></Field>
          <Field label={T('Sort order')}><Input type="number" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field></div>
        <Switch checked={f.active} onChange={(v) => set('active', v)} label="Active (shown to customers)" />
      </div>
    </Modal>
  );
}

function SettingsCard({ s, T, onSaved }: { s: FinanceSettings; T: TFn; onSaved: () => void }) {
  const [f, setF] = useState({ min_deposit: String(s.min_deposit), max_deposit: String(s.max_deposit), max_open_deposits: String(s.max_open_deposits), adjustment_limit: String(s.adjustment_limit) });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await walletAdmin.saveSettings({ min_deposit: Number(f.min_deposit), max_deposit: Number(f.max_deposit), max_open_deposits: Number(f.max_open_deposits), adjustment_limit: Number(f.adjustment_limit) }); toast('success', T('Saved')); onSaved(); }
    catch (e) { toast('error', msg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card card-b col gap-8"><b>{T('Wallet limits')}</b>
      <div className="row wrap">
        <Field label={T('Smallest deposit (฿)')}><Input type="number" min="0" value={f.min_deposit} onChange={(e) => setF({ ...f, min_deposit: e.target.value })} /></Field>
        <Field label={T('Largest deposit (฿)')}><Input type="number" min="0" value={f.max_deposit} onChange={(e) => setF({ ...f, max_deposit: e.target.value })} /></Field>
        <Field label={T('Open deposits per customer')}><Input type="number" min="1" value={f.max_open_deposits} onChange={(e) => setF({ ...f, max_open_deposits: e.target.value })} /></Field>
        <Field label={T('Adjustments above this need a SUPER_ADMIN (฿)')}><Input type="number" min="0" value={f.adjustment_limit} onChange={(e) => setF({ ...f, adjustment_limit: e.target.value })} /></Field>
      </div>
      <div><Button variant="primary" loading={busy} disabled={busy} onClick={() => void save()}>{T('Save')}</Button></div>
    </div>
  );
}

// ================================================================================================ accounting ledger (the queue)
function LedgerPanel({ T, role }: { T: TFn; role: FinanceRole | null }) {
  const db = useDB();
  const lang = useLang();
  const canPost = useHas('accounting:create');
  const [show, setShow] = useState<'pending' | 'posted'>('pending');
  const [data, setData] = useState<{ settings: FinanceSettings; items: GlRow[] } | null>(null);
  const [rec, setRec] = useState<Reconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [date, setDate] = useState('');
  const manage = canFinance(role, 'manage');
  const load = useCallback(() => {
    walletAdmin.glQueue(show, 300).then((r) => { setData(r); setError(null); }).catch((e) => setError(msg(e)));
    walletAdmin.glReconciliation().then(setRec).catch(() => setRec(null));
  }, [show]);
  useEffect(load, [load]);
  const acct = (code: string) => { const a = db.accounts.find((x) => x.code === code); return a ? `${a.code} ${lang === 'th' ? a.nameTh : a.name}` : code; };
  const resolved = (row: GlRow) => planFinanceRow(db, row, data!.settings, date ? { date: new Date(date + 'T12:00:00+07:00').toISOString() } : {});
  const postOne = async (row: GlRow): Promise<boolean> => {
    try {
      const r = act((d, ctx) => postFinanceRow(d, ctx, row, data!.settings, date ? { date: new Date(date + 'T12:00:00+07:00').toISOString() } : {}), { perm: 'accounting:create' });
      try { await walletAdmin.glMarkPosted(row.id, r.journalNo); } catch (e) { toast('error', T('Posted as {no} in the ledger, but the database could not record it ({why}). Open this list again to finish.', { no: r.journalNo, why: msg(e) })); return false; }
      return true;
    } catch (e) { toast('error', `${row.ref_no ?? row.event_type}: ${msg(e)}`); return false; }
  };
  const post = async (row: GlRow) => { setBusy(row.id); if (await postOne(row)) toast('success', T('Posted to the ledger')); setBusy(''); load(); };
  const postAll = async () => {
    if (!data) return;
    setBusy('all'); let n = 0; const done = new Set<string>();
    for (const row of [...data.items].sort((a, b) => a.seq - b.seq)) {
      const blocked = row.blocked_by && !done.has(row.blocked_by.id);
      if (blocked || !resolved(row).ok) continue;
      if (await postOne(row)) { n++; done.add(row.id); } else break;
    }
    toast(n ? 'success' : 'info', T('{n} entries posted', { n })); setBusy(''); load();
  };
  const voidRow = async (row: GlRow) => {
    const reason = window.prompt(T('Why is this entry voided? (at least 10 characters)')); if (!reason) return;
    try { await walletAdmin.glVoid(row.id, reason); toast('success', T('Voided')); load(); } catch (e) { toast('error', msg(e)); }
  };
  const customerCredit = roleCode(db, 'customer_credit') ?? '2300';
  const local = useMemo(() => (data && show === 'posted' ? verifyPosted(db, data.items.map((r) => ({ id: r.id, amount: r.amount, journal_no: r.journal_no, event_type: r.event_type }))) : null), [db.journals, data, show]);
  const ready = data ? data.items.filter((r) => show === 'pending' && !r.blocked_by && resolved(r).ok).length : 0;

  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <Banner tone="info">{T('Every verified deposit, wallet payment, bank receipt, refund, adjustment and invoice is queued here in the same moment it happens. Post them to the accounting ledger on this device; each can be posted once.')}</Banner>
      {error && <Banner tone="bad">{error}</Banner>}
      {rec && (
        <div className="card card-b col gap-4"><b>{T('Wallet ledger vs accounting ledger')}</b>
          <div className="row wrap" style={{ gap: 18 }}>
            <span>{T('Wallet balances')}: <b>{money(rec.wallet_balances)}</b></span><span>{T('Posted to the ledger')}: <b>{money(rec.gl_wallet_liability_posted)}</b></span>
            <span>{T('Waiting to be posted')}: <b>{money(rec.gl_wallet_liability_waiting)}</b></span><span>{T('Difference')}: <Badge tone={Math.abs(rec.difference) < 0.005 ? 'good' : 'bad'}>{money(rec.difference)}</Badge></span>
          </div>
          <span className="muted">{T('On this device the customer-credit account {code} holds {amount} from these entries.', { code: customerCredit, amount: money(financeNetCredit(db, customerCredit)) })}</span>
        </div>
      )}
      <div className="row wrap">
        <div className="seg"><button className={show === 'pending' ? 'on' : ''} onClick={() => setShow('pending')}>{T('Waiting')}</button><button className={show === 'posted' ? 'on' : ''} onClick={() => setShow('posted')}>{T('Posted')}</button></div>
        {show === 'pending' && <>
          <Field label={T('Post on date (optional)')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Button variant="primary" disabled={!canPost || !!busy || !ready} loading={busy === 'all'} onClick={() => void postAll()}>{T('Post all that are ready')} ({ready})</Button>
        </>}
        {!canPost && show === 'pending' && <span className="muted">{T('Posting needs accounting permission on this device.')}</span>}
      </div>
      {show === 'posted' && local && <Banner tone={local.mismatched.length ? 'warn' : 'info'}>{T('{here} of these were posted on this device, {elsewhere} on another device.', { here: local.here, elsewhere: local.elsewhere })}{local.mismatched.length ? ` ${T('{n} do not match their journal.', { n: local.mismatched.length })}` : ''}</Banner>}
      {!data ? <Skeleton h={160} /> : !data.items.length ? <Empty title={show === 'pending' ? T('Nothing waiting: the ledger is up to date') : T('Nothing posted yet')} /> : (
        <div className="col gap-8">{data.items.map((row) => {
          const p = show === 'pending' ? resolved(row) : null;
          return (
            <div key={row.id} className="card card-b col gap-4" data-event={row.event_type}>
              <div className="row between wrap"><span><b>{T(eventLabel(row.event_type))}</b> <span className="mono muted">{row.ref_no}</span></span>
                <span className="row gap-6"><b>{money(row.amount)}</b>{show === 'posted' ? <Badge tone="good" dot>{row.journal_no}</Badge> : row.blocked_by ? <Badge tone="warn">{T('Post {no} first', { no: row.blocked_by.ref_no ?? '' })}</Badge> : p && !p.ok ? <Badge tone="bad">{T('Cannot post yet')}</Badge> : <Badge tone="good" dot>{T('Ready')}</Badge>}</span></div>
              <div className="muted" style={{ fontSize: 12.5 }}>{row.customer_name ?? ''} · {dateTimeFmt(row.event_date)}</div>
              <table className="t compact"><tbody>{row.plan.map((l, i) => {
                const code = l.role === 'bank' ? (row.banks[l.bank_account_id ?? '']?.gl_account_code ?? roleCode(db, 'bank') ?? 'bank') : roleCode(db, l.role) ?? l.role;
                return <tr key={i}><td style={{ width: 40 }}>{l.side === 'dr' ? 'Dr' : 'Cr'}</td><td>{acct(code)}{l.role === 'bank' && l.bank_account_id && row.banks[l.bank_account_id] ? ` (${row.banks[l.bank_account_id].code})` : ''}</td><td className="r">{money(l.amount)}</td></tr>;
              })}</tbody></table>
              {p && !p.ok && <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--crit-text)', fontSize: 12.5 }}>{p.errors.map((e, i) => <li key={i}>{T(e)}</li>)}</ul>}
              {show === 'pending' && <div className="row gap-6">
                <Button variant="primary" size="sm" disabled={!canPost || !!busy || !!row.blocked_by || !p?.ok} loading={busy === row.id} onClick={() => void post(row)}>{T('Post to ledger')}</Button>
                {manage && <Button size="sm" variant="ghost" onClick={() => void voidRow(row)}>{T('Void')}</Button>}
              </div>}
            </div>
          );
        })}</div>
      )}
      {data && role && canFinance(role, 'manage') && <TaxSettings s={data.settings} T={T} onSaved={load} />}
    </div>
  );
}

function TaxSettings({ s, T, onSaved }: { s: FinanceSettings; T: TFn; onSaved: () => void }) {
  const [mode, setMode] = useState<FinanceSettings['invoice_vat_mode']>(s.invoice_vat_mode);
  const [rate, setRate] = useState(String(s.vat_rate));
  const [role, setRole] = useState(s.adjustment_role);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await walletAdmin.saveSettings({ invoice_vat_mode: mode, vat_rate: Number(rate), adjustment_role: role }); toast('success', T('Saved')); onSaved(); } catch (e) { toast('error', msg(e)); } finally { setBusy(false); } };
  return (
    <div className="card card-b col gap-8"><b>{T('Accounting settings')}</b>
      <div className="row wrap">
        <Field label={T('Tax treatment of invoices in the ledger')} hint={T('Until you choose, invoices cannot be posted (payments and wallet entries can).')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as FinanceSettings['invoice_vat_mode'])}><option value="unset">{T('Not chosen yet')}</option><option value="none">{T('No VAT split (whole amount is sales)')}</option><option value="inclusive">{T('Prices include VAT (split out output VAT)')}</option></Select></Field>
        <Field label={T('VAT rate (%)')}><Input type="number" min="0" max="99" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label={T('Account role for wallet adjustments')} hint={T('The other side of a staff adjustment (a role from Accounting setup).')}><Input value={role} onChange={(e) => setRole(e.target.value)} /></Field>
      </div>
      <div><Button variant="primary" loading={busy} disabled={busy} onClick={() => void save()}>{T('Save')}</Button></div>
    </div>
  );
}

// ================================================================================================ reports
function ReportsPanel({ T }: { T: TFn }) {
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(week);
  const [to, setTo] = useState(today);
  const [bank, setBank] = useState('');
  const [banks, setBanks] = useState<BankAccountRow[]>([]);
  const [rows, setRows] = useState<BankReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { walletAdmin.banks().then(setBanks).catch(() => undefined); }, []);
  useEffect(() => { setRows(null); walletAdmin.bankReport(from, to, bank).then((r) => { setRows(r); setError(null); }).catch((e) => setError(msg(e))); }, [from, to, bank]);
  const tot = (k: keyof BankReportRow) => (rows ?? []).reduce((s, r) => s + num(r[k]), 0);
  const csv = () => {
    const head = ['date', 'bank', 'deposits', 'deposit_amount', 'invoice_transfers', 'invoice_amount', 'total', 'in_ledger', 'waiting_for_ledger'];
    const body = (rows ?? []).map((r) => [r.day, r.bank_code, r.deposits, r.deposit_amount, r.invoice_transfers, r.invoice_amount, r.total, r.in_ledger, r.waiting_for_ledger].join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + [head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `bank-report-${from}-${to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <Banner tone="info">{T('What should appear on each bank statement: verified deposits and verified invoice transfers, by day and account, and whether the accounting ledger already has them. Compare the totals with the bank statement.')}</Banner>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label={T('From')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={T('To')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={T('Bank account')}><Select value={bank} onChange={(e) => setBank(e.target.value)}><option value="">{T('All bank accounts')}</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>
        <Button onClick={csv} disabled={!rows?.length}><Download size={14} /> {T('Export CSV')}</Button>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      {!rows && !error ? <Skeleton h={120} /> : rows && !rows.length ? <Empty title={T('No verified payments in this period')} /> : rows && (
        <div className="card table-wrap"><table className="t"><thead><tr><th>{T('Date')}</th><th>{T('Bank account')}</th><th className="r">{T('Deposits')}</th><th className="r">{T('Invoice transfers')}</th><th className="r">{T('Total')}</th><th className="r">{T('In the ledger')}</th><th className="r">{T('Waiting for the ledger')}</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}><td>{r.day}</td><td>{r.bank_code === 'CASH' ? T('Cash') : r.bank_code}</td><td className="r">{money(r.deposit_amount)}<div className="sub muted">{r.deposits}</div></td><td className="r">{money(r.invoice_amount)}<div className="sub muted">{r.invoice_transfers}</div></td>
              <td className="r"><b>{money(r.total)}</b></td><td className="r">{money(r.in_ledger)}</td><td className="r">{r.waiting_for_ledger > 0 ? <Badge tone="warn">{money(r.waiting_for_ledger)}</Badge> : money(0)}</td></tr>))}
            <tr className="total"><td colSpan={2}>{T('Total')}</td><td className="r">{money(tot('deposit_amount'))}</td><td className="r">{money(tot('invoice_amount'))}</td><td className="r">{money(tot('total'))}</td><td className="r">{money(tot('in_ledger'))}</td><td className="r">{money(tot('waiting_for_ledger'))}</td></tr></tbody></table></div>
      )}
    </div>
  );
}

export type _Unused = ReactNode;
