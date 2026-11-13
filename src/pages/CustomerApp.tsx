import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BrandHeader, CouponsSection, LayoutHome, MemberCardSection, OffersSection, OnboardingModal, OutstandingSection, themeVars, useDeviceOf, useLayoutFont } from '../devapp/render';
import { CUSTOMER_APP_ID, useCustomerLayout } from '../devapp/useCustomerLayout';
import { ArrowLeft, Gift, Hash, Home, Minus, Plus, ShoppingBag, UserRound, Wallet, X } from 'lucide-react';
import { useDB, useStore, toast, act } from '../domain/store';
import { customerLifetimeSpend, expiringSoon, pointsBalance, redeemReward, tierFor } from '../domain/loyalty';
import { allocatedMap, customerCredit, customerOutstanding, orderBalance, outstandingOrders, submitSlip } from '../domain/payments';
import { availableEntitlements, claimNumber, confirmSelection, occupancy, pad2, releaseSelection } from '../domain/events';
import { createOrder, quoteOrder } from '../domain/orders';
import { effectiveStatus } from '../domain/promotions';
import { Badge, Banner, Button, Card, Empty, Field, Input, NumInput } from '../ui/kit';
import { ProductEmoji, QR } from '../ui/shared';
import { uploadMedia } from '../ui/upload';
import { useTicker } from '../ui/data';
import { promptPayPayload } from '../lib/promptpay';
import { cx, dateFmt, dateTimeFmt, dayKey, money, money0, r2 } from '../lib/util';
import type { ID } from '../domain/types';
import { STATUS_LABEL } from '../domain/meta';
import { linkLineMember } from '../domain/master';
import { useAuth } from '../auth/AuthProvider';
import { supabase } from '../lib/supabase';
import FeedbackCenter, { useFeedbackNotifications } from './customer/FeedbackCenter';

type Tab = 'home' | 'shop' | 'rewards' | 'pay' | 'events' | 'profile';

