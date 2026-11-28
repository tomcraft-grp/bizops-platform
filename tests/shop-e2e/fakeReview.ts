// The slip-review part of the fake backend (the end-of-day dashboard). It mirrors the CONTRACT of supabase/migrations/20261120100000_slip_review.sql (tested for real by
// the SQL suites): the same role ladder (viewer < clerk < verifier < manager), the same stages, the same refusals with the same messages, Confirm moves no money, Post is
// what makes a payment official (once), a staff-entered payment never exceeds what the invoice can still take, cash needs a note and only a manager posts cash. The AI reader is a stub: the Edge
// Function `slip-analyze` is not run, its calls are only recorded (analyzeCalls) and each analysis is a row the test seeds. This file proves the SCREENS; it proves
// nothing about the database.
import type { FakeShop } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';

type Status = 'submitted' | 'confirmed' | 'more_evidence' | 'verified' | 'rejected';
type Stage = 'slip_submitted' | 'ai_completed' | 'manual_review' | 'confirmed' | 'posted' | 'rejected' | 'more_evidence';
export interface RReason { code: string; severity: 'info' | 'warn' | 'high'; field: string | null; expected: unknown; found: unknown; message: string }
export interface RAnalysis {
  id: string; evidence_id: string; attempt: number; status: 'queued' | 'running' | 'done' | 'failed'; engine: string | null; prompt_version: string | null;
  extracted: Record<string, unknown> | null; qr: Record<string, unknown> | null; expected: Record<string, unknown> | null; overall_confidence: number | null; signals: { code: string; severity: 'low' | 'high'; detail: string }[];
  result: string | null; reasons: RReason[]; error: string | null; requested_by: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}
export interface REvidence {
  id: string; invoice_id: string; customer_id: string; file_path: string | null; file_type: string | null; file_sha256: string | null; claimed_amount: number; claimed_transfer_at: string | null;
  claimed_bank: string | null; claimed_ref: string | null; status: Status; verified_via: string | null; verified_amount: number | null; bank_trans_ref: string | null; reject_reason: string | null;
  reviewed_at: string | null; reviewed_by: string | null; created_at: string; request_id: string | null; bank_account_id: string | null; transfer_at: string | null; review_note: string | null;
  source: 'customer_slip' | 'staff_entry'; method: 'transfer' | 'cash'; recorded_by: string | null;
  confirmed_by: string | null; confirmed_at: string | null; confirmed_amount: number | null; confirmed_bank_ref: string | null; confirmed_transfer_at: string | null; confirm_note: string | null;
  posted_by: string | null; posted_at: string | null; request_message: string | null; requested_by: string | null; requested_at: string | null;
  /** 20261122140000: where it was confirmed (absent on rows seeded before it) */
  confirmed_via?: 'web' | 'line_quick' | null;
}
interface RInvoice { id: string; invoice_no: string; amount: number; customer_id: string; issue_date: string; created_at: string; order_no: string | null; status: 'open' | 'cancelled' }
interface RCustomer { id: string; code: string; name: string; phone: string }
interface RReceipt { id: string; receipt_no: string; invoice_id: string; evidence_id: string; amount: number; bank_trans_ref: string | null; received_at: string; needs_review: boolean; status: 'posted'; created_at: string; method: 'bank_transfer' | 'cash' }
export interface RSettings { ai_review_enabled: boolean; post_requires_manager: boolean; ai_min_confidence: number; slip_window_before_min: number; slip_future_tolerance_min: number }

const ACTOR = 'staff@example.test';
const RANK = { viewer: 1, clerk: 2, verifier: 3, manager: 4 } as const;
const NEED = { view: 1, verify: 3, manage: 4 } as const;
const STAGES: Stage[] = ['slip_submitted', 'ai_completed', 'manual_review', 'confirmed', 'posted', 'rejected', 'more_evidence'];
const RESULTS = ['match', 'amount_mismatch', 'date_mismatch', 'time_anomaly', 'duplicate_suspected', 'suspicious_slip', 'manual_review'];
const norm = (s: string | null | undefined) => (s ?? '').replace(/[^0-9A-Za-z]/g, '').toLowerCase();       // finance_slip_ref: letters and digits only
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Bangkok calendar day of an instant (YYYY-MM-DD) */
const bkkDay = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10);

export const RECEIVERS = [{ label: 'SCB · ณัฐพล อยู่ยิ้ม', bank: 'SCB', name: 'ณัฐพล อยู่ยิ้ม', account_no_masked_digits: 'xxx-x-x2625-1' }];

