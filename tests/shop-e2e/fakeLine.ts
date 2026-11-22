// The LINE notifications part of the fake backend (Settings → LINE notifications). It mirrors the CONTRACT of the line_admin_* functions of
// supabase/migrations/20261122140000_line_order_notifications.sql (tested for real by supabase/tests/line_notifications.sql): staff read, a SUPER_ADMIN
// changes, credentials are write-only, switching on needs credentials and a bound group. It proves the SCREEN, nothing about the database.
import type { FakeShop } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';

export interface FOutbox { id: string; event: string; order_id: string | null; order_no: string | null; target_type: 'group' | 'user'; status: string; attempts: number; last_error: string | null; created_at: string; sent_at: string | null; next_attempt_at: string }

export class FakeLine {
  enabled = true;            // false = a database without the LINE migration
  canEdit = true;            // the caller is a SUPER_ADMIN
  s = {
    enabled: false, group: null as { name: string; bound_at: string } | null, group_left_at: null as string | null,
    events: { order_new: true, slip_new: true, order_status: true, payment_issue: true, customer_notify: false },
    quick_approve_enabled: false, quick_approve_max_amount: 3000, reject_reasons: ['สลิปไม่ถูกต้อง', 'ยอดเงินไม่ตรง', 'สินค้าหมด', 'ลูกค้าขอยกเลิก'],
    app_url: 'https://tomcraft-grp.github.io/bizops-platform/', secret_set_at: null as string | null, token_set_at: null as string | null,
    my_link: null as { display_name: string; linked_at: string } | null,
    links: [] as { profile_id: string; name: string; email: string; line_name: string; linked_at: string }[],
  };
  secret: string | null = null;
  token: string | null = null;
  outbox: FOutbox[] = [];
  testAnswer: { ok: boolean; name?: string; error?: string | null } = { ok: true, name: 'Tomcraft Shop', error: null };
  shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }

  private err(message: string): never { throw Object.assign(new Error(message), {}); }
  private requireSuper(what: string) { if (!this.canEdit) this.err(`You are not allowed to ${what}`); }
  view() {
    const s = this.s;
    return {
      enabled: s.enabled, group: s.group, group_left_at: s.group_left_at, events: s.events, quick_approve_enabled: s.quick_approve_enabled,
      quick_approve_max_amount: s.quick_approve_max_amount, reject_reasons: s.reject_reasons, app_url: s.app_url,
      secret_set: !!s.secret_set_at, secret_set_at: s.secret_set_at, token_set: !!s.token_set_at, token_set_at: s.token_set_at,
      can_edit: this.canEdit, my_link: s.my_link, links: this.canEdit ? s.links : null,
      webhook_url: 'https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-webhook',
    };
  }
  rpc(fn: string, a: Record<string, unknown>): unknown {
    if (!fn.startsWith('line_')) return NOT_HANDLED;
    if (!this.enabled) this.err(`Could not find the function public.${fn} in the schema cache`);
    switch (fn) {
      case 'line_admin_settings': return this.view();
      case 'line_admin_save_settings': {
        this.requireSuper('change the LINE settings');
        const p = a.p_patch as Record<string, unknown>;
        if ('events' in p) this.s.events = { ...this.s.events, ...(p.events as object) };
        if ('quick_approve_enabled' in p) this.s.quick_approve_enabled = !!p.quick_approve_enabled;
        if ('quick_approve_max_amount' in p) this.s.quick_approve_max_amount = Number(p.quick_approve_max_amount);
        if ('reject_reasons' in p) this.s.reject_reasons = p.reject_reasons as string[];
        if ('enabled' in p) {
          if (p.enabled && (!this.s.secret_set_at || !this.s.token_set_at || !this.s.group)) this.err('LINE_NOT_READY: enter the channel secret and access token and bind the admin group first');
          this.s.enabled = !!p.enabled;
        }
        return this.view();
      }
      case 'line_admin_set_credentials': {
        this.requireSuper('set the LINE credentials');
        const now = new Date().toISOString();
        if (a.p_channel_secret) { this.secret = String(a.p_channel_secret); this.s.secret_set_at = now; }
        if (a.p_access_token) { this.token = String(a.p_access_token); this.s.token_set_at = now; }
        return null;
      }
      case 'line_link_code':
        if (a.p_kind === 'group') this.requireSuper('bind the LINE admin group');
        return { code: a.p_kind === 'group' ? '654321' : '123456', expires_at: new Date(Date.now() + 600e3).toISOString() };
      case 'line_unlink':
        if (a.p_profile) { this.requireSuper('unlink another person\'s LINE'); this.s.links = this.s.links.filter((l) => l.profile_id !== a.p_profile); }
        else this.s.my_link = null;
        return null;
      case 'line_admin_outbox': return a.p_filter === 'failed' ? this.outbox.filter((o) => o.status === 'failed' || o.status === 'dead') : this.outbox;
      case 'line_admin_resend': {
        const o = this.outbox.find((x) => x.id === a.p_id);
        if (!o || !['failed', 'dead', 'skipped'].includes(o.status)) this.err('This message is not waiting to be sent again');
        Object.assign(o, { status: 'queued', attempts: 0, last_error: null });
        return null;
      }
      default: return NOT_HANDLED;
    }
  }
  /** the "op: test" call of the line-dispatch Edge Function */
  test(): unknown { return this.testAnswer; }
}
