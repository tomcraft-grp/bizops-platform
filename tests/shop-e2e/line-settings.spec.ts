// Settings → LINE notifications against the fake backend (fakeBackend.ts + fakeLine.ts). Who may change what is enforced and tested for real by
// supabase/tests/line_notifications.sql; these tests prove a SUPER_ADMIN can configure LINE on the screen, credentials never come back, an ADMIN sees it read-only.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

async function openSettings(page: Page, fake: FakeShop, lang: 'en' | 'th' = 'en') {
  fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff';
  await fake.install(page);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: lang === 'en' ? 'LINE notifications' : 'แจ้งเตือนผ่าน LINE' })).toBeVisible();
}
const card = (page: Page) => page.locator('[data-line-settings]');

test('a SUPER_ADMIN saves the access token: the box is cleared and only "Configured" is shown', async ({ page }) => {
  const fake = new FakeShop(); await openSettings(page, fake);
  await card(page).getByLabel('Channel access token').fill('TESTTOKEN-line-0123456789-abcdefghij');
  await card(page).getByRole('button', { name: 'Save credentials' }).click();
  await expect.poll(() => fake.ln.token).toBe('TESTTOKEN-line-0123456789-abcdefghij');
  await expect(card(page).getByLabel('Channel access token')).toHaveValue('');
  await expect(card(page).locator('[data-cred="token"]')).toContainText('Configured');
  await expect(card(page)).not.toContainText('TESTTOKEN');
});

test('switching LINE on before a group is bound is refused with a sentence', async ({ page }) => {
  const fake = new FakeShop(); fake.ln.s.secret_set_at = fake.ln.s.token_set_at = '2026-11-22T07:00:00Z'; await openSettings(page, fake);
  await card(page).getByRole('switch', { name: 'LINE notifications on' }).click();
  await expect(page.locator('.toast').last()).toContainText('bind the admin group, before switching LINE on');
  expect(fake.ln.s.enabled).toBe(false);
});

test('Link my LINE shows a 6-digit code to send to the OA', async ({ page }) => {
  const fake = new FakeShop(); await openSettings(page, fake);
  await card(page).getByRole('button', { name: 'Link my LINE' }).click();
  await expect(card(page)).toContainText('123456');
});

test('quick approve, maximum and reasons are saved together', async ({ page }) => {
  const fake = new FakeShop(); await openSettings(page, fake);
  await card(page).getByRole('switch', { name: 'Allow "Accept + approve payment" on the card' }).click();
  await card(page).getByLabel('Maximum amount per order (baht)').fill('2500');
  await card(page).getByLabel('Reject reasons (one per line)').fill('สลิปไม่ถูกต้อง\nสินค้าหมด');
  await card(page).getByRole('button', { name: 'Save settings' }).click();
  await expect.poll(() => fake.ln.s.quick_approve_max_amount).toBe(2500);
  expect(fake.ln.s.quick_approve_enabled).toBe(true);
  expect(fake.ln.s.reject_reasons).toEqual(['สลิปไม่ถูกต้อง', 'สินค้าหมด']);
});

test('a bad maximum is not sent', async ({ page }) => {
  const fake = new FakeShop(); await openSettings(page, fake);
  await card(page).getByLabel('Maximum amount per order (baht)').fill('0');
  await card(page).getByRole('button', { name: 'Save settings' }).click();
  await expect(card(page)).toContainText('Enter an amount above 0 with at most 2 decimals.');
  expect(fake.calls.some((c) => c.fn === 'line_admin_save_settings')).toBe(false);
});

test('the delivery log lists a failed message with its error and "Send again" queues it', async ({ page }) => {
  const fake = new FakeShop();
  fake.ln.outbox = [{ id: 'ob-1', event: 'order_new', order_id: 'o1', order_no: 'ORD-20261122-0001', target_type: 'group', status: 'dead', attempts: 1,
    last_error: 'HTTP 401: Authentication failed', created_at: '2026-11-22T07:00:00Z', sent_at: null, next_attempt_at: '2026-11-22T07:00:00Z' }];
  await openSettings(page, fake);
  const row = card(page).locator('tr', { hasText: 'ORD-20261122-0001' });
  await expect(row).toContainText('HTTP 401: Authentication failed');
  await row.getByRole('button', { name: 'Send again' }).click();
  await expect.poll(() => fake.ln.outbox[0].status).toBe('queued');
  await expect(row).toContainText('queued');
});

test('Test connection shows the OA name', async ({ page }) => {
  const fake = new FakeShop(); await openSettings(page, fake);
  await card(page).getByRole('button', { name: 'Test connection' }).click();
  await expect(card(page)).toContainText('Connected to Tomcraft Shop');
});

test('an ADMIN sees the card read-only except My LINE', async ({ page }) => {
  const fake = new FakeShop(); fake.ln.canEdit = false; await openSettings(page, fake);
  await expect(card(page).getByLabel('Channel access token')).toBeDisabled();
  await expect(card(page).getByRole('button', { name: 'Save settings' })).toBeDisabled();
  await expect(card(page).getByRole('button', { name: 'Link my LINE' })).toBeEnabled();
});

test('a database without the LINE migration shows a notice, not an error', async ({ page }) => {
  const fake = new FakeShop(); fake.ln.enabled = false; await openSettings(page, fake);
  await expect(card(page)).toContainText('The LINE part of the database is not installed yet.');
});

