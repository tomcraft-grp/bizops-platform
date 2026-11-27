// Back office: the online shop. Orders customers placed in the LINE app (move them along; payment is verified on the
// Payment review page, never here), the product pictures / descriptions / availability customers see, and the shop settings
// (open / closed, delivery, shipping fee). Every action is a server function that checks the caller's role again.
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ImagePlus, Package, Trash2, Upload } from 'lucide-react';
import { useLang, toast } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { STATUS_LABEL } from '../domain/meta';
import { dateTimeFmt, money } from '../lib/util';
import { supabase } from '../lib/supabase';
import { Badge, Banner, Button, Drawer, Empty, Field, Input, PageHead, SearchBox, Select, Skeleton, Switch, Tabs, Textarea, useConfirm } from '../ui/kit';
import { STATUS as PAY_STATUS } from '../finance/api';
import { AdminCategory, AdminOrder, AdminOrdersPage, AdminProduct, AdminSettings, ContentPatch, OrderStatus, ShopError, ShopSpec, shopAdmin } from './api';
import { preError } from '../preorders/view';
import { pickupLabel } from './preorderView';

type Panel = 'orders' | 'products' | 'settings';
const publicUrl = (path: string) => supabase.storage.from('shop-products').getPublicUrl(path).data.publicUrl;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STATUSES: OrderStatus[] = ['new', 'confirmed', 'preparing', 'packed', 'ready', 'shipped', 'completed', 'cancelled', 'returned'];
const TONE: Record<OrderStatus, 'good' | 'warn' | 'bad' | 'info' | ''> = { new: 'info', confirmed: 'info', preparing: 'info', packed: 'info', ready: 'good', shipped: 'good', completed: 'good', cancelled: '', returned: 'bad' };
export const ORDER_TONE = TONE;   // the Orders page shows the same colours for the same statuses

/** The moves the database allows (public.shop_admin_set_status); cancelling is separate. */
const nextSteps = (o: Pick<AdminOrder, 'status' | 'fulfilment' | 'order_type'>): OrderStatus[] => {
  switch (o.status) {
    case 'new': return ['confirmed']; case 'confirmed': return ['preparing']; case 'preparing': return [o.order_type === 'preorder' ? 'ready' : 'packed'];   // a preorder goes straight to ready (its checklist replaces the packing step)
    case 'packed': return [o.fulfilment === 'pickup' ? 'ready' : 'shipped']; case 'ready': return ['completed'];
    case 'shipped': return ['completed', 'returned']; case 'completed': return ['returned']; default: return [];
  }
};

export default function ShopAdmin() {
  const lang = useLang();
  const T = (s: string, v?: Record<string, string | number>) => tl(lang, s, v);
  const [panel, setPanel] = useState<Panel>('orders');
  const [counts, setCounts] = useState<AdminOrdersPage['counts']>({});
  return (
    <>
      <PageHead title="Online shop" desc="Orders from the LINE app, the products customers see, and the shop settings. Payments are verified on the Payment review page." />
      <Tabs<Panel> value={panel} onChange={setPanel} tabs={[{ v: 'orders', label: 'Orders', count: counts.new || undefined }, { v: 'products', label: 'Products' }, { v: 'settings', label: 'Settings' }]} />
      {panel === 'orders' && <OrdersPanel T={T} onCounts={setCounts} />}
      {panel === 'products' && <ProductsPanel T={T} />}
      {panel === 'settings' && <SettingsPanel T={T} />}
    </>
  );
}
type TFn = (s: string, v?: Record<string, string | number>) => string;

