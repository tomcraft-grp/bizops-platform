// What the staff "Point transfers" tab decides without React: whether the limits a Super Admin typed fit together, how a transfer's reason reads, and the sentence
// for a failed call. Strings are English source text (the back office translates them through lib/i18n.transfers.ts).
import { ShopError } from '../shop/api';
import type { AdminTransfer, TransferSettings, TransferStatus } from './transferApi';

export interface LimitsDraft { min_points: number; max_points: number; daily_max_points: number; max_pending: number; expire_days: number }
export const toDraft = (s: TransferSettings): LimitsDraft => ({ min_points: s.min_points, max_points: s.max_points, daily_max_points: s.daily_max_points, max_pending: s.max_pending, expire_days: s.expire_days });

export type Msg = { key: string; vars: Record<string, string | number> };   // the same shape as the rewards screens use, so the page's `say()` takes it
const msg = (key: string, vars: Record<string, string | number> = {}): Msg => ({ key, vars });
const whole = (n: number) => Number.isInteger(n) && n >= 1;

/** The same rules the database applies (smallest <= largest <= daily, at most 100 pending, at most 90 days), so a bad form is explained before it is sent. null = fine. */
export function checkLimits(d: LimitsDraft): Msg | null {
  for (const k of ['min_points', 'max_points', 'daily_max_points', 'max_pending', 'expire_days'] as const) if (!whole(d[k])) return msg('Every limit is a whole number, 1 or more.');
  if (d.max_points < d.min_points) return msg('The largest transfer cannot be smaller than the smallest.');
  if (d.daily_max_points < d.max_points) return msg('The daily limit cannot be smaller than the largest transfer.');
  if (d.max_pending > 100) return msg('At most 100 transfers can be waiting at once.');
  if (d.expire_days > 90) return msg('A request can wait at most 90 days.');
  return null;
}
/** Only what changed is sent (the database ignores nothing it is given, and a patch that touches one thing leaves the rest alone). */
export function limitsPatch(draft: LimitsDraft, saved: TransferSettings): Partial<LimitsDraft> {
  const patch: Partial<LimitsDraft> = {};
  for (const k of Object.keys(draft) as (keyof LimitsDraft)[]) if (draft[k] !== saved[k]) patch[k] = draft[k];
  return patch;
}

export const STATUS_LABEL: Record<TransferStatus, string> = { pending: 'Waiting', accepted: 'Done', rejected: 'Declined', cancelled: 'Cancelled', expired: 'Expired' };
export const statusTone = (s: TransferStatus): 'good' | 'bad' | 'warn' | 'info' => (s === 'accepted' ? 'good' : s === 'rejected' ? 'bad' : s === 'pending' ? 'info' : 'warn');

/** Why the transfer ended the way it did, in words (null when the status says it all). */
export function reasonText(t: Pick<AdminTransfer, 'status' | 'reason'>): Msg | null {
  if (!t.reason || t.status === 'accepted' || t.status === 'pending') return null;
  if (t.reason === 'SENDER_BALANCE_CHANGED') return msg('The sender’s points changed, so it was cancelled automatically');
  if (t.reason === 'CANCELLED_BY_SENDER') return msg('Cancelled by the sender');
  if (t.reason === 'EXPIRED') return msg('Nobody answered in time');
  if (t.reason === 'REJECTED') return null;
  if (t.reason.startsWith('ADMIN:')) return msg('Cancelled by staff: {why}', { why: t.reason.slice(6).trim() });
  return msg('{why}', { why: t.reason });
}

/** The sentence for a failed staff call. */
export function adminError(e: unknown): Msg {
  if (e instanceof ShopError) {
    const detail = e.message.replace(/^[A-Z][A-Z_]{2,}:?\s*/, '').trim();
    switch (e.code) {
      case 'FORBIDDEN': return msg('Only a Super Admin can do this.');
      case 'NETWORK': return msg('No connection. Check the internet and try again.');
      case 'TRANSFER_NOT_PENDING': return msg('This transfer is no longer waiting, so it cannot be cancelled. The list was refreshed.');
      case 'REASON_REQUIRED': return msg('Write a reason (at least 3 characters).');
      case 'NOT_FOUND': return msg('That transfer was not found.');
      case 'BAD_VALUE': case 'BAD_FIELD': return detail ? msg('These settings are not valid: {detail}', { detail }) : msg('These settings are not valid.');
      default: return detail ? msg('Something went wrong: {detail}', { detail }) : msg('Something went wrong. Try again.');
    }
  }
  return msg('Something went wrong. Try again.');
}
