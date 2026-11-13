import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ImagePlus, Plus, Star, Trash2 } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { saveProduct } from '../domain/master';
import { PRODUCT_KIND_LABEL, CHANNEL_LIST } from '../domain/meta';
import { globalAvgCost, lotsFor } from '../domain/inventory';
import { bomForProduct, rollup, versionAt } from '../domain/bom';
import { priceHistory } from '../domain/purchasing';
import { Badge, Button, Card, ChannelChip, Check, DataTable, Drawer, Empty, Field, Input, KV, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useConfirm, useHas, useRun, Tx } from '../ui/kit';
import { LineChart } from '../ui/charts';
import { MediaImg, ProductEmoji } from '../ui/shared';
import { uploadMedia } from '../ui/upload';
import { toast } from '../domain/store';
import { dateFmt, money, money0, pct, qtyFmt, shortDay, dayKey } from '../lib/util';
import type { DB, ID, Product, ProductKind } from '../domain/types';
import { t as tl } from '../lib/i18n';
import { PullSkuButton } from '../ui/PullSkuButton';

export default function Products() {
  const db = useDB();
  const [sp, setSp] = useSearchParams();
  const canCreate = useHas('catalog:create');
  const canEdit = useHas('catalog:edit');
  const canCost = useHas('finance:cost');
  const [kind, setKind] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const openId = sp.get('p');
  const stock = useMemo(() => { const m: Record<ID, number> = {}; for (const k in db.balances) { const pid = k.split('|')[1]; m[pid] = (m[pid] || 0) + db.balances[k].qty; } return m; }, [db.balances]);
  const rows = db.products.filter((p) => !kind || p.kind === kind);
  return (
    <>
      <PageHead title="Products" desc="One catalog for resale goods, manufactured goods, menu items (recipes), raw materials and packaging — with channel prices, images and cost history."
        actions={<>{canEdit && <PullSkuButton />}{canCreate && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} />{' '}<Tx>New product</Tx></Button>}</>} />
      <div className="grid g4 mb16">
        <Kpi label="Products" value={db.products.length} sub={<Tx vars={{ n: db.products.filter((p) => ['resale', 'finished', 'menu'].includes(p.kind)).length }}>{'{n} sellable'}</Tx>} />
        <Kpi label="Menu items (recipes)" value={db.products.filter((p) => p.kind === 'menu').length} sub="stock deducted by BOM" />
        <Kpi label="Raw & packaging" value={db.products.filter((p) => p.kind === 'material' || p.kind === 'packaging').length} sub="inventory-only items" />
        <Kpi label="Inactive" value={db.products.filter((p) => !p.active).length} sub="hidden from POS" />
      </div>
      <Card flush>
        <DataTable rows={rows} rowKey={(p) => p.id} pageSize={14} onRow={(p) => setSp({ p: p.id })} search={(p) => `${p.name} ${p.sku} ${p.barcode ?? ''} ${p.category}`}
          toolbar={<Select sm style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option>{Object.entries(PRODUCT_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
          cols={[
            { key: 'n', header: 'Product', sort: (p) => p.name, render: (p) => <div className="row"><ProductEmoji p={p} size={36} /><div><b>{p.name}</b><div className="sub">{p.sku}{p.barcode ? ` · ${p.barcode}` : ''}</div></div></div> },
            { key: 'k', header: 'Type', hideSm: true, render: (p) => <Badge><Tx>{PRODUCT_KIND_LABEL[p.kind]}</Tx></Badge> },
            { key: 'c', header: 'Category', hideSm: true, render: (p) => p.category },
            { key: 'p', header: 'Price', num: true, sort: (p) => p.price, render: (p) => (p.price ? money(p.price) : <span className="muted">–</span>) },
            ...(canCost ? [{ key: 'cost', header: 'Avg cost', num: true, render: (p: Product) => money(p.kind === 'menu' ? (bomForProduct(db, p.id) ? rollupPerUnit(db, p.id) : p.stdCost) : globalAvgCost(db, p.id)) }, { key: 'm', header: 'Margin', num: true, render: (p: Product) => { if (!p.price) return <span className="muted">–</span>; const c = p.kind === 'menu' ? rollupPerUnit(db, p.id) : globalAvgCost(db, p.id); return pct((p.price / 1.07 - c) / (p.price / 1.07), 0); } }] : []),
            { key: 's', header: 'On hand', num: true, sort: (p) => stock[p.id] || 0, render: (p) => (p.kind === 'menu' ? <span className="muted"><Tx>recipe</Tx></span> : `${qtyFmt(stock[p.id] || 0)} ${p.unit}`) },
            { key: 'a', header: '', render: (p) => (p.active ? null : <Badge tone="warn"><Tx>inactive</Tx></Badge>) },
          ]} />
      </Card>
      {adding && <NewProduct onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); setSp({ p: id }); }} />}
      {openId && <ProductDrawer id={openId} onClose={() => setSp({})} />}
    </>
  );
}
function rollupPerUnit(db: DB, pid: ID) {
  const b = bomForProduct(db, pid);
  const v = b && versionAt(b, new Date().toISOString());
  return v ? rollup(db, v).perUnit : 0;
}

