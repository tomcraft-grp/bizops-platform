// Products: the summary cards filter the table below (a real Chrome, a fake backend; the catalogue arrives through the SKU feed exactly as in production).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const sku = (code: string, cat: string, name: string, o: Record<string, unknown> = {}) => ({ sku_code: code, legacy_sku_code: null, sku_category: cat, origin: 'app', name_full: name, brand: 'BRAND', product_type: 'Puff', domain: 'POD', pack_qty: null, unit_en: 'pcs', unit_th: null, barcode: null,
  status: 'active', cost_price: 10, retail_price: 200, selling_price: 200, friend_price: null, wholesale_price: null, ecommerce_price: null, needs_review: false, review_notes: null, updated_at: '2026-11-25T00:00:00Z', category_id: null, category_code: null, category_name: null, ...o });
const code = (p: string, n: number) => `${p}-${String(n).padStart(6, '0')}`;
// 20 on sale (two pages of 14), 3 switched off, 2 active in the registry but without a price, 4 raw materials
const FEED = [
  ...Array.from({ length: 20 }, (_, i) => sku(code('FG', i + 1), 'FG', `${i % 2 ? 'Grape' : 'Mint'} ${String(i + 1).padStart(2, '0')}`, { selling_price: 100 + i })),
  ...Array.from({ length: 3 }, (_, i) => sku(code('FG', 101 + i), 'FG', `Grape stopped ${i + 1}`, { status: 'inactive' })),
  ...Array.from({ length: 2 }, (_, i) => sku(code('FG', 201 + i), 'FG', `Grape unpriced ${i + 1}`, { selling_price: null, retail_price: null })),
  ...Array.from({ length: 4 }, (_, i) => sku(code('RM', i + 1), 'RM', `Leaf ${i + 1}`)),
];

async function openProducts(page: Page, lang: 'en' | 'th' = 'en') {
  const fake = new FakeShop(); fake.profile.role = 'SUPER_ADMIN'; fake.w.role = 'manager';
  const errors: string[] = []; const calls: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.url().includes('supabase.co') && r.method() !== 'OPTIONS') calls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await fake.install(page);
  await page.route('**/rest/v1/rpc/sku_*', async (r: Route) => {
    if (r.request().method() === 'OPTIONS') return r.fallback();
    if (/sku_changes_since/.test(r.request().url())) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ cursor: 1, full: r.request().postDataJSON()?.p_cursor == null, rows: FEED }) });
    return r.fallback();
  });
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/products');
  await expect(card(page, 'all').locator('.val')).not.toHaveText('0', { timeout: 20_000 });
  return { errors, calls };
}
const ORDER = ['all', 'onsale', 'menu', 'raw', 'inactive'];
const card = (page: Page, id: string) => page.getByTestId('product-cards').getByRole('button').nth(ORDER.indexOf(id));
const num = async (page: Page, id: string) => Number(await card(page, id).locator('.val').innerText());
const rows = (page: Page) => page.locator('table.t tbody tr');
const names = (page: Page) => page.locator('table.t tbody tr td:first-child b').allInnerTexts();
async function allRows(page: Page): Promise<number> {
  let n = await rows(page).count(); const next = page.getByRole('button', { name: 'Next page' });
  while (await next.count() && await next.isEnabled()) { await next.click(); n += await rows(page).count(); }
  return n;
}

test('Active Products: the number, the list, and the status of every row agree; pressing again shows everything', async ({ page }) => {
  const { errors } = await openProducts(page);
  await expect(card(page, 'onsale')).toContainText('Active Products'); await expect(card(page, 'onsale').locator('.val')).toHaveText('20');
  const before = await page.getByTestId('product-cards').innerText();
  await card(page, 'onsale').click();
  await expect(card(page, 'onsale')).toHaveAttribute('aria-pressed', 'true'); await expect(card(page, 'all')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('products-showing')).toContainText('Active Products'); await expect(page.locator('.pager')).toContainText('of 20');
  await expect(page.locator('table.t')).not.toContainText('Inactive');
  expect(await allRows(page)).toBe(20);
  expect(await page.getByTestId('product-cards').innerText()).toBe(before);                     // the numbers never follow the table
  await card(page, 'onsale').click(); await expect(card(page, 'all')).toHaveAttribute('aria-pressed', 'true'); expect(await allRows(page)).toBe(await num(page, 'all'));
  expect(errors).toEqual([]);
});

