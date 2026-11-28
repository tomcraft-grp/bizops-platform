// LINE MAN delivery, customer app: the checkout takes the address from the customer's address book (the default is chosen, others one tap away, "+ Add a delivery address"
// opens the address editor over the checkout and the new address is saved to the account and chosen), the address editor itself (the place on the map: search, tap, drag, the
// phone's position, a pasted link; the details; who receives it), "My delivery addresses" in Account (add, edit, default, delete, limit), pick-up (no address, no recipient),
// and every fallback (addresses not loading, an incomplete address, map / search / route / tiles down, an old database, a shop that does not require a pin).
// Against the fake backend (fakeBackend.ts + fakeDelivery.ts) and test answers for OpenStreetMap / Nominatim / OSRM (mapMocks.ts): this proves the SCREENS.
// The rules themselves are proved in the database by supabase/tests/delivery_pin.sql (117 checks against the live project, rolled back).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { type FAddress, type FDelivery, dirUrl, mapsUrl } from './fakeDelivery';
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
const shipTo = (page: Page) => page.getByTestId('ship-to');
const editor = (page: Page) => page.getByTestId('address-editor');
const section = (page: Page) => page.getByTestId('delivery-section');
const picker = (page: Page) => page.getByTestId('pin-picker');
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
const placeCall = (fake: FakeShop) => fake.calls.filter((c) => c.fn === 'shop_place_order').at(-1);
const lastDelivery = (fake: FakeShop): FDelivery => [...fake.dl.deliveries.values()].at(-1)!;
/** a saved address straight into the fake database (as if saved on another day) */
function seed(fake: FakeShop, label: string, lat: number, lng: number, over: Partial<FAddress> = {}): FAddress {
  const a = fake.rpc('shop_address_save', { p_id: null, p_data: { lat, lng, confirmed: true, pin_source: 'tap', recipient_name: 'สมชาย ใจดี', recipient_phone: '0812345678', address_line: `${label} 99/9 ถนนทดสอบ ตำบลทดสอบ` }, p_label: label }) as FAddress;
  Object.assign(a, over); return a;
}
/** "+ Add a delivery address" at checkout: the editor opens over the checkout */
async function openAdd(page: Page) { await shipTo(page).getByTestId('ship-add').click(); await expect(editor(page)).toBeVisible(); }
/** open the map, search, pick the first result and confirm */
async function pinBySearch(page: Page, q = 'สามพราน') {
  await section(page).getByTestId('pin-choose').click();
  await picker(page).getByTestId('pin-search').fill(q); await picker(page).getByTestId('pin-search').press('Enter');
  await picker(page).getByTestId('pin-results').getByRole('button').nth(1).click();          // ตลาดสามพราน (the first result is the shop itself)
  await picker(page).getByTestId('pin-confirm').click();
  await expect(picker(page)).toHaveCount(0);
}
/** save the address in the editor (an address is filled in when the map gave none) and come back to the checkout */
async function saveAddr(page: Page) {
  if (await section(page).getByTestId('dl-address').inputValue() === '') await section(page).getByTestId('dl-address').fill('99/9 ถนนทดสอบ ตำบลทดสอบ อำเภอสามพราน');
  await editor(page).getByTestId('ab-save').click();
  await expect(editor(page)).toHaveCount(0);
}
async function addAddress(page: Page) { await openAdd(page); await pinBySearch(page); await saveAddr(page); }
async function placeOrder(page: Page) {
  await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
  await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
}

