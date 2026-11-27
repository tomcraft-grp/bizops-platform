// Customer-to-customer points transfer, on the screens: the Account entry and the Home banner, finding a member by ID, the amount checks, the question before sending,
// holding points while a request waits, accepting / declining / cancelling, history, and the staff tab (switch, limits, audit, cancel). Against the fake backend
// (fakeBackend.ts + fakeTransfers.ts): this proves the SCREENS and what the browser sends. The rules themselves (the hold, the accept that moves points in one
// transaction, double accept, concurrency, rollback) are tested on the real database in supabase/tests/points_transfer.sql.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { FakeRewardsAdmin } from './fakeRewardsAdmin';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const en = (k: K, v?: Record<string, string | number>) => tr('en', k, v);

async function open(page: Page, fake: FakeShop, lang: 'th' | 'en' = 'th') {
  if (lang === 'en') await page.addInitScript(() => { try { localStorage.setItem('tc.shop.lang', 'en'); } catch { /* ignore */ } });
  await fake.install(page);
  await page.goto('/#/app');
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
/** a customer with rewards and transfers on; `mine` / `friend` are their points */
function shopOn(mine = 10, friend = 20) { const fake = new FakeShop(); fake.decorate(); fake.tr.enable({ mine, friend }); return fake; }
async function openTransfer(page: Page, lang: 'th' | 'en' = 'th') {
  await tab(page, (lang === 'th' ? t : en)('nav.account')).click();
  await page.getByTestId('transfer-row').click();
  await expect(page.getByTestId('pt-available')).toBeVisible();
}
async function pickRecipient(page: Page, code = 'frnd-7342') {
  await page.getByTestId('pt-code').fill(code);
  await page.getByTestId('pt-check').click();
  await expect(page.getByTestId('pt-rcpt')).toBeVisible();
}
async function review(page: Page, amount: string | number, note?: string) {
  await page.getByTestId('pt-amount').fill(String(amount));
  if (note) await page.getByTestId('pt-note').fill(note);
  await page.getByTestId('pt-review').click();
}
const confirm = (page: Page) => page.getByTestId('pt-sheet-confirm');
async function send(page: Page, amount: number, note?: string) {
  await pickRecipient(page); await review(page, amount, note);
  await confirm(page).click();
  await expect(page.getByTestId('pt-msg')).toHaveAttribute('data-tone', 'good');
}
const available = (page: Page) => page.getByTestId('pt-available');
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
const created = (fake: FakeShop) => fake.calls.filter((c) => c.fn === 'rw_transfer_create');
const noPrimaryDisabled = async (page: Page) => expect(await page.locator('.pt-page button.primary[disabled], .sp-sheet button.primary[disabled]').count()).toBe(0);

test.describe('entry points', () => {
  test('ships dark: no row on Account, no banner on Home, nothing sent', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); fake.tr.friendPoints = 5; fake.tr.friendSends(1, null);   // rewards on, transfers off, a request even exists: still nothing shows
    await open(page, fake);
    await expect.poll(() => fake.calls.some((c) => c.fn === 'rw_transfer_overview')).toBe(true);
    await expect(page.getByTestId('home-transfer')).toHaveCount(0);
    await tab(page, t('nav.account')).click();
    await expect(page.getByTestId('rewards-row')).toBeVisible();
    await expect(page.getByTestId('transfer-row')).toHaveCount(0);
    expect(fake.calls.filter((c) => /^rw_transfer_(create|accept|reject|cancel|lookup)$/.test(c.fn))).toHaveLength(0);
  });

  test('off while rewards are off too', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.tr.enabled = true;                  // the transfer switch alone is not enough
    await open(page, fake);
    await tab(page, t('nav.account')).click();
    await expect.poll(() => fake.calls.some((c) => c.fn === 'rw_transfer_overview')).toBe(true);
    await expect(page.getByTestId('transfer-row')).toHaveCount(0);
  });

  test('on: the row shows on Account, the screen shows the numbers, the member ID and an empty history', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await expect(available(page)).toHaveText('10');
    await expect(page.getByTestId('pt-balance')).toHaveText('10');
    await expect(page.getByTestId('pt-reserved')).toHaveCount(0);
    await expect(page.getByTestId('pt-mycode')).toHaveText('ME7K-4PQ2');
    await expect(page.getByTestId('pt-hist-none')).toHaveText(t('pt.histNone'));
    await expect(page.getByTestId('pt-incoming-list')).toHaveCount(0);
    await expect(page.getByTestId('pt-outgoing-list')).toHaveCount(0);
  });

  test('Back lands on the row that opened the screen', async ({ page }) => {
    const fake = shopOn(); await open(page, fake); await openTransfer(page);
    await page.getByRole('button', { name: t('common.back') }).click();
    await expect(page.getByTestId('transfer-row')).toBeFocused();
  });
});

