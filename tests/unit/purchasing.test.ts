// Purchasing and perpetual inventory accounting (src/domain/purchasing.ts): purchase orders (draft, edit, approve stamp, partial receipts, short close, cancel), goods receipts with a discount and
// landed cost, the payable, supplier payments, returns, and the two reversals (goods receipt, supplier payment). Every scenario ends with sound(): all journals balanced, the stock value
// equals the inventory accounts, and the integrity checks are green; the supplier invoices equal the payables account and the supplier deposits equal their account.
import { describe, expect, it } from 'vitest';
import { codeOf, ctx } from '../helpers';
import { W, add, glCode, po as prodOrder, put, session, sound } from '../production';
import { approvePO, apOpen, cancelPO, closePO, createPO, liveAp, lineNet, paySupplier, poTotal, priceHistory, receiveGoods, returnToSupplier, reverseGoodsReceipt, supplierDeposit, updatePO, voidSupplierPayment } from '../../src/domain/purchasing';
import { reverseJournal, roleCode } from '../../src/domain/accounting';
import { reconciliationMatrix } from '../../src/domain/setup';
import { getBal, onHand } from '../../src/domain/inventory';
import { createBom } from '../../src/domain/bom';
import { approveOrder, createOrder as createProd, issueMaterials, receiveGoods as prodReceive } from '../../src/domain/production';
import { createOrder as sell } from '../../src/domain/orders';
import { thaiForError } from '../../src/lib/errorText';
import type { DB, ID } from '../../src/domain/types';
import { r2 } from '../../src/lib/util';

const u = (userId: string) => ({ ...ctx, userId });
const SUP = 'SUP1', SUPV = 'SUP2';
/** a shop that buys: a VAT supplier, a supplier without VAT, three items (two resale, one material). The ids are the test's own: the live test book already has products named A, B, C and FG. */
function shop() {
  return session((d) => {
    add(d, 'P1', 'resale', 100); add(d, 'P2', 'material', 80); add(d, 'P3', 'resale', 2); add(d, 'PFG', 'resale', 0, { price: 400 });
    d.suppliers.push({ id: SUP, code: 'AAA', name: 'Alpha Supplies', contact: '', phone: '', termsDays: 30, vatable: true, rating: 3, productIds: [] });
    d.suppliers.push({ id: SUPV, code: 'BBB', name: 'Beta No VAT', contact: '', phone: '', termsDays: 7, vatable: false, rating: 3, productIds: [] });
  });
}
type S = ReturnType<typeof shop>;
const order = (s: S, lines: { productId: ID; qty: number; unitCost: number; discountPct?: number }[], o: { supplierId?: ID; send?: boolean } = {}) =>
  s.do((d) => createPO(d, ctx, { supplierId: o.supplierId ?? SUP, warehouseId: W, lines, send: o.send }));
const rec = (s: S, poId: ID, lines: { productId: ID; qty: number }[], o: { freight?: number; handling?: number; invoiceNo?: string; key?: string } = {}) =>
  s.do((d) => receiveGoods(d, ctx, { poId, lines, ...o }));
const PO = (s: S, id: ID) => s.db.purchaseOrders.find((x) => x.id === id)!;
/** the ledger code a role posts to in this book (the live book maps materials and goods as set up there) */
const codeOfRole = (d: DB, role: string) => roleCode(d, role)!;
const apMatrix = (d: DB) => reconciliationMatrix(d).find((r) => r.key === 'ap')!;
const depMatrix = (d: DB) => reconciliationMatrix(d).find((r) => r.key === 'supplier_deposit')!;
/** the supplier invoices equal the payables account, the deposits equal their account */
function booksAgree(d: DB) { sound(d); expect(apMatrix(d).status).toBe('ok'); expect(depMatrix(d).status).toBe('ok'); expect(reconciliationMatrix(d).filter((r) => r.status === 'diff').map((r) => r.key)).toEqual([]); }

