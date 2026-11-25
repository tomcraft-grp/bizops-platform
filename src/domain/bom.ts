import type { Bom, BomComponent, BomVersion, DB, ID, ModifierOption, Product, ProductionOrder } from './types';
import { Ctx, audit, docNo, fail, nid, product, guard } from './core';
import { cr, dr, invAccount, post, whDim } from './accounting';
import { avgCost, getBal, globalAvgCost, moveStock } from './inventory';
import { addDays, dayKey, r2, r3 } from '../lib/util';

/** Version effective at a moment in time (used for historical snapshots) */
export function versionAt(bom: Bom, iso: string): BomVersion | undefined {
  const day = dayKey(iso);
  const eligible = bom.versions.filter((v) => v.status !== 'draft' && dayKey(v.effectiveFrom) <= day && (!v.effectiveTo || dayKey(v.effectiveTo) >= day));
  return eligible.sort((a, b) => b.version - a.version)[0] ?? bom.versions.filter((v) => v.status !== 'draft').sort((a, b) => b.version - a.version)[0];
}
export const bomForProduct = (d: DB, pid: ID) => d.boms.find((b) => b.productId === pid);

export interface CostLine { productId: ID; name: string; unit: string; qty: number; unitCost: number; cost: number; role: BomComponent['role'] }
export function rollup(d: DB, v: BomVersion, warehouseId?: ID) {
  const lines: CostLine[] = v.components.map((c) => {
    const p = product(d, c.productId);
    const uc = warehouseId ? avgCost(d, warehouseId, c.productId) : globalAvgCost(d, c.productId);
    return { productId: c.productId, name: p.name, unit: p.unit, qty: c.qty, unitCost: uc, cost: r2(c.qty * uc), role: c.role };
  });
  const materials = r2(lines.reduce((s, l) => s + l.cost, 0));
  const batch = r2(materials + v.laborCost + v.overheadCost);
  const y = v.yieldQty || 1;
  return {
    lines, materials, labor: v.laborCost, overhead: v.overheadCost, batch,
    perUnit: r2(batch / y), materialsPerUnit: r2(materials / y), conversionPerUnit: r2((v.laborCost + v.overheadCost) / y),
  };
}

