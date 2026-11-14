// Customer wallet, bank accounts (payment methods) and the staff side of payments. Everything goes through the signed-in user's
// Supabase session and the SECURITY DEFINER functions of supabase/migrations/20261115200000_wallet_payments.sql: the database
// owns every amount, every balance and every status. The app never sends a balance, a credit or a status.
import { supabase } from '../lib/supabase';
import { rpc, ShopError } from '../shop/api';
import { EVIDENCE_MAX, sha256, sniffType } from '../finance/api';

// ---------------------------------------------------------------- types
export interface Bank {
  id: string; code: string; bank_name_en: string; bank_name_th: string; account_no: string; account_name: string; logo_url: string | null;
  instructions_th: string | null; instructions_en: string | null;
}
export interface PaymentMethods { banks: Bank[]; promptpay: boolean; wallet: { balance: number; min_deposit: number; max_deposit: number } }
export interface WalletSummary { balance: number; total_deposits: number; total_payments: number; total_refunds: number; pending_deposits: number }
export type WalletTxnType = 'DEPOSIT' | 'INVOICE_PAYMENT' | 'REFUND' | 'ADJUSTMENT' | 'WITHDRAWAL' | 'REVERSAL';
export interface WalletTxn {
  id: string; txn_no: string; txn_type: WalletTxnType; direction: 'credit' | 'debit'; amount: number; balance_before: number; balance_after: number;
  ref_no: string | null; payment_method: string | null; verification_status: string; bank: { code: string; bank_name_th: string; bank_name_en: string } | null; note: string | null; txn_date: string;
}
export type DepositStatus = 'pending' | 'submitted' | 'under_review' | 'verified' | 'rejected' | 'cancelled';
export interface Deposit {
  id: string; deposit_no: string; status: DepositStatus; amount: number; verified_amount: number | null; created_at: string; submitted_at: string | null; reject_reason: string | null;
  has_slip: boolean; customer_ref: string | null; bank: { id: string; code: string; bank_name_th: string; bank_name_en: string; account_no: string; account_name: string } | null;
}
export interface PayWalletResult { replay: boolean; receipt_no: string; txn_no?: string; balance: number; state: { status_code: number; outstanding: number; paid: number } }

// staff
export interface PaymentRow {
  kind: 'deposit' | 'invoice_slip' | 'wallet_payment'; id: string; no: string; customer_id: string; customer_name: string; customer_code: string; invoice_no: string | null; amount: number;
  verified_amount: number | null; status: string; bank_account_id: string | null; bank_code: string | null; bank_name_th: string | null; bank_name_en: string | null; created_at: string;
  file_path: string | null; bank_trans_ref: string | null;
}
export interface WalletRow { wallet_id: string; customer_id: string; code: string; name: string; balance: number; total_deposits: number; total_payments: number; last_activity: string | null }
export interface LedgerRow extends Omit<WalletTxn, 'bank' | 'note'> {
  customer_id: string; seq: number; ref_type: string | null; ref_id: string | null; remarks: string | null; customer_note: string | null; bank_code: string | null;
  created_by_email: string | null; approved_by_email: string | null; reversal_of: string | null;
}
export interface GlPlanLine { side: 'dr' | 'cr'; role: string; amount: number; bank_account_id?: string; wallet?: boolean; vat?: 'split' }
export type GlEvent = 'INVOICE_ISSUE' | 'INVOICE_CANCEL' | 'BANK_RECEIPT' | 'RECEIPT_REAPPLY' | 'RECEIPT_REVERSAL' | 'WALLET_DEPOSIT' | 'WALLET_PAYMENT' | 'WALLET_REFUND' | 'WALLET_ADJUSTMENT' | 'WALLET_REVERSAL';
export interface GlRow {
  id: string; seq: number; event_type: GlEvent; ref_type: string; ref_id: string; ref_no: string | null; customer_id: string | null; customer_name: string | null; event_date: string; amount: number;
  plan: GlPlanLine[]; depends_on: string | null; status: 'pending' | 'posted' | 'void'; journal_no: string | null; posted_at: string | null; void_reason: string | null;
  blocked_by: { id: string; ref_no: string | null; status: string } | null; banks: Record<string, { code: string; gl_account_code: string | null }>;
}
export interface FinanceSettings {
  min_deposit: number; max_deposit: number; max_open_deposits: number; adjustment_limit: number; adjustment_role: string; invoice_vat_mode: 'unset' | 'none' | 'inclusive'; vat_rate: number; updated_at: string;
}
export interface BankReportRow { day: string; bank_code: string; bank_account_id: string | null; deposits: number; deposit_amount: number; invoice_transfers: number; invoice_amount: number; total: number; in_ledger: number; waiting_for_ledger: number }
export interface Reconciliation { wallet_balances: number; wallet_ledger: number; gl_wallet_liability_posted: number; gl_wallet_liability_waiting: number; difference: number; rows_waiting: number; rows_blocked: number }
export interface WalletReconcile { wallets: number; balance_total: number; ledger_total: number; problems: { customer_id: string; problem: string; txn_no?: string }[] }
export interface BankAccountRow extends Bank { branch: string | null; gl_account_code: string | null; sort_order: number; active: boolean }

