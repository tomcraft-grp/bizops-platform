// The end-of-day slip review dashboard ("Slips to check" on Payment review) against the fake backend (fakeBackend.ts + fakeReview.ts). The staff app is English by default.
// Who may do what, and what the money does, is enforced and tested for real by the SQL suites; these tests prove that staff can DO the work on the screens, that the
// screens only offer what a role may do, that nothing the AI says is ever pressed for a person, and that what is sent is only identifiers and the staff member's inputs.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FakeShop } from './fakeBackend';
import type { FRole } from './fakeWallet';
import { REVIEW_DETAIL_KEYS, REVIEW_ITEM_KEYS, REVIEW_SETTING_KEYS, REVIEW_SUMMARY_KEYS } from '../../src/finance/review';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

async function openReview(page: Page, fake: FakeShop, role: FRole = 'manager', lang: 'en' | 'th' = 'en', seed = true) {
  fake.profile.role = 'SUPER_ADMIN'; fake.profile.display_name = 'Staff'; fake.w.role = role;
  if (seed) fake.rv.seed();
  await fake.install(page);
  await page.clock.setFixedTime(new Date(fake.rv.clockIso));                    // the staff page and the fake database are at the same moment (timers still run): "today" is 19 Nov 2026, 12:00 in Bangkok
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, lang);
  await page.goto('/#/payment-review');
  await expect(page.getByRole('heading', { name: lang === 'en' ? 'Payment review' : 'ตรวจสอบการชำระเงิน' }).first()).toBeVisible();
}
const rows = (page: Page) => page.locator('table.t tbody tr');
const row = (page: Page, no: string) => page.locator('table.t tbody tr', { hasText: no });
/** the dashboard's own search box (the app's top bar has one too) */
const search = (page: Page) => page.getByPlaceholder('Order, invoice, customer or bank reference');
const kpi = (page: Page, id: string) => page.locator(`[data-kpi="${id}"]`);
/** the topmost dialog (the detail may have a confirm dialog or the record-payment form on top of it) */
const dlg = (page: Page) => page.locator('.modal').last();
const open = async (page: Page, no: string) => { await row(page, no).getByRole('button', { name: /^(Review|View)$/ }).click(); await expect(dlg(page)).toContainText('Payment ·'); };
const axeBad = async (page: Page, name: string) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
  expect(bad, `${name}: ${bad.join('\n')}`).toEqual([]);
};
const lastList = (fake: FakeShop) => fake.calls.filter((c) => c.fn === 'finance_review_list').at(-1)!.args;
/** open a slip, press Confirm, and send the form as it was pre-filled (what a human does after checking the bank record) */
const confirmIt = async (page: Page, no: string, differs = false) => {
  await open(page, no);
  await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
  await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
  if (differs) await dlg(page).getByRole('button', { name: 'Record bank amount' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
};

test.describe('the list and the KPI strip', () => {
  test('KPI numbers, badges and the default list of unresolved payments (newest first)', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake);
    await expect(page.getByRole('tab', { name: /Slips to check/ })).toContainText('5');                                  // submitted + confirmed
    for (const [id, text] of [['awaiting', '5'], ['expected', '฿1,540.00'], ['ai_read', '฿1,370.00'], ['ai_passed', '1'], ['manual', '1'], ['suspicious', '1'], ['confirmed', '1'], ['posted', '1']] as const) await expect(kpi(page, id), id).toContainText(text);
    await expect(kpi(page, 'confirmed')).toContainText('฿220.00'); await expect(kpi(page, 'posted')).toContainText('฿180.00');
    await expect(rows(page)).toHaveCount(5);                                                                                // the posted one is resolved: hidden until "Show all"
    await expect(rows(page).nth(0)).toContainText('INV-000104'); await expect(rows(page).nth(4)).toContainText('INV-000105');
    await expect(row(page, 'INV-000101')).toContainText('Verified / Match'); await expect(row(page, 'INV-000101')).toContainText('AI check passed — not proof of payment');
    await expect(row(page, 'INV-000101')).toContainText('AI Verification Completed'); await expect(row(page, 'INV-000101')).toContainText('97%');
    await expect(row(page, 'INV-000101')).toContainText('19 Nov 2026'); await expect(row(page, 'INV-000101')).toContainText('10:12');
    await expect(row(page, 'INV-000102')).toContainText('Amount Mismatch'); await expect(row(page, 'INV-000102')).toContainText('Manual Review Required');
    await expect(row(page, 'INV-000102')).toContainText('฿350.00'); await expect(row(page, 'INV-000102')).toContainText('฿300.00');
    await expect(row(page, 'INV-000103')).toContainText('Duplicate Suspected');
    await expect(row(page, 'INV-000103').getByText(/already used on another slip/)).toHaveCount(1);                         // two DUPLICATE_REFERENCE reasons are shown once
    await expect(row(page, 'INV-000104')).toContainText('AI check in progress'); await expect(row(page, 'INV-000104')).toContainText('Slip Submitted');
    await expect(row(page, 'INV-000105')).toContainText('Payment Confirmed');
    await expect(row(page, 'INV-000102')).toHaveAttribute('data-discrepancy', 'true');                                    // tinted: the AI read less than the order expects
    await expect(row(page, 'INV-000101')).not.toHaveAttribute('data-discrepancy', 'true');
    await expect(page.locator('table.t thead th')).toHaveText(['Order', 'Customer', 'Order date', 'Expected', 'Transferred (AI)', 'Transaction date', 'Transaction time', 'AI result', 'Confidence', 'Payment status', 'Action']);
    await expect(kpi(page, 'expected')).toHaveAttribute('title', /once for every awaiting slip/);                           // an invoice with two awaiting slips is counted twice
    for (const id of ['ai_passed', 'manual', 'suspicious']) await expect(kpi(page, id)).toHaveAttribute('title', /need not add up to Awaiting/);
    expect(lastList(fake)).toMatchObject({ p_limit: 50, p_offset: 0, p_filter: { stage: ['slip_submitted', 'ai_completed', 'manual_review', 'confirmed', 'more_evidence'] } });
  });

  test('"Show all" adds posted and rejected; zero expected shows a dash and a confirmed amount fills "Transferred"', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake);
    await page.getByLabel('Show all (including posted and rejected)').check();
    await expect(rows(page)).toHaveCount(6);
    const posted = row(page, 'INV-000106');
    await expect(posted).toContainText('Invoice Posted');
    const cells = posted.locator('td');
    await expect(cells.nth(3)).toHaveText('—');                                                                              // nothing expected any more (the invoice is paid): not "฿0.00"
    await expect(cells.nth(4)).toContainText('฿180.00');                                                                     // no AI reading: the confirmed amount
    await expect(cells.nth(4)).toContainText('confirmed');
    expect(lastList(fake).p_filter).toEqual({});
  });

  test('filters: AI result, the Suspicious chip, stage, reason, source, method and search', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake);
    await page.getByLabel('AI result').selectOption('amount_mismatch');
    await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('INV-000102');
    await page.getByLabel('AI result').selectOption('');
    await expect(rows(page)).toHaveCount(5);
    await page.getByRole('button', { name: /^Suspicious/ }).click();
    await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('INV-000103');
    expect((lastList(fake).p_filter as { ai_result: string[] }).ai_result.sort()).toEqual(['duplicate_suspected', 'suspicious_slip']);
    await page.getByRole('button', { name: /^Suspicious/ }).click();
    await page.getByLabel('Stage', { exact: true }).selectOption('confirmed'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('INV-000105');
    await page.getByLabel('Stage', { exact: true }).selectOption('posted'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('INV-000106');   // a chosen stage needs no "Show all"
    await page.getByLabel('Stage', { exact: true }).selectOption('');
    await page.getByLabel('Reason').selectOption('AMOUNT_UNDER'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('INV-000102');
    await page.getByLabel('Reason').selectOption('');
    await search(page).fill('SCB777000222'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('INV-000102');   // a bank reference the AI read
    await search(page).fill('boonmee'); await expect(rows(page)).toHaveCount(1);
    await search(page).fill('nobody'); await expect(page.getByText('No payments match these filters')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click(); await expect(rows(page)).toHaveCount(5);
    await page.getByLabel('Method').selectOption('cash'); await expect(page.getByText('No payments match these filters')).toBeVisible();
    await page.getByLabel('Method').selectOption(''); await page.getByLabel('Source').selectOption('staff_entry'); await expect(page.getByText('No payments match these filters')).toBeVisible();
    await page.getByLabel('Source').selectOption('');
    await page.getByLabel('From date').fill('2026-11-20'); await expect(page.getByText('No payments match these filters')).toBeVisible();      // dates are calendar days
    await page.getByLabel('From date').fill('2026-11-19'); await page.getByLabel('To date').fill('2026-11-19'); await expect(rows(page)).toHaveCount(5);
    expect(lastList(fake).p_filter).toMatchObject({ from: '2026-11-19', to: '2026-11-19' });
  });

  test('the list is paged by 50', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.seed();
    for (let k = 0; k < 55; k++) { const e = { ...fake.rv.evidence[0], id: `ev-x${k}`, created_at: `2026-11-18T${String(8 + Math.floor(k / 60)).padStart(2, '0')}:${String(k % 60).padStart(2, '0')}:00+07:00` }; fake.rv.evidence.push(e); }
    await openReview(page, fake, 'manager', 'en', false);
    await expect(rows(page)).toHaveCount(50); await expect(page.getByText('1–50 of 60')).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(rows(page)).toHaveCount(10); expect(lastList(fake)).toMatchObject({ p_limit: 50, p_offset: 50 });
  });
});

