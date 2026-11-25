import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { at, base, ctx } from '../helpers';
import { W, add, po, put, session, sound } from '../production';
import { createBom, createProductionOrder, recordProduction, setBomStatus } from '../../src/domain/bom';
import { addConversion, approveOrder, cancelOrder, closeOrder, createOrder, issueMaterials, receiveGoods, recordLoss, reverseReceipt, runProduction } from '../../src/domain/production';
import { orderCost, overview, productCost, profitability } from '../../src/domain/productionAnalysis';
import { balancesBetween, sumNetDebit } from '../../src/domain/accounting';
import { businessCosts, businessDeductions, computeEcon, totalsOf } from '../../src/domain/economics';
import { createOrder as sell, returnOrder } from '../../src/domain/orders';
import type { DB, ID } from '../../src/domain/types';
import { r2 } from '../../src/lib/util';

const LINES = [{ productId: 'A', qty: 10 }, { productId: 'B', qty: 5 }, { productId: 'C', qty: 100 }];
/** 100 FG cost 1,600 of materials + 200 labour + 100 overhead in the BOM: 19 each. */
function shop() {
  const s = session((d) => {
    put(d, 'A', 100, 100); put(d, 'B', 100, 80); put(d, 'C', 1000, 2);
    createBom(d, ctx, { productId: 'FG', name: 'FG', type: 'manufacturing', yieldQty: 100, laborCost: 200, overheadCost: 100, components: LINES.map((l) => ({ ...l, role: l.productId === 'C' ? 'packaging' : 'material' })) });
    d.products.find((p) => p.id === 'FG')!.stdCost = 20;
  });
  return Object.assign(s, { bom: s.db.boms[0].id });
}
const order = (s: ReturnType<typeof shop>, plannedQty = 100): ID => s.do((d) => { const id = createOrder(d, ctx, { bomId: s.bom, plannedQty, warehouseId: W }); approveOrder(d, ctx, id); return id; });
const full = (d: DB, id: ID, o: object = {}) => runProduction(d, ctx, id, { lines: LINES, conversions: [{ kind: 'labor', amount: 200 }, { kind: 'overhead', amount: 100 }], good: 100, rejected: 0, warehouseId: W, final: true, ...o });

