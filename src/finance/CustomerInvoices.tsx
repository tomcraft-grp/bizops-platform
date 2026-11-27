// Customer side of "pay an invoice with a Thai QR": invoice facts, a QR for exactly what is still owed (amount computed by
// the server), Save QR image, slip upload, and a clear message for every outcome. A slip never settles anything by
// itself; only staff verification (or later a verification provider / bank record) does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useLang, toast } from '../domain/store';
import { Lang, t as tl } from '../lib/i18n';
import { Badge, Banner, Button, Card, Field, Input } from '../ui/kit';
import { PayToBank, QrPanel, QrProblem, QrWaiting } from '../wallet/PayTo';
import { Choice, PayMethodPicker, useMethods } from '../wallet/ui';
import { TransferAmount, WalletPayPanel } from '../wallet/PayInvoice';
import { dateFmt, dateTimeFmt, money } from '../lib/util';
import { CustomerEvidence, finance, InvoiceRow, QrRequest, Receipt, STATUS, StatusCode } from './api';
import { review } from './review';
import { holdUp, IDLE, type LiveState, SlipLive } from '../slipReader/SlipLive';
import { SlipCheck } from './SlipCheck';
import { payNotes } from '../shop/pay';
import { withTimeout } from '../shop/timeout';
import { tr } from '../shop/i18n';
import { policyView, useMyPaymentPolicy } from './paymentPolicy';
import { slipProblem } from '../wallet/api';

const MSG: Record<StatusCode, { th: string; en: string; tone: 'info' | 'warn' | 'bad' | 'good' }> = {
  0: { th: 'ยังไม่ได้ชำระเงิน กรุณาเลือกช่องทางการชำระเงินด้านล่าง', en: 'Not paid yet. Choose how to pay below.', tone: 'info' },
  1: { th: 'รอการชำระเงิน กรุณาสแกน QR Code ผ่านแอปพลิเคชันธนาคาร และแนบหลักฐานการโอนเงิน', en: 'Waiting for payment. Scan the QR with any banking app, then upload your slip.', tone: 'info' },
  3: { th: 'ได้รับหลักฐานการชำระเงินแล้ว อยู่ระหว่างการตรวจสอบ ยอดชำระจะปรับปรุงภายหลังการตรวจสอบ', en: 'Slip received. The shop is checking it; your balance updates once it is verified.', tone: 'warn' },
  4: { th: 'ชำระเงินบางส่วนแล้ว กรุณาเลือกช่องทางเพื่อชำระยอดคงเหลือ', en: 'Partly paid. Choose how to pay the remaining balance.', tone: 'warn' },
  5: { th: 'ตรวจสอบการชำระเงินสำเร็จ ชำระครบถ้วนแล้ว ขอขอบคุณ', en: 'Payment verified. Fully paid. Thank you!', tone: 'good' },
  6: { th: 'ยอดที่ชำระสูงกว่ายอดค้างชำระ ทางร้านอยู่ระหว่างตรวจสอบและจะติดต่อกลับ', en: 'You paid more than the balance. The shop is reviewing it and will contact you.', tone: 'warn' },
  7: { th: 'ไม่สามารถยืนยันการชำระเงินได้ กรุณาตรวจสอบข้อมูลตามเหตุผลด้านล่าง แล้วแนบหลักฐานใหม่หรือเลือกช่องทางอื่น', en: 'Your payment evidence was rejected (see the reason below). Send a new slip or choose another way to pay.', tone: 'bad' },
  8: { th: 'ใบแจ้งหนี้นี้ถูกยกเลิก', en: 'This invoice was cancelled.', tone: 'warn' },
  9: { th: 'QR Code หมดอายุ กรุณาสร้างใหม่ หากชำระเงินแล้ว กรุณาแนบหลักฐานการโอนเงิน', en: 'The QR expired. Create a new one. If you already paid, upload your slip.', tone: 'warn' },
  10: { th: 'ทางร้านขอหลักฐานการชำระเงินเพิ่มเติม กรุณาแนบหลักฐานใหม่', en: 'The shop asked for more evidence of your payment. Please send a new slip.', tone: 'warn' },
};

/** The reason the database gives to a "more evidence" slip that the customer's newer slip closed (trigger finance_evidence_supersede_old): not a refusal, so the history does not call it one. */
const REPLACED = 'Replaced by a newer slip';
/** One line of the payment history per slip that is not posted: a slip the shop CONFIRMED is waiting to be recorded, never "rejected". An unknown status reads as waiting. */
const EVIDENCE_NOTE: Partial<Record<CustomerEvidence['status'], string>> = {
  submitted: 'waiting for the shop to check', confirmed: 'the shop confirmed it; being recorded', more_evidence: 'the shop asked for more evidence', rejected: 'rejected',
};

