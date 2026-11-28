// The map buttons of the LINE order card (migration 20261128140000 + line-dispatch): what a delivery order with a pin shows, what it never shows, and that the card builder
// reads the REAL card JSON the live database produced (tests/unit/fixtures/line-card-delivery.json, captured 2026-11-28 from line_card_data inside a rolled-back transaction).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapLink, orderCard, pinLine, type CardData } from '../../supabase/functions/_shared/lineCards';
import { handleDispatch, render, type DispatchDeps, type OutboxRow } from '../../supabase/functions/line-dispatch/handler';

const REAL = JSON.parse(readFileSync('tests/unit/fixtures/line-card-delivery.json', 'utf8')) as CardData;
const MAPS = 'https://www.google.com/maps/search/?api=1&query=13.77,100.33';
const ROUTE = 'https://www.google.com/maps/dir/?api=1&origin=13.745952,100.292734&destination=13.77,100.33&travelmode=driving';
const card = (over: Partial<CardData> = {}): CardData => ({ ...REAL, ...over });
const uris = (o: unknown) => [...JSON.stringify(o).matchAll(/"uri":"([^"]+)"/g)].map((m) => m[1]);
const json = (o: unknown) => JSON.stringify(o);

describe('the real card of a delivery order with a pin', () => {
  it('the fixture is what the database really sends: a delivery, with the pin and both links', () => {
    expect(REAL.fulfilment).toBe('delivery'); expect(REAL.delivery).toMatchObject({ maps_url: MAPS, directions_url: ROUTE, straight_m: 4832, route_m: 6200, route_s: 900 });
  });
  it('has the two map buttons that open the links in the phone\'s own browser', () => {
    const u = uris(orderCard(REAL));
    expect(u).toContain(`${MAPS}&openExternalBrowser=1`); expect(u).toContain(`${ROUTE}&openExternalBrowser=1`);
    expect(json(orderCard(REAL))).toContain('"label":"ดูแผนที่"'); expect(json(orderCard(REAL))).toContain('"label":"เส้นทางจากร้าน"');
  });
  it('says where and how far, and who receives it when that is not the customer', () => {
    const s = json(orderCard(REAL));
    expect(s).toContain('ปักหมุดแล้ว · ขับรถ 6.2 กม. (~15 นาที)');
    expect(s).toContain('Somchai Tester · 0891234567');                      // the customer is "Test Customer", so the recipient is named
  });
  it('keeps everything the card had before: the three action buttons, the old links, the item rows', () => {
    const s = json(orderCard(REAL));
    for (const part of ['รับออเดอร์', 'ปฏิเสธ', 'ดูรายละเอียด', 'โทรหาลูกค้า', 'tel:0812345678', '420.00', 'ยอดรวม']) expect(s).toContain(part);
    expect(uris(orderCard(REAL))).toContain('https://tomcraft-grp.github.io/bizops-platform/?openExternalBrowser=1#/shop-admin?order=' + REAL.order_id);
  });
  it('is still a valid, small Flex message (LINE accepts at most 50 KB) and the labels fit (20 characters)', () => {
    const o = orderCard(REAL); expect(json(o).length).toBeLessThan(8000);
    for (const m of JSON.stringify(o).matchAll(/"label":"([^"]+)"/g)) expect([...m[1]].length).toBeLessThanOrEqual(20);
  });
});

