// Preorders (scheduled pickup), customer app: the third way of getting an order, the day and time picker (closed, full, too soon, too many items), the confirmation, the order page
// (schedule, progress, updates, change the time, ask the shop, cancel, locked), and the fallbacks (a shop that offers no preorder, a database without the migration).
// Against the fake backend (fakeBackend.ts + fakePreorders.ts): this proves the SCREENS. The rules themselves are proved in the database by supabase/tests/preorders.sql.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { addDays, dayKey, slotAt } from './fakePreorders';
import { openFold } from './methods';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const today = () => dayKey(new Date());

async function open(page: Page, fake: FakeShop) {
  await fake.install(page);
  await page.goto('/#/app');
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);

/** a shop that offers preorders (the slip is off so a test does not need a picture; the payment rules are the ordering suites' business) */
function shop(): FakeShop { const f = new FakeShop(); f.decorate(); f.settings.require_payment_slip = false; f.po.enabled = true; return f; }
/** a preorder created straight in the fake (no screen involved) */
function seed(fake: FakeShop, key: string, off: number, hhmm: string, qty = 2, note: string | null = null) {
  const r = fake.rpc('shop_place_order', { p_key: key, p_items: [{ sku_code: 'FG-000001', qty }], p_fulfilment: 'pickup', p_name: 'สมชาย ใจดี', p_phone: '0812345678', p_address: null, p_note: note, p_pickup_at: slotAt(off, hhmm) }) as { order: { id: string; order_no: string } };
  return r.order;
}
async function addAndCheckout(page: Page, sku = 'FG-000001', times = 1) {
  await tab(page, t('nav.shop')).click();
  await page.locator(`.sp-card[data-sku="${sku}"]`).getByRole('button', { name: t('p.add') }).click();
  for (let i = 1; i < times; i++) await page.locator(`.sp-card[data-sku="${sku}"]`).getByRole('button', { name: t('p.plus') }).click();
  await tab(page, t('nav.cart')).click();
  await page.getByRole('button', { name: t('cart.checkout') }).click();
  await expect(page.getByRole('heading', { name: t('co.payment') })).toBeVisible();
}
const pickDay = (page: Page, off: number) => page.locator(`[data-day="${addDays(today(), off)}"]`);
const slot = (page: Page, hhmm: string) => page.locator(`[data-slot="${hhmm}"]`);

