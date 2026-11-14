// Full details of one expense: amounts, the four dates, receipts, history and, for the right role, the next action.
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { act, toast, useDB, useLang } from '../domain/store';
import { claimJournal, reverseExpenseClaim } from '../domain/expenseLedger';
import { Badge, Banner, Button, Drawer, KV, Modal, Tabs, useConfirm, useHas } from '../ui/kit';
import { dateFmt, dateTimeFmt, money } from '../lib/util';
import {
  METHOD_META, TAX_META, approveClaim, cancelClaim, catName, getClaim, markReversed, rejectClaim, signedUrl, submitClaim, useT, type Attachment, type Claim, type EventRow,
} from './api';
import { CatIcon, Section, StatusBadge, useExpense } from './parts';
import { ExpenseForm } from './ExpenseForm';
import { PostPanel } from './PostPanel';

const EVENT_LABEL: Record<string, [string, string]> = {
  created: ['Created', 'สร้างรายการ'], edited: ['Edited', 'แก้ไขรายการ'], submitted: ['Submitted for approval', 'ส่งขออนุมัติ'], approved: ['Approved', 'อนุมัติ'], rejected: ['Rejected', 'ไม่อนุมัติ'],
  reviewed: ['Accountant reviewed tax', 'นักบัญชีตรวจภาษี'], posted: ['Posted to the ledger', 'บันทึกบัญชี'], reversed: ['Reversed in the ledger', 'กลับรายการในบัญชี'], cancelled: ['Cancelled', 'ยกเลิก'],
  'attachment.added': ['Receipt added', 'เพิ่มใบเสร็จ'], 'attachment.removed': ['Receipt removed', 'ลบใบเสร็จ'],
};

