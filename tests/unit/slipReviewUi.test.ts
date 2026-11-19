// What the slip-review screens show (src/finance/reviewUi.ts): de-duplicated reasons, signal and reason values as text, the comparison of the order with what the AI read,
// the readable sentence for a refusal from the database, who may post, and that every sentence the screens can show has a Thai text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { t } from '../../src/lib/i18n';
import { errorToastText, thaiForError } from '../../src/lib/errorText';
import type { Reason, SlipAnalysis } from '../../src/finance/review';
import {
  compareRows, confirmPrefill, expectedOf, fromLocalInput, hasDiscrepancy, isFutureInput, isMissingMigration, localInput, mayPost, reasonValue, reviewErrorLine, reviewErrorText, serverSentence, SERVER_SENTENCES,
  SIGNAL_CODES, SIGNAL_TEXT, summaryRange, todayBkk, transferredOf, uniqueCodes, uniqueReasons,
} from '../../src/finance/reviewUi';
import type { ReviewItem, ReviewSettings } from '../../src/finance/review';

const reason = (code: string, severity: Reason['severity'], over: Partial<Reason> = {}): Reason => ({ code, severity, field: null, expected: null, found: null, message: '', ...over });

describe('reasons are shown once each', () => {
  it('a repeated code is kept at its first position, with the most serious of the repeats', () => {
    const out = uniqueReasons([reason('DUPLICATE_REFERENCE', 'warn'), reason('AMOUNT_UNDER', 'high'), reason('DUPLICATE_REFERENCE', 'high', { found: 'second' })]);
    expect(out.map((r) => r.code)).toEqual(['DUPLICATE_REFERENCE', 'AMOUNT_UNDER']);
    expect(out[0].severity).toBe('high');
    expect(uniqueReasons(null)).toEqual([]);
  });
  it('codes of the list are de-duplicated in order', () => { expect(uniqueCodes(['A', 'B', 'A', 'C', 'B'])).toEqual(['A', 'B', 'C']); expect(uniqueCodes(undefined)).toEqual([]); });
  it('a value is text whatever it is; an amount is money', () => {
    expect(reasonValue({ field: 'amount' }, 350)).toBe('฿350.00');
    expect(reasonValue({ field: 'trans_ref' }, 'SCB123')).toBe('SCB123');
    expect(reasonValue({ field: 'qr' }, true)).toBe('true');
    expect(reasonValue({ field: 'receiver' }, ['SCB · A', 'BBL · B'])).toBe('SCB · A, BBL · B');
    expect(reasonValue({ field: 'transfer_at' }, { from: '2026-11-19', to: '2026-11-20' })).toBe('2026-11-19 – 2026-11-20');
    expect(reasonValue({ field: 'amount' }, null)).toBe('');
  });
});

describe('tamper signals have a text', () => {
  it('the six codes the reader may send have English and Thai, an unknown code is shown as it is, never a function of Object.prototype', () => {
    expect(SIGNAL_CODES.sort()).toEqual(['blur_region', 'duplicate_artifacts', 'font_mismatch', 'inconsistent_layout', 'misaligned_text', 'other']);
    for (const c of SIGNAL_CODES) { const x = SIGNAL_TEXT(c); expect(x.en, c).not.toBe(c); expect(x.th, c).toMatch(/[ก-๿]/); }
    expect(SIGNAL_TEXT('new_signal')).toEqual({ en: 'new_signal', th: 'new_signal' });
    expect(SIGNAL_TEXT('constructor')).toEqual({ en: 'constructor', th: 'constructor' });
    expect(SIGNAL_TEXT('__proto__')).toEqual({ en: '__proto__', th: '__proto__' });
  });
});

