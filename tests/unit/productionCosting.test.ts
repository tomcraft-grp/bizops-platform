// Costs follow the physical material (POL-24): what a receipt takes, what stays in the order, what becomes a variance, and that every way back leads to the same ledger.
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { at, ctx } from '../helpers';
import { W, add, glCode, po, put, session, sound } from '../production';
import { activateVersion, bomState, createBom, duplicateBom, newDraftVersion, setBomStatus, updateDraft, validateBom } from '../../src/domain/bom';
import {
  addConversion, approveOrder, cancelOrder, closeOrder, createOrder, expectedMissing, issueMaterials, orderTotals, pool, receiveGoods, recordLoss, reopenOrder, returnMaterials, reverseConversion, reverseIssue,
  reverseLoss, reverseReceipt, reverseReturn, runDefaults, runProduction, shortages, unitsLeft,
} from '../../src/domain/production';
import { adjustStock, onHand } from '../../src/domain/inventory';
import { setMappingDirect, reconciliationMatrix, saveAccount, validateCoa } from '../../src/domain/setup';
import { businessCosts, businessDeductions } from '../../src/domain/economics';
import { thaiForError } from '../../src/lib/errorText';
import type { DB, ID, ProductKind } from '../../src/domain/types';
import { r2 } from '../../src/lib/util';

const THAI = /[ก-๿]/;
const u = (userId: string) => ({ ...ctx, userId });
type S = ReturnType<typeof session> & { bom: ID };
/** One unit of FG = one A; labour and overhead as given. */
function one(o: { labor?: number; overhead?: number; laborKnown?: boolean; qty?: number } = {}): S {
  const s = session((d) => { put(d, 'A', 1000, 10); createBom(d, ctx, { productId: 'FG', name: 'FG', type: 'manufacturing', yieldQty: 1, components: [{ productId: 'A', qty: o.qty ?? 1, role: 'material' }], laborCost: o.labor ?? 0, overheadCost: o.overhead ?? 0, laborKnown: o.laborKnown }); });
  return Object.assign(s, { bom: s.db.boms[0].id });
}
const order = (s: S, plannedQty = 100, bom = s.bom): ID => s.do((d) => { const id = createOrder(d, ctx, { bomId: bom, plannedQty, warehouseId: W }); approveOrder(d, ctx, id); return id; });
const price = (s: S, pid: ID, cost: number, qty = 1000) => s.do((d) => { const h = onHand(d, W, pid); if (h) adjustStock(d, ctx, { productId: pid, warehouseId: W, qty: -h, reason: 'out' }); put(d, pid, qty, cost); });
const run = (s: S, id: ID, lines: { productId: ID; qty: number }[], good: number, final = false, o: object = {}) => s.do((d) => runProduction(d, ctx, id, { lines, conversions: [], good, rejected: 0, warehouseId: W, final, ...o }));
const issue = (s: S, id: ID, qty: number, productId = 'A') => s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId, qty }] }));
const get = (s: S, id: ID, good: number, final = false, rejected = 0) => s.do((d) => receiveGoods(d, ctx, id, { good, rejected, warehouseId: W, final }));
const units = (s: S, id: ID) => po(s.db, id).receipts!.filter((r) => !r.reversal).map((r) => [r.good, r.goodValue, r.unitCost]);
/** Σ pool = WIP exactly, and nothing charged is lost or made up. */
function tied(d: DB) {
  for (const o of d.productionOrders) {
    const p = pool(o), w = o.wip ?? { materials: 0, labor: 0, overhead: 0 }, t = orderTotals(o);
    expect(r2(p.materials.reduce((a, x) => a + x.value, 0)), o.no).toBe(w.materials); expect([p.labor, p.overhead]).toEqual([w.labor, w.overhead]);
    for (const x of p.materials) { expect(x.qty).toBeGreaterThanOrEqual(0); expect(x.value).toBeGreaterThanOrEqual(0); if (x.qty === 0) expect(x.value).toBe(0); }
    expect(t.charged).toBe(r2(t.goodValue + t.rejectedValue + t.lossValue + t.variance.materials + t.variance.labor + t.variance.overhead + t.wipTotal));
  }
}
const ok = (s: S) => { sound(s.db); tied(s.db); };

