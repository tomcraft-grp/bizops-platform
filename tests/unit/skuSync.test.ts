// Automatic, incremental SKU sync (src/domain/skuSync.ts). The supabase client is a FAKE with a tiny in-memory "registry + change log", so what is proven here is the
// client behaviour: what it asks for (null cursor first, the stored cursor afterwards), what it applies to the local catalogue (registry-owned fields only), and what
// it keeps when something goes wrong. The SQL behind sku_changes_since / sku_set_status / sku_set_details is tested separately (supabase/tests/sku_registry_sync.sql).
// Each test loads a fresh copy of the modules (vi.resetModules) so the in-memory single-flight lock, view state and key-value store start empty.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { base, stock } from '../helpers';
import type { RegistryRow } from '../../src/rewards/api';

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: m.rpc } }));

type Err = { message: string; code?: string };
const srv = {
  log: [] as { id: number; row: RegistryRow }[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  failWith: null as Err | null,
  gate: null as Promise<void> | null,
  handlers: {} as Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: Err }>,
  reset() { this.log = []; this.rpcCalls = []; this.failWith = null; this.gate = null; this.handlers = {}; },
  put(row: RegistryRow) { this.log.push({ id: this.log.length + 1, row }); },
  calls(name: string) { return this.rpcCalls.filter((c) => c.name === name).map((c) => c.args); },
  /** what sku_changes_since returns: the latest row of every SKU changed after the cursor, and the new cursor */
  feed(cursor: number | null) {
    const latest = new Map<string, RegistryRow>();
    for (const e of this.log) if (e.id > (cursor ?? 0)) latest.set(e.row.sku_code, e.row);
    return { cursor: this.log.length, full: cursor == null, rows: [...latest.values()] };
  },
};
m.rpc.mockImplementation((name: string, args: Record<string, unknown>) => ({
  abortSignal: async () => {
    srv.rpcCalls.push({ name, args });
    if (name === 'sku_changes_since') {
      if (srv.gate) await srv.gate;
      if (srv.failWith) return { data: null, error: srv.failWith };
      return { data: srv.feed(args.p_cursor as number | null), error: null };
    }
    const h = srv.handlers[name];
    return h ? { data: null, error: null as Err | null, ...h(args) } : { data: null, error: { message: `unexpected rpc ${name}` } };
  },
}));

const reg = (o: Partial<RegistryRow> = {}): RegistryRow => ({
  sku_code: 'FG-000001', legacy_sku_code: null, sku_category: 'FG', origin: 'import', name_full: '1 BRAND Grape 6000', brand: 'BRAND', product_type: 'Puff', domain: 'POD / vape (Ref POD)',
  pack_qty: 6000, unit_en: 'Puff', unit_th: 'คำ', barcode: null, status: 'active', cost_price: 237, retail_price: 350, selling_price: 320, friend_price: 300, wholesale_price: 290,
  ecommerce_price: null, needs_review: false, review_notes: null, updated_at: '2026-11-21T00:00:00Z', ...o,
});

