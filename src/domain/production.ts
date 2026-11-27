import type { Bom, ConsumedLine, CostElems, ConversionEntry, DB, GoodsProduced, ID, LossEntry, MaterialIssue, MaterialReturn, Product, ProductionOrder } from './types';
import { Ctx, audit, docNo, fail, nid, product, guard } from './core';
import { cr, dr, invAccount, isLocked, post, reverseJournal, whDim } from './accounting';
import { getBal, moveStock, onHand } from './inventory';
import { bomCost, bomRequirement, grossPerUnit, versionAt } from './bom';
import { dayKey, r2 as round2, r3 as round3 } from '../lib/util';

// ======================================================================================
// Production orders with work in progress (POL-24)
// Every cost goes into the WIP of its order by element and leaves it as goods, waste, a return or a variance: Σ WIP of the orders = the balance of the WIP account, always.
// Costs follow the physical material: what is in an order (its pool) is known per product, in quantity and in actual cost, and a receipt takes what it used (see takeFor).
// The older single-step flow (createProductionOrder / recordProduction in bom.ts, policy POL-09) keeps its own records in `batches`; both are read together here.
// ======================================================================================
export const ELEMS = ['materials', 'labor', 'overhead'] as const;
const VAR_ROLE = { materials: 'prod_var_material', labor: 'prod_var_labor', overhead: 'prod_var_overhead' } as const;
const CONVERSION_KINDS = ['labor', 'overhead', 'utilities', 'other'];
const zero = (): CostElems => ({ materials: 0, labor: 0, overhead: 0 });
const total = (c: CostElems) => r2(c.materials + c.labor + c.overhead);
const r2 = (n: number) => round2(n) + 0, r3 = (n: number) => round3(n) + 0; // never −0
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const live = <T extends { reversal?: unknown }>(list?: T[]): T[] => (list ?? []).filter((x) => !x.reversal);
const elemOf = (k: ConversionEntry['kind']) => (k === 'labor' ? 'labor' : 'overhead'); // utilities and other costs count as overhead

const getOrder = (d: DB, id: ID): ProductionOrder => d.productionOrders.find((x) => x.id === id) || fail('NOT_FOUND', 'Production order not found');
const checkWarehouse = (d: DB, id: ID) => { if (!d.warehouses.some((w) => w.id === id)) fail('NOT_FOUND', 'Warehouse not found'); };
const MAX_QTY = 1e9, MAX_AMOUNT = 1e12;
/** A quantity the stock ledger can hold (3 decimals), above 0. NaN, infinity and text are refused, never turned into 0. */
function posQty(n: number, msg = 'Quantity must be positive'): number {
  if (!Number.isFinite(n) || !(n > 0)) fail('INVALID', msg);
  if (n > MAX_QTY) fail('INVALID', 'The quantity is too large');
  if (!(r3(n) > 0)) fail('INVALID', msg);
  return r3(n);
}
function posAmount(n: number): number {
  if (!Number.isFinite(n) || !(n > 0)) fail('INVALID', 'Amount must be greater than zero');
  if (n > MAX_AMOUNT) fail('INVALID', 'The amount is too large');
  if (!(r2(n) > 0)) fail('INVALID', 'Amount must be greater than zero');
  return r2(n);
}
/** post() checks this too, but only when there is money in the entry: a movement of stock without value must not slip into a closed period either. */
function openPeriod(d: DB, ctx: Ctx) {
  if (!ctx.seed && isLocked(d, ctx.now)) fail('PERIOD_LOCKED', `Accounting period is locked through ${d.meta.lockedUntil}. Reopen the period or post to a later date.`);
}
/**
 * The same request sent twice (a double tap, a retry after a lost connection) is carried out once and answered with the first id.
 * The key remembers its action and result; `done` proves that the result is on this order and still stands. A key reused for anything else, or whose result
 * was undone since, is refused: neither dropped silently nor reported as done.
 */
function once(d: DB, action: string, key: string | undefined, done: (id: ID) => boolean, run: () => ID): ID {
  if (!key) return run();
  const k = 'prod:' + key, first = d.meta.idem[k];
  if (first) {
    const id = first.startsWith(action + ':') ? first.slice(action.length + 1) : '';
    if (!id || !done(id)) fail('DUPLICATE_KEY', 'This request was already used for another production step, or what it did was undone. Reload the page and try again');
    return id;
  }
  const id = run();
  d.meta.idem[k] = `${action}:${id}`;
  return id;
}
function move(po: ProductionOrder, ctx: Ctx, to: ProductionOrder['status'], note?: string) {
  (po.events ||= []).push({ ts: ctx.now, userId: ctx.userId, from: po.status, to, note });
  po.status = to;
}
/** Issues, costs, receipts and losses need an order that is approved and not finished. */
function checkRunning(po: ProductionOrder) {
  if (po.status === 'draft' || po.status === 'planned') fail('INVALID', 'Approve this production order first');
  if (po.status === 'completed' || po.status === 'cancelled') fail('INVALID', `Order is ${po.status}`);
}
function charge(po: ProductionOrder, ctx: Ctx, e: keyof CostElems, amount: number) {
  const w = (po.wip ||= zero());
  w[e] = r2(w[e] + amount);
  if (po.status === 'approved') move(po, ctx, 'in_progress');
}
function release(po: ProductionOrder, c: CostElems) {
  const w = (po.wip ||= zero());
  for (const e of ELEMS) w[e] = r2(w[e] - c[e]);
}
const minus = (c: CostElems): CostElems => ({ materials: -c.materials, labor: -c.labor, overhead: -c.overhead });
const plus = (a: CostElems, b: CostElems): CostElems => ({ materials: r2(a.materials + b.materials), labor: r2(a.labor + b.labor), overhead: r2(a.overhead + b.overhead) });
const stillThere = <T extends { id: ID; reversal?: unknown }>(list: T[] | undefined) => (id: ID) => !!list?.some((x) => x.id === id && !x.reversal);
const noteOf = (po: ProductionOrder, no: string, why?: string) => `${po.no} ${no} (BOM v${po.snapshot.version})${why ? `: reversed, ${why}` : ''}`;

