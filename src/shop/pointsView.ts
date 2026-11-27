// What the points transfer screen decides, with no React in it so it can be tested on its own: reading the member ID and the amount the customer typed,
// which sentence a failed call gets, and what a history row says. The database re-checks every one of these; this only saves the customer a round trip
// and says it in their own words.
import type { Transfer, TransferLimits, TransferOverview, TransferStatus } from '../rewards/transferApi';
import type { K } from './i18n';

// ------------------------------------------------------------------------------------------------ member ID
/** Eight letters and digits, without I, O, 0 and 1 (they are mistaken for each other when a code is read out or copied by hand). */
export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
/** "abcd-efgh", "ABCD EFGH " and "ABCDEFGH" are the same ID. */
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** ABCDEFGH → ABCD-EFGH (what the customer sees and copies). */
export const formatCode = (code: string): string => { const c = normalizeCode(code); return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c; };

export type CodeCheck = { ok: true; code: string } | { ok: false; key: K };
/** `own` = the customer's own ID, which is refused here already (the database refuses it too). */
export function checkCode(raw: string, own?: string | null): CodeCheck {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, key: 'pt.err.codeEmpty' };
  if (!CODE_RE.test(code)) return { ok: false, key: 'pt.err.codeFormat' };
  if (own && normalizeCode(own) === code) return { ok: false, key: 'pt.err.self' };
  return { ok: true, code };
}

// ------------------------------------------------------------------------------------------------ amount
/** What is left of today's allowance (the database counts pending and accepted transfers of the last 24 hours). */
export const dailyLeft = (l: TransferLimits): number => Math.max(0, l.daily_max - l.sent_today);
/** The most this customer can send in one transfer right now. */
export const maxSendable = (available: number, l: TransferLimits): number => Math.max(0, Math.min(available, l.max, dailyLeft(l)));

export type AmountCheck = { ok: true; points: number } | { ok: false; key: K; vars?: Record<string, number> };
export function checkAmount(raw: string, o: { available: number; limits: TransferLimits }): AmountCheck {
  const s = raw.trim();
  if (!s) return { ok: false, key: 'pt.err.amountEmpty' };
  if (!/^\d+$/.test(s)) return { ok: false, key: 'pt.err.amountWhole' };            // no sign, no decimal point, no exponent, no spaces inside
  const n = s.length > 9 ? Number.POSITIVE_INFINITY : Number(s);
  if (n === 0) return { ok: false, key: 'pt.err.amountWhole' };
  const l = o.limits;
  if (n < l.min) return { ok: false, key: 'pt.err.amountMin', vars: { n: l.min } };
  if (n > l.max) return { ok: false, key: 'pt.err.amountMax', vars: { n: l.max } };
  if (o.available <= 0) return { ok: false, key: 'pt.err.nothing' };
  if (n > o.available) return { ok: false, key: 'pt.err.amountAvail', vars: { n: o.available } };
  if (n > dailyLeft(l)) return { ok: false, key: 'pt.err.amountDaily', vars: { n: dailyLeft(l) } };
  return { ok: true, points: n };
}

export const MESSAGE_MAX = 140;
export const checkMessage = (raw: string): { ok: true; text: string | null } | { ok: false; key: K } => {
  const text = raw.trim();
  return text.length > MESSAGE_MAX ? { ok: false, key: 'pt.err.msgLong' } : { ok: true, text: text || null };
};

// ------------------------------------------------------------------------------------------------ failed calls
export interface ErrorPlan {
  key: K; vars?: Record<string, number>;
  /** load the screen again: what it shows is out of date (a request was answered meanwhile, a limit changed, the feature was switched off) */
  refresh: boolean;
  /** keep the idempotency key: the request may have gone through, so a second press must be the SAME request */
  keepKey: boolean;
}
/**
 * The sentence for a failed call. A lost connection (or an unknown failure) may have been processed by the database, so for a send it keeps the key: pressing
 * confirm again repeats the same request, which the database answers with the original transfer instead of a second one.
 * `available` is the number the database itself reported for INSUFFICIENT_POINTS (its `detail`), when there is one.
 */
