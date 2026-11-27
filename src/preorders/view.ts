// Small shared helpers of the preorder back-office screens: translated text, status colours, the attention flags, shop-time formatting and the readable form of the database's coded errors.
import { useCallback } from 'react';
import { useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { ShopError, type OrderStatus } from '../shop/api';
import { bkkDayKey, bkkTime, pickupLabel } from '../shop/preorderView';
import type { Flag, PreRow } from './api';

export type TFn = (s: string, v?: Record<string, string | number>) => string;
/** English source text -> the staff member's language (Thai dictionary: lib/i18n.preorders.ts). */
export function useTx(): TFn {
  const lang = useLang();
  return useCallback((s, v) => tl(lang, s, v), [lang]);
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | '';
export const STATUS_TONE: Record<OrderStatus, Tone> = { new: 'warn', confirmed: 'info', preparing: 'info', packed: 'info', ready: 'good', shipped: 'good', completed: 'good', cancelled: '', returned: 'bad' };
const STATUS_TEXT: Record<OrderStatus, string> = {
  new: 'Pending confirmation', confirmed: 'Confirmed', preparing: 'Preparing', packed: 'Packed', ready: 'Ready for pickup', shipped: 'Shipped', completed: 'Picked up', cancelled: 'Cancelled', returned: 'Returned',
};
/** The preorder name of a status ("Rejected" = the shop cancelled an order it never confirmed). */
export function statusText(s: OrderStatus, cancelKind?: PreRow['cancel_kind']): string {
  return s === 'cancelled' && cancelKind === 'rejected' ? 'Rejected' : STATUS_TEXT[s];
}
export const ACTIVE: OrderStatus[] = ['new', 'confirmed', 'preparing', 'packed', 'ready'];

export const FLAGS: Record<Flag, { label: string; tone: Tone; hint: string }> = {
  unconfirmed: { label: 'Not confirmed', tone: 'warn', hint: 'Waiting for the shop to confirm for more than 30 minutes' },
  unpaid_soon: { label: 'Payment not verified', tone: 'warn', hint: 'The pickup is within 24 hours and the payment has not been verified' },
  not_started: { label: 'Not started', tone: 'warn', hint: 'Preparation should have started by now' },
  late: { label: 'Late', tone: 'bad', hint: 'The pickup time has come and the order is not ready' },
  overdue_pickup: { label: 'Waiting for pickup', tone: 'warn', hint: 'Ready, but the customer has not collected it' },
  large: { label: 'Large order', tone: 'info', hint: 'Many units: check there is enough to prepare it' },
  closed_day: { label: 'Day closed', tone: 'bad', hint: 'The shop is closed on the pickup day: move the order' },
};
/** The most urgent flag first (late > day closed > not started > ...). */
const FLAG_RANK: Flag[] = ['late', 'closed_day', 'not_started', 'overdue_pickup', 'unconfirmed', 'unpaid_soon', 'large'];
export const sortFlags = (f: Flag[]): Flag[] => [...f].sort((a, b) => FLAG_RANK.indexOf(a) - FLAG_RANK.indexOf(b));

export const dayOf = (iso: string): string => bkkDayKey(iso);
export const timeOf = (iso: string): string => bkkTime(iso);
export const whenOf = (iso: string, lang: 'th' | 'en'): string => pickupLabel(iso, lang);
export const todayKey = (): string => bkkDayKey(new Date());
/** Add whole days to a "YYYY-MM-DD" key (shop time has no daylight saving, so noon + 24 h is the next day). */
export const addDays = (day: string, n: number): string => bkkDayKey(new Date(new Date(`${day}T12:00:00+07:00`).getTime() + n * 86_400_000));
/** The start of a slot given its day and "HH:MM", as an ISO instant. */
export const slotInstant = (day: string, hhmm: string): string => new Date(`${day}T${hhmm}:00+07:00`).toISOString();

/** How long until (positive) or since (negative) the pickup, in words: "in 45 min", "20 min late", "in 2 h 10 min". */
export function untilText(iso: string, T: TFn, now = Date.now()): { text: string; late: boolean } {
  const mins = Math.round((new Date(iso).getTime() - now) / 60_000);
  const a = Math.abs(mins); const h = Math.floor(a / 60); const m = a % 60;
  const span = h >= 24 ? T('{n} d', { n: Math.round(h / 24) }) : h > 0 ? (m ? T('{h} h {m} min', { h, m }) : T('{h} h', { h })) : T('{m} min', { m: Math.max(a, 0) });
  return mins >= 0 ? { text: T('in {span}', { span }), late: false } : { text: T('{span} ago', { span }), late: true };
}

const CODE_TEXT: Record<string, string> = {
  PAYMENT_REQUIRED: 'Payment has not been verified yet. Verify it on Payment review, or continue with a recorded reason.',
  PREP_INCOMPLETE: 'Tick every item of the checklist before marking the order ready',
  PICKUP_PASSED: 'The pickup time has already passed: move the order to a new time first',
  NOT_PREPARING: 'The checklist can be ticked while the order is confirmed or being prepared',
  SLOT_FULL: 'That time is full',
  SLOT_UNITS_FULL: 'That time cannot take this many items',
  DAY_UNITS_FULL: 'That day is at its limit of items',
  SLOT_PAST: 'That time has already passed',
  SLOT_INVALID: 'That is not one of the pickup times of the shop',
  SLOT_CLOSED: 'The shop is closed on that day',
  INVALID_ASSIGNEE: 'Choose an active staff member',
  ORDER_CLOSED: 'This order is already finished',
  ORDER_IN_PROGRESS: 'The order is already being prepared or finished: it cannot be moved this way',
  NOTHING_TO_CHANGE: 'Nothing to change',
  PREORDER_NOT_CONFIGURED: 'Save the opening hours first (Settings), then switch preorders on',
  PICKUP_DISABLED: 'Switch on pick-up in the Online shop settings first',
  FORBIDDEN: 'You are not allowed to do this',
};
/** The readable form of any error from these functions (the database's code and detail are translated; anything else is shown as it came). */
export function preError(e: unknown, T: TFn): string {
  if (e instanceof ShopError) {
    const detail = e.message.includes(':') ? e.message.slice(e.message.indexOf(':') + 1).trim() : '';
    if (e.code === 'DAY_HAS_ORDERS') return T('Preorders are booked on that day that would no longer fit: {detail}', { detail });
    if (e.code === 'INVALID_SETTING' || e.code === 'INVALID_DAY') return detail || e.message;
    if (e.code === 'PREP_INCOMPLETE' && detail) return `${T(CODE_TEXT.PREP_INCOMPLETE)} (${detail})`;
    if (CODE_TEXT[e.code]) return T(CODE_TEXT[e.code]);
    if (e.code === 'NETWORK') return T('Could not connect. Please try again.');
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
