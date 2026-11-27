// The logic behind the production screens (src/production/forms.ts): the product search, where a BOM message is shown, what a form fills in, what a posting will do.
import { describe, expect, it } from 'vitest';
import { W, add, po, put, session } from '../production';
import { ctx } from '../helpers';
import { activateVersion, createBom, newDraftVersion, updateDraft, validateBom } from '../../src/domain/bom';
import { addConversion, approveOrder, cancelOrder, closeOrder, createOrder, issueMaterials, receiveGoods, recordLoss, reopenOrder, returnMaterials, reverseReceipt, runDefaults, runProduction } from '../../src/domain/production';
import { overview } from '../../src/domain/productionAnalysis';
import {
  EMPTY_BOM, ORDER_CARDS, bestWarehouse, bomListState, bomProblems, docsOf, dryRun, effectOf, engineText, formOf, historyOf, isEngineNote, journalsOf, missingRoles, newKey, nextStep, orderMatches, receiptFacts, searchProducts, stepsOf, stillMissing,
  traceOf, usableBoms, versionOf, type OrderView,
} from '../../src/production/forms';
import type { BomComponent, ID, Product } from '../../src/domain/types';

const COMPS: BomComponent[] = [{ productId: 'A', qty: 10, role: 'material' }, { productId: 'B', qty: 5, role: 'material' }, { productId: 'C', qty: 100, role: 'packaging' }];
function shop(o: { stock?: boolean } = {}) {
  const s = session((d) => {
    if (o.stock !== false) { put(d, 'A', 100, 100); put(d, 'B', 100, 80); put(d, 'C', 1000, 2); }
    createBom(d, ctx, { productId: 'FG', name: 'FG', type: 'manufacturing', yieldQty: 100, components: COMPS, laborCost: 200, overheadCost: 100, otherCosts: [{ kind: 'utilities', label: 'Power', amount: 50 }] });
  });
  return Object.assign(s, { bom: s.db.boms[0].id });
}
const order = (s: ReturnType<typeof shop>, qty = 100, approve = true): ID => { const id = s.do((d) => createOrder(d, ctx, { bomId: s.bom, plannedQty: qty, warehouseId: W })); if (approve) s.do((d) => approveOrder(d, ctx, id)); return id; };

describe('product search', () => {
  const p = (id: string, o: Partial<Product>): Product => ({ id, sku: id, name: id, category: 'General', kind: 'resale', unit: 'pcs', price: 0, channelPrices: {}, active: true, emoji: '', color: '', stdCost: 0, levels: {}, mediaIds: [], ...o });
  const LIST = [p('FG-1', { name: 'Grape Ice 20000', brand: 'RELX', barcode: '8850001' }), p('FG-2', { name: 'Mint', legacySku: 'OLD-77', barcode: '88500012' }), p('FG-3', { name: 'Ice Lemon', category: 'Puff', active: false }), p('FG-12', { name: 'Cola' })];
  it('finds by name, SKU, legacy SKU, barcode, brand and category, every word in any order', () => {
    const ids = (q: string) => searchProducts(LIST, q).rows.map((x) => x.id);
    expect(ids('grape')).toEqual(['FG-1']); expect(ids('old-77')).toEqual(['FG-2']); expect(ids('relx')).toEqual(['FG-1']); expect(ids('puff')).toEqual(['FG-3']);
    expect(ids('ice grape')).toEqual(['FG-1']); expect(ids('nothing')).toEqual([]); expect(ids('  ')).toHaveLength(4);
  });
  it('an exact code comes first (a scanned barcode must not pick its neighbour), then names that start with the text, active ones first', () => {
    expect(searchProducts(LIST, '8850001').rows[0].id).toBe('FG-1'); expect(searchProducts(LIST, 'fg-1').rows.map((x) => x.id)).toEqual(['FG-1', 'FG-12']);
    expect(searchProducts(LIST, 'ice').rows.map((x) => x.id)).toEqual(['FG-3', 'FG-1']); expect(searchProducts(LIST, '').rows.at(-1)!.id).toBe('FG-3');
  });
  it('what cannot be chosen goes last, and at most 50 are returned with the real total', () => {
    const many = Array.from({ length: 147 }, (_, i) => p('P' + i, {}));
    const r = searchProducts(many, 'p', (x) => x.id === 'P0'); expect(r.rows).toHaveLength(50); expect(r.total).toBe(147); expect(r.rows.some((x) => x.id === 'P0')).toBe(false);
    expect(searchProducts(LIST, '', (x) => x.id === 'FG-1').rows.at(-1)!.id).toBe('FG-1');
  });
});