export function CustomerInvoices({ lang: langProp, hide }: { lang?: Lang; hide?: (r: InvoiceRow) => boolean } = {}) {
  const storeLang = useLang();
  const lang = langProp ?? storeLang;
  const [all, setRows] = useState<InvoiceRow[] | null>(null);
  const rows = all && hide ? all.filter((r) => !hide(r)) : all;   // e.g. the shop screen hides invoices that belong to shop orders
  const reload = useCallback(() => finance.myInvoices().then(setRows).catch(() => setRows([])), []);
  useEffect(() => { void reload(); }, [reload]);
  // No finance invoices (or the finance tables are not set up yet): the Pay tab is exactly what it was.
  if (!rows?.length) return null;
  const owing = rows.filter((r) => r.status_code !== 8).reduce((s, r) => s + r.outstanding, 0);
  return (
    <>
      <h2>{tl(lang, 'Invoices')}</h2>
      <div className="card card-b row between"><span className="muted">{tl(lang, 'Total outstanding')}</span><b style={{ fontSize: 22 }} className={owing > 0 ? 'bad' : 'good'}>{money(owing)}</b></div>
      {rows.map((r) => <InvoiceCard key={r.id} inv={r} lang={lang} onChanged={reload} />)}
    </>
  );
}

/** `compact`: inside an order page, which already shows whose order it is and what it costs: only what is paid and what remains. */
export function InvoiceCard({ inv, onChanged, lang: langProp, defaultOpen, preferred, compact }: { inv: InvoiceRow; onChanged: () => void; lang?: Lang; defaultOpen?: boolean; preferred?: string | null; compact?: boolean }) {
  const storeLang = useLang();
  const lang = langProp ?? storeLang;
  // the panel opens by itself when there is something to do: pay (1), pay again after the QR expired (9), or send another slip because the shop asked for more evidence (10)
  const [open, setOpen] = useState(defaultOpen ?? (inv.status_code === 1 || inv.status_code === 9 || inv.status_code === 10));
  // the picked slip is shown as a preview first: nothing is sent until the customer confirms it
  const [picked, setPicked] = useState<{ file: File; url: string | null } | null>(null);
  const pickedUrl = useRef<string | null>(null);
  const pick = (f: File | null) => {
    if (f) void slipProblem(f).then((bad) => { if (bad) { pick(null); toast('error', tr(lang, bad)); } });
    if (pickedUrl.current) URL.revokeObjectURL(pickedUrl.current);
    const url = f && f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
    pickedUrl.current = url; setPicked(f ? { file: f, url } : null);
  };
  useEffect(() => () => { if (pickedUrl.current) URL.revokeObjectURL(pickedUrl.current); }, []);
  const [qr, setQr] = useState<QrRequest | null>(null);
  // how the customer pays: a bank account, the wallet or the PromptPay QR (all from the database-driven payment methods)
  const { methods, error: methodsError, reload: reloadMethods } = useMethods();
  const [picked0, setChoice] = useState<Choice>(null);
  const hasMethods = !!methods && (methods.banks.length > 0 || methods.wallet.balance > 0);
  // the customer's choice at checkout (when it is still available) comes first, then the first bank
  const prefChoice: Choice = !methods || !preferred ? null : preferred === 'wallet' ? (methods.wallet.balance > 0 ? { kind: 'wallet' } : null) : preferred === 'qr' ? (methods.promptpay ? { kind: 'qr' } : null)
    : preferred.startsWith('bank:') ? (() => { const b = methods.banks.find((x) => x.code === preferred.slice(5)); return b ? { kind: 'bank' as const, id: b.id } : null; })() : null;
  const choice: Choice = picked0 ?? prefChoice ?? (hasMethods ? (methods!.banks.length ? { kind: 'bank', id: methods!.banks[0].id } : methods!.wallet.balance > 0 ? { kind: 'wallet' } : methods!.promptpay ? { kind: 'qr' } : null) : null);
  const bankChoice = choice?.kind === 'bank' ? methods?.banks.find((b) => b.id === choice.id) : undefined;
  const loadingMethods = !methods && !methodsError;
  const showQr = !loadingMethods && (!hasMethods || choice?.kind === 'qr');   // without any other method (or on an old database) the QR is the only way to pay
  const [picking, setPicking] = useState(false);                             // the list of methods is closed until the customer wants to change the method
  const [qrError, setQrError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [history, setHistory] = useState<{ ev: CustomerEvidence[]; rc: Receipt[] } | null>(null);
  const [form, setForm] = useState({ amount: '', when: '', bank: '', ref: '' });
  // the customer's payment policy: under 'full' the amount is the whole outstanding amount and cannot be edited (the database refuses anything else)
  const policy = useMyPaymentPolicy();
  const pv = policyView(policy, inv);
  const file = useRef<HTMLInputElement>(null);
  const upBtn = useRef<HTMLDivElement>(null);
  const [slipLive, setSlipLive] = useState<LiveState>(IDLE);                         // the check of the picked slip on this phone
  const [sent, setSent] = useState(0);                                       // slips sent from this card: look at the check again
  const st = STATUS[inv.status_code] ?? STATUS[0];
  const msg = MSG[inv.status_code] ?? MSG[0];   // a state this build does not know (a newer database) reads as "not paid yet" instead of crashing
  const notes = payNotes(inv, lang);
  // a QR made for another amount (the shop recorded a part payment meanwhile) must not be paid: it counts as no QR, and a new one is made
  const live = [qr, inv.request && !inv.request.expired ? { ...inv.request, account_label: '', merchant_name: null } : null].find((q) => q && Number(q.amount) === Number(inv.outstanding)) ?? null;
  const payable = inv.status_code !== 8 && inv.status_code !== 5 && inv.status_code !== 6 && inv.outstanding > 0;

  const loadHistory = useCallback(async () => {
    // each part on its own: when one read fails the other still shows (the receipts must not vanish with the slips, nor the slips with the receipts)
    const [ev, rc] = await Promise.allSettled([finance.myEvidence(inv.id), finance.myReceipts(inv.id)]);
    setHistory({ ev: ev.status === 'fulfilled' ? ev.value : [], rc: rc.status === 'fulfilled' ? rc.value : [] });
  }, [inv.id]);
  useEffect(() => { if (open) void loadHistory(); }, [open, loadHistory, inv.status_code]);
  useEffect(() => { setForm((f) => ({ ...f, amount: pv.locked ? String(inv.outstanding) : f.amount || String(inv.outstanding) })); }, [inv.outstanding, pv.locked]);

  const makeQr = async () => {
    setBusy('qr'); setQrError(null);
    try { setQr(await finance.requestPayment(inv.id)); onChanged(); } catch (e) { setQrError((e as Error).message); toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  // choosing the QR shows it: no second button to find. Not while a slip waits (3), more evidence is wanted (10) or after a QR expired (9): then the money may already
  // have been sent, so a new QR is only made when the customer asks for it.
  const autoQr = open && payable && choice?.kind === 'qr' && !live && !busy && !qrError && [0, 1, 4, 7].includes(inv.status_code);
  const asked = useRef('');
  useEffect(() => { const k = `${inv.id}:${inv.outstanding}`; if (autoQr && asked.current !== k) { asked.current = k; void makeQr(); } }, [autoQr, inv.id, inv.outstanding]); // eslint-disable-line react-hooks/exhaustive-deps
  const upload = async (f: File | null) => {
    if (!f) return;
    const amount = pv.locked ? inv.outstanding : Number(form.amount);
    if (!(amount > 0)) return toast('error', tl(lang, 'Enter the amount you transferred'));
    const hold = holdUp(slipLive); if (hold) return toast('error', tr(lang, hold));
    setBusy('slip');
    try {
      // a stalled upload gives up after 60 s so the button comes back instead of waiting for ever (FB-001019)
      const evidenceId = await withTimeout(() => finance.submitEvidence({ invoiceId: inv.id, file: f, claimedAmount: amount, transferAt: form.when ? new Date(form.when).toISOString() : null, bank: bankChoice ? bankChoice.code : choice?.kind === 'qr' ? form.bank || 'PromptPay' : form.bank, ref: form.ref, bankAccountId: bankChoice?.id ?? null }), 60_000);
      void review.analyze({ evidenceId });   // best effort and never awaited: the slip is saved, and the shop checks it by hand whatever happens to the reader (analyze never throws)
      toast('success', tl(lang, 'Slip sent. The shop will verify it shortly.'));
      pick(null); setForm((x) => ({ ...x, ref: '' })); setSent((x) => x + 1); onChanged(); void loadHistory();
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }   // the toast shows a known message in Thai and English (lib/errorText.ts): duplicate slip, wrong date, …
  };
  const rejected = history?.ev.find((e) => e.status === 'rejected' && e.reject_reason);

  return (
    <Card>
      <div className="row between" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div><b>{inv.invoice_no}</b><div className="muted" style={{ fontSize: 12 }}>{dateFmt(inv.issue_date)} · {tl(lang, 'due')} {dateFmt(inv.due_date)}</div></div>
        <Badge tone={st.tone} dot>{lang === 'th' ? st.th : st.en}</Badge>
      </div>
      {!compact && inv.description && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{inv.description}</div>}
      <div className="col gap-4" style={{ marginTop: 8, fontSize: 13.5 }}>
        {!compact && <div className="row between"><span className="muted">{tl(lang, 'Customer')}</span><span>{inv.customer_name}</span></div>}
        {(!compact || inv.paid > 0) && <>
          <div className="row between"><span className="muted">{tl(lang, 'Invoice amount')}</span><span>{money(inv.amount)}</span></div>
          <div className="row between"><span className="muted">{tl(lang, 'Paid so far')}</span><span>{money(inv.paid)}</span></div>
        </>}
        <div className="row between"><b>{tl(lang, 'Remaining')}</b><b style={{ fontSize: 18 }}>{money(inv.outstanding)}</b></div>
      </div>
      <div style={{ marginTop: 8 }}><Banner tone={msg.tone}>{lang === 'th' ? msg.th : msg.en}</Banner></div>
      {/* while a slip waits: what the check found that the customer can fix, or that a person is checking it */}
      {inv.status_code === 3 && <SlipCheck invoiceId={inv.id} lang={lang} refresh={`${inv.status_code}:${inv.pending_evidence}:${sent}`} onResend={() => { setOpen(true); setTimeout(() => upBtn.current?.scrollIntoView({ block: 'center' }), 50); }} />}
      {/* the shop asked for more evidence: its own words, as plain text (React escapes them), above the upload below */}
      {inv.status_code === 10 && inv.more_evidence_message && <div style={{ marginTop: 6 }}><Banner tone="warn"><span data-testid="more-evidence-message" style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{inv.more_evidence_message}</span></Banner></div>}
      {(notes.remaining || notes.confirmed) && <div className="col gap-4" style={{ marginTop: 6, fontSize: 12.5 }}>{notes.remaining && <span data-testid="pay-remaining">{notes.remaining}</span>}{notes.confirmed && <span data-testid="pay-confirmed" className="muted">{notes.confirmed}</span>}</div>}
      {(inv.refunded ?? 0) > 0 && <div style={{ marginTop: 6 }}><Badge tone="info" dot>{lang === 'th' ? `คืนเงินแล้ว ${money(inv.refunded ?? 0)} เข้ากระเป๋าเงิน` : `Refunded ${money(inv.refunded ?? 0)} to your wallet`}</Badge></div>}
      {rejected && inv.status_code === 7 && <div className="bad" style={{ fontSize: 12.5, marginTop: 6 }}>{tl(lang, 'Reason')}: {rejected.reject_reason}</div>}

      {pv.locked && payable && !pv.waiting && <div style={{ marginTop: 6 }}><Banner tone="info"><span data-testid="policy-full">{tr(lang, 'pol.full', { amount: money(inv.outstanding) })}</span></Banner></div>}
      {pv.waiting && payable && <div style={{ marginTop: 6 }}><Banner tone="warn"><span data-testid="policy-waiting">{tr(lang, 'pol.waiting')}</span></Banner></div>}
      {payable && !open && !pv.waiting && <Button variant="primary" className="block mt8" onClick={() => setOpen(true)}>{tl(lang, 'Pay this invoice')}</Button>}
      {open && payable && !pv.waiting && (
        <div className="col gap-8" style={{ marginTop: 10 }}>
          {loadingMethods && <div className="muted" aria-busy="true" style={{ fontSize: 12.5 }}>{tr(lang, 'pm.loading')}</div>}
          {hasMethods && <PayMethodPicker id={`pay-${inv.id}`} title={tr(lang, 'pm.title')} methods={methods!} value={choice} onChange={(c) => { setChoice(c); setQrError(null); }} open={picking} setOpen={setPicking} />}
          {choice?.kind === 'wallet' && methods && <WalletPayPanel inv={inv} balance={methods.wallet.balance} full={pv.locked} onPaid={() => { reloadMethods(); onChanged(); void loadHistory(); }} />}
          {bankChoice && <><PayToBank bank={bankChoice} /><TransferAmount amount={inv.outstanding} reference={inv.invoice_no} /></>}
          {showQr && (live
            ? <>
              <QrPanel payload={live.qr_payload} amount={Number(live.amount)} merchant={live.merchant_name} account={live.account_label || null} orderNo={inv.source_ref ?? inv.invoice_no} reference={live.ref} expires={dateTimeFmt(live.expires_at)} expiresAt={live.expires_at} fileId={inv.source_ref || inv.invoice_no} onRetry={() => void makeQr()} onOther={hasMethods ? () => setPicking(true) : undefined} />
              <Button size="sm" variant="ghost" onClick={makeQr} disabled={!!busy}>{tl(lang, 'Create a new QR')}</Button>
            </>
            : qrError ? <QrProblem message={tr(lang, 'qr.errorHint')} busy={!!busy} onRetry={() => void makeQr()} onOther={hasMethods ? () => setPicking(true) : undefined} />
              : busy === 'qr' ? <QrWaiting />
                : <Button variant="primary" className="block" disabled={!!busy} onClick={makeQr}>{tl(lang, 'Create payment QR')} · {money(inv.outstanding)}</Button>)}

          {!loadingMethods && choice?.kind !== 'wallet' && <>
          <div className="dev-sub" ref={upBtn}><Tx2>{tl(lang, 'After you pay: upload your slip')}</Tx2></div>
          <input ref={file} type="file" hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) pick(f); }} />
          {picked ? (
            <div className="col gap-8" data-testid="slip-preview">
              <SlipLive file={picked.file} total={Number(form.amount) || inv.outstanding} earliest={inv.issue_date} onState={setSlipLive} />
              {picked.url ? <img src={picked.url} alt={tl(lang, 'Slip preview')} style={{ width: '100%', maxHeight: 320, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)' }} />
                : <div className="muted" style={{ padding: 12, border: '1px dashed var(--border)', borderRadius: 8 }}>{picked.file.name}</div>}
              <Field label={tl(lang, 'Amount transferred (฿)')} hint={pv.locked ? tr(lang, 'pol.locked') : undefined}><Input type="number" inputMode="decimal" min={0} step="0.01" readOnly={pv.locked} value={pv.locked ? String(inv.outstanding) : form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="slip-amount" /></Field>
              <Field label={tl(lang, 'Transfer date and time')}><Input type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} /></Field>
              <div className="row gap-6">
                {!bankChoice && choice?.kind !== 'qr' && <Field label={tl(lang, 'Bank / channel')}><Input maxLength={60} value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} /></Field>}
                <Field label={tl(lang, 'Reference on slip')}><Input maxLength={80} value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></Field>
              </div>
              <Button variant="primary" className="block" loading={busy === 'slip'} disabled={!!busy} onClick={() => void upload(picked.file)}><Upload size={15} /> {busy === 'slip' ? tr(lang, 'co.uploading') : tl(lang, 'Submit this slip')}</Button>
              <Button className="block" disabled={!!busy} onClick={() => file.current?.click()}>{tl(lang, 'Choose another picture')}</Button>
            </div>
          ) : <Button variant="primary" className="block" disabled={!!busy} onClick={() => file.current?.click()}><Upload size={15} /> {tl(lang, 'Upload payment slip')}</Button>}
          <div className="muted" style={{ fontSize: 12 }}>{tl(lang, 'JPG, PNG or PDF, up to 5 MB. Uploading a slip is not a confirmation of payment: the shop checks it against its bank record first.')}</div>
          </>}
        </div>
      )}

      {history && (history.rc.length > 0 || history.ev.length > 0) && (
        <div className="col gap-4" style={{ marginTop: 10, fontSize: 12.5 }}>
          <div className="dev-sub">{tl(lang, 'Payment history')}</div>
          {history.rc.map((r) => <div key={r.id} className="row between"><span>{r.receipt_no} <span className="muted">{dateTimeFmt(r.received_at)}</span>{r.status === 'reversed' && <> <Badge tone="bad">{tl(lang, 'reversed')}</Badge></>}</span><b>{money(r.amount)}</b></div>)}
          {history.ev.filter((e) => e.status !== 'verified').map((e) => <div key={e.id} className="row between"><span className="muted">{tl(lang, e.source === 'staff_entry' ? 'Payment recorded by the shop' : 'Slip')} {dateTimeFmt(e.created_at)}</span><span>{tl(lang, e.status === 'rejected' && e.reject_reason === REPLACED ? 'replaced by the slip you sent after' : (EVIDENCE_NOTE[e.status] ?? 'waiting for the shop to check'))} · {money(e.claimed_amount)}</span></div>)}
        </div>
      )}
      {!open && (history == null) && (inv.status_code !== 0) && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{tl(lang, 'Details')}</Button>}
    </Card>
  );
}
const Tx2 = ({ children }: { children: React.ReactNode }) => <>{children}</>;
