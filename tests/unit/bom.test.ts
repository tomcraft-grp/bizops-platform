import { describe, expect, it } from 'vitest';
import { ctx } from '../helpers';
import { add, put, session } from '../production';
import {
  activateVersion, bomCost, bomForProduct, bomRequirement, createBom, createProductionOrder, discardDraft, duplicateBom, newDraftVersion, recordProduction, setBomStatus, updateDraft, validateBom, versionAt,
} from '../../src/domain/bom';
import { createOrder as sell } from '../../src/domain/orders';
import { thaiForError } from '../../src/lib/errorText';
import type { BomComponent, BomVersion, DB, ProductKind } from '../../src/domain/types';

const THAI = /[ก-๿]/;
const u = (userId: string) => ({ ...ctx, userId });
const KINDS: ProductKind[] = ['resale', 'finished', 'menu', 'material', 'packaging', 'wip'];
const c = (productId: string, qty: number, o: Partial<BomComponent> = {}): BomComponent => ({ productId, qty, role: 'material', ...o });
const V = (components: BomComponent[], o: Partial<BomVersion> = {}): BomVersion => ({ version: 1, status: 'active', effectiveFrom: ctx.now, createdAt: ctx.now, yieldQty: 100, laborCost: 0, overheadCost: 0, components, ...o });
const ABC = [c('A', 10), c('B', 5), c('C', 100, { role: 'packaging' })];
const make = (d: DB, productId = 'FG', components = ABC, o: Partial<Parameters<typeof createBom>[2]> = {}) =>
  createBom(d, ctx, { productId, name: 'BOM ' + productId, type: 'manufacturing', yieldQty: 100, components, laborCost: 0, overheadCost: 0, ...o });
const ver = (d: DB, id: string, n: number) => d.boms.find((b) => b.id === id)!.versions.find((v) => v.version === n)!;

describe('what can be produced, and from what', () => {
  it.each(KINDS)('a %s product can be the output', (kind) => {
    const s = session((d) => { add(d, 'OUT', kind, 0); });
    const id = s.do((d) => make(d, 'OUT'));
    expect(bomForProduct(s.db, 'OUT')!.id).toBe(id);
    expect(s.db.products.find((p) => p.id === 'OUT')!.bomId).toBe(id);
    expect(s.db.audit.some((a) => a.action === 'bom.create' && a.entityId === id)).toBe(true);
  });
  it.each(KINDS)('a %s product as a component', (kind) => {
    const s = session((d) => { add(d, 'CMP', kind, 5); });
    expect(s.code((d) => make(d, 'FG', [c('CMP', 1)]))).toBe(kind === 'menu' ? 'INVALID' : null);
  });
  it('an inactive product cannot be given a BOM; a product has one BOM', () => {
    const s = session((d) => { add(d, 'OFF', 'resale', 0, { active: false }); });
    expect(s.code((d) => make(d, 'OFF'))).toBe('INACTIVE');
    s.do((d) => make(d));
    expect(s.code((d) => make(d))).toBe('DUPLICATE');
  });
  it('needs production:edit', () => {
    const s = session();
    expect(s.code((d) => createBom(d, u('U6'), { productId: 'FG', name: 'x', type: 'manufacturing', yieldQty: 1, components: ABC, laborCost: 0, overheadCost: 0 }))).toBe('FORBIDDEN');
  });
});

