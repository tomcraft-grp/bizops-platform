// Feedback round 2, browser level, against the FAKE backend (nothing here reaches the real Supabase project):
//   FB-001002  "order again" after the shop cancelled an order
//   FB-001019  a price check that never answers must not freeze the checkout (Android: "press and nothing happens, I have to kill the app")
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);

async function open(page: Page, fake: FakeShop, hash = '/app') {
  await fake.install(page);
  await page.goto(`/#${hash}`);
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const place = (fake: FakeShop, key: string, qty: number) => {
  const r = fake.rpc('shop_place_order', { p_key: key, p_items: [{ sku_code: 'FG-000001', qty }], p_fulfilment: 'pickup', p_name: 'A', p_phone: '0812345678', p_address: null, p_note: null }) as { order: { order_no: string } };
  return r.order.order_no;
};

test.describe('order again (FB-001002)', () => {
  test('a cancelled order can be put back in the cart in one tap; an order that is still running cannot', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const declined = place(fake, 'order-key-0001', 2);
    fake.setStatus(declined, 'cancelled', 'ขออภัย สินค้าหมด');
    const running = place(fake, 'order-key-0002', 1);
    fake.setStatus(running, 'preparing');
    await open(page, fake);
    await tab(page, t('nav.orders')).click();

    // the order that is still being prepared offers no "order again"
    await page.locator('.sp-order', { hasText: running }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    await expect(page.getByRole('button', { name: t('od.again') })).toHaveCount(0);
    await page.getByRole('button', { name: t('common.back') }).click();

    // the cancelled one does, and the cart ends up with the same item and quantity
    await page.locator('.sp-order', { hasText: declined }).click();
    await page.getByRole('button', { name: t('od.again') }).click();
    await expect(page.locator('.sp-lines > li')).toHaveCount(1);
    await expect(page.locator('.sp-lines > li').first()).toContainText('FG-000001');
    await expect(page.locator('.sp-summary')).toContainText('฿640');                // 2 x 320, priced by the (fake) server, not by the old order
    expect(fake.calls.filter((c) => c.fn === 'shop_quote').pop()!.args.p_items).toEqual([{ sku_code: 'FG-000001', qty: 2 }]);

    // tapping it again merges (it does not make a second line)
    await tab(page, t('nav.orders')).click();
    await page.locator('.sp-order', { hasText: declined }).click();
    await page.getByRole('button', { name: t('od.again') }).click();
    await expect(page.locator('.sp-lines > li')).toHaveCount(1);
    await expect(page.locator('.sp-summary')).toContainText('฿1,280');              // 4 x 320
  });
});

test.describe('online shop orders on the Orders page (FB-001013)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const staff = async (page: Page, fake: FakeShop, lang: 'en' | 'th' = 'en') => {
    fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff';
    await fake.install(page);
    await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
    await page.goto('/#/orders');
    await expect(page.getByRole('heading', { name: lang === 'en' ? 'Orders' : 'คำสั่งซื้อ' }).first()).toBeVisible();
  };

  test('the latest online orders are listed on /orders, read-only, with a link to manage them', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const a = place(fake, 'order-key-0001', 2); const b = place(fake, 'order-key-0002', 1);
    fake.setStatus(b, 'preparing');
    await staff(page, fake);
    const card = page.locator('section.card', { hasText: 'Online shop (LINE app)' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(a); await expect(card).toContainText(b);
    await expect(card).toContainText('1 new order(s) to look at');
    await expect(card.getByRole('row', { name: new RegExp(a) })).toContainText('฿');
    // read-only: no status buttons, rows do not open anything, one link to the page that manages them
    await expect(card.getByRole('button', { name: /Mark as/ })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Open Online shop' })).toHaveAttribute('href', /#\/shop-admin$/);
    // it asked the staff-only function for a short page, not for everything
    expect(fake.calls.filter((c) => c.fn === 'shop_admin_orders').pop()!.args.p_limit).toBe(6);
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/orders-online-card.png` });
  });
  test('Thai wording, and an empty shop says so', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    await staff(page, fake, 'th');
    const card = page.locator('section.card', { hasText: 'ร้านออนไลน์ (แอป LINE)' });
    await expect(card).toContainText('ยังไม่มีคำสั่งซื้อออนไลน์');
    await expect(card.getByRole('link', { name: 'เปิดหน้าร้านออนไลน์' })).toBeVisible();
  });
  test('a failed load shows a retry button and the rest of the Orders page keeps working', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); const no = place(fake, 'order-key-0001', 1);
    fake.failNext('shop_admin_orders', 1);
    await staff(page, fake);
    const card = page.locator('section.card', { hasText: 'Online shop (LINE app)' });
    await expect(card).toContainText('Could not load the online shop orders.');
    await expect(page.getByRole('heading', { name: 'Orders' }).first()).toBeVisible();
    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(card).toContainText(no);
    await expect(card).not.toContainText('Could not load the online shop orders.');
  });
});

test.describe('brand filter: products with no brand (FB-001018)', () => {
  const cards = (page: Page) => page.locator('.sp-card[data-sku]');
  test('"No brand" is offered, with its count, and lists exactly the products that have no brand', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const none = fake.items.filter((i) => !i.brand);
    expect(none.length).toBeGreaterThan(0);                                              // the fixture, like the real shop, has products without a brand
    await open(page, fake);
    await tab(page, t('nav.shop')).click();
    const brand = page.getByLabel(t('cat.brand'), { exact: true });          // exact: the search box's label also contains the word "brand"
    await expect(brand.locator('option')).toContainText([t('cat.allBrands')]);
    const choice = `${t('cat.noBrand')} (${none.length})`;
    await expect(brand.locator('option', { hasText: t('cat.noBrand') })).toHaveText(choice);
    await brand.selectOption({ label: choice });
    await expect(cards(page)).toHaveCount(none.length);
    const skus = await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-sku')));
    expect(skus.sort()).toEqual(none.map((i) => i.sku_code).sort());
    expect(fake.calls.filter((c) => c.fn === 'shop_catalog').pop()!.args.p_brand).toBe('__none__');
    // a named brand still works, and "all brands" brings everything back
    const relx = fake.items.filter((i) => i.brand === 'RELX').length;
    await brand.selectOption({ label: `RELX (${relx})` });
    await expect(cards(page)).toHaveCount(relx);
    await brand.selectOption({ label: t('cat.allBrands') });
    await expect(cards(page).first()).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/brand-no-brand.png` });
  });
  test('a database without the migration offers no such choice, and nothing breaks', async ({ page }) => {
    const old = new FakeShop(); old.decorate(); old.noBrandFilter = false;
    await open(page, old);
    await tab(page, t('nav.shop')).click();
    const brand = page.getByLabel(t('cat.brand'), { exact: true });
    await expect(brand).toBeVisible();                                                    // the named brands are still there
    await expect(brand.locator('option', { hasText: t('cat.noBrand') })).toHaveCount(0);
    await expect(cards(page).first()).toBeVisible();
  });
});

