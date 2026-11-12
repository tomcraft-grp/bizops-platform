import type { Account, DB, FsLine, ID, JournalDraft, OpeningSet, TaxCode } from './types';
import { Ctx, audit, docNo, fail, nid, guard } from './core';
import {
  ROLE_DEFS, ROLE_KEYS, balancesBetween, cr, dr, findAcct, isControl, natBal, netDebit, post, postManualJournal, roleCode, roleLabel, sumAccounts, sumNetDebit,
} from './accounting';
import { allocatedMap, orderBalance, receiptUnapplied } from './payments';
import { inTransitValue, stockValue } from './inventory';
import { apOpen, supplierDeposit } from './purchasing';
import { addDays, dayKey, r2 } from '../lib/util';

// ======================================================================================
// Chart of accounts management
// ======================================================================================
const usedCodes = (d: DB) => { const s = new Set<string>(); for (const j of d.journals) for (const l of j.lines) s.add(l.account); return s; };

export interface CoaIssue { code?: string; level: 'error' | 'warn'; msg: string }
export function validateCoa(d: DB): CoaIssue[] {
  const out: CoaIssue[] = [];
  const codes = new Set<string>();
  for (const a of d.accounts) {
    if (codes.has(a.code)) out.push({ code: a.code, level: 'error', msg: 'Duplicate account code' });
    codes.add(a.code);
    if (a.parent) {
      const p = findAcct(d, a.parent);
      if (!p) out.push({ code: a.code, level: 'error', msg: `Parent ${a.parent} does not exist` });
      else if (p.posting) out.push({ code: a.code, level: 'error', msg: `Parent ${a.parent} is a posting account; parents must be header accounts` });
      else if (p.type !== a.type && !(p.code === '7000' || p.code === '8000')) out.push({ code: a.code, level: 'warn', msg: `Type differs from parent ${a.parent}` });
    } else if (a.posting) out.push({ code: a.code, level: 'warn', msg: 'Posting account has no parent in the hierarchy' });
    const natural: Account['normal'] = a.type === 'asset' || a.type === 'expense' ? 'debit' : 'credit';
    if (a.normal !== natural && !a.contra) out.push({ code: a.code, level: 'warn', msg: `Normal balance ${a.normal} is unusual for ${a.type}; mark as contra if intended` });
  }
  for (const r of ROLE_DEFS) {
    const c = roleCode(d, r.key);
    if (!c) { out.push({ level: 'error', msg: `Role “${r.label}” is not mapped to an account` }); continue; }
    const a = findAcct(d, c);
    if (!a) out.push({ code: c, level: 'error', msg: `Role “${r.label}” maps to unknown account ${c}` });
    else {
      if (!a.posting || !a.active) out.push({ code: c, level: 'error', msg: `Role “${r.label}” maps to ${c}, which is not an active posting account` });
      if (!r.expect.includes(a.fsLine)) out.push({ code: c, level: 'error', msg: `Role “${r.label}” maps to ${c} (${a.fsLine}); expected ${r.expect.join(' / ')}` });
    }
  }
  return out;
}

export function saveAccount(d: DB, ctx: Ctx, p: Partial<Account> & { code: string; name: string }, isNew: boolean) {
  guard(d, ctx, 'accounting:create');
  const code = p.code.trim();
  if (!/^[0-9A-Za-z\-.]{2,12}$/.test(code)) fail('INVALID', 'Account code must be 2–12 characters (letters, digits, - .)');
  if (!p.name.trim()) fail('INVALID', 'Account name is required');
  const existing = findAcct(d, code);
  if (isNew && existing) fail('DUPLICATE', `Account code ${code} already exists`);
  if (!isNew && !existing) fail('NOT_FOUND', 'Account not found');
  if (p.parent) {
    const par = findAcct(d, p.parent);
    if (!par) fail('INVALID', `Parent ${p.parent} does not exist`);
    if (par!.posting) fail('INVALID', 'The parent must be a header (non-posting) account');
  }
  if (isNew) {
    if (!p.type || !p.normal || !p.fsLine) fail('INVALID', 'Type, normal balance and financial-statement line are required');
    d.accounts.push({
      code, name: p.name.trim(), nameTh: (p.nameTh ?? '').trim(), type: p.type!, normal: p.normal!, group: p.group ?? 'Custom', fsLine: p.fsLine!, posting: p.posting ?? true, active: true,
      effectiveFrom: p.effectiveFrom ?? ctx.now, parent: p.parent, contra: p.contra, cashFlow: p.cashFlow, taxCode: p.taxCode, control: p.control, dims: p.dims,
    });
    d.accounts.sort((a, b) => a.code.localeCompare(b.code));
    audit(d, ctx, 'coa.add', 'account', code, `Added account ${code} ${p.name}`, 'warn');
    return;
  }
  const a = existing!;
  const used = usedCodes(d).has(code);
  if (used) {
    if (p.type && p.type !== a.type) fail('IN_USE', 'The account type cannot change after postings exist');
    if (p.normal && p.normal !== a.normal) fail('IN_USE', 'The normal balance cannot change after postings exist');
    if (p.posting === false && a.posting) fail('IN_USE', 'An account with postings cannot become a header account');
  }
  if (p.posting === false && a.posting && d.accounts.some((x) => x.parent === code)) { /* header with children is fine */ }
  if (p.posting === true && !a.posting && d.accounts.some((x) => x.parent === code)) fail('INVALID', 'A header account with children cannot become a posting account');
  Object.assign(a, { ...p, code: a.code });
  audit(d, ctx, 'coa.edit', 'account', code, `Edited account ${code}: ${Object.keys(p).filter((k) => k !== 'code').join(', ')}`, 'warn');
}

