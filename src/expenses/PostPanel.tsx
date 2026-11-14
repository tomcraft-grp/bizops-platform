// Accountant's panel: confirm the tax treatment, see the exact journal that will be posted, then post it to the ledger.
// The ledger is on this device; the central database only records the result (journal number) so nothing can be posted twice.
import { useMemo, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { act, toast, useDB, useLang } from '../domain/store';
import { accountProblem, calcExpenseTax, planExpensePosting, postExpenseClaim, type ExpenseConfig, type TaxType, type Treatment } from '../domain/expenseLedger';
import { Badge, Banner, Button, Field, Input, NumInput, Select, Textarea, useHas } from '../ui/kit';
import { money, r2 } from '../lib/util';
import { TAX_META, markPosted, reviewClaim, useT, type Claim } from './api';
import { claimToPosting, useExpense } from './parts';

export function PostPanel({ claim, attachmentCount, onChanged }: { claim: Claim; attachmentCount: number; onChanged: (c: Claim) => void }) {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const { settings, catById, backoffice } = useExpense();
  const canPost = useHas('accounting:create');
  const cat = catById[claim.category_id];
  const paid = Number(claim.amount_paid);
  const [taxType, setTaxType] = useState<TaxType>(claim.tax_type);
  const [vat, setVat] = useState(String(Number(claim.vat_amount) || 0));
  const [wht, setWht] = useState(String(Number(claim.wht_rate) || cat?.default_wht_rate || 0));
  const [treatment, setTreatment] = useState<Treatment>(claim.treatment);
  const [override, setOverride] = useState(claim.account_override ?? '');
  const [branch, setBranch] = useState(claim.branch_id ?? '');
  const [note, setNote] = useState(claim.review_note ?? '');
  const [date, setDate] = useState(claim.posting_date ?? claim.expense_date);
  const [busy, setBusy] = useState(false);
  const cfg: ExpenseConfig = { whtAccount: settings.wht_account_code, fixedAssetAccount: settings.fixed_asset_account_code, fixedAssetWarnAmount: Number(settings.fixed_asset_warn_amount) };

  const vatN = taxType === 'none' ? 0 : r2(Number(vat) || 0);
  const whtRate = Math.max(0, Number(wht) || 0);
  const whtAmt = r2((paid - vatN) * whtRate / 100);
  const draft: Claim = { ...claim, tax_type: taxType, vat_amount: vatN, wht_rate: whtRate, wht_amount: whtAmt, treatment, account_override: override || null, branch_id: branch || null, posting_date: date };
  const plan = useMemo(() => planExpensePosting(db, claimToPosting(draft, cat, { attachmentCount, reviewed: true }), cfg), [db.accounts, db.journals, db.postingMap, db.meta.lockedUntil, taxType, vat, wht, treatment, override, date, claim.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const accts = db.accounts.filter((a) => !accountProblem(db, treatment, a.code, date));
  const nm = (code: string) => { const a = db.accounts.find((x) => x.code === code); return a ? (lang === 'th' ? a.nameTh : a.name) : code; };

  const changeTax = (t: TaxType) => {
    setTaxType(t);
    if (t === 'none') setVat('0');
    else if (!(Number(vat) > 0)) setVat(String(calcExpenseTax(paid, 'vat_included', settings.vat_rate).vat));
  };
  const saveReview = async () => reviewClaim(claim.id, { taxType, vatAmount: vatN, whtRate, treatment, accountOverride: override, branchId: branch, note });

  const review = async () => {
    setBusy(true);
    try { const c = await saveReview(); toast('success', T('Review saved', 'บันทึกการตรวจแล้ว')); onChanged(c); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };
  const post = async () => {
    setBusy(true);
    try {
      const c = await saveReview();
      const r = act((d, ctx) => postExpenseClaim(d, ctx, claimToPosting(c, cat, { attachmentCount, reviewed: true, postingDate: date }), cfg), { perm: 'accounting:create' });
      try {
        const done = await markPosted(c.id, r.journalNo, r.date);
        toast('success', T(`Posted to the ledger as ${r.journalNo}`, `บันทึกบัญชีแล้ว เลขที่ ${r.journalNo}`));
        onChanged(done);
      } catch (e) {
        toast('error', T(`Posted as ${r.journalNo} in the ledger, but the status could not be updated (${(e as Error).message}). Open this list again to finish.`, `ลงบัญชีเป็น ${r.journalNo} แล้ว แต่ยังอัปเดตสถานะไม่ได้ (${(e as Error).message}) กรุณาเปิดรายการนี้อีกครั้งเพื่อทำให้เสร็จ`));
        onChanged(c);
      }
    } catch (e) {
      toast('error', (e as Error).message);
    } finally { setBusy(false); }
  };

  if (!backoffice) return <Banner tone="warn">{T('Posting to the ledger is done inside the back office (Daily expenses → Accounting).', 'การลงบัญชีทำในหลังบ้าน (รายจ่ายประจำวัน → ลงบัญชี)')}</Banner>;
  const td = r2(plan.lines.reduce((s, l) => s + l.debit, 0)), tc = r2(plan.lines.reduce((s, l) => s + l.credit, 0));
  return (
    <div className="col gap-12">
      {!canPost && <Banner tone="warn">{T('The user signed in on this device cannot post to the ledger (needs the Owner or Accountant role here).', 'ผู้ใช้ที่ล็อกอินในเครื่องนี้ไม่มีสิทธิ์ลงบัญชี (ต้องเป็นเจ้าของหรือนักบัญชีในเครื่องนี้)')}</Banner>}
      <div className="form-grid">
        <Field label={T('Tax type', 'ประเภทภาษี')}><Select value={taxType} onChange={(e) => changeTax(e.target.value as TaxType)}>{(Object.keys(TAX_META) as TaxType[]).map((t) => <option key={t} value={t}>{lang === 'th' ? TAX_META[t].th : TAX_META[t].en}</option>)}</Select></Field>
        <Field label={T('VAT amount (฿) — as on the tax invoice', 'ยอด VAT (บาท) ตามใบกำกับภาษี')} hint={T('Claimable only with a valid full tax invoice; otherwise choose “VAT that cannot be claimed”.', 'ขอคืนได้ต่อเมื่อมีใบกำกับภาษีเต็มรูปที่ใช้ได้ ไม่เช่นนั้นเลือก “VAT ขอคืนไม่ได้”')}>
          <NumInput value={taxType === 'none' ? 0 : Number(vat) || ''} disabled={taxType === 'none'} onChange={(n) => setVat(String(n || 0))} /></Field>
        <Field label={T('Withholding tax rate (%)', 'อัตราภาษีหัก ณ ที่จ่าย (%)')} hint={T('Leave 0 unless tax must be withheld. Calculated on the amount before VAT.', 'ใส่ 0 หากไม่ต้องหักภาษี คำนวณจากยอดก่อน VAT')}>
          <NumInput value={Number(wht) || ''} onChange={(n) => setWht(String(n || 0))} /></Field>
        <Field label={T('Accounting treatment', 'การบันทึกบัญชี')}><Select value={treatment} onChange={(e) => { setTreatment(e.target.value as Treatment); setOverride(''); }}>
          <option value="expense">{T('Expense (profit & loss)', 'ค่าใช้จ่าย (งบกำไรขาดทุน)')}</option><option value="fixed_asset">{T('Fixed asset (balance sheet)', 'สินทรัพย์ถาวร (งบแสดงฐานะการเงิน)')}</option></Select></Field>
        <Field label={T('Account', 'บัญชี')} hint={cat?.account_code && !override ? T(`Category default: ${cat.account_code} ${nm(cat.account_code)}`, `ค่าเริ่มต้นของหมวด: ${cat.account_code} ${nm(cat.account_code)}`) : undefined}>
          <Select value={override} onChange={(e) => setOverride(e.target.value)}><option value="">{T('— use the category account —', '— ใช้บัญชีของหมวดหมู่ —')}</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {lang === 'th' ? a.nameTh : a.name}</option>)}</Select></Field>
        <Field label={T('Branch (analysis)', 'สาขา (สำหรับวิเคราะห์)')}><Select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">{T('Unallocated', 'ไม่ระบุ')}</option>{db.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label={T('Posting date', 'วันที่ลงบัญชี')} hint={T('Normally the expense date. Change it only if that period is closed.', 'ปกติคือวันที่จ่ายเงิน เปลี่ยนเมื่องวดนั้นปิดแล้วเท่านั้น')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label={T('Accountant note', 'หมายเหตุนักบัญชี')}><Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>

      {plan.errors.length > 0 && <Banner tone="bad"><b>{T('Cannot post yet', 'ยังลงบัญชีไม่ได้')}</b><ul className="exp-list">{plan.errors.map((e) => <li key={e.code + e.msg}>{e.msg}</li>)}</ul></Banner>}
      {plan.warnings.length > 0 && <Banner tone="warn"><b><AlertTriangle size={14} />{' '}{T('Please check', 'โปรดตรวจสอบ')}</b><ul className="exp-list">{plan.warnings.map((e) => <li key={e.code}>{e.msg}</li>)}</ul></Banner>}

      <div>
        <div className="lbl-s mb8">{T('Journal that will be posted', 'รายการบัญชีที่จะบันทึก')} · {plan.date}</div>
        <table className="t compact"><thead><tr><th>{T('Account', 'บัญชี')}</th><th className="num">{T('Debit', 'เดบิต')}</th><th className="num">{T('Credit', 'เครดิต')}</th></tr></thead>
          <tbody>{plan.lines.length ? plan.lines.map((l, i) => <tr key={i}><td><b>{l.account}</b> {nm(l.account)}</td><td className="num">{l.debit ? money(l.debit) : ''}</td><td className="num">{l.credit ? money(l.credit) : ''}</td></tr>)
            : <tr><td colSpan={3} className="muted">{T('Fix the problems above to see the journal.', 'แก้ปัญหาด้านบนเพื่อดูรายการบัญชี')}</td></tr>}</tbody>
          {plan.lines.length > 0 && <tfoot><tr className="total"><td>{T('Total', 'รวม')} {Math.abs(td - tc) < 0.005 ? <Badge tone="good"><Check size={11} />{' '}{T('balanced', 'สมดุล')}</Badge> : <Badge tone="bad">{T('not balanced', 'ไม่สมดุล')}</Badge>}</td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td></tr></tfoot>}
        </table>
      </div>
      <div className="exp-actions">
        <Button onClick={review}>{T('Save review only', 'บันทึกการตรวจอย่างเดียว')}</Button>
        <Button variant="primary" onClick={post}>{busy ? T('Working…', 'กำลังดำเนินการ…') : T('Confirm tax & post to ledger', 'ยืนยันภาษีและลงบัญชี')}</Button>
      </div>
    </div>
  );
}
