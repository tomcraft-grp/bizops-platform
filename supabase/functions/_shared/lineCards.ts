// The LINE messages: the order card (Flex bubble), follow-ups, the confirm step of quick approve, the reject reasons, and the reply sentences.
// Thai, phone-sized, at most 3 item lines (the rest is a count + the "ดูรายละเอียด" link). Buttons carry postback data (line.ts) bound to the card and the order;
// links open the back office in the phone's own browser (openExternalBrowser=1), where staff are usually signed in already.
import { encodePostback } from './line.ts';

export type CardData = {
  order_id: string; order_no: string; customer_name: string; phone: string; created_at: string;
  item_count: number; items: { name: string; qty: number; price: number; image: string | null }[]; more_count: number;
  total: number; fulfilment: 'delivery' | 'pickup';
  payment: { method: 'transfer' | 'wallet' | 'qr' | 'unpaid'; bank: string | null; has_slip: boolean; transfer_at: string | null; evidence_id: string | null };
  status: string; quick: { ok: boolean; why: string | null }; app_url: string;
};

export type ActResult =
  | { result: 'not_linked' }
  | { result: 'not_allowed'; why?: 'not_staff' | 'not_verifier' | null; message?: string }
  | { result: 'already_done'; order_no: string; status: string; by: string | null; at: string | null }
  | { result: 'slip_done'; order_no: string; status: 'confirmed' | 'verified' | 'rejected'; by: string | null; at: string | null }
  | { result: 'refused'; code: string; message?: string }
  | { result: 'ask_quick'; order_no: string; amount: number; bank: string | null; transfer_at: string }
  | { result: 'ask_reason'; order_no: string; reasons: string[] }
  | { result: 'done'; action: 'accept' | 'quick_confirm' | 'reject'; order_no: string; by: string; at: string; amount?: number; reason?: string };

const GREEN = '#06C755', RED = '#E5484D', GREY = '#8C8C8C', DARK = '#1F2937', AMBER = '#B45309';

export const money = (n: number) => '฿' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function hhmm(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}
function dayTime(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' }).format(d);
  return `${day} ${hhmm(iso)}`;
}
const done = (status: string) => (status === 'cancelled' || status === 'returned' ? 'ยกเลิก' : 'รับ');
function statusChip(status: string): { text: string; color: string } {
  if (status === 'new') return { text: 'รอยืนยัน', color: AMBER };
  if (status === 'cancelled' || status === 'returned') return { text: 'ยกเลิก', color: RED };
  return { text: 'รับแล้ว', color: GREEN };
}
export const orderUrl = (d: Pick<CardData, 'app_url' | 'order_id'>) => `${d.app_url}?openExternalBrowser=1#/shop-admin?order=${d.order_id}`;
export const slipUrl = (appUrl: string, evidenceId: string) => `${appUrl}?openExternalBrowser=1#/payment-review?evidence=${evidenceId}`;

const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: 'text', text: t, wrap: true, size: 'sm', color: DARK, ...extra });
const row = (label: string, value: string, valueExtra: Record<string, unknown> = {}) => ({
  type: 'box', layout: 'baseline', spacing: 'sm',
  contents: [text(label, { color: GREY, flex: 3 }), text(value, { flex: 7, ...valueExtra })],
});
const button = (label: string, action: Record<string, unknown>, style: 'primary' | 'secondary' | 'link' = 'secondary', color?: string) =>
  ({ type: 'button', style, height: 'sm', action: { label, ...action }, ...(color ? { color } : {}) });
const postback = (label: string, data: string, displayText: string) => ({ type: 'postback', label, data, displayText });

function paymentLine(p: CardData['payment']): string {
  if (p.method === 'wallet') return 'ชำระด้วยกระเป๋าเงิน';
  if (p.method === 'qr') return `QR พร้อมเพย์ · ${p.has_slip ? 'แนบสลิปแล้ว' : 'ยังไม่มีสลิป'}`;
  if (p.method === 'unpaid') return 'ยังไม่ชำระ';
  return `โอน ${p.bank ?? ''} · ${p.has_slip ? 'แนบสลิปแล้ว' : 'ยังไม่มีสลิป'}${p.transfer_at ? ` · เวลาโอน ${hhmm(p.transfer_at)}` : ''}`.replace('โอน  ·', 'โอน ·');
}

function itemRow(it: CardData['items'][number]) {
  const words = { type: 'box', layout: 'vertical', flex: 1, contents: [text(it.name, { maxLines: 2 }), text(`${it.qty} × ${money(it.price)}`, { color: GREY, size: 'xs' })] };
  return {
    type: 'box', layout: 'horizontal', spacing: 'md',
    contents: it.image && it.image.startsWith('https://')
      ? [{ type: 'image', url: it.image, size: '48px', aspectMode: 'cover', aspectRatio: '1:1', flex: 0 }, words]
      : [words],
  };
}

