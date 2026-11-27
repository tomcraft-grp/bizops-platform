// BOM & production through the screens, in a real Chrome against a fake backend, around the owner's ten scenarios. The catalogue is the owner's situation:
// 149 products from the SKU feed, nearly all of them resale and most inactive, no BOM, no stock. Stock is put in on the Inventory page, a packaging item is created on
// the Products page, a price change comes through the SKU feed. What is checked is what the app really keeps (its IndexedDB) and shows, never a mock of it.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
test.setTimeout(180_000);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const fg = (n: number) => `FG-${String(n).padStart(6, '0')}`;
const sku = (code: string, name: string, o: Record<string, unknown> = {}) => ({ sku_code: code, legacy_sku_code: null, sku_category: code.split('-')[0], origin: 'app', name_full: name, brand: 'BRAND', product_type: 'Puff', domain: 'POD', pack_qty: null, unit_en: 'pcs', unit_th: null, barcode: null,
  status: 'active', cost_price: 10, retail_price: 200, selling_price: 200, friend_price: null, wholesale_price: null, ecommerce_price: null, needs_review: false, review_notes: null, updated_at: '2026-11-25T00:00:00Z', category_id: null, category_code: null, category_name: null, ...o });
// Gift box = 10 Pod + 5 Coil + 100 Sleeve for a batch of 100: 10×100 + 5×80 + 100×2 = 1,600, 16 each; with labour 200 and overhead 100, 19. Price 107 with VAT 7% = 100 before VAT.
const FEED = [
  sku(fg(1), 'Gift box', { cost_price: null, selling_price: 107, retail_price: 107 }), sku(fg(2), 'Pod Grape', { cost_price: 100, barcode: '8850001112223' }), sku(fg(3), 'Coil Mesh', { cost_price: 80, legacy_sku_code: 'OLD-COIL-9' }), sku(fg(4), 'Sleeve', { cost_price: 2 }),
  sku(fg(5), 'Mystery part', { cost_price: null }), sku(fg(6), 'Duo set', { cost_price: null, brand: 'RELX' }), sku(fg(7), 'Sticker', { cost_price: 1 }),
  sku('RM-000001', 'Leaf RM', { cost_price: 5, product_type: 'Leaf' }), sku('WIP-000001', 'Base WIP', { cost_price: null }),
  ...Array.from({ length: 140 }, (_, i) => sku(fg(100 + i), `Puff old ${String(i + 1).padStart(3, '0')}`, { status: 'inactive' })),
];
interface Line { account: string; debit: number; credit: number }
interface Db {
  products: { id: string; sku: string; name: string; kind: string; stdCost: number }[]; balances: Record<string, { qty: number; value: number }>; movements: { type: string; qty: number; productId: string; warehouseId: string; refType: string; refId: string; note?: string; userId: string; value: number }[];
  journals: { id: string; no: string; refType: string; refId?: string; lines: Line[]; status: string; reverses?: string; date: string; memo: string }[]; boms: { id: string; productId: string; status?: string; versions: { version: number; status: string; components: { productId: string; qty: number; role: string; wastePct?: number; entry?: unknown }[] }[] }[];
  productionOrders: { id: string; no: string; status: string; plannedQty: number; snapshot: { version: number }; wip?: { materials: number; labor: number; overhead: number }; issues?: { id: string; no: string }[]; returns?: { value: number }[]; receipts?: { id: string; good: number; rejected: number; unitCost: number; goodValue: number; reversal?: unknown }[]; variances?: { reversal?: unknown }[] }[];
  accounts: { code: string; type: string; posting: boolean; control?: string }[]; postingMap: Record<string, unknown[]>; roles: { id: string; permissions: string[] }[]; grns: unknown[]; apInvoices: unknown[]; meta: { currentUserId: string }; users: { id: string; name: string }[];
}
/** What the app has saved in this browser. */
const read = (page: Page) => page.evaluate(() => new Promise<Db>((ok, bad) => { const r = indexedDB.open('bizops-platform', 1); r.onerror = bad; r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('db'); g.onsuccess = () => { r.result.close(); ok(g.result as Db); }; g.onerror = bad; }; })) as unknown as Promise<Db>;
/** A saved database that differs (an account not mapped, a role with fewer permissions): as if it had been saved like that before. */
async function change(page: Page, fn: string) {
  await page.evaluate((src) => new Promise<void>((ok, bad) => {
    const r = indexedDB.open('bizops-platform', 1); r.onerror = bad;
    r.onsuccess = () => { const s = r.result.transaction('kv', 'readwrite').objectStore('kv'); const g = s.get('db'); g.onsuccess = () => { const db = g.result; new Function('db', src)(db); const p = s.put(db, 'db'); p.onsuccess = () => { r.result.close(); ok(); }; p.onerror = bad; }; };
  }), fn);
  await page.reload();
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const gl = (db: Db, account: string) => r2(db.journals.flatMap((j) => j.lines).filter((l) => l.account === account).reduce((s, l) => s + l.debit - l.credit, 0));
const glOf = (db: Db, control: string) => r2(db.accounts.filter((a) => a.control === control).reduce((s, a) => s + gl(db, a.code), 0));
const pidOf = (db: Db, name: string) => db.products.find((p) => p.name === name)!.id;
const qty = (db: Db, name: string, wh = 'W3') => db.balances[`${wh}|${pidOf(db, name)}`]?.qty ?? 0;
const value = (db: Db, name: string, wh = 'W3') => db.balances[`${wh}|${pidOf(db, name)}`]?.value ?? 0;
/** Every entry balanced, stock value = the inventory accounts, WIP of the orders = the WIP accounts. */
async function sound(page: Page): Promise<Db> {
  const db = await read(page);
  for (const j of db.journals) expect(r2(j.lines.reduce((s, l) => s + l.debit - l.credit, 0)), j.no).toBe(0);
  expect(r2(Object.values(db.balances).reduce((s, b) => s + b.value, 0))).toBe(glOf(db, 'inventory'));
  expect(r2(db.productionOrders.reduce((s, o) => s + wipOf(o), 0))).toBe(glOf(db, 'wip'));
  return db;
}
const wipOf = (o: Db['productionOrders'][number]) => r2((o.wip?.materials ?? 0) + (o.wip?.labor ?? 0) + (o.wip?.overhead ?? 0));

async function open(page: Page, o: { lang?: 'en' | 'th'; feed?: unknown[] } = {}) {
  const fake = new FakeShop(); fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Owner'; fake.w.role = 'manager';
  const errors: string[] = [], later: unknown[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await fake.install(page);
  const feed = o.feed ?? FEED;
  const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/rpc/sku_*', async (r: Route) => {
    if (r.request().method() === 'OPTIONS') return r.fallback();
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    if (fn === 'sku_changes_since') { const full = r.request().postDataJSON()?.p_cursor == null; const rows = full ? feed : later.splice(0); return json(r, { cursor: 1, full, rows }); }
    // a new product made on the Products page gets its code from the registry
    if (fn === 'sku_peek') return json(r, 'RM-000900');
    if (fn === 'sku_reserve') return json(r, [{ code: r.request().postDataJSON()?.p_category === 'RM' ? 'RM-000900' : 'FG-000900', seq: 900, reused: false }]);
    if (fn === 'sku_set_details') return json(r, {});
    return r.fallback();
  });
  await page.route('**/rest/v1/rpc/product_categories_list', (r) => (r.request().method() === 'OPTIONS' ? r.fallback() : json(r, { code: 'PGRST202', message: 'Could not find the function public.product_categories_list in the schema cache' }, 404)));
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, o.lang ?? 'en');
  await page.goto('/#/production');
  await expect(page.locator('.tabs')).toBeVisible({ timeout: 30_000 });
  if (feed.length) await expect.poll(async () => (await read(page)).products.length, { timeout: 20_000 }).toBe(feed.length);
  /** The registry changes the cost of a product; the next sync (at the next start) brings it to this device. */
  const reprice = async (name: string, cost: number) => {
    later.push({ ...(feed as { name_full: string }[]).find((x) => x.name_full === name), cost_price: cost, updated_at: new Date().toISOString() });
    await page.reload(); await expect.poll(async () => (await read(page)).products.find((p) => p.name === name)?.stdCost, { timeout: 20_000 }).toBe(cost);
  };
  return { errors, reprice };
}
/** Puts stock in the way staff do it: Inventory, Adjust, Correction. A product that is new in a warehouse comes in at its cost from the registry. */
async function stockIn(page: Page, list: [string, number][], wh = 'W3', sign = 1) {
  await page.goto('/#/inventory');
  for (const [name, n] of list) {
    await page.getByRole('button', { name: 'Adjust / waste' }).click();
    const m = page.locator('.modal'); await m.getByRole('tab', { name: 'Correction (+/−)' }).click();
    await m.getByRole('combobox', { name: 'Warehouse' }).selectOption(wh); await m.getByRole('combobox', { name: 'Item' }).selectOption({ label: name });
    await m.getByRole('spinbutton').fill(String(sign * n)); await m.getByRole('textbox').fill('Opening count'); await m.getByRole('button', { name: 'Post' }).click(); await expect(m).toHaveCount(0);
  }
}
const STOCK: [string, number][] = [['Pod Grape', 100], ['Coil Mesh', 100], ['Sleeve', 1000]];
const GIFT: [string, string, string][] = [['8850001112223', 'Pod Grape', '10'], ['OLD-COIL-9', 'Coil Mesh', '5'], ['sleeve', 'Sleeve', '100']];
const tab = async (page: Page, name: string) => { await page.goto('/#/production'); await page.getByRole('tab', { name }).click(); };
const pick = async (box: Locator, q: string) => { await box.getByRole('combobox').fill(q); await box.getByRole('combobox').press('Enter'); };
const line = (page: Page, name: string) => page.getByTestId('bom-line').filter({ hasText: name });
/** A BOM made through the screens: Gift box from Pod, Coil and Sleeve unless said otherwise; labour and overhead as asked. */
async function newBom(page: Page, o: { labor?: string; overhead?: string; out?: string; comps?: [string, string, string][]; yieldQty?: string; activate?: boolean } = {}) {
  await tab(page, 'BOM list'); await page.getByRole('button', { name: 'New BOM' }).first().click();
  await pick(page.getByTestId('pick-output'), o.out ?? 'Gift box'); await page.getByTestId('bom-yield').fill(o.yieldQty ?? '100');
  for (const [q, name, n] of o.comps ?? GIFT) { await pick(page.getByTestId('pick-component'), q); await line(page, name).getByLabel('Quantity per batch (pcs)').fill(n); }
  for (const [k, v] of [['Labour', o.labor], ['Overhead', o.overhead]] as const) if (v !== undefined) { await page.getByLabel(`${k} is not known yet`).uncheck(); await page.getByLabel(`${k} cost per batch (฿)`).fill(v); }
  await page.getByRole('button', { name: 'Preview before saving' }).click();
  await page.getByRole('button', { name: o.activate === false ? 'Save as draft' : 'Save and activate' }).click(); await expect(page.getByTestId('bom-page')).toBeVisible();
}
async function newOrder(page: Page, n: string, o: { approve?: boolean; wh?: string } = {}): Promise<string> {
  await tab(page, 'Production orders'); await page.getByRole('button', { name: 'New production order' }).first().click();
  await page.getByTestId('order-qty').fill(n); await page.getByLabel('Warehouse of materials and goods').selectOption(o.wh ?? 'W3'); await page.getByRole('button', { name: 'Create order' }).click();
  await expect(page.getByTestId('order-page')).toBeVisible(); if (o.approve !== false) { await page.getByRole('button', { name: 'Approve order' }).click(); await expect(page.getByRole('button', { name: 'Record production' })).toBeVisible(); }
  return page.url().split('#')[1];
}
const modal = (page: Page) => page.locator('.modal');
const review = (page: Page) => page.getByTestId('review-post').click();
async function confirm(page: Page, button = 'Post') { await modal(page).getByRole('button', { name: button, exact: true }).click(); await expect(modal(page)).toHaveCount(0); }
async function reverse(page: Page, doc: string, reason: string) { await page.locator(`tr[data-doc="${doc}"]`).filter({ has: page.getByRole('button', { name: 'Reverse entry' }) }).first().getByRole('button', { name: 'Reverse entry' }).click(); await modal(page).getByRole('textbox').fill(reason); await confirm(page, 'Reverse entry'); }
const group = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const issueField = (page: Page, name: string) => group(page, name).getByLabel('Issue now (pcs)');
const toast = (page: Page) => page.locator('.toast.error').first();
const step = (page: Page) => page.locator('.mfg-steps [aria-current=step]');
async function addCost(page: Page, kind: string, n: string) { await page.getByRole('button', { name: 'Add a cost' }).click(); await page.getByLabel('Kind of cost').selectOption(kind); await page.getByLabel('Amount (฿)').fill(n); await review(page); await confirm(page); }
const ledgerNet = (db: Db) => r2(-db.accounts.filter((a) => a.posting && (a.type === 'revenue' || a.type === 'expense')).reduce((s, a) => s + gl(db, a.code), 0));
const money0 = (n: number) => '฿' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);

