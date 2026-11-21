// Pure helpers of the customer Rewards screen (Rewards.tsx) and the cart preview line: what each bill says, when the board is read-only, when the 5 s poll
// reloads the board, what a failed claim does to the screen, keyboard movement in the number grid. No React, no network: tests/unit/rewardsShop.test.ts.
// The rules themselves (per-bill arithmetic, who may hold a number) are decided by the database; nothing here computes picks or checks ownership.
import type { BillState, BoardRevs, BoardState, CartPreview, MySelection, PickSummary, PointsEntry, PublicBoard, BoardCell, Rights } from '../rewards/api';
import type { K } from './i18n';

/** How often the open board asks the server for its three revision numbers. */
export const POLL_MS = 5000;
export const GRID_COLS = 10;
/** The bills list shows this many until the customer asks for all. */
export const BILLS_COLLAPSED = 3;
/** The points history shows this many until the customer asks for all. */
export const HISTORY_COLLAPSED = 5;
/** This many failed revision reads in a row and the board says it may be out of date. */
export const STALE_AFTER = 2;

// ------------------------------------------------------------------------------------------------ the summary
export const sumPicks = (picks: PickSummary[]): Rights => picks.reduce((a, p) => ({ earned: a.earned + p.earned, used: a.used + p.used, remaining: a.remaining + p.remaining }), { earned: 0, used: 0, remaining: 0 });

/** A rule of the event as the customer is told about it. */
export interface PickRuleInfo { id: string; name: string; step: number; reward: number }
/** "Every ฿300 on one bill earns 2 picks": every rule whose step and picks-per-step the server sent (rw_my_rewards). An entry without usable numbers is left out: nothing is invented. */
export function pickRules(picks: PickSummary[]): PickRuleInfo[] {
  const out: PickRuleInfo[] = [];
  for (const p of picks) {
    const step: unknown = p.spend_step; const reward: unknown = p.reward_amount;
    if (typeof step === 'number' && step > 0 && typeof reward === 'number' && reward > 0) out.push({ id: p.rule_id, name: p.rule_name, step, reward });
  }
  return out;
}
/** "How much more on one bill earns a pick": the smallest step of the rules. */
export const smallestStep = (rules: PickRuleInfo[]): number | null => (rules.length ? Math.min(...rules.map((r) => r.step)) : null);

// ------------------------------------------------------------------------------------------------ bills
export type BillKind = 'earned' | 'none' | 'waiting' | 'taken_back';
/** What a bill's row says. An unpaid bill never claims picks and a reversed one is "taken back", whatever `rights` holds. */
export function billView(b: { state: BillState; rights: number }): { kind: BillKind; picks: number } {
  if (b.state === 'waiting_payment') return { kind: 'waiting', picks: 0 };
  if (b.state === 'taken_back') return { kind: 'taken_back', picks: 0 };
  return b.rights > 0 ? { kind: 'earned', picks: b.rights } : { kind: 'none', picks: 0 };
}
export const visibleBills = <T,>(bills: T[], all: boolean): T[] => (all || bills.length <= BILLS_COLLAPSED ? bills : bills.slice(0, BILLS_COLLAPSED));

/** What one rule said about a bill. */
export interface BillPart { rule_id: string; rule_name: string; eligible_amount: number; rights: number; state: BillState }
/** ONE row per bill, whatever the number of rules that listed it. `sameAmount` = every rule saw the same eligible amount (then the row shows that amount and the total picks; otherwise each rule's part is shown). */
export interface BillGroup { order_id: string; order_no: string; created_at: string; eligible_amount: number; rights: number; state: BillState; parts: BillPart[]; sameAmount: boolean }
/**
 * Bills of every rule of the event, grouped by order. Picks = the sum over the rules that COUNT the bill. State: counted if any rule counts it, otherwise taken back if
 * any rule took it back, otherwise waiting for payment. Newest bill first.
 */
export function groupBills(picks: PickSummary[]): BillGroup[] {
  const by = new Map<string, BillGroup>();
  for (const p of picks) {
    for (const b of p.bills) {
      const part: BillPart = { rule_id: p.rule_id, rule_name: p.rule_name, eligible_amount: b.eligible_amount, rights: b.rights, state: b.state };
      const g = by.get(b.order_id);
      if (g) g.parts.push(part); else by.set(b.order_id, { order_id: b.order_id, order_no: b.order_no, created_at: b.created_at, eligible_amount: 0, rights: 0, state: 'waiting_payment', parts: [part], sameAmount: true });
    }
  }
  const out = [...by.values()];
  for (const g of out) {
    const counted = g.parts.filter((x) => x.state === 'counted');
    g.state = counted.length ? 'counted' : g.parts.some((x) => x.state === 'taken_back') ? 'taken_back' : 'waiting_payment';
    g.rights = counted.reduce((n, x) => n + x.rights, 0);
    g.eligible_amount = Math.max(...g.parts.map((x) => x.eligible_amount));
    g.sameAmount = g.parts.every((x) => x.eligible_amount === g.parts[0].eligible_amount);
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.order_no.localeCompare(a.order_no));
}

