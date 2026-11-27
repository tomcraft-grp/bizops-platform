import { describe, expect, it } from 'vitest';
import { at, base, codeOf, ctx, stock, tx, expectIntegrity } from '../helpers';
import { W, add, glCode, glOf, po, put, session, sound } from '../production';
import { activateVersion, cancelProduction, completeProduction, createBom, createProductionOrder, newDraftVersion, prodTotals, recordProduction, setBomStatus, updateDraft } from '../../src/domain/bom';
import {
  addConversion, approveOrder, cancelOrder, closeOrder, createOrder, issueMaterials, orderTotals, planOrder, receiveGoods, recordLoss, reverseConversion, reverseIssue, reverseLoss, reverseReceipt, runProduction, shortages, updateDraftOrder,
} from '../../src/domain/production';
import { cr, dr, post, reverseJournal } from '../../src/domain/accounting';
import { getBal, onHand } from '../../src/domain/inventory';
import { createOrder as sell } from '../../src/domain/orders';
import { thaiForError } from '../../src/lib/errorText';
import type { BomVersion, DB, ID } from '../../src/domain/types';
import { r2 } from '../../src/lib/util';

const THAI = /[ก-๿]/;
const u = (userId: string) => ({ ...ctx, userId });
const COMPS: BomVersion['components'] = [{ productId: 'A', qty: 10, role: 'material' }, { productId: 'B', qty: 5, role: 'material' }, { productId: 'C', qty: 100, role: 'packaging' }];
const ALL = [{ productId: 'A', qty: 10 }, { productId: 'B', qty: 5 }, { productId: 'C', qty: 100 }];
/** 100 FG = 10 A × 100 + 5 B × 80 + 100 C × 2 = 1,600 of materials, plus labour 200 and overhead 100 in the estimate. */
function shop(o: { labor?: number; overhead?: number; stockUp?: boolean } = {}) {
  const s = session((d) => {
    if (o.stockUp !== false) { put(d, 'A', 100, 100); put(d, 'B', 100, 80); put(d, 'C', 1000, 2); }
    createBom(d, ctx, { productId: 'FG', name: 'FG', type: 'manufacturing', yieldQty: 100, components: COMPS, laborCost: o.labor ?? 200, overheadCost: o.overhead ?? 100 });
  });
  return Object.assign(s, { bom: s.db.boms[0].id });
}
const order = (s: ReturnType<typeof shop>, plannedQty = 100, approve = true): ID => {
  const id = s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty, warehouseId: W }));
  if (approve) s.do((d) => approveOrder(d, ctx, id));
  return id;
};
const WIP = (d: DB, id: ID) => po(d, id).wip ?? { materials: 0, labor: 0, overhead: 0 };
/** cost charged = cost taken out + cost left */
function conserved(d: DB, id: ID) {
  const t = orderTotals(po(d, id));
  expect(r2(t.materials + t.labor + t.overhead)).toBe(r2(t.goodValue + t.rejectedValue + t.lossValue + t.variance.materials + t.variance.labor + t.variance.overhead + t.wipTotal));
}

describe('1-2. create, plan, approve', () => {
  it('a resale product gets an order with a frozen BOM snapshot and an estimate per unit', () => {
    const s = shop();
    const id = order(s, 50, false);
    expect(po(s.db, id)).toMatchObject({ status: 'planned', plannedQty: 50, productId: 'FG', warehouseId: W, batches: [], createdBy: 'U1' });
    expect(po(s.db, id).estimate).toMatchObject({ materialsPerUnit: 16, laborPerUnit: 2, overheadPerUnit: 1 });
    expect(po(s.db, id).estimate!.lines![0]).toEqual({ productId: 'A', qty: 0.1, unitCost: 100 });
    const n = s.do((d) => newDraftVersion(d, ctx, s.bom));
    s.do((d) => { updateDraft(d, ctx, s.bom, n, { laborCost: 9999 }); activateVersion(d, ctx, s.bom, n, ctx.now); });
    expect(po(s.db, id).snapshot).toMatchObject({ version: 1, laborCost: 200 });
    expect(order(s, 1, false) && s.db.productionOrders.at(-1)!.snapshot.version).toBe(2);
  });
  it('draft: can be changed, then planned, then approved; every step is in the history', () => {
    const s = shop();
    const id = s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: 10, warehouseId: W, draft: true, note: 'a', dueAt: '2026-12-01' }));
    expect(po(s.db, id).status).toBe('draft');
    s.do((d) => updateDraftOrder(d, ctx, id, { plannedQty: 20, warehouseId: 'W1', note: 'b' }));
    expect(po(s.db, id)).toMatchObject({ plannedQty: 20, warehouseId: 'W1', note: 'b', dueAt: '2026-12-01' });
    expect(s.code((d) => updateDraftOrder(d, ctx, id, { plannedQty: -1 }))).toBe('INVALID');
    expect(s.code((d) => approveOrder(d, ctx, id))).toBe('INVALID');
    s.do((d) => planOrder(d, ctx, id));
    expect(s.code((d) => updateDraftOrder(d, ctx, id, { plannedQty: 5 }))).toBe('INVALID');
    s.do((d) => approveOrder(d, ctx, id));
    expect(po(s.db, id)).toMatchObject({ status: 'approved', approvedBy: 'U1' });
    expect(po(s.db, id).events!.map((e) => [e.from, e.to])).toEqual([['', 'draft'], ['draft', 'planned'], ['planned', 'approved']]);
  });
  it.each([0, -5, NaN, Infinity, 0.0001])('a planned quantity of %s is refused', (q) => {
    const s = shop();
    expect(s.code((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: q, warehouseId: W }))).toBe('INVALID');
  });
  it('refused: unknown BOM or warehouse, inactive or archived BOM, inactive product, no active version, a menu item', () => {
    const s = shop();
    const mk = (d: DB, o: object = {}) => createOrder(d, ctx, { bomId: s.bom, plannedQty: 1, warehouseId: W, ...o });
    expect(s.code((d) => mk(d, { bomId: 'x' }))).toBe('NOT_FOUND');
    expect(s.code((d) => mk(d, { warehouseId: 'x' }))).toBe('NOT_FOUND');
    for (const st of ['inactive', 'archived'] as const) expect(s.code((d) => { setBomStatus(d, ctx, s.bom, st, 'r'); mk(d); })).toBe('INVALID');
    expect(s.code((d) => { d.products.find((p) => p.id === 'FG')!.active = false; mk(d); })).toBe('INACTIVE');
    expect(s.code((d) => { d.boms[0].versions[0].status = 'draft'; mk(d); })).toBe('NO_BOM');
    expect(s.code((d) => { add(d, 'M', 'menu', 0); const b = createBom(d, ctx, { productId: 'M', name: 'M', type: 'recipe', yieldQty: 1, components: [{ productId: 'A', qty: 1, role: 'material' }], laborCost: 0, overheadCost: 0 }); mk(d, { bomId: b }); })).toBe('INVALID');
  });
  it('an unknown component cost leaves the estimate unknown, not 0', () => {
    const s = shop();
    s.do((d) => { d.boms[0].versions[0].components.push({ productId: 'X', qty: 1, role: 'material' }); d.boms[0].versions[0].laborKnown = false; });
    const id = order(s);
    expect(po(s.db, id).estimate).toMatchObject({ materialsPerUnit: null, laborPerUnit: null, overheadPerUnit: 1 });
  });
  it('permissions: create to make and run an order, approve to approve, close, cancel and reverse', () => {
    const s = shop();
    expect(s.code((d) => createOrder(d, u('U3'), { bomId: s.bom, plannedQty: 1, warehouseId: W }))).toBe('FORBIDDEN');
    const wh = s.db.users.find((x) => x.roleId === 'role-warehouse')!.id;
    const id = s.do((d) => createOrder(d, u(wh), { bomId: s.bom, plannedQty: 100, warehouseId: W }));
    expect(s.code((d) => approveOrder(d, u(wh), id))).toBe('FORBIDDEN');
    s.do((d) => approveOrder(d, ctx, id));
    const mi = s.do((d) => issueMaterials(d, u(wh), id, { lines: ALL }));
    const ce = s.do((d) => addConversion(d, u(wh), id, { kind: 'labor', amount: 5 }));
    const gp = s.do((d) => receiveGoods(d, u(wh), id, { good: 1, rejected: 0, warehouseId: W, final: false }));
    for (const f of [(d: DB) => reverseIssue(d, u(wh), id, mi, 'x'), (d: DB) => reverseConversion(d, u(wh), id, ce, 'x'), (d: DB) => reverseReceipt(d, u(wh), id, gp, 'x'), (d: DB) => closeOrder(d, u(wh), id), (d: DB) => cancelOrder(d, u(wh), id, 'x')]) expect(s.code(f)).toBe('FORBIDDEN');
    for (const f of [(d: DB) => issueMaterials(d, u('U3'), id, { lines: ALL }), (d: DB) => addConversion(d, u('U3'), id, { kind: 'labor', amount: 5 }), (d: DB) => recordLoss(d, u('U3'), id, { amount: 1, note: 'x' }), (d: DB) => receiveGoods(d, u('U3'), id, { good: 1, rejected: 0, warehouseId: W, final: false }), (d: DB) => planOrder(d, u('U3'), id), (d: DB) => updateDraftOrder(d, u('U3'), id, {})]) expect(s.code(f)).toBe('FORBIDDEN');
  });
});

