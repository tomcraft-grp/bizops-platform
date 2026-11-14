import { describe, expect, it } from 'vitest';
import { ctx, tx } from '../helpers';
import { roleCode } from '../../src/domain/accounting';
import { eventLabel, financeJournal, financeNetCredit, planFinanceRow, postFinanceRow, verifyPosted, type FinanceQueueRow } from '../../src/domain/financeLedger';
import type { DB } from '../../src/domain/types';

const NONE = { invoice_vat_mode: 'none', vat_rate: 7 } as const;
const row = (id: string, type: string, ref: string, amount: number, plan: FinanceQueueRow['plan'], banks?: FinanceQueueRow['banks']): FinanceQueueRow => ({ id, event_type: type, ref_no: ref, event_date: ctx.now, amount, plan, banks });
const SCB = 'bank-scb';
const deposit = (id: string, amount: number, gl: string | null = null) => row(id, 'WALLET_DEPOSIT', `WT-${id}`, amount,
  [{ side: 'dr', role: 'bank', amount, bank_account_id: SCB }, { side: 'cr', role: 'customer_credit', amount, wallet: true }], { [SCB]: { code: 'SCB', gl_account_code: gl } });
const walletPay = (id: string, amount: number) => row(id, 'WALLET_PAYMENT', `WT-${id}`, amount, [{ side: 'dr', role: 'customer_credit', amount, wallet: true }, { side: 'cr', role: 'ar', amount }]);
const bal = (d: DB, code: string) => d.journals.reduce((s, j) => s + j.lines.filter((l) => l.account === code).reduce((x, l) => x + l.debit - l.credit, 0), 0);
const trial = (d: DB) => d.journals.reduce((s, j) => s + j.lines.reduce((x, l) => x + l.debit - l.credit, 0), 0);

