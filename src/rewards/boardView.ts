// What the back-office event boards show and decide, kept out of the components so it can be unit-tested (tests/unit/rewardsBoardView.test.ts): how the holders of a number
// become a cell, when to poll and when a board must be reloaded, the wording and availability of the five separate Super Admin operations, the reset confirmation, the event
// form, and what an error from the database says. No JSX and nothing here changes a board: the screens send identifiers and what staff typed, and show the answer the server
// gives (never a guess). The server re-checks every role, so "who may" here only decides what to show.
import { ShopError } from '../shop/api';
import { dayText, fromLocalInput, localInput, timeText } from '../finance/reviewUi';
import { money, money0 } from '../lib/util';
import type { AdminBoard, Board, BoardMode, BoardRevs, EventDoc, EventPatch, EventStatus, Holder, ResetRow, Rule } from './api';

// ------------------------------------------------------------------------------------------------ time
/** A moment as day and time in the shop's own zone (Bangkok), never the browser's; "—" when there is none or it is not a date. */
export const whenText = (iso: string | null | undefined): string => (dayText(iso) ? `${dayText(iso)} ${timeText(iso)}` : '—');

// ------------------------------------------------------------------------------------------------ cells
export type CellKind = 'free' | 'taken' | 'reserved' | 'shared';
export interface CellView { n: number; kind: CellKind; holders: Holder[]; count: number }

/** free: nobody holds it. taken / reserved: one customer holds it alone (confirmed, or held until the hold ends). shared: it is held by customers who share it. An exclusive holder always wins, so a number is never shown as joinable when it is not. */
export function cellKind(holders: Holder[]): CellKind {
  if (!holders.length) return 'free';
  const alone = holders.find((h) => h.exclusive);
  if (alone) return alone.status === 'reserved' && holders.length === 1 ? 'reserved' : 'taken';
  return 'shared';
}
/** One cell per number of the range, in order, even when the server lists only the taken ones. A holder outside the range is still shown (the server is the truth). */
export function buildCells(numbers: AdminBoard['numbers'], min: number, max: number): CellView[] {
  const byN = new Map<number, Holder[]>();
  for (const x of numbers) byN.set(x.n, x.holders ?? []);
  const all = new Set<number>(byN.keys());
  for (let n = min; n <= max; n++) all.add(n);
  return [...all].sort((a, b) => a - b).map((n) => { const holders = byN.get(n) ?? []; return { n, kind: cellKind(holders), holders, count: holders.length }; });
}
export const takenCount = (cells: CellView[]) => cells.filter((c) => c.kind !== 'free').length;
export const padNumber = (n: number, max: number) => String(n).padStart(Math.max(2, String(max).length), '0');
const tailText = (tail: string) => (/^\d+$/.test(tail) ? `…${tail}` : tail);
/** "Name (…1234)": the name with the end of the phone number, which is all staff need to tell two customers apart. */
export function ownerText(h: Holder, unknown = 'Unknown customer'): string {
  const name = h.name?.trim() || unknown;
  return h.phone_tail ? `${name} (${tailText(h.phone_tail)})` : name;
}
/** What fits in a small cell: the first word of the name, or the phone tail when the name is missing. */
export function shortOwner(h: Holder): string {
  const first = h.name?.trim().split(/\s+/)[0];
  if (first) return Array.from(first).slice(0, 8).join('');
  return h.phone_tail ? tailText(h.phone_tail) : '?';
}

// ------------------------------------------------------------------------------------------------ polling
export const POLL_MS = 5000;
export interface PollContext { active: boolean; docHidden: boolean; eventId: string | null; inFlight: boolean }
/** The three revisions are read every 5 s, but only while this tab is the selected one, the browser page is not hidden, an event is open, and the previous read has finished. */
export const shouldPoll = (c: PollContext) => c.active && !c.docHidden && !!c.eventId && !c.inFlight;
export const revMap = (boards: { id: string; rev: number }[]): Record<string, number> => Object.fromEntries(boards.map((b) => [b.id, b.rev]));
/** The boards whose revision is not the one we hold (or that we have never seen): only those are reloaded. A lower revision also counts, e.g. after a restore. */
export const changedBoardIds = (known: Record<string, number>, revs: BoardRevs): string[] => revs.boards.filter((b) => known[b.id] !== b.rev).map((b) => b.id);
export const eventStatusChanged = (known: EventStatus | null | undefined, revs: BoardRevs): boolean => known != null && revs.event_status !== known;
/** A slow answer never replaces a newer board: the revision only goes up. */
export const acceptBoard = (current: Board | null | undefined, incoming: Board): boolean => !current || incoming.rev >= current.rev;