// ---------- the pool: what is in an order now, derived from its documents (nothing of it is stored)
interface Pot { qty: number; value: number }
function pots(po: ProductionOrder): Map<ID, Pot> {
  const m = new Map<ID, Pot>();
  const book = (l: { productId: ID; qty: number; value: number }, sign: 1 | -1) => { const p = m.get(l.productId) ?? { qty: 0, value: 0 }; m.set(l.productId, { qty: r3(p.qty + sign * l.qty), value: r2(p.value + sign * l.value) }); };
  for (const i of live(po.issues)) for (const l of i.lines) book(l, 1);
  for (const r of live(po.returns)) for (const l of r.lines) book(l, -1);
  for (const x of [...live(po.receipts), ...live(po.losses), ...live(po.variances)]) for (const l of x.consumed ?? []) book(l, -1);
  for (const [k, p] of m) if (!p.qty && !p.value) m.delete(k);
  return m;
}
/** Material (quantity and actual cost per product), labour and overhead charged to an order and not used yet. Σ value of the materials = wip.materials. */
export function pool(po: ProductionOrder): { materials: ConsumedLine[]; labor: number; overhead: number } {
  return { materials: [...pots(po)].map(([productId, p]) => ({ productId, ...p })), labor: po.wip?.labor ?? 0, overhead: po.wip?.overhead ?? 0 };
}
/** A quantity out of a pot at its average cost; the last of it takes exactly what is left. */
function draw(p: Pot, qty: number): Pot {
  const q = r3(Math.max(0, qty));
  if (q >= p.qty - 1e-9) return { ...p };
  return q > 0 ? { qty: q, value: Math.min(p.value, r2((p.value * q) / p.qty)) } : { qty: 0, value: 0 };
}
/** A value out of all the pots, pro rata, exact to the satang, with the quantity it stands for (an abnormal loss is stated in money). */
function drawValue(m: Map<ID, Pot>, amount: number): ConsumedLine[] {
  const all = [...m].map(([productId, p]) => ({ productId, ...p })), sum = r2(all.reduce((s, x) => s + x.value, 0));
  if (amount >= sum) return all;
  const big = r2(all.reduce((s, x) => s + (x.qty > 0.001 ? x.value : 0), 0)); // the smallest quantity cannot be split: it is touched last
  const take = all.map((x) => (x.qty > 0.001 && big > 0 ? Math.min(x.value, r2((amount * x.value) / big)) : 0));
  let diff = r2(amount - take.reduce((s, v) => s + v, 0));
  for (const i of all.map((_, k) => k).sort((a, b) => Number(all[b].qty > 0.001) - Number(all[a].qty > 0.001) || all[b].value - all[a].value)) { const v = r2(Math.max(0, Math.min(all[i].value, take[i] + diff))); diff = r2(diff - (v - take[i])); take[i] = v; }
  // value never moves without some quantity, and a pot that keeps some value keeps some quantity too
  return all.map((x, i) => ({ productId: x.productId, qty: !(take[i] > 0) ? 0 : take[i] >= x.value ? x.qty : Math.max(0, Math.min(Math.max(0.001, r3((x.qty * take[i]) / x.value)), r3(x.qty - 0.001))), value: take[i] })).filter((x) => x.qty > 0 || x.value > 0);
}
/** Output still to make: planned less good. Rejected units have to be made again. */
export const unitsLeft = (po: ProductionOrder) => r3(Math.max(0, po.plannedQty - live(po.receipts).reduce((s, r) => s + r.good, 0) - po.batches.reduce((s, b) => s + b.outputQty, 0)));

/** A part of WIP, pro rata over the elements, exact to the satang and never more than an element holds. */
function share(w: CostElems, amount: number): CostElems {
  const t = total(w), out = zero();
  for (const e of ELEMS) out[e] = t > 0 ? Math.min(w[e], r2((amount * w[e]) / t)) : 0;
  let diff = r2(amount - total(out));
  for (const e of [...ELEMS].sort((a, b) => w[b] - w[a])) {
    const x = r2(Math.max(0, Math.min(w[e], out[e] + diff)));
    diff = r2(diff - (x - out[e]));
    out[e] = x;
  }
  return out;
}

