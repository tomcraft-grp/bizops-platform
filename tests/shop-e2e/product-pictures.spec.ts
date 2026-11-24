// Product pictures: they go to the online shop by themselves (after a countdown in which each can be taken out), X takes one off the customer pages without deleting it, and what was taken out does
// not come back. Against the fake backend: this proves the SCREENS and what they send; who may save a picture is decided by the database (shop_admin_save_content, storage policies).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop, IMG } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const t = (k: K) => tr('th', k);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const HOST = 'https://hlvravynjalculvplrxc.supabase.co';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const reg = (code: string, name: string) => ({ sku_code: code, legacy_sku_code: null, sku_category: 'FG', origin: 'import', name_full: name, brand: 'BRAND', product_type: 'Puff', domain: 'POD', pack_qty: null, unit: 'EA', unit_count: null, barcode: null, status: 'active', cost_price: 100, retail_price: 200,
  selling_price: 200, friend_price: null, wholesale_price: null, ecommerce_price: null, needs_review: false, review_notes: null, updated_at: new Date().toISOString() });
const SHOTS = process.env.SHOP_SHOTS ?? 'test-results/shop';
const UPLOAD = `${HOST}/storage/v1/object/shop-products/**`;

async function boot(page: Page, o: { refuse?: string; role?: string; offline?: boolean; lang?: 'en' | 'th' } = {}) {
  const shop = new FakeShop(); shop.profile.role = o.role ?? 'SUPER_ADMIN'; shop.profile.display_name = 'Owner'; shop.shopPathsOnly = true;
  for (const i of shop.items) i.image_urls = [];
  await shop.install(page);
  await page.route(`${HOST}/rest/v1/rpc/sku_changes_since`, (r: Route) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ cursor: 1, full: true, rows: [reg('FG-000001', 'Grape 20000'), reg('FG-000002', 'Mint 20000')] }) }));
  if (o.refuse) await refuse(page, o.refuse);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, o.lang ?? 'en');
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#/products'); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible();
  return { shop, errors };
}
const refuse = (page: Page, why: string) => page.route(UPLOAD, (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: cors }) : r.fulfill({ status: 403, contentType: 'application/json', headers: cors, body: JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: why }) })));
const accept = (page: Page) => page.unroute(UPLOAD);
const drawer = (page: Page) => page.locator('aside.drawer');
const card = (page: Page) => page.getByTestId('auto-pictures');
const panel = (page: Page) => drawer(page).getByTestId('shop-pictures');
const shown = (page: Page) => drawer(page).getByTestId('shop-pic');
async function images(page: Page, name: RegExp) { if (!(await drawer(page).count())) await page.getByRole('row', { name }).click();       // after a refresh the address keeps the product open
  await drawer(page).getByRole('tab', { name: /Images|รูปภาพ/ }).or(drawer(page).getByRole('button', { name: /Images|รูปภาพ/ })).first().click(); await expect(panel(page)).toBeVisible(); }
