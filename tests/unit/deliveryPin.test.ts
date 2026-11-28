// The delivery pin, the part that needs no browser: distances, the Google Maps links, what a pasted link means, what the checkout asks for and sends, the saved-address helpers,
// and that every text has both languages. The database's own rules are proved against the real project by supabase/tests/delivery_pin.sql (117 checks).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  AREA, addressText, coordsText, deliverySummary, destinationUrl, fmtDistance, fmtDuration, inArea, readMapsInput, round6, routeUrl, safeMapsUrl, sameSpot, searchAddressUrl, straightMetres, validCoord,
} from '../../src/shop/geo/geo';
import { deliveryProblems, draftFromSaved, parseDeliveryDraft, pinOf, recipientOf, sameAsSaved, toDeliveryInput, type DeliveryDraft } from '../../src/shop/geo/deliveryDraft';
import { parseDraft } from '../../src/shop/checkoutDraft';
import { DELIVERY_CODES, DELIVERY_D } from '../../src/shop/i18n.delivery';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';
import { TH } from '../../src/lib/i18n';
import { TH_DELIVERY } from '../../src/lib/i18n.delivery';
import type { SavedAddress } from '../../src/shop/api';

const SHOP = { lat: 13.745952, lng: 100.292734 };
const PIN = { lat: 13.77, lng: 100.33 };
const THAI = /[ก-๿]/;
const ph = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join();

describe('distance and links (the same numbers and strings the database makes)', () => {
  it('the straight line from the shop to the test pin is what the database computes (4832 m)', () => { expect(straightMetres(SHOP, PIN)).toBe(4832); });
  it('is zero for the same place, symmetric, and a degree of latitude is 111.2 km', () => {
    expect(straightMetres(SHOP, SHOP)).toBe(0);
    expect(straightMetres(SHOP, PIN)).toBe(straightMetres(PIN, SHOP));
    expect(Math.abs(straightMetres({ lat: 13, lng: 100 }, { lat: 14, lng: 100 }) - 111195)).toBeLessThan(100);
  });
  it('builds the destination and the route links exactly like shop_maps_url / shop_maps_dir_url', () => {
    expect(destinationUrl(SHOP)).toBe('https://www.google.com/maps/search/?api=1&query=13.745952,100.292734');
    expect(destinationUrl(PIN)).toBe('https://www.google.com/maps/search/?api=1&query=13.77,100.33');
    expect(routeUrl(SHOP, PIN)).toBe('https://www.google.com/maps/dir/?api=1&origin=13.745952,100.292734&destination=13.77,100.33&travelmode=driving');
  });
  it('searches a written address when there is no pin', () => { expect(searchAddressUrl('12 Some Road,  Sam Phran')).toBe('https://www.google.com/maps/search/?api=1&query=12%20Some%20Road%2C%20Sam%20Phran'); });
  it('only follows Google Maps links', () => {
    expect(safeMapsUrl(destinationUrl(PIN))).toBe(destinationUrl(PIN));
    for (const bad of ['javascript:alert(1)', 'https://evil.example/maps/', 'http://www.google.com/maps/x', null, 7, 'https://www.google.com.evil.example/maps/']) expect(safeMapsUrl(bad)).toBeNull();
  });
  it('the delivery area is the box the database uses', () => {
    const sql = readFileSync('supabase/migrations/20261128130000_delivery_pin.sql', 'utf8');
    for (const n of [AREA.minLat, AREA.maxLat, AREA.minLng, AREA.maxLng]) expect(sql).toContain(String(n));
    expect(inArea(PIN)).toBe(true); expect(inArea({ lat: 0, lng: 0 })).toBe(false); expect(inArea({ lat: 35.68, lng: 139.69 })).toBe(false);
    expect(sql).toContain('13.745952'); expect(sql).toContain('100.292734'); expect(sql).toContain('https://maps.app.goo.gl/tT5NXeciaU2tuFyc9');
  });
  it('coordinates: valid, rounded to six decimals, compared at that precision', () => {
    expect(validCoord({ lat: 13.7, lng: 100.3 })).toBe(true);
    for (const p of [{ lat: NaN, lng: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 1 }, null, undefined]) expect(validCoord(p as never)).toBe(false);
    expect(round6(13.74595249)).toBe(13.745952);
    expect(sameSpot({ lat: 13.7700001, lng: 100.33 }, PIN)).toBe(true); expect(sameSpot(PIN, { lat: 13.771, lng: 100.33 })).toBe(false); expect(sameSpot(null, PIN)).toBe(false);
    expect(coordsText({ lat: 13.770000, lng: 100.330000 })).toBe('13.77, 100.33');
  });
});