// ------------------------------------------------------------------------------------------------ who may do what (a hint; the database enforces the same rules)
export const mayOperate = (role: string | null | undefined) => role === 'SUPER_ADMIN';
export const mayEditEvents = (role: string | null | undefined) => role === 'ADMIN' || role === 'SUPER_ADMIN';

// ------------------------------------------------------------------------------------------------ the five operations (spec table), each separate, each with a reason
export type OpKey = 'lock' | 'unlock' | 'mode' | 'release' | 'reset' | 'undo';
export interface OpInfo { key: OpKey; title: string; effect: string; never: string; panel: boolean; danger: boolean }
export const OPERATIONS: Record<OpKey, OpInfo> = {
  lock: { key: 'lock', title: 'Lock board', effect: 'Stops new picks on this board. Customers can still see it.', never: 'Numbers already taken stay as they are, and the mode does not change.', panel: false, danger: false },
  unlock: { key: 'unlock', title: 'Unlock board', effect: 'Lets customers pick numbers on this board again.', never: 'Does not change any number or the mode.', panel: false, danger: false },
  mode: { key: 'mode', title: 'Switch mode', effect: 'Changes whether a number can be held by one customer or by several. It changes the mode only.', never: 'Numbers already taken are kept, never rewritten or removed.', panel: false, danger: false },
  release: { key: 'release', title: 'Release number', effect: 'Frees one number and gives the pick back to its owner.', never: 'No other number is touched.', panel: false, danger: false },
  reset: { key: 'reset', title: 'Reset board', effect: 'Clears every number on this board so customers can pick again.', never: 'History is never deleted: every selection stays on record.', panel: true, danger: true },
  undo: { key: 'undo', title: 'Undo reset', effect: 'Restores the numbers this reset cleared, if all of them are still free.', never: 'Does nothing if a number has been taken since.', panel: false, danger: false },
};
export const lockOperation = (b: Board): 'lock' | 'unlock' => (b.state === 'locked' ? 'unlock' : 'lock');
export const otherMode = (m: BoardMode): BoardMode => (m === 'exclusive' ? 'shared' : 'exclusive');
/** What switching TO this mode does, including what happens to the numbers that are already taken. */
export const modeEffect = (to: BoardMode): string => (to === 'shared'
  ? 'From now on several customers may hold the same number. Numbers already held by one customer stay theirs alone.'
  : 'From now on a number belongs to one customer. Numbers already shared by several customers stay shared until they are released or the board is reset; nobody new can join them.');
export const resetEffect = (returnPicks: boolean): string => (returnPicks
  ? 'Every number is cleared and customers get their picks back to choose again. History is kept, and you can undo the reset while no number has been taken since.'
  : 'Every number is cleared but the picks stay used: customers cannot choose again with them. History is kept, and you can undo the reset while no number has been taken since.');
export const NOTHING_TO_RESET = 'Nothing to reset: no number is taken on this board.';
export const resetAvailability = (b: Board): { ok: true } | { ok: false; why: string } => (b.taken > 0 ? { ok: true } : { ok: false, why: NOTHING_TO_RESET });
/** The server needs a reason for every operation; a blank one is not a reason. */
export const reasonOk = (reason: string) => reason.trim().length > 0;
/** The reset is confirmed by typing the board's name exactly (case matters, spaces at the ends do not). The name that is sent is the board's own, so what the server compares is what was shown. */
export const resetConfirmOk = (typed: string, boardName: string) => boardName.trim() !== '' && typed.trim() === boardName.trim();
/** Only the newest reset can be undone, and only while it is not undone already; the server still refuses it if a number was taken since. */
export function latestUndoable(resets: ResetRow[]): ResetRow | null {
  if (!resets.length) return null;
  const newest = resets.reduce((a, b) => (new Date(b.at).getTime() > new Date(a.at).getTime() ? b : a));
  return newest.undone_at ? null : newest;
}

