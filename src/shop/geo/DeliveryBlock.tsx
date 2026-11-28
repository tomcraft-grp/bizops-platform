// Delivery pin: the delivery destination of an order, as the customer sees it in "My orders": who receives it, the address, the note for the driver and a link that
// opens the pinned place in Google Maps.
import { MapPin } from 'lucide-react';
import type { DeliveryInfo } from '../api';
import { useShopLang, useT } from '../i18n';
import { addressText, coordsText, fmtDistance, fmtDuration, safeMapsUrl } from './geo';

export function DeliveryBlock({ d }: { d: DeliveryInfo }) {
  const t = useT(); const lang = useShopLang();
  const url = safeMapsUrl(d.maps_url);
  return (
    <div className="col gap-6" data-testid="order-delivery">
      <div className="dp-line"><b>{t('dl.od.recipient')}</b><span>{d.recipient_name} · {d.recipient_phone}</span></div>
      <p className="sp-text">{addressText(d, lang)}</p>
      {d.directions && <p className="sp-note">{d.directions}</p>}
      {d.driver_note && <p className="sp-note"><b>{t('dl.od.driverNote')}:</b> {d.driver_note}</p>}
      <div className="dp-line"><MapPin size={14} aria-hidden /> <span className="sp-pill good">{t('dl.od.pinned')}</span><span className="muted">{coordsText(d)}</span></div>
      <div className="dp-line muted">
        <span>{t('dl.straight', { d: fmtDistance(d.straight_m, lang) })}</span>
        {d.route && <span>{t('dl.driving', { d: fmtDistance(d.route.distance_m, lang), t: fmtDuration(d.route.duration_s, lang) })}</span>}
      </div>
      {url && <a className="btn block" href={url} target="_blank" rel="noopener noreferrer" data-testid="order-map-link"><MapPin size={16} /> {t('dl.od.openMap')}</a>}
    </div>
  );
}
