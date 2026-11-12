// Canonical domain model. Everything here lives in one in-browser "database" (DB).
// The shape deliberately mirrors the planned production schema: ledgers are append-only,
// balances are projections, snapshots are stored on transactions.

export type ID = string;
export type ChannelCode = 'POS' | 'LINE' | 'SHOPEE' | 'LAZADA' | 'TIKTOK' | 'LINEMAN';
export type Station = 'kitchen' | 'beverage';
export type ProductKind = 'resale' | 'finished' | 'menu' | 'material' | 'packaging';
export type PayMethod = 'cash' | 'transfer' | 'qr' | 'card' | 'other';
export type OrderStatus =
  | 'new' | 'confirmed' | 'preparing' | 'packed' | 'ready' | 'shipped' | 'completed' | 'cancelled' | 'returned';
export type OrderType = 'dine_in' | 'takeaway' | 'delivery' | 'online' | 'wholesale';

export interface Org {
  name: string; legalName: string; taxId: string; address: string; phone: string;
  vatRate: number; vatRegistered: boolean; currency: 'THB';
  costingMethod: 'WAC'; allowNegativeStock: boolean; allocateOpex: 'none' | 'revenue';
  receiptFooter: string; promptPayId: string; pointValue: number;
}
export interface Branch { id: ID; code: string; name: string; type: 'store' | 'kitchen' | 'online'; defaultWarehouseId: ID; address: string }
export interface Warehouse { id: ID; code: string; name: string; branchId: ID; kind: 'store' | 'central' | 'kitchen' }

export interface Role { id: ID; name: string; description: string; permissions: string[]; system: boolean }
export interface User { id: ID; name: string; email: string; roleId: ID; branchIds: ID[]; active: boolean; color: string; lastLogin?: string }

export interface Customer {
  id: ID; code: string; name: string; phone: string; email?: string; lineUserId?: string;
  group: 'retail' | 'wholesale' | 'vip' | 'staff'; creditLimit: number; creditDays: number;
  consent: { pdpa: boolean; marketing: boolean; at: string }; createdAt: string; note?: string;
  birthday?: string; address?: string;
}

export interface ModifierOption {
  name: string; priceDelta: number;
  add?: { productId: ID; qty: number }[];
  replace?: { from: ID; to: ID };
}
export interface ModifierGroup { name: string; required?: boolean; options: ModifierOption[] }

export interface Product {
  id: ID; sku: string; name: string; category: string; kind: ProductKind; unit: string;
  price: number; channelPrices: Partial<Record<ChannelCode, number>>; barcode?: string;
  active: boolean; emoji: string; color: string; stdCost: number;
  levels: Record<ID, { min: number; max: number }>; // per-warehouse reorder levels
  station?: Station | null; supplierId?: ID; bomId?: ID; modifiers?: ModifierGroup[];
  trackLot?: boolean; mediaIds: ID[]; description?: string; listingMap?: Partial<Record<ChannelCode, string>>;
}

// ---------- inventory
export type MoveType =
  | 'opening' | 'receipt' | 'sale' | 'backflush' | 'adjust' | 'count' | 'transfer_out' | 'transfer_in'
  | 'prod_issue' | 'prod_output' | 'waste' | 'return_in' | 'return_out';
export interface Movement {
  id: ID; ts: string; productId: ID; warehouseId: ID; qty: number; unitCost: number; value: number;
  type: MoveType; refType: string; refId: ID; note?: string; lot?: string; expiry?: string; userId: ID;
}
export interface Balance { qty: number; value: number; lastCost: number }
export interface TransferLine { productId: ID; qty: number; receivedQty: number; unitCost: number; value: number; valueReceived: number; shortClosed?: number }
export interface Transfer {
  id: ID; no: string; fromWh: ID; toWh: ID; status: 'in_transit' | 'partial' | 'received' | 'closed_short';
  lines: TransferLine[]; createdAt: string; receivedAt?: string; note?: string; createdBy: ID;
}
export interface StockCount {
  id: ID; no: string; warehouseId: ID; createdAt: string; status: 'open' | 'posted';
  lines: { productId: ID; systemQty: number; countedQty: number | null }[]; postedAt?: string; note?: string;
}

