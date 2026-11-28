// Customer side of "Payment methods, bank accounts & wallet" against the fake backend (fakeBackend.ts + fakeWallet.ts).
// The rules (a slip never credits the wallet, only staff approval does, no overspending, no double charge) are enforced and tested
// for real in the database by supabase/tests/wallet_payments.sql; these tests prove that the SCREENS show the right things, send
// the right requests (never an amount for credit, never a balance) and survive double taps and dropped connections.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { openMethods, pickMethod } from './methods';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const SHOTS = process.env.SHOP_SHOTS ?? 'test-results/shop';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function open(page: Page, fake: FakeShop, hash = '/app') {
  await fake.install(page);
  await page.goto(`/#${hash}`);
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
/** an order whose invoice the customer can pay (pickup, 1 x FG-000001 = ฿320) */
function seedOrder(fake: FakeShop, key = 'wallet-order-001', qty = 1) {
  const r = fake.rpc('shop_place_order', { p_key: key, p_items: [{ sku_code: 'FG-000001', qty }], p_fulfilment: 'pickup', p_name: 'สมชาย', p_phone: '0812345678', p_address: null, p_note: null }) as { order: { order_no: string; total: number } };
  return r.order;
}
async function openOrderInvoice(page: Page) {
  await tab(page, t('nav.orders')).click();
  await page.locator('.sp-order').first().click();
  await expect(page.locator('.sp-order-detail')).toBeVisible();
  await openMethods(page); await expect(page.locator('[data-bank="SCB"]')).toBeVisible();
}
async function openWallet(page: Page) {
  await tab(page, t('nav.account')).click();
  await page.getByTestId('wallet-card').click();
  await expect(page.getByTestId('wallet-balance')).toBeVisible();
}
const methodRadio = (page: Page, code: string) => page.locator(`[data-bank="${code}"] label`);

const SCB_NO = '519-4-02625-1', BBL_NO = '938-0-31954-2';

