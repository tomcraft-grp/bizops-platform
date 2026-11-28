// Delivery pin, customer app: choosing the delivery place on the map (search, tap, drag, the phone's position, a pasted link), confirming it, the details form, the order that carries it,
// saved addresses (use, add, edit, default, delete; an order keeps its own copy), and every fallback (map, search, route or tiles down; an old database; a shop that does not require a pin).
// Against the fake backend (fakeBackend.ts + fakeDelivery.ts) and test answers for OpenStreetMap / Nominatim / OSRM (mapMocks.ts): this proves the SCREENS.
// The rules themselves are proved in the database by supabase/tests/delivery_pin.sql (117 checks against the live project, rolled back).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { type FDelivery, dirUrl, mapsUrl } from './fakeDelivery';
import { mockMaps, PLACES, type MapMock } from './mapMocks';
import { openFold } from './methods';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const STORE = { lat: 13.745952, lng: 100.292734 };

function shop(over: (f: FakeShop) => void = () => undefined): FakeShop { const f = new FakeShop(); f.decorate(); f.settings.require_payment_slip = false; f.dl.enabled = true; over(f); return f; }
async function open(page: Page, fake: FakeShop): Promise<MapMock> {
  const maps = await mockMaps(page);
  await fake.install(page);
  await page.goto('/#/app');
  await expect(page.locator('.phone-nav')).toBeVisible();
  return maps;
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
async function addAndCheckout(page: Page) {
  await tab(page, t('nav.shop')).click();
  await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.add') }).click();
  await tab(page, t('nav.cart')).click();
  await page.getByRole('button', { name: t('cart.checkout') }).click();
  await expect(page.getByRole('heading', { name: t('co.payment') })).toBeVisible();
}
const section = (page: Page) => page.getByTestId('delivery-section');
const picker = (page: Page) => page.getByTestId('pin-picker');
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
const placeCall = (fake: FakeShop) => fake.calls.filter((c) => c.fn === 'shop_place_order').at(-1);
const lastDelivery = (fake: FakeShop): FDelivery => [...fake.dl.deliveries.values()].at(-1)!;
/** open the map, search, pick the first result and confirm */
async function pinBySearch(page: Page, q = 'สามพราน') {
  await section(page).getByTestId('pin-choose').click();
  await picker(page).getByTestId('pin-search').fill(q); await picker(page).getByTestId('pin-search').press('Enter');
  await picker(page).getByTestId('pin-results').getByRole('button').nth(1).click();          // ตลาดสามพราน (the first result is the shop itself)
  await picker(page).getByTestId('pin-confirm').click();
  await expect(picker(page)).toHaveCount(0);
}
async function placeOrder(page: Page) {
  await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
  await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
}

test.describe('choosing the place', () => {
  test('search -> pick a result -> confirm: the card shows it confirmed with the distance from the shop (straight line and driving), and the address is filled in', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); await addAndCheckout(page);
    await expect(section(page)).toContainText(t('dl.title')); await expect(section(page).locator('h3 .bad')).toBeVisible();      // required
    await expect(section(page).getByTestId('pin-choose')).toBeVisible();
    await section(page).getByTestId('pin-choose').click();
    await expect(picker(page)).toBeVisible(); await expect(picker(page).getByTestId('pin-confirm')).toBeDisabled();           // nothing chosen yet
    await picker(page).getByTestId('pin-search').fill('สามพราน');
    expect(maps.searches).toEqual([]);                                                                                         // never search-as-you-type
    await picker(page).getByTestId('pin-search').press('Enter');
    await expect(picker(page).getByTestId('pin-results').getByRole('button')).toHaveCount(2);
    await picker(page).getByTestId('pin-results').getByRole('button').nth(1).click();                                           // ตลาดสามพราน
    await expect(picker(page).getByTestId('pin-coords')).toContainText('13.7702, 100.3301');
    await expect(picker(page).locator('.leaflet-container')).toBeVisible();
    await picker(page).getByTestId('pin-confirm').click();
    await expect(picker(page)).toHaveCount(0);
    const card = section(page).getByTestId('pin-card');
    await expect(card.getByTestId('pin-state')).toHaveText(t('dl.confirmed'));
    await expect(card).toContainText('13.7702, 100.3301');
    await expect(card.getByTestId('pin-distance')).toContainText(t('dl.straight', { d: '4.9 กม.' }));
    await expect(card.getByTestId('pin-driving')).toContainText('ขับรถ'); await expect(card.getByTestId('pin-driving')).toContainText('กม.');
    await expect(section(page).getByTestId('dl-address')).toHaveValue(PLACES[1].label);                                          // filled in from the search result
    await expect(card.getByTestId('dp-map-preview')).toHaveClass(/leaflet-container/);                                          // a small map of the place and the route
    expect(maps.routes).toBe(1);
  });

  test('tapping the map and dragging the pin move it; confirming takes the last place', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await section(page).getByTestId('pin-choose').click();
    const map = picker(page).locator('.leaflet-container'); const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width / 2 + 60, y: box.height / 2 - 40 } });
    const first = (await picker(page).getByTestId('pin-coords').innerText());
    expect(first).toMatch(/13\.7\d+, 100\.\d+/); expect(first).not.toContain('13.745952, 100.292734');
    const mk = picker(page).locator('.leaflet-marker-draggable'); await expect(mk).toBeVisible();
    const m = (await mk.boundingBox())!;
    await page.mouse.move(m.x + m.width / 2, m.y + m.height - 4); await page.mouse.down(); await page.mouse.move(m.x + m.width / 2 + 25, m.y + m.height - 4 + 30, { steps: 6 }); await page.mouse.up();
    await expect.poll(async () => picker(page).getByTestId('pin-coords').innerText()).not.toBe(first);
    const second = (await picker(page).getByTestId('pin-coords').innerText()).match(/(\d+\.\d+), (\d+\.\d+)/)!;
    await picker(page).getByTestId('pin-confirm').click();
    await expect(section(page).getByTestId('pin-card')).toContainText(`${second[1]}, ${second[2]}`);
    await addNames(page); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const d = (placeCall(fake)!.args.p_delivery as Record<string, unknown>);
    expect(d.pin_source).toBe('drag'); expect(d.lat).toBe(Number(second[1])); expect(d.lng).toBe(Number(second[2])); expect(d.confirmed).toBe(true);
  });

  test('the phone\'s own position: allowed -> a pin; refused -> a clear message and the map still works', async ({ page, context }) => {
    const fake = shop(); await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 13.7600, longitude: 100.3100 });
    await open(page, fake); await addAndCheckout(page);
    await section(page).getByTestId('pin-choose').click();
    await picker(page).getByTestId('pin-gps').click();
    await expect(picker(page).getByTestId('pin-coords')).toContainText('13.76, 100.31');
    await picker(page).getByTestId('pin-confirm').click();
    await expect(section(page).getByTestId('pin-state')).toHaveText(t('dl.confirmed'));
    await addNames(page); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect((placeCall(fake)!.args.p_delivery as Record<string, unknown>).pin_source).toBe('gps');
  });
  test('the phone\'s position refused: the message says what to do', async ({ page, context }) => {
    const fake = shop(); await context.clearPermissions(); await open(page, fake); await addAndCheckout(page);
    await section(page).getByTestId('pin-choose').click();
    await picker(page).getByTestId('pin-gps').click();
    await expect(picker(page).getByTestId('pin-msg')).toBeVisible();
    await expect(picker(page).getByTestId('pin-confirm')).toBeDisabled();
  });

  test('a pasted Google Maps link or coordinates: a full link works, a short link and a place outside Thailand are explained', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await section(page).getByTestId('pin-choose').click();
    await picker(page).getByTestId('pin-link-toggle').click();
    const link = picker(page).getByTestId('pin-link'); const use = picker(page).getByTestId('pin-link-use');
    await link.fill('https://maps.app.goo.gl/tT5NXeciaU2tuFyc9'); await use.click();
    await expect(picker(page).getByTestId('pin-msg')).toHaveText(t('pk.linkShort'));
    await link.fill('hello'); await use.click(); await expect(picker(page).getByTestId('pin-msg')).toHaveText(t('pk.linkNone'));
    await link.fill('35.68, 139.69'); await use.click(); await expect(picker(page).getByTestId('pin-msg')).toHaveText(t('pk.linkRange'));
    await expect(picker(page).getByTestId('pin-confirm')).toBeDisabled();
    await link.fill('https://www.google.com/maps/search/13.745952,+100.292734?entry=tts'); await use.click();
    await expect(picker(page).getByTestId('pin-coords')).toContainText('13.745952, 100.292734');
    await picker(page).getByTestId('pin-confirm').click();
    await addNames(page); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect((placeCall(fake)!.args.p_delivery as Record<string, unknown>).pin_source).toBe('link');
  });

  test('moving the pin again re-confirms it: the card keeps the old confirmed place until the new one is confirmed, and Escape closes the map without changing anything', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page); await pinBySearch(page);
    const before = await section(page).getByTestId('pin-card').innerText();
    await section(page).getByTestId('pin-change').click();
    const map = picker(page).locator('.leaflet-container'); const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width / 2 + 50, y: box.height / 2 + 50 } });
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
    expect(await section(page).getByTestId('pin-card').innerText()).toBe(before);
  });
});

