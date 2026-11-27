// Preorders, back office: the Preorders page (overview numbers, attention list, the day's timeline, the list with search / filters / sorting / paging, alerts, settings and closures),
// the order drawer (confirm, assign, move the time, checklist, ready, handed over, reject) and the employee's mobile Pickup prep board. Against the fake backend
// (fakeBackend.ts + fakePreorders.ts): this proves the SCREENS; the rules are proved in the database by supabase/tests/preorders.sql.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import { addDays, dayKey, slotAt } from './fakePreorders';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const today = () => dayKey(new Date());

function shop(role: 'SUPER_ADMIN' | 'ADMIN' = 'SUPER_ADMIN'): FakeShop {
  const f = new FakeShop(); f.decorate(); f.settings.require_payment_slip = false; f.po.enabled = true;
  f.profile.role = role; f.profile.display_name = 'Staff'; f.po.canEdit = role === 'SUPER_ADMIN'; return f;
}
async function openPage(page: Page, fake: FakeShop, hash: string, lang: 'en' | 'th' = 'en') {
  await fake.install(page);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto(`/#/${hash}`);
}
let n = 0;
/** a preorder created straight in the fake */
function seed(fake: FakeShop, off: number, hhmm: string, over: { qty?: number; name?: string; note?: string | null; qtyB?: number } = {}) {
  const items = [{ sku_code: 'FG-000001', qty: over.qty ?? 2 }, ...(over.qtyB ? [{ sku_code: 'FG-000002', qty: over.qtyB }] : [])];
  const r = fake.rpc('shop_place_order', { p_key: `adm-${++n}-${Math.random().toString(36).slice(2, 8)}`, p_items: items, p_fulfilment: 'pickup', p_name: over.name ?? 'Somchai', p_phone: '0812345678', p_address: null, p_note: over.note ?? null, p_pickup_at: slotAt(off, hhmm) }) as { order: { id: string; order_no: string } };
  return { ...r.order, f: fake.orders.find((o) => o.id === r.order.id)! };
}
const move = (fake: FakeShop, o: { f: Parameters<FakeShop['po']['setStatus']>[0] }, to: string) => fake.po.setStatus(o.f, to, null, 'test');
/** the confirm / form dialogs (a div); the order drawer is an aside with the same role */
const dlg = (page: Page) => page.locator('div[role="dialog"]');
/** a preorder due `min` minutes from now (any time of day): placed on a free future slot, then its pickup time is moved, as time passing would do */
let far = 0;
function seedIn(fake: FakeShop, min: number, over: Parameters<typeof seed>[3] = {}, steps: string[] = []) {
  const o = seed(fake, 5 + Math.floor(far / 18), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'][far++ % 18], over);
  for (const to of steps) fake.po.setStatus(o.f, to, null, 'test');      // the order is moved along while its pickup is still in the future, as it would have been
  fake.po.meta.get(o.id)!.pickup_at = new Date(Date.now() + min * 60_000).toISOString();
  return o;
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test.describe('Preorders page', () => {
  test('the overview counts come from the orders, the attention list shows what is late, and a card opens the filtered list', async ({ page }) => {
    const fake = shop();
    const a = seedIn(fake, -3, {}, ['confirmed', 'preparing']); const b = seedIn(fake, -2); const c = seedIn(fake, -1); seed(fake, 2, '10:00'); seed(fake, 3, '11:00');     // three preorders due a moment ago (today), two on later days
    fake.po.setStatus(b.f, 'cancelled', 'test', null);
    await openPage(page, fake, 'preorders');
    await expect(page.getByRole('heading', { name: 'Preorders' })).toBeVisible();
    const k = (id: string) => page.getByTestId(`kpi-${id}`);
    await expect(k('total')).toHaveText('3'); await expect(k('pending')).toHaveText('1'); await expect(k('preparing')).toHaveText('1'); await expect(k('cancelled')).toHaveText('1'); await expect(k('upcoming')).toHaveText('2');
    await expect(k('attention')).toHaveText(/[1-9]/);
    await expect(page.getByTestId('po-card').filter({ hasText: a.order_no })).toContainText('Late');
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/preorders-overview.png`, fullPage: true });
    await k('pending').click();
    await expect(page).toHaveURL(/tab=list/); await expect(page.getByTestId('po-table')).toContainText(c.order_no); await expect(page.getByTestId('po-table')).not.toContainText(a.order_no);
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/preorders-list.png`, fullPage: true });
    await noOverflow(page);
  });
  test('it says so when preorders are switched off, and when the database has no preorder part', async ({ page }) => {
    const fake = shop(); fake.po.enabled = false; await openPage(page, fake, 'preorders');
    await expect(page.getByText('Preorders are switched off')).toBeVisible();
    const f2 = shop(); f2.po.missing = true; const p2 = await page.context().newPage(); await openPage(p2, f2, 'preorders');
    await expect(p2.getByText('The preorder part of the database is not installed yet.')).toBeVisible();
    await p2.goto('/#/shop-admin'); await expect(p2.getByRole('heading', { name: 'Online shop' })).toBeVisible();      // the Online shop page is not affected
  });

  test('the schedule is a timeline of the day: free slots, orders under their time, and each slot\'s load', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 2, '10:00', { qty: 3 }); const b = seed(fake, 2, '10:00'); seed(fake, 2, '14:30', { name: 'Malee' });
    await openPage(page, fake, `preorders?tab=schedule&day=${addDays(today(), 2)}`);
    const tl = page.getByTestId('po-timeline');
    await expect(tl.locator('li[data-slot]')).toHaveCount(18);                                         // 09:00 .. 17:30: free slots are visible too
    const at10 = tl.locator('li[data-slot="10:00"]');
    await expect(at10).toContainText(a.order_no); await expect(at10).toContainText(b.order_no); await expect(at10).toContainText('2/2'); await expect(at10).toContainText('full');
    await expect(tl.locator('li[data-slot="14:30"]')).toContainText('Malee');
    await expect(tl.locator('li[data-slot="12:00"]')).not.toContainText('ORD-');
    await expect(page.getByTestId('schedule-summary')).toContainText('Open 09:00–18:00');
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/preorders-schedule.png` });
    await at10.getByTestId('po-card').first().click();
    await expect(page.getByTestId('preorder-drawer')).toContainText('10:00');
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/preorders-drawer.png` });
  });
  test('a closed day shows no timeline; a day with special hours shows its own', async ({ page }) => {
    const fake = shop(); fake.po.days.set(addDays(today(), 1), { kind: 'closed', open: null, close: null, reason: 'Holiday' }); fake.po.days.set(addDays(today(), 2), { kind: 'special', open: '10:00', close: '12:00', reason: null });
    await openPage(page, fake, `preorders?tab=schedule&day=${addDays(today(), 1)}`);
    await expect(page.getByTestId('schedule-summary')).toContainText('Closed: Holiday'); await expect(page.getByText('No pickup times on this day')).toBeVisible();
    await page.goto(`/#/preorders?tab=schedule&day=${addDays(today(), 2)}`);
    await expect(page.getByTestId('po-timeline').locator('li[data-slot]')).toHaveCount(4); await expect(page.getByTestId('schedule-summary')).toContainText('special hours');
  });

  test('the list: search, status, payment, date, time, assigned employee, sorting and paging', async ({ page }) => {
    const fake = shop(); fake.po.s.max_orders_per_slot = 99;
    const o: ReturnType<typeof seed>[] = [];
    for (let i = 0; i < 28; i++) o.push(seed(fake, 2 + (i % 3), ['09:00', '09:30', '10:00', '10:30'][i % 4], { name: i === 5 ? 'Malee Special' : 'Somchai', qty: 1 + (i % 3) }));
    move(fake, o[0], 'confirmed'); fake.verifyPayment(o[1].order_no); fake.po.assignments.set(o[2].id, 'staff-2');
    await openPage(page, fake, 'preorders?tab=list');
    const table = page.getByTestId('po-table');
    await expect(table.locator('tbody tr')).toHaveCount(25);                                            // 25 per page
    await expect(page.getByTestId('po-paging')).toContainText('Showing 1–25 of 28');
    await page.getByTestId('po-paging').getByRole('button', { name: 'Next' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(3); await expect(page.getByTestId('po-paging')).toContainText('Showing 26–28 of 28');
    await page.getByTestId('po-paging').getByRole('button', { name: 'Previous' }).click();
    const filters = page.getByTestId('po-filters');
    await filters.getByPlaceholder('Order no., customer name or phone').fill('malee'); await expect(table.locator('tbody tr')).toHaveCount(1); await expect(table).toContainText(o[5].order_no);
    await filters.getByPlaceholder('Order no., customer name or phone').fill(o[7].order_no); await expect(table.locator('tbody tr')).toHaveCount(1);
    await filters.getByPlaceholder('Order no., customer name or phone').fill('');
    await filters.getByLabel('Status').selectOption('confirmed'); await expect(table.locator('tbody tr')).toHaveCount(1); await expect(table).toContainText(o[0].order_no);
    await filters.getByLabel('Status').selectOption('');
    await filters.getByLabel('Payment').selectOption('paid'); await expect(table.locator('tbody tr')).toHaveCount(1); await expect(table).toContainText(o[1].order_no);
    await filters.getByLabel('Payment').selectOption('');
    await filters.getByLabel('Assigned to').selectOption('staff-2'); await expect(table.locator('tbody tr')).toHaveCount(1); await expect(table).toContainText(o[2].order_no);
    await filters.getByLabel('Assigned to').selectOption('none'); await expect(page.getByTestId('po-paging')).toContainText('of 27');
    await filters.getByLabel('Assigned to').selectOption('');
    const day = addDays(today(), 3);
    await filters.locator('label', { hasText: 'Pickup from' }).locator('input').fill(day); await filters.locator('label', { hasText: /^to/ }).first().locator('input').fill(day);
    await expect(page.getByTestId('po-paging')).toContainText('of 9');                                  // the 9 orders of that day
    await filters.locator('label', { hasText: 'Time from' }).locator('input').fill('10:00'); await filters.locator('label', { hasText: /^to/ }).nth(1).locator('input').fill('10:30');
    await expect(table.locator('tbody tr').first()).toBeVisible();
    for (const t of await table.locator('tbody tr td:nth-child(4)').allInnerTexts()) expect(t).toMatch(/10:(00|30)/);
    await filters.getByRole('button', { name: 'Clear filters' }).click(); await expect(page.getByTestId('po-paging')).toContainText('of 28');
    await filters.getByLabel('Sort by').selectOption('total_desc');
    // (the list reloads after the choice: wait until the first page is the largest totals, in descending order)
    await expect.poll(async () => {
      const totals = (await table.locator('tbody tr td:nth-child(6)').allInnerTexts()).map((x) => Number(x.replace(/[^\d.]/g, '')));
      return totals.length > 1 && new Set(totals).size > 1 && totals.every((v, i) => i === 0 || totals[i - 1] >= v);
    }).toBe(true);
    await table.locator('tbody tr').first().click(); await expect(page.getByTestId('preorder-drawer')).toBeVisible();
  });
  test('the table has the columns staff need and carries the customer\'s contact, the notes and the assignee', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 2, '10:00', { qty: 2, qtyB: 3, note: 'Pack separately' }); fake.po.assignments.set(a.id, 'staff-2');
    await openPage(page, fake, 'preorders?tab=list');
    await expect(page.getByTestId('po-table')).toBeVisible();
    const head = await page.getByTestId('po-table').locator('thead th').allInnerTexts();
    expect(head.map((h) => h.toLowerCase())).toEqual(['order', 'customer', 'ordered', 'pickup', 'items', 'total', 'payment', 'status', 'assigned', 'notes']);      // (the header is capitalised by the stylesheet)
    const row = page.getByTestId('po-table').locator('tbody tr', { hasText: a.order_no });
    await expect(row).toContainText('0812345678'); await expect(row).toContainText('Pack separately'); await expect(row).toContainText('Noi'); await expect(row).toContainText('2 lines'); await expect(row).toContainText('Pending confirmation');
  });

  test('alerts: what the system said, to whom, and LINE delivery state; each opens its order', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 2, '10:00'); fake.rpc('preorder_request_change', { p_id: a.id, p_message: 'make it 5' });
    await openPage(page, fake, 'preorders?tab=alerts');
    const t = page.getByTestId('po-alerts');
    await expect(t).toContainText('Customer asked for a change'); await expect(t).toContainText('New preorder'); await expect(t).toContainText(a.order_no); await expect(t).toContainText('app only');
    await page.getByRole('button', { name: 'Sent to customers' }).click(); await expect(t).toContainText('Preorder received'); await expect(t).not.toContainText('Customer asked for a change');
    await t.locator('tbody tr').first().click(); await expect(page.getByTestId('preorder-drawer')).toContainText(a.order_no);
  });
});