describe('the comparison of the order with what the AI read', () => {
  const analysis = (over: Partial<SlipAnalysis> = {}): SlipAnalysis => ({
    id: 'a', attempt: 1, status: 'done', engine: 'x', prompt_version: 'v1', overall_confidence: 0.93, signals: [], result: 'amount_mismatch', error: null, requested_by: null, created_at: '', started_at: null, finished_at: null, qr: { found: true, crc_ok: true, sending_bank: '004', trans_ref: 'REF123456' },
    expected: { amount: 350, order_created_at: '2026-11-19T02:55:00Z', window_from: '2026-11-19T00:55:00Z', window_to: '2026-11-19T04:20:00Z', receivers: [{ label: 'SCB · A', bank: 'SCB', name: 'A', account_no_masked_digits: 'xxx-2625-1' }] },
    extracted: { amount: 300, transfer_at: '2026-11-19T03:50:00Z', time_known: true, is_slip: true, bank: 'KBank', sender: { name: 'C', bank: 'KBank', account_hint: null }, receiver: { name: 'A', bank: 'SCB', account_hint: 'xxx-2625-1' }, trans_ref: 'REF123456', trans_id: null, status_text: 'ok', field_confidence: { amount: 0.93, date: 0.98, time: 0.96, receiver: 0.95, ref: 0.94 } },
    reasons: [reason('AMOUNT_UNDER', 'high', { field: 'amount', expected: 350, found: 300 })], ...over,
  });
  it('marks only the amount as differing for the mismatch slip, with the confidence of each field', () => {
    const rows = compareRows(analysis());
    expect(rows.map((r) => r.field)).toEqual(['amount', 'date', 'time', 'receiver', 'bank', 'reference']);
    expect(rows.filter((r) => r.differs).map((r) => r.field)).toEqual(['amount']);
    expect(rows[0]).toMatchObject({ expected: '฿350.00', found: '฿300.00', confidence: 0.93 });
    expect(rows[1].found).toBe('19 Nov 2026'); expect(rows[2].found).toBe('10:50'); expect(rows[2].expected).toBe('07:55 – 11:20');   // Bangkok time
    expect(rows[3]).toMatchObject({ expected: 'SCB · A', found: 'A · xxx-2625-1' }); expect(rows[5]).toMatchObject({ expected: 'REF123456', found: 'REF123456', differs: false });
  });
  it('an amount the reader could not find, where one is expected, differs; with no expectation it does not', () => {
    const x = analysis().extracted!;
    expect(compareRows(analysis({ extracted: { ...x, amount: null }, reasons: [] }))[0].differs).toBe(true);
    expect(compareRows(analysis({ extracted: { ...x, amount: null }, expected: { ...analysis().expected!, amount: null }, reasons: [] }), null)[0].differs).toBe(false);
    expect(compareRows(analysis({ expected: { ...analysis().expected!, amount: null } }), 300)[0]).toMatchObject({ expected: '฿300.00', differs: true });   // the reason still says AMOUNT_UNDER
  });
  it('a date outside the window, a missing time and a mismatching receiver or reference are red; nothing to compare gives no rows', () => {
    const x = analysis().extracted!;
    const rows = compareRows(analysis({ extracted: { ...x, amount: 350, transfer_at: '2026-11-25T03:50:00Z', time_known: false, trans_ref: 'OTHER' }, reasons: [reason('RECEIVER_MISMATCH', 'high'), reason('QR_REF_MISMATCH', 'high')] }));
    expect(rows.filter((r) => r.differs).map((r) => r.field)).toEqual(['date', 'time', 'receiver', 'bank', 'reference']);
    expect(compareRows(null)).toEqual([]); expect(compareRows(analysis({ extracted: null }))).toEqual([]);
  });
});