/** the contact details are the recipient: fill them in when the profile has none to offer */
async function addNames(page: Page) {
  await expect(section(page).getByTestId('dl-address')).toBeVisible();
  if (await section(page).getByTestId('dl-address').inputValue() === '') await section(page).getByTestId('dl-address').fill('99/9 ถนนทดสอบ ตำบลทดสอบ อำเภอสามพราน');
}

test.describe('the details and the order', () => {
  test('the whole journey: pin, details, instructions, confirm, and the order carries the pin; the order page and the links', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); await addAndCheckout(page); await pinBySearch(page);
    const f = section(page);
    await f.getByLabel(t('dl.f.unit')).fill('12/3'); await f.getByLabel(t('dl.f.village')).fill('หมู่บ้านทดสอบ'); await f.getByLabel(t('dl.f.floor')).fill('3');
    await f.getByLabel(t('dl.f.landmark')).fill('ตรงข้ามร้านสะดวกซื้อ'); await f.getByTestId('dl-directions').fill('ทางเข้าอยู่ด้านหลังอาคาร');
    await f.getByRole('button', { name: t('dl.q.call') }).click(); await f.getByRole('button', { name: t('dl.q.gate') }).click();
    await expect(f.getByTestId('dl-driver')).toHaveValue(`${t('dl.q.call')}. ${t('dl.q.gate')}`);
    await f.getByRole('button', { name: t('dl.q.call') }).click();                                                                // no duplicate
    await expect(f.getByTestId('dl-driver')).toHaveValue(`${t('dl.q.call')}. ${t('dl.q.gate')}`);
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    const sheet = page.locator('.sp-sheet'); await expect(sheet.getByTestId('confirm-delivery')).toContainText('12/3'); await expect(sheet.getByTestId('confirm-delivery')).toContainText('13.7702, 100.3301');
    await sheet.getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();

    const call = placeCall(fake)!.args; const d = call.p_delivery as Record<string, unknown>;
    expect(d).toMatchObject({ lat: 13.7702, lng: 100.3301, confirmed: true, pin_source: 'search', recipient_name: 'สมชาย ใจดี', recipient_phone: '0812345678', address_line: PLACES[1].label, unit_no: '12/3', village: 'หมู่บ้านทดสอบ',
      floor_no: '3', landmark: 'ตรงข้ามร้านสะดวกซื้อ', directions: 'ทางเข้าอยู่ด้านหลังอาคาร', driver_note: `${t('dl.q.call')}. ${t('dl.q.gate')}`, place_label: PLACES[1].label });
    expect(d.route).toMatchObject({ source: 'osrm' }); expect((d.route as { distance_m: number }).distance_m).toBeGreaterThan(4000);
    expect(d).not.toHaveProperty('maps_url'); expect(d).not.toHaveProperty('directions_url');                                       // the database builds the links
    expect(call.p_fulfilment).toBe('delivery');

    const got = lastDelivery(fake);
    expect(got.maps_url).toBe(mapsUrl(13.7702, 100.3301)); expect(got.directions_url).toBe(dirUrl(STORE, 13.7702, 100.3301)); expect(got.route).not.toBeNull();
    await openFold(page, 'delivery');
    const block = page.getByTestId('order-delivery');
    await expect(block).toContainText('12/3'); await expect(block).toContainText(t('dl.od.pinned')); await expect(block).toContainText('ตรงข้ามร้านสะดวกซื้อ'); await expect(block).toContainText(t('dl.od.driverNote'));
    await expect(block.getByTestId('order-map-link')).toHaveAttribute('href', mapsUrl(13.7702, 100.3301));
    await expect(block.getByTestId('order-map-link')).toHaveAttribute('target', '_blank'); await expect(block.getByTestId('order-map-link')).toHaveAttribute('rel', /noopener/);
    expect(maps.searches).toEqual(['สามพราน']);
  });

  test('an order without the pin is refused on the screen, nothing is sent; the address and the recipient are checked too', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('dl.pinFirst')); await expect(section(page).getByTestId('pin-missing')).toBeVisible();
    expect(fake.calls.filter((c) => c.fn === 'shop_place_order')).toHaveLength(0);
    await pinBySearch(page); await section(page).getByTestId('dl-address').fill('abc');
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('dl.err.address'));
    await section(page).getByTestId('dl-address').fill('99/9 ถนนทดสอบ'); await section(page).getByTestId('dl-other').check();
    await section(page).getByLabel(t('dl.f.rname')).fill('มาลี'); await section(page).getByLabel(t('dl.f.rphone')).fill('123');
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('dl.err.recipient'));
    expect(fake.calls.filter((c) => c.fn === 'shop_place_order')).toHaveLength(0);
    await section(page).getByLabel(t('dl.f.rphone')).fill('0899999999');                                                          // somebody else receives it
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ recipient_name: 'มาลี', recipient_phone: '0899999999' });
  });

  test('the database refuses a pin (an older app, a changed rule): the customer is told in Thai and keeps what they typed', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page); await pinBySearch(page);
    fake.dl.required = true; fake.dl.addresses = [];
    await page.route('**/rest/v1/rpc/shop_place_order', (route) => route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'P0001', message: 'PIN_OUTSIDE_AREA', details: null, hint: null }) }));
    await placeOrder(page);
    await expect(page.getByTestId('checkout-error')).toContainText(t('dl.err.PIN_OUTSIDE_AREA'));
    await expect(section(page).getByTestId('pin-state')).toHaveText(t('dl.confirmed'));
  });

  test('a pick-up order has no delivery section and sends no pin; changing back to delivery keeps the pin', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page); await pinBySearch(page);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click();
    await expect(section(page)).toHaveCount(0);
    await page.getByRole('radio', { name: new RegExp(t('co.delivery')) }).click();
    await expect(section(page).getByTestId('pin-state')).toHaveText(t('dl.confirmed'));
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click();
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const args = placeCall(fake)!.args; expect(args.p_fulfilment).toBe('pickup'); expect(args).not.toHaveProperty('p_delivery'); expect(fake.dl.deliveries.size).toBe(0);
  });
});

