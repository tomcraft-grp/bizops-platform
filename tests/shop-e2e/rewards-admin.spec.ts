// Back-office Promotions > "Online shop" against the fake backend (fakeBackend.ts + fakeRewardsAdmin.ts): the master switch, rules from two templates, the SKU picker,
// promotion packs and the simulator. The staff app is English by default; one test checks the Thai wording.
// What the rules DO (per-bill picks, scope, packs, who may call what) is tested for real by supabase/tests/rewards_core.sql and, for the pure arithmetic of the
// form, by tests/unit/rewardsRuleForm.test.ts. These tests prove that staff can do the work on the screens, that the screens offer only what a role may do,
// that every server refusal reads as a clear sentence, and that a second click never sends a second request.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import { FakeRewardsAdmin, INACTIVE_SKU, MALEE, SOMCHAI } from './fakeRewardsAdmin';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

async function open(page: Page, role: 'SUPER_ADMIN' | 'ADMIN' = 'SUPER_ADMIN', lang: 'en' | 'th' = 'en', setup?: (fake: FakeShop, adm: FakeRewardsAdmin) => void) {
  const fake = new FakeShop(); const adm = new FakeRewardsAdmin(fake);
  fake.profile.role = role; fake.profile.display_name = 'Staff';
  setup?.(fake, adm);
  await fake.install(page); await adm.install(page);
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/promotions');
  await expect(page.getByRole('heading', { name: lang === 'en' ? 'Promotions' : 'โปรโมชั่น', level: 1 })).toBeVisible();
  return { fake, adm };
}
const dlgOf = (page: Page) => page.locator('.modal');
const tab = (page: Page, name: string) => page.getByRole('tab', { name });

test.describe('the page', () => {
  test('opens on "Online shop"; "POS on this device" is the local engine, unchanged', async ({ page }) => {
    await open(page);
    await expect(tab(page, 'Online shop')).toHaveClass(/on/);
    await expect(page.getByRole('heading', { name: 'Master switch' })).toBeVisible();
    await tab(page, 'POS on this device').click();
    await expect(page.getByRole('button', { name: 'New promotion' })).toBeVisible();
    await expect(tab(page, 'Eligibility simulator')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Master switch' })).toHaveCount(0);
    await tab(page, 'Online shop').click();
    await expect(page.getByRole('heading', { name: 'Master switch' })).toBeVisible();
  });
});

test.describe('master switch', () => {
  test('off by default, with the promise that nothing changes; a Super Admin switches it on after one inline confirmation and off with one click', async ({ page }) => {
    const { adm } = await open(page);
    const sw = page.getByRole('switch', { name: 'Points and number picks' });
    await expect(page.getByText('Off = nothing changes for customers')).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'false'); await expect(sw).toBeEnabled();
    await sw.click();
    await expect(page.getByText(/Switch on for every customer\?/)).toBeVisible();
    await expect(page.getByText('From now on, paid bills that fit an active rule earn rewards. Bills paid before a rule was created do not earn.')).toBeVisible();
    await expect(page.getByText(/including bills paid before today/)).toHaveCount(0);
    expect(adm.count('rw_admin_save_settings')).toBe(0);                                   // nothing is sent before the confirmation
    await page.getByRole('button', { name: 'Yes, switch on' }).click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(adm.last('rw_admin_save_settings')).toEqual({ p_patch: { enabled: true } });
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(adm.last('rw_admin_save_settings')).toEqual({ p_patch: { enabled: false } });
    expect(adm.settings).toEqual({ enabled: false, boards_enabled: false });
  });

  test('an Admin sees it but cannot change it', async ({ page }) => {
    await open(page, 'ADMIN');
    await expect(page.getByRole('switch', { name: 'Points and number picks' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Event boards' })).toBeDisabled();
    await expect(page.getByText('Only a Super Admin can change the master switch.')).toBeVisible();
  });

  test('if the server refuses anyway (the screen is only a hint), the reason is a plain sentence and nothing changes', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.denySettings = true; });
    const sw = page.getByRole('switch', { name: 'Event boards' });
    await sw.click(); await page.getByRole('button', { name: 'Yes, switch on' }).click();
    await expect(page.getByText('You are not allowed to do this. Ask a Super Admin.')).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(adm.settings.boards_enabled).toBe(false);
  });
});

