import { useEffect, useMemo, useState } from 'react';
import type { DB, ID } from '../domain/types';
import { computeEcon, EconFilter } from '../domain/economics';
import { currentUser } from '../domain/core';
import { useDB, useStore } from '../domain/store';
import { addDays, dayKey, startOfDay } from '../lib/util';
import { reservedMap } from '../domain/inventory';
import { slipDuplicates } from '../domain/payments';

export type Range = 'today' | '7d' | '30d' | 'mtd' | 'all';
export const RANGES: { v: Range; label: string }[] = [
  { v: 'today', label: 'Today' }, { v: '7d', label: '7 days' }, { v: '30d', label: '30 days' }, { v: 'mtd', label: 'Month to date' }, { v: 'all', label: 'All' },
];
export function rangeOf(r: Range, now = new Date()): { from?: string; to: string } {
  const to = dayKey(now);
  if (r === 'today') return { from: to, to };
  if (r === '7d') return { from: dayKey(addDays(now, -6)), to };
  if (r === '30d') return { from: dayKey(addDays(now, -29)), to };
  if (r === 'mtd') return { from: dayKey(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  return { to };
}
export function previousRange(r: Range, now = new Date()): { from: string; to: string } | null {
  if (r === 'all') return null;
  const cur = rangeOf(r, now);
  const f = new Date(cur.from + 'T00:00:00');
  const t = new Date(cur.to + 'T00:00:00');
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  if (r === 'mtd') return { from: dayKey(new Date(f.getFullYear(), f.getMonth() - 1, 1)), to: dayKey(addDays(new Date(f.getFullYear(), f.getMonth() - 1, 1), days - 1)) };
  return { from: dayKey(addDays(f, -days)), to: dayKey(addDays(f, -1)) };
}

/** Branch ids the current user may see, given the global branch selector */
export function useBranchIds(): ID[] | undefined {
  const db = useDB();
  const scope = useStore((s) => s.ui.branchScope);
  const u = currentUser(db);
  if (u.branchIds.length) return scope !== 'all' && u.branchIds.includes(scope) ? [scope] : u.branchIds;
  return scope === 'all' ? undefined : [scope];
}

export function useEcon(f: EconFilter) {
  const db = useDB();
  const key = JSON.stringify(f);
  return useMemo(() => computeEcon(db, f), [db.orders, db.products, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useTicker(ms = 30000) {
  const [t, setT] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setT(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return t;
}

export function lowStock(db: DB) {
  const reserved = reservedMap(db);
  const out: { productId: ID; warehouseId: ID; qty: number; min: number; max: number; reserved: number }[] = [];
  for (const p of db.products) {
    if (!p.active) continue;
    for (const [wh, lv] of Object.entries(p.levels)) {
      const b = db.balances[`${wh}|${p.id}`];
      const qty = b?.qty ?? 0;
      if (qty < lv.min) out.push({ productId: p.id, warehouseId: wh, qty, min: lv.min, max: lv.max, reserved: reserved[`${wh}|${p.id}`] || 0 });
    }
  }
  return out;
}

export function useAlerts() {
  const db = useDB();
  return useMemo(() => {
    const slips = db.slips.filter((s) => s.status === 'pending');
    const dupSlips = slips.filter((s) => { const x = slipDuplicates(db, s); return x.exact.length || x.business.length; });
    const failedPrints = db.printJobs.filter((j) => j.status === 'failed');
    const queuedManual = db.printJobs.filter((j) => j.status === 'queued');
    const syncErrors = db.externalOrders.filter((e) => e.status === 'error');
    const low = lowStock(db);
    const newOrders = db.orders.filter((o) => o.channel !== 'POS' && o.status === 'new').length;
    const pendingSettle = db.settlements.filter((s) => s.status === 'pending');
    return { slips, dupSlips, failedPrints, queuedManual, syncErrors, low, newOrders, pendingSettle, total: slips.length + failedPrints.length + syncErrors.length };
  }, [db.slips, db.printJobs, db.externalOrders, db.balances, db.orders, db.settlements]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const todayStart = () => startOfDay(new Date());
