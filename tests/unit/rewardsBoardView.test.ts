// What the back-office event boards show and decide (src/rewards/boardView.ts): how a number's holders become a cell, when to poll and when to reload a board, the
// wording and availability of the five separate Super Admin operations, the reset confirmation, the event form and what an error from the database says.
// No JSX: the screens only send identifiers and what a staff member typed, and show the answer the server gives.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ShopError } from '../../src/shop/api';
import { TH, t } from '../../src/lib/i18n';
import type { Board, BoardRevs, EventDoc, Holder, ResetRow, Rule } from '../../src/rewards/api';
import {
  acceptBoard, actionLabel, BOARD_COLORS, BOARD_FORM_ERRORS, BOARD_NAME_MAX, boardPatch, buildCells, cellKind, changedBoardIds, detailText, emptyEventForm, eventPatchFor, eventStatusChanged, formFromEvent, rangeLocked, isForbidden, latestUndoable, lockOperation, mayEditEvents, mayOperate,
  modeEffect, opErrorText, OPERATIONS, otherMode, ownerText, padNumber, POLL_MS, reasonOk, resetAvailability, resetConfirmOk, resetEffect, revMap, ruleSummary, shortOwner, shouldPoll, statusActions,
  takenCount, validateEventForm, whenText, windowState, ALL_TEXTS,
} from '../../src/rewards/boardView';

const holder = (over: Partial<Holder> = {}): Holder => ({ selection_id: 's1', profile_id: 'p1', name: 'สมชาย ใจดี', phone_tail: '5678', status: 'confirmed', exclusive: true, at: '2026-11-21T03:00:00Z', ...over });
const board = (over: Partial<Board> = {}): Board => ({ id: 'b1', event_id: 'e1', slot: 1, name: 'Board A', color: '#e11', mode: 'exclusive', state: 'open', rev: 3, taken: 2, total: 100, last_reset_id: null, ...over });
const reset = (over: Partial<ResetRow> = {}): ResetRow => ({ id: 'r1', at: '2026-11-21T04:00:00Z', by_name: 'Boss', reason: 'new round', returned_picks: true, affected: 5, undone_at: null, ...over });