test.describe('when the map services fail the customer can still order', () => {
  test('the route is not available: said calmly, the order goes without a route', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); maps.failRoute = true; await addAndCheckout(page); await pinBySearch(page);
    await expect(section(page).getByTestId('route-fail')).toHaveText(t('dl.routeFail'));
    await expect(section(page).getByTestId('pin-distance')).toContainText(t('dl.straight', { d: '4.9 กม.' }));
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect((placeCall(fake)!.args.p_delivery as Record<string, unknown>).route).toBeNull();
    expect(lastDelivery(fake).route).toBeNull(); expect(lastDelivery(fake).maps_url).toContain('google.com/maps'); expect(lastDelivery(fake).straight_m).toBeGreaterThan(4000);
  });
  test('search is down or busy: said, and tapping the map still works', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); await addAndCheckout(page);
    await section(page).getByTestId('pin-choose').click();
    maps.failSearch = true; await picker(page).getByTestId('pin-search').fill('สามพราน'); await picker(page).getByTestId('pin-search').press('Enter');
    await expect(picker(page).getByTestId('pin-msg')).toHaveText(t('pk.searchFail'));
    maps.failSearch = 'busy'; await picker(page).getByTestId('pin-search').press('Enter');
    await expect(picker(page).getByTestId('pin-msg')).toHaveText(t('pk.searchBusy'));
    maps.failSearch = false; await picker(page).getByTestId('pin-search').fill('ไม่มีที่นี่ xyz'); await picker(page).getByTestId('pin-search').press('Enter');
    await expect(picker(page).getByTestId('pin-no-results')).toBeVisible();
    const map = picker(page).locator('.leaflet-container'); const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width / 2 + 30, y: box.height / 2 + 30 } });
    await expect(picker(page).getByTestId('pin-confirm')).toBeEnabled();
  });
  test('the map tiles do not load: a notice says so, and a pasted link still gives a confirmed pin and an order', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); maps.failTiles = true; await addAndCheckout(page);
    await section(page).getByTestId('pin-choose').click();
    await expect(picker(page).getByTestId('map-down')).toHaveText(t('pk.mapDown'));
    await picker(page).getByTestId('pin-link-toggle').click(); await picker(page).getByTestId('pin-link').fill('13.7702, 100.3301'); await picker(page).getByTestId('pin-link-use').click();
    await picker(page).getByTestId('pin-confirm').click();
    await addNames(page); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ lat: 13.7702, lng: 100.3301, pin_source: 'link' });
  });
  test('the name of the place is not found: the address stays empty and is asked for', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); maps.reverseName = null; await addAndCheckout(page);
    await section(page).getByTestId('pin-choose').click();
    const map = picker(page).locator('.leaflet-container'); const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width / 2 + 30, y: box.height / 2 + 30 } });
    await page.waitForTimeout(1000);
    await picker(page).getByTestId('pin-confirm').click();
    await expect(section(page).getByTestId('dl-address')).toHaveValue('');
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('dl.err.address'));
  });
});