// ---------- validation, requirement and cost (production module)
type BomDraft = Pick<BomVersion, 'yieldQty' | 'components' | 'laborCost' | 'overheadCost' | 'otherCosts'>;
const notNeg = (n: number) => Number.isFinite(n) && n >= 0;
/** Everything that is wrong with a BOM for this output, as messages people can read. Empty = good. Used on create, on saving a draft and on activation. */
export function validateBom(d: DB, productId: ID, v: BomDraft, now = new Date().toISOString()): string[] {
  const out: string[] = [];
  const name = (id: ID) => d.products.find((p) => p.id === id)?.name ?? id;
  if (!d.products.some((p) => p.id === productId)) out.push(`Product ${productId} not found`);
  if (!v.components.length) out.push('Add at least one component first');
  const menu = d.products.some((p) => p.id === productId && p.kind === 'menu'); // a sale (consumeRecipe) uses the quantities, labour and overhead only
  const seen = new Set<ID>();
  for (const c of v.components) {
    const p = d.products.find((x) => x.id === c.productId), n = name(c.productId);
    if (!p) out.push(`Product ${c.productId} not found`);
    if (!(c.qty > 0) || !Number.isFinite(c.qty)) out.push(`${n}: the quantity must be greater than 0`);
    else if (c.qty > 1e9) out.push(`${n}: the quantity is too large`);
    if (c.wastePct != null && !(c.wastePct >= 0 && c.wastePct <= 99)) out.push(`${n}: the waste allowance must be between 0 and 99 percent`);
    else if (menu && (c.wastePct ?? 0) > 0) out.push(`${n}: a menu item has no waste allowance. Please include the waste in the quantity`);
    // the typed quantity and the stock quantity must be the same thing (0.0005 = the rounding of a stock quantity)
    if (c.entry && !(c.entry.qty > 0 && c.entry.factor > 0 && Math.abs(c.entry.qty * c.entry.factor - c.qty) <= 0.0005 + Math.abs(c.qty) * 1e-6)) out.push(`${n}: the unit conversion does not match the quantity`);
    if (seen.has(c.productId)) out.push(`${n} is listed more than once`);
    seen.add(c.productId);
    if (c.productId === productId) out.push(`${n} cannot be its own component`);
    else if (p?.kind === 'menu') out.push(`${n} is a menu item and holds no stock, so it cannot be a component`);
    else if (contains(d, c.productId, productId, now)) out.push(`${n} is made from this product, so it would make a circular BOM`);
  }
  if (menu && v.otherCosts?.some((x) => x.amount > 0)) out.push('A menu item has no other costs. Put the cost into labour or overhead');
  if (!(v.yieldQty > 0) || !Number.isFinite(v.yieldQty)) out.push('The batch yield must be greater than 0');
  else if (v.yieldQty > 1e9) out.push('The batch yield is too large');
  const costs = [v.laborCost, v.overheadCost, ...(v.otherCosts ?? []).map((x) => x.amount)];
  if (!costs.every(notNeg)) out.push('Costs must be 0 or more');
  else if (costs.some((x) => x > 1e12)) out.push('A cost is too large');
  return out;
}
export type BomVersionState = 'in_use' | 'scheduled' | 'replaced' | 'draft';
/** What each version is on a day (the status alone does not say: a version activated for next week leaves the old one in use until then). */
export function bomState(b: Bom, now: string): Record<number, BomVersionState> {
  const day = dayKey(now), cur = versionAt(b, now), out: Record<number, BomVersionState> = {};
  for (const v of b.versions) {
    const from = dayKey(v.effectiveFrom), never = !!v.effectiveTo && dayKey(v.effectiveTo) < from;
    out[v.version] = v.status === 'draft' ? 'draft' : from > day ? (never ? 'replaced' : 'scheduled') : v === cur ? 'in_use' : 'replaced';
  }
  return out;
}
/** Is `target` somewhere inside the BOM of `pid`, in the version in use or a scheduled one? (several levels; data that already loops does not hang it) */
function contains(d: DB, pid: ID, target: ID, now: string, seen = new Set<ID>()): boolean {
  if (seen.has(pid)) return false;
  seen.add(pid);
  const b = bomForProduct(d, pid), state = b ? bomState(b, now) : {};
  return !!b && b.versions.some((v) => (state[v.version] === 'in_use' || state[v.version] === 'scheduled') && v.components.some((c) => c.productId === target || contains(d, c.productId, target, now, seen)));
}
function checkBom(d: DB, productId: ID, v: BomDraft, now: string) {
  const issues = validateBom(d, productId, v, now);
  if (issues.length) fail('INVALID', issues[0]);
}
const grossQty = (c: BomComponent) => c.qty * (1 + (c.wastePct ?? 0) / 100);

/** Component quantity per output unit, waste allowance included, not rounded. */
export function grossPerUnit(v: BomVersion): Map<ID, number> {
  const m = new Map<ID, number>();
  for (const c of v.components) m.set(c.productId, (m.get(c.productId) ?? 0) + grossQty(c) / (v.yieldQty || 1));
  return m;
}
/** Component quantities needed for an output quantity, waste allowance included (in stock units). */
export function bomRequirement(v: BomVersion, outputQty: number): { productId: ID; qty: number }[] {
  return [...grossPerUnit(v)].map(([productId, g]) => ({ productId, qty: r3(g * outputQty) }));
}

