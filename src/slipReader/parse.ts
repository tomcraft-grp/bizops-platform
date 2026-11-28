// Our own slip reader (no AI service): turns the text an OCR engine read from a transfer slip into the same shape the AI reader produces, so the same database rules judge it.
// Pure functions (tests/unit/slipParse.test.ts). The rule everywhere: when the text is ambiguous the field is left EMPTY and a person looks at the slip. A wrong value is worse than none.
// It never sees what the order expects, so it cannot "find" the right amount.
import { normalize, type Extracted, type RawSlip } from '../../supabase/functions/slip-analyze/core.ts';

/** OCR splits sara am (ำ) into two characters, and spreads odd spaces and zero-width marks. */
const ch = String.fromCharCode;            // (built from code points: the characters themselves would be invisible in the source)
const SARA_AM = new RegExp(ch(0x0e4d) + ch(0x0e32), 'g');
const INVISIBLE = new RegExp('[' + ch(0x200b) + '-' + ch(0x200f) + ch(0xfeff) + ']', 'g');
const SPACES = new RegExp('[ \\t' + ch(0xa0) + ']+', 'g');
export const tidy = (s: string): string => s.normalize('NFC').replace(SARA_AM, ch(0x0e33)).replace(INVISIBLE, '').replace(SPACES, ' ');

const AMOUNT_LABEL = /จำ?นวน(?:เงิ?น)?|ยอด(?:เงิ?น|โอน|ชำระ|รวม)?|เงินโอน|amount|total/i;
const NOT_AMOUNT = /คงเหลือ|ใช้ได้|ค่าธรรม|ธรรมเนียม|fee|balance|available|วงเงิน|สะสม|points?|คะแนน/i;
// (a number right after another digit and a space is a number the engine cut in two: "92 8.00" is not 8 baht, so it is not read at all)
const MONEY = /(?<![\d.,/:-])(?<!\d\s)(฿|B|THB)?\s?((?:\d{1,3}(?:,\d{3})+|\d{1,7})\.\d{2})(?![\d.,])\s*(บาท|THB|Baht)?/gi;

interface Money { value: number; labelled: boolean; ambiguous: boolean }
/** Every amount of money in one reading, best first. */
function moneyIn(text: string): Money[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean); const out: Money[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MONEY)) {
      const value = Number(m[2].replace(/,/g, '')); if (!(value > 0) || value > 9_999_999) continue;
      const own = line.slice(0, m.index); const prev = /\d\.\d{2}/.test(lines[i - 1] ?? '') ? '' : lines[i - 1] ?? '';
      if (NOT_AMOUNT.test(own) || (!AMOUNT_LABEL.test(own) && NOT_AMOUNT.test(prev) && own.trim() === '')) continue;
      // "฿15,250.00" is read as "815,250.00": a leading 8 that is not followed by a written unit, and that still makes an amount when it is dropped, could be the baht sign
      const bare = !m[1] && !m[3]; const dropped = m[2].replace(/^8,?/, '');
      const ambiguous = bare && /^8/.test(m[2]) && /^[1-9]/.test(dropped) && /^(?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2}$/.test(dropped);
      // slips write thousands with a comma: five digits or more without one are two numbers run together ("581010.00" was "B1,010.00")
      const runTogether = value >= 10_000 && !m[2].includes(',');
      out.push({ value, labelled: AMOUNT_LABEL.test(own) || AMOUNT_LABEL.test(prev), ambiguous: ambiguous || runTogether });
    }
  });
  return out;
}
/** The transferred amount in one reading: the labelled one; without a label only when there is exactly one candidate. */
export function amountIn(text: string): { value: number; labelled: boolean } | null {
  const all = moneyIn(text); const lab = all.filter((m) => m.labelled); const pool = lab.length ? lab : all;
  const values = [...new Set(pool.map((m) => m.value))];
  if (values.length !== 1 || pool.some((m) => m.ambiguous)) return null;
  return { value: values[0], labelled: lab.length > 0 };
}

