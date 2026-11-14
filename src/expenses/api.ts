// Daily expenses: data access. Everything goes through the signed-in user's Supabase session. RLS limits what is readable and the
// SECURITY DEFINER functions in supabase/migrations/*_daily_expenses.sql own every write: they recompute VAT / WHT, enforce the
// status machine, separation of duties and the audit trail. The client never sends a status or a computed amount as truth.
import { supabase } from '../lib/supabase';
import { useLang } from '../domain/store';
import type { TaxType, Treatment } from '../domain/expenseLedger';

export type ExpenseRole = 'employee' | 'manager' | 'accountant' | 'admin';
export type ExpenseCap = 'create' | 'view_all' | 'approve' | 'post' | 'config' | 'manage_roles';
const CAPS: Record<ExpenseCap, ExpenseRole[]> = {
  create: ['employee', 'manager', 'accountant', 'admin'], view_all: ['manager', 'accountant', 'admin'], approve: ['manager', 'admin'],
  post: ['accountant', 'admin'], config: ['accountant', 'admin'], manage_roles: ['admin'],
};
/** UI hint only: the database enforces the same table (public.expense_can). */
export const canDo = (role: ExpenseRole | null, cap: ExpenseCap) => !!role && CAPS[cap].includes(role);

export type Status = 'draft' | 'submitted' | 'approved' | 'rejected' | 'posted' | 'cancelled';
export type PayMethod = 'cash' | 'bank_transfer' | 'qr' | 'card';

export interface Category {
  id: string; code: string; name_en: string; name_th: string; icon: string; sort: number; treatment: Treatment; account_code: string | null;
  default_tax_type: TaxType; default_wht_rate: number | null; hint_en: string | null; hint_th: string | null; active: boolean;
}
export interface Settings { vat_registered: boolean; vat_rate: number; wht_account_code: string; fixed_asset_account_code: string; fixed_asset_warn_amount: number }
export interface Attachment { id: string; expense_id: string; file_path: string; file_name: string; mime: string; size_bytes: number; uploaded_at: string }
export interface EventRow { id: number; action: string; from_status: string | null; to_status: string | null; actor_name: string | null; at: string; note: string | null; detail: Record<string, unknown> | null }
export interface Claim {
  id: string; expense_no: string | null; created_by: string; created_by_name: string | null; expense_date: string; payment_date: string; category_id: string;
  description: string; vendor: string | null; vendor_tax_id: string | null; reference_no: string | null; notes: string | null; payment_method: PayMethod; paid_from: 'cash' | 'bank';
  tax_type: TaxType; vat_rate: number; amount_paid: number; vat_amount: number; wht_rate: number; wht_amount: number; treatment: Treatment; account_override: string | null; branch_id: string | null;
  status: Status; submitted_at: string | null; approved_by: string | null; approved_at: string | null; approval_note: string | null; rejected_at: string | null; reject_reason: string | null;
  reviewed_at: string | null; review_note: string | null; posted_at: string | null; posting_date: string | null; journal_no: string | null; posted_ref: string | null;
  cancelled_at: string | null; cancel_reason: string | null; reversal_journal_no: string | null; created_at: string;
  category?: Pick<Category, 'code' | 'name_en' | 'name_th' | 'icon'> | null;
}
export interface DashboardData {
  today_total: number; month_total: number; range_total: number;
  by_status: Partial<Record<Status, { n: number; amount: number }>>;
  by_category: { category_id: string; code: string; name_en: string; name_th: string; icon: string; n: number; amount: number }[];
  by_method: { method: PayMethod; n: number; amount: number }[];
}
export interface ClaimFilters { from?: string; to?: string; status?: Status | ''; category?: string; method?: PayMethod | ''; employee?: string; q?: string }
export interface StaffRow { user_id: string; email: string; display_name: string | null; profile_role: string; expense_role: string | null }

const OFFLINE = 'Cannot reach the database. Check the internet connection and try again.';
function must<T>(r: { data: T | null; error: { message: string; code?: string } | null }, what?: string): T {
  if (r.error) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error(OFFLINE);
    if (/failed to fetch|networkerror|load failed/i.test(r.error.message)) throw new Error(OFFLINE);
    throw new Error(what ? `${what}: ${r.error.message}` : r.error.message);
  }
  return r.data as T;
}

