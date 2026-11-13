// Minimal dictionary-based i18n: English source strings -> Thai. No build step, no missing-key errors —
// an untranslated string (or a dynamic/templated one that can't match a dictionary key) just stays in English.
// Kit components (Card, Tabs, DataTable headers, Modal, Badge, Field, …) translate their string props; static
// JSX text in back-office pages is wrapped in <Tx> (ui/kit.tsx) and attributes use t(lang, …).
// Data values (names, codes, amounts) are never passed through here, only fixed UI copy.
import type { ReactNode } from 'react';
import { TH_BACKOFFICE } from './i18n.backoffice';

export type Lang = 'en' | 'th';

export const TH: Record<string, string> = {
  // nav groups
  Overview: 'ภาพรวม', Sell: 'การขาย', Customers: 'ลูกค้า', Supply: 'ซัพพลาย', Finance: 'การเงิน',
  Operations: 'ปฏิบัติการ', Admin: 'ผู้ดูแลระบบ', 'Customer view': 'มุมมองลูกค้า',
  // nav items
  Dashboard: 'แดชบอร์ด', POS: 'หน้าร้าน POS', Orders: 'คำสั่งซื้อ', Channels: 'ช่องทางการขาย',
  'Kitchen display': 'จอแสดงผลครัว', Receivables: 'ลูกหนี้', 'Loyalty & rewards': 'สะสมแต้ม & รางวัล',
  Promotions: 'โปรโมชั่น', Events: 'กิจกรรม', Products: 'สินค้า', Inventory: 'คลังสินค้า',
  Purchasing: 'การจัดซื้อ', 'BOM & production': 'สูตร & การผลิต', Accounting: 'บัญชี',
  'Profit engine': 'เครื่องมือคำนวณกำไร', Reports: 'รายงาน', Printing: 'การพิมพ์',
  'Media & documents': 'สื่อ & เอกสาร', 'Team & access': 'ทีม & สิทธิ์การใช้งาน', Settings: 'ตั้งค่า',
  'System health': 'สถานะระบบ', 'Blueprint & scope': 'แผนผัง & ขอบเขตงาน',
  'Feedback & issues': 'ความคิดเห็น & ปัญหา', 'Customer app (LIFF)': 'แอปลูกค้า (LIFF)', Collapse: 'ย่อ',
  // topbar / shell chrome
  'Search products, customers, orders…': 'ค้นหาสินค้า, ลูกค้า, คำสั่งซื้อ…', 'Toggle theme': 'สลับธีม',
  Notifications: 'การแจ้งเตือน', 'Branch scope': 'ขอบเขตสาขา', 'All branches': 'ทุกสาขา',
  'Needs attention': 'ต้องดำเนินการ', 'All clear': 'เรียบร้อยดี',
  'Nothing needs your attention right now.': 'ไม่มีอะไรต้องดำเนินการตอนนี้',
  'payment slips awaiting review': 'สลิปโอนเงินรอตรวจสอบ', 'print jobs failed': 'งานพิมพ์ล้มเหลว',
  'channel sync errors (unmapped SKUs etc.)': 'ข้อผิดพลาดการซิงค์ช่องทาง (SKU ที่ยังไม่แมป ฯลฯ)',
  'items below reorder level': 'สินค้าต่ำกว่าจุดสั่งซื้อซ้ำ',
  'new online orders to confirm': 'คำสั่งซื้อออนไลน์ใหม่ที่ต้องยืนยัน',
  'settlement statements to reconcile': 'ใบแจ้งยอดที่ต้องกระทบยอด',
  'Demo: sign in as another role to see how permissions change the app.': 'เดโม: ลองเข้าสู่ระบบด้วยบทบาทอื่นเพื่อดูว่าสิทธิ์การใช้งานเปลี่ยนแอปอย่างไร',
  'Type a product, SKU, customer, phone, order number or page…': 'พิมพ์ชื่อสินค้า, SKU, ลูกค้า, เบอร์โทร, เลขคำสั่งซื้อ หรือหน้าที่ต้องการ…',
  'Go to page': 'ไปที่หน้า', 'No matches': 'ไม่พบผลลัพธ์',
  'Try a different spelling, a SKU or part of an order number.': 'ลองสะกดคำอื่น, SKU หรือส่วนหนึ่งของเลขคำสั่งซื้อ',
  'Access restricted': 'ไม่มีสิทธิ์เข้าถึง', 'Nothing here yet': 'ยังไม่มีข้อมูล',
  'No results match your search.': 'ไม่พบผลลัพธ์ที่ตรงกับการค้นหา', Search: 'ค้นหา',
  // page headers
  'Point of sale': 'ขายหน้าร้าน',
  'Every issue, idea or requested improvement submitted from the global Feedback button, with the exact page it came from.':
    'ทุกปัญหา ไอเดีย หรือข้อเสนอแนะที่ส่งมาจากปุ่ม Feedback ทั่วทั้งแอป พร้อมระบุหน้าต้นทางที่แน่นอน',
  'Events — number selection': 'กิจกรรม — เลือกหมายเลข',
  'Purchase-linked picks on boards of numbers 00–99. Claims are protected by a unique (event, board, number) constraint, so two customers can never hold the same number — whatever the screen shows.':
    'การเลือกหมายเลขที่ผูกกับการซื้อ บนกระดานเลข 00–99 การจองถูกป้องกันด้วยเงื่อนไข unique (กิจกรรม, กระดาน, หมายเลข) ทำให้ลูกค้าสองคนไม่สามารถถือเลขเดียวกันได้ ไม่ว่าหน้าจอจะแสดงอย่างไร',
  'Points are an append-only ledger (earn, bonus, redeem, expire, reverse). Balances are derived, redemptions are atomic, and double-spending is prevented.':
    'แต้มสะสมเป็นบัญชีแบบเพิ่มได้อย่างเดียว (ได้รับ, โบนัส, แลก, หมดอายุ, ย้อนกลับ) ยอดคงเหลือคำนวณจากรายการทั้งหมด การแลกแต้มเป็นธุรกรรมอะตอมมิก และป้องกันการใช้แต้มซ้ำ',
  'One unified order model for POS, LINE, Shopee, Lazada, TikTok Shop and LINE MAN — with the original channel IDs preserved.':
    'โมเดลคำสั่งซื้อเดียวที่รวม POS, LINE, Shopee, Lazada, TikTok Shop และ LINE MAN ไว้ด้วยกัน พร้อมเก็บรหัสอ้างอิงจากช่องทางเดิมไว้ครบ',
  'Real profitability from traceable costs: weighted-average COGS snapshots, BOM-based cost for recipes, channel commissions, payment fees, shipping subsidies, returns and business-level expenses.':
    'กำไรที่แท้จริงจากต้นทุนที่ตรวจสอบย้อนกลับได้: ต้นทุนขาย (COGS) แบบถ่วงเฉลี่ย, ต้นทุนสูตรจาก BOM, ค่าคอมมิชชั่นช่องทาง, ค่าธรรมเนียมการจ่ายเงิน, ค่าสนับสนุนค่าส่ง, การคืนสินค้า และค่าใช้จ่ายระดับธุรกิจ',
  'Purchasing & suppliers': 'การจัดซื้อ & ซัพพลายเออร์',
  'Purchase orders → partial goods receipts (with landed cost) → supplier invoices → payments, deposits and returns. Receipts feed inventory and the BOM costs.':
    'ใบสั่งซื้อ → รับสินค้าแบบรับทีละส่วน (รวมต้นทุนนำเข้า) → ใบแจ้งหนี้ซัพพลายเออร์ → การจ่ายเงิน, เงินมัดจำ และการคืนสินค้า การรับสินค้าจะส่งผลไปยังสต็อกและต้นทุน BOM',
  'One catalog for resale goods, manufactured goods, menu items (recipes), raw materials and packaging — with channel prices, images and cost history.':
    'แคตตาล็อกเดียวสำหรับสินค้าขายต่อ, สินค้าที่ผลิตเอง, เมนู (สูตร), วัตถุดิบ และบรรจุภัณฑ์ พร้อมราคาต่อช่องทาง, รูปภาพ และประวัติต้นทุน',
  'Role-based access with fine-grained permissions by module and action, plus branch scope and financial sensitivity. Switch user (top right) to feel the difference — e.g. a cashier cannot see cost or profit.':
    'ระบบสิทธิ์ตามบทบาท กำหนดละเอียดถึงระดับโมดูลและการกระทำ รวมถึงขอบเขตสาขาและข้อมูลการเงินที่ละเอียดอ่อน ลองสลับผู้ใช้ (มุมบนขวา) เพื่อดูความแตกต่าง เช่น แคชเชียร์จะไม่เห็นต้นทุนหรือกำไร',
  'Organization, tax, costing and data controls. Critical settings are restricted to Owners and every change is audited.':
    'การตั้งค่าองค์กร, ภาษี, ต้นทุน และการควบคุมข้อมูล การตั้งค่าที่สำคัญจำกัดให้เฉพาะเจ้าของ และทุกการเปลี่ยนแปลงจะถูกบันทึกไว้ในออดิท',
  'System health & integrity': 'สถานะระบบ & ความถูกต้องของข้อมูล',
  'Continuous reconciliation of the ledgers (stock, journal, points, receivables, events) plus executable concurrency tests — the invariants the production database must enforce.':
    'การกระทบยอดบัญชีแบบต่อเนื่อง (สต็อก, สมุดบัญชี, แต้มสะสม, ลูกหนี้, กิจกรรม) พร้อมการทดสอบ concurrency ที่รันได้จริง ซึ่งเป็นเงื่อนไขที่ฐานข้อมูลจริงต้องรักษาไว้เสมอ',
  'BOM, recipes & production': 'BOM, สูตร & การผลิต',
  'Versioned bills of materials. Active versions are immutable — change a recipe by creating a new version with an effective date, so historical costs never move.':
    'รายการวัตถุดิบ (BOM) ที่มีเวอร์ชัน เวอร์ชันที่ใช้งานอยู่จะแก้ไขไม่ได้ — เปลี่ยนสูตรด้วยการสร้างเวอร์ชันใหม่พร้อมวันที่มีผล เพื่อไม่ให้ต้นทุนในอดีตเปลี่ยนแปลง',
  'Sales channels': 'ช่องทางการขาย',
  'Connectors import orders into the unified model, map channel SKUs to internal products, track fees and reconcile platform settlements.':
    'ตัวเชื่อมต่อนำคำสั่งซื้อเข้าสู่โมเดลเดียวกัน, แมป SKU ของแต่ละช่องทางกับสินค้าภายใน, ติดตามค่าธรรมเนียม และกระทบยอดการชำระเงินของแพลตฟอร์ม',
  'One print service for receipts, kitchen & bar tickets, packing slips, POs and statements — routed by branch, station, order type and document type, with a queue, retries and duplicate protection.':
    'บริการพิมพ์เดียวสำหรับใบเสร็จ, ใบสั่งครัว/บาร์, ใบแพ็กสินค้า, ใบสั่งซื้อ และใบแจ้งยอด — จัดเส้นทางตามสาขา, สถานี, ประเภทคำสั่งซื้อ และประเภทเอกสาร พร้อมคิวงาน, การสั่งพิมพ์ใหม่ และการป้องกันพิมพ์ซ้ำ',
  'What this prototype covers against the requirements document, what was improved, and what still needs decisions or real integrations. Honest status, not marketing.':
    'สิ่งที่ต้นแบบนี้ครอบคลุมเทียบกับเอกสารความต้องการ, สิ่งที่ปรับปรุงไปแล้ว, และสิ่งที่ยังต้องตัดสินใจหรือเชื่อมต่อระบบจริง สถานะตามความเป็นจริง ไม่ใช่การโฆษณา',
  'A rule engine — conditions, actions, limits, budgets and stacking — configured without code. Every application is recorded against the order and flows into profit reports.':
    'เอนจินกฎ — เงื่อนไข, การกระทำ, ขีดจำกัด, งบประมาณ และการซ้อนโปรโมชั่น — ตั้งค่าได้โดยไม่ต้องเขียนโค้ด ทุกการใช้งานจะถูกบันทึกไว้กับคำสั่งซื้อและไหลเข้าสู่รายงานกำไร',
  'Accounting setup': 'ตั้งค่าบัญชี',
  'Configure the chart of accounts, tax treatment, transaction-to-account mapping and opening balances before live posting. Nothing is mapped silently: an unmapped event blocks the transaction instead of posting to an arbitrary account.':
    'ตั้งค่าผังบัญชี, การจัดการภาษี, การแมปรายการบัญชี และยอดยกมา ก่อนเริ่มลงบัญชีจริง ไม่มีการแมปแบบเงียบ: รายการที่ยังไม่ถูกแมปจะถูกบล็อก ไม่ใช่ถูกลงบัญชีไปยังบัญชีที่ไม่ถูกต้อง',
  'Inventory & warehouses': 'คลังสินค้า & โกดัง',
  'Every stock change is an immutable movement. Balances are a projection that must reconcile to the ledger — see the check on the Valuation tab.':
    'การเปลี่ยนแปลงสต็อกทุกครั้งคือรายการที่แก้ไขไม่ได้ ยอดคงเหลือเป็นผลคำนวณที่ต้องกระทบยอดกับสมุดบัญชีได้ — ดูการตรวจสอบได้ที่แท็บ Valuation',
  'Files live in object storage (Cloudflare R2 in production; IndexedDB in this prototype). Only metadata and links are stored in the database. Private by default, with signed short-lived access and an access log.':
    'ไฟล์จัดเก็บใน object storage (Cloudflare R2 ในระบบจริง; IndexedDB ในต้นแบบนี้) มีเพียง metadata และลิงก์ที่เก็บในฐานข้อมูล ตั้งค่าเป็นส่วนตัวโดยค่าเริ่มต้น พร้อมสิทธิ์เข้าถึงแบบมีลายเซ็นและจำกัดเวลา และมีบันทึกการเข้าถึง',
  'Profiles, membership tiers, purchase history, credit terms, balances and consent — one record shared by POS, LINE and receivables.':
    'ข้อมูลโปรไฟล์, ระดับสมาชิก, ประวัติการซื้อ, เงื่อนไขเครดิต, ยอดคงเหลือ และความยินยอม — ข้อมูลชุดเดียวที่ใช้ร่วมกันโดย POS, LINE และลูกหนี้',
  'Receivables & payments': 'ลูกหนี้ & การชำระเงิน',
  'Order value, payment received, customer credit and platform settlement are separate records. One receipt can be allocated across many orders — automatically (FIFO) or manually.':
    'มูลค่าคำสั่งซื้อ, เงินที่รับมา, เครดิตลูกค้า และการชำระเงินของแพลตฟอร์ม เป็นรายการแยกกัน ใบเสร็จหนึ่งใบสามารถจัดสรรไปยังหลายคำสั่งซื้อได้ — ทั้งแบบอัตโนมัติ (FIFO) หรือแบบกำหนดเอง',
  'Every report states its period, currency, scope, costing method and whether figures are provisional or posted/closed.':
    'ทุกรายงานระบุช่วงเวลา, สกุลเงิน, ขอบเขต, วิธีคิดต้นทุน และระบุว่าตัวเลขเป็นค่าประมาณหรือลงบัญชี/ปิดแล้ว',
  'Kitchen & beverage display': 'จอแสดงผลครัว & เครื่องดื่ม',
  'Orders appear by station. Tap an item to move it new → preparing → ready → done. Waiting time is tracked; printed tickets are the fallback.':
    'คำสั่งซื้อจะแสดงตามสถานี แตะรายการเพื่อเปลี่ยนสถานะ ใหม่ → กำลังทำ → พร้อม → เสร็จแล้ว มีการติดตามเวลารอ และมีใบสั่งพิมพ์เป็นทางเลือกสำรอง',
  'Double-entry ledger posted through the approved account mapping. Mistakes are fixed with reversal entries — nothing is silently overwritten; manual journals need a second person\'s approval.':
    'สมุดบัญชีแบบบันทึกคู่ ลงบัญชีผ่านการแมปบัญชีที่ได้รับอนุมัติ ข้อผิดพลาดแก้ไขด้วยรายการกลับรายการ — ไม่มีการเขียนทับแบบเงียบ; รายการบัญชีแบบแมนนวลต้องมีผู้อนุมัติคนที่สอง',
  // feedback feature (buttons/labels not covered by the auto-translate wrappers)
  Feedback: 'ความคิดเห็น', 'Send feedback': 'ส่งความคิดเห็น', 'Reporting from:': 'รายงานจากหน้า:', Description: 'คำอธิบาย',
  "What's the issue, idea, or additional feature you'd like to see on this page?":
    'มีปัญหา ไอเดีย หรือฟีเจอร์เพิ่มเติมอะไรที่คุณต้องการเห็นในหน้านี้?',
  'Remark / additional notes': 'หมายเหตุ / ข้อมูลเพิ่มเติม',
  'Optional — any extra context for the team.': 'ไม่บังคับ — ข้อมูลเพิ่มเติมสำหรับทีม',
  Cancel: 'ยกเลิก', Submit: 'ส่ง', Close: 'ปิด', 'Open page': 'เปิดหน้า', 'Add note': 'เพิ่มบันทึก',
  'Total submitted': 'ส่งทั้งหมด', Open: 'เปิดอยู่', 'Critical priority': 'ความสำคัญฉุกเฉิน', Completed: 'เสร็จสมบูรณ์',
  Issue: 'ปัญหา', Page: 'หน้า', Status: 'สถานะ', Priority: 'ความสำคัญ', Submitted: 'ส่งเมื่อ',
  'All statuses': 'ทุกสถานะ', 'All priorities': 'ทุกระดับความสำคัญ',
  New: 'ใหม่', Reviewing: 'กำลังตรวจสอบ', 'In progress': 'กำลังดำเนินการ', 'Need more information': 'ต้องการข้อมูลเพิ่ม',
  Rejected: 'ปฏิเสธ', Low: 'ต่ำ', Medium: 'กลาง', High: 'สูง', Critical: 'ฉุกเฉิน',
  'Where this happened': 'เกิดขึ้นที่ไหน', 'Context captured automatically': 'ข้อมูลที่บันทึกอัตโนมัติ', Update: 'อัปเดต',
  Route: 'เส้นทาง (Route)', Module: 'โมดูล', Feature: 'ฟีเจอร์', 'Function identifier': 'รหัสฟังก์ชัน', 'Full URL': 'URL เต็ม',
  Environment: 'สภาพแวดล้อม', Browser: 'เบราว์เซอร์', 'Device / viewport': 'อุปกรณ์ / ขนาดจอ', 'Last updated': 'อัปเดตล่าสุด', 'Resolved at': 'แก้ไขเสร็จเมื่อ',
  'No feedback yet': 'ยังไม่มีความคิดเห็น', 'Submissions from the Feedback button on any page will show up here.': 'ความคิดเห็นที่ส่งจากปุ่ม Feedback ในทุกหน้าจะแสดงที่นี่',
  'No internal notes yet.': 'ยังไม่มีบันทึกภายใน', 'Add an investigation note or internal remark…': 'เพิ่มบันทึกการตรวจสอบหรือหมายเหตุภายใน…',
  'Your role cannot update issues — ask an Owner or Manager.': 'บทบาทของคุณไม่สามารถอัปเดตรายการได้ — กรุณาติดต่อ Owner หรือ Manager',
  'Thanks — your feedback was recorded.': 'ขอบคุณ — บันทึกความคิดเห็นของคุณแล้ว',
  'Status updated': 'อัปเดตสถานะแล้ว', 'Priority updated': 'อัปเดตความสำคัญแล้ว', 'Note added': 'เพิ่มบันทึกแล้ว',
  Category: 'ประเภท', 'All categories': 'ทุกประเภท',
  'Feature request / requirement': 'ขอฟีเจอร์ / ความต้องการใหม่', 'Bug report': 'แจ้งบั๊ก',
  'UI/UX feedback': 'ความคิดเห็นเรื่อง UI/UX', 'Performance problem': 'ปัญหาประสิทธิภาพ',
  Question: 'คำถาม', 'General suggestion': 'ข้อเสนอแนะทั่วไป',
  'Helps the team route this to the right person and fix it at the right place.': 'ช่วยให้ทีมส่งเรื่องไปถึงคนที่ถูกต้องและแก้ไขได้ตรงจุด',
};

// Back-office labels (tabs, column headers, buttons, report captions, …) live in their own file to keep this
// one readable. Entries above win over that file on a duplicate key.
for (const [k, v] of Object.entries(TH_BACKOFFICE)) if (!(k in TH)) TH[k] = v;

/** Translate an English source string. `{name}` placeholders are filled from `vars` AFTER lookup, so the
 *  dictionary key is the template (e.g. 'Type {word} to confirm') and dynamic values are never translated. */
export function t(lang: Lang, s: string, vars?: Record<string, string | number>): string {
  const out = lang === 'th' ? TH[s] ?? s : s;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out;
}
/** Translate a prop that is usually plain text but may be arbitrary JSX — only strings are looked up. */
export function tr(lang: Lang, v: ReactNode): ReactNode {
  return typeof v === 'string' ? t(lang, v) : v;
}
