// The employee's expense form: pick a category card, type the amount, add a photo of the receipt, send. Everything else is optional.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronDown, ChevronUp, FileUp, X } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { calcExpenseTax, type TaxType } from '../domain/expenseLedger';
import { Button, Field, Input, Select, Textarea } from '../ui/kit';
import { cx, dayKey, money } from '../lib/util';
import { CLASS_META, METHOD_META, TAX_META, addAttachment, bankLabel, catName, listClaims, needsBank, removeAttachment, saveClaim, useT, type Attachment, type Claim, type PayMethod, type ProductOption } from './api';
import { CatIcon, useExpense } from './parts';

const todayKey = () => dayKey(new Date());

export function ExpenseForm({ claim, existing = [], defaultDate, onDone }: { claim?: Claim; existing?: Attachment[]; /** the day a new expense starts on (the daily sheet's day) */ defaultDate?: string; onDone: (c: Claim, submitted: boolean) => void }) {
  const T = useT();
  const lang = useLang();
  const { categories, catById, settings, products, productBySku, banks, bankById } = useExpense();
  const active = useMemo(() => categories.filter((c) => c.active), [categories]);
  const [catId, setCatId] = useState(claim?.category_id ?? '');
  const [sku, setSku] = useState<string>(claim?.sku_code ?? '');
  const [bankId, setBankId] = useState<string>(claim?.bank_account_id ?? (banks.length === 1 ? banks[0].id : ''));
  const [amount, setAmount] = useState(claim ? String(claim.tax_type === 'vat_excluded' ? Number(claim.amount_paid) - Number(claim.vat_amount) : claim.amount_paid) : '');
  const [date, setDate] = useState(claim?.expense_date ?? defaultDate ?? todayKey());
  const [method, setMethod] = useState<PayMethod>(claim?.payment_method ?? 'cash');
  const [desc, setDesc] = useState(claim?.description ?? '');
  const [vendor, setVendor] = useState(claim?.vendor ?? '');
  const [taxType, setTaxType] = useState<TaxType>(claim?.tax_type ?? 'none');
  const [taxId, setTaxId] = useState(claim?.vendor_tax_id ?? '');
  const [ref, setRef] = useState(claim?.reference_no ?? '');
  const [notes, setNotes] = useState(claim?.notes ?? '');
  const [more, setMore] = useState(!!(claim && (claim.tax_type !== 'none' || claim.vendor_tax_id || claim.reference_no || claim.notes)));
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<Attachment[]>(existing);
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'draft'>('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const cat = catById[catId];

  // the user's own most-used descriptions in this category (one tap instead of typing)
  useEffect(() => {
    if (!catId) { setRecent([]); return; }
    let live = true;
    listClaims({ category: catId }, 0, 30).then(({ rows }) => {
      if (!live) return;
      const n: Record<string, number> = {};
      for (const r of rows) n[r.description] = (n[r.description] ?? 0) + 1;
      setRecent(Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d]) => d));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [catId]);

  const pick = (id: string) => {
    const c = catById[id]; setCatId(id); setErrs((e) => ({ ...e, cat: '' }));
    if (c && !desc.trim()) setDesc(catName(lang, c));
    if (c && !claim) setTaxType(settings.vat_registered ? c.default_tax_type : 'none');
  };
  const productName = (p: ProductOption) => (lang === 'th' ? p.name_th || p.name_en : p.name_en || p.name_th);
  // a product: the category comes from its catalogue class (still changeable below), the description from its name
  const pickProduct = (code: string) => {
    const prev = sku ? productBySku[sku] : undefined;
    setSku(code);
    const p = code ? productBySku[code] : undefined;
    if (!p) return;
    if (p.category_id && catById[p.category_id]) pick(p.category_id);
    if (!desc.trim() || (prev && desc === productName(prev)) || (catById[catId] && desc === catName(lang, catById[catId]))) setDesc(productName(p));
  };
  const num = Number(amount.replace(/,/g, ''));
  const calc = num > 0 ? calcExpenseTax(num, taxType, taxType === 'none' ? 0 : settings.vat_rate) : null;
  const picks = [...recent, ...(cat ? [lang === 'th' ? cat.hint_th : cat.hint_en] : [])].filter((s, i, a): s is string => !!s && a.indexOf(s) === i).filter((s) => s !== desc).slice(0, 5);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!catId) e.cat = T('Choose what the money was spent on', 'เลือกว่าจ่ายเงินเรื่องอะไร');
    if (!(num > 0)) e.amount = T('Enter the amount you paid', 'ใส่จำนวนเงินที่จ่าย');
    if (!desc.trim()) e.desc = T('Write a short description', 'เขียนรายละเอียดสั้น ๆ');
    if (!date || date > todayKey()) e.date = T('The date cannot be in the future', 'วันที่ต้องไม่เป็นอนาคต');
    if (taxId && !/^\d{13}$/.test(taxId)) e.taxId = T('The tax ID has 13 digits', 'เลขประจำตัวผู้เสียภาษีมี 13 หลัก');
    if (needsBank(method) && !bankId) e.bank = T('Choose the bank account the money was paid from', 'เลือกบัญชีธนาคารที่ใช้จ่ายเงิน');
    setErrs(e);
    return Object.keys(e).length === 0;
  };
  // copy the FileList first: it is live, and the input is reset right after (which empties it before React reads it)
  const addFiles = (list: FileList | null) => { if (!list) return; const picked = Array.from(list); setFiles((f) => [...f, ...picked].slice(0, 5 - saved.length)); };

  const go = async () => {
    if (busy) return;
    if (!validate()) { toast('error', T('Please fix the highlighted fields', 'กรุณาแก้ช่องที่มีเครื่องหมายสีแดง')); return; }
    setBusy('draft');
    try {
      const c = await saveClaim({ id: claim?.id, expenseDate: date, categoryId: catId, description: desc, amount: num, taxType, paymentMethod: method, vendor, vendorTaxId: taxId, referenceNo: ref, notes,
        sku: sku || null, bankAccountId: bankId || null });
      const failed: string[] = [];
      for (const f of files) { try { await addAttachment(c, f); } catch (e) { failed.push(`${f.name}: ${(e as Error).message}`); } }
      if (failed.length) toast('error', failed[0]);
      toast('success', T('Saved. It is a draft until it is approved & posted to accounting.', 'บันทึกแล้ว เป็นแบบร่างจนกว่าจะอนุมัติและลงบัญชี'));
      onDone(c, false);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally { setBusy(''); }
  };
  const E = ({ k }: { k: string }) => (errs[k] ? <div className="exp-err" role="alert">{errs[k]}</div> : null);

  return (
    <div className="exp-form">
      <div className={cx('exp-block', errs.cat && 'bad')}>
        <div className="exp-q">1. {T('What was it for?', 'จ่ายเงินเรื่องอะไร?')}</div>
        {products.length > 0 && (
          <Field label={T('Product from the list (optional) — the category fills itself in', 'สินค้าจากรายการ (ไม่บังคับ) — ระบบเลือกหมวดหมู่ให้อัตโนมัติ')}>
            <Select value={sku} data-testid="exp-product" onChange={(e) => pickProduct(e.target.value)}>
              <option value="">{T('— not a product of the list —', '— ไม่ใช่สินค้าในรายการ —')}</option>
              {(['RM', 'WIP', 'FG'] as const).map((k) => {
                const list = products.filter((p) => p.sku_category === k);
                return list.length ? <optgroup key={k} label={lang === 'th' ? CLASS_META[k].th : CLASS_META[k].en}>{list.map((p) => <option key={p.sku_code} value={p.sku_code}>{productName(p)} · {p.sku_code}</option>)}</optgroup> : null;
              })}
              {sku && !productBySku[sku] && <option value={sku}>{sku}</option>}
            </Select></Field>)}
        <div className="exp-cats" role="radiogroup" aria-label={T('Expense category', 'หมวดหมู่รายจ่าย')}>
          {active.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={c.id === catId} className={cx('exp-cat', c.id === catId && 'on')} onClick={() => pick(c.id)} title={(lang === 'th' ? c.hint_th : c.hint_en) ?? undefined}>
              <CatIcon name={c.icon} /><span>{catName(lang, c)}</span><small>{lang === 'th' ? c.name_en : c.name_th}</small>
            </button>))}
        </div>
        <E k="cat" />
      </div>

      <div className="exp-block">
        <div className="exp-q">2. {T('How much, when, how paid?', 'จ่ายเท่าไร เมื่อไร จ่ายอย่างไร?')}</div>
        <div className="exp-row">
          <div className="exp-amount">
            <label htmlFor="exp-amount">{T('Amount (฿)', 'จำนวนเงิน (บาท)')}</label>
            <input id="exp-amount" className={cx('input exp-big', errs.amount && 'bad')} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount}
              onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.,]/g, '')); setErrs((x) => ({ ...x, amount: '' })); }} />
            <E k="amount" />
          </div>
          <div className="exp-date"><Field label={T('Expense date', 'วันที่จ่ายเงิน')}><Input type="date" value={date} max={todayKey()} onChange={(e) => { setDate(e.target.value); setErrs((x) => ({ ...x, date: '' })); }} /></Field><E k="date" /></div>
        </div>
        <div className="exp-methods" role="radiogroup" aria-label={T('Payment method', 'วิธีชำระเงิน')}>
          {(Object.keys(METHOD_META) as PayMethod[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={m === method} className={cx('exp-method', m === method && 'on')} onClick={() => setMethod(m)}>{lang === 'th' ? METHOD_META[m].th : METHOD_META[m].en}</button>))}
        </div>
        <div className="muted exp-sub">{method === 'cash' ? T('Paid from: cash on hand', 'เงินออกจาก: เงินสดในมือ') : method === 'card' ? T('Paid by card', 'จ่ายด้วยบัตร') : T('Paid from the bank account below', 'เงินออกจากบัญชีธนาคารด้านล่าง')}</div>
        {needsBank(method) && <div className="mt8">
          <Field label={T('Bank account (required)', 'บัญชีธนาคาร (จำเป็น)')}>
            <Select value={bankId} data-testid="exp-bank" onChange={(e) => { setBankId(e.target.value); setErrs((x) => ({ ...x, bank: '' })); }}>
              <option value="">{T('Choose the bank account…', 'เลือกบัญชีธนาคาร…')}</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{bankLabel(lang, b, true)}</option>)}
              {bankId && !bankById[bankId] && <option value={bankId}>{T('(account no longer active)', '(บัญชีปิดใช้แล้ว)')}</option>}
            </Select></Field><E k="bank" /></div>}
      </div>

      <div className="exp-block">
        <div className="exp-q">3. {T('Details', 'รายละเอียด')}</div>
        <Field label={T('Description', 'รายละเอียดค่าใช้จ่าย')}><Input value={desc} maxLength={300} onChange={(e) => { setDesc(e.target.value); setErrs((x) => ({ ...x, desc: '' })); }} /></Field>
        <E k="desc" />
        {picks.length > 0 && <div className="exp-chips" aria-label={T('Frequently used', 'ที่ใช้บ่อย')}>{picks.map((p) => <button key={p} type="button" className="exp-chip" onClick={() => setDesc(p)}>{p}</button>)}</div>}
        <Field label={T('Vendor / payee', 'ผู้รับเงิน / ร้านค้า')}><Input value={vendor} maxLength={200} onChange={(e) => setVendor(e.target.value)} /></Field>
      </div>

      <div className="exp-block">
        <div className="exp-q">4. {T('Receipt', 'ใบเสร็จ / หลักฐานการจ่าย')} <small className="muted">{T('(photo or PDF, up to 5 files)', '(รูปถ่ายหรือ PDF สูงสุด 5 ไฟล์)')}</small></div>
        <div className="row wrap gap-8">
          <Button onClick={() => camera.current?.click()}><Camera size={16} />{' '}{T('Take a photo', 'ถ่ายรูปใบเสร็จ')}</Button>
          <Button onClick={() => picker.current?.click()}><FileUp size={16} />{' '}{T('Choose a file', 'เลือกไฟล์')}</Button>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </div>
        {(files.length > 0 || saved.length > 0) && (
          <div className="exp-files">
            {saved.map((a) => <span key={a.id} className="exp-file">{a.file_name}<button type="button" aria-label={T('Remove', 'ลบ')} onClick={async () => { try { await removeAttachment(a.id); setSaved((s) => s.filter((x) => x.id !== a.id)); } catch (e) { toast('error', (e as Error).message); } }}><X size={13} /></button></span>)}
            {files.map((f, i) => <span key={i} className="exp-file">{f.name}<button type="button" aria-label={T('Remove', 'ลบ')} onClick={() => setFiles(files.filter((_, k) => k !== i))}><X size={13} /></button></span>)}
          </div>)}
      </div>

      <div className="exp-block">
        <button type="button" className="exp-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? <ChevronUp size={16} /> : <ChevronDown size={16} />}{' '}{T('More details (VAT, tax ID, reference, notes)', 'รายละเอียดเพิ่มเติม (VAT เลขผู้เสียภาษี เลขอ้างอิง หมายเหตุ)')}</button>
        {more && (
          <div className="col gap-12 mt8">
            {settings.vat_registered && (
              <div>
                <div className="lbl-s">{T('Tax type', 'ประเภทภาษี')} <span className="muted">— {T('if unsure, leave “No VAT”: the accountant will check it', 'ถ้าไม่แน่ใจเลือก “ไม่มี VAT” นักบัญชีจะตรวจให้')}</span></div>
                <div className="col gap-6 mt8">
                  {(Object.keys(TAX_META) as TaxType[]).map((t) => (
                    <label key={t} className={cx('exp-tax', t === taxType && 'on')}><input type="radio" name="tax" checked={t === taxType} onChange={() => setTaxType(t)} /><span><b>{lang === 'th' ? TAX_META[t].th : TAX_META[t].en}</b><small className="muted">{lang === 'th' ? TAX_META[t].helpTh : TAX_META[t].helpEn}</small></span></label>))}
                </div>
              </div>)}
            <div className="form-grid">
              <div><Field label={T('Vendor tax ID (13 digits)', 'เลขประจำตัวผู้เสียภาษีของร้านค้า (13 หลัก)')}><Input inputMode="numeric" maxLength={13} value={taxId} onChange={(e) => setTaxId(e.target.value.replace(/\D/g, ''))} /></Field><E k="taxId" /></div>
              <Field label={T('Reference number (receipt / invoice no.)', 'เลขที่เอกสารอ้างอิง (เลขที่ใบเสร็จ / ใบกำกับภาษี)')}><Input value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} /></Field>
            </div>
            <Field label={T('Notes', 'หมายเหตุ')}><Textarea value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>)}
      </div>

      <div className="exp-summary" aria-live="polite">
        <div className="exp-summary-h">{T('Summary', 'สรุปรายการ')}</div>
        <div className="row between"><span className="muted">{T('Category', 'หมวดหมู่')}</span><b>{cat ? catName(lang, cat) : '—'}</b></div>
        <div className="row between"><span className="muted">{T('Date', 'วันที่')}</span><b>{date}</b></div>
        <div className="row between"><span className="muted">{T('Paid by', 'วิธีจ่าย')}</span><b>{lang === 'th' ? METHOD_META[method].th : METHOD_META[method].en}{needsBank(method) && bankById[bankId] ? ` · ${bankLabel(lang, bankById[bankId])}` : ''}</b></div>
        {sku && <div className="row between"><span className="muted">{T('Product', 'สินค้า')}</span><span>{productBySku[sku] ? productName(productBySku[sku]) : sku}</span></div>}
        {calc && calc.vat > 0 && <div className="row between"><span className="muted">{T('of which VAT', 'ซึ่งเป็น VAT')}</span><span>{money(calc.vat)}</span></div>}
        <div className="row between exp-total"><span>{T('Total paid', 'รวมจ่ายจริง')}</span><b>{calc ? money(calc.paid) : '—'}</b></div>
        <div className="row between"><span className="muted">{T('Receipts', 'ใบเสร็จ')}</span><span>{files.length + saved.length}</span></div>
      </div>

      <div className="exp-actions">
        <Button variant="primary" data-testid="exp-save" onClick={() => void go()}>{busy === 'draft' ? T('Saving…', 'กำลังบันทึก…') : T('Save expense', 'บันทึกรายจ่าย')}</Button>
      </div>
    </div>
  );
}
