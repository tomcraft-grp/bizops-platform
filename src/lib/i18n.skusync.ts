// Thai for the Products page's SKU sync banner, filters and status messages. Owned by the SKU sync task; keys are the English source text.
// Merged into the dictionary by lib/i18n.ts; an existing key elsewhere wins.
export const TH_SKUSYNC: Record<string, string> = {
  // banner (src/pages/Products.tsx) and the age wording (domain/skuSync.ts syncAgeLabel)
  'Synced just now': 'ซิงค์แล้วเมื่อสักครู่',
  'Synced {n} min ago': 'ซิงค์แล้ว {n} นาทีที่แล้ว',
  'Synced {n} h ago': 'ซิงค์แล้ว {n} ชั่วโมงที่แล้ว',
  'Synced {n} d ago': 'ซิงค์แล้ว {n} วันที่แล้ว',
  'Not synced on this device yet': 'เครื่องนี้ยังไม่ได้ซิงค์',
  'Syncing SKUs…': 'กำลังซิงค์ SKU…',
  'Sync failed - retry': 'ซิงค์ไม่สำเร็จ - ลองอีกครั้ง',
  'Sync now': 'ซิงค์ตอนนี้',
  '{n} SKUs could not be applied': 'นำ SKU เข้าไม่สำเร็จ {n} รายการ',
  '{n} waiting to upload': 'รออัปโหลด {n} รายการ',
  'Show details': 'ดูรายละเอียด', 'Hide details': 'ซ่อนรายละเอียด',
  'They are tried again at every sync.': 'ระบบจะลองใหม่ทุกครั้งที่ซิงค์',
  // error sentences (domain/skuSync.ts describeSkuError)
  'Cannot reach the central database. Check the connection and try again.': 'เชื่อมต่อฐานข้อมูลกลางไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง',
  'Only staff (Admin or Super admin) can sync SKUs.': 'เฉพาะพนักงาน (แอดมินหรือซูเปอร์แอดมิน) เท่านั้นที่ซิงค์ SKU ได้',
  'SKU sync is not set up in the central database yet. Ask an administrator to apply the update.': 'ฐานข้อมูลกลางยังไม่ได้ติดตั้งระบบซิงค์ SKU กรุณาแจ้งผู้ดูแลระบบให้อัปเดต',
  'The app is still starting. Try again in a moment.': 'แอปกำลังเริ่มทำงาน กรุณาลองอีกครั้งในอีกสักครู่',
  'The SKU service returned an error.': 'ระบบ SKU แจ้งข้อผิดพลาด',
  // filters and badge
  'Not synced yet': 'ยังไม่ได้ซิงค์',
  'Pack': 'แพ็ก',
  'Promotion pack': 'แพ็กโปรโมชัน',
  // Re-sync everything
  'Re-sync everything': 'ซิงค์ใหม่ทั้งหมด',
  'Re-sync everything?': 'ซิงค์ใหม่ทั้งหมด?',
  'Every SKU is fetched again from the central database. Its name, price, cost, barcode, brand and active status replace what this device has. Stock, recipes, reorder levels, images and prep stations are not touched.':
    'ระบบจะดึง SKU ทุกรายการจากฐานข้อมูลกลางอีกครั้ง ชื่อ ราคา ต้นทุน บาร์โค้ด แบรนด์ และสถานะการใช้งานจะถูกแทนที่ด้วยข้อมูลจากฐานข้อมูลกลาง ส่วนสต็อก สูตร (BOM) ระดับสั่งซื้อ รูปภาพ และสถานีเตรียมจะไม่ถูกแตะต้อง',
  // Active switch
  'Could not change the status of {sku}: {e}': 'เปลี่ยนสถานะของ {sku} ไม่สำเร็จ: {e}',
  'Activated in the central database, but it has no price there, so it stays inactive on this device until a price is set.': 'เปิดใช้งานในฐานข้อมูลกลางแล้ว แต่ยังไม่มีราคา จึงยังคงไม่ใช้งานในเครื่องนี้จนกว่าจะตั้งราคา',
  // saving the product drawer (a refusal here keeps the drawer open and changes nothing on this device)
  'Name and SKU are required': 'ต้องระบุชื่อและ SKU',
  'Your role does not have permission: catalog:edit': 'บทบาทของคุณไม่มีสิทธิ์แก้ไขสินค้า (catalog:edit)',
  // New product
  'The product is saved on this device, but its price and details could not be sent to the central database ({e}). They will be sent again at the next sync.':
    'บันทึกสินค้าในเครื่องนี้แล้ว แต่ส่งราคาและรายละเอียดไปฐานข้อมูลกลางไม่สำเร็จ ({e}) ระบบจะส่งอีกครั้งตอนซิงค์ครั้งถัดไป',
};
