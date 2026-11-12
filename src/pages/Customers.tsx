import { useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Plus, Download, Mail, Phone, ShieldCheck } from 'lucide-react';
import { useDB } from '../domain/store';
import { addCustomer, updateCustomer } from '../domain/master';
import { agingFor, customerCredit, customerOutstanding, allocatedMap, customerStatement } from '../domain/payments';
import { customerLifetimeSpend, lifetimeSpendMap, pointsBalance, pointsMap, tierFor } from '../domain/loyalty';
import { Badge, Button, Card, DataTable, Drawer, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Check, useHas, useRun, StatusBadge, ChannelChip } from '../ui/kit';
import { dateFmt, dateTimeFmt, download, money, money0, toCSV, dayKey } from '../lib/util';
import type { Customer, ID } from '../domain/types';
import { OrderDrawer } from './OrderDetail';
import { CHANNELS } from '../domain/meta';

export default function Customers() {
  const db = useDB();
  const [sp, setSp] = useSearchParams();
  const canCreate = useHas('customers:create');
  const canExport = useHas('customers:export');
  const [adding, setAdding] = useState(false);
  const [group, setGroup] = useState<string>('');
  const spend = useMemo(() => lifetimeSpendMap(db), [db.orders]);
  const pts = useMemo(() => pointsMap(db), [db.pointsLedger]);
  const alloc = useMemo(() => allocatedMap(db), [db.allocations]);
  const rows = db.customers.filter((c) => !group || c.group === group);
  const openId = sp.get('c');
  const outMap = useMemo(() => Object.fromEntries(db.customers.map((c) => [c.id, customerOutstanding(db, c.id, alloc)])), [db.orders, db.allocations, db.customers]); // eslint-disable-line

  return (
    <>
      <PageHead title="Customers" desc="Profiles, membership tiers, purchase history, credit terms, balances and consent — one record shared by POS, LINE and receivables."
        actions={<>{canExport && <Button onClick={() => download('customers.csv', toCSV([['Code', 'Name', 'Phone', 'Group', 'Lifetime spend', 'Points', 'Outstanding'], ...db.customers.map((c) => [c.code, c.name, c.phone, c.group, spend[c.id] || 0, pts[c.id] || 0, outMap[c.id]])]))}><Download size={15} /> Export</Button>}{canCreate && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> New customer</Button>}</>} />
      <div className="grid g4 mb16">
        <Kpi label="Customers" value={db.customers.length} sub={`${db.customers.filter((c) => c.group === 'wholesale').length} wholesale accounts`} />
        <Kpi label="Outstanding balances" value={money0(Object.values(outMap).reduce((s, x) => s + x, 0))} sub={`${Object.values(outMap).filter((x) => x > 0).length} customers owe`} />
        <Kpi label="Marketing consent" value={`${db.customers.filter((c) => c.consent.marketing).length}/${db.customers.length}`} sub="opted in (PDPA)" />
        <Kpi label="Points outstanding" value={Object.values(pts).reduce((s, x) => s + x, 0).toLocaleString()} sub="liability estimate in Loyalty" />
      </div>
      <Card flush>
        <DataTable rows={rows} rowKey={(c) => c.id} pageSize={14} onRow={(c) => setSp({ c: c.id })} search={(c) => `${c.name} ${c.phone} ${c.code} ${c.email ?? ''}`}
          toolbar={<Select sm style={{ width: 'auto' }} value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All groups</option><option value="retail">Retail</option><option value="vip">VIP</option><option value="wholesale">Wholesale</option><option value="staff">Staff</option></Select>}
          cols={[
            { key: 'n', header: 'Customer', sort: (c) => c.name, render: (c) => <><b>{c.name}</b><div className="sub">{c.code} · {c.phone}</div></> },
            { key: 'g', header: 'Group', render: (c) => <Badge tone={c.group === 'wholesale' ? 'info' : c.group === 'vip' ? 'warn' : ''}>{c.group}</Badge> },
            { key: 't', header: 'Tier', hideSm: true, render: (c) => { const t = tierFor(db, spend[c.id] || 0); return <span style={{ color: t.color, fontWeight: 600 }}>{t.name}</span>; } },
            { key: 's', header: 'Lifetime spend', num: true, sort: (c) => spend[c.id] || 0, render: (c) => money0(spend[c.id] || 0) },
            { key: 'p', header: 'Points', num: true, hideSm: true, sort: (c) => pts[c.id] || 0, render: (c) => (pts[c.id] || 0).toLocaleString() },
            { key: 'o', header: 'Outstanding', num: true, sort: (c) => outMap[c.id], render: (c) => (outMap[c.id] > 0 ? <b className="bad">{money(outMap[c.id])}</b> : <span className="muted">–</span>) },
          ]} />
      </Card>
      {adding && <CustomerForm onClose={() => setAdding(false)} />}
      {openId && <CustomerDrawer id={openId} onClose={() => setSp({})} />}
    </>
  );
}