// ------------------------------------------------------------------------------------------------ errors
export const isForbidden = (e: unknown): boolean => (e instanceof ShopError && e.code === 'FORBIDDEN') || (typeof e === 'object' && e != null && (e as { code?: unknown }).code === '42501');
const ERROR_TEXT: Record<string, string> = {
  FORBIDDEN: 'Only a Super Admin can do this.',
  REASON_REQUIRED: 'Write the reason first.',
  CONFIRM_MISMATCH: 'The name you typed does not match the board name.',
  // the server uses this code for several situations (a customer picking during a reset, an undo of a reset that was already undone, a number taken again): its own words are
  // shown when it sends them (see opErrorText); this is only the fallback when it sent none
  RESET_CONFLICT: 'The board changed while you were doing this, so it could not be completed. Check the board, then try again.',
  NOT_FOUND: 'That item was not found. It may have been changed by someone else.',
  BOARDS_OFF: 'Event boards are switched off.',
  NETWORK: 'The connection failed. Check the signal, then check the board before trying again.',
};
export const GENERIC_ERROR = 'Something went wrong';
/** The sentence for a failed call: known codes have their own text, any other server text is shown without its code, nothing is hidden or invented. */
export function opErrorText(e: unknown): string {
  if (isForbidden(e)) return ERROR_TEXT.FORBIDDEN;
  if (e instanceof ShopError) {
    const detail = e.message.replace(/^[A-Z][A-Z_]{2,}:\s*/, '').trim();
    if (e.code === 'RESET_CONFLICT' && detail && detail !== e.code) return detail;
    return ERROR_TEXT[e.code] ?? (detail || GENERIC_ERROR);
  }
  if (e instanceof Error) return e.message || GENERIC_ERROR;
  return GENERIC_ERROR;
}