export function deactivateAccount(d: DB, ctx: Ctx, code: string, reason: string) {
  guard(d, ctx, 'accounting:create');
  const a = findAcct(d, code) || fail('NOT_FOUND', 'Account not found');
  if (!reason.trim()) fail('REASON', 'A reason is required');
  const role = ROLE_DEFS.find((r) => roleCode(d, r.key) === code);
  if (role) fail('IN_USE', `${code} is the mapped account for “${role.label}”. Re-map that role (with approval) before deactivating.`);
  const bal = balancesBetween(d.journals)[code];
  if (bal && Math.abs(netDebit(bal)) > 0.004) fail('NON_ZERO', `${code} still has a balance of ${r2(netDebit(bal))}. Clear it before deactivating.`);
  if (d.accounts.some((x) => x.parent === code && x.active)) fail('IN_USE', 'Deactivate the child accounts first');
  a!.active = false;
  a!.inactiveFrom = ctx.now;
  audit(d, ctx, 'coa.deactivate', 'account', code, `${code} deactivated: ${reason}`, 'warn');
}
export function reactivateAccount(d: DB, ctx: Ctx, code: string) {
  guard(d, ctx, 'accounting:create');
  const a = findAcct(d, code) || fail('NOT_FOUND', 'Account not found');
  a!.active = true;
  a!.inactiveFrom = undefined;
  audit(d, ctx, 'coa.reactivate', 'account', code, `${code} reactivated`, 'warn');
}
export const deleteAccount = (d: DB, _ctx: Ctx, code: string) => {
  if (usedCodes(d).has(code)) fail('IN_USE', 'Accounts used in posted transactions cannot be deleted — deactivate them instead');
  const i = d.accounts.findIndex((a) => a.code === code);
  if (i < 0) fail('NOT_FOUND', 'Account not found');
  if (d.accounts[i].system) fail('SYSTEM', 'System accounts cannot be deleted');
  if (d.accounts.some((a) => a.parent === code)) fail('IN_USE', 'Remove or move the child accounts first');
  d.accounts.splice(i, 1);
};

export const COA_HEADERS = ['code', 'name', 'name_th', 'type', 'normal', 'parent', 'posting', 'fs_line', 'cash_flow', 'tax_code', 'control', 'contra'] as const;
export function coaToRows(d: DB): string[][] {
  return [[...COA_HEADERS], ...d.accounts.map((a) => [a.code, a.name, a.nameTh, a.type, a.normal, a.parent ?? '', a.posting ? 'yes' : 'no', a.fsLine, a.cashFlow ?? '', a.taxCode ?? '', a.control ?? '', a.contra ? 'yes' : ''])];
}
/** Atomic import: validates every row first; either all rows apply or none */
export function importCoaRows(d: DB, ctx: Ctx, rows: string[][]) {
  guard(d, ctx, 'accounting:create');
  if (rows.length < 2) fail('INVALID', 'The file has no data rows');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const ix = (n: string) => head.indexOf(n);
  for (const need of ['code', 'name', 'type', 'normal', 'fs_line']) if (ix(need) < 0) fail('INVALID', `Missing required column "${need}"`);
  const types = ['asset', 'liability', 'equity', 'revenue', 'expense'];
  const errors: string[] = [];
  let added = 0, updated = 0;
  rows.slice(1).forEach((r, i) => {
    const g = (n: string) => (ix(n) >= 0 ? (r[ix(n)] ?? '').trim() : '');
    const code = g('code');
    if (!code) return;
    if (!types.includes(g('type'))) errors.push(`Row ${i + 2}: unknown type "${g('type')}"`);
    if (!['debit', 'credit'].includes(g('normal'))) errors.push(`Row ${i + 2}: normal must be debit or credit`);
  });
  if (errors.length) fail('INVALID', errors.slice(0, 4).join('; ') + (errors.length > 4 ? ` (+${errors.length - 4} more)` : ''));
  for (const r of rows.slice(1)) {
    const g = (n: string) => (ix(n) >= 0 ? (r[ix(n)] ?? '').trim() : '');
    const code = g('code');
    if (!code) continue;
    const isNew = !findAcct(d, code);
    saveAccount(d, ctx, {
      code, name: g('name'), nameTh: g('name_th'), type: g('type') as Account['type'], normal: g('normal') as Account['normal'], parent: g('parent') || undefined, posting: g('posting') !== 'no',
      fsLine: g('fs_line') as FsLine, cashFlow: (g('cash_flow') || undefined) as Account['cashFlow'], taxCode: g('tax_code') || undefined, control: (g('control') || undefined) as Account['control'], contra: g('contra') === 'yes' || undefined,
    }, isNew);
    if (isNew) added++; else updated++;
  }
  return { added, updated };
}

// ======================================================================================
// Transaction mapping (versioned, maker-checker once the setup is approved)
// ======================================================================================
function checkRoleTarget(d: DB, role: string, toCode: string) {
  const r = ROLE_DEFS.find((x) => x.key === role) || fail('NOT_FOUND', 'Unknown posting role');
  const a = findAcct(d, toCode) || fail('NOT_FOUND', `Account ${toCode} does not exist`);
  if (!a!.posting || !a!.active) fail('INVALID', `${toCode} is not an active posting account`);
  if (!r!.expect.includes(a!.fsLine)) fail('INVALID', `“${r!.label}” must map to a ${r!.expect.join(' / ')} account, but ${toCode} is ${a!.fsLine}`);
}

