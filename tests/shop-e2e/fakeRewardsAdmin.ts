// The back-office rules / promotion packs / simulator / master-switch part of the rewards fake (Promotions > Online shop). It mirrors the CONTRACT of
// docs/superpowers/plans/2026-11-21-rewards-boards-sku-sync.md (rw_admin_rules, rw_admin_save_rule, rw_admin_packs, rw_admin_create_pack, rw_admin_save_pack,
// rw_admin_sku_search, rw_admin_simulate, rw_admin_events, rw_settings_public, rw_admin_save_settings), which the SQL migrations implement and test for real.
// This file proves the SCREENS only. It is installed as an extra route on top of FakeShop.install(), so it does not touch fakeBackend.ts or fakeRewards.ts.
import type { Page } from '@playwright/test';
import type { FakeShop } from './fakeBackend';
import type { CustomerHit, EventDoc, Pack, RewardsSettings, Rule, RulePatch, SimLine, SkuHit } from '../../src/rewards/api';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const HANDLED = new Set(['rw_settings_public', 'rw_admin_save_settings', 'rw_admin_rules', 'rw_admin_save_rule', 'rw_admin_set_rule_active', 'rw_admin_packs', 'rw_admin_create_pack', 'rw_admin_save_pack', 'rw_admin_sku_search', 'rw_admin_simulate', 'rw_admin_events', 'rw_admin_customer_search']);

interface RegSku { sku_code: string; name: string; price: number; category: string; status: 'active' | 'inactive'; pack?: boolean }
export const INACTIVE_SKU = 'FG-000777';
export const SOMCHAI: CustomerHit = { id: '11111111-1111-4111-8111-111111111111', name: 'Somchai Jaidee', phone: '0812345678', email: 'somchai@example.test' };
export const MALEE: CustomerHit = { id: '22222222-2222-4222-8222-222222222222', name: 'Malee Rakdee', phone: '0898765432', email: 'malee@example.test' };

export class FakeRewardsAdmin {
  settings: RewardsSettings = { enabled: false, boards_enabled: false };
  rules: Rule[] = [];
  packs: Pack[] = [];
  events: EventDoc[] = [];
  /** every contract function the browser called here, with its arguments */
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  /** test control: the server refuses the master switch (as it does for anyone but a Super Admin) even though the screen offered it */
  denySettings = false;
  /** test control: the next rule save is refused with this server message (e.g. 'BAD_RULE: ...'), whatever the form sent */
  refuseNext: string | null = null;
  customers: CustomerHit[] = [SOMCHAI, MALEE, { id: '33333333-3333-4333-8333-333333333333', name: null, phone: '0855550000', email: null }];
  private registry: RegSku[];
  private keys = new Map<string, Pack>();
  private n = 0;

  private shop: FakeShop;
  constructor(shop: FakeShop) {
    this.shop = shop;
    this.registry = [
      ...shop.items.map((i) => ({ sku_code: i.sku_code, name: i.name, price: i.price, category: i.category, status: 'active' as const })),
      { sku_code: INACTIVE_SKU, name: 'Retired Mango 6000 (old stock)', price: 300, category: 'Puff', status: 'inactive' },
    ];
    this.events = [{
      id: 'ev-1', name: 'Lucky numbers', description: null, status: 'active', starts_at: null, ends_at: null, number_min: 0, number_max: 99, hold_minutes: 0, max_per_customer: null,
      boards: [1, 2, 3].map((slot) => ({ id: `bd-${slot}`, event_id: 'ev-1', slot: slot as 1 | 2 | 3, name: `Board ${'ABC'[slot - 1]}`, color: '#3366ff', mode: 'exclusive' as const, state: 'open' as const, rev: 1, taken: 0, total: 100, last_reset_id: null })),
    }];
  }
  count = (fn: string) => this.calls.filter((c) => c.fn === fn).length;
  last = (fn: string) => this.calls.filter((c) => c.fn === fn).at(-1)?.args;

  // ------------------------------------------------------------ test controls
  /** a SKU that was active when the staff member searched and was switched off in Products before Save */
  /** a rule that has given rewards since the form was opened (so the form still thinks it can be changed) */
  markUsed(id: string) { this.rules.find((r) => r.id === id)!.stats = { bills: 3, granted: 5 }; }
  deactivate(code: string) { const s = this.registry.find((x) => x.sku_code === code)!; s.status = 'inactive'; }
  addRule(over: Partial<Rule> = {}): Rule {
    const r: Rule = { id: `rule-${++this.n}`, kind: 'board_pick', name: 'Pick per ฿300 bill', active: true, starts_at: null, ends_at: null, spend_step: 300, reward_amount: 1, basis: 'per_bill', max_per_order: null,
      category_codes: [], include_skus: [], exclude_skus: [], include_packs: false, only_profile_ids: null, event_id: 'ev-1', board_slots: null, stats: { bills: 0, granted: 0 }, ...over };
    this.rules.push(r); return r;
  }
  addPack(over: Partial<Pack> = {}): Pack {
    const code = over.pack_sku_code ?? `FG-9${String(++this.n).padStart(5, '0')}`;
    this.registry.push({ sku_code: code, name: over.name ?? '4 for 300', price: over.price ?? 300, category: 'Puff', status: 'active', pack: true });
    const p: Pack = { pack_sku_code: code, name: '4 for 300', price: 300, status: 'active', active: true, eligible_value: null, points_per_pack: 3, sold_packs: 0,
      items: [{ sku_code: 'FG-000001', name: this.sku('FG-000001').name, qty: 4, status: 'active' }], ...over };
    this.packs.push(p); return p;
  }

