// Recent orders / order again (FB-001002): the rules in src/shop/orderAgain.ts. The list itself is the customer's own orders from shop_my_orders (owner-scoped in the database).
import { describe, expect, it } from 'vitest';
import { addOrderItems } from '../../src/shop/cart';
import { FINISHED, isReorderable, newestFirst, recentAction, reorderPlan } from '../../src/shop/orderAgain';
import type { OrderItem, OrderStatus, ShopOrder } from '../../src/shop/api';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';

const item = (o: Partial<OrderItem> = {}): OrderItem => ({ line_no: 1, sku_code: 'FG-000001', name: 'Grape', unit: 'pc', unit_price: 320, qty: 1, line_total: 320, image_url: null, ...o });
const order = (status: OrderStatus, code: number, items: OrderItem[] = [item()], o: Partial<ShopOrder> = {}) =>
  ({ id: 'o-' + status, order_no: 'SO-1', status, items, invoice: { status_code: code }, created_at: '2026-11-20T10:00:00Z', ...o }) as unknown as ShopOrder;

describe('recentAction: one sensible button per order', () => {
  it('a finished order is ordered again', () => {
    for (const s of FINISHED) expect(recentAction(order(s, s === 'cancelled' ? 8 : 5)), s).toBe('again');
  });
  it('a running order that still needs a payment is paid, not repeated (no duplicate order)', () => {
    for (const code of [0, 1, 7, 9, 10]) expect(recentAction(order('new', code)), String(code)).toBe('pay');
  });
  it('a running order that does not need a payment is only viewed', () => {
    for (const s of ['confirmed', 'preparing', 'packed', 'ready', 'shipped'] as const) expect(recentAction(order(s, 5)), s).toBe('view');
    expect(recentAction(order('preparing', 3))).toBe('view');                       // a slip waits for the shop
  });
  it('a finished order with nothing that can be ordered again is only viewed', () => {
    expect(recentAction(order('completed', 5, [item({ unit_price: 0 })]))).toBe('view');
    expect(recentAction(order('cancelled', 8, []))).toBe('view');
  });
});

describe('reorderPlan: gift lines are left out and the customer is told', () => {
  it('keeps priced lines, counts the rest', () => {
    const p = reorderPlan([item(), item({ line_no: 2, sku_code: 'GIFT', unit_price: 0, line_total: 0 }), item({ line_no: 3, qty: 0 })]);
    expect(p.ok.map((i) => i.sku_code)).toEqual(['FG-000001']);
    expect(p.skipped).toBe(2);
    expect(isReorderable(item({ unit_price: 0.01 }))).toBe(true);
  });
  it('the cart merges what is already in it (quantities add up), it does not replace it', () => {
    const first = addOrderItems([], reorderPlan([item({ qty: 2 })]).ok);
    const again = addOrderItems(first.lines, reorderPlan([item({ qty: 3 }), item({ line_no: 2, sku_code: 'FG-000002', name: 'Mint', qty: 1 })]).ok);
    expect(again.added).toBe(2);
    expect(again.lines.find((l) => l.sku === 'FG-000001')!.qty).toBe(5);
    expect(again.lines).toHaveLength(2);
  });
});

describe('newestFirst', () => {
  it('sorts by time, then by order number, and does not touch the input', () => {
    const a = order('completed', 5, [item()], { id: 'a', order_no: 'SO-1', created_at: '2026-11-20T10:00:00Z' });
    const b = order('completed', 5, [item()], { id: 'b', order_no: 'SO-2', created_at: '2026-11-21T10:00:00Z' });
    const c = order('completed', 5, [item()], { id: 'c', order_no: 'SO-3', created_at: '2026-11-21T10:00:00Z' });
    const input = [a, b, c];
    expect(newestFirst(input).map((o) => o.id)).toEqual(['c', 'b', 'a']);
    expect(input.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('words', () => {
  it('every text exists in Thai and English; the partial message names both numbers', () => {
    for (const k of ['ro.title', 'ro.all', 'ro.empty', 'ro.error', 'ro.again', 'ro.pay', 'ro.view', 'ro.addedSome'] as const) {
      expect(SHOP_KEYS).toContain(k);
      expect(tr('th', k, { n: 2, skipped: 1 })).toMatch(/[ก-๿]/);
      expect(tr('en', k, { n: 2, skipped: 1 })).not.toMatch(/[ก-๿]/);
    }
    expect(tr('en', 'ro.addedSome', { n: 2, skipped: 1 })).toContain('2');
  });
});