test.describe('the checkout: two ways, only what is needed', () => {
  test('exactly two choices, LINE MAN delivery and pick-up; no name, phone or address fields to fill in', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    const ways = page.getByRole('radiogroup', { name: t('co.fulfilment') }).getByRole('radio');
    await expect(ways).toHaveCount(2); await expect(ways.nth(0)).toHaveText(t('co.delivery')); await expect(ways.nth(1)).toHaveText(t('co.pickup'));
    expect(t('co.delivery')).toBe('เรียก Line Man');
    await expect(ways.nth(0)).toHaveAttribute('aria-checked', 'true'); await expect(page.getByTestId('fulfil-hint')).toHaveText(t('co.deliveryHint'));
    await expect(page.getByTestId('contact-section')).toHaveCount(0); await expect(page.getByLabel(t('co.name'))).toHaveCount(0); await expect(page.getByLabel(t('co.phone'))).toHaveCount(0);
    await expect(section(page)).toHaveCount(0);                                                                                  // the map form is not on the checkout
    await expect(shipTo(page).getByTestId('ship-none')).toHaveText(t('ck.none')); await expect(shipTo(page).getByTestId('ship-add')).toContainText(t('ck.add'));
    await expect(page.getByLabel(t('co.note'))).toBeVisible();
  });

  test('no saved address: ordering is stopped on the screen with a clear message, nothing is sent', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('ck.pickAddress')); await expect(shipTo(page).getByTestId('ship-missing')).toBeVisible();
    expect(fake.calls.filter((c) => c.fn === 'shop_place_order')).toHaveLength(0);
  });

  test('pick-up: no address, no recipient, only the note to the shop; switching back to LINE MAN keeps the chosen address; the order has no pin', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 'บ้าน', 13.7702, 100.3301); await open(page, fake); await addAndCheckout(page);
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน');
    await page.getByRole('radio', { name: t('co.pickup') }).click();
    await expect(shipTo(page)).toHaveCount(0); await expect(page.getByTestId('contact-section')).toHaveCount(0); await expect(page.getByLabel(t('co.address'))).toHaveCount(0);
    await expect(page.getByTestId('pickup-card')).toContainText(t('ck.pickupAt')); await expect(page.getByTestId('pickup-card')).toContainText(fake.dl.store.name);
    await expect(page.getByTestId('fulfil-hint')).toHaveText(t('co.pickupHint'));
    await page.getByLabel(t('co.note')).fill('มารับตอนบ่าย');
    await page.getByRole('radio', { name: t('co.delivery') }).click();
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน'); await expect(page.getByLabel(t('co.note'))).toHaveValue('มารับตอนบ่าย');
    await page.getByRole('radio', { name: t('co.pickup') }).click();
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.locator('.sp-sheet').getByTestId('confirm-pickup')).toBeVisible();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const args = placeCall(fake)!.args; expect(args.p_fulfilment).toBe('pickup'); expect(args).not.toHaveProperty('p_delivery'); expect(fake.dl.deliveries.size).toBe(0);
    expect([args.p_name, args.p_phone, args.p_note]).toEqual(['สมชาย ใจดี', '0812345678', 'มารับตอนบ่าย']);                     // from the account
    expect(a.id).toBeTruthy();
  });
});

