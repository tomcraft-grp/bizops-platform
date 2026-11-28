// Spending at a glance for managers and accountants (employees see their own numbers): today, this month, what is waiting, and why.
import { useEffect, useMemo, useState } from 'react';
import { useLang } from '../domain/store';
import { Card, ErrText, Field, Input, Kpi, Select, SearchBox } from '../ui/kit';
import { HBars } from '../ui/charts';
import { dayKey, money0 } from '../lib/util';
import { METHOD_META, STATUS_META, catName, dashboard, useT, type Claim, type ClaimFilters, type DashboardData, type PayMethod, type Status } from './api';
import { useExpense } from './parts';
import { ClaimList } from './ClaimList';

const monthStart = () => { const d = new Date(); return dayKey(new Date(d.getFullYear(), d.getMonth(), 1)); };

export function Dashboard({ onOpen, refreshKey }: { onOpen: (c: Claim) => void; refreshKey: number }) {
  const T = useT();
  const lang = useLang();
  const { categories, can } = useExpense();
  const all = can('view_all');
  const [f, setF] = useState<ClaimFilters & { account: string }>({ from: monthStart(), to: dayKey(new Date()), status: '', category: '', method: '', employee: '', q: '', account: '' });
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState('');
  const [people, setPeople] = useState<Record<string, string>>({});
  const srv: ClaimFilters = { from: f.from, to: f.to, status: f.status, category: f.category, method: f.method, employee: f.employee, q: f.q };
  const key = JSON.stringify(srv);
  useEffect(() => {
    let live = true; setErr('');
    dashboard(srv).then((d) => live && setData(d)).catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [key, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const accounts = useMemo(() => Array.from(new Set(categories.map((c) => c.account_code).filter((x): x is string => !!x))).sort(), [categories]);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const st = (s: Status) => data?.by_status[s] ?? { n: 0, amount: 0 };
  const label = (s: Status) => (lang === 'th' ? STATUS_META[s].th : STATUS_META[s].en);

  return (
    <div className="col gap-16">
      <div className="grid g4">
        <Kpi label={T('Spent today', 'รายจ่ายวันนี้')} value={money0(data?.today_total ?? 0)} sub={T('recorded and posted', 'บันทึกแล้วและลงบัญชีแล้ว')} />
        <Kpi label={T('Spent this month', 'รายจ่ายเดือนนี้')} value={money0(data?.month_total ?? 0)} sub={T('up to today', 'ถึงวันนี้')} />
        <Kpi label={T('Waiting for approval & posting', 'รออนุมัติและลงบัญชี')} value={st('draft').n + st('submitted').n + st('approved').n} tone={st('draft').n + st('submitted').n + st('approved').n ? 'bad' : undefined}
          sub={money0(st('draft').amount + st('submitted').amount + st('approved').amount)} />
        <Kpi label={T('Posted to the ledger', 'บันทึกบัญชีแล้ว')} value={st('posted').n} tone="good" sub={money0(st('posted').amount)} />
      </div>
      <div className="grid g4">
        <Kpi label={T('Sent back for a fix', 'ส่งกลับให้แก้ไข')} value={st('rejected').n} sub={money0(st('rejected').amount)} />
        <Kpi label={T('Drafts', 'แบบร่าง')} value={st('draft').n} sub={money0(st('draft').amount)} />
        <Kpi label={T('Total in the selected period', 'รวมในช่วงที่เลือก')} value={money0(data?.range_total ?? 0)} sub={T('recorded and posted; not counting sent back or cancelled', 'บันทึกแล้วและลงบัญชีแล้ว ไม่นับที่ส่งกลับหรือยกเลิก')} />
      </div>

      <Card title={T('Filters', 'ตัวกรอง')}>
        <div className="exp-filters">
          <Field label={T('From', 'ตั้งแต่วันที่')}><Input type="date" value={f.from} max={f.to} onChange={(e) => set({ from: e.target.value })} /></Field>
          <Field label={T('To', 'ถึงวันที่')}><Input type="date" value={f.to} min={f.from} onChange={(e) => set({ to: e.target.value })} /></Field>
          <Field label={T('Status', 'สถานะ')}><Select value={f.status} onChange={(e) => set({ status: e.target.value as Status | '' })}><option value="">{T('All', 'ทั้งหมด')}</option>{(Object.keys(STATUS_META) as Status[]).map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>
          <Field label={T('Category', 'หมวดหมู่')}><Select value={f.category} onChange={(e) => set({ category: e.target.value })}><option value="">{T('All', 'ทั้งหมด')}</option>{categories.map((c) => <option key={c.id} value={c.id}>{catName(lang, c)}</option>)}</Select></Field>
          <Field label={T('Payment method', 'วิธีชำระเงิน')}><Select value={f.method} onChange={(e) => set({ method: e.target.value as PayMethod | '' })}><option value="">{T('All', 'ทั้งหมด')}</option>{(Object.keys(METHOD_META) as PayMethod[]).map((m) => <option key={m} value={m}>{lang === 'th' ? METHOD_META[m].th : METHOD_META[m].en}</option>)}</Select></Field>
          {all && <Field label={T('Employee', 'พนักงาน')}><Select value={f.employee} onChange={(e) => set({ employee: e.target.value })}><option value="">{T('Everyone', 'ทุกคน')}</option>{Object.entries(people).sort((a, b) => a[1].localeCompare(b[1])).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select></Field>}
          {all && <Field label={T('Accounting account', 'บัญชี')}><Select value={f.account} onChange={(e) => set({ account: e.target.value })}><option value="">{T('All', 'ทั้งหมด')}</option>{accounts.map((a) => <option key={a} value={a}>{a}</option>)}</Select></Field>}
          <div className="exp-search"><SearchBox value={f.q ?? ''} onChange={(v) => set({ q: v })} placeholder={T('Search description, vendor, number…', 'ค้นหารายละเอียด ร้านค้า เลขที่…')} /></div>
        </div>
      </Card>
      {err && <div className="exp-err" role="alert"><ErrText>{err}</ErrText></div>}

      <div className="grid g2">
        <Card title={T('By category', 'แยกตามหมวดหมู่')}>
          {data?.by_category.length ? <HBars items={data.by_category.map((c) => ({ label: catName(lang, c), value: Number(c.amount), sub: `${c.n}` }))} fmt={money0} /> : <div className="muted">{T('Nothing in this period.', 'ไม่มีรายการในช่วงนี้')}</div>}
        </Card>
        <Card title={T('By payment method', 'แยกตามวิธีชำระเงิน')}>
          {data?.by_method.length ? <HBars items={data.by_method.map((m) => ({ label: lang === 'th' ? METHOD_META[m.method].th : METHOD_META[m.method].en, value: Number(m.amount), sub: `${m.n}` }))} fmt={money0} /> : <div className="muted">{T('Nothing in this period.', 'ไม่มีรายการในช่วงนี้')}</div>}
        </Card>
      </div>

      <Card flush title={T('Transactions', 'รายการ')} sub={T('Click a row for details, receipts, history and the ledger entry.', 'คลิกแถวเพื่อดูรายละเอียด ใบเสร็จ ประวัติ และรายการบัญชี')}>
        <ClaimList filters={srv} refreshKey={refreshKey} onOpen={onOpen} showEmployee={all} accountFilter={f.account || undefined}
          onLoaded={(rows) => setPeople((p) => ({ ...p, ...Object.fromEntries(rows.map((r) => [r.created_by, r.created_by_name ?? '—'])) }))} />
      </Card>
    </div>
  );
}
