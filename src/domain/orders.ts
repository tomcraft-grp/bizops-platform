import type { DB, ID, ModifierOption, Order, OrderLine, OrderStatus, OrderType, ChannelCode, PayMethod, ReturnDoc, Product } from './types';
import { Ctx, audit, docNo, fail, nid, product, order as getOrder } from './core';
import { cr, dr, invAccount, post, saleTax } from './accounting';
import { moveStock, onHand, reservedMap, bkey } from './inventory';
import { consumeRecipe } from './bom';
import { couponDiscount, evaluatePromotions } from './promotions';
import { earnPoints, issueCoupon, reversePoints } from './loyalty';
import { grantEntitlements } from './events';
import { allocatedMap, applyCredit, createReceipt, customerOutstanding, orderBalance, refundCash, refundToCredit } from './payments';
import { enqueueOrderPrints } from './printing';
import { CHANNELS, FLOWS } from './meta';
import { r2 } from '../lib/util';

export interface NewOrderLine {
  productId: ID; qty: number; modifiers?: { group: string; option: string }[]; note?: string; unitPrice?: number; externalSku?: string;
}
export interface NewOrderInput {
  channel: ChannelCode; branchId: ID; warehouseId?: ID; customerId?: ID; orderType?: OrderType; lines: NewOrderLine[];
  promoCode?: string; couponId?: ID; manualDiscount?: number; payments?: { method: PayMethod; amount: number; reference?: string }[];
  useCredit?: boolean; payLater?: boolean; externalId?: string; platformVoucher?: number; idempotencyKey?: string; note?: string;
  shipping?: Order['shipping']; tableNo?: string; skipStockCheck?: boolean; skipPromotions?: boolean;
}

export const sellable = (p: Product) => p.kind === 'resale' || p.kind === 'finished' || p.kind === 'menu';
export const isRecognized = (o: Order) => !!o.recognizedAt;

export function resolveModifiers(p: Product, sel: { group: string; option: string }[] = []) {
  const out: { group: string; option: string; priceDelta: number; opt: ModifierOption }[] = [];
  for (const s of sel) {
    const g = p.modifiers?.find((x) => x.name === s.group);
    const o = g?.options.find((x) => x.name === s.option);
    if (g && o) out.push({ group: g.name, option: o.name, priceDelta: o.priceDelta, opt: o });
  }
  return out;
}
export const unitPriceFor = (p: Product, ch: ChannelCode) => p.channelPrices[ch] ?? p.price;