describe('orderCost: estimated, standard and actual', () => {
  it('a perfect run has no variance', () => {
    const s = shop(); const id = order(s); s.do((d) => full(d, id));
    expect(orderCost(s.db, po(s.db, id))).toMatchObject({
      estimated: { materials: 1600, labor: 200, overhead: 100, total: 1900 }, estimatedPerUnit: 19, standard: 2000, standardPerUnit: 20, actual: { materials: 1600, labor: 200, overhead: 100, total: 1900 }, actualPerUnit: 19,
      variances: { materialPrice: 0, materialUsage: 0, labor: 0, overhead: 0, waste: 0, total: 0 }, waste: 0, leftover: { materials: 0, labor: 0, overhead: 0 },
    });
  });
  it('price, usage, labour, overhead and waste variances add up to the whole difference', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { put(d, 'A', 100, 120); }); // the average of A moves from 100 to 110 after the estimate
    s.do((d) => full(d, id, { lines: [{ productId: 'A', qty: 12 }, { productId: 'B', qty: 5 }, { productId: 'C', qty: 100 }], conversions: [{ kind: 'labor', amount: 230 }, { kind: 'overhead', amount: 80 }, { kind: 'utilities', amount: 5 }], good: 90, rejected: 10 }));
    const c = orderCost(s.db, po(s.db, id));
    expect(c.variances).toEqual({
      materialPrice: 120,   // 12 × (110 − 100)
      materialUsage: 200,   // (12 − 10) × 100
      labor: 30, overhead: -15, // 230 − 200 and 85 − 100
      waste: 190,           // 10 rejected × 19
      total: 525,
    });
    expect(c.variances!.total).toBe(r2(c.actual.total - 19 * 90)); // 2,235 − 1,710
    expect(c.waste).toBe(223.5); // what was really posted as waste: 10% of 2,235
    expect(c.estimated!.total).toBe(1900);
  });
  it('a material that is not in the BOM is usage, and a loss is shown as waste', () => {
    const s = shop(); s.do((d) => { add(d, 'S', 'resale', 0); put(d, 'S', 10, 7); }); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: [...LINES, { productId: 'S', qty: 2 }] }); addConversion(d, ctx, id, { kind: 'labor', amount: 200 }); addConversion(d, ctx, id, { kind: 'overhead', amount: 100 }); recordLoss(d, ctx, id, { amount: 50, note: 'spill' }); receiveGoods(d, ctx, id, { good: 100, rejected: 0, warehouseId: W, final: true }); });
    const c = orderCost(s.db, po(s.db, id));
    expect(c.variances).toMatchObject({ materialPrice: 0, materialUsage: 14, waste: 0, total: 14 }); expect(c.waste).toBe(50); expect(c.actualPerUnit).toBe(18.64);
  });
  it('no variance while the order is open: the material in WIP is not an over-use', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { issueMaterials(d, ctx, id, { lines: LINES }); receiveGoods(d, ctx, id, { good: 50, rejected: 0, warehouseId: W, final: false }); });
    expect(orderCost(s.db, po(s.db, id)).variances).toBeNull();
    s.do((d) => closeOrder(d, ctx, id));
    expect(orderCost(s.db, po(s.db, id))).toMatchObject({ variances: { materialUsage: 800, labor: -100 }, leftover: { materials: 800 } });
  });
  it('an unknown estimate or standard stays unknown, never 0', () => {
    const s = shop(); s.do((d) => { d.boms[0].versions[0].laborKnown = false; d.products.find((p) => p.id === 'FG')!.stdCost = 0; }); const id = order(s); s.do((d) => full(d, id));
    expect(orderCost(s.db, po(s.db, id))).toMatchObject({ estimated: { materials: 1600, labor: null, overhead: 100, total: null }, estimatedPerUnit: null, standard: null, standardPerUnit: null, variances: { materialPrice: 0, labor: null, waste: 0, total: null } });
  });
  it('rejects with an unknown estimate: the waste variance is unknown too', () => {
    const s = shop(); s.do((d) => { d.boms[0].versions[0].laborKnown = false; }); const id = order(s); s.do((d) => full(d, id, { good: 90, rejected: 10 }));
    expect(orderCost(s.db, po(s.db, id)).variances).toMatchObject({ waste: null, total: null });
  });
  it('reversed documents are left out', () => {
    const s = shop(); const id = order(s); const gp = s.do((d) => full(d, id)); s.do((d) => reverseReceipt(d, ctx, id, gp, 'x'));
    expect(orderCost(s.db, po(s.db, id))).toMatchObject({ actual: { total: 1900 }, actualPerUnit: null, variances: null });
  });
  it('an order of the older flow shows what it has', () => {
    const s = shop(); const id = s.do((d) => { const x = createProductionOrder(d, ctx, { bomId: s.bom, plannedQty: 100, warehouseId: W }); recordProduction(d, ctx, x, { outputQty: 100 }); return x; });
    expect(orderCost(s.db, po(s.db, id))).toMatchObject({ estimated: null, estimatedPerUnit: null, actual: { materials: 1600, labor: 200, overhead: 100, total: 1900 }, actualPerUnit: 19, variances: null });
  });
});

describe('productCost', () => {
  it('shows estimated, standard, average and last actual side by side', () => {
    const s = shop(); const id = order(s); s.do((d) => full(d, id, { good: 95 }));
    expect(productCost(s.db, 'FG')).toMatchObject({ bomId: s.bom, version: 1, estimated: 19, standard: 20, average: 20, lastActual: 20, lastActualAt: ctx.now, missing: [] });
  });
  it('is null where nothing is known', () => {
    const s = shop();
    expect(productCost(s.db, 'X')).toMatchObject({ bomId: null, version: null, estimated: null, standard: null, average: null, lastActual: null });
    s.do((d) => { d.boms[0].versions[0].components.push({ productId: 'X', qty: 1, role: 'material' }); });
    expect(productCost(s.db, 'FG')).toMatchObject({ estimated: null, missing: ['Product X'] });
  });
  it('the last actual is the latest receipt that was not reversed', () => {
    const s = shop(); const a = order(s), b = order(s);
    s.do((d) => full(d, a)); const gp = s.do((d) => full(d, b, { good: 50 }));
    expect(productCost(s.db, 'FG').lastActual).toBe(38);
    s.do((d) => reverseReceipt(d, ctx, b, gp, 'x'));
    expect(productCost(s.db, 'FG').lastActual).toBe(19);
  });
});

