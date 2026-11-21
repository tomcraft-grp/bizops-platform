// Customer side of "Rewards, event boards": the Account entry, the picks summary and the bills that earned them, the three shared number boards (pick a number with an
// inline confirm bar, never a dialog), the polling that shows what other people picked, and the preview line in the cart. Against the fake backend
// (fakeBackend.ts + fakeRewards.ts): this proves the SCREENS and what the browser sends. Who may hold a number, the per-bill arithmetic and the reversals are decided and
// tested in the database (supabase/tests/rewards_core.sql, event_boards.sql); the fake only mirrors that contract.
//
// Board picks are PER BILL: each paid bill earns floor(eligible amount / 300) picks (299 -> 0, 300 -> 1, 599 -> 1, 600 -> 2, 850 -> 2, 900 -> 3, 1000 -> 3, 1200 -> 4);
// bills are never added together. The screen says so, bill by bill.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop, USER_ID } from './fakeBackend';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const en = (k: K, v?: Record<string, string | number>) => tr('en', k, v);

async function open(page: Page, fake: FakeShop, lang: 'th' | 'en' = 'th') {
  if (lang === 'en') await page.addInitScript(() => { try { localStorage.setItem('tc.shop.lang', 'en'); } catch { /* ignore */ } });
  await fake.install(page);
  await page.goto('/#/app');
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1 && (document.querySelector('.phone-body')?.scrollWidth ?? 0) <= (document.querySelector('.phone-body')?.clientWidth ?? 0) + 1)).toBe(true);
/** Account tab, then the "Rewards & event" row */
async function openRewards(page: Page, lang: 'th' | 'en' = 'th') {
  const T = lang === 'th' ? t : en;
  await tab(page, T('nav.account')).click();
  await page.getByTestId('rewards-row').click();
  await expect(page.getByTestId('rewards-screen')).toBeVisible();
  await expect(page.getByTestId('rw-summary')).toBeVisible();
}
/** a customer with rewards on and an active event; `bills` are paid bills of these eligible amounts */
function shopWith(...bills: number[]) { const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); for (const b of bills) fake.rw.addBill(b); return fake; }
const cell = (page: Page, n: number) => page.locator(`[data-testid="rw-grid"] [data-n="${n}"]`);
/** a customer's tap on a number the screen marks as unavailable (aria-disabled): Playwright would wait for it to become enabled, a finger does not */
const tapDisabled = (page: Page, n: number) => cell(page, n).click({ force: true });
const claims = (fake: FakeShop) => fake.calls.filter((c) => c.fn === 'rw_claim_number');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.describe('the Account entry', () => {
  test('ships dark: with rewards off the Account tab shows no entry and nothing breaks', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake);
    await tab(page, t('nav.account')).click();
    await expect(page.locator('.sp-links')).toBeVisible();
    await expect(page.getByTestId('rewards-row')).toHaveCount(0);
  });
  test('an old database (the call fails) shows no entry either', async ({ page }) => {
    const fake = shopWith(); fake.failNext('rw_settings_public', 3); await open(page, fake);
    await tab(page, t('nav.account')).click();
    await expect(page.locator('.sp-links')).toBeVisible();
    await expect(page.getByTestId('rewards-row')).toHaveCount(0);
  });
  test('with rewards on there is a "Rewards & event" row; it opens the screen in place of the account page and Back returns to it', async ({ page }) => {
    const fake = shopWith(); await open(page, fake);
    await tab(page, t('nav.account')).click();
    const row = page.getByTestId('rewards-row');
    await expect(row).toContainText(t('acc.rewards'));
    await row.click();
    await expect(page.getByRole('heading', { name: t('rw.title') })).toBeVisible();
    await expect(page.locator('.sp-me')).toHaveCount(0);                                         // the account summary is replaced, not stacked
    await expect(page.locator('.phone-body')).not.toContainText(t('acc.language'));              // and so is everything below it (the member form, the language switch)
    await page.getByRole('button', { name: t('common.back') }).click();
    await expect(page.locator('.sp-me')).toBeVisible(); await expect(row).toBeFocused();
  });
});