describe('a receipt costs the material it used', () => {
  it('the price went from 10 to 20 after the order was made: 20 and 20', () => {
    const s = one(), id = order(s); price(s, 'A', 20);
    run(s, id, [{ productId: 'A', qty: 50 }], 50); ok(s); run(s, id, [{ productId: 'A', qty: 50 }], 50, true);
    expect(units(s, id)).toEqual([[50, 1000, 20], [50, 1000, 20]]); expect(glCode(s.db, '5310')).toBe(0); ok(s);
  });
  it('10% more material in four runs of 25: 11 each, the final one too', () => {
    const s = one(), id = order(s);
    for (const final of [false, false, false, true]) { run(s, id, [{ productId: 'A', qty: 27.5 }], 25, final); ok(s); }
    expect(units(s, id)).toEqual(Array(4).fill([25, 275, 11])); expect(glCode(s.db, '5310')).toBe(0);
  });
  it('the price fell from 10 to 5, all issued at once: 5 and 5', () => {
    const s = one(), id = order(s); price(s, 'A', 5); issue(s, id, 100);
    get(s, id, 50); ok(s); get(s, id, 50, true);
    expect(units(s, id)).toEqual([[50, 250, 5], [50, 250, 5]]); ok(s);
  });
  it.each([20, 4])('a substitute at %s used in two runs', (cost) => {
    const s = one(); s.do((d) => { add(d, 'S', 'resale', 0); put(d, 'S', 500, cost); }); const id = order(s);
    run(s, id, [{ productId: 'S', qty: 50 }], 50); run(s, id, [{ productId: 'S', qty: 50 }], 50, true);
    expect(units(s, id)).toEqual([[50, 50 * cost, cost], [50, 50 * cost, cost]]); ok(s);
  });
  it('a substitute issued for the whole order goes with the units made', () => {
    const s = one(); s.do((d) => { add(d, 'S', 'resale', 0); put(d, 'S', 500, 20); }); const id = order(s); issue(s, id, 100, 'S');
    get(s, id, 25); get(s, id, 25); get(s, id, 50, true);
    expect(units(s, id)).toEqual([[25, 500, 20], [25, 500, 20], [50, 1000, 20]]); ok(s);
  });
  it('150 issued for 100: 99 cost 10 each, the last unit takes its own 10 and 1% of the excess of 500, the rest is a variance', () => {
    const s = one(), id = order(s); issue(s, id, 150);
    get(s, id, 99); const gp = get(s, id, 1, true);
    expect(units(s, id)).toEqual([[99, 990, 10], [1, 15, 15]]);
    expect(po(s.db, id).receipts![1]).toMatchObject({ cost: { materials: 15 }, variance: { materials: 495, labor: 0, overhead: 0 }, consumed: [{ productId: 'A', qty: 51, value: 510 }] });
    expect([glCode(s.db, '5310'), glCode(s.db, '1220')]).toEqual([495, 0]); expect(orderTotals(po(s.db, id)).variance.materials).toBe(495); ok(s);
    s.do((d) => reverseReceipt(d, ctx, id, gp, 'x')); // the variance of the receipt goes back with it
    // the 495 are back; −4.95 is the one unit leaving at the average of 10.05 and not at 15
    expect(glCode(s.db, '5310')).toBe(-4.95); expect(po(s.db, id).receipts![1].reversal!.stockDiff).toBe(4.95); expect(po(s.db, id).wip!.materials).toBe(510); expect(pool(po(s.db, id)).materials).toEqual([{ productId: 'A', qty: 51, value: 510 }]); ok(s);
  });
  it('the first and only receipt takes all actual cost, however much was issued', () => {
    const s = one({ labor: 2 }), id = order(s); issue(s, id, 150); s.do((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 900 }));
    get(s, id, 100, true); expect(units(s, id)).toEqual([[100, 2400, 24]]); expect(glCode(s.db, '5310')).toBe(0); ok(s);
  });
  it('10% more material in a run, then close: nothing is left for the variance', () => {
    const s = one(), id = order(s); run(s, id, [{ productId: 'A', qty: 55 }], 50);
    expect(units(s, id)).toEqual([[50, 550, 11]]); s.do((d) => closeOrder(d, ctx, id)); expect(glCode(s.db, '5310')).toBe(0); ok(s);
  });
  it('labour of one run stays with that run', () => {
    const s = one({ labor: 2 }), id = order(s);
    run(s, id, [{ productId: 'A', qty: 50 }], 50, false, { conversions: [{ kind: 'labor', amount: 150 }] }); run(s, id, [{ productId: 'A', qty: 50 }], 50, true, { conversions: [{ kind: 'labor', amount: 50 }] });
    expect(units(s, id)).toEqual([[50, 650, 13], [50, 550, 11]]); ok(s);
  });
  it('a run takes from the earlier pool only what the BOM needs beyond its own material and labour', () => {
    const s = one({ labor: 2 }), id = order(s); issue(s, id, 100); s.do((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 200 })); price(s, 'A', 30);
    run(s, id, [{ productId: 'A', qty: 20 }], 50, false, { conversions: [{ kind: 'labor', amount: 40 }] });
    // 20 × 30 of its own + 30 × 10 earlier, 40 of its own + 60 earlier
    expect(po(s.db, id).receipts![0]).toMatchObject({ cost: { materials: 900, labor: 100, overhead: 0 }, consumed: [{ productId: 'A', qty: 50, value: 900 }] });
    expect(pool(po(s.db, id))).toEqual({ materials: [{ productId: 'A', qty: 70, value: 700 }], labor: 140, overhead: 0 }); ok(s);
  });
  it('labour and overhead by their estimate per unit; the excess of a final receipt is shared', () => {
    const s = one({ labor: 2, overhead: 1 }), id = order(s); issue(s, id, 100);
    s.do((d) => { addConversion(d, ctx, id, { kind: 'labor', amount: 300 }); addConversion(d, ctx, id, { kind: 'utilities', amount: 60 }); });
    get(s, id, 50); expect(po(s.db, id).receipts![0].cost).toEqual({ materials: 500, labor: 100, overhead: 50 });
    get(s, id, 50, true); // labour left 200, 100 needed, 100 excess: half of it here
    expect(po(s.db, id).receipts![1]).toMatchObject({ cost: { materials: 500, labor: 150, overhead: 10 }, variance: { materials: 0, labor: 50, overhead: 0 } }); expect(glCode(s.db, '5320')).toBe(50); ok(s);
  });
  it('an element nobody estimated goes with the share of the units still planned', () => {
    const s = one({ laborKnown: false }), id = order(s); issue(s, id, 100); s.do((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 400 }));
    get(s, id, 25); get(s, id, 25); get(s, id, 50, true); expect(po(s.db, id).receipts!.map((r) => r.cost.labor)).toEqual([100, 100, 200]); expect(glCode(s.db, '5320')).toBe(0); ok(s);
  });
  it('thirds of a component leave no dust variance', () => {
    const s = one({ qty: 1 / 3, labor: 1 / 3 }), id = order(s, 10); issue(s, id, 3.333); s.do((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 3.33 }));
    get(s, id, 3); get(s, id, 4); get(s, id, 3, true); expect([glCode(s.db, '5310'), glCode(s.db, '5320'), glCode(s.db, '1220')]).toEqual([0, 0, 0]); ok(s);
  });
  it('rejected units use material too', () => {
    const s = one(), id = order(s); issue(s, id, 100); get(s, id, 40, false, 10);
    expect(po(s.db, id).receipts![0]).toMatchObject({ goodValue: 400, rejectedValue: 100, consumed: [{ qty: 50, value: 500 }] }); ok(s);
  });
  it('an abnormal loss takes its material out of the pool', () => {
    const s = one(), id = order(s); issue(s, id, 100); s.do((d) => recordLoss(d, ctx, id, { amount: 250, note: 'spill' }));
    expect(po(s.db, id).losses![0].consumed).toEqual([{ productId: 'A', qty: 25, value: 250 }]); expect(pool(po(s.db, id)).materials).toEqual([{ productId: 'A', qty: 75, value: 750 }]); ok(s);
    const le = s.do((d) => recordLoss(d, ctx, id, { amount: 0.01, note: 'a satang' })); expect(po(s.db, id).losses![1].consumed).toEqual([{ productId: 'A', qty: 0.001, value: 0.01 }]); s.do((d) => reverseLoss(d, ctx, id, le, 'x'));
    s.do((d) => recordLoss(d, ctx, id, { amount: 750, note: 'fire' })); expect(pool(po(s.db, id)).materials).toEqual([]); ok(s);
  });
  it('an abnormal loss when the only valued material is a tiny quantity stays a number (review B)', () => {
    const s = one(); s.do((d) => { add(d, 'Z', 'resale', 0); put(d, 'Z', 10, 0); add(d, 'G', 'resale', 5000); put(d, 'G', 1, 5000); }); const id = order(s);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'Z', qty: 5 }, { productId: 'G', qty: 0.001 }], confirmUnknownCost: true }));
    s.do((d) => recordLoss(d, ctx, id, { amount: 3, note: 'spill' }));
    const c = po(s.db, id).losses![0].consumed!;
    expect(c.every((l) => Number.isFinite(l.qty) && Number.isFinite(l.value))).toBe(true); expect(r2(c.reduce((t, l) => t + l.value, 0))).toBe(3);
    expect(pool(po(s.db, id)).materials.every((m) => Number.isFinite(m.qty) && Number.isFinite(m.value))).toBe(true); ok(s);
  });
  it('zero cost: only with an issue line marked unknown, and only until a receipt took cost (M1)', () => {
    const s = one(); s.do((d) => { add(d, 'Z', 'resale', 0); put(d, 'Z', 10, 0); put(d, 'A', 1, 10); }); const id = order(s);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'Z', qty: 1 }], confirmUnknownCost: true }));
    expect(po(s.db, id).issues![0].lines[0].unknownCost).toBe(true);
    get(s, id, 1); issue(s, id, 1); get(s, id, 1);
    expect(s.code((d) => receiveGoods(d, ctx, id, { good: 1, rejected: 0, warehouseId: W, final: true }))).toBe('NO_COST');
    const t = order(s); issue(s, t, 10); expect(po(s.db, t).issues![0].lines[0].unknownCost).toBeUndefined(); ok(s);
  });
});

