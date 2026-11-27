// Central receivables in the back office, in a real Chrome against a FAKE backend (fakeBackend.ts + the small fake of the central functions below). The fake follows
// the contracts that supabase/tests/central_receivables.sql proves against the real database (rolled back). THIS file proves the SCREENS: Receive payment links the
// local customer to a central customer (search, choose), sends that customer's older orders as central invoices, records a split payment (a transfer, then cash)
// against the server's balances with a new request key per payment, and a changed customer starts a fresh form. Without the migration the old local screen stays.
import { expect, test, type Page, type Route } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const HOST = 'hlvravynjalculvplrxc.supabase.co';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const SOMCHAI = 'cccccccc-0000-4000-8000-000000000001';

type Inv = { id: string; invoice_no: string; customer_id: string; amount: number; paid: number; pending: number; source_device: string; source_order_id: string; source_ref: string; issue_date: string; due_date: string; status: 'open' | 'cancelled' };
class FakeCentral {
  installed = true;
  customers = [{ id: SOMCHAI, code: 'ST00001', name: 'Somchai Central', phone: '0812345678', tax_id: null, has_app: false }];
  links: Record<string, string> = {};              // `${device}|${localId}` -> customer id
  invoices: Inv[] = [];
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  keys = new Map<string, unknown>();
  owing(cid: string) {
    const open = this.invoices.filter((i) => i.customer_id === cid && i.status === 'open');
    return { open_count: open.filter((i) => i.amount - i.paid > 0).length, outstanding: open.reduce((s, i) => s + i.amount - i.paid, 0), confirmed_pending: open.reduce((s, i) => s + i.pending, 0) };
  }
  cust(id: string) { const c = this.customers.find((x) => x.id === id)!; return { ...c, ...this.owing(id) }; }
  rpc(fn: string, a: Record<string, unknown>): { status: number; body: unknown } | null {
    if (!fn.startsWith('finance_customer') && !['finance_link_customer', 'finance_issue_order_invoice', 'finance_store_invoice_states', 'finance_receive_payment'].includes(fn)) return null;
    this.calls.push({ fn, args: a });
    if (!this.installed) return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache`, details: null, hint: null } };
    const err = (message: string) => ({ status: 400, body: { code: 'P0001', message, details: null, hint: null } });
    switch (fn) {
      case 'finance_customer_links_for': {
        const out: Record<string, unknown> = {};
        for (const id of a.p_local_ids as string[]) { const c = this.links[`${a.p_device}|${id}`]; if (c) out[id] = this.cust(c); }
        return { status: 200, body: out };
      }
      case 'finance_customer_search': return { status: 200, body: String(a.p_q).length < 2 ? [] : this.customers.map((c) => this.cust(c.id)) };
      case 'finance_link_customer': {
        if (!a.p_customer) return err('NAME_REQUIRED: not used in this test');
        this.links[`${a.p_device}|${a.p_local_id}`] = String(a.p_customer);
        return { status: 200, body: this.cust(String(a.p_customer)) };
      }
      case 'finance_issue_order_invoice': {
        const prev = this.invoices.find((i) => i.source_device === a.p_device && i.source_order_id === a.p_order_id && i.status === 'open');
        if (prev) return prev.amount === a.p_amount ? { status: 200, body: { invoice: prev, replay: true } } : err('ORDER_ALREADY_INVOICED: different amount');
        const inv: Inv = { id: `dddddddd-0000-4000-8000-${String(this.invoices.length + 1).padStart(12, '0')}`, invoice_no: `INV-${String(this.invoices.length + 101).padStart(6, '0')}`, customer_id: String(a.p_customer),
          amount: Number(a.p_amount), paid: 0, pending: 0, source_device: String(a.p_device), source_order_id: String(a.p_order_id), source_ref: String(a.p_order_no), issue_date: String(a.p_issue), due_date: String(a.p_due), status: 'open' };
        this.invoices.push(inv);
        return { status: 200, body: { invoice: inv, replay: false } };
      }
      case 'finance_customer_open_invoices': return { status: 200, body: { customer: this.cust(String(a.p_customer)), invoices: this.invoices.filter((i) => i.customer_id === a.p_customer && i.status === 'open' && i.amount - i.paid > 0).map((i) => ({
        id: i.id, invoice_no: i.invoice_no, issue_date: i.issue_date, due_date: i.due_date, amount: i.amount, description: `Store sale ${i.source_ref}`, source_ref: i.source_ref, origin: 'store',
        outstanding: i.amount - i.paid, confirmed_pending: i.pending, available: i.amount - i.paid - i.pending, status: 'unpaid' })) } };
      case 'finance_store_invoice_states': return { status: 200, body: this.invoices.filter((i) => i.source_device === a.p_device).map((i) => ({ order_id: i.source_order_id, invoice_id: i.id, invoice_no: i.invoice_no, customer_id: i.customer_id, amount: i.amount, status: i.status, outstanding: i.amount - i.paid, confirmed_pending: i.pending })) };
      case 'finance_receive_payment': {
        if (this.keys.has(String(a.p_key))) return { status: 200, body: { ...(this.keys.get(String(a.p_key)) as object), replay: true } };
        const allocs = a.p_allocations as { invoice: string; amount: number }[];
        const sum = Math.round(allocs.reduce((s, x) => s + x.amount, 0) * 100) / 100;
        if (sum !== a.p_amount) return err(`ALLOCATION_MISMATCH: the parts add up to ${sum} but the payment is ${a.p_amount}`);
        for (const x of allocs) {
          const i = this.invoices.find((v) => v.id === x.invoice)!;
          if (i.customer_id !== a.p_customer) return err('CUSTOMER_MISMATCH: invoice belongs to another customer');
          if (x.amount > i.amount - i.paid - i.pending + 0.001) return err(`EXCEEDS_OUTSTANDING: ${x.amount} is more than what is left`);
        }
        for (const x of allocs) { const i = this.invoices.find((v) => v.id === x.invoice)!; if (a.p_post) i.paid += x.amount; else i.pending += x.amount; }
        const body = { customer_id: a.p_customer, replay: false, parts: allocs.map((x, k) => ({ evidence_id: `e-${k}`, invoice_id: x.invoice, amount: x.amount, status: 'confirmed' })), posted: a.p_post ? allocs.map((x, k) => ({ evidence_id: `e-${k}`, receipt_no: `PAY-${k}` })) : [], owing: this.owing(String(a.p_customer)) };
        this.keys.set(String(a.p_key), body);
        return { status: 200, body };
      }
      default: return null;
    }
  }
  async install(page: Page) {
    await page.route(`https://${HOST}/rest/v1/rpc/**`, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const fn = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
      let args: Record<string, unknown> = {}; try { args = JSON.parse(req.postData() || '{}'); } catch { /* none */ }
      const r = this.rpc(fn, args);
      if (!r) return route.fallback();
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: JSON.stringify(r.body) });
    });
  }
}