describe('a number becomes one cell', () => {
  it('no holder is free; one exclusive holder is taken; a reserved exclusive hold is reserved', () => {
    expect(cellKind([])).toBe('free');
    expect(cellKind([holder()])).toBe('taken');
    expect(cellKind([holder({ status: 'reserved' })])).toBe('reserved');
  });
  it('holders that share the number make it shared, however many there are', () => {
    expect(cellKind([holder({ exclusive: false })])).toBe('shared');
    expect(cellKind([holder({ exclusive: false }), holder({ selection_id: 's2', profile_id: 'p2', exclusive: false })])).toBe('shared');
  });
  it('an exclusive holder wins over a defensive mix: the number is taken, never shown as joinable', () => {
    expect(cellKind([holder({ exclusive: false }), holder({ selection_id: 's2', profile_id: 'p2', exclusive: true })])).toBe('taken');
  });
  it('every number of the range gets a cell, in order, even when the server lists only the taken ones', () => {
    const cells = buildCells([{ n: 7, holders: [holder()] }, { n: 3, holders: [holder({ exclusive: false }), holder({ selection_id: 's2', profile_id: 'p2', exclusive: false })] }], 0, 9);
    expect(cells.map((c) => c.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cells[7]).toMatchObject({ kind: 'taken', count: 1 });
    expect(cells[3]).toMatchObject({ kind: 'shared', count: 2 });
    expect(cells[0]).toMatchObject({ kind: 'free', count: 0, holders: [] });
    expect(takenCount(cells)).toBe(2);
  });
  it('a holder outside the range is not dropped silently: the server is the truth', () => {
    const cells = buildCells([{ n: 120, holders: [holder()] }], 0, 99);
    expect(cells).toHaveLength(101);
    expect(cells[100]).toMatchObject({ n: 120, kind: 'taken' });
  });
  it('numbers are padded to the width of the largest one', () => {
    expect(padNumber(7, 99)).toBe('07');
    expect(padNumber(7, 999)).toBe('007');
    expect(padNumber(0, 9)).toBe('00');
  });
  it('the owner is the name with the end of the phone number; a missing name is said so', () => {
    expect(ownerText(holder())).toBe('สมชาย ใจดี (…5678)');
    expect(ownerText(holder({ phone_tail: null }))).toBe('สมชาย ใจดี');
    expect(ownerText(holder({ name: null }), 'Unknown customer')).toBe('Unknown customer (…5678)');
    expect(ownerText(holder({ name: '  ', phone_tail: null }), 'Unknown customer')).toBe('Unknown customer');
    expect(shortOwner(holder())).toBe('สมชาย');
    expect(shortOwner(holder({ name: 'Wilhelmina Longname' }))).toBe('Wilhelmi');
    expect(shortOwner(holder({ name: null }))).toBe('…5678');
  });
});

describe('polling the three revisions', () => {
  it('polls only while the tab is selected, the page is not hidden, an event is open and no poll is still running', () => {
    const ok = { active: true, docHidden: false, eventId: 'e1', inFlight: false };
    expect(POLL_MS).toBe(5000);
    expect(shouldPoll(ok)).toBe(true);
    expect(shouldPoll({ ...ok, active: false })).toBe(false);
    expect(shouldPoll({ ...ok, docHidden: true })).toBe(false);
    expect(shouldPoll({ ...ok, eventId: null })).toBe(false);
    expect(shouldPoll({ ...ok, inFlight: true })).toBe(false);
  });
  const revs = (boards: [string, number][], event_status: BoardRevs['event_status'] = 'active'): BoardRevs => ({ event_status, boards: boards.map(([id, rev]) => ({ id, rev, state: 'open' as const })) });
  it('a board is reloaded only when its revision changed', () => {
    const known = revMap([board({ id: 'a', rev: 1 }), board({ id: 'b', rev: 4 }), board({ id: 'c', rev: 9 })]);
    expect(known).toEqual({ a: 1, b: 4, c: 9 });
    expect(changedBoardIds(known, revs([['a', 1], ['b', 4], ['c', 9]]))).toEqual([]);
    expect(changedBoardIds(known, revs([['a', 1], ['b', 5], ['c', 9]]))).toEqual(['b']);
    expect(changedBoardIds(known, revs([['a', 2], ['b', 4], ['c', 10]]))).toEqual(['a', 'c']);
  });
  it('a board we have never seen counts as changed; a lower revision also differs (a restored database)', () => {
    expect(changedBoardIds({ a: 1 }, revs([['a', 1], ['z', 1]]))).toEqual(['z']);
    expect(changedBoardIds({ a: 8 }, revs([['a', 2]]))).toEqual(['a']);
  });
  it('a change of the event status is noticed', () => {
    expect(eventStatusChanged('active', revs([], 'paused'))).toBe(true);
    expect(eventStatusChanged('active', revs([], 'active'))).toBe(false);
    expect(eventStatusChanged('active', revs([], null))).toBe(true);
    expect(eventStatusChanged(null, revs([], 'active'))).toBe(false);
  });
  it('an older answer never replaces a newer board (a slow poll must not undo an operation)', () => {
    expect(acceptBoard(undefined, board({ rev: 1 }))).toBe(true);
    expect(acceptBoard(board({ rev: 5 }), board({ rev: 5 }))).toBe(true);
    expect(acceptBoard(board({ rev: 5 }), board({ rev: 6 }))).toBe(true);
    expect(acceptBoard(board({ rev: 5 }), board({ rev: 4 }))).toBe(false);
  });
});

describe('five separate operations', () => {
  it('there are exactly lock, unlock, mode, release, reset and undo, each with its own title and effect', () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual(['lock', 'mode', 'release', 'reset', 'undo', 'unlock']);
    const titles = Object.values(OPERATIONS).map((o) => o.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const o of Object.values(OPERATIONS)) { expect(o.effect.length).toBeGreaterThan(20); expect(o.never.length).toBeGreaterThan(10); }
  });
  it('only reset opens a confirmation panel; the rest take an inline reason', () => {
    expect(Object.values(OPERATIONS).filter((o) => o.panel).map((o) => o.key)).toEqual(['reset']);
  });
  it('lock and unlock change the state only; mode changes the mode only: the wording says what is kept', () => {
    expect(OPERATIONS.lock.effect).toMatch(/new picks/i);
    expect(OPERATIONS.lock.never).toMatch(/numbers.*stay|mode/i);
    expect(OPERATIONS.mode.never).toMatch(/kept|never rewritten|not changed/i);
    expect(OPERATIONS.release.effect).toMatch(/one number/i);
    expect(OPERATIONS.release.effect).toMatch(/pick/i);
    expect(OPERATIONS.reset.never).toMatch(/history/i);
    expect(OPERATIONS.undo.effect).toMatch(/restore/i);
  });
  it('which of lock / unlock applies follows the board state, and the other mode is the target of a switch', () => {
    expect(lockOperation(board({ state: 'open' }))).toBe('lock');
    expect(lockOperation(board({ state: 'locked' }))).toBe('unlock');
    expect(otherMode('exclusive')).toBe('shared');
    expect(otherMode('shared')).toBe('exclusive');
  });
  it('the mode switch says what happens to numbers that are already taken, in both directions', () => {
    expect(modeEffect('shared')).toMatch(/several customers/i);
    expect(modeEffect('shared')).toMatch(/already.*(one customer|stay)/i);
    expect(modeEffect('exclusive')).toMatch(/one customer/i);
    expect(modeEffect('exclusive')).toMatch(/already shared.*(stay|until)/i);
  });
  it('the reset says whether picks go back, and that an undo is possible', () => {
    expect(resetEffect(true)).toMatch(/get their picks back/i);
    expect(resetEffect(false)).toMatch(/stay used/i);
    expect(resetEffect(true)).toMatch(/undo/i);
  });
  it('an empty board has nothing to reset', () => {
    expect(resetAvailability(board({ taken: 0 }))).toEqual({ ok: false, why: 'Nothing to reset: no number is taken on this board.' });
    expect(resetAvailability(board({ taken: 3 }))).toEqual({ ok: true });
  });
  it('a reason is needed: blanks do not count', () => {
    expect(reasonOk('')).toBe(false);
    expect(reasonOk('   ')).toBe(false);
    expect(reasonOk(' round two ')).toBe(true);
  });
  it('the reset is confirmed by typing the board name exactly (case matters, edge spaces do not)', () => {
    expect(resetConfirmOk('Board A', 'Board A')).toBe(true);
    expect(resetConfirmOk('  Board A ', 'Board A')).toBe(true);
    expect(resetConfirmOk('board a', 'Board A')).toBe(false);
    expect(resetConfirmOk('', 'Board A')).toBe(false);
    expect(resetConfirmOk('', '')).toBe(false);
  });
  it('only the newest reset can be undone, and only while it is not already undone', () => {
    expect(latestUndoable([])).toBeNull();
    const old = reset({ id: 'old', at: '2026-11-20T04:00:00Z' });
    const mid = reset({ id: 'new', at: '2026-11-21T04:00:00Z' });
    expect(latestUndoable([old, mid])?.id).toBe('new');
    expect(latestUndoable([mid, old])?.id).toBe('new');
    expect(latestUndoable([old, { ...mid, undone_at: '2026-11-21T05:00:00Z' }])).toBeNull();
  });
  it('who may do what: Super Admin runs the operations; Admin and Super Admin edit events; the server checks again', () => {
    expect(mayOperate('SUPER_ADMIN')).toBe(true);
    expect(mayOperate('ADMIN')).toBe(false);
    expect(mayOperate('USER')).toBe(false);
    expect(mayOperate(undefined)).toBe(false);
    expect(mayEditEvents('ADMIN')).toBe(true);
    expect(mayEditEvents('SUPER_ADMIN')).toBe(true);
    expect(mayEditEvents('USER')).toBe(false);
  });
});

