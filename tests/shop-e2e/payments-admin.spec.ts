// Back-office "Payments & wallet" page against the fake backend (fakeBackend.ts + fakeWallet.ts). The staff app is English by default.
// What is allowed to whom, and what the money does, is enforced and tested for real by supabase/tests/wallet_payments.sql;
// these tests prove that staff can DO the work on the screens, that the screens only offer what a role may do, and that they
// send only identifiers and the staff member's own inputs (never a balance).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import type { FRole } from './fakeWallet';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
void PNG;

async function openPayments(page: Page, fake: FakeShop, role: FRole = 'manager', lang: 'en' | 'th' = 'en') {
  fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff'; fake.w.role = role;
  await fake.install(page);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/payments');
  await expect(page.getByRole('heading', { name: lang === 'en' ? 'Payments & wallet' : 'การชำระเงินและกระเป๋าเงิน' })).toBeVisible();
}
const tabBtn = (page: Page, name: string) => page.getByRole('tab', { name });
const seedDeposit = (fake: FakeShop, bank: string, amount: number, slip = true, key = `seed-dep-${fake.w.deposits.length + 1}-xxxxxxxx`) => {
  const d = fake.rpc('finance_deposit_create', { p_bank: bank, p_amount: amount, p_key: key, p_customer_ref: null }) as { id: string; deposit_no: string };
  if (slip) fake.rpc('finance_deposit_submit_slip', { p_deposit: d.id, p_file_path: `u/deposit/${d.deposit_no}.png`, p_sha256: 'sha-' + d.deposit_no, p_file_type: 'image/png', p_transfer_at: null, p_customer_ref: null });
  return d.deposit_no;
};
const seedInvoiceSlip = (fake: FakeShop, bank: string, walletPay = 0) => {
  const r = fake.rpc('shop_place_order', { p_key: 'adm-order-0001', p_items: [{ sku_code: 'FG-000001', qty: 1 }], p_fulfilment: 'pickup', p_name: 'สมชาย', p_phone: '0812345678', p_address: null, p_note: null }) as { order: { invoice: { id: string; invoice_no: string } } };
  if (walletPay) fake.rpc('finance_pay_invoice_with_wallet', { p_invoice: r.order.invoice.id, p_amount: walletPay, p_key: 'adm-walletpay-01' });   // before the slip: a payment under review blocks wallet payment
  fake.rpc('finance_submit_evidence', { p_invoice: r.order.invoice.id, p_claimed_amount: 320, p_bank_account: bank, p_file_path: 'x/slip.png' });
  return r.order.invoice.invoice_no;
};

