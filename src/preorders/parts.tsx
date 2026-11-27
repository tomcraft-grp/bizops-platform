// Shared pieces of the preorder back office: status / payment / flag badges, the compact order card, the checklist, and the order drawer where staff run one preorder
// (confirm, assign, move the time, tick the checklist, start, ready, hand over, cancel). Every action is a database function that checks the caller and the rules again.
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Phone, User } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { cx, dateTimeFmt, money } from '../lib/util';
import { Badge, Banner, Button, Drawer, Field, Input, Modal, Select, Skeleton, Textarea, useConfirm } from '../ui/kit';
import { STATUS as PAY } from '../finance/api';
import { OrderStatus, ShopError, shopAdmin } from '../shop/api';
import { pre, type Flag, type PreAdminOrder, type PreRow, type Schedule, type Staffer } from './api';
import { ACTIVE, FLAGS, preError, slotInstant, sortFlags, STATUS_TONE, statusText, timeOf, todayKey, untilText, useTx, whenOf, addDays, type TFn } from './view';

export function StatusPill({ s, kind }: { s: OrderStatus; kind?: PreRow['cancel_kind'] }) {
  const T = useTx();
  return <Badge tone={STATUS_TONE[s]} dot>{T(statusText(s, kind))}</Badge>;
}
export function PayPill({ code }: { code: number | null | undefined }) {
  const lang = useLang();
  const s = PAY[(code ?? 0) as keyof typeof PAY] ?? PAY[0];
  return <Badge tone={s.tone} dot>{lang === 'th' ? s.th : s.en}</Badge>;
}
export function FlagPills({ flags, max = 3 }: { flags: Flag[]; max?: number }) {
  const T = useTx();
  const list = sortFlags(flags);
  return <>{list.slice(0, max).map((f) => <span key={f} title={T(FLAGS[f].hint)}><Badge tone={FLAGS[f].tone}>{T(FLAGS[f].label)}</Badge></span>)}{list.length > max && <Badge>+{list.length - max}</Badge>}</>;
}
export function PrepBar({ prep }: { prep: { checked: number; total: number } }) {
  const T = useTx();
  if (!prep.total) return null;
  return <span className="po-prepbar" title={T('{a} of {b} items prepared', { a: prep.checked, b: prep.total })}><progress max={prep.total} value={prep.checked} /> <small>{prep.checked}/{prep.total}</small></span>;
}

/** One preorder as a compact card (the schedule, the attention list): time, number, customer, items, status and flags. Click opens it. */
export function OrderCard({ r, onOpen, showDay }: { r: PreRow; onOpen: (id: string) => void; showDay?: boolean }) {
  const T = useTx(); const lang = useLang();
  const u = untilText(r.pickup_at, T);
  const live = ACTIVE.includes(r.status);
  return (
    <button type="button" className={cx('po-card', live && u.late && 'late')} data-testid="po-card" data-order={r.order_no} onClick={() => onOpen(r.id)}>
      <div className="row between">
        <b className="mono">{r.order_no}</b><StatusPill s={r.status} kind={r.cancel_kind} />
      </div>
      <div className="po-card-main"><span>{r.contact_name}</span><span className="muted">{showDay ? whenOf(r.pickup_at, lang) : timeOf(r.pickup_at)}{live ? ` · ${u.text}` : ''}</span></div>
      <div className="row gap-6 wrap"><span className="muted">{T('{n} items', { n: r.units })}{r.lines > 1 ? ` · ${T('{n} lines', { n: r.lines })}` : ''}</span><PrepBar prep={r.prep} /><FlagPills flags={r.flags} /></div>
    </button>
  );
}

/** The checklist of one order: a large tap target per line (name, quantity). */
export function Checklist({ row, disabled, onToggle, busy }: { row: PreRow; disabled?: boolean; busy?: boolean; onToggle: (line: number, checked: boolean) => void }) {
  const T = useTx();
  const items = row.items ?? [];
  return (
    <ul className="po-check" aria-label={T('Preparation checklist')}>
      {items.map((i) => (
        <li key={i.line_no}>
          <label className={cx(i.checked && 'done')}>
            <input type="checkbox" checked={i.checked} disabled={disabled || busy} data-testid={`tick-${i.line_no}`} onChange={(e) => onToggle(i.line_no, e.target.checked)} />
            <span className="po-check-q">{i.qty}</span>
            <span className="po-check-n">{i.name}{i.unit ? <small className="muted"> · {i.unit}</small> : null}<small className="muted mono"> {i.sku_code}</small></span>
          </label>
        </li>))}
    </ul>
  );
}

