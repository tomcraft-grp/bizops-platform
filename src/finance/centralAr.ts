// Central receivables for store credit sales (supabase/migrations/20261122130000_central_receivables.sql): the API, and the background sync that
//   1. sends each new credit sale (an order left owing for a customer) to the central ledger as an invoice, once (the server keys it by device + order id),
//   2. after staff link the local customer to a central customer (a person's choice: search by phone or name, or create),
//   3. keeps what those invoices still owe on the device (credit limit, order screens).
// Orders made before central receivables were switched on for this device are sent only by the one-time "Send open balances" action.
// A database without the migration answers "function not found": the status is `missing` and the app keeps the local receivables exactly as before.
// A user without a finance role gets `denied`: nothing is sent from that session (a manager's session on the same device sends it later).
import { useEffect } from 'react';
import { create } from 'zustand';
import { rpc, ShopError } from '../shop/api';
import { DEMO_SEED } from '../domain/demo';
import { act, useStore } from '../domain/store';
import { applyCentralStates, centralCandidates, markOrderCentral, type CentralState } from '../domain/centralAr';
import { dayKey, r2 } from '../lib/util';
import type { DB, ID } from '../domain/types';

export interface CentralCustomer { id: string; code: string; name: string; phone: string | null; tax_id: string | null; has_app: boolean; open_count: number; outstanding: number; confirmed_pending: number }
export interface CentralInvoice {
  id: string; invoice_no: string; issue_date: string; due_date: string; amount: number; description: string | null; source_ref: string | null;
  origin: 'store' | 'shop' | 'manual'; outstanding: number; confirmed_pending: number; available: number; status: string;
}
export interface ReceiveInput {
  customerId: string; method: 'cash' | 'transfer'; amount: number; receivedAt: string; ref: string | null; note: string | null;
  allocations: { invoice: string; amount: number }[]; key: string; post: boolean;
}
export interface ReceiveResult { customer_id: string; replay: boolean; parts: { evidence_id: string; invoice_id: string; invoice_no: string; amount: number; status: string }[]; posted: { receipt_no?: string; evidence_id: string }[]; owing: { outstanding: number; confirmed_pending: number; open_count: number } }

export const centralApi = {
  search: (q: string) => rpc<CentralCustomer[]>('finance_customer_search', { p_q: q, p_limit: 20 }),
  linksFor: (device: string, localIds: string[]) => rpc<Record<string, CentralCustomer>>('finance_customer_links_for', { p_device: device, p_local_ids: localIds }),
  link: (device: string, local: { id: string; code: string; name: string }, customerId: string | null, create?: { name: string; phone?: string; tax_id?: string; address?: string }) =>
    rpc<CentralCustomer>('finance_link_customer', { p_device: device, p_local_id: local.id, p_local_code: local.code, p_local_name: local.name, p_customer: customerId, p_new: customerId ? null : create ?? null }),
  issue: (p: { customerId: string; device: string; orderId: string; orderNo: string; amount: number; issue: string; due: string; description?: string }) =>
    rpc<{ invoice: { id: string; invoice_no: string; amount: number; customer_id: string }; replay: boolean }>('finance_issue_order_invoice', {
      p_customer: p.customerId, p_device: p.device, p_order_id: p.orderId, p_order_no: p.orderNo, p_amount: p.amount, p_issue: p.issue, p_due: p.due, p_description: p.description ?? null }),
  openInvoices: (customerId: string) => rpc<{ customer: CentralCustomer; invoices: CentralInvoice[] }>('finance_customer_open_invoices', { p_customer: customerId }),
  storeStates: (device: string, orderIds: string[] | null) => rpc<CentralState[]>('finance_store_invoice_states', { p_device: device, p_order_ids: orderIds }),
  receive: (p: ReceiveInput) => rpc<ReceiveResult>('finance_receive_payment', {
    p_customer: p.customerId, p_method: p.method, p_amount: p.amount, p_received_at: p.receivedAt, p_ref: p.ref, p_bank_account: null, p_note: p.note,
    p_allocations: p.allocations, p_key: p.key, p_post: p.post }, 30_000),
};

export const isMissingFunction = (e: unknown) => /could not find the function|schema cache|does not exist/i.test((e as Error)?.message ?? '');
/** The server's "CODE: detail" errors as one readable sentence (English; screens pass it through t()). */
export function describeCentralError(e: unknown): string {
  const m = ((e as Error)?.message ?? '').trim();
  if (e instanceof ShopError && e.code === 'NETWORK') return 'Cannot reach the central database. Check the connection and try again.';
  if (isMissingFunction(e)) return 'Central receivables are not installed in the database yet.';
  if (e instanceof ShopError && e.code === 'FORBIDDEN' && !/^[A-Z_]{3,}:/.test(m)) return 'Your account has no finance role for central receivables. Ask the owner to give you one (Payments → Staff roles).';
  return m.replace(/^[A-Z][A-Z_]{2,}:\s*/, '') || 'The central ledger returned an error.';
}

