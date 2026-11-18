// Customer-facing text of the shop. Thai is the default; English is optional (toggle on the Account tab). The customer's
// choice is remembered on their device and is independent of the staff app's language.
import { useCallback } from 'react';
import { create } from 'zustand';

export type ShopLang = 'th' | 'en';
const KEY = 'tc.shop.lang';
const initial = (): ShopLang => { try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'th'; } catch { return 'th'; } };
export const useShopLangStore = create<{ lang: ShopLang; set: (l: ShopLang) => void }>((set) => ({
  lang: initial(),
  set: (lang) => { try { localStorage.setItem(KEY, lang); } catch { /* ignore */ } set({ lang }); },
}));
export const useShopLang = () => useShopLangStore((s) => s.lang);

const D = {
  // navigation and general
  'nav.home': ['หน้าหลัก', 'Home'], 'nav.shop': ['สินค้า', 'Products'], 'nav.cart': ['ตะกร้า', 'Cart'], 'nav.orders': ['คำสั่งซื้อ', 'Orders'], 'nav.account': ['บัญชีของฉัน', 'Account'],
  'common.back': ['ย้อนกลับ', 'Back'], 'common.retry': ['ลองอีกครั้ง', 'Try again'], 'common.close': ['ปิด', 'Close'], 'common.all': ['ทั้งหมด', 'All'],
  'common.loadError': ['โหลดข้อมูลไม่สำเร็จ', 'Could not load this'], 'common.loadMore': ['ดูเพิ่มเติม', 'Load more'], 'common.cancel': ['ไม่ใช่', 'No'],
  'common.refresh': ['รีเฟรช', 'Refresh'], 'common.currency': ['บาท', 'THB'],
  // catalogue
  'cat.search': ['ค้นหาชื่อสินค้า แบรนด์ หรือรหัส SKU', 'Search name, brand or SKU'], 'cat.brand': ['แบรนด์', 'Brand'], 'cat.allBrands': ['ทุกแบรนด์', 'All brands'],
  'cat.sort': ['เรียงตาม', 'Sort by'], 'cat.count': ['พบ {n} รายการ', '{n} items'],
  'sort.recommended': ['แนะนำ', 'Recommended'], 'sort.newest': ['มาใหม่', 'Newest'], 'sort.price_asc': ['ราคาต่ำ → สูง', 'Price: low to high'],
  'sort.price_desc': ['ราคาสูง → ต่ำ', 'Price: high to low'], 'sort.name': ['ชื่อ ก–ฮ / A–Z', 'Name A–Z'],
  'cat.none': ['ไม่พบสินค้า', 'No products found'], 'cat.noneHint': ['ลองเปลี่ยนคำค้นหาหรือตัวกรอง', 'Try a different search or filter'], 'cat.clear': ['ล้างตัวกรอง', 'Clear filters'],
  'cat.empty': ['ยังไม่มีสินค้าในร้านออนไลน์', 'There are no products in the online shop yet'],
  'p.add': ['ใส่ตะกร้า', 'Add to cart'], 'p.added': ['เพิ่มลงตะกร้าแล้ว', 'Added to cart'], 'p.details': ['รายละเอียด', 'Details'], 'p.soldOut': ['สินค้าหมด', 'Sold out'],
  'p.available': ['พร้อมสั่งซื้อ', 'Available'], 'p.sku': ['รหัสสินค้า', 'SKU'], 'p.category': ['หมวดหมู่', 'Category'], 'p.brand': ['แบรนด์', 'Brand'], 'p.size': ['ขนาด', 'Size'],
  'p.unit': ['ชิ้น', 'pc'], 'p.qty': ['จำนวน', 'Quantity'], 'p.maxPer': ['สั่งได้สูงสุด {n} ชิ้นต่อออเดอร์', 'Up to {n} per order'], 'p.buyNow': ['สั่งซื้อทันที', 'Buy now'],
  'p.options': ['ตัวเลือก', 'Options'], 'p.specs': ['ข้อมูลจำเพาะ', 'Specifications'], 'p.desc': ['รายละเอียดสินค้า', 'Description'], 'p.related': ['สินค้าที่เกี่ยวข้อง', 'Related products'],
  'p.nameTh': ['ชื่อ (ไทย)', 'Name (Thai)'], 'p.nameEn': ['ชื่อ (อังกฤษ)', 'Name (English)'], 'p.gone': ['ไม่พบสินค้านี้ หรือไม่มีจำหน่ายแล้ว', 'This product was not found or is no longer sold'],
  'p.inCart': ['ในตะกร้า {n}', '{n} in cart'], 'p.minus': ['ลดจำนวน', 'Decrease'], 'p.plus': ['เพิ่มจำนวน', 'Increase'],
  // home
  'home.hello': ['สวัสดี {name}', 'Hello {name}'], 'home.sub': ['เลือกซื้อสินค้าได้เลย ชำระเงินสะดวกผ่าน QR', 'Pick your products and pay easily with a QR code'],
  'home.categories': ['หมวดหมู่สินค้า', 'Categories'], 'home.featured': ['สินค้าแนะนำ', 'Recommended'], 'home.new': ['สินค้ามาใหม่', 'New arrivals'], 'home.popular': ['สินค้าขายดี', 'Best sellers'],
  'home.seeAll': ['ดูทั้งหมด', 'See all'], 'home.allProducts': ['ดูสินค้าทั้งหมด', 'Browse all products'],
  'shop.closed': ['ร้านยังไม่เปิดรับออเดอร์ออนไลน์ ดูสินค้าได้ แต่ยังสั่งซื้อไม่ได้', 'The shop is not taking online orders yet. You can browse, but not order.'],
  // cart
  'cart.title': ['ตะกร้าสินค้า', 'Your cart'], 'cart.empty': ['ตะกร้าว่างเปล่า', 'Your cart is empty'], 'cart.emptyHint': ['เลือกสินค้าที่ถูกใจแล้วใส่ตะกร้าได้เลย', 'Add products you like and they will show up here'],
  'cart.browse': ['เลือกซื้อสินค้า', 'Browse products'], 'cart.remove': ['นำออก', 'Remove'], 'cart.subtotal': ['ยอดสินค้า', 'Subtotal'], 'cart.discount': ['ส่วนลด', 'Discount'],
  'cart.shipping': ['ค่าจัดส่ง', 'Shipping'], 'cart.total': ['ยอดที่ต้องชำระ', 'Total to pay'], 'cart.free': ['ฟรี', 'Free'],
  'cart.freeHint': ['ซื้อเพิ่มอีก {amount} ส่งฟรี', 'Add {amount} more for free shipping'], 'cart.checkout': ['ดำเนินการสั่งซื้อ', 'Checkout'],
  'cart.checking': ['กำลังตรวจสอบราคา…', 'Checking prices…'], 'cart.priceNote': ['ราคาและยอดรวมคำนวณโดยระบบของร้าน และตรวจสอบอีกครั้งตอนสั่งซื้อ', 'Prices and totals are calculated by the shop\'s system and checked again when you order'],
  'cart.removeBad': ['นำสินค้าที่สั่งไม่ได้ออก', 'Remove items that cannot be ordered'], 'cart.line.sold_out': ['สินค้าหมด', 'Sold out'], 'cart.line.not_found': ['ไม่มีจำหน่ายแล้ว', 'No longer available'],
  'cart.line.over_limit': ['สั่งได้สูงสุด {n} ชิ้น', 'Maximum {n} per order'], 'cart.line.bad_qty': ['จำนวนไม่ถูกต้อง', 'Invalid quantity'],
  'cart.items': ['{n} ชิ้น', '{n} items'], 'cart.fix': ['กรุณานำสินค้าที่สั่งไม่ได้ออกก่อนสั่งซื้อ', 'Please remove the items that cannot be ordered first'],
  // checkout
  'co.title': ['ยืนยันคำสั่งซื้อ', 'Confirm your order'], 'co.fulfilment': ['วิธีรับสินค้า', 'How to get your order'], 'co.delivery': ['จัดส่งถึงที่', 'Delivery'], 'co.pickup': ['รับที่ร้าน', 'Pick up'],
  'co.contact': ['ข้อมูลติดต่อ', 'Contact details'], 'co.name': ['ชื่อผู้รับ', 'Recipient name'], 'co.phone': ['เบอร์โทร', 'Phone'], 'co.address': ['ที่อยู่จัดส่ง', 'Delivery address'],
  'co.addressHint': ['บ้านเลขที่ ถนน แขวง/ตำบล เขต/อำเภอ จังหวัด รหัสไปรษณีย์', 'House no., street, sub-district, district, province, postcode'], 'co.note': ['หมายเหตุถึงร้าน (ไม่บังคับ)', 'Note to the shop (optional)'],
  'co.items': ['รายการสินค้า', 'Items'], 'co.payment': ['วิธีชำระเงิน', 'Payment'], 'co.promptpay': ['โอนผ่าน QR พร้อมเพย์', 'Transfer by PromptPay QR'],
  'co.promptpayHint': ['หลังกดยืนยัน ระบบจะสร้างคำสั่งซื้อและแสดง QR ตามยอดชำระ จากนั้นอัปโหลดสลิปเพื่อให้ร้านตรวจสอบ', 'After you confirm, we create your order and show a QR for the exact amount. Then upload your slip for the shop to check.'],
  'co.place': ['ยืนยันสั่งซื้อ', 'Place order'], 'co.placing': ['กำลังสั่งซื้อ…', 'Placing your order…'], 'co.confirmTitle': ['ยืนยันคำสั่งซื้อ?', 'Place this order?'],
  'co.confirmBody': ['ยอดที่ต้องชำระ {total} ระบบจะสร้างคำสั่งซื้อ แล้วพาไปหน้าชำระเงิน', 'Total {total}. We will create your order and take you to the payment screen.'],
  'co.paymentHint': ['เลือกวิธีที่สะดวก ยังเปลี่ยนได้ในหน้าชำระเงิน ร้านจะยืนยันว่าชำระแล้วหลังตรวจสอบกับบัญชีธนาคาร', 'Pick what suits you; you can change it on the payment screen. The order counts as paid only after the shop checks it against its bank record.'],
  'co.addressOptional': ['ไม่บังคับ ถ้าไม่กรอก ร้านจะโทรสอบถาม', 'optional: if you leave it empty the shop will call you'],
  'co.slipTitle': ['โอนเงิน แล้วแนบสลีป', 'Transfer, then attach your slip'],
  'co.slipHelp': ['โอนตามยอดด้านล่างเข้าบัญชีที่เลือก แล้วแนบรูปสลีปที่นี่ ต้องแนบสลีปก่อนจึงจะสั่งซื้อได้ ร้านจะตรวจสอบกับบัญชีธนาคารก่อนยืนยันว่าชำระแล้ว', 'Transfer the amount below to the account you chose, then attach the slip picture here. You must attach the slip to place the order. The shop checks it against its bank record before the order counts as paid.'],
  'co.slipAmount': ['ยอดที่ต้องโอน', 'Amount to transfer'], 'co.slipChoose': ['เลือกรูปสลีป', 'Choose the slip picture'], 'co.slipAnother': ['เลือกรูปอื่น', 'Choose another picture'],
  'co.slipMissing': ['กรุณาแนบรูปสลีปการโอนเงินก่อนสั่งซื้อ', 'Please attach your transfer slip before placing the order'], 'co.slipPreview': ['ตัวอย่างสลีป', 'Slip preview'],
  'co.slipWhen': ['วันและเวลาที่โอน (ไม่บังคับ)', 'Transfer date and time (optional)'], 'co.slipRef': ['เลขอ้างอิงในสลีป (ไม่บังคับ)', 'Reference on the slip (optional)'],
  'co.confirmBodySlip': ['ยอดที่ต้องชำระ {total} ระบบจะสร้างคำสั่งซื้อและส่งสลีปให้ร้านตรวจสอบ', 'Total {total}. We will create your order and send your slip to the shop to check.'],
  'err.slipRequired': ['ต้องแนบรูปสลีปการโอนเงินพร้อมการสั่งซื้อ', 'The transfer slip must be attached to the order'], 'err.slipUsed': ['สลีปนี้เคยถูกส่งแล้ว กรุณาแนบสลีปของการโอนครั้งนี้', 'This slip was already used. Please attach the slip of this transfer.'],
  'err.slipBad': ['ไฟล์สลีปไม่ถูกต้อง รองรับ JPG, PNG หรือ PDF', 'The slip file is not valid. Use a JPG, PNG or PDF.'], 'err.slipBig': ['ไฟล์สลีปต้องมีขนาดไม่เกิน 5 MB', 'The slip file must be 5 MB or smaller'],
  'err.slipUpload': ['อัปโหลดสลีปไม่สำเร็จ ลองใหม่อีกครั้ง', 'Could not upload the slip. Please try again.'], 'err.method': ['วิธีชำระเงินนี้ใช้ไม่ได้ กรุณาเลือกใหม่', 'This payment method is not available. Please choose another.'],
  'co.paymentLater': ['หลังสั่งซื้อ ระบบจะพาไปหน้าชำระเงินเพื่อเลือกช่องทาง', 'After you order, you will choose how to pay on the next screen.'],
  'co.placed': ['สั่งซื้อสำเร็จ กรุณาชำระเงิน', 'Order placed. Please pay to continue.'], 'co.pickupNote': ['สถานที่รับสินค้า', 'Pick-up information'],
  'co.back': ['กลับไปตะกร้า', 'Back to cart'], 'co.noDelivery': ['ขณะนี้ร้านยังไม่เปิดรับจัดส่ง', 'The shop is not offering delivery right now'],
  'co.noPickup': ['ขณะนี้ร้านยังไม่เปิดให้รับสินค้าที่ร้าน', 'Pick-up is not available right now'], 'co.shipTo': ['จัดส่งที่', 'Deliver to'],
  'err.name': ['กรุณากรอกชื่อผู้รับ', 'Please enter the recipient name'], 'err.phone': ['กรุณากรอกเบอร์โทรให้ถูกต้อง เช่น 0812345678', 'Please enter a valid phone number, e.g. 0812345678'],
  'err.address': ['ที่อยู่ยาวเกินไป (ไม่เกิน 400 ตัวอักษร)', 'The address is too long (400 characters at most)'],
  'err.closed': ['ร้านยังไม่เปิดรับออเดอร์ออนไลน์', 'The shop is not taking online orders yet'], 'err.noAccount': ['ร้านยังตั้งค่าบัญชีรับเงินไม่เสร็จ ยังสั่งซื้อไม่ได้ในขณะนี้', 'The shop has not finished setting up payments, so ordering is not possible yet'],
  'err.priceChanged': ['ราคาหรือค่าจัดส่งมีการเปลี่ยนแปลง ตรวจสอบยอดใหม่ แล้วกดยืนยันอีกครั้ง', 'The price or shipping changed. Please check the new total and confirm again.'],
  'err.cartInvalid': ['มีสินค้าที่สั่งซื้อไม่ได้ กรุณาตรวจสอบตะกร้า', 'Some items cannot be ordered. Please check your cart.'], 'err.tooMany': ['สั่งซื้อบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'Too many orders in a short time. Please wait a while.'],
  'err.network': ['เชื่อมต่อไม่ได้ กดลองอีกครั้งได้อย่างปลอดภัย ระบบจะไม่สร้างคำสั่งซื้อซ้ำ', 'Could not connect. You can safely try again: a duplicate order will not be created.'],
  'err.generic': ['เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', 'Something went wrong. Please try again.'], 'err.signin': ['กรุณาเข้าสู่ระบบอีกครั้ง', 'Please sign in again'],
  'err.delivery': ['ร้านยังไม่เปิดรับจัดส่ง', 'The shop is not offering delivery'], 'err.pickup': ['ร้านยังไม่เปิดให้รับสินค้าที่ร้าน', 'Pick-up is not available'],
  // orders
  'ord.title': ['คำสั่งซื้อของฉัน', 'My orders'], 'ord.f.all': ['ทั้งหมด', 'All'], 'ord.f.unpaid': ['ที่ต้องชำระ', 'To pay'], 'ord.f.to_ship': ['ที่ต้องจัดส่ง', 'To ship'],
  'ord.f.to_receive': ['ที่ต้องได้รับ', 'To receive'], 'ord.f.done': ['สำเร็จ', 'Completed'], 'ord.f.cancelled': ['ยกเลิก', 'Cancelled'],
  'ord.empty': ['ยังไม่มีคำสั่งซื้อ', 'No orders yet'], 'ord.emptyHint': ['เริ่มสั่งสินค้าชิ้นแรกของคุณกันเถอะ', 'Place your first order'], 'ord.start': ['เริ่มสั่งซื้อ', 'Start shopping'],
  'ord.emptyFilter': ['ไม่มีคำสั่งซื้อในหมวดนี้', 'No orders in this tab'],
  'ord.no': ['เลขที่ออเดอร์', 'Order no.'], 'ord.date': ['วันที่สั่ง', 'Date'], 'ord.n': ['{n} ชิ้น', '{n} items'], 'ord.total': ['ยอดรวม', 'Total'], 'ord.view': ['ดูรายละเอียด', 'View details'],
  'st.new': ['รอร้านยืนยัน', 'Waiting for the shop'], 'st.confirmed': ['ร้านยืนยันแล้ว', 'Confirmed'], 'st.preparing': ['กำลังเตรียมสินค้า', 'Preparing'], 'st.packed': ['แพ็คสินค้าแล้ว', 'Packed'],
  'st.ready': ['พร้อมรับสินค้า', 'Ready for pick-up'], 'st.shipped': ['จัดส่งแล้ว', 'Shipped'], 'st.completed': ['สำเร็จ', 'Completed'], 'st.cancelled': ['ยกเลิก', 'Cancelled'], 'st.returned': ['คืนสินค้า', 'Returned'],
  'pay.unpaid': ['ยังไม่ชำระ', 'Unpaid'], 'pay.pending': ['รอตรวจสอบการชำระเงิน', 'Awaiting payment verification'], 'pay.partial': ['ชำระบางส่วน', 'Partly paid'],
  'pay.paid': ['ชำระแล้ว', 'Paid'], 'pay.review': ['อยู่ระหว่างตรวจสอบยอดชำระ', 'Payment under review'], 'pay.rejected': ['หลักฐานการชำระถูกปฏิเสธ', 'Payment rejected'], 'pay.cancelled': ['ยกเลิก', 'Cancelled'],
  'od.title': ['รายละเอียดคำสั่งซื้อ', 'Order details'], 'od.progress': ['ความคืบหน้าของคำสั่งซื้อ', 'Order progress'], 'od.items': ['สินค้า', 'Items'], 'od.delivery': ['ข้อมูลการจัดส่ง', 'Delivery'],
  'od.pickup': ['รับสินค้าที่ร้าน', 'Pick up at the shop'], 'od.payment': ['การชำระเงิน', 'Payment'], 'od.shopNote': ['ข้อความจากร้าน', 'Message from the shop'], 'od.note': ['หมายเหตุของคุณ', 'Your note'],
  'od.cancel': ['ยกเลิกคำสั่งซื้อ', 'Cancel this order'], 'od.cancelTitle': ['ยกเลิกคำสั่งซื้อนี้?', 'Cancel this order?'],
  'od.again': ['สั่งซื้อรายการนี้อีกครั้ง', 'Order these items again'], 'od.againDone': ['เพิ่มสินค้าลงตะกร้าแล้ว กรุณาตรวจสอบราคาและจำนวนก่อนสั่งซื้อ', 'Items added to your cart. Please check the prices and quantities before ordering.'],
  'od.againNone': ['ไม่สามารถเพิ่มสินค้าลงตะกร้าได้ (ตะกร้าเต็ม)', 'The items could not be added (your cart is full).'],
  'od.cancelBody': ['หากคุณโอนเงินไปแล้ว กรุณาอย่ากดยกเลิก และติดต่อร้านแทน', 'If you have already paid, please do not cancel: contact the shop instead.'],
  'od.cancelled': ['ยกเลิกคำสั่งซื้อแล้ว', 'Order cancelled'], 'od.cancelReason': ['เหตุผลที่ยกเลิก', 'Why it was cancelled'], 'od.subtotal': ['ยอดสินค้า', 'Subtotal'],
  'od.refresh': ['รีเฟรชสถานะ', 'Refresh status'], 'od.notFound': ['ไม่พบคำสั่งซื้อนี้', 'This order was not found'], 'od.confirmYes': ['ยกเลิกคำสั่งซื้อ', 'Cancel order'],
  'od.err.PAYMENT_RECORDED': ['คำสั่งซื้อนี้ชำระเงินแล้ว ยกเลิกเองไม่ได้ กรุณาติดต่อร้าน', 'This order is paid and cannot be cancelled here. Please contact the shop.'],
  'od.err.SLIP_PENDING': ['มีสลิปที่รอร้านตรวจสอบ ยกเลิกไม่ได้ กรุณาติดต่อร้าน', 'A slip is waiting to be checked, so it cannot be cancelled. Please contact the shop.'],
  'od.err.ORDER_IN_PROGRESS': ['ร้านรับคำสั่งซื้อไปดำเนินการแล้ว ยกเลิกเองไม่ได้ กรุณาติดต่อร้าน', 'The shop has started on this order. Please contact the shop to cancel.'],
  // account
  'acc.title': ['บัญชีของฉัน', 'My account'], 'acc.orders': ['คำสั่งซื้อ', 'Orders'], 'acc.toPay': ['รอชำระ', 'To pay'], 'acc.language': ['ภาษา', 'Language'],
  'acc.myOrders': ['คำสั่งซื้อของฉัน', 'My orders'], 'acc.myOrdersHint': ['ดูสถานะและประวัติคำสั่งซื้อ', 'Order status and history'], 'acc.cart': ['ตะกร้าของฉัน', 'My cart'],
  'acc.cartHint': ['สินค้าที่เลือกไว้', 'Items you picked'], 'acc.shop': ['เลือกซื้อสินค้า', 'Browse products'], 'acc.shopHint': ['ดูสินค้าทั้งหมดของร้าน', 'See everything we sell'],
  'hdr.search': ['ค้นหา', 'Search'], 'hdr.cart': ['ตะกร้า', 'Cart'], 'hdr.account': ['บัญชี', 'Account'], 'hdr.title': ['ร้านค้าออนไลน์', 'Online shop'],
  // wallet and payment methods
  'w.title': ['กระเป๋าเงินของฉัน', 'My wallet'], 'w.balance': ['ยอดเงินคงเหลือ', 'Available balance'], 'w.totalDeposits': ['เติมเงินทั้งหมด', 'Total deposits'],
  'w.totalPayments': ['ใช้ชำระแล้วทั้งหมด', 'Total payments'], 'w.add': ['เติมเงิน', 'Add money'], 'w.payInvoice': ['ชำระใบแจ้งหนี้', 'Pay invoice'],
  'w.recent': ['รายการล่าสุด', 'Recent transactions'], 'w.history': ['ประวัติทั้งหมด', 'Full history'], 'w.noTxn': ['ยังไม่มีรายการในกระเป๋าเงิน', 'No wallet transactions yet'],
  'w.pending': ['รอตรวจสอบ {amount}', 'Waiting for verification: {amount}'], 'w.methods': ['ช่องทางการชำระเงิน', 'Payment methods'], 'w.deposits': ['รายการเติมเงินของฉัน', 'My deposits'],
  'w.about': ['เงินในกระเป๋าใช้ชำระใบแจ้งหนี้ครั้งต่อไปได้ เงินจะเข้ากระเป๋าหลังร้านตรวจสอบการโอนแล้วเท่านั้น', 'Use your wallet to pay future invoices. Money is added only after the shop has verified your transfer.'],
  'w.loadMore': ['ดูเพิ่มเติม', 'Load more'], 'w.balanceAfter': ['คงเหลือ {amount}', 'Balance {amount}'], 'w.back': ['กลับ', 'Back'],
  'w.t.DEPOSIT': ['เติมเงิน', 'Deposit'], 'w.t.INVOICE_PAYMENT': ['ชำระใบแจ้งหนี้', 'Invoice payment'], 'w.t.REFUND': ['คืนเงินเข้ากระเป๋า', 'Refund'],
  'w.t.ADJUSTMENT': ['ปรับยอดโดยร้าน', 'Adjustment'], 'w.t.WITHDRAWAL': ['ถอนเงิน', 'Withdrawal'], 'w.t.REVERSAL': ['ยกเลิกรายการ', 'Reversal'],
  'dep.pending': ['รอโอนและแนบสลิป', 'Waiting for your transfer and slip'], 'dep.submitted': ['ส่งสลิปแล้ว รอร้านตรวจสอบ', 'Slip sent, waiting for the shop'], 'dep.under_review': ['ร้านกำลังตรวจสอบ', 'Under review'],
  'dep.verified': ['ตรวจสอบแล้ว เติมเงินสำเร็จ', 'Verified: money added'], 'dep.rejected': ['ไม่ผ่านการตรวจสอบ', 'Rejected'], 'dep.cancelled': ['ยกเลิกแล้ว', 'Cancelled'],
  'dep.title': ['เติมเงินเข้ากระเป๋า', 'Add money to your wallet'], 'dep.pickBank': ['เลือกบัญชีที่จะโอนเข้า', 'Choose the account to transfer to'], 'dep.amount': ['จำนวนเงินที่จะโอน (บาท)', 'Amount to transfer (THB)'],
  'dep.create': ['ถัดไป: ดูข้อมูลการโอน', 'Next: transfer details'], 'dep.slip': ['แนบสลิปการโอน', 'Upload your transfer slip'], 'dep.submit': ['ส่งสลิป', 'Submit slip'],
  'dep.choose': ['เลือกรูปสลิป', 'Choose the slip picture'], 'dep.another': ['เลือกรูปอื่น', 'Choose another picture'], 'dep.preview': ['ตัวอย่างสลิป', 'Slip preview'],
  'dep.slipNote': ['การแนบสลิปยังไม่ทำให้เงินเข้ากระเป๋า ร้านจะตรวจสอบกับบัญชีธนาคารก่อน (ไฟล์ JPG, PNG หรือ PDF ไม่เกิน 5 MB)', 'Uploading a slip does not add money yet: the shop checks it against its bank record first (JPG, PNG or PDF, up to 5 MB).'],
  'dep.sent': ['ส่งสลิปแล้ว ร้านจะตรวจสอบโดยเร็ว', 'Slip sent. The shop will check it shortly.'], 'dep.cancel': ['ยกเลิกรายการนี้', 'Cancel this deposit'], 'dep.cancelledToast': ['ยกเลิกรายการเติมเงินแล้ว', 'Deposit cancelled'],
  'dep.reason': ['เหตุผล', 'Reason'], 'dep.continue': ['ส่งสลิปต่อ', 'Continue with the slip'], 'dep.transferTime': ['วันและเวลาที่โอน', 'Transfer date and time'], 'dep.ref': ['เลขอ้างอิงในสลิป (ถ้ามี)', 'Reference on the slip (optional)'],
  'dep.amountHint': ['ขั้นต่ำ {min} สูงสุด {max}', 'From {min} to {max}'], 'dep.open': ['เปิดดู', 'Open'], 'dep.noDeposits': ['ยังไม่มีรายการเติมเงิน', 'No deposits yet'],
  'pm.title': ['เลือกช่องทางการชำระเงิน', 'Choose how to pay'], 'pm.bank': ['โอนผ่านธนาคาร', 'Bank transfer'], 'pm.wallet': ['กระเป๋าเงิน', 'Customer wallet'], 'pm.qr': ['สแกน QR พร้อมเพย์', 'PromptPay QR'],
  'pm.walletBalance': ['คงเหลือ {amount}', 'Balance {amount}'], 'pm.none': ['ร้านยังไม่ได้ตั้งค่าช่องทางการชำระเงิน', 'The shop has not set up payment methods yet'],
  'bank.account': ['เลขที่บัญชี', 'Account number'], 'bank.holder': ['ชื่อบัญชี', 'Account name'], 'bank.copy': ['คัดลอกเลขบัญชี', 'Copy account number'], 'bank.copied': ['คัดลอกเลขบัญชีแล้ว', 'Account number copied'],
  'bank.copyFailed': ['คัดลอกไม่ได้ กรุณากดค้างที่เลขบัญชีเพื่อคัดลอก', 'Could not copy: press and hold the number'], 'bank.amount': ['ยอดที่ต้องโอน', 'Amount to transfer'],
  'bank.ref': ['เลขอ้างอิงการโอน', 'Payment reference'], 'bank.refHint': ['ใส่ในบันทึกช่วยจำของการโอนได้ ถ้าแอปธนาคารรองรับ', 'Put it in the transfer memo if your bank app allows'], 'bank.howto': ['วิธีชำระเงิน', 'How to pay'],
  'bank.copyRef': ['คัดลอกเลขอ้างอิง', 'Copy reference'], 'bank.refCopied': ['คัดลอกเลขอ้างอิงแล้ว', 'Reference copied'],
  'wp.title': ['ชำระด้วยกระเป๋าเงิน', 'Pay with your wallet'], 'wp.amount': ['จำนวนที่ต้องการชำระ (บาท)', 'Amount to pay (THB)'], 'wp.pay': ['ชำระ {amount} จากกระเป๋าเงิน', 'Pay {amount} from wallet'],
  'wp.confirmTitle': ['ชำระจากกระเป๋าเงิน?', 'Pay from your wallet?'], 'wp.confirmBody': ['ระบบจะหักเงิน {amount} จากกระเป๋าเงินของคุณ และบันทึกการชำระทันที', '{amount} will be taken from your wallet and recorded as paid straight away.'],
  'wp.done': ['ชำระด้วยกระเป๋าเงินสำเร็จ', 'Paid from your wallet'], 'wp.short': ['ยอดเงินในกระเป๋าไม่พอ ต้องเติมอีก {amount}', 'Not enough in your wallet: add {amount} more'], 'wp.max': ['ชำระได้สูงสุด {amount}', 'You can pay up to {amount}'],
  'we.INSUFFICIENT_FUNDS': ['ยอดเงินในกระเป๋าไม่พอ', 'Not enough money in your wallet'], 'we.AMOUNT_OUT_OF_RANGE': ['จำนวนเงินไม่อยู่ในช่วงที่กำหนด', 'The amount is outside the allowed range'],
  'we.TOO_MANY_OPEN_DEPOSITS': ['มีรายการเติมเงินที่ยังไม่เสร็จหลายรายการ กรุณาส่งสลิปหรือยกเลิกก่อน', 'You have several unfinished deposits: finish or cancel them first'],
  'we.SLIP_ALREADY_USED': ['สลิปนี้เคยถูกส่งแล้ว', 'This slip was already submitted'], 'we.BANK_NOT_AVAILABLE': ['บัญชีธนาคารนี้ไม่เปิดให้ใช้งาน', 'This bank account is not available'],
  'we.AMOUNT_EXCEEDS_OUTSTANDING': ['จำนวนเงินมากกว่ายอดค้างชำระ', 'The amount is more than what is owed'], 'we.NOTHING_OUTSTANDING': ['ใบแจ้งหนี้นี้ชำระครบแล้ว', 'This invoice is already paid'],
  'we.INVOICE_NOT_OPEN': ['ใบแจ้งหนี้นี้ปิดหรือถูกยกเลิกแล้ว', 'This invoice is closed or cancelled'], 'we.PAYMENT_UNDER_REVIEW': ['ร้านกำลังตรวจสอบการชำระเงินของใบแจ้งหนี้นี้', 'The shop is reviewing a payment on this invoice'],
  'we.DEPOSIT_NOT_PENDING': ['รายการนี้ส่งสลิปไปแล้ว', 'The slip was already sent for this deposit'], 'we.DEPOSIT_NOT_CANCELLABLE': ['รายการนี้ยกเลิกไม่ได้แล้ว', 'This deposit can no longer be cancelled'],
  'we.BAD_FILE_TYPE': ['รองรับเฉพาะไฟล์ JPG, PNG หรือ PDF', 'Only JPG, PNG or PDF files are accepted'], 'we.FILE_TOO_BIG': ['ไฟล์ต้องมีขนาดไม่เกิน 5 MB', 'The file must be 5 MB or smaller'],
  'we.UPLOAD_FAILED': ['อัปโหลดไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง', 'Could not upload the file. Please try again.'], 'we.KEY_REUSED': ['รายการนี้ถูกใช้ไปแล้ว กรุณาลองใหม่', 'That request was already used. Please try again.'],
  'we.NETWORK': ['เชื่อมต่อไม่ได้ กดลองอีกครั้งได้อย่างปลอดภัย ระบบจะไม่ทำรายการซ้ำ', 'Could not connect. You can safely try again: nothing will be done twice.'], 'we.ERROR': ['เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', 'Something went wrong. Please try again.'],
  'we.FORBIDDEN': ['กรุณาเข้าสู่ระบบอีกครั้ง', 'Please sign in again'], 'home.wallet': ['กระเป๋าเงิน', 'Wallet'],
} as const satisfies Record<string, readonly [string, string]>;

export type K = keyof typeof D;
/** Every text key (for tests that make sure each one exists in both languages). */
export const SHOP_KEYS = Object.keys(D) as K[];

export function tr(lang: ShopLang, k: K, vars?: Record<string, string | number>): string {
  const out = D[k][lang === 'en' ? 1 : 0] as string;
  return vars ? out.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : out;
}
export function useT() {
  const lang = useShopLang();
  return useCallback((k: K, vars?: Record<string, string | number>) => tr(lang, k, vars), [lang]);
}