// ------------------------------------------------------------------------------------------------ points
export const visibleHistory = <T,>(h: T[], all: boolean): T[] => (all || h.length <= HISTORY_COLLAPSED ? h : h.slice(0, HISTORY_COLLAPSED));
/** "+8", "−3" (a real minus sign), "0". */
export const signedPoints = (n: number): string => (n > 0 ? '+' : n < 0 ? '\u2212' : '') + Math.abs(n).toLocaleString('en-US');
export const historyKey = (k: PointsEntry['kind']): K => (k === 'earn' ? 'rw.hist.earn' : k === 'reverse' ? 'rw.hist.reverse' : 'rw.hist.adjust');

// ------------------------------------------------------------------------------------------------ my numbers
export interface MyNumber { id: string; board: string; n: number; reserved: boolean; expires_at: string | null }
/**
 * The customer's live numbers from rw_my_rewards.selections, ordered by board then number. The server lists them for ANY event status (a paused or closed event
 * does not hide what the customer holds), so this list does not depend on a board being loaded.
 */
export const myNumbers = (sel: MySelection[]): MyNumber[] =>
  sel.filter((s) => s.status === 'reserved' || s.status === 'confirmed')
    .map((s) => ({ id: s.id, board: s.board_name, n: s.number, reserved: s.status === 'reserved', expires_at: s.status === 'reserved' ? s.expires_at : null }))
    .sort((a, b) => a.board.localeCompare(b.board) || a.n - b.n);

// ------------------------------------------------------------------------------------------------ the board
export type Access = 'ok' | 'no_event' | 'event_draft' | 'event_paused' | 'event_closed' | 'locked' | 'no_rights';
/** Why the grid is (or is not) pickable. The event wins over the board's lock, the lock over missing picks. The server still decides on every claim. */
export function boardAccess(event: BoardState['event'], board: PublicBoard | null, rights: Rights): Access {
  if (!event || !board) return 'no_event';
  if (event.status !== 'active') return `event_${event.status}`;
  if (board.state === 'locked') return 'locked';
  // a right is valid on the board slots of its rule: the picks that count are the ones THIS board can take (an older server without the per-board count: the event-wide picks)
  const left = typeof board.remaining === 'number' ? board.remaining : rights.remaining;
  return left > 0 ? 'ok' : 'no_rights';
}
/** The banner text of a reason the board cannot be picked (no picks left has its own hint, because it carries the amount). */
export function accessKey(a: Access): K | null {
  switch (a) {
    case 'event_draft': return 'rw.ev.draft';
    case 'event_paused': return 'rw.ev.paused';
    case 'event_closed': return 'rw.ev.closed';
    case 'locked': return 'rw.locked';
    default: return null;
  }
}
export type CellKind ='pickable' | 'blocked' | 'taken' | 'mine';
/** A number that is someone's (or mine) is never pickable; a free or shared one is pickable only while the board is open to this customer. */
export function cellKind(c: BoardCell, access: Access): CellKind {
  if (c.s === 'mine') return 'mine';
  if (c.s === 'taken') return 'taken';
  return access === 'ok' ? 'pickable' : 'blocked';
}
export const padNumber = (n: number, max: number): string => String(n).padStart(Math.max(2, String(max).length), '0');
/** Only a plain hex colour is ever written into a style attribute. */
export const safeColor = (c: string | null | undefined): string | null => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null);
/** Arrow keys, Home and End inside the 10-wide grid; a move that would leave the grid stays where it is. */
export function gridMove(i: number, key: string, cols: number, total: number): number {
  const last = total - 1; const row = Math.floor(i / cols);
  switch (key) {
    case 'ArrowLeft': return i % cols === 0 ? i : i - 1;
    case 'ArrowRight': return i % cols === cols - 1 || i >= last ? i : i + 1;
    case 'ArrowUp': return i - cols >= 0 ? i - cols : i;
    case 'ArrowDown': return i + cols <= last ? i + cols : i;
    case 'Home': return row * cols;
    case 'End': return Math.min(row * cols + cols - 1, last);
    default: return i;
  }
}

