// The payment card (one QR, a real file to save, who is paid) and what the customer is told while their slip is checked. Against the fake backend: this proves the SCREENS; the rules are
// proved in the database by supabase/tests/slip_check_customer.sql. A saved picture is checked the way a banking app would: its pixels are decoded.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG as Png } from 'pngjs';
import { readFileSync } from 'node:fs';
import { promptPayPayload } from '../../src/lib/promptpay';
import { tr, type K } from '../../src/shop/i18n';
import { FakeShop } from './fakeBackend';
import { pickMethod } from './methods';

const t = (k: K, v?: Record<string, string | number>) => tr('th', k, v);
const SHOTS = process.env.SHOP_SHOTS ?? 'test-results/shop';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const LINE_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.8.0';
const tab = (page: Page, label: string) => page.locator('.phone-nav').getByRole('button', { name: label });
const QR370 = promptPayPayload('0812345678', 370);
const decode = (b: Buffer) => { const p = Png.sync.read(b); return jsQR(new Uint8ClampedArray(p.data), p.width, p.height)?.data; };
const bytes = async (d: Download) => readFileSync((await d.path())!);
const qrImages = (page: Page) => page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => /QR/.test(i.alt) && i.getBoundingClientRect().width > 0).length);
function watch(page: Page) { const errs: string[] = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push(m.text()); }); return errs; }
async function start(page: Page, fake: FakeShop) { fake.decorate(); await fake.install(page); await page.goto('/#/app'); await expect(page.locator('.phone-nav')).toBeVisible(); }
async function toQr(page: Page, fake: FakeShop) {
  await start(page, fake);
  await tab(page, t('nav.shop')).click(); await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.add') }).click();
  await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click();
  await pickMethod(page, 'qr'); await expect(page.getByTestId('pay-qr')).toBeVisible();
}
/** the page thinks it runs inside LINE on an iPhone; `share` decides what the share sheet does (undefined = this browser cannot share files) */
async function asLine(page: Page, share?: 'ok' | 'refused' | 'closed') {
  await page.addInitScript(([ua, mode]) => {
    Object.defineProperty(navigator, 'userAgent', { get: () => ua }); Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    const w = window as unknown as { __shared: { name: string; type: string; size: number; b64: string }[] }; w.__shared = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: mode ? () => true : undefined });
    Object.defineProperty(navigator, 'share', { configurable: true, value: mode ? async (d: { files: File[] }) => {
      const f = d.files[0]; const buf = new Uint8Array(await f.arrayBuffer()); let s = ''; buf.forEach((x) => { s += String.fromCharCode(x); });
      w.__shared.push({ name: f.name, type: f.type, size: f.size, b64: btoa(s) });
      if (mode === 'refused') throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); if (mode === 'closed') throw Object.assign(new Error('x'), { name: 'AbortError' });
    } : undefined });
  }, [LINE_IOS, share ?? ''] as const);
}
const saveBtn = (page: Page) => page.getByTestId('qr-panel').getByRole('button', { name: t('qr.save') });