describe('return of materials', () => {
  it('puts unused material back at the average of the order: Dr inventory, Cr WIP', () => {
    const s = one(), id = order(s); issue(s, id, 50); price(s, 'A', 20); issue(s, id, 50); const h = onHand(s.db, W, 'A');
    const rid = s.do((d) => returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 40, warehouseId: W }], reason: 'too much' }));
    const r = po(s.db, id).returns![0];
    expect(r).toMatchObject({ id: rid, value: 600, reason: 'too much', lines: [{ productId: 'A', qty: 40, value: 600 }] }); expect(onHand(s.db, W, 'A')).toBe(h + 40);
    expect(s.db.movements.find((m) => m.id === r.lines[0].movementId)).toMatchObject({ type: 'prod_issue', qty: 40, refType: 'production', refId: id }); expect(s.db.movements.find((m) => m.id === r.lines[0].movementId)!.note).toContain(po(s.db, id).no);
    expect(po(s.db, id).wip!.materials).toBe(900); expect(orderTotals(po(s.db, id)).materials).toBe(900); ok(s);
    get(s, id, 60, true); expect(units(s, id)).toEqual([[60, 900, 15]]); ok(s);
  });
  it('is capped by the pool, needs a reason, a known warehouse and a running order, and is one transaction', () => {
    const s = one(), id = order(s); issue(s, id, 10); const b = s.db;
    const back = (d: DB, o: object = {}, reason = 'x') => returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 10, warehouseId: W, ...o }], reason });
    expect(s.code((d) => back(d, { qty: 10.001 }))).toBe('OVER_RETURN'); expect(thaiForError(s.msg((d) => back(d, { qty: 11 })))).toMatch(THAI);
    expect(s.code((d) => returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 6, warehouseId: W }, { productId: 'A', qty: 6, warehouseId: 'W1' }], reason: 'x' }))).toBe('OVER_RETURN');
    expect(s.code((d) => back(d, { productId: 'B' }))).toBe('OVER_RETURN'); expect(s.code((d) => back(d, {}, ' '))).toBe('REASON'); expect(s.code((d) => back(d, { warehouseId: 'x' }))).toBe('NOT_FOUND');
    for (const qty of [0, -1, NaN]) expect(s.code((d) => back(d, { qty }))).toBe('INVALID');
    expect(s.code((d) => returnMaterials(d, ctx, id, { lines: [], reason: 'x' }))).toBe('INVALID'); expect(s.code((d) => returnMaterials(d, u('U3'), id, { lines: [], reason: 'x' }))).toBe('FORBIDDEN');
    expect(s.db).toBe(b);
    s.do((d) => { back(d); cancelOrder(d, ctx, id, 'x'); }); expect(glCode(s.db, '5310')).toBe(0); expect(s.code((d) => back(d))).toBe('INVALID'); ok(s);
  });
  it('a return can be reversed: the stock leaves at today’s average and the difference is a material variance', () => {
    const s = one(), id = order(s); issue(s, id, 100); const rid = s.do((d) => returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 40, warehouseId: W }], reason: 'x' }));
    s.do((d) => put(d, 'A', 940, 30)); // the average is 20 now
    expect(s.code((d) => reverseReturn(d, ctx, id, rid, ' '))).toBe('REASON');
    s.do((d) => reverseReturn(d, ctx, id, rid, 'it was used after all'));
    expect(po(s.db, id).wip!.materials).toBe(1000); expect(pool(po(s.db, id)).materials).toEqual([{ productId: 'A', qty: 100, value: 1000 }]); expect(glCode(s.db, '5310')).not.toBe(0);
    expect(po(s.db, id).returns![0].reversal!.stockDiff).toBe(r2(-glCode(s.db, '5310'))); expect(s.code((d) => reverseReturn(d, ctx, id, rid, 'x'))).toBe('ALREADY'); ok(s);
  });
  it('a return whose stock is gone cannot be reversed', () => {
    const s = one(), id = order(s); issue(s, id, 1000); const rid = s.do((d) => returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 40, warehouseId: W }], reason: 'x' }));
    s.do((d) => adjustStock(d, ctx, { productId: 'A', warehouseId: W, qty: -1, reason: 'lost' }));
    const go = (d: DB) => reverseReturn(d, ctx, id, rid, 'x'); expect(s.code(go)).toBe('INSUFFICIENT_STOCK'); expect(thaiForError(s.msg(go))).toMatch(THAI); ok(s);
  });
  it('an issue that was partly used or returned cannot be reversed at its old value: return the rest', () => {
    const s = one(), id = order(s); const mi = issue(s, id, 100); s.do((d) => returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1, warehouseId: W }], reason: 'x' }));
    expect(s.code((d) => reverseIssue(d, ctx, id, mi, 'x'))).toBe('IN_USE');
  });
  it('an issue at another price than what was used is not reversed when that would leave the rest at an impossible cost', () => {
    const s = one(), id = order(s); issue(s, id, 10); price(s, 'A', 30); const m2 = issue(s, id, 10); get(s, id, 10); // 10 left at 20 each
    expect(s.code((d) => reverseIssue(d, ctx, id, m2, 'x'))).toBe('IN_USE'); ok(s);
    const t = order(s); issue(s, t, 10); const m = issue(s, t, 10); get(s, t, 5); s.do((d) => reverseIssue(d, ctx, t, m, 'x')); expect(pool(po(s.db, t)).materials).toEqual([{ productId: 'A', qty: 5, value: 150 }]); ok(s);
  });
});