async function boot(page: Page, o: { installed?: boolean } = {}) {
  const shop = new FakeShop();
  shop.profile.role = 'SUPER_ADMIN'; shop.profile.display_name = 'Owner';
  const fc = new FakeCentral(); fc.installed = o.installed ?? true;
  await shop.install(page); await fc.install(page);
  await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  return { fc, errors };
}
const money = (s: string) => Number(s.replace(/[^0-9.]/g, ''));
/** The test's local database starts empty: two customers, one product and two POS sales left on account for the first customer (through the real domain code):
 *  one from yesterday (before central receivables began here) and one new. */
async function seedCreditSales(page: Page) {
  await page.evaluate(async () => {
    const st = await import('/src/domain/store.ts');
    const ord = await import('/src/domain/orders.ts');
    const inv = await import('/src/domain/inventory.ts');
    st.act((d, c) => {
      const cust = (id: string, name: string, phone: string) => ({ id, code: id, name, phone, group: 'retail' as const, creditLimit: 100000, creditDays: 30, consent: { pdpa: true, marketing: false, at: c.now }, createdAt: c.now });
      d.customers.push(cust('CUS-E2E-1', 'Somchai Local', '0812345678'), cust('CUS-E2E-2', 'Other Local', '0899999999'));
      d.products.push({ id: 'P-E2E', sku: 'FG-E2E-1', name: 'Test item', category: 'Test', kind: 'resale', unit: 'pc', price: 350, channelPrices: {}, active: true, emoji: '', color: '#888', stdCost: 100, levels: {}, mediaIds: [] });
      inv.adjustStock(d, c, { productId: 'P-E2E', warehouseId: d.branches.find((b) => b.id === 'B2')!.defaultWarehouseId, qty: 10, reason: 'e2e stock', kind: 'adjust' } as never);
      const ids = [2, 1].map((qty) => ord.createOrder(d, c, { channel: 'POS', branchId: 'B2', customerId: 'CUS-E2E-1', lines: [{ productId: 'P-E2E', qty }], payments: [], skipStockCheck: true, skipPromotions: true } as never));
      // the first sale is from before central receivables began on this device (sent only on request); the second is new (sent automatically once linked)
      d.orders.find((o) => o.id === ids[0])!.createdAt = new Date(Date.now() - 86_400_000).toISOString();
    });
  });
}

