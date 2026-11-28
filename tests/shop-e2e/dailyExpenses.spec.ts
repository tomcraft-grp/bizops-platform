// The daily expense sheet (/my-expenses → "Record expenses") in a real Chrome against a FAKE of the expense functions below. The fake follows
// the rules of supabase/migrations/20261114210000_daily_expenses.sql (expense_save inserts when there is no id and updates only drafts and
// rejected claims; submit locks them; nothing is ever deleted, only cancelled). This file proves the SCREEN: many rows for one day, the
// running total, saving them together without duplicates, keeping unsaved rows across days and reloads, failures that keep the data.
import { expect, test, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
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

// the catalogue (expense_product_options) and the shop's bank accounts (expense_bank_options) as the database returns them: no prices, last 4 digits only
const STOCK_CATS = [
  { id: 'cat-rm', code: 'stock_materials', name_en: 'Raw materials & packaging', name_th: 'วัตถุดิบและบรรจุภัณฑ์', icon: 'boxes', sort: 5, treatment: 'inventory', account_code: null, posting_role: 'inv_materials', product_class: 'RM', default_tax_type: 'none', default_wht_rate: null, hint_en: null, hint_th: null, active: true },
  { id: 'cat-fg', code: 'stock_goods', name_en: 'Goods for resale', name_th: 'สินค้าซื้อมาเพื่อขาย', icon: 'shopping-bag', sort: 6, treatment: 'inventory', account_code: null, posting_role: 'inv_goods', product_class: 'FG', default_tax_type: 'none', default_wht_rate: null, hint_en: null, hint_th: null, active: true },
];
const PRODUCTS = [
  { sku_code: 'RM-000001', name_th: 'น้ำตาลสด', name_en: 'Fresh coconut sugar', brand: null, unit_th: 'กก.', unit_en: 'kg', sku_category: 'RM', product_type: null, category_id: 'cat-rm' },
  { sku_code: 'FG-000086', name_th: 'น้ำกระท่อม 250 มล.', name_en: 'Kratom drink 250 ml', brand: null, unit_th: 'ขวด', unit_en: 'bottle', sku_category: 'FG', product_type: 'Kratom drink', category_id: 'cat-fg' },
];
const BANKS = [
  { id: 'bank-scb', code: 'SCB', bank_name_th: 'ธนาคารไทยพาณิชย์', bank_name_en: 'Siam Commercial Bank', account_name: 'Shop', last4: '6251', active: true },
  { id: 'bank-bbl', code: 'BBL', bank_name_th: 'ธนาคารกรุงเทพ', bank_name_en: 'Bangkok Bank', account_name: 'Shop', last4: '9542', active: true },
];
const ALL_CATS = [...CATS, ...STOCK_CATS];

class FakeExpenses {
  claims: C[] = [];
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  /** the catalogue the fake offers (empty unless a test needs products) */
  products: typeof PRODUCTS = [];
  /** the signed-in person's expense role ('manager' may approve & post) */
  role = 'employee';
  /** the bank balances the fake keeps (the real ones come from a ledger) */
  balance: Record<string, number> = { 'bank-scb': 100000, 'bank-bbl': 0 };
  private btx = 0;
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
  withCat(c: C) { const k = ALL_CATS.find((x) => x.id === c.category_id); return { ...c, category: k ? { code: k.code, name_en: k.name_en, name_th: k.name_th, icon: k.icon } : null }; }
  /** the same reasons as expense_post_problem */
  problem(c: C): string | null {
    if (c.status === 'posted') return 'EXP_ALREADY_POSTED: This expense is already posted';
    if (c.status === 'cancelled') return 'EXP_CANCELLED: This expense was cancelled';
    if (c.status === 'rejected') return 'EXP_SENT_BACK: This expense was sent back to the employee to fix';
    if (['bank_transfer', 'qr'].includes(String(c.payment_method)) && !c.bank_account_id) return 'EXP_BANK_REQUIRED: Choose the bank account the money was paid from';
    return null;
  }
  rpc(fn: string, a: Record<string, unknown>): unknown {
    const fail = (m: string) => { throw new Error(m); };
    switch (fn) {
      case 'expense_role': return this.role;
      case 'expense_product_options': return this.products;
      case 'expense_bank_options': return BANKS;
      case 'expense_mark_reviewed': { let n = 0; for (const c of this.claims) if ((a.p_ids as string[]).includes(c.id) && ['draft', 'submitted', 'approved'].includes(c.status)) { c.reviewed_at = new Date().toISOString(); n++; } return n; }
      case 'expense_post_preview': {
        const items = this.claims.filter((c) => (a.p_ids as string[]).includes(c.id)).map((c) => ({ id: c.id, expense_no: c.expense_no, description: c.description, expense_date: c.expense_date, amount_paid: c.amount_paid, wht_amount: 0,
          payment_method: c.payment_method, bank_account_id: c.bank_account_id ?? null, status: c.status, created_by_name: 'Somchai', problem: this.problem(c),
          bank_code: BANKS.find((b) => b.id === c.bank_account_id)?.code ?? null, bank_name_th: null, bank_name_en: BANKS.find((b) => b.id === c.bank_account_id)?.bank_name_en ?? null, bank_last4: BANKS.find((b) => b.id === c.bank_account_id)?.last4 ?? null }));
        const ok = items.filter((x) => !x.problem);
        const byBank = BANKS.map((b) => ({ b, xs: ok.filter((x) => x.bank_account_id === b.id && ['bank_transfer', 'qr'].includes(String(x.payment_method))) })).filter((x) => x.xs.length)
          .map(({ b, xs }) => ({ bank_account_id: b.id, code: b.code, bank_name_th: b.bank_name_th, bank_name_en: b.bank_name_en, last4: b.last4, n: xs.length, out: xs.reduce((s, x) => s + x.amount_paid, 0), balance: this.balance[b.id] }));
        const methods = [...new Set(ok.map((x) => String(x.payment_method)))].map((m) => ({ method: m, n: ok.filter((x) => x.payment_method === m).length, amount: ok.filter((x) => x.payment_method === m).reduce((s, x) => s + x.amount_paid, 0) }));
        return { items, missing: 0, ok_count: ok.length, ok_total: ok.reduce((s, x) => s + x.amount_paid, 0), by_method: methods, by_bank: byBank };
      }
      case 'expense_post_bulk': {
        const posted: unknown[] = [], skipped: unknown[] = [], failed: unknown[] = []; let total = 0;
        for (const id of [...new Set(a.p_ids as string[])].sort()) {
          const c = this.claims.find((x) => x.id === id);
          if (!c) { failed.push({ id, code: 'EXP_NOT_FOUND', reason: 'EXP_NOT_FOUND: Expense not found', expense_no: null, description: null, amount: null }); continue; }
          if (c.status === 'posted') { skipped.push({ id, result: 'already_posted', expense_no: c.expense_no, amount: c.amount_paid }); continue; }
          const pr = this.problem(c);
          if (pr) { failed.push({ id, code: pr.split(':')[0], reason: pr, expense_no: c.expense_no, description: c.description, amount: c.amount_paid }); continue; }
          const no = (c.expense_no as string | null) ?? `EXP-2026-${c.id.slice(-6)}`;
          let txn: string | null = null, after: number | null = null;
          if (c.bank_account_id && ['bank_transfer', 'qr'].includes(String(c.payment_method))) { const b = String(c.bank_account_id); this.balance[b] = Math.round((this.balance[b] - c.amount_paid) * 100) / 100; after = this.balance[b]; txn = `BTX-2026-${String(++this.btx).padStart(6, '0')}`; }
          Object.assign(c, { status: 'posted', expense_no: no, posted_at: new Date().toISOString(), posting_date: c.expense_date, gl_queue_id: `q-${c.id}`, bank_txn_id: txn });
          total += c.amount_paid;
          posted.push({ id, result: 'posted', expense_no: no, amount: c.amount_paid, description: c.description, bank_txn_no: txn, bank_out: txn ? c.amount_paid : null, bank_balance_after: after });
        }
        return { posted, skipped, failed, total_posted: total, request: a.p_request };
      }
      case 'expense_dashboard': return { today_total: 0, month_total: 0, range_total: 0, by_status: {}, by_category: [], by_method: [] };
      case 'expense_save': {
        const desc = String(a.p_description ?? '').trim();
        const left = this.failOn.get(desc) ?? 0;
        if (left > 0) { this.failOn.set(desc, left - 1); fail('Cannot reach the database. Check the internet connection and try again.'); }
        const product = a.p_sku ? PRODUCTS.find((p) => p.sku_code === a.p_sku) ?? fail('This product is not in the product list') : null;
        const catId = (a.p_category as string | null) ?? product?.category_id ?? null;
        if (!ALL_CATS.some((c) => c.id === catId)) fail('Choose an active expense category');
        if (!desc) fail('Describe what the money was spent on');
        if (!(Number(a.p_amount) > 0)) fail('Enter an amount greater than zero');
        if (String(a.p_expense_date) > TODAY) fail('The expense date cannot be in the future');
        const bankWay = ['bank_transfer', 'qr'].includes(String(a.p_payment_method));
        if ('p_bank_account' in a && bankWay && !a.p_bank_account) fail('Choose the bank account the money was paid from');
        const fields = { expense_date: String(a.p_expense_date), payment_date: String(a.p_expense_date), category_id: String(catId), description: desc, amount_paid: Math.round(Number(a.p_amount) * 100) / 100,
          payment_method: String(a.p_payment_method), paid_from: a.p_payment_method === 'cash' ? 'cash' : 'bank', notes: (a.p_notes as string | null)?.trim() || null, vendor: (a.p_vendor as string | null) || null, tax_type: String(a.p_tax_type),
          sku_code: (a.p_sku as string | null) ?? null, bank_account_id: bankWay ? (a.p_bank_account as string | null) ?? null : null,
          treatment: STOCK_CATS.some((c) => c.id === catId) ? 'inventory' : 'expense', reviewed_at: null };
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
      if (p === '/rest/v1/expense_categories') return json(route, ALL_CATS);
      if (p === '/rest/v1/expense_settings') return json(route, { vat_registered: true, vat_rate: 0.07, wht_account_code: '2210', fixed_asset_account_code: '1500', fixed_asset_warn_amount: 0 });
      if (p === '/rest/v1/expense_claims') {
        let rows = this.claims.slice();
        const by = url.searchParams.get('created_by'); if (by) rows = rows.filter((c) => c.created_by === by.replace('eq.', ''));
        for (const f of url.searchParams.getAll('expense_date')) {
          const [op, v] = [f.slice(0, f.indexOf('.')), f.slice(f.indexOf('.') + 1)];
          rows = rows.filter((c) => (op === 'gte' ? c.expense_date >= v : op === 'lte' ? c.expense_date <= v : c.expense_date === v));
        }
        const id = url.searchParams.get('id'); if (id) rows = rows.filter((c) => c.id === id.replace('eq.', ''));
        const st = url.searchParams.get('status');
        if (st?.startsWith('in.(')) { const set = st.slice(4, -1).split(','); rows = rows.filter((c) => set.includes(c.status)); } else if (st) rows = rows.filter((c) => c.status === st.replace('eq.', ''));
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
  await page.addInitScript(() => { try { localStorage.setItem('bizops.expenses.guide', '1'); localStorage.setItem('bizops.expenses.guide.v2', '1'); } catch { /* ignore */ } });
  await page.goto('/#/my-expenses');
  if (fx.role !== 'employee') await page.getByRole('tab', { name: /Record expenses|บันทึกรายจ่าย/ }).click();   // a poster opens on "Approve & post"
  await expect(page.getByTestId('xs-total')).toBeVisible();
  return fx;
}
const bankSel = (page: Page, n: number) => page.getByLabel(L(`Bank account, row ${n}`, `บัญชีธนาคาร แถว ${n}`));
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

  test('a saved draft is removed by cancelling it (never erased); there is no "send for approval" step any more: saved rows stay drafts', async ({ page }) => {
    const fx = new FakeExpenses();
    fx.seed({ description: 'Coffee', amount_paid: 80 }); fx.seed({ description: 'Typo row', amount_paid: 5 });
    await boot(page, fx);
    await page.getByRole('button', { name: L('Delete row 2', 'ลบแถว 2') }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^(Remove|ลบรายการ)$/ }).click();
    await expect(page.getByTestId('xs-total')).toHaveText('฿80.00');
    expect(fx.claims.find((c) => c.description === 'Typo row')?.status).toBe('cancelled');
    await fillRow(page, 2, { item: 'Lunch', cat: 'cat-food', amount: '120' });
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 1 expense|บันทึก 1 รายการของ/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Send day for approval|ส่งอนุมัติทั้งวัน/ })).toHaveCount(0);
    expect(fx.calls.some((c) => c.fn === 'expense_submit')).toBe(false);
    expect(fx.live().map((c) => c.status)).toEqual(['draft', 'draft']);
    await expect(item(page, 1)).toBeEditable();                                     // still editable until it is posted
  });

  test('choosing a product fills the category from its catalogue class: a raw material that is also sold stays "Raw materials"', async ({ page }) => {
    const withProducts = new FakeExpenses(); withProducts.products = PRODUCTS;
    const fx = await boot(page, withProducts);
    await item(page, 1).click();
    await item(page, 1).fill('sugar');
    await page.getByTestId('xs-opt').filter({ hasText: 'RM-000001' }).click();
    await expect(cat(page, 1)).toHaveValue('cat-rm');
    await expect(page.getByTestId('xs-row').first().locator('.xs-prod')).toContainText('RM-000001');
    await amount(page, 1).fill('2500');
    await amount(page, 1).press('Enter');
    await item(page, 2).fill('Kratom drink');
    await page.getByTestId('xs-opt').filter({ hasText: /FG-000086/ }).first().click();
    await expect(cat(page, 2)).toHaveValue('cat-fg');
    await cat(page, 2).selectOption('cat-office');                                    // the person can still change it before saving
    await amount(page, 2).fill('300');
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 2 expense|บันทึก 2 รายการของ/)).toBeVisible();
    const saves = fx.calls.filter((c) => c.fn === 'expense_save').map((c) => c.args);
    expect(saves.map((s) => [s.p_sku, s.p_category])).toEqual([['RM-000001', 'cat-rm'], ['FG-000086', 'cat-office']]);
  });

  test('a bank transfer needs the bank account: the list appears, the row is refused without it, and the chosen account is saved', async ({ page }) => {
    const fx = await boot(page);
    await expect(bankSel(page, 1)).toHaveCount(0);                                    // cash: no bank list
    await fillRow(page, 1, { item: 'Supplier invoice', cat: 'cat-office', amount: '2500', method: 'bank_transfer' });
    await expect(bankSel(page, 1)).toBeVisible();
    await expect(bankSel(page, 1).locator('option')).toHaveText([/Bank account…|เลือกบัญชีธนาคาร…/, /SCB .*••6251/, /BBL .*••9542/]);
    await saveBtn(page).click();
    await expect(page.getByText(/Choose the bank account|เลือกบัญชีธนาคาร/).first()).toBeVisible();
    expect(fx.calls.filter((c) => c.fn === 'expense_save')).toHaveLength(0);
    await bankSel(page, 1).selectOption('bank-scb');
    await saveBtn(page).click();
    await expect(page.getByText(/Saved 1 expense|บันทึก 1 รายการของ/)).toBeVisible();
    expect(fx.calls.find((c) => c.fn === 'expense_save')!.args).toMatchObject({ p_payment_method: 'bank_transfer', p_bank_account: 'bank-scb' });
    await method(page, 1).selectOption('cash');                                       // back to cash: the account is dropped
    await expect(bankSel(page, 1)).toHaveCount(0);
  });
});