test.describe('picks summary and the bills that earned them', () => {
  /** 850 and 600 paid (2 + 2 picks), 250 paid (none), 700 not paid yet, 900 paid then taken back; one pick already used on Board A #05 */
  function mixed() {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable();
    fake.rw.addBill(850); fake.rw.addBill(600); fake.rw.addBill(250);
    fake.rw.addBill(700, { paid: false });
    const back = fake.rw.addBill(900); fake.rw.reversePayment(back.order_no);
    fake.rw.pickFor(1, 5);
    return fake;
  }
  test('"Earned 4 · Used 1 · 3 left to pick", in Thai and in English', async ({ page }) => {
    const fake = mixed(); await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-summary')).toContainText(`${t('rw.earned', { n: 4 })} · ${t('rw.used', { n: 1 })} · ${t('rw.left', { n: 3 })}`);
    await expect(page.getByTestId('rw-summary')).toContainText('ได้รับ 4 · ใช้แล้ว 1 · เหลือ 3 สิทธิ์ให้เลือก');
    await page.getByRole('button', { name: t('common.back') }).click();
    await page.getByRole('group', { name: t('acc.language') }).getByRole('button', { name: 'English' }).click();
    await page.getByTestId('rewards-row').click();
    await expect(page.getByTestId('rw-summary')).toContainText('Earned 4 · Used 1 · 3 left to pick');
  });
  test('each bill shows its eligible amount and the picks it earned; unpaid "counts once paid", reversed "taken back"; bills are never added together', async ({ page }) => {
    const fake = mixed(); await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-rule')).toContainText(t('rw.rule1', { amount: '฿300' }));
    const bills = page.getByTestId('rw-bills');
    await expect(bills.locator('li')).toHaveCount(3);                                             // the newest three first
    await page.getByRole('button', { name: t('rw.showAll', { n: 5 }) }).click();
    await expect(bills.locator('li')).toHaveCount(5);
    const row = (no: string) => bills.locator(`li[data-order="${no}"]`);
    const nos = fake.orders.map((o) => o.order_no);
    await expect(row(nos[0])).toContainText(t('rw.order', { no: nos[0] })); await expect(row(nos[0])).toContainText(t('rw.billEarnedN', { amount: '฿850', n: 2 }));
    await expect(row(nos[1])).toContainText(t('rw.billEarnedN', { amount: '฿600', n: 2 }));       // 600 is two picks; the bills are not added to 850 (that would be 3)
    await expect(row(nos[2])).toContainText(t('rw.billNoneStep', { amount: '฿250', step: '฿300' })); // 250 earns nothing: bills never combine
    await expect(row(nos[3])).toContainText(t('rw.billWaiting', { amount: '฿700' }));
    await expect(row(nos[4])).toContainText(t('rw.billBack', { amount: '฿900' }));
    await expect(page.getByTestId('rw-summary')).toContainText(t('rw.earned', { n: 4 }));          // only the two counted bills
    await page.getByRole('button', { name: t('rw.showFewer') }).click(); await expect(bills.locator('li')).toHaveCount(3);
  });
  test('English wording of the bill rows', async ({ page }) => {
    const fake = mixed(); await open(page, fake, 'en'); await openRewards(page, 'en');
    await page.getByRole('button', { name: en('rw.showAll', { n: 5 }) }).click();
    const text = await page.getByTestId('rw-bills').innerText();
    expect(text).toContain('฿850 eligible → 2 picks'); expect(text).toContain('฿600 eligible → 2 picks'); expect(text).toContain('฿700 eligible · counts once paid'); expect(text).toContain('฿900 eligible · taken back');
    expect(text).toContain('฿250 eligible → no picks (needs ฿300 per pick)');
  });
  test('a bill opens its order so that an unpaid one can be paid', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); const o = fake.rw.addBill(700, { paid: false }); await open(page, fake); await openRewards(page);
    await page.getByTestId('rw-bills').locator(`li[data-order="${o.order_no}"] button`).click();
    await expect(page.locator('.sp-order-detail')).toBeVisible();
    await expect(page.locator('.sp-order-detail')).toContainText(o.order_no);
  });
  test('without a server-sent spend step the screen words things without inventing a number', async ({ page }) => {
    const fake = shopWith(); fake.rw.sendStep = false; await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-rule')).toContainText(t('rw.ruleUnknown'));
    await expect(page.getByTestId('rw-hint')).toContainText(t('rw.noRightsUnknown'));
  });
  test('a rule that gives 2 picks per step: the rule line says so and a bill of 450 (step 300) earns 2, one of 600 earns 4, one of 250 none', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); fake.rw.rule.reward = 2; fake.rw.addBill(450); fake.rw.addBill(600); fake.rw.addBill(250); await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-rule')).toContainText(t('rw.ruleN', { amount: '฿300', n: 2 }));
    await expect(page.getByTestId('rw-summary')).toContainText('ได้รับ 6 · ใช้แล้ว 0 · เหลือ 6 สิทธิ์ให้เลือก');
    const bills = page.getByTestId('rw-bills'); const nos = fake.orders.map((o) => o.order_no);
    await expect(bills.locator(`li[data-order="${nos[0]}"]`)).toContainText(t('rw.billEarnedN', { amount: '฿450', n: 2 }));
    await expect(bills.locator(`li[data-order="${nos[1]}"]`)).toContainText(t('rw.billEarnedN', { amount: '฿600', n: 4 }));
    await expect(bills.locator(`li[data-order="${nos[2]}"]`)).toContainText(t('rw.billNoneStep', { amount: '฿250', step: '฿300' }));
  });
  test('a customer with no bills yet sees an empty list and a read-only board', async ({ page }) => {
    const fake = shopWith(); await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-summary')).toContainText('ได้รับ 0 · ใช้แล้ว 0 · เหลือ 0');
    await expect(page.getByText(t('rw.noBills'))).toBeVisible();
  });
});

