// Back office: one event board. The 10 x 10 grid with the owners of the numbers, the five separate Super Admin operations (lock / unlock, switch mode, release one number,
// reset, undo reset), and the tabs History / Resets / Audit log / Needs review.
// The screen never decides anything: every operation is a server call that re-checks SUPER_ADMIN and needs a reason, and after it the screen shows the board the server
// returned. Only the reset has a confirmation panel (reason, "return picks", the board's name typed); the others take an inline reason field.
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Pencil, RotateCcw, Unlock } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { cx } from '../lib/util';
import { Badge, Banner, Button, Card, Check, DataTable, Empty, ErrText, Field, Input, Modal, Tabs, Textarea } from '../ui/kit';
import { rewardsAdmin, type AdminBoard, type Board, type BoardLogRow, type EventDoc, type Holder, type ResetRow, type ReviewItem } from './api';
import {
  actionLabel, BOARD_COLORS, BOARD_NAME_MAX, boardPatch, buildCells, CELL_LABEL, detailText, isForbidden, latestUndoable, lockOperation, LOCK_LABEL, mayOperate, MODE_LABEL, modeEffect, opErrorText, OPERATIONS, otherMode,
  ownerText, padNumber, reasonOk, resetAvailability, resetConfirmOk, resetEffect, shortOwner, takenCount, whenText, type CellView, type OpKey,
} from './boardView';

export type TFn = (s: string, v?: Record<string, string | number>) => string;
export function useT(): TFn {
  const lang = useLang();
  return useCallback((s, v) => tl(lang, s, v), [lang]);
}

/** The few styles the board needs (the shared stylesheet has no owner-name cell). Colours come from the theme variables, so dark mode follows. */
export function BoardStyles() {
  return <style>{`
.bo-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.bo-card { text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 12px 14px; cursor: pointer; font: inherit; color: inherit; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow); }
.bo-card:hover { border-color: var(--brand); } .bo-card.on { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
.bo-grid { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 4px; }
.bo-cell { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; min-height: 48px; min-width: 0; padding: 3px 1px; border-radius: 7px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; font-variant-numeric: tabular-nums; }
.bo-cell b { font-size: 12.5px; line-height: 1.1; } .bo-cell small { font-size: 9.5px; line-height: 1.1; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bo-cell:hover { border-color: var(--brand); }
.bo-cell.taken { background: var(--brand-soft); color: var(--brand-text); border-color: color-mix(in srgb, var(--brand) 40%, transparent); }
.bo-cell.reserved { background: var(--warn-soft); color: var(--warn-text); border-style: dashed; }
.bo-cell.shared { background: var(--surface-3); border: 2px dotted var(--text-2); }
.bo-cell.sel { outline: 2px solid var(--brand); outline-offset: 1px; }
.bo-cell i { position: absolute; top: 1px; right: 3px; font-style: normal; font-size: 9px; font-weight: 700; }
.bo-op { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; } .bo-op + .bo-op { border-top: 1px solid var(--border); padding-top: 14px; }
.bo-op > .bo-op-main { flex: 1 1 260px; min-width: 0; } .bo-op > .bo-op-act { flex: 0 1 340px; min-width: min(100%, 220px); }
.bo-err { color: var(--crit-text); font-size: 12.5px; margin: 2px 0; }
.bo-holder { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--border); }
.bo-reset { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.bo-edit { display: flex; flex-direction: column; gap: 10px; max-width: 420px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
.bo-sw { width: 30px; height: 30px; border-radius: 50%; border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--border-strong); color: #fff; font-weight: 800; font-size: 15px; line-height: 1; cursor: pointer; padding: 0; display: grid; place-items: center; }
.bo-sw.on { box-shadow: 0 0 0 2px var(--text); }
@media (max-width: 560px) { .bo-cell small { display: none; } .bo-cell { min-height: 36px; } .bo-op > .bo-op-act { flex-basis: 100%; } }
`}</style>;
}

