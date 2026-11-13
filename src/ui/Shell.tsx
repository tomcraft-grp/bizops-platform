import { ReactNode, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, Boxes, Calculator, ChefHat, ChevronsLeft, ChevronsRight, CircleUser, Factory, FileImage, Gift, Heart, LayoutDashboard, Layers, Languages, LineChart, Lock, LogOut, Menu, Monitor, Moon,
  Package, Percent, Printer, Search, Settings, ShieldCheck, ShoppingBag, ShoppingCart, Smartphone, Sparkles, Store, Sun, Tag, Truck, Users, Wallet, Radio, Hash, FileText, Activity, Map, Check, MessageSquarePlus,
} from 'lucide-react';
import { act, setLang, setTheme, toggleCollapsed, setUI, useDB, useLang, useStore } from '../domain/store';
import { currentUser, hasPerm, userPerms } from '../domain/core';
import { Avatar, Badge, Button, Empty, Popover, Modal, useUser } from './kit';
import { useAlerts } from './data';
import { cx, money } from '../lib/util';
import { CHANNELS } from '../domain/meta';
import { FeedbackButton } from './FeedbackWidget';
import { t } from '../lib/i18n';
import { useAuth } from '../auth/AuthProvider';

interface NavItem { to: string; label: string; icon: ReactNode; perm: string; badge?: 'orders' | 'slips' | 'prints' | 'sync' | 'low' }
const NAV: { title: string; items: NavItem[] }[] = [
  { title: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: <LayoutDashboard />, perm: 'dashboard:view' }] },
  { title: 'Sell', items: [
    { to: '/pos', label: 'POS', icon: <ShoppingCart />, perm: 'pos:view' },
    { to: '/orders', label: 'Orders', icon: <ShoppingBag />, perm: 'orders:view', badge: 'orders' },
    { to: '/channels', label: 'Channels', icon: <Radio />, perm: 'channels:view', badge: 'sync' },
    { to: '/kds', label: 'Kitchen display', icon: <ChefHat />, perm: 'kds:view' },
  ] },
  { title: 'Customers', items: [
    { to: '/customers', label: 'Customers', icon: <Users />, perm: 'customers:view' },
    { to: '/members', label: 'LINE members', icon: <Smartphone />, perm: 'customers:view' },
    { to: '/receivables', label: 'Receivables', icon: <Wallet />, perm: 'receivables:view', badge: 'slips' },
    { to: '/loyalty', label: 'Loyalty & rewards', icon: <Heart />, perm: 'loyalty:view' },
    { to: '/promotions', label: 'Promotions', icon: <Percent />, perm: 'promotions:view' },
    { to: '/events', label: 'Events', icon: <Hash />, perm: 'events:view' },
  ] },
  { title: 'Supply', items: [
    { to: '/products', label: 'Products', icon: <Tag />, perm: 'catalog:view' },
    { to: '/inventory', label: 'Inventory', icon: <Boxes />, perm: 'inventory:view', badge: 'low' },
    { to: '/purchasing', label: 'Purchasing', icon: <Truck />, perm: 'purchasing:view' },
    { to: '/production', label: 'BOM & production', icon: <Factory />, perm: 'production:view' },
  ] },
  { title: 'Finance', items: [
    { to: '/accounting', label: 'Accounting', icon: <Calculator />, perm: 'accounting:view' },
    { to: '/profit', label: 'Profit engine', icon: <LineChart />, perm: 'profit:view' },
    { to: '/reports', label: 'Reports', icon: <FileText />, perm: 'reports:view' },
  ] },
  { title: 'Operations', items: [
    { to: '/printing', label: 'Printing', icon: <Printer />, perm: 'printing:view', badge: 'prints' },
    { to: '/media', label: 'Media & documents', icon: <FileImage />, perm: 'media:view' },
  ] },
  { title: 'Admin', items: [
    { to: '/team', label: 'Team & access', icon: <ShieldCheck />, perm: 'team:view' },
    { to: '/settings', label: 'Settings', icon: <Settings />, perm: 'settings:view' },
    { to: '/health', label: 'System health', icon: <Activity />, perm: 'system:view' },
    { to: '/blueprint', label: 'Blueprint & scope', icon: <Map />, perm: 'dashboard:view' },
    { to: '/feedback', label: 'Feedback & issues', icon: <MessageSquarePlus />, perm: 'feedback:view' },
  ] },
];