describe('when there is no pin there is no map', () => {
  it('a card without the key (a database that does not have the migration yet) is exactly the card it always was', () => {
    const { delivery: _d, ...old } = REAL; void _d;
    const a = json(orderCard(old as CardData)); const b = json(orderCard(card({ delivery: null })));
    expect(a).toBe(b);
    expect(uris(orderCard(old as CardData)).some((u) => u.includes('google.com'))).toBe(false); expect(a).not.toContain('ดูแผนที่'); expect(a).not.toContain('ปักหมุดแล้ว');
  });
  it('a pick-up order shows no map even if a pin were sent', () => {
    const s = json(orderCard(card({ fulfilment: 'pickup' }))); expect(s).not.toContain('ดูแผนที่'); expect(s).not.toContain('ปักหมุดแล้ว');
  });
  it('a link that is not a Google Maps link is never made a button (and an order with no usable link shows no pin line)', () => {
    const evil = { ...REAL.delivery!, maps_url: 'https://evil.example/maps/x', directions_url: 'javascript:alert(1)' };
    const s = json(orderCard(card({ delivery: evil })));
    expect(s).not.toContain('evil.example'); expect(s).not.toContain('javascript'); expect(s).not.toContain('ดูแผนที่'); expect(s).not.toContain('ปักหมุดแล้ว');
    const one = uris(orderCard(card({ delivery: { ...REAL.delivery!, directions_url: 'http://www.google.com/maps/dir/x' } })));
    expect(one).toContain(`${MAPS}&openExternalBrowser=1`); expect(one.some((u) => u.includes('dir/'))).toBe(false);
  });
  it('mapLink only accepts https Google Maps links, and adds the browser hint with the right separator', () => {
    expect(mapLink(MAPS)).toBe(`${MAPS}&openExternalBrowser=1`); expect(mapLink('https://www.google.com/maps/place/x')).toBe('https://www.google.com/maps/place/x?openExternalBrowser=1');
    for (const bad of ['http://www.google.com/maps/x', 'https://maps.google.com/x', 'https://www.google.com.evil.example/maps/x', 'https://www.google.com/search?q=maps', null, 7, `https://www.google.com/maps/${'x'.repeat(700)}`]) expect(mapLink(bad)).toBeNull();
  });
});

describe('the pin line and the recipient row', () => {
  const x = REAL.delivery!;
  it('uses the driving route when the order has one and only the straight line when it does not (never calling it a driving distance)', () => {
    expect(pinLine(x)).toBe('ปักหมุดแล้ว · ขับรถ 6.2 กม. (~15 นาที)');
    expect(pinLine({ ...x, route_m: null, route_s: null })).toBe('ปักหมุดแล้ว · เส้นตรง 4.8 กม.');
    expect(pinLine({ ...x, route_m: null, route_s: null, straight_m: 650 })).toBe('ปักหมุดแล้ว · เส้นตรง 650 ม.');
    expect(pinLine({ ...x, route_m: 15200, route_s: 1800 })).toBe('ปักหมุดแล้ว · ขับรถ 15 กม. (~30 นาที)');
    expect(pinLine({ ...x, route_m: null, route_s: null, straight_m: null })).toBe('ปักหมุดแล้ว');
  });
  it('no recipient row when the recipient is the customer (the same name and phone, phone typed any way)', () => {
    const same = card({ delivery: { ...x, recipient_name: ` ${REAL.customer_name} `, recipient_phone: '081-234 5678' } });
    expect(json(orderCard(same))).not.toContain('"text":"ผู้รับ"');
    expect(json(orderCard(REAL))).toContain('"text":"ผู้รับ"');
  });
});

describe('through line-dispatch', () => {
  const OKR = { ok: true, status: 200, requestId: 'r', error: null };
  it('the message pushed to the LINE group for a new pinned order carries the map buttons', async () => {
    const row: OutboxRow = { id: '66666666-7777-4888-9999-aaaaaaaaaaa1', event: 'order_new', target_type: 'group', target_id: 'Cgroup', attempts: 0, card: REAL, payload: {} };
    const pushes: unknown[][] = []; let claimed = false;
    const deps: DispatchDeps = {
      dispatchSecret: async () => 'dispatch-secret-0000000000000000000000000000000000', token: async () => 'TESTTOKEN-line-0123456789-abcdefghij',
      claim: async () => { if (claimed) return []; claimed = true; return [row]; }, complete: async () => undefined, push: async (_to, m) => { pushes.push(m); return OKR; },
      botInfo: async () => ({ ...OKR, name: 'x' }), isSuperAdmin: async () => false, secrets: () => [],
    };
    const res = await handleDispatch(new Request('https://x/functions/v1/line-dispatch', { method: 'POST', body: '{}', headers: { 'x-line-dispatch-secret': 'dispatch-secret-0000000000000000000000000000000000' } }), deps);
    expect(await res.json()).toEqual({ sent: 1, retried: 0, dead: 0 });
    expect(uris(pushes[0])).toContain(`${MAPS}&openExternalBrowser=1`);
    expect(render({ ...row, card: { ...REAL, delivery: null } }) ![0]).toBeTruthy();
  });
});
