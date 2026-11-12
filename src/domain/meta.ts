import type { ChannelCode, OrderStatus } from './types';

export interface ChannelMeta {
  code: ChannelCode; label: string; short: string; color: string; flow: 'retail' | 'food' | 'pos';
  collectedBy: 'merchant' | 'platform'; recognizeAt: OrderStatus | 'immediate'; kind: 'store' | 'online' | 'marketplace' | 'delivery';
}
export const CHANNELS: Record<ChannelCode, ChannelMeta> = {
  POS: { code: 'POS', label: 'POS / Store', short: 'POS', color: '#2a78d6', flow: 'pos', collectedBy: 'merchant', recognizeAt: 'immediate', kind: 'store' },
  LINE: { code: 'LINE', label: 'LINE OA / LIFF', short: 'LINE', color: '#1baf7a', flow: 'retail', collectedBy: 'merchant', recognizeAt: 'shipped', kind: 'online' },
  SHOPEE: { code: 'SHOPEE', label: 'Shopee', short: 'Shopee', color: '#eb6834', flow: 'retail', collectedBy: 'platform', recognizeAt: 'shipped', kind: 'marketplace' },
  LAZADA: { code: 'LAZADA', label: 'Lazada', short: 'Lazada', color: '#6250d6', flow: 'retail', collectedBy: 'platform', recognizeAt: 'shipped', kind: 'marketplace' },
  TIKTOK: { code: 'TIKTOK', label: 'TikTok Shop', short: 'TikTok', color: '#e87ba4', flow: 'retail', collectedBy: 'platform', recognizeAt: 'shipped', kind: 'marketplace' },
  LINEMAN: { code: 'LINEMAN', label: 'LINE MAN', short: 'LINE MAN', color: '#eda100', flow: 'food', collectedBy: 'platform', recognizeAt: 'preparing', kind: 'delivery' },
};
export const CHANNEL_LIST = Object.values(CHANNELS);
export const channelColor = (c: ChannelCode) => CHANNELS[c].color;

export const FLOWS: Record<'retail' | 'food' | 'pos', OrderStatus[]> = {
  retail: ['new', 'confirmed', 'packed', 'shipped', 'completed'],
  food: ['new', 'preparing', 'ready', 'completed'],
  pos: ['completed'],
};
export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: 'New', confirmed: 'Confirmed', preparing: 'Preparing', packed: 'Packed', ready: 'Ready', shipped: 'Shipped',
  completed: 'Completed', cancelled: 'Cancelled', returned: 'Returned',
};
export const PAY_METHODS = [
  { key: 'cash', label: 'Cash' }, { key: 'qr', label: 'PromptPay QR' }, { key: 'transfer', label: 'Bank transfer' },
  { key: 'card', label: 'Card' }, { key: 'other', label: 'Other' },
] as const;
export const payLabel = (k: string) => PAY_METHODS.find((m) => m.key === k)?.label ?? k;

export const PRODUCT_KIND_LABEL: Record<string, string> = {
  resale: 'Resale', finished: 'Finished good', menu: 'Menu item (recipe)', material: 'Raw material', packaging: 'Packaging',
};
export const DOC_LABEL: Record<string, string> = {
  receipt: 'Customer receipt', kitchen_ticket: 'Kitchen ticket', beverage_ticket: 'Beverage ticket', packing_slip: 'Packing slip',
  picking_list: 'Picking list', purchase_order: 'Purchase order', goods_receipt: 'Goods receipt', payment_receipt: 'Payment receipt',
  statement: 'Customer statement', event_report: 'Event report',
};