test.describe('the number board', () => {
  test('three boards with their mode in plain words; a 10 x 10 grid; the legend; tapping a free number opens an inline confirm bar, not a dialog, and sends nothing yet', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    for (const slot of [1, 2, 3]) await expect(page.getByTestId(`rw-tab-${slot}`)).toBeVisible();
    await expect(page.getByTestId('rw-tab-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('rw-mode')).toContainText(t('rw.mode.exclusive'));
    await page.getByTestId('rw-tab-3').click(); await expect(page.getByTestId('rw-mode')).toContainText(t('rw.mode.shared'));
    await page.getByTestId('rw-tab-1').click();
    await expect(page.locator('[data-testid="rw-grid"] button')).toHaveCount(100);
    expect(await page.locator('[data-testid="rw-grid"]').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length)).toBe(10);
    await expect(page.getByTestId('rw-legend')).toBeVisible();
    await cell(page, 7).click();
    await expect(page.getByTestId('rw-confirm')).toContainText(t('rw.confirm.q', { board: 'Board A', n: '07' }));
    await expect(page.locator('[role="dialog"], [role="alertdialog"], .sp-sheet')).toHaveCount(0);
    expect(claims(fake).length).toBe(0);
    await page.getByTestId('rw-confirm-no').click();
    await expect(page.getByTestId('rw-confirm')).toHaveCount(0); expect(claims(fake).length).toBe(0);
    await expect(cell(page, 7)).toHaveAttribute('data-s', 'free');
  });

  test('Confirm sends ONE claim even on a double tap, then the grid shows the SERVER\'s board (not a guess made while waiting)', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    await page.route('**/rest/v1/rpc/rw_claim_number', async (route) => { await sleep(700); await route.fallback(); });   // a slow connection
    await cell(page, 7).click();
    await page.getByTestId('rw-confirm-yes').dblclick();
    await expect(cell(page, 7)).toHaveAttribute('data-s', 'free');                                // still the old board while the server has not answered
    await expect(page.getByTestId('rw-confirm-yes')).toBeDisabled();
    await expect(cell(page, 7)).toHaveAttribute('data-s', 'mine');
    await expect(page.getByTestId('rw-confirm')).toHaveCount(0);
    await expect(page.getByTestId('rw-summary')).toContainText(t('rw.left', { n: 2 }));
    await expect(page.getByTestId('rw-msg')).toContainText(t('rw.done', { board: 'Board A', n: '07', left: 2 }));
    await expect(page.getByTestId('rw-mine')).toContainText('Board A #07');
    expect(claims(fake).length).toBe(1);
    const c = claims(fake)[0].args;
    expect(c).toMatchObject({ p_event: 'event-1', p_board: 'board-1', p_number: 7 }); expect(String(c.p_key)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(fake.rw.held()).toBe(1);
  });

  test('a lost answer is not a lost pick: the server saved it, the refreshed board shows it, and nothing is sent twice', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    fake.dropResponseOnce('rw_claim_number');                                                      // the server saves the pick, the answer never arrives
    await cell(page, 23).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(cell(page, 23)).toHaveAttribute('data-s', 'mine');                                // the board is reloaded after a lost answer and shows what the server did
    await expect(page.getByTestId('rw-msg')).toContainText(t('rw.done', { board: 'Board A', n: '23', left: 2 }));
    await expect(page.getByTestId('rw-confirm')).toHaveCount(0);
    expect(claims(fake).length).toBe(1); expect(fake.rw.held()).toBe(1); await expect(page.getByTestId('rw-summary')).toContainText(t('rw.left', { n: 2 }));
  });
  test('a retry after a dropped connection reuses the SAME idempotency key (the question stays open, Confirm retries)', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    const keys: string[] = []; let n = 0;
    await page.route('**/rest/v1/rpc/rw_claim_number', async (route) => { keys.push((JSON.parse(route.request().postData() || '{}') as { p_key: string }).p_key); if (n++ === 0) await route.abort('connectionreset'); else await route.fallback(); });   // the first request never reaches the server
    await cell(page, 23).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(page.getByTestId('rw-msg')).toContainText(t('err.network'));
    await expect(page.getByTestId('rw-confirm')).toBeVisible(); await expect(cell(page, 23)).toHaveAttribute('data-s', 'free');
    await page.getByTestId('rw-confirm-yes').click();
    await expect(cell(page, 23)).toHaveAttribute('data-s', 'mine');
    expect(keys.length).toBe(2); expect(keys[0]).toBe(keys[1]); expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(claims(fake).length).toBe(1); expect(fake.rw.held()).toBe(1);
    // a different number is a new attempt with a new key
    await cell(page, 24).click(); await page.getByTestId('rw-confirm-yes').click(); await expect(cell(page, 24)).toHaveAttribute('data-s', 'mine');
    expect(keys[2]).not.toBe(keys[0]);
  });
  test('an unexpected server error keeps the question open too, and the retry uses the same key', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    fake.failNext('rw_claim_number');
    await cell(page, 31).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(page.getByTestId('rw-msg')).toContainText(t('err.generic')); await expect(page.getByTestId('rw-confirm')).toBeVisible();
    await page.getByTestId('rw-confirm-yes').click(); await expect(cell(page, 31)).toHaveAttribute('data-s', 'mine');
    const ks = claims(fake).map((x) => x.args.p_key); expect(ks.length).toBe(2); expect(ks[0]).toBe(ks[1]); expect(fake.rw.held()).toBe(1);
  });
  test('a stale tap: the number was taken meanwhile, the server says NUMBER_TAKEN, the board refreshes and the customer keeps the pick', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake);
    await page.route('**/rest/v1/rpc/rw_board_rev', (route) => route.abort());                     // no poll can reveal the change before the tap
    await openRewards(page);
    await expect(cell(page, 7)).toHaveAttribute('data-s', 'free');
    fake.rw.takeElsewhere(1, 7);                                                                    // somebody else, a moment ago
    await cell(page, 7).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(page.getByTestId('rw-msg')).toContainText(t('rw.err.taken'));
    await expect(cell(page, 7)).toHaveAttribute('data-s', 'taken');
    await expect(page.getByTestId('rw-confirm')).toHaveCount(0);
    await expect(page.getByTestId('rw-summary')).toContainText(t('rw.left', { n: 3 }));            // nothing was used
    expect(fake.rw.held()).toBe(0);
  });

  test('a tap on a taken number says why and sends nothing; my own number says it is mine', async ({ page }) => {
    const fake = shopWith(900); fake.rw.takeElsewhere(1, 11); fake.rw.pickFor(1, 12); await open(page, fake); await openRewards(page);
    await expect(cell(page, 11)).toHaveAttribute('aria-disabled', 'true'); await expect(cell(page, 11)).toHaveAttribute('aria-label', t('rw.cell.taken', { board: 'Board A', n: '11' }));
    await tapDisabled(page, 11); await expect(page.getByTestId('rw-msg')).toContainText(t('rw.tap.taken', { board: 'Board A', n: '11' }));
    await tapDisabled(page, 12); await expect(page.getByTestId('rw-msg')).toContainText(t('rw.tap.mine', { board: 'Board A', n: '12' }));
    await expect(page.getByTestId('rw-confirm')).toHaveCount(0); expect(claims(fake).length).toBe(0);
    await expect(cell(page, 12)).toHaveAttribute('aria-label', t('rw.cell.mine', { board: 'Board A', n: '12' }));
  });

  test('status is shown by text and shape, not by colour alone: every number carries its number, its state is in its name, and taken / mine / shared look different without colour', async ({ page }) => {
    const fake = shopWith(900); fake.rw.takeElsewhere(1, 3); fake.rw.pickFor(1, 4); await open(page, fake); await openRewards(page);
    await expect(cell(page, 3)).toHaveText('03'); await expect(cell(page, 4)).toContainText('04');
    await page.getByTestId('rw-tab-3').click(); fake.rw.takeElsewhere(3, 5, 'x'); fake.rw.takeElsewhere(3, 5, 'y');
    await page.reload(); await openRewards(page); await page.getByTestId('rw-tab-3').click();
    await expect(cell(page, 5)).toHaveAttribute('data-s', 'shared'); await expect(cell(page, 5)).toContainText('2');   // the number of people
    await expect(cell(page, 5)).toHaveAttribute('aria-label', t('rw.cell.shared', { board: 'Board C', n: '05', c: 2 }));
    const look = await page.evaluate(() => { const g = (n: number, board: string) => { const e = document.querySelector(`[data-testid="rw-grid"] [data-n="${n}"]`) as HTMLElement; const s = getComputedStyle(e); const a = getComputedStyle(e, '::after'); return [s.borderStyle, s.backgroundImage === 'none' ? 'plain' : 'pattern', s.textDecorationLine, a.content, board].join('|'); }; return { shared: g(5, 'C'), free: g(6, 'C') }; });
    expect(look.shared).not.toBe(look.free);
  });

  test('no picks left: the board is read-only with the hint "฿300 more on one bill earns a pick"', async ({ page }) => {
    const fake = shopWith(299, 250); fake.rw.takeElsewhere(1, 9); await open(page, fake); await openRewards(page);              // two bills under 300: bills are never combined, so no pick
    await expect(page.getByTestId('rw-summary')).toContainText(t('rw.left', { n: 0 }));
    await expect(page.getByTestId('rw-hint')).toContainText(t('rw.noRights', { amount: '฿300' }));
    await expect(cell(page, 20)).toHaveAttribute('aria-disabled', 'true');
    await tapDisabled(page, 20); await expect(page.getByTestId('rw-confirm')).toHaveCount(0); await expect(page.getByTestId('rw-msg')).toContainText(t('rw.noRights', { amount: '฿300' }));
    await expect(cell(page, 9)).toHaveAttribute('data-s', 'taken');                                  // the board itself is still shown
    expect(claims(fake).length).toBe(0);
  });

  test('all picks used: the same read-only board and hint', async ({ page }) => {
    const fake = shopWith(600); fake.rw.pickFor(1, 1); fake.rw.pickFor(2, 2); await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-summary')).toContainText('ได้รับ 2 · ใช้แล้ว 2 · เหลือ 0');
    await expect(page.getByTestId('rw-hint')).toBeVisible(); await expect(cell(page, 40)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('rw-mine')).toContainText('Board A #01'); await expect(page.getByTestId('rw-mine')).toContainText('Board B #02');
  });

  test('a locked board is read-only with a banner; the other boards stay open', async ({ page }) => {
    const fake = shopWith(900); fake.rw.lockBoard(2); await open(page, fake); await openRewards(page);
    await page.getByTestId('rw-tab-2').click();
    await expect(page.getByTestId('rw-locked')).toContainText(t('rw.locked'));
    await tapDisabled(page, 30); await expect(page.getByTestId('rw-confirm')).toHaveCount(0);
    await page.getByTestId('rw-tab-1').click(); await expect(page.getByTestId('rw-locked')).toHaveCount(0);
    await cell(page, 30).click(); await expect(page.getByTestId('rw-confirm')).toBeVisible();
  });

  test('a paused event and a closed event are read-only with their banners; no event says so', async ({ page }) => {
    const fake = shopWith(900); fake.rw.setEventStatus('paused'); await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-event-banner')).toContainText(t('rw.ev.paused')); await tapDisabled(page, 1); await expect(page.getByTestId('rw-confirm')).toHaveCount(0);
    fake.rw.setEventStatus('closed'); await page.reload(); await openRewards(page);
    await expect(page.getByTestId('rw-event-banner')).toContainText(t('rw.ev.closed'));
  });
  test('no event is running', async ({ page }) => {
    const fake = new FakeShop(); fake.rw.enabled = true; await open(page, fake); await openRewards(page);
    await expect(page.getByText(t('rw.noEvent'))).toBeVisible(); await expect(page.getByTestId('rw-grid')).toHaveCount(0);
  });
  test('a shared board: a number others hold can be picked again (it shows how many), an exclusive holder blocks it', async ({ page }) => {
    const fake = shopWith(900); fake.rw.takeElsewhere(3, 5, 'x'); fake.rw.takeElsewhere(3, 6, 'y'); fake.rw.setMode(3, 'shared');
    fake.rw.world.selections.find((s) => s.number === 6)!.exclusive = true;                         // held exclusively before the board became shared
    await open(page, fake); await openRewards(page); await page.getByTestId('rw-tab-3').click();
    await expect(page.getByTestId('rw-mode')).toContainText(t('rw.mode.shared'));
    await expect(cell(page, 5)).toHaveAttribute('data-s', 'shared'); await expect(cell(page, 6)).toHaveAttribute('data-s', 'taken');
    await cell(page, 5).click(); await expect(page.getByTestId('rw-confirm')).toContainText(t('rw.confirm.q', { board: 'Board C', n: '05' })); await page.getByTestId('rw-confirm-yes').click();
    await expect(cell(page, 5)).toHaveAttribute('data-s', 'mine'); await expect(cell(page, 5)).toContainText('2');
  });
  test('an event with a hold: the pick is reserved and confirmed in one go, with no extra step for the customer', async ({ page }) => {
    const fake = shopWith(900); fake.rw.enable({ hold_minutes: 5 }); await open(page, fake); await openRewards(page);
    await cell(page, 14).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(cell(page, 14)).toHaveAttribute('data-s', 'mine');
    expect(claims(fake).length).toBe(1); expect(fake.count('rw_confirm_selection')).toBe(1);
    expect(fake.rw.world.selections[0].status).toBe('confirmed');
  });
  test('every refusal of a claim is explained and refreshes the board: locked, closed, no picks left', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake);
    await page.route('**/rest/v1/rpc/rw_board_rev', (route) => route.abort());
    await openRewards(page);
    fake.rw.lockBoard(1); await cell(page, 2).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(page.getByTestId('rw-msg')).toContainText(t('rw.err.locked')); await expect(page.getByTestId('rw-locked')).toBeVisible();
    fake.rw.lockBoard(1, false); await page.getByTestId('rw-tab-2').click(); await page.getByTestId('rw-tab-1').click();
    await page.reload(); await page.route('**/rest/v1/rpc/rw_board_rev', (route) => route.abort()); await openRewards(page);
    fake.rw.setEventStatus('closed'); await cell(page, 2).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(page.getByTestId('rw-msg')).toContainText(t('rw.err.event')); await expect(page.getByTestId('rw-event-banner')).toContainText(t('rw.ev.closed'));
    expect(fake.rw.held()).toBe(0);
  });
});