export default function CustomerApp() {
  const db = useDB();
  const [cid, setCid] = useState<ID | null>(() => { try { return sessionStorage.getItem('bizops.cust'); } catch { return null; } });
  const [tab, setTabRaw] = useState<Tab>('home');
  // Remember the last non-profile tab so feedback can say which part of the app it is about.
  const [lastArea, setLastArea] = useState<string>('home');
  const setTab = (t: Tab) => { if (t !== 'profile') setLastArea(t); setTabRaw(t); };
  const login = (id: ID | null) => { setCid(id); try { if (id) sessionStorage.setItem('bizops.cust', id); else sessionStorage.removeItem('bizops.cust'); } catch { /* ignore */ } };
  const me = cid ? db.customers.find((c) => c.id === cid) : undefined;

  // Signed in with LINE (see lib/liff.ts): skip the simulated customer picker and open this LINE account's
  // own member record, creating it on first visit. Customer data itself is still the local prototype store.
  // The member's name/phone live in Supabase (profiles) and are mirrored onto the local record.
  const { session, profile } = useAuth();
  const lineMeta = session?.user.user_metadata as { line_user_id?: string; display_name?: string } | undefined;
  const lineId = lineMeta?.line_user_id;
  const needsSignup = !!lineId && !!profile && (!profile.phone || !profile.pdpa_consent_at);
  useEffect(() => {
    if (!lineId) return;
    const name = profile?.display_name || lineMeta?.display_name || 'LINE member';
    const phone = profile?.phone ?? '';
    const id = act((d, c) => linkLineMember(d, c, { lineUserId: lineId, name, phone }));
    if (id !== cid) login(id);
  }, [lineId, profile?.display_name, profile?.phone]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: [Tab, JSX.Element, string][] = [['home', <Home size={18} key="h" />, 'Home'], ['shop', <ShoppingBag size={18} key="s" />, 'Shop'], ['rewards', <Gift size={18} key="r" />, 'Rewards'], ['pay', <Wallet size={18} key="p" />, 'Pay'], ['events', <Hash size={18} key="e" />, 'Events']];
  if (lineId) tabs.push(['profile', <UserRound size={18} key="u" />, 'โปรไฟล์']);
  const fbNotes = useFeedbackNotifications(!!lineId && !needsSignup);

  // DEV APP Customer: the published layout (or a staff preview via ?layout=<version id>). Without one, the
  // built-in layout below is used unchanged.
  const [params] = useSearchParams();
  const { layout } = useCustomerLayout(CUSTOMER_APP_ID, params.get('layout'));
  const cfg = layout?.config ?? null;
  useLayoutFont(cfg);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const device = useDeviceOf(bodyEl);
  const navTabs = cfg ? cfg.nav.filter((n) => n.visible || n.key === 'home' || n.key === 'profile').flatMap((n) => { const t = tabs.find((x) => x[0] === n.key); return t ? [[t[0], t[1], n.label] as [Tab, JSX.Element, string]] : []; }) : tabs;
  useEffect(() => { if (navTabs.length && !navTabs.some((t) => t[0] === tab)) setTab(navTabs[0][0]); }, [navTabs.map((t) => t[0]).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  // Intro pop-up: once per published version unless the member ticks "don't show again" (staff previews always show it).
  const introKey = layout && !layout.preview ? `bizops.intro.${CUSTOMER_APP_ID}.v${layout.versionNo}` : null;
  const [introOpen, setIntroOpen] = useState(false);
  useEffect(() => {
    let seen = false;
    try { seen = !!introKey && !!localStorage.getItem(introKey); } catch { /* ignore */ }
    setIntroOpen(!!cfg?.onboarding.enabled && cfg.onboarding.slides.length > 0 && !seen);
  }, [introKey, cfg?.onboarding.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const goTab = (t: string) => { if (navTabs.some((x) => x[0] === t)) setTab(t as Tab); };

  return (
    <div className="standalone">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 340px) auto', gap: 40, alignItems: 'center', maxWidth: 860, width: '100%' }} className="cust-wrap">
        <div className="col gap-16 hide-sm" style={{ maxWidth: 340 }}>
          <Link to="/" className="row gap-6"><ArrowLeft size={15} /> Back to the staff app</Link>
          <h1>Customer app (LINE LIFF)</h1>
          <p className="text2">This is what a customer sees inside LINE. It runs on the same data as the staff app: redeem a reward, pay an invoice with a slip, order from the LINE shop and pick lucky-draw numbers — then watch the staff side react.</p>
          <Banner>LINE Login is simulated. In production the LIFF app authenticates the customer with their LINE account and links it to this customer record.</Banner>
          {me && !lineId && <Button onClick={() => login(null)}>Sign out / switch customer</Button>}
        </div>
        <div className="phone" style={cfg ? themeVars(cfg) : undefined}>
          {cfg ? <BrandHeader config={cfg} go={goTab} /> : <div className="phone-top"><b>{db.org.name.split(' ')[0]} ☕</b><span style={{ fontSize: 12, opacity: 0.9 }}>LINE</span></div>}
          {layout?.preview && <div style={{ background: 'var(--warn-soft)', color: 'var(--warn-text)', fontSize: 12, padding: '6px 12px' }}>Preview of layout v{layout.versionNo} ({layout.status}) — customers do not see this yet.</div>}
          {needsSignup ? <div className="phone-body"><MemberForm mode="signup" /></div> : !me ? (lineId ? <div className="phone-body center"><div className="spinner" /></div> : <Login onPick={login} />) : (
            <>
              <div className="phone-body" role="region" aria-label="Customer app content" tabIndex={0} ref={setBodyEl}>
                {tab === 'home' && (cfg ? <LayoutHome config={cfg} device={device} customerId={me.id} go={setTab} /> : <HomeTab id={me.id} go={setTab} />)}
                {tab === 'shop' && <ShopTab id={me.id} go={setTab} />}
                {tab === 'rewards' && <RewardsTab id={me.id} />}
                {tab === 'pay' && <PayTab id={me.id} />}
                {tab === 'events' && <EventsTab id={me.id} />}
                {tab === 'profile' && lineId && <><MemberForm mode="edit" /><hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} /><FeedbackCenter fromArea={lastArea} notes={fbNotes} /></>}
              </div>
              <nav className={cx('phone-nav', cfg?.theme.navStyle === 'floating' && 'floating')} style={{ gridTemplateColumns: `repeat(${navTabs.length}, 1fr)` }}>
                {navTabs.map(([k, i, l]) => (
                  <button key={k} className={cx(tab === k && 'on')} onClick={() => setTab(k)} style={{ position: 'relative' }}>
                    {i}{l}
                    {k === 'profile' && fbNotes.unread > 0 && <span aria-label={`${fbNotes.unread} new feedback updates`} style={{ position: 'absolute', top: 4, right: '50%', marginRight: -16, minWidth: 16, height: 16, borderRadius: 8, background: 'var(--crit, #d92d20)', color: '#fff', fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>{fbNotes.unread}</span>}
                  </button>
                ))}
              </nav>
            </>
          )}
          {cfg && introOpen && me && <OnboardingModal config={cfg} storageKey={introKey} onClose={() => setIntroOpen(false)} />}
        </div>
      </div>
      <style>{`@media (max-width: 900px){.cust-wrap{grid-template-columns:1fr !important}} @media (max-width:560px){.phone{border:0;border-radius:0;height:100vh;max-height:none;width:100vw}.standalone{padding:0}}`}</style>
    </div>
  );
}

// First visit (mode "signup") and the profile tab (mode "edit") for LINE members. Saved to Supabase
// profiles under RLS (a member can only update their own row); line_user_id/role are protected server-side.
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
        {picture ? <img src={picture} alt="" width={72} height={72} style={{ borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ fontSize: 40 }}>☕</div>}
        <h2 style={{ marginTop: 8 }}>{mode === 'signup' ? 'ยินดีต้อนรับสมาชิกใหม่' : 'โปรไฟล์ของฉัน'}</h2>
        {mode === 'signup' && <div className="muted" style={{ fontSize: 13 }}>กรอกข้อมูลครั้งเดียว แล้วใช้บัตรสมาชิกได้เลย</div>}
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      {saved && mode === 'edit' && <Banner tone="good">บันทึกแล้ว</Banner>}
      <Field label="ชื่อ"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} required /></Field>
      <Field label="เบอร์โทร" hint="ใช้ค้นหาสมาชิกตอนสะสมแต้มที่ร้าน"><Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="numeric" autoComplete="tel" placeholder="08xxxxxxxx" maxLength={12} required /></Field>
      {!profile?.pdpa_consent_at && (
        <label className="row gap-6" style={{ alignItems: 'flex-start', fontSize: 13 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
          <span>ยินยอมให้ร้านเก็บชื่อ เบอร์โทร และบัญชี LINE เพื่อใช้ในระบบสมาชิกและสะสมแต้ม ตามนโยบายคุ้มครองข้อมูลส่วนบุคคล (PDPA)</span>
        </label>
      )}
      <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy}>{mode === 'signup' ? 'สมัครสมาชิก' : 'บันทึก'}</Button>
    </form>
  );
}

function Login({ onPick }: { onPick: (id: ID) => void }) {
  const db = useDB();
  return (
    <div className="phone-body" role="region" aria-label="Customer app content" tabIndex={0}>
      <div className="center" style={{ padding: '20px 0 6px' }}><div style={{ fontSize: 40 }}>☕</div><h2>Welcome</h2><div className="muted">Sign in with LINE (simulated)</div></div>
      <div className="col gap-4" style={{ overflow: 'auto' }}>
        {db.customers.filter((c) => c.group !== 'staff').slice(0, 30).map((c) => (
          <button key={c.id} className="menu-item" onClick={() => onPick(c.id)}><span className="avatar" style={{ background: '#047a3b', color: '#fff' }}>{c.name[0]}</span><div className="grow"><div style={{ fontWeight: 600 }}>{c.name}</div><div className="muted" style={{ fontSize: 12 }}>{c.group === 'wholesale' ? 'Wholesale account' : `${pointsBalance(db, c.id)} pts`}</div></div></button>
        ))}
      </div>
    </div>
  );
}

// The built-in Home layout (used when no DEV APP layout is published). Same sections, same order, same markup as
// before; the sections now live in devapp/render.tsx so a configured layout can reuse and rearrange them.
function HomeTab({ id, go }: { id: ID; go: (t: Tab) => void }) {
  return (
    <>
      <MemberCardSection id={id} />
      <OutstandingSection id={id} go={go} />
      <CouponsSection id={id} />
      <OffersSection />
    </>
  );
}

export function ShopTab({ id, go }: { id: ID; go: (t: Tab) => void }) {
  const db = useDB();
  const c = db.customers.find((x) => x.id === id)!;
  const items = db.products.filter((p) => p.active && ['finished', 'resale'].includes(p.kind) && (p.channelPrices.LINE ?? p.price) > 0);
  const [cart, setCart] = useState<Record<ID, number>>({});
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([productId, qty]) => ({ productId, qty }));
  const q = useMemo(() => (lines.length ? quoteOrder(db, { channel: 'LINE', branchId: 'B3', customerId: id, lines, now: new Date().toISOString() }) : null), [db, cart, id]); // eslint-disable-line
  const [done, setDone] = useState<string | null>(null);
  const place = () => {
    try {
      const oid = act((d, ctx) => createOrder(d, ctx, { channel: 'LINE', branchId: 'B3', customerId: id, lines, payLater: c.group === 'wholesale', idempotencyKey: `liff-${Date.now()}`, shipping: { recipient: c.name, address: c.address ?? 'Bangkok' } }));
      setDone(db.orders.find((o) => o.id === oid)?.no ?? 'order'); setCart({});
      toast('success', 'Order placed — the shop will confirm it');
    } catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <>
      <h2>LINE shop</h2>
      {done && <Banner tone="good">Order placed. <a onClick={() => go('pay')} style={{ cursor: 'pointer' }}>Go to Pay</a> to settle it{c.group === 'wholesale' ? ' (or pay within your credit terms)' : ''}.</Banner>}
      {items.map((p) => {
        const price = p.channelPrices.LINE ?? p.price;
        const stock = Object.entries(db.balances).filter(([k]) => k.endsWith('|' + p.id) && k.startsWith('W3')).reduce((s, [, b]) => s + b.qty, 0);
        return (
          <div key={p.id} className="row card card-b">
            <ProductEmoji p={p} size={44} /><div className="grow"><b>{p.name}</b><div className="muted" style={{ fontSize: 12 }}>{money(price)} · {stock > 0 ? `${Math.floor(stock)} in stock` : 'sold out'}</div></div>
            <div className="qty"><button onClick={() => setCart({ ...cart, [p.id]: Math.max(0, (cart[p.id] || 0) - 1) })}><Minus size={13} /></button><span>{cart[p.id] || 0}</span><button disabled={stock <= (cart[p.id] || 0)} onClick={() => setCart({ ...cart, [p.id]: (cart[p.id] || 0) + 1 })}><Plus size={13} /></button></div>
          </div>
        );
      })}
      {q && (
        <div className="card card-b" style={{ position: 'sticky', bottom: 0, background: 'var(--surface)' }}>
          {q.applied.filter((a) => a.discount > 0).map((a) => <div key={a.promoId} className="row between good" style={{ fontSize: 13 }}><span>{a.name}</span><span>−{money(a.discount)}</span></div>)}
          <div className="row between" style={{ fontSize: 18 }}><b>Total</b><b>{money(q.total)}</b></div>
          <Button variant="primary" className="block mt8" onClick={place}>Place order</Button>
        </div>
      )}
    </>
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
      {mine.length > 0 && <Card title="My redemptions">{mine.slice(0, 6).map((r) => <div key={r.id} className="row between" style={{ fontSize: 13, padding: '3px 0' }}><span>{db.rewards.find((x) => x.id === r.rewardId)?.name} <span className="muted">{dateFmt(r.ts)}</span></span><span className="row gap-6"><span className="mono">{r.code}</span><Badge tone={r.status === 'issued' ? 'warn' : r.status === 'fulfilled' ? 'good' : 'bad'}>{r.status}</Badge></span></div>)}</Card>}
    </>
  );
}

export function PayTab({ id }: { id: ID }) {
  const db = useDB();
  const alloc = useMemo(() => allocatedMap(db), [db.allocations]);
  const open = outstandingOrders(db, id, alloc);
  const owing = r2(open.reduce((s, x) => s + x.balance, 0));
  const credit = customerCredit(db, id);
  const [amount, setAmount] = useState<number>(owing);
  const [ref, setRef] = useState('');
  const [sel, setSel] = useState<Record<ID, boolean>>({});
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const slips = db.slips.filter((s) => s.customerId === id).slice().reverse();
  const c = db.customers.find((x) => x.id === id)!;
  const chosen = open.filter((x) => sel[x.order.id]);
  const submit = async (f: File | null) => {
    if (!f) return;
    setBusy(true);
    try {
      const mediaId = await uploadMedia(f, 'payment_slip', { type: 'slip' }, { private: true });
      const media = useStore.getState().db.media.find((m) => m.id === mediaId)!;
      act((d, ctx) => submitSlip(d, ctx, { customerId: id, amount, orderIds: chosen.map((x) => x.order.id), reference: ref || undefined, mediaId, checksum: media.checksum }));
      toast('success', 'Slip sent — the shop will verify it shortly');
      setRef('');
    } catch (e) { toast('error', (e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <h2>Pay & statement</h2>
      <div className="grid g2" style={{ gap: 10 }}>
        <div className="card card-b"><div className="muted" style={{ fontSize: 12 }}>You owe</div><b style={{ fontSize: 22 }} className={owing > 0 ? 'bad' : 'good'}>{money(owing)}</b></div>
        <div className="card card-b"><div className="muted" style={{ fontSize: 12 }}>Credit</div><b style={{ fontSize: 22 }}>{money(credit)}</b></div>
      </div>
      {open.length === 0 ? <Empty title="Nothing to pay" hint="You are all settled." /> : (
        <>
          <Card title="Open invoices">
            {open.map((x) => <label key={x.order.id} className="row between check" style={{ padding: '5px 0', width: '100%' }}><span className="row gap-6"><input type="checkbox" checked={!!sel[x.order.id]} onChange={(e) => { const s = { ...sel, [x.order.id]: e.target.checked }; setSel(s); const t = open.filter((o) => s[o.order.id]).reduce((a, o) => a + o.balance, 0); setAmount(r2(t || owing)); }} /> {x.order.no} <span className="muted">{dateFmt(x.order.createdAt)}</span></span><b>{money(x.balance)}</b></label>)}
          </Card>
          <Card title="Pay by PromptPay">
            <div className="row" style={{ justifyContent: 'center' }}><QR data={promptPayPayload(db.org.promptPayId, amount)} size={150} /></div>
            <div className="center muted" style={{ fontSize: 12 }}>Scan with your banking app · {money(amount)}</div>
          </Card>
          <Card title="Upload your transfer slip">
            <div className="col">
              <Field label="Amount transferred"><NumInput value={amount} onChange={(n) => setAmount(n || 0)} /></Field>
              <Field label="Reference (optional)"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
              <input ref={file} type="file" hidden accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; void submit(f); }} />
              <Button variant="primary" onClick={() => file.current?.click()} disabled={busy || !(amount > 0)}>{busy ? 'Uploading…' : 'Take photo / choose image'}</Button>
              <div className="muted" style={{ fontSize: 12 }}>The shop checks the slip against its bank statement before your balance is updated. Uploading a slip is not a confirmation of payment.</div>
            </div>
          </Card>
        </>
      )}
      {slips.length > 0 && <Card title="My slips">{slips.slice(0, 6).map((s) => <div key={s.id} className="row between" style={{ fontSize: 13, padding: '3px 0' }}><span>{money(s.amount)} <span className="muted">{dateTimeFmt(s.createdAt)}</span>{s.rejectReason && <div className="bad" style={{ fontSize: 12 }}>{s.rejectReason}</div>}</span><Badge tone={s.status === 'approved' ? 'good' : s.status === 'rejected' ? 'bad' : 'warn'} dot>{s.status}</Badge></div>)}</Card>}
      <Card title="My orders">{db.orders.filter((o) => o.customerId === id && o.collectedBy === 'merchant').slice(-6).reverse().map((o) => <div key={o.id} className="row between" style={{ fontSize: 13, padding: '3px 0' }}><span>{o.no} <span className="muted">{dateFmt(o.createdAt)} · {STATUS_LABEL[o.status]}</span></span><span>{money(o.total)} {orderBalance(o, alloc[o.id] || 0) > 0.004 ? <Badge tone="warn">due</Badge> : <Badge tone="good">paid</Badge>}</span></div>)}{c.creditLimit > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Credit limit {money0(c.creditLimit)} · {c.creditDays} days</div>}</Card>
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
export const _ca = [dayKey];
