// Supabase Edge Function: sends the queued LINE messages (public.line_outbox) and answers the Settings page's "Test connection".
//   Called by pg_net from line_kick() right after a message is queued, and every minute by the pg_cron job "line-dispatch" (retries), with the shared
//   secret x-line-dispatch-secret (Vault: line_dispatch_secret). It claims due rows with line_claim_outbox (each with its card read from the CURRENT order),
//   pushes them with the outbox id as X-Line-Retry-Key (a retried push is never delivered twice), and records the outcome with line_complete_outbox.
//   A LINE outage or a wrong token never touches an order: rows retry (1, 2, 5, 15, 60 minutes) and end "dead" after 6 attempts, visible in Settings.
// Deploy (pg_net cannot send a user JWT; the shared secret is the credential, and "op: test" checks the caller's JWT itself):
//   supabase functions deploy line-dispatch --no-verify-jwt --project-ref hlvravynjalculvplrxc
import { createClient } from 'npm:@supabase/supabase-js@2.49.1';
import { lineClient } from '../_shared/line.ts';
import { handleDispatch, type OutboxRow } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(async (req) => {
  const { data: cred } = await admin.rpc('line_credentials_internal');
  const c = (cred ?? {}) as { access_token?: string | null; dispatch_secret?: string | null; channel_secret?: string | null };
  const line = lineClient(c.access_token ?? '', (url, init) => fetch(url, init));
  return handleDispatch(req, {
    dispatchSecret: async () => c.dispatch_secret ?? null,
    token: async () => c.access_token ?? null,
    async claim(limit) {
      const { data, error } = await admin.rpc('line_claim_outbox', { p_limit: limit });
      if (error) throw new Error(error.message);
      return (data ?? []) as OutboxRow[];
    },
    async complete(id, ok, retryable, error, requestId) {
      const { error: e } = await admin.rpc('line_complete_outbox', { p_id: id, p_ok: ok, p_retryable: retryable, p_error: error, p_request_id: requestId });
      if (e) console.error('line_complete_outbox failed: ' + e.message);
    },
    push: (to, messages, key) => line.push(to, messages, key),
    botInfo: () => line.botInfo(),
    async isSuperAdmin(jwt) {
      const { data, error } = await admin.auth.getUser(jwt);
      if (error || !data.user) return false;
      const { data: p } = await admin.from('profiles').select('role, status').eq('id', data.user.id).maybeSingle();
      return p?.role === 'SUPER_ADMIN' && p?.status === 'active';
    },
    secrets: () => [c.access_token, c.dispatch_secret, c.channel_secret, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')],
  });
});
