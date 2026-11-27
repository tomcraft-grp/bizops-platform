import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, Pencil, Plus, Printer, Send, Truck, Undo2 } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { apOpen, approvePO, cancelPO, closePO, createPO, lineNet, paySupplier, poTotal, priceHistory, receiveGoods, returnToSupplier, reverseGoodsReceipt, supplierDeposit, updatePO, voidSupplierPayment } from '../domain/purchasing';
import { saveSupplier } from '../domain/master';
import { globalAvgCost, bkey } from '../domain/inventory';
import { PAY_METHODS } from '../domain/meta';
import { Badge, Banner, Button, Card, DataTable, Drawer, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun, Check, Tx } from '../ui/kit';
import { usePrintDoc } from '../ui/shared';
import { addDays, dateFmt, dateTimeFmt, daysBetween, money, money0, qtyFmt, r2 } from '../lib/util';
import type { DB, ID, PayMethod, PurchaseOrder, Supplier } from '../domain/types';
import { t as tl } from '../lib/i18n';

type Tab = 'orders' | 'suppliers' | 'payables' | 'returns';
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
/** where goods are delivered by default: the central warehouse, else the first one (never a fixed id that this book may not have) */
const defaultWarehouse = (db: DB) => (db.warehouses.find((w) => w.kind === 'central') ?? db.warehouses[0])?.id ?? '';
const PO_TONE: Record<PurchaseOrder['status'], 'good' | 'warn' | 'bad' | 'info' | ''> = { draft: '', sent: 'info', partial: 'warn', received: 'good', closed: '', cancelled: 'bad' };

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
      {newPO && <POModal onClose={() => setNewPO(false)} onGoSuppliers={() => { setNewPO(false); setSp({ tab: 'suppliers' }); }} />}
    </>
  );
}

function NoSuppliers({ onGo }: { onGo?: () => void }) {
  return (
    <div data-testid="no-suppliers"><Banner tone="warn"><b><Tx>There is no supplier yet.</Tx></b>{' '}<Tx>Add the supplier you buy from first (Suppliers tab), then make the order.</Tx>{onGo && <>{' '}<Button size="sm" onClick={onGo}><Tx>Go to Suppliers</Tx></Button></>}</Banner></div>
  );
}

