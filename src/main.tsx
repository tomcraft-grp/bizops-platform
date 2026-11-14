import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { AuthProvider } from './auth/AuthProvider';
import { applyTheme, boot, useStore } from './domain/store';
import { isLiffEntry } from './lib/liff';
import { DEMO_SEED } from './domain/demo';

// LINE opens the LIFF endpoint as ".../?entry=liff" (LINE does not allow a #hash in the endpoint URL),
// so route it to the LINE sign-in page before the hash router starts.
if (isLiffEntry() && !window.location.hash.startsWith('#/liff')) window.location.hash = '#/liff';

// Password-reset email links: Supabase verifies the token and redirects to the app ROOT with the result in the
// hash (it drops our "#/reset-password" route): "#access_token=…&type=recovery" or "#error=…&error_code=otp_expired".
// supabase-js turns the first into a recovery session by itself; we only remember that this visit is a recovery so
// AuthProvider can open the reset form. Expired/used links are sent to the reset page, which explains what happened.
// (Read synchronously here, before supabase-js clears the hash during its async initialisation.)
{
  const h = window.location.hash;
  if (/^#access_token=/.test(h) && /(^|&)type=recovery(&|$)/.test(h.slice(1))) { try { sessionStorage.setItem('bizops.recovery', '1'); } catch { /* ignore */ } }
  else if (/^#error=/.test(h) && /otp_expired|email\+link/i.test(h)) window.location.hash = '#/reset-password#' + h.slice(1);
}

applyTheme(useStore.getState().ui.theme);
const root = createRoot(document.getElementById('root')!);
root.render(<div className="splash"><div><div className="spinner" /><b>{DEMO_SEED ? 'Preparing demo data…' : 'Loading…'}</b>{DEMO_SEED && <div className="muted" style={{ marginTop: 4 }}>Generating 26 days of trading history with the real engine</div>}</div></div>);
boot().then(() => root.render(<React.StrictMode><AuthProvider><App /></AuthProvider></React.StrictMode>)).catch((e) => {
  root.render(<div className="splash"><div><b>Failed to start</b><pre style={{ maxWidth: 600, whiteSpace: 'pre-wrap' }}>{String(e?.stack || e)}</pre></div></div>);
});
