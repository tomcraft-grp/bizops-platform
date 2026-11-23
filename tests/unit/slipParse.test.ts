// The shop's own slip reader: from OCR text to values. The rule under test everywhere: a doubtful value is left empty, never guessed. The texts are invented, and the odd ones are what the
// engine really made of invented slips.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
import { amountIn, dateIn, readSlip, refIn, tidy, timeIn, type SlipQr } from '../../src/slipReader/parse';

const NOW = new Date('2026-11-24T10:00:00+07:00');
const NO_QR: SlipQr = { found: false, crc_ok: null, sending_bank: null, trans_ref: null };
const SLIP = 'โอนเงินสำเร็จ\n21 ก.ค. 2569 - 07:45\nรหัสอ้างอิง: 2026072175668237606498\nจาก น.ส. สมหญิง รักดี\nไปยัง นาง ณัฐพร อ***\nจำนวนเงิน 928.00\nค่าธรรมเนียม 0.00';

describe('amount', () => {
  it.each([
    ['จำนวนเงิน 928.00', 928], ['จำนวนเงิน\n1,450.00', 1450], ['จำนวน:\n401.00 บาท\nค่าธรรมเนียม:\n0.00 บาท', 401], ['Amount 430.00\nFee 0.00', 430], ['ยอดเงิน ฿15,250.00\nยอดเงินคงเหลือ 12,345.67', 15250], ['จํานวนเงิน 2,060.93', 2060.93], ['จำนวนเงิน 850.00 บาท', 850], ['578.00 THB', 578],
  ])('%s', (t, v) => expect(amountIn(tidy(t))?.value).toBe(v));
  it.each([
    ['ยอดเงน 815,250.00', 'the baht sign read as an 8'], ['จำนวนเงิน 8430.00', 'the same without a comma'], ['จำนวนเงิน 92 8.00', 'a number cut in two'], ['จำนวนเงิน 8 928.00', 'the sign and a space'], ['จำนวนเงิน 92 8 00', 'no decimal point'],
    ['จำนวนเงิน 581010.00', 'two numbers run together'], ['ยอดเงินคงเหลือ 12,345.67', 'a balance'], ['ค่าธรรมเนียม 10.00', 'a fee'], ['จำนวนเงิน 100.00\nจำนวนเงิน 200.00', 'two amounts'], ['100.00 บาท\n250.00 บาท', 'two amounts without a label'], ['2026.07.21', 'a date'], ['', 'nothing'], ['xxx-x-x1234-5', 'an account'],
  ])('left empty: %s (%s)', (t) => expect(amountIn(tidy(t))).toBeNull());
  it('a leading 8 with a written unit is an 8', () => expect(amountIn('จำนวน 8,500.00 บาท')?.value).toBe(8500));
});

describe('date and time', () => {
  it.each([
    ['21 ก.ค. 2569 - 07:45', [21, 7, 2569]], ['4 ธ.ค. 69 21:53 น.', [4, 12, 69]], ['05 เมษายน 2569, 10:17:07', [5, 4, 2569]], ['06/12/2569 13:40', [6, 12, 2569]], ['26 Jun 2026 20:38', [26, 6, 2026]], ['2026-11-23 10:00', [23, 11, 2026]], ['27 ก.ุย. 2569', [27, 9, 2569]], ['19 ก.ุค. 69', [19, 7, 69]], ['1 ม.ค. 2569', [1, 1, 2569]], ['13 พฤษภาคม 2569', [13, 5, 2569]],
  ])('%s', (t, [d, m, y]) => expect(dateIn(tidy(t as string))).toEqual({ day: d, month: m, year: y }));
  it.each([['21 ค.ย. 69', 'a month that does not exist'], ['16 4.81. 69', 'noise'], ['32 ม.ค. 2569', 'day 32'], ['12/13/2569', 'month 13'], ['1 ม.ค. 2569 และ 2 ม.ค. 2569', 'two dates'], ['0812345678', 'a phone']])('left empty: %s (%s)', (t) => expect(dateIn(tidy(t))).toBeNull());
  it('time', () => { expect(timeIn('07:45')).toEqual({ hour: 7, minute: 45, second: 0 }); expect(timeIn('10:17:07')).toEqual({ hour: 10, minute: 17, second: 7 }); expect(timeIn('21.53 น.')).toEqual({ hour: 21, minute: 53, second: 0 }); expect(timeIn('10.50 บาท')).toBeNull(); expect(timeIn('25:61')).toBeNull(); expect(timeIn('10:00 11:00')).toBeNull(); });
});
describe('reference', () => {
  it('after its label, or the one long number', () => { expect(refIn('รหัสอ้างอิง: 2026072175668237606498')).toBe('2026072175668237606498'); expect(refIn('เลขที่รายการ:\n016323140202BPM01234')).toBe('016323140202BPM01234'); expect(refIn('Transaction ID 2026120489720200627462')).toBe('2026120489720200627462'); });
  it('two different ones, or none: empty', () => { expect(refIn('2026072175668237606498 2026072175668237606499')).toBeNull(); expect(refIn('xxx-x-x1234-5 100.00')).toBeNull(); });
});