test.describe('sending', () => {
  test('find the member by ID (any case, with or without the dash), see a short name and a masked ID, confirm, and the points are held', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await pickRecipient(page, ' frnd 7342 ');
    expect(fake.calls.find((c) => c.fn === 'rw_transfer_lookup')!.args).toEqual({ p_code: 'FRND7342' });
    await expect(page.getByTestId('pt-rcpt-name')).toHaveText('Maria S.');
    await expect(page.getByTestId('pt-rcpt')).toContainText('FR••••42');
    expect(await page.locator('.pt-page').innerText()).not.toMatch(/Suwan|FRND/);          // never the full name or the full ID of somebody else
    await review(page, 4, 'ขอบคุณที่ช่วยเมื่อวาน');
    await expect(page.getByTestId('pt-confirm-line')).toHaveText(t('pt.confirmLine', { n: 4, name: 'Maria S.', code: 'FR••••42' }));
    await expect(page.locator('.sp-sheet')).toContainText(t('pt.confirmAfter', { n: 6 }));
    expect(created(fake)).toHaveLength(0);                                                  // nothing is sent before the question is answered
    await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.sent', { name: 'Maria S.', n: 4 }));
    await expect(available(page)).toHaveText('6');
    await expect(page.getByTestId('pt-balance')).toHaveText('10');                          // the balance is untouched: the points are only held
    await expect(page.getByTestId('pt-reserved')).toHaveText(t('pt.reserved', { n: 4 }));
    await expect(page.getByTestId('pt-outgoing')).toHaveCount(1);
    const call = created(fake)[0].args;
    expect(call).toMatchObject({ p_code: 'FRND7342', p_points: 4, p_message: 'ขอบคุณที่ช่วยเมื่อวาน' });
    expect(String(call.p_key)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(fake.tr.points('me')).toBe(10); expect(fake.tr.points('friend')).toBe(20);       // nobody got any points yet
    expect(fake.tr.last()).toMatchObject({ points: 4, status: 'pending', sender: 'me', recipient: 'friend' });
    expect(fake.tr.friendPoints).toBe(20);
  });

  test('held points cannot be sent again: 10 points, 6 to one member, then 5 is refused and 4 works', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await send(page, 6);
    await expect(available(page)).toHaveText('4');
    await pickRecipient(page); await review(page, 5);
    await expect(page.getByTestId('pt-amount-err')).toHaveText(t('pt.err.amountAvail', { n: 4 }));
    expect(created(fake)).toHaveLength(1);                                                  // refused on the screen, never sent
    await review(page, 4);
    await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toHaveAttribute('data-tone', 'good');
    await expect(available(page)).toHaveText('0');
    expect(fake.tr.available('me')).toBe(0);
    expect(fake.tr.transfers.filter((x) => x.status === 'pending')).toHaveLength(2);
    await pickRecipient(page); await review(page, 1);
    await expect(page.getByTestId('pt-amount-err')).toHaveText(t('pt.err.nothing'));
  });

  test('the same server refusal when the screen is out of date: points removed behind it', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await pickRecipient(page);
    fake.tr.removePoints('me', 8);                                                           // staff took points away; the screen still says 10
    await review(page, 5);
    await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.err.amountAvail', { n: 2 }));
    await expect(available(page)).toHaveText('2');                                           // and the screen is refreshed
    expect(fake.tr.transfers).toHaveLength(0);
  });

  for (const bad of ['0', '-1', '1.5', '1e2', 'abc', '']) {
    test(`an amount of "${bad}" is explained on the screen and never sent`, async ({ page }) => {
      const fake = shopOn(10, 20);
      await open(page, fake); await openTransfer(page);
      await pickRecipient(page); await review(page, bad);
      await expect(page.getByTestId('pt-amount-err')).toHaveText(t(bad === '' ? 'pt.err.amountEmpty' : 'pt.err.amountWhole'));
      await expect(page.locator('.sp-sheet')).toHaveCount(0);
      expect(created(fake)).toHaveLength(0);
    });
  }

  test('more than the limit per transfer, and more than the daily limit', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.tr.enable({ mine: 5000, friend: 0, max: 100, daily_max: 150 });
    await open(page, fake); await openTransfer(page);
    await pickRecipient(page); await review(page, 101);
    await expect(page.getByTestId('pt-amount-err')).toHaveText(t('pt.err.amountMax', { n: 100 }));
    await review(page, 100); await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toHaveAttribute('data-tone', 'good');
    await pickRecipient(page); await review(page, 60);
    await expect(page.getByTestId('pt-amount-err')).toHaveText(t('pt.err.amountDaily', { n: 50 }));
    await page.getByTestId('pt-all').click();                                                // "all I can send" is what the limits allow: 50
    await expect(page.getByTestId('pt-amount')).toHaveValue('50');
  });

  test('a message of more than 140 characters is refused', async ({ page }) => {
    const fake = shopOn();
    await open(page, fake); await openTransfer(page);
    await pickRecipient(page); await review(page, 1, 'x'.repeat(141));
    await expect(page.locator('.pt-card [role="alert"]')).toHaveText(t('pt.err.msgLong'));
    expect(created(fake)).toHaveLength(0);
  });

  test('your own ID, an unknown ID, a disabled member and a badly typed ID are each explained, and a disabled member looks like an unknown one', async ({ page }) => {
    const fake = shopOn();
    await open(page, fake); await openTransfer(page);
    const err = page.getByTestId('pt-code-err');
    await page.getByTestId('pt-code').fill('me7k-4pq2'); await page.getByTestId('pt-check').click();
    await expect(err).toHaveText(t('pt.err.self'));
    expect(fake.calls.filter((c) => c.fn === 'rw_transfer_lookup')).toHaveLength(0);          // refused before asking
    await page.getByTestId('pt-code').fill('ABC'); await page.getByTestId('pt-check').click();
    await expect(err).toHaveText(t('pt.err.codeFormat'));
    await page.getByTestId('pt-code').fill(''); await page.getByTestId('pt-check').click();
    await expect(err).toHaveText(t('pt.err.codeEmpty'));
    await page.getByTestId('pt-code').fill('ZZZZ-9999'); await page.getByTestId('pt-check').click();
    await expect(err).toHaveText(t('pt.err.notFound'));
    await page.getByTestId('pt-code').fill('GNHP-9999'); await page.getByTestId('pt-check').click();
    await expect(err).toHaveText(t('pt.err.notFound'));
    await expect(page.getByTestId('pt-rcpt')).toHaveCount(0);
  });

  test('too many unknown IDs: the limit is explained', async ({ page }) => {
    const fake = shopOn(); fake.tr.misses = 20;
    await open(page, fake); await openTransfer(page);
    await page.getByTestId('pt-code').fill('ZZZZ-9999'); await page.getByTestId('pt-check').click();
    await expect(page.getByTestId('pt-code-err')).toHaveText(t('pt.err.lookups'));
  });

  test('change recipient goes back to the ID step', async ({ page }) => {
    const fake = shopOn();
    await open(page, fake); await openTransfer(page);
    await pickRecipient(page);
    await page.getByTestId('pt-change').click();
    await expect(page.getByTestId('pt-code')).toBeVisible();
    await expect(page.getByTestId('pt-rcpt')).toHaveCount(0);
  });

  test('a lost answer: pressing confirm again is the SAME request (same key), and exactly one transfer exists', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await pickRecipient(page); await review(page, 3);
    fake.dropResponseOnce('rw_transfer_create');                                              // the database handles it, the answer never arrives
    await confirm(page).click();
    await expect(page.getByTestId('pt-sheet-err')).toHaveText(t('pt.stillSending'));
    await expect(page.locator('.sp-sheet')).toBeVisible();                                    // the question stays open
    expect(fake.tr.transfers).toHaveLength(1);
    await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.sentReplay'));
    expect(fake.tr.transfers).toHaveLength(1);                                                // not two
    const keys = created(fake).map((c) => c.args.p_key);
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
    await expect(available(page)).toHaveText('7');
  });

  test('after a success the next transfer gets a NEW key (the same amount to the same member is a second, separate transfer)', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await send(page, 2);
    await send(page, 2);
    expect(fake.tr.transfers).toHaveLength(2);
    const keys = created(fake).map((c) => c.args.p_key); expect(keys[0]).not.toBe(keys[1]);
    await expect(available(page)).toHaveText('6');
  });

  test('a button that is working keeps its colour and says so; no primary button is ever disabled', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await noPrimaryDisabled(page);
    await pickRecipient(page); await noPrimaryDisabled(page);
    await review(page, 3); await noPrimaryDisabled(page);
    let release: () => void = () => undefined; const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/rest/v1/rpc/rw_transfer_create', async (route) => { await gate; await route.fallback(); });
    await confirm(page).click();
    await expect(confirm(page)).toHaveAttribute('aria-busy', 'true');
    await expect(confirm(page)).toContainText(t('pt.sending'));
    await noPrimaryDisabled(page);
    await confirm(page).click({ force: true }); await confirm(page).click({ force: true });  // more presses while it works: nothing more is sent
    release();
    await expect(page.getByTestId('pt-msg')).toHaveAttribute('data-tone', 'good');
    expect(created(fake)).toHaveLength(1);
    expect(fake.tr.transfers).toHaveLength(1);
  });

  test('the server says the feature is off: the screen says so', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await pickRecipient(page); await review(page, 2);
    fake.tr.enabled = false;
    await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.off'));
    await expect(page.getByTestId('pt-off')).toBeVisible();
  });
});

