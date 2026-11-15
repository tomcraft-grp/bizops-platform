// Screenshots + the English version in the Feedback & Issue module, in a real Chrome against a FAKE backend (fakeBackend.ts + fakeFeedback.ts) and a FAKE
// of Chrome's built-in Translator (the real language model cannot be downloaded in the test browser). The fake backend mirrors the contracts that the SQL
// suites prove for real; THIS file proves the screens and the browser behaviour (real Ctrl+V, drag and drop, thumbnails, previews, downloads, the clipboard
// text, translating on the computer) and that the screens cope with a missing, slow or failing translator. It does not prove the quality of real translations.
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FakeShop } from './fakeBackend';
import { FakeFeedback, PNG_1x1, installFakeTranslator, type FakeTranslatorOptions } from './fakeFeedback';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

async function boot(page: Page, o: { role?: string; lang?: 'en' | 'th'; path?: string; translator?: FakeTranslatorOptions } = {}) {
  const shop = new FakeShop();
  shop.profile.role = o.role ?? 'SUPER_ADMIN'; shop.profile.display_name = 'Staff';
  const fb = new FakeFeedback(shop);
  await shop.install(page); await fb.install(page);
  await installFakeTranslator(page, o.translator ?? { state: null });
  await page.addInitScript((l) => { try { localStorage.setItem('bizops.lang', l); } catch { /* ignore */ } }, o.lang ?? 'en');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/#${o.path ?? '/'}`);
  return { shop, fb, errors };
}
const tr = (page: Page) => page.evaluate(() => (window as unknown as { __tr: { state: string; creates: number; calls: string[]; downloads: number } }).__tr);
const grantClipboard = (page: Page) => page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:4179' });

async function openWidget(page: Page) {
  await page.locator('.feedback-fab').click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  return modal;
}
/** a picture on the REAL system clipboard, as Win+Shift+S leaves it */
async function copyPictureToClipboard(page: Page, label = 'screenshot', w = 320, h = 200) {
  await page.evaluate(async ({ label, w, h }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d')!; x.fillStyle = '#e8f0fe'; x.fillRect(0, 0, w, h); x.fillStyle = '#1a56db'; x.font = '22px sans-serif'; x.fillText(label, 12, 40);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, { label, w, h });
}
/** dispatches a paste event with the given pictures (and optionally text) on the focused element; returns true if NOTHING cancelled it */
async function pasteEvent(page: Page, pictures: { name: string; type?: string; w?: number; h?: number }[], text?: string) {
  return page.evaluate(async ({ pictures, text }) => {
    const dt = new DataTransfer();
    for (const p of pictures) {
      const c = document.createElement('canvas'); c.width = p.w ?? 200; c.height = p.h ?? 120;
      const x = c.getContext('2d')!; x.fillStyle = '#fde8e8'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#b42318'; x.fillText(p.name, 8, 20);
      const type = p.type ?? 'image/png';
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), type));
      dt.items.add(new File([blob], p.name, { type }));
    }
    if (text) dt.setData('text/plain', text);
    const target = document.activeElement ?? document.body;
    return target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { pictures, text });
}
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG_1x1 });
const thumbs = (page: Page) => page.locator('.modal [data-testid="attachment-thumb"]');

async function submitForm(page: Page, description: string, subject = '') {
  const modal = page.locator('.modal');
  if (subject) await modal.getByPlaceholder(/short summary|สรุปสั้น/).fill(subject);
  await modal.locator('textarea').fill(description);
  await modal.getByRole('button', { name: /^(Submit|ส่ง)/ }).click();
}