test.describe('adding an address during checkout', () => {
  test('the whole journey: + Add -> search -> confirm -> details -> save; it is saved to the account as the default, chosen for this order, and the order carries it', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); await addAndCheckout(page);
    await openAdd(page);
    await expect(editor(page)).toContainText(t('ab.newTitle')); await expect(editor(page).getByTestId('ab-default')).toHaveCount(0);   // the first address is the default anyway
    await section(page).getByTestId('pin-choose').click();
    await expect(picker(page)).toBeVisible(); await expect(picker(page).getByTestId('pin-confirm')).toBeDisabled();           // nothing chosen yet
    await picker(page).getByTestId('pin-search').fill('สามพราน');
    expect(maps.searches).toEqual([]);                                                                                         // never search-as-you-type
    await picker(page).getByTestId('pin-search').press('Enter');
    await expect(picker(page).getByTestId('pin-results').getByRole('button')).toHaveCount(2);
    await picker(page).getByTestId('pin-results').getByRole('button').nth(1).click();                                           // ตลาดสามพราน
    await expect(picker(page).getByTestId('pin-coords')).toContainText('13.7702, 100.3301');
    await picker(page).getByTestId('pin-confirm').click();
    await expect(picker(page)).toHaveCount(0); await expect(editor(page)).toBeVisible();                                         // back in the editor, still over the checkout
    const card = section(page).getByTestId('pin-card');
    await expect(card.getByTestId('pin-state')).toHaveText(t('dl.confirmed')); await expect(card).toContainText('13.7702, 100.3301');
    await expect(card.getByTestId('pin-distance')).toContainText(t('dl.straight', { d: '4.9 กม.' }));
    await expect(section(page).getByTestId('dl-address')).toHaveValue(PLACES[1].label);                                          // filled in from the search result
    await expect(section(page).getByTestId('dl-recipient')).toContainText('สมชาย ใจดี · 0812345678');                            // the account receives it
    await editor(page).getByRole('button', { name: t('ab.quick.home'), exact: true }).click(); await expect(editor(page).getByTestId('ab-label')).toHaveValue(t('ab.quick.home'));
    const f = section(page);
    await f.getByLabel(t('dl.f.unit')).fill('12/3');
    await expect(f.getByLabel(t('dl.f.village'))).toHaveCount(0); await f.getByTestId('dl-more').click();                       // the rarely needed details are folded
    await f.getByLabel(t('dl.f.village')).fill('หมู่บ้านทดสอบ'); await f.getByLabel(t('dl.f.floor')).fill('3');
    await f.getByLabel(t('dl.f.landmark')).fill('ตรงข้ามร้านสะดวกซื้อ'); await f.getByTestId('dl-directions').fill('ทางเข้าอยู่ด้านหลังอาคาร');
    await f.getByRole('button', { name: t('dl.q.call') }).click(); await f.getByRole('button', { name: t('dl.q.gate') }).click(); await f.getByRole('button', { name: t('dl.q.call') }).click();
    await expect(f.getByTestId('dl-driver')).toHaveValue(`${t('dl.q.call')}. ${t('dl.q.gate')}`);                               // no duplicate
    await editor(page).getByTestId('ab-save').click(); await expect(editor(page)).toHaveCount(0);

    expect(fake.dl.addresses).toHaveLength(1);
    const saved = fake.dl.addresses[0];
    expect(saved).toMatchObject({ label: t('ab.quick.home'), is_default: true, lat: 13.7702, lng: 100.3301, pin_source: 'search', recipient_name: 'สมชาย ใจดี', recipient_phone: '0812345678', unit_no: '12/3', village: 'หมู่บ้านทดสอบ' });
    const ship = shipTo(page).getByTestId('ship-card');                                                                          // chosen for this order
    await expect(ship).toContainText(t('ab.quick.home')); await expect(ship).toContainText(t('dl.default')); await expect(ship).toContainText('12/3');
    await expect(ship.getByTestId('ship-recipient')).toContainText('สมชาย ใจดี'); await expect(ship.getByTestId('pin-driving')).toContainText('ขับรถ');
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    const sheet = page.locator('.sp-sheet'); await expect(sheet.getByTestId('confirm-delivery')).toContainText('12/3'); await expect(sheet.getByTestId('confirm-delivery')).toContainText('13.7702, 100.3301');
    await sheet.getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();

    const call = placeCall(fake)!.args; const d = call.p_delivery as Record<string, unknown>;
    expect(d).toMatchObject({ lat: 13.7702, lng: 100.3301, confirmed: true, pin_source: 'saved', address_id: saved.id, recipient_name: 'สมชาย ใจดี', recipient_phone: '0812345678', address_line: PLACES[1].label,
      unit_no: '12/3', village: 'หมู่บ้านทดสอบ', floor_no: '3', landmark: 'ตรงข้ามร้านสะดวกซื้อ', directions: 'ทางเข้าอยู่ด้านหลังอาคาร', driver_note: `${t('dl.q.call')}. ${t('dl.q.gate')}`, place_label: PLACES[1].label });
    expect(d.route).toMatchObject({ source: 'osrm' }); expect((d.route as { distance_m: number }).distance_m).toBeGreaterThan(4000);
    expect(d).not.toHaveProperty('maps_url'); expect(d).not.toHaveProperty('directions_url');                                       // the database builds the links
    expect([call.p_fulfilment, call.p_name, call.p_phone]).toEqual(['delivery', 'สมชาย ใจดี', '0812345678']);

    const got = lastDelivery(fake);
    expect(got.maps_url).toBe(mapsUrl(13.7702, 100.3301)); expect(got.directions_url).toBe(dirUrl(STORE, 13.7702, 100.3301)); expect(got.route).not.toBeNull();
    await openFold(page, 'delivery');
    const block = page.getByTestId('order-delivery');
    await expect(block).toContainText('12/3'); await expect(block).toContainText('ตรงข้ามร้านสะดวกซื้อ'); await expect(block).toContainText(t('dl.od.driverNote'));
    await expect(block.getByTestId('order-map-link')).toHaveAttribute('href', mapsUrl(13.7702, 100.3301));
    expect(maps.searches).toEqual(['สามพราน']); expect(maps.routes).toBe(1);
  });

  test('the editor checks before saving: no pin, a short address, a wrong recipient phone; nothing is saved until it is right; closing it keeps the checkout as it was', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await page.getByLabel(t('co.note')).fill('โน้ตเดิม');
    await openAdd(page);
    await editor(page).getByTestId('ab-save').click();
    await expect(editor(page).getByTestId('ab-fix')).toBeVisible(); await expect(section(page).getByTestId('pin-missing')).toBeVisible();
    await pinBySearch(page); await section(page).getByTestId('dl-address').fill('abc');
    await editor(page).getByTestId('ab-save').click(); await expect(section(page).getByText(t('dl.err.address'))).toBeVisible();
    await section(page).getByTestId('dl-address').fill('99/9 ถนนทดสอบ'); await section(page).getByTestId('dl-other').check();
    await section(page).getByLabel(t('dl.f.rname')).fill('มาลี'); await section(page).getByLabel(t('dl.f.rphone')).fill('123');
    await editor(page).getByTestId('ab-save').click(); await expect(section(page).getByText(t('dl.err.recipient'))).toBeVisible();
    expect(fake.dl.addresses).toHaveLength(0);
    await editor(page).getByTestId('ab-cancel').click(); await expect(editor(page)).toHaveCount(0);
    await expect(page.getByLabel(t('co.note'))).toHaveValue('โน้ตเดิม'); expect(fake.dl.addresses).toHaveLength(0);
    await openAdd(page); await pinBySearch(page);
    await section(page).getByTestId('dl-other').check(); await section(page).getByLabel(t('dl.f.rname')).fill('มาลี'); await section(page).getByLabel(t('dl.f.rphone')).fill('0899999999');   // somebody else receives it
    await saveAddr(page);
    await expect(shipTo(page).getByTestId('ship-recipient')).toContainText('มาลี');
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ recipient_name: 'มาลี', recipient_phone: '0899999999' });
    expect([placeCall(fake)!.args.p_name, placeCall(fake)!.args.p_phone]).toEqual(['สมชาย ใจดี', '0812345678']);                // the customer is still the account
  });
});

