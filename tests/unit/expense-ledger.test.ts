import { describe, expect, it } from 'vitest';
import { ctx, tx, codeOf, expectIntegrity } from '../helpers';
import { balancesBetween } from '../../src/domain/accounting';
import { cashFlowReport, expenseAnalysis, vatReport } from '../../src/domain/setup';
import { calcExpenseTax, claimJournal, planExpensePosting, postExpenseClaim, reverseExpenseClaim, type ClaimForPosting, type ExpenseConfig } from '../../src/domain/expenseLedger';
import type { DB } from '../../src/domain/types';

const DAY = '2026-11-13';
const CFG: ExpenseConfig = { whtAccount: '2210', fixedAssetAccount: '1500', fixedAssetWarnAmount: 0 };
let n = 0;
const claim = (o: Partial<ClaimForPosting> = {}): ClaimForPosting => ({
  id: `claim-${++n}`, expenseNo: `EXP-2026-${String(n).padStart(6, '0')}`, expenseDate: DAY, description: 'Printer paper', vendor: 'Office Mate', vendorTaxId: '0105536123456',
  amountPaid: 250, vatAmount: 0, taxType: 'none', whtAmount: 0, paidFrom: 'cash', paymentMethod: 'cash', treatment: 'expense',
  categoryCode: 'office_supplies', categoryNameEn: 'Office supplies', categoryNameTh: 'เครื่องใช้สำนักงาน', accountCode: '6300', reviewed: true, attachmentCount: 1, ...o,
});
const totals = (d: DB) => { const b = balancesBetween(d.journals); let dr = 0, cr = 0; for (const k in b) { dr += b[k].debit; cr += b[k].credit; } return { dr: Math.round(dr * 100) / 100, cr: Math.round(cr * 100) / 100 }; };
const lastJournal = (d: DB) => d.journals[d.journals.length - 1];
const cashierId = (d: DB) => d.users.find((u) => u.roleId === 'role-cashier')!.id;

describe('expense tax arithmetic (must match the database function expense_calc)', () => {
  it('computes VAT included / excluded / none / non-creditable and rounds to the satang', () => {
    expect(calcExpenseTax(107, 'vat_included', 0.07)).toEqual({ paid: 107, vat: 7 });
    expect(calcExpenseTax(100, 'vat_excluded', 0.07)).toEqual({ paid: 107, vat: 7 });
    expect(calcExpenseTax(107, 'vat_noncreditable', 0.07)).toEqual({ paid: 107, vat: 7 });
    expect(calcExpenseTax(250, 'none', 0.07)).toEqual({ paid: 250, vat: 0 });
    expect(calcExpenseTax(99.99, 'vat_included', 0.07)).toEqual({ paid: 99.99, vat: 6.54 });
    expect(calcExpenseTax(0.5, 'vat_excluded', 0.07)).toEqual({ paid: 0.54, vat: 0.04 });
  });
});

