import type { CostElems, DB, ID, ProductionOrder } from './types';
import { saleTax } from './accounting';
import { bomCost, bomForProduct, knownCost, versionAt } from './bom';
import { computeEcon, type LineEcon } from './economics';
import { orderTotals, shortages } from './production';
import { r2, r3 } from '../lib/util';

// Cost and profit figures of the production module: read-only, nothing here posts. null = not known; a missing cost is never shown as 0.

type Maybe = number | null;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const z = (n: number) => r2(n) + 0; // no −0
const add = (...a: Maybe[]): Maybe => (a.some((x) => x == null) ? null : z(a.reduce<number>((s, x) => s + x!, 0)));
const times = (a: Maybe | undefined, q: number): Maybe => (a == null ? null : a * q);
const round = (a: Maybe): Maybe => (a == null ? null : z(a));

// ---------- product
/** The costs of one product side by side. `average`: what the stock is carried at; `lastActual`: the latest production receipt that was not reversed. */
export function productCost(d: DB, productId: ID) {
  const p = d.products.find((x) => x.id === productId), bom = bomForProduct(d, productId);
  const v = bom && versionAt(bom, new Date().toISOString());
  const cost = v ? bomCost(d, v) : null;
  const k = p && p.kind !== 'menu' ? knownCost(d, productId) : null;
  let lastActual: Maybe = null, lastActualAt: string | null = null;
  const seen = (ts: string, unit: number) => { if (unit > 0 && (lastActualAt == null || ts >= lastActualAt)) { lastActual = unit; lastActualAt = ts; } };
  for (const o of d.productionOrders) {
    if (o.productId !== productId) continue;
    for (const b of o.batches) if (b.outputQty > 0) seen(b.ts, b.unitCost);
    for (const r of o.receipts ?? []) if (!r.reversal && r.good > 0) seen(r.ts, r.unitCost);
  }
  return {
    productId, bomId: bom?.id ?? null, version: v?.version ?? null, estimated: cost?.perUnit ?? null, standard: p && p.stdCost > 0 ? p.stdCost : null,
    average: k?.source === 'average' ? z(k.cost!) : null, lastActual: lastActual as Maybe, lastActualAt: lastActualAt as string | null, missing: cost?.missing ?? [],
  };
}

// ---------- order
export interface Variances { materialPrice: Maybe; materialUsage: Maybe; labor: Maybe; overhead: Maybe; waste: Maybe; total: Maybe }
const perUnit = (po: ProductionOrder): Maybe => {
  const e = po.estimate;
  return !e || e.materialsPerUnit == null || e.laborPerUnit == null || e.overheadPerUnit == null ? null : e.materialsPerUnit + e.laborPerUnit + e.overheadPerUnit;
};
/**
 * Analysis only (what is posted is `leftover`). For a finished order, against the estimate for the units really made (good + rejected):
 *   price = Σ actual qty × (actual − estimated unit cost), usage = Σ (actual qty − estimated qty) × estimated unit cost, labour and overhead = actual − estimated,
 *   waste = rejected units × estimated cost. Together they are actual cost − estimated cost of the good units. Null while the order is open: material in WIP is not over-use.
 */
function variancesOf(po: ProductionOrder, t: ReturnType<typeof orderTotals>): Variances | null {
  const e = po.estimate;
  if (po.status !== 'completed' || !e || t.units <= 0) return null;
  let price: Maybe = null, usage: Maybe = null;
  if (e.lines && e.lines.every((l) => l.unitCost != null)) {
    const est = new Map<ID, { qty: number; unit: number }>(), got = new Map<ID, { qty: number; value: number }>();
    for (const l of e.lines) est.set(l.productId, { qty: (est.get(l.productId)?.qty ?? 0) + l.qty, unit: l.unitCost! });
    for (const i of po.issues ?? []) if (!i.reversal) for (const l of i.lines) { const g = got.get(l.productId) ?? { qty: 0, value: 0 }; got.set(l.productId, { qty: g.qty + l.qty, value: g.value + l.value }); }
    for (const i of po.returns ?? []) if (!i.reversal) for (const l of i.lines) { const g = got.get(l.productId) ?? { qty: 0, value: 0 }; got.set(l.productId, { qty: g.qty - l.qty, value: g.value - l.value }); }
    price = 0; usage = 0;
    for (const [pid, g] of got) {
      const x = est.get(pid);
      if (!x) { usage += g.value; continue; } // not in the BOM: all of it is extra use
      price += g.value - g.qty * x.unit;
      usage += (g.qty - x.qty * t.units) * x.unit;
    }
    for (const [pid, x] of est) if (!got.has(pid)) usage -= x.qty * t.units * x.unit;
  }
  const labor = e.laborPerUnit == null ? null : t.labor - e.laborPerUnit * t.units, overhead = e.overheadPerUnit == null ? null : t.overhead - e.overheadPerUnit * t.units;
  const waste = t.rejected ? times(perUnit(po), t.rejected) : 0;
  return { materialPrice: round(price), materialUsage: round(usage), labor: round(labor), overhead: round(overhead), waste: round(waste), total: add(price, usage, labor, overhead, waste) };
}
/** Estimated (for the planned quantity), standard and actual cost of an order. `waste` = what was posted as waste; `leftover` = what was posted to the variance accounts. */
export function orderCost(d: DB, po: ProductionOrder) {
  const t = orderTotals(po), e = po.estimate, std = d.products.find((p) => p.id === po.productId)?.stdCost ?? 0;
  const est = e ? { materials: round(times(e.materialsPerUnit, po.plannedQty)), labor: round(times(e.laborPerUnit, po.plannedQty)), overhead: round(times(e.overheadPerUnit, po.plannedQty)) } : null;
  return {
    estimated: est && { ...est, total: add(est.materials, est.labor, est.overhead) }, estimatedPerUnit: round(perUnit(po)),
    standard: std > 0 ? z(std * po.plannedQty) : null, standardPerUnit: std > 0 ? std : null,
    actual: { materials: t.materials, labor: t.labor, overhead: t.overhead, total: t.charged }, actualPerUnit: t.unitCost,
    variances: variancesOf(po, t), waste: z(t.rejectedValue + t.lossValue), leftover: t.variance as CostElems, wip: t.wipTotal,
  };
}