// ---------- create, plan, approve
export interface OrderInput { bomId: ID; plannedQty: number; warehouseId: ID; note?: string; dueAt?: string }
function usableBom(d: DB, id: ID): { b: Bom; p: Product } {
  const b: Bom = d.boms.find((x) => x.id === id) || fail('NOT_FOUND', 'BOM not found');
  if (b.status && b.status !== 'active') fail('INVALID', `This BOM is ${b.status}. Make it active before producing`);
  const p = product(d, b.productId);
  if (p.kind === 'menu') fail('INVALID', `${p.name} is a menu item: it is made when it is sold, so it has no production order`);
  if (!p.active) fail('INACTIVE', `${p.name} is inactive`);
  return { b, p };
}
function snapshotOf(b: Bom, ctx: Ctx) {
  const v = versionAt(b, ctx.now) || fail('NO_BOM', 'BOM has no active version');
  // versionAt falls back to the newest version when none is in effect: one that starts later is not usable yet
  if (dayKey(v.effectiveFrom) > dayKey(ctx.now)) fail('NO_BOM', `BOM v${v.version} starts on ${dayKey(v.effectiveFrom)} and cannot be used before that date`);
  return JSON.parse(JSON.stringify(v)) as ProductionOrder['snapshot'];
}
/** What one output unit should cost, at today's costs. An element nobody knows stays null: it is never taken as 0. */
function estimateOf(d: DB, v: ProductionOrder['snapshot'], warehouseId: ID): NonNullable<ProductionOrder['estimate']> {
  const c = bomCost(d, v, warehouseId), y = v.yieldQty || 1;
  const lines = v.components.map((x, i) => ({ productId: x.productId, qty: r6((x.qty * (1 + (x.wastePct ?? 0) / 100)) / y), unitCost: c.lines[i].unitCost }));
  return {
    materialsPerUnit: lines.some((l) => l.unitCost == null) ? null : r6(lines.reduce((s, l) => s + l.qty * l.unitCost!, 0)),
    laborPerUnit: c.labor == null ? null : r6(c.labor / y), overheadPerUnit: c.overhead == null ? null : r6((c.overhead + c.other) / y), lines,
  };
}
export function createOrder(d: DB, ctx: Ctx, p: OrderInput & { draft?: boolean }, key?: string): ID {
  guard(d, ctx, 'production:create');
  return once(d, 'create', key, (id) => d.productionOrders.some((x) => x.id === id && x.status !== 'cancelled'), () => {
    const { b, p: out } = usableBom(d, p.bomId), plannedQty = posQty(p.plannedQty, 'Planned quantity must be positive');
    checkWarehouse(d, p.warehouseId);
    const snapshot = snapshotOf(b, ctx), id = nid(d, 'PR'), status = p.draft ? 'draft' : 'planned';
    const po: ProductionOrder = {
      id, no: docNo(d, 'PRD'), bomId: b.id, productId: b.productId, warehouseId: p.warehouseId, plannedQty, status, snapshot, createdAt: ctx.now, batches: [], note: p.note, createdBy: ctx.userId,
      dueAt: p.dueAt, estimate: estimateOf(d, snapshot, p.warehouseId), events: [{ ts: ctx.now, userId: ctx.userId, from: '', to: status }],
    };
    d.productionOrders.push(po);
    audit(d, ctx, 'production.create', 'production', id, `${po.no}: ${po.plannedQty} ${out.unit} ${out.name}, BOM v${snapshot.version} (${status})`);
    return id;
  });
}
/** Only a draft can be changed. Choosing another BOM takes a new snapshot; otherwise the snapshot stays as it was when the order was created. */
export function updateDraftOrder(d: DB, ctx: Ctx, id: ID, patch: Partial<OrderInput>, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'update', key, (x) => x === id && po.status !== 'cancelled', () => {
    if (po.status !== 'draft') fail('INVALID', 'Only a draft order can be changed');
    if (patch.plannedQty !== undefined) po.plannedQty = posQty(patch.plannedQty, 'Planned quantity must be positive');
    if (patch.warehouseId !== undefined) { checkWarehouse(d, patch.warehouseId); po.warehouseId = patch.warehouseId; }
    if (patch.bomId !== undefined && patch.bomId !== po.bomId) {
      const { b } = usableBom(d, patch.bomId);
      Object.assign(po, { bomId: b.id, productId: b.productId, snapshot: snapshotOf(b, ctx) });
    }
    if ('note' in patch) po.note = patch.note;
    if ('dueAt' in patch) po.dueAt = patch.dueAt;
    po.estimate = estimateOf(d, po.snapshot, po.warehouseId);
    audit(d, ctx, 'production.update', 'production', id, `${po.no}: draft changed`);
    return id;
  });
}
export function planOrder(d: DB, ctx: Ctx, id: ID, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'plan', key, (x) => x === id && po.status !== 'draft' && po.status !== 'cancelled', () => {
    if (po.status !== 'draft') fail('INVALID', `Order is ${po.status}`);
    move(po, ctx, 'planned');
    audit(d, ctx, 'production.plan', 'production', id, `${po.no} planned`);
    return id;
  });
}
export function approveOrder(d: DB, ctx: Ctx, id: ID, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  return once(d, 'approve', key, (x) => x === id && !!po.approvedBy && po.status !== 'cancelled', () => {
    if (po.status !== 'planned') fail('INVALID', `Order is ${po.status}`);
    po.estimate = estimateOf(d, po.snapshot, po.warehouseId); // costs may have moved since it was planned
    po.approvedBy = ctx.userId;
    move(po, ctx, 'approved');
    audit(d, ctx, 'production.approve', 'production', id, `${po.no} approved`);
    return id;
  });
}

// ---------- costs in
export interface IssueInput { lines: { productId: ID; qty: number; warehouseId?: ID }[]; confirmUnknownCost?: boolean }
/** Takes components out of stock at average cost into WIP. What is really used may differ from the BOM (substitutes, extra material): the difference shows as a usage variance. */
export function issueMaterials(d: DB, ctx: Ctx, id: ID, p: IssueInput, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'issue', key, stillThere(po.issues), () => {
    checkRunning(po);
    openPeriod(d, ctx);
    if (!p.lines.length) fail('INVALID', 'Add at least one line');
    const seen = new Set<string>(), want = p.lines.map((l) => {
      const prod = product(d, l.productId), warehouseId = l.warehouseId ?? po.warehouseId;
      if (l.productId === po.productId) fail('INVALID', `${prod.name} cannot be its own component`);
      if (prod.kind === 'menu') fail('INVALID', `${prod.name} is a menu item and holds no stock, so it cannot be a component`);
      checkWarehouse(d, warehouseId);
      const k = warehouseId + '|' + l.productId;
      if (seen.has(k)) fail('INVALID', `${prod.name} is listed more than once`);
      seen.add(k);
      return { prod, warehouseId, qty: posQty(l.qty) };
    });
    const no = docNo(d, 'MIS'), lines: MaterialIssue['lines'] = [], credits: Record<string, number> = {};
    for (const { prod, warehouseId, qty } of want) {
      const b = getBal(d, warehouseId, prod.id), unit = b.qty > 0 ? b.value / b.qty : b.lastCost || prod.stdCost; // the cost moveStock takes
      const m = moveStock(d, ctx, { productId: prod.id, warehouseId, qty: -qty, type: 'prod_issue', refType: 'production', refId: id, note: noteOf(po, no) });
      const value = r2(0 - m.value);
      if (!(unit > 0) && !p.confirmUnknownCost) fail('UNKNOWN_COST', `${prod.name} has no known cost. Record its cost first, or confirm to issue it without a cost`);
      if (value < 0) fail('INVALID', `The stock value of ${prod.name} is below zero. Correct the stock value before issuing it`);
      lines.push({ productId: prod.id, warehouseId, qty, unitCost: m.unitCost, value, movementId: m.id, ...(unit > 0 ? {} : { unknownCost: true }) });
      const a = invAccount(prod.kind);
      credits[a] = r2((credits[a] || 0) + value);
    }
    const value = r2(lines.reduce((s, l) => s + l.value, 0));
    const journalId = post(d, ctx, { memo: `Production ${po.no}: materials issued ${no}`, refType: 'production', refId: id, dim: whDim(d, po.warehouseId), lines: [dr('wip', value), ...Object.entries(credits).map(([a, x]) => cr(a, x))] });
    const iid = nid(d, 'MI');
    (po.issues ||= []).push({ id: iid, no, ts: ctx.now, userId: ctx.userId, lines, value, journalId });
    charge(po, ctx, 'materials', value);
    audit(d, ctx, 'production.issue', 'production', id, `${po.no}: ${no}, ${lines.length} line(s)`);
    return iid;
  });
}
export interface ConversionInput { kind: ConversionEntry['kind']; amount: number; note?: string }
export function addConversion(d: DB, ctx: Ctx, id: ID, p: ConversionInput, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'cost', key, stillThere(po.conversions), () => {
    checkRunning(po);
    if (!CONVERSION_KINDS.includes(p.kind)) fail('INVALID', 'Choose labour, overhead, utilities or other cost');
    const amount = posAmount(p.amount), cid = nid(d, 'CE');
    const journalId = post(d, ctx, { memo: `Production ${po.no}: ${p.kind}${p.note ? ' ' + p.note : ''}`, refType: 'production', refId: id, dim: whDim(d, po.warehouseId), lines: [dr('wip', amount), cr('conversion_absorbed', amount)] });
    (po.conversions ||= []).push({ id: cid, ts: ctx.now, userId: ctx.userId, kind: p.kind, amount, note: p.note, journalId });
    charge(po, ctx, elemOf(p.kind), amount);
    audit(d, ctx, 'production.cost', 'production', id, `${po.no}: ${p.kind} cost recorded`);
    return cid;
  });
}

