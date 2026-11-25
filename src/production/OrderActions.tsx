import { useCallback, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useDB } from '../domain/store';
import { onHand } from '../domain/inventory';
import { addConversion, issueMaterials, pool, receiveGoods, recordLoss, returnMaterials, runDefaults, runProduction, unitsLeft, type ConversionInput } from '../domain/production';
import type { Missing } from '../domain/production';
import { Banner, Button, Card, Check, Field, Input, Select, Textarea } from '../ui/kit';
import { cx, money, qtyFmt, r3 } from '../lib/util';
import type { ConversionEntry, DB, ID, Product, ProductionOrder } from '../domain/types';
import { missesAnything, receiptFacts, stillMissing } from './forms';
import { Num, nameOf, prodOf, unitOf, useKey, useMay, usePost, useT } from './parts';
import { ProductPicker } from './ProductPicker';
import { useUnsaved } from './unsaved';

export type Doing = 'run' | 'issue' | 'cost' | 'receive' | 'loss' | 'return';
export const COST_KIND: Record<ConversionEntry['kind'], string> = { labor: 'Labour', overhead: 'Overhead', utilities: 'Utilities cost', other: 'Other cost' };
export const DOING: Record<Doing, { title: string; sub: string }> = {
  run: { title: 'Record production', sub: 'Materials out, costs, and finished goods in, as one step: either all of it is posted or nothing is.' },
  issue: { title: 'Issue materials', sub: 'Takes materials out of stock. Their cost waits in work in progress until the goods are received.' },
  cost: { title: 'Add a cost', sub: 'Labour, overhead, utilities or another cost of this order.' },
  receive: { title: 'Receive finished goods', sub: 'Puts the goods into stock at the cost of this order.' },
  loss: { title: 'Record an abnormal loss', sub: 'For something unusual, such as a spill or an accident. The cost becomes an expense at once, so the good units do not become dearer.' },
  return: { title: 'Return unused material', sub: 'Material that was issued and not used goes back into stock at the average cost it has in this order.' },
};
const KINDS = Object.keys(COST_KIND) as ConversionEntry['kind'][];
type Edits = Record<ID, { qty?: number; wh?: ID }>;
const fin = (n: number) => (Number.isFinite(n) ? n : 0);

