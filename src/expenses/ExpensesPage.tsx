// Daily Expenses (บันทึกรายจ่ายประจำวัน): one page, tabs depend on the person's expense role.
//   employee   record expenses (drafts), see own
//   manager / accountant / admin   + review and "approve & post to accounting" in bulk (one step, done in the central database), bank balances
//   accountant / admin             + tax review, reversal, reports (device ledger), settings
// It runs in two places: inside the back office (/expenses, where the device ledger lives, so its reports work) and as a light
// phone-friendly page (/my-expenses) for people who are not back-office staff. Approving & posting works in both: it is a database step.
import { useCallback, useEffect, useState } from 'react';
import { Languages, LogOut, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { setLang, useLang } from '../domain/store';
import { Badge, Banner, Button, Card, ErrText, PageHead, Tabs } from '../ui/kit';
import { BrandMark } from '../ui/Brand';
import { BRAND } from '../brand';
import {
  STATUS_META, canDo, dashboard, loadBanks, loadCategories, loadProducts, loadSettings, myRole, useT,
  type BankOption, type Category, type Claim, type ExpenseCap, type ExpenseRole, type ProductOption, type Settings, type Status,
} from './api';
import { ExpenseCtx, useExpense } from './parts';
import { DailySheet } from './DailySheet';
import { ClaimList } from './ClaimList';
import { ClaimDrawer } from './ClaimDrawer';
import { Dashboard } from './Dashboard';
import { SettingsPanel } from './SettingsPanel';
import { Reports } from './Reports';
import { PostQueue } from './PostQueue';
import { BankBooks } from '../finance/BankBooks';

type Tab = 'new' | 'mine' | 'overview' | 'post' | 'banks' | 'reports' | 'settings';
interface Boot { role: ExpenseRole | null; categories: Category[]; settings: Settings | null; products: ProductOption[]; banks: BankOption[] }

export default function ExpensesPage({ mode }: { mode: 'backoffice' | 'standalone' }) {
  const T = useT();
  const lang = useLang();
  const { session, signOut } = useAuth();
  const backoffice = mode === 'backoffice';
  const [boot, setBoot] = useState<Boot | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const role = await myRole();
      if (!role) { setBoot({ role: null, categories: [], settings: null, products: [], banks: [] }); return; }
      const [categories, settings, products, banks] = await Promise.all([loadCategories(), loadSettings(), loadProducts(), loadBanks()]);
      setBoot({ role, categories, settings, products, banks }); setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const body = (() => {
    if (err) return <Banner tone="bad"><ErrText>{err}</ErrText> <Button size="sm" onClick={load}>{T('Try again', 'ลองอีกครั้ง')}</Button></Banner>;
    if (!boot) return <div className="card-b"><div className="spinner" /></div>;
    if (!boot.role || !boot.settings) return <Banner tone="warn"><b>{T('You do not have access to Daily expenses yet.', 'คุณยังไม่มีสิทธิ์ใช้รายจ่ายประจำวัน')}</b> {T('Ask an administrator to give you a role (employee, manager or accountant).', 'กรุณาขอผู้ดูแลระบบกำหนดสิทธิ์ให้ (พนักงาน ผู้จัดการ หรือนักบัญชี)')}</Banner>;
    const role = boot.role;
    const value = {
      role, userId: session?.user.id ?? '', settings: boot.settings, categories: boot.categories, catById: Object.fromEntries(boot.categories.map((c) => [c.id, c])),
      backoffice, reloadConfig: load, can: (cap: ExpenseCap) => canDo(role, cap),
      products: boot.products, productBySku: Object.fromEntries(boot.products.map((p) => [p.sku_code, p])), banks: boot.banks, bankById: Object.fromEntries(boot.banks.map((b) => [b.id, b])),
    };
    return <ExpenseCtx.Provider value={value}><Workspace /></ExpenseCtx.Provider>;
  })();

  if (backoffice) return <><PageHead title="Daily expenses" desc={T('Record daily expenses: pick a day, type one row per expense (or pick a product), save. An authorised person reviews them and approves & posts them to accounting in one step; bank transfers move the bank balance at that moment.', 'บันทึกรายจ่ายประจำวัน: เลือกวัน พิมพ์รายจ่ายทีละแถว (หรือเลือกสินค้า) แล้วกดบันทึก ผู้มีสิทธิ์ตรวจแล้ว “อนุมัติและลงบัญชี” ในขั้นตอนเดียว รายการโอนเงินจะตัดยอดบัญชีธนาคารทันทีที่ลงบัญชี')} />{body}</>;
  return (
    <div className="exp-standalone">
      <header className="exp-top">
        <span className="row gap-8 exp-top-brand"><BrandMark size={30} /><span className="exp-top-title"><b>{BRAND.name}</b><small className="muted">{T('Daily expenses', 'รายจ่ายประจำวัน')}</small></span></span>
        <div className="row gap-8">
          <Button size="sm" onClick={() => setLang(lang === 'th' ? 'en' : 'th')}><Languages size={14} />{' '}{lang === 'th' ? 'English' : 'ไทย'}</Button>
          <Button size="sm" variant="ghost" onClick={() => { void signOut().then(() => { window.location.hash = '#/login'; }); }}><LogOut size={14} />{' '}{T('Sign out', 'ออกจากระบบ')}</Button>
        </div>
      </header>
      <main className="exp-main">{body}</main>
    </div>
  );
}

function Workspace() {
  const T = useT();
  const { can, backoffice, userId, role } = useExpense();
  const canPost = can('approve_post');
  const [tab, setTab] = useState<Tab>(canPost ? 'post' : 'new');
  const [openId, setOpenId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(0);
  const refresh = () => setTick((x) => x + 1);
  useEffect(() => {
    let live = true;
    if (canPost) dashboard({}).then((d) => live && setOpen((d.by_status.draft?.n ?? 0) + (d.by_status.submitted?.n ?? 0) + (d.by_status.approved?.n ?? 0))).catch(() => undefined);
    return () => { live = false; };
  }, [tick, canPost]);

  const tabs = [
    { v: 'new' as Tab, label: T('Record expenses', 'บันทึกรายจ่าย') }, { v: 'mine' as Tab, label: T('My expenses', 'รายจ่ายของฉัน') }, { v: 'overview' as Tab, label: T('Overview', 'ภาพรวม') },
    ...(canPost ? [{ v: 'post' as Tab, label: T('Approve & post', 'อนุมัติและลงบัญชี'), count: open || '' }, { v: 'banks' as Tab, label: T('Bank accounts', 'บัญชีธนาคาร') }] : []),
    ...(can('post') && backoffice ? [{ v: 'reports' as Tab, label: T('Reports', 'รายงาน') }] : []),
    ...(can('config') || can('manage_roles') ? [{ v: 'settings' as Tab, label: T('Settings', 'ตั้งค่า') }] : []),
  ];
  const openClaim = (c: Claim) => setOpenId(c.id);

  return (
    <>
      <HowItWorks />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'new' && <DailySheet refreshKey={tick} onOpen={setOpenId} onChanged={refresh} />}
      {tab === 'mine' && <Card flush title={T('My expenses', 'รายจ่ายของฉัน')}><ClaimList filters={{ employee: userId }} refreshKey={tick} onOpen={openClaim} empty={<div className="card-b muted">{T('You have not recorded any expenses yet. Use “Record expenses”.', 'คุณยังไม่ได้บันทึกรายจ่าย กดแท็บ “บันทึกรายจ่าย”')}</div>} /></Card>}
      {tab === 'overview' && <Dashboard onOpen={openClaim} refreshKey={tick} />}
      {tab === 'post' && canPost && <PostQueue refreshKey={tick} onOpen={setOpenId} onChanged={refresh} />}
      {tab === 'banks' && canPost && <BankBooks refreshKey={tick} canManage={role === 'admin'} onOpenExpense={setOpenId} />}
      {tab === 'reports' && can('post') && backoffice && <Reports />}
      {tab === 'settings' && <SettingsPanel />}
      {openId && <ClaimDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

/** Plain-language guide for people without accounting knowledge. Shown the first time, then one click away. */
function HowItWorks() {
  const T = useT();
  const lang = useLang();
  const [show, setShow] = useState(() => { try { return !localStorage.getItem('bizops.expenses.guide.v2'); } catch { return true; } });
  const hide = () => { setShow(false); try { localStorage.setItem('bizops.expenses.guide.v2', '1'); } catch { /* ignore */ } };
  if (!show) return <div className="mb16"><Button size="sm" variant="ghost" onClick={() => setShow(true)}>{T('How does this work?', 'ใช้งานอย่างไร?')}</Button></div>;
  const steps: Status[] = ['draft', 'posted'];
  return (
    <Card className="mb16" title={T('How daily expenses work', 'รายจ่ายประจำวันทำงานอย่างไร')} actions={<Button size="sm" variant="ghost" icon aria-label={T('Close', 'ปิด')} onClick={hide}><X size={15} /></Button>}>
      <div className="col gap-12">
        <div className="exp-steps">{steps.map((s, i) => <span key={s} className="row gap-6"><Badge tone={STATUS_META[s].tone} dot>{lang === 'th' ? STATUS_META[s].th : STATUS_META[s].en}</Badge>{i < steps.length - 1 && <span className="muted">→ {T('review', 'ตรวจ')} →</span>}</span>)}</div>
        <ol className="exp-list">
          <li><b>{T('Record:', 'บันทึก:')}</b> {T('pick the day, type one row per expense or pick a product from the list (its category fills itself in), choose how it was paid — for a transfer or QR also the bank account — and press “Save”. Saved rows are drafts and stay editable until they are posted.', 'เลือกวัน พิมพ์รายจ่ายทีละแถว หรือเลือกสินค้าจากรายการ (หมวดหมู่จะเติมให้อัตโนมัติ) เลือกวิธีจ่าย ถ้าโอนหรือจ่าย QR ให้เลือกบัญชีธนาคารด้วย แล้วกด “บันทึก” รายการที่บันทึกเป็นแบบร่างและแก้ไขได้จนกว่าจะลงบัญชี')}</li>
          <li><b>{T('Review:', 'ตรวจสอบ:')}</b> {T('an authorised person checks the rows and receipts, marks them reviewed or sends one back with a reason.', 'ผู้มีสิทธิ์ตรวจรายการและใบเสร็จ ทำเครื่องหมายว่าตรวจแล้ว หรือส่งกลับให้แก้พร้อมเหตุผล')}</li>
          <li><b>{T('Approve & post:', 'อนุมัติและลงบัญชี:')}</b> {T('select many rows at once and press “Approve & post to accounting”. A summary shows the count, the total, the payment methods and the bank accounts first. A transfer takes the money off that bank account at this moment, once only. Mistakes are fixed by a reversal, never by deleting.', 'เลือกหลายรายการพร้อมกันแล้วกด “อนุมัติและลงบัญชี” ระบบแสดงสรุปจำนวนรายการ ยอดรวม วิธีจ่าย และบัญชีธนาคารก่อนยืนยัน รายการโอนจะตัดยอดบัญชีธนาคารนั้นทันทีเพียงครั้งเดียว แก้ไขข้อผิดพลาดด้วยการกลับรายการ ไม่ลบทิ้ง')}</li>
        </ol>
        <div className="muted">{T('“Sent back” returns to the employee to fix and save again. “Cancelled” expenses are kept for the record.', '“ส่งกลับ” จะกลับไปให้พนักงานแก้ไขแล้วบันทึกใหม่ “ยกเลิก” จะเก็บไว้เป็นหลักฐาน')}</div>
        <div><Button size="sm" variant="primary" onClick={hide}>{T('Got it', 'เข้าใจแล้ว')}</Button></div>
      </div>
    </Card>
  );
}
