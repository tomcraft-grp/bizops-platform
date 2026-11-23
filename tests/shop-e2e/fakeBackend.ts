// A fake of the Supabase endpoints the customer shop talks to, for browser tests of the UI. It mirrors the contract of
// supabase/migrations/20261115100000_customer_shop.sql (which is tested for real by supabase/tests/customer_shop.sql): the
// server prices everything, an order is idempotent per key, a slip never marks an order paid. Catalogue data is a sample of the
// real catalogue (tests/shop-e2e/catalog.fixture.json). This file proves the SCREENS; it proves nothing about the database.
import type { Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./catalog.fixture.json', import.meta.url), 'utf8')) as unknown[];
import { promptPayPayload } from '../../src/lib/promptpay';
import { FakeWallet, NOT_HANDLED } from './fakeWallet';
import { FakeReview } from './fakeReview';
import { FakeRewards } from './fakeRewards';
import { FakeLine } from './fakeLine';

export const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOST = 'hlvravynjalculvplrxc.supabase.co';
export const IMG = 'https://img.test';

export interface FItem {
  sku_code: string; name: string; name_th: string | null; name_en: string | null; brand: string | null; category: string; unit: string | null; pack_qty: number | null; price: number;
  barcode: string | null; description_th: string | null; description_en: string | null; specs: { label: string; value: string }[]; family: string | null; badge: string | null;
  featured: boolean; available: boolean; max_qty: number | null; image_urls: string[]; sku_seq: number;
}
/** One payment event on an invoice, as the fake keeps it. `staffNote` is what staff wrote in the staff-only columns (review_note, confirm_note): it must never reach a customer's screen. */
export interface FEvidence { id: string; status: 'submitted' | 'confirmed' | 'more_evidence' | 'verified' | 'rejected'; claimed_amount: number; created_at: string; reject_reason?: string | null; reviewed_at?: string; request_message?: string | null; confirmed_amount?: number | null; source?: 'customer_slip' | 'staff_entry'; method?: 'transfer' | 'cash'; staffNote?: string }
interface FInvoice { id: string; invoice_no: string; amount: number; paid: number; cancelled: boolean; evidence: FEvidence[]; req: null | { ref: string; amount: number; qr_payload: string; expires_at: string }; source_ref: string; created_at: string; refunded?: number; /** the customer's receipts (what the payment history lists) */ receipts?: { receipt_no: string; amount: number; received_at: string }[]; /** test control: force a state code the fake cannot derive (6 = overpaid, under review) */ forceCode?: number }
interface FOrder { id: string; order_no: string; status: string; fulfilment: string; contact_name: string; contact_phone: string; delivery_address: string | null; note: string | null; items: { line_no: number; sku_code: string; name: string; unit: string | null; unit_price: number; qty: number; line_total: number; image_url: string | null }[]; subtotal: number; discount: number; shipping_fee: number; total: number; created_at: string; key: string; hash: string; invoice: FInvoice; status_note: string | null; cancel_reason: string | null; payment_pref: string | null }

/** the columns of the payment events table that the slip-review migration added and that a customer reads */
const REVIEW_COLUMNS = ['request_message', 'source', 'method'];
export const settingsDefault = { require_payment_slip: true, shop_open: true, closed_message: null as string | null, delivery_enabled: true, pickup_enabled: true, pickup_note: 'รับที่ร้าน 99 ถนนทดสอบ', shipping_fee: 50, free_shipping_min: 1000 as number | null };

export class FakeShop {
  items: FItem[];
  settings = { ...settingsDefault };
  orders: FOrder[] = [];
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  layout: unknown = null;
  /** false = a database that does not have migration 20261119100000 yet (no "no brand" count, and "__none__" matches nothing) */
  noBrandFilter = true;
  /** wallet, deposits and bank accounts (fakeWallet.ts) */
  w = new FakeWallet(this);
  /** the slip-review dashboard (fakeReview.ts): slips, analyses, confirm / post / reject / request more / record payment */
  rv = new FakeReview(this);
  /** points, per-bill board picks and the event boards (fakeRewards.ts) */
  rw = new FakeRewards(this);
  /** the LINE notifications settings (fakeLine.ts) */
  ln = new FakeLine(this);
  private fail = new Map<string, number>();
  private drop = new Set<string>();
  private seq = 0;
  profile = { id: USER_ID, email: 'customer@example.test', display_name: 'สมชาย ใจดี', role: 'USER', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', phone: '0812345678', line_user_id: null as string | null, pdpa_consent_at: '2026-01-01T00:00:00Z' };

  constructor() {
    this.items = (fixture as Omit<FItem, 'description_th' | 'description_en' | 'specs' | 'family' | 'badge' | 'featured' | 'available' | 'max_qty' | 'image_urls'>[]).map((x) => ({
      ...x, description_th: null, description_en: null, specs: [], family: null, badge: null, featured: false, available: true, max_qty: null, image_urls: [],
    }));
  }
  item = (sku: string) => this.items.find((i) => i.sku_code === sku)!;
  /** the same enrichment staff do in the back office: pictures, description, options, featured, sold out, limits */
  decorate() {
    const a = this.item('FG-000001'); Object.assign(a, { image_urls: [`${IMG}/FG-000001-a.svg`, `${IMG}/FG-000001-b.svg`], description_th: 'รสผลไม้รวม หอมหวาน', description_en: 'Mixed fruit', specs: [{ label: 'ขนาด', value: '6000 คำ' }, { label: 'แบตเตอรี่', value: 'ชาร์จได้' }], family: 'INFY 6000', badge: 'ขายดี', featured: true });
    Object.assign(this.item('FG-000002'), { image_urls: [`${IMG}/FG-000002-a.svg`], family: 'INFY 6000', featured: true });
    Object.assign(this.item('FG-000003'), { max_qty: 2, featured: true });
    Object.assign(this.item('FG-000004'), { available: false });
  }
  /** every Edge Function the browser called: its name and the body it sent (the slip reader, `slip-analyze`, is only recorded here, never run) */
  invokes: { name: string; body: Record<string, unknown> }[] = [];
  /** how the fake Edge Function answers: normally, with a server error, or never (until `openGate()`): the order flow must not wait for it */
  invokeMode: 'ok' | 'fail' | 'hang' = 'ok';
  openGate: () => void = () => undefined;
  private gate = new Promise<void>((resolve) => { this.openGate = resolve; });
  /** every direct table read the browser made (the table and the columns it asked for), so a test can see what a customer screen reads */
  restReads: { table: string; select: string | null }[] = [];
  /** true = a database WITHOUT the slip-review migration: the payment events table has no request_message / source / method column (selecting one is an error, like PostgREST) */
  noReviewColumns = false;
  /** true = every read of the payment events fails with a server error that has nothing to do with columns */
  failEvidenceReads = false;
  /** true = shop_place_order answers without the invoice object: the app must not depend on it once the order exists */
  placeWithoutInvoice = false;
  /** what finance_my_slip_check answers, one after another (the last one stays) */
  slipCheck: Record<string, unknown>[] = [];
  /** true = a database WITHOUT the slip check migration */
  noSlipCheck = false;
  /** the name a manager wrote for the QR account (null = not written yet) */
  merchantName: string | null = 'TEST SHOP';
  /** the shop's payment accounts (staff screen) */
  paymentAccounts: Record<string, unknown>[] = [];
  /** every file the browser put into storage: bucket/path, its type and size */
  uploads: { path: string; type: string | null; size: number; upsert: string | null }[] = [];
  /** true = a database WITHOUT the checkout QR migration */
  noCheckoutQr = false;
  /** true = the answer to shop_checkout_qr waits until `releaseCheckoutQr()` */
  holdCheckoutQr = false;
  releaseCheckoutQr: () => void = () => undefined;
  private qrGate = new Promise<void>((resolve) => { this.releaseCheckoutQr = resolve; });
  failNext(fn: string, times = 1) { this.fail.set(fn, times); }
  /** the server handles the call, but the answer never reaches the phone (dropped connection) */
  dropResponseOnce(fn: string) { this.drop.add(fn); }
  count = (fn: string) => this.calls.filter((c) => c.fn === fn).length;

  // ------------------------------------------------------------ server logic (mirrors the SQL)
  private err(message: string, details?: string): never { throw Object.assign(new Error(message), { details }); }
  private state(inv: FInvoice) {
    // like finance_invoice_state_raw after the slip-review migration: a slip the shop CONFIRMED but has not posted still counts as pending, and the newest "more evidence" request is state 10
    const pending = inv.evidence.filter((e) => e.status === 'submitted' || e.status === 'confirmed').length;
    const last = inv.evidence[0];
    const reqLive = inv.req && new Date(inv.req.expires_at).getTime() > Date.now();
    const code = inv.forceCode ?? (inv.cancelled ? 8 : inv.paid >= inv.amount ? 5 : pending > 0 ? 3 : last?.status === 'more_evidence' ? 10 : inv.paid > 0 ? 4 : last?.status === 'rejected' && !reqLive ? 7 : reqLive ? 1 : inv.req ? 9 : 0);
    const names = ['unpaid', 'awaiting_payment', 'payment_submitted', 'pending_verification', 'partially_paid', 'fully_paid', 'overpaid', 'rejected', 'cancelled', 'expired', 'more_evidence'];
    const confirmedPending = Math.round(inv.evidence.filter((e) => e.status === 'confirmed').reduce((s, e) => s + (e.confirmed_amount ?? 0), 0) * 100) / 100;
    return { invoice_id: inv.id, amount: inv.amount, paid: inv.paid, outstanding: Math.max(inv.amount - inv.paid, 0), unapplied: 0, refunded: inv.refunded ?? 0, status_code: code, status: names[code], pending_evidence: pending,
      request: inv.req && !inv.cancelled ? { ...inv.req, expired: !reqLive } : null, confirmed_pending: confirmedPending, more_evidence_message: last?.status === 'more_evidence' ? last.request_message ?? null : null };
  }
  private invoiceRow(inv: FInvoice) { return { id: inv.id, invoice_no: inv.invoice_no, issue_date: inv.created_at.slice(0, 10), due_date: inv.created_at.slice(0, 10), description: `Online order ${inv.source_ref}`, customer_name: this.profile.display_name, source_ref: inv.source_ref, ...this.state(inv) }; }
  /** one finance_payment_evidence row with EVERY column of the table (the staff-only ones too: PostgREST only returns the ones the browser asks for) */
  private evidenceRow(e: FEvidence, invoiceId: string): Record<string, unknown> {
    return {
      id: e.id, invoice_id: invoiceId, customer_id: 'cust-secret', request_id: null, file_path: 'u/secret/slip.png', file_sha256: 'f'.repeat(64), file_type: 'image/jpeg', claimed_amount: e.claimed_amount, claimed_transfer_at: null,
      claimed_bank: null, claimed_ref: null, status: e.status, verified_via: null, verified_amount: null, bank_trans_ref: null, transfer_at: null, sender_name: null, receiver_account: null, bank_account_id: null,
      review_note: e.staffNote ?? null, reject_reason: e.reject_reason ?? null, reviewed_by: 'staff-secret', reviewed_at: e.reviewed_at ?? null, created_by: 'cust-secret', created_at: e.created_at,
      source: e.source ?? 'customer_slip', method: e.method ?? 'transfer', recorded_by: null, confirmed_by: e.status === 'confirmed' ? 'staff-secret' : null, confirmed_at: null, confirmed_amount: e.confirmed_amount ?? null,
      confirmed_bank_ref: e.status === 'confirmed' ? 'BANKREF-SECRET' : null, confirmed_transfer_at: null, confirm_note: e.staffNote ?? null, posted_by: null, posted_at: null, request_message: e.request_message ?? null, requested_by: null, requested_at: null,
    };
  }
  private orderJson(o: FOrder) {
    const { key: _k, hash: _h, invoice, ...rest } = o; void _k; void _h;
    return { ...rest, channel: 'LINE', updated_at: o.created_at, cancelled_at: null, invoice: this.invoiceRow(invoice) };
  }
  private quote(items: unknown, fulfilment: string) {
    if (!Array.isArray(items) || !items.length) this.err('CART_EMPTY');
    if (items.length > 40) this.err('CART_TOO_LARGE');
    const merged = new Map<string, number>();
    for (const e of items as { sku_code?: string; qty?: unknown }[]) { const q = typeof e.qty === 'number' && Number.isInteger(e.qty) && e.qty >= 0 ? e.qty : 0; merged.set(e.sku_code ?? '', (merged.get(e.sku_code ?? '') ?? 0) + q); }
    const lines: Record<string, unknown>[] = []; const problems: Record<string, unknown>[] = []; let subtotal = 0;
    for (const [sku, qty] of [...merged].sort((a, b) => a[0].localeCompare(b[0]))) {
      const v = this.items.find((i) => i.sku_code === sku);
      const bad = (problem: string, extra: Record<string, unknown> = {}) => { lines.push({ sku_code: sku, qty, ok: false, problem, name: v?.name, unit_price: v?.price, image_url: v?.image_urls[0] ?? null, ...extra }); problems.push({ sku_code: sku, problem, ...extra }); };
      if (qty < 1 || qty > 99) bad('bad_qty'); else if (!v) bad('not_found'); else if (!v.available) bad('sold_out'); else if (v.max_qty && qty > v.max_qty) bad('over_limit', { max_qty: v.max_qty });
      else { subtotal += v.price * qty; lines.push({ sku_code: sku, qty, ok: true, name: v.name, unit: v.unit, pack_qty: v.pack_qty, unit_price: v.price, line_total: v.price * qty, max_qty: v.max_qty, image_url: v.image_urls[0] ?? null }); }
    }
    let ship = 0;
    if (fulfilment === 'delivery') { if (!this.settings.delivery_enabled) problems.push({ problem: 'delivery_off' }); ship = this.settings.free_shipping_min != null && subtotal >= this.settings.free_shipping_min ? 0 : this.settings.shipping_fee; }
    else if (fulfilment === 'pickup') { if (!this.settings.pickup_enabled) problems.push({ problem: 'pickup_off' }); } else problems.push({ problem: 'bad_fulfilment' });
    return { lines, subtotal, discount: 0, shipping_fee: ship, total: subtotal + ship, fulfilment, free_shipping_min: this.settings.free_shipping_min, ok: problems.length === 0 && subtotal > 0, problems };
  }
  private itemJson(i: FItem) { const { sku_seq: _s, ...r } = i; void _s; return { ...r, image_url: i.image_urls[0] ?? null }; }
  invoiceState(inv: FInvoice) { return this.state(inv); }
  private payOf(o: FOrder) { return this.state(o.invoice).status_code; }

  rpc(fn: string, a: Record<string, unknown>, viaHttp = false): unknown {
    switch (fn) {
      case 'get_published_customer_layout': return this.layout;
      case 'customer_app_query': return { columns: [{ key: 'sku_code', label: 'SKU', type: 'text' }, { key: 'name_full', label: 'Name', type: 'text' }, { key: 'price', label: 'Price', type: 'money' }], rows: this.items.slice(0, 3).map((i) => ({ sku_code: i.sku_code, name_full: i.name, price: i.price })) };
      case 'shop_settings_public': return { ...this.settings, shop_open: this.settings.shop_open };
      case 'shop_facets': {
        const cats = new Map<string, FItem[]>(); for (const i of this.items) cats.set(i.category, [...(cats.get(i.category) ?? []), i]);
        const brands = new Map<string, number>(); for (const i of this.items) if (i.brand) brands.set(i.brand, (brands.get(i.brand) ?? 0) + 1);
        return { categories: [...cats].map(([code, xs]) => ({ code, name_th: code === 'Puff' ? 'พอตใช้แล้วทิ้ง' : null, name_en: null, count: xs.length, image_url: xs.find((x) => x.image_urls[0])?.image_urls[0] ?? null })),
          brands: [...brands].map(([brand, count]) => ({ brand, count })).sort((x, y) => y.count - x.count),
          // migration 20261119100000 (the "no brand" filter); an older database leaves the key out
          ...(this.noBrandFilter ? { no_brand_count: this.items.filter((i) => !i.brand).length } : {}) };
      }
      case 'shop_catalog': {
        const q = String(a.p_search ?? '').trim().toLowerCase();
        let xs = this.items.filter((i) => (!q || [i.sku_code, i.name, i.name_th, i.name_en, i.brand].some((f) => f?.toLowerCase().includes(q))) && (!a.p_category || i.category === a.p_category) && (!a.p_brand || (this.noBrandFilter && a.p_brand === '__none__' ? !i.brand : i.brand === a.p_brand)) && (!a.p_featured || i.featured));
        const sort = String(a.p_sort ?? 'recommended');
        xs = [...xs].sort((p, r) => sort === 'price_asc' ? p.price - r.price : sort === 'price_desc' ? r.price - p.price : sort === 'newest' ? r.sku_seq - p.sku_seq : sort === 'name' ? p.name.localeCompare(r.name)
          : (Number(r.featured) - Number(p.featured)) || (Number(r.available) - Number(p.available)) || (p.sku_seq - r.sku_seq));
        const off = Number(a.p_offset ?? 0), lim = Math.min(Number(a.p_limit ?? 24), 60);
        return { total: xs.length, items: xs.slice(off, off + lim).map((i) => this.itemJson(i)) };
      }
      case 'shop_product': {
        const v = this.items.find((i) => i.sku_code === a.p_sku); if (!v) return null;
        return { ...this.itemJson(v), siblings: v.family ? this.items.filter((i) => i.family === v.family && i !== v).map((i) => this.itemJson(i)) : [], related: this.items.filter((i) => i.category === v.category && i !== v).slice(0, 6).map((i) => this.itemJson(i)) };
      }
      case 'shop_home': {
        const sold = new Map<string, number>(); for (const o of this.orders) if (o.status !== 'cancelled') for (const l of o.items) sold.set(l.sku_code, (sold.get(l.sku_code) ?? 0) + l.qty);
        return { featured: this.items.filter((i) => i.featured).slice(0, 8).map((i) => this.itemJson(i)), newest: [...this.items].sort((x, y) => y.sku_seq - x.sku_seq).slice(0, 8).map((i) => this.itemJson(i)),
          popular: [...sold].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([s]) => this.itemJson(this.item(s))) };
      }
      case 'shop_quote': return this.quote(a.p_items, String(a.p_fulfilment));
      case 'shop_checkout_qr': {       // migration 20261123100000: the same pricing as the order, the shop's own account, nothing written
        if (this.noCheckoutQr) this.err('Could not find the function public.shop_checkout_qr(p_fulfilment, p_items) in the schema cache');
        if (!this.settings.shop_open) this.err('SHOP_CLOSED');
        const q = this.quote(a.p_items, String(a.p_fulfilment)); if (!q.ok) this.err('CART_INVALID', JSON.stringify(q.problems));
        if (!this.w.promptpay) this.err('NO_PAYMENT_ACCOUNT');
        return { amount: q.total, qr_payload: promptPayPayload('0812345678', q.total), account_label: 'Test shop', merchant_name: this.merchantName };
      }
      case 'shop_place_order': {
        const r = this.place(a, viaHttp);
        if (!(viaHttp && this.placeWithoutInvoice)) return r;
        const { invoice: _gone, ...order } = r.order as Record<string, unknown>; void _gone;     // an answer without the invoice object
        return { ...r, order };
      }
      case 'shop_my_orders': {
        const f = String(a.p_filter ?? 'all');
        const mine = this.orders.filter((o) => { const p = this.payOf(o); return f === 'unpaid' ? o.status !== 'cancelled' && [0, 1, 3, 4, 7, 9, 10].includes(p) : f === 'to_ship' ? ['new', 'confirmed', 'preparing', 'packed'].includes(o.status) && [5, 6].includes(p) : f === 'to_receive' ? ['shipped', 'ready'].includes(o.status) : f === 'done' ? o.status === 'completed' : f === 'cancelled' ? ['cancelled', 'returned'].includes(o.status) : true; })
          .sort((x, y) => y.created_at.localeCompare(x.created_at));
        const off = Number(a.p_offset ?? 0), lim = Number(a.p_limit ?? 20);
        return { total: mine.length, orders: mine.slice(off, off + lim).map((o) => this.orderJson(o)) };
      }
      case 'shop_my_order': { const o = this.orders.find((x) => x.id === a.p_id); if (!o) this.err('Order not found'); return { ...this.orderJson(o), events: [] }; }
      case 'shop_cancel_my_order': {
        const o = this.orders.find((x) => x.id === a.p_id); if (!o) this.err('Order not found');
        if (o.status !== 'new') this.err('ORDER_IN_PROGRESS'); if (o.invoice.paid > 0) this.err('PAYMENT_RECORDED'); if (o.invoice.evidence.some((e) => e.status === 'submitted' || e.status === 'confirmed' || e.status === 'more_evidence')) this.err('SLIP_PENDING');   // like shop_cancel_order_internal: a slip the shop confirmed (not yet posted) or asked more evidence for also blocks it
        o.status = 'cancelled'; o.invoice.cancelled = true; o.cancel_reason = String(a.p_reason ?? 'Cancelled by customer'); return this.orderJson(o);
      }
      case 'finance_my_invoices': return this.orders.map((o) => this.invoiceRow(o.invoice));
      case 'finance_request_payment': {
        const o = this.orders.find((x) => x.invoice.id === a.p_invoice); if (!o) this.err('Invoice not found');
        const amt = o.invoice.amount - o.invoice.paid;
        o.invoice.req = { ref: 'PR' + (1000 + ++this.seq), amount: amt, qr_payload: promptPayPayload('0812345678', amt), expires_at: new Date(Date.now() + 24 * 3600e3).toISOString() };
        return { ...o.invoice.req, account_label: 'Test shop', merchant_name: this.merchantName };
      }
      case 'finance_my_slip_check': {       // migration 20261124100000: the customer's own newest slip; nothing while the reader is off
        if (this.noSlipCheck) this.err('Could not find the function public.finance_my_slip_check(p_invoice) in the schema cache');
        const o = this.orders.find((x) => x.invoice.id === a.p_invoice); if (!o) this.err('Invoice not found');
        const seq = this.slipCheck; return seq.length > 1 ? seq.shift() : seq[0] ?? { state: 'none' };
      }
      case 'finance_set_payment_account_name': {
        if (this.w.role !== 'manager') this.err('You are not allowed to change the shop payment account');
        const acc = this.paymentAccounts.find((x) => x.id === a.p_account); if (!acc) this.err('Account not found');
        if (String(a.p_name ?? '').trim().replace(/^(นาย|นางสาว|นาง|คุณ)s*/, '').length < 3) this.err('INVALID_NAME');
        Object.assign(acc, { merchant_name: String(a.p_name).trim(), slip_name_alt: a.p_name_alt ?? null }); return acc;
      }
      case 'finance_submit_evidence': {
        const o = this.orders.find((x) => x.invoice.id === a.p_invoice); if (!o) this.err('Invoice not found');
        // the trigger finance_evidence_supersede_old: a customer's new slip closes the older "more evidence" slips of the same invoice (rejected, with this reason)
        for (const e of o.invoice.evidence) if (e.status === 'more_evidence') Object.assign(e, { status: 'rejected', reject_reason: 'Replaced by a newer slip', reviewed_at: new Date().toISOString() });
        const id = 'ev-' + ++this.seq; o.invoice.evidence.unshift({ id, status: 'submitted', claimed_amount: Number(a.p_claimed_amount), created_at: new Date().toISOString() }); this.w.noteSlip(id, (a.p_bank_account as string | null) ?? null); return id;
      }
      case 'finance_role': return this.w.role;
      case 'finance_staff': return null;
      default: { const r = this.w.rpc(fn, a); if (r !== NOT_HANDLED) return r; const x = this.rw.rpc(fn, a); if (x !== NOT_HANDLED) return x; const ln = this.ln.rpc(fn, a); if (ln !== NOT_HANDLED) return ln; const v = this.rv.rpc(fn, a); return v === NOT_HANDLED ? this.admin(fn, a) : v; }
    }
  }

  // ------------------------------------------------------------ staff functions (same rules as public.shop_admin_*)
  hidden = new Set<string>();
  categories = new Map<string, { name_th: string | null; name_en: string | null; sort_order: number; visible: boolean }>();
  paymentAccountReady = false;
  private staff() { if (!['ADMIN', 'SUPER_ADMIN'].includes(this.profile.role)) this.err('You are not allowed to see online orders'); }
  private adminOrder(o: FOrder) {
    return { ...this.orderJson(o), customer: { code: 'LINE-TEST', name: this.profile.display_name, phone: this.profile.phone, line_user_id: null },
      events: [{ at: o.created_at, actor_email: this.profile.email, action: 'order.place', detail: {} }, ...(this.statusLog.get(o.id) ?? [])] };
  }
  statusLog = new Map<string, { at: string; actor_email: string; action: string; detail: Record<string, unknown> }[]>();
  private admin(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'shop_admin_orders': {
        this.staff();
        const q = String(a.p_search ?? '').toLowerCase();
        const xs = this.orders.filter((o) => (!a.p_status || o.status === a.p_status) && (!q || [o.order_no, o.contact_name, o.contact_phone].some((f) => f.toLowerCase().includes(q)))).sort((x, y) => y.created_at.localeCompare(x.created_at));
        const counts: Record<string, number> = {}; for (const o of this.orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
        return { total: xs.length, counts, orders: xs.map((o) => this.adminOrder(o)) };
      }
      case 'shop_admin_order': { this.staff(); const o = this.orders.find((x) => x.id === a.p_id); if (!o) this.err('Order not found'); return this.adminOrder(o); }
      case 'shop_admin_set_status': {
        this.staff();
        const o = this.orders.find((x) => x.id === a.p_order); if (!o) this.err('Order not found');
        const to = String(a.p_status); const note = String(a.p_note ?? '').trim() || null; const why = String(a.p_override_reason ?? '').trim() || null;
        const log = (detail: Record<string, unknown>) => this.statusLog.set(o.id, [...(this.statusLog.get(o.id) ?? []), { at: new Date().toISOString(), actor_email: this.profile.email, action: 'order.status', detail }]);
        if (to === 'cancelled') { if (!note) this.err('A reason is required'); if (o.invoice.paid > 0) this.err('PAYMENT_RECORDED'); o.status = 'cancelled'; o.invoice.cancelled = true; o.cancel_reason = note; log({ to }); return this.orderJson(o); }
        const ok: Record<string, string[]> = { new: ['confirmed'], confirmed: ['preparing'], preparing: ['packed'], packed: [o.fulfilment === 'pickup' ? 'ready' : 'shipped'], ready: ['completed'], shipped: ['completed', 'returned'], completed: ['returned'] };
        if (!(ok[o.status] ?? []).includes(to)) this.err(`An order that is ${o.status} cannot become ${to}`);
        if (to !== 'confirmed' && to !== 'returned' && ![5, 6].includes(this.payOf(o))) { if (!why) this.err('PAYMENT_REQUIRED'); }
        o.status = to; if (note) o.status_note = note; log({ to, note, payment_override: !!why && ![5, 6].includes(this.payOf(o)), override_reason: why });
        return this.orderJson(o);
      }
      case 'shop_admin_settings': return this.adminSettings();
      case 'shop_admin_save_settings': { this.staff(); Object.assign(this.settings, a.p_patch as object); return this.adminSettings(); }
      case 'shop_admin_categories': {
        this.staff(); const cats = new Map<string, number>(); for (const i of this.items) cats.set(i.category, (cats.get(i.category) ?? 0) + 1);
        return [...cats].map(([code, count]) => ({ code, count, name_th: null, name_en: null, image_path: null, image_url: null, sort_order: 100, visible: true, ...(this.categories.get(code) ?? {}) }));
      }
      case 'shop_admin_save_category': { this.staff(); this.categories.set(String(a.p_code), { name_th: null, name_en: null, sort_order: 100, visible: true, ...(this.categories.get(String(a.p_code)) ?? {}), ...(a.p_patch as object) }); return null; }
      case 'shop_admin_products': {
        this.staff(); const q = String(a.p_search ?? '').toLowerCase();
        const rows = this.items.filter((i) => !q || [i.sku_code, i.name, i.brand ?? ''].some((f) => f.toLowerCase().includes(q))).map((i) => ({
          sku_code: i.sku_code, name: i.name, brand: i.brand, status: 'active', category: i.category, price: i.price, description_th: i.description_th, description_en: i.description_en, image_paths: [], image_urls: i.image_urls,
          specs: i.specs, family: i.family, badge: i.badge, featured: i.featured, visible: !this.hidden.has(i.sku_code), available: i.available, max_qty: i.max_qty, sort_order: 100,
          on_sale: !this.hidden.has(i.sku_code), why_hidden: this.hidden.has(i.sku_code) ? 'hidden_by_staff' : null }));
        const f = String(a.p_filter ?? 'all'); const xs = rows.filter((r) => (f === 'visible' ? r.on_sale : f === 'hidden' ? !r.on_sale : f === 'no_image' ? r.on_sale && !r.image_urls.length : true));
        return { total: xs.length, items: xs.slice(0, Number(a.p_limit ?? 40)) };
      }
      case 'shop_admin_save_content': {
        this.staff(); const it = this.item(String(a.p_sku)); const p = a.p_patch as Record<string, unknown>;
        if (!it) this.err('Unknown product');
        for (const k of ['description_th', 'description_en', 'family', 'badge', 'featured', 'available', 'specs'] as const) if (k in p) (it as unknown as Record<string, unknown>)[k] = p[k] === '' ? null : p[k];
        if ('max_qty' in p) it.max_qty = p.max_qty === '' ? null : Number(p.max_qty);
        if ('visible' in p) { if (p.visible) this.hidden.delete(it.sku_code); else this.hidden.add(it.sku_code); }
        return null;
      }
      default: this.err(`Unknown function ${fn}`);
    }
  }
  private adminSettings() {
    this.staff();
    return { ...this.settings, image_base_url: 'https://x.test/', updated_at: new Date().toISOString(), payment_account_ready: this.paymentAccountReady, visible_products: this.items.length - this.hidden.size, products_with_image: this.items.filter((i) => i.image_urls.length).length };
  }
  slipHashes = new Set<string>();
  private place(a: Record<string, unknown>, viaHttp = false) {
    const key = String(a.p_key ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) this.err('INVALID_KEY');
    const norm = JSON.stringify({ i: (a.p_items as { sku_code: string; qty: number }[]).map((x) => [x.sku_code, x.qty]).sort(), f: a.p_fulfilment, n: String(a.p_name).trim(), p: String(a.p_phone).replace(/\D/g, ''), a: a.p_address ? String(a.p_address).trim() : null, note: a.p_note, ...(a.p_payment_method ? { pm: a.p_payment_method } : {}), ...(a.p_slip_sha256 ? { slip: a.p_slip_sha256 } : {}) });
    const have = this.orders.find((o) => o.key === key);
    if (have) { if (have.hash !== norm) this.err('KEY_REUSED'); return { replay: true, order: this.orderJson(have) }; }
    if (!this.settings.shop_open) this.err('SHOP_CLOSED');
    const pm = a.p_payment_method ? String(a.p_payment_method) : null;     // 'wallet' | 'qr' | 'bank:<CODE>': validated like the database does
    if (pm && !(pm === 'wallet' || (pm === 'qr' && this.w.promptpay) || (pm.startsWith('bank:') && this.w.banks.some((b) => b.active && b.code === pm.slice(5))))) this.err('INVALID_PAYMENT_METHOD');
    // the transfer slip comes with the order (only an order paid from the wallet needs none)
    if (viaHttp && this.settings.require_payment_slip && pm !== 'wallet' && (!a.p_slip_path || !a.p_slip_sha256)) this.err('SLIP_REQUIRED');
    const phone = String(a.p_phone).replace(/\D/g, '');
    if (!String(a.p_name).trim()) this.err('INVALID_NAME'); if (!/^0\d{8,9}$/.test(phone)) this.err('INVALID_PHONE');
    if (String(a.p_address ?? '').trim().length > 400) this.err('INVALID_ADDRESS');                   // optional, but not unbounded
    const q = this.quote(a.p_items, String(a.p_fulfilment)) as unknown as { ok: boolean; problems: unknown[]; total: number; subtotal: number; shipping_fee: number; lines: { ok: boolean; sku_code: string; name: string; unit: string | null; unit_price: number; qty: number; line_total: number; image_url: string | null }[] };
    if (!q.ok) this.err('CART_INVALID', JSON.stringify(q.problems));
    if (a.p_expected_total != null && Number(a.p_expected_total) !== q.total) this.err('PRICE_CHANGED', String(q.total));
    const n = this.orders.length + 1; const no = `ORD-${String(n).padStart(6, '0')}`; const now = new Date(Date.now() + n * 1000).toISOString();
    const inv: FInvoice = { id: `inv-${n}`, invoice_no: `INV-${String(n).padStart(6, '0')}`, amount: q.total, paid: 0, cancelled: false, evidence: [], req: null, source_ref: no, created_at: now };
    const o: FOrder = { id: `ord-${n}`, order_no: no, status: 'new', fulfilment: String(a.p_fulfilment), contact_name: String(a.p_name).trim(), contact_phone: phone, delivery_address: a.p_fulfilment === 'delivery' ? (String(a.p_address ?? '').trim() || null) : null,
      note: (a.p_note as string | null) ?? null, items: q.lines.map((l, i) => ({ line_no: i + 1, sku_code: l.sku_code, name: l.name, unit: l.unit, unit_price: l.unit_price, qty: l.qty, line_total: l.line_total, image_url: l.image_url })),
      subtotal: q.subtotal, discount: 0, shipping_fee: q.shipping_fee, total: q.total, created_at: now, key, hash: norm, invoice: inv, status_note: null, cancel_reason: null, payment_pref: pm };
    if (a.p_slip_path) {       // checked like finance_submit_evidence; any refusal creates nothing
      const path = String(a.p_slip_path); const sha = String(a.p_slip_sha256).toLowerCase();
      if (!path.startsWith(USER_ID + '/') || path.includes('..')) this.err('Invalid file');
      if (this.slipHashes.has(sha)) this.err('This slip was already submitted');
      this.slipHashes.add(sha);
      const id = 'ev-' + ++this.seq; inv.evidence.unshift({ id, status: 'submitted', claimed_amount: q.total, created_at: new Date().toISOString() });
      this.w.noteSlip(id, pm?.startsWith('bank:') ? (this.w.banks.find((b) => b.code === pm.slice(5))?.id ?? null) : null);
    }
    this.orders.push(o);
    return { replay: false, order: this.orderJson(o) };
  }
  // test controls: what staff do in the back office
  private order(orderNo: string) { return this.orders.find((x) => x.order_no === orderNo)!; }
  /** an order created straight in the fake (no screen involved): FG-000001 for pick-up (฿320, or `total` when given), unpaid, no slip. Returns the order. */
  seedOrder(total?: number): FOrder {
    this.rpc('shop_place_order', { p_key: `seed-${this.orders.length + 1}-${Math.random().toString(36).slice(2, 10)}`, p_items: [{ sku_code: 'FG-000001', qty: 1 }], p_fulfilment: 'pickup', p_name: 'สมชาย ใจดี', p_phone: '0812345678', p_address: null, p_note: null });
    const o = this.orders[this.orders.length - 1];
    if (total != null) { o.total = total; o.invoice.amount = total; }
    return o;
  }
  /** a payment event the customer or staff created (newest first, like the real list). `staffNote` is staff-only text that must stay off every customer screen. */
  addEvidence(orderNo: string, status: FEvidence['status'], extra: Partial<FEvidence> = {}): FEvidence {
    const o = this.order(orderNo); const n = ++this.seq;
    const e: FEvidence = { id: `ev-${n}`, status, claimed_amount: Math.max(o.invoice.amount - o.invoice.paid, 1), created_at: new Date(Date.now() + n * 1000).toISOString(), ...extra };
    o.invoice.evidence.unshift(e); return e;
  }
  /** staff posted a payment of this amount (partly or fully) */
  setPaid(orderNo: string, amount: number) { this.order(orderNo).invoice.paid = amount; }
  /** a receipt the customer can see in the payment history (it does not change the paid amount: use setPaid for that) */
  addReceipt(orderNo: string, receiptNo: string, amount: number) { const o = this.order(orderNo); (o.invoice.receipts ??= []).push({ receipt_no: receiptNo, amount, received_at: new Date().toISOString() }); }
  /** a payment QR that is still valid (state 1) or has expired (state 9) */
  giveQr(orderNo: string, live = true) {
    const o = this.order(orderNo);
    o.invoice.req = { ref: 'PR' + (1000 + ++this.seq), amount: o.invoice.amount - o.invoice.paid, qr_payload: promptPayPayload('0812345678', o.invoice.amount), expires_at: new Date(Date.now() + (live ? 24 : -24) * 3600e3).toISOString() };
  }
  /** staff asked for more evidence: the open slip becomes `more_evidence` with the message they wrote (invoice state 10) */
  requestMoreEvidence(orderNo: string, message: string) {
    const o = this.order(orderNo);
    for (const e of o.invoice.evidence) if (e.status === 'submitted' || e.status === 'confirmed') { e.status = 'more_evidence'; e.request_message = message; }
  }
  /** the shop CONFIRMED the amount the bank shows but has not posted it yet (the money is not received yet) */
  confirmSlip(orderNo: string, amount: number) {
    for (const e of this.order(orderNo).invoice.evidence) if (e.status === 'submitted') { e.status = 'confirmed'; e.confirmed_amount = amount; }
  }
  /** force a state code the fake cannot derive from the data */
  forceCode(orderNo: string, code: number) { this.order(orderNo).invoice.forceCode = code; }
  verifyPayment(orderNo: string) { const o = this.orders.find((x) => x.order_no === orderNo)!; o.invoice.paid = o.invoice.amount; o.invoice.evidence.forEach((e) => { e.status = 'verified'; }); }
  /** staff reversed a payment and refunded it into the customer's wallet */
  refund(orderNo: string, amount: number) { const o = this.orders.find((x) => x.order_no === orderNo)!; o.invoice.refunded = (o.invoice.refunded ?? 0) + amount; }
  rejectSlip(orderNo: string, reason: string) { const o = this.orders.find((x) => x.order_no === orderNo)!; o.invoice.evidence.forEach((e) => { e.status = 'rejected'; e.reject_reason = reason; e.reviewed_at = new Date().toISOString(); }); o.invoice.req = null; }
  setStatus(orderNo: string, status: string, note?: string) { const o = this.orders.find((x) => x.order_no === orderNo)!; o.status = status; if (note) o.status_note = note; }

  // ------------------------------------------------------------ wiring
  async install(page: Page) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    await page.route(`${IMG}/**`, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: cors, body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#cfd8e3"/><circle cx="200" cy="200" r="90" fill="#7a8da6"/></svg>' }));
    await page.route(`https://${HOST}/**`, async (route) => {
      const req = route.request(); const url = new URL(req.url()); const p = url.pathname;
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (p === '/auth/v1/user') return json(route, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: this.profile.email, user_metadata: {}, app_metadata: {} });
      if (p.startsWith('/auth/v1/')) return json(route, {});
      if (p === '/rest/v1/profiles') return json(route, this.profile);
      if (p.startsWith('/functions/v1/')) {                                           // an Edge Function: only recorded (name + body), it is never run here
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(req.postData() || '{}') as Record<string, unknown>; } catch { /* no body */ }
        const name = p.slice('/functions/v1/'.length);
        this.invokes.push({ name, body });
        if (name === 'line-dispatch') return json(route, this.ln.test());
        if (name !== 'slip-analyze') return json(route, { error: `Unknown function ${name}` }, 404);
        const answer = this.rv.analyze(body);                                          // the staff dashboard specs read this record too
        if (this.invokeMode === 'hang') await this.gate;                               // never answers (until the test opens the gate)
        try { return await (this.invokeMode === 'fail' ? json(route, { error: 'the reader is down' }, 500) : json(route, answer)); } catch { return; }   // the page may be gone by now
      }
      if (p.startsWith('/rest/v1/rpc/')) {
        const fn = p.slice('/rest/v1/rpc/'.length);
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(req.postData() || '{}') as Record<string, unknown>; } catch { /* no body */ }
        this.calls.push({ fn, args });
        const left = this.fail.get(fn) ?? 0;
        if (left > 0) { this.fail.set(fn, left - 1); return json(route, { code: 'P0001', message: 'boom', details: null, hint: null }, 500); }
        try {
          const out = this.rpc(fn, args, true);
          if (fn === 'shop_checkout_qr' && this.holdCheckoutQr) await this.qrGate;
          if (this.drop.delete(fn)) return route.abort('connectionreset');   // handled by the server, never answered
          return json(route, out);
        } catch (e) { const er = e as Error & { details?: string }; return json(route, { code: 'P0001', message: er.message, details: er.details ?? null, hint: null }, 400); }
      }
      if (p.startsWith('/rest/v1/') && !p.startsWith('/rest/v1/rpc/')) this.restReads.push({ table: p.slice('/rest/v1/'.length), select: url.searchParams.get('select') });
      if (p === '/rest/v1/finance_payment_evidence') {
        if (this.failEvidenceReads) return json(route, { code: 'XX000', message: 'boom', details: null, hint: null }, 500);
        // like PostgREST: only the columns asked for come back, and a column the table does not have is an error
        const id = url.searchParams.get('invoice_id')?.replace('eq.', '');
        const inv = this.orders.find((o) => o.invoice.id === id)?.invoice;
        const missing = this.noReviewColumns ? REVIEW_COLUMNS : [];                       // an old database has no such columns
        const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([c]) => !missing.includes(c)));
        const rows = (inv?.evidence ?? []).map((e) => strip(this.evidenceRow(e, id ?? '')));
        const select = url.searchParams.get('select') ?? '*';
        if (select === '*') return json(route, rows);
        const cols = select.split(',').map((c) => c.trim());
        const have = strip(this.evidenceRow({ id: '', status: 'submitted', claimed_amount: 0, created_at: '' }, ''));
        const unknown = cols.find((c) => !(c in have));
        if (unknown) return json(route, { code: '42703', message: `column finance_payment_evidence.${unknown} does not exist`, details: null, hint: null }, 400);
        return json(route, rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))));
      }
      if (p === '/rest/v1/finance_payment_accounts') return json(route, this.paymentAccounts);
      if (p === '/rest/v1/finance_receipts') {                                           // the customer's own receipts of one invoice
        const id = url.searchParams.get('invoice_id')?.replace('eq.', '');
        const inv = this.orders.find((o) => o.invoice.id === id)?.invoice;
        return json(route, (inv?.receipts ?? []).map((r, i) => ({ id: `rc-${i}`, receipt_no: r.receipt_no, invoice_id: id, amount: r.amount, bank_trans_ref: null, received_at: r.received_at, needs_review: false, status: 'posted', created_at: r.received_at })));
      }
      if (p.startsWith('/storage/v1/object/sign/') && req.method() === 'POST') return json(route, { signedURL: `/object/sign/${p.slice('/storage/v1/object/sign/'.length)}?token=t` });   // staff open a slip
      if (p.startsWith('/storage/v1/object/sign/')) return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
      if (p.startsWith('/storage/v1/')) {
        if (req.method() === 'POST' || req.method() === 'PUT') this.uploads.push({ path: p.replace('/storage/v1/object/', ''), type: req.headers()['content-type'] ?? null, size: req.postDataBuffer()?.length ?? 0, upsert: req.headers()['x-upsert'] ?? null });
        return json(route, { Key: 'payment-evidence/x', Id: 'x' });
      }
      if (p.startsWith('/rest/v1/')) return json(route, this.w.rest(p.slice('/rest/v1/'.length)) ?? []);
      return json(route, {}, 404);
    });
    // a signed-in customer (the real app signs in with LINE; the shop only needs a Supabase session)
    await page.addInitScript(([uid, email, ref]) => {
      const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
      try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: exp, user: { id: uid, aud: 'authenticated', role: 'authenticated', email, user_metadata: {}, app_metadata: {}, created_at: '2026-01-01T00:00:00Z' } })); } catch { /* ignore */ }
    }, [USER_ID, this.profile.email, HOST.split('.')[0]]);
  }
}
