# Pictures in the online shop

Customers see the pictures in `shop_sku_content.image_paths` (public bucket `shop-products`, at most 6 per SKU, only finished-goods SKUs).

Until 2026-11-24 the Products page kept a picture only in the browser it was added in (IndexedDB) and said "uploaded". Nothing reached the shop. Now:

* Adding a picture on **Products** also sends it to the shop. If the shop refuses, the page says "Saved in this browser only" with the reason.
* **Images** tab: which pictures the shop has, "Make main", "Remove from the shop".
* Pictures added before: a notice on Products offers **Send them to the online shop**. It appears only in the browser that holds them, and skips a SKU that already has shop pictures. Clearing that browser's data loses them.
* A customer still sees a SKU only when it is active.

No migration. The database decides who may save (`shop_admin_save_content`, storage policies: ADMIN and SUPER_ADMIN).
Code: `src/shop/productPictures.ts`, `src/shop/PicturePanel.tsx`. Tests: `tests/shop-e2e/product-pictures.spec.ts`.
