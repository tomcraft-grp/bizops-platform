import { useMemo, useState } from 'react';
import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import { useDB } from '../domain/store';
import { effectiveStatus, promoUsage } from '../domain/promotions';
import { quoteOrder } from '../domain/orders';
import { CHANNEL_LIST } from '../domain/meta';
import { Badge, Banner, Button, Card, ChannelChip, Check, DataTable, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useHas, useRun } from '../ui/kit';
import { dateFmt, dayKey, money, money0, addDays } from '../lib/util';
import type { ChannelCode, PromoActionType, Promotion } from '../domain/types';

const ACTIONS: { v: PromoActionType; label: string; hint: string }[] = [
  { v: 'percent', label: 'Percentage discount', hint: 'value = % off the eligible items' },
  { v: 'fixed', label: 'Fixed discount', hint: 'value = ฿ off the eligible items' },
  { v: 'bundle_price', label: 'Bundle price', hint: 'value = bundle price for the listed products' },
  { v: 'free_item', label: 'Free item', hint: 'adds a free product line' },
  { v: 'bonus_points', label: 'Bonus points', hint: 'multiplier (1 = double) or fixed points' },
  { v: 'event_entitlement', label: 'Event entitlement', hint: 'one pick per N baht spent' },
  { v: 'coupon', label: 'Issue coupon', hint: 'coupon for next purchase' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Promotions() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('promotions:edit');
  const [tab, setTab] = useState<'list' | 'sim'>('list');
  const [edit, setEdit] = useState<Promotion | 'new' | null>(null);
  const now = new Date().toISOString();
  const rows = db.promotions.map((p) => ({ p, st: effectiveStatus(p, now), u: promoUsage(db, p.id) }));
  const given = rows.reduce((s, r) => s + r.u.discount, 0);

  return (
    <>
      <PageHead title="Promotions" desc="A rule engine — conditions, actions, limits, budgets and stacking — configured without code. Every application is recorded against the order and flows into profit reports."
        actions={canEdit && <Button variant="primary" onClick={() => setEdit('new')}><Plus size={15} /> New promotion</Button>} />
      <div className="grid g4 mb16">
        <Kpi label="Active now" value={rows.filter((r) => r.st === 'active' && dayKey(r.p.startAt) <= dayKey(now)).length} sub={`${rows.filter((r) => r.st === 'draft').length} drafts · ${rows.filter((r) => r.st === 'expired').length} expired`} />
        <Kpi label="Redemptions" value={db.redemptions.length} sub="across all orders" />
        <Kpi label="Discount given" value={money0(given)} sub="business-funded" />
        <Kpi label="Budget tracked" value={money0(rows.reduce((s, r) => s + (r.p.budget ?? 0), 0))} sub={`${rows.filter((r) => r.p.budget).length} budgeted promotions`} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'list', label: 'Promotions' }, { v: 'sim', label: 'Eligibility simulator' }]} />
      {tab === 'list' && (
        <Card flush>
          <DataTable rows={rows} rowKey={(r) => r.p.id} pageSize={12} search={(r) => r.p.name + (r.p.code ?? '')}
            cols={[
              { key: 'n', header: 'Promotion', sort: (r) => r.p.name, render: (r) => <><b>{r.p.name}</b>{r.p.code && <Badge tone="info"> code {r.p.code}</Badge>}<div className="sub">{r.p.description}</div></> },
              { key: 's', header: 'Status', render: (r) => <Badge tone={r.st === 'active' ? 'good' : r.st === 'paused' ? 'warn' : r.st === 'expired' ? 'bad' : ''} dot>{r.st}</Badge> },
              { key: 'a', header: 'Action', render: (r) => <>{ACTIONS.find((x) => x.v === r.p.action.type)?.label}<div className="sub">{r.p.action.type === 'percent' ? `${r.p.action.value}%` : r.p.action.type === 'fixed' || r.p.action.type === 'bundle_price' ? money(r.p.action.value ?? 0) : r.p.action.type === 'event_entitlement' ? `per ${money0(r.p.action.perAmount ?? 0)}` : ''}</div></> },
              { key: 'w', header: 'When', hideSm: true, render: (r) => <>{dateFmt(r.p.startAt)} → {dateFmt(r.p.endAt)}<div className="sub">{r.p.weekdays?.length ? r.p.weekdays.map((d) => DAYS[d]).join(' ') : 'every day'}</div></> },
              { key: 'c', header: 'Channels', hideSm: true, render: (r) => (r.p.channels.length ? <div className="row wrap gap-4">{r.p.channels.map((c) => <ChannelChip key={c} c={c} />)}</div> : <span className="muted">all</span>) },
              { key: 'u', header: 'Used', num: true, render: (r) => <>{r.u.total}{r.p.limits.total ? <span className="muted"> / {r.p.limits.total}</span> : ''}<div className="sub">{r.u.discount ? '−' + money0(r.u.discount) : ''}{r.p.budget ? ` of ${money0(r.p.budget)}` : ''}</div></> },
              { key: 'x', header: '', render: (r) => canEdit && <div className="row gap-4">
                {r.st !== 'expired' && <Button size="sm" variant="ghost" icon title={r.p.status === 'active' ? 'Pause' : 'Activate'} onClick={() => run((d) => { const x = d.promotions.find((y) => y.id === r.p.id)!; x.status = x.status === 'active' ? 'paused' : 'active'; }, { ok: r.p.status === 'active' ? 'Paused' : 'Activated' })}>{r.p.status === 'active' ? <Pause size={14} /> : <Play size={14} />}</Button>}
                <Button size="sm" onClick={() => setEdit(r.p)}>Edit</Button></div> },
            ]} />
        </Card>
      )}
      {tab === 'sim' && <Simulator />}
      {edit && <PromoModal p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function Simulator() {
  const db = useDB();
  const [channel, setChannel] = useState<ChannelCode>('POS');
  const [cust, setCust] = useState('');
  const [code, setCode] = useState('');
  const [lines, setLines] = useState<{ productId: string; qty: number }[]>([{ productId: 'D03', qty: 1 }, { productId: 'FD1', qty: 1 }]);
  const [when, setWhen] = useState(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const branch = db.branches.find((b) => (channel === 'POS' ? b.type === 'kitchen' : b.type === 'online')) ?? db.branches[0];
  const q = useMemo(() => quoteOrder(db, { channel, branchId: branch.id, customerId: cust || undefined, lines: lines.filter((l) => l.productId), promoCode: code || undefined, now: new Date(when).toISOString() }), [db, channel, cust, code, lines, when, branch.id]);
  return (
    <div className="grid g2">
      <Card title="Test cart" sub="Change the date to preview weekday/time-window rules">
        <div className="form-grid">
          <Field label="Channel"><Select value={channel} onChange={(e) => setChannel(e.target.value as ChannelCode)}>{CHANNEL_LIST.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select></Field>
          <Field label="Customer"><Select value={cust} onChange={(e) => setCust(e.target.value)}><option value="">Walk-in</option>{db.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Date & time"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Field label="Promo code"><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="WELCOME50" /></Field>
        </div>
        <div className="col mt16">
          {lines.map((l, i) => (
            <div key={i} className="row"><Select value={l.productId} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, productId: e.target.value } : x)))}>{db.products.filter((p) => ['resale', 'finished', 'menu'].includes(p.kind)).map((p) => <option key={p.id} value={p.id}>{p.name} — {money0(p.price)}</option>)}</Select><NumInput style={{ width: 80 }} value={l.qty} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, qty: Math.max(1, n || 1) } : x)))} /><Button icon variant="ghost" onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 size={15} /></Button></div>
          ))}
          <div><Button size="sm" onClick={() => setLines([...lines, { productId: 'D01', qty: 1 }])}><Plus size={14} /> Add line</Button></div>
        </div>
      </Card>
      <Card title="Result" sub="Deterministic: the same cart always gives the same answer">
        <div className="row between"><span className="muted">Subtotal</span><b>{money(q.subtotal)}</b></div>
        <div className="row between"><span className="muted">Promotion discounts</span><b className="good">−{money(q.promoDiscount)}</b></div>
        <div className="row between" style={{ fontSize: 20 }}><b>Total</b><b>{money(q.total)}</b></div>
        <div className="divider" />
        <div className="lbl-s mb8">Applied</div>
        {q.applied.length ? q.applied.map((a) => <div key={a.promoId} className="row between" style={{ fontSize: 13 }}><span>{a.name}</span><span>{a.discount ? '−' + money(a.discount) : a.entitlements ? `+${a.entitlements} event pick(s)` : a.bonusPoints ? `+${a.bonusPoints} pts` : a.freeItems.length ? 'free item' : 'applied'}</span></div>) : <div className="muted">No promotion applies.</div>}
        {q.bonusMultiplier > 0 && <div className="good" style={{ fontSize: 13 }}>Points multiplier ×{1 + q.bonusMultiplier}</div>}
        {q.skipped.length > 0 && <><div className="lbl-s mt16 mb8">Close, but not applied — why</div>{q.skipped.map((s) => <div key={s.promoId} className="row between" style={{ fontSize: 13 }}><span>{s.name}</span><Badge tone="warn">{s.reason}</Badge></div>)}</>}
      </Card>
    </div>
  );
}

