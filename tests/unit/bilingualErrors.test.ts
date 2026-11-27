// FB-001004: every error alert says what the problem is in Thai AND in English.
// The first block reads the real messages out of the source and the migrations, so a new message without a Thai explanation fails here.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bilingualError, errorLines, errorToastText, thaiForError } from '../../src/lib/errorText';

const THAI = /[ก-๿]/;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const SRC = walk('src').filter((f) => /\.tsx?$/.test(f));
const SQL = walk('supabase/migrations').filter((f) => f.endsWith('.sql'));
const STR = "(`[^`]*`|'(?:[^'\\\\]|\\\\.)*')";
const clean = (s: string) => s.slice(1, -1).replace(/\$\{[^}]*\}/g, '1').replace(/\\'/g, "'");

function collect(files: string[], re: RegExp, text: (m: RegExpMatchArray) => string): string[] {
  const out = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(re)) out.add(text(m));
  return [...out];
}
const DB = collect(SQL, /raise exception\s+'((?:[^']|'')*)'/gi, (m) => m[1].replace(/''/g, "'").replace(/%/g, '1'));
const ENGINE = [
  ...collect(SRC, new RegExp("\\bfail\\(\\s*(?:'[A-Z_0-9]+'|[a-zA-Z.]+)\\s*,\\s*" + STR, 'g'), (m) => clean(m[1])),
  ...collect(SRC, new RegExp("new \\w*Error\\((?:\\s*'[A-Z_]+'\\s*,)?\\s*" + STR, 'g'), (m) => clean(m[1])),
];
const TOASTS = collect(SRC, new RegExp("toast\\('error',\\s*tl?\\((?:lang,\\s*)" + STR, 'g'), (m) => clean(m[1]));

// Not shown to anybody: checks inside a migration file, programming mistakes, and codes the caller turns into its own sentence.
const NOT_SHOWN = [
  /changed: anchor not found/, /changed since this migration was written/, /^numbering swap/, /^customer_app_validate has an unexpected shape/, /^Backfill incomplete/, /^Unmapped SKU domain/, /refusing to renumber/,
  /^Cannot add the event link/, /^an old numbering sequence/, /^Only LINE secrets$/, /must be used within/, /^ExpenseCtx missing$/, /^amount changed$/, /^TOO_MANY$/, /^FAILED$/,
  /^1: 1$/,
];
const missing = (list: string[]) => list.filter((m) => !THAI.test(m) && !NOT_SHOWN.some((r) => r.test(m)) && !thaiForError(m));

describe('every error message has a Thai explanation (FB-001004)', () => {
  it('finds the messages it is meant to check', () => {
    expect(DB.length).toBeGreaterThan(450); expect(ENGINE.length).toBeGreaterThan(220); expect(TOASTS.length).toBeGreaterThan(10);
  });
  it('raised by the database', () => { expect(missing(DB)).toEqual([]); });
  it('raised by the app and the accounting engine', () => { expect(missing(ENGINE)).toEqual([]); });
  it('written directly in an error toast', () => { expect(missing(TOASTS)).toEqual([]); });
  it('the Thai really is Thai, and no placeholder is left in it', () => {
    for (const m of [...DB, ...ENGINE]) { const th = thaiForError(m); if (th) { expect(th, m).toMatch(THAI); expect(th, m).not.toMatch(/\{\w+\}/); } }
  });
});

