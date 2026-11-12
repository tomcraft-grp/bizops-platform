import { describe, expect, it } from 'vitest';
import { base, ctx, at, tx, stock, throws, codeOf, expectIntegrity } from '../helpers';
import { addExpense, balancesBetween, closePeriod, natBal, post, postManualJournal, reverseJournal, reopenPeriod, sumAccounts, sumNetDebit, isControl, saleTax, taxAt, roleCode, dr, cr } from '../../src/domain/accounting';
import {
  approveDraft, approveOpening, approveSetup, cashFlowReport, decideMapping, deactivateAccount, deleteAccount, importCoaRows, postMovement, proposeMapping, reconDrill, reconciliationMatrix,
  rejectDraft, reopenSetup, reviewOpening, saveAccount, saveDraft, saveOpeningSet, saveTaxCode, setMappingDirect, setupChecks, submitDraft, validateCoa, vatReport, validateOpening, settlementRecon, inventoryRollforward,
} from '../../src/domain/setup';
import { createOrder, returnOrder } from '../../src/domain/orders';
import { createSettlement, receiveSettlement, settleable, createReceipt } from '../../src/domain/payments';
import { updateOrg } from '../../src/domain/master';
import { computeEcon, totalsOf } from '../../src/domain/economics';
import type { DB } from '../../src/domain/types';
import { dayKey, r2 } from '../../src/lib/util';

const u = (id: string) => ({ ...ctx, userId: id });
const addDaysIso = (d: Date, n: number) => new Date(d.getTime() + n * 86400000).toISOString();
const sale = (d: DB, productId = 'R04', qty = 1, extra: Record<string, unknown> = {}) => { stock(d, productId, 'W1', qty); return createOrder(d, ctx, { channel: 'POS', branchId: 'B1', lines: [{ productId, qty }], payments: [{ method: 'cash', amount: 1e6 }], skipPromotions: true, ...extra } as never); };
// signed: revenue = credit − debit (contra revenue reduces it), expense = debit − credit (contra expense reduces it)
const pl = (d: DB) => { const b = balancesBetween(d.journals); return { rev: r2(-sumNetDebit(d, b, (a) => a.type === 'revenue' && a.posting)), exp: sumNetDebit(d, b, (a) => a.type === 'expense' && a.posting) }; };