describe('the list: discrepancy, expected and transferred', () => {
  const item = (o: Partial<ReviewItem>): ReviewItem => ({ ai_result: null, ai_amount: null, expected_amount: null, ai_status: null, confirmed_amount: null, stage: 'slip_submitted', ...o } as ReviewItem);
  it('a mismatch, duplicate or suspicious result, or an amount that differs, is a discrepancy; a match and a reading still in progress are not', () => {
    expect(hasDiscrepancy(item({ ai_result: 'amount_mismatch', ai_status: 'done' }))).toBe(true);
    expect(hasDiscrepancy(item({ ai_result: 'duplicate_suspected', ai_status: 'done' }))).toBe(true);
    expect(hasDiscrepancy(item({ ai_result: 'match', ai_status: 'done', ai_amount: 300, expected_amount: 350 }))).toBe(true);
    expect(hasDiscrepancy(item({ ai_result: 'match', ai_status: 'done', ai_amount: 350, expected_amount: 350 }))).toBe(false);
    expect(hasDiscrepancy(item({ ai_result: null, ai_status: 'queued' }))).toBe(false);
    expect(hasDiscrepancy(item({ ai_result: 'time_anomaly', ai_status: 'done' }))).toBe(false);
  });
  it('zero expected is "nothing to compare"; a confirmed or posted payment shows its confirmed amount when the AI read none', () => {
    expect(expectedOf({ expected_amount: 0 })).toBeNull(); expect(expectedOf({ expected_amount: null })).toBeNull(); expect(expectedOf({ expected_amount: 120 })).toBe(120);
    expect(transferredOf({ ai_amount: 300, confirmed_amount: 280, stage: 'confirmed' })).toEqual({ amount: 300, from: 'ai' });
    expect(transferredOf({ ai_amount: null, confirmed_amount: 180, stage: 'posted' })).toEqual({ amount: 180, from: 'confirmed' });
    expect(transferredOf({ ai_amount: null, confirmed_amount: 180, stage: 'ai_completed' })).toBeNull();
    expect(transferredOf({ ai_amount: null, confirmed_amount: null, stage: 'confirmed' })).toBeNull();
  });
});

describe('who may post', () => {
  const s = (post_requires_manager: boolean): ReviewSettings => ({ ai_review_enabled: true, post_requires_manager, ai_min_confidence: 0.8, slip_window_before_min: 120, slip_future_tolerance_min: 10 });
  it('a verifier posts unless a manager is required; a manager always; a clerk and a viewer never', () => {
    expect(mayPost('verifier', s(false))).toBe(true); expect(mayPost('verifier', s(true))).toBe(false); expect(mayPost('manager', s(true))).toBe(true);
    expect(mayPost('clerk', s(false))).toBe(false); expect(mayPost('viewer', s(false))).toBe(false); expect(mayPost(null, s(false))).toBe(false);
  });
  it('settings that could not be read mean the stricter rule', () => { expect(mayPost('verifier', null)).toBe(false); expect(mayPost('verifier', undefined)).toBe(false); expect(mayPost('manager', null)).toBe(true); });
});