// ---------- purchasing
export interface Supplier {
  id: ID; code: string; name: string; contact: string; phone: string; email?: string;
  termsDays: number; taxId?: string; vatable: boolean; rating: number; productIds: ID[];
}
export interface POLine { productId: ID; qty: number; unitCost: number; receivedQty: number }
export interface PurchaseOrder {
  id: ID; no: string; supplierId: ID; warehouseId: ID; status: 'draft' | 'sent' | 'partial' | 'received' | 'closed' | 'cancelled';
  lines: POLine[]; createdAt: string; expectedAt?: string; note?: string; createdBy: ID;
}
export interface GRNLine { productId: ID; qty: number; unitCost: number; landedUnit: number; lot?: string; expiry?: string }
export interface GoodsReceipt {
  id: ID; no: string; poId: ID; supplierId: ID; warehouseId: ID; ts: string; lines: GRNLine[];
  freight: number; handling: number; invoiceNo: string; invoiceId: ID; journalId?: ID; createdBy: ID;
}
export interface SupplierInvoice {
  id: ID; no: string; supplierId: ID; poId?: ID; grnId?: ID; invoiceNo: string; date: string; dueDate: string;
  net: number; vat: number; landed: number; amount: number; paid: number; creditNotes: number;
  status: 'open' | 'partial' | 'paid';
}
export interface SupplierPayment {
  id: ID; no: string; supplierId: ID; ts: string; amount: number; method: PayMethod | 'deposit';
  allocations: { invoiceId: ID; amount: number }[]; deposit: number; note?: string; journalId?: ID;
}
export interface SupplierReturn {
  id: ID; no: string; supplierId: ID; warehouseId: ID; ts: string; reason: string;
  lines: { productId: ID; qty: number; unitCost: number }[]; amount: number; invoiceId?: ID;
}

// ---------- BOM & production
export interface BomComponent { productId: ID; qty: number; role: 'material' | 'packaging' | 'consumable' }
export interface BomVersion {
  version: number; status: 'draft' | 'active' | 'retired'; effectiveFrom: string; effectiveTo?: string;
  yieldQty: number; components: BomComponent[]; laborCost: number; overheadCost: number; notes?: string; createdAt: string;
}
export interface Bom {
  id: ID; productId: ID; name: string; type: 'manufacturing' | 'recipe' | 'packaging' | 'assembly'; versions: BomVersion[];
}
export interface ProductionBatch { ts: string; outputQty: number; wasteQty: number; materialCost: number; conversionCost: number; wasteCost: number; unitCost: number; journalId?: ID }
export interface ProductionOrder {
  id: ID; no: string; bomId: ID; productId: ID; warehouseId: ID; plannedQty: number; status: 'planned' | 'in_progress' | 'completed' | 'cancelled';
  snapshot: BomVersion; createdAt: string; completedAt?: string; batches: ProductionBatch[]; note?: string; createdBy: ID;
}

