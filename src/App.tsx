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
import Login from './pages/auth/Login';
import Register from './pages/auth/Register';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
import Unauthorized from './pages/auth/Unauthorized';
import { useAuth } from './auth/AuthProvider';
import { RequireAuth, RequireRole } from './auth/guards';

const G = ({ perm, children }: { perm: string; children: ReactNode }) => <Gate perm={perm}>{children}</Gate>;

// Bridges the REAL role (profile.role, server-enforced via RLS) onto this prototype's pre-existing
// simulated per-user permission matrix (MODULES in domain/core.ts), so the fine-grained module gates
// (`feedback:view`, `accounting:view`, …) keep working without rewriting them: SUPER_ADMIN borrows the
// seeded Owner identity (full access), ADMIN borrows the seeded Manager identity.
function RoleBridge() {
  const { profile } = useAuth();
  useEffect(() => {
    if (!profile) return;
    const targetUserId = profile.role === 'SUPER_ADMIN' ? 'U1' : profile.role === 'ADMIN' ? 'U2' : null;
    if (targetUserId) act((d) => { d.meta.currentUserId = targetUserId; });
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
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/unauthorized" element={<Unauthorized />} />
          <Route path="/app" element={<RequireAuth><CustomerApp /></RequireAuth>} />
          <Route element={<RequireAuth><RequireRole roles={['SUPER_ADMIN', 'ADMIN']}><Shell /></RequireRole></RequireAuth>}>
            <Route index element={<G perm="dashboard:view"><Dashboard /></G>} />
            <Route path="pos" element={<G perm="pos:view"><POS /></G>} />
            <Route path="orders" element={<G perm="orders:view"><Orders /></G>} />
            <Route path="channels" element={<G perm="channels:view"><Channels /></G>} />
            <Route path="kds" element={<G perm="kds:view"><KDS /></G>} />
            <Route path="customers" element={<G perm="customers:view"><Customers /></G>} />
            <Route path="receivables" element={<G perm="receivables:view"><Receivables /></G>} />
            <Route path="loyalty" element={<G perm="loyalty:view"><Loyalty /></G>} />
            <Route path="promotions" element={<G perm="promotions:view"><Promotions /></G>} />
            <Route path="events" element={<G perm="events:view"><Events /></G>} />
            <Route path="products" element={<G perm="catalog:view"><Products /></G>} />
            <Route path="inventory" element={<G perm="inventory:view"><Inventory /></G>} />
            <Route path="purchasing" element={<G perm="purchasing:view"><Purchasing /></G>} />
            <Route path="production" element={<G perm="production:view"><Production /></G>} />
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <Toasts />
    </ConfirmProvider>
  );
}
