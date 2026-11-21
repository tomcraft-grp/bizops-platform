// Pure helpers of the customer Rewards screen and the cart preview (src/shop/rewardsView.ts): which bills count, how the board is worded and when it is read-only,
// when the 5 s poll reloads the board, which server error refreshes the board or keeps the idempotency key, keyboard movement in the grid, the cart preview text.
// The rules themselves (per-bill arithmetic, exclusivity) live in the database and are tested there; these tests prove what the SCREEN does with the answers.
import { describe, expect, it } from 'vitest';
import type { BoardCell, BoardState, CartPreview, MySelection, PickBill, PickSummary, PointsEntry, PublicBoard } from '../../src/rewards/api';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';
import {
  accessKey, boardAccess, billView, cellKind, claimPlan, confirmPlan, gridMove, groupBills, myNumbers, padNumber, pickRules, pollHealth, previewView, replaceBoard, revsChanged, revsOf, safeColor,
  signedPoints, smallestStep, STALE_AFTER, sumPicks, visibleBills, visibleHistory, historyKey,
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

describe('one row per bill, whatever the number of rules (groupBills)', () => {
  const bill = (over: Partial<PickBill> = {}): PickBill => ({ order_id: 'o1', order_no: 'ORD-000001', created_at: '2026-11-20T03:00:00Z', eligible_amount: 850, rights: 2, state: 'counted', ...over });
  const rule = (id: string, bills: PickBill[], over: Partial<PickSummary> = {}) => pick({ rule_id: id, rule_name: 'Rule ' + id, bills, ...over });
  it('a bill that two rules list becomes ONE row and its picks are the sum over the rules', () => {
    const g = groupBills([rule('r1', [bill({ rights: 2 })]), rule('r2', [bill({ rights: 1 })], { spend_step: 500 })]);
    expect(g).toHaveLength(1); expect(g[0]).toMatchObject({ order_id: 'o1', rights: 3, state: 'counted', eligible_amount: 850, sameAmount: true });
    expect(g[0].parts.map((x) => [x.rule_id, x.rights])).toEqual([['r1', 2], ['r2', 1]]);
    expect(billView(g[0])).toEqual({ kind: 'earned', picks: 3 });
  });
  it('every order id appears once (no duplicate React keys), newest first', () => {
    const g = groupBills([rule('r1', [bill({ order_id: 'o1', created_at: '2026-11-18T00:00:00Z' }), bill({ order_id: 'o2', order_no: 'ORD-000002', created_at: '2026-11-20T00:00:00Z' })]), rule('r2', [bill({ order_id: 'o2', order_no: 'ORD-000002', created_at: '2026-11-20T00:00:00Z' })])]);
    expect(g.map((x) => x.order_id)).toEqual(['o2', 'o1']);
  });
  it('state: counted if ANY rule counts the bill, else taken back if any rule took it back, else waiting for payment', () => {
    const st = (...states: PickBill['state'][]) => groupBills(states.map((s, i) => rule('r' + i, [bill({ state: s, rights: s === 'counted' ? 1 : 0 })])))[0].state;
    expect(st('counted', 'waiting_payment')).toBe('counted'); expect(st('waiting_payment', 'counted')).toBe('counted'); expect(st('taken_back', 'counted')).toBe('counted');
    expect(st('waiting_payment', 'taken_back')).toBe('taken_back'); expect(st('taken_back', 'waiting_payment')).toBe('taken_back');
    expect(st('waiting_payment', 'waiting_payment')).toBe('waiting_payment'); expect(st('taken_back')).toBe('taken_back'); expect(st('waiting_payment')).toBe('waiting_payment');
  });
  it('only rules that count a bill add picks to it: a counted bill is never inflated by a rule that took it back', () => {
    const g = groupBills([rule('r1', [bill({ state: 'counted', rights: 2 })]), rule('r2', [bill({ state: 'taken_back', rights: 5 })])]);
    expect(g[0]).toMatchObject({ state: 'counted', rights: 2 });
  });
  it('a counted bill that no rule paid anything for reads "no picks"; a waiting one claims none whatever the server says', () => {
    expect(billView(groupBills([rule('r1', [bill({ eligible_amount: 250, rights: 0 })])])[0])).toEqual({ kind: 'none', picks: 0 });
    expect(billView(groupBills([rule('r1', [bill({ state: 'waiting_payment', rights: 3 })])])[0])).toEqual({ kind: 'waiting', picks: 0 });
  });
  it('rules that saw different eligible amounts (different scopes) are told apart: the row shows the total and each rule its own amount', () => {
    const g = groupBills([rule('r1', [bill({ eligible_amount: 900, rights: 3 })]), rule('r2', [bill({ eligible_amount: 500, rights: 1 })], { spend_step: 500 })])[0];
    expect(g.sameAmount).toBe(false); expect(g.rights).toBe(4); expect(g.eligible_amount).toBe(900);
    expect(g.parts.map((x) => [x.rule_name, x.eligible_amount, x.rights])).toEqual([['Rule r1', 900, 3], ['Rule r2', 500, 1]]);
  });
  it('a bill listed by only one of the rules is a one-part row', () => {
    const g = groupBills([rule('r1', [bill()]), rule('r2', [])]); expect(g).toHaveLength(1); expect(g[0].parts).toHaveLength(1); expect(g[0].sameAmount).toBe(true);
  });
  it('no rules, no bills', () => { expect(groupBills([])).toEqual([]); expect(groupBills([rule('r1', [])])).toEqual([]); });
  it('the collapsed list works on grouped rows', () => {
    const many = Array.from({ length: 5 }, (_, i) => bill({ order_id: 'o' + i, created_at: '2026-11-1' + i + 'T00:00:00Z' }));
    expect(visibleBills(groupBills([rule('r1', many)]), false)).toHaveLength(3);
  });
});

describe('the rules, described one by one', () => {
  it('every rule with usable numbers is listed with its name, step and picks per step', () => {
    expect(pickRules([pick({ rule_id: 'r1', rule_name: 'Per bill', spend_step: 300, reward_amount: 1 }), pick({ rule_id: 'r2', rule_name: 'Big bill', spend_step: 1000, reward_amount: 3 })]))
      .toEqual([{ id: 'r1', name: 'Per bill', step: 300, reward: 1 }, { id: 'r2', name: 'Big bill', step: 1000, reward: 3 }]);
  });
  it('a rule without usable numbers is left out (nothing is invented); none usable = empty', () => {
    const bare = pick({ rule_id: 'r3' }) as unknown as Record<string, unknown>; delete bare.spend_step;
    expect(pickRules([pick({ rule_id: 'r1' }), bare as unknown as PickSummary]).map((r) => r.id)).toEqual(['r1']); expect(pickRules([bare as unknown as PickSummary])).toEqual([]); expect(pickRules([])).toEqual([]);
  });
  it('a missing, zero or non-numeric step or reward is never turned into a number', () => {
    const odd = (o: object) => pick(o as Partial<PickSummary>);
    for (const bad of [odd({ spend_step: undefined }), odd({ reward_amount: undefined }), pick({ spend_step: 0 }), pick({ reward_amount: 0 }), odd({ spend_step: '300' }), odd({ spend_step: null })]) expect(pickRules([bad])).toEqual([]);
  });
  it('the picks per step are kept (a rule that gives 2 per step)', () => { expect(pickRules([pick({ spend_step: 300, reward_amount: 2 })])[0]).toMatchObject({ step: 300, reward: 2 }); });
  it('"how much more on a bill earns a pick" uses the smallest step of the rules', () => {
    expect(smallestStep(pickRules([pick({ spend_step: 500 }), pick({ rule_id: 'r2', spend_step: 300 })]))).toBe(300); expect(smallestStep([])).toBeNull();
  });
});

describe('points (the phase where only points are live)', () => {
  const e = (over: Partial<PointsEntry> = {}): PointsEntry => ({ at: '2026-11-20T03:00:00Z', points: 8, kind: 'earn', note: null, order_no: 'ORD-000001', ...over });
  it('shows a sign on every movement', () => { expect([8, -3, 0, 1200].map(signedPoints)).toEqual(['+8', '−3', '0', '+1,200']); });
  it('the history shows the latest five until the customer asks for all', () => {
    const h = Array.from({ length: 12 }, (_, i) => e({ order_no: 'ORD-' + i }));
    expect(visibleHistory(h, false)).toHaveLength(5); expect(visibleHistory(h, true)).toHaveLength(12); expect(visibleHistory(h.slice(0, 5), false)).toHaveLength(5);
  });
  it('every kind of movement has its own words in both languages', () => {
    for (const k of ['earn', 'reverse', 'adjust'] as const) { const key = historyKey(k); expect(tr('th', key).length, k).toBeGreaterThan(0); expect(tr('en', key).length, k).toBeGreaterThan(0); }
    expect(new Set(['earn', 'reverse', 'adjust'].map((k) => historyKey(k as 'earn'))).size).toBe(3);
  });
});

describe('a poll that keeps failing is not silent forever', () => {
  it('stays quiet after one failure and warns after two in a row', () => {
    expect(STALE_AFTER).toBe(2);
    let h = pollHealth(0, false); expect(h).toEqual({ fails: 1, stale: false });
    h = pollHealth(h.fails, false); expect(h).toEqual({ fails: 2, stale: true });
    h = pollHealth(h.fails, false); expect(h).toEqual({ fails: 3, stale: true });
  });
  it('one success clears the warning and the count', () => {
    expect(pollHealth(5, true)).toEqual({ fails: 0, stale: false });
    const h = pollHealth(pollHealth(0, false).fails, true); expect(h).toEqual({ fails: 0, stale: false });   // a single failure between two successes never warns
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
  // review round 1: a right is valid on the board slots of its rule, so event-wide picks do not make EVERY board pickable
  it('picks left on the event but none valid on THIS board: read-only (the server would refuse the tap)', () => {
    expect(boardAccess(s.event, board('b1', { remaining: 0 }), { earned: 3, used: 0, remaining: 3 })).toBe('no_rights');
  });
  it('picks valid on this board: the customer can pick, even when another board has none', () => {
    expect(boardAccess(s.event, board('b2', { remaining: 2 }), { earned: 2, used: 0, remaining: 2 })).toBe('ok');
  });
  it('an older server without the per-board count: the event-wide picks decide, as before', () => {
    const old = board('b1'); delete (old as { remaining?: number }).remaining;
    expect(boardAccess(s.event, old, { earned: 1, used: 0, remaining: 1 })).toBe('ok');
    expect(boardAccess(s.event, old, { earned: 1, used: 1, remaining: 0 })).toBe('no_rights');
  });
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
});

describe('my numbers (rw_my_rewards.selections: live numbers of any event, even a paused or closed one)', () => {
  const sel = (over: Partial<MySelection>): MySelection => ({ id: 's1', event_id: 'e1', board_id: 'b1', board_name: 'Board A', number: 7, status: 'confirmed', expires_at: null, ...over });
  it('lists board and number, ordered by board then number', () => {
    const rows = myNumbers([sel({ id: 'a', board_name: 'Board B', number: 3 }), sel({ id: 'b', number: 23 }), sel({ id: 'c', number: 7 })]);
    expect(rows.map((r) => [r.board, r.n])).toEqual([['Board A', 7], ['Board A', 23], ['Board B', 3]]);
  });
  it('a reserved (held) number says it is not confirmed yet and carries its deadline; a confirmed one does not', () => {
    const [held, done] = myNumbers([sel({ id: 'h', number: 1, status: 'reserved', expires_at: '2026-11-21T10:05:00Z' }), sel({ id: 'd', number: 2 })]);
    expect(held).toMatchObject({ id: 'h', reserved: true, expires_at: '2026-11-21T10:05:00Z' }); expect(done).toMatchObject({ id: 'd', reserved: false, expires_at: null });
  });
  it('nothing in, nothing out; a status the screen does not know is not shown as a live number', () => {
    expect(myNumbers([])).toEqual([]); expect(myNumbers([sel({ status: 'released' as unknown as MySelection['status'] })])).toEqual([]);
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
    expect(claimPlan('NETWORK')).toMatchObject({ keepKey: true, keepBar: true, message: 'rw.err.network' });
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

describe('a number that is held but not confirmed (the claim worked, the confirm did not)', () => {
  it('a lost connection or an unknown failure keeps the question open and says the number is held, never "picked"', () => {
    for (const code of ['NETWORK', 'ERROR']) { const p = confirmPlan(code); expect(p.message, code).toBe('rw.held.msg'); expect(p.keepBar, code).toBe(true); expect(p.refresh, code).toBe(true); }
    expect(tr('th', 'rw.held.msg', { board: 'Board A', n: '14' })).toContain('ยังไม่ได้ยืนยัน'); expect(tr('en', 'rw.held.msg', { board: 'Board A', n: '14' })).toContain('not confirmed');
    expect(tr('en', 'rw.held.msg', { board: 'Board A', n: '14' })).not.toMatch(/^Picked/);
  });
  it('any other answer is the same as for a claim: an expired hold or a closed event closes the question with its reason', () => {
    expect(confirmPlan('HOLD_EXPIRED')).toEqual(claimPlan('HOLD_EXPIRED')); expect(confirmPlan('EVENT_NOT_ACTIVE')).toEqual(claimPlan('EVENT_NOT_ACTIVE')); expect(confirmPlan('NOT_FOUND').keepBar).toBe(false);
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
