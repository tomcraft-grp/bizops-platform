// Client for the customer-to-customer points transfer (supabase/migrations/20261127120000_points_transfer.sql).
// Everything is a Supabase RPC (SECURITY DEFINER). The browser never sends a balance, a sender or a ledger row: it sends "this member ID, this many points, this key"
// and shows the answer. The database holds the points back for a pending request, decides who may answer it and moves the points in one transaction.
import { rpc, ShopError, WRITE_TIMEOUT_MS } from '../shop/api';

export type TransferErrorCode =
  | 'TRANSFERS_OFF' | 'TOO_MANY_LOOKUPS' | 'RECIPIENT_NOT_FOUND' | 'SELF_TRANSFER' | 'POINTS_OUT_OF_RANGE' | 'MESSAGE_TOO_LONG' | 'TOO_MANY_PENDING' | 'DAILY_LIMIT'
  | 'INSUFFICIENT_POINTS' | 'TRANSFER_NOT_PENDING' | 'POINTS_RESERVED' | 'INVALID_KEY' | 'KEY_REUSED' | 'NOT_FOUND' | 'FORBIDDEN' | 'NETWORK'
  | 'REASON_REQUIRED' | 'BAD_FIELD' | 'BAD_VALUE';
export const isTransferError = (e: unknown, ...codes: TransferErrorCode[]): e is ShopError => e instanceof ShopError && (codes as string[]).includes(e.code);

/** pending = waiting for the recipient (the sender's points are held); expired = nobody answered in time (the points are free again). */
export type TransferStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
/** `out` = the customer sent it, `in` = the customer is the recipient. `counterparty` is the OTHER person: a short name and a masked member ID, never a phone or an e-mail. */
export interface Transfer {
  id: string; transfer_no: string; direction: 'in' | 'out'; status: TransferStatus; points: number; message: string | null;
  created_at: string; expires_at: string; decided_at: string | null; reason: string | null;
  counterparty: { name: string; code: string };
  replay?: boolean;
  /** only on the answer to an accept: the recipient's new balance */
  balance?: number;
}
export interface TransferLimits { min: number; max: number; daily_max: number; sent_today: number; max_pending: number; expire_days: number }
export type TransferOverview =
  | { enabled: false }
  | { enabled: true; member_code: string; balance: number; reserved: number; available: number; limits: TransferLimits; incoming: Transfer[]; outgoing: Transfer[]; history: Transfer[]; unread: number };
export type LookupResult = { found: false } | { found: true; is_self: boolean; name: string; code: string };

export const transfers = {
  overview: () => rpc<TransferOverview>('rw_transfer_overview'),
  lookup: (code: string) => rpc<LookupResult>('rw_transfer_lookup', { p_code: code }),
  create: (code: string, points: number, key: string, message?: string | null) =>
    rpc<Transfer>('rw_transfer_create', { p_code: code, p_points: points, p_key: key, p_message: message?.trim() || null }, WRITE_TIMEOUT_MS),
  accept: (id: string) => rpc<Transfer>('rw_transfer_accept', { p_transfer: id }, WRITE_TIMEOUT_MS),
  reject: (id: string, reason?: string | null) => rpc<Transfer>('rw_transfer_reject', { p_transfer: id, p_reason: reason?.trim() || null }, WRITE_TIMEOUT_MS),
  cancel: (id: string) => rpc<Transfer>('rw_transfer_cancel', { p_transfer: id }, WRITE_TIMEOUT_MS),
  markRead: () => rpc<number>('rw_transfer_mark_read'),
};

// ------------------------------------------------------------------------------------------------ staff
export interface TransferSettings {
  transfers_enabled: boolean; min_points: number; max_points: number; daily_max_points: number; max_pending: number; expire_days: number; updated_at?: string | null;
  /** the rewards master switch: transfers also need it */
  rewards_enabled: boolean;
}
export type TransferSettingsPatch = Partial<Omit<TransferSettings, 'rewards_enabled' | 'updated_at'>>;
export interface AdminTransfer {
  id: string; transfer_no: string; status: TransferStatus; points: number; message: string | null; created_at: string; expires_at: string; decided_at: string | null; reason: string | null;
  sender_id: string; sender: string | null; sender_code: string | null; recipient_id: string; recipient: string | null; recipient_code: string | null;
  out_ledger_id: string | null; in_ledger_id: string | null; sender_before: number | null; recipient_before: number | null;
}
export interface AdminTransferPage { total: number; items: AdminTransfer[] }

export const transfersAdmin = {
  settings: () => rpc<TransferSettings>('rw_admin_transfer_settings'),
  saveSettings: (patch: TransferSettingsPatch) => rpc<TransferSettings>('rw_admin_save_transfer_settings', { p_patch: patch }, WRITE_TIMEOUT_MS),
  list: (status: TransferStatus | null, search: string, limit = 50, offset = 0) =>
    rpc<AdminTransferPage>('rw_admin_transfers', { p_status: status, p_search: search.trim() || null, p_limit: limit, p_offset: offset }),
  cancel: (id: string, reason: string) => rpc<{ id: string; status: TransferStatus }>('rw_admin_cancel_transfer', { p_transfer: id, p_reason: reason }, WRITE_TIMEOUT_MS),
};