describe('the Thai explanation is specific', () => {
  it('keeps the values of the message', () => {
    expect(thaiForError('Insufficient stock for Puff A at Main: need 5, have 2 pcs')).toMatch(/Puff A.*Main.*5.*2 pcs/);
    expect(thaiForError('Credit limit exceeded: outstanding 100 + 50 > limit 120')).toMatch(/100.*50.*120/);
  });
  it('translates a status inside a message', () => { expect(thaiForError('Coupon is expired')).toContain('หมดอายุ'); });
  it('reads past the name of the action and the code in front of the sentence', () => {
    const plain = thaiForError('the confidence must be between 0 and 1');
    expect(plain).toBeTruthy();
    expect(thaiForError('INVALID_CONFIDENCE: the confidence must be between 0 and 1')).toBe(plain);
    expect(thaiForError('Save settings: INVALID_CONFIDENCE: the confidence must be between 0 and 1')).toBe(plain);
  });
  it('a code with a detail nobody has translated still gets the meaning of the code', () => {
    expect(thaiForError('BARCODE_TAKEN: some new wording')).toMatch(/บาร์โค้ด/);
  });
  it('keeps what the app was doing when that matters', () => {
    expect(thaiForError('Cannot approve: Journal has no lines')).toMatch(/อนุมัติไม่ได้.*ไม่มีบรรทัด/);
    expect(thaiForError('Upload slip: SLIP_ALREADY_USED')).toMatch(/อัปโหลดสลิปไม่สำเร็จ.*สลิปซ้ำ/);
  });
  it('a slow database is not reported as a lost internet connection', () => {
    expect(thaiForError('canceling statement due to statement timeout')).toMatch(/ฐานข้อมูล/); expect(thaiForError('timeout')).toMatch(/อินเทอร์เน็ต/);
  });
  it('a short sentence does not swallow a longer one', () => {
    for (const m of ['Already done by someone else', 'Customer group was archived', 'Order is in the wrong place']) expect(thaiForError(m), m).toBeNull();
  });
  it('a permission problem does not look like a missing record, and "connection" in a sentence is not a lost internet', () => {
    expect(thaiForError('Only staff can manage categories')).toMatch(/พนักงาน/);
    expect(thaiForError('Order 1 not found')).toMatch(/ไม่พบคำสั่งซื้อ/);
  });
  it('database and sign-in failures that are not written by us are explained too', () => {
    for (const m of [
      'duplicate key value violates unique constraint "products_sku_key"', 'new row violates row-level security policy for table "x"', 'JWT expired',
      'null value in column "name" of relation "x" violates not-null constraint', 'update or delete on table "a" violates foreign key constraint "b" on table "c"',
      'new row for relation "x" violates check constraint "y"', 'canceling statement due to statement timeout', 'Could not find the function public.x in the schema cache',
      'Invalid login credentials', 'Email not confirmed', 'The object exceeded the maximum allowed size', 'invalid input syntax for type uuid: "x"', 'Failed to fetch', 'Request failed',
    ]) expect(thaiForError(m), m).toMatch(THAI);
  });
});

describe('both languages are in the alert', () => {
  it('Thai screen: Thai first, then English; English screen: the other way round', () => {
    const th = errorToastText('th', 'Coupon not found').split('\n'); const en = errorToastText('en', 'Coupon not found').split('\n');
    expect(th).toHaveLength(2); expect(th[0]).toMatch(THAI); expect(th[1]).toBe('Coupon not found'); expect(en).toEqual([th[1], th[0]]);
  });
  it('a sentence that was already put in Thai by the screen gets its English back', () => {
    const th = thaiForError('Name is required')!;
    expect(errorToastText('th', th).split('\n')).toEqual([th, 'Name is required']);
  });
  it('a Thai sentence with a value in it gets its English back, with the value', () => {
    const [th, en] = errorToastText('th', 'ส่งขึ้นระบบไม่สำเร็จ').split('\n');
    expect(th).toBe('ส่งขึ้นระบบไม่สำเร็จ'); expect(en).toBeUndefined();          // a sentence nobody knows is left alone, nothing is invented
    const b = bilingualError('Max 8 custom pages')!;
    expect(b.th).toContain('8'); expect(bilingualError(b.th)!.en).toBe('Max 8 custom pages');
  });
  it('an English reason inside a Thai sentence is explained in Thai as well', () => {
    const b = bilingualError('Saved in this browser only. The online shop did not take the picture: This SKU is not in the online shop')!;
    expect(b.th).toMatch(THAI); expect(b.th).not.toContain('This SKU is not in the online shop'); expect(b.en).toContain('This SKU is not in the online shop');
  });
  it('a bare code becomes an English sentence, and the code stays for support', () => {
    const lines = errorToastText('en', 'SLIP_ALREADY_USED').split('\n');
    expect(lines[0]).toMatch(/already.*\(SLIP_ALREADY_USED\)$/); expect(lines[1]).toMatch(THAI);
  });
  it('text that already carries both languages is not touched', () => {
    const both = 'สลิปซ้ำ\nDuplicate slip\nDUPLICATE_SUSPECT: raw'; expect(errorToastText('th', both)).toBe(both); expect(errorToastText('en', both)).toBe(both);
  });
  it('an unknown message says in Thai that it failed and shows the original, only where staff work', () => {
    const raw = 'Something nobody has seen before';
    const th = errorToastText('th', raw, { unknownNote: true });
    expect(th.split('\n')).toHaveLength(2); expect(th.split('\n')[0]).toMatch(/ไม่สำเร็จ/); expect(th).toContain(raw);
    expect(errorToastText('en', raw, { unknownNote: true }).split('\n')[0]).toBe(raw);
    expect(errorToastText('th', raw)).toBe(raw);
  });
  it('errorLines splits an alert into the main line and the rest', () => {
    expect(errorLines('th', 'Coupon not found')).toEqual(errorToastText('th', 'Coupon not found').split('\n'));
    expect(errorLines('th', '')).toEqual([]);
  });
});
