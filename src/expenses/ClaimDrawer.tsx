// Full details of one expense: amounts, product, bank account, dates, receipts, history, where it went in the books (queued journal,
// bank movement) and, for the right role, the next action (edit, review, approve & post, send back, reverse, cancel).
import { useEffect, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { act, toast, useDB, useLang } from '../domain/store';
import { claimJournal, reverseExpenseClaim } from '../domain/expenseLedger';
import { Badge, Banner, Button, Drawer, KV, Modal, Tabs, useConfirm, useHas } from '../ui/kit';
import { dateFmt, dateTimeFmt, money } from '../lib/util';
import {
  CLASS_META, METHOD_META, OPEN_STATUSES, TAX_META, bankLabel, cancelClaim, catName, claimLinks, getClaim, markReversed, markReviewed, needsBank, postBulk, problemText, rejectClaim,
  reverseClaim, signedUrl, useT, type Attachment, type Claim, type ClaimLinks, type EventRow,
} from './api';
import { CatIcon, Section, StatusBadge, useExpense } from './parts';
import { ExpenseForm } from './ExpenseForm';
import { PostPanel } from './PostPanel';

const EVENT_LABEL: Record<string, [string, string]> = {
  created: ['Created', 'สร้างรายการ'], edited: ['Edited', 'แก้ไขรายการ'], submitted: ['Submitted for approval (old step)', 'ส่งขออนุมัติ (ขั้นตอนเดิม)'], approved: ['Approved (old step)', 'อนุมัติ (ขั้นตอนเดิม)'],
  rejected: ['Sent back', 'ส่งกลับให้แก้ไข'], reviewed: ['Reviewed', 'ตรวจสอบแล้ว'], posted: ['Approved & posted to accounting', 'อนุมัติและลงบัญชี'], reversed: ['Reversed', 'กลับรายการ'], cancelled: ['Cancelled', 'ยกเลิก'],
  'attachment.added': ['Receipt added', 'เพิ่มใบเสร็จ'], 'attachment.removed': ['Receipt removed', 'ลบใบเสร็จ'],
};
const GL_STATUS: Record<string, [string, string, 'good' | 'warn' | '']> = {
  pending: ['waiting for the accounting device', 'รอเครื่องบัญชีบันทึก', 'warn'], posted: ['in the ledger', 'อยู่ในบัญชีแยกประเภทแล้ว', 'good'], void: ['voided (reversed before it reached the ledger)', 'ยกเลิกแล้ว (กลับรายการก่อนเข้าบัญชี)', ''],
};
const newRequestId = () => { try { return crypto.randomUUID(); } catch { return `req-${Date.now()}`; } };

export function ClaimDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const confirm = useConfirm();
  const { catById, can, userId, backoffice, productBySku, bankById } = useExpense();
  const canApproveLedger = useHas('accounting:approve');
  const [data, setData] = useState<{ claim: Claim; attachments: Attachment[]; events: EventRow[] } | null>(null);
  const [links, setLinks] = useState<ClaimLinks | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    getClaim(id).then(setData).catch((e) => setErr((e as Error).message));
    claimLinks(id).then(setLinks).catch(() => setLinks(null));
  };
  useEffect(() => { setData(null); setLinks(null); setErr(''); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (c?: Claim) => { if (c && data) setData({ ...data, claim: { ...data.claim, ...c } }); load(); onChanged(); };

  if (err) return <Drawer title={T('Expense', 'รายการรายจ่าย')} onClose={onClose}><Banner tone="bad">{err}</Banner></Drawer>;
  if (!data) return <Drawer title={T('Expense', 'รายการรายจ่าย')} onClose={onClose}><div className="spinner" /></Drawer>;
  const { claim: c, attachments, events } = data;
  const cat = catById[c.category_id];
  const mine = c.created_by === userId;
  const open = OPEN_STATUSES.includes(c.status);
  const paid = Number(c.amount_paid), vat = Number(c.vat_amount), wht = Number(c.wht_amount);
  const bank = links?.bank_account ?? (c.bank_account_id ? bankById[c.bank_account_id] : undefined);
  const product = c.sku_code ? productBySku[c.sku_code] : undefined;
  const run = async (fn: () => Promise<Claim>, ok: string, close = false) => { setBusy(true); try { const r = await fn(); toast('success', ok); changed(r); if (close) onClose(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); } };
  const ask = async (title: string, label: string, danger = true) => { const x = await confirm({ title, reason: label, danger, confirmLabel: T('Confirm', 'ยืนยัน') }); return x.ok ? x.reason : null; };

  const approvePost = async () => {
    if (needsBank(c.payment_method) && !c.bank_account_id) { toast('error', T('Choose the bank account first (Edit).', 'ต้องเลือกบัญชีธนาคารก่อน (กดแก้ไข)')); return; }
    const x = await confirm({
      title: T('Approve & post to accounting?', 'อนุมัติและลงบัญชี?'),
      body: `${c.description} · ${money(paid)} · ${lang === 'th' ? METHOD_META[c.payment_method].th : METHOD_META[c.payment_method].en}${bank ? ` · ${bankLabel(lang, bank)} (−${money(paid - wht)})` : ''}`,
      confirmLabel: T('Approve & post', 'อนุมัติและลงบัญชี'),
    });
    if (!x.ok) return;
    setBusy(true);
    try {
      const r = await postBulk([c.id], newRequestId());
      if (r.posted.length) toast('success', T(`Posted as ${r.posted[0].expense_no}${r.posted[0].bank_txn_no ? ` · bank ${r.posted[0].bank_txn_no}` : ''}`, `ลงบัญชีแล้ว ${r.posted[0].expense_no}${r.posted[0].bank_txn_no ? ` · ตัดบัญชี ${r.posted[0].bank_txn_no}` : ''}`));
      else if (r.skipped.length) toast('info', T('Already posted before: nothing was done again.', 'ลงบัญชีไว้แล้ว ไม่ได้ทำซ้ำ'));
      else if (r.failed.length) toast('error', problemText(lang, r.failed[0].reason));
      changed();
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };
  const reverse = async () => {
    const r = await ask(T('Reverse this posting?', 'กลับรายการบัญชีนี้?'), T('Reason (recorded in the audit trail)', 'เหตุผล (บันทึกไว้ในประวัติ)'));
    if (!r) return;
    setBusy(true);
    try {
      if (c.gl_queue_id) {
        const x = await reverseClaim(c.id, r);
        toast('success', x.bank_txn_no ? T(`Reversed: ${money(Number(x.bank_back))} back to the bank (${x.bank_txn_no})`, `กลับรายการแล้ว คืนเงินเข้าบัญชี ${money(Number(x.bank_back))} (${x.bank_txn_no})`) : T('Reversed', 'กลับรายการแล้ว'));
        changed();
      } else {
        // posted the old way (journal on this device): reverse it here first, then record it centrally
        const rev = act((d, ctx) => reverseExpenseClaim(d, ctx, c.id, r), { perm: 'accounting:approve' });
        try { const done = await markReversed(c.id, rev.reversalNo, r); toast('success', T(`Reversed as ${rev.reversalNo}`, `กลับรายการเป็น ${rev.reversalNo} แล้ว`)); changed(done); }
        catch (e) { toast('error', T(`Reversed in the ledger as ${rev.reversalNo}, but the status could not be updated: ${(e as Error).message}`, `กลับรายการในบัญชีเป็น ${rev.reversalNo} แล้ว แต่ยังอัปเดตสถานะไม่ได้: ${(e as Error).message}`)); }
      }
    } catch (e) { toast('error', problemText(lang, (e as Error).message)); } finally { setBusy(false); }
  };

  const actions = (
    <div className="exp-actions">
      {mine && (c.status === 'draft' || c.status === 'rejected') && <Button onClick={() => setEditing(true)}>{T('Edit', 'แก้ไข')}</Button>}
      {open && can('approve_post') && <>
        <Button variant="primary" data-testid="cd-post" onClick={() => void approvePost()}>{T('Approve & post', 'อนุมัติและลงบัญชี')}</Button>
        {!c.reviewed_at && <Button onClick={async () => { setBusy(true); try { await markReviewed([c.id]); toast('success', T('Marked as reviewed', 'ทำเครื่องหมายตรวจแล้ว')); changed(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); } }}>{T('Mark reviewed', 'ตรวจแล้ว')}</Button>}
        {!(mine && c.status === 'draft') && <Button onClick={async () => { const r = await ask(T('Send back to the employee?', 'ส่งกลับให้พนักงานแก้ไข?'), T('Reason (the employee will see it)', 'เหตุผล (พนักงานจะเห็น)')); if (r) run(() => rejectClaim(c.id, r), T('Sent back', 'ส่งกลับแล้ว'), true); }}>{T('Send back', 'ส่งกลับ')}</Button>}
      </>}
      {c.status === 'posted' && can('post') && (c.gl_queue_id || (backoffice && canApproveLedger)) && <Button variant="danger" onClick={() => void reverse()}>{T('Reverse posting', 'กลับรายการบัญชี')}</Button>}
      {((mine && ['draft', 'submitted', 'rejected'].includes(c.status)) || (!mine && can('approve_post') && ['draft', 'submitted', 'approved', 'rejected'].includes(c.status))) &&
        <Button variant="ghost" onClick={async () => { const r = mine && c.status === 'draft' ? '' : await ask(T('Cancel this expense?', 'ยกเลิกรายจ่ายนี้?'), T('Reason', 'เหตุผล')); if (r !== null) run(() => cancelClaim(c.id, r), T('Cancelled', 'ยกเลิกแล้ว'), true); }}>{T('Cancel expense', 'ยกเลิกรายการ')}</Button>}
    </div>
  );

  return (
    <Drawer title={<span className="row gap-8"><CatIcon name={cat?.icon} size={20} />{c.description}</span>} sub={<span className="row gap-8">{c.expense_no ?? T('Draft', 'แบบร่าง')} <StatusBadge status={c.status} />{c.reviewed_at && open && <Badge tone="info">{T('reviewed', 'ตรวจแล้ว')}</Badge>}</span>} onClose={onClose} footer={busy ? <div className="spinner" /> : actions}>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'details', label: T('Details', 'รายละเอียด') }, { v: 'history', label: T('History', 'ประวัติ'), count: events.length }]} />
      {tab === 'details' && (
        <div className="col gap-16">
          {c.status === 'rejected' && c.reject_reason && <Banner tone="bad"><b>{T('Sent back', 'ส่งกลับให้แก้ไข')}:</b> {c.reject_reason}</Banner>}
          {c.status === 'cancelled' && <Banner>{T('Cancelled', 'ยกเลิก')}{c.cancel_reason ? `: ${c.cancel_reason}` : ''}{c.reversal_journal_no ? ` · ${T('reversal journal', 'รายการกลับบัญชี')} ${c.reversal_journal_no}` : ''}</Banner>}
          {open && needsBank(c.payment_method) && !c.bank_account_id && <Banner tone="warn">{T('The bank account this was paid from is missing: it cannot be posted until it is chosen (Edit).', 'ยังไม่ได้ระบุบัญชีธนาคารที่ใช้จ่าย จะลงบัญชีไม่ได้จนกว่าจะเลือก (กดแก้ไข)')}</Banner>}
          <Section title={T('Amounts', 'จำนวนเงิน')}>
            <KV items={[
              [T('Total paid', 'รวมจ่ายจริง'), <b key="p">{money(paid)}</b>],
              [T('Tax type', 'ประเภทภาษี'), lang === 'th' ? TAX_META[c.tax_type].th : TAX_META[c.tax_type].en],
              ...(vat > 0 ? [[T('of which VAT', 'ซึ่งเป็น VAT'), money(vat)] as [string, string]] : []),
              ...(wht > 0 ? [[T(`Withholding tax ${c.wht_rate}%`, `ภาษีหัก ณ ที่จ่าย ${c.wht_rate}%`), money(wht)] as [string, string], [T('Cash actually paid out', 'เงินที่จ่ายออกจริง'), money(paid - wht)] as [string, string]] : []),
              [T('Payment method', 'วิธีชำระเงิน'), `${lang === 'th' ? METHOD_META[c.payment_method].th : METHOD_META[c.payment_method].en} (${c.paid_from === 'cash' ? T('cash on hand', 'เงินสดในมือ') : T('bank account', 'บัญชีธนาคาร')})`],
              ...(needsBank(c.payment_method) ? [[T('Bank account', 'บัญชีธนาคาร'), bank ? bankLabel(lang, bank, true) : <span key="nb" className="exp-err">{T('not chosen', 'ยังไม่ได้เลือก')}</span>] as [string, ReactNode]] : []),
              [T('Category', 'หมวดหมู่'), catName(lang, cat ?? c.category)],
              ...(c.sku_code ? [[T('Product', 'สินค้า'), `${product ? (lang === 'th' ? product.name_th : product.name_en) : links?.product ? (lang === 'th' ? links.product.name_th : links.product.name_en) ?? '' : ''} · ${c.sku_code}${product ? ` (${lang === 'th' ? CLASS_META[product.sku_category].th : CLASS_META[product.sku_category].en})` : ''}`] as [string, string]] : []),
              ...(c.treatment === 'fixed_asset' ? [[T('Accounting treatment', 'การบันทึกบัญชี'), T('Fixed asset', 'สินทรัพย์ถาวร')] as [string, string]] : []),
              ...(c.treatment === 'inventory' ? [[T('Accounting treatment', 'การบันทึกบัญชี'), T('Stock (inventory)', 'สินค้าคงคลัง')] as [string, string]] : []),
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
              [T('Reviewed', 'วันที่ตรวจสอบ'), c.reviewed_at ? dateTimeFmt(c.reviewed_at) : '—'], [T('Approved & posted', 'วันที่อนุมัติและลงบัญชี'), c.posted_at ? dateTimeFmt(c.posted_at) : c.approved_at ? dateTimeFmt(c.approved_at) : '—'],
              [T('Posting date (ledger)', 'วันที่ลงบัญชี'), c.posting_date ? dateFmt(c.posting_date) : '—'],
            ]} />
          </Section>
          <Section title={T('Receipts', 'ใบเสร็จ / หลักฐาน')}>
            {attachments.length === 0 ? <div className="muted">{T('No receipt attached.', 'ไม่มีไฟล์แนบ')}</div> : <div className="exp-gallery">{attachments.map((a) => <Receipt key={a.id} a={a} />)}</div>}
          </Section>
          {(c.gl_queue_id || links?.gl?.length || links?.bank?.length) ? <Section title={T('In the books', 'การลงบัญชี')} hint={T('Expense → journal → bank movement', 'รายจ่าย → รายการบัญชี → รายการธนาคาร')}><BooksBox links={links} /></Section>
            : c.status === 'posted' && <Section title={T('General ledger', 'บัญชีแยกประเภท')}><LedgerBox claimId={c.id} journalNo={c.journal_no} /></Section>}
          {open && can('post') && <Section title={T('Accountant: tax check (optional)', 'นักบัญชี: ตรวจภาษี (ถ้าต้องการ)')} hint={T('VAT, withholding tax and the account. Saved as part of the review.', 'VAT ภาษีหัก ณ ที่จ่าย และบัญชี บันทึกเป็นส่วนหนึ่งของการตรวจ')}><PostPanel claim={c} onChanged={changed} /></Section>}
          {open && !can('approve_post') && mine && <Banner>{T('Saved as a draft. An authorised person will review it and approve & post it to accounting.', 'บันทึกเป็นแบบร่างแล้ว ผู้มีสิทธิ์จะตรวจและอนุมัติลงบัญชี')}</Banner>}
        </div>)}
      {tab === 'history' && (
        <div className="exp-timeline">
          {events.map((e) => { const l = EVENT_LABEL[e.action]; return (
            <div key={e.id} className="exp-ev"><i /><div><b>{l ? (lang === 'th' ? l[1] : l[0]) : e.action}</b><div className="muted">{e.actor_name ?? '—'} · {dateTimeFmt(e.at)}</div>{e.note && <div>{e.note}</div>}
              {typeof e.detail?.bank_txn_no === 'string' && <div className="muted">{T('Bank movement', 'รายการธนาคาร')} {e.detail.bank_txn_no}{e.detail.bank_out != null ? ` · −${money(Number(e.detail.bank_out))}` : ''}{e.detail.bank_back != null ? ` · +${money(Number(e.detail.bank_back))}` : ''}</div>}</div></div>); })}
        </div>)}
      {editing && <Modal title={T('Edit expense', 'แก้ไขรายจ่าย')} size="lg" onClose={() => setEditing(false)}><ExpenseForm claim={c} existing={attachments} onDone={(r) => { setEditing(false); changed(r); }} /></Modal>}
      {/* referenced so the journal lookup re-renders when the ledger changes */}
      <span hidden>{db.journals.length}</span>
    </Drawer>
  );
}