test.describe('two customers, one board', () => {
  test('both see the same board; what one picks the other sees as taken, and nobody learns who picked', async ({ page, browser }) => {
    const a = shopWith(600); const b = new FakeShop(); b.decorate(); b.rw.world = a.rw.world; b.rw.me = 'cust-b'; b.rw.enable(); b.rw.addBill(300);
    await open(page, a); await openRewards(page);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'th-TH', timezoneId: 'Asia/Bangkok' }); const p2 = await ctx.newPage();
    await open(p2, b); await openRewards(p2);
    await expect(cell(p2, 7)).toHaveAttribute('data-s', 'free');
    await cell(page, 7).click(); await page.getByTestId('rw-confirm-yes').click();
    await expect(cell(page, 7)).toHaveAttribute('data-s', 'mine');
    await expect(cell(p2, 7)).toHaveAttribute('data-s', 'taken', { timeout: 12_000 });             // the poll brings it, no reload
    await expect(cell(p2, 7)).toHaveAttribute('aria-label', t('rw.cell.taken', { board: 'Board A', n: '07' }));
    await expect(p2.getByTestId('rw-mine')).toHaveCount(0);
    expect(await p2.locator('.phone-body').innerText()).not.toMatch(/cust-a|สมชาย/);                // no identity of the other customer on the page
    // the same boards, number for number, apart from "mine"
    const marks = async (p: Page) => p.locator('[data-testid="rw-grid"] button').evaluateAll((els) => els.map((e) => (e.getAttribute('data-s') === 'mine' ? 'taken' : e.getAttribute('data-s'))).join());
    expect(await marks(page)).toBe(await marks(p2));
    await cell(p2, 8).click(); await p2.getByTestId('rw-confirm-yes').click(); await expect(cell(p2, 8)).toHaveAttribute('data-s', 'mine');
    await expect(cell(page, 8)).toHaveAttribute('data-s', 'taken', { timeout: 12_000 });
    expect(a.rw.world.selections.length).toBe(2);
    await ctx.close();
  });
  test('two customers racing for one number: exactly one wins and the loser is told, keeping the pick', async ({ page, browser }) => {
    const a = shopWith(600); const b = new FakeShop(); b.decorate(); b.rw.world = a.rw.world; b.rw.me = 'cust-b'; b.rw.enable(); b.rw.addBill(600);
    await page.route('**/rest/v1/rpc/rw_board_rev', (route) => route.abort());
    await open(page, a); await openRewards(page);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'th-TH', timezoneId: 'Asia/Bangkok' }); const p2 = await ctx.newPage();
    await p2.route('**/rest/v1/rpc/rw_board_rev', (route) => route.abort());
    await open(p2, b); await openRewards(p2);
    await cell(page, 50).click(); await cell(p2, 50).click();                                       // both screens show 50 as free
    await page.getByTestId('rw-confirm-yes').click(); await expect(cell(page, 50)).toHaveAttribute('data-s', 'mine');
    await p2.getByTestId('rw-confirm-yes').click();
    await expect(p2.getByTestId('rw-msg')).toContainText(t('rw.err.taken')); await expect(cell(p2, 50)).toHaveAttribute('data-s', 'taken');
    expect(a.rw.world.selections.filter((s) => s.number === 50).length).toBe(1);
    expect(b.rw.held()).toBe(0); await expect(p2.getByTestId('rw-summary')).toContainText(t('rw.left', { n: 2 }));
    await ctx.close();
  });
});