// ------------------------------------------------------------------------------------------------ the owner's ten scenarios
test('(1) BOM Creation: select an existing product from the catalog, create a BOM, add multiple components, calculate cost, save, reopen, all data persisted', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, STOCK);
  await tab(page, 'BOM list'); await page.getByRole('button', { name: 'New BOM' }).first().click();
  // the picker: 149 products, 50 rows, what cannot be chosen says why, keyboard only
  const out = page.getByTestId('pick-output'); await out.getByRole('combobox').click(); await expect(out.getByRole('option')).toHaveCount(50); await expect(out).toContainText('Showing the first 50 of 149 products');
  await out.getByRole('combobox').fill('puff old 001'); await expect(out.getByRole('option').first()).toContainText('Inactive: activate it on the Products page first'); await out.getByRole('combobox').press('Enter'); await expect(page.getByTestId('bom-product')).toHaveCount(0);
  await out.getByRole('combobox').fill('relx'); await expect(out.getByRole('option')).toHaveCount(1); await out.getByRole('combobox').press('Escape');
  await out.getByRole('combobox').fill('gift'); await out.getByRole('combobox').press('ArrowDown'); await out.getByRole('combobox').press('Enter'); await expect(page.getByTestId('bom-product')).toContainText('Gift box');
  // several components, found by barcode, old SKU and name
  const comp = page.getByTestId('pick-component'); await comp.getByRole('combobox').fill('8850001112223'); await expect(comp.getByRole('option').first()).toContainText('On hand 100 pcs'); await comp.getByRole('combobox').press('Enter');
  await pick(comp, 'OLD-COIL-9'); await pick(comp, 'sleeve'); await expect(page.getByTestId('bom-line')).toHaveCount(3);
  await page.getByTestId('bom-yield').fill('100'); await line(page, 'Pod Grape').getByLabel('Quantity per batch (pcs)').fill('10');
  await line(page, 'Coil Mesh').getByRole('button', { name: 'Enter in another unit' }).click(); await line(page, 'Coil Mesh').getByLabel('Quantity in that unit').fill('0.5'); await line(page, 'Coil Mesh').getByLabel('Name of the unit (for example box)').fill('box'); await line(page, 'Coil Mesh').getByLabel('One unit contains (pcs)').fill('10'); await expect(line(page, 'Coil Mesh')).toContainText('= 5 pcs');
  await line(page, 'Sleeve').getByLabel('Quantity per batch (pcs)').fill('100'); await line(page, 'Sleeve').getByLabel('Waste allowance (%)').fill('5');
  // the cost follows: unknown until labour and overhead are given, then 1,000 + 400 + 105 × 2 + 300 = 1,910 for 100
  await expect(page.getByTestId('bom-unit-cost')).toHaveText('Unknown cost'); await expect(page.getByTestId('bom-cost')).toContainText('Cost not known: Labour cost, Overhead cost');
  for (const [k, v] of [['Labour', '200'], ['Overhead', '100']]) { await page.getByLabel(`${k} is not known yet`).uncheck(); await page.getByLabel(`${k} cost per batch (฿)`).fill(v); }
  await expect(page.getByTestId('bom-unit-cost')).toHaveText('฿19.10'); await expect(page.getByTestId('bom-cost')).toContainText('฿1,910.00'); await expect(line(page, 'Sleeve')).toContainText('฿210.00');
  await page.getByRole('button', { name: 'Preview before saving' }).click(); await expect(page.getByText('Check before saving')).toBeVisible(); expect((await read(page)).boms).toHaveLength(0);
  await page.getByRole('button', { name: 'Save as draft' }).click(); await expect(page.getByTestId('bom-draft')).toBeVisible();
  // reopened after a reload: the draft has every value
  await page.reload(); await expect(page.getByTestId('bom-draft')).toBeVisible();
  await expect(line(page, 'Sleeve').getByLabel('Waste allowance (%)')).toHaveValue('5'); await expect(line(page, 'Coil Mesh').getByLabel('Quantity in that unit')).toHaveValue('0.5'); await expect(line(page, 'Coil Mesh').getByLabel('Name of the unit (for example box)')).toHaveValue('box'); await expect(page.getByLabel('Labour cost per batch (฿)')).toHaveValue('200');
  let db = await read(page); expect(db.boms[0].versions).toMatchObject([{ status: 'draft', components: [{ qty: 10 }, { qty: 5, entry: { qty: 0.5, unit: 'box', factor: 10 } }, { qty: 100, wastePct: 5 }] }]);
  await page.getByRole('button', { name: 'Preview before saving' }).click(); await page.getByRole('button', { name: 'Save and activate' }).click(); await expect(page.locator('.mfg-h .badge')).toHaveText('BOM in use');
  // a new version as a draft; the active one stays as it was; both are there after a reload
  await page.getByRole('button', { name: 'New BOM version' }).click(); await line(page, 'Pod Grape').getByLabel('Quantity per batch (pcs)').fill('12'); await page.getByRole('button', { name: 'Preview before saving' }).click(); await page.getByRole('button', { name: 'Save as draft' }).click();
  await page.reload(); await expect(line(page, 'Pod Grape').getByLabel('Quantity per batch (pcs)')).toHaveValue('12');
  const hist = page.locator('table.t').last(); const v1 = hist.getByRole('row', { name: /^v1 / }), v2 = hist.getByRole('row', { name: /^v2 / }); await expect(v2).toContainText('Draft version'); await expect(v1).toContainText('In use now'); await expect(v2).toContainText('Draft based on v1');
  await hist.getByRole('button', { name: 'v1' }).click(); await expect(page.locator('table.t').first()).toContainText('0.5 box × 10'); await expect(page.locator('table.t').first()).toContainText('5.0%');
  db = await read(page); expect(db.boms[0].versions.map((v) => [v.version, v.status, v.components[0].qty])).toEqual([[1, 'active', 10], [2, 'draft', 12]]);
  await page.getByRole('button', { name: 'Back to the BOM list' }).click(); await expect(page.getByTestId('bom-page')).toHaveCount(0); await expect(page.locator('table.t tbody tr')).toContainText('New draft waiting'); await expect(page.locator('table.t tbody tr')).toContainText('฿19.10');
  expect(errors).toEqual([]);
});

