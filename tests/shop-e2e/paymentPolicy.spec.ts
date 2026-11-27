// Customer payment policy, the QR top-up (FB-001042) and their staff screens, against the FAKE backend (fakeBackend.ts + fakeWallet.ts). The fake follows the contract that
// supabase/tests/payment_policy.sql proves against the real database (65/65, rolled back). THIS file proves the SCREENS: a full-payment customer sees the rule and cannot edit the amount,
// the wallet pays exactly what is owed, a refusal from the server (the policy changed meanwhile) reads in Thai, the QR option appears in the top-up only when the shop linked its QR to a
// bank account and is drawn from the server's QR, and staff (manager only) change a policy with a reason and link the QR to a bank account. An old database changes nothing.
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { openMethods } from './methods';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function open(page: Page, fake: FakeShop, hash = '/app') {
  await fake.install(page);
  await page.goto(`/#${hash}`);
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
function seedOrder(fake: FakeShop, key = 'policy-order-001', qty = 1) {
  return (fake.rpc('shop_place_order', { p_key: key, p_items: [{ sku_code: 'FG-000001', qty }], p_fulfilment: 'pickup', p_name: 'สมชาย', p_phone: '0812345678', p_address: null, p_note: null }) as { order: { total: number; invoice: { id: string } } }).order;
}
async function openOrderInvoice(page: Page) {
  await tab(page, t('nav.orders')).click();
  await page.locator('.sp-order').first().click();
  await expect(page.locator('.sp-order-detail')).toBeVisible();
  await openMethods(page); await expect(page.locator('[data-bank="SCB"]')).toBeVisible();
}
async function openAddMoney(page: Page) {
  await tab(page, t('nav.account')).click();
  await page.getByTestId('wallet-card').click();
  await expect(page.getByTestId('wallet-balance')).toBeVisible();
  await page.getByRole('button', { name: t('w.add') }).first().click();
}
const methodRadio = (page: Page, code: string) => page.locator(`[data-bank="${code}"] label`);

test.describe('full-payment customer: the invoice', () => {
  test('the rule is shown, the slip amount is the whole outstanding amount and cannot be edited, and that amount is what is sent', async ({ page }) => {
    const fake = new FakeShop(); fake.w.policy = 'full'; const order = seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    await expect(page.getByTestId('policy-full')).toContainText(`฿${order.total.toLocaleString('en-US')}`);
    await methodRadio(page, 'BBL').click();
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('slip-preview')).toBeVisible();
    const amount = page.getByTestId('slip-amount');
    await expect(amount).toHaveValue(String(order.total));
    await expect(amount).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: /Submit this slip|ส่งสลิปนี้/ }).click();
    await expect.poll(() => fake.calls.find((c) => c.fn === 'finance_submit_evidence')?.args.p_claimed_amount).toBe(order.total);
  });

  test('a partial-payment customer (the default) can still edit the amount, and sees no rule', async ({ page }) => {
    const fake = new FakeShop(); seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    await expect(page.getByTestId('policy-full')).toHaveCount(0);
    await methodRadio(page, 'BBL').click();
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('slip-preview')).toBeVisible();
    await expect(page.getByTestId('slip-amount')).not.toHaveAttribute('readonly', '');
  });

  test('an old database without the policy migration behaves as before: editable amount, no rule', async ({ page }) => {
    const fake = new FakeShop(); fake.w.policyEnabled = false; fake.w.policy = 'full'; seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    await expect(page.getByTestId('policy-full')).toHaveCount(0);
    await methodRadio(page, 'BBL').click();
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('slip-amount')).not.toHaveAttribute('readonly', '');
  });

  test('the policy changed after the page loaded: the server refuses a part slip and the customer reads why, in Thai, with nothing recorded', async ({ page }) => {
    const fake = new FakeShop(); const order = seedOrder(fake); await open(page, fake); await openOrderInvoice(page);   // the page believes "partial"
    await expect(page.getByTestId('policy-full')).toHaveCount(0);
    fake.w.policy = 'full';                                                                                              // the shop changes the policy behind the customer's back
    await methodRadio(page, 'BBL').click();
    await page.locator('input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await page.getByTestId('slip-amount').fill('100');
    await page.getByRole('button', { name: /Submit this slip|ส่งสลิปนี้/ }).click();
    await expect(page.getByText(/ชำระเต็มจำนวน/).first()).toBeVisible();
    expect(fake.orders[0].invoice.evidence).toHaveLength(0);
    expect(order.total).toBeGreaterThan(100);
  });
});