describe('refusals from the database become sentences', () => {
  it('each known code has a sentence, in English and in Thai, and keeps the database text under it', () => {
    const cases: [string, string][] = [
      ['Post payment: NOT_CONFIRMED: this slip is rejected (it must be confirmed before it is posted)', 'This payment is not confirmed, so it cannot be posted. Confirm it first.'],
      ['Request more evidence: NO_CUSTOMER_SLIP: a payment recorded by staff has no customer slip to ask for', 'A payment recorded by staff has no customer slip to ask for.'],
      ['Request analysis: TOO_MANY_ATTEMPTS: this slip has already been analysed 5 times', 'The AI has already checked this slip 5 times. Please check it by hand.'],
      ['Request analysis: ALREADY_QUEUED: an analysis of this slip is already waiting or running', 'An AI check of this slip is already waiting or running.'],
      ['Request analysis: AI_DISABLED: the AI review is switched off', 'The AI check is switched off. A manager can turn it on under Review settings.'],
      ['Record payment: CASH_OVERPAY: cash of 500 is more than the 350 this invoice still owes', 'Cash cannot be more than the invoice still owes, and cash is never credited to the customer’s wallet.'],
      ['Record payment: NOTE_REQUIRED: say where the cash was received (at least 3 characters)', 'Say where the cash was received (at least 3 characters).'],
    ];
    for (const [raw, en] of cases) {
      expect(serverSentence(raw)?.key, raw).toBe(en);
      const th = t('th', en); expect(th, en).not.toBe(en); expect(th).toMatch(/[ก-๿]/);
      expect(reviewErrorText('en', new Error(raw)).split('\n')).toEqual([en, th, raw]);
      expect(reviewErrorText('th', new Error(raw)).split('\n')).toEqual([th, en, raw]);
      expect(reviewErrorLine('en', new Error(raw))).toBe(en);
    }
  });
  it('EXCEEDS_OUTSTANDING says how much is left', () => {
    const raw = 'Record payment: EXCEEDS_OUTSTANDING: 500 is more than the 150 that can still be added to this invoice';
    expect(reviewErrorText('en', new Error(raw)).split('\n')[0]).toBe('That is more than can still be added to this invoice (฿150.00 left, counting payments confirmed but not yet posted).');
    expect(reviewErrorText('th', new Error(raw)).split('\n')[0]).toBe('เกินจำนวนที่เพิ่มในใบแจ้งหนี้นี้ได้ (เหลือ ฿150.00 นับรวมการชำระที่ยืนยันแล้วแต่ยังไม่ได้ลงรายการ)');
    expect(serverSentence('EXCEEDS_OUTSTANDING: nothing parseable')!.vars).toEqual({});
  });
  it('a message it has no sentence for is returned as it is', () => {
    expect(reviewErrorText('en', new Error('Confirm payment: This slip is already confirmed'))).toBe('Confirm payment: This slip is already confirmed');
    expect(reviewErrorText('th', 'boom')).toBe('boom'); expect(serverSentence('INVALID_SETTING: ai_min_confidence must be a number from 0 to 1')).toBeNull();
    expect(reviewErrorLine('en', new Error('Post payment: boom'))).toBe('Post payment: boom');
  });
  it('every sentence has a Thai text that keeps its placeholders', () => {
    for (const en of SERVER_SENTENCES) { const th = t('th', en); expect(th, en).not.toBe(en); expect(th, en).toMatch(/[ก-๿]/); expect((en.match(/\{\w+\}/g) ?? []).sort(), en).toEqual((th.match(/\{\w+\}/g) ?? []).sort()); }
  });
  it('a database without the migration is told apart from any other error', () => {
    expect(isMissingMigration('Load slip review: Could not find the function public.finance_review_list(p_filter, p_limit, p_offset) in the schema cache')).toBe(true);
    expect(isMissingMigration('Load slip review: function finance_review_list does not exist')).toBe(true);
    expect(isMissingMigration('Load slip review: You are not allowed to see the slip review')).toBe(false);
  });
});