export function setMappingDirect(d: DB, ctx: Ctx, role: string, toCode: string) {
  guard(d, ctx, 'accounting:approve');
  if (d.setup.status === 'approved') fail('CHANGE_CONTROL', 'The accounting setup is approved. Propose the change and have a second authorized person approve it.');
  checkRoleTarget(d, role, toCode);
  d.postingMap[role] = [{ code: toCode, from: '2020-01-01T00:00:00.000Z' }];
  audit(d, ctx, 'mapping.set', 'mapping', role, `${roleLabel(role)} → ${toCode} (setup in draft)`, 'warn');
}
export function proposeMapping(d: DB, ctx: Ctx, p: { role: string; toCode: string; effectiveFrom: string; reason: string }): ID {
  guard(d, ctx, 'accounting:create');
  checkRoleTarget(d, p.role, p.toCode);
  if (!p.reason.trim()) fail('REASON', 'A reason is required');
  if (d.meta.lockedUntil && dayKey(p.effectiveFrom) <= d.meta.lockedUntil) fail('PERIOD_LOCKED', `The effective date must be after the locked period (${d.meta.lockedUntil})`);
  if (roleCode(d, p.role, p.effectiveFrom) === p.toCode) fail('NO_CHANGE', 'That account is already mapped to this role');
  if (d.mappingChanges.some((c) => c.role === p.role && c.status === 'pending')) fail('PENDING', 'A change for this role is already waiting for approval');
  const id = nid(d, 'MC');
  d.mappingChanges.push({ id, role: p.role, toCode: p.toCode, effectiveFrom: p.effectiveFrom, reason: p.reason, proposedBy: ctx.userId, proposedAt: ctx.now, status: 'pending' });
  audit(d, ctx, 'mapping.propose', 'mapping', p.role, `Proposed ${roleLabel(p.role)} → ${p.toCode} from ${dayKey(p.effectiveFrom)}: ${p.reason}`, 'warn');
  return id;
}
export function decideMapping(d: DB, ctx: Ctx, id: ID, approve: boolean, note: string) {
  guard(d, ctx, 'accounting:approve');
  const c = d.mappingChanges.find((x) => x.id === id) || fail('NOT_FOUND', 'Change not found');
  if (c!.status !== 'pending') fail('INVALID', `Change is already ${c!.status}`);
  if (c!.proposedBy === ctx.userId) fail('SELF_APPROVAL', 'The person who proposed a mapping change cannot approve it (four-eyes control).');
  if (!approve && !note.trim()) fail('REASON', 'A reason is required to reject');
  if (approve) {
    checkRoleTarget(d, c!.role, c!.toCode);
    if (d.meta.lockedUntil && dayKey(c!.effectiveFrom) <= d.meta.lockedUntil) fail('PERIOD_LOCKED', 'The effective date now falls in a locked period; propose a new date');
    (d.postingMap[c!.role] ||= []).push({ code: c!.toCode, from: c!.effectiveFrom });
  }
  c!.status = approve ? 'approved' : 'rejected';
  c!.decidedBy = ctx.userId;
  c!.decidedAt = ctx.now;
  c!.decisionNote = note;
  audit(d, ctx, approve ? 'mapping.approve' : 'mapping.reject', 'mapping', c!.role, `${roleLabel(c!.role)} → ${c!.toCode} ${approve ? 'approved' : 'rejected'}${note ? ': ' + note : ''}`, 'critical');
}

// ======================================================================================
// Tax register
// ======================================================================================
export function saveTaxCode(d: DB, ctx: Ctx, p: { code: string; name: string; kind: TaxCode['kind']; rate: number; creditable: boolean; effectiveFrom: string; note?: string }) {
  guard(d, ctx, 'accounting:create');
  if (!(p.rate >= 0 && p.rate <= 1)) fail('INVALID', 'Rate must be between 0% and 100%');
  if (!p.name.trim() || !p.code.trim()) fail('INVALID', 'Code and name are required');
  if (d.meta.lockedUntil && dayKey(p.effectiveFrom) <= d.meta.lockedUntil) fail('PERIOD_LOCKED', 'The effective date must be after the locked period');
  const versions = d.taxCodes.filter((t) => t.code === p.code).sort((a, b) => b.version - a.version);
  const cur = versions[0];
  if (cur && dayKey(p.effectiveFrom) <= dayKey(cur.effectiveFrom)) fail('INVALID', `The effective date must be after the current version's start (${dayKey(cur.effectiveFrom)})`);
  if (cur) cur.effectiveTo = addDays(p.effectiveFrom, -1).toISOString();
  d.taxCodes.push({ id: nid(d, 'TX'), code: p.code, name: p.name, kind: p.kind, rate: p.rate, creditable: p.creditable, effectiveFrom: p.effectiveFrom, version: (cur?.version ?? 0) + 1, note: p.note });
  audit(d, ctx, 'tax.version', 'tax', p.code, `${p.code} v${(cur?.version ?? 0) + 1}: ${(p.rate * 100).toFixed(2)}% from ${dayKey(p.effectiveFrom)}`, 'critical');
}

