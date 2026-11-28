# Delivery location pin (map, Google Maps links, saved addresses)

**Status (2026-11-28): BUILT AND TESTED, NOT YET APPLIED OR PUBLISHED.** Migration `20261128130000_delivery_pin.sql` has only been run inside rolled-back transactions against the live project (117/117 checks, rollback proven). The app code is on branch `feat/delivery-pin`, not committed, not merged, not deployed. Nothing a customer or the shop uses has changed yet.

## What a customer and the shop get

**Customer (checkout, delivery):** a *Delivery location* section. The customer chooses the place on a map: search a place / building / village / condominium / address, tap the map, drag the pin, use the phone's position, or paste a Google Maps link or coordinates. Nothing counts until they press **Confirm this location**. Then they add the details (address, house / building / unit, village / condo, floor, landmark, extra directions, a note for the driver with quick phrases, and, if it goes to somebody else, that person's name and phone). The card shows the distance from the shop: the **straight line** and, when the routing service answers, the **driving distance and time** (the straight line is never called a driving distance). The confirmation sheet repeats who / where before the order is placed.

**Saved addresses:** *Account → My delivery addresses* (add, edit / move the pin, make default, delete; up to 10). At checkout the default address is chosen for the customer, others are one tap away, and "save this address for next time" is offered (ticked by default only for a customer who has none yet). An order always keeps **its own copy** of where it was sent: editing or deleting a saved address never changes an order.

**Shop (Online shop → Orders):** the order drawer has a delivery card: recipient and phone (tap to call), the address, the driver's note (highlighted), the coordinates, the distance, a small map with the route, and the four actions: **Open destination in Google Maps**, **Open route from the store** (origin = the shop, destination = the pin), **Copy delivery link**, **Copy delivery details** (everything a driver needs, in Thai, to paste into LINE MAN or any booking), plus *Copy location link* and *Copy coordinates*. The order list marks orders that have a pin. An older order (typed address only) shows its address and a link that searches it in Google Maps.

**Shop location (Online shop → Settings → Delivery map):** name, latitude, longitude and the Google Maps link of the starting point (can paste a full Google link / coordinates to fill them in), and the switch *Delivery orders need a map pin*. Default: **หมู่บ้านสิวารัตน์ 2** at `13.745952, 100.292734`, resolved from the shop's own link `https://maps.app.goo.gl/tT5NXeciaU2tuFyc9` (it redirects to `google.com/maps/search/13.745952,+100.292734`; a reverse lookup puts it on a residential road in อ.สามพราน จ.นครปฐม 73210). Changing it affects **new** orders only: each order stores the starting point it was placed with.

## LINE MAN and other couriers

LINE MAN has no public booking API that was verified, so there is none here. The workflow is link-and-copy: *Open route from the store* → check it in Google Maps → *Copy delivery details* → paste into the booking. If an API is ever verified, it would take the same stored fields.

## How it works (database)

Migration `20261128130000_delivery_pin.sql` (nothing existing is removed; pick-up orders are untouched):

* `shop_settings` + `store_name`, `store_lat`, `store_lng`, `store_maps_url`, `delivery_pin_required` (default **true**).
* `shop_order_delivery`: one **frozen** row per delivery order that has a pin (update and delete are blocked by a trigger, `DELIVERY_FROZEN`): recipient, address parts, instructions, lat / lng, how it was pinned (`search | tap | drag | gps | link | saved`), when, the saved address it came from, the starting point it was placed with, the two Google Maps links, the straight-line distance, and the driving distance / time when plausible.
* `shop_addresses`: the customer's saved addresses (RLS: own rows only; one default per customer by a unique index; writes only through functions).
* `shop_place_order` gets one optional last parameter `p_delivery`. Without it the function behaves as before, except a delivery order without a pin is refused (`DELIVERY_PIN_REQUIRED`) while the switch is on. The order's own `delivery_address` text is made from the structured address, so every older screen, the LINE card and the invoice keep showing it. `shop_order_json` gains `delivery` (null when there is no pin); `shop_settings_public` gains `store` and `delivery_pin_required`; `shop_admin_save_settings` accepts the store fields.
* New functions: `shop_address_list / save / set_default / delete`; internal helpers (not callable by clients): haversine distance, the two link builders, the text cleaner, `shop_delivery_clean` (all validation), `shop_delivery_text`, `shop_route_accept`, `shop_delivery_json`.

### Rules the database enforces (the screen only mirrors them)

| Rule | Code |
|---|---|
| a delivery order needs a pin while the switch is on | `DELIVERY_PIN_REQUIRED` |
| the pin must be confirmed (`confirmed` is exactly `true`) | `PIN_NOT_CONFIRMED` |
| latitude / longitude are numbers in range (no exponents, no text) | `PIN_INVALID` |
| the place is inside Thailand (5.5–20.6 °N, 97.3–105.7 °E): `0,0` or Tokyo is a slip, not a destination | `PIN_OUTSIDE_AREA` |
| recipient name and a Thai phone number | `INVALID_RECIPIENT` |
| address of at least 5 characters | `INVALID_ADDRESS` |
| a text longer than its limit is refused, never silently cut | `INVALID_DETAILS` |
| a pin cannot come with a pick-up order | `DELIVERY_PICKUP_CONFLICT` |
| 10 saved addresses at most; another customer's address is "not found" | `ADDRESS_LIMIT`, `ADDRESS_NOT_FOUND` |
| a delivery destination can never be changed or removed | `DELIVERY_FROZEN` |

