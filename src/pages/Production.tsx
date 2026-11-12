import { useMemo, useState } from 'react';
import { Factory, Lock, Plus, Trash2 } from 'lucide-react';
import { useDB } from '../domain/store';
import { activateVersion, bomForProduct, cancelProduction, completeProduction, createBom, createProductionOrder, discardDraft, newDraftVersion, prodTotals, recordProduction, rollup, updateDraft, versionAt } from '../domain/bom';
import { bkey, onHand } from '../domain/inventory';
import { Badge, Banner, Button, Card, DataTable, Drawer, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun } from '../ui/kit';
import { dateFmt, dateTimeFmt, money, money0, pct, qtyFmt, r2 } from '../lib/util';
import type { BomComponent, BomVersion, ID } from '../domain/types';

type Tab = 'boms' | 'orders' | 'costing';
const TYPE_LABEL = { manufacturing: 'Manufacturing', recipe: 'Recipe (F&B)', packaging: 'Packaging', assembly: 'Assembly' };

export default function Production() {
  const db = useDB();
  const canCost = useHas('finance:cost');
  const canCreate = useHas('production:create');
  const [tab, setTab] = useState<Tab>('boms');
  const [open, setOpen] = useState<ID | null>(null);
  const [newBom, setNewBom] = useState(false);
  const [newOrder, setNewOrder] = useState(false);
  const [rec, setRec] = useState<ID | null>(null);
  const now = new Date().toISOString();
  const rows = db.boms.map((b) => { const v = versionAt(b, now); return { b, v, r: v ? rollup(db, v) : null, p: db.products.find((p) => p.id === b.productId)! }; });
  const orders = [...db.productionOrders].reverse();
  const wasteCost = db.productionOrders.reduce((s, o) => s + prodTotals(o).wasteCost, 0);
  return (
    <>
      <PageHead title="BOM, recipes & production" desc="Versioned bills of materials. Active versions are immutable — change a recipe by creating a new version with an effective date, so historical costs never move."
        actions={canCreate && <><Button onClick={() => setNewBom(true)}><Plus size={15} /> New BOM</Button><Button variant="primary" onClick={() => setNewOrder(true)}><Factory size={15} /> New production order</Button></>} />
      <div className="grid g4 mb16">
        <Kpi label="BOMs" value={db.boms.length} sub={`${db.boms.filter((b) => b.type === 'recipe').length} recipes · ${db.boms.filter((b) => b.type !== 'recipe').length} manufacturing/packaging`} />
        <Kpi label="Production orders" value={db.productionOrders.length} sub={`${db.productionOrders.filter((o) => o.status !== 'completed' && o.status !== 'cancelled').length} open`} />
        <Kpi label="Output (units)" value={qtyFmt(db.productionOrders.reduce((s, o) => s + prodTotals(o).out, 0))} sub="all batches" />
        {canCost ? <Kpi label="Waste & spoilage" value={money0(wasteCost)} sub="expensed to 5100" /> : <Kpi label="Waste units" value={qtyFmt(db.productionOrders.reduce((s, o) => s + prodTotals(o).waste, 0))} sub="all batches" />}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'boms', label: 'BOMs & recipes', count: db.boms.length }, { v: 'orders', label: 'Production orders', count: orders.length }, ...(canCost ? [{ v: 'costing' as Tab, label: 'Costing vs standard' }] : [])]} />
      {tab === 'boms' && (
        <Card flush><DataTable rows={rows} rowKey={(r) => r.b.id} pageSize={14} onRow={(r) => setOpen(r.b.id)} search={(r) => r.p.name + r.b.name}
          cols={[
            { key: 'n', header: 'Product', sort: (r) => r.p.name, render: (r) => <div className="row"><span style={{ fontSize: 22 }}>{r.p.emoji}</span><div><b>{r.p.name}</b><div className="sub">{r.b.name}</div></div></div> },
            { key: 't', header: 'Type', hideSm: true, render: (r) => <Badge>{TYPE_LABEL[r.b.type]}</Badge> },
            { key: 'v', header: 'Version', render: (r) => <>v{r.v?.version}{r.b.versions.some((x) => x.status === 'draft') && <Badge tone="warn"> draft</Badge>}<div className="sub">{r.b.versions.length} version(s)</div></> },
            { key: 'y', header: 'Yield', num: true, render: (r) => `${qtyFmt(r.v?.yieldQty ?? 0)} ${r.p.unit}` },
            { key: 'c', header: 'Components', num: true, hideSm: true, render: (r) => r.v?.components.length },
            ...(canCost ? [{ key: 'u', header: 'Cost / unit', num: true, render: (r: typeof rows[number]) => <b>{money(r.r?.perUnit ?? 0)}</b> }, { key: 'm', header: 'Margin', num: true, render: (r: typeof rows[number]) => (r.p.price && r.r ? pct((r.p.price / 1.07 - r.r.perUnit) / (r.p.price / 1.07), 0) : <span className="muted">–</span>) }] : []),
          ]} /></Card>
      )}
      {tab === 'orders' && (
        <Card flush><DataTable rows={orders} rowKey={(o) => o.id} pageSize={12} empty={<Empty icon={<Factory size={22} />} title="No production orders" />}
          cols={[
            { key: 'no', header: 'Order', render: (o) => <><b>{o.no}</b><div className="sub">{dateTimeFmt(o.createdAt)}</div></> },
            { key: 'p', header: 'Product', render: (o) => <>{db.products.find((p) => p.id === o.productId)?.name}<div className="sub">BOM v{o.snapshot.version} (snapshot)</div></> },
            { key: 'q', header: 'Planned', num: true, render: (o) => qtyFmt(o.plannedQty) },
            { key: 'o', header: 'Output / waste', num: true, render: (o) => { const t = prodTotals(o); return <>{qtyFmt(t.out)} <span className="muted">/ {qtyFmt(t.waste)}</span></>; } },
            ...(canCost ? [{ key: 'u', header: 'Unit cost', num: true, render: (o: typeof orders[number]) => { const t = prodTotals(o); const std = db.products.find((p) => p.id === o.productId)?.stdCost ?? 0; return t.out ? <>{money(t.unitCost)}<div className={t.unitCost > std ? 'sub bad' : 'sub good'}>{t.unitCost > std ? '+' : ''}{money(t.unitCost - std)} vs std</div></> : '–'; } }] : []),
            { key: 's', header: 'Status', render: (o) => <Badge tone={o.status === 'completed' ? 'good' : o.status === 'in_progress' ? 'warn' : o.status === 'cancelled' ? 'bad' : 'info'} dot>{o.status.replace('_', ' ')}</Badge> },
            { key: 'a', header: '', render: (o) => canCreate && (o.status === 'planned' || o.status === 'in_progress') ? <Button size="sm" variant="primary" onClick={() => setRec(o.id)}>Record output</Button> : null },
          ]} /></Card>
      )}
      {tab === 'costing' && (
        <Card flush title="Standard vs current BOM vs last actual" sub="Where cost drifts away from plan"><DataTable rows={rows.filter((r) => r.r)} rowKey={(r) => r.b.id}
          cols={[
            { key: 'n', header: 'Product', render: (r) => <b>{r.p.name}</b> }, { key: 's', header: 'Standard', num: true, render: (r) => money(r.p.stdCost) }, { key: 'c', header: 'Current BOM', num: true, render: (r) => money(r.r!.perUnit) },
            { key: 'a', header: 'Last actual', num: true, render: (r) => { const o = db.productionOrders.filter((x) => x.productId === r.p.id && x.batches.length).pop(); return o ? money(prodTotals(o).unitCost) : '–'; } },
            { key: 'v', header: 'Variance (BOM − std)', num: true, render: (r) => <span className={r.r!.perUnit > r.p.stdCost ? 'bad' : 'good'}>{money(r.r!.perUnit - r.p.stdCost)}</span> },
            { key: 'p', header: 'Price', num: true, render: (r) => (r.p.price ? money(r.p.price) : '–') },
          ]} /></Card>
      )}
      {open && <BomDrawer id={open} onClose={() => setOpen(null)} />}
      {newBom && <NewBom onClose={() => setNewBom(false)} />}
      {newOrder && <NewOrder onClose={() => setNewOrder(false)} />}
      {rec && <RecordModal id={rec} onClose={() => setRec(null)} />}
    </>
  );
}

