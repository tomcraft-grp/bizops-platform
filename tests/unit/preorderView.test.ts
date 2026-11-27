// The pure helpers of the preorder screens: shop-time (Asia/Bangkok) dates, the day list, quick instructions, the change window, the coded errors in both apps, and the checkout draft.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPhrase, bkkDayKey, bkkTime, changeOpen, dayParts, dayState, firstBookableDay, groupSlots, hasPhrase, leadWords, pickupLabel, pickupLong, preorderUnits, PREORDER_STEPS } from '../../src/shop/preorderView';
import { parseDraft, useCheckoutDraft } from '../../src/shop/checkoutDraft';
import { ShopError } from '../../src/shop/api';
import { tr, type K } from '../../src/shop/i18n';
import { errText, orderSteps } from '../../src/shop/ui';
import { addDays, preError, slotInstant, sortFlags, statusText, untilText } from '../../src/preorders/view';
import { t as tl } from '../../src/lib/i18n';

describe('shop time (Asia/Bangkok), whatever the phone\'s own time zone is', () => {
  it('a time late in the evening in Bangkok is the next day in UTC but stays on its Bangkok day', () => {
    const iso = '2026-11-30T17:30:00Z';                     // = 00:30 on 1 December in Bangkok
    expect(bkkDayKey(iso)).toBe('2026-12-01');
    expect(bkkTime(iso)).toBe('00:30');
  });
  it('a time at 23:59 in Bangkok is still that day (the boundary a UTC-based date would get wrong)', () => {
    const iso = '2026-11-30T16:59:00Z';                     // = 23:59 on 30 November in Bangkok
    expect(bkkDayKey(iso)).toBe('2026-11-30');
    expect(bkkTime(iso)).toBe('23:59');
  });
  it('a slot start is the wall-clock time the shop printed', () => {
    expect(bkkTime(slotInstant('2026-12-05', '10:30'))).toBe('10:30');
    expect(bkkDayKey(slotInstant('2026-12-05', '10:30'))).toBe('2026-12-05');
    expect(bkkDayKey(slotInstant('2026-12-05', '00:00'))).toBe('2026-12-05');
  });
  it('day keys add whole days across a month and a year end', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('bad input gives an empty text, never "Invalid Date"', () => {
    expect(bkkTime(null)).toBe(''); expect(bkkTime('nope')).toBe(''); expect(bkkDayKey('nope')).toBe(''); expect(pickupLabel('nope', 'th')).toBe(''); expect(pickupLong(undefined, 'en')).toBe('');
  });
  it('the one-line label has the weekday, the date and the time in each language', () => {
    expect(pickupLabel('2026-11-30T03:00:00Z', 'en')).toMatch(/^Mon 30 Nov, 10:00$/);
    expect(pickupLabel('2026-11-30T03:00:00Z', 'th')).toMatch(/10:00 น\.$/);
    expect(pickupLong('2026-11-30T03:00:00Z', 'en')).toContain('10:00');
    expect(dayParts('2026-12-01', 'en')).toEqual({ weekday: 'Tue', date: '1 Dec' });
  });
});

describe('the day list', () => {
  const days = [
    { day: '2026-12-01', closed: true, open: null, close: null, reason: 'Holiday', free_slots: 0 },
    { day: '2026-12-02', closed: false, open: '09:00', close: '18:00', reason: null, free_slots: 0 },
    { day: '2026-12-03', closed: false, open: '09:00', close: '18:00', reason: null, free_slots: 7 },
  ];
  it('a day is closed, full or ok', () => { expect(days.map(dayState)).toEqual(['closed', 'full', 'ok']); });
  it('the first day with room is offered first', () => { expect(firstBookableDay(days)).toBe('2026-12-03'); expect(firstBookableDay([days[0], days[1]])).toBeNull(); expect(firstBookableDay(undefined)).toBeNull(); });
  it('the lead time is said in minutes, hours or both', () => {
    expect(leadWords(45)).toEqual({ key: 'po.lead.min', vars: { n: 45 } });
    expect(leadWords(120)).toEqual({ key: 'po.lead.hour', vars: { n: 2 } });
    expect(leadWords(90)).toEqual({ key: 'po.lead.hourMin', vars: { h: 1, m: 30 } });
    expect(leadWords(-5)).toEqual({ key: 'po.lead.min', vars: { n: 0 } });
  });
  it('slots are grouped into morning, afternoon and evening, empty groups left out', () => {
    const g = groupSlots([{ time: '09:00' }, { time: '11:30' }, { time: '12:00' }, { time: '16:30' }, { time: '17:00' }]);
    expect(g.map((x) => [x.key, x.slots.map((s) => s.time)])).toEqual([['am', ['09:00', '11:30']], ['pm', ['12:00', '16:30']], ['eve', ['17:00']]]);
    expect(groupSlots([{ time: '13:00' }]).map((x) => x.key)).toEqual(['pm']);
  });
});

describe('what the shop must prepare, and the instructions', () => {
  it('units add up the quantities', () => { expect(preorderUnits([{ qty: 5 }, { qty: 3 }, { qty: 10 }])).toBe(18); expect(preorderUnits([])).toBe(0); });
  it('a quick phrase is added once, separated, and only while it fits', () => {
    expect(addPhrase('', 'Pack separately.')).toBe('Pack separately.');
    expect(addPhrase('Call me.', 'Pack separately.')).toBe('Call me. Pack separately.');
    expect(addPhrase('Pack separately.', 'Pack separately.')).toBe('Pack separately.');
    expect(addPhrase('x'.repeat(290), 'Pack separately.')).toBe('x'.repeat(290));
    expect(hasPhrase('Call me. Pack separately.', 'Pack separately.')).toBe(true);
  });
  it('the phrases of the app are short enough to add all three to a note', () => {
    let n = '';
    for (const k of ['po.ph.ready', 'po.ph.separate', 'po.ph.call'] as K[]) n = addPhrase(n, tr('th', k));
    expect(n.length).toBeLessThanOrEqual(300);
    expect(['po.ph.ready', 'po.ph.separate', 'po.ph.call'].every((k) => hasPhrase(n, tr('th', k as K)))).toBe(true);
  });
});

describe('the order page of a preorder', () => {
  it('a preorder passes through five steps (no packing step), a regular pick-up order keeps six', () => {
    expect(orderSteps('pickup', 'preorder')).toEqual(['new', 'confirmed', 'preparing', 'ready', 'completed']);
    expect([...PREORDER_STEPS]).toEqual(orderSteps('pickup', 'preorder'));
    expect(orderSteps('pickup')).toEqual(['new', 'confirmed', 'preparing', 'packed', 'ready', 'completed']);
    expect(orderSteps('delivery', 'regular')).toEqual(['new', 'confirmed', 'preparing', 'packed', 'shipped', 'completed']);
  });
  it('the change window follows the server: closed when the server says so, or when the deadline passed on the phone', () => {
    const base = { deadline: '2026-12-01T10:00:00Z', can_reschedule: true };
    expect(changeOpen(base, Date.parse('2026-12-01T09:59:00Z'))).toBe(true);
    expect(changeOpen(base, Date.parse('2026-12-01T10:01:00Z'))).toBe(false);
    expect(changeOpen({ ...base, can_reschedule: false }, Date.parse('2026-11-01T00:00:00Z'))).toBe(false);
    expect(changeOpen(null)).toBe(false); expect(changeOpen(undefined)).toBe(false);
  });
});

describe('the checkout draft keeps the preorder choice', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    useCheckoutDraft.setState({ uid: null, text: {}, slip: null });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('reads the choice and the time, drops anything odd', () => {
    expect(parseDraft(JSON.stringify({ preorder: true, pickupAt: '2026-12-01T03:00:00.000Z', fulfilment: 'pickup' }))).toEqual({ preorder: true, pickupAt: '2026-12-01T03:00:00.000Z', fulfilment: 'pickup' });
    expect(parseDraft(JSON.stringify({ preorder: 'yes', pickupAt: 'tomorrow' }))).toEqual({});
    expect(parseDraft(JSON.stringify({ pickupAt: 5 }))).toEqual({});
  });
  it('survives a reload and is forgotten with the order', () => {
    const s = () => useCheckoutDraft.getState();
    s().hydrate('u1'); s().patch({ preorder: true, pickupAt: '2026-12-01T03:00:00.000Z' });
    useCheckoutDraft.setState({ uid: null, text: {} }); s().hydrate('u1');
    expect(s().text.preorder).toBe(true); expect(s().text.pickupAt).toBe('2026-12-01T03:00:00.000Z');
    s().hydrate('u2'); expect(s().text.preorder).toBeUndefined();
    s().hydrate('u1'); s().clear(); expect(s().text).toEqual({});
  });
});

