// The receiver check on the customer's phone (src/slipReader/recipient.ts) is the twin of the database's (20261128150000_slip_recipient_check.sql). The same cases run here and in
// supabase/tests/slip_recipient_check.sql; the last block fails when a case is in one place only. Also: the phone's check before ordering (judge) with the receiver row.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import cases from './fixtures/recipient-cases.json';
import { checkRecipient, matchRecipient, nameDist, nameParts, recipientCandidates, type Holder } from '../../src/slipReader/recipient';
import { judge, needsConfirm, type LiveReading } from '../../src/slipReader/SlipLive';
import { readSlip } from '../../src/slipReader/parse';
import { ENGINE } from '../../src/slipReader/engine';

const H = cases.holders as Holder[];
const SQL_TESTS = readFileSync(new URL('../../supabase/tests/slip_recipient_check.sql', import.meta.url), 'utf8');
const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261128150000_slip_recipient_check.sql', import.meta.url), 'utf8');
const show = (c: { name: string | null; account_hint: string | null; how: string }[]) => (c.length ? c.map((x) => `${x.name ?? '-'}|${x.account_hint ?? '-'}|${x.how}`).join(' / ') : null);

describe('names: the same verdicts as the database', () => {
  for (const [name, want] of cases.names as [string, string][]) it(`${name} -> ${want}`, () => { expect(matchRecipient(name, null, H).verdict).toBe(want); });
  it('the two holders stay apart', () => {
    expect(matchRecipient('ณัฐพร อยู่ยิ้ม', null, H).holder).toBe('ณัฐพร อยู่ยิ้ม'); expect(matchRecipient('ณัฐพล อยู่ยิ้ม', null, H).holder).toBe('ณัฐพล อยู่ยิ้ม');
  });
  it('sara am split by OCR and a zero-width space are tidied', () => { expect(matchRecipient('นาย' + String.fromCharCode(0x200b) + 'ณัฐพล อยู่ยิ้ม', null, H).verdict).toBe('match'); });
  it('the digits rule is unchanged (an ordered subsequence of 3 or more of one of our accounts)', () => {
    expect(matchRecipient(null, 'xxx-x-x9542-x', H).verdict).toBe('match'); expect(matchRecipient(null, '123-4-56789-0', H).verdict).toBe('other');
    expect(matchRecipient(null, 'xx', H).verdict).toBe('none');
  });
  it('a name clearly someone else beside digits that look like ours is a conflict (a person decides)', () => {
    expect(matchRecipient('นาย สมชาย ใจดี', 'xxx-x-x9542-x', H).verdict).toBe('conflict');
    expect(checkRecipient([{ name: 'นาย สมชาย ใจดี', account_hint: 'xxx-x-x9542-x' }], H, 1).status).toBe('uncertain');
  });
  it('a stray short word after first name and surname is dropped; a masked initial is kept', () => {
    expect(show(recipientCandidates('ไปยัง นาย ณัฐพล อยู่ยิ้ม เล'))).toBe('นาย ณัฐพล อยู่ยิ้ม|-|label'); expect(show(recipientCandidates('ไปยัง นาย ณัฐพล อ'))).toBe('นาย ณัฐพล อ|-|label');
  });
  it('a near name is not made ours by the name: only the digits can', () => {
    const r = matchRecipient('ณัฐพง อยู่ยิ้ม', 'xxx-x-x9542-x', H); expect(r.verdict).toBe('match'); expect(r.name_verdict).toBe('near');
  });
  it('the weighted distance: a look-alike letter or a lost mark costs half', () => {
    expect(nameDist('ณัฐพร', 'ณัฐพธ')).toBe(0.5); expect(nameDist('อยู่', 'อยู')).toBe(0.5); expect(nameDist('abc', 'abd')).toBe(1); expect(nameDist('', 'ab')).toBe(2);
  });
  it('a surname masked by the bank', () => {
    expect(nameParts('นาย ณัฐพล อ.')).toMatchObject({ first: 'ณัฐพล', masked: true, prefix: 'อ', script: 'thai' });
    expect(nameParts('MR. TOMCRAFT TE')).toMatchObject({ first: 'tomcraft', masked: true, prefix: 'te', script: 'latin' });
    expect(nameParts('ณัฐพร อยู่ยิ้ม').masked).toBe(false);
  });
  it('an approved English spelling makes the English name ours', () => {
    expect(matchRecipient('MS. NATTHAPORN Y', null, [...H, { holder: 'ณัฐพร อยู่ยิ้ม', name: 'NATTHAPORN YOOYIM', src: 'english' }])).toMatchObject({ verdict: 'match', method: 'variant_masked' });
  });
});

describe('where the receiver is on the slip: the same as the database', () => {
  for (const [text, want] of cases.layouts as [string, string | null][]) it(JSON.stringify(text).slice(0, 70), () => { expect(show(recipientCandidates(text))).toBe(want); });
  it('one candidate per reading (form feed between readings)', () => { expect(recipientCandidates('ไปยัง ณัฐพร อยู่ยิ้ม\fไปยัง ณัฐพร อยู่ยิ้ม\fไปยัง ณัฐพร อยู่ยิ้ม')).toHaveLength(3); });
  it('only a masked number after the label: the digits are kept', () => { expect(show(recipientCandidates('ไปยัง xxx-x-x9542-1 จำนวน'))).toMatch(/^-\|xxx-x-x9542-1.*\|label$/); });
});