describe('3. issue materials', () => {
  it('takes stock at average cost into WIP: Dr WIP, Cr inventory, linked to the order', () => {
    const s = shop(); const id = order(s);
    const inv0 = glOf(s.db, 'inventory');
    const mi = s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    expect(onHand(s.db, W, 'A')).toBe(90); expect(onHand(s.db, W, 'C')).toBe(900);
    const x = po(s.db, id).issues![0];
    expect(x).toMatchObject({ id: mi, value: 1600, userId: 'U1' }); expect(x.no).toMatch(/^MIS-/);
    expect(x.lines[0]).toMatchObject({ productId: 'A', warehouseId: W, qty: 10, unitCost: 100, value: 1000 });
    expect(s.db.movements.find((m) => m.id === x.lines[0].movementId)).toMatchObject({ type: 'prod_issue', refType: 'production', refId: id, qty: -10 });
    expect(s.db.journals.find((j) => j.id === x.journalId)).toMatchObject({ refType: 'production', refId: id });
    expect(WIP(s.db, id)).toEqual({ materials: 1600, labor: 0, overhead: 0 });
    expect(glCode(s.db, '1220')).toBe(1600); expect(glOf(s.db, 'inventory')).toBe(r2(inv0 - 1600));
    expect(po(s.db, id).status).toBe('in_progress');
    sound(s.db); conserved(s.db, id);
  });
  it('raw materials and goods are credited to their own inventory accounts', () => {
    const s = shop(); s.do((d) => { add(d, 'RAW', 'material', 10); put(d, 'RAW', 5, 10); });
    const id = order(s); const g0 = glCode(s.db, '1210');
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'RAW', qty: 2 }, { productId: 'A', qty: 1 }] }));
    expect(glCode(s.db, '1200')).toBe(30); expect(glCode(s.db, '1210')).toBe(r2(g0 - 100));
    sound(s.db);
  });
  it('components may come from different warehouses', () => {
    const s = shop(); s.do((d) => { put(d, 'A', 4, 130, 'W1'); });
    const id = order(s);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 6 }, { productId: 'A', qty: 4, warehouseId: 'W1' }] }));
    expect(po(s.db, id).issues![0].lines.map((l) => [l.warehouseId, l.value])).toEqual([[W, 600], ['W1', 520]]);
    expect(onHand(s.db, 'W1', 'A')).toBe(0);
    sound(s.db);
  });
  it('needs approval first, and is refused once the order is finished', () => {
    const s = shop(); const id = order(s, 100, false);
    const go = (d: DB) => issueMaterials(d, ctx, id, { lines: ALL });
    expect(s.code(go)).toBe('INVALID'); expect(s.msg(go)).toMatch(/Approve/); expect(thaiForError(s.msg(go))).toMatch(THAI);
    s.do((d) => cancelOrder(d, ctx, id, 'x'));
    expect(s.code(go)).toBe('INVALID'); expect(thaiForError(s.msg(go))).toMatch(THAI);
  });
  it.each([['zero', 0], ['negative', -1], ['NaN', NaN], ['infinite', Infinity], ['below the stock precision', 0.0004]])('a %s quantity is refused', (_n, qty) => {
    const s = shop(); const id = order(s); const before = s.db;
    expect(s.code((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty }] }))).toBe('INVALID');
    expect(s.db).toBe(before);
  });
  it('refused: no line, the output itself, a menu item, an unknown warehouse, the same line twice', () => {
    const s = shop(); s.do((d) => { add(d, 'M', 'menu', 5); put(d, 'FG', 5, 10); }); const id = order(s);
    for (const lines of [[], [{ productId: 'FG', qty: 1 }], [{ productId: 'M', qty: 1 }], [{ productId: 'A', qty: 1 }, { productId: 'A', qty: 1, warehouseId: W }]]) expect(s.code((d) => issueMaterials(d, ctx, id, { lines }))).toBe('INVALID');
    expect(s.code((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1, warehouseId: 'x' }] }))).toBe('NOT_FOUND');
    expect(s.code((d) => issueMaterials(d, ctx, 'x', { lines: ALL }))).toBe('NOT_FOUND');
  });
  it('a component with no known cost is refused unless the person confirms', () => {
    const s = shop(); s.do((d) => { put(d, 'X', 10, 0); }); const id = order(s);
    const go = (confirmUnknownCost?: boolean) => (d: DB) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1 }, { productId: 'X', qty: 2 }], confirmUnknownCost });
    expect(s.code(go())).toBe('UNKNOWN_COST'); expect(s.msg(go())).toMatch(/Product X/); expect(thaiForError(s.msg(go()))).toMatch(/Product X/);
    s.do(go(true));
    expect(WIP(s.db, id).materials).toBe(100); expect(onHand(s.db, W, 'X')).toBe(8);
    sound(s.db);
  });
  it('short of one component: nothing at all is issued, and the reason is in both languages', () => {
    const s = shop(); const id = order(s); const before = s.db;
    const go = (d: DB) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 10 }, { productId: 'B', qty: 101 }] });
    expect(s.code(go)).toBe('INSUFFICIENT_STOCK'); expect(s.db).toBe(before); expect(thaiForError(s.msg(go))).toMatch(THAI);
  });
});