export type CostSource = 'average' | 'standard' | 'unknown';
/** What one unit costs today: the average of that warehouse, else of all warehouses, else the last cost, else the standard cost. Nothing known (or 0) is unknown, never 0. */
export function knownCost(d: DB, pid: ID, warehouseId?: ID): { cost: number | null; source: CostSource } {
  const here = warehouseId ? getBal(d, warehouseId, pid) : undefined;
  if (here && here.qty > 0.0001 && here.value > 0) return { cost: here.value / here.qty, source: 'average' };
  let q = 0, v = 0, last = here?.lastCost ?? 0;
  for (const k in d.balances) {
    if (!k.endsWith('|' + pid)) continue;
    const b = d.balances[k];
    if (b.qty > 0) { q += b.qty; v += b.value; }
    if (!(last > 0)) last = b.lastCost;
  }
  if (q > 0.0001 && v > 0) return { cost: v / q, source: 'average' };
  if (q <= 0.0001 && last > 0) return { cost: last, source: 'average' };
  const std = d.products.find((p) => p.id === pid)?.stdCost ?? 0;
  return std > 0 ? { cost: std, source: 'standard' } : { cost: null, source: 'unknown' };
}
export interface BomCostLine { productId: ID; name: string; unit: string; qty: number; unitCost: number | null; cost: number | null; source: CostSource }
/** Cost of one batch at today's costs, waste allowance included. `materials` and `packaging` add up what is known; the totals are null while something is missing. */
export function bomCost(d: DB, v: BomVersion, warehouseId?: ID) {
  const missing: string[] = [];
  let materials = 0, packaging = 0;
  const lines: BomCostLine[] = v.components.map((c) => {
    const p = d.products.find((x) => x.id === c.productId);
    const qty = grossQty(c), k = knownCost(d, c.productId, warehouseId);
    const cost = k.cost == null ? null : r2(qty * k.cost);
    if (cost == null) missing.push(p?.name ?? c.productId);
    else if (c.role === 'packaging') packaging += cost;
    else materials += cost;
    return { productId: c.productId, name: p?.name ?? c.productId, unit: p?.unit ?? '', qty: r3(qty), unitCost: k.cost, cost, source: k.source };
  });
  const labor = v.laborKnown === false ? null : v.laborCost, overhead = v.overheadKnown === false ? null : v.overheadCost;
  if (labor == null) missing.push('Labour cost');
  if (overhead == null) missing.push('Overhead cost');
  const other = r2((v.otherCosts ?? []).reduce((s, x) => s + x.amount, 0));
  const batch = missing.length ? null : r2(materials + packaging + labor! + overhead! + other);
  return { lines, materials: r2(materials), packaging: r2(packaging), labor, overhead, other, batch, perUnit: batch == null ? null : r2(batch / (v.yieldQty || 1)), missing };
}