function BomDrawer({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canEdit = useHas('production:edit');
  const canCost = useHas('finance:cost');
  const b = db.boms.find((x) => x.id === id)!;
  const p = db.products.find((x) => x.id === b.productId)!;
  const sorted = [...b.versions].sort((a, c) => c.version - a.version);
  const [vn, setVn] = useState(sorted[0].version);
  const v = b.versions.find((x) => x.version === vn) ?? sorted[0];
  const [draft, setDraft] = useState<BomVersion | null>(null);
  const [eff, setEff] = useState(new Date().toISOString().slice(0, 10));
  const cur = draft && draft.version === v.version ? draft : v;
  const r = rollup(db, cur);
  const editable = v.status === 'draft' && canEdit;
  const setC = (comps: BomComponent[]) => setDraft({ ...cur, components: comps });
  return (
    <Drawer title={<span>{p.emoji} {b.name}</span>} sub={`${TYPE_LABEL[b.type]} · output: ${p.name}`} onClose={onClose}
      footer={<>
        {canEdit && !b.versions.some((x) => x.status === 'draft') && <Button onClick={() => run((d, c) => newDraftVersion(d, c, b.id), { ok: 'Draft version created', onOk: (n) => { setVn(n); setDraft(null); } })}><Plus size={14} /> New version</Button>}
        {editable && <><Button variant="ghost" onClick={async () => { const x = await confirm({ title: 'Discard this draft?', danger: true }); if (x.ok) run((d) => discardDraft(d, b.id, v.version), { ok: 'Draft discarded', onOk: () => { setVn(sorted.find((s) => s.status !== 'draft')!.version); setDraft(null); } }); }}>Discard</Button><Button onClick={() => draft && run((d, c) => updateDraft(d, c, b.id, v.version, { components: draft.components, yieldQty: draft.yieldQty, laborCost: draft.laborCost, overheadCost: draft.overheadCost, notes: draft.notes }), { ok: 'Draft saved', onOk: () => setDraft(null) })} disabled={!draft}>Save draft</Button><Button variant="primary" onClick={() => run((d, c) => { if (draft) updateDraft(d, c, b.id, v.version, { components: draft.components, yieldQty: draft.yieldQty, laborCost: draft.laborCost, overheadCost: draft.overheadCost, notes: draft.notes }); activateVersion(d, c, b.id, v.version, new Date(eff).toISOString()); }, { ok: `v${v.version} is now active`, perm: 'production:approve', onOk: () => setDraft(null) })}>Activate from {eff}</Button></>}
      </>}>
      <div className="col gap-16">
        <div className="row wrap gap-6">{sorted.map((x) => <Button key={x.version} size="sm" variant={x.version === vn ? 'primary' : undefined} onClick={() => { setVn(x.version); setDraft(null); }}>v{x.version} <Badge tone={x.status === 'active' ? 'good' : x.status === 'draft' ? 'warn' : ''}>{x.status}</Badge></Button>)}</div>
        {v.status !== 'draft' ? <Banner><Lock size={14} style={{ verticalAlign: -2 }} /> <b>v{v.version} is {v.status} and read-only.</b> Effective {dateFmt(v.effectiveFrom)}{v.effectiveTo ? ` – ${dateFmt(v.effectiveTo)}` : ''}. Orders and production runs keep the BOM snapshot they were created with, so editing history is impossible by design.</Banner> : <Banner tone="warn"><b>Draft.</b> Edit freely, then activate with an effective date. The previous version is retired automatically.</Banner>}
        <div className="form-grid">
          <Field label={`Batch yield (${p.unit})`}><NumInput value={cur.yieldQty} disabled={!editable} onChange={(n) => setDraft({ ...cur, yieldQty: n || 1 })} /></Field>
          <Field label="Effective from"><Input type="date" value={editable ? eff : cur.effectiveFrom.slice(0, 10)} disabled={!editable} onChange={(e) => setEff(e.target.value)} /></Field>
          <Field label="Labor / batch (฿)"><NumInput value={cur.laborCost} disabled={!editable} onChange={(n) => setDraft({ ...cur, laborCost: n || 0 })} /></Field>
          <Field label="Overhead / batch (฿)"><NumInput value={cur.overheadCost} disabled={!editable} onChange={(n) => setDraft({ ...cur, overheadCost: n || 0 })} /></Field>
        </div>
        <Card title="Components" flush>
          <table className="t compact"><thead><tr><th>Component</th><th>Role</th><th className="num">Qty / batch</th>{canCost && <th className="num">Unit cost</th>}{canCost && <th className="num">Cost</th>}{editable && <th />}</tr></thead>
            <tbody>{cur.components.map((c, i) => { const cp = db.products.find((x) => x.id === c.productId)!; const line = r.lines[i]; return (
              <tr key={i}><td>{editable ? <Select sm value={c.productId} onChange={(e) => setC(cur.components.map((x, k) => (k === i ? { ...x, productId: e.target.value } : x)))}>{db.products.filter((x) => x.kind !== 'menu' && x.id !== b.productId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select> : cp.name}</td>
                <td>{editable ? <Select sm value={c.role} onChange={(e) => setC(cur.components.map((x, k) => (k === i ? { ...x, role: e.target.value as BomComponent['role'] } : x)))}><option value="material">material</option><option value="packaging">packaging</option><option value="consumable">consumable</option></Select> : <Badge>{c.role}</Badge>}</td>
                <td className="num">{editable ? <NumInput style={{ width: 90 }} value={c.qty} onChange={(n) => setC(cur.components.map((x, k) => (k === i ? { ...x, qty: n || 0 } : x)))} /> : `${qtyFmt(c.qty)} ${cp.unit}`}</td>
                {canCost && <td className="num">{money(line?.unitCost ?? 0)}</td>}{canCost && <td className="num">{money(line?.cost ?? 0)}</td>}{editable && <td><Button size="sm" variant="ghost" icon onClick={() => setC(cur.components.filter((_, k) => k !== i))}><Trash2 size={13} /></Button></td>}</tr>); })}</tbody></table>
          {editable && <div style={{ padding: 10 }}><Button size="sm" onClick={() => setC([...cur.components, { productId: db.products.find((x) => x.kind === 'material')!.id, qty: 1, role: 'material' }])}><Plus size={13} /> Add component</Button></div>}
        </Card>
        {canCost && <Card title="Cost roll-up (at current average costs)"><div className="col gap-6">
          <div className="row between"><span className="muted">Materials & packaging</span><span>{money(r.materials)}</span></div><div className="row between"><span className="muted">Labor</span><span>{money(r.labor)}</span></div><div className="row between"><span className="muted">Overhead</span><span>{money(r.overhead)}</span></div>
          <div className="row between"><b>Batch total</b><b>{money(r.batch)}</b></div><div className="row between" style={{ fontSize: 18 }}><b>Per {p.unit}</b><b>{money(r.perUnit)}</b></div></div></Card>}
        {cur.notes && <div className="muted">{cur.notes}</div>}
      </div>
    </Drawer>
  );
}

function NewBom({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const free = db.products.filter((p) => ['finished', 'menu'].includes(p.kind) && !bomForProduct(db, p.id));
  const [f, setF] = useState({ productId: free[0]?.id ?? '', name: '', type: 'manufacturing' as keyof typeof TYPE_LABEL, yieldQty: 1, laborCost: 0, overheadCost: 0 });
  const [comps, setComps] = useState<BomComponent[]>([{ productId: db.products.find((p) => p.kind === 'material')!.id, qty: 1, role: 'material' }]);
  return (
    <Modal title="New bill of materials" size="lg" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.productId || !f.name} onClick={() => run((d, c) => createBom(d, c, { ...f, components: comps }), { ok: 'BOM created (v1 active)', perm: 'production:create', onOk: onClose })}>Create</Button></>}>
      {!free.length ? <Empty title="Every finished/menu product already has a BOM" hint="Create the product first (Products → New product, type “Finished good” or “Menu item”)." /> : (
        <>
          <div className="form-grid">
            <Field label="Output product"><Select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value, name: db.products.find((p) => p.id === e.target.value)?.name ?? '' })}>{free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="BOM name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as keyof typeof TYPE_LABEL })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Batch yield"><NumInput value={f.yieldQty} onChange={(n) => setF({ ...f, yieldQty: n || 1 })} /></Field>
            <Field label="Labor / batch"><NumInput value={f.laborCost} onChange={(n) => setF({ ...f, laborCost: n || 0 })} /></Field><Field label="Overhead / batch"><NumInput value={f.overheadCost} onChange={(n) => setF({ ...f, overheadCost: n || 0 })} /></Field>
          </div>
          <div className="col mt16">{comps.map((c, i) => <div key={i} className="row"><Select value={c.productId} onChange={(e) => setComps(comps.map((x, k) => (k === i ? { ...x, productId: e.target.value } : x)))}>{db.products.filter((x) => x.kind !== 'menu').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select><NumInput style={{ width: 100 }} value={c.qty} onChange={(n) => setComps(comps.map((x, k) => (k === i ? { ...x, qty: n || 0 } : x)))} /><Button icon variant="ghost" onClick={() => setComps(comps.filter((_, k) => k !== i))}>×</Button></div>)}<div><Button size="sm" onClick={() => setComps([...comps, { productId: db.products[0].id, qty: 1, role: 'material' }])}><Plus size={13} /> Add component</Button></div></div>
        </>
      )}
    </Modal>
  );
}

function NewOrder({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const boms = db.boms.filter((b) => b.type !== 'recipe' || true);
  const [bomId, setBomId] = useState(db.boms.find((b) => b.productId === 'F02')?.id ?? boms[0].id);
  const [wh, setWh] = useState('W3');
  const [qty, setQty] = useState(40);
  const b = db.boms.find((x) => x.id === bomId)!;
  const v = versionAt(b, new Date().toISOString())!;
  const need = v.components.map((c) => ({ c, p: db.products.find((x) => x.id === c.productId)!, need: (c.qty * qty) / v.yieldQty, have: onHand(db, wh, c.productId) }));
  const short = need.filter((n) => n.have + 1e-6 < n.need);
  return (
    <Modal title="New production order" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => run((d, c) => createProductionOrder(d, c, { bomId, plannedQty: qty, warehouseId: wh }), { ok: 'Production order created (BOM snapshot taken)', perm: 'production:create', onOk: onClose })}>Create</Button></>}>
      <div className="form-grid">
        <Field label="BOM"><Select value={bomId} onChange={(e) => setBomId(e.target.value)}>{boms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Warehouse"><Select value={wh} onChange={(e) => setWh(e.target.value)}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label={`Planned output (${db.products.find((p) => p.id === b.productId)?.unit})`} hint={`Batch size ${v.yieldQty}`}><NumInput value={qty} onChange={(n) => setQty(n || 0)} /></Field>
      </div>
      <table className="t compact mt16"><thead><tr><th>Needs</th><th className="num">Required</th><th className="num">On hand</th></tr></thead><tbody>{need.map((n) => <tr key={n.c.productId}><td>{n.p.name}</td><td className="num">{qtyFmt(n.need)} {n.p.unit}</td><td className={n.have + 1e-6 < n.need ? 'num bad' : 'num'}>{qtyFmt(n.have)}</td></tr>)}</tbody></table>
      {short.length > 0 && <div className="mt8"><Banner tone="warn">Short of {short.map((s) => s.p.name).join(', ')} at this warehouse — recording output will fail until stock is received or transferred.</Banner></div>}
    </Modal>
  );
}

function RecordModal({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const o = db.productionOrders.find((x) => x.id === id)!;
  const p = db.products.find((x) => x.id === o.productId)!;
  const t = prodTotals(o);
  const left = Math.max(0, o.plannedQty - t.out);
  const [out, setOut] = useState(left);
  const [waste, setWaste] = useState(0);
  const frac = (out + waste) / o.snapshot.yieldQty;
  return (
    <Modal title={`Record output — ${o.no}`} desc={`${p.name} · planned ${qtyFmt(o.plannedQty)} · produced ${qtyFmt(t.out)}`} onClose={onClose} footer={<>
      {t.out > 0 && <Button variant="ghost" onClick={() => run((d, c) => completeProduction(d, c, id), { ok: 'Closed as complete', onOk: onClose })}>Close order</Button>}
      {t.out === 0 && <Button variant="ghost" onClick={async () => { const x = await confirm({ title: 'Cancel production order?', danger: true }); if (x.ok) run((d, c) => cancelProduction(d, c, id), { ok: 'Cancelled', onOk: onClose }); }}>Cancel order</Button>}
      <Button onClick={onClose}>Close</Button>
      <Button variant="primary" disabled={out + waste <= 0} onClick={() => run((d, c) => recordProduction(d, c, id, { outputQty: out, wasteQty: waste }), { ok: 'Output recorded — materials issued, cost posted', perm: 'production:create', onOk: onClose })}>Post</Button></>}>
      <div className="form-grid">
        <Field label={`Good output (${p.unit})`}><NumInput value={out} onChange={(n) => setOut(n || 0)} /></Field>
        <Field label="Waste / spoilage (units)" hint="Cost is expensed, not capitalised"><NumInput value={waste} onChange={(n) => setWaste(n || 0)} /></Field>
      </div>
      <table className="t compact mt16"><thead><tr><th>Material issued</th><th className="num">Quantity</th><th className="num">On hand</th></tr></thead>
        <tbody>{o.snapshot.components.map((c) => { const cp = db.products.find((x) => x.id === c.productId)!; const need = r2(c.qty * frac); const have = db.balances[bkey(o.warehouseId, c.productId)]?.qty ?? 0; return <tr key={c.productId}><td>{cp.name}</td><td className="num">{qtyFmt(need)} {cp.unit}</td><td className={have + 1e-6 < need ? 'num bad' : 'num'}>{qtyFmt(have)}</td></tr>; })}</tbody></table>
      <div className="muted mt8" style={{ fontSize: 12 }}>Partial production is supported — post several times until the order is complete. Costs use the BOM <b>snapshot v{o.snapshot.version}</b> taken when the order was created.</div>
    </Modal>
  );
}
