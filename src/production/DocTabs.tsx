import { useMemo, useState } from 'react';
import { History, PackageCheck, PackageMinus } from 'lucide-react';
import { useDB } from '../domain/store';
import { unitsLeft } from '../domain/production';
import { PRODUCT_KIND_LABEL } from '../domain/meta';
import { Badge, Button, Card, DataTable, Empty, Select, type Col } from '../ui/kit';
import { dateTimeFmt, money, qtyFmt } from '../lib/util';
import type { DB, ID } from '../domain/types';
import { STATUS, historyOf, isRunning, leftToIssue, nextStep, traceOf, type HistoryRow, type TraceRow } from './forms';
import { Cost, OrderBadge, journalOf, nameOf, prodOf, unitOf, useMay, useT, userName, whName, type Go } from './parts';
import { NoOrders } from './Orders';
import { COST_KIND } from './OrderActions';

type T = ReturnType<typeof useT>;
/** The order number as a button, so that every list leads to its order by keyboard too. */
function OrderLink({ id, no, go }: { id: ID; no: string; go: Go }) { return <button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); go({ tab: 'orders', order: id }); }}>{no}</button>; }
const orderOf = (db: DB, id?: ID) => db.productionOrders.find((o) => o.id === id);
/** Name, SKU and kind of a product in one cell. */
function Item({ db, id, T }: { db: DB; id: ID; T: T }) { const p = prodOf(db, id); return <><b>{nameOf(db, id)}</b><div className="sub"><span className="mono">{p?.sku}</span>{p ? ` · ${T(PRODUCT_KIND_LABEL[p.kind])}` : ''}</div></>; }
const searchOf = (db: DB, r: { orderNo?: string; no: string; productId?: ID; outputId?: ID; note?: string; userId?: ID }) =>
  [r.orderNo, r.no, r.productId && nameOf(db, r.productId), r.productId && prodOf(db, r.productId)?.sku, r.outputId && nameOf(db, r.outputId), r.note, userName(db, r.userId)].filter(Boolean).join(' ');

/** The columns every line of material or goods has: when and who, order, document, BOM version, item, quantity and place; cost and journal for those who may see them. */
function traceCols(db: DB, T: T, go: Go, cost: boolean, what: 'material' | 'goods'): Col<TraceRow>[] {
  const TYPE: Record<TraceRow['kind'], string> = { issue: 'Issue to production', return: 'Return to stock', receipt: 'Receipt from production', batch: 'Production recorded' };
  return [
    { key: 'd', header: 'Date', sort: (r) => r.ts, render: (r) => <>{dateTimeFmt(r.ts)}<div className="sub">{userName(db, r.userId)}</div></> },
    { key: 'o', header: 'Production order no.', sort: (r) => r.orderNo, render: (r) => <><OrderLink id={r.orderId} no={r.orderNo} go={go} /><div className="sub">{nameOf(db, r.outputId)} · BOM v{r.bomVersion}</div></> },
    { key: 'n', header: 'Document', render: (r) => <><b className="mono">{r.no || '–'}</b><div className="sub">{T(TYPE[r.kind])}</div>{r.reversal && <Badge tone="bad">Entry reversed</Badge>}{r.final && <Badge>Last receipt</Badge>}</> },
    { key: 'p', header: what === 'material' ? 'Material' : 'Product', sort: (r) => nameOf(db, r.productId), render: (r) => <Item db={db} id={r.productId} T={T} /> },
    { key: 'q', header: 'Quantity', num: true, sort: (r) => r.qty, render: (r) => <><b className={r.kind === 'issue' ? 'bad' : 'good'}>{r.kind === 'issue' ? '−' : '+'}{qtyFmt(r.qty)} {unitOf(db, r.productId)}</b>{r.rejected ? <div className="sub">{T('{n} rejected', { n: qtyFmt(r.rejected) })}</div> : null}</> },
    { key: 'w', header: 'Warehouse', hideSm: true, render: (r) => whName(db, r.warehouseId) },
    ...(cost ? [{ key: 'u', header: 'Unit cost', num: true, render: (r: TraceRow) => (r.qty > 0 ? <Cost v={r.unitCost > 0 ? r.unitCost : null} /> : '–') }, { key: 'v', header: 'Value', num: true, render: (r: TraceRow) => (r.value > 0 ? money(r.value) : <Cost v={null} />) }] : []),
    { key: 'j', header: 'Journal no.', hideSm: true, render: (r) => <span className="mono">{journalOf(db, r.journalId)?.no ?? '–'}</span> },
  ];
}