test.describe('choosing the place in the address editor', () => {
  test('tapping the map and dragging the pin move it; confirming takes the last place', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page); await openAdd(page);
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
    await saveAddr(page);
    expect(fake.dl.addresses[0]).toMatchObject({ pin_source: 'drag', lat: Number(second[1]), lng: Number(second[2]) });
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const d = (placeCall(fake)!.args.p_delivery as Record<string, unknown>);
    expect(d.lat).toBe(Number(second[1])); expect(d.lng).toBe(Number(second[2])); expect(d.confirmed).toBe(true);
  });

  test('the phone\'s own position: allowed -> a pin', async ({ page, context }) => {
    const fake = shop(); await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 13.7600, longitude: 100.3100 });
    await open(page, fake); await addAndCheckout(page); await openAdd(page);
    await section(page).getByTestId('pin-choose').click();
    await picker(page).getByTestId('pin-gps').click();
    await expect(picker(page).getByTestId('pin-coords')).toContainText('13.76, 100.31');
    await picker(page).getByTestId('pin-confirm').click();
    await expect(section(page).getByTestId('pin-state')).toHaveText(t('dl.confirmed'));
    await saveAddr(page); expect(fake.dl.addresses[0].pin_source).toBe('gps');
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ lat: 13.76, lng: 100.31 });
  });
  test('the phone\'s position refused: the message says what to do', async ({ page, context }) => {
    const fake = shop(); await context.clearPermissions(); await open(page, fake); await addAndCheckout(page); await openAdd(page);
    await section(page).getByTestId('pin-choose').click();
    await picker(page).getByTestId('pin-gps').click();
    await expect(picker(page).getByTestId('pin-msg')).toBeVisible();
    await expect(picker(page).getByTestId('pin-confirm')).toBeDisabled();
  });

  test('a pasted Google Maps link or coordinates: a full link works, a short link and a place outside Thailand are explained', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page); await openAdd(page);
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
    await saveAddr(page); expect(fake.dl.addresses[0].pin_source).toBe('link');
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ lat: 13.745952, lng: 100.292734 });
  });

  test('moving the pin again re-confirms it: the card keeps the old confirmed place until the new one is confirmed, and Escape closes only the map', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page); await openAdd(page); await pinBySearch(page);
    const before = await section(page).getByTestId('pin-card').innerText();
    await section(page).getByTestId('pin-change').click();
    const map = picker(page).locator('.leaflet-container'); const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width / 2 + 50, y: box.height / 2 + 50 } });
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0); await expect(editor(page)).toBeVisible();
    expect(await section(page).getByTestId('pin-card').innerText()).toBe(before);
  });
});

