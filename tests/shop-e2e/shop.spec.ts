import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { defaultLayout } from '../../src/devapp/schema';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { openFold, pickMethod } from './methods';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const SHOTS = process.env.SHOP_SHOTS ?? 'test-results/shop';
// a real (1x1) PNG: the slip uploader checks the file's first bytes, not its name
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** the checkout asks for the transfer slip: attach a (unique) picture when the screen shows that step */
async function attachSlip(page: Page) {
  if (await page.getByTestId('slip-section').count() === 0) return;
  if (await page.getByTestId('slip-preview').count() > 0) return;                              // already attached (a retry keeps the same slip)
  await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#' + Math.random())]) });
  await expect(page.getByTestId('slip-preview')).toBeVisible();
}


async function open(page: Page, fake: FakeShop, hash = '/app') {
  await fake.install(page);
  await page.goto(`/#${hash}`);
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const cards = (page: Page) => page.locator('.sp-card[data-sku]');
const body = (page: Page) => page.locator('.phone-body');
async function addFromCatalog(page: Page, sku: string) { await page.locator(`.sp-card[data-sku="${sku}"]`).getByRole('button', { name: t('p.add') }).click(); }
async function placeOrder(page: Page, fake: FakeShop, items: [string, number][] = [['FG-000001', 2]]) {
  await tab(page, t('nav.shop')).click();
  for (const [sku, n] of items) { await addFromCatalog(page, sku); for (let i = 1; i < n; i++) await page.locator(`.sp-card[data-sku="${sku}"]`).getByRole('button', { name: t('p.plus') }).click(); }
  await tab(page, t('nav.cart')).click();
  await page.getByRole('button', { name: t('cart.checkout') }).click();
  await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
  await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
  await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
  await expect(page.locator('.sp-order-detail')).toBeVisible();
  return fake.orders[fake.orders.length - 1];
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);

test.describe('home', () => {
  test('shows real sections, hides empty ones, categories use their Thai names', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await expect(page.getByRole('heading', { name: t('home.featured') })).toBeVisible();
    await expect(page.getByRole('heading', { name: t('home.new') })).toBeVisible();
    await expect(page.getByRole('heading', { name: t('home.popular') })).toHaveCount(0);          // no orders yet: no empty "best sellers"
    await expect(page.getByRole('button', { name: 'พอตใช้แล้วทิ้ง' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Coil' })).toBeVisible();
    expect(await cards(page).count()).toBeGreaterThan(5);
    for (const l of ['nav.home', 'nav.shop', 'nav.cart', 'nav.orders', 'nav.account'] as K[]) await expect(tab(page, t(l))).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/home-mobile.png` });
    await noOverflow(page);
  });
  test('best sellers appear once real orders exist', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rpc('shop_place_order', { p_key: 'seed-order-001', p_items: [{ sku_code: 'FG-000020', qty: 3 }], p_fulfilment: 'pickup', p_name: 'A', p_phone: '0812345678', p_address: null, p_note: null });
    await open(page, fake);
    await expect(page.getByRole('heading', { name: t('home.popular') })).toBeVisible();
  });
  test('search on the home page opens the catalogue with that search', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await page.getByRole('searchbox').fill('FG-000020'); await page.keyboard.press('Enter');
    await expect(cards(page)).toHaveCount(1);
    await expect(page.locator('.sp-card[data-sku="FG-000020"]')).toBeVisible();
  });
});

test.describe('catalogue', () => {
  test('search, category, sort, paging, sold out and empty states', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await tab(page, t('nav.shop')).click();
    await expect(cards(page)).toHaveCount(24);
    await expect(page.getByText(t('cat.count', { n: 47 }))).toBeVisible();
    await page.getByRole('button', { name: t('common.loadMore') }).click();
    await expect(cards(page)).toHaveCount(47);
    await expect(page.getByRole('button', { name: t('common.loadMore') })).toHaveCount(0);

    await page.getByRole('searchbox').fill('FG-000001');
    await expect(cards(page)).toHaveCount(1);
    await page.getByRole('searchbox').fill('zzzzzz');
    await expect(page.getByText(t('cat.none'))).toBeVisible();
    await page.getByRole('button', { name: t('cat.clear') }).first().click();
    await expect(cards(page).first()).toBeVisible();

    await page.getByRole('tab', { name: 'Coil' }).click();
    await expect(cards(page)).toHaveCount(2);
    await page.getByRole('tab', { name: t('common.all') }).click();
    await page.getByLabel(t('cat.sort')).selectOption('price_asc');
    await expect(page.getByText(t('cat.count', { n: 47 }))).toBeVisible();
    const prices = await page.locator('.sp-card .sp-price').allTextContents();
    const nums = prices.map((p) => Number(p.replace(/[^0-9.]/g, '').replace(/\/.*/, '')));
    expect(nums.slice(0, 20)).toEqual([...nums.slice(0, 20)].sort((a, b) => a - b));

    await page.getByRole('searchbox').fill('FG-000004');
    const sold = page.locator('.sp-card[data-sku="FG-000004"]');
    await expect(sold.getByText(t('p.soldOut')).first()).toBeVisible();
    await expect(sold.getByRole('button', { name: t('p.add') })).toHaveCount(0);
  });
  test('a failed load shows a message and Try again works', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    fake.failNext('shop_catalog', 2);   // the dev server runs effects twice (StrictMode): fail both loads
    await tab(page, t('nav.shop')).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: t('common.retry') }).click();
    await expect(cards(page).first()).toBeVisible();
  });
  test('a closed shop can be browsed but not ordered from', async ({ page }) => {
    const fake = new FakeShop(); fake.settings.shop_open = false; await open(page, fake);
    await tab(page, t('nav.shop')).click();
    await expect(page.getByText(t('shop.closed'))).toBeVisible();
    await expect(cards(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: t('p.add') })).toHaveCount(0);
  });
  test('catalogue filters survive opening a product and coming back', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.shop')).click();
    await page.getByRole('tab', { name: 'Coil' }).click();
    await expect(cards(page)).toHaveCount(2);
    await cards(page).first().getByRole('button', { name: t('p.details'), exact: true }).click();
    await page.getByRole('button', { name: t('common.back') }).click();
    await expect(cards(page)).toHaveCount(2);
  });
});

test.describe('product page', () => {
  test('shows real details, options, adds to cart and buys now', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await tab(page, t('nav.shop')).click();
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.details'), exact: true }).click();
    await expect(page.getByRole('heading', { name: /INFY Mix Friuts/ })).toBeVisible();
    await expect(page.getByText('FG-000001').first()).toBeVisible();
    await expect(page.getByText('ผลไม้รวม').first()).toBeVisible();          // Thai name
    await expect(page.getByText('Mix Friuts').first()).toBeVisible();          // English name
    await expect(page.locator('.sp-price.big')).toContainText('฿320');
    await expect(page.locator('.sp-facts')).toContainText('6,000 คำ');
    await expect(page.getByText('รสผลไม้รวม หอมหวาน')).toBeVisible();
    await expect(page.locator('.sp-specs')).toContainText('ชาร์จได้');
    await expect(page.locator('.sp-options')).toContainText('สตอเบอรี่กัมมี');
    expect(await page.locator('.sp-thumbs button').count()).toBe(2);
    await page.screenshot({ path: `${SHOTS}/product-mobile.png`, fullPage: false });
    // quantity then add
    await page.locator('.sp-buy').getByRole('button', { name: t('p.plus') }).click();
    await page.locator('.sp-buy').getByRole('button', { name: t('p.add'), exact: true }).click();
    await expect(page.locator('.phone-nav .sp-nav-badge')).toHaveText('2');
    // options: pick the sibling
    await page.locator('.sp-options').getByRole('button', { name: /สตอเบอรี่กัมมี/ }).click();
    await expect(page.getByText('FG-000002').first()).toBeVisible();
    await page.getByRole('button', { name: t('p.buyNow') }).click();
    await expect(page.getByRole('heading', { name: t('cart.title') })).toBeVisible();
    await expect(page.locator('.sp-lines > li')).toHaveCount(2);
  });
  test('quantity respects the per-order limit and a sold-out product cannot be added', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await tab(page, t('nav.shop')).click();
    await page.getByRole('searchbox').fill('FG-000003');
    await page.locator('.sp-card[data-sku="FG-000003"]').getByRole('button', { name: t('p.details'), exact: true }).click();
    await expect(page.getByText(t('p.maxPer', { n: 2 }), { exact: false })).toBeVisible();
    await page.locator('.sp-buy').getByRole('button', { name: t('p.plus') }).click();
    await expect(page.locator('.sp-buy').getByRole('button', { name: t('p.plus') })).toBeDisabled();
    await page.getByRole('button', { name: t('common.back') }).click();
    await page.getByRole('searchbox').fill('FG-000004');
    await page.locator('.sp-card[data-sku="FG-000004"]').getByRole('button', { name: t('p.details'), exact: true }).click();
    await expect(page.locator('.sp-info').getByRole('button', { name: t('p.add'), exact: true })).toHaveCount(0);
    await expect(page.locator('.sp-info').getByText(t('p.soldOut')).first()).toBeVisible();
  });
});

test.describe('cart', () => {
  test('totals come from the server; quantity, remove, free-shipping hint, empty state', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await tab(page, t('nav.cart')).click();
    await expect(page.getByText(t('cart.empty'))).toBeVisible();
    await page.getByRole('button', { name: t('cart.browse') }).click();
    await addFromCatalog(page, 'FG-000001'); await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.plus') }).click();
    await addFromCatalog(page, 'FG-000020');
    await tab(page, t('nav.cart')).click();
    await expect(page.locator('.sp-summary')).toContainText('฿960');                       // 3 x 320
    await expect(page.locator('.sp-summary')).toContainText('฿50');                        // shipping below the free threshold
    await expect(page.locator('.sp-summary')).toContainText('฿1,010');
    await expect(page.getByText(t('cart.freeHint', { amount: '฿40' }))).toBeVisible();
    await page.locator('.sp-lines > li').first().getByRole('button', { name: t('p.plus') }).click();
    await expect(page.locator('.sp-summary')).toContainText('฿1,280');                     // 4 x 320: free shipping
    await expect(page.locator('.sp-summary')).toContainText(t('cart.free'));
    await page.screenshot({ path: `${SHOTS}/cart-mobile.png` });
    // the app never sends a price: only SKU + quantity
    const q = fake.calls.filter((c) => c.fn === 'shop_quote').pop()!;
    expect(JSON.stringify(q.args.p_items)).not.toMatch(/price|total/i);
    await page.getByRole('button', { name: new RegExp(t('cart.remove')) }).first().click();
    await expect(page.locator('.sp-lines > li')).toHaveCount(1);
  });
  test('an item that became unavailable blocks checkout until it is removed', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await fake.install(page);
    await page.addInitScript(() => localStorage.setItem('tc.cart.v1:11111111-1111-4111-8111-111111111111', JSON.stringify([{ sku: 'FG-000004', qty: 1, name: 'x', price: 1, image: null, max: null }, { sku: 'FG-000001', qty: 1, name: 'y', price: 1, image: null, max: null }])));
    await page.goto('/#/app'); await tab(page, t('nav.cart')).click();
    await expect(page.getByText(t('cart.line.sold_out'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('cart.checkout') })).toBeDisabled();
    await page.getByRole('button', { name: t('cart.removeBad') }).click();
    await expect(page.locator('.sp-lines > li')).toHaveCount(1);
    await expect(page.getByRole('button', { name: t('cart.checkout') })).toBeEnabled();
    // the stored price (1) was only a label: the server's price is what is shown
    await expect(page.locator('.sp-summary')).toContainText('฿320');
  });
  test('the cart is remembered after a reload', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.shop')).click(); await addFromCatalog(page, 'FG-000001');
    await page.reload(); await expect(page.locator('.phone-nav')).toBeVisible();
    await expect(page.locator('.phone-nav .sp-nav-badge')).toHaveText('1');
  });
});

test.describe('checkout and payment', () => {
  test('validates the form, confirms, creates ONE order priced by the server, then shows the payment screen', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await tab(page, t('nav.shop')).click(); await addFromCatalog(page, 'FG-000001');
    await tab(page, t('nav.cart')).click();
    await page.getByRole('button', { name: t('cart.checkout') }).click();
    await page.getByLabel(t('co.phone')).fill('123');
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByText(t('err.phone'))).toBeVisible();
    await expect(page.getByText(t('err.address'))).toHaveCount(0);                            // the address is optional: no error for leaving it empty
    expect(fake.orders).toHaveLength(0);
    await page.getByLabel(t('co.phone')).fill('081-234-5678');
    await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
    await page.screenshot({ path: `${SHOTS}/checkout-mobile.png` });
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.locator('.sp-sheet')).toContainText('฿370');                          // 320 + 50 shipping
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toContainText(/ORD-\d{6}/);
    expect(fake.orders).toHaveLength(1);
    const call = fake.calls.find((c) => c.fn === 'shop_place_order')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_address', 'p_expected_total', 'p_fulfilment', 'p_items', 'p_key', 'p_name', 'p_note', 'p_payment_method', 'p_phone', 'p_slip_path', 'p_slip_ref', 'p_slip_sha256', 'p_slip_transfer_at', 'p_slip_type']);   // the payment choice and the slip are the only additions: still no price, amount or balance
    expect(call.args.p_items).toEqual([{ sku_code: 'FG-000001', qty: 1 }]);                 // no price anywhere
    await expect(page.locator('.phone-nav .sp-nav-badge')).toHaveCount(0);                   // the cart was emptied
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.pending'));          // the slip came with the order: awaiting verification, not paid
  });
  test('pickup needs no address and costs no shipping', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.shop')).click(); await addFromCatalog(page, 'FG-000020');
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await page.getByRole('radio', { name: t('co.pickup') }).click();
    await expect(page.getByLabel(t('co.address'))).toHaveCount(0);
    await expect(page.getByText('รับที่ร้าน 99 ถนนทดสอบ')).toBeVisible();
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders[0].total).toBe(320); expect(fake.orders[0].delivery_address).toBeNull();
  });
  test('a double tap on "place order" creates one order', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.shop')).click(); await addFromCatalog(page, 'FG-000001');
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    const confirm = page.locator('.sp-sheet').getByRole('button', { name: t('co.place') });
    await confirm.dblclick();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders).toHaveLength(1);
    expect(fake.count('shop_place_order')).toBe(1);
  });
  test('a dropped connection can be retried safely: same key, still one order', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.shop')).click(); await addFromCatalog(page, 'FG-000001');
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
    fake.dropResponseOnce('shop_place_order');
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.getByText(t('err.network'))).toBeVisible();
    expect(fake.orders).toHaveLength(1);                                                    // the server did create it
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders).toHaveLength(1);                                                    // the retry returned it, no second order
    const keys = fake.calls.filter((c) => c.fn === 'shop_place_order').map((c) => c.args.p_key);
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  });
  test('a price change since the customer looked is refused and shown, never silently charged', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.shop')).click(); await addFromCatalog(page, 'FG-000001');
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
    fake.item('FG-000001').price = 400;                                                     // staff changed the price meanwhile
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.getByText(t('err.priceChanged'))).toBeVisible();
    expect(fake.orders).toHaveLength(0);
    await expect(page.getByRole('button', { name: new RegExp('฿450') })).toBeVisible();      // the new total (400 + 50)
  });
  test('the whole payment flow when the shop does not require the slip at checkout: QR for the exact amount, save image, slip preview, pending, rejected, paid', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.settings.require_payment_slip = false; await open(page, fake);
    const order = await placeOrder(page, fake, [['FG-000001', 2], ['FG-000020', 1]]);        // 960 + 50
    expect(order.total).toBe(1010);
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.unpaid'));
    await openFold(page, 'progress'); await expect(page.locator('.sp-steps li.now')).toContainText(t('st.new'));
    await pickMethod(page, 'qr');                                                            // the invoice offers SCB, BBL, the wallet and the PromptPay QR: picking the QR shows it
    await expect(page.getByTestId('pay-qr')).toBeVisible();
    await expect(page.locator('.sp-order-detail')).toContainText('฿1,010');
    const qrCall = fake.calls.find((c) => c.fn === 'finance_request_payment')!;
    expect(Object.keys(qrCall.args)).toEqual(['p_invoice']);                                  // the amount is not sent: the server owns it
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Save QR image|บันทึกรูป QR/ }).click()]);
    expect(dl.suggestedFilename()).toBe(`payment-qr-${order.order_no}.png`);
    await page.screenshot({ path: `${SHOTS}/payment-mobile.png`, fullPage: true });

    // slip: choosing a picture only shows a preview; nothing is sent until the customer confirms
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('slip-preview')).toBeVisible();
    expect(fake.count('finance_submit_evidence')).toBe(0);
    await page.getByRole('button', { name: /Submit this slip|ส่งสลิปนี้/ }).click();
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.pending'));
    expect(fake.count('finance_submit_evidence')).toBe(1);
    expect((await page.locator('.sp-order-detail .sp-pill').allTextContents()).join('|')).not.toContain(t('pay.paid'));   // a slip never makes an order paid
    await expect(page.getByRole('button', { name: t('od.cancel') })).toHaveCount(0);          // and a pending slip blocks self-cancel

    // staff reject the slip: the customer sees it and the reason
    fake.rejectSlip(order.order_no, 'ยอดเงินไม่ตรง');
    await page.getByRole('button', { name: t('od.refresh') }).click();
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.rejected'));
    await expect(page.locator('.sp-order-detail')).toContainText('ยอดเงินไม่ตรง');

    // staff verify a payment: only then is it paid
    fake.verifyPayment(order.order_no); fake.setStatus(order.order_no, 'shipped', 'Kerry TH123');
    await page.getByRole('button', { name: t('od.refresh') }).click();
    await expect(page.locator('.sp-order-detail .sp-pill').filter({ hasText: t('pay.paid') })).toBeVisible();
    await expect(page.locator('.sp-order-detail')).toContainText('Kerry TH123');
    await expect(page.locator('.sp-steps li.now')).toContainText(t('st.shipped'));
  });
  test('the shop closes while the customer is checking out: the server refuses and nothing is created', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.shop')).click(); await addFromCatalog(page, 'FG-000001');
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
    fake.settings.shop_open = false;                                                        // staff close the shop (the page still has its cached settings)
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.getByText(t('err.closed'))).toBeVisible();
    expect(fake.orders).toHaveLength(0);
  });
  test('shop closed from the start: checkout is not offered', async ({ page }) => {
    const fake = new FakeShop(); fake.settings.shop_open = false; await fake.install(page);
    await page.addInitScript(() => localStorage.setItem('tc.cart.v1:11111111-1111-4111-8111-111111111111', JSON.stringify([{ sku: 'FG-000001', qty: 1, name: 'x', price: 1, image: null, max: null }])));
    await page.goto('/#/app'); await tab(page, t('nav.cart')).click();
    await expect(page.getByText(t('shop.closed'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('cart.checkout') })).toBeDisabled();
  });
});

test.describe('orders', () => {
  test('list, filters, detail and self-service cancel rules', async ({ page }) => {
    const fake = new FakeShop();
    const mk = (key: string, status: string, paid: boolean) => { const r = fake.rpc('shop_place_order', { p_key: key, p_items: [{ sku_code: 'FG-000001', qty: 1 }], p_fulfilment: 'pickup', p_name: 'A', p_phone: '0812345678', p_address: null, p_note: null }) as { order: { order_no: string } }; const no = r.order.order_no; if (paid) fake.verifyPayment(no); fake.setStatus(no, status); return no; };
    const unpaidNew = mk('order-key-0001', 'new', false);
    mk('order-key-0002', 'preparing', true); mk('order-key-0003', 'shipped', true); mk('order-key-0004', 'completed', true);
    const confirmedUnpaid = mk('order-key-0005', 'confirmed', false);
    await open(page, fake); await tab(page, t('nav.orders')).click();
    await expect(page.locator('.sp-order')).toHaveCount(5);
    const n = async (f: K) => { await page.getByRole('tab', { name: t(f) }).click(); await page.waitForTimeout(150); return page.locator('.sp-order').count(); };
    expect(await n('ord.f.unpaid')).toBe(2); expect(await n('ord.f.to_ship')).toBe(1); expect(await n('ord.f.to_receive')).toBe(1); expect(await n('ord.f.done')).toBe(1); expect(await n('ord.f.cancelled')).toBe(0);
    await page.getByRole('tab', { name: t('ord.f.cancelled') }).click(); await expect(page.getByText(t('ord.emptyFilter'))).toBeVisible();
    await page.getByRole('tab', { name: t('ord.f.unpaid') }).click();
    await page.locator('.sp-order', { hasText: confirmedUnpaid }).click();
    await expect(page.getByRole('button', { name: t('od.cancel') })).toHaveCount(0);          // the shop has started: no self-cancel
    await page.getByRole('button', { name: t('common.back') }).click();
    await page.locator('.sp-order', { hasText: unpaidNew }).click();
    await page.getByRole('button', { name: t('od.cancel') }).click();
    await expect(page.locator('.sp-sheet')).toContainText(t('od.cancelBody'));
    await page.locator('.sp-sheet').getByRole('button', { name: t('od.confirmYes') }).click();
    await expect.poll(() => fake.orders.find((o) => o.order_no === unpaidNew)!.status).toBe('cancelled');   // wait for the server: "ยกเลิก" is also a substring of the cancel button's own label
    await expect(page.locator('.sp-order-detail')).toContainText(t('st.cancelled'));
    await page.screenshot({ path: `${SHOTS}/order-detail-mobile.png`, fullPage: true });
  });
  test('an empty history invites the first order', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake); await tab(page, t('nav.orders')).click();
    await expect(page.getByText(t('ord.empty'))).toBeVisible();
    await page.getByRole('button', { name: t('ord.start') }).click();
    await expect(cards(page).first()).toBeVisible();
  });
});

test.describe('account and language', () => {
  test('account summary, shortcuts and the English toggle', async ({ page }) => {
    const fake = new FakeShop(); fake.rpc('shop_place_order', { p_key: 'order-key-0001', p_items: [{ sku_code: 'FG-000001', qty: 1 }], p_fulfilment: 'pickup', p_name: 'A', p_phone: '0812345678', p_address: null, p_note: null });
    await open(page, fake); await tab(page, t('nav.account')).click();
    await expect(page.locator('.sp-me')).toContainText('สมชาย ใจดี');
    await expect(page.locator('.sp-stats')).toContainText('1');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(tab(page, 'Cart')).toBeVisible(); await expect(tab(page, 'Home')).toBeVisible();
    await page.locator('.sp-links').getByRole('button', { name: /My orders/ }).click();
    await expect(page.getByRole('heading', { name: 'My orders' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/account-en-mobile.png` });
  });
});

test.describe('DEV APP layouts keep the shop working', () => {
  const published = (cfg: unknown) => ({ version_id: 'v1', version_no: 1, config: cfg });
  test('a published layout restyles the app; cart, orders and shop stay reachable', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); const cfg = defaultLayout('Layout Shop'); fake.layout = published(cfg);
    await open(page, fake);
    await expect(page.locator('.phone-top')).toContainText('Layout Shop');
    for (const label of ['หน้าหลัก', 'สินค้า', 'ตะกร้า', 'คำสั่งซื้อ', 'บัญชีของฉัน']) await expect(tab(page, label)).toBeVisible();
    await expect(page.locator('.phone-nav button')).toHaveCount(5);                          // rewards / events are off by default
    await tab(page, 'สินค้า').click(); await expect(cards(page).first()).toBeVisible();
    await addFromCatalog(page, 'FG-000001');
    await tab(page, 'ตะกร้า').click(); await expect(page.locator('.sp-lines > li')).toHaveCount(1);
    await tab(page, 'คำสั่งซื้อ').click(); await expect(page.getByText(t('ord.empty'))).toBeVisible();
  });
  test('a layout saved before the cart existed gets the cart tab automatically', async ({ page }) => {
    const fake = new FakeShop(); const cfg = JSON.parse(JSON.stringify(defaultLayout('Old Shop')));
    cfg.nav = cfg.nav.filter((n: { key: string }) => n.key !== 'cart'); delete cfg.pages.cart; fake.layout = published(cfg);
    await open(page, fake);
    await expect(tab(page, 'ตะกร้า')).toBeVisible();
    await tab(page, 'ตะกร้า').click(); await expect(page.getByText(t('cart.empty'))).toBeVisible();
  });
  test('a layout that tries to hide the cart or orders is not applied; the built-in app (which works) is used', async ({ page }) => {
    const fake = new FakeShop(); const cfg = defaultLayout('Bad Shop'); cfg.nav.find((n) => n.key === 'pay')!.visible = false; fake.layout = published(cfg);
    await open(page, fake);
    await expect(page.locator('.phone-top')).not.toContainText('Bad Shop');
    await expect(tab(page, t('nav.orders'))).toBeVisible();
  });
  test('a product tapped in a layout product list opens the real product page', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); const cfg = defaultLayout('Layout Shop');
    cfg.home = [{ id: 'pc1', type: 'productCard', props: { title: 'Picks', data: { source: 'db:sku_catalog', fields: ['sku_code', 'name_full', 'price'], filters: [], sort: null, limit: 4, formats: {}, agg: null }, imageField: '', titleField: 'name_full', priceField: 'price', subField: 'sku_code', badgeField: '', layout: 'list', linkTab: 'shop', hideWhenEmpty: false },
      span: { mobile: 12, tablet: 12, desktop: 12 }, hidden: { mobile: false, tablet: false, desktop: false }, style: { padding: 0, marginTop: 0, background: '', textColor: '', radius: 0, align: 'left' }, visibility: { groups: [] } } as never];
    fake.layout = published(cfg);
    await open(page, fake);
    await page.locator('.ca-pcard').nth(1).click();                                         // the layout's list comes from the catalogue data source
    await expect(page.locator('.sp-detail')).toContainText('FG-000002');
    await expect(page.locator('.sp-buy').getByRole('button', { name: t('p.add'), exact: true })).toBeVisible();
  });
});