export function createOrder(d: DB, ctx: Ctx, input: NewOrderInput): ID {
  const idemKey = input.idempotencyKey ? 'order:' + input.idempotencyKey : undefined;
  if (idemKey && d.meta.idem[idemKey]) return d.meta.idem[idemKey];
  if (input.externalId && d.orders.some((o) => o.channel === input.channel && o.externalId === input.externalId)) {
    fail('DUPLICATE_EXTERNAL', `Order ${input.externalId} was already imported for ${input.channel}`);
  }
  const branch = d.branches.find((b) => b.id === input.branchId) || fail('INVALID', 'Branch is required');
  const warehouseId = input.warehouseId ?? branch!.defaultWarehouseId;
  const chMeta = CHANNELS[input.channel];
  if (!input.lines.length) fail('EMPTY_CART', 'The cart is empty');

  // ---- price lines
  const reserved = reservedMap(d);
  const lines: OrderLine[] = [];
  const mods: Record<string, ModifierOption[]> = {};
  for (const il of input.lines) {
    if (!(il.qty > 0)) fail('INVALID', 'Quantity must be positive');
    const p = product(d, il.productId);
    if (!sellable(p)) fail('NOT_SELLABLE', `${p.name} is not a sellable product`);
    if (!p.active && !input.skipStockCheck) fail('INACTIVE', `${p.name} is inactive`);
    const rm = resolveModifiers(p, il.modifiers);
    const delta = rm.reduce((s, m) => s + m.priceDelta, 0);
    if (!input.skipStockCheck && !d.org.allowNegativeStock && (p.kind === 'resale' || p.kind === 'finished')) {
      const avail = onHand(d, warehouseId, p.id) - (chMeta.flow === 'pos' ? 0 : reserved[bkey(warehouseId, p.id)] || 0);
      const already = lines.filter((x) => x.productId === p.id).reduce((s, x) => s + x.qty, 0);
      if (avail < il.qty + already) fail('INSUFFICIENT_STOCK', `Not enough ${p.name} available (${Math.max(0, avail)} ${p.unit})`);
    }
    const id = nid(d, 'OL');
    mods[id] = rm.map((m) => m.opt);
    lines.push({
      id, productId: p.id, name: p.name, sku: p.sku, qty: il.qty, unitPrice: r2(il.unitPrice ?? unitPriceFor(p, input.channel) + delta),
      modifiers: rm.map(({ group, option, priceDelta }) => ({ group, option, priceDelta })), note: il.note, discount: 0,
      cost: 0, costMaterials: 0, costConversion: 0, station: p.station ?? null, kds: p.station ? 'new' : undefined, returnedQty: 0, restockedQty: 0, externalSku: il.externalSku,
    });
  }

  // ---- promotions & coupon
  const cart = lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice }));
  const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  const pr = input.skipPromotions
    ? { applied: [], lineDiscounts: lines.map(() => 0), orderDiscount: 0, bonusPoints: 0, bonusMultiplier: 0, entitlements: [], freeLines: [], couponDiscount: 0, skipped: [], issueCoupons: [] }
    : evaluatePromotions(d, cart, { channel: input.channel, branchId: input.branchId, customerId: input.customerId, now: ctx.now, code: input.promoCode, couponId: input.couponId, orderType: input.orderType });
  lines.forEach((l, i) => (l.discount = pr.lineDiscounts[i]));
  for (const f of pr.freeLines) {
    const p = product(d, f.productId);
    const id = nid(d, 'OL');
    mods[id] = [];
    lines.push({ id, productId: p.id, name: p.name + ' (free)', sku: p.sku, qty: f.qty, unitPrice: 0, modifiers: [], discount: 0, isFree: true, promoId: f.promoId, cost: 0, costMaterials: 0, costConversion: 0, station: p.station ?? null, kds: p.station ? 'new' : undefined, returnedQty: 0, restockedQty: 0 });
  }
  let extra = 0;
  let couponId: ID | undefined;
  if (input.couponId) {
    const c = d.coupons.find((x) => x.id === input.couponId) || fail('NOT_FOUND', 'Coupon not found');
    if (c!.status !== 'issued') fail('COUPON_INVALID', `Coupon is ${c!.status}`);
    if (c!.expiresAt < ctx.now) fail('COUPON_INVALID', 'Coupon has expired');
    if (input.customerId && c!.customerId !== input.customerId) fail('COUPON_INVALID', 'Coupon belongs to another customer');
    const base = subtotal - pr.orderDiscount;
    const cd = couponDiscount(c!, base);
    if (cd <= 0) fail('COUPON_INVALID', c!.minOrder ? `Coupon needs a minimum order of ${c!.minOrder}` : 'Coupon has no value on this order');
    extra += cd;
    couponId = c!.id;
  }
  const manual = r2(Math.max(0, input.manualDiscount ?? 0));
  if (manual > subtotal - pr.orderDiscount - extra + 0.001) fail('INVALID', 'Discount exceeds the order value');
  extra += manual;
  if (extra > 0) {
    const real = lines.filter((l) => !l.isFree);
    const base = real.reduce((s, l) => s + l.qty * l.unitPrice - l.discount, 0);
    let left = r2(extra);
    real.forEach((l, i) => {
      const share = i === real.length - 1 ? left : r2((extra * (l.qty * l.unitPrice - l.discount)) / (base || 1));
      l.discount = r2(l.discount + share);
      left = r2(left - share);
    });
  }
  const discountTotal = r2(lines.reduce((s, l) => s + l.discount, 0));
  const total = r2(subtotal - discountTotal);

  // ---- customer & credit
  if (input.customerId && !d.customers.some((c) => c.id === input.customerId)) fail('NOT_FOUND', 'Customer not found');
  const payNow = r2((input.payments ?? []).reduce((s, p) => s + p.amount, 0));
  const cust = input.customerId ? d.customers.find((c) => c.id === input.customerId) : undefined;
  if (chMeta.collectedBy === 'merchant' && payNow < total - 0.004 && !input.useCredit) {
    const unpaid = r2(total - payNow);
    if (input.channel === 'POS' && !cust) fail('UNDERPAID', 'Payment is less than the total. Select a customer to leave the balance on account.');
    if (cust && (input.payLater || input.channel === 'POS')) {
      const out = customerOutstanding(d, cust.id);
      if (out + unpaid > cust.creditLimit + 0.004) fail('CREDIT_LIMIT', `Credit limit exceeded: outstanding ${out} + ${unpaid} > limit ${cust.creditLimit}`);
    }
  }

  // ---- fees estimate (platform channels)
  const acct = d.channelAccounts.find((a) => a.channel === input.channel);
  const fees = acct && chMeta.collectedBy === 'platform'
    ? { commission: r2((total * acct.commissionPct) / 100), paymentFee: r2((total * acct.paymentFeePct) / 100), shippingSubsidy: chMeta.flow === 'retail' ? acct.shippingSubsidy : 0, estimated: true }
    : { commission: 0, paymentFee: 0, shippingSubsidy: 0, estimated: false };

  const id = nid(d, 'O');
  const tax = saleTax(d, ctx.now);
  const o: Order = {
    id, no: docNo(d, ({ POS: 'POS', LINE: 'LIN', SHOPEE: 'SHO', LAZADA: 'LAZ', TIKTOK: 'TIK', LINEMAN: 'LMN' } as Record<string, string>)[input.channel]), channel: input.channel, branchId: input.branchId, warehouseId, customerId: input.customerId,
    externalId: input.externalId, orderType: input.orderType ?? (input.channel === 'POS' ? 'takeaway' : input.channel === 'LINEMAN' ? 'delivery' : 'online'),
    status: 'new', statusLog: [{ ts: ctx.now, status: 'new', by: ctx.userId }], createdAt: ctx.now, lines, subtotal, discountTotal, total,
    platformVoucher: input.platformVoucher ?? 0, vatRate: tax.rate, taxCode: tax.code, taxRuleVersion: tax.version, collectedBy: chMeta.collectedBy, payLater: input.payLater,
    promotions: pr.applied, couponId, pointsEarned: 0, bonusMult: pr.bonusMultiplier, bonusFixed: pr.bonusPoints, fees, creditNoted: 0, refundsPaid: 0,
    idempotencyKey: input.idempotencyKey, note: input.note, createdBy: ctx.userId, shipping: input.shipping, tableNo: input.tableNo,
  };
  d.orders.push(o);
  if (idemKey) d.meta.idem[idemKey] = id;
  for (const a of pr.applied) {
    d.redemptions.push({ id: nid(d, 'PX'), promoId: a.promoId, orderId: id, customerId: input.customerId, ts: ctx.now, discount: a.discount, bonusPoints: a.bonusPoints, entitlements: a.entitlements });
  }
  if (couponId) {
    const c = d.coupons.find((x) => x.id === couponId)!;
    c.status = 'used';
    c.usedOrderId = id;
  }
  // coupons promised by promotions are issued at recognition; remember them on the applied promo
  for (const ic of pr.issueCoupons) {
    const a = o.promotions.find((x) => x.promoId === ic.promoId);
    if (a) a.pendingCoupon = { value: ic.value, days: ic.days };
  }
  if (input.manualDiscount && manual > 0) audit(d, ctx, 'order.manual_discount', 'order', id, `${o.no}: manual discount ${manual}`, 'warn');

  // ---- fulfilment
  if (chMeta.flow === 'pos') recognize(d, ctx, o, 'completed');
  if (!ctx.seed) enqueueOrderPrints(d, ctx, o);

  // ---- payments
  if (input.useCredit && o.customerId) {
    const bal = orderBalance(o, 0);
    try { applyCredit(d, ctx, { customerId: o.customerId, orderId: id, amount: bal }); } catch { /* no credit available */ }
  }
  for (const pay of input.payments ?? []) {
    const bal = orderBalance(o, allocatedMap(d)[id] || 0);
    if (bal <= 0.004) break;
    const amt = r2(Math.min(pay.amount, bal));
    if (amt > 0) createReceipt(d, ctx, { customerId: input.customerId, amount: amt, method: pay.method, reference: pay.reference, allocations: [{ orderId: id, amount: amt }] });
  }
  return id;
}