async function boot() {
  vi.resetModules();
  const store = await import('../../src/domain/store');
  const sync = await import('../../src/domain/skuSync');
  const kv = await import('../../src/lib/idb');
  store.useStore.setState({ db: base() });
  const product = (sku: string) => store.useStore.getState().db.products.find((p) => p.sku === sku);
  const stored = () => kv.kvGet<Record<string, unknown>>('skuSync');
  return { ...store, ...sync, kv, product, stored };
}
type Env = Awaited<ReturnType<typeof boot>>;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SKU sync: what is asked for', () => {
  let S: Env;
  beforeEach(async () => { srv.reset(); m.rpc.mockClear(); S = await boot(); });

  it('the first sync is a full one: it sends no cursor, creates the products and stores the cursor', async () => {
    srv.put(reg({ sku_code: 'FG-000001' }));
    srv.put(reg({ sku_code: 'FG-000002', name_full: '2 BRAND Mango', barcode: '8850000000002' }));
    const r = await S.syncSkus();
    expect(srv.calls('sku_changes_since')).toEqual([{ p_cursor: null }]);
    expect(r).toMatchObject({ ok: true, full: true, fetched: 2, created: 2, failed: [], error: null });
    expect(S.product('FG-000001')).toMatchObject({ price: 320, stdCost: 237, active: true });
    expect(await S.stored()).toMatchObject({ cursor: 2, lastError: null });
    expect(S.skuSyncSnapshot()).toMatchObject({ state: 'ok', error: null });
    expect(S.skuSyncSnapshot().lastOkAt).toBeTruthy();
  });

  it('a later sync with nothing new sends the stored cursor and writes nothing to the local catalogue', async () => {
    srv.put(reg());
    await S.syncSkus();
    const before = S.useStore.getState().db;
    const r = await S.syncSkus();
    expect(srv.calls('sku_changes_since')).toEqual([{ p_cursor: null }, { p_cursor: 1 }]);
    expect(r).toMatchObject({ ok: true, full: false, fetched: 0, created: 0, updated: 0 });
    expect(S.useStore.getState().db).toBe(before); // the same object: no transaction ran, nothing was persisted
  });

  it('"Re-sync everything" (full: true) sends no cursor even when one is stored', async () => {
    srv.put(reg());
    await S.syncSkus();
    const r = await S.syncSkus({ full: true });
    expect(srv.calls('sku_changes_since')[1]).toEqual({ p_cursor: null });
    expect(r).toMatchObject({ ok: true, full: true, fetched: 1, updated: 1, created: 0 });
  });

  it('a different local database (reset or restored from a backup) never trusts the old cursor: it starts with a full sync', async () => {
    srv.put(reg());
    await S.syncSkus();
    S.act((d) => { d.meta.seededAt = '2026-01-01T00:00:00.000Z'; }); // what boot() does when it replaces the database
    await S.syncSkus();
    expect(srv.calls('sku_changes_since')[1]).toEqual({ p_cursor: null });
  });
});

