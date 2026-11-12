import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRightLeft, ClipboardList, Plus, SlidersHorizontal, Truck } from 'lucide-react';
import { useDB } from '../domain/store';
import { adjustStock, closeTransferShort, createTransfer, inTransitQty, inTransitValue, lotsFor, postCount, receiveTransfer, reconcileStock, reservedMap, startCount, stockValue, bkey } from '../domain/inventory';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Seg, Tabs, Textarea, useConfirm, useHas, useRun } from '../ui/kit';
import { HBars } from '../ui/charts';
import { cx, dateFmt, dateTimeFmt, daysBetween, money, money0, qtyFmt, r3 } from '../lib/util';
import type { ID, MoveType } from '../domain/types';
import { lowStock } from '../ui/data';

type Tab = 'stock' | 'movements' | 'transfers' | 'counts' | 'lots' | 'valuation';
const MOVE_TONE: Record<string, 'good' | 'bad' | 'info' | 'warn' | ''> = { receipt: 'good', sale: '', backflush: '', adjust: 'warn', count: 'warn', transfer_out: 'info', transfer_in: 'info', prod_issue: '', prod_output: 'good', waste: 'bad', return_in: 'good', return_out: 'bad', opening: '' };

export default function Inventory() {
  const db = useDB();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'stock';
  const canCreate = useHas('inventory:create');
  const canCost = useHas('finance:cost');
  const [wh, setWh] = useState('');
  const [kind, setKind] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [adj, setAdj] = useState(false);
  const [tr, setTr] = useState(false);
  const reserved = useMemo(() => reservedMap(db), [db.orders]);
  const low = useMemo(() => lowStock(db), [db]);
  const rows = useMemo(() => {
    const out: { p: typeof db.products[number]; w: typeof db.warehouses[number]; qty: number; value: number; res: number; min?: number; max?: number; transit: number }[] = [];
    for (const p of db.products) {
      if (p.kind === 'menu' || (kind && p.kind !== kind)) continue;
      for (const w of db.warehouses) {
        if (wh && w.id !== wh) continue;
        const b = db.balances[bkey(w.id, p.id)];
        const lv = p.levels[w.id];
        if (!b?.qty && !lv) continue;
        out.push({ p, w, qty: b?.qty ?? 0, value: b?.value ?? 0, res: reserved[bkey(w.id, p.id)] || 0, min: lv?.min, max: lv?.max, transit: inTransitQty(db, p.id, w.id) });
      }
    }
    return onlyLow ? out.filter((r) => r.min != null && r.qty < r.min) : out;
  }, [db.balances, db.products, db.transfers, reserved, wh, kind, onlyLow]); // eslint-disable-line
  const total = stockValue(db);
  const recon = useMemo(() => reconcileStock(db), [db.movements, db.balances]);

  return (
    <>
      <PageHead title="Inventory & warehouses" desc="Every stock change is an immutable movement. Balances are a projection that must reconcile to the ledger — see the check on the Valuation tab."
        actions={canCreate && <><Button onClick={() => setAdj(true)}><SlidersHorizontal size={15} /> Adjust / waste</Button><Button variant="primary" onClick={() => setTr(true)}><ArrowRightLeft size={15} /> New transfer</Button></>} />
      <div className="grid g4 mb16">
        <Kpi label="Stock value" value={money0(total)} sub={`+ ${money0(inTransitValue(db))} in transit`} />
        <Kpi label="Below reorder level" value={low.length} tone={low.length ? 'bad' : 'good'} sub="across all warehouses" />
        <Kpi label="Movements recorded" value={db.movements.length.toLocaleString()} sub="append-only ledger" />
        <Kpi label="Ledger reconciliation" value={recon.diffs.length ? `${recon.diffs.length} diffs` : 'OK'} tone={recon.diffs.length ? 'bad' : 'good'} sub={`${recon.checked} balances checked`} />
      </div>
      <Tabs value={tab} onChange={(t) => setSp({ tab: t })} tabs={[{ v: 'stock', label: 'Stock levels' }, { v: 'movements', label: 'Movement ledger' }, { v: 'transfers', label: 'Transfers', count: db.transfers.filter((t) => t.status === 'in_transit' || t.status === 'partial').length || '' }, { v: 'counts', label: 'Stock counts' }, { v: 'lots', label: 'Lots & expiry' }, { v: 'valuation', label: 'Valuation' }]} />

      {tab === 'stock' && (
        <Card flush>
          <DataTable rows={rows} rowKey={(r) => r.p.id + r.w.id} pageSize={16} search={(r) => `${r.p.name} ${r.p.sku}`}
            toolbar={<><Select sm style={{ width: 'auto' }} value={wh} onChange={(e) => setWh(e.target.value)}><option value="">All warehouses</option>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select><Select sm style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option><option value="material">Raw materials</option><option value="packaging">Packaging</option><option value="finished">Finished goods</option><option value="resale">Resale</option></Select><label className="check"><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Low only</label></>}
            cols={[
              { key: 'p', header: 'Item', sort: (r) => r.p.name, render: (r) => <><b>{r.p.name}</b><div className="sub">{r.p.sku}</div></> },
              { key: 'w', header: 'Warehouse', hideSm: true, sort: (r) => r.w.name, render: (r) => r.w.name },
              { key: 'q', header: 'On hand', num: true, sort: (r) => r.qty, render: (r) => <span className={cx(r.min != null && r.qty < r.min && 'bad')}>{qtyFmt(r.qty)} {r.p.unit}</span> },
              { key: 'r', header: 'Reserved', num: true, hideSm: true, render: (r) => (r.res ? qtyFmt(r.res) : '–') },
              { key: 'a', header: 'Available', num: true, render: (r) => qtyFmt(r3(r.qty - r.res)) },
              { key: 't', header: 'In transit', num: true, hideSm: true, render: (r) => (r.transit ? qtyFmt(r.transit) : '–') },
              { key: 'lv', header: 'Min / Max', num: true, hideSm: true, render: (r) => (r.min != null ? `${qtyFmt(r.min)} / ${qtyFmt(r.max ?? 0)}` : '–') },
              ...(canCost ? [{ key: 'v', header: 'Value', num: true, sort: (r: { value: number }) => r.value, render: (r: { value: number }) => money(r.value) }] : []),
              { key: 's', header: '', render: (r) => (r.min != null && r.qty < r.min ? <Badge tone="bad"><AlertTriangle size={11} /> reorder</Badge> : <Badge tone="good">ok</Badge>) },
            ]} />
        </Card>
      )}
      {tab === 'movements' && <Movements />}
      {tab === 'transfers' && <Transfers />}
      {tab === 'counts' && <Counts />}
      {tab === 'lots' && <Lots />}
      {tab === 'valuation' && (
        <div className="grid g2">
          <Card title="Value by warehouse"><HBars items={db.warehouses.map((w) => ({ label: w.name, value: stockValue(db, w.id) }))} fmt={money0} /></Card>
          <Card title="Ledger ↔ balance reconciliation">
            {recon.diffs.length === 0 ? <Banner tone="good">All {recon.checked} balances equal the sum of their movements (quantity and value).</Banner> : <Banner tone="bad">{recon.diffs.length} differences found.</Banner>}
            <div className="muted mt8" style={{ fontSize: 13 }}>Costing method: <b>weighted average</b> per product and warehouse. Transfers carry cost; production output absorbs materials + labor + overhead; waste is expensed; landed costs are allocated into receipts.</div>
          </Card>
        </div>
      )}
      {adj && <AdjustModal onClose={() => setAdj(false)} />}
      {tr && <TransferModal onClose={() => setTr(false)} />}
    </>
  );
}

