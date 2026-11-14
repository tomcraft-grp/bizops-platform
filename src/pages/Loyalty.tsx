import { useMemo, useState } from 'react';
import { Gift, Plus, Sparkles } from 'lucide-react';
import { useDB } from '../domain/store';
import { isUsable } from '../domain/master';
import { adjustPoints, cancelRedemption, expirePoints, fulfillRedemption, lifetimeSpendMap, pointsMap, tierFor } from '../domain/loyalty';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun, Tx } from '../ui/kit';
import { Donut, HBars } from '../ui/charts';
import { dateFmt, dateTimeFmt, money0, compact } from '../lib/util';
import type { Reward } from '../domain/types';

type Tab = 'overview' | 'rewards' | 'redemptions' | 'ledger' | 'rules';
export default function Loyalty() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canEdit = useHas('loyalty:edit');
  const [tab, setTab] = useState<Tab>('overview');
  const [adj, setAdj] = useState(false);
  const [rw, setRw] = useState<Reward | 'new' | null>(null);
  const pts = useMemo(() => pointsMap(db), [db.pointsLedger]);
  const spend = useMemo(() => lifetimeSpendMap(db), [db.orders]);
  const sum = (f: (t: string) => boolean) => db.pointsLedger.filter((e) => f(e.type)).reduce((s, e) => s + e.points, 0);
  const issued = sum((t) => ['earn', 'bonus', 'adjust', 'restore'].includes(t)) + 0;
  const redeemed = -sum((t) => t === 'redeem');
  const expired = -sum((t) => t === 'expire');
  const outstanding = Object.values(pts).reduce((s, x) => s + x, 0);
  const tiers = db.loyalty.tiers.map((t) => ({ ...t, n: db.customers.filter((c) => tierFor(db, spend[c.id] || 0).name === t.name).length }));
  const top = Object.entries(pts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const expSoon = db.pointsLedger.filter((e) => (e.remaining ?? 0) > 0 && e.expiresAt && e.expiresAt < new Date(Date.now() + 60 * 86400000).toISOString()).reduce((s, e) => s + (e.remaining ?? 0), 0);

  return (
    <>
      <PageHead title="Loyalty & rewards" desc="Points are an append-only ledger (earn, bonus, redeem, expire, reverse). Balances are derived, redemptions are atomic, and double-spending is prevented."
        actions={canEdit && <><Button onClick={() => setAdj(true)}><Tx>Adjust points</Tx></Button><Button variant="primary" onClick={() => setRw('new')}><Plus size={15} />{' '}<Tx>New reward</Tx></Button></>} />
      <div className="grid g4 mb16">
        <Kpi label="Points outstanding" value={outstanding.toLocaleString()} sub={`≈ ${money0(outstanding * db.org.pointValue)} liability at ฿${db.org.pointValue}/pt`} />
        <Kpi label="Issued" value={issued.toLocaleString()} sub="earn + bonus + adjustments" />
        <Kpi label="Redeemed" value={redeemed.toLocaleString()} sub={`${db.rewardRedemptions.filter((r) => r.status !== 'cancelled').length} redemptions`} />
        <Kpi label="Expiring in 60 days" value={expSoon.toLocaleString()} sub={<Tx vars={{ n: expired.toLocaleString() }}>{'{n} already expired'}</Tx>} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'overview', label: 'Overview' }, { v: 'rewards', label: 'Reward catalog', count: db.rewards.length }, { v: 'redemptions', label: 'Redemptions' }, { v: 'ledger', label: 'Points ledger' }, { v: 'rules', label: 'Earning rules' }]} />

      {tab === 'overview' && (
        <div className="grid g2">
          <Card title="Members by tier">
            <Donut items={tiers.map((t) => ({ label: t.name, value: t.n, color: t.name === 'Silver' ? 'var(--s1)' : t.name === 'Gold' ? 'var(--s4)' : 'var(--s7)' }))} center={String(db.customers.length)} sub="members" fmt={(n) => String(n)} />
          </Card>
          <Card title="Top balances"><HBars items={top.map(([id, v]) => ({ label: db.customers.find((c) => c.id === id)?.name ?? id, value: v }))} fmt={(n) => compact(n) + ' pts'} /></Card>
        </div>
      )}
      {tab === 'rewards' && (
        <div className="grid g-auto">
          {db.rewards.map((r) => (
            <Card key={r.id} title={<span>{r.emoji} {r.name}</span>} sub={r.description} actions={<Badge tone={r.active ? 'good' : ''}>{r.active ? <Tx>{'active'}</Tx> : <Tx>{'hidden'}</Tx>}</Badge>}>
              <div className="row between"><b style={{ fontSize: 20 }}>{r.cost.toLocaleString()}{' '}<Tx>pts</Tx></b><span className="muted">{r.stock == null ? <Tx>{'Unlimited'}</Tx> : <Tx vars={{ n: r.stock }}>{'{n} in stock'}</Tx>}</span></div>
              <div className="muted mt8" style={{ fontSize: 12 }}>{r.kind === 'coupon' ? <Tx vars={{ v: r.couponKind === 'percent' ? r.couponValue + '%' : '฿' + r.couponValue }}>{'Issues a {v} coupon'}</Tx> : <Tx vars={{ name: String(db.products.find((p) => p.id === r.productId)?.name) }}>{'Free item: {name}'}</Tx>} · {db.rewardRedemptions.filter((x) => x.rewardId === r.id && x.status !== 'cancelled').length}{' '}<Tx>redeemed</Tx></div>
              {canEdit && <div className="row mt8"><Button size="sm" onClick={() => setRw(r)}><Tx>Edit</Tx></Button><Button size="sm" variant="ghost" onClick={() => run((d) => { d.rewards.find((x) => x.id === r.id)!.active = !r.active; }, { ok: r.active ? 'Reward hidden' : 'Reward visible' })}>{r.active ? <Tx>{'Hide'}</Tx> : <Tx>{'Show'}</Tx>}</Button></div>}
            </Card>
          ))}
        </div>
      )}
      {tab === 'redemptions' && (
        <Card flush>
          <DataTable rows={[...db.rewardRedemptions].reverse()} rowKey={(r) => r.id} pageSize={12} empty={<Empty icon={<Gift size={22} />} title="No redemptions yet" hint="Customers redeem rewards in the Customer app." />}
            cols={[
              { key: 'd', header: 'Date', render: (r) => dateTimeFmt(r.ts) }, { key: 'c', header: 'Customer', render: (r) => db.customers.find((c) => c.id === r.customerId)?.name },
              { key: 'r', header: 'Reward', render: (r) => db.rewards.find((x) => x.id === r.rewardId)?.name }, { key: 'p', header: 'Points', num: true, render: (r) => r.points },
              { key: 'code', header: 'Code', render: (r) => <span className="mono">{r.code}</span> },
              { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'issued' ? 'warn' : r.status === 'fulfilled' ? 'good' : 'bad'} dot>{r.status}</Badge> },
              { key: 'a', header: '', render: (r) => r.status === 'issued' && canEdit ? <div className="row gap-4">{!r.couponId && <Button size="sm" onClick={() => run((d, c) => fulfillRedemption(d, c, r.id), { ok: 'Marked as handed over' })}><Tx>Hand over</Tx></Button>}<Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: 'Cancel redemption?', body: 'Points are restored and stock/coupon released.', reason: true, danger: true }); if (x.ok) run((d, c) => cancelRedemption(d, c, r.id, x.reason), { ok: 'Points restored' }); }}><Tx>Cancel</Tx></Button></div> : null },
            ]} />
        </Card>
      )}
      {tab === 'ledger' && (
        <Card flush title="Points ledger" actions={canEdit && <Button size="sm" onClick={() => run((d, c) => { const n = expirePoints(d, c); if (!n) throw new Error('Nothing to expire right now'); return n; }, { ok: 'Expired batches processed' })}><Tx>Run expiry</Tx></Button>}>
          <DataTable rows={[...db.pointsLedger].reverse()} rowKey={(p) => p.id} pageSize={14} search={(p) => `${db.customers.find((c) => c.id === p.customerId)?.name} ${p.type} ${p.note ?? ''}`}
            cols={[
              { key: 'd', header: 'Date', render: (p) => dateTimeFmt(p.ts) }, { key: 'c', header: 'Customer', render: (p) => db.customers.find((c) => c.id === p.customerId)?.name },
              { key: 't', header: 'Type', render: (p) => <Badge tone={p.points > 0 ? 'good' : p.type === 'expire' ? 'warn' : ''}>{p.type}</Badge> }, { key: 'n', header: 'Note', render: (p) => p.note ?? '' },
              { key: 'e', header: 'Expires', render: (p) => (p.expiresAt ? dateFmt(p.expiresAt) : '') },
              { key: 'p', header: 'Points', num: true, render: (p) => <b className={p.points > 0 ? 'good' : 'bad'}>{p.points > 0 ? '+' : ''}{p.points}</b> },
            ]} />
        </Card>
      )}
      {tab === 'rules' && <Rules />}
      {adj && <AdjustModal onClose={() => setAdj(false)} />}
      {rw && <RewardModal r={rw === 'new' ? null : rw} onClose={() => setRw(null)} />}
    </>
  );
}