test('(2) Product Classification: BOM creation with products classified FG, RM, WIP, Packaging, other; classification must not prevent output or component selection', async ({ page }) => {
  const { errors } = await open(page);
  // a packaging item and a menu item, made on the Products page (the registry gives them their code)
  for (const [cat, kind, name, cost] of [['RM', 'packaging', 'Box PK', '3'], ['FG', 'menu', 'Iced drink', '0']]) {
    await page.goto('/#/products'); await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'New product', exact: true }).click(); const m = modal(page);
    await m.getByLabel('SKU type').selectOption(cat); await m.getByLabel('Kind').selectOption(kind); await m.getByLabel('Name', { exact: true }).fill(name); await m.getByLabel('Standard cost (฿)').fill(cost); await m.getByRole('button', { name: 'Create' }).click(); await expect(m).toHaveCount(0);
  }
  let db = await read(page); expect(Object.fromEntries(['Gift box', 'Leaf RM', 'Base WIP', 'Box PK', 'Iced drink'].map((n) => [n, db.products.find((p) => p.name === n)!.kind]))).toEqual({ 'Gift box': 'resale', 'Leaf RM': 'material', 'Base WIP': 'wip', 'Box PK': 'packaging', 'Iced drink': 'menu' });
  await stockIn(page, [['Leaf RM', 100], ['Box PK', 50], ['Pod Grape', 10], ['Sticker', 100]]);
  // the picker names the kind of every product, and only a menu item cannot be a component, with its reason
  await tab(page, 'BOM list'); await page.getByRole('button', { name: 'New BOM' }).first().click(); await pick(page.getByTestId('pick-output'), 'base wip');
  const comp = page.getByTestId('pick-component');
  for (const [q, kind] of [['leaf', 'Raw material'], ['box pk', 'Packaging'], ['pod', 'Resale'], ['base', 'Work in process']]) { await comp.getByRole('combobox').fill(q); await expect(comp.getByRole('option').first()).toContainText(kind); }
  await comp.getByRole('combobox').fill('iced'); await expect(comp.getByRole('option').first()).toContainText('A menu item holds no stock, so it cannot be a component'); await comp.getByRole('combobox').press('Enter'); await expect(page.getByTestId('bom-line')).toHaveCount(0); await comp.getByRole('combobox').press('Escape');
  await page.getByRole('tab', { name: 'BOM list' }).click(); await modal(page).getByRole('button', { name: 'Leave without saving' }).click();
  // WIP from raw material, packaging and a resale product; FG from WIP; RM from a resale product; packaging from a resale product
  await newBom(page, { out: 'base wip', yieldQty: '1', comps: [['leaf', 'Leaf RM', '2'], ['box pk', 'Box PK', '1'], ['pod', 'Pod Grape', '1']], labor: '0', overhead: '0' });
  await expect(page.locator('table.t').first().locator('tr', { hasText: 'Box PK' })).toContainText('Packing material'); await expect(page.getByTestId('bom-cost')).toContainText('฿113.00');
  await newBom(page, { out: 'gift', yieldQty: '1', comps: [['base wip', 'Base WIP', '1']], labor: '5', overhead: '0' });
  await newBom(page, { out: 'leaf rm', yieldQty: '10', comps: [['sticker', 'Sticker', '3']], labor: '0', overhead: '0' });
  await newBom(page, { out: 'box pk', yieldQty: '1', comps: [['sticker', 'Sticker', '1']], labor: '0', overhead: '0' });
  db = await read(page); expect(db.boms.map((b) => db.products.find((p) => p.id === b.productId)!.kind).sort()).toEqual(['material', 'packaging', 'resale', 'wip']);
  // WIP is produced and used again: its stock and cost move on like any other product
  await newOrder(page, '2'); await page.getByRole('button', { name: 'Record production' }).click(); await review(page); await confirm(page);
  db = await sound(page); expect([qty(db, 'Base WIP'), value(db, 'Base WIP'), qty(db, 'Leaf RM'), qty(db, 'Box PK')]).toEqual([2, 226, 96, 48]);
  const issue = db.journals.find((j) => j.memo.includes('materials issued'))!; expect(issue.lines.filter((l) => l.credit > 0).map((l) => [l.account, l.credit]).sort()).toEqual([['1200', 26], ['1210', 200]]);
  expect(errors).toEqual([]);
});