test.describe('rules', () => {
  test('no rules yet: the two templates are offered; "Number picks per bill" starts with step 300, 1 pick, per bill and says what it does', async ({ page }) => {
    const { adm } = await open(page);
    await expect(page.getByText('No rules yet')).toBeVisible();
    await page.getByRole('button', { name: 'Number picks per bill' }).click();
    const dlg = dlgOf(page);
    await expect(dlg.getByRole('heading', { name: 'New rule' })).toBeVisible();
    await expect(dlg.getByLabel('Rule name')).toHaveValue('Number picks per bill');
    await expect(dlg.getByLabel('Every complete (฿)')).toHaveValue('300');
    await expect(dlg.getByLabel('Picks earned')).toHaveValue('1');
    await expect(dlg).toContainText('Every complete ฿300 on one bill = 1 pick.');
    await expect(dlg).toContainText('฿850 on one bill → 2 picks.');
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-promotions-rule-form.png` });
    await expect(dlg).toContainText('Bills are never added together: two bills of ฿200 earn nothing.');
    await expect(dlg).toContainText('Counts bills from now on. Bills paid before this rule exists do not earn.');   // not retroactive, said before anything is opened
    await dlg.getByLabel('Every complete (฿)').fill('100');
    await expect(dlg).toContainText('Every complete ฿100 on one bill = 1 pick.');   // the sentence follows the form
    await dlg.getByLabel('Every complete (฿)').fill('300');
    await expect(dlg.getByLabel('Ends')).toBeHidden();                                // advanced options stay folded away

    await dlg.getByRole('button', { name: 'Save rule' }).click();                     // an event is needed: said inline, nothing sent
    await expect(dlg).toContainText('Choose the event these picks are for.');
    expect(adm.count('rw_admin_save_rule')).toBe(0);
    await dlg.getByLabel('Event', { exact: true }).selectOption('ev-1');
    await dlg.getByRole('button', { name: 'Save rule' }).dblclick();                  // a double click is one request
    await expect(dlg).toBeHidden();
    expect(adm.count('rw_admin_save_rule')).toBe(1);
    expect(adm.last('rw_admin_save_rule')).toEqual({
      p_id: null, p_patch: { kind: 'board_pick', name: 'Number picks per bill', active: true, starts_at: null, ends_at: null, spend_step: 300, reward_amount: 1, basis: 'per_bill', max_per_order: null,
        category_codes: [], include_skus: [], exclude_skus: [], include_packs: false, only_profile_ids: null, event_id: 'ev-1', board_slots: null },
    });
    const row = page.getByRole('row', { name: /Number picks per bill/ });
    await expect(row).toContainText('Every complete ฿300 on one bill = 1 pick.');
    await expect(row).toContainText('Lucky numbers');
    await expect(row).toContainText('Everything'); await expect(row).toContainText('From ');    // the server set the start to the moment it was created
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-promotions-rules.png` });
  });

  test('"Points per baht spent" is the other template; switching template inside the form keeps what was typed and drops what no longer applies', async ({ page }) => {
    const { adm } = await open(page);
    await page.getByRole('button', { name: 'New rule' }).click();
    const dlg = dlgOf(page);
    await expect(dlg.getByLabel('Rule name')).toHaveValue('Points per baht spent');
    await expect(dlg).toContainText('Every complete ฿300 on one bill = 1 point.');
    await expect(dlg.getByLabel('Event', { exact: true })).toHaveCount(0);
    await dlg.getByRole('tab', { name: 'Number picks per bill' }).click();
    await expect(dlg.getByLabel('Rule name')).toHaveValue('Number picks per bill');
    await expect(dlg.getByLabel('Event', { exact: true })).toBeVisible();
    await dlg.getByLabel('Rule name').fill('My own name');
    await dlg.getByRole('tab', { name: 'Points per baht spent' }).click();
    await expect(dlg.getByLabel('Rule name')).toHaveValue('My own name');
    await dlg.getByLabel('Every complete (฿)').fill('50'); await dlg.getByLabel('Points earned').fill('2');
    await expect(dlg).toContainText('Every complete ฿50 on one bill = 2 points.');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toMatchObject({ p_patch: { kind: 'points', name: 'My own name', spend_step: 50, reward_amount: 2, basis: 'per_bill', event_id: null, board_slots: null } });
  });

  test('the product picker searches by SKU or name, shows inactive SKUs disabled and labelled, and each product is added once', async ({ page }) => {
    const { adm } = await open(page);
    await page.getByRole('button', { name: 'New rule' }).click();
    const dlg = dlgOf(page);
    const search = dlg.getByLabel('Search products to include');
    await search.fill('F');
    await expect(dlg.getByText('Type at least 2 characters.')).toBeVisible();
    await search.fill(INACTIVE_SKU);
    const old = dlg.getByRole('listitem').filter({ hasText: INACTIVE_SKU });
    await expect(old).toContainText('Inactive'); await expect(old).toContainText('Inactive: cannot be added');
    await expect(dlg.getByRole('button', { name: `Add ${INACTIVE_SKU}` })).toBeDisabled();
    await search.fill('FG-000001');
    await dlg.getByRole('button', { name: 'Add FG-000001' }).click();
    await expect(dlg.locator('.chip').filter({ hasText: 'FG-000001' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Add FG-000001' })).toBeDisabled();  // already added
    await expect(dlg.getByRole('listitem').filter({ hasText: 'FG-000001' })).toContainText('Already added');
    await dlg.getByRole('checkbox', { name: 'Puff' }).check();                        // categories come from the shop's categories
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toMatchObject({ p_patch: { include_skus: ['FG-000001'], category_codes: ['Puff'] } });
    const row = page.getByRole('row', { name: /Points per baht spent/ });
    await expect(row).toContainText('Products: 1'); await expect(row).toContainText('Categories: 1');
  });

  test('advanced options hold the window, the cap, exclusions, customers and boards; the dates go out as Bangkok days', async ({ page }) => {
    const { adm } = await open(page);
    await page.getByRole('button', { name: 'Number picks per bill' }).click();
    const dlg = dlgOf(page);
    await dlg.getByLabel('Event', { exact: true }).selectOption('ev-1');
    await dlg.getByText('Advanced options').click();
    await expect(dlg.getByRole('tab', { name: 'From now' })).toHaveAttribute('aria-selected', 'true');   // the default
    await dlg.getByRole('tab', { name: 'From a date' }).click();
    await dlg.getByLabel('Start date').fill('2026-12-01'); await dlg.getByLabel('Ends').fill('2026-11-30');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toContainText('The end date cannot be before the start date.');
    await dlg.getByLabel('Ends').fill('2026-12-31');
    await dlg.getByLabel('Most per bill').fill('3');
    await expect(dlg).toContainText('At most 3 picks per bill.');
    await dlg.getByRole('checkbox', { name: 'Board A' }).check(); await dlg.getByRole('checkbox', { name: 'Board C' }).check();
    await dlg.getByRole('checkbox', { name: /Count promotion packs/ }).check();
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toMatchObject({ p_patch: {
      starts_at: '2026-12-01T00:00:00+07:00', ends_at: '2026-12-31T23:59:59+07:00', max_per_order: 3, board_slots: [1, 3], include_packs: true, only_profile_ids: null } });
    const row = page.getByRole('row', { name: /Number picks per bill/ });
    await expect(row).toContainText('2026-12-01 → 2026-12-31'); await expect(row).toContainText('Packs count');
  });

  test('a product that went inactive after it was chosen: the server refuses and the message names it', async ({ page }) => {
    const { adm } = await open(page);
    await page.getByRole('button', { name: 'New rule' }).click();
    const dlg = dlgOf(page);
    await dlg.getByLabel('Search products to include').fill('FG-000002');
    await dlg.getByRole('button', { name: 'Add FG-000002' }).click();
    adm.deactivate('FG-000002');                                                      // switched off in Products meanwhile
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toContainText('SKU FG-000002 is inactive, so it cannot be added.');
    await expect(dlg).toBeVisible();                                                  // the form stays open with everything typed
    expect(adm.rules).toHaveLength(0);
  });

  test('a saved rule that includes a SKU that is inactive now is flagged, and saving waits until it is removed', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ kind: 'points', event_id: null, name: 'Old promo', include_skus: [INACTIVE_SKU], starts_at: '2026-11-01T00:00:00+07:00' }); });
    await page.getByRole('row', { name: /Old promo/ }).getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    await expect(dlg).not.toContainText('already given rewards');                      // nothing was given yet, so it can still be changed
    const chip = dlg.locator('.chip').filter({ hasText: INACTIVE_SKU });
    await expect(chip).toContainText('Inactive'); await expect(chip).toContainText('Retired Mango');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toContainText(`Remove inactive SKUs before saving: ${INACTIVE_SKU}`);
    expect(adm.count('rw_admin_save_rule')).toBe(0);
    await chip.getByRole('button', { name: `Remove ${INACTIVE_SKU}` }).click();
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toMatchObject({ p_id: adm.rules[0].id, p_patch: { include_skus: [] } });
  });

  test('a rule is switched off with one click, by an Admin too', async ({ page }) => {
    const { adm } = await open(page, 'ADMIN', 'en', (_f, a) => { a.addRule({ name: 'Weekend picks' }); });
    const sw = page.getByRole('switch', { name: 'Active: Weekend picks' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(adm.last('rw_admin_set_rule_active')).toEqual({ p_id: adm.rules[0].id, p_active: false });
    await expect(page.getByText('Rule switched off').first()).toBeVisible();
  });

  test('a refusal of the rule by the server (BAD_RULE) is shown as the reason, not as a code, and the form stays open', async ({ page }) => {
    const { adm } = await open(page);
    adm.refuseNext = 'BAD_RULE: spend_step 0.001 is below the smallest step';
    await page.getByRole('button', { name: 'New rule' }).click();
    const dlg = dlgOf(page);
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toContainText('This rule is not valid: spend_step 0.001 is below the smallest step');
    await expect(dlg).not.toContainText('BAD_RULE');
    await dlg.getByRole('button', { name: 'Save rule' }).click();                    // the next try goes through: nothing was kept from the refused one
    await expect(dlg).toBeHidden();
    expect(adm.rules).toHaveLength(1);
  });

  test('when there is no event yet, a number-pick rule says so instead of offering an empty list', async ({ page }) => {
    await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.events = []; });
    await page.getByRole('button', { name: 'Number picks per bill' }).click();
    await expect(dlgOf(page)).toContainText('There is no event yet. Create one in Events, then come back.');
  });
});

