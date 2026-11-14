// Posting of the central finance queue (wallet deposits, wallet payments, bank receipts, refunds, adjustments, invoices) to the
// general ledger that lives on this device. Same pattern as daily expenses: the central database writes a queue row in the same
// transaction as the money event; the accountant's device turns it into a journal with the EXISTING posting engine (roles bank / ar /
// customer_credit / sales / output_vat, account validation, period lock) and confirms the journal number back, so that a unique
// reference makes a double posting impossible from either side. Re-posting the same row here returns the journal that is already there.
import { r2 } from '../lib/util';
import { findAcct, isLocked, post, resolveLine, ROLE_KEYS } from './accounting';
import { audit, Ctx, fail, guard } from './core';
import type { DB, ID, JournalLine } from './types';

export interface FinancePlanLine { side: 'dr' | 'cr'; role: string; amount: number; bank_account_id?: string; wallet?: boolean; vat?: 'split' }
export interface FinanceQueueRow {
  id: string; event_type: string; ref_no: string | null; event_date: string; amount: number; plan: FinancePlanLine[];
  banks?: Record<string, { code: string; gl_account_code: string | null }>;
}
export interface FinancePostSettings { invoice_vat_mode: 'unset' | 'none' | 'inclusive'; vat_rate: number }
export const FINANCE_REF_TYPE = 'finance_event';

const MEMO: Record<string, string> = {
  INVOICE_ISSUE: 'Invoice issued', INVOICE_CANCEL: 'Invoice cancelled', BANK_RECEIPT: 'Bank transfer received', RECEIPT_REAPPLY: 'Customer credit applied to invoice',
  RECEIPT_REVERSAL: 'Receipt reversed', WALLET_DEPOSIT: 'Wallet deposit', WALLET_PAYMENT: 'Invoice paid from wallet', WALLET_REFUND: 'Refund to wallet',
  WALLET_ADJUSTMENT: 'Wallet adjustment', WALLET_REVERSAL: 'Wallet transaction reversed',
};
export const eventLabel = (t: string) => MEMO[t] ?? t;

export interface FinancePlan { ok: boolean; errors: string[]; lines: JournalLine[]; date: string; memo: string }

/** The journal a queue row would produce on this device, or why it cannot be posted yet. Pure: it changes nothing. */
export function planFinanceRow(d: DB, row: FinanceQueueRow, s: FinancePostSettings, opts: { date?: string } = {}): FinancePlan {
  const date = opts.date ?? row.event_date;
  const errors: string[] = [];
  const lines: JournalLine[] = [];
  const add = (side: 'dr' | 'cr', account: string, amount: number) => {
    if (!(amount > 0)) return;
    lines.push(side === 'dr' ? { account, debit: r2(amount), credit: 0 } : { account, debit: 0, credit: r2(amount) });
  };
  for (const l of row.plan) {
    if (!(l.amount > 0)) { errors.push('A line of this entry has no amount.'); continue; }
    if (l.role === 'bank') {
      add(l.side, (l.bank_account_id && row.banks?.[l.bank_account_id]?.gl_account_code) || 'bank', l.amount);   // that bank's own GL account, else the ledger's bank role
    } else if (l.vat === 'split') {
      if (s.invoice_vat_mode === 'unset') { errors.push('Choose how invoices are taxed (Payments & wallet → Accounting ledger → Accounting settings) before invoices are posted.'); continue; }
      if (s.invoice_vat_mode === 'none') add(l.side, l.role, l.amount);
      else {
        const net = r2(l.amount / (1 + s.vat_rate / 100));
        add(l.side, l.role, net); add(l.side, 'output_vat', r2(l.amount - net));   // price includes VAT: sales at the net amount, the rest is output VAT
      }
    } else if (ROLE_KEYS.has(l.role) || /^[0-9]{3,8}$/.test(l.role)) {
      add(l.side, l.role, l.amount);
    } else errors.push(`Unknown account role “${l.role}”.`);
  }
  const td = r2(lines.reduce((x, l) => x + l.debit, 0)), tc = r2(lines.reduce((x, l) => x + l.credit, 0));
  if (lines.length && !errors.length && td !== tc) errors.push(`The entry does not balance (debit ${td}, credit ${tc}).`);
  if (isLocked(d, date)) errors.push(`The accounting period is locked through ${d.meta.lockedUntil}: reopen it or choose a later posting date.`);
  for (const l of lines) {
    try { resolveLine(d, l.account, date); } catch (e) { const m = (e as Error).message; if (!errors.includes(m)) errors.push(m); }
  }
  if (!lines.length && !errors.length) errors.push('This entry has no lines.');
  return { ok: !errors.length, errors, lines, date, memo: `${eventLabel(row.event_type)} ${row.ref_no ?? ''}`.trim() };
}

