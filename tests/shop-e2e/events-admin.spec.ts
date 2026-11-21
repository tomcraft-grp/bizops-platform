// Back-office Events, "Online shop" tab, against the fake backend (fakeEventsAdmin.ts hooked in front of fakeBackend.ts). The staff app is English by default.
// What the database allows (SUPER_ADMIN only, a reason for every operation, the confirmation name, one holder per exclusive number, a revision that goes up on every change) is
// enforced and tested for real by the SQL tests; these tests prove that staff can DO the work on the screens, that the five operations are separate and send only what they
// should, that the screens show the server's answer (never a guess), that a refusal is handled, and that the polling is cheap and stops when it should.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import { BOARD_A, BOARD_B, EVENT_ID, FakeEventsAdmin } from './fakeEventsAdmin';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

const REASON = 'Reason (required, recorded in the audit log)';
function world() {
  const fake = new FakeShop();
  const ev = new FakeEventsAdmin(fake).hook();
  ev.take(BOARD_A, 7, 'สมชาย ใจดี', '5678'); ev.take(BOARD_A, 42, 'Mali Rose', '1111');          // Board A: exclusive
  ev.take(BOARD_B, 5, 'Anan', '2222'); ev.take(BOARD_B, 5, 'Boon', '3333');                      // Board B: shared, number 5 held by two customers
  return { fake, ev };
}
async function open(page: Page, fake: FakeShop, role: 'SUPER_ADMIN' | 'ADMIN' = 'SUPER_ADMIN', lang: 'en' | 'th' = 'en') {
  fake.profile.role = role; fake.profile.display_name = 'Boss';
  await fake.install(page);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/events');
  await expect(page.getByRole('heading', { name: lang === 'en' ? 'Events — online shop' : 'กิจกรรม — ร้านค้าออนไลน์' })).toBeVisible();
  await expect(page.locator('.bo-cell')).toHaveCount(100);                                      // Board A's grid, loaded from the server
}
const cell = (page: Page, n: string, state?: string) => page.getByRole('button', { name: new RegExp(`^Number ${n},${state ? ` ${state}` : ''}`) });
const card = (page: Page, name: string) => page.locator('.bo-card', { hasText: name });
const calls = (fake: FakeShop, ...fns: string[]) => fake.calls.filter((c) => fns.includes(c.fn));