/** What the primary button of an order does next, and what that move is called. */
export function nextMove(s: OrderStatus): { to: OrderStatus; label: string } | null {
  switch (s) {
    case 'new': return { to: 'confirmed', label: 'Confirm' };
    case 'confirmed': return { to: 'preparing', label: 'Start preparing' };
    case 'preparing': case 'packed': return { to: 'ready', label: 'Mark ready for pickup' };
    case 'ready': return { to: 'completed', label: 'Handed over to the customer' };
    default: return null;
  }
}

/**
 * Run one status move. A move that needs a verified payment is offered once more with a recorded reason (the same rule as the Online shop page: nothing bypasses the payment check silently).
 * Returns true when the move happened.
 */
export function useMover(T: TFn) {
  const confirm = useConfirm();
  return useCallback(async (id: string, to: OrderStatus, note?: string): Promise<boolean> => {
    try { await shopAdmin.setStatus(id, to, note); return true; }
    catch (e) {
      if (e instanceof ShopError && e.code === 'PAYMENT_REQUIRED') {
        const r = await confirm({ title: T('Continue without verified payment?'), body: T('Use this only when the shop has agreed it (for example the customer pays at pickup). The reason stays in the internal log; the customer does not see it.'), reason: T('Reason (internal)'), confirmLabel: T('Continue anyway'), danger: true });
        if (!r.ok) return false;
        try { await shopAdmin.setStatus(id, to, note, r.reason); return true; } catch (e2) { toast('error', preError(e2, T)); return false; }
      }
      toast('error', preError(e, T)); return false;
    }
  }, [confirm, T]);
}

/** Cancel (reject) with the reason the customer will see. */
export function useCanceller(T: TFn) {
  const confirm = useConfirm();
  return useCallback(async (r: Pick<PreRow, 'id' | 'status'>): Promise<boolean> => {
    const rejecting = r.status === 'new';
    const x = await confirm({ title: T(rejecting ? 'Reject this preorder?' : 'Cancel this preorder?'), body: T('The invoice is cancelled with it. If a payment was verified, reverse it on the Payment review page first. The customer sees the reason.'), reason: T('Reason for the customer'), confirmLabel: T(rejecting ? 'Reject preorder' : 'Cancel preorder'), danger: true });
    if (!x.ok) return false;
    try { await shopAdmin.setStatus(r.id, 'cancelled', x.reason); return true; } catch (e) { toast('error', preError(e, T)); return false; }
  }, [confirm, T]);
}