describe('profitability', () => {
  const priced = (price: number, cost: number) => { const s = shop(); s.do((d) => { const p = d.products.find((x) => x.id === 'X')!; p.price = price; p.stdCost = cost; }); return s; };
  it('price 107 with 7% VAT and cost 60: net 100, gross profit 40, margin 40%', () => {
    const r = profitability(priced(107, 60).db, 'X');
    expect(r).toMatchObject({ price: 107, taxRate: 0.07, netPrice: 100, cost: 60, costSource: 'standard', gpPerUnit: 40, margin: 0.4 });
  });
  it('a business that is not registered for VAT keeps the whole price', () => {
    const s = priced(107, 60); s.do((d) => { d.org.vatRegistered = false; });
    expect(profitability(s.db, 'X')).toMatchObject({ taxRate: 0, netPrice: 107, gpPerUnit: 47 });
  });
  it('a loss is negative', () => { expect(profitability(priced(53.5, 60).db, 'X')).toMatchObject({ netPrice: 50, gpPerUnit: -10, margin: -0.2 }); });
  it('no price or no cost gives null, not 0', () => {
    expect(profitability(priced(0, 60).db, 'X')).toMatchObject({ netPrice: null, cost: 60, gpPerUnit: null, margin: null, sold: null });
    expect(profitability(priced(107, 0).db, 'X')).toMatchObject({ netPrice: 100, cost: null, costSource: null, gpPerUnit: null, margin: null });
  });
  it('the cost is the average in stock, else the last actual, else the BOM estimate, else the standard cost', () => {
    const s = shop(); s.do((d) => { d.products.find((p) => p.id === 'FG')!.price = 107; });
    expect(profitability(s.db, 'FG')).toMatchObject({ cost: 19, costSource: 'estimated' });
    const id = order(s); s.do((d) => full(d, id, { good: 50 }));
    expect(profitability(s.db, 'FG')).toMatchObject({ cost: 38, costSource: 'average' });
  });
  it('real sales: net of VAT, discounts and returns, with the cost recorded at the sale', () => {
    const s = shop(); s.do((d) => { d.products.find((p) => p.id === 'FG')!.price = 107; }); const id = order(s); s.do((d) => full(d, id));
    const so = s.do((d) => sell(d, ctx, { channel: 'POS', branchId: 'B3', warehouseId: W, lines: [{ productId: 'FG', qty: 10 }], manualDiscount: 107, payments: [{ method: 'cash', amount: 5000 }], skipPromotions: true }));
    expect(profitability(s.db, 'FG').sold).toEqual({ qty: 10, net: 900, cogs: 190, gp: 710, margin: 0.7889, contribution: 710, unitNet: 90 });
    s.do((d) => returnOrder(d, ctx, { orderId: so, lines: [{ lineId: d.orders[0].lines[0].id, qty: 2, restock: true }], reason: 'x', refund: 'cash' }));
    expect(profitability(s.db, 'FG').sold).toMatchObject({ qty: 8, net: 720, cogs: 152, gp: 568 });
    expect(profitability(s.db, 'FG', '2026-11-14').sold).toBeNull();
    expect(profitability(s.db, 'FG', '2026-11-13', '2026-11-13').sold).toMatchObject({ qty: 8 });
    expect(profitability(s.db, 'A').sold).toBeNull(); // another product
    sound(s.db);
  });
  it('goods sold with no cost recorded: the profit is unknown, not 100%', () => {
    const s = shop(); s.do((d) => { const p = d.products.find((x) => x.id === 'X')!; p.price = 107; put(d, 'X', 5, 0); sell(d, ctx, { channel: 'POS', branchId: 'B3', warehouseId: W, lines: [{ productId: 'X', qty: 1 }], payments: [{ method: 'cash', amount: 500 }], skipPromotions: true }); });
    expect(profitability(s.db, 'X').sold).toMatchObject({ qty: 1, net: 100, cogs: null, gp: null, margin: null, contribution: null });
  });
  it('a menu item is costed from its recipe', () => {
    const d = base(); const r = profitability(d, 'D03');
    expect(r.costSource).toBe('estimated'); expect(r.cost).toBeGreaterThan(0); expect(r.sold!.qty).toBeGreaterThan(0); expect(r.sold!.gp).toBe(r2(r.sold!.net - r.sold!.cogs!));
  });
  it('an unknown product gives nulls, not a crash', () => { expect(profitability(shop().db, 'GONE')).toMatchObject({ price: null, netPrice: null, cost: null, sold: null }); });
});