test('(3) Production Order: component requirements, stock availability, shortage (also when another warehouse holds the stock), cost', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, [['Pod Grape', 5], ['Coil Mesh', 100], ['Sleeve', 1000]]); await stockIn(page, [['Pod Grape', 50]], 'W1');
  await newBom(page, { labor: '200', overhead: '100' }); const bomId = (await read(page)).boms[0].id;
  await page.getByRole('button', { name: 'New production order' }).click(); await page.getByLabel('Warehouse of materials and goods').selectOption('W3');
  const need = page.getByTestId('order-need');
  await expect(need.locator('tr', { hasText: 'Pod Grape' })).toContainText('10 pcs'); await expect(need.locator('tr', { hasText: 'Pod Grape' })).toContainText('Short 5'); await expect(need.locator('tr', { hasText: 'Pod Grape' }).locator('td').nth(3)).toHaveText('50');
  await expect(need.locator('tr', { hasText: 'Sleeve' })).toContainText('Enough'); await expect(page.getByTestId('order-short')).toContainText('1 of 3 materials are short');
  await expect(page.getByTestId('order-form')).toContainText('฿1,900.00'); await expect(page.getByTestId('order-form')).toContainText('฿19.00');
  await page.getByLabel('Warehouse of materials and goods').selectOption('W1'); await expect(page.getByTestId('order-short')).toContainText('2 of 3 materials are short'); await page.getByLabel('Warehouse of materials and goods').selectOption('W3');
  await page.getByRole('button', { name: 'Create order' }).click(); await page.getByRole('button', { name: 'Approve order' }).click();
  await expect(page.getByTestId('order-shortages')).toContainText('Pod Grape short 5 pcs (other warehouses hold 50)'); await expect(page.getByTestId('order-materials').locator('tr', { hasText: 'Pod Grape' })).toContainText('10 pcs');
  await page.goto('/#/production'); await expect(page.getByTestId('prod-cards').getByRole('button', { name: /Orders short of materials/ }).locator('.val')).toHaveText('1');
  // a BOM in the address that cannot be used is never replaced silently; a usable one is followed
  await page.goto('/#/production?tab=orders&order=new&bom=GONE'); await expect(page.getByTestId('order-bom-why')).toContainText('does not exist'); await expect(page.getByTestId('order-bom')).toHaveValue(''); await expect(page.getByRole('button', { name: 'Create order' })).toBeDisabled();
  await page.goto(`/#/production?tab=orders&order=new&bom=${bomId}`); await expect(page.getByTestId('order-bom')).toHaveValue(bomId); await expect(page.getByTestId('order-bom-why')).toHaveCount(0);
  // a BOM that starts next week is not offered, and says when it starts
  const next = new Date(Date.now() + 7 * 86400000), day = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  await tab(page, 'BOM list'); await page.getByRole('button', { name: 'New BOM' }).first().click(); await pick(page.getByTestId('pick-output'), 'duo'); await page.getByTestId('bom-yield').fill('1'); await pick(page.getByTestId('pick-component'), 'sticker');
  await page.getByRole('button', { name: 'Preview before saving' }).click(); await page.getByLabel('In use from').fill(day); await page.getByRole('button', { name: 'Save and activate' }).click(); await expect(page.locator('.mfg-h .badge')).toHaveText('Starts later');
  const duo = (await read(page)).boms[1].id; await page.goto(`/#/production?tab=orders&order=new&bom=${duo}`); await expect(page.getByTestId('order-bom-why')).toContainText('starts on'); expect((await page.getByTestId('order-bom').locator('option').allInnerTexts()).some((x) => x.includes('Duo set'))).toBe(false);
  expect(errors).toEqual([]);
});

test('(4) Material Consumption: deduction, references (order, BOM, user on the movement), valuation, entries, two warehouses in one issue', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, [['Coil Mesh', 100], ['Sleeve', 1000]]); await stockIn(page, [['Pod Grape', 50]], 'W1'); await newBom(page, { labor: '0', overhead: '0' }); await newOrder(page, '100');
  await page.getByRole('button', { name: 'Issue materials' }).click(); await expect(issueField(page, 'Pod Grape')).toHaveValue('10'); await expect(group(page, 'Pod Grape')).toContainText('Short 10');
  await group(page, 'Pod Grape').getByLabel('From warehouse').selectOption('W1'); await expect(group(page, 'Pod Grape')).not.toContainText('Short');
  await review(page); const e = modal(page).getByTestId('posting-effect');
  await expect(e).toContainText('Pod Grape · Ari store & kitchen'); await expect(e).toContainText('Coil Mesh · Central warehouse & roastery'); await expect(e.locator('.mfg-dr')).toContainText('฿1,600.00');
  await modal(page).getByRole('button', { name: 'Cancel' }).click(); expect(qty(await read(page), 'Pod Grape', 'W1')).toBe(50);   // looked at, not posted
  await review(page); await modal(page).getByRole('button', { name: 'Post', exact: true }).dblclick(); await expect(modal(page)).toHaveCount(0); await expect(page.locator('tr[data-doc=issue]')).toHaveCount(1);
  const db = await sound(page), o = db.productionOrders[0], me = db.meta.currentUserId, mis = o.issues![0].no;
  expect([qty(db, 'Pod Grape', 'W1'), qty(db, 'Coil Mesh'), qty(db, 'Sleeve')]).toEqual([40, 95, 900]);
  const mv = db.movements.filter((m) => m.type === 'prod_issue'); expect(mv).toHaveLength(3);
  for (const m of mv) { expect(m).toMatchObject({ refType: 'production', refId: o.id, userId: me }); expect(m.note).toContain(o.no); expect(m.note).toContain(mis); expect(m.note).toContain('BOM v1'); }
  expect(mv.map((m) => [db.products.find((p) => p.id === m.productId)!.name, m.warehouseId, m.qty, m.value]).sort()).toEqual([['Coil Mesh', 'W3', -5, -400], ['Pod Grape', 'W1', -10, -1000], ['Sleeve', 'W3', -100, -200]]);
  const js = db.journals.filter((j) => j.refType === 'production'); expect(js).toHaveLength(1); expect(js[0].lines).toEqual([expect.objectContaining({ account: '1220', debit: 1600 }), expect.objectContaining({ account: '1210', credit: 1600 })]); await expect(page.locator('tr[data-doc=issue]')).toContainText(js[0].no);
  // traceable on the Inventory page and on Material consumption, by order number
  await page.goto('/#/inventory?tab=movements'); await page.locator('.card input').first().fill(o.no); const rows = page.locator('table.t tbody tr'); await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'Pod Grape' })).toContainText('-10 pcs'); await expect(rows.first()).toContainText('Owner'); await expect(rows.first()).toContainText(o.no);
  await tab(page, 'Material consumption'); await page.locator('.card input').last().fill(o.no); const t = page.getByTestId('tab-consumption').locator('table.t').last();
  await expect(t.locator('tbody tr')).toHaveCount(3); const pod = t.locator('tr', { hasText: 'Pod Grape' }); for (const x of [mis, 'BOM v1', 'Ari store & kitchen', '−10 pcs', '฿100.00', '฿1,000.00', js[0].no, 'Owner', 'Resale']) await expect(pod).toContainText(x);
  expect(errors).toEqual([]);
});

test('(5) Finished Goods Receipt: location, quantity, cost, entries, manufacturing receipt not purchase', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' }); await newOrder(page, '100');
  await page.getByRole('button', { name: 'Issue materials' }).click(); await review(page); await confirm(page);
  // receiving before labour and overhead are recorded: said, and a choice, before anything is posted
  await page.getByRole('button', { name: 'Receive finished goods' }).click(); await review(page);
  const gate = page.getByTestId('missing-choice'); await expect(gate).toContainText('Labour: ฿200.00 missing'); await expect(gate).toContainText('Overhead: ฿100.00 missing'); await expect(modal(page)).toHaveCount(0);
  await gate.getByRole('button', { name: 'Go back and record it' }).click(); await expect(page.getByTestId('do-run')).toBeVisible(); await page.getByTestId('do-run').getByRole('button', { name: 'Cancel' }).click();
  await addCost(page, 'labor', '200'); await addCost(page, 'overhead', '100');
  // a typing error (10,000 for 100) is caught in the confirmation
  await page.getByRole('button', { name: 'Receive finished goods' }).click(); await page.getByTestId('out-good').fill('10000'); await page.getByLabel('Goods into warehouse').selectOption('W1'); await review(page);
  await expect(page.getByTestId('missing-choice')).toContainText('Pod Grape: 990 pcs missing'); await page.getByTestId('missing-choice').getByRole('button', { name: 'Continue without it' }).click();
  await expect(modal(page).getByTestId('posting-warn')).toContainText('You are receiving 10,000 units, but only 100 are left to make on this order (planned 100)'); await modal(page).getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('out-good').fill('100'); await review(page); await expect(modal(page).getByTestId('posting-warn')).toHaveCount(0);
  await expect(modal(page).getByTestId('posting-fact').first()).toContainText('The finished goods take ฿1,900.00 of cost: ฿19.00 per pcs.'); await expect(modal(page)).toContainText('Gift box · Ari store & kitchen'); await expect(modal(page)).toContainText('+100 pcs'); await confirm(page);
  const db = await sound(page); expect([qty(db, 'Gift box', 'W1'), value(db, 'Gift box', 'W1')]).toEqual([100, 1900]); expect(db.productionOrders[0].status).toBe('completed');
  const mv = db.movements.filter((m) => m.productId === pidOf(db, 'Gift box')); expect(mv).toEqual([expect.objectContaining({ type: 'prod_output', refType: 'production', warehouseId: 'W1', qty: 100, value: 1900 })]);
  expect([db.grns.length, db.apInvoices.length]).toEqual([0, 0]); expect(db.journals.some((j) => j.lines.some((l) => l.account === '2100'))).toBe(false);   // made, not bought: no payable
  const fgr = db.journals.find((j) => j.memo.includes('FGR-'))!; expect(fgr.lines).toEqual([expect.objectContaining({ account: '1210', debit: 1900 }), expect.objectContaining({ account: '1220', credit: 1900 })]);
  await tab(page, 'Finished goods receipts'); const r = page.getByTestId('tab-receipts').locator('table.t tbody tr').first();
  for (const x of ['FGR-000001', 'Receipt from production', 'Ari store & kitchen', '+100 pcs', '฿19.00', '฿1,900.00', fgr.no, 'BOM v1']) await expect(r).toContainText(x);
  await page.goto('/#/inventory?tab=movements'); await expect(page.locator('table.t tbody tr', { hasText: 'Gift box' })).toContainText('prod output');
  expect(errors).toEqual([]);
});