/** The order card. event 'slip_new' changes only the header. Action buttons only while the order is new; quick approve only when d.quick.ok.
 *  cardId = the outbox row the card is sent as (line_act refuses a postback whose card does not belong to the order). */
export function orderCard(d: CardData, event: 'order_new' | 'slip_new' = 'order_new', cardId = '00000000-0000-4000-8000-000000000000') {
  const chip = statusChip(d.status);
  const isNew = d.status === 'new';
  const items = [...d.items.map(itemRow), ...(d.more_count > 0 ? [text(`+ อีก ${d.more_count} รายการ`, { color: GREY, size: 'xs' })] : [])];
  const actions = isNew ? [
    button('รับออเดอร์', postback('รับออเดอร์', encodePostback({ a: 'accept', o: d.order_id, c: cardId }), `รับออเดอร์ ${d.order_no}`), 'primary', GREEN),
    ...(d.quick.ok ? [button('รับ + อนุมัติเงิน', postback('รับ + อนุมัติเงิน', encodePostback({ a: 'quick_ask', o: d.order_id, c: cardId }), `รับ + อนุมัติเงิน ${d.order_no}`), 'primary', DARK)] : []),
    button('ปฏิเสธ', postback('ปฏิเสธ', encodePostback({ a: 'reject_ask', o: d.order_id, c: cardId }), `ปฏิเสธ ${d.order_no}`), 'secondary'),
  ] : [text(`สถานะ: ${chip.text}`, { color: chip.color, weight: 'bold', align: 'center' })];
  const links = [
    button('ดูรายละเอียด', { type: 'uri', uri: orderUrl(d) }, 'link'),
    ...(d.payment.has_slip && d.payment.evidence_id ? [button('ตรวจสลิป', { type: 'uri', uri: slipUrl(d.app_url, d.payment.evidence_id) }, 'link')] : []),
    button('โทรหาลูกค้า', { type: 'uri', uri: `tel:${d.phone}` }, 'link'),
  ];
  const title = event === 'slip_new' ? 'สลิปใหม่' : 'ออเดอร์ใหม่';
  return {
    type: 'flex', altText: `${title} ${d.order_no} ${money(d.total)}`,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'horizontal', paddingAll: '16px', backgroundColor: '#F7F7F7',
        contents: [
          text(title, { weight: 'bold', size: 'lg', flex: 1 }),
          { type: 'box', layout: 'vertical', flex: 0, cornerRadius: '12px', paddingAll: '4px', paddingStart: '10px', paddingEnd: '10px', backgroundColor: chip.color,
            contents: [text(chip.text, { color: '#FFFFFF', size: 'xs', weight: 'bold' })] },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          row('เลขที่', d.order_no, { weight: 'bold' }),
          row('ลูกค้า', d.customer_name),
          row('วันที่', dayTime(d.created_at)),
          row('รับสินค้า', d.fulfilment === 'pickup' ? 'รับที่ร้าน' : 'จัดส่ง'),
          { type: 'separator' },
          ...items,
          { type: 'separator' },
          row('จำนวน', `${d.item_count} ชิ้น`),
          row('ยอดรวม', money(d.total), { weight: 'bold', size: 'md' }),
          row('ชำระ', paymentLine(d.payment)),
        ],
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: [...actions, { type: 'separator' }, ...links] },
    },
  };
}
export function followUpCard(p: { order_no: string; status: string; by: string; at: string; reason?: string | null; quick?: boolean }) {
  const cancelled = p.status === 'cancelled' || p.status === 'returned';
  const head = cancelled ? `❌ ${p.order_no} ยกเลิกโดย ${p.by} · ${hhmm(p.at)}` : `✅ ${p.order_no} รับแล้วโดย ${p.by} · ${hhmm(p.at)}`;
  return {
    type: 'flex', altText: head,
    contents: { type: 'bubble', size: 'kilo', body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: [
      text(head, { weight: 'bold', color: cancelled ? RED : GREEN }),
      ...(p.quick ? [text('อนุมัติเงินด่วนจาก LINE · รอ Post สิ้นวัน', { color: GREY, size: 'xs' })] : []),
      ...(cancelled && p.reason ? [text(`เหตุผล: ${p.reason}`, { color: GREY, size: 'xs' })] : []),
    ] } },
  };
}

