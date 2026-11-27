import { describe, expect, it } from 'vitest';
import {
  blankRow, dayTotals, fillFromSuggestion, formatAmount, isBlank, isDirty, isEditable, filterSuggestions, matchSuggestion, mergeDay, newRowTaxType, parseAmount, rowFromClaim, shiftDay, stashOf, suggestionsFrom, validateRow,
  type SheetRow,
} from '../../src/expenses/sheet';
import type { Category, Claim } from '../../src/expenses/api';

const cat = (id: string, o: Partial<Category> = {}): Category => ({
  id, code: id, name_en: `Cat ${id}`, name_th: `หมวด ${id}`, icon: 'receipt', sort: 1, treatment: 'expense', account_code: '6300', default_tax_type: 'none', default_wht_rate: null,
  hint_en: null, hint_th: null, active: true, ...o,
});
const claim = (o: Partial<Claim> = {}): Claim => ({
  id: 'c1', expense_no: null, created_by: 'u', created_by_name: 'U', expense_date: '2026-11-26', payment_date: '2026-11-26', category_id: 'food', description: 'Coffee', vendor: null, vendor_tax_id: null,
  reference_no: null, notes: null, payment_method: 'cash', paid_from: 'cash', tax_type: 'none', vat_rate: 0, amount_paid: 80, vat_amount: 0, wht_rate: 0, wht_amount: 0, treatment: 'expense',
  account_override: null, branch_id: null, status: 'draft', submitted_at: null, approved_by: null, approved_at: null, approval_note: null, rejected_at: null, reject_reason: null, reviewed_at: null,
  review_note: null, posted_at: null, posting_date: null, journal_no: null, posted_ref: null, cancelled_at: null, cancel_reason: null, reversal_journal_no: null, created_at: '2026-11-26T01:00:00Z', ...o,
});
const typed = (o: Partial<SheetRow> = {}): SheetRow => ({ ...blankRow('cash'), description: 'Lunch', categoryId: 'food', amount: '120', ...o });

describe('amounts', () => {
  it('reads what people type: commas, a baht sign, spaces, up to two decimals', () => {
    expect(parseAmount('80')).toBe(80);
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount(' ฿ 99.9 ')).toBe(99.9);
    expect(parseAmount('.5')).toBe(0.5);
  });
  it('rejects empty, zero, negative, letters and more than two decimals', () => {
    for (const s of ['', '0', '0.00', '-5', 'abc', '1.234', '1.2.3']) expect(parseAmount(s)).toBeNull();
  });
  it('formats with thousands separators and two decimals', () => {
    expect(formatAmount(1234.5)).toBe('1,234.50');
    expect(formatAmount(80)).toBe('80.00');
  });
});

