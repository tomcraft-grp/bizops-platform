// Automatic, incremental SKU sync: the central registry (Supabase public.sku_registry, read through the change feed `sku_changes_since`) is the authority for a
// product's name, price, cost, barcode, brand, marketplace prices and active status; this device keeps its own stock, recipes (BOM), reorder levels, images, prep
// station, category, unit and notes. The device never writes the registry except through sku_set_status (the Active switch) and sku_set_details (a new SKU's price).
//
// State lives in the key-value store under 'skuSync' (NOT in the main local database, so no local DB version bump): the feed cursor, when the last sync succeeded, the last
// error, rows that could not be applied (kept and retried) and SKU details that could not be uploaded yet (kept and re-sent). The first sync, and any sync on a device
// whose local database was replaced, is a full one. A failed sync changes nothing: the cursor stays where it was.
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { act, useStore } from './store';
import { importSkuMaster, saveProduct } from './master';
import { can } from './core';
import { isStandardSku } from './sku';
import type { Product } from './types';
import { kvGet, kvSet } from '../lib/idb';
import { skuFeed, type RegistryRow, type SkuDetailsPatch } from '../rewards/api';
import { ShopError } from '../shop/api';

const KEY = 'skuSync';
/** Opening the Products page syncs only when the last success is older than this. */
export const STALE_AFTER_MS = 5 * 60_000;

export type SyncState = 'idle' | 'syncing' | 'ok' | 'error';
export interface SyncFailure { sku: string; error: string }
export interface SyncResult {
  ok: boolean; full: boolean; error: string | null;
  /** rows the feed returned (not counting rows kept from an earlier sync to retry) */
  fetched: number;
  created: number; updated: number; recoded: number; inactive: number; deactivated: number; reactivated: number;
  /** rows that could not be applied (for example a barcode another product already has); they are kept and tried again next time */
  failed: SyncFailure[];
}

interface Stored {
  cursor: number | null;
  /** which local database the cursor belongs to (db.meta.seededAt): a replaced or restored database starts over with a full sync */
  dbId: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  failed: SyncFailure[];
  retry: RegistryRow[];
  pending: Record<string, SkuDetailsPatch>;
}

// ------------------------------------------------------------------------------------------------ stored state (memory is authoritative, the key-value store is its copy)
async function load(): Promise<Stored> {
  let v: Partial<Stored> | undefined;
  try { v = await kvGet<Partial<Stored>>(KEY); } catch { v = undefined; }
  return {
    cursor: typeof v?.cursor === 'number' && Number.isFinite(v.cursor) ? v.cursor : null,
    dbId: typeof v?.dbId === 'string' ? v.dbId : null,
    lastOkAt: typeof v?.lastOkAt === 'string' ? v.lastOkAt : null,
    lastError: typeof v?.lastError === 'string' ? v.lastError : null,
    failed: Array.isArray(v?.failed) ? v.failed : [],
    retry: Array.isArray(v?.retry) ? v.retry : [],
    pending: v?.pending && typeof v.pending === 'object' ? { ...v.pending } : {},
  };
}
let loading: Promise<Stored> | null = null;
const state = (): Promise<Stored> => (loading ??= load());
async function save(s: Stored): Promise<void> {
  try { await kvSet(KEY, structuredClone(s)); } catch { /* the in-memory copy still drives this session */ }
}

// ------------------------------------------------------------------------------------------------ what the screen shows
interface View { state: SyncState; lastOkAt: string | null; error: string | null; failed: SyncFailure[]; waiting: string[]; hydrated: boolean }
const useView = create<View>(() => ({ state: 'idle', lastOkAt: null, error: null, failed: [], waiting: [], hydrated: false }));
function show(s: Stored, st: SyncState) {
  useView.setState({ state: st, lastOkAt: s.lastOkAt, error: s.lastError, failed: s.failed, waiting: Object.keys(s.pending), hydrated: true });
}
/** The same numbers the hook gives, for code outside React. */
export function skuSyncSnapshot() {
  const { state: st, lastOkAt, error, failed, waiting } = useView.getState();
  return { state: st, lastOkAt, error, failed, waiting };
}
/**
 * A local backup was restored. The cursor belongs to the database that was replaced, and a backup of the SAME device carries the same database id, so the id check alone
 * would trust the old cursor and miss every registry change between the backup and that cursor. Forget it: the next sync is a full one. Uploads still queued stay (they are
 * about the registry, not about this device's data).
 */
