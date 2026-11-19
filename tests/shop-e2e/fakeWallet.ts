// The wallet / bank accounts / deposits part of the fake backend. It mirrors the CONTRACT of
// supabase/migrations/20261115200000_wallet_payments.sql (which is tested for real by supabase/tests/wallet_payments.sql):
// a slip never credits the wallet, only a verifier's approval does, with the amount the bank shows; wallet payments never exceed
// the balance or the invoice's outstanding amount; the same key never creates a second deposit or a second charge; adjustments
// need a manager. This file proves the SCREENS. It proves nothing about the database.
import type { FakeShop } from './fakeBackend';

export const NOT_HANDLED = Symbol('not handled');
export interface FBank { id: string; code: string; bank_name_en: string; bank_name_th: string; account_no: string; account_name: string; logo_url: string | null; instructions_th: string | null; instructions_en: string | null; branch: string | null; gl_account_code: string | null; sort_order: number; active: boolean }
export interface FTxn { id: string; seq: number; txn_no: string; txn_type: string; direction: 'credit' | 'debit'; amount: number; balance_before: number; balance_after: number; ref_no: string | null; ref_id: string | null; payment_method: string | null; verification_status: string; bank_id: string | null; remarks: string | null; customer_note: string | null; txn_date: string; reversal_of: string | null; created_by_email: string; approved_by_email: string | null }
export interface FDeposit { id: string; deposit_no: string; status: string; amount: number; verified_amount: number | null; bank_id: string; created_at: string; submitted_at: string | null; reject_reason: string | null; file_path: string | null; customer_ref: string | null; key: string; bank_trans_ref: string | null }
export type FRole = null | 'viewer' | 'clerk' | 'verifier' | 'manager';

export const SCB: FBank = { id: 'bank-scb', code: 'SCB', bank_name_en: 'Siam Commercial Bank', bank_name_th: 'ธนาคารไทยพาณิชย์', account_no: '5194026251', account_name: 'ณัฐพล อยู่ยิ้ม', logo_url: null, instructions_th: 'โอนตามยอดที่ระบุ แล้วแนบสลิป', instructions_en: 'Transfer the exact amount, then attach the slip', branch: null, gl_account_code: null, sort_order: 10, active: true };
export const BBL: FBank = { id: 'bank-bbl', code: 'BBL', bank_name_en: 'Bangkok Bank', bank_name_th: 'ธนาคารกรุงเทพ', account_no: '9380319542', account_name: 'ณัฐพร อยู่ยิ้ม', logo_url: null, instructions_th: null, instructions_en: null, branch: null, gl_account_code: null, sort_order: 20, active: true };

const NAME = 'สมชาย ใจดี';
const pad = (n: number, w = 5) => String(n).padStart(w, '0');

export class FakeWallet {
  banks: FBank[] = [{ ...SCB }, { ...BBL }];
  balance = 0;
  txns: FTxn[] = [];
  deposits: FDeposit[] = [];
  role: FRole = null;                 // the signed-in user's finance role (staff tests set it)
  enabled = true;                     // false = the wallet migration is not installed (old database)
  promptpay = true;                   // false = no PromptPay account is set up (the QR is not offered), like production today
  settings = { min_deposit: 100, max_deposit: 100000, max_open_deposits: 3, adjustment_limit: 5000, adjustment_role: 'settlement_variance', invoice_vat_mode: 'unset' as 'unset' | 'none' | 'inclusive', vat_rate: 7, updated_at: new Date().toISOString() };
  queue: { id: string; seq: number; event_type: string; ref_no: string; amount: number; plan: unknown[]; status: 'pending' | 'posted' | 'void'; journal_no: string | null; event_date: string }[] = [];
  /** cash received at the back office and posted today (the CASH line of the daily bank report); 0 = none */
  cashToday = 0;
  invoiceBank = new Map<string, string>();       // invoice slip -> bank id (what the customer chose)
  private keys = new Map<string, { hash: string; out: unknown }>();
  private n = 0;
  private slips: { id: string; invoice_id: string; no: string; amount: number; status: string; created_at: string; bank_id: string | null }[] = [];

