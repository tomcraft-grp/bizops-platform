import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Printer, Truck, Undo2 } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { apOpen, cancelPO, closePO, createPO, paySupplier, poTotal, priceHistory, receiveGoods, returnToSupplier, supplierDeposit } from '../domain/purchasing';
import { saveSupplier } from '../domain/master';
import { globalAvgCost, bkey } from '../domain/inventory';
import { PAY_METHODS } from '../domain/meta';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun, Check, Tx } from '../ui/kit';
import { usePrintDoc } from '../ui/shared';
import { addDays, dateFmt, dateTimeFmt, daysBetween, money, money0, qtyFmt, r2 } from '../lib/util';
import type { ID, PayMethod, PurchaseOrder, Supplier } from '../domain/types';
import { t as tl } from '../lib/i18n';

type Tab = 'orders' | 'suppliers' | 'payables' | 'returns';
export default function Purchasing() {
  const db = useDB();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'orders';
  const canCreate = useHas('purchasing:create');
  const canCost = useHas('finance:cost');
  const [newPO, setNewPO] = useState(false);
  const open = db.apInvoices.filter((i) => apOpen(i) > 0.004);
  const overdue = open.filter((i) => daysBetween(i.dueDate, new Date()) > 0);
  return (
    <>
      <PageHead title="Purchasing & suppliers" desc="Purchase orders → partial goods receipts (with landed cost) → supplier invoices → payments, deposits and returns. Receipts feed inventory and the BOM costs."
        actions={canCreate && <Button variant="primary" onClick={() => setNewPO(true)}><Plus size={15} />{' '}<Tx>New purchase order</Tx></Button>} />
      <div className="grid g4 mb16">
        <Kpi label="Open POs" value={db.purchaseOrders.filter((p) => ['sent', 'partial', 'draft'].includes(p.status)).length} sub={<Tx vars={{ n: db.purchaseOrders.length }}>{'{n} total'}</Tx>} />
        <Kpi label="Payables" value={money0(open.reduce((s, i) => s + apOpen(i), 0))} sub={<Tx vars={{ n: open.length }}>{'{n} open invoices'}</Tx>} />
        <Kpi label="Overdue" value={money0(overdue.reduce((s, i) => s + apOpen(i), 0))} tone={overdue.length ? 'bad' : 'good'} sub={<Tx vars={{ n: overdue.length }}>{'{n} invoices past due'}</Tx>} />
        <Kpi label="Supplier deposits" value={money0(db.suppliers.reduce((s, x) => s + supplierDeposit(db, x.id), 0))} sub="prepayments held" />
      </div>
      <Tabs value={tab} onChange={(t) => setSp({ tab: t })} tabs={[{ v: 'orders', label: 'Purchase orders' }, { v: 'suppliers', label: 'Suppliers', count: db.suppliers.length }, { v: 'payables', label: 'Payables', count: open.length || '' }, { v: 'returns', label: 'Returns' }]} />
      {tab === 'orders' && <Orders canCost={canCost} />}
      {tab === 'suppliers' && <Suppliers />}
      {tab === 'payables' && <Payables />}
      {tab === 'returns' && <Returns />}
      {newPO && <POModal onClose={() => setNewPO(false)} />}
    </>
  );
}