test.describe('the payment card', () => {
  test('exactly one QR, the amount, the recipient, the account, the status and how to pay', async ({ page }) => {
    const errs = watch(page); const fake = new FakeShop(); fake.merchantName = 'ร้านทดสอบ จำกัด'; await toQr(page, fake);
    const card = page.getByTestId('qr-panel');
    await expect(card).toHaveCount(1); expect(await qrImages(page)).toBe(1); await expect(page.locator('.qr-box')).toHaveCount(1);
    await expect(card.getByTestId('qr-amount')).toHaveText('฿370'); await expect(card.getByTestId('qr-recipient')).toHaveText('ร้านทดสอบ จำกัด');
    await expect(card).toContainText('Test shop · ••• 5678'); await expect(card).toContainText(t('qr.waiting'));
    for (const k of ['qr.step1', 'qr.step2', 'qr.step3'] as const) await expect(card).toContainText(t(k));
    await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: `${SHOTS}/premium-card.png` });
    expect(errs).toEqual([]);
  });
  test('no recipient name written yet: the account label and the last digits, never "pay to <bank>" as if it were a person', async ({ page }) => {
    const fake = new FakeShop(); fake.merchantName = null; await toQr(page, fake);
    await expect(page.getByTestId('qr-recipient')).toHaveText('Test shop'); await expect(page.getByTestId('qr-panel')).toContainText('••• 5678');
  });
  test('the QR on the card scans at phone size, and is sharp', async ({ page }) => {
    const fake = new FakeShop(); await toQr(page, fake);
    const q = page.getByTestId('pay-qr'); await q.scrollIntoViewIfNeeded();
    expect(await q.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(1000);
    expect(decode(await q.screenshot({ scale: 'css' }))).toBe(QR370);
  });
  test('a QR whose text does not say the amount on the card is never shown', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake);
    await page.route('**/rest/v1/rpc/shop_checkout_qr', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ amount: 370, qr_payload: promptPayPayload('0899999999', 999), account_label: 'x', merchant_name: 'x' }) }));
    await tab(page, t('nav.shop')).click(); await page.locator('.sp-card[data-sku="FG-000001"]').getByRole('button', { name: t('p.add') }).click();
    await tab(page, t('nav.cart')).click(); await page.getByRole('button', { name: t('cart.checkout') }).click(); await pickMethod(page, 'qr');
    await expect(page.getByTestId('qr-error')).toBeVisible(); expect(await qrImages(page)).toBe(0);
  });
  for (const vp of [{ n: 'small phone', w: 320, h: 640 }, { n: 'tablet', w: 820, h: 1180 }, { n: 'desktop', w: 1440, h: 900 }]) {
    test(`${vp.n}: fits, scans, axe finds nothing serious (light and dark)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h }); const fake = new FakeShop(); fake.merchantName = 'บริษัท ชื่อยาวมากสำหรับทดสอบการตัดบรรทัด จำกัด (มหาชน)'; await toQr(page, fake);
      for (const theme of ['light', 'dark']) {
        await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        const q = page.getByTestId('pay-qr'); await q.scrollIntoViewIfNeeded(); expect(decode(await q.screenshot({ scale: 'css' }))).toBe(QR370);
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((nn) => nn.target.join(' ')).join(' | ')}`);
        expect(bad, bad.join('\n')).toEqual([]);
      }
    });
  }
});