describe('journals: balance, posting rules and corrections (§5.6, §23.8)', () => {
  it('every posted journal balances to the satang', () => {
    tx((d) => { for (const j of d.journals) expect(Math.abs(j.lines.reduce((s, l) => s + l.debit - l.credit, 0))).toBeLessThan(0.005); });
  });
  it('an unbalanced journal is rejected', () => {
    tx((d) => { expect(codeOf(() => post(d, ctx, { memo: 'x', refType: 't', lines: [dr('cash', 10), cr('bank', 9)] }))).toBe('UNBALANCED'); });
  });
  it('postings into a locked period are blocked; the lock date itself is inclusive', () => {
    tx((d) => {
      expect(d.meta.lockedUntil).toBe('2026-10-31');
      const lines = [dr('6300', 10), cr('cash', 10)];
      expect(codeOf(() => post(d, ctx, { memo: 'x', refType: 't', lines, date: new Date('2026-10-31T23:59:59+07:00').toISOString() }))).toBe('PERIOD_LOCKED');
      expect(codeOf(() => post(d, ctx, { memo: 'x', refType: 't', lines, date: new Date('2026-11-01T00:00:00+07:00').toISOString() }))).toBe(null);
    });
  });
  it('reopening a period needs a reason and is audited as critical', () => {
    tx((d) => {
      expect(codeOf(() => reopenPeriod(d, ctx, null, ''))).toBe('REASON');
      reopenPeriod(d, ctx, null, 'accountant adjustment');
      expect(d.audit.at(-1)!.severity).toBe('critical');
    });
  });
  it('a reversal preserves the original, links to it and nets to zero; a reversal cannot be reversed', () => {
    tx((d) => {
      const id = postManualJournal(d, ctx, { date: ctx.now, memo: 'x', lines: [dr('6300', 100), cr('cash', 100)] });
      const rid = reverseJournal(d, ctx, id, 'wrong amount');
      const j = d.journals.find((x) => x.id === id)!, r = d.journals.find((x) => x.id === rid)!;
      expect(j.status).toBe('reversed'); expect(j.reversedBy).toBe(rid); expect(r.reverses).toBe(id);
      expect(codeOf(() => reverseJournal(d, ctx, rid, 'again'))).toBe('INVALID');
      expect(codeOf(() => reverseJournal(d, ctx, id, 'again'))).toBe('ALREADY');
      const fresh = postManualJournal(d, ctx, { date: ctx.now, memo: 'y', lines: [dr('6300', 5), cr('cash', 5)] });
      expect(codeOf(() => reverseJournal(d, ctx, fresh, ' '))).toBe('REASON');
    });
  });
  it('manual journals need a different approver (four-eyes) and unbalanced drafts cannot be submitted', () => {
    tx((d) => {
      const x = saveDraft(d, u('U9'), { date: ctx.now, memo: 'accrual', lines: [{ account: '6210', debit: 500, credit: 0 }, { account: '2110', debit: 0, credit: 500 }] });
      submitDraft(d, u('U9'), x);
      expect(codeOf(() => approveDraft(d, u('U9'), x))).toBe('SELF_APPROVAL');
      const jid = approveDraft(d, u('U1'), x);
      const j = d.journals.find((y) => y.id === jid)!;
      expect(j.approvedBy).toBe('U1'); expect(j.createdBy).toBe('U1');
      const bad = saveDraft(d, u('U9'), { date: ctx.now, memo: 'bad', lines: [{ account: '6210', debit: 500, credit: 0 }, { account: '2110', debit: 0, credit: 400 }] });
      expect(codeOf(() => submitDraft(d, u('U9'), bad))).toBe('UNBALANCED');
    });
  });
  it('a rejected draft needs a reason and never posts', () => {
    tx((d) => {
      const n = d.journals.length;
      const x = saveDraft(d, u('U9'), { date: ctx.now, memo: 'x', lines: [{ account: '6300', debit: 5, credit: 0 }, { account: 'cash' === 'cash' ? '1100' : '', debit: 0, credit: 5 }] });
      submitDraft(d, u('U9'), x);
      expect(codeOf(() => rejectDraft(d, u('U1'), x, ''))).toBe('REASON');
      rejectDraft(d, u('U1'), x, 'no support');
      expect(d.journals.length).toBe(n);
    });
  });
});