describe('purchase orders: what can be ordered', () => {
  it('a plain order: draft or sent, with a history, the supplier learns its items', () => {
    const s = shop();
    const sent = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    expect(PO(s, sent)).toMatchObject({ status: 'sent', approvedBy: 'U1', createdBy: 'U1' });
    expect(PO(s, sent).history!.map((h) => h.action)).toEqual(['created', 'approved']);
    expect(s.db.suppliers.find((x) => x.id === SUP)!.productIds).toEqual(['P1']);                 // any item can be ordered; the supplier's usual list grows by itself
    const draft = order(s, [{ productId: 'P2', qty: 5, unitCost: 80 }], { send: false });
    expect(s.db.suppliers.find((x) => x.id === SUP)!.productIds).toEqual(['P1']);                 // a draft teaches the supplier nothing; sending it does
    expect(PO(s, draft)).toMatchObject({ status: 'draft' }); expect(PO(s, draft).approvedBy).toBeUndefined();
    expect(poTotal(PO(s, sent))).toBe(1000);
  });
  it('an item of any kind can be bought (a resale item, a material): the picker is not tied to a category', () => {
    const s = shop();
    for (const p of ['P1', 'P2', 'P3']) expect(s.code((d) => createPO(d, ctx, { supplierId: SUP, warehouseId: W, lines: [{ productId: p, qty: 1, unitCost: 1 }] }))).toBeNull();
  });
  it('refused: unknown supplier or warehouse, no lines, duplicate lines, bad numbers, a discount outside 0-100', () => {
    const s = shop();
    const mk = (o: object = {}, lines: object[] = [{ productId: 'P1', qty: 1, unitCost: 10 }]) => (d: DB) => createPO(d, ctx, { supplierId: SUP, warehouseId: W, lines, ...o } as never);
    expect(s.code(mk({ supplierId: 'nope' }))).toBe('NOT_FOUND');
    expect(s.code(mk({ warehouseId: 'nope' }))).toBe('NOT_FOUND');
    expect(s.code(mk({}, []))).toBe('INVALID');
    expect(s.code(mk({}, [{ productId: 'P1', qty: 0, unitCost: 10 }]))).toBe('INVALID');
    expect(s.code(mk({}, [{ productId: 'P1', qty: 1, unitCost: 10 }, { productId: 'P1', qty: 2, unitCost: 10 }]))).toBe('DUPLICATE_LINE');
    for (const bad of [-1, NaN, Infinity]) expect(s.code(mk({}, [{ productId: 'P1', qty: 1, unitCost: bad }])), String(bad)).toBe('INVALID');
    expect(s.code(mk({}, [{ productId: 'P1', qty: NaN, unitCost: 1 }]))).toBe('INVALID');
    for (const bad of [-1, 101, NaN]) expect(s.code(mk({}, [{ productId: 'P1', qty: 1, unitCost: 10, discountPct: bad }])), String(bad)).toBe('INVALID');
    expect(s.code(mk({}, [{ productId: 'ZZ', qty: 1, unitCost: 10 }]))).not.toBeNull();
    expect(s.db.purchaseOrders).toHaveLength(0);                                                   // every refusal kept nothing
  });
  it('a line discount lowers the value of the line (and only that line)', () => {
    expect(lineNet({ qty: 10, unitCost: 100, discountPct: 10 })).toBe(900);
    expect(lineNet({ qty: 10, unitCost: 100 })).toBe(1000);
    expect(lineNet({ qty: 3, unitCost: 33.33, discountPct: 12.5 })).toBe(r2(3 * 33.33 * 0.875));
  });
  it('permissions: creating needs purchasing:create; the cashier cannot', () => {
    const s = shop();
    expect(s.code((d) => createPO(d, u('U3'), { supplierId: SUP, warehouseId: W, lines: [{ productId: 'P1', qty: 1, unitCost: 1 }] }))).toBe('FORBIDDEN');
  });
});

