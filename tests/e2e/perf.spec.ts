import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { go, openApp } from './helpers';

// QA addendum §6 performance: real measurements in a real browser (Chrome headless, this machine, production build).
// Timings include Playwright round-trips (~tens of ms), so they are upper bounds. Thresholds are deliberately generous smoke guards;
// the recorded numbers (qa/results/perf-browser.json) are the evidence, not the thresholds.
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const r1 = (n: number) => Math.round(n * 10) / 10;

test('browser performance: cold start, warm reload, route changes, checkout, bundle size', async ({ page }) => {
  test.setTimeout(180_000);
  const out: Record<string, unknown> = { measuredAt: new Date().toISOString(), browser: 'Chrome (headless, Playwright)', build: 'vite preview of the production build' };

  const t0 = Date.now();
  await openApp(page, '/');
  await page.locator('.content h1').waitFor();
  out.coldStartMs = Date.now() - t0; // first ever load: builds the demo business (seed) and renders the dashboard

  const warm: number[] = [];
  for (let i = 0; i < 3; i++) { const t = Date.now(); await page.reload(); await page.locator('.content h1').waitFor(); warm.push(Date.now() - t); }
  out.warmReloadMs = { runs: warm, median: median(warm) };

  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined; if (!n) return null; return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transferKB: Math.round(n.transferSize / 1024) }; });
  out.lastNavigationTiming = nav;

  const routes = ['/orders', '/receivables', '/inventory', '/accounting', '/accounting/setup', '/profit', '/reports', '/events'];
  const routeMs: Record<string, number> = {};
  for (const r of routes) {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await go(page, '/');
      const prev = (await page.locator('.content h1').first().textContent()) || '';
      const t = Date.now();
      await page.evaluate((h) => { location.hash = '#' + h; }, r);
      await page.waitForFunction((p) => { const h = document.querySelector('.content h1'); return !!h && h.textContent !== p && document.querySelectorAll('.content .card, .content table').length > 0; }, prev);
      runs.push(Date.now() - t);
    }
    routeMs[r] = median(runs);
  }
  out.routeChangeMedianMs = routeMs;

  await go(page, '/pos');
  const sale: number[] = [];
  for (let i = 0; i < 3; i++) {
    await page.locator('button[aria-label="Add Butter Croissant"]').click();
    await page.locator('.modal-f button.primary').click();
    await page.getByRole('button', { name: /^Charge/ }).click();
    await page.getByRole('button', { name: 'Add payment' }).click();
    const t = Date.now();
    await page.getByRole('button', { name: /Complete sale/ }).click();
    await page.getByText(/Sale complete — POS-/).waitFor();
    sale.push(Date.now() - t);
    await page.getByRole('button', { name: 'New sale' }).click();
  }
  out.completeSaleClickToConfirmationMs = { runs: sale, median: median(sale) };

  const dist = 'dist/index.html';
  const buf = readFileSync(dist);
  out.bundle = { file: dist, rawKB: r1(statSync(dist).size / 1024), gzipKB: r1(gzipSync(buf).length / 1024) };

  mkdirSync('qa/results', { recursive: true });
  writeFileSync('qa/results/perf-browser.json', JSON.stringify(out, null, 2));
  console.log('PERF ' + JSON.stringify(out));

  expect(out.coldStartMs as number, 'cold start (seed + first render)').toBeLessThan(10_000);
  expect(median(warm), 'warm reload').toBeLessThan(5_000);
  for (const [r, ms] of Object.entries(routeMs)) expect(ms, `route ${r}`).toBeLessThan(3_000);
  expect(median(sale), 'complete sale').toBeLessThan(2_000);
});
