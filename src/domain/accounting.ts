import type { Account, DB, FsLine, ID, Journal, JournalDim, JournalLine, MappingEntry, PayMethod, ProductKind, TaxCode, Expense } from './types';
import { Ctx, audit, docNo, fail, nid, guard } from './core';
import { dayKey, r2 } from '../lib/util';

// ======================================================================================
// Chart of accounts (illustrative — the legal entity's COA must be approved by a Thai accountant)
// ======================================================================================
const D0 = '2020-01-01T00:00:00.000Z';
type AT = Account['type'];
function A(code: string, name: string, nameTh: string, type: AT, normal: 'debit' | 'credit', group: string, fsLine: FsLine, o: Partial<Account> = {}): Account {
  return { code, name, nameTh, type, normal, group, fsLine, posting: true, active: true, effectiveFrom: D0, ...o };
}
const H = (code: string, name: string, nameTh: string, type: AT, normal: 'debit' | 'credit', group: string, fsLine: FsLine, parent?: string): Account =>
  A(code, name, nameTh, type, normal, group, fsLine, { posting: false, parent });

export const CHART: Account[] = [
  H('1000', 'ASSETS', 'สินทรัพย์', 'asset', 'debit', 'Assets', 'other_assets'),
  H('1010', 'Cash & bank', 'เงินสดและเงินฝากธนาคาร', 'asset', 'debit', 'Cash & bank', 'cash', '1000'),
  A('1100', 'Cash on hand', 'เงินสดในมือ', 'asset', 'debit', 'Cash & bank', 'cash', { parent: '1010', control: 'cash_bank', cashFlow: 'cash', system: true, dims: ['branch'] }),
  A('1110', 'Bank – operating account', 'เงินฝากธนาคาร – บัญชีดำเนินงาน', 'asset', 'debit', 'Cash & bank', 'cash', { parent: '1010', control: 'cash_bank', cashFlow: 'cash', system: true }),
  H('1020', 'Receivables', 'ลูกหนี้', 'asset', 'debit', 'Receivables', 'receivables', '1000'),
  A('1120', 'Platform receivables (marketplace / delivery)', 'ลูกหนี้แพลตฟอร์ม (มาร์เก็ตเพลส/เดลิเวอรี)', 'asset', 'debit', 'Receivables', 'receivables', { parent: '1020', control: 'platform', system: true, dims: ['channel'] }),
  A('1130', 'Accounts receivable – customers', 'ลูกหนี้การค้า – ลูกค้า', 'asset', 'debit', 'Receivables', 'receivables', { parent: '1020', control: 'ar', system: true }),
  A('1140', 'Supplier deposits / prepayments', 'เงินมัดจำ/เงินจ่ายล่วงหน้าผู้ขาย', 'asset', 'debit', 'Receivables', 'other_assets', { parent: '1020', control: 'supplier_deposit', system: true }),
  H('1030', 'Inventory', 'สินค้าคงเหลือ', 'asset', 'debit', 'Inventory', 'inventory', '1000'),
  A('1200', 'Inventory – raw materials & packaging', 'สินค้าคงเหลือ – วัตถุดิบและบรรจุภัณฑ์', 'asset', 'debit', 'Inventory', 'inventory', { parent: '1030', control: 'inventory', system: true }),
  A('1210', 'Inventory – merchandise & finished goods', 'สินค้าคงเหลือ – สินค้าสำเร็จรูป/สินค้าซื้อมาขาย', 'asset', 'debit', 'Inventory', 'inventory', { parent: '1030', control: 'inventory', system: true }),
  A('1250', 'Inventory in transit', 'สินค้าระหว่างทาง', 'asset', 'debit', 'Inventory', 'inventory', { parent: '1030', control: 'inventory', system: true }),
  H('1040', 'Tax assets', 'สินทรัพย์ภาษี', 'asset', 'debit', 'Tax', 'tax_asset', '1000'),
  A('1300', 'Input VAT', 'ภาษีซื้อ', 'asset', 'debit', 'Tax', 'tax_asset', { parent: '1040', control: 'tax', system: true, taxCode: 'VAT7' }),
  H('1050', 'Fixed assets', 'สินทรัพย์ถาวร', 'asset', 'debit', 'Fixed assets', 'fixed_assets', '1000'),
  A('1500', 'Equipment', 'อุปกรณ์', 'asset', 'debit', 'Fixed assets', 'fixed_assets', { parent: '1050', cashFlow: 'investing' }),
  A('1590', 'Accumulated depreciation – equipment', 'ค่าเสื่อมราคาสะสม – อุปกรณ์', 'asset', 'credit', 'Fixed assets', 'fixed_assets', { parent: '1050', contra: true }),
  H('2000', 'LIABILITIES', 'หนี้สิน', 'liability', 'credit', 'Liabilities', 'payables'),
  A('2100', 'Accounts payable – suppliers', 'เจ้าหนี้การค้า – ผู้ขาย', 'liability', 'credit', 'Payables', 'payables', { parent: '2000', control: 'ap', system: true }),
  A('2110', 'Accrued expenses', 'ค่าใช้จ่ายค้างจ่าย', 'liability', 'credit', 'Payables', 'payables', { parent: '2000' }),
  A('2200', 'Output VAT', 'ภาษีขาย', 'liability', 'credit', 'Tax', 'tax_payable', { parent: '2000', control: 'tax', system: true, taxCode: 'VAT7' }),
  A('2210', 'Withholding tax payable', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย', 'liability', 'credit', 'Tax', 'tax_payable', { parent: '2000' }),
  A('2300', 'Customer credit & unapplied receipts', 'เครดิตลูกค้าและเงินรับล่วงหน้า', 'liability', 'credit', 'Customer balances', 'customer_liabilities', { parent: '2000', control: 'customer_credit', system: true }),
  A('2400', 'Loans payable', 'เงินกู้ยืม', 'liability', 'credit', 'Loans', 'loans', { parent: '2000', cashFlow: 'financing' }),
  H('3000', 'EQUITY', 'ส่วนของเจ้าของ', 'equity', 'credit', 'Equity', 'equity'),
  A('3010', "Owner's capital", 'ทุนของเจ้าของ', 'equity', 'credit', 'Equity', 'equity', { parent: '3000', cashFlow: 'financing' }),
  A('3100', 'Retained earnings', 'กำไรสะสม', 'equity', 'credit', 'Equity', 'equity', { parent: '3000', system: true }),
  A('3200', 'Owner drawings', 'เงินถอนของเจ้าของ', 'equity', 'debit', 'Equity', 'equity', { parent: '3000', contra: true, cashFlow: 'financing' }),
  H('4000', 'REVENUE', 'รายได้', 'revenue', 'credit', 'Revenue', 'revenue'),
  A('4010', 'Sales revenue', 'รายได้จากการขาย', 'revenue', 'credit', 'Revenue', 'revenue', { parent: '4000', dims: ['branch', 'channel'] }),
  A('4020', 'Other operating income', 'รายได้อื่นจากการดำเนินงาน', 'revenue', 'credit', 'Revenue', 'revenue', { parent: '4000' }),
  A('4100', 'Sales discounts', 'ส่วนลดการขาย', 'revenue', 'debit', 'Revenue', 'contra_revenue', { parent: '4000', contra: true, dims: ['branch', 'channel'] }),
  A('4200', 'Sales returns & credit notes', 'รับคืนสินค้าและใบลดหนี้', 'revenue', 'debit', 'Revenue', 'contra_revenue', { parent: '4000', contra: true, dims: ['branch', 'channel'] }),
  H('5000', 'COST OF SALES', 'ต้นทุนขาย', 'expense', 'debit', 'Cost of sales', 'cogs'),
  A('5010', 'Cost of goods sold', 'ต้นทุนสินค้าที่ขาย', 'expense', 'debit', 'Cost of sales', 'cogs', { parent: '5000', dims: ['branch', 'channel'] }),
  A('5100', 'Production waste & spoilage', 'ของเสียและสินค้าเสียหายจากการผลิต', 'expense', 'debit', 'Cost of sales', 'cogs', { parent: '5000' }),
  A('5200', 'Inventory adjustments & shrinkage', 'ปรับปรุง/สูญหายของสินค้าคงเหลือ', 'expense', 'debit', 'Cost of sales', 'cogs', { parent: '5000' }),
  A('5400', 'Labor & overhead absorbed (contra)', 'ค่าแรงและค่าโสหุ้ยที่ปันส่วนเข้าต้นทุน', 'expense', 'credit', 'Cost of sales', 'cogs', { parent: '5000', contra: true }),
  H('6000', 'OPERATING EXPENSES', 'ค่าใช้จ่ายในการดำเนินงาน', 'expense', 'debit', 'Operating expenses', 'opex'),
  A('6100', 'Marketplace commission', 'ค่าคอมมิชชันมาร์เก็ตเพลส', 'expense', 'debit', 'Channel costs', 'channel_costs', { parent: '6000', dims: ['channel'] }),
  A('6110', 'Payment processing fees', 'ค่าธรรมเนียมรับชำระเงิน', 'expense', 'debit', 'Channel costs', 'channel_costs', { parent: '6000', dims: ['channel'] }),
  A('6120', 'Shipping subsidy (seller-paid)', 'ค่าขนส่งที่ผู้ขายรับผิดชอบ', 'expense', 'debit', 'Channel costs', 'channel_costs', { parent: '6000', dims: ['channel'] }),
  A('6130', 'Marketing & promotions', 'การตลาดและส่งเสริมการขาย', 'expense', 'debit', 'Operating expenses', 'opex', { parent: '6000', dims: ['branch'] }),
  A('6200', 'Rent', 'ค่าเช่า', 'expense', 'debit', 'Operating expenses', 'opex', { parent: '6000', dims: ['branch'] }),
  A('6210', 'Utilities', 'ค่าสาธารณูปโภค', 'expense', 'debit', 'Operating expenses', 'opex', { parent: '6000', dims: ['branch'] }),
  A('6220', 'Staff costs', 'ค่าใช้จ่ายพนักงาน', 'expense', 'debit', 'Operating expenses', 'opex', { parent: '6000', dims: ['branch'] }),
  A('6300', 'Other operating expenses', 'ค่าใช้จ่ายในการดำเนินงานอื่น', 'expense', 'debit', 'Operating expenses', 'opex', { parent: '6000', dims: ['branch'] }),
  A('6400', 'Bank charges & settlement variance', 'ค่าธรรมเนียมธนาคารและผลต่างการรับชำระ', 'expense', 'debit', 'Operating expenses', 'opex', { parent: '6000' }),
  A('6500', 'Depreciation', 'ค่าเสื่อมราคา', 'expense', 'debit', 'Operating expenses', 'opex', { parent: '6000' }),
  H('7000', 'OTHER INCOME & EXPENSES', 'รายได้และค่าใช้จ่ายอื่น', 'expense', 'debit', 'Other', 'other_expense'),
  A('7100', 'Interest income', 'ดอกเบี้ยรับ', 'revenue', 'credit', 'Other', 'other_income', { parent: '7000' }),
  A('7200', 'Interest expense', 'ดอกเบี้ยจ่าย', 'expense', 'debit', 'Other', 'other_expense', { parent: '7000', cashFlow: 'financing' }),
  H('8000', 'CLEARING & SUSPENSE', 'บัญชีพัก', 'asset', 'debit', 'Clearing', 'other_assets'),
  A('8100', 'Suspense (disabled — no posting without an approved policy)', 'บัญชีพักรอจัดประเภท (ปิดใช้งาน)', 'asset', 'debit', 'Clearing', 'other_assets', { parent: '8000', system: true, active: false }),
];

// ======================================================================================
// Posting roles: the engine posts to ROLES; the setup maps each role to an account (versioned)
// ======================================================================================
export interface RoleDef { key: string; label: string; def: string; expect: FsLine[]; events: string }
export const ROLE_DEFS: RoleDef[] = [
  { key: 'cash', label: 'Cash on hand', def: '1100', expect: ['cash'], events: 'Cash receipts, refunds, cash expenses' },
  { key: 'bank', label: 'Bank – operating', def: '1110', expect: ['cash'], events: 'Transfers, QR, card, settlements, supplier payments' },
  { key: 'platform_ar', label: 'Platform receivable', def: '1120', expect: ['receivables'], events: 'Marketplace / delivery sales and settlements' },
  { key: 'ar', label: 'Customer receivable', def: '1130', expect: ['receivables'], events: 'Credit sales, customer payments, credit notes' },
  { key: 'supplier_deposit', label: 'Supplier deposit / advance', def: '1140', expect: ['other_assets', 'receivables'], events: 'Supplier prepayments and their use' },
  { key: 'inv_materials', label: 'Inventory – raw & packaging', def: '1200', expect: ['inventory'], events: 'Purchases of materials, consumption' },
  { key: 'inv_goods', label: 'Inventory – goods & finished', def: '1210', expect: ['inventory'], events: 'Purchases for resale, production output, sales' },
  { key: 'inv_transit', label: 'Inventory in transit', def: '1250', expect: ['inventory'], events: 'Warehouse transfers' },
  { key: 'input_vat', label: 'Input VAT', def: '1300', expect: ['tax_asset'], events: 'Purchases, expenses' },
  { key: 'ap', label: 'Accounts payable', def: '2100', expect: ['payables'], events: 'Goods receipts, supplier payments, supplier returns' },
  { key: 'output_vat', label: 'Output VAT', def: '2200', expect: ['tax_payable'], events: 'Sales, returns' },
  { key: 'customer_credit', label: 'Customer credit liability', def: '2300', expect: ['customer_liabilities'], events: 'Overpayments, refunds kept as credit, prepaid orders' },
  { key: 'loans', label: 'Loans payable', def: '2400', expect: ['loans'], events: 'Loan received / repaid' },
  { key: 'owner_capital', label: "Owner's capital", def: '3010', expect: ['equity'], events: 'Owner contributions, opening capital' },
  { key: 'owner_drawings', label: 'Owner drawings', def: '3200', expect: ['equity'], events: 'Owner withdrawals' },
  { key: 'sales', label: 'Sales revenue', def: '4010', expect: ['revenue'], events: 'All sales' },
  { key: 'sales_discount', label: 'Sales discounts (contra)', def: '4100', expect: ['contra_revenue'], events: 'Business-funded discounts' },
  { key: 'sales_returns', label: 'Sales returns (contra)', def: '4200', expect: ['contra_revenue'], events: 'Returns and credit notes' },
  { key: 'cogs', label: 'Cost of goods sold', def: '5010', expect: ['cogs'], events: 'Recognition of sales cost' },
  { key: 'waste', label: 'Waste & spoilage', def: '5100', expect: ['cogs'], events: 'Production waste, wasted stock' },
  { key: 'inv_adjust', label: 'Inventory adjustments / shrinkage', def: '5200', expect: ['cogs'], events: 'Counts, corrections, transfer losses' },
  { key: 'conversion_absorbed', label: 'Labor & overhead absorbed', def: '5400', expect: ['cogs'], events: 'Production & recipe conversion cost' },
  { key: 'fee_commission', label: 'Marketplace commission', def: '6100', expect: ['channel_costs'], events: 'Settlements' },
  { key: 'fee_payment', label: 'Payment processing fees', def: '6110', expect: ['channel_costs'], events: 'Settlements' },
  { key: 'fee_shipping', label: 'Shipping subsidy', def: '6120', expect: ['channel_costs'], events: 'Settlements' },
  { key: 'settlement_variance', label: 'Settlement variance / bank charges', def: '6400', expect: ['opex', 'other_expense'], events: 'Platform payout differences' },
  { key: 'interest_expense', label: 'Interest expense', def: '7200', expect: ['other_expense'], events: 'Loan interest' },
  { key: 'interest_income', label: 'Interest income', def: '7100', expect: ['other_income'], events: 'Bank interest' },
];
export const ROLE_KEYS = new Set(ROLE_DEFS.map((r) => r.key));
export const roleLabel = (k: string) => ROLE_DEFS.find((r) => r.key === k)?.label ?? k;
export const defaultPostingMap = (): Record<string, MappingEntry[]> => Object.fromEntries(ROLE_DEFS.map((r) => [r.key, [{ code: r.def, from: D0 }]]));

export function roleCode(d: DB, role: string, iso?: string): string | undefined {
  const day = dayKey(iso ?? new Date().toISOString());
  const list = d.postingMap[role] ?? [];
  let best: MappingEntry | undefined;
  for (const e of list) if (dayKey(e.from) <= day && (!best || e.from >= best.from)) best = e;
  return best?.code;
}
export const findAcct = (d: DB, code: string) => d.accounts.find((a) => a.code === code);
export const acctName = (d: DB, code: string) => findAcct(d, code)?.name ?? code;
export const invAccount = (kind: ProductKind) => (kind === 'material' || kind === 'packaging' ? 'inv_materials' : 'inv_goods');
export const cashAccount = (m: PayMethod | 'deposit') => (m === 'cash' ? 'cash' : 'bank');
export const dr = (account: string, amount: number, memo?: string): JournalLine => ({ account, debit: r2(amount), credit: 0, memo });
export const cr = (account: string, amount: number, memo?: string): JournalLine => ({ account, debit: 0, credit: r2(amount), memo });

/** Accounts selectable for expense categories (postable, P&L expense lines, active) */
export const expenseAccounts = (d: DB) => d.accounts.filter((a) => a.posting && a.active && ['opex', 'other_expense', 'channel_costs'].includes(a.fsLine) && a.type === 'expense');
export const EXPENSE_ACCOUNTS = ['6130', '6200', '6210', '6220', '6300', '6400'];

export const whDim = (d: DB, warehouseId: ID): JournalDim | undefined => { const b = d.warehouses.find((w) => w.id === warehouseId)?.branchId; return b ? { branchId: b } : undefined; };

export function isLocked(d: DB, date: string) {
  return !!d.meta.lockedUntil && dayKey(date) <= d.meta.lockedUntil;
}

// ======================================================================================
// Tax register (versioned by effective date)
// ======================================================================================
export function defaultTaxCodes(): TaxCode[] {
  return [
    { id: 'TX1', code: 'VAT7', name: 'VAT standard 7%', kind: 'vat', rate: 0.07, creditable: true, effectiveFrom: D0, version: 1, note: 'Standard output/input VAT. Confirm applicable rate and any reduced-rate period with your accountant.' },
    { id: 'TX2', code: 'VAT0', name: 'VAT zero-rated', kind: 'zero', rate: 0, creditable: true, effectiveFrom: D0, version: 1 },
    { id: 'TX3', code: 'EXEMPT', name: 'VAT exempt', kind: 'exempt', rate: 0, creditable: false, effectiveFrom: D0, version: 1 },
    { id: 'TX4', code: 'OOS', name: 'Out of scope / not VAT registered', kind: 'out_of_scope', rate: 0, creditable: false, effectiveFrom: D0, version: 1 },
    { id: 'TX5', code: 'VAT7NC', name: 'VAT 7% non-creditable (input)', kind: 'non_creditable', rate: 0.07, creditable: false, effectiveFrom: D0, version: 1, note: 'Input VAT that cannot be recovered; capitalised into cost.' },
  ];
}
export function taxAt(d: DB, code: string, iso: string): TaxCode | undefined {
  const day = dayKey(iso);
  return d.taxCodes.filter((t) => t.code === code && dayKey(t.effectiveFrom) <= day && (!t.effectiveTo || dayKey(t.effectiveTo) >= day)).sort((a, b) => b.version - a.version)[0];
}
/** Tax treatment applied to a sale at a moment in time (snapshotted on the order) */
export function saleTax(d: DB, iso: string): { code: string; rate: number; version: number } {
  const code = d.org.vatRegistered ? d.org.defaultTaxCode : 'OOS';
  const t = taxAt(d, code, iso) ?? taxAt(d, 'OOS', iso);
  return { code: t?.code ?? 'OOS', rate: t?.rate ?? 0, version: t?.version ?? 0 };
}
export function purchaseVatRate(d: DB, iso: string): number {
  return d.org.vatRegistered ? taxAt(d, 'VAT7', iso)?.rate ?? 0 : 0;
}

// ======================================================================================
// Posting
// ======================================================================================
export function resolveLine(d: DB, account: string, date: string, opts?: { allowInactive?: boolean }): string {
  let code = account;
  if (ROLE_KEYS.has(account)) {
    const c = roleCode(d, account, date);
    if (!c) fail('UNMAPPED_ACCOUNT', `No account is mapped for “${roleLabel(account)}” on ${dayKey(date)}. Complete Accounting setup → Transaction mapping before posting. (No suspense posting is allowed.)`);
    code = c!;
  }
  const a = findAcct(d, code) || fail('BAD_ACCOUNT', `Unknown account ${code}`);
  if (!opts?.allowInactive) {
    if (!a!.posting) fail('HEADER_ACCOUNT', `${a!.code} ${a!.name} is a header account and cannot accept postings`);
    if (!a!.active || (a!.inactiveFrom && dayKey(a!.inactiveFrom) <= dayKey(date))) fail('INACTIVE_ACCOUNT', `${a!.code} ${a!.name} is inactive`);
    if (dayKey(a!.effectiveFrom) > dayKey(date)) fail('INACTIVE_ACCOUNT', `${a!.code} ${a!.name} is not effective until ${dayKey(a!.effectiveFrom)}`);
  }
  return code;
}

export function post(
  d: DB, ctx: Ctx,
  p: { memo: string; refType: string; refId?: ID; lines: JournalLine[]; date?: string; manual?: boolean; reverses?: ID; dim?: JournalDim; approvedBy?: ID; allowInactive?: boolean; info?: Journal['info'] },
): ID | undefined {
  const date = p.date ?? ctx.now;
  const lines = p.lines
    .filter((l) => Math.abs(l.debit) > 0.0049 || Math.abs(l.credit) > 0.0049)
    .map((l) => ({ ...l, account: resolveLine(d, l.account, date, { allowInactive: p.allowInactive }) }));
  if (!lines.length) return undefined;
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
  if (!ctx.seed && isLocked(d, date)) fail('PERIOD_LOCKED', `Accounting period is locked through ${d.meta.lockedUntil}. Reopen the period or post to a later date.`);
  const id = nid(d, 'JV');
  d.journals.push({
    id, no: docNo(d, 'JV'), date, memo: p.memo, refType: p.refType, refId: p.refId, lines, status: 'posted',
    createdBy: ctx.userId, manual: p.manual, reverses: p.reverses, dim: p.dim, approvedBy: p.approvedBy, info: p.info,
  });
  return id;
}

export function reverseJournal(d: DB, ctx: Ctx, journalId: ID, reason: string): ID {
  const j = d.journals.find((x) => x.id === journalId) || fail('NOT_FOUND', 'Journal not found');
  if (j.status === 'reversed') fail('ALREADY', 'Journal already reversed');
  if (j.reverses) fail('INVALID', 'A reversal entry cannot itself be reversed');
  if (!reason.trim()) fail('REASON', 'A reason is required for a reversal');
  const rid = post(d, ctx, {
    memo: `Reversal of ${j.no}: ${reason}`, refType: 'reversal', refId: j.id, reverses: j.id, dim: j.dim, allowInactive: true,
    lines: j.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, memo: l.memo })),
  })!;
  j.status = 'reversed';
  j.reversedBy = rid;
  audit(d, ctx, 'journal.reverse', 'journal', j.id, `Reversed ${j.no}: ${reason}`, 'warn');
  return rid;
}

