// Daily expenses: data access. Everything goes through the signed-in user's Supabase session. RLS limits what is readable and the
// SECURITY DEFINER functions in supabase/migrations/*_daily_expenses.sql own every write: they recompute VAT / WHT, enforce the
// status machine, separation of duties and the audit trail. The client never sends a status or a computed amount as truth.
import { supabase } from '../lib/supabase';
import { useLang } from '../domain/store';
import type { TaxType, Treatment } from '../domain/expenseLedger';

export type ExpenseRole = 'employee' | 'manager' | 'accountant' | 'admin';
export type ExpenseCap = 'create' | 'view_all' | 'approve' | 'approve_post' | 'post' | 'config' | 'manage_roles';
const CAPS: Record<ExpenseCap, ExpenseRole[]> = {
  create: ['employee', 'manager', 'accountant', 'admin'], view_all: ['manager', 'accountant', 'admin'], approve: ['manager', 'admin'], approve_post: ['manager', 'accountant', 'admin'],
  post: ['accountant', 'admin'], config: ['accountant', 'admin'], manage_roles: ['admin'],
};
/** UI hint only: the database enforces the same table (public.expense_can). */
export const canDo = (role: ExpenseRole | null, cap: ExpenseCap) => !!role && CAPS[cap].includes(role);

export type Status = 'draft' | 'submitted' | 'approved' | 'rejected' | 'posted' | 'cancelled';
export type PayMethod = 'cash' | 'bank_transfer' | 'qr' | 'card';

export interface Category {
  id: string; code: string; name_en: string; name_th: string; icon: string; sort: number; treatment: Treatment; account_code: string | null;
  default_tax_type: TaxType; default_wht_rate: number | null; hint_en: string | null; hint_th: string | null; active: boolean;
  /** a stock category (treatment 'inventory'): the ledger posting role it debits, and the catalogue class (FG / RM) it receives */
  posting_role?: string | null; product_class?: 'FG' | 'RM' | null;
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
  /** the catalogue product (public.sku_registry), the bank account a transfer / QR was paid from, the queued journal and the bank movement */
  sku_code?: string | null; bank_account_id?: string | null; gl_queue_id?: string | null; bank_txn_id?: string | null; reviewed_by?: string | null; posted_by?: string | null;
  category?: Pick<Category, 'code' | 'name_en' | 'name_th' | 'icon'> | null;
}
export interface DashboardData {
  today_total: number; month_total: number; range_total: number;
  by_status: Partial<Record<Status, { n: number; amount: number }>>;
  by_category: { category_id: string; code: string; name_en: string; name_th: string; icon: string; n: number; amount: number }[];
  by_method: { method: PayMethod; n: number; amount: number }[];
}
export interface ClaimFilters { from?: string; to?: string; status?: Status | 'open' | ''; category?: string; method?: PayMethod | ''; employee?: string; q?: string; bank?: string }
/** statuses that are recorded but not in the books yet: what "Approve & post" works on */
export const OPEN_STATUSES: Status[] = ['draft', 'submitted', 'approved'];
/** a product of the central catalogue, as the expense screen may see it (no prices) */
export interface ProductOption { sku_code: string; name_th: string; name_en: string; brand: string | null; unit_th: string | null; unit_en: string | null; sku_category: 'FG' | 'RM' | 'WIP'; product_type: string | null; category_id: string | null }
/** an active bank account, enough to tell them apart */
export interface BankOption { id: string; code: string; bank_name_th: string; bank_name_en: string; account_name: string; last4: string; active: boolean }
export const needsBank = (m: PayMethod) => m === 'bank_transfer' || m === 'qr';
export const bankLabel = (lang: string, b?: Pick<BankOption, 'code' | 'bank_name_th' | 'bank_name_en' | 'last4' | 'account_name'> | null, long = false) =>
  (b ? `${b.code} · ${lang === 'th' ? b.bank_name_th : b.bank_name_en} ••${b.last4}${long ? ` (${b.account_name})` : ''}` : '');
