// The points-transfer part of the fake backend. It mirrors the CONTRACT of supabase/migrations/20261127120000_points_transfer.sql, which is tested for real (on the
// live project, in a transaction that always rolls back) by supabase/tests/points_transfer.sql. This file proves the SCREENS only.
//
// What it keeps the way the database does: a pending request HOLDS the sender's points (available = balance - held; a second request cannot spend them); only the
// recipient can accept or decline, only the sender can cancel; a second accept changes nothing (replay); an expired request is recorded as expired and frees the points;
// an accept for a sender whose points were removed behind the request cancels it with SENDER_BALANCE_CHANGED instead of going negative; the same key returns the same
// answer (KEY_REUSED for a different request); lookups of unknown IDs are limited to 20 an hour. "me" is the signed-in customer; their points are `shop.rw.points`, so the
// Rewards screen shows the same number. Functions it does not know fall through to the other fakes (NOT_HANDLED).
// (no parameter properties: Playwright loads this file with Node's strip-only TypeScript)
import type { FakeShop } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';

export type Who = 'me' | 'friend' | 'ghost';
type Status = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
export interface FTransfer { id: string; no: string; sender: Who; recipient: Who; points: number; key: string; message: string | null; status: Status; created: number; expires: number; decided: number | null; reason: string | null; outLedger: number | null; inLedger: number | null }
interface Notice { transfer: string; who: Who; kind: string; read: boolean }
export interface Limits { min: number; max: number; daily_max: number; max_pending: number; expire_days: number }

