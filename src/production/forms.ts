// What the production screens need to know and React does not: no figure is computed here that the engine (domain/bom, production, productionAnalysis) already computes.
import { produce } from 'immer';
import type { Bom, BomComponent, BomVersion, ConversionEntry, CostElems, DB, ID, Journal, Movement, Product, ProductionOrder, ProductionReversal } from '../domain/types';
import type { Ctx } from '../domain/core';
import { resolveLine } from '../domain/accounting';
import { bomRequirement, bomState, validateBom } from '../domain/bom';
import { onHand } from '../domain/inventory';
import { expectedMissing, orderTotals, runDefaults, shortages, unitsLeft, type ConversionInput, type Missing } from '../domain/production';
import { dayKey, r2, r3 } from '../lib/util';

/** One key for one opened form or one confirmed action: sent again (a double tap, a retry) it posts nothing more. */
export const newKey = (): string => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);

// ---------- product search
export const PICKER_ROWS = 50;
/** The first 50 products for a search text, the best match first; those that cannot be chosen go last. */
export function searchProducts(list: Product[], q: string, blocked: (p: Product) => boolean = () => false): { rows: Product[]; total: number } {
  const s = q.trim().toLowerCase(), words = s.split(/\s+/).filter(Boolean);
  const hit = list.filter((p) => { const t = `${p.name} ${p.sku} ${p.legacySku ?? ''} ${p.barcode ?? ''} ${p.brand ?? ''} ${p.category}`.toLowerCase(); return words.every((w) => t.includes(w)); });
  const rank = (p: Product) => (s && [p.sku, p.legacySku, p.barcode].some((c) => c?.toLowerCase() === s) ? 0 : 8) + (blocked(p) ? 4 : 0) + (s && p.name.toLowerCase().startsWith(s) ? 0 : 2) + (p.active ? 0 : 1);
  const sorted = hit.map((p) => ({ p, r: rank(p) })).sort((a, b) => a.r - b.r || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0));
  return { rows: sorted.slice(0, PICKER_ROWS).map((x) => x.p), total: hit.length };
}