describe('chart of accounts and mapping controls (§23.2–23.4)', () => {
  it('the seeded chart and mappings are structurally valid', () => {
    tx((d) => { expect(validateCoa(d).filter((i) => i.level === 'error')).toEqual([]); });
  });
  it('header accounts and inactive accounts cannot receive postings', () => {
    tx((d) => {
      expect(codeOf(() => post(d, ctx, { memo: 'x', refType: 't', lines: [dr('1000', 5), cr('cash', 5)] }))).toBe('HEADER_ACCOUNT');
      expect(codeOf(() => post(d, ctx, { memo: 'x', refType: 't', lines: [dr('8100', 5), cr('cash', 5)] }))).toBe('INACTIVE_ACCOUNT');
      expect(codeOf(() => post(d, ctx, { memo: 'x', refType: 't', lines: [dr('9999', 5), cr('cash', 5)] }))).toBe('BAD_ACCOUNT');
    });
  });
  it('an unmapped posting role blocks the transaction instead of posting to a default account', () => {
    tx((d) => {
      delete d.postingMap.sales;
      const n = d.orders.length;
      expect(codeOf(() => sale(d))).toBe('UNMAPPED_ACCOUNT');
      void n;
    });
  });
  it('a used account cannot change type/normal balance or be deleted; an unused one can', () => {
    tx((d) => {
      expect(codeOf(() => saveAccount(d, ctx, { code: '6200', name: 'Rent', type: 'asset' }, false))).toBe('IN_USE');
      expect(codeOf(() => deleteAccount(d, ctx, '6200'))).toBe('IN_USE');
      saveAccount(d, ctx, { code: '6900', name: 'Test expense', nameTh: 'ทดสอบ', type: 'expense', normal: 'debit', fsLine: 'opex', parent: '6000', posting: true }, true);
      expect(codeOf(() => saveAccount(d, ctx, { code: '6900', name: 'dup', type: 'expense', normal: 'debit', fsLine: 'opex' }, true))).toBe('DUPLICATE');
      expect(codeOf(() => deleteAccount(d, ctx, '6900'))).toBe(null);
    });
  });
  it('a posting account must have a header parent', () => {
    tx((d) => { expect(codeOf(() => saveAccount(d, ctx, { code: '6901', name: 'x', type: 'expense', normal: 'debit', fsLine: 'opex', parent: '6200' }, true))).toBe('INVALID'); });
  });
  it('an account that is mapped to a role or has a balance cannot be deactivated', () => {
    tx((d) => {
      expect(codeOf(() => deactivateAccount(d, ctx, '4010', 'x'))).toBe('IN_USE');
      expect(codeOf(() => deactivateAccount(d, ctx, '6200', 'x'))).toBe('NON_ZERO');
    });
  });
  it('mapping changes are four-eyes, effective-dated and never rewrite earlier postings', () => {
    tx((d) => {
      const pending = d.mappingChanges.find((c) => c.status === 'pending')!; // proposed by the accountant in the demo data
      expect(pending.proposedBy).toBe('U9');
      expect(codeOf(() => decideMapping(d, u('U9'), pending.id, true, ''))).toBe('SELF_APPROVAL');
      expect(codeOf(() => proposeMapping(d, u('U9'), { role: pending.role, toCode: '6300', effectiveFrom: ctx.now, reason: 'dup' }))).toBe('PENDING');
      const eff = new Date(pending.effectiveFrom);
      decideMapping(d, u('U1'), pending.id, true, 'ok');
      expect(roleCode(d, pending.role, addDaysIso(eff, -1))).toBe('6400'); // before the effective date: old account
      expect(roleCode(d, pending.role, addDaysIso(eff, 1))).toBe('6300');
      expect(d.audit.at(-1)!.severity).toBe('critical');
    });
  });
  it('mapping a role to an account of the wrong kind or inside a closed period is rejected', () => {
    tx((d) => {
      expect(codeOf(() => proposeMapping(d, u('U9'), { role: 'sales', toCode: '1100', effectiveFrom: ctx.now, reason: 'x' }))).toBe('INVALID');
      expect(codeOf(() => proposeMapping(d, u('U9'), { role: 'sales', toCode: '4020', effectiveFrom: new Date('2026-10-15T00:00:00+07:00').toISOString(), reason: 'x' }))).toBe('PERIOD_LOCKED');
    });
  });
  it('once approved, direct mapping edits are refused (change control); in draft they are allowed', () => {
    tx((d) => {
      expect(codeOf(() => setMappingDirect(d, ctx, 'sales', '4020'))).toBe('CHANGE_CONTROL');
      reopenSetup(d, ctx, 'restructure');
      setMappingDirect(d, ctx, 'sales', '4020');
      expect(roleCode(d, 'sales')).toBe('4020');
    });
  });
  it('COA import is all-or-nothing', () => {
    tx((d) => {
      const n = d.accounts.length;
      const rows = [['code', 'name', 'type', 'normal', 'fs_line', 'parent'], ['6910', 'Good', 'expense', 'debit', 'opex', '6000'], ['6911', 'Bad type', 'nonsense', 'debit', 'opex', '6000']];
      expect(codeOf(() => importCoaRows(d, ctx, rows))).toBe('INVALID');
      expect(d.accounts.length).toBe(n);
      const ok = importCoaRows(d, ctx, [rows[0], rows[1]]);
      expect(ok.added).toBe(1);
    });
  });
  it('setup approval is blocked while a structural check fails', () => {
    tx((d) => {
      reopenSetup(d, ctx, 'x');
      delete d.postingMap.cash;
      expect(codeOf(() => approveSetup(d, ctx, { note: 'x', accountantReviewed: false }))).toBe('SETUP_INCOMPLETE');
      expect(setupChecks(d).find((c) => c.id === 'mapping')!.status).toBe('fail');
    });
  });
  it('the demo setup is approved but honestly flagged as not accountant-reviewed', () => {
    tx((d) => { expect(d.setup.status).toBe('approved'); expect(d.setup.accountantReviewed).toBe(false); });
  });
});

