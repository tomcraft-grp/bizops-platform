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
