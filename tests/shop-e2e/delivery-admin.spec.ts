// Delivery pin, back office: the delivery card of an order (who, where, the driver's note, distance, a map, the four actions: open the place, open the route from the shop, copy the link,
// copy the details), what staff see for an order without a pin, the "Pinned" badge in the list, and the shop-location settings. Against the fake backend (fakeBackend.ts + fakeDelivery.ts) and test
// answers for the map services (mapMocks.ts): this proves the SCREENS; the rules are proved in the database by supabase/tests/delivery_pin.sql.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import { dirUrl, mapsUrl } from './fakeDelivery';
import { mockMaps, type MapMock } from './mapMocks';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const STORE = { lat: 13.745952, lng: 100.292734 };
let n = 0;

function shop(): FakeShop { const f = new FakeShop(); f.decorate(); f.settings.require_payment_slip = false; f.dl.enabled = true; f.profile.role = 'SUPER_ADMIN'; f.profile.display_name = 'Staff'; return f; }
const pin = (over: Record<string, unknown> = {}) => ({
  lat: 13.7702, lng: 100.3301, confirmed: true, pin_source: 'search', recipient_name: 'Somchai Receiver', recipient_phone: '0891234567', address_line: '99/9 Test Road, Sam Phran, Nakhon Pathom', unit_no: '12/3', village: 'Test Village',
  floor_no: '3', landmark: 'Opposite the 7-Eleven', directions: 'The entrance is behind the main building', driver_note: 'Call before arriving', place_label: 'Test place', route: { distance_m: 6200, duration_s: 900, source: 'osrm' }, ...over,
});
/** an order placed with a pin (straight in the fake), returns its order number */
function seedPinned(fake: FakeShop, over: Record<string, unknown> = {}): string {
  const r = fake.rpc('shop_place_order', { p_key: `adm-pin-${++n}-${Math.random().toString(36).slice(2, 8)}`, p_items: [{ sku_code: 'FG-000001', qty: 2 }], p_fulfilment: 'delivery', p_name: 'Somchai', p_phone: '0812345678', p_address: null, p_note: null, p_delivery: pin(over) }) as { order: { order_no: string } };
  return r.order.order_no;
}
/** an order from before pins: a typed address and nothing else */
function seedTyped(fake: FakeShop): string {
  const was = fake.dl.required; fake.dl.required = false;
  const r = fake.rpc('shop_place_order', { p_key: `adm-typed-${++n}-${Math.random().toString(36).slice(2, 8)}`, p_items: [{ sku_code: 'FG-000001', qty: 1 }], p_fulfilment: 'delivery', p_name: 'Somchai', p_phone: '0812345678', p_address: '12 Some Road, Sam Phran, Nakhon Pathom' }) as { order: { order_no: string } };
  fake.dl.required = was; return r.order.order_no;
}
async function openAdmin(page: Page, fake: FakeShop, lang: 'en' | 'th' = 'en'): Promise<MapMock> {
  const maps = await mockMaps(page);
  await fake.install(page);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/shop-admin');
  await expect(page.getByRole('heading', { name: lang === 'en' ? 'Online shop' : 'ร้านค้าออนไลน์' })).toBeVisible();
  return maps;
}
const drawer = (page: Page) => page.locator('aside.drawer');
const card = (page: Page) => drawer(page).getByTestId('staff-delivery');
async function openOrder(page: Page, no: string) { await page.getByRole('row', { name: new RegExp(no) }).click(); await expect(drawer(page)).toContainText(no); }
const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test.describe('the delivery card of an order', () => {
  test('shows who receives it, the address, the driver\'s note, the coordinates, the distance and a map, and the four actions with the right links', async ({ page }) => {
    const fake = shop(); const no = seedPinned(fake); await openAdmin(page, fake); await openOrder(page, no);
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByTestId('sd-recipient')).toContainText('Somchai Receiver'); await expect(card(page).getByTestId('sd-recipient')).toContainText('0891234567');
    await expect(card(page).getByTestId('sd-recipient').getByRole('link')).toHaveAttribute('href', 'tel:0891234567');
    await expect(card(page).getByTestId('sd-recipient')).toContainText('different from the customer');                          // the customer who ordered is Somchai; the recipient is another person
    await expect(card(page).getByTestId('sd-address')).toContainText('99/9 Test Road, Sam Phran, Nakhon Pathom'); await expect(card(page).getByTestId('sd-address')).toContainText('12/3 · Test Village · ชั้น 3');
    await expect(card(page).getByTestId('sd-address')).toContainText('Opposite the 7-Eleven'); await expect(card(page)).toContainText('The entrance is behind the main building');
    await expect(card(page).getByTestId('sd-driver-note')).toHaveText('Note for the driver: Call before arriving');
    await expect(card(page).getByTestId('sd-coords')).toHaveText('13.7702, 100.3301');
    const dist = card(page).getByTestId('sd-distance');
    await expect(dist).toContainText('From หมู่บ้านสิวารัตน์ 2'); await expect(dist).toContainText('Straight line 4.9 km (not the driving distance)');
    await expect(card(page).getByTestId('sd-driving')).toContainText('Driving 6.2 km, about 15 min'); await expect(card(page).getByTestId('sd-driving')).toContainText('worked out when the order was placed');
    await expect(card(page).getByTestId('staff-map')).toHaveClass(/leaflet-container/);
    const dest = card(page).getByTestId('sd-open-dest'); const route = card(page).getByTestId('sd-open-route');
    await expect(dest).toHaveAttribute('href', mapsUrl(13.7702, 100.3301)); await expect(route).toHaveAttribute('href', dirUrl(STORE, 13.7702, 100.3301));
    for (const a of [dest, route]) { await expect(a).toHaveAttribute('target', '_blank'); await expect(a).toHaveAttribute('rel', /noopener/); }
    await expect(dest).toContainText('Open destination in Google Maps'); await expect(route).toContainText('Open route from the store');
    // the customer's own contact stays above, the delivery card is the place to read the destination
    await expect(drawer(page)).toContainText('Somchai');
  });

  test('copy: the link, the destination link, the coordinates and every detail a driver needs (to paste into LINE MAN or another booking)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fake = shop(); const no = seedPinned(fake); await openAdmin(page, fake); await openOrder(page, no);
    await card(page).getByTestId('sd-copy-link').click(); await expect(page.locator('.toast').last()).toContainText('Copied');
    expect(await clip(page)).toBe(dirUrl(STORE, 13.7702, 100.3301));
    await card(page).getByTestId('sd-copy-dest').click(); expect(await clip(page)).toBe(mapsUrl(13.7702, 100.3301));
    await card(page).getByTestId('sd-copy-coords').click(); expect(await clip(page)).toBe('13.7702, 100.3301');
    await card(page).getByTestId('sd-copy-details').click();
    const text = await clip(page);
    for (const part of [`ออเดอร์ ${no}`, 'ผู้รับ: Somchai Receiver (0891234567)', '99/9 Test Road, Sam Phran, Nakhon Pathom · เลขที่/ห้อง 12/3 · Test Village · ชั้น 3 · จุดสังเกต: Opposite the 7-Eleven',
      'วิธีเดินทางเพิ่มเติม: The entrance is behind the main building', 'คำแนะนำสำหรับคนส่ง: Call before arriving', 'พิกัด: 13.7702, 100.3301', 'ระยะทางขับรถ: 6.2 กม. (ประมาณ 15 นาที) · เส้นตรง 4.9 กม.',
      `แผนที่: ${mapsUrl(13.7702, 100.3301)}`, `เส้นทางจากร้าน (หมู่บ้านสิวารัตน์ 2): ${dirUrl(STORE, 13.7702, 100.3301)}`]) expect(text).toContain(part);
  });

  test('when the browser refuses to copy, the text is shown to select and copy by hand', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
      document.execCommand = () => false;
    });
    const fake = shop(); const no = seedPinned(fake); await openAdmin(page, fake); await openOrder(page, no);
    await card(page).getByTestId('sd-copy-details').click();
    await expect(page.locator('.toast').last()).toContainText('Could not copy');
    await expect(card(page).getByTestId('sd-manual')).toHaveValue(new RegExp(`ออเดอร์ ${no}`)); await expect(card(page).getByTestId('sd-manual')).toHaveValue(/พิกัด: 13\.7702, 100\.3301/);
  });

  test('when the driving distance cannot be worked out the straight line is shown, honestly named, and every action still works', async ({ page }) => {
    const fake = shop(); const no = seedPinned(fake, { route: null }); const maps = await openAdmin(page, fake); maps.failRoute = true; await openOrder(page, no);
    await expect(card(page).getByTestId('sd-no-route')).toContainText('could not be worked out right now');
    await expect(card(page).getByTestId('sd-distance')).toContainText('Straight line 4.9 km (not the driving distance)'); await expect(card(page).getByTestId('sd-driving')).toHaveCount(0);
    await expect(card(page).getByTestId('sd-open-route')).toHaveAttribute('href', dirUrl(STORE, 13.7702, 100.3301));
    await expect(card(page).getByTestId('staff-map')).toHaveClass(/leaflet-container/);
  });

  test('an order placed without a route measures it now, says so, and keeps the time out of the stored order', async ({ page }) => {
    const fake = shop(); const no = seedPinned(fake, { route: null }); await openAdmin(page, fake); await openOrder(page, no);
    await expect(card(page).getByTestId('sd-driving')).toContainText('worked out just now');
    expect([...fake.dl.deliveries.values()][0].route).toBeNull();                                                                   // nothing is written by looking at an order
  });

  test('an order from before pins (a typed address) shows its address and a link that searches it in Google Maps', async ({ page }) => {
    const fake = shop(); const no = seedTyped(fake); await openAdmin(page, fake); await openOrder(page, no);
    await expect(drawer(page)).toContainText('12 Some Road, Sam Phran, Nakhon Pathom');
    await expect(card(page)).toHaveCount(0); await expect(drawer(page).getByTestId('staff-delivery-nopin')).toContainText('No map pin on this order');
    await expect(drawer(page).getByRole('link', { name: 'Search this address in Google Maps' })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=12%20Some%20Road%2C%20Sam%20Phran%2C%20Nakhon%20Pathom');
  });

  test('a pick-up order has no delivery card; the list marks the orders that have a pin', async ({ page }) => {
    const fake = shop(); const a = seedPinned(fake); const b = seedTyped(fake);
    const p = fake.rpc('shop_place_order', { p_key: `adm-pickup-${++n}-xxxxxx`, p_items: [{ sku_code: 'FG-000001', qty: 1 }], p_fulfilment: 'pickup', p_name: 'Somchai', p_phone: '0812345678', p_address: null }) as { order: { order_no: string } };
    await openAdmin(page, fake);
    await expect(page.getByRole('row', { name: new RegExp(a) })).toContainText('Pinned'); await expect(page.getByRole('row', { name: new RegExp(b) })).not.toContainText('Pinned');
    await expect(page.getByRole('row', { name: new RegExp(p.order.order_no) })).not.toContainText('Pinned');
    await openOrder(page, p.order.order_no); await expect(drawer(page).getByTestId('staff-delivery')).toHaveCount(0); await expect(drawer(page).getByTestId('staff-delivery-nopin')).toHaveCount(0);
  });

  test('in Thai: the card and the buttons speak Thai', async ({ page }) => {
    const fake = shop(); const no = seedPinned(fake); await openAdmin(page, fake, 'th'); await openOrder(page, no);
    await expect(card(page)).toContainText('จุดส่งสินค้า'); await expect(card(page)).toContainText('ลูกค้าปักหมุดแล้ว');
    await expect(card(page).getByTestId('sd-open-dest')).toContainText('เปิดปลายทางใน Google Maps'); await expect(card(page).getByTestId('sd-open-route')).toContainText('เปิดเส้นทางจากร้าน');
    await expect(card(page).getByTestId('sd-copy-link')).toContainText('คัดลอกลิงก์จัดส่ง'); await expect(card(page).getByTestId('sd-copy-details')).toContainText('คัดลอกรายละเอียดจัดส่ง');
    await expect(card(page).getByTestId('sd-distance')).toContainText('ระยะเส้นตรง 4.9 กม. (ไม่ใช่ระยะทางขับรถ)'); await expect(card(page).getByTestId('sd-driving')).toContainText('ขับรถ 6.2 กม. ประมาณ 15 นาที');
  });

  test('works on a phone: no sideways scrolling, the actions are reachable; and passes the accessibility checks', async ({ page }) => {
    const fake = shop(); const no = seedPinned(fake); await openAdmin(page, fake); await openOrder(page, no);
    // the delivery card itself (the drawer around it is shared with every other order screen)
    const ax = await new AxeBuilder({ page }).include('[data-testid="staff-delivery"]').analyze(); expect(ax.violations.map((v) => `${v.id}: ${v.nodes.map((nd) => nd.target.join(' ')).join(' | ')}`)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card(page).getByTestId('sd-open-dest')).toBeVisible(); await card(page).getByTestId('sd-copy-details').scrollIntoViewIfNeeded(); await noOverflow(page);
    const box = (await card(page).getByTestId('sd-copy-details').boundingBox())!; expect(box.width).toBeGreaterThan(120); expect(box.height).toBeGreaterThanOrEqual(30);
  });
});