// ================================================================================================ the inline reason field
/** The inline form every operation except the reset uses: a reason (required, kept in the audit log) and the one button that does it. */
export function ReasonForm({ confirmLabel, danger, busy, error, onSubmit, onCancel }: { confirmLabel: string; danger?: boolean; busy: boolean; error: string | null; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const T = useT();
  const [reason, setReason] = useState('');
  const ok = reasonOk(reason);
  const submit = (e: FormEvent) => { e.preventDefault(); if (ok && !busy) onSubmit(reason.trim()); };
  return (
    <form className="col gap-6" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <Field label={T('Reason (required, recorded in the audit log)')}><Input autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {error && <div role="alert" className="bo-err"><ErrText>{error}</ErrText></div>}
      <div className="row wrap">
        <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={!ok || busy}>{busy ? T('Working…') : confirmLabel}</Button>
        <Button onClick={onCancel} disabled={busy}>{T('Cancel')}</Button>
      </div>
    </form>
  );
}

// ================================================================================================ the board
type Tab = 'history' | 'resets' | 'audit' | 'review';
interface OpErr { where: string; text: string }
interface BoardAdminProps {
  event: EventDoc; admin: AdminBoard; role: string | undefined; denied: boolean; review: ReviewItem[] | null; reviewError?: string | null;
  /** Admin and Super Admin may rename and recolour a board (the server decides again) */
  canEditBoard: boolean;
  /** the server's answer after an operation (or a reload): the screen shows exactly this */
  onBoard: (ab: AdminBoard) => void; onReview: (items: ReviewItem[]) => void; onDenied: () => void;
  /** the server's answer after a rename / recolour */
  onBoardInfo: (b: Board) => void;
}
export default function BoardAdmin({ event, admin, role, denied, review, reviewError, canEditBoard, onBoard, onReview, onDenied, onBoardInfo }: BoardAdminProps) {
  const T = useT();
  const { board } = admin;
  const isSuper = mayOperate(role) && !denied;
  const [pick, setPick] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('history');
  const [open, setOpen] = useState<{ op: OpKey; id?: string } | null>(null);      // the one inline reason field that is open
  const [resetOpen, setResetOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);                                  // the inline name / colour form in the header is open
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<OpErr | null>(null);
  const cells = useMemo(() => buildCells(admin.numbers, event.number_min, event.number_max), [admin.numbers, event.number_min, event.number_max]);
  const cell = pick != null ? cells.find((c) => c.n === pick) : undefined;
  const maxN = event.number_max;
  useEffect(() => { setPick(null); setOpen(null); setErr(null); setResetOpen(false); setRenaming(false); }, [board.id]);

  /** Run one server operation. The screen then shows what the server returned; a refusal for rights hides the controls, any other failure is said where it happened. */
  const perform = async (where: string, call: () => Promise<AdminBoard>, ok: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true); setErr(null);
    try { const ab = await call(); onBoard(ab); setOpen(null); toast('success', ok); return true; }
    catch (e) { if (isForbidden(e)) onDenied(); setErr({ where, text: T(opErrorText(e)) }); return false; }
    finally { setBusy(false); }
  };
  const errFor = (where: string) => (err?.where === where ? err.text : null);
  const lockOp = lockOperation(board);
  const toMode = otherMode(board.mode);
  const resetOk = resetAvailability(board);
  const undoable = latestUndoable(admin.resets);

  return (
    <div className="col gap-16">
      {board.state === 'locked' && <Banner tone="warn"><b>{T('This board is locked.')}</b>{' '}{T('Customers cannot pick new numbers until it is unlocked.')}</Banner>}
      <div className="grid g-main">
        <Card title={<span className="row gap-6"><i className="ch-dot" style={{ background: board.color, width: 12, height: 12 }} />{board.name}</span>}
          sub={T('{taken} of {total} numbers taken · revision {rev}', { taken: takenCount(cells), total: board.total, rev: board.rev })}
          actions={<><Badge tone="info">{T(MODE_LABEL[board.mode])}</Badge><Badge tone={board.state === 'locked' ? 'warn' : 'good'} dot>{T(LOCK_LABEL[board.state])}</Badge>
            {canEditBoard && !renaming && <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}><Pencil size={13} />{' '}{T('Rename or recolour')}</Button>}</>}>
          {renaming && <BoardEditForm board={board} T={T} onCancel={() => setRenaming(false)} onSaved={(b) => { onBoardInfo(b); setRenaming(false); }} />}
          <div className="bo-grid" role="group" aria-label={T('{name} numbers', { name: board.name })}>
            {cells.map((c) => <Cell key={c.n} c={c} maxN={maxN} selected={pick === c.n} T={T} onPick={() => { setPick(c.n); setOpen(null); setErr(null); }} />)}
          </div>
          <div className="legend mt16">
            <span><i style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />{T('Free')}</span>
            <span><i style={{ background: 'var(--brand-soft)', border: '1px solid var(--brand)' }} />{T('Taken by one customer')}</span>
            <span><i style={{ background: 'var(--warn-soft)', border: '1px dashed var(--warn)' }} />{T('Reserved (held until confirmed)')}</span>
            <span><i style={{ background: 'var(--surface-3)', border: '2px dotted var(--text-2)' }} />{T('Shared (several customers)')}</span>
          </div>
          <div className="mt16" aria-live="polite">
            <NumberPanel cell={cell} boardName={board.name} maxN={maxN} isSuper={isSuper} open={open} setOpen={setOpen} busy={busy} errFor={errFor} T={T}
              onRelease={(h, reason) => void perform(`release:${h.selection_id}`, () => rewardsAdmin.releaseSelection(h.selection_id, reason), T('Number released'))} />
          </div>
        </Card>

        <Card title={T('Super Admin controls')} sub={T('Each action is separate, needs a reason and is written to the audit log.')}>
          {!isSuper ? (
            denied
              ? <Banner tone="bad">{T('The server refused: only a Super Admin can do this.')}</Banner>
              : <div className="muted">{T('Only a Super Admin can lock or unlock a board, switch its mode, release a number or reset a board.')}</div>
          ) : (
            <div className="col gap-16">
              <div className="bo-op">
                <div className="bo-op-main"><b>{T(OPERATIONS[lockOp].title)}</b><div className="text2">{T(OPERATIONS[lockOp].effect)}</div><div className="muted hint">{T(OPERATIONS[lockOp].never)}</div></div>
                <div className="bo-op-act">
                  {open?.op === lockOp
                    ? <ReasonForm confirmLabel={T(OPERATIONS[lockOp].title)} busy={busy} error={errFor(lockOp)} onCancel={() => setOpen(null)}
                        onSubmit={(r) => void perform(lockOp, () => (lockOp === 'lock' ? rewardsAdmin.lockBoard(board.id, r) : rewardsAdmin.unlockBoard(board.id, r)), lockOp === 'lock' ? T('Board locked') : T('Board unlocked'))} />
                    : <Button onClick={() => { setOpen({ op: lockOp }); setErr(null); }}>{lockOp === 'lock' ? <Lock size={14} /> : <Unlock size={14} />}{' '}{T(OPERATIONS[lockOp].title)}…</Button>}
                </div>
              </div>

              <div className="bo-op">
                <div className="bo-op-main"><b>{T(OPERATIONS.mode.title)}</b>{' '}<Badge tone="info">{T(MODE_LABEL[board.mode])}</Badge><div className="text2">{T(modeEffect(toMode))}</div><div className="muted hint">{T(OPERATIONS.mode.never)}</div></div>
                <div className="bo-op-act">
                  {open?.op === 'mode'
                    ? <ReasonForm confirmLabel={T('Switch to {mode}', { mode: T(MODE_LABEL[toMode]) })} busy={busy} error={errFor('mode')} onCancel={() => setOpen(null)}
                        onSubmit={(r) => void perform('mode', () => rewardsAdmin.setBoardMode(board.id, toMode, r), T('Mode changed'))} />
                    : <Button onClick={() => { setOpen({ op: 'mode' }); setErr(null); }}>{T('Switch to {mode}', { mode: T(MODE_LABEL[toMode]) })}…</Button>}
                </div>
              </div>

              <div className="bo-op">
                <div className="bo-op-main"><b>{T(OPERATIONS.reset.title)}</b><div className="text2">{T(OPERATIONS.reset.effect)}</div><div className="muted hint">{T(OPERATIONS.reset.never)}</div></div>
                <div className="bo-op-act">
                  {resetOk.ok
                    ? <Button variant="danger" onClick={() => { setResetOpen(true); setErr(null); }}><RotateCcw size={14} />{' '}{T(OPERATIONS.reset.title)}…</Button>
                    : <div className="muted">{T(resetOk.why)}</div>}
                </div>
              </div>
              <div className="muted hint">{T('To release one number, tap it on the grid and use the button under it.')}</div>
            </div>
          )}
        </Card>
      </div>

      <div>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[
          { v: 'history', label: T('History') }, { v: 'resets', label: T('Resets'), count: admin.resets.length || undefined },
          { v: 'audit', label: T('Audit log') }, { v: 'review', label: T('Needs review'), count: review?.length || undefined },
        ]} />
        {tab === 'history' && <HistoryTable rows={admin.log} T={T} />}
        {tab === 'resets' && (
          <ResetsPanel resets={admin.resets} undoableId={undoable?.id ?? null} isSuper={isSuper} open={open} setOpen={setOpen} busy={busy} errFor={errFor} T={T}
            onUndo={(r, reason) => void perform(`undo:${r.id}`, () => rewardsAdmin.undoReset(r.id, reason), T('Reset undone'))} />
        )}
        {tab === 'audit' && <AuditTable eventId={event.id} rev={board.rev} T={T} />}
        {tab === 'review' && <ReviewPanel items={review} error={reviewError ?? null} isSuper={isSuper} onReview={onReview} onDenied={onDenied} T={T} />}
      </div>

      {resetOpen && (
        <ResetPanel boardName={board.name} taken={board.taken} busy={busy} error={errFor('reset')} T={T} onCancel={() => { if (!busy) setResetOpen(false); }}
          onConfirm={async (reason, returnPicks) => { const ok = await perform('reset', () => rewardsAdmin.resetBoard(board.id, reason, returnPicks, board.name), T('Board reset')); if (ok) { setResetOpen(false); setPick(null); } }} />
      )}
    </div>
  );
}