// ---------- versioning (only draft versions are editable → history is never rewritten)
export function createBom(
  d: DB, ctx: Ctx,
  p: { productId: ID; name: string; type: Bom['type']; yieldQty: number; components: BomComponent[]; laborCost: number; overheadCost: number; notes?: string; asDraft?: boolean } & Pick<BomVersion, 'otherCosts' | 'laborKnown' | 'overheadKnown'>,
): ID {
  guard(d, ctx, 'production:edit');
  if (!p.asDraft) guard(d, ctx, 'production:approve'); // as activateVersion: a BOM in use decides what production costs
  const out = product(d, p.productId);
  if (!out.active) fail('INACTIVE', `${out.name} is inactive`);
  if (d.boms.some((b) => b.productId === p.productId)) fail('DUPLICATE', 'This product already has a BOM — create a new version instead');
  checkBom(d, p.productId, p, ctx.now);
  const id = nid(d, 'BM');
  const v: BomVersion = { version: 1, status: p.asDraft ? 'draft' : 'active', effectiveFrom: ctx.now, yieldQty: p.yieldQty, components: p.components, laborCost: p.laborCost, overheadCost: p.overheadCost, notes: p.notes, createdAt: ctx.now };
  for (const k of ['otherCosts', 'laborKnown', 'overheadKnown'] as const) if (p[k] !== undefined) Object.assign(v, { [k]: p[k] });
  d.boms.push({ id, productId: p.productId, name: p.name, type: p.type, versions: [JSON.parse(JSON.stringify(v))] });
  out.bomId = id;
  audit(d, ctx, 'bom.create', 'bom', id, `${p.name}: v1 ${v.status}, ${p.components.length} component(s)`);
  return id;
}
const getBom = (d: DB, id: ID): Bom => d.boms.find((x) => x.id === id) || fail('NOT_FOUND', 'BOM not found');
const notArchived = (b: Bom) => { if (b.status === 'archived') fail('INVALID', 'This BOM is archived. Make it active before changing it'); };
/** Copies the active version (else the latest) to a product that has no BOM yet, as a draft version 1. */
export function duplicateBom(d: DB, ctx: Ctx, bomId: ID, productId: ID): ID {
  guard(d, ctx, 'production:edit');
  const b = getBom(d, bomId);
  const v = b.versions.find((x) => x.status === 'active') ?? [...b.versions].sort((x, y) => y.version - x.version)[0];
  const out = product(d, productId);
  const id = createBom(d, ctx, {
    productId, name: out.name, type: out.kind === 'menu' ? 'recipe' : b.type === 'recipe' ? 'manufacturing' : b.type, yieldQty: v.yieldQty, components: v.components, laborCost: v.laborCost, overheadCost: v.overheadCost,
    otherCosts: v.otherCosts, laborKnown: v.laborKnown, overheadKnown: v.overheadKnown, notes: `Copied from ${b.name} v${v.version}`, asDraft: true,
  });
  audit(d, ctx, 'bom.duplicate', 'bom', id, `${out.name}: copied from ${b.name} v${v.version}`);
  return id;
}
/** Versions and orders are kept whatever the status: an inactive or archived BOM only stops new production orders (a sale uses the recipe whatever its status). */
export function setBomStatus(d: DB, ctx: Ctx, bomId: ID, status: NonNullable<Bom['status']>, reason: string) {
  guard(d, ctx, 'production:edit');
  if (status === 'active') guard(d, ctx, 'production:approve');
  const b = getBom(d, bomId), cur = b.status ?? 'active';
  if (!['active', 'inactive', 'archived'].includes(status)) fail('INVALID', 'Unknown BOM status');
  if (cur === status) fail('INVALID', `This BOM is already ${status}`);
  if (!reason?.trim()) fail('REASON', 'A reason is required');
  const p = d.products.find((x) => x.id === b.productId);
  if (status !== 'active' && p?.kind === 'menu' && p.active) fail('INVALID', `${p.name} is an active menu item and a sale would still use this recipe. Deactivate the menu item first`);
  b.status = status;
  audit(d, ctx, 'bom.status', 'bom', bomId, `${b.name}: ${cur} → ${status}: ${reason.trim()}`, 'warn');
}
export function newDraftVersion(d: DB, ctx: Ctx, bomId: ID): number {
  guard(d, ctx, 'production:edit');
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  notArchived(b);
  if (b.versions.some((v) => v.status === 'draft')) fail('INVALID', 'A draft version already exists');
  const latest = [...b.versions].sort((a, c) => c.version - a.version)[0];
  const n = latest.version + 1;
  b.versions.push({ ...JSON.parse(JSON.stringify(latest)), version: n, status: 'draft', effectiveFrom: ctx.now, effectiveTo: undefined, createdAt: ctx.now, notes: `Draft based on v${latest.version}` });
  return n;
}
export function updateDraft(d: DB, ctx: Ctx, bomId: ID, version: number, patch: Partial<Pick<BomVersion, 'yieldQty' | 'components' | 'laborCost' | 'overheadCost' | 'notes' | 'otherCosts' | 'laborKnown' | 'overheadKnown'>>) {
  guard(d, ctx, 'production:edit');
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  const v = b.versions.find((x) => x.version === version) || fail('NOT_FOUND', 'Version not found');
  if (v.status !== 'draft') fail('IMMUTABLE', `v${version} is ${v.status} and cannot be edited. Create a new version instead — historical costs must not change.`);
  notArchived(b);
  checkBom(d, b.productId, { ...v, ...patch }, ctx.now);
  Object.assign(v, patch);
  audit(d, ctx, 'bom.update', 'bom', bomId, `${b.name}: draft v${version} saved`);
}
export function activateVersion(d: DB, ctx: Ctx, bomId: ID, version: number, effectiveFrom: string) {
  guard(d, ctx, 'production:approve');
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  const v = b.versions.find((x) => x.version === version) || fail('NOT_FOUND', 'Version not found');
  if (v.status !== 'draft') fail('INVALID', 'Only draft versions can be activated');
  notArchived(b);
  checkBom(d, b.productId, v, ctx.now);
  for (const o of b.versions) if (o.status === 'active') { o.status = 'retired'; o.effectiveTo = addDays(effectiveFrom, -1).toISOString(); }
  v.status = 'active';
  v.effectiveFrom = effectiveFrom;
  audit(d, ctx, 'bom.activate', 'bom', bomId, `${b.name} v${version} effective ${dayKey(effectiveFrom)}`, 'warn');
}
export function discardDraft(d: DB, ctx: Ctx, bomId: ID, version: number) {
  guard(d, ctx, 'production:edit');
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  const i = b.versions.findIndex((x) => x.version === version && x.status === 'draft');
  if (i < 0) fail('INVALID', 'No such draft');
  b.versions.splice(i, 1);
  // a BOM that only ever was a draft has no history to keep: without it the product can be given a BOM again
  if (!b.versions.length) {
    d.boms.splice(d.boms.indexOf(b), 1);
    const p = d.products.find((x) => x.id === b.productId);
    if (p?.bomId === bomId) p.bomId = undefined;
  }
  audit(d, ctx, 'bom.discard', 'bom', bomId, `${b.name}: draft v${version} discarded`, 'warn');
}

