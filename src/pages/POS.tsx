import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Check, CreditCard, Gift, Minus, Pause, Percent, Play, Plus, QrCode, Tag, Trash2, UserRound, X, Landmark, MoreHorizontal, Receipt } from 'lucide-react';
import { useDB } from '../domain/store';
import { createOrder, quoteOrder, NewOrderLine } from '../domain/orders';
import { onHand } from '../domain/inventory';
import { servingsPossible } from '../domain/master';
import { PAY_METHODS } from '../domain/meta';
import { customerCredit, customerOutstanding } from '../domain/payments';
import { Badge, Banner, Button, Empty, Field, Input, Modal, NumInput, PageHead, SearchBox, useHas, useRun, useUser } from '../ui/kit';
import { CustomerPicker, CustomerSummary, DocPreview, PrintModal, ProductEmoji, QR } from '../ui/shared';
import { renderDoc } from '../domain/printing';
import { cx, money, qtyFmt, r2 } from '../lib/util';
import { promptPayPayload } from '../lib/promptpay';
import type { ID, PayMethod, Product } from '../domain/types';

interface CartLine { key: string; productId: ID; qty: number; modifiers: { group: string; option: string }[]; note?: string }
interface Pay { method: PayMethod; amount: number; reference?: string }
const METHOD_ICON: Record<string, React.ReactNode> = { cash: <Banknote size={16} />, qr: <QrCode size={16} />, card: <CreditCard size={16} />, transfer: <Landmark size={16} />, other: <MoreHorizontal size={16} /> };

