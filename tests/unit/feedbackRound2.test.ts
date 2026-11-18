// Feedback round 2 (FB-001001 … FB-001022): tests for the changes that came out of it.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PAGE_META, pageMetaFor } from '../../src/domain/meta';
import { errorToastText, thaiForError } from '../../src/lib/errorText';
import { addOrderItems, type CartLine } from '../../src/shop/cart';
import { TimeoutError, withTimeout } from '../../src/shop/timeout';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('feedback context: every back-office page is known (9 of the 12 reports were filed as "NOT AVAILABLE")', () => {
  // the paths that exist in the router and in the sidebar
  const routes = [...read('src/App.tsx').matchAll(/<Route path="([a-z][a-z-]*(?:\/[a-z-]+)?)" element=\{<G /g)].map((m) => `/${m[1]}`);
  const sidebar = [...read('src/ui/Shell.tsx').matchAll(/to: '(\/[a-z][a-z/-]*)/g)].map((m) => m[1]);

  it('finds the routes it is checking', () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(sidebar.length).toBeGreaterThan(20);
  });
  it('every guarded route and every sidebar link has a page name and a module', () => {
    const missing = [...new Set([...routes, ...sidebar])].filter((p) => pageMetaFor(p).page === 'NOT AVAILABLE');
    expect(missing).toEqual([]);
  });
  it('the two pages from the reports are named', () => {
    expect(pageMetaFor('/payment-review')).toMatchObject({ page: 'Payment review', module: 'receivables' });
    expect(pageMetaFor('/shop-admin')).toMatchObject({ page: 'Online shop', module: 'orders' });
  });
  it('an unknown path still falls back instead of throwing', () => {
    expect(pageMetaFor('/does-not-exist').page).toBe('NOT AVAILABLE');
    expect(Object.keys(PAGE_META)).toContain('/payments');
  });
});

describe('error alerts: Thai and English together (FB-001004, FB-001020)', () => {
  it('a duplicate slip is explained in Thai under the English text, in either UI language', () => {
    const en = 'This slip was already submitted';
    expect(errorToastText('th', en).split('\n')).toEqual([thaiForError(en), en]);
    expect(errorToastText('en', en).split('\n')).toEqual([en, thaiForError(en)]);
    expect(thaiForError(en)).toContain('สลิป');
  });
  it('keeps the variable part of a message (bank reference, status)', () => {
    expect(thaiForError('Bank transaction 0123456789 was already recorded (reused slip?)')).toContain('0123456789');
    expect(thaiForError('This invoice is paid')).toContain('ชำระแล้ว');
    expect(thaiForError('This slip is already verified')).toContain('ยืนยันแล้ว');
  });
  it('covers the slip rules the database enforces', () => {
    for (const m of [
      'The transfer time is in the future', 'The transfer is older than the invoice', 'The transfer is older than the deposit request',
      'Several slips for this invoice are already waiting to be checked', 'Only JPG, PNG or PDF files are accepted', 'The file must be 5 MB or smaller',
      'Invalid file', 'The bank transaction reference is required', 'The transfer date and time are required', 'Enter the amount shown by the bank',
    ]) expect(thaiForError(m), m).toBeTruthy();
  });
  it('a lost connection is explained, including the one our own time limit raises', () => {
    expect(thaiForError('Failed to fetch')).toContain('อินเทอร์เน็ต');
    expect(thaiForError(new TimeoutError(60000).message)).toContain('อินเทอร์เน็ต');
  });
  it('an unknown message is left exactly as it was, and a Thai one is never doubled', () => {
    expect(errorToastText('en', 'Something nobody has seen before')).toBe('Something nobody has seen before');
    expect(errorToastText('th', 'Something nobody has seen before')).toBe('Something nobody has seen before');
    expect(errorToastText('th', 'สลิปซ้ำ')).toBe('สลิปซ้ำ');
    expect(thaiForError('')).toBeNull();
  });
  it('the rules match the exact wording the migrations raise (a reworded SQL message must not silently lose its Thai)', () => {
    const sql = read('supabase/migrations/20261114190000_finance_ar_payments.sql') + read('supabase/migrations/20261115200000_wallet_payments.sql');
    const raised = [...sql.matchAll(/raise exception '([^']+)'/g)].map((m) => m[1].replace(/%/g, 'x'));
    const slipRelated = raised.filter((m) => /slip|transfer|bank transaction|invoice is|invalid file/i.test(m));
    // machine codes (SLIP_ALREADY_USED, …) are translated by the shop itself (shop/i18n.ts 'we.*' and shop/ui.tsx errText), not by this table
    const CODE = /^[A-Z][A-Z_]{2,}(?::|$)/;
    const prose = slipRelated.filter((m) => !CODE.test(m));
    expect(prose.length).toBeGreaterThan(5);
    for (const m of prose) expect(thaiForError(m), m).toBeTruthy();
    const shopI18n = read('src/shop/i18n.ts');
    for (const m of slipRelated.filter((x) => CODE.test(x))) expect(shopI18n, m).toContain(`'we.${m.split(':')[0]}'`);
  });
});

describe('order again (FB-001002)', () => {
  const item = (sku: string, qty: number, price = 100) => ({ sku_code: sku, name: `Item ${sku}`, unit_price: price, qty, image_url: null as string | null });
  const line = (sku: string, qty: number): CartLine => ({ sku, qty, name: sku, price: 1, image: null, max: null });

  it('puts every item of a cancelled order into an empty cart with the same quantities', () => {
    const r = addOrderItems([], [item('A', 2), item('B', 5)]);
    expect(r.added).toBe(2);
    expect(r.lines.map((l) => [l.sku, l.qty])).toEqual([['A', 2], ['B', 5]]);
  });
  it('merges into a line that is already in the cart instead of duplicating it', () => {
    const r = addOrderItems([line('A', 1)], [item('A', 2)]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].qty).toBe(3);
  });
  it('never goes above 99 of one item, and does not mutate the cart it was given', () => {
    const before = [line('A', 98)];
    const r = addOrderItems(before, [item('A', 50)]);
    expect(r.lines[0].qty).toBe(99);
    expect(before[0].qty).toBe(98);
  });
  it('reports 0 when the cart is full (40 lines) and the items are new', () => {
    const full = Array.from({ length: 40 }, (_, i) => line(`S${i}`, 1));
    expect(addOrderItems(full, [item('NEW', 1)]).added).toBe(0);
  });
  it('the price it stores is only a display snapshot (the cart page re-quotes with the server)', () => {
    expect(read('src/shop/cart.ts')).toContain('display snapshot');
    expect(read('src/shop/CartPage.tsx')).toContain('toQuoteItems(lines)');
  });
  it('its three messages exist in Thai and English', () => {
    const i18n = read('src/shop/i18n.ts');
    for (const k of ['od.again', 'od.againDone', 'od.againNone']) expect(i18n, k).toMatch(new RegExp(`'${k.replace('.', '\\.')}': \\['[^']*[\\u0E00-\\u0E7F][^']*', '[A-Za-z]`));
  });
});

describe('a stalled connection can no longer freeze the checkout (FB-001019)', () => {
  it('returns the result of a call that finishes in time', async () => {
    await expect(withTimeout(async () => 42, 1000)).resolves.toBe(42);
  });
  it('rejects with TimeoutError when the call never settles, and aborts the signal it gave the call', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const p = withTimeout((s) => { signal = s; return new Promise<never>(() => { /* never settles */ }); }, 5000);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
  it('passes a real failure through unchanged and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(async () => { throw new Error('boom'); }, 5000)).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it('the shop calls use it: reads 25 s, placing an order 45 s, and a timeout is a retryable NETWORK error', () => {
    const api = read('src/shop/api.ts');
    expect(api).toContain('READ_TIMEOUT_MS = 25_000');
    expect(api).toContain('WRITE_TIMEOUT_MS = 45_000');
    expect(api).toMatch(/e instanceof TimeoutError \? 'timeout'[^;]*'NETWORK'/);
    expect(api).toMatch(/shop_place_order[\s\S]{1,900}WRITE_TIMEOUT_MS\)/);
  });
  it('retrying after a timeout cannot create a second order: the checkout carries an idempotency key', () => {
    const sql = read('supabase/migrations/20261115100000_customer_shop.sql');
    expect(sql).toContain('pg_advisory_xact_lock(hashtextextended(uid::text');   // serialises retries of the same key
    expect(sql).toContain("raise exception 'KEY_REUSED'");
  });
});

