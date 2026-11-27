import { describe, expect, it, vi } from 'vitest';
import { produce } from 'immer';
import { base, codeOf, ctx, tx } from '../helpers';
import { glOf, liveBase, session } from '../production';
import { CHART, cr, dr, ensureProductionAccounts, findAcct, post, roleCode } from '../../src/domain/accounting';
import { reconDrill, reconciliationMatrix, setupChecks, validateCoa, validateOpening } from '../../src/domain/setup';
import { runIntegrityChecks } from '../../src/domain/integrity';
import type { DB, ProductionOrder } from '../../src/domain/types';

const ROLES: [string, string][] = [['wip', '1220'], ['prod_var_material', '5310'], ['prod_var_labor', '5320'], ['prod_var_overhead', '5330']];
const CODES = ROLES.map((r) => r[1]);
/** A database saved before the production module existed. */
const old = (edit?: (d: DB) => void) => produce(liveBase(), (d) => {
  d.accounts = d.accounts.filter((a) => !CODES.includes(a.code));
  for (const [r] of ROLES) delete d.postingMap[r];
  edit?.(d as DB);
}) as DB;
const oldSession = (edit?: (d: DB) => void) => { const s = session(); s.do((d) => { Object.assign(d, old(edit)); }); return s; };
const wipEntry = (d: DB) => post(d, ctx, { memo: 'x', refType: 't', lines: [dr('wip', 10), cr('cash', 10)] });

