import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BrandHeader, LayoutPage, OnboardingModal, themeVars, useDeviceOf, useLayoutFont } from '../devapp/render';
import { CUSTOMER_APP_ID, useCustomerLayout } from '../devapp/useCustomerLayout';
import { ALWAYS_VISIBLE, CoreType, customId, pageSections, TabKey } from '../devapp/schema';
import type { Row } from '../devapp/datasources';
import { ArrowLeft, Gift, Hash, Home, ShoppingBag, ShoppingCart, UserRound, Wallet, X } from 'lucide-react';
import { useDB, useStore, toast, act } from '../domain/store';
import { pointsBalance, redeemReward } from '../domain/loyalty';
import { availableEntitlements, claimNumber, confirmSelection, occupancy, pad2, releaseSelection } from '../domain/events';
import { Badge, Banner, Button, Card, Empty, Field, Input } from '../ui/kit';
import { useTicker } from '../ui/data';
import { cx, dateFmt } from '../lib/util';
import type { ID } from '../domain/types';
import { linkLineMember } from '../domain/master';
import { useAuth } from '../auth/AuthProvider';
import { supabase } from '../lib/supabase';
import FeedbackCenter, { useFeedbackNotifications } from './customer/FeedbackCenter';
import { CatalogCore } from '../shop/Catalog';
import { CartCore } from '../shop/CartPage';
import { OrdersCore } from '../shop/Orders';
import { ShopHome } from '../shop/Home';
import { AccountSummary } from '../shop/Account';
import { WalletView } from '../wallet/Wallet';
import { ShopHeader } from '../shop/Header';
import { useCart, useCartCount } from '../shop/cart';
import { useT } from '../shop/i18n';
import { ShopHost, useShopNav } from '../shop/nav';

type Tab = TabKey;
const ICON: Record<Tab, JSX.Element> = {
  home: <Home size={18} />, shop: <ShoppingBag size={18} />, cart: <ShoppingCart size={18} />, pay: <Wallet size={18} />, rewards: <Gift size={18} />, events: <Hash size={18} />, profile: <UserRound size={18} />,
};
/** The tabs of the built-in app (no published layout). Rewards and events are loyalty features of the staff-side prototype: a layout can still add them. */
const BUILT_IN: Tab[] = ['home', 'shop', 'cart', 'pay', 'profile'];
const NAV_KEY = { home: 'nav.home', shop: 'nav.shop', cart: 'nav.cart', pay: 'nav.orders', profile: 'nav.account' } as const;