test.describe('answering', () => {
  test('Home shows a banner for a waiting request; it opens the transfer screen; Accept adds the points once, and the Rewards screen shows the new balance', async ({ page }) => {
    const fake = shopOn(7, 20); const tf = fake.tr.friendSends(3, 'ฝากให้ครบ 10 แต้มนะ');
    await open(page, fake);
    await expect(page.getByTestId('home-transfer')).toContainText(t('pt.homeBanner', { n: 1 }));
    await page.getByTestId('home-transfer').click();
    await expect(available(page)).toHaveText('7');                                            // straight on the transfer screen
    const card = page.getByTestId('pt-incoming');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Maria S.'); await expect(card).toContainText('FR••••42'); await expect(card).toContainText('+3');
    await expect(card).toContainText('ฝากให้ครบ 10 แต้มนะ');
    await page.getByTestId('pt-accept').click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.accepted', { n: 3, total: 10 }));
    await expect(available(page)).toHaveText('10');
    await expect(page.getByTestId('pt-incoming')).toHaveCount(0);
    await expect(page.getByTestId('pt-hist')).toHaveCount(1);
    await expect(page.getByTestId('pt-hist')).toHaveAttribute('data-status', 'accepted');
    await expect(page.getByTestId('pt-hist')).toContainText('+3');
    expect(fake.tr.points('me')).toBe(10); expect(fake.tr.points('friend')).toBe(17);
    expect(fake.tr.rows('me')).toBe(1); expect(fake.tr.rows('friend')).toBe(1);
    expect(tf.status).toBe('accepted');
    await page.getByRole('button', { name: t('common.back') }).click();
    await page.getByTestId('rewards-row').click();
    await expect(page.getByTestId('rewards-screen')).toContainText('10');                     // the same 10 points the Rewards screen shows
  });

  test('a double tap on Accept adds the points once', async ({ page }) => {
    const fake = shopOn(7, 20); fake.tr.friendSends(3);
    await open(page, fake); await openTransfer(page);
    await page.getByTestId('pt-accept').dblclick();
    await expect(page.getByTestId('pt-msg')).toHaveAttribute('data-tone', 'good');
    await expect(available(page)).toHaveText('10');
    expect(fake.calls.filter((c) => c.fn === 'rw_transfer_accept')).toHaveLength(1);
    expect(fake.tr.rows('me')).toBe(1); expect(fake.tr.points('me')).toBe(10);
  });

  test('two devices: the second Accept on a stale screen changes nothing and says it was already accepted', async ({ page, browser }) => {
    const fake = shopOn(7, 20); fake.tr.friendSends(3);
    await open(page, fake); await openTransfer(page);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
    const p2 = await ctx.newPage(); await open(p2, fake); await openTransfer(p2);
    await expect(p2.getByTestId('pt-incoming')).toHaveCount(1);
    await page.getByTestId('pt-accept').click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.accepted', { n: 3, total: 10 }));
    await p2.getByTestId('pt-accept').click();                                                // the second device still shows the request
    await expect(p2.getByTestId('pt-msg')).toContainText(t('pt.acceptedReplay'));
    await expect(available(p2)).toHaveText('10');
    expect(fake.tr.rows('me')).toBe(1); expect(fake.tr.points('me')).toBe(10); expect(fake.tr.points('friend')).toBe(17);
    await ctx.close();
  });

  test('Decline asks first, frees the sender\'s points and moves nothing', async ({ page }) => {
    const fake = shopOn(7, 20); fake.tr.friendSends(3);
    await open(page, fake); await openTransfer(page);
    await page.getByTestId('pt-reject').click();
    await expect(page.locator('.sp-sheet')).toContainText(t('pt.rejectBody'));
    await page.getByTestId('pt-sheet-cancel').click();                                         // "keep it": nothing happened
    expect(fake.calls.filter((c) => c.fn === 'rw_transfer_reject')).toHaveLength(0);
    await expect(page.getByTestId('pt-incoming')).toHaveCount(1);
    await page.getByTestId('pt-reject').click();
    await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.rejected'));
    await expect(page.getByTestId('pt-incoming')).toHaveCount(0);
    await expect(page.getByTestId('pt-hist')).toHaveAttribute('data-status', 'rejected');
    expect(fake.tr.points('me')).toBe(7); expect(fake.tr.points('friend')).toBe(20); expect(fake.tr.held('friend')).toBe(0);
    expect(fake.tr.ledger).toHaveLength(0);
  });

  test('the sender can cancel a waiting request and gets the points back at once', async ({ page }) => {
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await send(page, 4);
    await expect(available(page)).toHaveText('6');
    await page.getByTestId('pt-cancel').click();
    await expect(page.locator('.sp-sheet')).toContainText(t('pt.cancelBody'));
    await confirm(page).click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.cancelDone'));
    await expect(available(page)).toHaveText('10');
    await expect(page.getByTestId('pt-outgoing-list')).toHaveCount(0);
    await expect(page.getByTestId('pt-hist')).toHaveAttribute('data-status', 'cancelled');
    expect(fake.tr.points('me')).toBe(10); expect(fake.tr.ledger).toHaveLength(0);
  });

  test('a request nobody answered is expired: gone from the waiting list, kept in the history, the points free again', async ({ page }) => {
    const fake = shopOn(10, 20);
    const incoming = fake.tr.friendSends(3);
    await open(page, fake); await openTransfer(page);
    await send(page, 4);
    const mine = fake.tr.last();
    await expect(available(page)).toHaveText('6');
    fake.tr.expire(incoming.no); fake.tr.expire(mine.no);
    await page.getByRole('button', { name: t('common.refresh') }).click();
    await expect(available(page)).toHaveText('10');
    await expect(page.getByTestId('pt-incoming-list')).toHaveCount(0);
    await expect(page.getByTestId('pt-outgoing-list')).toHaveCount(0);
    await expect(page.getByTestId('pt-hist')).toHaveCount(2);
    for (const row of await page.getByTestId('pt-hist').all()) await expect(row).toHaveAttribute('data-status', 'expired');
    expect(fake.tr.points('me')).toBe(10); expect(fake.tr.ledger).toHaveLength(0);
  });

  test('accepting a request that ran out of time while the screen was open: recorded as expired, no points move', async ({ page }) => {
    const fake = shopOn(7, 20); const tf = fake.tr.friendSends(3);
    await open(page, fake); await openTransfer(page);
    fake.tr.expire(tf.no);
    await page.getByTestId('pt-accept').click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.expiredNow'));
    await expect(available(page)).toHaveText('7');
    expect(fake.tr.points('me')).toBe(7); expect(fake.tr.ledger).toHaveLength(0);
  });

  test('the sender\'s points were taken away behind the request: it is cancelled with a reason, never negative', async ({ page }) => {
    const fake = shopOn(7, 5); fake.tr.friendSends(5);
    await open(page, fake); await openTransfer(page);
    fake.tr.removePoints('friend', 5);
    await page.getByTestId('pt-accept').click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.cancelledNow'));
    await expect(page.getByTestId('pt-hist')).toHaveAttribute('data-status', 'cancelled');
    await expect(page.getByTestId('pt-hist')).toContainText(t('pt.why.balance'));
    expect(fake.tr.points('me')).toBe(7); expect(fake.tr.points('friend')).toBe(0); expect(fake.tr.ledger).toHaveLength(0);
  });

  test('the request was cancelled by the sender while the screen was open: the answer is explained and the screen refreshes', async ({ page }) => {
    const fake = shopOn(7, 20); const tf = fake.tr.friendSends(3);
    await open(page, fake); await openTransfer(page);
    tf.status = 'cancelled'; tf.reason = 'CANCELLED_BY_SENDER';                                  // the sender cancelled it on their own phone
    await page.getByTestId('pt-accept').click();
    await expect(page.getByTestId('pt-msg')).toContainText(t('pt.err.notPending'));
    await expect(page.getByTestId('pt-incoming')).toHaveCount(0);
    expect(fake.tr.ledger).toHaveLength(0);
  });

  test('the unread number: the entry row shows it, opening the screen reads it', async ({ page }) => {
    const fake = shopOn(7, 20); const tf = fake.tr.friendSends(3);
    await open(page, fake);
    await tab(page, t('nav.account')).click();
    await expect(page.getByTestId('transfer-badge')).toHaveText('1');
    await expect(page.getByTestId('transfer-row')).toContainText(t('pt.rowWaiting', { n: 1 }));
    await page.getByTestId('transfer-row').click();
    await expect(available(page)).toBeVisible();
    await expect.poll(() => fake.tr.unread('me')).toBe(0);                                      // the notices were marked read
    await page.getByTestId('pt-accept').click();
    await expect(page.getByTestId('pt-msg')).toHaveAttribute('data-tone', 'good');
    await page.getByRole('button', { name: t('common.back') }).click();
    await expect(page.getByTestId('transfer-row')).toBeVisible();
    await expect(page.getByTestId('transfer-badge')).toHaveCount(0);
    expect(tf.status).toBe('accepted');
  });

  test('a long name, a long message and a lot of history do not break a 320 px screen', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const fake = shopOn(7, 2000);
    for (let i = 0; i < 12; i++) { const tf = fake.tr.friendSends(1, 'x'.repeat(130)); fake.tr.rpc('rw_transfer_accept', { p_transfer: tf.id }); }
    fake.tr.friendSends(3, 'y'.repeat(140));
    await open(page, fake); await openTransfer(page);
    await expect(page.getByTestId('pt-hist')).toHaveCount(8);                                    // eight rows, then "show all"
    await page.getByRole('button', { name: t('pt.showAll', { n: 12 }) }).click();
    await expect(page.getByTestId('pt-hist')).toHaveCount(12);
    await noOverflow(page);
  });
});

