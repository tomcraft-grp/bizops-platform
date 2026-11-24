// Error alerts in Thai AND English (FB-001004, FB-001020).
// The database and the accounting engine raise plain-English messages. Staff and customers are mostly Thai speakers, so an error toast shows the Thai
// explanation first (or second, in the English UI) with the original English message underneath. The sentences are in errorMessages.app.ts (the app and the
// accounting engine) and errorMessages.db.ts (the database); a message without one fails tests/unit/bilingualErrors.test.ts. Nothing is guessed, nothing is hidden.
import { Lang, TH } from './i18n';
import { APP_MESSAGES, type Pair } from './errorMessages.app';
import { CODE_MESSAGES, DB_MESSAGES, SYSTEM_RULES } from './errorMessages.db';

const THAI = /[฀-๿]/;

const STATUS_TH: Record<string, string> = {
  verified: 'ยืนยันแล้ว', confirmed: 'ยืนยันการชำระแล้ว', more_evidence: 'ขอหลักฐานเพิ่มแล้ว', rejected: 'ถูกปฏิเสธแล้ว', submitted: 'ส่งแล้ว', paid: 'ชำระแล้ว', cancelled: 'ยกเลิกแล้ว', canceled: 'ยกเลิกแล้ว',
  pending: 'รอดำเนินการ', approved: 'อนุมัติแล้ว', expired: 'หมดอายุ', used: 'ใช้แล้ว', issued: 'ออกแล้ว', fulfilled: 'รับของแล้ว', completed: 'เสร็จสมบูรณ์', in_progress: 'กำลังดำเนินการ',
  partial: 'ดำเนินการบางส่วน', received: 'รับแล้ว', sent: 'ส่งออกแล้ว', failed: 'ล้มเหลว', active: 'เปิดใช้อยู่', inactive: 'ปิดใช้งาน', paused: 'หยุดชั่วคราว', reviewed: 'ตรวจทานแล้ว', retired: 'เลิกใช้แล้ว',
  released: 'ปล่อยแล้ว', reserved: 'จองไว้', queued: 'รอคิว', resolved: 'แก้ไขแล้ว', archived: 'เก็บเข้าคลังแล้ว', shipped: 'จัดส่งแล้ว', delivered: 'ส่งถึงแล้ว', closed_short: 'ปิดโดยรับไม่ครบ',
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
  [/the payment is older than the invoice/i, () => 'เวลาที่รับชำระเก่ากว่าใบแจ้งหนี้ กรุณาตรวจสอบวันและเวลาที่กรอก'],
  [/the payment time is in the future/i, () => 'เวลาที่รับชำระอยู่ในอนาคต กรุณาตรวจสอบวันและเวลาที่กรอก'],
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
  [/not allowed to post cash payments/i, () => 'การลงรายการรับเงินสดทำได้เฉพาะผู้จัดการ (ผู้ตรวจสอบบันทึกรับเงินสดได้ แต่ต้องให้ผู้จัดการเป็นผู้ลงรายการ)'],
  [/you are not allowed to|permission denied|not authorized/i, () => 'คุณไม่มีสิทธิ์ทำรายการนี้'],
  [/(?:invoice|evidence|receipt|deposit|customer|order|transaction) not found/i, () => 'ไม่พบรายการที่ต้องการ (อาจถูกยกเลิก หรือคุณไม่มีสิทธิ์เห็น)'],
  [/failed to fetch|network ?error|load failed|timed? ?out|connection/i, () => 'การเชื่อมต่ออินเทอร์เน็ตมีปัญหา กรุณาตรวจสอบสัญญาณแล้วลองใหม่อีกครั้ง'],
];