// ---------- BOM form (NaN = an empty number field)
export interface BomForm {
  yieldQty: number; components: BomComponent[]; laborKnown: boolean; laborCost: number; overheadKnown: boolean; overheadCost: number; otherCosts: NonNullable<BomVersion['otherCosts']>; notes: string;
}
export const EMPTY_BOM: BomForm = { yieldQty: 1, components: [], laborKnown: false, laborCost: 0, overheadKnown: false, overheadCost: 0, otherCosts: [], notes: '' };
export const formOf = (v: BomVersion): BomForm => ({
  yieldQty: v.yieldQty, components: v.components.map((c) => ({ ...c, entry: c.entry && { ...c.entry } })), laborKnown: v.laborKnown !== false, laborCost: v.laborCost,
  overheadKnown: v.overheadKnown !== false, overheadCost: v.overheadCost, otherCosts: (v.otherCosts ?? []).map((x) => ({ ...x })), notes: v.notes ?? '',
});
export function versionOf(f: BomForm): BomVersion {
  const components = f.components.map((c) => {
    const x: BomComponent = { productId: c.productId, role: c.role, qty: c.entry ? c.entry.qty * c.entry.factor : c.qty };
    if (c.wastePct) x.wastePct = c.wastePct;
    if (c.entry) x.entry = { ...c.entry, unit: c.entry.unit.trim() };
    return x;
  });
  return {
    version: 0, status: 'draft', effectiveFrom: '', createdAt: '', yieldQty: f.yieldQty, components, laborKnown: f.laborKnown, laborCost: f.laborKnown ? f.laborCost : 0,
    overheadKnown: f.overheadKnown, overheadCost: f.overheadKnown ? f.overheadCost : 0, otherCosts: f.otherCosts, notes: f.notes.trim() || undefined,
  };
}
export interface BomProblems { batch: string[]; costs: string[]; list: string[]; rows: string[][] }
export const problemCount = (b: BomProblems) => b.batch.length + b.costs.length + b.list.length + b.rows.reduce((s, r) => s + r.length, 0);
const YIELD = 'The batch yield must be greater than 0', COSTS = ['Costs must be 0 or more', 'A menu item has no other costs. Put the cost into labour or overhead'];
/** The messages of the engine (validateBom), each at the place it is about. */
export function bomProblems(d: DB, productId: ID, v: BomVersion): BomProblems {
  const gone = `Product ${productId} not found`, known = d.products.some((p) => p.id === productId);
  const head = validateBom(d, productId, { ...v, components: [] }).filter((m) => m !== gone);
  const name = (id: ID) => d.products.find((p) => p.id === id)?.name ?? id;
  const rows = v.components.map((c, i) => [
    ...validateBom(d, productId, { yieldQty: 1, laborCost: 0, overheadCost: 0, components: [c] }).filter((m) => known || m !== gone),
    ...(v.components.slice(0, i).some((x) => x.productId === c.productId) ? [`${name(c.productId)} is listed more than once`] : []),
  ]);
  return { batch: head.filter((m) => m === YIELD), costs: head.filter((m) => COSTS.includes(m)), list: v.components.length ? [] : head.filter((m) => m !== YIELD && !COSTS.includes(m)), rows };
}
/** The version people mean when they speak of a BOM: the one in use today, else the one that starts next, else the latest draft. */
export function shownVersion(b: Bom): BomVersion | undefined {
  const st = bomState(b, new Date().toISOString()), by = [...b.versions].sort((x, y) => y.version - x.version);
  return by.find((v) => st[v.version] === 'in_use') ?? by.find((v) => st[v.version] === 'scheduled') ?? by[0];
}
/** What a BOM is as a whole: its own status, else whether a version is in use, starts later, or is a draft only. */
export function bomListState(b: Bom): 'draft' | 'scheduled' | 'active' | 'inactive' | 'archived' {
  if (b.status === 'inactive' || b.status === 'archived') return b.status;
  const st = Object.values(bomState(b, new Date().toISOString()));
  return st.includes('in_use') ? 'active' : st.includes('scheduled') ? 'scheduled' : 'draft';
}
/** BOMs an order can be made from (the rules of createOrder): in use today, for an active product that is not a menu item. */
export function usableBoms(d: DB): { b: Bom; p: Product; v: BomVersion }[] {
  return d.boms.flatMap((b) => {
    const p = d.products.find((x) => x.id === b.productId), v = shownVersion(b);
    return p && v && p.active && p.kind !== 'menu' && bomListState(b) === 'active' ? [{ b, p, v }] : [];
  });
}
/** Where to produce: the warehouse with most of the components in full, then with anything, then the central one. */
export function bestWarehouse(d: DB, v: BomVersion, qty: number): ID {
  const need = bomRequirement(v, qty);
  const score = (w: DB['warehouses'][number]) => need.reduce((s, n) => { const h = onHand(d, w.id, n.productId); return s + (h + 1e-6 >= n.qty ? 10 : h > 0 ? 5 : 0); }, 0) + (w.kind === 'central' ? 1 : 0);
  return [...d.warehouses].sort((a, b) => score(b) - score(a))[0]?.id ?? '';
}

// ---------- what a receipt would miss
const elemOf = (k: ConversionEntry['kind']) => (k === 'labor' ? 'labor' : 'overhead');
/** What the BOM expects for `units` and neither the order holds nor this run brings: the goods would be received without that cost. */
export function stillMissing(d: DB, po: ProductionOrder, units: number, own?: { lines: { productId: ID; qty: number }[]; conversions: ConversionInput[] }): Missing {
  const m = expectedMissing(d, po, units), bring = (id: ID) => (own?.lines ?? []).reduce((x, l) => x + (l.productId === id && l.qty > 0 ? l.qty : 0), 0);
  const cost = (e: 'labor' | 'overhead') => (own?.conversions ?? []).reduce((x, c) => x + (elemOf(c.kind) === e && c.amount > 0 ? c.amount : 0), 0);
  return {
    materials: m.materials.map((x) => ({ ...x, missing: r3(x.missing - bring(x.productId)) })).filter((x) => x.missing > 0.0015),
    conversions: m.conversions.map((x) => ({ ...x, missing: r2(x.missing - cost(x.element)) })).filter((x) => x.missing > 0.015),
    unknown: m.unknown.filter((e) => !(cost(e) > 0) && !((po.wip?.[e] ?? 0) > 0)),
  };
}
export const missesAnything = (m: Missing) => m.materials.length + m.conversions.length + m.unknown.length > 0;

