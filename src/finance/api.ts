// Finance data access (invoices, QR payment requests, payment evidence, verification). Everything goes through the
// signed-in user's Supabase session: RLS limits reads, and the SECURITY DEFINER functions in
// supabase/migrations/*_finance_ar_payments.sql own every write and recompute every amount. The app never sends a
// settled amount or a status; it can only submit evidence and ask the server to verify it (staff roles only).
import { supabase } from '../lib/supabase';

export type FinanceRole = 'viewer' | 'clerk' | 'verifier' | 'manager';
const RANK: Record<FinanceRole, number> = { viewer: 1, clerk: 2, verifier: 3, manager: 4 };
export type FinanceCap = 'view' | 'invoice' | 'verify' | 'manage';
const NEED: Record<FinanceCap, number> = { view: 1, invoice: 2, verify: 3, manage: 4 };
/** UI hint only: the database enforces the same ladder (public.finance_can). */
export const canFinance = (role: FinanceRole | null, cap: FinanceCap) => !!role && RANK[role] >= NEED[cap];

/** 0 unpaid · 1 awaiting payment · 3 pending verification · 4 partially paid · 5 fully paid · 6 overpaid (review) · 7 rejected · 8 cancelled · 9 expired */
export type StatusCode = 0 | 1 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export const STATUS: Record<StatusCode, { en: string; th: string; tone: 'good' | 'warn' | 'bad' | 'info' | '' }> = {
  0: { en: 'Unpaid', th: 'ยังไม่ชำระ', tone: '' },
  1: { en: 'Awaiting payment', th: 'รอชำระเงิน', tone: 'info' },
  3: { en: 'Pending verification', th: 'รอตรวจสอบ', tone: 'warn' },
  4: { en: 'Partially paid', th: 'ชำระบางส่วน', tone: 'warn' },
  5: { en: 'Fully paid', th: 'ชำระครบแล้ว', tone: 'good' },
  6: { en: 'Overpaid – under review', th: 'จ่ายเกิน – รอตรวจสอบ', tone: 'warn' },
  7: { en: 'Payment rejected', th: 'หลักฐานถูกปฏิเสธ', tone: 'bad' },
  8: { en: 'Cancelled', th: 'ยกเลิก', tone: '' },
  9: { en: 'QR expired', th: 'QR หมดอายุ', tone: 'bad' },
};

export interface PaymentRequestView { ref: string; amount: number; qr_payload: string; expires_at: string; expired: boolean }
export interface InvoiceState {
  invoice_id: string; amount: number; paid: number; outstanding: number; unapplied: number; status_code: StatusCode; status: string;
  pending_evidence: number; request: PaymentRequestView | null;
}
export interface InvoiceRow extends InvoiceState {
  id: string; invoice_no: string; issue_date: string; due_date: string; description: string | null; customer_name?: string;
  customer_id?: string; customer_code?: string; source_ref?: string | null;
}
export interface QrRequest { ref: string; amount: number; qr_payload: string; expires_at: string; account_label: string; merchant_name: string | null }
export interface PaymentAccount { id: string; label: string; kind: 'promptpay' | 'bill_payment'; target: string; target_type: string; merchant_name: string | null; is_default: boolean; active: boolean; created_at: string }
export interface QrInfo { kind: 'promptpay' | 'bill_payment'; target: string; target_type: string; ref1: string | null; merchant_name: string | null; has_amount: boolean }
export interface Evidence {
  id: string; invoice_id: string; customer_id: string; file_path: string; file_type: string; claimed_amount: number; claimed_transfer_at: string | null;
  claimed_bank: string | null; claimed_ref: string | null; status: 'submitted' | 'verified' | 'rejected'; verified_via: string | null; verified_amount: number | null;
  bank_trans_ref: string | null; reject_reason: string | null; reviewed_at: string | null; created_at: string;
}
export interface Receipt { id: string; receipt_no: string; invoice_id: string; amount: number; bank_trans_ref: string | null; received_at: string; needs_review: boolean; status: 'posted' | 'reversed'; created_at: string }
export interface VerifyResult { result: 'fully_paid' | 'partially_paid' | 'overpaid_review'; receipt_no: string; state: InvoiceState }

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (f: Blob) => hex(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()));

export const EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export const EVIDENCE_MAX = 5 * 1024 * 1024;