// ---------------------------------------------------------------------------------------------- device identity
// Two devices give one person different local ids and number their orders on their own, so the server keys everything by a device id: a random id kept by
// this browser + the moment this local database was created (a database restored or re-seeded on the same browser is another "device" for its order ids).
const DEVICE_KEY = 'tc-device-key';
export function deviceId(db: Pick<DB, 'meta'>): string {
  let k: string | null = null;
  try { k = localStorage.getItem(DEVICE_KEY); } catch { /* storage blocked */ }
  if (!k) { k = crypto.randomUUID(); try { localStorage.setItem(DEVICE_KEY, k); } catch { /* storage blocked: still unique for this session */ } }
  return `${k}:${db.meta?.seededAt ?? 'db'}`.slice(0, 80);
}

// ---------------------------------------------------------------------------------------------- per-device sync state (outbox)
export type OutState = 'queued' | 'needs_link' | 'failed';
export interface OutItem { orderId: ID; state: OutState; error?: string; tries: number; at: string }
interface Saved { since: string | null; items: Record<ID, OutItem> }
const savedKey = (device: string) => `tc-central-ar:${device}`;
function loadSaved(device: string): Saved {
  try { const v = JSON.parse(localStorage.getItem(savedKey(device)) ?? 'null'); if (v && typeof v === 'object') return { since: typeof v.since === 'string' ? v.since : null, items: v.items && typeof v.items === 'object' ? v.items : {} }; } catch { /* ignore */ }
  return { since: null, items: {} };
}
function save(device: string, s: Saved) { try { localStorage.setItem(savedKey(device), JSON.stringify(s)); } catch { /* storage blocked: the next sync rebuilds it */ } }

export type CentralStatus = 'idle' | 'checking' | 'ready' | 'missing' | 'denied' | 'offline';
interface State { status: CentralStatus; device: string | null; since: string | null; items: Record<ID, OutItem>; syncing: boolean; lastSyncAt: string | null; error: string | null }
export const useCentralAr = create<State>(() => ({ status: 'idle', device: null, since: null, items: {}, syncing: false, lastSyncAt: null, error: null }));

function setItems(device: string, items: Record<ID, OutItem>) {
  const st = useCentralAr.getState();
  useCentralAr.setState({ items });
  save(device, { since: st.since, items });
}

/** Is central receivables usable from this session? Resolves, never rejects. */
export async function probeCentral(): Promise<CentralStatus> {
  if (DEMO_SEED) { useCentralAr.setState({ status: 'missing' }); return 'missing'; }
  const db = useStore.getState().db;
  const device = deviceId(db);
  const saved = loadSaved(device);
  useCentralAr.setState({ status: 'checking', device, since: saved.since, items: saved.items });
  try {
    await centralApi.linksFor(device, []);
    let since = saved.since;
    if (!since) { since = new Date().toISOString(); save(device, { since, items: saved.items }); }
    useCentralAr.setState({ status: 'ready', since, error: null });
    return 'ready';
  } catch (e) {
    const s: CentralStatus = isMissingFunction(e) ? 'missing' : e instanceof ShopError && e.code === 'FORBIDDEN' ? 'denied' : e instanceof ShopError && e.code === 'NETWORK' ? 'offline' : 'offline';
    useCentralAr.setState({ status: s, error: s === 'missing' || s === 'denied' ? null : describeCentralError(e) });
    return s;
  }
}

const addDays = (day: string, n: number) => { const t = new Date(day + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + Math.max(0, Math.floor(n || 0))); return t.toISOString().slice(0, 10); };
const bangkokDay = (iso: string) => dayKey(iso);

let running: Promise<void> | null = null;
/**
 * Send what is due and refresh what central invoices still owe. Never rejects; serialised (a second call waits for the running one).
 * `onlyCustomer`: just this local customer's orders (the receive screen calls it before it lists the invoices).
 */