// ================================================================================================ rename and recolour (inline, in the board header)
/** A name and one of a handful of colours. Only what changed is sent; the screen then shows the board the server returned. */
function BoardEditForm({ board, T, onCancel, onSaved }: { board: Board; T: TFn; onCancel: () => void; onSaved: (b: Board) => void }) {
  const [name, setName] = useState(board.name);
  const [color, setColor] = useState(board.color);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { patch, errors } = boardPatch(board, { name, color });
  const changed = Object.keys(patch).length > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || busy) return;
    setBusy(true); setErr(null);
    try { const b = await rewardsAdmin.saveBoard(board.id, patch); toast('success', T('Board saved')); onSaved(b); }
    catch (x) { setErr(isForbidden(x) ? T('The server refused this change. Some changes (closing an event, changing the number range once numbers are taken) need a Super Admin.') : T(opErrorText(x))); setBusy(false); }
  };
  return (
    <form className="bo-edit" onSubmit={(e) => void submit(e)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <Field label={T('Board name')} hint={errors.name ? <span className="bo-err">{T(errors.name)}</span> : undefined}><Input autoFocus maxLength={BOARD_NAME_MAX + 10} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="field"><label id="bo-colour-label">{T('Colour')}</label>
        <div className="row wrap gap-6" role="radiogroup" aria-labelledby="bo-colour-label">
          {BOARD_COLORS.map((c) => {
            const on = c.value.toLowerCase() === color.toLowerCase();
            return <button key={c.value} type="button" role="radio" aria-checked={on} aria-label={T(c.label)} title={T(c.label)} className={cx('bo-sw', on && 'on')} style={{ background: c.value }} onClick={() => setColor(c.value)}>{on ? '✓' : ''}</button>;
          })}
        </div>
      </div>
      {err && <div role="alert" className="bo-err"><ErrText>{err}</ErrText></div>}
      <div className="row wrap">
        <Button type="submit" variant="primary" disabled={!changed || busy || Object.keys(errors).length > 0}>{busy ? T('Working…') : T('Save board')}</Button>
        <Button onClick={onCancel} disabled={busy}>{T('Cancel')}</Button>
      </div>
    </form>
  );
}