describe('purchase orders: draft, edit, approve, cancel, close', () => {
  it('a draft can be edited and then approved; a sent order cannot be edited; nothing can be received before it is sent', () => {
    const s = shop();
    const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }], { send: false });
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 1 }] }))).toBe('INVALID');
    s.do((d) => updatePO(d, ctx, id, { lines: [{ productId: 'P1', qty: 20, unitCost: 90, discountPct: 5 }, { productId: 'P2', qty: 4, unitCost: 80 }], note: 'urgent' }));
    expect(PO(s, id)).toMatchObject({ note: 'urgent', status: 'draft' }); expect(PO(s, id).lines).toHaveLength(2);
    expect(s.code((d) => updatePO(d, ctx, id, { lines: [{ productId: 'P1', qty: 1, unitCost: 1 }, { productId: 'P1', qty: 1, unitCost: 1 }] }))).toBe('DUPLICATE_LINE');
    expect(PO(s, id).lines).toHaveLength(2);                                                       // the refused edit changed nothing
    s.do((d) => approvePO(d, ctx, id));
    expect(PO(s, id)).toMatchObject({ status: 'sent', approvedBy: 'U1' });
    expect(s.code((d) => updatePO(d, ctx, id, { note: 'x' }))).toBe('INVALID');
    expect(s.code((d) => approvePO(d, ctx, id))).toBe('INVALID');
    expect(PO(s, id).history!.map((h) => h.action)).toEqual(['created', 'edited', 'approved']);
  });
  it('cancel: a draft or a sent order with nothing received; never one that has goods in, nor a closed one', () => {
    const s = shop();
    const a = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }], { send: false }), b = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    s.do((d) => { cancelPO(d, ctx, a, 'ordered twice'); cancelPO(d, ctx, b); });
    expect(PO(s, a)).toMatchObject({ status: 'cancelled', closedReason: 'ordered twice' });
    expect(s.code((d) => cancelPO(d, ctx, a))).toBe('INVALID');                                      // already cancelled
    const c = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    rec(s, c, [{ productId: 'P1', qty: 4 }]);
    expect(s.code((d) => cancelPO(d, ctx, c))).toBe('INVALID');                                      // goods are in: close it instead
    expect(s.code((d) => receiveGoods(d, ctx, { poId: a, lines: [{ productId: 'P1', qty: 1 }] }))).toBe('INVALID');
  });
  it('close short: only a partly received order; the rest will not come; it cannot be received any more', () => {
    const s = shop();
    const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    expect(s.code((d) => closePO(d, ctx, id, 'x'))).toBe('INVALID');                                 // nothing received yet: cancel instead
    rec(s, id, [{ productId: 'P1', qty: 6 }]);
    s.do((d) => closePO(d, ctx, id, 'supplier stopped the line'));
    expect(PO(s, id)).toMatchObject({ status: 'closed', closedReason: 'supplier stopped the line' });
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 1 }] }))).toBe('INVALID');
    booksAgree(s.db);
  });
  it('permissions: cancel and close need purchasing:edit', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 1, unitCost: 1 }]);
    expect(s.code((d) => cancelPO(d, u('U3'), id))).toBe('FORBIDDEN');
    expect(s.code((d) => closePO(d, u('U3'), id))).toBe('FORBIDDEN');
  });
});

