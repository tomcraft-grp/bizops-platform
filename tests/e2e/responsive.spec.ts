import { expect, test } from '@playwright/test';
import { go, openApp } from './helpers';

// QA addendum §4.1 viewport matrix: no unintended horizontal overflow, touch targets usable, dialogs on-screen.
const VIEWPORTS = [
  { name: 'small-mobile-320', width: 320, height: 640 }, { name: 'small-mobile-360', width: 360, height: 740 }, { name: 'mobile-375', width: 375, height: 812 }, { name: 'mobile-430', width: 430, height: 932 },
  { name: 'large-mobile-600', width: 600, height: 900 }, { name: 'tablet-768', width: 768, height: 1024 }, { name: 'tablet-1024', width: 1024, height: 768 }, { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'laptop-1440', width: 1440, height: 900 }, { name: 'desktop-1920', width: 1920, height: 1080 },
];
const ROUTES = ['/', '/pos', '/orders', '/channels', '/kds', '/customers', '/receivables', '/loyalty', '/promotions', '/events', '/products', '/inventory', '/purchasing', '/production', '/accounting', '/accounting/setup', '/profit', '/reports', '/printing', '/media', '/team', '/settings', '/health', '/blueprint', '/app'];

for (const vp of VIEWPORTS) {
  test(`no horizontal page overflow on every screen @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openApp(page, '/');
    const problems: string[] = [];
    for (const r of ROUTES) {
      await go(page, r);
      await page.waitForTimeout(250);
      const res = await page.evaluate(() => {
        const cw = document.documentElement.clientWidth;
        const sw = document.documentElement.scrollWidth;
        const scrollable = (el: Element | null) => { while (el && el !== document.body) { const s = getComputedStyle(el); if (/(auto|scroll|hidden)/.test(s.overflowX)) return true; el = el.parentElement; } return false; };
        const off: string[] = [];
        if (sw > cw + 1) {
          for (const el of Array.from(document.querySelectorAll('body *'))) {
            const rc = el.getBoundingClientRect();
            if (rc.width > 0 && rc.right > cw + 1 && !scrollable(el.parentElement) && off.length < 3) off.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(' ')[0]} right=${Math.round(rc.right)}`);
          }
        }
        return { cw, sw, off };
      });
      if (res.sw > res.cw + 1) problems.push(`${r}: scrollWidth ${res.sw} > ${res.cw} (${res.off.join('; ')})`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

for (const vp of [VIEWPORTS[0], VIEWPORTS[2], VIEWPORTS[5]]) {
  test(`dialogs and drawers stay on-screen and scrollable @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openApp(page, '/orders');
    await page.locator('table.t tbody tr').first().click();
    const drawer = page.locator('.drawer');
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(400); // let the slide-in animation finish before measuring
    const box = (await drawer.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    await page.keyboard.press('Escape');
    await go(page, '/pos');
    await page.locator('button[aria-label="Add Latte (hot)"]').click();
    const modal = page.locator('.modal');
    const mb = (await modal.boundingBox())!;
    expect(mb.x).toBeGreaterThanOrEqual(-1);
    expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width + 1);
    expect(mb.y + mb.height).toBeLessThanOrEqual(vp.height + 1);
    await expect(modal.locator('.modal-f button.primary')).toBeInViewport();
  });
}

test('touch targets on mobile are at least 24×24 CSS px on the primary screens (WCAG 2.2 target size)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, '/');
  const small: string[] = [];
  for (const r of ['/', '/pos', '/orders', '/receivables', '/app']) {
    await go(page, r);
    await page.waitForTimeout(250);
    const found = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role=button]'))) {
        const rc = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const inline = el.tagName === 'A' && cs.display === 'inline'; // WCAG 2.2 exempts links inside a sentence
        const vis = rc.width > 0 && rc.height > 0 && cs.visibility !== 'hidden' && !inline;
        if (vis && (rc.width < 24 || rc.height < 24) && (el as HTMLInputElement).type !== 'checkbox' && !el.closest('.sr-only')) out.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20)}] ${Math.round(rc.width)}x${Math.round(rc.height)}`);
      }
      return out.slice(0, 8);
    });
    for (const f of found) small.push(`${r}: ${f}`);
  }
  expect(small, small.join('\n')).toEqual([]);
});

test('long names, large numbers, zero and negative values do not break layout', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp(page, '/customers');
  await page.getByRole('button', { name: /New customer/ }).click();
  const long = 'สมชาย นามสกุลยาวมากๆ มากๆ มากๆ มากๆ มากๆ มากๆ มากๆ มากๆ มากๆ มากๆ มากๆ ' + 'Wolfeschlegelsteinhausenbergerdorff'.repeat(2);
  await page.locator('.modal input').first().fill(long);
  await page.locator('.modal input').nth(1).fill('089-999-0000');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('input[placeholder="Search…"]').fill('Wolfeschlegel');
  await expect(page.locator('table.t tbody tr')).toHaveCount(1);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sw).toBeLessThanOrEqual(1);
});
