// Recent orders (FB-001002): which action a recent order offers, and which of its lines can be ordered again. Pure rules, no screen: tests/unit/orderAgain.test.ts.
// "Order again" puts the lines of an earlier order into the cart and nothing else: the cart re-prices every line with the server, so a hidden or repriced item shows up there.
// A finished order (completed, cancelled by the shop or the customer, returned) is the one to order again. An order that is still running is NOT offered for a repeat: it would create a
// second order for the same goods; its customer is sent to pay it (when a payment is due) or to look at it.
import type { OrderItem, ShopOrder } from './api';
import { OPEN_CODES } from './pay';

export const RECENT_COUNT = 3;
export type RecentAction = 'again' | 'pay' | 'view';

/** a line with a price and a quantity; a free reward / gift line (price 0) is never ordered again */
export const isReorderable = (i: Pick<OrderItem, 'unit_price' | 'qty'>) => i.unit_price > 0 && i.qty > 0;
export const FINISHED = ['completed', 'cancelled', 'returned'] as const;

export function recentAction(o: Pick<ShopOrder, 'status' | 'invoice' | 'items'>): RecentAction {
  if ((FINISHED as readonly string[]).includes(o.status)) return o.items.some(isReorderable) ? 'again' : 'view';
  return OPEN_CODES.includes(o.invoice.status_code) && o.status !== 'cancelled' ? 'pay' : 'view';
}

/** the lines to put in the cart, and how many were left out (gift lines, empty lines) so the customer can be told */
export function reorderPlan(items: OrderItem[]): { ok: OrderItem[]; skipped: number } {
  const ok = items.filter(isReorderable);
  return { ok, skipped: items.length - ok.length };
}

/** newest first, and a stable order for orders made in the same second */
export const newestFirst = (orders: ShopOrder[]): ShopOrder[] => [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.order_no.localeCompare(a.order_no));
