import type { AppliedPromo, ChannelCode, Coupon, DB, ID, Product, Promotion } from './types';
import { customerLifetimeSpend } from './loyalty';
import { dayKey, r2 } from '../lib/util';

export interface CartLineIn { productId: ID; qty: number; unitPrice: number; isFree?: boolean }
export interface PromoContext { channel: ChannelCode; branchId: ID; customerId?: ID; now: string; code?: string; couponId?: ID; orderType?: string }
export interface PromoResult {
  applied: AppliedPromo[]; lineDiscounts: number[]; orderDiscount: number; bonusPoints: number; bonusMultiplier: number;
  entitlements: { promoId: ID; eventId: ID; count: number }[]; freeLines: { productId: ID; qty: number; promoId: ID }[];
  couponDiscount: number; skipped: { promoId: ID; name: string; reason: string }[]; issueCoupons: { promoId: ID; value: number; days: number }[];
}

export function promoUsage(d: DB, promoId: ID, customerId?: ID) {
  let total = 0, perCustomer = 0, discount = 0;
  for (const r of d.redemptions) {
    if (r.promoId !== promoId) continue;
    total++;
    discount += r.discount;
    if (customerId && r.customerId === customerId) perCustomer++;
  }
  return { total, perCustomer, discount: r2(discount) };
}

export function effectiveStatus(p: Promotion, now: string): Promotion['status'] {
  if (p.status === 'active' && dayKey(now) > dayKey(p.endAt)) return 'expired';
  return p.status;
}

