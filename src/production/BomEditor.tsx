import { useMemo, useState } from 'react';
import { Archive, ArrowLeft, Copy, Factory, Plus, Power } from 'lucide-react';
import { useDB } from '../domain/store';
import { activateVersion, bomState as versionStates, bomForProduct, createBom, discardDraft, duplicateBom, newDraftVersion, setBomStatus, updateDraft, bomCost } from '../domain/bom';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Select, useConfirm, useRun } from '../ui/kit';
import { dateFmt, dayKey, parseDay, qtyFmt } from '../lib/util';
import type { Bom, BomVersion, ID, Product } from '../domain/types';
import { EMPTY_BOM, bomListState, bomProblems, engineText, formOf, problemCount, shownVersion, usableBoms, versionOf, type BomForm } from './forms';
import { Cost, useMay, useT, nameOf, prodOf, type Go } from './parts';
import { BomCostCard, BomFormView, BomView } from './BomForm';
import { ProductPicker } from './ProductPicker';
import { BOM_BADGE, TYPE_LABEL } from './BomList';
import { useUnsaved } from './unsaved';

const Back = ({ go }: { go: Go }) => { const T = useT(); return <div className="mb8"><Button size="sm" variant="ghost" onClick={() => go({ tab: 'boms' })}><ArrowLeft size={14} /> {T('Back to the BOM list')}</Button></div>; };
/** A draft may be put into use only with production:approve, so a person who may only edit sees “Save as draft” alone. */
function SaveBar({ preview, onPreview, onBack, onSave, onActivate, extra }: { preview: boolean; onPreview: () => void; onBack: () => void; onSave: () => void; onActivate?: (iso: string) => void; extra?: React.ReactNode }) {
  const T = useT(), today = dayKey(new Date()), [eff, setEff] = useState(today);
  return (
    <div className="mfg-bar" data-testid="bom-bar">
      {extra}
      <div className="grow" />
      {!preview ? <Button variant="primary" onClick={onPreview}>{T('Preview before saving')}</Button> : (
        <>
          <Button onClick={onBack}>{T('Back to editing')}</Button>
          <Button onClick={onSave}>{T('Save as draft')}</Button>
          {onActivate && <><Field label="In use from"><Input type="date" value={eff} onChange={(e) => setEff(e.target.value || today)} /></Field><Button variant="primary" onClick={() => onActivate(parseDay(eff).toISOString())}>{T('Save and activate')}</Button></>}
        </>
      )}
    </div>
  );
}
const noBom = (db: ReturnType<typeof useDB>) => (p: Product) => (bomForProduct(db, p.id) ? 'This product already has a BOM' : !p.active ? 'Inactive: activate it on the Products page first' : null);

