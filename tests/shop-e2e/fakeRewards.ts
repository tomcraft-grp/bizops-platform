// The rewards part of the fake backend (per-bill board picks, the three event boards, the cart preview). It mirrors the CONTRACT of
// docs/superpowers/plans/2026-11-21-rewards-boards-sku-sync.md, which the SQL migrations implement and test for real. This file proves the SCREENS only.
// Customer functions only (rw_settings_public, rw_my_rewards, rw_preview_cart, rw_board_rev, rw_board_state, rw_claim_number, rw_confirm_selection); every other
// function falls through to the other fakes (NOT_HANDLED).
//
// What it keeps the way the database does: the server decides. A claim checks the event, the board lock, the number range, the customer's rights and who holds the
// number, in that order; a number held by someone else is NUMBER_TAKEN even when the screen says it is free; the same key returns the same answer (KEY_REUSED for a
// different request). Rights are PER BILL: floor(eligible bill amount / step) x reward, bills never combined (299 -> 0, 300 -> 1, 599 -> 1, 600 -> 2, 850 -> 2,
// 900 -> 3, 1000 -> 3, 1200 -> 4). Two customers can share ONE `world` (the boards) while each has their own orders, which is how a spec shows two people on one board.
import type { FakeShop } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';

type Mode = 'exclusive' | 'shared';
type EventStatus = 'draft' | 'active' | 'paused' | 'closed';
export interface FBoard { id: string; slot: 1 | 2 | 3; name: string; color: string; mode: Mode; state: 'open' | 'locked'; rev: number }
export interface FEvent { id: string; name: string; status: EventStatus; number_min: number; number_max: number; hold_minutes: number; starts_at: string | null; ends_at: string | null; boards: FBoard[] }
export interface FSelection { id: string; board_id: string; number: number; who: string; status: 'reserved' | 'confirmed' | 'released'; exclusive: boolean; expires_at: string | null }
/** The boards and who holds what: shared by every customer of one test. */
export class RewardsWorld {
  event: FEvent | null = null;
  selections: FSelection[] = [];
  keys = new Map<string, { hash: string; out: { selection: FSelection } }>();
  n = 0;
}
type FOrder = FakeShop['orders'][number];

/** floor(amount / step) x reward in whole satang: never a float, never rounded up. */
export const picksFor = (amount: number, step: number, reward = 1): number => Math.floor(Math.round(amount * 100) / Math.round(step * 100)) * reward;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const active = (s: FSelection) => s.status === 'reserved' || s.status === 'confirmed';

export class FakeRewards {
  /** false = the database ships dark (rw_settings.enabled = false): the shop looks exactly as before */
  enabled = false;
  boardsEnabled = true;
  /** the signed-in customer's identity in the shared world (never sent to the browser) */
  me = 'cust-a';
  world = new RewardsWorld();
  rule = { id: 'rule-1', name: 'สิทธิ์เลือกเลขต่อบิล', step: 300, reward: 1, excludeSkus: [] as string[], onlySkus: [] as string[] };
  /** false = an older server that leaves spend_step / reward_amount out of rw_my_rewards.picks[] and next_reward_total out of rw_preview_cart (the screen must then invent no numbers) */
  sendStep = true;
  points = 0;
  /** orders whose payment was reversed (their picks are taken back) */
  private reversed = new Set<string>();

  private shop: FakeShop;                                  // (no parameter property: Playwright loads this file with Node's strip-only TypeScript)
  constructor(shop: FakeShop) { this.shop = shop; }