/** Deterministic, auditable promotion evaluation. Pure with respect to the DB (does not mutate). */
export function evaluatePromotions(d: DB, lines: CartLineIn[], ctx: PromoContext): PromoResult {
  const res: PromoResult = { applied: [], lineDiscounts: lines.map(() => 0), orderDiscount: 0, bonusPoints: 0, bonusMultiplier: 0, entitlements: [], freeLines: [], couponDiscount: 0, skipped: [], issueCoupons: [] };
  const prods = new Map<ID, Product>(d.products.map((p) => [p.id, p]));
  const when = new Date(ctx.now);
  const subtotal = lines.reduce((s, l) => s + (l.isFree ? 0 : l.qty * l.unitPrice), 0);
  const cust = ctx.customerId ? d.customers.find((c) => c.id === ctx.customerId) : undefined;
  const lifetime = cust ? customerLifetimeSpend(d, cust.id) : 0;
  const promos = [...d.promotions].sort((a, b) => b.priority - a.priority);
  let exclusiveTaken = false;

  for (const p of promos) {
    const skip = (reason: string) => res.skipped.push({ promoId: p.id, name: p.name, reason });
    if (effectiveStatus(p, ctx.now) !== 'active') continue;
    if (dayKey(ctx.now) < dayKey(p.startAt)) continue;
    if (p.code && p.code.toLowerCase() !== (ctx.code || '').trim().toLowerCase()) continue;
    if (p.channels.length && !p.channels.includes(ctx.channel)) continue;
    if (p.branchIds.length && !p.branchIds.includes(ctx.branchId)) continue;
    if (p.weekdays?.length && !p.weekdays.includes(when.getDay())) continue;
    if (p.timeFrom && p.timeTo) {
      const hm = when.getHours() * 60 + when.getMinutes();
      const [fh, fm] = p.timeFrom.split(':').map(Number);
      const [th, tm] = p.timeTo.split(':').map(Number);
      if (hm < fh * 60 + fm || hm > th * 60 + tm) continue;
    }
    if (p.customerGroups.length && (!cust || !p.customerGroups.includes(cust.group))) { skip('Customer group not eligible'); continue; }
    if ((p.requireCustomer || p.action.type === 'event_entitlement' || p.action.type === 'coupon') && !cust) { skip('Needs a customer'); continue; }
    if (p.minLifetimeSpend && lifetime < p.minLifetimeSpend) { skip(`Lifetime spend below ${p.minLifetimeSpend}`); continue; }

    // scope: which lines count toward this promotion
    const inScope = lines.map((l, i) => {
      if (l.isFree) return false;
      const pr = prods.get(l.productId);
      if (!pr) return false;
      if (p.productIds?.length && !p.productIds.includes(l.productId)) return false;
      if (p.categories?.length && !p.categories.includes(pr.category)) return false;
      return true;
    });
    const scoped = lines.reduce((s, l, i) => s + (inScope[i] ? l.qty * l.unitPrice : 0), 0);
    const scopedQty = lines.reduce((s, l, i) => s + (inScope[i] ? l.qty : 0), 0);
    if (!scopedQty) continue;
    if (p.minOrder && subtotal < p.minOrder) { skip(`Order below ${p.minOrder}`); continue; }
    if (p.minQty && scopedQty < p.minQty) { skip(`Needs ${p.minQty}+ items`); continue; }

    // usage limits
    const u = promoUsage(d, p.id, ctx.customerId);
    if (p.limits.total != null && u.total >= p.limits.total) { skip('Total usage limit reached'); continue; }
    if (p.limits.perCustomer != null && ctx.customerId && u.perCustomer >= p.limits.perCustomer) { skip('Customer usage limit reached'); continue; }
    const budgetLeft = p.budget != null ? Math.max(0, p.budget - u.discount) : Infinity;
    const isDiscount = ['percent', 'fixed', 'bundle_price'].includes(p.action.type);
    if (isDiscount && budgetLeft <= 0) { skip('Budget exhausted'); continue; }
    if (isDiscount && exclusiveTaken) { skip('Blocked by an exclusive promotion'); continue; }

    const a = p.action;
    const ap: AppliedPromo = { promoId: p.id, name: p.name, discount: 0, bonusPoints: 0, entitlements: 0, freeItems: [] };
    const times = Math.max(1, p.limits.perOrder);

    if (a.type === 'percent' || a.type === 'fixed') {
      let disc = a.type === 'percent' ? scoped * ((a.value ?? 0) / 100) : Math.min(a.value ?? 0, scoped);
      disc = Math.min(disc, budgetLeft, scoped - res.lineDiscounts.reduce((s, x) => s + x, 0));
      disc = r2(Math.max(0, disc));
      if (disc <= 0) continue;
      ap.discount = disc;
      distribute(lines, inScope, res.lineDiscounts, disc);
    } else if (a.type === 'bundle_price') {
      const ids = a.bundleProductIds ?? [];
      if (!ids.length) continue;
      const sets = Math.min(...ids.map((id) => lines.filter((l) => l.productId === id && !l.isFree).reduce((s, l) => s + l.qty, 0)));
      const n = Math.min(sets, times);
      if (!n) continue;
      const normal = ids.reduce((s, id) => { const bp = prods.get(id); return s + (bp ? bp.channelPrices[ctx.channel] ?? bp.price : 0); }, 0);
      let disc = r2(Math.max(0, normal - (a.value ?? 0)) * n);
      disc = Math.min(disc, budgetLeft);
      if (disc <= 0) continue;
      ap.discount = disc;
      const bundleScope = lines.map((l) => ids.includes(l.productId) && !l.isFree);
      distribute(lines, bundleScope, res.lineDiscounts, disc);
    } else if (a.type === 'free_item') {
      if (!a.productId) continue;
      ap.freeItems.push({ productId: a.productId, qty: a.qty ?? 1 });
      res.freeLines.push({ productId: a.productId, qty: a.qty ?? 1, promoId: p.id });
    } else if (a.type === 'bonus_points') {
      if (a.bonusMode === 'multiplier') {
        if (!(a.value && a.value > 0)) continue;
        res.bonusMultiplier += a.value; // extra multiplier on base points, applied by the loyalty engine
      } else {
        ap.bonusPoints = a.perAmount ? Math.floor(subtotal / a.perAmount) * Math.round(a.value ?? 0) : Math.round(a.value ?? 0);
        res.bonusPoints += ap.bonusPoints;
        if (!ap.bonusPoints) continue;
      }
    } else if (a.type === 'event_entitlement') {
      const ev = d.events.find((e) => e.id === a.eventId);
      if (!ev || ev.status !== 'active') { skip('Event is not active'); continue; }
      const n = Math.min(a.maxPerOrder ?? 5, a.perAmount ? Math.floor(subtotal / a.perAmount) : a.qty ?? 1);
      if (n <= 0) { skip(`Spend ${a.perAmount} for an entitlement`); continue; }
      ap.entitlements = n;
      res.entitlements.push({ promoId: p.id, eventId: ev.id, count: n });
    } else if (a.type === 'coupon') {
      res.issueCoupons.push({ promoId: p.id, value: a.couponValue ?? 0, days: a.couponDays ?? 30 });
    }
    if (isDiscount && p.stacking === 'exclusive') exclusiveTaken = true;
    res.applied.push(ap);
  }
  res.orderDiscount = r2(res.lineDiscounts.reduce((s, x) => s + x, 0));
  return res;
}

function distribute(lines: CartLineIn[], scope: boolean[], out: number[], disc: number) {
  const base = lines.reduce((s, l, i) => s + (scope[i] ? l.qty * l.unitPrice - out[i] : 0), 0);
  if (base <= 0) return;
  let left = disc;
  const idx = scope.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  idx.forEach((i, n) => {
    const w = (lines[i].qty * lines[i].unitPrice - out[i]) / base;
    const share = n === idx.length - 1 ? left : r2(disc * w);
    out[i] = r2(out[i] + share);
    left = r2(left - share);
  });
}

/** Coupon eligibility for a cart → discount amount (0 if not applicable) */
export function couponDiscount(c: Coupon, subtotalAfterPromos: number): number {
  if (c.minOrder && subtotalAfterPromos < c.minOrder) return 0;
  return r2(c.kind === 'percent' ? subtotalAfterPromos * (c.value / 100) : Math.min(c.value, subtotalAfterPromos));
}
