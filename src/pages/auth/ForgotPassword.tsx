import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Banner, Button, Card, Field, Input } from '../../ui/kit';

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    const { error } = await requestPasswordReset(email.trim());
    setBusy(false);
    if (error) { setErr(error); return; }
    // Same message regardless of whether the email exists — no account enumeration here either.
    setDone(true);
  };

  if (done) {
    return (
      <div className="auth-shell">
        <Card title="Check your email" sub="BizOps Platform" className="auth-card">
          <p className="text2">If <b>{email}</b> has an account, we've sent a link to reset the password. It expires after a short time.</p>
          <Link to="/login"><Button variant="primary" className="block">Back to sign in</Button></Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <Card title="Forgot password" sub="BizOps Platform" className="auth-card">
        <form onSubmit={submit} className="col gap-12">
          {err && <Banner tone="bad">{err}</Banner>}
          <Field label="Email"><Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy}>Send reset link</Button>
          <div style={{ fontSize: 13 }}><Link to="/login">Back to sign in</Link></div>
        </form>
      </Card>
    </div>
  );
}