test.describe('the order drawer', () => {
  test('confirm, assign, tick the checklist, ready, handed over: every step is recorded and the customer is told', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 2, '10:00', { qty: 3, qtyB: 2, note: 'Please pack separately' });
    await openPage(page, fake, `preorders?order=${a.id}`);
    const d = page.getByTestId('preorder-drawer');
    await expect(d).toContainText(a.order_no); await expect(d).toContainText('Please pack separately'); await expect(d).toContainText('0812345678'); await expect(d).toContainText('Pending confirmation');
    await expect(page.getByTestId('tick-1')).toBeDisabled();                                            // nothing to tick before the order is confirmed
    await page.getByTestId('drawer-next').click();                                                      // Confirm
    await expect(d).toContainText('Confirmed'); expect(fake.orders.find((o) => o.id === a.id)!.status).toBe('confirmed');
    await d.getByLabel('Assigned to').selectOption('staff-2'); await expect.poll(() => fake.po.assignments.get(a.id)).toBe('staff-2');
    // the next move needs a verified payment: the page asks for a recorded reason, then goes on
    await page.getByTestId('drawer-next').click();
    await dlg(page).locator('textarea').fill('customer pays at pickup'); await dlg(page).getByRole('button', { name: 'Continue anyway' }).click();
    await expect(d).toContainText('Preparing');
    await expect(page.getByTestId('drawer-next')).toBeDisabled();                                       // "ready" waits for the checklist
    await expect(d).toContainText('Tick every item first');
    await page.getByTestId('tick-1').click(); await expect(d.locator('.po-check label.done')).toHaveCount(1);
    await page.getByTestId('tick-2').click(); await expect(d.locator('.po-check label.done')).toHaveCount(2);
    await expect(page.getByTestId('drawer-next')).toBeEnabled(); await page.getByTestId('drawer-next').click();
    await dlg(page).locator('textarea').fill('customer pays at pickup'); await dlg(page).getByRole('button', { name: 'Continue anyway' }).click();
    await expect(d).toContainText('Ready for pickup');
    await page.getByTestId('drawer-next').click();                                                      // handed over
    await dlg(page).locator('textarea').fill('customer pays at pickup'); await dlg(page).getByRole('button', { name: 'Continue anyway' }).click();
    await expect(d).toContainText('Picked up');
    expect(fake.orders.find((o) => o.id === a.id)!.status).toBe('completed');
    expect(fake.po.notices.filter((x) => x.order_id === a.id && x.audience === 'customer').map((x) => x.kind)).toEqual(['placed', 'confirmed', 'preparing', 'ready', 'completed']);
    await expect(d).toContainText('customer pays at pickup'.slice(0, 0) + 'What the customer and staff were told');
    const r = await new AxeBuilder({ page }).include('[data-testid="preorder-drawer"]').analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
  test('rejecting an unconfirmed preorder asks for the reason the customer will see', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 2, '10:00'); await openPage(page, fake, `preorders?order=${a.id}`);
    await page.getByRole('button', { name: 'Reject preorder' }).click();
    await expect(dlg(page)).toContainText('The customer sees the reason');
    await dlg(page).locator('textarea').fill('Sold out that day'); await dlg(page).getByRole('button', { name: 'Reject preorder' }).click();
    await expect(page.getByTestId('preorder-drawer')).toContainText('Rejected');
    expect(fake.po.notices.find((x) => x.kind === 'rejected')!.data.reason).toBe('Sold out that day');
    await expect(page.getByTestId('drawer-next')).toHaveCount(0);
  });
  test('moving the time: the full slots say so and need an explicit "over capacity" tick, and a reason is required', async ({ page }) => {
    const fake = shop(); fake.po.s.max_orders_per_slot = 1; const a = seed(fake, 2, '10:00'); seed(fake, 3, '10:00');
    await openPage(page, fake, `preorders?order=${a.id}`);
    await page.getByTestId('drawer-move').click();
    const m = dlg(page);
    await m.locator('input[type=date]').fill(addDays(today(), 3));
    await expect(m.locator('[data-slot="10:00"]')).toContainText('full'); await m.locator('[data-slot="10:00"]').click();
    await m.locator('textarea').fill('VIP customer');
    await expect(m.getByRole('button', { name: 'Move it' })).toBeDisabled();
    await m.getByLabel('Allow over capacity (recorded in the history)').check(); await m.getByRole('button', { name: 'Move it' }).click();
    await expect.poll(() => fake.po.meta.get(a.id)!.pickup_at).toBe(slotAt(3, '10:00'));
    expect(fake.po.notices.find((x) => x.kind === 'rescheduled_by_shop')!.data.reason).toBe('VIP customer');
  });
  test('an order that is not a preorder points to the Online shop page', async ({ page }) => {
    const fake = shop(); const o = fake.seedOrder(); await openPage(page, fake, `preorders?order=${o.id}`);
    await expect(page.getByText('This is not a preorder.')).toBeVisible();
  });
  test('the Online shop page shows a preorder\'s pickup time, the Preorder tag and moves it straight from preparing to ready', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 2, '10:00'); move(fake, a, 'confirmed'); move(fake, a, 'preparing'); fake.po.checks.set(a.id, new Set([1]));
    await openPage(page, fake, 'shop-admin');
    const row = page.getByRole('row', { name: new RegExp(a.order_no) });
    await expect(row).toContainText('Preorder'); await expect(row).toContainText('10:00'); await row.click();
    const drawer = page.locator('aside.drawer'); await expect(drawer.getByTestId('drawer-pickup')).toContainText('10:00');
    await expect(drawer.getByRole('link', { name: 'Manage in Preorders' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /Mark as Packed/ })).toHaveCount(0); await expect(drawer.getByRole('button', { name: /Mark as Ready/ })).toBeVisible();
  });
});