describe('what an error says', () => {
  const err = (code: string, message = code) => new ShopError(message, code);
  it('RESET_CONFLICT is shown with the SERVER\'s own words: the server uses it for "a customer is picking right now" on a reset and for "already undone" on an undo (review round 1)', () => {
    expect(opErrorText(err('RESET_CONFLICT', 'RESET_CONFLICT: a customer is picking right now, try again'))).toBe('a customer is picking right now, try again');
    expect(opErrorText(err('RESET_CONFLICT', 'RESET_CONFLICT: this reset was already undone'))).toBe('this reset was already undone');
    expect(opErrorText(err('RESET_CONFLICT', 'RESET_CONFLICT'))).not.toMatch(/taken again|cannot be restored/i);     // no detail: a generic sentence, never an undo-only claim
  });
  it('a refusal for rights is recognised from the code or the database error number', () => {
    expect(isForbidden(err('FORBIDDEN'))).toBe(true);
    expect(isForbidden(Object.assign(new Error('x'), { code: '42501' }))).toBe(true);
    expect(isForbidden(err('NUMBER_TAKEN'))).toBe(false);
    expect(isForbidden(new Error('boom'))).toBe(false);
  });
  it('each known code has its own sentence', () => {
    expect(opErrorText(err('FORBIDDEN'))).toMatch(/Super Admin/);
    expect(opErrorText(err('REASON_REQUIRED'))).toMatch(/reason/i);
    expect(opErrorText(err('CONFIRM_MISMATCH'))).toMatch(/name/i);
    expect(opErrorText(err('RESET_CONFLICT'))).toMatch(/board changed|try again/i);
    expect(opErrorText(err('NOT_FOUND'))).toMatch(/no longer|not found/i);
    expect(opErrorText(err('BOARDS_OFF'))).toMatch(/switched off/i);
    expect(opErrorText(err('NETWORK'))).toMatch(/connection/i);
  });
  it('an unknown code shows the server text without its code; a plain error shows its message', () => {
    expect(opErrorText(err('SOMETHING_ELSE', 'SOMETHING_ELSE: the thing went wrong'))).toBe('the thing went wrong');
    expect(opErrorText(new Error('boom'))).toBe('boom');
    expect(opErrorText('weird')).toBe('Something went wrong');
  });
});