test.describe('full-payment customer: the wallet', () => {
  test('the wallet pays exactly what is owed (the amount cannot be edited)', async ({ page }) => {
    const fake = new FakeShop(); fake.w.policy = 'full'; fake.w.seedBalance(2000); const order = seedOrder(fake, 'policy-order-002', 2); await open(page, fake); await openOrderInvoice(page);   // ฿640
    await page.locator('[data-method="wallet"] label').click();
    const amount = page.getByTestId('wallet-amount');
    await expect(amount).toHaveValue(String(order.total));
    await expect(amount).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ }).click();
    await expect(page.locator('.sp-order-detail .sp-pill').filter({ hasText: t('pay.paid') })).toBeVisible();
    expect(fake.calls.find((c) => c.fn === 'finance_pay_invoice_with_wallet')!.args.p_amount).toBe(order.total);
    expect(fake.w.balance).toBe(2000 - order.total);
  });

  test('a balance that does not cover the whole amount cannot pay part of it: the button stays off and the shortfall is shown', async ({ page }) => {
    const fake = new FakeShop(); fake.w.policy = 'full'; fake.w.seedBalance(100); seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    await page.locator('[data-method="wallet"] label').click();
    await expect(page.getByTestId('wallet-pay')).toContainText('฿');
    await expect(page.getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ })).toBeDisabled();
    await expect(page.getByTestId('wallet-pay').getByRole('status')).toBeVisible();
    expect(fake.count('finance_pay_invoice_with_wallet')).toBe(0);
  });

  test('a partial-payment customer can still pay part of the invoice from the wallet', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(100); seedOrder(fake); await open(page, fake); await openOrderInvoice(page);
    await page.locator('[data-method="wallet"] label').click();
    await expect(page.getByTestId('wallet-amount')).not.toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: /ชำระ .* จากกระเป๋าเงิน/ })).toBeEnabled();
  });
});

test.describe('wallet top-up with PromptPay QR (FB-001042)', () => {
  test('no QR option until the shop links its QR to a bank account (bank transfer still works)', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake); await openAddMoney(page);
    await expect(methodRadio(page, 'SCB')).toBeVisible();
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0);
  });

  test('linked: the QR is a choice; the deposit is created with the QR\'s bank and the QR the server made for that amount is shown next to the bank details', async ({ page }) => {
    const fake = new FakeShop(); fake.w.qrBankId = 'bank-scb'; await open(page, fake); await openAddMoney(page);
    await expect(page.locator('[data-method="qr"]')).toBeVisible();
    await page.locator('[data-method="qr"] label').click();
    await page.getByLabel(t('dep.amount')).fill('500');
    await page.getByRole('button', { name: t('dep.create') }).click();
    expect(fake.w.calls.find((c) => c.fn === 'finance_deposit_create')!.args).toMatchObject({ p_bank: 'bank-scb', p_amount: 500 });   // booked to the QR's own bank account
    const box = page.getByTestId('deposit-qr');
    await expect(box).toBeVisible();
    await expect(box.getByTestId('qr-panel')).toBeVisible();
    await expect(box.getByTestId('qr-amount')).toContainText('฿500');
    await expect(box.getByTestId('qr-error')).toHaveCount(0);
    expect(fake.w.calls.find((c) => c.fn === 'finance_deposit_qr')!.args.p_deposit).toBe(fake.w.deposits[0].id);
    await expect(page.getByTestId('transfer-amount')).toHaveText('฿500');                                                                // the bank details are still there
    await expect(page.getByTestId('account-no')).toBeVisible();
  });

  test('a deposit for ANOTHER bank has no QR (it would be booked to the wrong account)', async ({ page }) => {
    const fake = new FakeShop(); fake.w.qrBankId = 'bank-scb'; await open(page, fake); await openAddMoney(page);
    await methodRadio(page, 'BBL').click();
    await page.getByLabel(t('dep.amount')).fill('500');
    await page.getByRole('button', { name: t('dep.create') }).click();
    await expect(page.getByTestId('transfer-amount')).toHaveText('฿500');
    await expect(page.getByTestId('deposit-qr')).toHaveCount(0);
    expect(fake.w.calls.filter((c) => c.fn === 'finance_deposit_qr')).toHaveLength(0);
  });

  test('an old database (no QR function) keeps the bank-only top-up working', async ({ page }) => {
    const fake = new FakeShop(); fake.w.policyEnabled = false; fake.w.qrBankId = 'bank-scb'; await open(page, fake); await openAddMoney(page);
    await expect(page.locator('[data-method="qr"]')).toHaveCount(0);
    await methodRadio(page, 'SCB').click();
    await page.getByLabel(t('dep.amount')).fill('500');
    await page.getByRole('button', { name: t('dep.create') }).click();
    await expect(page.getByTestId('transfer-amount')).toHaveText('฿500');
    await expect(page.getByTestId('deposit-qr')).toHaveCount(0);
  });
});