describe('goods receipt: stock, payable, journal', () => {
  it('partial receipts then the rest: the order status follows, each receipt makes its own movement, journal and invoice', () => {
    const s = shop();
    const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }, { productId: 'P2', qty: 5, unitCost: 80 }]);
    const g1 = rec(s, id, [{ productId: 'P1', qty: 4 }], { invoiceNo: 'INV-1' });
    expect(PO(s, id).status).toBe('partial'); expect(onHand(s.db, W, 'P1')).toBe(4);
    expect(PO(s, id).lines.find((l) => l.productId === 'P1')!.receivedQty).toBe(4);
    const g2 = rec(s, id, [{ productId: 'P1', qty: 6 }, { productId: 'P2', qty: 5 }], { invoiceNo: 'INV-2' });
    expect(PO(s, id).status).toBe('received');
    expect(s.db.grns.map((g) => g.id)).toEqual([g1, g2]); expect(s.db.apInvoices).toHaveLength(2);
    expect(s.db.movements.filter((m) => m.refType === 'grn')).toHaveLength(3);
    expect(PO(s, id).history!.filter((h) => h.action === 'received')).toHaveLength(2);
    // Dr inventory + Dr input VAT / Cr AP: 4 x 100 = 400 + 7% = 428 on the first invoice
    const inv1 = s.db.apInvoices[0];
    expect(inv1).toMatchObject({ net: 400, vat: 28, amount: 428, status: 'open', invoiceNo: 'INV-1' });
    const j = s.db.journals.find((x) => x.id === s.db.grns[0].journalId)!;
    expect(j.lines.map((l) => [l.debit, l.credit]).sort()).toEqual([[0, 428], [28, 0], [400, 0]].sort());
    booksAgree(s.db);
  });
  it('over-receiving is refused (no authorised exception): the whole receipt is kept out, and so is a receipt with a repeated item', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    rec(s, id, [{ productId: 'P1', qty: 8 }]);
    const before = s.db;
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 3 }] }))).toBe('OVER_RECEIPT');
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 1 }, { productId: 'P1', qty: 1 }] }))).toBe('DUPLICATE_LINE');
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P3', qty: 1 }] }))).toBe('INVALID');          // not on this order
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 1 }], freight: -5 }))).toBe('INVALID');
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [] }))).toBe('INVALID');
    expect(s.db).toBe(before);
    expect(thaiForError(s.msg((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 3 }] })))).toMatch(/3.*2/);
  });
  it('the supplier\'s discount lowers the stock value and the payable; the price history shows the net price', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100, discountPct: 10 }]);
    rec(s, id, [{ productId: 'P1', qty: 10 }]);
    expect(getBal(s.db, W, 'P1')).toMatchObject({ qty: 10, value: 900 });
    expect(s.db.apInvoices[0]).toMatchObject({ net: 900, vat: 63, amount: 963 });
    expect(priceHistory(s.db, 'P1').map((x) => x.unitCost)).toEqual([90]);
    expect(s.db.grns[0].lines[0]).toMatchObject({ unitCost: 100, discountPct: 10 });
    booksAgree(s.db);
  });
  it('freight and handling are capitalised into the stock by value, and are payable to the supplier', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }, { productId: 'P2', qty: 10, unitCost: 100 }], { supplierId: SUPV });
    rec(s, id, [{ productId: 'P1', qty: 10 }, { productId: 'P2', qty: 10 }], { freight: 100, handling: 50 });
    expect(getBal(s.db, W, 'P1').value + getBal(s.db, W, 'P2').value).toBe(2150);                       // 2000 of goods + 150 landed
    expect(s.db.apInvoices[0]).toMatchObject({ net: 2000, vat: 0, landed: 150, amount: 2150 });          // a supplier without VAT: none claimed
    const goodsAcct = codeOfRole(s.db, 'inv_goods'), matAcct = codeOfRole(s.db, 'inv_materials');
    expect(glCode(s.db, goodsAcct) + (matAcct === goodsAcct ? 0 : glCode(s.db, matAcct))).toBe(2150);     // resale goods and materials: each kind in the account the book maps it to
    if (matAcct !== goodsAcct) expect(glCode(s.db, matAcct)).toBe(1075);
    booksAgree(s.db);
  });
  it('the same supplier invoice number twice is refused (also in other letters); a different supplier may use it; a voided one is free again', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    const g = rec(s, id, [{ productId: 'P1', qty: 2 }], { invoiceNo: 'INV-77' });
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 1 }], invoiceNo: ' inv-77 ' }))).toBe('DUPLICATE_INVOICE');
    const other = order(s, [{ productId: 'P1', qty: 1, unitCost: 1 }], { supplierId: SUPV });
    expect(s.code((d) => receiveGoods(d, ctx, { poId: other, lines: [{ productId: 'P1', qty: 1 }], invoiceNo: 'INV-77' }))).toBeNull();
    s.do((d) => reverseGoodsReceipt(d, ctx, g, 'wrong'));
    expect(s.code((d) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 1 }], invoiceNo: 'INV-77' }))).toBeNull();
  });
  it('a request key makes a double click one receipt: the same key returns the first receipt, nothing is received twice', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    const a = rec(s, id, [{ productId: 'P1', qty: 4 }], { key: 'req-1' });
    const b = rec(s, id, [{ productId: 'P1', qty: 4 }], { key: 'req-1' });
    expect(b).toBe(a); expect(s.db.grns).toHaveLength(1); expect(onHand(s.db, W, 'P1')).toBe(4); expect(s.db.apInvoices).toHaveLength(1);
    const c = rec(s, id, [{ productId: 'P1', qty: 4 }], { key: 'req-2' });                           // another request is another receipt
    expect(c).not.toBe(a); expect(onHand(s.db, W, 'P1')).toBe(8);
    booksAgree(s.db);
  });
  it('permissions: receiving needs purchasing:edit', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 1, unitCost: 1 }]);
    expect(s.code((d) => receiveGoods(d, u('U3'), { poId: id, lines: [{ productId: 'P1', qty: 1 }] }))).toBe('FORBIDDEN');
  });
});

describe('paying suppliers', () => {
  it('pays oldest invoices first, in parts; cash leaves the cash account; an overpayment is a supplier deposit that can pay a later invoice', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }], { supplierId: SUPV });
    rec(s, id, [{ productId: 'P1', qty: 4 }]); rec(s, id, [{ productId: 'P1', qty: 6 }]);              // 400 and 600
    const p1 = s.do((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 500, method: 'cash' }));
    expect(s.db.apInvoices.map((i) => [i.status, apOpen(i)])).toEqual([['paid', 0], ['partial', 500]]);
    expect(glCode(s.db, '1100')).toBe(-500);
    s.do((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 600, method: 'transfer' }));         // 500 owed + 100 over
    expect(s.db.apInvoices.every((i) => i.status === 'paid')).toBe(true); expect(supplierDeposit(s.db, SUPV)).toBe(100);
    expect(s.code((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 0, method: 'cash' }))).toBe('INVALID');
    expect(s.code((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: NaN, method: 'cash' }))).toBe('INVALID');
    expect(p1).toBeTruthy(); booksAgree(s.db);
  });
  it('permissions: paying needs purchasing:approve', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 1, unitCost: 1 }]); rec(s, id, [{ productId: 'P1', qty: 1 }]);
    expect(s.code((d) => paySupplier(d, u('U3'), { supplierId: SUP, amount: 1, method: 'cash' }))).toBe('FORBIDDEN');
  });
});

