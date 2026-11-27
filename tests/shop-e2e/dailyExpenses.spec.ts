// The daily expense sheet (/my-expenses → "Record expenses") in a real Chrome against a FAKE of the expense functions below. The fake follows
// the rules of supabase/migrations/20261114210000_daily_expenses.sql (expense_save inserts when there is no id and updates only drafts and
// rejected claims; submit locks them; nothing is ever deleted, only cancelled). This file proves the SCREEN: many rows for one day, the
// running total, saving them together without duplicates, keeping unsaved rows across days and reloads, failures that keep the data.
import { expect, test, type Page, type Route } from '@playwright/test';
import { FakeShop, USER_ID } from './fakeBackend';

const HOST = 'hlvravynjalculvplrxc.supabase.co';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const bkk = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const TODAY = bkk();
const YESTERDAY = bkk(new Date(Date.now() - 86400e3));
const CATS = [
  { code: 'food', en: 'Food & drinks', th: 'ค่าอาหารและรับรอง', icon: 'utensils' }, { code: 'fuel', en: 'Fuel', th: 'ค่าน้ำมัน', icon: 'fuel' },
  { code: 'office', en: 'Office supplies', th: 'เครื่องใช้สำนักงาน', icon: 'paperclip' }, { code: 'travel', en: 'Travel', th: 'ค่าเดินทาง', icon: 'bus' },
].map((c, i) => ({ id: `cat-${c.code}`, code: c.code, name_en: c.en, name_th: c.th, icon: c.icon, sort: i, treatment: 'expense', account_code: '6300', default_tax_type: 'none', default_wht_rate: null, hint_en: null, hint_th: null, active: true }));
type C = Record<string, unknown> & { id: string; status: string; expense_date: string; description: string; amount_paid: number; category_id: string; created_at: string };