describe('showing distance and time', () => {
  it('metres under a kilometre, kilometres above, in both languages', () => {
    expect(fmtDistance(650, 'th')).toBe('650 ม.'); expect(fmtDistance(650, 'en')).toBe('650 m');
    expect(fmtDistance(4832, 'th')).toBe('4.8 กม.'); expect(fmtDistance(15200, 'en')).toBe('15 km'); expect(fmtDistance(3, 'en')).toBe('10 m'); expect(fmtDistance(-1, 'en')).toBe('–');
  });
  it('minutes, then hours and minutes', () => {
    expect(fmtDuration(900, 'th')).toBe('15 นาที'); expect(fmtDuration(30, 'en')).toBe('1 min'); expect(fmtDuration(3900, 'en')).toBe('1 h 5 min'); expect(fmtDuration(7200, 'th')).toBe('2 ชม.'); expect(fmtDuration(0, 'en')).toBe('–');
  });
});

describe('what the customer pastes', () => {
  const pin = (s: string) => { const r = readMapsInput(s); return r.ok ? r.pin : r.reason; };
  it('reads the link the shop\'s own short link redirects to (the real store location)', () => {
    expect(pin('https://www.google.com/maps/search/13.745952,+100.292734?entry=tts&g_ep=EgoyMDI2MTEyMy4wIPu8ASoASAFQAw%3D%3D&skid=65b55696')).toEqual(SHOP);
  });
  it('reads the other shapes of a Google Maps link', () => {
    expect(pin('https://www.google.com/maps/place/Siwarat/@13.745952,100.292734,17z/data=!3m1!4b1')).toEqual(SHOP);
    expect(pin('https://www.google.com/maps/place/X/data=!3d13.745952!4d100.292734')).toEqual(SHOP);
    expect(pin('https://maps.google.com/?q=13.745952,100.292734')).toEqual(SHOP);
    expect(pin('https://maps.google.com/?ll=13.745952,100.292734&z=15')).toEqual(SHOP);
    expect(pin('https://www.google.com/maps/dir/?api=1&destination=13.745952%2C100.292734')).toEqual(SHOP);
  });
  it('reads plain coordinates', () => { expect(pin('13.745952, 100.292734')).toEqual(SHOP); expect(pin(' 13.745952 100.292734 ')).toEqual(SHOP); expect(pin('13.7459524,100.2927341')).toEqual(SHOP); });
  it('says why it cannot: a short link, nothing, or a place outside Thailand', () => {
    expect(pin('https://maps.app.goo.gl/tT5NXeciaU2tuFyc9')).toBe('short'); expect(pin('goo.gl/maps/abc')).toBe('short');
    expect(pin('')).toBe('none'); expect(pin('hello')).toBe('none'); expect(pin('13.7')).toBe('none');
    expect(pin('35.68, 139.69')).toBe('range'); expect(pin('100.29, 13.74')).toBe('range'); expect(pin('0, 0')).toBe('range');
  });
});

