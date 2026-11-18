// Error alerts in Thai AND English (FB-001004, FB-001020).
// The database and the accounting engine raise plain-English messages. Staff and customers are mostly Thai speakers, so an error toast shows the Thai
// explanation first (or second, in the English UI) with the original English message underneath. A message we do not know is left exactly as it was:
// nothing is guessed, nothing is hidden.
import { Lang, t } from './i18n';

const THAI = /[฀-๿]/;

const STATUS_TH: Record<string, string> = {
  verified: 'ยืนยันแล้ว', rejected: 'ถูกปฏิเสธแล้ว', submitted: 'ส่งแล้ว', paid: 'ชำระแล้ว', cancelled: 'ยกเลิกแล้ว', canceled: 'ยกเลิกแล้ว',
  void: 'ยกเลิกแล้ว', voided: 'ยกเลิกแล้ว', reversed: 'กลับรายการแล้ว', closed: 'ปิดแล้ว', open: 'เปิดอยู่', draft: 'ฉบับร่าง', posted: 'ลงบัญชีแล้ว',
};
const st = (s: string) => STATUS_TH[s.toLowerCase()] ?? s;
const SUBJECT_TH: Record<string, string> = { 'this slip': 'สลิปนี้', 'this deposit': 'รายการเติมเงินนี้', receipt: 'ใบเสร็จ', invoice: 'ใบแจ้งหนี้' };

/** Known failures, most specific first. Each returns the Thai explanation for the English message it matched. */
const RULES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/this slip was already submitted/i, () => 'สลิปนี้เคยถูกส่งแล้ว (สลิปซ้ำ) หากเพิ่งส่งไป ร้านได้รับแล้ว กรุณารอร้านตรวจสอบ ส่งสลิปใบเดิมซ้ำไม่ได้'],
  [/bank transaction (\S+) was already recorded/i, (m) => `รหัสอ้างอิงการโอน ${m[1]} ถูกบันทึกไปแล้ว (อาจเป็นสลิปที่ใช้ซ้ำ)`],
  [/the transfer is older than the (invoice|deposit request)/i, (m) => `เวลาที่โอนเก่ากว่า${/invoice/i.test(m[1]) ? 'ใบแจ้งหนี้' : 'คำขอเติมเงิน'} สลิปอาจไม่ใช่ของรายการนี้`],
  [/the transfer time is in the future/i, () => 'เวลาที่โอนอยู่ในอนาคต กรุณาตรวจสอบวันและเวลาที่กรอก'],
  [/several slips for this invoice are already waiting/i, () => 'ใบแจ้งหนี้นี้มีสลิปรอตรวจสอบหลายใบแล้ว กรุณารอร้านตรวจสอบก่อน'],
  [/only jpg, png or pdf files are accepted/i, () => 'รองรับเฉพาะไฟล์ JPG, PNG หรือ PDF'],
  [/the file must be (\d+) ?mb or smaller/i, (m) => `ไฟล์ต้องมีขนาดไม่เกิน ${m[1]} MB`],
  [/^invalid file$/i, () => 'ไฟล์ไม่ถูกต้อง กรุณาเลือกรูปสลิปใหม่'],
  [/(this slip|this deposit|receipt|invoice) is already (\w+)/i, (m) => `${SUBJECT_TH[m[1].toLowerCase()]}${st(m[2])}แล้ว ทำรายการซ้ำไม่ได้`],
  [/(?:this invoice is|the invoice is) (\w+)/i, (m) => `ใบแจ้งหนี้นี้อยู่ในสถานะ "${st(m[1])}" จึงรับชำระหรือแก้ไขไม่ได้`],
  [/the bank transaction reference is required/i, () => 'ต้องกรอกรหัสอ้างอิงการโอนจากธนาคาร'],
  [/the transfer date and time are required/i, () => 'ต้องกรอกวันและเวลาที่โอน'],
  [/enter the amount shown by the bank/i, () => 'กรอกยอดเงินตามที่ธนาคารแสดง (ทศนิยมไม่เกิน 2 ตำแหน่ง)'],
  [/payments are recorded on this invoice/i, () => 'ใบแจ้งหนี้นี้มีการชำระเงินแล้ว กรุณากลับรายการการชำระเงินก่อน'],
  [/financial records are never deleted/i, () => 'ข้อมูลการเงินห้ามลบ ให้ใช้การกลับรายการแทน'],
  [/^a reason is required/i, () => 'ต้องระบุเหตุผล'],
  [/^please sign in/i, () => 'กรุณาเข้าสู่ระบบ'],
  [/you are not allowed to|permission denied|not authorized/i, () => 'คุณไม่มีสิทธิ์ทำรายการนี้'],
  [/(?:invoice|evidence|receipt|deposit|customer|order|transaction) not found/i, () => 'ไม่พบรายการที่ต้องการ (อาจถูกยกเลิก หรือคุณไม่มีสิทธิ์เห็น)'],
  [/failed to fetch|network ?error|load failed|timed? ?out|connection/i, () => 'การเชื่อมต่ออินเทอร์เน็ตมีปัญหา กรุณาตรวจสอบสัญญาณแล้วลองใหม่อีกครั้ง'],
];

/** The Thai explanation for an English error message, or null when we have none. */
export function thaiForError(text: string): string | null {
  if (!text || THAI.test(text)) return null;
  for (const [re, th] of RULES) { const m = re.exec(text); if (m) return th(m); }
  const dict = t('th', text);            // an exact entry in the translation dictionary
  return dict !== text ? dict : null;
}

/** What an error toast shows: the UI language first, the other one under it. Unknown messages are returned unchanged. */
export function errorToastText(lang: Lang, text: string): string {
  const th = thaiForError(text);
  if (!th) return t(lang, text);
  return lang === 'th' ? `${th}\n${text}` : `${text}\n${th}`;
}
