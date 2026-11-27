// Customer-to-customer points transfer: the pure rules of the screens (member ID, amount, which sentence a failed call gets, what a history row says),
// the texts in both languages, and the staff tab's limit checks. The database rules (reservation, accept, concurrency, rollback) are tested in
// supabase/tests/points_transfer.sql; the screens end to end in tests/shop-e2e/pointsTransfer.spec.ts.
import { describe, expect, it } from 'vitest';
import { POINTS_D } from '../../src/shop/i18n.points';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';
import * as V from '../../src/shop/pointsView';
import { t as tBack } from '../../src/lib/i18n';
import { thaiForError } from '../../src/lib/errorText';
import { adminError, checkLimits, limitsPatch, reasonText, toDraft } from '../../src/rewards/transferView';
import { ShopError } from '../../src/shop/api';
import type { Transfer, TransferLimits, TransferOverview, TransferSettings } from '../../src/rewards/transferApi';

const THAI = /[ก-๿]/;
const limits: TransferLimits = { min: 1, max: 1000, daily_max: 5000, sent_today: 0, max_pending: 10, expire_days: 7 };
const tf = (o: Partial<Transfer> = {}): Transfer => ({
  id: 'x', transfer_no: 'PT-000001', direction: 'out', status: 'pending', points: 5, message: null, created_at: '2026-11-27T10:00:00Z', expires_at: '2026-12-04T10:00:00Z',
  decided_at: null, reason: null, counterparty: { name: 'Somchai J.', code: 'AB••••GH' }, ...o,
});

describe('member ID', () => {
  it('reads the same ID however it is typed', () => {
    for (const raw of ['abcd-efgh', 'ABCD EFGH ', ' abcdefgh', 'ab cd-ef gh']) expect(V.normalizeCode(raw)).toBe('ABCDEFGH');
    expect(V.formatCode('abcdefgh')).toBe('ABCD-EFGH');
    expect(V.formatCode('abc')).toBe('ABC');
  });
  it('accepts exactly eight characters of the alphabet (no I, O, 0, 1)', () => {
    expect(V.checkCode('ABCD-EFGH')).toEqual({ ok: true, code: 'ABCDEFGH' });
    expect(V.checkCode('')).toEqual({ ok: false, key: 'pt.err.codeEmpty' });
    expect(V.checkCode('   - ')).toEqual({ ok: false, key: 'pt.err.codeEmpty' });
    for (const bad of ['ABCDEFG', 'ABCDEFGHJ', 'ABCD-EFG0', 'ABCD-EFGI', 'ABCDEFGO', 'ABCDEFG1', 'ก ข ค']) expect(V.checkCode(bad), bad).toMatchObject({ ok: false });
  });
  it('refuses the customer\'s own ID before asking the database', () => {
    expect(V.checkCode('wxyz 2345', 'WXYZ-2345')).toEqual({ ok: false, key: 'pt.err.self' });
    expect(V.checkCode('WXYZ-2346', 'WXYZ-2345')).toMatchObject({ ok: true });
  });
});

describe('amount', () => {
  const ok = (raw: string, available = 100, l = limits) => V.checkAmount(raw, { available, limits: l });
  it('takes a whole number from the minimum up to what can be sent', () => {
    expect(ok('1')).toEqual({ ok: true, points: 1 });
    expect(ok(' 25 ')).toEqual({ ok: true, points: 25 });
    expect(ok('100')).toEqual({ ok: true, points: 100 });
  });
  it('refuses empty, zero, negative, decimal, exponent, text and spaces inside', () => {
    expect(ok('')).toMatchObject({ ok: false, key: 'pt.err.amountEmpty' });
    expect(ok('   ')).toMatchObject({ ok: false, key: 'pt.err.amountEmpty' });
    for (const bad of ['0', '00', '-5', '+5', '1.5', '1,5', '1e3', '0x10', 'abc', '1 0', '٣', '５']) expect(ok(bad), bad).toMatchObject({ ok: false, key: 'pt.err.amountWhole' });
  });
  it('says which limit was hit and what the limit is', () => {
    expect(ok('3', 100, { ...limits, min: 5 })).toEqual({ ok: false, key: 'pt.err.amountMin', vars: { n: 5 } });
    expect(ok('1001', 5000)).toEqual({ ok: false, key: 'pt.err.amountMax', vars: { n: 1000 } });
    expect(ok('101', 100)).toEqual({ ok: false, key: 'pt.err.amountAvail', vars: { n: 100 } });
    expect(ok('1', 0)).toMatchObject({ ok: false, key: 'pt.err.nothing' });
    expect(ok('300', 1000, { ...limits, sent_today: 4800 })).toEqual({ ok: false, key: 'pt.err.amountDaily', vars: { n: 200 } });
    expect(ok('200', 1000, { ...limits, sent_today: 4800 })).toEqual({ ok: true, points: 200 });
  });
  it('a huge number is a limit error, never a rounding accident', () => {
    expect(ok('99999999999999999999')).toMatchObject({ ok: false, key: 'pt.err.amountMax' });
  });
  it('the most that can be sent is the smallest of: available, per transfer, left today', () => {
    expect(V.maxSendable(100, limits)).toBe(100);
    expect(V.maxSendable(5000, limits)).toBe(1000);
    expect(V.maxSendable(5000, { ...limits, sent_today: 4700 })).toBe(300);
    expect(V.maxSendable(-3, limits)).toBe(0);
    expect(V.dailyLeft({ ...limits, sent_today: 9000 })).toBe(0);
  });
  it('the message is optional and at most 140 characters', () => {
    expect(V.checkMessage('   ')).toEqual({ ok: true, text: null });
    expect(V.checkMessage(' hi ')).toEqual({ ok: true, text: 'hi' });
    expect(V.checkMessage('x'.repeat(140))).toMatchObject({ ok: true });
    expect(V.checkMessage('x'.repeat(141))).toEqual({ ok: false, key: 'pt.err.msgLong' });
  });
});

