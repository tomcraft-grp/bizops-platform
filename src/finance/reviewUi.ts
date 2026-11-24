// What the slip-review screens need to show, kept out of the components so it can be unit-tested: the text of an AI tamper signal, the readable sentence for a refusal
// from the database, the comparison of what the order expected with what the AI read, de-duplicated reasons, and who may post. No JSX and nothing here changes a payment:
// the screens only ever send identifiers and what a staff member typed.
import { canFinance, type FinanceRole } from './api';
import { thaiForError } from '../lib/errorText';
import { t, type Lang } from '../lib/i18n';
import { money } from '../lib/util';
import { reasonValueText, type AiResult, type Bilingual, type Reason, type ReasonValue, type ReviewItem, type ReviewSettings, type SlipAnalysis } from './review';

// ------------------------------------------------------------------------------------------------ who may do what (a hint; the database enforces the same rules)
/**
 * Post is for a manager while `post_requires_manager` is on, else for a verifier; and a CASH payment is always for a manager, whatever the setting (cash has no bank record to
 * check against, so one verifier must not record cash and then post it alone). Pass the row's method; a transfer is the default. If the settings could not be read the
 * stricter rule is assumed: the buttons would only mirror the database anyway, and the database decides.
 */
export const mayPost = (role: FinanceRole | null, settings: ReviewSettings | null | undefined, method: 'transfer' | 'cash' | null | undefined = 'transfer') =>
  canFinance(role, (method === 'cash' || (settings?.post_requires_manager ?? true)) ? 'manage' : 'verify');

// ------------------------------------------------------------------------------------------------ dates in the shop's own time zone
const BKK = 'Asia/Bangkok';
const fmt = (iso: string | null | undefined, o: Intl.DateTimeFormatOptions) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-GB', { timeZone: BKK, hourCycle: 'h23', ...o }).format(d);
};
export const dayText = (iso: string | null | undefined) => fmt(iso, { day: '2-digit', month: 'short', year: 'numeric' });
export const timeText = (iso: string | null | undefined) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
/** The Bangkok calendar day of an instant, YYYY-MM-DD. */
const dayKey = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10) : '');
/**
 * Value for an <input type="datetime-local"> from an instant: the Bangkok wall clock, never the browser's own zone (every time on these screens is the shop's), so a
 * staff browser set to another zone still shows and sends the same moment. '' when there is none.
 */
