// Daily / monthly expense reports. Every number is derived from posted journals in the general ledger: there is no separate
// total that could drift away from the books. Reversed postings drop out automatically (the original is marked reversed).
import type { DB, Journal } from './types';
import { roleCode } from './accounting';
import { dayKey, r2 } from '../lib/util';

export interface ExpenseRow {
  journal: Journal; source: 'claim' | 'legacy';
  /** expense (or fixed-asset) amount recognised, before claimable VAT */
  amount: number; vat: number; wht: number; cashOut: number; bankOut: number; paid: number;
  categoryKey: string; categoryEn: string; categoryTh: string; accounts: { code: string; amount: number }[];
  transactionDate: string; postingDate: string; approvedAt?: string; claimNo?: string; vendor?: string;
}
const EXPENSE_LINES = ['opex', 'other_expense', 'channel_costs', 'fixed_assets'];

/** One row per posted (not reversed) expense journal dated within [from, to] (yyyy-mm-dd). */
export function expenseRows(d: DB, from: string, to: string): ExpenseRow[] {
  const acct = new Map(d.accounts.map((a) => [a.code, a]));
  const out: ExpenseRow[] = [];
  for (const j of d.journals) {
    if ((j.refType !== 'expense_claim' && j.refType !== 'expense') || j.status !== 'posted' || j.reverses) continue;
    const day = dayKey(j.date);
    if (day < from || day > to) continue;
    const cashCode = roleCode(d, 'cash', j.date), inputVat = roleCode(d, 'input_vat', j.date);
    let amount = 0, vat = 0, cashOut = 0, bankOut = 0;
    const accounts: Record<string, number> = {};
    for (const l of j.lines) {
      const a = acct.get(l.account);
      if (!a) continue;
      if (EXPENSE_LINES.includes(a.fsLine)) { const v = r2(l.debit - l.credit); amount += v; accounts[a.code] = r2((accounts[a.code] ?? 0) + v); }
      else if (l.account === inputVat) vat += l.debit - l.credit;
      else if (a.fsLine === 'cash') { const o = r2(l.credit - l.debit); if (l.account === cashCode) cashOut += o; else bankOut += o; }
    }
    const info = j.info;
    const first = Object.keys(accounts)[0];
    const fa = first ? acct.get(first) : undefined;
    out.push({
      journal: j, source: j.refType === 'expense_claim' ? 'claim' : 'legacy', amount: r2(amount), vat: r2(vat), wht: r2(info?.wht ?? 0), cashOut: r2(cashOut), bankOut: r2(bankOut), paid: r2(cashOut + bankOut),
      categoryKey: info?.categoryCode ?? `account:${first ?? '?'}`, categoryEn: info?.categoryNameEn ?? fa?.name ?? '—', categoryTh: info?.categoryNameTh ?? fa?.nameTh ?? '—',
      accounts: Object.entries(accounts).map(([code, amt]) => ({ code, amount: amt })), transactionDate: info?.expenseDate ?? day, postingDate: day, approvedAt: info?.approvedAt, claimNo: info?.claimNo, vendor: info?.vendor,
    });
  }
  return out.sort((a, b) => a.journal.date.localeCompare(b.journal.date));
}

export interface DayRow { date: string; n: number; amount: number; vat: number; wht: number; cashOut: number; bankOut: number; paid: number }
const zero = (): Omit<DayRow, 'date'> => ({ n: 0, amount: 0, vat: 0, wht: 0, cashOut: 0, bankOut: 0, paid: 0 });
const add = (t: Omit<DayRow, 'date'>, r: ExpenseRow) => { t.n++; t.amount = r2(t.amount + r.amount); t.vat = r2(t.vat + r.vat); t.wht = r2(t.wht + r.wht); t.cashOut = r2(t.cashOut + r.cashOut); t.bankOut = r2(t.bankOut + r.bankOut); t.paid = r2(t.paid + r.paid); };