describe('4. labour, overhead, utilities, other', () => {
  it('go to WIP by element against the absorbed account', () => {
    const s = shop(); const id = order(s);
    for (const [kind, amount] of [['labor', 200], ['overhead', 60], ['utilities', 30.555], ['other', 10]] as const) s.do((d) => addConversion(d, ctx, id, { kind, amount }));
    expect(WIP(s.db, id)).toEqual({ materials: 0, labor: 200, overhead: 100.56 });
    expect(glCode(s.db, '5400')).toBe(-300.56); expect(glCode(s.db, '1220')).toBe(300.56);
    expect(po(s.db, id).status).toBe('in_progress');
    sound(s.db); conserved(s.db, id);
  });
  it.each([0, -1, NaN, Infinity, 0.001])('an amount of %s is refused', (amount) => {
    const s = shop(); const id = order(s);
    expect(s.code((d) => addConversion(d, ctx, id, { kind: 'labor', amount }))).toBe('INVALID');
  });
  it('an unknown kind of cost is refused, and an order that is not approved', () => {
    const s = shop(); const id = order(s, 10, false);
    expect(s.code((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 1 }))).toBe('INVALID');
    s.do((d) => approveOrder(d, ctx, id));
    expect(s.code((d) => addConversion(d, ctx, id, { kind: 'bribe' as never, amount: 1 }))).toBe('INVALID');
  });
});

describe('5. receive finished goods', () => {
  it('a final receipt takes all WIP: 1,600 + 200 + 100 over 100 units is 19 each', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 200 }); addConversion(d, ctx, id, { kind: 'overhead', amount: 100 }); });
    const gp = s.do((d) => receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true, note: 'lot 1' }));
    const r = po(s.db, id).receipts![0];
    expect(r).toMatchObject({ id: gp, good: 100, rejected: 0, goodValue: 1900, rejectedValue: 0, unitCost: 19, final: true, cost: { materials: 1600, labor: 200, overhead: 100 } });
    expect(getBal(s.db, W, 'FG')).toMatchObject({ qty: 100, value: 1900 });
    const m = s.db.movements.find((x) => x.id === r.movementId)!;
    expect(m).toMatchObject({ type: 'prod_output', refType: 'production', refId: id, qty: 100 }); expect(m.note).toContain(po(s.db, id).no); expect(m.note).toMatch(/BOM v1/);
    expect(po(s.db, id)).toMatchObject({ status: 'completed', completedAt: ctx.now, wip: { materials: 0, labor: 0, overhead: 0 } });
    expect(glCode(s.db, '1220')).toBe(0);
    sound(s.db); conserved(s.db, id);
  });
  it('a partial receipt takes the covered share, and the last one exactly what is left', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 200 }); });
    s.do((d) => receiveGoods(d, ctx, id, { good: 30, rejected: 0, warehouseId: W, final: false }));
    expect(po(s.db, id)).toMatchObject({ status: 'partially_completed', wip: { materials: 1120, labor: 140, overhead: 0 } });
    expect(po(s.db, id).receipts![0]).toMatchObject({ goodValue: 540, unitCost: 18 });
    s.do((d) => receiveGoods(d, ctx, id, { good: 30, rejected: 0, warehouseId: 'W1', final: false }));
    expect(po(s.db, id).receipts![1].goodValue).toBe(540); // 30 of the 70 units still covered
    s.do((d) => receiveGoods(d, ctx, id, { good: 38, rejected: 0, warehouseId: W, final: true }));
    // 2 units short of the plan: the 32 of material and 4 of labour beyond these 38 units belong to all 98; this receipt carries 38/98 of them, the rest is a variance
    expect(po(s.db, id).receipts![2]).toMatchObject({ goodValue: 697.96, variance: { materials: 19.59, labor: 2.45, overhead: 0 } });
    expect(po(s.db, id)).toMatchObject({ status: 'completed', wip: { materials: 0, labor: 0, overhead: 0 } });
    sound(s.db); conserved(s.db, id);
  });
  it('materials issued in two steps: a partial receipt only takes what those materials cover', () => {
    const s = shop(); const id = order(s);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 5 }, { productId: 'B', qty: 2.5 }, { productId: 'C', qty: 50 }] })); // 800 = 50 units
    s.do((d) => receiveGoods(d, ctx, id, { good: 50, rejected: 0, warehouseId: W, final: false }));
    expect(po(s.db, id).receipts![0].goodValue).toBe(800); expect(WIP(s.db, id).materials).toBe(0);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 5 }, { productId: 'B', qty: 2.5 }, { productId: 'C', qty: 50 }] }));
    s.do((d) => receiveGoods(d, ctx, id, { good: 25, rejected: 0, warehouseId: W, final: false }));
    expect(po(s.db, id).receipts![1].goodValue).toBe(400); // half of the 50 units covered
    sound(s.db);
  });
  it('an unknown estimate changes nothing: a receipt costs the material it used', () => {
    const s = shop(); const id = order(s); s.do((d) => { po(d, id).estimate!.materialsPerUnit = null; issueMaterials(d, ctx, id, { lines: ALL }); });
    s.do((d) => receiveGoods(d, ctx, id, { good: 10, rejected: 0, warehouseId: W, final: false }));
    expect(po(s.db, id).receipts![0].goodValue).toBe(160);
    sound(s.db);
  });
  it('odd amounts: thirds never drift, and the last receipt clears WIP to the satang', () => {
    const s = shop(); const id = order(s, 3);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1 }] }); addConversion(d, ctx, id, { kind: 'labor', amount: 0.05 }); addConversion(d, ctx, id, { kind: 'overhead', amount: 0.01 }); po(d, id).estimate!.materialsPerUnit = 100 / 3; });
    for (const final of [false, false, true]) { s.do((d) => receiveGoods(d, ctx, id, { good: 0.7, rejected: 0.3, warehouseId: W, final })); sound(s.db); conserved(s.db, id); }
    expect(WIP(s.db, id)).toEqual({ materials: 0, labor: 0, overhead: 0 });
    expect(r2(po(s.db, id).receipts!.reduce((a, r) => a + r.goodValue + r.rejectedValue, 0) + glCode(s.db, '5310') + glCode(s.db, '5320') + glCode(s.db, '5330'))).toBe(100.06);
  });
  it('raw material output goes to the raw material account', () => {
    const s = shop(); s.do((d) => { d.products.find((p) => p.id === 'FG')!.kind = 'material'; }); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }); });
    expect(glCode(s.db, '1200')).toBe(1600); sound(s.db);
  });
  it('weighted average: the receipt is averaged with the stock already there', () => {
    const s = shop(); s.do((d) => put(d, 'FG', 100, 10)); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }); });
    expect(getBal(s.db, W, 'FG')).toMatchObject({ qty: 200, value: 2600 }); sound(s.db);
  });
  it.each([[NaN, 0], [1, NaN], [-1, 2], [2, -1], [0, 0], [Infinity, 0], [0.0004, 0]])('good %s and rejected %s is refused', (good, rejected) => {
    const s = shop(); const id = order(s); s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    expect(s.code((d) => receiveGoods(d, ctx, id, { good, rejected, warehouseId: W, final: false }))).toBe('INVALID');
  });
  it('refused before anything was issued or costed, on an unknown warehouse, on a finished order', () => {
    const s = shop(); const id = order(s);
    const go = (d: DB, o: object = {}) => receiveGoods(d, ctx, id, { good: 1, rejected: 0, warehouseId: W, final: true, ...o });
    expect(s.code(go)).toBe('INVALID'); expect(thaiForError(s.msg(go))).toMatch(THAI);
    s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    expect(s.code((d) => go(d, { warehouseId: 'x' }))).toBe('NOT_FOUND');
    s.do(go);
    expect(s.code(go)).toBe('INVALID');
  });
  it('goods are never taken into stock at zero cost by accident: no cost left is refused unless confirmed', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: false }); });
    const go = (d: DB) => receiveGoods(d, ctx, id, { good: 5, rejected: 0, warehouseId: W, final: true });
    expect(s.code(go)).toBe('NO_COST'); expect(thaiForError(s.msg(go))).toMatch(THAI);
    s.do((d) => receiveGoods(d, ctx, id, { good: 5, rejected: 0, warehouseId: W, final: true, confirmUnknownCost: true }));
    expect(getBal(s.db, W, 'FG')).toMatchObject({ qty: 105, value: 1600 }); sound(s.db);
  });
  it('after an unknown cost was confirmed at the issue, the goods can be received', () => {
    const s = shop(); s.do((d) => put(d, 'X', 10, 0)); const id = order(s);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'X', qty: 1 }], confirmUnknownCost: true }));
    expect(s.code((d) => receiveGoods(d, ctx, id, { good: 1, rejected: 0, warehouseId: W, final: true }))).toBe(null);
    sound(s.db);
  });
});

