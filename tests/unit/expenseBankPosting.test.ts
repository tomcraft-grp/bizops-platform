// Daily expenses v2 without the screen: products in the item list, the bank account a transfer needs, the journal the database queues
// (the same rules as expense_post_one in supabase/migrations/20261128160000_expense_bank_posting.sql), which rows can be ticked for
// "approve & post", the reasons in Thai, and how the accounting device posts an expense row from the queue (and its reversal).
import { describe, expect, it } from 'vitest';
import { ctx, tx } from '../helpers';
import { liveExpenses } from '../../src/domain/setup';
import { expenseRows, reconcileClaims } from '../../src/domain/expenseReports';
import { financeJournal, postFinanceRow, type FinanceQueueRow } from '../../src/domain/financeLedger';
import { blankRow, fillFromSuggestion, isDirty, matchSuggestion, rowFromClaim, suggestionsFrom, validateRow, withDefaults, type SheetRow } from '../../src/expenses/sheet';
import { queuePlan } from '../../src/expenses/parts';
import { rowBlock } from '../../src/expenses/PostQueue';
import { problemCode, problemText, type Category, type Claim, type ProductOption } from '../../src/expenses/api';
import type { DB } from '../../src/domain/types';

const cat = (o: Partial<Category>): Category => ({ id: 'c', code: 'c', name_en: 'C', name_th: 'ซี', icon: 'receipt', sort: 1, treatment: 'expense', account_code: '6300', default_tax_type: 'none', default_wht_rate: null, hint_en: null, hint_th: null, active: true, ...o });
const CATS = [
  cat({ id: 'office', code: 'office_supplies', name_en: 'Office supplies', name_th: 'เครื่องใช้สำนักงาน' }),
  cat({ id: 'rm', code: 'stock_materials', name_en: 'Raw materials & packaging', name_th: 'วัตถุดิบและบรรจุภัณฑ์', treatment: 'inventory', account_code: null, posting_role: 'inv_materials', product_class: 'RM' }),
  cat({ id: 'fg', code: 'stock_goods', name_en: 'Goods for resale', name_th: 'สินค้าซื้อมาเพื่อขาย', treatment: 'inventory', account_code: null, posting_role: 'inv_goods', product_class: 'FG' }),
];
const PRODUCTS: ProductOption[] = [
  { sku_code: 'RM-000001', name_th: 'น้ำตาลสด', name_en: 'Fresh coconut sugar', brand: null, unit_th: null, unit_en: null, sku_category: 'RM', product_type: null, category_id: 'rm' },
  { sku_code: 'FG-000086', name_th: 'น้ำกระท่อม', name_en: 'Kratom drink', brand: null, unit_th: null, unit_en: null, sku_category: 'FG', product_type: null, category_id: 'fg' },
];
const claim = (o: Partial<Claim> = {}): Claim => ({
  id: 'x1', expense_no: null, created_by: 'u', created_by_name: 'U', expense_date: '2026-11-28', payment_date: '2026-11-28', category_id: 'office', description: 'Coffee', vendor: null, vendor_tax_id: null,
  reference_no: null, notes: null, payment_method: 'cash', paid_from: 'cash', tax_type: 'none', vat_rate: 0, amount_paid: 100, vat_amount: 0, wht_rate: 0, wht_amount: 0, treatment: 'expense', account_override: null,
  branch_id: null, status: 'draft', submitted_at: null, approved_by: null, approved_at: null, approval_note: null, rejected_at: null, reject_reason: null, reviewed_at: null, review_note: null, posted_at: null,
  posting_date: null, journal_no: null, posted_ref: null, cancelled_at: null, cancel_reason: null, reversal_journal_no: null, created_at: '2026-11-28T01:00:00Z', ...o,
});
const typed = (o: Partial<SheetRow> = {}): SheetRow => ({ ...blankRow('cash'), description: 'Lunch', categoryId: 'office', amount: '120', ...o });