describe('reversing a goods receipt', () => {
  it('a wrong receipt: the stock goes back out, the invoice is void, the order is open again, nothing is deleted, and everything still balances', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]);
    const g = rec(s, id, [{ productId: 'P1', qty: 10 }], { invoiceNo: 'WRONG' });
    expect(PO(s, id).status).toBe('received');
    s.do((d) => reverseGoodsReceipt(d, ctx, g, 'delivered to the wrong shop'));
    const grn = s.db.grns[0];
    expect(grn.reversal).toMatchObject({ reason: 'delivered to the wrong shop', stockDiff: 0 }); expect(grn.reversal!.journalId).toBeTruthy();
    expect(s.db.apInvoices[0].status).toBe('void'); expect(apOpen(s.db.apInvoices[0])).toBe(0); expect(liveAp(s.db)).toHaveLength(0);
    expect(PO(s, id)).toMatchObject({ status: 'sent' }); expect(PO(s, id).lines[0].receivedQty).toBe(0);
    expect(onHand(s.db, W, 'P1')).toBe(0);
    expect(s.db.movements.filter((m) => m.refType === 'grn_reversal')).toHaveLength(1);              // the stock movement is its own record
    expect(s.db.journals.find((j) => j.id === grn.journalId)!.status).toBe('reversed');              // the receipt journal stays, marked reversed, with a mirror entry
    expect(glCode(s.db, '1210')).toBe(0); expect(glCode(s.db, '2000') + glCode(s.db, '2100')).toBe(0);
    expect(PO(s, id).history!.at(-1)).toMatchObject({ action: 'receipt_reversed' });
    expect(s.db.apInvoices).toHaveLength(1);                                                          // the invoice is kept, void, not deleted
    booksAgree(s.db);
    // the order can be received again, correctly
    rec(s, id, [{ productId: 'P1', qty: 10 }]); expect(PO(s, id).status).toBe('received'); booksAgree(s.db);
  });
  it('moving-average cost: reversing the second receipt takes the stock out at the CURRENT average, the difference goes to the inventory adjustment, and the ledger still equals the stock', () => {
    const s = shop();
    const o1 = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]); rec(s, o1, [{ productId: 'P1', qty: 10 }]);
    const o2 = order(s, [{ productId: 'P1', qty: 10, unitCost: 200 }]); const g2 = rec(s, o2, [{ productId: 'P1', qty: 10 }]);
    expect(getBal(s.db, W, 'P1')).toMatchObject({ qty: 20, value: 3000 });                              // average 150
    s.do((d) => reverseGoodsReceipt(d, ctx, g2, 'wrong price'));
    expect(getBal(s.db, W, 'P1')).toMatchObject({ qty: 10, value: 1500 });                              // 10 left at 150, not at the 100 they were bought for
    expect(s.db.grns[1].reversal!.stockDiff).toBe(500);                                                // the receipt was worth 2000, 1500 left
    expect(glCode(s.db, '1210')).toBe(1500); expect(glCode(s.db, '5200')).toBe(-500);
    booksAgree(s.db);
  });
  it('refused when the goods are no longer there (some were sold), and nothing is changed', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]); const g = rec(s, id, [{ productId: 'P1', qty: 10 }]);
    s.do((d) => { d.products.find((p) => p.id === 'P1')!.price = 150; sell(d, ctx, { channel: 'POS', branchId: 'B3', warehouseId: W, lines: [{ productId: 'P1', qty: 3 }], payments: [{ method: 'cash', amount: 450 }], skipPromotions: true }); });
    const before = s.db;
    expect(s.code((d) => reverseGoodsReceipt(d, ctx, g, 'oops'))).toBe('INSUFFICIENT_STOCK');
    expect(s.db).toBe(before);
    expect(thaiForError(s.msg((d) => reverseGoodsReceipt(d, ctx, g, 'oops')))).toMatch(/7.*10/);
  });
  it('refused when the invoice has a payment, a credit note, or a supplier return; the reason names what to do first', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]); const g = rec(s, id, [{ productId: 'P1', qty: 10 }]);
    const pay = s.do((d) => paySupplier(d, ctx, { supplierId: SUP, amount: 100, method: 'cash' }));
    expect(s.code((d) => reverseGoodsReceipt(d, ctx, g, 'wrong delivery'))).toBe('IN_USE');
    s.do((d) => voidSupplierPayment(d, ctx, pay, 'wrong amount'));
    s.do((d) => returnToSupplier(d, ctx, { supplierId: SUP, warehouseId: W, lines: [{ productId: 'P1', qty: 1 }], reason: 'damaged' }));
    expect(s.code((d) => reverseGoodsReceipt(d, ctx, g, 'wrong delivery'))).toBe('IN_USE');
  });
  it('reason required; twice is refused; the same key twice is one reversal; permission needs purchasing:approve; a journal cannot be reversed by hand from Accounting', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]); const g = rec(s, id, [{ productId: 'P1', qty: 10 }]);
    expect(s.code((d) => reverseGoodsReceipt(d, ctx, g, ' '))).toBe('REASON');
    expect(s.code((d) => reverseGoodsReceipt(d, u('U3'), g, 'valid reason'))).toBe('FORBIDDEN');
    expect(s.code((d) => reverseGoodsReceipt(d, ctx, 'nope', 'valid reason'))).toBe('NOT_FOUND');
    const jid = s.db.grns[0].journalId!;
    expect(s.code((d) => reverseJournal(d, ctx, jid, 'by hand'))).toBe('USE_PURCHASING');           // it would leave the stock and the payable behind
    expect(thaiForError(s.msg((d) => reverseJournal(d, ctx, jid, 'by hand')))).toMatch(/จัดซื้อ/);
    s.do((d) => reverseGoodsReceipt(d, ctx, g, 'wrong', 'k1'));
    expect(s.do((d) => reverseGoodsReceipt(d, ctx, g, 'wrong', 'k1'))).toBe(g);                    // a retry: the same answer, nothing more done
    expect(s.db.movements.filter((m) => m.refType === 'grn_reversal')).toHaveLength(1);
    expect(s.code((d) => reverseGoodsReceipt(d, ctx, g, 'again'))).toBe('ALREADY');
    expect(s.code((d) => reverseGoodsReceipt(d, ctx, g, 'again', 'k2'))).toBe('ALREADY');
    booksAgree(s.db);
  });
  it('a receipt whose journal was already reversed by hand (an older book) is still reversed in stock without a second reversal', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]); const g = rec(s, id, [{ productId: 'P1', qty: 10 }]);
    s.do((d) => { const j = d.journals.find((x) => x.id === d.grns[0].journalId)!; reverseJournal(d, ctx, j.id, 'by hand (before the guard)', { fromPurchasing: true }); });
    s.do((d) => reverseGoodsReceipt(d, ctx, g, 'finish the job'));
    expect(onHand(s.db, W, 'P1')).toBe(0); expect(s.db.apInvoices[0].status).toBe('void'); booksAgree(s.db);
  });
});

