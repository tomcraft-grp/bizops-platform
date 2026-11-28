// The map services of the delivery pin (OpenStreetMap tiles, Nominatim search, OSRM routing) answered by the test, so no browser test depends on the internet or on a provider's mood.
// The answers have the real services' shapes (checked by hand against the live services on 2026-11-28); a test can make any of them fail, slow or empty.
import type { Page } from '@playwright/test';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export interface Place { name: string; label: string; lat: number; lng: number }
export const PLACES: Place[] = [
  { name: 'หมู่บ้านสิวารัตน์ 2', label: 'หมู่บ้านสิวารัตน์ 2, บางกระทึก, สามพราน, นครปฐม, 73210, ประเทศไทย', lat: 13.745952, lng: 100.292734 },
  { name: 'ตลาดสามพราน', label: 'ตลาดสามพราน, ท่าตลาด, สามพราน, นครปฐม, 73110, ประเทศไทย', lat: 13.7702, lng: 100.3301 },
];
export interface MapMock { tiles: number; searches: string[]; reverses: number; routes: number; failTiles: boolean; failSearch: boolean | 'busy'; failRoute: boolean; failReverse: boolean; routeFactor: number; routeSeconds: number | null; reverseName: string | null }

/** straight-line metres (the same formula the app and the database use) */
const hav = (a: [number, number], b: [number, number]) => {
  const R = 6371008.8, r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export async function mockMaps(page: Page): Promise<MapMock> {
  const m: MapMock = { tiles: 0, searches: [], reverses: 0, routes: 0, failTiles: false, failSearch: false, failRoute: false, failReverse: false, routeFactor: 1.3, routeSeconds: null, reverseName: 'ถนนทดสอบ, ตำบลทดสอบ, สามพราน, นครปฐม' };
  await page.route('https://tile.openstreetmap.org/**', (route) => { m.tiles++; return m.failTiles ? route.abort('failed') : route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: PNG }); });
  await page.route('https://nominatim.openstreetmap.org/search**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''; m.searches.push(q);
    if (m.failSearch === 'busy') return route.fulfill({ status: 429, headers: cors, body: 'busy' });
    if (m.failSearch) return route.abort('failed');
    const rows = PLACES.filter((p) => p.label.includes(q) || p.name.includes(q) || q.includes('สามพราน') || q.toLowerCase() === 'all').map((p, i) => ({ place_id: 1000 + i, name: p.name, display_name: p.label, lat: String(p.lat), lon: String(p.lng) }));
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(rows) });
  });
  await page.route('https://nominatim.openstreetmap.org/reverse**', (route) => {
    m.reverses++;
    if (m.failReverse) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(m.reverseName ? { place_id: 1, display_name: m.reverseName } : { error: 'Unable to geocode' }) });
  });
  await page.route('https://router.project-osrm.org/route/v1/driving/**', (route) => {
    m.routes++;
    if (m.failRoute) return route.abort('failed');
    const [a, b] = new URL(route.request().url()).pathname.split('/').pop()!.split(';').map((s) => s.split(',').map(Number).reverse() as [number, number]);   // "lng,lat;lng,lat" -> [lat, lng]
    const distance = Math.round(hav(a, b) * m.routeFactor); const duration = m.routeSeconds ?? Math.round(distance / 8.3);
    const mid: [number, number] = [(a[1] + b[1]) / 2 + 0.002, (a[0] + b[0]) / 2];
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 'Ok', routes: [{ distance, duration, geometry: { type: 'LineString', coordinates: [[a[1], a[0]], [mid[0], mid[1]], [b[1], b[0]]] } }], waypoints: [] }) });
  });
  return m;
}