describe('times are the shop\'s own (Bangkok)', () => {
  it('a moment is shown as day and time in Bangkok, whatever the browser zone is; no moment is a dash', () => {
    expect(whenText('2026-11-21T17:30:00Z')).toBe('22 Nov 2026 00:30');
    expect(whenText(null)).toBe('—');
    expect(whenText('not a date')).toBe('—');
  });
});

describe('the log in plain words', () => {
  it('an action becomes a readable label, most specific first', () => {
    expect(actionLabel('board.unlock')).toBe('Board unlocked');
    expect(actionLabel('board_lock')).toBe('Board locked');
    expect(actionLabel('board.set_mode')).toBe('Mode changed');
    expect(actionLabel('release_selection')).toBe('Number released');
    expect(actionLabel('board.reset')).toBe('Board reset');
    expect(actionLabel('board.undo_reset')).toBe('Reset undone');
    expect(actionLabel('claim')).toBe('Number picked');
    expect(actionLabel('review.resolve')).toBe('Review decided');
    expect(actionLabel('event.status')).toBe('Event status changed');
    expect(actionLabel('settle_error')).toBe('Reward error');
  });
  it('an unknown action is shown as words, never hidden', () => {
    expect(actionLabel('custom_thing.happened')).toBe('Custom thing happened');
    expect(actionLabel('')).toBe('—');
  });
  it('detail is a short list of what changed', () => {
    expect(detailText({ from: 'exclusive', to: 'shared' })).toBe('from: exclusive, to: shared');
    expect(detailText({ number: 7, name: null, empty: '' })).toBe('number: 7');
    expect(detailText({ nested: { a: 1 } })).toBe('nested: {"a":1}');
    expect(detailText({})).toBe('');
    expect(detailText({ long: 'x'.repeat(300) }).length).toBeLessThanOrEqual(141);
  });
});