// ---------- profit
export type ProfitCostSource = 'average' | 'actual' | 'estimated' | 'standard';
/**
 * Unit profit at today's list price (prices include VAT, at the rate a sale takes today) and what was really sold in the period (order lines: net of VAT, discounts and
 * returns, with the cost recorded at the sale). The unit cost is what a sale would book: stock average, else last actual, else BOM estimate, else standard.
 * Pass `lines` (computeEcon(d, { from, to }).lines) when asking for many products.
 */
export function profitability(d: DB, productId: ID, from?: string, to?: string, lines?: LineEcon[]) {
  const p = d.products.find((x) => x.id === productId), c = productCost(d, productId), rate = saleTax(d, new Date().toISOString()).rate;
  const options: [ProfitCostSource, Maybe][] = [['average', c.average], ['actual', c.lastActual], ['estimated', c.estimated], ['standard', c.standard]];
  const [costSource, cost] = options.find(([, x]) => x != null && x > 0) ?? [null, null];
  const price = p && p.price > 0 ? p.price : null, net = price == null ? null : price / (1 + rate), gp = net == null || cost == null ? null : net - cost;
  const ls = (lines ?? computeEcon(d, { from, to }).lines).filter((l) => l.productId === productId);
  let sold: { qty: number; net: number; cogs: Maybe; gp: Maybe; margin: Maybe; contribution: Maybe; unitNet: Maybe } | null = null;
  if (ls.length) {
    const s = (f: (l: LineEcon) => number) => ls.reduce((a, l) => a + f(l), 0);
    const qty = s((l) => l.qty), snet = z(s((l) => l.net)), known = !ls.some((l) => l.qty > 0 && l.cogs <= 0); // goods that left without a recorded cost
    const cogs = known ? z(s((l) => l.cogs)) : null, g = cogs == null ? null : z(snet - cogs);
    sold = { qty, net: snet, cogs, gp: g, margin: g == null || !(snet > 0) ? null : r4(g / snet), contribution: cogs == null ? null : z(s((l) => l.contribution)), unitNet: qty > 0 ? z(snet / qty) : null };
  }
  return { productId, price, taxRate: rate, netPrice: round(net), cost, costSource, gpPerUnit: round(gp), margin: gp == null ? null : r4(gp / net!), sold };
}

// ---------- all of it
/** Figures of the overview. Estimated, actual and variance compare the same orders: completed ones whose estimate is known (the others are in `completedWithoutEstimate`). */
export function overview(d: DB) {
  let open = 0, inProgress = 0, completed = 0, outputUnits = 0, est = 0, act = 0, n = 0;
  const shortageOrders: ID[] = [];
  for (const o of d.productionOrders) {
    const t = orderTotals(o);
    outputUnits += t.good;
    if (o.status === 'cancelled') continue;
    if (o.status !== 'completed') {
      open++;
      if (o.status === 'in_progress' || o.status === 'partially_completed') inProgress++;
      if (shortages(d, o).length) shortageOrders.push(o.id);
      continue;
    }
    completed++;
    const per = perUnit(o);
    if (per == null) continue;
    n++; est += per * t.good; act += t.charged;
  }
  return {
    boms: d.boms.length, activeBoms: d.boms.filter((b) => (b.status ?? 'active') === 'active' && b.versions.some((v) => v.status === 'active')).length,
    open, inProgress, completed, outputUnits: r3(outputUnits), estimatedCost: n ? z(est) : null, actualCost: n ? z(act) : null, variance: n ? z(act - est) : null,
    completedWithoutEstimate: completed - n, shortageOrders,
  };
}