describe('the address and what staff copy', () => {
  const parts = { address_line: '99/9 Test Road, Sam Phran', unit_no: '12/3', village: 'Test Village', floor_no: '3', landmark: 'By the gate', directions: 'Enter by the main gate', driver_note: 'Call before arriving' };
  it('writes the address like the database does for the order (Thai)', () => {
    expect(addressText(parts)).toBe('99/9 Test Road, Sam Phran\nเลขที่/ห้อง 12/3 · Test Village · ชั้น 3\nจุดสังเกต: By the gate');
    expect(addressText({ address_line: '99/9 Test Road' })).toBe('99/9 Test Road');
    expect(addressText(parts, 'en')).toContain('No./Unit 12/3');
  });
  const view = { ...parts, recipient_name: 'Somchai', recipient_phone: '0891234567', ...PIN, maps_url: destinationUrl(PIN), directions_url: routeUrl(SHOP, PIN), straight_m: 4832, route: null, origin: { name: 'หมู่บ้านสิวารัตน์ 2' } };
  it('the copied details hold everything a driver needs', () => {
    const s = deliverySummary({ ...view, route: { distance_m: 6200, duration_s: 900 } }, 'SO-0001');
    for (const part of ['ออเดอร์ SO-0001', 'ผู้รับ: Somchai (0891234567)', '99/9 Test Road, Sam Phran · เลขที่/ห้อง 12/3 · Test Village · ชั้น 3 · จุดสังเกต: By the gate', 'วิธีเดินทางเพิ่มเติม: Enter by the main gate',
      'คำแนะนำสำหรับคนส่ง: Call before arriving', 'พิกัด: 13.77, 100.33', 'ระยะทางขับรถ: 6.2 กม. (ประมาณ 15 นาที) · เส้นตรง 4.8 กม.', 'แผนที่: https://www.google.com/maps/search/?api=1&query=13.77,100.33',
      'เส้นทางจากร้าน (หมู่บ้านสิวารัตน์ 2): https://www.google.com/maps/dir/?api=1&origin=13.745952,100.292734&destination=13.77,100.33&travelmode=driving']) expect(s).toContain(part);
  });
  it('without a driving route it says only the straight line (never calls it a driving distance)', () => {
    const s = deliverySummary(view);
    expect(s).toContain('ระยะทางเส้นตรง: 4.8 กม.'); expect(s).not.toContain('ระยะทางขับรถ'); expect(s).not.toContain('ออเดอร์');
  });
});

describe('the delivery form at checkout', () => {
  const contact = { name: 'Somchai', phone: '089-123 4567' };
  const full: DeliveryDraft = { lat: 13.77, lng: 100.33, confirmed: true, source: 'tap', addressLine: '99/9 Test Road, Sam Phran', landmark: ' By the gate ', driverNote: '' };
  it('asks for a pin, then its confirmation, an address and a recipient', () => {
    expect(deliveryProblems(undefined, contact)).toEqual(['pin', 'address']);
    expect(deliveryProblems({ ...full, confirmed: undefined }, contact)).toEqual(['confirm']);
    expect(deliveryProblems({ ...full, addressLine: 'abc' }, contact)).toEqual(['address']);
    expect(deliveryProblems(full, { name: '', phone: contact.phone })).toEqual(['recipient']);
    expect(deliveryProblems(full, { name: 'A', phone: '12345' })).toEqual(['recipient']);
    expect(deliveryProblems(full, contact)).toEqual([]);
  });
  it('the recipient is the contact unless the customer says it goes to somebody else', () => {
    expect(recipientOf(full, contact)).toEqual({ name: 'Somchai', phone: '089-123 4567' });
    expect(recipientOf({ ...full, other: true, rname: ' Mali ', rphone: '0812345678' }, contact)).toEqual({ name: 'Mali', phone: '0812345678' });
    expect(deliveryProblems({ ...full, other: true, rname: '', rphone: '0812345678' }, contact)).toEqual(['recipient']);
  });
  it('sends the confirmed pin with empty parts left out and the phone as digits', () => {
    expect(toDeliveryInput(full, contact)).toEqual({
      lat: 13.77, lng: 100.33, confirmed: true, pin_source: 'tap', recipient_name: 'Somchai', recipient_phone: '0891234567', address_line: '99/9 Test Road, Sam Phran',
      unit_no: undefined, village: undefined, floor_no: undefined, landmark: 'By the gate', directions: undefined, driver_note: undefined, place_label: undefined, address_id: undefined, route: null,
    });
  });
  it('never sends a pin that is not confirmed or an order that is not complete', () => {
    expect(toDeliveryInput({ ...full, confirmed: undefined }, contact)).toBeNull();
    expect(toDeliveryInput({ ...full, addressLine: '' }, contact)).toBeNull();
    expect(toDeliveryInput(undefined, contact)).toBeNull();
  });
  it('carries the measured route (rounded) only when it is real', () => {
    expect(toDeliveryInput(full, contact, { distance_m: 6200.4, duration_s: 899.6 })?.route).toEqual({ distance_m: 6200, duration_s: 900, source: 'osrm' });
    expect(toDeliveryInput(full, contact, { distance_m: 0, duration_s: 900 })?.route).toBeNull();
    expect(toDeliveryInput(full, contact, null)?.route).toBeNull();
  });
  it('the pin of a draft is read only when it is a real place', () => {
    expect(pinOf(full)).toEqual(PIN); expect(pinOf({})).toBeNull(); expect(pinOf(undefined)).toBeNull(); expect(pinOf({ lat: 13.7 })).toBeNull();
  });
});