describe('reopen', () => {
  const left = () => { const s = one({ labor: 2 }), id = order(s); issue(s, id, 100); s.do((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 200 })); return { s, id }; };
  it('an order that was closed: the variance comes back into WIP and it can be finished properly', () => {
    const { s, id } = left(); get(s, id, 80); s.do((d) => closeOrder(d, ctx, id)); expect([glCode(s.db, '5310'), glCode(s.db, '5320')]).toEqual([200, 40]);
    const j = po(s.db, id).variances![0].journalId;
    expect(s.code((d) => reopenOrder(d, ctx, id, ' '))).toBe('REASON'); expect(s.code((d) => reopenOrder(d, u(s.db.users.find((x) => x.roleId === 'role-warehouse')!.id), id, 'x'))).toBe('FORBIDDEN');
    s.do((d) => reopenOrder(d, ctx, id, 'closed too early'));
    expect(po(s.db, id)).toMatchObject({ status: 'partially_completed', wip: { materials: 200, labor: 40, overhead: 0 } }); expect(po(s.db, id).completedAt).toBeUndefined();
    expect([glCode(s.db, '5310'), glCode(s.db, '5320')]).toEqual([0, 0]); expect(s.db.journals.find((x) => x.id === po(s.db, id).variances![0].reversal!.journalId)!.reverses).toBe(j); ok(s);
    get(s, id, 20, true); expect(units(s, id)).toEqual([[80, 960, 12], [20, 240, 12]]); ok(s);
  });
  it('an order that was cancelled: back in progress, or approved when nothing was ever charged, or planned when it was never approved', () => {
    const { s, id } = left(); s.do((d) => cancelOrder(d, ctx, id, 'x')); s.do((d) => reopenOrder(d, ctx, id, 'x')); expect(po(s.db, id)).toMatchObject({ status: 'in_progress', wip: { materials: 1000 } }); ok(s);
    const b = order(s); s.do((d) => { cancelOrder(d, ctx, b, 'x'); reopenOrder(d, ctx, b, 'x'); }); expect(po(s.db, b).status).toBe('approved');
    const c = s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: 1, warehouseId: W, draft: true })); s.do((d) => { cancelOrder(d, ctx, c, 'x'); reopenOrder(d, ctx, c, 'x'); }); expect(po(s.db, c).status).toBe('planned');
  });
  it('close, reopen, close, cancel after reversal: every variance entry is kept and the ledger is right at each step', () => {
    const { s, id } = left(); const g = get(s, id, 50); s.do((d) => closeOrder(d, ctx, id)); ok(s); s.do((d) => reopenOrder(d, ctx, id, 'x')); ok(s); s.do((d) => closeOrder(d, ctx, id)); ok(s); s.do((d) => reopenOrder(d, ctx, id, 'x')); ok(s);
    s.do((d) => reverseReceipt(d, ctx, id, g, 'x')); ok(s); s.do((d) => cancelOrder(d, ctx, id, 'x')); ok(s);
    expect(po(s.db, id).variances!.map((v) => [v.why, !!v.reversal])).toEqual([['closed', true], ['closed', true], ['cancelled', false]]); expect([glCode(s.db, '5310'), glCode(s.db, '5320')]).toEqual([1000, 200]);
    s.do((d) => reopenOrder(d, ctx, id, 'x')); ok(s); expect(po(s.db, id).wip).toEqual({ materials: 1000, labor: 200, overhead: 0 });
  });
  it('reversing a receipt of a closed order takes the close variance back as well', () => {
    const { s, id } = left(); const g = get(s, id, 50); s.do((d) => closeOrder(d, ctx, id)); s.do((d) => reverseReceipt(d, ctx, id, g, 'x'));
    expect(po(s.db, id)).toMatchObject({ status: 'in_progress', wip: { materials: 1000, labor: 200, overhead: 0 } }); expect([glCode(s.db, '5310'), glCode(s.db, '5320')]).toEqual([0, 0]); ok(s);
  });
  it('refused: an open order, an order finished by its last receipt, a locked period', () => {
    const { s, id } = left(); expect(s.code((d) => reopenOrder(d, ctx, id, 'x'))).toBe('INVALID');
    get(s, id, 100, true); expect(s.code((d) => reopenOrder(d, ctx, id, 'x'))).toBe('INVALID'); expect(thaiForError(s.msg((d) => reopenOrder(d, ctx, id, 'x')))).toMatch(THAI);
    const b = order(s); issue(s, b, 5); s.do((d) => { cancelOrder(d, ctx, b, 'x'); d.meta.lockedUntil = '2026-12-31'; }); const before = s.db; expect(s.code((d) => reopenOrder(d, ctx, b, 'x'))).toBe('PERIOD_LOCKED'); expect(s.db).toBe(before);
  });
  it('the ledger of a reopened order is what it was before the close, whatever the receipt sequence', () => {
    const { s, id } = left(); get(s, id, 30); const before = [glCode(s.db, '1220'), glCode(s.db, '5310'), glCode(s.db, '5320')]; const p = JSON.stringify(pool(po(s.db, id)));
    s.do((d) => { closeOrder(d, ctx, id); reopenOrder(d, ctx, id, 'x'); }); expect([glCode(s.db, '1220'), glCode(s.db, '5310'), glCode(s.db, '5320')]).toEqual(before); expect(JSON.stringify(pool(po(s.db, id)))).toBe(p);
  });
});