test.describe('submitting', () => {
  test('Thai: the form is fully Thai, the Thai text is saved exactly, and the English version follows without ever delaying the submit', async ({ page }) => {
    const { fb } = await boot(page, { lang: 'th', translator: { state: 'available', delayMs: 1200 } });   // a slow translator must not hold the form
    const modal = await openWidget(page);
    // the texts that were still English in the reported screenshot
    await expect(modal.getByText('มีปัญหา ไอเดีย หรือฟีเจอร์เพิ่มเติมอะไรที่คุณต้องการเห็นในหน้านี้?')).toBeVisible();
    await expect(modal.getByPlaceholder('อธิบายสิ่งที่พบหรือสิ่งที่อยากให้เปลี่ยน…')).toBeVisible();
    await expect(modal.getByText('วางภาพหน้าจอได้ทันทีด้วย Ctrl+V หรือลากรูปภาพมาวางที่นี่')).toBeVisible();
    await expect(modal.getByText(/What's the issue|Describe what you noticed|Paste your screenshot/)).toHaveCount(0);
    const text = 'ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied for table sku_registry"\nบรรทัดที่สอง   มีช่องว่างหลายตัว';
    await submitForm(page, text, 'ปุ่มบันทึกกดไม่ได้');
    await expect(modal).toBeHidden({ timeout: 1000 });                    // closed before the first of the 3 slow translate calls can finish
    expect(fb.issues).toHaveLength(1);
    expect(fb.issues[0].description).toBe(text);                          // byte for byte
    expect(fb.issues[0].title).toBe('ปุ่มบันทึกกดไม่ได้');
    await expect.poll(() => fb.issues[0].english_context_source, { timeout: 10000 }).toBe('translation');
    expect(fb.issues[0].english_context).toBe('Title: The Save button cannot be pressed\n\nOn the Products page, pressing Save SKU FG-000001 then shows an error "permission denied for table sku_registry"\nSecond line with several spaces');
    expect(fb.issues[0].description).toBe(text);                          // still untouched after the translation
    expect(fb.rpcCalls.find((c) => c.fn === 'feedback_set_english_context')!.args).toMatchObject({ p_issue: fb.issues[0].id, p_source: 'translation' });
  });

  test('English: nothing needs translating, the English version is the same text, and the translator is not even asked', async ({ page }) => {
    const { fb } = await boot(page, { translator: { state: 'available' } });
    await openWidget(page);
    const text = 'The Save button on Products does nothing after I edit SKU FG-000002.';
    await submitForm(page, text);
    await expect.poll(() => fb.issues[0]?.english_context_source).toBe('translation');
    expect(fb.issues[0].description).toBe(text);
    expect(fb.issues[0].english_context).toBe(`Title: ${fb.issues[0].title}\n\n${text}`);
    expect((await tr(page)).calls).toEqual([]);
  });

  test('the Thai language pack is not installed yet: the submit works, nothing is translated by itself (it needs a click in the issue screen)', async ({ page }) => {
    const { fb } = await boot(page, { translator: { state: 'downloadable' } });
    await openWidget(page);
    await submitForm(page, 'ปุ่มบันทึกกดไม่ได้');
    await expect(page.locator('.modal')).toBeHidden();
    await expect(page.getByText(/your feedback was recorded/i).first()).toBeVisible();
    await page.waitForTimeout(800);
    expect(fb.issues).toHaveLength(1);
    expect(fb.issues[0].english_context ?? null).toBeNull();
    expect(fb.count('feedback_set_english_context')).toBe(0);
    expect((await tr(page)).creates).toBe(0);                              // no download was started behind the person's back
  });

  for (const [name, translator] of [['this browser has no translator', { state: null }], ['the translator is unavailable', { state: 'unavailable' }], ['the translator crashes', { state: 'available', failTimes: 5 }]] as const) {
    test(`${name}: the submission is never blocked and nothing wrong is saved`, async ({ page }) => {
      const { fb, errors } = await boot(page, { translator });
      await openWidget(page);
      await submitForm(page, 'ปุ่มบันทึกกดไม่ได้');
      await expect(page.locator('.modal')).toBeHidden();
      await expect(page.getByText(/your feedback was recorded/i).first()).toBeVisible();
      await page.waitForTimeout(600);
      expect(fb.issues).toHaveLength(1);
      expect(fb.issues[0].description).toBe('ปุ่มบันทึกกดไม่ได้');
      expect(fb.issues[0].english_context ?? null).toBeNull();
      expect(errors).toEqual([]);
    });
  }
});

test.describe('screenshots: Ctrl+V, drag and drop, browse', () => {
  test('a real Ctrl+V of a screenshot attaches it with a thumbnail and an "attached" indicator, and it is uploaded on submit', async ({ page }) => {
    const { fb } = await boot(page);
    await grantClipboard(page);
    const modal = await openWidget(page);
    await expect(thumbs(page)).toHaveCount(0);
    await modal.locator('textarea').click();
    await copyPictureToClipboard(page, 'Win+Shift+S');
    await page.keyboard.press('Control+V');
    await expect(thumbs(page)).toHaveCount(1);
    await expect(modal.getByTestId('attachment-status')).toHaveText(/1 attached/);
    const name = await thumbs(page).locator('img').getAttribute('alt');
    expect(name).toMatch(/^screenshot-\d{8}-\d{6}-1\.png$/);
    expect(await modal.locator('textarea').inputValue()).toBe('');        // the picture did not leak into the text field
    expect(await thumbs(page).locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
    await submitForm(page, 'Pasted with Ctrl+V');
    await expect(modal).toBeHidden();
    expect(fb.uploads).toHaveLength(1);
    expect(fb.uploads[0]).toMatchObject({ type: 'image/png' });
    expect(fb.attachments).toHaveLength(1);
    expect(fb.attachments[0].file_name).toBe(name);
    expect(fb.attachments[0].issue_id).toBe(fb.issues[0].id);
    expect(fb.uploads[0].path.startsWith(`${fb.issues[0].id}/`)).toBe(true);   // inside the issue's own folder
  });

  test('several screenshots: browse + drag and drop + paste, up to 5, with a clear message beyond that', async ({ page }) => {
    await boot(page);
    const modal = await openWidget(page);
    await modal.getByTestId('attachment-input').setInputFiles([png('a.png'), png('b.png'), png('c.png')]);
    await expect(thumbs(page)).toHaveCount(3);
    // drag and drop
    await page.evaluate(async () => {
      const dt = new DataTransfer();
      const f = (n: string) => new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], n, { type: 'image/png' });
      dt.items.add(f('d.png')); dt.items.add(f('e.png'));
      document.querySelector('[data-testid="attachment-dropzone"]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(thumbs(page)).toHaveCount(5);
    await expect(modal.getByTestId('attachment-status')).toHaveText(/5 attached/);
    await modal.locator('textarea').click();
    await pasteEvent(page, [{ name: 'image.png' }]);                      // a 6th one
    await expect(modal.getByRole('alert')).toContainText('You can attach up to 5 files');
    await expect(thumbs(page)).toHaveCount(5);
  });

  test('wrong or oversized files are refused up front with a message; good ones still go in', async ({ page }) => {
    await boot(page);
    const modal = await openWidget(page);
    await modal.getByTestId('attachment-input').setInputFiles([{ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') }]);
    await expect(modal.getByRole('alert')).toContainText('a.gif: Only PNG, JPG, WebP images or PDF files can be attached');
    await modal.getByTestId('attachment-input').setInputFiles([{ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024) }]);   // cannot be shrunk: not a real picture
    await expect(modal.getByRole('alert')).toContainText('huge.png: Each file must be 10 MB or smaller');
    await modal.getByTestId('attachment-input').setInputFiles([{ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }]);
    await expect(modal.getByRole('alert')).toContainText('The file is empty');
    await expect(thumbs(page)).toHaveCount(0);
    await modal.getByTestId('attachment-input').setInputFiles([png('ok.png')]);
    await expect(thumbs(page)).toHaveCount(1);
    await expect(modal.getByRole('alert')).toHaveCount(0);                 // a new good file clears the old message
  });

  test('removing a picture before submitting: only the others are uploaded; "Remove all" empties the list', async ({ page }) => {
    const { fb } = await boot(page);
    const modal = await openWidget(page);
    await modal.getByTestId('attachment-input').setInputFiles([png('a.png'), png('b.png'), png('c.png')]);
    await expect(thumbs(page)).toHaveCount(3);
    await thumbs(page).nth(1).getByTestId('attachment-remove').click();
    await expect(thumbs(page)).toHaveCount(2);
    await expect(modal.getByTestId('attachment-status')).toHaveText(/2 attached/);
    await expect(modal.getByText('b.png')).toHaveCount(0);
    await submitForm(page, 'Two of three');
    await expect(modal).toBeHidden();
    expect(fb.attachments.map((a) => a.file_name).sort()).toEqual(['a.png', 'c.png']);
    expect(fb.uploads).toHaveLength(2);
    // remove all
    await openWidget(page);
    await page.locator('.modal').getByTestId('attachment-input').setInputFiles([png('x.png'), png('y.png')]);
    await page.locator('.modal').getByRole('button', { name: 'Remove all' }).click();
    await expect(thumbs(page)).toHaveCount(0);
    await expect(page.locator('.modal').getByTestId('attachment-status')).toHaveCount(0);
  });

  test('a very large screenshot is shrunk before upload (longest side 2560 px) and accepted even though the original is over 10 MB', async ({ page }) => {
    test.setTimeout(120_000);
    const { fb } = await boot(page);
    const modal = await openWidget(page);
    await modal.locator('textarea').click();
    // a 4000 x 3000 PNG full of noise: far over 10 MB as a file
    const original = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
      const x = c.getContext('2d')!; const img = x.createImageData(4000, 3000);
      for (let o = 0; o < img.data.length; o += 65536) crypto.getRandomValues(img.data.subarray(o, Math.min(o + 65536, img.data.length)));
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      x.putImageData(img, 0, 0);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return blob.size;
    });
    expect(original).toBeGreaterThan(10 * 1024 * 1024);
    await expect(thumbs(page)).toHaveCount(1, { timeout: 60_000 });
    const dims = await thumbs(page).locator('img').evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
    expect(dims).toEqual([2560, 1920]);                                    // same proportions, longest side 2560
    await submitForm(page, 'Big screenshot');
    await expect(modal).toBeHidden({ timeout: 20_000 });
    expect(fb.uploads).toHaveLength(1);
    expect(fb.uploads[0].size).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(fb.uploads[0].size).toBeLessThan(original);
    expect(['image/png', 'image/webp', 'image/jpeg']).toContain(fb.uploads[0].type);
  });

  test('Ctrl+V with text on the clipboard (copied from Word/Excel) is left for the text field; a picture alone is taken', async ({ page }) => {
    await boot(page);
    const modal = await openWidget(page);
    await modal.locator('textarea').click();
    const notCancelled = await pasteEvent(page, [{ name: 'image.png' }], 'some copied cells');
    expect(notCancelled).toBe(true);                                       // not cancelled: the browser still pastes the text
    await expect(thumbs(page)).toHaveCount(0);
    const cancelled = !(await pasteEvent(page, [{ name: 'image.png' }]));
    expect(cancelled).toBe(true);
    await expect(thumbs(page)).toHaveCount(1);
  });

  test('clicking a thumbnail shows it full size; Esc closes only the preview, not the form or what was typed', async ({ page }) => {
    await boot(page);
    const modal = await openWidget(page);
    await modal.locator('textarea').fill('keep this text');
    await modal.getByTestId('attachment-input').setInputFiles([png('a.png')]);
    await thumbs(page).locator('img').click();
    const box = page.getByTestId('image-lightbox');
    await expect(box).toBeVisible();
    await expect(box.locator('img')).toHaveAttribute('alt', 'a.png');
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(modal.locator('textarea')).toHaveValue('keep this text');
    await page.keyboard.press('Escape');                                   // a second Esc closes the form as before
    await expect(modal).toBeHidden();
  });

  test('a failed upload is reported by name and the issue itself is still saved', async ({ page }) => {
    const { fb } = await boot(page);
    const modal = await openWidget(page);
    await modal.getByTestId('attachment-input').setInputFiles([png('a.png')]);
    await page.route('**/storage/v1/object/feedback-attachments/**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }));
    await submitForm(page, 'Upload will fail');
    await expect(page.getByText(/Some files could not be uploaded: a\.png/)).toBeVisible();
    expect(fb.issues).toHaveLength(1);
    expect(fb.attachments).toHaveLength(0);
  });
});

const ENGLISH = 'Title: Save button\n\nPressing Save does nothing for FG-000001';

test.describe('issue detail: original / English version / evidence', () => {
  async function seeded(page: Page, o: { translator?: FakeTranslatorOptions; legacy?: boolean; english?: boolean | 'manual' } = {}) {
    const ctx = await boot(page, { path: '/feedback', translator: o.translator });
    const { fb } = ctx;
    const issue = fb.seedLegacy({ title: 'ปุ่มบันทึกกดไม่ได้', description: 'ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"', source: 'customer', app_id: 'line-liff', submitter_label: 'Somchai' });
    if (!o.legacy) Object.assign(issue, { english_context: null, english_context_status: 'pending', english_context_error: null, english_context_at: null, english_context_source: null, english_context_model: null, english_context_attempts: 0, english_context_started_at: null });
    fb.seedAttachment(issue.id, 'screenshot-1.png'); fb.seedAttachment(issue.id, 'screenshot-2.png');
    if (o.english) fb.seedEnglish(issue.id, ENGLISH, o.english === 'manual' ? 'manual' : 'translation');
    await page.reload();
    await page.getByRole('row', { name: /ปุ่มบันทึกกดไม่ได้/ }).click();
    const drawer = page.locator('aside.drawer');
    await expect(drawer).toBeVisible();
    return { ...ctx, issue, drawer };
  }

  test('reopening an issue shows A) the original, B) the English version, C) the evidence, in that order', async ({ page }) => {
    const { drawer, fb, issue } = await seeded(page, { english: true });
    const titles = await drawer.locator('.card-h h2').allInnerTexts();
    const order = ['Original feedback', 'English version', 'Evidence & attachments'].map((t) => titles.findIndex((x) => x.includes(t)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);               // A before B before C
    // A: exactly as written + language, reporter, date
    await expect(drawer.getByTestId('original-description')).toHaveText('ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"');
    await expect(drawer.getByText('Original language')).toBeVisible();
    await expect(drawer.getByText('Somchai (Customer)').first()).toBeVisible();
    // B: the saved English text, marked as a translation made on a computer
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'completed');
    await expect(drawer.getByTestId('ctx-text')).toContainText('Translated on this computer');
    await expect(drawer.getByTestId('ctx-text')).toContainText('Pressing Save does nothing for FG-000001');
    // C: both screenshots with name, size, upload date, Preview and Download
    const items = drawer.getByTestId('attachment-item');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText('screenshot-1.png');
    await expect(items.first()).toContainText(/\d+ KB/);
    await expect(items.first()).toContainText(/Uploaded \d{2} \w{3} \d{4}, \d{2}:\d{2}/);
    // regression: the buttons of one file must never sit on top of the next file's buttons (they did, and the click hit the wrong one)
    const boxes = await items.locator('button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b, `buttons ${i} and ${j} overlap`).toBe(false);
    }
    await expect(items.first().getByRole('button', { name: /Preview/ }).last()).toBeVisible();
    await expect(items.first().getByRole('button', { name: /Download/ })).toBeVisible();
    expect(fb.issue(issue.id)!.description).toBe('ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"');
  });

  test('Preview opens the picture full size (Esc closes only it) and Download saves it under its own name', async ({ page }) => {
    const { drawer } = await seeded(page, { english: true });
    const first = drawer.getByTestId('attachment-item').first();
    await first.getByRole('button', { name: /Preview$/ }).click();
    const box = page.getByTestId('image-lightbox');
    await expect(box).toBeVisible();
    await expect(box.locator('img')).toHaveAttribute('src', /object\/sign\/feedback-attachments/);
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
    await expect(drawer).toBeVisible();                                    // the drawer stays open
    const [download] = await Promise.all([page.waitForEvent('download'), first.getByRole('button', { name: /Download/ }).click()]);
    expect(download.suggestedFilename()).toBe('screenshot-1.png');
  });

  test('an old issue (no English-version columns at all) opens normally; the Thai pack must be downloaded: one click shows the progress, translates and saves', async ({ page }) => {
    const { drawer, fb, issue, errors } = await seeded(page, { legacy: true, translator: { state: 'downloadable' } });
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'pending');
    await expect(drawer.getByTestId('ctx-pending')).toBeVisible();
    await expect(drawer.getByText('Nothing is sent to any server')).toBeVisible();
    await expect(drawer.getByTestId('ctx-copy')).toBeDisabled();           // nothing to copy yet
    await expect(drawer.getByTestId('ctx-copy-files')).toBeDisabled();
    await expect(drawer.getByTestId('original-description')).toContainText('SKU FG-000001');
    expect((await tr(page)).creates).toBe(0);                              // opening the issue downloaded nothing
    await drawer.getByTestId('ctx-translate').click();
    await expect(drawer.getByTestId('ctx-working')).toContainText('Downloading the Thai language pack to this computer');
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'completed');
    await expect(drawer.getByTestId('ctx-text')).toContainText('Title: The Save button cannot be pressed');
    await expect(drawer.getByTestId('ctx-text')).toContainText('On the Products page, pressing Save SKU FG-000001 then shows an error "permission denied"');
    expect(fb.issue(issue.id)!.english_context_source).toBe('translation');
    expect(fb.issue(issue.id)!.description).toBe('ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"');   // the original is untouched
    expect((await tr(page)).downloads).toBe(1);
    await expect(drawer.getByTestId('ctx-copy')).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('when the Thai pack is already installed, an untranslated issue is translated as soon as staff open it, once', async ({ page }) => {
    const { drawer, fb, issue } = await seeded(page, { translator: { state: 'available' } });
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'completed');
    await expect(drawer.getByTestId('ctx-text')).toContainText('Translated on this computer');
    expect(fb.issue(issue.id)!.english_context_source).toBe('translation');
    expect(fb.count('feedback_set_english_context')).toBe(1);
    await page.keyboard.press('Escape');                                   // close and open it again: nothing is translated twice
    await page.getByRole('row', { name: /ปุ่มบันทึกกดไม่ได้/ }).click();
    await expect(page.locator('aside.drawer').getByTestId('ctx-status')).toHaveAttribute('data-status', 'completed');
    await page.waitForTimeout(500);
    expect(fb.count('feedback_set_english_context')).toBe(1);
  });

  test('a failed translation shows the reason, does not retry in a loop, and clicking again works', async ({ page }) => {
    const { drawer, fb, issue } = await seeded(page, { translator: { state: 'available', failTimes: 1 } });
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'failed');
    await expect(drawer.getByTestId('ctx-error')).toContainText('the translator crashed');
    await page.waitForTimeout(1200);
    expect((await tr(page)).calls).toHaveLength(1);                        // one attempt only: no loop
    expect(fb.issue(issue.id)!.english_context ?? null).toBeNull();        // nothing half-saved
    await drawer.getByTestId('ctx-translate').click();
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'completed');
    expect(fb.issue(issue.id)!.english_context_source).toBe('translation');
  });

  test('a browser without the translator: a clear message, a Google Translate link, and the English text can be written by hand', async ({ page }) => {
    const { drawer, fb, issue } = await seeded(page, { translator: { state: null } });
    await expect(drawer.getByTestId('ctx-unsupported')).toContainText('cannot translate on the computer');
    await expect(drawer.getByTestId('ctx-translate')).toHaveCount(0);      // no button that cannot work
    const href = await drawer.getByTestId('ctx-google').getAttribute('href');
    expect(href).toMatch(/^https:\/\/translate\.google\.com\/\?sl=th&tl=en&op=translate&text=/);
    expect(decodeURIComponent(href!.split('text=')[1])).toContain('ปุ่มบันทึกกดไม่ได้');
    await expect(drawer.getByTestId('ctx-google')).toHaveAttribute('target', '_blank');
    await expect(drawer.getByTestId('ctx-google')).toHaveAttribute('rel', /noopener/);
    await drawer.getByTestId('ctx-edit').click();
    await expect(drawer.getByTestId('ctx-editor')).toHaveValue('');
    await drawer.getByTestId('ctx-editor').fill('Title: Save button does nothing\n\nWritten by staff');
    await drawer.getByTestId('ctx-save').click();
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'completed');
    await expect(drawer.getByTestId('ctx-text')).toContainText('Written by hand');
    expect(fb.issue(issue.id)!.english_context_source).toBe('manual');
    expect(fb.rpcCalls.find((c) => c.fn === 'feedback_set_english_context')!.args).not.toHaveProperty('p_source');   // a hand-written text sends no source
  });

  test('translating again over text staff typed asks first; Cancel keeps it, Translate again replaces it', async ({ page }) => {
    const { drawer, fb, issue } = await seeded(page, { english: 'manual', translator: { state: 'available' } });
    await expect(drawer.getByTestId('ctx-text')).toContainText('Written by hand');
    await expect(drawer.getByTestId('ctx-status')).toHaveAttribute('data-status', 'completed');   // an issue that has text is not auto-translated
    expect((await tr(page)).calls).toEqual([]);
    await drawer.getByTestId('ctx-translate').click();
    const dlg = page.locator('.modal');
    await expect(dlg).toContainText('Replace the text staff wrote?');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(fb.issue(issue.id)!.english_context_source).toBe('manual');
    expect((await tr(page)).calls).toEqual([]);
    await drawer.getByTestId('ctx-translate').click();
    await page.locator('.modal').getByRole('button', { name: 'Translate again' }).click();
    await expect.poll(() => fb.issue(issue.id)!.english_context_source).toBe('translation');
    expect(fb.issue(issue.id)!.english_context).toContain('Title: The Save button cannot be pressed');
  });

  test('Copy English Context and Copy Context + Attachments put the right text on the clipboard, and it pastes back unchanged', async ({ page }) => {
    const { drawer, fb, issue } = await seeded(page, { english: true });
    await grantClipboard(page);
    await drawer.getByTestId('ctx-copy').click();
    await expect(page.getByText('English text copied to the clipboard')).toBeVisible();
    const plain = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');   // the Windows clipboard stores line breaks as CR LF
    expect(plain).toBe(ENGLISH);

    fb.signed.length = 0;
    await drawer.getByTestId('ctx-copy-files').click();
    await expect(page.getByText(/Copied the English text and 2 attachment link\(s\)/)).toBeVisible();
    const withFiles = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    expect(withFiles.startsWith(plain)).toBe(true);                         // the English text first, unchanged
    expect(withFiles).toContain('## Attachments (2)');
    expect(withFiles).toMatch(/1\. screenshot-1\.png \(image\/png, \d+ KB, uploaded \d{4}-\d{2}-\d{2}\) - https:\/\/hlvravynjalculvplrxc\.supabase\.co\/storage\/v1\/object\/sign\/feedback-attachments\/FB-/);
    expect(withFiles).toMatch(/2\. screenshot-2\.png/);
    expect(withFiles).toMatch(/They are NOT embedded in this text/);      // honest: links, not embedded images
    expect(withFiles).toMatch(/stop working after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(fb.signed.filter((s) => s.expiresIn === 86400)).toHaveLength(2);   // 24 hours, for exactly the two files
    expect(issue.id).toMatch(/^FB-/);

    // paste it somewhere else (the internal-note box stands in for Claude Code)
    await drawer.getByRole('tab', { name: /^Internal notes/ }).click();
    const note = drawer.getByPlaceholder('Add an investigation note or internal remark…');
    await note.click();
    await page.keyboard.press('Control+V');
    expect((await note.inputValue()).replace(/\r\n/g, '\n')).toBe(withFiles);
  });

  test('when the browser blocks the clipboard the text is shown so it can be copied by hand', async ({ page }) => {
    const { drawer } = await seeded(page, { english: true });
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } }); document.execCommand = () => false; });
    await drawer.getByTestId('ctx-copy').click();
    await expect(page.getByText(/Could not copy automatically/)).toBeVisible();
    await expect(drawer.getByTestId('ctx-manual-copy')).toHaveValue(/Title: Save button/);
  });

  test('Thai staff see the English-version section in Thai', async ({ page }) => {
    const ctx = await boot(page, { path: '/feedback', lang: 'th', translator: { state: 'downloadable' } });
    const issue = ctx.fb.seedLegacy({ title: 'ปุ่มบันทึกกดไม่ได้' });
    ctx.fb.seedEnglish(issue.id, ENGLISH);
    await page.reload();
    await page.getByRole('row', { name: /ปุ่มบันทึกกดไม่ได้/ }).click();
    const drawer = page.locator('aside.drawer');
    for (const th of ['ข้อความต้นฉบับ', 'ฉบับภาษาอังกฤษ', 'หลักฐานและไฟล์แนบ', 'คัดลอกบริบทภาษาอังกฤษ', 'คัดลอกบริบท + ไฟล์แนบ', 'แปลอีกครั้ง', 'แปลบนเครื่องนี้']) await expect(drawer).toContainText(th);
    await expect(drawer).not.toContainText('Translate again');
  });
});

