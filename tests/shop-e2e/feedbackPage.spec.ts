// Feedback & Issue Management (back office), the page itself, in a real Chrome against the FAKE feedback backend (fakeBackend.ts + fakeFeedback.ts; nothing here
// reaches the real Supabase project). The fake mirrors the contracts that supabase/tests/feedback_permissions.sql proves for real; this file proves the SCREEN:
//   - the notification of an ARCHIVED issue opens that issue (it used to leave the drawer spinning for ever), and one that cannot be opened says so
//   - the floating Feedback button never covers the paging buttons at the end of the table (it did: "Next page" could not be pressed)
//   - an issue assigned to somebody who is no longer in the staff list still shows who it was assigned to (the name stored with the issue)
//   - on a phone the issue number does not break after "FB-" and the table keeps its width for what matters
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop, USER_ID } from './fakeBackend';
import { FakeFeedback } from './fakeFeedback';

async function boot(page: Page, setup?: (fb: FakeFeedback) => void) {
  const shop = new FakeShop();
  shop.profile.role = 'SUPER_ADMIN'; shop.profile.display_name = 'Staff';
  const fb = new FakeFeedback(shop);
  await shop.install(page); await fb.install(page);
  fb.staffList.push({ id: USER_ID, display_name: 'Staff', email: 'staff@example.com', role: 'SUPER_ADMIN' });
  setup?.(fb);
  await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#/feedback');
  await expect(page.getByTestId('feedback-cards').getByRole('button').first()).toBeVisible({ timeout: 30_000 });
  return { shop, fb, errors };
}
const drawer = (p: Page) => p.locator('.drawer, [role="dialog"]').first();
const bell = (p: Page) => p.getByRole('button', { name: /Notifications/ }).last();
const now = () => new Date().toISOString();

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  test.beforeEach(() => test.setTimeout(120_000));

  test('the notification of an archived issue opens that issue; one that cannot be opened says so (no endless spinner)', async ({ page }) => {
    let archived = '';
    const { errors } = await boot(page, (fb) => {
      archived = fb.seedLegacy({ title: 'An archived report', archived_at: now() }).id;
      fb.seedLegacy({ title: 'A live report' });
      fb.notes.push(
        { id: 'n1', issue_id: archived, kind: 'new_issue', title: 'New feedback', body: 'An archived report', read_at: null, created_at: now() },
        { id: 'n2', issue_id: 'FB-009999', kind: 'new_issue', title: 'New feedback', body: 'Gone', read_at: null, created_at: now() },
      );
    });
    await expect(page.getByTestId('feedback-showing')).toContainText('1 of 1');            // the list does not show the archived one
    await bell(page).click();
    await page.locator('.popover .menu-item', { hasText: archived }).click();
    await expect(drawer(page)).toContainText('An archived report');
    await expect(drawer(page)).toContainText('This issue is archived');
    await expect(drawer(page).locator('.spinner')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await bell(page).click();
    await page.locator('.popover .menu-item', { hasText: 'FB-009999' }).click();
    await expect(drawer(page)).toContainText('This issue could not be opened');
    await expect(drawer(page).locator('.spinner')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the floating Feedback button does not cover the paging buttons: Next page really goes to page 2', async ({ page }) => {
    await boot(page, (fb) => { for (let i = 0; i < 17; i++) fb.seedLegacy({ title: `Report ${i + 1}` }); });
    await expect(page.locator('table tbody tr')).toHaveCount(15);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const fab = (await page.locator('.feedback-fab').boundingBox())!;
    const next = (await page.getByRole('button', { name: 'Next page' }).boundingBox())!;
    const overlap = next.x < fab.x + fab.width && next.x + next.width > fab.x && next.y < fab.y + fab.height && next.y + next.height > fab.y;
    expect(overlap, `Next page ${JSON.stringify(next)} / Feedback button ${JSON.stringify(fab)}`).toBe(false);
    await page.getByRole('button', { name: 'Next page' }).click();                         // a real mouse click at its position
    await expect(page.locator('.modal')).toHaveCount(0);                                   // it did not open the Feedback form instead
    await expect(page.locator('table tbody tr')).toHaveCount(2);
  });

  test('an issue assigned to somebody who is no longer in the staff list still shows who it was assigned to', async ({ page }) => {
    let id = '';
    await boot(page, (fb) => {
      id = fb.seedLegacy({ title: 'Handled by a former colleague', assigned_to: '99999999-9999-4999-8999-999999999999', handler_label: 'Somchai' }).id;
      fb.seedLegacy({ title: 'Handled by me', assigned_to: USER_ID, handler_label: 'Staff' });
    });
    const row = page.locator('table tbody tr', { hasText: id });
    await expect(row).toContainText('Somchai');                                            // not a dash
    await row.click();
    const dlg = drawer(page);
    await expect(dlg).toContainText('Handled by');
    await expect(dlg.getByText('Somchai').first()).toBeVisible();
    await expect(dlg.getByLabel('Assigned to')).toHaveValue('99999999-9999-4999-8999-999999999999');
    await expect(dlg.locator('select option:checked').filter({ hasText: 'Somchai (no longer active)' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    // the export keeps the name too
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export to Excel/ }).click()]);
    expect(readFileSync((await dl.path())!, 'utf8')).toContain('Somchai');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'en-US', hasTouch: true });
  test.beforeEach(() => test.setTimeout(120_000));

  test('the issue number stays in one piece, the page does not scroll sideways and the paging buttons can be tapped', async ({ page }) => {
    await boot(page, (fb) => { for (let i = 0; i < 17; i++) fb.seedLegacy({ title: `Report ${i + 1}`, priority: 'high', created_at: new Date(Date.now() - 20 * 86400_000).toISOString() }); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const id = (await page.locator('table tbody tr').first().locator('.mono').boundingBox())!;
    expect(id.height, 'FB-001001 on one line').toBeLessThan(24);
    await expect(page.getByRole('columnheader', { name: 'Last updated' })).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const fab = (await page.locator('.feedback-fab').boundingBox())!, next = (await page.getByRole('button', { name: 'Next page' }).boundingBox())!;
    expect(next.x < fab.x + fab.width && next.x + next.width > fab.x && next.y < fab.y + fab.height && next.y + next.height > fab.y).toBe(false);
    await page.getByRole('button', { name: 'Next page' }).tap();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('table tbody tr')).toHaveCount(2);
  });
});