export function NewBom({ go }: { go: Go }) {
  const db = useDB(), T = useT(), run = useRun(), may = useMay();
  const [pid, setPid] = useState<ID>(''), [name, setName] = useState(''), [type, setType] = useState<Bom['type']>('manufacturing');
  const [f, setF] = useState<BomForm>(EMPTY_BOM), [preview, setPreview] = useState(false), [tried, setTried] = useState(false);
  const saved = useUnsaved(!!pid || JSON.stringify(f) !== JSON.stringify(EMPTY_BOM));
  const p = prodOf(db, pid), v = useMemo(() => versionOf(f), [f]), problems = useMemo(() => bomProblems(db, pid, v), [db.products, db.boms, pid, v]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (activateAt?: string) => run((d, c) => {
    const id = createBom(d, c, { productId: pid, name: name.trim() || nameOf(d, pid), type, yieldQty: v.yieldQty, components: v.components, laborCost: v.laborCost, overheadCost: v.overheadCost, laborKnown: v.laborKnown, overheadKnown: v.overheadKnown, otherCosts: v.otherCosts, notes: v.notes, asDraft: true });
    if (activateAt) activateVersion(d, c, id, 1, activateAt);
    return id;
  }, { ok: activateAt ? 'BOM saved and in use' : 'BOM saved as a draft', onOk: (id) => { saved(); go({ tab: 'boms', bom: id }); } });
  const ready = !!p && problemCount(problems) === 0;
  return (
    <div data-testid="bom-new">
      <Back go={go} />
      <h2 className="mb16">{T('New BOM')}</h2>
      <div className="mfg-split">
        <div className="col gap-16">
          {preview && ready ? <BomView productId={pid} v={v} title="Check before saving" /> : (
            <>
              <Card title="Product to make" sub="Any active product can be made, also one you normally buy and resell.">
                <div className="col">
                  {p && <div className="row between wrap" data-testid="bom-product"><div><b>{p.name}</b><div className="sub mono">{p.sku}</div></div><Badge tone="info">{T('Chosen product')}</Badge></div>}
                  <ProductPicker label="Product to make" testid="pick-output" value={pid || undefined} blocked={noBom(db)} onPick={(x) => { setPid(x.id); setName(x.name); setType(x.kind === 'menu' ? 'recipe' : 'manufacturing'); }} />
                  {tried && !p && <div className="mfg-err" role="alert">{T('Choose the product to make first')}</div>}
                  {p && <div className="form-grid"><Field label="BOM name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
                    <Field label="Kind of production"><Select value={type} disabled={p.kind === 'menu'} onChange={(e) => setType(e.target.value as Bom['type'])}>{Object.entries(TYPE_LABEL).filter(([k]) => (k === 'recipe') === (p.kind === 'menu')).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field></div>}
                </div>
              </Card>
              <BomFormView productId={pid} f={f} onChange={setF} problems={problems} tried={tried} />
            </>
          )}
        </div>
        <div className="col gap-16"><BomCostCard productId={pid} v={v} sticky /></div>
      </div>
      {tried && !ready && <div className="mt16"><Banner tone="warn">{T('Please correct the messages above before saving.')}</Banner></div>}
      <SaveBar preview={preview && ready} onPreview={() => { setTried(true); if (ready) { setPreview(true); window.scrollTo({ top: 0 }); } }} onBack={() => setPreview(false)} onSave={() => save()} onActivate={may.approve ? (iso) => save(iso) : undefined} />
    </div>
  );
}

export function BomPage({ id, go }: { id: ID; go: Go }) {
  const db = useDB(), T = useT(), run = useRun(), confirm = useConfirm(), may = useMay();
  const b = db.boms.find((x) => x.id === id);
  const [vn, setVn] = useState<number | null>(null), [copying, setCopying] = useState(false);
  if (!b) return <><Back go={go} /><Empty title="This BOM does not exist any more" hint="It may have been a draft that was discarded." /></>;
  const sorted = [...b.versions].sort((x, y) => y.version - x.version), v = sorted.find((x) => x.version === vn) ?? sorted.find((x) => x.status === 'draft') ?? shownVersion(b) ?? sorted[0];
  const state = bomListState(b), vs = versionStates(b, new Date().toISOString()), hasDraft = sorted.some((x) => x.status === 'draft'), editable = v.status === 'draft' && may.edit && state !== 'archived', p = prodOf(db, b.productId);
  const status = async (to: 'active' | 'inactive' | 'archived', title: string, body: string) => {
    const x = await confirm({ title, body, reason: true, danger: to === 'archived' });
    if (x.ok) run((d, c) => setBomStatus(d, c, b.id, to, x.reason), { ok: 'BOM status saved' });
  };
  return (
    <div data-testid="bom-page">
      <Back go={go} />
      <div className="page-head">
        <div><h2 className="mfg-h">{b.name} <Badge tone={BOM_BADGE[state].tone} dot>{BOM_BADGE[state].label}</Badge></h2><p>{T('Makes')} <b>{nameOf(db, b.productId)}</b> · <span className="mono">{p?.sku}</span> · {T(TYPE_LABEL[b.type])}{p && !p.active ? ` · ${T('Product is inactive')}` : ''}</p></div>
        <div className="row wrap">
          {may.create && usableBoms(db).some((x) => x.b.id === b.id) && <Button variant="primary" onClick={() => go({ tab: 'orders', order: 'new', bom: b.id })}><Factory size={15} /> {T('New production order')}</Button>}
          {may.edit && !hasDraft && state !== 'archived' && <Button onClick={() => run((d, c) => newDraftVersion(d, c, b.id), { ok: 'New version created as a draft', onOk: (n) => setVn(n) })}><Plus size={14} /> {T('New BOM version')}</Button>}
          {may.edit && <Button onClick={() => setCopying(!copying)} aria-expanded={copying}><Copy size={14} /> {T('Copy to another product')}</Button>}
          {may.edit && state === 'active' && <Button onClick={() => status('inactive', 'Stop using this BOM?', 'No new production order can be made from it. Its versions and orders are kept, and it can be used again later.')}><Power size={14} /> {T('Stop using this BOM')}</Button>}
          {may.edit && may.approve && (state === 'inactive' || state === 'archived') && <Button onClick={() => status('active', 'Use this BOM again?', 'New production orders can be made from it again.')}><Power size={14} /> {T('Use again')}</Button>}
          {may.edit && state !== 'archived' && state !== 'draft' && <Button onClick={() => status('archived', 'Archive this BOM?', 'It becomes read-only and leaves the normal list. Nothing is deleted.')}><Archive size={14} /> {T('Archive BOM')}</Button>}
        </div>
      </div>
      {copying && <Card className="mb16" title="Copy to another product" sub="A new BOM is created as a draft. This one is not changed."><ProductPicker label="Product that gets the copy" testid="pick-copy" blocked={noBom(db)} onPick={(x) => run((d, c) => duplicateBom(d, c, b.id, x.id), { ok: 'BOM copied as a draft', onOk: (nid) => { setCopying(false); setVn(null); go({ tab: 'boms', bom: nid }); } })} /></Card>}
      {editable
        ? <DraftEditor key={`${b.id}-${v.version}`} b={b} v={v} go={go} onDone={setVn} />
        : (
          <div className="mfg-split">
            <div className="col gap-16">
              <Banner>{v.status === 'draft' ? T('This version is a draft. It cannot be used for production yet.') : vs[v.version] === 'scheduled' ? T('Version {v} starts on {date}. Until then the version in use stays in use. It cannot be changed any more: create a new version to change it.', { v: v.version, date: dateFmt(v.effectiveFrom) }) : T('Version {v} cannot be changed. Create a new version to change it: orders and costs of the past stay as they were.', { v: v.version })}</Banner>
              <BomView productId={b.productId} v={v} title={T('Version {v}', { v: v.version })} />
            </div>
            <div className="col gap-16"><BomCostCard productId={b.productId} v={v} /></div>
          </div>
        )}
      <Card className="mt16" flush title="Revision history" sub="Every version is kept. An order uses the version it was created with.">
        <DataTable rows={sorted} rowKey={(x) => String(x.version)} compact cols={[
          { key: 'v', header: 'BOM version', render: (x) => <button type="button" className="linkish" onClick={() => setVn(x.version)} aria-current={x.version === v.version}>v{x.version}</button> },
          { key: 's', header: 'Version status', render: (x) => <Badge tone={VERSION_TONE[vs[x.version]]}>{vs[x.version] === 'scheduled' ? T('Starts on {date}', { date: dateFmt(x.effectiveFrom) }) : VERSION_STATUS[vs[x.version]]}</Badge> },
          { key: 'f', header: 'Period in use', render: (x) => (x.status === 'draft' ? '–' : `${dateFmt(x.effectiveFrom)}${x.effectiveTo && dayKey(x.effectiveTo) >= dayKey(x.effectiveFrom) ? ` – ${dateFmt(x.effectiveTo)}` : ''}`) },
          { key: 'y', header: 'Batch', num: true, render: (x) => qtyFmt(x.yieldQty) }, { key: 'c', header: 'Components in the BOM', num: true, render: (x) => x.components.length },
          ...(may.cost ? [{ key: 'u', header: 'Cost per unit today', num: true, render: (x: BomVersion) => <Cost v={bomCost(db, x).perUnit} /> }] : []),
          { key: 'n', header: 'Notes', hideSm: true, render: (x) => (x.notes ? engineText(T, x.notes) : '') },
        ]} />
      </Card>
    </div>
  );
}
const VERSION_STATUS: Record<'in_use' | 'scheduled' | 'replaced' | 'draft', string> = { draft: 'Draft version', in_use: 'In use now', scheduled: 'Starts later', replaced: 'Replaced' };
const VERSION_TONE: Record<keyof typeof VERSION_STATUS, 'good' | 'info' | 'warn' | ''> = { in_use: 'good', scheduled: 'info', draft: 'warn', replaced: '' };

function DraftEditor({ b, v, go, onDone }: { b: Bom; v: BomVersion; go: Go; onDone: (n: number | null) => void }) {
  const db = useDB(), T = useT(), run = useRun(), confirm = useConfirm(), may = useMay();
  const [f, setF] = useState<BomForm>(() => formOf(v)), [preview, setPreview] = useState(false), [tried, setTried] = useState(false), [first] = useState(() => JSON.stringify(formOf(v)));
  const saved = useUnsaved(JSON.stringify(f) !== first);
  const x = useMemo(() => versionOf(f), [f]), problems = useMemo(() => bomProblems(db, b.productId, x), [db.products, db.boms, b.productId, x]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = problemCount(problems) === 0;
  const patch = { yieldQty: x.yieldQty, components: x.components, laborCost: x.laborCost, overheadCost: x.overheadCost, laborKnown: x.laborKnown, overheadKnown: x.overheadKnown, otherCosts: x.otherCosts, notes: x.notes };
  return (
    <div data-testid="bom-draft">
      <div className="mb16"><Banner tone="warn">{T('Version {v} is a draft. Change it freely, then activate it. The version in use today stays in use until then.', { v: v.version })}</Banner></div>
      <div className="mfg-split">
        {preview && ready ? <BomView productId={b.productId} v={x} title="Check before saving" /> : <BomFormView productId={b.productId} f={f} onChange={setF} problems={problems} tried={tried} />}
        <div className="col gap-16"><BomCostCard productId={b.productId} v={x} sticky /></div>
      </div>
      {tried && !ready && <div className="mt16"><Banner tone="warn">{T('Please correct the messages above before saving.')}</Banner></div>}
      <SaveBar preview={preview && ready} onPreview={() => { setTried(true); if (ready) setPreview(true); }} onBack={() => setPreview(false)}
        onSave={() => run((d, c) => updateDraft(d, c, b.id, v.version, patch), { ok: 'BOM saved as a draft', onOk: () => { saved(); onDone(v.version); } })}
        onActivate={may.approve ? (iso) => run((d, c) => { updateDraft(d, c, b.id, v.version, patch); activateVersion(d, c, b.id, v.version, iso); }, { ok: 'BOM saved and in use', onOk: () => { saved(); onDone(v.version); } }) : undefined}
        extra={<Button variant="ghost" onClick={async () => { const r = await confirm({ title: 'Discard this draft?', body: 'Only the draft is removed. Other versions are kept.', danger: true, confirmLabel: 'Discard draft' }); if (r.ok) run((d, c) => discardDraft(d, c, b.id, v.version), { ok: 'Draft discarded', onOk: () => { saved(); onDone(null); if (b.versions.length === 1) go({ tab: 'boms' }); } }); }}>{T('Discard draft')}</Button>} />
    </div>
  );
}
