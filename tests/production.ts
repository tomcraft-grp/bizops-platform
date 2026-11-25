import { produce } from 'immer';
import { buildLiveDB, USERS } from '../src/domain/seedData';
import { adjustStock, stockValue } from '../src/domain/inventory';
import { runIntegrityChecks } from '../src/domain/integrity';
import { balancesBetween, isControl, sumAccounts } from '../src/domain/accounting';
import type { Ctx } from '../src/domain/core';
import type { DB, ID, Product, ProductKind } from '../src/domain/types';
import { r2 } from '../src/lib/util';
import { NOW, ctx } from './helpers';

export const W = 'W3';
/** The live situation: resale products only (no raw material kind), no BOM, no order, and the owner signed in. */
let cached: DB | undefined;
export function liveBase(): DB {
  if (cached) return cached;
  cached = produce(buildLiveDB(NOW.toISOString()), (d) => {
    d.users = USERS.map((u) => ({ ...u }));
    d.meta.currentUserId = 'U1';
    add(d as DB, 'FG', 'resale', 0); add(d as DB, 'A', 'resale', 100); add(d as DB, 'B', 'resale', 80); add(d as DB, 'C', 'resale', 2); add(d as DB, 'X', 'resale', 0);
  }) as DB;
  return cached;
}
export function add(d: DB, id: ID, kind: ProductKind, stdCost: number, o: Partial<Product> = {}): Product {
  const p: Product = { id, sku: id, name: `Product ${id}`, category: 'General', kind, unit: 'pcs', price: 0, channelPrices: {}, active: true, emoji: '', color: '', stdCost, levels: {}, mediaIds: [], ...o };
  d.products.push(p);
  return p;
}
export const put = (d: DB, pid: ID, qty: number, unitCost: number, wh: ID = W, c: Ctx = ctx) => { adjustStock(d, c, { productId: pid, warehouseId: wh, qty, reason: 'test stock', unitCost }); };

/** One database that lives through a test, changed only by whole transactions: a call that throws leaves it exactly as it was (as act() does). */
export function session(setup?: (d: DB) => void) {
  let db = setup ? (produce(liveBase(), (d) => { setup(d as DB); }) as DB) : liveBase();
  return {
    get db() { return db; },
    do<T>(fn: (d: DB) => T): T { let out!: T; db = produce(db, (d) => { out = fn(d as DB); }) as DB; return out; },
    /** The error code of a call, or null when it worked (and was kept). A call that fails keeps nothing. */
    code(fn: (d: DB) => unknown): string | null {
      try { db = produce(db, (d) => { fn(d as DB); }) as DB; return null; } catch (e) { return (e as { code?: string }).code ?? `ERR ${(e as Error).message}`; }
    },
    msg(fn: (d: DB) => unknown): string { try { produce(db, (d) => { fn(d as DB); }); return ''; } catch (e) { return (e as Error).message; } },
  };
}
export const po = (d: DB, id: ID) => d.productionOrders.find((x) => x.id === id)!;
export const glOf = (d: DB, control: 'wip' | 'inventory') => sumAccounts(d, balancesBetween(d.journals), isControl(control));
export const glCode = (d: DB, code: string) => { const b = balancesBetween(d.journals)[code]; return r2((b?.debit ?? 0) - (b?.credit ?? 0)) + 0; };
/** Every journal balanced, stock value = GL, order WIP = GL, and the integrity checks green. */
export function sound(d: DB) {
  for (const j of d.journals) { const x = r2(j.lines.reduce((s, l) => s + l.debit - l.credit, 0)); if (Math.abs(x) > 0) throw new Error(`${j.no} is out of balance by ${x}`); }
  for (const o of d.productionOrders) for (const v of Object.values(o.wip ?? {})) if (!(v >= 0) || r2(v) !== v) throw new Error(`${o.no} WIP element ${v}`);
  const w = r2(d.productionOrders.reduce((s, o) => s + (o.wip ? o.wip.materials + o.wip.labor + o.wip.overhead : 0), 0));
  if (w !== glOf(d, 'wip')) throw new Error(`WIP ${w} but GL ${glOf(d, 'wip')}`);
  if (stockValue(d) !== glOf(d, 'inventory')) throw new Error(`stock ${stockValue(d)} but GL ${glOf(d, 'inventory')}`);
  const bad = runIntegrityChecks(d, ctx.now).filter((c) => c.status === 'fail');
  if (bad.length) throw new Error(bad.map((x) => `${x.id}: ${x.detail}`).join(' | '));
}