test('every card lists as many products as its number, and switching leaves nothing behind', async ({ page }) => {
  await openProducts(page);
  for (const id of ['inactive', 'onsale', 'raw', 'menu', 'all', 'onsale', 'inactive']) {
    await card(page, id).click(); await expect(card(page, id)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('product-cards').locator('[aria-pressed="true"]')).toHaveCount(1);
    expect(await allRows(page), id).toBe(await num(page, id));
  }
  await expect(page.locator('table.t tbody .badge', { hasText: /^Active$/ })).toHaveCount(0);
});

test('search, sorting and pages work inside the card; switching cards goes back to page 1', async ({ page }) => {
  await openProducts(page); await card(page, 'onsale').click();
  await page.getByRole('button', { name: 'Next page' }).click(); await expect(page.locator('.pager')).toContainText('2 / 2');
  await card(page, 'all').click(); await expect(page.locator('.pager')).toContainText('1 / '); await card(page, 'onsale').click(); await expect(page.locator('.pager')).toContainText('1 / 2');
  const price = page.locator('table.t th', { hasText: 'Price' }); await price.click(); await expect(rows(page).first()).toContainText('100'); await price.click(); await expect(rows(page).first()).toContainText('119');
  const search = page.locator('.card input').first(); await search.fill('grape'); await expect(page.getByTestId('products-showing')).toContainText('10 of');
  expect((await names(page)).every((n) => /^Grape \d\d$/.test(n))).toBe(true);                   // not the stopped or the unpriced Grapes
  await expect(card(page, 'onsale')).toHaveAttribute('aria-pressed', 'true'); await expect(card(page, 'onsale').locator('.val')).toHaveText('20');
  await card(page, 'inactive').click(); await expect(search).toHaveValue('grape'); expect(await rows(page).count()).toBe(5);
  await search.fill('nothing like this'); await expect(page.getByText('No products match')).toBeVisible();
  await page.getByRole('button', { name: 'Show all products' }).click(); await expect(search).toHaveValue(''); expect(await allRows(page)).toBe(await num(page, 'all'));
});

test('cards and the boxes are one filter: they follow each other and a card clears the boxes', async ({ page }) => {
  await openProducts(page); const status = page.getByLabel('Status', { exact: true }); const type = page.getByLabel('Type', { exact: true });
  await card(page, 'onsale').click(); await expect(status).toHaveValue('onsale');
  await status.selectOption('inactive'); await expect(card(page, 'inactive')).toHaveAttribute('aria-pressed', 'true'); expect(await allRows(page)).toBe(await num(page, 'inactive'));
  await type.selectOption('material'); await page.getByLabel('SKU type', { exact: true }).selectOption('RM');
  await card(page, 'onsale').click(); await expect(type).toHaveValue(''); await expect(page.getByLabel('SKU type', { exact: true })).toHaveValue(''); expect(await allRows(page)).toBe(20);
  await status.selectOption('active'); await expect(page.getByTestId('product-cards').locator('[aria-pressed="true"]')).toHaveCount(0);
});

test('filtering asks the server for nothing', async ({ page }) => {
  const { calls } = await openProducts(page); await page.waitForTimeout(1500); const n = calls.length;
  for (const id of ['onsale', 'inactive', 'raw', 'all']) await card(page, id).click();
  await page.locator('.card input').first().fill('mint'); await page.waitForTimeout(1000);
  expect(calls.slice(n).filter((c) => /sku|product|categor/.test(c))).toEqual([]);
});

test('Thai, keyboard, accessibility, and no sideways scrolling from phone to desktop', async ({ page }) => {
  await openProducts(page, 'th');
  await expect(card(page, 'onsale')).toContainText('สินค้าที่เปิดขาย'); await card(page, 'onsale').focus(); await page.keyboard.press('Enter'); await expect(card(page, 'onsale')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('products-showing')).toContainText('20 จาก');
  for (const [w, h] of [[1440, 900], [1180, 900], [1024, 768], [820, 1180], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width: w, height: h });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${w}`).toBeLessThanOrEqual(0);
    const boxes = await page.getByTestId('product-cards').getByRole('button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { over: e.scrollWidth - e.clientWidth, right: r.right }; }));
    for (const b of boxes) { expect(b.over, `card text at ${w}`).toBeLessThanOrEqual(0); expect(b.right).toBeLessThanOrEqual(w); }
    if (process.env.SHOP_SHOTS) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${process.env.SHOP_SHOTS}/product-cards-${w}.png` }); }
  }
  const r = await new AxeBuilder({ page }).include('[data-testid="product-cards"]').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(r.violations.map((v) => v.id)).toEqual([]);
});