// ---------- costs out
/** An abnormal loss (a spill, a fire): expensed at once, so it does not make the good units dearer. */
export function recordLoss(d: DB, ctx: Ctx, id: ID, p: { amount: number; note: string }, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'loss', key, stillThere(po.losses), () => {
    checkRunning(po);
    const amount = posAmount(p.amount), w = po.wip ?? zero();
    if (!p.note?.trim()) fail('REASON', 'A reason is required');
    if (amount > total(w)) fail('INVALID', `The loss is more than the cost in this order (${total(w)})`);
    const cost = share(w, amount), consumed = cost.materials > 0 ? drawValue(pots(po), cost.materials) : [], lid = nid(d, 'LE');
    const journalId = post(d, ctx, { memo: `Production ${po.no}: abnormal loss ${p.note.trim()}`, refType: 'production', refId: id, dim: whDim(d, po.warehouseId), lines: [dr('waste', amount), cr('wip', amount)] });
    (po.losses ||= []).push({ id: lid, ts: ctx.now, userId: ctx.userId, amount, cost, consumed, note: p.note.trim(), journalId });
    release(po, cost);
    audit(d, ctx, 'production.loss', 'production', id, `${po.no}: abnormal loss, ${p.note.trim()}`, 'warn');
    return lid;
  });
}
export interface ReturnInput { lines: { productId: ID; qty: number; warehouseId?: ID }[]; reason: string }
/** Material that was issued and not used goes back to stock, at the average cost it has in the order. */
export function returnMaterials(d: DB, ctx: Ctx, id: ID, p: ReturnInput, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'return', key, stillThere(po.returns), () => {
    checkRunning(po);
    openPeriod(d, ctx);
    if (!p.reason?.trim()) fail('REASON', 'A reason is required');
    if (!p.lines.length) fail('INVALID', 'Add at least one line');
    const m = pots(po), seen = new Set<string>(), no = docNo(d, 'MRT'), lines: MaterialReturn['lines'] = [], debits: Record<string, number> = {};
    for (const l of p.lines) {
      const prod = product(d, l.productId), warehouseId = l.warehouseId ?? po.warehouseId, qty = posQty(l.qty), pot = m.get(l.productId) ?? { qty: 0, value: 0 };
      checkWarehouse(d, warehouseId);
      const k = warehouseId + '|' + l.productId;
      if (seen.has(k)) fail('INVALID', `${prod.name} is listed more than once`);
      seen.add(k);
      if (qty > pot.qty + 1e-9) fail('OVER_RETURN', `Only ${pot.qty} ${prod.unit} of ${prod.name} are left in this order to return`);
      const x = draw(pot, qty);
      m.set(l.productId, { qty: r3(pot.qty - x.qty), value: r2(pot.value - x.value) });
      const mv = moveStock(d, ctx, { productId: l.productId, warehouseId, qty, type: 'prod_issue', refType: 'production', refId: id, value: x.value, note: noteOf(po, no) });
      lines.push({ productId: l.productId, warehouseId, qty, unitCost: mv.unitCost, value: x.value, movementId: mv.id });
      const a = invAccount(prod.kind);
      debits[a] = r2((debits[a] || 0) + x.value);
    }
    const value = r2(lines.reduce((s, l) => s + l.value, 0)), rid = nid(d, 'MT');
    const journalId = post(d, ctx, { memo: `Production ${po.no}: materials returned ${no}`, refType: 'production', refId: id, dim: whDim(d, po.warehouseId), lines: [...Object.entries(debits).map(([a, x]) => dr(a, x)), cr('wip', value)] });
    (po.returns ||= []).push({ id: rid, no, ts: ctx.now, userId: ctx.userId, lines, value, reason: p.reason.trim(), journalId });
    release(po, { ...zero(), materials: value });
    audit(d, ctx, 'production.return', 'production', id, `${po.no}: ${no}, ${lines.length} line(s) returned: ${p.reason.trim()}`, 'warn');
    return rid;
  });
}
interface Own { materials: Map<ID, Pot>; labor: number; overhead: number }
/**
 * What a receipt of `units` (good + rejected) takes out of the pool, and what of it becomes a variance.
 * - What its own run brought (own) is all its own. Of the rest of the pool it takes, per component, what the BOM needs for these units and at the cost it has there;
 *   of labour and overhead what the estimate says; of anything without a BOM quantity or estimate the share of the units still to make.
 * - A final receipt takes everything. If earlier receipts are still live, what is more than these units need belongs to all the units alike: this receipt carries
 *   its share of that excess and the rest is a variance, so that the last few units do not carry the waste of the whole order.
 */