describe('products in the item list', () => {
  it('products come after the person\'s own items, each with its catalogue code and the category its class maps to; product categories are not offered as items', () => {
    const s = suggestionsFrom([claim({ description: 'Coffee' })], CATS, 'th', PRODUCTS);
    expect(s.map((x) => x.text)).toEqual(['Coffee', 'น้ำตาลสด', 'น้ำกระท่อม', 'เครื่องใช้สำนักงาน']);
    expect(s[1]).toMatchObject({ sku: 'RM-000001', categoryId: 'rm', productClass: 'RM' });
    expect(s[2]).toMatchObject({ sku: 'FG-000086', categoryId: 'fg', productClass: 'FG' });
  });
  it('an item typed before under the product\'s name now stands for the product (no duplicate line)', () => {
    const s = suggestionsFrom([claim({ description: 'น้ำตาลสด', category_id: 'office' })], CATS, 'th', PRODUCTS);
    expect(s.filter((x) => x.text === 'น้ำตาลสด')).toHaveLength(1);
    expect(s[0]).toMatchObject({ sku: 'RM-000001', categoryId: 'office' });   // what the person chose last time stays
  });
  it('choosing a product links the row and ALWAYS applies its mapped category (a raw material that is also sold stays a raw material); free text unlinks', () => {
    const s = suggestionsFrom([], CATS, 'th', PRODUCTS);
    const sugar = matchSuggestion(s, 'น้ำตาลสด')!;
    expect(fillFromSuggestion(typed({ categoryId: 'office' }), sugar, false)).toMatchObject({ sku: 'RM-000001', categoryId: 'rm' });
    const office = matchSuggestion(s, 'เครื่องใช้สำนักงาน')!;
    expect(fillFromSuggestion(typed({ sku: 'RM-000001' }), office, false).sku).toBeNull();
  });
  it('without a product list (older database) the list is exactly as before', () => {
    expect(suggestionsFrom([claim()], CATS.slice(0, 1), 'en').map((x) => x.text)).toEqual(['Coffee', 'Office supplies']);
  });
});

describe('the bank account of a transfer', () => {
  it('is required for a bank transfer and a QR payment, not for cash or card', () => {
    expect(validateRow(typed({ method: 'bank_transfer', bankId: '' }), Object.fromEntries(CATS.map((c) => [c.id, c]))).bank).toBe('required');
    expect(validateRow(typed({ method: 'qr', bankId: '' }), Object.fromEntries(CATS.map((c) => [c.id, c]))).bank).toBe('required');
    expect(validateRow(typed({ method: 'qr', bankId: 'scb' }), Object.fromEntries(CATS.map((c) => [c.id, c]))).bank).toBeUndefined();
    expect(validateRow(typed({ method: 'cash' }), Object.fromEntries(CATS.map((c) => [c.id, c]))).bank).toBeUndefined();
    expect(validateRow(typed({ method: 'card' }), Object.fromEntries(CATS.map((c) => [c.id, c]))).bank).toBeUndefined();
  });
  it('a new row starts with the account of the row above only when it is paid from a bank', () => {
    expect(blankRow('bank_transfer', 'scb').bankId).toBe('scb');
    expect(blankRow('cash', 'scb').bankId).toBe('');
  });
  it('changing the product or the bank account makes a saved row unsaved; a bank id left on a cash row does not', () => {
    const r = rowFromClaim(claim({ payment_method: 'bank_transfer', paid_from: 'bank', bank_account_id: 'scb', sku_code: 'RM-000001' }));
    expect(isDirty(r)).toBe(false);
    expect(isDirty({ ...r, bankId: 'bbl' })).toBe(true);
    expect(isDirty({ ...r, sku: null })).toBe(true);
    const cash = rowFromClaim(claim());
    expect(isDirty({ ...cash, bankId: 'scb' })).toBe(false);
  });
  it('rows kept in the browser by the previous version get the new fields', () => {
    const old = { ...typed() } as Partial<SheetRow>; delete old.sku; delete old.bankId;
    expect(withDefaults(old as SheetRow)).toMatchObject({ sku: null, bankId: '' });
  });
});

