// Opening Accounts Receivable carried forward from the previous accounting system, and payments received against it.
// Read straight from Supabase (supabase/migrations/20261114150000_ar_opening_balances.sql and 20261114170000_ar_receipts.sql);
// RLS limits everything to staff and all writes go through SECURITY DEFINER functions that re-check the caller.
// No fallback data: a failure is returned as an error and an empty database as empty lists.
import { supabase } from './supabase';

export interface ArCustomerBalance {
  customer_id: string; customer_code: string; customer_name: string; open_items: number;
  original_total: number; paid_total: number; outstanding_total: number; received_total: number; balance_total: number;
  oldest_doc_date: string | null; newest_doc_date: string | null; max_age_days: number | null; overdue_items: number;
}
export interface ArOpenItem {
  id: string; customer_id: string; source_ref: string; register_no: number | null; customer_code: string; customer_name: string;
  business_line: 'kratom' | 'pod'; doc_date: string | null; doc_date_raw: string | null; due_date: string | null;
  original_amount: number; paid_amount: number; outstanding_amount: number; received_amount: number; balance_amount: number; currency: string;
  source_workbook: string; source_sheet: string; source_row: number; review_flags: string[];
  age_days: number | null; aging_bucket: 'unknown' | '0-30' | '31-60' | '61-90' | '90+'; is_overdue: boolean | null; batch_code: string;
}
export interface ArBatch {
  id: string; batch_code: string; source_file: string; source_sheet: string; status: string; record_count: number;
  original_total: number; paid_total: number; outstanding_total: number; currency: string; imported_at: string;
  notes: { source_sheet_reported_totals?: { kratom_difference?: number; pod_difference?: number }; missing_in_source?: string[] } | null;
}
export interface ArReceipt {
  id: string; receipt_no: string; customer_id: string; received_date: string; amount: number; method: ArMethod; reference: string | null;
  note: string | null; status: 'posted' | 'voided'; created_by_label: string; created_at: string; voided_at: string | null; void_reason: string | null;
}
export type ArMethod = 'cash' | 'transfer' | 'promptpay' | 'other';
export const AR_METHODS: { v: ArMethod; label: string }[] = [
  { v: 'cash', label: 'Cash' }, { v: 'transfer', label: 'Bank transfer' }, { v: 'promptpay', label: 'PromptPay QR' }, { v: 'other', label: 'Other' },
];
export interface ArData { customers: ArCustomerBalance[]; items: ArOpenItem[]; batches: ArBatch[]; receipts: ArReceipt[] }

const num = (v: unknown) => Number(v ?? 0);

export async function loadOpeningAr(): Promise<{ data: ArData | null; error: string | null }> {
  const [c, i, b, r] = await Promise.all([
    supabase.from('ar_customer_balances').select('*').order('balance_total', { ascending: false }),
    supabase.from('ar_open_item_status')
      .select('id,customer_id,source_ref,register_no,customer_code,customer_name,business_line,doc_date,doc_date_raw,due_date,original_amount,paid_amount,outstanding_amount,received_amount,balance_amount,currency,source_workbook,source_sheet,source_row,review_flags,age_days,aging_bucket,is_overdue,batch_code')
      .order('doc_date', { ascending: true, nullsFirst: false }).order('source_row', { ascending: true }).limit(5000),
    supabase.from('ar_import_batches').select('*').eq('status', 'completed').order('imported_at', { ascending: false }),
    supabase.from('ar_receipts').select('id,receipt_no,customer_id,received_date,amount,method,reference,note,status,created_by_label,created_at,voided_at,void_reason').order('created_at', { ascending: false }).limit(1000),
  ]);
  const err = c.error || i.error || b.error || r.error;
  if (err) return { data: null, error: err.message };
  return {
    error: null,
    data: {
      customers: (c.data ?? []).map((x) => ({ ...x, open_items: num(x.open_items), original_total: num(x.original_total), paid_total: num(x.paid_total), outstanding_total: num(x.outstanding_total), received_total: num(x.received_total), balance_total: num(x.balance_total), max_age_days: x.max_age_days == null ? null : num(x.max_age_days), overdue_items: num(x.overdue_items) })) as ArCustomerBalance[],
      items: (i.data ?? []).map((x) => ({ ...x, original_amount: num(x.original_amount), paid_amount: num(x.paid_amount), outstanding_amount: num(x.outstanding_amount), received_amount: num(x.received_amount), balance_amount: num(x.balance_amount), age_days: x.age_days == null ? null : num(x.age_days) })) as ArOpenItem[],
      batches: (b.data ?? []).map((x) => ({ ...x, record_count: num(x.record_count), original_total: num(x.original_total), paid_total: num(x.paid_total), outstanding_total: num(x.outstanding_total) })) as ArBatch[],
      receipts: (r.data ?? []).map((x) => ({ ...x, amount: num(x.amount) })) as ArReceipt[],
    },
  };
}

export interface ReceivePaymentInput { customerId: string; amount: number; method: ArMethod; date: string; reference?: string; note?: string; idempotencyKey: string }

/** Posts a payment, allocated oldest-document-first by the database. Returns the receipt number or an error message. */
export async function receivePayment(i: ReceivePaymentInput): Promise<{ receiptNo: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('ar_receive_payment', {
    p_customer: i.customerId, p_amount: i.amount, p_method: i.method, p_date: i.date,
    p_reference: i.reference || null, p_note: i.note || null, p_allocations: null, p_idempotency_key: i.idempotencyKey,
  });
  if (error) return { receiptNo: null, error: error.message };
  return { receiptNo: (data as { receipt_no: string }).receipt_no, error: null };
}

export async function voidReceipt(receiptId: string, reason: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('ar_void_receipt', { p_receipt: receiptId, p_reason: reason });
  return { error: error?.message ?? null };
}

/** Same rule the database applies (oldest document first, undated last, then source row): used only to PREVIEW a payment. */
export function previewFifo(items: ArOpenItem[], amount: number): { cleared: number; partial: boolean; applied: number } {
  let left = Math.round(amount * 100);
  let cleared = 0; let partial = false;
  const order = items.filter((x) => x.balance_amount > 0).sort((a, b) => (a.doc_date ?? '9999').localeCompare(b.doc_date ?? '9999') || a.source_row - b.source_row);
  for (const it of order) {
    if (left <= 0) break;
    const bal = Math.round(it.balance_amount * 100);
    if (left >= bal) { left -= bal; cleared++; } else { left = 0; partial = true; }
  }
  return { cleared, partial, applied: Math.round(amount * 100 - left) / 100 };
}
