import { describe, expect, it } from 'vitest';
import { addLine, attemptKey, cartCount, clampQty, forgetAttempt, MAX_LINES, MAX_QTY, parseStored, removeLine, setLineQty, toQuoteItems, type CartLine, type CartSource } from '../../src/shop/cart';
import { baht, digits, packLabel, validPhone } from '../../src/shop/format';
import { ShopError } from '../../src/shop/api';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';
import { ORDER_TONE, orderSteps, PAY_LABEL } from '../../src/shop/ui';
import { CANCEL_CODES, OPEN_CODES, payNotes } from '../../src/shop/pay';
import { STATUS } from '../../src/finance/api';
import { ALWAYS_VISIBLE, CORE_OF, defaultLayout, normalizeLayout, PAGE_TABS, validateLayout } from '../../src/devapp/schema';

const item = (sku: string, over: Partial<CartSource> = {}): CartSource => ({ sku_code: sku, name: sku + ' name', price: 100, image_url: null, max_qty: null, ...over });
const kv = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

describe('cart', () => {
  it('adds, merges and clamps quantities', () => {
    let l: CartLine[] = [];
    l = addLine(l, item('A'), 2); l = addLine(l, item('A'), 3); l = addLine(l, item('B'));
    expect(l.map((x) => [x.sku, x.qty])).toEqual([['A', 5], ['B', 1]]);
    expect(cartCount(l)).toBe(6);
    expect(clampQty(1000)).toBe(MAX_QTY); expect(clampQty(0)).toBe(1); expect(clampQty(NaN)).toBe(1); expect(clampQty(2.9)).toBe(2);
  });
  it('never goes above a per-order limit, also when adding again', () => {
    let l = addLine([], item('A', { max_qty: 3 }), 2);
    l = addLine(l, item('A', { max_qty: 3 }), 5);
    expect(l[0].qty).toBe(3);
    expect(setLineQty(l, 'A', 50)[0].qty).toBe(3);
  });
  it('setting a quantity below 1 removes the line; remove drops it', () => {
    const l = addLine(addLine([], item('A')), item('B'));
    expect(setLineQty(l, 'A', 0).map((x) => x.sku)).toEqual(['B']);
    expect(removeLine(l, 'B').map((x) => x.sku)).toEqual(['A']);
  });
  it('holds at most MAX_LINES different products', () => {
    let l: CartLine[] = [];
    for (let i = 0; i < MAX_LINES + 5; i++) l = addLine(l, item('S' + i));
    expect(l).toHaveLength(MAX_LINES);
  });
  it('what is sent to the server is only SKU + quantity: never a price or total', () => {
    const l = addLine([], item('A', { price: 1 }), 2);
    expect(toQuoteItems(l)).toEqual([{ sku_code: 'A', qty: 2 }]);
    expect(JSON.stringify(toQuoteItems(l))).not.toMatch(/price|total|name/);
  });
  it('a stored cart that was tampered with or is corrupted cannot break the app', () => {
    expect(parseStored(null)).toEqual([]); expect(parseStored('not json')).toEqual([]); expect(parseStored('{"a":1}')).toEqual([]);
    const bad = JSON.stringify([
      { sku: 'OK', qty: 2, name: 'n', price: 5, image: 'https://x.test/a.png', max: 3 },
      { sku: 'OK', qty: 1 },                                   // duplicate
      { sku: '', qty: 1 }, { sku: 'NEG', qty: -1 }, { sku: 'BIG', qty: 1000 }, { sku: 'FRAC', qty: 1.5 }, { sku: 'STR', qty: '2' },
      { sku: 'IMG', qty: 1, image: 'javascript:alert(1)', price: -4 }, null, 7,
    ]);
    const l = parseStored(bad);
    expect(l.map((x) => x.sku)).toEqual(['OK', 'IMG']);
    expect(l[0].qty).toBe(2); expect(l[1].image).toBeNull(); expect(l[1].price).toBe(0);
  });
});