describe('the journal the database queues (same rules as expense_post_one)', () => {
  const office = CATS[0], rm = CATS[1];
  it('cash, no VAT: Dr the category account / Cr cash', () => {
    expect(queuePlan(claim(), office, '2210').lines).toEqual([{ side: 'dr', role: '6300', amount: 100 }, { side: 'cr', role: 'cash', amount: 100 }]);
  });
  it('a product bought by transfer: Dr inventory (raw materials) / Cr that bank account', () => {
    expect(queuePlan(claim({ amount_paid: 2500, paid_from: 'bank', payment_method: 'bank_transfer', bank_account_id: 'scb' }), rm, '2210').lines)
      .toEqual([{ side: 'dr', role: 'inv_materials', amount: 2500 }, { side: 'cr', role: 'bank', amount: 2500, bankAccountId: 'scb' }]);
  });
  it('claimable VAT is split out; VAT that cannot be claimed stays in the cost; withholding tax reduces the money out', () => {
    expect(queuePlan(claim({ amount_paid: 107, vat_amount: 7, tax_type: 'vat_included' }), office, '2210').lines)
      .toEqual([{ side: 'dr', role: '6300', amount: 100 }, { side: 'dr', role: 'input_vat', amount: 7 }, { side: 'cr', role: 'cash', amount: 107 }]);
    expect(queuePlan(claim({ amount_paid: 107, vat_amount: 7, tax_type: 'vat_noncreditable' }), office, '2210').lines)
      .toEqual([{ side: 'dr', role: '6300', amount: 107 }, { side: 'cr', role: 'cash', amount: 107 }]);
    expect(queuePlan(claim({ amount_paid: 1000, wht_amount: 30 }), office, '2210').lines)
      .toEqual([{ side: 'dr', role: '6300', amount: 1000 }, { side: 'cr', role: 'cash', amount: 970 }, { side: 'cr', role: '2210', amount: 30 }]);
  });
  it('the accountant\'s account wins over the category; an unmapped category has no journal', () => {
    expect(queuePlan(claim({ account_override: '6210' }), office, '2210').debit).toBe('6210');
    expect(queuePlan(claim(), cat({ account_code: null }), '2210')).toEqual({ lines: [], debit: null });
  });
});

describe('approve & post: what can be ticked, and why not', () => {
  it('only expenses not posted yet, and a transfer only with its bank account', () => {
    expect(rowBlock(claim())).toBeNull();
    expect(rowBlock(claim({ status: 'submitted' }))).toBeNull();
    expect(rowBlock(claim({ status: 'posted' }))).toBe('not_open');
    expect(rowBlock(claim({ status: 'rejected' }))).toBe('not_open');
    expect(rowBlock(claim({ payment_method: 'bank_transfer' }))).toBe('no_bank');
    expect(rowBlock(claim({ payment_method: 'bank_transfer', bank_account_id: 'scb' }))).toBeNull();
  });
  it('the database reasons are shown in Thai (English as sent)', () => {
    const p = 'EXP_BANK_REQUIRED: Choose the bank account the money was paid from';
    expect(problemCode(p)).toBe('EXP_BANK_REQUIRED');
    expect(problemText('th', p)).toContain('บัญชีธนาคาร');
    expect(problemText('en', p)).toBe('Choose the bank account the money was paid from');
    expect(problemText('th', 'some other error')).toBe('some other error');
  });
});