describe('production variances in the net profit of the business', () => {
  const close = (s: ReturnType<typeof shop>) => { const id = order(s); s.do((d) => { issueMaterials(d, ctx, id, { lines: LINES }); addConversion(d, ctx, id, { kind: 'labor', amount: 140 }); receiveGoods(d, ctx, id, { good: 50, rejected: 0, warehouseId: W, final: false }); closeOrder(d, ctx, id); }); };
  /** An order closed with 800 of materials and 40 of labour left in it. */
  const leftover = () => { const s = shop(); close(s); return s; };
  const map = (s: ReturnType<typeof shop>, role: string, code: string) => s.do((d) => { d.postingMap[role] = [{ code, from: '2020-01-01T00:00:00.000Z' }]; });
  const sellFive = (s: ReturnType<typeof shop>) => s.do((d) => { d.products.find((p) => p.id === 'FG')!.price = 107; sell(d, ctx, { channel: 'POS', branchId: 'B3', warehouseId: W, lines: [{ productId: 'FG', qty: 5 }], payments: [{ method: 'cash', amount: 5000 }], skipPromotions: true }); });
  it('is 0 without variances, and every other figure is what it was', () => {
    const b = base(), c = businessCosts(b);
    expect(c.productionVariance).toBe(0);
    expect(c.absorbed).toBeGreaterThan(0); expect(businessDeductions(c)).toBe(r2(c.waste + c.adjustments + c.opex - c.absorbed));
    expect(businessCosts(produce(b, (d) => { for (const k of Object.keys(d.postingMap)) if (k.startsWith('prod_var')) delete d.postingMap[k]; }) as DB)).toEqual(c); // a database without the roles
  });
  it('is its own figure, by posting role, and is deducted once', () => {
    const s = leftover(), c = businessCosts(s.db);
    expect(c.productionVariance).toBe(840); expect(c.waste).toBe(0);
    expect(businessDeductions(c)).toBe(r2(c.waste + c.adjustments + c.opex + 840 - 140));
    expect(businessCosts(s.db, '2026-11-14').productionVariance).toBe(0); expect(businessCosts(s.db, '2026-11-13', '2026-11-13').productionVariance).toBe(840);
  });
  it('a gain (reversed goods leave at a lower average than they came in) is negative and adds to profit', () => {
    const s = shop(); const id = order(s);
    s.do((d) => { const g = full(d, id); put(d, 'FG', 100, 1); reverseReceipt(d, ctx, id, g, 'x'); });
    const c = businessCosts(s.db); expect(c.productionVariance).toBeLessThan(0); expect(businessDeductions(c)).toBe(r2(c.waste + c.adjustments + c.opex + c.productionVariance - c.absorbed));
  });
  it('all three roles on one account are counted once', () => {
    const s = shop(); for (const r of ['prod_var_material', 'prod_var_labor', 'prod_var_overhead']) map(s, r, '5310');
    close(s); expect(businessCosts(s.db).productionVariance).toBe(840);
  });
  it('a role the owner put on the waste or the adjustment account is already counted there', () => {
    const s = shop(); map(s, 'prod_var_material', '5100'); close(s);
    expect(businessCosts(s.db)).toMatchObject({ waste: 800, productionVariance: 40 });
    const s2 = shop(); map(s2, 'prod_var_material', '5200'); const adj = businessCosts(s2.db).adjustments; close(s2);
    expect(businessCosts(s2.db)).toMatchObject({ adjustments: r2(adj + 800), productionVariance: 40 });
  });
  it('a role on the cost-of-sales account counts the production entries only, never the cost of the goods sold', () => {
    const s = shop(); map(s, 'prod_var_material', '5010'); close(s); sellFive(s);
    expect(businessCosts(s.db).productionVariance).toBe(840);
  });
  it('an entry made before the role was mapped to another account still counts', () => {
    const s = leftover(); s.do((d) => { d.postingMap.prod_var_material.push({ code: '5320', from: ctx.now }); });
    expect(businessCosts(s.db).productionVariance).toBe(840);
  });
  it('ties to the ledger: contribution less these costs is the result of the income statement', () => {
    const s = leftover(); sellFive(s);
    const t = totalsOf(computeEcon(s.db).orders), bal = balancesBetween(s.db.journals);
    const ledger = r2(-sumNetDebit(s.db, bal, (a) => a.posting && (a.type === 'revenue' || a.type === 'expense')));
    expect(r2(t.contribution - businessDeductions(businessCosts(s.db)))).toBe(ledger);
  });
});

