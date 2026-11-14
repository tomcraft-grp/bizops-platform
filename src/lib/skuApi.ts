// Client for the central SKU service (Supabase RPC, see supabase/migrations/20261114200000_sku_auto_codes.sql).
// Numbers are only ever handed out by the database inside a transaction; this file never builds a code itself.
import { supabase } from './supabase';
import type { SkuCategory } from '../domain/sku';

export interface ReservedSku { code: string; seq: number; reused: boolean }
export interface RegistryMapRow { sku_code: string; legacy_sku_code: string | null }

const OFFLINE = 'Cannot reach the central database. New SKU codes can only be created while online — check the connection and try again.';

function fail(error: { message?: string; code?: string } | null): never {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error(OFFLINE);
  const m = error?.message ?? '';
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(m)) throw new Error(OFFLINE);
  if (error?.code === '42501' || /only staff/i.test(m)) throw new Error('Only staff (Admin or Super admin) can issue SKU codes.');
  throw new Error(m || 'The SKU service returned an error.');
}

/** Preview of the next code in a category. NOT a reservation: the final number is assigned when the product is saved. */
export async function peekSku(category: SkuCategory): Promise<string> {
  const { data, error } = await supabase.rpc('sku_peek', { p_category: category });
  if (error || typeof data !== 'string') fail(error);
  return data as string;
}

/**
 * Reserve the next code for a product that is being saved. `clientRef` makes retries and double clicks idempotent:
 * the same ref always returns the same code and never consumes a second number.
 */
export async function reserveSku(category: SkuCategory, name: string, clientRef: string): Promise<ReservedSku> {
  const { data, error } = await supabase.rpc('sku_reserve', { p_category: category, p_name: name, p_client_ref: clientRef });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.code) fail(error);
  return { code: row.code as string, seq: Number(row.seq), reused: !!row.reused };
}

/** A reserved code whose product could not be saved is voided (never reused). */
export async function voidSku(code: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('sku_void', { p_code: code, p_reason: reason });
  if (error) fail(error);
}

/** Old code -> new code map for the products imported from the original workbook. */
export async function fetchLegacyMap(): Promise<RegistryMapRow[]> {
  const { data, error } = await supabase.from('sku_registry').select('sku_code, legacy_sku_code').not('legacy_sku_code', 'is', null);
  if (error) fail(error);
  return (data ?? []) as RegistryMapRow[];
}

export const newClientRef = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);