/** Internal: direct posting of a manual journal. The UI goes through the draft → approval workflow instead. */
export function postManualJournal(d: DB, ctx: Ctx, p: { date: string; memo: string; lines: JournalLine[]; approvedBy?: ID }): ID {
  const id = post(d, ctx, { ...p, refType: 'manual', manual: true });
  if (!id) fail('EMPTY', 'Journal has no lines');
  audit(d, ctx, 'journal.manual', 'journal', id, p.memo, 'warn');
  return id!;
}

export function closePeriod(d: DB, ctx: Ctx, throughDay: string) {
  guard(d, ctx, 'accounting:close');
  if (d.meta.lockedUntil && throughDay < d.meta.lockedUntil) fail('INVALID', 'Use reopen to move the lock backwards');
  d.meta.lockedUntil = throughDay;
  audit(d, ctx, 'period.close', 'period', throughDay, `Accounting period locked through ${throughDay}`, 'critical');
}
export function reopenPeriod(d: DB, ctx: Ctx, throughDay: string | null, reason: string) {
  guard(d, ctx, 'accounting:close');
  if (!reason.trim()) fail('REASON', 'A reason is required to reopen a period');
  d.meta.lockedUntil = throughDay;
  audit(d, ctx, 'period.reopen', 'period', throughDay ?? 'none', `Lock moved to ${throughDay ?? 'none'}: ${reason}`, 'critical');
}