export const STATUS_META: Record<Status, { en: string; th: string; tone: 'good' | 'warn' | 'bad' | 'info' | '' }> = {
  draft: { en: 'Draft', th: 'แบบร่าง', tone: '' }, submitted: { en: 'Pending approval', th: 'รออนุมัติ', tone: 'warn' }, approved: { en: 'Approved', th: 'อนุมัติแล้ว', tone: 'info' },
  rejected: { en: 'Rejected', th: 'ไม่อนุมัติ', tone: 'bad' }, posted: { en: 'Posted', th: 'บันทึกบัญชีแล้ว', tone: 'good' }, cancelled: { en: 'Cancelled', th: 'ยกเลิก', tone: '' },
};
export const METHOD_META: Record<PayMethod, { en: string; th: string }> = {
  cash: { en: 'Cash', th: 'เงินสด' }, bank_transfer: { en: 'Bank transfer', th: 'โอนเงินผ่านธนาคาร' }, qr: { en: 'QR / PromptPay', th: 'QR / พร้อมเพย์' }, card: { en: 'Card', th: 'บัตร' },
};
export const TAX_META: Record<TaxType, { en: string; th: string; helpEn: string; helpTh: string }> = {
  none: { en: 'No VAT', th: 'ไม่มี VAT', helpEn: 'Receipt without VAT, or the shop is not VAT-registered.', helpTh: 'ใบเสร็จไม่มี VAT หรือร้านค้านั้นไม่ได้จด VAT' },
  vat_included: { en: 'VAT included in the amount', th: 'ราคารวม VAT แล้ว', helpEn: 'You paid 107 and the receipt shows VAT 7 inside.', helpTh: 'จ่าย 107 บาท และในใบเสร็จมี VAT 7 บาทรวมอยู่ในนั้น' },
  vat_excluded: { en: 'VAT added on top', th: 'ราคายังไม่รวม VAT (บวกเพิ่ม)', helpEn: 'The price is 100 and VAT 7 is added: you pay 107.', helpTh: 'ราคา 100 บาท บวก VAT 7 บาท จ่ายจริง 107 บาท' },
  vat_noncreditable: { en: 'VAT that cannot be claimed', th: 'VAT ขอคืนไม่ได้', helpEn: 'VAT is in the amount but cannot be claimed (e.g. entertainment, no valid tax invoice).', helpTh: 'มี VAT รวมอยู่แต่ขอคืนภาษีซื้อไม่ได้ (เช่น ค่ารับรอง หรือไม่มีใบกำกับภาษีที่ใช้ได้)' },
};

/** Inline Thai / English text: `const T = useT(); T('Amount', 'จำนวนเงิน')`. */
export function useT() {
  const lang = useLang();
  return (en: string, th: string) => (lang === 'th' ? th : en);
}
export const catName = (lang: string, c?: { name_en: string; name_th: string } | null) => (c ? (lang === 'th' ? c.name_th : c.name_en) : '');

