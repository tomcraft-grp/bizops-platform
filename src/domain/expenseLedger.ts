// Posting an approved daily-expense claim to the general ledger.
//
// The workflow (draft → approval → review) lives in the central database (supabase/migrations/*_daily_expenses.sql); the
// ledger lives on the accounting device. This file is the bridge: it validates a claim against the REAL chart of accounts,
// builds the journal with double-entry rules, and posts it. Nothing here knows a hard-coded account code: the expense
// account comes from the category mapping, VAT / cash / bank come from the approved posting-role mapping, and the
// withholding-tax and fixed-asset accounts come from the expense settings.
import type { DB, ID, Journal, JournalLine } from './types';
import { Ctx, audit, fail, guard, nid } from './core';
import { cr, dr, findAcct, isLocked, post, reverseJournal, roleCode, taxAt } from './accounting';
import { dayKey, r2 } from '../lib/util';

export type TaxType = 'none' | 'vat_included' | 'vat_excluded' | 'vat_noncreditable';
export type Treatment = 'expense' | 'fixed_asset';

/** What the central database stores for a claim, as the ledger needs it. Amounts are in baht. */
export interface ClaimForPosting {
  id: string; expenseNo: string; expenseDate: string; postingDate?: string | null; description: string; vendor?: string | null; vendorTaxId?: string | null;
  amountPaid: number; vatAmount: number; taxType: TaxType; whtAmount: number; paidFrom: 'cash' | 'bank'; paymentMethod: string; treatment: Treatment;
  categoryCode: string; categoryNameEn: string; categoryNameTh: string; accountCode: string | null; accountOverride?: string | null;
  branchId?: string | null; reviewed: boolean; attachmentCount?: number; approvedAt?: string | null;
}
/** Account codes configured centrally (expense settings). The ledger still validates each one against its own chart. */
export interface ExpenseConfig { whtAccount: string; fixedAssetAccount: string; fixedAssetWarnAmount: number }

export interface PlanIssue { code: string; msg: string }
export interface PostingPlan { ok: boolean; errors: PlanIssue[]; warnings: PlanIssue[]; lines: JournalLine[]; date: string; debitAccount?: string }

/** Same arithmetic as the database function expense_calc: amount as typed + VAT mode → money out and VAT. */
export function calcExpenseTax(amount: number, taxType: TaxType, rate: number): { paid: number; vat: number } {
  if (taxType === 'none') return { paid: r2(amount), vat: 0 };
  if (taxType === 'vat_excluded') { const vat = r2(amount * rate); return { paid: r2(amount + vat), vat }; }
  return { paid: r2(amount), vat: r2((amount * rate) / (1 + rate)) };
}

const noonOf = (day: string) => new Date(`${day}T12:00:00`).toISOString();
export const claimRefType = 'expense_claim';
export const claimJournal = (d: DB, claimId: ID): Journal | undefined => d.journals.find((j) => j.refType === claimRefType && j.refId === claimId && j.status !== 'reversed' && !j.reverses);

/** Is this code a valid destination for the given accounting treatment on the given day? Returns the problem, or null. */
export function accountProblem(d: DB, treatment: Treatment, code: string | null | undefined, day: string): PlanIssue | null {
  if (!code) return { code: 'MISSING_MAPPING', msg: 'This category is not mapped to an account yet. An accountant must map it before it can be posted.' };
  const a = findAcct(d, code);
  if (!a) return { code: 'UNKNOWN_ACCOUNT', msg: `Account ${code} does not exist in the chart of accounts.` };
  if (!a.posting) return { code: 'HEADER_ACCOUNT', msg: `${a.code} ${a.name} is a header account and cannot accept postings.` };
  if (!a.active || (a.inactiveFrom && dayKey(a.inactiveFrom) <= day)) return { code: 'INACTIVE_ACCOUNT', msg: `${a.code} ${a.name} is inactive.` };
  if (dayKey(a.effectiveFrom) > day) return { code: 'INACTIVE_ACCOUNT', msg: `${a.code} ${a.name} is not effective until ${dayKey(a.effectiveFrom)}.` };
  if (a.control || a.system) return { code: 'CONTROL_ACCOUNT', msg: `${a.code} ${a.name} is a system / control account and cannot be used for expenses.` };
  if (treatment === 'fixed_asset') {
    if (a.type !== 'asset' || a.fsLine !== 'fixed_assets' || a.contra) return { code: 'WRONG_CLASS', msg: `${a.code} ${a.name} is not a fixed-asset account (an asset purchase must go to a fixed-asset account).` };
  } else if (a.type !== 'expense' || !['opex', 'other_expense', 'channel_costs'].includes(a.fsLine) || a.contra) {
    return { code: 'WRONG_CLASS', msg: `${a.code} ${a.name} is not an operating-expense account.` };
  }
  return null;
}