// ---------- orders
export interface AppliedPromo { promoId: ID; name: string; discount: number; bonusPoints: number; entitlements: number; freeItems: { productId: ID; qty: number }[]; couponIds?: ID[]; pendingCoupon?: { value: number; days: number } }
export interface OrderLine {
  id: ID; productId: ID; name: string; sku: string; qty: number; unitPrice: number;
  modifiers: { group: string; option: string; priceDelta: number }[]; note?: string;
  discount: number; isFree?: boolean; promoId?: ID;
  cost: number; costMaterials: number; costConversion: number; bom?: { bomId: ID; version: number };
  station?: Station | null; kds?: 'new' | 'preparing' | 'ready' | 'done'; returnedQty: number; restockedQty: number; externalSku?: string;
}
export interface Order {
  id: ID; no: string; channel: ChannelCode; branchId: ID; warehouseId: ID; customerId?: ID; externalId?: string;
  orderType: OrderType; status: OrderStatus; statusLog: { ts: string; status: OrderStatus; by: ID; note?: string }[];
  createdAt: string; recognizedAt?: string; lines: OrderLine[];
  subtotal: number; discountTotal: number; total: number; platformVoucher: number; vatRate: number;
  collectedBy: 'merchant' | 'platform'; payLater?: boolean; promotions: AppliedPromo[]; couponId?: ID;
  pointsEarned: number; bonusMult?: number; bonusFixed?: number; fees: { commission: number; paymentFee: number; shippingSubsidy: number; estimated: boolean };
  settlementId?: ID; creditNoted: number; refundsPaid: number; idempotencyKey?: string; note?: string; createdBy: ID;
  shipping?: { carrier?: string; tracking?: string; recipient?: string; address?: string }; cancelledReason?: string;
  tableNo?: string;
}
export interface ReturnDoc {
  id: ID; no: string; orderId: ID; ts: string; lines: { lineId: ID; qty: number; restock: boolean }[];
  amount: number; netAmount: number; vatAmount: number; costReversed: number; reason: string;
  refund: { method: 'none' | 'cash' | 'transfer' | 'credit' | 'platform'; amount: number }; createdBy: ID;
}

// ---------- payments / receivables
export interface Receipt {
  id: ID; no: string; ts: string; customerId?: ID; amount: number; method: PayMethod; reference?: string;
  slipId?: ID; status: 'posted' | 'void'; voidReason?: string; journalId?: ID; note?: string; createdBy: ID;
}
export interface Allocation { id: ID; receiptId: ID; orderId: ID; amount: number; ts: string; active: boolean; kind: 'payment' | 'reversal' | 'credit' }
export interface SlipRequest {
  id: ID; customerId: ID; orderIds: ID[]; amount: number; reference?: string; mediaId?: ID; createdAt: string;
  status: 'pending' | 'approved' | 'rejected'; reviewerId?: ID; reviewedAt?: string; rejectReason?: string;
  receiptId?: ID; checksum?: string; note?: string; transferAt?: string;
}

// ---------- channels
export interface ChannelAccount {
  channel: ChannelCode; name: string; enabled: boolean; connection: 'api' | 'csv' | 'native';
  verified: boolean; lastSyncAt?: string; shopName: string;
  commissionPct: number; paymentFeePct: number; shippingSubsidy: number; settlementDays: number;
}
export interface ChannelMapping { id: ID; channel: ChannelCode; externalSku: string; productId: ID | null; externalName: string }
export interface ExternalOrder {
  id: ID; channel: ChannelCode; externalId: string; receivedAt: string; status: 'imported' | 'error' | 'duplicate';
  error?: string; orderId?: ID; raw: Record<string, unknown>; source: 'sync' | 'csv' | 'webhook';
}
export interface SyncJob { id: ID; channel: ChannelCode; ts: string; source: 'sync' | 'csv'; fetched: number; imported: number; duplicates: number; errors: number; durationMs: number }
export interface Settlement {
  id: ID; no: string; channel: ChannelCode; createdAt: string; periodFrom: string; periodTo: string; orderIds: ID[];
  gross: number; commission: number; paymentFee: number; shippingSubsidy: number; net: number;
  status: 'pending' | 'received'; receivedAt?: string; receivedAmount?: number; variance?: number; journalId?: ID;
}