  // ------------------------------------------------------------ test controls: what staff and other customers do
  /** turn rewards on with an active event "Lucky numbers" and three boards: A and B exclusive, C shared, numbers 0-99 */
  enable(over: Partial<Pick<FEvent, 'name' | 'status' | 'hold_minutes' | 'starts_at' | 'ends_at'>> = {}) {
    this.enabled = true;
    if (!this.world.event) {
      const b = (slot: 1 | 2 | 3, name: string, color: string, mode: Mode): FBoard => ({ id: `board-${slot}`, slot, name, color, mode, state: 'open', rev: 1 });
      this.world.event = { id: 'event-1', name: 'จับเลขนำโชค', status: 'active', number_min: 0, number_max: 99, hold_minutes: 0, starts_at: null, ends_at: null,
        boards: [b(1, 'Board A', '#e11d48', 'exclusive'), b(2, 'Board B', '#2563eb', 'exclusive'), b(3, 'Board C', '#059669', 'shared')] };
    }
    Object.assign(this.world.event, over);
    return this;
  }
  /** an order of this customer whose eligible amount is `amount` (one line), optionally paid in full */
  addBill(amount: number, opts: { paid?: boolean } = {}): FOrder {
    const o = this.shop.seedOrder(amount);
    const l = o.items[0]; l.unit_price = amount; l.qty = 1; l.line_total = amount; o.subtotal = amount; o.total = amount; o.invoice.amount = amount;
    if (opts.paid !== false) this.shop.verifyPayment(o.order_no);
    return o;
  }
  /** staff reversed the payment: the bill is no longer paid and its picks are taken back */
  reversePayment(orderNo: string) {
    const o = this.shop.orders.find((x) => x.order_no === orderNo)!; o.invoice.paid = 0; o.invoice.refunded = o.invoice.amount; this.reversed.add(o.id);
  }
  /** another customer holds this number (exclusive unless the board is shared) */
  takeElsewhere(slot: 1 | 2 | 3, n: number, who = 'someone-else') {
    const ev = this.world.event!; const b = ev.boards.find((x) => x.slot === slot)!;
    this.world.selections.push({ id: `sel-${++this.world.n}`, board_id: b.id, number: n, who, status: 'confirmed', exclusive: b.mode === 'exclusive', expires_at: null }); b.rev++;
  }
  /** this customer already used a pick on a number (without going through the screen) */
  pickFor(slot: 1 | 2 | 3, n: number, who = this.me) { this.takeElsewhere(slot, n, who); }
  lockBoard(slot: 1 | 2 | 3, locked = true) { const b = this.world.event!.boards.find((x) => x.slot === slot)!; b.state = locked ? 'locked' : 'open'; b.rev++; }
  setEventStatus(status: EventStatus) { this.world.event!.status = status; this.world.event!.boards.forEach((b) => b.rev++); }
  setMode(slot: 1 | 2 | 3, mode: Mode) { const b = this.world.event!.boards.find((x) => x.slot === slot)!; b.mode = mode; b.rev++; }
  /** how many numbers this customer holds in total */
  held(who = this.me) { return this.world.selections.filter((s) => s.who === who && active(s)).length; }

  // ------------------------------------------------------------ what the customer's bills earn
  private ruleOk(sku: string) { return !this.rule.excludeSkus.includes(sku) && (!this.rule.onlySkus.length || this.rule.onlySkus.includes(sku)); }
  private bills() {
    const rows: { order_id: string; order_no: string; created_at: string; eligible_amount: number; rights: number; state: 'counted' | 'waiting_payment' | 'taken_back' }[] = [];
    for (const o of [...this.shop.orders].sort((x, y) => y.created_at.localeCompare(x.created_at))) {
      const eligible = o.items.filter((i) => this.ruleOk(i.sku_code)).reduce((s, i) => s + i.line_total, 0);
      const code = this.shop.invoiceState(o.invoice).status_code;
      const reversed = this.reversed.has(o.id);
      if (!reversed && (o.status === 'cancelled' || o.status === 'returned' || eligible <= 0)) continue;
      const state = reversed ? 'taken_back' : [5, 6].includes(code) ? 'counted' : 'waiting_payment';
      rows.push({ order_id: o.id, order_no: o.order_no, created_at: o.created_at, eligible_amount: eligible, rights: state === 'counted' ? picksFor(eligible, this.rule.step, this.rule.reward) : 0, state });
    }
    return rows;
  }
  private rights() {
    const earned = this.bills().reduce((s, b) => s + b.rights, 0); const used = this.held();
    return { earned, used, remaining: Math.max(earned - used, 0) };
  }

