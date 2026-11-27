// The preorder (scheduled pickup) part of the fake backend. It mirrors the CONTRACT of the preorder_* functions of supabase/migrations/20261128100000_preorders.sql, which is tested
// for real (against the live data, rolled back) by supabase/tests/preorders.sql: the same refusal codes, the same slot states, capacity counted in orders and units, the change window,
// the checklist before "ready", notices. It proves the SCREENS (customer app, Preorders page, Pickup prep board); it proves nothing about the database.
import type { FakeShop, FOrder } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';

const TZ = 'Asia/Bangkok';
export const dayKey = (d: Date | string | number): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
export const addDays = (key: string, n: number): string => dayKey(new Date(new Date(`${key}T12:00:00+07:00`).getTime() + n * 86_400_000));
export const instant = (key: string, hhmm: string): string => new Date(`${key}T${hhmm}:00+07:00`).toISOString();
const hm = (d: Date | string): string => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
/** a slot start, N days from today in shop time */
export const slotAt = (off: number, hhmm: string): string => instant(addDays(dayKey(new Date()), off), hhmm);

interface Meta { pickup_at: string; reschedule_count: number; cancel_kind: 'customer' | 'rejected' | 'staff' | null; confirmed_at?: string; preparing_at?: string; ready_at?: string; completed_at?: string }
export interface FNotice { order_id: string; audience: 'customer' | 'staff'; kind: string; data: Record<string, unknown>; at: string; text_th: string | null; for_profile: string | null }
const ACTIVE = ['new', 'confirmed', 'preparing', 'packed', 'ready'];
const NOT_COUNTED = ['cancelled', 'returned'];