describe('a failed call', () => {
  const codes = ['TRANSFERS_OFF', 'TOO_MANY_LOOKUPS', 'RECIPIENT_NOT_FOUND', 'SELF_TRANSFER', 'POINTS_OUT_OF_RANGE', 'MESSAGE_TOO_LONG', 'TOO_MANY_PENDING', 'DAILY_LIMIT',
    'INSUFFICIENT_POINTS', 'TRANSFER_NOT_PENDING', 'POINTS_RESERVED', 'INVALID_KEY', 'KEY_REUSED', 'NOT_FOUND', 'FORBIDDEN', 'NETWORK', 'ERROR', 'SOMETHING_NEW'];
  it('every code gets a sentence that exists in both languages', () => {
    for (const what of ['send', 'answer'] as const) for (const c of codes) {
      const p = V.errorPlan(c, what);
      expect(SHOP_KEYS, `${c}/${what}`).toContain(p.key);
      expect(tr('th', p.key, { n: 1 }), p.key).toMatch(THAI);
      expect(tr('en', p.key, { n: 1 })).not.toMatch(THAI);
    }
  });
  it('a lost connection or an unknown failure on a SEND keeps the key: the next press is the same request, never a second transfer', () => {
    for (const c of ['NETWORK', 'ERROR', 'SOMETHING_NEW']) expect(V.errorPlan(c, 'send'), c).toMatchObject({ key: 'pt.stillSending', keepKey: true });
  });
  it('a clear refusal drops the key, so the corrected request is a new one', () => {
    for (const c of ['RECIPIENT_NOT_FOUND', 'SELF_TRANSFER', 'INSUFFICIENT_POINTS', 'DAILY_LIMIT', 'TOO_MANY_PENDING', 'TRANSFERS_OFF', 'KEY_REUSED']) expect(V.errorPlan(c, 'send').keepKey, c).toBe(false);
  });
  it('a stale screen is refreshed (a request answered meanwhile, a limit that moved, the switch turned off)', () => {
    for (const c of ['TRANSFER_NOT_PENDING', 'NOT_FOUND', 'INSUFFICIENT_POINTS', 'DAILY_LIMIT', 'TRANSFERS_OFF', 'TOO_MANY_PENDING']) expect(V.errorPlan(c, 'answer').refresh, c).toBe(true);
  });
  it('INSUFFICIENT_POINTS and DAILY_LIMIT carry the number the database reported', () => {
    expect(V.errorPlan('INSUFFICIENT_POINTS', 'send', { available: 7 })).toMatchObject({ key: 'pt.err.amountAvail', vars: { n: 7 } });
    expect(V.errorPlan('INSUFFICIENT_POINTS', 'send', { available: -2 })).toMatchObject({ vars: { n: 0 } });
    expect(V.errorPlan('DAILY_LIMIT', 'send', { dailyLeft: 40 })).toMatchObject({ key: 'pt.err.amountDaily', vars: { n: 40 } });
  });
  it('answering (accept / decline / cancel) never says "still sending"', () => {
    expect(V.errorPlan('ERROR', 'answer').key).toBe('err.generic');
    expect(V.errorPlan('NETWORK', 'answer').key).toBe('err.network');
  });
});

