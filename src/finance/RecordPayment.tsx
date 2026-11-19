// Record a payment at the back office: a bank transfer found in the statement, or cash received at the shop. It is saved already confirmed (by the person who typed it)
// and still has to be posted; it can never be more than the invoice can still take, which the database checks again. A transfer needs its bank and reference and may carry
// the slip file; cash needs a note saying where it was received. Nothing here is pre-filled by the AI and nothing is sent until the person presses the button.
import { useEffect, useState } from 'react';
import { toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { money } from '../lib/util';
import { Banner, Button, Field, Input, Modal, Select, Textarea, Tx } from '../ui/kit';
import { walletAdmin, type BankAccountRow } from '../wallet/api';
import { review } from './review';
import { localInput, reviewErrorText } from './reviewUi';

export interface RecordTarget { invoiceId: string; invoiceNo: string; customer?: string | null; outstanding: number; confirmedPending?: number }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const refLen = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').length;

export default function RecordPayment({ target, onClose, onDone }: { target: RecordTarget; onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const [method, setMethod] = useState<'transfer' | 'cash'>('transfer');
  const [amount, setAmount] = useState('');
  const [when, setWhen] = useState(() => localInput(new Date().toISOString()));
  const [bankId, setBankId] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [banks, setBanks] = useState<BankAccountRow[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { walletAdmin.banks().then((b) => setBanks(b.filter((x) => x.active))).catch(() => setBanks([])); }, []);

  const pending = target.confirmedPending ?? 0;
  const limit = Math.max(r2(target.outstanding - pending), 0);          // what the invoice can still take: what it owes less what is confirmed and waits to be posted
  const amt = Number(amount);
  const amountOk = amount.trim() !== '' && amt > 0 && Math.abs(Math.round(amt * 100) - amt * 100) < 1e-6;
  const cash = method === 'cash';
  const valid = amountOk && !Number.isNaN(new Date(when).getTime()) && note.trim().length >= 3 && (cash || (refLen(ref) >= 4 && (banks.length === 0 || !!bankId)));

  const save = async () => {
    setBusy(true);
    try {
      await review.recordPayment({ invoiceId: target.invoiceId, method, amount: amt, receivedAt: new Date(when).toISOString(), bankRef: ref.trim(), bankAccountId: bankId || null, note: note.trim(), file: cash ? null : file });
      toast('success', tl(lang, 'Payment recorded. It is confirmed and waits to be posted.'));
      onDone();
    } catch (e) { toast('error', reviewErrorText(lang, e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={tl(lang, 'Record payment · {n}', { n: target.invoiceNo })} desc={target.customer ?? undefined} onClose={onClose}
      footer={<><Button onClick={onClose} disabled={busy}><Tx>Cancel</Tx></Button><Button variant="primary" loading={busy} disabled={busy || !valid} onClick={save}><Tx>Record payment</Tx></Button></>}>
      <div className="col gap-8">
        <Banner tone="info"><Tx>Use this for money that did not come with the customer’s own slip: a transfer you found in the bank statement, or cash received at the shop. It is saved as Payment Confirmed and still has to be posted.</Tx></Banner>
        <div className="col gap-4" style={{ fontSize: 13 }}>
          <div className="row between"><span className="muted"><Tx>Outstanding on this invoice</Tx></span><b>{money(target.outstanding)}</b></div>
          <div className="row between"><span className="muted"><Tx>Confirmed, waiting to be posted</Tx></span><b>{money(pending)}</b></div>
          <div className="row between"><span><Tx>Can still be added</Tx></span><b data-limit>{money(limit)}</b></div>
        </div>
        <Field label="Payment method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as 'transfer' | 'cash')}>
            <option value="transfer">{tl(lang, 'Bank transfer')}</option><option value="cash">{tl(lang, 'Cash')}</option>
          </Select>
        </Field>
        <Field label="Amount (฿)">
          <Input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {amountOk && amt > limit && <div className="exp-err" role="status">{tl(lang, 'More than the {n} that can still be added to this invoice.', { n: money(limit) })}</div>}
        <Field label="Received date and time"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        {!cash && (
          <>
            {banks.length > 0 && (
              <Field label="Bank account">
                <Select value={bankId} onChange={(e) => setBankId(e.target.value)}>
                  <option value="">{tl(lang, 'Choose a bank account')}</option>
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.bank_name_th}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Bank transaction reference" hint="From the bank statement. 4 to 80 letters or digits."><Input maxLength={80} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
            <Field label="Slip file (optional)" hint="JPG, PNG or PDF up to 5 MB."><input className="input" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          </>
        )}
        <Field label="Note" hint={cash ? 'Required: say where the cash was received.' : 'Required: say how this payment reached the shop.'}>
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
