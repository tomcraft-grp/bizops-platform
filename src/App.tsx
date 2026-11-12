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
import Profit from './pages/Profit';
import Reports from './pages/Reports';
import Printing from './pages/Printing';
import Media from './pages/Media';
import { Team, SettingsPage, Health } from './pages/Admin';
import Blueprint from './pages/Blueprint';
import CustomerApp from './pages/CustomerApp';

const G = ({ perm, children }: { perm: string; children: ReactNode }) => <Gate perm={perm}>{children}</Gate>;

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
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/app" element={<CustomerApp />} />
          <Route element={<Shell />}>
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
            <Route path="profit" element={<Profit />} />
            <Route path="reports" element={<Reports />} />
            <Route path="printing" element={<G perm="printing:view"><Printing /></G>} />
            <Route path="media" element={<G perm="media:view"><Media /></G>} />
            <Route path="team" element={<G perm="team:view"><Team /></G>} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="health" element={<Health />} />
            <Route path="blueprint" element={<Blueprint />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <Toasts />
    </ConfirmProvider>
  );
}