  // ------------------------------------------------------------ server logic (mirrors the SQL contract)
  private err(m: string): never { throw new Error(m); }
  private sku(code: string): RegSku { return this.registry.find((s) => s.sku_code === code) ?? this.err(`NOT_FOUND: ${code}`); }
  private staff() { if (!['ADMIN', 'SUPER_ADMIN'].includes(this.shop.profile.role)) this.err('FORBIDDEN: staff only'); }
  private superOnly() { if (this.shop.profile.role !== 'SUPER_ADMIN' || this.denySettings) this.err('FORBIDDEN: only a Super Admin can do this'); }
  private hit(s: RegSku): SkuHit { return { sku_code: s.sku_code, name: s.name, status: s.status, price: s.price, category: s.category, brand: null, is_pack: !!s.pack, origin: 'import' }; }
  private checkIncluded(codes: string[]) { for (const c of codes) { const s = this.registry.find((x) => x.sku_code === c); if (!s) this.err(`INACTIVE_SKU: ${c}`); if (s.status !== 'active') this.err(`INACTIVE_SKU: ${c}`); } }

  /** one rule's eligible amount for a cart: the scope rule of the contract (exclude wins; include or category; a pack only if the rule counts packs) */
  private amount(r: Rule, items: { sku_code: string; qty: number }[]): number {
    let sum = 0;
    for (const it of items) {
      const s = this.sku(it.sku_code); const pack = this.packs.find((p) => p.pack_sku_code === s.sku_code);
      if (r.exclude_skus.includes(s.sku_code)) continue;
      if (pack) { if (r.include_packs) sum += (pack.eligible_value ?? pack.price) * it.qty; continue; }
      const open = r.include_skus.length === 0 && r.category_codes.length === 0;
      if (open || r.include_skus.includes(s.sku_code) || r.category_codes.includes(s.category)) sum += s.price * it.qty;
    }
    return sum;
  }
  private reward(r: Rule, amount: number) { const n = Math.floor(Math.round(amount * 100) / Math.round(r.spend_step * 100)) * r.reward_amount; return r.max_per_order ? Math.min(n, r.max_per_order) : n; }
  private next(r: Rule, amount: number): number | null {
    if (r.max_per_order && this.reward(r, amount) >= r.max_per_order) return null;
    const step = Math.round(r.spend_step * 100); return (step - (Math.round(amount * 100) % step)) / 100;
  }