describe('validation', () => {
  const bad: [string, BomComponent[], Partial<BomVersion>, RegExp][] = [
    ['no component', [], {}, /at least one component/],
    ['zero quantity', [c('A', 0)], {}, /Product A.*quantity/],
    ['negative quantity', [c('A', -1)], {}, /quantity/],
    ['quantity that is not a number', [c('A', NaN)], {}, /quantity/],
    ['infinite quantity', [c('A', Infinity)], {}, /quantity/],
    ['negative waste', [c('A', 1, { wastePct: -1 })], {}, /waste/],
    ['waste above 99', [c('A', 1, { wastePct: 100 })], {}, /waste/],
    ['waste that is not a number', [c('A', 1, { wastePct: NaN })], {}, /waste/],
    ['the same component twice', [c('A', 1), c('B', 1), c('A', 2)], {}, /Product A.*more than once/],
    ['the output as its own component', [c('FG', 1)], {}, /its own component/],
    ['an unknown product', [c('NOPE', 1)], {}, /NOPE/],
    ['a unit entry that does not match', [c('A', 1, { entry: { qty: 500, unit: 'g', factor: 0.1 } })], {}, /unit/],
    ['a unit entry with a zero factor', [c('A', 1, { entry: { qty: 500, unit: 'g', factor: 0 } })], {}, /unit/],
    ['negative labour', ABC, { laborCost: -1 }, /cost/i],
    ['overhead that is not a number', ABC, { overheadCost: NaN }, /cost/i],
    ['a negative other cost', ABC, { otherCosts: [{ kind: 'utilities', label: 'Power', amount: -5 }] }, /cost/i],
    ['zero yield', ABC, { yieldQty: 0 }, /yield/i],
    ['negative yield', ABC, { yieldQty: -1 }, /yield/i],
    ['a yield that is not a number', ABC, { yieldQty: NaN }, /yield/i],
    ['labour that is too large (review C)', ABC, { laborCost: 1e13 }, /too large/i],
    ['overhead that is too large', ABC, { overheadCost: 1e13 }, /too large/i],
    ['an other cost that is too large', ABC, { otherCosts: [{ kind: 'utilities', label: 'Power', amount: 1e13 }] }, /too large/i],
    ['a yield that is too large', ABC, { yieldQty: 1e10 }, /yield.*too large/i],
  ];
  it.each(bad)('%s', (_n, comps, o, re) => {
    const s = session();
    const issues = validateBom(s.db, 'FG', V(comps, o));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(' | ')).toMatch(re);
    for (const i of issues) expect(thaiForError(i), i).toMatch(THAI);
    expect(s.code((d) => make(d, 'FG', comps, o as never))).toBe('INVALID');
    expect(s.db.boms).toEqual([]);
  });
  it('a good one has no issue (waste, unit entry, other costs)', () => {
    expect(validateBom(session().db, 'FG', V([c('A', 0.5, { wastePct: 3, entry: { qty: 500, unit: 'g', factor: 0.001 } }), c('B', 1, { wastePct: 0 }), c('C', 1, { wastePct: 99 })], { otherCosts: [{ kind: 'other', label: 'Delivery', amount: 0 }] }))).toEqual([]);
  });
  it('a menu item as a component is refused, with a reason', () => {
    const s = session((d) => { add(d, 'MENU', 'menu', 5); });
    expect(validateBom(s.db, 'FG', V([c('MENU', 1)]))[0]).toMatch(/Product MENU.*menu/);
    expect(thaiForError(validateBom(s.db, 'FG', V([c('MENU', 1)]))[0])).toMatch(THAI);
  });
  it('a missing output product is an issue, not a crash', () => {
    expect(validateBom(session().db, 'GONE', V(ABC)).join()).toMatch(/GONE/);
  });
  it('a circular BOM is refused, directly and through several levels', () => {
    const s = session();
    s.do((d) => make(d, 'A', [c('B', 1)]));
    s.do((d) => make(d, 'B', [c('C', 1)]));
    const issues = validateBom(s.db, 'C', V([c('A', 1)]));
    expect(issues.join()).toMatch(/circular/); expect(thaiForError(issues[0])).toMatch(THAI);
    expect(s.code((d) => make(d, 'C', [c('A', 1)]))).toBe('INVALID');
    expect(s.code((d) => make(d, 'FG', [c('A', 1), c('C', 1)]))).toBe(null); // the same part at two levels is not a circle
  });
  it('two drafts cannot become a circle: the second activation is refused', () => {
    const s = session();
    const a = s.do((d) => make(d, 'A', [c('B', 1)], { asDraft: true })), b = s.do((d) => make(d, 'B', [c('A', 1)], { asDraft: true }));
    s.do((d) => activateVersion(d, ctx, a, 1, ctx.now));
    expect(s.code((d) => activateVersion(d, ctx, b, 1, ctx.now))).toBe('INVALID');
  });
  it('an existing data loop does not hang the check', () => {
    const s = session();
    s.do((d) => { make(d, 'A', [c('B', 1)]); make(d, 'B', [c('C', 1)]); d.boms[1].versions[0].components = [c('A', 1)]; });
    expect(validateBom(s.db, 'FG', V([c('A', 1)]))).toEqual([]);
  });
  it('the draft is checked when it is saved and when it is activated', () => {
    const s = session();
    const id = s.do((d) => make(d));
    const n = s.do((d) => newDraftVersion(d, ctx, id));
    expect(s.code((d) => updateDraft(d, ctx, id, n, { components: [c('FG', 1)] }))).toBe('INVALID');
    expect(s.code((d) => updateDraft(d, ctx, id, n, { yieldQty: 0 }))).toBe('INVALID');
    s.do((d) => { ver(d, id, n).components = [c('A', -1)]; });
    expect(s.code((d) => activateVersion(d, ctx, id, n, ctx.now))).toBe('INVALID');
  });
});