test.describe('staff screens', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  async function openPayments(page: Page, fake: FakeShop, role: 'manager' | 'viewer') {
    fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff'; fake.w.role = role;
    await fake.install(page);
    await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
    await page.goto('/#/payments');
    await expect(page.getByRole('heading', { name: 'Payments & wallet' })).toBeVisible();
  }

  test('Customers tab: a manager changes a customer to full payment with a reason; the history gets the reason', async ({ page }) => {
    const fake = new FakeShop(); seedOrder(fake); await openPayments(page, fake, 'manager');
    await page.getByRole('tab', { name: 'Customers' }).click();
    const row = page.getByTestId('policy-row').first();
    await expect(row).toContainText('Partial payments allowed');
    await row.getByRole('button', { name: 'Change' }).click();
    const modal = page.locator('.modal');
    await expect(modal.getByRole('button', { name: 'Save' })).toBeDisabled();                                    // nothing changed, no reason
    await modal.getByRole('combobox', { name: 'Payment policy' }).selectOption('full');
    await expect(modal.getByRole('button', { name: 'Save' })).toBeDisabled();                                    // a reason is required
    await modal.getByRole('textbox', { name: 'Reason' }).fill('Wholesale terms');
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText('Full payment required');
    expect(fake.w.policy).toBe('full');
    expect(fake.w.policyLog).toEqual([{ to: 'full', reason: 'Wholesale terms' }]);
  });

  test('Customers tab: a viewer sees the policies but has no Change button', async ({ page }) => {
    const fake = new FakeShop(); seedOrder(fake); await openPayments(page, fake, 'viewer');
    await page.getByRole('tab', { name: 'Customers' }).click();
    await expect(page.getByTestId('policy-row').first()).toContainText('Partial payments allowed');
    await expect(page.getByRole('button', { name: 'Change' })).toHaveCount(0);
  });

  test('Customers tab on a database without the migration says so and changes nothing', async ({ page }) => {
    const fake = new FakeShop(); fake.w.policyEnabled = false; await openPayments(page, fake, 'manager');
    await page.getByRole('tab', { name: 'Customers' }).click();
    await expect(page.getByText('Customer payment policies are not installed in the database yet.')).toBeVisible();
  });

  test('Bank accounts tab: the manager links the shop QR to a bank account (customers then get the QR top-up); a viewer cannot', async ({ page }) => {
    const fake = new FakeShop(); fake.paymentAccounts.push({ id: 'acct-1', label: 'KASIKORN BANK', kind: 'promptpay', target: '0812345678', target_type: 'phone', merchant_name: 'Test shop', is_default: true, active: true, created_at: new Date().toISOString(), bank_account_id: null });
    await openPayments(page, fake, 'manager');
    await page.getByRole('tab', { name: 'Bank accounts' }).click();
    const card = page.getByTestId('qr-bank-card');
    await expect(card).toContainText('Not linked: customers see no QR when they top up');
    await card.getByRole('combobox', { name: 'Bank account of the QR' }).selectOption('bank-scb');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => fake.w.qrBankId).toBe('bank-scb');
    await expect(card).not.toContainText('Not linked: customers see no QR when they top up');
  });

  async function openRecordPayment(page: Page, policy: 'full' | 'partial') {
    const fake = new FakeShop(); fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff'; fake.w.role = 'manager'; fake.w.policy = policy; fake.rv.seed();
    await fake.install(page); await page.clock.setFixedTime(new Date(fake.rv.clockIso));
    await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
    await page.goto('/#/payment-review');
    await page.locator('table.t tbody tr', { hasText: 'INV-000102' }).getByRole('button').last().click();
    await page.locator('.modal').last().getByRole('button', { name: 'Record payment' }).click();
    await expect(page.locator('.modal').last().getByRole('button', { name: 'Record payment' })).toBeVisible();
    return fake;
  }
  test('Record payment warns, but does not block, for a full-payment customer', async ({ page }) => {
    const fake = await openRecordPayment(page, 'full');
    await expect(page.getByTestId('policy-staff-warning')).toBeVisible();
    expect(fake.w.calls.some((c) => c.fn === 'finance_customer_policies' && Array.isArray(c.args.p_ids))).toBe(true);
    await expect(page.locator('.modal').last().getByRole('combobox').first()).toBeEnabled();      // the form is not locked
  });
  test('Record payment shows no warning for a partial-payment customer', async ({ page }) => {
    await openRecordPayment(page, 'partial');
    await expect(page.getByTestId('policy-staff-warning')).toHaveCount(0);
  });
});
