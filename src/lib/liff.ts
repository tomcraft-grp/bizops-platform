// LINE LIFF sign-in for customers: open https://liff.line.me/<LIFF_ID> inside LINE and you are signed in,
// no email or password. Flow: liff.init → LINE ID token → Supabase Edge Function `line-auth` verifies the
// token with LINE and returns a Supabase session for that LINE account → supabase.auth.setSession().
// The LIFF ID and channel ID are public identifiers (they appear in every LIFF URL), not secrets.
import liff from '@line/liff';
import { supabase } from './supabase';

export const LIFF_ID = '2012605932-nfC3frpA';

/** True when the page was opened as the LIFF endpoint (or is LINE returning from liff.login()). */
export function isLiffEntry(search = window.location.search): boolean {
  const q = new URLSearchParams(search);
  return q.get('entry') === 'liff' || q.has('liff.state') || q.has('liffClientId');
}

export type LiffResult = { status: 'signed-in' } | { status: 'redirecting' } | { status: 'error'; message: string };

export async function signInWithLine(): Promise<LiffResult> {
  try {
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
      // Outside the LINE app (e.g. a desktop browser) this goes to the LINE login page and comes back here.
      liff.login({ redirectUri: window.location.href.split('#')[0] });
      return { status: 'redirecting' };
    }
    const idToken = liff.getIDToken();
    if (!idToken) return { status: 'error', message: 'LINE did not return an ID token. Check that the LIFF app has the "openid" scope.' };
    const { data, error } = await supabase.functions.invoke('line-auth', { body: { idToken } });
    if (error) {
      // An expired cached ID token is the common case: log out of LIFF so the next attempt gets a fresh one.
      let detail = error.message;
      try { const body = await (error as { context?: Response }).context?.json(); if (body?.error) detail = body.error; } catch { /* keep generic message */ }
      if (/expired/i.test(detail)) liff.logout();
      return { status: 'error', message: detail };
    }
    const { access_token, refresh_token } = (data ?? {}) as { access_token?: string; refresh_token?: string };
    if (!access_token || !refresh_token) return { status: 'error', message: 'Sign-in service returned no session.' };
    const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token });
    if (setErr) return { status: 'error', message: setErr.message };
    return { status: 'signed-in' };
  } catch (e) {
    return { status: 'error', message: (e as Error).message || String(e) };
  }
}