describe('a recipe costs what a sale posts', () => {
  const menu = () => session((d) => { add(d, 'M', 'menu', 0); });
  const both = (msg: string, re: RegExp) => { expect(msg).toMatch(re); expect(thaiForError(msg), msg).toMatch(THAI); };
  it('a waste allowance on a menu item is refused: the quantity must include it', () => {
    const s = menu();
    expect(validateBom(s.db, 'M', V([c('A', 1, { wastePct: 5 })]))).toHaveLength(1); both(validateBom(s.db, 'M', V([c('A', 1, { wastePct: 5 })]))[0], /Product A.*include the waste in the quantity/);
    expect(validateBom(s.db, 'M', V([c('A', 1, { wastePct: 0 })]))).toEqual([]); expect(validateBom(s.db, 'FG', V([c('A', 1, { wastePct: 5 })]))).toEqual([]);
    expect(s.code((d) => make(d, 'M', [c('A', 1, { wastePct: 5 })]))).toBe('INVALID');
  });
  it('other costs on a menu item are refused: they belong in labour or overhead', () => {
    const s = menu(), o = (amount: number) => V(ABC, { otherCosts: [{ kind: 'utilities', label: 'Gas', amount }] });
    both(validateBom(s.db, 'M', o(5))[0], /labour or overhead/); expect(validateBom(s.db, 'M', o(0))).toEqual([]); expect(validateBom(s.db, 'FG', o(5))).toEqual([]);
    const id = s.do((d) => make(d, 'M')); const n = s.do((d) => newDraftVersion(d, ctx, id));
    expect(s.code((d) => updateDraft(d, ctx, id, n, { otherCosts: [{ kind: 'other', label: 'x', amount: 1 }] }))).toBe('INVALID');
  });
  it('a BOM with waste or other costs cannot be copied to a menu item; a plain one can', () => {
    const s = menu();
    const a = s.do((d) => make(d, 'FG', [c('A', 1, { wastePct: 5 })])), b = s.do((d) => make(d, 'X', ABC, { otherCosts: [{ kind: 'other', label: 'x', amount: 1 }] })), p = s.do((d) => make(d, 'C', [c('A', 1)]));
    expect(s.code((d) => duplicateBom(d, ctx, a, 'M'))).toBe('INVALID'); expect(s.code((d) => duplicateBom(d, ctx, b, 'M'))).toBe('INVALID');
    expect(s.code((d) => duplicateBom(d, ctx, p, 'M'))).toBe(null);
  });
  it.each(['inactive', 'archived'] as const)('the recipe of an active menu item cannot be made %s: a sale would still use it', (st) => {
    const s = menu(); const id = s.do((d) => make(d, 'M'));
    expect(s.code((d) => setBomStatus(d, ctx, id, st, 'x'))).toBe('INVALID'); both(s.msg((d) => setBomStatus(d, ctx, id, st, 'x')), /Product M.*Deactivate the menu item first/);
    s.do((d) => { d.products.find((p) => p.id === 'M')!.active = false; });
    expect(s.code((d) => setBomStatus(d, ctx, id, st, 'x'))).toBe(null);
    expect(s.code((d) => setBomStatus(d, ctx, id, 'active', 'x'))).toBe(null);
  });
  it('the recipe cost shown is the cost a sale posts', () => {
    const s = menu(); s.do((d) => { put(d, 'A', 10, 30); d.products.find((p) => p.id === 'M')!.price = 107; });
    s.do((d) => make(d, 'M', [c('A', 2)], { yieldQty: 1, laborCost: 5, overheadCost: 3 }));
    const shown = bomCost(s.db, s.db.boms[0].versions[0], 'W3').perUnit;
    const id = s.do((d) => sell(d, ctx, { channel: 'POS', branchId: 'B3', warehouseId: 'W3', lines: [{ productId: 'M', qty: 1 }], payments: [{ method: 'cash', amount: 107 }], skipPromotions: true }));
    expect(s.db.orders.find((o) => o.id === id)!.lines[0].cost).toBe(shown);
  });
});