test.describe('responsive and accessible', () => {
  for (const vp of [{ n: 'phone', w: 360, h: 740 }, { n: 'desktop', w: 1440, h: 900 }]) {
    test(`no horizontal overflow on any tab (${vp.n})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const fake = new FakeShop(); fake.decorate(); await open(page, fake);
      for (const l of ['nav.home', 'nav.shop', 'nav.cart', 'nav.orders', 'nav.account'] as K[]) { await tab(page, t(l)).click(); await page.waitForTimeout(250); await noOverflow(page); }
      await tab(page, t('nav.shop')).click(); await expect(cards(page).first()).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/catalog-${vp.n}.png` });
      const box = await page.locator('.phone').boundingBox();
      if (vp.w <= 560) expect(box!.width).toBeLessThanOrEqual(vp.w); else expect(box!.width).toBeLessThanOrEqual(481);
    });
  }
  test('axe: no critical or serious violations on the main screens', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    const check = async (name: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
      expect(bad, `${name}: ${bad.join('\n')}`).toEqual([]);
    };
    await check('home');
    await tab(page, t('nav.shop')).click(); await expect(cards(page).first()).toBeVisible(); await check('catalog');
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.details'), exact: true }).click(); await expect(page.locator('.sp-detail')).toBeVisible(); await check('product');
    await page.locator('.sp-buy').getByRole('button', { name: t('p.add'), exact: true }).click();
    await tab(page, t('nav.cart')).click(); await expect(page.locator('.sp-lines > li')).toHaveCount(1); await check('cart');
    await page.getByRole('button', { name: t('cart.checkout') }).click(); await check('checkout');
    await tab(page, t('nav.orders')).click(); await check('orders');
    await tab(page, t('nav.account')).click(); await check('account');
  });
});
