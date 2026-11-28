// Small shared pieces of the Daily Expenses screens.
import { createContext, useContext, type ReactNode } from 'react';
import { Boxes, Bus, Droplets, Fuel, Home, Landmark, Megaphone, Package, Paperclip, Receipt, ShoppingBag, Truck, Users, Utensils, Wifi, Wrench, Zap, type LucideIcon } from 'lucide-react';
import { Badge } from '../ui/kit';
import { useLang } from '../domain/store';
import { STATUS_META, canDo, type BankOption, type Category, type ExpenseCap, type ExpenseRole, type ProductOption, type Settings, type Status } from './api';
import type { ClaimForPosting } from '../domain/expenseLedger';
import type { Claim } from './api';

const ICONS: Record<string, LucideIcon> = { paperclip: Paperclip, zap: Zap, droplets: Droplets, wifi: Wifi, bus: Bus, fuel: Fuel, utensils: Utensils, users: Users, home: Home, wrench: Wrench, megaphone: Megaphone, truck: Truck, landmark: Landmark, package: Package, receipt: Receipt, boxes: Boxes, 'shopping-bag': ShoppingBag };
export const CatIcon = ({ name, size = 22 }: { name?: string; size?: number }) => { const I = ICONS[name ?? 'receipt'] ?? Receipt; return <I size={size} />; };

export function StatusBadge({ status }: { status: Status }) {
  const lang = useLang();
  const m = STATUS_META[status];
  return <Badge tone={m.tone} dot>{lang === 'th' ? m.th : m.en}</Badge>;
}

export interface ExpenseCtxValue {
  role: ExpenseRole | null; userId: string; settings: Settings; categories: Category[]; catById: Record<string, Category>;
  /** true inside the back office (Accounting device): the local ledger is available for posting and reports */
  backoffice: boolean; reloadConfig: () => Promise<void>; can: (cap: ExpenseCap) => boolean;
  /** the active products of the central catalogue and the active bank accounts (empty when the database does not offer them) */
  products: ProductOption[]; productBySku: Record<string, ProductOption>; banks: BankOption[]; bankById: Record<string, BankOption>;
}
export const ExpenseCtx = createContext<ExpenseCtxValue | null>(null);
export const useExpense = () => { const v = useContext(ExpenseCtx); if (!v) throw new Error('ExpenseCtx missing'); return v; };

/** Claim + its category -> what the ledger needs for validation / posting. */
export function claimToPosting(c: Claim, cat: Category | undefined, extra?: { attachmentCount?: number; postingDate?: string | null; vendorTaxId?: string | null; reviewed?: boolean }): ClaimForPosting {
  return {
    id: c.id, expenseNo: c.expense_no ?? 'EXP', expenseDate: c.expense_date, postingDate: extra?.postingDate ?? c.posting_date, description: c.description, vendor: c.vendor, vendorTaxId: extra?.vendorTaxId ?? c.vendor_tax_id,
    amountPaid: Number(c.amount_paid), vatAmount: Number(c.vat_amount), taxType: c.tax_type, whtAmount: Number(c.wht_amount), paidFrom: c.paid_from, paymentMethod: c.payment_method, treatment: c.treatment,
    categoryCode: cat?.code ?? c.category?.code ?? '', categoryNameEn: cat?.name_en ?? c.category?.name_en ?? '', categoryNameTh: cat?.name_th ?? c.category?.name_th ?? '', accountCode: cat?.account_code ?? null,
    accountOverride: c.account_override, branchId: c.branch_id, reviewed: extra?.reviewed ?? !!c.reviewed_at, attachmentCount: extra?.attachmentCount, approvedAt: c.approved_at,
  };
}

export interface QueueLine { side: 'dr' | 'cr'; role: string; amount: number; bankAccountId?: string }
/** The journal the database will queue when this claim is approved & posted (the same rules as expense_post_one): debit the expense / stock
 *  account (the accountant's override, else the category's posting role or account), input VAT when it is claimable, credit cash or that bank
 *  account with the money that left, and the withholding-tax account. Pure; for showing it before anything is saved. */
export function queuePlan(c: Pick<Claim, 'amount_paid' | 'vat_amount' | 'wht_amount' | 'tax_type' | 'paid_from' | 'bank_account_id' | 'account_override'>, cat: Pick<Category, 'posting_role' | 'account_code'> | undefined, whtAccount: string): { lines: QueueLine[]; debit: string | null } {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const paid = r2(Number(c.amount_paid)), vat = r2(Number(c.vat_amount)), wht = r2(Number(c.wht_amount));
  const debit = c.account_override || cat?.posting_role || cat?.account_code || null;
  if (!debit) return { lines: [], debit: null };
  const creditable = vat > 0 && (c.tax_type === 'vat_included' || c.tax_type === 'vat_excluded');
  const lines: QueueLine[] = [{ side: 'dr', role: debit, amount: creditable ? r2(paid - vat) : paid }];
  if (creditable) lines.push({ side: 'dr', role: 'input_vat', amount: vat });
  lines.push({ side: 'cr', role: c.paid_from === 'cash' ? 'cash' : 'bank', amount: r2(paid - wht), ...(c.paid_from === 'bank' && c.bank_account_id ? { bankAccountId: c.bank_account_id } : {}) });
  if (wht > 0) lines.push({ side: 'cr', role: whtAccount, amount: wht });
  return { lines, debit };
}

export const Section =({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) => (
  <div className="exp-section"><div className="exp-section-h"><b>{title}</b>{hint && <span className="muted">{hint}</span>}</div>{children}</div>
);