test.describe('paging after an action', () => {
  test('dealing with the only row of the last page shows the new last page, not an empty list', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.seed();
    for (let k = 0; k < 46; k++) fake.rv.evidence.push({ ...fake.rv.evidence[0], id: `ev-x${k}`, created_at: `2026-11-18T08:${String(k).padStart(2, '0')}:00+07:00` });   // 5 + 46 unresolved = 51: one row on page 2
    await openReview(page, fake, 'verifier', 'en', false);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().getByRole('button', { name: 'Review' }).click();
    await dlg(page).getByRole('button', { name: 'Reject' }).click(); await dlg(page).getByLabel('Reason (shown to the customer)').fill('Not our slip'); await dlg(page).getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(50); await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);      // 50 left: one page, no pager
  });
});

test.describe('the detail: slip beside the order', () => {
  test('the mismatch slip: expected ฿350 against found ฿300 in red, the reasons, the signed slip and the reminder that AI is a hint', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000102');
    const d = dlg(page);
    await expect(d).toContainText('AI result is a hint, not proof that money arrived. Check your bank record.');
    await expect(d.getByRole('img', { name: 'Payment slip' })).toBeVisible();
    await expect(d).toContainText('ORD-000102'); await expect(d).toContainText('Mixed fruit pod 6000');                  // the order beside the slip
    const amount = d.locator('[data-cmp="amount"]');
    await expect(amount).toContainText('฿350.00'); await expect(amount).toContainText('฿300.00'); await expect(amount).toContainText('93%');
    await expect(amount).toHaveAttribute('data-differs', 'true'); await expect(amount.locator('.bad')).toContainText('฿300.00');
    await expect(d.locator('[data-cmp="date"]')).toHaveAttribute('data-differs', 'false');
    for (const f of ['amount', 'date', 'time', 'receiver', 'bank', 'reference']) await expect(d.locator(`[data-cmp="${f}"]`)).toHaveCount(1);
    await expect(d.getByRole('list', { name: 'Reasons' })).toContainText('The slip shows less than the order expects');
    await expect(d.getByRole('list', { name: 'Reasons' })).toContainText('฿350');
    await expect(d.getByText('Analysis history')).toBeVisible();
    expect(fake.count('finance_confirm_evidence') + fake.count('finance_post_evidence') + fake.count('finance_reject_evidence')).toBe(0);   // looking changes nothing
  });

  test('an info reason is shown prominently and never presses anything; a duplicate shows its reason once and the tamper signal', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000101');
    await expect(dlg(page).getByText(/resent a transfer already sent on an earlier slip/)).toBeVisible();
    await expect(dlg(page)).not.toContainText('ev-0');                                                                       // the "found" of this reason is an internal id: only the sentence is shown
    await expect(dlg(page)).toContainText('AI check passed — not proof of payment');
    await dlg(page).getByRole('button', { name: 'Close' }).click();
    await open(page, 'INV-000103');
    await expect(dlg(page).getByRole('list', { name: 'Reasons' }).getByText(/already used on another slip/)).toHaveCount(1);
    await expect(dlg(page)).toContainText('The digits of the amount use another font');
    expect(fake.calls.filter((c) => /confirm|post|reject|request_more|record/.test(c.fn)).length).toBe(0);
  });

  test('a PDF slip and a payment recorded by staff (no file) are shown for what they are', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.seed(); Object.assign(fake.rv.evidence[1], { file_type: 'application/pdf' });
    await openReview(page, fake, 'verifier', 'en', false); await open(page, 'INV-000102');
    await expect(dlg(page).getByRole('link', { name: 'Open the PDF slip' })).toBeVisible();
    await dlg(page).getByRole('button', { name: 'Close' }).click();
    fake.rv.rpc('finance_record_payment', { p_invoice: 'inv-4', p_method: 'cash', p_amount: 50, p_received_at: new Date(fake.rv.clockIso).toISOString(), p_bank_trans_ref: null, p_bank_account: null, p_note: 'Counter' });
    await search(page).fill('INV-000104'); await expect(rows(page)).toHaveCount(2);
    await row(page, 'INV-000104').filter({ hasText: 'Cash' }).getByRole('button', { name: 'Review' }).click();
    await expect(dlg(page)).toContainText('Recorded by staff'); await expect(dlg(page)).toContainText('No slip file');
    await expect(dlg(page).getByRole('button', { name: 'Request more evidence' })).toHaveCount(0);                            // there is no customer slip to ask for
  });

  test('a failed reading shows its reason to staff; Run AI check queues a new attempt and calls the reader', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.seed(); fake.rv.failLatest('ev-4', 'AI_TIMEOUT: the reader did not answer in time');
    await openReview(page, fake, 'verifier', 'en', false);
    await expect(row(page, 'INV-000104')).toContainText('AI check failed');
    await open(page, 'INV-000104');
    await expect(dlg(page)).toContainText('AI_TIMEOUT: the reader did not answer in time');
    await dlg(page).getByRole('button', { name: 'Run AI check' }).click();
    await expect(dlg(page)).toContainText('AI check in progress');                                                           // attempt 2 is queued; the stub only records the call
    expect(fake.count('finance_request_analysis')).toBe(1); expect(fake.rv.analyzeCalls).toEqual([{ evidence_id: 'ev-4' }]);
    await expect(dlg(page).getByRole('button', { name: 'Run AI check' })).toBeEnabled();
    await expect(dlg(page).locator('[data-history] tbody tr')).toHaveCount(2);                                               // the old attempt is kept
  });

  test('a queued slip can be run by hand (the "already queued" answer is not an error); a switched-off AI is explained', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000104');
    await expect(dlg(page)).toContainText('AI check in progress');
    await dlg(page).getByRole('button', { name: 'Run AI check' }).click();
    await expect.poll(() => fake.rv.analyzeCalls.length).toBe(1);
    await expect(page.locator('.toast.error')).toHaveCount(0);
    fake.rv.settings.ai_review_enabled = false; fake.rv.analyses = fake.rv.analyses.filter((a) => a.evidence_id !== 'ev-4');
    await dlg(page).getByRole('button', { name: 'Close' }).click(); await open(page, 'INV-000104');
    await dlg(page).getByRole('button', { name: 'Run AI check' }).click();
    await expect(page.locator('.toast.error')).toContainText('The AI check is switched off');
    await expect(page.locator('.toast.error')).toContainText('การตรวจด้วย AI ถูกปิดอยู่');                                    // and in Thai
  });
});

