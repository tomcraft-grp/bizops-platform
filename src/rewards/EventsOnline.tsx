// Back office, Events, "Online shop" tab: the events of the online shop and their three shared number boards. Everything here is read from, and decided by, the database
// (SECURITY DEFINER functions that re-check the role): the screen shows what the server answered, never a guess, and keeps itself current by reading the three board
// revisions every 5 s while this tab is open and the page is visible, reloading only a board whose revision changed.
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import { cx } from '../lib/util';
import { Badge, Banner, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Skeleton, Textarea } from '../ui/kit';
import { isRewardsError, rewards, rewardsAdmin, type AdminBoard, type Board, type EventDoc, type EventPatch, type EventStatus, type ReviewItem, type Rule } from './api';
import BoardAdmin, { BoardStyles, ReasonForm, useT, type TFn } from './BoardAdmin';
import {
  acceptBoard, changedBoardIds, emptyEventForm, eventPatchFor, eventStatusChanged, formFromEvent, isForbidden, LOCK_LABEL, mayEditEvents, mayOperate, MODE_LABEL, opErrorText, padNumber, POLL_MS, rangeLocked, ruleSummary, shouldPoll,
  STATUS_LABEL, statusActions, validateEventForm, whenText, windowState, WINDOW_LABEL, type EventForm, type FormErrorKey,
} from './boardView';

const STATUS_TONE: Record<EventStatus, 'good' | 'warn' | 'info' | ''> = { draft: 'info', active: 'good', paused: 'warn', closed: '' };

