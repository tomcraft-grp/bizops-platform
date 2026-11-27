// Back office → Preorders: the manager's view of every scheduled pickup. Overview (today's numbers and what needs attention), Schedule (a day as a timeline), All preorders
// (search, filters, sorting, paging), Alerts (what the system said and whether LINE delivered it) and Settings (opening hours, capacity, rules, closures).
// All numbers come from the database; nothing here is computed from sample data. The employee's mobile board is a separate page (Pickup prep).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, ChevronLeft, ChevronRight, ClipboardList, RefreshCw } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { cx, money } from '../lib/util';
import { Badge, Banner, Button, Empty, Field, Input, Kpi, PageHead, SearchBox, Select, Skeleton, Switch, Tabs } from '../ui/kit';
import { isPreorderMissing, pre, type Dashboard, type DayHours, type ListPage, type PreSettings, type Schedule, type SettingsPatch, type StaffNotice, type Staffer } from './api';
import { FlagPills, OrderCard, PayPill, PreorderDrawer, PrepBar, Section, StatusPill } from './parts';
import { addDays, FLAGS, preError, timeOf, todayKey, untilText, useTx, whenOf, ACTIVE } from './view';

type Panel = 'overview' | 'schedule' | 'list' | 'alerts' | 'settings';
const PANELS: Panel[] = ['overview', 'schedule', 'list', 'alerts', 'settings'];

export default function PreordersPage() {
  const T = useTx();
  const [sp, setSp] = useSearchParams();
  const asked = sp.get('tab') as Panel;
  const panel: Panel = PANELS.includes(asked) ? asked : 'overview';
  const [open, setOpen] = useState<string | null>(sp.get('order'));          // a link from LINE or the list: #/preorders?order=<id>
  const [tick, setTick] = useState(0);                                      // bumped whenever something changed, so every panel reloads
  const [missing, setMissing] = useState(false);
  const [attention, setAttention] = useState<number | undefined>(undefined);
  const refresh = useCallback(() => setTick((x) => x + 1), []);
  const go = useCallback((tab: Panel, extra: Record<string, string> = {}) => setSp({ tab, ...extra }), [setSp]);
  useEffect(() => { document.title = T('Preorders'); }, [T]);

  return (
    <>
      <PageHead title={T('Preorders')} desc={T('Orders customers place ahead for a day and time they choose. Watch the day, prepare on time and keep the shop\'s capacity in hand.')}
        actions={<><Link to="/prep"><Button><ClipboardList size={15} /> {T('Pickup prep board')}</Button></Link><Button onClick={refresh} aria-label={T('Refresh')}><RefreshCw size={15} /> {T('Refresh')}</Button></>} />
      {missing ? <Banner tone="warn">{T('The preorder part of the database is not installed yet.')}</Banner> : (
        <>
          <Tabs<Panel> value={panel} onChange={(v) => go(v)} tabs={[
            { v: 'overview', label: T('Overview'), count: attention || undefined }, { v: 'schedule', label: T('Schedule') }, { v: 'list', label: T('All preorders') }, { v: 'alerts', label: T('Alerts') }, { v: 'settings', label: T('Settings') }]} />
          {panel === 'overview' && <Overview tick={tick} go={go} onOpen={setOpen} onMissing={() => setMissing(true)} onAttention={setAttention} />}
          {panel === 'schedule' && <SchedulePanel tick={tick} initialDay={sp.get('day') ?? undefined} onOpen={setOpen} />}
          {panel === 'list' && <ListPanel tick={tick} initial={Object.fromEntries(sp.entries())} onOpen={setOpen} />}
          {panel === 'alerts' && <AlertsPanel tick={tick} onOpen={setOpen} />}
          {panel === 'settings' && <SettingsPanel tick={tick} onChanged={refresh} />}
        </>
      )}
      {open && <PreorderDrawer id={open} onClose={() => { setOpen(null); if (sp.get('order')) { const n = new URLSearchParams(sp); n.delete('order'); setSp(n); } }} onChanged={refresh} />}
    </>
  );
}