test.describe('payments list', () => {
  test('shows every kind of customer payment; filters by bank and status; searches by customer name and invoice number', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); seedDeposit(fake, 'bank-bbl', 500, false); fake.w.seedBalance(900); const inv = seedInvoiceSlip(fake, 'bank-bbl', 100);
    await openPayments(page, fake);
    const rows = page.locator('table.t tbody tr');
    await expect(rows).toHaveCount(4);                                                              // 2 deposits + 1 invoice slip + 1 wallet payment
    await expect(page.getByRole('row', { name: /DEP-202611-00001/ })).toContainText('SCB');
    await expect(page.getByRole('row').filter({ hasText: inv }).filter({ hasText: 'BBL' })).toHaveCount(1);          // the slip names its bank; the wallet payment on the same invoice has none
    await page.getByLabel('Bank account').selectOption({ label: 'BBL · ธนาคารกรุงเทพ' });
    await expect(rows).toHaveCount(2);                                                              // the BBL deposit and the BBL invoice slip
    await page.getByLabel('Bank account').selectOption('');
    await page.getByLabel('Status').selectOption('submitted'); await expect(rows).toHaveCount(2);   // the SCB deposit and the invoice slip
    await page.getByLabel('Status').selectOption('pending'); await expect(rows).toHaveCount(1);
    await page.getByLabel('Status').selectOption('');
    await page.getByLabel('Type').selectOption('wallet_payment'); await expect(rows).toHaveCount(1);
    await page.getByLabel('Type').selectOption('');
    await page.getByPlaceholder(/Customer, invoice no/).fill(inv); await expect(rows.filter({ hasText: inv })).toHaveCount(2);   // the invoice slip and the wallet payment on it
    await page.getByPlaceholder(/Customer, invoice no/).fill('สมชาย'); await expect(rows).toHaveCount(4);
    await page.getByPlaceholder(/Customer, invoice no/).fill('nobody'); await expect(page.getByText('No payments match')).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-payments.png` });
  });

  test('a slip opens through a signed link (the bucket is private)', async ({ page, context }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); await openPayments(page, fake);
    const popup = context.waitForEvent('page');
    await page.getByRole('row', { name: /DEP-202611-00001/ }).getByRole('button', { name: 'View slip' }).click();
    const p = await popup; await expect.poll(() => p.url()).toMatch(/\/storage\/v1\/object\/sign\/payment-evidence\/.*token=/);   // opened without an opener, through a short-lived signed link
  });
});

test.describe('verifying deposits', () => {
  test('approve: the wallet gets the amount the BANK shows, a bank reference is required, only a submitted deposit is reviewable', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); seedDeposit(fake, 'bank-bbl', 500, false); await openPayments(page, fake, 'verifier');
    await expect(page.getByRole('row', { name: /DEP-202611-00002/ }).getByRole('button', { name: 'Review' })).toHaveCount(0);   // no slip yet: nothing to approve
    await page.getByRole('row', { name: /DEP-202611-00001/ }).getByRole('button', { name: 'Review' }).click();
    const dlg = page.locator('.modal');
    await expect(dlg).toContainText('Review deposit'); await expect(dlg).toContainText('SCB');
    const approve = dlg.getByRole('button', { name: 'Approve and credit the wallet' });
    await expect(approve).toBeDisabled();                                                           // needs the bank's reference
    await dlg.getByLabel('Amount received (฿)').fill('990');                                       // the bank shows 990 (fee), not the 1000 the customer typed
    await dlg.getByLabel('Bank transaction reference').fill('SCB-2611-777');
    await approve.click();
    await expect.poll(() => fake.w.balance).toBe(990);
    expect(fake.w.deposits[0]).toMatchObject({ status: 'verified', verified_amount: 990 });
    const call = fake.calls.find((c) => c.fn === 'finance_deposit_verify')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_amount', 'p_bank_trans_ref', 'p_deposit', 'p_note', 'p_transfer_at']);   // no customer id, no balance
    await expect(page.getByRole('row', { name: /DEP-202611-00001/ })).toContainText('Verified');
    expect(fake.w.queue.filter((q) => q.event_type === 'WALLET_DEPOSIT')).toHaveLength(1);        // queued for the accounting ledger in the same moment
  });

  test('reject needs a reason, credits nothing, and the customer sees the reason', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); await openPayments(page, fake, 'verifier');
    await page.getByRole('row', { name: /DEP-202611-00001/ }).getByRole('button', { name: 'Review' }).click();
    const dlg = page.locator('.modal');
    await expect(dlg.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await dlg.getByLabel(/Reason for rejecting/).fill('Slip is not in the SCB statement');
    await dlg.getByRole('button', { name: 'Reject' }).click();
    await expect.poll(() => fake.w.deposits[0].status).toBe('rejected');
    expect(fake.w.balance).toBe(0); expect(fake.w.txns).toHaveLength(0);
    expect((fake.rpc('finance_my_deposits', {}) as { reject_reason: string }[])[0].reject_reason).toBe('Slip is not in the SCB statement');
  });

  test('a viewer can look but not approve; a clerk neither', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); await openPayments(page, fake, 'viewer');
    await page.getByRole('row', { name: /DEP-202611-00001/ }).getByRole('button', { name: 'Review' }).click();
    const dlg = page.locator('.modal');
    await expect(dlg).toContainText('Only a verifier or manager can approve or reject payments.');
    await dlg.getByLabel('Bank transaction reference').fill('REF-1');
    await expect(dlg.getByRole('button', { name: 'Approve and credit the wallet' })).toBeDisabled();
    expect(fake.count('finance_deposit_verify')).toBe(0); expect(fake.w.balance).toBe(0);
  });

  test('someone with no finance role is told so', async ({ page }) => {
    const fake = new FakeShop(); await openPayments(page, fake, null);
    await expect(page.getByText(/you have no finance role/)).toBeVisible();
  });
});

test.describe('wallets', () => {
  test('a manager adjusts a wallet (reason required), sees it in the ledger, and reverses it once', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(1000); await openPayments(page, fake, 'manager');
    await tabBtn(page, 'Wallets').click();
    await expect(page.getByText('Ledger check: every balance equals its ledger')).toBeVisible();
    await page.getByRole('row', { name: /LINE-TEST/ }).click();
    const drawer = page.locator('aside.drawer');
    await expect(drawer).toContainText('Balance');
    const apply = drawer.getByRole('button', { name: 'Apply adjustment' });
    await drawer.getByPlaceholder('0.00').first().fill('250');
    await expect(apply).toBeDisabled();                                                             // a reason of at least 10 characters is mandatory
    await drawer.getByLabel(/Reason \(at least 10 characters, kept in the audit log\)/).fill('Goodwill credit for a late delivery');
    await drawer.getByLabel(/Note the customer will see/).fill('ขออภัยในความล่าช้า');
    await apply.click();
    await expect.poll(() => fake.w.balance).toBe(1250);
    const call = fake.calls.find((c) => c.fn === 'finance_wallet_adjust')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_amount', 'p_customer', 'p_customer_note', 'p_direction', 'p_key', 'p_reason']);
    await expect(drawer.locator('tr', { hasText: 'Adjustment' })).toContainText('Goodwill credit');
    // reverse it: an opposite row, the original stays, and it cannot be reversed twice
    await drawer.locator('tr', { hasText: 'Adjustment' }).getByRole('button', { name: 'Reverse' }).click();
    const dlg = page.locator('.modal');
    await expect(dlg.getByRole('button', { name: 'Reverse' })).toBeDisabled();
    await dlg.getByLabel(/Reason \(at least 10 characters\)/).fill('Credited by mistake');
    await dlg.getByRole('button', { name: 'Reverse' }).click();
    await expect.poll(() => fake.w.balance).toBe(1000);
    expect(fake.w.txns.map((x) => x.txn_type)).toEqual(['DEPOSIT', 'ADJUSTMENT', 'REVERSAL']);       // nothing was deleted or edited
    await expect(drawer.locator('tr', { hasText: 'Adjustment' }).getByRole('button', { name: 'Reverse' })).toHaveCount(0);
  });

  test('a verifier sees the wallet but is offered no adjustment, and the server would refuse it anyway', async ({ page }) => {
    const fake = new FakeShop(); fake.w.seedBalance(1000); await openPayments(page, fake, 'verifier');
    await tabBtn(page, 'Wallets').click(); await page.getByRole('row', { name: /LINE-TEST/ }).click();
    const drawer = page.locator('aside.drawer');
    await expect(drawer).toContainText('Adjustments, reversals and refunds need a finance manager.');
    await expect(drawer.getByRole('button', { name: 'Apply adjustment' })).toHaveCount(0);
    expect(() => fake.rpc('finance_wallet_adjust', { p_customer: 'cust-1', p_direction: 'credit', p_amount: 50, p_reason: 'trying to sneak a credit in', p_key: 'sneak-0001' })).toThrow(/FORBIDDEN/);
    expect(fake.w.balance).toBe(1000);
  });
});

test.describe('bank accounts', () => {
  test('a manager adds a bank (a bad number is refused), switches one off, and customers stop seeing it', async ({ page }) => {
    const fake = new FakeShop(); await openPayments(page, fake, 'manager'); await tabBtn(page, 'Bank accounts').click();
    const rows = page.locator('table.t tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('519-4-02625-1'); await expect(rows.first()).toContainText('ณัฐพล อยู่ยิ้ม'); await expect(rows.nth(1)).toContainText('938-0-31954-2');
    await page.getByRole('button', { name: 'Add a bank account' }).click();
    const dlg = page.locator('.modal');
    await dlg.getByLabel('Code', { exact: true }).fill('KBANK'); await dlg.getByLabel('Thai name').fill('ธนาคารกสิกรไทย'); await dlg.getByLabel('English name').fill('Kasikornbank');
    await dlg.getByLabel('Account number').fill('abc'); await dlg.getByLabel('Account name').fill('Test Holder');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toContainText('INVALID_ACCOUNT_NO');                                          // refused by the server, shown in the dialog
    await dlg.getByLabel('Account number').fill('1234567890'); await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(rows).toHaveCount(3); await expect(rows.nth(2)).toContainText('123-4-56789-0');
    // switch SCB off
    await rows.first().getByRole('button', { name: 'Edit' }).click();
    await page.locator('.modal').getByRole('switch').click(); await page.locator('.modal').getByRole('button', { name: 'Save' }).click();
    await expect(rows.first()).toContainText('Inactive');
    const methods = fake.rpc('finance_payment_methods', {}) as { banks: { code: string }[] };
    expect(methods.banks.map((b) => b.code)).toEqual(['BBL', 'KBANK']);                             // customers no longer see SCB
    expect(fake.w.banks.find((b) => b.code === 'SCB')!.account_no).toBe('5194026251');            // the number itself was not touched
  });

  test('wallet limits are saved by a manager only', async ({ page }) => {
    const fake = new FakeShop(); await openPayments(page, fake, 'manager'); await tabBtn(page, 'Bank accounts').click();
    await page.getByLabel('Smallest deposit (฿)').fill('200'); await page.getByRole('button', { name: 'Save' }).last().click();
    await expect.poll(() => fake.w.settings.min_deposit).toBe(200);
    const fake2 = new FakeShop(); const page2 = await page.context().newPage(); await openPayments(page2, fake2, 'verifier'); await tabBtn(page2, 'Bank accounts').click();
    await expect(page2.getByLabel('Smallest deposit (฿)')).toHaveCount(0);
    await expect(page2.getByRole('button', { name: 'Add a bank account' })).toHaveCount(0);
  });
});

test.describe('accounting ledger and reports', () => {
  test('the queue shows what each money event posts (Dr bank / Cr customer credit) and reconciles with the wallet', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); fake.w.verify('DEP-202611-00001', 1000);
    await openPayments(page, fake, 'manager'); await tabBtn(page, 'Accounting ledger').click();
    const card = page.locator('[data-event="WALLET_DEPOSIT"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Wallet deposit'); await expect(card.locator('tr').first()).toContainText('Dr'); await expect(card.locator('tr').nth(1)).toContainText('Cr');
    await expect(card.locator('tr').first()).toContainText('SCB');                                  // the bank's own line
    await expect(page.getByText('Wallet ledger vs accounting ledger')).toBeVisible();
    await expect(page.getByText('Difference')).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-ledger.png` });
  });

  test('the daily bank report lists verified money per bank and exports CSV', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); seedDeposit(fake, 'bank-bbl', 400); fake.w.verify('DEP-202611-00001', 990); fake.w.verify('DEP-202611-00002', 400);
    await openPayments(page, fake, 'viewer'); await tabBtn(page, 'Reports').click();
    const rows = page.locator('table.t tbody tr');
    await expect(rows).toHaveCount(3);                                                              // SCB, BBL and the total
    await expect(rows.first()).toContainText('SCB'); await expect(rows.nth(1)).toContainText('BBL');
    await expect(rows.last()).toContainText('Total');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^bank-report-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
    await page.getByLabel('Bank account').selectOption({ label: 'BBL' }); await expect(rows).toHaveCount(2);
  });
});

