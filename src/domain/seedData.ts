import type { Bom, BomComponent, ChannelAccount, ChannelMapping, Customer, DB, ModifierGroup, Printer, PrintRule, Product, Promotion, Reward, Role, Supplier, User } from './types';
import { CHART } from './accounting';
import { addDays } from '../lib/util';

type Lv = Record<string, { min: number; max: number }>;

export const ROLES: Role[] = [
  { id: 'role-owner', name: 'Owner / Super Admin', description: 'Full access including settings, period close and permissions', permissions: ['*'], system: true },
  {
    id: 'role-manager', name: 'Manager', description: 'Branch operations, approvals and branch profitability; no global financial settings', system: true,
    permissions: ['dashboard:*', 'pos:*', 'orders:*', 'channels:*', 'kds:*', 'customers:*', 'receivables:*', 'loyalty:*', 'promotions:*', 'events:*', 'events:reset', 'catalog:*', 'inventory:*', 'purchasing:*', 'production:*', 'reports:*', 'profit:view', 'printing:*', 'media:*', 'team:view', 'finance:cost', 'finance:profit', 'accounting:view'],
  },
  { id: 'role-cashier', name: 'Cashier', description: 'Create sales and receive payments. Cannot see product cost or profit', system: true, permissions: ['pos:view', 'pos:create', 'orders:view', 'orders:create', 'customers:view', 'customers:create', 'receivables:view', 'receivables:create', 'loyalty:view', 'events:view', 'printing:view', 'printing:create', 'catalog:view', 'promotions:view'] },
  { id: 'role-kitchen', name: 'Kitchen staff', description: 'Kitchen display only', system: true, permissions: ['kds:view', 'kds:edit', 'orders:view', 'printing:view'] },
  { id: 'role-barista', name: 'Barista / Beverage', description: 'Beverage station display', system: true, permissions: ['kds:view', 'kds:edit', 'orders:view', 'printing:view'] },
  { id: 'role-warehouse', name: 'Warehouse staff', description: 'Receive and transfer stock; cannot approve accounting', system: true, permissions: ['inventory:view', 'inventory:create', 'inventory:edit', 'catalog:view', 'purchasing:view', 'production:view', 'production:create', 'orders:view', 'printing:view', 'printing:create', 'media:view', 'media:create'] },
  { id: 'role-purchasing', name: 'Purchasing staff', description: 'Suppliers, POs and goods receipts', system: true, permissions: ['purchasing:*', 'inventory:view', 'catalog:view', 'finance:cost', 'media:view', 'media:create', 'printing:view'] },
  { id: 'role-accountant', name: 'Accountant', description: 'Accounting, receivables, reports and costing', system: true, permissions: ['dashboard:view', 'accounting:*', 'receivables:*', 'reports:*', 'profit:view', 'orders:view', 'orders:export', 'purchasing:view', 'inventory:view', 'catalog:view', 'finance:cost', 'finance:profit', 'media:*', 'customers:view', 'system:view'] },
  { id: 'role-marketing', name: 'Marketing staff', description: 'Promotions, loyalty and events; no cost or profit data', system: true, permissions: ['promotions:*', 'loyalty:*', 'events:view', 'events:create', 'events:edit', 'customers:view', 'reports:view', 'catalog:view', 'orders:view', 'media:*'] },
];

export const USERS: User[] = [
  { id: 'U1', name: 'Naree Wongsakul', email: 'naree@sabaidee.example', roleId: 'role-owner', branchIds: [], active: true, color: '#2a78d6' },
  { id: 'U2', name: 'Kittisak Chai', email: 'kittisak@sabaidee.example', roleId: 'role-manager', branchIds: [], active: true, color: '#1baf7a' },
  { id: 'U3', name: 'Mali Srisuk', email: 'mali@sabaidee.example', roleId: 'role-cashier', branchIds: ['B1'], active: true, color: '#eb6834' },
  { id: 'U4', name: 'Boon Thongdee', email: 'boon@sabaidee.example', roleId: 'role-cashier', branchIds: ['B2'], active: true, color: '#e87ba4' },
  { id: 'U5', name: 'Anan Prasert', email: 'anan@sabaidee.example', roleId: 'role-kitchen', branchIds: ['B1'], active: true, color: '#eda100' },
  { id: 'U6', name: 'Pimchanok Lee', email: 'pim@sabaidee.example', roleId: 'role-barista', branchIds: ['B1'], active: true, color: '#6250d6' },
  { id: 'U7', name: 'Somsak Rungrot', email: 'somsak@sabaidee.example', roleId: 'role-warehouse', branchIds: ['B3'], active: true, color: '#008300' },
  { id: 'U8', name: 'Rattana Phan', email: 'rattana@sabaidee.example', roleId: 'role-purchasing', branchIds: [], active: true, color: '#e34948' },
  { id: 'U9', name: 'Dao Karnjana', email: 'dao@sabaidee.example', roleId: 'role-accountant', branchIds: [], active: true, color: '#256abf' },
  { id: 'U10', name: 'Ploy Suwan', email: 'ploy@sabaidee.example', roleId: 'role-marketing', branchIds: [], active: true, color: '#d55181' },
];