function NewProduct({ onClose, onCreated }: { onClose: () => void; onCreated: (id: ID) => void }) {
  const run = useRun();
  const [f, setF] = useState({ name: '', sku: '', kind: 'resale' as ProductKind, category: 'General', unit: 'pcs', price: 0, stdCost: 0, barcode: '' });
  return (
    <Modal title="New product" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" onClick={() => run((d, c) => saveProduct(d, c, { ...f, barcode: f.barcode || undefined }), { ok: 'Product created', perm: 'catalog:create', onOk: onCreated })}><Tx>Create</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Name" full><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="SKU"><Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label="Barcode"><Input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></Field>
        <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ProductKind })}>{Object.entries(PRODUCT_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Category"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></Field>
        <Field label="Unit"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
        <Field label="Selling price (฿, incl. VAT)"><NumInput value={f.price} onChange={(n) => setF({ ...f, price: n || 0 })} /></Field>
        <Field label="Standard cost (฿)"><NumInput value={f.stdCost} onChange={(n) => setF({ ...f, stdCost: n || 0 })} /></Field>
      </div>
    </Modal>
  );
}

function ProductDrawer({ id, onClose }: { id: ID; onClose: () => void }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canEdit = useHas('catalog:edit');
  const canCost = useHas('finance:cost');
  const canMedia = useHas('media:create') || canEdit;
  const [tab, setTab] = useState<'details' | 'images' | 'stock' | 'channels'>('details');
  const p = db.products.find((x) => x.id === id);
  const [f, setF] = useState<Product | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const cur = f ?? p;
  const set = (patch: Partial<Product>) => setF({ ...cur, ...patch });
  const imgs = p.mediaIds.map((m) => db.media.find((x) => x.id === m)).filter(Boolean);
  const hist = priceHistory(db, p.id);
  const bom = bomForProduct(db, p.id);
  const ver = bom && versionAt(bom, new Date().toISOString());
  const roll = ver ? rollup(db, ver) : null;
  const lots = lotsFor(db, p.id);
  const balances = db.warehouses.map((w) => ({ w, b: db.balances[`${w.id}|${p.id}`] })).filter((x) => x.b && Math.abs(x.b.qty) > 0.0005);
  const avg = globalAvgCost(db, p.id);

  return (
    <Drawer title={<span className="row gap-6"><ProductEmoji p={p} size={32} />{p.name}</span>} sub={<>{p.sku} · <Tx>{PRODUCT_KIND_LABEL[p.kind]}</Tx></>} onClose={onClose}
      footer={tab === 'details' && canEdit ? <><Button onClick={() => setF(null)} disabled={!f}><Tx>Reset</Tx></Button><Button variant="primary" disabled={!f} onClick={() => run((d, c) => saveProduct(d, c, f!), { ok: 'Product saved', perm: 'catalog:edit', onOk: () => setF(null) })}><Tx>Save changes</Tx></Button></> : undefined}>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'details', label: 'Details' }, { v: 'images', label: 'Images', count: imgs.length || '' }, { v: 'stock', label: 'Stock & cost' }, { v: 'channels', label: 'Channels' }]} />
      {tab === 'details' && (
        <div className="form-grid">
          <Field label="Name" full><Input value={cur.name} disabled={!canEdit} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="SKU"><Input value={cur.sku} disabled={!canEdit} onChange={(e) => set({ sku: e.target.value })} /></Field>
          <Field label="Barcode"><Input value={cur.barcode ?? ''} disabled={!canEdit} onChange={(e) => set({ barcode: e.target.value || undefined })} /></Field>
          <Field label="Category"><Input value={cur.category} disabled={!canEdit} onChange={(e) => set({ category: e.target.value })} /></Field>
          <Field label="Unit"><Input value={cur.unit} disabled={!canEdit} onChange={(e) => set({ unit: e.target.value })} /></Field>
          <Field label="Price (฿, incl. VAT)"><NumInput value={cur.price} disabled={!canEdit} onChange={(n) => set({ price: n || 0 })} /></Field>
          {canCost && <Field label="Standard cost (฿)"><NumInput value={cur.stdCost} disabled={!canEdit} onChange={(n) => set({ stdCost: n || 0 })} /></Field>}
          <Field label="Prep station"><Select value={cur.station ?? ''} disabled={!canEdit} onChange={(e) => set({ station: (e.target.value || null) as Product['station'] })}><option value="">None</option><option value="kitchen">Kitchen</option><option value="beverage">Beverage</option></Select></Field>
          <Field label="Description" full><Textarea value={cur.description ?? ''} disabled={!canEdit} onChange={(e) => set({ description: e.target.value })} /></Field>
          <div className="full"><Check checked={cur.active} onChange={(v) => canEdit && set({ active: v })}><Tx>Active (available for sale)</Tx></Check></div>
          {['resale', 'finished', 'menu'].includes(cur.kind) && (
            <div className="full"><div className="lbl-s mb8"><Tx>Channel-specific prices (blank = default)</Tx></div>
              <div className="grid g3" style={{ gap: 10 }}>{CHANNEL_LIST.filter((c) => c.code !== 'POS').map((c) => <Field key={c.code} label={c.short}><NumInput value={cur.channelPrices[c.code] ?? ''} disabled={!canEdit} onChange={(n) => set({ channelPrices: { ...cur.channelPrices, [c.code]: isNaN(n) ? undefined : n } })} /></Field>)}</div></div>
          )}
          <div className="full"><div className="lbl-s mb8"><Tx>Reorder levels per warehouse</Tx></div>
            {db.warehouses.map((w) => <div key={w.id} className="row mb8"><span style={{ width: 190 }}>{w.name}</span><NumInput style={{ width: 90 }} placeholder={tl(lang, 'min')} disabled={!canEdit} value={cur.levels[w.id]?.min ?? ''} onChange={(n) => set({ levels: { ...cur.levels, [w.id]: { min: n || 0, max: cur.levels[w.id]?.max ?? 0 } } })} /><NumInput style={{ width: 90 }} placeholder={tl(lang, 'max')} disabled={!canEdit} value={cur.levels[w.id]?.max ?? ''} onChange={(n) => set({ levels: { ...cur.levels, [w.id]: { min: cur.levels[w.id]?.min ?? 0, max: n || 0 } } })} /></div>)}</div>
        </div>
      )}
      {tab === 'images' && (
        <div className="col">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            setBusy(true);
            for (const file of files) {
              try { const mid = await uploadMedia(file, 'product_image', { type: 'product', id: p.id }); run((d) => { d.products.find((x) => x.id === p.id)!.mediaIds.push(mid); }, { ok: `${file.name} uploaded — thumbnails generated` }); } catch (err) { toast('error', (err as Error).message); }
            }
            setBusy(false);
            e.target.value = '';
          }} />
          {canMedia && <div className="dropzone" onClick={() => fileRef.current?.click()}><ImagePlus size={26} /><div><b>{busy ? <Tx>{'Processing…'}</Tx> : <Tx>{'Add images'}</Tx>}</b></div><div className="muted" style={{ fontSize: 12 }}><Tx>JPEG / PNG / WebP · max 8 MB · content type is verified, thumbnails & optimised WebP are generated automatically</Tx></div></div>}
          {imgs.length === 0 && <Empty title="No images yet" hint="The product shows its emoji until a picture is uploaded." />}
          <div className="grid g2" style={{ gap: 10 }}>
            {imgs.map((m, i) => m && (
              <div key={m.id} className="card card-b">
                <MediaImg m={m} variant="web" size={140} />
                <div className="row between mt8"><span style={{ fontSize: 12 }}>{m.name}<div className="muted">{(m.size / 1024).toFixed(0)}{' '}<Tx>KB ·</Tx>{' '}{m.width}×{m.height} · <Badge tone={m.status === 'available' ? 'good' : m.status === 'scanning' ? 'warn' : 'bad'}>{m.status}</Badge></div></span></div>
                <div className="row mt8">{i === 0 ? <Badge tone="info"><Star size={11} />{' '}<Tx>main</Tx></Badge> : canEdit && <Button size="sm" onClick={() => run((d) => { const pr = d.products.find((x) => x.id === p.id)!; pr.mediaIds = [m.id, ...pr.mediaIds.filter((x) => x !== m.id)]; }, { ok: 'Main image changed' })}><Tx>Make main</Tx></Button>}
                  {canEdit && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: 'Remove image?', body: 'The file record is kept in Media & documents for audit; it is just unlinked from this product.', danger: true }); if (x.ok) run((d) => { const pr = d.products.find((y) => y.id === p.id)!; pr.mediaIds = pr.mediaIds.filter((y) => y !== m.id); }, { ok: 'Image unlinked' }); }}><Trash2 size={14} /></Button>}</div>
              </div>))}
          </div>
        </div>
      )}
      {tab === 'stock' && (
        <div className="col gap-16">
          {p.kind !== 'menu' && <Card title="On hand by warehouse" flush>{balances.length ? <table className="t compact"><thead><tr><th><Tx>Warehouse</Tx></th><th className="num"><Tx>Qty</Tx></th>{canCost && <th className="num"><Tx>Value</Tx></th>}{canCost && <th className="num"><Tx>Avg cost</Tx></th>}</tr></thead><tbody>{balances.map(({ w, b }) => <tr key={w.id}><td>{w.name}</td><td className="num">{qtyFmt(b.qty)} {p.unit}</td>{canCost && <td className="num">{money(b.value)}</td>}{canCost && <td className="num">{money(b.qty ? b.value / b.qty : 0)}</td>}</tr>)}</tbody></table> : <Empty title="No stock on hand" />}</Card>}
          {canCost && roll && <Card title="BOM cost roll-up" sub={`v${ver!.version} · batch yield ${ver!.yieldQty} ${p.unit}`}><KV items={[['Materials & packaging / unit', money(roll.materialsPerUnit)], ['Labor & overhead / unit', money(roll.conversionPerUnit)], [<b key="u"><Tx>Cost per unit</Tx></b>, <b key="uu">{money(roll.perUnit)}</b>], ['Standard cost', money(p.stdCost)], ['Variance vs standard', <span key="v" className={roll.perUnit > p.stdCost ? 'bad' : 'good'}>{money(roll.perUnit - p.stdCost)}</span>]]} /></Card>}
          {canCost && p.kind !== 'menu' && <Card title="Cost" sub="weighted average across warehouses"><KV items={[['Average cost', money(avg)], ['Standard cost', money(p.stdCost)], ['Latest purchase', hist.length ? money(hist[hist.length - 1].unitCost + hist[hist.length - 1].landed) : '–']]} /></Card>}
          {canCost && hist.length > 1 && <Card title="Purchase price history" sub="unit cost incl. landed"><LineChart height={170} fmt={(n) => money(n)} data={hist.map((h) => ({ label: shortDay(dayKey(h.ts)), values: { c: h.unitCost + h.landed } }))} series={[{ key: 'c', label: 'Unit cost', color: 'var(--s1)' }]} /></Card>}
          {lots.length > 0 && <Card title="Lots & expiry (FEFO)" flush><table className="t compact"><thead><tr><th><Tx>Lot</Tx></th><th><Tx>Expiry</Tx></th><th className="num"><Tx>Remaining</Tx></th></tr></thead><tbody>{lots.slice(0, 8).map((l, i) => <tr key={i}><td className="mono">{l.lot}</td><td>{l.expiry ? dateFmt(l.expiry) : '–'}</td><td className="num">{qtyFmt(l.remaining)}</td></tr>)}</tbody></table></Card>}
        </div>
      )}
      {tab === 'channels' && (
        <div className="col">
          <div className="muted"><Tx>Listings that map to this product (edit in Channels → SKU mapping).</Tx></div>
          {db.mappings.filter((m) => m.productId === p.id).map((m) => <div key={m.id} className="row between card card-b"><span className="row"><ChannelChip c={m.channel} /><span className="mono">{m.externalSku}</span></span><span className="muted">{m.externalName}</span></div>)}
          {!db.mappings.some((m) => m.productId === p.id) && <Empty title="Not listed on any marketplace" />}
        </div>
      )}
    </Drawer>
  );
}
export const _p = money0;
