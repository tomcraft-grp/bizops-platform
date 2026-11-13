import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Banner, Button, Card, Field, Input } from '../../ui/kit';

export default function Login() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    const { error } = await signIn(email.trim(), password);
    setBusy(false);
    if (error) { setErr(error); return; }
    const to = (loc.state as { from?: string } | null)?.from ?? '/';
    nav(to, { replace: true });
  };

  return (
    <div className="auth-shell">
      <Card title="Sign in" sub="BizOps Platform" className="auth-card">
        <form onSubmit={submit} className="col gap-12">
          {err && <Banner tone="bad">{err}</Banner>}
          <Field label="Email"><Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy}>Sign in</Button>
          <div className="row between" style={{ fontSize: 13 }}>
            <Link to="/forgot-password">Forgot password?</Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