// ---------------------------------------------------------------- idempotency keys
export const newKey = (): string => {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID(); } catch { /* fall through */ }
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
};

/** A user-facing reason for a failed wallet call. `t` maps a code to text in the caller's language. */
export function walletCode(e: unknown): string { return e instanceof ShopError ? e.code : e instanceof Error && /fetch|network/i.test(e.message) ? 'NETWORK' : 'ERROR'; }

// ---------------------------------------------------------------- slips at checkout
/** Check a slip file (type by its first bytes, size) and fingerprint it. Throws a ShopError the screens translate. */
export async function slipFingerprint(file: File): Promise<{ type: string; sha256: string; ext: string }> {
  const type = await sniffType(file);
  if (!type) throw new ShopError('Only JPG, PNG or PDF files are accepted', 'BAD_FILE_TYPE');
  if (file.size > EVIDENCE_MAX) throw new ShopError('The file must be 5 MB or smaller', 'FILE_TOO_BIG');
  return { type, sha256: await sha256(file), ext: type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg' };
}
/** Upload the slip into the customer's own folder of the private bucket BEFORE the order is placed. The same order key always gives the same path,
 *  so a retry reuses the file instead of leaving a second one. The order itself is created (with the slip) by one database call. */
export async function uploadOrderSlip(file: File, key: string, fp: { type: string; ext: string }): Promise<string> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id; if (!uid) throw new ShopError('Please sign in', 'FORBIDDEN');
  const path = `${uid}/orders/${key}.${fp.ext}`;
  const up = await supabase.storage.from('payment-evidence').upload(path, file, { contentType: fp.type, upsert: false });
  if (up.error && !/already exists|duplicate/i.test(up.error.message)) throw new ShopError(up.error.message, 'UPLOAD_FAILED');
  return path;
}
export const removeOrderSlip = (path: string) => { void supabase.storage.from('payment-evidence').remove([path]); };

// ---------------------------------------------------------------- customer
export const wallet = {
  methods: () => rpc<PaymentMethods>('finance_payment_methods'),
  summary: () => rpc<WalletSummary>('finance_my_wallet'),
  transactions: (limit = 20, offset = 0) => rpc<{ total: number; items: WalletTxn[] }>('finance_my_wallet_transactions', { p_limit: limit, p_offset: offset }),
  deposits: (limit = 20) => rpc<Deposit[]>('finance_my_deposits', { p_limit: limit }),
  createDeposit: (bank: string, amount: number, key: string, ref?: string) => rpc<Deposit>('finance_deposit_create', { p_bank: bank, p_amount: amount, p_key: key, p_customer_ref: ref || null }),
  cancelDeposit: (id: string) => rpc<Deposit>('finance_deposit_cancel', { p_deposit: id }),
  /** Upload the slip into the customer's own folder of the private bucket, then record it. Credits nothing by itself. */
  async submitSlip(p: { depositId: string; file: File; transferAt: string | null; ref?: string }): Promise<Deposit> {
    const type = await sniffType(p.file);
    if (!type) throw new ShopError('Only JPG, PNG or PDF files are accepted', 'BAD_FILE_TYPE');
    if (p.file.size > EVIDENCE_MAX) throw new ShopError('The file must be 5 MB or smaller', 'FILE_TOO_BIG');
    const { data: u } = await supabase.auth.getUser();
    const uid = u.user?.id; if (!uid) throw new ShopError('Please sign in', 'FORBIDDEN');
    const sum = await sha256(p.file);
    const path = `${uid}/deposit/${new Date().toISOString().slice(0, 10)}/${newKey()}.${type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg'}`;
    const up = await supabase.storage.from('payment-evidence').upload(path, p.file, { contentType: type, upsert: false });
    if (up.error) throw new ShopError(up.error.message, 'UPLOAD_FAILED');
    try {
      return await rpc<Deposit>('finance_deposit_submit_slip', { p_deposit: p.depositId, p_file_path: path, p_sha256: sum, p_file_type: type, p_transfer_at: p.transferAt, p_customer_ref: p.ref || null });
    } catch (e) { void supabase.storage.from('payment-evidence').remove([path]); throw e; }
  },
  payInvoice: (invoice: string, amount: number, key: string) => rpc<PayWalletResult>('finance_pay_invoice_with_wallet', { p_invoice: invoice, p_amount: amount, p_key: key }),
};

