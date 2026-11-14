// Online ordering, customer side: how the customer chooses to pay at checkout, what the payment screen then shows (reference, the
// chosen method pre-selected, refunded status), and the fallbacks. Against the fake backend (fakeBackend.ts + fakeWallet.ts): this proves
// the SCREENS; the rules (server prices, idempotency, accounting) are proved in the database by supabase/tests/online_ordering.sql.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const SHOTS = process.env.SHOP_SHOTS ?? 'test-results/shop';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function open(page: Page, fake: FakeShop) {
  await fake.install(page);
  await page.goto('/#/app');
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
async function toCheckout(page: Page, sku = 'FG-000001') {
  await tab(page, t('nav.shop')).click();
  await page.locator(`.sp-card[data-sku="${sku}"]`).getByRole('button', { name: t('p.add') }).click();
  await tab(page, t('nav.cart')).click();
  await page.getByRole('button', { name: t('cart.checkout') }).click();
  await expect(page.getByRole('heading', { name: t('co.payment') })).toBeVisible();
}
async function fillAndPlace(page: Page) {
  await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
  await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
  await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
  await expect(page.locator('.sp-order-detail')).toBeVisible();
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);

test.describe('checkout: how to pay', () => {
  test('banks and the QR come from the database, the wallet only when it holds money, the first bank is pre-selected', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await expect(page.locator('[data-bank="SCB"]')).toContainText('519-4-02625-1'); await expect(page.locator('[data-bank="BBL"]')).toContainText('938-0-31954-2');
    await expect(page.locator('[data-bank="SCB"]')).toHaveClass(/on/);
    await expect(page.locator('[data-method="qr"]')).toBeVisible();
    await expect(page.locator('[data-method="wallet"]')).toHaveCount(0);                            // a zero wallet is not offered
    await page.screenshot({ path: `${SHOTS}/checkout-payment-mobile.png`, fullPage: true });
    await noOverflow(page);
  });

  test('the choice travels with the order (never an amount) and is pre-selected on the payment screen, with the invoice number as the reference', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:4179' });
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await page.locator('[data-bank="BBL"] label').click();
    await expect(page.locator('[data-bank="BBL"]')).toHaveClass(/on/);
    await fillAndPlace(page);
    const call = fake.calls.find((c) => c.fn === 'shop_place_order')!;
    expect(call.args.p_payment_method).toBe('bank:BBL');
    expect(Object.keys(call.args).filter((k) => /price|amount|balance|status/.test(k))).toEqual([]);   // only SKU + quantity + contact + the total the customer saw
    expect(fake.orders[0].payment_pref).toBe('bank:BBL');
    await expect(page.locator('[data-bank="BBL"]')).toHaveClass(/on/);                               // pre-selected for the transfer
    await expect(page.locator('[data-bank="SCB"]')).not.toHaveClass(/on/);
    const inv = fake.orders[0].invoice.invoice_no;
    await expect(page.getByTestId('payment-ref')).toHaveText(inv);
    await page.getByRole('button', { name: t('bank.copyRef') }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inv);                      // exactly the invoice number
    await expect(page.getByTestId('transfer-amount').first()).toContainText('฿370');   // 320 + the shop's 50 delivery fee, priced by the server
  });

  test('pay by transfer end to end: slip makes it "awaiting verification", NOT paid; staff verification makes it paid', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await fillAndPlace(page);
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('slip-preview')).toBeVisible();
    await page.getByRole('button', { name: /Submit this slip|ส่งสลิปนี้/ }).click();
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.pending'));
    expect(fake.calls.find((c) => c.fn === 'finance_submit_evidence')!.args.p_bank_account).toBe('bank-scb');
    expect((await page.locator('.sp-order-detail .sp-pill').allTextContents()).join('|')).not.toContain(t('pay.paid'));
    expect(fake.orders[0].invoice.paid).toBe(0);
    fake.verifyPayment(fake.orders[0].order_no);                                                    // the employee verifies in the back office
    await page.getByRole('button', { name: t('od.refresh') }).click();
    await expect(page.locator('.sp-order-detail .sp-pill').filter({ hasText: t('pay.paid') })).toBeVisible();
  });

  test('choosing the wallet: pre-selected on the order, the payment panel opens', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.w.seedBalance(1000); await open(page, fake); await toCheckout(page);
    await expect(page.locator('[data-method="wallet"]')).toContainText('฿1,000');
    await page.locator('[data-method="wallet"] label').click();
    await fillAndPlace(page);
    expect(fake.calls.find((c) => c.fn === 'shop_place_order')!.args.p_payment_method).toBe('wallet');
    await expect(page.getByTestId('wallet-pay')).toBeVisible();
    expect(fake.w.balance).toBe(1000);                                                               // choosing is not paying
  });

  test('no PromptPay account yet: the QR is not offered anywhere, banks still work', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.w.promptpay = false; await open(page, fake); await toCheckout(page);
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0);
    await fillAndPlace(page);
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0);
    await expect(page.locator('[data-bank="SCB"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Create payment QR|สร้าง QR ชำระเงิน/ })).toHaveCount(0);
  });

  test('an old database without payment methods: checkout still works and says where to choose', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.w.enabled = false; await open(page, fake); await toCheckout(page);
    await expect(page.getByText(t('co.paymentLater'))).toBeVisible();
    await expect(page.locator('[data-bank]')).toHaveCount(0);
    await fillAndPlace(page);
    expect(fake.calls.find((c) => c.fn === 'shop_place_order')!.args).not.toHaveProperty('p_payment_method');
    await expect(page.getByRole('button', { name: /Create payment QR|สร้าง QR ชำระเงิน/ })).toBeVisible();   // the original QR flow
  });

  test('a double tap on place order still creates ONE order with the choice', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await page.locator('[data-bank="BBL"] label').click();
    await page.getByLabel(t('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).dblclick();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders).toHaveLength(1);
    expect(new Set(fake.calls.filter((c) => c.fn === 'shop_place_order').map((c) => c.args.p_key)).size).toBe(1);
  });
});