export const CLASS_META: Record<ProductOption['sku_category'], { en: string; th: string }> = {
  RM: { en: 'Raw material', th: 'วัตถุดิบ' }, WIP: { en: 'Work in process', th: 'งานระหว่างทำ' }, FG: { en: 'Finished goods', th: 'สินค้าสำเร็จรูป' },
};
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
  draft: { en: 'Draft', th: 'แบบร่าง', tone: '' }, submitted: { en: 'Submitted (old step)', th: 'ส่งแล้ว (ขั้นตอนเดิม)', tone: 'warn' }, approved: { en: 'Approved (old step)', th: 'อนุมัติแล้ว (ขั้นตอนเดิม)', tone: 'info' },
  rejected: { en: 'Sent back', th: 'ส่งกลับให้แก้ไข', tone: 'bad' }, posted: { en: 'Posted', th: 'บันทึกบัญชีแล้ว', tone: 'good' }, cancelled: { en: 'Cancelled', th: 'ยกเลิก', tone: '' },
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
  if (f.status === 'open') q = q.in('status', OPEN_STATUSES);
  else if (f.status) q = q.eq('status', f.status);
  if (f.bank) q = q.eq('bank_account_id', f.bank);
  if (f.category) q = q.eq('category_id', f.category);
  if (f.method) q = q.eq('payment_method', f.method);
  if (f.employee) q = q.eq('created_by', f.employee);
  const term = f.q?.trim().replace(/[,()%*]/g, ' ');
  if (term) q = q.or(`description.ilike.%${term}%,vendor.ilike.%${term}%,expense_no.ilike.%${term}%,reference_no.ilike.%${term}%`);
  const r = await q.order('expense_date', { ascending: false }).order('created_at', { ascending: false }).range(page * size, page * size + size - 1);
  if (r.error) must(r);
  return { rows: (r.data ?? []) as unknown as Claim[], total: r.count ?? 0 };
}
/** Products and bank accounts for the pickers. Before the database has them (an older database) the lists are simply empty. */
export async function loadProducts(): Promise<ProductOption[]> {
  const r = await supabase.rpc('expense_product_options');
  return r.error ? [] : ((r.data ?? []) as ProductOption[]);
}
export async function loadBanks(): Promise<BankOption[]> {
  const r = await supabase.rpc('expense_bank_options');
  return r.error ? [] : ((r.data ?? []) as BankOption[]);
}
export interface ClaimLinks {
  bank_account: BankOption | null;
  product: { sku_code: string; name_th: string | null; name_en: string | null; sku_category: string; status: string } | null;
  gl: { event_type: string; status: 'pending' | 'posted' | 'void'; journal_no: string | null; posted_at: string | null; void_reason: string | null; created_at: string }[] | null;
  bank: { txn_no: string; txn_type: string; direction: 'in' | 'out'; amount: number; value_date: string; created_at: string; bank_code: string; balance_after: number | null }[] | null;
}
export const claimLinks = async (id: string) => must(await supabase.rpc('expense_claim_links', { p_id: id })) as ClaimLinks;
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
  /** product of the catalogue (null: none); bank account for a transfer / QR */
  sku?: string | null; bankAccountId?: string | null;
}
export async function saveClaim(i: ClaimInput): Promise<Claim> {
  const r = await supabase.rpc('expense_save', {
    p_id: i.id ?? null, p_expense_date: i.expenseDate, p_category: i.categoryId, p_description: i.description, p_amount: i.amount, p_tax_type: i.taxType, p_payment_method: i.paymentMethod,
    p_vendor: i.vendor ?? null, p_vendor_tax_id: i.vendorTaxId ?? null, p_reference_no: i.referenceNo ?? null, p_notes: i.notes ?? null,
    p_sku: i.sku || null, p_bank_account: needsBank(i.paymentMethod) ? i.bankAccountId || null : null,
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

// ---------------------------------------------------------------------------------------------- approve & post to accounting (one step)
export interface PreviewItem {
  id: string; expense_no: string | null; description: string; expense_date: string; amount_paid: number; wht_amount: number; payment_method: PayMethod; bank_account_id: string | null;
  status: Status; created_by_name: string | null; problem: string | null; bank_code: string | null; bank_name_th: string | null; bank_name_en: string | null; bank_last4: string | null;
}
export interface PostPreview {
  items: PreviewItem[]; missing: number; ok_count: number; ok_total: number;
  by_method: { method: PayMethod; n: number; amount: number }[];
  /** per bank: money going out and (for people who may see it) the balance now */
  by_bank: { bank_account_id: string; code: string; bank_name_th: string; bank_name_en: string; last4: string; n: number; out: number; balance: number | null }[];
}
export interface PostedItem { id: string; result: 'posted' | 'already_posted'; expense_no: string; amount: number; description?: string; bank_txn_no?: string | null; bank_out?: number | null; bank_balance_after?: number | null }
export interface FailedItem { id: string; code: string; reason: string; expense_no: string | null; description: string | null; amount: number | null }
export interface PostResult { posted: PostedItem[]; skipped: PostedItem[]; failed: FailedItem[]; total_posted: number; request: string | null }
export const previewPost = async (ids: string[]) => must(await supabase.rpc('expense_post_preview', { p_ids: ids })) as PostPreview;
export const postBulk = async (ids: string[], request: string) => must(await supabase.rpc('expense_post_bulk', { p_ids: ids, p_request: request })) as PostResult;
export const markReviewed = async (ids: string[], note?: string) => must(await supabase.rpc('expense_mark_reviewed', { p_ids: ids, p_note: note || null })) as number;
export const reverseClaim = async (id: string, reason: string) =>
  must(await supabase.rpc('expense_reverse', { p_id: id, p_reason: reason })) as { id: string; status: Status; gl_voided: boolean; bank_txn_no: string | null; bank_back: number | null };

/** Why an expense cannot be posted, in the reader's language (the database sends "EXP_CODE: English text"). */
const PROBLEM_TH: Record<string, string> = {
  EXP_ALREADY_POSTED: 'ลงบัญชีไปแล้ว', EXP_CANCELLED: 'รายการนี้ถูกยกเลิกแล้ว', EXP_SENT_BACK: 'ส่งกลับให้พนักงานแก้ไขอยู่', EXP_STATUS: 'สถานะนี้ลงบัญชีไม่ได้',
  EXP_FUTURE_DATE: 'วันที่จ่ายเงินเป็นวันในอนาคต', EXP_BAD_AMOUNT: 'จำนวนเงิน / VAT / ภาษีหัก ณ ที่จ่ายไม่สอดคล้องกัน', EXP_NOT_MAPPED: 'หมวดหมู่นี้ยังไม่ได้ผูกกับผังบัญชี (ตั้งค่า → หมวดหมู่)',
  EXP_BANK_REQUIRED: 'ยังไม่ได้เลือกบัญชีธนาคารที่ใช้จ่าย (เปิดรายการแล้วแก้ไข)', EXP_BANK_INACTIVE: 'บัญชีธนาคารนี้ปิดใช้งานแล้ว', EXP_NOT_FOUND: 'ไม่พบรายการ',
  EXP_ALREADY_REVERSED: 'กลับรายการไปแล้ว', EXP_LEDGER_DEVICE: 'รายการนี้ลงบัญชีด้วยเครื่องบัญชีแบบเดิม ต้องกลับรายการที่เครื่องบัญชี',
};
export function problemText(lang: string, problem: string | null | undefined): string {
  if (!problem) return '';
  const m = /^(EXP_[A-Z_]+):\s*(.*)$/.exec(problem);
  if (!m) return problem;
  return lang === 'th' ? PROBLEM_TH[m[1]] ?? m[2] : m[2];
}
export const problemCode = (problem: string | null | undefined) => /^(EXP_[A-Z_]+):/.exec(problem ?? '')?.[1] ?? null;

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