describe('dates', () => {
  it('moves a day key forward and back across months and years without time-zone drift', () => {
    expect(shiftDay('2026-11-30', 1)).toBe('2026-12-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('rows', () => {
  it('a saved claim becomes an editable row only while it is a draft or rejected', () => {
    expect(isEditable(rowFromClaim(claim({ status: 'draft' })))).toBe(true);
    expect(isEditable(rowFromClaim(claim({ status: 'rejected' })))).toBe(true);
    for (const s of ['submitted', 'approved', 'posted'] as const) expect(isEditable(rowFromClaim(claim({ status: s })))).toBe(false);
  });
  it('a claim whose VAT is added on top is edited in the full form, not in the sheet (its amount means something else)', () => {
    expect(isEditable(rowFromClaim(claim({ tax_type: 'vat_excluded', amount_paid: 107, vat_amount: 7 })))).toBe(false);
  });
  it('a blank new row is not dirty and is ignored; typing anything makes it dirty', () => {
    const b = blankRow('cash');
    expect(isBlank(b)).toBe(true);
    expect(isDirty(b)).toBe(false);
    expect(isDirty({ ...b, notes: 'x' })).toBe(true);
  });
  it('a saved row is dirty only when a field differs from what is stored (formatting of the amount does not count)', () => {
    const r = rowFromClaim(claim({ amount_paid: 1200 }));
    expect(isDirty(r)).toBe(false);
    expect(isDirty({ ...r, amount: '1,200.00' })).toBe(false);
    expect(isDirty({ ...r, amount: '1300' })).toBe(true);
    expect(isDirty({ ...r, description: 'Tea' })).toBe(true);
    expect(isDirty({ ...r, method: 'qr' })).toBe(true);
  });
  it('a locked row is never dirty, even if something changed in memory', () => {
    const r = rowFromClaim(claim({ status: 'submitted' }));
    expect(isDirty({ ...r, amount: '5' })).toBe(false);
  });
});

describe('validation', () => {
  const cats = { food: cat('food'), old: cat('old', { active: false }) };
  it('needs an item, an active category and an amount above zero', () => {
    expect(validateRow(typed(), cats)).toEqual({});
    expect(validateRow(typed({ description: '  ' }), cats).description).toBeTruthy();
    expect(validateRow(typed({ categoryId: '' }), cats).category).toBeTruthy();
    expect(validateRow(typed({ categoryId: 'old' }), cats).category).toBeTruthy();
    expect(validateRow(typed({ amount: '' }), cats).amount).toBeTruthy();
    expect(validateRow(typed({ amount: '1.234' }), cats).amount).toBeTruthy();
    expect(validateRow(typed({ amount: '100000000' }), cats).amount).toBeTruthy();
  });
  it('limits the lengths the database allows', () => {
    expect(validateRow(typed({ description: 'x'.repeat(301) }), cats).description).toBeTruthy();
    expect(validateRow(typed({ notes: 'x'.repeat(1001) }), cats).notes).toBeTruthy();
  });
});

describe('daily totals', () => {
  it('counts every non-blank row and adds saved and unsaved amounts, ignoring blank rows and unreadable amounts', () => {
    const rows = [rowFromClaim(claim({ id: 'a', amount_paid: 80 })), rowFromClaim(claim({ id: 'b', amount_paid: 500, status: 'submitted' })), typed({ amount: '120' }), typed({ amount: 'x' }), blankRow('cash')];
    expect(dayTotals(rows)).toEqual({ count: 4, total: 700, unsaved: 2 });
  });
  it('adds money without floating-point dust', () => {
    expect(dayTotals([typed({ amount: '0.1' }), typed({ amount: '0.2' })]).total).toBe(0.3);
  });
});

describe('suggestions for the item box', () => {
  const cats = [cat('food', { name_th: 'ค่าอาหาร', name_en: 'Food' }), cat('fuel', { name_th: 'ค่าน้ำมัน', name_en: 'Fuel' }), cat('gone', { active: false })];
  it('the most used items come first, each with the category and payment method used last time', () => {
    const history = [
      claim({ id: '1', description: 'Coffee', category_id: 'food', created_at: '2026-11-20T00:00:00Z' }),
      claim({ id: '2', description: 'coffee ', category_id: 'food', payment_method: 'qr', created_at: '2026-11-25T00:00:00Z' }),
      claim({ id: '3', description: 'Gasoline', category_id: 'fuel', created_at: '2026-11-24T00:00:00Z' }),
      claim({ id: '4', description: 'Cancelled thing', status: 'cancelled' }),
    ];
    const s = suggestionsFrom(history, cats, 'th');
    expect(s[0]).toMatchObject({ text: 'coffee', categoryId: 'food', method: 'qr', uses: 2 });
    expect(s[1]).toMatchObject({ text: 'Gasoline', categoryId: 'fuel', uses: 1 });
    expect(s.find((x) => x.text === 'Cancelled thing')).toBeUndefined();
    // the active category names follow, so a first-time user can still pick something; inactive ones are left out
    expect(s.map((x) => x.text)).toEqual(expect.arrayContaining(['ค่าอาหาร', 'ค่าน้ำมัน']));
    expect(s.find((x) => x.categoryId === 'gone')).toBeUndefined();
  });
  it('matches a typed item ignoring case and spaces, and fills only what is still empty', () => {
    const s = suggestionsFrom([claim({ description: 'Gasoline', category_id: 'fuel', payment_method: 'card' })], cats, 'en');
    const m = matchSuggestion(s, '  gasoline ')!;
    expect(m.categoryId).toBe('fuel');
    expect(fillFromSuggestion(typed({ categoryId: '' }), m, true)).toMatchObject({ categoryId: 'fuel', method: 'card' });
    expect(fillFromSuggestion(typed({ categoryId: 'food' }), m, false)).toMatchObject({ categoryId: 'food', method: 'cash' });
    expect(matchSuggestion(s, 'nothing like it')).toBeNull();
  });
});

describe('the list under the item box', () => {
  const list = [{ text: 'Coffee', icon: 'utensils', sub: 'Food' }, { text: 'Coffee beans', icon: 'utensils' }, { text: 'ค่าน้ำมัน', icon: 'fuel' }, { text: 'ค่าไฟฟ้า', icon: 'zap' }, { text: 'Gasoline' }];
  it('shows everything before anything is typed, up to the limit', () => {
    expect(filterSuggestions(list, '')).toHaveLength(5);
    expect(filterSuggestions(list, '   ')).toHaveLength(5);
    expect(filterSuggestions(list, '', 2).map((x) => x.text)).toEqual(['Coffee', 'Coffee beans']);
  });
  it('keeps what contains the typed text, in any case and in Thai too, in the same order, with its icon', () => {
    expect(filterSuggestions(list, 'cOFF').map((x) => x.text)).toEqual(['Coffee', 'Coffee beans']);
    expect(filterSuggestions(list, 'น้ำมัน')).toEqual([{ text: 'ค่าน้ำมัน', icon: 'fuel' }]);
    expect(filterSuggestions(list, 'ฟ้า')[0].icon).toBe('zap');
    expect(filterSuggestions(list, '  coffee   BEAN ').map((x) => x.text)).toEqual(['Coffee beans']);
  });
  it('offers nothing when nothing fits, or when the only fit is exactly what is typed', () => {
    expect(filterSuggestions(list, 'zzz')).toEqual([]);
    expect(filterSuggestions(list, 'gasoline')).toEqual([]);
    expect(filterSuggestions(list, 'coffee')).toHaveLength(2);      // an exact fit that has longer ones after it still shows them
  });
});

describe('new rows and tax', () => {
  it('a new row takes the category default tax only when the business is VAT-registered; "VAT on top" becomes "VAT included" because the sheet records money paid', () => {
    expect(newRowTaxType(cat('a', { default_tax_type: 'vat_included' }), true)).toBe('vat_included');
    expect(newRowTaxType(cat('a', { default_tax_type: 'vat_included' }), false)).toBe('none');
    expect(newRowTaxType(cat('a', { default_tax_type: 'vat_excluded' }), true)).toBe('vat_included');
    expect(newRowTaxType(undefined, true)).toBe('none');
  });
});

describe('keeping unsaved work (stash) and merging it with what the server has', () => {
  it('the stash holds only dirty rows', () => {
    const saved = rowFromClaim(claim({ id: 'a' }));
    const st = stashOf([saved, { ...rowFromClaim(claim({ id: 'b' })), amount: '99' }, typed({ description: 'Parking' }), blankRow('cash')]);
    expect(st.map((r) => r.id ?? r.description)).toEqual(['b', 'Parking']);
  });
  it('server rows come in creation order; stashed edits are re-applied to rows that are still editable; new stashed rows follow; one blank row ends the sheet', () => {
    const server = [claim({ id: 'b', created_at: '2026-11-26T03:00:00Z', description: 'Lunch' }), claim({ id: 'a', created_at: '2026-11-26T01:00:00Z', description: 'Coffee' })];
    const stash = [{ ...rowFromClaim(server[0]), amount: '150' }, typed({ description: 'Parking', amount: '40' })];
    const { rows, dropped } = mergeDay(server, stash, 'cash');
    expect(rows.map((r) => r.description)).toEqual(['Coffee', 'Lunch', 'Parking', '']);
    expect(rows[1].amount).toBe('150');
    expect(isDirty(rows[1])).toBe(true);
    expect(dropped).toBe(0);
  });
  it('an edit to a row that was sent for approval meanwhile is dropped and reported, and a row that disappeared (cancelled) is dropped too', () => {
    const server = [claim({ id: 'a', status: 'submitted' })];
    const stash = [{ ...rowFromClaim(claim({ id: 'a' })), amount: '5' }, { ...rowFromClaim(claim({ id: 'zz' })), amount: '6' }];
    const { rows, dropped } = mergeDay(server, stash, 'cash');
    expect(rows[0].amount).toBe('80.00');
    expect(rows).toHaveLength(2);
    expect(dropped).toBe(2);
  });
  it('a new row that was saved before the reload (it has an id now) is not added twice', () => {
    const server = [claim({ id: 'a' })];
    const { rows } = mergeDay(server, [], 'cash');
    expect(rows.filter((r) => r.id === 'a')).toHaveLength(1);
  });
});