export class FakeReview {
  /** false = a database without the slip-review migration: every review function is "not found" */
  enabled = true;
  /** a refusal the next Confirm answers with (e.g. DUPLICATE_SUSPECT, which needs a same-minute twin the seed data does not have) */
  forceConfirmError: string | null = null;
  settings: RSettings = { ai_review_enabled: true, post_requires_manager: false, ai_min_confidence: 0.8, slip_window_before_min: 120, slip_future_tolerance_min: 10 };
  customers: RCustomer[] = [];
  invoices: RInvoice[] = [];
  evidence: REvidence[] = [];
  analyses: RAnalysis[] = [];
  receipts: RReceipt[] = [];
  events: { evidence_id: string; id: number; at: string; actor: string; actor_email: string; action: string; detail: Record<string, unknown> }[] = [];
  /** every call of the Edge Function slip-analyze (the body the browser sent); the function itself is not run */
  analyzeCalls: Record<string, unknown>[] = [];
  private n = 0;
  private shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }

  // ------------------------------------------------------------ seed: 4 slips to check, 1 confirmed, 1 posted
  /** ids: ev-1 match, ev-2 amount mismatch (350 expected, 300 read), ev-3 duplicate, ev-4 queued (no reading yet), ev-5 confirmed, ev-6 posted */
  seed() {
    const day = '2026-11-19';
    const at = (hm: string) => `${day}T${hm}:00+07:00`;
    const person = (i: number, name: string, phone: string): RCustomer => ({ id: `cust-${i}`, code: `LINE-${i}`, name, phone });
    this.customers = [person(1, 'Anan Srisuk', '0811111111'), person(2, 'Boonmee Chai', '0822222222'), person(3, 'Chaiya Phon', '0833333333'), person(4, 'Dao Rungrat', '0844444444'), person(5, 'Ek Wattana', '0855555555'), person(6, 'Fon Sawat', '0866666666')];
    const inv = (i: number, amount: number, hm: string): RInvoice => ({ id: `inv-${i}`, invoice_no: `INV-00010${i}`, amount, customer_id: `cust-${i}`, issue_date: day, created_at: at(hm), order_no: `ORD-00010${i}`, status: 'open' });
    this.invoices = [inv(1, 350, '09:55'), inv(2, 350, '10:40'), inv(3, 500, '10:45'), inv(4, 120, '11:50'), inv(5, 220, '08:30'), inv(6, 180, '08:00')];
    const ev = (i: number, created: string, patch: Partial<REvidence> = {}): REvidence => ({
      id: `ev-${i}`, invoice_id: `inv-${i}`, customer_id: `cust-${i}`, file_path: `u/${day}/slip-${i}.png`, file_type: 'image/png', file_sha256: `${i}`.repeat(64).slice(0, 64), claimed_amount: this.invoices[i - 1].amount, claimed_transfer_at: null,
      claimed_bank: null, claimed_ref: null, status: 'submitted', verified_via: null, verified_amount: null, bank_trans_ref: null, reject_reason: null, reviewed_at: null, reviewed_by: null, created_at: at(created), request_id: null,
      bank_account_id: null, transfer_at: null, review_note: null, source: 'customer_slip', method: 'transfer', recorded_by: null, confirmed_by: null, confirmed_at: null, confirmed_amount: null, confirmed_bank_ref: null,
      confirmed_transfer_at: null, confirm_note: null, posted_by: null, posted_at: null, request_message: null, requested_by: null, requested_at: null, ...patch,
    });
    this.evidence = [
      ev(1, '10:30'), ev(2, '11:10'), ev(3, '11:20'), ev(4, '12:05'),
      ev(5, '08:40', { status: 'confirmed', confirmed_by: 'u-verifier', confirmed_at: at('09:00'), confirmed_amount: 220, confirmed_bank_ref: 'KB-C1-REF-0001', confirmed_transfer_at: at('08:35') }),
      ev(6, '08:10', { status: 'verified', verified_via: 'staff', verified_amount: 180, bank_trans_ref: 'KB-P1-REF-0002', transfer_at: at('08:05'), reviewed_at: at('09:30'), confirmed_by: 'u-verifier', confirmed_at: at('09:00'), confirmed_amount: 180, confirmed_bank_ref: 'KB-P1-REF-0002', confirmed_transfer_at: at('08:05'), posted_by: 'u-manager', posted_at: at('09:30') }),
    ];
    this.receipts = [{ id: 'rc-1', receipt_no: 'RC-000001', invoice_id: 'inv-6', evidence_id: 'ev-6', amount: 180, bank_trans_ref: 'KB-P1-REF-0002', received_at: at('08:05'), needs_review: false, status: 'posted', created_at: at('09:30'), method: 'bank_transfer' }];
    const party = (name: string | null, bank: string | null, hint: string | null) => ({ name, bank, account_hint: hint });
    const read = (amount: number | null, ref: string, hm: string, conf = 0.97) => ({
      amount, transfer_at: at(hm), time_known: true, is_slip: true, bank: 'KBank', sender: party('Customer', 'KBank', 'xxx-x-x1234-5'), receiver: party('ณัฐพล อยู่ยิ้ม', 'SCB', 'xxx-x-x2625-1'), trans_ref: ref, trans_id: null, status_text: 'โอนเงินสำเร็จ',
      field_confidence: { amount: conf, date: 0.98, time: 0.96, receiver: 0.95, ref: 0.94 },
    });
    const qr = (ref: string) => ({ found: true, crc_ok: true, sending_bank: '004', trans_ref: ref });
    const exp = (i: number, amount: number, from: string, to: string) => ({ amount, order_created_at: this.invoices[i - 1].created_at, window_from: at(from), window_to: at(to), receivers: RECEIVERS });
    const done = (i: number, p: Partial<RAnalysis>): RAnalysis => ({
      id: `an-${i}-1`, evidence_id: `ev-${i}`, attempt: 1, status: 'done', engine: 'claude-haiku-5-5', prompt_version: 'v1', extracted: null, qr: null, expected: null, overall_confidence: 0.97, signals: [], result: 'match', reasons: [], error: null,
      requested_by: null, created_at: at('10:31'), started_at: at('10:31'), finished_at: at('10:32'), ...p,
    });
    this.analyses = [
      done(1, { extracted: read(350, 'KB20261119101200ABC', '10:12'), qr: qr('KB20261119101200ABC'), expected: exp(1, 350, '07:55', '10:40'), result: 'match', overall_confidence: 0.97,
        reasons: [{ code: 'RESUBMITTED_TRANSFER', severity: 'info', field: 'trans_ref', expected: null, found: 'ev-0', message: 'The customer resent a transfer already sent on an earlier slip of this order.' }] }),
      done(2, { extracted: read(300, 'SCB777000222', '10:50', 0.93), qr: qr('SCB777000222'), expected: exp(2, 350, '08:40', '11:20'), result: 'amount_mismatch', overall_confidence: 0.93,
        reasons: [{ code: 'AMOUNT_UNDER', severity: 'high', field: 'amount', expected: 350, found: 300, message: 'The slip shows less than the order expects.' }] }),
      done(3, { extracted: read(500, 'SCB555000999', '11:15', 0.91), qr: qr('SCB555000999'), expected: exp(3, 500, '08:45', '11:30'), result: 'duplicate_suspected', overall_confidence: 0.91,
        reasons: [{ code: 'DUPLICATE_REFERENCE', severity: 'high', field: 'trans_ref', expected: null, found: 'SCB555000999', message: 'This reference was seen on a receipt.' },
          { code: 'DUPLICATE_REFERENCE', severity: 'high', field: 'trans_ref', expected: null, found: 'SCB555000999', message: 'This reference was seen on another slip.' }],
        signals: [{ code: 'font_mismatch', severity: 'high', detail: 'The digits of the amount use another font' }] }),
      done(4, { id: 'an-4-1', status: 'queued', engine: null, prompt_version: null, overall_confidence: null, result: null, started_at: null, finished_at: null, created_at: at('12:05') }),
      done(5, { extracted: read(220, 'KB-C1-REF-0001', '08:35'), qr: qr('KB-C1-REF-0001'), expected: exp(5, 220, '06:30', '08:50'), result: 'match', overall_confidence: 0.98 }),
    ];
    this.events = [];
    this.n = 100;
  }

  // ------------------------------------------------------------ helpers (the SQL's rules)
  private err(m: string): never { throw new Error(m); }
  private need(cap: keyof typeof NEED, what: string) {
    const role = this.shop.w.role;
    if (!role || RANK[role] < NEED[cap]) this.err(`You are not allowed to ${what}`);
  }
  /** The fake's own clock (the staff page is held at the same moment by openReview): a fixed day, so "today" does not depend on when the tests run. Every call is one second later. */
  clockIso = '2026-11-19T12:00:00+07:00';
  private tick = 0;
  private now() { return new Date(Date.parse(this.clockIso) + (++this.tick) * 1000).toISOString(); }
  private inv(id: string) { return this.invoices.find((x) => x.id === id)!; }
  private ev(id: unknown) { const e = this.evidence.find((x) => x.id === id); if (!e) this.err('Evidence not found'); return e; }
  private cust(id: string) { return this.customers.find((x) => x.id === id)!; }
  private log(e: REvidence, action: string, detail: Record<string, unknown>) { this.events.push({ evidence_id: e.id, id: ++this.n, at: this.now(), actor: 'u-me', actor_email: ACTOR, action, detail }); }
  private newest(e: REvidence) { return this.analyses.filter((a) => a.evidence_id === e.id).sort((x, y) => y.attempt - x.attempt)[0] ?? null; }
  private newestDone(e: REvidence) { return this.analyses.filter((a) => a.evidence_id === e.id && a.status === 'done').sort((x, y) => y.attempt - x.attempt)[0] ?? null; }
  stage(e: REvidence): Stage {
    const a = this.newest(e);
    if (e.status === 'submitted') return a?.status === 'failed' ? 'manual_review' : a?.status === 'done' ? (a.result === 'match' ? 'ai_completed' : 'manual_review') : 'slip_submitted';
    return ({ confirmed: 'confirmed', verified: 'posted', rejected: 'rejected', more_evidence: 'more_evidence' } as const)[e.status];
  }
  private paid(i: RInvoice) { return r2(this.receipts.filter((r) => r.invoice_id === i.id).reduce((s, r) => s + Math.min(r.amount, i.amount), 0)); }
  private confirmedPending(i: RInvoice) { return r2(this.evidence.filter((e) => e.invoice_id === i.id && e.status === 'confirmed').reduce((s, e) => s + (e.confirmed_amount ?? 0), 0)); }
  private state(i: RInvoice) {
    const paid = this.paid(i); const outstanding = r2(i.amount - paid);
    const evs = this.evidence.filter((e) => e.invoice_id === i.id).sort((x, y) => y.created_at.localeCompare(x.created_at));
    const pending = evs.filter((e) => e.status === 'submitted' || e.status === 'confirmed').length;
    const last = evs[0];
    const code = i.status === 'cancelled' ? 8 : outstanding <= 0 ? 5 : pending > 0 ? 3 : last?.status === 'more_evidence' ? 10 : paid > 0 ? 4 : last?.status === 'rejected' ? 7 : 0;
    const names: Record<number, string> = { 0: 'unpaid', 3: 'pending_verification', 4: 'partially_paid', 5: 'fully_paid', 7: 'rejected', 8: 'cancelled', 10: 'more_evidence' };
    return { invoice_id: i.id, amount: i.amount, paid, outstanding, unapplied: 0, refunded: 0, status_code: code, status: names[code], pending_evidence: pending, request: null, confirmed_pending: this.confirmedPending(i),
      more_evidence_message: last?.status === 'more_evidence' ? last.request_message : null };
  }
  /** finance_review_expected: what the newest finished analysis expected, else what the invoice still owes (posted receipts only) */
  private expected(e: REvidence): number | null {
    const d = this.newestDone(e); const x = d?.expected?.amount;
    if (typeof x === 'number') return x;
    const i = this.inv(e.invoice_id); return Math.max(r2(i.amount - this.paid(i)), 0);
  }
  private aiAmount(e: REvidence): number | null { const a = this.newestDone(e)?.extracted?.amount; return typeof a === 'number' ? a : null; }
  private refInUse(ref: string, except: string | null): string | null {
    const k = norm(ref);
    if (this.receipts.some((r) => r.bank_trans_ref && norm(r.bank_trans_ref) === k)) return 'receipt';
    if (this.evidence.some((x) => x.id !== except && (x.status === 'confirmed' || x.status === 'verified') && ((x.confirmed_bank_ref && norm(x.confirmed_bank_ref) === k) || (x.bank_trans_ref && norm(x.bank_trans_ref) === k)))) return 'evidence';
    return null;
  }

  // ------------------------------------------------------------ JSON shapes (the same keys the SQL builds)
  item(e: REvidence) {
    const i = this.inv(e.invoice_id); const c = this.cust(e.customer_id); const a = this.newest(e); const d = this.newestDone(e); const st = this.state(i);
    return {
      evidence_id: e.id, created_at: e.created_at, source: e.source, method: e.method, status: e.status, stage: this.stage(e),
      order_id: i.order_no ? `ord-${i.id}` : null, order_no: i.order_no, order_created_at: i.order_no ? i.created_at : null, order_total: i.order_no ? i.amount : null,
      invoice_id: i.id, invoice_no: i.invoice_no, invoice_amount: i.amount, paid: st.paid, outstanding: st.outstanding,
      customer_name: c.name, customer_phone: c.phone, expected_amount: this.expected(e), claimed_amount: e.claimed_amount,
      ai_amount: this.aiAmount(e), ai_transfer_at: (d?.extracted?.transfer_at as string | undefined) ?? null, ai_result: a?.result ?? null, ai_confidence: d?.overall_confidence ?? null, ai_status: a?.status ?? null,
      reasons: (a?.reasons ?? []).map((r) => r.code), confirmed_amount: e.confirmed_amount, confirmed_bank_ref: e.confirmed_bank_ref, posted_at: e.posted_at,
      confirmed_via: e.confirmed_via ?? null, no_ref: e.method === 'transfer' && !e.confirmed_bank_ref && !e.bank_trans_ref,
    };
  }
  private detail(e: REvidence) {
    const i = this.inv(e.invoice_id); const c = this.cust(e.customer_id);
    const items = [{ line_no: 1, sku_code: 'FG-000001', name: 'Mixed fruit pod 6000', unit: 'pcs', unit_price: i.amount - 50, qty: 1, line_total: i.amount - 50 }];
    return {
      evidence: { ...e, stage: this.stage(e), expected_amount: this.expected(e) },
      analyses: this.analyses.filter((a) => a.evidence_id === e.id).sort((x, y) => y.attempt - x.attempt).map(({ evidence_id: _e, ...rest }) => { void _e; return rest; }),
      order: i.order_no ? { id: `ord-${i.id}`, order_no: i.order_no, status: 'new', fulfilment: 'delivery', channel: 'LINE', contact_name: c.name, contact_phone: c.phone, delivery_address: '99 Test Road, Bangkok', note: null, subtotal: i.amount - 50, discount: 0, shipping_fee: 50,
        total: i.amount, created_at: i.created_at, updated_at: i.created_at, status_note: null, cancel_reason: null, cancelled_at: null, profile_id: `p-${c.id}`, customer_id: c.id, invoice_id: i.id, items } : null,
      invoice: { id: i.id, invoice_no: i.invoice_no, issue_date: i.issue_date, due_date: i.issue_date, description: i.order_no ? `Online order ${i.order_no}` : null, invoice_status: i.status, cancel_reason: null, created_at: i.created_at, ...this.state(i) },
      customer: { id: c.id, code: c.code, name: c.name, phone: c.phone },
      receipts: this.receipts.filter((r) => r.invoice_id === i.id).map((r) => ({ ...r, customer_id: c.id, method: r.method })),
      other_evidence: this.evidence.filter((x) => x.invoice_id === i.id && x.id !== e.id).map((x) => ({ id: x.id, status: x.status, amount: x.verified_amount ?? x.confirmed_amount ?? x.claimed_amount, created_at: x.created_at, source: x.source, method: x.method })),
      events: this.events.filter((v) => v.evidence_id === e.id).sort((x, y) => y.id - x.id).slice(0, 30).map(({ evidence_id: _e, ...rest }) => { void _e; return rest; }),
    };
  }

  // ------------------------------------------------------------ the RPCs
  rpc(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'finance_review_list': case 'finance_review_summary': case 'finance_review_detail': case 'finance_review_settings': case 'finance_save_review_settings':
      case 'finance_confirm_evidence': case 'finance_post_evidence': case 'finance_request_more_evidence': case 'finance_record_payment': case 'finance_request_analysis':
        if (!this.enabled) this.err(`Could not find the function public.${fn} in the schema cache`);
        break;
      case 'finance_set_checkout_check': case 'finance_own_reader': case 'finance_set_own_reader': case 'finance_store_reading': if (this.ownReader === null) this.err(`Could not find the function public.${fn} in the schema cache`); break;
      case 'finance_reject_evidence': break;
      case 'finance_invoice_overview': break;
      // 20261128150000 (the receiver check, feedback, the accuracy card): a database without it has none of these
      case 'finance_slip_learning': case 'finance_slip_recipients': case 'finance_slip_feedback_add': case 'finance_slip_variant_impact': case 'finance_slip_variant_add': case 'finance_slip_variant_retire':
        if (!this.learning) this.err(`Could not find the function public.${fn} in the schema cache`);
        return this.learn(fn, a);
      default: return NOT_HANDLED;
    }
    switch (fn) {
      case 'finance_review_list': return this.list(a);
      case 'finance_review_summary': return this.summary(a);
      case 'finance_review_detail': { this.need('view', 'see the slip review'); return this.detail(this.ev(a.p_evidence)); }
      case 'finance_review_settings': { this.need('view', 'see the slip review settings'); return { ...this.settings }; }
      case 'finance_save_review_settings': return this.saveSettings(a.p_patch);
      case 'finance_confirm_evidence': return this.confirm(a);
      case 'finance_post_evidence': return this.post(a);
      case 'finance_reject_evidence': return this.reject(a);
      case 'finance_request_more_evidence': return this.requestMore(a);
      case 'finance_record_payment': return this.record(a);
      case 'finance_request_analysis': return this.requestAnalysis(a);
      case 'finance_own_reader': return this.readerStatus();
      case 'finance_set_own_reader': { this.need('manage', 'change the review settings'); this.ownReader = !!a.p_on; return this.readerStatus(); }
      case 'finance_set_checkout_check': { this.need('manage', 'change the review settings'); this.checkout = !!a.p_on; return this.readerStatus(); }
      case 'finance_store_reading': return this.storeReading(a);
      case 'finance_invoice_overview': {
        this.need('view', 'see invoices');
        return this.invoices.filter((i) => a.p_status == null || this.state(i).status_code === Number(a.p_status)).map((i) => ({ id: i.id, invoice_no: i.invoice_no, issue_date: i.issue_date, due_date: i.issue_date, description: i.order_no ? `Online order ${i.order_no}` : null,
          customer_name: this.cust(i.customer_id).name, customer_id: i.customer_id, customer_code: this.cust(i.customer_id).code, source_ref: i.order_no, ...this.state(i) }));
      }
    }
    return NOT_HANDLED;
  }

  private arr(v: unknown, name: string, allowed: string[]): string[] | null {
    if (v == null) return null;
    const xs = typeof v === 'string' ? [v] : Array.isArray(v) ? v : this.err(`INVALID_FILTER: ${name} must be text or a list of text`);
    if (xs.length > 20) this.err(`INVALID_FILTER: ${name} has too many values (at most 20)`);
    if (xs.some((x) => typeof x !== 'string')) this.err(`INVALID_FILTER: ${name} must be text or a list of text`);
    const out = [...new Set((xs as string[]).filter((x) => x.trim() !== ''))];
    if (!out.length) return null;
    if (out.some((x) => !allowed.includes(x))) this.err(`INVALID_FILTER: ${name} has a value that does not exist`);
    return out;
  }
  private date(v: unknown, name: string): string | null {
    if (v == null) return null; if (typeof v !== 'string') this.err(`INVALID_FILTER: ${name} must be a date written YYYY-MM-DD`);
    const s = v.trim(); if (s === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) this.err(`INVALID_FILTER: ${name} must be a date written YYYY-MM-DD`);
    return s;
  }
  private list(a: Record<string, unknown>) {
    this.need('view', 'see the slip review');
    const f = (a.p_filter ?? {}) as Record<string, unknown>;
    if (typeof f !== 'object' || Array.isArray(f)) this.err('INVALID_FILTER: the filter must be an object');
    for (const k of Object.keys(f)) if (!['stage', 'ai_result', 'from', 'to', 'reason', 'source', 'method', 'search', 'via'].includes(k)) this.err(`INVALID_FILTER: unknown filter ${k}`);
    const stage = this.arr(f.stage, 'stage', STAGES), result = this.arr(f.ai_result, 'ai_result', RESULTS), source = this.arr(f.source, 'source', ['customer_slip', 'staff_entry']), method = this.arr(f.method, 'method', ['transfer', 'cash']);
    const via = this.arr(f.via, 'via', ['web', 'line_quick']);
    const from = this.date(f.from, 'from'), to = this.date(f.to, 'to');
    if ((f.reason != null && typeof f.reason !== 'string') || (f.search != null && typeof f.search !== 'string')) this.err('INVALID_FILTER: reason and search must be text');
    const reason = String(f.reason ?? '').trim() || null; const q = String(f.search ?? '').trim().toLowerCase() || null; const qref = q && norm(q).length >= 4 ? norm(q) : null;
    const lim = Math.min(Math.max(Number(a.p_limit ?? 50), 1), 200), off = Math.max(Number(a.p_offset ?? 0), 0);
    const rows = this.evidence.filter((e) => {
      const i = this.inv(e.invoice_id); const c = this.cust(e.customer_id); const n = this.newest(e); const d = this.newestDone(e);
      if (from && bkkDay(e.created_at) < from) return false; if (to && bkkDay(e.created_at) > to) return false;
      if (source && !source.includes(e.source)) return false; if (method && !method.includes(e.method)) return false;
      if (via && !(e.confirmed_via && via.includes(e.confirmed_via))) return false;
      if (stage && !stage.includes(this.stage(e))) return false; if (result && !(n?.result && result.includes(n.result))) return false;
      if (reason && !(n?.reasons ?? []).some((r) => r.code === reason)) return false;
      if (q) {
        const hay = [i.order_no, i.invoice_no, c.name, e.confirmed_bank_ref, e.claimed_ref, e.bank_trans_ref, d?.extracted?.trans_ref as string | undefined, d?.qr?.trans_ref as string | undefined];
        if (!hay.some((x) => (x ?? '').toLowerCase().includes(q) || (qref && norm(x).includes(qref)))) return false;
      }
      return true;
    }).sort((x, y) => y.created_at.localeCompare(x.created_at) || x.id.localeCompare(y.id));
    return { total: rows.length, items: rows.slice(off, off + lim).map((e) => this.item(e)) };
  }
  private summary(a: Record<string, unknown>) {
    this.need('view', 'see the slip review');
    const from = a.p_from ? String(a.p_from) : null, to = a.p_to ? String(a.p_to) : null;
    const inRange = (iso: string | null) => (!from && !to) || (!!iso && (!from || bkkDay(iso) >= from) && (!to || bkkDay(iso) <= to));
    const rows = this.evidence.filter((e) => ['submitted', 'confirmed', 'more_evidence'].includes(e.status) || (e.status === 'verified' && inRange(e.posted_at ?? e.reviewed_at)) || (e.status === 'rejected' && inRange(e.reviewed_at)));
    const sum = (xs: number[]) => r2(xs.reduce((s, x) => s + x, 0));
    const awaiting = rows.filter((e) => e.status === 'submitted' || e.status === 'confirmed');
    const susp = (e: REvidence) => ['duplicate_suspected', 'suspicious_slip'].includes(this.newest(e)?.result ?? '');
    return {
      awaiting: { count: awaiting.length, expected_total: sum(awaiting.map((e) => this.expected(e) ?? 0)), ai_total: sum(awaiting.map((e) => this.aiAmount(e) ?? 0)) },
      ai_verified: rows.filter((e) => this.stage(e) === 'ai_completed').length,
      manual_review: rows.filter((e) => this.stage(e) === 'manual_review' && !susp(e)).length,
      suspicious: rows.filter((e) => this.stage(e) === 'manual_review' && susp(e)).length,
      confirmed: { count: rows.filter((e) => e.status === 'confirmed').length, amount: sum(rows.filter((e) => e.status === 'confirmed').map((e) => e.confirmed_amount ?? e.claimed_amount)) },
      posted: { count: rows.filter((e) => e.status === 'verified').length, amount: sum(rows.filter((e) => e.status === 'verified').map((e) => e.verified_amount ?? e.confirmed_amount ?? e.claimed_amount)) },
      rejected: rows.filter((e) => e.status === 'rejected').length, more_evidence: rows.filter((e) => e.status === 'more_evidence').length,
    };
  }
  private saveSettings(p: unknown) {
    this.need('manage', 'change the slip review settings');
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length) this.err('Nothing to save');
    const patch = p as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (!['ai_review_enabled', 'post_requires_manager', 'ai_min_confidence', 'slip_window_before_min', 'slip_future_tolerance_min'].includes(k)) this.err(`UNKNOWN_SETTING: ${k} cannot be changed here`);
      if ((k === 'ai_review_enabled' || k === 'post_requires_manager') && typeof v !== 'boolean') this.err(`INVALID_SETTING: ${k} must be true or false`);
      if (k === 'ai_min_confidence' && !(typeof v === 'number' && v >= 0 && v <= 1)) this.err('INVALID_SETTING: ai_min_confidence must be a number from 0 to 1');
      if ((k === 'slip_window_before_min' || k === 'slip_future_tolerance_min') && !(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1440)) this.err(`INVALID_SETTING: ${k} must be a whole number of minutes from 0 to 1440`);
    }
    Object.assign(this.settings, patch);
    if (typeof patch.ai_min_confidence === 'number') this.settings.ai_min_confidence = r2(patch.ai_min_confidence);
    return { ...this.settings };
  }
  private confirm(a: Record<string, unknown>) {
    this.need('verify', 'confirm payments');
    const amount = Number(a.p_amount); const ref = String(a.p_bank_trans_ref ?? '').trim(); const note = String(a.p_note ?? '').trim() || null;
    if (a.p_amount == null || !(amount > 0) || r2(amount) !== amount) this.err('Enter the amount shown by the bank');
    if (this.forceConfirmError && a.p_distinct !== true) this.err(this.forceConfirmError);     // "two different transfers" (p_distinct) gets past it, as in the SQL
    // 20261122140000: the reference is optional; when typed it is checked as before
    if (ref && (norm(ref).length < 4 || ref.length > 80)) this.err('The bank transaction reference must have 4 to 80 letters or digits');
    if (!a.p_transfer_at) this.err('The transfer date and time are required');
    if (new Date(String(a.p_transfer_at)).getTime() > Date.parse(this.clockIso) + 10 * 60e3) this.err('The payment time is in the future');         // the same limit and words as Record payment
    if ((note ?? '').length > 500) this.err('The note is too long (500 characters at most)');
    const e = this.ev(a.p_evidence);
    if (e.status !== 'submitted') this.err(`This slip is already ${e.status}`);
    const i = this.inv(e.invoice_id); if (i.status !== 'open') this.err(`The invoice is ${i.status}`);
    if (ref && this.refInUse(ref, e.id)) this.err(`Bank transaction ${ref} was already recorded (reused slip?)`);
    Object.assign(e, { status: 'confirmed', confirmed_by: 'u-me', confirmed_at: this.now(), confirmed_amount: amount, confirmed_bank_ref: ref || null, confirmed_transfer_at: new Date(String(a.p_transfer_at)).toISOString(), confirm_note: note, confirmed_via: 'web' });
    this.log(e, 'evidence.confirm', { amount, claimed: e.claimed_amount, trans_ref: ref });
    return { status: 'confirmed', evidence_id: e.id, amount };
  }
  private post(a: Record<string, unknown>) {
    this.need(this.settings.post_requires_manager ? 'manage' : 'verify', 'post payments');
    const e = this.ev(a.p_evidence); const i = this.inv(e.invoice_id);
    if (e.method === 'cash') this.need('manage', 'post cash payments');         // cash is a manager's, whatever the setting; before the replay answer, like the SQL
    if (e.status === 'verified') { const rc = this.receipts.find((r) => r.evidence_id === e.id); if (rc) return { replay: true, result: 'already_posted', receipt_no: rc.receipt_no, credited_to_wallet: 0, state: this.state(i) }; }
    if (e.status !== 'confirmed') this.err(`NOT_CONFIRMED: this slip is ${e.status} (it must be confirmed before it is posted)`);
    if (i.status !== 'open') this.err(`The invoice is ${i.status}`);
    const add = String(a.p_bank_ref ?? '').trim();                                 // 20261122140000: a reference typed at Post fills in a missing one
    if (e.method === 'transfer' && !e.confirmed_bank_ref && add) e.confirmed_bank_ref = add;
    const amount = e.confirmed_amount ?? 0; const outstanding = r2(i.amount - this.paid(i));
    if (e.method === 'cash' && amount > outstanding) this.err(`CASH_OVERPAY: cash of ${amount} is more than the ${outstanding} this invoice still owes; cash never makes a wallet credit`);
    const credited = Math.max(r2(amount - outstanding), 0);
    const rc: RReceipt = { id: `rc-${++this.n}`, receipt_no: `RC-${String(this.receipts.length + 1).padStart(6, '0')}`, invoice_id: i.id, evidence_id: e.id, amount, bank_trans_ref: e.method === 'cash' ? null : e.confirmed_bank_ref, received_at: e.confirmed_transfer_at ?? this.now(), needs_review: false, status: 'posted', created_at: this.now(), method: e.method === 'cash' ? 'cash' : 'bank_transfer' };
    this.receipts.push(rc);
    Object.assign(e, { status: 'verified', verified_via: 'staff', verified_amount: amount, bank_trans_ref: rc.bank_trans_ref, posted_by: 'u-me', posted_at: this.now(), reviewed_at: this.now(), review_note: String(a.p_note ?? '').trim() || null });
    this.log(e, 'evidence.post', { receipt_no: rc.receipt_no, amount });
    const result = credited > 0 ? 'overpaid_credited' : amount === outstanding ? 'fully_paid' : 'partially_paid';
    return { replay: false, result, receipt_no: rc.receipt_no, credited_to_wallet: credited, state: this.state(i) };
  }
  private reject(a: Record<string, unknown>) {
    this.need('verify', 'reject payments');
    const reason = String(a.p_reason ?? '').trim(); if (!reason) this.err('A reason is required');
    const e = this.ev(a.p_evidence);
    if (!['submitted', 'confirmed', 'more_evidence'].includes(e.status)) this.err(`This slip is already ${e.status}`);
    Object.assign(e, { status: 'rejected', reject_reason: reason, reviewed_by: 'u-me', reviewed_at: this.now() });
    this.log(e, 'evidence.reject', { reason });
    return null;
  }
  private requestMore(a: Record<string, unknown>) {
    this.need('verify', 'ask for more evidence');
    const msg = String(a.p_message ?? '').trim(); if (msg.length < 3 || msg.length > 300) this.err('MESSAGE_REQUIRED: tell the customer what is needed (3 to 300 characters)');
    const e = this.ev(a.p_evidence);
    if (!['submitted', 'confirmed'].includes(e.status)) this.err(`This slip is already ${e.status}`);
    if (e.source === 'staff_entry') this.err('NO_CUSTOMER_SLIP: a payment recorded by staff has no customer slip to ask for');
    Object.assign(e, { status: 'more_evidence', request_message: msg, requested_by: 'u-me', requested_at: this.now() });
    this.log(e, 'evidence.request_more', { message: msg, was: 'submitted' });
    return null;
  }
  private record(a: Record<string, unknown>) {
    this.need('verify', 'record payments');
    const method = String(a.p_method ?? ''); const cash = method === 'cash'; const amount = Number(a.p_amount); const note = String(a.p_note ?? '').trim() || null; const ref = String(a.p_bank_trans_ref ?? '').trim() || null;
    if (!['transfer', 'cash'].includes(method)) this.err('INVALID_METHOD: choose transfer or cash');
    if (a.p_amount == null || !(amount > 0) || r2(amount) !== amount) this.err('INVALID_AMOUNT: enter the amount in baht and satang');
    if (!a.p_received_at) this.err('The payment date and time are required');
    if (new Date(String(a.p_received_at)).getTime() > Date.parse(this.clockIso) + 10 * 60e3) this.err('The payment time is in the future');
    if ((note ?? '').length > 500) this.err('The note is too long (500 characters at most)');
    if (cash) {
      if (!note || note.length < 3) this.err('NOTE_REQUIRED: say where the cash was received (at least 3 characters)');
      if (a.p_file_path != null || a.p_sha256 != null || a.p_file_type != null) this.err('FILE_NOT_ALLOWED: a cash payment has no slip file');
    } else if (!ref || norm(ref).length < 4 || ref.length > 80) this.err('REFERENCE_REQUIRED: enter the bank transaction reference (4 to 80 letters or digits)');
    const i = this.invoices.find((x) => x.id === a.p_invoice); if (!i) this.err('Invoice not found');
    if (i.status !== 'open') this.err(`The invoice is ${i.status}`);
    const st = this.state(i); const limit = r2(st.outstanding - st.confirmed_pending);
    if (amount > limit) this.err(`EXCEEDS_OUTSTANDING: ${amount} is more than the ${Math.max(limit, 0)} that can still be added to this invoice`);
    if (!cash && ref && this.refInUse(ref, null)) this.err(`Bank transaction ${ref} was already recorded (reused slip?)`);
    const id = `ev-${++this.n}`; const when = new Date(String(a.p_received_at)).toISOString();
    this.evidence.push({ id, invoice_id: i.id, customer_id: i.customer_id, file_path: (a.p_file_path as string | null) ?? null, file_type: (a.p_file_type as string | null) ?? null, file_sha256: (a.p_sha256 as string | null) ?? null, claimed_amount: amount, claimed_transfer_at: when,
      claimed_bank: null, claimed_ref: cash ? null : ref, status: 'confirmed', verified_via: null, verified_amount: null, bank_trans_ref: null, reject_reason: null, reviewed_at: null, reviewed_by: null, created_at: this.now(), request_id: null,
      bank_account_id: cash ? null : (a.p_bank_account as string | null) ?? null, transfer_at: null, review_note: null, source: 'staff_entry', method: cash ? 'cash' : 'transfer', recorded_by: 'u-me', confirmed_by: 'u-me', confirmed_at: this.now(), confirmed_amount: amount,
      confirmed_bank_ref: cash ? null : ref, confirmed_transfer_at: when, confirm_note: note, posted_by: null, posted_at: null, request_message: null, requested_by: null, requested_at: null });
    this.log(this.evidence.at(-1)!, 'evidence.record', { invoice: i.id, method, amount, trans_ref: cash ? null : ref, note });
    return { evidence_id: id, status: 'confirmed' };
  }
  /** migration 20261124110000 (the shop's own slip reader): null = a database without it */
  ownReader: boolean | null = null;
  /** migration 20261124120000 (the customer's own switch); undefined = a database without it */
  checkout: boolean | undefined = undefined;
  /** migration 20261128150000 (the receiver names the phone compares with); undefined = a database without it */
  recipients: string[] | undefined = undefined;
  /** migration 20261128150000: the accuracy report, the recipients and the feedback (false = a database without it). The numbers are invented; the real ones are proved in SQL. */
  learning = false;
  feedback: Record<string, unknown>[] = [];
  variants: { id: string; holder: string; variant: string; kind: string; source: string; status: string; note: string | null; created_at: string; created_by: string | null; retired_at: string | null; retire_reason: string | null; impact: Record<string, number> }[] = [];
  private learn(fn: string, a: Record<string, unknown>): unknown {
    const holders = [{ holder: 'ณัฐพร อยู่ยิ้ม', accounts: 2 }, { holder: 'ณัฐพล อยู่ยิ้ม', accounts: 1 }];
    switch (fn) {
      case 'finance_slip_learning': this.need('view', 'see how the slip check performs'); return {
        from: '2026-08-30T00:00:00Z', days: Number(a.p_days ?? 90), rules_version: 'rules-2026-11-28', readings: 14, slips: 12,
        decisions: { verified: 5, review_required: 5, rejected: 2 }, recipient: { match: 7, mismatch: 1, uncertain: 2, unclear: 2 }, unreadable: 2,
        feedback: { correct: 3, wrong: 2, recipient_corrected: 2 },
        outcomes: { verified_posted: 4, verified_rejected: 0, review_posted: 2, review_rejected: 1, rejected_posted: 0, rejected_rejected: 1, open: 4 },
        amount_on_posted: { right: 5, wrong: 0, blank: 1 }, date_on_posted: { right: 6, wrong: 0, blank: 0 },
        calibration: [{ band: '0.90-1.00', n: 4, right: 4, wrong: 0 }, { band: '0.50-0.79', n: 2, right: 1, wrong: 0 }],
        weeks: [{ week: '2026-11-23', n: 9, verified: 4, review_required: 4, rejected: 1 }, { week: '2026-11-16', n: 3, verified: 1, review_required: 1, rejected: 1 }],
        reasons: [{ code: 'RECEIVER_UNCLEAR', n: 2 }],
        corrections: [{ read: 'ณัฐพธ อยู่ยิ้ม', holder: 'ณัฐพร อยู่ยิ้ม', slips: 2, posted: 2, rejected: 0, distance: 0.5, proposed: true },
                      { read: 'ณัฐพล อย่ยม', holder: 'ณัฐพล อยู่ยิ้ม', slips: 1, posted: 0, rejected: 0, distance: 1.5, proposed: false }],
      };
      case 'finance_slip_recipients': this.need('view', 'see the shop\'s recipients'); return { holders, names: [], variants: this.variants };
      case 'finance_slip_feedback_add': { this.need('verify', 'give feedback on a slip reading'); this.feedback.push(a); return { id: `fb-${this.feedback.length}`, correct_decision: a.p_correct_decision ?? null }; }
      case 'finance_slip_variant_impact': this.need('view', 'see the slip readings'); return { readings: 2, evidence: 2, posted: 2, rejected: 0, open: 0, would_change: 2, distance: 0.5 };
      case 'finance_slip_variant_add': {
        this.need('manage', 'approve a recipient spelling');
        const v = { id: `var-${this.variants.length + 1}`, holder: String(a.p_holder), variant: String(a.p_variant), kind: String(a.p_kind), source: String(a.p_source ?? 'manager'), status: 'active', note: null, created_at: this.clockIso, created_by: null, retired_at: null, retire_reason: null, impact: {} };
        this.variants.push(v); return v;
      }
      case 'finance_slip_variant_retire': { this.need('manage', 'retire a recipient spelling'); const v = this.variants.find((x) => x.id === a.p_id); if (!v) this.err('NOT_FOUND: no active spelling with this id'); v!.status = 'retired'; return v; }
    }
    return NOT_HANDLED;
  }
  private readerStatus() { const may = (n: 'verify' | 'manage') => !!this.shop.w.role && RANK[this.shop.w.role as keyof typeof RANK] >= NEED[n]; return { enabled: !!this.ownReader, can_read: may('verify'), can_manage: may('manage'), ...(this.checkout === undefined ? {} : { checkout: this.checkout, before_min: 120, after_min: 10 }), ...(this.recipients === undefined ? {} : { recipients: this.recipients }) }; }
  /** what finance_store_reading answers about the amount only (the real rules are proved in the database) */
  private storeReading(a: Record<string, unknown>) {
    this.need('verify', 'read a payment slip');
    if (!this.ownReader) this.err('READER_OFF: the slip reader is switched off');
    const e = this.ev(a.p_evidence); const x = a.p_extracted as Record<string, unknown>; const inv = this.invoices.find((i) => i.id === e.invoice_id)!;
    const result = x.amount === null ? 'manual_review' : r2(Number(x.amount)) !== r2(inv.amount) ? 'amount_mismatch' : 'match'; const last = this.newest(e);
    this.analyses.push({ id: `an-${e.id}-own-${this.analyses.length}`, evidence_id: e.id, attempt: (last?.attempt ?? 0) + 1, status: 'done', engine: String(a.p_engine), prompt_version: 'own-v1', extracted: x, qr: a.p_qr as Record<string, unknown>, expected: { amount: inv.amount },
      overall_confidence: Number(a.p_confidence), signals: [], result, reasons: result === 'amount_mismatch' ? [{ code: 'AMOUNT_OVER', severity: 'high', field: 'amount', expected: inv.amount, found: x.amount, message: 'x' }] : [], error: null, requested_by: 'me', created_at: new Date().toISOString(), started_at: null, finished_at: new Date().toISOString() });
    return { result, receiver_found: true };
  }
  private requestAnalysis(a: Record<string, unknown>) {
    this.need('verify', 'ask for a new slip analysis');
    if (!this.settings.ai_review_enabled) this.err('AI_DISABLED: the AI review is switched off');
    const e = this.evidence.find((x) => x.id === a.p_evidence); if (!e) this.err('NOT_FOUND: slip not found');
    if (!e.file_path) this.err('NOTHING_TO_DO: this payment has no slip image');
    const last = this.newest(e);
    if (last && ['queued', 'running'].includes(last.status)) this.err('ALREADY_QUEUED: an analysis of this slip is already waiting or running');
    const count = this.analyses.filter((x) => x.evidence_id === e.id).length;
    if (count >= 5) this.err(`TOO_MANY_ATTEMPTS: this slip has already been analysed ${count} times`);
    const id = `an-${e.id}-${count + 1}`;
    this.analyses.push({ id, evidence_id: e.id, attempt: (last?.attempt ?? 0) + 1, status: 'queued', engine: null, prompt_version: null, extracted: null, qr: null, expected: null, overall_confidence: null, signals: [], result: null, reasons: [], error: null, requested_by: 'u-me', created_at: this.now(), started_at: null, finished_at: null });
    return id;
  }

  /** the Edge Function `slip-analyze`: only recorded (what the browser sent). The answer is the function's own word; the reading is a row a test seeds. */
  analyze(body: Record<string, unknown>) { this.analyzeCalls.push(body); return { status: 'completed' }; }
  /** test control: the newest analysis of a slip failed (the reader did not answer) */
  failLatest(evidenceId: string, error = 'AI_TIMEOUT: the reader did not answer in time') {
    const a = this.newest(this.ev(evidenceId)); if (!a) this.err('no analysis'); Object.assign(a, { status: 'failed', error, finished_at: this.now(), result: 'manual_review', reasons: [{ code: 'AI_UNAVAILABLE', severity: 'warn', field: 'analysis', expected: null, found: null, message: `The AI reader did not produce a result: ${error}` }] });
  }
}
