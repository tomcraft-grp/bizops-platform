// Thai for the back-office Online shop rewards screens (Promotions, Events tabs). Owned by the rewards UI tasks; keys are the English source text.
// Merged into the dictionary by lib/i18n.ts; an existing key elsewhere wins.
// ---- Events, "Online shop" tab: the three shared number boards and the Super Admin controls (rewards/EventsOnline.tsx, BoardAdmin.tsx, boardView.ts).
// Kept in its own block and spread below, so another task adding its own keys cannot collide with these.
const TH_EVENTS_ONLINE: Record<string, string> = {
  'POS on this device': 'POS บนอุปกรณ์เครื่องนี้',
  'Events — online shop': 'กิจกรรม — ร้านค้าออนไลน์',
  'Number boards for online-shop customers. The database decides who gets a number, so two customers can never hold the same exclusive number, whatever a screen shows.':
    'กระดานเลขสำหรับลูกค้าร้านค้าออนไลน์ ฐานข้อมูลเป็นผู้ตัดสินว่าใครได้เลขใด ลูกค้าสองคนจึงไม่มีทางถือเลขเฉพาะตัวเดียวกันได้ ไม่ว่าหน้าจอจะแสดงอย่างไร',
  'Event boards are switched off, so customers cannot see them yet. You can set everything up now; boards stay hidden from customers until a Super Admin switches them on.':
    'กระดานกิจกรรมถูกปิดอยู่ ลูกค้าจึงยังมองไม่เห็น คุณตั้งค่าทุกอย่างไว้ล่วงหน้าได้ กระดานจะซ่อนจากลูกค้าจนกว่า Super Admin จะเปิดใช้งาน',
  'Live updates are paused because the connection is failing. Retrying; what you see may be out of date.': 'การอัปเดตสดหยุดชั่วคราวเพราะการเชื่อมต่อมีปัญหา กำลังลองใหม่ ข้อมูลที่เห็นอาจไม่ล่าสุด',
  'You do not have access to the online-shop events. Ask a Super Admin if you need it.': 'คุณไม่มีสิทธิ์เข้าถึงกิจกรรมของร้านค้าออนไลน์ โปรดขอสิทธิ์จาก Super Admin หากจำเป็น',
  'Create an event to open three number boards for customers.': 'สร้างกิจกรรมเพื่อเปิดกระดานเลขสามกระดานให้ลูกค้า',
  'This event is active, but its dates are not running now, so customers cannot pick numbers.': 'กิจกรรมนี้เปิดใช้งานอยู่ แต่ขณะนี้ไม่อยู่ในช่วงวันที่ ลูกค้าจึงเลือกเลขไม่ได้',
  'rev {rev}': 'รุ่นที่ {rev}', taken: 'ถูกเลือก', 'Edit event': 'แก้ไขกิจกรรม', 'Event created as a draft': 'สร้างกิจกรรมเป็นฉบับร่างแล้ว', 'Event saved': 'บันทึกกิจกรรมแล้ว',
  'The server refused this change. Some changes (closing an event, changing the number range once numbers are taken) need a Super Admin.': 'เซิร์ฟเวอร์ปฏิเสธการเปลี่ยนแปลงนี้ บางอย่าง (การปิดกิจกรรม การเปลี่ยนช่วงเลขเมื่อมีเลขที่ถูกเลือกแล้ว) ต้องใช้ Super Admin',
  'Only a Super Admin can change the number range once numbers are taken.': 'เมื่อมีเลขที่ถูกเลือกแล้ว เฉพาะ Super Admin เท่านั้นที่เปลี่ยนช่วงเลขได้',
  // rename and recolour a board
  'Rename or recolour': 'เปลี่ยนชื่อหรือสี', 'Board saved': 'บันทึกกระดานแล้ว', 'Board name': 'ชื่อกระดาน', Colour: 'สี', 'Save board': 'บันทึกกระดาน',
  'Give the board a name of 1 to 40 characters.': 'ตั้งชื่อกระดานความยาว 1 ถึง 40 ตัวอักษร', 'Pick one of the colours.': 'เลือกสีจากที่ให้ไว้',
  Red: 'แดง', Orange: 'ส้ม', Green: 'เขียว', Teal: 'เขียวน้ำทะเล', Blue: 'น้ำเงิน', Purple: 'ม่วง', Pink: 'ชมพู', Grey: 'เทา',
  Dates: 'วันที่', Numbers: 'ช่วงเลข', '{n} numbers': '{n} เลข', 'Hold before a pick is final': 'เวลาพักก่อนการเลือกเป็นที่สิ้นสุด', 'Final at once': 'สิ้นสุดทันที',
  'Max per customer': 'สูงสุดต่อลูกค้า', 'No limit': 'ไม่จำกัด', 'Pick rules for this event': 'กติกาการได้สิทธิ์เลือกของกิจกรรมนี้',
  'No pick rule is linked to this event yet. Add one in Promotions (Online shop tab).': 'ยังไม่มีกติกาสิทธิ์เลือกที่ผูกกับกิจกรรมนี้ เพิ่มได้ที่หน้าโปรโมชั่น (แท็บร้านค้าออนไลน์)',
  Off: 'ปิด', 'Event status will be {status}.': 'สถานะกิจกรรมจะเป็น {status}', 'Working…': 'กำลังดำเนินการ…', 'Save event': 'บันทึกกิจกรรม',
  'Starts (Bangkok time)': 'เริ่ม (เวลากรุงเทพฯ)', 'Leave empty for no start date.': 'เว้นว่างหากไม่กำหนดวันเริ่ม', 'Ends (Bangkok time)': 'สิ้นสุด (เวลากรุงเทพฯ)',
  'Hold minutes': 'นาทีที่พักเลข', '0 makes a pick final at once.': '0 คือการเลือกสิ้นสุดทันที', 'Max picks per customer': 'จำนวนครั้งที่เลือกได้สูงสุดต่อลูกค้า', 'Leave empty for no limit.': 'เว้นว่างหากไม่จำกัด',
  // the form's refusals
  'Give the event a name.': 'กรุณาตั้งชื่อกิจกรรม',
  'Numbers must be whole, from 0 up, with "to" not below "from", and at most 1,000 numbers.': 'ช่วงเลขต้องเป็นจำนวนเต็ม เริ่มจาก 0 ขึ้นไป โดย "ถึง" ต้องไม่น้อยกว่า "จาก" และมีได้ไม่เกิน 1,000 เลข',
  'Hold minutes must be a whole number, 0 or more (0 confirms a pick at once).': 'นาทีที่พักต้องเป็นจำนวนเต็ม 0 ขึ้นไป (0 คือยืนยันการเลือกทันที)',
  'Leave empty for no limit, or enter a whole number of 1 or more.': 'เว้นว่างหากไม่จำกัด หรือใส่จำนวนเต็ม 1 ขึ้นไป',
  'Enter complete dates and times, with the end after the start.': 'กรอกวันและเวลาให้ครบ และวันสิ้นสุดต้องอยู่หลังวันเริ่ม',
  'No date limit': 'ไม่จำกัดวันที่', 'Not started yet': 'ยังไม่เริ่ม', 'Inside its dates': 'อยู่ในช่วงวันที่', Ended: 'สิ้นสุดแล้ว',
  // the board
  Exclusive: 'เลขเฉพาะคน', Shared: 'เลขร่วมกัน', Locked: 'ล็อกอยู่', Free: 'ว่าง', Taken: 'ถูกเลือกแล้ว',
  'This board is locked.': 'กระดานนี้ถูกล็อกอยู่', 'Customers cannot pick new numbers until it is unlocked.': 'ลูกค้าเลือกเลขใหม่ไม่ได้จนกว่าจะปลดล็อก',
  '{taken} of {total} numbers taken · revision {rev}': 'ถูกเลือก {taken} จาก {total} เลข · รุ่นที่ {rev}',
  '{name} numbers': 'เลขของ {name}', 'Taken by one customer': 'ถูกเลือกโดยลูกค้าคนเดียว', 'Reserved (held until confirmed)': 'พักไว้ (ถือไว้จนกว่าจะยืนยัน)', 'Shared (several customers)': 'ใช้ร่วมกัน (ลูกค้าหลายคน)',
  'Number {n}': 'เลข {n}', shared: 'ร่วม', 'Unknown customer': 'ลูกค้าที่ไม่ทราบชื่อ', 'Tap a number to see who holds it.': 'แตะเลขเพื่อดูว่าใครถืออยู่', 'Nobody holds this number.': 'ไม่มีใครถือเลขนี้',
  'Held until confirmed': 'พักไว้จนกว่าจะยืนยัน', 'Own number': 'เลขเฉพาะคน', 'Shared number': 'เลขร่วม',
  // the five Super Admin operations: what each one does and what it never does
  'Super Admin controls': 'การควบคุมของ Super Admin',
  'Each action is separate, needs a reason and is written to the audit log.': 'แต่ละการกระทำแยกจากกัน ต้องระบุเหตุผล และถูกบันทึกในบันทึกการตรวจสอบ',
  'The server refused: only a Super Admin can do this.': 'เซิร์ฟเวอร์ปฏิเสธ: เฉพาะ Super Admin เท่านั้นที่ทำได้',
  'Only a Super Admin can lock or unlock a board, switch its mode, release a number or reset a board.': 'เฉพาะ Super Admin เท่านั้นที่ล็อก/ปลดล็อกกระดาน สลับโหมด ปล่อยเลข หรือรีเซ็ตกระดานได้',
  'To release one number, tap it on the grid and use the button under it.': 'หากต้องการปล่อยเลขหนึ่งตัว ให้แตะเลขนั้นบนตาราง แล้วใช้ปุ่มด้านล่าง',
  'Lock board': 'ล็อกกระดาน', 'Stops new picks on this board. Customers can still see it.': 'หยุดการเลือกเลขใหม่บนกระดานนี้ ลูกค้ายังมองเห็นกระดานได้',
  'Numbers already taken stay as they are, and the mode does not change.': 'เลขที่มีคนเลือกไปแล้วยังคงเดิม และโหมดไม่เปลี่ยน',
  'Unlock board': 'ปลดล็อกกระดาน', 'Lets customers pick numbers on this board again.': 'ให้ลูกค้าเลือกเลขบนกระดานนี้ได้อีกครั้ง', 'Does not change any number or the mode.': 'ไม่เปลี่ยนเลขใดๆ และไม่เปลี่ยนโหมด',
  'Switch mode': 'สลับโหมด', 'Switch to {mode}': 'สลับเป็น {mode}',
  'Changes whether a number can be held by one customer or by several. It changes the mode only.': 'เปลี่ยนว่าเลขหนึ่งตัวถือได้โดยลูกค้าคนเดียวหรือหลายคน เปลี่ยนเฉพาะโหมดเท่านั้น',
  'Numbers already taken are kept, never rewritten or removed.': 'เลขที่มีคนเลือกไปแล้วจะถูกเก็บไว้ ไม่ถูกแก้ไขหรือลบ',
  'From now on several customers may hold the same number. Numbers already held by one customer stay theirs alone.': 'ต่อจากนี้ลูกค้าหลายคนถือเลขเดียวกันได้ เลขที่ลูกค้าคนเดียวถืออยู่แล้วยังเป็นของคนนั้นคนเดียว',
  'From now on a number belongs to one customer. Numbers already shared by several customers stay shared until they are released or the board is reset; nobody new can join them.':
    'ต่อจากนี้เลขหนึ่งตัวเป็นของลูกค้าคนเดียว เลขที่ลูกค้าหลายคนถือร่วมกันอยู่แล้วยังคงเป็นเลขร่วมจนกว่าจะปล่อยเลขหรือรีเซ็ตกระดาน และจะไม่มีใครเข้าร่วมเพิ่มได้',
  'Frees one number and gives the pick back to its owner.': 'ปล่อยเลขหนึ่งตัวและคืนสิทธิ์เลือกให้เจ้าของเลข', 'No other number is touched.': 'ไม่แตะต้องเลขตัวอื่น', 'Release #{n}': 'ปล่อยเลข #{n}',
  'Clears every number on this board so customers can pick again.': 'ล้างเลขทุกตัวบนกระดานนี้ เพื่อให้ลูกค้าเลือกใหม่ได้', 'History is never deleted: every selection stays on record.': 'ไม่ลบประวัติ: ทุกการเลือกยังคงถูกบันทึกไว้',
  'Reset {name}?': 'รีเซ็ต {name}?', '{n} numbers are taken on this board now.': 'ขณะนี้มีเลขที่ถูกเลือกบนกระดานนี้ {n} เลข', 'Return picks to customers': 'คืนสิทธิ์เลือกให้ลูกค้า',
  'Every number is cleared and customers get their picks back to choose again. History is kept, and you can undo the reset while no number has been taken since.':
    'ล้างเลขทุกตัว และลูกค้าได้รับสิทธิ์เลือกคืนเพื่อเลือกใหม่ เก็บประวัติไว้ และสามารถยกเลิกการรีเซ็ตได้ตราบที่ยังไม่มีใครเลือกเลขหลังจากนั้น',
  'Every number is cleared but the picks stay used: customers cannot choose again with them. History is kept, and you can undo the reset while no number has been taken since.':
    'ล้างเลขทุกตัว แต่สิทธิ์เลือกยังถือว่าใช้ไปแล้ว: ลูกค้าเลือกใหม่ด้วยสิทธิ์เหล่านั้นไม่ได้ เก็บประวัติไว้ และสามารถยกเลิกการรีเซ็ตได้ตราบที่ยังไม่มีใครเลือกเลขหลังจากนั้น',
  'Nothing to reset: no number is taken on this board.': 'ไม่มีอะไรให้รีเซ็ต: ยังไม่มีเลขที่ถูกเลือกบนกระดานนี้',
  'Undo reset': 'ยกเลิกการรีเซ็ต', 'Restores the numbers this reset cleared, if all of them are still free.': 'คืนเลขที่การรีเซ็ตนี้ล้างไป หากเลขทั้งหมดยังว่างอยู่', 'Does nothing if a number has been taken since.': 'จะไม่ทำอะไรหากมีคนเลือกเลขไปแล้วหลังจากนั้น',
  // errors
  'Only a Super Admin can do this.': 'เฉพาะ Super Admin เท่านั้นที่ทำรายการนี้ได้', 'Write the reason first.': 'กรุณาระบุเหตุผลก่อน', 'The name you typed does not match the board name.': 'ชื่อที่พิมพ์ไม่ตรงกับชื่อกระดาน',
  'The board changed while you were doing this, so it could not be completed. Check the board, then try again.': 'กระดานมีการเปลี่ยนแปลงระหว่างที่คุณทำรายการ จึงทำไม่สำเร็จ ตรวจสอบกระดานแล้วลองอีกครั้ง',
  'A number cleared by this reset has been taken again, so it cannot be restored.': 'มีเลขที่ถูกล้างในการรีเซ็ตนี้ถูกเลือกไปอีกครั้งแล้ว จึงคืนค่าไม่ได้',
  'That item was not found. It may have been changed by someone else.': 'ไม่พบรายการนี้ อาจมีผู้อื่นเปลี่ยนแปลงไปแล้ว', 'Event boards are switched off.': 'กระดานกิจกรรมถูกปิดอยู่',
  'The connection failed. Check the signal, then check the board before trying again.': 'การเชื่อมต่อล้มเหลว ตรวจสอบสัญญาณ แล้วดูสถานะกระดานก่อนลองใหม่',
  // tabs: history, resets, audit, needs review
  Resets: 'การรีเซ็ต', 'Needs review': 'ต้องตรวจสอบ', What: 'เหตุการณ์', 'Nothing has happened on this board yet.': 'ยังไม่มีเหตุการณ์ใดบนกระดานนี้', 'The audit log is empty.': 'บันทึกการตรวจสอบยังว่างอยู่',
  'This board has not been reset.': 'กระดานนี้ยังไม่เคยถูกรีเซ็ต', '{n} numbers cleared': 'ล้างไป {n} เลข', 'Picks returned to customers': 'คืนสิทธิ์เลือกให้ลูกค้าแล้ว', 'Picks stayed used': 'สิทธิ์เลือกยังถือว่าใช้ไปแล้ว',
  'Undone {when}': 'ยกเลิกเมื่อ {when}', 'Only the newest reset can be undone, and only while no number has been taken since.': 'ยกเลิกได้เฉพาะการรีเซ็ตล่าสุด และเฉพาะตอนที่ยังไม่มีใครเลือกเลขหลังจากนั้น',
  'Reset undone': 'ยกเลิกการรีเซ็ตแล้ว', 'Board reset': 'รีเซ็ตกระดานแล้ว', 'Board unlocked': 'ปลดล็อกกระดานแล้ว', 'Board locked': 'ล็อกกระดานแล้ว', 'Mode changed': 'เปลี่ยนโหมดแล้ว',
  'Number picked': 'เลือกเลข', 'Pick confirmed': 'ยืนยันการเลือกเลข', 'Hold expired': 'การพักเลขหมดเวลา', 'Review decided': 'ตัดสินรายการตรวจสอบแล้ว', 'Event status changed': 'เปลี่ยนสถานะกิจกรรมแล้ว', 'Reward error': 'ข้อผิดพลาดของระบบสิทธิ์',
  'Number kept': 'เก็บเลขไว้แล้ว', 'Keep number': 'เก็บเลขไว้', 'Nothing needs review.': 'ไม่มีรายการที่ต้องตรวจสอบ', 'no number held': 'ไม่ได้ถือเลข', 'Since {when}': 'ตั้งแต่ {when}',
  'A customer\'s bill was taken back after they had already used a pick on a number. The number stays as it is until a Super Admin decides.': 'บิลของลูกค้าถูกยกเลิกหรือคืนเงินหลังจากที่ลูกค้าใช้สิทธิ์เลือกเลขไปแล้ว เลขจะคงเดิมจนกว่า Super Admin จะตัดสิน',
  'The customer keeps this number. Nothing changes on the board.': 'ลูกค้าคงถือเลขนี้ไว้ ไม่มีอะไรเปลี่ยนบนกระดาน', 'Frees this number so other customers can pick it.': 'ปล่อยเลขนี้เพื่อให้ลูกค้าคนอื่นเลือกได้',
  'Only a Super Admin can decide these.': 'เฉพาะ Super Admin เท่านั้นที่ตัดสินรายการเหล่านี้ได้',
  'Every {step} on one bill earns {n} pick(s)': 'ทุก {step} ในบิลเดียว ได้สิทธิ์เลือก {n} ครั้ง',
  'Every {step} on one bill earns {n} pick(s), up to {max} per bill': 'ทุก {step} ในบิลเดียว ได้สิทธิ์เลือก {n} ครั้ง สูงสุด {max} ครั้งต่อบิล',
};