function Orders({ canCost }: { canCost: boolean }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const print = usePrintDoc();
  const canEdit = useHas('purchasing:edit');
  const [recv, setRecv] = useState<ID | null>(null);
  return (
    <Card flush>
      <DataTable rows={[...db.purchaseOrders].reverse()} rowKey={(p) => p.id} pageSize={12} search={(p) => p.no + (db.suppliers.find((s) => s.id === p.supplierId)?.name ?? '')}
        cols={[
          { key: 'no', header: 'PO', sort: (p) => p.no, render: (p) => <><b>{p.no}</b><div className="sub">{dateTimeFmt(p.createdAt)}</div></> },
          { key: 's', header: 'Supplier', render: (p) => db.suppliers.find((s) => s.id === p.supplierId)?.name },
          { key: 'w', header: 'Deliver to', hideSm: true, render: (p) => db.warehouses.find((w) => w.id === p.warehouseId)?.name },
          { key: 'l', header: 'Received', render: (p) => <>{p.lines.reduce((s, l) => s + l.receivedQty, 0) > 0 ? `${Math.round((p.lines.reduce((s, l) => s + l.receivedQty, 0) / p.lines.reduce((s, l) => s + l.qty, 0)) * 100)}%` : '0%'}<div className="sub">{p.lines.length}{' '}<Tx>line(s)</Tx></div></> },
          ...(canCost ? [{ key: 't', header: 'Total (ex VAT)', num: true, render: (p: PurchaseOrder) => money(poTotal(p)) }] : []),
          { key: 'st', header: 'Status', render: (p) => <Badge tone={p.status === 'received' ? 'good' : p.status === 'partial' ? 'warn' : p.status === 'cancelled' ? 'bad' : 'info'} dot>{p.status}</Badge> },
          { key: 'a', header: '', render: (p) => <div className="row gap-4"><Button size="sm" variant="ghost" icon title={tl(lang, 'Print PO')} onClick={() => print.open('purchase_order', p.id)}><Printer size={14} /></Button>{canEdit && ['sent', 'partial'].includes(p.status) && <Button size="sm" variant="primary" onClick={() => setRecv(p.id)}><Truck size={13} />{' '}<Tx>Receive</Tx></Button>}{canEdit && p.status === 'partial' && <Button size="sm" variant="ghost" onClick={() => run((d, c) => closePO(d, c, p.id), { ok: 'PO closed' })}><Tx>Close</Tx></Button>}{canEdit && p.status === 'sent' && !p.lines.some((l) => l.receivedQty) && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: `Cancel ${p.no}?`, danger: true }); if (x.ok) run((d, c) => cancelPO(d, c, p.id), { ok: 'PO cancelled' }); }}><Tx>Cancel</Tx></Button>}</div> },
        ]} />
      {recv && <ReceiveModal id={recv} onClose={() => setRecv(null)} />}
      {print.node}
    </Card>
  );
}

