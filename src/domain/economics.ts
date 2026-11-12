import type { ChannelCode, DB, ID, Order } from './types';
import type { Account } from './types';
import { balancesBetween, netDebit, roleCode, sumNetDebit } from './accounting';
import { dayKey, r2 } from '../lib/util';

export interface OrderEcon {
  orderId: ID; no: string; day: string; channel: ChannelCode; branchId: ID; customerId?: ID; units: number;
  gross: number; discount: number; returns: number; net: number; cogs: number; grossProfit: number;
  commission: number; paymentFee: number; shipping: number; channelCosts: number; contribution: number;
  feesFinal: boolean; platform: boolean;
}
export interface LineEcon {
  orderId: ID; day: string; channel: ChannelCode; branchId: ID; productId: ID; name: string; category: string; qty: number;
  net: number; cogs: number; feeShare: number; contribution: number;
}
export interface EconFilter { from?: string; to?: string; channels?: ChannelCode[]; branchIds?: ID[] }

const inRange = (o: Order, f: EconFilter) => {
  if (!o.recognizedAt) return false;
  const k = dayKey(o.recognizedAt);
  if (f.from && k < f.from) return false;
  if (f.to && k > f.to) return false;
  if (f.channels?.length && !f.channels.includes(o.channel)) return false;
  if (f.branchIds?.length && !f.branchIds.includes(o.branchId)) return false;
  return true;
};

export function computeEcon(d: DB, f: EconFilter = {}) {
  const orders: OrderEcon[] = [];
  const lines: LineEcon[] = [];
  const cat = new Map(d.products.map((p) => [p.id, p.category]));
  for (const o of d.orders) {
    if (!inRange(o, f)) continue;
    const v = 1 + o.vatRate;
    const gross = r2(o.subtotal / v);
    const discount = r2(o.discountTotal / v);
    const returns = r2(o.creditNoted / v);
    const net = r2(gross - discount - returns);
    let cogs = 0;
    for (const l of o.lines) cogs += l.cost - (l.qty ? (l.cost * l.restockedQty) / l.qty : 0);
    cogs = r2(cogs);
    const gp = r2(net - cogs);
    const fees = o.fees;
    const channelCosts = r2(fees.commission + fees.paymentFee + fees.shippingSubsidy);
    const day = dayKey(o.recognizedAt!);
    orders.push({
      orderId: o.id, no: o.no, day, channel: o.channel, branchId: o.branchId, customerId: o.customerId, units: o.lines.reduce((s, l) => s + l.qty - l.returnedQty, 0),
      gross, discount, returns, net, cogs, grossProfit: gp, commission: fees.commission, paymentFee: fees.paymentFee, shipping: fees.shippingSubsidy,
      channelCosts, contribution: r2(gp - channelCosts), feesFinal: o.collectedBy === 'merchant' || !fees.estimated, platform: o.collectedBy === 'platform',
    });
    const lineBase = o.lines.reduce((s, l) => s + (l.qty * l.unitPrice - l.discount), 0) || 1;
    for (const l of o.lines) {
      const keep = l.qty ? (l.qty - l.returnedQty) / l.qty : 0;
      const lnet = r2(((l.qty * l.unitPrice - l.discount) * keep) / v);
      const lcogs = r2(l.cost - (l.qty ? (l.cost * l.restockedQty) / l.qty : 0));
      const share = r2((channelCosts * (l.qty * l.unitPrice - l.discount)) / lineBase);
      lines.push({ orderId: o.id, day, channel: o.channel, branchId: o.branchId, productId: l.productId, name: l.name.replace(' (free)', ''), category: cat.get(l.productId) ?? '', qty: l.qty - l.returnedQty, net: lnet, cogs: lcogs, feeShare: share, contribution: r2(lnet - lcogs - share) });
    }
  }
  return { orders, lines };
}

