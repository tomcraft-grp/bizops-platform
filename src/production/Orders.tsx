import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Factory, Plus } from 'lucide-react';
import { useDB } from '../domain/store';
import { bomRequirement, knownCost } from '../domain/bom';
import { onHand } from '../domain/inventory';
import { createOrder, orderTotals, shortages, updateDraftOrder } from '../domain/production';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Select, Textarea, useRun } from '../ui/kit';
import { cx, dateFmt, dateTimeFmt, dayKey, parseDay, qtyFmt, r2, r3 } from '../lib/util';
import type { ID, ProductionOrder } from '../domain/types';
import { STATUS, bestWarehouse, bomListState, isRunning, orderMatches, shownVersion, usableBoms, type OrderView } from './forms';
import { useUnsaved } from './unsaved';
import { Cost, Facts, Missing, Num, OrderBadge, Qty, nameOf, prodOf, unitOf, useKey, useMay, useT, whName, type Go } from './parts';
import { NewBomButton } from './BomList';

export function NewOrderButton({ go, bom }: { go: Go; bom?: ID }) { const T = useT(); return <Button variant="primary" onClick={() => go({ tab: 'orders', order: 'new', ...(bom ? { bom } : {}) })}><Plus size={15} /> {T('New production order')}</Button>; }
export function NoOrders({ go }: { go: Go }) {
  const db = useDB(), may = useMay(), has = usableBoms(db).length > 0;
  return <Empty icon={<Factory size={22} />} title="No production order yet" hint={has ? 'A production order says what to make, how many and from which warehouse.' : 'A production order is made from a BOM. Create and activate a BOM first.'} action={has ? (may.create ? <NewOrderButton go={go} /> : undefined) : may.edit ? <NewBomButton go={go} /> : undefined} />;
}

export function OrderTable({ go, view = 'all', tools }: { go: Go; view?: OrderView; tools?: boolean }) {
  const db = useDB(), T = useT(), may = useMay();
  const [status, setStatus] = useState<'' | ProductionOrder['status']>('');
  const rows = useMemo(() => db.productionOrders.filter((o) => orderMatches(db, o, view) && (!status || o.status === status)).reverse(), [db, view, status]);
  const open = (o: ProductionOrder) => go({ tab: 'orders', order: o.id });
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(o) => o.id} pageSize={14} onRow={open} search={(o) => `${o.no} ${nameOf(db, o.productId)} ${prodOf(db, o.productId)?.sku ?? ''} ${o.note ?? ''}`} resetKey={view + status}
        toolbar={tools ? <Select sm style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label={T('Production order status')}><option value="">All order statuses</option>{Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select> : undefined}
        empty={!db.productionOrders.length ? <NoOrders go={go} /> : <Empty title="No production order matches" hint="Clear the search or choose another card or status." />}
        cols={[
          { key: 'no', header: 'Production order no.', sort: (o) => o.no, render: (o) => <><button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); open(o); }}>{o.no}</button><div className="sub">{dateTimeFmt(o.createdAt)}</div></> },
          { key: 'p', header: 'Product', sort: (o) => nameOf(db, o.productId), render: (o) => <><b>{nameOf(db, o.productId)}</b><div className="sub"><span className="mono">{prodOf(db, o.productId)?.sku}</span> · BOM v{o.snapshot.version}</div></> },
          { key: 's', header: 'Status', sort: (o) => o.status, render: (o) => { const n = shortages(db, o).length; return <><OrderBadge s={o.status} />{n > 0 && <div className="sub bad">{T('{n} materials short', { n })}</div>}</>; } },
          { key: 'q', header: 'Planned quantity', num: true, sort: (o) => o.plannedQty, render: (o) => <Qty n={o.plannedQty} unit={unitOf(db, o.productId)} /> },
          { key: 'd', header: 'Made', num: true, render: (o) => { const x = orderTotals(o); return <>{qtyFmt(x.good)}{x.rejected > 0 && <div className="sub">{T('{n} rejected', { n: qtyFmt(x.rejected) })}</div>}</>; } },
          { key: 'due', header: 'Due', hideSm: true, sort: (o) => o.dueAt ?? '9', render: (o) => { const late = o.dueAt && dayKey(o.dueAt) < dayKey(new Date()) && (isRunning(o) || o.status === 'planned' || o.status === 'draft'); return o.dueAt ? <span className={late ? 'bad' : ''}>{dateFmt(o.dueAt)}{late ? ` · ${T('Past the due date')}` : ''}</span> : '–'; } },
          { key: 'w', header: 'Warehouse', hideSm: true, render: (o) => whName(db, o.warehouseId) },
          ...(may.cost ? [{ key: 'u', header: 'Actual unit cost', num: true, render: (o: ProductionOrder) => { const u = orderTotals(o).unitCost; return u == null ? '–' : <Cost v={u > 0 ? u : null} />; } }] : []),
        ]} />
    </Card>
  );
}