const MONTHS: [RegExp, number][] = [
  [/^ม\.?ค\.?$|^มกราคม$|^jan/i, 1], [/^ก\.?พ\.?$|^กุมภาพันธ์?$|^feb/i, 2], [/^มี\.?ค\.?$|^มีนาคม$|^mar/i, 3], [/^เม\.?ย\.?$|^เมษายน$|^apr/i, 4], [/^พ\.?ค\.?$|^พฤษภาคม$|^may/i, 5], [/^มิ\.?ย\.?$|^มิถุนายน$|^jun/i, 6],
  [/^ก\.?ค\.?$|^กรกฎาคม$|^jul/i, 7], [/^ส\.?ค\.?$|^สิงหาคม$|^aug/i, 8], [/^ก\.?ย\.?$|^กันยายน$|^sep/i, 9], [/^ต\.?ค\.?$|^ตุลาคม$|^oct/i, 10], [/^พ\.?ย\.?$|^พฤศจิกายน$|^nov/i, 11], [/^ธ\.?ค\.?$|^ธันวาคม$|^dec/i, 12],
];
/** The engine often adds a stray vowel under an abbreviated month ("ก.ุย." for "ก.ย."): no abbreviation has one, so it is dropped from short words. */
const monthOf = (w: string): number | null => {
  const s = w.replace(/\s/g, '').replace(/\.{2,}/g, '.');
  const find = (x: string) => MONTHS.find(([re]) => re.test(x))?.[1] ?? null;
  return find(s) ?? (s.replace(/\./g, '').length <= 4 ? find(s.replace(/ุ/g, '')) : null);
};
export interface DateRead { day: number; month: number; year: number }
/** The one date of a reading; null when there is none or more than one different date. */
export function dateIn(text: string): DateRead | null {
  const found: DateRead[] = []; const add = (day: number, month: number | null, year: number) => { if (month && day >= 1 && day <= 31 && month >= 1 && month <= 12) found.push({ day, month, year }); };
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*([ก-ฮะ-์.]{2,14}|[A-Za-z]{3,9})\.?,?\s*(25\d{2}|20\d{2}|\d{2})(?!\d)/g)) add(Number(m[1]), monthOf(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](25\d{2}|20\d{2}|\d{2})(?![\d/])/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)/g)) add(Number(m[3]), Number(m[2]), Number(m[1]));
  const keys = [...new Set(found.map((d) => `${d.day}/${d.month}/${d.year % 100}`))];
  return keys.length === 1 ? found[0] : null;
}
export function timeIn(text: string): { hour: number; minute: number; second: number } | null {
  const all = [...text.matchAll(/(?<![\d:.])([01]?\d|2[0-3])[:.]([0-5]\d)(?:[:.]([0-5]\d))?(?![\d:])(?!\s*(?:บาท|THB|Baht))/g)].filter((m) => m[0].includes(':') || /\s*น\./.test(text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 4)));
  const keys = [...new Set(all.map((m) => `${Number(m[1])}:${m[2]}`))];
  return keys.length === 1 ? { hour: Number(all[0][1]), minute: Number(all[0][2]), second: Number(all[0][3] ?? 0) } : null;
}
/** The printed reference: after its label, or the one long run of digits / letters on its own. */
export function refIn(text: string): string | null {
  const lab = [...text.matchAll(/(?:รหัสอ้างอิง|หมายเลขอ้างอิง|เลขที่อ้างอิง|เลขที่รายการ|อ้างอิง|transaction\s*id|reference(?:\s*(?:no\.?|number))?|ref\.?(?:\s*no\.?)?)\s*[:：.]?\s*\n?\s*([A-Za-z0-9]{10,40})/gi)].map((m) => m[1]);
  const pool = lab.length ? lab : [...text.matchAll(/(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d{6})[A-Za-z0-9]{14,40}(?![A-Za-z0-9])/g)].map((m) => m[0]);
  const u = [...new Set(pool.filter((x) => /\d{4}/.test(x)).map((x) => x.toUpperCase()))];
  return u.length === 1 ? u[0] : null;
}
const FAIL = /ไม่สำเร็จ|ล้มเหลว|ยกเลิกรายการ|unsuccessful|failed|cancel+ed/i;
const OKAY = /สำเร็จ|เรียบร้อย|successful|completed?/i;
const SLIP_WORD = /โอนเงิน|สำเร็จ|อ้างอิง|เลขที่รายการ|ค่าธรรมเนียม|จำนวนเงิน|พร้อมเพย์|transfer|transaction|reference|successful|promptpay/gi;