/** The materials of an issue: what the BOM asks for (beyond what is in the order already) is filled in, every quantity and warehouse can be changed, and other materials can be added. */
function useLines(db: DB, po: ProductionOrder, units: number) {
  const [edits, setEdits] = useState<Edits>({}), [extra, setExtra] = useState<ID[]>([]);
  const base = runDefaults(db, po, units).lines;
  const rows = [...base, ...extra.filter((id) => !base.some((b) => b.productId === id)).map((productId) => ({ productId, qty: NaN }))]
    .map((b) => ({ productId: b.productId, bom: b.qty, qty: edits[b.productId]?.qty ?? b.qty, warehouseId: edits[b.productId]?.wh ?? po.warehouseId, extra: extra.includes(b.productId) }));
  const edit = (id: ID, p: Edits[ID]) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...p } }));
  // an empty field is not "none": it is sent as it is and the engine refuses it, so nothing is left out by accident
  return {
    rows, edit, changed: !!extra.length || Object.keys(edits).length > 0,
    add: (id: ID) => setExtra((x) => [...x, id]), remove: (id: ID) => { setExtra((x) => x.filter((y) => y !== id)); setEdits(({ [id]: _, ...e }) => e); },
    lines: rows.filter((r) => r.qty !== 0).map((r) => ({ productId: r.productId, qty: r.qty, warehouseId: r.warehouseId })),
  };
}
function LinesEditor({ po, l }: { po: ProductionOrder; l: ReturnType<typeof useLines> }) {
  const db = useDB(), T = useT();
  const has = l.rows.map((r) => r.productId).join();
  const blocked = useCallback((p: Product) => (p.id === po.productId ? 'This is the product being made' : p.kind === 'menu' ? 'A menu item holds no stock, so it cannot be a component' : has.split(',').includes(p.id) ? 'Already in the list' : null), [po.productId, has]);
  return (
    <div className="col">
      {!l.rows.length && <div className="muted">{T('Nothing is left to issue.')}</div>}
      {l.rows.map((r) => {
        const have = onHand(db, r.warehouseId, r.productId), short = Number.isFinite(r.qty) && r.qty > have + 1e-6, name = nameOf(db, r.productId), unit = unitOf(db, r.productId);
        return (
          <div key={r.productId} className={cx('iss-line', short && 'short')} role="group" aria-label={name} data-testid="issue-line">
            <div className="iss-name"><b>{name}</b><div className="sub">{r.extra ? T('Not in the BOM') : T('BOM asks for {n} more', { n: `${qtyFmt(r.bom)} ${unit}` })} · <span className={short ? 'bad' : ''}>{T('On hand')} {qtyFmt(have)}</span>{short && <b className="bad"> · {T('Short {n}', { n: qtyFmt(r3(r.qty - have)) })}</b>}</div></div>
            <Field label={T('Issue now ({unit})', { unit })}><Num value={r.qty} onChange={(n) => l.edit(r.productId, { qty: n })} /></Field>
            <Field label="From warehouse"><Select value={r.warehouseId} onChange={(e) => l.edit(r.productId, { wh: e.target.value })}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
            {r.extra ? <Button icon variant="ghost" aria-label={T('Take out {name}', { name })} onClick={() => l.remove(r.productId)}><Trash2 size={15} /></Button> : <span />}
          </div>
        );
      })}
      <div><div className="lbl-s mb8">{T('Add a material that is not in the BOM (a substitute, or extra use)')}</div><ProductPicker label="Add a material" testid="pick-extra" blocked={blocked} onPick={(p) => l.add(p.id)} /></div>
    </div>
  );
}
interface Out { good: number; rejected: number; wh: ID; final: boolean | null; note: string }
/** Unless the person says otherwise, the receipt that reaches the planned quantity is the last one. */
const isFinal = (po: ProductionOrder, o: Out) => o.final ?? (Number.isFinite(o.good) && o.good + 1e-9 >= unitsLeft(po));
function OutputEditor({ po, o, set }: { po: ProductionOrder; o: Out; set: (p: Partial<Out>) => void }) {
  const db = useDB(), T = useT(), unit = unitOf(db, po.productId), left = unitsLeft(po), final = isFinal(po, o);
  return (
    <div className="col">
      <div className="form-grid">
        <Field label={T('Good units ({unit})', { unit })} hint={T('{n} still to make', { n: qtyFmt(left) })}><Num value={o.good} onChange={(n) => set({ good: n })} data-testid="out-good" /></Field>
        <Field label={T('Rejected units ({unit})', { unit })} hint="They do not enter stock. Their share of the cost becomes waste, and they have to be made again."><Num value={o.rejected} onChange={(n) => set({ rejected: n })} data-testid="out-rejected" /></Field>
        <Field label="Goods into warehouse"><Select value={o.wh} onChange={(e) => set({ wh: e.target.value })}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="Note (optional)"><Input value={o.note} onChange={(e) => set({ note: e.target.value })} /></Field>
      </div>
      <Check checked={final} onChange={(x) => set({ final: x })}>This is the last receipt: the order is finished and the goods take all the cost that is left</Check>
      {final && Number.isFinite(o.good) && o.good < left && <Banner tone="warn">{T('Fewer good units than planned. The goods will carry all the cost of the order.')}</Banner>}
    </div>
  );
}
/** What the BOM still expects and the order does not hold, with the choice to go back or to continue. Amounts only for people who may see costs. */
function MissingChoice({ m, units, onBack, onGo, back }: { m: Missing; units: number; onBack: () => void; onGo: () => void; back: string }) {
  const T = useT(), { cost } = useMay();
  return (
    <div className="mfg-gate" role="alert" data-testid="missing-choice">
      <Banner tone="warn"><>
        <b>{T('The BOM still expects more for these {n} units than this order holds:', { n: qtyFmt(units) })}</b>
        <ul>
          {m.materials.map((x) => <li key={x.productId}>{T('{name}: {missing} {unit} missing (the BOM needs {need}, the order holds {have})', { name: x.name, missing: qtyFmt(x.missing), unit: x.unit, need: qtyFmt(x.need), have: qtyFmt(x.have) })}</li>)}
          {cost && m.conversions.map((x) => <li key={x.element}>{T('{what}: {missing} missing (the BOM expects {need})', { what: T(x.element === 'labor' ? 'Labour' : 'Overhead'), missing: money(x.missing), need: money(x.need) })}</li>)}
          {m.unknown.map((e) => <li key={e}>{T('{what}: the BOM does not know this cost, so the goods will carry none of it', { what: T(e === 'labor' ? 'Labour' : 'Overhead') })}</li>)}
        </ul>
        {T('If you continue, the goods are received without it and their cost is too low.')}
      </></Banner>
      <div className="row wrap mt8" style={{ justifyContent: 'flex-end' }}><Button onClick={onBack}>{T(back)}</Button><Button variant="danger" onClick={onGo}>{T('Continue without it')}</Button></div>
    </div>
  );
}

