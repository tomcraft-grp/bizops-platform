// Pure helpers of the customer Rewards screen (Rewards.tsx) and the cart preview line: what each bill says, when the board is read-only, when the 5 s poll
// reloads the board, what a failed claim does to the screen, keyboard movement in the number grid. No React, no network: tests/unit/rewardsShop.test.ts.
// The rules themselves (per-bill arithmetic, who may hold a number) are decided by the database; nothing here computes picks or checks ownership.
import type { BoardRevs, BoardState, CartPreview, PickBill, PickSummary, PublicBoard, BoardCell, Rights } from '../rewards/api';
import type { K } from './i18n';

/** How often the open board asks the server for its three revision numbers. */
export const POLL_MS = 5000;
export const GRID_COLS = 10;
/** The bills list shows this many until the customer asks for all. */
export const BILLS_COLLAPSED = 3;

// ------------------------------------------------------------------------------------------------ the summary
export const sumPicks = (picks: PickSummary[]): Rights => picks.reduce((a, p) => ({ earned: a.earned + p.earned, used: a.used + p.used, remaining: a.remaining + p.remaining }), { earned: 0, used: 0, remaining: 0 });

/**
 * "Every ฿300 on one bill earns 2 picks": the rule's step and reward come with each picks[] entry (rw_my_rewards). If a server leaves either out, the screen words
 * things without a number (null here) rather than invent one.
 */
export function pickRule(picks: PickSummary[]): { step: number; reward: number } | null {
  for (const p of picks) {
    const step: unknown = p.spend_step; const reward: unknown = p.reward_amount;
    if (typeof step === 'number' && step > 0 && typeof reward === 'number' && reward > 0) return { step, reward };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ bills
export type BillKind = 'earned' | 'none' | 'waiting' | 'taken_back';
/** What a bill's row says. An unpaid bill never claims picks and a reversed one is "taken back", whatever `rights` holds. */
export function billView(b: PickBill): { kind: BillKind; picks: number } {
  if (b.state === 'waiting_payment') return { kind: 'waiting', picks: 0 };
  if (b.state === 'taken_back') return { kind: 'taken_back', picks: 0 };
  return b.rights > 0 ? { kind: 'earned', picks: b.rights } : { kind: 'none', picks: 0 };
}
export const visibleBills = (bills: PickBill[], all: boolean): PickBill[] => (all || bills.length <= BILLS_COLLAPSED ? bills : bills.slice(0, BILLS_COLLAPSED));

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
/** The numbers the server marked as mine, board by board (what "Your numbers" lists). */
export const mineChips = (s: BoardState): { board: string; n: number }[] =>
  [...s.boards].sort((a, b) => a.slot - b.slot).flatMap((b) => b.numbers.filter((c) => c.s === 'mine').map((c) => ({ board: b.name, n: c.n })));

// ------------------------------------------------------------------------------------------------ the poll and the server's answers
export const revsOf = (s: BoardState): BoardRevs => ({ event_status: s.event?.status ?? null, boards: s.boards.map((b) => ({ id: b.id, rev: b.rev, state: b.state })) });
/** Reload only when something on screen is out of date: nothing shown yet, another event status, another set of boards, a new revision or lock. */
export function revsChanged(shown: BoardRevs | null, polled: BoardRevs): boolean {
  if (!shown || shown.event_status !== polled.event_status || shown.boards.length !== polled.boards.length) return true;
  const by = new Map(shown.boards.map((b) => [b.id, b] as const));
  return polled.boards.some((b) => { const s = by.get(b.id); return !s || s.rev !== b.rev || s.state !== b.state; });
}
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
