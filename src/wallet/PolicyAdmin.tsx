// Staff side of the customer payment policy (migration 20261127100000) and of the QR top-up (migration 20261127110000):
//   - "Customers" tab of Payments & wallet: every customer with their policy (partial payments allowed / full payment required) and what they still owe; a finance manager changes it with a reason
//     (the database writes who, when, from, to and why to the history and refuses everybody else).
//   - a card on the Bank accounts tab: which bank account the shop's PromptPay QR pays into. Customers see the QR option in the wallet top-up only after a manager sets it.
// A database without the migrations answers "function not found": the screens say so and change nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../domain/store';
import { money } from '../lib/util';
import { Badge, Banner, Button, Empty, Field, Input, Modal, SearchBox, Select, Skeleton } from '../ui/kit';
import { canFinance, finance, type FinanceRole, type PaymentAccount } from '../finance/api';
import type { PaymentPolicy } from '../finance/paymentPolicy';
import { ShopError } from '../shop/api';
import { type BankAccountRow, type PolicyRow, walletAdmin } from './api';

type TFn = (s: string, v?: Record<string, string | number>) => string;
const missing = (e: unknown) => /could not find the function|schema cache|does not exist/i.test((e as Error)?.message ?? '');
const msg = (e: unknown) => (e instanceof ShopError ? e.message.replace(/^[A-Z_]{3,}:\s*/, '') : e instanceof Error ? e.message : String(e));

export const POLICY_LABEL: Record<PaymentPolicy, string> = { partial: 'Partial payments allowed', full: 'Full payment required' };
export const PolicyBadge = ({ p, T }: { p: PaymentPolicy; T: TFn }) => <Badge tone={p === 'full' ? 'warn' : 'good'} dot>{T(POLICY_LABEL[p])}</Badge>;