describe('BOM form', () => {
  it('a new form starts with labour and overhead not known, never 0', () => {
    expect(versionOf(EMPTY_BOM)).toMatchObject({ laborKnown: false, overheadKnown: false, laborCost: 0, overheadCost: 0, components: [], yieldQty: 1 });
  });
  it('form and version are the same thing both ways', () => {
    const s = shop(), v = s.db.boms[0].versions[0];
    expect(versionOf(formOf(v))).toMatchObject({ yieldQty: 100, components: COMPS, laborCost: 200, overheadCost: 100, laborKnown: true, overheadKnown: true, otherCosts: [{ kind: 'utilities', label: 'Power', amount: 50 }] });
  });
  it('a quantity typed in another unit becomes the stock quantity and passes the engine', () => {
    const v = versionOf({ ...EMPTY_BOM, components: [{ productId: 'A', qty: 1, role: 'material', entry: { qty: 2, unit: 'box', factor: 12.5 } }] });
    expect(v.components[0].qty).toBe(25); expect(validateBom(shop().db, 'X', v)).toEqual([]);
  });
  it('an empty field is a problem, not a 0', () => {
    const v = versionOf({ ...EMPTY_BOM, laborKnown: true, laborCost: NaN, components: [{ productId: 'A', qty: NaN, role: 'material' }] });
    const b = bomProblems(shop().db, 'X', v); expect(b.costs).toEqual(['Costs must be 0 or more']); expect(b.rows[0]).toEqual(['Product A: the quantity must be greater than 0']);
  });
  it('every message of the engine is shown exactly once, at its place', () => {
    const s = session((d) => { add(d, 'M', 'menu', 0); add(d, 'A2', 'resale', 1, { name: 'Product A 2' }); });
    const v = versionOf({ ...EMPTY_BOM, yieldQty: 0, laborKnown: true, laborCost: -1, components: [
      { productId: 'A', qty: 0, role: 'material' }, { productId: 'A2', qty: 1, role: 'material' }, { productId: 'A2', qty: 2, role: 'material', wastePct: 120 }, { productId: 'M', qty: 1, role: 'material' }, { productId: 'X', qty: 1, role: 'material' },
    ] });
    const b = bomProblems(s.db, 'X', v);
    expect(b.rows[0]).toHaveLength(1); expect(b.rows[1]).toEqual([]); expect(b.rows[2]).toEqual(expect.arrayContaining([expect.stringContaining('waste allowance'), 'Product A 2 is listed more than once']));
    expect(b.batch).toEqual(['The batch yield must be greater than 0']); expect(b.costs).toEqual(['Costs must be 0 or more']); expect(b.list).toEqual([]);
    expect([...b.batch, ...b.costs, ...b.list, ...b.rows.flat()].sort()).toEqual(validateBom(s.db, 'X', v).sort());
    expect(bomProblems(s.db, 'X', versionOf(EMPTY_BOM)).list).toEqual(['Add at least one component first']);
  });
  it('only a BOM that can be produced is offered for an order', () => {
    const s = shop(); s.do((d) => { createBom(d, ctx, { productId: 'X', name: 'X', type: 'assembly', yieldQty: 1, components: [COMPS[0]], laborCost: 0, overheadCost: 0, asDraft: true }); });
    expect(usableBoms(s.db).map((x) => x.p.id)).toEqual(['FG']);
    s.do((d) => { d.products.find((p) => p.id === 'FG')!.active = false; }); expect(usableBoms(s.db)).toEqual([]);
  });
});