test.describe('the delivery map settings', () => {
  const settings = async (page: Page, fake: FakeShop) => { await openAdmin(page, fake); await page.getByRole('tab', { name: 'Settings' }).click(); await expect(page.getByTestId('store-card')).toBeVisible(); };
  test('shows the shop\'s starting point (หมู่บ้านสิวารัตน์ 2) and the pin switch; a database without the migration shows no such card', async ({ page }) => {
    const fake = shop(); await settings(page, fake);
    await expect(page.getByTestId('store-name')).toHaveValue('หมู่บ้านสิวารัตน์ 2'); await expect(page.getByTestId('store-lat')).toHaveValue('13.745952'); await expect(page.getByTestId('store-lng')).toHaveValue('100.292734');
    await expect(page.getByTestId('store-url')).toHaveValue('https://maps.app.goo.gl/tT5NXeciaU2tuFyc9');
    await expect(page.getByRole('switch', { name: 'Delivery orders need a map pin' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('store-card').getByRole('link', { name: 'Check this place in Google Maps' })).toHaveAttribute('href', mapsUrl(13.745952, 100.292734));
  });
  test('an older database has no delivery map card', async ({ page }) => {
    const fake = shop(); fake.dl.enabled = false; await openAdmin(page, fake); await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByText('Before you open the shop')).toBeVisible(); await expect(page.getByTestId('store-card')).toHaveCount(0);
  });
  test('moving the starting point: paste a Google Maps link, save; new orders start there and earlier orders keep the old one', async ({ page }) => {
    const fake = shop(); const before = seedPinned(fake); await settings(page, fake);
    await page.getByTestId('store-paste').fill('https://maps.app.goo.gl/abc123'); await page.getByTestId('store-paste-use').click();
    await expect(page.getByTestId('store-card')).toContainText('A short link (maps.app.goo.gl) cannot be read here');
    await page.getByTestId('store-paste').fill('35.68, 139.69'); await page.getByTestId('store-paste-use').click(); await expect(page.getByTestId('store-card')).toContainText('This place is outside Thailand.');
    await page.getByTestId('store-paste').fill('https://www.google.com/maps/place/Shop/@13.7800,100.3500,17z'); await page.getByTestId('store-paste-use').click();
    await expect(page.getByTestId('store-lat')).toHaveValue('13.78'); await expect(page.getByTestId('store-lng')).toHaveValue('100.35');
    await page.getByTestId('store-name').fill('New shop'); await page.getByTestId('store-save').click();
    await expect(page.locator('.toast').last()).toContainText('The starting point was saved');
    expect(fake.dl.store).toMatchObject({ name: 'New shop', lat: 13.78, lng: 100.35 });
    const after = seedPinned(fake);
    const d = [...fake.dl.deliveries.values()];
    expect(d[0].origin).toMatchObject({ name: 'หมู่บ้านสิวารัตน์ 2', lat: 13.745952 }); expect(d[1].origin).toMatchObject({ name: 'New shop', lat: 13.78, lng: 100.35 });
    expect(d[1].directions_url).toBe(dirUrl({ lat: 13.78, lng: 100.35 }, 13.7702, 100.3301));
    await page.getByRole('tab', { name: 'Orders' }).click(); await openOrder(page, before);
    await expect(card(page).getByTestId('sd-distance')).toContainText('From หมู่บ้านสิวารัตน์ 2'); await expect(card(page).getByTestId('sd-open-route')).toHaveAttribute('href', dirUrl(STORE, 13.7702, 100.3301));
    void after;
  });
  test('a starting point the database refuses (outside Thailand) is shown as an error and nothing changes', async ({ page }) => {
    const fake = shop(); await settings(page, fake);
    await page.getByTestId('store-lat').fill('35.68'); await page.getByTestId('store-lng').fill('139.69'); await page.getByTestId('store-save').click();
    await expect(page.locator('.toast').last()).toContainText('must be a latitude and longitude inside Thailand');
    expect(fake.dl.store.lat).toBe(13.745952);
  });
  test('the switch lets customers order with a typed address only', async ({ page }) => {
    const fake = shop(); await settings(page, fake);
    await page.getByRole('switch', { name: 'Delivery orders need a map pin' }).click();
    await expect.poll(() => fake.dl.required).toBe(false);
    await expect(page.getByRole('switch', { name: 'Delivery orders need a map pin' })).toHaveAttribute('aria-checked', 'false');
  });
});