export function PoliciesPanel({ T, role }: { T: TFn; role: FinanceRole | null }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PolicyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<PolicyRow | null>(null);
  const seq = useRef(0);
  const manage = canFinance(role, 'manage');
  const load = useCallback(() => {
    const my = ++seq.current;                                              // a slow answer for an old search must not replace the newer one
    walletAdmin.policies(q.trim()).then((r) => { if (my === seq.current) { setRows(r); setError(null); } })
      .catch((e) => { if (my === seq.current) { setRows([]); setError(missing(e) ? T('Customer payment policies are not installed in the database yet.') : msg(e)); } });
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }} data-testid="policies-panel">
      <Banner tone="info">{T('Partial payments allowed: the customer may pay an invoice in instalments. Full payment required: the customer app only accepts the whole outstanding amount in one payment, from a slip or from the wallet. Staff can still record money they really received.')}</Banner>
      {!manage && <Banner tone="warn">{T('Only a finance manager can change a customer\'s policy.')}</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}
      <SearchBox value={q} onChange={setQ} placeholder="Search customer name or code…" />
      {!rows ? <Skeleton h={120} /> : !rows.length ? <Empty title={T('No customers found')} /> : (
        <div className="card table-wrap"><table className="t"><thead><tr><th>{T('Customer')}</th><th>{T('Payment policy')}</th><th className="r">{T('Open invoices')}</th><th className="r">{T('Still owed')}</th><th /></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id} data-testid="policy-row"><td><b>{c.name}</b><div className="sub muted mono">{c.code}</div></td><td><PolicyBadge p={c.payment_policy} T={T} /></td><td className="r">{c.open_invoices}</td><td className="r">{money(c.open_amount)}</td>
              <td className="r">{manage && <Button size="sm" onClick={() => setEdit(c)}>{T('Change')}</Button>}</td></tr>))}</tbody></table></div>
      )}
      {edit && <PolicyEditor c={edit} T={T} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function PolicyEditor({ c, T, onClose, onSaved }: { c: PolicyRow; T: TFn; onClose: () => void; onSaved: () => void }) {
  const [policy, setPolicy] = useState<PaymentPolicy>(c.payment_policy);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const same = policy === c.payment_policy;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await walletAdmin.setPolicy(c.id, policy, reason.trim()); toast('success', T('Payment policy saved')); onSaved(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={T('Payment policy · {n}', { n: c.name })} onClose={() => { if (!busy) onClose(); }}
      footer={<><Button onClick={onClose} disabled={busy}>{T('Cancel')}</Button><Button variant="primary" loading={busy} disabled={busy || same || reason.trim().length < 3} onClick={() => void save()}>{T('Save')}</Button></>}>
      <div className="col gap-8">
        {err && <Banner tone="bad">{err}</Banner>}
        <Field label={T('Payment policy')}>
          <Select value={policy} onChange={(e) => setPolicy(e.target.value as PaymentPolicy)} aria-label={T('Payment policy')}>
            <option value="partial">{T(POLICY_LABEL.partial)}</option><option value="full">{T(POLICY_LABEL.full)}</option>
          </Select>
        </Field>
        <Field label={T('Reason')} hint={T('Kept in the history with your name and the time.')}><Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-label={T('Reason')} /></Field>
        {policy === 'full' && <Banner tone="info">{T('From now on this customer\'s invoices can only be paid in full from the customer app. Invoices that are already partly paid: the customer pays the rest in one payment.')}</Banner>}
      </div>
    </Modal>
  );
}

/** Which bank account does the shop's PromptPay QR pay into? Without this the wallet top-up shows no QR (a deposit is booked to one of the shop's bank accounts). */
export function QrBankCard({ T, role }: { T: TFn; role: FinanceRole | null }) {
  const [acct, setAcct] = useState<PaymentAccount | null | undefined>(undefined);        // undefined = loading, null = no default QR account
  const [banks, setBanks] = useState<BankAccountRow[]>([]);
  const [bank, setBank] = useState('');
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const manage = canFinance(role, 'manage');
  const load = useCallback(() => {
    void Promise.all([finance.accounts(), walletAdmin.banks()]).then(([a, b]) => {
      const d = a.find((x) => x.is_default && x.active) ?? null;
      setBanks(b.filter((x) => x.active)); setAcct(d); setSupported(!d || d.bank_account_id !== undefined); setBank(d?.bank_account_id ?? '');
    }).catch(() => setAcct(null));
  }, []);
  useEffect(load, [load]);
  if (acct === undefined || acct === null || !supported) return null;                  // no QR account, still loading, or the database has no link column yet
  const dirty = bank !== (acct.bank_account_id ?? '');
  const save = async () => {
    setBusy(true);
    try { await walletAdmin.linkQrBank(acct.id, bank || null); toast('success', T('Saved')); load(); } catch (e) { toast('error', msg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card card-b col gap-8" data-testid="qr-bank-card">
      <b>{T('PromptPay QR for wallet top-ups')}</b>
      <div className="muted">{T('The shop\'s QR is "{n}". A wallet top-up is booked to one of your bank accounts, so choose the account this QR pays into. Until you do, customers see no QR option when they top up (bank transfer still works). If this account is not in the list, add it under Add a bank account first.', { n: acct.label })}</div>
      <div className="row wrap gap-8">
        <Select value={bank} onChange={(e) => setBank(e.target.value)} disabled={!manage || busy} aria-label={T('Bank account of the QR')}>
          <option value="">{T('Not linked (no QR option for top-ups)')}</option>
          {banks.map((b) => <option key={b.id} value={b.id}>{b.bank_name_th} ({b.code}) · {b.account_no}</option>)}
        </Select>
        {manage && <Button variant="primary" loading={busy} disabled={busy || !dirty} onClick={() => void save()}>{T('Save')}</Button>}
      </div>
      {!acct.bank_account_id && <Badge tone="warn" dot>{T('Not linked: customers see no QR when they top up')}</Badge>}
    </div>
  );
}
