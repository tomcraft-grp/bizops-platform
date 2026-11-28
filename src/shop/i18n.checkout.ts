// Customer text of the checkout's two ways to get an order (LINE MAN delivery to a saved address, pick-up at the shop): [Thai, English].
// Merged into the shop dictionary in shop/i18n.ts. Thai is the polite shop register used elsewhere in the customer app.
export const CHECKOUT_D = {
  'co.deliveryHint': ['ร้านจะเรียก LINE MAN ไปส่งตามที่อยู่ที่ท่านเลือก', 'The shop books a LINE MAN driver to the address you choose'],
  'co.pickupHint': ['มารับสินค้าที่ร้าน ไม่ต้องกรอกที่อยู่', 'Collect your order at the shop. No address needed'],
  // LINE MAN: the address from the customer's address book
  'ck.shipTo': ['ที่อยู่จัดส่ง', 'Delivery address'],
  'ck.add': ['เพิ่มที่อยู่จัดส่ง', 'Add a delivery address'],
  'ck.none': ['ยังไม่มีที่อยู่จัดส่งในบัญชีของท่าน เพิ่มครั้งเดียว ใช้ได้ทุกครั้งที่สั่งซื้อ', 'You have no saved delivery address yet. Add one once and reuse it every time you order'],
  'ck.change': ['เปลี่ยน', 'Change'],
  'ck.close': ['ปิดรายการ', 'Close list'],
  'ck.edit': ['แก้ไข', 'Edit'],
  'ck.choose': ['เลือกที่อยู่จัดส่ง', 'Choose a delivery address'],
  'ck.loadFail': ['โหลดที่อยู่จัดส่งไม่สำเร็จ กรุณาลองใหม่', 'Could not load your delivery addresses. Please try again'],
  'ck.loading': ['กำลังโหลดที่อยู่จัดส่ง…', 'Loading your delivery addresses…'],
  'ck.incomplete': ['ที่อยู่นี้ข้อมูลยังไม่ครบ กรุณากดแก้ไข', 'This address is incomplete. Please edit it'],
  'ck.pickAddress': ['กรุณาเลือกหรือเพิ่มที่อยู่จัดส่ง', 'Please choose or add a delivery address'],
  'ck.manage': ['จัดการที่อยู่ทั้งหมดได้ที่ บัญชี → ที่อยู่จัดส่งของฉัน', 'Manage all your addresses in Account → My delivery addresses'],
  'ck.typeInstead': ['พิมพ์ที่อยู่เองโดยไม่ปักหมุด', 'Type an address without a pin'],
  'ck.useSaved': ['ใช้ที่อยู่ที่บันทึกไว้', 'Use a saved address'],
  'ck.typedLabel': ['ที่อยู่จัดส่ง (พิมพ์เอง)', 'Delivery address (typed)'],
  // pick-up
  'ck.pickupAt': ['รับสินค้าที่ร้าน', 'Pick up at the shop'],
  'ck.pickupSoon': ['รับเมื่อสินค้าพร้อม', 'When it is ready'],
  'ck.pickupWhen': ['เวลารับสินค้า', 'When to collect'],
  // contact details: only when the account has no name or phone to use
  'ck.contactTitle': ['ข้อมูลติดต่อ', 'Your contact details'],
  'ck.contactWhy': ['บัญชีของท่านยังไม่มีชื่อหรือเบอร์โทร กรุณากรอกเพื่อให้ร้านติดต่อได้', 'Your account has no name or phone yet. Fill them in so the shop can reach you'],
  // the address editor (checkout sheet and My delivery addresses)
  'ab.quick.home': ['บ้าน', 'Home'], 'ab.quick.office': ['ที่ทำงาน', 'Office'], 'ab.quick.other': ['อื่นๆ', 'Other'],
  'ab.fix': ['กรุณาตรวจสอบช่องที่มีเครื่องหมายสีแดง', 'Please check the fields marked in red'],
  'dl.f.more': ['รายละเอียดเพิ่มเติม (ไม่บังคับ)', 'More details (optional)'],
} as const satisfies Record<string, readonly [string, string]>;