export interface SlipQr { found: boolean; crc_ok: boolean | null; sending_bank: string | null; trans_ref: string | null }
export interface Reading { extracted: Extracted; confidence: number; signals: { code: string; severity: 'low' | 'high'; detail: string }[]; text: string }

/**
 * One answer from several readings of the same picture. Readings that disagree about a value give no value; one that only a single reading has gives a low confidence.
 * `majority` (dates only, never money): two equal readings outvote a third, but then the answer is not sure enough to tell a customer about it.
 */
function agree<T>(values: (T | null)[], key: (v: T) => string, majority = false): { value: T | null; confidence: number } {
  const have = values.filter((v): v is T => v !== null); if (!have.length) return { value: null, confidence: 0 };
  if (new Set(have.map(key)).size > 1) {
    const win = majority && have.length >= 3 ? have.find((v) => have.filter((x) => key(x) === key(v)).length >= 2) : undefined;
    return win ? { value: win, confidence: 0.8 } : { value: null, confidence: 0 };
  }
  return { value: have[0], confidence: have.length >= 2 ? 0.95 : 0.7 };
}

/** The readings of one picture (each a full text) and its slip QR -> what the database rules read. */
export function readSlip(rawTexts: string[], qr: SlipQr, now: Date): Reading {
  const texts = rawTexts.map(tidy); const all = texts.join('\n');
  const amounts = texts.map(amountIn);
  const amount = agree(amounts, (a) => a.value.toFixed(2));
  const labelled = amounts.some((a) => a?.labelled);
  const date = agree(texts.map(dateIn), (d) => `${d.day}/${d.month}/${d.year % 100}`, true);
  const time = agree(texts.map(timeIn), (t) => `${t.hour}:${t.minute}`);
  const ref = agree(texts.map(refIn), (r) => r);
  const words = new Set([...all.matchAll(SLIP_WORD)].map((m) => m[0].toLowerCase()));
  const isSlip = qr.crc_ok === true || words.size >= 2 || (words.size >= 1 && amount.value !== null);
  const aConf = amount.value ? (labelled ? amount.confidence : Math.min(amount.confidence, 0.75)) : 0;
  const none = { name: null, bank: null, account_hint: null };
  const raw: RawSlip = {
    is_slip: isSlip, amount: amount.value?.value ?? null, currency: 'THB', date: date.value ? { ...date.value, era: null } : null, time: time.value, bank: qr.sending_bank, sender: none, receiver: none,
    trans_ref: ref.value ?? null, trans_id: null, status_text: FAIL.test(all) ? (FAIL.exec(all)?.[0] ?? null) : OKAY.test(all) ? 'สำเร็จ' : null,
    field_confidence: { amount: aConf, date: date.confidence, time: time.confidence, receiver: 0, ref: ref.confidence }, overall_confidence: Math.min(aConf, date.confidence), tamper_signals: [],
  };
  const n = normalize(raw, now);
  // the readings are kept apart by a form feed: the database takes one receiver per reading by its place on the slip, and needs two readings to agree before it calls the
  // receiver someone else (20261128150000_slip_recipient_check.sql). An older database reads the same text as one.
  return { extracted: n.extracted, confidence: n.confidence, signals: n.signals, text: texts.map((t) => t.slice(0, 3800)).join('\n\f\n') };
}
