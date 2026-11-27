// Purchasing through the screens, in a real Chrome against a fake backend, in the owner's situation: a book with NO suppliers, products from the SKU feed, no stock. Everything checked is what the
// app really keeps (its IndexedDB) and shows. The rules (stock, payable, reversals, returns) are proven in tests/unit/purchasing.test.ts; THIS file proves the screens: the order page no longer breaks
// without a supplier, any item can be ordered, the supplier's usual items, a draft is edited and approved, a receipt posts once, can be paid at once, can be reversed, and the books stay balanced.
import { expect, test, type Page, type Route } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
test.setTimeout(120_000);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const sku = (code: string, name: string, o: Record<string, unknown> = {}) => ({ sku_code: code, legacy_sku_code: null, sku_category: code.split('-')[0], origin: 'app', name_full: name, brand: 'BRAND', product_type: 'Puff', domain: 'POD / vape (Ref POD)', pack_qty: null, unit_en: null, unit_th: null, barcode: null,
  status: 'active', cost_price: 10, retail_price: 200, selling_price: 200, friend_price: null, wholesale_price: null, ecommerce_price: null, needs_review: false, review_notes: null, updated_at: '2026-11-25T00:00:00Z', category_id: null, category_code: null, category_name: null, ...o });
const FEED = [sku('FG-000002', 'Pod Grape', { cost_price: 100 }), sku('FG-000003', 'Coil Mesh', { cost_price: 80 }), sku('FG-000004', 'Sleeve', { cost_price: 2 }), sku('FG-000005', 'Old stock', { status: 'inactive' })];
interface Db {
  products: { id: string; name: string }[]; balances: Record<string, { qty: number; value: number }>; journals: { no: string; lines: { account: string; debit: number; credit: number }[]; status: string }[];
  purchaseOrders: { id: string; no: string; status: string; approvedBy?: string; lines: { productId: string; qty: number; receivedQty: number; discountPct?: number }[]; history?: { action: string }[] }[];
  grns: { id: string; no: string; invoiceId: string; reversal?: unknown }[]; apInvoices: { id: string; status: string; amount: number; paid: number; invoiceNo: string }[]; suppliers: { id: string; name: string; productIds: string[] }[];
  meta: { currentUserId: string }; supplierPayments: { amount: number; reversal?: unknown }[]; warehouses: { id: string; name: string }[]; accounts: { code: string; control?: string }[];
}
const read = (page: Page) => page.evaluate(() => new Promise<Db>((ok, bad) => { const r = indexedDB.open('bizops-platform', 1); r.onerror = bad; r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('db'); g.onsuccess = () => ok(g.result); g.onerror = bad; }; }));
const r2 = (n: number) => Math.round(n * 100) / 100;
const gl = (db: Db, account: string) => r2(db.journals.flatMap((j) => j.lines).filter((l) => l.account === account).reduce((s, l) => s + l.debit - l.credit, 0));
const glOf = (db: Db, control: string) => r2(db.accounts.filter((a) => a.control === control).reduce((s, a) => s + gl(db, a.code), 0));
/** every entry balanced, stock value = the inventory accounts, the supplier invoices = the payables account */
async function sound(page: Page): Promise<Db> {
  const db = await read(page);
  for (const j of db.journals) expect(r2(j.lines.reduce((s, l) => s + l.debit - l.credit, 0)), j.no).toBe(0);
  expect(r2(Object.values(db.balances).reduce((s, b) => s + b.value, 0))).toBe(glOf(db, 'inventory'));
  expect(r2(-glOf(db, 'ap')) + 0).toBe(r2(db.apInvoices.filter((i) => i.status !== 'void').reduce((s, i) => s + i.amount - i.paid, 0)) + 0);
  return db;
}
const pidOf = (db: Db, name: string) => db.products.find((p) => p.name === name)!.id;