describe('times are the shop’s own (Bangkok), whatever time zone the browser is in', () => {
  const zones = ['Asia/Bangkok', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC'];
  const inZone = (tz: string, fn: () => void) => { const was = process.env.TZ; process.env.TZ = tz; try { fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; } };
  it('an instant becomes the Bangkok wall clock of a datetime-local field, also next to midnight', () => {
    for (const tz of zones) inZone(tz, () => {
      expect(localInput('2026-11-19T03:50:00Z'), tz).toBe('2026-11-19T10:50');
      expect(localInput('2026-11-18T16:59:00Z'), tz).toBe('2026-11-18T23:59');            // one minute before Bangkok midnight
      expect(localInput('2026-11-18T17:00:00Z'), tz).toBe('2026-11-19T00:00');            // Bangkok midnight: the next day
      expect(localInput('2026-12-31T17:30:00Z'), tz).toBe('2027-01-01T00:30');            // and across a year end
    });
    expect(localInput(null)).toBe(''); expect(localInput('')).toBe(''); expect(localInput('not a date')).toBe('');
  });
  it('what staff type is read as Bangkok time and sent with an explicit +07:00 offset, so every browser sends the same instant', () => {
    for (const tz of zones) inZone(tz, () => {
      expect(fromLocalInput('2026-11-19T10:50'), tz).toBe('2026-11-19T03:50:00.000Z');
      expect(fromLocalInput('2026-11-19T00:00'), tz).toBe('2026-11-18T17:00:00.000Z');
      expect(fromLocalInput('2026-11-19T23:59'), tz).toBe('2026-11-19T16:59:00.000Z');
      expect(fromLocalInput('2026-11-19T10:50:30'), tz).toBe('2026-11-19T03:50:30.000Z');
    });
    expect(fromLocalInput('')).toBeNull(); expect(fromLocalInput('tomorrow')).toBeNull(); expect(fromLocalInput('2026-13-40T10:50')).toBeNull(); expect(fromLocalInput('2026-11-19')).toBeNull();
  });
  it('a value goes there and back unchanged (to the minute), in any zone', () => {
    for (const tz of zones) inZone(tz, () => {
      for (const iso of ['2026-11-19T03:50:00.000Z', '2026-11-18T17:00:00.000Z', '2026-11-18T16:59:00.000Z', '2027-01-01T04:05:00.000Z']) expect(fromLocalInput(localInput(iso)), `${tz} ${iso}`).toBe(iso);
    });
  });
  it('"today" is the Bangkok calendar day (it turns at 17:00 UTC)', () => {
    expect(todayBkk(Date.parse('2026-11-19T16:59:00Z'))).toBe('2026-11-19'); expect(todayBkk(Date.parse('2026-11-19T17:00:00Z'))).toBe('2026-11-20');
    for (const tz of zones) inZone(tz, () => expect(todayBkk(Date.parse('2026-11-19T20:00:00Z')), tz).toBe('2026-11-20'));
  });
  it('a time more than 10 minutes ahead of now is in the future (the database allows 10 minutes); an empty or broken value is not', () => {
    const now = Date.parse('2026-11-19T05:00:00Z');                                   // 12:00 in Bangkok
    expect(isFutureInput('2026-11-19T12:09', now)).toBe(false); expect(isFutureInput('2026-11-19T12:10', now)).toBe(false); expect(isFutureInput('2026-11-19T12:11', now)).toBe(true);
    expect(isFutureInput('2026-11-20T00:00', now)).toBe(true); expect(isFutureInput('', now)).toBe(false); expect(isFutureInput('x', now)).toBe(false);
  });
});

describe('the KPI strip follows the date filter; with none, it means today', () => {
  it('both dates empty: today (Bangkok) for both ends; any date set: exactly what was chosen', () => {
    const now = Date.parse('2026-11-19T20:00:00Z');                                   // already 20 Nov in Bangkok
    expect(summaryRange('', '', now)).toEqual({ from: '2026-11-20', to: '2026-11-20', today: true });
    expect(summaryRange('2026-11-01', '2026-11-19', now)).toEqual({ from: '2026-11-01', to: '2026-11-19', today: false });
    expect(summaryRange('2026-11-05', '', now)).toEqual({ from: '2026-11-05', to: '', today: false });
    expect(summaryRange('', '2026-11-05', now)).toEqual({ from: '', to: '2026-11-05', today: false });
  });
});

describe('the Confirm form is pre-filled only with what the AI really read', () => {
  const read = (over: Record<string, unknown> = {}) => ({ amount: 300, transfer_at: '2026-11-19T03:50:00Z', time_known: true, trans_ref: 'SCB777000222', ...over }) as unknown as Parameters<typeof confirmPrefill>[0];
  it('a time that was read is filled in (Bangkok clock), with the amount and the reference', () => {
    expect(confirmPrefill(read(), null)).toEqual({ amount: '300', ref: 'SCB777000222', when: '2026-11-19T10:50', unreadTimeDay: '', filled: ['amount', 'ref', 'when'] });
  });
  it('a time the AI did NOT read (it stored 12:00 of the date) is left empty; the date is only named as a hint', () => {
    const p = confirmPrefill(read({ time_known: false, transfer_at: '2026-11-19T05:00:00Z' }), null);
    expect(p.when).toBe(''); expect(p.unreadTimeDay).toBe('19 Nov 2026'); expect(p.filled).toEqual(['amount', 'ref']);          // the note must not claim the time
    expect(confirmPrefill(read({ time_known: false, transfer_at: null }), null)).toMatchObject({ when: '', unreadTimeDay: '' });
  });
  it('nothing read gives an empty form; the reference falls back to the one in the QR code', () => {
    expect(confirmPrefill(null, null)).toEqual({ amount: '', ref: '', when: '', unreadTimeDay: '', filled: [] });
    expect(confirmPrefill(read({ amount: null, trans_ref: null, transfer_at: null }), 'QR-REF-1')).toMatchObject({ amount: '', ref: 'QR-REF-1', when: '', filled: ['ref'] });
  });
});

describe('Thai for the refusals of "record payment"', () => {
  it('"older than the invoice" and "in the future" have a Thai explanation, shown beside the English text in both UI languages', () => {
    const older = 'Record payment: The payment is older than the invoice', future = 'Record payment: The payment time is in the future';
    expect(thaiForError(older)).toMatch(/[ก-๿]/); expect(thaiForError(future)).toMatch(/[ก-๿]/);
    expect(errorToastText('en', future).split('\n')).toEqual([future, thaiForError(future)]); expect(errorToastText('th', older).split('\n')).toEqual([thaiForError(older), older]);
    expect(thaiForError(older)).not.toBe(thaiForError('Record payment: The transfer is older than the invoice'));          // its own sentence: it is a payment, not a transfer
  });
});

describe('every sentence on the dashboard has a Thai text', () => {
  const src = (f: string) => readFileSync(new URL(`../../src/finance/${f}`, import.meta.url), 'utf8');
  const found = new Set<string>();
  for (const f of ['SlipReview.tsx', 'RecordPayment.tsx']) {
    const code = src(f);
    for (const re of [/<Tx>([^<>{}]+)<\/Tx>/g, /\btl\(lang, '((?:[^'\\]|\\.)*)'/g, /\b(?:label|hint|title|sub)="([^"]+)"/g, /\btile\('[a-z_]+', '([^']+)', [^,]+, '([^']+)'/g, /<Badge[^>]*>([A-Z][^<>{}]+)<\/Badge>/g]) {
      for (const m of code.matchAll(re)) for (const g of m.slice(1)) if (g) found.add(g.replace(/\\'/g, "'").trim());
    }
  }
  // the tiles carry their tooltips in constants, and a few labels are built from tables of words
  const extra = ['The three AI tiles never overlap and need not add up to Awaiting: a slip that is still waiting for the AI, or was never analysed, is counted only in Awaiting.',
    'An invoice is counted once for every awaiting slip: an invoice with two awaiting slips is counted twice.', 'Queued', 'Running', 'Done', 'Failed', 'Amount', 'Date', 'Time', 'Receiver', 'Bank', 'Reference',
    'Bank transfer', 'Cash', 'Confirmed', 'Posted', 'Posted today', 'Posted (in range)', 'the amount', 'the bank reference', 'the transfer date and time', 'Rejected', 'Asked for more evidence', 'Recorded by staff', 'Verified in one step', 'Not analysed', 'Slips to check', 'Payment review', 'Unresolved payments'];
  for (const e of extra) found.add(e);
  it('finds the sentences it is meant to check', () => { expect(found.size).toBeGreaterThan(100); expect(found.has('Run AI check')).toBe(true); expect(found.has('Review settings')).toBe(true); });
  it('has a Thai text for each (or the text is a name, a symbol or a number)', () => {
    const missing = [...found].filter((s) => /[A-Za-z]{3}/.test(s) && t('th', s) === s);
    expect(missing).toEqual([]);
  });
});
