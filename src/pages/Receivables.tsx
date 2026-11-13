import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, FileText, Printer, ShieldAlert, Wallet, X } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { AGING_BUCKETS, agingFor, allocatedMap, approveSlip, createReceipt, customerCredit, customerOutstanding, orderBalance, outstandingOrders, receiptUnapplied, rejectSlip, slipDuplicates, voidReceipt, customerStatement } from '../domain/payments';
import { PAY_METHODS, payLabel } from '../domain/meta';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Seg, Tabs, useConfirm, useHas, useRun, Tx } from '../ui/kit';
import { MediaImg, usePrintDoc } from '../ui/shared';
import { dateFmt, dateTimeFmt, money, money0, r2, relTime } from '../lib/util';
import type { ID, PayMethod } from '../domain/types';
import { OrderDrawer } from './OrderDetail';
import { useMemo as _um } from 'react';
import { t as tl } from '../lib/i18n';

type Tab = 'aging' | 'slips' | 'receipts' | 'credit';

export default function Receivables() {
  const db = useDB();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'aging';
  const canCreate = useHas('receivables:create');
  const [recv, setRecv] = useState<ID | 'new' | null>(sp.get('c') ?? null);
  const [openOrder, setOpenOrder] = useState<ID | null>(null);
  const alloc = useMemo(() => allocatedMap(db), [db.allocations]);
  const aging = useMemo(() => agingFor(db, new Date().toISOString(), (cid) => db.customers.find((c) => c.id === cid)?.creditDays ?? 0), [db.orders, db.allocations]);
  const rows = useMemo(() => db.customers.map((c) => ({ c, out: customerOutstanding(db, c.id, alloc), buckets: aging[c.id] || [0, 0, 0, 0, 0], credit: customerCredit(db, c.id) })).filter((r) => r.out > 0.004 || r.credit > 0.004), [db.orders, db.allocations, db.receipts, db.customers, aging]); // eslint-disable-line
  const total = rows.reduce((s, r) => s + r.out, 0);
  const overdue = rows.reduce((s, r) => s + r.buckets.slice(1).reduce((a, b) => a + b, 0), 0);
  const pendingSlips = db.slips.filter((s) => s.status === 'pending');
  const setTab = (t: Tab) => setSp({ tab: t });

  return (
    <>
      <PageHead title="Receivables & payments" desc="Order value, payment received, customer credit and platform settlement are separate records. One receipt can be allocated across many orders — automatically (FIFO) or manually."
        actions={canCreate && <Button variant="primary" onClick={() => setRecv('new')}><Wallet size={15} />{' '}<Tx>Receive payment</Tx></Button>} />
      <div className="grid g4 mb16">
        <Kpi label="Outstanding (customers)" value={money0(total)} sub={<Tx vars={{ n: rows.filter((r) => r.out > 0).length }}>{'{n} customers'}</Tx>} />
        <Kpi label="Overdue" value={money0(overdue)} tone={overdue > 0 ? 'bad' : undefined} sub="past credit terms" />
        <Kpi label="Slips awaiting review" value={pendingSlips.length} sub="payment evidence uploaded" />
        <Kpi label="Customer credit held" value={money0(db.customers.reduce((s, c) => s + customerCredit(db, c.id), 0))} sub="unapplied receipts" />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'aging', label: 'Outstanding & aging' }, { v: 'slips', label: 'Payment slips', count: pendingSlips.length || '' }, { v: 'receipts', label: 'Receipts' }, { v: 'credit', label: 'Customer credit' }]} />

      {tab === 'aging' && (
        <Card flush>
          <DataTable rows={rows.filter((r) => r.out > 0.004)} rowKey={(r) => r.c.id} pageSize={12} search={(r) => r.c.name + r.c.code}
            empty={<Empty icon={<Check size={22} />} title="No outstanding balances" hint="Everything is paid up." />}
            cols={[
              { key: 'c', header: 'Customer', sort: (r) => r.c.name, render: (r) => <><b>{r.c.name}</b><div className="sub"><Tx>{r.c.group}</Tx>{' '}<Tx>· terms</Tx>{' '}{r.c.creditDays || 0}{' '}<Tx>days · limit</Tx>{' '}{money0(r.c.creditLimit)}</div></> },
              ...AGING_BUCKETS.map((b, i) => ({ key: 'b' + i, header: b, num: true, render: (r: { buckets: number[] }) => (r.buckets[i] > 0 ? <span className={i >= 2 ? 'bad' : ''}>{money0(r.buckets[i])}</span> : <span className="muted">–</span>) })),
              { key: 'o', header: 'Total', num: true, sort: (r: { out: number }) => r.out, render: (r: { out: number }) => <b>{money(r.out)}</b> },
              { key: 'a', header: '', render: (r: { c: { id: ID } }) => canCreate && <Button size="sm" onClick={() => setRecv(r.c.id)}><Tx>Receive</Tx></Button> },
            ]} />
        </Card>
      )}
      {tab === 'slips' && <Slips />}
      {tab === 'receipts' && <Receipts openOrder={setOpenOrder} />}
      {tab === 'credit' && (
        <div className="col gap-16">
          <Banner tone="warn"><b><Tx>Customer credit is a non-cash ledger</Tx></b>{' '}<Tx>(overpayments, refunds kept as credit, cancelled prepaid orders). Real-money wallet top-ups / prepaid stored value are</Tx>{' '}<b><Tx>disabled</Tx></b>{' '}<Tx>until Thai e-money / stored-value regulation has been reviewed by a legal professional — the model is intentionally named “credit”, not “wallet”.</Tx></Banner>
          <Card flush>
            <DataTable rows={rows.filter((r) => r.credit > 0.004)} rowKey={(r) => r.c.id} empty={<Empty title="No customer credit" hint="Credit appears when a customer overpays or a paid order is cancelled." />}
              cols={[{ key: 'c', header: 'Customer', render: (r) => <b>{r.c.name}</b> }, { key: 'cr', header: 'Credit balance', num: true, render: (r) => <b className="good">{money(r.credit)}</b> }, { key: 'o', header: 'Also owes', num: true, render: (r) => (r.out > 0 ? money(r.out) : '–') },
                { key: 'a', header: '', render: (r) => r.out > 0 && canCreate ? <Button size="sm" onClick={() => setRecv(r.c.id)}><Tx>Apply to orders</Tx></Button> : null }]} />
          </Card>
        </div>
      )}
      {recv && <ReceiveModal customerId={recv === 'new' ? undefined : recv} onClose={() => { setRecv(null); if (sp.get('c')) setSp({ tab }); }} />}
      {openOrder && <OrderDrawer id={openOrder} onClose={() => setOpenOrder(null)} />}
    </>
  );
}