test.describe('polling', () => {
  test('a number taken elsewhere shows up without a reload; unchanged polls do not reload the board; nothing is polled while the page is hidden or after leaving', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    await expect(cell(page, 42)).toHaveAttribute('data-s', 'free');
    // 1. visible: it polls the three revision numbers every 5 s, and an unchanged board is NOT reloaded
    const revs = () => fake.count('rw_board_rev'); const states = () => fake.count('rw_board_state'); const base = states();      // (the dev build loads twice on mount: count from here)
    await expect.poll(revs, { timeout: 9_000 }).toBeGreaterThanOrEqual(1);
    expect(states()).toBe(base);
    // 2. somebody else picks: the next poll sees a new revision, the board reloads, the number is taken
    fake.rw.takeElsewhere(1, 42);
    await expect(cell(page, 42)).toHaveAttribute('data-s', 'taken', { timeout: 12_000 });
    expect(states()).toBe(base + 1);
    // 3. a hidden page does not poll
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenAt = revs(); await sleep(6_500); expect(revs()).toBe(hiddenAt);
    // 4. visible again: it asks right away and keeps polling
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(revs, { timeout: 7_000 }).toBeGreaterThan(hiddenAt);
    // 5. leaving the screen stops it
    await page.getByRole('button', { name: t('common.back') }).click(); await expect(page.getByTestId('rewards-row')).toBeVisible();
    const goneAt = revs(); await sleep(6_500); expect(revs()).toBe(goneAt);
  });
  test('coming back to the page (window focus) reloads the board and the bills', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake);
    await page.route('**/rest/v1/rpc/rw_board_rev', (route) => route.abort());
    await openRewards(page);
    fake.rw.takeElsewhere(1, 60); fake.rw.addBill(300);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(cell(page, 60)).toHaveAttribute('data-s', 'taken');
    await expect(page.getByTestId('rw-summary')).toContainText(t('rw.earned', { n: 4 }));
  });
});

