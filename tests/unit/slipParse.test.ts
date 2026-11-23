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

describe('the word of caution on the customer\'s phone', async () => {
  const { hintFor, worthTrying } = await import('../../src/slipReader/SlipHint');
  const read = (t: string, qr = NO_QR) => ({ ...readSlip([t, t], qr, NOW), qr });
  it('says nothing when the amount is right, doubtful or missing', () => { expect(hintFor(read(SLIP), 928)).toBeNull(); expect(hintFor(read(SLIP.replace('จำนวนเงิน 928.00', 'จำนวนเงิน 8928.00')), 370)).toBeNull(); expect(hintFor(read('โอนเงินสำเร็จ'), 370)).toBeNull(); });
  it('warns about another amount, and about a picture that is no slip', () => { expect(hintFor(read(SLIP), 370)).toEqual({ kind: 'amount', amount: 928 }); expect(hintFor(read('hello'), 370)).toEqual({ kind: 'notSlip' }); });
  it('a picture with any QR is not called "not a slip"', () => expect(hintFor(read('', { found: true, crc_ok: null, sending_bank: null, trans_ref: null }), 370)).toBeNull());
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
