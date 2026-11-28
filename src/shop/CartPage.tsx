// The cart tab: lines with server-checked prices, and the checkout step. Totals shown here are the server's quote
// (shop_quote); placing the order sends only SKU + quantity + contact details and the total the customer saw, and the
// database prices the order again. A retry of the same checkout returns the same order (see attemptKey).
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CalendarClock, ShoppingCart, Store, Trash2, Truck, Upload } from 'lucide-react';
import { Banner, Empty } from '../ui/kit';
import { cx } from '../lib/util';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import { Fulfilment, Quote, shop, ShopError } from './api';
import { attemptKey, cartCount, forgetAttempt, MAX_QTY, toQuoteItems, useCart } from './cart';
import { useCheckoutDraft } from './checkoutDraft';
import { TimeoutError, withTimeout } from './timeout';
import { baht, digits, packLabel, validPhone } from './format';
import { useSettings, useQuote } from './hooks';
import { K, useT } from './i18n';
import { useShopHost, useShopNav } from './nav';
import { ConfirmSheet, ErrorBox, errText, Fold, ProductImage, Stepper } from './ui';
import { RewardsPreview } from './Rewards';
import { CheckoutQrPanel, PayToBank } from '../wallet/PayTo';
import { RecentOrders } from './RecentOrders';
import { PickupPicker, PreorderSummary, QuickPhrases } from './Preorder';
import { DeliveryForm, DeliverySummary, useDrivingRoute } from './geo/DeliveryForm';
import { deliveryProblems, draftFromSaved, pinOf, toDeliveryInput } from './geo/deliveryDraft';
import type { SavedAddress } from './api';
import { preorderUnits } from './preorderView';
import { Choice, PayMethodPicker, useMethods } from '../wallet/ui';
import { removeOrderSlip, slipFingerprint, slipProblem, uploadOrderSlip } from '../wallet/api';
import { review } from '../finance/review';
import { holdUp, IDLE, type LiveState, SlipLive } from '../slipReader/SlipLive';

export function CartCore() {
  const t = useT();
  const host = useShopHost();
  const settings = useSettings();
  const lines = useCart((s) => s.lines);
  const { setQty, remove, removeMany } = useCart.getState();
  const [step, setStep] = useState<'cart' | 'checkout'>('cart');
  // what the customer chose before (it survives going to the cart, to another tab and back), else whichever way of getting the order the shop offers
  const chosen = useCheckoutDraft((s) => s.text.fulfilment);
  const fulfilment: Fulfilment = chosen ?? (settings && !settings.delivery_enabled && settings.pickup_enabled ? 'pickup' : 'delivery');
  const setFulfilment = (f: Fulfilment) => useCheckoutDraft.getState().patch({ fulfilment: f });
  const { quote, loading, error, refresh } = useQuote(lines, fulfilment);

  if (!lines.length) {
    return <><Empty icon={<ShoppingCart size={28} />} title={t('cart.empty')} hint={t('cart.emptyHint')} action={<button type="button" className="btn primary" onClick={() => host.goTab('shop')}>{t('cart.browse')}</button>} /><div className="sp-page"><RecentOrders /></div></>;
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
      <RewardsPreview lines={lines} />
      <button type="button" className="btn primary lg block" disabled={!quote || loading || !quote.ok || closed} onClick={() => setStep('checkout')}>{loading && !quote ? t('cart.checking') : t('cart.checkout')}</button>
    </div>
  );
}