const SWEET: ModifierGroup = { name: 'Sweetness', options: [{ name: 'Less sweet', priceDelta: 0 }, { name: 'Normal', priceDelta: 0 }, { name: 'Extra sweet', priceDelta: 0, add: [{ productId: 'M05', qty: 0.01 }] }] };
const SHOT: ModifierGroup = { name: 'Extra', options: [{ name: 'Extra shot', priceDelta: 20, add: [{ productId: 'F01', qty: 0.018 }] }] };
const OAT: ModifierGroup = { name: 'Milk', options: [{ name: 'Oat milk', priceDelta: 25, replace: { from: 'M03', to: 'M04' } }] };
const FOODMOD: ModifierGroup = { name: 'Serving', options: [{ name: 'Warmed', priceDelta: 0 }, { name: 'Cold', priceDelta: 0 }] };

interface PDef {
  id: string; sku: string; name: string; cat: string; kind: Product['kind']; unit: string; price: number; std: number; emoji: string; color: string;
  station?: Product['station']; sup?: string; levels?: Lv; mods?: ModifierGroup[]; lot?: boolean; ch?: Product['channelPrices']; barcode?: string; desc?: string;
}
const L = (min: number, max: number) => ({ min, max });

const PRODUCT_DEFS: PDef[] = [
  // raw materials
  { id: 'M01', sku: 'RM-GB-ETH', name: 'Green beans – Ethiopia Yirgacheffe', cat: 'Raw material', kind: 'material', unit: 'kg', price: 0, std: 420, emoji: '🫘', color: '#8a6d3b', sup: 'S1', levels: { W3: L(30, 90) } },
  { id: 'M02', sku: 'RM-GB-CR', name: 'Green beans – Chiang Rai', cat: 'Raw material', kind: 'material', unit: 'kg', price: 0, std: 310, emoji: '🫘', color: '#7a5c2e', sup: 'S1', levels: { W3: L(30, 90) } },
  { id: 'M03', sku: 'RM-MILK', name: 'Fresh milk', cat: 'Raw material', kind: 'material', unit: 'L', price: 0, std: 42, emoji: '🥛', color: '#9ec5f4', sup: 'S2', lot: true, levels: { W1: L(15, 40), W2: L(8, 20) } },
  { id: 'M04', sku: 'RM-OAT', name: 'Oat milk', cat: 'Raw material', kind: 'material', unit: 'L', price: 0, std: 95, emoji: '🌾', color: '#eda100', sup: 'S2', lot: true, levels: { W1: L(5, 15), W2: L(3, 8) } },
  { id: 'M05', sku: 'RM-SYR', name: 'Simple syrup', cat: 'Raw material', kind: 'material', unit: 'L', price: 0, std: 60, emoji: '🍯', color: '#eb6834', sup: 'S2', levels: { W1: L(2, 6), W2: L(1, 3) } },
  { id: 'M06', sku: 'RM-MATCHA', name: 'Matcha powder', cat: 'Raw material', kind: 'material', unit: 'kg', price: 0, std: 1450, emoji: '🍵', color: '#1baf7a', sup: 'S7', levels: { W1: L(0.4, 1.5), W2: L(0.2, 0.8) } },
  { id: 'M07', sku: 'RM-COCOA', name: 'Cocoa powder', cat: 'Raw material', kind: 'material', unit: 'kg', price: 0, std: 380, emoji: '🍫', color: '#7a4a2e', sup: 'S7', levels: { W1: L(0.5, 2), W2: L(0.3, 1) } },
  { id: 'M08', sku: 'RM-ICE', name: 'Ice', cat: 'Raw material', kind: 'material', unit: 'kg', price: 0, std: 5, emoji: '🧊', color: '#86b6ef', sup: 'S2', levels: { W1: L(20, 60), W2: L(10, 30) } },
  { id: 'M09', sku: 'RM-CROI', name: 'Frozen croissant dough', cat: 'Raw material', kind: 'material', unit: 'pcs', price: 0, std: 16, emoji: '🥐', color: '#eda100', sup: 'S4', lot: true, levels: { W1: L(20, 60) } },
  { id: 'M10', sku: 'RM-HAMCH', name: 'Ham & cheese filling', cat: 'Raw material', kind: 'material', unit: 'portion', price: 0, std: 22, emoji: '🧀', color: '#fab219', sup: 'S4', lot: true, levels: { W1: L(10, 30) } },
  { id: 'M11', sku: 'RM-BRWN', name: 'Brownie (pre-baked)', cat: 'Raw material', kind: 'material', unit: 'pcs', price: 0, std: 24, emoji: '🍰', color: '#7a4a2e', sup: 'S4', lot: true, levels: { W1: L(10, 30) } },
  // packaging
  { id: 'K01', sku: 'PK-BAG250', name: 'Kraft zip bag 250 g', cat: 'Packaging', kind: 'packaging', unit: 'pcs', price: 0, std: 2.8, emoji: '📦', color: '#a38a5c', sup: 'S3', levels: { W3: L(160, 400) } },
  { id: 'K02', sku: 'PK-LABEL', name: 'Label sticker', cat: 'Packaging', kind: 'packaging', unit: 'pcs', price: 0, std: 0.9, emoji: '🏷️', color: '#a38a5c', sup: 'S3', levels: { W3: L(240, 600) } },
  { id: 'K03', sku: 'PK-BOTTLE', name: 'Glass bottle 250 ml', cat: 'Packaging', kind: 'packaging', unit: 'pcs', price: 0, std: 9, emoji: '🍼', color: '#86b6ef', sup: 'S3', levels: { W3: L(70, 180) } },
  { id: 'K04', sku: 'PK-HOT8', name: 'Hot cup 8 oz + lid', cat: 'Packaging', kind: 'packaging', unit: 'pcs', price: 0, std: 3.2, emoji: '☕', color: '#a38a5c', sup: 'S3', levels: { W1: L(120, 400), W2: L(60, 200) } },
  { id: 'K05', sku: 'PK-COLD16', name: 'Cold cup 16 oz + lid', cat: 'Packaging', kind: 'packaging', unit: 'pcs', price: 0, std: 3.8, emoji: '🥤', color: '#a38a5c', sup: 'S3', levels: { W1: L(180, 500), W2: L(90, 250) } },
  { id: 'K06', sku: 'PK-BOX', name: 'Shipping box (S)', cat: 'Packaging', kind: 'packaging', unit: 'pcs', price: 0, std: 7, emoji: '📦', color: '#a38a5c', sup: 'S3', levels: { W3: L(30, 100) } },
  // finished goods (manufactured)
  { id: 'F01', sku: 'FG-ROAST-HB', name: 'Roasted beans – House Blend (bulk)', cat: 'Bulk roasted', kind: 'finished', unit: 'kg', price: 0, std: 498, emoji: '🔥', color: '#7a4a2e', levels: { W3: L(26, 60), W1: L(2, 8), W2: L(1, 4) }, lot: true },
  { id: 'F02', sku: 'FG-HB-250', name: 'House Blend 250 g', cat: 'Coffee Beans', kind: 'finished', unit: 'bag', price: 189, std: 132, emoji: '☕', color: '#2a78d6', levels: { W3: L(30, 90), W1: L(6, 20), W2: L(6, 15) }, ch: { SHOPEE: 209, LAZADA: 209, TIKTOK: 205, LINE: 189 }, barcode: '8850000100021', lot: true, desc: 'Medium roast, notes of chocolate and caramel. Roasted in-house.' },
  { id: 'F03', sku: 'FG-ETH-250', name: 'Ethiopia Single Origin 250 g', cat: 'Coffee Beans', kind: 'finished', unit: 'bag', price: 289, std: 153, emoji: '🌸', color: '#e87ba4', levels: { W3: L(20, 60), W1: L(4, 12), W2: L(3, 8) }, ch: { SHOPEE: 319, LAZADA: 319, TIKTOK: 309, LINE: 289 }, barcode: '8850000100038', lot: true, desc: 'Floral and citrus. Light roast.' },
  { id: 'F04', sku: 'FG-CB-250', name: 'Cold Brew 250 ml bottle', cat: 'Ready-to-drink', kind: 'finished', unit: 'bottle', price: 85, std: 42, emoji: '🧋', color: '#1c5cab', levels: { W3: L(20, 60), W1: L(8, 24), W2: L(6, 18) }, ch: { SHOPEE: 95, LAZADA: 95, TIKTOK: 92, LINE: 85 }, barcode: '8850000100045', lot: true },
  // resale
  { id: 'R01', sku: 'MD-V60', name: 'Ceramic V60 dripper', cat: 'Merchandise', kind: 'resale', unit: 'pcs', price: 390, std: 180, emoji: '🫖', color: '#eb6834', sup: 'S5', levels: { W3: L(6, 20), W1: L(2, 6) }, ch: { SHOPEE: 429, LAZADA: 429, TIKTOK: 419, LINE: 390 }, barcode: '8850000200012' },
  { id: 'R02', sku: 'MD-MUG', name: 'Stoneware mug 300 ml', cat: 'Merchandise', kind: 'resale', unit: 'pcs', price: 220, std: 95, emoji: '🥣', color: '#6250d6', sup: 'S5', levels: { W3: L(6, 20), W1: L(3, 8) }, ch: { SHOPEE: 239, LAZADA: 239, TIKTOK: 235, LINE: 220 }, barcode: '8850000200029' },
  { id: 'R03', sku: 'SN-COOKIE', name: 'Choco cookie pack', cat: 'Snacks', kind: 'resale', unit: 'pack', price: 55, std: 28, emoji: '🍪', color: '#eda100', sup: 'S6', levels: { W1: L(10, 30), W2: L(6, 18), W3: L(10, 30) }, barcode: '8850000300019', lot: true },
  { id: 'R04', sku: 'SN-WATER', name: 'Mineral water 600 ml', cat: 'Snacks', kind: 'resale', unit: 'bottle', price: 15, std: 4.5, emoji: '💧', color: '#86b6ef', sup: 'S6', levels: { W1: L(24, 72), W2: L(12, 36) }, barcode: '8850000300026' },
  { id: 'R05', sku: 'MD-FILTER', name: 'Paper filters (100 pcs)', cat: 'Merchandise', kind: 'resale', unit: 'box', price: 169, std: 85, emoji: '🧻', color: '#c3c2b7', sup: 'S5', levels: { W3: L(10, 30) }, ch: { SHOPEE: 185, LAZADA: 185, TIKTOK: 179, LINE: 169 }, barcode: '8850000200036' },
  { id: 'R06', sku: 'MD-TOTE', name: 'Canvas tote bag', cat: 'Merchandise', kind: 'resale', unit: 'pcs', price: 190, std: 70, emoji: '👜', color: '#1baf7a', sup: 'S5', levels: { W3: L(10, 30) }, ch: { SHOPEE: 209, LAZADA: 209, TIKTOK: 199, LINE: 190 }, barcode: '8850000200043' },
  { id: 'R07', sku: 'SN-GRANOLA', name: 'Granola bar', cat: 'Snacks', kind: 'resale', unit: 'pcs', price: 45, std: 18, emoji: '🌰', color: '#a38a5c', sup: 'S6', levels: { W1: L(10, 30), W2: L(6, 18) }, barcode: '8850000300033', lot: true },
  // menu (recipe → backflush)
  { id: 'D01', sku: 'MN-ESP', name: 'Espresso', cat: 'Drinks', kind: 'menu', unit: 'cup', price: 55, std: 20, emoji: '☕', color: '#7a4a2e', station: 'beverage', mods: [SWEET, SHOT] },
  { id: 'D02', sku: 'MN-AME', name: 'Iced Americano', cat: 'Drinks', kind: 'menu', unit: 'cup', price: 60, std: 22, emoji: '🧊', color: '#1c5cab', station: 'beverage', mods: [SWEET, SHOT] },
  { id: 'D03', sku: 'MN-LAT', name: 'Latte (hot)', cat: 'Drinks', kind: 'menu', unit: 'cup', price: 70, std: 28, emoji: '🥛', color: '#eda100', station: 'beverage', mods: [SWEET, SHOT, OAT] },
  { id: 'D04', sku: 'MN-ILAT', name: 'Iced Latte', cat: 'Drinks', kind: 'menu', unit: 'cup', price: 75, std: 29, emoji: '🧋', color: '#86b6ef', station: 'beverage', mods: [SWEET, SHOT, OAT] },
  { id: 'D05', sku: 'MN-OATL', name: 'Iced Oat Latte', cat: 'Drinks', kind: 'menu', unit: 'cup', price: 90, std: 38, emoji: '🌾', color: '#1baf7a', station: 'beverage', mods: [SWEET, SHOT] },
  { id: 'D06', sku: 'MN-MATCHA', name: 'Matcha Latte', cat: 'Drinks', kind: 'menu', unit: 'cup', price: 85, std: 34, emoji: '🍵', color: '#008300', station: 'beverage', mods: [SWEET, OAT] },
  { id: 'D07', sku: 'MN-MOCHA', name: 'Mocha', cat: 'Drinks', kind: 'menu', unit: 'cup', price: 85, std: 33, emoji: '🍫', color: '#7a4a2e', station: 'beverage', mods: [SWEET, SHOT, OAT] },
  { id: 'FD1', sku: 'MN-CROI', name: 'Butter Croissant', cat: 'Food', kind: 'menu', unit: 'pcs', price: 65, std: 25, emoji: '🥐', color: '#eda100', station: 'kitchen', mods: [FOODMOD] },
  { id: 'FD2', sku: 'MN-CROIHC', name: 'Ham & Cheese Croissant', cat: 'Food', kind: 'menu', unit: 'pcs', price: 95, std: 47, emoji: '🥪', color: '#eb6834', station: 'kitchen', mods: [FOODMOD] },
  { id: 'FD3', sku: 'MN-BROWNIE', name: 'Chocolate Brownie', cat: 'Food', kind: 'menu', unit: 'pcs', price: 75, std: 27, emoji: '🍰', color: '#7a4a2e', station: 'kitchen' },
];

