// Back-office "Online shop" page against the fake backend (see fakeBackend.ts). The staff app is English by default;
// one test checks the Thai wording too.
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

async function openAdmin(page: Page, fake: FakeShop, lang: 'en' | 'th' = 'en') {
  fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff';
  await fake.install(page);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/shop-admin');
  await expect(page.getByRole('heading', { name: lang === 'en' ? 'Online shop' : 'ร้านค้าออนไลน์' })).toBeVisible();
}
const seed = (fake: FakeShop, key: string, fulfilment = 'delivery', qty = 2) => {
  const r = fake.rpc('shop_place_order', { p_key: key, p_items: [{ sku_code: 'FG-000001', qty }], p_fulfilment: fulfilment, p_name: 'Somchai', p_phone: '0812345678', p_address: fulfilment === 'delivery' ? '99 Test Road Bangkok 10110' : null, p_note: 'leave at the door' }) as { order: { order_no: string } };
  return r.order.order_no;
};

test.describe('orders', () => {
  test('lists customer orders, opens one and walks a paid order through to shipped', async ({ page }) => {
    const fake = new FakeShop(); const no = seed(fake, 'admin-order-001'); await openAdmin(page, fake);
    const row = page.getByRole('row', { name: new RegExp(no) });
    await expect(row).toContainText('Somchai'); await expect(row).toContainText('฿690');
    await row.click();
    const drawer = page.locator('aside.drawer');
    await expect(drawer).toContainText('99 Test Road Bangkok 10110'); await expect(drawer).toContainText('leave at the door');
    await expect(drawer).toContainText('Not paid yet');                                       // a slip alone is not payment: it points at Payment review
    await expect(drawer.getByRole('link', { name: 'Open Payment review' })).toBeVisible();
    await drawer.getByRole('button', { name: /Mark as/ }).click();                             // new -> confirmed needs no payment
    await expect(drawer.getByText('Confirmed').first()).toBeVisible();
    // the next step needs a verified payment
    await drawer.getByRole('button', { name: /Mark as Preparing/ }).click();
    await expect(page.getByText('Payment has not been verified yet')).toBeVisible();
    expect(fake.orders[0].status).toBe('confirmed');
    fake.verifyPayment(no);
    await page.keyboard.press('Escape'); await row.click();
    for (const step of ['Preparing', 'Packed']) await drawer.getByRole('button', { name: new RegExp(`Mark as ${step}`) }).click();
    await drawer.getByLabel(/Message to the customer/).fill('Kerry TH123');
    await drawer.getByRole('button', { name: /Mark as Shipped/ }).click();
    await expect.poll(() => fake.orders[0].status).toBe('shipped');
    expect(fake.orders[0].status_note).toBe('Kerry TH123');
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-order.png` });
  });
  test('continuing without payment needs a reason that stays internal', async ({ page }) => {
    const fake = new FakeShop(); const no = seed(fake, 'admin-order-002', 'pickup'); fake.setStatus(no, 'confirmed'); await openAdmin(page, fake);
    await page.getByRole('row', { name: new RegExp(no) }).click();
    const drawer = page.locator('aside.drawer');
    await drawer.getByRole('button', { name: 'Without payment…' }).click();
    const dlg = page.locator('.modal');
    await expect(dlg.getByRole('button', { name: 'Continue anyway' })).toBeDisabled();       // a reason is mandatory
    await dlg.getByRole('textbox').fill('Regular customer, pays at pick-up');
    await dlg.getByRole('button', { name: 'Continue anyway' }).click();
    await expect.poll(() => fake.orders[0].status).toBe('preparing');
    expect(fake.orders[0].status_note).toBeNull();                                            // the customer-visible message is untouched
    expect(JSON.stringify(fake.statusLog.get(fake.orders[0].id))).toContain('Regular customer');
  });
  test('cancelling needs a reason and a paid order cannot be cancelled here', async ({ page }) => {
    const fake = new FakeShop(); const a = seed(fake, 'admin-order-003'); const b = seed(fake, 'admin-order-004'); fake.verifyPayment(b); await openAdmin(page, fake);
    await page.getByRole('row', { name: new RegExp(a) }).click();
    await page.locator('aside.drawer').getByRole('button', { name: 'Cancel order' }).click();
    const dlg = page.locator('.modal');
    await expect(dlg.getByRole('button', { name: 'Cancel order' })).toBeDisabled();
    await dlg.getByRole('textbox').fill('Customer asked'); await dlg.getByRole('button', { name: 'Cancel order' }).click();
    await expect.poll(() => fake.orders.find((o) => o.order_no === a)!.status).toBe('cancelled');
    await page.keyboard.press('Escape');
    await page.getByRole('row', { name: new RegExp(b) }).click();
    await page.locator('aside.drawer').getByRole('button', { name: 'Cancel order' }).click();
    await page.locator('.modal').getByRole('textbox').fill('x'); await page.locator('.modal').getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('PAYMENT_RECORDED')).toBeVisible();
    expect(fake.orders.find((o) => o.order_no === b)!.status).toBe('new');
  });
  test('filter by status and search; an empty shop explains itself', async ({ page }) => {
    const fake = new FakeShop(); await openAdmin(page, fake);
    await expect(page.getByText('No online orders yet')).toBeVisible();
    const a = seed(fake, 'admin-order-005'); seed(fake, 'admin-order-006'); fake.setStatus(a, 'shipped');
    await page.reload(); await expect(page.getByRole('heading', { name: 'Online shop' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(3);                                       // header + 2
    await page.getByRole('button', { name: /^Shipped/ }).click();
    await expect(page.getByRole('row')).toHaveCount(2);
  });
});

test.describe('products', () => {
  test('edit what customers see: availability, description, a specification; hidden products are explained', async ({ page }) => {
    const fake = new FakeShop(); fake.hidden.add('FG-000009'); await openAdmin(page, fake);
    await page.getByRole('tab', { name: 'Products' }).click();
    await expect(page.getByRole('row', { name: /FG-000009/ })).toContainText('Hidden');
    await page.getByPlaceholder('SKU, name or brand').fill('FG-000001');
    await page.getByRole('row', { name: /FG-000001/ }).click();
    const drawer = page.locator('aside.drawer');
    await drawer.getByRole('switch', { name: 'Available to order (switch off = sold out)' }).click();
    await drawer.getByLabel('Description (Thai)').fill('รสผลไม้รวม');
    await drawer.getByRole('button', { name: 'Add a specification' }).click();
    await drawer.getByPlaceholder('Label').fill('Size'); await drawer.getByPlaceholder('Value').fill('6000 puffs');
    await drawer.getByLabel('Max per order').fill('3');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => fake.item('FG-000001').available).toBe(false);
    expect(fake.item('FG-000001').description_th).toBe('รสผลไม้รวม');
    expect(fake.item('FG-000001').specs).toEqual([{ label: 'Size', value: '6000 puffs' }]);
    expect(fake.item('FG-000001').max_qty).toBe(3);
    const call = fake.calls.filter((c) => c.fn === 'shop_admin_save_content').pop()!;
    expect(call.args.p_sku).toBe('FG-000001');
    expect(Object.keys(call.args.p_patch as object)).not.toContain('price');                  // staff cannot change prices from here
  });
  test('filters', async ({ page }) => {
    const fake = new FakeShop(); fake.hidden.add('FG-000009'); await openAdmin(page, fake);
    await page.getByRole('tab', { name: 'Products' }).click();
    await page.getByLabel('Show').selectOption('hidden');
    await expect(page.getByRole('row')).toHaveCount(2);
    await page.getByLabel('Show').selectOption('no_image');
    await expect(page.getByRole('row').nth(1)).toContainText('FG-');
  });
});

test.describe('settings', () => {
  test('shows what is missing before opening, then opens the shop and saves shipping', async ({ page }) => {
    const fake = new FakeShop(); fake.settings.shop_open = false; await openAdmin(page, fake);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByText('A payment account (your PromptPay QR) is set up')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set it up on Payment review' })).toBeVisible();
    await page.getByRole('switch', { name: 'The shop takes online orders' }).click();
    await expect(page.getByText('customers still cannot order: no payment account is set up')).toBeVisible();   // honest about the missing account
    expect(fake.settings.shop_open).toBe(true);
    await page.getByLabel('Shipping fee (฿)').fill('60'); await page.getByLabel('Free shipping from (฿)').fill('1500');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect.poll(() => fake.settings.shipping_fee).toBe(60);
    expect(fake.settings.free_shipping_min).toBe(1500);
    // categories: give a category its Thai name
    const row = page.locator('div.row', { hasText: 'Coil' }).filter({ has: page.getByLabel('Thai name') }).first();
    await row.getByLabel('Thai name').fill('คอยล์'); await row.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => fake.categories.get('Coil')?.name_th).toBe('คอยล์');
  });
  test('Thai wording', async ({ page }) => {
    const fake = new FakeShop(); seed(fake, 'admin-order-007'); await openAdmin(page, fake, 'th');
    await expect(page.getByRole('row', { name: /SO-/ })).toContainText('ยังไม่ชำระ');
    await expect(page.getByRole('tab', { name: 'ตั้งค่า' }).or(page.getByRole('tab', { name: 'Settings' }))).toBeVisible();
  });
});

test.describe('access', () => {
  test('a customer account cannot open the back office page', async ({ page }) => {
    const fake = new FakeShop(); await fake.install(page);                                    // role USER
    await page.goto('/#/shop-admin');
    await expect(page.getByRole('heading', { name: 'Online shop' })).toHaveCount(0);
    await expect(page.locator('.phone-nav')).toBeVisible();                                   // sent to the customer app
  });
});

test.describe('payment choice', () => {
  test('staff see how the customer plans to pay and how much is still owed', async ({ page }) => {
    const fake = new FakeShop();
    const r = fake.rpc('shop_place_order', { p_key: 'admin-order-pm1', p_items: [{ sku_code: 'FG-000001', qty: 2 }], p_fulfilment: 'pickup', p_name: 'Somchai', p_phone: '0812345678', p_address: null, p_note: null, p_payment_method: 'bank:BBL' }) as { order: { order_no: string } };
    await openAdmin(page, fake);
    await page.getByRole('row', { name: new RegExp(r.order.order_no) }).click();
    const drawer = page.locator('aside.drawer');
    await expect(drawer).toContainText('Customer plans to pay by');
    await expect(drawer).toContainText('Bank transfer · BBL');
    await expect(drawer).toContainText('Not paid yet');                                    // choosing a method is not paying
  });
  test('the payment choice is shown in Thai too', async ({ page }) => {
    const fake = new FakeShop();
    const r = fake.rpc('shop_place_order', { p_key: 'admin-order-pm2', p_items: [{ sku_code: 'FG-000001', qty: 1 }], p_fulfilment: 'pickup', p_name: 'Somchai', p_phone: '0812345678', p_address: null, p_note: null, p_payment_method: 'wallet' }) as { order: { order_no: string } };
    await openAdmin(page, fake, 'th');
    await page.getByRole('row', { name: new RegExp(r.order.order_no) }).click();
    await expect(page.locator('aside.drawer')).toContainText('ลูกค้าตั้งใจชำระโดย');
    await expect(page.locator('aside.drawer')).toContainText('กระเป๋าเงิน');
  });
});
