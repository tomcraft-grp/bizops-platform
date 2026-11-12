import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import type { DB } from './types';
import { Ctx, AppError, currentUser, hasPerm, userPerms } from './core';
import { buildSeed } from './seed';
import { kvDel, kvGet, kvSet } from '../lib/idb';
import { debounce } from '../lib/util';

setAutoFreeze(false);
const KEY = 'db';
const VERSION = 4;

export type Theme = 'light' | 'dark' | 'system';
interface UIState {
  theme: Theme; branchScope: string; sidebarOpen: boolean; collapsed: boolean; searchOpen: boolean;
  toasts: { id: number; kind: 'success' | 'error' | 'info'; text: string }[];
}
interface Store {
  db: DB; ready: boolean; seedErrors: string[]; ui: UIState;
}

const savedTheme = (() => { try { return (localStorage.getItem('bizops.theme') as Theme) || 'system'; } catch { return 'system' as Theme; } })();
const savedCollapsed = (() => { try { return localStorage.getItem('bizops.collapsed') === '1'; } catch { return false; } })();

export const useStore = create<Store>(() => ({
  db: null as unknown as DB, ready: false, seedErrors: [],
  ui: { theme: savedTheme, branchScope: 'all', sidebarOpen: false, collapsed: savedCollapsed, searchOpen: false, toasts: [] },
}));

const persist = debounce((db: DB) => { void kvSet(KEY, db); }, 600);

export async function boot() {
  let db: DB | undefined;
  try { db = await kvGet<DB>(KEY); } catch { db = undefined; }
  let seedErrors: string[] = [];
  if (!db || db.version !== VERSION || !db.orders) {
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const seeded = buildSeed(new Date());
    seedErrors = seeded._seedErrors ?? [];
    delete (seeded as { _seedErrors?: unknown })._seedErrors;
    db = seeded;
    // eslint-disable-next-line no-console
    console.info(`[bizops] demo data generated in ${Math.round(performance.now() - t0)} ms · ${db.orders.length} orders · ${db.journals.length} journals · seed warnings: ${seedErrors.length}`);
    if (seedErrors.length) console.warn('[bizops] seed warnings', seedErrors.slice(0, 20));
    await kvSet(KEY, db);
  }
  useStore.setState({ db, ready: true, seedErrors });
}

export async function resetDemoData() {
  useStore.setState({ ready: false });
  await kvDel(KEY);
  await boot();
}

export function exportBackup(): string {
  return JSON.stringify(useStore.getState().db);
}
export async function importBackup(json: string) {
  const db = JSON.parse(json) as DB;
  if (!db.version || !db.orders || !db.journals) throw new Error('This is not a valid backup file');
  useStore.setState({ db });
  await kvSet(KEY, db);
}

/**
 * Run a business operation as ONE transaction: if it throws, nothing is changed
 * (the same guarantee a database transaction gives the production system).
 */
export function act<T>(fn: (d: DB, ctx: Ctx) => T, opts?: { perm?: string }): T {
  const s = useStore.getState();
  const ctx: Ctx = { now: new Date().toISOString(), userId: s.db.meta.currentUserId };
  let result!: T;
  const next = produce(s.db, (d) => {
    if (opts?.perm && !hasPerm(userPerms(d as DB, currentUser(d as DB)), opts.perm)) throw new AppError('FORBIDDEN', `Your role does not have permission: ${opts.perm}`);
    result = fn(d as DB, ctx);
  });
  useStore.setState({ db: next });
  persist(next);
  return result;
}

export const setUI = (patch: Partial<UIState>) => useStore.setState((s) => ({ ui: { ...s.ui, ...patch } }));
let toastId = 1;
export function toast(kind: 'success' | 'error' | 'info', text: string) {
  const id = toastId++;
  setUI({ toasts: [...useStore.getState().ui.toasts, { id, kind, text }] });
  setTimeout(() => setUI({ toasts: useStore.getState().ui.toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3500);
}
export function setTheme(t: Theme) {
  try { localStorage.setItem('bizops.theme', t); } catch { /* ignore */ }
  setUI({ theme: t });
  applyTheme(t);
}
export function applyTheme(t: Theme) {
  const r = document.documentElement;
  if (t === 'system') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', t);
}
export function toggleCollapsed() {
  const c = !useStore.getState().ui.collapsed;
  try { localStorage.setItem('bizops.collapsed', c ? '1' : '0'); } catch { /* ignore */ }
  setUI({ collapsed: c });
}

export const useDB = () => useStore((s) => s.db);
export const useUI = () => useStore((s) => s.ui);