function ReceiveModal({ customerId, onClose }: { customerId?: ID; onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const [cid, setCid] = useState<ID>(customerId ?? '');
  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState<PayMethod>('transfer');
  const [ref, setRef] = useState('');
  const [mode, setMode] = useState<'fifo' | 'manual'>('fifo');
  const [manual, setManual] = useState<Record<ID, number>>({});
  const alloc = useMemo(() => allocatedMap(db), [db.allocations]);
  const open = useMemo(() => (cid ? outstandingOrders(db, cid, alloc) : []), [db.orders, db.allocations, cid]); // eslint-disable-line
  const owing = open.reduce((s, x) => s + x.balance, 0);
  const credit = cid ? customerCredit(db, cid) : 0;
  useEffect(() => { if (cid) { setAmount(r2(owing)); setManual({}); } }, [cid]); // eslint-disable-line
  const preview = useMemo(() => {
    let left = amount || 0;
    return open.map((x) => {
      const a = mode === 'fifo' ? r2(Math.min(left, x.balance)) : Math.min(manual[x.order.id] || 0, x.balance);
      if (mode === 'fifo') left = r2(left - a);
      return { ...x, a };
    });
  }, [open, amount, mode, manual]);
  const allocated = r2(preview.reduce((s, x) => s + x.a, 0));
  const unapplied = r2((amount || 0) - allocated);
  const invalid = !cid || !(amount > 0) || (mode === 'manual' && allocated > amount + 0.004);
  return (
    <Modal title="Receive payment" size="lg" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={invalid} onClick={() => run((d, c) => createReceipt(d, c, { customerId: cid, amount, method, reference: ref || undefined, allocations: mode === 'fifo' ? 'fifo' : preview.filter((x) => x.a > 0).map((x) => ({ orderId: x.order.id, amount: x.a })) }), { ok: 'Receipt posted and allocated', perm: 'receivables:create', onOk: onClose })}><Tx>Post receipt</Tx>{' '}{amount > 0 && `(${money(amount)})`}</Button></>}>
      <div className="form-grid">
        <Field label="Customer"><Select value={cid} onChange={(e) => setCid(e.target.value)}><option value="">Select…</option>{db.customers.map((c) => <option key={c.id} value={c.id}>{c.name}{customerOutstanding(db, c.id, alloc) > 0 ? tl(lang, ' — owes {amount}', { amount: money0(customerOutstanding(db, c.id, alloc)) }) : ''}</option>)}</Select></Field>
        <Field label="Amount received (฿)"><NumInput value={amount || ''} onChange={(n) => setAmount(isNaN(n) ? 0 : n)} /></Field>
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>{PAY_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</Select></Field>
        <Field label="Reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={tl(lang, 'Bank ref / cheque no.')} /></Field>
      </div>
      {cid && (
        <div className="mt16">
          <div className="row between mb8"><b><Tx>Allocate to outstanding orders</Tx></b><Seg value={mode} onChange={setMode} options={[{ v: 'fifo', label: 'Automatic (FIFO)' }, { v: 'manual', label: 'Manual' }]} /></div>
          {credit > 0 && <div className="muted mb8"><Tx>This customer also has</Tx>{' '}{money(credit)}{' '}<Tx>of unapplied credit (apply it from the order screen).</Tx></div>}
          {open.length ? (
            <table className="t compact"><thead><tr><th><Tx>Order</Tx></th><th><Tx>Date</Tx></th><th className="num"><Tx>Outstanding</Tx></th><th className="num"><Tx>Apply</Tx></th><th className="num"><Tx>Remaining</Tx></th></tr></thead>
              <tbody>{preview.map((x) => (
                <tr key={x.order.id}><td><b>{x.order.no}</b></td><td>{dateFmt(x.order.createdAt)}</td><td className="num">{money(x.balance)}</td>
                  <td className="num">{mode === 'fifo' ? <b>{x.a ? money(x.a) : '–'}</b> : <input className="input sm" style={{ width: 110, textAlign: 'right' }} type="number" min={0} max={x.balance} value={manual[x.order.id] ?? ''} onChange={(e) => setManual({ ...manual, [x.order.id]: Math.min(x.balance, Math.max(0, Number(e.target.value))) })} />}</td>
                  <td className="num">{money(r2(x.balance - x.a))}</td></tr>))}</tbody>
              <tfoot><tr className="total"><td colSpan={2}><Tx>Total</Tx></td><td className="num">{money(owing)}</td><td className="num">{money(allocated)}</td><td className="num">{money(r2(owing - allocated))}</td></tr></tfoot></table>
          ) : <Empty title="No outstanding orders" hint="A payment now would be kept as customer credit." />}
          {unapplied > 0.004 && <div className="mt8"><Banner tone="info">{money(unapplied)}{' '}<Tx>is not allocated and will be kept as</Tx>{' '}<b><Tx>customer credit</Tx></b>{' '}<Tx>on this customer’s account.</Tx></Banner></div>}
          {mode === 'manual' && allocated > amount + 0.004 && <div className="mt8"><Banner tone="bad"><Tx>Allocated</Tx>{' '}{money(allocated)}{' '}<Tx>exceeds the payment of</Tx>{' '}{money(amount)}.</Banner></div>}
        </div>
      )}
    </Modal>
  );
}

function Slips() {
  const db = useDB();
  const run = useRun();
  const canApprove = useHas('receivables:approve');
  const confirm = useConfirm();
  const [view, setView] = useState<ID | null>(null);
  const pending = db.slips.filter((s) => s.status === 'pending');
  const history = db.slips.filter((s) => s.status !== 'pending').reverse();
  return (
    <div className="col gap-16">
      <Banner><b><Tx>A slip image alone never confirms a payment.</Tx></b>{' '}<Tx>Check the amount and reference against your bank, watch for duplicates, then approve — approving creates a receipt and allocates it to the customer’s orders.</Tx></Banner>
      <Card title="Awaiting review" flush>
        <DataTable rows={pending} rowKey={(s) => s.id} empty={<Empty icon={<Check size={22} />} title="No slips to review" hint="Customers upload transfer slips from the LINE app (Customer app → Statement)." />}
          cols={[
            { key: 'img', header: '', width: 60, render: (s) => <MediaImg m={db.media.find((m) => m.id === s.mediaId)} size={44} fallback="🧾" /> },
            { key: 'c', header: 'Customer', render: (s) => <><b>{db.customers.find((c) => c.id === s.customerId)?.name}</b><div className="sub">{relTime(s.createdAt)}{' '}<Tx>· ref</Tx>{' '}{s.reference ?? '–'}</div></> },
            { key: 'a', header: 'Amount', num: true, render: (s) => <b>{money(s.amount)}</b> },
            { key: 'o', header: 'For orders', render: (s) => s.orderIds.map((id) => db.orders.find((o) => o.id === id)?.no).join(', ') || <span className="muted"><Tx>oldest first</Tx></span> },
            { key: 'd', header: 'Checks', render: (s) => { const d = slipDuplicates(db, s); return d.exact.length ? <Badge tone="bad"><ShieldAlert size={12} />{' '}<Tx>exact duplicate</Tx></Badge> : d.business.length ? <Badge tone="warn"><AlertTriangle size={12} />{' '}<Tx>similar slip</Tx></Badge> : <Badge tone="good"><Tx>no duplicates</Tx></Badge>; } },
            { key: 'x', header: '', render: (s) => <Button size="sm" onClick={() => setView(s.id)}><Tx>Review</Tx></Button> },
          ]} />
      </Card>
      <Card title="Reviewed" flush>
        <DataTable rows={history} rowKey={(s) => s.id} pageSize={8} empty={<Empty title="Nothing reviewed yet" />}
          cols={[
            { key: 'c', header: 'Customer', render: (s) => db.customers.find((c) => c.id === s.customerId)?.name }, { key: 'a', header: 'Amount', num: true, render: (s) => money(s.amount) },
            { key: 's', header: 'Result', render: (s) => <Badge tone={s.status === 'approved' ? 'good' : 'bad'} dot>{s.status}</Badge> },
            { key: 'r', header: 'By', render: (s) => <>{db.users.find((u) => u.id === s.reviewerId)?.name}<div className="sub">{dateTimeFmt(s.reviewedAt)}{s.rejectReason ? ` — ${s.rejectReason}` : ''}</div></> },
          ]} />
      </Card>
      {view && (() => {
        const s = db.slips.find((x) => x.id === view)!;
        const media = db.media.find((m) => m.id === s.mediaId);
        const dup = slipDuplicates(db, s);
        const alloc = allocatedMap(db);
        const orders = s.orderIds.map((id) => db.orders.find((o) => o.id === id)).filter(Boolean);
        return (
          <Modal title="Review payment slip" size="lg" onClose={() => setView(null)} footer={canApprove ? <>
            <Button variant="danger" onClick={async () => { const r = await confirm({ title: 'Reject this slip?', reason: 'Rejection reason (shown to the customer)', danger: true, confirmLabel: 'Reject' }); if (r.ok) run((d, c) => rejectSlip(d, c, s.id, r.reason), { ok: 'Slip rejected', onOk: () => setView(null) }); }}><X size={15} />{' '}<Tx>Reject</Tx></Button>
            <Button variant="primary" disabled={dup.exact.length > 0} onClick={() => run((d, c) => approveSlip(d, c, s.id), { ok: 'Approved — receipt created', perm: 'receivables:approve', onOk: () => setView(null) })}><Check size={15} />{' '}<Tx>Approve</Tx>{' '}{money(s.amount)}</Button></> : <span className="muted"><Tx>You can view but not approve slips.</Tx></span>}>
            <div className="grid g2">
              <div style={{ background: 'var(--surface-3)', borderRadius: 12, padding: 12, display: 'grid', placeItems: 'center', minHeight: 260 }}>{media ? <MediaImg m={media} variant="web" size={300} fallback="🧾" /> : <Empty title="No image attached" />}</div>
              <div className="col">
                <div><div className="muted"><Tx>Customer</Tx></div><b>{db.customers.find((c) => c.id === s.customerId)?.name}</b></div>
                <div><div className="muted"><Tx>Amount claimed</Tx></div><b style={{ fontSize: 24 }}>{money(s.amount)}</b></div>
                <div><div className="muted"><Tx>Reference</Tx></div><span className="mono">{s.reference ?? '–'}</span></div>
                {s.note && <div><div className="muted"><Tx>Customer note</Tx></div>{s.note}</div>}
                {orders.map((o) => o && <div key={o.id} className="row between chip"><span>{o.no}</span><span><Tx>due</Tx>{' '}{money(orderBalance(o, alloc[o.id] || 0))}</span></div>)}
                {orders.length > 0 && s.amount < orders.reduce((a, o) => a + (o ? orderBalance(o, alloc[o.id] || 0) : 0), 0) - 0.01 && <Banner tone="warn"><Tx>Amount is lower than the order balance — the order will remain part-paid.</Tx></Banner>}
                {dup.exact.length > 0 && <Banner tone="bad"><b><Tx>Exact duplicate image</Tx></b>{' '}<Tx>of a slip already submitted. Approving is blocked.</Tx></Banner>}
                {dup.business.length > 0 && <Banner tone="warn"><b><Tx>Similar slip:</Tx></b>{' '}<Tx>same customer, same amount within 24 h. Check the bank statement before approving.</Tx></Banner>}
                {media && <div className="muted" style={{ fontSize: 12 }}><Tx>File</Tx>{' '}{media.name}{' '}<Tx>· SHA-256</Tx>{' '}{media.checksum.slice(0, 14)}<Tx>… · scan:</Tx>{' '}{media.status}</div>}
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

function Receipts({ openOrder }: { openOrder: (id: ID) => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const print = usePrintDoc();
  const canCancel = useHas('receivables:cancel');
  const [v, setV] = useState<'all' | 'void'>('all');
  const rows = useMemo(() => [...db.receipts].reverse().filter((r) => v === 'all' || r.status === 'void'), [db.receipts, v]);
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(r) => r.id} pageSize={12} search={(r) => `${r.no} ${r.reference ?? ''} ${db.customers.find((c) => c.id === r.customerId)?.name ?? ''}`}
        toolbar={<Seg value={v} onChange={setV} options={[{ v: 'all', label: 'All' }, { v: 'void', label: 'Voided' }]} />}
        cols={[
          { key: 'no', header: 'Receipt', sort: (r) => r.no, render: (r) => <><b>{r.no}</b><div className="sub">{dateTimeFmt(r.ts)}</div></> },
          { key: 'c', header: 'Customer', hideSm: true, render: (r) => db.customers.find((c) => c.id === r.customerId)?.name ?? <span className="muted"><Tx>Walk-in</Tx></span> },
          { key: 'm', header: 'Method', render: (r) => <><Tx>{payLabel(r.method)}</Tx>{r.reference && <div className="sub mono">{r.reference}</div>}</> },
          { key: 'a', header: 'Amount', num: true, sort: (r) => r.amount, render: (r) => <b>{money(r.amount)}</b> },
          { key: 'al', header: 'Applied to', render: (r) => <div className="row wrap gap-4">{db.allocations.filter((a) => a.receiptId === r.id && a.active && a.kind === 'payment').slice(0, 3).map((a) => <button key={a.id} className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => openOrder(a.orderId)}>{db.orders.find((o) => o.id === a.orderId)?.no} {money0(a.amount)}</button>)}{receiptUnapplied(db, r) > 0.004 && <Badge tone="info"><Tx>credit</Tx>{' '}{money0(receiptUnapplied(db, r))}</Badge>}</div> },
          { key: 's', header: 'Status', render: (r) => (r.status === 'void' ? <Badge tone="bad"><Tx>void</Tx></Badge> : <Badge tone="good"><Tx>posted</Tx></Badge>) },
          { key: 'x', header: '', render: (r) => <div className="row gap-4"><Button size="sm" variant="ghost" icon title={tl(lang, 'Print receipt')} onClick={() => print.open('payment_receipt', r.id)}><Printer size={14} /></Button>{canCancel && r.status === 'posted' && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: `Void ${r.no}?`, body: 'A reversing journal is posted and the allocated orders become outstanding again.', reason: true, danger: true, confirmLabel: 'Void receipt' }); if (x.ok) run((d, c) => voidReceipt(d, c, r.id, x.reason), { ok: 'Receipt voided' }); }}><Tx>Void</Tx></Button>}</div> },
        ]} />
      {print.node}
    </Card>
  );
}
export const _r = [FileText, _um, customerStatement];
