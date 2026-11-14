// Opening Accounts Receivable carried forward from the previous accounting system. Read straight from Supabase
// (tables/views created in supabase/migrations/20261114150000_ar_opening_balances.sql); RLS limits them to staff.
// No fallback data: a failure is returned as an error and an empty database as empty lists.
import { supabase } from './supabase';

export interface ArCustomerBalance {
  customer_id: string; customer_code: string; customer_name: string; open_items: number;
  original_total: number; paid_total: number; outstanding_total: number;
  oldest_doc_date: string | null; newest_doc_date: string | null; max_age_days: number | null; overdue_items: number;
}
export interface ArOpenItem {
  id: string; source_ref: string; register_no: number | null; customer_code: string; customer_name: string;
  business_line: 'kratom' | 'pod'; doc_date: string | null; doc_date_raw: string | null; due_date: string | null;
  original_amount: number; paid_amount: number; outstanding_amount: number; currency: string;
  source_workbook: string; source_sheet: string; source_row: number; review_flags: string[];
  age_days: number | null; aging_bucket: 'unknown' | '0-30' | '31-60' | '61-90' | '90+'; is_overdue: boolean | null; batch_code: string;
}
export interface ArBatch {
  id: string; batch_code: string; source_file: string; source_sheet: string; status: string; record_count: number;
  original_total: number; paid_total: number; outstanding_total: number; currency: string; imported_at: string;
  notes: { source_sheet_reported_totals?: { kratom_difference?: number; pod_difference?: number }; missing_in_source?: string[] } | null;
}
export interface ArData { customers: ArCustomerBalance[]; items: ArOpenItem[]; batches: ArBatch[] }

const num = (v: unknown) => Number(v ?? 0);

export async function loadOpeningAr(): Promise<{ data: ArData | null; error: string | null }> {
  const [c, i, b] = await Promise.all([
    supabase.from('ar_customer_balances').select('*').order('outstanding_total', { ascending: false }),
    supabase.from('ar_open_item_status')
      .select('id,source_ref,register_no,customer_code,customer_name,business_line,doc_date,doc_date_raw,due_date,original_amount,paid_amount,outstanding_amount,currency,source_workbook,source_sheet,source_row,review_flags,age_days,aging_bucket,is_overdue,batch_code')
      .order('doc_date', { ascending: true, nullsFirst: true }).limit(5000),
    supabase.from('ar_import_batches').select('*').eq('status', 'completed').order('imported_at', { ascending: false }),
  ]);
  const err = c.error || i.error || b.error;
  if (err) return { data: null, error: err.message };
  return {
    error: null,
    data: {
      customers: (c.data ?? []).map((r) => ({ ...r, open_items: num(r.open_items), original_total: num(r.original_total), paid_total: num(r.paid_total), outstanding_total: num(r.outstanding_total), max_age_days: r.max_age_days == null ? null : num(r.max_age_days), overdue_items: num(r.overdue_items) })) as ArCustomerBalance[],
      items: (i.data ?? []).map((r) => ({ ...r, original_amount: num(r.original_amount), paid_amount: num(r.paid_amount), outstanding_amount: num(r.outstanding_amount), age_days: r.age_days == null ? null : num(r.age_days) })) as ArOpenItem[],
      batches: (b.data ?? []).map((r) => ({ ...r, record_count: num(r.record_count), original_total: num(r.original_total), paid_total: num(r.paid_total), outstanding_total: num(r.outstanding_total) })) as ArBatch[],
    },
  };
}
