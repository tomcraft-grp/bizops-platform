import type { Coupon, DB, ID, Order, PointEntry, RewardRedemption } from './types';
import { Ctx, audit, docNo, fail, nid } from './core';
import { addDays, r2 } from '../lib/util';

// ---------- customer value
export function orderNet(o: Order): number {
  return r2(o.total - o.creditNoted);
}
export function lifetimeSpendMap(d: DB): Record<ID, number> {
  const m: Record<ID, number> = {};
  for (const o of d.orders) {
    if (!o.customerId || !o.recognizedAt || o.status === 'cancelled') continue;
    m[o.customerId] = (m[o.customerId] || 0) + orderNet(o);
  }
  return m;
}
export function customerLifetimeSpend(d: DB, cid: ID): number {
  let s = 0;
  for (const o of d.orders) if (o.customerId === cid && o.recognizedAt && o.status !== 'cancelled') s += orderNet(o);
  return r2(s);
}
export function tierFor(d: DB, spend: number) {
  const tiers = [...d.loyalty.tiers].sort((a, b) => b.minSpend - a.minSpend);
  return tiers.find((t) => spend >= t.minSpend) ?? tiers[tiers.length - 1];
}

// ---------- ledger views
export function pointsMap(d: DB): Record<ID, number> {
  const m: Record<ID, number> = {};
  for (const e of d.pointsLedger) m[e.customerId] = (m[e.customerId] || 0) + e.points;
  return m;
}
export const pointsBalance = (d: DB, cid: ID) => d.pointsLedger.reduce((s, e) => (e.customerId === cid ? s + e.points : s), 0);
export function expiringSoon(d: DB, cid: ID, now: string, days = 60) {
  const lim = addDays(now, days).toISOString();
  return d.pointsLedger.filter((e) => e.customerId === cid && (e.remaining ?? 0) > 0 && e.expiresAt && e.expiresAt <= lim).reduce((s, e) => s + (e.remaining ?? 0), 0);
}

function add(d: DB, ctx: Ctx, e: Omit<PointEntry, 'id' | 'ts'>) {
  d.pointsLedger.push({ id: nid(d, 'PT'), ts: ctx.now, ...e });
}
function expiry(d: DB, ctx: Ctx) {
  return addDays(ctx.now, d.loyalty.expiryMonths * 30).toISOString();
}
/** consume points FIFO by expiry from the earn batches (the 'remaining' field) */
function consume(d: DB, cid: ID, pts: number) {
  let left = pts;
  const batches = d.pointsLedger.filter((e) => e.customerId === cid && (e.remaining ?? 0) > 0).sort((a, b) => (a.expiresAt || '9').localeCompare(b.expiresAt || '9'));
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, b.remaining ?? 0);
    b.remaining = (b.remaining ?? 0) - take;
    left -= take;
  }
}

/** Points on an order: line net × category multiplier ÷ baht-per-point × tier multiplier × (1+promo multiplier) */
export function earnPoints(d: DB, ctx: Ctx, o: Order, bonus: { multiplier: number; fixed: number }): number {
  if (!o.customerId) return 0;
  const cfg = d.loyalty;
  let base = 0;
  for (const l of o.lines) {
    if (l.isFree) continue;
    const p = d.products.find((x) => x.id === l.productId);
    const net = Math.max(0, l.qty * l.unitPrice - l.discount);
    base += (net / cfg.earnBahtPerPoint) * (cfg.categoryMultipliers[p?.category ?? ''] ?? 1);
  }
  const tier = tierFor(d, customerLifetimeSpend(d, o.customerId));
  const pts = Math.floor(base * tier.multiplier * (1 + bonus.multiplier));
  if (pts > 0) add(d, ctx, { customerId: o.customerId, points: pts, type: 'earn', refType: 'order', refId: o.id, note: `Order ${o.no}` + (bonus.multiplier ? ` (x${1 + bonus.multiplier} promo)` : ''), expiresAt: expiry(d, ctx), remaining: pts });
  if (bonus.fixed > 0) add(d, ctx, { customerId: o.customerId, points: bonus.fixed, type: 'bonus', refType: 'order', refId: o.id, note: `Promo bonus on ${o.no}`, expiresAt: expiry(d, ctx), remaining: bonus.fixed });
  return pts + bonus.fixed;
}
export function reversePoints(d: DB, ctx: Ctx, o: Order, fraction: number, reason: string) {
  if (!o.customerId || !o.pointsEarned) return;
  const already = d.pointsLedger.filter((e) => e.type === 'reverse' && e.refId === o.id).reduce((s, e) => s - e.points, 0);
  const want = Math.min(o.pointsEarned - already, Math.round(o.pointsEarned * fraction));
  const bal = pointsBalance(d, o.customerId);
  const pts = Math.max(0, Math.min(want, bal));
  if (pts <= 0) return;
  consume(d, o.customerId, pts);
  add(d, ctx, { customerId: o.customerId, points: -pts, type: 'reverse', refType: 'order', refId: o.id, note: `${reason} (${o.no})` });
}

export function adjustPoints(d: DB, ctx: Ctx, cid: ID, pts: number, reason: string) {
  if (!pts || !Number.isFinite(pts)) fail('INVALID', 'Enter a non-zero number of points');
  if (!reason.trim()) fail('REASON', 'A reason is required for manual adjustments');
  if (!d.customers.some((c) => c.id === cid)) fail('NOT_FOUND', 'Customer not found');
  if (pts < 0) {
    if (pointsBalance(d, cid) < -pts) fail('INSUFFICIENT_POINTS', 'Customer does not have enough points');
    consume(d, cid, -pts);
    add(d, ctx, { customerId: cid, points: pts, type: 'adjust', note: reason, by: ctx.userId });
  } else add(d, ctx, { customerId: cid, points: pts, type: 'adjust', note: reason, by: ctx.userId, expiresAt: expiry(d, ctx), remaining: pts });
  audit(d, ctx, 'points.adjust', 'customer', cid, `${pts > 0 ? '+' : ''}${pts} pts — ${reason}`, 'warn');
}

