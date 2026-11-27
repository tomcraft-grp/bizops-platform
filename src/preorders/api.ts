// Back office client of the preorder (scheduled pickup) functions of migration 20261128100000_preorders.sql. Thin wrappers: the database decides who may do what
// (staff run the day, a SUPER_ADMIN changes the settings) and what is bookable; nothing here is a rule. The order moves themselves (confirm, preparing, ready, handed over,
// cancel) are the existing `shopAdmin.setStatus`, which now knows the preorder rules.
import { rpc, type AdminOrder, type OrderStatus } from '../shop/api';

export type Flag = 'unconfirmed' | 'unpaid_soon' | 'not_started' | 'late' | 'overdue_pickup' | 'large' | 'closed_day';
export interface PreItem { line_no: number; sku_code: string; name: string; unit: string | null; qty: number; image_url: string | null; checked: boolean }
/** One preorder as the staff screens list it (the database's own compact row). */
export interface PreRow {
  id: string; order_no: string; status: OrderStatus; contact_name: string; contact_phone: string; note: string | null; status_note: string | null; created_at: string; pickup_at: string;
  total: number; lines: number; units: number; pay_code: number | null; assigned_to: string | null; assigned_name: string | null; prep: { checked: number; total: number };
  cancel_kind: 'customer' | 'rejected' | 'staff' | null; reschedule_count: number; flags: Flag[]; items?: PreItem[];
}
export interface Dashboard {
  day: string; enabled: boolean; total: number; pending: number; confirmed: number; preparing: number; ready: number; completed: number; cancelled: number; upcoming: number; pending_all: number; units_today: number;
  attention: PreRow[]; attention_count: number;
  capacity: { max_orders_per_slot: number; max_units_per_slot: number | null; max_units_per_day: number | null; day_units: number };
}
export interface ListFilters { search?: string; status?: string; pay?: string; from?: string; to?: string; timeFrom?: string; timeTo?: string; assigned?: string; sort?: string; limit?: number; offset?: number }
export interface ListPage { total: number; orders: PreRow[] }
export interface ScheduleSlot { at: string; time: string; in_grid: boolean; load: { orders: number; units: number }; orders: PreRow[] }
export interface Schedule {
  day: string; hours: { closed: boolean; open?: string; close?: string; special?: boolean; reason?: string | null }; slot_minutes: number; max_orders_per_slot: number; max_units_per_slot: number | null;
  max_units_per_day: number | null; day_units: number; slots: ScheduleSlot[]; cancelled: number;
}
export interface Board { now: string; me: string | null; orders: PreRow[] }
export interface Staffer { id: string; name: string; role: 'ADMIN' | 'SUPER_ADMIN' }
export interface StaffNotice {
  at: string; order_id: string; order_no: string; audience: 'customer' | 'staff'; kind: string; data: Record<string, unknown>; text_th: string | null; for_profile: string | null;
  line: 'queued' | 'sending' | 'sent' | 'failed' | 'dead' | 'skipped' | null; line_error: string | null;
}
export interface DayHours { dow: number; closed: boolean; open: string; close: string }
export interface SpecialDay { day: string; kind: 'closed' | 'special'; open: string | null; close: string | null; reason: string | null; orders: number }
export interface PreSettings {
  enabled: boolean; configured: boolean; slot_minutes: number; lead_minutes: number; max_advance_days: number; weekly_hours: DayHours[]; max_orders_per_slot: number; max_units_per_slot: number | null;
  max_units_per_day: number | null; change_cutoff_minutes: number; prep_lead_minutes: number; reminder_minutes: number; grace_minutes: number; large_order_units: number; customer_note: string | null;
  updated_at: string; can_edit: boolean; shop_open: boolean; pickup_enabled: boolean; days: SpecialDay[];
}
export type SettingsPatch = Partial<Omit<PreSettings, 'configured' | 'updated_at' | 'can_edit' | 'shop_open' | 'pickup_enabled' | 'days'>>;
/** The staff order view with the preorder block and the notices (with LINE delivery state). */
export type PreAdminOrder = Omit<AdminOrder, 'notices'> & { preorder?: PreRow | null; notices?: Omit<StaffNotice, 'order_id' | 'order_no' | 'for_profile' | 'line_error'>[] };

export const pre = {
  dashboard: (day?: string) => rpc<Dashboard>('preorder_admin_dashboard', { p_day: day || null }),
  list: (f: ListFilters) => rpc<ListPage>('preorder_admin_list', {
    p_search: f.search || null, p_status: f.status || null, p_pay: f.pay || null, p_from: f.from || null, p_to: f.to || null, p_time_from: f.timeFrom || null, p_time_to: f.timeTo || null,
    p_assigned: f.assigned || null, p_sort: f.sort || 'pickup_asc', p_limit: f.limit ?? 30, p_offset: f.offset ?? 0,
  }),
  schedule: (day?: string) => rpc<Schedule>('preorder_admin_schedule', { p_day: day || null }),
  board: (mine = false, days = 2) => rpc<Board>('preorder_prep_board', { p_mine: mine, p_days: days }),
  staff: () => rpc<Staffer[]>('preorder_admin_staff'),
  order: (id: string) => rpc<PreAdminOrder>('shop_admin_order', { p_id: id }),
  assign: (order: string, profile: string | null) => rpc<PreRow>('preorder_admin_assign', { p_order: order, p_profile: profile }),
  reschedule: (order: string, at: string, reason: string, force = false) => rpc<PreRow>('preorder_admin_reschedule', { p_order: order, p_pickup_at: at, p_reason: reason, p_force: force }),
  prep: (order: string, line: number | null, checked: boolean) => rpc<PreRow>('preorder_prep_set', { p_order: order, p_line: line, p_checked: checked }),
  notices: (limit = 40) => rpc<StaffNotice[]>('preorder_admin_notices', { p_limit: limit }),
  settings: () => rpc<PreSettings>('preorder_admin_settings'),
  saveSettings: (patch: SettingsPatch) => rpc<PreSettings>('preorder_admin_save_settings', { p_patch: patch }),
  saveDay: (day: string, kind: 'closed' | 'special', open: string | null, close: string | null, reason: string, force = false) =>
    rpc<{ ok: boolean; orders_affected: number }>('preorder_admin_save_day', { p_day: day, p_kind: kind, p_open: open, p_close: close, p_reason: reason || null, p_force: force }),
  removeDay: (day: string) => rpc<{ ok: boolean }>('preorder_admin_remove_day', { p_day: day }),
};

/** A database without the preorder migration: the functions do not exist (PostgREST says so) and the pages say "not installed yet" instead of an error. */
export const isPreorderMissing = (e: unknown): boolean => /could not find the function|schema cache|does not exist|PGRST202/i.test(e instanceof Error ? e.message : String(e));
