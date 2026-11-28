// Accountant's tax check of one expense (optional, before or instead of a plain review): VAT as on the tax invoice, withholding tax, the
// account, the branch. Saving it marks the expense reviewed. Below it, the exact journal the database will queue when the expense is
// approved & posted (the accounting device posts that journal with the existing engine; the posting role names resolve to accounts there).
import { useState } from 'react';
import { toast, useDB, useLang } from '../domain/store';
import { roleCode } from '../domain/accounting';
import { calcExpenseTax, type TaxType, type Treatment } from '../domain/expenseLedger';
import { Banner, Button, Field, NumInput, Select, Textarea } from '../ui/kit';
import { money, r2 } from '../lib/util';
import { TAX_META, bankLabel, reviewClaim, useT, type Claim } from './api';
import { queuePlan, useExpense } from './parts';

export function PostPanel({ claim, onChanged }: { claim: Claim; onChanged: (c: Claim) => void }) {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const { settings, catById, backoffice, bankById } = useExpense();
  const cat = catById[claim.category_id];
  const stock = claim.treatment === 'inventory' || cat?.treatment === 'inventory';
  const paid = Number(claim.amount_paid);
  const [taxType, setTaxType] = useState<TaxType>(claim.tax_type);
  const [vat, setVat] = useState(String(Number(claim.vat_amount) || 0));
  const [wht, setWht] = useState(String(Number(claim.wht_rate) || cat?.default_wht_rate || 0));
  const [treatment, setTreatment] = useState<Treatment>(stock ? 'inventory' : claim.treatment);
  const [override, setOverride] = useState(claim.account_override ?? '');
  const [branch, setBranch] = useState(claim.branch_id ?? '');
  const [note, setNote] = useState(claim.review_note ?? '');
  const [busy, setBusy] = useState(false);

  const vatN = taxType === 'none' ? 0 : r2(Number(vat) || 0);
  const whtRate = Math.max(0, Number(wht) || 0);
  const whtAmt = r2((paid - vatN) * whtRate / 100);
  const plan = queuePlan({ ...claim, tax_type: taxType, vat_amount: vatN, wht_amount: whtAmt, account_override: stock ? null : override || null }, cat, settings.wht_account_code);
  // on the accounting device, show which account each posting role is today
  const name = (role: string, bankId?: string) => {
    if (bankId && bankById[bankId]) return `${T('bank', 'ธนาคาร')} ${bankLabel(lang, bankById[bankId])}`;
    const code = backoffice ? (/^[0-9]{3,8}$/.test(role) ? role : roleCode(db, role)) : null;
    const a = code ? db.accounts.find((x) => x.code === code) : undefined;
    return a ? `${a.code} ${lang === 'th' ? a.nameTh : a.name}` : role;
  };
  const accts = backoffice ? db.accounts.filter((a) => a.posting && a.active && (treatment === 'fixed_asset' ? a.fsLine === 'fixed_assets' : a.type === 'expense')) : [];

  const changeTax = (t: TaxType) => {
    setTaxType(t);
    if (t === 'none') setVat('0');
    else if (!(Number(vat) > 0)) setVat(String(calcExpenseTax(paid, 'vat_included', settings.vat_rate).vat));
  };
  const save = async () => {
    setBusy(true);
    try {
      const c = await reviewClaim(claim.id, { taxType, vatAmount: vatN, whtRate, treatment, accountOverride: stock ? '' : override, branchId: branch, note });
      toast('success', T('Tax check saved (marked reviewed)', 'บันทึกการตรวจภาษีแล้ว (ตรวจแล้ว)'));
      onChanged(c);
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };

  const td = r2(plan.lines.filter((l) => l.side === 'dr').reduce((s, l) => s + l.amount, 0)), tc = r2(plan.lines.filter((l) => l.side === 'cr').reduce((s, l) => s + l.amount, 0));
  return (
    <div className="col gap-12">
      <div className="form-grid">
        <Field label={T('Tax type', 'ประเภทภาษี')}><Select value={taxType} onChange={(e) => changeTax(e.target.value as TaxType)}>{(Object.keys(TAX_META) as TaxType[]).map((t) => <option key={t} value={t}>{lang === 'th' ? TAX_META[t].th : TAX_META[t].en}</option>)}</Select></Field>
        <Field label={T('VAT amount (฿) — as on the tax invoice', 'ยอด VAT (บาท) ตามใบกำกับภาษี')} hint={T('Claimable only with a valid full tax invoice; otherwise choose “VAT that cannot be claimed”.', 'ขอคืนได้ต่อเมื่อมีใบกำกับภาษีเต็มรูปที่ใช้ได้ ไม่เช่นนั้นเลือก “VAT ขอคืนไม่ได้”')}>
          <NumInput value={taxType === 'none' ? 0 : Number(vat) || ''} disabled={taxType === 'none'} onChange={(n) => setVat(String(n || 0))} /></Field>
        <Field label={T('Withholding tax rate (%)', 'อัตราภาษีหัก ณ ที่จ่าย (%)')} hint={T('Leave 0 unless tax must be withheld. Calculated on the amount before VAT.', 'ใส่ 0 หากไม่ต้องหักภาษี คำนวณจากยอดก่อน VAT')}>
          <NumInput value={Number(wht) || ''} onChange={(n) => setWht(String(n || 0))} /></Field>
        {stock ? <Field label={T('Accounting treatment', 'การบันทึกบัญชี')}><Select value="inventory" disabled><option value="inventory">{T('Stock (inventory) — from the product category', 'สินค้าคงคลัง — ตามหมวดสินค้า')}</option></Select></Field>
          : <Field label={T('Accounting treatment', 'การบันทึกบัญชี')}><Select value={treatment} onChange={(e) => { setTreatment(e.target.value as Treatment); setOverride(''); }}>
            <option value="expense">{T('Expense (profit & loss)', 'ค่าใช้จ่าย (งบกำไรขาดทุน)')}</option><option value="fixed_asset">{T('Fixed asset (balance sheet)', 'สินทรัพย์ถาวร (งบแสดงฐานะการเงิน)')}</option></Select></Field>}
        {!stock && backoffice && <Field label={T('Account', 'บัญชี')} hint={cat?.account_code && !override ? T(`Category default: ${name(cat.account_code)}`, `ค่าเริ่มต้นของหมวด: ${name(cat.account_code)}`) : undefined}>
          <Select value={override} onChange={(e) => setOverride(e.target.value)}><option value="">{T('— use the category account —', '— ใช้บัญชีของหมวดหมู่ —')}</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {lang === 'th' ? a.nameTh : a.name}</option>)}</Select></Field>}
        {backoffice && <Field label={T('Branch (analysis)', 'สาขา (สำหรับวิเคราะห์)')}><Select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">{T('Unallocated', 'ไม่ระบุ')}</option>{db.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>}
      </div>
      <Field label={T('Accountant note', 'หมายเหตุนักบัญชี')}><Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>

      {!plan.debit ? <Banner tone="bad">{T('This category has no account yet (Settings → Categories): it cannot be posted.', 'หมวดหมู่นี้ยังไม่ได้ผูกบัญชี (ตั้งค่า → หมวดหมู่) จึงลงบัญชีไม่ได้')}</Banner> : (
        <div>
          <div className="lbl-s mb8">{T('Journal that will be queued for the accounting device', 'รายการบัญชีที่จะส่งให้เครื่องบัญชีบันทึก')}</div>
          <table className="t compact" data-testid="pp-plan"><thead><tr><th>{T('Account', 'บัญชี')}</th><th className="num">{T('Debit', 'เดบิต')}</th><th className="num">{T('Credit', 'เครดิต')}</th></tr></thead>
            <tbody>{plan.lines.map((l, i) => <tr key={i}><td>{name(l.role, l.bankAccountId)}</td><td className="num">{l.side === 'dr' ? money(l.amount) : ''}</td><td className="num">{l.side === 'cr' ? money(l.amount) : ''}</td></tr>)}</tbody>
            <tfoot><tr className="total"><td>{T('Total', 'รวม')}</td><td className="num">{money(td)}</td><td className="num">{money(tc)}</td></tr></tfoot></table>
        </div>)}
      <div className="exp-actions"><Button disabled={busy} onClick={() => void save()}>{busy ? T('Saving…', 'กำลังบันทึก…') : T('Save tax check', 'บันทึกการตรวจภาษี')}</Button></div>
    </div>
  );
}
