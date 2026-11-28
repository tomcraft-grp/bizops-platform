// The reader and the database: is it switched on, read one slip of the private bucket in this browser, store what was read (finance_store_reading judges it with the same rules as the AI
// reader and finds the receiver itself). Nothing here confirms, posts or rejects a payment.
import { finance, must, sha256 } from '../finance/api';
import { review, type AiResult, type ReviewDetail, type SlipDecision } from '../finance/review';
import { supabase } from '../lib/supabase';
import { withTimeout } from '../shop/timeout';
import { ENGINE, ReaderError, readPicture } from './engine';
import type { Reading, SlipQr } from './parse';

/** `checkout`: the check the customer sees before ordering (its own switch; absent on an older database); `before_min` / `after_min`: how far from now a slip may be dated;
 *  `recipients`: the names a slip may show as its receiver (the names on the payment card; absent on a database before 20261128150000) */
export interface OwnReaderStatus { enabled: boolean; can_read: boolean; can_manage: boolean; checkout?: boolean; before_min?: number; after_min?: number; recipients?: string[] }
export const ownReader = {
  /** null = a database without the reader */
  async status(): Promise<OwnReaderStatus | null> { const r = await supabase.rpc('finance_own_reader'); return r.error ? null : (r.data as OwnReaderStatus); },
  async setOn(on: boolean): Promise<OwnReaderStatus> { return must(await supabase.rpc('finance_set_own_reader', { p_on: on }), 'Save the reader setting'); },
  async setCheckout(on: boolean): Promise<OwnReaderStatus> { return must(await supabase.rpc('finance_set_checkout_check', { p_on: on }), 'Save the reader setting'); },
  async store(evidenceId: string, r: Reading & { qr: SlipQr }, fileSha256: string): Promise<{ result: AiResult; receiver_found: boolean; decision?: SlipDecision }> {
    return must(await supabase.rpc('finance_store_reading', { p_evidence: evidenceId, p_extracted: r.extracted, p_qr: { ...r.qr, file_sha256: fileSha256 }, p_confidence: r.confidence, p_text: r.text, p_engine: ENGINE }), 'Store the reading');
  },
};

export const isPicture = (type: string | null | undefined) => type === 'image/jpeg' || type === 'image/png';
/** Downloads a slip through the signed-in user's own permission (a short-lived link) and reads it here. */
export async function readSlipFile(path: string): Promise<{ reading: Reading & { qr: SlipQr }; sha: string }> {
  const url = await finance.slipUrl(path);
  const blob = await withTimeout(async (signal) => { const r = await fetch(url, { signal }); if (!r.ok) throw new ReaderError('FAILED', `The slip could not be downloaded (${r.status})`); return r.blob(); }, 30_000);
  return { reading: await readPicture(blob), sha: await sha256(blob) };
}
/** One slip: download, read, store. */
export async function readEvidence(e: { id: string; file_path: string | null }): Promise<AiResult> {
  if (!e.file_path) throw new ReaderError('NOT_A_PICTURE', 'This payment has no slip picture');
  const { reading, sha } = await readSlipFile(e.file_path);
  return (await ownReader.store(e.id, reading, sha)).result;
}

/** Slips nobody has read yet: submitted customer pictures without any analysis. */
export async function unread(limit = 50): Promise<{ id: string; label: string }[]> {
  const p = await review.list({ stage: ['slip_submitted'], source: ['customer_slip'], method: ['transfer'] }, limit, 0);
  return p.items.filter((i) => !i.ai_status).map((i) => ({ id: i.evidence_id, label: i.order_no ?? i.invoice_no }));
}

// ---------------------------------------------------------------- how good is it on OUR slips? (reads posted slips again and compares with what staff recorded from the bank; stores nothing)
export interface Accuracy { slips: number; failed: number; amount: Tally; date: Tally; qr: number; isSlip: number; ms: number }
export interface Tally { right: number; blank: number; wrong: number }
export const emptyAccuracy = (): Accuracy => ({ slips: 0, failed: 0, amount: { right: 0, blank: 0, wrong: 0 }, date: { right: 0, blank: 0, wrong: 0 }, qr: 0, isSlip: 0, ms: 0 });
const bkkDay = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10);
/** Compares one reading with what staff recorded from the bank record. */
export function scoreReading(a: Accuracy, r: Reading & { qr: SlipQr }, truth: { amount: number | null; transferAt: string | null }, ms: number): Accuracy {
  const t = (x: Tally, right: boolean | null): Tally => ({ right: x.right + (right === true ? 1 : 0), blank: x.blank + (right === null ? 1 : 0), wrong: x.wrong + (right === false ? 1 : 0) });
  const e = r.extracted;
  return {
    slips: a.slips + 1, failed: a.failed, qr: a.qr + (r.qr.crc_ok === true ? 1 : 0), isSlip: a.isSlip + (e.is_slip ? 1 : 0), ms: a.ms + ms,
    amount: truth.amount === null ? a.amount : t(a.amount, e.amount === null ? null : Math.round(e.amount * 100) === Math.round(truth.amount * 100)),
    date: truth.transferAt === null ? a.date : t(a.date, e.transfer_at === null ? null : e.transfer_at.slice(0, 10) === bkkDay(truth.transferAt)),
  };
}
export async function measure(limit: number, onStep: (a: Accuracy, total: number) => void, stopped: () => boolean): Promise<Accuracy> {
  const p = await review.list({ stage: ['posted'], source: ['customer_slip'], method: ['transfer'] }, limit, 0);
  let a = emptyAccuracy();
  for (const i of p.items) {
    if (stopped()) break;
    let d: ReviewDetail | null = null;
    try {
      d = await review.detail(i.evidence_id); const e = d.evidence;
      if (!e.file_path || !isPicture(e.file_type)) continue;
      const t0 = performance.now(); const { reading } = await readSlipFile(e.file_path);
      a = scoreReading(a, reading, { amount: e.verified_amount ?? e.confirmed_amount ?? null, transferAt: e.transfer_at ?? e.confirmed_transfer_at ?? null }, performance.now() - t0);
    } catch { a = { ...a, failed: a.failed + 1 }; }
    onStep(a, p.items.length);
  }
  return a;
}