describe('6. rejects and losses', () => {
  it('rejected units never enter stock; their share of the cost goes to waste', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 90, rejected: 10, warehouseId: W, final: true }); });
    expect(po(s.db, id).receipts![0]).toMatchObject({ goodValue: 1440, rejectedValue: 160, unitCost: 16 });
    expect(onHand(s.db, W, 'FG')).toBe(90); expect(glCode(s.db, '5100')).toBe(160);
    sound(s.db); conserved(s.db, id);
  });
  it('everything rejected: no stock movement, all the cost is waste', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 0, rejected: 100, warehouseId: W, final: true }); });
    expect(po(s.db, id).receipts![0]).toMatchObject({ goodValue: 0, rejectedValue: 1600, unitCost: 0, movementId: undefined });
    expect(onHand(s.db, W, 'FG')).toBe(0); sound(s.db);
  });
  it('an abnormal loss moves cost from WIP to waste, pro rata over the elements', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 400 }); });
    s.do((d) => recordLoss(d, ctx, id, { amount: 100, note: 'spill' }));
    expect(WIP(s.db, id)).toEqual({ materials: 1520, labor: 380, overhead: 0 });
    expect(po(s.db, id).losses![0]).toMatchObject({ amount: 100, note: 'spill', cost: { materials: 80, labor: 20, overhead: 0 } });
    expect(glCode(s.db, '5100')).toBe(100); sound(s.db); conserved(s.db, id);
    expect(s.code((d) => recordLoss(d, ctx, id, { amount: 1900.01, note: 'x' }))).toBe('INVALID');
    expect(s.code((d) => recordLoss(d, ctx, id, { amount: 1, note: ' ' }))).toBe('REASON');
    for (const amount of [0, -1, NaN]) expect(s.code((d) => recordLoss(d, ctx, id, { amount, note: 'x' }))).toBe('INVALID');
    s.do((d) => recordLoss(d, ctx, id, { amount: 1900, note: 'fire' }));
    expect(WIP(s.db, id)).toEqual({ materials: 0, labor: 0, overhead: 0 }); sound(s.db);
  });
});

describe('7. close and cancel', () => {
  it('closing posts the cost left to the variances by element', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 200 }); addConversion(d, ctx, id, { kind: 'utilities', amount: 50 }); });
    expect(s.code((d) => closeOrder(d, ctx, id))).toBe('INVALID'); // nothing produced: cancel instead
    s.do((d) => receiveGoods(d, ctx, id, { good: 80, rejected: 0, warehouseId: W, final: false }));
    s.do((d) => closeOrder(d, ctx, id));
    expect([glCode(s.db, '5310'), glCode(s.db, '5320'), glCode(s.db, '5330')]).toEqual([320, 40, 0]); // 2 of labour and up to 1 of overhead a unit went with the 80
    expect(po(s.db, id)).toMatchObject({ status: 'completed', closedBy: 'close', variances: [{ why: 'closed', cost: { materials: 320, labor: 40, overhead: 0 } }], wip: { materials: 0, labor: 0, overhead: 0 } });
    expect(s.db.journals.find((j) => j.id === po(s.db, id).variances![0].journalId)).toMatchObject({ refType: 'production', refId: id });
    sound(s.db); conserved(s.db, id);
    expect(s.code((d) => closeOrder(d, ctx, id))).toBe('INVALID');
  });
  it('closing with nothing left posts nothing', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: false }); });
    const n = s.db.journals.length; s.do((d) => closeOrder(d, ctx, id));
    expect(s.db.journals.length).toBe(n); expect(po(s.db, id).variances).toBeUndefined(); sound(s.db);
  });
  it('a negative amount left (old data) is posted the other way round', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 80, rejected: 0, warehouseId: W, final: false }); po(d, id).wip = { materials: -20, labor: 5, overhead: 0 }; });
    s.do((d) => closeOrder(d, ctx, id));
    const j = s.db.journals.at(-1)!;
    expect(j.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['5310', 0, 20], ['5320', 5, 0], ['1220', 15, 0]]);
  });
  it('cancel before anything was received: a reason, and the cost left goes to the variances', () => {
    const s = shop(); const id = order(s); s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    expect(s.code((d) => cancelOrder(d, ctx, id, ' '))).toBe('REASON');
    s.do((d) => cancelOrder(d, ctx, id, 'customer left'));
    expect(po(s.db, id).status).toBe('cancelled'); expect(glCode(s.db, '5310')).toBe(1600); sound(s.db); conserved(s.db, id);
    expect(po(s.db, id).events!.at(-1)).toMatchObject({ to: 'cancelled', note: 'customer left' });
  });
  it.each(['draft', 'planned', 'approved'] as const)('cancel from %s posts nothing', (st) => {
    const s = shop(); const n = s.db.journals.length;
    const id = s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: 1, warehouseId: W, draft: st === 'draft' }));
    if (st === 'approved') s.do((d) => approveOrder(d, ctx, id));
    s.do((d) => cancelOrder(d, ctx, id, 'x'));
    expect(po(s.db, id).status).toBe('cancelled'); expect(s.db.journals.length).toBe(n);
  });
  it('cannot be cancelled after a receipt; can be after the receipt was reversed', () => {
    const s = shop(); const id = order(s);
    const gp = s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); return receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: false }); });
    expect(s.code((d) => cancelOrder(d, ctx, id, 'x'))).toBe('INVALID');
    s.do((d) => reverseReceipt(d, ctx, id, gp, 'wrong'));
    s.do((d) => cancelOrder(d, ctx, id, 'x'));
    expect(glCode(s.db, '5310')).toBe(1600); sound(s.db);
  });
  it('a reversed issue then cancel: the materials are back and nothing is written off', () => {
    const s = shop(); const id = order(s); const inv = glOf(s.db, 'inventory');
    const mi = s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    s.do((d) => reverseIssue(d, ctx, id, mi, 'returned')); s.do((d) => cancelOrder(d, ctx, id, 'x'));
    expect(glOf(s.db, 'inventory')).toBe(inv); expect(glCode(s.db, '5310')).toBe(0); sound(s.db);
  });
});

