import { produce, setAutoFreeze } from 'immer';
import { buildSeed } from '../src/domain/seed';
import { adjustStock } from '../src/domain/inventory';
import { runIntegrityChecks } from '../src/domain/integrity';
import type { Ctx } from '../src/domain/core';
import type { DB, ID } from '../src/domain/types';

setAutoFreeze(true); // same as the app: state is frozen outside transactions

/** A fixed "now": reproducible seed, reproducible dates (TZ is pinned in globalSetup) */
export const NOW = new Date('2026-11-13T10:30:00+07:00');
export const ctx: Ctx = { now: NOW.toISOString(), userId: 'U1' };
export const at = (iso: string, userId = 'U1'): Ctx => ({ now: new Date(iso).toISOString(), userId });

let cached: DB | undefined;
/** Seeded demo business (built once per test file; every test runs on its own immer copy) */
export const base = (): DB => (cached ||= buildSeed(NOW) as DB);

/** Run `fn` inside a throw-away transaction; returns whatever `fn` returns (primitives only) */
export function tx<T>(fn: (d: DB) => T): T {
  let out!: T;
  produce(base(), (d) => { out = fn(d as DB); });
  return out;
}
/** Like tx, but returns the resulting DB so tests can inspect state after an error was caught */
export function txState(fn: (d: DB) => void): DB {
  return produce(base(), (d) => { fn(d as DB); }) as DB;
}

/** Add stock through the proper ledger path (movement + balanced journal) */
export function stock(d: DB, pid: ID, wh: ID, qty: number) {
  adjustStock(d, ctx, { productId: pid, warehouseId: wh, qty, reason: 'test stock', kind: 'adjust' });
}
export const throws = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return (e as Error).message; } };
export const codeOf = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? 'ERR'; } };
export const failing = (d: DB) => runIntegrityChecks(d, ctx.now).filter((c) => c.status === 'fail');
export const expectIntegrity = (d: DB) => { const f = failing(d); if (f.length) throw new Error('Integrity failed: ' + f.map((x) => `${x.id}: ${x.detail}`).join(' | ')); };