/** Revenue + stock + cost recognition. Single transaction → balanced journal. */
function recognize(d: DB, ctx: Ctx, o: Order, status: OrderStatus) {
  if (o.recognizedAt) return;
  let materialsTotal = 0, conversionTotal = 0;
  const invCredits: Record<string, number> = {};
  for (const l of o.lines) {
    const p = product(d, l.productId);
    if (p.kind === 'menu') {
      const mods = resolveModifiers(p, l.modifiers.map((m) => ({ group: m.group, option: m.option }))).map((m) => m.opt);
      const r = consumeRecipe(d, ctx, p, l.qty, o.warehouseId, o.id, mods);
      l.costMaterials = r.materials;
      l.costConversion = r.conversion;
      l.bom = r.ref;
      for (const [a, v] of Object.entries(r.byAcct)) invCredits[a] = (invCredits[a] || 0) + v;
    } else {
      const m = moveStock(d, ctx, { productId: p.id, warehouseId: o.warehouseId, qty: -l.qty, type: 'sale', refType: 'order', refId: o.id, note: o.no });
      l.costMaterials = -m.value;
      l.costConversion = 0;
      const a = invAccount(p.kind);
      invCredits[a] = (invCredits[a] || 0) + -m.value;
    }
    l.cost = r2(l.costMaterials + l.costConversion);
    materialsTotal += l.costMaterials;
    conversionTotal += l.costConversion;
  }
  // loyalty before recognition so tier reflects history only
  if (o.customerId) {
    o.pointsEarned = earnPoints(d, ctx, o, { multiplier: o.bonusMult ?? 0, fixed: o.bonusFixed ?? 0 });
    for (const a of o.promotions) {
      const pm = d.promotions.find((x) => x.id === a.promoId);
      if (a.entitlements && pm?.action.eventId) grantEntitlements(d, ctx, { eventId: pm.action.eventId, customerId: o.customerId, orderId: o.id, promoId: pm.id, count: a.entitlements });
      const pc = a.pendingCoupon;
      if (pc && pm) {
        const c = issueCoupon(d, ctx, { customerId: o.customerId, kind: 'fixed', value: pc.value, title: pm.name, source: 'promo', sourceId: pm.id, days: pc.days });
        (a.couponIds ||= []).push(c.id);
        a.pendingCoupon = undefined;
      }
    }
  }
  const vat = o.vatRate;
  const grossEx = r2(o.subtotal / (1 + vat));
  const discEx = r2(o.discountTotal / (1 + vat));
  const vatAmt = r2(o.total + discEx - grossEx);
  const ar = o.collectedBy === 'platform' ? 'platform_ar' : 'ar';
  post(d, ctx, {
    memo: `Sale ${o.no} (${o.channel})`, refType: 'order', refId: o.id, dim: { branchId: o.branchId, channel: o.channel },
    lines: [
      dr(ar, o.total), dr('sales_discount', discEx), cr('sales', grossEx), cr('output_vat', vatAmt),
      dr('cogs', materialsTotal + conversionTotal), ...Object.entries(invCredits).map(([a, v]) => cr(a, v)), cr('conversion_absorbed', conversionTotal),
    ],
  });
  o.taxBase = r2(grossEx - discEx);
  o.vatAmount = vatAmt;
  o.recognizedAt = ctx.now;
  o.status = status;
  o.statusLog.push({ ts: ctx.now, status, by: ctx.userId });
}