// ================================================================================================ the grid
function Cell({ c, maxN, selected, T, onPick }: { c: CellView; maxN: number; selected: boolean; T: TFn; onPick: () => void }) {
  const num = padNumber(c.n, maxN);
  const first = c.holders[0];
  const who = c.kind === 'free' ? '' : c.kind === 'shared' ? T('{n} customers', { n: c.count }) : first ? ownerText(first, T('Unknown customer')) : '';
  const label = `${T('Number {n}', { n: num })}, ${T(CELL_LABEL[c.kind])}${who ? `, ${who}` : ''}`;
  return (
    <button type="button" className={cx('bo-cell', c.kind !== 'free' && c.kind, selected && 'sel')} onClick={onPick} aria-label={label} aria-pressed={selected} title={label}>
      <b>{num}</b>
      {c.kind === 'shared' ? <small>{T('shared')}</small> : first && <small>{shortOwner(first)}</small>}
      {c.kind === 'shared' && c.count > 1 && <i aria-hidden="true">×{c.count}</i>}
    </button>
  );
}

function NumberPanel({ cell, boardName, maxN, isSuper, open, setOpen, busy, errFor, T, onRelease }: {
  cell: CellView | undefined; boardName: string; maxN: number; isSuper: boolean; open: { op: OpKey; id?: string } | null; setOpen: (o: { op: OpKey; id?: string } | null) => void;
  busy: boolean; errFor: (w: string) => string | null; T: TFn; onRelease: (h: Holder, reason: string) => void;
}) {
  if (!cell) return <div className="muted">{T('Tap a number to see who holds it.')}</div>;
  const num = padNumber(cell.n, maxN);
  return (
    <div>
      <div className="row between wrap"><b>{boardName} · #{num}</b><Badge tone={cell.kind === 'free' ? 'good' : cell.kind === 'reserved' ? 'warn' : 'info'}>{T(CELL_LABEL[cell.kind])}</Badge></div>
      {cell.holders.length === 0 && <div className="muted mt8">{T('Nobody holds this number.')}</div>}
      {cell.holders.map((h) => {
        const where = `release:${h.selection_id}`;
        const mine = open?.op === 'release' && open.id === h.selection_id;
        return (
          <div key={h.selection_id} className="bo-holder">
            <div style={{ minWidth: 0 }}>
              <b>{ownerText(h, T('Unknown customer'))}</b>
              <div className="sub muted">{h.status === 'reserved' ? T('Held until confirmed') : T('Confirmed')} · {h.exclusive ? T('Own number') : T('Shared number')} · {whenText(h.at)}</div>
            </div>
            {isSuper && (mine
              ? <div style={{ flex: '1 1 280px', maxWidth: 380 }}><ReasonForm confirmLabel={T('Release #{n}', { n: num })} busy={busy} error={errFor(where)} onCancel={() => setOpen(null)} onSubmit={(r) => onRelease(h, r)} /></div>
              : <Button size="sm" onClick={() => setOpen({ op: 'release', id: h.selection_id })}>{T(OPERATIONS.release.title)}…</Button>)}
          </div>
        );
      })}
      {isSuper && cell.holders.length > 0 && <div className="muted hint mt8">{T(OPERATIONS.release.effect)} {T(OPERATIONS.release.never)}</div>}
    </div>
  );
}