/** Where a posted expense went: its journal in the accounting queue (and whether the device has posted it) and its bank movements. */
function BooksBox({ links }: { links: ClaimLinks | null }) {
  const T = useT();
  const lang = useLang();
  if (!links) return <div className="spinner" />;
  return (
    <div className="col gap-8">
      {(links.gl ?? []).map((g, i) => { const s = GL_STATUS[g.status]; return (
        <div key={i} className="row between wrap gap-8"><span><b>{g.event_type === 'EXPENSE_REVERSAL' ? T('Reversal journal', 'รายการบัญชีกลับรายการ') : T('Journal', 'รายการบัญชี')}</b> {g.journal_no && <span className="mono">{g.journal_no}</span>}</span>
          <Badge tone={s?.[2] ?? ''} dot>{s ? (lang === 'th' ? s[1] : s[0]) : g.status}</Badge></div>); })}
      {(links.bank ?? []).map((b) => (
        <div key={b.txn_no} className="row between wrap gap-8" data-testid="cd-bank-move"><span><b>{b.txn_no}</b> · {b.bank_code} · {dateFmt(b.value_date)}</span>
          <span className={b.direction === 'out' ? 'exp-err' : ''}>{b.direction === 'out' ? '−' : '+'}{money(Number(b.amount))}{b.balance_after != null && <span className="muted"> · {T('balance', 'คงเหลือ')} {money(Number(b.balance_after))}</span>}</span></div>))}
      {!(links.bank ?? []).length && <div className="muted">{T('No bank movement (cash, card or no bank account).', 'ไม่มีรายการธนาคาร (เงินสด บัตร หรือไม่ได้ระบุบัญชี)')}</div>}
    </div>
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