// ---- Promotions, "Online shop" tab: master switch, rules, promotion packs, "try it" (rewards/PromotionsOnline.tsx, RuleEditor.tsx, PackEditor.tsx, ruleForm.ts).
// Its own block, spread below, so the other rewards tasks cannot collide with it. tests/unit/rewardsRuleForm.test.ts fails if a sentence of those files has no entry.
const TH_PROMOTIONS_ONLINE: Record<string, string> = {
  // what a rule or a result earns
  '{n} point': '{n} แต้ม', '{n} points': '{n} แต้ม', '{n} pick': '{n} สิทธิ์เลือกเลข', '{n} picks': '{n} สิทธิ์เลือกเลข', picks: 'สิทธิ์เลือกเลข', points: 'แต้ม',
  'Every complete ฿{step} on one bill = {n} pick.': 'ทุกๆ ฿{step} ที่ครบในบิลเดียว = {n} สิทธิ์เลือกเลข', 'Every complete ฿{step} on one bill = {n} picks.': 'ทุกๆ ฿{step} ที่ครบในบิลเดียว = {n} สิทธิ์เลือกเลข',
  'Every complete ฿{step} on one bill = {n} point.': 'ทุกๆ ฿{step} ที่ครบในบิลเดียว = {n} แต้ม', 'Every complete ฿{step} on one bill = {n} points.': 'ทุกๆ ฿{step} ที่ครบในบิลเดียว = {n} แต้ม',
  'Every complete ฿{step} spent in total = {n} point.': 'ทุกๆ ฿{step} ที่ใช้จ่ายสะสมรวม = {n} แต้ม', 'Every complete ฿{step} spent in total = {n} points.': 'ทุกๆ ฿{step} ที่ใช้จ่ายสะสมรวม = {n} แต้ม',
  '฿{amount} on one bill → {n} pick.': '฿{amount} ในบิลเดียว → {n} สิทธิ์เลือกเลข', '฿{amount} on one bill → {n} picks.': '฿{amount} ในบิลเดียว → {n} สิทธิ์เลือกเลข',
  '฿{amount} on one bill → {n} point.': '฿{amount} ในบิลเดียว → {n} แต้ม', '฿{amount} on one bill → {n} points.': '฿{amount} ในบิลเดียว → {n} แต้ม',
  '฿{amount} spent in total → {n} point.': '฿{amount} ที่ใช้จ่ายสะสมรวม → {n} แต้ม', '฿{amount} spent in total → {n} points.': '฿{amount} ที่ใช้จ่ายสะสมรวม → {n} แต้ม',
  'Bills are never added together: two bills of ฿{amount} earn nothing.': 'ไม่นำหลายบิลมารวมกัน: สองบิล บิลละ ฿{amount} จะไม่ได้อะไรเลย',
  'At most {n} pick per bill.': 'สูงสุด {n} สิทธิ์เลือกเลขต่อบิล', 'At most {n} picks per bill.': 'สูงสุด {n} สิทธิ์เลือกเลขต่อบิล', 'At most {n} point per bill.': 'สูงสุด {n} แต้มต่อบิล', 'At most {n} points per bill.': 'สูงสุด {n} แต้มต่อบิล',
  // the rule form's refusals
  'Give the rule a name.': 'กรุณาตั้งชื่อกฎ', 'The amount per step must be more than ฿0.': 'ยอดต่อขั้นต้องมากกว่า ฿0', 'The reward must be a whole number, at least 1.': 'รางวัลต้องเป็นจำนวนเต็ม อย่างน้อย 1',
  'The limit per bill must be a whole number, at least 1 (or leave it empty).': 'ขีดจำกัดต่อบิลต้องเป็นจำนวนเต็ม อย่างน้อย 1 (หรือเว้นว่างไว้)', 'Choose the event these picks are for.': 'เลือกกิจกรรมที่สิทธิ์เหล่านี้ใช้',
  'Number picks are always counted per bill. "Total spent" is for points only.': 'สิทธิ์เลือกเลขนับแยกรายบิลเสมอ ส่วน "ยอดรวมที่ใช้จ่าย" ใช้ได้กับแต้มเท่านั้น', 'The end date cannot be before the start date.': 'วันสิ้นสุดต้องไม่อยู่ก่อนวันเริ่ม',
  'Remove inactive SKUs before saving: {list}': 'กรุณานำ SKU ที่ปิดใช้งานออกก่อนบันทึก: {list}',
  'Give the pack a name.': 'กรุณาตั้งชื่อแพ็ก', 'The pack price must be more than ฿0.': 'ราคาแพ็กต้องมากกว่า ฿0', 'Add at least one product to the pack.': 'เพิ่มสินค้าอย่างน้อยหนึ่งรายการในแพ็ก',
  'Quantities must be whole numbers, at least 1.': 'จำนวนต้องเป็นจำนวนเต็ม อย่างน้อย 1', 'Each product can be in the pack once: change its quantity instead.': 'สินค้าแต่ละรายการใส่ในแพ็กได้ครั้งเดียว ให้เปลี่ยนจำนวนแทน',
  'Points per pack must be a whole number, 0 or more (or leave it empty).': 'แต้มต่อแพ็กต้องเป็นจำนวนเต็ม 0 ขึ้นไป (หรือเว้นว่างไว้)', 'The eligible value must be 0 or more (or leave it empty).': 'มูลค่าที่นับต้องเป็น 0 ขึ้นไป (หรือเว้นว่างไว้)',
  "This rule counts a customer's total spend, so one bill cannot show it. Shown as if this were all they spent.": 'กฎนี้นับยอดรวมที่ลูกค้าใช้จ่ายทั้งหมด จึงดูจากบิลเดียวไม่ได้ ที่แสดงคือกรณีที่ลูกค้าใช้จ่ายเท่านี้เท่านั้น',
  'This rule only counts some products or customers. Use the cart test for an exact answer.': 'กฎนี้นับเฉพาะบางสินค้าหรือบางลูกค้า หากต้องการคำตอบที่แน่นอน ให้ลองด้วยตะกร้า',
  // what the server refused
  'You are not allowed to do this. Ask a Super Admin.': 'คุณไม่มีสิทธิ์ทำรายการนี้ กรุณาติดต่อ Super Admin',
  'SKU {sku} is inactive, so it cannot be added. Remove it, or switch it back to active in Products.': 'SKU {sku} ปิดใช้งานอยู่ จึงเพิ่มไม่ได้ ให้นำออก หรือเปิดใช้งานอีกครั้งในหน้าสินค้า',
  'A product in this form is inactive, so it cannot be added.': 'มีสินค้าในแบบฟอร์มนี้ที่ปิดใช้งานอยู่ จึงเพิ่มไม่ได้',
  'This rule is not valid: {detail}': 'กฎนี้ไม่ถูกต้อง: {detail}', 'This rule is not valid.': 'กฎนี้ไม่ถูกต้อง', 'This pack is not valid: {detail}': 'แพ็กนี้ไม่ถูกต้อง: {detail}', 'This pack is not valid.': 'แพ็กนี้ไม่ถูกต้อง',
  'Rewards are switched off. Use the master switch first.': 'ระบบรางวัลปิดอยู่ ให้เปิดสวิตช์หลักก่อน', 'That item no longer exists. Refresh the page.': 'ไม่พบรายการนี้แล้ว กรุณารีเฟรชหน้า',
  'No connection. Check the internet and try again.': 'ไม่มีการเชื่อมต่อ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง', 'This request was already sent with different details. Close the form and start again.': 'คำขอนี้เคยถูกส่งด้วยรายละเอียดอื่นแล้ว กรุณาปิดแบบฟอร์มแล้วเริ่มใหม่',
  'Something went wrong: {detail}': 'เกิดข้อผิดพลาด: {detail}', 'Something went wrong. Please try again.': 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง',
  // page, master switch
  'Points, number picks and promotion packs for customers of the online shop. Nothing changes for customers until the master switch is on.': 'แต้ม สิทธิ์เลือกเลข และแพ็กโปรโมชั่นสำหรับลูกค้าร้านค้าออนไลน์ ลูกค้าจะไม่เห็นการเปลี่ยนแปลงใดๆ จนกว่าจะเปิดสวิตช์หลัก',
  'New rule': 'กฎใหม่', 'New pack': 'แพ็กใหม่', 'Promotion packs': 'แพ็กโปรโมชั่น', 'Try it': 'ลองคำนวณ', 'Switched on': 'เปิดแล้ว', 'Switched off': 'ปิดแล้ว',
  
  'Let customers pick numbers on the event boards?': 'ให้ลูกค้าเลือกเลขบนกระดานกิจกรรมใช่หรือไม่?', 'Yes, switch on': 'ใช่ เปิดเลย', 'Master switch': 'สวิตช์หลัก',
  'Off = nothing changes for customers: no points, no picks, nothing extra on their screens.': 'ปิด = ลูกค้าไม่เห็นการเปลี่ยนแปลงใดๆ: ไม่มีแต้ม ไม่มีสิทธิ์เลือกเลข ไม่มีอะไรเพิ่มบนหน้าจอ',
  'Could not read the master switch.': 'อ่านสถานะสวิตช์หลักไม่ได้', 'Points and number picks': 'แต้มและสิทธิ์เลือกเลข', 'Customers earn from paid bills, following the rules below.': 'ลูกค้าได้รับจากบิลที่ชำระแล้ว ตามกฎด้านล่าง',
  'Event boards': 'กระดานกิจกรรม', 'Customers can use their picks on the event boards.': 'ลูกค้าใช้สิทธิ์เลือกเลขบนกระดานกิจกรรมได้', 'Only a Super Admin can change the master switch.': 'เฉพาะ Super Admin เท่านั้นที่เปลี่ยนสวิตช์หลักได้',
  // rules list
  'Rule switched on': 'เปิดกฎแล้ว', 'Rule switched off': 'ปิดกฎแล้ว', 'Categories: {n}': 'หมวดหมู่: {n}', 'Products: {n}': 'สินค้า: {n}', 'Excluding: {n}': 'ยกเว้น: {n}', 'Packs count': 'นับแพ็ก', 'Customers: {n}': 'ลูกค้า: {n}',
  'No rules yet': 'ยังไม่มีกฎ', 'Start from one of the two templates. The common values are filled in for you.': 'เริ่มจากหนึ่งในสองแม่แบบ ระบบกรอกค่าที่ใช้บ่อยไว้ให้แล้ว',
  'Number picks per bill': 'สิทธิ์เลือกเลขต่อบิล', 'Points per baht spent': 'แต้มตามยอดที่ใช้จ่าย', Rule: 'กฎ', 'Number picks': 'สิทธิ์เลือกเลข', 'What counts': 'สิ่งที่นับ', Everything: 'ทุกอย่าง', Always: 'ตลอดเวลา',
  'Given so far': 'ให้ไปแล้ว', '{n} bills': '{n} บิล',
  // packs list
  'Pack switched on': 'เปิดขายแพ็กแล้ว', 'Pack switched off': 'ปิดขายแพ็กแล้ว', 'No packs yet': 'ยังไม่มีแพ็ก',
  'A pack is one product with its own price that stands for several products, like 4 bottles for ฿300.': 'แพ็กคือสินค้าหนึ่งรายการที่มีราคาของตัวเอง แทนสินค้าหลายชิ้น เช่น 4 ขวด 300 บาท',
  'Inside one pack': 'ในแพ็กหนึ่ง', 'Points per pack': 'แต้มต่อแพ็ก', 'Eligible value': 'มูลค่าที่นับ', Sold: 'ขายแล้ว', 'Contents locked': 'ล็อกเนื้อหาแล้ว', 'On sale': 'เปิดขาย',
  // try it
  'No rule applies': 'ไม่มีกฎที่ใช้ได้', 'No active rule counts this cart.': 'ไม่มีกฎที่เปิดอยู่ที่นับตะกร้านี้', Counts: 'ยอดที่นับ', Earns: 'ได้รับ', 'Next reward': 'รางวัลถัดไป', '฿{x} more': 'อีก ฿{x}',
  'A bill amount': 'ยอดบิล', 'A cart': 'ตะกร้า', 'One bill': 'บิลเดียว', 'What would a single bill of this amount earn? Every rule is worked out on its own: bills are never added together.': 'บิลเดียวยอดเท่านี้จะได้อะไร? คำนวณแต่ละกฎแยกกัน: ไม่นำหลายบิลมารวมกัน',
  'Bill amount (฿)': 'ยอดบิล (฿)', 'Assumes every item on the bill counts. To test a rule that only counts some products, try a cart.': 'สมมติว่าสินค้าทุกชิ้นในบิลถูกนับ หากต้องการทดสอบกฎที่นับเฉพาะบางสินค้า ให้ลองด้วยตะกร้า',
  'Enter an amount': 'กรอกยอดเงิน', Cart: 'ตะกร้า', 'Add products or packs. The server works out what this cart would earn once it is paid.': 'เพิ่มสินค้าหรือแพ็ก ระบบจะคำนวณว่าตะกร้านี้จะได้อะไรเมื่อชำระเงินแล้ว',
  'Quantity of': 'จำนวนของ', 'Search products to add to the cart': 'ค้นหาสินค้าเพื่อเพิ่มลงตะกร้า', 'Cart total': 'ยอดรวมตะกร้า', 'Nothing to test yet': 'ยังไม่มีอะไรให้ทดสอบ', 'Add a product to see what the cart would earn.': 'เพิ่มสินค้าเพื่อดูว่าตะกร้าจะได้อะไร',
  // product search
  'Search by SKU or name': 'ค้นหาด้วย SKU หรือชื่อ', 'Type at least 2 characters.': 'พิมพ์อย่างน้อย 2 ตัวอักษร', 'Searching…': 'กำลังค้นหา…', 'No product matches.': 'ไม่พบสินค้าที่ตรงกัน', 'Search results': 'ผลการค้นหา',
  'Inactive: cannot be added': 'ปิดใช้งานอยู่: เพิ่มไม่ได้', 'Already added': 'เพิ่มแล้ว', 'A pack: use "Count promotion packs" instead': 'เป็นแพ็ก: ให้ใช้ตัวเลือก "นับแพ็กโปรโมชั่น" แทน', 'A pack cannot go inside a pack': 'แพ็กใส่ในแพ็กไม่ได้',
  // rule form
  'Customers collect points on what they pay.': 'ลูกค้าสะสมแต้มจากยอดที่จ่าย', 'Each eligible bill earns picks the customer uses on the event boards.': 'แต่ละบิลที่เข้าเงื่อนไขจะได้สิทธิ์เลือกเลข เพื่อใช้บนกระดานกิจกรรม',
  'Rule created': 'สร้างกฎแล้ว', 'Rule saved': 'บันทึกกฎแล้ว', 'Edit rule': 'แก้ไขกฎ', 'Save rule': 'บันทึกกฎ', 'Start from': 'เริ่มจาก',
  
  'Rule name': 'ชื่อกฎ', 'Every complete (฿)': 'ทุกๆ ยอดครบ (฿)', 'The bill amount that earns one reward.': 'ยอดบิลที่ได้รับรางวัลหนึ่งครั้ง', 'Picks earned': 'สิทธิ์เลือกเลขที่ได้', 'Given for each complete step.': 'ให้ทุกครั้งที่ยอดครบหนึ่งขั้น',
  'The events could not be loaded. Refresh the page.': 'โหลดกิจกรรมไม่ได้ กรุณารีเฟรชหน้านี้', 'There is no event yet. Create one in Events, then come back.': 'ยังไม่มีกิจกรรม กรุณาสร้างในหน้ากิจกรรมก่อน แล้วกลับมาที่นี่', 'Choose an event…': 'เลือกกิจกรรม…',
  'Leave empty to count everything in the shop. Shipping never counts.': 'เว้นว่างไว้เพื่อนับทุกอย่างในร้าน ค่าส่งไม่นับเสมอ', 'The categories could not be loaded.': 'โหลดหมวดหมู่ไม่ได้', 'No categories yet.': 'ยังไม่มีหมวดหมู่',
  'Only these products': 'เฉพาะสินค้าเหล่านี้', 'Search products to include': 'ค้นหาสินค้าที่ต้องการรวม', 'Advanced options': 'ตัวเลือกขั้นสูง', Starts: 'เริ่ม', Ends: 'สิ้นสุด',
  'Most per bill': 'สูงสุดต่อบิล', 'Optional cap on one bill.': 'จำกัดสูงสุดต่อบิล (ไม่บังคับ)',
  'How it counts': 'วิธีนับ', 'Per bill is the usual choice. Total spent adds up everything the customer has paid.': 'ปกติใช้แบบแยกรายบิล ส่วนยอดรวมจะรวมทุกอย่างที่ลูกค้าจ่ายแล้ว', 'Each bill on its own': 'แยกรายบิล', 'Total spent by the customer': 'ยอดรวมที่ลูกค้าใช้จ่าย',
  'Never count these products': 'ไม่นับสินค้าเหล่านี้', 'Search products to exclude': 'ค้นหาสินค้าที่ต้องการยกเว้น', 'Count promotion packs (at their eligible value)': 'นับแพ็กโปรโมชั่น (ตามมูลค่าที่นับ)',
  'Boards these picks can be used on': 'กระดานที่ใช้สิทธิ์เหล่านี้ได้', 'Leave all unticked for any board.': 'ไม่เลือกเลยหมายถึงใช้ได้ทุกกระดาน', 'Only these customers': 'เฉพาะลูกค้าเหล่านี้',
  'Active: counts bills as soon as rewards are switched on': 'เปิดใช้งาน: เริ่มนับบิลทันทีที่เปิดสวิตช์รางวัล',
  // pack form
  '1 pack = {units} items, ฿{price}.': '1 แพ็ก = {units} ชิ้น ฿{price}', '2 packs = {units} items, ฿{price}.': '2 แพ็ก = {units} ชิ้น ฿{price}',
  '1 pack = {units} items, ฿{price}, {pts} points.': '1 แพ็ก = {units} ชิ้น ฿{price} {pts} แต้ม', '2 packs = {units} items, ฿{price}, {pts} points.': '2 แพ็ก = {units} ชิ้น ฿{price} {pts} แต้ม',
  'Pack created: {code}': 'สร้างแพ็กแล้ว: {code}', 'Pack saved': 'บันทึกแพ็กแล้ว', 'New promotion pack': 'แพ็กโปรโมชั่นใหม่', 'Edit promotion pack': 'แก้ไขแพ็กโปรโมชั่น', 'A pack is sold as one product with its own price and code.': 'แพ็กขายเป็นสินค้าหนึ่งรายการ มีราคาและรหัสของตัวเอง',
  'Save pack': 'บันทึกแพ็ก', 
  'Pack name': 'ชื่อแพ็ก', 'e.g. 4 bottles for ฿300': 'เช่น 4 ขวด 300 บาท', 'Pack price (฿)': 'ราคาแพ็ก (฿)', 'What the customer pays for one pack.': 'ราคาที่ลูกค้าจ่ายต่อหนึ่งแพ็ก',
  'Optional. Gives exactly this many points per pack, and the points rules skip this pack. Empty lets the rules decide.': 'ไม่บังคับ ให้แต้มตามจำนวนนี้ต่อแพ็กพอดี และกฎแต้มจะข้ามแพ็กนี้ ว่างไว้ให้กฎเป็นผู้กำหนด',
  'Eligible value (฿)': 'มูลค่าที่นับ (฿)', 'Optional. How much of one pack counts toward rules that count packs. Empty means the full price.': 'ไม่บังคับ มูลค่าของหนึ่งแพ็กที่นับในกฎที่นับแพ็ก ว่างไว้หมายถึงนับเต็มราคา',
  'What is inside one pack': 'สิ่งที่อยู่ในแพ็กหนึ่ง', 'The products and quantities in one pack. Only active products can be added.': 'สินค้าและจำนวนในหนึ่งแพ็ก เพิ่มได้เฉพาะสินค้าที่เปิดใช้งาน', 'Pack contents': 'เนื้อหาในแพ็ก', 'Search products to put in the pack': 'ค้นหาสินค้าเพื่อใส่ในแพ็ก',
  // start date, customers, used rules, locked packs
  'Counts bills from now on. Bills paid before this rule exists do not earn.': 'นับบิลตั้งแต่ตอนนี้เป็นต้นไป บิลที่ชำระก่อนที่กฎนี้จะมีผลจะไม่ได้รับรางวัล',
  'Also counts bills placed since {date}, once rewards are switched on.': 'นับบิลที่สั่งตั้งแต่วันที่ {date} ด้วย เมื่อเปิดระบบรางวัลแล้ว',
  'Starts counting on {date}.': 'เริ่มนับตั้งแต่วันที่ {date}', 'Counts bills placed from {date}.': 'นับบิลที่สั่งตั้งแต่วันที่ {date}',
  'Choose the day this rule starts counting.': 'เลือกวันที่กฎนี้เริ่มนับ', 'The end date can only be moved later, or removed.': 'วันสิ้นสุดเลื่อนให้ช้าลงได้หรือลบออกเท่านั้น',
  'From now': 'ตั้งแต่ตอนนี้', 'From a date': 'ตั้งแต่วันที่เลือก', 'Start date': 'วันที่เริ่ม', 'Bills paid before this rule exists do not earn.': 'บิลที่ชำระก่อนที่กฎนี้จะมีผลจะไม่ได้รับรางวัล',
  'Bills placed before this day do not earn.': 'บิลที่สั่งก่อนวันนี้จะไม่ได้รับรางวัล', 'Optional. Bills are matched by the day they were placed.': 'ไม่บังคับ บิลจะถูกจับคู่ตามวันที่สั่งซื้อ',
  'From {date}': 'ตั้งแต่ {date}', 'Until {date}': 'ถึง {date}',
  'Search customers by name, phone or e-mail': 'ค้นหาลูกค้าด้วยชื่อ เบอร์โทร หรืออีเมล', 'Name, phone or e-mail': 'ชื่อ เบอร์โทร หรืออีเมล', 'No customer matches.': 'ไม่พบลูกค้าที่ตรงกัน',
  'Optional. Search by name, phone or e-mail. Empty means everyone.': 'ไม่บังคับ ค้นหาด้วยชื่อ เบอร์โทร หรืออีเมล ว่างไว้หมายถึงทุกคน',
  'This rule has already given rewards. To change how it works, duplicate it.': 'กฎนี้ให้รางวัลไปแล้ว หากต้องการเปลี่ยนวิธีทำงาน ให้ทำสำเนากฎ', Duplicate: 'ทำสำเนา',
  'Switch on for every customer? From now on, paid bills that fit an active rule earn rewards. Bills paid before a rule was created do not earn.': 'เปิดให้ลูกค้าทุกคนใช่หรือไม่? นับจากนี้ บิลที่ชำระแล้วและตรงกับกฎที่เปิดอยู่จะได้รับรางวัล บิลที่ชำระก่อนที่กฎจะถูกสร้างจะไม่ได้รับรางวัล',
  'This pack has been sold ({n} sold), so its contents, eligible value and points per pack are locked. Name, price and on sale can still change. To change the rest, create a new pack.': 'แพ็กนี้ขายไปแล้ว ({n} แพ็ก) จึงล็อกเนื้อหา มูลค่าที่นับ และแต้มต่อแพ็กไว้ ยังแก้ชื่อ ราคา และเปิดขายได้ หากต้องการเปลี่ยนส่วนอื่น ให้สร้างแพ็กใหม่',
  'Locked: this pack has been sold.': 'ล็อกแล้ว: แพ็กนี้ขายไปแล้ว',
};

export const TH_REWARDS: Record<string, string> = { ...TH_EVENTS_ONLINE, ...TH_PROMOTIONS_ONLINE };
