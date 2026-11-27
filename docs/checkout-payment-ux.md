# Checkout: payment picker, PromptPay QR, collapsible sections

## Why the QR was not visible

Two causes, one on top of the other:

1. **Screen.** The checkout drew the payment methods without the QR option (`MethodCards` without `qr`), so it was never offered.
2. **Backend.** The only function that makes a QR, `finance_request_payment`, needs an invoice. The invoice is created by the order, and the shop asks for the
   transfer slip *with* the order (`shop_settings.require_payment_slip`). So before the order there was no way to make a QR, and after it there was nothing left to pay.

The payment account itself was set up correctly. Adding the option to the screen alone would have shown a method that could not be paid.

## What changed

| Area | Behaviour |
|---|---|
| Payment methods (checkout and order page) | One closed line with the chosen method. Tap to open, pick a method and it closes. Arrow keys move without closing, Enter closes. |
| QR at checkout | Choosing the QR shows it in the "transfer, then attach your slip" card, outside every collapsible section. The amount is the server's own total. |
| QR on the order page | Choosing the QR makes it at once. Not made by itself when a slip waits, more evidence is wanted or a QR expired: the money may already be on its way. |
| Wrong or old QR | A QR whose amount differs from what is owed is never shown. Loading and failure show text, never a picture. |
| Slip attached | The transfer details close; one tap brings them back. If the total changes afterwards the customer is warned. |
| Sections | Contact, items, payment: one open at a time. Contact starts open only while something is missing. On the order page progress, items and delivery are closed while a payment is due. |
| Going back, other tabs, reload | Contact, note, way of getting the order, method and slip details are kept (`src/shop/checkoutDraft.ts`, per user, cleared after the order). The slip *picture* is kept while moving around but not across a page reload. |

Code: `Fold` (`src/shop/ui.tsx`), `PayMethodPicker` (`src/wallet/ui.tsx`), `QrPanel` / `CheckoutQrPanel` / `PayToBank` (`src/wallet/PayTo.tsx`).

## Database

`supabase/migrations/20261123100000_checkout_qr.sql` adds one function, `shop_checkout_qr(items, fulfilment)`. It writes nothing. It prices with `shop_quote_internal`
(the function that prices the order) and builds the QR with `finance_qr_with_amount` (the function the invoice QR uses). The app sends only SKU and quantity.

Rollback: `supabase/rollbacks/20261123100000_checkout_qr_down.sql`.

## Go-live order

1. Apply the migration (`scripts/apply-migrations.sh`). It is safe on its own: the published app does not call it.
2. Publish the app.
3. Place one real order with the QR using a small amount and check that the bank app shows the shop's name and the exact amount.

If the app is published first, choosing the QR shows "the QR cannot be shown right now" with Try again and the other methods; bank and wallet work.

## Tests

- `tests/shop-e2e/checkout-ux.spec.ts`: the QR is decoded from the pixels on the screen and from the saved picture.
- `tests/unit/checkoutDraft.test.ts`
- `supabase/tests/checkout_qr.sql` (`scripts/run-checkout-qr-sql-tests.sh`, rolls back; or the local harness:
  `node scripts/local-pg/run.mjs --skip checkout_qr --skip line_order_notifications supabase/migrations/20261123100000_checkout_qr.sql supabase/tests/checkout_qr.sql`).
  The suite places an order inside the transaction, so prefer the local harness.

## Limits

- A scan with a real banking app is not automated: step 3 above.
- The QR has no reference of its own (PromptPay carries only the account and the amount). Staff match it by the slip, as for a bank transfer.
