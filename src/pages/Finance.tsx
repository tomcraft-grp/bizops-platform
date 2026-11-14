// Payment review & invoices (staff). What a person may do here is decided by their finance role in Supabase
// (viewer / clerk / verifier / manager); the buttons only mirror it. The shop's payment account is set from a picture of
// the shop's own QR: the server checks it is a real Thai QR, and every customer QR is generated server-side from it
// with the exact outstanding amount.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Plus, QrCode, Upload, XCircle } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { Badge, Banner, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Tabs, Tx, useConfirm } from '../ui/kit';
import { canFinance, Evidence, finance, FinanceRole, InvoiceRow, PaymentAccount, QrInfo, Receipt, STATUS } from '../finance/api';
import { decodeQrFromImage } from '../finance/qrImage';
import { dateFmt, dateTimeFmt, money } from '../lib/util';

type Tab = 'slips' | 'review' | 'invoices' | 'account' | 'access';
const ROLE_LABEL: Record<FinanceRole, string> = { viewer: 'Viewer', clerk: 'Clerk', verifier: 'Verifier', manager: 'Manager' };
const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function Finance() {
  const lang = useLang();
  const [role, setRole] = useState<FinanceRole | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('slips');
  const [counts, setCounts] = useState({ slips: 0, review: 0 });
  const refreshCounts = useCallback(async () => {
    try { const [q, r] = await Promise.all([finance.queue(), finance.reviewReceipts()]); setCounts({ slips: q.length, review: r.length }); } catch { /* shown by the tab itself */ }
  }, []);
  useEffect(() => {
    finance.myRole().then((r) => { setRole(r); if (r) void refreshCounts(); })
      .catch((e: Error) => { setErr(/finance_role|schema cache|does not exist|Could not find the function/i.test(e.message) ? tl(lang, 'The finance database part is not set up yet. An administrator needs to apply the finance migration in Supabase.') : e.message); setRole(null); });
  }, [refreshCounts]); // eslint-disable-line react-hooks/exhaustive-deps

  if (role === undefined) return <div className="center" style={{ padding: 60 }}><div className="spinner" /></div>;
  if (!role) return (
    <>
      <PageHead title="Payment review" desc="Verify customer payments and manage invoices." />
      <Card><Empty title="No access to payment review" hint={err ?? 'Ask a manager to give you a finance role (Viewer, Clerk, Verifier or Manager).'} /></Card>
    </>
  );
  return (
    <div>
      <PageHead title="Payment review" desc="Customer slips are evidence only. A payment settles an invoice after you verify it against the bank record."
        actions={<Badge tone="info"><Tx>Your role</Tx>: <Tx>{ROLE_LABEL[role]}</Tx></Badge>} />
      <Card flush>
        <Tabs value={tab} onChange={setTab} tabs={[
          { v: 'slips', label: 'Slips to check', count: counts.slips || '' }, { v: 'review', label: 'Overpayments', count: counts.review || '' },
          { v: 'invoices', label: 'Invoices' }, { v: 'account', label: 'Payment account' },
          ...(canFinance(role, 'manage') ? [{ v: 'access' as const, label: 'Access' }] : []),
        ]} />
        <div style={{ padding: 14 }}>
          {tab === 'slips' && <SlipQueue role={role} onChanged={refreshCounts} />}
          {tab === 'review' && <OverpaymentQueue role={role} onChanged={refreshCounts} />}
          {tab === 'invoices' && <Invoices role={role} />}
          {tab === 'account' && <AccountPanel role={role} />}
          {tab === 'access' && canFinance(role, 'manage') && <AccessPanel />}
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- slips
function SlipQueue({ role, onChanged }: { role: FinanceRole; onChanged: () => void }) {
  const lang = useLang();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof finance.queue>> | null>(null);
  const [open, setOpen] = useState<(Evidence & { invoice_no?: string; customer_name?: string }) | null>(null);
  const load = useCallback(() => finance.queue().then(setRows).catch((e: Error) => { toast('error', e.message); setRows([]); }), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <div className="spinner" />;
  if (!rows.length) return <Empty title="No slips waiting" hint="New customer slips appear here." />;
  return (
    <>
      <div className="table-wrap"><table className="t compact">
        <thead><tr><th><Tx>Received</Tx></th><th><Tx>Invoice</Tx></th><th><Tx>Customer</Tx></th><th style={{ textAlign: 'right' }}><Tx>Customer says</Tx></th><th><Tx>Bank / ref</Tx></th><th /></tr></thead>
        <tbody>{rows.map((e) => (
          <tr key={e.id}><td className="muted">{dateTimeFmt(e.created_at)}</td><td><b>{e.invoice_no}</b></td><td>{e.customer_name}</td>
            <td style={{ textAlign: 'right' }}>{money(e.claimed_amount)}</td><td className="muted">{[e.claimed_bank, e.claimed_ref].filter(Boolean).join(' · ') || '—'}</td>
            <td><Button size="sm" variant="primary" onClick={() => setOpen(e)} disabled={!canFinance(role, 'verify')}><Tx>Check</Tx></Button></td></tr>))}</tbody>
      </table></div>
      {!canFinance(role, 'verify') && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}><Tx>Your role can view slips but not verify them.</Tx></div>}
      {open && <VerifyModal ev={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void load(); onChanged(); }} />}
    </>
  );
  void lang;
}

function VerifyModal({ ev, onClose, onDone }: { ev: Evidence & { invoice_no?: string; customer_name?: string }; onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const ask = useConfirm();
  const [url, setUrl] = useState<string | null>(null);
  const [f, setF] = useState({ amount: '', ref: '', when: localInput(ev.claimed_transfer_at ? new Date(ev.claimed_transfer_at) : new Date()), note: '' });
  const [busy, setBusy] = useState('');
  useEffect(() => { finance.slipUrl(ev.file_path).then(setUrl).catch((e: Error) => toast('error', e.message)); }, [ev.file_path]);
  const amount = Number(f.amount);
  const verify = async () => {
    if (!(amount > 0) || !f.ref.trim()) return toast('error', tl(lang, 'Enter the amount and the bank transaction reference from your bank record'));
    if (Math.abs(amount - ev.claimed_amount) > 0.004) {
      const r = await ask({ title: tl(lang, 'The amount differs from what the customer says'), body: tl(lang, 'Customer says {c}, you entered {a}. The amount from the bank record is the one that will be recorded.', { c: money(ev.claimed_amount), a: money(amount) }), confirmLabel: tl(lang, 'Record bank amount') });
      if (!r.ok) return;
    }
    setBusy('v');
    try {
      const res = await finance.verify({ evidenceId: ev.id, amount, bankTransRef: f.ref.trim(), transferAt: new Date(f.when).toISOString(), note: f.note });
      toast(res.result === 'overpaid_review' ? 'info' : 'success', res.result === 'fully_paid' ? tl(lang, 'Recorded: invoice fully paid') : res.result === 'partially_paid' ? tl(lang, 'Recorded: partially paid, {n} left', { n: money(res.state.outstanding) }) : tl(lang, 'Recorded as an overpayment: decide it under Overpayments'));
      onDone();
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  const reject = async () => {
    const r = await ask({ title: tl(lang, 'Reject this slip?'), body: tl(lang, 'The customer sees your reason and can send a new slip.'), confirmLabel: tl(lang, 'Reject'), danger: true, reason: tl(lang, 'Reason (shown to the customer)') });
    if (!r.ok) return;
    setBusy('r');
    try { await finance.reject(ev.id, r.reason); toast('success', tl(lang, 'Rejected')); onDone(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  return (
    <Modal size="lg" title={tl(lang, 'Check slip · {n}', { n: ev.invoice_no ?? '' })} desc={ev.customer_name} onClose={onClose}
      footer={<><Button variant="danger" onClick={reject} disabled={!!busy}><XCircle size={15} /> <Tx>Reject</Tx></Button><Button variant="primary" loading={busy === 'v'} disabled={!!busy} onClick={verify}><CheckCircle2 size={15} /> <Tx>Verify and record payment</Tx></Button></>}>
      <div className="row gap-16 wrap" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          {!url ? <div className="spinner" /> : ev.file_type === 'application/pdf'
            ? <a href={url} target="_blank" rel="noreferrer" className="row gap-4"><ExternalLink size={14} /> <Tx>Open the PDF slip</Tx></a>
            : <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={tl(lang, 'Payment slip')} style={{ width: '100%', maxHeight: 460, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 8 }} /></a>}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}><Tx>Customer claims</Tx>: {money(ev.claimed_amount)}{ev.claimed_bank && ` · ${ev.claimed_bank}`}{ev.claimed_ref && ` · ${ev.claimed_ref}`}{ev.claimed_transfer_at && ` · ${dateTimeFmt(ev.claimed_transfer_at)}`}</div>
        </div>
        <div className="col gap-8" style={{ flex: '1 1 260px' }}>
          <Banner tone="warn"><Tx>Fill these in from your bank statement or banking app, not from the slip picture alone. A slip can be faked.</Tx></Banner>
          <Field label="Amount received (฿)"><Input type="number" inputMode="decimal" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Bank transaction reference"><Input maxLength={80} value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
          <Field label="Transfer date and time"><Input type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></Field>
          <Field label="Note (optional)"><Input maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------- overpayments
function OverpaymentQueue({ role, onChanged }: { role: FinanceRole; onChanged: () => void }) {
  const lang = useLang();
  const ask = useConfirm();
  const [rows, setRows] = useState<Receipt[] | null>(null);
  const load = useCallback(() => finance.reviewReceipts().then(setRows).catch((e: Error) => { toast('error', e.message); setRows([]); }), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <div className="spinner" />;
  if (!rows.length) return <Empty title="No overpayments to review" />;
  const resolve = async (r: Receipt) => {
    const a = await ask({ title: tl(lang, 'Apply {r}?', { r: r.receipt_no }), body: tl(lang, 'The invoice is credited up to what is outstanding. Any excess stays as the customer’s credit; refund it or apply it to another invoice separately.'), confirmLabel: tl(lang, 'Apply and keep excess as credit'), reason: tl(lang, 'What was agreed with the customer') });
    if (!a.ok) return;
    try { await finance.resolveOverpayment(r.id, a.reason); toast('success', tl(lang, 'Overpayment resolved')); void load(); onChanged(); } catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>Receipt</Tx></th><th><Tx>Received</Tx></th><th><Tx>Bank ref</Tx></th><th style={{ textAlign: 'right' }}><Tx>Amount</Tx></th><th /></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td><b>{r.receipt_no}</b></td><td className="muted">{dateTimeFmt(r.received_at)}</td><td className="mono">{r.bank_trans_ref}</td><td style={{ textAlign: 'right' }}>{money(r.amount)}</td>
        <td><Button size="sm" variant="primary" disabled={!canFinance(role, 'verify')} onClick={() => resolve(r)}><Tx>Decide</Tx></Button></td></tr>)}</tbody></table></div>
  );
}

// ------------------------------------------------------------------------------------------- invoices
function Invoices({ role }: { role: FinanceRole }) {
  const lang = useLang();
  const ask = useConfirm();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => finance.overview().then(setRows).catch((e: Error) => { toast('error', e.message); setRows([]); }), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <div className="spinner" />;
  const shown = filter === '' ? rows : rows.filter((r) => String(r.status_code) === filter);
  const cancel = async (r: InvoiceRow) => {
    const a = await ask({ title: tl(lang, 'Cancel invoice {n}?', { n: r.invoice_no }), body: tl(lang, 'Only an invoice with no recorded payment can be cancelled. It stays in the history.'), confirmLabel: tl(lang, 'Cancel invoice'), danger: true, reason: tl(lang, 'Reason') });
    if (!a.ok) return;
    try { await finance.cancelInvoice(r.id, a.reason); toast('success', tl(lang, 'Invoice cancelled')); void load(); } catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <div className="col gap-8">
      <div className="row gap-8 wrap">
        <Select sm style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={tl(lang, 'Status')}>
          <option value="">{tl(lang, 'All statuses')}</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{lang === 'th' ? v.th : v.en}</option>)}</Select>
        {canFinance(role, 'invoice') && <Button size="sm" onClick={() => setAdding(true)}><Plus size={14} /> <Tx>Issue invoice</Tx></Button>}
      </div>
      {!shown.length ? <Empty title="No invoices" /> : (
        <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>Invoice</Tx></th><th><Tx>Customer</Tx></th><th><Tx>Due</Tx></th><th style={{ textAlign: 'right' }}><Tx>Amount</Tx></th><th style={{ textAlign: 'right' }}><Tx>Paid</Tx></th><th style={{ textAlign: 'right' }}><Tx>Outstanding</Tx></th><th><Tx>Status</Tx></th><th /></tr></thead>
          <tbody>{shown.map((r) => { const s = STATUS[r.status_code]; return (
            <tr key={r.id}><td><b>{r.invoice_no}</b><div className="sub">{dateFmt(r.issue_date)}{r.source_ref ? ` · ${r.source_ref}` : ''}</div></td><td>{r.customer_name}</td><td className="muted">{dateFmt(r.due_date)}</td>
              <td style={{ textAlign: 'right' }}>{money(r.amount)}</td><td style={{ textAlign: 'right' }}>{money(r.paid)}</td><td style={{ textAlign: 'right' }}><b>{money(r.outstanding)}</b></td>
              <td><Badge tone={s.tone} dot>{lang === 'th' ? s.th : s.en}</Badge></td>
              <td>{canFinance(role, 'manage') && r.status_code !== 8 && r.paid === 0 && <Button size="sm" variant="ghost" onClick={() => cancel(r)}><Tx>Cancel</Tx></Button>}</td></tr>); })}</tbody></table></div>
      )}
      {adding && <NewInvoice onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} />}
    </div>
  );
}

function NewInvoice({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const [customers, setCustomers] = useState<{ id: string; code: string; name: string }[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ customerId: '', amount: '', issue: today, due: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), description: '', sourceRef: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { finance.customers().then((c) => { setCustomers(c); setF((x) => ({ ...x, customerId: x.customerId || c[0]?.id || '' })); }).catch((e: Error) => toast('error', e.message)); }, []);
  const save = async () => {
    setBusy(true);
    try { const i = await finance.createInvoice({ ...f, amount: Number(f.amount) }); toast('success', tl(lang, 'Invoice {n} issued', { n: i.invoice_no })); onDone(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={tl(lang, 'Issue invoice')} onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" loading={busy} disabled={busy || !f.customerId || !(Number(f.amount) > 0)} onClick={save}><Tx>Issue</Tx></Button></>}>
      <div className="col gap-8">
        {!customers.length && <Banner tone="warn"><Tx>No finance customers yet. Customers must be added (linked to their app sign-in) before invoices can be issued.</Tx></Banner>}
        <Field label="Customer"><Select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}>{customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
        <Field label="Amount (฿)" hint="The amount cannot be changed after issuing."><Input type="number" inputMode="decimal" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <div className="row gap-8"><Field label="Issue date"><Input type="date" value={f.issue} onChange={(e) => setF({ ...f, issue: e.target.value })} /></Field><Field label="Due date"><Input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field></div>
        <Field label="Description"><Input maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Order / source reference (optional)" hint="Prevents issuing two open invoices for the same order."><Input maxLength={80} value={f.sourceRef} onChange={(e) => setF({ ...f, sourceRef: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------- payment account (QR picture)
const TARGET_TYPE: Record<string, string> = { phone: 'PromptPay (mobile number)', national_id: 'PromptPay (ID / tax number)', e_wallet: 'PromptPay (e-wallet)', biller_id: 'Thai QR bill payment (Biller ID)' };
function maskTarget(t: string) { return t.length > 6 ? `${t.slice(0, 3)}${'•'.repeat(t.length - 6)}${t.slice(-3)}` : t; }

function AccountPanel({ role }: { role: FinanceRole }) {
  const lang = useLang();
  const ask = useConfirm();
  const [accounts, setAccounts] = useState<PaymentAccount[] | null>(null);
  const [found, setFound] = useState<{ payload: string; info: QrInfo } | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const manage = canFinance(role, 'manage');
  const load = useCallback(() => finance.accounts().then(setAccounts).catch((e: Error) => { toast('error', e.message); setAccounts([]); }), []);
  useEffect(() => { void load(); }, [load]);

  const pick = async (f: File | null) => {
    if (!f) return;
    setBusy(true); setFound(null);
    try {
      const payload = await decodeQrFromImage(f);
      const info = await finance.describeQr(payload);   // the server validates it (Thai QR, checksum, baht, receiving account)
      setFound({ payload, info });
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!found) return;
    const r = await ask({ title: tl(lang, 'Use this account for customer payments?'), body: tl(lang, 'Customers will pay to {t}. Check that it is the shop’s own account.', { t: maskTarget(found.info.target) }), confirmLabel: tl(lang, 'Use this account') });
    if (!r.ok) return;
    setBusy(true);
    try { await finance.saveAccount(found.payload, label.trim() || 'Shop account'); toast('success', tl(lang, 'Payment account saved')); setFound(null); setLabel(''); void load(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };
  const disable = async (a: PaymentAccount) => {
    const r = await ask({ title: tl(lang, 'Stop using “{n}”?', { n: a.label }), body: tl(lang, 'Customers cannot create new payment QRs until another account is set. QRs already shown still pay this account.'), confirmLabel: tl(lang, 'Stop using'), danger: true });
    if (r.ok) try { await finance.disableAccount(a.id); void load(); } catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <div className="col gap-12">
      <div className="muted" style={{ fontSize: 12.5 }}><Tx>Upload a picture of the shop’s own payment QR (e.g. the one in the bank passbook or app). The system reads the receiving account from it and, for every invoice, makes a new QR from that account with the exact amount still owed. Customers never type the amount.</Tx></div>
      {!accounts ? <div className="spinner" /> : !accounts.some((a) => a.active) && <Banner tone="warn"><Tx>No payment account yet: customers cannot create payment QRs.</Tx></Banner>}
      {accounts?.map((a) => (
        <div key={a.id} className="dev-item">
          <div className="row between"><div><b>{a.label}</b> {a.is_default && a.active && <Badge tone="good"><Tx>in use</Tx></Badge>}{!a.active && <Badge><Tx>stopped</Tx></Badge>}
            <div className="muted" style={{ fontSize: 12 }}><Tx>{TARGET_TYPE[a.target_type] ?? a.target_type}</Tx> · <span className="mono">{maskTarget(a.target)}</span>{a.merchant_name && ` · ${a.merchant_name}`}</div></div>
            {manage && a.active && <Button size="sm" variant="ghost" onClick={() => disable(a)}><Tx>Stop using</Tx></Button>}</div>
        </div>
      ))}
      {manage ? (
        <div className="col gap-8">
          <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; void pick(f); }} />
          <div><Button loading={busy && !found} disabled={busy} onClick={() => file.current?.click()}><Upload size={15} /> <Tx>Upload the shop’s QR picture</Tx></Button></div>
          {found && (
            <div className="dev-item">
              <div className="row gap-6"><QrCode size={18} /><b><Tx>QR read successfully</Tx></b></div>
              <div style={{ fontSize: 13 }}><Tx>{TARGET_TYPE[found.info.target_type] ?? found.info.target_type}</Tx>: <b className="mono">{maskTarget(found.info.target)}</b>{found.info.merchant_name && <> · {found.info.merchant_name}</>}</div>
              {found.info.has_amount && <div className="muted" style={{ fontSize: 12 }}><Tx>This QR already has an amount; it is ignored. Each customer QR gets its own amount.</Tx></div>}
              {found.info.kind === 'bill_payment' && <div className="muted" style={{ fontSize: 12 }}><Tx>This is a bank bill-payment QR. Test one real payment with a banking app before you rely on it.</Tx></div>}
              <Field label="Name for this account"><Input maxLength={80} value={label} placeholder={tl(lang, 'e.g. KBank company account')} onChange={(e) => setLabel(e.target.value)} /></Field>
              <div className="row gap-6"><Button variant="primary" loading={busy} disabled={busy} onClick={save}><Tx>Use this account</Tx></Button><Button onClick={() => setFound(null)}><Tx>Cancel</Tx></Button></div>
            </div>
          )}
        </div>
      ) : <div className="muted" style={{ fontSize: 12 }}><Tx>Only a manager can change the payment account.</Tx></div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- access
function AccessPanel() {
  const lang = useLang();
  const [rows, setRows] = useState<{ user_id: string; email: string; display_name: string | null; profile_role: string; finance_role: FinanceRole | null }[] | null>(null);
  const load = useCallback(() => finance.staff().then(setRows).catch((e: Error) => { toast('error', e.message); setRows([]); }), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <div className="spinner" />;
  return (
    <div className="col gap-8">
      <div className="muted" style={{ fontSize: 12.5 }}><Tx>Verifying payments, resolving overpayments, reversing receipts and changing the payment account are limited to these roles. A SUPER_ADMIN is always a manager.</Tx></div>
      <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>Employee</Tx></th><th><Tx>Account role</Tx></th><th><Tx>Finance role</Tx></th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.user_id}><td>{r.display_name || r.email}<div className="sub">{r.email}</div></td><td className="muted">{r.profile_role}</td>
            <td>{r.profile_role === 'SUPER_ADMIN' ? <Badge tone="good"><Tx>Manager</Tx></Badge> : (
              <Select sm style={{ width: 'auto' }} value={r.finance_role ?? ''} aria-label={tl(lang, 'Finance role')} onChange={async (e) => {
                try { await finance.setRole(r.user_id, (e.target.value || null) as FinanceRole | null); toast('success', tl(lang, 'Access updated')); void load(); } catch (er) { toast('error', (er as Error).message); }
              }}><option value="">{tl(lang, 'No access')}</option>{(['viewer', 'clerk', 'verifier', 'manager'] as FinanceRole[]).map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</Select>)}</td></tr>))}</tbody></table></div>
    </div>
  );
}
