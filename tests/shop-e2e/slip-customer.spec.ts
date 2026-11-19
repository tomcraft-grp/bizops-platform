// The customer side of the AI-assisted slip review: what the customer is told while the shop checks a slip (never "paid" before staff POST it), the paid /
// remaining line of a part-paid order, what the customer sees when the shop CONFIRMED a payment that is not posted yet, the "more evidence requested" flow (the
// staff message, the upload on the SAME invoice, no second order) and the best-effort call that asks the AI reader to look at a new slip. Against the fake backend
// (fakeBackend.ts): this proves the SCREENS and what the browser sends; the rules are proved in the database (supabase/tests/slip_review.sql).
//
// The one rule above all: a customer NEVER sees an AI result, a confidence, or any wording about the analysis, on any screen, in either language.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PENDING_TH = 'รอตรวจสอบการชำระเงิน – รอเจ้าหน้าที่ยืนยัน';
const PENDING_EN = 'Pending payment verification – awaiting staff confirmation';
const th = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const en = (k: K, v?: Record<string, string | number>) => tr('en', k, v);

async function open(page: Page, fake: FakeShop, lang: 'th' | 'en' = 'th') {
  if (lang === 'en') await page.addInitScript(() => { try { localStorage.setItem('tc.shop.lang', 'en'); } catch { /* ignore */ } });
  await fake.install(page);
  await page.goto('/#/app');
  await expect(page.locator('.phone-nav')).toBeVisible();
}
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const detail = (page: Page) => page.locator('.sp-order-detail');
const pills = async (page: Page) => (await detail(page).locator('.sp-pill').allTextContents()).join('|');

/** the checkout with a slip attached, up to the placed order's page */
async function placeWithSlip(page: Page) {
  await tab(page, th('nav.shop')).click();
  await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: th('p.add') }).click();
  await tab(page, th('nav.cart')).click();
  await page.getByRole('button', { name: th('cart.checkout') }).click();
  await page.getByLabel(th('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
  await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#' + Math.random())]) });
  await expect(page.getByTestId('slip-preview')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(th('co.place')) }).click();
  await page.locator('.sp-sheet').getByRole('button', { name: th('co.place') }).click();
}
/** the Orders tab, then one order's page */
async function openOrder(page: Page, orderNo: string, lang: 'th' | 'en' = 'th') {
  const T = lang === 'th' ? th : en;
  await tab(page, T('nav.orders')).click();
  await page.locator('.sp-order').filter({ hasText: orderNo }).click();
  await expect(detail(page)).toBeVisible();
}
/** the same, from a list that may already be showing an order */
async function backToList(page: Page) { await page.locator('.sp-order-detail .sp-back').click(); await expect(page.locator('.sp-orders')).toBeVisible(); }
const submitSlip = async (page: Page) => {
  await page.locator('.sp-order-detail input[type=file]').setInputFiles({ name: 'more.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#more' + Math.random())]) });
  await expect(page.getByTestId('slip-preview')).toBeVisible();
  await page.getByRole('button', { name: /Submit this slip|ส่งสลิปนี้/ }).click();
};

