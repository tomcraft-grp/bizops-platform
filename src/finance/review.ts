// Client side of the AI-assisted slip review (migration 20261120100000_slip_review.sql, Edge Function slip-analyze). The staff dashboard and the customer screens read
// and act through this file only: labels, reason texts, types and thin wrappers over the database functions. Like finance/api.ts it goes through the signed-in user's
// session: RLS and the SECURITY DEFINER functions decide who may do what and recompute every amount; nothing here decides a payment.
//
// The AI is a reader and a risk flagger, never the decision maker: a result is shown to staff only (customers never see it), and "match" is labelled as an AI check that
// passed, not as proof that money arrived (see AI_RESULT.match.hint). The stage of a payment is derived by the database from its status and its newest analysis.
import { supabase } from '../lib/supabase';
import { EVIDENCE_MAX, must, sha256, sniffType, type Evidence, type InvoiceState, type Receipt, type VerifyResult } from './api';

type Tone = 'good' | 'warn' | 'bad' | 'info' | '';
export interface Bilingual { en: string; th: string }
export interface Label extends Bilingual { tone: Tone }

// ------------------------------------------------------------------------------------------------ ids and labels
/** The derived stage of one payment (finance_evidence_stage). */
export type ReviewStage = 'slip_submitted' | 'ai_completed' | 'manual_review' | 'confirmed' | 'posted' | 'rejected' | 'more_evidence';
/** What the classifier concluded about a slip (finance_classify_slip). Staff only. */
export type AiResult = 'match' | 'amount_mismatch' | 'date_mismatch' | 'time_anomaly' | 'duplicate_suspected' | 'suspicious_slip' | 'manual_review';

/** Green is kept for money a person has confirmed or posted: an AI pass is blue, and carries the caveat in `hint`. */
export const AI_RESULT: Record<AiResult, Label & { hint?: Bilingual }> = {
  match: { en: 'Verified / Match', th: 'ตรงกัน', tone: 'info', hint: { en: 'AI check passed — not proof of payment', th: 'AI ตรวจผ่านแล้ว — ไม่ใช่หลักฐานว่าเงินเข้าจริง' } },
  amount_mismatch: { en: 'Amount Mismatch', th: 'ยอดเงินไม่ตรง', tone: 'bad' },
  date_mismatch: { en: 'Date Mismatch', th: 'วันที่ไม่ตรง', tone: 'bad' },
  time_anomaly: { en: 'Time Anomaly', th: 'เวลาผิดปกติ', tone: 'warn' },
  duplicate_suspected: { en: 'Duplicate Suspected', th: 'สงสัยสลิปซ้ำ', tone: 'bad' },
  suspicious_slip: { en: 'Suspicious Slip', th: 'สลิปน่าสงสัย', tone: 'bad' },
  manual_review: { en: 'Manual Review Required', th: 'ต้องตรวจสอบด้วยตนเอง', tone: 'warn' },
};

export const STAGE: Record<ReviewStage, Label> = {
  slip_submitted: { en: 'Slip Submitted', th: 'ส่งสลิปแล้ว', tone: '' },
  ai_completed: { en: 'AI Verification Completed', th: 'AI ตรวจแล้ว', tone: 'info' },
  manual_review: { en: 'Manual Review Required', th: 'ต้องตรวจสอบด้วยตนเอง', tone: 'warn' },
  confirmed: { en: 'Payment Confirmed', th: 'ยืนยันการชำระแล้ว', tone: 'info' },
  posted: { en: 'Invoice Posted', th: 'ลงรายการแล้ว', tone: 'good' },
  rejected: { en: 'Payment Rejected', th: 'ปฏิเสธการชำระ', tone: 'bad' },
  more_evidence: { en: 'More Evidence Requested', th: 'ขอหลักฐานเพิ่ม', tone: 'warn' },
};