describe('posting an approved expense claim', () => {
  it('cash expense without VAT: Dr expense account / Cr cash, balanced, with a full trail', () => {
    tx((d) => {
      const before = totals(d);
      const c = claim();
      const r = postExpenseClaim(d, ctx, c, CFG);
      const j = d.journals.find((x) => x.id === r.journalId)!;
      expect(j.lines).toEqual([{ account: '6300', debit: 250, credit: 0, memo: 'Office Mate' }, { account: '1100', debit: 0, credit: 250, memo: 'Office Mate' }]);
      expect(j).toMatchObject({ refType: 'expense_claim', refId: c.id, status: 'posted', memo: `Expense ${c.expenseNo}: Office Mate` });
      expect(j.info).toMatchObject({ claimNo: c.expenseNo, categoryCode: 'office_supplies', categoryNameTh: 'เครื่องใช้สำนักงาน', treatment: 'expense', vat: 0, wht: 0, expenseDate: DAY });
      expect(d.audit.some((a) => a.action === 'expense.post' && a.entityId === r.journalId)).toBe(true);
      expect(totals(d).dr - before.dr).toBe(250); expect(totals(d).cr - before.cr).toBe(250);
      expect(totals(d).dr).toBe(totals(d).cr);
      expectIntegrity(d);
    });
  });

  it('bank transfer with claimable VAT included: Dr expense (before VAT) + Dr Input VAT / Cr bank', () => {
    tx((d) => {
      postExpenseClaim(d, ctx, claim({ amountPaid: 107, vatAmount: 7, taxType: 'vat_included', paidFrom: 'bank', paymentMethod: 'bank_transfer' }), CFG);
      expect(lastJournal(d).lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['6300', 100, 0], ['1300', 7, 0], ['1110', 0, 107]]);
      expectIntegrity(d);
    });
  });

  it('VAT excluded (paid = price + VAT) posts exactly the same way', () => {
    tx((d) => {
      const t = calcExpenseTax(100, 'vat_excluded', 0.07);
      postExpenseClaim(d, ctx, claim({ amountPaid: t.paid, vatAmount: t.vat, taxType: 'vat_excluded', paidFrom: 'bank' }), CFG);
      expect(lastJournal(d).lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['6300', 100, 0], ['1300', 7, 0], ['1110', 0, 107]]);
    });
  });

  it('VAT that cannot be claimed stays in the cost: no Input VAT line, nothing listed in the VAT report', () => {
    tx((d) => {
      postExpenseClaim(d, ctx, claim({ amountPaid: 107, vatAmount: 7, taxType: 'vat_noncreditable', paidFrom: 'bank' }), CFG);
      expect(lastJournal(d).lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['6300', 107, 0], ['1110', 0, 107]]);
      const v = vatReport(d, DAY, DAY);
      expect(v.expenses).toHaveLength(0);
    });
  });

  it('withholding tax: cash out is reduced and the tax is owed to the Revenue Department (Cr 2210)', () => {
    tx((d) => {
      postExpenseClaim(d, ctx, claim({ amountPaid: 1000, whtAmount: 50, paidFrom: 'bank', accountCode: '6200', categoryCode: 'rent' }), CFG);
      expect(lastJournal(d).lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['6200', 1000, 0], ['1110', 0, 950], ['2210', 0, 50]]);
      expect(lastJournal(d).info).toMatchObject({ wht: 50 });
      expectIntegrity(d);
    });
  });

  it('VAT and withholding tax together: WHT is on the amount before VAT', () => {
    tx((d) => {
      postExpenseClaim(d, ctx, claim({ amountPaid: 107, vatAmount: 7, taxType: 'vat_included', whtAmount: 3, paidFrom: 'bank' }), CFG);
      const l = lastJournal(d).lines.map((x) => [x.account, x.debit, x.credit]);
      expect(l).toEqual([['6300', 100, 0], ['1300', 7, 0], ['1110', 0, 104], ['2210', 0, 3]]);
      expect(totals(d).dr).toBe(totals(d).cr);
    });
  });

  it('a fixed asset goes to the asset account (not an expense), and its cash outflow is an investing activity', () => {
    tx((d) => {
      postExpenseClaim(d, ctx, claim({ amountPaid: 32100, vatAmount: 2100, taxType: 'vat_included', treatment: 'fixed_asset', accountCode: '1500', paidFrom: 'bank', description: 'Espresso machine', categoryCode: 'equipment' }), CFG);
      expect(lastJournal(d).lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['1500', 30000, 0], ['1300', 2100, 0], ['1110', 0, 32100]]);
      expect(expenseAnalysis(d, DAY, DAY).some((r) => r.account === '1500')).toBe(false);
      const cf = cashFlowReport(d, DAY, DAY);
      expect(cf.rows.find((r) => r.label === 'Equipment purchases')).toMatchObject({ cls: 'investing', outflow: 32100 });
      expect(cf.check).toBe(0);
    });
  });

  it('feeds the reports: expense analysis, VAT input, cash flow (operating) and the trial balance', () => {
    tx((d) => {
      const e0 = expenseAnalysis(d, DAY, DAY).find((r) => r.account === '6300')?.amount ?? 0;
      const v0 = vatReport(d, DAY, DAY).inputVat;
      postExpenseClaim(d, ctx, claim({ amountPaid: 107, vatAmount: 7, taxType: 'vat_included', paidFrom: 'bank' }), CFG);
      expect(expenseAnalysis(d, DAY, DAY).find((r) => r.account === '6300')!.amount - e0).toBe(100);
      expect(vatReport(d, DAY, DAY).inputVat - v0).toBe(7);
      expect(cashFlowReport(d, DAY, DAY).rows.some((r) => r.cls === 'operating' && r.label === 'Operating expenses')).toBe(true);
      expect(cashFlowReport(d, DAY, DAY).check).toBe(0);
      expectIntegrity(d);
    });
  });

  it('keeps the transaction date apart from the posting date (a later posting date can be chosen)', () => {
    tx((d) => {
      const r = postExpenseClaim(d, ctx, claim({ expenseDate: '2026-11-10', postingDate: '2026-11-13' }), CFG);
      const j = d.journals.find((x) => x.id === r.journalId)!;
      expect(r.date).toBe('2026-11-13');
      expect(j.date.slice(0, 10) >= '2026-11-12' && j.date.slice(0, 10) <= '2026-11-13').toBe(true);
      expect(j.info!.expenseDate).toBe('2026-11-10');
    });
  });

  it('tags a branch on the journal when the accountant chose one', () => {
    tx((d) => {
      const b = d.branches[0].id;
      postExpenseClaim(d, ctx, claim({ branchId: b }), CFG);
      expect(lastJournal(d).dim).toEqual({ branchId: b });
    });
  });
});