test('Receive payment through the central ledger: link the customer, send older orders, a transfer then cash, fresh form for another customer', async ({ page }) => {
  const { fc, errors } = await boot(page);
  await page.goto('/#/receivables');
  await expect(page.getByRole('tab', { name: /Central ledger/ })).toBeVisible();
  await seedCreditSales(page);
  const first = page.locator('table tbody tr').first();
  const localName = (await first.locator('td').first().locator('b').innerText()).trim();
  await first.getByRole('button', { name: 'Receive' }).click();
  const modal = page.getByTestId('central-receive');
  // not linked yet: search finds the central customer; choose it
  await expect(modal.getByTestId('link-customer')).toBeVisible();
  await modal.getByRole('button', { name: 'This is the customer' }).click();
  await expect(modal.getByTestId('central-payment-form')).toContainText('Somchai Central');
  await expect.poll(() => fc.invoices.length).toBe(1);                                        // the new sale went by itself once the customer was linked
  expect(fc.calls.find((c) => c.fn === 'finance_link_customer')!.args).toMatchObject({ p_customer: SOMCHAI, p_local_name: localName });
  // the customer's older orders on this device are offered, then sent as central invoices
  await expect(modal.getByTestId('older-orders')).toBeVisible();
  await modal.getByRole('button', { name: 'Send them to the central ledger' }).click();
  await expect(modal.getByTestId('older-orders')).toHaveCount(0);
  await expect.poll(() => fc.invoices.length).toBe(2);
  expect(fc.invoices[1].amount).toBe(700);                                                   // the old sale: 2 x 350
  const owed = Math.round(fc.invoices.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const form = modal.getByTestId('central-payment-form');
  await expect(form.getByRole('spinbutton', { name: 'Amount received (฿)' })).toHaveValue(String(owed));

  // part 1: a transfer of 100 (oldest invoice first), needs the bank reference
  await form.getByRole('spinbutton', { name: 'Amount received (฿)' }).fill('100');
  await expect(form.getByTestId('central-receive-submit')).toBeDisabled();
  await form.getByRole('textbox', { name: 'Bank transaction reference' }).fill('BANKREF123456');
  await form.getByTestId('central-receive-submit').click();
  await expect(form).toContainText('recorded and posted');
  const p1 = fc.calls.filter((c) => c.fn === 'finance_receive_payment')[0].args;
  expect(p1).toMatchObject({ p_customer: SOMCHAI, p_method: 'transfer', p_amount: 100, p_ref: 'BANKREF123456', p_post: true });
  expect(p1.p_allocations).toEqual([{ invoice: fc.invoices[1].id, amount: 100 }]);          // oldest first: yesterday's sale, although it was invoiced second

  // part 2: the rest in cash; the form now offers what the server says is left, and needs where the cash was received
  const left = Math.round((owed - 100) * 100) / 100;
  await expect(form.getByRole('spinbutton', { name: 'Amount received (฿)' })).toHaveValue(String(left));
  await form.getByText('Cash', { exact: true }).click();
  await expect(form.getByTestId('central-receive-submit')).toBeDisabled();
  await form.getByRole('textbox', { name: 'Where was the cash received?' }).fill('Counter 1');
  await form.getByTestId('central-receive-submit').click();
  await expect(form).toContainText('Nothing left to receive');
  const p2 = fc.calls.filter((c) => c.fn === 'finance_receive_payment')[1].args;
  expect(p2).toMatchObject({ p_customer: SOMCHAI, p_method: 'cash', p_amount: left, p_note: 'Counter 1', p_ref: null });
  expect(p2.p_key).not.toBe(p1.p_key);                                                    // a second payment, not a retry of the first

  // another customer: nothing of Somchai's form is carried over
  const sel = modal.getByRole('combobox', { name: 'Customer' });
  const other = await sel.locator('option').evaluateAll((os, name) => (os as HTMLOptionElement[]).find((o) => o.value && !o.textContent!.startsWith(name as string))!.value, localName);
  await sel.selectOption(other);
  await expect(modal.getByTestId('central-payment-form')).toHaveCount(0);
  await expect(modal.getByTestId('link-customer')).toBeVisible();
  expect(errors).toEqual([]);
  expect(money('0')).toBe(0);
});

test('without the migration the Receivables page keeps the local screen (no Central ledger tab, old Post receipt)', async ({ page }) => {
  const { errors } = await boot(page, { installed: false });
  await page.goto('/#/receivables');
  await expect(page.getByRole('heading', { name: 'Receivables & payments' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByRole('tab', { name: /Central ledger/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Receive payment' }).click();
  await expect(page.locator('.modal').getByRole('button', { name: /Post receipt/ })).toBeVisible();
  expect(errors).toEqual([]);
});