// ================================================================================================ overview
function Overview({ tick, go, onOpen, onMissing, onAttention }: { tick: number; go: (t: Panel, x?: Record<string, string>) => void; onOpen: (id: string) => void; onMissing: () => void; onAttention: (n: number) => void }) {
  const T = useTx();
  const [day, setDay] = useState(todayKey());
  const [d, setD] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    pre.dashboard(day).then((r) => { if (on) { setD(r); setErr(null); onAttention(r.attention_count); } }).catch((e) => { if (!on) return; if (isPreorderMissing(e)) onMissing(); else setErr(preError(e, T)); });
    return () => { on = false; };
  }, [day, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = setInterval(() => { if (document.visibilityState === 'visible') pre.dashboard(day).then((r) => { setD(r); onAttention(r.attention_count); }).catch(() => undefined); }, 60_000); return () => clearInterval(h); }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  const isToday = day === todayKey();
  const cards: { k: string; label: string; v: number | undefined; tone?: 'good' | 'bad'; to: Record<string, string> }[] = [
    { k: 'total', label: isToday ? 'Total preorders today' : 'Total preorders that day', v: d?.total, to: { from: day, to: day } },
    { k: 'pending', label: 'Pending confirmation', v: d?.pending, to: { status: 'new', from: day, to: day } },
    { k: 'confirmed', label: 'Confirmed', v: d?.confirmed, to: { status: 'confirmed', from: day, to: day } },
    { k: 'preparing', label: 'Preparing', v: d?.preparing, to: { status: 'preparing', from: day, to: day } },
    { k: 'ready', label: 'Ready for pickup', v: d?.ready, to: { status: 'ready', from: day, to: day } },
    { k: 'completed', label: 'Completed', v: d?.completed, to: { status: 'completed', from: day, to: day } },
    { k: 'cancelled', label: 'Cancelled', v: d?.cancelled, to: { status: 'cancelled', from: day, to: day } },
    { k: 'upcoming', label: 'Upcoming preorders', v: d?.upcoming, to: { from: addDays(day, 1) } },
  ];
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      {err && <Banner tone="bad">{err}</Banner>}
      {d && !d.enabled && <Banner tone="warn">{T('Preorders are switched off, so customers cannot order ahead. Set the opening hours and switch them on in Settings.')} <button type="button" className="link" onClick={() => go('settings')}>{T('Open Settings')}</button></Banner>}
      <div className="row wrap gap-8 po-day">
        <Button size="sm" onClick={() => setDay(addDays(day, -1))} aria-label={T('Previous day')}><ChevronLeft size={15} /></Button>
        <Input type="date" sm value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label={T('Day')} />
        <Button size="sm" onClick={() => setDay(addDays(day, 1))} aria-label={T('Next day')}><ChevronRight size={15} /></Button>
        {!isToday && <Button size="sm" variant="ghost" onClick={() => setDay(todayKey())}>{T('Today')}</Button>}
      </div>
      {!d ? <Skeleton h={120} /> : (
        <>
          <div className="po-kpis" data-testid="po-kpis">
            {cards.map((c) => <Kpi key={c.k} label={T(c.label)} value={<span data-testid={`kpi-${c.k}`}>{c.v ?? 0}</span>} onClick={() => go('list', c.to)} />)}
            <Kpi label={T('Orders requiring attention')} value={<span data-testid="kpi-attention">{d.attention_count}</span>} tone={d.attention_count ? 'bad' : undefined} />
          </div>
          <div className="muted">
            {T('{n} items to prepare that day', { n: d.units_today })}
            {d.capacity.max_units_per_day ? ` · ${T('limit {n} per day', { n: d.capacity.max_units_per_day })}` : ''} · {T('up to {n} orders per time slot', { n: d.capacity.max_orders_per_slot })}
            {d.pending_all ? ` · ${T('{n} waiting for confirmation in total', { n: d.pending_all })}` : ''}
          </div>
          <Section title={T('Needs attention')} hint={T('Late, not started, not paid, waiting for pickup, or the day was closed. Click an order to deal with it.')}>
            {!d.attention.length ? <Empty icon={<CalendarClock size={24} />} title={T('Nothing needs attention')} hint={T('Everything on the schedule is on track.')} /> : (
              <div className="po-grid">{d.attention.map((r) => <OrderCard key={r.id} r={r} showDay onOpen={onOpen} />)}</div>)}
          </Section>
        </>
      )}
    </div>
  );
}