describe('what must be refused (nothing is posted when any rule fails)', () => {
  const refuse = (mut: (d: DB) => void, c: Partial<ClaimForPosting>, code: string, cfg: ExpenseConfig = CFG) => tx((d) => {
    mut(d);
    const j0 = d.journals.length, e0 = d.expenses.length;
    expect(codeOf(() => postExpenseClaim(d, ctx, claim(c), cfg)), JSON.stringify(c)).toBe(code);
    expect(d.journals.length).toBe(j0); expect(d.expenses.length).toBe(e0);
  });

  it('a category with no account mapping', () => refuse(() => undefined, { accountCode: null }, 'MISSING_MAPPING'));
  it('an account that does not exist', () => refuse(() => undefined, { accountCode: '6999' }, 'UNKNOWN_ACCOUNT'));
  it('a header account', () => refuse(() => undefined, { accountCode: '6000' }, 'HEADER_ACCOUNT'));
  it('an inactive account', () => refuse((d) => { d.accounts.find((a) => a.code === '6210')!.active = false; }, { accountCode: '6210' }, 'INACTIVE_ACCOUNT'));
  it('an account that is inactive from a date on or before the expense date', () => refuse((d) => { d.accounts.find((a) => a.code === '6210')!.inactiveFrom = '2026-11-01T00:00:00.000Z'; }, { accountCode: '6210' }, 'INACTIVE_ACCOUNT'));
  it('an account that is not yet effective on the expense date', () => refuse((d) => { d.accounts.find((a) => a.code === '6210')!.effectiveFrom = '2027-01-01T00:00:00.000Z'; }, { accountCode: '6210' }, 'INACTIVE_ACCOUNT'));
  it('a revenue account', () => refuse(() => undefined, { accountCode: '4010' }, 'WRONG_CLASS'));
  it('cost of goods sold (not an operating expense)', () => refuse(() => undefined, { accountCode: '5010' }, 'WRONG_CLASS'));
  it('an asset account for an ordinary expense', () => refuse(() => undefined, { accountCode: '1500' }, 'WRONG_CLASS'));
  it('an expense account for a fixed asset', () => refuse(() => undefined, { treatment: 'fixed_asset', accountCode: '6300' }, 'WRONG_CLASS'));
  it('accumulated depreciation (contra) for a fixed asset', () => refuse(() => undefined, { treatment: 'fixed_asset', accountCode: '1590' }, 'WRONG_CLASS'));
  it('a system / control account such as Input VAT or Cash', () => { refuse(() => undefined, { accountCode: '1300' }, 'CONTROL_ACCOUNT'); refuse(() => undefined, { accountCode: '1100' }, 'CONTROL_ACCOUNT'); });
  it('an expense that was not reviewed by the accountant', () => refuse(() => undefined, { reviewed: false }, 'NOT_REVIEWED'));
  it('VAT on a business that is not VAT-registered', () => refuse((d) => { d.org.vatRegistered = false; }, { amountPaid: 107, vatAmount: 7, taxType: 'vat_included' }, 'NOT_VAT_REGISTERED'));
  it('a VAT amount while the tax type says no VAT', () => refuse(() => undefined, { amountPaid: 107, vatAmount: 7, taxType: 'none' }, 'VAT_INCONSISTENT'));
  it('VAT as large as the whole amount', () => refuse(() => undefined, { amountPaid: 100, vatAmount: 100, taxType: 'vat_included' }, 'BAD_AMOUNT'));
  it('withholding tax larger than the amount before VAT', () => refuse(() => undefined, { amountPaid: 107, vatAmount: 7, taxType: 'vat_included', whtAmount: 101 }, 'BAD_AMOUNT'));
  it('a zero amount', () => refuse(() => undefined, { amountPaid: 0 }, 'BAD_AMOUNT'));
  it('withholding tax when the configured tax-payable account is not a tax-payable account', () => refuse(() => undefined, { amountPaid: 1000, whtAmount: 30 }, 'WHT_ACCOUNT', { ...CFG, whtAccount: '6300' }));
  it('withholding tax when the configured account does not exist', () => refuse(() => undefined, { amountPaid: 1000, whtAmount: 30 }, 'WHT_ACCOUNT', { ...CFG, whtAccount: '2999' }));
  it('claimable VAT when no Input VAT account is mapped', () => refuse((d) => { delete d.postingMap.input_vat; }, { amountPaid: 107, vatAmount: 7, taxType: 'vat_included' }, 'VAT_ACCOUNT'));
  it('a payment account that is not mapped', () => refuse((d) => { delete d.postingMap.cash; }, {}, 'PAYMENT_ACCOUNT'));
  it('a posting date inside a closed period', () => refuse((d) => { d.meta.lockedUntil = DAY; }, {}, 'PERIOD_LOCKED'));

  it('a closed period is fine once a posting date in an open period is chosen', () => {
    tx((d) => {
      d.meta.lockedUntil = '2026-11-13';
      const r = postExpenseClaim(d, ctx, claim({ postingDate: '2026-11-14' }), CFG);
      expect(r.date).toBe('2026-11-14');
    });
  });

  it('posting the same claim twice (duplicate journal)', () => {
    tx((d) => {
      const c = claim();
      postExpenseClaim(d, ctx, c, CFG);
      const n1 = d.journals.length;
      expect(codeOf(() => postExpenseClaim(d, ctx, c, CFG))).toBe('DUPLICATE_POSTING');
      expect(d.journals.length).toBe(n1);
      expect(d.expenses.filter((e) => e.no === c.expenseNo)).toHaveLength(1);
    });
  });

  it('a user without accounting permission', () => {
    tx((d) => { expect(codeOf(() => postExpenseClaim(d, { ...ctx, userId: cashierId(d) }, claim(), CFG))).toBe('FORBIDDEN'); });
  });
});

