// The checkout screen: payment methods behind one line, the PromptPay QR at the stage where the customer pays, sections that close by themselves, and nothing lost on the
// way. Against the fake backend (fakeBackend.ts): this proves the SCREENS; that the database prices the QR is proved by supabase/tests/checkout_qr.sql.
// The QR is checked the way a bank app sees it: the pixels on the screen are decoded.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG as Png } from 'pngjs';
import { promptPayPayload } from '../../src/lib/promptpay';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { chosen, methodFold, openFold, openMethods, pickMethod } from './methods';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const SHOTS = process.env.SHOP_SHOTS ?? 'test-results/shop';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const placeBtn = (page: Page) => page.getByRole('button', { name: new RegExp(t('co.place')) });
const slipSec = (page: Page) => page.getByTestId('slip-section');
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
const openFolds = (page: Page) => page.locator('.sp-fold.open').count();

/** every uncaught error of the page: a test fails when there is one */
function watch(page: Page) { const errs: string[] = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); }); return errs; }
async function start(page: Page, fake: FakeShop) { fake.decorate(); await fake.install(page); await page.goto('/#/app'); await expect(page.locator('.phone-nav')).toBeVisible(); }
async function toCheckout(page: Page, sku = 'FG-000001') {
  await tab(page, t('nav.shop')).click();
  await page.locator(`.sp-card[data-sku="${sku}"]`).getByRole('button', { name: t('p.add') }).click();
  await tab(page, t('nav.cart')).click();
  await page.getByRole('button', { name: t('cart.checkout') }).click();
  await expect(methodFold(page)).toBeVisible();
}
async function attach(page: Page, name = 'slip.png') {
  await slipSec(page).locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#' + Math.random())]) });
  await expect(page.getByTestId('slip-preview')).toBeVisible();
}
/** what a banking app reads from the QR that is on the screen */
async function scan(page: Page, box: Locator = page.getByTestId('pay-qr')): Promise<string | undefined> {
  await expect(box).toBeVisible(); await expect.poll(() => box.evaluate((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(500); await box.scrollIntoViewIfNeeded();
  const p = Png.sync.read(await box.screenshot({ scale: 'css' }));
  return jsQR(new Uint8ClampedArray(p.data), p.width, p.height)?.data;
}

test.describe('payment methods at checkout', () => {
  test('closed at first with the chosen method on show; tap opens, picking closes, and it can be changed again and again', async ({ page }) => {
    const errs = watch(page); const fake = new FakeShop(); await start(page, fake); await toCheckout(page);
    const head = methodFold(page).locator('.sp-fold-h');
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-bank]')).toHaveCount(0);                                   // no card is expanded
    await expect(chosen(page)).toHaveAttribute('data-chosen', 'SCB'); await expect(chosen(page)).toContainText('519-4-02625-1');
    await page.screenshot({ path: `${SHOTS}/ux-1-checkout-closed.png`, fullPage: true });
    await head.click();
    await expect(page.locator('[data-bank="SCB"]')).toHaveClass(/on/); await expect(page.locator('[data-bank="BBL"]')).toBeVisible(); await expect(page.locator('[data-method="qr"]')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ux-2-checkout-open.png`, fullPage: true });
    await page.locator('[data-bank="BBL"] label').click();
    await expect(head).toHaveAttribute('aria-expanded', 'false'); await expect(head).toBeFocused();
    await expect(chosen(page)).toHaveAttribute('data-chosen', 'BBL');
    await expect(page.getByTestId('payto-account')).toHaveText('938-0-31954-2');                // the account to pay follows the choice and is not inside the list
    await head.click(); await expect(page.locator('[data-bank="BBL"]')).toHaveClass(/on/);
    await page.locator('[data-bank="BBL"] label').click();                                      // the same method again just closes the list
    await expect(head).toHaveAttribute('aria-expanded', 'false'); await expect(chosen(page)).toHaveAttribute('data-chosen', 'BBL');
    await head.click(); await head.click(); await expect(head).toHaveAttribute('aria-expanded', 'false');   // and the header closes it without a choice
    expect(errs).toEqual([]);
  });

  test('keyboard: arrows move between the methods without closing, Enter closes on the chosen one', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page);
    const head = methodFold(page).locator('.sp-fold-h');
    await head.focus(); await page.keyboard.press('Enter');
    await page.locator('[data-bank="SCB"] input').focus();
    await page.keyboard.press('ArrowDown'); await expect(page.locator('[data-bank="BBL"]')).toHaveClass(/on/);
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown'); await expect(page.locator('[data-method="qr"]')).toHaveClass(/on/);
    await page.keyboard.press('Enter');
    await expect(head).toHaveAttribute('aria-expanded', 'false'); await expect(head).toBeFocused(); await expect(chosen(page)).toHaveAttribute('data-chosen', 'qr');
  });

  test('copying an account number does not choose the bank or close the list', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${process.env.SHOP_PORT ?? 4179}` });
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page); await openMethods(page);
    await page.locator('[data-bank="BBL"] .wl-copy button').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('9380319542');
    await expect(page.locator('[data-bank="SCB"]')).toHaveClass(/on/); await expect(methodFold(page).locator('.sp-fold-h')).toHaveAttribute('aria-expanded', 'true');
  });

  test('one section open at a time', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page);
    expect(await openFolds(page)).toBeLessThanOrEqual(1);
    for (const id of ['items', 'payment']) { await openFold(page, id); expect(await openFolds(page)).toBe(1); }
  });

  test('the methods could not be loaded: the screen says so and Try again brings them back', async ({ page }) => {
    const fake = new FakeShop(); fake.failNext('finance_payment_methods', 99); await start(page, fake);
    await tab(page, t('nav.shop')).click(); await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.add') }).click();
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await expect(page.getByText(t('pm.loadError'))).toBeVisible(); fake.failNext('finance_payment_methods', 0);
    await page.getByRole('button', { name: t('common.retry') }).click();
    await expect(chosen(page)).toHaveAttribute('data-chosen', 'SCB');
  });
});