function takeFor(po: ProductionOrder, units: number, final: boolean, own?: Own): { consumed: ConsumedLine[]; cost: CostElems; variance: CostElems } {
  const gross = grossPerUnit(po.snapshot), left = unitsLeft(po), part = Math.min(1, units / Math.max(units, left)), earlier = live(po.receipts), made = earlier.reduce((s, r) => s + r.good + r.rejected, 0);
  const spread = (excess: number) => (final && made > 0 ? r2(excess - r2((excess * units) / (units + made))) : 0);
  const dust = earlier.length + 1; // what rounding of the earlier receipts can leave behind is not an excess
  const consumed: ConsumedLine[] = [], cost = zero(), variance = zero();
  for (const [productId, pot] of pots(po)) {
    const mine = own?.materials.get(productId) ?? { qty: 0, value: 0 }, rest = { qty: r3(pot.qty - mine.qty), value: r2(pot.value - mine.value) };
    const g = gross.get(productId), need = g === undefined ? undefined : r3(Math.max(0, g * units - mine.qty));
    const x = final ? rest : need === undefined ? draw(rest, rest.qty * part) : draw(rest, need);
    if (final && need !== undefined && rest.qty > need + 0.001 * dust + 1e-9) variance.materials = r2(variance.materials + spread(r2(rest.value - draw(rest, need).value)));
    const line = { productId, qty: r3(mine.qty + x.qty), value: r2(mine.value + x.value) };
    if (line.qty > 0 || line.value > 0) consumed.push(line);
    cost.materials = r2(cost.materials + line.value);
  }
  for (const e of ['labor', 'overhead'] as const) {
    const mine = own?.[e] ?? 0, rest = r2((po.wip?.[e] ?? 0) - mine), per = po.estimate?.[e === 'labor' ? 'laborPerUnit' : 'overheadPerUnit'], need = per == null ? undefined : r2(Math.max(0, per * units - mine));
    if (final && need !== undefined && rest > need + 0.01 * dust + 1e-9) variance[e] = spread(r2(rest - need));
    cost[e] = r2(mine + (final ? rest : need === undefined ? r2(rest * part) : Math.min(rest, need)));
  }
  return { consumed, cost: plus(cost, minus(variance)), variance };
}
export interface ReceiptInput { good: number; rejected: number; warehouseId: ID; final: boolean; note?: string; confirmUnknownCost?: boolean }
function receive(d: DB, ctx: Ctx, po: ProductionOrder, p: ReceiptInput, own?: Own): ID {
  checkRunning(po);
  if (po.status === 'approved') fail('INVALID', 'Issue materials or record a cost before receiving goods');
  openPeriod(d, ctx);
  const prod = product(d, po.productId);
  if (prod.kind === 'menu') fail('INVALID', `${prod.name} is a menu item: it is made when it is sold, so it has no production order`);
  const good = p.good === 0 ? 0 : posQty(p.good), rejected = p.rejected === 0 ? 0 : posQty(p.rejected), units = r3(good + rejected);
  if (!units) fail('INVALID', 'Enter an output and/or waste quantity');
  checkWarehouse(d, p.warehouseId);
  const { consumed, cost, variance } = takeFor(po, units, !!p.final, own), all = total(cost), over = total(variance);
  // goods at zero cost would look like pure profit later: only when somebody said the cost is unknown (here, or when the material was issued and nothing has cost anything yet)
  const unknown = live(po.issues).some((i) => i.lines.some((l) => l.unknownCost)) && !live(po.receipts).some((r) => total(r.cost) > 0);
  if (good > 0 && all <= 0 && !p.confirmUnknownCost && !unknown) {
    fail('NO_COST', 'There is no cost left in this order for these goods. Issue materials, reverse an earlier receipt, or confirm to receive them without a cost');
  }
  const goodValue = r2(all * (good / units)), rejectedValue = r2(all - goodValue), no = docNo(d, 'FGR');
  const m = good > 0 ? moveStock(d, ctx, { productId: po.productId, warehouseId: p.warehouseId, qty: good, type: 'prod_output', refType: 'production', refId: po.id, value: goodValue, note: noteOf(po, no) }) : undefined;
  // one entry for goods, rejects and the variance of a final receipt: its mirror takes all of it back
  const journalId = post(d, ctx, {
    memo: `Production ${po.no}: ${no} ${good} ${prod.unit} ${prod.name}${rejected ? ` (+${rejected} rejected)` : ''}`, refType: 'production', refId: po.id, dim: whDim(d, po.warehouseId),
    lines: [dr(invAccount(prod.kind), goodValue), dr('waste', rejectedValue), ...ELEMS.map((e) => dr(VAR_ROLE[e], variance[e])), cr('wip', r2(all + over))],
  });
  const gid = nid(d, 'GP');
  (po.receipts ||= []).push({
    id: gid, no, ts: ctx.now, userId: ctx.userId, warehouseId: p.warehouseId, good, rejected, cost, consumed, ...(over ? { variance } : {}), goodValue, rejectedValue, unitCost: good > 0 ? r2(goodValue / good) : 0, final: !!p.final, note: p.note, movementId: m?.id, journalId,
  });
  release(po, plus(cost, variance));
  if (p.final) { po.completedAt = ctx.now; po.closedBy = 'receipt'; move(po, ctx, 'completed', no); } else if (po.status !== 'partially_completed') move(po, ctx, 'partially_completed', no);
  audit(d, ctx, 'production.receive', 'production', po.id, `${po.no}: ${no}, ${good} good, ${rejected} rejected${p.final ? ' (final)' : ''}`);
  return gid;
}
export function receiveGoods(d: DB, ctx: Ctx, id: ID, p: ReceiptInput, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'receive', key, stillThere(po.receipts), () => receive(d, ctx, po, p));
}
/** Issue, costs and receipt as one step: inside act() either all of it happens or nothing does. The material and costs of the run belong to its own receipt. */
export function runProduction(d: DB, ctx: Ctx, id: ID, p: IssueInput & ReceiptInput & { conversions: ConversionInput[] }, key?: string): ID {
  guard(d, ctx, 'production:create');
  const po = getOrder(d, id);
  return once(d, 'run', key, stillThere(po.receipts), () => {
    const own: Own = { materials: new Map(), labor: 0, overhead: 0 };
    if (p.lines.length) {
      const iid = issueMaterials(d, ctx, id, p);
      for (const l of po.issues!.find((x) => x.id === iid)!.lines) { const x = own.materials.get(l.productId) ?? { qty: 0, value: 0 }; own.materials.set(l.productId, { qty: r3(x.qty + l.qty), value: r2(x.value + l.value) }); }
    }
    for (const c of p.conversions) { addConversion(d, ctx, id, c); own[elemOf(c.kind)] = r2(own[elemOf(c.kind)] + r2(c.amount)); }
    return receive(d, ctx, po, p, own);
  });
}