describe('product switch (FB-001005)', () => {
  it('turns a product on or off at once, with no confirmation dialog, and still records an audit entry', () => {
    const src = read('src/pages/Products.tsx');
    const fn = src.slice(src.indexOf('function ProductStatus'), src.indexOf('function rollupPerUnit'));
    expect(fn).not.toContain('confirm(');
    expect(fn).toContain('setProductActive(d, c, p.id, next)');
    expect(read('src/domain/master.ts')).toMatch(/audit\(d, ctx, 'product\.status'/);
  });
});

describe('online shop orders on the Orders page (FB-001013)', () => {
  const card = read('src/shop/OnlineOrdersCard.tsx');
  it('is mounted on the Orders page, and only reads', () => {
    expect(read('src/pages/Orders.tsx')).toContain('<OnlineOrdersCard />');
    for (const writer of ['setStatus', 'saveSettings', 'saveContent', 'cancelMyOrder', 'placeOrder']) expect(card, writer).not.toContain(writer);
    expect(card).toContain('shopAdmin.orders({ limit: LATEST })');
  });
  it('is hidden in the demo business and for people who may not see the shop orders', () => {
    expect(card).toContain('DEMO_SEED');
    expect(card).toMatch(/e\.code === 'FORBIDDEN'\) setHidden\(true\)/);
  });
  it('every string it shows has a Thai translation in the dictionary the app really uses', async () => {
    const { t: translate } = await import('../../src/lib/i18n');       // the merged dictionary (back office + shop + feedback)
    const strings = [...card.matchAll(/T\('([^']+)'/g)].map((m) => m[1]);
    expect(strings.length).toBeGreaterThan(8);
    for (const s of strings) expect(translate('th', s), s).not.toBe(s);
  });
});

describe('brand filter: products with no brand (FB-001018)', () => {
  const orig = read('supabase/migrations/20261115100000_customer_shop.sql');
  const mig = read('supabase/migrations/20261119100000_shop_no_brand_filter.sql');
  const down = read('supabase/rollbacks/20261119100000_shop_no_brand_filter_down.sql');
  const fns = (sql: string) => sql.slice(sql.indexOf('create or replace function public.shop_facets'), sql.indexOf('create or replace function public.shop_product')).replace(/\r/g, '').trim();
  const code = (sql: string) => sql.replace(/\r/g, '').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('the migration only replaces shop_facets and shop_catalog: no table, column, policy, grant or data is touched', () => {
    const body = code(mig);
    expect([...body.matchAll(/create or replace function ([\w.]+)/g)].map((m) => m[1])).toEqual(['public.shop_facets', 'public.shop_catalog']);
    expect(body).not.toMatch(/\b(alter|drop|truncate|grant|revoke)\b|create (table|index|policy|trigger|view)|insert into|update public\.|delete from/i);
  });
  it('it changes the two functions in exactly two places', () => {
    const a = new Set(fns(orig).split('\n').map((l) => l.trimEnd())); const b = fns(mig).split('\n').map((l) => l.trimEnd());
    const added = b.filter((l) => !a.has(l));
    expect(added).toHaveLength(3);                                                      // the closing of 'brands', the new 'no_brand_count' key, the brand condition
    expect(added.join('\n')).toContain("'no_brand_count'");
    expect(added.join('\n')).toContain("case when p_brand = '__none__' then v.brand is null else v.brand = p_brand end");
    expect(new Set(b).size).toBeGreaterThan(40);
  });
  it('its rollback puts back the two ORIGINAL functions, character for character', () => {
    expect(fns(down)).toBe(fns(orig));
    expect(code(down)).not.toMatch(/no_brand_count|__none__/);
  });
  it('the app and the database use the same marker, and the app copes with a database that does not send the count', () => {
    expect(read('src/shop/api.ts')).toContain("export const NO_BRAND = '__none__'");
    expect(mig).toContain("'__none__'");
    expect(read('src/shop/Catalog.tsx')).toContain('facets?.no_brand_count ?? 0');
  });
  it('the SQL tests end in the forced rollback the runner insists on, and the runner scripts point at the right files', () => {
    expect(read('supabase/tests/shop_no_brand.sql')).toMatch(/raise exception E'SHOP_NO_BRAND_TESTS/);
    expect(read('supabase/tests/shop_brand_down_post.sql')).toMatch(/raise exception E'SHOP_NO_BRAND_DOWN_PROOF/);
    expect(read('scripts/run-shop-no-brand-sql-tests.sh')).toContain('SHOP_NO_BRAND_TESTS supabase/migrations/20261119100000_shop_no_brand_filter.sql supabase/tests/shop_no_brand.sql');
    expect(read('scripts/run-shop-no-brand-down-proof.sh')).toContain('supabase/rollbacks/20261119100000_shop_no_brand_filter_down.sql');
  });
  it('the new choice has Thai and English wording', () => {
    expect(read('src/shop/i18n.ts')).toMatch(/'cat\.noBrand': \['ไม่ระบุแบรนด์', 'No brand'\]/);
  });
});
