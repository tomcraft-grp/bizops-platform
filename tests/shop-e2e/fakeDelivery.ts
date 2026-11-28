// The delivery-pin part of the fake backend. It mirrors the CONTRACT of supabase/migrations/20261128130000_delivery_pin.sql (the same refusal codes, the same links, the straight line, the plausible-route
// rule, the saved addresses with one default, the frozen snapshot per order), which is tested for real (against the live data, rolled back) by supabase/tests/delivery_pin.sql. It proves the SCREENS
// (checkout map, saved addresses, the back-office delivery card); it proves nothing about the database.
import type { FakeShop, FOrder } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';

export interface FDelivery {
  recipient_name: string; recipient_phone: string; address_line: string; unit_no: string | null; village: string | null; floor_no: string | null; landmark: string | null; directions: string | null; driver_note: string | null;
  place_label: string | null; lat: number; lng: number; pin_source: string; confirmed_at: string; origin: { name: string; lat: number; lng: number }; maps_url: string; directions_url: string; straight_m: number;
  route: { distance_m: number; duration_s: number; source: 'osrm'; at: string } | null;
}
export interface FAddress { id: string; label: string | null; recipient_name: string; recipient_phone: string; address_line: string; unit_no: string | null; village: string | null; floor_no: string | null; landmark: string | null;
  directions: string | null; driver_note: string | null; place_label: string | null; lat: number; lng: number; pin_source: string; confirmed_at: string; is_default: boolean; updated_at: string }

