// Small shared pieces of the Daily Expenses screens.
import { createContext, useContext, type ReactNode } from 'react';
import { Bus, Droplets, Fuel, Home, Landmark, Megaphone, Package, Paperclip, Receipt, Truck, Users, Utensils, Wifi, Wrench, Zap, type LucideIcon } from 'lucide-react';
import { Badge } from '../ui/kit';
import { useLang } from '../domain/store';
import { STATUS_META, canDo, type Category, type ExpenseCap, type ExpenseRole, type Settings, type Status } from './api';
import type { ClaimForPosting } from '../domain/expenseLedger';
import type { Claim } from './api';

const ICONS: Record<string, LucideIcon> = { paperclip: Paperclip, zap: Zap, droplets: Droplets, wifi: Wifi, bus: Bus, fuel: Fuel, utensils: Utensils, users: Users, home: Home, wrench: Wrench, megaphone: Megaphone, truck: Truck, landmark: Landmark, package: Package, receipt: Receipt };
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

export const Section = ({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) => (
  <div className="exp-section"><div className="exp-section-h"><b>{title}</b>{hint && <span className="muted">{hint}</span>}</div>{children}</div>
);