// ------------------------------------------------------------------------------------------------ reasons
// Every code finance_classify_slip can put in `reasons` (and AI_UNAVAILABLE, which finance_analysis_fail writes). tests/unit/slipReview.test.ts reads the migration and
// fails when the SQL has a code this table does not (or the other way round), so a new rule cannot reach the dashboard as a bare code.
const REASONS = {
  AI_UNAVAILABLE: { en: 'The AI reader did not produce a result', th: 'AI ไม่สามารถอ่านสลิปได้' },
  AMOUNT_MISSING: { en: 'The amount could not be read from the slip', th: 'อ่านยอดเงินจากสลิปไม่ได้' },
  AMOUNT_OVER: { en: 'The slip shows more than the order expects', th: 'ยอดบนสลิปมากกว่ายอดที่ออเดอร์ต้องชำระ' },
  AMOUNT_UNDER: { en: 'The slip shows less than the order expects', th: 'ยอดบนสลิปน้อยกว่ายอดที่ออเดอร์ต้องชำระ' },
  DATE_MISSING: { en: 'The transfer date could not be read from the slip', th: 'อ่านวันที่โอนจากสลิปไม่ได้' },
  DATE_OUT_OF_RANGE: { en: 'The transfer is on a different day from the order', th: 'วันที่โอนไม่ตรงกับวันที่สั่งซื้อ' },
  DUPLICATE_REFERENCE: { en: 'This bank reference was already used on another slip, receipt or deposit', th: 'เลขอ้างอิงธนาคารนี้เคยถูกใช้แล้ว (สลิป ใบเสร็จ หรือการฝากเงินอื่น)' },
  LOW_CONFIDENCE: { en: 'The AI is not confident enough about what it read', th: 'AI ไม่มั่นใจในสิ่งที่อ่านได้มากพอ' },
  NOT_A_SLIP: { en: 'The picture does not look like a transfer slip', th: 'ภาพนี้ดูเหมือนไม่ใช่สลิปโอนเงิน' },
  QR_BAD_CRC: { en: 'The checksum of the QR code on the slip is wrong', th: 'รหัสตรวจสอบ (CRC) ของ QR บนสลิปไม่ถูกต้อง' },
  QR_REF_MISMATCH: { en: 'The reference in the QR code differs from the one printed on the slip', th: 'เลขอ้างอิงใน QR ไม่ตรงกับที่พิมพ์บนสลิป' },
  RECEIVER_MISMATCH: { en: 'The receiver on the slip is not one of the shop\'s accounts', th: 'ผู้รับบนสลิปไม่ใช่บัญชีของร้าน' },
  RECEIVER_UNCLEAR: { en: 'The receiver could not be read well enough to compare with the shop\'s accounts', th: 'อ่านผู้รับไม่ชัดพอที่จะเทียบกับบัญชีของร้าน' },
  RESUBMITTED_TRANSFER: { en: 'The customer resent a transfer already sent on an earlier slip of this order', th: 'ลูกค้าส่งสลิปโอนเดิมซ้ำอีกครั้ง (สลิปก่อนหน้าถูกส่งกลับหรือปฏิเสธ)' },
  STATUS_NOT_SUCCESS: { en: 'The slip does not say that the transfer succeeded', th: 'สลิปไม่ได้ระบุว่าโอนสำเร็จ' },
  TAMPER_SIGNAL: { en: 'The AI found a sign that the picture was edited', th: 'AI พบสัญญาณว่าภาพถูกแก้ไข' },
  TIME_MISSING: { en: 'The slip shows no time of day', th: 'สลิปไม่แสดงเวลา' },
  TIME_OUT_OF_RANGE: { en: 'The transfer time is outside the allowed window around the order', th: 'เวลาที่โอนอยู่นอกช่วงที่ยอมรับได้ของออเดอร์' },
  UNREADABLE: { en: 'The AI could not read this slip: a person has to look at it', th: 'AI อ่านสลิปนี้ไม่ได้ ต้องให้เจ้าหน้าที่ตรวจ' },
} as const satisfies Record<string, Bilingual>;

export type ReasonCode = keyof typeof REASONS;
export const REASON_CODES = Object.keys(REASONS) as ReasonCode[];