export function buildProducts(): Product[] {
  return PRODUCT_DEFS.map((p) => ({
    id: p.id, sku: p.sku, name: p.name, category: p.cat, kind: p.kind, unit: p.unit, price: p.price, channelPrices: p.ch ?? {}, barcode: p.barcode,
    active: true, emoji: p.emoji, color: p.color, stdCost: p.std, levels: p.levels ?? {}, station: p.station ?? null, supplierId: p.sup, modifiers: p.mods,
    trackLot: p.lot, mediaIds: [], description: p.desc,
  }));
}

const C = (productId: string, qty: number, role: BomComponent['role'] = 'material'): BomComponent => ({ productId, qty, role });
export function buildBoms(startIso: string): Bom[] {
  const mk = (id: string, productId: string, name: string, type: Bom['type'], y: number, comps: BomComponent[], labor: number, oh: number, notes = ''): Bom => ({
    id, productId, name, type,
    versions: [{ version: 1, status: 'active', effectiveFrom: startIso, yieldQty: y, components: comps, laborCost: labor, overheadCost: oh, notes, createdAt: startIso }],
  });
  const cup = (id: string, pid: string, name: string, comps: BomComponent[]) => mk(id, pid, name, 'recipe', 1, comps, 6, 3, 'Barista labor + machine overhead per cup');
  return [
    mk('BM-F01', 'F01', 'Roast – House Blend', 'manufacturing', 10, [C('M01', 6), C('M02', 6)], 350, 250, '12 kg green → ~10 kg roasted (≈15% roast loss)'),
    mk('BM-F02', 'F02', 'Pack – House Blend 250 g', 'packaging', 40, [C('F01', 10), C('K01', 40, 'packaging'), C('K02', 40, 'packaging')], 120, 40, '40 bags per batch'),
    mk('BM-F03', 'F03', 'Roast & pack – Ethiopia 250 g', 'manufacturing', 40, [C('M01', 11.8), C('K01', 40, 'packaging'), C('K02', 40, 'packaging')], 600, 400, 'Light roast, 40 bags per batch'),
    mk('BM-F04', 'F04', 'Cold brew – 250 ml', 'manufacturing', 30, [C('F01', 1.5), C('K03', 30, 'packaging'), C('K02', 30, 'packaging')], 150, 60, '18 h steep'),
    cup('BM-D01', 'D01', 'Espresso', [C('F01', 0.018), C('K04', 1, 'packaging')]),
    cup('BM-D02', 'D02', 'Iced Americano', [C('F01', 0.018), C('M08', 0.15), C('K05', 1, 'packaging')]),
    cup('BM-D03', 'D03', 'Latte (hot)', [C('F01', 0.018), C('M03', 0.2), C('K04', 1, 'packaging')]),
    cup('BM-D04', 'D04', 'Iced Latte', [C('F01', 0.018), C('M03', 0.18), C('M08', 0.12), C('K05', 1, 'packaging')]),
    cup('BM-D05', 'D05', 'Iced Oat Latte', [C('F01', 0.018), C('M04', 0.2), C('M08', 0.12), C('K05', 1, 'packaging')]),
    cup('BM-D06', 'D06', 'Matcha Latte', [C('M06', 0.012), C('M03', 0.2), C('M05', 0.015), C('M08', 0.1), C('K05', 1, 'packaging')]),
    cup('BM-D07', 'D07', 'Mocha', [C('F01', 0.018), C('M07', 0.02), C('M03', 0.18), C('K04', 1, 'packaging')]),
    mk('BM-FD1', 'FD1', 'Butter Croissant', 'recipe', 1, [C('M09', 1)], 5, 4, 'Bake 14 min @ 180°C'),
    mk('BM-FD2', 'FD2', 'Ham & Cheese Croissant', 'recipe', 1, [C('M09', 1), C('M10', 1)], 6, 4),
    mk('BM-FD3', 'FD3', 'Chocolate Brownie', 'recipe', 1, [C('M11', 1)], 2, 1),
  ];
}