// ======================================================================================
// Manual journals: draft → submitted → approved (posted). Maker ≠ checker unless approval is switched off.
// ======================================================================================
export function saveDraft(d: DB, ctx: Ctx, p: { id?: ID; date: string; memo: string; lines: JournalDraft['lines'] }): ID {
  guard(d, ctx, 'accounting:create');
  if (!p.memo.trim()) fail('INVALID', 'A memo is required');
  if (p.id) {
    const x = d.journalDrafts.find((y) => y.id === p.id) || fail('NOT_FOUND', 'Draft not found');
    if (x!.status !== 'draft' && x!.status !== 'rejected') fail('INVALID', `Draft is ${x!.status}`);
    Object.assign(x!, { date: p.date, memo: p.memo, lines: p.lines, status: 'draft' });
    return x!.id;
  }
  const id = nid(d, 'JD');
  d.journalDrafts.push({ id, no: docNo(d, 'DRAFT', 4), date: p.date, memo: p.memo, lines: p.lines, createdBy: ctx.userId, createdAt: ctx.now, status: 'draft' });
  return id;
}
export function submitDraft(d: DB, ctx: Ctx, id: ID) {
  guard(d, ctx, 'accounting:create');
  const x = d.journalDrafts.find((y) => y.id === id) || fail('NOT_FOUND', 'Draft not found');
  const td = r2(x!.lines.reduce((s, l) => s + l.debit, 0)), tc = r2(x!.lines.reduce((s, l) => s + l.credit, 0));
  if (td <= 0 || Math.abs(td - tc) > 0.005) fail('UNBALANCED', `Debits (${td}) must equal credits (${tc}) before submitting`);
  for (const l of x!.lines) { const a = findAcct(d, l.account); if (!a || !a.posting || !a.active) fail('BAD_ACCOUNT', `${l.account} is not an active posting account`); }
  x!.status = 'submitted';
  x!.submittedAt = ctx.now;
}
export function approveDraft(d: DB, ctx: Ctx, id: ID): ID {
  guard(d, ctx, 'accounting:approve');
  const x = d.journalDrafts.find((y) => y.id === id) || fail('NOT_FOUND', 'Draft not found');
  if (x!.status !== 'submitted') fail('INVALID', 'Only submitted drafts can be approved');
  if (d.org.requireJournalApproval && x!.createdBy === ctx.userId) fail('SELF_APPROVAL', 'You prepared this journal; a different authorized person must approve it.');
  const jid = postManualJournal(d, ctx, { date: x!.date, memo: x!.memo, lines: x!.lines, approvedBy: ctx.userId });
  x!.status = 'approved';
  x!.decidedBy = ctx.userId;
  x!.decidedAt = ctx.now;
  x!.journalId = jid;
  return jid;
}
export function rejectDraft(d: DB, ctx: Ctx, id: ID, reason: string) {
  guard(d, ctx, 'accounting:approve');
  const x = d.journalDrafts.find((y) => y.id === id) || fail('NOT_FOUND', 'Draft not found');
  if (x!.status !== 'submitted') fail('INVALID', 'Only submitted drafts can be rejected');
  if (!reason.trim()) fail('REASON', 'A reason is required');
  x!.status = 'rejected';
  x!.decidedBy = ctx.userId;
  x!.decidedAt = ctx.now;
  x!.reason = reason;
}

// ======================================================================================
// Money movements that are NOT revenue or expense (transfers, loans, owner funds)
// ======================================================================================
export type MovementKind = 'transfer' | 'loan_received' | 'loan_repaid' | 'interest_paid' | 'interest_received' | 'owner_contribution' | 'owner_withdrawal';
export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  transfer: 'Transfer between own cash/bank accounts', loan_received: 'Loan received (principal)', loan_repaid: 'Loan principal repayment', interest_paid: 'Loan interest paid',
  interest_received: 'Interest received', owner_contribution: 'Owner contribution', owner_withdrawal: 'Owner withdrawal / drawings',
};
export function postMovement(d: DB, ctx: Ctx, p: { kind: MovementKind; amount: number; account: 'cash' | 'bank'; toAccount?: 'cash' | 'bank'; date: string; memo: string }): ID {
  guard(d, ctx, 'accounting:create');
  if (!(p.amount > 0)) fail('INVALID', 'Amount must be greater than zero');
  const a = p.amount;
  const lines = {
    transfer: () => { if (!p.toAccount || p.toAccount === p.account) fail('INVALID', 'Choose two different accounts'); return [dr(p.toAccount!, a), cr(p.account, a)]; },
    loan_received: () => [dr(p.account, a), cr('loans', a)],
    loan_repaid: () => [dr('loans', a), cr(p.account, a)],
    interest_paid: () => [dr('interest_expense', a), cr(p.account, a)],
    interest_received: () => [dr(p.account, a), cr('interest_income', a)],
    owner_contribution: () => [dr(p.account, a), cr('owner_capital', a)],
    owner_withdrawal: () => [dr('owner_drawings', a), cr(p.account, a)],
  }[p.kind]();
  const id = post(d, ctx, { date: p.date, memo: `${MOVEMENT_LABEL[p.kind]}${p.memo ? ': ' + p.memo : ''}`, refType: 'movement:' + p.kind, lines });
  audit(d, ctx, 'movement.' + p.kind, 'journal', id, `${MOVEMENT_LABEL[p.kind]} ${a}`, p.kind.startsWith('owner') || p.kind.startsWith('loan') ? 'warn' : 'info');
  return id!;
}

// ======================================================================================
// Opening balances (non-control accounts here; subledger balances load through their own documents)
// ======================================================================================
const SUBLEDGER_CONTROLS = ['ar', 'platform', 'ap', 'inventory', 'customer_credit', 'supplier_deposit'];
export function saveOpeningSet(d: DB, ctx: Ctx, p: { id?: ID; asOf: string; source: string; lines: OpeningSet['lines']; note?: string }): ID {
  guard(d, ctx, 'accounting:create');
  if (!p.source.trim()) fail('INVALID', 'A source document / reference is required');
  if (p.id) {
    const x = d.openingSets.find((y) => y.id === p.id) || fail('NOT_FOUND', 'Opening set not found');
    if (x!.status !== 'draft') fail('INVALID', `Opening set is ${x!.status}`);
    Object.assign(x!, { asOf: p.asOf, source: p.source, lines: p.lines, note: p.note });
    return x!.id;
  }
  const id = nid(d, 'OB');
  d.openingSets.push({ id, no: docNo(d, 'OPEN', 3), asOf: p.asOf, source: p.source, preparedBy: ctx.userId, createdAt: ctx.now, status: 'draft', lines: p.lines, note: p.note });
  return id;
}
export function validateOpening(d: DB, x: OpeningSet) {
  const issues: string[] = [];
  const td = r2(x.lines.reduce((s, l) => s + l.debit, 0)), tc = r2(x.lines.reduce((s, l) => s + l.credit, 0));
  if (td <= 0) issues.push('The opening set has no amounts');
  if (Math.abs(td - tc) > 0.005) issues.push(`Opening debits (${td}) do not equal credits (${tc})`);
  for (const l of x.lines) {
    const a = findAcct(d, l.account);
    if (!a) { issues.push(`Unknown account ${l.account}`); continue; }
    if (!a.posting) issues.push(`${l.account} is a header account`);
    if (a.control && SUBLEDGER_CONTROLS.includes(a.control)) issues.push(`${a.code} ${a.name} is a control account — its opening balance must come from subledger documents (customer invoices, supplier bills, stock counts) so the subledger reconciles`);
  }
  return issues;
}
export function reviewOpening(d: DB, ctx: Ctx, id: ID) {
  // Review is a read-and-confirm step (it posts nothing): anyone who may see the books can be the independent checker.
  // Posting the opening journal (approveOpening) still needs accounting:approve.
  guard(d, ctx, 'accounting:view');
  const x = d.openingSets.find((y) => y.id === id) || fail('NOT_FOUND', 'Opening set not found');
  if (x!.status !== 'draft') fail('INVALID', `Opening set is ${x!.status}`);
  if (x!.preparedBy === ctx.userId) fail('SELF_APPROVAL', 'The preparer cannot review their own opening balances.');
  const issues = validateOpening(d, x!);
  if (issues.length) fail('INVALID', issues[0]);
  x!.status = 'reviewed';
  x!.reviewedBy = ctx.userId;
}
export function approveOpening(d: DB, ctx: Ctx, id: ID): ID {
  guard(d, ctx, 'accounting:approve');
  const x = d.openingSets.find((y) => y.id === id) || fail('NOT_FOUND', 'Opening set not found');
  if (x!.status !== 'reviewed') fail('INVALID', 'Opening balances must be reviewed before approval');
  if (x!.preparedBy === ctx.userId) fail('SELF_APPROVAL', 'The preparer cannot approve their own opening balances.');
  const issues = validateOpening(d, x!);
  if (issues.length) fail('INVALID', issues[0]);
  const jid = post(d, ctx, { date: x!.asOf, memo: `Opening balances ${x!.no} (${x!.source})`, refType: 'opening_balance', refId: x!.id, lines: x!.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, memo: l.memo })), approvedBy: ctx.userId });
  x!.status = 'posted';
  x!.approvedBy = ctx.userId;
  x!.journalId = jid;
  audit(d, ctx, 'opening.post', 'opening', x!.id, `${x!.no} posted as of ${dayKey(x!.asOf)}`, 'critical');
  return jid!;
}

