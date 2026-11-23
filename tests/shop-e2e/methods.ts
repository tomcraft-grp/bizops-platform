// The payment methods live behind a collapsible section (checkout: data-fold="payment", an invoice: data-fold="pay-<id>"). Helpers shared by the browser tests.
import { expect, type Page } from '@playwright/test';

export const methodFold = (page: Page) => page.locator('[data-fold="payment"], [data-fold^="pay-"]').first();
/** open the list of payment methods when it is closed */
export async function openMethods(page: Page) {
  const head = methodFold(page).locator('.sp-fold-h');
  await expect(head).toBeVisible();
  if (await head.getAttribute('aria-expanded') === 'false') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
}
/** choose a bank by its code, or 'wallet' / 'qr': the list closes by itself and the closed section names the choice */
export async function pickMethod(page: Page, what: string) {
  await openMethods(page);
  await page.locator(what === 'wallet' || what === 'qr' ? `[data-method="${what}"] label` : `[data-bank="${what}"] label`).click();
  await expect(chosen(page)).toHaveAttribute('data-chosen', what);
}
export const chosen = (page: Page) => page.getByTestId('chosen-method');
/** open a collapsible section by its id (contact, items, progress, delivery) when it is closed */
export async function openFold(page: Page, id: string) {
  const head = page.locator(`[data-fold="${id}"] .sp-fold-h`);
  if (await head.getAttribute('aria-expanded') === 'false') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
}
