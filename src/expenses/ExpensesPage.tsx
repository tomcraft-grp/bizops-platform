// Daily Expenses (บันทึกรายจ่ายประจำวัน): one page, tabs depend on the person's expense role.
//   employee   record expenses, see own          manager   + approve / reject      accountant  + review tax, post, reports, settings
// It runs in two places: inside the back office (/expenses, where the ledger lives, so posting and reports work) and as a light
// phone-friendly page (/my-expenses) for people who are not back-office staff.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Languages, LogOut, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { setLang, toast, useDB, useLang } from '../domain/store';
import { claimJournal, planExpensePosting } from '../domain/expenseLedger';
import { Badge, Banner, Button, Card, PageHead, Tabs } from '../ui/kit';
import { dayKey } from '../lib/util';
import { STATUS_META, canDo, dashboard, loadCategories, loadSettings, markPosted, myRole, useT, type Category, type Claim, type ExpenseCap, type ExpenseRole, type Settings, type Status } from './api';
import { ExpenseCtx, claimToPosting, useExpense } from './parts';
import { ExpenseForm } from './ExpenseForm';
import { ClaimList } from './ClaimList';
import { ClaimDrawer } from './ClaimDrawer';
import { Dashboard } from './Dashboard';
import { SettingsPanel } from './SettingsPanel';
import { Reports } from './Reports';

type Tab = 'new' | 'mine' | 'overview' | 'approve' | 'post' | 'reports' | 'settings';

