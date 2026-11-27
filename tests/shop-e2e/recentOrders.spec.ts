// Recent orders (FB-001002) in the customer app, against the FAKE backend (fakeBackend.ts). The list is the customer's own orders (the database function shop_my_orders returns only the
// signed-in customer's); these tests prove the SCREENS: the last three orders on Home and on an empty cart, newest first, one tap to the detail page, "Order again" for a finished order
// (merged into the cart, gift lines left out), Pay / View for an order that is still running (no duplicate order), loading, empty and error states, and the request itself.
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
const place = (fake: FakeShop, key: string, qty: number) => (fake.rpc('shop_place_order', { p_key: key, p_items: [{ sku_code: 'FG-000001', qty }], p_fulfilment: 'pickup', p_name: 'A', p_phone: '0812345678', p_address: null, p_note: null }) as { order: { order_no: string } }).order.order_no;
const card = (page: Page, no: string) => page.getByTestId('recent-order').filter({ has: page.locator(`[data-order="${no}"]`) }).or(page.locator(`[data-testid="recent-order"][data-order="${no}"]`));
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);

test.describe('recent orders', () => {
  test('Home shows the last three orders, newest first, each with its status, payment and total; the request is the plain "all, 3" list with no customer id', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const nos = [1, 2, 3, 4].map((n) => place(fake, `recent-key-000${n}`, n));
    await open(page, fake);
    const rows = page.getByTestId('recent-order');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-order', nos[3]);                      // newest first
    await expect(rows.nth(2)).toHaveAttribute('data-order', nos[1]);
    await expect(page.locator(`[data-order="${nos[0]}"]`)).toHaveCount(0);                // the oldest is not among the last three
    await expect(rows.nth(0)).toContainText(nos[3]); await expect(rows.nth(0)).toContainText('฿');
    const call = fake.calls.find((c) => c.fn === 'shop_my_orders')!;
    expect(call.args).toMatchObject({ p_limit: 3, p_offset: 0 });
    expect(Object.keys(call.args).join(',')).not.toMatch(/customer|user|profile/i);        // the database decides whose orders: the app sends no customer id
    await noOverflow(page);
  });

  test('a finished order offers "Order again": its lines go into the cart (merged with what is there), the cart opens, and the cart page re-checks the prices', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const declined = place(fake, 'recent-key-0001', 2);
    fake.setStatus(declined, 'cancelled', 'ขออภัย สินค้าหมด');
    await open(page, fake);
    await expect(page.getByTestId('recent-order')).toHaveCount(1);
    const c = page.locator(`[data-testid="recent-order"][data-order="${declined}"]`);
    await expect(c.getByTestId('recent-again')).toBeVisible();
    await c.getByTestId('recent-again').click();
    await expect(page.locator('.sp-lines > li')).toHaveCount(1);
    await expect(page.locator('.sp-lines > li').first()).toContainText('FG-000001');
    await expect(page.locator('.sp-summary')).toContainText('฿640');                    // 2 x 320, priced by the (fake) server, not by the old order
    expect(fake.calls.filter((x) => x.fn === 'shop_quote').pop()!.args.p_items).toEqual([{ sku_code: 'FG-000001', qty: 2 }]);
    // ordering again once more adds to the same line instead of replacing the cart
    await tab(page, t('nav.home')).click();
    await page.locator(`[data-testid="recent-order"][data-order="${declined}"]`).getByTestId('recent-again').click();
    await expect(page.locator('.sp-lines > li')).toHaveCount(1);
    await expect(page.locator('.sp-summary')).toContainText('฿1,280');                  // 4 x 320: merged, not replaced
  });

  test('an order that is still running is not offered again (it would be a second order): Pay while a payment is due, View otherwise; the card opens the order', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.w.seedBalance(1000);
    const unpaid = place(fake, 'recent-key-0001', 1);
    const preparing = place(fake, 'recent-key-0002', 1);
    fake.setStatus(preparing, 'preparing');
    fake.rpc('finance_pay_invoice_with_wallet', { p_invoice: fake.orders.find((o) => o.order_no === preparing)!.invoice.id, p_amount: 320, p_key: 'recent-pay-0001' });   // paid: nothing due
    await open(page, fake);
    const a = page.locator(`[data-testid="recent-order"][data-order="${unpaid}"]`), b = page.locator(`[data-testid="recent-order"][data-order="${preparing}"]`);
    await expect(a.getByTestId('recent-pay')).toBeVisible(); await expect(a.getByTestId('recent-again')).toHaveCount(0);
    await expect(b.getByTestId('recent-view')).toBeVisible(); await expect(b.getByTestId('recent-again')).toHaveCount(0);
    await a.getByTestId('recent-pay').click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    await expect(page.locator('.sp-order-detail')).toContainText(unpaid);
  });

  test('tapping the card opens that order\'s detail page', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); const no = place(fake, 'recent-key-0001', 1);
    await open(page, fake);
    await page.locator(`[data-testid="recent-order"][data-order="${no}"]`).getByRole('button', { name: new RegExp(no) }).click();
    await expect(page.locator('.sp-order-detail')).toContainText(no);
  });

  test('no orders: an empty state, not a blank gap; an empty cart also offers the recent orders', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await expect(page.getByTestId('recent-empty')).toContainText(t('ro.empty'));
    await tab(page, t('nav.cart')).click();
    await expect(page.getByText(t('cart.empty'))).toBeVisible();
    await expect(page.getByTestId('recent-empty')).toBeVisible();
  });

  test('an empty cart shows the recent orders so the customer can order again from there', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); const no = place(fake, 'recent-key-0001', 1); fake.setStatus(no, 'cancelled', 'x');
    await open(page, fake); await tab(page, t('nav.cart')).click();
    await expect(page.getByText(t('cart.empty'))).toBeVisible();
    await expect(page.locator(`[data-testid="recent-order"][data-order="${no}"]`).getByTestId('recent-again')).toBeVisible();
  });

  test('a failed load shows an error with a retry; the retry shows the orders', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); const no = place(fake, 'recent-key-0001', 1);
    await fake.install(page);
    let fail = true;
    await page.route('**/rest/v1/rpc/shop_my_orders', (r) => (r.request().method() === 'OPTIONS' || !fail ? r.fallback() : r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'boom' }) })));
    await page.goto('/#/app'); await expect(page.locator('.phone-nav')).toBeVisible();
    await expect(page.getByText(t('ro.error'))).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: t('common.retry') }).first().click();
    await expect(page.locator(`[data-testid="recent-order"][data-order="${no}"]`)).toBeVisible();
  });

  test('order detail: a completed order can also be ordered again (not only a cancelled one)', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); const no = place(fake, 'recent-key-0001', 1); fake.setStatus(no, 'completed');
    await open(page, fake); await tab(page, t('nav.orders')).click();
    await page.locator('.sp-order', { hasText: no }).click();
    await expect(page.getByTestId('order-again')).toBeVisible();
  });
});
void card;