describe('rows', () => {
  it('only an accepted transfer moves points: + for the recipient, - for the sender', () => {
    expect(V.movement(tf({ status: 'accepted', direction: 'in', points: 3 }))).toBe(3);
    expect(V.movement(tf({ status: 'accepted', direction: 'out', points: 3 }))).toBe(-3);
    for (const status of ['pending', 'rejected', 'cancelled', 'expired'] as const) { expect(V.movement(tf({ status, direction: 'in' }))).toBe(0); expect(V.movement(tf({ status, direction: 'out' }))).toBe(0); }
  });
  it('explains the reasons a customer can meet, and nothing else', () => {
    expect(V.reasonKey(tf({ status: 'cancelled', reason: 'SENDER_BALANCE_CHANGED' }))).toBe('pt.why.balance');
    expect(V.reasonKey(tf({ status: 'cancelled', reason: 'ADMIN: duplicate request' }))).toBe('pt.why.admin');
    expect(V.reasonKey(tf({ status: 'cancelled', reason: 'CANCELLED_BY_SENDER' }))).toBe('pt.why.sender');
    expect(V.reasonKey(tf({ status: 'rejected', reason: 'REJECTED' }))).toBeNull();
    expect(V.reasonKey(tf({ status: 'cancelled', reason: null }))).toBeNull();
  });
  it('every status has a label in both languages', () => {
    for (const s of ['pending', 'accepted', 'rejected', 'cancelled', 'expired'] as const) { expect(tr('th', V.STATUS_KEY[s])).toMatch(THAI); expect(V.statusTone(s)).toMatch(/good|bad|warn|info/); }
  });
  it('the entry row shows the larger of unread news and waiting requests, and nothing when transfers are off', () => {
    const on = (o: Partial<Extract<TransferOverview, { enabled: true }>>): TransferOverview => ({
      enabled: true, member_code: 'ABCD-EFGH', balance: 10, reserved: 0, available: 10, limits, incoming: [], outgoing: [], history: [], unread: 0, ...o });
    expect(V.entryBadge(null)).toBe(0);
    expect(V.entryBadge({ enabled: false })).toBe(0);
    expect(V.entryBadge(on({}))).toBe(0);
    expect(V.entryBadge(on({ unread: 2 }))).toBe(2);
    expect(V.entryBadge(on({ unread: 0, incoming: [tf({ direction: 'in' })] }))).toBe(1);
    expect(V.waitingForMe(on({ incoming: [tf(), tf({ id: 'y' })] }))).toBe(2);
    expect(V.waitingForMe({ enabled: false })).toBe(0);
  });
  it('a request past its time is not live, whatever the status says', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    expect(V.isLive(tf(), now)).toBe(true);
    expect(V.isLive(tf({ expires_at: '2026-11-30T23:59:59Z' }), now)).toBe(false);
    expect(V.isLive(tf({ status: 'accepted' }), now)).toBe(false);
  });
});

describe('the customer texts', () => {
  const keys = Object.keys(POINTS_D) as (keyof typeof POINTS_D)[];
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  it('every text exists in the shop dictionary, in Thai and English', () => {
    for (const k of keys) { expect(SHOP_KEYS).toContain(k); expect(POINTS_D[k][0], k).toMatch(THAI); expect(POINTS_D[k][1], k).not.toMatch(THAI); expect(POINTS_D[k][1].length).toBeGreaterThan(1); }
  });
  it('both languages fill the same blanks, and no blank is left empty', () => {
    for (const k of keys) {
      expect(holes(POINTS_D[k][0]), k).toBe(holes(POINTS_D[k][1]));
      const vars = Object.fromEntries(holes(POINTS_D[k][0]).split(',').filter(Boolean).map((h) => [h, '7']));
      expect(tr('th', k, vars), k).not.toMatch(/\{\w+\}/);
      expect(tr('en', k, vars), k).not.toMatch(/\{\w+\}/);
    }
  });
  it('uses the same words for the same buttons in both places a customer meets them', () => {
    expect(POINTS_D['pt.accept'][0]).toBe('รับแต้ม');
    expect(POINTS_D['pt.reject'][0]).toBe('ปฏิเสธ');
    expect(POINTS_D['pt.cancel'][0]).toBe('ยกเลิกคำขอ');
  });
});

