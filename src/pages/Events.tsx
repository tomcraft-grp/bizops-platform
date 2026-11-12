import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Crown, Pause, Play, Plus, Printer, RotateCcw, Square } from 'lucide-react';
import { useDB } from '../domain/store';
import { claimNumber, createEvent, eventStats, occupancy, pad2, recordWinner, releaseSelection, resetBoard, resetEvent, setEventStatus } from '../domain/events';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, KV, Kpi, Modal, NumInput, PageHead, Select, Seg, Tabs, Textarea, useConfirm, useHas, useRun } from '../ui/kit';
import { usePrintDoc } from '../ui/shared';
import { cx, dateTimeFmt, money0 } from '../lib/util';
import type { EventDoc, ID } from '../domain/types';
import { OrderDrawer } from './OrderDetail';

export default function Events() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const print = usePrintDoc();
  const canEdit = useHas('events:edit');
  const canReset = useHas('events:reset');
  const canCreate = useHas('events:create');
  const [sp, setSp] = useSearchParams();
  const evId = sp.get('e') ?? db.events.find((e) => e.status === 'active')?.id ?? db.events[db.events.length - 1]?.id;
  const ev = db.events.find((e) => e.id === evId);
  const [boardId, setBoardId] = useState<ID>('');
  const [tab, setTab] = useState<'board' | 'entitlements' | 'history' | 'log'>('board');
  const [pick, setPick] = useState<number | null>(null);
  const [create, setCreate] = useState(false);
  const [winner, setWinner] = useState(false);
  const [order, setOrder] = useState<ID | null>(null);
  const nowIso = new Date().toISOString();
  const board = ev?.boards.find((b) => b.id === boardId) ?? ev?.boards[0];
  const occ = useMemo(() => (ev && board ? occupancy(db, ev.id, board.id, nowIso) : {}), [db.selections, ev?.id, board?.id]); // eslint-disable-line
  const stats = useMemo(() => (ev ? eventStats(db, ev.id, nowIso) : null), [db.selections, db.entitlements, ev?.id]); // eslint-disable-line

  if (!ev || !board || !stats) return (<><PageHead title="Events" actions={canCreate && <Button variant="primary" onClick={() => setCreate(true)}>New event</Button>} /><Card><Empty title="No events yet" /></Card>{create && <NewEvent onClose={() => setCreate(false)} />}</>);
  const sel = pick != null ? occ[pick] : undefined;
  const selections = db.selections.filter((s) => s.eventId === ev.id).slice().reverse();
  const ents = db.entitlements.filter((e) => e.eventId === ev.id).slice().reverse();
  const customersWith = db.customers.filter((c) => db.entitlements.some((e) => e.eventId === ev.id && e.customerId === c.id && e.status === 'available'));

  return (
    <>
      <PageHead title="Events — number selection" desc="Purchase-linked picks on boards of numbers 00–99. Claims are protected by a unique (event, board, number) constraint, so two customers can never hold the same number — whatever the screen shows."
        actions={<>
          <Select sm aria-label="Event" style={{ width: 'auto' }} value={ev.id} onChange={(e) => setSp({ e: e.target.value })}>{db.events.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.status})</option>)}</Select>
          {canCreate && <Button onClick={() => setCreate(true)}><Plus size={15} /> New event</Button>}
        </>} />
      <div className="mb16"><Banner tone="warn"><b>Legal review required before launch.</b> Purchase-linked prize events can fall under Thai gambling / lottery and consumer-promotion rules. Eligibility, prize and marketing terms must be approved by qualified counsel; this prototype only demonstrates the mechanics.</Banner></div>
      <div className="grid g4 mb16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Kpi label="Status" value={<Badge tone={ev.status === 'active' ? 'good' : ev.status === 'paused' ? 'warn' : ''} dot>{ev.status}</Badge>} sub={`${ev.boards.length} boards · ${pad2(ev.min)}–${pad2(ev.max)}`} />
        <Kpi label="Numbers taken" value={`${stats.taken}/${stats.total}`} sub={`${stats.available} available`} />
        <Kpi label="Picks issued" value={stats.issued} sub={`${stats.used} used · ${stats.issued - stats.used} open`} />
        <Kpi label="Participants" value={stats.participants} sub="customers with entitlements" />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'board', label: 'Boards' }, { v: 'entitlements', label: 'Entitlements', count: ents.length }, { v: 'history', label: 'Selection history', count: selections.length }, { v: 'log', label: 'Admin log' }]} />

      {tab === 'board' && (
        <div className="grid g-main">
          <Card title={<span className="row gap-6"><i className="ch-dot" style={{ background: board.color, width: 12, height: 12 }} />{board.name}</span>} sub={`${Object.keys(occ).length} of ${ev.max - ev.min + 1} numbers taken`}
            actions={<Seg value={board.id} onChange={setBoardId} options={ev.boards.map((b) => ({ v: b.id, label: b.name }))} />}>
            <div className="number-grid" role="group" aria-label={`${board.name} numbers`}>
              {Array.from({ length: ev.max - ev.min + 1 }, (_, i) => ev.min + i).map((n) => {
                const s = occ[n];
                const mine = s && ev.winners.some((w) => w.boardId === board.id && w.number === n);
                return (
                  <button key={n} className={cx('num-cell', s?.status === 'confirmed' && 'taken', s?.status === 'reserved' && 'reserved', mine && 'mine', pick === n && 'sel')}
                    onClick={() => setPick(n)} title={s ? `${db.customers.find((c) => c.id === s.customerId)?.name} (${s.status})` : 'Available'} aria-label={`Number ${pad2(n)} ${s ? s.status : 'available'}`}>{pad2(n)}</button>
                );
              })}
            </div>
            <div className="legend mt16"><span><i style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />Available</span><span><i style={{ background: 'var(--surface-3)' }} />Taken (confirmed)</span><span><i style={{ background: 'var(--warn-soft)', border: '1px dashed var(--warn)' }} />Reserved (expires)</span><span><i style={{ background: 'var(--brand)' }} />Winner</span></div>
          </Card>
          <div className="col gap-16">
            <Card title="Event controls">
              <div className="col">
                <div className="row wrap">
                  {canEdit && ev.status === 'draft' && <Button variant="primary" onClick={() => run((d, c) => setEventStatus(d, c, ev.id, 'active'), { ok: 'Event is live' })}><Play size={14} /> Activate</Button>}
                  {canEdit && ev.status === 'active' && <Button onClick={() => run((d, c) => setEventStatus(d, c, ev.id, 'paused'), { ok: 'Event paused' })}><Pause size={14} /> Pause</Button>}
                  {canEdit && ev.status === 'paused' && <Button variant="primary" onClick={() => run((d, c) => setEventStatus(d, c, ev.id, 'active'), { ok: 'Event resumed' })}><Play size={14} /> Resume</Button>}
                  {canEdit && ev.status !== 'closed' && ev.status !== 'draft' && <Button onClick={async () => { const x = await confirm({ title: 'Close this event?', body: 'No further picks are possible. Selection history and winners are kept.', confirmLabel: 'Close event' }); if (x.ok) run((d, c) => setEventStatus(d, c, ev.id, 'closed'), { ok: 'Event closed' }); }}><Square size={14} /> Close</Button>}
                  <Button onClick={() => print.open('event_report', ev.id)}><Printer size={14} /> Report</Button>
                </div>
                {canEdit && <Button onClick={() => setWinner(true)}><Crown size={14} /> Record winner</Button>}
                {canReset ? (
                  <div className="row wrap">
                    <Button variant="danger" size="sm" onClick={async () => { const x = await confirm({ title: `Reset ${board.name}?`, body: 'All numbers on this board are released and picks returned to customers. History is preserved.', reason: true, typeToConfirm: 'RESET', danger: true, confirmLabel: 'Reset board' }); if (x.ok) run((d, c) => resetBoard(d, c, ev.id, board.id, x.reason), { ok: 'Board reset (audited)', perm: 'events:reset' }); }}><RotateCcw size={13} /> Reset board</Button>
                    <Button variant="danger" size="sm" onClick={async () => { const x = await confirm({ title: 'Reset the whole event?', body: 'Every board is cleared and winners removed. Previous selections stay in history.', reason: true, typeToConfirm: 'RESET', danger: true, confirmLabel: 'Reset event' }); if (x.ok) run((d, c) => resetEvent(d, c, ev.id, x.reason), { ok: 'Event reset (audited)', perm: 'events:reset' }); }}><RotateCcw size={13} /> Reset event</Button>
                  </div>
                ) : <div className="muted" style={{ fontSize: 12 }}>Only authorized administrators can reset boards or events.</div>}
              </div>
            </Card>
            <Card title="Winners">
              {ev.winners.length ? ev.winners.map((w) => <div key={w.id} className="row between" style={{ fontSize: 13, padding: '3px 0' }}><span><b>{ev.boards.find((b) => b.id === w.boardId)?.name} #{pad2(w.number)}</b> — {w.prize}</span><span>{w.customerId ? db.customers.find((c) => c.id === w.customerId)?.name : <Badge>unclaimed</Badge>}</span></div>) : <div className="muted">No winners recorded.</div>}
            </Card>
            <Card title="Rules"><div className="muted" style={{ fontSize: 13 }}>{ev.terms}</div><div className="muted mt8" style={{ fontSize: 12 }}>Reservation hold: {ev.reservationMinutes} min · Entitlements come from promotions (see Promotions → “Lucky Draw”).</div></Card>
          </div>
        </div>
      )}

      {tab === 'entitlements' && (
        <Card flush><DataTable rows={ents} rowKey={(e) => e.id} pageSize={12} search={(e) => db.customers.find((c) => c.id === e.customerId)?.name ?? ''}
          cols={[
            { key: 'd', header: 'Granted', render: (e) => dateTimeFmt(e.ts) }, { key: 'c', header: 'Customer', render: (e) => db.customers.find((c) => c.id === e.customerId)?.name },
            { key: 'o', header: 'From order', render: (e) => (e.orderId ? <Button size="sm" variant="ghost" onClick={() => setOrder(e.orderId!)}>{db.orders.find((o) => o.id === e.orderId)?.no}</Button> : <span className="muted">manual</span>) },
            { key: 's', header: 'Status', render: (e) => <Badge tone={e.status === 'available' ? 'info' : e.status === 'used' ? 'good' : 'bad'} dot>{e.status}</Badge> },
            { key: 'n', header: 'Number', render: (e) => { const s = db.selections.find((x) => x.id === e.selectionId); return s ? `${ev.boards.find((b) => b.id === s.boardId)?.name} #${pad2(s.number)}` : '–'; } },
          ]} /></Card>
      )}
      {tab === 'history' && (
        <Card flush><DataTable rows={selections} rowKey={(s) => s.id} pageSize={12}
          cols={[
            { key: 'd', header: 'When', render: (s) => dateTimeFmt(s.ts) }, { key: 'b', header: 'Board / No.', render: (s) => <b>{ev.boards.find((b) => b.id === s.boardId)?.name} #{pad2(s.number)}</b> }, { key: 'c', header: 'Customer', render: (s) => db.customers.find((c) => c.id === s.customerId)?.name },
            { key: 's', header: 'Status', render: (s) => <Badge tone={s.status === 'confirmed' ? 'good' : s.status === 'reserved' ? 'warn' : 'bad'} dot>{s.status}</Badge> },
            { key: 'r', header: 'Note', render: (s) => <>{s.releaseReason ?? ''}{s.onBehalfBy ? ` (entered by ${db.users.find((u) => u.id === s.onBehalfBy)?.name})` : ''}</> },
          ]} /></Card>
      )}
      {tab === 'log' && (
        <Card flush><DataTable rows={db.eventActions.filter((a) => a.eventId === ev.id).slice().reverse()} rowKey={(a) => a.id} pageSize={12} empty={<Empty title="No admin actions yet" />}
          cols={[{ key: 'd', header: 'When', render: (a) => dateTimeFmt(a.ts) }, { key: 'u', header: 'By', render: (a) => db.users.find((u) => u.id === a.by)?.name }, { key: 'a', header: 'Action', render: (a) => <Badge tone={a.action.startsWith('reset') ? 'bad' : ''}>{a.action.replace('_', ' ')}</Badge> }, { key: 'n', header: 'Affected', num: true, render: (a) => a.affected }, { key: 'x', header: 'Detail', render: (a) => a.detail }]} /></Card>
      )}

      {pick != null && (
        <Modal title={`${board.name} · #${pad2(pick)}`} size="sm" onClose={() => setPick(null)} footer={sel && canEdit && ev.status !== 'closed' ? <Button variant="danger" onClick={async () => { const x = await confirm({ title: `Release ${board.name} #${pad2(pick)}?`, body: 'The number becomes available again and the customer gets the pick back.', reason: true, danger: true, confirmLabel: 'Release' }); if (x.ok) run((d, c) => releaseSelection(d, c, sel.id, x.reason), { ok: 'Number released', perm: 'events:edit', onOk: () => setPick(null) }); }}>Release number</Button> : undefined}>
          {sel ? (
            <KV items={[['Status', <Badge key="s" tone={sel.status === 'confirmed' ? 'good' : 'warn'} dot>{sel.status}</Badge>], ['Customer', db.customers.find((c) => c.id === sel.customerId)?.name], ['Selected', dateTimeFmt(sel.ts)],
              ['Order', (() => { const en = db.entitlements.find((e) => e.id === sel.entitlementId); const o = en?.orderId ? db.orders.find((x) => x.id === en.orderId) : undefined; return o ? <Button key="o" size="sm" variant="ghost" onClick={() => { setPick(null); setOrder(o.id); }}>{o.no}</Button> : 'manual entitlement'; })()],
              ...(sel.reservedUntil ? [['Reservation expires', dateTimeFmt(sel.reservedUntil)] as [string, string]] : [])]} />
          ) : (
            <PickForCustomer ev={ev} boardId={board.id} number={pick} customers={customersWith} disabled={ev.status !== 'active' || !canEdit} onDone={() => setPick(null)} />
          )}
        </Modal>
      )}
      {create && <NewEvent onClose={() => setCreate(false)} />}
      {winner && <WinnerModal ev={ev} onClose={() => setWinner(false)} />}
      {order && <OrderDrawer id={order} onClose={() => setOrder(null)} />}
      {print.node}
    </>
  );
}

function PickForCustomer({ ev, boardId, number, customers, disabled, onDone }: { ev: EventDoc; boardId: ID; number: number; customers: { id: ID; name: string }[]; disabled: boolean; onDone: () => void }) {
  const db = useDB();
  const run = useRun();
  const [cid, setCid] = useState('');
  return (
    <div className="col">
      <Badge tone="good">Available</Badge>
      {disabled && <Banner tone="warn">The event is {ev.status}; picks can only be entered while it is active.</Banner>}
      <Field label="Select on behalf of a customer" hint={customers.length ? 'Only customers with an unused entitlement are listed.' : 'No customer has an unused entitlement yet. Entitlements are earned by qualifying purchases.'}>
        <Select value={cid} onChange={(e) => setCid(e.target.value)} disabled={disabled}><option value="">Select…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name} — {db.entitlements.filter((e) => e.eventId === ev.id && e.customerId === c.id && e.status === 'available').length} unused</option>)}</Select>
      </Field>
      <Button variant="primary" disabled={!cid || disabled} onClick={() => run((d, c) => claimNumber(d, c, { eventId: ev.id, boardId, number, customerId: cid, confirm: true, onBehalf: true }), { ok: `#${pad2(number)} confirmed`, perm: 'events:edit', onOk: onDone })}>Confirm #{pad2(number)}</Button>
    </div>
  );
}

