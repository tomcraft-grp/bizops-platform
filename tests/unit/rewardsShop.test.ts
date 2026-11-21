// Pure helpers of the customer Rewards screen and the cart preview (src/shop/rewardsView.ts): which bills count, how the board is worded and when it is read-only,
// when the 5 s poll reloads the board, which server error refreshes the board or keeps the idempotency key, keyboard movement in the grid, the cart preview text.
// The rules themselves (per-bill arithmetic, exclusivity) live in the database and are tested there; these tests prove what the SCREEN does with the answers.
import { describe, expect, it } from 'vitest';
import type { BoardCell, BoardState, CartPreview, PickSummary, PublicBoard } from '../../src/rewards/api';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';
import {
  accessKey, boardAccess, billView, cellKind, claimPlan, gridMove, mineChips, padNumber, pickRule, previewView, replaceBoard, revsChanged, revsOf, safeColor, sumPicks, visibleBills,
} from '../../src/shop/rewardsView';

const cell = (n: number, s: BoardCell['s'] = 'free', c = 0): BoardCell => ({ n, s, c });
const board = (id: string, over: Partial<PublicBoard> = {}): PublicBoard => ({ id, slot: 1, name: 'Board A', color: '#e11d48', mode: 'exclusive', state: 'open', rev: 1, taken: 0, numbers: Array.from({ length: 100 }, (_, n) => cell(n)), ...over });
const state = (over: Partial<BoardState> = {}): BoardState => ({
  event: { id: 'e1', name: 'Lucky numbers', status: 'active', number_min: 0, number_max: 99, hold_minutes: 0, starts_at: null, ends_at: null },
  boards: [board('b1', { slot: 1 }), board('b2', { slot: 2, name: 'Board B', rev: 4 }), board('b3', { slot: 3, name: 'Board C', mode: 'shared' })],
  rights: { earned: 4, used: 1, remaining: 3 }, ...over,
});
const pick = (over: Partial<PickSummary> = {}): PickSummary => ({ rule_id: 'r1', rule_name: 'Pick per bill', event_id: 'e1', spend_step: 300, reward_amount: 1, earned: 4, used: 1, remaining: 3, bills: [], ...over });
const line = (over: Partial<CartPreview['lines'][number]>): CartPreview['lines'][number] => ({ kind: 'board_pick', name: 'x', eligible_amount: 0, reward: 0, next_reward_in: null, next_reward_total: null, ...over });

describe('picks summary', () => {
  it('adds earned, used and remaining over the rules of the event', () => {
    expect(sumPicks([pick(), pick({ rule_id: 'r2', earned: 2, used: 0, remaining: 2 })])).toEqual({ earned: 6, used: 1, remaining: 5 });
    expect(sumPicks([])).toEqual({ earned: 0, used: 0, remaining: 0 });
  });
  it('the step and the picks per step are read from the rule the server sends', () => {
    expect(pickRule([pick()])).toEqual({ step: 300, reward: 1 });
    expect(pickRule([pick({ spend_step: 300, reward_amount: 2 })])).toEqual({ step: 300, reward: 2 });
    expect(pickRule([pick({ spend_step: 0 }), pick({ rule_id: 'r2', spend_step: 500, reward_amount: 1 })])).toEqual({ step: 500, reward: 1 });   // the first usable rule
  });
  it('a server that leaves a number out (or sends nonsense) gets wording without a number: nothing is guessed', () => {
    const bare = (o: object) => pick(o as Partial<PickSummary>);
    expect(pickRule([bare({ spend_step: undefined })])).toBeNull(); expect(pickRule([bare({ reward_amount: undefined })])).toBeNull();
    expect(pickRule([pick({ spend_step: 0 })])).toBeNull(); expect(pickRule([pick({ reward_amount: 0 })])).toBeNull(); expect(pickRule([bare({ spend_step: '300' })])).toBeNull();
    expect(pickRule([])).toBeNull();
  });
});