describe('Thai for what the database says', () => {
  it('keeps the numbers in the sentence', () => {
    const th = thaiForError('INSUFFICIENT_POINTS: 5 points are available (balance 8, held by pending transfers 3)');
    expect(th).toMatch(THAI); expect(th).toMatch(/5/); expect(th).toMatch(/8/); expect(th).toMatch(/3/);
    expect(thaiForError('DAILY_LIMIT: at most 5000 points can be sent per day')).toMatch(/5000/);
    expect(thaiForError('POINTS_OUT_OF_RANGE: a transfer is between 1 and 1000 points')).toMatch(/1.*1000/);
    expect(thaiForError('TOO_MANY_PENDING: you already have 10 pending transfers')).toMatch(/10/);
    expect(thaiForError('POINTS_RESERVED: 6 points are held by pending transfers (balance 10)')).toMatch(/6.*10/);
  });
  it('every code the transfer functions raise has a Thai meaning', () => {
    for (const c of ['TRANSFERS_OFF', 'TOO_MANY_LOOKUPS', 'RECIPIENT_NOT_FOUND', 'SELF_TRANSFER', 'POINTS_OUT_OF_RANGE', 'MESSAGE_TOO_LONG', 'TOO_MANY_PENDING', 'DAILY_LIMIT', 'INSUFFICIENT_POINTS', 'TRANSFER_NOT_PENDING', 'POINTS_RESERVED'])
      expect(thaiForError(c), c).toMatch(THAI);
  });
});

describe('staff tab', () => {
  const saved: TransferSettings = { transfers_enabled: false, min_points: 1, max_points: 1000, daily_max_points: 5000, max_pending: 10, expire_days: 7, rewards_enabled: true };
  it('limits must be whole numbers that fit together', () => {
    expect(checkLimits(toDraft(saved))).toBeNull();
    expect(checkLimits({ ...toDraft(saved), min_points: 0 })).not.toBeNull();
    expect(checkLimits({ ...toDraft(saved), max_points: Number.NaN })).not.toBeNull();
    expect(checkLimits({ ...toDraft(saved), max_points: 12.5 })).not.toBeNull();
    expect(checkLimits({ ...toDraft(saved), min_points: 50, max_points: 40 })?.key).toMatch(/largest/);
    expect(checkLimits({ ...toDraft(saved), daily_max_points: 999 })?.key).toMatch(/daily/);
    expect(checkLimits({ ...toDraft(saved), max_pending: 101 })?.key).toMatch(/100/);
    expect(checkLimits({ ...toDraft(saved), expire_days: 91 })?.key).toMatch(/90/);
    expect(checkLimits({ ...toDraft(saved), max_pending: 100, expire_days: 90 })).toBeNull();
  });
  it('only what changed is sent', () => {
    expect(limitsPatch(toDraft(saved), saved)).toEqual({});
    expect(limitsPatch({ ...toDraft(saved), max_points: 500, expire_days: 3 }, saved)).toEqual({ max_points: 500, expire_days: 3 });
  });
  it('every staff sentence has Thai', () => {
    const seen: { key: string; vars: Record<string, string | number> }[] = [
      checkLimits({ ...toDraft(saved), min_points: 0 })!, checkLimits({ ...toDraft(saved), min_points: 50, max_points: 40 })!, checkLimits({ ...toDraft(saved), daily_max_points: 999 })!,
      checkLimits({ ...toDraft(saved), max_pending: 101 })!, checkLimits({ ...toDraft(saved), expire_days: 91 })!,
      ...['SENDER_BALANCE_CHANGED', 'CANCELLED_BY_SENDER', 'EXPIRED', 'ADMIN: duplicate'].map((reason) => reasonText({ status: 'cancelled', reason })!),
      ...['FORBIDDEN', 'NETWORK', 'TRANSFER_NOT_PENDING', 'REASON_REQUIRED', 'NOT_FOUND', 'BAD_VALUE', 'BAD_FIELD', 'WHATEVER'].flatMap((code) => [adminError(new ShopError(`${code}: details`, code)), adminError(new ShopError(code, code))]),
      adminError(new Error('boom')), adminError('x'),
    ];
    for (const m of seen) { const th = tBack('th', m.key, m.vars); expect(th, m.key).toMatch(THAI); expect(th).not.toMatch(/\{\w+\}/); }
  });
  it('a reason is not invented where the status says it all, and an unknown one is shown as it is', () => {
    expect(reasonText({ status: 'cancelled', reason: 'something else' })).toEqual({ key: '{why}', vars: { why: 'something else' } });
    expect(reasonText({ status: 'accepted', reason: null })).toBeNull();
    expect(reasonText({ status: 'rejected', reason: 'REJECTED' })).toBeNull();
    expect(reasonText({ status: 'pending', reason: null })).toBeNull();
  });
});