describe('checkout idempotency key', () => {
  it('the same checkout keeps the same key (retry, double tap, reload); a different checkout gets a new one', () => {
    const s = kv(); let n = 0; const gen = () => `key-${++n}-xxxxxxxx`;
    const a = attemptKey(s, 'u1', 'P1', gen);
    expect(attemptKey(s, 'u1', 'P1', gen)).toBe(a);
    expect(attemptKey(s, 'u1', 'P2', gen)).not.toBe(a);          // the customer changed the cart
    expect(n).toBe(2);
  });
  it('keys are per customer and are forgotten after a successful order', () => {
    const s = kv(); let n = 0; const gen = () => `key-${++n}-xxxxxxxx`;
    const a = attemptKey(s, 'u1', 'P', gen); const b = attemptKey(s, 'u2', 'P', gen);
    expect(a).not.toBe(b);
    forgetAttempt(s, 'u1');
    expect(attemptKey(s, 'u1', 'P', gen)).not.toBe(a);
  });
  it('a damaged stored value is replaced by a valid key', () => {
    const s = kv(); s.setItem('tc.shop.attempt:u1', '{"key":"x","payload":"P"}');   // too short for the server's rule
    expect(attemptKey(s, 'u1', 'P')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    s.setItem('tc.shop.attempt:u1', 'garbage');
    expect(attemptKey(s, 'u1', 'P')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
  it('still works when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
    expect(attemptKey(broken, 'u1', 'P')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('formatting and validation', () => {
  it('baht shows whole baht without decimals and satang when present', () => {
    expect(baht(320)).toBe('฿320'); expect(baht(1010)).toBe('฿1,010'); expect(baht(1010.5)).toBe('฿1,010.50'); expect(baht(null)).toBe('฿0');
  });
  it('size label from pack quantity and unit', () => { expect(packLabel(6000, 'คำ')).toBe('6,000 คำ'); expect(packLabel(null, 'คำ')).toBe(''); expect(packLabel(60, null)).toBe(''); });
  it('Thai mobile numbers as people type them', () => {
    expect(digits('081-234-5678')).toBe('0812345678');
    expect(validPhone('081-234-5678')).toBe(true); expect(validPhone('0212345678')).toBe(true);
    expect(validPhone('123')).toBe(false); expect(validPhone('+66812345678')).toBe(false); expect(validPhone('')).toBe(false);
  });
});

describe('customer-facing text', () => {
  const keys = SHOP_KEYS;
  it('every text exists in Thai and English with the same placeholders', () => {
    for (const k of keys) {
      const th = tr('th', k), en = tr('en', k);
      expect(th.length, k).toBeGreaterThan(0); expect(en.length, k).toBeGreaterThan(0);
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(th), k).toBe(ph(en));
    }
  });
  it('placeholders are filled', () => { expect(tr('th', 'cat.count', { n: 47 })).toBe('พบ 47 รายการ'); expect(tr('en', 'p.maxPer', { n: 2 })).toBe('Up to 2 per order'); });
  it('payment statuses: every finance status code has a customer label, and "paid" is only code 5', () => {
    for (const code of Object.keys(STATUS).map(Number) as (keyof typeof STATUS)[]) { expect(PAY_LABEL[code], String(code)).toBeDefined(); expect(keys).toContain(PAY_LABEL[code].k); }
    for (const [c, v] of Object.entries(PAY_LABEL)) if (v.k === 'pay.paid') expect(Number(c)).toBe(5);
  });
  it('slip review copy: the four new pay.* texts are exactly the agreed Thai and English', () => {
    expect(tr('th', 'pay.pending')).toBe('รอตรวจสอบการชำระเงิน – รอเจ้าหน้าที่ยืนยัน');
    expect(tr('en', 'pay.pending')).toBe('Pending payment verification – awaiting staff confirmation');
    expect(tr('th', 'pay.moreEvidence')).toBe('ร้านขอหลักฐานการชำระเพิ่มเติม');
    expect(tr('en', 'pay.moreEvidence')).toBe('The shop asked for more payment evidence');
    expect(tr('th', 'pay.confirmedNote', { amount: '฿320' })).toBe('ร้านยืนยันยอด ฿320 แล้ว กำลังบันทึก');
    expect(tr('en', 'pay.confirmedNote', { amount: '฿320' })).toBe('The shop confirmed ฿320; it is being recorded');
    expect(tr('th', 'pay.remaining', { paid: '฿200', left: '฿150' })).toBe('ชำระแล้ว ฿200 · คงเหลือ ฿150');
    expect(tr('en', 'pay.remaining', { paid: '฿200', left: '฿150' })).toBe('Paid ฿200 · remaining ฿150');
  });
  it('every pay.* key exists in Thai and in English, with the same placeholders, and the new ones are all there', () => {
    const pay = keys.filter((k) => k.startsWith('pay.'));
    expect(pay).toEqual(expect.arrayContaining(['pay.unpaid', 'pay.pending', 'pay.partial', 'pay.paid', 'pay.review', 'pay.rejected', 'pay.cancelled', 'pay.moreEvidence', 'pay.confirmedNote', 'pay.remaining']));
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of pay) { const th = tr('th', k), en = tr('en', k); expect(th.trim().length, k).toBeGreaterThan(0); expect(en.trim().length, k).toBeGreaterThan(0); expect(ph(th), k).toBe(ph(en)); expect(/[฀-๿]/.test(th), `${k} is Thai`).toBe(true); }
  });
  it('payment states: all ten codes have a label in both languages; 10 is "the shop asked for more evidence" (warn), 3 is the pending text, and only 5 says paid', () => {
    for (const code of [0, 1, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
      const l = PAY_LABEL[code]; expect(l, String(code)).toBeDefined(); expect(keys).toContain(l.k);
      expect(tr('th', l.k).length, `${code} th`).toBeGreaterThan(0); expect(tr('en', l.k).length, `${code} en`).toBeGreaterThan(0);
    }
    expect(PAY_LABEL[10]).toEqual({ k: 'pay.moreEvidence', tone: 'warn' });
    expect(PAY_LABEL[3].k).toBe('pay.pending');
    expect(PAY_LABEL[10].k).not.toBe(PAY_LABEL[3].k);                                  // the stand-in that reused the pending text is gone
    for (const [c, v] of Object.entries(PAY_LABEL)) if (v.k === 'pay.paid') expect(Number(c), v.k).toBe(5);
    expect(tr('th', 'pay.pending')).not.toContain('ชำระแล้ว'); expect(tr('en', 'pay.pending')).not.toMatch(/\bpaid\b/i);
  });
  it('a state code an older app build does not know falls back to a label instead of crashing (PAY_LABEL is looked up with a default)', () => {
    expect((PAY_LABEL as Record<number, unknown>)[99]).toBeUndefined();                // PayBadge reads PAY_LABEL[code] ?? PAY_LABEL[0]
    expect(PAY_LABEL[0]).toBeDefined();
  });
  it('paid / remaining and confirmed notes come from the invoice, in the customer\'s language', () => {
    const inv = (o: Partial<Parameters<typeof payNotes>[0]>) => ({ paid: 0, outstanding: 350, status_code: 0 as const, confirmed_pending: 0, ...o });
    expect(payNotes(inv({ paid: 200, outstanding: 150, status_code: 4 }), 'th')).toEqual({ remaining: 'ชำระแล้ว ฿200 · คงเหลือ ฿150', confirmed: null });
    expect(payNotes(inv({ paid: 200, outstanding: 150, status_code: 3 }), 'en')).toEqual({ remaining: 'Paid ฿200 · remaining ฿150', confirmed: null });
    expect(payNotes(inv({ paid: 200.5, outstanding: 149.5, status_code: 3, confirmed_pending: 149.5 }), 'en')).toEqual({ remaining: 'Paid ฿200.50 · remaining ฿149.50', confirmed: 'The shop confirmed ฿149.50; it is being recorded' });
    expect(payNotes(inv({ status_code: 3, confirmed_pending: 320 }), 'th')).toEqual({ remaining: null, confirmed: 'ร้านยืนยันยอด ฿320 แล้ว กำลังบันทึก' });
    expect(payNotes(inv({}), 'th')).toEqual({ remaining: null, confirmed: null });                                      // nothing paid, nothing confirmed
    expect(payNotes(inv({ paid: 350, outstanding: 0, status_code: 5 }), 'th')).toEqual({ remaining: null, confirmed: null });   // fully paid: no "remaining"
    expect(payNotes(inv({ paid: 100, outstanding: 250, status_code: 8 }), 'th')).toEqual({ remaining: null, confirmed: null });   // a cancelled invoice says nothing about what is left
    expect(payNotes({ paid: 0, outstanding: 350, status_code: 3 }, 'th')).toEqual({ remaining: null, confirmed: null });          // an older database: no confirmed_pending at all
  });
  it('the customer can cancel only when nothing waits on the shop; the payment panel opens by itself when there is something to do', () => {
    expect([...CANCEL_CODES]).toEqual([0, 1, 7, 9]);
    for (const c of [3, 4, 5, 6, 8, 10]) expect(CANCEL_CODES, String(c)).not.toContain(c);        // 3 slip pending (also a confirmed one) and 10 more evidence requested: no self-cancel
    expect([...OPEN_CODES]).toEqual([0, 1, 7, 9, 10]);
    for (const c of [3, 4, 5, 6, 8]) expect(OPEN_CODES, String(c)).not.toContain(c);
  });
  it('every order status has a label and a tone, and the steps end in "completed"', () => {
    for (const s of ['new', 'confirmed', 'preparing', 'packed', 'ready', 'shipped', 'completed', 'cancelled', 'returned'] as const) { expect(keys).toContain(`st.${s}`); expect(ORDER_TONE[s]).toBeDefined(); }
    expect(orderSteps('delivery')).toEqual(['new', 'confirmed', 'preparing', 'packed', 'shipped', 'completed']);
    expect(orderSteps('pickup')).toEqual(['new', 'confirmed', 'preparing', 'packed', 'ready', 'completed']);
  });
  it('a failed call carries the database reason code', () => { const e = new ShopError('PRICE_CHANGED', 'PRICE_CHANGED', '450'); expect(e.code).toBe('PRICE_CHANGED'); expect(e.detail).toBe('450'); });
});

describe('DEV APP layouts and the shop', () => {
  it('the cart is a page of its own with its own core block, like every other tab', () => {
    expect(PAGE_TABS).toContain('cart'); expect(CORE_OF.cart).toBe('cartCore');
    const c = defaultLayout(); expect(c.pages.cart.map((s) => s.type)).toEqual(['cartCore']);
    expect(validateLayout(c)).toEqual([]);
  });
  it('shop, cart, orders and profile cannot be hidden by a layout: ordering and paying must always work', () => {
    expect(ALWAYS_VISIBLE).toEqual(expect.arrayContaining(['home', 'shop', 'cart', 'pay', 'profile']));
    for (const key of ['shop', 'cart', 'pay'] as const) {
      const c = defaultLayout(); c.nav.find((n) => n.key === key)!.visible = false;
      expect(validateLayout(c).some((i) => i.message.includes(`${key} tab`)), key).toBe(true);
      expect(validateLayout(normalizeLayout(c)), key).toEqual([]);   // normalizing repairs it
    }
  });
  it('a layout saved before the cart existed gets a visible cart tab and its page', () => {
    const old = JSON.parse(JSON.stringify(defaultLayout())) as ReturnType<typeof defaultLayout>;
    old.nav = old.nav.filter((n) => n.key !== 'cart'); delete (old.pages as Record<string, unknown>).cart;
    expect(validateLayout(old)).toEqual([]);
    const n = normalizeLayout(old);
    expect(n.nav.find((x) => x.key === 'cart')?.visible).toBe(true);
    expect(n.pages.cart.map((s) => s.type)).toEqual(['cartCore']);
    expect(validateLayout(n)).toEqual([]);
  });
  it('loyalty tabs stay optional (hidden by default) so the default app is the shop', () => {
    const c = defaultLayout();
    expect(c.nav.filter((n) => n.visible).map((n) => n.key)).toEqual(['home', 'shop', 'cart', 'pay', 'profile']);
  });
});
