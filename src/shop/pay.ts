// What the customer is told about the payment of an order, as plain functions (no React), so the rules can be tested without a browser. Nothing here reads or shows
// how a slip was analysed: a customer sees only what staff did (the slip is waiting, confirmed, rejected, more evidence wanted) and what has really been paid.
import type { InvoiceState, StatusCode } from '../finance/api';
import { baht } from './format';
import { type ShopLang, tr } from './i18n';

/**
 * Payment states in which the customer may cancel their own order: nothing is waiting on the shop and nothing is paid. 3 (a slip is waiting, or the shop confirmed it
 * and is recording it) and 10 (the shop asked for more evidence) are NOT here: the shop is working on the payment. The database refuses it again.
 */
export const CANCEL_CODES: readonly StatusCode[] = [0, 1, 7, 9];

/** Payment states in which the payment panel of an order opens by itself because the customer has something to do (10: send another slip for the same order). */
export const OPEN_CODES: readonly StatusCode[] = [0, 1, 7, 9, 10];

export interface PayNotes {
  /** "Paid ฿200 · remaining ฿150" while part of the order is paid and part is still owed */
  remaining: string | null;
  /** "The shop confirmed ฿320; it is being recorded": a payment the shop confirmed that is not posted yet (not money received yet) */
  confirmed: string | null;
}

/** The extra lines under the payment status. Both are null when there is nothing to say (older databases have no `confirmed_pending`). */
export function payNotes(inv: Pick<InvoiceState, 'paid' | 'outstanding' | 'status_code' | 'confirmed_pending'>, lang: ShopLang): PayNotes {
  const code = inv.status_code;
  const part = inv.paid > 0 && inv.outstanding > 0 && code !== 8;
  const confirmed = (inv.confirmed_pending ?? 0) > 0 && code !== 5 && code !== 8;
  return {
    remaining: part ? tr(lang, 'pay.remaining', { paid: baht(inv.paid), left: baht(inv.outstanding) }) : null,
    confirmed: confirmed ? tr(lang, 'pay.confirmedNote', { amount: baht(inv.confirmed_pending) }) : null,
  };
}
