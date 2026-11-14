import { describe, expect, it } from 'vitest';
import { ctx, tx, expectIntegrity } from '../helpers';
import { addExpense, balancesBetween } from '../../src/domain/accounting';
import { postExpenseClaim, reverseExpenseClaim, type ClaimForPosting, type ExpenseConfig } from '../../src/domain/expenseLedger';
import { byAccount, byCategory, dailySummary, expenseRows, monthlyComparison, reconcileClaims, totalsOf } from '../../src/domain/expenseReports';
import type { DB } from '../../src/domain/types';

const CFG: ExpenseConfig = { whtAccount: '2210', fixedAssetAccount: '1500', fixedAssetWarnAmount: 0 };
let n = 0;
const claim = (o: Partial<ClaimForPosting> = {}): ClaimForPosting => ({
  id: `rc-${++n}`, expenseNo: `EXP-2026-9${String(n).padStart(5, '0')}`, expenseDate: '2026-11-13', description: 'Item', vendor: 'Vendor', vendorTaxId: '0105536123456', amountPaid: 100, vatAmount: 0, taxType: 'none',
  whtAmount: 0, paidFrom: 'cash', paymentMethod: 'cash', treatment: 'expense', categoryCode: 'office_supplies', categoryNameEn: 'Office supplies', categoryNameTh: 'เครื่องใช้สำนักงาน', accountCode: '6300',
  reviewed: true, attachmentCount: 1, ...o,
});
const claimRows = (d: DB, from: string, to: string) => expenseRows(d, from, to).filter((r) => r.source === 'claim');   // the demo data also holds older-style expenses
const post = (d: DB, o: Partial<ClaimForPosting>) => { const c = claim(o); postExpenseClaim(d, ctx, c, CFG); return c; };

/** A small, varied month of expenses. */
function seedMonth(d: DB) {
  d.meta.lockedUntil = null;                                                      // the demo data is closed through 31 Oct; these tests need October open
  post(d, { expenseDate: '2026-10-20', amountPaid: 200, description: 'October paper' });
  post(d, { expenseDate: '2026-11-12', amountPaid: 500, categoryCode: 'electricity', categoryNameEn: 'Electricity', categoryNameTh: 'ค่าไฟฟ้า', accountCode: '6210', paidFrom: 'bank', paymentMethod: 'bank_transfer' });
  post(d, { expenseDate: '2026-11-12', amountPaid: 107, vatAmount: 7, taxType: 'vat_included', paidFrom: 'bank', paymentMethod: 'qr' });
  post(d, { expenseDate: '2026-11-13', amountPaid: 1000, whtAmount: 50, categoryCode: 'rent', categoryNameEn: 'Rent', categoryNameTh: 'ค่าเช่า', accountCode: '6200', paidFrom: 'bank', paymentMethod: 'bank_transfer' });
  post(d, { expenseDate: '2026-11-13', amountPaid: 32100, vatAmount: 2100, taxType: 'vat_included', treatment: 'fixed_asset', accountCode: '1500', categoryCode: 'equipment', categoryNameEn: 'Equipment & assets', categoryNameTh: 'อุปกรณ์และสินทรัพย์', paidFrom: 'bank', paymentMethod: 'bank_transfer' });
  post(d, { expenseDate: '2026-11-13', amountPaid: 75 });
}