describe('drafts, duplicate, status and history', () => {
  it('a draft keeps its extra fields and can be edited, activated and discarded', () => {
    const s = session();
    const id = s.do((d) => make(d, 'FG', [c('A', 1, { wastePct: 5, entry: { qty: 1000, unit: 'g', factor: 0.001 } })], { asDraft: true, laborKnown: false, otherCosts: [{ kind: 'utilities', label: 'Power', amount: 20 }] }));
    expect(ver(s.db, id, 1)).toMatchObject({ status: 'draft', laborKnown: false, otherCosts: [{ amount: 20 }], components: [{ wastePct: 5, entry: { unit: 'g' } }] });
    expect(versionAt(s.db.boms[0], ctx.now)).toBeUndefined();
    s.do((d) => updateDraft(d, ctx, id, 1, { laborCost: 70, laborKnown: true, otherCosts: [] }));
    expect(s.db.audit.some((a) => a.action === 'bom.update')).toBe(true);
    s.do((d) => activateVersion(d, ctx, id, 1, ctx.now));
    const n = s.do((d) => newDraftVersion(d, ctx, id));
    expect(ver(s.db, id, n)).toMatchObject({ laborCost: 70, components: [{ wastePct: 5 }] });
    expect(s.code((d) => discardDraft(d, u('U6'), id, n))).toBe('FORBIDDEN');
    s.do((d) => discardDraft(d, ctx, id, n));
    expect(s.db.boms[0].versions).toHaveLength(1);
    expect(s.code((d) => discardDraft(d, ctx, id, 1))).toBe('INVALID');
    expect(s.code((d) => updateDraft(d, ctx, id, 1, { laborCost: 1 }))).toBe('IMMUTABLE');
  });
  it('discarding the only draft of a new BOM removes the empty BOM, so the product can have one again', () => {
    const s = session();
    const id = s.do((d) => make(d, 'FG', ABC, { asDraft: true }));
    s.do((d) => discardDraft(d, ctx, id, 1));
    expect(s.db.boms).toEqual([]); expect(s.db.products.find((p) => p.id === 'FG')!.bomId).toBeUndefined();
    expect(s.code((d) => make(d))).toBe(null);
  });
  it('duplicate copies the active version to another product as a draft and leaves the source alone', () => {
    const s = session();
    const id = s.do((d) => make(d, 'FG', [c('A', 2, { wastePct: 4 })], { laborCost: 30 }));
    const before = JSON.stringify(s.db.boms[0]);
    const copy = s.do((d) => duplicateBom(d, ctx, id, 'X'));
    expect(bomForProduct(s.db, 'X')).toMatchObject({ id: copy, productId: 'X' });
    expect(bomForProduct(s.db, 'X')!.versions).toHaveLength(1);
    expect(ver(s.db, copy, 1)).toMatchObject({ version: 1, status: 'draft', laborCost: 30, components: [{ productId: 'A', qty: 2, wastePct: 4 }] });
    s.do((d) => updateDraft(d, ctx, copy, 1, { components: [c('B', 9)] }));
    expect(JSON.stringify(s.db.boms[0])).toBe(before);
    expect(s.code((d) => duplicateBom(d, ctx, id, 'X'))).toBe('DUPLICATE');
    expect(s.code((d) => duplicateBom(d, ctx, id, 'A'))).toBe('INVALID'); // A would contain itself
    expect(s.code((d) => duplicateBom(d, ctx, 'NOPE', 'B'))).toBe('NOT_FOUND');
    expect(s.code((d) => duplicateBom(d, u('U6'), id, 'B'))).toBe('FORBIDDEN');
    expect(s.db.audit.some((a) => a.action === 'bom.duplicate' && a.entityId === copy)).toBe(true);
  });
  it('status needs a reason, is audited, keeps the versions, and an archived BOM is read-only', () => {
    const s = session();
    const id = s.do((d) => make(d));
    const versions = JSON.stringify(s.db.boms[0].versions);
    expect(s.code((d) => setBomStatus(d, ctx, id, 'inactive', ' '))).toBe('REASON');
    expect(s.code((d) => setBomStatus(d, ctx, id, 'active', 'x'))).toBe('INVALID');
    expect(s.code((d) => setBomStatus(d, ctx, id, 'whatever' as never, 'x'))).toBe('INVALID');
    expect(s.code((d) => setBomStatus(d, u('U6'), id, 'inactive', 'x'))).toBe('FORBIDDEN');
    s.do((d) => setBomStatus(d, ctx, id, 'archived', 'old product'));
    expect(s.db.boms[0].status).toBe('archived'); expect(JSON.stringify(s.db.boms[0].versions)).toBe(versions);
    expect(s.db.audit.at(-1)).toMatchObject({ action: 'bom.status' }); expect(s.db.audit.at(-1)!.detail).toMatch(/old product/);
    expect(s.code((d) => newDraftVersion(d, ctx, id))).toBe('INVALID');
    s.do((d) => setBomStatus(d, ctx, id, 'active', 'needed again'));
    expect(s.code((d) => newDraftVersion(d, ctx, id))).toBe(null);
  });
  it('a revision does not change the snapshot of an open order (existing order flow untouched)', () => {
    const s = session((d) => { put(d, 'A', 100, 100); put(d, 'B', 100, 80); put(d, 'C', 1000, 2); });
    const id = s.do((d) => make(d));
    const o = s.do((d) => createProductionOrder(d, ctx, { bomId: id, plannedQty: 100, warehouseId: 'W3' }));
    const n = s.do((d) => newDraftVersion(d, ctx, id));
    s.do((d) => updateDraft(d, ctx, id, n, { components: [c('A', 99)] }));
    s.do((d) => activateVersion(d, ctx, id, n, ctx.now));
    expect(s.db.productionOrders.find((x) => x.id === o)!.snapshot.components).toEqual(ABC);
    s.do((d) => recordProduction(d, ctx, o, { outputQty: 100 }));
    expect(s.db.productionOrders.find((x) => x.id === o)!.batches[0].materialCost).toBe(1600);
  });
});