// ======================================================================================
// Reconciliation: subledger ↔ general-ledger control accounts (§23.7)
// ======================================================================================
export interface ReconRow { key: string; title: string; accounts: string; gl: number; sub: number; diff: number; status: 'ok' | 'diff' | 'pending'; subLabel: string; note?: string }
export function reconciliationMatrix(d: DB): ReconRow[] {
  const bal = balancesBetween(d.journals);
  const gl = (k: Account['control']) => sumAccounts(d, bal, isControl(k));
  const codes = (k: Account['control']) => d.accounts.filter(isControl(k)).map((a) => a.code).join(' + ');
  const alloc = allocatedMap(d);
  const rows: ReconRow[] = [];
  const add = (key: string, title: string, accounts: string, g: number, s: number, subLabel: string, note?: string) => {
    const diff = r2(g - s);
    rows.push({ key, title, accounts, gl: g, sub: s, diff, status: Math.abs(diff) < 0.05 ? 'ok' : 'diff', subLabel, note });
  };
  let ar = 0;
  for (const o of d.orders) if (o.collectedBy === 'merchant') ar += (o.recognizedAt ? o.total - o.creditNoted : 0) - (alloc[o.id] || 0) + o.refundsPaid;
  add('ar', 'Customer receivables', codes('ar'), gl('ar'), r2(ar), 'Σ order balances (customer ledger)');
  let plat = 0;
  for (const o of d.orders) if (o.collectedBy === 'platform' && o.recognizedAt) plat += o.total - o.creditNoted;
  for (const s of d.settlements) if (s.status === 'received') for (const id of s.orderIds) { const o = d.orders.find((x) => x.id === id); if (o) plat -= o.settledAmount ?? 0; }
  add('platform', 'Platform (marketplace / delivery) receivables', codes('platform'), gl('platform'), r2(plat), 'Σ unsettled platform orders');
  add('ap', 'Supplier payables', codes('ap'), gl('ap'), r2(d.apInvoices.reduce((s, i) => s + apOpen(i), 0)), 'Σ open supplier invoices');
  add('inventory', 'Inventory', codes('inventory'), gl('inventory'), r2(stockValue(d) + inTransitValue(d)), 'Stock ledger value + in transit');
  add('customer_credit', 'Customer credit / unapplied receipts', codes('customer_credit'), gl('customer_credit'), r2(d.receipts.reduce((s, r) => s + receiptUnapplied(d, r), 0)), 'Σ unapplied receipts');
  add('supplier_deposit', 'Supplier deposits', codes('supplier_deposit'), gl('supplier_deposit'), r2(d.suppliers.reduce((s, x) => s + supplierDeposit(d, x.id), 0)), 'Σ deposit balances');
  // tax: net VAT payable per GL vs per source documents
  const outGl = sumAccounts(d, bal, (a) => a.control === 'tax' && a.fsLine === 'tax_payable' && a.taxCode !== undefined);
  const inGl = sumAccounts(d, bal, (a) => a.control === 'tax' && a.fsLine === 'tax_asset');
  const outSub = d.orders.reduce((s, o) => s + (o.recognizedAt ? o.vatAmount ?? 0 : 0), 0) - d.returns.reduce((s, r) => s + r.vatAmount, 0);
  const inSub = d.apInvoices.reduce((s, i) => s + i.vat, 0) + d.expenses.reduce((s, e) => s + e.vat, 0) - d.supplierReturns.reduce((s, r) => s + (r.vat ?? 0), 0);
  add('tax', 'VAT (output − input)', codes('tax'), r2(outGl - inGl), r2(outSub - inSub), 'Tax base of sales, purchases and expenses', 'Net VAT payable per ledger vs per source documents');
  // cash & bank: reconciled-to-statement status
  const cashAccts = d.accounts.filter(isControl('cash_bank'));
  let glCash = 0, unrecN = 0, unrecAmt = 0;
  for (const j of d.journals) j.lines.forEach((l, i) => { if (cashAccts.some((a) => a.code === l.account)) { const v = l.debit - l.credit; glCash += v; if (!d.reconciled[`${j.id}:${i}`]) { unrecN++; unrecAmt += v; } } });
  const sub = r2(glCash - unrecAmt);
  rows.push({ key: 'cash_bank', title: 'Cash & bank (vs statement)', accounts: cashAccts.map((a) => a.code).join(' + '), gl: r2(glCash), sub, diff: r2(unrecAmt), status: unrecN ? 'pending' : 'ok', subLabel: 'Σ lines ticked as matched to the statement', note: `${unrecN} unreconciled line(s) — tick them on Cash & bank once they appear on the statement` });
  return rows;
}