describe('what is left to do (one definition: planned − good)', () => {
  it('rejects need replacement material', () => {
    const s = one(), id = order(s); issue(s, id, 100); get(s, id, 90, false, 10);
    expect(unitsLeft(po(s.db, id))).toBe(10); expect(runDefaults(s.db, po(s.db, id), 10).lines).toEqual([{ productId: 'A', qty: 10 }]);
    price(s, 'A', 10, 4); expect(shortages(s.db, po(s.db, id))).toMatchObject([{ productId: 'A', required: 10, issued: 0, need: 10, onHand: 4, short: 6 }]);
  });
  it('the pool counts against the need', () => {
    const s = one({ labor: 2, overhead: 1 }), id = order(s); issue(s, id, 30); s.do((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 25 }));
    expect(runDefaults(s.db, po(s.db, id), 50)).toEqual({ lines: [{ productId: 'A', qty: 20 }], conversions: [{ kind: 'labor', amount: 75 }, { kind: 'overhead', amount: 50 }] });
    expect(runDefaults(s.db, po(s.db, id), 10)).toEqual({ lines: [{ productId: 'A', qty: 0 }], conversions: [{ kind: 'overhead', amount: 10 }] });
    expect(runDefaults(s.db, po(s.db, id), NaN).lines).toEqual([{ productId: 'A', qty: 0 }]);
  });
  it('conversions keep their kind; what nobody knows is left out', () => {
    const s = one({ laborKnown: false, overhead: 1 }); s.do((d) => { d.boms[0].versions[0].otherCosts = [{ kind: 'utilities', label: 'p', amount: 2 }, { kind: 'other', label: 'x', amount: 3 }]; }); const id = order(s);
    s.do((d) => addConversion(d, ctx, id, { kind: 'utilities', amount: 15 }));
    expect(runDefaults(s.db, po(s.db, id), 10).conversions).toEqual([{ kind: 'utilities', amount: 15 }, { kind: 'other', amount: 30 }]); // 10 of overhead and 5 of utilities are covered by the 15 already recorded
  });
  it('says what the BOM still expects for a receipt and is not in the order', () => {
    const s = one({ labor: 2 }), id = order(s); issue(s, id, 30);
    expect(expectedMissing(s.db, po(s.db, id), 50)).toEqual({ materials: [{ productId: 'A', name: 'Product A', unit: 'pcs', need: 50, have: 30, missing: 20 }], conversions: [{ element: 'labor', need: 100, have: 0, missing: 100 }], unknown: [] });
    s.do((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 100 })); issue(s, id, 20); expect(expectedMissing(s.db, po(s.db, id), 50)).toEqual({ materials: [], conversions: [], unknown: [] });
    const t = one({ laborKnown: false }), x = order(t); expect(expectedMissing(t.db, po(t.db, x), 1).unknown).toEqual(['labor']);
  });
  it('the estimate is made again at approval (M12)', () => {
    const s = one(); const id = s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: 1, warehouseId: W })); expect(po(s.db, id).estimate!.materialsPerUnit).toBe(10);
    price(s, 'A', 20); s.do((d) => approveOrder(d, ctx, id)); expect(po(s.db, id).estimate!.materialsPerUnit).toBe(20);
  });
});