test.describe('start date, customers and used rules', () => {
  const used = { name: 'Weekend picks', stats: { bills: 5, granted: 12 }, category_codes: ['Puff'], starts_at: '2026-11-01T00:00:00+07:00', ends_at: '2026-12-31T23:59:59+07:00' };

  test('a new rule starts from now; an earlier day is a visible, explicit choice and says what it reaches back to', async ({ page }) => {
    const { adm } = await open(page);
    await page.getByRole('button', { name: 'New rule' }).click();
    const dlg = dlgOf(page);
    await dlg.getByText('Advanced options').click();
    await dlg.getByRole('tab', { name: 'From a date' }).click();
    await dlg.getByLabel('Start date').fill('2020-01-01');
    await expect(dlg).toContainText('Also counts bills placed since 2020-01-01, once rewards are switched on.');
    await dlg.getByRole('tab', { name: 'From now' }).click();                         // back to the default: no date is kept
    await expect(dlg.getByLabel('Start date')).toHaveCount(0);
    await expect(dlg).toContainText('Counts bills from now on. Bills paid before this rule exists do not earn.');
    await dlg.getByRole('tab', { name: 'From a date' }).click(); await dlg.getByLabel('Start date').fill('2020-01-01');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toMatchObject({ p_id: null, p_patch: { starts_at: '2020-01-01T00:00:00+07:00' } });
  });

  test('editing a saved rule shows its start day; it cannot be emptied (that would mean "from the beginning")', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ name: 'Weekend picks', starts_at: '2026-11-01T00:00:00+07:00' }); });
    await page.getByRole('row', { name: /Weekend picks/ }).getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    await expect(dlg).toContainText('Counts bills placed from 2026-11-01.');
    await dlg.getByText('Advanced options').click();
    await expect(dlg.getByLabel('Start date')).toHaveValue('2026-11-01');
    await expect(dlg.getByRole('tab', { name: 'From now' })).toHaveCount(0);
    await dlg.getByLabel('Start date').fill('');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toContainText('Choose the day this rule starts counting.');
    expect(adm.count('rw_admin_save_rule')).toBe(0);
  });

  test('customers are chosen by searching name, phone or e-mail (2 characters at least); the rule sends their ids', async ({ page }) => {
    const { adm } = await open(page);
    await page.getByRole('button', { name: 'New rule' }).click();
    const dlg = dlgOf(page);
    await dlg.getByText('Advanced options').click();
    const search = dlg.getByLabel('Search customers by name, phone or e-mail');
    await search.fill('S');
    await expect(dlg.getByText('Type at least 2 characters.')).toBeVisible();
    expect(adm.count('rw_admin_customer_search')).toBe(0);
    await search.fill('somch');
    const row = dlg.getByRole('listitem').filter({ hasText: 'Somchai Jaidee' });
    await expect(row).toContainText('0812345678'); await expect(row).toContainText('somchai@example.test');
    expect(adm.last('rw_admin_customer_search')).toEqual({ p_q: 'somch', p_limit: 10 });
    await dlg.getByRole('button', { name: 'Add Somchai Jaidee' }).click();
    const chip = dlg.locator('.chip').filter({ hasText: 'Somchai Jaidee' });
    await expect(chip).toContainText('0812345678');
    await expect(dlg.getByRole('button', { name: 'Add Somchai Jaidee' })).toBeDisabled();
    await expect(row).toContainText('Already added');
    await search.fill('0898');                                                        // by phone
    await dlg.getByRole('button', { name: 'Add Malee Rakdee' }).click();
    await search.fill('malee@');                                                      // by e-mail: the same customer, already added
    await expect(dlg.getByRole('button', { name: 'Add Malee Rakdee' })).toBeDisabled();
    await dlg.locator('.chip').filter({ hasText: 'Somchai Jaidee' }).getByRole('button', { name: 'Remove Somchai Jaidee' }).click();
    await expect(dlg.locator('.chip').filter({ hasText: 'Somchai Jaidee' })).toHaveCount(0);
    await search.fill('somch'); await dlg.getByRole('button', { name: 'Add Somchai Jaidee' }).click();
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toMatchObject({ p_patch: { only_profile_ids: [MALEE.id, SOMCHAI.id] } });
    await expect(page.getByRole('row', { name: /Points per baht spent/ })).toContainText('Customers: 2');
  });

  test('a customer picked earlier shows as a short id when the form is reopened (the server cannot look a customer up by id)', async ({ page }) => {
    await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ name: 'VIP picks', only_profile_ids: [SOMCHAI.id], starts_at: '2026-11-01T00:00:00+07:00' }); });
    await page.getByRole('row', { name: /VIP picks/ }).getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    await expect(dlg.locator('.chip').filter({ hasText: '…11111111' })).toBeVisible();
  });

  test('a rule that has given rewards is read-only except its name, on/off and a later end date; Duplicate makes an editable inactive copy in one click', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule(used); });
    await page.getByRole('row', { name: /Weekend picks/ }).getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    await expect(dlg).toContainText('This rule has already given rewards. To change how it works, duplicate it.');
    await expect(dlg).not.toContainText('can change what those bills earned');         // the old warning is gone
    for (const label of ['Every complete (฿)', 'Picks earned', 'Start date', 'Most per bill']) await expect(dlg.getByLabel(label), label).toBeDisabled();
    await expect(dlg.getByLabel('Event', { exact: true })).toBeDisabled();
    await expect(dlg.getByRole('checkbox', { name: 'Puff' })).toBeDisabled(); await expect(dlg.getByRole('checkbox', { name: /Count promotion packs/ })).toBeDisabled();
    await expect(dlg.getByLabel('Search products to include')).toBeDisabled(); await expect(dlg.getByLabel('Search customers by name, phone or e-mail')).toBeDisabled();
    await expect(dlg.getByLabel('Rule name')).toBeEnabled(); await expect(dlg.getByLabel('Ends')).toBeEnabled(); await expect(dlg.getByRole('checkbox', { name: /^Active/ })).toBeEnabled();
    await dlg.getByLabel('Rule name').fill('Renamed promo');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toEqual({ p_id: adm.rules[0].id, p_patch: { name: 'Renamed promo', active: true } });   // nothing frozen is sent

    await page.getByRole('row', { name: /Renamed promo/ }).getByRole('button', { name: 'Edit' }).click();
    await dlg.getByRole('button', { name: 'Duplicate' }).click();                      // the same window becomes a new rule, no second dialog
    await expect(dlg.getByRole('heading', { name: 'New rule' })).toBeVisible();
    await expect(dlg.getByLabel('Rule name')).toHaveValue('Renamed promo (copy)');
    await expect(dlg.getByRole('checkbox', { name: /^Active/ })).not.toBeChecked();
    await expect(dlg).not.toContainText('already given rewards');
    await expect(dlg).toContainText('Counts bills from now on.');
    await expect(dlg.getByLabel('Every complete (฿)')).toBeEnabled(); await expect(dlg.getByLabel('Every complete (฿)')).toHaveValue('300');
    await expect(dlg.getByRole('checkbox', { name: 'Puff' })).toBeChecked();
    await dlg.getByLabel('Every complete (฿)').fill('200');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toMatchObject({ p_id: null, p_patch: { name: 'Renamed promo (copy)', active: false, starts_at: null, spend_step: 200, category_codes: ['Puff'] } });
    await expect(page.getByRole('row', { name: /Renamed promo \(copy\)/ })).toBeVisible(); await expect(page.getByRole('row', { name: /^Renamed promo\b(?! \(copy\))/ })).toBeVisible();
    expect(adm.rules).toHaveLength(2);
  });

  test('the end date of a used rule can only be moved later or removed', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule(used); });
    await page.getByRole('row', { name: /Weekend picks/ }).getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    await dlg.getByLabel('Ends').fill('2026-12-30');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toContainText('The end date can only be moved later, or removed.');
    expect(adm.count('rw_admin_save_rule')).toBe(0);
    await dlg.getByLabel('Ends').fill('2027-01-31');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_rule')).toEqual({ p_id: adm.rules[0].id, p_patch: { name: 'Weekend picks', active: true, ends_at: '2027-01-31T23:59:59+07:00' } });
  });

  test('the form was open while the rule gave its first reward: the server says RULE_USED and the form turns read-only with the original values and Duplicate', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ name: 'Weekend picks', starts_at: '2026-11-01T00:00:00+07:00' }); });
    await page.getByRole('row', { name: /Weekend picks/ }).getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    await expect(dlg.getByLabel('Every complete (฿)')).toBeEnabled();
    adm.markUsed(adm.rules[0].id);
    await dlg.getByLabel('Every complete (฿)').fill('100'); await dlg.getByLabel('Rule name').fill('Weekend picks 2');
    await dlg.getByRole('button', { name: 'Save rule' }).click();
    await expect(dlg.getByText('This rule has already given rewards. To change how it works, duplicate it.')).toHaveCount(1);
    await expect(dlg.getByLabel('Every complete (฿)')).toBeDisabled(); await expect(dlg.getByLabel('Every complete (฿)')).toHaveValue('300');   // what was typed is not kept
    await expect(dlg.getByLabel('Rule name')).toHaveValue('Weekend picks 2');                                                                   // the editable part is
    await expect(dlg.getByRole('button', { name: 'Duplicate' })).toBeVisible();
    expect(adm.rules[0].spend_step).toBe(300);
  });
});