export function Shell() {
  const db = useDB();
  const ui = useStore((s) => s.ui);
  const lang = useLang();
  const user = useUser();
  const { profile } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const alerts = useAlerts();
  const perms = userPerms(db, user);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => { setUI({ sidebarOpen: false }); }, [loc.pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const badges: Record<string, number> = { orders: alerts.newOrders, slips: alerts.slips.length, prints: alerts.failedPrints.length, sync: alerts.syncErrors.length, low: alerts.low.length };
  const branches = user.branchIds.length ? db.branches.filter((b) => user.branchIds.includes(b.id)) : db.branches;

  return (
    <div className={cx('app', ui.collapsed && 'collapsed')}>
      <aside className={cx('sidebar', ui.sidebarOpen && 'open')} aria-label={t(lang, 'Main navigation')}>
        <div className="brand"><div className="logo"><Store size={17} /></div><div>BizOps<small>{db.org.name.split(' ')[0]} · {t(lang, 'Prototype')}</small></div></div>
        <nav className="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => hasPerm(perms, i.perm));
            if (!items.length) return null;
            return (
              <div className="nav-group" key={g.title}>
                <div className="nav-title">{t(lang, g.title)}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => cx(isActive && 'active')} title={t(lang, i.label)}>
                    {i.icon}<span>{t(lang, i.label)}</span>{i.badge && badges[i.badge] > 0 && <b className="badge-dot">{badges[i.badge] > 99 ? '99+' : badges[i.badge]}</b>}
                  </NavLink>
                ))}
              </div>
            );
          })}
          <div className="nav-group">
            <div className="nav-title">{t(lang, 'Customer view')}</div>
            <NavLink to="/app" title={t(lang, 'Customer app (LINE LIFF simulator)')}><Smartphone /><span>{t(lang, 'Customer app (LIFF)')}</span></NavLink>
          </div>
        </nav>
        <div style={{ padding: 10, borderTop: '1px solid var(--border)' }} className="hide-sm">
          <Button variant="ghost" className="block" onClick={toggleCollapsed} title={t(lang, 'Collapse sidebar')}>{ui.collapsed ? <ChevronsRight size={17} /> : <><ChevronsLeft size={17} /> {t(lang, 'Collapse')}</>}</Button>
        </div>
      </aside>
      <div className={cx('scrim', ui.sidebarOpen && 'open')} onClick={() => setUI({ sidebarOpen: false })} />
      <div className="main">
        <header className="topbar">
          <Button variant="ghost" icon className="menu-btn" onClick={() => setUI({ sidebarOpen: true })} aria-label={t(lang, 'Open menu')}><Menu size={20} /></Button>
          <button className="search-btn" onClick={() => setSearchOpen(true)} aria-label={t(lang, 'Search')}><Search size={16} /><span>{t(lang, 'Search products, customers, orders…')}</span><kbd>Ctrl K</kbd></button>
          <div className="grow" />
          <select className="select sm" style={{ width: 'auto', maxWidth: 170 }} value={ui.branchScope} onChange={(e) => setUI({ branchScope: e.target.value })} aria-label={t(lang, 'Branch scope')}>
            {!user.branchIds.length && <option value="all">{t(lang, 'All branches')}</option>}
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <Button variant="ghost" icon onClick={() => setLang(lang === 'th' ? 'en' : 'th')} title={lang === 'th' ? 'Switch to English' : 'สลับเป็นภาษาไทย'} aria-label="Switch language"><Languages size={18} /></Button>
          <Button variant="ghost" icon onClick={() => setTheme(ui.theme === 'dark' ? 'light' : ui.theme === 'light' ? 'system' : 'dark')} title={t(lang, 'Theme: {theme}', { theme: t(lang, ui.theme) })} aria-label={t(lang, 'Toggle theme')}>{ui.theme === 'dark' ? <Moon size={18} /> : ui.theme === 'light' ? <Sun size={18} /> : <Monitor size={18} />}</Button>
          <Popover width={340} trigger={(_o, tg) => <Button variant="ghost" icon onClick={tg} aria-label={t(lang, 'Notifications')} style={{ position: 'relative' }}><Bell size={18} />{alerts.total > 0 && <span style={{ position: 'absolute', top: 3, right: 3, width: 8, height: 8, borderRadius: 4, background: 'var(--crit)' }} />}</Button>}>
            {(close) => <Notifications close={close} />}
          </Popover>
          <Popover width={300} trigger={(_o, tg) => <button className="user-chip" onClick={tg} aria-label={t(lang, 'Account menu — signed in as {email}', { email: profile?.email ?? '' })}><Avatar name={profile?.display_name || profile?.email || '?'} color={user.color} /><span className="nm" style={{ fontWeight: 600, fontSize: 13 }}>{(profile?.display_name || profile?.email || '').split(' ')[0].split('@')[0]}</span></button>}>
            {(close) => <UserMenu close={close} />}
          </Popover>
        </header>
        <main className="content"><Outlet /></main>
      </div>
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} go={(p) => { setSearchOpen(false); nav(p); }} />}
      <FeedbackButton />
    </div>
  );
}