// ================================================================================================ orders
function OrdersPanel({ T, onCounts }: { T: TFn; onCounts: (c: AdminOrdersPage['counts']) => void }) {
  const lang = useLang();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<AdminOrdersPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const [open, setOpen] = useState<string | null>(params.get('order'));         // a link from LINE: #/shop-admin?order=<id> opens that order
  const load = useCallback(() => {
    shopAdmin.orders({ status, search, limit: 50 }).then((p) => { setPage(p); onCounts(p.counts); setError(null); }).catch((e) => setError(msg(e)));
  }, [status, search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = setTimeout(load, search ? 300 : 0); return () => clearTimeout(h); }, [load, search]);
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <div className="row wrap">
        <div className="seg" role="tablist">
          <button className={!status ? 'on' : ''} onClick={() => setStatus('')}>{T('All')}</button>
          {STATUSES.map((s) => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{T(STATUS_LABEL[s])}{page?.counts[s] ? ` (${page.counts[s]})` : ''}</button>)}
        </div>
        <div style={{ marginLeft: 'auto', minWidth: 220 }}><SearchBox value={search} onChange={setSearch} placeholder="Order no., name or phone" /></div>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      {!page && !error ? <Skeleton h={120} /> : page && !page.orders.length ? <Empty icon={<Package size={24} />} title={T('No online orders yet')} hint={T('Orders placed in the customer app appear here.')} /> : page && (
        <div className="card table-wrap">
          <table className="t"><thead><tr><th>{T('Order')}</th><th>{T('Date')}</th><th>{T('Customer')}</th><th className="r">{T('Total')}</th><th>{T('Payment')}</th><th>{T('Status')}</th></tr></thead>
            <tbody>{page.orders.map((o) => (
              <tr key={o.id} className="click" tabIndex={0} onClick={() => setOpen(o.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(o.id); }}>
                <td><b className="mono">{o.order_no}</b>{o.order_type === 'preorder' && o.pickup_at && <div><Badge tone="info">{T('Preorder')}</Badge> <span className="muted">{pickupLabel(o.pickup_at, lang)}</span></div>}</td><td>{dateTimeFmt(o.created_at)}</td><td>{o.contact_name}<div className="muted">{o.contact_phone}</div></td>
                <td className="r">{money(o.total)}</td>
                <td><PayBadge code={o.invoice.status_code} T={T} /></td><td><Badge tone={TONE[o.status]}>{T(STATUS_LABEL[o.status])}</Badge></td>
              </tr>))}</tbody></table>
        </div>
      )}
      {page && page.total > page.orders.length && <div className="muted">{T('Showing {n} of {total}. Narrow the search to see the rest.', { n: page.orders.length, total: page.total })}</div>}
      {open && <OrderDrawer id={open} T={T} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
function PayBadge({ code }: { code: keyof typeof PAY_STATUS; T?: TFn }) {
  const lang = useLang();
  const s = PAY_STATUS[code];
  return <Badge tone={s.tone} dot>{lang === 'th' ? s.th : s.en}</Badge>;
}

function OrderDrawer({ id, T, onClose, onChanged }: { id: string; T: TFn; onClose: () => void; onChanged: () => void }) {
  const lang = useLang();
  const confirm = useConfirm();
  const [o, setO] = useState<AdminOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => shopAdmin.order(id).then((r) => { setO(r); setError(null); }).catch((e) => setError(msg(e))), [id]);
  useEffect(() => { void reload(); }, [reload]);
  const paid = !!o && [5, 6].includes(o.invoice.status_code);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast('success', T(ok)); setNote(''); await reload(); onChanged(); } catch (e) { toast('error', e instanceof ShopError && e.code === 'PAYMENT_REQUIRED' ? T('Payment has not been verified yet') : preError(e, T)); } finally { setBusy(false); }
  };
  const move = (to: OrderStatus) => run(() => shopAdmin.setStatus(id, to, note), 'Order updated');
  const moveUnpaid = async (to: OrderStatus) => {
    const r = await confirm({ title: 'Continue without verified payment?', body: 'Use this only when the shop has agreed it (for example cash on delivery). The reason stays in the internal log; the customer does not see it.', reason: 'Reason (internal)', confirmLabel: 'Continue anyway', danger: true });
    if (r.ok) await run(() => shopAdmin.setStatus(id, to, note, r.reason), 'Order updated');
  };
  const cancel = async () => {
    const r = await confirm({ title: 'Cancel this order?', body: 'The invoice is cancelled with it. If a payment was verified, reverse it on the Payment review page first. The customer sees the reason.', reason: 'Reason for the customer', confirmLabel: 'Cancel order', danger: true });
    if (r.ok) await run(() => shopAdmin.setStatus(id, 'cancelled', r.reason), 'Order cancelled');
  };

  return (
    <Drawer title={o ? o.order_no : T('Order')} sub={o ? dateTimeFmt(o.created_at) : undefined} onClose={onClose}>
      {error && <Banner tone="bad">{error}</Banner>}
      {!o ? <Skeleton h={200} /> : (
        <div className="col gap-12">
          <div className="row wrap gap-6"><Badge tone={TONE[o.status]}>{T(STATUS_LABEL[o.status])}</Badge><PayBadge code={o.invoice.status_code} T={T} />{o.order_type === 'preorder' && <Badge tone="info">{T('Preorder')}</Badge>}<Badge>{o.fulfilment === 'pickup' ? T('Pick-up') : T('Delivery')}</Badge>{o.payment_pref && <Badge>{T('Customer plans to pay by')}: {o.payment_pref === 'wallet' ? T('Wallet') : o.payment_pref === 'qr' ? 'PromptPay QR' : `${T('Bank transfer')} · ${o.payment_pref.slice(5)}`}</Badge>}</div>
          {!paid && o.status !== 'cancelled' && <Banner tone="warn">{T('Not paid yet. Verify the customer\'s slip on the Payment review page: a slip alone never marks an order paid.')} <Link to="/payment-review">{T('Open Payment review')}</Link> · <span className="mono">{o.invoice.invoice_no}</span></Banner>}
          <div className="card card-b col gap-4">
            {o.order_type === 'preorder' && o.pickup_at && <span data-testid="drawer-pickup"><b>{T('Pickup')}: {pickupLabel(o.pickup_at, lang)}</b> · <Link to={`/preorders?order=${o.id}`}>{T('Manage in Preorders')}</Link></span>}
            <b>{o.contact_name}</b><span>{o.contact_phone}</span>
            {o.customer && <span className="muted">{T('Customer account')}: {o.customer.code}{o.customer.line_user_id ? ' · LINE' : ''}</span>}
            {o.delivery_address && <span style={{ whiteSpace: 'pre-wrap' }}>{o.delivery_address}</span>}
            {o.fulfilment === 'delivery' && !o.delivery_address && <span className="muted">{T('No delivery address given: please call the customer')}</span>}
            {o.note && <span className="muted">{T(o.order_type === 'preorder' ? 'Customer instructions' : 'Customer note')}: {o.note}</span>}
          </div>
          <table className="t"><thead><tr><th>{T('Item')}</th><th style={{ textAlign: 'right' }}>{T('Qty')}</th><th style={{ textAlign: 'right' }}>{T('Amount')}</th></tr></thead>
            <tbody>{o.items.map((i) => <tr key={i.line_no}><td>{i.name}<div className="muted mono">{i.sku_code} · {money(i.unit_price)}</div></td><td style={{ textAlign: 'right' }}>{i.qty}</td><td style={{ textAlign: 'right' }}>{money(i.line_total)}</td></tr>)}
              <tr><td colSpan={2} className="muted">{T('Shipping')}</td><td style={{ textAlign: 'right' }}>{money(o.shipping_fee)}</td></tr>
              <tr><td colSpan={2}><b>{T('Total')}</b></td><td style={{ textAlign: 'right' }}><b>{money(o.total)}</b></td></tr></tbody></table>
          {o.status !== 'cancelled' && o.status !== 'returned' && (
            <div className="col gap-8">
              <Field label={T('Message to the customer (optional, e.g. a tracking number)')}><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="row wrap">
                {nextSteps(o).map((s) => (
                  <span key={s} className="row gap-6">
                    <Button variant={s === 'returned' ? undefined : 'primary'} disabled={busy || (s === 'returned' && !note.trim())} loading={busy} onClick={() => move(s)}>{T('Mark as')} {T(STATUS_LABEL[s])}</Button>
                    {!paid && s !== 'confirmed' && s !== 'returned' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => moveUnpaid(s)}>{T('Without payment…')}</Button>}
                  </span>))}
                {o.status !== 'completed' && <Button variant="danger" disabled={busy} onClick={cancel}>{T('Cancel order')}</Button>}
              </div>
              {nextSteps(o).includes('returned') && <div className="muted">{T('To mark an order as returned, write the reason in the message box first.')}</div>}
            </div>
          )}
          {o.status_note && <div className="muted">{T('Message shown to the customer')}: {o.status_note}</div>}
          <div><b>{T('History')}</b>
            <ul className="col gap-4" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{(o.events ?? []).map((e, i) => <li key={i} style={{ fontSize: 12.5 }}>{dateTimeFmt(e.at)} · {e.action}{typeof e.detail?.to === 'string' ? ` → ${e.detail.to}` : ''}{e.actor_email ? ` · ${e.actor_email}` : ''}{e.detail?.payment_override ? ` · ${T('without payment')}: ${String(e.detail.override_reason ?? '')}` : ''}</li>)}</ul></div>
        </div>
      )}
    </Drawer>
  );
}

