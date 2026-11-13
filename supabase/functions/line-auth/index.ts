// Supabase Edge Function: exchange a LINE ID token (from LIFF) for a Supabase session.
// Supabase Auth has no built-in LINE provider, so this function is the bridge:
//   1. verify the ID token with LINE (signature, audience = our LINE Login channel, expiry)
//   2. find-or-create a Supabase user for that LINE account (role USER via the handle_new_user trigger)
//   3. mint a session server-side (admin magic-link token, verified immediately — no email is sent)
// Deploy with verify_jwt = false: callers are not signed in yet; the LINE ID token is the credential.
import { createClient } from 'npm:@supabase/supabase-js@2.49.1';

const LINE_CHANNEL_ID = Deno.env.get('LINE_CHANNEL_ID') ?? '2012605932';
const ALLOWED_ORIGINS = ['https://tomcraft-grp.github.io', 'http://localhost:5173'];

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('Origin'));
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

  let idToken: unknown;
  try { ({ idToken } = await req.json()); } catch { return reply(400, { error: 'Invalid JSON body' }); }
  if (typeof idToken !== 'string' || !idToken) return reply(400, { error: 'idToken is required' });

  // 1. Verify with LINE. Rejects forged, expired, or other-channel tokens.
  const verify = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  const line = await verify.json().catch(() => ({}));
  if (!verify.ok || typeof line.sub !== 'string') {
    return reply(401, { error: `LINE token rejected: ${line.error_description ?? line.error ?? verify.status}` });
  }
  const lineUserId: string = line.sub;
  const meta = { provider: 'line', line_user_id: lineUserId, display_name: line.name ?? null, picture: line.picture ?? null };

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 2. One Supabase user per LINE account, keyed by a synthetic, non-deliverable address derived from the LINE user ID.
  const email = `line_${lineUserId.toLowerCase()}@line.invalid`;
  const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: meta });
  if (created.error && !/already|exists|registered/i.test(created.error.message)) {
    return reply(500, { error: `Could not create user: ${created.error.message}` });
  }

  // 3. Mint a session: generate a magic-link token (not emailed) and redeem it right away.
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error || !link.data.properties?.hashed_token) {
    return reply(500, { error: `Could not create session: ${link.error?.message ?? 'no token'}` });
  }
  const userId = link.data.user.id;

  const { data: profile } = await admin.from('profiles').select('status, line_user_id').eq('id', userId).maybeSingle();
  if (profile?.status === 'disabled') return reply(403, { error: 'This account has been disabled. Please contact the shop.' });
  // Record the LINE ID on the profile (only this service-role call may set it; see protect_profile_columns).
  if (profile && !profile.line_user_id) await admin.from('profiles').update({ line_user_id: lineUserId }).eq('id', userId);

  // Keep name/picture current (customers change them in LINE).
  await admin.auth.admin.updateUserById(userId, { user_metadata: meta });

  const otp = await admin.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
  if (otp.error || !otp.data.session) return reply(500, { error: `Could not create session: ${otp.error?.message ?? 'no session'}` });

  return reply(200, { access_token: otp.data.session.access_token, refresh_token: otp.data.session.refresh_token });
});