test.describe('confirm, post, reject, request more, record payment', () => {
  test('a verifier confirms with the amount the AI read pre-filled; the slip becomes Payment Confirmed and there is NO Post when only a manager may post', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.settings.post_requires_manager = true; await openReview(page, fake, 'verifier');
    await open(page, 'INV-000102');
    expect(fake.count('finance_confirm_evidence')).toBe(0);                                                                  // opening a slip confirms nothing
    await expect(dlg(page).getByRole('button', { name: /Post/ })).toHaveCount(0);                                            // not Post Invoice, not Confirm & Post
    await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    const d = dlg(page);
    await expect(d.getByLabel('Amount received (฿)')).toHaveValue('300');                                                   // pre-filled from what the AI read, editable
    await expect(d.getByLabel('Bank transaction reference')).toHaveValue('SCB777000222');
    await expect(d.getByLabel('Transfer date and time')).toHaveValue('2026-11-19T10:50');
    expect(fake.count('finance_confirm_evidence')).toBe(0);                                                                  // pre-filled is not sent
    const ok = d.getByRole('button', { name: 'Confirm', exact: true });
    await d.getByLabel('Amount received (฿)').fill(''); await expect(ok).toBeDisabled(); await d.getByLabel('Amount received (฿)').fill('300');
    await d.getByLabel('Bank transaction reference').fill(''); await expect(ok).toBeDisabled(); await d.getByLabel('Bank transaction reference').fill('SCB777000222');
    await expect(d.getByRole('button', { name: /Post/ })).toHaveCount(0);
    await ok.click();
    await dlg(page).getByRole('button', { name: 'Record bank amount' }).click();                                              // the bank shows ฿300 but the order expects ฿350
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(row(page, 'INV-000102')).toContainText('Payment Confirmed');
    const call = fake.calls.find((c) => c.fn === 'finance_confirm_evidence')!;
    expect(Object.keys(call.args).sort()).toEqual(['p_amount', 'p_bank_trans_ref', 'p_evidence', 'p_note', 'p_transfer_at']);
    expect(call.args).toMatchObject({ p_evidence: 'ev-2', p_amount: 300, p_bank_trans_ref: 'SCB777000222', p_transfer_at: new Date('2026-11-19T10:50:00+07:00').toISOString() });
    expect(fake.rv.evidence.find((e) => e.id === 'ev-2')).toMatchObject({ status: 'confirmed', confirmed_amount: 300 }); expect(fake.rv.receipts).toHaveLength(1);   // nothing was posted
    await expect(kpi(page, 'confirmed')).toContainText('2'); await expect(kpi(page, 'manual')).toContainText('0');
    await expect(page.getByRole('button', { name: /Post/ })).toHaveCount(0);                                                  // no Post Invoice in the list, no "Post all confirmed"
    await open(page, 'INV-000102'); await expect(dlg(page).getByRole('button', { name: /Post/ })).toHaveCount(0);
    await expect(dlg(page).getByRole('button', { name: 'Reject' })).toBeVisible();
    expect(() => fake.rpc('finance_post_evidence', { p_evidence: 'ev-2' })).toThrow(/not allowed/);                             // and the server would refuse it anyway
  });

  test('a manager posts a confirmed payment after a dialog that states the amount; the KPI strip follows', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.settings.post_requires_manager = true; await openReview(page, fake, 'manager');
    await row(page, 'INV-000105').getByRole('button', { name: 'Post Invoice' }).click();
    await expect(dlg(page)).toContainText('Post ฿220.00 to INV-000105?');
    expect(fake.count('finance_post_evidence')).toBe(0);
    await dlg(page).getByRole('button', { name: 'Post Invoice' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(kpi(page, 'posted')).toContainText('2'); await expect(kpi(page, 'posted')).toContainText('฿400.00'); await expect(kpi(page, 'confirmed')).toContainText('0'); await expect(kpi(page, 'awaiting')).toContainText('4');
    await expect(row(page, 'INV-000105')).toHaveCount(0);
    expect(fake.calls.find((c) => c.fn === 'finance_post_evidence')!.args).toEqual({ p_evidence: 'ev-5', p_note: null });      // only the id: no amount is ever sent
    expect(fake.rv.evidence.find((e) => e.id === 'ev-5')).toMatchObject({ status: 'verified', posted_at: expect.any(String) });
    await page.getByLabel('Show all (including posted and rejected)').check();
    await expect(row(page, 'INV-000105')).toContainText('Invoice Posted');
  });

  test('without the manager rule a verifier can Confirm & Post in one step, after a dialog that states the amount', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000101');
    await dlg(page).getByRole('button', { name: 'Confirm & Post' }).click();
    await expect(dlg(page).getByLabel('Amount received (฿)')).toHaveValue('350');
    await dlg(page).getByRole('button', { name: 'Confirm & Post' }).click();
    await expect(dlg(page)).toContainText('Confirm and post ฿350.00');
    await dlg(page).getByRole('button', { name: 'Post Invoice' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(fake.calls.filter((c) => /confirm|post/.test(c.fn)).map((c) => c.fn)).toEqual(['finance_confirm_evidence', 'finance_post_evidence']);
    expect(fake.rv.receipts.at(-1)).toMatchObject({ amount: 350, evidence_id: 'ev-1' });
    await expect(kpi(page, 'posted')).toContainText('2'); await expect(kpi(page, 'ai_passed')).toContainText('0');
  });

  test('a manager confirms a second slip, then posts both confirmed payments at once with a result per row (one failure does not stop the rest)', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.settings.post_requires_manager = true; await openReview(page, fake, 'manager');
    await confirmIt(page, 'INV-000102', true);
    await expect(kpi(page, 'confirmed')).toContainText('2');
    await page.getByRole('button', { name: 'Post all confirmed (2)' }).click();
    await expect(dlg(page)).toContainText('Post 2 confirmed payments?'); await expect(dlg(page)).toContainText('฿520.00');
    fake.failNext('finance_post_evidence', 1);                                                                                // the first post fails (a dropped request), the second one goes through
    await dlg(page).getByRole('button', { name: 'Post all confirmed' }).click();
    const res = page.locator('[data-bulk-results]');
    await expect(res).toContainText('ORD-000102'); await expect(res).toContainText('ORD-000105');
    await expect(res.locator('[data-ok="false"]')).toHaveCount(1); await expect(res.locator('[data-ok="false"]')).toContainText('boom');
    await expect(res.locator('[data-ok="true"]')).toHaveCount(1); await expect(res.locator('[data-ok="true"]')).toContainText('RC-000002');
    await expect(kpi(page, 'posted')).toContainText('2'); await expect(kpi(page, 'confirmed')).toContainText('1');             // the failed one is still confirmed and can be tried again
    await page.getByRole('button', { name: 'Post all confirmed (1)' }).click(); await dlg(page).getByRole('button', { name: 'Post all confirmed' }).click();
    await expect(res.locator('[data-ok="true"]')).toHaveCount(1); await expect(kpi(page, 'posted')).toContainText('3'); await expect(kpi(page, 'confirmed')).toContainText('0');
    await expect(page.getByRole('button', { name: /Post all confirmed/ })).toHaveCount(0);
    expect(fake.rv.receipts).toHaveLength(3);
  });

  test('reject needs a reason, states the amount, and the customer will see the reason', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000103');
    await dlg(page).getByRole('button', { name: 'Reject' }).click();
    const d = dlg(page);
    await expect(d).toContainText('฿500.00');
    await expect(d.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await d.getByLabel('Reason (shown to the customer)').fill('This reference is already on another order');
    await d.getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator('.modal')).toHaveCount(0); await expect(row(page, 'INV-000103')).toHaveCount(0);
    expect(fake.rv.evidence.find((e) => e.id === 'ev-3')).toMatchObject({ status: 'rejected', reject_reason: 'This reference is already on another order' });
    expect(fake.calls.find((c) => c.fn === 'finance_reject_evidence')!.args).toEqual({ p_evidence: 'ev-3', p_reason: 'This reference is already on another order' });
    await expect(kpi(page, 'suspicious')).toContainText('0');
  });

  test('request more evidence needs a message of 3 to 300 characters', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000102');
    await dlg(page).getByRole('button', { name: 'Request more evidence' }).click();
    const d = dlg(page); const send = d.getByRole('button', { name: 'Send request' });
    await expect(send).toBeDisabled();
    await d.getByLabel('Message to the customer').fill('ab'); await expect(send).toBeDisabled();
    await d.getByLabel('Message to the customer').fill('Please send the whole slip, with the time shown'); await expect(send).toBeEnabled();
    await send.click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(row(page, 'INV-000102')).toContainText('More Evidence Requested');                                           // still waiting: it stays in the list
    expect(fake.rv.evidence.find((e) => e.id === 'ev-2')).toMatchObject({ status: 'more_evidence', request_message: 'Please send the whole slip, with the time shown' });
    await open(page, 'INV-000102'); await expect(dlg(page)).toContainText('Please send the whole slip, with the time shown');
    await expect(dlg(page).getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);                              // nothing to confirm until the customer answers
  });

  test('record payment: cash over what can still be added shows the server error, then ฿150 in cash appears as Payment Confirmed', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000102');
    await dlg(page).getByRole('button', { name: 'Record payment' }).click();
    const d = dlg(page);
    await expect(d).toContainText('Record payment · INV-000102'); await expect(d).toContainText('฿350.00');                  // what the invoice can still take
    await expect(d.getByLabel('Bank transaction reference')).toBeVisible();                                                  // a transfer is the default: reference, bank and file
    await d.getByLabel('Payment method').selectOption('cash');
    for (const l of ['Bank transaction reference', 'Bank account', 'Slip file (optional)']) await expect(d.getByLabel(l)).toHaveCount(0);
    const ok = d.getByRole('button', { name: 'Record payment' });
    await d.getByLabel('Amount (฿)').fill('500'); await expect(ok).toBeDisabled();                                            // the note is required
    await d.getByLabel('Note').fill('Cash at the counter');
    await expect(d).toContainText('More than the ฿350.00 that can still be added');
    await ok.click();
    await expect(page.locator('.toast.error')).toContainText('EXCEEDS_OUTSTANDING');
    await expect(page.locator('.toast.error')).toContainText('more than can still be added to this invoice');
    await expect(d).toBeVisible();                                                                                           // the form stays so it can be corrected
    await d.getByLabel('Amount (฿)').fill('150'); await ok.click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(row(page, 'INV-000102').filter({ hasText: 'Cash' })).toContainText('Payment Confirmed');
    await expect(row(page, 'INV-000102').filter({ hasText: 'Cash' })).toContainText('฿150.00');
    const calls = fake.calls.filter((c) => c.fn === 'finance_record_payment');
    expect(calls).toHaveLength(2); expect(calls[1].args).toEqual({ p_invoice: 'inv-2', p_method: 'cash', p_amount: 150, p_received_at: expect.any(String), p_bank_trans_ref: null, p_bank_account: null, p_note: 'Cash at the counter', p_file_path: null, p_sha256: null, p_file_type: null });
    expect(fake.rv.evidence.at(-1)).toMatchObject({ source: 'staff_entry', method: 'cash', status: 'confirmed', confirmed_amount: 150 });
    await expect(kpi(page, 'confirmed')).toContainText('2');
  });

  test('record payment by transfer needs the bank and the reference; the Invoices tab has a Record payment button for a verifier but not a viewer', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier');
    await page.getByRole('tab', { name: 'Invoices' }).click();
    await expect(page.locator('table.t tbody tr', { hasText: 'INV-000106' })).toBeVisible();
    await expect(page.locator('table.t tbody tr', { hasText: 'INV-000106' }).getByRole('button', { name: 'Record payment' })).toHaveCount(0);   // fully paid: nothing to record
    await page.locator('table.t tbody tr', { hasText: 'INV-000104' }).getByRole('button', { name: 'Record payment' }).click();
    const d = dlg(page); const ok = d.getByRole('button', { name: 'Record payment' });
    await d.getByLabel('Amount (฿)').fill('100'); await d.getByLabel('Note').fill('Paid by phone banking');
    await expect(ok).toBeDisabled();                                                                                         // a transfer needs its bank and reference
    await d.getByLabel('Bank account').selectOption({ label: 'SCB · ธนาคารไทยพาณิชย์' }); await d.getByLabel('Bank transaction reference').fill('SCB-REC-0001');
    await expect(ok).toBeEnabled(); await ok.click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(fake.calls.find((c) => c.fn === 'finance_record_payment')!.args).toMatchObject({ p_invoice: 'inv-4', p_method: 'transfer', p_amount: 100, p_bank_trans_ref: 'SCB-REC-0001', p_bank_account: 'bank-scb', p_note: 'Paid by phone banking' });
    const page2 = await page.context().newPage(); const fake2 = new FakeShop(); await openReview(page2, fake2, 'viewer');
    await page2.getByRole('tab', { name: 'Invoices' }).click(); await expect(page2.locator('table.t tbody tr').first()).toBeVisible();
    await expect(page2.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  });

  test('a server refusal is shown as a readable sentence in both languages with the server message under it', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'manager');
    await open(page, 'INV-000105');
    fake.rv.evidence.find((e) => e.id === 'ev-5')!.status = 'rejected';                                                        // somebody else rejected it meanwhile
    await dlg(page).getByRole('button', { name: 'Post Invoice' }).click(); await dlg(page).getByRole('button', { name: 'Post Invoice' }).click();
    const toast = page.locator('.toast.error');
    await expect(toast).toContainText('This payment is not confirmed, so it cannot be posted');
    await expect(toast).toContainText('การชำระเงินนี้ยังไม่ได้ยืนยัน จึงลงรายการไม่ได้');
    await expect(toast).toContainText('NOT_CONFIRMED');
  });

  test('every action button is disabled while its request runs (no double submit)', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'manager');
    await page.route('**/rest/v1/rpc/finance_post_evidence', async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.fallback(); });
    await row(page, 'INV-000105').getByRole('button', { name: 'Post Invoice' }).click();
    await dlg(page).getByRole('button', { name: 'Post Invoice' }).click();
    await expect(row(page, 'INV-000105').getByRole('button', { name: 'Post Invoice' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Post all confirmed/ })).toBeDisabled();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect.poll(() => fake.count('finance_post_evidence')).toBe(1);                                                    // the request is on its way (held back for 800 ms)
    await expect(row(page, 'INV-000105')).toHaveCount(0);                                                                    // done: the list no longer has it
    expect(fake.count('finance_post_evidence')).toBe(1);                                                                      // and it was sent once
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('only what the AI really read is pre-filled', () => {
  test('a time the AI could not read is NOT filled in as if it were read: the field is empty, Confirm waits for a typed time, the note does not claim it', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.seed();
    Object.assign(fake.rv.analyses.find((a) => a.evidence_id === 'ev-2')!.extracted!, { time_known: false, transfer_at: '2026-11-19T12:00:00+07:00' });   // what slip-analyze stores when the time was not on the slip
    await openReview(page, fake, 'verifier', 'en', false); await open(page, 'INV-000102');
    await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    const d = dlg(page); const ok = d.getByRole('button', { name: 'Confirm', exact: true });
    await expect(d.getByLabel('Amount received (฿)')).toHaveValue('300'); await expect(d.getByLabel('Bank transaction reference')).toHaveValue('SCB777000222');
    await expect(d.getByLabel('Transfer date and time')).toHaveValue('');                                                    // not 12:00
    await expect(d.locator('[data-note="prefilled"]')).toContainText('the amount, the bank reference'); await expect(d.locator('[data-note="prefilled"]')).not.toContainText('date and time');
    await expect(d.locator('[data-note="time-unread"]')).toContainText('19 Nov 2026');                                        // the date is a hint, not a value
    await expect(ok).toBeDisabled(); await expect(d.getByRole('button', { name: 'Confirm & Post' })).toBeDisabled();
    await d.getByLabel('Transfer date and time').fill('2026-11-19T10:50'); await expect(ok).toBeEnabled();
    await ok.click(); await dlg(page).getByRole('button', { name: 'Record bank amount' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(fake.calls.find((c) => c.fn === 'finance_confirm_evidence')!.args).toMatchObject({ p_transfer_at: new Date('2026-11-19T10:50:00+07:00').toISOString() });   // what the person typed, not noon
  });

  test('a time the AI did read is still filled in, and the note names the time', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000102');
    await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dlg(page).getByLabel('Transfer date and time')).toHaveValue('2026-11-19T10:50');
    await expect(dlg(page).locator('[data-note="prefilled"]')).toContainText('the amount, the bank reference, the transfer date and time');
    await expect(dlg(page).locator('[data-note="time-unread"]')).toHaveCount(0);
  });
});

