// Delivery pin: the full-screen sheet where the customer chooses the place. Five ways to put the pin down, all ending in the same explicit "Confirm this location":
// search a place or address, tap the map, drag the pin, use the phone's position, or paste a Google Maps link / coordinates. Nothing is sent anywhere until the order is placed.
import { useEffect, useRef, useState } from 'react';
import { Crosshair, Link2, Search, X } from 'lucide-react';
import { useT } from '../i18n';
import { coordsText, inArea, LatLng, PinSource, readMapsInput, sameSpot } from './geo';
import { MapView } from './MapView';
import { currentPosition, MapServiceError, nameOfPlace, Place, searchPlaces } from './services';

export interface PickResult { pin: LatLng; source: PinSource; placeLabel: string | null }
export interface PinPickerProps { shop: LatLng & { name: string }; initial: LatLng | null; initialSource?: PinSource; initialLabel?: string | null; onConfirm: (r: PickResult) => void; onClose: () => void }

export function PinPicker({ shop, initial, initialSource, initialLabel, onConfirm, onClose }: PinPickerProps) {
  const t = useT();
  const [pin, setPin] = useState<LatLng | null>(initial);
  const [source, setSource] = useState<PinSource>(initialSource ?? 'tap');
  const [placeLabel, setPlaceLabel] = useState<string | null>(initialLabel ?? null);
  const [focus, setFocus] = useState(initial ? 1 : 0);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [mapDown, setMapDown] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [link, setLink] = useState('');
  const [gps, setGps] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const lookup = useRef(0);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  // the name of the place under the pin (to fill the address in): once the pin has stopped moving, best effort
  useEffect(() => {
    if (!pin || !inArea(pin) || placeLabel) return;
    const id = ++lookup.current;
    const h = setTimeout(() => { nameOfPlace(pin).then((n) => { if (id === lookup.current && n) setPlaceLabel(n); }).catch(() => undefined); }, 700);
    return () => clearTimeout(h);
  }, [pin?.lat, pin?.lng, placeLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  const put = (p: LatLng, how: PinSource, label: string | null = null, zoom = false) => {
    setPin(p); setSource(how); setPlaceLabel(label); setMsg(null);
    if (zoom) setFocus((n) => n + 1);
  };
  const search = async () => {
    setMsg(null); setResults(null);
    if (q.trim().length < 2) return;
    setSearching(true);
    try { setResults(await searchPlaces(q)); }
    catch (e) { setMsg(e instanceof MapServiceError && e.kind === 'busy' ? t('pk.searchBusy') : t('pk.searchFail')); }
    finally { setSearching(false); }
  };
  const takeGps = async () => {
    setMsg(null); setGps(true);
    try { put(await currentPosition(), 'gps', null, true); setResults(null); }
    catch (e) { setMsg(e instanceof MapServiceError && e.message === 'denied' ? t('pk.gpsDenied') : t('pk.gpsFail')); }
    finally { setGps(false); }
  };
  const takeLink = () => {
    const r = readMapsInput(link);
    if (r.ok) { put(r.pin, 'link', null, true); setResults(null); setLink(''); setShowLink(false); return; }
    setMsg(r.reason === 'short' ? t('pk.linkShort') : r.reason === 'range' ? t('pk.linkRange') : t('pk.linkNone'));
  };
  const outside = !!pin && !inArea(pin);

  return (
    <div className="dp-sheet" role="dialog" aria-modal="true" aria-label={t('pk.title')} data-testid="pin-picker">
      <div className="dp-sheet-head">
        <h2>{t('pk.title')}</h2>
        <button type="button" className="sp-iconbtn" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button>
      </div>
      <div className="dp-sheet-body">
        <form className="dp-search" role="search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <input ref={input} value={q} maxLength={200} placeholder={t('pk.search')} aria-label={t('pk.search')} enterKeyHint="search" onChange={(e) => setQ(e.target.value)} data-testid="pin-search" />
          <button type="submit" className="btn primary" disabled={searching || q.trim().length < 2}><Search size={16} /> {t('pk.searchBtn')}</button>
        </form>
        {searching && <div className="sp-note" aria-live="polite">…</div>}
        {results && (results.length
          ? <ul className="dp-results" aria-label={t('pk.results')} data-testid="pin-results">{results.map((r) => (
            <li key={r.id}><button type="button" onClick={() => { put(r.pin, 'search', r.label, true); setResults(null); }}><b>{r.name}</b><span>{r.label}</span></button></li>))}</ul>
          : <div className="sp-note" data-testid="pin-no-results">{t('pk.noResults')}</div>)}
        {msg && <div className="sp-note bad" role="alert" data-testid="pin-msg">{msg}</div>}
        <div className="dp-tools">
          <button type="button" className="btn" disabled={gps} onClick={() => void takeGps()} data-testid="pin-gps"><Crosshair size={16} /> {t('pk.gps')}</button>
          <button type="button" className="btn" aria-expanded={showLink} onClick={() => setShowLink((v) => !v)} data-testid="pin-link-toggle"><Link2 size={16} /> {t('pk.link')}</button>
        </div>
        {showLink && (
          <div className="dp-link">
            <div className="dp-search">
              <input value={link} maxLength={600} placeholder={t('pk.linkHint')} aria-label={t('pk.link')} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); takeLink(); } }} data-testid="pin-link" />
              <button type="button" className="btn" disabled={!link.trim()} onClick={takeLink} data-testid="pin-link-use">{t('pk.linkUse')}</button>
            </div>
          </div>
        )}
        <div className="sp-note">{t('pk.tapHint')}</div>
        <div style={{ position: 'relative', display: 'flex', flex: '1 0 280px', minHeight: 280 }}>
          <MapView className="" shop={shop} pin={pin} focus={focus} onPin={(p, how) => put(p, how)} onTilesFailed={() => setMapDown(true)} label={t('pk.mapLabel')} shopLabel={t('pk.shop')} pinLabel={t('pk.dest')} />
          {mapDown && <div className="dp-map-down" role="status" data-testid="map-down">{t('pk.mapDown')}</div>}
        </div>
      </div>
      <div className="dp-sheet-foot">
        {pin
          ? <div className="dp-coords" data-testid="pin-coords">{t('dl.coords')}: {coordsText(pin)}{placeLabel ? <><br />{t('pk.near', { place: placeLabel })}</> : null}</div>
          : <div className="dp-coords">{t('pk.noPin')}</div>}
        {outside && <div className="sp-note bad" role="alert">{t('pk.outside')}</div>}
        <button type="button" className="btn primary lg block" disabled={!pin || outside} data-testid="pin-confirm" onClick={() => pin && onConfirm({ pin, source, placeLabel: sameSpot(pin, initial) && !placeLabel ? initialLabel ?? null : placeLabel })}>{t('pk.confirm')}</button>
      </div>
    </div>
  );
}