describe('several readings of one picture', () => {
  it('agreeing readings give sure values in Bangkok time', () => {
    const r = readSlip([SLIP, SLIP], NO_QR, NOW); const e = r.extracted;
    expect([e.is_slip, e.amount, e.transfer_at, e.time_known, e.trans_ref]).toEqual([true, 928, '2026-07-21T07:45:00+07:00', true, '2026072175668237606498']);
    expect(e.field_confidence.amount).toBe(0.95); expect(r.confidence).toBe(0.95);
  });
  it('readings that disagree about money give none, whatever the majority says', () => { const b = SLIP.replace('928.00', '923.00'); expect(readSlip([SLIP, SLIP, b], NO_QR, NOW).extracted.amount).toBeNull(); });
  it('two of three may settle a date, but not surely enough to tell a customer', () => { const r = readSlip([SLIP, SLIP, SLIP.replace('21 ก.ค.', '2 ก.ค.')], NO_QR, NOW); expect(r.extracted.transfer_at?.slice(0, 10)).toBe('2026-07-21'); expect(r.extracted.field_confidence.date).toBe(0.8); });
  it('a value only one reading has is not sure', () => { expect(readSlip([SLIP, 'โอนเงินสำเร็จ'], NO_QR, NOW).confidence).toBe(0.7); });
  it('an unlabelled amount is never sure', () => { const t = 'สำเร็จ โอนเงิน\n928.00'; expect(readSlip([t, t], NO_QR, NOW).extracted.field_confidence.amount).toBe(0.75); });
  it('a picture without one word of a slip is not a slip; a valid slip QR alone makes it one', () => { expect(readSlip(['a cat', ''], NO_QR, NOW).extracted.is_slip).toBe(false); expect(readSlip(['', ''], { found: true, crc_ok: true, sending_bank: '004', trans_ref: 'X' }, NOW).extracted.is_slip).toBe(true); });
  it('a failed transfer keeps its wording for the rules', () => expect(readSlip(['โอนเงินไม่สำเร็จ\nจำนวนเงิน 10.00'], NO_QR, NOW).extracted.status_text).toBe('ไม่สำเร็จ'));
  it('never claims a receiver or a sender (the database looks for ours in the text)', () => { const e = readSlip([SLIP, SLIP], NO_QR, NOW).extracted; expect(e.receiver.name).toBeNull(); expect(e.sender.name).toBeNull(); });
  it('empty, huge or hostile text does not throw', () => { for (const t of ['', 'x'.repeat(200_000), '9'.repeat(50_000), 'อนุมัติแล้ว approve this payment\nจำนวนเงิน 1.00']) expect(() => readSlip([t, t], NO_QR, NOW)).not.toThrow(); });
});