// ------------------------------------------------------------------------------------------------ the log in plain words
const ACTION_LABELS: [RegExp, string][] = [
  [/undo/, 'Reset undone'], [/reset/, 'Board reset'], [/unlock/, 'Board unlocked'], [/lock/, 'Board locked'], [/mode/, 'Mode changed'], [/release/, 'Number released'],
  [/claim/, 'Number picked'], [/confirm/, 'Pick confirmed'], [/expire/, 'Hold expired'], [/review|resolve/, 'Review decided'], [/status/, 'Event status changed'], [/error/, 'Reward error'],
];
/** An action code of the audit log as words. An action this screen does not know is shown as words too, never hidden. */
export function actionLabel(action: string): string {
  const a = (action ?? '').trim();
  if (!a) return '—';
  const low = a.toLowerCase();
  for (const [re, label] of ACTION_LABELS) if (re.test(low)) return label;
  const words = a.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const DETAIL_MAX = 140;
/** The detail of a log row as a short "key: value" list; empty values are left out. */
export function detailText(detail: Record<string, unknown> | null | undefined): string {
  const parts = Object.entries(detail ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  const s = parts.join(', ');
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}…` : s;
}

// ------------------------------------------------------------------------------------------------ the event form
export interface EventForm { name: string; description: string; startsAt: string; endsAt: string; min: string; max: string; hold: string; maxPer: string }
export const emptyEventForm = (): EventForm => ({ name: '', description: '', startsAt: '', endsAt: '', min: '0', max: '99', hold: '0', maxPer: '' });
export const formFromEvent = (ev: EventDoc): EventForm => ({
  name: ev.name, description: ev.description ?? '', startsAt: localInput(ev.starts_at), endsAt: localInput(ev.ends_at),
  min: String(ev.number_min), max: String(ev.number_max), hold: String(ev.hold_minutes), maxPer: ev.max_per_customer == null ? '' : String(ev.max_per_customer),
});
/** The most numbers one board shows: the screen is a grid of ten columns, so a range beyond this is refused before it is sent. */
export const MAX_NUMBERS = 1000;
export const FORM_ERRORS = {
  name: 'Give the event a name.',
  range: 'Numbers must be whole, from 0 up, with "to" not below "from", and at most 1,000 numbers.',
  hold: 'Hold minutes must be a whole number, 0 or more (0 confirms a pick at once).',
  maxPer: 'Leave empty for no limit, or enter a whole number of 1 or more.',
  window: 'Enter complete dates and times, with the end after the start.',
} as const;
export type FormErrorKey = keyof typeof FORM_ERRORS;
const intOf = (s: string): number | null => (/^-?\d+$/.test(s.trim()) ? Number(s.trim()) : null);
export function validateEventForm(f: EventForm): { ok: true; patch: EventPatch } | { ok: false; errors: Partial<Record<FormErrorKey, string>> } {
  const errors: Partial<Record<FormErrorKey, string>> = {};
  if (!f.name.trim()) errors.name = FORM_ERRORS.name;
  const min = intOf(f.min), max = intOf(f.max);
  if (min == null || max == null || min < 0 || max < min || max - min + 1 > MAX_NUMBERS) errors.range = FORM_ERRORS.range;
  const hold = intOf(f.hold);
  if (hold == null || hold < 0) errors.hold = FORM_ERRORS.hold;
  let maxPer: number | null = null;
  if (f.maxPer.trim() !== '') { const n = intOf(f.maxPer); if (n == null || n < 1) errors.maxPer = FORM_ERRORS.maxPer; else maxPer = n; }
  const starts = f.startsAt.trim() ? fromLocalInput(f.startsAt) : null, ends = f.endsAt.trim() ? fromLocalInput(f.endsAt) : null;
  if ((f.startsAt.trim() && !starts) || (f.endsAt.trim() && !ends) || (starts && ends && new Date(ends).getTime() <= new Date(starts).getTime())) errors.window = FORM_ERRORS.window;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, patch: { name: f.name.trim(), description: f.description.trim() || null, starts_at: starts, ends_at: ends, number_min: min as number, number_max: max as number, hold_minutes: hold as number, max_per_customer: maxPer } };
}

export const STATUS_LABEL: Record<EventStatus, string> = { draft: 'Draft', active: 'Active', paused: 'Paused', closed: 'Closed' };
export interface StatusAction { to: EventStatus; label: string; danger: boolean }
/** The next steps in the life of an event. A closed event stays closed (its history and winners are kept). Closing is for a Super Admin, so an Admin is not offered it (the server decides again). */
export function statusActions(s: EventStatus, canClose = true): StatusAction[] {
  const close: StatusAction[] = canClose ? [{ to: 'closed', label: 'Close', danger: true }] : [];
  if (s === 'draft') return [{ to: 'active', label: 'Activate', danger: false }];
  if (s === 'active') return [{ to: 'paused', label: 'Pause', danger: false }, ...close];
  if (s === 'paused') return [{ to: 'active', label: 'Resume', danger: false }, ...close];
  return [];
}
/** Once numbers are taken, changing the number range is for a Super Admin (the server refuses an Admin), so the fields are locked for an Admin rather than failing when saved. */
export const rangeLocked = (role: string | null | undefined, ev: Pick<EventDoc, 'boards'>): boolean => !mayOperate(role) && ev.boards.some((b) => b.taken > 0);
const DATE_KEYS = ['starts_at', 'ends_at'];
const sameValue = (key: string, a: unknown, b: unknown) => (DATE_KEYS.includes(key) && typeof a === 'string' && typeof b === 'string' ? new Date(a).getTime() === new Date(b).getTime() : a === b);
/** What an edit sends: only the fields that changed (a range that was not touched is never a "range change"). A new event (no event given) sends everything. */
export function eventPatchFor(ev: EventDoc | null, patch: EventPatch): EventPatch {
  if (!ev) return patch;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (!sameValue(k, v, (ev as unknown as Record<string, unknown>)[k])) out[k] = v;
  return out as EventPatch;
}

// ------------------------------------------------------------------------------------------------ rename and recolour a board
export const BOARD_COLORS: { value: string; label: string }[] = [
  { value: '#d6453a', label: 'Red' }, { value: '#e08a00', label: 'Orange' }, { value: '#2f9e44', label: 'Green' }, { value: '#0f9aa8', label: 'Teal' },
  { value: '#2a78d6', label: 'Blue' }, { value: '#7b4fd6', label: 'Purple' }, { value: '#c0397b', label: 'Pink' }, { value: '#5b6573', label: 'Grey' },
];
export const BOARD_NAME_MAX = 40;
export const BOARD_FORM_ERRORS = { name: 'Give the board a name of 1 to 40 characters.', color: 'Pick one of the colours.' } as const;
/** The patch for `saveBoard`: only the changed fields (an empty patch means nothing to save), the name trimmed, and what is wrong, field by field. */
export function boardPatch(board: Pick<Board, 'name' | 'color'>, f: { name: string; color: string }): { patch: Partial<Pick<Board, 'name' | 'color'>>; errors: Partial<Record<'name' | 'color', string>> } {
  const patch: Partial<Pick<Board, 'name' | 'color'>> = {};
  const errors: Partial<Record<'name' | 'color', string>> = {};
  const name = f.name.trim();
  if (!name || name.length > BOARD_NAME_MAX) errors.name = BOARD_FORM_ERRORS.name; else if (name !== board.name) patch.name = name;
  if (!/^#[0-9a-f]{6}$/i.test(f.color)) errors.color = BOARD_FORM_ERRORS.color; else if (f.color.toLowerCase() !== board.color.toLowerCase()) patch.color = f.color;
  return Object.keys(errors).length ? { patch: {}, errors } : { patch, errors };
}
export type WindowState = 'always' | 'before' | 'open' | 'ended';
export const WINDOW_LABEL: Record<WindowState, string> = { always: 'No date limit', before: 'Not started yet', open: 'Inside its dates', ended: 'Ended' };
/** Where "now" is against the event's dates: an active event outside its dates is still not open to customers. */
export function windowState(ev: Pick<EventDoc, 'starts_at' | 'ends_at'>, now: number = Date.now()): WindowState {
  if (!ev.starts_at && !ev.ends_at) return 'always';
  if (ev.starts_at && now < new Date(ev.starts_at).getTime()) return 'before';
  if (ev.ends_at && now > new Date(ev.ends_at).getTime()) return 'ended';
  return 'open';
}
const stepText = (n: number) => (Number.isInteger(n) ? money0(n) : money(n));
/** One line about a number-pick rule of the event: the text to translate and what goes into it. */
export function ruleSummary(r: Pick<Rule, 'spend_step' | 'reward_amount' | 'max_per_order'>): { key: string; vars: Record<string, string | number> } {
  const vars: Record<string, string | number> = { step: stepText(r.spend_step), n: r.reward_amount };
  if (r.max_per_order != null) return { key: 'Every {step} on one bill earns {n} pick(s), up to {max} per bill', vars: { ...vars, max: r.max_per_order } };
  return { key: 'Every {step} on one bill earns {n} pick(s)', vars };
}

// ------------------------------------------------------------------------------------------------ labels
export const MODE_LABEL: Record<BoardMode, string> = { exclusive: 'Exclusive', shared: 'Shared' };
export const LOCK_LABEL: Record<Board['state'], string> = { open: 'Open', locked: 'Locked' };
export const CELL_LABEL: Record<CellKind, string> = { free: 'Free', taken: 'Taken', reserved: 'Reserved', shared: 'Shared' };

/** Every fixed sentence of this module, so a test can prove each one has a Thai text. */
export const ALL_TEXTS: string[] = [
  ...Object.values(OPERATIONS).flatMap((o) => [o.title, o.effect, o.never]), modeEffect('shared'), modeEffect('exclusive'), resetEffect(true), resetEffect(false), NOTHING_TO_RESET,
  ...Object.values(ERROR_TEXT), GENERIC_ERROR, ...Object.values(FORM_ERRORS), ...Object.values(BOARD_FORM_ERRORS), ...BOARD_COLORS.map((c) => c.label), ...Object.values(STATUS_LABEL), ...Object.values(WINDOW_LABEL),
  ...(['draft', 'active', 'paused', 'closed'] as EventStatus[]).flatMap((s) => statusActions(s).map((a) => a.label)),
  ...Object.values(MODE_LABEL), ...Object.values(LOCK_LABEL), ...Object.values(CELL_LABEL),
  ...ACTION_LABELS.map(([, l]) => l), 'Every {step} on one bill earns {n} pick(s)', 'Every {step} on one bill earns {n} pick(s), up to {max} per bill',
];