describe('keys, limits, notes, audit (M2, M3, M10)', () => {
  it('a key is tied to its action, its order and its result', () => {
    const s = one(), a = order(s), b = order(s);
    const mi = s.do((d) => issueMaterials(d, ctx, a, { lines: [{ productId: 'A', qty: 10 }] }, 'k')); expect(s.db.meta.idem['prod:k']).toBe('issue:' + mi);
    const g = s.do((d) => receiveGoods(d, ctx, a, { good: 1, rejected: 0, warehouseId: W, final: false }, 'r'));
    expect(s.code((d) => runProduction(d, ctx, a, { lines: [], conversions: [], good: 1, rejected: 0, warehouseId: W, final: false }, 'r'))).toBe('DUPLICATE_KEY');
    expect(s.code((d) => approveOrder(d, ctx, a, 'k'))).toBe('DUPLICATE_KEY'); expect(s.code((d) => issueMaterials(d, ctx, b, { lines: [{ productId: 'A', qty: 1 }] }, 'k'))).toBe('DUPLICATE_KEY');
    s.do((d) => reverseReceipt(d, ctx, a, g, 'x', 'rr')); // a late retry of the receipt must not say that it is there
    expect(s.code((d) => receiveGoods(d, ctx, a, { good: 1, rejected: 0, warehouseId: W, final: false }, 'r'))).toBe('DUPLICATE_KEY'); expect(s.do((d) => reverseReceipt(d, ctx, a, g, 'x', 'rr'))).toBe(g);
    s.do((d) => cancelOrder(d, ctx, a, 'x', 'c')); s.do((d) => reopenOrder(d, ctx, a, 'x', 'o')); expect(s.code((d) => cancelOrder(d, ctx, a, 'x', 'c'))).toBe('DUPLICATE_KEY'); expect(s.do((d) => reopenOrder(d, ctx, a, 'x', 'o'))).toBe(a);
  });
  it.each([1e9 + 1, 1e306, 1e308])('a quantity of %s is refused, not turned into infinity', (q) => {
    const s = one(), id = order(s); issue(s, id, 1); const L = [{ productId: 'A', qty: q }];
    for (const f of [(d: DB) => createOrder(d, ctx, { bomId: s.bom, plannedQty: q, warehouseId: W }), (d: DB) => issueMaterials(d, ctx, id, { lines: L }), (d: DB) => receiveGoods(d, ctx, id, { good: q, rejected: 0, warehouseId: W, final: false }), (d: DB) => returnMaterials(d, ctx, id, { lines: [{ ...L[0], warehouseId: W }], reason: 'x' })]) { expect(s.code(f)).toBe('INVALID'); expect(thaiForError(s.msg(f))).toMatch(THAI); }
    expect(s.code((d) => addConversion(d, ctx, id, { kind: 'labor', amount: q * 1000 }))).toBe('INVALID'); expect(s.code((d) => recordLoss(d, ctx, id, { amount: q * 1000, note: 'x' }))).toBe('INVALID');
    expect(validateBom(s.db, 'FG', { yieldQty: 1, laborCost: 0, overheadCost: 0, components: [{ productId: 'A', qty: q, role: 'material' }] })).toHaveLength(1);
  });
  it('movement notes carry order, document and BOM version; audit texts carry no money', () => {
    const s = one({ labor: 2 }), id = order(s);
    issue(s, id, 60); issue(s, id, 10);
    s.do((d) => { addConversion(d, ctx, id, { kind: 'labor', amount: 123.45 }); recordLoss(d, ctx, id, { amount: 7.77, note: 'spill' }); const r = returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1, warehouseId: W }], reason: 'x' }); reverseReturn(d, ctx, id, r, 'x'); const g = receiveGoods(d, ctx, id, { good: 3, rejected: 0, warehouseId: W, final: false }); reverseReceipt(d, ctx, id, g, 'x'); cancelOrder(d, ctx, id, 'x'); });
    const o = po(s.db, id), mv = s.db.movements.filter((m) => m.refId === id); expect(mv.length).toBeGreaterThan(5);
    for (const m of mv) { expect(m.note).toContain(o.no); expect(m.note).toMatch(/(MIS|MRT|FGR)-\d+/); expect(m.note).toMatch(/BOM v1/); }
    const money = [...s.db.journals.filter((j) => j.refId === id).flatMap((j) => j.lines.map((l) => l.debit || l.credit))].filter((x) => x % 1 !== 0 || x > 100);
    for (const a of s.db.audit.filter((x) => x.entity === 'production')) { for (const m of money) expect(a.detail).not.toContain(String(m)); expect(a.detail).not.toMatch(/\d+\.\d\d\b/); }
  });
});

describe('BOM versions in time and who may switch one on (M5, M7)', () => {
  const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  const editor = (s: S) => s.do((d) => { d.roles = [...d.roles, { id: 'role-edit', name: 'e', description: '', system: false, permissions: ['production:view', 'production:create', 'production:edit'] }]; d.users = d.users.map((x) => (x.id === 'U6' ? { ...x, roleId: 'role-edit' } : x)); });
  it('editing is enough for a draft; an active BOM, and making one active again, needs approval', () => {
    const s = one(); editor(s); const mk = (asDraft: boolean) => (d: DB) => createBom(d, u('U6'), { productId: 'X', name: 'X', type: 'assembly', yieldQty: 1, components: [{ productId: 'A', qty: 1, role: 'material' }], laborCost: 0, overheadCost: 0, asDraft });
    expect(s.code(mk(false))).toBe('FORBIDDEN'); expect(s.code(mk(true))).toBe(null); expect(s.code((d) => duplicateBom(d, u('U6'), s.bom, 'C'))).toBe(null);
    expect(s.code((d) => setBomStatus(d, u('U6'), s.bom, 'inactive', 'x'))).toBe(null); expect(s.code((d) => setBomStatus(d, u('U6'), s.bom, 'active', 'x'))).toBe('FORBIDDEN'); expect(s.code((d) => setBomStatus(d, ctx, s.bom, 'active', 'x'))).toBe(null);
  });
  it('bomState tells in use, scheduled, replaced and draft', () => {
    const s = one(); const v = (from: string) => s.do((d) => { const n = newDraftVersion(d, ctx, s.bom); activateVersion(d, ctx, s.bom, n, from); return n; });
    v(day(-5)); v(day(10)); s.do((d) => newDraftVersion(d, ctx, s.bom));
    expect(bomState(s.db.boms[0], day(0))).toEqual({ 1: 'replaced', 2: 'in_use', 3: 'scheduled', 4: 'draft' }); expect(bomState(s.db.boms[0], day(11))).toEqual({ 1: 'replaced', 2: 'replaced', 3: 'in_use', 4: 'draft' });
  });
  it('a first version dated in the future cannot be used before its date', () => {
    const s = one(); const b = s.do((d) => { const x = createBom(d, ctx, { productId: 'X', name: 'X', type: 'assembly', yieldQty: 1, components: [{ productId: 'A', qty: 1, role: 'material' }], laborCost: 0, overheadCost: 0, asDraft: true }); activateVersion(d, ctx, x, 1, at('2026-11-20T00:00:00+07:00').now); return x; });
    expect(bomState(s.db.boms[1], ctx.now)).toEqual({ 1: 'scheduled' });
    const go = (d: DB) => createOrder(d, ctx, { bomId: b, plannedQty: 1, warehouseId: W }); expect(s.code(go)).toBe('NO_BOM'); expect(s.msg(go)).toMatch(/2026-11-20/); expect(thaiForError(s.msg(go))).toMatch(/2026-11-20/);
    expect(s.code((d) => createOrder(d, at('2026-11-20T08:00:00+07:00'), { bomId: b, plannedQty: 1, warehouseId: W }))).toBe(null);
  });
  it('the circle check sees the version in effect and the scheduled one', () => {
    const s = one(); // FG contains A
    const a = s.do((d) => createBom(d, ctx, { productId: 'A', name: 'A', type: 'assembly', yieldQty: 1, components: [{ productId: 'C', qty: 1, role: 'material' }], laborCost: 0, overheadCost: 0 }));
    const n = s.do((d) => newDraftVersion(d, ctx, a)); s.do((d) => { updateDraft(d, ctx, a, n, { components: [{ productId: 'B', qty: 1, role: 'material' }] }); activateVersion(d, ctx, a, n, day(10)); });
    for (const out of ['B', 'C']) expect(validateBom(s.db, out, { yieldQty: 1, laborCost: 0, overheadCost: 0, components: [{ productId: 'A', qty: 1, role: 'material' }] }).join(), out).toMatch(/circular/);
    expect(validateBom(s.db, 'C', { yieldQty: 1, laborCost: 0, overheadCost: 0, components: [{ productId: 'A', qty: 1, role: 'material' }] }, day(12))).toEqual([]); // the old version is replaced by then
  });
});