async function open(page: Page, lang: 'en' | 'th' = 'en') {
  const fake = new FakeShop(); fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Owner'; fake.w.role = 'manager';
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await fake.install(page);
  const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/rest/v1/rpc/sku_*', async (r: Route) => {
    if (r.request().method() === 'OPTIONS') return r.fallback();
    const fn = new URL(r.request().url()).pathname.split('/').pop();
    if (fn === 'sku_changes_since') return json(r, { cursor: 1, full: r.request().postDataJSON()?.p_cursor == null, rows: FEED });
    return r.fallback();
  });
  await page.route('**/rest/v1/rpc/product_categories_list', (r) => (r.request().method() === 'OPTIONS' ? r.fallback() : json(r, { code: 'PGRST202', message: 'Could not find the function public.product_categories_list in the schema cache' }, 404)));
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/purchasing');
  await expect(page.locator('.tabs')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await read(page)).products.length, { timeout: 20_000 }).toBe(FEED.length);
  return { errors };
}
const modal = (page: Page) => page.locator('.modal').last();
async function newSupplier(page: Page, name: string, o: { usual?: string[]; vat?: boolean } = {}) {
  await page.getByRole('tab', { name: /Suppliers/ }).click();
  await page.getByRole('button', { name: 'New supplier' }).click();
  await modal(page).getByRole('textbox', { name: 'Name' }).fill(name);
  if (o.vat === false) await modal(page).getByLabel('VAT-registered supplier (input VAT is claimed)').uncheck();
  for (const u of o.usual ?? []) await modal(page).getByTestId('supplier-items').getByLabel(new RegExp(u)).check();
  await modal(page).getByRole('button', { name: 'Save' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  await page.getByRole('tab', { name: /Purchase orders/ }).click();
}
async function fillLine(page: Page, i: number, item: string, qty: string, cost: string, disc = '') {
  const row = page.getByTestId('po-line').nth(i);
  await row.getByRole('combobox', { name: 'Item' }).selectOption({ label: item });
  await row.getByLabel('Qty').fill(qty); await row.getByLabel('Unit cost').fill(cost); if (disc) await row.getByLabel('Discount %').fill(disc);
}
const rowOf = (page: Page, text: string) => page.locator('table.t tbody tr', { hasText: text });

test('a book with no supplier: "New purchase order" says so and offers the Suppliers tab (it used to break the page)', async ({ page }) => {
  const { errors } = await open(page);
  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  await expect(modal(page).getByTestId('no-suppliers')).toBeVisible();
  await modal(page).getByRole('button', { name: 'Go to Suppliers' }).click();
  await expect(page.getByRole('button', { name: 'New supplier' })).toBeVisible();
  // the other two forms that read the first supplier do not break either
  await page.getByRole('tab', { name: /Payables/ }).click(); await expect(page.getByText('No supplier invoices yet')).toBeVisible();
  await page.getByRole('tab', { name: /Returns/ }).click(); await page.getByRole('button', { name: 'New return' }).click(); await expect(modal(page).getByTestId('no-suppliers')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a new supplier can buy ANY item (not only its usual ones); usual items come first; the draft is edited, approved with a stamp, received in parts, paid at once, and the books balance', async ({ page }) => {
  const { errors } = await open(page);
  await newSupplier(page, 'Alpha Supplies', { usual: ['Pod Grape'] });
  expect((await read(page)).suppliers[0].productIds).toHaveLength(1);

  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  const m = modal(page);
  const options = (g: string) => m.getByTestId('po-line').first().getByRole('combobox', { name: 'Item' }).locator(`optgroup[label="${g}"] option`).allInnerTexts();
  expect(await options('Usual items of this supplier')).toEqual(['Pod Grape']);
  expect((await options('All other items')).sort()).toEqual(['Coil Mesh', 'Sleeve']);                              // every active item can be bought; an inactive one is not offered
  await fillLine(page, 0, 'Coil Mesh', '10', '80', '10');                                                        // an item that is NOT one of the supplier's usual ones
  await expect(m.getByTestId('po-total')).toHaveText('฿720.00');                                                  // 10 x 80 less 10%
  await m.getByRole('button', { name: 'Add line' }).click();
  await expect(page.getByTestId('po-line').nth(1).getByRole('combobox', { name: 'Item' }).locator('option', { hasText: 'Coil Mesh' })).toHaveCount(0);   // already on the order: not offered twice
  await fillLine(page, 1, 'Pod Grape', '20', '100');
  await expect(m.getByTestId('po-total')).toHaveText('฿2,720.00');
  await m.getByRole('button', { name: 'Save draft' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  let db = await read(page);
  expect(db.purchaseOrders[0].status).toBe('draft'); expect(db.purchaseOrders[0].approvedBy).toBeUndefined();
  expect(db.suppliers[0].productIds).toHaveLength(1);                                                              // a draft teaches the supplier nothing yet

  // a draft cannot be received; it can be edited, then approved
  const row = rowOf(page, db.purchaseOrders[0].no);
  await expect(row.getByRole('button', { name: 'Receive' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('po-line').nth(1).getByLabel('Qty').fill('10');
  await expect(modal(page).getByTestId('po-total')).toHaveText('฿1,720.00');
  await modal(page).getByRole('button', { name: 'Approve & send' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  db = await read(page);
  expect(db.purchaseOrders[0].status).toBe('sent'); expect(db.purchaseOrders[0].approvedBy).toBe(db.meta.currentUserId); expect(db.purchaseOrders[0].history!.map((h) => h.action)).toEqual(['created', 'edited', 'approved']);
  expect(db.suppliers[0].productIds).toHaveLength(2);                                                              // sent: Coil Mesh is now one of its usual items

  // receive part of it, the rest later, the first one paid at once
  await rowOf(page, db.purchaseOrders[0].no).getByRole('button', { name: 'Receive' }).click();
  const rm = modal(page);
  await rm.getByLabel('Receive now Coil Mesh').fill('4'); await rm.getByLabel('Receive now Pod Grape').fill('0');
  await rm.getByRole('textbox').first().fill('INV-100');                                                             // supplier invoice no.
  await rm.getByLabel('Paid now (the invoice of this receipt is paid at once)').check();
  await rm.getByRole('button', { name: 'Post receipt' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  db = await sound(page);
  expect(db.purchaseOrders[0].status).toBe('partial');
  expect(db.balances[`${db.warehouses.find((w) => w.id === 'W3') ? 'W3' : db.warehouses[0].id}|${pidOf(db, 'Coil Mesh')}`]).toMatchObject({ qty: 4, value: 288 });   // 4 x 80 less 10%
  expect(db.apInvoices[0]).toMatchObject({ invoiceNo: 'INV-100', status: 'paid', paid: 308.16 });                      // 288 + 7% VAT, paid in the same step
  await rowOf(page, db.purchaseOrders[0].no).getByRole('button', { name: 'Receive' }).click();
  await modal(page).getByRole('textbox').first().fill('INV-101');
  await modal(page).getByRole('button', { name: 'Post receipt' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  db = await sound(page);
  expect(db.purchaseOrders[0].status).toBe('received'); expect(db.grns).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('a wrong receipt is reversed from the order page (reason required); a wrong payment is cancelled from Payables; the books stay balanced and nothing is deleted', async ({ page }) => {
  const { errors } = await open(page);
  await newSupplier(page, 'Beta Trading', { vat: false });
  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  await fillLine(page, 0, 'Pod Grape', '10', '100');
  await modal(page).getByRole('button', { name: 'Approve & send' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  let db = await read(page); const no = db.purchaseOrders[0].no;
  await rowOf(page, no).getByRole('button', { name: 'Receive' }).click();
  await modal(page).getByRole('textbox').first().fill('WRONG-1');
  await modal(page).getByRole('button', { name: 'Post receipt' }).click(); await expect(page.locator('.modal')).toHaveCount(0);

  // the invoice is paid, so the receipt cannot be reversed until the payment is cancelled
  await page.getByRole('tab', { name: /Payables/ }).click();
  await page.getByRole('button', { name: 'Pay supplier' }).click();
  await modal(page).getByRole('button', { name: 'Pay all owed' }).click(); await modal(page).getByRole('button', { name: /^Pay ฿/ }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  await page.getByRole('tab', { name: /Purchase orders/ }).click();
  await rowOf(page, no).getByRole('button', { name: 'Details' }).click();
  await page.getByTestId('po-receipt').getByRole('button', { name: 'Reverse' }).click();
  await expect(modal(page).getByRole('button', { name: 'Reverse the receipt' })).toBeDisabled();                    // a reason is required
  await modal(page).getByRole('textbox').fill('delivered to the wrong shop'); await modal(page).getByRole('button', { name: 'Reverse the receipt' }).click();
  await expect(page.locator('.toast.error').first()).toBeVisible();                                                  // refused: it has a payment
  db = await read(page); expect(db.grns[0].reversal).toBeUndefined();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Payables/ }).click();
  await page.locator('.card', { hasText: 'Supplier payments' }).getByRole('button', { name: 'Cancel' }).click();
  await modal(page).getByRole('textbox').fill('paid the wrong supplier'); await modal(page).getByRole('button', { name: 'Cancel the payment' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  db = await sound(page); expect(db.supplierPayments[0].reversal).toBeTruthy(); expect(db.apInvoices[0]).toMatchObject({ status: 'open', paid: 0 });

  await page.getByRole('tab', { name: /Purchase orders/ }).click();
  await rowOf(page, no).getByRole('button', { name: 'Details' }).click();
  await page.getByTestId('po-receipt').getByRole('button', { name: 'Reverse' }).click();
  await modal(page).getByRole('textbox').fill('delivered to the wrong shop'); await modal(page).getByRole('button', { name: 'Reverse the receipt' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  db = await sound(page);
  expect(db.grns[0].reversal).toBeTruthy(); expect(db.apInvoices[0].status).toBe('void'); expect(db.apInvoices).toHaveLength(1);            // kept, void
  expect(db.purchaseOrders[0].status).toBe('sent'); expect(Object.values(db.balances).every((b) => b.qty === 0)).toBe(true);
  await expect(page.getByTestId('po-receipt')).toContainText('reversed');
  expect(errors).toEqual([]);
});

test('Thai: the new buttons and messages read in Thai', async ({ page }) => {
  await open(page, 'th');
  await page.getByRole('button', { name: /ใบสั่งซื้อใหม่|New purchase order/ }).first().click();
  await expect(modal(page).getByTestId('no-suppliers')).toContainText('ยังไม่มีผู้ขาย');
});
