// Delivery pin: the customer's delivery location form (checkout and "My delivery addresses"). A pin card (choose / change the place on the map, its distance from the shop),
// then the address details. Everything lives in a DeliveryDraft owned by the parent; this component only edits it.
import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { cx } from '../../lib/util';
import type { SavedAddress } from '../api';
import { useShopLang, useT } from '../i18n';
import { Contact, DeliveryDraft, deliveryProblems, pinOf, recipientOf, sameAsSaved } from './deliveryDraft';
import { addressText, coordsText, fmtDistance, fmtDuration, LatLng, straightMetres } from './geo';
import { MapView } from './MapView';
import { PinPicker } from './PinPicker';
import { drivingRoute, nameOfPlace, RouteInfo } from './services';

export interface Shop { name: string; lat: number; lng: number }
export interface RouteState { status: 'idle' | 'loading' | 'ok' | 'fail'; info?: RouteInfo }

/** The driving route from the shop to a confirmed pin. A failure is a state, never an error: the order does not depend on it. */
export function useDrivingRoute(shop: Shop | null | undefined, pin: LatLng | null, enabled = true): RouteState {
  const [st, setSt] = useState<RouteState>({ status: 'idle' });
  const key = shop && pin && enabled ? `${shop.lat},${shop.lng}>${pin.lat},${pin.lng}` : '';
  useEffect(() => {
    if (!key || !shop || !pin) { setSt({ status: 'idle' }); return; }
    let on = true; setSt({ status: 'loading' });
    drivingRoute(shop, pin).then((info) => { if (on) setSt({ status: 'ok', info }); }).catch(() => { if (on) setSt({ status: 'fail' }); });
    return () => { on = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/** "From the shop: straight line 4.8 km · driving 6.2 km, about 15 min" (the straight line is never called a driving distance). */
export function DistanceLine({ shop, pin, route }: { shop: Shop; pin: LatLng; route: RouteState }) {
  const t = useT(); const lang = useShopLang();
  const straight = fmtDistance(straightMetres(shop, pin), lang);
  return (
    <div className="dp-line" data-testid="pin-distance">
      <b>{t('dl.fromShop')}</b><span>{t('dl.straight', { d: straight })}</span>
      {route.status === 'ok' && route.info && <span data-testid="pin-driving">{t('dl.driving', { d: fmtDistance(route.info.distance_m, lang), t: fmtDuration(route.info.duration_s, lang) })}</span>}
      {route.status === 'loading' && <span className="muted" aria-live="polite">{t('dl.routeLoading')}</span>}
      {route.status === 'fail' && <span className="muted" data-testid="route-fail">{t('dl.routeFail')}</span>}
    </div>
  );
}

const PHRASES: ('dl.q.call' | 'dl.q.gate' | 'dl.q.security' | 'dl.q.door')[] = ['dl.q.call', 'dl.q.gate', 'dl.q.security', 'dl.q.door'];

export interface DeliveryFormProps {
  value: DeliveryDraft; onChange: (p: Partial<DeliveryDraft>) => void; contact: Contact; shop: Shop; touched: boolean;
  /** the pin must be confirmed to order (the shop's switch); false = optional */
  required: boolean; route: RouteState;
  saved?: SavedAddress[]; onUseSaved?: (a: SavedAddress) => void; onNew?: () => void;
  /** offer "save this address" (checkout) */
  offerSave?: boolean;
  /** no title and heading (the form sits inside another heading) */
  bare?: boolean;
}

export function DeliveryForm({ value, onChange, contact, shop, touched, required, route, saved, onUseSaved, onNew, offerSave, bare }: DeliveryFormProps) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  const [filling, setFilling] = useState(false);
  const pin = pinOf(value);
  const problems = deliveryProblems(value, contact);
  const ok = !!pin && !!value.confirmed;
  const line = useRef<HTMLTextAreaElement>(null);
  const from = saved?.find((a) => a.id === value.addressId);
  const edited = !!from && !sameAsSaved(value, from, contact);
  const addrBad = touched && problems.includes('address');
  const recBad = touched && problems.includes('recipient');

  const fillFromMap = async () => {
    if (!pin) return;
    setFilling(true);
    try { const n = await nameOfPlace(pin); if (n) { onChange({ addressLine: n, placeLabel: n }); line.current?.focus(); } } catch { /* the customer types it */ } finally { setFilling(false); }
  };
  const addPhrase = (k: (typeof PHRASES)[number]) => {
    const p = t(k); const cur = (value.driverNote ?? '').trim();
    if (cur.includes(p)) return;
    onChange({ driverNote: (cur ? `${cur}. ${p}` : p).slice(0, 300) });
  };
  const field = (k: keyof DeliveryDraft, label: string, max: number, extra?: { hint?: string; mode?: 'text' | 'tel' }) => (
    <label>{label}<input value={(value[k] as string | undefined) ?? ''} maxLength={max} inputMode={extra?.mode} placeholder={extra?.hint} onChange={(e) => onChange({ [k]: e.target.value } as Partial<DeliveryDraft>)} /></label>
  );

  return (
    <section className="sp-sec" data-testid="delivery-section" data-fold="delivery">
      {!bare && <h3>{t('dl.title')} {required ? <span className="bad" aria-hidden>*</span> : <small className="muted">({t('dl.optional')})</small>}</h3>}
      {!bare && <div className="sp-note">{t('dl.intro')}</div>}

      {!!saved?.length && (
        <div className="col gap-6" data-testid="saved-chips">
          <small className="muted">{t('dl.saved')}</small>
          <div className="dp-chips" role="group" aria-label={t('dl.saved')}>
            {saved.map((a) => (
              <button key={a.id} type="button" className={cx('dp-chip', value.addressId === a.id && 'on')} aria-pressed={value.addressId === a.id} onClick={() => onUseSaved?.(a)} data-testid="saved-chip">
                {a.label || a.address_line.slice(0, 18)}{a.is_default ? ` · ${t('dl.default')}` : ''}
              </button>))}
            <button type="button" className={cx('dp-chip', !value.addressId && 'on')} aria-pressed={!value.addressId} onClick={() => onNew?.()} data-testid="new-address-chip">+ {t('dl.newAddress')}</button>
          </div>
        </div>
      )}

      <div className={cx('dp-card', ok ? 'ok' : 'todo')} data-testid="pin-card" aria-invalid={touched && !ok && required}>
        {pin
          ? (
            <>
              <div className="dp-line"><MapPin size={16} aria-hidden /> <b data-testid="pin-state">{ok ? t('dl.confirmed') : t('dl.notConfirmed')}</b><span className="muted">{t('dl.coords')}: {coordsText(pin)}</span></div>
              <DistanceLine shop={shop} pin={pin} route={route} />
              <MapView className="" shop={shop} pin={pin} path={route.info?.path} label={t('pk.mapLabel')} shopLabel={t('pk.shop')} pinLabel={t('pk.dest')} testId="dp-map-preview" />
              <button type="button" className="btn block" onClick={() => setPicking(true)} data-testid="pin-change">{t('dl.changePin')}</button>
            </>
          )
          : <button type="button" className="btn primary lg block" onClick={() => setPicking(true)} data-testid="pin-choose"><MapPin size={18} /> {t('dl.pickOnMap')}</button>}
        {touched && !ok && required && <small className="bad" role="alert" data-testid="pin-missing">{t('dl.pinFirst')}</small>}
      </div>

      <div className="sp-form">
        <label>{t('dl.f.address')}
          <textarea ref={line} rows={3} maxLength={300} value={value.addressLine ?? ''} placeholder={t('dl.f.addressHint')} autoComplete="street-address" aria-invalid={addrBad}
            onChange={(e) => onChange({ addressLine: e.target.value })} data-testid="dl-address" /></label>
        {addrBad && <small className="bad">{t('dl.err.address')}</small>}
        {pin && <button type="button" className="sp-link" disabled={filling} onClick={() => void fillFromMap()} data-testid="dl-fill">{t('dl.f.addressFill')}</button>}
        {field('unit', t('dl.f.unit'), 60)}
        {field('village', t('dl.f.village'), 100)}
        {field('floor', t('dl.f.floor'), 20)}
        {field('landmark', t('dl.f.landmark'), 120, { hint: t('dl.f.landmarkHint') })}
        <label>{t('dl.f.directions')}<textarea rows={2} maxLength={300} value={value.directions ?? ''} placeholder={t('dl.f.directionsHint')} onChange={(e) => onChange({ directions: e.target.value })} data-testid="dl-directions" /></label>
        <label>{t('dl.f.driverNote')}<textarea rows={2} maxLength={300} value={value.driverNote ?? ''} onChange={(e) => onChange({ driverNote: e.target.value })} data-testid="dl-driver" /></label>
        <div className="col gap-6"><small className="muted">{t('dl.f.phrases')}</small>
          <div className="dp-chips">{PHRASES.map((k) => <button key={k} type="button" className="dp-chip" onClick={() => addPhrase(k)}>{t(k)}</button>)}</div></div>

        <label className="dp-check"><input type="checkbox" checked={!!value.other} onChange={(e) => onChange({ other: e.target.checked || undefined })} data-testid="dl-other" /> {t('dl.f.other')}</label>
        {value.other && (
          <>
            {field('rname', t('dl.f.rname'), 100)}
            {field('rphone', t('dl.f.rphone'), 14, { mode: 'tel', hint: '08xxxxxxxx' })}
            {recBad && <small className="bad" role="alert">{t('dl.err.recipient')}</small>}
          </>
        )}

        {offerSave && (
          <div className="col gap-6">
            {edited && <label className="dp-check"><input type="checkbox" checked={!!value.updateSaved} onChange={(e) => onChange({ updateSaved: e.target.checked || undefined })} data-testid="dl-update-saved" /> {t('dl.saveUpdate')}</label>}
            {(!from || !value.updateSaved) && !(from && !edited) && (
              <>
                <label className="dp-check"><input type="checkbox" checked={!!value.saveIt} onChange={(e) => onChange({ saveIt: e.target.checked })} data-testid="dl-save" /> {t('dl.save')}</label>
                {value.saveIt && <label>{t('dl.saveLabel')}<input value={value.saveLabel ?? ''} maxLength={40} onChange={(e) => onChange({ saveLabel: e.target.value })} data-testid="dl-save-label" /></label>}
              </>
            )}
          </div>
        )}
      </div>

      {picking && (
        <PinPicker shop={shop} initial={pin} initialSource={value.source} initialLabel={value.placeLabel}
          onClose={() => setPicking(false)}
          onConfirm={({ pin: p, source, placeLabel }) => {
            const auto = !(value.addressLine ?? '').trim() || value.addressLine === value.placeLabel;       // the address is empty or still what the map filled in: let the map fill it again
            const moved = !pin || p.lat !== pin.lat || p.lng !== pin.lng;
            onChange({ lat: p.lat, lng: p.lng, confirmed: true, source, placeLabel: placeLabel ?? (moved ? undefined : value.placeLabel), ...(auto && placeLabel ? { addressLine: placeLabel } : {}) });
            setPicking(false);
          }} />
      )}
    </section>
  );
}

/** What the customer is about to confirm, in the order confirmation sheet: who, where, which pin. */
export function DeliverySummary({ value, contact, shop }: { value: DeliveryDraft; contact: Contact; shop: Shop }) {
  const t = useT(); const lang = useShopLang();
  const pin = pinOf(value);
  const r = recipientOf(value, contact);
  if (!pin) return null;
  return (
    <div className="dp-card" data-testid="confirm-delivery">
      <div className="dp-line"><b>{t('dl.f.recipient')}</b><span>{r.name} · {r.phone}</span></div>
      <div className="sp-text">{addressText({ address_line: value.addressLine ?? '', unit_no: value.unit, village: value.village, floor_no: value.floor, landmark: value.landmark }, lang)}</div>
      <div className="dp-line"><MapPin size={14} aria-hidden /> <span>{coordsText(pin)}</span><span className="muted">· {t('dl.straight', { d: fmtDistance(straightMetres(shop, pin), lang) })}</span></div>
    </div>
  );
}