describe('expense reports are derived from the ledger', () => {
  it('daily summary: every column equals the sum of the underlying journal lines', () => {
    tx((d) => {
      seedMonth(d);
      const rows = claimRows(d, '2026-11-01', '2026-11-30');
      expect(rows).toHaveLength(5);
      const t = totalsOf(rows);
      let amount = 0, vat = 0, cash = 0, bank = 0, wht = 0;
      for (const j of d.journals.filter((x) => x.refType === 'expense_claim' && x.date.startsWith('2026-11'))) {
        for (const l of j.lines) {
          if (['6300', '6210', '6200', '1500'].includes(l.account)) amount += l.debit - l.credit;
          if (l.account === '1300') vat += l.debit - l.credit;
          if (l.account === '1100') cash += l.credit - l.debit;
          if (l.account === '1110') bank += l.credit - l.debit;
          if (l.account === '2210') wht += l.credit - l.debit;
        }
      }
      const r = (x: number) => Math.round(x * 100) / 100;
      expect(t).toMatchObject({ n: 5, amount: r(amount), vat: r(vat), cashOut: r(cash), bankOut: r(bank), wht: r(wht), paid: r(cash + bank) });
      expect(t.amount + t.vat).toBe(Math.round((t.paid + t.wht) * 100) / 100);     // what was recognised = what left the bank/cash + tax withheld
      expect(dailySummary(rows).map((x) => x.date)).toEqual(['2026-11-13', '2026-11-12']);
      expect(dailySummary(rows).reduce((s, x) => s + x.paid, 0)).toBe(t.paid);
    });
  });

  it('by category and by account both add up to the expense total', () => {
    tx((d) => {
      seedMonth(d);
      const rows = claimRows(d, '2026-11-01', '2026-11-30');
      const total = totalsOf(rows).amount;
      expect(Math.round(byCategory(rows).reduce((s, c) => s + c.amount, 0) * 100) / 100).toBe(total);
      expect(Math.round(byAccount(rows).reduce((s, c) => s + c.amount, 0) * 100) / 100).toBe(total);
      expect(byCategory(rows).find((c) => c.key === 'rent')).toMatchObject({ amount: 1000, th: 'ค่าเช่า', n: 1 });
      expect(byCategory(rows).find((c) => c.key === 'equipment')).toMatchObject({ amount: 30000 });
      expect(byAccount(rows).find((a) => a.code === '1500')!.amount).toBe(30000);
    });
  });

  it('cash and bank outflow come from the cash / bank accounts, and WHT stays out of the cash outflow', () => {
    tx((d) => {
      seedMonth(d);
      const t = totalsOf(claimRows(d, '2026-11-13', '2026-11-13'));
      expect(t.cashOut).toBe(75);
      expect(t.bankOut).toBe(950 + 32100);
      expect(t.wht).toBe(50);
    });
  });

  it('a reversed posting drops out of every report and the books stay balanced', () => {
    tx((d) => {
      const c = post(d, { amountPaid: 640, expenseDate: '2026-11-14', description: 'to be reversed' });
      const before = totalsOf(claimRows(d, '2026-11-14', '2026-11-14'));
      expect(before.amount).toBe(640);
      reverseExpenseClaim(d, ctx, c.id, 'Wrong month');
      const after = totalsOf(claimRows(d, '2026-11-14', '2026-11-14'));
      expect(after).toMatchObject({ n: 0, amount: 0, paid: 0 });
      const b = balancesBetween(d.journals); let dr = 0, cr = 0; for (const k in b) { dr += b[k].debit; cr += b[k].credit; }
      expect(Math.round(dr * 100)).toBe(Math.round(cr * 100));
      expectIntegrity(d);
    });
  });

  it('keeps the transaction date, posting date and approval date apart', () => {
    tx((d) => {
      post(d, { expenseDate: '2026-11-10', postingDate: '2026-11-13', amountPaid: 300, approvedAt: '2026-11-11T09:00:00.000Z' });
      const r = claimRows(d, '2026-11-13', '2026-11-13')[0];
      expect(r).toMatchObject({ transactionDate: '2026-11-10', postingDate: '2026-11-13', approvedAt: '2026-11-11T09:00:00.000Z' });
      expect(claimRows(d, '2026-11-10', '2026-11-10')).toHaveLength(0);          // reports by posting date: nothing was posted on the 10th
    });
  });

  it('monthly comparison reports each month and the change against the previous one', () => {
    tx((d) => {
      seedMonth(d);
      const m = monthlyComparison(d, '2026-11-30', 3);
      expect(m.map((x) => x.month)).toEqual(['2026-09', '2026-10', '2026-11']);
      expect(m[2].amount).toBe(totalsOf(expenseRows(d, '2026-11-01', '2026-11-30')).amount);
      expect(m[1].amount).toBe(totalsOf(expenseRows(d, '2026-10-01', '2026-10-31')).amount);
      expect(m[1].amount).toBeGreaterThanOrEqual(200);                                // includes the October claim posted above
      const prev = m[1].amount;
      expect(m[2].change).toBe(prev > 0 ? Math.round(((m[2].amount - prev) / prev) * 10000) / 100 : null);
    });
  });

  it('includes expenses entered the old way (“Add expense”) and groups them by account', () => {
    tx((d) => {
      addExpense(d, ctx, { date: '2026-11-13T05:00:00.000Z', account: '6210', vendor: 'MEA', amount: 321, paidFrom: 'bank' });
      const rows = expenseRows(d, '2026-11-13', '2026-11-13').filter((r) => r.journal.memo === 'Expense: MEA');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: 'legacy', amount: 321, bankOut: 321, categoryKey: 'account:6210', categoryEn: 'Utilities', categoryTh: 'ค่าสาธารณูปโภค' });
    });
  });
});

describe('reconciling the workflow database with this ledger', () => {
  const wf = (c: ClaimForPosting, status = 'posted', over: object = {}) => ({ id: c.id, expense_no: c.expenseNo, amount_paid: c.amountPaid, wht_amount: c.whtAmount, journal_no: null as string | null, status, ...over });
  it('agrees when every posted claim has exactly one matching journal', () => {
    tx((d) => {
      const a = post(d, { amountPaid: 100 }), b = post(d, { amountPaid: 107, vatAmount: 7, taxType: 'vat_included', whtAmount: 3 });
      const r = reconcileClaims(d, [wf(a), wf(b), wf(claim(), 'approved')]);
      expect(r).toMatchObject({ issues: [], workflow: 207, ledger: 207, diff: 0, orphans: [] });
    });
  });
  it('flags a claim marked posted with no journal here, an amount that differs, a different journal number, and a journal the workflow does not know', () => {
    tx((d) => {
      const a = post(d, { amountPaid: 100 }), lost = claim({ amountPaid: 50 }), c = post(d, { amountPaid: 80 }), e = post(d, { amountPaid: 60 });
      const jNo = d.journals.find((j) => j.refId === c.id)!.no;
      const r = reconcileClaims(d, [wf(a, 'posted', { amount_paid: 101 }), wf(lost), wf(c, 'posted', { journal_no: 'JV-999999' })]);
      expect(r.issues.map((i) => i.problem).sort()).toEqual(['amount', 'journal', 'missing']);
      expect(r.orphans.map((o) => o.claim)).toEqual([e.expenseNo]);
      expect(r.diff).not.toBe(0);
      expect(jNo).not.toBe('JV-999999');
    });
  });
});