export function ClaimDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const confirm = useConfirm();
  const { catById, can, userId, backoffice } = useExpense();
  const canApproveLedger = useHas('accounting:approve');
  const [data, setData] = useState<{ claim: Claim; attachments: Attachment[]; events: EventRow[] } | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => getClaim(id).then(setData).catch((e) => setErr((e as Error).message));
  useEffect(() => { setData(null); setErr(''); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (c?: Claim) => { if (c && data) setData({ ...data, claim: { ...data.claim, ...c } }); load(); onChanged(); };

  if (err) return <Drawer title={T('Expense', 'รายการรายจ่าย')} onClose={onClose}><Banner tone="bad">{err}</Banner></Drawer>;
  if (!data) return <Drawer title={T('Expense', 'รายการรายจ่าย')} onClose={onClose}><div className="spinner" /></Drawer>;
  const { claim: c, attachments, events } = data;
  const cat = catById[c.category_id];
  const mine = c.created_by === userId;
  const paid = Number(c.amount_paid), vat = Number(c.vat_amount), wht = Number(c.wht_amount);
  const run = async (fn: () => Promise<Claim>, ok: string, close = false) => { setBusy(true); try { const r = await fn(); toast('success', ok); changed(r); if (close) onClose(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); } };
  const ask = async (title: string, label: string, danger = true) => { const x = await confirm({ title, reason: label, danger, confirmLabel: T('Confirm', 'ยืนยัน') }); return x.ok ? x.reason : null; };

  const actions = (
    <div className="exp-actions">
      {mine && (c.status === 'draft' || c.status === 'rejected') && <><Button onClick={() => setEditing(true)}>{T('Edit', 'แก้ไข')}</Button><Button variant="primary" onClick={() => run(() => submitClaim(c.id), T('Sent for approval', 'ส่งขออนุมัติแล้ว'))}>{T('Submit for approval', 'ส่งอนุมัติ')}</Button></>}
      {c.status === 'submitted' && can('approve') && !mine && <>
        <Button variant="primary" onClick={async () => { const x = await confirm({ title: T('Approve this expense?', 'อนุมัติรายจ่ายนี้?'), body: `${c.description} · ${money(paid)}`, confirmLabel: T('Approve', 'อนุมัติ') }); if (x.ok) run(() => approveClaim(c.id, ''), T('Approved', 'อนุมัติแล้ว'), true); }}>{T('Approve', 'อนุมัติ')}</Button>
        <Button onClick={async () => { const r = await ask(T('Reject this expense?', 'ไม่อนุมัติรายจ่ายนี้?'), T('Reason (the employee will see it)', 'เหตุผล (พนักงานจะเห็น)')); if (r) run(() => rejectClaim(c.id, r), T('Rejected', 'ไม่อนุมัติแล้ว'), true); }}>{T('Reject', 'ไม่อนุมัติ')}</Button></>}
      {c.status === 'submitted' && can('approve') && mine && <span className="muted">{T('You cannot approve your own expense — another manager must.', 'คุณอนุมัติรายจ่ายของตัวเองไม่ได้ ต้องให้ผู้จัดการคนอื่นอนุมัติ')}</span>}
      {c.status === 'approved' && can('post') && <Button onClick={async () => { const r = await ask(T('Send back to the employee?', 'ส่งกลับให้พนักงาน?'), T('Reason', 'เหตุผล')); if (r) run(() => rejectClaim(c.id, r), T('Sent back', 'ส่งกลับแล้ว'), true); }}>{T('Send back', 'ส่งกลับ')}</Button>}
      {c.status === 'posted' && can('post') && backoffice && canApproveLedger && <Button variant="danger" onClick={async () => {
        const r = await ask(T('Reverse this posting?', 'กลับรายการบัญชีนี้?'), T('Reason (recorded in the audit trail)', 'เหตุผล (บันทึกไว้ในประวัติ)'));
        if (!r) return;
        setBusy(true);
        try {
          const rev = act((d, ctx) => reverseExpenseClaim(d, ctx, c.id, r), { perm: 'accounting:approve' });
          try { const done = await markReversed(c.id, rev.reversalNo, r); toast('success', T(`Reversed as ${rev.reversalNo}`, `กลับรายการเป็น ${rev.reversalNo} แล้ว`)); changed(done); }
          catch (e) { toast('error', T(`Reversed in the ledger as ${rev.reversalNo}, but the status could not be updated: ${(e as Error).message}`, `กลับรายการในบัญชีเป็น ${rev.reversalNo} แล้ว แต่ยังอัปเดตสถานะไม่ได้: ${(e as Error).message}`)); }
        } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
      }}>{T('Reverse posting', 'กลับรายการบัญชี')}</Button>}
      {(((mine && ['draft', 'submitted', 'rejected'].includes(c.status)) || (!mine && (can('approve') || can('post')) && ['draft', 'submitted', 'approved', 'rejected'].includes(c.status)))) &&
        <Button variant="ghost" onClick={async () => { const r = mine && c.status === 'draft' ? '' : await ask(T('Cancel this expense?', 'ยกเลิกรายจ่ายนี้?'), T('Reason', 'เหตุผล')); if (r !== null) run(() => cancelClaim(c.id, r), T('Cancelled', 'ยกเลิกแล้ว'), true); }}>{T('Cancel expense', 'ยกเลิกรายการ')}</Button>}
    </div>
  );

  return (
    <Drawer title={<span className="row gap-8"><CatIcon name={cat?.icon} size={20} />{c.description}</span>} sub={<span className="row gap-8">{c.expense_no ?? T('Draft', 'แบบร่าง')} <StatusBadge status={c.status} /></span>} onClose={onClose} footer={busy ? <div className="spinner" /> : actions}>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'details', label: T('Details', 'รายละเอียด') }, { v: 'history', label: T('History', 'ประวัติ'), count: events.length }]} />
      {tab === 'details' && (
        <div className="col gap-16">
          {c.status === 'rejected' && c.reject_reason && <Banner tone="bad"><b>{T('Not approved', 'ไม่อนุมัติ')}:</b> {c.reject_reason}</Banner>}
          {c.status === 'cancelled' && <Banner>{T('Cancelled', 'ยกเลิก')}{c.cancel_reason ? `: ${c.cancel_reason}` : ''}{c.reversal_journal_no ? ` · ${T('reversal journal', 'รายการกลับบัญชี')} ${c.reversal_journal_no}` : ''}</Banner>}
          <Section title={T('Amounts', 'จำนวนเงิน')}>
            <KV items={[
              [T('Total paid', 'รวมจ่ายจริง'), <b key="p">{money(paid)}</b>],
              [T('Tax type', 'ประเภทภาษี'), lang === 'th' ? TAX_META[c.tax_type].th : TAX_META[c.tax_type].en],
              ...(vat > 0 ? [[T('of which VAT', 'ซึ่งเป็น VAT'), money(vat)] as [string, string]] : []),
              ...(wht > 0 ? [[T(`Withholding tax ${c.wht_rate}%`, `ภาษีหัก ณ ที่จ่าย ${c.wht_rate}%`), money(wht)] as [string, string], [T('Cash actually paid out', 'เงินที่จ่ายออกจริง'), money(paid - wht)] as [string, string]] : []),
              [T('Payment method', 'วิธีชำระเงิน'), `${lang === 'th' ? METHOD_META[c.payment_method].th : METHOD_META[c.payment_method].en} (${c.paid_from === 'cash' ? T('cash on hand', 'เงินสดในมือ') : T('bank account', 'บัญชีธนาคาร')})`],
              [T('Category', 'หมวดหมู่'), catName(lang, cat ?? c.category)],
              ...(c.treatment === 'fixed_asset' ? [[T('Accounting treatment', 'การบันทึกบัญชี'), T('Fixed asset', 'สินทรัพย์ถาวร')] as [string, string]] : []),
              ...(c.vendor ? [[T('Vendor / payee', 'ผู้รับเงิน / ร้านค้า'), c.vendor] as [string, string]] : []),
              ...(c.vendor_tax_id ? [[T('Vendor tax ID', 'เลขประจำตัวผู้เสียภาษี'), c.vendor_tax_id] as [string, string]] : []),
              ...(c.reference_no ? [[T('Reference no.', 'เลขที่อ้างอิง'), c.reference_no] as [string, string]] : []),
              ...(can('view_all') || mine ? [[T('Recorded by', 'ผู้บันทึก'), c.created_by_name ?? '—'] as [string, string]] : []),
            ]} />
            {c.notes && <div className="muted mt8">{c.notes}</div>}
          </Section>
          <Section title={T('Dates', 'วันที่')} hint={T('They can differ: each one means something else in the reports.', 'อาจไม่ตรงกัน แต่ละวันมีความหมายต่างกันในรายงาน')}>
            <KV items={[
              [T('Transaction date', 'วันที่เกิดรายการ'), dateFmt(c.expense_date)], [T('Payment date', 'วันที่จ่ายเงิน'), dateFmt(c.payment_date)],
              [T('Submitted', 'วันที่ส่งอนุมัติ'), c.submitted_at ? dateTimeFmt(c.submitted_at) : '—'], [T('Approval date', 'วันที่อนุมัติ'), c.approved_at ? dateTimeFmt(c.approved_at) : '—'],
              [T('Posting date (ledger)', 'วันที่ลงบัญชี'), c.posting_date ? dateFmt(c.posting_date) : '—'], [T('Posted at', 'เวลาที่บันทึกบัญชี'), c.posted_at ? dateTimeFmt(c.posted_at) : '—'],
            ]} />
          </Section>
          <Section title={T('Receipts', 'ใบเสร็จ / หลักฐาน')}>
            {attachments.length === 0 ? <div className="muted">{T('No receipt attached.', 'ไม่มีไฟล์แนบ')}</div> : <div className="exp-gallery">{attachments.map((a) => <Receipt key={a.id} a={a} />)}</div>}
          </Section>
          {c.status === 'posted' && <Section title={T('General ledger', 'บัญชีแยกประเภท')}><LedgerBox claimId={c.id} journalNo={c.journal_no} /></Section>}
          {c.status === 'approved' && can('post') && <Section title={T('Accounting: tax review & posting', 'งานบัญชี: ตรวจภาษีและลงบัญชี')} hint={T('Approval and posting are separate steps.', 'การอนุมัติและการลงบัญชีเป็นคนละขั้นตอน')}><PostPanel claim={c} attachmentCount={attachments.length} onChanged={changed} /></Section>}
          {c.status === 'approved' && !can('post') && <Banner>{T('Approved. Waiting for the accountant to check the tax and post it.', 'อนุมัติแล้ว รอนักบัญชีตรวจภาษีและลงบัญชี')}</Banner>}
          {c.status === 'submitted' && mine && <Banner>{T('Waiting for a manager to approve.', 'รอผู้จัดการอนุมัติ')}</Banner>}
        </div>)}
      {tab === 'history' && (
        <div className="exp-timeline">
          {events.map((e) => { const l = EVENT_LABEL[e.action]; return (
            <div key={e.id} className="exp-ev"><i /><div><b>{l ? (lang === 'th' ? l[1] : l[0]) : e.action}</b><div className="muted">{e.actor_name ?? '—'} · {dateTimeFmt(e.at)}</div>{e.note && <div>{e.note}</div>}</div></div>); })}
        </div>)}
      {editing && <Modal title={T('Edit expense', 'แก้ไขรายจ่าย')} size="lg" onClose={() => setEditing(false)}><ExpenseForm claim={c} existing={attachments} onDone={(r) => { setEditing(false); changed(r); }} /></Modal>}
      {/* referenced so the journal lookup re-renders when the ledger changes */}
      <span hidden>{db.journals.length}</span>
    </Drawer>
  );
}