// ------------------------------------------------------------------------------------------------ the poll and the server's answers
export const revsOf = (s: BoardState): BoardRevs => ({ event_status: s.event?.status ?? null, boards: s.boards.map((b) => ({ id: b.id, rev: b.rev, state: b.state })) });
/** Reload only when something on screen is out of date: nothing shown yet, another event status, another set of boards, a new revision or lock. */
export function revsChanged(shown: BoardRevs | null, polled: BoardRevs): boolean {
  if (!shown || shown.event_status !== polled.event_status || shown.boards.length !== polled.boards.length) return true;
  const by = new Map(shown.boards.map((b) => [b.id, b] as const));
  return polled.boards.some((b) => { const s = by.get(b.id); return !s || s.rev !== b.rev || s.state !== b.state; });
}
/** Failed revision reads in a row: two or more and the screen says it may be out of date; one success clears it (a single failure between successes never warns). */
export const pollHealth = (fails: number, ok: boolean): { fails: number; stale: boolean } => (ok ? { fails: 0, stale: false } : { fails: fails + 1, stale: fails + 1 >= STALE_AFTER });
/** The server's answer to a claim (its board and its rights) goes into the shown state as it is; the other boards stay. */
export const replaceBoard = (s: BoardState, board: PublicBoard, rights: Rights): BoardState => ({ ...s, boards: s.boards.map((b) => (b.id === board.id ? board : b)), rights });

export interface ClaimPlan { message: K; refresh: boolean; keepKey: boolean; keepBar: boolean }
/**
 * What a failed claim does. A refusal about the board's state (taken, locked, no picks, event closed, hold expired…) means the screen was out of date: show the
 * reason, reload the board, close the confirm bar and forget the key. A lost connection (or an unknown server failure) may have been processed: keep the
 * confirm bar and the SAME key so that Confirm retries the same request, which the server answers with the original result instead of a second pick.
 */
export function claimPlan(code: string): ClaimPlan {
  const stale = (message: K): ClaimPlan => ({ message, refresh: true, keepKey: false, keepBar: false });
  switch (code) {
    case 'NUMBER_TAKEN': return stale('rw.err.taken');
    case 'BOARD_LOCKED': return stale('rw.err.locked');
    case 'NO_ENTITLEMENT': return stale('rw.err.noRights');
    case 'EVENT_NOT_ACTIVE': return stale('rw.err.event');
    case 'HOLD_EXPIRED': return stale('rw.err.hold');
    case 'NUMBER_OUT_OF_RANGE': return stale('rw.err.range');
    case 'LIMIT_REACHED': return stale('rw.err.limit');
    case 'REWARDS_OFF': case 'BOARDS_OFF': return stale('rw.off');
    case 'NETWORK': return { message: 'rw.err.network', refresh: true, keepKey: true, keepBar: true };      // its own wording: the checkout's "no duplicate order" does not apply to a pick
    case 'ERROR': return { message: 'err.generic', refresh: true, keepKey: true, keepBar: true };
    case 'FORBIDDEN': return { message: 'err.signin', refresh: false, keepKey: false, keepBar: false };
    default: return stale('err.generic');           // KEY_REUSED, INVALID_KEY, NOT_FOUND, a code from a newer server: a new attempt gets a new key
  }
}

/**
 * What a failed rw_confirm_selection does AFTER a successful claim (an event with a hold): the number is already held for the customer, so a lost connection must
 * NOT read "picked": it says the number is held but not confirmed and keeps the question open so that Confirm can be tried again (same selection). Any other
 * answer is the same as for a claim.
 */
export function confirmPlan(code: string): ClaimPlan {
  if (code === 'NETWORK' || code === 'ERROR') return { message: 'rw.held.msg', refresh: true, keepKey: false, keepBar: true };
  return claimPlan(code);
}

// ------------------------------------------------------------------------------------------------ cart preview
/** `more` = baht more for the next step (next_reward_in); `next` = what the bill would then earn in all (next_reward_total). Both are set or both are null: the "more" part is shown only when the server gave both. */
export interface PreviewVM { kind: 'picks' | 'points'; amount: number; n: number; more: number | null; next: number | null }
/** The lines of rw_preview_cart worth showing: rewards on, something eligible in the cart, and either a reward or a next step to say. */
export function previewView(p: CartPreview | null): PreviewVM[] {
  if (!p || !p.enabled) return [];
  return p.lines
    .filter((l) => l.eligible_amount > 0 && (l.reward > 0 || (l.next_reward_in != null && l.next_reward_in > 0)))
    .map((l) => {
      const next = l.next_reward_in != null && l.next_reward_in > 0 && typeof l.next_reward_total === 'number' ? l : null;
      return { kind: l.kind === 'points' ? 'points' : 'picks', amount: l.eligible_amount, n: l.reward, more: next ? next.next_reward_in : null, next: next ? next.next_reward_total : null };
    });
}
