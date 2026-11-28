// Delivery pin: the map services, called from the browser (no key, no account). OpenStreetMap shows the map and Nominatim finds places by name; OSRM gives the
// driving distance and time. Nothing here is ever made up: a service that does not answer in time, or answers with something else, is an error the screen shows
// as "not available now" and the customer carries on (the Google Maps links work without any of this).
// To use another provider (for example Google's, which needs a billing account and a key), change this file only: the screens use these functions.
import { TimeoutError, withTimeout } from '../timeout';
import { LatLng, inArea, roundPin, validCoord } from './geo';

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '© OpenStreetMap';
export const SEARCH_URL = 'https://nominatim.openstreetmap.org';
export const ROUTE_URL = 'https://router.project-osrm.org';
const SEARCH_TIMEOUT = 8_000;
const ROUTE_TIMEOUT = 9_000;

export class MapServiceError extends Error {
  constructor(public kind: 'network' | 'busy' | 'bad', message?: string) { super(message ?? kind); this.name = 'MapServiceError'; }
}

/** (a function, not `new` at every call: the details are for the log, never shown, so they are not texts to translate) */
function mapError(kind: MapServiceError['kind'], detail?: string): MapServiceError { return new MapServiceError(kind, detail); }

async function getJson(url: string, ms: number): Promise<unknown> {
  let res: Response;
  try { res = await withTimeout((signal) => fetch(url, { signal, headers: { Accept: 'application/json' }, referrerPolicy: 'strict-origin-when-cross-origin' }), ms); }
  catch (e) { throw mapError('network', e instanceof TimeoutError ? 'timeout' : (e as Error).message); }
  if (res.status === 429 || res.status === 503) throw mapError('busy', `HTTP ${res.status}`);
  if (!res.ok) throw mapError('bad', `HTTP ${res.status}`);
  try { return await res.json(); } catch { throw mapError('bad', 'not JSON'); }
}

export interface Place { id: string; name: string; label: string; pin: LatLng }

/** Look for a place by name, building, address, village, condominium or landmark in Thailand. Only on request (the public service forbids search-as-you-type). */
export async function searchPlaces(query: string): Promise<Place[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const url = `${SEARCH_URL}/search?format=jsonv2&limit=6&countrycodes=th&accept-language=th,en&q=${encodeURIComponent(q)}`;
  const rows = await getJson(url, SEARCH_TIMEOUT);
  if (!Array.isArray(rows)) throw mapError('bad', 'unexpected answer');
  const out: Place[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const pin = { lat: Number(r.lat), lng: Number(r.lon) };
    if (!validCoord(pin) || !inArea(pin)) continue;
    const label = String(r.display_name ?? '').trim();
    if (!label) continue;
    out.push({ id: String(r.place_id ?? `${pin.lat},${pin.lng}`), name: String(r.name ?? '').trim() || label.split(',')[0], label, pin: roundPin(pin) });
  }
  return out;
}

/** The name of the place under a pin, for filling the address in. Null when the service has nothing (a field or a new village). */
export async function nameOfPlace(pin: LatLng): Promise<string | null> {
  const url = `${SEARCH_URL}/reverse?format=jsonv2&zoom=18&accept-language=th,en&lat=${pin.lat}&lon=${pin.lng}`;
  const r = await getJson(url, SEARCH_TIMEOUT) as { display_name?: unknown } | null;
  const t = typeof r?.display_name === 'string' ? r.display_name.trim() : '';
  return t ? t.slice(0, 300) : null;
}

export interface RouteInfo { distance_m: number; duration_s: number; source: 'osrm'; path: [number, number][] }
/** The driving route between two points: distance, time and the line to draw. */
export async function drivingRoute(from: LatLng, to: LatLng): Promise<RouteInfo> {
  const url = `${ROUTE_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=simplified&geometries=geojson&alternatives=false&steps=false`;
  const j = await getJson(url, ROUTE_TIMEOUT) as { code?: string; routes?: { distance?: number; duration?: number; geometry?: { coordinates?: unknown } }[] } | null;
  const r = j?.code === 'Ok' ? j.routes?.[0] : undefined;
  if (!r || !(Number(r.distance) > 0) || !(Number(r.duration) > 0)) throw mapError('bad', 'no route');
  const coords = Array.isArray(r.geometry?.coordinates) ? (r.geometry!.coordinates as unknown[]) : [];
  const path = coords.filter((c): c is [number, number] => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number').map((c) => [c[1], c[0]] as [number, number]);
  return { distance_m: Math.round(Number(r.distance)), duration_s: Math.round(Number(r.duration)), source: 'osrm', path };
}

/** The phone's own position (asks the customer's permission). */
export function currentPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject(mapError('bad', 'no geolocation')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(roundPin({ lat: p.coords.latitude, lng: p.coords.longitude })),
      (e) => reject(mapError(e.code === 1 ? 'bad' : 'network', e.code === 1 ? 'denied' : e.message)),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  });
}