describe('what sessionStorage holds is not trusted', () => {
  it('keeps a good draft and drops everything odd', () => {
    const d = parseDeliveryDraft({ lat: 13.77, lng: 100.33, confirmed: true, source: 'gps', addressLine: 'x'.repeat(500), other: true, rname: 'A', addressId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', evil: '<script>' });
    expect(d).toMatchObject({ lat: 13.77, lng: 100.33, confirmed: true, source: 'gps', other: true, rname: 'A', addressId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
    expect(d?.addressLine).toHaveLength(300); expect(d).not.toHaveProperty('evil');
  });
  it('a pin outside Thailand, a text where a number belongs, or a bad id is dropped (and the confirmation with it)', () => {
    expect(parseDeliveryDraft({ lat: 0, lng: 0, confirmed: true })).toBeUndefined();
    expect(parseDeliveryDraft({ lat: '13.7', lng: '100.3', confirmed: true })).toBeUndefined();
    expect(parseDeliveryDraft({ lat: 13.77, lng: 100.33, confirmed: 'yes', addressId: 'nope' })).toEqual({ lat: 13.77, lng: 100.33 });
    for (const bad of [null, 'x', 7, [], {}]) expect(parseDeliveryDraft(bad)).toBeUndefined();
  });
  it('the checkout draft carries it through a reload', () => {
    const raw = JSON.stringify({ name: 'A', delivery: { lat: 13.77, lng: 100.33, confirmed: true, addressLine: '99/9 Test Road' } });
    expect(parseDraft(raw).delivery).toEqual({ lat: 13.77, lng: 100.33, confirmed: true, addressLine: '99/9 Test Road' });
    expect(parseDraft(JSON.stringify({ name: 'A', delivery: 'junk' }))).not.toHaveProperty('delivery');
  });
});

describe('saved addresses', () => {
  const contact = { name: 'Somchai', phone: '0891234567' };
  const saved: SavedAddress = {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', label: 'Home', recipient_name: 'Somchai', recipient_phone: '0891234567', address_line: '99/9 Test Road', unit_no: '12/3', village: null, floor_no: null, landmark: null,
    directions: null, driver_note: 'Call before arriving', place_label: null, lat: 13.77, lng: 100.33, pin_source: 'tap', confirmed_at: '2026-11-28T00:00:00Z', is_default: true, updated_at: '2026-11-28T00:00:00Z',
  };
  it('choosing one confirms its pin and follows the contact when it is the same person', () => {
    const d = draftFromSaved(saved, contact);
    expect(d).toMatchObject({ lat: 13.77, lng: 100.33, confirmed: true, source: 'saved', addressId: saved.id, unit: '12/3', driverNote: 'Call before arriving' });
    expect(d.other).toBeUndefined(); expect(deliveryProblems(d, contact)).toEqual([]);
  });
  it('a different recipient is kept as that person', () => {
    const d = draftFromSaved({ ...saved, recipient_name: 'Mali', recipient_phone: '0812345678' }, contact);
    expect(d).toMatchObject({ other: true, rname: 'Mali', rphone: '0812345678' }); expect(recipientOf(d, contact)).toEqual({ name: 'Mali', phone: '0812345678' });
  });
  it('knows whether anything was changed since it was chosen', () => {
    const d = draftFromSaved(saved, contact);
    expect(sameAsSaved(d, saved, contact)).toBe(true);
    expect(sameAsSaved({ ...d, lat: 13.78 }, saved, contact)).toBe(false);
    expect(sameAsSaved({ ...d, addressLine: '1 Other Road' }, saved, contact)).toBe(false);
    expect(sameAsSaved({ ...d, driverNote: ' Call before arriving ' }, saved, contact)).toBe(true);
  });
});

describe('texts', () => {
  const keys = Object.keys(DELIVERY_D) as (keyof typeof DELIVERY_D)[];
  it('every customer text is in the shop dictionary with Thai and English and the same placeholders', () => {
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) { expect(SHOP_KEYS).toContain(k); expect(THAI.test(tr('th', k))).toBe(true); expect(tr('en', k).length).toBeGreaterThan(0); expect(THAI.test(tr('en', k))).toBe(false); expect(ph(DELIVERY_D[k][0])).toBe(ph(DELIVERY_D[k][1])); }
  });
  it('every refusal the database can send has a sentence', () => {
    for (const c of ['DELIVERY_PIN_REQUIRED', 'PIN_NOT_CONFIRMED', 'PIN_INVALID', 'PIN_OUTSIDE_AREA', 'INVALID_RECIPIENT', 'INVALID_DETAILS', 'ADDRESS_LIMIT', 'ADDRESS_NOT_FOUND', 'DELIVERY_PICKUP_CONFLICT']) {
      expect(DELIVERY_CODES.has(c)).toBe(true); expect(keys as string[]).toContain(`dl.err.${c}`);
    }
    // every code this migration RAISES that no earlier migration raised is one of the codes above (or the three staff-settings codes, or the frozen row)
    const mine = '20261128130000_delivery_pin.sql';
    const before = new Set(readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql') && x < mine).flatMap((x) => [...readFileSync(`supabase/migrations/${x}`, 'utf8').matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1])));
    const sql = readFileSync(`supabase/migrations/${mine}`, 'utf8');
    const fresh = [...new Set([...sql.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1]))].filter((c) => !before.has(c));
    expect(fresh.length).toBeGreaterThan(8);
    for (const c of fresh) expect(['DELIVERY_FROZEN', 'INVALID_STORE', 'INVALID_STORE_LOCATION', 'INVALID_STORE_URL', ...DELIVERY_CODES]).toContain(c);
  });
  it('every back-office text has Thai with the same placeholders', () => {
    for (const [en, th] of Object.entries(TH_DELIVERY)) { expect(THAI.test(th)).toBe(true); expect(ph(en)).toBe(ph(th)); }
  });
  it('every text of the back-office delivery card is translated', () => {
    const src = readFileSync('src/shop/geo/StaffDelivery.tsx', 'utf8');
    const used = new Set<string>();
    for (let i = 0; (i = src.indexOf('T(', i)) >= 0; i += 2) {
      if (i > 0 && /[A-Za-z0-9_$.]/.test(src[i - 1])) continue;
      let d = 0; let j = i + 2; let arg = '';
      for (; j < src.length; j++) { const c = src[j]; if (c === '(') d++; else if (c === ')') { if (d === 0) break; d--; } else if (c === ',' && d === 0) break; arg += c; }
      for (const m of arg.matchAll(/'((?:[^'\\]|\\.)*)'/g)) used.add(m[1].replace(/\\'/g, "'"));
    }
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((s) => !THAI.test(TH[s] ?? ''))).toEqual([]);
  });
});