test.describe('keyboard and accessibility', () => {
  test('the grid is one tab stop with arrow keys; Enter on a number opens the confirm bar, Escape cancels', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    const tabbable = await page.locator('[data-testid="rw-grid"] button[tabindex="0"]').count(); expect(tabbable).toBe(1);
    await cell(page, 0).focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    await expect(cell(page, 11)).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.getByTestId('rw-confirm')).toContainText('#11');
    await expect(page.getByTestId('rw-confirm-yes')).toBeFocused();                                  // a question opened from the keyboard takes the focus: Enter, Enter
    await page.keyboard.press('Escape'); await expect(page.getByTestId('rw-confirm')).toHaveCount(0); await expect(cell(page, 11)).toBeFocused();   // and Escape gives it back
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await expect(cell(page, 11)).toHaveAttribute('data-s', 'mine'); await expect(cell(page, 11)).toBeFocused();
  });
  test('390 px: no horizontal scroll on the account entry, the screen with every state, the confirm bar and the English text; axe finds nothing serious', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); fake.rw.addBill(850); fake.rw.addBill(250); fake.rw.addBill(700, { paid: false }); const back = fake.rw.addBill(900); fake.rw.reversePayment(back.order_no);
    fake.rw.takeElsewhere(1, 3); fake.rw.pickFor(1, 4); fake.rw.takeElsewhere(1, 99); fake.rw.lockBoard(2);
    await open(page, fake);
    const check = async (name: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      expect(bad, `${name}: ${bad.join('\n')}`).toEqual([]);
    };
    await tab(page, t('nav.account')).click(); await expect(page.getByTestId('rewards-row')).toBeVisible(); await noOverflow(page); await check('account');
    await openRewards(page); await page.getByRole('button', { name: t('rw.showAll', { n: 4 }) }).click(); await noOverflow(page); await check('rewards screen');
    await cell(page, 20).click(); await expect(page.getByTestId('rw-confirm')).toBeVisible(); await noOverflow(page); await check('confirm bar');
    await page.getByTestId('rw-tab-2').click(); await expect(page.getByTestId('rw-locked')).toBeVisible(); await noOverflow(page); await check('locked board');
    const box = await cell(page, 20).boundingBox(); await page.getByTestId('rw-tab-1').click();
    const b1 = await cell(page, 20).boundingBox(); expect(b1!.width).toBeGreaterThanOrEqual(30); expect(b1!.height).toBeGreaterThanOrEqual(36); void box;     // big enough to tap on a 390 px phone
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/rewards-board-mobile.png`, fullPage: true });
    await page.getByRole('button', { name: t('common.back') }).click(); await page.getByRole('group', { name: t('acc.language') }).getByRole('button', { name: 'English' }).click();
    await page.getByTestId('rewards-row').click(); await expect(page.getByTestId('rw-summary')).toBeVisible(); await noOverflow(page); await check('english');
  });
});

test.describe('the cart preview line', () => {
  /** 2 x FG-000002 at ฿425 = ฿850 of eligible items */
  async function withCart(page: Page, fake: FakeShop, qty = 2, price = 425, lang: 'th' | 'en' = 'th') {
    fake.item('FG-000002').price = price;
    await page.addInitScript(([uid, q, pr]) => localStorage.setItem(`tc.cart.v1:${uid}`, JSON.stringify([{ sku: 'FG-000002', qty: q, name: 'x', price: pr, image: null, max: null }])), [USER_ID, qty, price] as const);
    await open(page, fake, lang); await tab(page, (lang === 'th' ? t : en)('nav.cart')).click();
  }
  test('"฿850 of eligible items: you will earn 2 picks once paid; ฿50 more for 3 in total", and the totals are the server\'s quote, untouched', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); await withCart(page, fake);
    await expect(page.getByTestId('rw-preview')).toContainText(`${t('rw.cart.picksN', { amount: '฿850', n: 2 })}`);
    await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.more', { more: '฿50', total: 3 }));
    await expect(page.locator('.sp-summary')).toContainText('฿850'); await expect(page.locator('.sp-summary')).toContainText('฿900');   // subtotal and total (shipping ฿50) are the quote's
    expect(fake.calls.filter((c) => c.fn === 'rw_preview_cart').at(-1)!.args.p_items).toEqual([{ sku_code: 'FG-000002', qty: 2 }]);
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/cart-preview-mobile.png`, fullPage: true });
  });
  test('English wording', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable();
    await withCart(page, fake, 2, 425, 'en');
    await expect(page.getByTestId('rw-preview')).toContainText('฿850 of eligible items: you will earn 2 picks once paid'); await expect(page.getByTestId('rw-preview')).toContainText('฿50 more for 3 picks in total');
  });
  test('it follows the cart: ฿250 is below the first step and says how much more earns a pick; adding one more reaches it', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); await withCart(page, fake, 1, 250);
    await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.picksNone', { amount: '฿250' })); await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.more1', { more: '฿50' }));
    await page.getByRole('button', { name: t('p.plus') }).click();                                                   // 2 x 250 = 500: one pick, 100 more for the second
    await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.picks1', { amount: '฿500' })); await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.more', { more: '฿100', total: 2 }));
  });
  test('a rule that gives 2 picks per step: ฿450 earns 2 picks and ฿150 more makes 4 in total', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); fake.rw.rule.reward = 2; await withCart(page, fake, 1, 450);
    await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.picksN', { amount: '฿450', n: 2 }));
    await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.more', { more: '฿150', total: 4 })); await expect(page.getByTestId('rw-preview')).toContainText('รวมเป็น 4 สิทธิ์');
    const call = fake.calls.filter((c) => c.fn === 'rw_preview_cart').at(-1)!; expect(call.args.p_items).toEqual([{ sku_code: 'FG-000002', qty: 1 }]);
  });
  test('an older server without next_reward_total: the earned picks show, the "more for N in total" part is left out (nothing guessed)', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); fake.rw.sendStep = false; await withCart(page, fake);
    await expect(page.getByTestId('rw-preview')).toContainText(t('rw.cart.picksN', { amount: '฿850', n: 2 }));
    await expect(page.getByTestId('rw-preview')).not.toContainText('รวมเป็น');
  });
  test('hidden when rewards are off, and checkout is never blocked', async ({ page }) => {
    const off = new FakeShop(); off.decorate(); await withCart(page, off);
    await expect(page.getByRole('button', { name: t('cart.checkout') })).toBeEnabled(); await expect(page.getByTestId('rw-preview')).toHaveCount(0);
  });
  test('a failing preview call shows nothing and checkout still works', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable(); fake.failNext('rw_preview_cart', 20); await withCart(page, fake);
    await expect(page.getByRole('button', { name: t('cart.checkout') })).toBeEnabled(); await expect.poll(() => fake.count('rw_preview_cart')).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('rw-preview')).toHaveCount(0); await expect(page.locator('.sp-error')).toHaveCount(0);
    await page.getByRole('button', { name: t('cart.checkout') }).click(); await expect(page.getByRole('heading', { name: t('co.title') })).toBeVisible();
  });
  test('a slow preview never holds the checkout button back', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.rw.enable();
    await page.route('**/rest/v1/rpc/rw_preview_cart', async (route) => { await sleep(3_000); await route.fallback(); });
    await withCart(page, fake);
    await expect(page.getByRole('button', { name: t('cart.checkout') })).toBeEnabled();
    await page.getByRole('button', { name: t('cart.checkout') }).click(); await expect(page.getByRole('heading', { name: t('co.title') })).toBeVisible();
  });
});

