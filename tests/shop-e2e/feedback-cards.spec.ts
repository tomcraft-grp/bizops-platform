// The summary cards of Feedback & Issue Management as filters, in a real Chrome against the fake backend. The rules themselves are in tests/unit/feedbackFilters.test.ts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import { FakeFeedback, installFakeTranslator } from './fakeFeedback';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const SHOTS = process.env.SHOP_SHOTS ?? 'test-results/shop';
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function boot(page: Page, o: { lang?: 'en' | 'th'; seed?: (fb: FakeFeedback) => void } = {}) {
  const shop = new FakeShop(); shop.profile.role = 'SUPER_ADMIN'; shop.profile.display_name = 'Nok Support';
  const fb = new FakeFeedback(shop); await shop.install(page); await fb.install(page); await installFakeTranslator(page, { state: null });
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, o.lang ?? 'en');
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  (o.seed ?? seed)(fb); await page.goto('/#/feedback'); await expect(cards(page).getByRole('button').first()).toContainText(String(fb.issues.length));
  return { fb, errors };
}
function seed(fb: FakeFeedback) {
  for (let i = 0; i < 20; i++) fb.seedLegacy({ title: `Fresh ${i}`, status: 'submitted', priority: i < 2 ? 'critical' : 'medium', category: i % 2 ? 'bug' : 'ui_ux', created_at: daysAgo(0.1) });
  fb.seedLegacy({ title: 'Late one', status: 'submitted', priority: 'high', created_at: daysAgo(9) });
  fb.seedLegacy({ title: 'Reviewing', status: 'under_review' }); fb.seedLegacy({ title: 'Accepted one', status: 'accepted' }); fb.seedLegacy({ title: 'Working on', status: 'in_progress' });
  fb.seedLegacy({ title: 'Asked back', status: 'waiting_info' }); fb.seedLegacy({ title: 'Fixed', status: 'resolved' }); fb.seedLegacy({ title: 'Over', status: 'closed' }); fb.seedLegacy({ title: 'No', status: 'rejected' });
}
const cards = (page: Page) => page.getByTestId('feedback-cards');
const card = (page: Page, name: string) => cards(page).getByRole('button', { name: new RegExp(`^${name.replace(/[()/]/g, '\\$&')}`) });
const rowsOf = (page: Page) => page.locator('table.t tbody tr');
const showing = (page: Page) => page.getByTestId('feedback-showing');
/** how many the list holds, over all pages */
const listed = async (page: Page) => { const pager = page.locator('.pager span').first(); return (await pager.count()) ? Number(/of (\d+)/.exec((await pager.textContent()) ?? '')?.[1]) : rowsOf(page).count(); };
const value = async (page: Page, name: string) => Number(await card(page, name).locator('.val').textContent());

test('every card lists exactly what it counts; the active one is marked; pressing it again, or Total, or the button, shows everything', async ({ page }) => {
  const { errors } = await boot(page);
  await expect(page.getByRole('combobox', { name: 'Status' }).first()).toHaveValue('open'); await expect(cards(page).locator('[aria-pressed="true"]')).toHaveCount(0);      // opens as before: the open issues
  for (const [name, want] of [['New (submitted)', 21], ['Under review', 1], ['In progress', 2], ['Waiting for information', 1], ['Resolved / closed', 2], ['Critical (open)', 2], ['Overdue (open)', 1], ['Total feedback', 28]] as const) {
    await card(page, name).click(); await expect(card(page, name)).toHaveAttribute('aria-pressed', 'true'); await expect(cards(page).locator('[aria-pressed="true"]')).toHaveCount(1);
    expect(await value(page, name), name).toBe(want); await expect.poll(() => listed(page), name).toBe(want); await expect(showing(page)).toContainText(`${want} of 28`);
  }
  await card(page, 'Overdue (open)').click(); await expect(rowsOf(page)).toHaveCount(1); await expect(rowsOf(page)).toContainText('Late one');
  await card(page, 'Overdue (open)').click(); await expect(card(page, 'Total feedback')).toHaveAttribute('aria-pressed', 'true'); expect(await listed(page)).toBe(28);
  await card(page, 'Resolved / closed').click(); await showing(page).getByRole('button', { name: 'Show all feedback' }).click(); expect(await listed(page)).toBe(28); await expect(showing(page).getByRole('button')).toHaveCount(0); expect(errors).toEqual([]);
});

test('the cards and the Status box are one filter; the other filters and the search count on the cards too', async ({ page }) => {
  await boot(page); const status = page.getByRole('combobox', { name: 'Status' }).first();
  await card(page, 'In progress').click(); await expect(status).toHaveValue('in_work'); await status.selectOption('overdue'); await expect(card(page, 'Overdue (open)')).toHaveAttribute('aria-pressed', 'true');
  await status.selectOption('rejected'); await expect(cards(page).locator('[aria-pressed="true"]')).toHaveCount(0); await expect(rowsOf(page)).toHaveCount(1); await expect(showing(page)).toContainText('Rejected');
  await card(page, 'New (submitted)').click(); await page.getByRole('combobox', { name: 'Category' }).first().selectOption('ui_ux'); expect(await value(page, 'New (submitted)')).toBe(10); await expect(rowsOf(page)).toHaveCount(10);
  await page.getByPlaceholder(/Search/).last().fill('fresh 1'); await expect.poll(() => value(page, 'New (submitted)')).toBe(await rowsOf(page).count()); await expect(showing(page)).toContainText('with the other filters below');
  await card(page, 'Waiting for information').click(); expect(await value(page, 'Waiting for information')).toBe(0); await expect(page.getByText('No issues match')).toBeVisible();
  await showing(page).getByRole('button', { name: 'Show all feedback' }).click(); expect(await listed(page)).toBe(28); await expect(page.getByPlaceholder(/Search/).last()).toHaveValue('');
});

