import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Banner, Button, Card, Field, Input } from '../../ui/kit';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const addr = email.trim();
    if (!EMAIL.test(addr)) { setErr('Please enter a valid email address, e.g. name@example.com.'); return; }
    setBusy(true); setErr(null);
    const { error } = await requestPasswordReset(addr);
    setBusy(false);
    if (error) {
      // Supabase answers the same way for registered and unknown addresses, so errors here are about sending,
      // not about the account. Show a friendly message; the technical detail goes to the console only.
      console.warn('[password reset] request failed:', error);
      setErr(/rate limit|too many|seconds/i.test(error)
        ? 'Too many reset requests. Please wait a few minutes and try again.'
        : 'We could not send the reset email right now. Please try again in a few minutes.');
      return;
    }
    setDone(true);
  };

  if (done) {
    return (
      <div className="auth-shell">
        <Card title="Check your email" sub="BizOps Platform" className="auth-card">
          <div className="col gap-12">
            <p className="text2" style={{ margin: 0 }}>If an account exists with this email address, you will receive a password reset link shortly. Please check your inbox and spam folder.</p>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The link works once and expires after 1 hour.</p>
            <Link to="/login"><Button variant="primary" className="block">Back to sign in</Button></Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <Card title="Forgot password" sub="BizOps Platform" className="auth-card">
        <form onSubmit={submit} className="col gap-12" noValidate>
          <p className="text2" style={{ margin: 0 }}>Enter the email address you sign in with. We'll email you a link to set a new password.</p>
          {err && <Banner tone="bad">{err}</Banner>}
          <Field label="Email"><Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => { setEmail(e.target.value); setErr(null); }} aria-invalid={!!err} /></Field>
          <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
          <div style={{ fontSize: 13 }}><Link to="/login">Back to sign in</Link></div>
        </form>
      </Card>
    </div>
  );
}