test.describe('quality', () => {
  test('English: every label of the screen is English', async ({ page }) => {
    const fake = shopOn(10, 20); fake.tr.friendSends(2, 'hello');
    await open(page, fake, 'en'); await openTransfer(page, 'en');
    await expect(page.getByRole('heading', { name: en('pt.title') })).toBeVisible();
    await expect(page.getByTestId('pt-incoming')).toContainText(en('pt.accept'));
    await expect(page.getByTestId('pt-incoming')).toContainText(en('pt.reject'));
    await pickRecipient(page); await review(page, 3);
    await expect(page.getByTestId('pt-confirm-line')).toHaveText(en('pt.confirmLine', { n: 3, name: 'Maria S.', code: 'FR••••42' }));
    expect(await page.locator('.pt-page, .sp-sheet').allInnerTexts().then((x) => x.join(' '))).not.toMatch(/[ก-๿]/);
  });

  test('no accessibility violations on the screen with waiting requests, a held request, history and the question open', async ({ page }) => {
    const fake = shopOn(10, 20); fake.tr.friendSends(2, 'hello');
    await open(page, fake); await openTransfer(page);
    await send(page, 3);
    await pickRecipient(page); await review(page, 1);
    const r = await new AxeBuilder({ page }).include('.pt-page').include('.sp-sheet').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });

  test('a phone screen has no horizontal scroll and the main buttons are at least 44 px high', async ({ page }) => {
    const fake = shopOn(10, 20); fake.tr.friendSends(2);
    await open(page, fake); await openTransfer(page);
    await noOverflow(page);
    for (const id of ['pt-accept', 'pt-reject', 'pt-check']) { const box = await page.getByTestId(id).first().boundingBox(); expect(box!.height, id).toBeGreaterThanOrEqual(44); }
  });

  test('a desktop screen works too', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const fake = shopOn(10, 20);
    await open(page, fake); await openTransfer(page);
    await send(page, 2);
    await expect(available(page)).toHaveText('8');
    await noOverflow(page);
  });
});