export async function forgetSkuCursor(): Promise<void> {
  const s = await state();
  s.cursor = null; s.dbId = null; s.lastOkAt = null; s.retry = []; s.failed = []; s.lastError = null;
  await save(s);
  show(s, 'idle');
}
/** Read the stored state once (last success, last error) so a freshly opened page shows it. */
export function hydrateSkuSync(): Promise<void> {
  if (useView.getState().hydrated) return Promise.resolve();
  return state().then((s) => { if (!useView.getState().hydrated) show(s, s.lastError ? 'error' : s.lastOkAt ? 'ok' : 'idle'); });
}
export function useSkuSync(): { state: SyncState; lastOkAt: string | null; error: string | null; failed: SyncFailure[]; waiting: string[]; run: (full?: boolean) => void } {
  const v = useView();
  useEffect(() => { void hydrateSkuSync(); }, []);
  const run = useCallback((full?: boolean) => { void syncSkus({ full }); }, []);
  return { state: v.state, lastOkAt: v.lastOkAt, error: v.error, failed: v.failed, waiting: v.waiting, run };
}

/** "Synced just now" / "Synced 2 min ago" ... as an English key plus values for t(); null when there has been no success. */
export function syncAgeLabel(iso: string | null, nowMs: number = Date.now()): { text: string; vars?: { n: number } } | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const min = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (min < 1) return { text: 'Synced just now' };
  if (min < 60) return { text: 'Synced {n} min ago', vars: { n: min } };
  const h = Math.floor(min / 60);
  if (h < 24) return { text: 'Synced {n} h ago', vars: { n: h } };
  return { text: 'Synced {n} d ago', vars: { n: Math.floor(h / 24) } };
}

// ------------------------------------------------------------------------------------------------ errors
const OFFLINE = 'Cannot reach the central database. Check the connection and try again.';
const NOT_STAFF = 'Only staff (Admin or Super admin) can sync SKUs.';
const NOT_SET_UP = 'SKU sync is not set up in the central database yet. Ask an administrator to apply the update.';
const NOT_READY = 'The app is still starting. Try again in a moment.';
const CODE_PREFIX = /^[A-Z][A-Z_]{2,}(?::\s*|$)/; // the database's "CODE: detail" error format
/** A server or network failure as one sentence a person can act on (the server's own detail when it gave one). English; the screen passes it through t(). */
export function describeSkuError(e: unknown): string {
  const msg = ((e as Error | undefined)?.message ?? '').trim();
  if (!(e instanceof ShopError)) return msg || 'The SKU service returned an error.';
  if (e.code === 'NETWORK') return OFFLINE;
  if (/could not find the function|schema cache/i.test(msg)) return NOT_SET_UP;
  if (e.code === 'FORBIDDEN' && !CODE_PREFIX.test(msg)) return NOT_STAFF;
  return msg.replace(CODE_PREFIX, '').trim() || msg || 'The SKU service returned an error.';
}