test('(6) Partial Production: two partial "Record production" runs with actual ≠ BOM and a price that changed after the order was created (20 and 20, not 10 and 30), then the rest; with rejects and replacement material', async ({ page }) => {
  const { errors, reprice } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' }); const url = await newOrder(page, '100');
  // after the order: the registry price of Pod doubles, and Pod at the new price is put into the Ari warehouse
  await reprice('Pod Grape', 200); await stockIn(page, [['Pod Grape', 20]], 'W1'); let db = await read(page); expect(value(db, 'Pod Grape', 'W1')).toBe(4000);
  const runOf = async (good: string, o: { rejected?: string; pod?: string; podWh?: string } = {}) => {
    await page.goto('/#' + url); await page.getByRole('button', { name: 'Record production' }).click(); await page.getByTestId('out-good').fill(good); if (o.rejected) await page.getByTestId('out-rejected').fill(o.rejected);
    if (o.pod) await issueField(page, 'Pod Grape').fill(o.pod); if (o.podWh) await group(page, 'Pod Grape').getByLabel('From warehouse').selectOption(o.podWh);
    await review(page); await confirm(page);
  };
  // two runs of 40 with 10% more Pod than the BOM, at the new price: 4.4 × 200 + 2 × 80 + 40 × 2 + 80 + 40 = 1,240, 31 each, both times
  await runOf('40', { pod: '4.4', podWh: 'W1' }); await expect(step(page)).toHaveText('Partly received'); await runOf('40', { pod: '4.4', podWh: 'W1' });
  db = await sound(page); expect(db.productionOrders[0].receipts!.map((r) => [r.good, r.goodValue, r.unitCost])).toEqual([[40, 1240, 31], [40, 1240, 31]]); expect(qty(db, 'Pod Grape', 'W1')).toBe(11.2);
  // 15 good and 5 rejected: the rejected units have to be made again, so the next step is material, not goods
  await runOf('15', { rejected: '5' }); db = await sound(page); expect(db.productionOrders[0].receipts![2]).toMatchObject({ good: 15, rejected: 5, unitCost: 19 }); expect(db.productionOrders[0].status).toBe('partially_completed');
  await expect(page.getByTestId('next-step')).toContainText('rejected units have to be made again');
  await tab(page, 'Finished goods receipts'); await expect(page.getByTestId('tab-receipts')).not.toContainText('Orders ready to receive');
  await page.getByRole('tab', { name: 'Material consumption' }).click(); const need = page.getByTestId('tab-consumption').locator('tr', { hasText: db.productionOrders[0].no }).first(); await expect(need).toContainText('Pod Grape × 0.5 pcs');
  // the rest, with replacement material: the last run takes what is left, and nothing stays in work in progress
  await page.goto('/#' + url); await page.getByRole('button', { name: 'Record production' }).click(); await expect(page.getByTestId('out-good')).toHaveValue('5'); await expect(issueField(page, 'Pod Grape')).toHaveValue('0.5'); await expect(page.getByLabel(/This is the last receipt/)).toBeChecked();
  await review(page); await expect(modal(page).getByTestId('posting-fact').first()).toContainText('฿19.00 per pcs'); await confirm(page);
  db = await sound(page); const o = db.productionOrders[0]; expect(o.status).toBe('completed'); expect(wipOf(o)).toBe(0); expect(o.receipts!.reduce((s, r) => s + r.good, 0)).toBe(100); expect(glOf(db, 'wip')).toBe(0);
  expect(errors).toEqual([]);
});

test('(7) Production Variances: actual consumption changed, return of unused material, waste / loss, price and usage variance shown, estimated vs actual', async ({ page }) => {
  const { errors, reprice } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' }); await newOrder(page, '100');
  const url = page.url(); await reprice('Pod Grape', 200); await stockIn(page, [['Pod Grape', 20]], 'W1'); await page.goto(url);
  // 11 Pod at 200 instead of 10 at 100, and one Coil too many that is returned
  await page.getByRole('button', { name: 'Issue materials' }).click(); await issueField(page, 'Pod Grape').fill('11'); await group(page, 'Pod Grape').getByLabel('From warehouse').selectOption('W1'); await issueField(page, 'Coil Mesh').fill('6'); await review(page); await confirm(page);
  await page.getByRole('button', { name: 'Return unused material' }).click(); await group(page, 'Coil Mesh').getByLabel('Return now (pcs)').fill('1'); await page.getByLabel('Why it is returned (required)').fill('one too many');
  await review(page); await expect(modal(page)).toContainText('Coil Mesh · Central warehouse & roastery'); await expect(modal(page)).toContainText('+1 pcs'); await expect(modal(page).locator('.mfg-cr')).toContainText('1220'); await confirm(page);
  let db = await sound(page); expect([qty(db, 'Coil Mesh'), db.productionOrders[0].returns![0].value]).toEqual([95, 80]); await expect(page.locator('tr[data-doc=return]')).toContainText('one too many');
  await addCost(page, 'labor', '250'); await addCost(page, 'overhead', '100');
  await page.getByRole('button', { name: 'Record an abnormal loss' }).click(); await page.getByLabel('Cost that was lost (฿)').fill('50'); await page.getByLabel('What happened (required)').fill('dropped'); await review(page); await confirm(page);
  // the loss took some of each material with it, so the BOM now expects a little more than the order holds: said, and a choice
  await page.getByRole('button', { name: 'Receive finished goods' }).click(); await review(page); await expect(page.getByTestId('missing-choice')).toContainText('Sleeve'); await page.getByTestId('missing-choice').getByRole('button', { name: 'Continue without it' }).click(); await confirm(page);
  db = await sound(page); expect(db.productionOrders[0].status).toBe('completed'); expect([gl(db, '5100'), glOf(db, 'wip')]).toEqual([50, 0]);
  // estimated (made at approval: 19 each) and actual apart; the variances by element: price 11 × 100, usage 1 × 100, labour 50
  const c = page.getByTestId('order-costs'); await expect(c.locator('tr', { hasText: 'Materials' })).toContainText('฿1,600.00'); await expect(c.locator('tr', { hasText: 'Materials' })).toContainText('฿2,800.00'); await expect(c.locator('tr', { hasText: 'Labour' })).toContainText('฿250.00');
  const v = page.getByTestId('order-variances'); await expect(v.locator('tr', { hasText: 'Material price' })).toContainText('+฿1,100.00'); await expect(v.locator('tr', { hasText: 'Material usage' })).toContainText('+฿100.00'); await expect(v.locator('tr', { hasText: 'Labour' })).toContainText('+฿50.00'); await expect(v.locator('tr', { hasText: 'Total' })).toContainText('+฿1,250.00');
  await expect(page.getByTestId('order-page')).toContainText('฿50.00 as waste'); await expect(page.locator('tr[data-doc=loss]')).toContainText('dropped');
  await tab(page, 'Cost & profit'); await page.getByRole('tab', { name: 'By production order' }).click(); await expect(page.locator('table.t tbody tr').first()).toContainText('+฿1,250.00'); await expect(page.locator('table.t tbody tr').first()).toContainText('฿19.00');
  expect(errors).toEqual([]);
});