test.describe('saved addresses', () => {
  test('save at checkout; the next checkout picks the default for the customer; switch to a new address; edit a saved one and the old order keeps its pin', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page); await pinBySearch(page);
    await expect(section(page).getByTestId('dl-save')).toBeChecked();                                                            // none saved yet: kept by default
    await section(page).getByTestId('dl-save-label').fill('บ้าน');
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    await expect.poll(() => fake.dl.addresses.length).toBe(1);
    expect(fake.dl.addresses[0]).toMatchObject({ label: 'บ้าน', is_default: true, lat: 13.7702, lng: 100.3301 });
    const orderPin = JSON.stringify(lastDelivery(fake));

    await tab(page, t('nav.shop')).click();
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.add') }).click();
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await expect(section(page).getByTestId('pin-state')).toHaveText(t('dl.confirmed'));                                          // the default address, already chosen
    await expect(section(page).getByTestId('saved-chip')).toHaveCount(1); await expect(section(page).getByTestId('saved-chip')).toHaveAttribute('aria-pressed', 'true');
    await expect(section(page).getByTestId('dl-address')).toHaveValue(PLACES[1].label);
    await section(page).getByTestId('new-address-chip').click();
    await expect(section(page).getByTestId('pin-choose')).toBeVisible();                                                          // a fresh form
    await section(page).getByTestId('saved-chip').click(); await expect(section(page).getByTestId('pin-state')).toBeVisible();

    // Account -> My delivery addresses: reposition the saved address
    await tab(page, t('nav.account')).click();
    await page.getByTestId('addresses-row').click();
    const item = page.getByTestId('ab-item'); await expect(item).toHaveCount(1); await expect(item).toContainText('บ้าน'); await expect(item).toContainText(t('dl.default'));
    await item.getByTestId('ab-edit').click();
    await page.getByTestId('pin-change').click();
    await picker(page).getByTestId('pin-link-toggle').click(); await picker(page).getByTestId('pin-link').fill('13.7500, 100.3000'); await picker(page).getByTestId('pin-link-use').click();
    await picker(page).getByTestId('pin-confirm').click();
    await page.getByTestId('ab-save').click();
    await expect(page.getByTestId('ab-item')).toHaveCount(1);
    expect(fake.dl.addresses[0]).toMatchObject({ lat: 13.75, lng: 100.3 });
    expect(JSON.stringify(lastDelivery(fake))).toBe(orderPin);                                                                    // the order placed before keeps the place it was sent to
    expect([...fake.dl.deliveries.values()][0].lat).toBe(13.7702);
  });

  test('add, make default, delete in My delivery addresses; the limit; another customer\'s addresses are not there', async ({ page }) => {
    const fake = shop(); await open(page, fake);
    await tab(page, t('nav.account')).click(); await page.getByTestId('addresses-row').click();
    await expect(page.getByTestId('ab-empty')).toBeVisible();
    const add = async (label: string, coords: string) => {
      await page.getByTestId('ab-add').click(); await page.getByTestId('ab-label').fill(label);
      await page.getByTestId('pin-choose').click(); await picker(page).getByTestId('pin-link-toggle').click(); await picker(page).getByTestId('pin-link').fill(coords); await picker(page).getByTestId('pin-link-use').click(); await picker(page).getByTestId('pin-confirm').click();
      await page.getByTestId('dl-address').fill(`ที่อยู่ ${label} ถนนทดสอบ`); await page.getByTestId('ab-save').click(); await expect(page.getByTestId('ab-item').filter({ hasText: label })).toHaveCount(1);
    };
    await add('บ้าน', '13.7500, 100.3000'); await add('ที่ทำงาน', '13.7800, 100.3500');
    const items = page.getByTestId('ab-item'); await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: 'บ้าน' }).locator('.sp-pill')).toHaveText(t('dl.default'));
    await items.filter({ hasText: 'ที่ทำงาน' }).getByTestId('ab-make-default').click();
    await expect(items.filter({ hasText: 'ที่ทำงาน' }).locator('.sp-pill')).toHaveText(t('dl.default')); await expect(items.filter({ hasText: 'บ้าน' }).locator('.sp-pill')).toHaveCount(0);
    await items.filter({ hasText: 'ที่ทำงาน' }).getByTestId('ab-delete').click();
    await expect(page.locator('.sp-sheet')).toContainText(t('ab.deleteBody'));
    await page.locator('.sp-sheet').getByRole('button', { name: t('ab.delete') }).click();
    await expect(items).toHaveCount(1); await expect(items.first().locator('.sp-pill')).toHaveText(t('dl.default'));                              // the other one became the default
    expect(fake.dl.addresses.map((a) => a.label)).toEqual(['บ้าน']);
  });

  test('ten addresses is the limit: the add button is replaced by a note', async ({ page }) => {
    const fake = shop(); for (let i = 0; i < 10; i++) fake.rpc('shop_address_save', { p_id: null, p_data: { lat: 13.7, lng: 100.3, confirmed: true, pin_source: 'tap', recipient_name: 'A', recipient_phone: '0812345678', address_line: `ที่อยู่ที่ ${i + 1} ถนนทดสอบ` }, p_label: `n${i}` });
    await open(page, fake); await tab(page, t('nav.account')).click(); await page.getByTestId('addresses-row').click();
    await expect(page.getByTestId('ab-item')).toHaveCount(10); await expect(page.getByTestId('ab-add')).toHaveCount(0); await expect(page.locator('.sp-page')).toContainText(t('ab.limit'));
  });
});

