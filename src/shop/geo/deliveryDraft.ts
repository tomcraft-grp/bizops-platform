// Delivery pin: what the customer has filled in (kept in the checkout draft), what is still missing, and what is sent with the order. Pure functions, no screen.
import type { DeliveryInput, SavedAddress } from '../api';
import { digits, validPhone } from '../format';
import { inArea, LatLng, PinSource, round6, validCoord } from './geo';

/** One delivery address being filled in: at checkout (kept in the draft) or in "My delivery addresses". `confirmed` is the customer's own "yes, this place"; moving the pin takes it away. */
export interface DeliveryDraft {
  lat?: number; lng?: number; confirmed?: boolean; source?: PinSource; placeLabel?: string;
  addressLine?: string; unit?: string; village?: string; floor?: string; landmark?: string; directions?: string; driverNote?: string;
  /** deliver to somebody else: their own name and phone (otherwise the contact details are the recipient) */
  other?: boolean; rname?: string; rphone?: string;
  /** the saved address this started from */
  addressId?: string;
  /** after the order: keep it (a new saved address), or update the saved one it started from */
  saveIt?: boolean; saveLabel?: string; updateSaved?: boolean;
}
export interface Contact { name: string; phone: string }
export type DeliveryProblem = 'pin' | 'confirm' | 'address' | 'recipient';

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v !== '' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const SOURCES: PinSource[] = ['search', 'tap', 'drag', 'gps', 'link', 'saved'];

/** What sessionStorage holds is untrusted (an old build, hand-edited): anything odd is dropped. */
export function parseDeliveryDraft(o: unknown): DeliveryDraft | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  const pin = { lat: num(r.lat), lng: num(r.lng) };
  const ok = validCoord(pin) && inArea(pin);
  const d: DeliveryDraft = {
    lat: ok ? pin.lat : undefined, lng: ok ? pin.lng : undefined, confirmed: ok && r.confirmed === true ? true : undefined,
    source: ok && SOURCES.includes(r.source as PinSource) ? (r.source as PinSource) : undefined, placeLabel: text(r.placeLabel, 200),
    addressLine: text(r.addressLine, 300), unit: text(r.unit, 60), village: text(r.village, 100), floor: text(r.floor, 20), landmark: text(r.landmark, 120),
    directions: text(r.directions, 300), driverNote: text(r.driverNote, 300), other: r.other === true ? true : undefined, rname: text(r.rname, 100), rphone: text(r.rphone, 14),
    addressId: typeof r.addressId === 'string' && /^[0-9a-f-]{36}$/i.test(r.addressId) ? r.addressId : undefined,
    saveIt: typeof r.saveIt === 'boolean' ? r.saveIt : undefined, saveLabel: text(r.saveLabel, 40), updateSaved: r.updateSaved === true ? true : undefined,
  };
  const out = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as DeliveryDraft;
  return Object.keys(out).length ? out : undefined;
}

export const pinOf = (d: DeliveryDraft | undefined): LatLng | null => (d && validCoord({ lat: d.lat, lng: d.lng }) ? { lat: d.lat as number, lng: d.lng as number } : null);

/** The person the order goes to: the contact details unless the customer said it goes to somebody else. */
export const recipientOf = (d: DeliveryDraft | undefined, c: Contact): Contact =>
  d?.other ? { name: (d.rname ?? '').trim(), phone: d.rphone ?? '' } : { name: c.name.trim(), phone: c.phone };

/** What still stops the order: no pin, a pin that was not confirmed, no address, no valid recipient. */
export function deliveryProblems(d: DeliveryDraft | undefined, c: Contact): DeliveryProblem[] {
  const out: DeliveryProblem[] = [];
  const pin = pinOf(d);
  if (!pin) out.push('pin'); else if (!d?.confirmed) out.push('confirm');
  if ((d?.addressLine ?? '').trim().length < 5) out.push('address');
  const r = recipientOf(d, c);
  if (!r.name || r.name.length > 100 || !validPhone(r.phone)) out.push('recipient');
  return out;
}

const opt = (s: string | undefined): string | undefined => { const v = (s ?? '').trim(); return v === '' ? undefined : v; };

/** The delivery as the database expects it, or null while something is missing. The route is whatever the routing service measured (never invented). */
export function toDeliveryInput(d: DeliveryDraft | undefined, c: Contact, route?: { distance_m: number; duration_s: number } | null): DeliveryInput | null {
  const pin = pinOf(d);
  if (!d || !pin || !d.confirmed || deliveryProblems(d, c).length) return null;
  const r = recipientOf(d, c);
  return {
    lat: round6(pin.lat), lng: round6(pin.lng), confirmed: true, pin_source: d.source ?? 'tap', recipient_name: r.name, recipient_phone: digits(r.phone), address_line: (d.addressLine ?? '').trim(),
    unit_no: opt(d.unit), village: opt(d.village), floor_no: opt(d.floor), landmark: opt(d.landmark), directions: opt(d.directions), driver_note: opt(d.driverNote),
    place_label: opt(d.placeLabel), address_id: d.addressId, route: route && route.distance_m > 0 && route.duration_s > 0 ? { distance_m: Math.round(route.distance_m), duration_s: Math.round(route.duration_s), source: 'osrm' } : null,
  };
}

/** A saved address chosen for this order: the pin counts as confirmed (the customer confirmed it when saving and chooses it now). */
export function draftFromSaved(a: SavedAddress, c: Contact): DeliveryDraft {
  const same = a.recipient_name.trim() === c.name.trim() && digits(a.recipient_phone) === digits(c.phone);
  const d: DeliveryDraft = {
    lat: a.lat, lng: a.lng, confirmed: true, source: 'saved', placeLabel: a.place_label ?? undefined, addressLine: a.address_line, unit: a.unit_no ?? undefined, village: a.village ?? undefined,
    floor: a.floor_no ?? undefined, landmark: a.landmark ?? undefined, directions: a.directions ?? undefined, driverNote: a.driver_note ?? undefined, addressId: a.id,
    other: same ? undefined : true, rname: same ? undefined : a.recipient_name, rphone: same ? undefined : a.recipient_phone,
  };
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as DeliveryDraft;
}

/** The same place and details as the saved address (nothing to update)? */
export function sameAsSaved(d: DeliveryDraft | undefined, a: SavedAddress, c: Contact): boolean {
  const pin = pinOf(d); const r = recipientOf(d, c);
  const eq = (x: string | undefined, y: string | null) => (x ?? '').trim() === (y ?? '').trim();
  return !!d && !!pin && round6(pin.lat) === round6(a.lat) && round6(pin.lng) === round6(a.lng) && eq(d.addressLine, a.address_line) && eq(d.unit, a.unit_no) && eq(d.village, a.village)
    && eq(d.floor, a.floor_no) && eq(d.landmark, a.landmark) && eq(d.directions, a.directions) && eq(d.driverNote, a.driver_note) && r.name === a.recipient_name.trim() && digits(r.phone) === digits(a.recipient_phone);
}