// ---------- close, cancel, reopen
/** Cost that can no longer become goods: to the variance account of its element, whatever the sign. Every such entry is kept on the order. */
function writeOffWip(d: DB, ctx: Ctx, po: ProductionOrder, why: 'closed' | 'cancelled') {
  const w = { ...(po.wip ?? zero()) }, consumed = pool(po).materials;
  if (ELEMS.every((e) => w[e] === 0) && !consumed.length) return;
  const lines = ELEMS.map((e) => (w[e] >= 0 ? dr(VAR_ROLE[e], w[e]) : cr(VAR_ROLE[e], -w[e]))), t = total(w);
  const journalId = post(d, ctx, { memo: `Production ${po.no}: cost left when ${why}`, refType: 'production', refId: po.id, dim: whDim(d, po.warehouseId), lines: [...lines, t >= 0 ? cr('wip', t) : dr('wip', -t)] });
  (po.variances ||= []).push({ id: nid(d, 'VE'), ts: ctx.now, userId: ctx.userId, why, cost: w, consumed, journalId });
  release(po, w);
}
/** The variance of a close or cancel taken back: its cost and material are in the order again. */
function undoVariances(d: DB, ctx: Ctx, po: ProductionOrder, reason: string) {
  for (const v of live(po.variances)) {
    v.reversal = { ts: ctx.now, userId: ctx.userId, reason, journalId: mirror(d, ctx, v.journalId, reason) };
    release(po, minus(v.cost));
  }
}
const produced = (po: ProductionOrder) => po.batches.length > 0 || live(po.receipts).length > 0;
export function closeOrder(d: DB, ctx: Ctx, id: ID, note?: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  return once(d, 'close', key, (x) => x === id && po.status === 'completed' && po.closedBy === 'close', () => {
    checkRunning(po);
    if (!produced(po)) fail('INVALID', 'Nothing has been produced yet');
    const left = total(po.wip ?? zero());
    writeOffWip(d, ctx, po, 'closed');
    po.completedAt = ctx.now;
    po.closedBy = 'close';
    move(po, ctx, 'completed', note);
    audit(d, ctx, 'production.close', 'production', id, `${po.no} closed${left ? ', the cost left went to production variance' : ''}${note ? ': ' + note : ''}`, 'warn');
    return id;
  });
}
export function cancelOrder(d: DB, ctx: Ctx, id: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  return once(d, 'cancel', key, (x) => x === id && po.status === 'cancelled', () => {
    if (po.status === 'completed' || po.status === 'cancelled') fail('INVALID', `Order is ${po.status}`);
    if (!reason?.trim()) fail('REASON', 'A reason is required');
    if (produced(po)) fail('INVALID', 'Cannot cancel after production was recorded — close it instead');
    const left = total(po.wip ?? zero());
    writeOffWip(d, ctx, po, 'cancelled');
    move(po, ctx, 'cancelled', reason.trim());
    audit(d, ctx, 'production.cancel', 'production', id, `${po.no} cancelled${left ? ', the cost left went to production variance' : ''}: ${reason.trim()}`, 'warn');
    return id;
  });
}
/** Opens an order that was closed or cancelled again: the variance is reversed and its cost is back in WIP. An order finished by its last receipt is opened by reversing that receipt. */
export function reopenOrder(d: DB, ctx: Ctx, id: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  return once(d, 'reopen', key, (x) => x === id && po.status !== 'completed' && po.status !== 'cancelled' && !!po.events?.some((e) => e.from === 'completed' || e.from === 'cancelled'), () => {
    if (!(po.status === 'cancelled' || (po.status === 'completed' && po.closedBy === 'close'))) fail('INVALID', 'Only an order that was closed or cancelled can be reopened. An order finished by its last receipt is opened by reversing that receipt');
    if (!reason?.trim()) fail('REASON', 'A reason is required');
    openPeriod(d, ctx);
    undoVariances(d, ctx, po, reason.trim());
    po.completedAt = undefined;
    po.closedBy = undefined;
    // an order that was never approved needs its approval as before
    move(po, ctx, produced(po) ? 'partially_completed' : total(po.wip ?? zero()) > 0 || live(po.issues).length ? 'in_progress' : po.approvedBy ? 'approved' : 'planned', reason.trim());
    audit(d, ctx, 'production.reopen', 'production', id, `${po.no} reopened: ${reason.trim()}`, 'warn');
    return id;
  });
}

