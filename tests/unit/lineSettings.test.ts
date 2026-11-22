// The LINE Settings card's client helpers (src/lib/lineApi.ts): refusal sentences in both languages and the form checks that mirror the database's rules.
import { describe, expect, it } from 'vitest';
import { lineErrorText, parseReasons, validMaxAmount, validReasons } from '../../src/lib/lineApi';

describe('lineErrorText', () => {
  it('LINE_NOT_READY becomes a sentence', () => {
    const e = new Error('Save LINE settings: LINE_NOT_READY: enter the channel secret and access token and bind the admin group first');
    expect(lineErrorText('th', e)).toBe('ต้องใส่ข้อมูลเชื่อมต่อและผูกกลุ่มก่อนเปิดใช้');
    expect(lineErrorText('en', e)).toBe('Enter the channel secret and the access token, and bind the admin group, before switching LINE on.');
  });
  it('a refused permission says only a SUPER_ADMIN can', () => {
    const e = new Error('Save LINE settings: You are not allowed to change the LINE settings');
    expect(lineErrorText('th', e)).toBe('เฉพาะ SUPER_ADMIN เท่านั้นที่แก้ไขส่วนนี้ได้');
  });
  it('any other message is shown as it is', () => { expect(lineErrorText('en', new Error('boom'))).toBe('boom'); });
});

describe('form checks', () => {
  it('validMaxAmount: a positive amount with at most 2 decimals, up to 1,000,000', () => {
    expect(validMaxAmount('3000')).toBe(true);
    expect(validMaxAmount('2999.50')).toBe(true);
    for (const bad of ['0', '-1', 'abc', '', '1.234', '1000001']) expect(validMaxAmount(bad), bad).toBe(false);
  });
  it('validReasons: 1 to 10 reasons, none empty, at most 80 characters', () => {
    expect(validReasons(['a'])).toBe(true);
    expect(validReasons([''])).toBe(false);
    expect(validReasons([])).toBe(false);
    expect(validReasons(Array.from({ length: 11 }, (_, i) => `r${i}`))).toBe(false);
    expect(validReasons(['x'.repeat(81)])).toBe(false);
  });
  it('parseReasons: one reason per line, trimmed, blank lines dropped', () => {
    expect(parseReasons(' สลิปไม่ถูกต้อง \n\nสินค้าหมด\n')).toEqual(['สลิปไม่ถูกต้อง', 'สินค้าหมด']);
  });
});