class FakeExpenses {
  claims: C[] = [];
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  /** saving a row with this description fails (once per entry) */
  failOn = new Map<string, number>();
  /** answer expense_save slowly, to test a double click */
  slowSave = 0;
  private n = 0;
  seed(o: Partial<C>): C {
    const c = this.make({ expense_date: TODAY, description: 'Seed', amount_paid: 100, category_id: 'cat-food', status: 'draft', ...o });
    this.claims.push(c); return c;
  }
  private make(o: Partial<C>): C {
    const id = `eeeeeeee-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    return {
      id, expense_no: null, created_by: USER_ID, created_by_name: 'Somchai', payment_date: o.expense_date, vendor: null, vendor_tax_id: null, reference_no: null, notes: null, payment_method: 'cash', paid_from: 'cash',
      tax_type: 'none', vat_rate: 0, vat_amount: 0, wht_rate: 0, wht_amount: 0, treatment: 'expense', account_override: null, branch_id: null, submitted_at: null, approved_by: null, approved_at: null, approval_note: null,
      rejected_at: null, reject_reason: null, reviewed_at: null, review_note: null, posted_at: null, posting_date: null, journal_no: null, posted_ref: null, cancelled_at: null, cancel_reason: null, reversal_journal_no: null,
      created_at: new Date(Date.UTC(2026, 0, 1) + this.n * 60e3).toISOString(), ...o,
    } as C;
  }
  withCat(c: C) { const k = CATS.find((x) => x.id === c.category_id); return { ...c, category: k ? { code: k.code, name_en: k.name_en, name_th: k.name_th, icon: k.icon } : null }; }
  rpc(fn: string, a: Record<string, unknown>): unknown {
    const fail = (m: string) => { throw new Error(m); };
    switch (fn) {
      case 'expense_role': return 'employee';
      case 'expense_dashboard': return { today_total: 0, month_total: 0, range_total: 0, by_status: {}, by_category: [], by_method: [] };
      case 'expense_save': {
        const desc = String(a.p_description ?? '').trim();
        const left = this.failOn.get(desc) ?? 0;
        if (left > 0) { this.failOn.set(desc, left - 1); fail('Cannot reach the database. Check the internet connection and try again.'); }
        if (!CATS.some((c) => c.id === a.p_category)) fail('Choose an active expense category');
        if (!desc) fail('Describe what the money was spent on');
        if (!(Number(a.p_amount) > 0)) fail('Enter an amount greater than zero');
        if (String(a.p_expense_date) > TODAY) fail('The expense date cannot be in the future');
        const fields = { expense_date: String(a.p_expense_date), payment_date: String(a.p_expense_date), category_id: String(a.p_category), description: desc, amount_paid: Math.round(Number(a.p_amount) * 100) / 100,
          payment_method: String(a.p_payment_method), paid_from: a.p_payment_method === 'cash' ? 'cash' : 'bank', notes: (a.p_notes as string | null)?.trim() || null, vendor: (a.p_vendor as string | null) || null, tax_type: String(a.p_tax_type) };
        if (!a.p_id) { const c = this.make({ ...fields, status: 'draft' }); this.claims.push(c); return this.withCat(c); }
        const c = this.claims.find((x) => x.id === a.p_id) ?? fail('Expense not found');
        if (!['draft', 'rejected'].includes(c.status)) fail(`Only drafts and rejected expenses can be edited (this one is ${c.status})`);
        Object.assign(c, fields, { status: 'draft' }); return this.withCat(c);
      }
      case 'expense_submit': {
        const c = this.claims.find((x) => x.id === a.p_id) ?? fail('Expense not found');
        if (!['draft', 'rejected'].includes(c.status)) fail('Only drafts can be submitted');
        Object.assign(c, { status: 'submitted', expense_no: `EXP-2026-${c.id.slice(-6)}`, submitted_at: new Date().toISOString() }); return this.withCat(c);
      }
      case 'expense_cancel': {
        const c = this.claims.find((x) => x.id === a.p_id) ?? fail('Expense not found');
        if (c.status !== 'draft' && !String(a.p_reason ?? '').trim()) fail('A reason is required');
        Object.assign(c, { status: 'cancelled', cancel_reason: a.p_reason || null }); return this.withCat(c);
      }
    }
    return undefined;
  }
  async install(page: Page) {
    const json = (route: Route, body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, contentType: 'application/json', headers: { ...cors, ...extra }, body: JSON.stringify(body) });
    await page.route(`https://${HOST}/rest/v1/**`, async (route) => {
      const req = route.request(); const url = new URL(req.url()); const p = url.pathname;
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (p.startsWith('/rest/v1/rpc/expense_')) {
        const fn = p.slice('/rest/v1/rpc/'.length);
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(req.postData() || '{}') as Record<string, unknown>; } catch { /* none */ }
        this.calls.push({ fn, args });
        if (fn === 'expense_save' && this.slowSave) await new Promise((r) => setTimeout(r, this.slowSave));
        try { return await json(route, this.rpc(fn, args) ?? null); } catch (e) { return json(route, { code: 'P0001', message: (e as Error).message, details: null, hint: null }, 400); }
      }
      if (p === '/rest/v1/expense_categories') return json(route, CATS);
      if (p === '/rest/v1/expense_settings') return json(route, { vat_registered: true, vat_rate: 0.07, wht_account_code: '2210', fixed_asset_account_code: '1500', fixed_asset_warn_amount: 0 });
      if (p === '/rest/v1/expense_claims') {
        let rows = this.claims.slice();
        const by = url.searchParams.get('created_by'); if (by) rows = rows.filter((c) => c.created_by === by.replace('eq.', ''));
        for (const f of url.searchParams.getAll('expense_date')) {
          const [op, v] = [f.slice(0, f.indexOf('.')), f.slice(f.indexOf('.') + 1)];
          rows = rows.filter((c) => (op === 'gte' ? c.expense_date >= v : op === 'lte' ? c.expense_date <= v : c.expense_date === v));
        }
        const id = url.searchParams.get('id'); if (id) rows = rows.filter((c) => c.id === id.replace('eq.', ''));
        rows.sort((a, b) => (a.expense_date < b.expense_date ? 1 : a.expense_date > b.expense_date ? -1 : a.created_at < b.created_at ? 1 : -1));
        const out = rows.map((c) => this.withCat(c));
        if ((req.headers()['accept'] ?? '').includes('vnd.pgrst.object')) return json(route, out[0]);
        return json(route, out, 200, { 'content-range': `0-${Math.max(out.length - 1, 0)}/${out.length}` });
      }
      if (p === '/rest/v1/expense_attachments' || p === '/rest/v1/expense_events') return json(route, []);
      return route.fallback();
    });
  }
  live() { return this.claims.filter((c) => c.status !== 'cancelled'); }
}