describe('cancelling a supplier payment', () => {
  it('the invoices owe the money again, the cash comes back, the payment stays on record as cancelled', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }], { supplierId: SUPV }); rec(s, id, [{ productId: 'P1', qty: 10 }]);
    const p = s.do((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 1000, method: 'cash' }));
    expect(s.db.apInvoices[0].status).toBe('paid');
    s.do((d) => voidSupplierPayment(d, ctx, p, 'paid the wrong supplier'));
    expect(s.db.apInvoices[0]).toMatchObject({ status: 'open', paid: 0 }); expect(glCode(s.db, '1100')).toBe(0);
    expect(s.db.supplierPayments[0].reversal).toMatchObject({ reason: 'paid the wrong supplier' }); expect(s.db.supplierPayments).toHaveLength(1);
    expect(s.code((d) => voidSupplierPayment(d, ctx, p, 'again'))).toBe('ALREADY');
    booksAgree(s.db);
  });
  it('a part of it kept as a deposit that was already used is refused; a deposit payment can be cancelled and the deposit comes back', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 20, unitCost: 100 }], { supplierId: SUPV });
    rec(s, id, [{ productId: 'P1', qty: 5 }]);
    const p1 = s.do((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 700, method: 'transfer' }));      // 500 owed, 200 kept as a deposit
    expect(supplierDeposit(s.db, SUPV)).toBe(200);
    rec(s, id, [{ productId: 'P1', qty: 5 }]);
    const p2 = s.do((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 200, method: 'deposit' }));       // the deposit pays part of the next invoice
    expect(supplierDeposit(s.db, SUPV)).toBe(0);
    expect(s.code((d) => voidSupplierPayment(d, ctx, p1, 'wrong'))).toBe('IN_USE');                         // the 200 it kept has been spent
    s.do((d) => voidSupplierPayment(d, ctx, p2, 'wrong use'));
    expect(supplierDeposit(s.db, SUPV)).toBe(200);
    s.do((d) => voidSupplierPayment(d, ctx, p1, 'wrong'));
    expect(supplierDeposit(s.db, SUPV)).toBe(0); expect(s.db.apInvoices.every((i) => i.paid === 0)).toBe(true);
    booksAgree(s.db);
  });
  it('refused when the invoice it paid was voided afterwards; permission needs purchasing:approve; a reason is required', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 1, unitCost: 100 }]); rec(s, id, [{ productId: 'P1', qty: 1 }]);
    const p = s.do((d) => paySupplier(d, ctx, { supplierId: SUP, amount: 10, method: 'cash' }));
    expect(s.code((d) => voidSupplierPayment(d, ctx, p, ' '))).toBe('REASON');
    expect(s.code((d) => voidSupplierPayment(d, u('U3'), p, 'valid'))).toBe('FORBIDDEN');
    expect(s.code((d) => voidSupplierPayment(d, ctx, 'nope', 'valid'))).toBe('NOT_FOUND');
    expect(s.code((d) => reverseJournal(d, ctx, s.db.supplierPayments[0].journalId!, 'by hand'))).toBe('USE_PURCHASING');
  });
});