export function quickAskCard(r: Extract<ActResult, { result: 'ask_quick' }>, card: string, order: string) {
  const line = `อนุมัติ ${money(r.amount)} · โอนเข้า ${r.bank ?? '-'} · ${dayTime(r.transfer_at)} ?`;
  return {
    type: 'flex', altText: `ยืนยันอนุมัติเงิน ${r.order_no}`,
    contents: { type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: [
        text(`ยืนยันอนุมัติเงิน ${r.order_no}`, { weight: 'bold' }), text(line),
        text('เงินจะเข้าบัญชีจริงเมื่อกด Post ตอนสิ้นวันในเว็บ', { color: GREY, size: 'xs' }),
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        button('ยืนยัน', postback('ยืนยัน', encodePostback({ a: 'quick_confirm', o: order, c: card }), `ยืนยันอนุมัติ ${r.order_no}`), 'primary', GREEN),
      ] } },
  };
}

export function reasonsCard(reasons: string[], card: string, order: string, orderLink: string) {
  return {
    type: 'flex', altText: 'เลือกเหตุผลที่ปฏิเสธ',
    contents: { type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: [text('เลือกเหตุผลที่ปฏิเสธ', { weight: 'bold' })] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        ...reasons.map((r, i) => button(r.slice(0, 20), postback(r.slice(0, 20), encodePostback({ a: 'reject', o: order, c: card, r: i }), `ปฏิเสธ: ${r}`), 'secondary')),
        button('อื่น ๆ', { type: 'uri', uri: orderLink }, 'link'),
      ] } },
  };
}

const REFUSED: Record<string, string> = {
  QUICK_OFF: 'ปิดการอนุมัติด่วนอยู่ ตรวจในเว็บ',
  OVER_CAP: 'ยอดเกินวงเงินอนุมัติด่วน ตรวจในเว็บ',
  NO_TRANSFER_TIME: 'ลูกค้าไม่ได้ใส่เวลาโอน ตรวจในเว็บ',
  DUPLICATE_SUSPECT: 'อาจเป็นสลิปซ้ำ ตรวจในเว็บ',
  AMOUNT_MISMATCH: 'ยอดในสลิปไม่ตรงกับยอดที่ต้องชำระ ตรวจในเว็บ',
  OUT_OF_WINDOW: 'เวลาโอนไม่อยู่ในช่วงเวลาของออเดอร์ ตรวจในเว็บ',
  AI_MISMATCH: 'ผลตรวจสลิปอัตโนมัติไม่ผ่าน ตรวจในเว็บ',
  PAYMENT_RECORDED: 'ออเดอร์นี้บันทึกรับเงินแล้ว ยกเลิกจาก LINE ไม่ได้ ทำในเว็บ',
  BAD_REASON: 'เหตุผลไม่ถูกต้อง ลองใหม่',
  UNKNOWN_CARD: 'การ์ดนี้ใช้ไม่ได้แล้ว เปิดออเดอร์ในเว็บ',
};
const NOT_ELIGIBLE = 'ออเดอร์นี้อนุมัติด่วนไม่ได้ ตรวจในเว็บ';

/** The sentence the bot replies with after a tap (ask_quick / ask_reason are cards, not sentences). */
export function resultText(r: ActResult): string {
  switch (r.result) {
    case 'not_linked': return 'บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ';
    case 'not_allowed': return r.why === 'not_verifier' ? 'ทำรายการนี้ได้เฉพาะผู้ตรวจการเงินขึ้นไป' : 'บัญชีนี้ไม่มีสิทธิ์จัดการออเดอร์';
    case 'already_done': return `ออเดอร์ ${r.order_no} ถูก${done(r.status)}แล้วโดย ${r.by ?? '-'} เมื่อ ${hhmm(r.at)}`;
    case 'slip_done': return `สลิปของออเดอร์ ${r.order_no} ถูก${r.status === 'verified' ? 'บันทึกรับเงิน' : r.status === 'rejected' ? 'ปฏิเสธ' : 'ยืนยัน'}แล้วโดย ${r.by ?? '-'} เมื่อ ${hhmm(r.at)}`;
    case 'refused': return REFUSED[r.code] ?? (['NO_SLIP', 'MANY_SLIPS', 'NOT_TRANSFER', 'NOT_NEW'].includes(r.code) ? NOT_ELIGIBLE : 'เกิดข้อผิดพลาด ลองใหม่หรือทำในเว็บ');
    case 'done':
      if (r.action === 'accept') return `✅ รับออเดอร์ ${r.order_no} แล้ว (${r.by} · ${hhmm(r.at)})`;
      if (r.action === 'quick_confirm') return `✅ รับออเดอร์ ${r.order_no} + อนุมัติเงิน ${money(r.amount ?? 0)} แล้ว (${r.by} · ${hhmm(r.at)}) · รอ Post สิ้นวัน`;
      return `❌ ยกเลิกออเดอร์ ${r.order_no} แล้ว · เหตุผล: ${r.reason ?? '-'} (${r.by} · ${hhmm(r.at)})`;
    case 'ask_quick': return `ยืนยันอนุมัติเงิน ${r.order_no}`;
    case 'ask_reason': return 'เลือกเหตุผลที่ปฏิเสธ';
  }
}