describe('the coded errors of the database', () => {
  const en = (k: K, v?: Record<string, string | number>) => tr('en', k, v);
  it('the customer app says each refusal in words, never the generic message', () => {
    for (const code of ['SLOT_FULL', 'SLOT_TOO_SOON', 'SLOT_UNITS_FULL', 'SLOT_CLOSED', 'RESCHEDULE_LIMIT', 'TOO_LATE_TO_CHANGE', 'PREORDER_OFF', 'DAY_UNITS_FULL', 'INVALID_MESSAGE', 'TOO_MANY_REQUESTS']) {
      const msg = errText(en, new ShopError(code, code));
      expect(msg).not.toBe(en('err.generic'));
      expect(msg).toBe(en(`po.err.${code}` as K));
    }
  });
  it('an unknown code still gets the generic message', () => { expect(errText(en, new ShopError('x', 'WHATEVER'))).toBe(en('err.generic')); });
  const T = (s: string, v?: Record<string, string | number>) => tl('en', s, v);
  it('the back office turns the codes into sentences, with the detail', () => {
    expect(preError(new ShopError('PAYMENT_REQUIRED', 'PAYMENT_REQUIRED'), T)).toMatch(/Payment has not been verified/);
    expect(preError(new ShopError('PREP_INCOMPLETE: 1 of 3 items ticked', 'PREP_INCOMPLETE'), T)).toMatch(/Tick every item.*1 of 3 items ticked/);
    expect(preError(new ShopError('DAY_HAS_ORDERS: 2 active preorder(s) would no longer fit', 'DAY_HAS_ORDERS'), T)).toMatch(/2 active preorder/);
    expect(preError(new ShopError('INVALID_SETTING: a value is out of range', 'INVALID_SETTING'), T)).toBe('a value is out of range');
    expect(preError(new ShopError('timeout', 'NETWORK'), T)).toMatch(/Could not connect/);
    expect(preError(new Error('boom'), T)).toBe('boom');
  });
  it('flags are ordered most urgent first, and a rejected order is called rejected', () => {
    expect(sortFlags(['large', 'unpaid_soon', 'late', 'not_started'])).toEqual(['late', 'not_started', 'unpaid_soon', 'large']);
    expect(statusText('cancelled', 'rejected')).toBe('Rejected'); expect(statusText('cancelled', 'customer')).toBe('Cancelled'); expect(statusText('ready')).toBe('Ready for pickup');
  });
  it('the time until pickup is said both ways', () => {
    const now = Date.parse('2026-12-01T03:00:00Z');
    expect(untilText('2026-12-01T03:45:00Z', T, now)).toEqual({ text: 'in 45 min', late: false });
    expect(untilText('2026-12-01T05:10:00Z', T, now)).toEqual({ text: 'in 2 h 10 min', late: false });
    expect(untilText('2026-12-01T02:40:00Z', T, now)).toEqual({ text: '20 min ago', late: true });
    expect(untilText('2026-12-04T03:00:00Z', T, now).text).toBe('in 3 d');
  });
});