/** Real type from the first bytes (the file name / browser type can lie). */
export async function sniffType(f: Blob): Promise<(typeof EVIDENCE_TYPES)[number] | null> {
  const b = new Uint8Array(await f.slice(0, 8).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return null;
}

export const finance = {
  async myRole(): Promise<FinanceRole | null> { return must(await supabase.rpc('finance_role'), 'Load finance role') as FinanceRole | null; },
  // ---- customer
  async myInvoices(): Promise<InvoiceRow[]> { return must(await supabase.rpc('finance_my_invoices'), 'Load invoices') ?? []; },
  async requestPayment(invoiceId: string): Promise<QrRequest> { return must(await supabase.rpc('finance_request_payment', { p_invoice: invoiceId }), 'Create QR'); },
  async myReceipts(invoiceId: string): Promise<Receipt[]> {
    return must(await supabase.from('finance_receipts').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: false }), 'Load receipts');
  },
  async myEvidence(invoiceId: string): Promise<Evidence[]> {
    return must(await supabase.from('finance_payment_evidence').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: false }), 'Load slips');
  },
  /** Upload the slip into the caller's own folder of the private bucket, then record it. Settles nothing by itself. */
  async submitEvidence(p: { invoiceId: string; file: File; claimedAmount: number; transferAt: string | null; bank: string; ref: string }): Promise<string> {
    const type = await sniffType(p.file);
    if (!type) throw new Error('Only JPG, PNG or PDF files are accepted');
    if (p.file.size > EVIDENCE_MAX) throw new Error('The file must be 5 MB or smaller');
    const { data: u } = await supabase.auth.getUser();
    const uid = u.user?.id; if (!uid) throw new Error('Please sign in');
    const sum = await sha256(p.file);
    const path = `${uid}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg'}`;
    const up = await supabase.storage.from('payment-evidence').upload(path, p.file, { contentType: type, upsert: false });
    if (up.error) throw new Error(`Upload slip: ${up.error.message}`);
    const r = await supabase.rpc('finance_submit_evidence', {
      p_invoice: p.invoiceId, p_file_path: path, p_sha256: sum, p_file_type: type, p_claimed_amount: p.claimedAmount,
      p_transfer_at: p.transferAt, p_bank: p.bank || null, p_ref: p.ref || null,
    });
    if (r.error) { void supabase.storage.from('payment-evidence').remove([path]); throw new Error(r.error.message); }
    return r.data as string;
  },
  async slipUrl(path: string): Promise<string> {
    const r = await supabase.storage.from('payment-evidence').createSignedUrl(path, 120);
    if (r.error) throw new Error(`Open slip: ${r.error.message}`);
    return r.data.signedUrl;
  },
  // ---- staff
  async overview(status: number | null = null): Promise<InvoiceRow[]> { return must(await supabase.rpc('finance_invoice_overview', { p_status: status }), 'Load invoices') ?? []; },
  async queue(): Promise<(Evidence & { invoice_no?: string; customer_name?: string })[]> {
    const ev = must(await supabase.from('finance_payment_evidence').select('*').eq('status', 'submitted').order('created_at'), 'Load slips') as Evidence[];
    if (!ev.length) return [];
    const inv = must(await supabase.from('finance_invoices').select('id, invoice_no, customer_id').in('id', [...new Set(ev.map((e) => e.invoice_id))]), 'Load invoices') as { id: string; invoice_no: string; customer_id: string }[];
    const cu = must(await supabase.from('finance_customers').select('id, name').in('id', [...new Set(inv.map((i) => i.customer_id))]), 'Load customers') as { id: string; name: string }[];
    return ev.map((e) => { const i = inv.find((x) => x.id === e.invoice_id); return { ...e, invoice_no: i?.invoice_no, customer_name: cu.find((c) => c.id === i?.customer_id)?.name }; });
  },
  async verify(p: { evidenceId: string; amount: number; bankTransRef: string; transferAt: string; note: string }): Promise<VerifyResult> {
    return must(await supabase.rpc('finance_verify_evidence', { p_evidence: p.evidenceId, p_amount: p.amount, p_bank_trans_ref: p.bankTransRef, p_transfer_at: p.transferAt, p_note: p.note || null, p_via: 'staff' }), 'Verify payment');
  },
  async reject(evidenceId: string, reason: string) { must(await supabase.rpc('finance_reject_evidence', { p_evidence: evidenceId, p_reason: reason }), 'Reject payment'); },
  async resolveOverpayment(receiptId: string, note: string): Promise<InvoiceState> { return must(await supabase.rpc('finance_resolve_overpayment', { p_receipt: receiptId, p_note: note }), 'Resolve overpayment'); },
  async reverseReceipt(receiptId: string, reason: string): Promise<InvoiceState> { return must(await supabase.rpc('finance_reverse_receipt', { p_receipt: receiptId, p_reason: reason }), 'Reverse receipt'); },
  async reviewReceipts(): Promise<Receipt[]> {
    return must(await supabase.from('finance_receipts').select('*').eq('status', 'posted').eq('needs_review', true).order('created_at'), 'Load receipts');
  },
  async cancelInvoice(id: string, reason: string) { must(await supabase.rpc('finance_cancel_invoice', { p_invoice: id, p_reason: reason }), 'Cancel invoice'); },
  async createInvoice(p: { customerId: string; amount: number; issue: string; due: string; description: string; sourceRef: string }): Promise<InvoiceRow> {
    return must(await supabase.rpc('finance_create_invoice', { p_customer: p.customerId, p_amount: p.amount, p_issue: p.issue, p_due: p.due, p_description: p.description || null, p_source_ref: p.sourceRef || null }), 'Issue invoice');
  },
  async staff(): Promise<{ user_id: string; email: string; display_name: string | null; profile_role: string; finance_role: FinanceRole | null }[]> { return must(await supabase.rpc('finance_staff'), 'Load staff'); },
  async setRole(userId: string, role: FinanceRole | null) { must(await supabase.rpc('finance_set_role', { p_user: userId, p_role: role }), 'Change role'); },
  async customers(): Promise<{ id: string; code: string; name: string }[]> { return must(await supabase.from('finance_customers').select('id, code, name').order('name'), 'Load customers'); },
  // ---- shop payment account (from the shop's own QR picture)
  async accounts(): Promise<PaymentAccount[]> { return must(await supabase.from('finance_payment_accounts').select('*').order('created_at', { ascending: false }), 'Load payment accounts'); },
  async describeQr(payload: string): Promise<QrInfo> { return must(await supabase.rpc('finance_qr_describe', { p: payload }), 'Check QR'); },
  async saveAccount(payload: string, label: string): Promise<PaymentAccount> { return must(await supabase.rpc('finance_save_payment_account', { p_payload: payload, p_label: label, p_make_default: true }), 'Save payment account'); },
  async disableAccount(id: string) { must(await supabase.rpc('finance_disable_payment_account', { p_account: id }), 'Disable payment account'); },
};