export default function POS() {
  const db = useDB();
  const user = useUser();
  const run = useRun();
  const canCharge = useHas('pos:create');
  const canDiscount = useHas('pos:discount');
  const branches = db.branches.filter((b) => b.type !== 'online' && (!user.branchIds.length || user.branchIds.includes(b.id)));
  const [branchId, setBranchId] = useState(branches[0]?.id ?? 'B1');
  const branch = db.branches.find((b) => b.id === branchId)!;
  const wh = branch.defaultWarehouseId;
  const [cat, setCat] = useState('All');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState<ID | undefined>();
  const [orderType, setOrderType] = useState<'dine_in' | 'takeaway'>('takeaway');
  const [table, setTable] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [couponId, setCouponId] = useState<ID | ''>('');
  const [manual, setManual] = useState(0);
  const [modFor, setModFor] = useState<Product | null>(null);
  const [pickCust, setPickCust] = useState(false);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<{ orderId: ID; change: number } | null>(null);
  const [parked, setParked] = useState<{ id: number; label: string; cart: CartLine[]; customerId?: ID }[]>([]);
  const [showManual, setShowManual] = useState(false);
  const now = useMemo(() => new Date().toISOString(), [cart, customerId, promoCode, couponId, manual]); // eslint-disable-line

  const sellables = useMemo(() => db.products.filter((p) => p.active && p.price > 0 && ['resale', 'finished', 'menu'].includes(p.kind)), [db.products]);
  const cats = useMemo(() => ['All', ...Array.from(new Set(sellables.map((p) => p.category)))], [sellables]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return sellables.filter((p) => (cat === 'All' || p.category === cat) && (!s || (p.name + p.sku + (p.barcode ?? '')).toLowerCase().includes(s)));
  }, [sellables, cat, q]);
  const stockOf = (p: Product) => (p.kind === 'menu' ? servingsPossible(db, wh, p.id, now) : onHand(db, wh, p.id));

  const lines: NewOrderLine[] = cart.map((c) => ({ productId: c.productId, qty: c.qty, modifiers: c.modifiers, note: c.note }));
  const quote = useMemo(() => (cart.length ? quoteOrder(db, { channel: 'POS', branchId, customerId, lines, promoCode: promoCode || undefined, couponId: couponId || undefined, manualDiscount: manual, now }) : null), [db, cart, branchId, customerId, promoCode, couponId, manual, now]); // eslint-disable-line
  const coupons = customerId ? db.coupons.filter((c) => c.customerId === customerId && c.status === 'issued' && c.expiresAt > now) : [];

  const add = (p: Product, mods: { group: string; option: string }[] = [], qty = 1, note?: string) => {
    if (p.kind !== 'menu' && !db.org.allowNegativeStock) {
      const inCart = cart.filter((c) => c.productId === p.id).reduce((s, c) => s + c.qty, 0);
      if (onHand(db, wh, p.id) < inCart + qty) { run(() => { throw new Error(`Only ${qtyFmt(onHand(db, wh, p.id))} ${p.unit} of ${p.name} in stock here`); }); return; }
    }
    const key = p.id + JSON.stringify(mods) + (note ?? '');
    setCart((c) => (c.some((x) => x.key === key) ? c.map((x) => (x.key === key ? { ...x, qty: x.qty + qty } : x)) : [...c, { key, productId: p.id, qty, modifiers: mods, note }]));
  };
  const onTile = (p: Product) => (p.modifiers?.length ? setModFor(p) : add(p));
  const reset = () => { setCart([]); setCustomerId(undefined); setPromoCode(''); setCouponId(''); setManual(0); setTable(''); setShowManual(false); };
  const park = () => { setParked((p) => [...p, { id: Date.now(), label: `${cart.reduce((s, c) => s + c.qty, 0)} items · ${money(quote?.total ?? 0)}`, cart, customerId }]); reset(); };

  useEffect(() => { setCart([]); }, [branchId]);
  const itemsCount = cart.reduce((s, c) => s + c.qty, 0);

  return (
    <>
      <PageHead title="Point of sale" desc={`${branch.name} · stock is deducted from ${db.warehouses.find((w) => w.id === wh)?.name}`}
        actions={<>
          {branches.length > 1 && <select className="select sm" style={{ width: 'auto' }} value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
          {parked.length > 0 && <Button size="sm" onClick={() => { const p = parked[0]; setCart(p.cart); setCustomerId(p.customerId); setParked((x) => x.slice(1)); }}><Play size={14} /> Recall ({parked.length})</Button>}
        </>} />
      <div className="pos">
        <div className="pos-left">
          <div className="row">
            <div className="grow"><SearchBox value={q} onChange={(v) => { setQ(v); const hit = sellables.find((p) => p.barcode && p.barcode === v.trim()); if (hit) { onTile(hit); setQ(''); } }} placeholder="Search or scan a barcode…" /></div>
          </div>
          <div className="cats">{cats.map((c) => <Button key={c} size="sm" variant={cat === c ? 'primary' : undefined} onClick={() => setCat(c)}>{c}</Button>)}</div>
          <div className="pos-grid">
            {shown.map((p) => {
              const st = stockOf(p);
              const out = st <= 0 && !db.org.allowNegativeStock;
              return (
                <button key={p.id} className={cx('tile', out && 'out')} disabled={out} onClick={() => onTile(p)} aria-label={`Add ${p.name}`}>
                  <div className="row between"><ProductEmoji p={p} size={40} />{p.kind === 'menu' ? (st < 6 ? <Badge tone="warn">{st} left</Badge> : null) : st <= (p.levels[wh]?.min ?? 0) ? <Badge tone={st <= 0 ? 'bad' : 'warn'}>{st <= 0 ? 'Out' : `${qtyFmt(st)} left`}</Badge> : null}</div>
                  <div className="nm">{p.name}</div>
                  <div className="pr"><b>{money(p.price)}</b>{p.modifiers?.length ? <span className="muted" style={{ fontSize: 11 }}>options</span> : <span className="muted" style={{ fontSize: 11 }}>{p.kind === 'menu' ? '' : `${qtyFmt(st)} ${p.unit}`}</span>}</div>
                </button>
              );
            })}
            {!shown.length && <div style={{ gridColumn: '1 / -1' }}><Empty title="No products match" hint="Try another category or search term." /></div>}
          </div>
        </div>

        <div className="card cart">
          <div className="card-h" style={{ paddingBottom: 10 }}>
            <h2>Current sale {itemsCount > 0 && <span className="muted" style={{ fontWeight: 400 }}>· {itemsCount} items</span>}</h2>
            <div className="row gap-6">{cart.length > 0 && <Button size="sm" variant="ghost" onClick={park} title="Park this sale"><Pause size={14} /> Park</Button>}{cart.length > 0 && <Button size="sm" variant="ghost" onClick={reset}><Trash2 size={14} /></Button>}</div>
          </div>
          <div style={{ padding: '0 16px 10px' }} className="col gap-6">
            <div className="row">
              <button className="btn block" style={{ justifyContent: 'flex-start' }} onClick={() => setPickCust(true)}><UserRound size={16} />{customerId ? db.customers.find((c) => c.id === customerId)?.name : 'Add customer (optional)'}</button>
              {customerId && <Button icon size="sm" variant="ghost" onClick={() => { setCustomerId(undefined); setCouponId(''); }}><X size={15} /></Button>}
            </div>
            {customerId && <CustomerSummary id={customerId} />}
            {branch.type === 'kitchen' && (
              <div className="row"><div className="seg grow"><button className={cx(orderType === 'takeaway' && 'on')} style={{ flex: 1 }} onClick={() => setOrderType('takeaway')}>Takeaway</button><button className={cx(orderType === 'dine_in' && 'on')} style={{ flex: 1 }} onClick={() => setOrderType('dine_in')}>Dine-in</button></div>{orderType === 'dine_in' && <Input sm style={{ width: 80 }} placeholder="Table" value={table} onChange={(e) => setTable(e.target.value)} />}</div>
            )}
          </div>
          <div className="cart-lines">
            {cart.length === 0 && <Empty icon={<Receipt size={22} />} title="Cart is empty" hint="Tap a product to add it. Scan a barcode or press Enter after typing one." />}
            {cart.map((c, i) => {
              const p = db.products.find((x) => x.id === c.productId)!;
              const ql = quote?.lines[i];
              const disc = quote?.lineDiscounts[i] ?? 0;
              return (
                <div key={c.key} className="cart-line">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    {c.modifiers.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{c.modifiers.map((m) => m.option).join(' · ')}</div>}
                    {c.note && <div className="muted" style={{ fontSize: 12 }}>“{c.note}”</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}><b className="num">{money((ql?.unitPrice ?? 0) * c.qty - disc)}</b>{disc > 0 && <div className="good" style={{ fontSize: 11.5 }}>−{money(disc)}</div>}</div>
                  <div className="qty"><button onClick={() => setCart((x) => x.map((l) => (l.key === c.key ? { ...l, qty: Math.max(0, l.qty - 1) } : l)).filter((l) => l.qty > 0))} aria-label="Decrease"><Minus size={13} /></button><span>{c.qty}</span><button onClick={() => add(p, c.modifiers, 1, c.note)} aria-label="Increase"><Plus size={13} /></button></div>
                  <div className="muted num" style={{ textAlign: 'right', fontSize: 12 }}>{money(ql?.unitPrice ?? 0)} each</div>
                </div>
              );
            })}
            {quote?.freeLines.map((f) => <div key={f.productId + f.promoId} className="cart-line"><div><b>{db.products.find((p) => p.id === f.productId)?.name}</b> <Badge tone="good"><Gift size={11} /> free</Badge></div><div className="num right">{money(0)}</div></div>)}
          </div>
          <div style={{ padding: '10px 16px 14px', borderTop: '1px solid var(--border)' }}>
            {quote && (
              <>
                <div className="row gap-6 mb8">
                  <div className="input-icon grow"><Tag /><input className="input sm" style={{ paddingLeft: 30 }} placeholder="Promo code (e.g. WELCOME50)" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} /></div>
                  {canDiscount && <Button size="sm" onClick={() => setShowManual((s) => !s)}><Percent size={14} /></Button>}
                </div>
                {coupons.length > 0 && <select className="select sm mb8" value={couponId} onChange={(e) => setCouponId(e.target.value)}><option value="">Apply a coupon…</option>{coupons.map((c) => <option key={c.id} value={c.id}>{c.title} · {c.code}</option>)}</select>}
                {showManual && canDiscount && <div className="row mb8"><span className="muted">Manual discount ฿</span><NumInput value={manual || ''} onChange={(n) => setManual(isNaN(n) ? 0 : n)} className="input sm" /><Badge tone="warn">audited</Badge></div>}
                {quote.couponNote && <div className="bad" style={{ fontSize: 12 }}>{quote.couponNote}</div>}
                <div className="totals">
                  <div><span className="muted">Subtotal</span><span className="num">{money(quote.subtotal)}</span></div>
                  {quote.applied.map((a) => (a.discount > 0 || a.entitlements || a.bonusPoints || a.freeItems.length) ? <div key={a.promoId} className="good" style={{ fontSize: 13 }}><span>{a.name}</span><span className="num">{a.discount > 0 ? '−' + money(a.discount) : a.entitlements ? `+${a.entitlements} event pick${a.entitlements > 1 ? 's' : ''}` : a.bonusPoints ? `+${a.bonusPoints} pts` : 'free item'}</span></div> : null)}
                  {quote.bonusMultiplier > 0 && <div className="good" style={{ fontSize: 13 }}><span>Double points today</span><span>×{1 + quote.bonusMultiplier}</span></div>}
                  {quote.couponDiscount > 0 && <div className="good" style={{ fontSize: 13 }}><span>Coupon</span><span className="num">−{money(quote.couponDiscount)}</span></div>}
                  {quote.manual > 0 && <div style={{ fontSize: 13 }}><span>Manual discount</span><span className="num">−{money(quote.manual)}</span></div>}
                  <div className="grand"><span>Total</span><span className="num">{money(quote.total)}</span></div>
                </div>
              </>
            )}
            <Button variant="primary" size="lg" className="block mt8" disabled={!cart.length || !canCharge} onClick={() => setPaying(true)}>{canCharge ? `Charge ${quote ? money(quote.total) : ''}` : 'No permission to charge'}</Button>
          </div>
        </div>
      </div>

      {modFor && <ModifierModal p={modFor} onClose={() => setModFor(null)} onAdd={(mods, qty, note) => { add(modFor, mods, qty, note); setModFor(null); }} />}
      {pickCust && <CustomerPicker onClose={() => setPickCust(false)} onPick={(id) => { setCustomerId(id); setPickCust(false); }} />}
      {paying && quote && (
        <PayModal total={quote.total} customerId={customerId} onClose={() => setPaying(false)}
          onPay={(payments, extra) => {
            const key = extra.key;
            let change = 0;
            const cash = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0);
            const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
            const need = Math.max(0, quote.total - (extra.creditUsed || 0));
            if (paidTotal > need && cash > 0) change = r2(Math.min(cash, paidTotal - need));
            run((d, c) => createOrder(d, c, { channel: 'POS', branchId, customerId, lines, orderType: branch.type === 'kitchen' ? orderType : 'takeaway', tableNo: table || undefined, promoCode: promoCode || undefined, couponId: couponId || undefined, manualDiscount: manual || undefined, payments, useCredit: extra.useCredit, payLater: extra.payLater, idempotencyKey: key }),
              { perm: 'pos:create', onOk: (orderId) => { setPaying(false); setDone({ orderId, change }); } });
          }} />
      )}
      {done && <DoneModal orderId={done.orderId} change={done.change} onClose={() => { setDone(null); reset(); }} />}
    </>
  );
}