  private shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }
  private err(m: string): never { throw new Error(m); }
  private need(min: 'viewer' | 'clerk' | 'verifier' | 'manager') {
    const rank = { viewer: 1, clerk: 2, verifier: 3, manager: 4 } as const;
    if (!this.role || rank[this.role] < rank[min]) this.err('FORBIDDEN: not allowed');
  }
  private bank(id: string | null) { return id ? this.banks.find((b) => b.id === id) ?? null : null; }
  private pubBank(b: FBank) { return { id: b.id, code: b.code, bank_name_en: b.bank_name_en, bank_name_th: b.bank_name_th, account_no: b.account_no, account_name: b.account_name, logo_url: b.logo_url, instructions_th: b.instructions_th, instructions_en: b.instructions_en }; }
  private depJson(d: FDeposit) {
    const b = this.bank(d.bank_id);
    return { id: d.id, deposit_no: d.deposit_no, status: d.status, amount: d.amount, verified_amount: d.verified_amount, created_at: d.created_at, submitted_at: d.submitted_at, reject_reason: d.reject_reason, has_slip: !!d.file_path, customer_ref: d.customer_ref,
      bank: b ? { id: b.id, code: b.code, bank_name_th: b.bank_name_th, bank_name_en: b.bank_name_en, account_no: b.account_no, account_name: b.account_name } : null };
  }
  private txnJson(x: FTxn) {
    const b = this.bank(x.bank_id);
    return { id: x.id, txn_no: x.txn_no, txn_type: x.txn_type, direction: x.direction, amount: x.amount, balance_before: x.balance_before, balance_after: x.balance_after, ref_no: x.ref_no, payment_method: x.payment_method, verification_status: x.verification_status,
      bank: b ? { code: b.code, bank_name_th: b.bank_name_th, bank_name_en: b.bank_name_en } : null, note: x.customer_note, txn_date: x.txn_date };
  }
  /** the only place a balance changes (like finance_wallet_apply): a ledger row per change, never negative */
  private apply(type: string, direction: 'credit' | 'debit', amount: number, extra: Partial<FTxn>): FTxn {
    const after = Math.round((this.balance + (direction === 'credit' ? amount : -amount)) * 100) / 100;
    if (after < 0) this.err('INSUFFICIENT_FUNDS');
    const x: FTxn = { id: `wt-${++this.n}`, seq: this.n, txn_no: `WT-202611-${pad(this.n)}`, txn_type: type, direction, amount, balance_before: this.balance, balance_after: after, ref_no: null, ref_id: null, payment_method: null, verification_status: 'verified', bank_id: null, remarks: null, customer_note: null,
      txn_date: new Date(Date.now() + this.n * 1000).toISOString(), reversal_of: null, created_by_email: 'customer@example.test', approved_by_email: null, ...extra };
    this.balance = after; this.txns.push(x); return x;
  }
  private idem<T>(key: string, hash: string, run: () => T): { replay: boolean; out: T } {
    const have = this.keys.get(key);
    if (have) { if (have.hash !== hash) this.err('KEY_REUSED'); return { replay: true, out: have.out as T }; }
    const out = run(); this.keys.set(key, { hash, out }); return { replay: false, out };
  }
  /** test control: what a verifier does after checking the bank statement */
  private asStaff<T>(fn: () => T): T { const was = this.role; this.role = 'manager'; try { return fn(); } finally { this.role = was; } }
  verify(depositNo: string, amount?: number) { const d = this.deposits.find((x) => x.deposit_no === depositNo)!; this.asStaff(() => this.rpc('finance_deposit_verify', { p_deposit: d.id, p_amount: amount ?? d.amount, p_bank_trans_ref: 'BANKREF-' + d.deposit_no, p_transfer_at: new Date().toISOString(), p_note: null })); }
  reject(depositNo: string, reason: string) { const d = this.deposits.find((x) => x.deposit_no === depositNo)!; this.asStaff(() => this.rpc('finance_deposit_reject', { p_deposit: d.id, p_reason: reason })); }
  /** test control: staff take money out behind the customer's back (the screen showed an older balance) */
  drain(amount: number) { this.apply('ADJUSTMENT', 'debit', amount, { remarks: 'test drain', approved_by_email: 'staff@example.test', created_by_email: 'staff@example.test', payment_method: 'adjustment' }); }
  /** test control: a customer who already has money in the wallet */
  seedBalance(amount: number) { this.apply('DEPOSIT', 'credit', amount, { payment_method: 'bank_transfer', bank_id: SCB.id, ref_no: 'DEP-SEED', approved_by_email: 'staff@example.test' }); }

  rpc(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      // ---------------------------------------------------------------- customer
      case 'finance_payment_methods':
        if (!this.enabled) this.err('Could not find the function public.finance_payment_methods');
        return { banks: this.banks.filter((b) => b.active).sort((x, y) => x.sort_order - y.sort_order).map((b) => this.pubBank(b)), promptpay: this.promptpay, wallet: { balance: this.balance, min_deposit: this.settings.min_deposit, max_deposit: this.settings.max_deposit } };
      case 'finance_my_wallet': {
        if (!this.enabled) this.err('Could not find the function public.finance_my_wallet');
        const dep = this.txns.filter((x) => x.txn_type === 'DEPOSIT').reduce((s, x) => s + (x.direction === 'credit' ? x.amount : -x.amount), 0);
        const pay = this.txns.filter((x) => x.txn_type === 'INVOICE_PAYMENT').reduce((s, x) => s + x.amount, 0);
        const ref = this.txns.filter((x) => x.txn_type === 'REFUND').reduce((s, x) => s + x.amount, 0);
        return { balance: this.balance, total_deposits: dep, total_payments: pay, total_refunds: ref, pending_deposits: this.deposits.filter((d) => ['pending', 'submitted', 'under_review'].includes(d.status)).reduce((s, d) => s + d.amount, 0) };
      }
      case 'finance_my_wallet_transactions': {
        const xs = [...this.txns].sort((x, y) => y.seq - x.seq); const off = Number(a.p_offset ?? 0), lim = Number(a.p_limit ?? 20);
        return { total: xs.length, items: xs.slice(off, off + lim).map((x) => this.txnJson(x)) };
      }
      case 'finance_my_deposits': return [...this.deposits].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, Number(a.p_limit ?? 20)).map((d) => this.depJson(d));
      case 'finance_deposit_create': {
        const key = String(a.p_key ?? ''); if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) this.err('INVALID_KEY');
        const amount = Number(a.p_amount);
        const r = this.idem(key, JSON.stringify([a.p_bank, amount]), () => {
          const b = this.banks.find((x) => x.id === a.p_bank && x.active); if (!b) this.err('BANK_NOT_AVAILABLE');
          if (!(amount >= this.settings.min_deposit && amount <= this.settings.max_deposit) || Math.round(amount * 100) !== amount * 100) this.err('AMOUNT_OUT_OF_RANGE');
          if (this.deposits.filter((d) => ['pending', 'submitted', 'under_review'].includes(d.status)).length >= this.settings.max_open_deposits) this.err('TOO_MANY_OPEN_DEPOSITS');
          const id = `dep-${++this.n}`;
          const d: FDeposit = { id, deposit_no: `DEP-202611-${pad(this.deposits.length + 1)}`, status: 'pending', amount, verified_amount: null, bank_id: b.id, created_at: new Date(Date.now() + this.n * 1000).toISOString(), submitted_at: null, reject_reason: null, file_path: null, customer_ref: (a.p_customer_ref as string) ?? null, key, bank_trans_ref: null };
          this.deposits.push(d); return d.id;
        });
        return this.depJson(this.deposits.find((d) => d.id === r.out)!);
      }
      case 'finance_deposit_cancel': {
        const d = this.deposits.find((x) => x.id === a.p_deposit); if (!d) this.err('Deposit not found');
        if (!['pending', 'submitted'].includes(d.status)) this.err('DEPOSIT_NOT_CANCELLABLE');
        d.status = 'cancelled'; return this.depJson(d);
      }
      case 'finance_deposit_submit_slip': {
        const d = this.deposits.find((x) => x.id === a.p_deposit); if (!d) this.err('Deposit not found');
        if (d.status !== 'pending') this.err('DEPOSIT_NOT_PENDING');
        if (this.deposits.some((x) => x !== d && x.file_path && x.bank_trans_ref === String(a.p_sha256))) this.err('SLIP_ALREADY_USED');
        d.file_path = String(a.p_file_path); d.bank_trans_ref = String(a.p_sha256); d.status = 'submitted'; d.submitted_at = new Date().toISOString(); d.customer_ref = (a.p_customer_ref as string) ?? d.customer_ref;
        return this.depJson(d);                                                   // nothing is credited
      }
      case 'finance_pay_invoice_with_wallet': {
        const key = String(a.p_key ?? ''); if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) this.err('INVALID_KEY');
        const o = this.shop.orders.find((x) => x.invoice.id === a.p_invoice); if (!o) this.err('Invoice not found');
        const inv = o.invoice; const amount = Number(a.p_amount);
        const r = this.idem(key, JSON.stringify([a.p_invoice, amount]), () => {
          if (inv.cancelled) this.err('INVOICE_NOT_OPEN');
          const outstanding = inv.amount - inv.paid; if (outstanding <= 0) this.err('NOTHING_OUTSTANDING');
          if (inv.evidence.some((e) => e.status === 'submitted')) this.err('PAYMENT_UNDER_REVIEW');
          if (!(amount > 0) || Math.round(amount * 100) !== amount * 100) this.err('AMOUNT_OUT_OF_RANGE');
          if (amount > outstanding + 0.004) this.err('AMOUNT_EXCEEDS_OUTSTANDING');
          const x = this.apply('INVOICE_PAYMENT', 'debit', amount, { ref_no: inv.invoice_no, ref_id: inv.id, payment_method: 'wallet' });   // throws INSUFFICIENT_FUNDS
          inv.paid = Math.round((inv.paid + amount) * 100) / 100;
          this.queue.push({ id: `q-${++this.n}`, seq: this.n, event_type: 'WALLET_PAYMENT', ref_no: x.txn_no, amount, plan: [{ side: 'dr', role: 'customer_credit', amount, wallet: true }, { side: 'cr', role: 'ar', amount }], status: 'pending', journal_no: null, event_date: x.txn_date });
          return { receipt_no: `RC-${pad(this.n)}`, txn_no: x.txn_no, balance: this.balance, state: this.shop.invoiceState(inv) };
        });
        return { replay: r.replay, ...r.out };
      }

      // ---------------------------------------------------------------- staff
      case 'finance_payments_overview': {
        this.need('viewer');
        const q = String(a.p_search ?? '').toLowerCase();
        const rows: Record<string, unknown>[] = [
          ...this.deposits.map((d) => { const b = this.bank(d.bank_id); return { kind: 'deposit', id: d.id, no: d.deposit_no, customer_id: 'cust-1', customer_name: NAME, customer_code: 'LINE-TEST', invoice_no: null, amount: d.amount, verified_amount: d.verified_amount, status: d.status, bank_account_id: d.bank_id, bank_code: b?.code ?? null, bank_name_th: b?.bank_name_th ?? null, bank_name_en: b?.bank_name_en ?? null, created_at: d.created_at, file_path: d.file_path, bank_trans_ref: d.bank_trans_ref }; }),
          ...this.shop.orders.flatMap((o) => o.invoice.evidence.map((e) => { const b = this.bank(this.invoiceBank.get(e.id) ?? null); return { kind: 'invoice_slip', id: e.id, no: e.id, customer_id: 'cust-1', customer_name: NAME, customer_code: 'LINE-TEST', invoice_no: o.invoice.invoice_no, amount: e.claimed_amount, verified_amount: null, status: e.status, bank_account_id: b?.id ?? null, bank_code: b?.code ?? null, bank_name_th: b?.bank_name_th ?? null, bank_name_en: b?.bank_name_en ?? null, created_at: e.created_at, file_path: 'x/slip.png', bank_trans_ref: null }; })),
          ...this.txns.filter((x) => x.txn_type === 'INVOICE_PAYMENT').map((x) => ({ kind: 'wallet_payment', id: x.id, no: x.txn_no, customer_id: 'cust-1', customer_name: NAME, customer_code: 'LINE-TEST', invoice_no: x.ref_no, amount: x.amount, verified_amount: x.amount, status: 'verified', bank_account_id: null, bank_code: null, bank_name_th: null, bank_name_en: null, created_at: x.txn_date, file_path: null, bank_trans_ref: null })),
        ].filter((r) => (!a.p_kind || r.kind === a.p_kind) && (!a.p_status || r.status === a.p_status) && (!a.p_bank || r.bank_account_id === a.p_bank)
          && (!q || [r.customer_name, r.customer_code, r.invoice_no, r.no, r.bank_trans_ref].some((f) => String(f ?? '').toLowerCase().includes(q)))).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
        return { total: rows.length, items: rows.slice(Number(a.p_offset ?? 0), Number(a.p_offset ?? 0) + Number(a.p_limit ?? 50)) };
      }
      case 'finance_wallets_overview': {
        this.need('viewer');
        const has = this.txns.length > 0 || this.deposits.length > 0;
        const dep = this.txns.filter((x) => x.txn_type === 'DEPOSIT').reduce((s, x) => s + x.amount, 0), pay = this.txns.filter((x) => x.txn_type === 'INVOICE_PAYMENT').reduce((s, x) => s + x.amount, 0);
        const items = has ? [{ wallet_id: 'w-1', customer_id: 'cust-1', code: 'LINE-TEST', name: NAME, balance: this.balance, total_deposits: dep, total_payments: pay, last_activity: this.txns.at(-1)?.txn_date ?? null }] : [];
        return { total: items.length, sum_balance: this.balance, items };
      }
      case 'finance_wallet_ledger': {
        this.need('viewer');
        const xs = [...this.txns].sort((x, y) => y.seq - x.seq);
        return { balance: this.balance, total: xs.length, items: xs.map((x) => ({ ...this.txnJson(x), customer_id: 'cust-1', seq: x.seq, ref_type: null, ref_id: x.ref_id, remarks: x.remarks, customer_note: x.customer_note, bank_code: this.bank(x.bank_id)?.code ?? null, created_by_email: x.created_by_email, approved_by_email: x.approved_by_email, reversal_of: x.reversal_of })) };
      }
      case 'finance_deposit_start_review': {
        this.need('verifier'); const d = this.deposits.find((x) => x.id === a.p_deposit); if (!d) this.err('Deposit not found');
        if (d.status !== 'submitted') this.err('DEPOSIT_NOT_PENDING'); d.status = 'under_review'; return null;
      }
      case 'finance_deposit_verify': {
        this.need('verifier'); const d = this.deposits.find((x) => x.id === a.p_deposit); if (!d) this.err('Deposit not found');
        if (!['submitted', 'under_review'].includes(d.status)) this.err('DEPOSIT_NOT_PENDING');          // a pending deposit without a slip, or one already decided, credits nothing
        const amount = Number(a.p_amount); if (!(amount > 0)) this.err('AMOUNT_OUT_OF_RANGE');
        const x = this.apply('DEPOSIT', 'credit', amount, { ref_no: d.deposit_no, ref_id: d.id, payment_method: 'bank_transfer', bank_id: d.bank_id, approved_by_email: 'staff@example.test', remarks: String(a.p_note ?? '') || null });
        d.status = 'verified'; d.verified_amount = amount; d.bank_trans_ref = String(a.p_bank_trans_ref);
        this.queue.push({ id: `q-${++this.n}`, seq: this.n, event_type: 'WALLET_DEPOSIT', ref_no: x.txn_no, amount, plan: [{ side: 'dr', role: 'bank', amount, bank_account_id: d.bank_id }, { side: 'cr', role: 'customer_credit', amount, wallet: true }], status: 'pending', journal_no: null, event_date: x.txn_date });
        return { txn_no: x.txn_no, balance: this.balance };
      }
      case 'finance_deposit_reject': {
        this.need('verifier'); const d = this.deposits.find((x) => x.id === a.p_deposit); if (!d) this.err('Deposit not found');
        if (!['pending', 'submitted', 'under_review'].includes(d.status)) this.err('DEPOSIT_NOT_PENDING');
        if (!String(a.p_reason ?? '').trim()) this.err('A reason is required');
        d.status = 'rejected'; d.reject_reason = String(a.p_reason); return null;
      }
      case 'finance_wallet_adjust': {
        this.need('manager');
        const reason = String(a.p_reason ?? '').trim(); if (reason.length < 10) this.err('REASON_REQUIRED: write at least 10 characters');
        const amount = Number(a.p_amount); if (!(amount > 0)) this.err('AMOUNT_OUT_OF_RANGE');
        const r = this.idem(String(a.p_key), JSON.stringify([a.p_direction, amount]), () => this.apply('ADJUSTMENT', a.p_direction === 'debit' ? 'debit' : 'credit', amount, { remarks: reason, customer_note: (a.p_customer_note as string) ?? null, approved_by_email: 'staff@example.test', created_by_email: 'staff@example.test', payment_method: 'adjustment' }));
        return { txn_no: r.out.txn_no, balance: this.balance };
      }
      case 'finance_wallet_reverse': {
        this.need('manager'); const x = this.txns.find((t) => t.id === a.p_txn); if (!x) this.err('Transaction not found');
        if (this.txns.some((t) => t.reversal_of === x.id)) this.err('ALREADY_REVERSED');
        const r = this.apply('REVERSAL', x.direction === 'credit' ? 'debit' : 'credit', x.amount, { reversal_of: x.id, remarks: String(a.p_reason ?? ''), approved_by_email: 'staff@example.test', created_by_email: 'staff@example.test' });
        return { txn_no: r.txn_no, balance: this.balance };
      }
      case 'finance_wallet_reconcile': {
        this.need('viewer');
        const sum = this.txns.reduce((s, x) => s + (x.direction === 'credit' ? x.amount : -x.amount), 0);
        return { wallets: this.txns.length ? 1 : 0, balance_total: this.balance, ledger_total: Math.round(sum * 100) / 100, problems: Math.abs(sum - this.balance) < 0.005 ? [] : [{ customer_id: 'cust-1', problem: 'balance differs from ledger' }] };
      }
      case 'finance_gl_reconciliation': {
        this.need('viewer');
        const waiting = this.queue.filter((q) => q.status === 'pending' && ['WALLET_DEPOSIT', 'WALLET_PAYMENT'].includes(q.event_type)).reduce((s, q) => s + (q.event_type === 'WALLET_DEPOSIT' ? q.amount : -q.amount), 0);
        return { wallet_balances: this.balance, wallet_ledger: this.balance, gl_wallet_liability_posted: 0, gl_wallet_liability_waiting: waiting, difference: Math.round((this.balance - waiting) * 100) / 100, rows_waiting: this.queue.filter((q) => q.status === 'pending').length, rows_blocked: 0 };
      }
      case 'finance_gl_pending': {
        this.need('viewer');
        const items = this.queue.filter((q) => q.status === (a.p_status ?? 'pending')).map((q) => ({ ...q, ref_type: 'wallet_txn', ref_id: q.id, customer_id: 'cust-1', customer_name: NAME, depends_on: null, posted_at: null, void_reason: null, blocked_by: null, banks: Object.fromEntries(this.banks.map((b) => [b.id, { code: b.code, gl_account_code: b.gl_account_code }])) }));
        return { settings: this.settings, items };
      }
      case 'finance_gl_mark_posted': {
        this.need('verifier'); const q = this.queue.find((x) => x.id === a.p_id); if (!q) this.err('Entry not found');
        if (q.status === 'posted') { if (q.journal_no !== a.p_journal_no) this.err('ALREADY_POSTED'); return null; }
        q.status = 'posted'; q.journal_no = String(a.p_journal_no); return null;
      }
      case 'finance_gl_void': { this.need('manager'); const q = this.queue.find((x) => x.id === a.p_id); if (!q) this.err('Entry not found'); q.status = 'void'; return null; }
      case 'finance_bank_daily_report': {
        this.need('viewer');
        const day = new Date().toISOString().slice(0, 10); const out: Record<string, unknown>[] = [];
        if (this.cashToday > 0 && !a.p_bank) out.push({ day, bank_code: 'CASH', bank_account_id: null, deposits: 0, deposit_amount: 0, invoice_transfers: 1, invoice_amount: this.cashToday, total: this.cashToday, in_ledger: 0, waiting_for_ledger: this.cashToday });
        for (const b of this.banks) {
          if (a.p_bank && a.p_bank !== b.id) continue;
          const ds = this.deposits.filter((d) => d.bank_id === b.id && d.status === 'verified');
          if (!ds.length) continue;
          const amt = ds.reduce((s, d) => s + (d.verified_amount ?? 0), 0);
          out.push({ day, bank_code: b.code, bank_account_id: b.id, deposits: ds.length, deposit_amount: amt, invoice_transfers: 0, invoice_amount: 0, total: amt, in_ledger: 0, waiting_for_ledger: amt });
        }
        return out;
      }
      case 'finance_save_settings': { this.need('manager'); Object.assign(this.settings, a.p_patch as object); return this.settings; }
      case 'finance_save_bank_account': {
        this.need('manager');
        const f = { code: String(a.p_code), bank_name_en: String(a.p_bank_name_en), bank_name_th: String(a.p_bank_name_th), account_no: String(a.p_account_no), account_name: String(a.p_account_name), branch: (a.p_branch as string) ?? null, logo_url: (a.p_logo_url as string) ?? null,
          instructions_th: (a.p_instructions_th as string) ?? null, instructions_en: (a.p_instructions_en as string) ?? null, gl_account_code: (a.p_gl_account_code as string) ?? null, sort_order: Number(a.p_sort_order ?? 100), active: a.p_active !== false };
        if (!/^[0-9]{6,20}$/.test(f.account_no.replace(/[\s-]/g, ''))) this.err('INVALID_ACCOUNT_NO');
        const id = a.p_id ? String(a.p_id) : '';
        const have = this.banks.find((b) => b.id === id);
        if (have) { Object.assign(have, f); return have; }
        if (this.banks.some((b) => b.code.toUpperCase() === f.code.toUpperCase())) this.err('DUPLICATE_BANK_CODE');
        const nb: FBank = { id: `bank-${f.code.toLowerCase()}`, ...f }; this.banks.push(nb); return nb;
      }
      default: return NOT_HANDLED;
    }
  }

  /** invoice slips: remember which bank the customer chose (finance_submit_evidence with p_bank_account) */
  noteSlip(evidenceId: string, bank: string | null) { if (bank) this.invoiceBank.set(evidenceId, bank); }
  rest(table: string): unknown[] | null {
    if (table === 'finance_bank_accounts') return this.banks;
    if (table === 'finance_receipts') return [];
    return null;
  }
}