function Orders({ canCost }: { canCost: boolean }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const print = usePrintDoc();
  const canEdit = useHas('purchasing:edit');
  const canCreate = useHas('purchasing:create');
  const [recv, setRecv] = useState<ID | null>(null);
  const [edit, setEdit] = useState<PurchaseOrder | null>(null);
  const [detail, setDetail] = useState<ID | null>(null);
  return (
    <Card flush>
      <DataTable rows={[...db.purchaseOrders].reverse()} rowKey={(p) => p.id} pageSize={12} search={(p) => p.no + (db.suppliers.find((s) => s.id === p.supplierId)?.name ?? '')}
        empty={<Empty title="No purchase orders yet" hint="Press “New purchase order” to order from a supplier." />}
        cols={[
          { key: 'no', header: 'PO', sort: (p) => p.no, render: (p) => <><b>{p.no}</b><div className="sub">{dateTimeFmt(p.createdAt)}</div></> },
          { key: 's', header: 'Supplier', render: (p) => db.suppliers.find((s) => s.id === p.supplierId)?.name },
          { key: 'w', header: 'Deliver to', hideSm: true, render: (p) => db.warehouses.find((w) => w.id === p.warehouseId)?.name },
          { key: 'l', header: 'Received', render: (p) => { const got = p.lines.reduce((s, l) => s + l.receivedQty, 0), all = p.lines.reduce((s, l) => s + l.qty, 0); return <>{got > 0 && all > 0 ? `${Math.round((got / all) * 100)}%` : '0%'}<div className="sub">{p.lines.length}{' '}<Tx>line(s)</Tx></div></>; } },
          ...(canCost ? [{ key: 't', header: 'Total (ex VAT)', num: true, render: (p: PurchaseOrder) => money(poTotal(p)) }] : []),
          { key: 'st', header: 'Status', render: (p) => <Badge tone={PO_TONE[p.status]} dot><Tx>{p.status}</Tx></Badge> },
          { key: 'a', header: '', render: (p) => (
            <div className="row gap-4 wrap">
              <Button size="sm" variant="ghost" icon title={tl(lang, 'Details')} aria-label={tl(lang, 'Details')} onClick={() => setDetail(p.id)}><Eye size={14} /></Button>
              <Button size="sm" variant="ghost" icon title={tl(lang, 'Print PO')} aria-label={tl(lang, 'Print PO')} onClick={() => print.open('purchase_order', p.id)}><Printer size={14} /></Button>
              {canCreate && p.status === 'draft' && <Button size="sm" onClick={() => setEdit(p)}><Pencil size={13} />{' '}<Tx>Edit</Tx></Button>}
              {canCreate && p.status === 'draft' && <Button size="sm" variant="primary" onClick={() => run((d, c) => approvePO(d, c, p.id), { ok: 'PO approved and sent to the supplier', perm: 'purchasing:create' })}><Send size={13} />{' '}<Tx>Approve & send</Tx></Button>}
              {canEdit && ['sent', 'partial'].includes(p.status) && <Button size="sm" variant="primary" onClick={() => setRecv(p.id)}><Truck size={13} />{' '}<Tx>Receive</Tx></Button>}
              {canEdit && p.status === 'partial' && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: `Close ${p.no}?`, body: 'The goods that have not arrived will not be received on this order. What is already received stays.', reason: 'Why is it closed? (for example the supplier cannot deliver the rest)', confirmLabel: 'Close the order' }); if (x.ok) run((d, c) => closePO(d, c, p.id, x.reason), { ok: 'PO closed' }); }}><Tx>Close</Tx></Button>}
              {canEdit && ['draft', 'sent'].includes(p.status) && !p.lines.some((l) => l.receivedQty) && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: `Cancel ${p.no}?`, danger: true, reason: 'Reason (optional)', reasonOptional: true, confirmLabel: 'Cancel the order' }); if (x.ok) run((d, c) => cancelPO(d, c, p.id, x.reason), { ok: 'PO cancelled' }); }}><Tx>Cancel</Tx></Button>}
            </div>) },
        ]} />
      {recv && <ReceiveModal id={recv} onClose={() => setRecv(null)} />}
      {edit && <POModal po={edit} onClose={() => setEdit(null)} />}
      {detail && <PODetail id={detail} onClose={() => setDetail(null)} canCost={canCost} />}
      {print.node}
    </Card>
  );
}