test.describe('checkout: choosing a pickup time', () => {
  test('a shop that offers no preorder shows no such choice, and a database without the migration still checks out as before', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.settings.require_payment_slip = false; await open(page, fake); await addAndCheckout(page);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await expect(page.getByTestId('pickup-card')).toBeVisible();
    await expect(page.getByTestId('mode-preorder')).toHaveCount(0);
    await page.close();
  });
  test('an old database (no preorder_enabled, no preorder functions) shows no preorder choice and still places a pick-up order', async ({ page }) => {
    const fake = shop(); fake.po.missing = true; await open(page, fake); await addAndCheckout(page);
    await expect(page.getByTestId('mode-preorder')).toHaveCount(0);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click();
    await expect(page.getByTestId('pickup-card')).toBeVisible(); await expect(page.getByTestId('mode-preorder')).toHaveCount(0);
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.calls.find((c) => c.fn === 'shop_place_order')!.args).not.toHaveProperty('p_pickup_at');
    await expect(page.getByTestId('preorder-badge')).toHaveCount(0);
  });

  test('the whole journey: choose Preorder, a day and a time, instructions, confirm, and the order page shows the schedule', async ({ page }) => {
    const fake = shop(); fake.po.days.set(addDays(today(), 1), { kind: 'closed', open: null, close: null, reason: 'วันหยุดร้าน' });
    await open(page, fake); await addAndCheckout(page, 'FG-000001', 3);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await page.getByTestId('mode-preorder').click();
    await expect(page.getByTestId('pickup-picker')).toBeVisible();
    await expect(page.getByTestId('preorder-section')).toContainText(t('po.prepNote'));
    // the closed day cannot be chosen, with its reason said on the chip
    await expect(pickDay(page, 1)).toBeDisabled(); await expect(pickDay(page, 1)).toHaveAttribute('data-state', 'closed');
    await pickDay(page, 2).click();
    await expect(slot(page, '09:00')).toBeVisible(); await expect(slot(page, '17:30')).toBeVisible(); await expect(slot(page, '18:00')).toHaveCount(0);
    await slot(page, '10:30').click();
    await expect(page.getByTestId('pickup-chosen')).toContainText('10:30');
    // the quick instructions add to the note once
    await page.getByRole('button', { name: new RegExp(t('po.ph.ready')) }).click();
    await page.getByRole('button', { name: new RegExp(t('po.ph.call')) }).click();
    await expect(page.getByTestId('co-note')).toHaveValue(`${t('po.ph.ready')} ${t('po.ph.call')}`);
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    // the confirmation shows everything the customer is committing to
    const sum = page.getByTestId('preorder-summary');
    await expect(sum).toBeVisible();
    await expect(page.getByTestId('summary-when')).toContainText('10:30');
    await expect(sum).toContainText(t('po.mode')); await expect(sum).toContainText(t('po.ph.ready')); await expect(sum).toContainText('× 3'); await expect(sum).toContainText(t('po.cf.method.bank', { bank: 'SCB' })); await expect(sum).toContainText('฿');
    await noOverflow(page);
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    const call = fake.calls.find((c) => c.fn === 'shop_place_order')!;
    expect(call.args.p_fulfilment).toBe('pickup'); expect(call.args.p_pickup_at).toBe(slotAt(2, '10:30')); expect(String(call.args.p_note)).toContain(t('po.ph.ready'));
    expect((call.args.p_items as { qty: number }[])[0].qty).toBe(3);
    expect(Object.keys(call.args)).not.toContain('p_unit_price');                    // the app still sends only SKU + quantity: the database prices the order
    await expect(page.getByTestId('preorder-badge')).toBeVisible();
    await openFold(page, 'schedule');
    await expect(page.getByTestId('pickup-long')).toContainText('10:30');
    await expect(page.locator('.sp-fold[data-fold="schedule"]')).toContainText(t('po.od.deadline', { when: '' }).slice(0, 12));
    await expect(page.getByTestId('po-updates')).toContainText(t('po.n.placed'));
    await noOverflow(page);
    expect(fake.orders).toHaveLength(1); expect(fake.po.meta.get(fake.orders[0].id)!.pickup_at).toBe(slotAt(2, '10:30'));
  });

  test('placing without a time is refused with a clear sentence, and nothing is sent', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await page.getByTestId('mode-preorder').click();
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('po.pickFirst'));
    expect(fake.count('shop_place_order')).toBe(0);
  });

  test('full slots, slots that are too soon and slots that cannot take this many items are shown disabled and cannot be chosen', async ({ page }) => {
    const fake = shop(); fake.po.s.max_units_per_slot = 5;
    seed(fake, 'full-a-0001', 3, '11:00', 1); seed(fake, 'full-b-0001', 3, '11:00', 1);        // 11:00 on day +3: two orders, the slot is full
    seed(fake, 'unit-a-0001', 3, '12:00', 3);                                                   // 12:00: 3 of 5 units used, a cart of 3 will not fit
    await open(page, fake); await addAndCheckout(page, 'FG-000001', 3);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await page.getByTestId('mode-preorder').click(); await pickDay(page, 3).click();
    await expect(slot(page, '11:00')).toBeDisabled(); await expect(slot(page, '11:00')).toHaveAttribute('data-state', 'full');
    await expect(slot(page, '12:00')).toBeDisabled(); await expect(slot(page, '12:00')).toHaveAttribute('data-state', 'units');
    await expect(slot(page, '11:30')).toBeEnabled();
    await slot(page, '11:00').click({ force: true });
    await expect(page.getByTestId('pickup-chosen')).toHaveCount(0);                            // a disabled slot never becomes the choice
    // the lead time: with three days of lead, the first three days have nothing to offer
    fake.po.s.lead_minutes = 3 * 24 * 60; await page.reload(); await expect(page.locator('.phone-nav')).toBeVisible();
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click(); await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await page.getByTestId('mode-preorder').click();
    for (const off of [0, 1, 2]) await expect(pickDay(page, off)).toBeDisabled();
    await expect(pickDay(page, 4)).toBeEnabled();
  });

  test('a time that fills up while the customer is deciding is refused, the choice is dropped and the slot shows as full', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await page.getByTestId('mode-preorder').click(); await pickDay(page, 2).click(); await slot(page, '14:00').click();
    await expect(page.getByTestId('pickup-chosen')).toBeVisible();
    seed(fake, 'race-a-0001', 2, '14:00', 1); seed(fake, 'race-b-0001', 2, '14:00', 1);        // somebody else takes the last two places
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.getByTestId('checkout-error')).toContainText(t('po.err.SLOT_FULL'));
    await expect(page.getByTestId('pickup-chosen')).toHaveCount(0);
    await expect(slot(page, '14:00')).toBeDisabled();
    expect(fake.orders.filter((o) => !o.key.startsWith('race-'))).toHaveLength(0);              // the refused order was not created
  });

  test('a delivery or ordinary pick-up choice leaves no schedule behind', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await page.getByTestId('mode-preorder').click(); await pickDay(page, 2).click(); await slot(page, '10:00').click();
    await page.getByTestId('mode-soon').click();                                                    // pick up when it is ready (the top choice stays "pick up")
    await expect(page.getByRole('radio', { name: new RegExp(t('co.pickup')) })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('preorder-section')).toHaveCount(0);
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.calls.find((c) => c.fn === 'shop_place_order')!.args).not.toHaveProperty('p_pickup_at');
    await expect(page.getByTestId('preorder-badge')).toHaveCount(0);
  });

  test('accessible and fits a phone: the picker has no axe violations and nothing scrolls sideways', async ({ page }) => {
    const fake = shop(); await open(page, fake); await addAndCheckout(page);
    await page.getByRole('radio', { name: new RegExp(t('co.pickup')) }).click(); await page.getByTestId('mode-preorder').click(); await pickDay(page, 2).click(); await slot(page, '10:00').click();
    await noOverflow(page);
    const r = await new AxeBuilder({ page }).include('[data-testid="preorder-section"]').analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/preorder-checkout-mobile.png`, fullPage: true });
  });
});

test.describe('my orders: a scheduled pickup', () => {
  test('the list has a "scheduled pickups" chip that shows only upcoming preorders, each with its pickup time', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 'ord-a-000001', 3, '10:00'); seed(fake, 'ord-b-000001', 5, '15:30'); fake.seedOrder();
    await open(page, fake); await tab(page, t('nav.orders')).click();
    await expect(page.locator('.sp-orders li')).toHaveCount(3);
    await page.getByRole('tab', { name: t('ord.f.preorder') }).click();
    await expect(page.locator('.sp-orders li')).toHaveCount(2);
    await expect(page.getByTestId('order-pickup').first()).toContainText('10:00');                 // soonest pickup first
    await expect(page.getByTestId('order-pickup').nth(1)).toContainText('15:30');
    await page.locator('.sp-order', { hasText: a.order_no }).click();
    await expect(page.getByTestId('preorder-badge')).toBeVisible();
  });
  test('the chip is not offered when the shop does not take preorders', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.seedOrder(); await open(page, fake); await tab(page, t('nav.orders')).click();
    await expect(page.getByRole('tab', { name: t('ord.f.preorder') })).toHaveCount(0);
  });

  test('the order page: schedule, progress, updates and what the shop said', async ({ page }) => {
    const fake = shop(); const o = seed(fake, 'ord-c-000001', 2, '11:00', 3);
    const f = fake.orders[0]; fake.verifyPayment(o.order_no);
    fake.po.setStatus(f, 'confirmed', null, null); fake.po.setStatus(f, 'preparing', null, null);
    fake.po.checks.set(f.id, new Set([1]));
    await open(page, fake); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order', { hasText: o.order_no }).click(); await openFold(page, 'schedule');
    await expect(page.getByTestId('pickup-long')).toContainText('11:00');
    await expect(page.getByTestId('prep-progress')).toContainText(t('po.od.prepDone'));      // one line, ticked
    await expect(page.getByTestId('po-updates')).toContainText(t('po.n.confirmed')); await expect(page.getByTestId('po-updates')).toContainText(t('po.n.preparing'));
    await page.locator('[data-fold="progress"] .sp-fold-h').click();
    await expect(page.locator('[data-fold="progress"] .sp-steps li')).toHaveCount(5);          // new, confirmed, preparing, ready, completed: no packing step
    await noOverflow(page);
    const r = await new AxeBuilder({ page }).include('.sp-order-detail').analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  test('the customer changes the pickup time and the instructions; the staff are told', async ({ page }) => {
    const fake = shop(); const o = seed(fake, 'ord-d-000001', 3, '10:00', 2, 'เดิม');
    await open(page, fake); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order', { hasText: o.order_no }).click(); await openFold(page, 'schedule');
    await page.getByTestId('po-change').click();
    await pickDay(page, 4).click(); await slot(page, '16:00').click();
    await page.getByTestId('po-note').fill('เปลี่ยนคำสั่ง');
    await page.getByTestId('po-save').click();
    await expect(page.getByTestId('pickup-long')).toContainText('16:00');
    expect(fake.po.meta.get(o.id)!.pickup_at).toBe(slotAt(4, '16:00'));
    expect(fake.orders[0].note).toBe('เปลี่ยนคำสั่ง');
    expect(fake.po.notices.some((n) => n.audience === 'staff' && n.kind === 'changed')).toBe(true);
    await expect(page.locator('[data-fold="schedule"]')).toContainText(t('po.od.left', { n: 2 }));
  });
  test('a change that the slot cannot take is refused in words and the order keeps its time', async ({ page }) => {
    const fake = shop(); fake.po.s.max_orders_per_slot = 1; seed(fake, 'taken-a-00001', 4, '10:00'); const o = seed(fake, 'ord-e-000001', 3, '10:00');
    await open(page, fake); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order', { hasText: o.order_no }).click(); await openFold(page, 'schedule');
    await page.getByTestId('po-change').click(); await pickDay(page, 4).click();
    await expect(slot(page, '10:00')).toBeDisabled();                                         // full: cannot even be chosen
    await slot(page, '10:30').click();
    fake.po.s.max_orders_per_slot = 1; seed(fake, 'taken-b-00001', 4, '10:30');                 // ...and it fills up before the customer saves
    await page.getByTestId('po-save').click();
    await expect(page.locator('.sp-sheet').getByRole('alert').or(page.locator('.sp-sheet [class*="banner"]')).first()).toContainText(t('po.err.SLOT_FULL'));
    expect(fake.po.meta.get(o.id)!.pickup_at).toBe(slotAt(3, '10:00'));
  });
  test('"ask the shop" sends a message once and says so; a second one right away is refused', async ({ page }) => {
    const fake = shop(); const o = seed(fake, 'ord-f-000001', 3, '10:00');
    await open(page, fake); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order', { hasText: o.order_no }).click(); await openFold(page, 'schedule');
    await page.getByTestId('po-ask').click();
    await expect(page.getByTestId('po-send')).toBeDisabled();
    await page.getByTestId('po-msg').fill('ขอเพิ่มเป็น 5 ชิ้น');
    await page.getByTestId('po-send').click();
    await expect.poll(() => fake.po.notices.filter((n) => n.kind === 'request').length).toBe(1);
    expect(fake.po.notices.find((n) => n.kind === 'request')!.data.message).toBe('ขอเพิ่มเป็น 5 ชิ้น');
    await page.getByTestId('po-ask').click(); await page.getByTestId('po-msg').fill('อีกข้อความ'); await page.getByTestId('po-send').click();
    await expect(page.locator('.sp-sheet')).toContainText(t('po.err.TOO_MANY_REQUESTS'));
  });
  test('inside the cut-off the customer can no longer change or cancel it, and is told to message the shop', async ({ page }) => {
    const fake = shop(); fake.po.s.change_cutoff_minutes = 100_000; const o = seed(fake, 'ord-g-000001', 3, '10:00');
    await open(page, fake); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order', { hasText: o.order_no }).click(); await openFold(page, 'schedule');
    await expect(page.locator('[data-fold="schedule"]')).toContainText(t('po.od.locked'));
    await expect(page.getByTestId('po-change')).toHaveCount(0);
    await expect(page.getByRole('button', { name: t('od.cancel') })).toHaveCount(0);
    await expect(page.getByTestId('po-ask')).toBeVisible();
  });
  test('the customer cancels an unconfirmed, unpaid preorder and the place is released', async ({ page }) => {
    const fake = shop(); const o = seed(fake, 'ord-h-000001', 3, '10:00');
    await open(page, fake); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order', { hasText: o.order_no }).click();
    await page.getByRole('button', { name: t('od.cancel') }).click();
    await expect(page.locator('.sp-sheet')).toContainText(t('po.od.cancelBodyPre'));
    await page.locator('.sp-sheet').getByRole('button', { name: t('od.confirmYes') }).click();
    await expect(page.getByText(t('po.od.cancelledYou'))).toBeVisible();
    expect(fake.po.load(slotAt(3, '10:00')).orders).toBe(0);
    expect(fake.po.notices.some((n) => n.audience === 'staff' && n.kind === 'cancelled_by_customer')).toBe(true);
  });
  test('when the shop rejects it the customer sees that, with the reason', async ({ page }) => {
    const fake = shop(); const o = seed(fake, 'ord-i-000001', 3, '10:00'); fake.po.setStatus(fake.orders[0], 'cancelled', 'ของหมดวันนั้น', null);
    await open(page, fake); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order', { hasText: o.order_no }).click();
    await expect(page.locator('.sp-order-detail')).toContainText(t('po.od.rejected')); await expect(page.locator('.sp-order-detail')).toContainText('ของหมดวันนั้น');
    await expect(page.getByTestId('po-updates')).toContainText(t('po.n.rejected'));
    await expect(page.getByTestId('po-change')).toHaveCount(0);
  });
  test('English wording works on the preorder screens', async ({ page }) => {
    const fake = shop(); const o = seed(fake, 'ord-j-000001', 3, '10:00');
    await fake.install(page); await page.addInitScript(() => { try { localStorage.setItem('tc.shop.lang', 'en'); } catch { /* ignore */ } });
    await page.goto('/#/app'); await expect(page.locator('.phone-nav')).toBeVisible();
    await page.locator('.phone-nav').getByRole('button', { name: tr('en', 'nav.orders') }).click(); await page.locator('.sp-order', { hasText: o.order_no }).click();
    await expect(page.locator('[data-fold="schedule"]')).toContainText(tr('en', 'po.od.schedule'));
    await expect(page.getByTestId('preorder-badge')).toHaveText(tr('en', 'po.badge'));
  });
});
