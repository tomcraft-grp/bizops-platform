// Delivery pin: the pure part (no network, no map). Coordinates, distances, the Google Maps links, what a pasted link means, and the text staff copy.
// The database builds the links it stores from the same rules (supabase/migrations/20261128130000_delivery_pin.sql); the checks here only decide what the
// customer is allowed to confirm and how it is shown. The server checks everything again.

export interface LatLng { lat: number; lng: number }
export type PinSource = 'search' | 'tap' | 'drag' | 'gps' | 'link' | 'saved';
export type GeoLang = 'th' | 'en';

/** The delivery area is Thailand (the same box the database uses). A pin outside it is a slip of the finger or a map that never loaded. */
export const AREA = { minLat: 5.5, maxLat: 20.6, minLng: 97.3, maxLng: 105.7 } as const;

export const validCoord = (p: Partial<LatLng> | null | undefined): p is LatLng =>
  !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
export const inArea = (p: LatLng): boolean => p.lat >= AREA.minLat && p.lat <= AREA.maxLat && p.lng >= AREA.minLng && p.lng <= AREA.maxLng;
/** Six decimals (about 10 cm) is what the database keeps. */
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
export const roundPin = (p: LatLng): LatLng => ({ lat: round6(p.lat), lng: round6(p.lng) });
const trim = (n: number): string => String(round6(n));          // 13.7 not 13.700000, the same as trim_scale() in the database
export const sameSpot = (a: LatLng | null | undefined, b: LatLng | null | undefined): boolean => !!a && !!b && round6(a.lat) === round6(b.lat) && round6(a.lng) === round6(b.lng);