/** One order: what was ordered, received and is still to come, every receipt (with its supplier invoice, and a way to reverse a wrong one), and the history of the order. */
function PODetail({ id, onClose, canCost }: { id: ID; onClose: () => void; canCost: boolean }) {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canApprove = useHas('purchasing:approve');
  const po = db.purchaseOrders.find((x) => x.id === id);
  if (!po) return <Drawer title="Order not found" onClose={onClose}><div className="muted"><Tx>This order no longer exists.</Tx></div></Drawer>;
  const sup = db.suppliers.find((s) => s.id === po.supplierId);
  const grns = db.grns.filter((g) => g.poId === po.id);
  const userName = (u?: ID) => db.users.find((x) => x.id === u)?.name ?? u ?? '';
  return (
    <Drawer title={<span className="row gap-6">{po.no} <Badge tone={PO_TONE[po.status]} dot><Tx>{po.status}</Tx></Badge></span>} sub={`${sup?.name ?? ''} · ${db.warehouses.find((w) => w.id === po.warehouseId)?.name ?? ''}`} onClose={onClose}>
      <div className="col gap-16" data-testid="po-detail">
        {po.approvedAt && <div className="muted"><Tx>Approved by</Tx>{' '}<b>{userName(po.approvedBy)}</b>{' · '}{dateTimeFmt(po.approvedAt)}</div>}
        {po.closedReason && <Banner tone="info"><Tx>Reason:</Tx>{' '}{po.closedReason}</Banner>}
        <table className="t compact"><thead><tr><th><Tx>Item</Tx></th><th className="num"><Tx>Ordered</Tx></th><th className="num"><Tx>Received</Tx></th><th className="num"><Tx>Still to come</Tx></th>{canCost && <th className="num"><Tx>Value</Tx></th>}</tr></thead>
          <tbody>{po.lines.map((l) => { const p = db.products.find((x) => x.id === l.productId); return (
            <tr key={l.productId}><td>{p?.name ?? l.productId}<div className="sub">{canCost ? `${money(l.unitCost)}${l.discountPct ? ` −${l.discountPct}%` : ''} / ${p?.unit ?? ''}` : p?.unit}</div></td><td className="num">{qtyFmt(l.qty)}</td><td className="num">{qtyFmt(l.receivedQty)}</td><td className="num">{qtyFmt(Math.max(0, r2(l.qty - l.receivedQty)))}</td>{canCost && <td className="num">{money(lineNet(l))}</td>}</tr>); })}</tbody></table>
        <div>
          <b><Tx>Goods receipts</Tx></b>
          {!grns.length ? <div className="muted"><Tx>Nothing received yet.</Tx></div> : (
            <table className="t compact mt8"><thead><tr><th><Tx>Receipt</Tx></th><th><Tx>Supplier invoice</Tx></th><th className="num"><Tx>Amount</Tx></th><th /></tr></thead>
              <tbody>{grns.map((g) => { const inv = db.apInvoices.find((i) => i.id === g.invoiceId); return (
                <tr key={g.id} data-testid="po-receipt"><td><b>{g.no}</b><div className="sub">{dateTimeFmt(g.ts)}</div></td>
                  <td>{inv?.invoiceNo ?? '–'}<div className="sub">{inv?.no}</div></td><td className="num">{inv ? money(inv.amount) : '–'}</td>
                  <td>{g.reversal ? <Badge tone="bad" dot><Tx>reversed</Tx></Badge>
                    : canApprove && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: `Reverse ${g.no}?`, body: 'The goods go back out of stock, the supplier invoice is voided and the entries are reversed. It is refused if the goods were used or sold, or if the invoice has a payment.', reason: 'Why is this receipt wrong?', danger: true, confirmLabel: 'Reverse the receipt' }); if (x.ok) run((d, c) => reverseGoodsReceipt(d, c, g.id, x.reason, newKey()), { ok: 'Goods receipt reversed', perm: 'purchasing:approve' }); }}><Undo2 size={13} />{' '}<Tx>Reverse</Tx></Button>}</td></tr>); })}</tbody></table>)}
        </div>
        <div>
          <b><Tx>History</Tx></b>
          <ul className="col gap-4 mt8" style={{ paddingLeft: 16 }}>{(po.history ?? []).map((h, i) => <li key={i}><span className="muted">{dateTimeFmt(h.ts)}</span>{' '}<Tx>{h.action.replace('_', ' ')}</Tx>{' · '}{userName(h.by)}{h.note ? ` · ${h.note}` : ''}</li>)}
            {!(po.history ?? []).length && <li className="muted"><Tx>No history recorded (an older order).</Tx></li>}</ul>
        </div>
      </div>
    </Drawer>
  );
}

type Line = { productId: ID; qty: number; unitCost: number; discountPct: number };
const blank = (): Line => ({ productId: '', qty: 0, unitCost: 0, discountPct: 0 });

