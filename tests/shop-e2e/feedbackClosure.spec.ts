// Feedback closure workflow in the back office (Feedback & Issue Management), in a real Chrome against the FAKE backend (fakeBackend.ts + fakeFeedback.ts).
// The fake mirrors feedback_staff_update + the closure trigger that supabase/tests/feedback_closure.sql proves against the real database (20/20, rolled back).
// THIS file proves the screens: resolve needs a written resolution, the reporter-visible texts are shown before they are sent, closing takes an optional note,
// the closure summary shows who/when, and the overdue filter. It proves nothing about the database itself.
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import { FakeFeedback, installFakeTranslator } from './fakeFeedback';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

async function boot(page: Page, lang: 'en' | 'th' = 'en') {
  const shop = new FakeShop();
  shop.profile.role = 'SUPER_ADMIN'; shop.profile.display_name = 'Nok Support';
  const fb = new FakeFeedback(shop);
  await shop.install(page); await fb.install(page);
  await installFakeTranslator(page, { state: null });
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { shop, fb, errors };
}
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

test('resolve needs a written resolution; resolve then close with a note; the summary shows who and when', async ({ page }) => {
  const { fb, errors } = await boot(page);
  const issue = fb.seedLegacy({ title: 'Cannot redeem points', status: 'in_progress', source: 'customer', app_id: 'line-liff', submitter_label: 'Somchai' });
  await page.goto('/#/feedback');
  await page.getByRole('row', { name: /Cannot redeem points/ }).click();
  const drawer = page.locator('aside.drawer');
  const summary = drawer.locator('.card', { has: page.getByRole('heading', { name: 'Resolution & closure' }) });
  await expect(summary).toBeVisible();
  await expect(summary.getByRole('button', { name: 'Close issue' })).toHaveCount(0);          // closing is only offered once resolved

  // 1) no resolution written: refused in the screen, nothing sent
  await summary.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.getByText(/Write the resolution first/)).toBeVisible();
  expect(fb.count('feedback_staff_update')).toBe(0);

  // 2) with a resolution: the dialog shows exactly what the reporter will read
  await drawer.getByRole('textbox', { name: 'Resolution' }).fill('Fixed the redeem button in build 0.1.1');
  await summary.getByRole('button', { name: 'Mark resolved' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('Fixed the redeem button in build 0.1.1');
  await modal.getByRole('button', { name: 'Change status' }).click();
  await expect.poll(() => fb.issue(issue.id)!.status).toBe('resolved');
  await expect(summary).toContainText('Nok Support');                                          // resolved by
  await expect(drawer.locator('.badge', { hasText: 'Resolved' }).first()).toBeVisible();

  // 3) close with an optional note (shown to the reporter)
  await summary.getByRole('button', { name: 'Close issue' }).click();
  await expect(modal).toContainText('Closing officially completes the issue');
  await modal.getByRole('textbox', { name: /Closing note/ }).fill('Confirmed working with the customer');
  await modal.getByRole('button', { name: 'Change status' }).click();
  await expect.poll(() => fb.issue(issue.id)!.status).toBe('closed');
  const last = fb.rpcCalls.filter((c) => c.fn === 'feedback_staff_update').at(-1)!.args;
  expect(last).toMatchObject({ p_issue: issue.id, p_status: 'closed', p_reason: 'Confirmed working with the customer' });
  await expect(summary).toContainText('Closing note');
  await expect(summary).toContainText('Confirmed working with the customer');
  await expect(summary.getByRole('button', { name: 'Close issue' })).toHaveCount(0);
  // the visible history the reporter reads has the whole path
  expect(fb.events.filter((e) => e.issue_id === issue.id && e.kind === 'status').map((e) => e.to_value)).toEqual(['resolved', 'closed']);
  expect(errors).toEqual([]);
});

test('closing works without a note too (the note is optional)', async ({ page }) => {
  const { fb } = await boot(page);
  const issue = fb.seedLegacy({ title: 'Typo on receipt', status: 'resolved', resolution: 'Corrected the wording' });
  await page.goto('/#/feedback');
  await page.getByRole('combobox', { name: 'Status' }).first().selectOption('');               // all statuses (resolved is not "open")
  await page.getByRole('row', { name: /Typo on receipt/ }).click();
  await page.locator('aside.drawer').getByRole('button', { name: 'Close issue' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Change status' }).click();
  await expect.poll(() => fb.issue(issue.id)!.status).toBe('closed');
  expect(fb.issue(issue.id)!.closed_by_label).toBe('Nok Support');
});

test('overdue: counted in the KPI, flagged in the list, and filterable (waiting-for-information never counts)', async ({ page }) => {
  const { fb } = await boot(page);
  fb.seedLegacy({ title: 'Critical old one', priority: 'critical', status: 'submitted', created_at: daysAgo(3) });
  fb.seedLegacy({ title: 'Low recent one', priority: 'low', status: 'submitted', created_at: daysAgo(3) });
  fb.seedLegacy({ title: 'Waiting on reporter', priority: 'critical', status: 'waiting_info', created_at: daysAgo(30) });
  await page.goto('/#/feedback');
  await expect(page.locator('.kpi', { hasText: 'Overdue (open)' })).toContainText('1');
  await expect(page.getByRole('row', { name: /Critical old one/ })).toContainText('Overdue');
  await page.getByRole('combobox', { name: 'Status' }).first().selectOption('overdue');
  await expect(page.getByRole('row', { name: /Critical old one/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Low recent one/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Waiting on reporter/ })).toHaveCount(0);
});

test('Thai: the closure card and its buttons are in Thai', async ({ page }) => {
  const { fb } = await boot(page, 'th');
  fb.seedLegacy({ title: 'ปุ่มแลกแต้มกดไม่ได้', status: 'in_progress' });
  await page.goto('/#/feedback');
  await page.getByRole('row', { name: /ปุ่มแลกแต้มกดไม่ได้/ }).click();
  const drawer = page.locator('aside.drawer');
  await expect(drawer.getByRole('heading', { name: 'การแก้ไขและการปิดเรื่อง' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'ทำเครื่องหมายว่าแก้ไขแล้ว' })).toBeVisible();
});