test.describe('the tiles follow the date filter', () => {
  test('Posted means today until a range is chosen; then it follows the range and says so', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake);
    const sums = () => fake.calls.filter((c) => c.fn === 'finance_review_summary').map((c) => c.args);
    await expect(kpi(page, 'posted')).toContainText('Posted today'); await expect(kpi(page, 'posted')).toContainText('฿180.00');
    expect(sums().at(-1)).toEqual({ p_from: '2026-11-19', p_to: '2026-11-19' });                                              // no date chosen: today, in Bangkok
    await page.getByLabel('From date').fill('2026-11-01'); await page.getByLabel('To date').fill('2026-11-18');
    await expect(kpi(page, 'posted')).toContainText('Posted (in range)'); await expect(kpi(page, 'posted')).toContainText('฿0.00');
    expect(sums().at(-1)).toEqual({ p_from: '2026-11-01', p_to: '2026-11-18' });
    await expect(kpi(page, 'awaiting')).toContainText('5');                                                                    // the unresolved counts do not depend on the range
    await page.getByLabel('To date').fill('2026-11-19'); await expect(kpi(page, 'posted')).toContainText('฿180.00');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(kpi(page, 'posted')).toContainText('Posted today'); expect(sums().at(-1)).toEqual({ p_from: '2026-11-19', p_to: '2026-11-19' });
  });

  test('on the next day yesterday’s posted payments are not "today"; the label is Thai in Thai', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.clockIso = '2026-11-20T09:00:00+07:00'; await openReview(page, fake, 'manager', 'th');
    await expect(kpi(page, 'posted')).toContainText('ลงรายการวันนี้'); await expect(kpi(page, 'posted')).toContainText('฿0.00');
    expect(fake.calls.filter((c) => c.fn === 'finance_review_summary').at(-1)!.args).toEqual({ p_from: '2026-11-20', p_to: '2026-11-20' });
  });
});