test.describe('saving the QR', () => {
  test('desktop: a real PNG under its own name that opens and scans; still one QR on the screen', async ({ page }) => {
    const fake = new FakeShop(); await toQr(page, fake);
    const [d] = await Promise.all([page.waitForEvent('download'), saveBtn(page).click()]);
    expect(d.suggestedFilename()).toBe('payment-qr-checkout-370.png');
    await expect(page.getByText(t('qr.downloaded'))).toBeVisible();
    const b = await bytes(d); const p = Png.sync.read(b); expect([p.width, p.height]).toEqual([1080, 1600]); expect(decode(b)).toBe(QR370); expect(b.length).toBeLessThan(500_000);
    const px = (x: number, y: number) => [...p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3)];
    for (const [x, y] of [[30, 60], [1050, 800], [60, 1500]]) expect(Math.max(...px(x, y)), `the card is dark at ${x},${y}`).toBeLessThan(110);
    let white = 0; for (let x = 200; x < 880; x++) for (let y = 1160; y < 1270; y++) if (px(x, y).every((v) => v > 240)) white++; expect(white, 'the amount is written in white on it').toBeGreaterThan(1500);
    expect(await qrImages(page)).toBe(1);
    const fs = await import('node:fs'); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(`${SHOTS}/premium-saved.png`, b);
  });
  test('on the order page the file carries the order number', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); const o = fake.seedOrder();
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click(); await pickMethod(page, 'qr'); await expect(page.getByTestId('pay-qr')).toBeVisible();
    const [d] = await Promise.all([page.waitForEvent('download'), saveBtn(page).click()]);
    expect(d.suggestedFilename()).toBe(`payment-qr-${o.order_no}.png`); expect(decode(await bytes(d))).toBe(promptPayPayload('0812345678', 320));
  });
  test('LINE on an iPhone: the share sheet gets a real PNG file that scans', async ({ page }) => {
    await asLine(page, 'ok'); const fake = new FakeShop(); await toQr(page, fake); await saveBtn(page).click();
    await expect(page.getByText(t('qr.shared'))).toBeVisible();
    const s = (await page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; b64: string }[] }).__shared))[0];
    expect(s.name).toBe('payment-qr-checkout-370.png'); expect(s.type).toBe('image/png'); expect(decode(Buffer.from(s.b64, 'base64'))).toBe(QR370);
    expect(await qrImages(page)).toBe(1); await expect(page.getByTestId('qr-sheet')).toHaveCount(0);
  });
  test('closing the share sheet changes nothing', async ({ page }) => {
    await asLine(page, 'closed'); const fake = new FakeShop(); await toQr(page, fake); await saveBtn(page).click(); await page.waitForTimeout(300);
    await expect(page.getByTestId('qr-sheet')).toHaveCount(0); await expect(page.getByTestId('pay-qr')).toBeVisible();
  });
  for (const mode of ['refused', undefined] as const) {
    test(`LINE that cannot share (${mode ?? 'no sharing at all'}): the picture full screen to press and hold, the only QR on the screen, and a real link for the phone's own browser`, async ({ page }) => {
      await asLine(page, mode); const fake = new FakeShop(); await toQr(page, fake); await saveBtn(page).click();
      const sheet = page.getByTestId('qr-sheet'); await expect(sheet).toBeVisible(); await expect(sheet).toContainText(t('qr.hold'));
      const img = sheet.getByTestId('qr-saved'); await expect(img).toBeVisible(); expect(await qrImages(page)).toBe(1);
      const src = (await img.getAttribute('src'))!; expect(src.startsWith('data:image/png;base64,')).toBe(true); expect(decode(Buffer.from(src.split(',')[1], 'base64'))).toBe(QR370);
      await expect(sheet.getByRole('button', { name: t('qr.outside') })).toBeEnabled();
      const up = fake.uploads.find((u) => u.path.startsWith('payment-qr/'))!; expect(up.path).toBe('payment-qr/11111111-1111-4111-8111-111111111111/payment-qr.png'); expect(up.upsert).toBe('true'); expect(up.size).toBeGreaterThan(10_000); expect(up.size).toBeLessThan(600_000);
      await page.screenshot({ path: `${SHOTS}/premium-line-sheet.png` });
      await sheet.getByRole('button', { name: t('common.close'), exact: true }).click(); await expect(sheet).toHaveCount(0); await expect(page.getByTestId('pay-qr')).toBeVisible(); expect(await qrImages(page)).toBe(1);
    });
  }
  test('when the link cannot be made, press and hold still works', async ({ page }) => {
    await asLine(page); const fake = new FakeShop(); await page.route('**/storage/v1/object/payment-qr/**', (r) => r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{"message":"no bucket"}' }));
    await toQr(page, fake); await saveBtn(page).click();
    await expect(page.getByTestId('qr-saved')).toBeVisible(); await expect(page.getByRole('button', { name: t('qr.outside') })).toHaveCount(0); await expect(page.getByRole('button', { name: t('qr.outsideWait') })).toHaveCount(0);
  });
  test('"Cannot save it?" opens the picture by hand on any device; Escape closes it', async ({ page }) => {
    const fake = new FakeShop(); await toQr(page, fake); await page.getByRole('button', { name: t('qr.cannotSave') }).click();
    await expect(page.getByTestId('qr-saved')).toBeVisible(); expect(await qrImages(page)).toBe(1);
    await page.keyboard.press('Escape'); await expect(page.getByTestId('qr-sheet')).toHaveCount(0); expect(await qrImages(page)).toBe(1);
  });
});