/** New order, or (with `po`) a draft being edited. Any active item can be ordered; the supplier's usual items come first. */
function POModal({ po, onClose, onGoSuppliers }: { po?: PurchaseOrder; onClose: () => void; onGoSuppliers?: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const [supplierId, setSupplierId] = useState(po?.supplierId ?? db.suppliers[0]?.id ?? '');
  const [warehouseId, setWarehouseId] = useState(po?.warehouseId ?? defaultWarehouse(db));
  const [note, setNote] = useState(po?.note ?? '');
  const [lines, setLines] = useState<Line[]>(po ? po.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost, discountPct: l.discountPct ?? 0 })) : [blank()]);
  const sup = db.suppliers.find((s) => s.id === supplierId);
  if (!db.suppliers.length || !sup) return <Modal title="New purchase order" onClose={onClose} footer={<Button onClick={onClose}><Tx>Close</Tx></Button>}><NoSuppliers onGo={onGoSuppliers} /></Modal>;
  const usual = db.products.filter((p) => sup.productIds.includes(p.id) && (p.active || lines.some((l) => l.productId === p.id)));
  const others = db.products.filter((p) => !sup.productIds.includes(p.id) && (p.active || lines.some((l) => l.productId === p.id)));
  const taken = (i: number) => new Set(lines.filter((_, k) => k !== i).map((l) => l.productId));
  const lastCost = (pid: ID) => { const h = priceHistory(db, pid); return h.length ? h[h.length - 1].unitCost : db.products.find((p) => p.id === pid)?.stdCost ?? 0; };
  const filled = lines.filter((l) => l.productId && l.qty > 0);
  const total = r2(filled.reduce((s, l) => s + lineNet(l), 0));
  const bad = !warehouseId || !filled.length || filled.some((l) => !(l.unitCost >= 0) || l.discountPct < 0 || l.discountPct > 100);
  const input = () => filled.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost, discountPct: l.discountPct || undefined }));
  const save = (send: boolean) => run((d, c) => {
    if (po) { updatePO(d, c, po.id, { supplierId, warehouseId, lines: input(), note }); if (send) approvePO(d, c, po.id); return po.id; }
    return createPO(d, c, { supplierId, warehouseId, lines: input(), note, send, expectedAt: send ? addDays(new Date(), 3).toISOString() : undefined });
  }, { ok: send ? 'PO approved and sent to the supplier' : po ? 'Draft saved' : 'Saved as draft', perm: 'purchasing:create', onOk: onClose });
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <Modal title={po ? `Edit ${po.no}` : 'New purchase order'} size="lg" onClose={onClose}
      footer={<><div className="grow muted"><Tx>Total ex VAT:</Tx>{' '}<b data-testid="po-total">{money(total)}</b></div><Button onClick={onClose}><Tx>Cancel</Tx></Button>
        <Button disabled={bad} onClick={() => save(false)}><Tx>Save draft</Tx></Button><Button variant="primary" disabled={bad} onClick={() => save(true)}><Tx>Approve & send</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Supplier"><Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); if (!po) setLines([blank()]); }} aria-label={tl(lang, 'Supplier')}>{db.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Deliver to"><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label={tl(lang, 'Deliver to')}>{!db.warehouses.length && <option value="">{tl(lang, 'No warehouse')}</option>}{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
      </div>
      <div className="col mt16">
        <div className="lbl-s"><Tx>Lines — terms:</Tx>{' '}{sup.termsDays}{' '}<Tx>days ·</Tx>{' '}{sup.vatable ? <Tx>{'VAT 7% added at receipt'}</Tx> : <Tx>{'no VAT'}</Tx>}</div>
        {lines.map((l, i) => { const p = db.products.find((x) => x.id === l.productId); const used = taken(i); return (
          <div key={i} className="row" data-testid="po-line">
            <Select value={l.productId} aria-label={tl(lang, 'Item')} onChange={(e) => set(i, { productId: e.target.value, unitCost: e.target.value ? lastCost(e.target.value) : 0, discountPct: 0 })}>
              <option value="">{tl(lang, 'Select item…')}</option>
              {usual.length > 0 && <optgroup label={tl(lang, 'Usual items of this supplier')}>{usual.filter((x) => !used.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
              <optgroup label={tl(lang, usual.length ? 'All other items' : 'All items')}>{others.filter((x) => !used.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
            </Select>
            <NumInput style={{ width: 90 }} placeholder={tl(lang, 'Qty')} aria-label={tl(lang, 'Qty')} value={l.qty || ''} onChange={(n) => set(i, { qty: n || 0 })} /><span className="muted" style={{ width: 44 }}>{p?.unit}</span>
            <NumInput style={{ width: 100 }} placeholder={tl(lang, 'Unit cost')} aria-label={tl(lang, 'Unit cost')} value={l.unitCost || ''} onChange={(n) => set(i, { unitCost: n || 0 })} />
            <NumInput style={{ width: 78 }} placeholder="%" aria-label={tl(lang, 'Discount %')} value={l.discountPct || ''} onChange={(n) => set(i, { discountPct: Math.min(100, Math.max(0, n || 0)) })} />
            <span style={{ width: 90, textAlign: 'right' }} className="num">{money(lineNet(l))}</span><Button icon variant="ghost" aria-label={tl(lang, 'Remove line')} onClick={() => setLines(lines.length > 1 ? lines.filter((_, k) => k !== i) : [blank()])}>×</Button></div>); })}
        <div className="muted" style={{ fontSize: 12 }}><Tx>Columns: item, quantity, unit cost, discount %, line total.</Tx></div>
        <div><Button size="sm" onClick={() => setLines([...lines, blank()])}><Plus size={14} />{' '}<Tx>Add line</Tx></Button></div>
        <Field label="Note"><Textarea style={{ minHeight: 50 }} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ReceiveModal({ id, onClose }: { id: ID; onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const canPay = useHas('purchasing:approve');
  const po = db.purchaseOrders.find((p) => p.id === id)!;
  const key = useRef(newKey());                                                    // one request key per opened form: a double click or a retry is one receipt
  const [q, setQ] = useState<Record<ID, number>>(() => Object.fromEntries(po.lines.map((l) => [l.productId, r2(l.qty - l.receivedQty)])));
  const [lot, setLot] = useState<Record<ID, { lot: string; expiry: string }>>({});
  const [freight, setFreight] = useState(0);
  const [handling, setHandling] = useState(0);
  const [inv, setInv] = useState('');
  const [payNow, setPayNow] = useState(false);
  const [method, setMethod] = useState<PayMethod>('transfer');
  const goods = po.lines.reduce((s, l) => s + lineNet(l, q[l.productId] || 0), 0);
  const any = po.lines.some((l) => (q[l.productId] || 0) > 0);
  const post = () => run((d, c) => {
    const gid = receiveGoods(d, c, { poId: id, lines: po.lines.map((l) => ({ productId: l.productId, qty: q[l.productId] || 0, lot: lot[l.productId]?.lot || undefined, expiry: lot[l.productId]?.expiry ? new Date(lot[l.productId].expiry).toISOString() : undefined })), freight, handling, invoiceNo: inv, key: key.current });
    // paid at once: the invoice of this receipt is paid in the same transaction (receive and pay, or neither)
    if (payNow) { const g = d.grns.find((x) => x.id === gid)!, i = d.apInvoices.find((x) => x.id === g.invoiceId)!; paySupplier(d, c, { supplierId: po.supplierId, amount: apOpen(i), method, allocations: [{ invoiceId: i.id, amount: apOpen(i) }] }); }
    return gid;
  }, { ok: payNow ? 'Goods received and paid — stock, payable and cost updated' : 'Goods received — stock, payable and cost updated', perm: 'purchasing:edit', onOk: onClose });
  return (
    <Modal title={`Receive goods — ${po.no}`} size="lg" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!any} onClick={post}><Tx>Post receipt</Tx></Button></>}>
      <div className="muted mb8"><Tx>Receive part of an order if only some goods arrived — the PO stays open for the rest.</Tx></div>
      <table className="t compact"><thead><tr><th><Tx>Item</Tx></th><th className="num"><Tx>Ordered</Tx></th><th className="num"><Tx>Received</Tx></th><th className="num"><Tx>Receive now</Tx></th><th><Tx>Lot / expiry</Tx></th></tr></thead>
        <tbody>{po.lines.map((l) => { const p = db.products.find((x) => x.id === l.productId)!; const out = r2(l.qty - l.receivedQty); return (
          <tr key={l.productId}><td>{p.name}<div className="sub">{money(l.unitCost)}{l.discountPct ? ` −${l.discountPct}%` : ''} / {p.unit}</div></td><td className="num">{qtyFmt(l.qty)}</td><td className="num">{qtyFmt(l.receivedQty)}</td>
            <td className="num"><NumInput style={{ width: 90 }} value={q[l.productId] ?? 0} disabled={out <= 0} aria-label={`${tl(lang, 'Receive now')} ${p.name}`} onChange={(n) => setQ({ ...q, [l.productId]: Math.min(out, Math.max(0, n || 0)) })} /></td>
            <td>{p.trackLot ? <div className="row gap-4"><Input sm style={{ width: 100 }} placeholder={tl(lang, 'Lot')} value={lot[l.productId]?.lot ?? ''} onChange={(e) => setLot({ ...lot, [l.productId]: { lot: e.target.value, expiry: lot[l.productId]?.expiry ?? '' } })} /><Input sm type="date" style={{ width: 140 }} value={lot[l.productId]?.expiry ?? ''} onChange={(e) => setLot({ ...lot, [l.productId]: { lot: lot[l.productId]?.lot ?? '', expiry: e.target.value } })} /></div> : <span className="muted">–</span>}</td></tr>); })}</tbody></table>
      <div className="form-grid mt16">
        <Field label="Supplier invoice no." hint="The same number cannot be recorded twice for one supplier. Left empty, one is made up."><Input value={inv} onChange={(e) => setInv(e.target.value)} /></Field><div />
        <Field label="Freight (landed cost)" hint="Allocated across the received lines by value"><NumInput value={freight || ''} onChange={(n) => setFreight(Math.max(0, n || 0))} /></Field>
        <Field label="Handling / duties"><NumInput value={handling || ''} onChange={(n) => setHandling(Math.max(0, n || 0))} /></Field>
      </div>
      <div className="muted mt8"><Tx>Goods value</Tx>{' '}{money(goods)}{' '}<Tx>+ landed</Tx>{' '}{money(freight + handling)}</div>
      {canPay && (
        <div className="row gap-8 mt8" style={{ alignItems: 'center' }}>
          <Check checked={payNow} onChange={setPayNow}><Tx>Paid now (the invoice of this receipt is paid at once)</Tx></Check>
          {payNow && <Select sm value={method} onChange={(e) => setMethod(e.target.value as PayMethod)} aria-label={tl(lang, 'Method')}>{PAY_METHODS.filter((m) => m.key !== 'qr').map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</Select>}
        </div>
      )}
    </Modal>
  );
}

function Suppliers() {
  const db = useDB();
  const canEdit = useHas('purchasing:edit');
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  return (
    <Card flush actions={undefined}>
      <DataTable rows={db.suppliers} rowKey={(s) => s.id} onRow={(s) => canEdit && setEdit(s)} toolbar={canEdit && <Button size="sm" onClick={() => setEdit('new')}><Plus size={14} />{' '}<Tx>New supplier</Tx></Button>}
        empty={<Empty title="No suppliers yet" hint={canEdit ? 'Add the suppliers you buy from.' : 'Ask someone with purchasing access to add them.'} />}
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
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const [f, setF] = useState({ name: s?.name ?? '', contact: s?.contact ?? '', phone: s?.phone ?? '', termsDays: s?.termsDays ?? 30, vatable: s?.vatable ?? true, taxId: s?.taxId ?? '' });
  const [items, setItems] = useState<ID[]>(s?.productIds ?? []);
  const [find, setFind] = useState('');
  const shown = db.products.filter((p) => (p.active || items.includes(p.id)) && (!find.trim() || `${p.name} ${p.sku}`.toLowerCase().includes(find.trim().toLowerCase()))).slice(0, 60);
  return (
    <Modal title={s ? 'Edit supplier' : 'New supplier'} onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!f.name.trim()} onClick={() => run((d, c) => saveSupplier(d, c, { id: s?.id, ...f, productIds: items }), { ok: 'Supplier saved', perm: 'purchasing:edit', onOk: onClose })}><Tx>Save</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Name" full><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Contact"><Input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field><Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Payment terms (days)"><NumInput value={f.termsDays} onChange={(n) => setF({ ...f, termsDays: n || 0 })} /></Field><Field label="Tax ID"><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field>
        <div className="full"><Check checked={f.vatable} onChange={(v) => setF({ ...f, vatable: v })}><Tx>VAT-registered supplier (input VAT is claimed)</Tx></Check></div>
        <div className="full" data-testid="supplier-items">
          <div className="lbl-s"><Tx>Usual items (offered first on a purchase order; any item can still be ordered)</Tx>{' · '}{items.length}</div>
          <Input placeholder={tl(lang, 'Search items…')} aria-label={tl(lang, 'Search items…')} value={find} onChange={(e) => setFind(e.target.value)} />
          <div className="col gap-4 mt8" style={{ maxHeight: 180, overflow: 'auto' }}>{shown.map((p) => <Check key={p.id} checked={items.includes(p.id)} onChange={(v) => setItems(v ? [...items, p.id] : items.filter((x) => x !== p.id))}>{p.name} <span className="muted">{p.sku}</span></Check>)}
            {!shown.length && <div className="muted"><Tx>No item matches.</Tx></div>}</div>
        </div>
      </div>
    </Modal>
  );
}

function Payables() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canPay = useHas('purchasing:approve');
  const [pay, setPay] = useState<ID | null>(null);
  const rows = db.apInvoices.slice().reverse();
  const payments = db.supplierPayments.slice().reverse();
  return (
    <div className="col gap-16">
      <Card flush>
        <DataTable rows={rows} rowKey={(i) => i.id} pageSize={12} search={(i) => i.no + i.invoiceNo + (db.suppliers.find((s) => s.id === i.supplierId)?.name ?? '')}
          toolbar={canPay && <Button size="sm" variant="primary" onClick={() => setPay('')}><Tx>Pay supplier</Tx></Button>}
          empty={<Empty title="No supplier invoices yet" hint="An invoice is made for every goods receipt." />}
          cols={[
            { key: 'no', header: 'Invoice', render: (i) => <><b>{i.no}</b><div className="sub mono">{i.invoiceNo}</div></> }, { key: 's', header: 'Supplier', render: (i) => db.suppliers.find((s) => s.id === i.supplierId)?.name },
            { key: 'd', header: 'Due', sort: (i) => i.dueDate, render: (i) => { const late = daysBetween(i.dueDate, new Date()); return <>{dateFmt(i.dueDate)}{apOpen(i) > 0.004 && late > 0 && <div className="sub bad">{late}{' '}<Tx>days overdue</Tx></div>}</>; } },
            { key: 'a', header: 'Amount', num: true, render: (i) => <>{money(i.amount)}{i.landed > 0 && <div className="sub"><Tx>incl. landed</Tx>{' '}{money(i.landed)}</div>}</> }, { key: 'p', header: 'Paid', num: true, render: (i) => money(i.paid) },
            { key: 'o', header: 'Open', num: true, sort: (i) => apOpen(i), render: (i) => <b>{money(apOpen(i))}</b> },
            { key: 'st', header: 'Status', render: (i) => <Badge tone={i.status === 'paid' ? 'good' : i.status === 'partial' ? 'warn' : i.status === 'void' ? 'bad' : 'info'} dot><Tx>{i.status}</Tx></Badge> },
            { key: 'x', header: '', render: (i) => apOpen(i) > 0.004 && canPay ? <Button size="sm" onClick={() => setPay(i.supplierId)}><Tx>Pay</Tx></Button> : null },
          ]} />
        {pay != null && <PayModal supplierId={pay} onClose={() => setPay(null)} />}
      </Card>
      {payments.length > 0 && (
        <Card title="Supplier payments" flush>
          <DataTable rows={payments} rowKey={(p) => p.id} pageSize={8}
            cols={[
              { key: 'no', header: 'Payment', render: (p) => <><b>{p.no}</b><div className="sub">{dateTimeFmt(p.ts)}</div></> }, { key: 's', header: 'Supplier', render: (p) => db.suppliers.find((s) => s.id === p.supplierId)?.name },
              { key: 'm', header: 'Method', render: (p) => <Tx>{p.method}</Tx> }, { key: 'a', header: 'Amount', num: true, render: (p) => money(p.amount) },
              { key: 'st', header: 'Status', render: (p) => (p.reversal ? <Badge tone="bad" dot><Tx>cancelled</Tx></Badge> : <Badge tone="good" dot><Tx>posted</Tx></Badge>) },
              { key: 'x', header: '', render: (p) => !p.reversal && canPay ? <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: `Cancel ${p.no}?`, body: 'The money is put back on the invoices it paid and the entry is reversed. The payment stays on record.', reason: 'Why is this payment wrong?', danger: true, confirmLabel: 'Cancel the payment' }); if (x.ok) run((d, c) => voidSupplierPayment(d, c, p.id, x.reason, newKey()), { ok: 'Supplier payment cancelled', perm: 'purchasing:approve' }); }}><Tx>Cancel</Tx></Button> : p.reversal ? <span className="muted">{p.reversal.reason}</span> : null },
            ]} />
        </Card>
      )}
    </div>
  );
}
function PayModal({ supplierId, onClose }: { supplierId: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [sid, setSid] = useState(supplierId || db.suppliers[0]?.id || '');
  const open = db.apInvoices.filter((i) => i.supplierId === sid && apOpen(i) > 0.004).sort((a, b) => a.date.localeCompare(b.date));
  const owed = open.reduce((s, i) => s + apOpen(i), 0);
  const dep = supplierDeposit(db, sid);
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PayMethod | 'deposit'>('transfer');
  if (!db.suppliers.length) return <Modal title="Pay supplier" onClose={onClose} footer={<Button onClick={onClose}><Tx>Close</Tx></Button>}><NoSuppliers /></Modal>;
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
        cols={[{ key: 'no', header: 'Return', render: (r) => <b>{r.no}</b> }, { key: 'd', header: 'Date', render: (r) => dateFmt(r.ts) }, { key: 's', header: 'Supplier', render: (r) => db.suppliers.find((s) => s.id === r.supplierId)?.name }, { key: 'r', header: 'Reason', render: (r) => r.reason },
          { key: 'a', header: 'Credit note', num: true, render: (r) => <>{money(r.amount)}{(r.deposit ?? 0) > 0 && <div className="sub"><Tx>kept as supplier deposit</Tx>{' '}{money(r.deposit ?? 0)}</div>}</> }]} />
      {open && <ReturnModal onClose={() => setOpen(false)} />}
    </Card>
  );
}
function ReturnModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [supplierId, setSupplierId] = useState(db.suppliers[0]?.id ?? '');
  const [warehouseId, setWarehouseId] = useState(defaultWarehouse(db));
  const [reason, setReason] = useState('');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState(0);
  const [invoiceId, setInvoiceId] = useState('');
  const sup = db.suppliers.find((s) => s.id === supplierId);
  if (!sup) return <Modal title="Return goods to supplier" size="sm" onClose={onClose} footer={<Button onClick={onClose}><Tx>Close</Tx></Button>}><NoSuppliers /></Modal>;
  const have = productId ? db.balances[bkey(warehouseId, productId)]?.qty ?? 0 : 0;
  return (
    <Modal title="Return goods to supplier" size="sm" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!productId || !(qty > 0) || !reason.trim()} onClick={() => run((d, c) => returnToSupplier(d, c, { supplierId, warehouseId, lines: [{ productId, qty }], invoiceId: invoiceId || undefined, reason }), { ok: 'Return posted — credit note applied', perm: 'purchasing:approve', onOk: onClose })}><Tx>Post return</Tx></Button></>}>
      <div className="col">
        <Field label="Supplier"><Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setInvoiceId(''); }}>{db.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="From warehouse"><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="Item" hint={productId ? `On hand ${qtyFmt(have)} · avg cost ${money(globalAvgCost(db, productId))}` : undefined}><Select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Select…</option>{db.products.filter((p) => p.id === productId || (db.balances[bkey(warehouseId, p.id)]?.qty ?? 0) > 0).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Quantity"><NumInput value={qty || ''} onChange={(n) => setQty(Math.min(have, n || 0))} /></Field>
        <Field label="Apply credit to invoice" hint="Empty: the oldest open invoices; what no open invoice can take is kept as a supplier deposit."><Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}><option value="">— none —</option>{db.apInvoices.filter((i) => i.supplierId === supplierId && apOpen(i) > 0.004).map((i) => <option key={i.id} value={i.id}>{i.no} ({money(apOpen(i))})</option>)}</Select></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
export const _pu = [Banner, Truck, useMemo];