describe('the WIP account (I7)', () => {
  const acct = (s: S, code: string, control?: 'wip') => s.do((d) => saveAccount(d, ctx, { code, name: 'My WIP ' + code, nameTh: 'งาน', type: 'asset', normal: 'debit', fsLine: 'inventory', parent: '1030', posting: true, control }, true));
  it('the role only takes a WIP control account', () => {
    const s = one(); acct(s, '1221'); acct(s, '1222', 'wip'); const go = (d: DB) => setMappingDirect(d, ctx, 'wip', '1221');
    expect(s.code(go)).toBe('INVALID'); expect(thaiForError(s.msg(go))).toMatch(THAI); expect(s.code((d) => setMappingDirect(d, ctx, 'wip', '1222'))).toBe(null);
    const bad = produce(s.db, (d) => { d.postingMap.wip = [{ code: '1221', from: '2020-01-01T00:00:00.000Z' }]; }) as DB; expect(validateCoa(bad).some((i) => i.level === 'error' && /Work in progress/.test(i.msg))).toBe(true);
  });
  it('an owner account gets the control while nothing is posted to it, and keeps it afterwards', () => {
    const s = one(); acct(s, '1221'); expect(s.code((d) => saveAccount(d, ctx, { code: '1221', name: 'x', control: 'wip' }, false))).toBe(null); s.do((d) => setMappingDirect(d, ctx, 'wip', '1221'));
    const id = order(s); issue(s, id, 5); const go = (d: DB) => saveAccount(d, ctx, { code: '1221', name: 'x', control: undefined }, false); expect(s.code(go)).toBe('IN_USE'); expect(thaiForError(s.msg(go))).toMatch(THAI);
  });
  it('a mapped account keeps the control even before anything is posted to it (review A)', () => {
    const s = one(); acct(s, '1222', 'wip'); s.do((d) => setMappingDirect(d, ctx, 'wip', '1222'));
    const go = (d: DB) => saveAccount(d, ctx, { code: '1222', name: 'x', control: undefined }, false);
    expect(s.code(go)).toBe('IN_USE'); expect(thaiForError(s.msg(go))).toMatch(THAI);
    expect(s.code((d) => saveAccount(d, ctx, { code: '1222', name: 'Renamed' }, false))).toBe(null);
  });
  it('mapped to another account while an order is open: the reconciliation covers both', () => {
    const s = one(), id = order(s); issue(s, id, 100); acct(s, '1222', 'wip'); s.do((d) => setMappingDirect(d, ctx, 'wip', '1222')); get(s, id, 50);
    expect([glCode(s.db, '1220'), glCode(s.db, '1222')]).toEqual([1000, -500]); expect(reconciliationMatrix(s.db).find((r) => r.key === 'wip')).toMatchObject({ gl: 500, sub: 500, status: 'ok' }); ok(s);
  });
});

describe('absorbed labour on the profit page (I1)', () => {
  it('is a credit of its own in the deductions, 0 when nothing was absorbed', () => {
    const s = one({ labor: 2 }); expect(businessCosts(s.db).absorbed).toBe(0); const id = order(s);
    run(s, id, [{ productId: 'A', qty: 100 }], 100, true, { conversions: [{ kind: 'labor', amount: 200 }] }); const c = businessCosts(s.db);
    expect(c.absorbed).toBe(200); expect(businessDeductions(c)).toBe(r2(c.waste + c.adjustments + c.productionVariance + c.opex - 200));
  });
  it('a role the owner put on the waste account is already counted there', () => {
    const s = one({ labor: 2 }); s.do((d) => { d.postingMap.conversion_absorbed = [{ code: '5100', from: '2020-01-01T00:00:00.000Z' }]; }); const id = order(s);
    run(s, id, [{ productId: 'A', qty: 100 }], 100, true, { conversions: [{ kind: 'labor', amount: 200 }] }); expect(businessCosts(s.db)).toMatchObject({ waste: -200, absorbed: 0 });
  });
});

