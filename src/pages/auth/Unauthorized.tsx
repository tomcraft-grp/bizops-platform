import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card } from '../../ui/kit';

export default function Unauthorized() {
  const { signOut } = useAuth();
  const nav = useNavigate();
  return (
    <div className="auth-shell">
      <Card title="Account disabled" sub="BizOps Platform" className="auth-card">
        <p className="text2">Your account has been disabled. Contact an administrator if you believe this is a mistake.</p>
        <Button variant="primary" className="block" onClick={async () => { await signOut(); nav('/login', { replace: true }); }}>Sign out</Button>
      </Card>
    </div>
  );
}