test('(8) Accounting Integrity: balanced, mappings (unmapped role, owner account with WIP control), inventory accounts of different kinds, WIP zero at the end, no duplicates on double click, every journal traceable to its order, close → reopen → finish, receipt reversed', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, [['Pod Grape', 100], ['Leaf RM', 100]]);
  await newBom(page, { comps: [['pod', 'Pod Grape', '10'], ['leaf', 'Leaf RM', '5']], labor: '0', overhead: '0' }); const url = await newOrder(page, '100');
  // no account for work in progress: the banner names it, posting is refused in both languages, nothing changes
  await change(page, "db.postingMap.wip = []; db.accounts.find((a) => a.code === '1220').name = 'Owner account used for something else'"); await expect(page.getByTestId('role-banner')).toContainText('Work in progress'); await expect(page.getByTestId('role-banner').getByRole('link')).toHaveAttribute('href', /accounting\/setup/);
  const before = (await read(page)).journals.length; await page.getByRole('button', { name: 'Record production' }).click(); await review(page);
  await expect(toast(page)).toContainText('No account is mapped for “Work in progress”'); await expect(toast(page).locator('.err-other')).toContainText(/[ก-๙]/); expect((await read(page)).journals).toHaveLength(before);
  // the owner's own WIP account (control: work in progress) is used as it is
  await change(page, "db.accounts.push({ ...db.accounts.find((a) => a.code === '1220'), code: '1221', name: 'Own production WIP', nameTh: 'งานระหว่างทำของร้าน', system: false }); db.postingMap.wip = [{ code: '1221', from: '2000-01-01T00:00:00.000Z' }]");
  await expect(page.getByTestId('role-banner')).toHaveCount(0);
  // half, posted with a double click: one issue, one receipt; raw material and goods each to their own inventory account
  await page.getByRole('button', { name: 'Record production' }).click(); await page.getByTestId('out-good').fill('50'); await review(page); await modal(page).getByRole('button', { name: 'Post', exact: true }).dblclick(); await expect(modal(page)).toHaveCount(0);
  let db = await sound(page); const o = () => db.productionOrders[0]; expect([o().issues!.length, o().receipts!.length]).toEqual([1, 1]);
  const issue = db.journals.find((j) => j.memo.includes('materials issued'))!; expect(issue.lines.map((l) => [l.account, l.debit || -l.credit]).sort()).toEqual([['1200', -12.5], ['1210', -500], ['1221', 512.5]]);
  // the material for the rest is issued, then the order is closed early: that material goes to the variance; opened again with a reason, it is back and the order is finished properly
  await page.getByRole('button', { name: 'Issue materials' }).click(); await review(page); await confirm(page);
  await page.getByRole('button', { name: 'Close order' }).click(); await confirm(page, 'Close order'); await expect(step(page)).toHaveText('Production completed');
  await page.getByRole('button', { name: 'Open again' }).click(); await expect(modal(page).getByRole('button', { name: 'Open again' })).toBeDisabled(); await modal(page).getByRole('textbox').fill('closed too early'); await confirm(page, 'Open again');
  db = await sound(page); expect(o().status).toBe('partially_completed'); expect(o().variances!.map((x) => !!x.reversal)).toEqual([true]); expect(wipOf(o())).toBe(512.5); expect([gl(db, '5310')]).toEqual([0]);
  await page.getByRole('button', { name: 'Record production' }).click(); await review(page); await confirm(page); await expect(step(page)).toHaveText('Production completed');
  // the last receipt reversed: goods out, cost back, the order open; received again
  await reverse(page, 'receipt', 'counted twice'); db = await sound(page); expect(o().status).toBe('partially_completed'); expect(wipOf(o())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Receive finished goods' }).click(); await review(page); await confirm(page);
  db = await sound(page); expect([wipOf(o()), glOf(db, 'wip'), gl(db, '1220'), gl(db, '1221')]).toEqual([0, 0, 0, 0]); expect(qty(db, 'Gift box')).toBe(100); expect(value(db, 'Gift box')).toBe(1025);
  // every journal of production belongs to this order (or reverses one that does), and the order lists them all
  const own = db.journals.filter((j) => j.refType === 'production'); for (const j of own) expect(j.refId).toBe(o().id);
  const mirrors = db.journals.filter((j) => j.reverses && own.some((x) => x.id === j.reverses)); expect(db.journals.filter((j) => j.refType === 'reversal')).toHaveLength(mirrors.length);
  await page.goto('/#' + url); await expect(page.getByTestId('order-journals').getByRole('button')).toHaveCount(own.length + mirrors.length);
  expect(errors).toEqual([]);
});

test('(9) Profit Analysis: unit cost, total cost, price, GP per unit, margin, total profit after a real POS sale, and the Profit page net equal to the ledger with labour absorbed', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' }); await newOrder(page, '100');
  await page.getByRole('button', { name: 'Record production' }).click(); await page.getByLabel('Goods into warehouse').selectOption('W1'); await review(page); await confirm(page);
  await tab(page, 'Cost & profit'); const row = page.locator('table.t tbody tr', { hasText: 'Gift box' });
  for (const x of ['฿19.00', '฿100.00', '฿81.00', '81.0%']) await expect(row).toContainText(x);
  await page.getByRole('tab', { name: 'By production order' }).click(); const po = page.locator('table.t tbody tr').first(); for (const x of ['100 / 100', '฿19.00', '฿1,900.00', '฿100.00', '฿81.00']) await expect(po).toContainText(x);
  // a real sale on the POS: 107 with VAT, 100 before VAT, 19 of cost
  await page.goto('/#/pos'); await page.getByRole('button', { name: 'Add Gift box' }).click(); await page.getByRole('button', { name: /Charge/ }).click(); await modal(page).getByRole('button', { name: 'Add payment' }).click(); await modal(page).getByRole('button', { name: 'Complete sale' }).click(); await expect(page.getByText(/Sale complete/)).toBeVisible();
  await tab(page, 'Cost & profit'); await row.getByRole('button').click(); const c = page.getByTestId('cost-product');
  for (const x of ['Units sold1', 'Revenue (net of VAT)฿100.00', 'Cost of sales฿19.00', 'Gross profit฿81.00', 'Margin81.0%']) await expect(c).toContainText(x);
  await expect(row).toContainText('฿100.00'); await expect(row).toContainText('฿81.00');
  // the Profit page: labour and overhead in the cost of the goods are not deducted again, so its net profit is the result of the ledger
  const db = await sound(page); expect(gl(db, '5400')).toBe(-300);
  await page.goto('/#/profit'); await expect(page.locator('.kpi', { hasText: 'Net profit (business)' }).locator('.val')).toHaveText(money0(ledgerNet(db)));
  expect(errors).toEqual([]);
});

