// The "New pack / Edit pack" form of Promotions > Online shop > Packs.
// A pack is a normal SKU with its own price, mapped to underlying SKUs and quantities ("4 bottles for ฿300, 3 points"). Once the pack has been sold its
// contents, eligible value and points per pack are locked (new contents = a new pack SKU); name, price and on-sale can still change. The server
// (rw_admin_create_pack / rw_admin_save_pack) re-checks everything: components must be active, not packs, and a locked field of a sold pack is refused with BAD_PACK.
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from '../domain/store';
import { Badge, Banner, Button, Field, Input, Modal, NumInput, Tx } from '../ui/kit';
import { rewardsAdmin, type Pack } from './api';
import { newPackForm, newPackKey, packFormToCreate, packIsLocked, packPatchFromForm, packToForm, rewardsErrorMessage, validatePackForm, type Msg, type PackForm } from './ruleForm';
import { SkuSearch, useSkuInfo, useT } from './RuleEditor';

const errStyle = { color: 'var(--crit-text)' } as const;

export function PackEditor({ pack, onClose, onSaved }: { pack: Pack | null; onClose: () => void; onSaved: (p: Pack | null) => void }) {
  const { T, say } = useT();
  const isNew = !pack;
  const locked = !!pack && packIsLocked(pack);
  const [f, setF] = useState<PackForm>(() => (pack ? packToForm(pack) : newPackForm()));
  const [key] = useState(newPackKey);                       // one key per open form: a double click or a retry is still one pack
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<Msg | null>(null);
  const set = (p: Partial<PackForm>) => setF((x) => ({ ...x, ...p }));
  const { info, remember, ensure } = useSkuInfo();
  useEffect(() => { ensure(f.items.map((i) => i.sku_code)); }, [f.items, ensure]);
  const known = useMemo(() => new Map((pack?.items ?? []).map((i) => [i.sku_code, i])), [pack]);
  const nameOf = (code: string) => info[code]?.name ?? known.get(code)?.name ?? '';
  const statusOf = (code: string) => info[code]?.status ?? known.get(code)?.status;

  const inactive = useMemo(() => new Set(isNew ? f.items.filter((i) => info[i.sku_code]?.status === 'inactive').map((i) => i.sku_code) : []), [f.items, info, isNew]);
  const errors = useMemo(() => validatePackForm(f, { inactive }), [f, inactive]);
  const err = (k: keyof typeof errors, hint?: string) => (tried && errors[k] ? <span style={errStyle}>{say(errors[k]!)}</span> : hint ? T(hint) : undefined);

  const units = f.items.reduce((s, i) => s + (Number.isInteger(i.qty) && i.qty > 0 ? i.qty : 0), 0);
  const price = typeof f.price === 'number' && f.price > 0 ? f.price : null;
  const points = f.pointsPerPack === '' ? null : f.pointsPerPack;
  const pk = (n: number) => (points == null
    ? T(n === 1 ? '1 pack = {units} items, ฿{price}.' : '2 packs = {units} items, ฿{price}.', { units: units * n, price: (price ?? 0) * n })
    : T(n === 1 ? '1 pack = {units} items, ฿{price}, {pts} points.' : '2 packs = {units} items, ฿{price}, {pts} points.', { units: units * n, price: (price ?? 0) * n, pts: points * n }));
  const summary: string[] = price && units > 0 ? [pk(1), pk(2)] : [];

  const save = async () => {
    setTried(true); setServerErr(null);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      if (!pack) {
        const a = packFormToCreate(f);
        const made = await rewardsAdmin.createPack(key, a.name, a.price, a.items, a.patch);
        toast('success', T('Pack created: {code}', { code: made.pack_sku_code }));
        onSaved(made);
      } else {
        const patch = packPatchFromForm(pack, f);
        if (!Object.keys(patch).length) { onClose(); return; }
        const saved = await rewardsAdmin.savePack(pack.pack_sku_code, patch);
        toast('success', T('Pack saved'));
        onSaved(saved);
      }
    } catch (e) { setServerErr(rewardsErrorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'New promotion pack' : 'Edit promotion pack'} size="lg" onClose={onClose} desc={pack ? <span className="mono">{pack.pack_sku_code}</span> : 'A pack is sold as one product with its own price and code.'}
      footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={busy} onClick={() => void save()}><Tx>Save pack</Tx></Button></>}>
      <div className="col" style={{ gap: 16 }}>
        {serverErr && <Banner tone="bad">{say(serverErr)}</Banner>}
        {locked && <Banner tone="warn">{T('This pack has been sold ({n} sold), so its contents, eligible value and points per pack are locked. Name, price and on sale can still change. To change the rest, create a new pack.', { n: pack!.sold_packs })}</Banner>}
        <div className="form-grid">
          <Field label="Pack name" full hint={err('name')}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder={T('e.g. 4 bottles for ฿300')} /></Field>
          <Field label="Pack price (฿)" hint={err('price', 'What the customer pays for one pack.')}><NumInput value={f.price} min={0} onChange={(n) => set({ price: isNaN(n) ? '' : n })} /></Field>
          <Field label="Points per pack" hint={err('pointsPerPack', locked ? 'Locked: this pack has been sold.' : 'Optional. Gives exactly this many points per pack, and the points rules skip this pack. Empty lets the rules decide.')}>
            <NumInput value={f.pointsPerPack} min={0} step={1} disabled={locked} onChange={(n) => set({ pointsPerPack: isNaN(n) ? '' : n })} />
          </Field>
          <Field label="Eligible value (฿)" hint={err('eligibleValue', locked ? 'Locked: this pack has been sold.' : 'Optional. How much of one pack counts toward rules that count packs. Empty means the full price.')}>
            <NumInput value={f.eligibleValue} min={0} disabled={locked} onChange={(n) => set({ eligibleValue: isNaN(n) ? '' : n })} />
          </Field>
        </div>

        <div className="col" style={{ gap: 8 }}>
          <div><div className="lbl-s"><Tx>What is inside one pack</Tx></div><div className="muted" style={{ fontSize: 12.5 }}><Tx>The products and quantities in one pack. Only active products can be added.</Tx></div></div>
          {f.items.length > 0 && (
            <div className="card" role="list" aria-label={T('Pack contents')}>
              {f.items.map((it) => (
                <div key={it.sku_code} role="listitem" className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <span className="mono">{it.sku_code}</span> {nameOf(it.sku_code)} {statusOf(it.sku_code) === 'inactive' && <Badge tone="bad">Inactive</Badge>}
                  </div>
                  <NumInput style={{ width: 84 }} aria-label={`${T('Quantity of')} ${it.sku_code}`} value={Number.isNaN(it.qty) ? '' : it.qty} min={1} step={1} disabled={locked}
                    onChange={(n) => set({ items: f.items.map((x) => (x.sku_code === it.sku_code ? { ...x, qty: n } : x)) })} />
                  {!locked && <Button variant="ghost" size="sm" icon aria-label={`${T('Remove')} ${it.sku_code}`} onClick={() => set({ items: f.items.filter((x) => x.sku_code !== it.sku_code) })}><X size={14} /></Button>}
                </div>
              ))}
            </div>
          )}
          {tried && errors.items && <div role="alert" style={errStyle}>{say(errors.items)}</div>}
          {!locked && (
            <SkuSearch label="Search products to put in the pack" remember={remember}
              why={(h) => (h.status !== 'active' ? 'Inactive: cannot be added' : f.items.some((i) => i.sku_code === h.sku_code) ? 'Already added' : h.is_pack ? 'A pack cannot go inside a pack' : null)}
              onPick={(h) => set({ items: [...f.items, { sku_code: h.sku_code, qty: 1 }] })} />
          )}
        </div>

        {summary.length > 0 && <Banner tone="info"><div className="col" style={{ gap: 2 }} aria-live="polite">{summary.map((s, i) => <div key={i} style={i === 0 ? { fontWeight: 650 } : undefined}>{s}</div>)}</div></Banner>}
      </div>
    </Modal>
  );
}