describe('opening balances (§23.10)', () => {
  const set = (d: DB, lines: { account: string; debit: number; credit: number }[]) => saveOpeningSet(d, u('U9'), { asOf: new Date('2026-11-12T00:00:00+07:00').toISOString(), source: 'Asset register v3', lines });
  it('requires a source, balanced amounts, and different preparer / reviewer / approver', () => {
    tx((d) => {
      expect(codeOf(() => saveOpeningSet(d, u('U9'), { asOf: ctx.now, source: ' ', lines: [] }))).toBe('INVALID');
      const id = set(d, [{ account: '1500', debit: 100, credit: 0 }, { account: '3010', debit: 0, credit: 100 }]);
      expect(codeOf(() => reviewOpening(d, u('U9'), id))).toBe('SELF_APPROVAL');
      reviewOpening(d, u('U2'), id);
      expect(codeOf(() => approveOpening(d, u('U9'), id))).toBe('SELF_APPROVAL');
      const jid = approveOpening(d, u('U1'), id);
      expect(d.journals.find((j) => j.id === jid)!.refType).toBe('opening_balance');
      expect(d.openingSets.find((x) => x.id === id)!.status).toBe('posted');
      expectIntegrity(d);
    });
  });
  it('rejects an unbalanced set and control accounts (subledger balances must come from documents)', () => {
    tx((d) => {
      const bad = set(d, [{ account: '1500', debit: 100, credit: 0 }, { account: '3010', debit: 0, credit: 90 }]);
      expect(codeOf(() => reviewOpening(d, u('U2'), bad))).toBe('INVALID');
      const ctrl = set(d, [{ account: '1130', debit: 100, credit: 0 }, { account: '3010', debit: 0, credit: 100 }]);
      expect(validateOpening(d, d.openingSets.find((x) => x.id === ctrl)!).join(' ')).toMatch(/control account/);
    });
  });
});

describe('money that is NOT revenue or expense (§23.5)', () => {
  it.each(['transfer', 'loan_received', 'loan_repaid', 'owner_contribution', 'owner_withdrawal'] as const)('%s leaves profit and loss untouched', (kind) => {
    tx((d) => {
      const before = pl(d);
      postMovement(d, ctx, { kind, amount: 1234, account: 'bank', toAccount: 'cash', date: ctx.now, memo: '' });
      expect(pl(d)).toEqual(before);
      expectIntegrity(d);
    });
  });
  it('interest is the only part of a loan payment that is an expense', () => {
    tx((d) => { const b = pl(d); postMovement(d, ctx, { kind: 'interest_paid', amount: 50, account: 'bank', date: ctx.now, memo: '' }); expect(pl(d).exp).toBe(r2(b.exp + 50)); });
  });
  it('a transfer between own accounts needs two different accounts', () => {
    tx((d) => { expect(codeOf(() => postMovement(d, ctx, { kind: 'transfer', amount: 5, account: 'bank', toAccount: 'bank', date: ctx.now, memo: '' }))).toBe('INVALID'); });
  });
  it('a later customer payment is not revenue (only the sale is)', () => {
    tx((d) => {
      d.customers.find((c) => c.id === 'C006')!.creditLimit = 1e6;
      const rev0 = pl(d).rev;
      stock(d, 'F02', 'W1', 1);
      const id = createOrder(d, ctx, { channel: 'POS', branchId: 'B1', customerId: 'C006', lines: [{ productId: 'F02', qty: 1 }], payLater: true, skipPromotions: true });
      const o = d.orders.find((x) => x.id === id)!;
      const rev1 = pl(d).rev;
      expect(rev1).toBeCloseTo(rev0 + (o.taxBase ?? 0), 1); // revenue = net sales (ex VAT)
      createReceipt(d, ctx, { customerId: 'C006', amount: o.total, method: 'transfer', allocations: 'fifo' });
      expect(pl(d).rev).toBe(rev1); // the later payment adds NO revenue
    });
  });
  it('expenses must use an expense account and keep VAT in input VAT', () => {
    tx((d) => {
      expect(codeOf(() => addExpense(d, ctx, { date: ctx.now, account: '1100', vendor: 'x', amount: 10, paidFrom: 'cash' }))).toBe('BAD_ACCOUNT');
      const exp0 = pl(d).exp;
      addExpense(d, ctx, { date: ctx.now, account: '6130', vendor: 'Ads', amount: 107, vat: 7, paidFrom: 'bank', branchId: 'B1' });
      expect(pl(d).exp).toBe(r2(exp0 + 100));
    });
  });
});