test.describe('choosing among saved addresses', () => {
  test('the default is chosen by itself; Change lists them all; another one is chosen with one tap and goes with the order', async ({ page }) => {
    const fake = shop(); seed(fake, 'บ้าน', 13.7702, 100.3301); const office = seed(fake, 'ที่ทำงาน', 13.78, 100.35);
    await open(page, fake); await addAndCheckout(page);
    const card = shipTo(page).getByTestId('ship-card');
    await expect(card).toContainText('บ้าน'); await expect(card).toContainText(t('dl.default'));
    await shipTo(page).getByTestId('ship-change').click();
    const opts = shipTo(page).getByTestId('ship-option'); await expect(opts).toHaveCount(2);
    await expect(opts.filter({ hasText: 'บ้าน' })).toHaveAttribute('aria-checked', 'true'); await expect(opts.filter({ hasText: 'ที่ทำงาน' })).toHaveAttribute('aria-checked', 'false');
    await opts.filter({ hasText: 'ที่ทำงาน' }).click();
    await expect(shipTo(page).getByTestId('ship-list')).toHaveCount(0); await expect(card).toContainText('ที่ทำงาน');
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ address_id: office.id, lat: 13.78, lng: 100.35, pin_source: 'saved' });
  });

  test('a reload keeps the address chosen for this order; an address deleted meanwhile falls back to the default', async ({ page }) => {
    const fake = shop(); seed(fake, 'บ้าน', 13.7702, 100.3301); const office = seed(fake, 'ที่ทำงาน', 13.78, 100.35);
    await open(page, fake); await addAndCheckout(page);
    await shipTo(page).getByTestId('ship-change').click(); await shipTo(page).getByTestId('ship-option').filter({ hasText: 'ที่ทำงาน' }).click();
    await page.reload(); await expect(page.locator('.phone-nav')).toBeVisible(); await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('ที่ทำงาน');
    fake.dl.addresses.splice(fake.dl.addresses.indexOf(fake.dl.addresses.find((a) => a.id === office.id)!), 1);
    await page.reload(); await expect(page.locator('.phone-nav')).toBeVisible(); await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน');
  });

  test('edit the chosen address from the checkout: the change is saved to the account, the order placed before keeps its own copy', async ({ page }) => {
    const fake = shop(); seed(fake, 'บ้าน', 13.7702, 100.3301); await open(page, fake); await addAndCheckout(page);
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const orderPin = JSON.stringify(lastDelivery(fake));
    await addAndCheckout(page);
    await shipTo(page).getByTestId('ship-edit').click(); await expect(editor(page)).toContainText(t('ab.editTitle'));
    await expect(editor(page).getByTestId('ab-label')).toHaveValue('บ้าน');
    await section(page).getByTestId('pin-change').click();
    await picker(page).getByTestId('pin-link-toggle').click(); await picker(page).getByTestId('pin-link').fill('13.7500, 100.3000'); await picker(page).getByTestId('pin-link-use').click();
    await picker(page).getByTestId('pin-confirm').click();
    await editor(page).getByTestId('ab-save').click(); await expect(editor(page)).toHaveCount(0);
    expect(fake.dl.addresses).toHaveLength(1); expect(fake.dl.addresses[0]).toMatchObject({ lat: 13.75, lng: 100.3, is_default: true });
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน');
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ lat: 13.75, lng: 100.3 });
    expect(JSON.stringify([...fake.dl.deliveries.values()][0])).toBe(orderPin);                                                 // the earlier order keeps the place it was sent to
  });

  test('an incomplete saved address is shown with a warning; ordering waits until it is edited', async ({ page }) => {
    const fake = shop(); seed(fake, 'บ้านเก่า', 13.7702, 100.3301, { recipient_phone: '123' }); await open(page, fake); await addAndCheckout(page);
    await expect(shipTo(page).getByTestId('ship-incomplete')).toHaveText(t('ck.incomplete'));
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('ck.incomplete')); expect(fake.calls.filter((c) => c.fn === 'shop_place_order')).toHaveLength(0);
    await shipTo(page).getByTestId('ship-edit').click();
    await expect(section(page).getByLabel(t('dl.f.rphone'))).toHaveValue('123'); await section(page).getByLabel(t('dl.f.rphone')).fill('0899999999');
    await editor(page).getByTestId('ab-save').click(); await expect(editor(page)).toHaveCount(0);
    await expect(shipTo(page).getByTestId('ship-incomplete')).toHaveCount(0);
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ recipient_phone: '0899999999' });
  });

  test('the addresses cannot be loaded: said, Try again brings them back; pick-up still works meanwhile', async ({ page }) => {
    const fake = shop(); seed(fake, 'บ้าน', 13.7702, 100.3301); fake.failNext('shop_address_list', 1); await open(page, fake); await addAndCheckout(page);
    await expect(shipTo(page)).toContainText(t('ck.loadFail'));
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('ck.loadFail')); expect(fake.calls.filter((c) => c.fn === 'shop_place_order')).toHaveLength(0);
    await shipTo(page).getByRole('button', { name: t('common.retry') }).click();
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน');
  });

  test('ten addresses: no add button at checkout, the limit is said', async ({ page }) => {
    const fake = shop(); for (let i = 0; i < 10; i++) seed(fake, `n${i}`, 13.7, 100.3);
    await open(page, fake); await addAndCheckout(page);
    await expect(shipTo(page).getByTestId('ship-add')).toHaveCount(0); await expect(shipTo(page)).toContainText(t('ab.limit'));
  });

  test('the database refuses the place (an older app, a changed rule): the customer is told in Thai and the chosen address stays', async ({ page }) => {
    const fake = shop(); seed(fake, 'บ้าน', 13.7702, 100.3301); await open(page, fake); await addAndCheckout(page);
    await page.route('**/rest/v1/rpc/shop_place_order', (route) => route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'P0001', message: 'PIN_OUTSIDE_AREA', details: null, hint: null }) }));
    await placeOrder(page);
    await expect(page.getByTestId('checkout-error')).toContainText(t('dl.err.PIN_OUTSIDE_AREA'));
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน');
  });
});