Links are **built by the database** from the coordinates and the stored starting point; any link the client sends is ignored. The straight-line distance is computed by the database. A driving route sent by the browser is kept only if it is plausible (not shorter than the straight line, not absurdly longer, a speed a vehicle can do, provider `osrm`); otherwise it is dropped and the order still goes through. Retrying the same checkout returns the same order, also when the route was measured again; the same key with another pin is `KEY_REUSED`.

## Map services and their limits

No Google API key or billing account exists, so the map uses free services, called **from the customer's browser** (the database and the shop never call them):

* **OpenStreetMap** tiles (map pictures), via Leaflet (`leaflet@1.9.4`, bundled into the single file).
* **Nominatim** (search and "name of the place under the pin"). Its public usage policy forbids search-as-you-type, so search runs only when the customer presses Search / Enter.
* **OSRM** public server (driving distance, time and the route line; the staff card measures again when the order has no stored route).
* The Google Maps **links** (open the place, open the route) work on any phone or computer and need no key.

These are shared public services meant for light use. If the shop grows, or a service is slow, switch the provider in one file, `src/shop/geo/services.ts` (for example Google's Routes / Places, which need a key and billing; keep the key in an Edge Function, never in the page).

**Privacy to know:** the words a customer searches for and the pinned coordinates go to those public services from the customer's browser. Nothing else (no name, phone or order) is sent.

**If a service fails** the order is never blocked: tiles down → a notice and the pin can still be chosen by search / phone position / pasted link; search down or busy → a message, tap the map; route down → "could not be worked out", the order goes without a route and staff open the route in Google Maps; place name not found → the address is asked for. The phone's position needs the customer's permission (a refusal is explained).

## Rollout

1. Apply `supabase/migrations/20261128130000_delivery_pin.sql` (only after the owner's OK; no data changes: defaults only). From that moment a delivery order **needs a pin**, so apply it and publish the app together: an old, cached copy of the app that tries a delivery order is told, in Thai, to reload the page.
2. Publish the app (main → `gh-pages`, keep `ocr/`).
3. Check once with a real order: place a delivery order with a pin, open it in the shop, tap *Open route from the store*.
4. If the map misbehaves in production, switch off *Delivery orders need a map pin* (Settings) to let customers order with a typed address while it is fixed.

**Rollback:** `supabase/rollbacks/20261128130000_delivery_pin_down.sql` restores the four replaced functions verbatim and drops the new objects. It **refuses** while any order carries a pin or any saved address exists (they would be lost): export `shop_order_delivery` / `shop_addresses` first.

## How it is tested (real results, 2026-11-28)

* `bash scripts/run-delivery-pin-sql-tests.sh`: the migration and **117 checks against the live project's real customers, staff, catalogue and payment accounts, rolled back**: defaults and old orders, who may call what, the helper functions, every refusal above, placing orders with pins, retries and replays, links built by the database, plausible / implausible routes, the frozen snapshot, who can read what (customer A / customer B / staff / anon), saved addresses (default, limit, edit does not change orders, another customer cannot touch them), the store settings, and that earlier orders keep their starting point.
* `bash scripts/run-delivery-pin-down-proof.sh` (+ `control`, `guard`, `guard-pin`): the rollback restores all 449 functions, 109 tables, 1142 columns, 610 constraints, 242 indexes, 86 triggers and 61 policies exactly (9/9); without the rollback the comparison finds the differences; the rollback refuses while an address or a pin exists.
* Unit tests `tests/unit/deliveryPin.test.ts` (32): distances equal the database's (4832 m), the exact link strings, reading pasted links (including the real link the shop's short link redirects to), the draft and what is sent, saved addresses, and that every text exists in Thai and English.
* Browser tests (Chrome, 390 px and 320 px wide): `tests/shop-e2e/delivery.spec.ts` (22: choosing the place all five ways, the whole order journey, validation, services failing, saved addresses, old database, optional pin, English, no sideways scroll, accessibility) and `delivery-admin.spec.ts` (14: the card, the exact links, copy and the copy fallback, orders without a pin, Thai, phone, settings). They run against a fake backend that mirrors the database contract and test answers for the three map services (`tests/shop-e2e/mapMocks.ts`); the provider answers were checked by hand against the live services on 2026-11-28 (shapes and CORS).
* **Not tested:** the screens against the real database from a browser (the migration is not applied), real taps on the Google Maps links on a phone, a real LINE in-app browser (the phone's position may be refused there: the other four ways remain), and the public map services under real traffic.