const shut = async (page: Page) => { await drawer(page).getByRole('button', { name: /Close|ปิด/ }).first().click(); await expect(drawer(page)).toHaveCount(0); };
const add = (page: Page, n = 1) => drawer(page).locator('input[type=file]').setInputFiles(Array.from({ length: n }, (_, i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#' + i + Math.random())]) })));
const saved = (shop: FakeShop) => shop.calls.filter((c) => c.fn === 'shop_admin_save_content');
const ups = (shop: FakeShop) => shop.uploads.filter((u) => u.path.startsWith('shop-products/'));
/** leaves n pictures of a product only in this browser (the shop refuses them), then the shop accepts again and the page is opened anew */
async function leaveBehind(page: Page, shop: FakeShop, name: RegExp, n = 1) {
  await refuse(page, 'down'); await images(page, name); await add(page, n); await expect(page.getByText(/Saved in this browser only|หน้าร้านไม่.*รับรูป|เบราว์เซอร์นี้เท่านั้น/).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500); await shut(page); await accept(page); shop.uploads.length = 0; shop.calls.length = 0;
}

test.describe('a picture added on Products', () => {
  test('is stored in the shop, saved on the SKU, and the customer sees it', async ({ page }) => {
    const { shop, errors } = await boot(page); await images(page, /Grape 20000/);
    await expect(panel(page)).toContainText('No picture in the online shop yet');
    await add(page); await expect(shown(page)).toHaveCount(1, { timeout: 15_000 });
    expect(ups(shop)).toHaveLength(1); expect(ups(shop)[0].path).toMatch(/^shop-products\/FG-000001\/m-[A-Za-z0-9]{20,40}\.(webp|jpg|png)$/);
    expect(saved(shop)).toHaveLength(1); expect(saved(shop)[0].args.p_sku).toBe('FG-000001'); expect(Object.keys(saved(shop)[0].args.p_patch as object)).toEqual(['image_paths']);      // only the pictures: a description or price is never touched
    expect(`shop-products/${shop.shopPaths.get('FG-000001')![0]}`).toBe(ups(shop)[0].path);
    await expect(drawer(page).getByTestId('local-shop-status')).toContainText('Shown in the online shop'); expect(errors).toEqual([]);
    const url = shop.item('FG-000001').image_urls[0]; expect(url.startsWith(IMG)).toBe(true);
    const c = await page.context().newPage(); shop.profile.role = 'USER'; await shop.install(c); await c.setViewportSize({ width: 390, height: 844 }); await c.goto('/#/app'); await c.locator('.phone-nav').getByRole('button', { name: /สินค้า|Products/ }).click();
    await expect(c.locator('.sp-card[data-sku="FG-000001"] img').first()).toHaveAttribute('src', url);
  });
  test('at most six: the rest stay here and that is said', async ({ page }) => {
    const { shop } = await boot(page); const old = Array.from({ length: 5 }, (_, i) => `FG-000001/old${i}.webp`); shop.shopPaths.set('FG-000001', old); shop.item('FG-000001').image_urls = old.map((x) => `${IMG}/${x}`);
    await images(page, /Grape 20000/); await add(page, 2); await expect(page.getByText(/at most 6 pictures/)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => shop.shopPaths.get('FG-000001')?.length).toBe(6); expect(shop.shopPaths.get('FG-000001')!.slice(0, 5)).toEqual(old);
    await expect(card(page)).toHaveCount(0);                                                        // a full product is not offered again and again
  });
  test('an edit begun before a picture was added does not take it away when it is saved', async ({ page }) => {
    const { shop } = await boot(page); await page.route(`${HOST}/rest/v1/rpc/sku_set_details`, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(reg('FG-000001', 'Grape 20000')) }));
    await page.getByRole('row', { name: /Grape 20000/ }).click(); await drawer(page).getByRole('textbox', { name: 'Description' }).fill('new text');
    await drawer(page).getByRole('tab', { name: /Images/ }).or(drawer(page).getByRole('button', { name: /Images/ })).first().click(); await add(page); await expect(shown(page)).toHaveCount(1, { timeout: 15_000 });
    await drawer(page).getByRole('tab', { name: /Details/ }).or(drawer(page).getByRole('button', { name: /Details/ })).first().click(); await drawer(page).getByRole('button', { name: 'Save changes' }).click(); await expect(page.getByText('Product saved')).toBeVisible();
    await drawer(page).getByRole('tab', { name: /Images/ }).or(drawer(page).getByRole('button', { name: /Images/ })).first().click(); await expect(drawer(page).getByTestId('local-shop-status')).toHaveCount(1); expect(shop.shopPaths.get('FG-000001')).toHaveLength(1);
  });
});

test.describe('X on a picture', () => {
  test('off the customer pages at once, the others stay, the file is kept, it stays off after a refresh, and it can be shown again', async ({ page }) => {
    const { shop, errors } = await boot(page); await images(page, /Grape 20000/); await add(page, 3); await expect(shown(page)).toHaveCount(3, { timeout: 20_000 });
    const [a, b, c] = shop.shopPaths.get('FG-000001')!;
    await panel(page).getByRole('button', { name: 'Make main' }).nth(1).click(); await expect.poll(() => shop.shopPaths.get('FG-000001')).toEqual([c, a, b]); await expect(shown(page).first().locator('img')).toHaveAttribute('src', new RegExp(c.split('/')[1]));
    await shown(page).nth(1).getByRole('button', { name: 'Remove from the shop' }).click();
    await expect(shown(page)).toHaveCount(2); await expect.poll(() => shop.shopPaths.get('FG-000001')).toEqual([c, b]);
    expect(shop.stored.size).toBe(3);                                                                // nothing was deleted
    await expect(drawer(page).getByTestId('shop-pic-off')).toHaveCount(1); await expect(drawer(page).getByTestId('local-shop-status').filter({ hasText: 'Not shown in the online shop' })).toHaveCount(1);
    expect(shop.item('FG-000001').image_urls).toEqual([c, b].map((x) => `${IMG}/${x}`));              // what the customer's catalogue and home answer
    const n = ups(shop).length; await page.reload(); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible(); await page.waitForTimeout(2500);
    await expect(card(page)).toHaveCount(0); expect(ups(shop)).toHaveLength(n); expect(shop.shopPaths.get('FG-000001')).toEqual([c, b]);      // not offered, not sent again
    await images(page, /Grape 20000/); await expect(shown(page)).toHaveCount(2);
    await drawer(page).getByTestId('shop-pic-off').getByRole('button', { name: 'Show again' }).click(); await expect(shown(page)).toHaveCount(3); await expect.poll(() => shop.shopPaths.get('FG-000001')).toEqual([c, b, a]);
    await expect(drawer(page).getByTestId('shop-not-displayed')).toHaveCount(0); expect(errors).toEqual([]);
  });
  test('taking out the LAST picture also holds: it is not sent again', async ({ page }) => {
    const { shop } = await boot(page); await images(page, /Grape 20000/); await add(page); await expect(shown(page)).toHaveCount(1, { timeout: 15_000 });
    await shown(page).getByRole('button', { name: 'Remove from the shop' }).click(); await expect(panel(page)).toContainText('No picture in the online shop yet'); await shut(page);
    await page.reload(); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible(); await page.waitForTimeout(2500); await expect(card(page)).toHaveCount(0); expect(shop.shopPaths.get('FG-000001')).toEqual([]); expect(ups(shop)).toHaveLength(1);
  });
  test('the server refuses: the picture stays where it was and the reason is shown; trying again works', async ({ page }) => {
    const { shop } = await boot(page); await images(page, /Grape 20000/); await add(page, 2); await expect(shown(page)).toHaveCount(2, { timeout: 20_000 }); const before = [...shop.shopPaths.get('FG-000001')!];
    shop.failNext('shop_admin_save_content', 1); await shown(page).first().getByRole('button', { name: 'Remove from the shop' }).click();
    await expect(panel(page)).toContainText('Not changed: boom'); await expect(shown(page)).toHaveCount(2); expect(shop.shopPaths.get('FG-000001')).toEqual(before);
    await shown(page).first().getByRole('button', { name: 'Remove from the shop' }).click(); await expect(shown(page)).toHaveCount(1); expect(shop.shopPaths.get('FG-000001')).toEqual([before[1]]);
  });
});

test.describe('pictures of this browser go to the shop by themselves', () => {
  test('a countdown, then sent: each once, only the pictures are written, and nothing is left to send', async ({ page }) => {
    test.setTimeout(90_000);
    const { shop, errors } = await boot(page); for (const n of [/Grape 20000/, /Mint 20000/]) await leaveBehind(page, shop, n);
    await page.goto('/#/customers'); await page.reload(); await expect(card(page)).toHaveAttribute('data-phase', 'countdown'); await expect(card(page)).toContainText('2 product pictures'); expect(ups(shop)).toHaveLength(0);       // on any page, and nothing before the time is up
    await expect(card(page)).toHaveAttribute('data-phase', 'done', { timeout: 25_000 }); await expect(card(page)).toContainText('2 pictures are now in the online shop');
    expect(ups(shop)).toHaveLength(2); expect([...shop.shopPaths.keys()].sort()).toEqual(['FG-000001', 'FG-000002']); for (const c of saved(shop)) expect(Object.keys(c.args.p_patch as object)).toEqual(['image_paths']);
    await expect(card(page)).toHaveCount(0, { timeout: 10_000 }); await page.reload(); await page.waitForTimeout(2500); await expect(card(page)).toHaveCount(0); expect(ups(shop)).toHaveLength(2); expect(errors).toEqual([]);
  });
  test('X in the countdown: that one is never sent, not even after a refresh; the other is', async ({ page }) => {
    test.setTimeout(90_000);
    const { shop } = await boot(page); await leaveBehind(page, shop, /Grape 20000/, 2); await page.reload(); await expect(card(page).getByTestId('auto-pic')).toHaveCount(2, { timeout: 10_000 });
    await card(page).getByTestId('auto-pic').first().getByRole('button', { name: /Do not send/ }).click(); await expect(card(page).getByTestId('auto-pic')).toHaveCount(1);
    await card(page).getByRole('button', { name: 'Send now' }).click(); await expect(card(page)).toHaveAttribute('data-phase', 'done'); expect(ups(shop)).toHaveLength(1);
    await page.reload(); await page.waitForTimeout(2500); await expect(card(page)).toHaveCount(0); expect(ups(shop)).toHaveLength(1);
    await page.goto('/#/products'); await images(page, /Grape 20000/); await drawer(page).getByTestId('local-shop-status').filter({ hasText: 'Not shown' }).getByRole('button', { name: 'Show again' }).click();       // changing one's mind
    await expect(card(page)).toContainText('1 product pictures'); await card(page).getByRole('button', { name: 'Send now' }).click(); await expect.poll(() => shop.shopPaths.get('FG-000001')?.length).toBe(2); expect(ups(shop)).toHaveLength(2);
  });
  test('the countdown stands still while the mouse is on the card; Pause holds until it is pressed, also after a refresh', async ({ page }) => {
    test.setTimeout(90_000);
    const { shop } = await boot(page); await leaveBehind(page, shop, /Grape 20000/); await page.reload(); await expect(card(page)).toBeVisible(); await card(page).hover(); await expect(card(page)).toContainText('Waiting for you');
    await page.waitForTimeout(12_000); expect(ups(shop)).toHaveLength(0);
    await card(page).getByRole('button', { name: 'Hold for now' }).click(); await page.mouse.move(1300, 200); await page.waitForTimeout(11_000); expect(ups(shop)).toHaveLength(0);
    await page.reload(); await expect(card(page)).toHaveAttribute('data-phase', 'paused'); await card(page).getByRole('button', { name: 'Send now' }).click(); await expect.poll(() => ups(shop).length).toBe(1);
  });
  test('two tabs, and a lost answer: the same picture is stored once and shown once', async ({ page }) => {
    test.setTimeout(90_000);
    const { shop } = await boot(page); await leaveBehind(page, shop, /Grape 20000/); await page.reload(); await expect(card(page)).toBeVisible();
    shop.failNext('shop_admin_save_content', 1); await card(page).getByRole('button', { name: 'Send now' }).click(); await expect(card(page)).toHaveAttribute('data-phase', 'failed'); await expect(card(page)).toContainText('boom');      // stored, but not saved on the SKU
    await page.waitForTimeout(800); expect(shop.shopPaths.get('FG-000001') ?? []).toEqual([]);
    await images(page, /Grape 20000/); await drawer(page).getByTestId('shop-pic-off').getByRole('button', { name: 'Show again' }).click(); await expect(shown(page)).toHaveCount(1);
    expect(shop.stored.size).toBe(1); expect(shop.shopPaths.get('FG-000001')).toHaveLength(1);
  });
  test('the connection drops: it says so, tries again by itself, and nothing is stored twice', async ({ page }) => {
    test.setTimeout(90_000);
    const { shop, errors } = await boot(page); await leaveBehind(page, shop, /Grape 20000/); await page.reload(); await expect(card(page)).toBeVisible();
    await page.route(UPLOAD, (r) => r.abort('internetdisconnected')); await card(page).getByRole('button', { name: 'Send now' }).click(); await expect(card(page)).toHaveAttribute('data-phase', 'failed'); await expect(card(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    await accept(page); await expect.poll(() => shop.shopPaths.get('FG-000001')?.length ?? 0, { timeout: 15_000 }).toBe(1); expect(shop.stored.size).toBe(1); expect(errors).toEqual([]);
  });
  test('a refusal is not repeated by itself; Retry sends it', async ({ page }) => {
    test.setTimeout(90_000);
    const { shop } = await boot(page); await leaveBehind(page, shop, /Grape 20000/); await refuse(page, 'new row violates row-level security policy'); await page.reload(); await expect(card(page)).toBeVisible();
    await card(page).getByRole('button', { name: 'Send now' }).click(); await expect(card(page)).toContainText('row-level security'); await page.waitForTimeout(7000); await expect(card(page)).toHaveAttribute('data-phase', 'failed');
    await accept(page); await card(page).getByRole('button', { name: 'Retry' }).click(); await expect.poll(() => shop.shopPaths.get('FG-000001')?.length ?? 0).toBe(1);
  });
  test('pictures sent before this version (names that cannot be matched) are not sent a second time; a newer one is', async ({ page }) => {
    test.setTimeout(90_000);
    const { shop } = await boot(page); await leaveBehind(page, shop, /Grape 20000/); shop.stored.set('FG-000001/mwu1nuuwij14.webp', new Date(Date.now() + 1000).toISOString()); shop.shopPaths.set('FG-000001', ['FG-000001/mwu1nuuwij14.webp']);
    await page.reload(); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible(); await page.waitForTimeout(2500); await expect(card(page)).toHaveCount(0); expect(ups(shop)).toHaveLength(0);
    await images(page, /Grape 20000/); await expect(drawer(page).getByTestId('local-shop-status')).toContainText('Sent earlier');
  });
  test('no picture in this browser: the shop is not asked; a role that may not send is shown nothing; an unreachable shop breaks nothing', async ({ page }) => {
    const { shop, errors } = await boot(page); await page.waitForTimeout(1500); expect(shop.listed).toEqual([]); await expect(card(page)).toHaveCount(0);
    await leaveBehind(page, shop, /Grape 20000/); shop.failNext('shop_admin_products', 99); await page.reload(); await expect(page.getByRole('row', { name: /Grape 20000/ })).toBeVisible(); await page.waitForTimeout(2000); await expect(card(page)).toHaveCount(0); expect(ups(shop)).toHaveLength(0); expect(errors).toEqual([]);
  });
});

test('the card and the X: nothing serious for accessibility, no sideways scroll on a phone, Thai', async ({ page }) => {
  test.setTimeout(90_000);
  const { shop } = await boot(page, { lang: 'th' }); await leaveBehind(page, shop, /Grape 20000/, 2); await page.reload(); await expect(card(page)).toContainText('รูปสินค้ารอขึ้นหน้าร้าน 2 รูป'); await card(page).getByRole('button', { name: 'หยุดไว้ก่อน' }).click();
  await card(page).screenshot({ path: `${SHOTS}/auto-pictures-th.png` });
  const r = await new AxeBuilder({ page }).include('[data-testid="auto-pictures"]').analyze(); expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(card(page)).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = (await card(page).boundingBox())!, fab = (await page.locator('.feedback-fab').boundingBox())!; expect(box.y + box.height).toBeLessThanOrEqual(fab.y);           // above the Feedback button, not under it
  await page.screenshot({ path: `${SHOTS}/auto-pictures-phone-th.png` });
});

test('formal Thai on the payment screens', async () => {
  for (const k of ['co.slipTitle', 'co.slipHelp', 'co.slipMissing', 'qr.step3', 'sc.review', 'sc.attentionBody', 'sv.ok', 'sv.differs', 'sv.tick', 'sv.must', 'sv.note'] as K[]) { expect(t(k), k).not.toMatch(/คุณ|ค่ะ|ครับ|ใช้ได้เลย|ไหม|กดอีกครั้ง/); expect(t(k).length, k).toBeGreaterThan(5); }
  expect(t('co.slipChoose')).toBe('แนบรูปภาพสลีปการโอนเงิน'); expect(t('co.place')).toBe('ยืนยันคำสั่งซื้อสินค้า');            // the two labels the owner dictated stay word for word
});
