import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useDB } from '../domain/store';
import { bomRequirement } from '../domain/bom';
import { onHand } from '../domain/inventory';
import { approveOrder, cancelOrder, closeOrder, orderTotals, planOrder, pool, reopenOrder, reverseConversion, reverseIssue, reverseLoss, reverseReceipt, reverseReturn, runDefaults, shortages, unitsLeft } from '../domain/production';
import { orderCost } from '../domain/productionAnalysis';
import { Badge, Banner, Button, Card, Empty, Kpi, useRun } from '../ui/kit';
import { cx, dateFmt, dateTimeFmt, money, qtyFmt, r3 } from '../lib/util';
import type { ID, ProductionOrder } from '../domain/types';
import { STATUS, docLabel, docsOf, isRunning, journalsOf, newKey, nextStep, stepsOf, type NextStep, type ProdDoc } from './forms';
import { Cost, Entries, Missing, OrderBadge, Qty, journalOf, nameOf, prodOf, unitOf, useKey, useMay, usePost, useT, userName, whName, type Go } from './parts';
import { ActionPanel, COST_KIND, DOING, type Doing } from './OrderActions';
import { VarianceTable } from './CostTab';
import { useMayLeave } from './unsaved';

const NEXT: Record<NextStep, string> = {
  plan: 'Next: plan the order, so that it can be approved.', approve: 'Next: approve the order. After that, materials can be issued and production recorded.',
  run: 'Next: record production. The BOM still expects material or a cost for what is left to make (rejected units have to be made again). Materials, costs and finished goods can be posted as one step, or one by one.',
  receive: 'Next: the materials are issued. Receive the finished goods when they are ready.',
  finish: 'Next: receive the rest, or close the order if nothing more will be made.', done: 'This order is completed. To correct it, reverse a document below with a reason.', cancelled: 'This order was cancelled. It is kept for the record.',
};
/** The order's own steps. Old orders of the single-step flow show their runs as documents. */
export function OrderDetail({ id, go, doing }: { id: ID; go: Go; doing?: Doing }) {
  const db = useDB(), T = useT(), run = useRun(), post = usePost(), may = useMay(), planKey = useKey(), approveKey = useKey(), leave = useMayLeave();
  const [act, setAct] = useState<Doing | null>(doing ?? null);
  const po = db.productionOrders.find((o) => o.id === id);
  // a step puts another button where the pressed one was: for a moment none of them can be pressed, so a double tap on "Plan order" does not approve it as well
  const status = po?.status, was = useRef(status), [calm, setCalm] = useState(false);
  useLayoutEffect(() => { if (was.current !== status) { was.current = status; setCalm(true); } }, [status]);
  useEffect(() => { if (!calm) return undefined; const i = setTimeout(() => setCalm(false), 600); return () => clearTimeout(i); }, [calm]);
  const Back = <div className="mb8"><Button size="sm" variant="ghost" onClick={() => go({ tab: 'orders' })}><ArrowLeft size={14} /> {T('Back to the orders')}</Button></div>;
  if (!po) return <>{Back}<Empty title="This production order does not exist" hint="It may belong to another device: production data is kept on the device where it was entered." /></>;
  const t = orderTotals(po), p = prodOf(db, po.productId), unit = p?.unit ?? '', running = isRunning(po), next = nextStep(db, po), short = shortages(db, po), produced = t.good > 0 || t.rejected > 0;
  const hasPool = pool(po).materials.length > 0;
  const buttons: Doing[] = po.status === 'approved' ? ['run', 'issue', 'cost'] : ['run', 'issue', 'cost', 'receive', 'loss', ...(hasPool ? ['return' as const] : [])];
  const best: Doing = next === 'receive' || next === 'finish' ? 'receive' : 'run';
  const canDo = (x: Doing) => (x !== 'cost' && x !== 'loss') || may.cost; // a cost cannot be typed by somebody who may not see one
  const shown = act && running && may.create && buttons.includes(act) && canDo(act) ? act : null;
  const pick = async (x: Doing | null) => { if (x !== shown && (await leave())) setAct(x); };
  const closeKey = newKey();
  const close = () => post({ title: 'Close this order?', words: ['No more goods will be received. Cost that is left in work in progress is posted to the production variance accounts. Material that is left over can be returned to stock first.'], confirmLabel: 'Close order', ok: 'Production order closed', exec: (d, c) => closeOrder(d, c, po.id, undefined, closeKey) });
  const cancel = () => post({ title: 'Cancel this production order?', words: ['Cost that is left in work in progress is posted to the production variance accounts. Material that was not used should be returned to stock first.'], confirmLabel: 'Cancel this order', ok: 'Production order cancelled', danger: true, reason: true, exec: (d, c, x) => cancelOrder(d, c, po.id, x.reason, closeKey) });
  const reopen = () => post({ title: 'Open this order again?', words: ['The production variance posted when it was closed or cancelled is reversed, and that cost is back in work in progress. Stock does not change.'], confirmLabel: 'Open again', ok: 'Production order opened again', reason: true, exec: (d, c, x) => reopenOrder(d, c, po.id, x.reason, closeKey) });
  const reopenable = po.status === 'cancelled' || (po.status === 'completed' && po.closedBy === 'close');
  return (
    <div data-testid="order-page">
      {Back}
      <div className="page-head">
        <div><h2 className="mfg-h">{po.no} <OrderBadge s={po.status} /></h2><p><b>{nameOf(db, po.productId)}</b> · <span className="mono">{p?.sku}</span> · BOM v{po.snapshot.version} · {whName(db, po.warehouseId)}{po.dueAt ? ` · ${T('Due')} ${dateFmt(po.dueAt)}` : ''}</p>{po.note && <p>{po.note}</p>}</div>
        <div className="row wrap">
          {po.status === 'draft' && may.create && <><Button onClick={() => go({ tab: 'orders', order: po.id, edit: '1' })}>{T('Change draft')}</Button><Button variant="primary" disabled={calm} onClick={() => run((d, c) => planOrder(d, c, po.id, planKey), { ok: 'Order planned' })}>{T('Plan order')}</Button></>}
          {po.status === 'planned' && may.approve && <Button variant="primary" disabled={calm} onClick={() => run((d, c) => approveOrder(d, c, po.id, approveKey), { ok: 'Order approved' })}><CheckCircle2 size={15} /> {T('Approve order')}</Button>}
          {running && may.create && buttons.filter(canDo).map((x) => <Button key={x} variant={x === best && !shown ? 'primary' : undefined} aria-expanded={shown === x} disabled={calm} onClick={() => void pick(shown === x ? null : x)}>{T(DOING[x].title)}</Button>)}
          {running && may.approve && produced && <Button disabled={calm} onClick={() => void close()}>{T('Close order')}</Button>}
          {po.status !== 'completed' && po.status !== 'cancelled' && may.approve && !produced && <Button variant="ghost" disabled={calm} onClick={() => void cancel()}>{T('Cancel this order')}</Button>}
          {reopenable && may.approve && <Button disabled={calm} onClick={() => void reopen()}>{T('Open again')}</Button>}
        </div>
      </div>
      <ol className="steps mfg-steps" aria-label={T('Order steps')}>{stepsOf(po).map((s) => <li key={s.status} className={cx('step', s.state)} aria-current={s.state === 'now' ? 'step' : undefined}>{T(STATUS[s.status].label)}</li>)}</ol>
      <div className="mb16 mt8" data-testid="next-step"><Banner tone={next === 'done' ? 'good' : 'info'}>{T(next === 'approve' && !may.approve ? 'This order waits for the approval of a manager.' : next === 'done' && reopenable ? 'This order was closed before everything was received. It can be opened again with a reason.' : NEXT[next])}</Banner></div>
      {shown && <ActionPanel key={shown} po={po} doing={shown} onClose={() => setAct(null)} onSwitch={(x) => setAct(x)} />}
      {short.length > 0 && <div className="mb16" data-testid="order-shortages"><Banner tone="warn"><><b>{T('Not enough stock in {w}:', { w: whName(db, po.warehouseId) })}</b> {short.map((s) => T('{name} short {n} {unit}', { name: s.name, n: qtyFmt(s.short), unit: s.unit }) + (s.elsewhere ? ` (${T('other warehouses hold {n}', { n: qtyFmt(s.elsewhere) })})` : '')).join(' · ')}</></Banner></div>}
      <div className="grid mfg-kpis mb16">
        <Kpi label="Planned quantity" value={qtyFmt(po.plannedQty)} sub={unit} /><Kpi label="Good units received" value={qtyFmt(t.good)} sub={T('{n} still to make', { n: qtyFmt(t.remaining) })} /><Kpi label="Rejected units" value={qtyFmt(t.rejected)} sub={unit} />
        {may.cost && <><Kpi label="Actual unit cost" value={t.unitCost == null ? '–' : <Cost v={t.unitCost > 0 ? t.unitCost : null} />} sub={t.unitCost == null ? T('Known after the first receipt') : T('per {unit}', { unit })} /><Kpi label="Work in progress" value={money(t.wipTotal)} sub="Cost not yet in finished goods" /></>}
      </div>
      <div className="mfg-two">
        <Materials po={po} />
        {may.cost && <Costs po={po} />}
      </div>
      <Documents po={po} />
      <div className="mfg-two">
        {may.cost && <Journals po={po} />}
        <Card title="Order history"><div className="timeline" data-testid="order-events">{[...(po.events ?? [{ ts: po.createdAt, userId: po.createdBy, from: '', to: po.status }])].reverse().map((e, i) => (
          <div key={i}><b>{T(STATUS[e.to as ProductionOrder['status']]?.label ?? e.to)}</b>{e.from && <span className="muted"> · {T('before: {s}', { s: T(STATUS[e.from as ProductionOrder['status']]?.label ?? e.from) })}</span>}<div className="sub muted">{dateTimeFmt(e.ts)} · {userName(db, e.userId)}</div>{'note' in e && e.note && <div className="text2">{e.note}</div>}</div>))}</div></Card>
      </div>
    </div>
  );
}