export const localInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 16);
};
/** The instant (ISO, UTC) of what was typed in a datetime-local field, read as Bangkok time with an explicit +07:00; null when it is not a complete valid date and time. */
export const fromLocalInput = (v: string | null | undefined): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v ?? ''));
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+07:00`);
  if (Number.isNaN(d.getTime())) return null;
  return localInput(d.toISOString()).slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? d.toISOString() : null;          // 31 February would roll over into March: refuse it
};
/** Today's date in the shop's calendar (Bangkok), YYYY-MM-DD. */
export const todayBkk = (nowMs: number = Date.now()) => new Date(nowMs + 7 * 3600e3).toISOString().slice(0, 10);
/** True when a typed date and time is later than now plus the 10 minutes the database allows. A missing or broken value is not "in the future": other checks catch it. */
export const isFutureInput = (v: string, nowMs: number = Date.now(), toleranceMin = 10): boolean => {
  const at = fromLocalInput(v);
  return at != null && new Date(at).getTime() > nowMs + toleranceMin * 60e3;
};
/**
 * The range the KPI strip asks the database for. With no date chosen it is today for both ends, so Posted means "posted today"; the unresolved counts ignore the range anyway.
 */
export const summaryRange = (from: string, to: string, nowMs: number = Date.now()): { from: string; to: string; today: boolean } => {
  if (!from && !to) { const d = todayBkk(nowMs); return { from: d, to: d, today: true }; }
  return { from, to, today: false };
};

// ------------------------------------------------------------------------------------------------ the list
export const UNRESOLVED = ['slip_submitted', 'ai_completed', 'manual_review', 'confirmed', 'more_evidence'] as const;
export const SUSPICIOUS: AiResult[] = ['duplicate_suspected', 'suspicious_slip'];
const RED_RESULTS: AiResult[] = ['amount_mismatch', 'date_mismatch', 'duplicate_suspected', 'suspicious_slip'];

/** A row is tinted red when the AI found something that does not agree with the order, or the amount it read is not what the order expects. */
export function hasDiscrepancy(i: Pick<ReviewItem, 'ai_result' | 'ai_amount' | 'expected_amount' | 'ai_status'>): boolean {
  if (i.ai_status === 'queued' || i.ai_status === 'running') return false;
  if (i.ai_result && RED_RESULTS.includes(i.ai_result)) return true;
  return i.ai_amount != null && !!i.expected_amount && Math.abs(i.ai_amount - i.expected_amount) > 0.004;
}
/** The expected amount, or null when there is nothing to compare (0 would read as "nothing is owed", which a paid invoice shows as a dash). */
export const expectedOf = (i: Pick<ReviewItem, 'expected_amount'>): number | null => (i.expected_amount ? i.expected_amount : null);
/** What the "Transferred (AI)" column shows: the amount the AI read; for a confirmed or posted payment without a reading, the amount a person confirmed. */
export function transferredOf(i: Pick<ReviewItem, 'ai_amount' | 'confirmed_amount' | 'stage'>): { amount: number; from: 'ai' | 'confirmed' } | null {
  if (i.ai_amount != null) return { amount: i.ai_amount, from: 'ai' };
  if ((i.stage === 'confirmed' || i.stage === 'posted') && i.confirmed_amount != null) return { amount: i.confirmed_amount, from: 'confirmed' };
  return null;
}
/** The money of a payment as the screens name it in a dialog: what a person confirmed, else what the AI read, else what the customer said. */
export const amountOf = (i: Pick<ReviewItem, 'confirmed_amount' | 'ai_amount' | 'claimed_amount'>) => i.confirmed_amount ?? i.ai_amount ?? i.claimed_amount;

// ------------------------------------------------------------------------------------------------ reasons
const RANK = { info: 0, warn: 1, high: 2 } as const;
/** Each reason code once (the classifier can record one code for several sources); the most serious of the repeats stays, at the position of the first. */
export function uniqueReasons(rs: Reason[] | null | undefined): Reason[] {
  const out: Reason[] = [];
  for (const r of rs ?? []) {
    const at = out.findIndex((x) => x.code === r.code);
    if (at < 0) out.push(r); else if ((RANK[r.severity] ?? 0) > (RANK[out[at].severity] ?? 0)) out[at] = r;
  }
  return out;
}
export const uniqueCodes = (codes: string[] | null | undefined): string[] => [...new Set(codes ?? [])];

/** What a reason's expected / found value looks like: an amount as money, anything else as plain text. */
export function reasonValue(r: Pick<Reason, 'field'>, v: ReasonValue | undefined): string {
  if (r.field === 'amount' && typeof v === 'number') return money(v);
  return reasonValueText(v);
}

const SIGNALS: Record<string, Bilingual> = {
  font_mismatch: { en: 'Fonts in the picture do not match', th: 'ฟอนต์ในภาพไม่สอดคล้องกัน' },
  misaligned_text: { en: 'Text is not lined up the way the bank prints it', th: 'ข้อความจัดวางไม่เหมือนที่ธนาคารพิมพ์' },
  blur_region: { en: 'One part of the picture is blurred', th: 'บางส่วนของภาพเบลอ' },
  duplicate_artifacts: { en: 'Parts of the picture look copied', th: 'บางส่วนของภาพดูเหมือนถูกคัดลอก' },
  inconsistent_layout: { en: 'The layout does not look like a bank slip', th: 'รูปแบบไม่เหมือนสลิปของธนาคาร' },
  other: { en: 'Another sign that the picture was edited', th: 'สัญญาณอื่นว่าภาพถูกแก้ไข' },
};
/** The text of a tamper signal code; a code this table does not know (a newer reader) is shown as it is. */
export function SIGNAL_TEXT(code: string): Bilingual {
  const c = String(code ?? '');
  return Object.prototype.hasOwnProperty.call(SIGNALS, c) ? SIGNALS[c] : { en: c, th: c };
}
export const SIGNAL_CODES = Object.keys(SIGNALS);

// ------------------------------------------------------------------------------------------------ the comparison table: what the order expected, what the AI found
export type CmpField = 'amount' | 'date' | 'time' | 'receiver' | 'bank' | 'reference';
export interface CmpRow { field: CmpField; expected: string; found: string; confidence: number | null; differs: boolean }

const has = (rs: Reason[], ...codes: string[]) => rs.some((r) => codes.includes(r.code));
/**
 * The rows of the comparison. A row is "differs" (red) when the database said so (a reason on that field) or the values plainly disagree; a value the AI could not read,
 * where the order does expect one, differs too. Nothing here is a verdict: it only lays the two sides next to each other for a person.
 */
export function compareRows(a: SlipAnalysis | null | undefined, fallbackExpected: number | null = null): CmpRow[] {
  if (!a || !a.extracted) return [];
  const x = a.extracted, e = a.expected, q = a.qr, rs = a.reasons ?? [], c = x.field_confidence;
  const expAmount = e?.amount ?? fallbackExpected;
  const amountDiffers = has(rs, 'AMOUNT_UNDER', 'AMOUNT_OVER', 'AMOUNT_MISSING') || (expAmount != null && (x.amount == null || Math.abs(x.amount - expAmount) > 0.004));
  const fromDay = dayKey(e?.window_from), toDay = dayKey(e?.window_to), foundDay = dayKey(x.transfer_at);
  const dateDiffers = has(rs, 'DATE_OUT_OF_RANGE', 'DATE_MISSING') || (!!fromDay && !!toDay && (!foundDay || foundDay < fromDay || foundDay > toDay));
  const winFrom = e?.window_from ? new Date(e.window_from).getTime() : NaN, winTo = e?.window_to ? new Date(e.window_to).getTime() : NaN, at = x.transfer_at ? new Date(x.transfer_at).getTime() : NaN;
  const timeDiffers = has(rs, 'TIME_OUT_OF_RANGE', 'TIME_MISSING') || (!x.time_known && !!e?.window_from) || (x.time_known && !Number.isNaN(winFrom) && !Number.isNaN(winTo) && !Number.isNaN(at) && (at < winFrom || at > winTo));
  const days = fromDay && toDay ? (fromDay === toDay ? dayText(e?.window_from) : `${dayText(e?.window_from)} – ${dayText(e?.window_to)}`) : '';
  const times = e?.window_from && e?.window_to ? `${timeText(e.window_from)} – ${timeText(e.window_to)}` : '';
  const labels = (e?.receivers ?? []).map((r) => r.label).filter(Boolean);
  const banks = [...new Set((e?.receivers ?? []).map((r) => r.bank).filter((b): b is string => !!b))];
  const receiver = [x.receiver?.name, x.receiver?.account_hint].filter(Boolean).join(' · ');
  const receiverDiffers = has(rs, 'RECEIVER_MISMATCH', 'RECEIVER_UNCLEAR');
  const refDiffers = has(rs, 'QR_REF_MISMATCH', 'QR_BAD_CRC', 'DUPLICATE_REFERENCE');
  return [
    { field: 'amount', expected: expAmount != null ? money(expAmount) : '', found: x.amount != null ? money(x.amount) : '', confidence: c?.amount ?? null, differs: amountDiffers },
    { field: 'date', expected: days, found: dayText(x.transfer_at), confidence: c?.date ?? null, differs: dateDiffers },
    { field: 'time', expected: times, found: x.time_known ? timeText(x.transfer_at) : '', confidence: c?.time ?? null, differs: timeDiffers },
    { field: 'receiver', expected: labels.join(' / '), found: receiver, confidence: c?.receiver ?? null, differs: receiverDiffers },
    { field: 'bank', expected: banks.join(' / '), found: x.receiver?.bank ?? x.bank ?? '', confidence: null, differs: has(rs, 'RECEIVER_MISMATCH') },
    { field: 'reference', expected: q?.found ? (q.trans_ref ?? '') : '', found: x.trans_ref ?? '', confidence: c?.ref ?? null, differs: refDiffers },
  ];
}
export const percent = (v: number | null | undefined) => (v == null ? '' : `${Math.round(v * 100)}%`);

// ------------------------------------------------------------------------------------------------ the Confirm form's starting values
export interface ConfirmPrefill {
  amount: string;
  /** Always '': the person types the bank reference from the bank record (a slip can be faked, and the AI's reading of it is not the bank's). */
  ref: string;
  when: string;
  /** The date the AI read when it could not read the time of day (shown as a hint, never as the value); '' otherwise. */
  unreadTimeDay: string;
  /** The reference the AI read on the slip (or in its QR code): only a hint line, never a value of the form; '' when it read none. */
  aiRef: string;
  /** Which of the fields were filled in from the reading (what the note under the title may claim). */
  filled: ('amount' | 'when')[];
}
/**
 * What the Confirm form starts with: the amount and the time the AI actually read. A slip whose time of day could not be read is stored at 12:00 of its date (`time_known`
 * false): that is not read data, so the time stays empty and the person types it from the bank record. The bank reference is never filled in: the AI's reading of it is
 * returned as `aiRef`, for a hint line only. Nothing here is a decision; every value is checked and sent by a person.
 */
export function confirmPrefill(x: SlipAnalysis['extracted'] | null | undefined, qrRef: string | null | undefined): ConfirmPrefill {
  const amount = x?.amount != null ? String(x.amount) : '';
  const aiRef = x?.trans_ref ?? qrRef ?? '';
  const when = x?.time_known && x.transfer_at ? localInput(x.transfer_at) : '';
  const unreadTimeDay = x && !x.time_known && x.transfer_at ? dayText(x.transfer_at) : '';
  const filled: ConfirmPrefill['filled'] = [];
  if (amount) filled.push('amount'); if (when) filled.push('when');
  return { amount, ref: '', when, unreadTimeDay, aiRef, filled };
}

// ------------------------------------------------------------------------------------------------ refusals from the database, as sentences
// The database raises messages such as "EXCEEDS_OUTSTANDING: 500 is more than the 150 that can still be added to this invoice". For the codes people actually meet, the
// screen shows a sentence in both languages and the database's own text under it; any other message is shown as it is (errorToastText adds Thai for the ones it knows).
// The English sentence is the dictionary key of its Thai text (TH_BACKOFFICE).
const CODES: Record<string, string> = {
  CASH_OVERPAY: 'Cash cannot be more than the invoice still owes, and cash is never credited to the customer’s wallet.',
  NOT_CONFIRMED: 'This payment is not confirmed, so it cannot be posted. Confirm it first.',
  NO_CUSTOMER_SLIP: 'A payment recorded by staff has no customer slip to ask for.',
  TOO_MANY_ATTEMPTS: 'The AI has already checked this slip 5 times. Please check it by hand.',
  ALREADY_QUEUED: 'An AI check of this slip is already waiting or running.',
  AI_DISABLED: 'The AI check is switched off. A manager can turn it on under Review settings.',
  NOTHING_TO_DO: 'This payment has no slip picture for the AI to read.',
  NOTE_REQUIRED: 'Say where the cash was received (at least 3 characters).',
  REFERENCE_REQUIRED: 'Enter the bank transaction reference (4 to 80 letters or digits).',
  MESSAGE_REQUIRED: 'Tell the customer what is needed (3 to 300 characters).',
  INVALID_AMOUNT: 'Enter the amount in baht and satang (at most 2 decimals).',
  FILE_NOT_ALLOWED: 'A cash payment has no slip file.',
  BANK_NOT_AVAILABLE: 'This bank account is not available. Choose another one.',
  DUPLICATE_SUSPECT: 'Possible duplicate: a payment of the same amount to the same account, within a minute, is already recorded. Check the bank statement.',
};
const EXCEEDS = 'That is more than can still be added to this invoice ({n} left, counting payments confirmed but not yet posted).';
const EXCEEDS_NO_N = 'That is more than can still be added to this invoice (counting payments confirmed but not yet posted).';
export const SERVER_SENTENCES = [...Object.values(CODES), EXCEEDS, EXCEEDS_NO_N];

/** The sentence (dictionary key) and its values for a database message, or null for a message this screen has no sentence for. */
export function serverSentence(message: string): { key: string; vars: Record<string, string | number> } | null {
  const msg = String(message ?? '');
  const m = /\b(EXCEEDS_OUTSTANDING|[A-Z]+(?:_[A-Z]+)+)\b/.exec(msg);
  if (!m) return null;
  if (m[1] === 'EXCEEDS_OUTSTANDING') {
    const n = /than the ([0-9]+(?:\.[0-9]+)?) that can/.exec(msg);
    return n ? { key: EXCEEDS, vars: { n: money(Number(n[1])) } } : { key: EXCEEDS_NO_N, vars: {} };
  }
  return Object.prototype.hasOwnProperty.call(CODES, m[1]) ? { key: CODES[m[1]], vars: {} } : null;
}
/** The text of an error toast: the sentence in the UI language, then in the other one, then the database's own message. An unknown message is returned as it is. */
export function reviewErrorText(lang: Lang, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const s = serverSentence(raw);
  if (!s) return raw;
  const other: Lang = lang === 'th' ? 'en' : 'th';
  return [t(lang, s.key, s.vars), t(other, s.key, s.vars), raw].join('\n');
}
/** One line for a result list: the sentence in the UI language when there is one (errorText.ts knows the rest of the messages in Thai), else the message as it is. */
export function reviewErrorLine(lang: Lang, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const s = serverSentence(raw);
  return s ? t(lang, s.key, s.vars) : lang === 'th' ? thaiForError(raw) ?? raw : raw;
}
/** True when the database does not have the review functions yet (the migration is not applied). */
export const isMissingMigration = (message: string) => /schema cache|does not exist|Could not find the function/i.test(message);