// ---------------------------------------------------------------- staff
export const walletAdmin = {
  payments: (p: { kind?: string; status?: string; bank?: string; search?: string; limit?: number; offset?: number }) =>
    rpc<{ total: number; items: PaymentRow[] }>('finance_payments_overview', { p_kind: p.kind || null, p_status: p.status || null, p_bank: p.bank || null, p_search: p.search || null, p_limit: p.limit ?? 50, p_offset: p.offset ?? 0 }),
  wallets: (search?: string, limit = 50, offset = 0) => rpc<{ total: number; sum_balance: number; items: WalletRow[] }>('finance_wallets_overview', { p_search: search || null, p_limit: limit, p_offset: offset }),
  ledger: (customer: string, limit = 50, offset = 0) => rpc<{ balance: number; total: number; items: LedgerRow[] }>('finance_wallet_ledger', { p_customer: customer, p_limit: limit, p_offset: offset }),
  startReview: (id: string) => rpc<void>('finance_deposit_start_review', { p_deposit: id }),
  verifyDeposit: (p: { id: string; amount: number; bankTransRef: string; transferAt: string; note?: string }) =>
    rpc<{ txn_no: string; balance: number }>('finance_deposit_verify', { p_deposit: p.id, p_amount: p.amount, p_bank_trans_ref: p.bankTransRef, p_transfer_at: p.transferAt, p_note: p.note || null }),
  rejectDeposit: (id: string, reason: string) => rpc<void>('finance_deposit_reject', { p_deposit: id, p_reason: reason }),
  adjust: (p: { customer: string; direction: 'credit' | 'debit'; amount: number; reason: string; customerNote?: string; key: string }) =>
    rpc<{ txn_no: string; balance: number }>('finance_wallet_adjust', { p_customer: p.customer, p_direction: p.direction, p_amount: p.amount, p_reason: p.reason, p_key: p.key, p_customer_note: p.customerNote || null }),
  reverse: (txn: string, reason: string) => rpc<{ txn_no: string; balance: number }>('finance_wallet_reverse', { p_txn: txn, p_reason: reason }),
  refund: (p: { receipt: string; amount: number; reason: string; key: string }) => rpc<{ txn_no: string; balance: number }>('finance_wallet_refund', { p_receipt: p.receipt, p_amount: p.amount, p_reason: p.reason, p_key: p.key }),
  /** Reversed bank receipts of one customer that can still be refunded into their wallet. */
  async refundable(customer: string): Promise<{ id: string; receipt_no: string; amount: number; reverse_reason: string | null }[]> {
    const r = await supabase.from('finance_receipts').select('id, receipt_no, amount, reverse_reason').eq('customer_id', customer).eq('status', 'reversed').is('wallet_txn_id', null).order('created_at', { ascending: false });
    if (r.error) throw new ShopError(r.error.message, 'ERROR');
    return r.data ?? [];
  },
  reconcile: () => rpc<WalletReconcile>('finance_wallet_reconcile'),
  glReconciliation: () => rpc<Reconciliation>('finance_gl_reconciliation'),
  bankReport: (from: string, to: string, bank?: string) => rpc<BankReportRow[]>('finance_bank_daily_report', { p_from: from, p_to: to, p_bank: bank || null }),
  glQueue: (status = 'pending', limit = 200) => rpc<{ settings: FinanceSettings; items: GlRow[] }>('finance_gl_pending', { p_status: status, p_limit: limit }),
  glMarkPosted: (id: string, journalNo: string) => rpc<void>('finance_gl_mark_posted', { p_id: id, p_journal_no: journalNo, p_posted_ref: `FINQ:${id}` }),
  glVoid: (id: string, reason: string) => rpc<void>('finance_gl_void', { p_id: id, p_reason: reason }),
  saveSettings: (patch: Partial<Omit<FinanceSettings, 'updated_at'>>) => rpc<FinanceSettings>('finance_save_settings', { p_patch: patch }),
  async banks(): Promise<BankAccountRow[]> {
    const r = await supabase.from('finance_bank_accounts').select('*').order('sort_order').order('code');
    if (r.error) throw new ShopError(r.error.message, 'ERROR');
    return r.data as BankAccountRow[];
  },
  saveBank: (b: Partial<BankAccountRow> & { code: string; bank_name_en: string; bank_name_th: string; account_no: string; account_name: string }) => rpc<BankAccountRow>('finance_save_bank_account', {
    p_id: b.id ?? null, p_code: b.code, p_bank_name_en: b.bank_name_en, p_bank_name_th: b.bank_name_th, p_account_no: b.account_no, p_account_name: b.account_name, p_branch: b.branch ?? null,
    p_logo_url: b.logo_url ?? null, p_instructions_th: b.instructions_th ?? null, p_instructions_en: b.instructions_en ?? null, p_gl_account_code: b.gl_account_code ?? null, p_sort_order: b.sort_order ?? 100, p_active: b.active ?? true,
  }),
};