// ---------------------------------------------------------------------------------------------- reads
export async function myRole(): Promise<ExpenseRole | null> {
  const r = await supabase.rpc('expense_role');
  return must(r) as ExpenseRole | null;
}
export async function loadCategories(): Promise<Category[]> {
  return must(await supabase.from('expense_categories').select('*').order('sort').order('name_en')) as Category[];
}
export async function loadSettings(): Promise<Settings> {
  return must(await supabase.from('expense_settings').select('vat_registered, vat_rate, wht_account_code, fixed_asset_account_code, fixed_asset_warn_amount').eq('id', 1).single()) as Settings;
}
const COLS = '*, category:expense_categories(code, name_en, name_th, icon)';
export async function listClaims(f: ClaimFilters, page = 0, size = 50): Promise<{ rows: Claim[]; total: number }> {
  let q = supabase.from('expense_claims').select(COLS, { count: 'exact' });
  if (f.from) q = q.gte('expense_date', f.from);
  if (f.to) q = q.lte('expense_date', f.to);
  if (f.status) q = q.eq('status', f.status);
  if (f.category) q = q.eq('category_id', f.category);
  if (f.method) q = q.eq('payment_method', f.method);
  if (f.employee) q = q.eq('created_by', f.employee);
  const term = f.q?.trim().replace(/[,()%*]/g, ' ');
  if (term) q = q.or(`description.ilike.%${term}%,vendor.ilike.%${term}%,expense_no.ilike.%${term}%,reference_no.ilike.%${term}%`);
  const r = await q.order('expense_date', { ascending: false }).order('created_at', { ascending: false }).range(page * size, page * size + size - 1);
  if (r.error) must(r);
  return { rows: (r.data ?? []) as unknown as Claim[], total: r.count ?? 0 };
}
export async function getClaim(id: string): Promise<{ claim: Claim; attachments: Attachment[]; events: EventRow[] }> {
  const claim = must(await supabase.from('expense_claims').select(COLS).eq('id', id).single()) as unknown as Claim;
  const attachments = must(await supabase.from('expense_attachments').select('*').eq('expense_id', id).order('uploaded_at')) as Attachment[];
  const events = must(await supabase.from('expense_events').select('id, action, from_status, to_status, actor_name, at, note, detail').eq('expense_id', id).order('at').order('id')) as EventRow[];
  return { claim, attachments, events };
}
export async function dashboard(f: ClaimFilters): Promise<DashboardData> {
  const r = await supabase.rpc('expense_dashboard', { p_from: f.from || null, p_to: f.to || null, p_status: f.status || null, p_category: f.category || null, p_method: f.method || null, p_employee: f.employee || null });
  return must(r) as DashboardData;
}
export async function signedUrl(path: string): Promise<string> {
  const r = await supabase.storage.from('expense-receipts').createSignedUrl(path, 120);
  if (r.error || !r.data) throw new Error(r.error?.message ?? 'Cannot open the file');
  return r.data.signedUrl;
}

// ---------------------------------------------------------------------------------------------- employee actions
export interface ClaimInput {
  id?: string | null; expenseDate: string; categoryId: string; description: string; amount: number; taxType: TaxType; paymentMethod: PayMethod;
  vendor?: string; vendorTaxId?: string; referenceNo?: string; notes?: string;
}
export async function saveClaim(i: ClaimInput): Promise<Claim> {
  const r = await supabase.rpc('expense_save', {
    p_id: i.id ?? null, p_expense_date: i.expenseDate, p_category: i.categoryId, p_description: i.description, p_amount: i.amount, p_tax_type: i.taxType, p_payment_method: i.paymentMethod,
    p_vendor: i.vendor ?? null, p_vendor_tax_id: i.vendorTaxId ?? null, p_reference_no: i.referenceNo ?? null, p_notes: i.notes ?? null,
  });
  return must(r) as Claim;
}
export const submitClaim = async (id: string) => must(await supabase.rpc('expense_submit', { p_id: id })) as Claim;
export const cancelClaim = async (id: string, reason: string) => must(await supabase.rpc('expense_cancel', { p_id: id, p_reason: reason })) as Claim;
export const approveClaim = async (id: string, note: string) => must(await supabase.rpc('expense_approve', { p_id: id, p_note: note || null })) as Claim;
export const rejectClaim = async (id: string, reason: string) => must(await supabase.rpc('expense_reject', { p_id: id, p_reason: reason })) as Claim;
export const removeAttachment = async (id: string) => { must(await supabase.rpc('expense_remove_attachment', { p_attachment: id })); };

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const MAX = 5 * 1024 * 1024;
/** Phone photos are often 5–12 MB: shrink images (long edge 1600 px, JPEG) so they fit the 5 MB limit and upload fast on mobile data. */
export async function prepareReceipt(file: File): Promise<{ blob: Blob; name: string; mime: string }> {
  if (!ALLOWED.includes(file.type)) throw new Error('Only photos (JPEG, PNG, WebP) and PDF files can be attached.');
  const base = file.name.replace(/\.[^.]+$/, '') || 'receipt';
  if (file.type !== 'application/pdf' && file.size > 800 * 1024) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
      if (blob && blob.size < file.size) return { blob, name: `${base}.jpg`, mime: 'image/jpeg' };
    } catch { /* cannot decode here (e.g. HEIC on some browsers): fall back to the original if it fits */ }
  }
  if (file.size > MAX) throw new Error('The file is larger than 5 MB. Take the photo again at a lower quality or attach a smaller file.');
  return { blob: file, name: file.name, mime: file.type };
}
export async function addAttachment(claim: { id: string; created_by: string }, file: File): Promise<Attachment> {
  const p = await prepareReceipt(file);
  const ext = p.mime === 'application/pdf' ? 'pdf' : p.mime === 'image/png' ? 'png' : p.mime === 'image/webp' ? 'webp' : p.mime.startsWith('image/hei') ? 'heic' : 'jpg';
  const path = `${claim.created_by}/${claim.id}/${(crypto.randomUUID?.() ?? String(Date.now()))}.${ext}`;
  const up = await supabase.storage.from('expense-receipts').upload(path, p.blob, { contentType: p.mime, upsert: false });
  if (up.error) must({ data: null, error: up.error }, 'Upload failed');
  const r = await supabase.rpc('expense_add_attachment', { p_expense: claim.id, p_path: path, p_name: p.name.slice(0, 200), p_mime: p.mime, p_size: p.blob.size });
  return must(r) as Attachment;
}