describe('where to produce', () => {
  it('the warehouse that holds most of the components is suggested, else the central one', () => {
    const s = shop({ stock: false }), v = s.db.boms[0].versions[0];
    expect(bestWarehouse(s.db, v, 100)).toBe('W3'); s.do((d) => put(d, 'A', 50, 1, 'W1')); expect(bestWarehouse(s.db, v, 100)).toBe('W1');
    s.do((d) => { d.warehouses = []; }); expect(bestWarehouse(s.db, v, 100)).toBe('');
  });
});

describe('what a posting will do, before it is posted', () => {
  it('a dry run shows the stock and the journals and changes nothing', () => {
    const s = shop(), id = order(s), before = JSON.stringify(s.db);
    const r = dryRun(s.db, (d, c) => issueMaterials(d, c, id, { lines: [{ productId: 'A', qty: 10 }] }, 'k1'));
    expect(JSON.stringify(s.db)).toBe(before); expect(r.error).toBeUndefined();
    expect(effectOf(r.effect!)).toEqual({ stock: [{ productId: 'A', warehouseId: W, qty: -10, value: -1000 }], entries: [{ account: '1220', debit: 1000, credit: 0 }, { account: '1210', debit: 0, credit: 1000 }], unknown: [] });
  });
  it('the reason of a refusal comes back with its code', () => {
    const s = shop(), id = order(s);
    const r = dryRun(s.db, (d, c) => issueMaterials(d, c, id, { lines: [{ productId: 'A', qty: 1e6 }] })); expect(r.error).toMatchObject({ code: 'INSUFFICIENT_STOCK' }); expect(r.effect).toBeUndefined();
  });
  it('names what leaves stock without a known cost', () => {
    const s = session((d) => { put(d, 'X', 5, 0); createBom(d, ctx, { productId: 'FG', name: 'FG', type: 'assembly', yieldQty: 1, components: [{ productId: 'X', qty: 1, role: 'material' }], laborCost: 0, overheadCost: 0 }); });
    const id = s.do((d) => { const o = createOrder(d, ctx, { bomId: d.boms[0].id, plannedQty: 1, warehouseId: W }); approveOrder(d, ctx, o); return o; });
    const ask = (confirmUnknownCost: boolean) => dryRun(s.db, (d, c) => issueMaterials(d, c, id, { lines: [{ productId: 'X', qty: 1 }], confirmUnknownCost }));
    expect(ask(false).error).toMatchObject({ code: 'UNKNOWN_COST' }); expect(effectOf(ask(true).effect!).unknown).toEqual(['X']);
  });
});