test('(10) UI and Usability: buttons, forms, filters, search, tabs, dialogs, tables, refresh/reload, understandable errors in both languages, responsive, unsaved-input question, permissions, axe in Thai and English and in dark theme', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' });
  const a = await newOrder(page, '100'); await newOrder(page, '20', { approve: false }); await page.goto('/#' + a); await page.getByRole('button', { name: 'Record production' }).click(); await review(page); await confirm(page);
  // tabs in the address, reload keeps the place; the status filter and the search narrow the list
  await tab(page, 'Production orders'); await expect(page).toHaveURL(/tab=orders/); await page.reload(); await expect(page.getByRole('tab', { name: 'Production orders' })).toHaveAttribute('class', /on/);
  await page.getByLabel('Production order status').selectOption('planned'); await expect(page.locator('table.t tbody tr')).toHaveCount(1); await page.getByLabel('Production order status').selectOption('');
  await page.locator('.card input').first().fill('PRD-000001'); await expect(page.locator('table.t tbody tr')).toHaveCount(1); await expect(page.locator('table.t tbody tr')).toContainText('Production completed');
  // an error says what is wrong in both languages, and nothing is posted
  await page.locator('.card input').first().fill(''); await page.getByRole('button', { name: 'PRD-000002' }).click(); await page.getByRole('button', { name: 'Approve order' }).click();
  await page.getByRole('button', { name: 'Issue materials' }).click(); await issueField(page, 'Pod Grape').fill('5000'); await review(page);
  await expect(toast(page).locator('.err-main')).toContainText('Insufficient stock for Pod Grape'); await expect(toast(page).locator('.err-other')).toContainText(/[ก-๙]/); await expect(modal(page)).toHaveCount(0);
  // typed input is not lost by accident: another action, a tab, the side menu, the Back button, closing the tab
  await page.getByRole('button', { name: 'Add a cost' }).click(); await expect(modal(page)).toContainText('Leave without saving?'); await modal(page).getByRole('button', { name: 'Cancel' }).click(); await expect(issueField(page, 'Pod Grape')).toHaveValue('5000');
  await page.getByRole('tab', { name: 'BOM list' }).click(); await modal(page).getByRole('button', { name: 'Cancel' }).click(); await expect(page).toHaveURL(/order=PR/);
  await page.locator('.sidebar').getByRole('link', { name: 'Inventory' }).click(); await expect(modal(page)).toContainText('What you typed here has not been saved.'); await modal(page).getByRole('button', { name: 'Cancel' }).click(); await expect(page).toHaveURL(/production/);
  await page.getByRole('button', { name: 'Back to the orders' }).click(); await expect(modal(page)).toContainText('Leave without saving?'); await modal(page).getByRole('button', { name: 'Cancel' }).click(); await expect(page).toHaveURL(/order=PR/); await expect(issueField(page, 'Pod Grape')).toHaveValue('5000');
  await page.getByRole('tab', { name: 'BOM list' }).click(); await modal(page).getByRole('button', { name: 'Leave without saving' }).click(); await expect(page).toHaveURL(/tab=boms/);
  await page.getByRole('tab', { name: 'Production orders' }).click(); await expect(modal(page)).toHaveCount(0);                                     // nothing typed, nothing asked
  await page.goto('/#/production?tab=boms&bom=new'); await pick(page.getByTestId('pick-output'), 'duo');
  let asked = ''; page.once('dialog', (d) => { asked = d.type(); void d.dismiss(); }); await page.close({ runBeforeUnload: true }); await expect.poll(() => asked).toBe('beforeunload');
  expect(errors).toEqual([]);
});

test('(10b) UI and Usability: axe in English and in dark theme, with dialogs and tables open', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' }); const a = await newOrder(page, '100'); await page.getByRole('button', { name: 'Issue materials' }).click(); await review(page); await confirm(page);
  const bom = (await read(page)).boms[0].id;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/production', `/production?tab=boms&bom=${bom}`, '/production?tab=boms&bom=new', a, '/production?tab=consumption', '/production?tab=receipts', '/production?tab=costs', '/production?tab=history']) {
      await page.goto('/#' + path); await expect(page.locator('.tabs')).toBeVisible(); await page.waitForTimeout(200);
      if (path === a) { await page.getByRole('button', { name: 'Receive finished goods' }).click(); await review(page); await expect(page.getByTestId('missing-choice')).toBeVisible(); }
      const r = await new AxeBuilder({ page }).include('.content').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`), `${scheme} ${path}`).toEqual([]);
      if (path === a) { await page.getByTestId('missing-choice').getByRole('button', { name: 'Continue without it' }).click(); await expect(modal(page)).toBeVisible(); const m = await new AxeBuilder({ page }).include('.modal').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(m.violations.map((v) => v.id), `${scheme} dialog`).toEqual([]); await modal(page).getByRole('button', { name: 'Cancel' }).click(); await page.getByTestId('do-receive').getByRole('button', { name: 'Cancel' }).click(); }
    }
  }
  expect(errors).toEqual([]);
});

test('(10c) UI and Usability: permissions; without finance:cost no amount is shown anywhere, labour is still added, and buttons a person may not use are not there', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' }); const url = await newOrder(page, '100');
  await page.getByRole('button', { name: 'Issue materials' }).click(); await review(page); await confirm(page);
  await change(page, "db.roles.find((r) => r.id === 'role-owner').permissions = ['production:view', 'production:create', 'production:edit', 'inventory:view', 'catalog:view']"); await page.goto('/#' + url);
  for (const b of ['Add a cost', 'Record an abnormal loss', 'Cancel this order', 'Close order']) await expect(page.getByRole('button', { name: b })).toHaveCount(0);
  // a plain receipt by somebody who may not see costs brings the labour and overhead of the BOM, as "Record production" does
  await page.getByRole('button', { name: 'Receive finished goods' }).click(); await review(page); await expect(modal(page)).toContainText('Labour and other costs from the BOM are added automatically.'); await expect(modal(page)).toContainText('Amounts are hidden for your role.');
  expect(await modal(page).innerText()).not.toContain('฿'); await confirm(page); await expect(step(page)).toHaveText('Production completed');
  for (const t of ['Production overview', 'BOM list', 'Production orders', 'Material consumption', 'Finished goods receipts', 'History of production']) { await page.getByRole('tab', { name: t }).click(); expect(await page.locator('.content').innerText(), t).not.toContain('฿'); }
  await expect(page.getByRole('tab', { name: 'Cost & profit' })).toHaveCount(0); await page.goto('/#/production?tab=costs'); await expect(page.getByText('Your role does not include this')).toBeVisible();
  // a BOM editor without finance:cost: amounts are hidden, kept as they are, and cannot be changed
  await page.goto('/#/production?tab=boms'); await page.getByRole('button', { name: 'Gift box' }).click(); await page.getByRole('button', { name: 'New BOM version' }).click();
  await expect(page.getByLabel('Labour cost per batch (฿)')).toHaveValue('Amount set (hidden for your role)'); await expect(page.getByLabel('Labour is not known yet')).toHaveCount(0); expect(await page.locator('.content').innerText()).not.toContain('฿200');
  await line(page, 'Pod Grape').getByLabel('Quantity per batch (pcs)').fill('11'); await page.getByRole('button', { name: 'Preview before saving' }).click(); await expect(page.getByRole('button', { name: 'Save and activate' })).toHaveCount(0); await page.getByRole('button', { name: 'Save as draft' }).click();
  const db = await sound(page); expect(db.boms[0].versions[1]).toMatchObject({ status: 'draft', laborCost: 200, overheadCost: 100, components: [{ qty: 11 }, { qty: 5 }, { qty: 100 }] }); expect(value(db, 'Gift box')).toBe(1900);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------------------------------------ the live situation, empty data, overview cards, Thai and widths
test('the live situation: 149 products, nearly all resale, no BOM, no stock: nothing crashes and the screens say what to do next', async ({ page }) => {
  const { errors } = await open(page);
  await expect(page.getByTestId('prod-start').getByRole('listitem')).toHaveCount(4); await expect(page.getByTestId('device-note')).toHaveCount(1);
  for (const t of ['BOM list', 'Production orders', 'Material consumption', 'Finished goods receipts', 'Cost & profit', 'History of production', 'Production overview']) { await page.getByRole('tab', { name: t }).click(); await expect(page.locator('.empty, [data-testid=prod-start]').first()).toBeVisible(); await expect(page).toHaveURL(/tab=/); }
  await page.getByRole('button', { name: 'New production order' }).first().click(); await expect(page.getByText('A production order is made from a BOM. Create and activate a BOM first.')).toBeVisible();
  await page.goto('/#/production?tab=orders&order=GONE'); await expect(page.getByText('This production order does not exist')).toBeVisible();
  await page.goto('/#/production?tab=boms&bom=GONE'); await expect(page.getByText('This BOM does not exist any more')).toBeVisible();
  for (const lang of ['th', 'en']) {
    await page.evaluate((l) => localStorage.setItem('bizops.lang', l), lang); await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang); await page.goto('/#/production'); await page.reload(); await expect(page.getByTestId('prod-start')).toBeVisible();
    if (lang === 'th') for (const [w, h] of [[1440, 900], [390, 844], [320, 640]]) { await page.setViewportSize({ width: w, height: h }); expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${w}`).toBeLessThanOrEqual(0); }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(errors).toEqual([]);
});

test('an empty catalogue and no warehouse: no crash', async ({ page }) => {
  const { errors } = await open(page, { feed: [] });
  await page.getByRole('button', { name: 'New BOM' }).first().click(); await page.getByTestId('pick-output').getByRole('combobox').click();
  await expect(page.getByText('There is no product yet. Add products on the Products page first.')).toBeVisible();
  await page.getByRole('button', { name: 'Preview before saving' }).click(); await expect(page.getByText('Choose the product to make first')).toBeVisible(); await expect(page.locator('.mfg-err').filter({ hasText: 'Add at least one component first' })).toBeVisible();
  await change(page, 'db.warehouses = []'); await page.goto('/#/production?tab=orders&order=new'); await expect(page.getByText('There is no warehouse')).toBeVisible();
  expect(errors).toEqual([]);
});

