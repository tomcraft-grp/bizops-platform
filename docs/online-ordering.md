# Online ordering: going live and testing it yourself

Builds on [customer-shop.md](customer-shop.md) (catalogue, cart, orders) and [wallet-and-payments.md](wallet-and-payments.md) (bank accounts, wallet, ledger queue).
Migration `supabase/migrations/20261115300000_online_ordering.sql`, rollback `supabase/rollbacks/20261115300000_online_ordering_down.sql`.

## The journey

| Step | Customer (LINE / mobile browser, `/app`) | Back office |
|---|---|---|
| 1 Browse | Home, categories, search, product page. Only **Active finished-goods SKUs with a price** appear; the price is read from the database. | Online shop → Products: pictures, descriptions, hide / sold-out / max per order |
| 2 Cart | Quantities, remove, subtotal, shipping, total. Every amount is the server's quote; the app sends only SKU + quantity. | |
| 3 Checkout | Name and phone (pre-filled), delivery address or pick-up, note, **how to pay** (SCB, BBL, wallet when it holds money, PromptPay QR when configured). One tap = one order, even with double taps or a dropped connection. | Online shop → Orders: the order appears, with the customer's chosen method |
| 4 Payment request | The order page shows the invoice, the amount owed, the chosen bank with a **copy account number** button, the **payment reference** (invoice number) with a copy button, or the QR with **Save QR image**, or the wallet panel. | |
| 5 Slip | Upload JPG / PNG / PDF (≤ 5 MB). The invoice becomes **awaiting verification**. It is never "paid" because of a slip. | Payment review: the slip, the amount the customer claims, the bank chosen |
| 6 Verify | Sees "paid" / "partly paid" after verification, or the rejection reason. | A verifier or manager enters **the amount the bank shows** and the bank reference, then approves (or rejects with a reason). More than owed: the extra is credited to the customer's wallet. |
| 7 Fulfil | Order progress: new → confirmed → preparing → packed → shipped / ready → completed | Online shop → order → move it along; tracking number goes in the message box |

Order status and payment status are separate. Payment statuses: unpaid, awaiting verification, partly paid, paid, rejected, cancelled, expired, and **refunded** (shown as a badge when money was returned to the wallet).

## Accounting (nothing is posted automatically)

* Submitting an order creates **no** accounting entry. The receivable (Dr accounts receivable / Cr sales) is queued for the accountant when staff **confirm the order**, or when the first payment on it is verified. An order cancelled before that leaves no trace.
* A verified bank transfer queues Dr bank (that bank) / Cr receivable for the part owed, and Cr customer wallet liability for any excess (the same amount is added to the wallet in the same transaction).
* Reversing a receipt reverses the wallet credit too, and is refused if the customer already spent that credit.
* The accountant posts the queue on the accounting device: **Payments & wallet → Accounting ledger**. Before invoices can be posted, choose the VAT treatment under *Accounting settings* there.

## Before the first real order (settings only you can make)

1. **Open the shop**: Online shop → Settings → switch on. (It is switched on by the deployment of this change; the checklist on that page shows what is still missing.)
2. **PromptPay QR (optional)**: Payment review → Payment account → your PromptPay ID (phone number or tax ID). Until then the QR option is not offered and customers pay by bank transfer + slip. No gateway credentials are needed for this: the QR is generated from your PromptPay ID.
3. **Shipping**: Online shop → Settings: delivery on / pick-up on, shipping fee, free-shipping threshold, pick-up note.
4. **VAT treatment** for the accountant (see above).
5. **Roles**: SUPER_ADMIN accounts already act as finance managers. Give verifiers / clerks a role under Payment review → Access.
6. **Pictures and descriptions** (optional): Online shop → Products. Without a picture the app shows a placeholder.

## Test it yourself (about 10 minutes)

1. On your phone open the Customer App with a **customer** account (not the staff account). Pick a product, add it, check out with SCB.
2. Open the order: check the amount, the SCB account number (tap *Copy*), the reference (the invoice number). Upload a slip picture. The order says **awaiting verification**.
3. On the computer, sign in as staff: *Payment review* → the slip → enter the amount and a bank reference → approve. Back on the phone, refresh the order: **paid**.
4. *Online shop → Orders*: open the order → Confirmed → Preparing → Packed → Shipped (with a tracking number) → Completed.
5. *Payments & wallet → Accounting ledger*: the receivable and the bank receipt are waiting; post them. *Reports* shows the receipt under SCB.
6. Try the edge cases: transfer more than the invoice (the extra appears in the customer's wallet), reject a slip, cancel an unpaid order.

## How it is tested

* `scripts/run-ordering-sql-tests.sh`: 76 checks of the whole journey against the real catalogue and real accounts, always rolled back (browse, price tampering, duplicate checkout, payment choice, slip, partial and over-payment, accounting queue, reversal, refund, cancel, isolation between customers, unauthorised actions).
* `scripts/run-ordering-down-proof.sh` (and `... guard`): the rollback restores the schema exactly and refuses once orders carry data.
* Browser tests (`npx playwright test -c playwright.shop.config.ts`): checkout choice, pre-selection, reference + copy, refunded badge, old-database fallback, accessibility, phone widths. They use a fake backend: they prove the screens, not the database.

## Limits

* No payment-provider or bank callbacks: payments are verified by staff against the bank statement (the interface for a provider exists, `finance_verify_evidence(... p_via => 'provider')`, but no provider credentials are configured).
* No central stock: availability is the sold-out switch and a maximum per order. No discounts or coupons.
* Not tested inside the real LINE app.