// ------------------------------------------------------------------------------------------------ the sync
type Applied = { created: number; updated: number; recoded: number; inactive: number; deactivated: number; reactivated: number; failed: SyncFailure[] };
/** Write rows into the local catalogue in one transaction (all or nothing). Throws when the signed-in user may not edit the catalogue. */
function applyRows(rows: RegistryRow[]): Applied {
  return act((d, c) => {
    const was = new Map(d.products.map((p) => [p.id, p.active]));
    const r = importSkuMaster(d, c, rows, { preserveLocal: true });
    let deactivated = 0, reactivated = 0;
    for (const p of d.products) {
      const w = was.get(p.id);
      if (w === undefined || w === p.active) continue;
      if (p.active) reactivated++; else deactivated++;
    }
    return { created: r.created, updated: r.updated, recoded: r.recoded, inactive: r.inactive, deactivated, reactivated, failed: r.failed.map((f) => ({ ...f })) };
  });
}
/** Rows from the feed first, then rows kept from an earlier sync (older state, unless the feed has a newer row of the same SKU). */
const mergeRows = (feed: RegistryRow[], retry: RegistryRow[]): RegistryRow[] => {
  const seen = new Set(feed.map((r) => r.sku_code));
  return [...feed, ...retry.filter((r) => !seen.has(r.sku_code))];
};
/** Send SKU details that could not be uploaded earlier. A refusal keeps the item queued; a dropped connection stops the loop (every call would time out). */
async function flushPending(s: Stored): Promise<void> {
  for (const [code, patch] of Object.entries(s.pending)) {
    try { await skuFeed.setDetails(code, patch); if (s.pending[code] === patch) delete s.pending[code]; }
    catch (e) { if (e instanceof ShopError && e.code === 'NETWORK') break; }
  }
}

let inflight: { p: Promise<SyncResult>; full: boolean } | null = null;

/**
 * Bring the registry's changes into this device. Resolves, never rejects: `ok: false` carries the error (also stored and shown by the Products banner).
 * Calls made while one is running share it, except that a full re-sync asked for during an incremental one runs right after it.
 */
export function syncSkus(opts: { full?: boolean } = {}): Promise<SyncResult> {
  const full = !!opts.full;
  if (inflight) {
    if (!full || inflight.full) return inflight.p;
    return inflight.p.then(() => syncSkus({ full: true }));
  }
  const p = run(full).finally(() => { inflight = null; });
  inflight = { p, full };
  return p;
}

async function run(wantFull: boolean): Promise<SyncResult> {
  useView.setState({ state: 'syncing', hydrated: true });
  const out: SyncResult = { ok: false, full: wantFull, error: null, fetched: 0, created: 0, updated: 0, recoded: 0, inactive: 0, deactivated: 0, reactivated: 0, failed: [] };
  const s = await state();
  try {
    const db = useStore.getState().db;
    if (!db) throw new Error(NOT_READY);
    const dbId = db.meta?.seededAt ?? null;
    const full = wantFull || s.cursor == null || s.dbId !== dbId;
    out.full = full;
    await flushPending(s);
    const feed = await skuFeed.changesSince(full ? null : s.cursor);
    const fed = Array.isArray(feed?.rows) ? feed.rows : [];
    out.fetched = fed.length;
    const rows = mergeRows(fed, s.retry);
    const applied = rows.length ? applyRows(rows) : null;
    if (applied) Object.assign(out, applied);
    const bad = new Set((applied?.failed ?? []).map((f) => f.sku));
    s.retry = rows.filter((r) => bad.has(r.sku_code));
    s.failed = applied?.failed ?? [];
    const cursor = Number(feed?.cursor);
    if (feed?.cursor != null && Number.isFinite(cursor)) s.cursor = cursor;
    s.dbId = dbId; s.lastOkAt = new Date().toISOString(); s.lastError = null;
    await save(s);
    show(s, 'ok');
    out.ok = true;
    return out;
  } catch (e) {
    // nothing is half applied: the cursor, the retry list and the queued uploads stay as they were
    s.lastError = describeSkuError(e);
    await save(s);
    show(s, 'error');
    out.error = s.lastError;
    return out;
  }
}