/** Everything the accountant needs to see before posting: the journal that WOULD be posted, blocking errors and soft warnings. */
export function planExpensePosting(d: DB, claim: ClaimForPosting, cfg: ExpenseConfig): PostingPlan {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const day = claim.postingDate || claim.expenseDate;
  const E = (code: string, msg: string) => errors.push({ code, msg });
  const W = (code: string, msg: string) => warnings.push({ code, msg });
  const paid = r2(claim.amountPaid), vat = r2(claim.vatAmount), wht = r2(claim.whtAmount);

  if (!claim.reviewed) E('NOT_REVIEWED', 'The accountant must confirm the tax treatment (review) before posting.');
  if (!(paid > 0)) E('BAD_AMOUNT', 'The amount must be greater than zero.');
  if (vat < 0 || vat >= paid) E('BAD_AMOUNT', 'VAT must be at least 0 and less than the amount paid.');
  if (wht < 0 || wht > r2(paid - vat) + 0.005) E('BAD_AMOUNT', 'Withholding tax cannot be more than the amount before VAT.');
  if (vat > 0 && claim.taxType === 'none') E('VAT_INCONSISTENT', 'A VAT amount is set but the tax type is “No VAT”.');
  if (vat > 0 && !d.org.vatRegistered) E('NOT_VAT_REGISTERED', 'This business is not VAT-registered, so VAT cannot be recorded separately. Set the tax type to “No VAT”.');

  // the debit account: category mapping, unless the accountant chose another one while reviewing
  const code = claim.accountOverride || claim.accountCode;
  const pr = accountProblem(d, claim.treatment, code, day);
  if (pr) E(pr.code, pr.msg);

  // payment side: the approved role mapping decides which ledger account is cash / bank
  const payRole = claim.paidFrom === 'cash' ? 'cash' : 'bank';
  const payCode = roleCode(d, payRole, noonOf(day));
  const payAcct = payCode ? findAcct(d, payCode) : undefined;
  if (!payCode || !payAcct) E('PAYMENT_ACCOUNT', `No account is mapped for “${payRole}” on ${day}. Complete Accounting setup → Transaction mapping.`);
  else if (!payAcct.posting || !payAcct.active) E('PAYMENT_ACCOUNT', `${payAcct.code} ${payAcct.name} (${payRole}) cannot accept postings.`);

  const creditableVat = vat > 0 && (claim.taxType === 'vat_included' || claim.taxType === 'vat_excluded');
  let vatCode: string | undefined;
  if (creditableVat) {
    vatCode = roleCode(d, 'input_vat', noonOf(day));
    const va = vatCode ? findAcct(d, vatCode) : undefined;
    if (!va || !va.posting || !va.active) E('VAT_ACCOUNT', 'No active account is mapped for “Input VAT”. Complete Accounting setup → Transaction mapping.');
    const rate = taxAt(d, 'VAT7', noonOf(day))?.rate;
    const expected = rate == null ? null : claim.taxType === 'vat_excluded' ? r2((paid - vat) * rate) : r2((paid * rate) / (1 + rate));
    if (expected != null && Math.abs(vat - expected) > 0.02) W('VAT_RATE_DIFF', `The VAT amount differs from ${(rate! * 100).toFixed(0)}% VAT (expected about ${expected.toLocaleString()}). Check it against the tax invoice.`);
    if (!claim.vendorTaxId) W('NO_VENDOR_TAX_ID', 'Input VAT is being claimed but the vendor tax ID is empty. A claimable VAT needs a valid full tax invoice.');
  }

  let whtCode: string | undefined;
  if (wht > 0) {
    whtCode = cfg.whtAccount;
    const wa = findAcct(d, whtCode);
    if (!wa) E('WHT_ACCOUNT', `The withholding-tax account ${whtCode} does not exist in the chart of accounts.`);
    else if (!wa.posting || !wa.active || wa.type !== 'liability' || wa.fsLine !== 'tax_payable') E('WHT_ACCOUNT', `${wa.code} ${wa.name} is not an active tax-payable account for withholding tax.`);
  }

  if (claim.treatment === 'expense' && cfg.fixedAssetWarnAmount > 0 && paid >= cfg.fixedAssetWarnAmount) W('ASSET_THRESHOLD', `The amount is ${cfg.fixedAssetWarnAmount.toLocaleString()} or more. If this is equipment that will be used for over a year, post it as a fixed asset instead.`);
  if (!claim.attachmentCount) W('NO_RECEIPT', 'No receipt or proof of payment is attached.');
  if (isLocked(d, noonOf(day))) E('PERIOD_LOCKED', `The accounting period is closed through ${d.meta.lockedUntil}. Choose a posting date in an open period.`);
  if (claimJournal(d, claim.id)) E('DUPLICATE_POSTING', 'This expense has already been posted to the ledger.');

  const base = r2(paid - vat);
  const lines: JournalLine[] = [];
  if (code && !pr) {
    const memo = claim.vendor || claim.description;
    lines.push(dr(code, creditableVat ? base : paid, memo));                                   // VAT that cannot be claimed stays in the cost
    if (creditableVat && vatCode) lines.push(dr(vatCode, vat, 'Input VAT'));
    if (payCode) lines.push(cr(payCode, r2(paid - wht), memo));
    if (wht > 0 && whtCode) lines.push(cr(whtCode, wht, 'Withholding tax'));
    const td = r2(lines.reduce((s, l) => s + l.debit, 0)), tc = r2(lines.reduce((s, l) => s + l.credit, 0));
    if (Math.abs(td - tc) > 0.004) E('UNBALANCED', `The journal would not balance: debit ${td} ≠ credit ${tc}.`);
  }
  return { ok: errors.length === 0, errors, warnings, lines: errors.length ? [] : lines, date: day, debitAccount: code ?? undefined };
}

