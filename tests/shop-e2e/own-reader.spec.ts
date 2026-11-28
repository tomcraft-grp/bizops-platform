// The shop's own slip reader with the REAL engine (public/ocr) reading REAL pictures of invented slips in the browser, against the fake backend. The rules that judge a reading are proved in the
// database (supabase/tests/own_slip_reader.sql), the text parsing in tests/unit/slipParse.test.ts. Slow on purpose: an engine really runs.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';

test.describe.configure({ mode: 'serial', timeout: 150_000 });
const pic = (n: string) => readFileSync(new URL(`./slips/${n}`, import.meta.url));
const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
/** every request that leaves this site and the fake database: there must be none */
function outside(page: Page) { const out: string[] = []; page.on('request', (r) => { const u = r.url(); if (!/^(data|blob):/.test(u) && !/localhost:4179|hlvravynjalculvplrxc\.supabase\.co|img\.test/.test(u)) out.push(u); }); return out; }
function watch(page: Page) { const errs: string[] = []; page.on('pageerror', (e) => errs.push(String(e))); return errs; }

test.describe('staff', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  async function open(page: Page, fake: FakeShop, role: 'manager' | 'verifier' | 'viewer' = 'manager') {
    fake.profile.role = 'SUPER_ADMIN'; fake.w.role = role; fake.rv.seed();
    await fake.install(page); await page.clock.setFixedTime(new Date(fake.rv.clockIso));
    await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
    await page.goto('/#/payment-review'); await expect(page.getByRole('heading', { name: 'Payment review' }).first()).toBeVisible();
  }
  const dlg = (page: Page) => page.getByRole('dialog').last();
  const openSlip = async (page: Page, no: string) => { await page.locator('table.t tbody tr', { hasText: no }).getByRole('button', { name: /Review|View/ }).click(); await expect(dlg(page)).toBeVisible(); };

  test('a database without the reader: nothing of it is shown', async ({ page }) => {
    const fake = new FakeShop(); await open(page, fake); await expect(page.getByTestId('own-reader')).toHaveCount(0); await expect(page.getByTestId('slip-insight')).toHaveCount(0);
  });

  // 20261128150000: the outcome and the receiver of a reading, a verifier's judgement of it, and the accuracy card with the spellings a manager approves
  test('the receiver and the outcome of a reading; a verifier judges it; a manager approves a proposed spelling', async ({ page }) => {
    const errs = watch(page); const fake = new FakeShop(); fake.rv.learning = true; await open(page, fake);
    const card = page.getByTestId('slip-insight'); await expect(card).toBeVisible(); await expect(card.getByTestId('outcomes')).toContainText('Checks passed');
    await expect(card.getByTestId('recipients')).toContainText('ณัฐพร อยู่ยิ้ม'); await expect(card.getByTestId('recipients')).toContainText('ณัฐพล อยู่ยิ้ม');
    await expect(card.getByTestId('corrections').getByRole('button', { name: 'Approve' })).toHaveCount(1);                       // only the proposal with two posted slips
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/shop/slip-insight.png', fullPage: true });
    await card.getByTestId('corrections').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('dialog').last()).toContainText('2 posted after the bank check'); await page.getByRole('dialog').last().getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => fake.rv.variants.length).toBe(1); expect(fake.rv.variants[0]).toMatchObject({ holder: 'ณัฐพร อยู่ยิ้ม', variant: 'ณัฐพธ อยู่ยิ้ม', kind: 'ocr', source: 'learned' });
    await expect(card.getByTestId('recipients')).toContainText('ณัฐพธ อยู่ยิ้ม');

    const a = fake.rv.analyses.find((x) => x.evidence_id === 'ev-1')!;
    Object.assign(a, { decision: 'verified', rules_version: 'rules-2026-11-28', recipient: { status: 'match', holder: 'ณัฐพร อยู่ยิ้ม', method: 'masked', confidence: 0.95, agree: { match: 1, other: 0, soft: 0 }, version: 'recipient-v1',
      candidates: [{ name: 'น.ส. ณัฐพร อ.', account_hint: 'xxx-x-x9542-x', how: 'reader', verdict: 'match', method: 'masked', holder: 'ณัฐพร อยู่ยิ้ม', distance: 0 }] } });
    await openSlip(page, 'INV-000101');
    const v = dlg(page).getByTestId('reading-verdict'); await expect(v).toHaveAttribute('data-decision', 'verified'); await expect(v).toContainText('Still check the bank record');
    await expect(v.getByTestId('recipient-check')).toHaveAttribute('data-status', 'match'); await expect(v.getByTestId('recipient-check')).toContainText('surname masked by the bank');
    await v.getByRole('button', { name: 'Wrong, correct it' }).click(); await expect(dlg(page).locator('[data-panel="feedback"]').getByRole('button', { name: 'Save correction' })).toBeDisabled();
    await dlg(page).locator('[data-panel="feedback"]').getByLabel('Who the slip really pays').selectOption('ณัฐพล อยู่ยิ้ม');
    await dlg(page).locator('[data-panel="feedback"]').getByRole('button', { name: 'Save correction' }).click();
    await expect.poll(() => fake.rv.feedback.length).toBe(1); expect(fake.rv.feedback[0]).toMatchObject({ p_analysis: a.id, p_verdict: 'wrong', p_recipient_truth: 'ณัฐพล อยู่ยิ้ม', p_correct_decision: null });
    expect(fake.count('finance_confirm_evidence') + fake.count('finance_post_evidence') + fake.count('finance_reject_evidence')).toBe(0);              // feedback moves no money
    expect(errs).toEqual([]);
  });

  test('a verifier judges but cannot approve; a viewer only looks', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.learning = true; await open(page, fake, 'verifier');
    await expect(page.getByTestId('slip-insight').getByRole('button', { name: 'Approve' })).toHaveCount(0); await expect(page.getByTestId('slip-insight').getByText('Proposed', { exact: true })).toBeVisible();
    await openSlip(page, 'INV-000101'); await dlg(page).getByTestId('reading-verdict').getByRole('button', { name: 'Right' }).click();
    await expect.poll(() => fake.rv.feedback.length).toBe(1); expect(fake.rv.feedback[0]).toMatchObject({ p_verdict: 'correct' });
    const p2 = await page.context().newPage(); const f2 = new FakeShop(); f2.rv.learning = true; await open(p2, f2, 'viewer');
    await openSlip(p2, 'INV-000101'); await expect(dlg(p2).getByTestId('reading-verdict')).toBeVisible(); await expect(dlg(p2).getByTestId('reading-verdict').getByRole('button')).toHaveCount(0);
  });

  test('off: a manager sees the switch and can turn it on; a verifier sees nothing', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.ownReader = false; await open(page, fake);
    const card = page.getByTestId('own-reader'); await expect(card).toBeVisible(); await expect(card.getByRole('button', { name: /Read all waiting/ })).toHaveCount(0);
    await card.getByRole('switch').click(); await expect(card.getByRole('button', { name: /Read all waiting/ })).toBeVisible(); expect(fake.rv.ownReader).toBe(true);
    const fake2 = new FakeShop(); fake2.rv.ownReader = false; const p2 = await page.context().newPage(); await open(p2, fake2, 'verifier'); await expect(p2.getByTestId('own-reader')).toHaveCount(0);
  });

  test('opening a slip nobody has read: it is read in the browser and judged; nothing is confirmed, nothing leaves the site', async ({ page }) => {
    const errs = watch(page), out = outside(page); const fake = new FakeShop(); fake.rv.ownReader = true; fake.slipPicture = pic('invented-430.jpg'); await open(page, fake, 'verifier');
    fake.rv.analyses = fake.rv.analyses.filter((a) => a.evidence_id !== 'ev-4');
    await openSlip(page, 'INV-000104');
    await expect(dlg(page)).toContainText('Reading the slip in this browser'); await expect(dlg(page)).toContainText('Amount Mismatch', { timeout: 100_000 });
    await expect(dlg(page)).toContainText('Slip reading (no AI)'); await expect(dlg(page)).toContainText('hint, not proof');
    const c = fake.calls.filter((x) => x.fn === 'finance_store_reading'); expect(c).toHaveLength(1);
    const x = c[0].args.p_extracted as Record<string, unknown>; expect(x.amount).toBe(430); expect(String(x.transfer_at).slice(0, 16)).toBe('2026-12-04T21:53'); expect(x.trans_ref).toBe('2026120489720200627462');
    expect(c[0].args.p_qr).toMatchObject({ found: true, crc_ok: true, sending_bank: '004', trans_ref: '2026120489720200627462' }); expect(String((c[0].args.p_qr as Record<string, unknown>).file_sha256)).toMatch(/^[0-9a-f]{64}$/); expect(c[0].args.p_engine).toBe('browser-ocr/2'); expect(String(c[0].args.p_text).split(String.fromCharCode(12))).toHaveLength(3);   // the three readings kept apart (20261128150000)
    expect(Object.keys(c[0].args).filter((k) => /expected|result|status|receiver/.test(k))).toEqual([]);
    for (const fn of ['finance_confirm_evidence', 'finance_post_evidence', 'finance_reject_evidence']) expect(fake.count(fn), fn).toBe(0);
    expect(fake.rv.evidence.find((e) => e.id === 'ev-4')!.status).toBe('submitted'); expect(out).toEqual([]); expect(errs).toEqual([]);
    await dlg(page).getByRole('button', { name: 'Close' }).click(); await openSlip(page, 'INV-000104'); await page.waitForTimeout(500); expect(fake.count('finance_store_reading')).toBe(1);   // read once, not on every opening
  });

  test('a picture that cannot be read changes nothing and can be tried again; a viewer is never offered it', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.ownReader = true; await open(page, fake, 'verifier');      // (the fake's picture is 1x1)
    fake.rv.analyses = fake.rv.analyses.filter((a) => a.evidence_id !== 'ev-4'); await openSlip(page, 'INV-000104');
    await expect(dlg(page).getByRole('button', { name: 'Read the slip' })).toBeEnabled({ timeout: 30_000 }); expect(fake.count('finance_store_reading')).toBe(0);
    await dlg(page).getByRole('button', { name: 'Read the slip' }).click(); await expect(page.locator('.toast.error')).toContainText('could not be read');
    const fake2 = new FakeShop(); fake2.rv.ownReader = true; const p2 = await page.context().newPage(); await open(p2, fake2, 'viewer'); fake2.rv.analyses = fake2.rv.analyses.filter((a) => a.evidence_id !== 'ev-4');
    await openSlip(p2, 'INV-000104'); await p2.waitForTimeout(600); await expect(dlg(p2).getByRole('button', { name: /Read the slip/ })).toHaveCount(0); expect(fake2.count('finance_store_reading')).toBe(0);
  });

  test('read all waiting, then measure on posted slips (nothing is stored by the measurement)', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.ownReader = true; fake.slipPicture = pic('invented-4564.jpg'); fake.rv.seed(); await open(page, fake);
    fake.rv.analyses = fake.rv.analyses.filter((a) => a.evidence_id !== 'ev-4'); await page.reload(); await expect(page.getByTestId('own-reader')).toBeVisible();
    await page.getByRole('button', { name: /Read all waiting slips \(1\)/ }).click(); await expect(page.getByTestId('reader-done')).toContainText('1 read, 0 could not', { timeout: 100_000 });
    expect(fake.count('finance_store_reading')).toBe(1); await expect(page.getByRole('button', { name: /Read all waiting slips \(0\)/ })).toBeDisabled();
    const posted = fake.rv.evidence.find((e) => e.status === 'verified')!; posted.verified_amount = 4564; posted.transfer_at = '2026-08-26T06:36:00+07:00';
    await page.getByRole('button', { name: 'Measure it on posted slips' }).click(); const acc = page.getByTestId('reader-accuracy');
    await expect(page.getByRole('button', { name: 'Measure it on posted slips' })).toBeEnabled({ timeout: 100_000 });
    await expect(acc.locator('tbody tr').nth(0)).toContainText(/Amount\s*1\s*0\s*0/); await expect(acc.locator('tbody tr').nth(1)).toContainText(/Transfer date\s*1\s*0\s*0/);
    expect(fake.count('finance_store_reading')).toBe(1);
  });
});