describe('reading an order', () => {
  it('cards: the number is the length of the list it opens, and agrees with the overview of the engine', () => {
    const s = shop(); const a = order(s), b = order(s, 20); order(s, 5, false); order(s, 5000);
    s.do((d) => runProduction(d, ctx, a, { ...runDefaults(d, po(d, a), 100), good: 100, rejected: 0, warehouseId: W, final: true }));
    s.do((d) => issueMaterials(d, ctx, b, { lines: [{ productId: 'A', qty: 1 }] }));
    const n = (v: OrderView) => s.db.productionOrders.filter((o) => orderMatches(s.db, o, v)).length, o = overview(s.db);
    expect({ all: n('all'), open: n('open'), progress: n('progress'), done: n('done'), short: n('short') }).toEqual({ all: 4, open: 3, progress: 1, done: 1, short: 1 });
    expect([o.open, o.inProgress, o.completed, o.shortageOrders.length]).toEqual([n('open'), n('progress'), n('done'), n('short')]);
    expect(n('costed')).toBe(o.completed - o.completedWithoutEstimate); s.do((d) => { po(d, a).estimate!.laborPerUnit = null; }); expect(n('costed')).toBe(0); expect(overview(s.db).actualCost).toBeNull();
    expect(ORDER_CARDS).toEqual(['open', 'progress', 'short', 'done']);
  });
  it('documents: issues, costs, losses, returns, receipts and variances, each with its journal and what was reversed', () => {
    const s = shop(), id = order(s);
    // material that was issued before the run stays in the order for what is made later …
    s.do((d) => { issueMaterials(d, ctx, id, { lines: runDefaults(d, po(d, id), 100).lines }); runProduction(d, ctx, id, { lines: [], conversions: [{ kind: 'labor', amount: 200 }], good: 50, rejected: 0, warehouseId: W, final: false }); recordLoss(d, ctx, id, { amount: 10, note: 'spill' }); });
    s.do((d) => reverseReceipt(d, ctx, id, po(d, id).receipts![0].id, 'wrong count'));
    const docs = docsOf(po(s.db, id)); expect(docs.map((x) => x.kind).sort()).toEqual(['cost', 'issue', 'loss', 'receipt']);
    for (const x of docs) expect(s.db.journals.some((j) => j.id === x.journalId)).toBe(true);
    expect(docs.find((x) => x.kind === 'receipt')).toMatchObject({ value: 1000, unitCost: 20, reversal: { reason: 'wrong count' } }); // half of 1,600 and all of the run's own labour
    expect(journalsOf(s.db, po(s.db, id))).toHaveLength(5); // issue, labour, receipt, loss, and the mirror of the receipt
    s.do((d) => { returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 2, warehouseId: W }], reason: 'not needed' }); cancelOrder(d, ctx, id, 'stop'); reopenOrder(d, ctx, id, 'go on'); });
    const more = docsOf(po(s.db, id)); expect(more.find((x) => x.kind === 'return')).toMatchObject({ note: 'not needed', lines: [{ productId: 'A', qty: 2 }] }); expect(more.find((x) => x.kind === 'variance')).toMatchObject({ why: 'cancelled', reversal: { reason: 'go on' } });
    for (const x of more) expect(s.db.journals.some((j) => j.id === x.journalId)).toBe(true);
    expect(journalsOf(s.db, po(s.db, id))).toHaveLength(8);
  });
  it('… and material issued in the run itself goes with its own receipt, all of it', () => {
    const s = shop(), id = order(s);
    s.do((d) => runProduction(d, ctx, id, { lines: runDefaults(d, po(d, id), 100).lines, conversions: [{ kind: 'labor', amount: 200 }], good: 50, rejected: 0, warehouseId: W, final: false }));
    expect(po(s.db, id)).toMatchObject({ wip: { materials: 0, labor: 0, overhead: 0 }, receipts: [{ goodValue: 1800, unitCost: 36 }] });
    expect(s.code((d) => recordLoss(d, ctx, id, { amount: 10, note: 'spill' }))).toBe('INVALID'); // nothing is left to lose
    expect(docsOf(po(s.db, id)).map((x) => [x.kind, x.value])).toEqual([['receipt', 1800], ['cost', 200], ['issue', 1600]]); expect(journalsOf(s.db, po(s.db, id))).toHaveLength(3);
  });
  it('the next step is always something that can be done', () => {
    const s = shop(), id = order(s, 100, false); const step = () => nextStep(s.db, po(s.db, id));
    expect(step()).toBe('approve'); s.do((d) => approveOrder(d, ctx, id)); expect(step()).toBe('run');
    s.do((d) => issueMaterials(d, ctx, id, { lines: runDefaults(d, po(d, id), 100).lines })); expect(step()).toBe('run'); // labour and overhead of the BOM are still missing
    s.do((d) => { for (const c of runDefaults(d, po(d, id), 100).conversions) addConversion(d, ctx, id, c); }); expect(step()).toBe('receive');
    s.do((d) => receiveGoods(d, ctx, id, { good: 60, rejected: 0, warehouseId: W, final: false })); expect(step()).toBe('finish');
    expect(stepsOf(po(s.db, id)).map((x) => x.state)).toEqual(['done', 'done', 'done', 'now', '']); // it was never a draft
    s.do((d) => closeOrder(d, ctx, id)); expect(step()).toBe('done');
    expect(stepsOf(po(s.db, id)).map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'now']);
  });
  it('after rejects the next step is replacement material, not goods without a cost', () => {
    const s = shop(), id = order(s); s.do((d) => runProduction(d, ctx, id, { ...runDefaults(d, po(d, id), 100), good: 90, rejected: 10, warehouseId: W, final: false }));
    expect(nextStep(s.db, po(s.db, id))).toBe('run'); expect(runDefaults(s.db, po(s.db, id), 10).lines[0]).toEqual({ productId: 'A', qty: 1 });
  });
  it('what a receipt would miss: the order holds too little, a run brings some of it, the BOM does not know', () => {
    const s = shop(), id = order(s); s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 10 }] }));
    const all = stillMissing(s.db, po(s.db, id), 100); expect(all.materials.map((m) => [m.productId, m.missing])).toEqual([['B', 5], ['C', 100]]); expect(all.conversions.map((c) => [c.element, c.missing])).toEqual([['labor', 200], ['overhead', 150]]); expect(all.unknown).toEqual([]);
    const part = stillMissing(s.db, po(s.db, id), 100, { lines: [{ productId: 'B', qty: 5 }, { productId: 'C', qty: 40 }], conversions: [{ kind: 'labor', amount: 200 }, { kind: 'utilities', amount: 50 }] });
    expect(part.materials.map((m) => [m.productId, m.missing])).toEqual([['C', 60]]); expect(part.conversions.map((c) => [c.element, c.missing])).toEqual([['overhead', 100]]);
    expect(stillMissing(s.db, po(s.db, id), 100, runDefaults(s.db, po(s.db, id), 100))).toEqual({ materials: [], conversions: [], unknown: [] });
    s.do((d) => { po(d, id).estimate!.laborPerUnit = null; }); expect(stillMissing(s.db, po(s.db, id), 1).unknown).toEqual(['labor']); expect(stillMissing(s.db, po(s.db, id), 1, { lines: [], conversions: [{ kind: 'labor', amount: 1 }] }).unknown).toEqual([]);
  });
  it('the cost a receipt takes, and what of a final one becomes a variance', () => {
    const s = shop(), id = order(s); s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 20 }] })); s.do((d) => receiveGoods(d, ctx, id, { good: 50, rejected: 0, warehouseId: W, final: false }));
    const r = dryRun(s.db, (d, c) => receiveGoods(d, c, id, { good: 40, rejected: 10, warehouseId: W, final: true }));
    // 5 of 20 were used; 15 are left, 5 are needed, 10 are an excess: half of it here, half a variance
    expect(receiptFacts(r.next!, id)).toEqual({ cost: 1000, good: 40, rejected: 10, goodValue: 800, rejectedValue: 200, unitCost: 20, variance: 500 });
  });
  it('history lists every event of every order and the changes of the BOMs', () => {
    const s = shop(), id = order(s); s.do((d) => { newDraftVersion(d, ctx, s.bom); updateDraft(d, ctx, s.bom, 2, { yieldQty: 50 }); activateVersion(d, ctx, s.bom, 2, ctx.now); });
    s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1 }] }));
    s.do((d) => runProduction(d, ctx, id, { lines: [{ productId: 'B', qty: 1 }], conversions: [{ kind: 'labor', amount: 5 }], good: 1, rejected: 0, warehouseId: W, final: false }));
    expect(historyOf(s.db).filter((x) => x.orderId && x.kind !== 'status').map((x) => x.kind)).toEqual(['receipt', 'cost', 'issue', 'issue']); // newest first, also within one step
    const kinds = historyOf(s.db).map((x) => x.kind); for (const k of ['bom', 'status', 'issue'] as const) expect(kinds).toContain(k);
    const line = historyOf(s.db).find((x) => x.kind === 'issue' && x.productId === 'B')!; expect(line).toMatchObject({ orderNo: po(s.db, id).no, bomVersion: 1, qty: -1, warehouseId: W, unitCost: 80, value: 80, userId: 'U1' }); expect(line.no).toMatch(/^MIS-/);
  });
});