test.describe('placing an order with a slip', () => {
  test('the order says "pending payment verification – awaiting staff confirmation" (Thai, then English), never paid; ONE reader call for the order\'s invoice', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); await open(page, fake);
    await placeWithSlip(page);
    await expect(detail(page)).toBeVisible();
    await expect(detail(page)).toContainText(PENDING_TH);
    expect(await pills(page)).not.toContain('ชำระแล้ว');
    expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.paid).toBe(0);
    // the browser asked the reader (best effort) to look at the invoice's newest slip: exactly once for this order, naming the invoice and nothing else
    await expect.poll(() => fake.invokes.length).toBe(1);
    expect(fake.invokes[0]).toEqual({ name: 'slip-analyze', body: { invoice_id: fake.orders[0].invoice.id } });
    // switch to English: the same status in English
    await tab(page, th('nav.account')).click(); await page.getByRole('button', { name: 'English' }).click();
    await openOrder(page, fake.orders[0].order_no, 'en');
    await expect(detail(page)).toContainText(PENDING_EN);
    expect(await pills(page)).not.toContain('Paid');
    expect(fake.invokes).toHaveLength(1);                                                           // nothing called it a second time
  });

  test('an order placed WITHOUT a slip (the shop does not require one) does not call the reader', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.settings.require_payment_slip = false; await open(page, fake);
    await tab(page, th('nav.shop')).click();
    await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: th('p.add') }).click();
    await tab(page, th('nav.cart')).click(); await page.getByRole('button', { name: th('cart.checkout') }).click();
    await page.getByLabel(th('co.address')).fill('99 ถนนทดสอบ แขวงทดลอง เขตทดสอบ กรุงเทพ 10110');
    await page.getByRole('button', { name: new RegExp(th('co.place')) }).click();
    await page.locator('.sp-sheet').getByRole('button', { name: th('co.place') }).click();
    await expect(detail(page)).toBeVisible();
    expect(fake.orders[0].invoice.evidence).toHaveLength(0);
    await page.waitForTimeout(500);                                                                  // a call would have been made by now
    expect(fake.invokes).toEqual([]);
  });

  test('a reader that answers with an error does not stop the order page', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.invokeMode = 'fail'; await open(page, fake);
    await placeWithSlip(page);
    await expect(detail(page)).toContainText(PENDING_TH);                                            // the order is there, with its slip, as if nothing had gone wrong
    await expect.poll(() => fake.invokes.length).toBe(1);                                            // it was tried, once
    expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.evidence).toHaveLength(1);
    await expect(page.getByText(th('err.generic'))).toHaveCount(0);                                  // and no error was shown to the customer
  });

  test('a reader that never answers does not delay the order page, and the page stays usable', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.invokeMode = 'hang'; await open(page, fake);
    try {
      const started = Date.now();
      await placeWithSlip(page);
      await expect(detail(page)).toContainText(PENDING_TH, { timeout: 8_000 });                      // well inside the 60 s a stalled call could take
      expect(Date.now() - started).toBeLessThan(20_000);
      await expect.poll(() => fake.invokes.length).toBe(1);                                          // it is still waiting for an answer…
      await page.getByRole('button', { name: th('od.refresh') }).click();                            // …and the screen works meanwhile
      await expect(detail(page)).toContainText(PENDING_TH);
    } finally { fake.openGate(); }
  });
});

test.describe('part payments and a payment the shop has confirmed', () => {
  test('a part-paid order shows paid and remaining (Thai and English), in the list and on the order; no pending text when no slip waits', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(350); fake.setPaid(o.order_no, 200);
    await open(page, fake);
    await tab(page, th('nav.orders')).click();
    await expect(page.locator('.sp-order').filter({ hasText: o.order_no })).toContainText('ชำระแล้ว ฿200 · คงเหลือ ฿150');
    await openOrder(page, o.order_no);
    await expect(detail(page)).toContainText('ชำระแล้ว ฿200 · คงเหลือ ฿150');
    expect(await pills(page)).toContain(th('pay.partial'));
    await expect(detail(page)).not.toContainText(PENDING_TH);
    await tab(page, th('nav.account')).click(); await page.getByRole('button', { name: 'English' }).click();
    await openOrder(page, o.order_no, 'en');
    await expect(detail(page)).toContainText('Paid ฿200 · remaining ฿150');
  });

  test('a part-paid order with a slip waiting shows BOTH the paid / remaining line and the pending text, never "paid"', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(350); fake.setPaid(o.order_no, 200); fake.addEvidence(o.order_no, 'submitted', { claimed_amount: 150 });
    await open(page, fake);
    await openOrder(page, o.order_no);
    await expect(detail(page)).toContainText('ชำระแล้ว ฿200 · คงเหลือ ฿150');
    await expect(detail(page)).toContainText(PENDING_TH);
    expect(await pills(page)).not.toContain(th('pay.paid'));
    await tab(page, th('nav.account')).click(); await page.getByRole('button', { name: 'English' }).click();
    await openOrder(page, o.order_no, 'en');
    await expect(detail(page)).toContainText('Paid ฿200 · remaining ฿150'); await expect(detail(page)).toContainText(PENDING_EN);
  });

  test('a fully unpaid and a fully paid order show no paid / remaining line', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const a = fake.seedOrder(); const b = fake.seedOrder(); fake.verifyPayment(b.order_no);
    await open(page, fake);
    // (the invoice card's own "Remaining" row is always there: it is the new "Paid X · remaining Y" line that must be absent)
    for (const o of [a, b]) { await openOrder(page, o.order_no); await expect(detail(page)).not.toContainText('ชำระแล้ว ฿'); await expect(page.getByTestId('pay-remaining')).toHaveCount(0); await backToList(page); }
  });

  test('a slip the shop CONFIRMED (not posted yet) reads as pending with the confirmed amount: not rejected, not paid; the history does not call it rejected', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'submitted', { claimed_amount: 320 }); fake.confirmSlip(o.order_no, 320);
    await open(page, fake);
    await openOrder(page, o.order_no);
    await expect(detail(page)).toContainText(PENDING_TH);
    await expect(detail(page)).toContainText('ร้านยืนยันยอด ฿320 แล้ว กำลังบันทึก');
    const text = await detail(page).innerText();
    expect(text).not.toContain(th('pay.rejected')); expect(text).not.toContain('ปฏิเสธ'); expect(await pills(page)).not.toContain(th('pay.paid'));
    await page.getByRole('button', { name: /Details|รายละเอียด/ }).click();                          // the payment history of the card
    await expect(detail(page)).toContainText('ร้านยืนยันแล้ว กำลังบันทึก');
    expect(await detail(page).innerText()).not.toContain('ปฏิเสธ');
    await expect(page.getByRole('button', { name: th('od.cancel') })).toHaveCount(0);                // a confirmed slip blocks self-cancel too
    await tab(page, th('nav.account')).click(); await page.getByRole('button', { name: 'English' }).click();
    await openOrder(page, o.order_no, 'en');
    await expect(detail(page)).toContainText('The shop confirmed ฿320; it is being recorded');
  });

  test('a confirmed slip beside a part payment shows the paid / remaining line, the pending text and the confirmed note', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(350); fake.setPaid(o.order_no, 200); fake.addEvidence(o.order_no, 'confirmed', { claimed_amount: 150, confirmed_amount: 150 });
    await open(page, fake);
    await openOrder(page, o.order_no);
    for (const s of ['ชำระแล้ว ฿200 · คงเหลือ ฿150', PENDING_TH, 'ร้านยืนยันยอด ฿150 แล้ว กำลังบันทึก']) await expect(detail(page)).toContainText(s);
  });
});