// ---------- promotions / loyalty / events
export type PromoActionType = 'percent' | 'fixed' | 'free_item' | 'bundle_price' | 'bonus_points' | 'event_entitlement' | 'coupon';
export interface PromoAction {
  type: PromoActionType; value?: number; bonusMode?: 'multiplier' | 'fixed'; productId?: ID; qty?: number; bundleProductIds?: ID[];
  eventId?: ID; perAmount?: number; maxPerOrder?: number; couponValue?: number; couponDays?: number;
}
export interface Promotion {
  id: ID; name: string; description: string; code?: string; status: 'draft' | 'active' | 'paused' | 'expired';
  priority: number; stacking: 'exclusive' | 'stackable'; startAt: string; endAt: string;
  channels: ChannelCode[]; branchIds: ID[]; customerGroups: string[]; weekdays?: number[]; timeFrom?: string; timeTo?: string;
  minOrder?: number; minQty?: number; productIds?: ID[]; categories?: string[]; minLifetimeSpend?: number; requireCustomer?: boolean;
  action: PromoAction; limits: { total?: number; perCustomer?: number; perOrder: number }; budget?: number;
}
export interface PromoRedemption { id: ID; promoId: ID; orderId: ID; customerId?: ID; ts: string; discount: number; bonusPoints: number; entitlements: number }
export interface Coupon {
  id: ID; code: string; customerId: ID; kind: 'percent' | 'fixed'; value: number; minOrder?: number; title: string;
  status: 'issued' | 'used' | 'expired' | 'cancelled'; source: 'reward' | 'promo'; sourceId: ID; expiresAt: string; usedOrderId?: ID; createdAt: string;
}
export interface PointEntry {
  id: ID; customerId: ID; ts: string; points: number; type: 'earn' | 'redeem' | 'adjust' | 'expire' | 'reverse' | 'restore' | 'bonus';
  refType?: string; refId?: ID; note?: string; expiresAt?: string; remaining?: number; by?: ID;
}
export interface Reward {
  id: ID; name: string; description: string; cost: number; stock: number | null; active: boolean; emoji: string;
  kind: 'item' | 'coupon'; productId?: ID; couponKind?: 'percent' | 'fixed'; couponValue?: number; couponMinOrder?: number;
}
export interface RewardRedemption { id: ID; customerId: ID; rewardId: ID; points: number; ts: string; status: 'issued' | 'fulfilled' | 'cancelled'; couponId?: ID; code: string; idempotencyKey?: string }

export interface EventDoc {
  id: ID; name: string; description: string; status: 'draft' | 'active' | 'paused' | 'closed';
  boards: { id: ID; name: string; color: string }[]; min: number; max: number; reservationMinutes: number;
  terms: string; createdAt: string; winners: { id: ID; boardId: ID; number: number; prize: string; selectionId?: ID; customerId?: ID; ts: string }[];
}
export interface Entitlement { id: ID; eventId: ID; customerId: ID; orderId?: ID; promoId?: ID; ts: string; status: 'available' | 'used' | 'void'; selectionId?: ID }
export interface EventSelection {
  id: ID; eventId: ID; boardId: ID; number: number; customerId: ID; entitlementId: ID; status: 'reserved' | 'confirmed' | 'released' | 'reset';
  reservedUntil?: string; ts: string; confirmedAt?: string; releasedAt?: string; releaseReason?: string; resetId?: ID; onBehalfBy?: ID;
}
export interface EventAdminAction { id: ID; eventId: ID; ts: string; by: ID; action: 'release' | 'reset_board' | 'reset_event' | 'pause' | 'resume' | 'close' | 'winner' | 'activate'; detail: string; affected: number }