test('Thai wording', async ({ page }) => {
  const fake = new FakeShop(); await openSettings(page, fake, 'th');
  await expect(card(page)).toContainText('เชื่อม LINE ของฉัน');
});

test('accessible, and no sideways scrolling on a phone', async ({ page }) => {
  const fake = new FakeShop(); await openSettings(page, fake);
  const r = await new AxeBuilder({ page }).include('[data-line-settings]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => v.id)).toEqual([]);
  await page.setViewportSize({ width: 360, height: 800 });
  const over = await card(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
});

// ---- several LINE accounts under one staff account (migration 20261128120000_line_multi_link.sql): a code never removes anybody else's link
test.describe('several LINE accounts', () => {
  const two = [
    { line_user_id: 'U-multi-aaaaaaaa01', display_name: 'Somsri', linked_at: '2026-11-28T01:00:00Z' },
    { line_user_id: 'U-multi-aaaaaaaa02', display_name: 'Malee', linked_at: '2026-11-28T01:05:00Z' },
  ];
  test('My LINE lists every linked LINE account, the code dialog names the staff account it links to, and the button offers to add another', async ({ page }) => {
    const fake = new FakeShop(); fake.ln.s.my_links = [...two]; await openSettings(page, fake);
    const mine = page.getByTestId('my-links');
    await expect(mine.locator('li')).toHaveCount(2); await expect(mine).toContainText('Somsri'); await expect(mine).toContainText('Malee');
    await expect(card(page)).toContainText('Signed in as Staff');
    await card(page).getByRole('button', { name: 'Add another LINE account' }).click();
    await expect(card(page)).toContainText('123456'); await expect(card(page)).toContainText('staff account Staff');
    await expect(card(page)).toContainText('A code never removes anybody else');
    await expect(card(page)).not.toContainText('\\');                                              // no stray backslash from the apostrophe
  });
  test('taking back one LINE account leaves the others', async ({ page }) => {
    const fake = new FakeShop(); fake.ln.s.my_links = [...two]; await openSettings(page, fake);
    await page.getByTestId('my-links').locator('li', { hasText: 'Somsri' }).getByRole('button', { name: 'Unlink' }).click();
    await expect.poll(() => fake.ln.unlinked).toEqual(['U-multi-aaaaaaaa01']);
    await expect(page.getByTestId('my-links').locator('li')).toHaveCount(1); await expect(page.getByTestId('my-links')).toContainText('Malee');
  });
  test('Linked staff (SUPER_ADMIN) shows one row per LINE account of the same staff account, each with its own Unlink', async ({ page }) => {
    const fake = new FakeShop();
    fake.ln.s.links = [
      { profile_id: 'p-1', name: 'AKE', email: 'ake@example.test', line_name: 'Somsri', linked_at: '2026-11-28T01:00:00Z', line_user_id: 'U-multi-aaaaaaaa01' },
      { profile_id: 'p-1', name: 'AKE', email: 'ake@example.test', line_name: 'Malee', linked_at: '2026-11-28T01:05:00Z', line_user_id: 'U-multi-aaaaaaaa02' },
      { profile_id: 'p-2', name: 'Oy', email: 'oy@example.test', line_name: 'Oy LINE', linked_at: '2026-11-28T01:10:00Z', line_user_id: 'U-multi-bbbbbbbb01' },
    ] as never;
    await openSettings(page, fake);
    const staff = card(page).locator('section', { has: page.getByRole('heading', { name: 'Linked staff' }) });
    await expect(staff.locator('li')).toHaveCount(3);
    await staff.locator('li', { hasText: 'Malee' }).getByRole('button', { name: 'Unlink' }).click();
    await expect.poll(() => fake.ln.unlinked).toEqual(['U-multi-aaaaaaaa02']);
    await expect(staff.locator('li')).toHaveCount(2); await expect(staff).toContainText('Somsri'); await expect(staff).toContainText('Oy LINE');
  });
  test('a database without the migration still works: one LINE account, the old Unlink', async ({ page }) => {
    const fake = new FakeShop(); fake.ln.multi = false; fake.ln.s.my_link = { display_name: 'Only one', linked_at: '2026-11-28T01:00:00Z' }; await openSettings(page, fake);
    await expect(page.getByTestId('my-links').locator('li')).toHaveCount(1); await expect(page.getByTestId('my-links')).toContainText('Only one');
    await card(page).getByRole('button', { name: 'Unlink' }).first().click();
    await expect(card(page)).toContainText('Your LINE is not linked'); expect(fake.ln.unlinked).toEqual([]);
  });
  test('the Thai text is complete', async ({ page }) => {
    const fake = new FakeShop(); fake.ln.s.my_links = [...two]; await openSettings(page, fake, 'th');
    await expect(card(page)).toContainText('เพิ่มบัญชี LINE อีกบัญชี'); await expect(card(page)).toContainText('ทุกบัญชี LINE ที่ผูกไว้');
    await card(page).getByRole('button', { name: 'เพิ่มบัญชี LINE อีกบัญชี' }).click();
    await expect(card(page)).toContainText('รหัสนี้ผูกบัญชี LINE กับบัญชีพนักงาน'); await expect(card(page)).toContainText('ไม่ลบการผูกของคนอื่น');
    const r = await new AxeBuilder({ page }).include('[data-line-settings]').analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
