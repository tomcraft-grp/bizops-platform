// Configuration for accountants: which ledger account each category posts to (checked against the real chart of accounts),
// VAT / withholding-tax / fixed-asset settings, and who may record, approve or post.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Pencil, Plus } from 'lucide-react';
import { toast, useDB, useLang } from '../domain/store';
import { accountProblem, type Treatment } from '../domain/expenseLedger';
import { Badge, Banner, Button, Card, DataTable, Field, Input, Modal, NumInput, Select } from '../ui/kit';
import { dayKey } from '../lib/util';
import { TAX_META, catName, loadStaff, saveCategory, saveSettings, setRole, useT, type Category, type Settings, type StaffRow } from './api';
import { CatIcon, useExpense } from './parts';
import type { TaxType } from '../domain/expenseLedger';

const ICON_NAMES = ['paperclip', 'zap', 'droplets', 'wifi', 'bus', 'fuel', 'utensils', 'users', 'home', 'wrench', 'megaphone', 'truck', 'landmark', 'package', 'receipt'];

export function SettingsPanel() {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const { categories, settings, can, backoffice, reloadConfig } = useExpense();
  const canConfig = can('config');
  const today = dayKey(new Date());
  const [edit, setEdit] = useState<Category | 'new' | null>(null);
  const acctName = (code: string | null) => { const a = code ? db.accounts.find((x) => x.code === code) : undefined; return a ? (lang === 'th' ? a.nameTh : a.name) : ''; };
  const problem = (c: Category) => (backoffice ? accountProblem(db, c.treatment, c.account_code, today) : null);
  const broken = categories.filter((c) => c.active && (!c.account_code || problem(c)));

  return (
    <div className="col gap-16">
      {broken.length > 0 && (
        <Banner tone="bad"><b><AlertTriangle size={14} />{' '}{T(`${broken.length} active categor${broken.length === 1 ? 'y' : 'ies'} cannot be posted until the account is fixed:`, `มี ${broken.length} หมวดหมู่ที่ยังลงบัญชีไม่ได้จนกว่าจะแก้บัญชี:`)}</b>{' '}{broken.map((c) => catName(lang, c)).join(', ')}</Banner>)}
      <Card flush title={T('Expense categories and the account each one posts to', 'หมวดหมู่รายจ่ายและบัญชีที่แต่ละหมวดลงรายการ')}
        sub={T('Every expense is posted with this mapping. No account codes are built into the screens. Where the chart of accounts has no dedicated account, several categories share “Other operating expenses”.', 'ทุกรายจ่ายลงบัญชีตามการแมปนี้ ไม่มีรหัสบัญชีฝังในหน้าจอ หมวดที่ผังบัญชียังไม่มีบัญชีเฉพาะจะใช้ร่วมกันที่ “ค่าใช้จ่ายในการดำเนินงานอื่น”')}
        actions={canConfig && backoffice && <Button size="sm" variant="primary" onClick={() => setEdit('new')}><Plus size={14} />{' '}{T('Add category', 'เพิ่มหมวดหมู่')}</Button>}>
        <DataTable rows={categories} rowKey={(c) => c.id} pageSize={20}
          cols={[
            { key: 'n', header: T('Category', 'หมวดหมู่'), sort: (c) => c.sort, render: (c) => <span className="row gap-8"><CatIcon name={c.icon} size={18} /><span><b>{catName(lang, c)}</b><div className="sub">{lang === 'th' ? c.name_en : c.name_th}</div></span></span> },
            { key: 't', header: T('Treatment', 'การบันทึกบัญชี'), hideSm: true, render: (c) => c.treatment === 'fixed_asset' ? <Badge tone="info">{T('Fixed asset', 'สินทรัพย์ถาวร')}</Badge> : <Badge>{T('Expense', 'ค่าใช้จ่าย')}</Badge> },
            { key: 'a', header: T('Posts to account', 'ลงบัญชี'), render: (c) => { const p = problem(c); return c.account_code ? <><b>{c.account_code}</b> {acctName(c.account_code)}{p && <div className="exp-err"><AlertTriangle size={12} />{' '}{p.msg}</div>}</> : <Badge tone="bad">{T('Not mapped', 'ยังไม่แมป')}</Badge>; } },
            { key: 'x', header: T('Default tax', 'ภาษีเริ่มต้น'), hideSm: true, render: (c) => (lang === 'th' ? TAX_META[c.default_tax_type].th : TAX_META[c.default_tax_type].en) },
            { key: 'w', header: T('Default WHT', 'หัก ณ ที่จ่ายเริ่มต้น'), num: true, hideSm: true, render: (c) => (c.default_wht_rate != null ? `${c.default_wht_rate}%` : <span className="muted">{T('none', 'ไม่มี')}</span>) },
            { key: 's', header: T('Status', 'สถานะ'), render: (c) => (c.active ? <Badge tone="good" dot>{T('In use', 'ใช้งาน')}</Badge> : <Badge dot>{T('Hidden', 'ซ่อน')}</Badge>) },
            { key: 'e', header: '', render: (c) => canConfig && backoffice && <Button size="sm" variant="ghost" icon aria-label={T('Edit', 'แก้ไข')} onClick={() => setEdit(c)}><Pencil size={14} /></Button> },
          ]} />
        {canConfig && !backoffice && <div className="card-b muted">{T('Open Daily expenses inside the back office to change account mappings (they are checked against the ledger).', 'เปิดรายจ่ายประจำวันในหลังบ้านเพื่อแก้การแมปบัญชี (ระบบตรวจกับสมุดบัญชีให้)')}</div>}
      </Card>
      {canConfig && <TaxSettings settings={settings} onSaved={reloadConfig} />}
      {can('manage_roles') && <Roles />}
      {edit && <CategoryModal c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reloadConfig(); }} />}
    </div>
  );
}