function Movements() {
  const db = useDB();
  const [type, setType] = useState('');
  const [pid, setPid] = useState('');
  const canCost = useHas('finance:cost');
  const rows = useMemo(() => db.movements.filter((m) => (!type || m.type === type) && (!pid || m.productId === pid)).slice().reverse(), [db.movements, type, pid]);
  const types = Array.from(new Set(db.movements.map((m) => m.type)));
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(m) => m.id} pageSize={16}
        toolbar={<><Select sm style={{ width: 'auto' }} value={pid} onChange={(e) => setPid(e.target.value)}><option value="">All products</option>{db.products.filter((p) => p.kind !== 'menu').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><Select sm style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}</Select></>}
        cols={[
          { key: 'd', header: 'Time', render: (m) => dateTimeFmt(m.ts) },
          { key: 'p', header: 'Item', render: (m) => <><b>{db.products.find((p) => p.id === m.productId)?.name}</b><div className="sub">{db.warehouses.find((w) => w.id === m.warehouseId)?.name}</div></> },
          { key: 't', header: 'Type', render: (m) => <Badge tone={MOVE_TONE[m.type as MoveType]}>{m.type.replace('_', ' ')}</Badge> },
          { key: 'q', header: 'Qty', num: true, render: (m) => <b className={m.qty > 0 ? 'good' : 'bad'}>{m.qty > 0 ? '+' : ''}{qtyFmt(m.qty)}</b> },
          ...(canCost ? [{ key: 'v', header: 'Value', num: true, render: (m: { value: number }) => money(m.value) }] : []),
          { key: 'r', header: 'Reference', hideSm: true, render: (m) => <span className="muted">{m.refType} {m.note ?? ''}{m.lot ? ` · lot ${m.lot}` : ''}</span> },
        ]} />
    </Card>
  );
}