test.describe('when something is wrong', () => {
  test('rewards switched off while the screen is open: it says so instead of showing a stale board', async ({ page }) => {
    const fake = shopWith(900); await open(page, fake); await openRewards(page);
    fake.rw.enabled = false; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('rw-off')).toContainText(t('rw.off'));
    await expect(page.getByTestId('rw-grid')).toHaveCount(0);
  });
  test('the first load fails: an error with a retry that works (the dev build loads twice, so two failures)', async ({ page }) => {
    const fake = shopWith(900); fake.failNext('rw_my_rewards', 2); await open(page, fake);
    await tab(page, t('nav.account')).click(); await page.getByTestId('rewards-row').click();
    await expect(page.locator('.sp-error')).toBeVisible();
    await page.getByRole('button', { name: t('common.retry') }).click();
    await expect(page.getByTestId('rw-summary')).toBeVisible(); await expect(page.locator('.sp-error')).toHaveCount(0);
  });
  test('the board fails to load but the picks and bills still show, with a retry for the board only', async ({ page }) => {
    const fake = shopWith(900); fake.failNext('rw_board_state', 2); await open(page, fake);
    await tab(page, t('nav.account')).click(); await page.getByTestId('rewards-row').click();
    await expect(page.getByTestId('rw-summary')).toContainText(t('rw.left', { n: 3 })); await expect(page.getByTestId('rw-bills').locator('li')).toHaveCount(1);
    await expect(page.locator('.sp-error')).toBeVisible(); await expect(page.getByTestId('rw-grid')).toHaveCount(0);
    await page.getByRole('button', { name: t('common.retry') }).click();
    await expect(page.getByTestId('rw-grid')).toBeVisible(); await expect(page.locator('.sp-error')).toHaveCount(0);
  });
  test('boards switched off: the picks and bills show and the board area says it is not open yet', async ({ page }) => {
    const fake = shopWith(900); fake.rw.boardsEnabled = false; await open(page, fake); await openRewards(page);
    await expect(page.getByTestId('rw-summary')).toBeVisible(); await expect(page.getByText(t('rw.boardsOff'))).toBeVisible(); await expect(page.getByTestId('rw-grid')).toHaveCount(0);
  });
});