export function reconDrill(d: DB, key: string): { label: string; amount: number; sub?: string }[] {
  const alloc = allocatedMap(d);
  const m: Record<string, number> = {};
  const add = (k: string, v: number) => { m[k] = (m[k] || 0) + v; };
  if (key === 'ar') {
    for (const o of d.orders) if (o.collectedBy === 'merchant') add(d.customers.find((c) => c.id === o.customerId)?.name ?? 'Walk-in / no customer', (o.recognizedAt ? o.total - o.creditNoted : 0) - (alloc[o.id] || 0) + o.refundsPaid);
  } else if (key === 'platform') {
    for (const o of d.orders) if (o.collectedBy === 'platform' && o.recognizedAt) add(o.channel, o.total - o.creditNoted);
    for (const s of d.settlements) if (s.status === 'received') for (const id of s.orderIds) { const o = d.orders.find((x) => x.id === id); if (o) add(o.channel, -(o.settledAmount ?? 0)); }
  } else if (key === 'ap') {
    for (const i of d.apInvoices) add(d.suppliers.find((s) => s.id === i.supplierId)?.name ?? i.supplierId, apOpen(i));
  } else if (key === 'inventory') {
    for (const k in d.balances) add(d.warehouses.find((w) => w.id === k.split('|')[0])?.name ?? k, d.balances[k].value);
    add('In transit', inTransitValue(d));
  } else if (key === 'customer_credit') {
    for (const r of d.receipts) { const u = receiptUnapplied(d, r); if (u) add(d.customers.find((c) => c.id === r.customerId)?.name ?? 'Unknown', u); }
  } else if (key === 'supplier_deposit') {
    for (const s of d.suppliers) add(s.name, supplierDeposit(d, s.id));
  } else if (key === 'tax') {
    add('Output VAT on sales', d.orders.reduce((s, o) => s + (o.recognizedAt ? o.vatAmount ?? 0 : 0), 0));
    add('Output VAT reversed by returns', -d.returns.reduce((s, r) => s + r.vatAmount, 0));
    add('Input VAT on purchases', -d.apInvoices.reduce((s, i) => s + i.vat, 0));
    add('Input VAT on expenses', -d.expenses.reduce((s, e) => s + e.vat, 0));
    add('Input VAT returned to suppliers', d.supplierReturns.reduce((s, r) => s + (r.vat ?? 0), 0));
  }
  return Object.entries(m).map(([label, amount]) => ({ label, amount: r2(amount) })).filter((x) => Math.abs(x.amount) > 0.004).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

// ======================================================================================
// Setup checklist & approval (§23.2)
// ======================================================================================
export interface SetupCheck { id: string; stage: string; title: string; status: 'ok' | 'warn' | 'fail' | 'pending'; detail: string }
export const SETUP_STAGES: { id: string; title: string }[] = [
  { id: 'profile', title: '1 · Business profile' }, { id: 'coa', title: '2 · Chart of accounts' }, { id: 'tax', title: '3 · Tax configuration' },
  { id: 'mapping', title: '4 · Transaction mapping' }, { id: 'opening', title: '5 · Opening balances' }, { id: 'recon', title: '6 · Reconciliation' }, { id: 'approval', title: '7 · Approval & lock' },
];
export function setupChecks(d: DB): SetupCheck[] {
  const out: SetupCheck[] = [];
  const o = d.org;
  const profileMissing = [!o.legalName && 'legal name', !o.taxId && 'tax ID', !o.fiscalYearStart && 'financial-year start', !d.branches.length && 'branches'].filter(Boolean);
  out.push({ id: 'profile', stage: 'profile', title: 'Legal entity, tax ID, currency, financial year, branches', status: profileMissing.length ? 'fail' : 'ok', detail: profileMissing.length ? `Missing: ${profileMissing.join(', ')}` : `${o.legalName} · ${o.currency} · FY starts ${o.fiscalYearStart} · ${d.branches.length} branches · ${o.accountingBasis} basis` });
  const coa = validateCoa(d).filter((i) => !i.msg.startsWith('Role '));
  const errs = coa.filter((i) => i.level === 'error');
  out.push({ id: 'coa', stage: 'coa', title: 'Chart of accounts is structurally valid', status: errs.length ? 'fail' : coa.length ? 'warn' : 'ok', detail: errs.length ? errs[0].msg : coa.length ? `${coa.length} warning(s)` : `${d.accounts.length} accounts · ${d.accounts.filter((a) => a.posting).length} postable` });
  const tax = taxCheck(d);
  out.push({ id: 'tax', stage: 'tax', title: 'Tax codes configured and effective', status: tax ? 'fail' : 'ok', detail: tax ?? `${d.taxCodes.length} tax code versions · default ${o.defaultTaxCode} · ${o.taxInclusivePricing ? 'tax-inclusive' : 'tax-exclusive'} prices` });
  const mapIssues = validateCoa(d).filter((i) => i.msg.startsWith('Role '));
  const pend = d.mappingChanges.filter((c) => c.status === 'pending').length;
  out.push({ id: 'mapping', stage: 'mapping', title: 'Every posting role maps to a valid account', status: mapIssues.length ? 'fail' : pend ? 'warn' : 'ok', detail: mapIssues.length ? mapIssues[0].msg : pend ? `${pend} change(s) awaiting approval` : `${ROLE_DEFS.length} roles mapped` });
  const posted = d.openingSets.filter((x) => x.status === 'posted').length;
  const open = d.openingSets.filter((x) => x.status !== 'posted').length;
  out.push({ id: 'opening', stage: 'opening', title: 'Opening balances approved and posted', status: posted ? (open ? 'warn' : 'ok') : 'fail', detail: posted ? `${posted} posted${open ? `, ${open} still in progress` : ''}` : 'No approved opening balances yet' });
  const rec = reconciliationMatrix(d).filter((r) => r.status === 'diff');
  out.push({ id: 'recon', stage: 'recon', title: 'Subledgers reconcile to control accounts', status: rec.length ? 'fail' : 'ok', detail: rec.length ? `${rec.length} difference(s): ${rec.map((r) => r.title).join(', ')}` : 'All control accounts agree with their subledgers' });
  out.push({ id: 'approval', stage: 'approval', title: 'Setup approved for live posting', status: d.setup.status === 'approved' ? (d.setup.accountantReviewed ? 'ok' : 'warn') : 'pending', detail: d.setup.status === 'approved' ? `v${d.setup.version} approved ${dayKey(d.setup.approvedAt!)} by ${d.users.find((u) => u.id === d.setup.approvedBy)?.name ?? '—'}${d.setup.accountantReviewed ? '' : ' — NOT yet reviewed by a qualified Thai accountant'}` : 'Not approved' });
  return out;
}
function taxCheck(d: DB): string | undefined {
  const now = new Date().toISOString();
  const day = dayKey(now);
  if (!d.taxCodes.some((t) => t.code === d.org.defaultTaxCode && dayKey(t.effectiveFrom) <= day && (!t.effectiveTo || dayKey(t.effectiveTo) >= day))) return `Default tax code ${d.org.defaultTaxCode} has no version effective today`;
  if (d.org.vatRegistered && !d.taxCodes.some((t) => t.kind === 'vat')) return 'VAT-registered but no VAT tax code exists';
  return undefined;
}
export function approveSetup(d: DB, ctx: Ctx, p: { note: string; accountantReviewed: boolean }) {
  guard(d, ctx, 'accounting:approve');
  const blockers = setupChecks(d).filter((c) => c.stage !== 'approval' && c.status === 'fail');
  if (blockers.length) fail('SETUP_INCOMPLETE', `Cannot approve: ${blockers.map((b) => b.title).join('; ')}`);
  d.setup.version += d.setup.status === 'approved' ? 1 : 0;
  d.setup.status = 'approved';
  d.setup.approvedBy = ctx.userId;
  d.setup.approvedAt = ctx.now;
  d.setup.accountantReviewed = p.accountantReviewed;
  d.setup.note = p.note;
  d.setup.history.push({ ts: ctx.now, by: ctx.userId, action: 'approve', detail: `v${d.setup.version}${p.accountantReviewed ? ' (accountant reviewed)' : ' (NOT accountant reviewed)'}: ${p.note}` });
  audit(d, ctx, 'setup.approve', 'setup', String(d.setup.version), `Accounting setup v${d.setup.version} approved. ${p.note}`, 'critical');
}
export function reopenSetup(d: DB, ctx: Ctx, reason: string) {
  guard(d, ctx, 'accounting:approve');
  if (!reason.trim()) fail('REASON', 'A reason is required');
  d.setup.status = 'draft';
  d.setup.history.push({ ts: ctx.now, by: ctx.userId, action: 'reopen', detail: reason });
  audit(d, ctx, 'setup.reopen', 'setup', String(d.setup.version), `Setup reopened for editing: ${reason}`, 'critical');
}
export function assignStageOwner(d: DB, ctx: Ctx, stage: string, userId: ID) {
  guard(d, ctx, 'accounting:approve');
  d.setup.stageOwners[stage] = userId;
  audit(d, ctx, 'setup.owner', 'setup', stage, `Owner of ${stage} → ${d.users.find((u) => u.id === userId)?.name}`, 'info');
}

// ======================================================================================
// Reports that depend on the approved mapping (§23.11)
// ======================================================================================
export function vatReport(d: DB, from: string, to: string) {
  const inRange = (iso: string) => { const k = dayKey(iso); return k >= from && k <= to; };
  const sales: { doc: string; date: string; code: string; base: number; vat: number; channel: string }[] = [];
  for (const o of d.orders) if (o.recognizedAt && inRange(o.recognizedAt)) sales.push({ doc: o.no, date: o.recognizedAt, code: o.taxCode ?? 'n/a', base: o.taxBase ?? 0, vat: o.vatAmount ?? 0, channel: o.channel });
  const returns = d.returns.filter((r) => inRange(r.ts)).map((r) => ({ doc: r.no, date: r.ts, base: -r.netAmount, vat: -r.vatAmount }));
  const purchases = d.apInvoices.filter((i) => inRange(i.date)).map((i) => ({ doc: i.no, date: i.date, base: i.net, vat: i.vat, kind: 'Purchase invoice' }));
  const expenses = d.expenses.filter((e) => inRange(e.date) && e.vat > 0).map((e) => ({ doc: e.no, date: e.date, base: r2(e.amount - e.vat), vat: e.vat, kind: 'Expense' }));
  const byCode: Record<string, { base: number; vat: number; n: number }> = {};
  for (const s of sales) { const b = (byCode[s.code] ||= { base: 0, vat: 0, n: 0 }); b.base += s.base; b.vat += s.vat; b.n++; }
  const outputVat = r2(sales.reduce((s, x) => s + x.vat, 0) + returns.reduce((s, x) => s + x.vat, 0));
  const inputVat = r2(purchases.reduce((s, x) => s + x.vat, 0) + expenses.reduce((s, x) => s + x.vat, 0));
  return { sales, returns, purchases, expenses, byCode, outputVat, inputVat, netPayable: r2(outputVat - inputVat) };
}

export type CashClass = 'operating' | 'financing' | 'investing' | 'internal';
export function cashFlowReport(d: DB, from: string, to: string) {
  const cashCodes = new Set(d.accounts.filter((a) => a.fsLine === 'cash').map((a) => a.code));
  const classify = (refType: string): { cls: CashClass; label: string } => {
    if (refType.startsWith('movement:')) { const k = refType.slice(9); return { cls: k === 'transfer' ? 'internal' : 'financing', label: k.replace('_', ' ') }; }
    if (refType === 'opening_balance') return { cls: 'financing', label: 'opening balances' };
    const label: Record<string, string> = { receipt: 'Customer receipts', settlement: 'Platform settlements', supplier_payment: 'Supplier payments', expense: 'Operating expenses', refund_paid: 'Customer refunds', order: 'Cash sales', manual: 'Manual journals', reversal: 'Reversals' };
    return { cls: 'operating', label: label[refType] ?? refType };
  };
  let opening = 0, closing = 0;
  const rows: Record<string, { cls: CashClass; label: string; inflow: number; outflow: number }> = {};
  for (const j of d.journals) {
    const k = dayKey(j.date);
    const net = j.lines.filter((l) => cashCodes.has(l.account)).reduce((s, l) => s + l.debit - l.credit, 0);
    if (k <= to) closing += net;
    if (k < from) { opening += net; continue; }
    if (k > to || Math.abs(net) < 0.005) continue;
    const c = classify(j.refType);
    const r = (rows[c.cls + c.label] ||= { ...c, inflow: 0, outflow: 0 });
    if (net > 0) r.inflow += net; else r.outflow += -net;
  }
  const list = Object.values(rows).map((r) => ({ ...r, inflow: r2(r.inflow), outflow: r2(r.outflow) }));
  const sum = (cls: CashClass) => r2(list.filter((r) => r.cls === cls).reduce((s, r) => s + r.inflow - r.outflow, 0));
  return { opening: r2(opening), closing: r2(closing), rows: list, operating: sum('operating'), financing: sum('financing'), investing: sum('investing'), check: r2(opening + sum('operating') + sum('financing') + sum('investing') + sum('internal') - closing) };
}

export function settlementRecon(d: DB) {
  const channels = Array.from(new Set(d.orders.filter((o) => o.collectedBy === 'platform').map((o) => o.channel)));
  return channels.map((ch) => {
    const orders = d.orders.filter((o) => o.channel === ch && o.recognizedAt);
    const billed = r2(orders.reduce((s, o) => s + o.total - o.creditNoted, 0));
    const sts = d.settlements.filter((s) => s.channel === ch);
    const rec = sts.filter((s) => s.status === 'received');
    const settledGross = r2(rec.reduce((s, x) => s + x.gross, 0));
    const fees = r2(rec.reduce((s, x) => s + x.commission + x.paymentFee + x.shippingSubsidy, 0));
    const received = r2(rec.reduce((s, x) => s + (x.receivedAmount ?? 0), 0));
    const variance = r2(rec.reduce((s, x) => s + (x.variance ?? 0), 0));
    const pendingNet = r2(sts.filter((s) => s.status === 'pending').reduce((s, x) => s + x.net, 0));
    const unsettledOrders = orders.filter((o) => !o.settlementId).length;
    return { channel: ch, billed, settledGross, fees, received, variance, pendingNet, outstanding: r2(billed - settledGross), unsettledOrders, statements: sts.length };
  });
}

export function expenseAnalysis(d: DB, from: string, to: string) {
  const bal = new Map<string, number>();
  const accts = new Map(d.accounts.map((a) => [a.code, a]));
  const rows: Record<string, { account: string; branch: string; amount: number }> = {};
  for (const j of d.journals) {
    const k = dayKey(j.date);
    if (k < from || k > to) continue;
    for (const l of j.lines) {
      const a = accts.get(l.account);
      if (!a || !['opex', 'other_expense', 'channel_costs'].includes(a.fsLine)) continue;
      const branch = j.dim?.branchId ?? '';
      const key = a.code + '|' + branch;
      (rows[key] ||= { account: a.code, branch, amount: 0 }).amount += l.debit - l.credit;
      bal.set(a.code, (bal.get(a.code) ?? 0) + l.debit - l.credit);
    }
  }
  return Object.values(rows).map((r) => ({ ...r, amount: r2(r.amount) })).filter((r) => Math.abs(r.amount) > 0.004).sort((a, b) => b.amount - a.amount);
}

export function inventoryRollforward(d: DB, from: string, to: string) {
  const inv = new Set(d.accounts.filter(isControl('inventory')).map((a) => a.code));
  let opening = 0, closing = 0;
  const by: Record<string, number> = {};
  for (const j of d.journals) {
    const k = dayKey(j.date);
    const net = j.lines.filter((l) => inv.has(l.account)).reduce((s, l) => s + l.debit - l.credit, 0);
    if (k <= to) closing += net;
    if (k < from) { opening += net; continue; }
    if (k > to || Math.abs(net) < 0.005) continue;
    by[j.refType] = (by[j.refType] || 0) + net;
  }
  const label: Record<string, string> = { grn: 'Purchases received', production: 'Production (net of waste & absorbed cost)', order: 'Cost of goods sold (sales)', return: 'Customer returns restocked', stock_adjust: 'Adjustments & waste', count: 'Stock count variances', transfer: 'Transfers (net)', supplier_return: 'Returns to suppliers', opening_balance: 'Opening balances' };
  const bal = balancesBetween(d.journals, from, to);
  const cogs = sumNetDebit(d, bal, (a) => a.fsLine === 'cogs');
  return { opening: r2(opening), closing: r2(closing), movements: Object.entries(by).map(([k, v]) => ({ key: k, label: label[k] ?? k, amount: r2(v) })), cogsAccounts: cogs, check: r2(opening + Object.values(by).reduce((s, x) => s + x, 0) - closing) };
}
export { netDebit as _nd, natBal as _nb };
