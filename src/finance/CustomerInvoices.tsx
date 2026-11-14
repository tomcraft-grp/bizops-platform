// Customer side of "pay an invoice with a Thai QR": invoice facts, a QR for exactly what is still owed (amount computed by
// the server), Save QR image, slip upload, and a clear message for every outcome. A slip never settles anything by
// itself; only staff verification (or later a verification provider / bank record) does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { useLang, toast } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { Badge, Banner, Button, Card, Field, Input } from '../ui/kit';
import { QR } from '../ui/shared';
import { dateFmt, dateTimeFmt, money } from '../lib/util';
import { Evidence, finance, InvoiceRow, QrRequest, Receipt, STATUS, StatusCode } from './api';
import { downloadBlob, renderQrCard } from './qrImage';

const MSG: Record<StatusCode, { th: string; en: string; tone: 'info' | 'warn' | 'bad' | 'good' }> = {
  0: { th: 'ยังไม่ได้ชำระ กด “สร้าง QR ชำระเงิน” เพื่อเริ่ม', en: 'Not paid yet. Tap “Create payment QR” to start.', tone: 'info' },
  1: { th: 'รอชำระเงิน สแกน QR ด้วยแอปธนาคารใดก็ได้ แล้วอัปโหลดสลิป', en: 'Waiting for payment. Scan the QR with any banking app, then upload your slip.', tone: 'info' },
  3: { th: 'ได้รับสลิปแล้ว กำลังรอทางร้านตรวจสอบ ยอดจะอัปเดตหลังตรวจสอบเสร็จ', en: 'Slip received. The shop is checking it; your balance updates once it is verified.', tone: 'warn' },
  4: { th: 'ชำระบางส่วนแล้ว ยังมียอดค้าง กด “สร้าง QR ชำระเงิน” เพื่อจ่ายส่วนที่เหลือ', en: 'Partly paid. Create a new QR to pay the remaining balance.', tone: 'warn' },
  5: { th: 'ชำระครบแล้ว ขอบคุณค่ะ', en: 'Fully paid. Thank you!', tone: 'good' },
  6: { th: 'ยอดที่ชำระมากกว่ายอดค้าง ทางร้านกำลังตรวจสอบและจะติดต่อกลับ', en: 'You paid more than the balance. The shop is reviewing it and will contact you.', tone: 'warn' },
  7: { th: 'หลักฐานการชำระถูกปฏิเสธ ดูเหตุผลด้านล่าง แล้วสร้าง QR หรือส่งสลิปใหม่', en: 'Your payment evidence was rejected (see the reason below). Create a new QR or send a new slip.', tone: 'bad' },
  8: { th: 'ใบแจ้งหนี้นี้ถูกยกเลิก', en: 'This invoice was cancelled.', tone: 'warn' },
  9: { th: 'QR หมดอายุ กรุณาสร้างใหม่ หากโอนไปแล้วให้อัปโหลดสลิป', en: 'The QR expired. Create a new one. If you already paid, upload your slip.', tone: 'warn' },
};

export function CustomerInvoices() {
  const lang = useLang();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const reload = useCallback(() => finance.myInvoices().then(setRows).catch(() => setRows([])), []);
  useEffect(() => { void reload(); }, [reload]);
  // No finance invoices (or the finance tables are not set up yet): the Pay tab is exactly what it was.
  if (!rows?.length) return null;
  const owing = rows.filter((r) => r.status_code !== 8).reduce((s, r) => s + r.outstanding, 0);
  return (
    <>
      <h2>{tl(lang, 'Invoices')}</h2>
      <div className="card card-b row between"><span className="muted">{tl(lang, 'Total outstanding')}</span><b style={{ fontSize: 22 }} className={owing > 0 ? 'bad' : 'good'}>{money(owing)}</b></div>
      {rows.map((r) => <InvoiceCard key={r.id} inv={r} onChanged={reload} />)}
    </>
  );
}