test('overview cards: the number is the length of the list, pressing again shows everything', async ({ page }) => {
  const { errors } = await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '0', overhead: '0' }); await newOrder(page, '100'); await page.getByRole('button', { name: 'Record production' }).click(); await review(page); await confirm(page);
  await newOrder(page, '10'); await page.getByRole('button', { name: 'Issue materials' }).click(); await review(page); await confirm(page); await newOrder(page, '5000', { approve: false }); await page.goto('/#/production');
  const cards = page.getByTestId('prod-cards').getByRole('button'); await expect(cards).toHaveCount(6); expect(await cards.locator('.val').allInnerTexts()).toEqual(['1', '2', '1', '1', '1', '฿1,600']);
  for (const [i, n] of [[0, 1], [1, 2], [2, 1], [3, 1], [4, 1], [5, 1]]) { await cards.nth(i).click(); await expect(cards.nth(i)).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByTestId('prod-cards').locator('[aria-pressed=true]')).toHaveCount(1); await expect(page.locator('table.t tbody tr')).toHaveCount(n); }
  await expect(page.getByTestId('prod-showing')).toContainText('1 of 3 orders'); await cards.nth(5).click(); await expect(page.getByTestId('prod-showing')).toContainText('3 of 3 orders'); await expect(page.locator('table.t tbody tr')).toHaveCount(3);
  await cards.nth(3).focus(); await page.keyboard.press('Enter'); await expect(page.locator('table.t tbody tr')).toContainText('materials short'); expect(errors).toEqual([]);
});

test('Thai: the whole way by keyboard, no English left, axe, no sideways scrolling and nothing cut off at 1440, 1024, 820, 390 and 320', async ({ page }) => {
  test.setTimeout(360_000);
  await open(page); await stockIn(page, STOCK); await newBom(page, { labor: '200', overhead: '100' }); await newOrder(page, '100'); await page.getByRole('button', { name: 'Record production' }).click(); await page.getByTestId('out-good').fill('60'); await page.getByTestId('out-rejected').fill('5'); await review(page); await confirm(page); const order = page.url().split('#')[1];
  const bomId = (await read(page)).boms[0].id; await newOrder(page, '5000'); const short = page.url().split('#')[1];
  await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'th'); } catch { /* ignore */ } }); await page.goto('/#/production'); await page.reload();
  const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message));
  // keyboard only: choose a product, add components
  await page.goto('/#/production?tab=boms&bom=new'); await page.getByTestId('pick-output').getByRole('combobox').focus(); await page.keyboard.type('duo'); await page.keyboard.press('Enter'); await page.getByTestId('pick-component').getByRole('combobox').focus(); await page.keyboard.type('pod'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter'); await page.keyboard.type('sleeve'); await page.keyboard.press('Enter'); await expect(page.getByTestId('bom-line')).toHaveCount(2);
  const DATA = /Gift box|Duo set|Pod Grape|Coil Mesh|Sleeve|Sticker|Mystery part|Leaf RM|Base WIP|\bLeaf\b|Puff old \d+|BRAND|RELX|OLD-COIL-9|POD · \w+|Puff|Owner|pcs|BOM|VAT|SKU|\b(PRD|MIS|MRT|FGR|JV|FG|RM|WIP|PR|BM)-?\w*\d+|Central warehouse & roastery|Ari store & kitchen|Thonglor stock|\bv\d+\b|\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*/g;
  const english = async (where: Locator) => { const other = await where.locator('.err-other').allInnerTexts(); const text = other.reduce((s, x) => s.replace(x, ' '), await where.innerText()).replace(DATA, ' '); return text.match(/[A-Za-z]{3,}[^\n]*/g) ?? []; };
  const look = async (name: string) => {
    // an error message carries both languages by design: its English line is not counted
    expect(await english(page.locator('.content')), `English on ${name}`).toEqual([]);
    for (const [w, h] of [[1440, 900], [1024, 768], [820, 1180], [390, 844], [320, 640]]) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(120);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${name} at ${w}`).toBeLessThanOrEqual(0);
      // nothing ends outside the screen or is cut inside its box; a wide table scrolls in its own frame, as everywhere in the app
      const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.content *, .modal *')].filter((e) => !e.closest('.table-wrap, .tabs') && e.getClientRects().length && (e.getBoundingClientRect().right > innerWidth + 1 || (e.matches('button, .badge, .card-b, .banner, h1, h2, h3, label, dd, dt, .kpi, .pp-row, .step, .field, .mfg-je > div') && e.scrollWidth - e.clientWidth > 1))).map((e) => `${e.className || e.tagName}: ${e.textContent?.slice(0, 40)}`));
      expect(cut, `${name} at ${w}`).toEqual([]);
      if (process.env.SHOP_SHOTS && [1440, 820, 390].includes(w)) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${process.env.SHOP_SHOTS}/prod-${name}-${w}.png`, fullPage: true }); }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const r = await new AxeBuilder({ page }).include('.content').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`), `axe on ${name}`).toEqual([]);
  };
  await line(page, 'Pod Grape').getByRole('spinbutton').first().fill('0'); await look('bom-editor');
  await page.getByTestId('pick-component').getByRole('combobox').click(); await look('picker');
  await page.getByRole('tab', { name: 'ภาพรวมการผลิต' }).click(); await modal(page).getByRole('button', { name: 'ออกโดยไม่บันทึก' }).click();
  for (const [name, path] of [['overview', '/production'], ['boms', '/production?tab=boms'], ['bom', `/production?tab=boms&bom=${bomId}`], ['orders', '/production?tab=orders'], ['order-form', '/production?tab=orders&order=new'], ['order', order], ['order-short', short], ['consumption', '/production?tab=consumption'], ['receipts', '/production?tab=receipts'], ['costs', '/production?tab=costs'], ['history', '/production?tab=history'], ['movements', '/inventory?tab=movements']]) {
    await page.goto('/#' + path); await expect(page.locator('.page-head').first()).toBeVisible(); await page.waitForTimeout(250);
    if (name === 'costs') await page.locator('table.t .linkish').first().click();
    if (name === 'order') await page.getByTestId('order-journals').getByRole('button').first().click();
    if (name === 'movements') { expect(await page.locator('table.t tbody tr').first().innerText()).toMatch(/PRD-\d+/); continue; }
    await look(name);
    if (name === 'order-short') { for (const [i, b] of ['บันทึกการผลิต', 'เบิกวัตถุดิบ', 'เพิ่มค่าใช้จ่าย'].entries()) { await page.getByRole('button', { name: b, exact: true }).click(); await look(`do-${i}`); } }
    if (name === 'order') {
      // the receipt of what is left: the BOM still expects material for it (rejects to make again), said before anything is posted
      for (const b of ['บันทึกการสูญเสียผิดปกติ', 'รับสินค้าสำเร็จรูป']) await page.getByRole('button', { name: b, exact: true }).click();
      await page.getByTestId('review-post').click(); await expect(page.getByTestId('missing-choice')).toBeVisible(); await page.getByTestId('missing-choice').scrollIntoViewIfNeeded(); await look('receive-warning');
      await page.getByTestId('missing-choice').getByRole('button', { name: 'ดำเนินการต่อโดยไม่มีส่วนนี้' }).click(); await expect(modal(page)).toContainText('การเคลื่อนไหวสต็อก');
      expect(await english(modal(page))).toEqual([]); const r = await new AxeBuilder({ page }).include('.modal').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(r.violations.map((v) => v.id)).toEqual([]);
      if (process.env.SHOP_SHOTS) { await page.screenshot({ path: `${process.env.SHOP_SHOTS}/prod-receive-confirm-1440.png` }); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${process.env.SHOP_SHOTS}/prod-receive-confirm-390.png` }); await page.setViewportSize({ width: 1440, height: 900 }); }
      await page.keyboard.press('Escape'); await expect(modal(page)).toHaveCount(0);
    }
  }
  expect(errors).toEqual([]);
});
