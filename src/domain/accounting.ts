import type { Account, DB, Journal, JournalLine, ProductKind, PayMethod, ID, Expense } from './types';
import { Ctx, audit, docNo, fail, nid } from './core';
import { dayKey, r2 } from '../lib/util';

export const CHART: Account[] = [
  { code: '1100', name: 'Cash on hand', type: 'asset', normal: 'debit', group: 'Cash & bank' },
  { code: '1110', name: 'Bank – operating account', type: 'asset', normal: 'debit', group: 'Cash & bank' },
  { code: '1120', name: 'Platform receivables (marketplace/delivery)', type: 'asset', normal: 'debit', group: 'Receivables' },
  { code: '1130', name: 'Accounts receivable – customers', type: 'asset', normal: 'debit', group: 'Receivables' },
  { code: '1140', name: 'Supplier deposits / prepayments', type: 'asset', normal: 'debit', group: 'Receivables' },
  { code: '1200', name: 'Inventory – raw materials & packaging', type: 'asset', normal: 'debit', group: 'Inventory' },
  { code: '1210', name: 'Inventory – merchandise & finished goods', type: 'asset', normal: 'debit', group: 'Inventory' },
  { code: '1250', name: 'Inventory in transit', type: 'asset', normal: 'debit', group: 'Inventory' },
  { code: '1300', name: 'Input VAT', type: 'asset', normal: 'debit', group: 'Tax' },
  { code: '2100', name: 'Accounts payable – suppliers', type: 'liability', normal: 'credit', group: 'Payables' },
  { code: '2200', name: 'Output VAT', type: 'liability', normal: 'credit', group: 'Tax' },
  { code: '2300', name: 'Customer credit & unapplied receipts', type: 'liability', normal: 'credit', group: 'Customer balances' },
  { code: '3000', name: "Owner's equity", type: 'equity', normal: 'credit', group: 'Equity' },
  { code: '3100', name: 'Retained earnings', type: 'equity', normal: 'credit', group: 'Equity' },
  { code: '4000', name: 'Sales revenue', type: 'revenue', normal: 'credit', group: 'Revenue' },
  { code: '4100', name: 'Sales discounts', type: 'revenue', normal: 'debit', group: 'Revenue', contra: true },
  { code: '4200', name: 'Sales returns & credit notes', type: 'revenue', normal: 'debit', group: 'Revenue', contra: true },
  { code: '5000', name: 'Cost of goods sold', type: 'expense', normal: 'debit', group: 'Cost of sales' },
  { code: '5100', name: 'Production waste & spoilage', type: 'expense', normal: 'debit', group: 'Cost of sales' },
  { code: '5200', name: 'Inventory adjustments & shrinkage', type: 'expense', normal: 'debit', group: 'Cost of sales' },
  { code: '5400', name: 'Labor & overhead absorbed (contra)', type: 'expense', normal: 'credit', group: 'Cost of sales', contra: true },
  { code: '6100', name: 'Marketplace commission', type: 'expense', normal: 'debit', group: 'Channel costs' },
  { code: '6110', name: 'Payment processing fees', type: 'expense', normal: 'debit', group: 'Channel costs' },
  { code: '6120', name: 'Shipping subsidy (seller-paid)', type: 'expense', normal: 'debit', group: 'Channel costs' },
  { code: '6130', name: 'Marketing & promotions', type: 'expense', normal: 'debit', group: 'Operating expenses' },
  { code: '6200', name: 'Rent', type: 'expense', normal: 'debit', group: 'Operating expenses' },
  { code: '6210', name: 'Utilities', type: 'expense', normal: 'debit', group: 'Operating expenses' },
  { code: '6220', name: 'Staff costs', type: 'expense', normal: 'debit', group: 'Operating expenses' },
  { code: '6300', name: 'Other operating expenses', type: 'expense', normal: 'debit', group: 'Operating expenses' },
  { code: '6400', name: 'Bank charges & settlement variance', type: 'expense', normal: 'debit', group: 'Operating expenses' },
];
export const EXPENSE_ACCOUNTS = ['6130', '6200', '6210', '6220', '6300', '6400'];

export const acctName = (d: DB, code: string) => d.accounts.find((a) => a.code === code)?.name ?? code;
export const invAccount = (kind: ProductKind) => (kind === 'material' || kind === 'packaging' ? '1200' : '1210');
export const cashAccount = (m: PayMethod | 'deposit') => (m === 'cash' ? '1100' : '1110');

export const dr = (account: string, amount: number, memo?: string): JournalLine => ({ account, debit: r2(amount), credit: 0, memo });
export const cr = (account: string, amount: number, memo?: string): JournalLine => ({ account, debit: 0, credit: r2(amount), memo });

export function isLocked(d: DB, date: string) {
  return !!d.meta.lockedUntil && dayKey(date) <= d.meta.lockedUntil;
}