test.describe('more evidence requested (state 10)', () => {
  const MESSAGE = 'กรุณาส่งสลิปที่เห็นเวลาโอนชัดเจน <b>อีกครั้ง</b>';
  test('the order says the shop asked for more evidence, shows the staff message as plain text, opens by itself and takes a new slip on the SAME invoice: no second order, one more reader call', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'submitted', { claimed_amount: 320 }); fake.requestMoreEvidence(o.order_no, MESSAGE);
    await open(page, fake);
    await openOrder(page, o.order_no);
    expect(await pills(page)).toContain(th('pay.moreEvidence')); expect(await pills(page)).toContain('ร้านขอหลักฐานการชำระเพิ่มเติม');
    expect(await pills(page)).not.toContain(th('pay.paid'));
    const banner = page.getByTestId('more-evidence-message');
    await expect(banner).toBeVisible(); await expect(banner).toContainText(MESSAGE);                  // the staff words, exactly, as text
    await expect(banner.locator('b')).toHaveCount(0);                                                 // a tag in the message is text, never markup
    await expect(page.getByRole('button', { name: /Upload payment slip|อัปโหลดสลิปการโอนเงิน/ })).toBeVisible();   // open by itself: the upload is there without a tap
    expect(await detail(page).innerText()).not.toContain(PENDING_TH);

    // the new slip goes to the same invoice
    await submitSlip(page);
    await expect(detail(page)).toContainText(PENDING_TH);                                             // waiting again
    await expect(page.getByTestId('more-evidence-message')).toHaveCount(0);
    expect(fake.orders).toHaveLength(1); expect(fake.count('shop_place_order')).toBe(0);              // no second order
    expect(fake.count('finance_submit_evidence')).toBe(1);
    expect(fake.calls.find((c) => c.fn === 'finance_submit_evidence')!.args.p_invoice).toBe(o.invoice.id);
    expect(fake.orders[0].invoice.evidence).toHaveLength(2);
    await expect.poll(() => fake.invokes.length).toBe(1);                                             // one more reader call, for that slip
    expect(fake.invokes[0]).toEqual({ name: 'slip-analyze', body: { evidence_id: fake.orders[0].invoice.evidence[0].id } });
    await page.waitForTimeout(400); expect(fake.invokes).toHaveLength(1);
  });

  test('English: the badge, the banner and the upload read in English', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'submitted'); fake.requestMoreEvidence(o.order_no, 'Please send a clearer slip');
    await open(page, fake, 'en');
    await openOrder(page, o.order_no, 'en');
    expect(await pills(page)).toContain('The shop asked for more payment evidence');
    await expect(page.getByTestId('more-evidence-message')).toContainText('Please send a clearer slip');
    await expect(page.getByRole('button', { name: 'Upload payment slip' })).toBeVisible();
  });

  test('cancel is hidden while more evidence is requested (and for a pending slip), and offered on an unpaid order', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const more = fake.seedOrder(); fake.addEvidence(more.order_no, 'submitted'); fake.requestMoreEvidence(more.order_no, 'ส่งสลิปใหม่');
    const pending = fake.seedOrder(); fake.addEvidence(pending.order_no, 'submitted');
    const unpaid = fake.seedOrder();
    await open(page, fake);
    const cancel = page.getByRole('button', { name: th('od.cancel') });
    await openOrder(page, more.order_no); await expect(page.getByTestId('more-evidence-message')).toBeVisible(); await expect(cancel).toHaveCount(0); await backToList(page);
    await openOrder(page, pending.order_no); await expect(detail(page)).toContainText(PENDING_TH); await expect(cancel).toHaveCount(0); await backToList(page);
    await openOrder(page, unpaid.order_no); await expect(cancel).toBeVisible();
  });

  test('an order that asks for more evidence is in the "To pay" chip, with the new status', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'submitted'); fake.requestMoreEvidence(o.order_no, 'ส่งสลิปใหม่');
    await open(page, fake);
    await tab(page, th('nav.orders')).click();
    await page.getByRole('tab', { name: th('ord.f.unpaid') }).click();
    const row = page.locator('.sp-order').filter({ hasText: o.order_no });
    await expect(row).toBeVisible(); await expect(row).toContainText(th('pay.moreEvidence'));
  });

  test('a rejected slip still shows the reason the staff wrote (state 7)', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'rejected', { reject_reason: 'ยอดเงินไม่ตรง', reviewed_at: new Date().toISOString() });
    await open(page, fake);
    await openOrder(page, o.order_no);
    expect(await pills(page)).toContain(th('pay.rejected'));
    await expect(detail(page)).toContainText('ยอดเงินไม่ตรง');
    await expect(page.getByTestId('more-evidence-message')).toHaveCount(0);
  });

  test('accessible: the more-evidence screen passes axe', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'submitted'); fake.requestMoreEvidence(o.order_no, 'กรุณาส่งสลิปใหม่');
    await open(page, fake); await openOrder(page, o.order_no);
    await expect(page.getByTestId('more-evidence-message')).toBeVisible();
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