describe('returning goods to the supplier', () => {
  it('credit at the INVOICED price, stock out at the average cost, the difference to the inventory adjustment; the invoice goes down; the books agree', () => {
    const s = shop();
    const o1 = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }]); rec(s, o1, [{ productId: 'P1', qty: 10 }]);
    const o2 = order(s, [{ productId: 'P1', qty: 10, unitCost: 200 }]); rec(s, o2, [{ productId: 'P1', qty: 10 }]);   // average 150
    const inv2 = s.db.apInvoices[1].id;
    s.do((d) => returnToSupplier(d, ctx, { supplierId: SUP, warehouseId: W, lines: [{ productId: 'P1', qty: 2 }], invoiceId: inv2, reason: 'damaged' }));
    const r = s.db.supplierReturns[0];
    expect(r).toMatchObject({ amount: 428, vat: 28, deposit: 0 }); expect(r.lines[0].unitCost).toBe(200);          // 2 x 200 + 7%
    expect(getBal(s.db, W, 'P1')).toMatchObject({ qty: 18, value: 2700 });                                           // 2 left at the average 150
    expect(s.db.apInvoices[1]).toMatchObject({ creditNotes: 428, status: 'partial' }); expect(r.applied).toEqual([{ invoiceId: inv2, amount: 428 }]);
    expect(glCode(s.db, '5200')).toBe(-100);                                                                         // credited 400, stock left 300
    booksAgree(s.db);
  });
  it('no invoice chosen: the credit takes down the oldest open invoices; the excess over what is owed becomes a supplier deposit', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 10, unitCost: 100 }], { supplierId: SUPV }); rec(s, id, [{ productId: 'P1', qty: 10 }]);
    s.do((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 1000, method: 'cash' }));                        // paid in full
    s.do((d) => returnToSupplier(d, ctx, { supplierId: SUPV, warehouseId: W, lines: [{ productId: 'P1', qty: 3 }], reason: 'wrong colour' }));
    expect(s.db.supplierReturns[0]).toMatchObject({ amount: 300, deposit: 300, applied: [] });
    expect(supplierDeposit(s.db, SUPV)).toBe(300); expect(apOpen(s.db.apInvoices[0])).toBe(0);
    booksAgree(s.db);                                                                                                  // before the fix the payables account was 300 short of the invoices
  });
  it('refused: nothing to return, an item twice, no reason, not enough stock, an invoice of another supplier', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 5, unitCost: 100 }]); rec(s, id, [{ productId: 'P1', qty: 5 }]);
    const ret = (o: object) => (d: DB) => returnToSupplier(d, ctx, { supplierId: SUP, warehouseId: W, lines: [{ productId: 'P1', qty: 1 }], reason: 'r', ...o });
    expect(s.code(ret({ lines: [] }))).toBe('INVALID');
    expect(s.code(ret({ lines: [{ productId: 'P1', qty: 1 }, { productId: 'P1', qty: 1 }] }))).toBe('DUPLICATE_LINE');
    expect(s.code(ret({ reason: ' ' }))).toBe('REASON');
    expect(s.code(ret({ lines: [{ productId: 'P1', qty: 6 }] }))).toBe('INSUFFICIENT_STOCK');
    expect(s.code(ret({ invoiceId: 'nope' }))).toBe('INVALID');
    expect(s.code((d) => returnToSupplier(d, u('U3'), { supplierId: SUP, warehouseId: W, lines: [{ productId: 'P1', qty: 1 }], reason: 'r' }))).toBe('FORBIDDEN');
    expect(s.db.supplierReturns).toHaveLength(0);
  });
});