/** The text of a reason code. A code this table does not know (a newer database) is shown as the raw code: never blank, never an exception. */
export function REASON_TEXT(code: string): Bilingual {
  const c = String(code ?? '');
  return Object.prototype.hasOwnProperty.call(REASONS, c) ? { en: REASONS[c as ReasonCode].en, th: REASONS[c as ReasonCode].th } : { en: c, th: c };
}

/** What a reason's `expected` / `found` can hold: usually a number or a string, but also a boolean (QR_BAD_CRC), a list of receivers or an object (a date range, the receiver read). */
export type ReasonValue = string | number | boolean | null | ReasonValue[] | { [key: string]: ReasonValue };

/** A reason value as plain text, whatever it is. A number or a string is shown as it is; null is an empty string. */
export function reasonValueText(v: ReasonValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(reasonValueText).filter((x) => x !== '').join(', ');
  const o = v as { [key: string]: ReasonValue };
  const keys = Object.keys(o);
  if (keys.length === 2 && 'from' in o && 'to' in o) return `${reasonValueText(o.from)} – ${reasonValueText(o.to)}`;   // a range (DATE_OUT_OF_RANGE)
  return keys.map((k) => `${k}: ${reasonValueText(o[k])}`).join(', ');
}

/** One rule that applied to a slip (stored as is in finance_slip_analysis.reasons). `message` is the database's English sentence; show REASON_TEXT(code) instead. */
export interface Reason { code: string; severity: 'info' | 'warn' | 'high'; field: string | null; expected: ReasonValue; found: ReasonValue; message: string }

// ------------------------------------------------------------------------------------------------ what the database returns
export interface Party { name: string | null; bank: string | null; account_hint: string | null }
/** What the reader found on the slip, as normalised by the Edge Function (dates in Asia/Bangkok). */
export interface SlipExtracted {
  amount: number | null; transfer_at: string | null; time_known: boolean; is_slip: boolean; bank: string | null; sender: Party; receiver: Party;
  trans_ref: string | null; trans_id: string | null; status_text: string | null;
  field_confidence: { amount: number | null; date: number | null; time: number | null; receiver: number | null; ref: number | null };
}
export interface SlipQr { found: boolean; crc_ok: boolean | null; sending_bank: string | null; trans_ref: string | null }
/** What the order expected when the result was decided (a snapshot; the reader never sees it). */
export interface SlipExpected {
  amount: number | null; order_created_at: string | null; window_from: string | null; window_to: string | null;
  receivers: { label: string; bank: string | null; name: string | null; account_no_masked_digits: string | null }[];
}
export interface SlipSignal { code: string; severity: 'low' | 'high'; detail: string }
export type AnalysisStatus = 'queued' | 'running' | 'done' | 'failed';
/** One analysis attempt of a slip (finance_slip_analysis row without its evidence id). A finished attempt never changes; a re-run is a new attempt. */
export interface SlipAnalysis {
  id: string; attempt: number; status: AnalysisStatus; engine: string | null; prompt_version: string | null;
  extracted: SlipExtracted | null; qr: SlipQr | null; expected: SlipExpected | null; overall_confidence: number | null; signals: SlipSignal[];
  result: AiResult | null; reasons: Reason[]; error: string | null; requested_by: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}

/** One row of the review list (finance_review_list). `reasons` are the reason codes of the newest analysis, in the order they were recorded. */
export interface ReviewItem {
  evidence_id: string; created_at: string; source: 'customer_slip' | 'staff_entry'; method: 'transfer' | 'cash'; status: Evidence['status']; stage: ReviewStage;
  order_id: string | null; order_no: string | null; order_created_at: string | null; order_total: number | null;
  invoice_id: string; invoice_no: string; invoice_amount: number; paid: number; outstanding: number;
  customer_name: string; customer_phone: string | null;
  expected_amount: number | null; claimed_amount: number;
  ai_amount: number | null; ai_transfer_at: string | null; ai_result: AiResult | null; ai_confidence: number | null; ai_status: AnalysisStatus | null;
  reasons: string[];
  confirmed_amount: number | null; confirmed_bank_ref: string | null; posted_at: string | null;
}
export interface ReviewPage { total: number; items: ReviewItem[] }

