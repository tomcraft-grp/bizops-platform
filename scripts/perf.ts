// Engine performance measurement (QA addendum §6). Runs in Node against the seeded dataset; writes qa/results/perf-engine.json.
// Numbers are for THIS machine and THIS in-memory engine — they are not a load test of a production backend.
import { mkdirSync, writeFileSync } from 'node:fs';
import { produce, setAutoFreeze } from 'immer';
import os from 'node:os';
import { buildSeed } from '../src/domain/seed';
import { adjustStock } from '../src/domain/inventory';
import { createOrder } from '../src/domain/orders';
import { runIntegrityChecks } from '../src/domain/integrity';
import { reconciliationMatrix, vatReport, cashFlowReport } from '../src/domain/setup';
import { computeEcon } from '../src/domain/economics';
import { balancesBetween } from '../src/domain/accounting';
import type { DB } from '../src/domain/types';

setAutoFreeze(true); // same as the app (src/domain/store.ts)
const NOW = new Date('2026-11-13T10:30:00+07:00');
const ctx = { now: NOW.toISOString(), userId: 'U1' };
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: +s[0].toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
};
const time = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };

const seedMs: number[] = [];
let db!: DB;
for (let i = 0; i < 5; i++) seedMs.push(time(() => { db = buildSeed(NOW) as DB; }));

const sizeMB = JSON.stringify(db).length / 1e6;
const counts = { orders: db.orders.length, journals: db.journals.length, movements: db.movements.length, receipts: db.receipts.length, allocations: db.allocations.length, customers: db.customers.length, products: db.products.length, audit: db.audit.length };

// one POS sale = one transaction (immer produce + stock top-up through the ledger); measured on the seeded dataset
const sales = (n: number, start: DB = db) => {
  const xs: number[] = []; let cur = start;
  for (let i = 0; i < n; i++) {
    xs.push(time(() => {
      cur = produce(cur, (d) => {
        const x = d as DB;
        adjustStock(x, ctx, { productId: 'R04', warehouseId: 'W1', qty: 1, reason: 'perf', kind: 'adjust' });
        createOrder(x, ctx, { channel: 'POS', branchId: 'B1', lines: [{ productId: 'R04', qty: 1 }], payments: [{ method: 'cash', amount: 1e6 }], skipPromotions: true } as never);
      }) as DB;
    }));
  }
  return { xs, cur };
};
sales(3); // warm-up (first transaction freezes the base state once)
const { xs: saleMs, cur } = sales(100);
// comparison only: the app's previous setting. A NEW seed is built with freeze off, otherwise the already-frozen state would flatter the result.
setAutoFreeze(false);
const unfrozen = buildSeed(NOW) as DB;
const saleMsNoFreeze = sales(20, unfrozen).xs;
setAutoFreeze(true);
const integrityMs = Array.from({ length: 10 }, () => time(() => { runIntegrityChecks(cur, ctx.now); }));
const reconMs = Array.from({ length: 10 }, () => time(() => { reconciliationMatrix(cur); }));
const trialMs = Array.from({ length: 10 }, () => time(() => { balancesBetween(cur.journals); }));
const econMs = Array.from({ length: 10 }, () => time(() => { computeEcon(cur, {}); }));
const from = new Date(NOW.getTime() - 90 * 86400000).toISOString();
const vatMs = Array.from({ length: 10 }, () => time(() => { vatReport(cur, from, NOW.toISOString()); }));
const cfMs = Array.from({ length: 10 }, () => time(() => { cashFlowReport(cur, from, NOW.toISOString()); }));
const persistMs = Array.from({ length: 10 }, () => time(() => { JSON.stringify(cur); }));

const out = {
  measuredAt: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGB: +(os.totalmem() / 1e9).toFixed(1), node: process.version },
  dataset: { ...counts, serializedMB: +sizeMB.toFixed(2) },
  ms: {
    seedFullBusiness: stats(seedMs), postOnePosSale: stats(saleMs), postOnePosSale_autoFreezeOff_forComparison: stats(saleMsNoFreeze), integrityChecks: stats(integrityMs), reconciliationMatrix: stats(reconMs),
    trialBalance: stats(trialMs), profitEngine: stats(econMs), vatReport90d: stats(vatMs), cashFlow90d: stats(cfMs), serializeForPersist: stats(persistMs),
  },
  note: 'In-memory engine on a developer laptop; no network, no database, no concurrency. Not evidence of production capacity.',
};
mkdirSync('qa/results', { recursive: true });
writeFileSync('qa/results/perf-engine.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