describe('8. reversals', () => {
  it('reversing an issue puts the stock back at its original value with a linked mirror entry', () => {
    const s = shop(); const id = order(s);
    const mi = s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    s.do((d) => put(d, 'A', 10, 500)); // the average moved since
    const inv = glOf(s.db, 'inventory');
    expect(s.code((d) => reverseIssue(d, ctx, id, mi, ' '))).toBe('REASON');
    s.do((d) => reverseIssue(d, ctx, id, mi, 'wrong order'));
    const x = po(s.db, id).issues![0];
    expect(x.reversal).toMatchObject({ reason: 'wrong order', userId: 'U1' });
    expect(s.db.journals.find((j) => j.id === x.reversal!.journalId)!.reverses).toBe(x.journalId);
    expect(s.db.journals.find((j) => j.id === x.journalId)!.status).toBe('reversed');
    expect(onHand(s.db, W, 'A')).toBe(110); expect(glOf(s.db, 'inventory')).toBe(r2(inv + 1600)); expect(WIP(s.db, id).materials).toBe(0);
    expect(s.code((d) => reverseIssue(d, ctx, id, mi, 'again'))).toBe('ALREADY');
    sound(s.db); conserved(s.db, id);
  });
  it('an issue whose cost has already gone into goods cannot be reversed', () => {
    const s = shop(); const id = order(s);
    const mi = s.do((d) => { const m = issueMaterials(d, ctx, id, { lines: ALL }); receiveGoods(d, ctx, id, { good: 10, rejected: 0, warehouseId: W, final: false }); return m; });
    const go = (d: DB) => reverseIssue(d, ctx, id, mi, 'x'); const before = s.db;
    expect(s.code(go)).toBe('IN_USE'); expect(s.db).toBe(before); expect(thaiForError(s.msg(go))).toMatch(THAI);
    s.do((d) => receiveGoods(d, ctx, id, { good: 90, rejected: 0, warehouseId: W, final: true }));
    expect(s.code(go)).toBe('INVALID');
  });
  it('reversing a conversion cost, refused when that cost has left WIP', () => {
    const s = shop(); const id = order(s);
    const ce = s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); return addConversion(d, ctx, id, { kind: 'utilities', amount: 40 }); });
    expect(s.code((d) => reverseConversion(d, ctx, id, ce, ''))).toBe('REASON');
    s.do((d) => reverseConversion(d, ctx, id, ce, 'typo'));
    expect(WIP(s.db, id).overhead).toBe(0); expect(glCode(s.db, '5400')).toBe(0);
    expect(s.code((d) => reverseConversion(d, ctx, id, ce, 'x'))).toBe('ALREADY');
    const c2 = s.do((d) => { const c = addConversion(d, ctx, id, { kind: 'labor', amount: 100 }); receiveGoods(d, ctx, id, { good: 50, rejected: 0, warehouseId: W, final: false }); return c; });
    expect(s.code((d) => reverseConversion(d, ctx, id, c2, 'x'))).toBe('IN_USE');
    expect(s.code((d) => reverseConversion(d, ctx, id, 'nope', 'x'))).toBe('NOT_FOUND');
    sound(s.db); conserved(s.db, id);
  });
  it('reversing the final receipt: goods out, cost back in WIP, waste undone, order open again', () => {
    const s = shop(); const id = order(s);
    const gp = s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 200 }); return receiveGoods(d, ctx, id, { good: 90, rejected: 10, warehouseId: W, final: true }); });
    expect(s.code((d) => reverseReceipt(d, ctx, id, gp, ''))).toBe('REASON');
    s.do((d) => reverseReceipt(d, ctx, id, gp, 'counted wrong'));
    expect(po(s.db, id)).toMatchObject({ status: 'in_progress', wip: { materials: 1600, labor: 200, overhead: 0 } }); expect(po(s.db, id).completedAt).toBeUndefined();
    expect(getBal(s.db, W, 'FG')).toMatchObject({ qty: 0, value: 0 }); expect(glCode(s.db, '5100')).toBe(0); expect(glCode(s.db, '5310')).toBe(0);
    const r = po(s.db, id).receipts![0]; expect(s.db.journals.find((j) => j.id === r.reversal!.journalId)!.reverses).toBe(r.journalId);
    expect(s.code((d) => reverseReceipt(d, ctx, id, gp, 'again'))).toBe('ALREADY');
    sound(s.db); conserved(s.db, id);
    s.do((d) => receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }));
    expect(po(s.db, id).receipts![1].goodValue).toBe(1800); sound(s.db); conserved(s.db, id);
  });
  it('reversing one of two receipts of a completed order reopens it as partly completed, and the final one can still be closed', () => {
    const s = shop(); const id = order(s);
    const g1 = s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); const g = receiveGoods(d, ctx, id, { good: 40, rejected: 0, warehouseId: W, final: false }); receiveGoods(d, ctx, id, { good: 60, rejected: 0, warehouseId: W, final: true }); return g; });
    s.do((d) => reverseReceipt(d, ctx, id, g1, 'x'));
    expect(po(s.db, id)).toMatchObject({ status: 'partially_completed', wip: { materials: 640 } }); sound(s.db); conserved(s.db, id);
    s.do((d) => closeOrder(d, ctx, id)); expect(glCode(s.db, '5310')).toBe(640); sound(s.db); conserved(s.db, id);
  });
  it.each([[10, 1], [30, -1]])('the average changed since (other stock at %s): the difference goes to the material variance', (other, sign) => {
    const s = shop(); const id = order(s);
    const gp = s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); return receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }); }); // 16 each
    s.do((d) => put(d, 'FG', 100, other));
    s.do((d) => reverseReceipt(d, ctx, id, gp, 'x'));
    const out = 100 * ((1600 + 100 * other) / 200), diff = r2(1600 - out);
    expect(Math.sign(diff)).toBe(sign);
    expect(glCode(s.db, '5310')).toBe(-diff); expect(getBal(s.db, W, 'FG')).toMatchObject({ qty: 100, value: r2(100 * other + diff) });
    expect(po(s.db, id).receipts![0].reversal!.stockDiff).toBe(diff); expect(WIP(s.db, id).materials).toBe(1600);
    sound(s.db); conserved(s.db, id);
  });
  it.each([false, true])('refused with a clear reason when some of the goods were sold (negative stock allowed: %s)', (allow) => {
    const s = shop(); s.do((d) => { d.org.allowNegativeStock = allow; d.products.find((p) => p.id === 'FG')!.price = 50; }); const id = order(s);
    const gp = s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); return receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }); });
    s.do((d) => sell(d, ctx, { channel: 'POS', branchId: 'B3', warehouseId: W, lines: [{ productId: 'FG', qty: 3 }], payments: [{ method: 'cash', amount: 150 }], skipPromotions: true }));
    const go = (d: DB) => reverseReceipt(d, ctx, id, gp, 'x'); const before = s.db;
    expect(s.code(go)).toBe('INSUFFICIENT_STOCK'); expect(s.db).toBe(before); expect(s.msg(go)).toMatch(/97.*100/); expect(thaiForError(s.msg(go))).toMatch(/97.*100/);
  });
  it('a receipt of a cancelled order or an unknown one is refused', () => {
    const s = shop(); const id = order(s);
    expect(s.code((d) => reverseReceipt(d, ctx, id, 'x', 'r'))).toBe('NOT_FOUND');
    expect(s.code((d) => reverseIssue(d, ctx, id, 'x', 'r'))).toBe('NOT_FOUND');
  });
  it('a reversal in a locked period is refused and changes nothing', () => {
    const s = shop(); const id = order(s); const mi = s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    s.do((d) => { d.meta.lockedUntil = '2026-12-31'; }); const before = s.db;
    expect(s.code((d) => reverseIssue(d, ctx, id, mi, 'x'))).toBe('PERIOD_LOCKED'); expect(s.db).toBe(before);
  });
});