/** The filter of the list. Every key is optional; an empty value means "no filter". The database refuses a key or a value it does not know (INVALID_FILTER). */
export interface ReviewFilter {
  stage?: ReviewStage[]; ai_result?: AiResult[]; source?: ('customer_slip' | 'staff_entry')[]; method?: ('transfer' | 'cash')[];
  /** one reason code of the newest analysis */
  reason?: string;
  /** calendar days (Asia/Bangkok) on the slip's created_at, both inclusive, written YYYY-MM-DD */
  from?: string; to?: string;
  /** order number, invoice number, customer name or a bank reference */
  search?: string;
}

/** The KPI tiles (finance_review_summary). The unresolved counts ignore the date range; posted and rejected use it. */
export interface ReviewSummary {
  awaiting: { count: number; expected_total: number; ai_total: number };
  ai_verified: number; manual_review: number; suspicious: number;
  confirmed: { count: number; amount: number }; posted: { count: number; amount: number };
  rejected: number; more_evidence: number;
}

/** The evidence row in full (the file path included, for the signed URL) with its derived stage and what the order expected. */
export interface ReviewEvidence extends Evidence {
  stage: ReviewStage; expected_amount: number | null;
  file_sha256: string | null; request_id: string | null; bank_account_id: string | null; transfer_at: string | null; review_note: string | null; reviewed_by: string | null;
  recorded_by: string | null; confirmed_by: string | null; posted_by: string | null; requested_by: string | null;
}
export interface ReviewOrder {
  id: string; order_no: string; status: string; fulfilment: 'delivery' | 'pickup'; channel: string; contact_name: string; contact_phone: string; delivery_address: string | null; note: string | null;
  subtotal: number; discount: number; shipping_fee: number; total: number; created_at: string; updated_at: string; status_note: string | null; cancel_reason: string | null;
  cancelled_at: string | null; profile_id: string; customer_id: string; invoice_id: string;
  items: { line_no: number; sku_code: string; name: string; unit: string | null; unit_price: number; qty: number; line_total: number }[];
}
export interface ReviewInvoice extends InvoiceState {
  id: string; invoice_no: string; issue_date: string; due_date: string; description: string | null; invoice_status: string; cancel_reason: string | null; created_at: string;
}
export interface ReviewEvent { id: number | string; at: string; actor: string | null; actor_email: string | null; action: string; detail: Record<string, unknown> }
/** Everything the screen needs to show one payment: the slip beside its order (finance_review_detail). */
export interface ReviewDetail {
  evidence: ReviewEvidence;
  /** newest first */
  analyses: SlipAnalysis[];
  /** null for an invoice that is not a shop order */
  order: ReviewOrder | null;
  invoice: ReviewInvoice;
  customer: { id: string; code: string; name: string; phone: string | null };
  receipts: (Receipt & { method?: string })[];
  other_evidence: { id: string; status: Evidence['status']; amount: number | null; created_at: string; source: 'customer_slip' | 'staff_entry'; method: 'transfer' | 'cash' }[];
  /** the last 30 audit rows of this payment, newest first */
  events: ReviewEvent[];
}

/** The five settings of the review (finance_review_settings; a manager saves them with finance_save_review_settings). */
export interface ReviewSettings {
  ai_review_enabled: boolean; post_requires_manager: boolean; ai_min_confidence: number; slip_window_before_min: number; slip_future_tolerance_min: number;
}