/** Straight-line (great-circle) distance in metres. Never presented as a driving distance. */
export function straightMetres(a: LatLng, b: LatLng): number {
  const R = 6371008.8; const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

// ---------------------------------------------------------------- Google Maps links
/** Opens Google Maps on the destination. */
export const destinationUrl = (p: LatLng): string => `https://www.google.com/maps/search/?api=1&query=${trim(p.lat)},${trim(p.lng)}`;
/** Opens Google Maps with the route from the store to the destination already filled in. */
export const routeUrl = (from: LatLng, to: LatLng): string =>
  `https://www.google.com/maps/dir/?api=1&origin=${trim(from.lat)},${trim(from.lng)}&destination=${trim(to.lat)},${trim(to.lng)}&travelmode=driving`;
/** An order that has no pin (every order placed before pins existed): Google Maps can still search the written address. */
export const searchAddressUrl = (text: string): string => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text.replace(/\s+/g, ' ').trim().slice(0, 200))}`;
export const coordsText = (p: LatLng): string => `${trim(p.lat)}, ${trim(p.lng)}`;

// ---------------------------------------------------------------- showing numbers
export function fmtDistance(m: number, lang: GeoLang): string {
  if (!Number.isFinite(m) || m < 0) return '–';
  if (m < 1000) return `${Math.round(m / 10) * 10 || (m > 0 ? 10 : 0)} ${lang === 'th' ? 'ม.' : 'm'}`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : String(Math.round(km))} ${lang === 'th' ? 'กม.' : 'km'}`;
}
export function fmtDuration(s: number, lang: GeoLang): string {
  if (!Number.isFinite(s) || s <= 0) return '–';
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} ${lang === 'th' ? 'นาที' : 'min'}`;
  const h = Math.floor(min / 60); const r = min % 60;
  return lang === 'th' ? `${h} ชม.${r ? ` ${r} นาที` : ''}` : `${h} h${r ? ` ${r} min` : ''}`;
}

// ---------------------------------------------------------------- what the customer pastes
export type LinkReading = { ok: true; pin: LatLng } | { ok: false; reason: 'short' | 'none' | 'range' };
const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PAIRS: RegExp[] = [
  new RegExp(`@${NUM},\\s*${NUM}`),                                   // /maps/place/Name/@13.74,100.29,17z
  new RegExp(`!3d${NUM}!4d${NUM}`),                                   // data=!3d13.74!4d100.29
  new RegExp(`[?&](?:q|query|ll|destination|daddr|center)=\\+?${NUM}(?:,|%2C)\\+?\\s*${NUM}`, 'i'),
  new RegExp(`/(?:search|place|dir)/\\+?${NUM},\\+?\\s*${NUM}`),      // /maps/search/13.74,+100.29
];
/**
 * A place the customer found in Google Maps: a full link, or plain coordinates ("13.745952, 100.292734"). A short link (maps.app.goo.gl) cannot be opened from
 * the page, so it is reported as such and the customer is told to paste the full link or the coordinates.
 */
export function readMapsInput(raw: string): LinkReading {
  const text = (raw ?? '').trim().slice(0, 2000);
  if (!text) return { ok: false, reason: 'none' };
  let decoded = text; try { decoded = decodeURIComponent(text); } catch { /* keep as typed */ }
  let m: RegExpExecArray | null = new RegExp(`^${NUM}\\s*[,\\s]\\s*${NUM}$`).exec(text);
  for (const re of PAIRS) { if (m) break; m = re.exec(decoded) ?? re.exec(text); }
  if (!m) return { ok: false, reason: /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i.test(text) ? 'short' : 'none' };
  const pin = { lat: Number(m[1]), lng: Number(m[2]) };
  if (!validCoord(pin) || !inArea(pin)) return { ok: false, reason: 'range' };
  return { ok: true, pin: roundPin(pin) };
}

// ---------------------------------------------------------------- the address parts
export interface AddressParts {
  address_line: string; unit_no?: string | null; village?: string | null; floor_no?: string | null; landmark?: string | null; directions?: string | null; driver_note?: string | null;
}
const has = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim() !== '';
/** The address as one readable text (the order keeps the same text in `delivery_address`; the database builds it with the same rule). */
export function addressText(a: AddressParts, lang: GeoLang = 'th'): string {
  const unit = [has(a.unit_no) ? `${lang === 'th' ? 'เลขที่/ห้อง' : 'No./Unit'} ${a.unit_no.trim()}` : '', has(a.village) ? a.village.trim() : '', has(a.floor_no) ? `${lang === 'th' ? 'ชั้น' : 'Floor'} ${a.floor_no.trim()}` : ''].filter(Boolean).join(' · ');
  return [a.address_line.trim(), unit, has(a.landmark) ? `${lang === 'th' ? 'จุดสังเกต' : 'Landmark'}: ${a.landmark.trim()}` : ''].filter(Boolean).join('\n');
}

export interface DeliveryView extends AddressParts {
  recipient_name: string; recipient_phone: string; lat: number; lng: number; maps_url: string; directions_url: string; straight_m: number;
  route: { distance_m: number; duration_s: number } | null; origin?: { name: string };
}
/** What staff copy to paste into LINE MAN or any other delivery booking: everything a driver needs, in Thai. */
export function deliverySummary(d: DeliveryView, orderNo?: string): string {
  const lines: string[] = [];
  if (orderNo) lines.push(`ออเดอร์ ${orderNo}`);
  lines.push(`ผู้รับ: ${d.recipient_name} (${d.recipient_phone})`);
  lines.push(`ที่อยู่: ${addressText(d, 'th').replace(/\n/g, ' · ')}`);
  if (has(d.directions)) lines.push(`วิธีเดินทางเพิ่มเติม: ${d.directions.trim().replace(/\n/g, ' ')}`);
  if (has(d.driver_note)) lines.push(`คำแนะนำสำหรับคนส่ง: ${d.driver_note.trim().replace(/\n/g, ' ')}`);
  lines.push(`พิกัด: ${coordsText(d)}`);
  lines.push(d.route ? `ระยะทางขับรถ: ${fmtDistance(d.route.distance_m, 'th')} (ประมาณ ${fmtDuration(d.route.duration_s, 'th')}) · เส้นตรง ${fmtDistance(d.straight_m, 'th')}` : `ระยะทางเส้นตรง: ${fmtDistance(d.straight_m, 'th')}`);
  lines.push(`แผนที่: ${d.maps_url}`);
  lines.push(`เส้นทางจากร้าน${d.origin?.name ? ` (${d.origin.name})` : ''}: ${d.directions_url}`);
  return lines.join('\n');
}

/** A link from the database is only ever followed when it really is a Google Maps link (defence in depth: the database builds them, but a link is code the browser would run). */
export const safeMapsUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\/www\.google\.com\/maps\//.test(u) && u.length <= 600 ? u : null);
