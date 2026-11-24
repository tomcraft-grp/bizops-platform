// FB-001004: an error alert says what the problem is in Thai AND in English, on toasts and on the red boxes inside a page (staff screens).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import { FakeFeedback } from './fakeFeedback';

test.use({ viewport: { width: 1440, height: 900 } });

async function staff(page: Page, lang: 'en' | 'th', path: string) {
  const fake = new FakeShop(); fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff'; fake.w.role = 'manager'; fake.rv.seed();
  await fake.install(page); await page.clock.setFixedTime(new Date(fake.rv.clockIso));
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  return { fake, go: () => page.goto(`/#${path}`) };
}
const refuse = (page: Page, fn: string, message: string) => page.route(`**/rest/v1/rpc/${fn}`, (r) => (r.request().method() === 'OPTIONS' ? r.fallback()
  : r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message }) })));
const toast = (page: Page) => page.locator('.toast.error').first();
/** record ฿100 in cash on INV-000102 from Payment review (the page the feedback was sent from) */
async function recordCash(page: Page, th: boolean) {
  await page.locator('table.t tbody tr', { hasText: 'INV-000102' }).getByRole('button').last().click();
  const d = page.locator('.modal').last(); await d.getByRole('button', { name: th ? 'บันทึกการชำระเงิน' : 'Record payment' }).click();
  const f = page.locator('.modal').last(); await f.getByRole('combobox').first().selectOption('cash');
  await f.getByLabel(th ? /จำนวนเงิน/ : 'Amount (฿)').first().fill('100'); await f.getByLabel(th ? /หมายเหตุ/ : 'Note').first().fill('Cash at the counter');
  await f.getByRole('button', { name: th ? 'บันทึกการชำระเงิน' : 'Record payment' }).click();
}

for (const lang of ['th', 'en'] as const) {
  test(`Payment review (${lang}): the toast has the UI language on the first line and the other language under it`, async ({ page }) => {
    const { go } = await staff(page, lang, '/payment-review'); await refuse(page, 'finance_record_payment', 'CUSTOMER_MISMATCH: the payment\'s customer is not the invoice\'s customer'); await go();
    await recordCash(page, lang === 'th');
    const main = toast(page).locator('.err-main'); const other = toast(page).locator('.err-other');
    await expect(lang === 'th' ? main : other).toHaveText('ลูกค้าของการชำระไม่ตรงกับลูกค้าในใบแจ้งหนี้');
    await expect(lang === 'th' ? other : main).toContainText("the payment's customer is not the invoice's customer");
    await expect(toast(page)).toHaveAttribute('role', 'alert');
    const r = await new AxeBuilder({ page }).include('.toasts').withTags(['wcag2a', 'wcag2aa']).analyze(); expect(r.violations.map((v) => v.id)).toEqual([]);
    await toast(page).getByRole('button', { name: lang === 'th' ? 'ปิดข้อความ' : 'Dismiss message' }).click(); await expect(page.locator('.toast.error')).toHaveCount(0);
  });
}

test('a reason nobody has translated still says in Thai that the action failed, and shows the system\'s own text', async ({ page }) => {
  const { go } = await staff(page, 'th', '/payment-review'); await refuse(page, 'finance_record_payment', 'zzz unexpected wording'); await go(); await recordCash(page, true);
  await expect(toast(page).locator('.err-main')).toContainText('ไม่สำเร็จ'); await expect(toast(page)).toContainText('zzz unexpected wording');
});

test('a red box inside a page has both languages too', async ({ page }) => {
  const { go } = await staff(page, 'th', '/shop-admin'); await refuse(page, 'shop_admin_orders', 'statement timeout: canceling statement due to statement timeout'); await go();
  const box = page.locator('.banner.bad').first();
  await expect(box.locator('.err-main')).toContainText('ฐานข้อมูลใช้เวลานานเกินไป'); await expect(box.locator('.err-other')).toContainText('statement timeout');
});

test('a red box with a lead-in sentence (Feedback & issues) explains the reason in both languages', async ({ page }) => {
  const { fake, go } = await staff(page, 'th', '/feedback'); await new FakeFeedback(fake).install(page);
  await page.route(/rest\/v1\/bizops_feedback_issues/, (r) => (r.request().method() === 'OPTIONS' ? r.fallback() : r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ message: 'permission denied for table bizops_feedback_issues' }) })));
  await go(); const box = page.locator('.banner.bad').first();
  await expect(box).toContainText('คุณไม่มีสิทธิ์ทำรายการนี้', { timeout: 20_000 }); await expect(box).toContainText('permission denied');
});

test('the customer app is left as it is: one language, no system wording added', async ({ page }) => {
  const fake = new FakeShop(); await fake.install(page); await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'th'); } catch { /* ignore */ } });
  await page.route('**/rest/v1/rpc/shop_home', (r) => (r.request().method() === 'OPTIONS' ? r.fallback() : r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) })));
  await page.goto('/#/app'); await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.err-other')).toHaveCount(0); await expect(page.getByText(/ระบบแจ้งเหตุผลเป็นภาษาอังกฤษ/)).toHaveCount(0);
});