/** Planned for the whole order, what is in it now (issued less returned and less what receipts, losses and closes used), and what the BOM still asks for. */
function Materials({ po }: { po: ProductionOrder }) {
  const db = useDB(), T = useT(), got = new Map<ID, number>();
  for (const i of po.issues ?? []) if (!i.reversal) for (const l of i.lines) got.set(l.productId, r3((got.get(l.productId) ?? 0) + l.qty));
  for (const i of po.returns ?? []) if (!i.reversal) for (const l of i.lines) got.set(l.productId, r3((got.get(l.productId) ?? 0) - l.qty));
  const open = po.status !== 'completed' && po.status !== 'cancelled', more = open ? runDefaults(db, po, unitsLeft(po)).lines : [], here = new Map(pool(po).materials.map((x) => [x.productId, x.qty]));
  const need = bomRequirement(po.snapshot, po.plannedQty), extra = [...got.keys()].filter((x) => !need.some((n) => n.productId === x)).map((productId) => ({ productId, qty: 0 }));
  return (
    <Card flush title="Materials: planned and issued" sub="Planned for the whole order, waste allowance included. Issued is net of returns.">
      <div className="table-wrap" role="region" aria-label={T('Scrollable table')} tabIndex={0}><table className="t compact" data-testid="order-materials"><thead><tr><th>{T('Component')}</th><th className="num">{T('Planned quantity')}</th><th className="num">{T('Quantity issued')}</th><th className="num">{T('In the order now')}</th>{open && <><th className="num">{T('Still to issue')}</th><th className="num">{T('On hand')}</th></>}</tr></thead>
        <tbody>{[...need, ...extra].map((n) => { const is = got.get(n.productId) ?? 0, left = more.find((m) => m.productId === n.productId)?.qty ?? 0, have = onHand(db, po.warehouseId, n.productId), u = unitOf(db, n.productId); return (
          <tr key={n.productId} className={cx(open && left > have + 5e-4 && 'mfg-short')}><td><b>{nameOf(db, n.productId)}</b><div className="sub mono">{prodOf(db, n.productId)?.sku}</div></td><td className="num">{n.qty ? <Qty n={n.qty} unit={u} /> : <span className="muted">{T('Not in the BOM')}</span>}</td><td className="num"><Qty n={is} unit={u} /></td><td className="num">{qtyFmt(here.get(n.productId) ?? 0)}</td>{open && <><td className="num">{left ? <Qty n={left} unit={u} /> : '–'}</td><td className={cx('num', left > have + 5e-4 && 'bad')}>{qtyFmt(have)}</td></>}</tr>); })}</tbody></table></div>
    </Card>
  );
}
function Costs({ po }: { po: ProductionOrder }) {
  const db = useDB(), T = useT(), c = orderCost(db, po), e = c.estimated, missing = (po.estimate?.lines ?? []).filter((l) => l.unitCost == null).map((l) => nameOf(db, l.productId));
  if (po.estimate && po.estimate.laborPerUnit == null) missing.push('Labour cost');
  if (po.estimate && po.estimate.overheadPerUnit == null) missing.push('Overhead cost');
  return (
    <Card title="Estimated and actual cost" sub="The estimate was made when the order was approved. Actual is what was really recorded, less material returned.">
      <div className="col">
        <table className="t compact" data-testid="order-costs"><thead><tr><th /><th className="num">{T('Estimated')}</th><th className="num">{T('Actual')}</th></tr></thead><tbody>
          {(['materials', 'labor', 'overhead'] as const).map((k) => <tr key={k}><td>{T(k === 'materials' ? 'Materials' : k === 'labor' ? 'Labour' : 'Overhead and other costs')}</td><td className="num">{e ? <Cost v={e[k]} /> : '–'}</td><td className="num">{money(c.actual[k])}</td></tr>)}
          <tr className="total"><td>{T('Total')}</td><td className="num">{e ? <Cost v={e.total} /> : '–'}</td><td className="num">{money(c.actual.total)}</td></tr>
          <tr><td>{T('Per {unit}', { unit: unitOf(db, po.productId) })}</td><td className="num">{e ? <Cost v={c.estimatedPerUnit} /> : '–'}</td><td className="num">{c.actualPerUnit == null ? '–' : <Cost v={c.actualPerUnit > 0 ? c.actualPerUnit : null} />}</td></tr>
        </tbody></table>
        <Missing list={missing} />
        {c.variances && <VarianceTable v={c.variances} waste={c.waste} leftover={c.leftover} />}
      </div>
    </Card>
  );
}

