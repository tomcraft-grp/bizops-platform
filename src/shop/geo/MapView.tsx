// Delivery pin: the map. One Leaflet map showing the shop and the delivery pin (and the driving route when there is one). With `onPin` the customer taps the map or drags
// the pin; without it the map only shows (the back office). Leaflet draws OpenStreetMap tiles; if they cannot be loaded the screen says so and the pin can still be chosen
// by search, by the phone's position or by pasting a link (the map is a convenience, never the only way).
import { useEffect, useRef } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './geo.css';
import { LatLng, roundPin } from './geo';
import { TILE_ATTRIBUTION, TILE_URL } from './services';

export interface MapViewProps {
  shop: LatLng; pin: LatLng | null; path?: [number, number][] | null;
  /** given: the map is for choosing (tap = move the pin, drag = fine-tune) */
  onPin?: (p: LatLng, how: 'tap' | 'drag') => void;
  onTilesFailed?: () => void;
  /** changes whenever the pin should be brought into close view (a search result, the phone's position, a pasted link) */
  focus?: number;
  label: string; shopLabel: string; pinLabel: string; className?: string; testId?: string;
}

const icon = (cls: string) => L.divIcon({ className: 'dp-marker', html: `<span class="dp-pin ${cls}"><span class="dp-pin-label"></span></span>`, iconSize: [30, 40], iconAnchor: [15, 40] });
const setLabel = (m: L.Marker | null, text: string) => { const el = m?.getElement()?.querySelector('.dp-pin-label'); if (el) el.textContent = text; };

export function MapView({ shop, pin, path, onPin, onTilesFailed, focus, label, shopLabel, pinLabel, className, testId }: MapViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pinMarker = useRef<L.Marker | null>(null);
  const shopMarker = useRef<L.Marker | null>(null);
  const line = useRef<L.Polyline | null>(null);
  const cb = useRef({ onPin, onTilesFailed }); cb.current = { onPin, onTilesFailed };
  const first = useRef({ shop, pin });

  // the map itself, once
  useEffect(() => {
    const el = host.current; if (!el) return;
    const start = first.current.pin ?? first.current.shop;
    const m = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 5, maxZoom: 19 }).setView([start.lat, start.lng], first.current.pin ? 16 : 13);
    const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION, crossOrigin: false });
    let loaded = 0; let failed = 0; let told = false;
    tiles.on('tileload', () => { loaded++; });
    tiles.on('tileerror', () => { failed++; if (!told && loaded === 0 && failed >= 3) { told = true; cb.current.onTilesFailed?.(); } });
    tiles.addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => { cb.current.onPin?.(roundPin({ lat: e.latlng.lat, lng: e.latlng.lng }), 'tap'); });
    map.current = m;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => m.invalidateSize()) : null; ro?.observe(el);
    const kick = setTimeout(() => m.invalidateSize(), 60);
    return () => { clearTimeout(kick); ro?.disconnect(); m.remove(); map.current = null; pinMarker.current = null; shopMarker.current = null; line.current = null; };
  }, []);

  // the shop marker
  useEffect(() => {
    const m = map.current; if (!m) return;
    if (!shopMarker.current) shopMarker.current = L.marker([shop.lat, shop.lng], { icon: icon('dp-pin-shop'), interactive: false, keyboard: false, zIndexOffset: -100 }).addTo(m);
    else shopMarker.current.setLatLng([shop.lat, shop.lng]);
    setLabel(shopMarker.current, shopLabel);
  }, [shop.lat, shop.lng, shopLabel]);

  // the delivery pin (draggable while choosing)
  useEffect(() => {
    const m = map.current; if (!m) return;
    if (!pin) { pinMarker.current?.remove(); pinMarker.current = null; return; }
    if (!pinMarker.current) {
      const mk = L.marker([pin.lat, pin.lng], { icon: icon(''), draggable: !!cb.current.onPin, keyboard: true, title: pinLabel, alt: pinLabel }).addTo(m);
      mk.on('dragend', () => { const p = mk.getLatLng(); cb.current.onPin?.(roundPin({ lat: p.lat, lng: p.lng }), 'drag'); });
      pinMarker.current = mk;
    } else pinMarker.current.setLatLng([pin.lat, pin.lng]);
    setLabel(pinMarker.current, pinLabel);
    // keep the pin in view: pan (never zoom out) to where it is, and fit both ends when the route is shown
    if (!m.getBounds().pad(-0.15).contains([pin.lat, pin.lng])) m.panTo([pin.lat, pin.lng], { animate: true });
  }, [pin?.lat, pin?.lng, pinLabel]);

  useEffect(() => { const m = map.current; if (m && pin && focus) m.setView([pin.lat, pin.lng], Math.max(m.getZoom(), 17), { animate: true }); }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // the route (or, without one, nothing: a straight line would look like a road)
  useEffect(() => {
    const m = map.current; if (!m) return;
    line.current?.remove(); line.current = null;
    if (path && path.length > 1) {
      line.current = L.polyline(path, { color: '#2a78d6', weight: 5, opacity: 0.85 }).addTo(m);
      if (pin) m.fitBounds(L.latLngBounds([[shop.lat, shop.lng], [pin.lat, pin.lng], ...path]).pad(0.15), { maxZoom: 16 });
    } else if (pin && !onPin) m.fitBounds(L.latLngBounds([[shop.lat, shop.lng], [pin.lat, pin.lng]]).pad(0.3), { maxZoom: 16 });
  }, [path, pin?.lat, pin?.lng, shop.lat, shop.lng, !!onPin]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className={`dp-map ${className ?? ''}`} ref={host} role="application" aria-label={label} data-testid={testId ?? 'dp-map'} />;
}
