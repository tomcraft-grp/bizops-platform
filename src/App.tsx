import { ReactNode, useEffect } from 'react';
import { HashRouter, Route, Routes, Navigate } from 'react-router-dom';
import { act, useStore } from './domain/store';
import { processPrintQueue } from './domain/printing';
import { sweepReservations } from './domain/events';
import { ConfirmProvider, Toasts } from './ui/kit';
import { Gate, Shell } from './ui/Shell';
import Dashboard from './pages/Dashboard';
import POS from './pages/POS';
import Orders from './pages/Orders';
import Channels from './pages/Channels';
import KDS from './pages/KDS';
import Customers from './pages/Customers';
import Receivables from './pages/Receivables';
import Loyalty from './pages/Loyalty';
import Promotions from './pages/Promotions';
import Events from './pages/Events';
import Products from './pages/Products';
import Inventory from './pages/Inventory';
import Purchasing from './pages/Purchasing';
import Production from './pages/Production';
import Accounting from './pages/Accounting';
import AccountingSetup from './pages/AccountingSetup';
import Profit from './pages/Profit';
import Reports from './pages/Reports';
import Printing from './pages/Printing';
import Media from './pages/Media';
import { Team, SettingsPage, Health } from './pages/Admin';
import Blueprint from './pages/Blueprint';
import CustomerApp from './pages/CustomerApp';
import FeedbackIssues from './pages/FeedbackIssues';
import DevApp from './pages/DevApp';
import Finance from './pages/Finance';
import ExpensesPage from './expenses/ExpensesPage';
import Login from './pages/auth/Login';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
import Unauthorized from './pages/auth/Unauthorized';
import LiffEntry from './pages/auth/LiffEntry';
import LineMembers from './pages/LineMembers';
import { useAuth } from './auth/AuthProvider';
import { RequireAuth, RequireRole } from './auth/guards';
import { DEMO_SEED } from './domain/demo';
import { PENDING_USER_ID } from './domain/seedData';

const G = ({ perm, children }: { perm: string; children: ReactNode }) => <Gate perm={perm}>{children}</Gate>;

// Bridges the REAL role (profile.role, server-enforced via RLS) onto this prototype's pre-existing
// simulated per-user permission matrix (MODULES in domain/core.ts), so the fine-grained module gates
// (`feedback:view`, `accounting:view`, …) keep working without rewriting them: SUPER_ADMIN borrows the
// seeded Owner identity (full access), ADMIN borrows the seeded Manager identity.
function RoleBridge() {
  const { profile } = useAuth();
  useEffect(() => {
    if (!profile) return;
    if (DEMO_SEED) {
      const targetUserId = profile.role === 'SUPER_ADMIN' ? 'U1' : profile.role === 'ADMIN' ? 'U2' : null;
      if (targetUserId) act((d) => { d.meta.currentUserId = targetUserId; });
      return;
    }
    // Real app: the acting user IS the signed-in Supabase profile (no simulated people).
    const roleId = profile.role === 'SUPER_ADMIN' ? 'role-owner' : profile.role === 'ADMIN' ? 'role-manager' : 'role-none';
    act((d) => {
      d.users = d.users.filter((u) => u.id !== PENDING_USER_ID);
      const name = profile.display_name || profile.email;
      const u = d.users.find((x) => x.id === profile.id);
      if (u) { u.name = name; u.email = profile.email; u.roleId = roleId; u.active = profile.status === 'active'; }
      else d.users.push({ id: profile.id, name, email: profile.email, roleId, branchIds: [], active: profile.status === 'active', color: '#2a78d6' });
      d.meta.currentUserId = profile.id;
    });
  }, [profile]);
  return null;
}

export default function App() {
  // background workers: simulated print agent + event reservation sweeper
  useEffect(() => {
    const i = setInterval(() => {
      const db = useStore.getState().db;
      if (db.printJobs.some((j) => j.status === 'queued' && db.printers.find((p) => p.id === j.printerId)?.connection === 'agent')) act((d, c) => processPrintQueue(d, c));
      if (db.selections.some((s) => s.status === 'reserved' && s.reservedUntil && s.reservedUntil <= new Date().toISOString())) act((d, c) => sweepReservations(d, c));
    }, 2500);
    return () => clearInterval(i);
  }, []);
  return (
    <ConfirmProvider>
      <RoleBridge />
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/liff" element={<LiffEntry />} />
          {/* Public email sign-up is off (Supabase disable_signup): customers join via LINE, staff are added by an admin. */}
          <Route path="/register" element={<Navigate to="/login" replace />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/unauthorized" element={<Unauthorized />} />
          <Route path="/app" element={<RequireAuth><CustomerApp /></RequireAuth>} />
          <Route path="/my-expenses" element={<RequireAuth><ExpensesPage mode="standalone" /></RequireAuth>} />
          <Route element={<RequireAuth><RequireRole roles={['SUPER_ADMIN', 'ADMIN']}><Shell /></RequireRole></RequireAuth>}>
            <Route index element={<G perm="dashboard:view"><Dashboard /></G>} />
            <Route path="pos" element={<G perm="pos:view"><POS /></G>} />
            <Route path="orders" element={<G perm="orders:view"><Orders /></G>} />
            <Route path="channels" element={<G perm="channels:view"><Channels /></G>} />
            <Route path="kds" element={<G perm="kds:view"><KDS /></G>} />
            <Route path="customers" element={<G perm="customers:view"><Customers /></G>} />
            <Route path="members" element={<G perm="customers:view"><LineMembers /></G>} />
            <Route path="receivables" element={<G perm="receivables:view"><Receivables /></G>} />
            <Route path="payment-review" element={<G perm="receivables:view"><Finance /></G>} />
            <Route path="loyalty" element={<G perm="loyalty:view"><Loyalty /></G>} />
            <Route path="promotions" element={<G perm="promotions:view"><Promotions /></G>} />
            <Route path="events" element={<G perm="events:view"><Events /></G>} />
            <Route path="products" element={<G perm="catalog:view"><Products /></G>} />
            <Route path="inventory" element={<G perm="inventory:view"><Inventory /></G>} />
            <Route path="purchasing" element={<G perm="purchasing:view"><Purchasing /></G>} />
            <Route path="production" element={<G perm="production:view"><Production /></G>} />
            <Route path="expenses" element={<ExpensesPage mode="backoffice" />} />
            <Route path="accounting" element={<G perm="accounting:view"><Accounting /></G>} />
            <Route path="accounting/setup" element={<G perm="accounting:view"><AccountingSetup /></G>} />
            <Route path="profit" element={<Profit />} />
            <Route path="reports" element={<Reports />} />
            <Route path="printing" element={<G perm="printing:view"><Printing /></G>} />
            <Route path="media" element={<G perm="media:view"><Media /></G>} />
            <Route path="team" element={<G perm="team:view"><Team /></G>} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="health" element={<Health />} />
            <Route path="blueprint" element={<Blueprint />} />
            <Route path="feedback" element={<G perm="feedback:view"><FeedbackIssues /></G>} />
            <Route path="dev-app" element={<G perm="devapp:view"><DevApp /></G>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <Toasts />
    </ConfirmProvider>
  );
}
