// Supabase Edge Function: the LINE Messaging API webhook (card buttons, link codes, the bot leaving the admin group).
//   1. checks X-Line-Signature with the channel secret (read from Vault through line_credentials_internal),
//   2. drops events already handled (line_webhook_seen: LINE redelivers on timeouts),
//   3. hands each card tap to line_act, which acts AS the linked staff member through the existing order and finance functions (their role checks, locks
//      and audit rows apply unchanged), and replies with the result (reply token; push when it has expired).
// It writes ONLY through the RPCs line_webhook_seen / line_redeem_code / line_group_left / line_act (service role).
// Deploy (callers are LINE's servers, not signed-in users; the signature is the credential):
//   supabase functions deploy line-webhook --no-verify-jwt --project-ref hlvravynjalculvplrxc
// Webhook URL to paste in the LINE Developers console: https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-webhook
import { createClient } from 'npm:@supabase/supabase-js@2.49.1';
import { lineClient } from '../_shared/line.ts';
import type { ActResult } from '../_shared/lineCards.ts';
import { handleWebhook } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

async function credentials(): Promise<{ channel_secret: string | null; access_token: string | null }> {
  const { data, error } = await admin.rpc('line_credentials_internal');
  if (error) throw new Error(error.message);
  return data ?? { channel_secret: null, access_token: null };
}
async function settings(): Promise<{ group_id: string | null; app_url: string }> {
  const { data } = await admin.from('line_settings').select('group_id, app_url').eq('id', true).maybeSingle();
  return data ?? { group_id: null, app_url: 'https://tomcraft-grp.github.io/bizops-platform/' };
}

Deno.serve(async (req) => {
  const cred = await credentials().catch(() => ({ channel_secret: null, access_token: null }));
  const line = lineClient(cred.access_token ?? '', (url, init) => fetch(url, init));
  const s = await settings();
  return handleWebhook(req, {
    channelSecret: async () => cred.channel_secret,
    async seen(eventId, type, source) {
      const { data, error } = await admin.rpc('line_webhook_seen', { p_event_id: eventId, p_type: type, p_source: source });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async redeem(lineUser, name, code, group) {
      const { data, error } = await admin.rpc('line_redeem_code', { p_line_user: lineUser, p_display_name: name, p_code: code, p_group: group });
      if (error) throw new Error(error.message);
      return data as { result: string; name?: string };
    },
    async groupLeft(group) { await admin.rpc('line_group_left', { p_group: group }); },
    boundGroup: async () => s.group_id,
    appUrl: async () => s.app_url,
    async act(a) {
      const { data, error } = await admin.rpc('line_act', { p_line_user: a.lineUser, p_action: a.action, p_order: a.order, p_card: a.card, p_reason: a.reason, p_event_id: a.eventId });
      if (error) throw new Error(error.message);
      return data as ActResult;
    },
    reply: (token, messages) => line.reply(token, messages),
    push: (to, messages) => line.push(to, messages, crypto.randomUUID()),
    profileName: (userId) => line.profileName(userId),
    groupName: (groupId) => line.groupName(groupId),
    log: (m) => console.error(m),
  });
});
