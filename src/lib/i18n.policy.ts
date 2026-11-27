// Thai for the customer payment policy screens (Payments & wallet → Customers, the QR → bank link card, the warning on Record payment). Keys are the exact English source strings.
export const TH_POLICY: Record<string, string> = {
  'Partial payments allowed': 'ชำระบางส่วนได้',
  'Full payment required': 'ต้องชำระเต็มจำนวน',
  'Customer payment policies are not installed in the database yet.': 'ยังไม่ได้ติดตั้งนโยบายการชำระเงินของลูกค้าในฐานข้อมูล',
  'Partial payments allowed: the customer may pay an invoice in instalments. Full payment required: the customer app only accepts the whole outstanding amount in one payment, from a slip or from the wallet. Staff can still record money they really received.':
    'ชำระบางส่วนได้: ลูกค้าแบ่งชำระใบแจ้งหนี้เป็นงวดได้ ต้องชำระเต็มจำนวน: แอปลูกค้ารับเฉพาะยอดค้างทั้งหมดในครั้งเดียว ทั้งจากสลิปและจากกระเป๋าเงิน พนักงานยังบันทึกเงินที่ได้รับจริงได้',
  'Only a finance manager can change a customer\'s policy.': 'เฉพาะผู้จัดการฝ่ายการเงินเท่านั้นที่เปลี่ยนนโยบายของลูกค้าได้',
  'Search customer name or code…': 'ค้นหาชื่อหรือรหัสลูกค้า…',
  'No customers found': 'ไม่พบลูกค้า',
  'Payment policy': 'นโยบายการชำระเงิน',
  'Open invoices': 'ใบแจ้งหนี้ที่ค้าง',
  'Still owed': 'ยอดที่ยังค้าง',
  Change: 'เปลี่ยน',
  'Payment policy saved': 'บันทึกนโยบายการชำระเงินแล้ว',
  'Payment policy · {n}': 'นโยบายการชำระเงิน · {n}',
  Reason: 'เหตุผล',
  'Kept in the history with your name and the time.': 'จะเก็บไว้ในประวัติพร้อมชื่อของคุณและเวลา',
  'From now on this customer\'s invoices can only be paid in full from the customer app. Invoices that are already partly paid: the customer pays the rest in one payment.':
    'ต่อจากนี้ ใบแจ้งหนี้ของลูกค้ารายนี้จะชำระจากแอปลูกค้าได้เฉพาะเต็มจำนวน ใบที่ชำระไปบางส่วนแล้ว ลูกค้าต้องชำระส่วนที่เหลือในครั้งเดียว',
  'PromptPay QR for wallet top-ups': 'QR พร้อมเพย์สำหรับเติมเงินเข้ากระเป๋า',
  'The shop\'s QR is "{n}". A wallet top-up is booked to one of your bank accounts, so choose the account this QR pays into. Until you do, customers see no QR option when they top up (bank transfer still works). If this account is not in the list, add it under Add a bank account first.':
    'QR ของร้านคือ "{n}" การเติมเงินเข้ากระเป๋าต้องลงบัญชีธนาคารของร้านหนึ่งบัญชี จึงต้องเลือกบัญชีที่ QR นี้โอนเข้า ถ้ายังไม่เลือก ลูกค้าจะไม่เห็นตัวเลือก QR ตอนเติมเงิน (โอนผ่านธนาคารยังใช้ได้) ถ้าบัญชีนี้ไม่อยู่ในรายการ ให้เพิ่มที่ "เพิ่มบัญชีธนาคาร" ก่อน',
  'Bank account of the QR': 'บัญชีธนาคารของ QR',
  'Not linked (no QR option for top-ups)': 'ยังไม่ผูก (ไม่มีตัวเลือก QR ตอนเติมเงิน)',
  'Not linked: customers see no QR when they top up': 'ยังไม่ผูก: ลูกค้าไม่เห็น QR ตอนเติมเงิน',
  'This customer must pay in full. The customer app refuses part payments for them. Record a part payment only for money you really received (for example cash at the counter): it is noted in the history.':
    'ลูกค้ารายนี้ต้องชำระเต็มจำนวน แอปลูกค้าไม่รับการชำระบางส่วนของลูกค้ารายนี้ ให้บันทึกการชำระบางส่วนเฉพาะเงินที่ได้รับจริง (เช่น เงินสดที่หน้าร้าน) ระบบจะจดไว้ในประวัติ',
};