export function errorPlan(code: string, what: 'send' | 'answer', o: { available?: number; dailyLeft?: number } = {}): ErrorPlan {
  const stop = (key: K, extra: Partial<ErrorPlan> = {}): ErrorPlan => ({ key, refresh: false, keepKey: false, ...extra });
  switch (code) {
    case 'TRANSFERS_OFF': return stop('pt.off', { refresh: true });
    case 'TOO_MANY_LOOKUPS': return stop('pt.err.lookups');
    case 'RECIPIENT_NOT_FOUND': return stop('pt.err.notFound');
    case 'SELF_TRANSFER': return stop('pt.err.self');
    case 'POINTS_OUT_OF_RANGE': return stop('pt.err.amountWhole', { refresh: true });
    case 'MESSAGE_TOO_LONG': return stop('pt.err.msgLong');
    case 'TOO_MANY_PENDING': return stop('pt.err.pending', { refresh: true });
    case 'DAILY_LIMIT': return stop('pt.err.amountDaily', { vars: { n: Math.max(0, o.dailyLeft ?? 0) }, refresh: true });
    case 'INSUFFICIENT_POINTS': return stop('pt.err.amountAvail', { vars: { n: Math.max(0, o.available ?? 0) }, refresh: true });
    case 'POINTS_RESERVED': return stop('pt.err.reserved', { refresh: true });
    case 'TRANSFER_NOT_PENDING': case 'NOT_FOUND': return stop('pt.err.notPending', { refresh: true });
    case 'INVALID_KEY': case 'KEY_REUSED': return stop('pt.err.keyReused');
    case 'FORBIDDEN': return stop('err.signin');
    case 'NETWORK': return what === 'send' ? { key: 'pt.stillSending', refresh: false, keepKey: true } : { key: 'err.network', refresh: false, keepKey: true };
    default: return what === 'send' ? { key: 'pt.stillSending', refresh: false, keepKey: true } : stop('err.generic');
  }
}

// ------------------------------------------------------------------------------------------------ rows
export const STATUS_KEY: Record<TransferStatus, K> = {
  pending: 'pt.st.pending', accepted: 'pt.st.accepted', rejected: 'pt.st.rejected', cancelled: 'pt.st.cancelled', expired: 'pt.st.expired',
};
export type RowTone = 'good' | 'bad' | 'warn' | 'info';
export const statusTone = (s: TransferStatus): RowTone => (s === 'accepted' ? 'good' : s === 'rejected' ? 'bad' : s === 'pending' ? 'info' : 'warn');

/** The points that really moved for this customer: only an accepted transfer moves anything (+ for the recipient, - for the sender). */
export const movement = (t: Pick<Transfer, 'status' | 'direction' | 'points'>): number => (t.status !== 'accepted' ? 0 : t.direction === 'in' ? t.points : -t.points);

/** Why a transfer did not happen, when the database gives a reason worth showing. */
export function reasonKey(t: Pick<Transfer, 'status' | 'reason'>): K | null {
  if (t.status !== 'cancelled' || !t.reason) return null;
  if (t.reason === 'SENDER_BALANCE_CHANGED') return 'pt.why.balance';
  if (t.reason.startsWith('ADMIN')) return 'pt.why.admin';
  if (t.reason === 'CANCELLED_BY_SENDER') return 'pt.why.sender';
  return null;
}

/** The small number on the entry row: unread news, or the requests that wait for an answer, whichever is more. 0 = nothing (and no row at all when transfers are off). */
export const entryBadge = (o: TransferOverview | null): number => (o && o.enabled ? Math.max(o.unread, o.incoming.length) : 0);
export const waitingForMe = (o: TransferOverview | null): number => (o && o.enabled ? o.incoming.length : 0);

/** A request that is past its time is shown as expired at once (the server says so too, on the next load). */
export const isLive = (t: Pick<Transfer, 'status' | 'expires_at'>, now = Date.now()): boolean => t.status === 'pending' && Date.parse(t.expires_at) > now;