export class FakePreorders {
  enabled = false;
  /** true = a database WITHOUT the preorder migration: no preorder function exists and the public settings carry no preorder_enabled */
  missing = false;
  /** the caller is a SUPER_ADMIN (may change the settings) */
  canEdit = true;
  s = {
    slot_minutes: 30, lead_minutes: 120, max_advance_days: 14, max_orders_per_slot: 2, max_units_per_slot: null as number | null, max_units_per_day: null as number | null, change_cutoff_minutes: 180,
    prep_lead_minutes: 90, reminder_minutes: 120, grace_minutes: 30, large_order_units: 50, customer_note: 'กรุณามาถึงตามเวลานัด' as string | null, configured: true,
    weekly: Array.from({ length: 7 }, (_, dow) => ({ dow, closed: false, open: '09:00', close: '18:00' })),
  };
  days = new Map<string, { kind: 'closed' | 'special'; open: string | null; close: string | null; reason: string | null }>();
  meta = new Map<string, Meta>();
  notices: FNotice[] = [];
  assignments = new Map<string, string>();
  checks = new Map<string, Set<number>>();
  /** the staff members the assign list offers */
  staffList = [{ id: 'staff-1', name: 'Staff', role: 'SUPER_ADMIN' }, { id: 'staff-2', name: 'Noi', role: 'ADMIN' }];
  shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }

  private err(message: string, details?: string): never { throw Object.assign(new Error(message), { details }); }
  private requireStaff(what: string) { if (!['ADMIN', 'SUPER_ADMIN'].includes(this.shop.profile.role)) this.err(`You are not allowed to ${what}`); }
  private order(id: unknown): FOrder { const o = this.shop.orders.find((x) => x.id === id); if (!o) this.err('Order not found'); return o; }
  isPreorder = (o: FOrder) => this.meta.has(o.id);
  private units = (o: FOrder) => o.items.reduce((s, i) => s + i.qty, 0);
  private pay = (o: FOrder) => this.shop.invoiceState(o.invoice).status_code;
  private note(o: FOrder, audience: 'customer' | 'staff', kind: string, data: Record<string, unknown> = {}, forProfile: string | null = null) {
    this.notices.push({ order_id: o.id, audience, kind, data, at: new Date().toISOString(), text_th: `${kind} ${o.order_no}`, for_profile: forProfile });
  }

  // ------------------------------------------------------------ the calendar
  hours(day: string): { closed: boolean; open?: string; close?: string; special?: boolean; reason?: string | null } {
    const d = this.days.get(day);
    if (d) return d.kind === 'closed' ? { closed: true, special: true, reason: d.reason } : { closed: false, special: true, reason: d.reason, open: d.open!, close: d.close! };
    const w = this.s.weekly[new Date(`${day}T12:00:00+07:00`).getUTCDay()];
    return w.closed ? { closed: true, special: false, reason: null } : { closed: false, special: false, reason: null, open: w.open, close: w.close };
  }
  grid(day: string): string[] {
    const h = this.hours(day); if (h.closed) return [];
    const out: string[] = []; const end = new Date(instant(day, h.close!)).getTime();
    for (let t = new Date(instant(day, h.open!)).getTime(); t + this.s.slot_minutes * 60_000 <= end; t += this.s.slot_minutes * 60_000) out.push(new Date(t).toISOString());
    return out;
  }
  load(slot: string, exclude?: string) {
    const a = new Date(slot).getTime(); const b = a + this.s.slot_minutes * 60_000; let orders = 0; let units = 0;
    for (const o of this.shop.orders) { const m = this.meta.get(o.id); if (!m || o.id === exclude || NOT_COUNTED.includes(o.status)) continue; const t = new Date(m.pickup_at).getTime(); if (t >= a && t < b) { orders++; units += this.units(o); } }
    return { orders, units };
  }
  private dayUnits(day: string, exclude?: string) {
    return this.shop.orders.reduce((s, o) => { const m = this.meta.get(o.id); return m && o.id !== exclude && !NOT_COUNTED.includes(o.status) && dayKey(m.pickup_at) === day ? s + this.units(o) : s; }, 0);
  }
  /** the slot rule (preorder_check_slot) */
  checkSlot(at: string, units: number, exclude?: string, staff = false, force = false) {
    if (!staff && !this.enabled) this.err('PREORDER_OFF');
    const day = dayKey(at); const t = new Date(at).getTime();
    if (staff) { if (t < Date.now()) this.err('SLOT_PAST'); } else {
      if (t < Date.now() + this.s.lead_minutes * 60_000) this.err('SLOT_TOO_SOON');
      if (day > addDays(dayKey(new Date()), this.s.max_advance_days)) this.err('SLOT_TOO_FAR');
    }
    if (!this.grid(day).some((g) => new Date(g).getTime() === t)) this.err(this.hours(day).closed ? 'SLOT_CLOSED' : 'SLOT_INVALID');
    if (force) return;
    const ld = this.load(new Date(t).toISOString(), exclude);
    if (ld.orders >= this.s.max_orders_per_slot) this.err('SLOT_FULL');
    if (this.s.max_units_per_slot != null && ld.units + units > this.s.max_units_per_slot) this.err('SLOT_UNITS_FULL');
    if (this.s.max_units_per_day != null && this.dayUnits(day, exclude) + units > this.s.max_units_per_day) this.err('DAY_UNITS_FULL');
  }
  // hooks called by the base fake
  publicSetting() { return this.missing ? {} : { preorder_enabled: this.enabled && this.shop.settings.pickup_enabled && this.shop.settings.shop_open }; }
  checkNew(at: string, fulfilment: string, units: number) { if (fulfilment !== 'pickup') this.err('PREORDER_PICKUP_ONLY'); this.checkSlot(at, units); }
  attach(o: FOrder, at: string) {
    this.meta.set(o.id, { pickup_at: at, reschedule_count: 0, cancel_kind: null });
    this.note(o, 'customer', 'placed'); this.note(o, 'staff', 'new');
    if (this.units(o) >= this.s.large_order_units) this.note(o, 'staff', 'large');
  }
  pickupOf = (o: FOrder): string => this.meta.get(o.id)?.pickup_at ?? '';
  upcoming = (o: FOrder) => this.isPreorder(o) && ACTIVE.includes(o.status);
  rules(o: FOrder) {
    const m = this.meta.get(o.id); if (!m) return null;
    const deadline = new Date(new Date(m.pickup_at).getTime() - this.s.change_cutoff_minutes * 60_000);
    const inTime = Date.now() <= deadline.getTime();
    return { deadline: deadline.toISOString(), can_reschedule: inTime && ['new', 'confirmed'].includes(o.status) && m.reschedule_count < 3, can_cancel_time: inTime && o.status === 'new', reschedules_left: Math.max(3 - m.reschedule_count, 0) };
  }
  /** the preorder keys of the order JSON (what shop_order_json adds) */
  orderExtra(o: FOrder): Record<string, unknown> {
    const m = this.meta.get(o.id);
    if (this.missing) return {};
    return { order_type: m ? 'preorder' : 'regular', pickup_at: m?.pickup_at ?? null, confirmed_at: m?.confirmed_at ?? null, preparing_at: m?.preparing_at ?? null, ready_at: m?.ready_at ?? null, completed_at: m?.completed_at ?? null,
      cancel_kind: m?.cancel_kind ?? null, reschedule_count: m?.reschedule_count ?? 0, prep: m ? { checked: this.checks.get(o.id)?.size ?? 0, total: o.items.length } : null, change: this.rules(o),
      items: o.items.map((i) => ({ ...i, checked: this.checks.get(o.id)?.has(i.line_no) ?? false })) };
  }
  customerNotices(o: FOrder) { return this.notices.filter((n) => n.order_id === o.id && n.audience === 'customer').map((n) => ({ at: n.at, kind: n.kind, data: n.data, text_th: n.text_th })); }
  cancelCheck(o: FOrder) {
    const m = this.meta.get(o.id); if (m && Date.now() > new Date(m.pickup_at).getTime() - this.s.change_cutoff_minutes * 60_000) this.err('TOO_LATE_TO_CHANGE');
  }
  afterCancel(o: FOrder, by: 'customer' | 'staff', reason: string) {
    const m = this.meta.get(o.id); if (!m) return;
    const kind = by === 'customer' ? 'customer' : o.status_before_cancel === 'new' ? 'rejected' : 'staff'; m.cancel_kind = kind;
    if (by === 'customer') this.note(o, 'staff', 'cancelled_by_customer'); else this.note(o, 'customer', kind === 'rejected' ? 'rejected' : 'cancelled_by_shop', { reason });
  }
  adminExtra(o: FOrder) { return this.isPreorder(o) ? { preorder: this.row(o, true), notices: this.notices.filter((n) => n.order_id === o.id).map((n) => ({ at: n.at, audience: n.audience, kind: n.kind, data: n.data, text_th: n.text_th, line: null })) } : {}; }

  /** the staff status move of a preorder (shop_admin_set_status with the preorder rules) */
  setStatus(o: FOrder, to: string, note: string | null, why: string | null) {
    const m = this.meta.get(o.id)!;
    const log = (detail: Record<string, unknown>) => this.shop.statusLog.set(o.id, [...(this.shop.statusLog.get(o.id) ?? []), { at: new Date().toISOString(), actor_email: this.shop.profile.email, action: 'order.status', detail }]);
    if (to === 'cancelled') {
      if (!note) this.err('A reason is required'); if (o.invoice.paid > 0) this.err('PAYMENT_RECORDED');
      (o as FOrder & { status_before_cancel?: string }).status_before_cancel = o.status; o.status = 'cancelled'; o.invoice.cancelled = true; o.cancel_reason = note; this.afterCancel(o, 'staff', note); log({ to }); return this.shop.orderJsonPublic(o);
    }
    const ok: Record<string, string[]> = { new: ['confirmed'], confirmed: ['preparing'], preparing: ['packed', 'ready'], packed: ['ready'], ready: ['completed'], completed: ['returned'] };
    if (!(ok[o.status] ?? []).includes(to)) this.err(`An order that is ${o.status} cannot become ${to}`);
    if (to === 'confirmed' && new Date(m.pickup_at).getTime() < Date.now()) this.err('PICKUP_PASSED');
    if (to === 'ready' && (this.checks.get(o.id)?.size ?? 0) < o.items.length) this.err(`PREP_INCOMPLETE: ${this.checks.get(o.id)?.size ?? 0} of ${o.items.length} items ticked`);
    if (to !== 'confirmed' && to !== 'returned' && ![5, 6].includes(this.pay(o)) && !why) this.err('PAYMENT_REQUIRED');
    o.status = to; if (note) o.status_note = note;
    const at = new Date().toISOString();
    if (to === 'confirmed') m.confirmed_at = at; if (to === 'preparing') { m.preparing_at = at; if (!this.assignments.has(o.id)) this.assignments.set(o.id, this.staffList[0].id); } if (to === 'ready') m.ready_at = at; if (to === 'completed') m.completed_at = at;
    if (['confirmed', 'preparing', 'ready', 'completed'].includes(to)) this.note(o, 'customer', to);
    log({ to, note, payment_override: !!why && ![5, 6].includes(this.pay(o)), override_reason: why });
    return this.shop.orderJsonPublic(o);
  }

  // ------------------------------------------------------------ rows for the staff screens
  flags(o: FOrder, m: Meta): string[] {
    if (!ACTIVE.includes(o.status)) return [];
    const f: string[] = []; const t = new Date(m.pickup_at).getTime(); const now = Date.now();
    if (o.status === 'new' && now > new Date(o.created_at).getTime() + 30 * 60_000) f.push('unconfirmed');
    if (![5, 6].includes(this.pay(o)) && t < now + 24 * 3600e3) f.push('unpaid_soon');
    if (['new', 'confirmed'].includes(o.status) && now >= t - this.s.prep_lead_minutes * 60_000 && now < t) f.push('not_started');
    if (['new', 'confirmed', 'preparing', 'packed'].includes(o.status) && now >= t) f.push('late');
    if (o.status === 'ready' && now > t + this.s.grace_minutes * 60_000) f.push('overdue_pickup');
    if (this.units(o) >= this.s.large_order_units) f.push('large');
    if (this.days.get(dayKey(m.pickup_at))?.kind === 'closed') f.push('closed_day');
    return f;
  }
  row(o: FOrder, items = false) {
    const m = this.meta.get(o.id)!; const a = this.assignments.get(o.id) ?? null;
    return { id: o.id, order_no: o.order_no, status: o.status, contact_name: o.contact_name, contact_phone: o.contact_phone, note: o.note, status_note: o.status_note, created_at: o.created_at, pickup_at: m.pickup_at, total: o.total,
      lines: o.items.length, units: this.units(o), pay_code: this.pay(o), assigned_to: a, assigned_name: a ? this.staffList.find((s) => s.id === a)?.name ?? null : null, prep: { checked: this.checks.get(o.id)?.size ?? 0, total: o.items.length },
      cancel_kind: m.cancel_kind, reschedule_count: m.reschedule_count, flags: this.flags(o, m),
      ...(items ? { items: o.items.map((i) => ({ line_no: i.line_no, sku_code: i.sku_code, name: i.name, unit: i.unit, qty: i.qty, image_url: null, checked: this.checks.get(o.id)?.has(i.line_no) ?? false })) } : {}) };
  }
  private all = () => this.shop.orders.filter((o) => this.meta.has(o.id));

  rpc(fn: string, a: Record<string, unknown>): unknown {
    if (!fn.startsWith('preorder_')) return NOT_HANDLED;
    if (this.missing) this.err(`Could not find the function public.${fn} in the schema cache`);
    const user = !fn.startsWith('preorder_admin') && fn !== 'preorder_prep_board' && fn !== 'preorder_prep_set';
    if (!user) this.requireStaff(fn === 'preorder_prep_board' ? 'see the pickup board' : 'see preorders');
    switch (fn) {
      case 'preorder_options': {
        if (!this.enabled || !this.shop.settings.pickup_enabled || !this.shop.settings.shop_open) return { enabled: false };
        const today = dayKey(new Date()); const lead = Date.now() + this.s.lead_minutes * 60_000;
        const days = Array.from({ length: this.s.max_advance_days + 1 }, (_, i) => {
          const day = addDays(today, i); const h = this.hours(day);
          const free = h.closed ? 0 : this.grid(day).filter((g) => new Date(g).getTime() >= lead && this.load(g).orders < this.s.max_orders_per_slot).length;
          return { day, closed: !!h.closed, open: h.open ?? null, close: h.close ?? null, reason: h.reason ?? null, free_slots: free };
        });
        return { enabled: true, slot_minutes: this.s.slot_minutes, lead_minutes: this.s.lead_minutes, max_advance_days: this.s.max_advance_days, change_cutoff_minutes: this.s.change_cutoff_minutes, note: this.s.customer_note, now: new Date().toISOString(), days };
      }
      case 'preorder_slots': {
        if (!this.enabled) this.err('PREORDER_OFF');
        const day = String(a.p_day); const today = dayKey(new Date());
        if (day < today) this.err('SLOT_PAST'); if (day > addDays(today, this.s.max_advance_days)) this.err('SLOT_TOO_FAR');
        const h = this.hours(day); const units = Math.max(Number(a.p_units ?? 1), 1); const lead = Date.now() + this.s.lead_minutes * 60_000;
        const du = this.dayUnits(day);
        return { day, closed: !!h.closed, open: h.open ?? null, close: h.close ?? null, reason: h.reason ?? null, slots: this.grid(day).map((g) => {
          const ld = this.load(g); const oleft = this.s.max_orders_per_slot - ld.orders; const uleft = this.s.max_units_per_slot == null ? null : this.s.max_units_per_slot - ld.units;
          const state = new Date(g).getTime() < lead ? 'soon' : oleft <= 0 ? 'full' : uleft != null && uleft < units ? 'units' : this.s.max_units_per_day != null && du + units > this.s.max_units_per_day ? 'units' : 'ok';
          return { at: g, time: hm(g), state, orders_left: Math.max(oleft, 0), units_left: uleft };
        }) };
      }
      case 'preorder_change_my_order': {
        const o = this.order(a.p_id); const m = this.meta.get(o.id); if (!m) this.err('NOT_PREORDER');
        const p = a.p_patch as { pickup_at?: string; note?: string };
        if (!['new', 'confirmed'].includes(o.status)) this.err('ORDER_IN_PROGRESS');
        if (Date.now() > new Date(m.pickup_at).getTime() - this.s.change_cutoff_minutes * 60_000) this.err('TOO_LATE_TO_CHANGE');
        const newNote = 'note' in p ? (String(p.note ?? '').trim() || null) : o.note; if (newNote && newNote.length > 300) this.err('INVALID_NOTE');
        const moved = !!p.pickup_at && new Date(p.pickup_at).getTime() !== new Date(m.pickup_at).getTime();
        if (moved) { if (m.reschedule_count >= 3) this.err('RESCHEDULE_LIMIT'); this.checkSlot(p.pickup_at!, this.units(o), o.id); }
        const from = m.pickup_at; if (moved) { m.pickup_at = new Date(p.pickup_at!).toISOString(); m.reschedule_count++; } o.note = newNote;
        if (moved || newNote !== o.note) this.note(o, 'staff', 'changed', { from });
        return this.shop.orderJsonPublic(o);
      }
      case 'preorder_request_change': {
        const o = this.order(a.p_id); const msg = String(a.p_message ?? '').trim();
        if (msg.length < 3 || msg.length > 300) this.err('INVALID_MESSAGE');
        if (this.notices.some((n) => n.order_id === o.id && n.kind === 'request' && Date.now() - new Date(n.at).getTime() < 600_000)) this.err('TOO_MANY_REQUESTS');
        this.note(o, 'staff', 'request', { message: msg }); return { ok: true };
      }
      // ---- staff
      case 'preorder_admin_staff': return this.staffList;
      case 'preorder_admin_dashboard': {
        const day = String(a.p_day ?? dayKey(new Date())); const on = (o: FOrder) => dayKey(this.meta.get(o.id)!.pickup_at) === day; const all = this.all();
        const att = all.filter((o) => ACTIVE.includes(o.status)).sort((x, y) => this.meta.get(x.id)!.pickup_at.localeCompare(this.meta.get(y.id)!.pickup_at)).map((o) => this.row(o)).filter((r) => r.flags.length > 0);
        const n = (f: (o: FOrder) => boolean) => all.filter((o) => on(o) && f(o)).length;
        return { day, enabled: this.enabled, total: n(() => true), pending: n((o) => o.status === 'new'), confirmed: n((o) => o.status === 'confirmed'), preparing: n((o) => ['preparing', 'packed'].includes(o.status)), ready: n((o) => o.status === 'ready'),
          completed: n((o) => o.status === 'completed'), cancelled: n((o) => NOT_COUNTED.includes(o.status)), upcoming: all.filter((o) => dayKey(this.meta.get(o.id)!.pickup_at) > day && ACTIVE.includes(o.status)).length, pending_all: all.filter((o) => o.status === 'new').length,
          units_today: all.filter((o) => on(o) && !NOT_COUNTED.includes(o.status)).reduce((s, o) => s + this.units(o), 0), attention: att, attention_count: att.length,
          capacity: { max_orders_per_slot: this.s.max_orders_per_slot, max_units_per_slot: this.s.max_units_per_slot, max_units_per_day: this.s.max_units_per_day, day_units: this.dayUnits(day) } };
      }
      case 'preorder_admin_list': {
        const q = String(a.p_search ?? '').toLowerCase(); const st = a.p_status as string | null; const from = a.p_from as string | null; const to = a.p_to as string | null;
        const tf = a.p_time_from as string | null; const tt = a.p_time_to as string | null; const as = a.p_assigned as string | null; const pay = a.p_pay as string | null;
        let xs = this.all().filter((o) => { const m = this.meta.get(o.id)!; const d = dayKey(m.pickup_at); const h = hm(m.pickup_at); const p = this.pay(o);
          return (!st || o.status === st) && (!from || d >= from) && (!to || d <= to) && (!tf || h >= tf) && (!tt || h <= tt) && (!q || [o.order_no, o.contact_name, o.contact_phone].some((f) => f.toLowerCase().includes(q)))
            && (!as || (as === 'none' ? !this.assignments.has(o.id) : this.assignments.get(o.id) === as)) && (!pay || (pay === 'paid' ? [5, 6].includes(p) : pay === 'review' ? [3, 4].includes(p) : [0, 1, 7, 9, 10].includes(p))); });
        const sort = String(a.p_sort ?? 'pickup_asc'); const pk = (o: FOrder) => this.meta.get(o.id)!.pickup_at;
        xs = xs.sort((x, y) => sort === 'pickup_desc' ? pk(y).localeCompare(pk(x)) : sort === 'created_desc' ? y.created_at.localeCompare(x.created_at) : sort === 'total_desc' ? y.total - x.total : pk(x).localeCompare(pk(y)));
        const off = Number(a.p_offset ?? 0); const lim = Number(a.p_limit ?? 30);
        return { total: xs.length, orders: xs.slice(off, off + lim).map((o) => this.row(o)) };
      }
      case 'preorder_admin_schedule': {
        const day = String(a.p_day ?? dayKey(new Date())); const orders = this.all().filter((o) => dayKey(this.meta.get(o.id)!.pickup_at) === day && !NOT_COUNTED.includes(o.status));
        const grid = this.grid(day); const times = [...new Set([...grid, ...orders.map((o) => new Date(this.meta.get(o.id)!.pickup_at).toISOString())])].sort();
        return { day, hours: this.hours(day), slot_minutes: this.s.slot_minutes, max_orders_per_slot: this.s.max_orders_per_slot, max_units_per_slot: this.s.max_units_per_slot, max_units_per_day: this.s.max_units_per_day, day_units: this.dayUnits(day),
          slots: times.map((t) => ({ at: t, time: hm(t), in_grid: grid.includes(t), load: this.load(t), orders: orders.filter((o) => new Date(this.meta.get(o.id)!.pickup_at).toISOString() === t).map((o) => this.row(o)) })),
          cancelled: this.all().filter((o) => dayKey(this.meta.get(o.id)!.pickup_at) === day && NOT_COUNTED.includes(o.status)).length };
      }
      case 'preorder_prep_board': {
        const today = dayKey(new Date()); const horizon = addDays(today, Math.max(Number(a.p_days ?? 2), 1) - 1);
        const rows = this.all().filter((o) => ['new', 'confirmed', 'preparing', 'packed', 'ready'].includes(o.status) && dayKey(this.meta.get(o.id)!.pickup_at) <= horizon && (!a.p_mine || this.assignments.get(o.id) === this.staffList[0].id))
          .sort((x, y) => this.meta.get(x.id)!.pickup_at.localeCompare(this.meta.get(y.id)!.pickup_at)).map((o) => this.row(o, true));
        return { now: new Date().toISOString(), me: this.staffList[0].id, orders: rows };
      }
      case 'preorder_admin_assign': {
        const o = this.order(a.p_order); if (a.p_profile && !this.staffList.some((s) => s.id === a.p_profile)) this.err('INVALID_ASSIGNEE');
        if (a.p_profile) this.assignments.set(o.id, String(a.p_profile)); else this.assignments.delete(o.id); return this.row(o, true);
      }
      case 'preorder_admin_reschedule': {
        const o = this.order(a.p_order); const m = this.meta.get(o.id)!; if (!String(a.p_reason ?? '').trim()) this.err('A reason is required');
        if (!['new', 'confirmed', 'preparing'].includes(o.status)) this.err('ORDER_IN_PROGRESS');
        this.checkSlot(String(a.p_pickup_at), this.units(o), o.id, true, a.p_force === true);
        const from = m.pickup_at; m.pickup_at = new Date(String(a.p_pickup_at)).toISOString(); this.note(o, 'customer', 'rescheduled_by_shop', { from, reason: a.p_reason });
        return this.row(o, true);
      }
      case 'preorder_prep_set': {
        const o = this.order(a.p_order); if (!['confirmed', 'preparing', 'packed'].includes(o.status)) this.err('NOT_PREPARING');
        const set = this.checks.get(o.id) ?? new Set<number>(); const lines = a.p_line == null ? o.items.map((i) => i.line_no) : [Number(a.p_line)];
        if (lines.some((l) => !o.items.some((i) => i.line_no === l))) this.err('Line not found');
        for (const l of lines) { if (a.p_checked === false) set.delete(l); else set.add(l); } this.checks.set(o.id, set); return this.row(o, true);
      }
      case 'preorder_admin_notices': return this.notices.slice().reverse().map((n) => { const o = this.shop.orders.find((x) => x.id === n.order_id)!; return { at: n.at, order_id: n.order_id, order_no: o.order_no, audience: n.audience, kind: n.kind, data: n.data, text_th: n.text_th, for_profile: n.for_profile, line: null, line_error: null }; });
      case 'preorder_admin_settings': {
        const s = this.s;
        return { enabled: this.enabled, configured: s.configured, slot_minutes: s.slot_minutes, lead_minutes: s.lead_minutes, max_advance_days: s.max_advance_days, weekly_hours: s.weekly, max_orders_per_slot: s.max_orders_per_slot, max_units_per_slot: s.max_units_per_slot,
          max_units_per_day: s.max_units_per_day, change_cutoff_minutes: s.change_cutoff_minutes, prep_lead_minutes: s.prep_lead_minutes, reminder_minutes: s.reminder_minutes, grace_minutes: s.grace_minutes, large_order_units: s.large_order_units,
          customer_note: s.customer_note, updated_at: new Date().toISOString(), can_edit: this.canEdit, shop_open: this.shop.settings.shop_open, pickup_enabled: this.shop.settings.pickup_enabled,
          days: [...this.days].sort().map(([day, d]) => ({ day, kind: d.kind, open: d.open, close: d.close, reason: d.reason, orders: this.all().filter((o) => ACTIVE.includes(o.status) && dayKey(this.meta.get(o.id)!.pickup_at) === day).length })) };
      }
      case 'preorder_admin_save_settings': {
        if (!this.canEdit) this.err('Only a SUPER_ADMIN can change the preorder settings'); const p = a.p_patch as Record<string, unknown>;
        if ('slot_minutes' in p && (Number(p.slot_minutes) < 5 || Number(p.slot_minutes) > 240)) this.err('INVALID_SETTING: a value is out of range');
        if (p.enabled === true && !this.s.configured) this.err('PREORDER_NOT_CONFIGURED: save the opening hours first');
        for (const [k, v] of Object.entries(p)) { if (k === 'enabled') this.enabled = v === true; else if (k === 'weekly_hours') { this.s.weekly = v as typeof this.s.weekly; this.s.configured = true; } else (this.s as Record<string, unknown>)[k] = v; }
        return this.rpc('preorder_admin_settings', {});
      }
      case 'preorder_admin_save_day': {
        const day = String(a.p_day); const kind = String(a.p_kind) as 'closed' | 'special';
        if (day < dayKey(new Date())) this.err('INVALID_DAY: choose today or a later date');
        const n = this.all().filter((o) => ACTIVE.includes(o.status) && dayKey(this.meta.get(o.id)!.pickup_at) === day).length;
        if (kind === 'closed' && n > 0 && a.p_force !== true) this.err(`DAY_HAS_ORDERS: ${n} active preorder(s) would no longer fit`);
        this.days.set(day, { kind, open: (a.p_open as string | null) ?? null, close: (a.p_close as string | null) ?? null, reason: (a.p_reason as string | null) ?? null }); return { ok: true, orders_affected: kind === 'closed' ? n : 0 };
      }
      case 'preorder_admin_remove_day': this.days.delete(String(a.p_day)); return { ok: true };
      default: return NOT_HANDLED;
    }
  }
}