const MEMBERS: Record<Who, { name: string; code: string; active: boolean }> = {
  me: { name: 'สมชาย ใจดี', code: 'ME7K4PQ2', active: true },
  friend: { name: 'Maria Suwan', code: 'FRND7342', active: true },
  ghost: { name: 'Gone Person', code: 'GNHP9999', active: false },       // a disabled account: "not found", like the database
};
const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const DAY = 86_400_000;
const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmt = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
const mask = (c: string) => `${c.slice(0, 2)}••••${c.slice(6)}`;
const shortName = (n: string) => { const w = n.trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w[1].slice(0, 1)}.` : w[0]; };
const fail = (message: string, details?: string): never => { throw Object.assign(new Error(message), details ? { details } : {}); };

export class FakeTransfers {
  /** false = the database ships dark (rw_transfer_settings.transfers_enabled = false) */
  enabled = false;
  limits: Limits = { min: 1, max: 1000, daily_max: 5000, max_pending: 10, expire_days: 7 };
  transfers: FTransfer[] = [];
  /** the second customer's points (me = shop.rw.points) */
  friendPoints = 0;
  /** unknown-ID lookups by me in the last hour (20 = TOO_MANY_LOOKUPS) */
  misses = 0;
  /** every ledger row an accept wrote: [who, points] (a second accept must not add one) */
  ledger: { who: Who; points: number }[] = [];
  private notices: Notice[] = [];
  private seq = 0;
  private shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }

  // ------------------------------------------------------------ test controls
  /** switch the feature on (and rewards, which it needs) and give the customers their points */
  enable(o: { mine?: number; friend?: number } & Partial<Limits> = {}) {
    const { mine, friend, ...limits } = o;
    this.enabled = true; this.shop.rw.enabled = true; this.limits = { ...this.limits, ...limits };
    if (mine !== undefined) this.shop.rw.points = mine;
    if (friend !== undefined) this.friendPoints = friend;
  }
  member(who: Who) { return MEMBERS[who]; }
  code(who: Who) { return fmt(MEMBERS[who].code); }
  points(who: Who): number { return who === 'me' ? this.shop.rw.points : who === 'friend' ? this.friendPoints : 0; }
  private add(who: Who, n: number) { if (who === 'me') this.shop.rw.points += n; else if (who === 'friend') this.friendPoints += n; }
  held(who: Who): number { return this.transfers.filter((t) => t.sender === who && t.status === 'pending' && t.expires > Date.now()).reduce((s, t) => s + t.points, 0); }
  available(who: Who): number { return this.points(who) - this.held(who); }
  byNo(no: string): FTransfer { const t = this.transfers.find((x) => x.no === no); if (!t) throw new Error(`no transfer ${no}`); return t; }
  last(): FTransfer { return this.transfers[this.transfers.length - 1]; }
  /** the other customer sends points to me (the same rules as a customer's own request) */
  friendSends(points: number, message: string | null = null, to: Who = 'me'): FTransfer { return this.make('friend', to, points, `friend-key-${this.seq + 1}`, message); }
  /** the other customer answers a request I sent */
  friendAccepts(no: string) { return this.accept(this.byNo(no).id, 'friend'); }
  friendRejects(no: string) { return this.reject(this.byNo(no).id, 'friend'); }
  /** the request ran out of time (nobody pressed anything) */
  expire(no: string) { const t = this.byNo(no); t.expires = Date.now() - 1000; }
  /** staff took points away behind a pending request */
  removePoints(who: Who, n: number) { this.add(who, -n); }
  /** a ledger-row count per customer, for "no duplicate credit" checks */
  rows(who: Who) { return this.ledger.filter((l) => l.who === who).length; }
  unread(who: Who = 'me') { return this.notices.filter((n) => n.who === who && !n.read).length; }

  // ------------------------------------------------------------ the database rules
  private json(t: FTransfer, viewer: Who) {
    const other: Who = t.sender === viewer ? t.recipient : t.sender;
    const m = MEMBERS[other];
    return { id: t.id, transfer_no: t.no, direction: t.sender === viewer ? 'out' : 'in', status: t.status === 'pending' && t.expires <= Date.now() ? 'expired' : t.status, points: t.points, message: t.message,
      created_at: new Date(t.created).toISOString(), expires_at: new Date(t.expires).toISOString(), decided_at: t.decided ? new Date(t.decided).toISOString() : null, reason: t.reason,
      counterparty: { name: shortName(m.name), code: mask(m.code) } };
  }
  private note(t: FTransfer, who: Who, kind: string) { if (!this.notices.some((n) => n.transfer === t.id && n.who === who && n.kind === kind)) this.notices.push({ transfer: t.id, who, kind, read: false }); }
  private expireFor(who: Who) {
    for (const t of this.transfers) if (t.status === 'pending' && t.expires <= Date.now() && (t.sender === who || t.recipient === who)) {
      t.status = 'expired'; t.decided = Date.now(); t.reason = 'EXPIRED'; this.note(t, t.sender, 'expired'); this.note(t, t.recipient, 'expired');
    }
  }
  private sentToday(who: Who) { return this.transfers.filter((t) => t.sender === who && (t.status === 'pending' || t.status === 'accepted') && t.created > Date.now() - DAY).reduce((s, t) => s + t.points, 0); }

  private make(sender: Who, recipient: Who, points: number, key: string, message: string | null): FTransfer {
    if (!Number.isInteger(points) || points < this.limits.min || points > this.limits.max) fail(`POINTS_OUT_OF_RANGE: a transfer is between ${this.limits.min} and ${this.limits.max} points`);
    this.expireFor(sender);
    if (this.transfers.filter((t) => t.sender === sender && t.status === 'pending').length >= this.limits.max_pending) fail(`TOO_MANY_PENDING: you already have ${this.limits.max_pending} pending transfers`);
    if (this.sentToday(sender) + points > this.limits.daily_max) fail(`DAILY_LIMIT: at most ${this.limits.daily_max} points can be sent per day`);
    const avail = this.available(sender);
    if (points > avail) fail(`INSUFFICIENT_POINTS: ${avail} points are available (balance ${this.points(sender)}, held by pending transfers ${this.held(sender)})`, String(avail));
    const t: FTransfer = { id: `tr-${++this.seq}`, no: `PT-${String(this.seq).padStart(6, '0')}`, sender, recipient, points, key, message, status: 'pending', created: Date.now(),
      expires: Date.now() + this.limits.expire_days * DAY, decided: null, reason: null, outLedger: null, inLedger: null };
    this.transfers.push(t); this.note(t, recipient, 'incoming');
    return t;
  }
  private accept(id: string, viewer: Who) {
    const t = this.transfers.find((x) => x.id === id && x.recipient === viewer); if (!t) fail('NOT_FOUND: transfer');
    const x = t as FTransfer;
    if (x.status === 'accepted') return { ...this.json(x, viewer), replay: true };
    if (x.status !== 'pending') fail(`TRANSFER_NOT_PENDING: this transfer is ${x.status}`);
    if (x.expires <= Date.now()) { x.status = 'expired'; x.decided = Date.now(); x.reason = 'EXPIRED'; this.note(x, x.sender, 'expired'); this.note(x, x.recipient, 'expired'); return { ...this.json(x, viewer), replay: false }; }
    if (this.points(x.sender) < x.points) { x.status = 'cancelled'; x.decided = Date.now(); x.reason = 'SENDER_BALANCE_CHANGED'; this.note(x, x.sender, 'cancelled'); this.note(x, x.recipient, 'cancelled'); return { ...this.json(x, viewer), replay: false }; }
    this.add(x.sender, -x.points); this.add(x.recipient, x.points);
    this.ledger.push({ who: x.sender, points: -x.points }); this.ledger.push({ who: x.recipient, points: x.points });
    x.outLedger = this.ledger.length - 1; x.inLedger = this.ledger.length;
    x.status = 'accepted'; x.decided = Date.now(); this.note(x, x.sender, 'accepted'); this.note(x, x.recipient, 'accepted');
    return { ...this.json(x, viewer), replay: false, balance: this.points(x.recipient) };
  }
  private reject(id: string, viewer: Who) {
    const t = this.transfers.find((x) => x.id === id && x.recipient === viewer); if (!t) fail('NOT_FOUND: transfer');
    const x = t as FTransfer;
    if (x.status === 'rejected') return { ...this.json(x, viewer), replay: true };
    if (x.status !== 'pending') fail(`TRANSFER_NOT_PENDING: this transfer is ${x.status}`);
    x.status = 'rejected'; x.decided = Date.now(); x.reason = 'REJECTED'; this.note(x, x.sender, 'rejected');
    return { ...this.json(x, viewer), replay: false };
  }
  private cancel(id: string, viewer: Who) {
    const t = this.transfers.find((x) => x.id === id && x.sender === viewer); if (!t) fail('NOT_FOUND: transfer');
    const x = t as FTransfer;
    if (x.status === 'cancelled') return { ...this.json(x, viewer), replay: true };
    if (x.status !== 'pending') fail(`TRANSFER_NOT_PENDING: this transfer is ${x.status}`);
    x.status = 'cancelled'; x.decided = Date.now(); x.reason = 'CANCELLED_BY_SENDER'; this.note(x, x.recipient, 'cancelled');
    return { ...this.json(x, viewer), replay: false };
  }
  private requireSuper() { if (this.shop.profile.role !== 'SUPER_ADMIN') fail('FORBIDDEN: only a Super Admin can do this'); }
  private adminRow(t: FTransfer) {
    const s = MEMBERS[t.sender], r = MEMBERS[t.recipient];
    return { id: t.id, transfer_no: t.no, status: t.status === 'pending' && t.expires <= Date.now() ? 'expired' : t.status, points: t.points, message: t.message, created_at: new Date(t.created).toISOString(), expires_at: new Date(t.expires).toISOString(),
      decided_at: t.decided ? new Date(t.decided).toISOString() : null, reason: t.reason, sender_id: `id-${t.sender}`, sender: s.name, sender_code: fmt(s.code), recipient_id: `id-${t.recipient}`, recipient: r.name, recipient_code: fmt(r.code),
      out_ledger_id: t.outLedger, in_ledger_id: t.inLedger, sender_before: null, recipient_before: null };
  }

  // ------------------------------------------------------------ the functions
  rpc(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'rw_transfer_overview': {
        if (!this.enabled || !this.shop.rw.enabled) return { enabled: false };
        this.expireFor('me');
        const live = (t: FTransfer) => t.status === 'pending' && t.expires > Date.now();
        const history = this.transfers.filter((t) => (t.sender === 'me' || t.recipient === 'me') && !live(t) && t.status !== 'pending').sort((x, y) => (y.decided ?? y.created) - (x.decided ?? x.created)).slice(0, 50);
        return { enabled: true, member_code: this.code('me'), balance: this.points('me'), reserved: this.held('me'), available: this.available('me'),
          limits: { min: this.limits.min, max: this.limits.max, daily_max: this.limits.daily_max, sent_today: this.sentToday('me'), max_pending: this.limits.max_pending, expire_days: this.limits.expire_days },
          incoming: this.transfers.filter((t) => t.recipient === 'me' && live(t)).reverse().map((t) => this.json(t, 'me')),
          outgoing: this.transfers.filter((t) => t.sender === 'me' && live(t)).reverse().map((t) => this.json(t, 'me')),
          history: history.map((t) => this.json(t, 'me')), unread: this.unread('me') };
      }
      case 'rw_transfer_mark_read': { const n = this.notices.filter((x) => x.who === 'me' && !x.read); n.forEach((x) => { x.read = true; }); return n.length; }
      case 'rw_transfer_lookup': {
        if (!this.enabled) fail('TRANSFERS_OFF: points transfers are not available');
        if (this.misses >= 20) fail('TOO_MANY_LOOKUPS: too many unknown member IDs in the last hour. Try again later');
        const c = norm(a.p_code); const who = (Object.keys(MEMBERS) as Who[]).find((w) => MEMBERS[w].code === c && MEMBERS[w].active);
        if (!who) { this.misses += 1; return { found: false }; }
        return { found: true, is_self: who === 'me', name: shortName(MEMBERS[who].name), code: mask(MEMBERS[who].code) };
      }
      case 'rw_transfer_create': {
        if (!this.enabled) fail('TRANSFERS_OFF: points transfers are not available');
        const key = String(a.p_key ?? ''); const points = a.p_points as number; const c = norm(a.p_code);
        const message = typeof a.p_message === 'string' && a.p_message.trim() ? a.p_message.trim() : null;
        if (!KEY.test(key)) fail('INVALID_KEY');
        if (!Number.isInteger(points) || points < this.limits.min || points > this.limits.max) fail(`POINTS_OUT_OF_RANGE: a transfer is between ${this.limits.min} and ${this.limits.max} points`);
        if (message && message.length > 140) fail('MESSAGE_TOO_LONG: 140 characters at most');
        const old = this.transfers.find((t) => t.sender === 'me' && t.key === key);
        const rcpt = (Object.keys(MEMBERS) as Who[]).find((w) => MEMBERS[w].code === c);
        if (old) { if (old.recipient !== rcpt || old.points !== points) fail('KEY_REUSED'); return { ...this.json(old, 'me'), replay: true }; }
        if (this.misses >= 20) fail('TOO_MANY_LOOKUPS: too many unknown member IDs in the last hour. Try again later');
        const who = (Object.keys(MEMBERS) as Who[]).find((w) => MEMBERS[w].code === c && MEMBERS[w].active);
        if (!who) { this.misses += 1; fail('RECIPIENT_NOT_FOUND: check the member ID'); }
        if (who === 'me') fail('SELF_TRANSFER: you cannot send points to yourself');
        return { ...this.json(this.make('me', who as Who, points, key, message), 'me'), replay: false };
      }
      case 'rw_transfer_accept': if (!this.enabled) fail('TRANSFERS_OFF: points transfers are not available'); return this.accept(String(a.p_transfer), 'me');
      case 'rw_transfer_reject': return this.reject(String(a.p_transfer), 'me');
      case 'rw_transfer_cancel': return this.cancel(String(a.p_transfer), 'me');
      // staff
      case 'rw_admin_transfer_settings': return { transfers_enabled: this.enabled, min_points: this.limits.min, max_points: this.limits.max, daily_max_points: this.limits.daily_max, max_pending: this.limits.max_pending, expire_days: this.limits.expire_days, updated_at: null, rewards_enabled: this.shop.rw.enabled };
      case 'rw_admin_save_transfer_settings': {
        this.requireSuper();
        const p = (a.p_patch ?? {}) as Record<string, unknown>; const next = { ...this.limits };
        for (const [k, v] of Object.entries(p)) {
          if (k === 'transfers_enabled') { if (typeof v !== 'boolean') fail('BAD_VALUE: transfers_enabled is on or off'); this.enabled = v as boolean; continue; }
          const map: Record<string, keyof Limits> = { min_points: 'min', max_points: 'max', daily_max_points: 'daily_max', max_pending: 'max_pending', expire_days: 'expire_days' };
          if (!map[k]) fail(`BAD_FIELD: ${k} cannot be changed here`);
          if (!Number.isInteger(v) || (v as number) < 1) fail(`BAD_VALUE: ${k} must be a whole number, at least 1`);
          next[map[k]] = v as number;
        }
        if (next.max < next.min || next.daily_max < next.max || next.max_pending > 100 || next.expire_days > 90) fail('BAD_VALUE: the limits do not fit together (smallest <= largest <= daily, at most 100 pending, 90 days)');
        this.limits = next;
        return this.rpc('rw_admin_transfer_settings', {});
      }
      case 'rw_admin_transfers': {
        const st = a.p_status ? String(a.p_status) : null; const q = String(a.p_search ?? '').trim().toLowerCase(); const lim = Number(a.p_limit ?? 50);
        const rows = [...this.transfers].reverse().map((t) => this.adminRow(t)).filter((r) => (!st || r.status === st) && (!q || `${r.transfer_no} ${r.sender} ${r.recipient}`.toLowerCase().includes(q)));
        return { total: rows.length, items: rows.slice(Number(a.p_offset ?? 0), Number(a.p_offset ?? 0) + lim) };
      }
      case 'rw_admin_cancel_transfer': {
        this.requireSuper();
        const reason = String(a.p_reason ?? '').trim(); if (reason.length < 3) fail('REASON_REQUIRED');
        const t = this.transfers.find((x) => x.id === a.p_transfer); if (!t) fail('NOT_FOUND: transfer');
        const x = t as FTransfer; if (x.status !== 'pending') fail(`TRANSFER_NOT_PENDING: this transfer is ${x.status}`);
        x.status = 'cancelled'; x.decided = Date.now(); x.reason = `ADMIN: ${reason}`; this.note(x, x.sender, 'cancelled'); this.note(x, x.recipient, 'cancelled');
        return { id: x.id, status: x.status };
      }
      default: return NOT_HANDLED;
    }
  }
}