describe('production accounts and posting roles', () => {
  it('the default chart has them, is valid, and every role resolves', () => {
    expect(validateCoa(liveBase()).filter((i) => i.level === 'error')).toEqual([]);
    tx((d) => { expect(validateCoa(d).filter((i) => i.level === 'error')).toEqual([]); });
    for (const [r, c] of ROLES) expect(roleCode(liveBase(), r), r).toBe(c);
    expect(CHART.find((a) => a.code === '1220')).toMatchObject({ name: 'Work in progress', nameTh: 'งานระหว่างทำ', control: 'wip', fsLine: 'inventory', normal: 'debit', parent: '1030' });
    for (const c of ['5310', '5320', '5330']) expect(CHART.find((a) => a.code === c)).toMatchObject({ type: 'expense', fsLine: 'cogs', parent: '5000' });
  });
  it('an old saved database gets what is missing once; the second run adds nothing and nothing else changes', () => {
    const before = old();
    let added: string[] = [], again: string[] = [];
    const after = produce(before, (d) => { added = ensureProductionAccounts(d as DB); again = ensureProductionAccounts(d as DB); }) as DB;
    expect(added).toEqual(CODES); expect(again).toEqual([]);
    expect(after.accounts).toEqual(liveBase().accounts); // in the place the standard chart has them
    expect(after.accounts.filter((a) => !CODES.includes(a.code))).toEqual(before.accounts);
    expect(after.postingMap).toEqual({ ...before.postingMap, ...Object.fromEntries(ROLES.map(([r, c]) => [r, [{ code: c, from: CHART[0].effectiveFrom }]])) });
    expect(validateCoa(after).filter((i) => i.level === 'error')).toEqual([]);
    expect(after.audit.length).toBe(before.audit.length + 1); // a change of the chart is never silent
  });
  it('an old database opens and posts; production is refused until the accounts exist', () => {
    const s = oldSession();
    expect(s.code((d) => post(d, ctx, { memo: 'x', refType: 't', lines: [dr('6300', 10), cr('cash', 10)] }))).toBe(null);
    expect(s.code(wipEntry)).toBe('UNMAPPED_ACCOUNT');
    s.do((d) => ensureProductionAccounts(d));
    expect(s.code(wipEntry)).toBe(null);
  });
  it('an owner-made 1220 with another name is left alone: the role stays unmapped and posting fails', () => {
    const mine = { ...CHART.find((a) => a.code === '1220')!, name: 'Consignment stock', nameTh: 'สินค้าฝากขาย', control: undefined, system: undefined };
    const s = oldSession((x) => { x.accounts.push(mine); });
    expect(s.do((d) => ensureProductionAccounts(d))).toEqual(['5310', '5320', '5330']);
    expect(findAcct(s.db, '1220')).toEqual(mine);
    expect(s.db.postingMap.wip).toBeUndefined();
    expect(s.code(wipEntry)).toBe('UNMAPPED_ACCOUNT');
    expect(setupChecks(s.db).find((c) => c.id === 'mapping')!.status).toBe('fail');
  });
  it('an account with our name that is not a WIP control account is not used either', () => {
    const s = oldSession((x) => { x.accounts.push({ ...CHART.find((a) => a.code === '1220')!, control: undefined }); });
    s.do((d) => ensureProductionAccounts(d));
    expect(s.db.postingMap.wip).toBeUndefined();
  });
  it('a mapping the owner already chose is kept', () => {
    const s = session((d) => { d.postingMap.prod_var_labor = [{ code: '5200', from: CHART[0].effectiveFrom }]; });
    expect(s.do((d) => ensureProductionAccounts(d))).toEqual([]);
    expect(roleCode(s.db, 'prod_var_labor')).toBe('5200');
  });
  it('a chart without the usual header account still gets them, at the top level', () => {
    const s = oldSession((x) => { x.accounts = x.accounts.filter((a) => a.code !== '1030'); for (const a of x.accounts) if (a.parent === '1030') a.parent = undefined; });
    s.do((d) => ensureProductionAccounts(d));
    expect(findAcct(s.db, '1220')!.parent).toBeUndefined();
    expect(validateCoa(s.db).filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('WIP reconciliation', () => {
  const wipOrder = { id: 'PRX', no: 'PRD-X', wip: { materials: 60, labor: 30, overhead: 10 }, batches: [], status: 'in_progress' } as unknown as ProductionOrder;
  it('is not listed while there is no WIP at all', () => {
    tx((d) => { expect(reconciliationMatrix(d).some((r) => r.key === 'wip')).toBe(false); });
    expect(runIntegrityChecks(base(), ctx.now).some((c) => c.id === 'recon-wip')).toBe(false);
  });
  it('compares the WIP of the orders with the control account, with a drill-down', () => {
    const s = session();
    s.do((d) => { d.productionOrders.push(wipOrder); post(d, ctx, { memo: 'x', refType: 't', lines: [dr('wip', 100), cr('conversion_absorbed', 100)] }); });
    expect(reconciliationMatrix(s.db).find((r) => r.key === 'wip')).toMatchObject({ gl: 100, sub: 100, diff: 0, status: 'ok', accounts: '1220' });
    expect(reconDrill(s.db, 'wip')).toEqual([{ label: 'PRD-X', amount: 100 }]);
    expect(runIntegrityChecks(s.db, ctx.now).find((c) => c.id === 'recon-wip')!.status).toBe('pass');
    expect(glOf(s.db, 'inventory')).toBe(0); // WIP is its own control: the stock reconciliation does not move
    s.do((d) => { post(d, ctx, { memo: 'stray', refType: 't', lines: [dr('wip', 1), cr('cash', 1)] }); });
    expect(reconciliationMatrix(s.db).find((r) => r.key === 'wip')).toMatchObject({ diff: 1, status: 'diff' });
    expect(runIntegrityChecks(s.db, ctx.now).find((c) => c.id === 'recon-wip')!.status).toBe('fail');
  });
  it('an opening balance cannot be typed into WIP: it must come from production orders', () => {
    const issues = validateOpening(liveBase(), { id: 'x', no: 'x', asOf: ctx.now, source: 's', preparedBy: 'U1', createdAt: ctx.now, status: 'draft', lines: [{ account: '1220', debit: 5, credit: 0 }, { account: '3010', debit: 0, credit: 5 }] });
    expect(issues.some((x) => x.startsWith('1220'))).toBe(true);
  });
});

describe('opening an old saved database', () => {
  it('boot adds the accounts, keeps every record and saves; a restored backup gets them too', async () => {
    const saved: Record<string, unknown> = { db: JSON.parse(JSON.stringify(old((d) => { d.products[0].name = 'Kept'; }))) };
    vi.resetModules();
    vi.doMock('../../src/lib/idb', () => ({ kvGet: async (k: string) => saved[k], kvSet: async (k: string, v: unknown) => { saved[k] = v; }, kvDel: async () => undefined }));
    const store = await import('../../src/domain/store');
    await store.boot();
    const db = store.useStore.getState().db;
    expect(db.products[0].name).toBe('Kept'); expect(db.version).toBe(7);
    expect(roleCode(db, 'wip')).toBe('1220'); expect(roleCode(saved.db as DB, 'wip')).toBe('1220');
    expect(codeOf(() => store.act((d, c) => post(d, c, { memo: 'x', refType: 't', lines: [dr('wip', 10), cr('cash', 10)] })))).toBe(null);
    const first = saved.db; await store.boot(); // a second start finds everything in place: nothing is written again
    expect(saved.db).toBe(first);
    await store.importBackup(JSON.stringify(old()));
    expect(roleCode(store.useStore.getState().db, 'wip')).toBe('1220');
    vi.doUnmock('../../src/lib/idb');
  });
});
