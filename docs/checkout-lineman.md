# Checkout: LINE MAN delivery or pick-up (address book at checkout)

**Status (2026-11-28): built on branch `feat/checkout-lineman`, not published.** App-only change: **no database change, no migration**. It uses the address book and the order function that went live with the delivery pin (`20261128130000_delivery_pin.sql`, see docs/delivery-pin.md).

## What the customer sees

**Checkout → How to get your order** has exactly two choices:

| Choice | What the checkout shows | What it asks for |
|---|---|---|
| **เรียก Line Man** (LINE MAN delivery, the order's `fulfilment` is still `delivery`) | the chosen saved address: name (Home, Office…), recipient and phone, the address, the driver's note, the distance from the shop (straight line and, when the routing service answers, driving distance and time); **Change** (lists every saved address as a choice), **Edit**, **+ เพิ่มที่อยู่จัดส่ง** | nothing, when the customer has a saved address (the default is chosen for them) |
| **รับที่ร้าน** (pick-up) | a pick-up card (the shop's name and its pick-up information) | nothing |

Both have one optional field: **หมายเหตุถึงร้าน** (note to the shop). The name and phone of an order come from the customer's **account** (a LINE member cannot enter the shop without both, see `needsSignup` in pages/CustomerApp.tsx). Only an account without a valid name or phone (in practice a staff or e-mail account) gets a small *Your contact details* box. A LINE MAN order then uses the recipient of the chosen address.

The preorder (pick up at a chosen time) is not a third choice any more: when the shop offers it, *Pick up* shows **When to collect: When it is ready / Preorder (pick up later)**.

**+ เพิ่มที่อยู่จัดส่ง** opens the address editor **over** the checkout (cart, payment choice, attached slip and note stay as they are). Map pin (search, tap, drag, phone position, pasted link), the address line (filled in from the map, editable), house no. / building / room, the driver's note with quick phrases, *more details (optional)* (village / condo, floor, landmark, extra directions), the recipient (the account unless *deliver to somebody else*), a name with quick chips **บ้าน / ที่ทำงาน / อื่นๆ**. **Save address** stores it in the account (`shop_address_save`) and chooses it for this order; the first address becomes the default. **Edit** from the checkout opens the same editor on the chosen address.

**Account → ที่อยู่จัดส่งของฉัน** (My delivery addresses) is where addresses are managed: add, edit (move the pin), make default, delete (with a confirmation; an order already placed keeps its own copy), at most 10, the default first, an incomplete address flagged.

## Cases handled

| Case | Behaviour |
|---|---|
| several / one saved address | the default (else the first) is chosen; *Change* lists them (only shown with 2+) |
| none saved | a short note and a primary **+ เพิ่มที่อยู่จัดส่ง**; ordering says *Please choose or add a delivery address* and sends nothing |
| an address added or edited during checkout | saved to the account, chosen for this order, the list reloaded |
| the customer changes the address | one tap in the list; the order carries the chosen one (`address_id`) |
| delivery → pick-up → delivery | the chosen address, note, payment choice and slip are kept (the checkout draft) |
| page refresh | the chosen address is remembered (its id in the session draft); one deleted meanwhile falls back to the default |
| incomplete / invalid saved address (an old row, a bad phone) | a warning on the card, ordering waits, **Edit** fixes it |
| addresses cannot be loaded | *Could not load your delivery addresses* with *Try again*; pick-up still works |
| ordering pick-up | no address or recipient check at all |
| not signed in | the shop is not reachable (sign-in gate); every address function is refused by the database for anyone but the owner |
| 10 addresses | no add button, the limit is said |
| the shop switched *Delivery orders need a map pin* off | a customer with nothing saved can type an address (no pin); one with a saved address can choose *Type an address without a pin* |
| an older database (no delivery-pin migration) | a typed address, as before |

## What did NOT change

* The database: no table, function or policy was added or changed. Addresses are the existing `shop_addresses` (RLS: own rows only, one default by a unique index, at most 10, writes only through `shop_address_save / set_default / delete`). The order is placed by the existing `shop_place_order` with the existing `p_delivery` snapshot (frozen per order).
* Prices, promotions, points, payment methods, the slip, the QR, the preorder slots, the LINE card, the staff order screens.
* The pin of an order placed from a saved address is recorded with `pin_source = 'saved'` (as it already was when a saved address was chosen); how the address itself was pinned stays on the saved address.

## Not done (by choice)

* **Province / district / sub-district / postcode as separate fields.** The address line is filled in from the map pin (it already contains ตำบล อำเภอ จังหวัด and the postcode, editable). Separate fields would need new columns on `shop_addresses` and `shop_order_delivery`, changes to five live functions, and a Thai administrative-area list; the pin is what a LINE MAN driver uses. Can be added later if wanted.
* **Booking LINE MAN automatically.** There is still no verified LINE MAN API: staff book the driver with *Copy delivery details* / *Open route from the store* (docs/delivery-pin.md). The checkout text says the shop books it.

## Tests

* Browser tests (fake backend, Chrome): `tests/shop-e2e/delivery.spec.ts` rewritten for the new flow (two choices only, no contact fields, pick-up, adding during checkout, the editor's checks, choosing / changing / editing / incomplete / failing-to-load / limit / refresh / deleted address, map services failing, Account address book, older database, pin optional, English, 320 px and 390 px with axe). The other checkout specs (`checkout-ux`, `ordering`, `preorders`, `shop`) were updated where they filled in the old contact section.
* `playwright.shop.config.ts` now takes `SHOP_PORT` (default 4179), so a second worktree can run the suite without reusing another worktree's dev server.

### Results (2026-11-28, worktree `.claude/worktrees/checkout-lineman`, port 4180, fake backend)

* Type check (`tsc --noEmit`): clean.
* Unit tests (vitest): 1725 / 1726; the one failure (`skuSync.test.ts`, a 10 s hook timeout while another session's full browser run had the CPU at 100%) passes when run again (41 / 41).
* Browser tests: `delivery.spec` 29 / 29; `checkout-ux`, `ordering`, `shop`, `own-reader`, `delivery-admin` 111 / 111; `preorders` 18 / 18; `premium-qr`, `product-pictures`, `rewards`, `slip-customer`, `wallet`, `feedback`, `feedbackRound2` 182 / 182. On the first pass 2 tests timed out loading the first page (the busy machine) and passed on the re-run; one real accessibility finding was fixed (the map's attribution links are now underlined, axe `link-in-text-block` at 320 px).
* **Not tested:** against the real database from a browser (the screens use the same functions as the live delivery-pin release, unchanged), on a real phone / inside the LINE browser. The complete suite of every spec was not run.