// ---------- F&B / recipe backflush at sale time
export function consumeRecipe(
  d: DB, ctx: Ctx, prod: Product, qty: number, warehouseId: ID, refId: ID, mods: ModifierOption[],
): { materials: number; conversion: number; byAcct: Record<string, number>; ref?: { bomId: ID; version: number } } {
  const bom = bomForProduct(d, prod.id);
  if (!bom) fail('NO_BOM', `${prod.name} has no recipe/BOM`);
  const v = versionAt(bom!, ctx.now) || fail('NO_BOM', `${prod.name} has no active recipe`);
  const need: Record<ID, number> = {};
  for (const c of v!.components) need[c.productId] = (need[c.productId] || 0) + (c.qty * qty) / v!.yieldQty;
  for (const m of mods) {
    if (m.replace && need[m.replace.from] != null) { need[m.replace.to] = (need[m.replace.to] || 0) + need[m.replace.from]; delete need[m.replace.from]; }
    for (const a of m.add ?? []) need[a.productId] = (need[a.productId] || 0) + a.qty * qty;
  }
  let materials = 0;
  const byAcct: Record<string, number> = {};
  for (const [pid, q] of Object.entries(need)) {
    const mv = moveStock(d, ctx, { productId: pid, warehouseId, qty: -r3(q), type: 'backflush', refType: 'order', refId, note: `Recipe ${prod.name}` });
    materials += -mv.value;
    const a = invAccount(product(d, pid).kind);
    byAcct[a] = (byAcct[a] || 0) + -mv.value;
  }
  const conversion = r2(((v!.laborCost + v!.overheadCost) * qty) / v!.yieldQty);
  return { materials: r2(materials), conversion, byAcct, ref: { bomId: bom!.id, version: v!.version } };
}
/** Reverse a recipe consumption proportionally (returns): puts back materials at original-average cost */
export function estimateRecipeCost(d: DB, prod: Product, iso: string, warehouseId?: ID): number {
  const bom = bomForProduct(d, prod.id);
  if (!bom) return prod.stdCost;
  const v = versionAt(bom, iso);
  return v ? rollup(d, v, warehouseId).perUnit : prod.stdCost;
}

// ---------- production orders
export function createProductionOrder(d: DB, ctx: Ctx, p: { bomId: ID; plannedQty: number; warehouseId: ID; note?: string }): ID {
  guard(d, ctx, 'production:create');
  const b = d.boms.find((x) => x.id === p.bomId) || fail('NOT_FOUND', 'BOM not found');
  if (!(p.plannedQty > 0)) fail('INVALID', 'Planned quantity must be positive');
  const v = versionAt(b, ctx.now) || fail('NO_BOM', 'BOM has no active version');
  const id = nid(d, 'PR');
  const po: ProductionOrder = {
    id, no: docNo(d, 'PRD'), bomId: b.id, productId: b.productId, warehouseId: p.warehouseId, plannedQty: p.plannedQty, status: 'planned',
    snapshot: JSON.parse(JSON.stringify(v)), createdAt: ctx.now, batches: [], note: p.note, createdBy: ctx.userId,
  };
  d.productionOrders.push(po);
  return id;
}