// ================================================================================================ schedule
function SchedulePanel({ tick, initialDay, onOpen }: { tick: number; initialDay?: string; onOpen: (id: string) => void }) {
  const T = useTx();
  const [day, setDay] = useState(initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay) ? initialDay : todayKey());
  const [s, setS] = useState<Schedule | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => pre.schedule(day).then((r) => { setS(r); setErr(null); }).catch((e) => setErr(preError(e, T))), [day]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay)) setDay(initialDay); }, [initialDay]);      // a link or the back button changes the day in the address
  useEffect(() => { setS(null); void load(); }, [load, tick]);
  useEffect(() => { const h = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000); return () => clearInterval(h); }, [load]);
  const nowKey = todayKey() === day ? timeOf(new Date().toISOString()) : null;
  const busy = (s?.slots ?? []).filter((x) => x.orders.length > 0 || x.in_grid === false);
  const showSlots = useMemo(() => (s?.slots ?? []), [s]);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <div className="row wrap gap-8 po-day">
        <Button size="sm" onClick={() => setDay(addDays(day, -1))} aria-label={T('Previous day')}><ChevronLeft size={15} /></Button>
        <Input type="date" sm value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label={T('Day')} />
        <Button size="sm" onClick={() => setDay(addDays(day, 1))} aria-label={T('Next day')}><ChevronRight size={15} /></Button>
        {day !== todayKey() && <Button size="sm" variant="ghost" onClick={() => setDay(todayKey())}>{T('Today')}</Button>}
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      {!s ? <Skeleton h={160} /> : (
        <>
          <div className="muted" data-testid="schedule-summary">
            {s.hours.closed ? <Badge tone="bad">{T('Closed')}{s.hours.reason ? `: ${s.hours.reason}` : ''}</Badge> : <>{T('Open {open}–{close}', { open: s.hours.open ?? '', close: s.hours.close ?? '' })}{s.hours.special ? ` · ${T('special hours')}` : ''}</>}
            {' · '}{T('{n} orders on the timeline', { n: busy.reduce((a, x) => a + x.orders.length, 0) })} · {T('{n} items', { n: s.day_units })}{s.max_units_per_day ? ` / ${s.max_units_per_day}` : ''}{s.cancelled ? ` · ${T('{n} cancelled', { n: s.cancelled })}` : ''}
          </div>
          {!showSlots.length ? <Empty icon={<CalendarClock size={24} />} title={T('No pickup times on this day')} hint={s.hours.closed ? T('The shop is closed that day.') : undefined} /> : (
            <ol className="po-timeline" data-testid="po-timeline">
              {showSlots.map((x) => {
                const full = x.load.orders >= s.max_orders_per_slot || (s.max_units_per_slot != null && x.load.units >= s.max_units_per_slot);
                const isNow = nowKey != null && x.time <= nowKey && nowKey < addMinutes(x.time, s.slot_minutes);
                return (
                  <li key={x.at} className={cx(x.orders.length === 0 && 'empty', isNow && 'now')} data-slot={x.time}>
                    <div className="po-tl-time"><b>{x.time}</b>{!x.in_grid && <small className="warn">{T('off schedule')}</small>}</div>
                    <div className="po-tl-body">
                      <div className="row gap-6 wrap po-tl-load"><span className={cx('po-load', full && 'full')}>{x.load.orders}/{s.max_orders_per_slot} {T('orders')}</span>{s.max_units_per_slot != null && <span className={cx('po-load', full && 'full')}>{x.load.units}/{s.max_units_per_slot} {T('items')}</span>}{full && <Badge tone="warn">{T('full')}</Badge>}</div>
                      {x.orders.map((r) => <OrderCard key={r.id} r={r} onOpen={onOpen} />)}
                    </div>
                  </li>);
              })}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
const addMinutes = (hhmm: string, mins: number): string => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m + mins; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

// ================================================================================================ all preorders
const PAGE = 25;
function ListPanel({ tick, initial, onOpen }: { tick: number; initial: Record<string, string>; onOpen: (id: string) => void }) {
  const T = useTx(); const lang = useLang();
  const [f, setF] = useState({ search: '', status: initial.status ?? '', pay: initial.pay ?? '', from: initial.from ?? '', to: initial.to ?? '', timeFrom: '', timeTo: '', assigned: '', sort: 'pickup_asc' });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ListPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [staff, setStaff] = useState<Staffer[]>([]);
  useEffect(() => { pre.staff().then(setStaff).catch(() => undefined); }, []);
  const set = (p: Partial<typeof f>) => { setF((x) => ({ ...x, ...p })); setPage(0); };
  useEffect(() => {
    let on = true;
    const h = setTimeout(() => pre.list({ ...f, limit: PAGE, offset: page * PAGE }).then((r) => { if (on) { setData(r); setErr(null); } }).catch((e) => { if (on) setErr(preError(e, T)); }), f.search ? 300 : 0);
    return () => { on = false; clearTimeout(h); };
  }, [f, page, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));
  const clear = () => { setF({ search: '', status: '', pay: '', from: '', to: '', timeFrom: '', timeTo: '', assigned: '', sort: 'pickup_asc' }); setPage(0); };
  const filtered = !!(f.search || f.status || f.pay || f.from || f.to || f.timeFrom || f.timeTo || f.assigned);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <div className="po-filters" data-testid="po-filters">
        <SearchBox value={f.search} onChange={(v) => set({ search: v })} placeholder={T('Order no., customer name or phone')} />
        <Select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label={T('Status')}>
          <option value="">{T('All statuses')}</option>{(['new', 'confirmed', 'preparing', 'packed', 'ready', 'completed', 'cancelled'] as const).map((s) => <option key={s} value={s}>{T(s === 'new' ? 'Pending confirmation' : s === 'ready' ? 'Ready for pickup' : s === 'completed' ? 'Picked up' : s[0].toUpperCase() + s.slice(1))}</option>)}
        </Select>
        <Select value={f.pay} onChange={(e) => set({ pay: e.target.value })} aria-label={T('Payment')}>
          <option value="">{T('Any payment')}</option><option value="paid">{T('Paid')}</option><option value="review">{T('Slip waiting / part paid')}</option><option value="unpaid">{T('Not paid')}</option>
        </Select>
        <Select value={f.assigned} onChange={(e) => set({ assigned: e.target.value })} aria-label={T('Assigned to')}>
          <option value="">{T('Anyone')}</option><option value="none">{T('Nobody yet')}</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <label className="po-f"><span>{T('Pickup from')}</span><Input type="date" sm value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="po-f"><span>{T('to')}</span><Input type="date" sm value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
        <label className="po-f"><span>{T('Time from')}</span><Input type="time" sm value={f.timeFrom} onChange={(e) => set({ timeFrom: e.target.value })} /></label>
        <label className="po-f"><span>{T('to')}</span><Input type="time" sm value={f.timeTo} onChange={(e) => set({ timeTo: e.target.value })} /></label>
        <Select value={f.sort} onChange={(e) => set({ sort: e.target.value })} aria-label={T('Sort by')}>
          <option value="pickup_asc">{T('Soonest pickup first')}</option><option value="pickup_desc">{T('Latest pickup first')}</option><option value="created_desc">{T('Newest order first')}</option><option value="total_desc">{T('Largest total first')}</option>
        </Select>
        {filtered && <Button size="sm" variant="ghost" onClick={clear}>{T('Clear filters')}</Button>}
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      {!data && !err ? <Skeleton h={160} /> : data && !data.orders.length ? <Empty icon={<ClipboardList size={24} />} title={T('No preorders match')} hint={filtered ? T('Try clearing a filter.') : T('Preorders customers place appear here.')} /> : data && (
        <div className="card table-wrap">
          <table className="t" data-testid="po-table"><thead><tr>
            <th>{T('Order')}</th><th>{T('Customer')}</th><th>{T('Ordered')}</th><th>{T('Pickup')}</th><th className="r">{T('Items')}</th><th className="r">{T('Total')}</th><th>{T('Payment')}</th><th>{T('Status')}</th><th>{T('Assigned')}</th><th>{T('Notes')}</th></tr></thead>
            <tbody>{data.orders.map((r) => (
              <tr key={r.id} className="click" tabIndex={0} data-order={r.order_no} onClick={() => onOpen(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.id); }}>
                <td><b className="mono">{r.order_no}</b></td>
                <td>{r.contact_name}<div className="muted">{r.contact_phone}</div></td>
                <td>{new Date(r.created_at).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td><b>{whenOf(r.pickup_at, lang)}</b>{ACTIVE.includes(r.status) && <div className={cx('muted', untilText(r.pickup_at, T).late && 'bad')}>{untilText(r.pickup_at, T).text}</div>}</td>
                <td className="r">{r.units}{r.lines > 1 ? <div className="muted">{T('{n} lines', { n: r.lines })}</div> : null}<PrepBar prep={r.prep} /></td>
                <td className="r">{money(r.total)}</td>
                <td><PayPill code={r.pay_code} /></td>
                <td><StatusPill s={r.status} kind={r.cancel_kind} /><div className="row gap-4 wrap"><FlagPills flags={r.flags} max={2} /></div></td>
                <td>{r.assigned_name ?? <span className="muted">—</span>}</td>
                <td className="po-notecell">{r.note ? <span title={r.note}>{r.note}</span> : <span className="muted">—</span>}</td>
              </tr>))}</tbody></table>
        </div>
      )}
      {data && data.total > 0 && (
        <div className="row between wrap" data-testid="po-paging">
          <span className="muted">{T('Showing {a}–{b} of {n}', { a: page * PAGE + 1, b: Math.min((page + 1) * PAGE, data.total), n: data.total })}</span>
          <div className="row gap-6"><Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{T('Previous')}</Button><span className="muted">{page + 1} / {pages}</span><Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{T('Next')}</Button></div>
        </div>)}
    </div>
  );
}

// ================================================================================================ alerts
const KIND_LABEL: Record<string, string> = {
  new: 'New preorder', changed: 'Customer changed the schedule', cancelled_by_customer: 'Customer cancelled', request: 'Customer asked for a change', assigned: 'Assigned to someone', rescheduled_assignee: 'Pickup time changed',
  due_soon: 'Not started in time', late: 'Late', overdue_pickup: 'Waiting for pickup', slot_near: 'Time slot nearly full', slot_full: 'Time slot full', large: 'Large order',
  placed: 'Preorder received', confirmed: 'Confirmed', preparing: 'Preparing', ready: 'Ready', completed: 'Picked up', rejected: 'Rejected', cancelled_by_shop: 'Cancelled by the shop', rescheduled_by_shop: 'Time changed by the shop', reminder: 'Pickup reminder',
};
function AlertsPanel({ tick, onOpen }: { tick: number; onOpen: (id: string) => void }) {
  const T = useTx(); const lang = useLang();
  const [rows, setRows] = useState<StaffNotice[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [who, setWho] = useState<'staff' | 'customer' | 'all'>('staff');
  useEffect(() => { let on = true; pre.notices(100).then((r) => { if (on) { setRows(r); setErr(null); } }).catch((e) => { if (on) setErr(preError(e, T)); }); return () => { on = false; }; }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (rows ?? []).filter((r) => who === 'all' || r.audience === who);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <div className="row wrap gap-8">
        <div className="seg" role="tablist">{(['staff', 'customer', 'all'] as const).map((w) => <button key={w} className={who === w ? 'on' : ''} onClick={() => setWho(w)}>{T(w === 'staff' ? 'For staff' : w === 'customer' ? 'Sent to customers' : 'Everything')}</button>)}</div>
        <span className="muted">{T('Every message is kept here once. LINE shows whether it was delivered; failures can be resent in Settings → LINE notifications.')}</span>
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      {!rows && !err ? <Skeleton h={120} /> : !shown.length ? <Empty icon={<CalendarClock size={24} />} title={T('No alerts yet')} /> : (
        <div className="card table-wrap"><table className="t" data-testid="po-alerts"><thead><tr><th>{T('When')}</th><th>{T('Order')}</th><th>{T('For')}</th><th>{T('What')}</th><th>LINE</th></tr></thead>
          <tbody>{shown.map((r, i) => (
            <tr key={i} className="click" tabIndex={0} onClick={() => onOpen(r.order_id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.order_id); }}>
              <td>{new Date(r.at).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="mono">{r.order_no}</td><td>{r.audience === 'customer' ? T('Customer') : r.for_profile ? T('Assigned employee') : T('Staff')}</td>
              <td><b>{T(KIND_LABEL[r.kind] ?? r.kind)}</b>{r.text_th ? <div className="muted">{r.text_th}</div> : null}</td>
              <td>{r.line ? <Badge tone={r.line === 'sent' ? 'good' : r.line === 'dead' ? 'bad' : r.line === 'failed' ? 'warn' : ''} dot>{r.line}</Badge> : <span className="muted">{T('app only')}</span>}{r.line_error ? <div className="muted bad">{r.line_error}</div> : null}</td>
            </tr>))}</tbody></table></div>
      )}
    </div>
  );
}

// ================================================================================================ settings
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SLOT_CHOICES = [10, 15, 20, 30, 45, 60, 90, 120];
function SettingsPanel({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const T = useTx();
  const [s, setS] = useState<PreSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [hours, setHours] = useState<DayHours[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => pre.settings().then((r) => { setS(r); setHours(r.weekly_hours); setF({
    slot_minutes: String(r.slot_minutes), lead_minutes: String(r.lead_minutes), max_advance_days: String(r.max_advance_days), max_orders_per_slot: String(r.max_orders_per_slot),
    max_units_per_slot: r.max_units_per_slot == null ? '' : String(r.max_units_per_slot), max_units_per_day: r.max_units_per_day == null ? '' : String(r.max_units_per_day),
    change_cutoff_minutes: String(r.change_cutoff_minutes), prep_lead_minutes: String(r.prep_lead_minutes), reminder_minutes: String(r.reminder_minutes), grace_minutes: String(r.grace_minutes),
    large_order_units: String(r.large_order_units), customer_note: r.customer_note ?? '' }); setErr(null); }).catch((e) => setErr(preError(e, T))), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, tick]);
  const edit = !!s?.can_edit;
  const num = (k: string) => (f[k] === '' ? null : Number(f[k]));
  const save = async (patch: SettingsPatch, ok = 'Settings saved') => {
    setBusy(true);
    try { const r = await pre.saveSettings(patch); setS(r); toast('success', T(ok)); onChanged(); await load(); } catch (e) { toast('error', preError(e, T)); } finally { setBusy(false); }
  };
  const saveAll = () => save({
    slot_minutes: Number(f.slot_minutes), lead_minutes: Number(f.lead_minutes), max_advance_days: Number(f.max_advance_days), weekly_hours: hours, max_orders_per_slot: Number(f.max_orders_per_slot),
    max_units_per_slot: num('max_units_per_slot'), max_units_per_day: num('max_units_per_day'), change_cutoff_minutes: Number(f.change_cutoff_minutes), prep_lead_minutes: Number(f.prep_lead_minutes),
    reminder_minutes: Number(f.reminder_minutes), grace_minutes: Number(f.grace_minutes), large_order_units: Number(f.large_order_units), customer_note: f.customer_note,
  });
  const field = (k: string, label: string, hint?: string, opts: { optional?: boolean; max?: number } = {}) => (
    <Field label={T(label)} hint={hint ? T(hint) : undefined}><Input type="number" min={opts.optional ? 1 : 0} value={f[k] ?? ''} disabled={!edit} placeholder={opts.optional ? T('No limit') : undefined} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`set-${k}`} /></Field>);
  if (err && !s) return <Banner tone="bad">{err}</Banner>;
  if (!s) return <Skeleton h={200} />;
  const ready = s.configured && s.pickup_enabled && s.shop_open;
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      {!edit && <Banner tone="info">{T('Only a SUPER_ADMIN can change these settings. You can still manage closures and special days below.')}</Banner>}
      <div className="card card-b col gap-8">
        <div className="row between wrap gap-8">
          <div><b>{T('Customers can order ahead')}</b><div className="muted">{T('When this is off, the preorder choice is not shown in the customer app. Preorders already placed continue as normal.')}</div></div>
          <Switch checked={s.enabled} onChange={(v) => save({ enabled: v }, v ? 'Preorders are on' : 'Preorders are off')} label={T('Customers can order ahead')} />
        </div>
        <ul className="po-check-list" data-testid="po-checklist">
          <li className={cx(s.configured && 'ok')}>{s.configured ? '✓' : '○'} {T('Opening hours saved')}{!s.configured && <> — {T('review the hours below and press Save settings')}</>}</li>
          <li className={cx(s.pickup_enabled && 'ok')}>{s.pickup_enabled ? '✓' : '○'} {T('Pick-up is offered in the Online shop settings')}</li>
          <li className={cx(s.shop_open && 'ok')}>{s.shop_open ? '✓' : '○'} {T('The online shop is open')}</li>
        </ul>
        {s.enabled && !ready && <Banner tone="warn">{T('Preorders are on, but a step above is missing, so customers do not see them yet.')}</Banner>}
      </div>

      <Section title={T('Opening hours')} hint={T('Pickup times are offered inside these hours only. A time slot must fit completely before closing.')}>
        <div className="po-hours">{hours.map((h, i) => (
          <div key={h.dow} className="row gap-8 wrap po-hours-row">
            <b style={{ minWidth: 96 }}>{T(DOW[h.dow])}</b>
            <label className="row gap-4"><input type="checkbox" disabled={!edit} checked={!h.closed} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, closed: !e.target.checked } : x)))} /> {T('Open')}</label>
            <Input type="time" sm value={h.open} disabled={!edit || h.closed} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} aria-label={`${T(DOW[h.dow])} ${T('opens')}`} />
            <span>–</span>
            <Input type="time" sm value={h.close} disabled={!edit || h.closed} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} aria-label={`${T(DOW[h.dow])} ${T('closes')}`} />
          </div>))}</div>
      </Section>

      <Section title={T('Pickup times')} hint={T('How the day is cut into pickup times and how far ahead customers may order.')}>
        <div className="po-fields">
          <Field label={T('Pickup interval (minutes)')}><Select value={f.slot_minutes} disabled={!edit} onChange={(e) => setF({ ...f, slot_minutes: e.target.value })} data-testid="set-slot_minutes">
            {[...new Set([...SLOT_CHOICES, Number(f.slot_minutes)])].filter((n) => n > 0).sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
          {field('lead_minutes', 'Preparation lead time (minutes)', 'The earliest pickup is this long after the order.')}
          {field('max_advance_days', 'Furthest day customers can book (days)')}
        </div>
      </Section>

      <Section title={T('Capacity')} hint={T('Every active preorder counts against the time slot it is booked in. Units are the total quantity of the products, which absorbs big orders better than a count of orders.')}>
        <div className="po-fields">
          {field('max_orders_per_slot', 'Orders per time slot')}
          {field('max_units_per_slot', 'Items per time slot', 'Leave empty for no limit.', { optional: true })}
          {field('max_units_per_day', 'Items per day', 'Leave empty for no limit.', { optional: true })}
          {field('large_order_units', 'Large order from (items)', 'Staff get an alert for an order this big.')}
        </div>
      </Section>

      <Section title={T('Changes, reminders and alerts')}>
        <div className="po-fields">
          {field('change_cutoff_minutes', 'Customer can change or cancel until (minutes before pickup)')}
          {field('reminder_minutes', 'Remind the customer (minutes before pickup)')}
          {field('prep_lead_minutes', 'Warn staff if not started (minutes before pickup)')}
          {field('grace_minutes', '"Waiting for pickup" after (minutes past the pickup time)')}
        </div>
        <Field label={T('Message shown to customers when they choose a time (optional)')}><Input value={f.customer_note ?? ''} maxLength={400} disabled={!edit} onChange={(e) => setF({ ...f, customer_note: e.target.value })} data-testid="set-customer_note" /></Field>
      </Section>
      {edit && <div className="row gap-8"><Button variant="primary" loading={busy} onClick={saveAll} data-testid="set-save">{T('Save settings')}</Button></div>}

      <ClosuresPanel s={s} onChanged={() => { onChanged(); void load(); }} />
    </div>
  );
}