// The keys of the JSON the database builds, written once as a Record over the interface (the compiler then insists they are complete and real) and compared with the
// SQL by tests/unit/slipReview.test.ts, so a column added on one side only is caught.
const ITEM_KEYS: Record<keyof ReviewItem, true> = {
  evidence_id: true, created_at: true, source: true, method: true, status: true, stage: true, order_id: true, order_no: true, order_created_at: true, order_total: true,
  invoice_id: true, invoice_no: true, invoice_amount: true, paid: true, outstanding: true, customer_name: true, customer_phone: true, expected_amount: true, claimed_amount: true,
  ai_amount: true, ai_transfer_at: true, ai_result: true, ai_confidence: true, ai_status: true, reasons: true, confirmed_amount: true, confirmed_bank_ref: true, posted_at: true,
};
const SUMMARY_KEYS: Record<keyof ReviewSummary, true> = { awaiting: true, ai_verified: true, manual_review: true, suspicious: true, confirmed: true, posted: true, rejected: true, more_evidence: true };
const DETAIL_KEYS: Record<keyof ReviewDetail, true> = { evidence: true, analyses: true, order: true, invoice: true, customer: true, receipts: true, other_evidence: true, events: true };
const SETTING_KEYS: Record<keyof ReviewSettings, true> = { ai_review_enabled: true, post_requires_manager: true, ai_min_confidence: true, slip_window_before_min: true, slip_future_tolerance_min: true };
export const REVIEW_ITEM_KEYS = Object.keys(ITEM_KEYS) as (keyof ReviewItem)[];
export const REVIEW_SUMMARY_KEYS = Object.keys(SUMMARY_KEYS) as (keyof ReviewSummary)[];
export const REVIEW_DETAIL_KEYS = Object.keys(DETAIL_KEYS) as (keyof ReviewDetail)[];
export const REVIEW_SETTING_KEYS = Object.keys(SETTING_KEYS) as (keyof ReviewSettings)[];

// ------------------------------------------------------------------------------------------------ actions
/** What Post answers. `replay` is true when the payment was already posted (a second press, or another administrator at the same moment): nothing new was recorded. */
export interface PostResult { replay: boolean; result: VerifyResult['result'] | 'already_posted'; receipt_no: string; credited_to_wallet?: number; state: InvoiceState }

export interface ConfirmInput {
  evidenceId: string;
  /** the amount the BANK shows (not the slip picture) */
  amount: number; bankRef: string; transferAt: string; note?: string;
}
export interface RecordPaymentInput {
  invoiceId: string; method: 'transfer' | 'cash'; amount: number; receivedAt: string;
  /** a transfer needs the bank reference; cash has none */
  bankRef?: string; bankAccountId?: string | null;
  /** cash needs a note saying where the money was received */
  note?: string;
  /** an optional slip for a transfer (JPG, PNG or PDF up to 5 MB); cash has no file */
  file?: File | null;
}

const clean = (s: string | null | undefined) => (s ?? '').trim() || null;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;