function CategoryModal({ c, onClose, onSaved }: { c: Category | null; onClose: () => void; onSaved: () => void }) {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const today = dayKey(new Date());
  const [f, setF] = useState({ code: c?.code ?? '', name_en: c?.name_en ?? '', name_th: c?.name_th ?? '', icon: c?.icon ?? 'receipt', sort: c?.sort ?? 100, treatment: (c?.treatment ?? 'expense') as Treatment, account_code: c?.account_code ?? '',
    default_tax_type: (c?.default_tax_type ?? 'none') as TaxType, wht: c?.default_wht_rate != null ? String(c.default_wht_rate) : '', hint_en: c?.hint_en ?? '', hint_th: c?.hint_th ?? '', active: c?.active ?? true });
  const [busy, setBusy] = useState(false);
  const accts = db.accounts.filter((a) => !accountProblem(db, f.treatment, a.code, today));
  const prob = f.account_code ? accountProblem(db, f.treatment, f.account_code, today) : null;
  const save = async () => {
    if (!f.name_en.trim() || !f.name_th.trim()) { toast('error', T('Enter the name in English and Thai', 'ใส่ชื่อทั้งภาษาอังกฤษและภาษาไทย')); return; }
    if (!c && !/^[a-z][a-z0-9_]{1,40}$/.test(f.code)) { toast('error', T('The code needs lowercase letters, digits or _ (for example “petty_cash”)', 'รหัสใช้ตัวพิมพ์เล็ก ตัวเลข หรือ _ (เช่น petty_cash)')); return; }
    if (prob) { toast('error', prob.msg); return; }
    setBusy(true);
    try {
      await saveCategory({ id: c?.id, code: f.code, name_en: f.name_en, name_th: f.name_th, icon: f.icon, sort: f.sort, treatment: f.treatment, account_code: f.account_code || null, default_tax_type: f.default_tax_type,
        default_wht_rate: f.wht === '' ? null : Number(f.wht), hint_en: f.hint_en, hint_th: f.hint_th, active: f.active });
      toast('success', T('Category saved', 'บันทึกหมวดหมู่แล้ว')); onSaved();
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={c ? T('Edit category', 'แก้ไขหมวดหมู่') : T('New category', 'เพิ่มหมวดหมู่')} size="lg" onClose={onClose} footer={<><Button onClick={onClose}>{T('Cancel', 'ยกเลิก')}</Button><Button variant="primary" onClick={save}>{busy ? T('Saving…', 'กำลังบันทึก…') : T('Save', 'บันทึก')}</Button></>}>
      <div className="form-grid">
        {!c && <Field label={T('Code (cannot be changed later)', 'รหัส (แก้ภายหลังไม่ได้)')}><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase() })} /></Field>}
        <Field label={T('Name (English)', 'ชื่อ (อังกฤษ)')}><Input value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
        <Field label={T('Name (Thai)', 'ชื่อ (ไทย)')}><Input value={f.name_th} onChange={(e) => setF({ ...f, name_th: e.target.value })} /></Field>
        <Field label={T('Icon', 'ไอคอน')}><Select value={f.icon} onChange={(e) => setF({ ...f, icon: e.target.value })}>{ICON_NAMES.map((i) => <option key={i} value={i}>{i}</option>)}</Select></Field>
        <Field label={T('Accounting treatment', 'การบันทึกบัญชี')}><Select value={f.treatment} onChange={(e) => setF({ ...f, treatment: e.target.value as Treatment, account_code: '' })}><option value="expense">{T('Expense (profit & loss)', 'ค่าใช้จ่าย (งบกำไรขาดทุน)')}</option><option value="fixed_asset">{T('Fixed asset (balance sheet)', 'สินทรัพย์ถาวร (งบแสดงฐานะการเงิน)')}</option></Select></Field>
        <Field label={T('Posts to account', 'ลงบัญชี')} hint={prob ? undefined : T('Only active accounts of the right type are listed.', 'แสดงเฉพาะบัญชีที่ใช้งานอยู่และประเภทถูกต้อง')}>
          <Select value={f.account_code} onChange={(e) => setF({ ...f, account_code: e.target.value })}><option value="">{T('— not mapped (cannot be posted) —', '— ยังไม่แมป (ลงบัญชีไม่ได้) —')}</option>
            {f.account_code && !accts.some((a) => a.code === f.account_code) && <option value={f.account_code}>{f.account_code} ⚠</option>}
            {accts.map((a) => <option key={a.code} value={a.code}>{a.code} {lang === 'th' ? a.nameTh : a.name}</option>)}</Select></Field>
        <Field label={T('Default tax type', 'ประเภทภาษีเริ่มต้น')} hint={T('What employees see pre-selected. “No VAT” is the safe default.', 'ค่าที่พนักงานเห็นเลือกไว้ให้ “ไม่มี VAT” ปลอดภัยที่สุด')}><Select value={f.default_tax_type} onChange={(e) => setF({ ...f, default_tax_type: e.target.value as TaxType })}>{(Object.keys(TAX_META) as TaxType[]).map((t) => <option key={t} value={t}>{lang === 'th' ? TAX_META[t].th : TAX_META[t].en}</option>)}</Select></Field>
        <Field label={T('Default withholding tax (%) — blank = none', 'ภาษีหัก ณ ที่จ่ายเริ่มต้น (%) — ว่าง = ไม่มี')} hint={T('Only a suggestion for the accountant. Rates depend on the type of payment and payee: confirm them with your accountant.', 'เป็นเพียงค่าแนะนำให้นักบัญชี อัตราขึ้นกับประเภทเงินได้และผู้รับเงิน โปรดยืนยันกับนักบัญชี')}>
          <NumInput value={f.wht === '' ? '' : Number(f.wht)} onChange={(n) => setF({ ...f, wht: Number.isNaN(n) ? '' : String(n) })} /></Field>
        <Field label={T('Order on screen', 'ลำดับการแสดง')}><NumInput value={f.sort} onChange={(n) => setF({ ...f, sort: n || 0 })} /></Field>
        <Field label={T('Hint for employees (English)', 'คำอธิบายให้พนักงาน (อังกฤษ)')}><Input value={f.hint_en} maxLength={160} onChange={(e) => setF({ ...f, hint_en: e.target.value })} /></Field>
        <Field label={T('Hint for employees (Thai)', 'คำอธิบายให้พนักงาน (ไทย)')}><Input value={f.hint_th} maxLength={160} onChange={(e) => setF({ ...f, hint_th: e.target.value })} /></Field>
        <Field label={T('Status', 'สถานะ')}><Select value={f.active ? '1' : '0'} onChange={(e) => setF({ ...f, active: e.target.value === '1' })}><option value="1">{T('In use', 'ใช้งาน')}</option><option value="0">{T('Hidden from the form', 'ซ่อนจากฟอร์ม')}</option></Select></Field>
      </div>
      {prob && <Banner tone="bad">{prob.msg}</Banner>}
    </Modal>
  );
}