describe('SKU sync: what is applied to the local catalogue', () => {
  let S: Env;
  beforeEach(async () => { srv.reset(); m.rpc.mockClear(); S = await boot(); });

  it('a changed price, name and barcode update the product, but stock, recipes, levels, images, station, category and notes stay as they are', async () => {
    srv.put(reg({ barcode: '111' }));
    await S.syncSkus();
    const pid = S.product('FG-000001')!.id;
    S.act((d) => {
      const p = d.products.find((x) => x.id === pid)!;
      Object.assign(p, { levels: { W1: { min: 3, max: 9 } }, station: 'kitchen', mediaIds: ['M-1'], category: 'My shelf', unit: 'box', description: 'my note', emoji: '🍇' });
      stock(d, pid, d.warehouses[0].id, 5);
    });
    const keep = () => { const d = S.useStore.getState().db; const { levels, station, mediaIds, category, unit, description, emoji } = d.products.find((x) => x.id === pid)!; return JSON.stringify({ levels, station, mediaIds, category, unit, description, emoji, balances: d.balances, boms: d.boms, movements: d.movements }); };
    const before = keep();

    srv.put(reg({ name_full: '1 BRAND Grape NEW', selling_price: 330, cost_price: 250, barcode: '999', brand: 'BRAND2', ecommerce_price: 400 }));
    const r = await S.syncSkus();
    expect(r).toMatchObject({ ok: true, updated: 1, created: 0 });
    expect(S.product('FG-000001')).toMatchObject({ id: pid, name: 'BRAND Grape NEW', price: 330, stdCost: 250, barcode: '999', brand: 'BRAND2', channelPrices: { SHOPEE: 400, LAZADA: 400, TIKTOK: 400 } });
    expect(keep()).toBe(before);
  });

  it('a status change to inactive deactivates the local product and a later change back to active re-activates it', async () => {
    srv.put(reg());
    await S.syncSkus();
    expect(S.product('FG-000001')!.active).toBe(true);
    srv.put(reg({ status: 'inactive' }));
    expect(await S.syncSkus()).toMatchObject({ ok: true, deactivated: 1, reactivated: 0 });
    expect(S.product('FG-000001')!.active).toBe(false);
    srv.put(reg({ status: 'active' }));
    expect(await S.syncSkus()).toMatchObject({ ok: true, deactivated: 0, reactivated: 1 });
    expect(S.product('FG-000001')!.active).toBe(true);
  });

  it('a SKU that exists locally under its legacy code is re-coded, not duplicated', async () => {
    const pid = S.useStore.getState().db.products.find((x) => x.kind === 'resale')!.id;
    S.act((d) => { const p = d.products.find((x) => x.id === pid)!; p.sku = 'FG-202310-001'; p.legacySku = undefined; });
    const n = S.useStore.getState().db.products.length;
    srv.put(reg({ sku_code: 'FG-000001', legacy_sku_code: 'FG-202310-001' }));
    const r = await S.syncSkus();
    expect(r).toMatchObject({ ok: true, created: 0, updated: 1, recoded: 1, failed: [] });
    expect(S.useStore.getState().db.products.length).toBe(n);
    expect(S.useStore.getState().db.products.find((x) => x.id === pid)).toMatchObject({ sku: 'FG-000001', legacySku: 'FG-202310-001' });
  });

  it('a SKU created in the app (origin app) creates a product on this device, keeping its name as typed', async () => {
    srv.put(reg({ sku_code: 'FG-900001', origin: 'app', name_full: '100 ml Mango tea', domain: '', product_type: null, brand: null, unit_en: null, unit_th: 'ขวด', selling_price: 45, cost_price: 20, retail_price: null, pack_qty: null }));
    const r = await S.syncSkus();
    expect(r).toMatchObject({ ok: true, created: 1, failed: [] });
    expect(S.product('FG-900001')).toMatchObject({ name: '100 ml Mango tea', price: 45, stdCost: 20, unit: 'ขวด', category: 'General', kind: 'resale', active: true });
  });

  it('a registry row with no price never wipes the price, cost or barcode this device already has (they stay), but its inactive status still applies', async () => {
    S.act((d, c) => { d.products.push({ id: 'PX-L', sku: 'FG-900002', name: 'Local only', category: 'General', kind: 'resale', unit: 'pcs', price: 80, channelPrices: {}, barcode: 'B-80', active: true, emoji: '📦', color: '#000', stdCost: 30, levels: {}, mediaIds: [], createdAt: c.now }); });
    srv.put(reg({ sku_code: 'FG-900002', origin: 'app', name_full: 'Local only (registry name)', selling_price: null, retail_price: null, cost_price: null, barcode: null }));
    await S.syncSkus();
    expect(S.product('FG-900002')).toMatchObject({ name: 'Local only (registry name)', price: 80, stdCost: 30, barcode: 'B-80', active: true });
    srv.put(reg({ sku_code: 'FG-900002', origin: 'app', name_full: 'Local only (registry name)', status: 'inactive', selling_price: null, retail_price: null, cost_price: null, barcode: null }));
    await S.syncSkus();
    expect(S.product('FG-900002')).toMatchObject({ price: 80, active: false });
  });

  it('a row that cannot be applied is reported, the cursor still moves, and the row is tried again on the next sync', async () => {
    srv.put(reg({ sku_code: 'FG-000001', barcode: '111' }));
    srv.put(reg({ sku_code: 'FG-000002', name_full: '2 Second', barcode: '111' })); // the same barcode: the catalogue refuses it
    const r = await S.syncSkus();
    expect(r).toMatchObject({ ok: true, created: 1 });
    expect(r.failed).toEqual([{ sku: 'FG-000002', error: expect.stringMatching(/barcode/i) }]);
    expect(S.product('FG-000002')).toBeUndefined();
    expect(S.skuSyncSnapshot().failed).toHaveLength(1);
    expect(await S.stored()).toMatchObject({ cursor: 2 });

    srv.put(reg({ sku_code: 'FG-000001', barcode: '222' })); // fixed centrally
    const r2 = await S.syncSkus();
    expect(r2).toMatchObject({ ok: true, failed: [] });
    expect(S.product('FG-000002')).toMatchObject({ barcode: '111' });
    expect(S.skuSyncSnapshot().failed).toEqual([]);
  });
});