test.describe('the slip check before ordering', () => {
  // invented-430-th.jpg: 430.00 on 13 May 2026, 12:45 in Bangkok
  const DAY = '2026-05-13T13:00:00+07:00';
  async function toSlip(page: Page, fake: FakeShop, o: { total?: number; now?: string; file?: string } = {}) {
    fake.decorate(); if (o.total) fake.item('FG-000001').price = o.total - 50; await fake.install(page); if (o.now) await page.clock.setFixedTime(new Date(o.now)); await page.goto('/#/app'); await expect(page.locator('.phone-nav')).toBeVisible();
    const tab = (l: string) => page.locator('.phone-nav').getByRole('button', { name: l });
    await tab(t('nav.shop')).click(); await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.add') }).click(); await tab(t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
    await attach(page, o.file ?? 'invented-430-th.jpg');
  }
  const attach = async (page: Page, file: string, extra = '') => { await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 's.jpg', mimeType: 'image/jpeg', buffer: Buffer.concat([pic(file), Buffer.from(extra)]) }); await expect(page.getByTestId('slip-preview')).toBeVisible(); };
  const live = (page: Page) => page.getByTestId('slip-live');
  const place = (page: Page) => page.getByRole('button', { name: new RegExp(t('co.place')) }).first();
  const DONE = { timeout: 90_000 };
  const on = () => { const f = new FakeShop(); f.rv.ownReader = false; f.rv.checkout = true; return f; };

  test('the amount and the day agree: checking, then green, nothing to tick, ONE order', async ({ page }) => {
    const errs = watch(page), out = outside(page); const fake = on(); await toSlip(page, fake, { total: 430, now: DAY });
    await expect(live(page)).toHaveAttribute('data-state', 'reading'); await expect(live(page)).toContainText(t('sv.reading'));
    await expect(live(page)).toHaveAttribute('data-state', 'ok', DONE); await expect(live(page)).toContainText(t('sv.amountOk', { a: '฿430' })); await expect(live(page).locator('[data-row="date"]')).toHaveAttribute('data-row-state', 'ok'); await expect(live(page).getByRole('checkbox')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/shop/slip-live-ok.png' });
    await place(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders).toHaveLength(1); expect(fake.count('finance_store_reading')).toBe(0); expect(out).toEqual([]); expect(errs).toEqual([]);
  });

  test('another amount: the order waits for the tick; the tick is for this slip and this total only; nothing read is sent', async ({ page }) => {
    const fake = on(); await toSlip(page, fake, { now: DAY });
    await expect(live(page)).toHaveAttribute('data-state', 'differs', DONE); await expect(live(page)).toContainText(t('sv.amountDiff', { slip: '฿430', want: '฿370' })); await live(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/shop/slip-live-differs.png' });
    await place(page).click(); await expect(page.locator('.sp-sheet')).toHaveCount(0); await expect(page.getByTestId('checkout-error')).toContainText(t('sv.must')); expect(fake.orders).toHaveLength(0);
    await live(page).getByRole('checkbox').check();
    await page.getByRole('radio', { name: t('co.pickup') }).click(); await expect(live(page)).toContainText(t('sv.amountDiff', { slip: '฿430', want: '฿320' })); await expect(live(page).getByRole('checkbox')).not.toBeChecked();           // another total: asked again
    await place(page).click(); await expect(page.locator('.sp-sheet')).toHaveCount(0);
    await live(page).getByRole('checkbox').check(); await place(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.paid).toBe(0); const a = fake.calls.find((c) => c.fn === 'shop_place_order')!.args; expect(JSON.stringify(a)).not.toContain('430'); expect(fake.count('finance_store_reading')).toBe(0);
  });

  // the receiver (20261128150000): invented-430-th.jpg pays "น.ส. ทดสอบ ผู้รับ" (the sender "น.ส. สมหญิง รักดี" is printed first)
  test('the receiver is one of the shop names: a third green row with that name, nothing to tick', async ({ page }) => {
    const fake = on(); fake.rv.recipients = ['ทดสอบ ผู้รับ']; await toSlip(page, fake, { total: 430, now: DAY });
    await expect(live(page)).toHaveAttribute('data-state', 'ok', DONE); await expect(live(page)).toContainText(t('sv.okAll'));
    await expect(live(page).locator('[data-row="recipient"]')).toHaveAttribute('data-row-state', 'ok'); await expect(live(page).locator('[data-row="recipient"]')).toContainText('ทดสอบ ผู้รับ');
    await expect(live(page).getByRole('checkbox')).toHaveCount(0); await live(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/shop/slip-live-recipient-ok.png' });
  });
  test('the slip pays someone else (the right amount and day): said plainly, and the order waits for the tick', async ({ page }) => {
    const fake = on(); fake.rv.recipients = ['ณัฐพร อยู่ยิ้ม', 'ณัฐพล อยู่ยิ้ม']; await toSlip(page, fake, { total: 430, now: DAY });
    await expect(live(page)).toHaveAttribute('data-state', 'differs', DONE); await expect(live(page).locator('[data-row="recipient"]')).toHaveAttribute('data-row-state', 'differs');
    await expect(live(page).locator('[data-row="recipient"]')).toContainText(t('sv.recipientDiff')); await expect(live(page).locator('[data-row="amount"]')).toHaveAttribute('data-row-state', 'ok');
    await live(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/shop/slip-live-recipient-differs.png' });
    await place(page).click(); await expect(page.getByTestId('checkout-error')).toContainText(t('sv.must')); expect(fake.orders).toHaveLength(0);
    await live(page).getByRole('checkbox').check(); await place(page).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click(); await expect(page.locator('.sp-order-detail')).toBeVisible();
    expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.paid).toBe(0);                      // a tick moves no money: the shop still checks the bank
  });

  test('an earlier day: said with the date, and must be ticked', async ({ page }) => {
    const fake = on(); await toSlip(page, fake, { total: 430, now: '2026-05-15T10:00:00+07:00' });
    await expect(live(page)).toHaveAttribute('data-state', 'differs', DONE); await expect(live(page).locator('[data-row="date"]')).toContainText('เป็นวันก่อนหน้า'); await expect(live(page).locator('[data-row="amount"]')).toHaveAttribute('data-row-state', 'ok');
    await place(page).click(); await expect(page.getByTestId('checkout-error')).toContainText(t('sv.must'));
  });

  test('going to the cart and back does not read the picture again, and the tick is asked again', async ({ page }) => {
    const fake = on(); await toSlip(page, fake, { now: DAY }); await expect(live(page)).toHaveAttribute('data-state', 'differs', DONE); await live(page).getByRole('checkbox').check();
    await page.getByRole('button', { name: t('co.back') }).click(); await page.getByRole('button', { name: t('cart.checkout') }).click(); await expect(live(page)).toHaveAttribute('data-state', 'differs', { timeout: 3000 }); await expect(live(page).getByRole('checkbox')).not.toBeChecked();
  });

  test('pressing "place order" while it reads asks to wait; a picture that cannot be read holds nothing up', async ({ page }) => {
    const fake = on(); await toSlip(page, fake, { total: 430, now: DAY }); await place(page).click(); await expect(page.getByTestId('checkout-error')).toContainText(t('sv.wait')); await expect(page.locator('.sp-sheet')).toHaveCount(0);
    await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 's.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    await expect(live(page)).toHaveCount(0, { timeout: 20_000 }); await place(page).click(); await expect(page.locator('.sp-sheet')).toBeVisible();
  });

  test('sending a slip for an existing order: the same check; an older transfer of an older order is fine', async ({ page }) => {
    const fake = on(); fake.decorate(); await fake.install(page); await page.goto('/#/app'); await expect(page.locator('.phone-nav')).toBeVisible(); const o = fake.seedOrder(430); o.invoice.created_at = '2026-05-13T02:00:00.000Z';
    await page.locator('.phone-nav').getByRole('button', { name: t('nav.orders') }).click(); await page.locator('.sp-order').first().click();
    await page.locator('input[type=file]').setInputFiles({ name: 's.jpg', mimeType: 'image/jpeg', buffer: pic('invented-430-th.jpg') });
    await expect(live(page)).toHaveAttribute('data-state', 'ok', DONE);
    await page.getByLabel(/Amount transferred|ยอดที่โอน/).fill('500'); await expect(live(page)).toHaveAttribute('data-state', 'differs');
    await page.getByRole('button', { name: /ส่งสลิปนี้/ }).click(); expect(fake.count('finance_submit_evidence')).toBe(0);
    await live(page).getByRole('checkbox').check(); await page.getByRole('button', { name: /ส่งสลิปนี้/ }).click(); await expect.poll(() => fake.count('finance_submit_evidence')).toBe(1);
  });

  test('switched off (also with the staff reader on): the engine is not even downloaded', async ({ page }) => {
    const got: string[] = []; page.on('request', (r) => { if (/\/ocr\//.test(r.url())) got.push(r.url()); });
    const fake = new FakeShop(); fake.rv.ownReader = true; fake.rv.checkout = false; await toSlip(page, fake); await page.waitForTimeout(2500); expect(got).toEqual([]); await expect(live(page)).toHaveCount(0); await place(page).click(); await expect(page.locator('.sp-sheet')).toBeVisible();
  });
  test('a database without the separate switch: it follows the reader', async ({ page }) => {
    const f2 = new FakeShop(); f2.rv.ownReader = true; await toSlip(page, f2); await expect(live(page)).toHaveAttribute('data-state', 'reading');
  });

  test('an engine that cannot be loaded says nothing and blocks nothing', async ({ page }) => {
    const errs = watch(page); await page.route('**/ocr/**', (r) => r.fulfill({ status: 404, body: 'no' }));
    const fake = on(); await toSlip(page, fake); await page.waitForTimeout(3000); await expect(live(page)).toHaveCount(0); await place(page).click(); await expect(page.locator('.sp-sheet')).toBeVisible(); expect(errs).toEqual([]);
  });

  test('fits a small phone and passes axe, light and dark', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 }); const fake = on(); await toSlip(page, fake, { now: DAY }); await expect(live(page)).toHaveAttribute('data-state', 'differs', DONE);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme); await live(page).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => v.id + ': ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')); expect(bad, bad.join('\n')).toEqual([]);
    }
  });
});

test.describe('staff: the customer switch', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('a manager switches it apart from the reader; a database without it shows no such switch', async ({ page }) => {
    const go = async (p: Page, fake: FakeShop) => { fake.profile.role = 'SUPER_ADMIN'; fake.w.role = 'manager'; fake.rv.seed(); await fake.install(p); await p.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } }); await p.goto('/#/payment-review'); await expect(p.getByTestId('own-reader')).toBeVisible(); };
    const fake = new FakeShop(); fake.rv.ownReader = false; fake.rv.checkout = false; await go(page, fake);
    await page.getByTestId('own-reader').getByRole('switch').nth(1).click(); await expect.poll(() => fake.rv.checkout).toBe(true); expect(fake.rv.ownReader).toBe(false);
    const p2 = await page.context().newPage(); const f2 = new FakeShop(); f2.rv.ownReader = true; await go(p2, f2); await expect(p2.getByTestId('own-reader').getByRole('switch')).toHaveCount(1);
  });
});