test.describe('Thai labels', () => {
  test('the two buttons of the checkout read as asked', async ({ page }) => {
    const fake = new FakeShop(); await toQr(page, fake);
    await expect(page.getByRole('button', { name: 'แนบรูปภาพสลีปการโอนเงิน' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^ยืนยันคำสั่งซื้อสินค้า · ฿370$/ })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('เลือกรูปสลีป'); await expect(page.locator('body')).not.toContainText('ยืนยันสั่งซื้อ');
  });
  test('and on the order page', async ({ page }) => {
    const fake = new FakeShop(); await start(page, fake); fake.seedOrder(); await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click();
    await expect(page.getByRole('button', { name: 'แนบรูปภาพสลีปการโอนเงิน' })).toBeVisible();
  });
});

test.describe('what the customer is told while the slip is checked', () => {
  async function openPending(page: Page, fake: FakeShop) {
    await start(page, fake); const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'submitted');
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click(); await expect(page.locator('.sp-order-detail')).toBeVisible(); return o;
  }
  const box = (page: Page) => page.getByTestId('slip-check');
  test('checking, then "a person checks it": it looks again by itself and stops', async ({ page }) => {
    const fake = new FakeShop(); fake.slipCheck = [{ state: 'processing' }, { state: 'processing' }, { state: 'review' }]; await openPending(page, fake);
    await expect(box(page)).toContainText('กำลังตรวจสอบข้อมูลการชำระเงิน'); await expect(box(page)).toContainText('ระบบกำลังตรวจสอบยอดเงินและวันที่ทำรายการ');
    await expect(box(page)).toContainText(t('sc.review'), { timeout: 20_000 }); await expect(box(page)).not.toContainText(t('sc.resend'));
    const n = fake.count('finance_my_slip_check'); await page.waitForTimeout(5000); expect(fake.count('finance_my_slip_check')).toBe(n);
  });
  for (const c of [
    { n: 'another amount', a: { state: 'attention', code: 'AMOUNT', slip_amount: 300, expected_amount: 320 }, text: 'ยอดบนสลีป ฿300 ไม่ตรงกับยอดที่ต้องชำระ ฿320' },
    { n: 'an earlier day', a: { state: 'attention', code: 'DATE_PAST', slip_date: '2026-11-20', expected_date: '2026-11-23' }, text: 'เป็นวันก่อนหน้าคำสั่งซื้อนี้' },
    { n: 'a future day', a: { state: 'attention', code: 'DATE_FUTURE', slip_date: '2026-12-25', expected_date: '2026-11-23' }, text: 'เป็นวันในอนาคต' },
    { n: 'a used slip', a: { state: 'attention', code: 'DUPLICATE' }, text: 'เคยใช้กับการชำระเงินรายการอื่นแล้ว' },
    { n: 'not a slip', a: { state: 'attention', code: 'NOT_A_SLIP' }, text: 'ไม่ใช่สลีปการโอนเงิน' },
    { n: 'unreadable', a: { state: 'attention', code: 'UNREADABLE' }, text: 'อ่านยอดเงินหรือวันที่บนสลีปไม่ชัดเจน' },
    { n: 'a code this build does not know', a: { state: 'attention', code: 'NEW_THING' }, text: 'ข้อมูลบนสลีปไม่ตรงกับคำสั่งซื้อ' },
  ]) {
    test(`${c.n}: said plainly, another slip can be attached for the SAME order, nothing is marked paid`, async ({ page }) => {
      const fake = new FakeShop(); fake.slipCheck = [c.a]; await openPending(page, fake);
      await expect(page.getByTestId('slip-check-detail')).toContainText(c.text); expect((await page.locator('.sp-order-detail .sp-pill').allTextContents()).join('|')).not.toContain(t('pay.paid'));
      await box(page).getByRole('button', { name: t('sc.resend') }).click();
      await expect(page.getByRole('button', { name: 'แนบรูปภาพสลีปการโอนเงิน' })).toBeVisible();
      fake.slipCheck = [{ state: 'review' }];
      await page.locator('input[type=file]').setInputFiles({ name: 's.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('#2')]) }); await page.getByRole('button', { name: /ส่งสลิปนี้/ }).click();
      await expect(box(page)).toContainText(t('sc.review')); expect(fake.orders).toHaveLength(1); expect(fake.orders[0].invoice.evidence).toHaveLength(2);
    });
  }
  test('the reader is off, or the database is older: the page is exactly as before', async ({ page }) => {
    const fake = new FakeShop(); await openPending(page, fake); await page.waitForTimeout(400); await expect(box(page)).toHaveCount(0);
    const fake2 = new FakeShop(); fake2.noSlipCheck = true; const p2 = await page.context().newPage(); const errs = watch(p2); await openPending(p2, fake2); await p2.waitForTimeout(400); await expect(box(p2)).toHaveCount(0); expect(errs).toEqual([]);
  });
  test('only while a slip waits: an unpaid, a rejected and a paid order do not ask', async ({ page }) => {
    const fake = new FakeShop(); fake.slipCheck = [{ state: 'review' }]; await start(page, fake); const o = fake.seedOrder(); fake.addEvidence(o.order_no, 'rejected', { reject_reason: 'x' });
    await tab(page, t('nav.orders')).click(); await page.locator('.sp-order').first().click(); await expect(page.locator('.sp-order-detail')).toContainText('ไม่สามารถยืนยันการชำระเงินได้');
    fake.verifyPayment(o.order_no); await page.getByRole('button', { name: t('od.refresh') }).click(); await expect(page.locator('.sp-order-detail')).toContainText('ตรวจสอบการชำระเงินสำเร็จ');
    expect(fake.count('finance_my_slip_check')).toBe(0);
  });
  test('placing an order: "uploading" is shown, then the checking state on the order page', async ({ page }) => {
    const fake = new FakeShop(); fake.slipCheck = [{ state: 'processing' }]; await toQr(page, fake);
    let go: () => void = () => undefined; const gate = new Promise<void>((r) => { go = r; });
    await page.route('**/storage/v1/object/payment-evidence/**', async (r) => { if (r.request().method() === 'POST') await gate; await r.fallback(); });
    await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 's.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: new RegExp(t('co.place')) }).click(); await page.locator('.sp-sheet').getByRole('button', { name: t('co.place') }).click();
    await expect(page.locator('.sp-sheet')).toContainText('กำลังอัปโหลดสลิป'); go();
    await expect(page.locator('.sp-order-detail')).toBeVisible(); await expect(box(page)).toContainText(t('sc.processing')); expect(fake.orders).toHaveLength(1);
    await page.screenshot({ path: `${SHOTS}/premium-processing.png` });
  });
  test('a picture over 5 MB is refused at once', async ({ page }) => {
    const fake = new FakeShop(); await toQr(page, fake);
    await page.locator('[data-testid="slip-section"] input[type=file]').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) });
    await expect(page.getByText(t('err.slipBig'))).toBeVisible(); await expect(page.getByTestId('slip-preview')).toHaveCount(0); expect(fake.uploads).toHaveLength(0);
  });
});