describe('8b. the Accounting page cannot reverse an entry of a production order', () => {
  const entries = (d: DB, id: ID) => d.journals.filter((j) => j.refType === 'production' && j.refId === id);
  it('issue, cost, loss, receipt, variance and average-cost difference: each is refused, with the order named in both languages', () => {
    const s = shop(); const id = order(s);
    s.do((d) => {
      issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 200 }); recordLoss(d, ctx, id, { amount: 50, note: 'x' });
      const g = receiveGoods(d, ctx, id, { good: 40, rejected: 0, warehouseId: W, final: false }); receiveGoods(d, ctx, id, { good: 10, rejected: 2, warehouseId: W, final: false });
      put(d, 'FG', 100, 1); reverseReceipt(d, ctx, id, g, 'x'); closeOrder(d, ctx, id);
      // reopened and closed again: the first variance entry is no longer the one the order points to
      reverseReceipt(d, ctx, id, po(d, id).receipts![1].id, 'x'); receiveGoods(d, ctx, id, { good: 5, rejected: 0, warehouseId: W, final: false }); closeOrder(d, ctx, id);
    });
    const open = entries(s.db, id).filter((j) => j.status === 'posted');
    expect(open.length).toBeGreaterThanOrEqual(7);
    const before = s.db;
    for (const j of open) {
      const go = (d: DB) => reverseJournal(d, ctx, j.id, 'by hand');
      expect(s.code(go), j.memo).toBe('USE_PRODUCTION'); expect(s.msg(go)).toContain(po(s.db, id).no); expect(thaiForError(s.msg(go))).toMatch(THAI); expect(thaiForError(s.msg(go))).toContain(po(s.db, id).no);
    }
    expect(s.db).toBe(before); sound(s.db);
  });
  it('the production order itself still can, and other journals are as before', () => {
    const s = shop(); const id = order(s); const mi = s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    expect(s.code((d) => reverseIssue(d, ctx, id, mi, 'x'))).toBe(null);
    const j = s.do((d) => post(d, ctx, { memo: 'x', refType: 'manual', lines: [dr('6300', 5), cr('cash', 5)] })!);
    expect(s.code((d) => reverseJournal(d, ctx, j, 'x'))).toBe(null); sound(s.db);
  });
  it('a batch of the older flow has no other way back: it can be reversed as today', () => {
    const s = shop(); const id = s.do((d) => { const x = createProductionOrder(d, ctx, { bomId: s.bom, plannedQty: 100, warehouseId: W }); recordProduction(d, ctx, x, { outputQty: 40 }); return x; });
    expect(s.code((d) => reverseJournal(d, ctx, po(d, id).batches[0].journalId!, 'x'))).toBe(null);
  });
  it('so a loss can be taken back on the order: cost returns to WIP by the same elements', () => {
    const s = shop(); const id = order(s);
    const le = s.do((d) => { issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 400 }); return recordLoss(d, ctx, id, { amount: 100, note: 'spill' }); });
    expect(s.code((d) => reverseLoss(d, ctx, id, le, ' '))).toBe('REASON'); expect(s.code((d) => reverseLoss(d, ctx, id, 'x', 'x'))).toBe('NOT_FOUND');
    s.do((d) => reverseLoss(d, ctx, id, le, 'found it', 'k')); s.do((d) => reverseLoss(d, ctx, id, le, 'found it', 'k'));
    expect(WIP(s.db, id)).toEqual({ materials: 1600, labor: 400, overhead: 0 }); expect(glCode(s.db, '5100')).toBe(0);
    const l = po(s.db, id).losses![0]; expect(s.db.journals.find((j) => j.id === l.reversal!.journalId)!.reverses).toBe(l.journalId);
    expect(s.code((d) => reverseLoss(d, ctx, id, le, 'again'))).toBe('ALREADY'); expect(orderTotals(po(s.db, id)).lossValue).toBe(0);
    sound(s.db); conserved(s.db, id);
    const l2 = s.do((d) => { const x = recordLoss(d, ctx, id, { amount: 10, note: 'x' }); receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }); return x; });
    expect(s.code((d) => reverseLoss(d, ctx, id, l2, 'x'))).toBe('INVALID'); // finished
  });
});

describe('9. run production in one step', () => {
  const run = (o: object = {}) => ({ lines: ALL, conversions: [{ kind: 'labor' as const, amount: 200 }, { kind: 'overhead' as const, amount: 100 }], good: 95, rejected: 5, warehouseId: W, final: true, ...o });
  it('issue, costs and receipt together', () => {
    const s = shop(); const id = order(s);
    const gp = s.do((d) => runProduction(d, ctx, id, run()));
    expect(po(s.db, id)).toMatchObject({ status: 'completed' }); expect(po(s.db, id).receipts![0]).toMatchObject({ id: gp, goodValue: 1805, rejectedValue: 95, unitCost: 19 });
    sound(s.db); conserved(s.db, id);
  });
  it('can run in parts, and without lines when the materials were issued before', () => {
    const s = shop(); const id = order(s);
    s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    s.do((d) => runProduction(d, ctx, id, run({ lines: [], conversions: [], good: 50, rejected: 0, final: false })));
    expect(po(s.db, id).status).toBe('partially_completed');
    s.do((d) => runProduction(d, ctx, id, run({ lines: [], good: 50, rejected: 0 })));
    expect(po(s.db, id).status).toBe('completed'); sound(s.db); conserved(s.db, id);
  });
  it('one thing wrong and nothing happens: short stock, bad cost, bad output', () => {
    const s = shop(); const id = order(s); const before = s.db;
    expect(s.code((d) => runProduction(d, ctx, id, run({ lines: [{ productId: 'A', qty: 10 }, { productId: 'B', qty: 1000 }] })))).toBe('INSUFFICIENT_STOCK');
    expect(s.code((d) => runProduction(d, ctx, id, run({ conversions: [{ kind: 'labor', amount: NaN }] })))).toBe('INVALID');
    expect(s.code((d) => runProduction(d, ctx, id, run({ good: -1 })))).toBe('INVALID');
    expect(s.db).toBe(before); sound(s.db);
  });
});

