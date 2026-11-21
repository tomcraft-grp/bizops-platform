// The back-office event boards part of the fake backend: events, three boards each, selections, the five Super Admin operations and the review queue. It mirrors the CONTRACT of
// docs/superpowers/plans/2026-11-21-rewards-boards-sku-sync.md (the SQL implements and tests it for real). This file proves the SCREENS only. It is a separate fake that a spec
// hooks in front of FakeShop.rpc (`hook(shop)`), so it does not touch fakeBackend.ts / fakeRewards.ts (the customer-side fake): functions it does not know fall through.
import type { FakeShop } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';
import type { AdminBoard, Board, BoardLogRow, EventDoc, Holder, ResetRow, ReviewItem, Rule } from '../../src/rewards/api';

interface FSel { id: string; board: string; n: number; profile: string; name: string | null; tail: string; status: 'reserved' | 'confirmed' | 'released' | 'reset'; exclusive: boolean; at: string; resetId?: string }
interface FBoard { id: string; event: string; slot: 1 | 2 | 3; name: string; color: string; mode: 'exclusive' | 'shared'; state: 'open' | 'locked'; rev: number; lastReset: string | null }
interface FEvent { id: string; name: string; description: string | null; status: EventDoc['status']; starts_at: string | null; ends_at: string | null; number_min: number; number_max: number; hold_minutes: number; max_per_customer: number | null }
interface FReset { id: string; board: string; at: string; by: string; reason: string; returned: boolean; sels: string[]; undone_at: string | null }
interface FLog { event: string; board: string | null; row: BoardLogRow }

export const EVENT_ID = 'ev-1';
export const BOARD_A = 'bd-a', BOARD_B = 'bd-b', BOARD_C = 'bd-c';