test.describe('promotion packs', () => {
  test('create: name, price, components with quantities, points per pack; the sentence shows 1 pack and 2 packs; one pack SKU is made once', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addPack({ pack_sku_code: 'FG-900001', name: 'Old combo', sold_packs: 2 }); });
    await tab(page, 'Promotion packs').click();
    await expect(page.getByRole('row', { name: /Old combo/ })).toContainText('FG-900001');
    await page.getByRole('button', { name: 'New pack' }).first().click();
    const dlg = dlgOf(page);
    await expect(dlg.getByRole('heading', { name: 'New promotion pack' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Save pack' }).click();
    await expect(dlg).toContainText('Give the pack a name.'); await expect(dlg).toContainText('Add at least one product to the pack.');
    expect(adm.count('rw_admin_create_pack')).toBe(0);
    await dlg.getByLabel('Pack name').fill('4 for 300'); await dlg.getByLabel('Pack price (฿)').fill('300'); await dlg.getByLabel('Points per pack').fill('3');
    const search = dlg.getByLabel('Search products to put in the pack');
    await search.fill('FG-900001');
    await expect(dlg.getByRole('listitem').filter({ hasText: 'FG-900001' })).toContainText('A pack cannot go inside a pack');
    await expect(dlg.getByRole('button', { name: 'Add FG-900001' })).toBeDisabled();
    await search.fill(INACTIVE_SKU);
    await expect(dlg.getByRole('button', { name: `Add ${INACTIVE_SKU}` })).toBeDisabled();
    await search.fill('FG-000001');
    await dlg.getByRole('button', { name: 'Add FG-000001' }).click();
    await dlg.getByLabel('Quantity of FG-000001').fill('4');
    await expect(dlg).toContainText('1 pack = 4 items, ฿300, 3 points.');
    await expect(dlg).toContainText('2 packs = 8 items, ฿600, 6 points.');
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-promotions-pack-form.png` });
    await dlg.getByRole('button', { name: 'Save pack' }).dblclick();
    await expect(dlg).toBeHidden();
    expect(adm.count('rw_admin_create_pack')).toBe(1);
    const call = adm.last('rw_admin_create_pack')!;
    expect(call).toMatchObject({ p_name: '4 for 300', p_price: 300, p_items: [{ sku_code: 'FG-000001', qty: 4 }], p_patch: { points_per_pack: 3 } });
    expect(String(call.p_key)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const row = page.getByRole('row', { name: /^4 for 300/ });
    await expect(row).toContainText('4 × '); await expect(row).toContainText('฿300');
    await expect(page.getByText('Pack created').first()).toBeVisible();
  });

  test('a pack that has been sold is locked (contents, eligible value, points per pack); its name and price can still change', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addPack({ pack_sku_code: 'FG-900001', sold_packs: 2 }); });
    await tab(page, 'Promotion packs').click();
    const row = page.getByRole('row', { name: /FG-900001/ });
    await expect(row).toContainText('Contents locked');
    await row.getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    await expect(dlg).toContainText('This pack has been sold (2 sold), so its contents, eligible value and points per pack are locked. Name, price and on sale can still change.');
    await expect(dlg.getByLabel('Quantity of FG-000001')).toBeDisabled();
    await expect(dlg.getByLabel('Points per pack')).toBeDisabled(); await expect(dlg.getByLabel('Eligible value (฿)')).toBeDisabled();
    await expect(dlg.getByLabel('Pack name')).toBeEnabled(); await expect(dlg.getByLabel('Pack price (฿)')).toBeEnabled();
    await expect(dlg.getByLabel('Search products to put in the pack')).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: 'Remove FG-000001' })).toHaveCount(0);
    await dlg.getByLabel('Pack price (฿)').fill('320'); await dlg.getByLabel('Pack name').fill('4 for 320');
    await dlg.getByRole('button', { name: 'Save pack' }).click();
    await expect(dlg).toBeHidden();
    expect(adm.last('rw_admin_save_pack')).toEqual({ p_pack: 'FG-900001', p_patch: { name: '4 for 320', price: 320 } });   // never the contents, the eligible value or the points
  });

  test('the server refusing a pack (BAD_PACK) is shown as the reason', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addPack({ pack_sku_code: 'FG-900001', sold_packs: 0 }); });
    await tab(page, 'Promotion packs').click();
    await page.getByRole('row', { name: /FG-900001/ }).getByRole('button', { name: 'Edit' }).click();
    const dlg = dlgOf(page);
    adm.packs[0].sold_packs = 3;                                                      // sold in another window since this form was opened
    await dlg.getByLabel('Quantity of FG-000001').fill('6');
    await dlg.getByRole('button', { name: 'Save pack' }).click();
    await expect(dlg).toContainText('This pack is not valid: items cannot change once the pack has been sold');
    await expect(dlg).toBeVisible();
  });

  test('a pack goes off sale with one click', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addPack({ pack_sku_code: 'FG-900001' }); });
    await tab(page, 'Promotion packs').click();
    const sw = page.getByRole('switch', { name: 'On sale: 4 for 300' });
    await sw.click(); await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(adm.last('rw_admin_save_pack')).toEqual({ p_pack: 'FG-900001', p_patch: { active: false } });
  });
});

test.describe('try it', () => {
  test('a bill amount: each rule works out on its own and shows how much more earns the next reward', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ name: 'Pick per ฿300 bill' }); a.addRule({ kind: 'points', event_id: null, name: 'Points per ฿100', spend_step: 100, reward_amount: 2 }); a.addRule({ name: 'Switched off', active: false }); });
    await tab(page, 'Try it').click();
    const picks = page.getByRole('row', { name: /Pick per ฿300 bill/ }); const pts = page.getByRole('row', { name: /Points per ฿100/ });
    await expect(page.getByLabel('Bill amount (฿)')).toHaveValue('850');
    await expect(picks).toContainText('2 picks'); await expect(picks).toContainText('฿50 more');
    await expect(pts).toContainText('16 points');
    await expect(page.getByRole('row', { name: /Switched off/ })).toHaveCount(0);
    for (const [amount, text, more] of [['299', '0 picks', '฿1 more'], ['300', '1 pick', '฿300 more'], ['599', '1 pick', '฿1 more'], ['600', '2 picks', '฿300 more'], ['900', '3 picks', '฿300 more'], ['1200', '4 picks', '฿300 more']] as const) {
      await page.getByLabel('Bill amount (฿)').fill(amount);
      await expect(picks, amount).toContainText(text); await expect(picks, amount).toContainText(more);
    }
    await expect(page.getByText('bills are never added together')).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOP_SHOTS ?? 'test-results/shop'}/admin-promotions-try.png` });
    expect(adm.count('rw_admin_simulate')).toBe(0);                                  // the amount is worked out on the screen from the rules
  });

  test('a cart: the server applies each rule\'s scope (excluded products do not count) and the screen shows its answer', async ({ page }) => {
    const { adm } = await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ name: 'All products' }); a.addRule({ name: 'Not the strawberry one', exclude_skus: ['FG-000002'] }); });
    await tab(page, 'Try it').click();
    await page.getByRole('tab', { name: 'A cart' }).click();
    await expect(page.getByText('Add a product to see what the cart would earn.')).toBeVisible();
    for (const code of ['FG-000001', 'FG-000002']) { await page.getByLabel('Search products to add to the cart').fill(code); await page.getByRole('button', { name: `Add ${code}` }).click(); }
    await expect(page.getByText('Cart total')).toBeVisible();
    const all = page.getByRole('row', { name: /All products/ }); const some = page.getByRole('row', { name: /Not the strawberry one/ });
    await expect(all).toContainText('฿640'); await expect(all).toContainText('2 picks');
    await expect(some).toContainText('฿320'); await expect(some).toContainText('1 pick');
    expect(adm.last('rw_admin_simulate')).toEqual({ p_items: [{ sku_code: 'FG-000001', qty: 1 }, { sku_code: 'FG-000002', qty: 1 }], p_profile: null });
    await page.getByLabel('Quantity of FG-000001').fill('3');                          // 960 + 320
    await expect(all).toContainText('฿1,280'); await expect(all).toContainText('4 picks');
  });
});