function CustomerForm({ onClose, c }: { onClose: () => void; c?: Customer }) {
  const run = useRun();
  const canCredit = useHas('receivables:approve');
  const [f, setF] = useState({ name: c?.name ?? '', phone: c?.phone ?? '', email: c?.email ?? '', group: (c?.group ?? 'retail') as Customer['group'], creditLimit: c?.creditLimit ?? 0, creditDays: c?.creditDays ?? 0, address: c?.address ?? '', marketing: c?.consent.marketing ?? false });
  return (
    <Modal title={c ? 'Edit customer' : 'New customer'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => run((d, ctx) => {
      if (c) { updateCustomer(d, ctx, c.id, { name: f.name, phone: f.phone, email: f.email, group: f.group, creditLimit: f.creditLimit, creditDays: f.creditDays, address: f.address, consent: { ...c.consent, marketing: f.marketing, at: f.marketing !== c.consent.marketing ? ctx.now : c.consent.at } }); return c.id; }
      return addCustomer(d, ctx, { ...f });
    }, { ok: c ? 'Customer updated' : 'Customer created', onOk: onClose })}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Group"><Select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value as Customer['group'] })}><option value="retail">Retail</option><option value="vip">VIP</option><option value="wholesale">Wholesale</option><option value="staff">Staff</option></Select></Field>
        <Field label="Credit limit (฿)" hint={canCredit ? 'Needs approval permission to change' : 'Requires receivables approval permission'}><NumInput value={f.creditLimit} disabled={!canCredit} onChange={(n) => setF({ ...f, creditLimit: n || 0 })} /></Field>
        <Field label="Credit terms (days)"><NumInput value={f.creditDays} disabled={!canCredit} onChange={(n) => setF({ ...f, creditDays: n || 0 })} /></Field>
        <Field label="Address" full><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <div className="full"><Check checked={f.marketing} onChange={(v) => setF({ ...f, marketing: v })}>Customer consents to marketing messages (recorded with a timestamp)</Check></div>
      </div>
    </Modal>
  );
}