// ---------------------------------------------------------------------------------------------- accountant actions
export interface ReviewInput { taxType: TaxType; vatAmount: number; whtRate: number; treatment: Treatment; accountOverride: string; branchId: string; note: string }
export async function reviewClaim(id: string, i: ReviewInput): Promise<Claim> {
  const r = await supabase.rpc('expense_review', { p_id: id, p_tax_type: i.taxType, p_vat_amount: i.vatAmount, p_wht_rate: i.whtRate, p_treatment: i.treatment, p_account_override: i.accountOverride || null, p_branch: i.branchId || null, p_note: i.note || null });
  return must(r) as Claim;
}
export const markPosted = async (id: string, journalNo: string, postingDate: string) =>
  must(await supabase.rpc('expense_mark_posted', { p_id: id, p_journal_no: journalNo, p_posting_date: postingDate, p_posted_ref: `EXPCLAIM:${id}` })) as Claim;
export const markReversed = async (id: string, reversalNo: string, reason: string) =>
  must(await supabase.rpc('expense_mark_reversed', { p_id: id, p_reversal_journal_no: reversalNo, p_reason: reason })) as Claim;

// ---------------------------------------------------------------------------------------------- configuration
export async function saveCategory(c: Partial<Category> & { name_en: string; name_th: string; code: string }): Promise<Category> {
  const r = await supabase.rpc('expense_category_save', {
    p_id: c.id ?? null, p_code: c.code, p_name_en: c.name_en, p_name_th: c.name_th, p_icon: c.icon ?? 'receipt', p_sort: c.sort ?? 100, p_treatment: c.treatment ?? 'expense',
    p_account_code: c.account_code ?? null, p_default_tax_type: c.default_tax_type ?? 'none', p_default_wht_rate: c.default_wht_rate ?? null, p_hint_en: c.hint_en ?? null, p_hint_th: c.hint_th ?? null, p_active: c.active ?? true,
  });
  return must(r) as Category;
}
export const saveSettings = async (s: Settings) =>
  must(await supabase.rpc('expense_settings_save', { p_vat_registered: s.vat_registered, p_vat_rate: s.vat_rate, p_wht_account: s.wht_account_code, p_fixed_asset_account: s.fixed_asset_account_code, p_warn_amount: s.fixed_asset_warn_amount })) as Settings;
export const loadStaff = async () => must(await supabase.rpc('expense_staff')) as StaffRow[];
export const setRole = async (userId: string, role: string | null) => { must(await supabase.rpc('expense_set_role', { p_user: userId, p_role: role })); };