function PromoModal({ p, onClose }: { p: Promotion | null; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const cats = Array.from(new Set(db.products.filter((x) => ['resale', 'finished', 'menu'].includes(x.kind)).map((x) => x.category)));
  const [f, setF] = useState<Promotion>(p ?? { id: '', name: '', description: '', status: 'draft', priority: 30, stacking: 'stackable', startAt: new Date().toISOString(), endAt: addDays(new Date(), 30).toISOString(), channels: [], branchIds: [], customerGroups: [], action: { type: 'percent', value: 10 }, limits: { perOrder: 1 } });
  const set = (patch: Partial<Promotion>) => setF({ ...f, ...patch });
  const a = f.action;
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const dtl = (iso: string) => iso.slice(0, 10);
  return (
    <Modal title={p ? 'Edit promotion' : 'New promotion'} size="lg" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim()} onClick={() => run((d) => { if (p) Object.assign(d.promotions.find((x) => x.id === p.id)!, f); else d.promotions.push({ ...f, id: 'PM' + (d.promotions.length + 20) }); }, { ok: 'Promotion saved', perm: 'promotions:edit', onOk: onClose })}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Name" full><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Description" full><Textarea style={{ minHeight: 50 }} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label="Status"><Select value={f.status} onChange={(e) => set({ status: e.target.value as Promotion['status'] })}><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option></Select></Field>
        <Field label="Promo code (optional)"><Input value={f.code ?? ''} onChange={(e) => set({ code: e.target.value || undefined })} /></Field>
        <Field label="Start"><Input type="date" value={dtl(f.startAt)} onChange={(e) => set({ startAt: new Date(e.target.value).toISOString() })} /></Field>
        <Field label="End"><Input type="date" value={dtl(f.endAt)} onChange={(e) => set({ endAt: new Date(e.target.value + 'T23:59:00').toISOString() })} /></Field>
        <Field label="Priority" hint="Higher runs first"><NumInput value={f.priority} onChange={(n) => set({ priority: n || 0 })} /></Field>
        <Field label="Stacking"><Select value={f.stacking} onChange={(e) => set({ stacking: e.target.value as Promotion['stacking'] })}><option value="stackable">Stackable with other promotions</option><option value="exclusive">Exclusive (blocks lower-priority discounts)</option></Select></Field>
        <Field label="Channels (none = all)" full><div className="row wrap">{CHANNEL_LIST.map((c) => <Check key={c.code} checked={f.channels.includes(c.code)} onChange={() => set({ channels: toggle(f.channels, c.code) })}>{c.short}</Check>)}</div></Field>
        <Field label="Weekdays (none = every day)" full><div className="row wrap">{DAYS.map((d, i) => <Check key={d} checked={!!f.weekdays?.includes(i)} onChange={() => set({ weekdays: toggle(f.weekdays ?? [], i) })}>{d}</Check>)}</div></Field>
        <Field label="Customer groups (none = everyone)" full><div className="row wrap">{['retail', 'vip', 'wholesale', 'staff'].map((g) => <Check key={g} checked={f.customerGroups.includes(g)} onChange={() => set({ customerGroups: toggle(f.customerGroups, g) })}>{g}</Check>)}</div></Field>
        <Field label="Minimum order (฿)"><NumInput value={f.minOrder ?? ''} onChange={(n) => set({ minOrder: isNaN(n) ? undefined : n })} /></Field>
        <Field label="Minimum item quantity"><NumInput value={f.minQty ?? ''} onChange={(n) => set({ minQty: isNaN(n) ? undefined : n })} /></Field>
        <Field label="Limited to categories" full><div className="row wrap">{cats.map((c) => <Check key={c} checked={!!f.categories?.includes(c)} onChange={() => set({ categories: toggle(f.categories ?? [], c) })}>{c}</Check>)}</div></Field>
        <div className="full divider" />
        <Field label="Action"><Select value={a.type} onChange={(e) => set({ action: { type: e.target.value as PromoActionType, value: a.value } })}>{ACTIONS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</Select></Field>
        <Field label="Value" hint={ACTIONS.find((x) => x.v === a.type)?.hint}><NumInput value={a.value ?? ''} onChange={(n) => set({ action: { ...a, value: isNaN(n) ? undefined : n } })} /></Field>
        {a.type === 'bonus_points' && <Field label="Mode"><Select value={a.bonusMode ?? 'fixed'} onChange={(e) => set({ action: { ...a, bonusMode: e.target.value as 'fixed' | 'multiplier' } })}><option value="fixed">Fixed points</option><option value="multiplier">Extra multiplier</option></Select></Field>}
        {a.type === 'free_item' && <Field label="Free product"><Select value={a.productId ?? ''} onChange={(e) => set({ action: { ...a, productId: e.target.value } })}><option value="">Select…</option>{db.products.filter((x) => ['resale', 'finished', 'menu'].includes(x.kind)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>}
        {a.type === 'bundle_price' && <Field label="Bundle products" full><div className="row wrap">{db.products.filter((x) => ['resale', 'finished', 'menu'].includes(x.kind)).map((x) => <Check key={x.id} checked={!!a.bundleProductIds?.includes(x.id)} onChange={() => set({ action: { ...a, bundleProductIds: toggle(a.bundleProductIds ?? [], x.id) } })}>{x.name}</Check>)}</div></Field>}
        {a.type === 'event_entitlement' && <>
          <Field label="Event"><Select value={a.eventId ?? ''} onChange={(e) => set({ action: { ...a, eventId: e.target.value } })}><option value="">Select…</option>{db.events.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="One pick per (฿)"><NumInput value={a.perAmount ?? ''} onChange={(n) => set({ action: { ...a, perAmount: n } })} /></Field>
          <Field label="Max picks per order"><NumInput value={a.maxPerOrder ?? 5} onChange={(n) => set({ action: { ...a, maxPerOrder: n } })} /></Field></>}
        {a.type === 'coupon' && <><Field label="Coupon value (฿)"><NumInput value={a.couponValue ?? ''} onChange={(n) => set({ action: { ...a, couponValue: n } })} /></Field><Field label="Valid for (days)"><NumInput value={a.couponDays ?? 30} onChange={(n) => set({ action: { ...a, couponDays: n } })} /></Field></>}
        <div className="full divider" />
        <Field label="Total usage limit"><NumInput value={f.limits.total ?? ''} onChange={(n) => set({ limits: { ...f.limits, total: isNaN(n) ? undefined : n } })} /></Field>
        <Field label="Per-customer limit"><NumInput value={f.limits.perCustomer ?? ''} onChange={(n) => set({ limits: { ...f.limits, perCustomer: isNaN(n) ? undefined : n } })} /></Field>
        <Field label="Budget / max discount exposure (฿)"><NumInput value={f.budget ?? ''} onChange={(n) => set({ budget: isNaN(n) ? undefined : n })} /></Field>
        <Field label="Max times per order"><NumInput value={f.limits.perOrder} onChange={(n) => set({ limits: { ...f.limits, perOrder: Math.max(1, n || 1) } })} /></Field>
        <div className="full"><Check checked={!!f.requireCustomer} onChange={(v) => set({ requireCustomer: v })}>Requires an identified customer</Check></div>
      </div>
      {f.channels.some((c) => c !== 'POS' && c !== 'LINE') && <div className="mt16"><Banner tone="warn">Marketplace and delivery platforms set their own final prices; promotions are only applied to <b>POS</b> and <b>LINE</b> orders in this prototype.</Banner></div>}
    </Modal>
  );
}