function ModifierModal({ p, onClose, onAdd }: { p: Product; onClose: () => void; onAdd: (mods: { group: string; option: string }[], qty: number, note?: string) => void }) {
  const [sel, setSel] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const delta = (p.modifiers ?? []).reduce((s, g) => s + (g.options.find((o) => o.name === sel[g.name])?.priceDelta ?? 0), 0);
  return (
    <Modal title={p.name} desc={money(p.price)} size="sm" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onAdd(Object.entries(sel).filter(([, v]) => v).map(([group, option]) => ({ group, option })), qty, note || undefined)}>Add · {money((p.price + delta) * qty)}</Button></>}>
      <div className="col gap-16">
        {(p.modifiers ?? []).map((g) => (
          <div key={g.name}>
            <div className="lbl-s mb8">{g.name}</div>
            <div className="row wrap gap-6">
              {g.options.map((o) => <Button key={o.name} size="sm" variant={sel[g.name] === o.name ? 'primary' : undefined} onClick={() => setSel({ ...sel, [g.name]: sel[g.name] === o.name ? '' : o.name })}>{o.name}{o.priceDelta ? ` +${o.priceDelta}` : ''}</Button>)}
            </div>
          </div>
        ))}
        <Field label="Note for the kitchen / bar"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. less ice" /></Field>
        <div className="row between"><span className="lbl-s">Quantity</span><div className="qty"><button onClick={() => setQty(Math.max(1, qty - 1))}><Minus size={13} /></button><span>{qty}</span><button onClick={() => setQty(qty + 1)}><Plus size={13} /></button></div></div>
      </div>
    </Modal>
  );
}

