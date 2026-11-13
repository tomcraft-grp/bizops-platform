// Server-enforced authorization lives in Postgres RLS (see the migrations on profiles/login_attempts/
// auth_audit_logs) — these guards are the UI layer only: they decide what to render, they never grant
// access themselves. A client bypassing them would still be stopped by RLS on every real query.
import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ProfileRole, useAuth } from './AuthProvider';

function Splash() {
  return <div className="auth-shell"><div className="spinner" /></div>;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Splash />;
  if (!session) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}

/** Gate by real role (profile.role). Children render only if the signed-in profile's role is listed. */
export function RequireRole({ roles, children }: { roles: ProfileRole[]; children: ReactNode }) {
  const { profile, loading } = useAuth();
  if (loading) return <Splash />;
  if (!profile) return <Splash />;
  if (profile.status !== 'active') return <Navigate to="/unauthorized" replace />;
  if (!roles.includes(profile.role)) return <Navigate to={profile.role === 'USER' ? '/app' : '/'} replace />;
  return <>{children}</>;
}
