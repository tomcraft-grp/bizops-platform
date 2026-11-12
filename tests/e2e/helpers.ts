import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const NOW = new Date('2026-11-13T10:30:00+07:00');

/** Open the app with a pinned clock (deterministic seed) and wait until the demo data is ready */
export async function openApp(page: Page, hash = '/') {
  await page.clock.setFixedTime(NOW);
  await page.goto('/#' + hash);
  await page.waitForSelector('.app .content, .standalone', { timeout: 40_000 });
}
export const go = async (page: Page, hash: string) => { await page.evaluate((h) => { location.hash = '#' + h; }, hash); await page.waitForTimeout(250); };
export const heading = (page: Page) => page.locator('.content h1');
export async function switchUser(page: Page, name: string) {
  await page.locator('.user-chip').click();
  await page.locator('.popover .menu-item', { hasText: name }).click();
  await expect(page.locator('.user-chip')).toContainText(name.split(' ')[0]);
}
export const toast = (page: Page, text?: string | RegExp) => (text ? page.locator('.toast', { hasText: text }).first() : page.locator('.toast').first());