describe('SKU sync: failures and concurrency', () => {
  let S: Env;
  beforeEach(async () => { srv.reset(); m.rpc.mockClear(); S = await boot(); });

  it('a failed sync keeps the old cursor, applies nothing, reports a readable error, and the next success clears it', async () => {
    srv.put(reg());
    await S.syncSkus();
    srv.put(reg({ selling_price: 999 }));
    srv.failWith = { message: 'Failed to fetch' };
    const r = await S.syncSkus();
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cannot reach the central database/i) });
    expect(S.product('FG-000001')!.price).toBe(320);
    expect(await S.stored()).toMatchObject({ cursor: 1, lastError: expect.stringMatching(/cannot reach/i) });
    expect(S.skuSyncSnapshot()).toMatchObject({ state: 'error', error: expect.stringMatching(/cannot reach/i) });

    srv.failWith = null;
    const r2 = await S.syncSkus();
    expect(srv.calls('sku_changes_since').at(-1)).toEqual({ p_cursor: 1 }); // the cursor survived the failure
    expect(r2).toMatchObject({ ok: true, updated: 1 });
    expect(S.product('FG-000001')!.price).toBe(999);
    expect(S.skuSyncSnapshot()).toMatchObject({ state: 'ok', error: null });
  });

  it.each([
    [{ message: 'permission denied for function sku_changes_since', code: '42501' }, /only staff/i],
    [{ message: 'Could not find the function public.sku_changes_since(p_cursor) in the schema cache', code: 'PGRST202' }, /not set up in the central database yet/i],
    [{ message: 'INACTIVE_SKU: FG-000001' }, /^FG-000001$/],
  ])('turns the server error %j into a message a person can act on', async (err, expected) => {
    srv.failWith = err;
    const r = await S.syncSkus();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(expected);
  });

  it('two calls at the same time run once and share the result; the view says "syncing" meanwhile', async () => {
    srv.put(reg());
    let release!: () => void;
    srv.gate = new Promise<void>((res) => { release = res; });
    const a = S.syncSkus();
    const b = S.syncSkus();
    await flush();
    expect(S.skuSyncSnapshot().state).toBe('syncing');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(srv.calls('sku_changes_since')).toHaveLength(1);
    expect(ra).toBe(rb);
    expect(ra).toMatchObject({ ok: true, created: 1 });
  });

  it('"Re-sync everything" asked while an incremental sync is running is not swallowed: it runs right after', async () => {
    srv.put(reg());
    await S.syncSkus();
    let release!: () => void;
    srv.gate = new Promise<void>((res) => { release = res; });
    const a = S.syncSkus();
    const b = S.syncSkus({ full: true });
    await flush();
    release();
    await Promise.all([a, b]);
    expect(srv.calls('sku_changes_since')).toEqual([{ p_cursor: null }, { p_cursor: 1 }, { p_cursor: null }]);
  });
});

describe('SKU sync: when it runs on its own', () => {
  let S: Env;
  beforeEach(async () => { srv.reset(); m.rpc.mockClear(); S = await boot(); });

  it('does nothing when the last success is under 5 minutes old; syncs when it is older, never ran, or the last try failed', async () => {
    srv.put(reg());
    expect(await S.syncSkusIfStale()).toMatchObject({ ok: true, full: true }); // never synced
    m.rpc.mockClear();
    expect(await S.syncSkusIfStale()).toBeNull();                              // just synced
    expect(m.rpc).not.toHaveBeenCalled();
    expect(await S.syncSkusIfStale(5 * 60_000, Date.now() + 6 * 60_000)).toMatchObject({ ok: true }); // stale
    srv.failWith = { message: 'Failed to fetch' };
    await S.syncSkus();
    srv.failWith = null;
    expect(await S.syncSkusIfStale()).toMatchObject({ ok: true });             // the last try failed: try again at once
  });

  it('remembers the last success across a reload (it is stored with the device data), so a fresh page does not sync again within 5 minutes', async () => {
    vi.resetModules(); // a "reload": fresh modules, then only what the key-value store holds
    const kv = await import('../../src/lib/idb');
    await kv.kvSet('skuSync', { cursor: 7, lastOkAt: new Date().toISOString(), lastError: null });
    const again = await import('../../src/domain/skuSync');
    expect(await again.syncSkusIfStale()).toBeNull();
    expect(again.skuSyncSnapshot().lastOkAt).toBeTruthy();
  });

  it('syncAgeLabel words the age: just now, minutes, hours, days', async () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    const ago = (ms: number) => S.syncAgeLabel(new Date(now - ms).toISOString(), now);
    expect(ago(20_000)).toEqual({ text: 'Synced just now' });
    expect(ago(2 * 60_000)).toEqual({ text: 'Synced {n} min ago', vars: { n: 2 } });
    expect(ago(3 * 3_600_000)).toEqual({ text: 'Synced {n} h ago', vars: { n: 3 } });
    expect(ago(2 * 86_400_000)).toEqual({ text: 'Synced {n} d ago', vars: { n: 2 } });
    expect(S.syncAgeLabel(null, now)).toBeNull();
  });
});

