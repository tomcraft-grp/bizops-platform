// Client side of the LINE OA order notifications (migration 20261122140000_line_order_notifications.sql, Edge Functions line-webhook / line-dispatch).
// The Settings card reads and changes everything through these thin wrappers over the database functions; the database decides who may do what
// (staff read, SUPER_ADMIN changes) and never returns a credential.
import { supabase } from './supabase';
import { t, type Lang } from './i18n';

export type LineEvent = 'order_new' | 'slip_new' | 'order_status' | 'payment_issue' | 'customer_notify';
export interface LineSettings {
  enabled: boolean;
  group: { name: string | null; bound_at: string } | null;
  group_left_at: string | null;
  events: Record<LineEvent, boolean>;
  quick_approve_enabled: boolean;
  quick_approve_max_amount: number;
  reject_reasons: string[];
  app_url: string;
  secret_set: boolean; secret_set_at: string | null;
  token_set: boolean; token_set_at: string | null;
  can_edit: boolean;
  my_link: { display_name: string | null; linked_at: string } | null;
  links: { profile_id: string; name: string; email: string; line_name: string | null; linked_at: string }[] | null;
  webhook_url: string;
}
export interface OutboxEntry {
  id: string; event: LineEvent; order_id: string | null; order_no: string | null; target_type: 'group' | 'user';
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'dead' | 'skipped'; attempts: number; last_error: string | null;
  created_at: string; sent_at: string | null; next_attempt_at: string;
}
export type SettingsPatch = Partial<Pick<LineSettings, 'enabled' | 'events' | 'quick_approve_enabled' | 'quick_approve_max_amount' | 'reject_reasons'>>;

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export const line = {
  async settings(): Promise<LineSettings> { return must(await supabase.rpc('line_admin_settings'), 'LINE settings'); },
  async save(patch: SettingsPatch): Promise<LineSettings> { return must(await supabase.rpc('line_admin_save_settings', { p_patch: patch }), 'Save LINE settings'); },
  async setCredentials(p: { secret?: string; token?: string }): Promise<void> {
    must(await supabase.rpc('line_admin_set_credentials', { p_channel_secret: p.secret || null, p_access_token: p.token || null }), 'Save LINE credentials');
  },
  async linkCode(kind: 'staff' | 'group'): Promise<{ code: string; expires_at: string }> { return must(await supabase.rpc('line_link_code', { p_kind: kind }), 'LINE code'); },
  async unlink(profileId?: string): Promise<void> { must(await supabase.rpc('line_unlink', { p_profile: profileId ?? null }), 'Unlink LINE'); },
  async outbox(filter: 'all' | 'failed'): Promise<OutboxEntry[]> { return must(await supabase.rpc('line_admin_outbox', { p_filter: filter, p_limit: 100 }), 'LINE delivery log') ?? []; },
  async resend(id: string): Promise<void> { must(await supabase.rpc('line_admin_resend', { p_id: id }), 'Send again'); },
  async test(): Promise<{ ok: boolean; name?: string | null; error?: string | null }> {
    const { data, error } = await supabase.functions.invoke('line-dispatch', { body: { op: 'test' } });
    if (error) {
      let detail = error.message;
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) detail = b.error; } catch { /* keep the generic message */ }
      return { ok: false, error: detail };
    }
    return data as { ok: boolean; name?: string | null; error?: string | null };
  },
};

// The English sentence is the dictionary key of its Thai text (i18n.line.ts).
const NOT_READY = 'Enter the channel secret and the access token, and bind the admin group, before switching LINE on.';
const ONLY_SUPER = 'Only a SUPER_ADMIN can change this.';
export function lineErrorText(lang: Lang, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/LINE_NOT_READY/.test(raw)) return t(lang, NOT_READY);
  if (/not allowed/i.test(raw)) return t(lang, ONLY_SUPER);
  return raw;
}

export const validMaxAmount = (s: string) => /^[0-9]+(\.[0-9]{1,2})?$/.test(s.trim()) && Number(s) > 0 && Number(s) <= 1_000_000;
export const validReasons = (list: string[]) => list.length >= 1 && list.length <= 10 && list.every((r) => r.trim() !== '' && r.length <= 80);
export const parseReasons = (text: string) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
/** True when the database does not have the LINE functions yet (the migration is not applied). */
export const isLineMissing = (message: string) => /schema cache|does not exist|Could not find the function/i.test(message);