export const SUPPLIERS: Supplier[] = [
  { id: 'S1', code: 'DCF', name: 'Doi Chang Farmers Co-op', contact: 'Khun Somporn', phone: '053-555-0101', termsDays: 14, vatable: false, rating: 5, productIds: ['M01', 'M02'], taxId: '0105551000011' },
  { id: 'S2', code: 'BKD', name: 'Bangkok Dairy & Ice Co.', contact: 'Khun Wichai', phone: '02-555-0102', termsDays: 7, vatable: true, rating: 4, productIds: ['M03', 'M04', 'M05', 'M08'], taxId: '0105551000028' },
  { id: 'S3', code: 'PKT', name: 'PackThai Supplies', contact: 'Khun Jintana', phone: '02-555-0103', termsDays: 30, vatable: true, rating: 4, productIds: ['K01', 'K02', 'K03', 'K04', 'K05', 'K06'], taxId: '0105551000035' },
  { id: 'S4', code: 'SGF', name: 'Siam Gourmet Foods', contact: 'Khun Preecha', phone: '02-555-0104', termsDays: 15, vatable: true, rating: 4, productIds: ['M09', 'M10', 'M11'], taxId: '0105551000042' },
  { id: 'S5', code: 'BGI', name: 'BrewGear Imports', contact: 'Khun Nicha', phone: '02-555-0105', termsDays: 30, vatable: true, rating: 5, productIds: ['R01', 'R02', 'R05', 'R06'], taxId: '0105551000059' },
  { id: 'S6', code: 'SNH', name: 'Snack Hub Trading', contact: 'Khun Tee', phone: '02-555-0106', termsDays: 15, vatable: true, rating: 3, productIds: ['R03', 'R04', 'R07'], taxId: '0105551000066' },
  { id: 'S7', code: 'MKT', name: 'Matcha Kyoto Trading', contact: 'Khun Aoi', phone: '02-555-0107', termsDays: 21, vatable: true, rating: 5, productIds: ['M06', 'M07'], taxId: '0105551000073' },
];

