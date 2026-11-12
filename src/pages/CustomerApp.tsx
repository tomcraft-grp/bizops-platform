import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Gift, Hash, Home, Minus, Plus, ShoppingBag, Wallet, X } from 'lucide-react';
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

type Tab = 'home' | 'shop' | 'rewards' | 'pay' | 'events';

export default function CustomerApp() {
  const db = useDB();
  const [cid, setCid] = useState<ID | null>(() => { try { return sessionStorage.getItem('bizops.cust'); } catch { return null; } });
  const [tab, setTab] = useState<Tab>('home');
  const login = (id: ID | null) => { setCid(id); try { if (id) sessionStorage.setItem('bizops.cust', id); else sessionStorage.removeItem('bizops.cust'); } catch { /* ignore */ } };
  const me = cid ? db.customers.find((c) => c.id === cid) : undefined;
  return (
    <div className="standalone">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 340px) auto', gap: 40, alignItems: 'center', maxWidth: 860, width: '100%' }} className="cust-wrap">
        <div className="col gap-16 hide-sm" style={{ maxWidth: 340 }}>
          <Link to="/" className="row gap-6"><ArrowLeft size={15} /> Back to the staff app</Link>
          <h1>Customer app (LINE LIFF)</h1>
          <p className="text2">This is what a customer sees inside LINE. It runs on the same data as the staff app: redeem a reward, pay an invoice with a slip, order from the LINE shop and pick lucky-draw numbers — then watch the staff side react.</p>
          <Banner>LINE Login is simulated. In production the LIFF app authenticates the customer with their LINE account and links it to this customer record.</Banner>
          {me && <Button onClick={() => login(null)}>Sign out / switch customer</Button>}
        </div>
        <div className="phone">
          <div className="phone-top"><b>{db.org.name.split(' ')[0]} ☕</b><span style={{ fontSize: 12, opacity: 0.9 }}>LINE</span></div>
          {!me ? <Login onPick={login} /> : (
            <>
              <div className="phone-body" role="region" aria-label="Customer app content" tabIndex={0}>
                {tab === 'home' && <HomeTab id={me.id} go={setTab} />}
                {tab === 'shop' && <ShopTab id={me.id} go={setTab} />}
                {tab === 'rewards' && <RewardsTab id={me.id} />}
                {tab === 'pay' && <PayTab id={me.id} />}
                {tab === 'events' && <EventsTab id={me.id} />}
              </div>
              <nav className="phone-nav">
                {([['home', <Home size={18} key="h" />, 'Home'], ['shop', <ShoppingBag size={18} key="s" />, 'Shop'], ['rewards', <Gift size={18} key="r" />, 'Rewards'], ['pay', <Wallet size={18} key="p" />, 'Pay'], ['events', <Hash size={18} key="e" />, 'Events']] as [Tab, JSX.Element, string][]).map(([k, i, l]) => <button key={k} className={cx(tab === k && 'on')} onClick={() => setTab(k)}>{i}{l}</button>)}
              </nav>
            </>
          )}
        </div>
      </div>
      <style>{`@media (max-width: 900px){.cust-wrap{grid-template-columns:1fr !important}} @media (max-width:560px){.phone{border:0;border-radius:0;height:100vh;max-height:none;width:100vw}.standalone{padding:0}}`}</style>
    </div>
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

function HomeTab({ id, go }: { id: ID; go: (t: Tab) => void }) {
  const db = useDB();
  const c = db.customers.find((x) => x.id === id)!;
  const spend = customerLifetimeSpend(db, id);
  const tier = tierFor(db, spend);
  const next = [...db.loyalty.tiers].sort((a, b) => a.minSpend - b.minSpend).find((t) => t.minSpend > spend);
  const pts = pointsBalance(db, id);
  const exp = expiringSoon(db, id, new Date().toISOString());
  const coupons = db.coupons.filter((x) => x.customerId === id && x.status === 'issued' && x.expiresAt > new Date().toISOString());
  const promos = db.promotions.filter((p) => effectiveStatus(p, new Date().toISOString()) === 'active' && !p.code && (!p.channels.length || p.channels.includes('LINE') || p.channels.includes('POS'))).slice(0, 4);
  const out = customerOutstanding(db, id);
  return (
    <>
      <div className="cust-card">
        <div className="row between"><div><div style={{ opacity: 0.8, fontSize: 12 }}>Member</div><div style={{ fontSize: 18, fontWeight: 700 }}>{c.name}</div></div><span style={{ background: 'rgba(255,255,255,.2)', padding: '3px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12 }}>{tier.name}</span></div>
        <div style={{ fontSize: 34, fontWeight: 750, marginTop: 10 }}>{pts.toLocaleString()} <span style={{ fontSize: 14, fontWeight: 500 }}>points</span></div>
        {exp > 0 && <div style={{ fontSize: 12, opacity: 0.9 }}>{exp} points expire within 60 days</div>}
        {next && <div style={{ marginTop: 10 }}><div style={{ fontSize: 12, opacity: 0.9 }}>{money0(next.minSpend - spend)} more to reach {next.name}</div><div className="progress" style={{ background: 'rgba(255,255,255,.25)', marginTop: 4 }}><i style={{ width: `${Math.min(100, (spend / next.minSpend) * 100)}%`, background: '#fff' }} /></div></div>}
        <div className="row mt16" style={{ justifyContent: 'center' }}><QR data={`MEMBER|${c.code}`} size={96} /></div>
      </div>
      {out > 0 && <Banner tone="warn">You have an outstanding balance of <b>{money(out)}</b>. <a onClick={() => go('pay')} style={{ cursor: 'pointer' }}>Pay now</a></Banner>}
      {coupons.length > 0 && <Card title="My coupons">{coupons.map((x) => <div key={x.id} className="row between" style={{ padding: '4px 0' }}><span>{x.title}</span><span className="mono">{x.code}</span></div>)}<div className="muted" style={{ fontSize: 12 }}>Show the code at the counter or enter it at checkout.</div></Card>}
      <Card title="Offers for you">{promos.map((p) => <div key={p.id} style={{ padding: '5px 0' }}><b>{p.name}</b><div className="muted" style={{ fontSize: 12.5 }}>{p.description}</div></div>)}</Card>
    </>
  );
}

function ShopTab({ id, go }: { id: ID; go: (t: Tab) => void }) {
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

function RewardsTab({ id }: { id: ID }) {
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

function PayTab({ id }: { id: ID }) {
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

function EventsTab({ id }: { id: ID }) {
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