describe('tax configuration and snapshots (§23.9)', () => {
  it('a sale stores tax code, rate, base, amount and rule version', () => {
    tx((d) => {
      const id = sale(d, 'F02');
      const o = d.orders.find((x) => x.id === id)!;
      expect(o.taxCode).toBe('VAT7'); expect(o.vatRate).toBe(0.07); expect(o.taxRuleVersion).toBe(1);
      expect(r2((o.taxBase ?? 0) + (o.vatAmount ?? 0))).toBe(o.total);
    });
  });
  it('a new rate version applies only from its effective date; history keeps its own snapshot', () => {
    tx((d) => {
      const old = sale(d, 'F02');
      saveTaxCode(d, ctx, { code: 'VAT7', name: 'VAT', kind: 'vat', rate: 0.1, creditable: true, effectiveFrom: new Date('2026-11-14T00:00:00+07:00').toISOString() });
      expect(taxAt(d, 'VAT7', ctx.now)!.rate).toBe(0.07);
      expect(taxAt(d, 'VAT7', new Date('2026-11-15T00:00:00+07:00').toISOString())!.rate).toBe(0.1);
      expect(saleTax(d, new Date('2026-11-15T00:00:00+07:00').toISOString()).version).toBe(2);
      expect(d.orders.find((o) => o.id === old)!.vatRate).toBe(0.07);
      expect(codeOf(() => saveTaxCode(d, ctx, { code: 'VAT7', name: 'x', kind: 'vat', rate: 0.2, creditable: true, effectiveFrom: new Date('2026-11-14T00:00:00+07:00').toISOString() }))).toBe('INVALID');
    });
  });
  it('a business that is not VAT-registered posts no output VAT', () => {
    tx((d) => {
      updateOrg(d, ctx, { vatRegistered: false });
      const id = sale(d, 'F02');
      const o = d.orders.find((x) => x.id === id)!;
      expect(o.vatAmount).toBe(0); expect(o.taxCode).toBe('OOS');
      expectIntegrity(d);
    });
  });
  it('VAT report: output − input, and a return reverses output VAT', () => {
    tx((d) => {
      const day = dayKey(ctx.now);
      const before = vatReport(d, day, day);
      const id = sale(d, 'F02', 2);
      const o = d.orders.find((x) => x.id === id)!;
      const mid = vatReport(d, day, day);
      expect(r2(mid.outputVat - before.outputVat)).toBe(o.vatAmount);
      returnOrder(d, ctx, { orderId: id, lines: [{ lineId: o.lines[0].id, qty: 2, restock: true }], reason: 't', refund: 'none' });
      expect(vatReport(d, day, day).outputVat).toBeCloseTo(before.outputVat, 1);
      expect(vatReport(d, day, day).netPayable).toBeCloseTo(vatReport(d, day, day).outputVat - vatReport(d, day, day).inputVat, 2);
    });
  });
});

