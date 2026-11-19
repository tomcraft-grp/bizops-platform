// The cart tab: lines with server-checked prices, and the checkout step. Totals shown here are the server's quote
// (shop_quote); placing the order sends only SKU + quantity + contact details and the total the customer saw, and the
// database prices the order again. A retry of the same checkout returns the same order (see attemptKey).
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ShoppingCart, Store, Trash2, Truck, Upload } from 'lucide-react';
import { Banner, Empty } from '../ui/kit';
import { cx } from '../lib/util';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import { Fulfilment, Quote, shop, ShopError } from './api';
import { attemptKey, forgetAttempt, MAX_QTY, toQuoteItems, useCart } from './cart';
import { TimeoutError, withTimeout } from './timeout';
import { baht, digits, packLabel, validPhone } from './format';
import { useSettings, useQuote } from './hooks';
import { K, useT } from './i18n';
import { useShopHost, useShopNav } from './nav';
import { ConfirmSheet, ErrorBox, errText, ProductImage, Stepper } from './ui';
import { Choice, MethodCards, useMethods } from '../wallet/ui';
import { removeOrderSlip, slipFingerprint, uploadOrderSlip } from '../wallet/api';
import { review } from '../finance/review';

export function CartCore() {
  const t = useT();
  const host = useShopHost();
  const settings = useSettings();
  const lines = useCart((s) => s.lines);
  const { setQty, remove, removeMany } = useCart.getState();
  const [step, setStep] = useState<'cart' | 'checkout'>('cart');
  const [fulfilment, setFulfilment] = useState<Fulfilment>('delivery');
  const picked = useRef(false);
  useEffect(() => { // start on whichever way of getting the order the shop offers
    if (settings && !picked.current) { picked.current = true; if (!settings.delivery_enabled && settings.pickup_enabled) setFulfilment('pickup'); }
  }, [settings]);
  const { quote, loading, error, refresh } = useQuote(lines, fulfilment);

  if (!lines.length) {
    return <Empty icon={<ShoppingCart size={28} />} title={t('cart.empty')} hint={t('cart.emptyHint')} action={<button type="button" className="btn primary" onClick={() => host.goTab('shop')}>{t('cart.browse')}</button>} />;
  }
  if (step === 'checkout' && quote) {
    return <Checkout quote={quote} loading={loading} fulfilment={fulfilment} setFulfilment={setFulfilment} onBack={() => setStep('cart')} refresh={refresh} />;
  }

  const bad = quote?.lines.filter((l) => !l.ok) ?? [];
  const closed = !!settings && !settings.shop_open;
  const need = quote && fulfilment === 'delivery' && quote.free_shipping_min != null && quote.subtotal < quote.free_shipping_min ? quote.free_shipping_min - quote.subtotal : 0;
  return (
    <div className="sp-page">
      <h2 className="sp-h2">{t('cart.title')}</h2>
      {closed && <Banner tone="warn">{settings?.closed_message || t('shop.closed')}</Banner>}
      {error != null && !quote && <ErrorBox message={errText(t, error)} onRetry={refresh} />}
      <ul className="sp-lines">
        {lines.map((l) => {
          const q = quote?.lines.find((x) => x.sku_code === l.sku);
          const unit = q?.unit_price ?? l.price;
          return (
            <li key={l.sku} className={cx(q && !q.ok && 'bad')}>
              <ProductImage src={q?.image_url ?? l.image} alt={l.name} />
              <div className="sp-line-main">
                <b>{q?.name ?? l.name}</b>
                <div className="sp-sku">{l.sku}{q?.pack_qty && q.unit ? ` · ${packLabel(q.pack_qty, q.unit)}` : ''}</div>
                <div className="sp-line-price">{baht(unit)}</div>
                {q && !q.ok && q.problem && <div className="sp-badline" role="alert">{t(`cart.line.${q.problem}` as K, { n: q.max_qty ?? 0 })}</div>}
                <div className="sp-line-ctl">
                  <Stepper value={l.qty} min={1} max={l.max ?? MAX_QTY} onChange={(n) => setQty(l.sku, n)} size="sm" />
                  <button type="button" className="sp-iconbtn" aria-label={`${t('cart.remove')} ${l.name}`} onClick={() => remove(l.sku)}><Trash2 size={16} /></button>
                  <span className="sp-line-total">{q?.ok && q.line_total != null ? baht(q.line_total) : ''}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {bad.length > 0 && <div className="sp-fixbar"><span>{t('cart.fix')}</span><button type="button" className="btn sm" onClick={() => removeMany(bad.map((b) => b.sku_code))}>{t('cart.removeBad')}</button></div>}
      <div className="sp-summary" aria-busy={loading}>
        {!quote ? <div className="muted">{t('cart.checking')}</div> : (
          <>
            <div className="row between"><span>{t('cart.subtotal')}</span><span>{baht(quote.subtotal)}</span></div>
            {quote.discount > 0 && <div className="row between good"><span>{t('cart.discount')}</span><span>−{baht(quote.discount)}</span></div>}
            <div className="row between"><span>{t('cart.shipping')}</span><span>{quote.shipping_fee > 0 ? baht(quote.shipping_fee) : t('cart.free')}</span></div>
            {need > 0 && <div className="sp-note">{t('cart.freeHint', { amount: baht(need) })}</div>}
            <div className="row between sp-total"><b>{t('cart.total')}</b><b>{baht(quote.total)}</b></div>
          </>
        )}
        <div className="sp-note">{t('cart.priceNote')}</div>
      </div>
      <button type="button" className="btn primary lg block" disabled={!quote || loading || !quote.ok || closed} onClick={() => setStep('checkout')}>{loading && !quote ? t('cart.checking') : t('cart.checkout')}</button>
    </div>
  );
}

const CONTACT_KEY = (uid: string) => `tc.shop.contact:${uid}`;
interface Contact { name: string; phone: string; address: string }
function loadContact(uid: string | undefined): Partial<Contact> {
  if (!uid) return {};
  try { const v = JSON.parse(localStorage.getItem(CONTACT_KEY(uid)) ?? 'null') as Partial<Contact> | null; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

function Checkout({ quote, loading, fulfilment, setFulfilment, onBack, refresh }: {
  quote: Quote; loading: boolean; fulfilment: Fulfilment; setFulfilment: (f: Fulfilment) => void; onBack: () => void; refresh: () => void;
}) {
  const t = useT();
  const host = useShopHost();
  const { session, profile } = useAuth();
  const uid = session?.user.id ?? '';
  const settings = useSettings();
  const saved = loadContact(uid);
  const [name, setName] = useState(saved.name ?? profile?.display_name ?? '');
  const [phone, setPhone] = useState(saved.phone ?? profile?.phone ?? '');
  const [address, setAddress] = useState(saved.address ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const inflight = useRef(false);
  const lines = useCart((s) => s.lines);
  // how the customer intends to pay: any active bank account, the wallet (only when it holds money) or the PromptPay QR. Chosen again, and changeable, on the payment screen.
  const { methods } = useMethods();
  const [pickedMethod, setPickedMethod] = useState<Choice>(null);
  const method: Choice = pickedMethod ?? (methods && methods.banks.length ? { kind: 'bank', id: methods.banks[0].id } : null);
  // pay first: an order paid by transfer comes with its slip (the database refuses it otherwise); an order paid from the wallet needs none
  const needsSlip = settings?.require_payment_slip === true && method?.kind !== 'wallet';
  const [slip, setSlip] = useState<{ file: File; url: string | null } | null>(null);
  const [slipWhen, setSlipWhen] = useState('');
  const [slipRef, setSlipRef] = useState('');
  const slipInput = useRef<HTMLInputElement>(null);
  const slipUrl = useRef<string | null>(null);
  useEffect(() => () => { if (slipUrl.current) URL.revokeObjectURL(slipUrl.current); }, []);
  const pickSlip = (f: File | null) => { if (slipUrl.current) URL.revokeObjectURL(slipUrl.current); const url = f && f.type.startsWith('image/') ? URL.createObjectURL(f) : null; slipUrl.current = url; setSlip(f ? { file: f, url } : null); };
  const methodPref = method?.kind === 'bank' ? (methods?.banks.find((b) => b.id === method.id)?.code ? `bank:${methods.banks.find((b) => b.id === method.id)!.code}` : null) : method?.kind ?? null;

  const nameOk = name.trim().length > 0 && name.trim().length <= 100;
  const phoneOk = validPhone(phone);
  const addrOk = address.trim().length <= 400;                                  // the address is optional
  const closed = !!settings && !settings.shop_open;
  const unavailable = settings && ((fulfilment === 'delivery' && !settings.delivery_enabled) || (fulfilment === 'pickup' && !settings.pickup_enabled));
  const formOk = nameOk && phoneOk && addrOk;

  const ask = () => { setTouched(true); setErr(null); if (needsSlip && !slip) { setErr(t('co.slipMissing')); slipInput.current?.scrollIntoView({ block: 'center' }); return; } if (!formOk) return; setAsking(true); };
  const place = async () => {
    if (inflight.current) return;           // a second tap or a retry while one is running does nothing
    inflight.current = true; setBusy(true); setErr(null);
    let uploaded: string | null = null;
    try {
      const items = toQuoteItems(lines);
      const fp = needsSlip && slip ? await slipFingerprint(slip.file) : null;
      const payload = JSON.stringify({ items, fulfilment, name: name.trim(), phone: digits(phone), address: fulfilment === 'delivery' ? address.trim() : '', note: note.trim(), pm: methodPref, slip: fp?.sha256 ?? null });
      const key = attemptKey(sessionStorage, uid, payload);
      // the same key gives the same file: a retry never leaves a second one. A stalled upload gives up after 60 s so the button comes back (FB-001019)
      if (fp && slip) uploaded = await withTimeout(() => uploadOrderSlip(slip.file, key, fp), 60_000);
      const r = await shop.placeOrder({ key, items, fulfilment, name: name.trim(), phone: digits(phone), address: address.trim(), note: note.trim(), paymentMethod: methodPref, expectedTotal: quote.total,
        slip: fp && uploaded ? { path: uploaded, sha256: fp.sha256, type: fp.type, transferAt: slipWhen ? new Date(slipWhen).toISOString() : null, ref: slipRef.trim() || null } : null });
      try { localStorage.setItem(CONTACT_KEY(uid), JSON.stringify({ name: name.trim(), phone: digits(phone), address: address.trim() } satisfies Contact)); } catch { /* ignore */ }
      forgetAttempt(sessionStorage, uid);
      // the order and its slip are saved: ask the AI reader to look at the slip, once, best effort. Never awaited and it never throws (analyze swallows every error),
      // so a slow or broken reader cannot delay the order page or fail the order; the shop checks every slip by hand whatever the reader does.
      // (the answer is read defensively: an order without an invoice object must never throw after the order exists, so then the reader is simply not asked)
      const invoiceId = r.order.invoice?.id;
      if (fp && uploaded && invoiceId) void review.analyze({ invoiceId });
      useCart.getState().clear();
      useShopNav.getState().openOrder(r.order.id);
      toast('success', t('co.placed'));
      host.goTab('pay');
    } catch (e) {
      setAsking(false);
      const code = e instanceof ShopError ? e.code : '';
      if (uploaded && e instanceof ShopError && code !== 'NETWORK' && code !== 'ERROR') removeOrderSlip(uploaded);   // refused for good: do not keep the file (a lost answer might still have created the order, so then it stays)
      if (code === 'PRICE_CHANGED' || code === 'CART_INVALID') refresh();   // show the new numbers / the unavailable items
      setErr(e instanceof TimeoutError ? t('err.network') : errText(t, e));   // a stalled upload: the same "could not connect, safe to try again" message
    } finally { inflight.current = false; setBusy(false); }
  };

  return (
    <div className="sp-page">
      <button type="button" className="sp-back" onClick={onBack}><ArrowLeft size={18} /> {t('co.back')}</button>
      <h2 className="sp-h2">{t('co.title')}</h2>
      {closed && <Banner tone="warn">{settings?.closed_message || t('shop.closed')}</Banner>}
      {err && <Banner tone="bad">{err}</Banner>}

      <section className="sp-sec"><h3>{t('co.fulfilment')}</h3>
        <div className="sp-seg" role="radiogroup" aria-label={t('co.fulfilment')}>
          <button type="button" role="radio" aria-checked={fulfilment === 'delivery'} className={cx(fulfilment === 'delivery' && 'on')} onClick={() => setFulfilment('delivery')}><Truck size={16} /> {t('co.delivery')}</button>
          <button type="button" role="radio" aria-checked={fulfilment === 'pickup'} className={cx(fulfilment === 'pickup' && 'on')} onClick={() => setFulfilment('pickup')}><Store size={16} /> {t('co.pickup')}</button>
        </div>
        {unavailable && <Banner tone="warn">{fulfilment === 'delivery' ? t('co.noDelivery') : t('co.noPickup')}</Banner>}
        {fulfilment === 'pickup' && settings?.pickup_note && <div className="sp-note"><b>{t('co.pickupNote')}:</b> {settings.pickup_note}</div>}
      </section>

      <section className="sp-sec"><h3>{t('co.contact')}</h3>
        <div className="sp-form">
          <label>{t('co.name')}<input value={name} maxLength={100} autoComplete="name" aria-invalid={touched && !nameOk} onChange={(e) => setName(e.target.value)} /></label>
          {touched && !nameOk && <small className="bad">{t('err.name')}</small>}
          <label>{t('co.phone')}<input value={phone} type="tel" inputMode="numeric" autoComplete="tel" maxLength={14} placeholder="08xxxxxxxx" aria-invalid={touched && !phoneOk} onChange={(e) => setPhone(e.target.value)} /></label>
          {touched && !phoneOk && <small className="bad">{t('err.phone')}</small>}
          {fulfilment === 'delivery' && (
            <>
              <label>{t('co.address')} <small className="muted">({t('co.addressOptional')})</small><textarea value={address} rows={3} maxLength={400} autoComplete="street-address" placeholder={t('co.addressHint')} aria-invalid={touched && !addrOk} onChange={(e) => setAddress(e.target.value)} /></label>
              {touched && !addrOk && <small className="bad">{t('err.address')}</small>}
            </>
          )}
          <label>{t('co.note')}<textarea value={note} rows={2} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
      </section>

      <section className="sp-sec"><h3>{t('co.items')}</h3>
        <ul className="sp-mini">{quote.lines.filter((l) => l.ok).map((l) => <li key={l.sku_code}><ProductImage src={l.image_url} alt={l.name ?? l.sku_code} /><span className="grow">{l.name}<small> × {l.qty}</small></span><b>{baht(l.line_total)}</b></li>)}</ul>
      </section>

      <section className="sp-sec"><h3>{t('co.payment')}</h3>
        {methods ? <><MethodCards methods={methods} value={method} onChange={setPickedMethod} wallet={methods.wallet.balance > 0} /><div className="sp-note">{t('co.paymentHint')}</div></> : <div className="sp-note">{t('co.paymentLater')}</div>}
      </section>

      {needsSlip && (
        <section className="sp-sec" data-testid="slip-section"><h3>{t('co.slipTitle')} <span className="bad" aria-hidden>*</span></h3>
          <p className="sp-note">{t('co.slipHelp')}</p>
          <div className="wl-amount"><span className="wl-k">{t('co.slipAmount')}</span><b data-testid="transfer-amount">{baht(quote.total)}</b></div>
          <div className="sp-form">
            <input ref={slipInput} type="file" hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) { pickSlip(f); setErr(null); } }} />
            {slip ? (
              <div className="col gap-8" data-testid="slip-preview">
                {slip.url ? <img src={slip.url} alt={t('co.slipPreview')} className="wl-slip" /> : <div className="muted wl-slip-file">{slip.file.name}</div>}
                <label>{t('co.slipWhen')}<input type="datetime-local" value={slipWhen} onChange={(e) => setSlipWhen(e.target.value)} /></label>
                <label>{t('co.slipRef')}<input value={slipRef} maxLength={80} onChange={(e) => setSlipRef(e.target.value)} /></label>
                <button type="button" className="btn block" disabled={busy} onClick={() => slipInput.current?.click()}>{t('co.slipAnother')}</button>
              </div>
            ) : <button type="button" className="btn primary lg block" disabled={busy} onClick={() => slipInput.current?.click()}><Upload size={16} /> {t('co.slipChoose')}</button>}
          </div>
        </section>
      )}

      <div className="sp-summary" aria-busy={loading}>
        <div className="row between"><span>{t('cart.subtotal')}</span><span>{baht(quote.subtotal)}</span></div>
        {quote.discount > 0 && <div className="row between good"><span>{t('cart.discount')}</span><span>−{baht(quote.discount)}</span></div>}
        <div className="row between"><span>{t('cart.shipping')}</span><span>{quote.shipping_fee > 0 ? baht(quote.shipping_fee) : t('cart.free')}</span></div>
        <div className="row between sp-total"><b>{t('cart.total')}</b><b>{baht(quote.total)}</b></div>
      </div>
      <button type="button" className="btn primary lg block" disabled={busy || loading || !quote.ok || closed || !!unavailable} onClick={ask}>{busy ? t('co.placing') : `${t('co.place')} · ${baht(quote.total)}`}</button>

      {asking && <ConfirmSheet title={t('co.confirmTitle')} body={t(needsSlip ? 'co.confirmBodySlip' : 'co.confirmBody', { total: baht(quote.total) })} confirmLabel={t('co.place')} cancelLabel={t('common.back')} busy={busy} onConfirm={place} onCancel={() => setAsking(false)} />}
    </div>
  );
}