export function dailySummary(rows: ExpenseRow[]): DayRow[] {
  const m: Record<string, Omit<DayRow, 'date'>> = {};
  for (const r of rows) add((m[r.postingDate] ||= zero()), r);
  return Object.entries(m).sort((a, b) => b[0].localeCompare(a[0])).map(([date, t]) => ({ date, ...t }));
}
export function totalsOf(rows: ExpenseRow[]): Omit<DayRow, 'date'> { const t = zero(); for (const r of rows) add(t, r); return t; }

export function byCategory(rows: ExpenseRow[]) {
  const m: Record<string, { key: string; en: string; th: string; n: number; amount: number }> = {};
  for (const r of rows) { const x = (m[r.categoryKey] ||= { key: r.categoryKey, en: r.categoryEn, th: r.categoryTh, n: 0, amount: 0 }); x.n++; x.amount = r2(x.amount + r.amount); }
  return Object.values(m).sort((a, b) => b.amount - a.amount);
}
export function byAccount(rows: ExpenseRow[]) {
  const m: Record<string, number> = {};
  for (const r of rows) for (const a of r.accounts) m[a.code] = r2((m[a.code] ?? 0) + a.amount);
  return Object.entries(m).map(([code, amount]) => ({ code, amount })).sort((a, b) => b.amount - a.amount);
}
/** Totals per calendar month for the `months` months ending with the month of `to`, with the change against the previous month. */
export function monthlyComparison(d: DB, to: string, months = 6) {
  const end = new Date(`${to}T00:00:00`);
  const list: { month: string; n: number; amount: number; paid: number; change: number | null }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const first = new Date(end.getFullYear(), end.getMonth() - i, 1), last = new Date(end.getFullYear(), end.getMonth() - i + 1, 0);
    const t = totalsOf(expenseRows(d, dayKey(first), dayKey(last)));
    list.push({ month: dayKey(first).slice(0, 7), n: t.n, amount: t.amount, paid: t.paid, change: null });
  }
  for (let i = 1; i < list.length; i++) list[i].change = list[i - 1].amount > 0 ? r2(((list[i].amount - list[i - 1].amount) / list[i - 1].amount) * 100) : null;
  return list;
}

export interface WorkflowClaim { id: string; expense_no: string | null; amount_paid: number; wht_amount: number; journal_no: string | null; status: string }
/** Compare the workflow database (claims marked posted) with this ledger: every posted claim must have exactly one matching journal. */
export function reconcileClaims(d: DB, claims: WorkflowClaim[]) {
  const issues: { id: string; no: string; problem: 'missing' | 'amount' | 'journal'; detail: string }[] = [];
  let workflow = 0, ledger = 0;
  for (const c of claims) {
    if (c.status !== 'posted') continue;
    const js = d.journals.filter((j) => j.refType === 'expense_claim' && j.refId === c.id && j.status === 'posted' && !j.reverses);
    workflow += Number(c.amount_paid);
    if (js.length !== 1) { issues.push({ id: c.id, no: c.expense_no ?? c.id, problem: 'missing', detail: js.length === 0 ? 'No journal in this ledger' : `${js.length} journals in this ledger` }); continue; }
    const j = js[0], debit = r2(j.lines.reduce((s, l) => s + l.debit, 0));
    ledger += debit;
    if (Math.abs(debit - Number(c.amount_paid)) > 0.005) issues.push({ id: c.id, no: c.expense_no ?? c.id, problem: 'amount', detail: `Claim ${c.amount_paid} vs journal ${debit}` });
    if (c.journal_no && c.journal_no !== j.no) issues.push({ id: c.id, no: c.expense_no ?? c.id, problem: 'journal', detail: `Claim says ${c.journal_no}, ledger has ${j.no}` });
  }
  // journals of claims that the workflow does not know as posted (e.g. posted here, status update failed or claim reversed elsewhere)
  const known = new Set(claims.filter((c) => c.status === 'posted').map((c) => c.id));
  const orphans = d.journals.filter((j) => j.refType === 'expense_claim' && j.status === 'posted' && !j.reverses && j.refId && !known.has(j.refId));
  return { issues, workflow: r2(workflow), ledger: r2(ledger), diff: r2(workflow - ledger), orphans: orphans.map((j) => ({ no: j.no, claim: j.info?.claimNo ?? j.refId ?? '' })) };
}