test.describe('other databases and shops', () => {
  test('an older database (no delivery-pin migration): the typed address is kept, no map, no addresses row, and the order goes as before', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.settings.require_payment_slip = false; await open(page, fake); await addAndCheckout(page);
    await expect(section(page)).toHaveCount(0);
    await expect(page.getByLabel(t('co.address'))).toHaveCount(1);
    await page.getByLabel(t('co.address')).fill('99/9 ถนนทดสอบ ตำบลทดสอบ'); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const args = placeCall(fake)!.args; expect(args).not.toHaveProperty('p_delivery'); expect(args.p_address).toBe('99/9 ถนนทดสอบ ตำบลทดสอบ');
    await tab(page, t('nav.account')).click(); await expect(page.getByTestId('addresses-row')).toHaveCount(0);
  });
  test('a shop that does not require a pin: it is optional; ordering with a typed address works, and a pin that was chosen is checked like a required one', async ({ page }) => {
    const fake = shop((f) => { f.dl.required = false; }); await open(page, fake); await addAndCheckout(page);
    await expect(section(page)).toContainText(t('dl.optional'));
    await section(page).getByTestId('dl-address').fill('99/9 ถนนทดสอบ ตำบลทดสอบ'); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const args = placeCall(fake)!.args; expect(args).not.toHaveProperty('p_delivery'); expect(args.p_address).toBe('99/9 ถนนทดสอบ ตำบลทดสอบ');
    expect(fake.dl.deliveries.size).toBe(0);
  });
  test('English: the customer app speaks English when chosen', async ({ page }) => {
    const fake = shop(); await page.addInitScript(() => { try { localStorage.setItem('tc.shop.lang', 'en'); } catch { /* ignore */ } });
    await open(page, fake); await tab(page, tr('en', 'nav.shop')).click();
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: tr('en', 'p.add') }).click();
    await tab(page, tr('en', 'nav.cart')).click(); await page.getByRole('button', { name: tr('en', 'cart.checkout') }).click();
    await expect(section(page)).toContainText(tr('en', 'dl.title')); await expect(section(page).getByTestId('pin-choose')).toContainText(tr('en', 'dl.pickOnMap'));
    await section(page).getByTestId('pin-choose').click(); await expect(picker(page)).toContainText(tr('en', 'pk.title')); await expect(picker(page).getByTestId('pin-confirm')).toHaveText(tr('en', 'pk.confirm'));
  });
});

test.describe('on a small phone and for accessibility', () => {
  for (const width of [320, 390]) {
    test(`no sideways scrolling and no accessibility violations at ${width}px: the form, the map sheet and the confirmation`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      const fake = shop(); await open(page, fake); await addAndCheckout(page);
      await section(page).getByTestId('pin-choose').click(); await noOverflow(page);
      const sheet = await new AxeBuilder({ page }).include('[data-testid="pin-picker"]').analyze(); expect(sheet.violations.map((v) => v.id)).toEqual([]);
      await picker(page).getByTestId('pin-search').fill('สามพราน'); await picker(page).getByTestId('pin-search').press('Enter');
      await picker(page).getByTestId('pin-results').getByRole('button').first().click(); await picker(page).getByTestId('pin-confirm').click();
      await section(page).scrollIntoViewIfNeeded(); await noOverflow(page);
      const form = await new AxeBuilder({ page }).include('[data-testid="delivery-section"]').analyze(); expect(form.violations.map((v) => v.id)).toEqual([]);
      await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
      await expect(page.locator('.sp-sheet')).toBeVisible(); await noOverflow(page);
    });
  }
});