/** The way the customer chose to pay, in words, for the confirmation of a preorder. */
function methodLabel(t: ReturnType<typeof useT>, m: Choice, bank?: string): string {
  if (!m) return '-';
  return m.kind === 'wallet' ? t('po.cf.method.wallet') : m.kind === 'qr' ? t('po.cf.method.qr') : t('po.cf.method.bank', { bank: bank ?? '' });
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
  // every answer lives in the draft, so nothing is lost when a section closes or the customer goes back to the cart or to the bank app
  const { text: draft, slip, patch, setSlip } = useCheckoutDraft();
  const [saved] = useState(() => loadContact(uid));
  const name = draft.name ?? saved.name ?? profile?.display_name ?? '';
  const phone = draft.phone ?? saved.phone ?? profile?.phone ?? '';
  const address = draft.address ?? saved.address ?? '';
  const note = draft.note ?? '';
  // a preorder = pick-up at a time the customer chose; it exists only while the shop offers it
  const preorder = fulfilment === 'pickup' && draft.preorder === true && settings?.preorder_enabled === true;
  const pickupAt = preorder ? draft.pickupAt ?? '' : '';
  const units = preorderUnits(quote.lines.filter((l) => l.ok));
  // delivery pin (a database with the delivery-pin migration): the place the customer confirmed on the map replaces the typed address
  const store = settings?.store;
  const pinAvailable = fulfilment === 'delivery' && !!store;
  const pinRequired = pinAvailable && settings?.delivery_pin_required !== false;
  const dl = draft.delivery ?? {};
  const contact = { name, phone };
  const dlPin = pinAvailable ? pinOf(dl) : null;
  const dlActive = pinAvailable && (pinRequired || !!dlPin);                                   // a pin that is optional but was chosen is checked like a required one
  const dlProblems = dlActive ? deliveryProblems(dl, contact) : [];
  const route = useDrivingRoute(store, dlActive && dl.confirmed ? dlPin : null);
  const [book, setBook] = useState<SavedAddress[]>([]);
  const bookLoaded = useRef(false);
  useEffect(() => {
    if (!pinAvailable || bookLoaded.current) return;
    bookLoaded.current = true;
    shop.addresses.list().then((list) => {
      setBook(list);
      const def = list.find((a) => a.is_default);
      if (def && !useCheckoutDraft.getState().text.delivery) useCheckoutDraft.getState().setDelivery(draftFromSaved(def, { name, phone }));   // the default address is chosen for the customer
    }).catch(() => undefined);                                                                  // no saved addresses: the customer pins a new one
  }, [pinAvailable]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveIt = dl.saveIt ?? (!book.length && !dl.addressId);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [reloadSlots, setReloadSlots] = useState(0);
  const inflight = useRef(false);
  const lines = useCart((s) => s.lines);
  // how the customer intends to pay: any active bank account, the wallet (only when it holds money) or the PromptPay QR. Changeable here at any time; a choice that is no
  // longer offered falls back to the first method.
  const { methods, error: methodsError, reload: reloadMethods } = useMethods();
  const hasWallet = !!methods && methods.wallet.balance > 0;
  const want = draft.method ?? null;
  const offered = !!methods && !!want && (want.kind === 'bank' ? methods.banks.some((b) => b.id === want.id) : want.kind === 'wallet' ? hasWallet : methods.promptpay);
  const method: Choice = !methods ? null : offered ? want : methods.banks.length ? { kind: 'bank', id: methods.banks[0].id } : methods.promptpay ? { kind: 'qr' } : null;
  const bank = method?.kind === 'bank' ? methods?.banks.find((b) => b.id === method.id) : undefined;
  // pay first: an order paid by transfer comes with its slip (the database refuses it otherwise); an order paid from the wallet needs none
  const needsSlip = settings?.require_payment_slip === true && method?.kind !== 'wallet';
  const slipWhen = draft.slipWhen ?? '';
  const slipRef = draft.slipRef ?? '';
  const slipInput = useRef<HTMLInputElement>(null);
  const slipSec = useRef<HTMLElement>(null);
  const [slipUrl, setSlipUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!slip || !slip.file.type.startsWith('image/')) { setSlipUrl(null); return; }
    const url = URL.createObjectURL(slip.file); setSlipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [slip]);
  const [live, setLive] = useState<LiveState>(IDLE);            // the check of the attached slip on this phone
  const [showPay, setShowPay] = useState(false);               // the transfer details again, after the slip is attached
  const methodPref = method?.kind === 'bank' ? (bank ? `bank:${bank.code}` : null) : method?.kind ?? null;

  const nameOk = name.trim().length > 0 && name.trim().length <= 100;
  const phoneOk = validPhone(phone);
  const addrOk = address.trim().length <= 400;                                  // the address is optional
  const closed = !!settings && !settings.shop_open;
  const unavailable = settings && ((fulfilment === 'delivery' && !settings.delivery_enabled) || (fulfilment === 'pickup' && !settings.pickup_enabled));
  const formOk = nameOk && phoneOk && addrOk;
  // one section open at a time; the contact form starts open only while there is something to fill in
  const [sec, setSec] = useState<'contact' | 'items' | 'payment' | null>(() => (!nameOk || !phoneOk || (fulfilment === 'delivery' && !address.trim() && draft.address === undefined) ? 'contact' : null));
  const toggle = (id: 'contact' | 'items' | 'payment') => setSec((s) => (s === id ? null : id));
  useEffect(() => { if (pinAvailable && nameOk && phoneOk) setSec((s) => (s === 'contact' && draft.address === undefined ? null : s)); }, [pinAvailable]); // eslint-disable-line react-hooks/exhaustive-deps
  const openPayment = () => { setSec('payment'); setTimeout(() => document.getElementById('fold-payment-h')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0); };
  const contactDone = () => { setTouched(true); if (!formOk) return; patch({ name, phone, address }); setSec(null); };
  const pickSlip = async (f: File) => {
    const bad = await slipProblem(f); if (bad) { setErr(t(bad)); return; }          // not a picture or PDF, or too big: said now, nothing is kept
    setSlip({ file: f, total: quote.total }); setShowPay(false); setErr(null); if (formOk) { patch({ name, phone, address }); setSec(null); }
  };

  const ask = () => {
    setTouched(true); setErr(null);
    if (dlProblems.length) {
      setErr(t(dlProblems.includes('pin') || dlProblems.includes('confirm') ? 'dl.pinFirst' : dlProblems.includes('address') ? 'dl.err.address' : 'dl.err.recipient'));
      document.querySelector('[data-testid="delivery-section"]')?.scrollIntoView({ block: 'start' }); return;
    }
    if (needsSlip && !slip) { setErr(t('co.slipMissing')); slipSec.current?.scrollIntoView({ block: 'center' }); return; }
    if (preorder && !pickupAt) { setErr(t('po.pickFirst')); document.querySelector('[data-testid="pickup-picker"]')?.scrollIntoView({ block: 'center' }); return; }
    if (!formOk) { setSec('contact'); setTimeout(() => document.querySelector<HTMLElement>('[data-fold="contact"] [aria-invalid="true"]')?.focus(), 0); return; }
    const hold = needsSlip ? holdUp(live) : null;              // still being read (never longer than 20 s), or something to confirm first
    if (hold) { setErr(t(hold)); document.querySelector('[data-testid="slip-live"]')?.scrollIntoView({ block: 'center' }); return; }
    setAsking(true);
  };
  const place = async () => {
    if (inflight.current) return;           // a second tap or a retry while one is running does nothing
    inflight.current = true; setBusy(true); setErr(null);
    let uploaded: string | null = null;
    try {
      const items = toQuoteItems(lines);
      const fp = needsSlip && slip ? await slipFingerprint(slip.file) : null;
      const dlInput = dlActive && dl.confirmed ? toDeliveryInput(dl, contact, route.status === 'ok' && route.info ? { distance_m: route.info.distance_m, duration_s: route.info.duration_s } : null) : null;
      const addrText = pinAvailable ? (dl.addressLine ?? '').trim() : address.trim();
      const payload = JSON.stringify({ items, fulfilment, name: name.trim(), phone: digits(phone), address: fulfilment === 'delivery' ? addrText : '', note: note.trim(), pm: methodPref, slip: fp?.sha256 ?? null, pu: pickupAt || null, dl: dlInput ? { ...dlInput, route: null } : null });
      const key = attemptKey(sessionStorage, uid, payload);
      // the same key gives the same file: a retry never leaves a second one. A stalled upload gives up after 60 s so the button comes back (FB-001019)
      if (fp && slip) { setUploading(true); uploaded = await withTimeout(() => uploadOrderSlip(slip.file, key, fp), 60_000); setUploading(false); }
      const r = await shop.placeOrder({ key, items, fulfilment, name: name.trim(), phone: digits(phone), address: addrText, note: note.trim(), paymentMethod: methodPref, expectedTotal: quote.total, pickupAt: pickupAt || null, delivery: dlInput,
        slip: fp && uploaded ? { path: uploaded, sha256: fp.sha256, type: fp.type, transferAt: slipWhen ? new Date(slipWhen).toISOString() : null, ref: slipRef.trim() || null } : null });
      try { localStorage.setItem(CONTACT_KEY(uid), JSON.stringify({ name: name.trim(), phone: digits(phone), address: address.trim() } satisfies Contact)); } catch { /* ignore */ }
      forgetAttempt(sessionStorage, uid);
      // the order is placed; saving the address for next time is a favour that never holds anything up (a failure is said, the order stays)
      if (dlInput && (saveIt || (dl.updateSaved && dl.addressId))) {
        const { route: _route, address_id: _aid, ...data } = dlInput; void _route; void _aid;
        const update = !!(dl.updateSaved && dl.addressId);
        void shop.addresses.save(update ? dl.addressId! : null, data, (dl.saveLabel ?? '').trim() || null, update ? undefined : !book.length ? true : undefined).catch(() => toast('error', t('dl.saveFailed')));
      }
      // the order and its slip are saved: ask the AI reader to look at the slip, once, best effort. Never awaited and it never throws (analyze swallows every error),
      // so a slow or broken reader cannot delay the order page or fail the order; the shop checks every slip by hand whatever the reader does.
      // (the answer is read defensively: an order without an invoice object must never throw after the order exists, so then the reader is simply not asked)
      const invoiceId = r.order.invoice?.id;
      if (fp && uploaded && invoiceId) void review.analyze({ invoiceId });
      useCart.getState().clear();
      useCheckoutDraft.getState().clear();
      useShopNav.getState().openOrder(r.order.id);
      toast('success', t(uploaded ? 'co.placedSlip' : 'co.placed'));
      host.goTab('pay');
    } catch (e) {
      setAsking(false);
      const code = e instanceof ShopError ? e.code : '';
      if (uploaded && e instanceof ShopError && code !== 'NETWORK' && code !== 'ERROR') removeOrderSlip(uploaded);   // refused for good: do not keep the file (a lost answer might still have created the order, so then it stays)
      if (code === 'PRICE_CHANGED' || code === 'CART_INVALID') refresh();   // show the new numbers / the unavailable items
      if (/^(SLOT_|DAY_UNITS)/.test(code)) { patch({ pickupAt: undefined }); setReloadSlots((k) => k + 1); }   // the time filled up or passed meanwhile: choose again
      setErr(e instanceof TimeoutError ? t('err.network') : errText(t, e));   // a stalled upload: the same "could not connect, safe to try again" message
    } finally { inflight.current = false; setBusy(false); setUploading(false); }
  };

  return (
    <div className="sp-page">
      <button type="button" className="sp-back" onClick={onBack}><ArrowLeft size={18} /> {t('co.back')}</button>
      <h2 className="sp-h2">{t('co.title')}</h2>
      {closed && <Banner tone="warn">{settings?.closed_message || t('shop.closed')}</Banner>}

      <section className="sp-sec"><h3>{t('co.fulfilment')}</h3>
        <div className="sp-seg" role="radiogroup" aria-label={t('co.fulfilment')}>
          <button type="button" role="radio" aria-checked={fulfilment === 'delivery'} className={cx(fulfilment === 'delivery' && 'on')} onClick={() => { patch({ preorder: false, pickupAt: undefined }); setFulfilment('delivery'); }}><Truck size={16} /> {t('co.delivery')}</button>
          <button type="button" role="radio" aria-checked={fulfilment === 'pickup' && !preorder} className={cx(fulfilment === 'pickup' && !preorder && 'on')} onClick={() => { patch({ preorder: false, pickupAt: undefined }); setFulfilment('pickup'); }}><Store size={16} /> {t('co.pickup')}</button>
          {settings?.preorder_enabled === true && <button type="button" role="radio" data-testid="mode-preorder" aria-checked={preorder} className={cx(preorder && 'on')} onClick={() => { setFulfilment('pickup'); patch({ preorder: true }); }}><CalendarClock size={16} /> {t('po.mode')}</button>}
        </div>
        {settings?.preorder_enabled === true && !preorder && <div className="sp-note">{t('po.modeHint')}</div>}
        {unavailable && <Banner tone="warn">{fulfilment === 'delivery' ? t('co.noDelivery') : t('co.noPickup')}</Banner>}
        {fulfilment === 'pickup' && settings?.pickup_note && <div className="sp-note"><b>{t('co.pickupNote')}:</b> {settings.pickup_note}</div>}
      </section>

      {pinAvailable && store && (
        <DeliveryForm value={{ ...dl, saveIt }} onChange={(p) => useCheckoutDraft.getState().patchDelivery(p)} contact={contact} shop={store} touched={touched} required={pinRequired} route={route}
          saved={book} onUseSaved={(a) => useCheckoutDraft.getState().setDelivery(draftFromSaved(a, contact))} onNew={() => useCheckoutDraft.getState().setDelivery(undefined)} offerSave />
      )}

      {preorder && (
        <section className="sp-sec" data-testid="preorder-section"><h3>{t('po.title')} <span className="bad" aria-hidden>*</span></h3>
          <div className="sp-note">{t('po.prepNote')}</div>
          <PickupPicker units={units} value={pickupAt} onChange={(at) => patch({ pickupAt: at || undefined })} reloadKey={reloadSlots} />
        </section>
      )}

      <Fold id="contact" title={t('co.contact')} open={sec === 'contact'} onToggle={() => toggle('contact')} action={t('pm.change')}
        summary={nameOk && phoneOk
          ? <span className="sp-fold-lines"><span>{name.trim()} · {phone}</span>{fulfilment === 'delivery' && <span>{(pinAvailable ? dl.addressLine ?? '' : address).trim() || t('co.noAddress')}</span>}{note.trim() && <span>{note.trim()}</span>}</span>
          : <span className="bad">{t('co.contactMissing')}</span>}>
        <div className="sp-form">
          <label>{t('co.name')}<input value={name} maxLength={100} autoComplete="name" aria-invalid={touched && !nameOk} onChange={(e) => patch({ name: e.target.value })} /></label>
          {touched && !nameOk && <small className="bad">{t('err.name')}</small>}
          <label>{t('co.phone')}<input value={phone} type="tel" inputMode="numeric" autoComplete="tel" maxLength={14} placeholder="08xxxxxxxx" aria-invalid={touched && !phoneOk} onChange={(e) => patch({ phone: e.target.value })} /></label>
          {touched && !phoneOk && <small className="bad">{t('err.phone')}</small>}
          {fulfilment === 'delivery' && !pinAvailable && (
            <>
              <label>{t('co.address')} <small className="muted">({t('co.addressOptional')})</small><textarea value={address} rows={3} maxLength={400} autoComplete="street-address" placeholder={t('co.addressHint')} aria-invalid={touched && !addrOk} onChange={(e) => patch({ address: e.target.value })} /></label>
              {touched && !addrOk && <small className="bad">{t('err.address')}</small>}
            </>
          )}
          <label>{t('co.note')}<textarea value={note} rows={2} maxLength={300} onChange={(e) => patch({ note: e.target.value })} /></label>
          {preorder && <><small className="muted">{t('po.noteHint')}</small><QuickPhrases note={note} onChange={(n) => patch({ note: n })} /></>}
          <button type="button" className="btn block" onClick={contactDone}>{t('co.contactDone')}</button>
        </div>
      </Fold>

      <Fold id="items" title={t('co.items')} open={sec === 'items'} onToggle={() => toggle('items')}
        summary={<span className="sp-fold-row"><span className="sp-thumbs-row" aria-hidden>{quote.lines.filter((l) => l.ok).slice(0, 3).map((l) => <ProductImage key={l.sku_code} src={l.image_url} alt="" />)}</span><span>{t('ord.n', { n: cartCount(lines) })} · {baht(quote.subtotal)}</span></span>}>
        <ul className="sp-mini">{quote.lines.filter((l) => l.ok).map((l) => <li key={l.sku_code}><ProductImage src={l.image_url} alt={l.name ?? l.sku_code} /><span className="grow">{l.name}<small> × {l.qty}</small></span><b>{baht(l.line_total)}</b></li>)}</ul>
      </Fold>

      {methods && (method || hasWallet)
        ? <PayMethodPicker title={t('co.payment')} methods={methods} value={method} onChange={(m) => { patch({ method: m }); setShowPay(true); }} open={sec === 'payment'} setOpen={(o) => setSec(o ? 'payment' : null)} wallet={hasWallet} hint={t('co.paymentHint')} />
        : (
          <section className="sp-sec"><h3>{t('co.payment')}</h3>
            <div className="sp-note" aria-busy={!methods && !methodsError}>{methodsError ? (needsSlip ? t('pm.loadError') : t('co.paymentLater')) : methods ? t('pm.none') : t('pm.loading')}</div>
            {methodsError && needsSlip && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={reloadMethods}>{t('common.retry')}</button>}
          </section>
        )}
      {!needsSlip && method?.kind === 'qr' && <div className="sp-note" data-testid="qr-later">{t('qr.afterOrder')}</div>}
      {method?.kind === 'wallet' && <div className="sp-note">{t('co.walletAfter')}</div>}

      {needsSlip && (
        <section ref={slipSec} className="sp-sec sp-paycard" data-testid="slip-section"><h3>{t('co.slipTitle')} <span className="bad" aria-hidden>*</span></h3>
          {(method?.kind !== 'qr' || slip) && <div className="wl-amount"><span className="wl-k">{t('co.slipAmount')}</span><b data-testid="transfer-amount">{baht(quote.total)}</b></div>}
          {/* where to pay: never inside a collapsible section. Hidden only once the slip is attached (the customer has paid), and one tap brings it back. */}
          {slip && method && <button type="button" className="sp-link" aria-expanded={showPay} onClick={() => setShowPay(!showPay)}>{t(showPay ? 'co.payHide' : 'co.payShow')}</button>}
          {(!slip || showPay) && (bank ? <PayToBank bank={bank} />
            : method?.kind === 'qr' ? (quote.ok && quote.fulfilment === fulfilment && !unavailable && !closed
              ? <CheckoutQrPanel items={toQuoteItems(lines)} fulfilment={fulfilment} total={quote.total} onStale={refresh} onOther={openPayment} /> : null)
              : methods ? <p className="sp-note">{t('co.slipPickMethod')}</p> : null)}
          {!slip && <p className="sp-note">{t(method?.kind === 'qr' ? 'co.slipHelpQr' : 'co.slipHelp')}</p>}
          <div className="sp-form">
            <input ref={slipInput} type="file" hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) void pickSlip(f); }} />
            {slip ? (
              <div className="col gap-8" data-testid="slip-preview">
                {slip.total !== quote.total && !loading && <Banner tone="warn">{t('co.slipTotalChanged', { was: baht(slip.total), now: baht(quote.total) })}</Banner>}
                <SlipLive file={slip.file} total={quote.total} onState={setLive} />
                {slipUrl ? <img src={slipUrl} alt={t('co.slipPreview')} className="wl-slip" /> : <div className="muted wl-slip-file">{slip.file.name}</div>}
                <label>{t('co.slipWhen')}<input type="datetime-local" value={slipWhen} onChange={(e) => patch({ slipWhen: e.target.value })} /></label>
                <label>{t('co.slipRef')}<input value={slipRef} maxLength={80} onChange={(e) => patch({ slipRef: e.target.value })} /></label>
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
      {err && <div data-testid="checkout-error"><Banner tone="bad">{err}</Banner></div>}
      <button type="button" className="btn primary lg block" disabled={busy || loading || !quote.ok || closed || !!unavailable} onClick={ask}>{busy ? t('co.placing') : `${t('co.place')} · ${baht(quote.total)}`}</button>

      {asking && <ConfirmSheet title={t(preorder ? 'po.cf.title' : 'co.confirmTitle')} body={preorder
        ? <PreorderSummary lines={quote.lines.filter((l) => l.ok)} pickupAt={pickupAt} note={note} total={quote.total} method={methodLabel(t, method, bank?.code)} />
        : <>{t(needsSlip ? 'co.confirmBodySlip' : 'co.confirmBody', { total: baht(quote.total) })}{dlActive && dlPin && store && <DeliverySummary value={dl} contact={contact} shop={store} />}</>} confirmLabel={t('co.place')} cancelLabel={t('common.back')} busy={busy} busyLabel={t(uploading ? 'co.uploading' : 'co.placing')} onConfirm={place} onCancel={() => setAsking(false)} />}
    </div>
  );
}