export function Consumption({ go }: { go: Go }) {
  const db = useDB(), T = useT(), may = useMay();
  const waiting = useMemo(() => db.productionOrders.filter((o) => isRunning(o)).map((o) => ({ o, n: leftToIssue(db, o) })).filter((x) => x.n.length), [db]);
  const rows = useMemo(() => traceOf(db).filter((r) => r.kind === 'issue' || r.kind === 'return'), [db]);
  return (
    <div className="col gap-16" data-testid="tab-consumption">
      {waiting.length > 0 && (
        <Card flush title="Orders that still need materials" sub="Approved orders with materials left to issue, rejected units to make again included">
          <DataTable rows={waiting} rowKey={(x) => x.o.id} pageSize={6} cols={[
            { key: 'o', header: 'Production order no.', render: (x) => <><OrderLink id={x.o.id} no={x.o.no} go={go} /><div className="sub">{nameOf(db, x.o.productId)}</div></> }, { key: 's', header: 'Status', hideSm: true, render: (x) => <OrderBadge s={x.o.status} /> },
            { key: 'n', header: 'Still to issue', render: (x) => <>{x.n.slice(0, 3).map((l) => <div key={l.productId}>{nameOf(db, l.productId)} <span className="muted">× {qtyFmt(l.qty)} {unitOf(db, l.productId)}</span></div>)}{x.n.length > 3 && <div className="sub">{T('and {n} more', { n: x.n.length - 3 })}</div>}</> },
            { key: 'a', header: '', right: true, render: (x) => may.create && <Button size="sm" variant="primary" onClick={() => go({ tab: 'orders', order: x.o.id, do: 'issue' })}>{T('Issue materials')}</Button> },
          ]} />
        </Card>
      )}
      <Card flush title="Materials issued and returned" sub="Every line that left stock for production or came back unused, newest first. Search by order number, document, material or person.">
        <DataTable rows={rows} rowKey={(r) => r.id} pageSize={14} search={(r) => searchOf(db, r)}
          empty={db.productionOrders.length ? <Empty icon={<PackageMinus size={22} />} title="No material has been issued yet" hint="Open an approved order and choose “Record production” or “Issue materials”." /> : <NoOrders go={go} />}
          cols={traceCols(db, T, go, may.cost, 'material')} />
      </Card>
    </div>
  );
}

export function Receipts({ go }: { go: Go }) {
  const db = useDB(), T = useT(), may = useMay();
  // only orders whose next step really is a receipt: one that still needs material (rejects to make again) is listed under Material consumption
  const ready = useMemo(() => db.productionOrders.filter((o) => (o.status === 'in_progress' || o.status === 'partially_completed') && ['receive', 'finish'].includes(nextStep(db, o))), [db]);
  const rows = useMemo(() => traceOf(db).filter((r) => r.kind === 'receipt' || r.kind === 'batch'), [db]);
  return (
    <div className="col gap-16" data-testid="tab-receipts">
      {ready.length > 0 && (
        <Card flush title="Orders ready to receive" sub="Materials and costs are in the order; goods still to come">
          <DataTable rows={ready} rowKey={(o) => o.id} pageSize={6} cols={[
            { key: 'o', header: 'Production order no.', render: (o) => <><OrderLink id={o.id} no={o.no} go={go} /><div className="sub">{nameOf(db, o.productId)}</div></> }, { key: 's', header: 'Status', hideSm: true, render: (o) => <OrderBadge s={o.status} /> },
            { key: 'n', header: 'Still to make', num: true, render: (o) => `${qtyFmt(unitsLeft(o))} ${unitOf(db, o.productId)}` },
            { key: 'a', header: '', right: true, render: (o) => may.create && <Button size="sm" variant="primary" onClick={() => go({ tab: 'orders', order: o.id, do: 'receive' })}>{T('Receive finished goods')}</Button> },
          ]} />
        </Card>
      )}
      <Card flush title="Finished goods received" sub="Every receipt from production, newest first. Search by order number, document, product or person.">
        <DataTable rows={rows} rowKey={(r) => r.id} pageSize={14} search={(r) => searchOf(db, r)}
          empty={db.productionOrders.length ? <Empty icon={<PackageCheck size={22} />} title="No finished goods have been received yet" hint="Open an order in production and choose “Record production” or “Receive finished goods”." /> : <NoOrders go={go} />}
          cols={traceCols(db, T, go, may.cost, 'goods')} />
      </Card>
    </div>
  );
}