export function nextStatuses(o: Order): OrderStatus[] {
  if (['cancelled', 'returned', 'completed'].includes(o.status)) return [];
  const flow = FLOWS[CHANNELS[o.channel].flow];
  const i = flow.indexOf(o.status);
  return i >= 0 && i < flow.length - 1 ? [flow[i + 1]] : [];
}

export function advanceOrder(d: DB, ctx: Ctx, id: ID, note?: string, shipping?: Order['shipping']): OrderStatus {
  const o = getOrder(d, id);
  const next = nextStatuses(o)[0] || fail('INVALID', `Order is ${o.status}; nothing to advance`);
  if (shipping) o.shipping = { ...o.shipping, ...shipping };
  const meta = CHANNELS[o.channel];
  if (meta.recognizeAt === next) recognize(d, ctx, o, next);
  else {
    o.status = next;
    o.statusLog.push({ ts: ctx.now, status: next, by: ctx.userId, note });
  }
  if (next === 'completed') for (const l of o.lines) if (l.kds && l.kds !== 'done') l.kds = 'done';
  return o.status;
}

export function cancelOrder(d: DB, ctx: Ctx, id: ID, reason: string) {
  const o = getOrder(d, id);
  if (!reason.trim()) fail('REASON', 'A cancellation reason is required');
  if (o.recognizedAt) fail('USE_RETURN', 'This order has already shipped/been served — process a return instead');
  if (['cancelled', 'completed'].includes(o.status)) fail('INVALID', `Order is already ${o.status}`);
  // paid before fulfilment → move payments to customer credit so no money is lost
  const alloc = allocatedMap(d)[id] || 0;
  if (alloc > 0.004) {
    if (!o.customerId) fail('NEEDS_CUSTOMER', 'A paid order without a customer must be refunded manually before cancelling');
    const paid = d.allocations.filter((a) => a.orderId === id && a.active && a.amount > 0);
    for (const a of paid) d.allocations.push({ id: nid(d, 'AL'), receiptId: a.receiptId, orderId: id, amount: -a.amount, ts: ctx.now, active: true, kind: 'reversal' });
    post(d, ctx, { memo: `Cancelled ${o.no}: payment moved to customer credit`, refType: 'cancel_credit', refId: id, lines: [dr('ar', alloc), cr('customer_credit', alloc)] });
  }
  d.redemptions = d.redemptions.filter((r) => r.orderId !== id); // frees promo usage & budget
  if (o.couponId) { const c = d.coupons.find((x) => x.id === o.couponId); if (c) { c.status = 'issued'; c.usedOrderId = undefined; } }
  o.status = 'cancelled';
  o.cancelledReason = reason;
  o.statusLog.push({ ts: ctx.now, status: 'cancelled', by: ctx.userId, note: reason });
  audit(d, ctx, 'order.cancel', 'order', id, `${o.no}: ${reason}`, 'warn');
}