export function addExpense(
  d: DB, ctx: Ctx,
  p: { date: string; account: string; vendor: string; amount: number; vat?: number; paidFrom: 'cash' | 'bank'; branchId?: ID; note?: string; mediaId?: ID },
): ID {
  guard(d, ctx, 'accounting:create');
  if (!(p.amount > 0)) fail('INVALID', 'Amount must be greater than zero');
  const acct = findAcct(d, p.account);
  if (!acct || acct.type !== 'expense') fail('BAD_ACCOUNT', 'Choose an expense account');
  const vat = r2(p.vat ?? 0);
  const net = r2(p.amount - vat);
  const id = nid(d, 'EX');
  const jid = post(d, ctx, {
    date: p.date, memo: `Expense: ${p.vendor}`, refType: 'expense', refId: id, dim: p.branchId ? { branchId: p.branchId } : undefined,
    lines: [dr(p.account, net), dr('input_vat', vat), cr(p.paidFrom === 'cash' ? 'cash' : 'bank', p.amount)],
  });
  const e: Expense = { id, no: docNo(d, 'EXP'), date: p.date, account: p.account, vendor: p.vendor, amount: p.amount, vat, paidFrom: p.paidFrom, branchId: p.branchId, note: p.note, journalId: jid, mediaId: p.mediaId };
  d.expenses.push(e);
  return id;
}