test.describe('customers never see the AI or any staff-only data', () => {
  // Words that would reveal the analysis (or how to beat it). "AI" is matched as a word (the letters also occur inside ordinary words such as "Paid").
  const FORBIDDEN = /\bAI\b|confidence|ความมั่นใจ|match|suspicious|duplicate|analy[sz]|artificial|เอไอ|ปัญญาประดิษฐ์|\bscore\b|คะแนน|สงสัย|ซ้ำ/i;
  /** staff-only columns of a payment (never selected by the customer's browser) and the planted staff note that must stay off every screen */
  const STAFF_ONLY = ['review_note', 'confirm_note', 'reviewed_by', 'confirmed_by', 'recorded_by', 'requested_by', 'posted_by', 'verified_via', 'confirmed_amount', 'confirmed_bank_ref', 'confirmed_transfer_at', 'file_path', 'file_sha256'];
  const SECRET = 'AI match confidence 0.97 suspicious duplicate ความมั่นใจ BANKREF-SECRET';
  const CODES = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  const PILL: Record<number, K> = { 0: 'pay.unpaid', 1: 'pay.unpaid', 3: 'pay.pending', 4: 'pay.partial', 5: 'pay.paid', 6: 'pay.review', 7: 'pay.rejected', 8: 'pay.cancelled', 9: 'pay.unpaid', 10: 'pay.moreEvidence' };

  /** everything a customer can read or hear on the page: the visible text and the labels (aria-label, title, alt, placeholder) */
  const everything = (page: Page) => page.evaluate(() => {
    const labels = [...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].map((e) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => e.getAttribute(a) ?? '').join(' '));
    return `${document.body.innerText}\n${labels.join('\n')}`;
  });

  for (const lang of ['th', 'en'] as const) {
    test(`orders and payment screens for every state code (${lang === 'th' ? 'Thai' : 'English'}) carry no AI wording, no score and no staff-only text`, async ({ page }) => {
      test.setTimeout(150_000);
      const T = lang === 'th' ? th : en;
      const fake = new FakeShop(); fake.decorate();
      const staffNote = SECRET;
      const byCode = new Map<number, string>();
      for (const code of CODES) {
        const o = fake.seedOrder(); byCode.set(code, o.order_no);
        switch (code) {
          case 1: fake.giveQr(o.order_no, true); break;
          case 3: fake.addEvidence(o.order_no, 'submitted', { staffNote }); break;
          case 4: fake.addEvidence(o.order_no, 'verified', { staffNote }); fake.setPaid(o.order_no, 100); break;
          case 5: fake.addEvidence(o.order_no, 'verified', { staffNote }); fake.setPaid(o.order_no, o.total); break;
          case 6: fake.forceCode(o.order_no, 6); break;
          case 7: fake.addEvidence(o.order_no, 'rejected', { reject_reason: 'ยอดเงินไม่ตรง', staffNote, reviewed_at: new Date().toISOString() }); break;
          case 8: o.invoice.cancelled = true; fake.setStatus(o.order_no, 'cancelled'); break;
          case 9: fake.giveQr(o.order_no, false); break;
          case 10: fake.addEvidence(o.order_no, 'submitted', { staffNote }); fake.requestMoreEvidence(o.order_no, 'กรุณาส่งสลิปใหม่'); break;
        }
      }
      const confirmed = fake.seedOrder(); fake.addEvidence(confirmed.order_no, 'confirmed', { confirmed_amount: 320, staffNote });   // state 3 again, this time a confirmed slip
      await open(page, fake, lang);
      const seen: string[] = [];
      await tab(page, T('nav.orders')).click();
      await expect(page.locator('.sp-orders')).toBeVisible();
      seen.push(await everything(page));
      const nos = [...byCode.entries(), [3, confirmed.order_no] as [number, string]];
      for (const [code, no] of nos) {
        await page.locator('.sp-order').filter({ hasText: no }).click();
        await expect(detail(page)).toBeVisible();
        await expect(detail(page).locator('.sp-pill').last()).toContainText(T(PILL[code]));          // the screen is the state we think it is (so the check below is not vacuous)
        const more = detail(page).getByRole('button', { name: T('od.refresh') });
        await more.click();                                                                          // a refresh must not change what is shown
        seen.push(await everything(page));
        const pay = page.getByRole('button', { name: /Pay this invoice|ชำระเงิน$/ });                // open the payment panel of an invoice that was not opened by itself
        if (await pay.count()) { await pay.first().click(); seen.push(await everything(page)); }
        const hist = page.getByRole('button', { name: /^(Details|รายละเอียด)$/ });                   // and the payment history
        if (await hist.count()) { await hist.first().click(); await page.waitForTimeout(150); seen.push(await everything(page)); }
        await backToList(page);
      }
      const all = seen.join('\n=====\n');
      expect(all, all.match(FORBIDDEN)?.[0]).not.toMatch(FORBIDDEN);
      expect(all).not.toContain('BANKREF-SECRET'); expect(all).not.toContain('0.97');               // what staff wrote in the staff-only columns never reaches the customer
      expect(all).toContain(T('pay.moreEvidence'));                                                   // (the screens above really were read)

      // what the browser asked the database for: never the analysis, never a staff-only column, only the reader function by name
      const reads = fake.restReads.filter((r) => r.table.startsWith('finance_payment_evidence'));
      expect(reads.length).toBeGreaterThan(0);
      for (const r of reads) { expect(r.select, 'an explicit column list, never *').not.toBeNull(); expect(r.select).not.toBe('*'); for (const c of STAFF_ONLY) expect(r.select!.split(','), c).not.toContain(c); }
      expect(fake.restReads.filter((r) => /finance_slip_analysis/.test(r.table))).toEqual([]);
      expect(fake.calls.filter((c) => /review|analys/i.test(c.fn)).map((c) => c.fn)).toEqual([]);
      expect(fake.invokes.every((i) => i.name === 'slip-analyze')).toBe(true);
    });
  }
});