function NewEvent({ onClose }: { onClose: () => void }) {
  const run = useRun();
  const [f, setF] = useState({ name: '', description: '', boards: 3, min: 0, max: 99, reservationMinutes: 10, terms: '' });
  return (
    <Modal title="New event" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name} onClick={() => run((d, c) => createEvent(d, c, f), { ok: 'Event created as draft', perm: 'events:create', onOk: onClose })}>Create</Button></>}>
      <div className="form-grid">
        <Field label="Name" full><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Boards"><NumInput value={f.boards} onChange={(n) => setF({ ...f, boards: n })} /></Field>
        <Field label="Reservation hold (min)"><NumInput value={f.reservationMinutes} onChange={(n) => setF({ ...f, reservationMinutes: n })} /></Field>
        <Field label="Number from"><NumInput value={f.min} onChange={(n) => setF({ ...f, min: n })} /></Field>
        <Field label="Number to"><NumInput value={f.max} onChange={(n) => setF({ ...f, max: n })} /></Field>
        <Field label="Description" full><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Terms & prize rules" full><Textarea value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
function WinnerModal({ ev, onClose }: { ev: EventDoc; onClose: () => void }) {
  const run = useRun();
  const [b, setB] = useState(ev.boards[0].id);
  const [n, setN] = useState(0);
  const [prize, setPrize] = useState('');
  return (
    <Modal title="Record winning number" size="sm" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!prize} onClick={() => run((d, c) => recordWinner(d, c, { eventId: ev.id, boardId: b, number: n, prize }), { ok: 'Winner recorded', perm: 'events:edit', onOk: onClose })}>Save</Button></>}>
      <div className="col">
        <Field label="Board"><Select value={b} onChange={(e) => setB(e.target.value)}>{ev.boards.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Winning number"><NumInput value={n} onChange={(v) => setN(Math.max(ev.min, Math.min(ev.max, v || 0)))} /></Field>
        <Field label="Prize"><Input value={prize} onChange={(e) => setPrize(e.target.value)} /></Field>
        <div className="muted" style={{ fontSize: 12 }}>The system looks up who holds this number (if anyone). Unclaimed numbers are recorded as unclaimed.</div>
      </div>
    </Modal>
  );
}
export const _e = money0;