function POModal({ onClose }: { onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const [supplierId, setSupplierId] = useState(db.suppliers[0].id);
  const [warehouseId, setWarehouseId] = useState('W3');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ productId: ID; qty: number; unitCost: number }[]>([{ productId: '', qty: 0, unitCost: 0 }]);
  const sup = db.suppliers.find((s) => s.id === supplierId)!;
  const prods = db.products.filter((p) => sup.productIds.includes(p.id));
  const lastCost = (pid: ID) => { const h = priceHistory(db, pid); return h.length ? h[h.length - 1].unitCost : db.products.find((p) => p.id === pid)?.stdCost ?? 0; };
  const total = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
  return (
    <Modal title="New purchase order" size="lg" onClose={onClose} footer={<><div className="grow muted"><Tx>Total ex VAT:</Tx>{' '}<b>{money(total)}</b></div><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button onClick={() => run((d, c) => createPO(d, c, { supplierId, warehouseId, lines: lines.filter((l) => l.productId && l.qty > 0), note, send: false }), { ok: 'Saved as draft', onOk: onClose })}><Tx>Save draft</Tx></Button><Button variant="primary" onClick={() => run((d, c) => createPO(d, c, { supplierId, warehouseId, lines: lines.filter((l) => l.productId && l.qty > 0), note, expectedAt: addDays(new Date(), 3).toISOString() }), { ok: 'PO sent to supplier', perm: 'purchasing:create', onOk: onClose })}><Tx>Create & send</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Supplier"><Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setLines([{ productId: '', qty: 0, unitCost: 0 }]); }}>{db.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Deliver to"><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
      </div>
      <div className="col mt16">
        <div className="lbl-s"><Tx>Lines — terms:</Tx>{' '}{sup.termsDays}{' '}<Tx>days ·</Tx>{' '}{sup.vatable ? <Tx>{'VAT 7% added at receipt'}</Tx> : <Tx>{'no VAT'}</Tx>}</div>
        {lines.map((l, i) => { const p = db.products.find((x) => x.id === l.productId); return (
          <div key={i} className="row"><Select value={l.productId} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, productId: e.target.value, unitCost: lastCost(e.target.value) } : x)))}><option value="">Select item…</option>{prods.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            <NumInput style={{ width: 90 }} placeholder={tl(lang, 'Qty')} value={l.qty || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, qty: n || 0 } : x)))} /><span className="muted" style={{ width: 44 }}>{p?.unit}</span>
            <NumInput style={{ width: 100 }} placeholder={tl(lang, 'Unit cost')} value={l.unitCost || ''} onChange={(n) => setLines(lines.map((x, k) => (k === i ? { ...x, unitCost: n || 0 } : x)))} /><span style={{ width: 90, textAlign: 'right' }} className="num">{money(l.qty * l.unitCost)}</span><Button icon variant="ghost" onClick={() => setLines(lines.filter((_, k) => k !== i))}>×</Button></div>); })}
        <div><Button size="sm" onClick={() => setLines([...lines, { productId: '', qty: 0, unitCost: 0 }])}><Plus size={14} />{' '}<Tx>Add line</Tx></Button></div>
        <Field label="Note"><Textarea style={{ minHeight: 50 }} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ReceiveModal({ id, onClose }: { id: ID; onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const po = db.purchaseOrders.find((p) => p.id === id)!;
  const [q, setQ] = useState<Record<ID, number>>(() => Object.fromEntries(po.lines.map((l) => [l.productId, r2(l.qty - l.receivedQty)])));
  const [lot, setLot] = useState<Record<ID, { lot: string; expiry: string }>>({});
  const [freight, setFreight] = useState(0);
  const [handling, setHandling] = useState(0);
  const [inv, setInv] = useState('');
  const goods = po.lines.reduce((s, l) => s + (q[l.productId] || 0) * l.unitCost, 0);
  return (
    <Modal title={`Receive goods — ${po.no}`} size="lg" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" onClick={() => run((d, c) => receiveGoods(d, c, { poId: id, lines: po.lines.map((l) => ({ productId: l.productId, qty: q[l.productId] || 0, lot: lot[l.productId]?.lot || undefined, expiry: lot[l.productId]?.expiry ? new Date(lot[l.productId].expiry).toISOString() : undefined })), freight, handling, invoiceNo: inv }), { ok: 'Goods received — stock, payable and cost updated', perm: 'purchasing:edit', onOk: onClose })}><Tx>Post receipt</Tx></Button></>}>
      <div className="muted mb8"><Tx>Receive part of an order if only some goods arrived — the PO stays open for the rest.</Tx></div>
      <table className="t compact"><thead><tr><th><Tx>Item</Tx></th><th className="num"><Tx>Ordered</Tx></th><th className="num"><Tx>Received</Tx></th><th className="num"><Tx>Receive now</Tx></th><th><Tx>Lot / expiry</Tx></th></tr></thead>
        <tbody>{po.lines.map((l) => { const p = db.products.find((x) => x.id === l.productId)!; const out = r2(l.qty - l.receivedQty); return (
          <tr key={l.productId}><td>{p.name}<div className="sub">{money(l.unitCost)} / {p.unit}</div></td><td className="num">{qtyFmt(l.qty)}</td><td className="num">{qtyFmt(l.receivedQty)}</td>
            <td className="num"><NumInput style={{ width: 90 }} value={q[l.productId] ?? 0} disabled={out <= 0} onChange={(n) => setQ({ ...q, [l.productId]: Math.min(out, Math.max(0, n || 0)) })} /></td>
            <td>{p.trackLot ? <div className="row gap-4"><Input sm style={{ width: 100 }} placeholder={tl(lang, 'Lot')} value={lot[l.productId]?.lot ?? ''} onChange={(e) => setLot({ ...lot, [l.productId]: { lot: e.target.value, expiry: lot[l.productId]?.expiry ?? '' } })} /><Input sm type="date" style={{ width: 140 }} value={lot[l.productId]?.expiry ?? ''} onChange={(e) => setLot({ ...lot, [l.productId]: { lot: lot[l.productId]?.lot ?? '', expiry: e.target.value } })} /></div> : <span className="muted">–</span>}</td></tr>); })}</tbody></table>
      <div className="form-grid mt16">
        <Field label="Supplier invoice no."><Input value={inv} onChange={(e) => setInv(e.target.value)} /></Field><div />
        <Field label="Freight (landed cost)" hint="Allocated across the received lines by value"><NumInput value={freight || ''} onChange={(n) => setFreight(n || 0)} /></Field>
        <Field label="Handling / duties"><NumInput value={handling || ''} onChange={(n) => setHandling(n || 0)} /></Field>
      </div>
      <div className="muted mt8"><Tx>Goods value</Tx>{' '}{money(goods)}{' '}<Tx>+ landed</Tx>{' '}{money(freight + handling)}</div>
    </Modal>
  );
}

function Suppliers() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('purchasing:edit');
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  return (
    <Card flush actions={undefined}>
      <DataTable rows={db.suppliers} rowKey={(s) => s.id} onRow={(s) => canEdit && setEdit(s)} toolbar={canEdit && <Button size="sm" onClick={() => setEdit('new')}><Plus size={14} />{' '}<Tx>New supplier</Tx></Button>}
        cols={[
          { key: 'n', header: 'Supplier', render: (s) => <><b>{s.name}</b><div className="sub">{s.contact} · {s.phone}</div></> }, { key: 't', header: 'Terms', num: true, render: (s) => `${s.termsDays} days` },
          { key: 'p', header: 'Supplies', hideSm: true, render: (s) => s.productIds.slice(0, 3).map((id) => db.products.find((p) => p.id === id)?.name).join(', ') + (s.productIds.length > 3 ? ` +${s.productIds.length - 3}` : '') },
          { key: 'o', header: 'Owed', num: true, render: (s) => { const o = db.apInvoices.filter((i) => i.supplierId === s.id).reduce((a, i) => a + apOpen(i), 0); return o > 0 ? money(o) : '–'; } },
          { key: 'r', header: 'Rating', render: (s) => '★'.repeat(s.rating) + '☆'.repeat(5 - s.rating) },
        ]} />
      {edit && <SupplierModal s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}
function SupplierModal({ s, onClose }: { s: Supplier | null; onClose: () => void }) {
  const run = useRun();
  const [f, setF] = useState({ name: s?.name ?? '', contact: s?.contact ?? '', phone: s?.phone ?? '', termsDays: s?.termsDays ?? 30, vatable: s?.vatable ?? true, taxId: s?.taxId ?? '' });
  return (
    <Modal title={s ? 'Edit supplier' : 'New supplier'} onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" onClick={() => run((d, c) => saveSupplier(d, c, { id: s?.id, ...f }), { ok: 'Supplier saved', perm: 'purchasing:edit', onOk: onClose })}><Tx>Save</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Name" full><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Contact"><Input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field><Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Payment terms (days)"><NumInput value={f.termsDays} onChange={(n) => setF({ ...f, termsDays: n || 0 })} /></Field><Field label="Tax ID"><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field>
        <div className="full"><Check checked={f.vatable} onChange={(v) => setF({ ...f, vatable: v })}><Tx>VAT-registered supplier (input VAT is claimed)</Tx></Check></div>
      </div>
    </Modal>
  );
}

function Payables() {
  const db = useDB();
  const canPay = useHas('purchasing:approve');
  const [pay, setPay] = useState<ID | null>(null);
  const rows = db.apInvoices.filter((i) => apOpen(i) > 0.004 || true).slice().reverse();
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(i) => i.id} pageSize={12} search={(i) => i.no + i.invoiceNo + (db.suppliers.find((s) => s.id === i.supplierId)?.name ?? '')}
        toolbar={canPay && <Button size="sm" variant="primary" onClick={() => setPay('')}><Tx>Pay supplier</Tx></Button>}
        cols={[
          { key: 'no', header: 'Invoice', render: (i) => <><b>{i.no}</b><div className="sub mono">{i.invoiceNo}</div></> }, { key: 's', header: 'Supplier', render: (i) => db.suppliers.find((s) => s.id === i.supplierId)?.name },
          { key: 'd', header: 'Due', sort: (i) => i.dueDate, render: (i) => { const late = daysBetween(i.dueDate, new Date()); return <>{dateFmt(i.dueDate)}{apOpen(i) > 0.004 && late > 0 && <div className="sub bad">{late}{' '}<Tx>days overdue</Tx></div>}</>; } },
          { key: 'a', header: 'Amount', num: true, render: (i) => <>{money(i.amount)}{i.landed > 0 && <div className="sub"><Tx>incl. landed</Tx>{' '}{money(i.landed)}</div>}</> }, { key: 'p', header: 'Paid', num: true, render: (i) => money(i.paid) },
          { key: 'o', header: 'Open', num: true, sort: (i) => apOpen(i), render: (i) => <b>{money(apOpen(i))}</b> },
          { key: 'st', header: 'Status', render: (i) => <Badge tone={i.status === 'paid' ? 'good' : i.status === 'partial' ? 'warn' : 'info'} dot>{i.status}</Badge> },
          { key: 'x', header: '', render: (i) => apOpen(i) > 0.004 && canPay ? <Button size="sm" onClick={() => setPay(i.supplierId)}><Tx>Pay</Tx></Button> : null },
        ]} />
      {pay != null && <PayModal supplierId={pay} onClose={() => setPay(null)} />}
    </Card>
  );
}
function PayModal({ supplierId, onClose }: { supplierId: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [sid, setSid] = useState(supplierId || db.suppliers[0].id);
  const open = db.apInvoices.filter((i) => i.supplierId === sid && apOpen(i) > 0.004).sort((a, b) => a.date.localeCompare(b.date));
  const owed = open.reduce((s, i) => s + apOpen(i), 0);
  const dep = supplierDeposit(db, sid);
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PayMethod | 'deposit'>('transfer');
  return (
    <Modal title="Pay supplier" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!(amount > 0)} onClick={() => run((d, c) => paySupplier(d, c, { supplierId: sid, amount, method, allocations: 'fifo' }), { ok: 'Payment posted', perm: 'purchasing:approve', onOk: onClose })}><Tx>Pay</Tx>{' '}{amount > 0 ? money(amount) : ''}</Button></>}>
      <div className="form-grid">
        <Field label="Supplier"><Select value={sid} onChange={(e) => { setSid(e.target.value); setAmount(0); }}>{db.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as PayMethod | 'deposit')}>{PAY_METHODS.filter((m) => m.key !== 'qr').map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}{dep > 0 && <option value="deposit">Use deposit ({money(dep)})</option>}</Select></Field>
        <Field label="Amount" hint={`Owed ${money(owed)}. Extra becomes a supplier deposit.`}><NumInput value={amount || ''} onChange={(n) => setAmount(n || 0)} /></Field>
        <div className="row" style={{ alignSelf: 'flex-end' }}><Button size="sm" onClick={() => setAmount(r2(owed))}><Tx>Pay all owed</Tx></Button></div>
      </div>
      <div className="mt16 muted"><Tx>Allocation: oldest invoices first —</Tx>{' '}{open.map((i) => i.no).join(', ') || <Tx>{'none open'}</Tx>}</div>
    </Modal>
  );
}