// ---------- what a posting will do
export interface Effect { movements: Movement[]; journals: Journal[] }
/** Runs the engine on a copy that is thrown away: the stock movements and journals it would post, or the reason it refuses. Nothing is saved. */
export function dryRun(d: DB, fn: (d: DB, ctx: Ctx) => unknown): { effect?: Effect; next?: DB; error?: Error & { code?: string } } {
  try {
    const next = produce(d, (x) => { fn(x as DB, { now: new Date().toISOString(), userId: d.meta.currentUserId }); }) as DB;
    return { next, effect: { movements: next.movements.slice(d.movements.length), journals: next.journals.slice(d.journals.length) } };
  } catch (e) { return { error: e as Error & { code?: string } }; }
}
export function effectOf(e: Effect) {
  const entries: { account: string; debit: number; credit: number }[] = [];
  for (const j of e.journals) for (const l of j.lines) {
    const x = entries.find((y) => y.account === l.account && (y.debit > 0) === (l.debit > 0));
    if (x) { x.debit = r2(x.debit + l.debit); x.credit = r2(x.credit + l.credit); } else entries.push({ account: l.account, debit: l.debit, credit: l.credit });
  }
  return {
    stock: e.movements.map((m) => ({ productId: m.productId, warehouseId: m.warehouseId, qty: m.qty, value: m.value })), entries,
    unknown: e.movements.filter((m) => m.type === 'prod_issue' && m.qty < 0 && !(m.value < 0)).map((m) => m.productId),
  };
}
/** The cost the newest receipt of an order took (after a dry run): what goes into the goods, into waste, and what of a final receipt is a production variance. */
export function receiptFacts(d: DB, orderId: ID) {
  const r = d.productionOrders.find((o) => o.id === orderId)?.receipts?.at(-1);
  if (!r) return null;
  const sum = (c?: CostElems) => r2(c ? c.materials + c.labor + c.overhead : 0);
  return { cost: sum(r.cost), good: r.good, rejected: r.rejected, goodValue: r.goodValue, rejectedValue: r.rejectedValue, unitCost: r.unitCost, variance: sum(r.variance) };
}
/** Posting roles a production order needs that are not mapped, or mapped to an account that cannot be posted to today. */
export function missingRoles(d: DB): string[] {
  const now = new Date().toISOString();
  return ['wip', 'inv_materials', 'inv_goods', 'waste', 'conversion_absorbed', 'prod_var_material', 'prod_var_labor', 'prod_var_overhead'].filter((r) => { try { resolveLine(d, r, now); return false; } catch { return true; } });
}