describe('many random steps over several BOMs', () => {
  it.each([1, 2, 3])('1,000 steps (seed %s): every action, output of one order used by another, all kinds', (n0) => {
    const KINDS: ProductKind[] = ['resale', 'finished', 'material', 'packaging', 'wip'];
    const s = session((d) => {
      KINDS.forEach((k, i) => { add(d, 'R' + i, k, 0); put(d, 'R' + i, 4000, [33.33, 7.77, 0.37, 120, 1][i]); });
      add(d, 'SUB', 'wip', 0); add(d, 'OUT', 'finished', 0, { price: 500 }); add(d, 'RAW', 'material', 0);
      const mk = (productId: ID, comps: [ID, number, number?][], yieldQty: number, o: object = {}) => createBom(d, ctx, { productId, name: productId, type: 'manufacturing', yieldQty, components: comps.map(([p, qty, wastePct]) => ({ productId: p, qty, wastePct, role: 'material' as const })), laborCost: 20, overheadCost: 10, ...o });
      mk('SUB', [['R0', 1, 5], ['R2', 7]], 3); mk('RAW', [['R1', 2], ['R4', 1.234]], 1, { laborKnown: false, laborCost: 0 }); mk('OUT', [['SUB', 1], ['RAW', 0.5], ['R3', 0.1]], 1, { otherCosts: [{ kind: 'utilities', label: 'p', amount: 3 }] });
    }) as S;
    let seed = n0 * 7919; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); }, pick = <T,>(l?: T[]) => l?.[rnd(l.length || 1)];
    const ids: ID[] = []; const n: Record<string, number> = {};
    const c = at('2026-11-13T11:00:00+07:00');
    for (const b of s.db.boms) for (const q of [12, 40]) ids.push(s.do((d) => { const id = createOrder(d, c, { bomId: b.id, plannedQty: q, warehouseId: W }); approveOrder(d, c, id); return id; }));
    const WH = [W, 'W1'];
    for (let i = 0; i < 1000; i++) {
      const id = pick(ids)!, o = po(s.db, id), step = rnd(18), U = (1 + rnd(20)) / 4, gid = (l?: { id: ID }[]) => pick(l)?.id ?? 'none', comp = () => pick([...o.snapshot.components.map((x) => x.productId), 'R1'])!;
      const line = () => ({ productId: comp(), qty: (1 + rnd(60)) / 7, warehouseId: W }); const before = s.db;
      const e = s.code((d) => {
        switch (step) {
          case 0: case 1: return issueMaterials(d, c, id, { lines: [line()] });
          case 2: return addConversion(d, c, id, { kind: (['labor', 'overhead', 'utilities', 'other'] as const)[rnd(4)], amount: (1 + rnd(3000)) / 33 });
          case 3: case 4: return receiveGoods(d, c, id, { good: U, rejected: rnd(3) / 7, warehouseId: pick(WH)!, final: rnd(10) === 0 });
          case 5: case 6: { const x = runDefaults(d, po(d, id), U); return runProduction(d, c, id, { lines: x.lines.filter((l) => l.qty > 0).map((l) => ({ ...l, qty: l.qty * (1 + rnd(3) / 10) })), conversions: x.conversions, good: U, rejected: rnd(3) / 9, warehouseId: W, final: rnd(8) === 0 }); }
          case 7: return recordLoss(d, c, id, { amount: (1 + rnd(900)) / 70, note: 'x' });
          case 8: { const p = pick(pool(po(d, id)).materials); return returnMaterials(d, c, id, { lines: [{ productId: p?.productId ?? 'R0', qty: rnd(2) ? p?.qty ?? 1 : (p?.qty ?? 1) / 3, warehouseId: pick(WH)! }], reason: 'x' }); }
          case 9: return reverseReceipt(d, c, id, gid(o.receipts), 'x');
          case 10: return reverseIssue(d, c, id, gid(o.issues), 'x');
          case 11: return reverseConversion(d, c, id, gid(o.conversions), 'x');
          case 12: return reverseLoss(d, c, id, gid(o.losses), 'x');
          case 13: return reverseReturn(d, c, id, gid(o.returns), 'x');
          case 14: return closeOrder(d, c, id);
          case 15: return cancelOrder(d, c, id, 'x');
          case 16: case 17: return reopenOrder(d, c, id, 'x');
        }
      });
      n[`${step} ${e ?? 'done'}`] = (n[`${step} ${e ?? 'done'}`] || 0) + 1;
      expect(e ?? '', `step ${step}`).not.toMatch(/^ERR/); if (e) expect(s.db).toBe(before);
      for (const x of [po(s.db, id)]) {
        const p = pool(x), w = x.wip ?? { materials: 0, labor: 0, overhead: 0 }; expect(r2(p.materials.reduce((a, y) => a + y.value, 0))).toBe(w.materials);
        for (const y of p.materials) { expect(y.qty).toBeGreaterThanOrEqual(0); expect(y.value).toBeGreaterThanOrEqual(0); if (y.qty === 0) expect(y.value).toBe(0); }
      }
      if (i % 50 === 0) ok(s);
    }
    ok(s);
    // the material in every receipt cost what that material cost when it was issued: never more, never less
    for (const id of ids) {
      const o = po(s.db, id), lo: Record<ID, number> = {}, hi: Record<ID, number> = {};
      for (const i of o.issues ?? []) for (const l of i.lines) { lo[l.productId] = Math.min(lo[l.productId] ?? Infinity, l.unitCost); hi[l.productId] = Math.max(hi[l.productId] ?? 0, l.unitCost); }
      for (const r of o.receipts ?? []) {
        const all = r.cost.labor + r.cost.overhead + (r.variance?.labor ?? 0) + (r.variance?.overhead ?? 0); let min = all, max = all;
        for (const x of r.consumed ?? []) { const slack = 0.02 + x.qty * hi[x.productId] * 0.005; min += x.qty * lo[x.productId] - slack; max += x.qty * hi[x.productId] + slack; }
        const spent = r.goodValue + r.rejectedValue + (r.variance ? r.variance.materials + r.variance.labor + r.variance.overhead : 0);
        expect(spent, r.no).toBeGreaterThanOrEqual(min - 1e-6); expect(spent, r.no).toBeLessThanOrEqual(max + 1e-6);
        if (r.good > 0) expect(r.unitCost * r.good).toBeLessThanOrEqual(max + 0.01 * r.good);
      }
    }
    for (let k = 0; k < 17; k++) expect(n[`${k} done`] ?? 0, `step ${k} really happened: ${JSON.stringify(n)}`).toBeGreaterThan(0);
    for (const id of ids) { s.code((d) => closeOrder(d, c, id)); s.code((d) => cancelOrder(d, c, id, 'end')); }
    expect(glCode(s.db, '1220')).toBe(0); ok(s);
  }, 60000);
});