describe('the event form', () => {
  it('starts with the defaults: numbers 0 to 99, no hold, no limit', () => {
    expect(emptyEventForm()).toEqual({ name: '', description: '', startsAt: '', endsAt: '', min: '0', max: '99', hold: '0', maxPer: '' });
  });
  it('reads an event with the window in Bangkok time', () => {
    const ev: EventDoc = { id: 'e1', name: 'Tom-Craft', description: 'x', status: 'draft', starts_at: '2026-11-21T00:00:00Z', ends_at: null, number_min: 0, number_max: 99, hold_minutes: 10, max_per_customer: 3, boards: [] };
    expect(formFromEvent(ev)).toEqual({ name: 'Tom-Craft', description: 'x', startsAt: '2026-11-21T07:00', endsAt: '', min: '0', max: '99', hold: '10', maxPer: '3' });
  });
  it('a valid form becomes the patch the server takes', () => {
    const r = validateEventForm({ ...emptyEventForm(), name: ' Tom-Craft ', startsAt: '2026-11-21T07:00', endsAt: '2026-12-31T23:59', hold: '10', maxPer: '3' });
    expect(r).toEqual({ ok: true, patch: { name: 'Tom-Craft', description: null, starts_at: '2026-11-21T00:00:00.000Z', ends_at: '2026-12-31T16:59:00.000Z', number_min: 0, number_max: 99, hold_minutes: 10, max_per_customer: 3 } });
  });
  it('no window and no limit are sent as null', () => {
    const r = validateEventForm({ ...emptyEventForm(), name: 'A' });
    expect(r).toMatchObject({ ok: true, patch: { starts_at: null, ends_at: null, max_per_customer: null, hold_minutes: 0 } });
  });
  it('says what is wrong, field by field', () => {
    const r = validateEventForm({ ...emptyEventForm(), name: '', min: '50', max: '10', hold: '-1', maxPer: '0', startsAt: '2026-12-31T10:00', endsAt: '2026-12-01T10:00' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['hold', 'maxPer', 'name', 'range', 'window']);
  });
  it('numbers must be whole; a half-typed date is refused; the board stays small enough to show', () => {
    const bad = (over: Partial<ReturnType<typeof emptyEventForm>>) => { const r = validateEventForm({ ...emptyEventForm(), name: 'A', ...over }); return r.ok ? [] : Object.keys(r.errors); };
    expect(bad({ min: '0.5' })).toEqual(['range']);
    expect(bad({ min: '-1' })).toEqual(['range']);
    expect(bad({ max: '' })).toEqual(['range']);
    expect(bad({ max: '1000' })).toEqual(['range']);
    expect(bad({ startsAt: '2026-11-21' })).toEqual(['window']);
    expect(bad({ hold: '2.5' })).toEqual(['hold']);
    expect(bad({ maxPer: 'x' })).toEqual(['maxPer']);
    expect(bad({})).toEqual([]);
  });
  it('the status actions follow the life of an event', () => {
    expect(statusActions('draft').map((a) => a.to)).toEqual(['active']);
    expect(statusActions('active').map((a) => a.to)).toEqual(['paused', 'closed']);
    expect(statusActions('paused').map((a) => a.to)).toEqual(['active', 'closed']);
    expect(statusActions('closed')).toEqual([]);
    expect(statusActions('draft')[0].label).toBe('Activate');
    expect(statusActions('paused')[0].label).toBe('Resume');
  });
  it('closing an event is for a Super Admin: an Admin is not offered it (the server decides again)', () => {
    expect(statusActions('active', false).map((a) => a.to)).toEqual(['paused']);
    expect(statusActions('paused', false).map((a) => a.to)).toEqual(['active']);
    expect(statusActions('draft', false).map((a) => a.to)).toEqual(['active']);
    expect(statusActions('active', true).map((a) => a.to)).toEqual(['paused', 'closed']);
  });
  it('the number range is locked for an Admin once numbers are taken, and only then', () => {
    const ev = (taken: number): EventDoc => ({ id: 'e1', name: 'x', description: null, status: 'active', starts_at: null, ends_at: null, number_min: 0, number_max: 99, hold_minutes: 0, max_per_customer: null, boards: [board({ taken: 0 }), board({ id: 'b2', taken })] });
    expect(rangeLocked('ADMIN', ev(1))).toBe(true);
    expect(rangeLocked('ADMIN', ev(0))).toBe(false);
    expect(rangeLocked('SUPER_ADMIN', ev(5))).toBe(false);
  });
  it('an edit sends only what changed, so an unchanged range is never "changed"; a new event sends everything', () => {
    const ev: EventDoc = { id: 'e1', name: 'Tom-Craft', description: null, status: 'active', starts_at: '2026-11-21T00:00:00Z', ends_at: null, number_min: 0, number_max: 99, hold_minutes: 10, max_per_customer: 3, boards: [] };
    const full = { name: 'Tom-Craft', description: null, starts_at: '2026-11-21T00:00:00.000Z', ends_at: null, number_min: 0, number_max: 99, hold_minutes: 10, max_per_customer: 3 };
    expect(eventPatchFor(ev, full)).toEqual({});                                                    // the same instant written another way is not a change
    expect(eventPatchFor(ev, { ...full, name: 'Renamed', number_max: 199, max_per_customer: null })).toEqual({ name: 'Renamed', number_max: 199, max_per_customer: null });
    expect(eventPatchFor(ev, { ...full, ends_at: '2026-12-31T16:59:00.000Z' })).toEqual({ ends_at: '2026-12-31T16:59:00.000Z' });
    expect(eventPatchFor(null, full)).toEqual(full);
  });
  it('an active event can still be outside its window, which customers feel as "not open"', () => {
    const base = { starts_at: null, ends_at: null } as Pick<EventDoc, 'starts_at' | 'ends_at'>;
    const now = Date.parse('2026-11-21T00:00:00Z');
    expect(windowState(base, now)).toBe('always');
    expect(windowState({ starts_at: '2026-11-22T00:00:00Z', ends_at: null }, now)).toBe('before');
    expect(windowState({ starts_at: '2026-11-20T00:00:00Z', ends_at: '2026-11-22T00:00:00Z' }, now)).toBe('open');
    expect(windowState({ starts_at: null, ends_at: '2026-11-20T00:00:00Z' }, now)).toBe('ended');
  });
});

describe('renaming and recolouring a board', () => {
  const b = board({ name: 'Board A', color: '#d6453a' });
  it('there is a handful of preset colours, each a valid hex colour with its own name', () => {
    expect(BOARD_COLORS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(BOARD_COLORS.map((c) => c.value)).size).toBe(BOARD_COLORS.length);
    for (const c of BOARD_COLORS) { expect(c.value).toMatch(/^#[0-9a-f]{6}$/i); expect(c.label.length).toBeGreaterThan(2); }
  });
  it('nothing changed is no patch and no error (so there is nothing to save)', () => {
    expect(boardPatch(b, { name: 'Board A', color: '#d6453a' })).toEqual({ patch: {}, errors: {} });
    expect(boardPatch(b, { name: '  Board A  ', color: '#D6453A' })).toEqual({ patch: {}, errors: {} });
  });
  it('only what changed is sent, the name trimmed', () => {
    expect(boardPatch(b, { name: '  Lucky A ', color: '#d6453a' }).patch).toEqual({ name: 'Lucky A' });
    expect(boardPatch(b, { name: 'Board A', color: '#2f9e44' }).patch).toEqual({ color: '#2f9e44' });
    expect(boardPatch(b, { name: 'Lucky A', color: '#2f9e44' }).patch).toEqual({ name: 'Lucky A', color: '#2f9e44' });
  });
  it('a blank or too long name and a colour that is not a hex colour are refused, with the reason', () => {
    expect(boardPatch(b, { name: '   ', color: '#d6453a' })).toEqual({ patch: {}, errors: { name: BOARD_FORM_ERRORS.name } });
    expect(boardPatch(b, { name: 'x'.repeat(BOARD_NAME_MAX + 1), color: '#d6453a' }).errors.name).toBe(BOARD_FORM_ERRORS.name);
    expect(boardPatch(b, { name: 'x'.repeat(BOARD_NAME_MAX), color: '#d6453a' }).errors).toEqual({});
    expect(boardPatch(b, { name: 'Board A', color: 'red' }).errors.color).toBe(BOARD_FORM_ERRORS.color);
    expect(boardPatch(b, { name: '', color: 'red' }).patch).toEqual({});
  });
});

describe('the rules summary of an event', () => {
  const rule = (over: Partial<Rule> = {}): Rule => ({ id: 'r1', kind: 'board_pick', name: 'Picks', active: true, starts_at: null, ends_at: null, spend_step: 300, reward_amount: 1, basis: 'per_bill', max_per_order: null, category_codes: [], include_skus: [], exclude_skus: [], include_packs: false, only_profile_ids: null, event_id: 'e1', board_slots: null, stats: { bills: 0, granted: 0 }, ...over });
  it('says how many picks a bill earns, and the limit per bill when there is one', () => {
    expect(ruleSummary(rule())).toEqual({ key: 'Every {step} on one bill earns {n} pick(s)', vars: { step: '฿300', n: 1 } });
    expect(ruleSummary(rule({ spend_step: 150.5, reward_amount: 2, max_per_order: 4 }))).toEqual({ key: 'Every {step} on one bill earns {n} pick(s), up to {max} per bill', vars: { step: '฿150.50', n: 2, max: 4 } });
  });
});

describe('every sentence of the screens has a Thai text', () => {
  const missing = (xs: string[]) => [...new Set(xs)].filter((s) => t('th', s) === s);
  it('the operation wording, status labels and error sentences', () => { expect(missing(ALL_TEXTS)).toEqual([]); });
  it('every text the two screens show through T(...) or <Tx>', () => {
    const src = ['src/rewards/EventsOnline.tsx', 'src/rewards/BoardAdmin.tsx'].map((f) => readFileSync(f, 'utf8')).join('\n');
    const found = [...src.matchAll(/\bT\('((?:[^'\\]|\\.)+)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
      .concat([...src.matchAll(/<Tx>([^<{]+)<\/Tx>/g)].map((m) => m[1].trim()));
    expect(found.length).toBeGreaterThan(20);
    expect(missing(found)).toEqual([]);
  });
  it('the dictionary keeps the Thai of an English key unchanged for the placeholders', () => { expect(TH['Type {word} to confirm']).toBeTruthy(); });
});
