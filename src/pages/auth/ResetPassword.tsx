import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Banner, Button, Card, Field, Input } from '../../ui/kit';

// Reached by clicking the link in a password-reset email. supabase-js (detectSessionInUrl: true,
// configured in src/lib/supabase.ts) parses the recovery tokens from the URL and establishes a
// session before this component renders, so we only need to call updateUser() with the new password.
export default function ResetPassword() {
  const { updatePassword, session } = useAuth();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setBusy(true); setErr(null);
    const { error } = await updatePassword(password);
    setBusy(false);
    if (error) { setErr(error); return; }
    setDone(true);
  };

  if (done) {
    return (
      <div className="auth-shell">
        <Card title="Password updated" sub="BizOps Platform" className="auth-card">
          <p className="text2">Your password has been changed. You're signed in with it now.</p>
          <Button variant="primary" className="block" onClick={() => nav('/', { replace: true })}>Continue</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <Card title="Set a new password" sub="BizOps Platform" className="auth-card">
        <div className="col gap-12">
          {!session && <Banner tone="warn">This reset link is invalid or has expired. Request a new one from the Forgot password page.</Banner>}
          <form onSubmit={submit} className="col gap-12">
            {err && <Banner tone="bad">{err}</Banner>}
            <Field label="New password" hint="At least 8 characters.">
              <Input type="password" autoComplete="new-password" autoFocus required disabled={!session} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy || !session}>Update password</Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