  // ------------------------------------------------------------ the boards, as the customer may see them (no identities)
  private publicBoard(b: FBoard) {
    const ev = this.world.event!;
    const numbers: { n: number; s: 'free' | 'taken' | 'mine' | 'shared'; c: number }[] = [];
    for (let n = ev.number_min; n <= ev.number_max; n++) {
      const here = this.world.selections.filter((s) => s.board_id === b.id && s.number === n && active(s));
      const mineHere = here.some((s) => s.who === this.me);
      const s = mineHere ? 'mine' : here.some((x) => x.exclusive) ? 'taken' : here.length ? 'shared' : 'free';
      numbers.push({ n, s, c: here.length });
    }
    return { id: b.id, slot: b.slot, name: b.name, color: b.color, mode: b.mode, state: b.state, rev: b.rev, taken: numbers.filter((x) => x.c > 0).length, numbers };
  }
  private boardState() {
    const ev = this.world.event; if (!this.boardsEnabled) throw new Error('BOARDS_OFF');
    if (!ev) return { event: null, boards: [], rights: this.rights() };
    return { event: { id: ev.id, name: ev.name, status: ev.status, number_min: ev.number_min, number_max: ev.number_max, hold_minutes: ev.hold_minutes, starts_at: ev.starts_at, ends_at: ev.ends_at },
      boards: ev.boards.map((b) => this.publicBoard(b)), rights: this.rights() };
  }