export default function EventsOnline({ active = true }: { active?: boolean }) {
  const T = useT();
  const { profile } = useAuth();
  const role = profile?.role;
  const [events, setEvents] = useState<EventDoc[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noAccess, setNoAccess] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [admin, setAdmin] = useState<Record<string, AdminBoard>>({});
  const [boardError, setBoardError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewItem[] | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [boardsOn, setBoardsOn] = useState<boolean | null>(null);
  const [denied, setDenied] = useState(false);               // the server refused a Super Admin action: the controls are hidden until the page is reloaded
  const canEdit = mayEditEvents(role);                         // Admin and Super Admin edit events and boards (the server decides again, and says so when it refuses)
  const canClose = mayOperate(role) && !denied;                // closing an event is for a Super Admin
  const [live, setLive] = useState(true);
  const [form, setForm] = useState<'new' | 'edit' | null>(null);
  const known = useRef<Record<string, number>>({});          // the newest revision we hold per board; a poll reloads a board only when the server's differs
  const statusRef = useRef<EventStatus | null>(null);
  const boardsOffSince = useRef(0);                          // when the server last said BOARDS_OFF (0 = it has not): kept across the polling effect's re-runs
  const pollBusy = useRef(false);                            // a revision request is on its way: shared by every run of the polling effect, so a re-run never starts a second one

  const ev = events?.find((e) => e.id === eventId) ?? null;
  const board = ev?.boards.find((b) => b.id === boardId) ?? null;
  statusRef.current = ev?.status ?? null;

  // ---------------------------------------------------------------------------------------- what we hold, always the server's answer
  const applyBoard = useCallback((b: Board) => {
    setEvents((es) => es && es.map((e) => (e.id !== b.event_id ? e : { ...e, boards: e.boards.map((x) => (x.id === b.id && acceptBoard(x, b) ? b : x)) })));
    if (known.current[b.id] === undefined || b.rev >= known.current[b.id]) known.current[b.id] = b.rev;
  }, []);
  const applyAdmin = useCallback((ab: AdminBoard) => {
    setAdmin((m) => (m[ab.board.id] && !acceptBoard(m[ab.board.id].board, ab.board) ? m : { ...m, [ab.board.id]: ab }));
    applyBoard(ab.board);
  }, [applyBoard]);
  /** a rename / recolour: the board the server returned replaces the one in the card and in the open board */
  const applyBoardInfo = useCallback((b: Board) => {
    setAdmin((m) => (m[b.id] && acceptBoard(m[b.id].board, b) ? { ...m, [b.id]: { ...m[b.id], board: b } } : m));
    applyBoard(b);
  }, [applyBoard]);
  const applyEvent = useCallback((doc: EventDoc) => {
    setEvents((es) => (es ? (es.some((e) => e.id === doc.id) ? es.map((e) => (e.id === doc.id ? doc : e)) : [...es, doc]) : [doc]));
    for (const b of doc.boards) if (known.current[b.id] === undefined) known.current[b.id] = b.rev;
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const list = await rewardsAdmin.events();
      setEvents(list); setLoadError(null); setNoAccess(false);
      for (const e of list) for (const b of e.boards) if (known.current[b.id] === undefined) known.current[b.id] = b.rev;
      setEventId((cur) => (cur && list.some((e) => e.id === cur) ? cur : (list.find((e) => e.status === 'active') ?? list[list.length - 1])?.id ?? null));
    } catch (e) { if (isForbidden(e)) setNoAccess(true); else setLoadError(T(opErrorText(e))); setEvents((cur) => cur ?? []); }
  }, [T]);
  const loadReview = useCallback(() => { rewardsAdmin.reviewQueue().then((r) => { setReview(r); setReviewError(null); }).catch((e) => setReviewError(T(opErrorText(e)))); }, [T]);
  const loadBoard = useCallback((id: string) => { rewardsAdmin.board(id).then((ab) => { applyAdmin(ab); setBoardError(null); }).catch((e) => setBoardError(T(opErrorText(e)))); }, [applyAdmin, T]);

  useEffect(() => {
    void loadEvents(); loadReview();
    rewards.settings().then((s) => setBoardsOn(s.boards_enabled)).catch(() => undefined);
    rewardsAdmin.rules().then(setRules).catch(() => undefined);
  }, []);                                                      // eslint-disable-line react-hooks/exhaustive-deps
  const boardKey = ev?.boards.map((b) => b.id).join(',') ?? '';
  useEffect(() => { if (ev) setBoardId((cur) => (cur && ev.boards.some((b) => b.id === cur) ? cur : ev.boards[0]?.id ?? null)); }, [ev?.id, boardKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (boardId && !admin[boardId]) loadBoard(boardId); }, [boardId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------------------- every 5 s: three integers, reload only what changed
  useEffect(() => {
    if (!eventId) return;
    let stop = false, fails = 0;
    const tick = async () => {
      if (!shouldPoll({ active, docHidden: document.hidden, eventId, inFlight: pollBusy.current })) return;
      // While the boards are switched off the server refuses this call (BOARDS_OFF) by design: staff may set everything up before the switch is turned on. That is not a connection
      // problem, so there is no warning and no 5-second hammering: ask again once a minute (the switch may have been turned on in another tab).
      if (boardsOffSince.current && Date.now() - boardsOffSince.current < 60_000) return;
      pollBusy.current = true;
      try {
        const revs = await rewards.boardRevs(eventId);
        if (stop) return;
        fails = 0; boardsOffSince.current = 0; setLive(true);
        if (eventStatusChanged(statusRef.current, revs)) await loadEvents();
        const ids = changedBoardIds(known.current, revs);
        for (const id of ids) { const ab = await rewardsAdmin.board(id); if (stop) return; applyAdmin(ab); }
        if (ids.length && !stop) loadReview();
      } catch (e) {
        if (stop) return;
        if (isRewardsError(e, 'BOARDS_OFF', 'REWARDS_OFF')) { boardsOffSince.current = Date.now(); fails = 0; setLive(true); }
        else if (++fails >= 2) setLive(false);
      }
      finally { pollBusy.current = false; }
    };
    void tick();                                               // read once now (a different event may have been opened: what we hold for it can be old), then every 5 s
    const h = setInterval(() => void tick(), POLL_MS);
    const visible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', visible);
    return () => { stop = true; clearInterval(h); document.removeEventListener('visibilitychange', visible); };
  }, [eventId, active, applyAdmin, loadEvents, loadReview]);

  // ---------------------------------------------------------------------------------------- render
  const linked = rules.filter((r) => r.kind === 'board_pick' && ev && r.event_id === ev.id);
  const outside = ev && ev.status === 'active' && windowState(ev) !== 'open' && windowState(ev) !== 'always';
  return (
    <>
      <BoardStyles />
      <PageHead title={T('Events — online shop')} desc={T('Number boards for online-shop customers. The database decides who gets a number, so two customers can never hold the same exclusive number, whatever a screen shows.')}
        actions={events && events.length > 0 ? <>
          <Select sm aria-label={T('Event')} style={{ width: 'auto' }} value={eventId ?? ''} onChange={(e) => { setEventId(e.target.value); setBoardId(null); }}>
            {events.map((x) => <option key={x.id} value={x.id}>{x.name} ({T(STATUS_LABEL[x.status])})</option>)}
          </Select>
          {canEdit && <Button onClick={() => setForm('new')}><Plus size={15} />{' '}{T('New event')}</Button>}
        </> : undefined} />
      <div className="mb16"><Banner tone="warn"><b>{T('Legal review required before launch.')}</b>{' '}{T('Purchase-linked prize events can fall under Thai gambling / lottery and consumer-promotion rules. Eligibility, prize and marketing terms must be approved by qualified counsel; this prototype only demonstrates the mechanics.')}</Banner></div>
      {boardsOn === false && <div className="mb16"><Banner>{T('Event boards are switched off, so customers cannot see them yet. You can set everything up now; boards stay hidden from customers until a Super Admin switches them on.')}</Banner></div>}
      {!live && <div className="mb16"><Banner tone="warn">{T('Live updates are paused because the connection is failing. Retrying; what you see may be out of date.')}</Banner></div>}
      {noAccess && <Banner tone="bad">{T('You do not have access to the online-shop events. Ask a Super Admin if you need it.')}</Banner>}
      {loadError && <div className="mb16"><Banner tone="bad">{loadError}{' '}<Button size="sm" onClick={() => void loadEvents()}>{T('Try again')}</Button></Banner></div>}

      {!events && !noAccess && !loadError && <Skeleton h={180} />}
      {events && events.length === 0 && !noAccess && !loadError && (
        <Card><Empty title={T('No events yet')} hint={canEdit ? T('Create an event to open three number boards for customers.') : undefined}
          action={canEdit ? <Button variant="primary" onClick={() => setForm('new')}><Plus size={15} />{' '}{T('New event')}</Button> : undefined} /></Card>
      )}

      {ev && (
        <div className="col gap-16">
          {outside && <Banner tone="warn">{T('This event is active, but its dates are not running now, so customers cannot pick numbers.')}</Banner>}
          <EventCard ev={ev} canEdit={canEdit} canClose={canClose} linked={linked} T={T} onEdit={() => setForm('edit')} onDoc={applyEvent} />
          <div className="bo-cards" role="group" aria-label={T('Boards')}>
            {ev.boards.map((b) => (
              <button key={b.id} type="button" className={cx('bo-card', b.id === boardId && 'on')} aria-pressed={b.id === boardId} onClick={() => setBoardId(b.id)}>
                <span className="row between"><span className="row gap-6"><i className="ch-dot" style={{ background: b.color, width: 12, height: 12 }} /><b>{b.name}</b></span><span className="muted" style={{ fontSize: 11.5 }}>{T('rev {rev}', { rev: b.rev })}</span></span>
                <span className="row gap-6 wrap"><Badge tone="info">{T(MODE_LABEL[b.mode])}</Badge><Badge tone={b.state === 'locked' ? 'warn' : 'good'} dot>{T(LOCK_LABEL[b.state])}</Badge></span>
                <span><b style={{ fontSize: 20 }}>{b.taken}</b><span className="muted"> / {b.total} {T('taken')}</span></span>
              </button>
            ))}
          </div>
          {board && admin[board.id]
            ? <BoardAdmin key={board.id} event={ev} admin={admin[board.id]} role={role} denied={denied} review={review} reviewError={reviewError} canEditBoard={canEdit} onBoard={applyAdmin} onReview={setReview} onDenied={() => setDenied(true)} onBoardInfo={(b) => { applyBoardInfo(b); loadBoard(b.id); }} />
            : boardError ? <Banner tone="bad">{boardError}{' '}<Button size="sm" onClick={() => board && loadBoard(board.id)}>{T('Try again')}</Button></Banner> : <Skeleton h={260} />}
        </div>
      )}

      {form && <EventFormModal title={form === 'new' ? T('New event') : T('Edit event')} initial={form === 'edit' && ev ? formFromEvent(ev) : emptyEventForm()} editing={form === 'edit' ? ev : null} lockRange={form === 'edit' && ev ? rangeLocked(role, ev) : false} T={T} onClose={() => setForm(null)}
        onSave={async (patch) => { const doc = await rewardsAdmin.saveEvent(form === 'edit' && ev ? ev.id : null, patch); applyEvent(doc); setEventId(doc.id); if (form === 'new') setBoardId(null); toast('success', form === 'new' ? T('Event created as a draft') : T('Event saved')); setForm(null); }} />}
    </>
  );
}

// ================================================================================================ one event: facts, status, rules
/** The sentence for a failed event call: a refusal here is about editing events, not about the Super Admin board operations. */
const eventErrorText = (e: unknown, T: TFn) => (isForbidden(e) ? T('The server refused this change. Some changes (closing an event, changing the number range once numbers are taken) need a Super Admin.') : T(opErrorText(e)));
function Prop({ label, children }: { label: string; children: ReactNode }) {
  return <div><div className="muted" style={{ fontSize: 12 }}>{label}</div><div style={{ fontWeight: 600 }}>{children}</div></div>;
}
function EventCard({ ev, canEdit, canClose, linked, T, onEdit, onDoc }: { ev: EventDoc; canEdit: boolean; canClose: boolean; linked: Rule[]; T: TFn; onEdit: () => void; onDoc: (d: EventDoc) => void }) {
  const [to, setTo] = useState<EventStatus | null>(null);         // the status change whose inline reason field is open
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const win = windowState(ev);
  const range = `${padNumber(ev.number_min, ev.number_max)}–${padNumber(ev.number_max, ev.number_max)}`;
  const actions = statusActions(ev.status, canClose);
  const change = async (status: EventStatus, reason: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { onDoc(await rewardsAdmin.setEventStatus(ev.id, status, reason)); setTo(null); toast('success', T('Event status changed')); }
    catch (e) { setErr(eventErrorText(e, T)); }
    finally { setBusy(false); }
  };
  return (
    <Card title={ev.name} sub={ev.description ?? undefined} actions={canEdit ? <Button size="sm" onClick={onEdit}><Pencil size={13} />{' '}{T('Edit event')}</Button> : undefined}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
        <Prop label={T('Status')}><span className="row gap-6 wrap"><Badge tone={STATUS_TONE[ev.status]} dot>{T(STATUS_LABEL[ev.status])}</Badge>{win !== 'always' && <Badge tone={win === 'open' ? 'good' : win === 'before' ? 'info' : 'bad'}>{T(WINDOW_LABEL[win])}</Badge>}</span></Prop>
        <Prop label={T('Dates')}>{ev.starts_at || ev.ends_at ? `${ev.starts_at ? whenText(ev.starts_at) : '…'} → ${ev.ends_at ? whenText(ev.ends_at) : '…'}` : T('No date limit')}</Prop>
        <Prop label={T('Numbers')}>{range} · {T('{n} numbers', { n: ev.number_max - ev.number_min + 1 })}</Prop>
        <Prop label={T('Hold before a pick is final')}>{ev.hold_minutes > 0 ? T('{n} min', { n: ev.hold_minutes }) : T('Final at once')}</Prop>
        <Prop label={T('Max per customer')}>{ev.max_per_customer != null ? ev.max_per_customer : T('No limit')}</Prop>
      </div>
      <div className="mt16"><b>{T('Pick rules for this event')}</b>
        {linked.length === 0
          ? <div className="muted">{T('No pick rule is linked to this event yet. Add one in Promotions (Online shop tab).')}</div>
          : linked.map((r) => { const s = ruleSummary(r); return <div key={r.id} className="row gap-6 wrap text2"><span>{r.name}: {T(s.key, s.vars)}</span>{!r.active && <Badge>{T('Off')}</Badge>}</div>; })}
      </div>
      {canEdit && actions.length > 0 && (
        <div className="mt16">
          {to === null
            ? <div className="row wrap">{actions.map((a) => <Button key={a.to} variant={a.danger ? undefined : a.to === 'active' ? 'primary' : undefined} onClick={() => { setTo(a.to); setErr(null); }}>{T(a.label)}…</Button>)}</div>
            : <div style={{ maxWidth: 420 }}>
                <div className="text2 mb8">{T('Event status will be {status}.', { status: T(STATUS_LABEL[to]) })}</div>
                <ReasonForm confirmLabel={T(actions.find((a) => a.to === to)?.label ?? 'Confirm')} danger={to === 'closed'} busy={busy} error={err} onCancel={() => setTo(null)} onSubmit={(r) => void change(to, r)} />
              </div>}
        </div>
      )}
    </Card>
  );
}

// ================================================================================================ the event form
function EventFormModal({ title, initial, editing, lockRange, T, onClose, onSave }: { title: string; initial: EventForm; editing: EventDoc | null; lockRange: boolean; T: TFn; onClose: () => void; onSave: (patch: EventPatch) => Promise<void> }) {
  const [f, setF] = useState<EventForm>(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rangeErr, setRangeErr] = useState<string | null>(null);   // the server's own words when it refuses a range (a number that is held would fall outside it)
  const v = validateEventForm(f);
  const errors: Partial<Record<FormErrorKey, string>> = tried && !v.ok ? v.errors : {};
  const set = (k: keyof EventForm) => (e: { target: { value: string } }) => { if (k === 'min' || k === 'max') setRangeErr(null); setF({ ...f, [k]: e.target.value }); };
  const bad = (k: FormErrorKey, hint?: string): ReactNode => (errors[k] ? <span className="bo-err">{T(errors[k] as string)}</span> : hint);
  const rangeHint: ReactNode = errors.range ? <span className="bo-err">{T(errors.range)}</span> : rangeErr ? <span className="bo-err">{rangeErr}</span> : lockRange ? T('Only a Super Admin can change the number range once numbers are taken.') : undefined;
  const save = async () => {
    setTried(true);
    if (!v.ok || busy) return;
    const patch = eventPatchFor(editing, v.patch);               // an edit sends only what changed
    if (editing && Object.keys(patch).length === 0) { onClose(); return; }
    setBusy(true); setErr(null); setRangeErr(null);
    try { await onSave(patch); }
    catch (e) { if (isRewardsError(e, 'NUMBER_OUT_OF_RANGE')) setRangeErr(T(opErrorText(e))); else setErr(eventErrorText(e, T)); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }} footer={<><Button onClick={onClose} disabled={busy}>{T('Cancel')}</Button><Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? T('Working…') : T('Save event')}</Button></>}>
      <div className="form-grid">
        <Field label={T('Name')} full hint={bad('name')}><Input autoFocus value={f.name} onChange={set('name')} maxLength={120} /></Field>
        <Field label={T('Description')} full><Textarea value={f.description} onChange={set('description')} maxLength={500} /></Field>
        <Field label={T('Starts (Bangkok time)')} hint={bad('window', T('Leave empty for no start date.'))}><Input type="datetime-local" value={f.startsAt} onChange={set('startsAt')} /></Field>
        <Field label={T('Ends (Bangkok time)')}><Input type="datetime-local" value={f.endsAt} onChange={set('endsAt')} /></Field>
        <Field label={T('Number from')} hint={rangeHint}><Input type="number" inputMode="numeric" min={0} step={1} value={f.min} onChange={set('min')} disabled={lockRange} /></Field>
        <Field label={T('Number to')}><Input type="number" inputMode="numeric" min={0} step={1} value={f.max} onChange={set('max')} disabled={lockRange} /></Field>
        <Field label={T('Hold minutes')} hint={bad('hold', T('0 makes a pick final at once.'))}><Input type="number" inputMode="numeric" min={0} step={1} value={f.hold} onChange={set('hold')} /></Field>
        <Field label={T('Max picks per customer')} hint={bad('maxPer', T('Leave empty for no limit.'))}><Input type="number" inputMode="numeric" min={1} step={1} value={f.maxPer} onChange={set('maxPer')} /></Field>
      </div>
      {err && <div className="mt8"><Banner tone="bad">{err}</Banner></div>}
    </Modal>
  );
}