test.describe('after payment', () => {
  test('a refund into the wallet shows as REFUNDED on the order', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page); await fillAndPlace(page);
    fake.refund(fake.orders[0].order_no, 320);
    await page.getByRole('button', { name: t('od.refresh') }).click();
    await expect(page.locator('.sp-order-detail')).toContainText('คืนเงินแล้ว ฿320');
    await expect(page.locator('.sp-order-detail')).toContainText('เข้ากระเป๋าเงิน');
  });
  test('English: the same screens read in English', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await tab(page, t('nav.account')).click(); await page.getByRole('button', { name: 'English' }).click();
    const en = (k: K) => tr('en', k);
    await tab(page, en('nav.shop')).click();
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: en('p.add') }).click();
    await tab(page, en('nav.cart')).click(); await page.getByRole('button', { name: en('cart.checkout') }).click();
    await expect(page.getByRole('heading', { name: en('co.payment') })).toBeVisible();
    await expect(page.locator('[data-bank="SCB"]')).toContainText('Siam Commercial Bank');
    await expect(page.getByText(/Pick what suits you/)).toBeVisible();
  });
});

test.describe('accessible and responsive', () => {
  test('axe: no critical or serious violations on the checkout with payment methods', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.w.seedBalance(500); await open(page, fake); await toCheckout(page);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });
  for (const vp of [{ n: 'small phone', w: 320, h: 640 }, { n: 'desktop', w: 1440, h: 900 }]) {
    test(`no horizontal overflow on checkout and on the payment screen (${vp.n})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const fake = new FakeShop(); fake.decorate(); fake.w.seedBalance(500); await open(page, fake); await toCheckout(page); await noOverflow(page);
      await fillAndPlace(page); await noOverflow(page);
    });
  }
});