describe('the plan shown to the accountant', () => {
  it('returns the journal that would be posted, no errors, and soft warnings', () => {
    tx((d) => {
      const p = planExpensePosting(d, claim({ attachmentCount: 0, vendorTaxId: null, amountPaid: 107, vatAmount: 7, taxType: 'vat_included' }), { ...CFG, fixedAssetWarnAmount: 100 });
      expect(p.ok).toBe(true);
      expect(p.lines).toHaveLength(3);
      expect(p.warnings.map((w) => w.code).sort()).toEqual(['ASSET_THRESHOLD', 'NO_RECEIPT', 'NO_VENDOR_TAX_ID']);
    });
  });
  it('warns when the VAT amount is not 7% of the amount', () => {
    tx((d) => {
      const p = planExpensePosting(d, claim({ amountPaid: 107, vatAmount: 12, taxType: 'vat_included' }), CFG);
      expect(p.ok).toBe(true);
      expect(p.warnings.some((w) => w.code === 'VAT_RATE_DIFF')).toBe(true);
    });
  });
  it('lists every blocking problem at once and an empty journal when blocked', () => {
    tx((d) => {
      const p = planExpensePosting(d, claim({ accountCode: '6000', reviewed: false }), CFG);
      expect(p.ok).toBe(false);
      expect(p.errors.map((e) => e.code).sort()).toEqual(['HEADER_ACCOUNT', 'NOT_REVIEWED']);
      expect(p.lines).toEqual([]);
    });
  });
  it('an accountant override replaces the category account (and is validated like any other)', () => {
    tx((d) => {
      expect(planExpensePosting(d, claim({ accountCode: '6300', accountOverride: '6210' }), CFG).debitAccount).toBe('6210');
      expect(planExpensePosting(d, claim({ accountCode: '6300', accountOverride: '4010' }), CFG).errors[0].code).toBe('WRONG_CLASS');
    });
  });
});

describe('reversal', () => {
  it('reverses the journal, keeps the original, keeps the ledger balanced and removes the claimed VAT from the VAT report', () => {
    tx((d) => {
      const c = claim({ amountPaid: 107, vatAmount: 7, taxType: 'vat_included', paidFrom: 'bank' });
      const r = postExpenseClaim(d, ctx, c, CFG);
      const v1 = vatReport(d, DAY, DAY).inputVat;
      const out = reverseExpenseClaim(d, ctx, c.id, 'Posted to the wrong month');
      const orig = d.journals.find((j) => j.id === r.journalId)!;
      expect(orig.status).toBe('reversed');
      expect(out.journalNo).toBe(orig.no);
      expect(d.journals.find((j) => j.no === out.reversalNo)).toMatchObject({ reverses: orig.id, refType: 'reversal' });
      expect(claimJournal(d, c.id)).toBeUndefined();
      expect(totals(d).dr).toBe(totals(d).cr);
      expect(vatReport(d, DAY, DAY).inputVat).toBe(Math.round((v1 - 7) * 100) / 100);
      expectIntegrity(d);
    });
  });
  it('needs a reason, an existing posting, and the approve permission', () => {
    tx((d) => {
      const c = claim();
      expect(codeOf(() => reverseExpenseClaim(d, ctx, c.id, 'x'))).toBe('NOT_FOUND');
      postExpenseClaim(d, ctx, c, CFG);
      expect(codeOf(() => reverseExpenseClaim(d, ctx, c.id, ' '))).toBe('REASON');
      expect(codeOf(() => reverseExpenseClaim(d, { ...ctx, userId: cashierId(d) }, c.id, 'x'))).toBe('FORBIDDEN');
    });
  });
});