// ------------------------------------------------------------------------------------------------ staff
test.describe('staff tab "Point transfers"', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  async function openStaff(page: Page, role: 'SUPER_ADMIN' | 'ADMIN' = 'SUPER_ADMIN', lang: 'en' | 'th' = 'en', setup?: (fake: FakeShop) => void) {
    const fake = new FakeShop(); const adm = new FakeRewardsAdmin(fake);
    fake.profile.role = role; fake.profile.display_name = 'Staff'; fake.rw.enabled = true;
    setup?.(fake);
    await fake.install(page); await adm.install(page);
    await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
    await page.goto('/#/promotions');
    await expect(page.getByRole('heading', { name: lang === 'en' ? 'Promotions' : 'โปรโมชั่น', level: 1 })).toBeVisible();
    await page.getByRole('tab', { name: lang === 'en' ? 'Point transfers' : 'การโอนแต้ม' }).click();
    await expect(page.getByTestId('transfers-panel')).toBeVisible();
    return fake;
  }
  const saves = (fake: FakeShop) => fake.calls.filter((c) => c.fn === 'rw_admin_save_transfer_settings');

  test('off by default; a Super Admin switches it on after one inline confirmation and off with one click', async ({ page }) => {
    const fake = await openStaff(page);
    const sw = page.getByTestId('tr-switch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(page.getByText(/Switch on for every customer\?/)).toBeVisible();
    expect(saves(fake)).toHaveLength(0);                                                      // nothing is sent before the confirmation
    await page.getByTestId('tr-switch-yes').click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(saves(fake)[0].args).toEqual({ p_patch: { transfers_enabled: true } });
    expect(fake.tr.enabled).toBe(true);
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(saves(fake)[1].args).toEqual({ p_patch: { transfers_enabled: false } });
  });

  test('says so when the rewards master switch is off', async ({ page }) => {
    await openStaff(page, 'SUPER_ADMIN', 'en', (f) => { f.rw.enabled = false; });
    await expect(page.getByText(/master switch above is off/)).toBeVisible();
  });

  test('limits that do not fit together are explained before anything is sent; a valid change sends only what changed', async ({ page }) => {
    const fake = await openStaff(page);
    await page.getByTestId('tr-min_points').fill('50'); await page.getByTestId('tr-max_points').fill('40');
    await page.getByTestId('tr-save').click();
    await expect(page.getByText('The largest transfer cannot be smaller than the smallest.')).toBeVisible();
    expect(saves(fake)).toHaveLength(0);
    await page.getByTestId('tr-min_points').fill('2'); await page.getByTestId('tr-max_points').fill('500'); await page.getByTestId('tr-expire_days').fill('91');
    await page.getByTestId('tr-save').click();
    await expect(page.getByText('A request can wait at most 90 days.')).toBeVisible();
    await page.getByTestId('tr-expire_days').fill('3');
    await page.getByTestId('tr-save').click();
    await expect.poll(() => saves(fake).length).toBe(1);
    expect(saves(fake)[0].args).toEqual({ p_patch: { min_points: 2, max_points: 500, expire_days: 3 } });
    expect(fake.tr.limits).toMatchObject({ min: 2, max: 500, expire_days: 3, daily_max: 5000 });
  });

  test('the audit list shows who sent what to whom; filter by status and search by name', async ({ page }) => {
    const fake = await openStaff(page, 'SUPER_ADMIN', 'en', (f) => {
      f.tr.enable({ mine: 10, friend: 20 });
      const a = f.tr.friendSends(3); f.tr.rpc('rw_transfer_accept', { p_transfer: a.id });
      f.tr.friendSends(5);
      f.tr.rpc('rw_transfer_create', { p_code: 'FRND7342', p_points: 2, p_key: 'key-for-a-test-1', p_message: null });
    });
    const rows = page.locator('[data-testid="transfers-panel"] tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('PT-000003');
    await expect(rows.nth(2)).toContainText('Maria Suwan'); await expect(rows.nth(2)).toContainText('FRND-7342'); await expect(rows.nth(2)).toContainText('สมชาย ใจดี');
    await expect(rows.nth(2)).toContainText('Done');
    await expect(rows.nth(2)).toContainText('#1 → #2');                                          // the two ledger rows of the accepted transfer
    await page.getByRole('tab', { name: 'Done' }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole('tab', { name: 'All' }).click();
    await page.getByTestId('tr-search').fill('PT-000002');
    await expect(rows).toHaveCount(1);
    expect(fake.calls.filter((c) => c.fn === 'rw_admin_transfers').length).toBeGreaterThan(1);
  });

  test('a Super Admin cancels a waiting transfer with a reason; the held points are free again', async ({ page }) => {
    const fake = await openStaff(page, 'SUPER_ADMIN', 'en', (f) => { f.tr.enable({ mine: 10, friend: 20 }); f.tr.friendSends(5); });
    expect(fake.tr.held('friend')).toBe(5);
    await page.getByTestId('tr-cancel').click();
    await expect(page.getByText(/Cancel transfer PT-000001\?/)).toBeVisible();
    await page.getByRole('textbox').last().fill('duplicate request');
    await page.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
    await expect(page.getByText('Transfer cancelled. The held points are free again.')).toBeVisible();
    expect(fake.calls.find((c) => c.fn === 'rw_admin_cancel_transfer')!.args).toMatchObject({ p_reason: 'duplicate request' });
    expect(fake.tr.byNo('PT-000001')).toMatchObject({ status: 'cancelled', reason: 'ADMIN: duplicate request' });
    expect(fake.tr.held('friend')).toBe(0);
    await expect(page.locator('[data-testid="transfers-panel"] tbody tr').first()).toContainText('Cancelled');
    await expect(page.getByTestId('tr-cancel')).toHaveCount(0);
  });

  test('an Admin can read the list but cannot change anything', async ({ page }) => {
    await openStaff(page, 'ADMIN', 'en', (f) => { f.tr.enable({ mine: 10, friend: 20 }); f.tr.friendSends(5); });
    await expect(page.getByTestId('tr-switch')).toBeDisabled();
    await expect(page.getByTestId('tr-save')).toHaveCount(0);
    await expect(page.getByTestId('tr-cancel')).toHaveCount(0);
    await expect(page.locator('[data-testid="transfers-panel"] tbody tr')).toHaveCount(1);
    await expect(page.getByText('Only a Super Admin can change these.')).toBeVisible();
  });

  test('Thai', async ({ page }) => {
    await openStaff(page, 'SUPER_ADMIN', 'th', (f) => { f.tr.enable({ mine: 10, friend: 20 }); f.tr.friendSends(5); });
    await expect(page.getByText('การโอนแต้มระหว่างลูกค้า')).toBeVisible();
    await expect(page.getByText('การโอนแต้มทั้งหมด')).toBeVisible();
    await expect(page.getByText('บันทึกค่าที่ตั้ง')).toBeVisible();
  });
});