test.describe('when the map services fail the customer can still order', () => {
  test('the route is not available: said calmly, the order goes without a route', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); maps.failRoute = true; await addAndCheckout(page); await addAddress(page);
    await expect(shipTo(page).getByTestId('route-fail')).toHaveText(t('dl.routeFail'));
    await expect(shipTo(page).getByTestId('pin-distance')).toContainText(t('dl.straight', { d: '4.9 กม.' }));
    await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect((placeCall(fake)!.args.p_delivery as Record<string, unknown>).route).toBeNull();
    expect(lastDelivery(fake).route).toBeNull(); expect(lastDelivery(fake).maps_url).toContain('google.com/maps'); expect(lastDelivery(fake).straight_m).toBeGreaterThan(4000);
  });
  test('search is down or busy: said, and tapping the map still works', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); await addAndCheckout(page); await openAdd(page);
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
  test('the map tiles do not load: a notice says so, and a pasted link still gives a saved address and an order', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); maps.failTiles = true; await addAndCheckout(page); await openAdd(page);
    await section(page).getByTestId('pin-choose').click();
    await expect(picker(page).getByTestId('map-down')).toHaveText(t('pk.mapDown'));
    await picker(page).getByTestId('pin-link-toggle').click(); await picker(page).getByTestId('pin-link').fill('13.7702, 100.3301'); await picker(page).getByTestId('pin-link-use').click();
    await picker(page).getByTestId('pin-confirm').click();
    await saveAddr(page); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(placeCall(fake)!.args.p_delivery).toMatchObject({ lat: 13.7702, lng: 100.3301 });
  });
  test('the name of the place is not found: the address stays empty and is asked for', async ({ page }) => {
    const fake = shop(); const maps = await open(page, fake); maps.reverseName = null; await addAndCheckout(page); await openAdd(page);
    await section(page).getByTestId('pin-choose').click();
    const map = picker(page).locator('.leaflet-container'); const box = (await map.boundingBox())!;
    await map.click({ position: { x: box.width / 2 + 30, y: box.height / 2 + 30 } });
    await page.waitForTimeout(1000);
    await picker(page).getByTestId('pin-confirm').click();
    await expect(section(page).getByTestId('dl-address')).toHaveValue('');
    await editor(page).getByTestId('ab-save').click();
    await expect(section(page).getByText(t('dl.err.address'))).toBeVisible(); expect(fake.dl.addresses).toHaveLength(0);
  });
});