// ================================================================================================ moving the pickup time
/** Pick another slot (all the shop's slots of a day with their load), with a reason; full slots need the explicit "allow over capacity". */
export function RescheduleModal({ row, onClose, onDone }: { row: PreRow; onClose: () => void; onDone: (r: PreRow) => void }) {
  const T = useTx(); const lang = useLang();
  const [day, setDay] = useState(() => { const d = new Date(row.pickup_at); return isNaN(d.getTime()) ? todayKey() : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(d); });
  const [sch, setSch] = useState<Schedule | null>(null);
  const [at, setAt] = useState('');
  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; setSch(null); pre.schedule(day).then((s) => { if (on) setSch(s); }).catch((e) => { if (on) setErr(preError(e, T)); }); return () => { on = false; }; }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  const slots = (sch?.slots ?? []).filter((s) => s.in_grid && new Date(s.at).getTime() > Date.now());
  const chosen = slots.find((s) => s.at === at);
  const full = !!chosen && (chosen.load.orders >= (sch?.max_orders_per_slot ?? 99) || (sch?.max_units_per_slot != null && chosen.load.units + row.units > sch.max_units_per_slot));
  const save = async () => {
    setBusy(true); setErr(null);
    try { const r = await pre.reschedule(row.id, at, reason, force); toast('success', T('Pickup time changed. The customer is told.')); onDone(r); }
    catch (e) { setErr(preError(e, T)); } finally { setBusy(false); }
  };
  return (
    <Modal title={T('Change the pickup time')} onClose={onClose} size="sm" footer={<><Button onClick={onClose}>{T('Close')}</Button><Button variant="primary" loading={busy} disabled={!at || !reason.trim() || (full && !force)} onClick={save}>{T('Move it')}</Button></>}>
      <div className="col gap-12">
        <div className="muted">{T('Now')}: <b>{whenOf(row.pickup_at, lang)}</b> · {T('{n} items', { n: row.units })}</div>
        <Field label={T('Day')}><Input type="date" value={day} min={todayKey()} onChange={(e) => { setDay(e.target.value); setAt(''); }} /></Field>
        {!sch ? <Skeleton h={80} /> : sch.hours.closed ? <Banner tone="warn">{T('The shop is closed that day.')}</Banner> : (
          <div className="po-slotpick" role="radiogroup" aria-label={T('Time')}>
            {slots.map((s) => {
              const f = s.load.orders >= sch.max_orders_per_slot || (sch.max_units_per_slot != null && s.load.units + row.units > sch.max_units_per_slot);
              return <button key={s.at} type="button" role="radio" aria-checked={at === s.at} data-slot={s.time} className={cx('po-slotbtn', at === s.at && 'on', f && 'full')} onClick={() => setAt(s.at)}><b>{s.time}</b><small>{s.load.orders}/{sch.max_orders_per_slot}{f ? ` · ${T('full')}` : ''}</small></button>;
            })}
            {!slots.length && <span className="muted">{T('No pickup times left on this day.')}</span>}
          </div>
        )}
        {full && <label className="row gap-6"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> <span>{T('Allow over capacity (recorded in the history)')}</span></label>}
        <Field label={T('Reason (the customer sees it)')}><Textarea rows={2} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Modal>
  );
}