function Notifications({ close }: { close: () => void }) {
  const a = useAlerts();
  const lang = useLang();
  const nav = useNavigate();
  const go = (p: string) => { close(); nav(p); };
  const rows = [
    { n: a.slips.length, t: 'payment slips awaiting review', to: '/receivables?tab=slips', tone: 'warn' as const },
    { n: a.failedPrints.length, t: 'print jobs failed', to: '/printing', tone: 'bad' as const },
    { n: a.syncErrors.length, t: 'channel sync errors (unmapped SKUs etc.)', to: '/channels?tab=errors', tone: 'bad' as const },
    { n: a.low.length, t: 'items below reorder level', to: '/inventory', tone: 'warn' as const },
    { n: a.newOrders, t: 'new online orders to confirm', to: '/orders', tone: 'info' as const },
    { n: a.pendingSettle.length, t: 'settlement statements to reconcile', to: '/channels?tab=settlements', tone: 'info' as const },
  ].filter((r) => r.n > 0);
  return (
    <div>
      <div style={{ padding: '6px 10px', fontWeight: 650 }}>{t(lang, 'Needs attention')}</div>
      {rows.length ? rows.map((r) => (
        <button key={r.t} className="menu-item" onClick={() => go(r.to)}><Badge tone={r.tone}>{r.n}</Badge><span>{t(lang, r.t)}</span></button>
      )) : <Empty title="All clear" hint="Nothing needs your attention right now." />}
    </div>
  );
}

function UserMenu({ close }: { close: () => void }) {
  const { profile, signOut } = useAuth();
  const nav = useNavigate();
  const lang = useLang();
  return (
    <div>
      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontWeight: 650 }}>{profile?.display_name || profile?.email}</div>
        <div className="muted" style={{ fontSize: 12 }}>{profile?.email}{profile?.role ? ` · ${profile.role}` : ''}</div>
      </div>
      <div className="divider" style={{ margin: '4px 0' }} />
      <button className="menu-item" onClick={async () => { close(); await signOut(); nav('/login', { replace: true }); }}>
        <LogOut size={16} /><span>{t(lang, 'Sign out')}</span>
      </button>
    </div>
  );
}

function SearchPalette({ onClose, go }: { onClose: () => void; go: (p: string) => void }) {
  const db = useDB();
  const lang = useLang();
  const perms = userPerms(db, currentUser(db));
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out: { k: string; icon: ReactNode; title: string; sub: string; to: string }[] = [];
    for (const g of NAV) for (const i of g.items) if (hasPerm(perms, i.perm) && (!s || i.label.toLowerCase().includes(s))) out.push({ k: 'p' + i.to, icon: i.icon, title: i.label, sub: 'Go to page', to: i.to });
    if (s.length >= 2) {
      if (hasPerm(perms, 'catalog:view')) for (const p of db.products) if ((p.name + p.sku + (p.barcode ?? '')).toLowerCase().includes(s)) { out.push({ k: 'pr' + p.id, icon: <Package />, title: p.name, sub: `Product · ${p.sku}`, to: `/products?p=${p.id}` }); if (out.length > 30) break; }
      if (hasPerm(perms, 'customers:view')) for (const c of db.customers) if ((c.name + c.phone + c.code).toLowerCase().includes(s)) out.push({ k: 'c' + c.id, icon: <CircleUser />, title: c.name, sub: `Customer · ${c.code} · ${c.phone}`, to: `/customers?c=${c.id}` });
      if (hasPerm(perms, 'orders:view')) for (const o of db.orders.slice().reverse()) { if ((o.no + (o.externalId ?? '')).toLowerCase().includes(s)) { out.push({ k: 'o' + o.id, icon: <ShoppingBag />, title: o.no + (o.externalId ? ` · ${o.externalId}` : ''), sub: `Order · ${CHANNELS[o.channel].short} · ${money(o.total)}`, to: `/orders?o=${o.id}` }); if (out.length > 40) break; } }
    }
    return out.slice(0, 14);
  }, [q, db, perms]);
  useEffect(() => setIdx(0), [q]);
  return (
    <Modal title="Search" onClose={onClose} size="lg">
      <div className="input-icon"><Search /><input className="input" autoFocus placeholder={t(lang, 'Type a product, SKU, customer, phone, order number or page…')} value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); } if (e.key === 'Enter' && results[idx]) go(results[idx].to); }} /></div>
      <div className="col gap-4 mt8">
        {results.map((r, i) => (
          <button key={r.k} className={cx('menu-item', i === idx && 'on')} onMouseEnter={() => setIdx(i)} onClick={() => go(r.to)}>
            <span className="kpi-ico">{r.icon}</span><div className="grow"><div style={{ fontWeight: 600 }}>{r.title}</div><div className="muted" style={{ fontSize: 12 }}>{t(lang, r.sub)}</div></div>
          </button>
        ))}
        {!results.length && <Empty title="No matches" hint="Try a different spelling, a SKU or part of an order number." />}
      </div>
    </Modal>
  );
}

export function Gate({ perm, children }: { perm: string; children: ReactNode }) {
  const db = useDB();
  const u = currentUser(db);
  if (hasPerm(userPerms(db, u), perm)) return <>{children}</>;
  const role = db.roles.find((r) => r.id === u.roleId);
  return (
    <div className="card" style={{ maxWidth: 560, margin: '60px auto' }}>
      <Empty icon={<Lock size={22} />} title="Access restricted" hint={<>Your role <b>{role?.name}</b> does not include <span className="mono">{perm}</span>. Ask an Owner to grant it in <b>Team &amp; access</b>, or switch user from the top-right menu to explore other roles.</>} />
    </div>
  );
}
export const IconLayers = Layers;
export const IconGift = Gift;
export const IconSparkles = Sparkles;