export function syncCentral(opts: { onlyCustomer?: ID } = {}): Promise<void> {
  const run = async () => {
    if (useCentralAr.getState().status !== 'ready') { const s = await probeCentral(); if (s !== 'ready') return; }
    const st = useCentralAr.getState();
    const device = st.device!;
    useCentralAr.setState({ syncing: true });
    try {
      const db = useStore.getState().db;
      const items = { ...st.items };
      // new credit sales since central receivables began on this device, plus what the one-time import queued
      const due = centralCandidates(db, { customerId: opts.onlyCustomer }).filter((x) => (st.since && x.order.createdAt >= st.since) || items[x.order.id]);
      for (const id of Object.keys(items)) if (!db.orders.some((o) => o.id === id && !o.central)) delete items[id];
      if (due.length) {
        const localIds = [...new Set(due.map((x) => x.order.customerId!))];
        const links = await centralApi.linksFor(device, localIds);
        for (const { order, owing } of due) {
          const link = links[order.customerId!];
          const prev = items[order.id];
          if (!link) { items[order.id] = { orderId: order.id, state: 'needs_link', tries: prev?.tries ?? 0, at: new Date().toISOString() }; continue; }
          const cust = db.customers.find((c) => c.id === order.customerId);
          const issue = bangkokDay(order.createdAt);
          try {
            const r = await centralApi.issue({ customerId: link.id, device, orderId: order.id, orderNo: order.no, amount: r2(owing), issue, due: addDays(issue, cust?.creditDays ?? 0) });
            act((d, c) => markOrderCentral(d, c, order.id, { invoiceId: r.invoice.id, invoiceNo: r.invoice.invoice_no, customerId: r.invoice.customer_id, amount: Number(r.invoice.amount) }));
            delete items[order.id];
          } catch (e) {
            if (e instanceof ShopError && e.code === 'NETWORK') throw e;            // stop: the rest waits for the next run
            items[order.id] = { orderId: order.id, state: 'failed', error: describeCentralError(e), tries: (prev?.tries ?? 0) + 1, at: new Date().toISOString() };
          }
        }
      }
      setItems(device, items);
      // what the central invoices of this device's orders still owe
      const centralIds = useStore.getState().db.orders.filter((o) => o.central && !(o.central.outstanding <= 0.004 && o.central.pending <= 0.004 && o.central.syncedAt)).map((o) => o.id);
      if (centralIds.length) {
        const states = await centralApi.storeStates(device, centralIds);
        act((d, c) => applyCentralStates(d, c, states));
      }
      useCentralAr.setState({ lastSyncAt: new Date().toISOString(), error: null });
    } catch (e) {
      if (isMissingFunction(e)) useCentralAr.setState({ status: 'missing' });
      else if (e instanceof ShopError && e.code === 'FORBIDDEN') useCentralAr.setState({ status: 'denied' });
      useCentralAr.setState({ error: describeCentralError(e) });
    } finally {
      useCentralAr.setState({ syncing: false });
    }
  };
  const next = (running ?? Promise.resolve()).then(run, run);
  running = next.finally(() => { if (running === next) running = null; });
  return next;
}

/** One-time import: queue every order of this device that still owes something (made before central receivables began), then send.
 *  `customerId`: only that local customer's orders (the receive screen offers it for the customer in front of the staff member). */
export async function importOpenBalances(customerId?: ID): Promise<{ queued: number }> {
  const st = useCentralAr.getState();
  if (st.status !== 'ready' || !st.device) return { queued: 0 };
  const db = useStore.getState().db;
  const items = { ...st.items };
  let n = 0;
  for (const { order } of centralCandidates(db, { customerId })) if (!items[order.id]) { items[order.id] = { orderId: order.id, state: 'queued', tries: 0, at: new Date().toISOString() }; n++; }
  setItems(st.device, items);
  await syncCentral(customerId ? { onlyCustomer: customerId } : {});
  return { queued: n };
}

/** Link a local customer to a central one (chosen or created), then send that customer's waiting orders. */
export async function linkLocalCustomer(local: { id: string; code: string; name: string }, customerId: string | null, create?: { name: string; phone?: string; tax_id?: string; address?: string }): Promise<CentralCustomer> {
  const st = useCentralAr.getState();
  if (!st.device) throw new Error('Central receivables are not ready on this device.');
  const c = await centralApi.link(st.device, local, customerId, create);
  await syncCentral({ onlyCustomer: local.id });
  return c;
}

/** Background sync for the back office: on sign-in, when the tab becomes visible, and every 2 minutes while it is visible. */
export function useCentralArSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled || DEMO_SEED) return undefined;
    void syncCentral();
    const tick = () => { if (document.visibilityState === 'visible') void syncCentral(); };
    const id = window.setInterval(tick, 120_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [enabled]);
}
