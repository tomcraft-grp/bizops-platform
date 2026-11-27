// Pure helpers of the preorder screens (customer side): Asia/Bangkok date and time formatting, the day list, quick instructions. No React, no network.
// The database stores every pickup time as an instant (timestamptz) and decides what is bookable; this file only shows it, always in shop time.
import type { ShopLang } from './i18n';

const TZ = 'Asia/Bangkok';
const loc = (lang: ShopLang) => (lang === 'th' ? 'th-TH' : 'en-GB');

/** "10:30" in shop time. */
export function bkkTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
/** "2026-11-30": the shop-time calendar day of an instant. */
export function bkkDayKey(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
/** A "YYYY-MM-DD" day as a date at midday shop time (so no time zone can move it to another day). */
const dayDate = (day: string): Date => new Date(`${day}T12:00:00+07:00`);
/** The weekday and the date of a day key, e.g. { weekday: 'จ.', date: '30 พ.ย.' }. */
export function dayParts(day: string, lang: ShopLang): { weekday: string; date: string } {
  const d = dayDate(day);
  if (isNaN(d.getTime())) return { weekday: '', date: day };
  return {
    weekday: new Intl.DateTimeFormat(loc(lang), { timeZone: TZ, weekday: 'short' }).format(d),
    date: new Intl.DateTimeFormat(loc(lang), { timeZone: TZ, day: 'numeric', month: 'short' }).format(d),
  };
}
/** "จ. 30 พ.ย. 10:30 น." / "Mon 30 Nov, 10:30": the whole pickup time in one line. */
export function pickupLabel(iso: string | null | undefined, lang: ShopLang): string {
  if (!iso) return '';
  const day = bkkDayKey(iso);
  if (!day) return '';                          // not a date: say nothing rather than "Invalid Date"
  const p = dayParts(day, lang);
  return lang === 'th' ? `${p.weekday} ${p.date} ${bkkTime(iso)} น.` : `${p.weekday} ${p.date}, ${bkkTime(iso)}`;
}
/** The pickup time with a long weekday ("วันจันทร์ที่ 30 พฤศจิกายน 2569 เวลา 10:30 น."), for the confirmation. */
export function pickupLong(iso: string | null | undefined, lang: ShopLang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat(loc(lang), { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  return lang === 'th' ? `${date} เวลา ${bkkTime(iso)} น.` : `${date}, ${bkkTime(iso)}`;
}

export interface DayInfo { day: string; closed: boolean; open: string | null; close: string | null; reason: string | null; free_slots: number }
/** A day the customer can pick: open and with at least one free time. */
export const dayBookable = (d: Pick<DayInfo, 'closed' | 'free_slots'>): boolean => !d.closed && d.free_slots > 0;
/** The first day with room, or null. */
export const firstBookableDay = (days: DayInfo[] | undefined | null): string | null => days?.find(dayBookable)?.day ?? null;
/** What a day button says under its date: closed, full, or nothing. */
export function dayState(d: DayInfo): 'closed' | 'full' | 'ok' { return d.closed ? 'closed' : d.free_slots > 0 ? 'ok' : 'full'; }

/** "2 ชั่วโมง" / "1 h 30 min": a number of minutes in words (the lead time). */
export function leadWords(minutes: number): { key: 'po.lead.min' | 'po.lead.hour' | 'po.lead.hourMin'; vars: Record<string, number> } {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return { key: 'po.lead.min', vars: { n: m } };
  if (m % 60 === 0) return { key: 'po.lead.hour', vars: { n: m / 60 } };
  return { key: 'po.lead.hourMin', vars: { h: Math.floor(m / 60), m: m % 60 } };
}

/** The statuses a preorder passes through (the "packed" step of a regular order is not part of it). */
export const PREORDER_STEPS = ['new', 'confirmed', 'preparing', 'ready', 'completed'] as const;

/** Total units of a basket: what the shop has to prepare (and what the slot capacity counts). */
export const preorderUnits = (lines: { qty: number }[]): number => lines.reduce((s, l) => s + (Number.isFinite(l.qty) ? l.qty : 0), 0);

/** Add a quick phrase to the instructions: separated by a space, only once, and only while it still fits. */
export function addPhrase(note: string, phrase: string, max = 300): string {
  const cur = note.trim();
  if (cur.includes(phrase)) return note;
  const next = cur ? `${cur} ${phrase}` : phrase;
  return next.length <= max ? next : note;
}
/** Is the phrase already in the instructions? (the chip then shows as chosen) */
export const hasPhrase = (note: string, phrase: string): boolean => note.includes(phrase);

/** Which notices of an order the customer sees: the kinds the app knows; anything else is shown through its stored Thai text. */
export const KNOWN_NOTICES = ['placed', 'confirmed', 'preparing', 'ready', 'completed', 'rejected', 'cancelled_by_shop', 'rescheduled_by_shop', 'reminder'] as const;

/** Is the preorder's own change window still open? The server decides (`change`); this only guards against showing a stale button after the deadline passed on the phone. */
export function changeOpen(change: { deadline: string; can_reschedule: boolean } | null | undefined, now = Date.now()): boolean {
  if (!change?.can_reschedule) return false;
  const t = new Date(change.deadline).getTime();
  return isNaN(t) || now <= t;
}

/** Group the slots of a day into morning / afternoon / evening so a long list stays easy to scan. */
export function groupSlots<T extends { time: string }>(slots: T[]): { key: 'am' | 'pm' | 'eve'; slots: T[] }[] {
  const g: Record<'am' | 'pm' | 'eve', T[]> = { am: [], pm: [], eve: [] };
  for (const s of slots) { const h = Number(s.time.slice(0, 2)); (h < 12 ? g.am : h < 17 ? g.pm : g.eve).push(s); }
  return (['am', 'pm', 'eve'] as const).filter((k) => g[k].length > 0).map((key) => ({ key, slots: g[key] }));
}