const FIRST = ['Somchai', 'Anong', 'Pim', 'Nattapon', 'Kanya', 'Wirat', 'Suda', 'Thanakorn', 'Orn', 'Piyawat', 'Jirapa', 'Chaiwat', 'Napat', 'Siriporn', 'Kritsada', 'Mayuree', 'Arthit', 'Pranee', 'Ekkachai', 'Lalita', 'Surasak', 'Ratree', 'Veera', 'Duangjai'];
const LAST = ['Kaewmanee', 'Srisuwan', 'Rattanakul', 'Boonmee', 'Chaiyasit', 'Phromma', 'Sukhum', 'Wongchai', 'Thongkham', 'Jaidee', 'Saelim', 'Pattanasin'];
export function buildCustomers(nowIso: string): Customer[] {
  const out: Customer[] = [];
  const cafes = ['Café Mali', 'Hom Mali Bistro', 'Baan Rim Nam', 'Little Bean Roasters', 'Sook Sabai Hotel', 'The Garden Brunch'];
  cafes.forEach((name, i) => {
    out.push({ id: `C${String(i + 1).padStart(3, '0')}`, code: `W-${String(i + 1).padStart(3, '0')}`, name, phone: `02-77${i}-01${i}${i}`, email: `buy@cafe${i + 1}.example`, group: 'wholesale', creditLimit: [40000, 30000, 25000, 50000, 60000, 20000][i], creditDays: [30, 30, 15, 45, 30, 15][i], consent: { pdpa: true, marketing: false, at: addDays(nowIso, -120).toISOString() }, createdAt: addDays(nowIso, -120).toISOString(), address: `${10 + i}/${i + 4} Sukhumvit Rd, Bangkok`, note: 'Wholesale account' });
  });
  for (let i = 0; i < 24; i++) {
    const n = out.length + 1;
    const vip = i % 8 === 0;
    out.push({
      id: `C${String(n).padStart(3, '0')}`, code: `M-${String(i + 1).padStart(4, '0')}`, name: `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`, phone: `08${(i * 7 + 1) % 10}-${String(100 + i * 13).slice(0, 3)}-${String(1000 + i * 37).slice(0, 4)}`,
      lineUserId: `U${(0xa1b2c3d4 + i * 7919).toString(16)}`, group: vip ? 'vip' : i === 23 ? 'staff' : 'retail', creditLimit: 0, creditDays: 0,
      consent: { pdpa: true, marketing: i % 3 !== 0, at: addDays(nowIso, -90 + i).toISOString() }, createdAt: addDays(nowIso, -90 + i).toISOString(),
      birthday: `199${i % 10}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
    });
  }
  return out;
}

export function buildPromotions(nowIso: string, eventId: string): Promotion[] {
  const d = (n: number) => addDays(nowIso, n).toISOString();
  const base = { description: '', stacking: 'stackable' as const, channels: [], branchIds: [], customerGroups: [], limits: { perOrder: 1 } };
  return [
    { ...base, id: 'PM1', name: 'Weekend beans 10% off', description: 'Sat–Sun: 10% off all coffee beans (POS, LINE).', status: 'active', priority: 50, stacking: 'exclusive', startAt: d(-60), endAt: d(30), channels: ['POS', 'LINE'], weekdays: [0, 6], categories: ['Coffee Beans'], action: { type: 'percent', value: 10 } },
    { ...base, id: 'PM2', name: 'Lucky Draw: ฿500 → 1 number', description: 'Every ฿500 in a single bill earns one pick on the Lucky Draw boards (max 5).', status: 'active', priority: 40, startAt: d(-12), endAt: d(20), channels: ['POS', 'LINE'], requireCustomer: true, action: { type: 'event_entitlement', eventId, perAmount: 500, maxPerOrder: 5 } },
    { ...base, id: 'PM3', name: 'Latte + Croissant combo ฿119', description: 'Hot latte with a butter croissant for ฿119.', status: 'active', priority: 60, stacking: 'exclusive', startAt: d(-30), endAt: d(60), channels: ['POS'], action: { type: 'bundle_price', value: 119, bundleProductIds: ['D03', 'FD1'] }, limits: { perOrder: 3 } },
    { ...base, id: 'PM4', name: 'Double points Tuesday', description: 'Members earn 2× points every Tuesday.', status: 'active', priority: 30, startAt: d(-90), endAt: d(60), weekdays: [2], requireCustomer: true, action: { type: 'bonus_points', bonusMode: 'multiplier', value: 1 } },
    { ...base, id: 'PM5', name: 'WELCOME50 coupon code', description: '฿50 off a first order of ฿300+. One per customer.', code: 'WELCOME50', status: 'active', priority: 70, stacking: 'stackable', startAt: d(-60), endAt: d(60), minOrder: 300, requireCustomer: true, limits: { perOrder: 1, perCustomer: 1, total: 200 }, budget: 10000, action: { type: 'fixed', value: 50 } },
    { ...base, id: 'PM6', name: 'Shopee 11.11 flash 12%', description: 'Marketplace campaign on merchandise (expired — platform sets final prices).', status: 'active', priority: 20, startAt: d(-14), endAt: d(-2), channels: ['SHOPEE'], categories: ['Merchandise'], budget: 5000, action: { type: 'percent', value: 12 } },
    { ...base, id: 'PM7', name: 'LINE MAN free cookie ฿250+', description: 'Free cookie pack on LINE MAN orders over ฿250 (draft — pending platform approval).', status: 'draft', priority: 10, startAt: d(0), endAt: d(30), channels: ['LINEMAN'], minOrder: 250, action: { type: 'free_item', productId: 'R03', qty: 1 } },
    { ...base, id: 'PM8', name: 'Mid-month sale 15%', description: 'Planned: 15% off merchandise on the 15th–16th.', status: 'draft', priority: 25, startAt: d(2), endAt: d(4), categories: ['Merchandise'], action: { type: 'percent', value: 15 } },
    { ...base, id: 'PM9', name: 'Big basket ฿1,000 → ฿100 coupon', description: 'Spend ฿1,000+ and get a ฿100 coupon for next time (members).', status: 'active', priority: 35, startAt: d(-45), endAt: d(45), minOrder: 1000, requireCustomer: true, limits: { perOrder: 1, perCustomer: 3 }, action: { type: 'coupon', couponValue: 100, couponDays: 30 } },
  ];
}

export const REWARDS: Reward[] = [
  { id: 'RW1', name: 'Free espresso', description: 'One espresso at any branch', cost: 200, stock: null, active: true, emoji: '☕', kind: 'item', productId: 'D01' },
  { id: 'RW2', name: '฿50 voucher', description: '฿50 off orders from ฿200', cost: 300, stock: null, active: true, emoji: '🎟️', kind: 'coupon', couponKind: 'fixed', couponValue: 50, couponMinOrder: 200 },
  { id: 'RW3', name: '15% off any beans', description: '15% off one purchase', cost: 500, stock: null, active: true, emoji: '🫘', kind: 'coupon', couponKind: 'percent', couponValue: 15 },
  { id: 'RW4', name: 'Canvas tote bag', description: 'Limited stock', cost: 900, stock: 20, active: true, emoji: '👜', kind: 'item', productId: 'R06' },
  { id: 'RW5', name: 'Ceramic V60 dripper', description: 'Limited stock', cost: 2500, stock: 5, active: true, emoji: '🫖', kind: 'item', productId: 'R01' },
];

export const CHANNEL_ACCOUNTS: ChannelAccount[] = [
  { channel: 'POS', name: 'Store POS', enabled: true, connection: 'native', verified: true, shopName: 'Sabaidee Roasters', commissionPct: 0, paymentFeePct: 0, shippingSubsidy: 0, settlementDays: 0 },
  { channel: 'LINE', name: 'LINE OA / LIFF shop', enabled: true, connection: 'native', verified: true, shopName: '@sabaidee-roasters', commissionPct: 0, paymentFeePct: 0, shippingSubsidy: 0, settlementDays: 0 },
  { channel: 'SHOPEE', name: 'Shopee shop', enabled: true, connection: 'api', verified: false, shopName: 'sabaidee.roasters', commissionPct: 6.5, paymentFeePct: 3, shippingSubsidy: 15, settlementDays: 7 },
  { channel: 'LAZADA', name: 'Lazada shop', enabled: true, connection: 'api', verified: false, shopName: 'Sabaidee Roasters Official', commissionPct: 5.5, paymentFeePct: 2.5, shippingSubsidy: 12, settlementDays: 7 },
  { channel: 'TIKTOK', name: 'TikTok Shop', enabled: true, connection: 'csv', verified: false, shopName: '@sabaidee.roasters', commissionPct: 4, paymentFeePct: 2.5, shippingSubsidy: 10, settlementDays: 5 },
  { channel: 'LINEMAN', name: 'LINE MAN Wongnai', enabled: true, connection: 'csv', verified: false, shopName: 'Sabaidee Café – Ari', commissionPct: 30, paymentFeePct: 3, shippingSubsidy: 0, settlementDays: 7 },
];

export function buildMappings(products: Product[]): ChannelMapping[] {
  const out: ChannelMapping[] = [];
  let n = 0;
  const px = { SHOPEE: 'SPE', LAZADA: 'LZD', TIKTOK: 'TTS', LINEMAN: 'LMN' } as const;
  for (const ch of ['SHOPEE', 'LAZADA', 'TIKTOK'] as const) {
    for (const p of products.filter((x) => ['F02', 'F03', 'F04', 'R01', 'R02', 'R05', 'R06'].includes(x.id))) {
      out.push({ id: `MP${++n}`, channel: ch, externalSku: `${px[ch]}-${p.id}`, productId: p.id, externalName: `Sabaidee ${p.name}` });
      (p.listingMap ||= {})[ch] = `${px[ch]}-${p.id}`;
    }
  }
  for (const p of products.filter((x) => x.kind === 'menu')) {
    out.push({ id: `MP${++n}`, channel: 'LINEMAN', externalSku: `LMN-${p.id}`, productId: p.id, externalName: p.name });
    (p.listingMap ||= {}).LINEMAN = `LMN-${p.id}`;
  }
  out.push({ id: `MP${++n}`, channel: 'SHOPEE', externalSku: 'SPE-GIFTSET', productId: null, externalName: 'Gift set (beans + mug) — new listing' });
  return out;
}

export const PRINTERS: Printer[] = [
  { id: 'PT1', name: 'Cashier – Epson TM-T82', model: 'Epson TM-T82 (USB)', branchId: 'B1', paper: '80mm', connection: 'agent', status: 'online', agentName: 'ari-pos-pc' },
  { id: 'PT2', name: 'Kitchen – Star TSP143', model: 'Star TSP143III (LAN)', branchId: 'B1', paper: '80mm', connection: 'agent', status: 'online', agentName: 'ari-pos-pc' },
  { id: 'PT3', name: 'Beverage bar – Xprinter XP-58', model: 'Xprinter XP-58IIH (BT)', branchId: 'B1', paper: '58mm', connection: 'agent', status: 'offline', agentName: 'ari-bar-tablet' },
  { id: 'PT4', name: 'Kiosk – browser printing', model: 'Any (Chrome print dialog)', branchId: 'B2', paper: '80mm', connection: 'browser', status: 'online' },
  { id: 'PT5', name: 'Warehouse – Brother HL-L2350', model: 'Brother HL-L2350DW (A4)', branchId: 'B3', paper: 'A4', connection: 'agent', status: 'online', agentName: 'hub-pc' },
  { id: 'PT6', name: 'PDF export', model: 'PDF adapter', branchId: 'B3', paper: 'A4', connection: 'pdf', status: 'online' },
];
export const PRINT_RULES: PrintRule[] = [
  { id: 'PRL1', docType: 'receipt', branchId: 'B1', printerId: 'PT1', priority: 10 },
  { id: 'PRL2', docType: 'receipt', branchId: 'B2', printerId: 'PT4', priority: 10 },
  { id: 'PRL3', docType: 'kitchen_ticket', station: 'kitchen', branchId: 'B1', printerId: 'PT2', priority: 10 },
  { id: 'PRL4', docType: 'beverage_ticket', station: 'beverage', branchId: 'B1', printerId: 'PT3', priority: 10 },
  { id: 'PRL5', docType: 'beverage_ticket', station: 'beverage', branchId: 'B2', printerId: 'PT4', priority: 10 },
  { id: 'PRL6', docType: 'picking_list', printerId: 'PT5', priority: 5 },
  { id: 'PRL7', docType: 'packing_slip', printerId: 'PT5', priority: 5 },
  { id: 'PRL8', docType: 'goods_receipt', printerId: 'PT5', priority: 5 },
  { id: 'PRL9', docType: 'purchase_order', printerId: 'PT6', priority: 5 },
  { id: 'PRL10', docType: 'payment_receipt', printerId: 'PT1', priority: 5 },
  { id: 'PRL11', docType: 'statement', printerId: 'PT6', priority: 5 },
  { id: 'PRL12', docType: 'event_report', printerId: 'PT6', priority: 5 },
  { id: 'PRL13', docType: 'kitchen_ticket', station: 'kitchen', printerId: 'PT2', priority: 1 },
];

export function emptyDB(nowIso: string): DB {
  return {
    version: 4,
    meta: { seq: {}, lockedUntil: null, currentUserId: 'U1', seededAt: nowIso, idem: {} },
    org: {
      name: 'Sabaidee Roasters & Café', legalName: 'Sabaidee Roasters Co., Ltd.', taxId: '0105559012345', address: '88 Phahonyothin Rd, Ari, Bangkok 10400', phone: '02-555-0188',
      vatRate: 0.07, vatRegistered: true, currency: 'THB', costingMethod: 'WAC', allowNegativeStock: false, allocateOpex: 'none', receiptFooter: 'Thank you · ขอบคุณที่อุดหนุน ☕', promptPayId: '0812345678', pointValue: 0.2,
    },
    branches: [
      { id: 'B1', code: 'ARI', name: 'Ari Flagship Café', type: 'kitchen', defaultWarehouseId: 'W1', address: '88 Phahonyothin Rd, Ari' },
      { id: 'B2', code: 'TL', name: 'Thonglor Kiosk', type: 'store', defaultWarehouseId: 'W2', address: '12 Sukhumvit 55, Thonglor' },
      { id: 'B3', code: 'HUB', name: 'Online & Fulfilment Hub', type: 'online', defaultWarehouseId: 'W3', address: '5 Lat Phrao 71, Bangkok' },
    ],
    warehouses: [
      { id: 'W1', code: 'ARI-K', name: 'Ari store & kitchen', branchId: 'B1', kind: 'kitchen' },
      { id: 'W2', code: 'TL-S', name: 'Thonglor stock', branchId: 'B2', kind: 'store' },
      { id: 'W3', code: 'HUB-C', name: 'Central warehouse & roastery', branchId: 'B3', kind: 'central' },
    ],
    roles: ROLES, users: USERS, customers: [], products: [], boms: [],
    movements: [], balances: {}, transfers: [], counts: [],
    suppliers: SUPPLIERS, purchaseOrders: [], grns: [], apInvoices: [], supplierPayments: [], supplierReturns: [], productionOrders: [],
    orders: [], returns: [], receipts: [], allocations: [], slips: [],
    channelAccounts: CHANNEL_ACCOUNTS.map((a) => ({ ...a })), mappings: [], externalOrders: [], syncJobs: [], settlements: [],
    promotions: [], redemptions: [], coupons: [], pointsLedger: [], rewards: REWARDS, rewardRedemptions: [],
    loyalty: {
      earnBahtPerPoint: 25, expiryMonths: 12, categoryMultipliers: { 'Coffee Beans': 1.5, 'Ready-to-drink': 1.2 },
      tiers: [{ name: 'Silver', minSpend: 0, multiplier: 1, color: '#898781' }, { name: 'Gold', minSpend: 8000, multiplier: 1.25, color: '#eda100' }, { name: 'Platinum', minSpend: 25000, multiplier: 1.5, color: '#6250d6' }],
    },
    events: [], entitlements: [], selections: [], eventActions: [], eventIndex: {},
    accounts: CHART, journals: [], expenses: [], reconciled: {},
    printers: PRINTERS, printRules: PRINT_RULES, printJobs: [], media: [], mediaAccess: [], audit: [],
  };
}