/** Creates an order, or changes a draft. What is needed is compared with the stock before anything is saved. */
export function OrderForm({ id, bom, go }: { id?: ID; bom?: ID; go: Go }) {
  const db = useDB(), T = useT(), run = useRun(), may = useMay(), key = useKey();
  const boms = usableBoms(db), old = id ? db.productionOrders.find((o) => o.id === id) : undefined;
  // a BOM named in the address that cannot be used is not replaced by another one without a word: the choice stays empty and says why
  const pickOf = (b?: ID) => (b === undefined ? boms[0]?.b.id ?? '' : boms.some((x) => x.b.id === b) ? b : '');
  const start = old?.bomId ?? pickOf(bom), first = boms.find((x) => x.b.id === start);
  const [init] = useState(() => ({ bomId: start, qty: old?.plannedQty ?? first?.v.yieldQty ?? 1, wh: old?.warehouseId ?? '', due: old?.dueAt ? dayKey(old.dueAt) : '', note: old?.note ?? '' }));
  const [f, setF] = useState(init);
  // a BOM chosen by the address is not typed input: the form follows it and nothing is asked when leaving
  const [base, setBase] = useState(() => JSON.stringify(init)), shown = useRef(bom);
  useEffect(() => {
    if (old || shown.current === bom) return;
    shown.current = bom;
    const n = { ...f, bomId: pickOf(bom), qty: boms.find((b) => b.b.id === bom)?.v.yieldQty ?? f.qty };
    setF(n); setBase(JSON.stringify(n));
  }, [bom]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = useUnsaved(JSON.stringify(f) !== base);
  const why = !old && bom && !boms.some((x) => x.b.id === bom) ? unusable(db, bom) : null;
  const cur = boms.find((x) => x.b.id === f.bomId), same = old && old.bomId === f.bomId, v = same ? old.snapshot : cur?.v, p = same ? prodOf(db, old.productId) : cur?.p;
  const wh = f.wh || (v ? bestWarehouse(db, v, f.qty || 0) : '');
  const back = () => go(old ? { tab: 'orders', order: old.id } : { tab: 'orders' });
  const Head = <><div className="mb8"><Button size="sm" variant="ghost" onClick={back}><ArrowLeft size={14} /> {T('Back to the orders')}</Button></div><h2 className="mb16">{old ? T('Change draft {no}', { no: old.no }) : T('New production order')}</h2></>;
  if (!db.warehouses.length) return <>{Head}<Card><Empty title="There is no warehouse" hint="Production takes materials from a warehouse and puts the goods into one. Please contact the person who looks after the system." /></Card></>;
  if (!boms.length && !old) return <>{Head}<Card><Empty icon={<Factory size={22} />} title={db.boms.length ? 'No BOM is ready for production' : 'No BOM yet'} hint={db.boms.length ? 'Activate a BOM first. Its product must be active as well.' : 'A production order is made from a BOM. Create and activate a BOM first.'} action={db.boms.length ? <Button variant="primary" onClick={() => go({ tab: 'boms' })}>{T('Open the BOM list')}</Button> : may.edit ? <NewBomButton go={go} /> : undefined} /></Card></>;
  const valid = Number.isFinite(f.qty) && r3(f.qty) > 0 && !!v, qty = valid ? f.qty : 0;
  const need = !v ? [] : bomRequirement(v, qty).map((n) => {
    const here = onHand(db, wh, n.productId), elsewhere = db.warehouses.filter((w) => w.id !== wh).reduce((s, w) => s + Math.max(0, onHand(db, w.id, n.productId)), 0), k = knownCost(db, n.productId, wh);
    return { ...n, here, elsewhere: r3(elsewhere), short: r3(Math.max(0, n.qty - Math.max(0, here))), cost: k.cost };
  });
  const short = need.filter((n) => n.short > 0.0005), b = v?.yieldQty || 1;
  const mats = !v || need.some((n) => n.cost == null) ? null : r2(need.reduce((s, n) => s + n.qty * n.cost!, 0)), labor = !v || v.laborKnown === false ? null : r2((v.laborCost / b) * qty);
  const over = !v || v.overheadKnown === false ? null : r2(((v.overheadCost + (v.otherCosts ?? []).reduce((s, x) => s + x.amount, 0)) / b) * qty), total = mats == null || labor == null || over == null ? null : r2(mats + labor + over);
  const input = { bomId: f.bomId, plannedQty: f.qty, warehouseId: wh, note: f.note.trim() || undefined, dueAt: f.due ? parseDay(f.due).toISOString() : undefined };
  const save = (draft: boolean) => run((d, c) => (old ? updateDraftOrder(d, c, old.id, input, key) : createOrder(d, c, { ...input, draft }, key)), { ok: old ? 'Draft order saved' : draft ? 'Order saved as a draft' : 'Production order created', onOk: (x) => { saved(); go({ tab: 'orders', order: x }); } });
  function unusable(d: typeof db, x: ID): string {
    const b = d.boms.find((y) => y.id === x), pr = b && prodOf(d, b.productId), st = b ? bomListState(b) : null, sv = b && shownVersion(b);
    if (!b) return T('The BOM in the link does not exist on this device. Please choose a BOM.');
    const name = pr?.name ?? b.name;
    if (st === 'scheduled' && sv) return T('The BOM of {name} starts on {date} and cannot be used before then. Please choose another BOM.', { name, date: dateFmt(sv.effectiveFrom) });
    if (st === 'draft') return T('The BOM of {name} is only a draft. Activate it first, or choose another BOM.', { name });
    if (st === 'inactive' || st === 'archived') return T('The BOM of {name} is not in use. Please choose another BOM.', { name });
    return T('{name} cannot be produced now: the product is inactive or a menu item. Please choose another BOM.', { name });
  }
  return (
    <div data-testid="order-form">
      {Head}
      <div className="mfg-split">
        <div className="col gap-16">
          <Card title="What to make">
            <div className="form-grid">
              <Field label="BOM to use"><Select value={f.bomId} onChange={(e) => setF({ ...f, bomId: e.target.value, qty: boms.find((x) => x.b.id === e.target.value)?.v.yieldQty ?? f.qty })} data-testid="order-bom">{!f.bomId && <option value="">Choose a BOM…</option>}{same && !cur && p && v && <option value={old.bomId}>{p.name} (BOM v{v.version})</option>}{boms.map((x) => <option key={x.b.id} value={x.b.id}>{x.p.name} (BOM v{x.v.version})</option>)}</Select></Field>
              <Field label={p ? T('Planned quantity ({unit})', { unit: p.unit }) : T('Planned quantity')} hint={v ? T('One batch makes {n}', { n: qtyFmt(v.yieldQty) }) : undefined}><Num value={f.qty} onChange={(n) => setF({ ...f, qty: n })} data-testid="order-qty" /></Field>
              <Field label="Warehouse of materials and goods"><Select value={wh} onChange={(e) => setF({ ...f, wh: e.target.value })}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
              <Field label="Due date (optional)"><Input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
              <Field full label="Note (optional)"><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
            </div>
            {why && <div className="mt8" data-testid="order-bom-why"><Banner tone="warn">{why}</Banner></div>}
            {!v && !why && <div className="mfg-err mt8" role="alert">{T('Choose the BOM to produce with')}</div>}
            {v && !valid && <div className="mfg-err mt8" role="alert">{T('Enter a planned quantity greater than 0')}</div>}
          </Card>
          <Card flush title="Materials needed" sub="Compared with the stock of the chosen warehouse. The order can be created even when something is short.">
            {short.length > 0 && <div className="mfg-pad" data-testid="order-short"><Banner tone="warn">{T('{n} of {m} materials are short. Production cannot be recorded until stock is received or transferred.', { n: short.length, m: need.length })}</Banner></div>}
            <div className="table-wrap" role="region" aria-label={T('Scrollable table')} tabIndex={0}>
              <table className="t compact" data-testid="order-need"><thead><tr><th>{T('Component')}</th><th className="num">{T('Needed')}</th><th className="num">{T('On hand')}</th><th className="num">{T('Other warehouses')}</th><th>{T('Result')}</th></tr></thead>
                <tbody>{need.map((n) => <tr key={n.productId} className={cx(n.short > 0.0005 && 'mfg-short')}><td><b>{nameOf(db, n.productId)}</b><div className="sub mono">{prodOf(db, n.productId)?.sku}</div></td><td className="num"><Qty n={n.qty} unit={unitOf(db, n.productId)} /></td><td className="num">{qtyFmt(n.here)}</td><td className="num">{n.elsewhere ? qtyFmt(n.elsewhere) : '–'}</td><td>{n.short > 0.0005 ? <Badge tone="bad">{T('Short {n}', { n: qtyFmt(n.short) })}</Badge> : <Badge tone="good">Enough</Badge>}</td></tr>)}</tbody></table>
            </div>
          </Card>
        </div>
        {may.cost && (
          <div className="col gap-16"><Card className="mfg-sticky" title="Estimated cost of the order" sub="An estimate at today’s costs. The actual cost is known after production."><div className="col">
            <Facts items={[[T('Materials'), <Cost key="m" v={mats} />], [T('Labour'), <Cost key="l" v={labor} />], [T('Overhead and other costs'), <Cost key="o" v={over} />], [<b key="t">{T('Estimated total')}</b>, <Cost key="tt" v={total} bold />], [T('Cost per {unit}', { unit: p?.unit ?? '' }), <span key="u" className="mfg-big"><Cost v={total == null || !qty ? null : r2(total / qty)} bold /></span>]]} />
            <Missing list={[...need.filter((n) => n.cost == null).map((n) => nameOf(db, n.productId)), ...(labor == null ? ['Labour cost'] : []), ...(over == null ? ['Overhead cost'] : [])]} />
          </div></Card></div>
        )}
      </div>
      <div className="mfg-bar"><div className="grow" /><Button onClick={back}>{T('Cancel')}</Button>{old ? <Button variant="primary" disabled={!valid} onClick={() => save(true)}>{T('Save draft')}</Button> : <><Button disabled={!valid} onClick={() => save(true)}>{T('Save as draft')}</Button><Button variant="primary" disabled={!valid} onClick={() => save(false)}>{T('Create order')}</Button></>}</div>
    </div>
  );
}