export function expirePoints(d: DB, ctx: Ctx): number {
  let n = 0;
  for (const e of d.pointsLedger.filter((x) => (x.remaining ?? 0) > 0 && x.expiresAt && x.expiresAt < ctx.now)) {
    add(d, ctx, { customerId: e.customerId, points: -(e.remaining ?? 0), type: 'expire', refId: e.id, note: `Expired batch ${e.id}` });
    e.remaining = 0;
    n++;
  }
  return n;
}

// ---------- rewards & coupons
export function issueCoupon(d: DB, ctx: Ctx, p: { customerId: ID; kind: 'percent' | 'fixed'; value: number; minOrder?: number; title: string; source: 'reward' | 'promo'; sourceId: ID; days: number }): Coupon {
  const n = (d.meta.seq['cpn'] = (d.meta.seq['cpn'] || 0) + 1);
  const c: Coupon = {
    id: nid(d, 'CP'), code: 'CP-' + (n + 4096).toString(36).toUpperCase(), customerId: p.customerId, kind: p.kind, value: p.value, minOrder: p.minOrder,
    title: p.title, status: 'issued', source: p.source, sourceId: p.sourceId, expiresAt: addDays(ctx.now, p.days).toISOString(), createdAt: ctx.now,
  };
  d.coupons.push(c);
  return c;
}

export function redeemReward(d: DB, ctx: Ctx, p: { customerId: ID; rewardId: ID; idempotencyKey?: string }): ID {
  const key = p.idempotencyKey ? `redeem:${p.idempotencyKey}` : undefined;
  if (key && d.meta.idem[key]) return d.meta.idem[key];
  const reward = d.rewards.find((r) => r.id === p.rewardId) || fail('NOT_FOUND', 'Reward not found');
  if (!reward.active) fail('INACTIVE', 'This reward is no longer available');
  if (reward.stock != null && reward.stock <= 0) fail('OUT_OF_STOCK', 'Reward is out of stock');
  const bal = pointsBalance(d, p.customerId);
  if (bal < reward.cost) fail('INSUFFICIENT_POINTS', `Needs ${reward.cost} points; balance is ${bal}`);
  consume(d, p.customerId, reward.cost);
  const id = nid(d, 'RR');
  add(d, ctx, { customerId: p.customerId, points: -reward.cost, type: 'redeem', refType: 'reward', refId: id, note: reward.name });
  if (reward.stock != null) reward.stock -= 1;
  let couponId: ID | undefined;
  if (reward.kind === 'coupon') {
    couponId = issueCoupon(d, ctx, { customerId: p.customerId, kind: reward.couponKind ?? 'fixed', value: reward.couponValue ?? 0, minOrder: reward.couponMinOrder, title: reward.name, source: 'reward', sourceId: reward.id, days: 60 }).id;
  }
  const code = couponId ? d.coupons.find((c) => c.id === couponId)!.code : 'RW-' + docNo(d, 'RWC', 4).slice(-4);
  const r: RewardRedemption = { id, customerId: p.customerId, rewardId: reward.id, points: reward.cost, ts: ctx.now, status: 'issued', couponId, code, idempotencyKey: p.idempotencyKey };
  d.rewardRedemptions.push(r);
  if (key) d.meta.idem[key] = id;
  return id;
}
export function fulfillRedemption(d: DB, ctx: Ctx, id: ID) {
  const r = d.rewardRedemptions.find((x) => x.id === id) || fail('NOT_FOUND', 'Redemption not found');
  if (r.status !== 'issued') fail('INVALID', `Already ${r.status}`);
  r.status = 'fulfilled';
}
export function cancelRedemption(d: DB, ctx: Ctx, id: ID, reason: string) {
  const r = d.rewardRedemptions.find((x) => x.id === id) || fail('NOT_FOUND', 'Redemption not found');
  if (r.status !== 'issued') fail('INVALID', `Cannot cancel a ${r.status} redemption`);
  if (r.couponId) {
    const c = d.coupons.find((x) => x.id === r.couponId);
    if (c && c.status === 'used') fail('INVALID', 'Coupon was already used');
    if (c) c.status = 'cancelled';
  }
  const reward = d.rewards.find((x) => x.id === r.rewardId);
  if (reward && reward.stock != null) reward.stock += 1;
  add(d, ctx, { customerId: r.customerId, points: r.points, type: 'restore', refType: 'reward', refId: r.id, note: `Cancelled: ${reason}`, expiresAt: expiry(d, ctx), remaining: r.points });
  r.status = 'cancelled';
  audit(d, ctx, 'reward.cancel', 'redemption', id, reason, 'warn');
}

/** Ledger reconciliation: balance == Σ remaining batches */
export function reconcilePoints(d: DB) {
  const bal = pointsMap(d);
  const rem: Record<ID, number> = {};
  for (const e of d.pointsLedger) if (e.remaining) rem[e.customerId] = (rem[e.customerId] || 0) + e.remaining;
  const diffs: { customerId: ID; balance: number; batches: number }[] = [];
  for (const cid of new Set([...Object.keys(bal), ...Object.keys(rem)])) {
    if ((bal[cid] || 0) !== (rem[cid] || 0)) diffs.push({ customerId: cid, balance: bal[cid] || 0, batches: rem[cid] || 0 });
  }
  return { checked: Object.keys(bal).length, diffs };
}