export function ActionPanel({ po, doing, onClose, onSwitch }: { po: ProductionOrder; doing: Doing; onClose: () => void; onSwitch: (d: Doing) => void }) {
  const T = useT(), db = useDB(), post = usePost(), may = useMay(), key = useKey();
  const left = unitsLeft(po), product = prodOf(db, po.productId), unit = product?.unit ?? '';
  const [o, setO] = useState<Out>({ good: left, rejected: 0, wh: po.warehouseId, final: null, note: '' });
  const units = doing === 'run' || doing === 'receive' ? r3(fin(o.good) + fin(o.rejected)) : left;
  const l = useLines(db, po, units);
  const [costs, setCosts] = useState<Partial<Record<ConversionEntry['kind'], number>>>({});
  const [one, setOne] = useState<{ kind: ConversionEntry['kind']; amount: number; note: string }>({ kind: 'labor', amount: NaN, note: '' });
  const [loss, setLoss] = useState({ amount: NaN, note: '' });
  const [back, setBack] = useState<{ qty: Record<ID, number>; wh: Record<ID, ID>; reason: string }>({ qty: {}, wh: {}, reason: '' });
  const [gate, setGate] = useState('');
  const suggested = runDefaults(db, po, units).conversions, costOf = (k: ConversionEntry['kind']) => costs[k] ?? suggested.find((s) => s.kind === k)?.amount ?? NaN;
  // an empty or zero cost is simply not recorded; anything else (also a negative number) goes to the engine, which has the last word
  const conversions: ConversionInput[] = KINDS.map((kind) => ({ kind, amount: costOf(kind) })).filter((c) => Number.isFinite(c.amount) && c.amount !== 0);
  const out = { good: o.good, rejected: o.rejected, warehouseId: o.wh, final: isFinal(po, o), note: o.note.trim() || undefined };
  // somebody who may not see costs does not type them either: a receipt then brings what the BOM expects of labour and overhead, as "Record production" does
  const plain = doing === 'receive' && !may.cost;
  const own = doing === 'run' ? { lines: l.lines, conversions } : plain ? { lines: [], conversions: suggested } : undefined;
  const missing = useMemo(() => ((doing === 'receive' || (doing === 'run' && out.final)) && units > 0 ? stillMissing(db, po, units, own) : null), [db, po, units, doing, out.final, JSON.stringify(own)]); // eslint-disable-line react-hooks/exhaustive-deps
  const sig = JSON.stringify([o, l.lines, conversions, doing]);
  const dirty = l.changed || JSON.stringify(o) !== JSON.stringify({ good: left, rejected: 0, wh: po.warehouseId, final: null, note: '' }) || Object.keys(costs).length > 0 || !Number.isNaN(one.amount) || !!one.note || !Number.isNaN(loss.amount) || !!loss.note || Object.keys(back.qty).length > 0 || !!back.reason;
  const saved = useUnsaved(dirty);
  const done = { onOk: () => { saved(); onClose(); } };
  const over = (doing === 'run' || doing === 'receive') && units > left + 1e-9 ? T('You are receiving {n} units, but only {m} are left to make on this order (planned {p}). Please check that the quantity is right, for example 10,000 typed instead of 100.', { n: qtyFmt(units), m: qtyFmt(left), p: qtyFmt(po.plannedQty) }) : undefined;
  const facts = (next: DB): string[] => {
    const r = receiptFacts(next, po.id);
    if (!r || !may.cost) return [];
    return [
      ...(r.good > 0 ? [T('The finished goods take {v} of cost: {u} per {unit}.', { v: money(r.goodValue), u: money(r.unitCost), unit })] : []),
      ...(r.rejected > 0 ? [T('The {n} rejected units take {v}, which becomes a waste expense.', { n: qtyFmt(r.rejected), v: money(r.rejectedValue) })] : []),
      ...(r.variance > 0 ? [T('{v} of the cost in this order is more than these units need. It is posted as a production variance, not into the goods.', { v: money(r.variance) })] : []),
    ];
  };
  const receiptWords = (final: boolean) => ['The good units enter stock and their cost leaves work in progress.', final ? 'The order is completed.' : 'The order stays open for the rest.'];
  const submit = (force = false) => {
    if (!force && missing && missesAnything(missing)) { setGate(sig); return; }
    switch (doing) {
      case 'run': return post({ title: 'Record this production?', words: ['Materials leave stock, their cost and the other costs are collected in work in progress, and the finished goods enter stock at that cost.', receiptWords(out.final)[1]], warn: over, facts, ok: 'Production recorded', ...done, exec: (d, c, x) => runProduction(d, c, po.id, { lines: l.lines, conversions, ...out, confirmUnknownCost: x.allowUnknown }, key) });
      case 'issue': return post({ title: 'Issue these materials?', words: ['Materials leave stock. Their cost moves from inventory to work in progress of this order.'], ok: 'Materials issued', ...done, exec: (d, c, x) => issueMaterials(d, c, po.id, { lines: l.lines, confirmUnknownCost: x.allowUnknown }, key) });
      case 'cost': return post({ title: 'Add this cost?', words: ['The amount is added to work in progress of this order. Stock does not change.'], ok: 'Cost added', ...done, exec: (d, c) => addConversion(d, c, po.id, { kind: one.kind, amount: one.amount, note: one.note.trim() || undefined }, key) });
      case 'receive': return post({
        title: 'Receive these goods?', words: [...receiptWords(out.final), ...(plain && suggested.length ? ['Labour and other costs from the BOM are added automatically.'] : [])], warn: over, facts, ok: 'Finished goods received', ...done,
        exec: (d, c, x) => (plain ? runProduction(d, c, po.id, { lines: [], conversions: runDefaults(d, d.productionOrders.find((p) => p.id === po.id)!, units).conversions, ...out, confirmUnknownCost: x.allowUnknown }, key) : receiveGoods(d, c, po.id, { ...out, confirmUnknownCost: x.allowUnknown }, key)),
      });
      case 'return': return post({ title: 'Return this material?', words: ['The material goes back into stock at the average cost it has in this order. That cost leaves work in progress: inventory is debited, work in progress credited.'], ok: 'Material returned', ...done,
        exec: (d, c) => returnMaterials(d, c, po.id, { lines: Object.entries(back.qty).filter(([, q]) => q !== 0).map(([productId, qty]) => ({ productId, qty, warehouseId: back.wh[productId] ?? po.warehouseId })), reason: back.reason }, key) });
      default: return post({ title: 'Record this loss?', words: ['The amount leaves work in progress and becomes a waste expense. Stock does not change.'], ok: 'Loss recorded', danger: true, ...done, exec: (d, c) => recordLoss(d, c, po.id, loss, key) });
    }
  };
  const inOrder = pool(po).materials;
  return (
    <Card className="mb16" title={DOING[doing].title} sub={DOING[doing].sub}>
      <div className="col gap-16" data-testid={`do-${doing}`}>
        {(doing === 'run' || doing === 'receive') && <section><h3 className="mb8">{T('Finished goods')}: {product?.name}</h3><OutputEditor po={po} o={o} set={(p) => setO({ ...o, ...p })} /></section>}
        {(doing === 'run' || doing === 'issue') && <section><h3 className="mb8">{T('Materials to issue')}</h3><LinesEditor po={po} l={l} /></section>}
        {doing === 'run' && (may.cost ? (
          <section><h3 className="mb8">{T('Costs of this production (฿)')}</h3>
            <div className="mfg-4">{KINDS.map((k) => <Field key={k} label={COST_KIND[k]}><Num value={costOf(k)} onChange={(n) => setCosts({ ...costs, [k]: n })} /></Field>)}</div>
            <div className="sub mt8">{T('Filled in: what the BOM expects for these units, less what is already recorded on the order.')}</div>
            {(po.snapshot.laborKnown === false || po.snapshot.overheadKnown === false) && <div className="sub mt8">{T('The BOM does not know the labour or overhead cost yet. Enter it here if you know it, or leave it empty.')}</div>}
          </section>
        ) : conversions.length > 0 && <div className="muted">{T('Labour and other costs from the BOM are added automatically.')}</div>)}
        {doing === 'cost' && (
          <div className="form-grid">
            <Field label="Kind of cost"><Select value={one.kind} onChange={(e) => setOne({ ...one, kind: e.target.value as typeof one.kind })}>{Object.entries(COST_KIND).map(([k, s]) => <option key={k} value={k}>{s}</option>)}</Select></Field>
            <Field label="Amount (฿)"><Num value={one.amount} onChange={(n) => setOne({ ...one, amount: n })} /></Field>
            <Field full label="Note (optional)"><Input value={one.note} onChange={(e) => setOne({ ...one, note: e.target.value })} /></Field>
          </div>
        )}
        {doing === 'loss' && (
          <div className="form-grid">
            <Field label="Cost that was lost (฿)"><Num value={loss.amount} onChange={(n) => setLoss({ ...loss, amount: n })} /></Field>
            <Field full label="What happened (required)"><Textarea value={loss.note} onChange={(e) => setLoss({ ...loss, note: e.target.value })} /></Field>
          </div>
        )}
        {doing === 'return' && (
          <div className="col">
            {!inOrder.length && <div className="muted">{T('Nothing is left in this order to return.')}</div>}
            {inOrder.map((x) => {
              const name = nameOf(db, x.productId), u = unitOf(db, x.productId);
              return (
                <div key={x.productId} className="iss-line" role="group" aria-label={name} data-testid="return-line">
                  <div className="iss-name"><b>{name}</b><div className="sub">{T('In the order: {n}', { n: `${qtyFmt(x.qty)} ${u}` })}{may.cost ? ` · ${money(x.value)}` : ''}</div></div>
                  <Field label={T('Return now ({unit})', { unit: u })}><Num value={back.qty[x.productId] ?? 0} max={x.qty} onChange={(n) => setBack({ ...back, qty: { ...back.qty, [x.productId]: n } })} /></Field>
                  <Field label="Into warehouse"><Select value={back.wh[x.productId] ?? po.warehouseId} onChange={(e) => setBack({ ...back, wh: { ...back.wh, [x.productId]: e.target.value } })}>{db.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
                  <span />
                </div>
              );
            })}
            {inOrder.length > 0 && <Field label="Why it is returned (required)"><Textarea value={back.reason} onChange={(e) => setBack({ ...back, reason: e.target.value })} /></Field>}
          </div>
        )}
        {gate === sig && missing && missesAnything(missing) && <MissingChoice m={missing} units={units} back={doing === 'receive' ? 'Go back and record it' : 'Go back and add it'}
          onBack={() => { setGate(''); if (doing === 'receive' && may.create) onSwitch('run'); }} onGo={() => { setGate(''); void submit(true); }} />}
        <div className="row wrap" style={{ justifyContent: 'flex-end' }}><Button onClick={onClose}>{T('Cancel')}</Button><Button variant="primary" onClick={() => void submit()} data-testid="review-post">{T('Review and post')}</Button></div>
      </div>
    </Card>
  );
}