function PayModal({ total, customerId, onClose, onPay }: { total: number; customerId?: ID; onClose: () => void; onPay: (p: Pay[], extra: { useCredit: boolean; payLater: boolean; key: string; creditUsed: number }) => void }) {
  const db = useDB();
  const key = useRef(`pos-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [pays, setPays] = useState<Pay[]>([]);
  const [method, setMethod] = useState<PayMethod>('cash');
  const [tender, setTender] = useState<number>(total);
  const [useCredit, setUseCredit] = useState(false);
  const [payLater, setPayLater] = useState(false);
  const cust = customerId ? db.customers.find((c) => c.id === customerId) : undefined;
  const credit = customerId ? customerCredit(db, customerId) : 0;
  const out = customerId ? customerOutstanding(db, customerId) : 0;
  const creditUsed = useCredit ? Math.min(credit, total) : 0;
  const due = r2(total - creditUsed);
  const paid = r2(pays.reduce((s, p) => s + p.amount, 0));
  const remaining = r2(Math.max(0, due - paid));
  const available = cust ? cust.creditLimit - out : 0;
  const cashTendered = pays.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0);
  const change = r2(Math.max(0, paid - due) > 0 ? Math.min(cashTendered, paid - due) : 0);
  useEffect(() => { setTender(remaining); }, [remaining, method]);
  const addPay = () => { if (tender > 0) setPays([...pays, { method, amount: tender }]); };
  const settled = remaining <= 0.004;
  const canLater = !!cust && cust.creditLimit > 0 && remaining <= available + 0.004;
  return (
    <Modal title={`Charge ${money(total)}`} onClose={onClose} footer={
      <><Button onClick={onClose}>Back</Button>
        <Button variant="primary" size="lg" disabled={!(settled || (payLater && canLater))} onClick={() => onPay(pays, { useCredit, payLater: payLater && !settled, key: key.current, creditUsed })}><Check size={18} /> {settled ? 'Complete sale' : payLater ? `Put ${money(remaining)} on account` : 'Complete sale'}</Button></>}>
      <div className="col gap-16">
        {cust && credit > 0 && <label className="check"><input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} /> Use customer credit ({money(credit)} available)</label>}
        <div className="grid g2" style={{ gap: 10 }}>
          <div className="card card-b" style={{ background: 'var(--surface-2)' }}><div className="muted">Amount due</div><div style={{ fontSize: 28, fontWeight: 700 }} className="num">{money(due)}</div></div>
          <div className="card card-b" style={{ background: remaining > 0 ? 'var(--warn-soft)' : 'var(--good-soft)' }}><div className="muted">{remaining > 0 ? 'Remaining' : change > 0 ? 'Change due' : 'Settled'}</div><div style={{ fontSize: 28, fontWeight: 700 }} className="num">{remaining > 0 ? money(remaining) : money(change)}</div></div>
        </div>
        {pays.map((p, i) => <div key={i} className="row between chip" style={{ padding: '6px 10px' }}><span className="row gap-6">{METHOD_ICON[p.method]}{PAY_METHODS.find((m) => m.key === p.method)?.label}</span><span className="row gap-6"><b className="num">{money(p.amount)}</b><Button size="sm" icon variant="ghost" onClick={() => setPays(pays.filter((_, k) => k !== i))}><X size={14} /></Button></span></div>)}
        {!settled && (
          <>
            <div className="row wrap gap-6">{PAY_METHODS.map((m) => <Button key={m.key} variant={method === m.key ? 'primary' : undefined} onClick={() => setMethod(m.key)}>{METHOD_ICON[m.key]} {m.label}</Button>)}</div>
            {method === 'qr' && <div className="row gap-16 wrap" style={{ alignItems: 'center' }}><QR data={promptPayPayload(db.org.promptPayId, tender)} size={150} /><div className="text2" style={{ fontSize: 13 }}>Customer scans with any banking app.<br />PromptPay ID <b>{db.org.promptPayId}</b> · <b>{money(tender)}</b><br /><span className="muted">Confirm only after the payment notification arrives.</span></div></div>}
            <div className="row">
              <Field label={method === 'cash' ? 'Cash received' : 'Amount'}><NumInput value={tender} onChange={setTender} /></Field>
              <div style={{ alignSelf: 'flex-end' }}><Button variant="soft" onClick={addPay}>Add payment</Button></div>
            </div>
            {method === 'cash' && <div className="row wrap gap-6">{[remaining, 100, 500, 1000].filter((v, i, a) => v > 0 && a.indexOf(v) === i).map((v) => <Button key={v} size="sm" onClick={() => setTender(v)}>{v === remaining ? 'Exact' : money(v)}</Button>)}</div>}
          </>
        )}
        {!settled && cust && (
          <div className="card card-b" style={{ background: 'var(--surface-2)' }}>
            <label className="check"><input type="checkbox" checked={payLater} disabled={!canLater} onChange={(e) => setPayLater(e.target.checked)} /> <b>Leave {money(remaining)} on account</b></label>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Credit limit {money(cust.creditLimit)} · outstanding {money(out)} · available {money(Math.max(0, available))}{!canLater && cust.creditLimit <= 0 ? ' — this customer has no credit terms.' : !canLater ? ' — amount exceeds available credit.' : ''}</div>
          </div>
        )}
        {!settled && !cust && <Banner>To leave a balance unpaid, first select a customer with credit terms.</Banner>}
      </div>
    </Modal>
  );
}

function DoneModal({ orderId, change, onClose }: { orderId: ID; change: number; onClose: () => void }) {
  const db = useDB();
  const o = db.orders.find((x) => x.id === orderId)!;
  const jobs = db.printJobs.filter((j) => j.refId === orderId);
  const doc = useMemo(() => renderDoc(db, 'receipt', orderId, { paper: '80mm' }), [db, orderId]);
  const [print, setPrint] = useState(false);
  const ents = o.promotions.reduce((s, a) => s + a.entitlements, 0);
  return (
    <Modal title={<span className="row gap-6"><Check color="var(--good)" /> Sale complete — {o.no}</span>} onClose={onClose} footer={<><Button onClick={() => setPrint(true)}>Print / reprint receipt</Button><Button variant="primary" onClick={onClose}>New sale</Button></>}>
      <div className="grid g2" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,340px)" }}>
        <div className="col">
          <div style={{ fontSize: 30, fontWeight: 700 }} className="num">{money(o.total)}</div>
          {change > 0 && <Banner tone="good"><b>Give change {money(change)}</b></Banner>}
          {o.customerId && <div className="col gap-6">{o.pointsEarned > 0 && <Badge tone="info">+{o.pointsEarned} points earned</Badge>}{ents > 0 && <Badge tone="info">+{ents} lucky-draw pick{ents > 1 ? 's' : ''} — customer can choose numbers in the Events page or LINE app</Badge>}{o.promotions.some((a) => a.couponIds?.length) && <Badge tone="info">Coupon issued to customer</Badge>}</div>}
          {jobs.length > 0 && (
            <div className="card card-b"><div className="lbl-s mb8">Print jobs</div>{jobs.map((j) => <div key={j.id} className="row between" style={{ fontSize: 13 }}><span>{j.docType.replace('_', ' ')}{j.station ? ` · ${j.station}` : ''} → {db.printers.find((p) => p.id === j.printerId)?.name ?? 'no printer'}</span><Badge tone={j.status === 'printed' ? 'good' : j.status === 'failed' ? 'bad' : 'warn'} dot>{j.status}</Badge></div>)}<div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Failed or manual jobs can be retried in <Link to="/printing">Printing</Link>.</div></div>
          )}
        </div>
        <div style={{ background: 'var(--surface-3)', padding: 12, borderRadius: 12, maxHeight: 420, overflow: 'auto' }}><DocPreview doc={doc} /></div>
      </div>
      {print && <PrintModal docType="receipt" refId={orderId} onClose={() => setPrint(false)} />}
    </Modal>
  );
}
