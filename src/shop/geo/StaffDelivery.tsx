// Delivery pin, back office: the delivery destination of an order, ready to use. Staff see who receives it, the address and the driver's note, the distance, a map, and four
// actions: open the destination in Google Maps, open the route from the shop, copy the link, copy everything a driver needs (to paste into LINE MAN or any other booking).
// There is no LINE MAN integration (it has no public booking API we could verify): this link-and-copy flow is what is possible, and it does not depend on any key.
import { useEffect, useState } from 'react';
import { Copy, ExternalLink, MapPin, Navigation, Phone } from 'lucide-react';
import { toast } from '../../domain/store';
import { Badge, Banner } from '../../ui/kit';
import type { AdminOrder } from '../api';
import { copyText } from './clipboard';
import { addressText, coordsText, deliverySummary, fmtDistance, fmtDuration, safeMapsUrl, searchAddressUrl } from './geo';
import { MapView } from './MapView';
import { drivingRoute, RouteInfo } from './services';

type TFn = (s: string, v?: Record<string, string | number>) => string;

export function StaffDelivery({ o, T, lang }: { o: AdminOrder; T: TFn; lang: 'th' | 'en' }) {
  const d = o.delivery ?? null;
  const [live, setLive] = useState<RouteInfo | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  // the route line for the map (and the numbers, when the order was placed without them): measured here, now, never made up
  useEffect(() => {
    if (!d) return;
    let on = true; setLive(null); setLiveFailed(false);
    drivingRoute(d.origin, d).then((r) => { if (on) setLive(r); }).catch(() => { if (on) setLiveFailed(true); });
    return () => { on = false; };
  }, [d?.lat, d?.lng, d?.origin.lat, d?.origin.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) {
    // an order placed before pins existed, or one where the customer typed an address
    if (o.fulfilment !== 'delivery' || !o.delivery_address) return null;
    return (
      <div className="col gap-6" data-testid="staff-delivery-nopin">
        <span className="muted">{T('No map pin on this order: it has a typed address only.')}</span>
        <a className="btn sm" href={searchAddressUrl(o.delivery_address)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> {T('Search this address in Google Maps')}</a>
      </div>
    );
  }

  const dest = safeMapsUrl(d.maps_url); const dir = safeMapsUrl(d.directions_url);
  const stored = d.route; const route = stored ?? (live ? { distance_m: live.distance_m, duration_s: live.duration_s } : null);
  const summary = deliverySummary({ ...d, route }, o.order_no);
  const copy = async (text: string) => { if (await copyText(text)) { setManual(null); toast('success', T('Copied')); } else { setManual(text); toast('error', T('Could not copy: select the text below and copy it yourself')); } };
  const differs = d.recipient_name.trim() !== o.contact_name.trim() || d.recipient_phone !== o.contact_phone;

  return (
    <div className="dp-staff" data-testid="staff-delivery">
      <div className="row wrap gap-6"><b>{T('Delivery location')}</b><Badge tone="good">{T('Pinned by the customer')}</Badge></div>
      <div className="col gap-4">
        <span data-testid="sd-recipient"><b>{d.recipient_name}</b> · <a href={`tel:${d.recipient_phone}`}><Phone size={12} aria-hidden /> {d.recipient_phone}</a>{differs && <span className="muted"> ({T('different from the customer')})</span>}</span>
        <span style={{ whiteSpace: 'pre-wrap' }} data-testid="sd-address">{addressText(d, 'th')}</span>
        {d.directions && <span className="muted" style={{ whiteSpace: 'pre-wrap' }}>{T('Extra directions')}: {d.directions}</span>}
        {d.driver_note && <div className="dp-note-driver" data-testid="sd-driver-note"><b>{T('Note for the driver')}:</b> {d.driver_note}</div>}
        <span className="muted"><MapPin size={12} aria-hidden /> {T('Coordinates')}: <span className="mono" data-testid="sd-coords">{coordsText(d)}</span></span>
      </div>
      <div className="col gap-4" data-testid="sd-distance">
        <span><b>{T('From {shop}', { shop: d.origin.name })}</b></span>
        <span>{T('Straight line {d} (not the driving distance)', { d: fmtDistance(d.straight_m, lang) })}</span>
        {route
          ? <span data-testid="sd-driving">{T('Driving {d}, about {t}', { d: fmtDistance(route.distance_m, lang), t: fmtDuration(route.duration_s, lang) })} <span className="muted">· {stored ? T('worked out when the order was placed') : T('worked out just now')}</span></span>
          : liveFailed ? <span className="muted" data-testid="sd-no-route">{T('The driving distance could not be worked out right now: open the route in Google Maps.')}</span> : <span className="muted">{T('Working out the route…')}</span>}
      </div>
      <MapView shop={d.origin} pin={d} path={live?.path} label={T('Map of the delivery location')} shopLabel={d.origin.name.slice(0, 18)} pinLabel={T('Delivery')} testId="staff-map" />
      <div className="dp-actions">
        {dest && <a className="btn primary" href={dest} target="_blank" rel="noopener noreferrer" data-testid="sd-open-dest"><ExternalLink size={14} /> {T('Open destination in Google Maps')}</a>}
        {dir && <a className="btn" href={dir} target="_blank" rel="noopener noreferrer" data-testid="sd-open-route"><Navigation size={14} /> {T('Open route from the store')}</a>}
        {dir && <button type="button" className="btn" onClick={() => void copy(dir)} data-testid="sd-copy-link"><Copy size={14} /> {T('Copy delivery link')}</button>}
        <button type="button" className="btn" onClick={() => void copy(summary)} data-testid="sd-copy-details"><Copy size={14} /> {T('Copy delivery details')}</button>
      </div>
      <div className="row wrap gap-6">
        {dest && <button type="button" className="btn sm ghost" onClick={() => void copy(dest)} data-testid="sd-copy-dest">{T('Copy location link')}</button>}
        <button type="button" className="btn sm ghost" onClick={() => void copy(coordsText(d))} data-testid="sd-copy-coords">{T('Copy coordinates')}</button>
      </div>
      {manual && <Banner tone="warn"><textarea readOnly rows={6} style={{ width: '100%' }} value={manual} onFocus={(e) => e.currentTarget.select()} data-testid="sd-manual" /></Banner>}
      <span className="muted" style={{ fontSize: 12.5 }}>{T('To book a courier (for example LINE MAN): open the route, check it, then paste the copied details into the booking.')}</span>
    </div>
  );
}