export const review = {
  // ---- reads (any staff role)
  async list(filter: ReviewFilter, limit = 50, offset = 0): Promise<ReviewPage> {
    const r = must(await supabase.rpc('finance_review_list', { p_filter: filter, p_limit: limit, p_offset: offset }), 'Load slip review') as ReviewPage | null;
    return { total: r?.total ?? 0, items: r?.items ?? [] };
  },
  /** from / to: calendar days (YYYY-MM-DD) or null for no end. */
  async summary(from: string | null, to: string | null): Promise<ReviewSummary> {
    return must(await supabase.rpc('finance_review_summary', { p_from: from || null, p_to: to || null }), 'Load review summary');
  },
  async detail(evidenceId: string): Promise<ReviewDetail> {
    return must(await supabase.rpc('finance_review_detail', { p_evidence: evidenceId }), 'Load payment');
  },
  async settings(): Promise<ReviewSettings> {
    return must(await supabase.rpc('finance_review_settings'), 'Load review settings');
  },
  // ---- the workflow (verifier or above; Post needs a manager while post_requires_manager is on; the database checks)
  /** Record what the bank shows against a submitted slip. Moves no money: the payment is posted by a second step. */
  async confirm(p: ConfirmInput): Promise<{ status: 'confirmed'; evidence_id: string; amount: number }> {
    return must(await supabase.rpc('finance_confirm_evidence', {
      p_evidence: p.evidenceId, p_amount: p.amount, p_bank_trans_ref: p.bankRef, p_transfer_at: p.transferAt, p_note: clean(p.note),
    }), 'Confirm payment');
  },
  /** Make a confirmed payment official (receipt, allocation, ledger row), once. */
  async post(evidenceId: string, note?: string): Promise<PostResult> {
    return must(await supabase.rpc('finance_post_evidence', { p_evidence: evidenceId, p_note: clean(note) }), 'Post payment');
  },
  async reject(evidenceId: string, reason: string): Promise<void> {
    must(await supabase.rpc('finance_reject_evidence', { p_evidence: evidenceId, p_reason: reason }), 'Reject payment');
  },
  /** Ask the customer for another slip; the message is shown to them (3 to 300 characters). */
  async requestMore(evidenceId: string, message: string): Promise<void> {
    must(await supabase.rpc('finance_request_more_evidence', { p_evidence: evidenceId, p_message: message }), 'Request more evidence');
  },
  /**
   * Enter a payment at the back office (a bank transfer or cash). It is created already confirmed and still has to be posted. A slip file, when given, is uploaded
   * into the caller's own folder of the private bucket first (the same rules as a customer's upload) and removed again if the database refuses the payment.
   */
  async recordPayment(p: RecordPaymentInput): Promise<{ evidence_id: string; status: 'confirmed' }> {
    let path: string | null = null, sum: string | null = null, type: string | null = null;
    if (p.file) {
      if (p.method === 'cash') throw new Error('A cash payment has no slip file');
      type = await sniffType(p.file);
      if (!type) throw new Error('Only JPG, PNG or PDF files are accepted');
      if (p.file.size > EVIDENCE_MAX) throw new Error('The file must be 5 MB or smaller');
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id; if (!uid) throw new Error('Please sign in');
      sum = await sha256(p.file);
      path = `${uid}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${EXT[type as keyof typeof EXT]}`;
      const up = await supabase.storage.from('payment-evidence').upload(path, p.file, { contentType: type, upsert: false });
      if (up.error) throw new Error(`Upload slip: ${up.error.message}`);
    }
    const cash = p.method === 'cash';
    const r = await supabase.rpc('finance_record_payment', {
      p_invoice: p.invoiceId, p_method: p.method, p_amount: p.amount, p_received_at: p.receivedAt,
      p_bank_trans_ref: cash ? null : clean(p.bankRef), p_bank_account: cash ? null : p.bankAccountId || null, p_note: clean(p.note),
      p_file_path: path, p_sha256: sum, p_file_type: type,
    });
    if (r.error) { if (path) void supabase.storage.from('payment-evidence').remove([path]); throw new Error(`Record payment: ${r.error.message}`); }
    return r.data as { evidence_id: string; status: 'confirmed' };
  },
  // ---- the AI reader
  /** Queue a new analysis attempt of a slip (staff re-run; at most 5 per slip). Returns the attempt's id. Call analyze() afterwards to run it. */
  async requestAnalysis(evidenceId: string): Promise<string> {
    return must(await supabase.rpc('finance_request_analysis', { p_evidence: evidenceId }), 'Request analysis');
  },
  /**
   * Ask the Edge Function to read a slip (by slip, or by invoice = its newest slip). Best effort: it NEVER throws, because the order and the slip are already saved
   * and the reader must never block anybody. `ok` means the function was reached and answered; `status` is its own word ('completed', 'failed' or 'nothing_to_do').
   * The answer never carries what the AI found: results are read by staff through detail() and list().
   */
  async analyze(p: { evidenceId?: string; invoiceId?: string }): Promise<{ ok: boolean; status?: string }> {
    try {
      const body: Record<string, string> = {};
      if (p.evidenceId) body.evidence_id = p.evidenceId;
      if (p.invoiceId) body.invoice_id = p.invoiceId;
      if (!Object.keys(body).length) return { ok: false };
      const r = await supabase.functions.invoke('slip-analyze', { body });
      if (r.error) return { ok: false };
      const status = (r.data as { status?: unknown } | null)?.status;
      return typeof status === 'string' ? { ok: true, status } : { ok: false };
    } catch {
      return { ok: false };
    }
  },
  // ---- settings (a manager)
  async saveSettings(patch: Partial<ReviewSettings>): Promise<ReviewSettings> {
    return must(await supabase.rpc('finance_save_review_settings', { p_patch: patch }), 'Save review settings');
  },
};