  rpc(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'rw_settings_public': return { enabled: this.enabled, boards_enabled: this.enabled && this.boardsEnabled };
      case 'rw_my_rewards': {
        if (!this.enabled) return { enabled: false, boards_enabled: false, points: 0, points_history: [], picks: [], selections: [] };
        const r = this.rights(); const ev = this.world.event;
        const extra = this.sendStep ? { spend_step: this.rule.step, reward_amount: this.rule.reward } : {};
        return { enabled: true, boards_enabled: this.boardsEnabled, points: this.points, points_history: [],
          picks: [{ rule_id: this.rule.id, rule_name: this.rule.name, event_id: ev?.id ?? null, ...r, bills: this.bills(), ...extra }],
          selections: this.world.selections.filter((s) => s.who === this.me && active(s)).map((s) => { const b = ev?.boards.find((x) => x.id === s.board_id); return { id: s.id, event_id: ev?.id ?? '', board_id: s.board_id, board_name: b?.name ?? '', number: s.number, status: s.status as 'reserved' | 'confirmed', expires_at: s.expires_at }; }) };
      }
      case 'rw_preview_cart': {
        if (!this.enabled) return { enabled: false, lines: [] };
        const items = Array.isArray(a.p_items) ? (a.p_items as { sku_code: string; qty: number }[]) : [];
        const eligible = items.reduce((s, i) => s + (this.shop.items.find((x) => x.sku_code === i.sku_code && this.ruleOk(x.sku_code))?.price ?? 0) * (Number(i.qty) || 0), 0);
        const step = this.rule.step; const rem = Math.round(eligible * 100) % Math.round(step * 100) / 100;
        const more = Math.round((step - rem) * 100) / 100;                       // baht more on this bill for the next step
        return { enabled: true, lines: [{ kind: 'board_pick', name: this.rule.name, eligible_amount: eligible, reward: picksFor(eligible, step, this.rule.reward), next_reward_in: more,
          ...(this.sendStep ? { next_reward_total: picksFor(Math.round((eligible + more) * 100) / 100, step, this.rule.reward) } : {}) }] };
      }
      case 'rw_board_rev': {
        if (!this.enabled) throw new Error('REWARDS_OFF'); if (!this.boardsEnabled) throw new Error('BOARDS_OFF');
        const ev = this.world.event; return { event_status: ev?.status ?? null, boards: (ev?.boards ?? []).map((b) => ({ id: b.id, rev: b.rev, state: b.state })) };
      }
      case 'rw_board_state': if (!this.enabled) throw new Error('REWARDS_OFF'); return this.boardState();
      case 'rw_claim_number': return this.claim(String(a.p_event), String(a.p_board), Number(a.p_number), String(a.p_key));
      case 'rw_confirm_selection': {
        const s = this.world.selections.find((x) => x.id === a.p_selection && x.who === this.me); if (!s) throw new Error('NOT_FOUND');
        if (s.status === 'reserved' && s.expires_at && new Date(s.expires_at).getTime() < Date.now()) { s.status = 'released'; throw new Error('HOLD_EXPIRED'); }
        s.status = 'confirmed'; s.expires_at = null; const b = this.world.event!.boards.find((x) => x.id === s.board_id)!; b.rev++;
        return { selection: this.selJson(s), board: this.publicBoard(b), rights: this.rights() };
      }
      default: return NOT_HANDLED;
    }
  }
  private selJson(s: FSelection) { return { id: s.id, board_id: s.board_id, number: s.number, status: s.status as 'reserved' | 'confirmed', expires_at: s.expires_at }; }
  private claim(eventId: string, boardId: string, number: number, key: string) {
    if (!this.enabled) throw new Error('REWARDS_OFF'); if (!this.boardsEnabled) throw new Error('BOARDS_OFF');
    if (!KEY.test(key)) throw new Error('INVALID_KEY');
    const mapKey = `${this.me}:${key}`; const hash = `${eventId}|${boardId}|${number}`;
    const have = this.world.keys.get(mapKey);
    if (have) { if (have.hash !== hash) throw new Error('KEY_REUSED'); const b = this.world.event!.boards.find((x) => x.id === boardId)!; return { replay: true, selection: this.selJson(have.out.selection), board: this.publicBoard(b), rights: this.rights() }; }
    const ev = this.world.event; if (!ev || ev.id !== eventId) throw new Error('NOT_FOUND');
    const b = ev.boards.find((x) => x.id === boardId); if (!b) throw new Error('NOT_FOUND');
    // the order the database checks in: event, board lock, number range, the customer's rights, then who holds the number
    if (ev.status !== 'active') throw new Error('EVENT_NOT_ACTIVE');
    if (ev.starts_at && new Date(ev.starts_at).getTime() > Date.now()) throw new Error('EVENT_NOT_ACTIVE');
    if (ev.ends_at && new Date(ev.ends_at).getTime() < Date.now()) throw new Error('EVENT_NOT_ACTIVE');
    if (b.state === 'locked') throw new Error('BOARD_LOCKED');
    if (!Number.isInteger(number) || number < ev.number_min || number > ev.number_max) throw new Error('NUMBER_OUT_OF_RANGE');
    if (this.rights().remaining < 1) throw new Error('NO_ENTITLEMENT');
    const here = this.world.selections.filter((s) => s.board_id === b.id && s.number === number && active(s));
    const exclusive = b.mode === 'exclusive';
    if (exclusive ? here.length > 0 : here.some((s) => s.exclusive || s.who === this.me)) throw new Error('NUMBER_TAKEN');
    const hold = ev.hold_minutes > 0;
    const sel: FSelection = { id: `sel-${++this.world.n}`, board_id: b.id, number, who: this.me, status: hold ? 'reserved' : 'confirmed', exclusive, expires_at: hold ? new Date(Date.now() + ev.hold_minutes * 60_000).toISOString() : null };
    this.world.selections.push(sel); b.rev++;
    this.world.keys.set(mapKey, { hash, out: { selection: sel } });
    return { replay: false, selection: this.selJson(sel), board: this.publicBoard(b), rights: this.rights() };
  }
}