describe('10. the same request twice, locked periods, unmapped roles', () => {
  it('the same key sent again returns the first id and does nothing more', () => {
    const s = shop();
    const mk = () => s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: 100, warehouseId: W }, 'k1'));
    const id = mk(); expect(mk()).toBe(id); expect(s.db.productionOrders).toHaveLength(1);
    expect(s.db.meta.idem['prod:k1']).toBe('create:' + id);
    const twice = (f: (d: DB) => unknown) => { const a = s.do(f); const snap = JSON.stringify([s.db.journals.length, s.db.movements.length, s.db.audit.length, s.db.productionOrders]); expect(s.do(f)).toBe(a); expect(JSON.stringify([s.db.journals.length, s.db.movements.length, s.db.audit.length, s.db.productionOrders])).toBe(snap); return a as ID; };
    twice((d) => approveOrder(d, ctx, id, 'k2'));
    const mi = twice((d) => issueMaterials(d, ctx, id, { lines: ALL }, 'k3'));
    const ce = twice((d) => addConversion(d, ctx, id, { kind: 'labor', amount: 10 }, 'k4'));
    twice((d) => recordLoss(d, ctx, id, { amount: 5, note: 'x' }, 'k5'));
    const gp = twice((d) => receiveGoods(d, ctx, id, { good: 10, rejected: 0, warehouseId: W, final: false }, 'k6'));
    twice((d) => reverseReceipt(d, ctx, id, gp, 'x', 'k7'));
    const c2 = s.do((d) => addConversion(d, ctx, id, { kind: 'overhead', amount: 10 }));
    twice((d) => reverseConversion(d, ctx, id, c2, 'x', 'k8'));
    const m2 = s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1 }] }));
    twice((d) => reverseIssue(d, ctx, id, m2, 'x', 'k9'));
    twice((d) => runProduction(d, ctx, id, { lines: [], conversions: [], good: 10, rejected: 0, warehouseId: W, final: false }, 'k10'));
    twice((d) => closeOrder(d, ctx, id, 'done', 'k11'));
    const o2 = s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: 1, warehouseId: W, draft: true }));
    twice((d) => updateDraftOrder(d, ctx, o2, { plannedQty: 2 }, 'k12')); twice((d) => planOrder(d, ctx, o2, 'k13')); twice((d) => cancelOrder(d, ctx, o2, 'x', 'k14'));
    void mi; void ce; sound(s.db);
  });
  it('a key used for another action or another order is refused, never silently dropped', () => {
    const s = shop(); const a = order(s), b = order(s);
    s.do((d) => issueMaterials(d, ctx, a, { lines: ALL }, 'same'));
    expect(s.code((d) => addConversion(d, ctx, a, { kind: 'labor', amount: 1 }, 'same'))).toBe('DUPLICATE_KEY');
    expect(s.code((d) => issueMaterials(d, ctx, b, { lines: ALL }, 'same'))).toBe('DUPLICATE_KEY');
    expect(s.code((d) => reverseIssue(d, ctx, a, po(d, a).issues![0].id, 'x', 'same'))).toBe('DUPLICATE_KEY');
    expect(thaiForError(s.msg((d) => addConversion(d, ctx, a, { kind: 'labor', amount: 1 }, 'same')))).toMatch(THAI);
  });
  it('a key does not open a door: without the permission the repeated call is refused too', () => {
    const s = shop(); const id = order(s); s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }, 'k'));
    expect(s.code((d) => issueMaterials(d, u('U3'), id, { lines: ALL }, 'k'))).toBe('FORBIDDEN');
  });
  const STEPS: [string, string, (d: DB, id: ID) => unknown, boolean][] = [
    ['issue', 'wip', (d, id) => issueMaterials(d, ctx, id, { lines: ALL }), false],
    ['issue (inventory role)', 'inv_goods', (d, id) => issueMaterials(d, ctx, id, { lines: ALL }), false],
    ['conversion', 'conversion_absorbed', (d, id) => addConversion(d, ctx, id, { kind: 'labor', amount: 5 }), false],
    ['receipt', 'inv_goods', (d, id) => receiveGoods(d, ctx, id, { good: 5, rejected: 0, warehouseId: W, final: false }), true],
    ['rejects', 'waste', (d, id) => receiveGoods(d, ctx, id, { good: 5, rejected: 5, warehouseId: W, final: false }), true],
    ['loss', 'waste', (d, id) => recordLoss(d, ctx, id, { amount: 5, note: 'x' }), true],
    ['cancel', 'prod_var_material', (d, id) => cancelOrder(d, ctx, id, 'x'), true],
    ['run', 'wip', (d, id) => runProduction(d, ctx, id, { lines: ALL, conversions: [], good: 5, rejected: 0, warehouseId: W, final: true }), false],
  ];
  it.each(STEPS)('%s: an unmapped %s or a locked period changes nothing and says so in both languages', (_n, role, f, issued) => {
    const s = shop(); const id = order(s);
    if (issued) s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    const keep = s.db;
    s.do((d) => { delete d.postingMap[role]; });
    let before = s.db;
    expect(s.code((d) => f(d, id))).toBe('UNMAPPED_ACCOUNT'); expect(s.db).toBe(before); expect(thaiForError(s.msg((d) => f(d, id)))).toMatch(THAI);
    s.do((d) => { Object.assign(d, keep); d.meta = { ...d.meta, lockedUntil: '2026-11-30' }; });
    before = s.db;
    expect(s.code((d) => f(d, id))).toBe('PERIOD_LOCKED'); expect(s.db).toBe(before); expect(thaiForError(s.msg((d) => f(d, id)))).toMatch(THAI);
  });
  it('a locked period also stops a stock movement that has no value', () => {
    const s = shop(); s.do((d) => put(d, 'X', 10, 0)); const id = order(s); s.do((d) => { d.meta.lockedUntil = '2026-11-30'; });
    expect(s.code((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'X', qty: 1 }], confirmUnknownCost: true }))).toBe('PERIOD_LOCKED');
  });
});

describe('totals and shortages', () => {
  it('orderTotals adds up what is live and leaves reversed documents out', () => {
    const s = shop(); const id = order(s);
    s.do((d) => {
      const m = issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1 }] }); reverseIssue(d, ctx, id, m, 'x');
      issueMaterials(d, ctx, id, { lines: ALL }); addConversion(d, ctx, id, { kind: 'labor', amount: 200 });
      receiveGoods(d, ctx, id, { good: 45, rejected: 5, warehouseId: W, final: false });
    });
    expect(orderTotals(po(s.db, id))).toMatchObject({ good: 45, rejected: 5, units: 50, remaining: 55, materials: 1600, labor: 200, overhead: 0, goodValue: 810, rejectedValue: 90, lossValue: 0, wipTotal: 900, unitCost: 18 });
    const other = order(s), empty = orderTotals(po(s.db, other));
    expect(empty).toMatchObject({ good: 0, unitCost: null, wipTotal: 0, remaining: 100 });
  });
  it('shortages count what is still to be issued, in the warehouse of the order, and say what other warehouses hold', () => {
    const s = shop({ stockUp: false }); s.do((d) => { put(d, 'A', 4, 100); put(d, 'A', 20, 100, 'W1'); put(d, 'B', 5, 80); put(d, 'C', 1000, 2); });
    const id = order(s);
    expect(shortages(s.db, po(s.db, id))).toEqual([{ productId: 'A', name: 'Product A', unit: 'pcs', required: 10, issued: 0, need: 10, onHand: 4, elsewhere: 20, short: 6 }]);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 4 }, { productId: 'A', qty: 3, warehouseId: 'W1' }] }));
    expect(shortages(s.db, po(s.db, id))).toMatchObject([{ productId: 'A', issued: 7, need: 3, onHand: 0, short: 3 }]);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 3, warehouseId: 'W1' }] }));
    expect(shortages(s.db, po(s.db, id))).toEqual([]);
    s.do((d) => cancelOrder(d, ctx, id, 'x'));
    expect(shortages(s.db, po(s.db, id))).toEqual([]);
  });
});