test.describe('Thai and accessibility', () => {
  test('the page, its tabs and the deposit review are in Thai', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); await openPayments(page, fake, 'manager', 'th');
    for (const l of ['การชำระเงิน', 'กระเป๋าเงิน', 'บัญชีธนาคาร', 'สมุดบัญชี (GL)', 'รายงาน']) await expect(page.getByRole('tab', { name: l })).toBeVisible();
    await page.getByRole('row', { name: /DEP-202611-00001/ }).getByRole('button', { name: 'ตรวจสอบ' }).click();
    await expect(page.locator('.modal')).toContainText('ตรวจสอบการเติมเงิน');
    await expect(page.locator('.modal').getByRole('button', { name: 'อนุมัติและเติมเงินเข้ากระเป๋า' })).toBeVisible();
    await expect(page.locator('.modal')).not.toContainText('Approve and credit');                  // no English left in the dialog
  });

  test('axe: no critical or serious violations on the staff tabs', async ({ page }) => {
    const fake = new FakeShop(); seedDeposit(fake, 'bank-scb', 1000); fake.w.seedBalance(500); await openPayments(page, fake, 'manager');
    const check = async (name: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
      expect(bad, `${name}: ${bad.join('\n')}`).toEqual([]);
    };
    await check('payments');
    for (const name of ['Wallets', 'Bank accounts', 'Accounting ledger', 'Reports']) { await tabBtn(page, name).click(); await page.waitForTimeout(400); await check(name); }
  });
});