// ================================================================================================ reset (the one confirmation panel)
function ResetPanel({ boardName, taken, busy, error, T, onCancel, onConfirm }: { boardName: string; taken: number; busy: boolean; error: string | null; T: TFn; onCancel: () => void; onConfirm: (reason: string, returnPicks: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [returnPicks, setReturnPicks] = useState(true);       // ticked by default: customers get their picks back
  const [typed, setTyped] = useState('');
  const valid = reasonOk(reason) && resetConfirmOk(typed, boardName);
  return (
    <Modal title={T('Reset {name}?', { name: boardName })} size="sm" onClose={onCancel}
      footer={<><Button onClick={onCancel} disabled={busy}>{T('Cancel')}</Button><Button variant="danger" disabled={!valid || busy} onClick={() => onConfirm(reason.trim(), returnPicks)}>{busy ? T('Working…') : T('Reset board')}</Button></>}>
      <div className="col">
        <Banner tone="warn">{T('{n} numbers are taken on this board now.', { n: taken })}{' '}{T(resetEffect(returnPicks))}</Banner>
        <Field label={T('Reason (required, recorded in the audit log)')}><Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        <Check checked={returnPicks} onChange={setReturnPicks}>{T('Return picks to customers')}</Check>
        <Field label={T('Type {word} to confirm', { word: boardName })}><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
        {error && <div role="alert" className="bo-err"><ErrText>{error}</ErrText></div>}
      </div>
    </Modal>
  );
}

// ================================================================================================ the tabs
function HistoryTable({ rows, T }: { rows: BoardLogRow[]; T: TFn }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()), [rows]);
  return <Card flush><LogTable rows={sorted} T={T} empty={T('Nothing has happened on this board yet.')} /></Card>;
}
function LogTable({ rows, T, empty }: { rows: BoardLogRow[]; T: TFn; empty: string }) {
  return (
    <DataTable<BoardLogRow> rows={rows} rowKey={(r) => `${r.at}|${r.action}|${r.actor_name ?? ''}|${detailText(r.detail)}|${r.reason ?? ''}`} pageSize={10} empty={<Empty title={empty} />}
      cols={[
        { key: 'at', header: T('When'), render: (r) => whenText(r.at) },
        { key: 'who', header: T('By'), render: (r) => r.actor_name ?? '—' },
        { key: 'what', header: T('What'), render: (r) => <Badge>{T(actionLabel(r.action))}</Badge> },
        { key: 'why', header: T('Reason'), render: (r) => r.reason ?? '' },
        { key: 'detail', header: T('Detail'), hideSm: true, render: (r) => <span className="muted">{detailText(r.detail)}</span> },
      ]} />
  );
}