test.describe('My delivery addresses (Account)', () => {
  test('add, make default, delete; the default stays on top; another customer\'s addresses are not there', async ({ page }) => {
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
    await expect(items.first()).toContainText('ที่ทำงาน');                                                                       // the default first
    await items.filter({ hasText: 'ที่ทำงาน' }).getByTestId('ab-delete').click();
    await expect(page.locator('.sp-sheet')).toContainText(t('ab.deleteBody'));
    await page.locator('.sp-sheet').getByRole('button', { name: t('ab.delete') }).click();
    await expect(items).toHaveCount(1); await expect(items.first().locator('.sp-pill')).toHaveText(t('dl.default'));                              // the other one became the default
    expect(fake.dl.addresses.map((a) => a.label)).toEqual(['บ้าน']);
  });

  test('an address saved in Account is the one the next checkout chooses', async ({ page }) => {
    const fake = shop(); await open(page, fake);
    await tab(page, t('nav.account')).click(); await page.getByTestId('addresses-row').click();
    await page.getByTestId('ab-add').click(); await page.getByRole('button', { name: t('ab.quick.office'), exact: true }).click();
    await page.getByTestId('pin-choose').click(); await picker(page).getByTestId('pin-link-toggle').click(); await picker(page).getByTestId('pin-link').fill('13.7800, 100.3500'); await picker(page).getByTestId('pin-link-use').click(); await picker(page).getByTestId('pin-confirm').click();
    await page.getByTestId('dl-address').fill('อาคารทดสอบ ถนนทดสอบ'); await page.getByTestId('ab-save').click(); await expect(page.getByTestId('ab-item')).toHaveCount(1);
    await addAndCheckout(page);
    await expect(shipTo(page).getByTestId('ship-card')).toContainText(t('ab.quick.office')); await expect(shipTo(page).getByTestId('ship-card')).toContainText('อาคารทดสอบ');
  });

  test('ten addresses is the limit: the add button is replaced by a note', async ({ page }) => {
    const fake = shop(); for (let i = 0; i < 10; i++) seed(fake, `n${i}`, 13.7, 100.3);
    await open(page, fake); await tab(page, t('nav.account')).click(); await page.getByTestId('addresses-row').click();
    await expect(page.getByTestId('ab-item')).toHaveCount(10); await expect(page.getByTestId('ab-add')).toHaveCount(0); await expect(page.locator('.sp-page')).toContainText(t('ab.limit'));
  });
});

