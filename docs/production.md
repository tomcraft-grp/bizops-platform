# BOM and production

For staff (how to work) and for the accountant (what is posted, how costs are worked out, what the limits are).
The rules are in `src/domain/bom.ts`, `src/domain/production.ts` and `src/domain/productionAnalysis.ts`. The screens are in `src/production/`. Accounting policy: POL-09 (older single-step flow) and POL-24 (orders with work in progress) in `docs/accounting/ACCOUNTING_POLICY_REGISTER.md`.

## Where the data is kept

BOMs, production orders, stock and journals are kept **in this browser on this device**. They are not shared: another phone or computer does not see them, and clearing the browser data removes them. Make a backup regularly (Settings). The product catalogue itself comes from the central SKU registry and is the same on every device. One short note on the Production overview says the same.

## For staff: the way of working

Production → the tabs are *Production overview, BOM list, Production orders, Material consumption, Finished goods receipts, Cost & profit, History of production*. The open tab, BOM or order is in the address, so a reload or the back button returns to the same place.

1. **Put the materials into stock** (Purchasing, or Inventory → Adjust). A product you buy and resell can be a material. The cost matters: without a cost the result is "unknown".
2. **Create a BOM.** Choose the product to make (any *active* product), the batch size (for example 100), and the components. Search by name, SKU, old SKU, barcode (a scanner works), brand or category. Each component has a quantity per batch, a use (material, packing, consumable) and a waste allowance in percent. A quantity can be typed in another unit, for example *2 boxes of 12*. Labour and overhead are either an amount or **not known yet**: "not known" is never counted as 0. Press *Preview before saving*, then *Save as draft* or *Save and activate*.
   - A version in use cannot be changed. *New BOM version* makes a draft; activating it replaces the old one from the chosen date (the list says *Starts on …* until then, and such a version cannot be used for an order before its date). Orders already made keep the version they were made with.
   - *Copy to another product*, *Stop using this BOM*, *Use again*, *Archive*: a reason is asked where the status changes; nothing is deleted.
   - Somebody without *finance: cost* sees that labour, overhead and other costs are set, not how much; saving keeps them as they are.
3. **Create a production order** from the BOM: quantity, warehouse, due date. Only a BOM in use today can be chosen; a link to a BOM that cannot be used says why instead of choosing another one. The screen shows what is needed, what is on hand, what is short, what other warehouses hold, and the estimated cost. An order may be created although something is short.
4. **Approve** it (permission *production: approve*).
5. **Record production**: materials out, labour and other costs, finished goods in, as one step. Quantities are filled in from the BOM for the units of this run, less what is already in the order, and can be changed; a material that is not in the BOM can be added, and every line can come from another warehouse. Or do it in separate steps: *Issue materials*, *Add a cost*, *Receive finished goods*, *Record an abnormal loss*, *Return unused material*.
   - Good units enter stock. Rejected units do not; their share of the cost becomes waste, and they have to be made again: what is left to make is planned − good, so the next step after rejects is new material, never goods without a cost.
   - When a receipt (or a last run) would take goods in although the BOM expects more material, labour or overhead than the order holds, the screen lists what is missing and asks: *Go back and record it*, or *Continue without it*. Somebody without *finance: cost* never types amounts: a receipt then brings the labour and overhead of the BOM by itself.
   - Receiving more than is left to make (for example 10,000 typed instead of 100) is shown with the numbers in the confirmation.
   - The confirmation says in plain words what cost the goods take, per unit, what goes to waste and, for a last receipt, what is posted as a production variance.
   - A receipt is **partial** (the order stays open) or the **last one** (the goods take all the cost that is left, the order is completed).
   - Before anything is posted, one confirmation lists the stock movements and the journal lines. What it shows is what will be posted.
6. **Close** an order when no more will be made, or **cancel** it (with a reason) before anything was received. Material that is left over should be returned first. A closed or cancelled order can be **opened again** with a reason; an order finished by its last receipt is opened by reversing that receipt.
7. **A mistake** is corrected by *Reverse entry* on the document (issue, return, cost, loss, receipt), with a reason. Nothing posted is edited or deleted.
8. **Unsaved input**: leaving a BOM, an order form or an action with typed input (another tab, another action, the side menu, the back button, closing the browser tab) asks first.

### Statuses

Draft → Planned → Approved → In production → Partly received → Completed. Cancelled from any state before goods were received.

### Who may do what

| Permission | Allows |
|---|---|
| production: view | see the screens |
| production: create | create and plan orders, issue, return material, record costs, losses and receipts |
| production: edit | BOMs: create as draft, change drafts, new version, copy, stop using, archive |
| production: approve | create a BOM in use, activate a version, use a BOM again; approve, close, cancel, reopen and reverse |
| finance: cost | see any cost, value or margin. Without it *Add a cost*, *Record an abnormal loss* and the *Cost & profit* tab are hidden, and labour and other costs from the BOM are added automatically when production is recorded |

Buttons a person may not use are not shown, and the engine refuses the action as well. The one exception is *finance: cost*: it only decides what a person sees. It hides amounts, but it does not stop someone with *production: create* from adding a cost or recording a loss.

## For the accountant

### Accounts

All postings go through posting roles (Accounting setup → Transaction mapping). New roles: `wip` 1220 Work in progress, `prod_var_material` 5310, `prod_var_labor` 5320, `prod_var_overhead` 5330. Reused: `inv_goods` 1210, `inv_materials` 1200, `waste` 5100, `conversion_absorbed` 5400. If a role has no usable account, a red banner on Production names it and posting is refused; there is no suspense posting.