// ---------- reversals (nothing posted is ever edited or deleted)
function startReversal(d: DB, ctx: Ctx, doc: { reversal?: unknown }, reason: string) {
  if (doc.reversal) fail('ALREADY', 'This entry was already reversed');
  if (!reason?.trim()) fail('REASON', 'A reason is required for a reversal');
  openPeriod(d, ctx);
}
const mirror = (d: DB, ctx: Ctx, journalId: ID | undefined, reason: string) => (journalId ? reverseJournal(d, ctx, journalId, reason, { fromProduction: true }) : undefined);
/** Stock leaves at today's average, the mirror of its document at the old value: the difference is a material variance, in its own entry. Above 0: the stock took out less. */
function postStockDiff(d: DB, ctx: Ctx, po: ProductionOrder, what: string, diffs: Record<string, number>) {
  const list = Object.entries(diffs).filter(([, x]) => x), sum = r2(list.reduce((s, [, x]) => s + x, 0));
  if (!list.length) return;
  post(d, ctx, {
    memo: `Production ${po.no}: average cost difference on the reversal of ${what}`, refType: 'production', refId: po.id, dim: whDim(d, po.warehouseId),
    lines: [...list.map(([a, x]) => (x > 0 ? dr(a, x) : cr(a, -x))), sum > 0 ? cr('prod_var_material', sum) : dr('prod_var_material', -sum)],
  });
}
export function reverseIssue(d: DB, ctx: Ctx, id: ID, issueId: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  const x: MaterialIssue = po.issues?.find((i) => i.id === issueId) || fail('NOT_FOUND', 'Entry not found');
  return once(d, 'reverse_issue', key, (k) => k === issueId && !!x.reversal, () => {
    startReversal(d, ctx, x, reason);
    checkRunning(po);
    const m = pots(po), back = new Map<ID, Pot>();
    for (const l of x.lines) { const b = back.get(l.productId) ?? { qty: 0, value: 0 }; back.set(l.productId, { qty: r3(b.qty + l.qty), value: r2(b.value + l.value) }); }
    for (const [pid, b] of back) {
      // It goes back at the value it left with. That is only right when all of it is still here and what stays behind keeps a cost that material really had.
      const pot = m.get(pid) ?? { qty: 0, value: 0 }, q = r3(pot.qty - b.qty), v = r2(pot.value - b.value);
      const costs = live(po.issues).filter((i) => i.id !== x.id).flatMap((i) => i.lines.filter((l) => l.productId === pid).map((l) => l.unitCost)), slack = q > 0 ? 0.02 / q : 0;
      const right = q === 0 ? v === 0 : q > 0 && v >= 0 && v / q >= Math.min(...costs) - slack && v / q <= Math.max(...costs) + slack;
      if (!right) fail('IN_USE', `${x.no} cannot be reversed: part of its material is already in finished goods, losses or returns. Return the material that is left instead`);
    }
    for (const l of x.lines) moveStock(d, ctx, { productId: l.productId, warehouseId: l.warehouseId, qty: l.qty, type: 'prod_issue', refType: 'production', refId: id, value: l.value, note: noteOf(po, x.no, reason.trim()) });
    const journalId = mirror(d, ctx, x.journalId, reason.trim());
    x.reversal = { ts: ctx.now, userId: ctx.userId, reason: reason.trim(), journalId };
    release(po, { ...zero(), materials: x.value });
    audit(d, ctx, 'production.reverse_issue', 'production', id, `${po.no}: ${x.no} reversed: ${reason.trim()}`, 'warn');
    return issueId;
  });
}
export function reverseReturn(d: DB, ctx: Ctx, id: ID, returnId: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  const x: MaterialReturn = po.returns?.find((i) => i.id === returnId) || fail('NOT_FOUND', 'Entry not found');
  return once(d, 'reverse_return', key, (k) => k === returnId && !!x.reversal, () => {
    startReversal(d, ctx, x, reason);
    checkRunning(po);
    const why = reason.trim(), diffs: Record<string, number> = {};
    for (const l of x.lines) {
      const have = onHand(d, l.warehouseId, l.productId), prod = product(d, l.productId);
      if (have + 1e-6 < l.qty) fail('INSUFFICIENT_STOCK', `Only ${have} of the ${l.qty} ${prod.unit} returned with ${x.no} are still in ${d.warehouses.find((w) => w.id === l.warehouseId)?.name ?? l.warehouseId}. The rest was sold or moved, so this return cannot be reversed`);
      const m = moveStock(d, ctx, { productId: l.productId, warehouseId: l.warehouseId, qty: -l.qty, type: 'prod_issue', refType: 'production', refId: id, note: noteOf(po, x.no, why) }), a = invAccount(prod.kind);
      diffs[a] = r2((diffs[a] || 0) + l.value + m.value);
    }
    const journalId = mirror(d, ctx, x.journalId, why), stockDiff = r2(Object.values(diffs).reduce((s, v) => s + v, 0));
    postStockDiff(d, ctx, po, x.no, diffs);
    x.reversal = { ts: ctx.now, userId: ctx.userId, reason: why, journalId, ...(stockDiff ? { stockDiff } : {}) };
    release(po, { ...zero(), materials: -x.value });
    audit(d, ctx, 'production.reverse_return', 'production', id, `${po.no}: ${x.no} reversed: ${why}`, 'warn');
    return returnId;
  });
}
export function reverseConversion(d: DB, ctx: Ctx, id: ID, entryId: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  const x: ConversionEntry = po.conversions?.find((i) => i.id === entryId) || fail('NOT_FOUND', 'Entry not found');
  return once(d, 'reverse_cost', key, (k) => k === entryId && !!x.reversal, () => {
    startReversal(d, ctx, x, reason);
    checkRunning(po);
    const e = elemOf(x.kind);
    if ((po.wip?.[e] ?? 0) < x.amount) fail('IN_USE', 'This cost cannot be reversed: it has already gone into finished goods or losses');
    const journalId = mirror(d, ctx, x.journalId, reason.trim());
    x.reversal = { ts: ctx.now, userId: ctx.userId, reason: reason.trim(), journalId };
    release(po, { ...zero(), [e]: x.amount });
    audit(d, ctx, 'production.reverse_cost', 'production', id, `${po.no}: ${x.kind} cost reversed: ${reason.trim()}`, 'warn');
    return entryId;
  });
}
export function reverseLoss(d: DB, ctx: Ctx, id: ID, lossId: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  const x: LossEntry = po.losses?.find((i) => i.id === lossId) || fail('NOT_FOUND', 'Entry not found');
  return once(d, 'reverse_loss', key, (k) => k === lossId && !!x.reversal, () => {
    startReversal(d, ctx, x, reason);
    checkRunning(po);
    const journalId = mirror(d, ctx, x.journalId, reason.trim());
    x.reversal = { ts: ctx.now, userId: ctx.userId, reason: reason.trim(), journalId };
    release(po, minus(x.cost));
    audit(d, ctx, 'production.reverse_loss', 'production', id, `${po.no}: loss reversed: ${reason.trim()}`, 'warn');
    return lossId;
  });
}
/**
 * Takes the goods out again and gives the order its original cost (and the material it stands for) back, with the variance of a final receipt.
 * If the order was closed since, the variance of the close is taken back first: that cost belongs to the open order again.
 */
export function reverseReceipt(d: DB, ctx: Ctx, id: ID, receiptId: ID, reason: string, key?: string): ID {
  guard(d, ctx, 'production:approve');
  const po = getOrder(d, id);
  const x: GoodsProduced = po.receipts?.find((i) => i.id === receiptId) || fail('NOT_FOUND', 'Entry not found');
  return once(d, 'reverse_receipt', key, (k) => k === receiptId && !!x.reversal, () => {
    startReversal(d, ctx, x, reason);
    const why = reason.trim(), prod = product(d, po.productId), inv = invAccount(prod.kind);
    let stockDiff = 0;
    if (x.good > 0) {
      // goods that were sold or moved cannot be un-made, even where negative stock is allowed
      const have = onHand(d, x.warehouseId, po.productId);
      if (have + 1e-6 < x.good) fail('INSUFFICIENT_STOCK', `Only ${have} of the ${x.good} ${prod.unit} received with ${x.no} are still in ${d.warehouses.find((w) => w.id === x.warehouseId)?.name ?? x.warehouseId}. The rest was sold or moved, so this receipt cannot be reversed`);
      const m = moveStock(d, ctx, { productId: po.productId, warehouseId: x.warehouseId, qty: -x.good, type: 'prod_output', refType: 'production', refId: id, note: noteOf(po, x.no, why) });
      stockDiff = r2(x.goodValue + m.value);
    }
    if (po.status === 'completed') undoVariances(d, ctx, po, why);
    const journalId = mirror(d, ctx, x.journalId, why);
    postStockDiff(d, ctx, po, x.no, { [inv]: stockDiff });
    x.reversal = { ts: ctx.now, userId: ctx.userId, reason: why, journalId, ...(stockDiff ? { stockDiff } : {}) };
    release(po, minus(plus(x.cost, x.variance ?? zero())));
    const back = produced(po) ? 'partially_completed' : 'in_progress';
    if (po.status === 'completed') { po.completedAt = undefined; po.closedBy = undefined; }
    if (po.status !== back) move(po, ctx, back, `${x.no}: ${why}`);
    audit(d, ctx, 'production.reverse_receipt', 'production', id, `${po.no}: ${x.no} reversed, ${x.good} good, ${x.rejected} rejected: ${why}`, 'warn');
    return receiptId;
  });
}

