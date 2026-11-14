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

/** the checkout asks for the transfer slip: attach a (unique) picture when the screen shows that step */
async function attachSlip(page: Page) {
  if (await page.getByTestId('slip-section').count() === 0) return;
  if (await page.getByTestId('slip-preview').count() > 0) return;                              // already attached (a retry keeps the same slip)
  await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#' + Math.random())]) });
  await expect(page.getByTestId('slip-preview')).toBeVisible();
}


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
  await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
  await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
  await expect(page.locator('.sp-order-detail')).toBeVisible();
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);

test.describe('checkout: how to pay', () => {
  test('banks come from the database, the wallet only when it holds money, the first bank is pre-selected', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await expect(page.locator('[data-bank="SCB"]')).toContainText('519-4-02625-1'); await expect(page.locator('[data-bank="BBL"]')).toContainText('938-0-31954-2');
    await expect(page.locator('[data-bank="SCB"]')).toHaveClass(/on/);
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0);                              // the QR needs an invoice: it is on the payment screen, not at checkout
    await expect(page.locator('[data-method="wallet"]')).toHaveCount(0);                            // a zero wallet is not offered
    await page.screenshot({ path: `${SHOTS}/checkout-payment-mobile.png`, fullPage: true });
    await noOverflow(page);
  });

  test('with the slip rule switched off (pay later): the choice travels with the order and is pre-selected on the payment screen, with the invoice number as the reference', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:4179' });
    const fake = new FakeShop(); fake.decorate(); fake.settings.require_payment_slip = false; await open(page, fake); await toCheckout(page);
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

  test('pay by transfer end to end: the slip comes with the order = "awaiting verification", NOT paid; staff verification makes it paid', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await page.locator('[data-bank="BBL"] label').click();
    await fillAndPlace(page);                                                                        // attaches the slip, places the order
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.pending'));
    expect([...fake.w.invoiceBank.values()]).toEqual(['bank-bbl']);                                  // the slip names the bank the customer chose
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
    const fake = new FakeShop(); fake.decorate(); fake.w.promptpay = false; fake.settings.require_payment_slip = false; await open(page, fake); await toCheckout(page);
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0);
    await fillAndPlace(page);
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0);
    await expect(page.locator('[data-bank="SCB"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Create payment QR|สร้าง QR ชำระเงิน/ })).toHaveCount(0);
  });

  test('an old database without payment methods: checkout still works and says where to choose', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.w.enabled = false; fake.settings.require_payment_slip = false; await open(page, fake); await toCheckout(page);
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
    await attachSlip(page); await page.getByRole('button', { name: new RegExp(t('co.place')) }).click();
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

test.describe('pay first: the transfer slip comes with the order', () => {
  const addr = '99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110';
  const placeClick = (page: Page) => page.getByRole('button', { name: new RegExp(t('co.place')) });
  const confirm = (page: Page) => page.locator('.sp-sheet').getByRole('button', { name: t('co.place') });
  test('the slip step shows the amount to transfer; WITHOUT a slip the order is not placed and the screen says why', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    const sec = page.getByTestId('slip-section');
    await expect(sec).toBeVisible(); await expect(sec).toContainText(t('co.slipTitle'));
    await expect(sec.getByTestId('transfer-amount')).toContainText('฿370');                          // 320 + 50 delivery, the server's quote
    await page.getByLabel(t('co.address')).fill(addr);
    await placeClick(page).click();                                                                   // no slip yet
    await expect(page.getByText(t('co.slipMissing')).first()).toBeVisible();
    await expect(page.locator('.sp-sheet')).toHaveCount(0);                                           // never reached the confirmation
    expect(fake.count('shop_place_order')).toBe(0); expect(fake.orders).toHaveLength(0);
    await page.screenshot({ path: `${SHOTS}/checkout-slip-required-mobile.png`, fullPage: true });
  });

  test('with the slip: ONE call creates the order, awaiting verification, the slip in the customer\'s own folder, never an amount from the app', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await page.getByLabel(t('co.address')).fill(addr);
    await attachSlip(page);
    await page.getByLabel(t('co.slipRef')).fill('MY-REF-1');
    await placeClick(page).click();
    await expect(page.locator('.sp-sheet')).toContainText(t('co.confirmBodySlip', { total: '฿370' }));
    await confirm(page).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    const call = fake.calls.find((c) => c.fn === 'shop_place_order')!;
    expect(String(call.args.p_slip_path)).toMatch(/^11111111-1111-4111-8111-111111111111\/orders\/[A-Za-z0-9_-]{8,64}\.png$/);
    expect(String(call.args.p_slip_sha256)).toMatch(/^[0-9a-f]{64}$/); expect(call.args.p_slip_type).toBe('image/png'); expect(call.args.p_slip_ref).toBe('MY-REF-1');
    expect(Object.keys(call.args).filter((k) => /price|amount|balance|status|claimed/.test(k))).toEqual([]);   // the database prices the slip's claim
    expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.evidence).toHaveLength(1);
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.pending'));                    // awaiting verification
    expect((await page.locator('.sp-order-detail .sp-pill').allTextContents()).join('|')).not.toContain(t('pay.paid'));
    expect(fake.orders[0].invoice.paid).toBe(0);
    expect(fake.calls.some((c) => c.fn === 'finance_submit_evidence')).toBe(false);                    // not a second step: it was one call
  });

  test('the delivery address is optional', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await expect(page.getByLabel(t('co.address'))).toBeVisible();
    await expect(page.getByText(t('co.addressOptional'))).toBeVisible();
    await attachSlip(page);
    await placeClick(page).click(); await confirm(page).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders[0].fulfilment).toBe('delivery'); expect(fake.orders[0].delivery_address).toBeNull();
  });

  test('pick-up is offered, needs no address, and still needs the slip', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await page.getByRole('radio', { name: t('co.pickup') }).click();
    await expect(page.getByLabel(t('co.address'))).toHaveCount(0);
    await expect(page.getByText('รับที่ร้าน 99 ถนนทดสอบ')).toBeVisible();                              // the shop's pick-up information
    await expect(page.getByTestId('slip-section').getByTestId('transfer-amount')).toContainText('฿320');   // no delivery fee
    await placeClick(page).click(); await expect(page.getByText(t('co.slipMissing')).first()).toBeVisible();
    expect(fake.orders).toHaveLength(0);
    await attachSlip(page);
    await placeClick(page).click(); await confirm(page).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders[0].fulfilment).toBe('pickup'); expect(fake.orders[0].shipping_fee).toBe(0);
    expect(fake.orders[0].invoice.evidence).toHaveLength(1);
  });

  test('an order paid from the wallet needs no slip', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.w.seedBalance(1000); await open(page, fake); await toCheckout(page);
    await expect(page.getByTestId('slip-section')).toBeVisible();
    await page.locator('[data-method="wallet"] label').click();
    await expect(page.getByTestId('slip-section')).toHaveCount(0);
    await page.getByLabel(t('co.address')).fill(addr);
    await placeClick(page).click(); await confirm(page).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.calls.find((c) => c.fn === 'shop_place_order')!.args).not.toHaveProperty('p_slip_path');
    await expect(page.getByTestId('wallet-pay')).toBeVisible();
  });

  test('a slip that was already used is refused by the server: the customer is told, NO order is created', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    await open(page, fake); await toCheckout(page);
    await page.getByLabel(t('co.address')).fill(addr);
    const png = Buffer.concat([PNG, Buffer.from('#reused')]);
    const sum = await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const d = await crypto.subtle.digest('SHA-256', bin); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); }, png.toString('base64'));
    fake.slipHashes.add(sum);                                                                          // this exact picture was used for another payment
    await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('slip-preview')).toBeVisible();
    await placeClick(page).click(); await confirm(page).click();
    await expect(page.getByText(t('err.slipUsed'))).toBeVisible();
    expect(fake.orders).toHaveLength(0);
    await expect(page.locator('.sp-order-detail')).toHaveCount(0);
  });

  test('a file that is not a picture or PDF is refused before anything is sent', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await page.getByLabel(t('co.address')).fill(addr);
    await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is plain text, not a picture') });
    await placeClick(page).click(); await confirm(page).click();
    await expect(page.getByText(t('err.slipBad'))).toBeVisible();
    expect(fake.count('shop_place_order')).toBe(0); expect(fake.orders).toHaveLength(0);
  });

  test('a double tap and a dropped connection still create ONE order with ONE slip', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page);
    await page.getByLabel(t('co.address')).fill(addr); await attachSlip(page);
    fake.dropResponseOnce('shop_place_order');
    await placeClick(page).click(); await confirm(page).dblclick();
    await expect(page.getByText(t('err.network'))).toBeVisible();
    expect(fake.orders).toHaveLength(1);                                                              // the server created it, the answer was lost
    await placeClick(page).click(); await confirm(page).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.evidence).toHaveLength(1);
    expect(new Set(fake.calls.filter((c) => c.fn === 'shop_place_order').map((c) => c.args.p_key)).size).toBe(1);
  });

  test('staff switch the rule off: the slip step disappears and an order without one is accepted', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.settings.require_payment_slip = false; await open(page, fake); await toCheckout(page);
    await expect(page.getByTestId('slip-section')).toHaveCount(0);
    await page.getByLabel(t('co.address')).fill(addr);
    await placeClick(page).click(); await confirm(page).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders[0].invoice.evidence).toHaveLength(0);
  });

  test('accessible on a small phone: the slip step fits and passes axe', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const fake = new FakeShop(); fake.decorate(); await open(page, fake); await toCheckout(page); await attachSlip(page);
    await noOverflow(page);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
