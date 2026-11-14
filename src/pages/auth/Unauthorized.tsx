import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card } from '../../ui/kit';
import { AuthLayout } from '../../ui/Brand';
import { BRAND } from '../../brand';

export default function Unauthorized() {
  const { signOut } = useAuth();
  const nav = useNavigate();
  return (
    <AuthLayout>
      <Card title="Account disabled" sub={BRAND.name} className="auth-card">
        <p className="text2">Your account has been disabled. Contact an administrator if you believe this is a mistake.</p>
        <Button variant="primary" className="block" onClick={async () => { await signOut(); nav('/login', { replace: true }); }}>Sign out</Button>
      </Card>
    </AuthLayout>
  );
}