// ---------- accounting
export interface Account { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'; normal: 'debit' | 'credit'; group: string; contra?: boolean }
export interface JournalLine { account: string; debit: number; credit: number; memo?: string }
export interface Journal {
  id: ID; no: string; date: string; memo: string; refType: string; refId?: ID; lines: JournalLine[];
  status: 'posted' | 'reversed'; reverses?: ID; reversedBy?: ID; createdBy: ID; manual?: boolean;
}
export interface Expense { id: ID; no: string; date: string; account: string; vendor: string; amount: number; vat: number; paidFrom: 'cash' | 'bank'; branchId?: ID; note?: string; journalId?: ID; mediaId?: ID }

// ---------- printing
export type DocType = 'receipt' | 'kitchen_ticket' | 'beverage_ticket' | 'packing_slip' | 'picking_list' | 'purchase_order' | 'goods_receipt' | 'payment_receipt' | 'statement' | 'event_report';
export interface Printer {
  id: ID; name: string; model: string; branchId: ID; paper: '58mm' | '80mm' | 'A4'; connection: 'browser' | 'agent' | 'pdf';
  status: 'online' | 'offline'; agentName?: string; lastSeen?: string;
}
export interface PrintRule { id: ID; docType: DocType; station?: Station; branchId?: ID; orderType?: OrderType; printerId: ID; priority: number }
export interface PrintJob {
  id: ID; docType: DocType; refType: string; refId: ID; printerId: ID | null; status: 'queued' | 'printing' | 'printed' | 'failed' | 'cancelled';
  attempts: number; idempotencyKey: string; reprintOf?: ID; reprintReason?: string; createdAt: string; printedAt?: string;
  error?: string; copies: number; station?: Station; createdBy: ID; branchId?: ID;
}

// ---------- media
export interface MediaFile {
  id: ID; kind: 'product_image' | 'customer_upload' | 'payment_slip' | 'supplier_doc' | 'purchase_invoice' | 'accounting_doc' | 'production_image' | 'event_image';
  name: string; mime: string; size: number; checksum: string; status: 'scanning' | 'available' | 'quarantined'; private: boolean;
  linkedType?: string; linkedId?: ID; uploadedBy: ID; createdAt: string; width?: number; height?: number;
  variants: { name: string; width: number; height: number; size: number }[]; dataUrl?: string; scanNote?: string; isMain?: boolean; sort?: number;
}
export interface MediaAccess { id: ID; mediaId: ID; ts: string; userId: ID; action: 'view' | 'download' | 'signed_url'; }

// ---------- audit / settings
export interface AuditEntry { id: ID; ts: string; userId: ID; action: string; entity: string; entityId?: string; detail: string; severity: 'info' | 'warn' | 'critical' }
export interface LoyaltyConfig {
  earnBahtPerPoint: number; expiryMonths: number; categoryMultipliers: Record<string, number>;
  tiers: { name: string; minSpend: number; multiplier: number; color: string }[];
}

export interface DB {
  version: number;
  meta: { seq: Record<string, number>; lockedUntil: string | null; currentUserId: ID; seededAt: string; idem: Record<string, ID> };
  org: Org; branches: Branch[]; warehouses: Warehouse[]; roles: Role[]; users: User[];
  customers: Customer[]; products: Product[]; boms: Bom[];
  movements: Movement[]; balances: Record<string, Balance>; transfers: Transfer[]; counts: StockCount[];
  suppliers: Supplier[]; purchaseOrders: PurchaseOrder[]; grns: GoodsReceipt[]; apInvoices: SupplierInvoice[]; supplierPayments: SupplierPayment[]; supplierReturns: SupplierReturn[];
  productionOrders: ProductionOrder[];
  orders: Order[]; returns: ReturnDoc[]; receipts: Receipt[]; allocations: Allocation[]; slips: SlipRequest[];
  channelAccounts: ChannelAccount[]; mappings: ChannelMapping[]; externalOrders: ExternalOrder[]; syncJobs: SyncJob[]; settlements: Settlement[];
  promotions: Promotion[]; redemptions: PromoRedemption[]; coupons: Coupon[];
  pointsLedger: PointEntry[]; rewards: Reward[]; rewardRedemptions: RewardRedemption[]; loyalty: LoyaltyConfig;
  events: EventDoc[]; entitlements: Entitlement[]; selections: EventSelection[]; eventActions: EventAdminAction[]; eventIndex: Record<string, ID>;
  accounts: Account[]; journals: Journal[]; expenses: Expense[]; reconciled: Record<string, boolean>;
  printers: Printer[]; printRules: PrintRule[]; printJobs: PrintJob[];
  media: MediaFile[]; mediaAccess: MediaAccess[]; audit: AuditEntry[];
}