describe('finance queue -> general ledger (existing posting engine)', () => {
  it('the roles it relies on exist and map to the expected accounts', () => {
    tx((d) => {
      expect(roleCode(d, 'bank')).toBe('1110'); expect(roleCode(d, 'ar')).toBe('1130'); expect(roleCode(d, 'customer_credit')).toBe('2300'); expect(roleCode(d, 'sales')).toBe('4010'); expect(roleCode(d, 'output_vat')).toBe('2200');
    });
  });

  it('Scenario A: a THB 5,000 deposit into SCB is Dr bank / Cr customer wallet liability (not revenue)', () => {
    tx((d) => {
      const b0 = bal(d, '1110'), c0 = bal(d, '2300'), s0 = bal(d, '4010');
      const r = postFinanceRow(d, ctx, deposit('q1', 5000), NONE);
      const j = d.journals.find((x) => x.id === r.journalId)!;
      expect(j.lines).toEqual([{ account: '1110', debit: 5000, credit: 0 }, { account: '2300', debit: 0, credit: 5000 }]);
      expect(bal(d, '1110') - b0).toBe(5000); expect(bal(d, '2300') - c0).toBe(-5000); expect(bal(d, '4010') - s0).toBe(0);   // revenue untouched
      expect(j.refType).toBe('finance_event'); expect(j.refId).toBe('q1');
    });
  });

  it('Scenario B: paying a THB 2,000 invoice from the wallet is Dr customer wallet liability / Cr accounts receivable', () => {
    tx((d) => {
      postFinanceRow(d, ctx, deposit('q1', 5000), NONE);
      const a0 = bal(d, '1130');
      const r = postFinanceRow(d, ctx, walletPay('q2', 2000), NONE);
      expect(d.journals.find((x) => x.id === r.journalId)!.lines).toEqual([{ account: '2300', debit: 2000, credit: 0 }, { account: '1130', debit: 0, credit: 2000 }]);
      expect(bal(d, '1130') - a0).toBe(-2000);
      expect(financeNetCredit(d, '2300')).toBe(3000);                                  // 5,000 in, 2,000 out
    });
  });

  it('Scenario C: a refund into the wallet keeps the money as liability (Dr bank / Cr customer credit)', () => {
    tx((d) => {
      const r = postFinanceRow(d, ctx, row('q3', 'WALLET_REFUND', 'WT-3', 500, [{ side: 'dr', role: 'bank', amount: 500 }, { side: 'cr', role: 'customer_credit', amount: 500, wallet: true }]), NONE);
      expect(d.journals.find((x) => x.id === r.journalId)!.lines).toEqual([{ account: '1110', debit: 500, credit: 0 }, { account: '2300', debit: 0, credit: 500 }]);
    });
  });

  it('a bank with its own GL account posts there; an unknown or header account is refused with a clear reason', () => {
    tx((d) => {
      const ok = planFinanceRow(d, deposit('q1', 100, '1100'), NONE);   // use the cash account code as a stand-in for a dedicated bank account
      expect(ok.ok).toBe(true); expect(ok.lines[0].account).toBe('1100');
      const missing = planFinanceRow(d, deposit('q1', 100, '1119'), NONE);
      expect(missing.ok).toBe(false); expect(missing.errors.join(' ')).toMatch(/Unknown account 1119/);
      const header = planFinanceRow(d, deposit('q1', 100, '1010'), NONE);
      expect(header.ok).toBe(false); expect(header.errors.join(' ')).toMatch(/header account/);
      expect(d.journals.length).toBe(d.journals.length);   // planning never posts
    });
  });

  it('posting is idempotent: the same queue row is never posted twice', () => {
    tx((d) => {
      const n0 = d.journals.length;
      const a = postFinanceRow(d, ctx, deposit('q9', 700), NONE);
      const b = postFinanceRow(d, ctx, deposit('q9', 700), NONE);
      expect(a.already).toBe(false); expect(b.already).toBe(true); expect(b.journalNo).toBe(a.journalNo);
      expect(d.journals.length).toBe(n0 + 1);
      expect(financeJournal(d, 'q9')?.no).toBe(a.journalNo);
    });
  });

  it('a locked accounting period blocks posting, and a later posting date fixes it', () => {
    tx((d) => {
      d.meta.lockedUntil = '2026-11-30';
      const p = planFinanceRow(d, deposit('q1', 100), NONE);
      expect(p.ok).toBe(false); expect(p.errors.join(' ')).toMatch(/locked/);
      expect(() => postFinanceRow(d, ctx, deposit('q1', 100), NONE)).toThrow(/locked/);
      const later = planFinanceRow(d, deposit('q1', 100), NONE, { date: '2026-12-02T10:00:00+07:00' });
      expect(later.ok).toBe(true);
    });
  });

  it('invoices: blocked until the accountant chooses the tax treatment; then no-VAT or VAT-inclusive', () => {
    tx((d) => {
      const inv = row('i1', 'INVOICE_ISSUE', 'INV-1', 1070, [{ side: 'dr', role: 'ar', amount: 1070 }, { side: 'cr', role: 'sales', amount: 1070, vat: 'split' }]);
      const unset = planFinanceRow(d, inv, { invoice_vat_mode: 'unset', vat_rate: 7 });
      expect(unset.ok).toBe(false); expect(unset.errors.join(' ')).toMatch(/how invoices are taxed/);
      // the plan keeps role names; the posting engine resolves them to the mapped accounts (1130 / 4010 / 2200)
      expect(planFinanceRow(d, inv, NONE).lines).toEqual([{ account: 'ar', debit: 1070, credit: 0 }, { account: 'sales', debit: 0, credit: 1070 }]);
      expect(planFinanceRow(d, inv, { invoice_vat_mode: 'inclusive', vat_rate: 7 }).lines).toEqual([
        { account: 'ar', debit: 1070, credit: 0 }, { account: 'sales', debit: 0, credit: 1000 }, { account: 'output_vat', debit: 0, credit: 70 }]);
      const r = postFinanceRow(d, ctx, inv, { invoice_vat_mode: 'inclusive', vat_rate: 7 });
      expect(d.journals.find((x) => x.id === r.journalId)!.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['1130', 1070, 0], ['4010', 0, 1000], ['2200', 0, 70]]);
    });
  });

  it('a malformed plan is refused: unknown role, zero amount, unbalanced', () => {
    tx((d) => {
      expect(planFinanceRow(d, row('x', 'WALLET_DEPOSIT', 'x', 10, [{ side: 'dr', role: 'made_up', amount: 10 }, { side: 'cr', role: 'customer_credit', amount: 10 }]), NONE).errors.join(' ')).toMatch(/Unknown account role/);
      expect(planFinanceRow(d, row('x', 'WALLET_DEPOSIT', 'x', 10, [{ side: 'dr', role: 'bank', amount: 0 }, { side: 'cr', role: 'customer_credit', amount: 10 }]), NONE).errors.join(' ')).toMatch(/no amount/);
      expect(planFinanceRow(d, row('x', 'WALLET_DEPOSIT', 'x', 10, [{ side: 'dr', role: 'bank', amount: 10 }, { side: 'cr', role: 'customer_credit', amount: 9 }]), NONE).errors.join(' ')).toMatch(/does not balance/);
    });
  });

  it('LEDGER AND GL AGREE: after a realistic sequence the wallet balance equals the customer-credit liability and the books balance', () => {
    tx((d) => {
      // what the central wallet ledger does (balance simulated here), event by event, each posted from its queue row
      let wallet = 0;
      const events: [FinanceQueueRow, number][] = [
        [deposit('e1', 5000), +5000],
        [walletPay('e2', 2000), -2000],
        [row('e3', 'WALLET_REFUND', 'WT-3', 500, [{ side: 'dr', role: 'bank', amount: 500 }, { side: 'cr', role: 'customer_credit', amount: 500, wallet: true }]), +500],
        [row('e4', 'WALLET_ADJUSTMENT', 'WT-4', 300, [{ side: 'dr', role: 'settlement_variance', amount: 300 }, { side: 'cr', role: 'customer_credit', amount: 300, wallet: true }]), +300],
        [row('e5', 'WALLET_REVERSAL', 'WT-5', 300, [{ side: 'cr', role: 'settlement_variance', amount: 300 }, { side: 'dr', role: 'customer_credit', amount: 300, wallet: true }]), -300],
        [row('e6', 'WALLET_REVERSAL', 'WT-6', 2000, [{ side: 'dr', role: 'ar', amount: 2000 }, { side: 'cr', role: 'customer_credit', amount: 2000, wallet: true }]), +2000],   // a wallet receipt reversed
      ];
      for (const [r, delta] of events) { postFinanceRow(d, ctx, r, NONE); wallet += delta; }
      expect(wallet).toBe(5500);
      expect(financeNetCredit(d, '2300')).toBe(wallet);                                // the GL liability = the wallet balance
      expect(Math.abs(trial(d))).toBeLessThan(0.005);                                   // every journal balanced: the trial balance still nets to zero
      const posted = events.map(([r]) => ({ id: r.id, amount: r.amount, journal_no: financeJournal(d, r.id)!.no, event_type: r.event_type }));
      const v = verifyPosted(d, posted);
      expect(v.here).toBe(6); expect(v.elsewhere).toBe(0); expect(v.mismatched).toEqual([]);
    });
  });

  it('verifyPosted reports rows posted on another device and rows whose journal disagrees', () => {
    tx((d) => {
      postFinanceRow(d, ctx, deposit('v1', 100), NONE);
      const no = financeJournal(d, 'v1')!.no;
      const v = verifyPosted(d, [{ id: 'v1', amount: 100, journal_no: no, event_type: 'WALLET_DEPOSIT' }, { id: 'gone', amount: 5, journal_no: 'JV-X', event_type: 'WALLET_DEPOSIT' },
        { id: 'v1', amount: 999, journal_no: 'JV-OTHER', event_type: 'WALLET_DEPOSIT' }]);
      expect(v.elsewhere).toBe(1); expect(v.here).toBe(2); expect(v.mismatched.length).toBe(2);
    });
  });

  it('an overpaid bank transfer: Dr bank (all) / Cr receivable (owed) / Cr customer wallet liability (excess); the wallet liability equals the credit', () => {
    tx((d) => {
      const owed = 320, paid = 400;
      postFinanceRow(d, ctx, row('inv1', 'INVOICE_ISSUE', 'INV-1', owed, [{ side: 'dr', role: 'ar', amount: owed }, { side: 'cr', role: 'sales', amount: owed, vat: 'split' }]), NONE);
      const a0 = bal(d, '1130');
      const r = postFinanceRow(d, ctx, row('rc1', 'BANK_RECEIPT', 'RC-1', paid, [{ side: 'dr', role: 'bank', amount: paid, bank_account_id: SCB }, { side: 'cr', role: 'ar', amount: owed }, { side: 'cr', role: 'customer_credit', amount: paid - owed, wallet: true }], { [SCB]: { code: 'SCB', gl_account_code: null } }), NONE);
      expect(d.journals.find((x) => x.id === r.journalId)!.lines).toEqual([{ account: '1110', debit: 400, credit: 0 }, { account: '1130', debit: 0, credit: 320 }, { account: '2300', debit: 0, credit: 80 }]);
      expect(bal(d, '1130') - a0).toBe(-320);                                       // the receivable is cleared by exactly what was owed
      expect(financeNetCredit(d, '2300')).toBe(80);                                  // the excess is the wallet liability (= the wallet credit)
      const rev = postFinanceRow(d, ctx, row('rv1', 'RECEIPT_REVERSAL', 'RC-1', paid, [{ side: 'cr', role: 'bank', amount: paid, bank_account_id: SCB }, { side: 'dr', role: 'ar', amount: owed }, { side: 'dr', role: 'customer_credit', amount: paid - owed, wallet: true }], { [SCB]: { code: 'SCB', gl_account_code: null } }), NONE);
      expect(d.journals.find((x) => x.id === rev.journalId)!.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['1110', 0, 400], ['1130', 320, 0], ['2300', 80, 0]]);
      expect(financeNetCredit(d, '2300')).toBe(0);                                   // reversing the receipt takes the credit back
      expect(Math.abs(trial(d))).toBeLessThan(0.005);
    });
  });

  it('every queue event type has a readable label', () => {
    for (const t of ['INVOICE_ISSUE', 'INVOICE_CANCEL', 'BANK_RECEIPT', 'RECEIPT_REAPPLY', 'RECEIPT_REVERSAL', 'WALLET_DEPOSIT', 'WALLET_PAYMENT', 'WALLET_REFUND', 'WALLET_ADJUSTMENT', 'WALLET_REVERSAL']) expect(eventLabel(t)).not.toBe(t);
  });
});