function TaxSettings({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const { backoffice } = useExpense();
  const [s, setS] = useState({ ...settings });
  const [busy, setBusy] = useState(false);
  const today = dayKey(new Date());
  const whtAccts = db.accounts.filter((a) => a.posting && a.active && a.type === 'liability' && a.fsLine === 'tax_payable');
  const faAccts = db.accounts.filter((a) => !accountProblem(db, 'fixed_asset', a.code, today));
  const wProb = backoffice && !whtAccts.some((a) => a.code === s.wht_account_code);
  const fProb = backoffice && !faAccts.some((a) => a.code === s.fixed_asset_account_code);
  const save = async () => {
    if (wProb || fProb) { toast('error', T('Choose valid accounts from the list', 'เลือกบัญชีที่ถูกต้องจากรายการ')); return; }
    setBusy(true);
    try { await saveSettings({ ...s, vat_rate: Number(s.vat_rate), fixed_asset_warn_amount: Number(s.fixed_asset_warn_amount) || 0 }); toast('success', T('Settings saved', 'บันทึกการตั้งค่าแล้ว')); onSaved(); }
    catch (e) { toast('error', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card title={T('Tax and asset settings', 'ตั้งค่าภาษีและสินทรัพย์')} sub={T('Thai tax rules change: these are settings, not built-in assumptions. Confirm them with your accountant.', 'กฎภาษีไทยเปลี่ยนแปลงได้ สิ่งเหล่านี้เป็นค่าตั้งค่า ไม่ใช่สมมติฐานที่ฝังไว้ โปรดยืนยันกับนักบัญชี')}>
      <div className="form-grid">
        <Field label={T('The business is VAT-registered', 'กิจการจดทะเบียนภาษีมูลค่าเพิ่ม')} hint={T('If off, employees cannot choose VAT types.', 'ถ้าปิด พนักงานจะเลือกประเภท VAT ไม่ได้')}>
          <Select value={s.vat_registered ? '1' : '0'} onChange={(e) => setS({ ...s, vat_registered: e.target.value === '1' })}><option value="1">{T('Yes', 'ใช่')}</option><option value="0">{T('No', 'ไม่ใช่')}</option></Select></Field>
        <Field label={T('VAT rate', 'อัตรา VAT')} hint={T('A fraction, e.g. 0.07 for 7%', 'เป็นเศษส่วน เช่น 0.07 = 7%')}><NumInput value={Number(s.vat_rate)} step={0.01} onChange={(n) => setS({ ...s, vat_rate: n || 0 })} /></Field>
        <Field label={T('Withholding tax payable account', 'บัญชีภาษีหัก ณ ที่จ่ายค้างจ่าย')} hint={wProb ? T('This code is not an active tax-payable account in the ledger.', 'รหัสนี้ไม่ใช่บัญชีภาษีค้างจ่ายที่ใช้งานอยู่ในบัญชี') : undefined}>
          {backoffice ? <Select value={s.wht_account_code} onChange={(e) => setS({ ...s, wht_account_code: e.target.value })}>{wProb && <option value={s.wht_account_code}>{s.wht_account_code} ⚠</option>}{whtAccts.map((a) => <option key={a.code} value={a.code}>{a.code} {lang === 'th' ? a.nameTh : a.name}</option>)}</Select> : <Input value={s.wht_account_code} readOnly />}</Field>
        <Field label={T('Fixed-asset account (equipment)', 'บัญชีสินทรัพย์ถาวร (อุปกรณ์)')} hint={fProb ? T('This code is not a valid fixed-asset account in the ledger.', 'รหัสนี้ไม่ใช่บัญชีสินทรัพย์ถาวรที่ถูกต้องในบัญชี') : undefined}>
          {backoffice ? <Select value={s.fixed_asset_account_code} onChange={(e) => setS({ ...s, fixed_asset_account_code: e.target.value })}>{fProb && <option value={s.fixed_asset_account_code}>{s.fixed_asset_account_code} ⚠</option>}{faAccts.map((a) => <option key={a.code} value={a.code}>{a.code} {lang === 'th' ? a.nameTh : a.name}</option>)}</Select> : <Input value={s.fixed_asset_account_code} readOnly />}</Field>
        <Field label={T('Warn the accountant when an expense is at least (฿)', 'เตือนนักบัญชีเมื่อรายจ่ายตั้งแต่ (บาท)')} hint={T('0 = never. A reminder to consider the “Fixed asset” treatment.', '0 = ไม่เตือน เป็นการเตือนให้พิจารณาลงเป็นสินทรัพย์ถาวร')}><NumInput value={Number(s.fixed_asset_warn_amount)} onChange={(n) => setS({ ...s, fixed_asset_warn_amount: n || 0 })} /></Field>
      </div>
      <div className="mt16"><Button variant="primary" onClick={save}>{busy ? T('Saving…', 'กำลังบันทึก…') : <><Check size={14} />{' '}{T('Save settings', 'บันทึกการตั้งค่า')}</>}</Button></div>
    </Card>
  );
}

function Roles() {
  const T = useT();
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => loadStaff().then(setRows).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);
  const roleName = useMemo(() => ({ '': T('No access', 'ไม่มีสิทธิ์'), employee: T('Employee — records expenses', 'พนักงาน — บันทึกรายจ่าย'), manager: T('Manager — approves', 'ผู้จัดการ — อนุมัติ'), accountant: T('Accountant — reviews tax and posts', 'นักบัญชี — ตรวจภาษีและลงบัญชี') }), [T]);
  return (
    <Card flush title={T('Who can do what', 'ใครทำอะไรได้บ้าง')} sub={T('A Super admin always has full access. Nobody can approve their own expense.', 'ผู้ดูแลสูงสุดมีสิทธิ์ทั้งหมด และไม่มีใครอนุมัติรายจ่ายของตัวเองได้')}>
      {err && <div className="card-b exp-err">{err}</div>}
      <DataTable rows={rows ?? []} rowKey={(r) => r.user_id} pageSize={15}
        cols={[
          { key: 'u', header: T('User', 'ผู้ใช้'), render: (r) => <><b>{r.display_name || r.email.split('@')[0]}</b><div className="sub">{r.email}</div></> },
          { key: 'p', header: T('App role', 'บทบาทในแอป'), hideSm: true, render: (r) => <Badge>{r.profile_role}</Badge> },
          { key: 'r', header: T('Expense role', 'สิทธิ์รายจ่าย'), render: (r) => r.profile_role === 'SUPER_ADMIN' ? <Badge tone="good">{T('Full access', 'สิทธิ์เต็ม')}</Badge> : (
            <Select sm value={r.expense_role ?? ''} aria-label={T('Expense role', 'สิทธิ์รายจ่าย')} onChange={async (e) => { try { await setRole(r.user_id, e.target.value || null); toast('success', T('Saved', 'บันทึกแล้ว')); load(); } catch (x) { toast('error', (x as Error).message); } }}>
              {Object.entries(roleName).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>) },
        ]} />
    </Card>
  );
}