test.describe('a hint when more than the invoice owes is entered', () => {
  test('the Confirm form and the Confirm & Post dialog say the extra is credited to the customer’s wallet; nothing is said for an amount that is not above', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000101');
    await dlg(page).getByRole('button', { name: 'Confirm & Post' }).click();
    const d = dlg(page);
    await expect(d.locator('[data-note="over-owed"]')).toHaveCount(0);                                                       // ฿350 on a ฿350 invoice
    await d.getByLabel('Amount received (฿)').fill('400');
    await expect(d.locator('[data-note="over-owed"]')).toContainText('฿50.00 over'); await expect(d.locator('[data-note="over-owed"]')).toContainText('credited to the customer’s wallet');
    await d.getByLabel('Amount received (฿)').fill('349'); await expect(d.locator('[data-note="over-owed"]')).toHaveCount(0);
    await d.getByLabel('Amount received (฿)').fill('400');
    await d.getByRole('button', { name: 'Confirm & Post' }).click();
    await dlg(page).getByRole('button', { name: 'Record bank amount' }).click();                                              // ฿400 is not the ฿350 the order expects
    await expect(dlg(page)).toContainText('Confirm and post ฿400.00 to INV-000101?'); await expect(dlg(page)).toContainText('credited to the customer’s wallet');
    await dlg(page).getByRole('button', { name: 'Cancel' }).click();
    expect(fake.count('finance_confirm_evidence')).toBe(0);
  });

  test('the Post dialog of a confirmed payment says it only when the amount is above what the invoice owes', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.settings.post_requires_manager = true; fake.rv.seed();
    Object.assign(fake.rv.evidence.find((e) => e.id === 'ev-5')!, { confirmed_amount: 300 });                                    // confirmed above the ฿220 the invoice owes
    await openReview(page, fake, 'manager', 'en', false);
    await row(page, 'INV-000105').getByRole('button', { name: 'Post Invoice' }).click();
    await expect(dlg(page)).toContainText('Post ฿300.00 to INV-000105?'); await expect(dlg(page)).toContainText('฿80.00 over'); await expect(dlg(page)).toContainText('credited to the customer’s wallet');
    await dlg(page).getByRole('button', { name: 'Cancel' }).click();
    const page2 = await page.context().newPage(); const fake2 = new FakeShop(); fake2.rv.settings.post_requires_manager = true; await openReview(page2, fake2, 'manager');    // the same payment, confirmed for exactly what the invoice owes
    await row(page2, 'INV-000105').getByRole('button', { name: 'Post Invoice' }).click();
    await expect(dlg(page2)).toContainText('Post ฿220.00 to INV-000105?'); await expect(dlg(page2)).not.toContainText('credited to the customer’s wallet');
  });
});