const t = (n: number) => String(Math.round(n * 1e6) / 1e6);
export const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${t(lat)},${t(lng)}`;
export const dirUrl = (o: { lat: number; lng: number }, lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&origin=${t(o.lat)},${t(o.lng)}&destination=${t(lat)},${t(lng)}&travelmode=driving`;
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371008.8; const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}
const clean = (v: unknown, max: number): string | null => { const s = String(v ?? '').replace(/[\u0001-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim(); if (s.length > max) throw new Error('INVALID_DETAILS'); return s || null; };

export class FakeDelivery {
  /** false (the default: every older spec) = a database WITHOUT the delivery-pin migration: no store in the public settings, no address functions, orders have no pin */
  enabled = false;
  required = true;
  store = { name: 'หมู่บ้านสิวารัตน์ 2', lat: 13.745952, lng: 100.292734, maps_url: 'https://maps.app.goo.gl/tT5NXeciaU2tuFyc9' as string | null };
  deliveries = new Map<string, FDelivery>();
  addresses: FAddress[] = [];
  private seq = 0;
  shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }
  private err(message: string): never { throw new Error(message); }

  publicSetting() { return this.enabled ? { delivery_pin_required: this.required, store: { name: this.store.name, lat: this.store.lat, lng: this.store.lng } } : {}; }
  adminSetting() { return this.enabled ? { delivery_pin_required: this.required, store_name: this.store.name, store_lat: this.store.lat, store_lng: this.store.lng, store_maps_url: this.store.maps_url } : {}; }
  /** keys of a settings patch that belong here are taken; the rest goes on to the ordinary settings */
  consume(patch: Record<string, unknown>): Record<string, unknown> {
    const rest = { ...patch };
    if ('delivery_pin_required' in rest) { this.required = Boolean(rest.delivery_pin_required); delete rest.delivery_pin_required; }
    if ('store_name' in rest) { const n = String(rest.store_name ?? '').trim(); if (!n || n.length > 100) this.err('INVALID_STORE'); this.store.name = n; delete rest.store_name; }
    for (const k of ['store_lat', 'store_lng'] as const) if (k in rest) {
      const v = Number(rest[k]); if (!Number.isFinite(v)) this.err('INVALID_STORE_LOCATION');
      const next = { lat: k === 'store_lat' ? v : this.store.lat, lng: k === 'store_lng' ? v : this.store.lng };
      if (next.lat < 5.5 || next.lat > 20.6 || next.lng < 97.3 || next.lng > 105.7) this.err('INVALID_STORE_LOCATION');
      this.store[k === 'store_lat' ? 'lat' : 'lng'] = v; delete rest[k];
    }
    if ('store_maps_url' in rest) { const u = String(rest.store_maps_url ?? '').trim() || null; if (u && !/^https:\/\//.test(u)) this.err('INVALID_STORE_URL'); this.store.maps_url = u; delete rest.store_maps_url; }
    return rest;
  }

  /** the checks shop_delivery_clean makes, in the same order; returns what the database would keep */
  private clean(p: Record<string, unknown>, needConfirm = true) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (typeof p.lat === 'string' && !/^-?\d{1,3}(\.\d{1,12})?$/.test(p.lat)) this.err('PIN_INVALID');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) this.err('PIN_INVALID');
    if (lat < 5.5 || lat > 20.6 || lng < 97.3 || lng > 105.7) this.err('PIN_OUTSIDE_AREA');
    if (needConfirm && p.confirmed !== true) this.err('PIN_NOT_CONFIRMED');
    if (!['search', 'tap', 'drag', 'gps', 'link', 'saved'].includes(String(p.pin_source))) this.err('PIN_INVALID');
    let name: string | null; let addr: string | null;
    try { name = clean(p.recipient_name, 100); } catch (e) { throw e; }
    const phone = String(p.recipient_phone ?? '').replace(/\D/g, '');
    if (!name || !/^0\d{8,9}$/.test(phone)) this.err('INVALID_RECIPIENT');
    addr = clean(p.address_line, 300); if (!addr || addr.length < 5) this.err('INVALID_ADDRESS');
    const r = p.route as { distance_m?: unknown; duration_s?: unknown; source?: unknown } | null | undefined;
    return {
      recipient_name: name, recipient_phone: phone, address_line: addr, unit_no: clean(p.unit_no, 60), village: clean(p.village, 100), floor_no: clean(p.floor_no, 20), landmark: clean(p.landmark, 120),
      directions: clean(p.directions, 300), driver_note: clean(p.driver_note, 300), place_label: clean(p.place_label, 200), lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
      pin_source: String(p.pin_source), address_id: typeof p.address_id === 'string' ? p.address_id : null, route: r && typeof r === 'object' ? { distance_m: Number(r.distance_m), duration_s: Number(r.duration_s), source: r.source } : null,
    };
  }
  private plausible(straight: number, r: { distance_m: number; duration_s: number; source?: unknown } | null): boolean {
    if (!r || r.source !== 'osrm' || !(r.distance_m >= 1) || !(r.duration_s >= 1)) return false;
    if (r.distance_m < Math.floor(straight * 0.9) || r.distance_m > straight * 8 + 3000) return false;
    const v = r.distance_m / r.duration_s; return v >= 0.8 && v <= 38;
  }
  /** a part of the place-order request hash: the pin without the measured route */
  hashPart(p: unknown): string { try { const c = this.clean(p as Record<string, unknown>); const { route: _r, ...rest } = c; void _r; return JSON.stringify(rest); } catch { return 'invalid'; } }

  /** before the order exists: what shop_place_order refuses */
  check(a: Record<string, unknown>) {
    if (!this.enabled) return;
    const has = a.p_delivery != null;
    if (has && a.p_fulfilment !== 'delivery') this.err('DELIVERY_PICKUP_CONFLICT');
    if (has) this.clean(a.p_delivery as Record<string, unknown>);
  }
  /** after the order exists: the delivery snapshot; returns the address text the order keeps */
  addressText(a: Record<string, unknown>): string | null {
    if (!this.enabled || a.p_delivery == null) return null;
    const c = this.clean(a.p_delivery as Record<string, unknown>);
    return [c.address_line, [c.unit_no ? `เลขที่/ห้อง ${c.unit_no}` : '', c.village ?? '', c.floor_no ? `ชั้น ${c.floor_no}` : ''].filter(Boolean).join(' · '), c.landmark ? `จุดสังเกต: ${c.landmark}` : ''].filter(Boolean).join('\n').slice(0, 400);
  }
  refuseUnpinned(a: Record<string, unknown>) { if (this.enabled && this.required && a.p_fulfilment === 'delivery' && a.p_delivery == null) this.err('DELIVERY_PIN_REQUIRED'); }
  attach(o: FOrder, a: Record<string, unknown>) {
    if (!this.enabled || a.p_delivery == null) return;
    const c = this.clean(a.p_delivery as Record<string, unknown>);
    const straight = haversine(this.store, c);
    const ok = this.plausible(straight, c.route as { distance_m: number; duration_s: number; source?: unknown } | null);
    this.deliveries.set(o.id, {
      recipient_name: c.recipient_name!, recipient_phone: c.recipient_phone, address_line: c.address_line!, unit_no: c.unit_no, village: c.village, floor_no: c.floor_no, landmark: c.landmark, directions: c.directions,
      driver_note: c.driver_note, place_label: c.place_label, lat: c.lat, lng: c.lng, pin_source: c.pin_source, confirmed_at: new Date().toISOString(), origin: { name: this.store.name, lat: this.store.lat, lng: this.store.lng },
      maps_url: mapsUrl(c.lat, c.lng), directions_url: dirUrl(this.store, c.lat, c.lng), straight_m: straight,
      route: ok ? { distance_m: Math.round(c.route!.distance_m), duration_s: Math.round(c.route!.duration_s), source: 'osrm', at: new Date().toISOString() } : null,
    });
  }
  orderExtra(o: FOrder) { return this.enabled ? { delivery: this.deliveries.get(o.id) ?? null } : {}; }

  rpc(fn: string, a: Record<string, unknown>): unknown {
    if (!fn.startsWith('shop_address_')) return NOT_HANDLED;
    if (!this.enabled) this.err(`Could not find the function public.${fn} in the schema cache`);
    switch (fn) {
      case 'shop_address_list': return [...this.addresses].sort((x, y) => Number(y.is_default) - Number(x.is_default) || y.updated_at.localeCompare(x.updated_at));
      case 'shop_address_save': {
        const c = this.clean(a.p_data as Record<string, unknown>); const label = clean(a.p_label, 40);
        const now = new Date().toISOString(); const wantDefault = a.p_default === true;
        const fields = { label, recipient_name: c.recipient_name!, recipient_phone: c.recipient_phone, address_line: c.address_line!, unit_no: c.unit_no, village: c.village, floor_no: c.floor_no, landmark: c.landmark,
          directions: c.directions, driver_note: c.driver_note, place_label: c.place_label, lat: c.lat, lng: c.lng, pin_source: c.pin_source };
        if (a.p_id == null) {
          if (this.addresses.length >= 10) this.err('ADDRESS_LIMIT');
          const mk = wantDefault || this.addresses.length === 0; if (mk) this.addresses.forEach((x) => { x.is_default = false; });
          const row: FAddress = { id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`, ...fields, confirmed_at: now, is_default: mk, updated_at: now }; this.addresses.push(row); return row;
        }
        const row = this.addresses.find((x) => x.id === a.p_id); if (!row) this.err('ADDRESS_NOT_FOUND');
        if (wantDefault) this.addresses.forEach((x) => { if (x !== row) x.is_default = false; });
        Object.assign(row, fields, { confirmed_at: now, updated_at: now, is_default: row.is_default || wantDefault }); return row;
      }
      case 'shop_address_set_default': { const row = this.addresses.find((x) => x.id === a.p_id); if (!row) this.err('ADDRESS_NOT_FOUND'); this.addresses.forEach((x) => { x.is_default = x === row; }); return row; }
      case 'shop_address_delete': {
        const i = this.addresses.findIndex((x) => x.id === a.p_id); if (i < 0) this.err('ADDRESS_NOT_FOUND');
        const [gone] = this.addresses.splice(i, 1);
        if (gone.is_default && this.addresses.length) [...this.addresses].sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0].is_default = true;
        return null;
      }
      default: return NOT_HANDLED;
    }
  }
}