test.describe('older databases, odd answers and the shape of the page', () => {
  /** the 14 columns an old payment events table has (the 17 a customer reads minus request_message, source, method) */
  const BASE_COLUMNS = ['id', 'invoice_id', 'status', 'created_at', 'claimed_amount', 'claimed_transfer_at', 'claimed_bank', 'claimed_ref', 'file_type', 'reject_reason', 'verified_amount', 'transfer_at', 'bank_trans_ref', 'reviewed_at'];

  test('a database WITHOUT the slip-review columns: the browser asks again with the base columns, so the rejection reason and the receipts still show (never *)', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.noReviewColumns = true;
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'rejected', { reject_reason: 'ยอดเงินไม่ตรง', reviewed_at: new Date().toISOString() }); fake.addReceipt(o.order_no, 'RC-000042', 100);
    await open(page, fake); await openOrder(page, o.order_no);
    expect(await pills(page)).toContain(th('pay.rejected'));
    await expect(detail(page)).toContainText('ยอดเงินไม่ตรง');                                      // the reason the staff wrote (state 7)
    await expect(detail(page)).toContainText('RC-000042');                                          // the receipts of the history
    const reads = fake.restReads.filter((r) => r.table.startsWith('finance_payment_evidence'));
    expect(reads.some((r) => r.select!.split(',').map((c) => c.trim()).includes('request_message'))).toBe(true);        // first the full list (it failed: the old table has no such column)
    expect(reads.some((r) => [...r.select!.split(',').map((c) => c.trim())].sort().join() === [...BASE_COLUMNS].sort().join())).toBe(true);   // then the base list
    for (const r of reads) expect(r.select).not.toBe('*');
  });

  test('when the slips cannot be read at all, the receipts of the history still show (each part is read on its own)', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.failEvidenceReads = true;
    const o = fake.seedOrder(350); fake.setPaid(o.order_no, 200); fake.addReceipt(o.order_no, 'RC-000007', 200);
    await open(page, fake); await openOrder(page, o.order_no);
    await page.getByRole('button', { name: /^(Details|รายละเอียด)$/ }).click();
    await expect(detail(page)).toContainText('RC-000007');
    await expect(detail(page)).toContainText('ชำระแล้ว ฿200 · คงเหลือ ฿150');                         // the rest of the screen is as usual
  });

  test('an order answer without an invoice object never throws after the order exists: the page opens, no error is shown, the reader is simply not asked', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate(); fake.placeWithoutInvoice = true; await open(page, fake);
    await placeWithSlip(page);
    await expect(detail(page)).toContainText(PENDING_TH);                                            // the order page loaded the invoice itself
    expect(fake.orders).toHaveLength(1);
    await expect(page.getByText(th('err.generic'))).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(fake.invokes).toEqual([]);
  });

  test('only the payment status pill wraps; the order pill keeps one line', async ({ page }) => {
    const fake = new FakeShop(); fake.decorate();
    const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'submitted');
    await open(page, fake); await openOrder(page, o.order_no);
    const ws = (sel: string) => detail(page).locator(sel).first().evaluate((e) => getComputedStyle(e).whiteSpace);
    expect(await ws('.sp-pill.sp-pay')).toBe('normal');
    expect(await ws('.sp-pill:not(.sp-pay)')).toBe('nowrap');
  });

  test('the fake refuses a self-cancel while a slip waits, is confirmed or more evidence is requested (like shop_cancel_order_internal)', () => {
    const fake = new FakeShop();
    const more = fake.seedOrder(); fake.addEvidence(more.order_no, 'submitted'); fake.requestMoreEvidence(more.order_no, 'x');
    const confirmed = fake.seedOrder(); fake.addEvidence(confirmed.order_no, 'confirmed', { confirmed_amount: 320 });
    const waiting = fake.seedOrder(); fake.addEvidence(waiting.order_no, 'submitted');
    for (const o of [more, confirmed, waiting]) expect(() => fake.rpc('shop_cancel_my_order', { p_id: o.id }), o.order_no).toThrow('SLIP_PENDING');
    const plain = fake.seedOrder(); fake.rpc('shop_cancel_my_order', { p_id: plain.id }); expect(plain.status).toBe('cancelled');
  });
});
