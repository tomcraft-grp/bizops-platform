import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { go, openApp } from './helpers';

// QA addendum §4.4 accessibility (automated axe-core: WCAG 2.x A/AA) and §4.3 visual regression on critical screens.
const PAGES = ['/', '/pos', '/orders', '/receivables', '/events', '/inventory', '/accounting', '/accounting/setup', '/profit', '/printing', '/blueprint'];
for (const theme of ['light', 'dark'] as const) {
  test(`axe: no critical or serious WCAG violations on key screens (${theme})`, async ({ page }) => {
    await openApp(page, '/');
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const report: string[] = [];
    for (const p of PAGES) {
      await go(page, p);
      await page.waitForTimeout(500);
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of r.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')) report.push(`${p} [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes) e.g. ${v.nodes[0].target.join(' ')}`);
    }
    expect(report, report.join('\n')).toEqual([]);
  });
}

test('axe: customer app (LIFF) has no critical or serious violations', async ({ page }) => {
  await openApp(page, '/app');
  await page.locator('.phone-body .menu-item').nth(3).click();
  await page.waitForTimeout(300);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious').map((v) => `${v.id}: ${v.nodes[0].target.join(' ')}`);
  expect(bad, bad.join('\n')).toEqual([]);
});

test('forms have visible labels and interactive controls have accessible names', async ({ page }) => {
  await openApp(page, '/');
  const bad: string[] = [];
  for (const p of ['/pos', '/orders', '/receivables', '/accounting', '/accounting/setup', '/customers']) {
    await go(page, p);
    await page.waitForTimeout(300);
    const found = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll('button, a[href], input, select, textarea'))) {
        const rc = el.getBoundingClientRect(); if (!rc.width) continue;
        const name = (el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).placeholder || el.getAttribute('title') || '').trim();
        const labelled = !!(el as HTMLInputElement).labels?.length || !!el.closest('label') || !!el.closest('.field');
        if (!name && !labelled) out.push(el.outerHTML.slice(0, 80));
      }
      return out.slice(0, 3);
    });
    for (const f of found) bad.push(`${p}: ${f}`);
  }
  expect(bad, bad.join('\n')).toEqual([]);
});

// ---- visual regression: pinned clock ⇒ identical seed ⇒ stable screens. Baselines live in qa/VISUAL_BASELINES.
const SHOTS: [string, string][] = [['dashboard', '/'], ['pos', '/pos'], ['orders', '/orders'], ['receivables', '/receivables'], ['events', '/events'], ['accounting-setup', '/accounting/setup'], ['profit', '/profit']];
for (const [name, route] of SHOTS) {
  for (const vp of [{ n: 'desktop', w: 1440, h: 900 }, { n: 'mobile', w: 390, h: 844 }]) {
    test(`visual: ${name} @ ${vp.n}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await openApp(page, route);
      await page.waitForTimeout(800);
      await expect(page).toHaveScreenshot(`${name}-${vp.n}.png`, { animations: 'disabled', fullPage: false });
    });
  }
}

// The in-app release-gate view must state the honest verdict, be accessible, and not overflow on a phone.
test('quality & release gates tab: honest verdict, axe-clean, no horizontal overflow on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openApp(page, '/blueprint');
  await page.getByRole('tab', { name: 'Quality & release gates' }).click();
  await expect(page.getByText('Not production-ready.')).toBeVisible();
  await expect(page.getByText('Gate E — Business ready')).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Gate F — Production ready' }).getByText('not met')).toBeVisible();
  await page.waitForTimeout(400);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious').map((v) => `${v.id}: ${v.nodes[0].target.join(' ')}`);
  expect(bad, bad.join('\n')).toEqual([]);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
});

// Mobile layout hides labels (e.g. the user name), so accessibility must be checked at phone width too, not only on desktop.
test('axe: no critical or serious WCAG violations on key screens at phone width (375 px)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openApp(page, '/');
  const report: string[] = [];
  for (const p of PAGES) {
    await go(page, p);
    await page.waitForTimeout(500);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const v of r.violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')) report.push(`${p} [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes) e.g. ${v.nodes[0].target.join(' ')}`);
  }
  expect(report, report.join('\n')).toEqual([]);
});