function Rules() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('loyalty:edit');
  const [f, setF] = useState({ per: db.loyalty.earnBahtPerPoint, exp: db.loyalty.expiryMonths, pv: db.org.pointValue, mult: JSON.stringify(db.loyalty.categoryMultipliers) });
  const cats = Array.from(new Set(db.products.filter((p) => ['resale', 'finished', 'menu'].includes(p.kind)).map((p) => p.category)));
  return (
    <div className="grid g2">
      <Card title="Earning & expiry">
        <div className="form-grid">
          <Field label="Baht per 1 point"><NumInput value={f.per} onChange={(n) => setF({ ...f, per: n })} /></Field>
          <Field label="Expiry (months)"><NumInput value={f.exp} onChange={(n) => setF({ ...f, exp: n })} /></Field>
          <Field label="Liability value per point (฿)" hint="Used only for the outstanding-points estimate"><NumInput value={f.pv} onChange={(n) => setF({ ...f, pv: n })} /></Field>
          <Field label="Category multipliers (JSON)" hint={`Categories: ${cats.join(', ')}`}><Input value={f.mult} onChange={(e) => setF({ ...f, mult: e.target.value })} /></Field>
        </div>
        <div className="mt16"><Button variant="primary" disabled={!canEdit} onClick={() => run((d) => { const m = JSON.parse(f.mult); d.loyalty.earnBahtPerPoint = f.per; d.loyalty.expiryMonths = f.exp; d.loyalty.categoryMultipliers = m; d.org.pointValue = f.pv; }, { ok: 'Rules saved — applies to new orders', perm: 'loyalty:edit' })}><Tx>Save rules</Tx></Button></div>
      </Card>
      <Card title="Tiers"><table className="t compact"><thead><tr><th><Tx>Tier</Tx></th><th className="num"><Tx>Lifetime spend ≥</Tx></th><th className="num"><Tx>Multiplier</Tx></th></tr></thead><tbody>{db.loyalty.tiers.map((t) => <tr key={t.name}><td><b style={{ color: t.color }}>{t.name}</b></td><td className="num">{money0(t.minSpend)}</td><td className="num">×{t.multiplier}</td></tr>)}</tbody></table>
        <div className="muted mt8" style={{ fontSize: 12.5 }}><Tx>Points = floor( Σ line net ÷ baht-per-point × category multiplier × tier multiplier × (1 + promo multiplier) ). Promotions can add bonus points or double-points days.</Tx></div></Card>
    </div>
  );
}

function AdjustModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [cid, setCid] = useState('');
  const [pts, setPts] = useState(0);
  const [reason, setReason] = useState('');
  return (
    <Modal title="Manual points adjustment" size="sm" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!cid || !pts || !reason.trim()} onClick={() => run((d, c) => adjustPoints(d, c, cid, pts, reason), { ok: 'Points adjusted (audited)', perm: 'loyalty:edit', onOk: onClose })}><Tx>Apply</Tx></Button></>}>
      <div className="col">
        <Field label="Customer"><Select value={cid} onChange={(e) => setCid(e.target.value)}><option value="">Select…</option>{db.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Points (+ add, − deduct)"><NumInput value={pts || ''} onChange={(n) => setPts(isNaN(n) ? 0 : Math.round(n))} /></Field>
        <Field label="Reason (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Banner tone="warn"><Tx>Every manual adjustment is written to the audit log with your name.</Tx></Banner>
      </div>
    </Modal>
  );
}

function RewardModal({ r, onClose }: { r: Reward | null; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [f, setF] = useState<Reward>(r ?? { id: '', name: '', description: '', cost: 300, stock: null, active: true, emoji: '🎁', kind: 'coupon', couponKind: 'fixed', couponValue: 50 });
  return (
    <Modal title={r ? 'Edit reward' : 'New reward'} onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!f.name || f.cost <= 0} onClick={() => run((d) => { if (r) Object.assign(d.rewards.find((x) => x.id === r.id)!, f); else d.rewards.push({ ...f, id: 'RW' + (d.rewards.length + 10) }); }, { ok: 'Reward saved', perm: 'loyalty:edit', onOk: onClose })}><Tx>Save</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Emoji"><Input value={f.emoji} onChange={(e) => setF({ ...f, emoji: e.target.value })} /></Field>
        <Field label="Description" full><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Points cost"><NumInput value={f.cost} onChange={(n) => setF({ ...f, cost: n })} /></Field>
        <Field label="Stock (blank = unlimited)"><NumInput value={f.stock ?? ''} onChange={(n) => setF({ ...f, stock: isNaN(n) ? null : n })} /></Field>
        <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Reward['kind'] })}><option value="coupon">Coupon / discount</option><option value="item">Free item</option></Select></Field>
        {f.kind === 'coupon' ? <>
          <Field label="Coupon kind"><Select value={f.couponKind} onChange={(e) => setF({ ...f, couponKind: e.target.value as 'percent' | 'fixed' })}><option value="fixed">฿ amount</option><option value="percent">% off</option></Select></Field>
          <Field label="Value"><NumInput value={f.couponValue ?? 0} onChange={(n) => setF({ ...f, couponValue: n })} /></Field>
        </> : <Field label="Free product"><Select value={f.productId ?? ''} onChange={(e) => setF({ ...f, productId: e.target.value })}><option value="">Select…</option>{db.products.filter((p) => ['resale', 'finished', 'menu'].includes(p.kind) && isUsable(p, f.productId)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>}
      </div>
    </Modal>
  );
}
export const _l = Sparkles;