describe('requirement and cost', () => {
  it('requirement scales with the output and includes the waste allowance', () => {
    const v = V([c('A', 10), c('B', 5, { wastePct: 10 }), c('C', 100)]);
    expect(bomRequirement(v, 100)).toEqual([{ productId: 'A', qty: 10 }, { productId: 'B', qty: 5.5 }, { productId: 'C', qty: 100 }]);
    expect(bomRequirement(v, 25)).toEqual([{ productId: 'A', qty: 2.5 }, { productId: 'B', qty: 1.375 }, { productId: 'C', qty: 25 }]);
    expect(bomRequirement(v, 0).every((x) => x.qty === 0)).toBe(true);
    expect(bomRequirement(V([c('A', 1), c('A', 2)], { yieldQty: 1 }), 1)).toEqual([{ productId: 'A', qty: 3 }]); // an old BOM with a repeated line
  });
  it('10 × 100 + 5 × 80 + 100 × 2 = 1,600, 16 per unit', () => {
    const s = session((d) => { put(d, 'A', 50, 100); put(d, 'B', 50, 80); put(d, 'C', 500, 2); });
    const r = bomCost(s.db, V(ABC));
    expect(r).toMatchObject({ materials: 1400, packaging: 200, labor: 0, overhead: 0, other: 0, batch: 1600, perUnit: 16, missing: [] });
    expect(r.lines.map((l) => [l.productId, l.qty, l.unitCost, l.cost, l.source])).toEqual([['A', 10, 100, 1000, 'average'], ['B', 5, 80, 400, 'average'], ['C', 100, 2, 200, 'average']]);
    expect(r.lines[0]).toMatchObject({ name: 'Product A', unit: 'pcs' });
  });
  it('labour, overhead, other costs and the waste allowance are part of it', () => {
    const r = bomCost(session().db, V([c('A', 10, { wastePct: 10 })], { laborCost: 50, overheadCost: 30, otherCosts: [{ kind: 'utilities', label: 'Power', amount: 15 }, { kind: 'other', label: 'x', amount: 5 }] }));
    expect(r).toMatchObject({ materials: 1100, labor: 50, overhead: 30, other: 20, batch: 1200, perUnit: 12 });
    expect(r.lines[0]).toMatchObject({ qty: 11, source: 'standard' }); // no stock yet: the standard cost of the product
  });
  it('a component nobody knows the cost of is unknown and listed, never 0', () => {
    const r = bomCost(session().db, V([c('A', 10), c('X', 1)]));
    expect(r.lines[1]).toMatchObject({ unitCost: null, cost: null, source: 'unknown' });
    expect(r).toMatchObject({ batch: null, perUnit: null, missing: ['Product X'] });
    expect(r.materials).toBe(1000); // what is known so far
  });
  it('stock brought in at no cost is also unknown', () => {
    const s = session((d) => { d.products.find((p) => p.id === 'X')!.stdCost = 0; put(d, 'X', 10, 0); });
    expect(bomCost(s.db, V([c('X', 1)])).lines[0]).toMatchObject({ unitCost: null, source: 'unknown' });
  });
  it('labour or overhead marked as not known makes the total unknown', () => {
    const r = bomCost(session().db, V(ABC, { laborCost: 0, laborKnown: false, overheadCost: 10 }));
    expect(r).toMatchObject({ labor: null, overhead: 10, batch: null, perUnit: null }); expect(r.missing).toHaveLength(1);
  });
  it('the warehouse average comes first, then the average elsewhere, then the standard cost', () => {
    const s = session((d) => { put(d, 'A', 10, 90, 'W1'); put(d, 'A', 10, 120, 'W3'); put(d, 'B', 10, 77, 'W1'); });
    expect(bomCost(s.db, V([c('A', 1)]), 'W3').lines[0].unitCost).toBe(120);
    expect(bomCost(s.db, V([c('A', 1)])).lines[0].unitCost).toBe(105);
    expect(bomCost(s.db, V([c('B', 1)]), 'W3').lines[0]).toMatchObject({ unitCost: 77, source: 'average' });
    expect(bomCost(s.db, V([c('C', 1)]), 'W3').lines[0]).toMatchObject({ unitCost: 2, source: 'standard' });
  });
  it('a component that is no longer in the catalogue does not crash the cost', () => {
    expect(bomCost(session().db, V([c('GONE', 1)]))).toMatchObject({ batch: null, missing: ['GONE'] });
  });
});
