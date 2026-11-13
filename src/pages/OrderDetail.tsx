import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer, Undo2, XCircle, ArrowRight, Wallet, Gift, Hash } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { advanceOrder, cancelOrder, nextStatuses, returnOrder } from '../domain/orders';
import { allocatedMap, applyCredit, createReceipt, customerCredit, orderBalance, payStatus } from '../domain/payments';
import { CHANNELS, FLOWS, PAY_METHODS, STATUS_LABEL, payLabel } from '../domain/meta';
import { Badge, Banner, Button, ChannelChip, Drawer, Field, Input, KV, Modal, NumInput, Select, StatusBadge, Textarea, useConfirm, useHas, useRun, Tx } from '../ui/kit';
import { usePrintDoc } from '../ui/shared';
import { computeEcon } from '../domain/economics';
import { dateTimeFmt, money, qtyFmt, r2 } from '../lib/util';
import type { ID, OrderLine, PayMethod } from '../domain/types';
import { t as tl } from '../lib/i18n';

export function OrderDrawer({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canCost = useHas('finance:cost');
  const canProfit = useHas('finance:profit');
  const canCancel = useHas('orders:cancel');
  const canPay = useHas('receivables:create');
  const print = usePrintDoc();
  const [ret, setRet] = useState(false);
  const [pay, setPay] = useState(false);
  const o = db.orders.find((x) => x.id === id);
  const alloc = useMemo(() => allocatedMap(db), [db.allocations]);
  const econ = useMemo(() => (o?.recognizedAt && canProfit ? computeEcon(db, { from: undefined }).orders.find((e) => e.orderId === id) : undefined), [db.orders, id, canProfit]); // eslint-disable-line
  if (!o) return <Drawer title="Order not found" onClose={onClose}><div className="muted"><Tx>This order no longer exists.</Tx></div></Drawer>;
  const cust = o.customerId ? db.customers.find((c) => c.id === o.customerId) : undefined;
  const meta = CHANNELS[o.channel];
  const flow = FLOWS[meta.flow];
  const paid = alloc[o.id] || 0;
  const balance = orderBalance(o, paid);
  const ps = payStatus(o, paid);
  const next = nextStatuses(o)[0];
  const branch = db.branches.find((b) => b.id === o.branchId);
  const pays = db.allocations.filter((a) => a.orderId === o.id && a.active).map((a) => ({ a, r: db.receipts.find((r) => r.id === a.receiptId)! })).filter((x) => x.r);
  const returns = db.returns.filter((r) => r.orderId === o.id);
  const credit = o.customerId ? customerCredit(db, o.customerId) : 0;
  const docs: { label: string; type: Parameters<typeof print.open>[0]; station?: 'kitchen' | 'beverage' }[] = [];
  if (o.channel === 'POS' || o.collectedBy === 'merchant') docs.push({ label: 'Receipt', type: 'receipt' });
  if (o.channel !== 'POS' && meta.flow === 'retail') docs.push({ label: 'Packing slip', type: 'packing_slip' }, { label: 'Picking list', type: 'picking_list' });
  if (o.lines.some((l) => l.station === 'kitchen')) docs.push({ label: 'Kitchen ticket', type: 'kitchen_ticket', station: 'kitchen' });
  if (o.lines.some((l) => l.station === 'beverage')) docs.push({ label: 'Beverage ticket', type: 'beverage_ticket', station: 'beverage' });

  return (
    <Drawer onClose={onClose} title={<span className="row gap-6">{o.no} <ChannelChip c={o.channel} /> <StatusBadge status={o.status} /></span>}
      sub={<>{dateTimeFmt(o.createdAt)} · {branch?.name}{o.externalId && <> · <span className="mono">{o.externalId}</span></>}</>}
      footer={<>
        {docs.map((d) => <Button key={d.type} size="sm" onClick={() => print.open(d.type, o.id, d.station)}><Printer size={14} /> <Tx>{d.label}</Tx></Button>)}
        <div className="grow" />
        {canCancel && !o.recognizedAt && !['cancelled', 'completed'].includes(o.status) && (
          <Button size="sm" variant="danger" onClick={async () => { const r = await confirm({ title: `Cancel ${o.no}?`, body: 'Stock reservation is released and any payment already received moves to the customer’s credit balance.', danger: true, confirmLabel: 'Cancel order', reason: true }); if (r.ok) run((d, c) => cancelOrder(d, c, o.id, r.reason), { ok: 'Order cancelled' }); }}><XCircle size={14} />{' '}<Tx>Cancel</Tx></Button>
        )}
        {canCancel && o.recognizedAt && o.status !== 'returned' && <Button size="sm" onClick={() => setRet(true)}><Undo2 size={14} />{' '}<Tx>Return / credit note</Tx></Button>}
        {next && <Button size="sm" variant="primary" onClick={() => run((d, c) => advanceOrder(d, c, o.id), { ok: `Moved to ${STATUS_LABEL[next]}` })}><Tx>Mark</Tx>{' '}<Tx>{STATUS_LABEL[next]}</Tx> <ArrowRight size={14} /></Button>}
      </>}>
      <div className="col gap-16">
        {!['cancelled', 'returned'].includes(o.status) && (
          <div className="steps">{flow.map((s, i) => { const cur = flow.indexOf(o.status); return <span key={s} className={`step ${i < cur ? 'done' : i === cur ? 'now' : ''}`}><Tx>{STATUS_LABEL[s]}</Tx></span>; })}</div>
        )}
        {o.status === 'cancelled' && <Banner tone="bad"><Tx>Cancelled:</Tx>{' '}{o.cancelledReason}</Banner>}
        {meta.collectedBy === 'platform' && <Banner><Tx>Payment is collected by</Tx>{' '}<b><Tx>{meta.label}</Tx></b>{' '}<Tx>and settled to your bank later (see Channels → Settlements). Fees below are</Tx>{' '}{o.fees.estimated ? <b><Tx>estimated</Tx></b> : <b><Tx>final (from settlement)</Tx></b>}.</Banner>}

        <div>
          <table className="t compact">
            <thead><tr><th><Tx>Item</Tx></th><th className="num"><Tx>Qty</Tx></th><th className="num"><Tx>Price</Tx></th><th className="num"><Tx>Disc.</Tx></th><th className="num"><Tx>Total</Tx></th>{canCost && <th className="num"><Tx>Cost</Tx></th>}</tr></thead>
            <tbody>
              {o.lines.map((l: OrderLine) => (
                <tr key={l.id}>
                  <td><b>{l.name}</b>{l.modifiers.map((m) => <div key={m.option} className="sub">+ {m.option}{m.priceDelta ? ` (${money(m.priceDelta)})` : ''}</div>)}{l.note && <div className="sub"><Tx>Note:</Tx>{' '}{l.note}</div>}{l.returnedQty > 0 && <div className="sub bad"><Tx>Returned</Tx>{' '}{l.returnedQty}{l.restockedQty ? <> <Tx vars={{ n: l.restockedQty }}>{'({n} restocked)'}</Tx></> : ''}</div>}</td>
                  <td className="num">{qtyFmt(l.qty)}</td><td className="num">{money(l.unitPrice)}</td><td className="num">{l.discount ? '−' + money(l.discount) : ''}</td><td className="num">{money(l.qty * l.unitPrice - l.discount)}</td>
                  {canCost && <td className="num muted">{o.recognizedAt ? money(l.cost) : '–'}{l.bom && <div className="sub"><Tx>BOM v</Tx>{l.bom.version}</div>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid g2">
          <div className="card card-b">
            <KV items={[
              ['Subtotal', money(o.subtotal)], ['Discounts', o.discountTotal ? '−' + money(o.discountTotal) : '–'], [<b key="t"><Tx>Total</Tx></b>, <b key="tt">{money(o.total)}</b>],
              ...(o.vatRate ? [[`incl. VAT ${(o.vatRate * 100).toFixed(0)}%`, money(r2(o.total - o.total / (1 + o.vatRate)))] as [string, string]] : []),
              ...(o.creditNoted ? [['Credit notes', '−' + money(o.creditNoted)] as [string, string]] : []),
              ...(meta.collectedBy === 'merchant' ? [['Paid', money(paid)] as [string, string], [<b key="b"><Tx>Balance due</Tx></b>, <b key="bb" className={balance > 0 ? 'bad' : balance < 0 ? 'warn' : 'good'}>{money(balance)}</b>] as [React.ReactNode, React.ReactNode]] : []),
            ]} />
            {meta.collectedBy === 'merchant' && <div className="mt8"><Badge tone={ps === 'paid' ? 'good' : ps === 'partial' ? 'warn' : ps === 'unpaid' ? 'bad' : 'info'} dot>{ps}</Badge></div>}
          </div>
          <div className="card card-b">
            <div className="col gap-6">
              <div className="row between"><span className="muted"><Tx>Customer</Tx></span>{cust ? <Link to={`/customers?c=${cust.id}`}>{cust.name}</Link> : <span><Tx>Walk-in</Tx></span>}</div>
              <div className="row between"><span className="muted"><Tx>Type</Tx></span><span>{o.orderType.replace('_', ' ')}{o.tableNo ? <> · <Tx vars={{ n: o.tableNo }}>{'table {n}'}</Tx></> : ''}</span></div>
              {o.pointsEarned > 0 && <div className="row between"><span className="muted"><Tx>Points earned</Tx></span><b>+{o.pointsEarned}</b></div>}
              {o.shipping?.tracking && <div className="row between"><span className="muted"><Tx>Tracking</Tx></span><span className="mono">{o.shipping.carrier} {o.shipping.tracking}</span></div>}
              {o.shipping?.recipient && <div className="row between"><span className="muted"><Tx>Ship to</Tx></span><span>{o.shipping.recipient}</span></div>}
              {o.platformVoucher > 0 && <div className="row between"><span className="muted"><Tx>Platform voucher</Tx></span><span>{money(o.platformVoucher)}</span></div>}
              {o.note && <div className="row between"><span className="muted"><Tx>Note</Tx></span><span>{o.note}</span></div>}
            </div>
          </div>
        </div>

        {o.promotions.length > 0 && (
          <div className="card card-b">
            <h3 className="mb8 row gap-6"><Gift size={15} />{' '}<Tx>Promotions applied</Tx></h3>
            {o.promotions.map((a) => (
              <div key={a.promoId} className="row between" style={{ fontSize: 13, padding: '3px 0' }}>
                <span>{a.name}</span>
                <span className="row gap-6">{a.discount > 0 && <Badge tone="good">−{money(a.discount)}</Badge>}{a.bonusPoints > 0 && <Badge tone="info">+{a.bonusPoints}{' '}<Tx>pts</Tx></Badge>}{a.entitlements > 0 && <Badge tone="info"><Hash size={11} /> {a.entitlements}{' '}<Tx>event pick</Tx>{a.entitlements > 1 ? 's' : ''}</Badge>}{a.freeItems.length > 0 && <Badge tone="good"><Tx>free item</Tx></Badge>}{a.couponIds?.length ? <Badge tone="info"><Tx>coupon issued</Tx></Badge> : null}</span>
              </div>
            ))}
          </div>
        )}

        {meta.collectedBy === 'merchant' && (
          <div className="card card-b">
            <div className="row between mb8"><h3 className="row gap-6"><Wallet size={15} />{' '}<Tx>Payments</Tx></h3>
              <div className="row">{canPay && balance > 0.004 && credit > 0 && <Button size="sm" onClick={() => run((d, c) => applyCredit(d, c, { customerId: o.customerId!, orderId: o.id, amount: balance }), { ok: 'Customer credit applied' })}><Tx>Use credit (</Tx>{money(credit)})</Button>}{canPay && balance > 0.004 && o.status !== 'cancelled' && <Button size="sm" variant="primary" onClick={() => setPay(true)}><Tx>Record payment</Tx></Button>}</div></div>
            {pays.length ? pays.map(({ a, r }) => (
              <div key={a.id} className="row between" style={{ fontSize: 13, padding: '3px 0' }}>
                <span>{r.no} · <Tx>{payLabel(r.method)}</Tx>{r.reference ? ` · ${r.reference}` : ''} <span className="muted">{dateTimeFmt(r.ts)}</span></span>
                <span className="num" style={{ color: a.amount < 0 ? 'var(--crit-text)' : undefined }}>{money(a.amount)}</span>
              </div>
            )) : <div className="muted"><Tx>No payments received yet.</Tx></div>}
          </div>
        )}

        {canProfit && econ && (
          <div className="card card-b">
            <h3 className="mb8"><Tx>Order economics</Tx>{' '}{econ.platform && !econ.feesFinal && <Badge tone="warn"><Tx>provisional fees</Tx></Badge>}</h3>
            <KV items={[['Net sales (ex VAT)', money(econ.net)], ['Cost of goods', '−' + money(econ.cogs)], [<b key="g"><Tx>Gross profit</Tx></b>, <b key="gg">{money(econ.grossProfit)}</b>], ...(econ.channelCosts ? [['Commission', '−' + money(econ.commission)] as [string, string], ['Payment fee', '−' + money(econ.paymentFee)] as [string, string], ['Shipping subsidy', '−' + money(econ.shipping)] as [string, string]] : []), [<b key="c"><Tx>Contribution</Tx></b>, <b key="cc">{money(econ.contribution)}</b>]]} />
          </div>
        )}

        {returns.length > 0 && (
          <div className="card card-b"><h3 className="mb8"><Tx>Returns & credit notes</Tx></h3>
            {returns.map((r) => <div key={r.id} className="row between" style={{ fontSize: 13 }}><span>{r.no} · {r.reason} <span className="muted">{dateTimeFmt(r.ts)}</span></span><b>−{money(r.amount)}</b></div>)}</div>
        )}

        <div className="card card-b">
          <h3 className="mb8"><Tx>History</Tx></h3>
          <div className="timeline">{o.statusLog.map((s, i) => <div key={i}><b><Tx>{STATUS_LABEL[s.status]}</Tx></b> <span className="muted">{dateTimeFmt(s.ts)} · {db.users.find((u) => u.id === s.by)?.name ?? s.by}</span>{s.note && <div className="muted">{s.note}</div>}</div>)}</div>
        </div>
        {o.externalId && (() => { const x = db.externalOrders.find((e) => e.channel === o.channel && e.externalId === o.externalId && e.orderId === o.id); return x ? <details className="acc"><summary><Tx>Source payload (</Tx>{x.source})</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-3)', padding: 10, borderRadius: 8 }}>{JSON.stringify(x.raw, null, 2)}</pre></details> : null; })()}
      </div>
      {print.node}
      {ret && <ReturnDialog id={o.id} onClose={() => setRet(false)} />}
      {pay && <PayDialog id={o.id} max={balance} onClose={() => setPay(false)} />}
    </Drawer>
  );
}

function PayDialog({ id, max, onClose }: { id: ID; max: number; onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const o = db.orders.find((x) => x.id === id)!;
  const [amt, setAmt] = useState<number>(max);
  const [method, setMethod] = useState<PayMethod>('transfer');
  const [ref, setRef] = useState('');
  return (
    <Modal title="Record payment" size="sm" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!(amt > 0)} onClick={() => run((d, c) => createReceipt(d, c, { customerId: o.customerId, amount: amt, method, reference: ref || undefined, allocations: [{ orderId: id, amount: Math.min(amt, max) }] }), { ok: 'Payment recorded', onOk: onClose })}><Tx>Save receipt</Tx></Button></>}>
      <div className="col">
        <Field label="Amount" hint={`Outstanding ${money(max)}${o.customerId ? ' — any excess is kept as customer credit' : ''}`}><NumInput value={amt} onChange={setAmt} /></Field>
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>{PAY_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</Select></Field>
        <Field label="Reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={tl(lang, 'Bank ref / slip no.')} /></Field>
      </div>
    </Modal>
  );
}

function ReturnDialog({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const o = db.orders.find((x) => x.id === id)!;
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'none' | 'cash' | 'transfer' | 'credit' | 'platform'>(o.collectedBy === 'platform' ? 'platform' : 'transfer');
  const amount = o.lines.reduce((s, l) => s + (qty[l.id] || 0) * (l.qty ? l.unitPrice - l.discount / l.qty : 0), 0);
  return (
    <Modal title={`Return / credit note — ${o.no}`} size="lg" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={amount <= 0 || !reason.trim()} onClick={() => run((d, c) => returnOrder(d, c, { orderId: id, lines: o.lines.filter((l) => qty[l.id] > 0).map((l) => ({ lineId: l.id, qty: qty[l.id], restock: !!restock[l.id] })), reason, refund }), { ok: 'Credit note created', onOk: onClose })}><Tx>Create credit note</Tx>{' '}{amount > 0 && `(${money(amount)})`}</Button></>}>
      <table className="t compact">
        <thead><tr><th><Tx>Item</Tx></th><th className="num"><Tx>Returnable</Tx></th><th className="num"><Tx>Return qty</Tx></th><th><Tx>Restock?</Tx></th></tr></thead>
        <tbody>{o.lines.map((l) => { const left = l.qty - l.returnedQty; const isMenu = db.products.find((p) => p.id === l.productId)?.kind === 'menu'; return (
          <tr key={l.id}><td>{l.name}</td><td className="num">{qtyFmt(left)}</td>
            <td className="num"><input className="input sm" style={{ width: 80, textAlign: 'right' }} type="number" min={0} max={left} value={qty[l.id] ?? ''} disabled={left <= 0} onChange={(e) => setQty({ ...qty, [l.id]: Math.min(left, Math.max(0, Number(e.target.value))) })} /></td>
            <td>{isMenu ? <span className="muted"><Tx>Prepared item — cannot restock</Tx></span> : <label className="check"><input type="checkbox" checked={!!restock[l.id]} onChange={(e) => setRestock({ ...restock, [l.id]: e.target.checked })} />{' '}<Tx>Back to stock</Tx></label>}</td></tr>); })}</tbody>
      </table>
      <div className="form-grid mt16">
        <Field label="Reason (required)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label="Refund" hint={o.collectedBy === 'platform' ? 'Marketplace refunds are deducted from your settlement.' : 'Only applies if the order was already paid.'}>
          <Select value={refund} onChange={(e) => setRefund(e.target.value as typeof refund)}>
            {o.collectedBy === 'platform' ? <option value="platform">Via platform (settlement)</option> : <><option value="transfer">Refund by bank transfer</option><option value="cash">Refund in cash</option><option value="credit">Keep as customer credit</option><option value="none">Do not refund now</option></>}
          </Select></Field>
      </div>
    </Modal>
  );
}