| Event | Debit | Credit |
|---|---|---|
| Materials issued | 1220 WIP | 1210 or 1200, by the kind of each component |
| Labour, overhead, utilities, other cost | 1220 WIP | 5400 Labour & overhead absorbed |
| Finished goods received | 1210 or 1200, by the kind of the product | 1220 WIP |
| Rejected units in a receipt | 5100 Waste | 1220 WIP |
| Abnormal loss | 5100 Waste | 1220 WIP |
| Material returned to stock | 1210 or 1200 | 1220 WIP (at the average the material has in the order) |
| Excess cost in a last receipt (see costing) | 5310 / 5320 / 5330 | 1220 WIP, in the same entry as the receipt |
| Cost left when an order is closed or cancelled | 5310 / 5320 / 5330 by element (either sign) | 1220 WIP |
| Reversal | the mirror of the entry, linked to it | |
| Reversed receipt or return, when the average cost has moved since | the difference between inventory and 5310 | |
| Order opened again | the mirror of its close or cancel entry | |

Every entry has `refType = production` and the order as its reference. A journal of a production order cannot be reversed on the Accounting page; it is reversed on the order, so that stock and cost go with it. The reconciliation has a WIP row: WIP of all orders = balance of every account with control *work in progress* (the `wip` role only takes such an account; an owner's own WIP account works when it has that control).

`5400` is credited with what is recorded on orders. The wages and bills themselves are booked as expenses as before; the credit in 5400 takes the part that went into goods out of the expenses of the period.

### Costing method

Actual cost, weighted average per product and warehouse.

Costs follow the physical material.

- Materials are issued at the average cost of the warehouse they come from.
- WIP is kept per order in three elements: materials, labour, overhead (utilities and other costs count as overhead). The *pool* of an order is what is in it now, per product in quantity and actual cost: issued, less returned, less what receipts, losses and closes took.
- A partial receipt of U units (good + rejected) takes, per BOM component, what the BOM needs for U units at the cost it has in the pool; of a material that is not in the BOM, and of labour or overhead without an estimate, the share U ÷ units left. Labour and overhead with an estimate: estimate × U.
- *Record production*: what that run issued and recorded belongs to its own goods, all of it; from the earlier pool it takes only what the BOM needs beyond that. So two runs at a new price cost the same (20 and 20, not 10 and 30).
- The last receipt takes all that is left. When earlier receipts exist, an excess over what these units need is shared: this receipt carries its part, the rest is posted as a production variance in the same entry.
- Units = good + rejected. The cost is divided over both; the rejected part is expensed. Units left to make = planned − good.
- An abnormal loss is stated in money and takes material from the pool pro rata by value.
- Unused material is returned at the average it has in the order.
- The goods enter stock at that cost and are averaged with what is already there. A sale then books that average as cost of sales.

### Estimated, standard, actual

Three figures, shown side by side and never mixed:

- **Estimated**: the BOM at today's costs (an order keeps the estimate of the day it was approved).
- **Standard**: the standard cost written on the product.
- **Actual**: what was recorded on the order.

Variances of a completed order (material price, material usage, labour, overhead, rejected units) compare actual with the estimate *for the units really made*. They are analysis and are **not posted**. Posted to 5310–5330 are only: cost left in WIP when an order is closed or cancelled (taken back when it is opened again), the excess of a last receipt, and the average-cost difference when a receipt or a return is reversed. While an order is open no variance is shown: material in WIP is not over-use.

### Unknown cost

A component with no average, last or standard cost is *unknown*, not 0. It is named wherever it matters, and every total it belongs to is unknown too. Issuing it, or receiving goods when there is no cost, is refused; a person may confirm it after a warning. The goods then carry too little cost and the profit looks too high: correct the cost first whenever possible.

### Profit

- Price before VAT = list price ÷ (1 + the VAT rate a sale takes today). Gross profit per unit = price before VAT − unit cost. Margin = gross profit ÷ price before VAT.
- The unit cost used is the average in stock, else the last production, else the BOM estimate, else the standard cost; the screen says which.
- The Profit page deducts production variances and adds back the labour and overhead absorbed into the cost of goods (5400), so its net profit is the result of the ledger.
- Revenue, cost of sales and gross profit of a period come from the real order lines (net of VAT, discounts and returns, cost recorded at the sale). "No data" means there is none. If goods left without a recorded cost, the profit of the period is unknown.
- Sales are not shown per production order: goods of several orders are mixed in stock at their average. Per order, the actual unit cost is compared with today's price.

### Checks

The same request sent twice (a double tap) posts once; a request whose result was undone since is refused, not repeated. An action is all or nothing: short stock, a locked period or an unmapped role changes nothing and says why in Thai and English. A reversed receipt is refused when some of the goods have been sold or moved.

## Limits

- One device (see above). Two devices would have two separate sets of BOMs, orders and stock.
- One BOM per product. A menu item (recipe) can have a BOM but no production order: it is made when it is sold.
- No lots or expiry dates on produced goods, no machine or staff planning, no purchase order made from a shortage.
- Average cost only (no FIFO). Back-dating is not possible: a document has the date it is posted.
- Orders of the older single-step flow keep their records and can be finished with the new steps.
- A variance is shown per element (material price, usage, labour, overhead, rejects) only for a completed order, against the estimate made at approval.
- The leave-without-saving question covers navigation inside the app and closing the tab; the browser's own wording is used for the latter.
- Texts the system stores in English ("Copied from …", "Draft based on …", reversal notes on stock movements) are shown in Thai on the Thai screen; free text people typed is shown as typed.
- `5400`, the variance accounts and the WIP policy should be reviewed by a qualified accountant before real use, as the setup page says.