// ================================================================================================ products
function ProductsPanel({ T }: { T: TFn }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<{ total: number; items: AdminProduct[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminProduct | null>(null);
  const [limit, setLimit] = useState(40);
  const load = useCallback(() => { shopAdmin.products({ filter, search, limit }).then((r) => { setData(r); setError(null); }).catch((e) => setError(msg(e))); }, [filter, search, limit]);
  useEffect(() => { const h = setTimeout(load, search ? 300 : 0); return () => clearTimeout(h); }, [load, search]);
  const WHY: Record<string, string> = { inactive: 'Inactive in the SKU master', no_price: 'No price', hidden_by_staff: 'Hidden', category_hidden: 'Category hidden' };
  return (
    <div className="col gap-12" style={{ marginTop: 12 }}>
      <div className="row wrap">
        <Select value={filter} onChange={(e) => { setFilter(e.target.value); setLimit(40); }} aria-label={T('Show')}>
          <option value="all">{T('All finished goods')}</option><option value="visible">{T('Shown to customers')}</option><option value="hidden">{T('Not shown')}</option><option value="no_image">{T('Shown, without a picture')}</option>
        </Select>
        <div style={{ marginLeft: 'auto', minWidth: 240 }}><SearchBox value={search} onChange={setSearch} placeholder="SKU, name or brand" /></div>
      </div>
      <Banner tone="info">{T('Customers see a finished-goods SKU only when it is Active in the SKU master, has a price and is not hidden here. Changing the price or status is done in the SKU master / Products.')}</Banner>
      {error && <Banner tone="bad">{error}</Banner>}
      {!data && !error ? <Skeleton h={160} /> : data && !data.items.length ? <Empty title={T('No products match')} /> : data && (
        <div className="card table-wrap">
          <table className="t"><thead><tr><th /><th>SKU</th><th>{T('Name')}</th><th>{T('Category')}</th><th style={{ textAlign: 'right' }}>{T('Price')}</th><th>{T('Shop')}</th></tr></thead>
            <tbody>{data.items.map((p) => (
              <tr key={p.sku_code} className="click" tabIndex={0} onClick={() => setEditing(p)} onKeyDown={(e) => { if (e.key === 'Enter') setEditing(p); }}>
                <td style={{ width: 52 }}>{p.image_urls[0] ? <img src={p.image_urls[0]} alt="" width={40} height={40} style={{ objectFit: 'cover', borderRadius: 6 }} /> : <span className="muted"><Package size={20} /></span>}</td>
                <td className="mono">{p.sku_code}</td><td>{p.name}<div className="muted">{p.brand}</div></td><td>{p.category}</td><td style={{ textAlign: 'right' }}>{p.price != null ? money(p.price) : '—'}</td>
                <td className="row wrap gap-4">{p.on_sale ? <Badge tone="good">{T('Shown')}</Badge> : <Badge tone="warn">{T(WHY[p.why_hidden ?? 'hidden_by_staff'])}</Badge>}{p.on_sale && !p.available && <Badge tone="bad">{T('Sold out')}</Badge>}{p.featured && <Badge tone="info">{T('Featured')}</Badge>}</td>
              </tr>))}</tbody></table>
        </div>
      )}
      {data && data.items.length < data.total && <Button onClick={() => setLimit(limit + 40)}>{T('Show more')} ({data.items.length}/{data.total})</Button>}
      {editing && <ProductDrawer p={editing} T={T} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function ProductDrawer({ p, T, onClose, onSaved }: { p: AdminProduct; T: TFn; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    description_th: p.description_th ?? '', description_en: p.description_en ?? '', family: p.family ?? '', badge: p.badge ?? '', max_qty: p.max_qty ? String(p.max_qty) : '',
    sort_order: String(p.sort_order), featured: p.featured, visible: p.visible, available: p.available,
  });
  const [images, setImages] = useState<string[]>(p.image_paths);
  const [specs, setSpecs] = useState<ShopSpec[]>(p.specs);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setErr(null);
    try {
      const added: string[] = [];
      for (const file of Array.from(files).slice(0, 6 - images.length)) added.push(await shopAdmin.uploadProductImage(p.sku_code, file));
      setImages((x) => [...x, ...added]);
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const patch: ContentPatch = {
        description_th: f.description_th, description_en: f.description_en, family: f.family, badge: f.badge, featured: f.featured, visible: f.visible, available: f.available,
        max_qty: f.max_qty.trim() === '' ? '' : Number(f.max_qty), sort_order: Number(f.sort_order) || 100, image_paths: images,
        specs: specs.filter((s) => s.label.trim() && s.value.trim()),
      };
      await shopAdmin.saveContent(p.sku_code, patch);
      toast('success', T('Saved')); onSaved();
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const why = !p.on_sale && p.why_hidden === 'inactive' ? 'This SKU is Inactive in the SKU master, so customers cannot see it whatever is set here.' : !p.on_sale && p.why_hidden === 'no_price' ? 'This SKU has no price, so customers cannot see it.' : null;
  return (
    <Drawer title={`${p.sku_code}`} sub={p.name} onClose={onClose} footer={<><Button onClick={onClose}>{T('Cancel')}</Button><Button variant="primary" loading={busy} disabled={busy} onClick={save}>{T('Save')}</Button></>}>
      <div className="col gap-12">
        {why && <Banner tone="warn">{T(why)}</Banner>}
        {err && <Banner tone="bad">{err}</Banner>}
        <div className="col gap-6">
          <Switch checked={f.visible} onChange={(v) => set('visible', v)} label="Shown to customers" />
          <Switch checked={f.available} onChange={(v) => set('available', v)} label="Available to order (switch off = sold out)" />
          <Switch checked={f.featured} onChange={(v) => set('featured', v)} label="Featured on the home page" />
        </div>
        <Field label={T('Pictures (up to 6, the first is the main picture)')}>
          <div className="row wrap">
            {images.map((path, i) => (
              <div key={path} className="col gap-4" style={{ width: 84 }}>
                <img src={publicUrl(path)} alt="" width={84} height={84} style={{ objectFit: 'cover', borderRadius: 8, border: i === 0 ? '2px solid var(--brand)' : '1px solid var(--border)' }} />
                <div className="row gap-4">{i > 0 && <Button size="sm" variant="ghost" onClick={() => setImages((x) => [path, ...x.filter((y) => y !== path)])}>{T('Main')}</Button>}<Button size="sm" variant="ghost" icon aria-label={T('Remove')} onClick={() => setImages((x) => x.filter((y) => y !== path))}><Trash2 size={14} /></Button></div>
              </div>))}
            {images.length < 6 && <label className="btn" style={{ height: 84, width: 84, flexDirection: 'column', cursor: 'pointer' }}><ImagePlus size={20} />{T('Add')}<input type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} /></label>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{T('JPG, PNG or WebP. Pictures are shrunk automatically. They are public: anyone with the link can see them.')}</div>
        </Field>
        <Field label={T('Description (Thai)')}><Textarea rows={3} maxLength={2000} value={f.description_th} onChange={(e) => set('description_th', e.target.value)} /></Field>
        <Field label={T('Description (English)')}><Textarea rows={3} maxLength={2000} value={f.description_en} onChange={(e) => set('description_en', e.target.value)} /></Field>
        <div className="row"><Field label={T('Badge (e.g. Best seller)')}><Input maxLength={30} value={f.badge} onChange={(e) => set('badge', e.target.value)} /></Field>
          <Field label={T('Max per order')} hint={T('Leave empty for no limit')}><Input type="number" min={1} max={99} value={f.max_qty} onChange={(e) => set('max_qty', e.target.value)} /></Field></div>
        <div className="row"><Field label={T('Option group')} hint={T('SKUs with the same group name show each other as options')}><Input maxLength={80} value={f.family} onChange={(e) => set('family', e.target.value)} /></Field>
          <Field label={T('Sort order')} hint={T('Lower shows first')}><Input type="number" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field></div>
        <Field label={T('Specifications')}>
          <div className="col gap-6">
            {specs.map((s, i) => (
              <div key={i} className="row"><Input placeholder={T('Label')} maxLength={40} value={s.label} onChange={(e) => setSpecs((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
                <Input placeholder={T('Value')} maxLength={120} value={s.value} onChange={(e) => setSpecs((x) => x.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
                <Button size="sm" variant="ghost" icon aria-label={T('Remove')} onClick={() => setSpecs((x) => x.filter((_, j) => j !== i))}><Trash2 size={14} /></Button></div>))}
            {specs.length < 12 && <Button size="sm" onClick={() => setSpecs((x) => [...x, { label: '', value: '' }])}>{T('Add a specification')}</Button>}
          </div>
        </Field>
      </div>
    </Drawer>
  );
}

// ================================================================================================ settings
function SettingsPanel({ T }: { T: TFn }) {
  const [s, setS] = useState<AdminSettings | null>(null);
  const [cats, setCats] = useState<AdminCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ closed_message: '', pickup_note: '', shipping_fee: '0', free_shipping_min: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    shopAdmin.settings().then((r) => { setS(r); setForm({ closed_message: r.closed_message ?? '', pickup_note: r.pickup_note ?? '', shipping_fee: String(r.shipping_fee), free_shipping_min: r.free_shipping_min != null ? String(r.free_shipping_min) : '' }); setError(null); }).catch((e) => setError(msg(e)));
    shopAdmin.categories().then(setCats).catch((e) => setError(msg(e)));
  }, []);
  useEffect(load, [load]);
  const save = async (patch: Parameters<typeof shopAdmin.saveSettings>[0], ok = 'Saved') => {
    setBusy(true);
    try { setS(await shopAdmin.saveSettings(patch)); toast('success', T(ok)); } catch (e) { toast('error', msg(e)); } finally { setBusy(false); }
  };
  const saveText = () => save({ closed_message: form.closed_message, pickup_note: form.pickup_note, shipping_fee: Number(form.shipping_fee) || 0, free_shipping_min: form.free_shipping_min.trim() === '' ? null : Number(form.free_shipping_min) });
  const check = (ok: boolean, label: ReactNode) => <li style={{ color: ok ? 'var(--good-text)' : 'var(--warn-text)' }}>{ok ? '✓' : '○'} {label}</li>;
  if (error && !s) return <Banner tone="bad">{error}</Banner>;
  if (!s) return <Skeleton h={200} />;
  return (
    <div className="col gap-16" style={{ marginTop: 12, maxWidth: 760 }}>
      <div className="card card-b col gap-8">
        <b>{T('Before you open the shop')}</b>
        <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'none' }}>
          {check(s.payment_account_ready, <>{T('A payment account (your PromptPay QR) is set up')}{!s.payment_account_ready && <> · <Link to="/payment-review">{T('Set it up on Payment review')}</Link></>}</>)}
          {check(s.visible_products > 0, T('{n} products are shown to customers', { n: s.visible_products }))}
          {check(s.products_with_image > 0, T('{n} of them have a picture', { n: s.products_with_image }))}
          {check(Number(form.shipping_fee) > 0 || s.free_shipping_min != null || !s.delivery_enabled, T('Shipping fee reviewed (it is 0 until you set it)'))}
        </ul>
        <Switch checked={s.shop_open} onChange={(v) => save({ shop_open: v }, v ? 'The shop is open' : 'The shop is closed')} label="The shop takes online orders" />
        {s.shop_open && !s.payment_account_ready && <Banner tone="warn">{T('The shop is switched on but customers still cannot order: no payment account is set up.')}</Banner>}
      </div>
      <div className="card card-b col gap-12">
        <b>{T('Getting the order')}</b>
        <Switch checked={s.delivery_enabled} onChange={(v) => save({ delivery_enabled: v })} label="Delivery" />
        <div className="row"><Field label={T('Shipping fee (฿)')}><Input type="number" min={0} step="0.01" value={form.shipping_fee} onChange={(e) => setForm({ ...form, shipping_fee: e.target.value })} /></Field>
          <Field label={T('Free shipping from (฿)')} hint={T('Leave empty for never')}><Input type="number" min={0} step="0.01" value={form.free_shipping_min} onChange={(e) => setForm({ ...form, free_shipping_min: e.target.value })} /></Field></div>
        <Switch checked={s.pickup_enabled} onChange={(v) => save({ pickup_enabled: v })} label="Pick up at the shop" />
        <Field label={T('Pick-up information (address, hours)')}><Textarea rows={2} maxLength={200} value={form.pickup_note} onChange={(e) => setForm({ ...form, pickup_note: e.target.value })} /></Field>
        <Switch checked={s.require_payment_slip !== false} onChange={(v) => save({ require_payment_slip: v })} label="Customers must attach the transfer slip with the order" />
        <Field label={T('Message shown while the shop is closed')}><Input maxLength={200} value={form.closed_message} onChange={(e) => setForm({ ...form, closed_message: e.target.value })} /></Field>
        <div><Button variant="primary" loading={busy} disabled={busy} onClick={saveText}>{T('Save')}</Button></div>
      </div>
      <CategoriesCard cats={cats} T={T} onSaved={load} />
    </div>
  );
}

function CategoriesCard({ cats, T, onSaved }: { cats: AdminCategory[] | null; T: TFn; onSaved: () => void }) {
  const [edit, setEdit] = useState<Record<string, { name_th: string; name_en: string; sort_order: string }>>({});
  const [busy, setBusy] = useState('');
  const val = (c: AdminCategory) => edit[c.code] ?? { name_th: c.name_th ?? '', name_en: c.name_en ?? '', sort_order: String(c.sort_order) };
  const save = async (c: AdminCategory, extra: Partial<{ image_path: string; visible: boolean }> = {}) => {
    const v = val(c); setBusy(c.code);
    try { await shopAdmin.saveCategory(c.code, { name_th: v.name_th, name_en: v.name_en, sort_order: Number(v.sort_order) || 100, ...extra }); toast('success', T('Saved')); setEdit((x) => { const { [c.code]: _, ...rest } = x; void _; return rest; }); onSaved(); } catch (e) { toast('error', msg(e)); } finally { setBusy(''); }
  };
  const upload = async (c: AdminCategory, f: File | undefined) => { if (!f) return; setBusy(c.code); try { await save(c, { image_path: await shopAdmin.uploadCategoryImage(f) }); } catch (e) { toast('error', msg(e)); setBusy(''); } };
  const rows = useMemo(() => cats ?? [], [cats]);
  return (
    <div className="card card-b col gap-8">
      <b>{T('Categories')}</b>
      <div className="muted" style={{ fontSize: 12.5 }}>{T('Categories come from the product type in the SKU master. Here you give them the names and pictures customers see.')}</div>
      {!cats ? <Skeleton h={80} /> : !rows.length ? <Empty title={T('No categories yet')} /> : rows.map((c) => {
        const v = val(c);
        return (
          <div key={c.code} className="row wrap" style={{ alignItems: 'flex-end', borderTop: '1px solid var(--hairline)', paddingTop: 8 }}>
            <div style={{ width: 120 }}><b>{c.code}</b><div className="muted">{T('{n} products', { n: c.count })}</div></div>
            <Field label={T('Thai name')}><Input value={v.name_th} maxLength={60} onChange={(e) => setEdit({ ...edit, [c.code]: { ...v, name_th: e.target.value } })} /></Field>
            <Field label={T('English name')}><Input value={v.name_en} maxLength={60} onChange={(e) => setEdit({ ...edit, [c.code]: { ...v, name_en: e.target.value } })} /></Field>
            <Field label={T('Order')}><Input type="number" style={{ width: 70 }} value={v.sort_order} onChange={(e) => setEdit({ ...edit, [c.code]: { ...v, sort_order: e.target.value } })} /></Field>
            {c.image_url ? <img src={c.image_url} alt="" width={40} height={40} style={{ objectFit: 'cover', borderRadius: 8 }} /> : null}
            <label className="btn sm" style={{ cursor: 'pointer' }}><Upload size={13} /> {T('Picture')}<input type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => { void upload(c, e.target.files?.[0]); e.target.value = ''; }} /></label>
            <Switch checked={c.visible} onChange={(on) => void save(c, { visible: on })} label="Shown" />
            <Button size="sm" variant="primary" loading={busy === c.code} disabled={!!busy || !edit[c.code]} onClick={() => save(c)}>{T('Save')}</Button>
          </div>
        );
      })}
    </div>
  );
}