describe('traceability', () => {
  it('every line of material and goods with its order, document, BOM version, quantity, place, user and cost', () => {
    const s = shop(), id = order(s); s.do((d) => runProduction(d, ctx, id, { ...runDefaults(d, po(d, id), 100), good: 98, rejected: 2, warehouseId: 'W1', final: false })); s.do((d) => issueMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 2 }] })); s.do((d) => returnMaterials(d, ctx, id, { lines: [{ productId: 'A', qty: 1, warehouseId: 'W2' }], reason: 'x' }));
    const t = traceOf(s.db), no = po(s.db, id).no; expect(t).toHaveLength(6); for (const x of t) expect(x).toMatchObject({ orderNo: no, bomVersion: 1, userId: 'U1' });
    expect(t.filter((x) => x.kind === 'issue').map((x) => [x.productId, x.qty, x.warehouseId])).toEqual(expect.arrayContaining([['A', 10, W], ['B', 5, W], ['C', 100, W], ['A', 2, W]]));
    expect(t.find((x) => x.kind === 'return')).toMatchObject({ productId: 'A', qty: 1, warehouseId: 'W2', unitCost: 100, value: 100 }); expect(t.find((x) => x.kind === 'receipt')).toMatchObject({ productId: 'FG', qty: 98, rejected: 2, warehouseId: 'W1' });
    for (const x of t) { expect(x.no).toMatch(/^(MIS|MRT|FGR)-/); expect(s.db.journals.some((j) => j.id === x.journalId)).toBe(true); }
  });
});