function ClosuresPanel({ s, onChanged }: { s: PreSettings; onChanged: () => void }) {
  const T = useTx();
  const [d, setD] = useState({ day: '', kind: 'closed' as 'closed' | 'special', open: '09:00', close: '14:00', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [force, setForce] = useState<string | null>(null);
  const save = async (forced = false) => {
    setBusy(true); setErr(null);
    try { const r = await pre.saveDay(d.day, d.kind, d.kind === 'special' ? d.open : null, d.kind === 'special' ? d.close : null, d.reason, forced); toast('success', T(r.orders_affected ? 'Saved. {n} preorder(s) now need attention.' : 'Saved', { n: r.orders_affected })); setForce(null); setD({ ...d, day: '', reason: '' }); onChanged(); }
    catch (e) { const m = preError(e, T); setErr(m); if (e instanceof Error && /DAY_HAS_ORDERS/.test(e.message)) setForce(m); } finally { setBusy(false); }
  };
  const remove = async (day: string) => { try { await pre.removeDay(day); toast('success', T('Removed')); onChanged(); } catch (e) { toast('error', preError(e, T)); } };
  return (
    <Section title={T('Holidays, closures and special hours')} hint={T('A closed date offers no pickup times. Special hours replace the weekly hours for that date.')}>
      <div className="po-fields">
        <Field label={T('Date')}><Input type="date" value={d.day} min={todayKey()} onChange={(e) => setD({ ...d, day: e.target.value })} data-testid="day-date" /></Field>
        <Field label={T('Type')}><Select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as 'closed' | 'special' })} data-testid="day-kind"><option value="closed">{T('Closed all day')}</option><option value="special">{T('Special hours')}</option></Select></Field>
        {d.kind === 'special' && <><Field label={T('Opens')}><Input type="time" value={d.open} onChange={(e) => setD({ ...d, open: e.target.value })} /></Field><Field label={T('Closes')}><Input type="time" value={d.close} onChange={(e) => setD({ ...d, close: e.target.value })} /></Field></>}
        <Field label={T('Reason (optional, customers see it)')}><Input value={d.reason} maxLength={200} onChange={(e) => setD({ ...d, reason: e.target.value })} data-testid="day-reason" /></Field>
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      <div className="row gap-8"><Button variant="primary" loading={busy} disabled={!d.day} onClick={() => save(false)} data-testid="day-save">{T('Save date')}</Button>{force && <Button variant="danger" loading={busy} onClick={() => save(true)}>{T('Save anyway (the orders will be flagged)')}</Button>}</div>
      {!s.days.length ? <div className="muted">{T('No special dates yet.')}</div> : (
        <div className="card table-wrap"><table className="t" data-testid="po-days"><thead><tr><th>{T('Date')}</th><th>{T('What')}</th><th>{T('Reason')}</th><th className="r">{T('Active preorders')}</th><th /></tr></thead>
          <tbody>{s.days.map((x) => (<tr key={x.day}><td className="mono">{x.day}</td><td>{x.kind === 'closed' ? <Badge tone="bad">{T('Closed')}</Badge> : <Badge tone="info">{x.open}–{x.close}</Badge>}</td><td>{x.reason ?? '—'}</td><td className="r">{x.orders || '—'}</td><td className="r"><Button size="sm" variant="ghost" onClick={() => remove(x.day)}>{T('Remove')}</Button></td></tr>))}</tbody></table></div>
      )}
    </Section>
  );
}