export default function ExpensesPage({ mode }: { mode: 'backoffice' | 'standalone' }) {
  const T = useT();
  const lang = useLang();
  const { session, signOut } = useAuth();
  const backoffice = mode === 'backoffice';
  const [boot, setBoot] = useState<{ role: ExpenseRole | null; categories: Category[]; settings: Settings | null } | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const role = await myRole();
      if (!role) { setBoot({ role: null, categories: [], settings: null }); return; }
      const [categories, settings] = await Promise.all([loadCategories(), loadSettings()]);
      setBoot({ role, categories, settings }); setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const body = (() => {
    if (err) return <Banner tone="bad"><b>{err}</b> <Button size="sm" onClick={load}>{T('Try again', 'ลองอีกครั้ง')}</Button></Banner>;
    if (!boot) return <div className="card-b"><div className="spinner" /></div>;
    if (!boot.role || !boot.settings) return <Banner tone="warn"><b>{T('You do not have access to Daily expenses yet.', 'คุณยังไม่มีสิทธิ์ใช้รายจ่ายประจำวัน')}</b> {T('Ask an administrator to give you a role (employee, manager or accountant).', 'กรุณาขอผู้ดูแลระบบกำหนดสิทธิ์ให้ (พนักงาน ผู้จัดการ หรือนักบัญชี)')}</Banner>;
    const role = boot.role;
    const value = {
      role, userId: session?.user.id ?? '', settings: boot.settings, categories: boot.categories, catById: Object.fromEntries(boot.categories.map((c) => [c.id, c])),
      backoffice, reloadConfig: load, can: (cap: ExpenseCap) => canDo(role, cap),
    };
    return <ExpenseCtx.Provider value={value}><Workspace /></ExpenseCtx.Provider>;
  })();

  if (backoffice) return <><PageHead title="Daily expenses" desc="Record everyday spending in under a minute. A manager approves it, then the accountant checks the tax and posts it to the books." />{body}</>;
  return (
    <div className="exp-standalone">
      <header className="exp-top">
        <b>BizOps · {T('Daily expenses', 'รายจ่ายประจำวัน')}</b>
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
  const db = useDB();
  const { can, backoffice, role, catById, settings } = useExpense();
  const [tab, setTab] = useState<Tab>(can('approve') ? 'approve' : can('post') ? 'overview' : 'new');
  const [openId, setOpenId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [counts, setCounts] = useState({ submitted: 0, approved: 0 });
  const refresh = () => setTick((x) => x + 1);
  useEffect(() => {
    let live = true;
    dashboard({}).then((d) => live && setCounts({ submitted: d.by_status.submitted?.n ?? 0, approved: d.by_status.approved?.n ?? 0 })).catch(() => undefined);
    return () => { live = false; };
  }, [tick]);
  const { userId } = useExpense();
  const showPost = can('post') && backoffice;

  // A claim that was posted to this ledger but whose status could not be updated (connection lost) is finished here automatically.
  const syncPosted = async (rows: Claim[]) => {
    let n = 0;
    for (const c of rows) {
      if (c.status !== 'approved' || !c.reviewed_at) continue;
      const j = claimJournal(db, c.id);
      if (!j) continue;
      try { await markPosted(c.id, j.no, dayKey(j.date)); n++; } catch { /* the accountant will see it again next time */ }
    }
    if (n) { toast('success', T(`${n} expense(s) already in the ledger were marked as posted`, `มี ${n} รายการที่ลงบัญชีไปแล้ว ระบบอัปเดตสถานะให้แล้ว`)); refresh(); }
  };

  const tabs = [
    { v: 'new' as Tab, label: T('New expense', 'บันทึกรายจ่าย') }, { v: 'mine' as Tab, label: T('My expenses', 'รายจ่ายของฉัน') }, { v: 'overview' as Tab, label: T('Overview', 'ภาพรวม') },
    ...(can('approve') ? [{ v: 'approve' as Tab, label: T('Approvals', 'รออนุมัติ'), count: counts.submitted || '' }] : []),
    ...(showPost ? [{ v: 'post' as Tab, label: T('Accounting', 'ลงบัญชี'), count: counts.approved || '' }, { v: 'reports' as Tab, label: T('Reports', 'รายงาน') }] : []),
    ...(can('config') || can('manage_roles') ? [{ v: 'settings' as Tab, label: T('Settings', 'ตั้งค่า') }] : []),
  ];
  const open = (c: Claim) => setOpenId(c.id);

  return (
    <>
      <HowItWorks />
      {role && can('post') && !backoffice && counts.approved > 0 && <div className="mb16"><Banner>{T(`${counts.approved} approved expense(s) are waiting to be posted. Posting is done in the back office (Daily expenses → Accounting).`, `มี ${counts.approved} รายการที่อนุมัติแล้วรอลงบัญชี การลงบัญชีทำในหลังบ้าน (รายจ่ายประจำวัน → ลงบัญชี)`)}</Banner></div>}
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'new' && <Card><ExpenseForm key={tick} onDone={() => { refresh(); setTab('mine'); }} /></Card>}
      {tab === 'mine' && <Card flush title={T('My expenses', 'รายจ่ายของฉัน')}><ClaimList filters={{ employee: userId }} refreshKey={tick} onOpen={open} empty={<div className="card-b muted">{T('You have not recorded any expenses yet. Use “New expense”.', 'คุณยังไม่ได้บันทึกรายจ่าย กดแท็บ “บันทึกรายจ่าย”')}</div>} /></Card>}
      {tab === 'overview' && <Dashboard onOpen={open} refreshKey={tick} />}
      {tab === 'approve' && <Card flush title={T('Waiting for your approval', 'รอการอนุมัติจากคุณ')} sub={T('Open an expense to see the receipt, then approve or reject it. You cannot approve your own.', 'เปิดรายการเพื่อดูใบเสร็จ แล้วอนุมัติหรือไม่อนุมัติ คุณอนุมัติรายการของตัวเองไม่ได้')}><ClaimList filters={{ status: 'submitted' }} refreshKey={tick} onOpen={open} showEmployee empty={<div className="card-b muted">{T('Nothing is waiting for approval.', 'ไม่มีรายการรออนุมัติ')}</div>} /></Card>}
      {tab === 'post' && showPost && (
        <Card flush title={T('Approved: ready for accounting', 'อนุมัติแล้ว: รอลงบัญชี')} sub={T('Check the tax treatment and account, then post. The journal is shown before anything is saved.', 'ตรวจภาษีและบัญชี แล้วลงบัญชี ระบบแสดงรายการบัญชีให้ดูก่อนบันทึก')}>
          <ClaimList filters={{ status: 'approved' }} refreshKey={tick} onOpen={open} showEmployee extraHeader={T('Check', 'ตรวจสอบ')} onLoaded={syncPosted}
            extra={(c) => <Ready claim={c} />} empty={<div className="card-b muted">{T('Nothing is waiting to be posted.', 'ไม่มีรายการรอลงบัญชี')}</div>} />
        </Card>)}
      {tab === 'reports' && showPost && <Reports />}
      {tab === 'settings' && <SettingsPanel />}
      {openId && <ClaimDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
      <span hidden>{Object.keys(catById).length}{settings.vat_rate}</span>
    </>
  );
}

/** Quick traffic light for the accounting queue: would this claim post cleanly right now? */
function Ready({ claim }: { claim: Claim }) {
  const T = useT();
  const db = useDB();
  const { catById, settings } = useExpense();
  const plan = useMemo(() => planExpensePosting(db, claimToPosting(claim, catById[claim.category_id], { reviewed: true }), { whtAccount: settings.wht_account_code, fixedAssetAccount: settings.fixed_asset_account_code, fixedAssetWarnAmount: Number(settings.fixed_asset_warn_amount) }), [db.accounts, db.journals, db.meta.lockedUntil, claim, catById, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  if (plan.errors.length) return <Badge tone="bad" dot>{T(`${plan.errors.length} to fix`, `ต้องแก้ ${plan.errors.length}`)}</Badge>;
  return <Badge tone={claim.reviewed_at ? 'good' : 'warn'} dot>{claim.reviewed_at ? T('Ready to post', 'พร้อมลงบัญชี') : T('Needs tax review', 'รอตรวจภาษี')}</Badge>;
}

/** Plain-language guide for people without accounting knowledge. Shown the first time, then one click away. */
function HowItWorks() {
  const T = useT();
  const lang = useLang();
  const [show, setShow] = useState(() => { try { return !localStorage.getItem('bizops.expenses.guide'); } catch { return true; } });
  const hide = () => { setShow(false); try { localStorage.setItem('bizops.expenses.guide', '1'); } catch { /* ignore */ } };
  if (!show) return <div className="mb16"><Button size="sm" variant="ghost" onClick={() => setShow(true)}>{T('How does this work?', 'ใช้งานอย่างไร?')}</Button></div>;
  const steps: Status[] = ['draft', 'submitted', 'approved', 'posted'];
  return (
    <Card className="mb16" title={T('How daily expenses work', 'รายจ่ายประจำวันทำงานอย่างไร')} actions={<Button size="sm" variant="ghost" icon aria-label={T('Close', 'ปิด')} onClick={hide}><X size={15} /></Button>}>
      <div className="col gap-12">
        <div className="exp-steps">{steps.map((s, i) => <span key={s} className="row gap-6"><Badge tone={STATUS_META[s].tone} dot>{lang === 'th' ? STATUS_META[s].th : STATUS_META[s].en}</Badge>{i < steps.length - 1 && <span className="muted">→</span>}</span>)}</div>
        <ol className="exp-list">
          <li><b>{T('Employee:', 'พนักงาน:')}</b> {T('pick the category, type the amount, take a photo of the receipt, press “Submit for approval”. Not sure about VAT? Leave “No VAT”: the accountant will check.', 'เลือกหมวดหมู่ ใส่จำนวนเงิน ถ่ายรูปใบเสร็จ แล้วกด “ส่งอนุมัติ” ไม่แน่ใจเรื่อง VAT เลือก “ไม่มี VAT” นักบัญชีจะตรวจให้')}</li>
          <li><b>{T('Manager:', 'ผู้จัดการ:')}</b> {T('checks the receipt and approves or rejects (with a reason). Nobody approves their own expense.', 'ตรวจใบเสร็จ แล้วอนุมัติหรือไม่อนุมัติ (ใส่เหตุผล) ไม่มีใครอนุมัติรายจ่ายของตัวเองได้')}</li>
          <li><b>{T('Accountant:', 'นักบัญชี:')}</b> {T('confirms VAT and withholding tax, sees the exact journal, and posts it to the books. Mistakes are fixed by a reversal, never by deleting.', 'ยืนยัน VAT และภาษีหัก ณ ที่จ่าย ดูรายการบัญชีที่จะลง แล้วบันทึกบัญชี แก้ไขข้อผิดพลาดด้วยการกลับรายการ ไม่ลบทิ้ง')}</li>
        </ol>
        <div className="muted">{T('“Rejected” returns to the employee to fix and send again. “Cancelled” expenses are kept for the record.', '“ไม่อนุมัติ” จะกลับไปให้พนักงานแก้ไขแล้วส่งใหม่ “ยกเลิก” จะเก็บไว้เป็นหลักฐาน')}</div>
        <div><Button size="sm" variant="primary" onClick={hide}>{T('Got it', 'เข้าใจแล้ว')}</Button></div>
      </div>
    </Card>
  );
}