describe('what each bill says', () => {
  const bill = (over: Partial<PickSummary['bills'][number]> = {}) => ({ order_id: 'o1', order_no: 'ORD-000001', created_at: '2026-11-20T03:00:00Z', eligible_amount: 850, rights: 2, state: 'counted' as const, ...over });
  it('a counted bill shows the picks it earned', () => { expect(billView(bill())).toEqual({ kind: 'earned', picks: 2 }); expect(billView(bill({ rights: 1, eligible_amount: 599 }))).toEqual({ kind: 'earned', picks: 1 }); });
  it('a counted bill that earned nothing says so (299 earns no pick)', () => { expect(billView(bill({ eligible_amount: 299, rights: 0 }))).toEqual({ kind: 'none', picks: 0 }); });
  it('an unpaid bill counts once paid, whatever the server says about rights', () => { expect(billView(bill({ state: 'waiting_payment', rights: 0 }))).toEqual({ kind: 'waiting', picks: 0 }); });
  it('a bill whose payment was reversed reads "taken back"', () => { expect(billView(bill({ state: 'taken_back', rights: 0 }))).toEqual({ kind: 'taken_back', picks: 0 }); });
  it('a long list shows the first three until the customer asks for all', () => {
    const many = Array.from({ length: 7 }, (_, i) => bill({ order_id: 'o' + i }));
    expect(visibleBills(many, false)).toHaveLength(3); expect(visibleBills(many, true)).toHaveLength(7); expect(visibleBills(many.slice(0, 3), false)).toHaveLength(3);
  });
});

describe('board access: when the grid is read-only', () => {
  const s = state();
  it('open, active, picks left: the customer can pick', () => { expect(boardAccess(s.event, s.boards[0], s.rights)).toBe('ok'); });
  it('no picks left: read-only with the hint', () => { expect(boardAccess(s.event, s.boards[0], { earned: 1, used: 1, remaining: 0 })).toBe('no_rights'); });
  it('a locked board is read-only even with picks', () => { expect(boardAccess(s.event, board('b1', { state: 'locked' }), s.rights)).toBe('locked'); });
  it('a paused, closed or draft event is read-only, and wins over the board lock', () => {
    for (const status of ['paused', 'closed', 'draft'] as const) expect(boardAccess({ ...s.event!, status }, board('b1', { state: 'locked' }), s.rights)).toBe('event_' + status);
  });
  it('no event at all', () => { expect(boardAccess(null, null, s.rights)).toBe('no_event'); });
  it('each reason has its own banner text, in both languages; the others have none', () => {
    for (const a of ['event_draft', 'event_paused', 'event_closed', 'locked'] as const) { const k = accessKey(a)!; expect(tr('th', k).length, a).toBeGreaterThan(0); expect(tr('en', k).length, a).toBeGreaterThan(0); }
    expect(accessKey('ok')).toBeNull(); expect(accessKey('no_rights')).toBeNull(); expect(accessKey('no_event')).toBeNull();
  });
});

describe('what a tap on a number does', () => {
  it('a free or shared number can be picked while the board allows it', () => {
    expect(cellKind(cell(7), 'ok')).toBe('pickable'); expect(cellKind(cell(7, 'shared', 2), 'ok')).toBe('pickable');
  });
  it('a taken number or my own number is never pickable and says why', () => { expect(cellKind(cell(7, 'taken'), 'ok')).toBe('taken'); expect(cellKind(cell(7, 'mine'), 'ok')).toBe('mine'); });
  it('when the board is read-only a free number is not pickable', () => { expect(cellKind(cell(7), 'no_rights')).toBe('blocked'); expect(cellKind(cell(7), 'locked')).toBe('blocked'); expect(cellKind(cell(7, 'taken'), 'locked')).toBe('taken'); });
});

describe('the 5 second poll', () => {
  it('reads the revisions of the board on screen', () => {
    expect(revsOf(state())).toEqual({ event_status: 'active', boards: [{ id: 'b1', rev: 1, state: 'open' }, { id: 'b2', rev: 4, state: 'open' }, { id: 'b3', rev: 1, state: 'open' }] });
  });
  it('reloads only when a revision, a lock or the event status changed', () => {
    const shown = revsOf(state());
    expect(revsChanged(shown, structuredClone(shown))).toBe(false);
    expect(revsChanged(shown, { ...shown, boards: shown.boards.map((b) => (b.id === 'b2' ? { ...b, rev: 5 } : b)) })).toBe(true);
    expect(revsChanged(shown, { ...shown, boards: shown.boards.map((b) => (b.id === 'b3' ? { ...b, state: 'locked' as const } : b)) })).toBe(true);
    expect(revsChanged(shown, { ...shown, event_status: 'paused' })).toBe(true);
  });
  it('a different set of boards (a new event) is a change; nothing shown yet is a change', () => {
    const shown = revsOf(state());
    expect(revsChanged(shown, { ...shown, boards: shown.boards.slice(0, 2) })).toBe(true);
    expect(revsChanged(shown, { ...shown, boards: [...shown.boards.slice(0, 2), { id: 'x', rev: 1, state: 'open' }] })).toBe(true);
    expect(revsChanged(null, shown)).toBe(true);
  });
  it('the same boards in another order are not a change', () => {
    const shown = revsOf(state());
    expect(revsChanged(shown, { ...shown, boards: [...shown.boards].reverse() })).toBe(false);
  });
});