describe('Products page actions: the Active switch and the New-product details', () => {
  let S: Env;
  beforeEach(async () => { srv.reset(); m.rpc.mockClear(); S = await boot(); });

  it('the switch asks the registry to change the status, then re-syncs, and the local product follows', async () => {
    srv.put(reg());
    await S.syncSkus();
    srv.handlers.sku_set_status = (a) => { const row = reg({ status: a.p_status as 'active' | 'inactive' }); srv.put(row); return { data: row }; };
    const pid = S.product('FG-000001')!.id;
    const r = await S.setSkuActive({ id: pid, sku: 'FG-000001' }, false);
    expect(r).toEqual({ ok: true, localActive: false });
    expect(srv.calls('sku_set_status')).toEqual([{ p_code: 'FG-000001', p_status: 'inactive', p_reason: expect.any(String) }]);
    expect(srv.calls('sku_changes_since').length).toBeGreaterThanOrEqual(2); // the re-sync after the change
    expect(S.product('FG-000001')!.active).toBe(false);
    expect(await S.setSkuActive({ id: pid, sku: 'FG-000001' }, true)).toEqual({ ok: true, localActive: true });
    expect(S.product('FG-000001')!.active).toBe(true);
  });

  it('when the server refuses, nothing changes locally, no re-sync runs, and the server text is returned to show', async () => {
    srv.put(reg());
    await S.syncSkus();
    srv.rpcCalls = [];
    srv.handlers.sku_set_status = () => ({ error: { message: 'FORBIDDEN: only staff can change a SKU status', code: '42501' } });
    const r = await S.setSkuActive({ id: S.product('FG-000001')!.id, sku: 'FG-000001' }, false);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/only staff/i) });
    expect(S.product('FG-000001')!.active).toBe(true);
    expect(srv.calls('sku_changes_since')).toHaveLength(0);
  });

  it('activating a SKU the registry holds no price for reports that it stays inactive on this device', async () => {
    srv.put(reg({ sku_code: 'FG-900003', origin: 'app', status: 'inactive', selling_price: null, retail_price: null, cost_price: null }));
    await S.syncSkus();
    srv.handlers.sku_set_status = (a) => { const row = reg({ sku_code: 'FG-900003', origin: 'app', status: a.p_status as 'active', selling_price: null, retail_price: null, cost_price: null }); srv.put(row); return { data: row }; };
    const r = await S.setSkuActive({ id: S.product('FG-900003')!.id, sku: 'FG-900003' }, true);
    expect(r).toEqual({ ok: true, localActive: false });
  });

  it('pushSkuDetails sends the price and details for a new SKU; if that fails it is kept and sent again by the next sync', async () => {
    srv.handlers.sku_set_details = () => ({ error: { message: 'Failed to fetch' } });
    const patch = { name_full: 'Mango tea', selling_price: 45, cost_price: 20 };
    const r = await S.pushSkuDetails('FG-900004', patch);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cannot reach/i) });
    expect(srv.calls('sku_set_details')).toEqual([{ p_code: 'FG-900004', p_patch: patch }]);
    expect(S.skuSyncSnapshot().waiting).toEqual(['FG-900004']);
    expect(await S.stored()).toMatchObject({ pending: { 'FG-900004': patch } });

    srv.handlers.sku_set_details = () => ({ data: reg({ sku_code: 'FG-900004' }) });
    await S.syncSkus();
    expect(srv.calls('sku_set_details')).toHaveLength(2);
    expect(srv.calls('sku_set_details')[1]).toEqual({ p_code: 'FG-900004', p_patch: patch });
    expect(S.skuSyncSnapshot().waiting).toEqual([]);
    expect(await S.stored()).toMatchObject({ pending: {} });
  });

  describe('saving the Products drawer (saveProductEdit)', () => {
    const setup = async (over: Partial<RegistryRow> = {}) => {
      srv.put(reg({ barcode: '111', ...over }));
      await S.syncSkus();
      srv.rpcCalls = [];
      return S.product('FG-000001')!;
    };
    /** a fake sku_set_details: the registry applies the patch and answers with the new row */
    const registryApplies = () => {
      let cur = reg({ barcode: '111' });
      srv.handlers.sku_set_details = (a) => { cur = { ...cur, ...(a.p_patch as Partial<RegistryRow>) }; srv.put(cur); return { data: cur }; };
      srv.handlers.sku_set_status = (a) => { cur = { ...cur, status: a.p_status as 'active' | 'inactive' }; srv.put(cur); return { data: cur }; };
    };

    it('restoring a local backup forgets the cursor, so the next sync is a full one (review round 1)', async () => {
      await setup();                                                                  // a sync ran: the cursor is set
      expect((await S.stored()).cursor).toBeGreaterThan(0);
      srv.put(reg({ sku_code: 'FG-000002', name_full: '2 Mango', barcode: '222' }));  // changed in the registry after the backup was taken
      await S.importBackup(JSON.stringify(S.useStore.getState().db));                 // the backup of the same device carries the same database id
      expect((await S.stored()).cursor).toBeNull();
      srv.rpcCalls = [];
      await S.syncSkus();
      expect(srv.calls('sku_changes_since')).toEqual([{ p_cursor: null }]);           // a FULL snapshot: nothing between the backup and the old cursor is missed
      expect(S.product('FG-000002')).toBeTruthy();
    });

    it('a queued upload never overwrites a newer value staff set later (review round 1)', async () => {
      const p = await setup();
      // the upload of a price of 100 failed at creation and is waiting in the queue
      srv.handlers.sku_set_details = () => ({ error: { message: 'Failed to fetch' } });
      await S.pushSkuDetails('FG-000001', { name_full: 'Queued name', selling_price: 100 });
      expect(await S.stored()).toMatchObject({ pending: { 'FG-000001': { selling_price: 100, name_full: 'Queued name' } } });
      // staff then correct the price in the drawer and the registry accepts it
      registryApplies();
      const r = await S.saveProductEdit(p, { ...p, price: 120 });
      expect(r).toMatchObject({ ok: true });
      // the price they sent is no longer queued (only the name, which they did not touch, still is)
      const left = (await S.stored()).pending['FG-000001'] ?? {};
      expect('selling_price' in left).toBe(false);
      // the next sync must NOT send the stale 100 again
      srv.rpcCalls = [];
      await S.syncSkus();
      const sentPrices = srv.calls('sku_set_details').map((c) => (c.p_patch as { selling_price?: number }).selling_price).filter((x) => x !== undefined);
      expect(sentPrices).not.toContain(100);
    });

    it('sends only the registry-owned fields that changed, then saves the whole form on this device', async () => {
      const p = await setup(); registryApplies();
      const f = { ...p, name: 'Grape 6000 NEW', price: 350, stdCost: 240, station: 'kitchen' as const, description: 'my note', levels: { W1: { min: 1, max: 4 } } };
      const r = await S.saveProductEdit(p, f);
      expect(r).toMatchObject({ ok: true });
      expect(srv.calls('sku_set_details')).toEqual([{ p_code: 'FG-000001', p_patch: { name_full: 'Grape 6000 NEW', selling_price: 350, cost_price: 240 } }]);
      expect(S.product('FG-000001')).toMatchObject({ name: 'Grape 6000 NEW', price: 350, stdCost: 240, station: 'kitchen', description: 'my note', levels: { W1: { min: 1, max: 4 } }, barcode: '111' });
    });

    it.each([
      [{ message: 'Failed to fetch' }, /cannot reach the central database/i],
      [{ message: 'permission denied for function sku_set_details', code: '42501' }, /only staff/i],
      [{ message: 'Could not find the function public.sku_set_details(p_code, p_patch) in the schema cache', code: 'PGRST202' }, /not set up in the central database yet/i],
      [{ message: 'BAD_RULE: barcode is already used by FG-000009' }, /^barcode is already used by FG-000009$/],
    ])('when the registry refuses (%j) nothing is saved on this device, the error is returned, and nothing is queued', async (err, expected) => {
      const p = await setup();
      srv.handlers.sku_set_details = () => ({ error: err });
      const before = S.useStore.getState().db;
      const r = await S.saveProductEdit(p, { ...p, name: 'Edited', price: 999, station: 'kitchen' });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(expected) });
      expect(S.useStore.getState().db).toBe(before); // no local transaction ran: not even the device-owned station
      expect(S.skuSyncSnapshot().waiting).toEqual([]);
    });

    it('an edit that only touches device-owned fields makes no server call and is saved here', async () => {
      const p = await setup();
      const r = await S.saveProductEdit(p, { ...p, station: 'beverage', description: 'shelf 3', category: 'My shelf', levels: { W1: { min: 2, max: 8 } }, mediaIds: ['M-1'] });
      expect(r).toMatchObject({ ok: true });
      expect(srv.rpcCalls).toEqual([]);
      expect(S.product('FG-000001')).toMatchObject({ station: 'beverage', description: 'shelf 3', category: 'My shelf', mediaIds: ['M-1'] });
    });

    it('a product without a registry code keeps the local-only save', async () => {
      const old = S.useStore.getState().db.products.find((x) => !/^(FG|RM|WIP)-\d{6,}$/.test(x.sku))!;
      const r = await S.saveProductEdit(old, { ...old, name: 'Renamed locally', price: old.price + 1 });
      expect(r).toMatchObject({ ok: true });
      expect(srv.rpcCalls).toEqual([]);
      expect(S.useStore.getState().db.products.find((x) => x.id === old.id)).toMatchObject({ name: 'Renamed locally', price: old.price + 1 });
    });

    it('a barcode this device already uses on another product is refused before anything is sent', async () => {
      const p = await setup();
      const other = S.useStore.getState().db.products.find((x) => x.id !== p.id)!;
      S.act((d) => { d.products.find((x) => x.id === other.id)!.barcode = '777'; });
      const r = await S.saveProductEdit(p, { ...p, barcode: '777' });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/barcode is already used/i) });
      expect(srv.rpcCalls).toEqual([]);
    });

    it('clearing the barcode and the brand sends null to the registry and clears them here', async () => {
      const p = await setup(); registryApplies();
      const r = await S.saveProductEdit(p, { ...p, barcode: undefined, brand: undefined });
      expect(r).toMatchObject({ ok: true });
      expect(srv.calls('sku_set_details')).toEqual([{ p_code: 'FG-000001', p_patch: { barcode: null, brand: null } }]);
      expect(S.product('FG-000001')!.barcode).toBeUndefined();
      expect(S.product('FG-000001')!.brand).toBeUndefined();
    });

    it('a change of the Active box goes to the registry too, after the details', async () => {
      const p = await setup(); registryApplies();
      const r = await S.saveProductEdit(p, { ...p, name: 'Renamed', active: false });
      expect(r).toMatchObject({ ok: true, localActive: false });
      expect(srv.rpcCalls.map((c) => c.name).filter((n) => n === 'sku_set_details' || n === 'sku_set_status')).toEqual(['sku_set_details', 'sku_set_status']);
      expect(S.product('FG-000001')).toMatchObject({ name: 'Renamed', active: false });
    });

    it('if the details were accepted but the status is refused, this device still matches the registry (details applied) and the error is returned', async () => {
      const p = await setup(); registryApplies();
      srv.handlers.sku_set_status = () => ({ error: { message: 'FORBIDDEN: only staff can change a SKU status', code: '42501' } });
      const r = await S.saveProductEdit(p, { ...p, name: 'Renamed', active: false });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/only staff/i) });
      expect(S.product('FG-000001')).toMatchObject({ name: 'Renamed', active: true });
    });
  });

  it('newSkuDetails builds the registry patch from the New-product form: only what was filled in, name and price included', () => {
    expect(S.newSkuDetails({ name: ' Mango tea ', price: 45, stdCost: 20, barcode: '8850000000099', brand: ' Acme ', unit: 'ขวด' }))
      .toEqual({ name_full: 'Mango tea', selling_price: 45, cost_price: 20, barcode: '8850000000099', brand: 'Acme', unit_th: 'ขวด' });
    expect(S.newSkuDetails({ name: 'Plain', price: 0, stdCost: 0, barcode: '', brand: '  ', unit: '' })).toEqual({ name_full: 'Plain' });
  });

  it('pushSkuDetails that succeeds leaves nothing waiting', async () => {
    srv.handlers.sku_set_details = () => ({ data: reg({ sku_code: 'FG-900005' }) });
    expect(await S.pushSkuDetails('FG-900005', { selling_price: 10 })).toEqual({ ok: true });
    expect(S.skuSyncSnapshot().waiting).toEqual([]);
  });
});