test.describe('accessibility and layout', () => {
  const serious = async (page: Page, selector: string, name: string) => {
    const r = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    expect(bad, `${name}: ${bad.join(', ')}`).toEqual([]);
  };
  for (const lang of ['en', 'th'] as const) {
    test(`axe: the feedback form with pictures attached and the issue detail have no critical or serious violations (${lang})`, async ({ page }) => {
      const { fb } = await boot(page, { lang, path: '/', translator: { state: 'downloadable' } });
      const modal = await openWidget(page);
      await modal.getByTestId('attachment-input').setInputFiles([png('a.png'), png('b.png')]);
      await expect(thumbs(page)).toHaveCount(2);
      await serious(page, '.modal', 'feedback form');
      await thumbs(page).first().locator('img').click();
      await serious(page, '[data-testid="image-lightbox"]', 'preview');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const issue = fb.seedLegacy({ title: 'Axe issue' }); fb.seedAttachment(issue.id, 'one.png'); fb.seedEnglish(issue.id, ENGLISH);
      await page.goto('/#/feedback'); await page.reload();
      await page.getByRole('row', { name: /Axe issue/ }).click();
      await expect(page.locator('aside.drawer').getByTestId('attachment-item')).toHaveCount(1);
      await serious(page, 'aside.drawer', 'issue detail');
    });
  }
  test('on a phone the form and its pictures fit the screen (no sideways scrolling)', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await boot(page, { path: '/' });
    const modal = await openWidget(page);
    await modal.getByTestId('attachment-input').setInputFiles([png('a-very-long-file-name-that-could-break-the-layout-of-a-small-screen.png'), png('b.png'), png('c.png'), png('d.png'), png('e.png')]);
    await expect(thumbs(page)).toHaveCount(5);
    const over = await page.evaluate(() => { const m = document.querySelector('.modal')!; return m.scrollWidth - m.clientWidth; });
    expect(over).toBeLessThanOrEqual(1);
  });
});