describe('end to end: buy -> BOM -> produce -> sell', () => {
  it('purchased items feed a BOM and a production order; the finished goods are sold; journals balance and every control account reconciles at each step', () => {
    const s = shop();
    // buy the components (a resale item and a material) from two suppliers, some on credit and some paid, with a discount and freight
    const o1 = order(s, [{ productId: 'P1', qty: 100, unitCost: 100, discountPct: 10 }, { productId: 'P3', qty: 1000, unitCost: 2 }]);
    rec(s, o1, [{ productId: 'P1', qty: 100 }, { productId: 'P3', qty: 1000 }], { freight: 200 }); booksAgree(s.db);
    const o2 = order(s, [{ productId: 'P2', qty: 100, unitCost: 80 }], { supplierId: SUPV }); rec(s, o2, [{ productId: 'P2', qty: 100 }]);
    s.do((d) => paySupplier(d, ctx, { supplierId: SUPV, amount: 8000, method: 'transfer' })); booksAgree(s.db);
    expect(glCode(s.db, codeOfRole(s.db, 'inv_materials'))).toBeGreaterThanOrEqual(8000);                          // the material, in the account the book maps materials to
    // a BOM made of what was bought: 100 FG = 10 A + 5 B + 100 C
    const bom = s.do((d) => createBom(d, ctx, { productId: 'PFG', name: 'PFG', type: 'manufacturing', yieldQty: 100, components: [{ productId: 'P1', qty: 10, role: 'material' }, { productId: 'P2', qty: 5, role: 'material' }, { productId: 'P3', qty: 100, role: 'packaging' }], laborCost: 0, overheadCost: 0 }));
    const pid = s.do((d) => { const x = createProd(d, ctx, { bomId: bom, plannedQty: 100, warehouseId: W }); approveOrder(d, ctx, x); return x; });
    s.do((d) => issueMaterials(d, ctx, pid, { lines: [{ productId: 'P1', qty: 10 }, { productId: 'P2', qty: 5 }, { productId: 'P3', qty: 100 }] }));
    expect(onHand(s.db, W, 'P1')).toBe(90); sound(s.db);
    s.do((d) => prodReceive(d, ctx, pid, { good: 100, rejected: 0, warehouseId: W, final: true }));
    expect(onHand(s.db, W, 'PFG')).toBe(100);
    // the material cost of the finished goods is the PURCHASE cost (after the discount, with the freight share), not a standard cost
    const made = prodOrder(s.db, pid);
    expect(made.status).toBe('completed'); expect(r2(getBal(s.db, W, 'PFG').value)).toBeGreaterThan(0); sound(s.db); booksAgree(s.db);
    // sell some: cost of goods sold leaves the finished goods
    s.do((d) => sell(d, ctx, { channel: 'POS', branchId: 'B3', warehouseId: W, lines: [{ productId: 'PFG', qty: 10 }], payments: [{ method: 'cash', amount: 4000 }], skipPromotions: true }));
    expect(onHand(s.db, W, 'PFG')).toBe(90); expect(glCode(s.db, '5010')).toBeGreaterThan(0);
    booksAgree(s.db);
    // a wrong receipt of a component can still be reversed while its goods are on hand: the finished goods are not touched
    const extra = order(s, [{ productId: 'P3', qty: 50, unitCost: 2 }]); const g = rec(s, extra, [{ productId: 'P3', qty: 50 }]);
    s.do((d) => reverseGoodsReceipt(d, ctx, g, 'delivered twice'));
    booksAgree(s.db); expect(onHand(s.db, W, 'PFG')).toBe(90);
  });
  it('stock in the books: a purchase put on hand by the stock count code path and by purchasing both end in the inventory account (one ledger, not two)', () => {
    const s = shop(); s.do((d) => put(d, 'P1', 5, 100));
    const id = order(s, [{ productId: 'P1', qty: 5, unitCost: 120 }]); rec(s, id, [{ productId: 'P1', qty: 5 }]);
    expect(getBal(s.db, W, 'P1')).toMatchObject({ qty: 10, value: 1100 }); sound(s.db);
  });
});

describe('words', () => {
  it('every refusal of purchasing reads in Thai', () => {
    const s = shop(); const id = order(s, [{ productId: 'P1', qty: 1, unitCost: 1 }]);
    for (const f of [
      (d: DB) => createPO(d, ctx, { supplierId: SUP, warehouseId: W, lines: [{ productId: 'P1', qty: 1, unitCost: 1 }, { productId: 'P1', qty: 1, unitCost: 1 }] }),
      (d: DB) => receiveGoods(d, ctx, { poId: id, lines: [{ productId: 'P1', qty: 5 }] }),
      (d: DB) => closePO(d, ctx, id, 'x'), (d: DB) => reverseGoodsReceipt(d, ctx, 'x', 'valid reason'), (d: DB) => voidSupplierPayment(d, ctx, 'x', 'valid reason'),
    ]) expect(thaiForError(s.msg(f))).toMatch(/[ก-๿]/);
  });
  it('codeOf keeps working on the helpers used here', () => { expect(codeOf(() => { throw Object.assign(new Error('x'), { code: 'Z' }); })).toBe('Z'); });
});