export class FakeEventsAdmin {
  boardsEnabled = true;
  events: FEvent[] = [{ id: EVENT_ID, name: 'Tom-Craft Lucky Numbers', description: 'Pick a number with each ฿300 bill', status: 'active', starts_at: null, ends_at: null, number_min: 0, number_max: 99, hold_minutes: 0, max_per_customer: null }];
  boards: FBoard[] = [
    { id: BOARD_A, event: EVENT_ID, slot: 1, name: 'Board A', color: '#d6453a', mode: 'exclusive', state: 'open', rev: 1, lastReset: null },
    { id: BOARD_B, event: EVENT_ID, slot: 2, name: 'Board B', color: '#2a78d6', mode: 'shared', state: 'open', rev: 1, lastReset: null },
    { id: BOARD_C, event: EVENT_ID, slot: 3, name: 'Board C', color: '#2f9e44', mode: 'exclusive', state: 'locked', rev: 1, lastReset: null },
  ];
  sels: FSel[] = [];
  resets: FReset[] = [];
  logs: FLog[] = [];
  review: ReviewItem[] = [];
  rules: Rule[] = [];
  /** every sentence this fake raised for a refused call (so a spec can see the server said no) */
  refused: string[] = [];
  private n = 0;
  private shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }

  /** put this fake in front of the shop fake: what it handles never reaches the others */
  hook() {
    const orig = this.shop.rpc.bind(this.shop);
    this.shop.rpc = (fn: string, a: Record<string, unknown>, viaHttp?: boolean) => { const r = this.rpc(fn, a); return r === NOT_HANDLED ? orig(fn, a, viaHttp) : r; };
    return this;
  }

  private err(m: string): never { throw new Error(m); }
  private role() { return this.shop.profile.role; }
  private staff() { if (!['ADMIN', 'SUPER_ADMIN'].includes(this.role())) { this.refused.push('staff'); this.err('permission denied: staff only'); } }
  private super(): void { if (this.role() !== 'SUPER_ADMIN') { this.refused.push('super'); this.err('permission denied: Super Admin only'); } }
  private reason(r: unknown): string { const s = String(r ?? '').trim(); if (!s) this.err('REASON_REQUIRED'); return s; }
  private board(id: unknown) { const b = this.boards.find((x) => x.id === id); if (!b) this.err('NOT_FOUND'); return b; }
  private eventOf(b: FBoard) { return this.events.find((e) => e.id === b.event)!; }
  private active(b: FBoard) { return this.sels.filter((s) => s.board === b.id && (s.status === 'reserved' || s.status === 'confirmed')); }
  private bump(b: FBoard) { b.rev += 1; }
  private audit(b: FBoard | null, event: string, action: string, reason: string | null, detail: Record<string, unknown> = {}) {
    this.logs.push({ event, board: b?.id ?? null, row: { at: new Date(Date.now() + this.logs.length * 1000).toISOString(), actor_name: 'Boss', action, reason, detail } });
  }

  // ---------------------------------------------------------------- test controls (what a customer does somewhere else)
  /** a customer takes a number through the customer app: the board's revision goes up like the server's claim does */
  take(boardId: string, n: number, name: string | null, tail: string, o: { exclusive?: boolean; status?: 'reserved' | 'confirmed' } = {}): FSel {
    const b = this.board(boardId);
    const s: FSel = { id: `sel-${++this.n}`, board: b.id, n, profile: `p-${name ?? tail}`, name, tail, status: o.status ?? 'confirmed', exclusive: o.exclusive ?? b.mode === 'exclusive', at: new Date(Date.now() + this.n * 1000).toISOString() };
    this.sels.push(s); this.bump(b); this.audit(b, b.event, 'claim', null, { number: n });
    return s;
  }
  addReview(over: Partial<ReviewItem> = {}) {
    this.review.push({ entitlement_id: `ent-${this.review.length + 1}`, profile_id: 'p-review', profile_name: 'วิภา ทดสอบ', rule_name: 'Number picks per bill', selection_id: 'sel-x', board_name: 'Board A', number: 7, since: '2026-11-20T03:00:00Z', ...over });
  }

  // ---------------------------------------------------------------- shapes
  private boardJson(b: FBoard): Board {
    const ev = this.eventOf(b);
    return { id: b.id, event_id: b.event, slot: b.slot, name: b.name, color: b.color, mode: b.mode, state: b.state, rev: b.rev, taken: new Set(this.active(b).map((s) => s.n)).size, total: ev.number_max - ev.number_min + 1, last_reset_id: b.lastReset };
  }
  private eventJson(e: FEvent): EventDoc { return { ...e, boards: this.boards.filter((b) => b.event === e.id).map((b) => this.boardJson(b)) }; }
  private holder(s: FSel): Holder { return { selection_id: s.id, profile_id: s.profile, name: s.name, phone_tail: s.tail, status: s.status as 'reserved' | 'confirmed', exclusive: s.exclusive, at: s.at }; }
  private adminBoard(b: FBoard): AdminBoard {
    const byN = new Map<number, Holder[]>();
    for (const s of this.active(b)) byN.set(s.n, [...(byN.get(s.n) ?? []), this.holder(s)]);
    const resets: ResetRow[] = this.resets.filter((r) => r.board === b.id).map((r) => ({ id: r.id, at: r.at, by_name: r.by, reason: r.reason, returned_picks: r.returned, affected: r.sels.length, undone_at: r.undone_at }));
    return { board: this.boardJson(b), numbers: [...byN].map(([n, holders]) => ({ n, holders })), resets, log: this.logs.filter((l) => l.board === b.id).map((l) => l.row) };
  }

  // ---------------------------------------------------------------- the contract
  rpc(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'rw_settings_public': return { enabled: true, boards_enabled: this.boardsEnabled };
      case 'rw_admin_events': this.staff(); return this.events.map((e) => this.eventJson(e));
      case 'rw_admin_rules': this.staff(); return this.rules;
      case 'rw_admin_save_event': {
        this.staff();
        const p = a.p_patch as Partial<FEvent>;
        if (a.p_id == null) {
          const e: FEvent = { id: `ev-${this.events.length + 1}`, name: String(p.name), description: p.description ?? null, status: 'draft', starts_at: p.starts_at ?? null, ends_at: p.ends_at ?? null, number_min: p.number_min ?? 0, number_max: p.number_max ?? 99, hold_minutes: p.hold_minutes ?? 0, max_per_customer: p.max_per_customer ?? null };
          this.events.push(e);
          (['A', 'B', 'C'] as const).forEach((l, i) => this.boards.push({ id: `${e.id}-b${i + 1}`, event: e.id, slot: (i + 1) as 1 | 2 | 3, name: `Board ${l}`, color: ['#d6453a', '#2a78d6', '#2f9e44'][i], mode: 'exclusive', state: 'open', rev: 1, lastReset: null }));
          return this.eventJson(e);
        }
        const e = this.events.find((x) => x.id === a.p_id); if (!e) this.err('NOT_FOUND');
        // like the server: once numbers are held, changing the range is for a Super Admin, and a range may not leave a held number outside it
        const heldNs = this.sels.filter((x) => (x.status === 'reserved' || x.status === 'confirmed') && this.boards.find((b) => b.id === x.board)?.event === e.id).map((x) => x.n);
        const rangeChanged = (p.number_min != null && p.number_min !== e.number_min) || (p.number_max != null && p.number_max !== e.number_max);
        if (rangeChanged && heldNs.length) this.super();
        if (heldNs.some((n) => n < (p.number_min ?? e.number_min) || n > (p.number_max ?? e.number_max))) this.err('NUMBER_OUT_OF_RANGE: number ' + Math.max(...heldNs) + ' is held, so the range cannot end below it');
        Object.assign(e, p); for (const b of this.boards.filter((x) => x.event === e.id)) this.bump(b); return this.eventJson(e);
      }
      case 'rw_admin_set_event_status': {
        this.staff();
        const e = this.events.find((x) => x.id === a.p_id); if (!e) this.err('NOT_FOUND');
        if (a.p_status === 'closed') this.super();                       // closing an event is for a Super Admin
        const why = this.reason(a.p_reason);
        e.status = a.p_status as FEvent['status']; this.audit(null, e.id, 'event.status', why, { to: e.status });
        return this.eventJson(e);
      }
      case 'rw_admin_save_board': {
        this.staff();
        const b = this.board(a.p_board); const patch = a.p_patch as { name?: string; color?: string };
        if (patch.name !== undefined) {
          const nm = patch.name.trim(); if (!nm) this.err('BAD_RULE: a board needs a name');
          if (this.boards.some((x) => x.event === b.event && x.id !== b.id && x.name === nm)) this.err('NAME_TAKEN: another board of this event already has that name');
          b.name = nm;
        }
        if (patch.color !== undefined) b.color = patch.color;
        this.bump(b); this.audit(b, b.event, 'board.save', null, patch as Record<string, unknown>); return this.boardJson(b);
      }
      case 'rw_admin_board': this.staff(); return this.adminBoard(this.board(a.p_board));
      case 'rw_admin_log': {
        this.staff();
        const rows = this.logs.filter((l) => l.event === a.p_event).map((l) => l.row).reverse();
        return rows.slice(Number(a.p_offset ?? 0), Number(a.p_offset ?? 0) + Number(a.p_limit ?? 50));
      }
      case 'rw_board_rev': {
        if (!this.boardsEnabled) this.err('BOARDS_OFF');                                // like the server: the customer-side revision call refuses while the boards are switched off
        const ev = this.events.find((e) => e.id === (a.p_event ?? EVENT_ID))!;
        return { event_status: ev.status, boards: this.boards.filter((b) => b.event === ev.id).map((b) => ({ id: b.id, rev: b.rev, state: b.state })) };
      }
      case 'rw_admin_review_queue': this.staff(); return this.review;
      case 'rw_admin_resolve_review': {
        this.super(); this.reason(a.p_reason);
        if (a.p_action !== 'keep' && a.p_action !== 'release') this.err('BAD_RULE');
        this.review = this.review.filter((r) => r.entitlement_id !== a.p_entitlement);
        return this.review;
      }
      // ---- the five Super Admin operations: each separate, each needs SUPER_ADMIN and a reason, each bumps the revision and answers with the board
      case 'rw_board_lock': case 'rw_board_unlock': {
        this.super(); const why = this.reason(a.p_reason); const b = this.board(a.p_board);
        b.state = fn === 'rw_board_lock' ? 'locked' : 'open'; this.bump(b); this.audit(b, b.event, fn === 'rw_board_lock' ? 'board.lock' : 'board.unlock', why); return this.adminBoard(b);
      }
      case 'rw_board_set_mode': {
        this.super(); const why = this.reason(a.p_reason); const b = this.board(a.p_board);
        const from = b.mode; b.mode = a.p_mode as FBoard['mode'];        // only the mode: the selections keep the `exclusive` they were claimed with
        this.bump(b); this.audit(b, b.event, 'board.set_mode', why, { from, to: b.mode }); return this.adminBoard(b);
      }
      case 'rw_release_selection': {
        this.super(); const why = this.reason(a.p_reason);
        const s = this.sels.find((x) => x.id === a.p_selection && (x.status === 'reserved' || x.status === 'confirmed')); if (!s) this.err('NOT_FOUND');
        const b = this.board(s.board); s.status = 'released'; this.bump(b); this.audit(b, b.event, 'release_selection', why, { number: s.n }); return this.adminBoard(b);
      }
      case 'rw_board_reset': {
        this.super(); const why = this.reason(a.p_reason); const b = this.board(a.p_board);
        if (a.p_confirm !== b.name) this.err('CONFIRM_MISMATCH');
        const id = `rs-${this.resets.length + 1}`; const sels = this.active(b);
        for (const s of sels) { s.status = 'reset'; s.resetId = id; }
        this.resets.push({ id, board: b.id, at: new Date(Date.now() + this.resets.length * 1000).toISOString(), by: 'Boss', reason: why, returned: !!a.p_return_picks, sels: sels.map((s) => s.id), undone_at: null });
        b.lastReset = id; this.bump(b); this.audit(b, b.event, 'board.reset', why, { affected: sels.length, return_picks: !!a.p_return_picks }); return this.adminBoard(b);
      }
      case 'rw_board_undo_reset': {
        this.super(); const why = this.reason(a.p_reason);
        const r = this.resets.find((x) => x.id === a.p_reset && !x.undone_at); if (!r) this.err('NOT_FOUND');
        const b = this.board(r.board);
        const mine = this.sels.filter((s) => r.sels.includes(s.id));
        if (this.active(b).some((t) => mine.some((s) => s.n === t.n))) this.err('RESET_CONFLICT: a number cleared by this reset has been taken again, so it cannot be restored');   // the server explains itself
        for (const s of mine) s.status = 'confirmed';
        r.undone_at = new Date().toISOString(); this.bump(b); this.audit(b, b.event, 'board.undo_reset', why); return this.adminBoard(b);
      }
      default: return NOT_HANDLED;
    }
  }
}