describe('orders saved before this module', () => {
  it('an old planned order can be approved and run; the old steps are then closed to it', () => {
    const s = shop();
    const id = s.do((d) => createProductionOrder(d, ctx, { bomId: s.bom, plannedQty: 100, warehouseId: W }));
    expect(s.code((d) => issueMaterials(d, ctx, id, { lines: ALL }))).toBe('INVALID');
    s.do((d) => approveOrder(d, ctx, id));
    expect(po(s.db, id).estimate).toMatchObject({ materialsPerUnit: 16 });
    s.do((d) => issueMaterials(d, ctx, id, { lines: ALL }));
    // the old functions would leave the WIP behind, so they refuse this order
    for (const f of [(d: DB) => recordProduction(d, ctx, id, { outputQty: 1 }), (d: DB) => completeProduction(d, ctx, id), (d: DB) => cancelProduction(d, ctx, id)]) expect(s.code(f)).toBe('INVALID');
    s.do((d) => receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }));
    sound(s.db);
  });
  it('an order in progress with batches keeps its numbers and can be finished with the new steps', () => {
    const s = shop();
    const id = s.do((d) => { const x = createProductionOrder(d, ctx, { bomId: s.bom, plannedQty: 100, warehouseId: W }); recordProduction(d, ctx, x, { outputQty: 40, wasteQty: 10 }); return x; });
    const batch = JSON.stringify(po(s.db, id).batches);
    expect(orderTotals(po(s.db, id))).toMatchObject({ good: 40, rejected: 10, remaining: 60, materials: 800, unitCost: 19, wipTotal: 0 });
    expect(shortages(s.db, po(s.db, id))).toEqual([]);
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 5 }, { productId: 'B', qty: 2.5 }, { productId: 'C', qty: 50 }] }));
    expect(s.code((d) => cancelOrder(d, ctx, id, 'x'))).toBe('INVALID');
    expect(s.code((d) => recordProduction(d, ctx, id, { outputQty: 60 }))).toBe('INVALID'); // it would complete the order and leave the WIP behind
    s.do((d) => receiveGoods(d, ctx, id, { good: 50, rejected: 0, warehouseId: W, final: true }));
    expect(JSON.stringify(po(s.db, id).batches)).toBe(batch);
    expect(orderTotals(po(s.db, id))).toMatchObject({ good: 90, rejected: 10, goodValue: r2(760 + 800) });
    expect(prodTotals(po(s.db, id)).out).toBe(40); // the old summary still reads the old batches only
    sound(s.db); conserved(s.db, id);
  });
  it('an old order in progress can be closed or its batches left alone', () => {
    const s = shop();
    const id = s.do((d) => { const x = createProductionOrder(d, ctx, { bomId: s.bom, plannedQty: 100, warehouseId: W }); recordProduction(d, ctx, x, { outputQty: 40 }); return x; });
    s.do((d) => closeOrder(d, ctx, id)); expect(po(s.db, id).status).toBe('completed'); sound(s.db);
  });
  it('works on the demo business too, and the old flow is untouched there', () => {
    const b = base(); expect(b.productionOrders.every((o) => !o.events && !o.wip)).toBe(true);
    tx((d) => {
      stock(d, 'M01', W, 30); stock(d, 'M02', W, 30);
      const id = createOrder(d, ctx, { bomId: 'BM-F01', plannedQty: 10, warehouseId: W }); approveOrder(d, ctx, id);
      runProduction(d, ctx, id, { lines: po(d, id).snapshot.components.map((c) => ({ productId: c.productId, qty: c.qty })), conversions: [{ kind: 'labor', amount: 350 }], good: 9.5, rejected: 0.5, warehouseId: W, final: true });
      const old = createProductionOrder(d, ctx, { bomId: 'BM-F01', plannedQty: 10, warehouseId: W }); recordProduction(d, ctx, old, { outputQty: 10 }); expect(po(d, old).status).toBe('completed');
      expectIntegrity(d);
      expect(codeOf(() => issueMaterials(d, ctx, old, { lines: [{ productId: 'M01', qty: 1 }] }))).toBe('INVALID');
    });
  });
});

describe('many random steps', () => {
  it('300 steps on four orders: WIP, stock and the ledger never drift, and no cost is lost or made up', () => {
    const s = shop(); s.do((d) => { put(d, 'A', 1000, 33.33); put(d, 'B', 1000, 7.77); put(d, 'C', 5000, 0.37); });
    const ids = [order(s, 33), order(s, 77), order(s, 100), order(s, 7)];
    let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const n: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const id = ids[rnd(4)], o = po(s.db, id), c = at('2026-11-13T11:00:00+07:00'), step = rnd(9);
      const ok = s.code((d) => {
        switch (step) {
          case 0: case 1: return issueMaterials(d, c, id, { lines: [{ productId: 'A', qty: (1 + rnd(50)) / 7 }, { productId: 'C', qty: (1 + rnd(90)) / 3 }] });
          case 2: return addConversion(d, c, id, { kind: (['labor', 'overhead', 'utilities', 'other'] as const)[rnd(4)], amount: (1 + rnd(5000)) / 33 });
          case 3: case 4: return receiveGoods(d, c, id, { good: (1 + rnd(30)) / 3, rejected: rnd(5) / 7, warehouseId: rnd(2) ? W : 'W1', final: rnd(25) === 0 });
          case 5: return recordLoss(d, c, id, { amount: (1 + rnd(900)) / 70, note: 'x' });
          case 6: return reverseReceipt(d, c, id, o.receipts?.[rnd(o.receipts.length || 1)]?.id ?? 'none', 'x');
          case 7: return reverseIssue(d, c, id, o.issues?.[rnd(o.issues.length || 1)]?.id ?? 'none', 'x');
          default: return reverseConversion(d, c, id, o.conversions?.[rnd(o.conversions.length || 1)]?.id ?? 'none', 'x');
        }
      });
      const k = `${step} ${ok ?? 'done'}`; n[k] = (n[k] || 0) + 1;
      for (const v of Object.values(WIP(s.db, id))) expect(v).toBeGreaterThanOrEqual(0);
      conserved(s.db, id);
      if (i % 25 === 0) sound(s.db);
    }
    for (let k = 0; k < 9; k++) expect(n[`${k} done`], `step ${k} really happened`).toBeGreaterThan(5);
    for (const id of ids) if (!['completed', 'cancelled'].includes(po(s.db, id).status)) s.code((d) => closeOrder(d, ctx, id)) && s.do((d) => cancelOrder(d, ctx, id, 'end'));
    expect(glCode(s.db, '1220')).toBe(0); sound(s.db);
  });
});