describe('the server answer replaces the board (never a guess)', () => {
  it('swaps in the returned board and the returned rights, leaving the other boards alone', () => {
    const s = state();
    const claimed = board('b1', { rev: 2, taken: 1, numbers: Array.from({ length: 100 }, (_, n) => (n === 7 ? cell(7, 'mine', 1) : cell(n))) });
    const next = replaceBoard(s, claimed, { earned: 4, used: 2, remaining: 2 });
    expect(next.boards[0].numbers[7].s).toBe('mine'); expect(next.boards[0].rev).toBe(2); expect(next.boards[1]).toBe(s.boards[1]); expect(next.rights.remaining).toBe(2);
    expect(s.boards[0].numbers[7].s).toBe('free');          // the old state is untouched
  });
  it('a board the screen does not know is ignored', () => { const s = state(); expect(replaceBoard(s, board('zzz'), s.rights).boards.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']); });
  it('lists my numbers across the boards from the server\'s own marks', () => {
    const s = state({ boards: [board('b1', { numbers: [cell(7, 'mine'), cell(8)] }), board('b2', { slot: 2, name: 'Board B', numbers: [cell(23, 'mine'), cell(5, 'shared', 3)] }), board('b3', { slot: 3, name: 'Board C' })] });
    expect(mineChips(s)).toEqual([{ board: 'Board A', n: 7 }, { board: 'Board B', n: 23 }]);
  });
});

describe('what a claim answer does to the screen', () => {
  it('the contract errors that mean the board is out of date refresh it and drop the idempotency key', () => {
    for (const code of ['NUMBER_TAKEN', 'BOARD_LOCKED', 'NO_ENTITLEMENT', 'EVENT_NOT_ACTIVE', 'HOLD_EXPIRED', 'NUMBER_OUT_OF_RANGE', 'LIMIT_REACHED'] as const) {
      const p = claimPlan(code); expect(p.refresh, code).toBe(true); expect(p.keepKey, code).toBe(false); expect(p.keepBar, code).toBe(false);
      expect(SHOP_KEYS, code).toContain(p.message);
    }
  });
  it('a dropped connection keeps the key and the confirm bar so that Confirm retries the SAME request', () => {
    expect(claimPlan('NETWORK')).toMatchObject({ keepKey: true, keepBar: true, message: 'err.network' });
    expect(claimPlan('ERROR')).toMatchObject({ keepKey: true, keepBar: true });
  });
  it('a reused or invalid key gets a new key next time; every message exists in both languages', () => {
    expect(claimPlan('KEY_REUSED')).toMatchObject({ keepKey: false, keepBar: false });
    for (const code of ['NUMBER_TAKEN', 'BOARD_LOCKED', 'NO_ENTITLEMENT', 'EVENT_NOT_ACTIVE', 'HOLD_EXPIRED', 'REWARDS_OFF', 'BOARDS_OFF', 'FORBIDDEN', 'WHATEVER']) {
      const m = claimPlan(code).message; expect(tr('th', m).length, code).toBeGreaterThan(0); expect(tr('en', m).length, code).toBeGreaterThan(0);
    }
    expect(tr('th', claimPlan('NUMBER_TAKEN').message)).not.toBe(tr('th', 'err.generic'));
  });
});

describe('grid keyboard movement (10 per row)', () => {
  it('arrows move one cell or one row and stop at the edges', () => {
    expect(gridMove(0, 'ArrowRight', 10, 100)).toBe(1); expect(gridMove(0, 'ArrowLeft', 10, 100)).toBe(0); expect(gridMove(9, 'ArrowRight', 10, 100)).toBe(9);
    expect(gridMove(5, 'ArrowDown', 10, 100)).toBe(15); expect(gridMove(95, 'ArrowDown', 10, 100)).toBe(95); expect(gridMove(5, 'ArrowUp', 10, 100)).toBe(5); expect(gridMove(15, 'ArrowUp', 10, 100)).toBe(5);
  });
  it('Home and End go to the ends of the row', () => { expect(gridMove(47, 'Home', 10, 100)).toBe(40); expect(gridMove(47, 'End', 10, 100)).toBe(49); });
  it('a short last row never moves past the last number', () => { expect(gridMove(95, 'End', 10, 98)).toBe(97); expect(gridMove(88, 'ArrowDown', 10, 98)).toBe(88); expect(gridMove(97, 'ArrowRight', 10, 98)).toBe(97); });
  it('other keys do nothing', () => { expect(gridMove(5, 'a', 10, 100)).toBe(5); expect(gridMove(5, 'Tab', 10, 100)).toBe(5); });
});

describe('small formatting helpers', () => {
  it('numbers are padded to the width of the board range', () => { expect(padNumber(7, 99)).toBe('07'); expect(padNumber(0, 99)).toBe('00'); expect(padNumber(7, 999)).toBe('007'); expect(padNumber(42, 99)).toBe('42'); });
  it('a board colour is only used when it is a plain hex colour', () => { expect(safeColor('#e11d48')).toBe('#e11d48'); expect(safeColor('#abc')).toBe('#abc'); expect(safeColor('red; background:url(x)')).toBeNull(); expect(safeColor('')).toBeNull(); expect(safeColor(undefined)).toBeNull(); });
});

describe('cart preview text (from rw_preview_cart: reward, next_reward_in, next_reward_total)', () => {
  const p = (lines: CartPreview['lines'], enabled = true): CartPreview => ({ enabled, lines });
  it('is hidden when rewards are off, when there are no lines, or when a line has nothing to say', () => {
    expect(previewView(null)).toEqual([]); expect(previewView(p([], true))).toEqual([]);
    expect(previewView(p([line({ eligible_amount: 850, reward: 2, next_reward_in: 50, next_reward_total: 3 })], false))).toEqual([]);
    expect(previewView(p([line({ eligible_amount: 0 })]))).toEqual([]);
    expect(previewView(p([line({ eligible_amount: 0, next_reward_in: 300, next_reward_total: 1 })]))).toEqual([]);   // nothing eligible in the cart: no nagging
  });
  it('850 earns 2 picks once paid and 50 more makes 3 in total', () => {
    expect(previewView(p([line({ eligible_amount: 850, reward: 2, next_reward_in: 50, next_reward_total: 3 })]))).toEqual([{ kind: 'picks', amount: 850, n: 2, more: 50, next: 3 }]);
  });
  it('below the first step it says how much more earns the first pick', () => {
    expect(previewView(p([line({ eligible_amount: 250, reward: 0, next_reward_in: 50, next_reward_total: 1 })]))).toEqual([{ kind: 'picks', amount: 250, n: 0, more: 50, next: 1 }]);
  });
  it('a rule that gives 2 picks per step: a bill of 450 (step 300) earns 2, and 150 more makes 4 in total (never "a third")', () => {
    const vm = previewView(p([line({ eligible_amount: 450, reward: 2, next_reward_in: 150, next_reward_total: 4 })]));
    expect(vm).toEqual([{ kind: 'picks', amount: 450, n: 2, more: 150, next: 4 }]);
    expect(tr('th', 'rw.cart.more', { more: '฿150', total: vm[0].next! })).toBe('ซื้อเพิ่มอีก ฿150 รวมเป็น 4 สิทธิ์');
    expect(tr('en', 'rw.cart.more', { more: '฿150', total: vm[0].next! })).toBe('฿150 more for 4 picks in total');
  });
  it('at the cap (next_reward_in and next_reward_total null) there is no "more" part; points lines are worded as points', () => {
    expect(previewView(p([line({ eligible_amount: 600, reward: 2 })]))).toEqual([{ kind: 'picks', amount: 600, n: 2, more: null, next: null }]);
    expect(previewView(p([line({ kind: 'points', eligible_amount: 850, reward: 8, next_reward_in: 50, next_reward_total: 9 })]))).toEqual([{ kind: 'points', amount: 850, n: 8, more: 50, next: 9 }]);
  });
  it('an older server that sends no next_reward_total: the "more" part is left out rather than guessed', () => {
    const old = { kind: 'board_pick', name: 'x', eligible_amount: 850, reward: 2, next_reward_in: 50 } as unknown as CartPreview['lines'][number];
    expect(previewView(p([old]))).toEqual([{ kind: 'picks', amount: 850, n: 2, more: null, next: null }]);
  });
});

describe('the new texts', () => {
  it('every rewards text exists in Thai and English with the same placeholders', () => {
    const keys = SHOP_KEYS.filter((k) => k.startsWith('rw.') || k.startsWith('acc.rewards'));
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) {
      const th = tr('th', k), en = tr('en', k); const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(th.length, k).toBeGreaterThan(0); expect(en.length, k).toBeGreaterThan(0); expect(ph(th), k).toBe(ph(en));
    }
  });
  it('the summary reads "Earned 4 · Used 1 · 3 left to pick"', () => {
    expect([tr('en', 'rw.earned', { n: 4 }), tr('en', 'rw.used', { n: 1 }), tr('en', 'rw.left', { n: 3 })].join(' · ')).toBe('Earned 4 · Used 1 · 3 left to pick');
  });
});