function Transfers() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canEdit = useHas('inventory:edit');
  const [recv, setRecv] = useState<ID | null>(null);
  return (
    <Card flush>
      <DataTable rows={[...db.transfers].reverse()} rowKey={(t) => t.id} pageSize={10} empty={<Empty icon={<Truck size={22} />} title="No transfers yet" hint="Create a transfer to move stock between warehouses with an in-transit stage." />}
        cols={[
          { key: 'no', header: 'Transfer', render: (t) => <><b>{t.no}</b><div className="sub">{dateTimeFmt(t.createdAt)}</div></> },
          { key: 'r', header: 'Route', render: (t) => <>{db.warehouses.find((w) => w.id === t.fromWh)?.name} → {db.warehouses.find((w) => w.id === t.toWh)?.name}</> },
          { key: 'l', header: 'Lines', render: (t) => t.lines.map((l) => `${qtyFmt(l.receivedQty)}/${qtyFmt(l.qty)} ${db.products.find((p) => p.id === l.productId)?.name}`).slice(0, 2).join(', ') + (t.lines.length > 2 ? ` +${t.lines.length - 2}` : '') },
          { key: 's', header: 'Status', render: (t) => <Badge tone={t.status === 'received' ? 'good' : t.status === 'closed_short' ? 'bad' : 'warn'} dot>{t.status.replace('_', ' ')}</Badge> },
          { key: 'a', header: '', render: (t) => (t.status === 'in_transit' || t.status === 'partial') && canEdit ? <div className="row gap-4"><Button size="sm" variant="primary" onClick={() => setRecv(t.id)}>Receive</Button><Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: 'Close short?', body: 'Remaining quantities are written off as inventory loss.', reason: true, danger: true, confirmLabel: 'Close short' }); if (x.ok) run((d, c) => closeTransferShort(d, c, t.id, x.reason), { ok: 'Closed short — loss posted' }); }}>Close short</Button></div> : null },
        ]} />
      {recv && <ReceiveTransfer id={recv} onClose={() => setRecv(null)} />}
    </Card>
  );
}
function ReceiveTransfer({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const t = db.transfers.find((x) => x.id === id)!;
  const [q, setQ] = useState<Record<ID, number>>(() => Object.fromEntries(t.lines.map((l) => [l.productId, r3(l.qty - l.receivedQty - (l.shortClosed || 0))])));
  return (
    <Modal title={`Receive ${t.no}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => run((d, c) => receiveTransfer(d, c, id, Object.entries(q).map(([productId, qty]) => ({ productId, qty }))), { ok: 'Stock received', perm: 'inventory:edit', onOk: onClose })}>Confirm receipt</Button></>}>
      <div className="muted mb8">Enter what actually arrived. A partial receipt leaves the rest in transit.</div>
      <table className="t compact"><thead><tr><th>Item</th><th className="num">Sent</th><th className="num">Outstanding</th><th className="num">Receive now</th></tr></thead>
        <tbody>{t.lines.map((l) => { const out = r3(l.qty - l.receivedQty - (l.shortClosed || 0)); const p = db.products.find((x) => x.id === l.productId)!; return <tr key={l.productId}><td>{p.name}</td><td className="num">{qtyFmt(l.qty)}</td><td className="num">{qtyFmt(out)}</td><td className="num"><NumInput style={{ width: 90 }} value={q[l.productId] ?? 0} disabled={out <= 0} onChange={(n) => setQ({ ...q, [l.productId]: Math.min(out, Math.max(0, n || 0)) })} /> {p.unit}</td></tr>; })}</tbody></table>
    </Modal>
  );
}

function Counts() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('inventory:approve');
  const [open, setOpen] = useState<ID | null>(null);
  const [wh, setWh] = useState(db.warehouses[0].id);
  return (
    <div className="col gap-16">
      {canEdit && <Card title="Start a stock count"><div className="row"><Select style={{ width: 260 }} value={wh} onChange={(e) => setWh(e.target.value)}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select><Button variant="primary" onClick={() => run((d, c) => startCount(d, c, wh), { ok: 'Count sheet created', onOk: (id) => setOpen(id) })}><ClipboardList size={15} /> Create count sheet</Button></div></Card>}
      <Card flush><DataTable rows={[...db.counts].reverse()} rowKey={(c) => c.id} empty={<Empty title="No counts yet" />}
        cols={[{ key: 'no', header: 'Count', render: (c) => <b>{c.no}</b> }, { key: 'w', header: 'Warehouse', render: (c) => db.warehouses.find((w) => w.id === c.warehouseId)?.name }, { key: 'd', header: 'Created', render: (c) => dateTimeFmt(c.createdAt) }, { key: 's', header: 'Status', render: (c) => <Badge tone={c.status === 'posted' ? 'good' : 'warn'} dot>{c.status}</Badge> }, { key: 'v', header: 'Variances', num: true, render: (c) => c.lines.filter((l) => l.countedQty != null && Math.abs(l.countedQty - l.systemQty) > 0.0005).length },
          { key: 'a', header: '', render: (c) => <Button size="sm" onClick={() => setOpen(c.id)}>{c.status === 'open' ? 'Enter counts' : 'View'}</Button> }]} /></Card>
      {open && <CountSheet id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
function CountSheet({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const canCost = useHas('finance:cost');
  const c = db.counts.find((x) => x.id === id)!;
  const [v, setV] = useState<Record<ID, number | null>>(() => Object.fromEntries(c.lines.map((l) => [l.productId, l.countedQty])));
  const diffs = c.lines.filter((l) => v[l.productId] != null && Math.abs((v[l.productId] ?? 0) - l.systemQty) > 0.0005);
  return (
    <Modal title={`Stock count ${c.no}`} desc={db.warehouses.find((w) => w.id === c.warehouseId)?.name} size="lg" onClose={onClose} footer={c.status === 'open' ? <><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => run((d, ctx) => postCount(d, ctx, id, v), { ok: 'Count posted — adjustments recorded', perm: 'inventory:approve', onOk: onClose })}>Post count ({diffs.length} variance{diffs.length === 1 ? '' : 's'})</Button></> : <Button onClick={onClose}>Close</Button>}>
      <div className="table-wrap max"><table className="t compact"><thead><tr><th>Item</th><th className="num">System</th><th className="num">Counted</th><th className="num">Variance</th></tr></thead>
        <tbody>{c.lines.map((l) => { const p = db.products.find((x) => x.id === l.productId)!; const cv = v[l.productId]; const diff = cv == null ? null : r3(cv - l.systemQty); return (
          <tr key={l.productId}><td>{p.name}</td><td className="num">{qtyFmt(l.systemQty)}</td><td className="num">{c.status === 'open' ? <input className="input sm" type="number" step="any" style={{ width: 90, textAlign: 'right' }} value={cv ?? ''} onChange={(e) => setV({ ...v, [l.productId]: e.target.value === '' ? null : Number(e.target.value) })} /> : qtyFmt(l.countedQty ?? 0)}</td><td className={cx('num', diff ? (diff < 0 ? 'bad' : 'good') : '')}>{diff == null ? '' : diff === 0 ? '–' : (diff > 0 ? '+' : '') + qtyFmt(diff)}</td></tr>); })}</tbody></table></div>
      {canCost && <div className="muted mt8" style={{ fontSize: 12 }}>Variances are valued at weighted-average cost and posted to Inventory adjustments & shrinkage.</div>}
    </Modal>
  );
}

function Lots() {
  const db = useDB();
  const lots = useMemo(() => lotsFor(db), [db.movements]);
  return (
    <Card flush title="Lots & expiry (first-expired-first-out)" sub="Derived from receipts with a lot number; consumption is allocated to the earliest expiry first.">
      <DataTable rows={lots} rowKey={(l) => l.productId + l.warehouseId + l.lot} pageSize={14} empty={<Empty title="No lot-tracked stock" />}
        cols={[
          { key: 'p', header: 'Item', render: (l) => <b>{db.products.find((p) => p.id === l.productId)?.name}</b> }, { key: 'w', header: 'Warehouse', render: (l) => db.warehouses.find((w) => w.id === l.warehouseId)?.name }, { key: 'l', header: 'Lot', render: (l) => <span className="mono">{l.lot}</span> },
          { key: 'e', header: 'Expiry', render: (l) => (l.expiry ? dateFmt(l.expiry) : '–') }, { key: 'r', header: 'Remaining', num: true, render: (l) => qtyFmt(l.remaining) },
          { key: 's', header: '', render: (l) => { if (!l.expiry) return null; const d = daysBetween(new Date(), l.expiry); return d < 0 ? <Badge tone="bad">expired</Badge> : d <= 5 ? <Badge tone="warn">{d} days left</Badge> : <Badge tone="good">{d} days</Badge>; } },
        ]} />
    </Card>
  );
}

function AdjustModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [f, setF] = useState({ productId: '', warehouseId: db.warehouses[0].id, qty: 0, reason: '', kind: 'waste' as 'adjust' | 'waste' });
  const p = db.products.find((x) => x.id === f.productId);
  const bal = p ? db.balances[bkey(f.warehouseId, p.id)]?.qty ?? 0 : 0;
  return (
    <Modal title="Stock adjustment / waste" size="sm" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.productId || !f.qty || !f.reason.trim()} onClick={() => run((d, c) => adjustStock(d, c, { ...f, qty: f.kind === 'waste' ? -Math.abs(f.qty) : f.qty }), { ok: 'Adjustment posted (audited)', perm: 'inventory:create', onOk: onClose })}>Post</Button></>}>
      <div className="col">
        <Seg value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ v: 'waste', label: 'Waste / spoilage' }, { v: 'adjust', label: 'Correction (+/−)' }]} />
        <Field label="Warehouse"><Select value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="Item"><Select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}><option value="">Select…</option>{db.products.filter((x) => x.kind !== 'menu').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label={f.kind === 'waste' ? `Quantity wasted${p ? ` (${p.unit})` : ''}` : 'Quantity (+ add / − remove)'} hint={p ? `On hand: ${qtyFmt(bal)} ${p.unit}` : undefined}><NumInput value={f.qty || ''} onChange={(n) => setF({ ...f, qty: isNaN(n) ? 0 : n })} /></Field>
        <Field label="Reason (required)"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function TransferModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [from, setFrom] = useState('W3');
  const [to, setTo] = useState('W1');
  const [lines, setLines] = useState<{ productId: ID; qty: number }[]>([{ productId: '', qty: 0 }]);
  return (
    <Modal title="New stock transfer" size="lg" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => run((d, c) => createTransfer(d, c, { fromWh: from, toWh: to, lines: lines.filter((l) => l.productId && l.qty > 0) }), { ok: 'Dispatched — stock is now in transit', perm: 'inventory:create', onOk: onClose })}>Dispatch</Button></>}>
      <div className="form-grid">
        <Field label="From"><Select value={from} onChange={(e) => setFrom(e.target.value)}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="To"><Select value={to} onChange={(e) => setTo(e.target.value)}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
      </div>
      <div className="col mt16">
        {lines.map((l, i) => { const p = db.products.find((x) => x.id === l.productId); const have = p ? db.balances[bkey(from, p.id)]?.qty ?? 0 : 0; return (
          <div key={i} className="row"><Select value={l.productId} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, productId: e.target.value } : x)))}><option value="">Select item…</option>{db.products.filter((x) => x.kind !== 'menu' && (db.balances[bkey(from, x.id)]?.qty ?? 0) > 0).map((x) => <option key={x.id} value={x.id}>{x.name} ({qtyFmt(db.balances[bkey(from, x.id)].qty)} {x.unit})</option>)}</Select>
            <NumInput style={{ width: 100 }} value={l.qty || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, qty: Math.min(have, Math.max(0, n || 0)) } : x)))} /><span className="muted" style={{ width: 50 }}>{p?.unit}</span><Button icon variant="ghost" onClick={() => setLines(lines.filter((_, k) => k !== i))}>×</Button></div>); })}
        <div><Button size="sm" onClick={() => setLines([...lines, { productId: '', qty: 0 }])}><Plus size={14} /> Add line</Button></div>
        <div className="muted" style={{ fontSize: 12 }}>Stock leaves the source immediately and sits in <b>In transit</b> until the destination confirms receipt. Partial receipts are supported.</div>
      </div>
    </Modal>
  );
}
export const _i = [Input, Textarea];