test.describe('wording and layout', () => {
  test('Thai: tabs, switch, form sentence and the legacy tab are in Thai', async ({ page }) => {
    await open(page, 'SUPER_ADMIN', 'th');
    await expect(page.getByRole('heading', { name: 'สวิตช์หลัก' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'แพ็กโปรโมชั่น' })).toBeVisible(); await expect(page.getByRole('tab', { name: 'POS บนอุปกรณ์เครื่องนี้' })).toBeVisible();
    await page.getByRole('button', { name: 'สิทธิ์เลือกเลขต่อบิล' }).click();
    await expect(dlgOf(page)).toContainText('ทุกๆ ฿300 ที่ครบในบิลเดียว = 1 สิทธิ์เลือกเลข');
    await expect(dlgOf(page)).toContainText('ไม่นำหลายบิลมารวมกัน: สองบิล บิลละ ฿200 จะไม่ได้อะไรเลย');
    await dlgOf(page).getByRole('button', { name: 'บันทึกกฎ' }).click();
    await expect(dlgOf(page)).toContainText('เลือกกิจกรรมที่สิทธิ์เหล่านี้ใช้');
  });

  test('a phone: no sideways scrolling on the page or in the form, and the form fits the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ name: 'Weekend picks' }); });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'New rule' }).first().click();
    const dlg = dlgOf(page);
    await expect(dlg).toBeVisible();
    const box = (await dlg.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(391);
    expect(await overflow()).toBeLessThanOrEqual(1);
    await expect(dlg.getByRole('button', { name: 'Save rule' })).toBeInViewport();
  });

  test('accessibility: no violations on the rules list or in the rule form', async ({ page }) => {
    await open(page, 'SUPER_ADMIN', 'en', (_f, a) => { a.addRule({ name: 'Weekend picks' }); });
    await expect(page.getByRole('row', { name: /Weekend picks/ })).toBeVisible();
    const list = await new AxeBuilder({ page }).include('.card').analyze();
    expect(list.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    await page.getByRole('button', { name: 'New rule' }).first().click();
    await dlgOf(page).getByLabel('Search products to include').fill('FG-00000');
    await expect(dlgOf(page).getByRole('listitem').first()).toBeVisible();
    const form = await new AxeBuilder({ page }).include('.modal').analyze();
    expect(form.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
});