const REVERSE = { issue: reverseIssue, return: reverseReturn, cost: reverseConversion, loss: reverseLoss, receipt: reverseReceipt } as const;
const REVERSE_WORDS: Record<keyof typeof REVERSE, string> = {
  issue: 'The materials go back into stock at the value they left with, and their cost leaves work in progress.',
  return: 'The material leaves stock again and its cost goes back into work in progress. If its average cost has changed since, the difference is posted as a material variance.',
  cost: 'The cost leaves work in progress again: the entry is posted the other way round and the first entry is kept.',
  loss: 'The cost comes back from the waste expense into work in progress. Stock does not change.',
  receipt: 'The goods leave stock and their cost goes back to work in progress. A completed order opens again.',
};
function Documents({ po }: { po: ProductionOrder }) {
  const db = useDB(), T = useT(), may = useMay(), post = usePost(), docs = docsOf(po);
  const reverse = (x: ProdDoc) => {
    const key = newKey(), k = x.kind as keyof typeof REVERSE;
    return post({ title: 'Reverse this entry?', words: [REVERSE_WORDS[k]], confirmLabel: 'Reverse entry', ok: 'Entry reversed', danger: true, reason: true, exec: (d, c, r) => REVERSE[k](d, c, po.id, x.id, r.reason, key) });
  };
  const running = isRunning(po);
  const can = (x: ProdDoc) => may.approve && !x.reversal && (x.kind === 'receipt' ? po.status !== 'cancelled' : x.kind in REVERSE && running);
  const what = (x: ProdDoc) => {
    if (x.kind === 'cost') return <>{T(COST_KIND[x.cost!])}{x.note ? ` · ${x.note}` : ''}</>;
    if (x.kind === 'loss') return <>{x.note}</>;
    if (x.kind === 'variance') return <>{T(x.why === 'closed' ? 'Cost left when the order was closed' : 'Cost left when the order was cancelled')}</>;
    if (x.lines) return <>{x.lines.map((l, i) => <div key={i}>{nameOf(db, l.productId)} <span className="muted">× {qtyFmt(l.qty)} {unitOf(db, l.productId)} · {whName(db, l.warehouseId)}</span></div>)}{x.kind === 'return' && x.note && <div className="sub">{x.note}</div>}</>;
    return <>{T('{n} good', { n: qtyFmt(x.good ?? 0) })}{x.rejected ? ` · ${T('{n} rejected', { n: qtyFmt(x.rejected) })}` : ''}{x.final ? ` · ${T('Last receipt')}` : ''} <span className="muted">· {whName(db, x.warehouseId)}</span>{may.cost && x.variance ? <div className="sub">{T('{v} of it posted as production variance', { v: money(x.variance) })}</div> : null}{x.note ? <div className="sub">{x.note}</div> : null}</>;
  };
  return (
    <Card className="mt16 mb16" flush title="Documents" sub="Nothing posted is ever changed or deleted. A mistake is corrected by a reversal with a reason.">
      {!docs.length ? <Empty title="No document yet" hint="Issues, costs and receipts of this order will be listed here with their journal numbers." /> : (
        <div className="table-wrap" role="region" aria-label={T('Scrollable table')} tabIndex={0}><table className="t compact" data-testid="order-docs"><thead><tr><th>{T('Document')}</th><th>{T('Details')}</th>{may.cost && <th className="num">{T('Value')}</th>}<th>{T('Journal no.')}</th><th /></tr></thead><tbody>
          {docs.map((x) => (
            <tr key={x.id} className={cx(x.reversal && 'mfg-rev')} data-doc={x.kind}><td><b>{T(docLabel(x))}</b><div className="sub">{x.no ? `${x.no} · ` : ''}{dateTimeFmt(x.ts)}{x.userId ? ` · ${userName(db, x.userId)}` : ''}</div></td><td>{what(x)}{x.reversal && <div className="mt8"><Badge tone="bad">Entry reversed</Badge> <span className="sub">{x.reversal.reason} · {dateTimeFmt(x.reversal.ts)} · {userName(db, x.reversal.userId)}</span></div>}</td>
              {may.cost && <td className="num">{x.value > 0 ? money(x.value) : x.kind === 'variance' ? money(x.value) : <Cost v={null} />}</td>}<td className="mono">{journalOf(db, x.journalId)?.no ?? '–'}{x.reversal?.journalId && <div className="sub">{journalOf(db, x.reversal.journalId)?.no}</div>}</td>
              <td>{can(x) && <Button size="sm" variant="ghost" onClick={() => void reverse(x)}>{T('Reverse entry')}</Button>}</td></tr>))}
        </tbody></table></div>
      )}
    </Card>
  );
}
function Journals({ po }: { po: ProductionOrder }) {
  const db = useDB(), T = useT(), [open, setOpen] = useState<ID | null>(null), js = journalsOf(db, po);
  return (
    <Card title="Journal entries of this order" sub="Every entry balances. Select a number to see its lines.">
      {!js.length ? <div className="muted">{T('Nothing has been posted yet.')}</div> : <div className="col gap-6" data-testid="order-journals">{js.map((j) => (
        <Fragment key={j.id}><button type="button" className="mfg-jrow" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}><span><span className="mono">{j.no}</span>{j.status === 'reversed' && <> <Badge tone="bad">Entry reversed</Badge></>}{j.reverses && <> <Badge>Reversal entry</Badge></>}<span className="sub muted"> {dateTimeFmt(j.date)}</span></span><b className="num">{money(j.lines.reduce((s, l) => s + l.debit, 0))}</b></button>{open === j.id && <Entries lines={j.lines} />}</Fragment>))}</div>}
    </Card>
  );
}