// ------------------------------------------------------------------------------------------------ the catalogue
interface Tpl { re: RegExp; keys: string[]; en: string; th: string; literal: number }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PH = /\{(\w+)(:w)?\}/g;
/** "Coupon is {1:w}" -> an anchored pattern with one group for each placeholder ({1:w} is a single word). */
function pattern(tpl: string): { re: RegExp; keys: string[]; literal: number } {
  const keys: string[] = []; let out = '', last = 0, literal = 0;
  const add = (s: string) => { out += esc(s); literal += s.replace(/[\s.,:;()“”"']/g, '').length; };
  for (const m of tpl.matchAll(PH)) { add(tpl.slice(last, m.index)); out += m[2] ? '([\\w-]+)' : '([\\s\\S]+?)'; keys.push(m[1]); last = (m.index ?? 0) + m[0].length; }
  add(tpl.slice(last));
  return { re: new RegExp(`^${out}$`), keys, literal };
}
const hasPlaceholder = (s: string) => /\{\w+(:w)?\}/.test(s);
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(PH, (m, k: string) => v[k] ?? m);
const plain = (s: string) => s.trim().replace(/\.$/, '');
const bare = (tpl: string) => tpl.replace(/:w\}/g, '}');

interface Side { exact: Map<string, Pair>; tpls: Tpl[] }
/** `by` is the side of the pair a text is compared with. A Thai sentence that stands for several different English ones is left out (it would be a guess). */
function build(pairs: Pair[], by: 'en' | 'th', minLiteral: number): Side {
  const exact = new Map<string, Pair>(); const clash = new Set<string>(); const tpls: Tpl[] = [];
  for (const [en, th] of pairs) {
    const key = by === 'en' ? en : th;
    if (hasPlaceholder(key)) { const p = pattern(key); if (p.literal >= minLiteral) tpls.push({ ...p, en: bare(en), th: bare(th) }); }
    else {
      const k = by === 'en' ? plain(key).toLowerCase() : plain(key); const old = exact.get(k);
      if (!old) exact.set(k, [en, th]); else if (by === 'th' && plain(old[0]).toLowerCase() !== plain(en).toLowerCase()) clash.add(k);
    }
  }
  if (by === 'th') clash.forEach((k) => exact.delete(k));
  return { exact, tpls: tpls.sort((a, b) => b.literal - a.literal) };
}
interface Index { msgEn: Side; msgTh: Side; dictEn: Side; dictTh: Side }
let index: Index | null = null;
function idx(): Index {                                                              // built at the first error: nobody pays for it before
  if (!index) {
    const msgs = [...APP_MESSAGES, ...DB_MESSAGES]; const dict = Object.entries(TH).filter(([, th]) => THAI.test(th)) as Pair[];
    index = { msgEn: build(msgs, 'en', 2), msgTh: build(msgs, 'th', 4), dictEn: build(dict, 'en', 8), dictTh: build(dict, 'th', 8) };
  }
  return index;
}
const STATUS_EN = Object.fromEntries(Object.entries(STATUS_TH).map(([en, th]) => [th, en]).reverse());

/** The values inside a message: a status is shown in Thai, an English reason that we know is explained in Thai, anything else stays as it is. */
function valueTh(v: string, depth: number): string {
  if (Object.prototype.hasOwnProperty.call(STATUS_TH, v.toLowerCase())) return st(v);
  return depth < 2 && (/\s/.test(v) || CODED.test(v)) && !THAI.test(v) ? findEn(v, depth + 1)?.th ?? v : v;
}
function viaTemplate(side: Side, text: string, by: 'en' | 'th', depth: number): Bilingual | null {
  for (const tpl of side.tpls) {
    const m = tpl.re.exec(text); if (!m) continue;
    const th: Record<string, string> = {}; const en: Record<string, string> = {};
    tpl.keys.forEach((k, i) => { th[k] = valueTh(m[i + 1], depth); en[k] = STATUS_EN[m[i + 1]] ?? m[i + 1]; });
    return by === 'en' ? { en: text, th: fill(tpl.th, th) } : { en: fill(tpl.en, en), th: fill(tpl.th, th) };
  }
  return null;
}

export interface Bilingual { en: string; th: string }
const CODED = /^([A-Z][A-Z_]{2,})(?::\s*|$)/;
const ACTION = /^[A-Z][A-Za-z/ -]{2,40}:\s+/;                                         // "Record payment: …", "Upload slip: …": what the app was doing

/** A head such as "Record payment" only names the action, so the Thai line has to say that it failed. */
const FAILING = /\b(?:could not|cannot|can't|failed|not|refused|only|error|problem|invalid)\b/i;

/** From an English message to both languages, or null when we have no explanation for it. */
function findEn(text: string, depth = 0): Bilingual | null {
  const full = text.trim(); if (!full) return null;
  const inner = full.replace(CODED, '') === full ? full.replace(ACTION, '') : full;
  const coded = CODED.exec(inner); const detail = coded ? inner.slice(coded[0].length).trim() : '';
  const tries = [...new Set([full, inner, detail].filter(Boolean))];
  const { msgEn, dictEn } = idx();
  for (const s of tries) {                                                             // the whole message first, then without the action, then without the code
    const p = msgEn.exact.get(plain(s).toLowerCase()) ?? (/\s/.test(s) ? dictEn.exact.get(plain(s).toLowerCase()) : undefined); if (p) return { en: full, th: bare(p[1]) };
    const b = viaTemplate(msgEn, s, 'en', depth) ?? viaTemplate(msgEn, plain(s), 'en', depth); if (b) return { en: full, th: b.th };
  }
  if (coded) {
    const c = Object.prototype.hasOwnProperty.call(CODE_MESSAGES, coded[1]) ? CODE_MESSAGES[coded[1]] : null;
    if (c && !detail) return { en: `${c[0]} (${coded[1]})`, th: c[1] };
    if (c && !RULES.some(([re]) => re.test(detail))) return { en: full, th: c[1] };
  }
  for (const s of tries) { const b = viaTemplate(dictEn, s, 'en', depth); if (b) return { en: full, th: b.th }; }
  const head = /^([^:]{6,}?):\s+([\s\S]+)$/.exec(full);                                // "Some files could not be uploaded: a.jpg"
  const known = head ? msgEn.exact.get(plain(head[1]).toLowerCase()) ?? dictEn.exact.get(`${head[1]}:`.toLowerCase()) ?? dictEn.exact.get(plain(head[1]).toLowerCase()) : undefined;
  if (head && known) return { en: full, th: `${known[1].replace(/:$/, '')}${FAILING.test(head[1]) ? '' : 'ไม่สำเร็จ'}: ${valueTh(head[2], depth)}` };
  for (const [re, th] of SYSTEM_RULES) if (re.test(full)) return { en: full, th };
  for (const [re, th] of RULES) { const m = re.exec(full); if (m) return { en: full, th: th(m) }; }
  return null;
}
/** From a Thai sentence the screen has already translated back to its English one, or null when it is not one of ours. */
function findTh(text: string): Bilingual | null {
  const full = text.trim(); const { msgTh, dictTh } = idx();
  const p = msgTh.exact.get(plain(full)) ?? dictTh.exact.get(plain(full));
  if (p) return { en: bare(p[0]), th: full };
  const b = viaTemplate(msgTh, full, 'th', 0) ?? viaTemplate(dictTh, full, 'th', 0); if (b) return b;
  const head = /^([^:]{4,}?):\s+([\s\S]+)$/.exec(full);
  const known = head ? msgTh.exact.get(plain(head[1])) ?? dictTh.exact.get(`${head[1]}:`) ?? dictTh.exact.get(plain(head[1])) : undefined;
  if (!head || !known) return null;
  const rest = THAI.test(head[2]) ? findTh(head[2])?.en ?? head[2] : head[2];
  return { en: `${known[0].replace(/:$/, '')}: ${rest}`, th: `${head[1]}: ${valueTh(head[2], 0)}` };
}

/** Both languages of an error message, whichever of the two it arrives in; null when we do not know it. */
export function bilingualError(text: string): Bilingual | null {
  if (!text?.trim()) return null;
  return THAI.test(text) ? findTh(text) : findEn(text);
}

/** The Thai explanation for an English error message, or null when we have none. */
export function thaiForError(text: string): string | null {
  return !text || THAI.test(text) ? null : findEn(text)?.th ?? null;
}

export const UNKNOWN_TH = 'ทำรายการไม่สำเร็จ ระบบแจ้งเหตุผลเป็นภาษาอังกฤษดังนี้';
/** What an error alert shows: the UI language first, the other one under it. A message we do not know is returned unchanged; with `unknownNote` (the back office)
 *  a Thai line says that the action failed and that the reason beside it is the system's own text. */
export function errorToastText(lang: Lang, text: string, opts?: { unknownNote?: boolean }): string {
  if (!text?.trim()) return text ?? '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => THAI.test(l)) && lines.some((l) => !THAI.test(l))) return text;   // carries both languages already
  const b = bilingualError(text);
  if (b) return b.en === b.th ? text : lang === 'th' ? `${b.th}\n${b.en}` : `${b.en}\n${b.th}`;
  if (!opts?.unknownNote || THAI.test(text) || !/[A-Za-z]{2}/.test(text)) return text;
  return lang === 'th' ? `${UNKNOWN_TH}\n${text}` : `${text}\n${UNKNOWN_TH}`;
}
/** The customer app: a sentence the shop has already translated stays as it is; only a raw English message gets its Thai beside it. */
export const customerErrorText = (lang: Lang, text: string): string => (THAI.test(text ?? '') ? text : errorToastText(lang, text));
/** The lines of an alert: the first is the main one. */
export const errorLines = (lang: Lang, text: string, opts?: { unknownNote?: boolean }): string[] => errorToastText(lang, text, opts).split('\n').filter((l) => l.trim());