export function returnOrder(
  d: DB, ctx: Ctx,
  p: { orderId: ID; lines: { lineId: ID; qty: number; restock: boolean }[]; reason: string; refund: 'none' | 'cash' | 'transfer' | 'credit' | 'platform' },
): ID {
  const o = getOrder(d, p.orderId);
  if (!o.recognizedAt) fail('INVALID', 'Order has not shipped yet — cancel it instead');
  if (!p.reason.trim()) fail('REASON', 'A return reason is required');
  const lines = p.lines.filter((l) => l.qty > 0);
  if (!lines.length) fail('INVALID', 'Select at least one item to return');
  let amount = 0, costRev = 0;
  const debit: Record<string, number> = {};
  for (const rl of lines) {
    const l = o.lines.find((x) => x.id === rl.lineId) || fail('NOT_FOUND', 'Line not found');
    if (rl.qty > l!.qty - l!.returnedQty + 1e-9) fail('OVER_RETURN', `${l!.name}: only ${l!.qty - l!.returnedQty} left to return`);
    const unitNet = l!.qty ? l!.unitPrice - l!.discount / l!.qty : 0;
    amount += rl.qty * unitNet;
    l!.returnedQty += rl.qty;
    const p2 = product(d, l!.productId);
    if (rl.restock && p2.kind !== 'menu') {
      const cost = r2((l!.cost * rl.qty) / l!.qty);
      moveStock(d, ctx, { productId: p2.id, warehouseId: o.warehouseId, qty: rl.qty, type: 'return_in', refType: 'return', refId: o.id, value: cost, note: `Return ${o.no}` });
      l!.restockedQty += rl.qty;
      costRev += cost;
      const a = invAccount(p2.kind);
      debit[a] = (debit[a] || 0) + cost;
    }
  }
  amount = r2(amount);
  costRev = r2(costRev);
  const net = r2(amount / (1 + o.vatRate));
  const vatAmt = r2(amount - net);
  const ar = o.collectedBy === 'platform' ? 'platform_ar' : 'ar';
  post(d, ctx, {
    memo: `Return/credit note on ${o.no}: ${p.reason}`, refType: 'return', refId: o.id, dim: { branchId: o.branchId, channel: o.channel },
    lines: [dr('sales_returns', net), dr('output_vat', vatAmt), cr(ar, amount), ...Object.entries(debit).map(([a, v]) => dr(a, v)), cr('cogs', costRev)],
  });
  o.creditNoted = r2(o.creditNoted + amount);
  reversePoints(d, ctx, o, o.total ? amount / o.total : 0, 'Return');
  if (o.lines.every((l) => l.returnedQty >= l.qty - 1e-9)) {
    o.status = 'returned';
    o.statusLog.push({ ts: ctx.now, status: 'returned', by: ctx.userId, note: p.reason });
  }
  // refund of any overpayment created by the credit note
  if (o.collectedBy === 'merchant' && p.refund !== 'none' && p.refund !== 'platform') {
    const bal = orderBalance(o, allocatedMap(d)[o.id] || 0);
    const refundable = r2(Math.max(0, -bal));
    if (refundable > 0.004) {
      if (p.refund === 'credit') refundToCredit(d, ctx, o.id, refundable);
      else refundCash(d, ctx, o.id, refundable, p.refund);
    }
  }
  const id = nid(d, 'RT');
  const doc: ReturnDoc = {
    id, no: docNo(d, 'RTN'), orderId: o.id, ts: ctx.now, lines, amount, netAmount: net, vatAmount: vatAmt, costReversed: costRev, reason: p.reason,
    refund: { method: p.refund, amount: o.collectedBy === 'merchant' && p.refund !== 'none' ? amount : 0 }, createdBy: ctx.userId,
  };
  d.returns.push(doc);
  audit(d, ctx, 'order.return', 'order', o.id, `${o.no}: returned ${amount} — ${p.reason}`, 'warn');
  return id;
}

