# Pictures in the online shop

| | Where | Who changes it |
|---|---|---|
| **Stored** | public bucket `shop-products`, folder = SKU | an upload adds; nothing here deletes |
| **Displayed** | `shop_sku_content.image_paths`, at most 6, in order | staff; this is what customers see |
| **Waiting** | only in the browser the picture was added in (IndexedDB) | sent by itself, unless staff pressed X |

## Sending by itself (since 2026-11-24)

On any back-office page except POS and the kitchen display, for ADMIN and SUPER_ADMIN, a card shows the pictures of this browser the shop does not have and counts down 10 seconds. **X** on a
picture: it is never sent. **Hold for now** stops until Send now (also after a refresh of that tab). The countdown stands still while a mouse or the keyboard focus is on the card and while the tab
is hidden. A dropped connection is tried again after 5 and 20 seconds and when the connection is back; a refusal is not repeated by itself. Adding a picture to a product sends it straight away.

A picture is stored as `m-<checksum>`, so a second tab, another computer or a retry stores and shows it once, and one that staff removed is recognised and does not come back. Pictures sent earlier
that day have random names that cannot be matched: pictures of that SKU added before them count as "Sent earlier" and are never sent by themselves.

## Taking a picture off the customer pages

Products -> a product -> Images: **X** removes it from `image_paths` (saved at once, logged as `product.save`). The file stays, is listed under "Stored, not shown to customers" and can be shown again.
A customer with the page open sees the change when the home data is asked again (kept 30 seconds). A customer sees a SKU only when it is active.

No migration. The database decides who may save (`shop_admin_save_content`, storage policies). A public file can still be opened by someone who already has its link.
Two computers changing the same SKU in the same second: the later one wins (the list is read right before it is written; an add/remove function in the database would close this).

Code: `src/shop/productPictures.ts`, `src/shop/PicturePanel.tsx`. Tests: `tests/shop-e2e/product-pictures.spec.ts`.