describe('reconciliation and report integrity (§23.7, §23.11–12)', () => {
  it('every control account agrees with its subledger on the seeded business', () => {
    tx((d) => { for (const r of reconciliationMatrix(d)) if (r.key !== 'cash_bank') expect(Math.abs(r.diff), `${r.key} differs by ${r.diff}`).toBeLessThan(0.05); });
  });
  it('a stray journal on a control account is detected, not hidden', () => {
    tx((d) => {
      postManualJournal(d, ctx, { date: ctx.now, memo: 'plug', lines: [dr('ar', 500), cr('6300', 500)] });
      const r = reconciliationMatrix(d).find((x) => x.key === 'ar')!;
      expect(r.status).toBe('diff'); expect(r.diff).toBe(500);
      expect(reconDrill(d, 'ar').length).toBeGreaterThan(0);
    });
  });
  it('trial balance, balance sheet and P&L reconcile to one another', () => {
    tx((d) => {
      const b = balancesBetween(d.journals);
      const td = Object.values(b).reduce((s, x) => s + x.debit, 0), tc = Object.values(b).reduce((s, x) => s + x.credit, 0);
      expect(r2(td - tc)).toBe(0);
      // signed balances so that contra accounts (discounts, returns, drawings, absorbed cost) reduce their section
      const assets = sumNetDebit(d, b, (a) => a.type === 'asset' && a.posting), liab = -sumNetDebit(d, b, (a) => a.type === 'liability' && a.posting), eq = -sumNetDebit(d, b, (a) => a.type === 'equity' && a.posting);
      const earnings = -sumNetDebit(d, b, (a) => (a.type === 'revenue' || a.type === 'expense') && a.posting);
      expect(r2(assets - liab - eq - earnings)).toBeCloseTo(0, 2);
    });
  });
  it('cash-flow opening + movements = closing; transfers net to zero', () => {
    tx((d) => {
      postMovement(d, ctx, { kind: 'transfer', amount: 100, account: 'bank', toAccount: 'cash', date: ctx.now, memo: '' });
      const r = cashFlowReport(d, '2026-10-16', dayKey(ctx.now));
      expect(Math.abs(r.check)).toBeLessThan(0.01);
      expect(r.rows.filter((x) => x.cls === 'internal').every((x) => Math.abs(x.inflow - x.outflow) < 0.01)).toBe(true);
    });
  });
  it('inventory roll-forward ties to the GL', () => {
    tx((d) => { const r = inventoryRollforward(d, '2026-10-16', dayKey(ctx.now)); expect(Math.abs(r.check)).toBeLessThan(0.01); });
  });
  it('settlements: received = gross − fees ± variance, and the platform receivable clears', () => {
    tx((d) => {
      const os = settleable(d, 'SHOPEE').slice(0, 3);
      if (!os.length) return;
      const sid = createSettlement(d, ctx, { channel: 'SHOPEE', orderIds: os.map((o) => o.id) });
      const st = d.settlements.find((s) => s.id === sid)!;
      receiveSettlement(d, ctx, sid, st.net - 10);
      const s2 = d.settlements.find((s) => s.id === sid)!;
      expect(r2(s2.gross - s2.commission - s2.paymentFee - s2.shippingSubsidy)).toBe(s2.net);
      expect(s2.variance).toBe(-10);
      expect(reconciliationMatrix(d).find((r) => r.key === 'platform')!.status).toBe('ok');
      const row = settlementRecon(d).find((r) => r.channel === 'SHOPEE')!;
      expect(row.variance).toBeLessThan(0);
      expectIntegrity(d);
    });
  });
  it('estimated fees never produce a "Final" profit label until the settlement is received', () => {
    tx((d) => {
      const { orders } = computeEcon(d, {});
      const t = totalsOf(orders);
      expect(t.provisionalOrders).toBeGreaterThan(0);
      const pOrders = orders.filter((o) => o.platform);
      expect(pOrders.some((o) => !o.feesFinal)).toBe(true);
    });
  });
  it('P&L by dimension: branch-tagged postings add up to the all-branch figure', () => {
    tx((d) => {
      const all = balancesBetween(d.journals, '2026-10-16', dayKey(ctx.now));
      const parts = d.branches.map((b) => balancesBetween(d.journals, '2026-10-16', dayKey(ctx.now), { branchId: b.id }));
      const code = roleCode(d, 'sales')!;
      const sumParts = parts.reduce((s, p) => s + (p[code]?.credit ?? 0) - (p[code]?.debit ?? 0), 0);
      expect(r2(sumParts)).toBeCloseTo((all[code].credit - all[code].debit), 1);
    });
  });
  it('control accounts, headers and statement lines resolve through metadata, not codes', () => {
    tx((d) => {
      const b = balancesBetween(d.journals);
      expect(sumAccounts(d, b, isControl('inventory'))).toBeGreaterThan(0);
      expect(sumNetDebit(d, b, (a) => a.fsLine === 'cash')).toBeGreaterThan(0);
      expect(natBal(d.accounts.find((a) => a.code === '2100')!, b['2100'])).toBeGreaterThanOrEqual(0);
    });
  });
});
const _unused = [expect, base, at, throws];
void _unused;