test.describe('other databases and shops', () => {
  test('an older database (no delivery-pin migration): the typed address is kept, no map, no addresses row, and the order goes as before', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.settings.require_payment_slip = false; await open(page, fake); await addAndCheckout(page);
    await expect(section(page)).toHaveCount(0); await expect(shipTo(page)).toHaveCount(0);
    await expect(page.getByLabel(t('co.address'))).toHaveCount(1);
    await page.getByLabel(t('co.address')).fill('99/9 ถนนทดสอบ ตำบลทดสอบ'); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const args = placeCall(fake)!.args; expect(args).not.toHaveProperty('p_delivery'); expect(args.p_address).toBe('99/9 ถนนทดสอบ ตำบลทดสอบ');
    await tab(page, t('nav.account')).click(); await expect(page.getByTestId('addresses-row')).toHaveCount(0);
  });
  test('a shop that does not require a pin: a customer with nothing saved can type the address; one with a saved address can still type instead', async ({ page }) => {
    const fake = shop((f) => { f.dl.required = false; }); await open(page, fake); await addAndCheckout(page);
    await expect(shipTo(page).getByTestId('typed-address')).toBeVisible(); await expect(shipTo(page).getByTestId('ship-add')).toBeVisible();
    await shipTo(page).getByTestId('typed-address').fill('99/9 ถนนทดสอบ ตำบลทดสอบ'); await placeOrder(page); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const args = placeCall(fake)!.args; expect(args).not.toHaveProperty('p_delivery'); expect(args.p_address).toBe('99/9 ถนนทดสอบ ตำบลทดสอบ');
    expect(fake.dl.deliveries.size).toBe(0);
    seed(fake, 'บ้าน', 13.7702, 100.3301); await addAndCheckout(page);
    await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน');
    await shipTo(page).getByTestId('type-instead').click(); await expect(shipTo(page).getByTestId('typed-address')).toBeVisible(); await expect(shipTo(page).getByTestId('ship-card')).toHaveCount(0);
    await shipTo(page).getByTestId('use-saved').click(); await expect(shipTo(page).getByTestId('ship-card')).toContainText('บ้าน');
  });
  test('English: the customer app speaks English when chosen', async ({ page }) => {
    const fake = shop(); await page.addInitScript(() => { try { localStorage.setItem('tc.shop.lang', 'en'); } catch { /* ignore */ } });
    await open(page, fake); await tab(page, tr('en', 'nav.shop')).click();
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: tr('en', 'p.add') }).click();
    await tab(page, tr('en', 'nav.cart')).click(); await page.getByRole('button', { name: tr('en', 'cart.checkout') }).click();
    await expect(page.getByRole('radio', { name: tr('en', 'co.delivery') })).toBeVisible();
    await expect(shipTo(page)).toContainText(tr('en', 'ck.shipTo')); await expect(shipTo(page).getByTestId('ship-add')).toContainText(tr('en', 'ck.add'));
    await shipTo(page).getByTestId('ship-add').click(); await expect(editor(page)).toContainText(tr('en', 'ab.newTitle'));
    await expect(section(page).getByTestId('pin-choose')).toContainText(tr('en', 'dl.pickOnMap'));
    await section(page).getByTestId('pin-choose').click(); await expect(picker(page)).toContainText(tr('en', 'pk.title')); await expect(picker(page).getByTestId('pin-confirm')).toHaveText(tr('en', 'pk.confirm'));
  });
});

test.describe('on a small phone and for accessibility', () => {
  for (const width of [320, 390]) {
    test(`no sideways scrolling and no accessibility violations at ${width}px: the checkout, the address editor, the map sheet, the list and the confirmation`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      const fake = shop(); seed(fake, 'ที่ทำงาน', 13.78, 100.35, { is_default: false }); await open(page, fake); await addAndCheckout(page);
      await noOverflow(page);
      const co = await new AxeBuilder({ page }).include('[data-testid="ship-to"]').analyze(); expect(co.violations.map((v) => v.id)).toEqual([]);
      await openAdd(page); await noOverflow(page);
      const ed = await new AxeBuilder({ page }).include('[data-testid="address-editor"]').analyze(); expect(ed.violations.map((v) => v.id)).toEqual([]);
      await section(page).getByTestId('pin-choose').click(); await noOverflow(page);
      const sheet = await new AxeBuilder({ page }).include('[data-testid="pin-picker"]').analyze(); expect(sheet.violations.map((v) => v.id)).toEqual([]);
      await picker(page).getByTestId('pin-search').fill('สามพราน'); await picker(page).getByTestId('pin-search').press('Enter');
      await picker(page).getByTestId('pin-results').getByRole('button').first().click(); await picker(page).getByTestId('pin-confirm').click();
      await saveAddr(page); await noOverflow(page);
      await shipTo(page).getByTestId('ship-change').click(); await noOverflow(page);
      const list = await new AxeBuilder({ page }).include('[data-testid="ship-to"]').analyze(); expect(list.violations.map((v) => v.id)).toEqual([]);
      await shipTo(page).getByTestId('ship-option').first().click();
      await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
      await expect(page.locator('.sp-sheet')).toBeVisible(); await noOverflow(page);
    });
  }
});