function InvoiceCard({ inv, onChanged }: { inv: InvoiceRow; onChanged: () => void }) {
  const lang = useLang();
  const [open, setOpen] = useState(inv.status_code === 1 || inv.status_code === 9);
  const [qr, setQr] = useState<QrRequest | null>(null);
  const [busy, setBusy] = useState('');
  const [img, setImg] = useState<string | null>(null);
  const [history, setHistory] = useState<{ ev: Evidence[]; rc: Receipt[] } | null>(null);
  const [form, setForm] = useState({ amount: '', when: '', bank: '', ref: '' });
  const file = useRef<HTMLInputElement>(null);
  const st = STATUS[inv.status_code];
  const msg = MSG[inv.status_code];
  const live = qr ?? (inv.request && !inv.request.expired ? { ...inv.request, account_label: '', merchant_name: null } : null);
  const payable = inv.status_code !== 8 && inv.status_code !== 5 && inv.status_code !== 6 && inv.outstanding > 0;

  const loadHistory = useCallback(async () => {
    try { const [ev, rc] = await Promise.all([finance.myEvidence(inv.id), finance.myReceipts(inv.id)]); setHistory({ ev, rc }); } catch { setHistory({ ev: [], rc: [] }); }
  }, [inv.id]);
  useEffect(() => { if (open) void loadHistory(); }, [open, loadHistory, inv.status_code]);
  useEffect(() => { setForm((f) => ({ ...f, amount: f.amount || String(inv.outstanding) })); }, [inv.outstanding]);

  const makeQr = async () => {
    setBusy('qr');
    try { setQr(await finance.requestPayment(inv.id)); setImg(null); onChanged(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  const card = async () => {
    if (!live) return null;
    return renderQrCard({ payload: live.qr_payload, amount: live.amount, ref: live.ref, merchant: live.merchant_name || qr?.account_label || '', invoiceNo: inv.invoice_no, expiresAt: live.expires_at, lang });
  };
  const save = async () => {
    setBusy('save');
    try {
      const b = await card(); if (!b) return;
      downloadBlob(b, `QR-${inv.invoice_no}-${live!.ref}.png`);
      // LINE's in-app browser may ignore downloads: also show the picture so it can be pressed and held
      setImg(URL.createObjectURL(b));
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  const upload = async (f: File | null) => {
    if (!f) return;
    const amount = Number(form.amount);
    if (!(amount > 0)) return toast('error', tl(lang, 'Enter the amount you transferred'));
    setBusy('slip');
    try {
      await finance.submitEvidence({ invoiceId: inv.id, file: f, claimedAmount: amount, transferAt: form.when ? new Date(form.when).toISOString() : null, bank: form.bank, ref: form.ref });
      toast('success', tl(lang, 'Slip sent. The shop will verify it shortly.'));
      setForm((x) => ({ ...x, ref: '' })); onChanged(); void loadHistory();
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  const rejected = history?.ev.find((e) => e.status === 'rejected' && e.reject_reason);

  return (
    <Card>
      <div className="row between" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div><b>{inv.invoice_no}</b><div className="muted" style={{ fontSize: 12 }}>{dateFmt(inv.issue_date)} · {tl(lang, 'due')} {dateFmt(inv.due_date)}</div></div>
        <Badge tone={st.tone} dot>{lang === 'th' ? st.th : st.en}</Badge>
      </div>
      {inv.description && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{inv.description}</div>}
      <div className="col gap-4" style={{ marginTop: 8, fontSize: 13.5 }}>
        <div className="row between"><span className="muted">{tl(lang, 'Customer')}</span><span>{inv.customer_name}</span></div>
        <div className="row between"><span className="muted">{tl(lang, 'Invoice amount')}</span><span>{money(inv.amount)}</span></div>
        <div className="row between"><span className="muted">{tl(lang, 'Paid so far')}</span><span>{money(inv.paid)}</span></div>
        <div className="row between"><b>{tl(lang, 'Remaining')}</b><b style={{ fontSize: 18 }}>{money(inv.outstanding)}</b></div>
      </div>
      <div style={{ marginTop: 8 }}><Banner tone={msg.tone}>{lang === 'th' ? msg.th : msg.en}</Banner></div>
      {rejected && inv.status_code === 7 && <div className="bad" style={{ fontSize: 12.5, marginTop: 6 }}>{tl(lang, 'Reason')}: {rejected.reject_reason}</div>}

      {payable && !open && <Button variant="primary" className="block mt8" onClick={() => setOpen(true)}>{tl(lang, 'Pay this invoice')}</Button>}
      {open && payable && (
        <div className="col gap-8" style={{ marginTop: 10 }}>
          {!live
            ? <Button variant="primary" className="block" loading={busy === 'qr'} disabled={!!busy} onClick={makeQr}>{tl(lang, 'Create payment QR')} · {money(inv.outstanding)}</Button>
            : <>
              <div className="col gap-4" style={{ alignItems: 'center' }}>
                <QR data={live.qr_payload} size={190} />
                <b style={{ fontSize: 24 }}>{money(live.amount)}</b>
                <span className="muted mono" style={{ fontSize: 12 }}>{tl(lang, 'Ref')} {live.ref}</span>
                <span className="muted" style={{ fontSize: 12 }}>{tl(lang, 'Valid until')} {dateTimeFmt(live.expires_at)}</span>
              </div>
              <Button className="block" loading={busy === 'save'} disabled={!!busy} onClick={save}><Download size={15} /> {tl(lang, 'Save QR image')}</Button>
              {img && <div className="col gap-4" style={{ alignItems: 'center' }}><img src={img} alt={tl(lang, 'Payment QR')} style={{ width: '100%', maxWidth: 300, border: '1px solid var(--border)', borderRadius: 8 }} /><span className="muted" style={{ fontSize: 12, textAlign: 'center' }}>{tl(lang, 'If nothing downloaded, press and hold the picture to save it.')}</span></div>}
              <div className="muted" style={{ fontSize: 12 }}>{tl(lang, 'Open any banking app, choose scan from your photos, pick the saved picture and confirm the amount shown.')}</div>
              <Button size="sm" variant="ghost" onClick={makeQr} disabled={!!busy}>{tl(lang, 'Create a new QR')}</Button>
            </>}

          <div className="dev-sub"><Tx2>{tl(lang, 'After you pay: upload your slip')}</Tx2></div>
          <Field label={tl(lang, 'Amount transferred (฿)')}><Input type="number" inputMode="decimal" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label={tl(lang, 'Transfer date and time')}><Input type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} /></Field>
          <div className="row gap-6">
            <Field label={tl(lang, 'Bank / channel')}><Input maxLength={60} value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} /></Field>
            <Field label={tl(lang, 'Reference on slip')}><Input maxLength={80} value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></Field>
          </div>
          <input ref={file} type="file" hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; void upload(f); }} />
          <Button variant="primary" className="block" loading={busy === 'slip'} disabled={!!busy} onClick={() => file.current?.click()}><Upload size={15} /> {tl(lang, 'Upload payment slip')}</Button>
          <div className="muted" style={{ fontSize: 12 }}>{tl(lang, 'JPG, PNG or PDF, up to 5 MB. Uploading a slip is not a confirmation of payment: the shop checks it against its bank record first.')}</div>
        </div>
      )}

      {history && (history.rc.length > 0 || history.ev.length > 0) && (
        <div className="col gap-4" style={{ marginTop: 10, fontSize: 12.5 }}>
          <div className="dev-sub">{tl(lang, 'Payment history')}</div>
          {history.rc.map((r) => <div key={r.id} className="row between"><span>{r.receipt_no} <span className="muted">{dateTimeFmt(r.received_at)}</span>{r.status === 'reversed' && <> <Badge tone="bad">{tl(lang, 'reversed')}</Badge></>}</span><b>{money(r.amount)}</b></div>)}
          {history.ev.filter((e) => e.status !== 'verified').map((e) => <div key={e.id} className="row between"><span className="muted">{tl(lang, 'Slip')} {dateTimeFmt(e.created_at)}</span><span>{e.status === 'submitted' ? tl(lang, 'waiting for the shop to check') : tl(lang, 'rejected')} · {money(e.claimed_amount)}</span></div>)}
        </div>
      )}
      {!open && (history == null) && (inv.status_code !== 0) && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{tl(lang, 'Details')}</Button>}
    </Card>
  );
}
const Tx2 = ({ children }: { children: React.ReactNode }) => <>{children}</>;