// ---------- reading orders
export type OrderView = 'all' | 'open' | 'progress' | 'short' | 'done' | 'costed';
export const ORDER_CARDS: OrderView[] = ['open', 'progress', 'short', 'done'];
const finished = (o: ProductionOrder) => o.status === 'completed' || o.status === 'cancelled';
export const isRunning = (o: ProductionOrder) => o.status === 'approved' || o.status === 'in_progress' || o.status === 'partially_completed';
export function orderMatches(d: DB, o: ProductionOrder, v: OrderView): boolean {
  switch (v) {
    case 'open': return !finished(o);
    case 'progress': return o.status === 'in_progress' || o.status === 'partially_completed';
    case 'short': return shortages(d, o).length > 0;
    case 'done': return o.status === 'completed';
    case 'costed': return o.status === 'completed' && !!o.estimate && o.estimate.materialsPerUnit != null && o.estimate.laborPerUnit != null && o.estimate.overheadPerUnit != null; // the orders the cost figures of the overview compare
    default: return true;
  }
}
export const STATUS: Record<ProductionOrder['status'], { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | '' }> = {
  draft: { label: 'Draft order', tone: '' }, planned: { label: 'Planned order', tone: 'info' }, approved: { label: 'Approved for production', tone: 'info' }, in_progress: { label: 'In production', tone: 'warn' },
  partially_completed: { label: 'Partly received', tone: 'warn' }, completed: { label: 'Production completed', tone: 'good' }, cancelled: { label: 'Cancelled order', tone: 'bad' },
};
/** The steps of an order. A draft or a partial receipt is a step only for an order that has been one. */
export function stepsOf(po: ProductionOrder): { status: ProductionOrder['status']; state: '' | 'done' | 'now' }[] {
  const was = (s: string) => po.status === s || !!po.events?.some((e) => e.to === s || e.from === s);
  const all = (['draft', 'planned', 'approved', 'in_progress', 'partially_completed', 'completed'] as const).filter((s) => (s !== 'draft' && s !== 'partially_completed') || was(s));
  if (po.status === 'cancelled') return [...all.filter((s) => s !== 'completed' && was(s)).map((status) => ({ status, state: 'done' as const })), { status: 'cancelled', state: 'now' }];
  const at = all.indexOf(po.status);
  return all.map((status, i) => ({ status, state: i < at ? 'done' : i === at ? 'now' : '' }));
}
export type NextStep = 'plan' | 'approve' | 'run' | 'receive' | 'finish' | 'done' | 'cancelled';
/** What to do next. While the BOM still expects material or a cost for what is left to make (after rejects as well), that comes first: goods are never the next step without it. */
export function nextStep(d: DB, po: ProductionOrder): NextStep {
  if (po.status === 'draft') return 'plan';
  if (po.status === 'planned') return 'approve';
  if (po.status === 'completed') return 'done';
  if (po.status === 'cancelled') return 'cancelled';
  const need = runDefaults(d, po, unitsLeft(po));
  if (po.status === 'approved' || need.lines.some((l) => l.qty > 0) || need.conversions.length) return 'run';
  return po.status === 'partially_completed' ? 'finish' : 'receive';
}
/** Material the BOM asks for to make what is left, less what is in the order already. */
export const leftToIssue = (d: DB, po: ProductionOrder) => runDefaults(d, po, unitsLeft(po)).lines.filter((l) => l.qty > 0);