// ---------- read
/** Everything charged to an order (less what was returned) and where it went; reversed documents are left out, batches of the older flow are included. */
export function orderTotals(po: ProductionOrder) {
  const rc = live(po.receipts), sum = <T>(l: T[], f: (x: T) => number) => l.reduce((s, x) => s + f(x), 0);
  const conv = (e: keyof CostElems) => sum(live(po.conversions).filter((c) => elemOf(c.kind) === e), (c) => c.amount);
  const bc = sum(po.batches, (b) => b.conversionCost), lo = po.snapshot.laborCost + po.snapshot.overheadCost;
  const bLabor = lo > 0 ? r2((bc * po.snapshot.laborCost) / lo) : 0; // a batch keeps labour and overhead in one figure: split as in its BOM
  const good = r3(sum(rc, (r) => r.good) + sum(po.batches, (b) => b.outputQty)), rejected = r3(sum(rc, (r) => r.rejected) + sum(po.batches, (b) => b.wasteQty));
  const goodValue = r2(sum(rc, (r) => r.goodValue) + sum(po.batches, (b) => b.materialCost + b.conversionCost - b.wasteCost)), returned = r2(sum(live(po.returns), (r) => r.value));
  const materials = r2(sum(live(po.issues), (i) => i.value) - returned + sum(po.batches, (b) => b.materialCost)), labor = r2(conv('labor') + bLabor), overhead = r2(conv('overhead') + bc - bLabor);
  const wip = { ...(po.wip ?? zero()) }, variance = [...live(po.variances).map((v) => v.cost), ...rc.map((r) => r.variance ?? zero())].reduce(plus, zero());
  return {
    good, rejected, units: r3(good + rejected), remaining: unitsLeft(po),
    materials, labor, overhead, charged: r2(materials + labor + overhead), returned,
    goodValue, rejectedValue: r2(sum(rc, (r) => r.rejectedValue) + sum(po.batches, (b) => b.wasteCost)), lossValue: r2(sum(live(po.losses), (l) => l.amount)),
    variance, wip, wipTotal: total(wip), unitCost: good > 0 ? r2(goodValue / good) : null,
  };
}
export interface Shortage { productId: ID; name: string; unit: string; required: number; issued: number; need: number; onHand: number; elsewhere: number; short: number }
/** Components for the output still to make that are neither in the order (`issued`: its pool) nor in its warehouse. `elsewhere`: what the other warehouses hold (issue from there, or transfer). */
export function shortages(d: DB, po: ProductionOrder): Shortage[] {
  if (po.status === 'completed' || po.status === 'cancelled') return [];
  const m = pots(po), out: Shortage[] = [];
  for (const { productId, qty: required } of bomRequirement(po.snapshot, unitsLeft(po))) {
    const p = d.products.find((x) => x.id === productId), issued = m.get(productId)?.qty ?? 0, need = r3(Math.max(0, required - issued)), here = onHand(d, po.warehouseId, productId);
    const short = r3(need - Math.max(0, here));
    if (short <= 0.0005) continue;
    let elsewhere = 0;
    for (const w of d.warehouses) if (w.id !== po.warehouseId) elsewhere += Math.max(0, onHand(d, w.id, productId));
    out.push({ productId, name: p?.name ?? productId, unit: p?.unit ?? '', required, issued, need, onHand: here, elsewhere: r3(elsewhere), short });
  }
  return out;
}
const countOf = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
/** What a run of `units` should add to what is already in the order: material per component (0 when there is enough) and costs by kind. A cost nobody knows is left out. */
export function runDefaults(_d: DB, po: ProductionOrder, units: number): { lines: { productId: ID; qty: number }[]; conversions: { kind: ConversionEntry['kind']; amount: number }[] } {
  const n = countOf(units), m = pots(po), v = po.snapshot, per = n / (v.yieldQty || 1), have = { labor: po.wip?.labor ?? 0, overhead: po.wip?.overhead ?? 0 };
  const other = (k: 'utilities' | 'other') => (v.otherCosts ?? []).filter((x) => x.kind === k).reduce((s, x) => s + x.amount, 0);
  const want: [ConversionEntry['kind'], number][] = [['labor', v.laborKnown === false ? 0 : v.laborCost], ['overhead', v.overheadKnown === false ? 0 : v.overheadCost], ['utilities', other('utilities')], ['other', other('other')]];
  const conversions: { kind: ConversionEntry['kind']; amount: number }[] = [];
  for (const [kind, cost] of want) {
    const e = elemOf(kind), need = r2(cost * per), used = Math.min(have[e], need);
    have[e] = r2(have[e] - used);
    if (r2(need - used) > 0) conversions.push({ kind, amount: r2(need - used) });
  }
  return { lines: bomRequirement(v, n).map((x) => ({ productId: x.productId, qty: r3(Math.max(0, x.qty - (m.get(x.productId)?.qty ?? 0))) })), conversions };
}
export interface Missing {
  materials: { productId: ID; name: string; unit: string; need: number; have: number; missing: number }[];
  conversions: { element: 'labor' | 'overhead'; need: number; have: number; missing: number }[];
  unknown: ('labor' | 'overhead')[];
}
/** What the BOM expects for a receipt of `units` and the order does not hold: the goods would be received without that cost. `unknown`: elements without an estimate. */
export function expectedMissing(d: DB, po: ProductionOrder, units: number): Missing {
  const n = countOf(units), m = pots(po), out: Missing = { materials: [], conversions: [], unknown: [] };
  for (const { productId, qty: need } of bomRequirement(po.snapshot, n)) {
    const p = d.products.find((x) => x.id === productId), have = m.get(productId)?.qty ?? 0;
    if (need - have > 0.0015) out.materials.push({ productId, name: p?.name ?? productId, unit: p?.unit ?? '', need, have, missing: r3(need - have) });
  }
  for (const element of ['labor', 'overhead'] as const) {
    const per = po.estimate?.[element === 'labor' ? 'laborPerUnit' : 'overheadPerUnit'], have = po.wip?.[element] ?? 0;
    if (per == null) { out.unknown.push(element); continue; }
    const need = r2(per * n);
    if (need - have > 0.015) out.conversions.push({ element, need, have, missing: r2(need - have) });
  }
  return out;
}