export function CustomerDrawer({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDB();
  const canEdit = useHas('customers:edit');
  const [tab, setTab] = useState<'overview' | 'orders' | 'statement' | 'points'>('overview');
  const [edit, setEdit] = useState(false);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const c = db.customers.find((x) => x.id === id);
  const alloc = useMemo(() => allocatedMap(db), [db.allocations]);
  if (!c) return null;
  const spend = customerLifetimeSpend(db, c.id);
  const tier = tierFor(db, spend);
  const out = customerOutstanding(db, c.id, alloc);
  const credit = customerCredit(db, c.id);
  const orders = db.orders.filter((o) => o.customerId === c.id).reverse();
  const st = customerStatement(db, c.id);
  const aging = agingFor(db, new Date().toISOString(), () => c.creditDays)[c.id];
  const ledger = db.pointsLedger.filter((p) => p.customerId === c.id).reverse();
  const entitlements = db.entitlements.filter((e) => e.customerId === c.id);
  return (
    <Drawer title={c.name} sub={`${c.code} · ${c.group}`} onClose={onClose} footer={canEdit && <Button onClick={() => setEdit(true)}>Edit</Button>}>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'overview', label: 'Overview' }, { v: 'orders', label: 'Orders', count: orders.length }, { v: 'statement', label: 'Statement' }, { v: 'points', label: 'Points' }]} />
      {tab === 'overview' && (
        <div className="col gap-16">
          <div className="grid g2" style={{ gap: 10 }}>
            <Kpi label="Lifetime spend" value={money0(spend)} sub={<span style={{ color: tier.color, fontWeight: 650 }}>{tier.name} tier</span>} />
            <Kpi label="Points" value={pointsBalance(db, c.id).toLocaleString()} sub={`${entitlements.filter((e) => e.status === 'available').length} unused event picks`} />
            <Kpi label="Outstanding" value={money(out)} tone={out > 0 ? 'bad' : undefined} sub={c.creditLimit ? `limit ${money0(c.creditLimit)} · ${c.creditDays} days` : 'no credit terms'} />
            <Kpi label="Customer credit" value={money(credit)} sub="unapplied receipts" tone={credit > 0 ? 'good' : undefined} />
          </div>
          {aging && (
            <Card title="Aging of outstanding balance" sub="relative to credit terms">
              <div className="grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, textAlign: 'center' }}>{['Current', '1–30', '31–60', '61–90', '90+'].map((l, i) => <div key={l}><div className="muted" style={{ fontSize: 11.5 }}>{l}</div><b className={i > 1 && aging[i] > 0 ? 'bad' : ''}>{money0(aging[i])}</b></div>)}</div>
            </Card>
          )}
          <Card title="Contact & consent">
            <div className="col gap-6">
              <div className="row gap-6"><Phone size={14} /> {c.phone}</div>
              {c.email && <div className="row gap-6"><Mail size={14} /> {c.email}</div>}
              {c.address && <div className="muted">{c.address}</div>}
              <div className="row gap-6"><ShieldCheck size={14} /> PDPA consent recorded {dateFmt(c.consent.at)} · marketing: <Badge tone={c.consent.marketing ? 'good' : ''}>{c.consent.marketing ? 'opted in' : 'not opted in'}</Badge></div>
              {c.lineUserId && <div className="muted mono">LINE {c.lineUserId}</div>}
            </div>
          </Card>
        </div>
      )}
      {tab === 'orders' && (
        <DataTable rows={orders} rowKey={(o) => o.id} pageSize={10} compact onRow={(o) => setOpenOrder(o.id)} cols={[
          { key: 'no', header: 'Order', render: (o) => <><b>{o.no}</b><div className="sub">{dateTimeFmt(o.createdAt)}</div></> }, { key: 'ch', header: 'Channel', render: (o) => <ChannelChip c={o.channel} /> },
          { key: 'st', header: 'Status', render: (o) => <StatusBadge status={o.status} /> }, { key: 't', header: 'Total', num: true, render: (o) => money(o.total) }]} />
      )}
      {tab === 'statement' && (
        <div className="col">
          <div className="row between"><div><div className="muted">Closing balance</div><b style={{ fontSize: 22 }} className={st.closing > 0 ? 'bad' : ''}>{money(st.closing)}</b></div><Link to={`/receivables?c=${c.id}`}><Button>Receive payment</Button></Link></div>
          <DataTable rows={[...st.rows].reverse()} rowKey={(r) => r.ref + r.type + r.date} pageSize={12} compact cols={[
            { key: 'd', header: 'Date', render: (r) => dateFmt(r.date) }, { key: 'r', header: 'Document', render: (r) => <>{r.ref}<div className="sub">{r.type.replace('_', ' ')} {r.note}</div></> },
            { key: 'db', header: 'Charge', num: true, render: (r) => (r.debit ? money(r.debit) : '') }, { key: 'cr', header: 'Credit', num: true, render: (r) => (r.credit ? money(r.credit) : '') }, { key: 'b', header: 'Balance', num: true, render: (r) => money(r.balance) }]} />
        </div>
      )}
      {tab === 'points' && (
        <DataTable rows={ledger} rowKey={(p) => p.id} pageSize={12} compact cols={[
          { key: 'd', header: 'Date', render: (p) => dateFmt(p.ts) }, { key: 't', header: 'Type', render: (p) => <Badge tone={p.points > 0 ? 'good' : ''}>{p.type}</Badge> }, { key: 'n', header: 'Note', render: (p) => p.note ?? '' },
          { key: 'p', header: 'Points', num: true, render: (p) => <b className={p.points > 0 ? 'good' : 'bad'}>{p.points > 0 ? '+' : ''}{p.points}</b> }]} />
      )}
      {edit && <CustomerForm c={c} onClose={() => setEdit(false)} />}
      {openOrder && <OrderDrawer id={openOrder} onClose={() => setOpenOrder(null)} />}
    </Drawer>
  );
}
export const _u = [dayKey, CHANNELS];
