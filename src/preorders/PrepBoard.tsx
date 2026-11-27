// Back office → Pickup prep: the employee's board. Built for a phone held in one hand at the counter: what has to be ready, by when, how many of what, the customer's
// instructions, one big checklist per order, and one big button for the next step. Orders move to "Preparing", "Ready" and "Handed over" here without opening the manager's pages.
// The checklist must be complete before an order can be marked ready (the database refuses otherwise). Refreshes itself every 30 seconds.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Phone, RefreshCw } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { cx } from '../lib/util';
import { Badge, Banner, Button, Empty, PageHead, Skeleton, Switch } from '../ui/kit';
import { isPreorderMissing, pre, type PreRow } from './api';
import { Checklist, FlagPills, nextMove, PayPill, PrepBar, StatusPill, useCanceller, useMover } from './parts';
import { dayOf, preError, timeOf, todayKey, untilText, useTx, whenOf, addDays } from './view';

export default function PrepBoard() {
  const T = useTx(); const lang = useLang();
  const [rows, setRows] = useState<PreRow[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [days, setDays] = useState(2);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [gone, setGone] = useState<string[]>([]);               // orders that left the board since it was opened (cancelled or handed over elsewhere)
  const seen = useRef<Map<string, string>>(new Map());
  const [, setClock] = useState(0);
  const load = useCallback(async () => {
    try {
      const b = await pre.board(mine, days);
      const now = new Map(b.orders.map((o) => [o.id, o.order_no] as const));
      const left = [...seen.current.entries()].filter(([id]) => !now.has(id)).map(([, no]) => no);
      if (left.length) setGone((g) => [...new Set([...g, ...left])]);
      seen.current = now;
      setRows(b.orders); setMe(b.me); setErr(null);
    } catch (e) { if (isPreorderMissing(e)) setMissing(true); else setErr(preError(e, T)); }
  }, [mine, days]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { seen.current = new Map(); setGone([]); setRows(null); void load(); }, [load]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') { void load(); setClock((x) => x + 1); } };
    const h = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(h); document.removeEventListener('visibilitychange', tick); };
  }, [load]);
  useEffect(() => { document.title = T('Pickup prep'); }, [T]);

  const patch = (r: PreRow) => setRows((rs) => (rs ? rs.map((x) => (x.id === r.id ? r : x)) : rs));
  const groups = useMemo(() => {
    const today = todayKey();
    const urgent = (rows ?? []).filter((r) => r.flags.some((f) => f === 'late' || f === 'not_started' || f === 'overdue_pickup' || f === 'closed_day'));
    const ids = new Set(urgent.map((r) => r.id));
    const rest = (rows ?? []).filter((r) => !ids.has(r.id));
    const byDay = new Map<string, PreRow[]>();
    for (const r of rest) { const k = dayOf(r.pickup_at); byDay.set(k, [...(byDay.get(k) ?? []), r]); }
    return { urgent, days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({ day, today: day === today, tomorrow: day === addDays(today, 1), list })) };
  }, [rows]);
  const toPrepare = (rows ?? []).filter((r) => ['confirmed', 'preparing', 'packed'].includes(r.status)).length;
  const ready = (rows ?? []).filter((r) => r.status === 'ready').length;
  const waiting = (rows ?? []).filter((r) => r.status === 'new').length;

  return (
    <div className="pb">
      <PageHead title={T('Pickup prep')} desc={T('What to prepare, by when. Tick each item as you pack it, then mark the order ready.')}
        actions={<><Link to="/preorders"><Button><CalendarClock size={15} /> {T('Preorders')}</Button></Link><Button onClick={() => void load()} aria-label={T('Refresh')}><RefreshCw size={15} /> {T('Refresh')}</Button></>} />
      {missing ? <Banner tone="warn">{T('The preorder part of the database is not installed yet.')}</Banner> : (
        <>
          <div className="pb-bar">
            <Switch checked={mine} onChange={setMine} label={T('Only my orders')} />
            <label className="pb-days"><span>{T('Show')}</span>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={T('Days to show')}><option value={1}>{T('Today')}</option><option value={2}>{T('Today and tomorrow')}</option><option value={4}>{T('Next 4 days')}</option><option value={8}>{T('Next 8 days')}</option></select>
            </label>
          </div>
          {rows && <div className="pb-sum" data-testid="pb-summary"><Badge tone="info">{toPrepare} {T('to prepare')}</Badge> <Badge tone="good">{ready} {T('ready')}</Badge> {waiting > 0 && <Badge tone="warn">{waiting} {T('waiting for confirmation')}</Badge>}</div>}
          {gone.length > 0 && <Banner tone="info">{T('No longer on the board (cancelled or handed over): {list}', { list: gone.join(', ') })} <button type="button" className="link" onClick={() => setGone([])}>{T('OK')}</button></Banner>}
          {err && <Banner tone="bad">{err}</Banner>}
          {!rows && !err ? <Skeleton h={220} /> : rows && !rows.length ? <Empty icon={<CalendarClock size={26} />} title={T('Nothing to prepare')} hint={mine ? T('No preorder is assigned to you. Turn off "Only my orders" to see them all.') : T('New preorders appear here once customers place them.')} /> : (
            <>
              {groups.urgent.length > 0 && <section className="pb-sec urgent" data-testid="pb-urgent"><h2>{T('Needs action now')} <Badge tone="bad">{groups.urgent.length}</Badge></h2>{groups.urgent.map((r) => <PrepCard key={r.id} r={r} me={me} onChange={patch} onReload={load} />)}</section>}
              {groups.days.map((g) => (
                <section key={g.day} className="pb-sec" data-day={g.day}><h2>{g.today ? T('Today') : g.tomorrow ? T('Tomorrow') : whenOf(`${g.day}T12:00:00+07:00`, lang).replace(/ \d\d:\d\d.*$/, '')} <span className="muted">· {g.list.length}</span></h2>
                  {g.list.map((r) => <PrepCard key={r.id} r={r} me={me} onChange={patch} onReload={load} />)}</section>))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function PrepCard({ r, me, onChange, onReload }: { r: PreRow; me: string | null; onChange: (r: PreRow) => void; onReload: () => Promise<void> }) {
  const T = useTx();
  const [busy, setBusy] = useState(false);
  const move = useMover(T); const cancel = useCanceller(T);
  const u = untilText(r.pickup_at, T);
  const allTicked = r.prep.total > 0 && r.prep.checked >= r.prep.total;
  const canTick = ['confirmed', 'preparing', 'packed'].includes(r.status);
  const m = nextMove(r.status);
  const tick = async (line: number | null, checked: boolean) => {
    setBusy(true);
    try { onChange(await pre.prep(r.id, line, checked)); } catch (e) { toast('error', preError(e, T)); } finally { setBusy(false); }
  };
  const go = async () => {
    if (!m) return;
    setBusy(true);
    try { if (await move(r.id, m.to)) { toast('success', T(m.to === 'completed' ? 'Handed over. Thank you!' : 'Order updated')); await onReload(); } } finally { setBusy(false); }
  };
  const take = async () => { setBusy(true); try { onChange(await pre.assign(r.id, me)); toast('success', T('You took this order')); } catch (e) { toast('error', preError(e, T)); } finally { setBusy(false); } };
  return (
    <article className={cx('pb-card', u.late && r.status !== 'ready' && 'late', r.status === 'ready' && 'ready')} data-testid="pb-card" data-order={r.order_no} data-status={r.status}>
      <header>
        <div className="pb-time"><b>{timeOf(r.pickup_at)}</b><small className={cx(u.late && 'bad')}>{u.text}</small></div>
        <div className="pb-head">
          <div className="row between gap-6"><b className="mono">{r.order_no}</b><StatusPill s={r.status} kind={r.cancel_kind} /></div>
          <div className="row gap-6 wrap"><span><b>{r.units}</b> {T('items')}</span><PrepBar prep={r.prep} /><PayPill code={r.pay_code} /><FlagPills flags={r.flags} max={4} /></div>
        </div>
      </header>
      <div className="pb-who"><b>{r.contact_name}</b><a href={`tel:${r.contact_phone}`} className="pb-call"><Phone size={15} aria-hidden /> {r.contact_phone}</a></div>
      {r.note && <div className="pb-note" data-testid="pb-note"><small>{T('Customer instructions')}</small><div>{r.note}</div></div>}
      {r.status_note && <div className="muted">{T('Message shown to the customer')}: {r.status_note}</div>}
      {r.status === 'new' ? <div className="muted">{T('Waiting for the shop to confirm this order.')}</div> : <Checklist row={r} disabled={!canTick} busy={busy} onToggle={(l, c) => tick(l, c)} />}
      {canTick && !allTicked && r.prep.total > 1 && <Button size="sm" variant="soft" disabled={busy} onClick={() => tick(null, true)}>{T('Tick everything')}</Button>}
      <footer>
        {!r.assigned_to && me && ['new', 'confirmed', 'preparing', 'packed'].includes(r.status) && <Button disabled={busy} onClick={take} data-testid="pb-take">{T('Take this order')}</Button>}
        {r.assigned_name && <span className="muted">{T('Assigned to')}: {r.assigned_name}</span>}
        {m && <Button variant="primary" size="lg" loading={busy} disabled={busy || (m.to === 'ready' && !allTicked)} onClick={go} data-testid="pb-next">{T(m.label)}</Button>}
        {m?.to === 'ready' && !allTicked && <span className="muted">{T('Tick every item first')}</span>}
        {['new', 'confirmed', 'preparing', 'packed'].includes(r.status) && <Button variant="ghost" size="sm" disabled={busy} onClick={async () => { setBusy(true); try { if (await cancel(r)) await onReload(); } finally { setBusy(false); } }}>{T(r.status === 'new' ? 'Reject' : 'Cancel order')}</Button>}
      </footer>
    </article>
  );
}