// ================================================================================================ the order drawer
export function PreorderDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const T = useTx(); const lang = useLang();
  const [o, setO] = useState<PreAdminOrder | null>(null);
  const [staff, setStaff] = useState<Staffer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [moving, setMoving] = useState(false);
  const move = useMover(T); const cancel = useCanceller(T);
  const reload = useCallback(() => pre.order(id).then((r) => { setO(r); setError(null); }).catch((e) => setError(preError(e, T))), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { pre.staff().then(setStaff).catch(() => undefined); }, []);
  const row = o?.preorder ?? null;

  const after = async (okText?: string) => { if (okText) toast('success', T(okText)); await reload(); onChanged(); };
  const act = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    try { await fn(); await after(okText); } catch (e) { toast('error', preError(e, T)); } finally { setBusy(false); }
  };
  const go = async (to: OrderStatus) => { setBusy(true); try { if (await move(id, to, note.trim() || undefined)) { setNote(''); await after('Order updated'); } } finally { setBusy(false); } };
  const tick = (line: number | null, checked: boolean) => act(async () => { const r = await pre.prep(id, line, checked); setO((p) => (p ? { ...p, preorder: r } : p)); }, checked ? 'Ticked' : 'Un-ticked');
  const m = row ? nextMove(row.status) : null;
  const canTick = !!row && ['confirmed', 'preparing', 'packed'].includes(row.status);
  const allTicked = !!row && row.prep.total > 0 && row.prep.checked >= row.prep.total;

  return (
    <Drawer title={o ? o.order_no : T('Preorder')} sub={o ? `${T('Ordered')} ${dateTimeFmt(o.created_at)}` : undefined} onClose={onClose}>
      {error && <Banner tone="bad">{error}</Banner>}
      {!o ? <Skeleton h={220} /> : !row ? <Banner tone="info">{T('This is not a preorder.')} <Link to={`/shop-admin?order=${o.id}`}>{T('Open it in the Online shop page')}</Link></Banner> : (
        <div className="col gap-12" data-testid="preorder-drawer">
          <div className="row wrap gap-6"><StatusPill s={row.status} kind={row.cancel_kind} /><PayPill code={row.pay_code} /><FlagPills flags={row.flags} max={6} />{row.reschedule_count > 0 && <Badge>{T('Moved {n}×', { n: row.reschedule_count })}</Badge>}</div>
          {row.flags.includes('unpaid_soon') && <Banner tone="warn">{T('Payment has not been verified.')} <Link to="/payment-review">{T('Open Payment review')}</Link> · <span className="mono">{o.invoice.invoice_no}</span></Banner>}

          <div className="card card-b col gap-6">
            <div className="row gap-8"><CalendarClock size={18} aria-hidden /><b data-testid="drawer-when">{whenOf(row.pickup_at, lang)}</b><span className="muted">{untilText(row.pickup_at, T).text}</span>
              {['new', 'confirmed', 'preparing'].includes(row.status) && <Button size="sm" variant="ghost" onClick={() => setMoving(true)} data-testid="drawer-move">{T('Change time')}</Button>}</div>
            <div className="row gap-8"><User size={16} aria-hidden /><b>{row.contact_name}</b><a href={`tel:${row.contact_phone}`} className="row gap-4"><Phone size={14} aria-hidden /> {row.contact_phone}</a></div>
            {row.note && <div className="po-note" data-testid="drawer-note"><small className="muted">{T('Customer instructions')}</small><div>{row.note}</div></div>}
            <Field label={T('Assigned to')}>
              <Select value={row.assigned_to ?? ''} disabled={busy || !ACTIVE.includes(row.status)} aria-label={T('Assigned to')} onChange={(e) => act(() => pre.assign(id, e.target.value || null), 'Assignment saved')}>
                <option value="">{T('Nobody yet')}</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>

          <div className="col gap-6">
            <div className="row between"><b>{T('Items to prepare')}</b><span className="muted">{T('{n} items', { n: row.units })} · {money(row.total)}</span></div>
            <Checklist row={row} disabled={!canTick} busy={busy} onToggle={(l, c) => tick(l, c)} />
            {canTick && !allTicked && <Button size="sm" variant="soft" disabled={busy} onClick={() => tick(null, true)}>{T('Tick everything')}</Button>}
          </div>

          {ACTIVE.includes(row.status) && (
            <div className="col gap-8">
              <Field label={T('Message to the customer (optional)')}><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="row wrap">
                {m && <Button variant="primary" loading={busy} disabled={busy || (m.to === 'ready' && !allTicked)} data-testid="drawer-next" onClick={() => go(m.to)}>{T(m.label)}</Button>}
                {m?.to === 'ready' && !allTicked && <span className="muted">{T('Tick every item first')}</span>}
                <Button variant="danger" disabled={busy} onClick={async () => { if (await cancel(row)) await after('Order cancelled'); }}>{T(row.status === 'new' ? 'Reject preorder' : 'Cancel preorder')}</Button>
              </div>
            </div>
          )}
          {o.status_note && <div className="muted">{T('Message shown to the customer')}: {o.status_note}</div>}

          <div><b>{T('What the customer and staff were told')}</b>
            <ul className="col gap-4 po-notices">{(o.notices ?? []).map((n, i) => (
              <li key={i}><small className="muted">{dateTimeFmt(n.at)}</small> <Badge>{n.audience === 'customer' ? T('Customer') : T('Staff')}</Badge> <span>{n.text_th ?? n.kind}</span> {n.line && <Badge tone={n.line === 'sent' ? 'good' : n.line === 'dead' ? 'bad' : n.line === 'failed' ? 'warn' : ''}>LINE: {n.line}</Badge>}</li>))}
              {!o.notices?.length && <li className="muted">{T('Nothing yet')}</li>}</ul></div>
          <div><b>{T('History')}</b>
            <ul className="col gap-4" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{(o.events ?? []).map((e, i) => <li key={i} style={{ fontSize: 12.5 }}>{dateTimeFmt(e.at)} · {e.action}{typeof e.detail?.to === 'string' ? ` → ${e.detail.to}` : ''}{typeof e.detail?.pickup_to === 'string' ? ` → ${whenOf(e.detail.pickup_to, lang)}` : ''}{e.actor_email ? ` · ${e.actor_email}` : ''}{e.detail?.reason ? ` · ${String(e.detail.reason)}` : ''}</li>)}</ul></div>
          <Link to={`/shop-admin?order=${o.id}`} className="muted">{T('Open it in the Online shop page')}</Link>
        </div>
      )}
      {moving && row && <RescheduleModal row={row} onClose={() => setMoving(false)} onDone={() => { setMoving(false); void after(); }} />}
    </Drawer>
  );
}

export function Section({ title, hint, children, actions }: { title: ReactNode; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className="po-section"><div className="row between"><h2>{title}</h2>{actions}</div>{hint && <div className="muted">{hint}</div>}{children}</section>;
}
export { addDays };