// ======================================================================================
// Reporting helpers (pure, over a journal list)
// ======================================================================================
export interface Bal { debit: number; credit: number }
export function balancesBetween(journals: Journal[], fromDay?: string, toDay?: string, dim?: JournalDim): Record<string, Bal> {
  const out: Record<string, Bal> = {};
  for (const j of journals) {
    const k = dayKey(j.date);
    if (fromDay && k < fromDay) continue;
    if (toDay && k > toDay) continue;
    if (dim?.branchId && j.dim?.branchId !== dim.branchId) continue;
    if (dim?.channel && j.dim?.channel !== dim.channel) continue;
    for (const l of j.lines) {
      const b = (out[l.account] ||= { debit: 0, credit: 0 });
      b.debit += l.debit;
      b.credit += l.credit;
    }
  }
  return out;
}
export function natBal(acc: Account, b?: Bal): number {
  if (!b) return 0;
  return r2(acc.normal === 'debit' ? b.debit - b.credit : b.credit - b.debit);
}
export function netDebit(b?: Bal): number {
  return b ? r2(b.debit - b.credit) : 0;
}
/** Σ of natural balances over accounts matching a predicate (e.g. all cash accounts) */
export function sumAccounts(d: DB, bal: Record<string, Bal>, pred: (a: Account) => boolean): number {
  return r2(d.accounts.filter(pred).reduce((s, a) => s + natBal(a, bal[a.code]), 0));
}
/** Signed Σ (debit − credit) over accounts matching a predicate */
export function sumNetDebit(d: DB, bal: Record<string, Bal>, pred: (a: Account) => boolean): number {
  return r2(d.accounts.filter(pred).reduce((s, a) => s + netDebit(bal[a.code]), 0));
}
export const isControl = (k: Account['control']) => (a: Account) => a.control === k;
export const isFs = (...f: FsLine[]) => (a: Account) => f.includes(a.fsLine);