/** Post the claim. Throws (with the first blocking problem as the message) if anything is wrong; nothing is posted then. */
export function postExpenseClaim(d: DB, ctx: Ctx, claim: ClaimForPosting, cfg: ExpenseConfig): { journalId: ID; journalNo: string; date: string } {
  guard(d, ctx, 'accounting:create');
  const plan = planExpensePosting(d, claim, cfg);
  if (!plan.ok) fail(plan.errors[0].code, plan.errors[0].msg);
  const vat = r2(claim.vatAmount);
  const creditableVat = vat > 0 && (claim.taxType === 'vat_included' || claim.taxType === 'vat_excluded');
  const jid = post(d, ctx, {
    date: noonOf(plan.date), memo: `Expense ${claim.expenseNo}: ${claim.vendor || claim.description}`, refType: claimRefType, refId: claim.id, lines: plan.lines,
    dim: claim.branchId ? { branchId: claim.branchId } : undefined,
    info: { claimNo: claim.expenseNo, categoryCode: claim.categoryCode, categoryNameEn: claim.categoryNameEn, categoryNameTh: claim.categoryNameTh, vendor: claim.vendor ?? undefined, paymentMethod: claim.paymentMethod,
            taxType: claim.taxType, treatment: claim.treatment, vat: creditableVat ? vat : 0, wht: r2(claim.whtAmount), expenseDate: claim.expenseDate, approvedAt: claim.approvedAt ?? undefined, postedBy: ctx.userId },
  });
  if (!jid) fail('EMPTY', 'The journal has no lines');
  const j = d.journals.find((x) => x.id === jid)!;
  // the expense register feeds the VAT report (input VAT only when it is claimable); the journal remains the source of truth for amounts
  d.expenses.push({ id: nid(d, 'EX'), no: claim.expenseNo, date: j.date, account: plan.debitAccount!, vendor: claim.vendor || claim.description, amount: r2(claim.amountPaid), vat: creditableVat ? vat : 0, paidFrom: claim.paidFrom, branchId: claim.branchId ?? undefined, note: claim.description, journalId: jid });
  audit(d, ctx, 'expense.post', 'journal', jid, `Posted expense ${claim.expenseNo} (${r2(claim.amountPaid)}) as ${j.no}`, 'info');
  return { journalId: jid!, journalNo: j.no, date: plan.date };
}

/** Reverse a posted claim in the ledger (the original stays, marked reversed). Returns the reversal journal number. */
export function reverseExpenseClaim(d: DB, ctx: Ctx, claimId: ID, reason: string): { reversalNo: string; journalNo: string } {
  guard(d, ctx, 'accounting:approve');
  const j = claimJournal(d, claimId) || fail('NOT_FOUND', 'This expense is not posted in this ledger, so it cannot be reversed here. Open the app on the accounting device that holds the ledger.');
  const rid = reverseJournal(d, ctx, j.id, reason);
  return { reversalNo: d.journals.find((x) => x.id === rid)!.no, journalNo: j.no };
}