function Returns() {
  const db = useDB();
  const [open, setOpen] = useState(false);
  const canEdit = useHas('purchasing:edit');
  return (
    <Card flush>
      <DataTable rows={[...db.supplierReturns].reverse()} rowKey={(r) => r.id} toolbar={canEdit && <Button size="sm" onClick={() => setOpen(true)}><Undo2 size={14} />{' '}<Tx>New return</Tx></Button>} empty={<Empty title="No supplier returns" hint="Return damaged or wrong goods; a credit note reduces what you owe." />}
        cols={[{ key: 'no', header: 'Return', render: (r) => <b>{r.no}</b> }, { key: 'd', header: 'Date', render: (r) => dateFmt(r.ts) }, { key: 's', header: 'Supplier', render: (r) => db.suppliers.find((s) => s.id === r.supplierId)?.name }, { key: 'r', header: 'Reason', render: (r) => r.reason }, { key: 'a', header: 'Credit note', num: true, render: (r) => money(r.amount) }]} />
      {open && <ReturnModal onClose={() => setOpen(false)} />}
    </Card>
  );
}
function ReturnModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [supplierId, setSupplierId] = useState(db.suppliers[0].id);
  const [warehouseId, setWarehouseId] = useState('W3');
  const [reason, setReason] = useState('');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState(0);
  const [invoiceId, setInvoiceId] = useState('');
  const sup = db.suppliers.find((s) => s.id === supplierId)!;
  const have = productId ? db.balances[bkey(warehouseId, productId)]?.qty ?? 0 : 0;
  return (
    <Modal title="Return goods to supplier" size="sm" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!productId || !(qty > 0) || !reason.trim()} onClick={() => run((d, c) => returnToSupplier(d, c, { supplierId, warehouseId, lines: [{ productId, qty }], invoiceId: invoiceId || undefined, reason }), { ok: 'Return posted — credit note applied', perm: 'purchasing:edit', onOk: onClose })}><Tx>Post return</Tx></Button></>}>
      <div className="col">
        <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>{db.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="From warehouse"><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="Item" hint={productId ? `On hand ${qtyFmt(have)} · avg cost ${money(globalAvgCost(db, productId))}` : undefined}><Select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Select…</option>{db.products.filter((p) => sup.productIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Quantity"><NumInput value={qty || ''} onChange={(n) => setQty(Math.min(have, n || 0))} /></Field>
        <Field label="Apply credit to invoice"><Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}><option value="">— none —</option>{db.apInvoices.filter((i) => i.supplierId === supplierId && apOpen(i) > 0.004).map((i) => <option key={i.id} value={i.id}>{i.no} ({money(apOpen(i))})</option>)}</Select></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
export const _pu = [Banner, Truck];