export default function CustomerApp() {
  const db = useDB();
  const t = useT();
  const [tab, setTabRaw] = useState<Tab>('home');
  // Remember the last non-profile tab so feedback can say which part of the app it is about.
  const [lastArea, setLastArea] = useState<string>('home');
  const setTab = (x: Tab) => { if (x !== 'profile') setLastArea(x); setTabRaw(x); };

  // Everything customer-facing (catalogue, cart, orders, payments) belongs to the signed-in Supabase account. The local
  // store only mirrors it for the loyalty sections a layout may still place (member card, rewards, lucky draw).
  const { session, profile } = useAuth();
  const uid = session?.user.id ?? null;
  const lineMeta = session?.user.user_metadata as { line_user_id?: string; display_name?: string } | undefined;
  const lineId = lineMeta?.line_user_id;
  const isStaff = profile?.role === 'ADMIN' || profile?.role === 'SUPER_ADMIN';
  const needsSignup = !!lineId && !!profile && (!profile.phone || !profile.pdpa_consent_at);
  useEffect(() => { useCart.getState().hydrate(uid); }, [uid]);
  useEffect(() => { document.body.classList.add('customer-app'); return () => document.body.classList.remove('customer-app'); }, []);   // lets the shell put toasts where they do not cover the menu
  const [cid, setCid] = useState<ID | null>(null);
  const memberKey = lineId ?? (uid ? `account:${uid}` : null);
  useEffect(() => {
    if (!memberKey) return;
    const name = profile?.display_name || lineMeta?.display_name || profile?.email || 'Member';
    setCid(act((d, c) => linkLineMember(d, c, { lineUserId: memberKey, name, phone: profile?.phone ?? '' })));
  }, [memberKey, profile?.display_name, profile?.phone]); // eslint-disable-line react-hooks/exhaustive-deps
  const me = cid ? db.customers.find((c) => c.id === cid) : undefined;
  const fbNotes = useFeedbackNotifications(!!lineId && !needsSignup);
  const cartN = useCartCount();

  // DEV APP Customer: the published layout (or a staff preview via ?layout=<version id>). Without one, the built-in app is used.
  const [params] = useSearchParams();
  const { layout } = useCustomerLayout(CUSTOMER_APP_ID, params.get('layout'));
  const cfg = layout?.config ?? null;
  useLayoutFont(cfg);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const device = useDeviceOf(bodyEl);
  const navTabs = useMemo<[Tab, string][]>(() => (cfg
    ? cfg.nav.filter((n) => n.visible || ALWAYS_VISIBLE.includes(n.key)).map((n) => [n.key, n.label] as [Tab, string])
    : BUILT_IN.map((k) => [k, t(NAV_KEY[k as keyof typeof NAV_KEY])] as [Tab, string])), [cfg, t]);
  useEffect(() => { if (navTabs.length && !navTabs.some((x) => x[0] === tab)) setTab(navTabs[0][0]); }, [navTabs.map((x) => x[0]).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  // Intro pop-up: once per published version unless the member ticks "don't show again" (staff previews always show it).
  const introKey = layout && !layout.preview ? `bizops.intro.${CUSTOMER_APP_ID}.v${layout.versionNo}` : null;
  const [introOpen, setIntroOpen] = useState(false);
  useEffect(() => {
    let seen = false;
    try { seen = !!introKey && !!localStorage.getItem(introKey); } catch { /* ignore */ }
    setIntroOpen(!!cfg?.onboarding.enabled && cfg.onboarding.slides.length > 0 && !seen);
  }, [introKey, cfg?.onboarding.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  // Custom pages made in DEV APP open from links (buttons, banners, product cards…), optionally with the tapped record.
  const [custom, setCustom] = useState<{ id: string; record: Row | null } | null>(null);
  const goTab = useCallback((x: string) => { if (navTabs.some((n) => n[0] === x)) { setCustom(null); setTab(x as Tab); } }, [navTabs]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (target: string, record?: Row) => {
    const id = customId(target);
    if (id) { if (cfg?.customPages.some((p) => p.id === id)) setCustom({ id, record: record ?? null }); return; }
    // a product tapped in a layout's product list opens the real product page
    if (target === 'shop' && typeof record?.sku_code === 'string') useShopNav.getState().openProduct(record.sku_code);
    goTab(target);
  };
  const host = useMemo(() => ({ goTab: (x: string) => goTab(x) }), [goTab]);
  const customPage = custom && cfg ? cfg.customPages.find((p) => p.id === custom.id) : undefined;
  /** The tabs' built-in features, placed by the layout's core blocks. Same components as without a layout. */
  const core = (id: ID) => (c: CoreType) => {
    switch (c) {
      case 'shopCore': return <CatalogCore />;
      case 'cartCore': return <CartCore />;
      case 'payCore': return <OrdersCore />;
      case 'rewardsCore': return <RewardsTab id={id} />;
      case 'eventsCore': return <EventsTab id={id} />;
      case 'profileCore': return <ProfileCore showFeedback={!!lineId} lastArea={lastArea} notes={fbNotes} />;
    }
  };

  return (
    <ShopHost.Provider value={host}>
      <div className="standalone">
        <div className={cx('cust-wrap', isStaff && 'with-side')}>
          {isStaff && (
            <div className="col gap-16 hide-sm" style={{ maxWidth: 340 }}>
              <Link to="/" className="row gap-6"><ArrowLeft size={15} /> Back to the staff app</Link>
              <h1>Customer app</h1>
              <p className="text2">This is what a customer sees inside LINE: real products, a real cart and real orders. Orders you place here are real orders for your own account.</p>
            </div>
          )}
          <div className="phone shop-phone" style={cfg ? themeVars(cfg) : undefined}>
            {cfg ? <BrandHeader config={cfg} go={(x) => go(x)} /> : <ShopHeader />}
            {layout?.preview && <div style={{ background: 'var(--warn-soft)', color: 'var(--warn-text)', fontSize: 12, padding: '6px 12px' }}>Preview of layout v{layout.versionNo} ({layout.status}) — customers do not see this yet.</div>}
            {customPage && me && !needsSignup && <div className="ca-backbar"><button type="button" className="ca-hicon" onClick={() => setCustom(null)} aria-label="Back"><ArrowLeft size={16} /></button><b>{customPage.title}</b></div>}
            {needsSignup ? <div className="phone-body"><MemberForm mode="signup" /></div> : !me ? <div className="phone-body center"><div className="spinner" /></div> : (
              <>
                <div className="phone-body" role="region" aria-label="Customer app content" tabIndex={0} ref={setBodyEl}>
                  {cfg ? (
                    customPage
                      ? <LayoutPage key={'page:' + customPage.id + JSON.stringify(custom?.record ?? null)} config={cfg} sections={customPage.sections} device={device} customerId={me.id} go={go} core={core(me.id)} selected={custom?.record ?? null} />
                      : <LayoutPage key={tab} config={cfg} sections={pageSections(cfg, tab)} device={device} customerId={me.id} go={go} core={core(me.id)} />
                  ) : <>
                    {/* no published layout: the built-in app */}
                    {tab === 'home' && <ShopHome />}
                    {tab === 'shop' && <CatalogCore />}
                    {tab === 'cart' && <CartCore />}
                    {tab === 'pay' && <OrdersCore />}
                    {tab === 'profile' && core(me.id)('profileCore')}
                  </>}
                </div>
                <nav className={cx('phone-nav', cfg?.theme.navStyle === 'floating' && 'floating')} style={{ gridTemplateColumns: `repeat(${navTabs.length}, 1fr)` }} aria-label="Main">
                  {navTabs.map(([k, label]) => (
                    <button key={k} className={cx(tab === k && !customPage && 'on')} onClick={() => { setCustom(null); setTab(k); }} style={{ position: 'relative' }} aria-current={tab === k && !customPage ? 'page' : undefined}>
                      {ICON[k]}{label}
                      {k === 'cart' && cartN > 0 && <span className="sp-nav-badge" aria-label={`${cartN}`}>{cartN > 99 ? '99+' : cartN}</span>}
                      {k === 'profile' && fbNotes.unread > 0 && <span className="sp-nav-badge" aria-label={`${fbNotes.unread} new feedback updates`}>{fbNotes.unread}</span>}
                    </button>
                  ))}
                </nav>
              </>
            )}
            {cfg && introOpen && me && <OnboardingModal config={cfg} storageKey={introKey} onClose={() => setIntroOpen(false)} />}
          </div>
        </div>
      </div>
    </ShopHost.Provider>
  );
}

/** The Account tab: summary + shortcuts, the member's own details, and (LINE members) the feedback centre. */
function ProfileCore({ showFeedback, lastArea, notes }: { showFeedback: boolean; lastArea: string; notes: ReturnType<typeof useFeedbackNotifications> }) {
  // the wallet opens from the account card, or from "Add money" elsewhere (peek for the first render, consume in an effect: StrictMode-safe)
  const [inWallet, setInWallet] = useState(() => useShopNav.getState().pendingWallet);
  const pending = useShopNav((s) => s.pendingWallet);
  useEffect(() => { if (pending) { setInWallet(true); useShopNav.setState({ pendingWallet: false }); } }, [pending]);
  if (inWallet) return <WalletView onBack={() => setInWallet(false)} />;
  return (
    <>
      <AccountSummary onOpenWallet={() => setInWallet(true)} />
      <MemberForm mode="edit" />
      {showFeedback && <><hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} /><FeedbackCenter fromArea={lastArea} notes={notes} /></>}
    </>
  );
}

// First visit (mode "signup") and the profile tab (mode "edit"). Saved to Supabase profiles under RLS (a member can only
// update their own row); line_user_id/role are protected server-side.
function MemberForm({ mode }: { mode: 'signup' | 'edit' }) {
  const { session, profile, refreshProfile } = useAuth();
  const picture = (session?.user.user_metadata as { picture?: string } | undefined)?.picture;
  const [name, setName] = useState(profile?.display_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [consent, setConsent] = useState(!!profile?.pdpa_consent_at);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !profile) return;
    const digits = phone.replace(/\D/g, '');
    if (!name.trim()) return setErr('กรุณากรอกชื่อ');
    if (!/^0\d{8,9}$/.test(digits)) return setErr('กรุณากรอกเบอร์โทรให้ถูกต้อง เช่น 0812345678');
    if (!consent) return setErr('กรุณายอมรับนโยบายข้อมูลส่วนบุคคล');
    setBusy(true); setErr(null); setSaved(false);
    const patch: Record<string, string> = { display_name: name.trim(), phone: digits };
    if (!profile.pdpa_consent_at) patch.pdpa_consent_at = new Date().toISOString();
    const { error } = await supabase.from('profiles').update(patch).eq('id', profile.id);
    if (error) { setBusy(false); return setErr(error.message); }
    await refreshProfile();
    setBusy(false); setSaved(true);
  };

  return (
    <form onSubmit={submit} className="col gap-12">
      <div className="center" style={{ padding: '8px 0 4px' }}>
        {mode === 'signup' && (picture ? <img src={picture} alt="" width={72} height={72} style={{ borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ fontSize: 40 }}>☕</div>)}
        <h2 style={{ marginTop: 8 }}>{mode === 'signup' ? 'ยินดีต้อนรับสมาชิกใหม่' : 'ข้อมูลของฉัน'}</h2>
        {mode === 'signup' && <div className="muted" style={{ fontSize: 13 }}>กรอกข้อมูลครั้งเดียว แล้วสั่งซื้อและติดตามคำสั่งซื้อได้เลย</div>}
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      {saved && mode === 'edit' && <Banner tone="good">บันทึกแล้ว</Banner>}
      <Field label="ชื่อ"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} required /></Field>
      <Field label="เบอร์โทร" hint="ใช้ติดต่อเรื่องคำสั่งซื้อและค้นหาสมาชิกที่ร้าน"><Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="numeric" autoComplete="tel" placeholder="08xxxxxxxx" maxLength={12} required /></Field>
      {!profile?.pdpa_consent_at && (
        <label className="row gap-6" style={{ alignItems: 'flex-start', fontSize: 13 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
          <span>ยินยอมให้ร้านเก็บชื่อ เบอร์โทร และบัญชี LINE เพื่อใช้ในการสั่งซื้อ จัดส่ง และระบบสมาชิก ตามนโยบายคุ้มครองข้อมูลส่วนบุคคล (PDPA)</span>
        </label>
      )}
      <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy}>{mode === 'signup' ? 'สมัครสมาชิก' : 'บันทึก'}</Button>
    </form>
  );
}

export function RewardsTab({ id }: { id: ID }) {
  const db = useDB();
  const pts = pointsBalance(db, id);
  const [last, setLast] = useState<string | null>(null);
  const mine = db.rewardRedemptions.filter((r) => r.customerId === id).slice().reverse();
  return (
    <>
      <div className="row between"><h2>Rewards</h2><Badge tone="info">{pts.toLocaleString()} pts</Badge></div>
      {last && <Banner tone="good">Redeemed! Your code: <b className="mono">{last}</b></Banner>}
      {db.rewards.filter((r) => r.active).map((r) => (
        <div key={r.id} className="row card card-b">
          <span style={{ fontSize: 28 }}>{r.emoji}</span><div className="grow"><b>{r.name}</b><div className="muted" style={{ fontSize: 12 }}>{r.cost} pts{r.stock != null ? ` · ${r.stock} left` : ''}</div></div>
          <Button size="sm" variant="primary" disabled={pts < r.cost || r.stock === 0} onClick={() => { try { const rid = act((d, c) => redeemReward(d, c, { customerId: id, rewardId: r.id, idempotencyKey: `${id}-${r.id}-${Date.now()}` })); setLast(useStore.getState().db.rewardRedemptions.find((x) => x.id === rid)?.code ?? ''); } catch (e) { toast('error', (e as Error).message); } }}>Redeem</Button>
        </div>
      ))}
      {!db.rewards.some((r) => r.active) && <Empty title="No rewards yet" />}
      {mine.length > 0 && <Card title="My redemptions">{mine.slice(0, 6).map((r) => <div key={r.id} className="row between" style={{ fontSize: 13, padding: '3px 0' }}><span>{db.rewards.find((x) => x.id === r.rewardId)?.name} <span className="muted">{dateFmt(r.ts)}</span></span><span className="row gap-6"><span className="mono">{r.code}</span><Badge tone={r.status === 'issued' ? 'warn' : r.status === 'fulfilled' ? 'good' : 'bad'}>{r.status}</Badge></span></div>)}</Card>}
    </>
  );
}

export function EventsTab({ id }: { id: ID }) {
  const db = useDB();
  useTicker(1000);
  const ev = db.events.find((e) => e.status === 'active') ?? db.events[db.events.length - 1];
  const [bid, setBid] = useState<ID>('');
  if (!ev) return <Empty title="No events" />;
  const board = ev.boards.find((b) => b.id === bid) ?? ev.boards[0];
  const nowIso = new Date().toISOString();
  const occ = occupancy(db, ev.id, board.id, nowIso);
  const ents = availableEntitlements(db, id, ev.id);
  const mine = db.selections.filter((s) => s.eventId === ev.id && s.customerId === id && (s.status === 'confirmed' || s.status === 'reserved')).slice().reverse();
  const reserved = mine.find((s) => s.status === 'reserved' && s.reservedUntil && s.reservedUntil > nowIso);
  const secs = reserved ? Math.max(0, Math.round((new Date(reserved.reservedUntil!).getTime() - Date.now()) / 1000)) : 0;
  const tap = (n: number) => {
    if (occ[n]) return;
    if (ev.status !== 'active') { toast('error', `Event is ${ev.status}`); return; }
    if (!ents.length) { toast('error', 'You have no picks left. Earn one with every ฿500 spent.'); return; }
    try { act((d, c) => claimNumber(d, c, { eventId: ev.id, boardId: board.id, number: n, customerId: id, confirm: false })); toast('info', `#${pad2(n)} reserved for ${ev.reservationMinutes} minutes — confirm to lock it`); } catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <>
      <div><h2>{ev.name.replace(' – ', ' · ')}</h2><div className="muted" style={{ fontSize: 12.5 }}>{ev.description}</div></div>
      <div className="row between card card-b"><span>Your picks left</span><b style={{ fontSize: 22 }}>{ents.length}</b></div>
      {reserved && (
        <Banner tone="warn"><div><b>Reserved {ev.boards.find((b) => b.id === reserved.boardId)?.name} #{pad2(reserved.number)}</b> — {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')} left</div>
          <div className="row mt8"><Button size="sm" variant="primary" onClick={() => { try { act((d, c) => confirmSelection(d, c, reserved.id)); toast('success', 'Number locked in!'); } catch (e) { toast('error', (e as Error).message); } }}>Confirm</Button><Button size="sm" onClick={() => { try { act((d, c) => releaseSelection(d, c, reserved.id, 'Cancelled by customer')); } catch (e) { toast('error', (e as Error).message); } }}><X size={13} /> Cancel</Button></div></Banner>
      )}
      <div className="seg">{ev.boards.map((b) => <button key={b.id} className={cx(board.id === b.id && 'on')} onClick={() => setBid(b.id)}>{b.name}</button>)}</div>
      <div className="number-grid">
        {Array.from({ length: ev.max - ev.min + 1 }, (_, i) => ev.min + i).map((n) => { const s = occ[n]; const isMine = s?.customerId === id; return <button key={n} className={cx('num-cell', s && !isMine && 'taken', isMine && s?.status === 'confirmed' && 'mine', isMine && s?.status === 'reserved' && 'reserved')} onClick={() => tap(n)} disabled={!!s} aria-label={`Number ${pad2(n)}`}>{pad2(n)}</button>; })}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Greyed numbers are taken. Blue numbers are yours. Numbers are first-come, first-served — the system never lets two people hold the same number.</div>
      {mine.filter((s) => s.status === 'confirmed').length > 0 && <Card title="My numbers">{mine.filter((s) => s.status === 'confirmed').map((s) => <div key={s.id} className="row between" style={{ padding: '3px 0' }}><b>{ev.boards.find((b) => b.id === s.boardId)?.name} #{pad2(s.number)}</b><span className="muted">{dateFmt(s.confirmedAt)}</span></div>)}</Card>}
      <div className="muted" style={{ fontSize: 11.5 }}>{ev.terms}</div>
    </>
  );
}