/** The audit log of the whole event (every board), newest first, loaded again when this board changes. */
function AuditTable({ eventId, rev, T }: { eventId: string; rev: number; T: TFn }) {
  const [limit, setLimit] = useState(50);
  const [rows, setRows] = useState<BoardLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    rewardsAdmin.log(eventId, limit, 0).then((r) => { if (!stop) { setRows(r); setError(null); } }).catch((e) => { if (!stop) setError(T(opErrorText(e))); });
    return () => { stop = true; };
  }, [eventId, rev, limit]);                                       // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Banner tone="bad">{error}</Banner>;
  if (!rows) return <div className="muted">{T('Loading…')}</div>;
  return (
    <>
      <Card flush><LogTable rows={rows} T={T} empty={T('The audit log is empty.')} /></Card>
      {rows.length >= limit && <div className="mt8"><Button onClick={() => setLimit(limit + 50)}>{T('Show more')}</Button></div>}
    </>
  );
}

function ResetsPanel({ resets, undoableId, isSuper, open, setOpen, busy, errFor, T, onUndo }: {
  resets: ResetRow[]; undoableId: string | null; isSuper: boolean; open: { op: OpKey; id?: string } | null; setOpen: (o: { op: OpKey; id?: string } | null) => void;
  busy: boolean; errFor: (w: string) => string | null; T: TFn; onUndo: (r: ResetRow, reason: string) => void;
}) {
  const sorted = useMemo(() => [...resets].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()), [resets]);
  if (!sorted.length) return <Card><Empty title={T('This board has not been reset.')} /></Card>;
  return (
    <div className="col">
      {sorted.map((r) => {
        const here = open?.op === 'undo' && open.id === r.id;
        return (
          <div key={r.id} className="bo-reset">
            <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <b>{whenText(r.at)}</b> · {r.by_name ?? '—'}
                <div className="text2">{r.reason}</div>
                <div className="muted hint">{T('{n} numbers cleared', { n: r.affected })} · {r.returned_picks ? T('Picks returned to customers') : T('Picks stayed used')}</div>
              </div>
              <div className="row gap-6">
                {r.undone_at ? <Badge>{T('Undone {when}', { when: whenText(r.undone_at) })}</Badge> : <Badge tone="warn" dot>{T('Active')}</Badge>}
                {isSuper && r.id === undoableId && !here && <Button size="sm" onClick={() => setOpen({ op: 'undo', id: r.id })}><RotateCcw size={13} />{' '}{T(OPERATIONS.undo.title)}…</Button>}
              </div>
            </div>
            {here && (
              <div className="mt8" style={{ maxWidth: 420 }}>
                <div className="text2 mb8">{T(OPERATIONS.undo.effect)} {T(OPERATIONS.undo.never)}</div>
                <ReasonForm confirmLabel={T(OPERATIONS.undo.title)} busy={busy} error={errFor(`undo:${r.id}`)} onCancel={() => setOpen(null)} onSubmit={(reason) => onUndo(r, reason)} />
              </div>
            )}
          </div>
        );
      })}
      <div className="muted hint">{T('Only the newest reset can be undone, and only while no number has been taken since.')}</div>
    </div>
  );
}