test.describe('times are Bangkok time in a browser set to another zone', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('the Confirm form shows and sends the Bangkok moment; the Record payment form starts at the Bangkok clock and sends what was typed as Bangkok time', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'verifier'); await open(page, 'INV-000102');
    await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dlg(page).getByLabel('Transfer date and time')).toHaveValue('2026-11-19T10:50');                              // 19:50 the evening before in Los Angeles
    await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click(); await dlg(page).getByRole('button', { name: 'Record bank amount' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(fake.calls.find((c) => c.fn === 'finance_confirm_evidence')!.args).toMatchObject({ p_transfer_at: '2026-11-19T03:50:00.000Z' });
    await open(page, 'INV-000104'); await dlg(page).getByRole('button', { name: 'Record payment' }).click();
    const d = dlg(page);
    await expect(d.getByLabel('Received date and time')).toHaveValue('2026-11-19T12:00');                                      // "now" on the Bangkok clock
    await d.getByLabel('Payment method').selectOption('cash'); await d.getByLabel('Amount (฿)').fill('50'); await d.getByLabel('Note').fill('Cash at the counter');
    await d.getByLabel('Received date and time').fill('2026-11-19T00:30');                                                    // next to midnight
    await d.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(fake.calls.filter((c) => c.fn === 'finance_record_payment').at(-1)!.args).toMatchObject({ p_received_at: '2026-11-18T17:30:00.000Z' });
  });
});