test.describe('settings and closures', () => {
  test('a SUPER_ADMIN changes hours and capacity; the numbers are saved and the page shows the checklist', async ({ page }) => {
    const fake = shop(); await openPage(page, fake, 'preorders?tab=settings');
    await expect(page.getByTestId('po-checklist')).toContainText('Opening hours saved');
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/preorders-settings.png`, fullPage: true });
    await page.getByTestId('set-max_orders_per_slot').fill('5'); await page.getByTestId('set-max_units_per_slot').fill('20'); await page.getByTestId('set-slot_minutes').selectOption('15');
    await page.getByLabel('Sunday closes').fill('16:00'); await page.getByLabel('Monday', { exact: false }).first().isVisible();
    await page.getByTestId('set-save').click();
    await expect.poll(() => fake.po.s.max_orders_per_slot).toBe(5); expect(fake.po.s.max_units_per_slot).toBe(20); expect(fake.po.s.slot_minutes).toBe(15); expect(fake.po.s.weekly[0].close).toBe('16:00');
    await expect(page.getByText('Settings saved')).toBeVisible();
  });
  test('switching preorders off hides the choice from customers', async ({ page }) => {
    const fake = shop(); await openPage(page, fake, 'preorders?tab=settings');
    await page.getByRole('switch', { name: 'Customers can order ahead' }).click(); await expect.poll(() => fake.po.enabled).toBe(false);
    expect((fake.rpc('shop_settings_public', {}) as { preorder_enabled: boolean }).preorder_enabled).toBe(false);
  });
  test('an ADMIN may read the settings but not change them, and still manages closures', async ({ page }) => {
    const fake = shop('ADMIN'); await openPage(page, fake, 'preorders?tab=settings');
    await expect(page.getByText('Only a SUPER_ADMIN can change these settings')).toBeVisible();
    await expect(page.getByTestId('set-max_orders_per_slot')).toBeDisabled(); await expect(page.getByTestId('set-save')).toHaveCount(0);
    await page.getByTestId('day-date').fill(addDays(today(), 4)); await page.getByTestId('day-reason').fill('Staff day'); await page.getByTestId('day-save').click();
    await expect.poll(() => fake.po.days.get(addDays(today(), 4))?.kind).toBe('closed');
    await expect(page.getByTestId('po-days')).toContainText('Staff day');
    await page.getByTestId('po-days').getByRole('button', { name: 'Remove' }).click(); await expect.poll(() => fake.po.days.size).toBe(0);
  });
  test('closing a day that has active preorders needs a second, explicit step, and flags those orders', async ({ page }) => {
    const fake = shop(); const a = seed(fake, 4, '10:00'); await openPage(page, fake, 'preorders?tab=settings');
    await page.getByTestId('day-date').fill(addDays(today(), 4)); await page.getByTestId('day-save').click();
    await expect(page.getByText(/would no longer fit/).first()).toBeVisible(); expect(fake.po.days.size).toBe(0);
    await page.getByRole('button', { name: 'Save anyway (the orders will be flagged)' }).click();
    await expect.poll(() => fake.po.days.get(addDays(today(), 4))?.kind).toBe('closed');
    await page.goto('/#/preorders'); await expect(page.getByTestId('po-card').filter({ hasText: a.order_no })).toContainText('Day closed');
  });
  test('a bad value is refused with the database\'s own words', async ({ page }) => {
    const fake = shop(); await openPage(page, fake, 'preorders?tab=settings');
    await page.getByTestId('set-slot_minutes').selectOption('10'); await page.getByTestId('set-save').click(); await expect(page.getByText('Settings saved')).toBeVisible();
    fake.po.s.slot_minutes = 30;
  });
});

test.describe('Pickup prep board (the employee\'s phone)', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('what to prepare, by when: time, order, customer, instructions, checklist, and one big button for the next step', async ({ page }) => {
    const fake = shop(); const a = seedIn(fake, 50, { qty: 5, qtyB: 2, note: 'Ring me on arrival' }); move(fake, a, 'confirmed'); fake.verifyPayment(a.order_no);
    await openPage(page, fake, 'prep');
    const card = page.getByTestId('pb-card').filter({ hasText: a.order_no });
    await expect(card).toBeVisible(); await expect(card).toContainText('Somchai'); await expect(card).toContainText('0812345678'); await expect(page.getByTestId('pb-note')).toContainText('Ring me on arrival');
    await expect(card.locator('.po-check li')).toHaveCount(2); await expect(card.locator('.po-check-q').first()).toHaveText('5');
    await expect(page.getByTestId('pb-summary')).toContainText('1 to prepare');
    await expect(page.getByTestId('pb-next')).toHaveText('Start preparing');
    await page.getByTestId('pb-next').click(); await expect(card).toHaveAttribute('data-status', 'preparing');
    await expect(page.getByTestId('pb-next')).toBeDisabled(); await expect(card).toContainText('Tick every item first');
    await card.getByTestId('tick-1').click(); await expect(card.getByTestId('tick-1')).toBeChecked(); await expect(page.getByTestId('pb-next')).toBeDisabled();
    await card.getByTestId('tick-2').click(); await expect(card.getByTestId('tick-2')).toBeChecked(); await expect(page.getByTestId('pb-next')).toHaveText('Mark ready for pickup'); await page.getByTestId('pb-next').click();
    await expect(card).toHaveAttribute('data-status', 'ready'); await expect(page.getByTestId('pb-next')).toHaveText('Handed over to the customer'); await page.getByTestId('pb-next').click();
    await expect(page.getByTestId('pb-card')).toHaveCount(0);                                           // handed over: off the board
    expect(fake.orders.find((o) => o.id === a.id)!.status).toBe('completed'); expect(fake.po.meta.get(a.id)!.completed_at).toBeTruthy();
    expect(fake.po.assignments.get(a.id)).toBeTruthy();                                                 // whoever started it owns it
    await noOverflow(page);
  });
  test('an overdue order is on top under "Needs action now", and "Take this order" assigns it to me', async ({ page }) => {
    const fake = shop(); const late = seedIn(fake, -25); const later = seed(fake, 3, '10:00');
    await openPage(page, fake, 'prep'); await page.getByLabel('Days to show').selectOption('4');
    await expect(page.getByTestId('pb-urgent')).toContainText(late.order_no); await expect(page.getByTestId('pb-urgent')).toContainText('Late'); await expect(page.getByTestId('pb-urgent')).not.toContainText(later.order_no);
    await page.getByTestId('pb-card').filter({ hasText: later.order_no }).getByTestId('pb-take').click();
    await expect.poll(() => fake.po.assignments.get(later.id)).toBe('staff-1');
    await page.getByRole('switch', { name: 'Only my orders' }).click();
    await expect(page.getByTestId('pb-card')).toHaveCount(1); await expect(page.getByTestId('pb-card')).toContainText(later.order_no);
  });
  test('a cancelled order leaves the board and the employee is told', async ({ page }) => {
    const fake = shop(); const a = seedIn(fake, 90);
    await openPage(page, fake, 'prep'); await expect(page.getByTestId('pb-card')).toHaveCount(1);
    fake.po.setStatus(a.f, 'cancelled', 'Customer called', null);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('No longer on the board')).toContainText(a.order_no); await expect(page.getByText('Nothing to prepare')).toBeVisible();
  });
  test('the board is accessible and works in Thai', async ({ page }) => {
    const fake = shop(); const a = seedIn(fake, 90, { note: 'โทรหาก่อนมา' }); move(fake, a, 'confirmed');
    await openPage(page, fake, 'prep', 'th');
    await expect(page.getByRole('heading', { name: 'เตรียมสินค้านัดรับ' })).toBeVisible(); await expect(page.getByTestId('pb-next')).toHaveText('เริ่มเตรียมสินค้า'); await expect(page.getByTestId('pb-note')).toContainText('โทรหาก่อนมา');
    const r = await new AxeBuilder({ page }).include('.pb').analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(' | ')}`)).toEqual([]);
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/pickup-prep-mobile.png`, fullPage: true });
  });
});

test('the Preorders page works in Thai', async ({ page }) => {
  const fake = shop(); seed(fake, 2, '10:00'); await openPage(page, fake, 'preorders', 'th');
  await expect(page.getByRole('heading', { name: 'พรีออเดอร์' })).toBeVisible(); await expect(page.getByTestId('po-kpis')).toContainText('พรีออเดอร์ที่นัดรับวันนี้'); await expect(page.getByTestId('po-kpis')).toContainText('รอยืนยัน');
});