describe('all readings together', () => {
  const c = (...names: (string | null)[]) => names.map((name) => ({ name, account_hint: null }));
  it('A / B: ours in every reading', () => { expect(checkRecipient(c('ณัฐพร อยู่ยิ้ม', 'ณัฐพร อยู่ยิ้ม'), H, 2).status).toBe('match'); });
  it('D: one reading right and one misread: ours', () => { expect(checkRecipient(c('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม'), H, 2).status).toBe('match'); });
  it('D: misread in every reading: a person decides', () => { expect(checkRecipient(c('ณัฐพธ อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม'), H, 2).status).toBe('uncertain'); });
  it('E: someone else in two readings: not ours', () => { expect(checkRecipient(c('นาย สมชาย ใจดี', 'นาย สมชาย ใจดี'), H, 2).status).toBe('mismatch'); });
  it('E: someone else in ONE reading only: a person decides', () => { expect(checkRecipient(c('นาย สมชาย ใจดี', null), H, 2).status).toBe('uncertain'); });
  it('ours and someone else at once: a person decides', () => { expect(checkRecipient(c('ณัฐพร อยู่ยิ้ม', 'นาย สมชาย ใจดี', 'นาย สมชาย ใจดี'), H, 2).status).toBe('uncertain'); });
  it('F: nothing read', () => { expect(checkRecipient([], H, 2).status).toBe('unclear'); expect(checkRecipient(c(null, null), H, 2).status).toBe('unclear'); });
  it('the AI reads one name: one is enough to call it someone else', () => { expect(checkRecipient(c('นาย สมชาย ใจดี'), H, 1).status).toBe('mismatch'); });
});

describe("the customer's check before ordering, with the receiver", () => {
  const NOW = new Date('2026-11-28T07:00:00Z');
  const slip = (receiver: string) => `โอนเงินสำเร็จ\n28 พ.ย. 69 13:55 น.\nจาก นาย ลูกค้า ทดสอบ\nไปยัง ${receiver}\nจำนวนเงิน 150.00 บาท\nเลขที่รายการ 0153321234567890`;
  const reading = (receiver: string, r2 = receiver, r3 = receiver): LiveReading => ({ ...readSlip([slip(receiver), slip(r2), slip(r3)], { found: false, crc_ok: null, sending_bank: null, trans_ref: null }, NOW), qr: { found: false, crc_ok: null, sending_bank: null, trans_ref: null } });
  const rule = { before: 120, after: 10 };
  const names = ['ณัฐพร อยู่ยิ้ม', 'ณัฐพล อยู่ยิ้ม'];
  it('the reader keeps its readings apart for the database (and says so in its engine name)', () => {
    expect(reading('ณัฐพร อยู่ยิ้ม').text.split('\f')).toHaveLength(3); expect(ENGINE).toBe('browser-ocr/2');
    expect(MIGRATION).toContain("'^browser-ocr/[0-9a-z.]{1,12}$'");
  });
  it('A: our receiver, the right amount and day: all three rows agree', () => {
    const x = judge(reading('น.ส. ณัฐพร อยู่ยิ้ม'), 150, NOW.getTime(), rule, undefined, names);
    expect(x.recipient).toEqual({ state: 'ok', holder: 'ณัฐพร อยู่ยิ้ม' }); expect(x.amount.state).toBe('ok'); expect(needsConfirm(x)).toBe(false);
  });
  it('B: the second holder', () => { expect(judge(reading('นาย ณัฐพล อยู่ยิ้ม'), 150, NOW.getTime(), rule, undefined, names).recipient?.holder).toBe('ณัฐพล อยู่ยิ้ม'); });
  it('E: someone else: the customer must tick before ordering', () => {
    const x = judge(reading('นาย สมชาย ใจดี'), 150, NOW.getTime(), rule, undefined, names); expect(x.recipient?.state).toBe('differs'); expect(needsConfirm(x)).toBe(true);
  });
  it('D: a misread name asks nothing of the customer (unsure, a person checks)', () => {
    const x = judge(reading('ณัฐพธ อยู่ยิ้ม'), 150, NOW.getTime(), rule, undefined, names); expect(x.recipient?.state).toBe('unsure'); expect(needsConfirm(x)).toBe(false);
  });
  it('G: our receiver and another amount: still must tick', () => { expect(needsConfirm(judge(reading('ณัฐพร อยู่ยิ้ม'), 999, NOW.getTime(), rule, undefined, names))).toBe(true); });
  it('an older database (no names): no receiver row, as before', () => { expect(judge(reading('นาย สมชาย ใจดี'), 150, NOW.getTime(), rule).recipient).toBeNull(); });
});

describe('the cases are in both suites', () => {
  for (const [name] of cases.names as [string, string][]) it(`SQL has ${name}`, () => { expect(SQL_TESTS.includes(`'${name}'`), name).toBe(true); });
  for (const [text] of cases.layouts as [string, string | null][]) it(`SQL has the layout ${JSON.stringify(text).slice(0, 40)}`, () => { expect(SQL_TESTS.includes(text.replace(/\n/g, '\\n'))).toBe(true); });
  it('the look-alike pairs and the field words are the same on both sides', () => {
    const ts = readFileSync(new URL('../../src/slipReader/recipient.ts', import.meta.url), 'utf8');
    const look = (s: string) => s.match(/'รธ'[^\]]*\]/)?.[0].replace(/\s/g, '');
    expect(look(ts)).toBe(look(MIGRATION));
    const field = (s: string) => s.match(/\^\(จำนวน\|[^)]*\)/)?.[0];
    expect(field(ts)).toBeTruthy(); expect(field(ts)).toBe(field(MIGRATION));
  });
});