test.describe('staff: the name of the account the QR pays', () => {
  const account = (over = {}) => ({ id: 'acc-1', label: 'KASIKORN BANK', kind: 'promptpay', target: '004999000000001', target_type: 'e_wallet', merchant_name: null, slip_name_alt: null, is_default: true, active: true, created_at: '2026-11-21T00:00:00Z', ...over });
  async function openAccount(page: Page, fake: FakeShop, role: 'manager' | 'verifier') {
    fake.profile.role = 'ADMIN'; fake.w.role = role; await page.addInitScript(() => { try { localStorage.setItem('tc.lang', 'th'); } catch { /* ignore */ } });
    await fake.install(page); await page.goto('/#/payment-review'); await page.getByRole('tab', { name: /Payment account|บัญชีรับชำระเงิน/ }).or(page.getByRole('button', { name: /Payment account|บัญชีรับชำระเงิน/ })).first().click();
  }
  test('a manager is warned that the name is missing, writes it (two spellings), and the warning goes away', async ({ page }) => {
    const fake = new FakeShop(); fake.paymentAccounts = [account()]; await openAccount(page, fake, 'manager');
    await expect(page.getByText(/This account has no recipient name|บัญชีนี้ยังไม่มีชื่อผู้รับเงิน/)).toBeVisible();
    const box = page.getByTestId('account-name'); await box.locator('input').nth(0).fill('นาย ทดสอบ รับเงิน'); await box.locator('input').nth(1).fill('Thotsob Rapngoen'); await box.getByRole('button').click();
    await expect(page.getByText(/This account has no recipient name|บัญชีนี้ยังไม่มีชื่อผู้รับเงิน/)).toHaveCount(0);
    expect(fake.calls.find((c) => c.fn === 'finance_set_payment_account_name')!.args).toEqual({ p_account: 'acc-1', p_name: 'นาย ทดสอบ รับเงิน', p_name_alt: 'Thotsob Rapngoen' });
  });
  test('a verifier sees the warning but cannot change the name', async ({ page }) => {
    const fake = new FakeShop(); fake.paymentAccounts = [account()]; await openAccount(page, fake, 'verifier');
    await expect(page.getByText(/This account has no recipient name|บัญชีนี้ยังไม่มีชื่อผู้รับเงิน/)).toBeVisible(); await expect(page.getByTestId('account-name')).toHaveCount(0);
  });
});