test('a new filter starts on page 1, also when both lists are equally long; a refresh of the data keeps the page and the filter', async ({ page }) => {
  const { fb } = await boot(page, { seed: (f) => { for (let i = 0; i < 20; i++) f.seedLegacy({ title: `S ${i}`, status: 'submitted' }); for (let i = 0; i < 20; i++) f.seedLegacy({ title: `R ${i}`, status: 'resolved' }); } });
  await card(page, 'New (submitted)').click(); await page.getByRole('button', { name: 'Next page' }).click(); await expect(page.locator('.pager')).toContainText('2 / 2');
  fb.seedLegacy({ title: 'Just in', status: 'submitted' }); await page.getByRole('button', { name: 'Refresh' }).click(); await expect(card(page, 'New (submitted)').locator('.val')).toHaveText('21'); await expect(page.locator('.pager')).toContainText('2 / 2'); await expect(card(page, 'New (submitted)')).toHaveAttribute('aria-pressed', 'true');
  fb.issues = fb.issues.filter((i) => i.title !== 'Just in'); await page.getByRole('button', { name: 'Refresh' }).click(); await expect(card(page, 'New (submitted)').locator('.val')).toHaveText('20');
  await card(page, 'Resolved / closed').click(); await expect(page.locator('.pager')).toContainText('1 / 2'); await expect(rowsOf(page).first()).toContainText('R ');
});

test('changing an issue moves it: the counts and the list follow at once, and the open drawer stays', async ({ page }) => {
  const { fb } = await boot(page); await card(page, 'Under review').click(); await page.getByRole('row', { name: /Reviewing/ }).click(); const drawer = page.locator('aside.drawer');
  await drawer.getByRole('button', { name: 'Start work (In progress)' }).click(); await expect.poll(() => fb.issues.find((i) => i.title === 'Reviewing')!.status).toBe('in_progress');
  await expect(card(page, 'Under review').locator('.val')).toHaveText('0'); await expect(card(page, 'In progress').locator('.val')).toHaveText('3'); await expect(drawer).toContainText('Reviewing');
});

test('loading and failure: no false zeros; the error is said and Refresh recovers', async ({ page }) => {
  const shop = new FakeShop(); shop.profile.role = 'SUPER_ADMIN'; const fb = new FakeFeedback(shop); await shop.install(page); await fb.install(page); await installFakeTranslator(page, { state: null }); seed(fb);
  await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
  const list = /rest\/v1\/bizops_feedback_issues/; await page.route(list, (r) => (r.request().method() === 'OPTIONS' ? r.fallback() : r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ message: 'database is down' }) })));
  await page.goto('/#/feedback'); await expect(page.getByText(/database is down/)).toBeVisible({ timeout: 20_000 }); await expect(card(page, 'Overdue (open)').locator('.val')).toHaveText('–');
  await page.unroute(list); await page.getByRole('button', { name: 'Refresh' }).click(); await expect(card(page, 'Total feedback').locator('.val')).toHaveText('28'); await expect(page.getByText(/database is down/)).toHaveCount(0);
});

test('keyboard, accessibility, equal heights, phone and tablet', async ({ page }) => {
  await boot(page, { lang: 'th' }); await cards(page).getByRole('button').nth(1).focus(); await page.keyboard.press('Enter'); await expect(cards(page).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true'); await page.keyboard.press('Space'); await expect(cards(page).getByRole('button').nth(0)).toHaveAttribute('aria-pressed', 'true');
  await cards(page).getByRole('button').nth(7).click(); await expect(showing(page)).toContainText('เกินกำหนด'); await expect(rowsOf(page)).toContainText('ส่งแล้ว'); await page.screenshot({ path: `${SHOTS}/feedback-cards-th.png` });
  const r = await new AxeBuilder({ page }).include('[data-testid="feedback-cards"]').include('[data-testid="feedback-showing"]').analyze(); expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  for (const [w, h] of [[1440, 900], [820, 1180], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
    const b = await cards(page).getByRole('button').evaluateAll((xs) => xs.map((x) => x.getBoundingClientRect()).map((q) => ({ y: Math.round(q.y), h: Math.round(q.height) })));
    expect(new Set(b.map((q) => q.h)).size, `${w}px: all cards equally high`).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${w}px`).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0)); await cards(page).getByRole('button').nth(0).click(); await expect(showing(page)).toBeInViewport(); await page.waitForTimeout(800); await page.screenshot({ path: `${SHOTS}/feedback-cards-phone-th.png` });
});
