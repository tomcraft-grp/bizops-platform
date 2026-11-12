import type { Bom, BomComponent, BomVersion, DB, ID, ModifierOption, Product, ProductionOrder } from './types';
import { Ctx, audit, docNo, fail, nid, product, guard } from './core';
import { cr, dr, invAccount, post, whDim } from './accounting';
import { avgCost, globalAvgCost, moveStock } from './inventory';
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

// ---------- versioning (only draft versions are editable → history is never rewritten)
export function createBom(
  d: DB, ctx: Ctx,
  p: { productId: ID; name: string; type: Bom['type']; yieldQty: number; components: BomComponent[]; laborCost: number; overheadCost: number; notes?: string },
): ID {
  guard(d, ctx, 'production:edit');
  if (d.boms.some((b) => b.productId === p.productId)) fail('DUPLICATE', 'This product already has a BOM — create a new version instead');
  const id = nid(d, 'BM');
  d.boms.push({
    id, productId: p.productId, name: p.name, type: p.type,
    versions: [{ version: 1, status: 'active', effectiveFrom: ctx.now, yieldQty: p.yieldQty, components: p.components, laborCost: p.laborCost, overheadCost: p.overheadCost, notes: p.notes, createdAt: ctx.now }],
  });
  product(d, p.productId).bomId = id;
  return id;
}
export function newDraftVersion(d: DB, ctx: Ctx, bomId: ID): number {
  guard(d, ctx, 'production:edit');
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  if (b.versions.some((v) => v.status === 'draft')) fail('INVALID', 'A draft version already exists');
  const latest = [...b.versions].sort((a, c) => c.version - a.version)[0];
  const n = latest.version + 1;
  b.versions.push({ ...JSON.parse(JSON.stringify(latest)), version: n, status: 'draft', effectiveFrom: ctx.now, effectiveTo: undefined, createdAt: ctx.now, notes: `Draft based on v${latest.version}` });
  return n;
}
export function updateDraft(d: DB, ctx: Ctx, bomId: ID, version: number, patch: Partial<Pick<BomVersion, 'yieldQty' | 'components' | 'laborCost' | 'overheadCost' | 'notes'>>) {
  guard(d, ctx, 'production:edit');
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  const v = b.versions.find((x) => x.version === version) || fail('NOT_FOUND', 'Version not found');
  if (v.status !== 'draft') fail('IMMUTABLE', `v${version} is ${v.status} and cannot be edited. Create a new version instead — historical costs must not change.`);
  Object.assign(v, patch);
}
export function activateVersion(d: DB, ctx: Ctx, bomId: ID, version: number, effectiveFrom: string) {
  guard(d, ctx, 'production:approve');
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  const v = b.versions.find((x) => x.version === version) || fail('NOT_FOUND', 'Version not found');
  if (v.status !== 'draft') fail('INVALID', 'Only draft versions can be activated');
  if (!v.components.length) fail('INVALID', 'Add at least one component first');
  for (const o of b.versions) if (o.status === 'active') { o.status = 'retired'; o.effectiveTo = addDays(effectiveFrom, -1).toISOString(); }
  v.status = 'active';
  v.effectiveFrom = effectiveFrom;
  audit(d, ctx, 'bom.activate', 'bom', bomId, `${b.name} v${version} effective ${dayKey(effectiveFrom)}`, 'warn');
}
export function discardDraft(d: DB, bomId: ID, version: number) {
  const b = d.boms.find((x) => x.id === bomId) || fail('NOT_FOUND', 'BOM not found');
  const i = b.versions.findIndex((x) => x.version === version && x.status === 'draft');
  if (i < 0) fail('INVALID', 'No such draft');
  b.versions.splice(i, 1);
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

export function recordProduction(d: DB, ctx: Ctx, id: ID, p: { outputQty: number; wasteQty?: number; note?: string }) {
  guard(d, ctx, 'production:create');
  const po = d.productionOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'Production order not found');
  if (po.status === 'completed' || po.status === 'cancelled') fail('INVALID', `Order is ${po.status}`);
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
  if (!po.batches.length) fail('INVALID', 'Nothing has been produced yet');
  po.status = 'completed';
  po.completedAt = ctx.now;
}
export function cancelProduction(d: DB, ctx: Ctx, id: ID) {
  guard(d, ctx, 'production:approve');
  const po = d.productionOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'Production order not found');
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