describe('BOM list and engine texts', () => {
  const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  it('a version that starts later is scheduled, and cannot be chosen for an order', () => {
    const s = session((d) => { const b = createBom(d, ctx, { productId: 'X', name: 'X', type: 'assembly', yieldQty: 1, components: [COMPS[0]], laborCost: 0, overheadCost: 0, asDraft: true }); activateVersion(d, ctx, b, 1, day(5)); });
    expect(bomListState(s.db.boms[0])).toBe('scheduled'); expect(usableBoms(s.db)).toEqual([]); expect(bomListState(shop().db.boms[0])).toBe('active');
    s.do((d) => { d.boms[0].status = 'archived'; }); expect(bomListState(s.db.boms[0])).toBe('archived');
  });
  it('English the engine stores is shown in the language of the screen', () => {
    const T = (k: string, v?: Record<string, string | number>) => '[' + k.replace(/\{(\w+)\}/g, (_, x: string) => String(v?.[x])) + ']';
    expect(engineText(T, 'Copied from Gift box v2')).toBe('[Copied from Gift box v2]'); expect(engineText(T, 'Draft based on v1')).toBe('[Draft based on v1]'); expect(engineText(T, 'PRD-000001 MIS-000002 (BOM v1): reversed, wrong')).toBe('PRD-000001 MIS-000002 (BOM v1): [reversed], wrong');
    expect(engineText(T, 'my own note')).toBe('my own note'); expect([isEngineNote('Draft based on v1'), isEngineNote('Copied from a v1'), isEngineNote('Draft')]).toEqual([true, true, false]);
  });
});

describe('posting roles', () => {
  it('names what is not mapped, or mapped to an account that cannot be used', () => {
    const s = session(); expect(missingRoles(s.db)).toEqual([]);
    s.do((d) => { d.postingMap.wip = []; d.accounts.find((a) => a.code === '5320')!.active = false; }); expect(missingRoles(s.db)).toEqual(['wip', 'prod_var_labor']);
  });
});
it('keys are never the same', () => { expect(new Set(Array.from({ length: 200 }, newKey)).size).toBe(200); });