describe('overview', () => {
  it('counts and totals', () => {
    const s = shop();
    expect(overview(s.db)).toMatchObject({ boms: 1, activeBoms: 1, open: 0, inProgress: 0, completed: 0, outputUnits: 0, estimatedCost: null, actualCost: null, variance: null, shortageOrders: [] });
    const a = order(s), b = order(s), c = order(s), e = order(s, 100000), x = order(s);
    s.do((d) => { full(d, a); full(d, b, { good: 90, rejected: 10, conversions: [{ kind: 'labor', amount: 300 }, { kind: 'overhead', amount: 100 }] }); issueMaterials(d, ctx, c, { lines: LINES }); cancelOrder(d, ctx, x, 'r'); });
    s.do((d) => { createBom(d, ctx, { productId: 'X', name: 'X', type: 'manufacturing', yieldQty: 1, components: [{ productId: 'A', qty: 1, role: 'material' }], laborCost: 0, overheadCost: 0, asDraft: true }); });
    const o = overview(s.db);
    expect(o).toMatchObject({ boms: 2, activeBoms: 1, open: 2, inProgress: 1, completed: 2, outputUnits: 190, completedWithoutEstimate: 0 });
    expect(o.estimatedCost).toBe(r2(19 * 190)); expect(o.actualCost).toBe(3900); expect(o.variance).toBe(r2(3900 - 19 * 190));
    expect(o.shortageOrders).toEqual([e]);
    s.do((d) => setBomStatus(d, ctx, s.bom, 'inactive', 'x'));
    expect(overview(s.db).activeBoms).toBe(0);
  });
  it('orders without an estimate are counted apart, so estimated and actual compare the same orders', () => {
    const s = shop(); const a = order(s); s.do((d) => full(d, a));
    s.do((d) => { const x = createProductionOrder(d, at('2026-11-12T10:00:00+07:00'), { bomId: s.bom, plannedQty: 100, warehouseId: W }); recordProduction(d, ctx, x, { outputQty: 100 }); });
    expect(overview(s.db)).toMatchObject({ completed: 2, outputUnits: 200, estimatedCost: 1900, actualCost: 1900, variance: 0, completedWithoutEstimate: 1 });
  });
  it('an empty database and the demo business both work', () => {
    expect(overview(session().db)).toMatchObject({ boms: 0, open: 0, estimatedCost: null });
    expect(overview(base()).completed).toBeGreaterThan(0);
  });
});