export type DocKind = 'issue' | 'return' | 'cost' | 'loss' | 'receipt' | 'variance' | 'batch';
export interface DocLine { productId: ID; warehouseId: ID; qty: number; unitCost: number; value: number }
export interface ProdDoc {
  kind: DocKind; id: ID; no: string; ts: string; userId?: ID; note?: string; value: number; journalId?: ID; reversal?: ProductionReversal; why?: 'closed' | 'cancelled'; variance?: number;
  cost?: ConversionEntry['kind']; lines?: DocLine[]; good?: number; rejected?: number; warehouseId?: ID; unitCost?: number; final?: boolean;
}
const sumElems = (c?: CostElems) => r2(c ? c.materials + c.labor + c.overhead : 0);
/** Every document of an order, newest first, reversed ones included. `variance` is the cost left when it was closed or cancelled, `batch` a run of the older single-step flow. */
export function docsOf(po: ProductionOrder): ProdDoc[] {
  const out: ProdDoc[] = [
    ...(po.issues ?? []).map((i): ProdDoc => ({ kind: 'issue', id: i.id, no: i.no, ts: i.ts, userId: i.userId, value: i.value, journalId: i.journalId, reversal: i.reversal, lines: i.lines })),
    ...(po.conversions ?? []).map((c): ProdDoc => ({ kind: 'cost', id: c.id, no: '', ts: c.ts, userId: c.userId, note: c.note, value: c.amount, journalId: c.journalId, reversal: c.reversal, cost: c.kind })),
    ...(po.losses ?? []).map((l): ProdDoc => ({ kind: 'loss', id: l.id, no: '', ts: l.ts, userId: l.userId, note: l.note, value: l.amount, journalId: l.journalId, reversal: l.reversal })),
    ...(po.returns ?? []).map((r): ProdDoc => ({ kind: 'return', id: r.id, no: r.no, ts: r.ts, userId: r.userId, note: r.reason, value: r.value, journalId: r.journalId, reversal: r.reversal, lines: r.lines })),
    ...(po.receipts ?? []).map((r): ProdDoc => ({ kind: 'receipt', id: r.id, no: r.no, ts: r.ts, userId: r.userId, note: r.note, value: r2(r.goodValue + r.rejectedValue), journalId: r.journalId, reversal: r.reversal, good: r.good, rejected: r.rejected, warehouseId: r.warehouseId, unitCost: r.unitCost, final: r.final, variance: sumElems(r.variance) })),
    ...(po.variances ?? []).map((v): ProdDoc => ({ kind: 'variance', id: v.id, no: '', ts: v.ts, userId: v.userId, value: sumElems(v.cost), journalId: v.journalId, reversal: v.reversal, why: v.why })),
    ...po.batches.map((b, i): ProdDoc => ({ kind: 'batch', id: `${po.id}-b${i}`, no: '', ts: b.ts, value: r2(b.materialCost + b.conversionCost), journalId: b.journalId, good: b.outputQty, rejected: b.wasteQty, unitCost: b.unitCost, warehouseId: po.warehouseId })),
  ];
  return newest(out);
}
/** Newest first; within one moment the later step first. */
function newest<T extends { ts: string }>(list: T[]): T[] { return list.map((x, i) => ({ x, i })).sort((a, b) => (a.x.ts < b.x.ts ? 1 : a.x.ts > b.x.ts ? -1 : b.i - a.i)).map((y) => y.x); }
/** One line of material or goods with everything needed to follow it: order, document, BOM version, quantity, place, user, cost and journal. */
export interface TraceRow {
  id: string; kind: 'issue' | 'return' | 'receipt' | 'batch'; ts: string; userId?: ID; orderId: ID; orderNo: string; outputId: ID; no: string; bomVersion: number; productId: ID; warehouseId: ID; qty: number; rejected?: number;
  unitCost: number; value: number; journalId?: ID; reversal?: ProductionReversal; final?: boolean; note?: string;
}
export function traceOf(d: DB): TraceRow[] {
  return newest(d.productionOrders.flatMap((o) => docsOf(o).reverse().flatMap((x): TraceRow[] => {
    const base = { ts: x.ts, userId: x.userId, orderId: o.id, orderNo: o.no, outputId: o.productId, no: x.no, bomVersion: o.snapshot.version, journalId: x.journalId, reversal: x.reversal, note: x.note };
    if (x.kind === 'issue' || x.kind === 'return') return x.lines!.map((l, i) => ({ ...base, id: `${x.id}-${i}`, kind: x.kind as 'issue', productId: l.productId, warehouseId: l.warehouseId, qty: l.qty, unitCost: l.unitCost, value: l.value }));
    if (x.kind === 'receipt' || x.kind === 'batch') return [{ ...base, id: x.id, kind: x.kind, productId: o.productId, warehouseId: x.warehouseId!, qty: x.good ?? 0, rejected: x.rejected, unitCost: x.unitCost ?? 0, value: x.value, final: x.final }];
    return [];
  })));
}
/** Every journal entry of an order, oldest first, with the mirrors of those that were reversed. */
export function journalsOf(d: DB, po: ProductionOrder): Journal[] {
  const own = d.journals.filter((j) => j.refType === 'production' && j.refId === po.id), ids = new Set(own.map((j) => j.id));
  return d.journals.filter((j) => ids.has(j.id) || (j.reverses && ids.has(j.reverses)));
}
export interface HistoryRow {
  id: string; ts: string; userId?: ID; kind: 'status' | DocKind | 'reversal' | 'bom'; orderId?: ID; orderNo?: string; bomId?: ID; bomVersion?: number; productId?: ID; no: string; label: string; what?: ProductionOrder['status']; note?: string;
  /** stock movement: above 0 in, below 0 out */ qty?: number; warehouseId?: ID; unitCost?: number; value?: number; journalId?: ID; cost?: ConversionEntry['kind'];
}
const DOC_LABEL: Record<DocKind, string> = { issue: 'Materials issued', return: 'Materials returned', cost: 'Cost recorded', loss: 'Abnormal loss', receipt: 'Finished goods received', variance: 'Cost left posted as variance', batch: 'Production recorded' };
export const docLabel = (x: { kind: DocKind }) => DOC_LABEL[x.kind];
const BOM_LABEL: Record<string, string> = { 'bom.create': 'BOM created', 'bom.update': 'BOM draft saved', 'bom.activate': 'BOM version activated', 'bom.discard': 'BOM draft discarded', 'bom.duplicate': 'BOM copied', 'bom.status': 'BOM status changed' };
/** Everything that happened in production, newest first: steps of the orders, every line of their documents, reversals, and the changes of the BOMs. */
export function historyOf(d: DB): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (const o of d.productionOrders) {
    const base = { orderId: o.id, orderNo: o.no, bomVersion: o.snapshot.version, productId: o.productId };
    if (!o.events?.length) out.push({ ...base, id: `${o.id}-c`, ts: o.createdAt, userId: o.createdBy, kind: 'status', no: '', label: 'Order created' });
    (o.events ?? []).forEach((e, i) => out.push({ ...base, id: `${o.id}-e${i}`, ts: e.ts, userId: e.userId, kind: 'status', no: '', label: e.from ? 'Status changed' : 'Order created', what: e.to as ProductionOrder['status'], note: e.note }));
    for (const x of docsOf(o).reverse()) {
      const doc = { ...base, ts: x.ts, userId: x.userId, kind: x.kind, no: x.no, label: docLabel(x), note: x.note, journalId: x.journalId, cost: x.cost }, sign = x.kind === 'issue' ? -1 : 1;
      const lines: Partial<HistoryRow>[] = x.lines ? x.lines.map((l) => ({ productId: l.productId, warehouseId: l.warehouseId, qty: sign * l.qty, unitCost: l.unitCost, value: l.value }))
        : [{ value: x.value, ...(x.good !== undefined ? { qty: x.good, warehouseId: x.warehouseId, unitCost: x.unitCost } : {}) }];
      lines.forEach((l, i) => out.push({ ...doc, ...l, id: `${x.id}-${i}` }));
      if (x.reversal) lines.forEach((l, i) => out.push({ ...doc, ...l, id: `${x.id}-${i}-r`, kind: 'reversal', label: 'Entry reversed', ts: x.reversal!.ts, userId: x.reversal!.userId, note: x.reversal!.reason, journalId: x.reversal!.journalId, qty: l.qty === undefined ? undefined : -l.qty }));
    }
  }
  for (const a of d.audit) if (a.entity === 'bom' && BOM_LABEL[a.action]) { const b = d.boms.find((x) => x.id === a.entityId); out.push({ id: a.id, ts: a.ts, userId: a.userId, kind: 'bom', bomId: b?.id, productId: b?.productId, no: '', label: BOM_LABEL[a.action] }); }
  return newest(out);
}

// ---------- texts the engine stores in English
type Tr = (s: string, v?: Record<string, string | number>) => string;
const COPIED = /^Copied from ([\s\S]+) v(\d+)$/, BASED = /^Draft based on v(\d+)$/;
/** A note the engine wrote, not a person. */
export const isEngineNote = (s: string) => COPIED.test(s) || BASED.test(s);
/** The same text in the language of the screen; anything a person wrote stays as it is. */
export function engineText(T: Tr, s: string): string {
  const c = COPIED.exec(s), b = BASED.exec(s);
  if (c) return T('Copied from {name} v{v}', { name: c[1], v: c[2] });
  if (b) return T('Draft based on v{v}', { v: b[1] });
  return s.replace(/(\(BOM v\d+\)): reversed, /, (_, x: string) => `${x}: ${T('reversed')}, `);
}