/** Rights whose bill was taken back after their number was claimed. The number is never released silently: a Super Admin keeps it or releases it. */
function ReviewPanel({ items, error, isSuper, onReview, onDenied, T }: { items: ReviewItem[] | null; error: string | null; isSuper: boolean; onReview: (items: ReviewItem[]) => void; onDenied: () => void; T: TFn }) {
  const [open, setOpen] = useState<{ id: string; action: 'keep' | 'release' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<OpErr | null>(null);
  if (!items) return error ? <Banner tone="bad">{error}</Banner> : <div className="muted">{T('Loading…')}</div>;
  const resolve = async (it: ReviewItem, action: 'keep' | 'release', reason: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { const rest = await rewardsAdmin.resolveReview(it.entitlement_id, action, reason); onReview(rest); setOpen(null); toast('success', action === 'keep' ? T('Number kept') : T('Number released')); }
    catch (e) { if (isForbidden(e)) onDenied(); setErr({ where: it.entitlement_id, text: T(opErrorText(e)) }); }
    finally { setBusy(false); }
  };
  return (
    <div className="col">
      <div className="text2">{T('A customer\'s bill was taken back after they had already used a pick on a number. The number stays as it is until a Super Admin decides.')}</div>
      {!items.length && <Card><Empty title={T('Nothing needs review.')} /></Card>}
      {items.map((it) => {
        const here = open?.id === it.entitlement_id;
        return (
          <div key={it.entitlement_id} className="bo-reset">
            <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <b>{it.profile_name ?? T('Unknown customer')}</b>
                <div className="text2">{it.rule_name} · {it.number != null && it.board_name ? `${it.board_name} #${it.number}` : T('no number held')}</div>
                <div className="muted hint">{T('Since {when}', { when: whenText(it.since) })}</div>
              </div>
              {isSuper && !here && (
                <div className="row gap-6">
                  <Button size="sm" onClick={() => setOpen({ id: it.entitlement_id, action: 'keep' })}>{T('Keep number')}…</Button>
                  <Button size="sm" onClick={() => setOpen({ id: it.entitlement_id, action: 'release' })}>{T('Release number')}…</Button>
                </div>
              )}
            </div>
            {here && open && (
              <div className="mt8" style={{ maxWidth: 420 }}>
                <div className="text2 mb8">{open.action === 'keep' ? T('The customer keeps this number. Nothing changes on the board.') : T('Frees this number so other customers can pick it.')}</div>
                <ReasonForm confirmLabel={open.action === 'keep' ? T('Keep number') : T('Release number')} busy={busy} error={err?.where === it.entitlement_id ? err.text : null} onCancel={() => setOpen(null)} onSubmit={(r) => void resolve(it, open.action, r)} />
              </div>
            )}
          </div>
        );
      })}
      {!isSuper && items.length > 0 && <div className="muted hint">{T('Only a Super Admin can decide these.')}</div>}
    </div>
  );
}