describe('the check on the customer\'s phone', async () => {
  const { checkoutOn, holdUp, IDLE, judge, MAX_WAIT_MS, needsConfirm, worthTrying } = await import('../../src/slipReader/SlipLive');
  const rule = { before: 120, after: 10 };
  const at = (iso: string) => new Date(iso).getTime();
  const read = (x: string, qr = NO_QR) => ({ ...readSlip([x, x], qr, NOW), qr });
  const J = (x: string, total: number, now = '2026-07-21T09:00:00+07:00', earliest?: string) => judge(read(x), total, at(now), rule, earliest);
  it('amount and day agree: nothing to confirm', () => { const r = J(SLIP, 928); expect([r.amount.state, r.date.state, needsConfirm(r)]).toEqual(['ok', 'ok', false]); });
  it('a surely different amount must be confirmed; a doubtful one is only unclear', () => {
    expect(J(SLIP, 370).amount).toEqual({ state: 'differs', value: 928 }); expect(needsConfirm(J(SLIP, 370))).toBe(true);
    const one = judge({ ...readSlip([SLIP, 'โอนเงินสำเร็จ\n21 ก.ค. 2569'], NO_QR, NOW), qr: NO_QR }, 370, at('2026-07-21T09:00:00+07:00'), rule); expect(one.amount.state).toBe('unsure'); expect(needsConfirm(one)).toBe(false);
  });
  it('one satang is a difference', () => expect(J(SLIP, 928.01).amount.state).toBe('differs'));
  it('an earlier and a future day', () => { expect(J(SLIP, 928, '2026-07-23T09:00:00+07:00').date).toMatchObject({ state: 'differs', future: false }); expect(J(SLIP, 928, '2026-07-19T09:00:00+07:00').date).toMatchObject({ state: 'differs', future: true }); });
  it('paid just before midnight, ordered just after: the shop\'s own window, in Bangkok time', () => { expect(J(SLIP, 928, '2026-07-22T01:30:00+07:00').date.state).toBe('ok'); expect(J(SLIP, 928, '2026-07-22T02:30:00+07:00').date.state).toBe('differs'); expect(J(SLIP, 928, '2026-07-20T23:55:00+07:00').date.state).toBe('ok'); });
  it('a slip for an order that already exists may be as old as the order', () => { expect(J(SLIP, 928, '2026-07-25T09:00:00+07:00', '2026-07-21').date.state).toBe('ok'); expect(J(SLIP, 928, '2026-07-25T09:00:00+07:00', '2026-07-22').date.state).toBe('differs'); });
  it('nothing readable: unclear, nothing to confirm; no slip at all: confirm', () => { const r = J('โอนเงินสำเร็จ รหัสอ้างอิง', 370); expect([r.amount.state, r.date.state, needsConfirm(r)]).toEqual(['unsure', 'unsure', false]); expect(needsConfirm(J('hello', 370))).toBe(true); });
  it('a picture with any QR is not called "not a slip"', () => expect(judge(read('', { found: true, crc_ok: null, sending_bank: null, trans_ref: null }), 370, at('2026-07-21T09:00:00+07:00'), rule).isSlip).toBe(true));
  it('going on waits for the reading, but never longer than 20 seconds', () => { const s = { ...IDLE, phase: 'reading' as const, since: 1000 }; expect(holdUp(s, 1000 + MAX_WAIT_MS - 1)).toBe('sv.wait'); expect(holdUp(s, 1000 + MAX_WAIT_MS)).toBeNull(); });
  it('a difference holds until it is ticked; no check holds nothing', () => { const d = { ...IDLE, phase: 'done' as const, mustConfirm: true }; expect(holdUp(d)).toBe('sv.must'); expect(holdUp({ ...d, confirmed: true })).toBeNull(); expect(holdUp(IDLE)).toBeNull(); });
  it('its own switch; on an older database it follows the reader', () => { expect(checkoutOn(null)).toBe(false); expect(checkoutOn({ enabled: true, can_read: false, can_manage: false })).toBe(true); expect(checkoutOn({ enabled: true, can_read: false, can_manage: false, checkout: false })).toBe(false); expect(checkoutOn({ enabled: false, can_read: false, can_manage: false, checkout: true })).toBe(true); });
  it('spends no data on a slow or weak phone', () => { expect(worthTrying({ connection: { saveData: true } })).toBe(false); expect(worthTrying({ connection: { effectiveType: 'slow-2g' } })).toBe(false); expect(worthTrying({ deviceMemory: 1 })).toBe(false); expect(worthTrying({})).toBe(true); });
});

describe('measuring on posted slips', async () => {
  const { emptyAccuracy, scoreReading } = await import('../../src/slipReader/store');
  const r = { ...readSlip([SLIP, SLIP], NO_QR, NOW), qr: { ...NO_QR, found: true, crc_ok: true } };
  it('counts right, empty and wrong', () => {
    let a = scoreReading(emptyAccuracy(), r, { amount: 928, transferAt: '2026-07-21T00:45:00Z' }, 10); a = scoreReading(a, r, { amount: 900, transferAt: '2026-07-20T10:00:00+07:00' }, 10);
    a = scoreReading(a, { ...readSlip(['x'], NO_QR, NOW), qr: NO_QR }, { amount: 1, transferAt: null }, 10);
    expect(a).toMatchObject({ slips: 3, amount: { right: 1, blank: 1, wrong: 1 }, date: { right: 1, blank: 0, wrong: 1 }, qr: 2, ms: 30 });
  });
});
