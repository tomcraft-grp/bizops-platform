// A picture added on the back-office Products page reaches the online shop (it used to stay in that browser), and pictures that are only in this browser can be sent in one go. Against the
// fake backend: this proves the SCREENS and what they send; who may save a picture is decided by the database (shop_admin_save_content, storage policies).
import { expect, test, type Page, type Route } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop, IMG } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const t = (k: K) => tr('th', k);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const reg = (code: string, name: string) => ({ sku_code: code, legacy_sku_code: null, sku_category: 'FG', origin: 'import', name_full: name, brand: 'BRAND', product_type: 'Puff', domain: 'POD', pack_qty: null, unit: 'EA', unit_count: null, barcode: null, status: 'active', cost_price: 100, retail_price: 200,
  selling_price: 200, friend_price: null, wholesale_price: null, ecommerce_price: null, needs_review: false, review_notes: null, updated_at: new Date().toISOString() });

async function boot(page: Page, o: { refuse?: string } = {}) {
  const shop = new FakeShop(); shop.profile.role = 'SUPER_ADMIN'; shop.profile.display_name = 'Owner'; shop.shopPathsOnly = true;
  for (const i of shop.items) i.image_urls = [];
  await shop.install(page);
  await page.route('https://hlvravynjalculvplrxc.supabase.co/rest/v1/rpc/sku_changes_since', (r: Route) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ cursor: 1, full: true, rows: [reg('FG-000001', 'Grape 20000'), reg('FG-000002', 'Mint 20000')] }) }));
  if (o.refuse) await page.route('https://hlvravynjalculvplrxc.supabase.co/storage/v1/object/shop-products/**', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: cors }) : r.fulfill({ status: 403, contentType: 'application/json', headers: cors, body: JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: o.refuse }) })));
  await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#/products'); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible();
  return { shop, errors };
}
const drawer = (page: Page) => page.locator('aside.drawer');
async function images(page: Page, name: RegExp) { await page.getByRole('row', { name }).click(); await drawer(page).getByRole('tab', { name: /Images/ }).or(drawer(page).getByRole('button', { name: /Images/ })).first().click(); }
const add = (page: Page, n = 1) => drawer(page).locator('input[type=file]').setInputFiles(Array.from({ length: n }, (_, i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#' + i + Math.random())]) })));
const saved = (shop: FakeShop) => shop.calls.filter((c) => c.fn === 'shop_admin_save_content');

test('a picture added on Products is sent to the shop\'s storage, saved on the SKU, and the customer sees it', async ({ page }) => {
  const { shop, errors } = await boot(page); await images(page, /Grape 20000/);
  await expect(drawer(page).getByTestId('shop-pictures')).toContainText('No picture in the online shop yet');
  await add(page);
  await expect(drawer(page).getByTestId('shop-pictures').locator('img')).toHaveCount(1, { timeout: 15_000 });
  const up = shop.uploads.filter((u) => u.path.startsWith('shop-products/')); expect(up).toHaveLength(1); expect(up[0].path).toMatch(/^shop-products\/FG-000001\/[A-Za-z0-9]+\.(webp|jpg|png)$/);
  expect(saved(shop)).toHaveLength(1); expect(saved(shop)[0].args.p_sku).toBe('FG-000001'); expect(Object.keys(saved(shop)[0].args.p_patch as object)).toEqual(['image_paths']);      // only the pictures: a description or price is never touched
  expect(shop.shopPaths.get('FG-000001')).toHaveLength(1); expect(`shop-products/${shop.shopPaths.get('FG-000001')![0]}`).toBe(up[0].path); expect(errors).toEqual([]);
  // the customer
  const url = shop.item('FG-000001').image_urls[0]; expect(url.startsWith(IMG)).toBe(true);
  const c = await page.context().newPage(); shop.profile.role = 'USER'; await shop.install(c); await c.setViewportSize({ width: 390, height: 844 }); await c.goto('/#/app'); await c.locator('.phone-nav').getByRole('button', { name: /สินค้า|Products/ }).click();
  await expect(c.locator('.sp-card[data-sku="FG-000001"] img').first()).toHaveAttribute('src', url);
});

test('several pictures, choosing the main one, removing one', async ({ page }) => {
  const { shop } = await boot(page); await images(page, /Grape 20000/); await add(page, 3); const box = drawer(page).getByTestId('shop-pictures'); await expect(box.locator('img')).toHaveCount(3, { timeout: 20_000 });
  const [a, b, c] = shop.shopPaths.get('FG-000001')!; await box.getByRole('button', { name: 'Make main' }).nth(1).click(); await expect.poll(() => shop.shopPaths.get('FG-000001')).toEqual([c, a, b]);
  await box.getByRole('button', { name: 'Remove from the shop' }).first().click(); await expect.poll(() => shop.shopPaths.get('FG-000001')).toEqual([a, b]);
});

test('at most six: the rest stay here and that is said', async ({ page }) => {
  const { shop } = await boot(page); shop.shopPaths.set('FG-000001', Array.from({ length: 5 }, (_, i) => `FG-000001/old${i}.webp`)); await images(page, /Grape 20000/); await add(page, 2);
  await expect(page.getByText(/at most 6 pictures/)).toBeVisible({ timeout: 20_000 }); await expect.poll(() => shop.shopPaths.get('FG-000001')?.length).toBe(6); expect(shop.shopPaths.get('FG-000001')!.slice(0, 5)).toEqual(Array.from({ length: 5 }, (_, i) => `FG-000001/old${i}.webp`));
});

test('the shop refuses: it says the picture is only in this browser (it no longer says "uploaded" and nothing more), and it can be sent later', async ({ page }) => {
  const { shop } = await boot(page, { refuse: 'new row violates row-level security policy' }); await images(page, /Grape 20000/); await add(page);
  await expect(page.getByText(/Saved in this browser only/)).toBeVisible({ timeout: 15_000 }); expect(saved(shop)).toHaveLength(0);
  await drawer(page).getByRole('button', { name: /Close/ }).first().click(); await expect(page.getByTestId('pictures-only-here')).toContainText('1 products have pictures only in this browser');
});

test('pictures from before: found in this browser, sent in one click, the notice goes away; nothing is sent twice', async ({ page }) => {
  // a picture that is only in this browser: added while the shop refuses, then the shop accepts again
  const { shop, errors } = await boot(page, { refuse: 'down' });
  for (const n of [/Grape 20000/, /Mint 20000/]) { await images(page, n); await add(page); await expect(page.getByText(/Saved in this browser only/).first()).toBeVisible({ timeout: 15_000 }); await drawer(page).getByRole('button', { name: /Close/ }).first().click(); await page.waitForTimeout(400); }
  await page.unroute('https://hlvravynjalculvplrxc.supabase.co/storage/v1/object/shop-products/**'); shop.uploads.length = 0;
  const bar = page.getByTestId('pictures-only-here'); await expect(bar).toContainText('2 products'); await bar.getByRole('button', { name: 'Send them to the online shop' }).click();
  await expect(bar).toContainText('Sent 2 of 2', { timeout: 20_000 }); await expect(bar.getByRole('button')).toHaveCount(0);
  expect([...shop.shopPaths.keys()].sort()).toEqual(['FG-000001', 'FG-000002']); expect(shop.uploads.filter((u) => u.path.startsWith('shop-products/'))).toHaveLength(2);
  await page.reload(); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible(); await page.waitForTimeout(1500); await expect(bar).toHaveCount(0); expect(errors).toEqual([]);
});

test('a SKU that already has shop pictures is left alone; the shop being unreachable shows no notice and breaks nothing', async ({ page }) => {
  const { shop, errors } = await boot(page, { refuse: 'down' }); await images(page, /Grape 20000/); await add(page); await expect(page.getByText(/Saved in this browser only/)).toBeVisible({ timeout: 15_000 });
  shop.shopPaths.set('FG-000001', ['FG-000001/mine.webp']); await page.reload(); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible(); await page.waitForTimeout(1500); await expect(page.getByTestId('pictures-only-here')).toHaveCount(0);
  shop.failNext('shop_admin_products', 99); await page.reload(); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible(); await page.waitForTimeout(1000); await expect(page.getByTestId('pictures-only-here')).toHaveCount(0); expect(errors).toEqual([]);
});

test('formal Thai on the payment screens', async () => {
  for (const k of ['co.slipTitle', 'co.slipHelp', 'co.slipMissing', 'qr.step3', 'sc.review', 'sc.attentionBody', 'sv.ok', 'sv.differs', 'sv.tick', 'sv.must', 'sv.note'] as K[]) { expect(t(k), k).not.toMatch(/คุณ|ค่ะ|ครับ|ใช้ได้เลย|ไหม|กดอีกครั้ง/); expect(t(k).length, k).toBeGreaterThan(5); }
  expect(t('co.slipChoose')).toBe('แนบรูปภาพสลีปการโอนเงิน'); expect(t('co.place')).toBe('ยืนยันคำสั่งซื้อสินค้า');            // the two labels the owner dictated stay word for word
});
