import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { supabase } from '../../lib/supabase';
import { Banner, Button, Card, Field, PasswordInput } from '../../ui/kit';

// Reached from the password-reset email: #/reset-password?token_hash=…&type=recovery (template in
// supabase/auth/recovery-email.html). The token is checked when the form is submitted (single use, 1 hour).
// Links sent with the previous template end in "#/reset-password#access_token=…", which supabase-js cannot
// parse under the hash router; those tokens are picked up here so already-sent emails still work.
export const PASSWORD_RULES = 'At least 8 characters, with at least one letter and one number.';
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}

export default function ResetPassword() {
  const { completePasswordReset, session } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const tokenHash = params.get('type') === 'recovery' ? params.get('token_hash') : null;
  const [legacy, setLegacy] = useState<'none' | 'checking' | 'ok' | 'bad'>('none');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [verified, setVerified] = useState(false); // token already exchanged for a recovery session

  useEffect(() => {
    const h = window.location.hash;
    if (h.indexOf('#error=', 1) > 0 || h.indexOf('#error_code=', 1) > 0) { setExpired(true); return; }
    const i = h.indexOf('#access_token=', 1);
    if (i < 0) return;
    const p = new URLSearchParams(h.slice(i + 1));
    const access_token = p.get('access_token'), refresh_token = p.get('refresh_token');
    window.history.replaceState(null, '', window.location.pathname + '#/reset-password'); // keep tokens out of history
    if (!access_token || !refresh_token || p.get('type') !== 'recovery') { setLegacy('bad'); return; }
    setLegacy('checking');
    supabase.auth.setSession({ access_token, refresh_token }).then(({ error }) => setLegacy(error ? 'bad' : 'ok'));
  }, []);

  const usable = !!tokenHash || legacy === 'ok' || (legacy === 'none' && !!session);
  const invalid = expired || legacy === 'bad' || (!usable && legacy !== 'checking');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = passwordProblem(password);
    if (problem) { setErr(problem); return; }
    if (password !== confirm) { setErr('The two passwords do not match.'); return; }
    setBusy(true); setErr(null);
    const r = await completePasswordReset(verified ? null : tokenHash, password);
    setBusy(false);
    if (r.verified) setVerified(true);
    if (r.error) { if (r.expired) setExpired(true); setErr(r.error); return; }
    nav('/login', { replace: true, state: { notice: 'Your password has been reset. Sign in with your new password.' } });
  };

  if (invalid) {
    return (
      <div className="auth-shell">
        <Card title="Reset link expired" sub="BizOps Platform" className="auth-card">
          <div className="col gap-12">
            <Banner tone="warn">This password reset link has expired or has already been used. Reset links work once and are valid for 1 hour.</Banner>
            <Link to="/forgot-password"><Button variant="primary" className="block">Request a new link</Button></Link>
            <div style={{ fontSize: 13 }}><Link to="/login">Back to sign in</Link></div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <Card title="Set a new password" sub="BizOps Platform" className="auth-card">
        <form onSubmit={submit} className="col gap-12" noValidate>
          {err && <Banner tone="bad">{err}</Banner>}
          <Field label="New password" hint={PASSWORD_RULES}>
            <PasswordInput autoComplete="new-password" autoFocus required value={password} disabled={legacy === 'checking'} onChange={(e) => { setPassword(e.target.value); setErr(null); }} />
          </Field>
          <Field label="Confirm new password">
            <PasswordInput autoComplete="new-password" required value={confirm} disabled={legacy === 'checking'} onChange={(e) => { setConfirm(e.target.value); setErr(null); }} />
          </Field>
          <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy || legacy === 'checking'}>{busy ? 'Saving…' : 'Reset password'}</Button>
          <div style={{ fontSize: 13 }}><Link to="/login">Back to sign in</Link></div>
        </form>
      </Card>
    </div>
  );
}