export function post(
  d: DB, ctx: Ctx,
  p: { memo: string; refType: string; refId?: ID; lines: JournalLine[]; date?: string; manual?: boolean; reverses?: ID },
): ID | undefined {
  const lines = p.lines.filter((l) => Math.abs(l.debit) > 0.0049 || Math.abs(l.credit) > 0.0049);
  if (!lines.length) return undefined;
  for (const l of lines) if (!d.accounts.some((a) => a.code === l.account)) fail('BAD_ACCOUNT', `Unknown account ${l.account}`);
  let td = r2(lines.reduce((s, l) => s + l.debit, 0));
  let tc = r2(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(td - tc) > 0.011) fail('UNBALANCED', `Journal does not balance: debit ${td} ≠ credit ${tc} (${p.memo})`);
  if (td !== tc) {
    // sub-cent rounding between independently rounded lines: plug it into the largest line on the short side
    const diff = r2(td - tc);
    const side = diff > 0 ? 'credit' : 'debit';
    const target = lines.filter((l) => l[side] > 0).sort((a, b) => b[side] - a[side])[0];
    if (target) { target[side] = r2(target[side] + Math.abs(diff)); td = r2(lines.reduce((s, l) => s + l.debit, 0)); tc = r2(lines.reduce((s, l) => s + l.credit, 0)); }
  }
  const date = p.date ?? ctx.now;
  if (!ctx.seed && isLocked(d, date)) fail('PERIOD_LOCKED', `Accounting period is locked through ${d.meta.lockedUntil}. Reopen the period or post to a later date.`);
  const id = nid(d, 'JV');
  d.journals.push({
    id, no: docNo(d, 'JV'), date, memo: p.memo, refType: p.refType, refId: p.refId, lines, status: 'posted',
    createdBy: ctx.userId, manual: p.manual, reverses: p.reverses,
  });
  return id;
}

export function reverseJournal(d: DB, ctx: Ctx, journalId: ID, reason: string): ID {
  const j = d.journals.find((x) => x.id === journalId) || fail('NOT_FOUND', 'Journal not found');
  if (j.status === 'reversed') fail('ALREADY', 'Journal already reversed');
  if (j.reverses) fail('INVALID', 'A reversal entry cannot itself be reversed');
  const rid = post(d, ctx, {
    memo: `Reversal of ${j.no}: ${reason}`, refType: 'reversal', refId: j.id, reverses: j.id,
    lines: j.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, memo: l.memo })),
  })!;
  j.status = 'reversed';
  j.reversedBy = rid;
  audit(d, ctx, 'journal.reverse', 'journal', j.id, `Reversed ${j.no}: ${reason}`, 'warn');
  return rid;
}

export function postManualJournal(d: DB, ctx: Ctx, p: { date: string; memo: string; lines: JournalLine[] }): ID {
  const id = post(d, ctx, { ...p, refType: 'manual', manual: true });
  if (!id) fail('EMPTY', 'Journal has no lines');
  audit(d, ctx, 'journal.manual', 'journal', id, p.memo, 'warn');
  return id!;
}

export function closePeriod(d: DB, ctx: Ctx, throughDay: string) {
  if (d.meta.lockedUntil && throughDay < d.meta.lockedUntil) fail('INVALID', 'Use reopen to move the lock backwards');
  d.meta.lockedUntil = throughDay;
  audit(d, ctx, 'period.close', 'period', throughDay, `Accounting period locked through ${throughDay}`, 'critical');
}
export function reopenPeriod(d: DB, ctx: Ctx, throughDay: string | null, reason: string) {
  if (!reason.trim()) fail('REASON', 'A reason is required to reopen a period');
  d.meta.lockedUntil = throughDay;
  audit(d, ctx, 'period.reopen', 'period', throughDay ?? 'none', `Lock moved to ${throughDay ?? 'none'}: ${reason}`, 'critical');
}

export function addExpense(
  d: DB, ctx: Ctx,
  p: { date: string; account: string; vendor: string; amount: number; vat?: number; paidFrom: 'cash' | 'bank'; branchId?: ID; note?: string; mediaId?: ID },
): ID {
  if (!(p.amount > 0)) fail('INVALID', 'Amount must be greater than zero');
  const vat = r2(p.vat ?? 0);
  const net = r2(p.amount - vat);
  const id = nid(d, 'EX');
  const jid = post(d, ctx, {
    date: p.date, memo: `Expense: ${p.vendor}`, refType: 'expense', refId: id,
    lines: [dr(p.account, net), dr('1300', vat), cr(p.paidFrom === 'cash' ? '1100' : '1110', p.amount)],
  });
  const e: Expense = { id, no: docNo(d, 'EXP'), date: p.date, account: p.account, vendor: p.vendor, amount: p.amount, vat, paidFrom: p.paidFrom, branchId: p.branchId, note: p.note, journalId: jid, mediaId: p.mediaId };
  d.expenses.push(e);
  return id;
}

// ---------- reporting helpers (pure, take a journal list)
export interface Bal { debit: number; credit: number }
export function balancesBetween(journals: Journal[], fromDay?: string, toDay?: string): Record<string, Bal> {
  const out: Record<string, Bal> = {};
  for (const j of journals) {
    const k = dayKey(j.date);
    if (fromDay && k < fromDay) continue;
    if (toDay && k > toDay) continue;
    for (const l of j.lines) {
      const b = (out[l.account] ||= { debit: 0, credit: 0 });
      b.debit += l.debit;
      b.credit += l.credit;
    }
  }
  return out;
}
/** signed balance in the account's normal direction */
export function natBal(acc: Account, b?: Bal): number {
  if (!b) return 0;
  return r2(acc.normal === 'debit' ? b.debit - b.credit : b.credit - b.debit);
}
export function netDebit(b?: Bal): number {
  return b ? r2(b.debit - b.credit) : 0;
}