test.describe('the page', () => {
  test('opens on "Online shop"; "POS on this device" is the original page and the online tab stops polling when it is left', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    await expect(page.getByRole('tab', { name: 'Online shop' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'POS on this device' })).toBeVisible();
    await expect(page.getByText('Legal review required before launch.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tom-Craft Lucky Numbers' })).toBeVisible();
    await page.getByRole('tab', { name: 'POS on this device' }).click();
    await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();      // the original page (its own header)
    await expect(page.getByText('No events yet')).toBeVisible();                                  // it has its own, local events (none in this browser)
    await expect(page.getByRole('heading', { name: 'Tom-Craft Lucky Numbers' })).toHaveCount(0);
    await page.waitForTimeout(500);
    const n = fake.count('rw_board_rev');
    await page.waitForTimeout(6500);                                                              // more than one polling period
    expect(fake.count('rw_board_rev')).toBe(n);                                                   // unmounted: nothing is read any more
  });

  test('three board cards: mode, lock state, taken / total and the revision; the grid has 100 numbers with the owners', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    await expect(card(page, 'Board A')).toContainText('Exclusive');
    await expect(card(page, 'Board A')).toContainText('Open');
    await expect(card(page, 'Board A')).toContainText('2 / 100 taken');
    await expect(card(page, 'Board A')).toContainText('rev 3');
    await expect(card(page, 'Board B')).toContainText('Shared');
    await expect(card(page, 'Board B')).toContainText('1 / 100 taken');                           // number 5 is one number, held by two customers
    await expect(card(page, 'Board C')).toContainText('Locked');
    await expect(cell(page, '07', 'Taken')).toContainText('สมชาย');                               // the owner on the number
    await expect(cell(page, '42', 'Taken')).toContainText('Mali');
    await expect(cell(page, '08', 'Free')).toBeVisible();
    await cell(page, '07').click();
    await expect(page.getByText('Board A · #07')).toBeVisible();
    await expect(page.getByText('สมชาย ใจดี (…5678)')).toBeVisible();                             // name and the end of the phone number
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-events.png`, fullPage: true });
  });

  test('a shared number shows all its holders; a locked board says so', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    await card(page, 'Board B').click();
    await expect(cell(page, '05', 'Shared')).toContainText('×2');
    await cell(page, '05').click();
    await expect(page.getByText('Anan (…2222)')).toBeVisible(); await expect(page.getByText('Boon (…3333)')).toBeVisible();
    await card(page, 'Board C').click();
    await expect(page.getByText('This board is locked.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock board…' })).toBeVisible();              // the one that applies: not "Lock"
    await expect(page.getByRole('button', { name: 'Lock board…', exact: true })).toHaveCount(0);
  });
});

test.describe('the five operations are separate', () => {
  test('lock and unlock change the state only: a reason is needed, nothing else is called, the numbers stay', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    await page.getByRole('button', { name: 'Lock board…' }).click();
    const go = page.getByRole('button', { name: 'Lock board', exact: true });
    await expect(go).toBeDisabled();                                                              // no reason yet
    await page.getByLabel(REASON).fill('   ');
    await expect(go).toBeDisabled();                                                              // blanks are not a reason
    await page.getByLabel(REASON).fill('Prize draw tonight');
    await go.click();
    await expect(page.getByText('This board is locked.')).toBeVisible();
    await expect(card(page, 'Board A')).toContainText('Locked');
    expect(calls(fake, 'rw_board_lock')).toHaveLength(1);
    expect(calls(fake, 'rw_board_lock')[0].args).toEqual({ p_board: BOARD_A, p_reason: 'Prize draw tonight' });
    expect(calls(fake, 'rw_board_set_mode', 'rw_board_reset', 'rw_release_selection', 'rw_board_unlock')).toHaveLength(0);
    await expect(page.locator('.bo-cell.taken')).toHaveCount(2);                                  // the selections are untouched
    await page.getByRole('button', { name: 'Unlock board…' }).click();
    await page.getByLabel(REASON).fill('Draw finished');
    await page.getByRole('button', { name: 'Unlock board', exact: true }).click();
    await expect(page.getByText('This board is locked.')).toHaveCount(0);
    expect(calls(fake, 'rw_board_unlock')[0].args).toEqual({ p_board: BOARD_A, p_reason: 'Draw finished' });
  });

  test('switch mode changes the mode only: existing selections are kept and shown as the server returns them', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    await expect(page.getByText('From now on several customers may hold the same number.')).toBeVisible();   // what it does, before pressing
    await page.getByRole('button', { name: 'Switch to Shared…' }).click();
    await page.getByLabel(REASON).fill('Two friends want the same number');
    await page.getByRole('button', { name: 'Switch to Shared', exact: true }).click();
    await expect(card(page, 'Board A')).toContainText('Shared');
    await expect(page.getByRole('button', { name: 'Switch to Exclusive…' })).toBeVisible();
    expect(calls(fake, 'rw_board_set_mode')[0].args).toEqual({ p_board: BOARD_A, p_mode: 'shared', p_reason: 'Two friends want the same number' });
    expect(calls(fake, 'rw_board_lock', 'rw_board_unlock', 'rw_board_reset', 'rw_release_selection')).toHaveLength(0);
    await expect(page.locator('.bo-cell.taken')).toHaveCount(2);                                  // still two numbers held by one customer each
    await expect(page.locator('.bo-cell.shared')).toHaveCount(0);
  });

  test('release one number: only that number is freed, with a reason', async ({ page }) => {
    const { fake, ev } = world(); await open(page, fake);
    await cell(page, '42').click();
    await page.getByRole('button', { name: 'Release number…' }).click();
    const go = page.getByRole('button', { name: 'Release #42', exact: true });
    await expect(go).toBeDisabled();
    await page.getByLabel(REASON).fill('Customer asked');
    await go.click();
    await expect(cell(page, '42', 'Free')).toBeVisible();
    await expect(cell(page, '07', 'Taken')).toBeVisible();                                        // nobody else is touched
    const sel = ev.sels.find((s) => s.n === 42 && s.board === BOARD_A)!;
    expect(calls(fake, 'rw_release_selection')[0].args).toEqual({ p_selection: sel.id, p_reason: 'Customer asked' });
    expect(calls(fake, 'rw_board_reset', 'rw_board_set_mode', 'rw_board_lock')).toHaveLength(0);
  });

  test('reset needs the reason and the board name typed; picks are returned by default; the history keeps the reset; undo restores it', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    await page.getByRole('button', { name: 'Reset board…' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Reset Board A?');
    await expect(dlg).toContainText('2 numbers are taken on this board now.');
    const go = dlg.getByRole('button', { name: 'Reset board', exact: true });
    await expect(dlg.getByRole('checkbox', { name: 'Return picks to customers' })).toBeChecked();   // ticked by default
    await expect(go).toBeDisabled();
    await dlg.getByLabel(REASON).fill('New round');
    await expect(go).toBeDisabled();                                                              // the name is not typed yet
    await dlg.getByLabel('Type Board A to confirm').fill('board a');
    await expect(go).toBeDisabled();                                                              // case matters
    await dlg.getByLabel('Type Board A to confirm').fill('Board A');
    await go.click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('.bo-cell.taken')).toHaveCount(0);                                  // the server's answer: nothing is taken
    expect(calls(fake, 'rw_board_reset')[0].args).toEqual({ p_board: BOARD_A, p_reason: 'New round', p_return_picks: true, p_confirm: 'Board A' });
    await expect(card(page, 'Board A')).toContainText('0 / 100 taken');
    await expect(page.getByText('Nothing to reset: no number is taken on this board.')).toBeVisible();   // nothing to reset: no button that does nothing
    await page.getByRole('tab', { name: /Resets/ }).click();
    await expect(page.getByText('New round')).toBeVisible();
    await expect(page.getByText('2 numbers cleared')).toBeVisible();
    await expect(page.getByText('Picks returned to customers')).toBeVisible();
    await page.getByRole('button', { name: 'Undo reset…' }).click();
    await page.getByLabel(REASON).fill('Reset by mistake');
    await page.getByRole('button', { name: 'Undo reset', exact: true }).click();
    await expect(page.locator('.bo-cell.taken')).toHaveCount(2);                                  // restored
    expect(calls(fake, 'rw_board_undo_reset')[0].args).toEqual({ p_reset: 'rs-1', p_reason: 'Reset by mistake' });
    await expect(page.getByText(/Undone /)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo reset…' })).toHaveCount(0);               // done: it cannot be undone twice
  });

  test('reset without returning the picks sends false; an undo that the server refuses says why and changes nothing', async ({ page }) => {
    const { fake, ev } = world(); await open(page, fake);
    await page.getByRole('button', { name: 'Reset board…' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('checkbox', { name: 'Return picks to customers' }).uncheck();
    await expect(dlg).toContainText('the picks stay used');
    await dlg.getByLabel(REASON).fill('Test');
    await dlg.getByLabel('Type Board A to confirm').fill('Board A');
    await dlg.getByRole('button', { name: 'Reset board', exact: true }).click();
    await expect(page.locator('.bo-cell.taken')).toHaveCount(0);
    expect(calls(fake, 'rw_board_reset')[0].args).toMatchObject({ p_return_picks: false });
    ev.take(BOARD_A, 7, 'Someone New', '0000');                                                   // a number cleared by the reset is taken again
    await expect(cell(page, '07', 'Taken')).toBeVisible({ timeout: 12_000 });                     // seen through the poll
    await page.getByRole('tab', { name: /Resets/ }).click();
    await page.getByRole('button', { name: 'Undo reset…' }).click();
    await page.getByLabel(REASON).fill('Oops');
    await page.getByRole('button', { name: 'Undo reset', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('has been taken again, so it cannot be restored');
    await expect(page.locator('.bo-cell.taken')).toHaveCount(1);                                  // the board is exactly what the server said
  });
});

test.describe('who may do what', () => {
  test('an Admin sees the board and its owners but has no operation to press', async ({ page }) => {
    const { fake } = world(); await open(page, fake, 'ADMIN');
    await expect(page.getByText('Only a Super Admin can lock or unlock a board, switch its mode, release a number or reset a board.')).toBeVisible();
    for (const name of [/Lock board/, /Unlock board/, /Switch to/, /Reset board/]) await expect(page.getByRole('button', { name })).toHaveCount(0);
    await cell(page, '07').click();
    await expect(page.getByText('สมชาย ใจดี (…5678)')).toBeVisible();                             // staff see who holds a number
    await expect(page.getByRole('button', { name: /Release number/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible();                  // Admin edits events (the server decides)
    expect(calls(fake, 'rw_board_lock', 'rw_board_unlock', 'rw_board_set_mode', 'rw_release_selection', 'rw_board_reset', 'rw_board_undo_reset')).toHaveLength(0);
  });

  test('when the server says no (rights changed), the screen says so, hides the controls and shows the unchanged board', async ({ page }) => {
    const { fake, ev } = world(); await open(page, fake, 'SUPER_ADMIN');
    fake.profile.role = 'ADMIN';                                                                  // the database now knows this person is no Super Admin
    await page.getByRole('button', { name: 'Lock board…' }).click();
    await page.getByLabel(REASON).fill('Try');
    await page.getByRole('button', { name: 'Lock board', exact: true }).click();
    await expect(page.getByText('The server refused: only a Super Admin can do this.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Lock board|Switch to|Reset board/ })).toHaveCount(0);
    expect(ev.refused).toContain('super');
    await expect(card(page, 'Board A')).toContainText('Open');                                    // nothing was changed, nothing is shown as changed
  });
});

test.describe('needs review', () => {
  test('a right whose bill was taken back: the number is kept or released only by a Super Admin, with a reason', async ({ page }) => {
    const { fake, ev } = world(); ev.addReview(); await open(page, fake);
    await expect(page.getByRole('tab', { name: /Needs review/ })).toContainText('1');
    await page.getByRole('tab', { name: /Needs review/ }).click();
    await expect(page.getByText('วิภา ทดสอบ')).toBeVisible();
    await expect(page.getByText('Number picks per bill · Board A #7')).toBeVisible();
    await page.getByRole('button', { name: 'Keep number…' }).click();
    await expect(page.getByText('The customer keeps this number. Nothing changes on the board.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep number', exact: true })).toBeDisabled();
    await page.getByLabel(REASON).fill('Customer paid in cash');
    await page.getByRole('button', { name: 'Keep number', exact: true }).click();
    await expect(page.getByText('Nothing needs review.')).toBeVisible();                           // the queue the server returned
    expect(calls(fake, 'rw_admin_resolve_review')[0].args).toEqual({ p_entitlement: 'ent-1', p_action: 'keep', p_reason: 'Customer paid in cash' });
  });

  test('an Admin sees the queue but cannot decide', async ({ page }) => {
    const { fake, ev } = world(); ev.addReview(); await open(page, fake, 'ADMIN');
    await page.getByRole('tab', { name: /Needs review/ }).click();
    await expect(page.getByText('วิภา ทดสอบ')).toBeVisible();
    await expect(page.getByRole('button', { name: /Keep number|Release number/ })).toHaveCount(0);
    await expect(page.getByText('Only a Super Admin can decide these.')).toBeVisible();
  });
});

test.describe('history and audit log', () => {
  test('History is this board; the Audit log is the whole event, newest first, with the reason', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    await page.getByRole('button', { name: 'Lock board…' }).click();
    await page.getByLabel(REASON).fill('Audit me');
    await page.getByRole('button', { name: 'Lock board', exact: true }).click();
    await expect(page.getByText('This board is locked.')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Board locked' })).toBeVisible();                  // the History tab (this board)
    await expect(page.getByRole('cell', { name: 'Audit me' })).toBeVisible();
    await page.getByRole('tab', { name: 'Audit log' }).click();
    await expect(page.getByRole('cell', { name: 'Board locked' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Number picked' }).first()).toBeVisible();          // the event's other boards too
    expect(calls(fake, 'rw_admin_log')[0].args).toMatchObject({ p_event: EVENT_ID, p_limit: 50, p_offset: 0 });
  });
});

test.describe('staying current', () => {
  test('every 5 s only the three revisions are read; a board is reloaded only when its revision changed; a hidden page does not poll', async ({ page }) => {
    const { fake, ev } = world(); await open(page, fake);
    const boardLoads = () => fake.count('rw_admin_board');
    const before = boardLoads();
    await expect.poll(() => fake.count('rw_board_rev'), { timeout: 12_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(5500);
    expect(boardLoads()).toBe(before);                                                            // nothing changed: no board was reloaded
    ev.take(BOARD_A, 63, 'Nok', '9999');                                                          // a customer takes a number in the shop
    await expect(cell(page, '63', 'Taken')).toBeVisible({ timeout: 12_000 });                     // shown without reloading the page
    await expect(card(page, 'Board A')).toContainText('3 / 100 taken');
    expect(boardLoads()).toBe(before + 1);                                                        // exactly the one board that changed
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(400);
    const n = fake.count('rw_board_rev');
    await page.waitForTimeout(6500);
    expect(fake.count('rw_board_rev')).toBe(n);                                                   // the page is hidden: no polling
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => fake.count('rw_board_rev'), { timeout: 8000 }).toBeGreaterThan(n);    // visible again: reads at once
  });

  test('a failing connection is said, not hidden', async ({ page }) => {
    const { fake } = world(); await open(page, fake);
    fake.failNext('rw_board_rev', 3);                                                              // three reads in a row fail, then the connection is back
    await expect(page.getByText('Live updates are paused because the connection is failing.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Live updates are paused because the connection is failing.')).toHaveCount(0, { timeout: 20_000 });   // and it clears by itself
  });
});

test.describe('events', () => {
  test('create an event (checked before it is sent), open its three boards, activate it with a reason', async ({ page }) => {
    const { fake } = world(); await open(page, fake, 'ADMIN');
    await page.getByRole('button', { name: 'New event' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Save event' }).click();
    await expect(dlg.getByText('Give the event a name.')).toBeVisible();
    await dlg.getByLabel('Name', { exact: true }).fill('Christmas numbers');
    await dlg.getByLabel('Number from').fill('10'); await dlg.getByLabel('Number to').fill('5');
    await dlg.getByRole('button', { name: 'Save event' }).click();
    await expect(dlg.getByText(/Numbers must be whole, from 0 up/)).toBeVisible();
    expect(calls(fake, 'rw_admin_save_event')).toHaveLength(0);                                    // a wrong form is never sent
    await dlg.getByLabel('Number from').fill('0'); await dlg.getByLabel('Number to').fill('99');
    await dlg.getByRole('button', { name: 'Save event' }).click();
    await expect(dlg).toHaveCount(0);
    expect(calls(fake, 'rw_admin_save_event')[0].args).toEqual({ p_id: null, p_patch: { name: 'Christmas numbers', description: null, starts_at: null, ends_at: null, number_min: 0, number_max: 99, hold_minutes: 0, max_per_customer: null } });
    await expect(page.getByRole('heading', { name: 'Christmas numbers' })).toBeVisible();
    await expect(page.locator('.bo-card')).toHaveCount(3);
    await expect(page.getByText('Final at once')).toBeVisible();
    await page.getByRole('button', { name: 'Activate…' }).click();
    await expect(page.getByRole('button', { name: 'Activate', exact: true })).toBeDisabled();       // a reason first
    await page.getByLabel(REASON).fill('Ready');
    await page.getByRole('button', { name: 'Activate', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause…' })).toBeVisible();                       // the server's status decides which buttons exist
    expect(calls(fake, 'rw_admin_set_event_status')[0].args).toEqual({ p_id: 'ev-2', p_status: 'active', p_reason: 'Ready' });
  });

  test('the dates are Bangkok time; an active event outside its dates is flagged; the form shows what the server has', async ({ page }) => {
    const { fake, ev } = world();
    ev.events[0].starts_at = new Date(Date.now() + 86_400_000).toISOString(); ev.events[0].hold_minutes = 15; ev.events[0].max_per_customer = 3;
    await open(page, fake, 'ADMIN');
    await expect(page.getByText('This event is active, but its dates are not running now, so customers cannot pick numbers.')).toBeVisible();
    await expect(page.getByText('Not started yet')).toBeVisible();
    await expect(page.getByText('15 min')).toBeVisible();
    await page.getByRole('button', { name: 'Edit event' }).click();
    await expect(page.getByLabel('Hold minutes')).toHaveValue('15');
    await expect(page.getByLabel('Max picks per customer')).toHaveValue('3');
    await expect(page.getByLabel('Starts (Bangkok time)')).toHaveValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

test.describe('rename and recolour a board', () => {
  test('an Admin edits the name and colour inline, no dialog: only the changes are sent and the server\'s board is shown', async ({ page }) => {
    const { fake } = world(); await open(page, fake, 'ADMIN');
    await page.getByRole('button', { name: 'Rename or recolour' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const save = page.getByRole('button', { name: 'Save board' });
    await expect(save).toBeDisabled();                                                            // nothing changed yet
    await page.getByLabel('Board name').fill('   ');
    await expect(page.getByText('Give the board a name of 1 to 40 characters.')).toBeVisible();
    await expect(save).toBeDisabled();                                                            // a blank name is never sent
    await page.getByLabel('Board name').fill('Lucky A');
    await page.getByRole('radio', { name: 'Green' }).click();
    await expect(page.getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-checked', 'true');
    await save.click();
    await expect(card(page, 'Lucky A')).toBeVisible();                                            // the card
    await expect(card(page, 'Lucky A').locator('.ch-dot')).toHaveCSS('background-color', 'rgb(47, 158, 68)');
    await expect(page.getByRole('heading', { name: 'Lucky A' })).toBeVisible();                   // and the open board's header
    await expect(page.getByRole('button', { name: 'Save board' })).toHaveCount(0);                // the form closed
    expect(calls(fake, 'rw_admin_save_board')).toHaveLength(1);
    expect(calls(fake, 'rw_admin_save_board')[0].args).toEqual({ p_board: BOARD_A, p_patch: { name: 'Lucky A', color: '#2f9e44' } });
    await page.getByRole('button', { name: 'Rename or recolour' }).click();                       // only the colour this time
    await page.getByRole('radio', { name: 'Blue' }).click();
    await page.getByRole('button', { name: 'Save board' }).click();
    await expect(page.getByRole('button', { name: 'Save board' })).toHaveCount(0);
    expect(calls(fake, 'rw_admin_save_board')[1].args).toEqual({ p_board: BOARD_A, p_patch: { color: '#2a78d6' } });
    await expect(page.getByRole('cell', { name: 'Number picked' }).first()).toBeVisible();        // the History tab still shows the board's log
  });

  test('a refusal of the server is shown in the form, which stays open and the board stays as it was', async ({ page }) => {
    const { fake } = world(); await open(page, fake, 'ADMIN');
    await page.getByRole('button', { name: 'Rename or recolour' }).click();
    await page.getByLabel('Board name').fill('Board B');                                          // another board of the event has this name
    await page.getByRole('button', { name: 'Save board' }).click();
    await expect(page.getByRole('alert')).toContainText('another board of this event already has that name');
    await expect(page.getByLabel('Board name')).toHaveValue('Board B');                           // nothing is lost: the form stays
    await expect(card(page, 'Board A')).toBeVisible();                                            // and the card shows what the server has
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Board name')).toHaveCount(0);
  });
});

test.describe('what needs a Super Admin on an event', () => {
  test('an Admin is not offered "Close"; the range is locked once numbers are taken; an edit sends only what changed', async ({ page }) => {
    const { fake } = world(); await open(page, fake, 'ADMIN');
    await expect(page.getByRole('button', { name: 'Pause…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close…' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit event' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('Number from')).toBeDisabled(); await expect(dlg.getByLabel('Number to')).toBeDisabled();
    await expect(dlg.getByText('Only a Super Admin can change the number range once numbers are taken.')).toBeVisible();
    await dlg.getByLabel('Name', { exact: true }).fill('Tom-Craft Renamed');
    await dlg.getByRole('button', { name: 'Save event' }).click();
    await expect(dlg).toHaveCount(0);
    expect(calls(fake, 'rw_admin_save_event')[0].args).toEqual({ p_id: EVENT_ID, p_patch: { name: 'Tom-Craft Renamed' } });   // no range in it
    await expect(page.getByRole('heading', { name: 'Tom-Craft Renamed' })).toBeVisible();
  });

  test('a Super Admin may close an event and change the range; a range below a held number is refused in the server\'s words, inline', async ({ page }) => {
    const { fake } = world(); await open(page, fake, 'SUPER_ADMIN');
    await expect(page.getByRole('button', { name: 'Close…' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit event' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('Number to')).toBeEnabled();
    await dlg.getByLabel('Number to').fill('20');                                                  // number 42 is held
    await dlg.getByRole('button', { name: 'Save event' }).click();
    await expect(dlg.getByText('number 42 is held, so the range cannot end below it')).toBeVisible();
    await expect(dlg).toBeVisible();                                                              // the form stays, nothing was saved
    await dlg.getByLabel('Number to').fill('199');                                                 // growing the range is allowed
    await dlg.getByRole('button', { name: 'Save event' }).click();
    await expect(dlg).toHaveCount(0);
    expect(calls(fake, 'rw_admin_save_event').pop()!.args).toEqual({ p_id: EVENT_ID, p_patch: { number_max: 199 } });
    await expect(page.getByText(/000–199/)).toBeVisible();
    await page.getByRole('button', { name: 'Close…' }).click();
    await page.getByLabel(REASON).fill('Draw done');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause…' })).toHaveCount(0);                    // closed: nothing more to do
    expect(calls(fake, 'rw_admin_set_event_status')[0].args).toEqual({ p_id: EVENT_ID, p_status: 'closed', p_reason: 'Draw done' });
  });
});

test.describe('on a phone and in Thai', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('no sideways scroll, nothing serious for accessibility, the reset panel fits; Thai text', async ({ page }) => {
    const { fake } = world(); await open(page, fake, 'SUPER_ADMIN', 'th');
    await expect(page.getByRole('tab', { name: 'ร้านค้าออนไลน์' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'POS บนอุปกรณ์เครื่องนี้' })).toBeVisible();
    await expect(page.getByText('การควบคุมของ Super Admin')).toBeVisible();
    await page.getByRole('button', { name: /^เลข 07,/ }).click();
    await expect(page.getByText('สมชาย ใจดี (…5678)')).toBeVisible();
    const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await over()).toBeLessThanOrEqual(1);
    const bad = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes[0].target.join(' ')}`);
    expect(await bad()).toEqual([]);
    await page.getByRole('button', { name: /^รีเซ็ตกระดาน/ }).click();
    await expect(page.getByRole('dialog')).toContainText('รีเซ็ต Board A?');
    expect(await over()).toBeLessThanOrEqual(1);
    expect(await bad()).toEqual([]);
  });
});