test.describe('the PromptPay QR at checkout (pay first)', () => {
  test('choosing the QR shows a scannable QR for exactly the total; it stays visible when the sections open and close; then the slip, then ONE order', async ({ page }) => {
    const errs = watch(page); const fake = new FakeShop(); await start(page, fake); await toCheckout(page);
    await pickMethod(page, 'qr');
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));                          // 320 + 50 delivery: the server's amount, decoded from the screen
    await expect(page.getByTestId('qr-amount')).toHaveText('฿370'); await expect(page.getByTestId('qr-panel')).toContainText('TEST SHOP');
    expect(Object.keys(fake.calls.find((c) => c.fn === 'shop_checkout_qr')!.args).sort()).toEqual(['p_fulfilment', 'p_items']);   // never an amount
    await page.screenshot({ path: `${SHOTS}/ux-3-checkout-qr.png`, fullPage: true });
    for (const id of ['items', 'payment']) { await openFold(page, id); await expect(page.getByTestId('pay-qr')).toBeVisible(); }
    await methodFold(page).locator('.sp-fold-h').click(); await expect(page.getByTestId('pay-qr')).toBeVisible();
    const n = fake.count('shop_checkout_qr'); await openFold(page, 'items'); expect(fake.count('shop_checkout_qr')).toBe(n);      // and it is not asked for again
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: t('qr.save') }).click()]);
    expect(dl.suggestedFilename()).toBe('payment-qr-checkout-370.png');
    const saved = Png.sync.read(await (async () => { const s = await dl.createReadStream(); const b: Buffer[] = []; for await (const x of s) b.push(x as Buffer); return Buffer.concat(b); })());
    expect(jsQR(new Uint8ClampedArray(saved.data), saved.width, saved.height)?.data).toBe(promptPayPayload('0812345678', 370));   // the saved picture scans too
    await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ');
    await attach(page);
    await expect(page.getByTestId('pay-qr')).toHaveCount(0);                                     // paid and attached: out of the way…
    await page.getByRole('button', { name: t('co.payShow') }).click(); expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));   // …one tap away
    await page.screenshot({ path: `${SHOTS}/ux-4-slip-attached.png`, fullPage: true });
    await placeBtn(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    await expect(page.getByText(t('co.placedSlip'))).toBeVisible();
    const call = fake.calls.find((c) => c.fn === 'shop_place_order')!; expect(call.args.p_payment_method).toBe('qr'); expect(call.args.p_slip_path).toBeTruthy();
    expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.paid).toBe(0);
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.pending'));
    await expect(page.getByTestId('pay-qr')).toHaveCount(0);                                     // nothing left to pay: no QR to pay twice
    await page.screenshot({ path: `${SHOTS}/ux-5-order-placed.png`, fullPage: true });
    expect(errs).toEqual([]);
  });

  test('switching method: the QR goes away for a bank and for the wallet, and comes back', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(1000); await start(page, fake); await toCheckout(page);
    await pickMethod(page, 'qr'); await expect(page.getByTestId('pay-qr')).toBeVisible(); await expect(page.getByTestId('payto-bank')).toHaveCount(0);
    await pickMethod(page, 'BBL'); await expect(page.getByTestId('pay-qr')).toHaveCount(0); await expect(page.getByTestId('payto-bank')).toBeVisible();
    await pickMethod(page, 'wallet'); await expect(page.getByTestId('pay-qr')).toHaveCount(0); await expect(slipSec(page)).toHaveCount(0);
    await pickMethod(page, 'qr'); expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));
  });

  test('the amount changes (pick-up instead of delivery): a new QR for the new amount, never the old one', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page); await pickMethod(page, 'qr');
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));
    await page.getByRole('radio', { name: t('co.pickup') }).click();
    await expect(page.getByTestId('qr-amount')).toHaveText('฿320');
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 320));
  });

  test('while it loads there is no QR; a failure shows the reason, Try again and the other methods, never a picture', async ({ page }) => {
    const fake = new FakeShop(); fake.holdCheckoutQr = true; fake.failNext('shop_checkout_qr', 99); await start(page, fake); await toCheckout(page); await pickMethod(page, 'qr');
    await expect(page.getByTestId('qr-error')).toContainText(t('qr.error')); await expect(page.getByTestId('pay-qr')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/ux-6-qr-error.png`, fullPage: true }); fake.failNext('shop_checkout_qr', 0);
    await page.getByTestId('qr-error').getByRole('button', { name: t('common.retry') }).click();
    await expect(page.getByTestId('qr-loading')).toBeVisible(); await expect(page.locator('.qr-box')).toHaveCount(0);
    fake.releaseCheckoutQr();
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));
    fake.holdCheckoutQr = false;
  });

  test('a database without the function: the QR says it is not available, the other methods work', async ({ page }) => {
    const fake = new FakeShop(); fake.noCheckoutQr = true; await start(page, fake); await toCheckout(page); await pickMethod(page, 'qr');
    await expect(page.getByTestId('qr-error')).toBeVisible();
    await page.getByRole('button', { name: t('qr.other') }).click();
    await page.locator('[data-bank="SCB"] label').click(); await expect(page.getByTestId('payto-account')).toHaveText('519-4-02625-1');
  });

  test('the price changed on the server: no QR for an amount that differs from the total; the total is refreshed and the QR follows', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page);
    fake.item('FG-000001').price = 400;
    await pickMethod(page, 'qr');
    await expect(page.getByTestId('qr-amount')).toHaveText('฿450'); await expect(placeBtn(page)).toContainText('฿450');
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 450));
  });

  test('no PromptPay account: the QR is not offered', async ({ page }) => {
    const fake = new FakeShop(); fake.w.promptpay = false; await start(page, fake); await toCheckout(page); await openMethods(page);
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0); expect(fake.count('shop_checkout_qr')).toBe(0);
  });

  test('dark theme: the QR is still black on white with its quiet zone and scans', async ({ page }) => {
    await page.addInitScript(() => { const set = () => document.documentElement?.setAttribute('data-theme', 'dark'); set(); document.addEventListener('DOMContentLoaded', set); });
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page); await pickMethod(page, 'qr');
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));
  });
});

test.describe('pay later: the QR on the order page', () => {
  test('QR chosen at checkout: no slip is asked, the QR appears on the order page without another tap, for the exact amount', async ({ page }) => {
    const errs = watch(page); const fake = new FakeShop(); fake.settings.require_payment_slip = false; await start(page, fake); await toCheckout(page); await pickMethod(page, 'qr');
    await expect(page.getByTestId('qr-later')).toBeVisible(); await expect(page.getByTestId('pay-qr')).toHaveCount(0);   // paying before the order exists would leave the money without an order
    await placeBtn(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));
    expect(fake.count('finance_request_payment')).toBe(1);                                       // made once, not on every render or refresh
    await page.getByRole('button', { name: t('od.refresh') }).click(); await expect(page.getByTestId('pay-qr')).toBeVisible(); expect(fake.count('finance_request_payment')).toBe(1);
    await expect(methodFold(page).locator('.sp-fold-h')).toHaveAttribute('aria-expanded', 'false'); await expect(chosen(page)).toHaveAttribute('data-chosen', 'qr');
    expect(await openFolds(page)).toBe(0);                                                       // progress, items and delivery wait behind one line each
    await page.screenshot({ path: `${SHOTS}/ux-7-order-pay-qr.png`, fullPage: true });
    await pickMethod(page, 'SCB'); await expect(page.getByTestId('pay-qr')).toHaveCount(0); await expect(page.getByTestId('payto-account')).toHaveText('519-4-02625-1');
    await pickMethod(page, 'qr'); expect(await scan(page)).toBe(promptPayPayload('0812345678', 370)); expect(fake.count('finance_request_payment')).toBe(1);
    expect(errs).toEqual([]);
  });

  test('a QR made before a part payment is never shown again: a new one for what is left', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); const o = fake.seedOrder(); fake.giveQr(o.order_no); fake.setPaid(o.order_no, 120); fake.forceCode(o.order_no, 4);
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click();
    await page.getByRole('button', { name: /Pay this invoice|ชำระเงิน$/ }).click(); await pickMethod(page, 'qr');
    await expect(page.getByTestId('qr-amount')).toHaveText('฿200'); expect(await scan(page)).toBe(promptPayPayload('0812345678', 200));
  });

  test('the QR cannot be made: the reason and Try again, no picture', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); fake.seedOrder(); fake.failNext('finance_request_payment');
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click(); await pickMethod(page, 'qr');
    await expect(page.getByTestId('qr-error')).toBeVisible(); await expect(page.locator('.qr-box')).toHaveCount(0);
    await page.waitForTimeout(400); expect(fake.count('finance_request_payment')).toBe(1);       // it does not hammer the server
    await page.getByTestId('qr-error').getByRole('button', { name: t('common.retry') }).click();
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 320));
  });

  test('an expired QR, a waiting slip: no QR is made by itself (the money may already be on its way)', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); const a = fake.seedOrder(); fake.giveQr(a.order_no, false);
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click(); await pickMethod(page, 'qr');
    await expect(page.getByRole('button', { name: /Create payment QR|สร้าง QR ชำระเงิน/ })).toBeVisible(); await expect(page.locator('.qr-box')).toHaveCount(0);
    expect(fake.count('finance_request_payment')).toBe(0);
  });
});

test.describe('moving between steps', () => {
  test('cart and back, another tab and back: note, way of getting it, method and slip are all still there; the account gives the name and phone', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page);
    await page.getByRole('radio', { name: t('co.pickup') }).click();
    await expect(page.getByTestId('contact-section')).toHaveCount(0);                            // the account has a name and a phone: nothing to ask
    await page.getByLabel(t('co.note')).fill('ฝากไว้หน้าร้าน');
    await pickMethod(page, 'BBL'); await attach(page); await page.getByLabel(t('co.slipRef')).fill('REF-9');
    const same = async () => {
      await expect(page.getByRole('radio', { name: t('co.pickup') })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByLabel(t('co.note'))).toHaveValue('ฝากไว้หน้าร้าน');
      await expect(chosen(page)).toHaveAttribute('data-chosen', 'BBL'); await expect(page.getByTestId('slip-preview')).toBeVisible(); await expect(page.getByLabel(t('co.slipRef'))).toHaveValue('REF-9');
      expect(await openFolds(page)).toBe(0);
    };
    await page.getByRole('button', { name: t('co.back') }).click(); await page.getByRole('button', { name: t('cart.checkout') }).click(); await same();
    await tab(page, t('nav.shop')).click(); await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click(); await same();
    await placeBtn(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible();
    const a = fake.calls.find((c) => c.fn === 'shop_place_order')!.args;
    expect([a.p_name, a.p_phone, a.p_note, a.p_fulfilment, a.p_payment_method, a.p_slip_ref]).toEqual(['สมชาย ใจดี', '0812345678', 'ฝากไว้หน้าร้าน', 'pickup', 'bank:BBL', 'REF-9']);
  });

  test('the in-app browser reloads while the customer is in the bank app: the text and the method are still there, the QR comes back (the slip picture must be attached again)', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page); await page.getByLabel(t('co.address')).fill('99/1 ถนนทดสอบ'); await pickMethod(page, 'qr');
    await expect(page.getByTestId('pay-qr')).toBeVisible();
    await page.reload(); await expect(page.locator('.phone-nav')).toBeVisible(); await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await expect(page.getByLabel(t('co.address'))).toHaveValue('99/1 ถนนทดสอบ'); await expect(chosen(page)).toHaveAttribute('data-chosen', 'qr');
    expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));
  });

  test('a finished order leaves nothing behind: the next checkout starts clean', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page); await page.getByLabel(t('co.note')).fill('ครั้งเดียว'); await pickMethod(page, 'BBL'); await attach(page);
    await placeBtn(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible();
    await toCheckout(page, 'FG-000002');
    await expect(page.getByTestId('slip-preview')).toHaveCount(0); await expect(chosen(page)).toHaveAttribute('data-chosen', 'SCB'); await expect(page.locator('body')).not.toContainText('ครั้งเดียว');
  });

  test('the total changed after the slip was attached: the customer is warned', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page); await attach(page);
    await page.getByRole('radio', { name: t('co.pickup') }).click();
    await expect(page.getByText(t('co.slipTotalChanged', { was: '฿370', now: '฿320' }))).toBeVisible();
    await attach(page, 'new.png'); await expect(page.getByText(t('co.slipTotalChanged', { was: '฿370', now: '฿320' }))).toHaveCount(0);
  });

  test('the method changes after the slip was attached: the new place to pay shows itself, the slip stays', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); await toCheckout(page); await attach(page); await expect(page.getByTestId('payto-bank')).toHaveCount(0);
    await pickMethod(page, 'BBL'); await expect(page.getByTestId('payto-account')).toHaveText('938-0-31954-2'); await expect(page.getByTestId('slip-preview')).toBeVisible();
    await pickMethod(page, 'qr'); await expect(page.getByTestId('pay-qr')).toBeVisible(); await expect(page.getByTestId('slip-preview')).toBeVisible();
  });

  test('an account without a phone: only then the contact details are asked; a mistake puts the focus on the field and nothing is sent', async ({ page }) => {
    const fake = new FakeShop(); fake.profile.phone = ''; await start(page, fake); await toCheckout(page);
    await expect(page.getByTestId('contact-section')).toBeVisible(); await expect(page.getByLabel(t('co.name'))).toHaveValue('สมชาย ใจดี');
    await page.getByLabel(t('co.phone')).fill('12'); await openFold(page, 'items'); await attach(page);
    await placeBtn(page).click();
    await expect(page.getByLabel(t('co.phone'))).toBeFocused(); await expect(page.getByText(t('err.phone'))).toBeVisible();
    expect(fake.count('shop_place_order')).toBe(0);
    await page.getByLabel(t('co.phone')).fill('0899999999');
    await placeBtn(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.calls.find((c) => c.fn === 'shop_place_order')!.args.p_phone).toBe('0899999999');
  });

  test('a returning customer sees a short page: everything closed, one tap to change', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake);
    await page.evaluate(() => localStorage.setItem('tc.shop.contact:11111111-1111-4111-8111-111111111111', JSON.stringify({ name: 'ลูกค้าเดิม', phone: '0812345678', address: '1 ถนนเดิม' })));
    await toCheckout(page); expect(await openFolds(page)).toBe(0);
    await expect(page.getByLabel(t('co.address'))).toHaveValue('1 ถนนเดิม'); await expect(page.getByTestId('contact-section')).toHaveCount(0);
  });
});

test.describe('fits and is accessible', () => {
  for (const vp of [{ n: 'small phone', w: 320, h: 640 }, { n: 'phone', w: 390, h: 844 }, { n: 'tablet', w: 820, h: 1180 }, { n: 'desktop', w: 1440, h: 900 }]) {
    test(`${vp.n}: no horizontal overflow closed, open, with the QR, with the slip and on the order; axe finds nothing serious`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const errs = watch(page); const fake = new FakeShop(); fake.w.seedBalance(500); await start(page, fake); await toCheckout(page);
      const check = async (name: string) => {
        await noOverflow(page);
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
        expect(bad, `${name}: ${bad.join('\n')}`).toEqual([]);
      };
      await check('closed'); await openMethods(page); await check('methods open'); await pickMethod(page, 'qr'); await expect(page.getByTestId('pay-qr')).toBeVisible(); await check('qr');
      expect(await scan(page)).toBe(promptPayPayload('0812345678', 370));
      await page.screenshot({ path: `${SHOTS}/ux-fit-${vp.w}-qr.png`, fullPage: true });
      await attach(page); await check('slip');
      await placeBtn(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible(); await check('order');
      await page.screenshot({ path: `${SHOTS}/ux-fit-${vp.w}-order.png`, fullPage: true });
      expect(errs).toEqual([]);
    });
  }
  test('English', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('tc.shop.lang', 'en'); } catch { /* ignore */ } });
    const en = (k: K, v?: Record<string, string | number>) => tr('en', k, v);
    const fake = new FakeShop(); await start(page, fake);
    await tab(page, en('nav.shop')).click(); await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: en('p.add') }).click();
    await tab(page, en('nav.cart')).click(); await page.getByRole('button', { name: en('cart.checkout') }).click();
    await expect(chosen(page)).toContainText('Siam Commercial Bank'); await pickMethod(page, 'qr');
    await expect(page.getByRole('img', { name: en('qr.alt', { amount: '฿370' }) })).toBeVisible(); await expect(page.getByText(en('qr.step2'))).toBeVisible();
  });
});