/** For when a page opens: sync unless the last attempt succeeded less than `maxAgeMs` ago. Returns null when it did nothing. */
export async function syncSkusIfStale(maxAgeMs: number = STALE_AFTER_MS, nowMs: number = Date.now()): Promise<SyncResult | null> {
  await hydrateSkuSync();
  if (inflight) return inflight.p;
  const v = useView.getState();
  const fresh = !!v.lastOkAt && !v.error && nowMs - Date.parse(v.lastOkAt) < maxAgeMs;
  return fresh ? null : syncSkus();
}

/** How often a visible, long-open tab asks whether the registry changed. One tiny request that returns no rows when nothing changed. */
export const WATCH_EVERY_MS = 10 * 60_000;
/**
 * Keeps a tab that stays open all day (a POS screen) current: when it becomes visible again, and every 10 minutes while it is visible, run the staleness check, so the
 * price and status the shop shows and the ones POS uses cannot drift apart for hours. Never while the tab is hidden. Returns the cleanup.
 */
export function startSkuSyncWatch(everyMs: number = WATCH_EVERY_MS): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const tick = () => { if (document.visibilityState === 'visible') void syncSkusIfStale(); };
  const timer = setInterval(tick, everyMs);
  document.addEventListener('visibilitychange', tick);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
}

// ------------------------------------------------------------------------------------------------ writes to the registry (the only two the device makes)
export type SkuActiveResult = { ok: true; localActive: boolean | null } | { ok: false; error: string };
/**
 * The Products page's Active switch for a product that has a registry code: ask the registry to change the status (it is the owner), apply the row it answers with,
 * then re-sync. A refusal changes nothing here and returns the server's text. `localActive` is what this device ended up with: activating a SKU the registry holds
 * no price for leaves it inactive here (a SKU without a price is never sellable at 0), which the caller should tell the person.
 */
export async function setSkuActive(p: { id: string; sku: string }, active: boolean): Promise<SkuActiveResult> {
  let row: RegistryRow | null = null;
  try { row = await skuFeed.setStatus(p.sku, active ? 'active' : 'inactive', 'Changed on the Products page'); }
  catch (e) { return { ok: false, error: describeSkuError(e) }; }
  if (row && typeof row === 'object' && row.sku_code) { try { applyRows([row]); } catch { /* the re-sync below brings the change */ } }
  await syncSkus();
  const now = useStore.getState().db?.products.find((x) => x.id === p.id);
  return { ok: true, localActive: now ? now.active : null };
}

/** The registry-owned fields of a drawer edit that changed; null clears a field. Everything else on the form is device-owned and needs no server call. */
export function registryEditPatch(p: Product, f: Product): SkuDetailsPatch {
  const patch: SkuDetailsPatch = {};
  if (f.name.trim() !== p.name.trim()) patch.name_full = f.name.trim();
  if ((f.brand ?? '') !== (p.brand ?? '')) patch.brand = f.brand?.trim() || null;
  if ((f.barcode ?? '') !== (p.barcode ?? '')) patch.barcode = f.barcode || null;
  if (f.stdCost !== p.stdCost) patch.cost_price = f.stdCost;
  if (f.price !== p.price) patch.selling_price = f.price;
  if (f.unit !== p.unit) patch.unit_th = f.unit;
  return patch;
}

export type ProductEditResult = { ok: true; localActive: boolean | null } | { ok: false; error: string };
/**
 * Save the Products drawer. For a product with a registry code the registry-owned fields that changed (and the Active box) go to the registry FIRST, and only when it
 * accepts them is the form saved here, so the device never holds a value the registry refused. A refusal (offline, not staff, function missing) returns the described
 * error and changes nothing on this device; the caller keeps the drawer open with the person's edits. Device-owned fields (station, levels, description, images, category,
 * marketplace prices) are saved locally with no server call; a product without a registry code is saved locally only, as before.
 */