export const financeJournal = (d: DB, rowId: ID) => d.journals.find((j) => j.refType === FINANCE_REF_TYPE && j.refId === rowId);

/** Post one queue row. Idempotent: a row that already has its journal on this device returns that journal (nothing new is posted). */
export function postFinanceRow(d: DB, ctx: Ctx, row: FinanceQueueRow, s: FinancePostSettings, opts: { date?: string } = {}): { journalId: ID; journalNo: string; date: string; already: boolean } {
  guard(d, ctx, 'accounting:create');
  const have = financeJournal(d, row.id);
  if (have) return { journalId: have.id, journalNo: have.no, date: have.date, already: true };
  const plan = planFinanceRow(d, row, s, opts);
  if (!plan.ok) fail('FINANCE_NOT_POSTABLE', plan.errors[0]);
  const jid = post(d, ctx, { date: plan.date, memo: plan.memo, refType: FINANCE_REF_TYPE, refId: row.id, lines: plan.lines });
  if (!jid) fail('EMPTY', 'The journal has no lines');
  const j = d.journals.find((x) => x.id === jid)!;
  audit(d, ctx, 'finance.post', 'journal', jid!, `${plan.memo} (${r2(row.amount)}) posted as ${j.no}`, 'info');
  return { journalId: jid!, journalNo: j.no, date: plan.date, already: false };
}

/** Of the rows the database says are posted: which have their journal on THIS device, and do the amounts agree? */
export function verifyPosted(d: DB, rows: { id: string; amount: number; journal_no: string | null; event_type: string }[]): { here: number; elsewhere: number; mismatched: { id: string; journal_no: string | null; why: string }[] } {
  let here = 0, elsewhere = 0; const mismatched: { id: string; journal_no: string | null; why: string }[] = [];
  for (const r of rows) {
    const j = financeJournal(d, r.id);
    if (!j) { elsewhere++; continue; }
    here++;
    if (j.no !== r.journal_no) mismatched.push({ id: r.id, journal_no: r.journal_no, why: `journal number differs (${j.no})` });
    const debit = r2(j.lines.reduce((x, l) => x + l.debit, 0));
    if (r.event_type !== 'INVOICE_ISSUE' && r.event_type !== 'INVOICE_CANCEL' && debit !== r2(r.amount)) mismatched.push({ id: r.id, journal_no: j.no, why: `amount ${debit} differs from ${r2(r.amount)}` });
  }
  return { here, elsewhere, mismatched };
}

/** Net credit on an account from finance journals (e.g. the customer-credit liability) as posted on this device. */
export function financeNetCredit(d: DB, account: string): number {
  return r2(d.journals.filter((j) => j.refType === FINANCE_REF_TYPE && j.status !== 'reversed')
    .reduce((s, j) => s + j.lines.filter((l) => l.account === account).reduce((x, l) => x + l.credit - l.debit, 0), 0));
}
export const accountName = (d: DB, code: string) => findAcct(d, code)?.name ?? code;
