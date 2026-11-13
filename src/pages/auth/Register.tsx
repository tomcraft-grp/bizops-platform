import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Banner, Button, Card, Field, Input } from '../../ui/kit';

export default function Register() {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setBusy(true); setErr(null);
    const { error } = await signUp(email.trim(), password, name.trim() || undefined);
    setBusy(false);
    if (error) { setErr(error); return; }
    // Always the same message whether the email was new or already registered, so registration
    // never reveals which emails already exist (Supabase itself returns no error either way).
    setDone(true);
  };

  if (done) {
    return (
      <div className="auth-shell">
        <Card title="Check your email" sub="BizOps Platform" className="auth-card">
          <p className="text2">If that email isn't already registered, we've sent a confirmation link to <b>{email}</b>. Click it to activate your account, then sign in.</p>
          <Link to="/login"><Button variant="primary" className="block">Back to sign in</Button></Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <Card title="Create an account" sub="BizOps Platform" className="auth-card">
        <form onSubmit={submit} className="col gap-12">
          {err && <Banner tone="bad">{err}</Banner>}
          <Field label="Name"><Input autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password" hint="At least 8 characters."><Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy}>Create account</Button>
          <div style={{ fontSize: 13 }}>Already have an account? <Link to="/login">Sign in</Link></div>
        </form>
      </Card>
    </div>
  );
}