/**
 * A value was just sent to the registry (drawer save, flush): drop exactly those keys from the queued upload of that SKU. Otherwise the next sync would re-send an OLDER
 * value that staff have since replaced (a failed upload of price 100, then a corrected 120, then the sync sends 100 again and reverts the shop's price).
 */
async function dropQueued(code: string, sent: SkuDetailsPatch): Promise<void> {
  try {
    const s = await state();
    const queued = s.pending[code];
    if (!queued) return;
    for (const k of Object.keys(sent)) delete (queued as Record<string, unknown>)[k];
    if (Object.keys(queued).length === 0) delete s.pending[code];
    await save(s);
    useView.setState({ waiting: Object.keys(s.pending) });
  } catch { /* the queue is only a retry aid: never fail the save that already succeeded */ }
}

export async function saveProductEdit(p: Product, f: Product): Promise<ProductEditResult> {
  const db = useStore.getState().db;
  if (!can(db, 'catalog:edit')) return { ok: false, error: 'Your role does not have permission: catalog:edit' };
  const central = isStandardSku(p.sku);
  const patch = central ? registryEditPatch(p, f) : {};
  const sends = Object.keys(patch).length > 0;
  const flips = central && f.active !== p.active;
  // refuse here what the local save would refuse, before anything is sent: the registry must not accept an edit this device then rejects
  if ('name_full' in patch && !patch.name_full) return { ok: false, error: 'Name and SKU are required' };
  if (patch.barcode && db.products.some((x) => x.barcode === patch.barcode && x.id !== p.id)) return { ok: false, error: 'Barcode is already used by another product' };
  let next = f;
  if (sends) {
    let row: RegistryRow | null;
    try { row = await skuFeed.setDetails(p.sku, patch); } catch (e) { return { ok: false, error: describeSkuError(e) }; }
    await dropQueued(p.sku, patch);
    if (row && typeof row === 'object' && row.sku_code) { try { applyRows([row]); } catch { /* the next sync brings the row */ } }
    next = { ...next, name: f.name.trim() };
  }
  if (flips) {
    const r = await setSkuActive(p, f.active);
    if (!r.ok) return { ok: false, error: r.error }; // any details already accepted were applied above, so this device still matches the registry
  }
  if (sends || flips) { const l = useStore.getState().db.products.find((x) => x.id === p.id); if (l) next = { ...next, active: l.active }; }
  try { act((d, c) => saveProduct(d, c, next), { perm: 'catalog:edit' }); } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true, localActive: useStore.getState().db.products.find((x) => x.id === p.id)?.active ?? null };
}

/** The registry patch for a product typed into the New-product form: the name, and the price, cost, barcode, brand and unit when they were filled in. */
export function newSkuDetails(f: { name: string; price: number; stdCost: number; barcode: string; brand: string; unit: string }): SkuDetailsPatch {
  const patch: SkuDetailsPatch = { name_full: f.name.trim() };
  if (f.price > 0) patch.selling_price = f.price;
  if (f.stdCost > 0) patch.cost_price = f.stdCost;
  if (f.barcode) patch.barcode = f.barcode;
  if (f.brand.trim()) patch.brand = f.brand.trim();
  if (f.unit.trim()) patch.unit_th = f.unit.trim();
  return patch;
}

/**
 * Upload a new SKU's details (price, cost, barcode, brand, unit, name) right after its code was reserved, so the price exists centrally. If the upload fails the
 * details are kept in the stored state and sent again by the next sync (the product itself is already saved on this device).
 */
export async function pushSkuDetails(code: string, patch: SkuDetailsPatch): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await state();
  try { await skuFeed.setDetails(code, patch); }
  catch (e) {
    s.pending[code] = { ...s.pending[code], ...patch };
    await save(s);
    useView.setState({ waiting: Object.keys(s.pending) });
    return { ok: false, error: describeSkuError(e) };
  }
  if (s.pending[code]) { delete s.pending[code]; await save(s); }
  useView.setState({ waiting: Object.keys(s.pending) });
  return { ok: true };
}
