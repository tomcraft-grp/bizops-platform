// Back office → LINE members: a SUPER_ADMIN gives or takes back back-office access (the ADMIN role) of a LINE member. Against the fake backend (fakeBackend.ts), which mirrors the refusals of
// supabase/migrations/20261128110000_backoffice_access.sql (tested for real by supabase/tests/backoffice_access.sql): this proves the SCREEN, not the database.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'th-TH' });

const member = (id: string, name: string, role: 'USER' | 'ADMIN' | 'SUPER_ADMIN' = 'USER', status: 'active' | 'disabled' = 'active') =>
  ({ id, display_name: name, phone: '0812345678', status, created_at: '2026-11-20T03:00:00Z', pdpa_consent_at: '2026-11-20T03:01:00Z', role });

function shop(role: 'SUPER_ADMIN' | 'ADMIN' = 'SUPER_ADMIN'): FakeShop {
  const f = new FakeShop(); f.profile.role = role; f.profile.display_name = 'Owner';
  f.members = [member('m-1', 'สมชาย ใจดี'), member('m-2', 'มาลี ดีมาก'), member('m-3', 'ปิดบัญชี คนหนึ่ง', 'USER', 'disabled'), member('m-4', 'ผู้จัดการ เดิม', 'ADMIN'), member(f.profile.id, 'Owner', role), member('m-5', 'เจ้าของ อีกคน', 'SUPER_ADMIN')];
  return f;
}
async function open(page: Page, fake: FakeShop) {
  await fake.install(page);
  await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'th'); } catch { /* ignore */ } });
  await page.goto('/#/members');
  await expect(page.getByRole('heading', { name: 'สมาชิก LINE' })).toBeVisible();
}
const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });

test('the table shows each person\'s access, and the count of people with back-office access', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  await expect(row(page, 'สมชาย ใจดี')).toContainText('ลูกค้า');
  await expect(row(page, 'ผู้จัดการ เดิม')).toContainText('หลังบ้าน (ADMIN)');
  await expect(row(page, 'เจ้าของ อีกคน')).toContainText('SUPER_ADMIN');
  await expect(page.getByText(/มีสิทธิ์หลังบ้าน 3/)).toBeVisible();
  await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/line-members-access.png` });                              // the admin, the owner (me) and the other owner
});

test('a SUPER_ADMIN gives access: a confirmation says what it means, the reason is optional, and the row changes', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  await row(page, 'สมชาย ใจดี').getByTestId('grant-access').click();
  const dlg = page.locator('div[role="dialog"]');
  await expect(dlg).toContainText('ให้สิทธิ์หลังบ้านแก่ สมชาย ใจดี'); await expect(dlg).toContainText('ระดับผู้จัดการ'); await expect(dlg).toContainText('ประวัติการสั่งซื้อและแต้มเดิมของเขายังอยู่');
  await dlg.locator('textarea').fill('ผู้จัดการร้านสาขาใหม่');
  await dlg.getByRole('button', { name: 'ให้สิทธิ์หลังบ้าน' }).click();
  await expect.poll(() => fake.accessCalls.length).toBe(1);
  expect(fake.accessCalls[0]).toMatchObject({ p_profile: 'm-1', p_grant: true, p_reason: 'ผู้จัดการร้านสาขาใหม่' });
  await expect(row(page, 'สมชาย ใจดี')).toContainText('หลังบ้าน (ADMIN)');
  await expect(row(page, 'สมชาย ใจดี').getByTestId('revoke-access')).toBeVisible();
  await expect(page.getByText(/ให้สิทธิ์แล้ว/)).toBeVisible();
});

test('the reason may stay empty (nothing is sent as a reason)', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  await row(page, 'มาลี ดีมาก').getByTestId('grant-access').click();
  await page.locator('div[role="dialog"]').getByRole('button', { name: 'ให้สิทธิ์หลังบ้าน' }).click();
  await expect.poll(() => fake.accessCalls.length).toBe(1);
  expect(fake.accessCalls[0].p_reason).toBeNull();
});

test('cancelling the confirmation changes nothing and calls nothing', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  await row(page, 'สมชาย ใจดี').getByTestId('grant-access').click();
  await page.locator('div[role="dialog"]').getByRole('button', { name: 'ยกเลิก' }).click();
  expect(fake.accessCalls).toHaveLength(0); await expect(row(page, 'สมชาย ใจดี')).toContainText('ลูกค้า');
});

test('taking access back asks first, says the member becomes a customer at once, and the row changes back', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  await row(page, 'ผู้จัดการ เดิม').getByTestId('revoke-access').click();
  const dlg = page.locator('div[role="dialog"]');
  await expect(dlg).toContainText('ถอนสิทธิ์หลังบ้านของ ผู้จัดการ เดิม'); await expect(dlg).toContainText('เข้าหลังบ้านไม่ได้ทันที');
  await dlg.getByRole('button', { name: 'ถอนสิทธิ์' }).click();
  await expect.poll(() => fake.accessCalls.length).toBe(1);
  expect(fake.accessCalls[0]).toMatchObject({ p_profile: 'm-4', p_grant: false });
  await expect(row(page, 'ผู้จัดการ เดิม')).toContainText('ลูกค้า'); await expect(row(page, 'ผู้จัดการ เดิม').getByTestId('grant-access')).toBeVisible();
});

test('the screen never offers what the database refuses: no button for a disabled member, yourself or another owner', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  await expect(row(page, 'ปิดบัญชี คนหนึ่ง').getByTestId('grant-access')).toHaveCount(0);
  await expect(row(page, 'Owner').getByTestId('grant-access')).toHaveCount(0); await expect(row(page, 'Owner').getByTestId('revoke-access')).toHaveCount(0);
  await expect(row(page, 'เจ้าของ อีกคน').getByTestId('grant-access')).toHaveCount(0); await expect(row(page, 'เจ้าของ อีกคน').getByTestId('revoke-access')).toHaveCount(0);
  await expect(page.getByTestId('grant-access')).toHaveCount(2);                                      // only the two active customers
});

test('an ADMIN sees who has access but gets no button at all', async ({ page }) => {
  const fake = shop('ADMIN'); await open(page, fake);
  await expect(row(page, 'ผู้จัดการ เดิม')).toContainText('หลังบ้าน (ADMIN)');
  await expect(page.getByTestId('grant-access')).toHaveCount(0); await expect(page.getByTestId('revoke-access')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ปิดบัญชี' })).toHaveCount(0);
});

test('a refusal from the database is shown in words, and the row stays as it was', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  fake.profile.role = 'ADMIN';                                                                         // the role changed in the database after the page was opened (the button was still on screen)
  await row(page, 'สมชาย ใจดี').getByTestId('grant-access').click();
  await page.locator('div[role="dialog"]').getByRole('button', { name: 'ให้สิทธิ์หลังบ้าน' }).click();
  await expect(page.getByText(/SUPER_ADMIN/).first()).toBeVisible(); await expect(row(page, 'สมชาย ใจดี')).toContainText('ลูกค้า');
});

test('a database without the migration says so instead of showing a raw error', async ({ page }) => {
  const fake = shop(); fake.noAccessFunction = true; await open(page, fake);
  await row(page, 'สมชาย ใจดี').getByTestId('grant-access').click();
  await page.locator('div[role="dialog"]').getByRole('button', { name: 'ให้สิทธิ์หลังบ้าน' }).click();
  await expect(page.getByText('ฐานข้อมูลส่วนให้สิทธิ์หลังบ้านยังไม่ได้ติดตั้ง')).toBeVisible();
  await expect(row(page, 'สมชาย ใจดี')).toContainText('ลูกค้า');
});

test('accessible, and the table fits a phone', async ({ page }) => {
  const fake = shop(); await open(page, fake);
  const r = await new AxeBuilder({ page }).include('main').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
