import { useId, useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useDB } from '../domain/store';
import { bomCost } from '../domain/bom';
import { saleTax } from '../domain/accounting';
import { Button, Card, Check, Field, Input, Select, Textarea, Badge } from '../ui/kit';
import { money, pct, qtyFmt, r2, r3 } from '../lib/util';
import type { BomComponent, BomVersion, ID, Product } from '../domain/types';
import { engineText, versionOf, type BomForm, type BomProblems } from './forms';
import { Cost, Facts, Missing, Num, Problems, Qty, nameOf, prodOf, useMay, useT } from './parts';
import { ProductPicker } from './ProductPicker';

export const ROLES: Record<BomComponent['role'], string> = { material: 'Material used', packaging: 'Packing material', consumable: 'Consumable' };
const GIVE: Record<'labor' | 'overhead', string> = { labor: 'Labour cost per batch (฿)', overhead: 'Overhead cost per batch (฿)' };

/** The fields of one BOM version. Every message stands next to the field it is about; the cost follows while typing. */
export function BomFormView({ productId, f, onChange, problems, tried }: { productId: ID; f: BomForm; onChange: (f: BomForm) => void; problems: BomProblems; tried: boolean }) {
  const db = useDB(), T = useT(), { cost } = useMay();
  const out = prodOf(db, productId), v = useMemo(() => versionOf(f), [f]);
  const set = (p: Partial<BomForm>) => onChange({ ...f, ...p });
  const setC = (i: number, p: Partial<BomComponent>) => set({ components: f.components.map((c, k) => (k === i ? { ...c, ...p } : c)) });
  const lines = bomCost(db, v).lines;
  const used = new Set(f.components.map((c) => c.productId));
  const blocked = (p: Product) => (p.id === productId ? 'This is the product being made' : p.kind === 'menu' ? 'A menu item holds no stock, so it cannot be a component' : used.has(p.id) ? 'Already in the list' : null);
  return (
    <div className="col gap-16">
      <Card title="1. Batch size" sub="How many units one round of production makes. All quantities below are for this many units.">
        <div className="form-grid"><Field label={out ? T('Output per batch ({unit})', { unit: out.unit }) : T('Output per batch')}><Num value={f.yieldQty} onChange={(n) => set({ yieldQty: n })} data-testid="bom-yield" /></Field></div>
        <Problems list={problems.batch} />
      </Card>
      <Card title="2. Components" sub="What goes into one batch. Any product can be a component, also an inactive one.">
        <div className="col gap-16">
          {f.components.map((c, i) => <Line key={c.productId + i} c={c} i={i} set={(p) => setC(i, p)} remove={() => set({ components: f.components.filter((_, k) => k !== i) })} problems={problems.rows[i] ?? []} cost={cost ? lines[i]?.cost : undefined} />)}
          {tried && <Problems list={problems.list} />}
          <div><div className="lbl-s mb8">{T('Add a component')}</div><ProductPicker label="Add a component" testid="pick-component" blocked={blocked} onPick={(p) => set({ components: [...f.components, { productId: p.id, qty: 1, role: p.kind === 'packaging' ? 'packaging' : 'material' }] })} /></div>
        </div>
      </Card>
      <Card title="3. Labour, overhead and other costs" sub="For one batch. Choose “not known yet” when nobody has worked it out: the cost then shows as unknown instead of 0.">
        <div className="form-grid">
          {(['labor', 'overhead'] as const).map((k) => {
            const known = k === 'labor' ? f.laborKnown : f.overheadKnown, val = k === 'labor' ? f.laborCost : f.overheadCost;
            return (
              <div key={k} className="col gap-6">
                <Field label={GIVE[k]} hint={known ? 'Enter 0 when there is none' : undefined}>{known && cost ? <Num value={val} onChange={(n) => set(k === 'labor' ? { laborCost: n } : { overheadCost: n })} /> : <Input value={T(known ? 'Amount set (hidden for your role)' : 'Not known yet')} disabled readOnly />}</Field>
                {cost && <Check checked={!known} onChange={(x) => set(k === 'labor' ? { laborKnown: !x } : { overheadKnown: !x })}>{k === 'labor' ? 'Labour is not known yet' : 'Overhead is not known yet'}</Check>}
              </div>
            );
          })}
        </div>
        <div className="col mt16">
          {!cost && f.otherCosts.map((x, i) => <div key={i} className="text2" data-testid="other-cost-hidden">{x.label || T(x.kind === 'utilities' ? 'Utilities cost' : 'Other cost')} · {T('Amount set (hidden for your role)')}</div>)}
          {cost && f.otherCosts.map((x, i) => {
            const put = (p: Partial<typeof x>) => set({ otherCosts: f.otherCosts.map((y, k) => (k === i ? { ...y, ...p } : y)) });
            return (
              <div key={i} className="mfg-other">
                <Field label="Kind of cost"><Select value={x.kind} onChange={(e) => put({ kind: e.target.value as typeof x.kind })}><option value="utilities">Utilities cost</option><option value="other">Other cost</option></Select></Field>
                <Field label="Description of the cost"><Input value={x.label} onChange={(e) => put({ label: e.target.value })} /></Field>
                <Field label="Amount per batch (฿)"><Num value={x.amount} onChange={(n) => put({ amount: n })} /></Field>
                <Button icon variant="ghost" aria-label={T('Remove this cost')} onClick={() => set({ otherCosts: f.otherCosts.filter((_, k) => k !== i) })}><Trash2 size={15} /></Button>
              </div>
            );
          })}
          {cost && <div><Button size="sm" onClick={() => set({ otherCosts: [...f.otherCosts, { kind: 'utilities', label: '', amount: NaN }] })}><Plus size={13} /> {T('Add another cost')}</Button></div>}
          {!cost && <div className="sub">{T('Your role does not show costs. Amounts that are set stay as they are when you save.')}</div>}
        </div>
        <Problems list={problems.costs} />
      </Card>
      <Card title="4. Notes"><Field label="Notes for this version"><Textarea value={engineText(T, f.notes)} onChange={(e) => set({ notes: e.target.value })} /></Field></Card>
    </div>
  );
}
function Line({ c, i, set, remove, problems, cost }: { c: BomComponent; i: number; set: (p: Partial<BomComponent>) => void; remove: () => void; problems: string[]; cost?: number | null }) {
  const db = useDB(), T = useT(), p = prodOf(db, c.productId), unit = p?.unit ?? '', name = p?.name ?? c.productId, hid = useId();
  const stockQty = c.entry ? c.entry.qty * c.entry.factor : c.qty;
  return (
    <div className="bom-line" role="group" aria-labelledby={hid} data-testid="bom-line">
      <div className="bom-name" id={hid}><b>{i + 1}. {name}</b><div className="sub"><span className="mono">{p?.sku}</span>{p && !p.active ? ` · ${T('Inactive')}` : ''}</div></div>
      {c.entry
        ? <Field label="Quantity in that unit"><Num value={c.entry.qty} onChange={(n) => set({ entry: { ...c.entry!, qty: n } })} /></Field>
        : <Field label={T('Quantity per batch ({unit})', { unit })}><Num value={c.qty} onChange={(n) => set({ qty: n })} /></Field>}
      <Field label="Used as"><Select value={c.role} onChange={(e) => set({ role: e.target.value as BomComponent['role'] })}>{Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
      <Field label="Waste allowance (%)"><Num value={c.wastePct ?? 0} max={99} onChange={(n) => set({ wastePct: n })} /></Field>
      <div className="bom-cost">{cost !== undefined && <><span className="lbl-s">{T('Cost per batch')}</span><Cost v={Number.isFinite(stockQty) ? cost : null} bold /></>}</div>
      <Button icon variant="ghost" aria-label={T('Take out {name}', { name })} onClick={remove}><Trash2 size={15} /></Button>
      <div className="bom-entry">
        {c.entry ? (
          <>
            <Field label="Name of the unit (for example box)"><Input value={c.entry.unit} onChange={(e) => set({ entry: { ...c.entry!, unit: e.target.value } })} /></Field>
            <Field label={T('One unit contains ({unit})', { unit })}><Num value={c.entry.factor} onChange={(n) => set({ entry: { ...c.entry!, factor: n } })} /></Field>
            <span className="text2">= <b>{Number.isFinite(stockQty) ? qtyFmt(r3(stockQty)) : '–'} {unit}</b></span>
            <Button size="sm" variant="ghost" onClick={() => set({ entry: undefined, qty: Number.isFinite(stockQty) ? r3(stockQty) : c.qty })}>{T('Use the stock unit')}</Button>
          </>
        ) : <Button size="sm" variant="ghost" onClick={() => set({ entry: { qty: c.qty, unit: '', factor: 1 } })}>{T('Enter in another unit')}</Button>}
      </div>
      {problems.length > 0 && <div className="bom-wide"><Problems list={problems} /></div>}
    </div>
  );
}

/** Cost of a version at today's costs. Without finance:cost nothing is shown. */
export function BomCostCard({ productId, v, warehouseId, sticky }: { productId: ID; v: BomVersion; warehouseId?: ID; sticky?: boolean }) {
  const db = useDB(), T = useT(), { cost } = useMay();
  if (!cost) return null;
  const c = bomCost(db, v, warehouseId), p = prodOf(db, productId), unit = p?.unit ?? '', rate = saleTax(db, new Date().toISOString()).rate, net = p && p.price > 0 ? r2(p.price / (1 + rate)) : null;
  const gp = net != null && c.perUnit != null ? r2(net - c.perUnit) : null, ok = Number.isFinite(v.yieldQty) && v.yieldQty > 0 && v.components.length > 0 && v.components.every((x) => Number.isFinite(x.qty));
  return (
    <Card title="Estimated cost" sub="At today’s average cost of each component, waste allowance included" className={sticky ? 'mfg-sticky' : undefined}>
      <div className="col" data-testid="bom-cost">
        <Facts items={[
          [T('Materials'), <Cost key="m" v={c.lines.some((l, i) => l.cost == null && v.components[i].role !== 'packaging') ? null : c.materials} />], [T('Packing materials'), <Cost key="p" v={c.lines.some((l, i) => l.cost == null && v.components[i].role === 'packaging') ? null : c.packaging} />],
          [T('Labour'), <Cost key="l" v={c.labor} />], [T('Overhead'), <Cost key="o" v={c.overhead} />], [T('Utilities and other costs'), <Cost key="x" v={Number.isFinite(c.other) ? c.other : null} />],
          [<b key="bt">{T('Cost of one batch')}</b>, <Cost key="b" v={ok ? c.batch : null} bold />], [<b key="ut">{T('Cost per {unit}', { unit })}</b>, <span key="u" className="mfg-big" data-testid="bom-unit-cost"><Cost v={ok ? c.perUnit : null} bold /></span>],
          [T('Price before VAT'), net == null ? T('No price') : money(net)], [T('Gross profit per unit'), gp == null ? <span key="g" className="muted">{T('No data')}</span> : <span key="g" className={gp < 0 ? 'bad' : ''}>{money(gp)} ({pct(gp / net!)})</span>],
        ]} />
        <Missing list={c.missing} />
      </div>
    </Card>
  );
}

/** A version to read: used for the preview before saving and for versions that can no longer be changed. */
export function BomView({ productId, v, title }: { productId: ID; v: BomVersion; title: string }) {
  const db = useDB(), T = useT(), { cost } = useMay(), c = bomCost(db, v), out = prodOf(db, productId);
  return (
    <Card title={title} flush>
      <div className="mfg-pad"><Facts items={[
        [T('Product made'), <b key="p">{nameOf(db, productId)}</b>], [T('Output per batch'), <Qty key="q" n={v.yieldQty} unit={out?.unit ?? ''} />],
        ...(cost ? [[T('Labour'), <Cost key="l" v={c.labor} />], [T('Overhead'), <Cost key="o" v={c.overhead} />]] as [string, React.ReactNode][] : []),
        ...(v.otherCosts ?? []).map((x): [string, React.ReactNode] => [x.label || T(x.kind === 'utilities' ? 'Utilities cost' : 'Other cost'), cost ? money(x.amount) : T('Amount set (hidden for your role)')]),
        ...(v.notes ? [[T('Notes'), engineText(T, v.notes)] as [string, React.ReactNode]] : []),
      ]} /></div>
      <div className="table-wrap" role="region" aria-label={T('Scrollable table')} tabIndex={0}>
        <table className="t compact"><thead><tr><th>{T('Component')}</th><th>{T('Used as')}</th><th className="num">{T('Per batch')}</th><th className="num">{T('Waste allowance (%)')}</th><th className="num">{T('With waste')}</th>{cost && <><th className="num">{T('Unit cost')}</th><th className="num">{T('Cost')}</th></>}</tr></thead>
          <tbody>{v.components.map((x, i) => (
            <tr key={x.productId + i}><td><b>{nameOf(db, x.productId)}</b><div className="sub mono">{prodOf(db, x.productId)?.sku}</div></td><td><Badge>{ROLES[x.role]}</Badge></td>
              <td className="num"><Qty n={r3(x.qty)} unit={c.lines[i].unit} />{x.entry && <div className="sub">{qtyFmt(x.entry.qty)} {x.entry.unit} × {qtyFmt(x.entry.factor)}</div>}</td><td className="num">{x.wastePct ? pct(x.wastePct / 100, 1) : '–'}</td><td className="num"><Qty n={c.lines[i].qty} unit={c.lines[i].unit} /></td>
              {cost && <><td className="num"><Cost v={c.lines[i].unitCost} /></td><td className="num"><Cost v={c.lines[i].cost} /></td></>}</tr>))}</tbody></table>
      </div>
    </Card>
  );
}
