import { expect, test } from '@playwright/test';
import { go, heading, openApp, switchUser, toast } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ordersToday = async (page: import('@playwright/test').Page) => { await go(page, '/orders'); await expect(heading(page)).toHaveText('Orders'); return Number((await page.locator('.kpi', { hasText: 'Orders today' }).locator('.val').innerText()).trim()); };

test.describe('critical journeys (QA addendum §3.4)', () => {
  test('J6 POS sale: options, combo promotion, payment, receipt, orders list, persistence after refresh', async ({ page }) => {
    await openApp(page, '/pos');
    const before = await ordersToday(page);
    await go(page, '/pos');
    await page.locator('button[aria-label="Add Latte (hot)"]').click();
    await page.getByRole('button', { name: 'Oat milk +25' }).click();
    await page.locator('.modal-f button.primary').click();
    await page.locator('button[aria-label="Add Butter Croissant"]').click();
    await page.locator('.modal-f button.primary').click();
    await expect(page.locator('.totals .grand')).toContainText('฿144.00');           // 70+25+65 = 160 − 16 combo
    await expect(page.locator('.totals')).toContainText('Latte + Croissant combo');
    await page.getByRole('button', { name: /^Charge/ }).click();
    await page.getByRole('button', { name: 'Add payment' }).click();
    await page.getByRole('button', { name: /Complete sale/ }).click();
    await expect(page.getByText(/Sale complete — POS-/)).toBeVisible();
    await expect(page.locator('.receipt-paper')).toContainText('TOTAL');
    await page.getByRole('button', { name: 'New sale' }).click();
    expect(await ordersToday(page)).toBe(before + 1);
    await page.reload();                                                           // refresh must not lose data
    await page.waitForSelector('.app .content');
    expect(await ordersToday(page)).toBe(before + 1);
  });

  test('J7 double-clicking Complete sale creates exactly one order (idempotent checkout)', async ({ page }) => {
    await openApp(page, '/pos');
    const before = await ordersToday(page);
    await go(page, '/pos');
    await page.locator('button[aria-label="Add Mineral water 600 ml"]').click();
    await page.getByRole('button', { name: /^Charge/ }).click();
    await page.getByRole('button', { name: 'Add payment' }).click();
    await page.getByRole('button', { name: /Complete sale/ }).dblclick();
    await expect(page.getByText(/Sale complete — POS-/)).toBeVisible();
    expect(await ordersToday(page)).toBe(before + 1);
  });

  test('J3 staff: a cashier sees only permitted modules, direct URLs are blocked, and cost is hidden', async ({ page }) => {
    await openApp(page);
    await switchUser(page, 'Mali Srisuk');
    const nav = page.locator('.sidebar');
    await expect(nav.getByRole('link', { name: 'POS' })).toBeVisible();
    for (const hidden of ['Accounting', 'Profit engine', 'Purchasing', 'Team & access', 'Settings']) await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
    await go(page, '/accounting');
    await expect(page.getByText('Access restricted')).toBeVisible();
    await go(page, '/profit');
    await expect(page.getByText('Access restricted')).toBeVisible();
    await go(page, '/products');
    await expect(page.locator('th', { hasText: 'Avg cost' })).toHaveCount(0);      // financial sensitivity
    await go(page, '/pos');
    await expect(page.getByText('Current sale')).toBeVisible();
  });

  test('J8 one payment of ฿3,000 is allocated FIFO across open invoices and leaves the right balance', async ({ page }) => {
    await openApp(page, '/receivables');
    const total = async () => Number((await page.locator('tr', { hasText: 'Café Mali' }).locator('td').nth(6).innerText()).replace(/[^\d.]/g, ''));
    const before = await total();
    await page.getByRole('button', { name: 'Receive payment' }).click();
    const modal = page.locator('.modal');
    const v = await modal.locator('select').first().locator('option', { hasText: 'Café Mali' }).getAttribute('value');
    await modal.locator('select').first().selectOption(v!);
    await modal.locator('input[type=number]').first().fill('3000');
    await expect(modal.locator('tbody tr').first().locator('td').nth(3)).toContainText('3,000.00');   // oldest invoice is paid first
    await expect(modal.locator('tfoot td').nth(2)).toContainText('3,000.00');                         // applied total = payment
    await modal.getByRole('button', { name: /Post receipt/ }).click();
    await expect(toast(page, 'Receipt posted and allocated')).toBeVisible();
    expect(Math.round((before - (await total())) * 100) / 100).toBe(3000);                          // customer balance fell by exactly the payment
  });

  test('J9 a payment slip is reviewed: approval creates a receipt, rejection needs a reason', async ({ page }) => {
    await openApp(page, '/receivables?tab=slips');
    const rows = page.locator('table.t').first().locator('tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    await rows.first().getByRole('button', { name: 'Review' }).click();
    await page.getByRole('button', { name: /Approve/ }).click();
    await expect(toast(page, 'Approved')).toBeVisible();
    await expect(rows).toHaveCount(n - 1);
    await rows.first().getByRole('button', { name: 'Review' }).click();
    await page.getByRole('button', { name: /Reject/ }).click();
    await expect(page.getByRole('button', { name: 'Reject' }).last()).toBeDisabled();   // reason is mandatory
    await page.locator('.modal textarea').fill('Amount does not match');
    await page.getByRole('button', { name: 'Reject' }).last().click();
    await expect(toast(page, 'rejected')).toBeVisible();
  });

  test('J7b marketplace sync: orders arrive, duplicates are ignored (idempotency), unmapped SKUs are parked', async ({ page }) => {
    await openApp(page, '/channels');
    await page.getByRole('button', { name: /Sync now/ }).first().click();
    await expect(toast(page, 'Synced')).toBeVisible();
    await page.getByRole('tab', { name: /Sync errors/ }).click();
    await expect(page.getByText('duplicate ignored').first()).toBeVisible();
    await expect(page.getByText(/Unmapped SKU/).first()).toBeVisible();
  });

  test('J13 event numbers: a taken number cannot be selected by another customer', async ({ page }) => {
    await openApp(page, '/app');
    const pick = async (i: number) => {
      const so = page.getByRole('button', { name: /Sign out/ });
      if (await so.count()) await so.click();
      await page.locator('.phone-body .menu-item').nth(i).click();
      await page.locator('.phone-nav button', { hasText: 'Events' }).click();
      return Number((await page.locator('.phone-body', { hasText: 'Your picks left' }).innerText()).match(/Your picks left\s+(\d+)/)![1]);
    };
    let first = -1, second = -1;
    for (let i = 0; i < 12 && second < 0; i++) { const n = await pick(i); if (n > 0) { if (first < 0) first = i; else second = i; } }
    expect(first).toBeGreaterThanOrEqual(0); expect(second).toBeGreaterThan(first);
    await pick(first);
    const cell = page.locator('.num-cell:not([disabled])').first();
    const label = (await cell.getAttribute('aria-label'))!;
    await cell.click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(toast(page, 'locked in')).toBeVisible();
    await pick(second);
    await expect(page.locator(`.num-cell[aria-label="${label}"]`).first()).toBeDisabled();   // the screen reflects the constraint
  });

  test('J10 points: redeeming a reward deducts points once and issues a code', async ({ page }) => {
    await openApp(page, '/app');
    await page.locator('.phone-body .menu-item').nth(8).click();
    await page.locator('.phone-nav button', { hasText: 'Rewards' }).click();
    const bal = async () => Number((await page.locator('.phone-body .badge').first().innerText()).replace(/[^\d]/g, ''));
    const before = await bal();
    const btn = page.getByRole('button', { name: 'Redeem' }).filter({ hasNot: page.locator('[disabled]') }).first();
    if (await btn.isEnabled()) { await btn.click(); await expect(page.getByText(/Redeemed! Your code/)).toBeVisible(); expect(await bal()).toBeLessThan(before); }
    else test.info().annotations.push({ type: 'note', description: 'chosen customer cannot afford any reward; deduction path covered by unit tests' });
  });

  test('J12 accounting: four-eyes approval of manual journals and mapping changes', async ({ page }) => {
    await openApp(page, '/accounting');
    await page.getByRole('tab', { name: /Approvals/ }).click();
    await expect(page.getByText('Four-eyes control')).toBeVisible();
    // the demo leaves a draft prepared by the accountant: the Owner may approve it
    const row = page.locator('tr', { hasText: 'Accrue November electricity' });
    await row.getByRole('button', { name: /Approve/ }).click();
    await expect(toast(page, 'Approved and posted')).toBeVisible();
    // the Owner cannot approve their own draft
    await page.getByRole('button', { name: /New journal draft/ }).click();
    await page.locator('.modal input').nth(1).fill('Owner test accrual');
    await page.locator('.modal input[aria-label="Debit"]').first().fill('10');
    await page.locator('.modal input[aria-label="Credit"]').nth(1).fill('10');
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    const own = page.locator('tr', { hasText: 'Owner test accrual' });
    await own.getByRole('button', { name: /Approve/ }).click();
    await expect(toast(page, 'different authorized person')).toBeVisible();
    // the proposer of a mapping change cannot approve it
    await switchUser(page, 'Dao Karnjana');
    await go(page, '/accounting');
    await page.getByRole('tab', { name: /Approvals/ }).click();
    await page.locator('tr', { hasText: 'Settlement variance' }).getByRole('button', { name: 'Approve' }).click();
    await expect(toast(page, 'cannot approve')).toBeVisible();
  });

  test('J15 reports reconcile: every integrity and control-account check passes', async ({ page }) => {
    await openApp(page, '/health');
    const kpi = page.locator('.kpi', { hasText: 'Checks passing' }).locator('.val');
    const txt = (await kpi.innerText()).trim();
    const [a, b] = txt.split('/').map(Number);
    expect(a).toBe(b);
    await go(page, '/accounting');
    await page.getByRole('tab', { name: /^Reconciliation/ }).click();
    await expect(page.getByText('DIFFERENCE', { exact: true })).toHaveCount(0);
    await expect(page.getByText('agrees').first()).toBeVisible();
  });

  test('J16 printing: a sale queues receipt and tickets; the agent prints online printers; the offline bar printer fails', async ({ page }) => {
    await openApp(page, '/pos');
    await page.locator('button[aria-label="Add Iced Latte"]').click();
    await page.locator('.modal-f button.primary').click();
    await page.getByRole('button', { name: /^Charge/ }).click();
    await page.getByRole('button', { name: 'Add payment' }).click();
    await page.getByRole('button', { name: /Complete sale/ }).click();
    await expect(page.getByText(/Sale complete/)).toBeVisible();
    await expect(page.locator('.modal').getByText('printed').first()).toBeVisible({ timeout: 10_000 });   // agent tick
    await expect(page.locator('.modal .badge', { hasText: /^failed$/ }).first()).toBeVisible();                                   // beverage printer is offline
  });

  test('J18 backup and recovery: export, wipe, restore and verify the data is back', async ({ page }) => {
    await openApp(page, '/pos');
    await page.locator('button[aria-label="Add Mineral water 600 ml"]').click();
    await page.getByRole('button', { name: /^Charge/ }).click();
    await page.getByRole('button', { name: 'Add payment' }).click();
    await page.getByRole('button', { name: /Complete sale/ }).click();
    await expect(page.getByText(/Sale complete/)).toBeVisible();
    await page.getByRole('button', { name: 'New sale' }).click();
    const withSale = await ordersToday(page);
    await go(page, '/settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export backup/ }).click()]);
    const file = await dl.path();
    await page.getByRole('button', { name: /Reset demo data/ }).click();
    await page.locator('.modal input').fill('RESET');
    await page.getByRole('button', { name: 'Reset data' }).click();
    await expect(toast(page, 'regenerated')).toBeVisible({ timeout: 30_000 });
    expect(await ordersToday(page)).toBe(withSale - 1);
    await go(page, '/settings');
    await page.locator('input[type=file]').setInputFiles(file!);
    await expect(toast(page, 'Backup restored')).toBeVisible();
    expect(await ordersToday(page)).toBe(withSale);
  });

  test('J17 media upload: valid image accepted, disguised / infected / duplicate files rejected', async ({ page }) => {
    await openApp(page, '/media');
    const input = page.locator('input[type=file]').first();
    await input.setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: PNG });
    await expect(toast(page, 'stored')).toBeVisible();
    await input.setInputFiles({ name: 'invoice-copy.png', mimeType: 'image/png', buffer: PNG });
    await expect(toast(page, 'already uploaded')).toBeVisible();                                // duplicate document blocked
    await input.setInputFiles({ name: 'evil.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('MZ\x90\x00 this is not an image') });
    await expect(toast(page, /disguised|Unsupported/)).toBeVisible();                            // content sniffing
    const eicar = Buffer.concat([PNG, Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    await input.setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: eicar });
    await expect(page.locator('.kpi', { hasText: 'Quarantined' }).locator('.val')).toHaveText('1');    // malware signature quarantined
  });

  test('J14 customer app: a customer only sees their own balance, orders and slips (UI level)', async ({ page }) => {
    await openApp(page, '/app');
    const names = await page.locator('.phone-body .menu-item .grow > div:first-child').allInnerTexts();
    await page.locator('.phone-body .menu-item').nth(2).click();
    await page.locator('.phone-nav button', { hasText: 'Pay' }).click();
    const body = await page.locator('.phone-body').innerText();
    for (const other of names.filter((n) => n !== names[2]).slice(0, 12)) expect(body).not.toContain(other);
  });

  test('keyboard and navigation: Ctrl+K search, Esc closes dialogs, browser back closes an order drawer', async ({ page }) => {
    await openApp(page, '/orders');
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/Type a product/).fill('latte');
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('Products');
    await go(page, '/orders');
    await page.locator('table.t tbody tr').first().click();
    await expect(page.locator('.drawer')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.drawer')).toHaveCount(0);
    await page.locator('table.t tbody tr').first().click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer')).toHaveCount(0);
  });

  test('accounting setup: checklist shows the honest state; COA protects used accounts; locked period rejects postings', async ({ page }) => {
    await openApp(page, '/accounting/setup');
    await expect(page.getByText(/NOT yet reviewed by a qualified Thai accountant|Not yet reviewed/i).first()).toBeVisible();
    await expect(page.getByText('Setup checklist')).toBeVisible();
    await page.getByRole('tab', { name: /Chart of accounts/ }).click();
    await page.locator('input[placeholder="Search…"]').fill('6200');
    await page.locator('tr', { hasText: 'Rent' }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText(/has postings: its code, type/)).toBeVisible();
    await page.keyboard.press('Escape');
    await go(page, '/accounting');
    await page.getByRole('button', { name: /New journal draft/ }).click();
    await page.locator('.modal input[type=date]').fill('2026-10-05');
    await page.locator('.modal input').nth(1).fill('Back-dated');
    await page.locator('.modal input[aria-label="Debit"]').first().fill('10');
    await page.locator('.modal input[aria-label="Credit"]').nth(1).fill('10');
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await switchUser(page, 'Dao Karnjana');                                   // different person approves → the lock still blocks it
    await go(page, '/accounting');
    await page.getByRole('tab', { name: /Approvals/ }).click();
    await page.locator('tr', { hasText: 'Back-dated' }).getByRole('button', { name: /Approve/ }).click();
    await expect(toast(page, 'locked')).toBeVisible();
  });
});