const L = (en: string, th: string) => new RegExp(`^(${en}|${th})$`);
async function boot(page: Page, fx = new FakeExpenses()) {
  const shop = new FakeShop();
  await shop.install(page); await fx.install(page);
  await page.addInitScript(() => { try { localStorage.setItem('bizops.expenses.guide', '1'); } catch { /* ignore */ } });
  await page.goto('/#/my-expenses');
  await expect(page.getByTestId('xs-total')).toBeVisible();
  return fx;
}
const item = (page: Page, n: number) => page.getByLabel(L(`Expense item, row ${n}`, `รายการ แถว ${n}`));
const cat = (page: Page, n: number) => page.getByLabel(L(`Category, row ${n}`, `หมวดหมู่ แถว ${n}`));
const method = (page: Page, n: number) => page.getByLabel(L(`Paid by, row ${n}`, `จ่ายโดย แถว ${n}`));
const amount = (page: Page, n: number) => page.getByLabel(L(`Amount, row ${n}`, `จำนวนเงิน แถว ${n}`));
const notes = (page: Page, n: number) => page.getByLabel(L(`Notes, row ${n}`, `หมายเหตุ แถว ${n}`));
const saveBtn = (page: Page) => page.getByTestId('xs-save');
async function fillRow(page: Page, n: number, r: { item: string; cat?: string; amount: string; method?: string; notes?: string }) {
  await item(page, n).fill(r.item);
  if (r.cat) await cat(page, n).selectOption(r.cat);
  if (r.method) await method(page, n).selectOption(r.method);
  if (r.notes) await notes(page, n).fill(r.notes);
  await amount(page, n).fill(r.amount);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test('several rows for one day: running total, Enter adds a row, delete and edit before saving, one save creates each claim once', async ({ page }) => {
    const fx = await boot(page);
    await expect(page.getByTestId('xs-count')).toHaveText('0');
    await fillRow(page, 1, { item: 'Coffee', cat: 'cat-food', amount: '80' });
    await amount(page, 1).press('Enter');                                         // Enter in Amount opens the next row with the cursor in it
    await expect(item(page, 2)).toBeFocused();
    await page.keyboard.type('Lunch');
    await cat(page, 2).selectOption('cat-food'); await amount(page, 2).fill('120'); await amount(page, 2).press('Enter');
    await fillRow(page, 3, { item: 'Gasoline', cat: 'cat-fuel', amount: '1,500.50', method: 'card', notes: 'Trip to supplier' });
    await expect(page.getByTestId('xs-count')).toHaveText('3');
    await expect(page.getByTestId('xs-total')).toHaveText('฿1,700.50');
    // delete Lunch, change Coffee: the total follows at once
    await page.getByRole('button', { name: L('Delete row 2', 'ลบแถว 2') }).click();
    await expect(page.getByTestId('xs-total')).toHaveText('฿1,580.50');
    await amount(page, 1).fill('90');
    await expect(page.getByTestId('xs-total')).toHaveText('฿1,590.50');
    expect(fx.calls.filter((c) => c.fn === 'expense_save')).toHaveLength(0);       // nothing is sent before Save
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 2 expense|บันทึก 2 รายการของ/)).toBeVisible();
    expect(fx.live().map((c) => [c.description, c.amount_paid, c.expense_date, c.payment_method])).toEqual([['Coffee', 90, TODAY, 'cash'], ['Gasoline', 1500.5, TODAY, 'card']]);
    expect(fx.live()[1].notes).toBe('Trip to supplier');
    // saving again with nothing changed sends nothing; an edit updates the same claim
    await saveBtn(page).click();
    expect(fx.calls.filter((c) => c.fn === 'expense_save')).toHaveLength(2);
    await amount(page, 1).fill('95'); await saveBtn(page).click();
    await expect.poll(() => fx.live().find((c) => c.description === 'Coffee')?.amount_paid).toBe(95);
    expect(fx.live()).toHaveLength(2);
    // after a reload the day comes back from the server
    await page.reload();
    await expect(page.getByTestId('xs-total')).toHaveText('฿1,595.50');
    await expect(item(page, 1)).toHaveValue('Coffee');
    await expect(amount(page, 2)).toHaveValue('1,500.50');
  });

  test('a double click on Save while the first save is running does not create duplicates', async ({ page }) => {
    const fx = await boot(page);
    fx.slowSave = 600;
    await fillRow(page, 1, { item: 'Parking', cat: 'cat-travel', amount: '40' });
    await saveBtn(page).dblclick();
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 1 expense|บันทึก 1 รายการของ/)).toBeVisible();
    await page.waitForTimeout(800);
    expect(fx.live()).toHaveLength(1);
  });

  test('missing item or amount is shown on the row and nothing is saved; a failed save keeps the rows and a retry does not duplicate', async ({ page }) => {
    const fx = await boot(page);
    await fillRow(page, 1, { item: '', cat: 'cat-office', amount: '250' });
    await amount(page, 1).press('Enter');
    await fillRow(page, 2, { item: 'Paper', amount: '' });
    await saveBtn(page).click();
    await expect(page.getByText(/^(Type what it was|ใส่ชื่อรายการ)$/)).toBeVisible();
    await expect(page.getByText(/^(Enter the amount|ใส่จำนวนเงิน)$/)).toBeVisible();
    await expect(page.getByText(/^(Pick a category|เลือกหมวดหมู่)$/)).toBeVisible();
    expect(fx.calls.filter((c) => c.fn === 'expense_save')).toHaveLength(0);
    await item(page, 1).fill('Pens'); await cat(page, 2).selectOption('cat-office'); await amount(page, 2).fill('35');
    fx.failOn.set('Paper', 1);                                                     // the second row fails once (connection lost)
    await saveBtn(page).click();
    await expect(page.getByText(/1 saved, 1 not saved|บันทึกแล้ว 1 รายการ ยังไม่สำเร็จ 1 รายการ/)).toBeVisible();
    await expect(item(page, 2)).toHaveValue('Paper');                               // nothing typed is lost
    await expect(amount(page, 2)).toHaveValue('35.00');
    expect(fx.live().map((c) => c.description)).toEqual(['Pens']);
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 1 expense|บันทึก 1 รายการของ/)).toBeVisible();
    expect(fx.live().map((c) => c.description).sort()).toEqual(['Paper', 'Pens']);
  });

  test('another day: existing expenses load (sent ones are locked), new rows can be added, unsaved rows survive changing the day and a reload', async ({ page }) => {
    const fx = new FakeExpenses();
    fx.seed({ expense_date: YESTERDAY, description: 'Gasoline', category_id: 'cat-fuel', amount_paid: 500, status: 'submitted', expense_no: 'EXP-2026-000001', payment_method: 'card' });
    fx.seed({ expense_date: YESTERDAY, description: 'Coffee', category_id: 'cat-food', amount_paid: 60, status: 'draft' });
    fx.seed({ expense_date: YESTERDAY, description: 'Old mistake', amount_paid: 999, status: 'cancelled' });
    await boot(page, fx);
    await fillRow(page, 1, { item: 'Water', cat: 'cat-food', amount: '15' });       // typed today, not saved
    await page.getByRole('button', { name: L('Previous day', 'วันก่อนหน้า') }).click();
    await expect(page.getByTestId('xs-total')).toHaveText('฿560.00');               // the cancelled one is left out
    await expect(page.getByText('EXP-2026-000001')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'EXP-2026-000001' }).getByRole('textbox')).toHaveCount(0);   // sent for approval: read-only
    // a historical draft can be edited, and a new row added to that day
    await amount(page, 2).fill('65');
    await fillRow(page, 3, { item: 'Gasoline', amount: '300' });                    // a known item fills its category and how it was paid
    await expect(cat(page, 3)).toHaveValue('cat-fuel');
    await expect(method(page, 3)).toHaveValue('card');
    await expect(page.getByTestId('xs-total')).toHaveText('฿865.00');
    await page.reload();                                                           // a reload opens today: its unsaved row is back
    await expect(item(page, 1)).toHaveValue('Water');
    await expect(page.getByText(/Unsaved rows on other days|มีแถวที่ยังไม่บันทึกในวันอื่น/)).toBeVisible();
    await page.getByRole('button', { name: L('Previous day', 'วันก่อนหน้า') }).click();
    await expect(page.getByTestId('xs-total')).toHaveText('฿865.00');
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 2 expense|บันทึก 2 รายการของ/)).toBeVisible();
    expect(fx.live().filter((c) => c.expense_date === YESTERDAY).map((c) => [c.description, c.amount_paid]).sort()).toEqual([['Coffee', 65], ['Gasoline', 300], ['Gasoline', 500]]);
  });

  test('a saved draft is removed by cancelling it (never erased), and the day is sent for approval in one step, which locks it', async ({ page }) => {
    const fx = new FakeExpenses();
    fx.seed({ description: 'Coffee', amount_paid: 80 }); fx.seed({ description: 'Typo row', amount_paid: 5 });
    await boot(page, fx);
    await page.getByRole('button', { name: L('Delete row 2', 'ลบแถว 2') }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^(Remove|ลบรายการ)$/ }).click();
    await expect(page.getByTestId('xs-total')).toHaveText('฿80.00');
    expect(fx.claims.find((c) => c.description === 'Typo row')?.status).toBe('cancelled');
    await fillRow(page, 2, { item: 'Lunch', cat: 'cat-food', amount: '120' });
    await page.getByRole('button', { name: /Send day for approval|ส่งอนุมัติทั้งวัน/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^(Send for approval|ส่งอนุมัติ)$/ }).click();
    await expect(page.getByText(/2 expense\(s\) sent for approval|ส่งขออนุมัติแล้ว 2 รายการ/)).toBeVisible();
    expect(fx.live().map((c) => c.status)).toEqual(['submitted', 'submitted']);
    await expect(page.getByTestId('xs-total')).toHaveText('฿200.00');
    await expect(item(page, 1)).toHaveCount(0);                                     // the sent rows are read-only now
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('rows stack, nothing scrolls sideways, and the save bar stays reachable', async ({ page }) => {
    const fx = await boot(page);
    await fillRow(page, 1, { item: 'Coffee', cat: 'cat-food', amount: '80' });
    await amount(page, 1).press('Enter');
    await fillRow(page, 2, { item: 'Parking', cat: 'cat-travel', amount: '40' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const box = await amount(page, 2).boundingBox();
    expect(box!.width).toBeGreaterThan(120);
    await expect(page.getByTestId('xs-total')).toHaveText('฿120.00');
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 2 expense|บันทึก 2 รายการของ/)).toBeVisible();
    expect(fx.live()).toHaveLength(2);
    await page.screenshot({ path: 'test-results/daily-expenses-phone.png', fullPage: true });
  });
});