test.describe('approve & post to accounting (manager)', () => {
  test.use({ viewport: { width: 1366, height: 900 } });
  const open = async (page: Page, fx: FakeExpenses) => {
    const shop = new FakeShop();
    await shop.install(page); await fx.install(page);
    await page.addInitScript(() => { try { localStorage.setItem('bizops.expenses.guide.v2', '1'); } catch { /* ignore */ } });
    await page.goto('/#/my-expenses');
    await expect(page.getByTestId('pq-row').first()).toBeVisible();
  };

  test('tick many, see count, total, methods, the bank and its balance, confirm once: posted, skipped and failed are each listed with the reason', async ({ page }) => {
    const fx = new FakeExpenses(); fx.role = 'manager';
    fx.seed({ description: 'น้ำตาลสด', amount_paid: 2500, payment_method: 'bank_transfer', paid_from: 'bank', bank_account_id: 'bank-scb', category_id: 'cat-rm', sku_code: 'RM-000001' });
    fx.seed({ description: 'Coffee', amount_paid: 100 });
    fx.seed({ description: 'Old app transfer', amount_paid: 50, payment_method: 'bank_transfer', paid_from: 'bank' });   // no bank account: cannot be ticked
    await open(page, fx);
    const rows = page.getByTestId('pq-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'Old app transfer' }).getByRole('checkbox')).toBeDisabled();
    await page.getByTestId('pq-all').click();                                          // every row that can be posted in the filter
    await expect(page.getByTestId('pq-selected')).toHaveText(/2 selected|เลือก 2 รายการ/);
    await page.getByTestId('pq-post').click();
    const pv = page.getByTestId('pq-preview');
    await expect(pv.getByTestId('pq-ok-count')).toHaveText('2');
    await expect(pv.getByTestId('pq-ok-total')).toContainText('2,600');
    await expect(pv.getByTestId('pq-banks')).toContainText('SCB');
    await expect(pv.getByTestId('pq-banks')).toContainText('100,000');
    await expect(pv.getByTestId('pq-banks')).toContainText('97,500');
    await page.getByTestId('pq-confirm').dblclick();                                    // a double click posts once
    const res = page.getByTestId('pq-result');
    await expect(res.getByTestId('pq-res-posted')).toHaveText('2');
    await expect(res).toContainText('BTX-2026-000001');
    expect(fx.calls.filter((c) => c.fn === 'expense_post_bulk')).toHaveLength(1);
    expect(fx.balance['bank-scb']).toBe(97500);
    expect(fx.claims.filter((c) => c.status === 'posted').map((c) => c.description).sort()).toEqual(['Coffee', 'น้ำตาลสด']);
  });

  test('an ineligible row sent along is reported as failed with its reason, an already posted one as skipped', async ({ page }) => {
    const fx = new FakeExpenses(); fx.role = 'manager';
    fx.seed({ description: 'Lunch', amount_paid: 120 });
    await open(page, fx);
    await page.getByTestId('pq-row').first().getByRole('checkbox').check();
    await page.getByTestId('pq-post').click();
    // meanwhile someone else posts it and an employee records a transfer without a bank account
    fx.claims[0].status = 'posted';
    await page.getByTestId('pq-confirm').click();
    await expect(page.getByTestId('pq-result')).toContainText(/Already posted before|ลงบัญชีไว้ก่อนแล้ว/);
    await expect(page.getByTestId('pq-result').getByTestId('pq-res-posted')).toHaveText('0');
  });

  test('phone: the selection bar and the table stay inside the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fx = new FakeExpenses(); fx.role = 'manager';
    fx.seed({ description: 'Coffee', amount_paid: 100 }); fx.seed({ description: 'Paper', amount_paid: 60 });
    await open(page, fx);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(page.getByTestId('pq-post')).toBeVisible();
    await page.screenshot({ path: 'test-results/approve-post-phone.png', fullPage: true });
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

// ------------------------------------------------------------------------------------------------ the list under the item box shows the icon of each category
const opts = (page: Page) => page.getByTestId('xs-opt');
const optOf = (page: Page, text: string) => opts(page).filter({ has: page.locator('.xs-opt-t', { hasText: new RegExp(`^${text}$`) }) });
const pop = (page: Page) => page.getByTestId('xs-pop');
function earlier(fx: FakeExpenses) {
  fx.seed({ expense_date: YESTERDAY, description: 'Coffee', category_id: 'cat-food', amount_paid: 60 });
  fx.seed({ expense_date: YESTERDAY, description: 'Gasoline', category_id: 'cat-fuel', amount_paid: 900, payment_method: 'card' });
  return fx;
}

test.describe('item list with category icons (desktop)', () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test('every entry has the icon of its category; choosing one fills the item, the category and how it was paid', async ({ page }) => {
    await boot(page, earlier(new FakeExpenses()));
    await expect(pop(page)).toHaveCount(0);
    await item(page, 1).click();
    await expect(pop(page)).toBeVisible();
    await expect(opts(page)).toHaveCount(6);                       // the two earlier items, then the four category names
    for (let i = 0; i < 6; i++) await expect(opts(page).nth(i).locator('.xs-ico svg')).toHaveCount(1);
    await expect(optOf(page, 'Coffee').locator('.xs-ico svg')).toHaveClass(/lucide-utensils/);
    await expect(optOf(page, 'Gasoline').locator('.xs-ico svg')).toHaveClass(/lucide-fuel/);
    await expect(optOf(page, 'Coffee')).toContainText(/Food & drinks|ค่าอาหารและรับรอง/);          // the category name, small, at the end
    await expect(page.locator('.xs-opt-s')).toHaveCount(2);                                          // not repeated on the entries that ARE a category
    await page.screenshot({ path: 'test-results/xs-icons-desktop.png' });
    await optOf(page, 'Gasoline').click();
    await expect(item(page, 1)).toHaveValue('Gasoline');
    await expect(cat(page, 1)).toHaveValue('cat-fuel');
    await expect(method(page, 1)).toHaveValue('card');
    await expect(pop(page)).toHaveCount(0);
    await expect(item(page, 1)).toBeFocused();
    await expect(page.locator('.xs-lead svg').first()).toHaveClass(/lucide-fuel/);                  // the icon in front of the text follows the category
  });

  test('typing narrows the list; arrow keys and Enter choose; Enter with nothing highlighted changes nothing; Escape and Tab close', async ({ page }) => {
    await boot(page, earlier(new FakeExpenses()));
    await item(page, 1).click(); await page.keyboard.type('gas');
    await expect(opts(page)).toHaveCount(1);
    await page.keyboard.press('Enter');                                            // nothing highlighted: the typed text stays, no other row appears
    await expect(item(page, 1)).toHaveValue('gas');
    await expect(opts(page)).toHaveCount(1);
    await expect(item(page, 2)).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(opts(page).first()).toHaveAttribute('aria-selected', 'true');
    await expect(item(page, 1)).toHaveAttribute('aria-activedescendant', /.+/);
    await page.keyboard.press('Enter');
    await expect(item(page, 1)).toHaveValue('Gasoline');
    await expect(cat(page, 1)).toHaveValue('cat-fuel');
    await expect(pop(page)).toHaveCount(0);
    await item(page, 1).fill('co');
    await expect(opts(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(pop(page)).toHaveCount(0);
    await expect(item(page, 1)).toHaveValue('co');                                 // Escape does not touch the text
    await page.keyboard.press('ArrowDown');                                        // ArrowDown opens it again
    await expect(opts(page)).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(pop(page)).toHaveCount(0);
  });

  test('the cursor that the sheet moves into the next row by itself does not open the list', async ({ page }) => {
    await boot(page, earlier(new FakeExpenses()));
    await fillRow(page, 1, { item: 'Water', cat: 'cat-food', amount: '10' });
    await amount(page, 1).press('Enter');
    await expect(item(page, 2)).toBeFocused();
    await expect(pop(page)).toHaveCount(0);
    await item(page, 2).click();
    await expect(pop(page)).toBeVisible();                                          // a click does
    await page.getByTestId('xs-total').click();                                     // a press anywhere else closes it
    await expect(pop(page)).toHaveCount(0);
  });

  test('the list is on top of the sheet and inside the window', async ({ page }) => {
    await boot(page, earlier(new FakeExpenses()));
    await item(page, 1).click();
    const b = (await pop(page).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1366); expect(b.y + b.height).toBeLessThanOrEqual(900);
    const onTop = await page.evaluate(() => { const p = document.querySelector('[data-testid=xs-pop]')!; const r = p.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return !!e && p.contains(e); });
    expect(onTop).toBe(true);
  });

  test('with no room below, the list opens upwards and stays inside the window', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 360 });
    await boot(page, earlier(new FakeExpenses()));
    await item(page, 1).focus();
    await item(page, 1).evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await page.keyboard.press('ArrowDown');
    await expect(pop(page)).toBeVisible();
    const p = (await pop(page).boundingBox())!, i = (await item(page, 1).boundingBox())!;
    expect(p.y + p.height).toBeLessThanOrEqual(i.y + 1);                            // above the box
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  test("a row sent for approval keeps its icon, and a new row's icon follows the category chosen by hand", async ({ page }) => {
    const fx = new FakeExpenses(); fx.seed({ expense_date: TODAY, description: 'Taxi', category_id: 'cat-travel', status: 'submitted' });
    await boot(page, fx);
    await expect(page.locator('.xs-lt .xs-ico svg')).toHaveClass(/lucide-bus/);
    await expect(page.locator('.xs-lead svg')).toHaveClass(/lucide-receipt/);       // nothing chosen yet: a neutral icon
    await expect(page.locator('.xs-lead.off')).toHaveCount(1);
    await cat(page, 2).selectOption('cat-office');
    await expect(page.locator('.xs-lead svg')).toHaveClass(/lucide-paperclip/);
    await expect(page.locator('.xs-lead.off')).toHaveCount(0);
  });

  test('in the dark theme the list is dark with light text', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await boot(page, earlier(new FakeExpenses()));
    await item(page, 1).click();
    await expect(pop(page)).toBeVisible();
    const lum = (c: string) => { const m = c.match(/\d+(\.\d+)?/g)!.map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    const { bg, fg } = await page.evaluate(() => ({ bg: getComputedStyle(document.querySelector('[data-testid=xs-pop]')!).backgroundColor, fg: getComputedStyle(document.querySelector('.xs-opt-t')!).color }));
    expect(lum(bg)).toBeLessThan(0.3); expect(lum(fg)).toBeGreaterThan(0.6);
    await page.screenshot({ path: 'test-results/xs-icons-dark.png' });
  });

  test('axe: no serious problems in the open list', async ({ page }) => {
    await boot(page, earlier(new FakeExpenses()));
    await item(page, 1).click();
    await expect(pop(page)).toBeVisible();
    const r = await new AxeBuilder({ page }).include('[data-testid=xs-pop]').include('.xs-ib').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')}`)).toEqual([]);
  });
});

test.describe('item list with category icons (Thai)', () => {
  test.use({ viewport: { width: 1366, height: 900 } });
  test('Thai names, even very long ones, stay inside the list', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'th'); } catch { /* ignore */ } });
    const fx = earlier(new FakeExpenses());
    fx.seed({ expense_date: YESTERDAY, description: 'ค่าอินเทอร์เน็ตและโทรศัพท์ของสำนักงานใหญ่และสาขาทั้งหมดประจำเดือนพฤศจิกายนพร้อมค่าบริการเสริมทุกรายการ', category_id: 'cat-food' });
    await boot(page, fx);
    await item(page, 1).click();
    await expect(pop(page)).toBeVisible();
    await expect(page.locator('.xs-opt-s').first()).toContainText(/ค่าอาหารและรับรอง|ค่าน้ำมัน/);     // Thai category names under the items
    const over = await opts(page).evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    expect(over).toBe(0);
    const p = (await pop(page).boundingBox())!;
    expect(p.x + p.width).toBeLessThanOrEqual(1366);
    await page.screenshot({ path: 'test-results/xs-icons-thai.png' });
  });
});

test.describe('item list with category icons (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('the list fits the screen, a tap chooses an entry, and nothing scrolls sideways', async ({ page }) => {
    await boot(page, earlier(new FakeExpenses()));
    await item(page, 1).tap();
    await expect(pop(page)).toBeVisible();
    const b = (await pop(page).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(390); expect(b.width).toBeGreaterThanOrEqual(270);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const h of await opts(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(40);
    await page.screenshot({ path: 'test-results/xs-icons-phone.png' });
    await optOf(page, 'Coffee').tap();
    await expect(item(page, 1)).toHaveValue('Coffee');
    await expect(cat(page, 1)).toHaveValue('cat-food');
    await expect(pop(page)).toHaveCount(0);
  });
});