test.describe('record payment: care with files, time, banks and closing', () => {
  const openRecord = async (page: Page, fake: FakeShop) => {
    await openReview(page, fake, 'verifier'); await page.getByRole('tab', { name: 'Invoices' }).click();
    await page.locator('table.t tbody tr', { hasText: 'INV-000104' }).getByRole('button', { name: 'Record payment' }).click();
    return dlg(page);
  };
  test('a slip file chosen for a transfer is dropped when the method becomes cash and is not sent when it goes back to transfer', async ({ page }) => {
    const fake = new FakeShop(); const uploads: string[] = []; page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/storage/v1/object/payment-evidence')) uploads.push(r.url()); });
    const d = await openRecord(page, fake);
    await d.getByLabel('Slip file (optional)').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG });
    await d.getByLabel('Payment method').selectOption('cash'); await d.getByLabel('Payment method').selectOption('transfer');
    await expect(d.getByLabel('Slip file (optional)')).toHaveValue('');                                                        // the picker is empty again, and so is what would be sent
    await d.getByLabel('Amount (฿)').fill('100'); await d.getByLabel('Note').fill('Paid by phone banking');
    await d.getByLabel('Bank account').selectOption({ label: 'SCB · ธนาคารไทยพาณิชย์' }); await d.getByLabel('Bank transaction reference').fill('SCB-REC-0002');
    await d.getByRole('button', { name: 'Record payment' }).click(); await expect(page.locator('.modal')).toHaveCount(0);
    expect(uploads).toHaveLength(0); expect(fake.calls.find((c) => c.fn === 'finance_record_payment')!.args).toMatchObject({ p_file_path: null, p_sha256: null, p_file_type: null });
  });

  test('a time more than 10 minutes ahead is refused in the form with a readable message', async ({ page }) => {
    const fake = new FakeShop(); const d = await openRecord(page, fake);
    await d.getByLabel('Payment method').selectOption('cash'); await d.getByLabel('Amount (฿)').fill('50'); await d.getByLabel('Note').fill('Cash at the counter');
    const ok = d.getByRole('button', { name: 'Record payment' }); await expect(ok).toBeEnabled();                                // now (12:00)
    await d.getByLabel('Received date and time').fill('2026-11-19T12:30');
    await expect(d).toContainText('This time is in the future. Check the date and time.'); await expect(ok).toBeDisabled();
    await d.getByLabel('Received date and time').fill('2026-11-19T12:05');                                                    // within the 10 minutes the database allows
    await expect(d).not.toContainText('This time is in the future'); await expect(ok).toBeEnabled();
    expect(fake.count('finance_record_payment')).toBe(0);
  });

  test('a transfer cannot be sent before the list of bank accounts has loaded', async ({ page }) => {
    const fake = new FakeShop();
    await page.route('**/rest/v1/finance_bank_accounts*', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.fallback(); });
    const d = await openRecord(page, fake);
    await d.getByLabel('Amount (฿)').fill('100'); await d.getByLabel('Note').fill('Paid by phone banking'); await d.getByLabel('Bank transaction reference').fill('SCB-REC-0003');
    const ok = d.getByRole('button', { name: 'Record payment' });
    await expect(d).toContainText('Loading the bank accounts…'); await expect(ok).toBeDisabled();
    await expect(d.getByLabel('Bank account')).toBeVisible(); await expect(d).not.toContainText('Loading the bank accounts…'); await expect(ok).toBeDisabled();   // loaded: now the bank must be chosen
    await d.getByLabel('Bank account').selectOption({ label: 'SCB · ธนาคารไทยพาณิชย์' }); await expect(ok).toBeEnabled();
  });

  test('Esc, the X and a click outside do nothing while the request runs; afterwards the form closes by itself', async ({ page }) => {
    const fake = new FakeShop();
    await page.route('**/rest/v1/rpc/finance_record_payment', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.fallback(); });
    const d = await openRecord(page, fake);
    await d.getByLabel('Payment method').selectOption('cash'); await d.getByLabel('Amount (฿)').fill('50'); await d.getByLabel('Note').fill('Cash at the counter');
    const ok = d.getByRole('button', { name: 'Record payment' }); await ok.click();
    await expect(ok).toBeDisabled();                                                                                        // the request is running (held back for 1.2 s)
    await page.keyboard.press('Escape'); await d.getByRole('button', { name: 'Close' }).click(); await page.mouse.click(5, 5);
    await expect(d).toBeVisible();
    await expect(page.locator('.modal')).toHaveCount(0);                                                                     // the answer came: done
    expect(fake.count('finance_record_payment')).toBe(1);
  });
});

test.describe('who sees what', () => {
  for (const role of ['viewer', 'clerk'] as const) {
    test(`a ${role} sees the list and the detail without any action button`, async ({ page }) => {
      const fake = new FakeShop(); await openReview(page, fake, role);
      await expect(rows(page)).toHaveCount(5); await expect(kpi(page, 'awaiting')).toContainText('5');
      await expect(page.getByRole('button', { name: /^(Confirm|Post|Reject|Record payment|Review)/ })).toHaveCount(0);
      await expect(page.getByText('Review settings')).toHaveCount(0);
      await open(page, 'INV-000102');
      for (const n of ['Confirm', 'Confirm & Post', 'Post Invoice', 'Reject', 'Request more evidence', 'Record payment', 'Run AI check']) await expect(dlg(page).getByRole('button', { name: n, exact: true }), n).toHaveCount(0);
      await expect(dlg(page)).toContainText('Your role can view payments but not act on them.');
      await expect(dlg(page).locator('[data-cmp="amount"]')).toContainText('฿300.00');                                           // everything can still be read
      expect(() => fake.rpc('finance_confirm_evidence', { p_evidence: 'ev-2', p_amount: 300, p_bank_trans_ref: 'SCB777000222', p_transfer_at: new Date().toISOString() })).toThrow(/not allowed/);
    });
  }

  test('only a manager sees Review settings, and can save the five settings', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'manager');
    const card = page.locator('section.review-settings');
    await expect(card).toBeVisible();
    await expect(card.getByRole('switch', { name: 'Run the AI reader on every new slip' })).toHaveAttribute('aria-checked', 'true');
    await card.getByRole('switch', { name: 'Only a manager may post' }).click();
    await card.getByLabel('Lowest confidence for an AI pass (0 to 1)').fill('0.9');
    await card.getByLabel('Slip may be dated this many minutes before the order').fill('90');
    await card.getByLabel('Slip may be dated this many minutes after it arrives').fill('5');
    await card.getByRole('button', { name: 'Save settings' }).click();
    await expect.poll(() => fake.rv.settings).toEqual({ ai_review_enabled: true, post_requires_manager: true, ai_min_confidence: 0.9, slip_window_before_min: 90, slip_future_tolerance_min: 5 });
    expect(Object.keys(fake.calls.find((c) => c.fn === 'finance_save_review_settings')!.args)).toEqual(['p_patch']);
    await card.getByLabel('Lowest confidence for an AI pass (0 to 1)').fill('2'); await card.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('.toast.error')).toContainText('INVALID_SETTING');                                                // the server's refusal is shown
    const page2 = await page.context().newPage(); await openReview(page2, new FakeShop(), 'verifier');
    await expect(page2.getByText('Review settings')).toHaveCount(0);
  });

  test('if the settings cannot be read, Post is offered only to a manager (the stricter rule)', async ({ page }) => {
    const fake = new FakeShop(); fake.failNext('finance_review_settings', 5); await openReview(page, fake, 'verifier');
    await expect(rows(page)).toHaveCount(5); await expect(page.getByRole('button', { name: /Post/ })).toHaveCount(0);
  });
});