/** An order run with work in progress (domain/production.ts): these single-step functions would leave its WIP behind, so they refuse it. Older orders have neither field. */
const notWipOrder = (po: ProductionOrder) => { if (po.wip || po.events) fail('INVALID', 'This production order is run step by step: use issue, receive, close or cancel on the order'); };
export function recordProduction(d: DB, ctx: Ctx, id: ID, p: { outputQty: number; wasteQty?: number; note?: string }) {
  guard(d, ctx, 'production:create');
  const po = d.productionOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'Production order not found');
  if (po.status === 'completed' || po.status === 'cancelled') fail('INVALID', `Order is ${po.status}`);
  notWipOrder(po);
  const waste = p.wasteQty ?? 0;
  const out = p.outputQty;
  if (out < 0 || waste < 0 || out + waste <= 0) fail('INVALID', 'Enter an output and/or waste quantity');
  const v = po.snapshot; // BOM snapshot frozen at order creation
  const units = out + waste;
  const frac = units / v.yieldQty;
  const outProd = product(d, po.productId);
  let materials = 0;
  const credits: Record<string, number> = {};
  for (const c of v.components) {
    const mv = moveStock(d, ctx, { productId: c.productId, warehouseId: po.warehouseId, qty: -r3(c.qty * frac), type: 'prod_issue', refType: 'production', refId: po.id });
    materials += -mv.value;
    const a = invAccount(product(d, c.productId).kind);
    credits[a] = (credits[a] || 0) + -mv.value;
  }
  materials = r2(materials);
  const conversion = r2((v.laborCost + v.overheadCost) * frac);
  const total = r2(materials + conversion);
  const wasteCost = r2(total * (waste / units));
  const outputCost = r2(total - wasteCost);
  if (out > 0) moveStock(d, ctx, { productId: po.productId, warehouseId: po.warehouseId, qty: out, type: 'prod_output', refType: 'production', refId: po.id, value: outputCost });
  // waste units never enter stock; their cost is expensed to 5100 and kept on the batch record
  const jid = post(d, ctx, {
    memo: `Production ${po.no}: ${out} ${outProd.unit} ${outProd.name}` + (waste ? ` (+${waste} waste)` : ''), refType: 'production', refId: po.id, dim: whDim(d, po.warehouseId),
    lines: [dr(invAccount(outProd.kind), outputCost), dr('waste', wasteCost), ...Object.entries(credits).map(([a, x]) => cr(a, x)), cr('conversion_absorbed', conversion)],
  });
  po.batches.push({ ts: ctx.now, outputQty: out, wasteQty: waste, materialCost: materials, conversionCost: conversion, wasteCost, unitCost: out > 0 ? r2(outputCost / out) : 0, journalId: jid });
  po.status = 'in_progress';
  const totalOut = po.batches.reduce((s, b) => s + b.outputQty, 0);
  if (totalOut >= po.plannedQty - 1e-6) { po.status = 'completed'; po.completedAt = ctx.now; }
}
export function completeProduction(d: DB, ctx: Ctx, id: ID) {
  guard(d, ctx, 'production:create');
  const po = d.productionOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'Production order not found');
  notWipOrder(po);
  if (!po.batches.length) fail('INVALID', 'Nothing has been produced yet');
  po.status = 'completed';
  po.completedAt = ctx.now;
}
export function cancelProduction(d: DB, ctx: Ctx, id: ID) {
  guard(d, ctx, 'production:approve');
  const po = d.productionOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'Production order not found');
  notWipOrder(po);
  if (po.batches.length) fail('INVALID', 'Cannot cancel after production was recorded — close it instead');
  po.status = 'cancelled';
}
export const prodTotals = (po: ProductionOrder) => {
  const out = po.batches.reduce((s, b) => s + b.outputQty, 0);
  const waste = po.batches.reduce((s, b) => s + b.wasteQty, 0);
  const cost = po.batches.reduce((s, b) => s + b.materialCost + b.conversionCost - b.wasteCost, 0);
  const wasteCost = po.batches.reduce((s, b) => s + b.wasteCost, 0);
  return { out, waste, cost: r2(cost), wasteCost: r2(wasteCost), unitCost: out > 0 ? r2(cost / out) : 0 };
};