function Receipt({ a }: { a: Attachment }) {
  const T = useT();
  const [url, setUrl] = useState<string | null>(null);
  const img = a.mime.startsWith('image/') && !a.mime.includes('hei');
  useEffect(() => { let live = true; signedUrl(a.file_path).then((u) => live && setUrl(u)).catch(() => undefined); return () => { live = false; }; }, [a.file_path]);
  return (
    <a className="exp-receipt" href={url ?? undefined} target="_blank" rel="noreferrer" aria-label={T(`Open ${a.file_name}`, `เปิด ${a.file_name}`)}>
      {img && url ? <img src={url} alt={a.file_name} loading="lazy" /> : <span className="exp-receipt-ph">{a.mime === 'application/pdf' ? 'PDF' : 'IMG'}</span>}
      <small>{a.file_name}</small><ExternalLink size={12} />
    </a>
  );
}

function LedgerBox({ claimId, journalNo }: { claimId: string; journalNo: string | null }) {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const { backoffice } = useExpense();
  const j = claimJournal(db, claimId);
  if (!backoffice) return <div className="muted">{T('Journal', 'เลขที่รายการบัญชี')}: <b>{journalNo}</b></div>;
  if (!j) return <Banner tone="warn">{T(`Journal ${journalNo} is not in this device's ledger. Open the app on the accounting device to see its lines.`, `ไม่พบรายการบัญชี ${journalNo} ในเครื่องนี้ กรุณาเปิดแอปบนเครื่องบัญชีเพื่อดูรายการ`)}</Banner>;
  const nm = (code: string) => { const a = db.accounts.find((x) => x.code === code); return a ? (lang === 'th' ? a.nameTh : a.name) : ''; };
  return (
    <table className="t compact"><thead><tr><th>{j.no}</th><th className="num">{T('Debit', 'เดบิต')}</th><th className="num">{T('Credit', 'เครดิต')}</th></tr></thead>
      <tbody>{j.lines.map((l, i) => <tr key={i}><td><b>{l.account}</b> {nm(l.account)}</td><td className="num">{l.debit ? money(l.debit) : ''}</td><td className="num">{l.credit ? money(l.credit) : ''}</td></tr>)}</tbody>
      <tfoot><tr className="total"><td><Badge tone="good">{T('posted', 'บันทึกแล้ว')}</Badge></td><td className="num">{money(j.lines.reduce((s, l) => s + l.debit, 0))}</td><td className="num">{money(j.lines.reduce((s, l) => s + l.credit, 0))}</td></tr></tfoot></table>
  );
}