test.describe('degrades and translates', () => {
  test('a database without the migration shows the existing "not set up" banner and the tab count falls back', async ({ page }) => {
    const fake = new FakeShop(); fake.rv.enabled = false; await openReview(page, fake, 'manager', 'en', false);
    await expect(page.getByText('The finance database part is not set up yet. An administrator needs to apply the finance migration in Supabase.')).toBeVisible();
    await expect(rows(page)).toHaveCount(0); await expect(page.getByRole('tab', { name: /Slips to check/ })).toBeVisible();
  });

  test('the dashboard, the detail and the actions are in Thai', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'manager', 'th');
    await expect(page.getByRole('tab', { name: /สลิปที่ต้องตรวจ/ })).toBeVisible();
    await expect(kpi(page, 'awaiting')).toContainText('รอตรวจสอบ');
    await expect(row(page, 'INV-000105')).toContainText('ยืนยันการชำระแล้ว'); await expect(row(page, 'INV-000101')).toContainText('AI ตรวจผ่านแล้ว — ไม่ใช่หลักฐานว่าเงินเข้าจริง');
    await expect(row(page, 'INV-000104')).toContainText('AI กำลังตรวจสอบ');
    await row(page, 'INV-000102').getByRole('button', { name: 'ตรวจสอบ' }).click();
    const d = dlg(page);
    await expect(d).toContainText('ผลของ AI เป็นเพียงข้อสังเกต ไม่ใช่หลักฐานว่าเงินเข้าจริง กรุณาตรวจสอบกับรายการเดินบัญชีของธนาคาร');
    await expect(d).toContainText('ยอดบนสลิปน้อยกว่ายอดที่ออเดอร์ต้องชำระ');
    await expect(d.getByRole('button', { name: 'ยืนยัน', exact: true })).toBeVisible();
    await expect(d.getByRole('button', { name: 'ลงรายการใบแจ้งหนี้' })).toHaveCount(0);                                        // a submitted slip has nothing to post yet
    await expect(d.getByRole('button', { name: 'บันทึกการชำระเงิน' })).toBeVisible();
    for (const english of ['Confirm', 'Reject', 'Request more evidence', 'Record payment', 'Analysis history']) await expect(d, english).not.toContainText(english);
  });
});

test.describe('phone and accessibility', () => {
  test('390 px: the page does not scroll sideways; the table scrolls inside its own box; the detail fits', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fake = new FakeShop(); await openReview(page, fake, 'manager');
    await expect(rows(page)).toHaveCount(5);
    const page_ = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
    const w = await page_(); expect(w.doc).toBeLessThanOrEqual(1); expect(w.body).toBeLessThanOrEqual(1);
    expect(await page.locator('.table-wrap').first().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);           // the eleven columns scroll inside .table-wrap
    await open(page, 'INV-000102');
    expect(await page.evaluate(() => { const m = document.querySelector('.modal')!; return m.scrollWidth - m.clientWidth; })).toBeLessThanOrEqual(1);
    const w2 = await page_(); expect(w2.doc).toBeLessThanOrEqual(1);
    await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    expect(await page.evaluate(() => { const m = document.querySelector('.modal')!; return m.scrollWidth - m.clientWidth; })).toBeLessThanOrEqual(1);
  });

  test('axe: no critical or serious violations on the dashboard, the detail, the confirm form and the record-payment form', async ({ page }) => {
    const fake = new FakeShop(); await openReview(page, fake, 'manager');
    await expect(rows(page)).toHaveCount(5);
    await axeBad(page, 'dashboard');
    await open(page, 'INV-000102'); await expect(dlg(page).getByRole('img', { name: 'Payment slip' })).toBeVisible();
    await axeBad(page, 'detail');
    await dlg(page).getByRole('button', { name: 'Confirm', exact: true }).click(); await axeBad(page, 'confirm form');
    await dlg(page).getByRole('button', { name: 'Cancel' }).click(); await dlg(page).getByRole('button', { name: 'Request more evidence' }).click(); await axeBad(page, 'request more');
    await dlg(page).getByRole('button', { name: 'Cancel' }).click(); await dlg(page).getByRole('button', { name: 'Record payment' }).click(); await axeBad(page, 'record payment');
  });
});

test.describe('the fake follows the contract', () => {
  test('its JSON has exactly the keys the SQL builds (the keys the client lists are compared with the SQL by the unit tests)', async () => {
    const fake = new FakeShop(); fake.w.role = 'manager'; fake.rv.seed();
    const sorted = (o: object) => Object.keys(o).sort();
    expect(sorted(fake.rv.item(fake.rv.evidence[0]))).toEqual([...REVIEW_ITEM_KEYS].sort());
    expect(sorted(fake.rpc('finance_review_summary', {}) as object)).toEqual([...REVIEW_SUMMARY_KEYS].sort());
    expect(sorted(fake.rpc('finance_review_detail', { p_evidence: 'ev-1' }) as object)).toEqual([...REVIEW_DETAIL_KEYS].sort());
    expect(sorted(fake.rpc('finance_review_settings', {}) as object)).toEqual([...REVIEW_SETTING_KEYS].sort());
  });

  test('roles, the outstanding limit, a reused bank reference and posting twice behave like the SQL', async () => {
    const fake = new FakeShop(); fake.rv.seed(); fake.rv.settings.post_requires_manager = true;
    const confirm = (id: string, ref: string, amount = 300) => fake.rpc('finance_confirm_evidence', { p_evidence: id, p_amount: amount, p_bank_trans_ref: ref, p_transfer_at: '2026-11-19T10:50:00+07:00' });
    fake.w.role = 'viewer'; expect(() => confirm('ev-2', 'SCB777000222')).toThrow(/not allowed to confirm/);
    fake.w.role = 'clerk'; expect(() => fake.rpc('finance_reject_evidence', { p_evidence: 'ev-2', p_reason: 'x' })).toThrow(/not allowed/);
    fake.w.role = 'verifier';
    expect(() => confirm('ev-2', 'ab')).toThrow(/4 to 80 letters or digits/); expect(() => confirm('ev-2', 'SCB777000222', 0)).toThrow(/amount shown by the bank/);
    confirm('ev-2', 'SCB-777-000-222');
    expect(() => confirm('ev-1', 'scb777000222')).toThrow(/already recorded/);                                              // the same transfer typed another way
    expect(() => confirm('ev-2', 'SCB777000299')).toThrow(/already confirmed/);
    expect(() => fake.rpc('finance_post_evidence', { p_evidence: 'ev-2' })).toThrow(/not allowed to post/);                  // a verifier cannot post while a manager is required
  });

  test('posting twice replays; record payment counts what is confirmed but not posted; cash needs a note', async () => {
    const fake = new FakeShop(); fake.rv.seed(); fake.w.role = 'manager';
    const first = fake.rpc('finance_post_evidence', { p_evidence: 'ev-5' }) as { replay: boolean; result: string };
    expect(first).toMatchObject({ replay: false, result: 'fully_paid' });
    expect(fake.rpc('finance_post_evidence', { p_evidence: 'ev-5' })).toMatchObject({ replay: true });
    expect(fake.rv.receipts).toHaveLength(2);
    const rec = (amount: number, note: string | null = 'Cash at the counter', invoice = 'inv-2') => fake.rpc('finance_record_payment', { p_invoice: invoice, p_method: 'cash', p_amount: amount, p_received_at: new Date().toISOString(), p_bank_trans_ref: null, p_bank_account: null, p_note: note });
    expect(() => rec(100, null)).toThrow(/NOTE_REQUIRED/); expect(() => rec(351)).toThrow(/EXCEEDS_OUTSTANDING: 351 is more than the 350/);
    rec(200); expect(() => rec(151)).toThrow(/EXCEEDS_OUTSTANDING: 151 is more than the 150/);                                // 200 is confirmed and waits to be posted
    expect(rec(150)).toMatchObject({ status: 'confirmed' });
  });
});