// ---------- KDS
export function setKds(d: DB, ctx: Ctx, orderId: ID, lineId: ID, status: 'new' | 'preparing' | 'ready' | 'done') {
  const o = getOrder(d, orderId);
  const l = o.lines.find((x) => x.id === lineId) || fail('NOT_FOUND', 'Line not found');
  if (!l!.kds) fail('INVALID', 'Line is not a prepared item');
  l!.kds = status;
  const meta = CHANNELS[o.channel];
  if (meta.flow === 'food') {
    if (status === 'preparing' && o.status === 'new') advanceOrder(d, ctx, orderId);
    const prep = o.lines.filter((x) => x.kds);
    if (o.status === 'preparing' && prep.every((x) => x.kds === 'ready' || x.kds === 'done')) advanceOrder(d, ctx, orderId);
  }
}
export function kdsAllDone(d: DB, ctx: Ctx, orderId: ID) {
  const o = getOrder(d, orderId);
  for (const l of o.lines) if (l.kds) setKds(d, ctx, orderId, l.id, 'done');
}

export function orderProfitInputs(o: Order) {
  return { cost: r2(o.lines.reduce((s, l) => s + l.cost, 0)) };
}

/** Read-only price quote used by POS/LIFF before checkout (same rules as createOrder). */
export function quoteOrder(
  d: DB, p: { channel: ChannelCode; branchId: ID; customerId?: ID; lines: NewOrderLine[]; promoCode?: string; couponId?: ID; manualDiscount?: number; now: string },
) {
  const lines = p.lines.map((il) => {
    const pr = d.products.find((x) => x.id === il.productId)!;
    const delta = resolveModifiers(pr, il.modifiers).reduce((s, m) => s + m.priceDelta, 0);
    return { productId: il.productId, qty: il.qty, unitPrice: r2(il.unitPrice ?? unitPriceFor(pr, p.channel) + delta) };
  });
  const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  const res = evaluatePromotions(d, lines, { channel: p.channel, branchId: p.branchId, customerId: p.customerId, now: p.now, code: p.promoCode, couponId: p.couponId });
  let couponDisc = 0;
  let couponNote = '';
  if (p.couponId) {
    const c = d.coupons.find((x) => x.id === p.couponId);
    if (c && c.status === 'issued' && c.expiresAt >= p.now) {
      couponDisc = couponDiscount(c, subtotal - res.orderDiscount);
      if (!couponDisc) couponNote = c.minOrder ? `Coupon needs a minimum order of ${c.minOrder}` : 'Coupon has no value here';
    } else couponNote = 'Coupon is not valid';
  }
  const manual = Math.min(r2(Math.max(0, p.manualDiscount ?? 0)), Math.max(0, subtotal - res.orderDiscount - couponDisc));
  const total = r2(subtotal - res.orderDiscount - couponDisc - manual);
  return { lines, subtotal, promoDiscount: res.orderDiscount, couponDiscount: couponDisc, couponNote, manual, total, applied: res.applied, freeLines: res.freeLines, entitlements: res.entitlements, bonusPoints: res.bonusPoints, bonusMultiplier: res.bonusMultiplier, skipped: res.skipped, lineDiscounts: res.lineDiscounts };
}