test.describe('who can see and do what', () => {
  test('a customer (non-staff) account is kept out of the back-office feedback workspace', async ({ page }) => {
    const { fb } = await boot(page, { role: 'USER', path: '/feedback' });
    fb.seedLegacy({ title: 'Somebody else problem', reporter_id: '33333333-3333-4333-8333-333333333333' });
    await page.waitForTimeout(800);
    await expect(page.getByRole('heading', { name: 'Feedback & Issue Management' })).toHaveCount(0);
    await expect(page.getByText('Somebody else problem')).toHaveCount(0);
    await expect(page.getByTestId('ctx-status')).toHaveCount(0);
  });
  test('only staff can save the English text, and only as a hand-written text or a translation (fake of the SQL contract)', async ({ page }) => {
    const { fb } = await boot(page, { role: 'USER', path: '/' });
    const call = (args: Record<string, unknown>) => page.evaluate(async (a) => { const r = await fetch('https://hlvravynjalculvplrxc.supabase.co/rest/v1/rpc/feedback_set_english_context', { method: 'POST', body: JSON.stringify(a) }); return (await r.json()).message as string; }, args);
    expect(await call({ p_issue: 'x', p_context: 'y' })).toBe('Only support staff can change the English context');
    expect(await call({ p_issue: 'x', p_context: 'y', p_source: 'translation' })).toBe('Only support staff can change the English context');
    expect(fb.issues).toHaveLength(0);
  });
});