test.describe('payment methods on an invoice', () => {
  test('SCB, BBL and the wallet are shown with the exact configured details; selecting one shows how to pay', async ({ page }) => {
    const fake = new FakeShop(); const order = seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    const scb = page.locator('[data-bank="SCB"]'), bbl = page.locator('[data-bank="BBL"]');
    await expect(scb).toContainText('ธนาคารไทยพาณิชย์'); await expect(scb).toContainText('Siam Commercial Bank'); await expect(scb.getByTestId('account-no')).toHaveText(SCB_NO); await expect(scb).toContainText('ณัฐพล อยู่ยิ้ม');
    await expect(bbl).toContainText('ธนาคารกรุงเทพ'); await expect(bbl).toContainText('Bangkok Bank'); await expect(bbl.getByTestId('account-no')).toHaveText(BBL_NO); await expect(bbl).toContainText('ณัฐพร อยู่ยิ้ม');
    await expect(scb).toContainText('โอนตามยอดที่ระบุ');                                          // per-bank instructions from the database
    await expect(page.locator('[data-method="wallet"]')).toContainText(t('pm.walletBalance', { amount: '฿0' }));
    await expect(page.locator('[data-method="qr"]')).toBeVisible();
    // the first bank is preselected and the exact amount to transfer comes from the invoice (the database), not from the customer
    await expect(page.getByTestId('transfer-amount').first()).toContainText(`฿${order.total.toLocaleString('en-US')}`);
    await pickMethod(page, 'BBL'); await openMethods(page);
    await expect(page.locator('[data-bank="BBL"]')).toHaveClass(/on/); await expect(page.locator('[data-bank="SCB"]')).not.toHaveClass(/on/);
    await page.screenshot({ path: `${SHOTS}/pay-methods-mobile.png`, fullPage: true });
    await noOverflow(page);
  });

  test('the copy button copies exactly the digits of that bank\'s account number', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${process.env.SHOP_PORT ?? 4179}` });
    const fake = new FakeShop(); seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    await page.locator('[data-bank="SCB"] .wl-copy button').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('5194026251');
    await expect(page.getByText(t('bank.copied')).first()).toBeVisible();
    await page.locator('[data-bank="BBL"] .wl-copy button').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('9380319542');
  });

  test('a slip for a bank transfer is sent with the chosen bank, stays pending and adds NOTHING to the wallet', async ({ page }) => {
    const fake = new FakeShop(); const order = seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    await methodRadio(page, 'BBL').click();
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('slip-preview')).toBeVisible();
    expect(fake.count('finance_submit_evidence')).toBe(0);                                      // choosing a picture sends nothing
    await page.getByRole('button', { name: /Submit this slip|ส่งสลิปนี้/ }).click();
    await expect(page.locator('.sp-order-detail')).toContainText(t('pay.pending'));
    const call = fake.calls.find((c) => c.fn === 'finance_submit_evidence')!;
    expect(call.args.p_bank_account).toBe('bank-bbl');
    expect(Number(call.args.p_claimed_amount)).toBe(order.total);
    expect(fake.w.balance).toBe(0); expect(fake.w.txns.length).toBe(0);                          // a slip is not money
    expect(fake.orders[0].invoice.paid).toBe(0);
  });

  test('an old database without the wallet keeps the original QR flow working', async ({ page }) => {
    const fake = new FakeShop(); fake.w.enabled = false; seedOrder(fake); await open(page, fake);
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click();
    await expect(page.getByRole('button', { name: /Create payment QR|สร้าง QR ชำระเงิน/ })).toBeVisible();
    await expect(page.locator('[data-bank]')).toHaveCount(0);
    await tab(page, t('nav.account')).click();
    await expect(page.getByTestId('wallet-card')).toHaveCount(0);                                // no wallet card without a wallet
  });
});

test.describe('customer wallet', () => {
  test('empty wallet: balance, totals, no history, bank cards; the account tab shows the balance', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.account')).click();
    await expect(page.getByTestId('account-wallet-balance')).toHaveText('฿0');
    await page.getByTestId('wallet-card').click();
    await expect(page.getByTestId('wallet-balance')).toHaveText('฿0');
    await expect(page.locator('.sp-stats')).toContainText(t('w.totalDeposits')); await expect(page.locator('.sp-stats')).toContainText(t('w.totalPayments'));
    await expect(page.getByText(t('w.noTxn'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('w.add') }).first()).toBeVisible(); await expect(page.getByRole('button', { name: t('w.payInvoice') })).toBeVisible();
    await expect(page.locator('[data-bank="SCB"]')).toContainText(SCB_NO); await expect(page.locator('[data-bank="BBL"]')).toContainText(BBL_NO);
    await page.screenshot({ path: `${SHOTS}/wallet-empty-mobile.png`, fullPage: true });
    await noOverflow(page);
  });

  test('add money: pick a bank and an amount, transfer, send the slip; only the bank-verified amount reaches the balance', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake); await openWallet(page);
    await page.getByRole('button', { name: t('w.add') }).first().click();
    await expect(page.getByRole('button', { name: t('dep.create') })).toBeDisabled();             // needs a bank and an amount
    await methodRadio(page, 'SCB').click();
    await page.getByLabel(t('dep.amount')).fill('50'); await expect(page.getByRole('button', { name: t('dep.create') })).toBeDisabled();      // below the minimum
    await page.getByLabel(t('dep.amount')).fill('1000');
    await page.getByRole('button', { name: t('dep.create') }).click();
    // step 2: exactly what to transfer, to which account, with a reference
    await expect(page.getByTestId('transfer-amount')).toHaveText('฿1,000');
    await expect(page.getByTestId('deposit-ref')).toHaveText('DEP-202611-00001');
    await expect(page.getByTestId('account-no')).toHaveText(SCB_NO);
    const create = fake.calls.find((c) => c.fn === 'finance_deposit_create')!;
    expect(create.args).toMatchObject({ p_bank: 'bank-scb', p_amount: 1000 }); expect(Object.keys(create.args)).not.toContain('p_balance');
    await page.screenshot({ path: `${SHOTS}/deposit-transfer-mobile.png`, fullPage: true });
    // slip: a preview first, nothing sent until confirmed
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('slip-preview')).toBeVisible();
    expect(fake.count('finance_deposit_submit_slip')).toBe(0);
    await page.getByRole('button', { name: t('dep.submit') }).click();
    await expect(page.getByText(t('dep.submitted')).first()).toBeVisible();
    expect(fake.count('finance_deposit_submit_slip')).toBe(1);
    expect(fake.w.balance).toBe(0);                                                              // the slip alone credits nothing
    // back on the wallet: pending shown, balance still 0
    await page.getByRole('button', { name: t('w.back') }).click();
    await expect(page.getByTestId('wallet-balance')).toHaveText('฿0');
    await expect(page.locator('.wl-bal-pending')).toContainText('฿1,000');
    // the shop checks the bank statement: the bank shows 990 (a transfer fee), so 990 is what is credited
    fake.w.verify('DEP-202611-00001', 990);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByTestId('wallet-balance')).toHaveText('฿990');
    await expect(page.locator('.wl-txn[data-type="DEPOSIT"]')).toContainText('+฿990');
    await expect(page.locator('.wl-txn[data-type="DEPOSIT"]')).toContainText('SCB');
    await expect(page.locator('.sp-stats')).toContainText('฿990');
    await page.screenshot({ path: `${SHOTS}/wallet-credited-mobile.png`, fullPage: true });
  });

  test('a rejected deposit adds nothing and shows the reason; a pending one can be cancelled', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake); await openWallet(page);
    for (const amt of ['500', '700']) {
      await page.getByRole('button', { name: t('w.add') }).first().click();
      await methodRadio(page, 'BBL').click(); await page.getByLabel(t('dep.amount')).fill(amt); await page.getByRole('button', { name: t('dep.create') }).click();
      await expect(page.getByTestId('transfer-amount')).toHaveText(`฿${amt}`);
      if (amt === '500') {
        await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG2 });
        await page.getByRole('button', { name: t('dep.submit') }).click(); await expect(page.getByText(t('dep.submitted')).first()).toBeVisible();
        await page.getByRole('button', { name: t('w.back') }).first().click();
      } else {
        await page.getByRole('button', { name: t('dep.cancel') }).first().click();                      // unpaid: cancel it
        await page.locator('.sp-sheet').getByRole('button', { name: t('dep.cancel') }).click();       // cancelling returns to the wallet by itself
      }
      await expect(page.getByTestId('wallet-balance')).toBeVisible();
    }
    expect(fake.w.deposits.map((d) => d.status)).toEqual(['submitted', 'cancelled']);
    fake.w.reject('DEP-202611-00001', 'ยอดเงินไม่ตรงกับสลิป');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.wl-dep.static').filter({ hasText: 'ยอดเงินไม่ตรงกับสลิป' })).toBeVisible();
    await expect(page.getByTestId('wallet-balance')).toHaveText('฿0');
    expect(fake.w.txns.length).toBe(0);
  });

  test('a double tap creates ONE deposit, and a dropped connection can be retried safely with the same key', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake); await openWallet(page);
    await page.getByRole('button', { name: t('w.add') }).first().click();
    await methodRadio(page, 'SCB').click(); await page.getByLabel(t('dep.amount')).fill('2000');
    fake.dropResponseOnce('finance_deposit_create');
    await page.getByRole('button', { name: t('dep.create') }).dblclick();
    await expect(page.getByText(t('we.NETWORK'))).toBeVisible();                                    // the server created it, the answer never arrived
    expect(fake.w.deposits.length).toBe(1);
    await page.getByRole('button', { name: t('dep.create') }).click();                              // retry
    await expect(page.getByTestId('transfer-amount')).toHaveText('฿2,000');
    expect(fake.w.deposits.length).toBe(1);                                                        // same key: no second deposit
    const keys = fake.calls.filter((c) => c.fn === 'finance_deposit_create').map((c) => c.args.p_key);
    expect(new Set(keys).size).toBe(1);
  });

  test('history: recent first, full history pages, English labels', async ({ page }) => {
    const fake = new FakeShop(); for (let i = 1; i <= 24; i++) fake.w.seedBalance(10 * i);
    await open(page, fake); await openWallet(page);
    await expect(page.locator('.wl-txn')).toHaveCount(5);                                           // recent
    await page.getByRole('button', { name: t('w.history') }).first().click();
    await expect(page.locator('.wl-txn')).toHaveCount(20);
    await page.getByRole('button', { name: t('w.loadMore') }).click();
    await expect(page.locator('.wl-txn')).toHaveCount(24);
    await expect(page.locator('.wl-txn').first()).toContainText('+฿240');                        // newest first
    await expect(page.locator('.wl-txn').first()).toContainText(t('w.balanceAfter', { amount: '฿3,000' }));
    await page.getByRole('button', { name: t('w.back') }).first().click(); await page.getByRole('button', { name: 'English' }).click();
    await page.getByTestId('wallet-card').click();
    await expect(page.getByRole('heading', { name: 'My wallet' })).toBeVisible(); await expect(page.getByText('Available balance')).toBeVisible();
    await expect(page.locator('[data-bank="SCB"]')).toContainText('Account number');
  });
});

test.describe('paying an invoice from the wallet', () => {
  test('pays, the balance and the invoice follow the database, and the payment shows in the wallet history', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(2000); const order = seedOrder(fake, 'wallet-order-002', 2); await open(page, fake); await openOrderInvoice(page);   // ฿640
    expect(order.total).toBe(640);
    await page.locator('[data-method="wallet"] label').click();
    await expect(page.getByTestId('wallet-pay')).toBeVisible();
    await expect(page.getByTestId('wallet-pay').getByLabel(t('wp.amount'))).toHaveValue('640');   // never more than what is owed
    await page.getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await expect(page.locator('.sp-sheet')).toContainText('฿640');                              // a confirmation before any money moves
    expect(fake.count('finance_pay_invoice_with_wallet')).toBe(0);
    await page.locator('.sp-sheet').getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await expect(page.locator('.sp-order-detail .sp-pill').filter({ hasText: t('pay.paid') })).toBeVisible();
    const call = fake.calls.find((c) => c.fn === 'finance_pay_invoice_with_wallet')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_amount', 'p_invoice', 'p_key']);              // no balance, no status, no customer id from the app
    expect(fake.w.balance).toBe(1360); expect(fake.orders[0].invoice.paid).toBe(640);
    expect(fake.w.queue.filter((q) => q.event_type === 'WALLET_PAYMENT')).toHaveLength(1);        // the ledger entry is queued with the payment
    await openWallet(page).catch(async () => { await tab(page, t('nav.account')).click(); await page.getByTestId('wallet-card').click(); });
    await expect(page.getByTestId('wallet-balance')).toHaveText('฿1,360');
    await expect(page.locator('.wl-txn[data-type="INVOICE_PAYMENT"]')).toContainText('−฿640');
    await expect(page.locator('.wl-txn[data-type="INVOICE_PAYMENT"]')).toContainText('INV-');
  });

  test('not enough money: the screen says how much more is needed and cannot pay more than the balance', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(300); seedOrder(fake, 'wallet-order-003', 2); await open(page, fake); await openOrderInvoice(page);
    await page.locator('[data-method="wallet"] label').click();
    await expect(page.getByTestId('wallet-pay')).toContainText(t('wp.short', { amount: '฿340' }));
    const amount = page.getByTestId('wallet-pay').getByLabel(t('wp.amount'));
    await expect(amount).toHaveValue('300');                                                        // at most the balance
    await amount.fill('301');
    await expect(page.getByTestId('wallet-pay').getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ })).toBeDisabled();
    expect(fake.count('finance_pay_invoice_with_wallet')).toBe(0);
  });

  test('the balance changed behind the customer\'s back: the SERVER refuses, nothing is charged, the reason is shown', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(1000); seedOrder(fake, 'wallet-order-004'); await open(page, fake); await openOrderInvoice(page);
    await page.locator('[data-method="wallet"] label').click();
    fake.w.drain(900);                                                                              // staff adjust it while the screen still shows ฿1,000
    await page.getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await expect(page.getByTestId('wallet-pay')).toContainText(t('we.INSUFFICIENT_FUNDS'));
    expect(fake.w.balance).toBe(100); expect(fake.orders[0].invoice.paid).toBe(0);
    expect(fake.w.txns.filter((x) => x.txn_type === 'INVOICE_PAYMENT')).toHaveLength(0);
  });

  test('a double tap, then a dropped connection: the invoice is charged once', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(1000); seedOrder(fake, 'wallet-order-005'); await open(page, fake); await openOrderInvoice(page);   // ฿320
    await page.locator('[data-method="wallet"] label').click();
    fake.dropResponseOnce('finance_pay_invoice_with_wallet');
    await page.getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).dblclick();
    await expect(page.getByTestId('wallet-pay')).toContainText(t('we.NETWORK'));
    expect(fake.w.balance).toBe(680);                                                              // the server did take it once
    await page.getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();                       // retry with the same key
    await page.locator('.sp-sheet').getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await expect(page.locator('.sp-order-detail .sp-pill').filter({ hasText: t('pay.paid') })).toBeVisible();
    expect(fake.w.balance).toBe(680);                                                              // still charged once
    expect(fake.w.txns.filter((x) => x.txn_type === 'INVOICE_PAYMENT')).toHaveLength(1);
    expect(new Set(fake.calls.filter((c) => c.fn === 'finance_pay_invoice_with_wallet').map((c) => c.args.p_key)).size).toBe(1);
  });
});

test.describe('wallet screens: responsive and accessible', () => {
  for (const vp of [{ n: 'small phone', w: 320, h: 640 }, { n: 'phone', w: 390, h: 844 }, { n: 'desktop', w: 1440, h: 900 }]) {
    test(`no horizontal overflow on wallet, add money and payment methods (${vp.n})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const fake = new FakeShop(); fake.w.seedBalance(500); seedOrder(fake); await open(page, fake);
      await openWallet(page); await noOverflow(page);
      await page.getByRole('button', { name: t('w.add') }).first().click(); await expect(page.locator('[data-bank="SCB"]')).toBeVisible(); await noOverflow(page);
      await page.getByRole('button', { name: t('w.back') }).first().click();
      await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click(); await openMethods(page); await expect(page.locator('[data-bank="BBL"]')).toBeVisible(); await noOverflow(page);
      await pickMethod(page, 'wallet'); await expect(page.getByTestId('wallet-pay')).toBeVisible(); await noOverflow(page); await openMethods(page);
      const box = await page.locator('[data-bank="SCB"]').boundingBox(); expect(box!.width).toBeLessThanOrEqual(vp.w);
    });
  }
  test('axe: no critical or serious violations on the wallet screens', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(500); seedOrder(fake); await open(page, fake);
    const check = async (name: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
      expect(bad, `${name}: ${bad.join('\n')}`).toEqual([]);
    };
    await openWallet(page); await check('wallet');
    await page.getByRole('button', { name: t('w.add') }).first().click(); await expect(page.locator('[data-bank="SCB"]')).toBeVisible(); await check('add money');
    await methodRadio(page, 'SCB').click(); await page.getByLabel(t('dep.amount')).fill('1500'); await page.getByRole('button', { name: t('dep.create') }).click();
    await expect(page.getByTestId('transfer-amount')).toBeVisible(); await check('transfer details');
    await page.getByRole('button', { name: t('w.back') }).first().click(); await page.getByRole('button', { name: t('w.back') }).first().click();
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click(); await openMethods(page); await expect(page.locator('[data-bank="BBL"]')).toBeVisible(); await check('invoice payment methods');
    await page.locator('[data-method="wallet"] label').click(); await expect(page.getByTestId('wallet-pay')).toBeVisible(); await check('pay from wallet');
  });
});