export interface EconTotals {
  orders: number; units: number; gross: number; discount: number; returns: number; net: number; cogs: number; grossProfit: number;
  commission: number; paymentFee: number; shipping: number; channelCosts: number; contribution: number; provisionalOrders: number; platformOrders: number;
}
export const emptyTotals = (): EconTotals => ({ orders: 0, units: 0, gross: 0, discount: 0, returns: 0, net: 0, cogs: 0, grossProfit: 0, commission: 0, paymentFee: 0, shipping: 0, channelCosts: 0, contribution: 0, provisionalOrders: 0, platformOrders: 0 });
export function addEcon(t: EconTotals, e: OrderEcon) {
  t.orders++; t.units += e.units; t.gross += e.gross; t.discount += e.discount; t.returns += e.returns; t.net += e.net; t.cogs += e.cogs;
  t.grossProfit += e.grossProfit; t.commission += e.commission; t.paymentFee += e.paymentFee; t.shipping += e.shipping; t.channelCosts += e.channelCosts; t.contribution += e.contribution;
  if (e.platform) { t.platformOrders++; if (!e.feesFinal) t.provisionalOrders++; }
}
export function totalsOf(list: OrderEcon[]): EconTotals {
  const t = emptyTotals();
  for (const e of list) addEcon(t, e);
  for (const k of Object.keys(t) as (keyof EconTotals)[]) t[k] = r2(t[k]);
  return t;
}
export function groupEcon(list: OrderEcon[], key: (e: OrderEcon) => string): Record<string, EconTotals> {
  const m: Record<string, EconTotals> = {};
  for (const e of list) addEcon((m[key(e)] ||= emptyTotals()), e);
  for (const t of Object.values(m)) for (const k of Object.keys(t) as (keyof EconTotals)[]) t[k] = r2(t[k]);
  return m;
}
export interface LineTotals { qty: number; net: number; cogs: number; feeShare: number; contribution: number }
export function groupLines(list: LineEcon[], key: (e: LineEcon) => string): Record<string, LineTotals & { name?: string }> {
  const m: Record<string, LineTotals & { name?: string }> = {};
  for (const e of list) {
    const t = (m[key(e)] ||= { qty: 0, net: 0, cogs: 0, feeShare: 0, contribution: 0, name: e.name });
    t.qty += e.qty; t.net += e.net; t.cogs += e.cogs; t.feeShare += e.feeShare; t.contribution += e.contribution;
  }
  for (const t of Object.values(m)) { t.net = r2(t.net); t.cogs = r2(t.cogs); t.feeShare = r2(t.feeShare); t.contribution = r2(t.contribution); }
  return m;
}

/** Business-level costs that are not attributable to a single order, from the GL (classified by financial-statement line, not by hard-coded codes) */
export function businessCosts(d: DB, from?: string, to?: string) {
  const b = balancesBetween(d.journals, from, to);
  const sum = (pred: (a: Account) => boolean) => sumNetDebit(d, b, pred);
  const bySub = (code: string) => netDebit(b[code]);
  const waste = roleCode(d, 'waste'), adj = roleCode(d, 'inv_adjust');
  const opexAccts = (a: Account) => a.fsLine === 'opex' || a.fsLine === 'other_expense';
  return {
    waste: waste ? bySub(waste) : 0, adjustments: adj ? bySub(adj) : 0, opex: sum(opexAccts),
    marketing: bySub('6130'), rent: bySub('6200'), utilities: bySub('6210'), staff: bySub('6220'), other: bySub('6300'), bank: bySub('6400'),
  };
}

export interface Completeness { label: 'Final' | 'Provisional'; reasons: string[]; pctFinal: number }
export function completeness(d: DB, t: EconTotals): Completeness {
  const reasons: string[] = [];
  if (t.provisionalOrders) reasons.push(`${t.provisionalOrders} of ${t.platformOrders} marketplace/delivery orders still use ESTIMATED fees (settlement not yet received)`);
  const missingCost = d.orders.filter((o) => o.recognizedAt && o.lines.some((l) => l.cost <= 0 && !l.isFree)).length;
  if (missingCost) reasons.push(`${missingCost} orders contain lines with zero cost`);
  const pct = t.platformOrders ? (t.platformOrders - t.provisionalOrders) / t.platformOrders : 1;
  return { label: reasons.length ? 'Provisional' : 'Final', reasons, pctFinal: pct };
}