describe('the accounting device posts an expense row from the queue', () => {
  const SCB = 'bank-scb';
  const pay = (id: string, amount: number, vat = 0): FinanceQueueRow => ({
    id, event_type: 'EXPENSE_PAYMENT', ref_no: 'EXP-2026-000010', event_date: ctx.now, amount,
    plan: [{ side: 'dr', role: 'inv_materials', amount: amount - vat }, ...(vat ? [{ side: 'dr' as const, role: 'input_vat', amount: vat }] : []), { side: 'cr', role: 'bank', amount, bank_account_id: SCB }],
    banks: { [SCB]: { code: 'SCB', gl_account_code: null } }, detail: { expense_no: 'EXP-2026-000010', description: 'น้ำตาลสด', vendor: 'ตลาด', vat, paid_from: 'bank' },
  });
  const bal = (d: DB, code: string) => d.journals.reduce((s, j) => s + j.lines.filter((l) => l.account === code).reduce((x, l) => x + l.debit - l.credit, 0), 0);
  it('Dr inventory raw materials / Cr bank, and the expense register (VAT report) gets the claimable VAT', () => {
    tx((d) => {
      const inv0 = bal(d, '1200'), bank0 = bal(d, '1110'), n0 = d.expenses.length;
      const r = postFinanceRow(d, ctx, pay('q1', 2675, 175), { invoice_vat_mode: 'none', vat_rate: 7 });
      expect(bal(d, '1200') - inv0).toBe(2500); expect(bal(d, '1110') - bank0).toBe(-2675);
      expect(d.expenses).toHaveLength(n0 + 1);
      expect(d.expenses[d.expenses.length - 1]).toMatchObject({ no: 'EXP-2026-000010', amount: 2675, vat: 175, paidFrom: 'bank', journalId: r.journalId, account: '1200' });
      expect(postFinanceRow(d, ctx, pay('q1', 2675, 175), { invoice_vat_mode: 'none', vat_rate: 7 }).already).toBe(true);   // posting again changes nothing
      expect(d.expenses).toHaveLength(n0 + 1);
    });
  });
  it('the journal knows its expense, so the expense reports and the claims-vs-ledger check include it', () => {
    tx((d) => {
      const row = { ...pay('q9', 107, 7), plan: [{ side: 'dr' as const, role: '6300', amount: 100 }, { side: 'dr' as const, role: 'input_vat', amount: 7 }, { side: 'cr' as const, role: 'cash', amount: 107 }],
        detail: { expense_no: 'EXP-2026-000011', description: 'Paper', vat: 7, paid_from: 'cash', claim_id: 'claim-9', category_code: 'office_supplies', category_name_en: 'Office supplies', category_name_th: 'เครื่องใช้สำนักงาน', expense_date: '2026-11-28' } };
      const r = postFinanceRow(d, ctx, row, { invoice_vat_mode: 'none', vat_rate: 7 });
      const j = d.journals.find((x) => x.id === r.journalId)!;
      expect(j.info).toMatchObject({ claimId: 'claim-9', claimNo: 'EXP-2026-000011', categoryCode: 'office_supplies', vat: 7 });
      const day = j.date.slice(0, 10);
      const rows = expenseRows(d, day, day).filter((x) => x.journal.id === j.id);
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ source: 'claim', amount: 100, vat: 7, cashOut: 107, categoryKey: 'office_supplies' });
      const rec = reconcileClaims(d, [{ id: 'claim-9', expense_no: 'EXP-2026-000011', amount_paid: 107, wht_amount: 0, journal_no: null, status: 'posted', gl_queue_id: 'q9' },
        { id: 'claim-10', expense_no: 'EXP-2026-000012', amount_paid: 50, wht_amount: 0, journal_no: null, status: 'posted', gl_queue_id: 'q10' }]);
      expect(rec.issues).toEqual([{ id: 'claim-10', no: 'EXP-2026-000012', problem: 'missing', detail: expect.stringContaining('accounting queue') }]);
    });
  });
  it('the reversal row flips the lines and marks the original reversed, so the register leaves it out', () => {
    tx((d) => {
      const r1 = postFinanceRow(d, ctx, pay('q1', 2500), { invoice_vat_mode: 'none', vat_rate: 7 });
      const rev: FinanceQueueRow = { ...pay('q2', 2500), event_type: 'EXPENSE_REVERSAL', depends_on: 'q1',
        plan: pay('q1', 2500).plan.map((l) => ({ ...l, side: l.side === 'dr' ? 'cr' as const : 'dr' as const })), detail: { reverses_queue_id: 'q1', reason: 'Wrong account' } };
      const inv0 = bal(d, '1200');
      const r2 = postFinanceRow(d, ctx, rev, { invoice_vat_mode: 'none', vat_rate: 7 });
      expect(bal(d, '1200') - inv0).toBe(-2500);
      expect(financeJournal(d, 'q1')!.status).toBe('reversed');
      expect(d.journals.find((j) => j.id === r2.journalId)!.reverses).toBe(r1.journalId);
      expect(liveExpenses(d).some((e) => e.journalId === r1.journalId)).toBe(false);
    });
  });
});