  rpc(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'rw_settings_public': return { ...this.settings };
      case 'rw_admin_save_settings': { this.superOnly(); Object.assign(this.settings, a.p_patch as object); return { ...this.settings }; }
      case 'rw_admin_events': { this.staff(); return this.events; }
      case 'rw_admin_rules': { this.staff(); return this.rules; }
      case 'rw_admin_save_rule': {
        this.staff();
        if (this.refuseNext) { const m = this.refuseNext; this.refuseNext = null; this.err(m); }
        const p = a.p_patch as RulePatch; const cur = a.p_id ? this.rules.find((r) => r.id === a.p_id) : null;
        if (a.p_id && !cur) this.err('NOT_FOUND');
        const m: Rule = { id: cur?.id ?? `rule-${++this.n}`, kind: 'points', name: '', active: true, starts_at: null, ends_at: null, spend_step: 300, reward_amount: 1, basis: 'per_bill', max_per_order: null, category_codes: [], include_skus: [], exclude_skus: [],
          include_packs: false, only_profile_ids: null, event_id: null, board_slots: null, stats: cur?.stats ?? { bills: 0, granted: 0 }, ...(cur ?? {}), ...p };
        if (!cur && !m.starts_at) m.starts_at = new Date().toISOString();                   // a new rule starts now unless staff chose a date: never retroactive
        if (cur && cur.stats.granted > 0) {                                                    // used: only name, active and an end date that is not earlier
          const frozen = (Object.keys(p) as (keyof Rule)[]).filter((k) => !['name', 'active', 'ends_at'].includes(k) && JSON.stringify(p[k as keyof RulePatch]) !== JSON.stringify(cur[k]));
          if (frozen.length) this.err('BAD_RULE: RULE_USED');
          if ('ends_at' in p && p.ends_at != null && (cur.ends_at == null || Date.parse(p.ends_at) < Date.parse(cur.ends_at))) this.err('BAD_RULE: RULE_USED');
        }
        if (!m.name.trim()) this.err('BAD_RULE: name is required');
        if (!(m.spend_step > 0)) this.err('BAD_RULE: spend_step must be greater than 0');
        if (m.kind === 'board_pick' && m.basis !== 'per_bill') this.err('BAD_RULE: board picks are counted per bill');
        if (m.kind === 'board_pick' && !this.events.some((e) => e.id === m.event_id)) this.err('BAD_RULE: a board pick rule needs an event');
        this.checkIncluded(m.include_skus);
        if (cur) Object.assign(cur, m); else this.rules.push(m);
        return cur ?? m;
      }
      case 'rw_admin_set_rule_active': { this.staff(); const r = this.rules.find((x) => x.id === a.p_id) ?? this.err('NOT_FOUND'); r.active = !!a.p_active; return r; }
      case 'rw_admin_packs': { this.staff(); return this.packs; }
      case 'rw_admin_create_pack': {
        this.staff();
        const have = this.keys.get(String(a.p_key)); if (have) return have;
        const items = a.p_items as { sku_code: string; qty: number }[];
        if (!(Number(a.p_price) > 0)) this.err('BAD_PACK: price must be greater than 0');
        if (!items.length) this.err('BAD_PACK: a pack needs at least one product');
        for (const i of items) { const s = this.sku(i.sku_code); if (s.status !== 'active') this.err(`INACTIVE_SKU: ${i.sku_code}`); if (s.pack) this.err('BAD_PACK: a pack cannot contain a pack'); if (!(i.qty >= 1)) this.err('BAD_PACK: quantity must be at least 1'); }
        const patch = a.p_patch as { points_per_pack?: number | null; eligible_value?: number | null };
        const p = this.addPack({ name: String(a.p_name), price: Number(a.p_price), points_per_pack: patch.points_per_pack ?? null, eligible_value: patch.eligible_value ?? null, sold_packs: 0,
          items: items.map((i) => ({ sku_code: i.sku_code, name: this.sku(i.sku_code).name, qty: i.qty, status: 'active' as const })) });
        this.keys.set(String(a.p_key), p); return p;
      }
      case 'rw_admin_save_pack': {
        this.staff();
        const p = this.packs.find((x) => x.pack_sku_code === a.p_pack) ?? this.err('NOT_FOUND'); const patch = a.p_patch as Partial<Pack> & { items?: { sku_code: string; qty: number }[] };
        if (p.sold_packs > 0) for (const k of ['items', 'eligible_value', 'points_per_pack'] as const) if (k in patch && JSON.stringify(patch[k]) !== JSON.stringify(k === 'items' ? p.items.map((i) => ({ sku_code: i.sku_code, qty: i.qty })) : p[k])) this.err(`BAD_PACK: ${k} cannot change once the pack has been sold`);
        const { items, ...rest } = patch; Object.assign(p, rest);
        if (items) p.items = items.map((i) => ({ sku_code: i.sku_code, name: this.sku(i.sku_code).name, qty: i.qty, status: 'active' as const }));
        return p;
      }
      case 'rw_admin_customer_search': {
        this.staff();
        const q = String(a.p_q ?? '').trim().toLowerCase(); if (q.length < 2) return [];
        return this.customers.filter((c) => [c.name, c.phone, c.email].some((v) => (v ?? '').toLowerCase().includes(q))).slice(0, Math.min(Number(a.p_limit ?? 10), 20));
      }
      case 'rw_admin_sku_search': {
        this.staff();
        const q = String(a.p_q ?? '').toLowerCase();
        return this.registry.filter((s) => (!a.p_only_active || s.status === 'active') && (s.sku_code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))).slice(0, Number(a.p_limit ?? 20)).map((s) => this.hit(s));
      }
      case 'rw_admin_simulate': {
        this.staff();
        const items = a.p_items as { sku_code: string; qty: number }[];
        return this.rules.filter((r) => r.active).map((r): SimLine => { const amount = this.amount(r, items); return { rule_id: r.id, rule_name: r.name, kind: r.kind, eligible_amount: amount, reward: this.reward(r, amount), next_reward_in: this.next(r, amount), note: null }; });
      }
      default: return this.err(`Unknown function ${fn}`);
    }
  }

  async install(page: Page) {
    await page.route('**/rest/v1/rpc/*', async (route) => {
      const req = route.request();
      const fn = new URL(req.url()).pathname.split('/').pop() ?? '';
      if (req.method() !== 'POST' || !HANDLED.has(fn)) return route.fallback();
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(req.postData() || '{}') as Record<string, unknown>; } catch { /* no body */ }
      this.calls.push({ fn, args });
      try { return await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(this.rpc(fn, args)) }); }
      catch (e) { return await route.fulfill({ status: 400, contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 'P0001', message: (e as Error).message, details: null, hint: null }) }); }
    });
  }
}