const KIND: Record<HistoryRow['kind'], string> = { status: 'Order steps', issue: 'Materials issued', return: 'Materials returned', cost: 'Cost recorded', loss: 'Abnormal loss', receipt: 'Finished goods received', variance: 'Cost left posted as variance', batch: 'Production recorded', reversal: 'Entry reversed', bom: 'BOM changes' };
export function HistoryTab({ go }: { go: Go }) {
  const db = useDB(), T = useT(), may = useMay(), [kind, setKind] = useState<'' | HistoryRow['kind']>('');
  const all = useMemo(() => historyOf(db), [db.productionOrders, db.audit, db.boms]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = all.filter((x) => !kind || x.kind === kind);
  return (
    <Card flush title="Production history" sub="Who did what and when, over all orders and BOMs. Search by order number, document, product or person.">
      <DataTable rows={rows} rowKey={(x) => x.id} pageSize={16} resetKey={kind} search={(x) => searchOf(db, x)}
        toolbar={<Select sm style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label={T('Kind of event')}><option value="">All events</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
        empty={<Empty icon={<History size={22} />} title="No history yet" hint="Everything done with BOMs and production orders will be listed here." />}
        cols={[
          { key: 't', header: 'Date', render: (x) => <>{dateTimeFmt(x.ts)}<div className="sub">{userName(db, x.userId)}</div></> },
          { key: 'e', header: 'What happened', render: (x) => <><b>{T(x.label)}</b>{x.what && STATUS[x.what] && <> <OrderBadge s={x.what} /></>}{(x.cost || x.note) && <div className="sub">{x.cost ? T(COST_KIND[x.cost]) : ''}{x.cost && x.note ? ' · ' : ''}{x.note}</div>}</> },
          { key: 'n', header: 'Production order no.', render: (x) => (x.orderId ? <><OrderLink id={x.orderId} no={x.orderNo ?? orderOf(db, x.orderId)?.no ?? ''} go={go} /><div className="sub"><span className="mono">{x.no}</span>{x.no ? ' · ' : ''}BOM v{x.bomVersion}</div></> : x.bomId ? <button type="button" className="linkish" onClick={() => go({ tab: 'boms', bom: x.bomId! })}>BOM</button> : '–') },
          { key: 'p', header: 'Product', hideSm: true, render: (x) => (x.productId ? <Item db={db} id={x.productId} T={T} /> : '–') },
          { key: 'q', header: 'Quantity', num: true, render: (x) => (x.qty == null ? '' : <span className={x.qty < 0 ? 'bad' : 'good'}>{x.qty > 0 ? '+' : '−'}{qtyFmt(Math.abs(x.qty))} {x.productId ? unitOf(db, x.productId) : ''}</span>) },
          { key: 'w', header: 'Warehouse', hideSm: true, render: (x) => (x.warehouseId ? whName(db, x.warehouseId) : '') },
          ...(may.cost ? [{ key: 'u', header: 'Unit cost', num: true, hideSm: true, render: (x: HistoryRow) => (x.unitCost == null ? '' : <Cost v={x.unitCost > 0 ? x.unitCost : null} />) }, { key: 'v', header: 'Value', num: true, render: (x: HistoryRow) => (x.value == null ? '' : x.value === 0 ? <Cost v={null} /> : money(x.value)) }] : []),
          { key: 'j', header: 'Journal no.', hideSm: true, render: (x) => <span className="mono">{journalOf(db, x.journalId)?.no ?? ''}</span> },
        ]} />
    </Card>
  );
}