test.describe('a stalled connection (FB-001019)', () => {
  test('a price check that never answers ends in a "try again" button, and the checkout works after it', async ({ page }) => {
    test.setTimeout(90_000);
    const fake = new FakeShop(); fake.decorate();
    await open(page, fake);
    await tab(page, t('nav.shop')).click();
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.add') }).click();

    // the first price check is never answered (phone lost its signal); the next ones go to the normal fake
    let seen = 0;
    await page.route('**/rest/v1/rpc/shop_quote', (route) => { seen++; return seen === 1 ? undefined : route.fallback(); });

    await tab(page, t('nav.cart')).click();
    const checkout = page.getByRole('button', { name: new RegExp(`${t('cart.checkout')}|${t('cart.checking')}`) });
    await expect(checkout).toBeDisabled();                                            // waiting for the price check
    // before the fix this stayed "checking…" for ever. Now the 25 s limit turns it into a clear message with a retry button.
    const retry = page.getByRole('button', { name: t('common.retry') });
    await expect(retry).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole('alert')).toContainText(t('err.network'));

    await retry.click();
    await expect(page.locator('.sp-summary')).toContainText('฿320');
    await expect(page.getByRole('button', { name: t('cart.checkout') })).toBeEnabled();
    expect(seen).toBeGreaterThanOrEqual(2);
  });
});
