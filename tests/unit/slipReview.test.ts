// The client side of the slip review (src/finance/review.ts): the labels the dashboard shows, the reason texts, and the thin RPC wrappers. The supabase client is a
// FAKE (no network, no database): what is proven here is the names and shapes the wrappers send, that nothing throws where it must not, and that the TypeScript
// side agrees with the SQL migration (the reason codes the classifier can emit, the keys of the review list / summary / detail / settings) so the two cannot drift.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const m = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), getUser: vi.fn(), upload: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: m.rpc, functions: { invoke: m.invoke }, auth: { getUser: m.getUser }, storage: { from: () => ({ upload: m.upload, remove: m.remove }) } },
}));

import {
  AI_RESULT, REASON_CODES, REASON_TEXT, REVIEW_ITEM_KEYS, REVIEW_SETTING_KEYS, REVIEW_SUMMARY_KEYS, REVIEW_DETAIL_KEYS, review, reasonValueText, STAGE,
  type AiResult, type ReviewStage,
} from '../../src/finance/review';
import { STATUS } from '../../src/finance/api';
import { t } from '../../src/lib/i18n';

const SQL = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261120100000_slip_review.sql'), 'utf8');
const THAI = /[฀-๿]/;
const nonEmpty = (s: unknown) => typeof s === 'string' && s.trim().length > 0;

// ---- reading the SQL (the same way for reason codes and for the keys of a jsonb_build_object)
/** The text of one function: from its "create or replace function public.<name>(" to the next "end $$;". */
function fnBody(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in the migration`);
  const end = SQL.indexOf('end $$;', start);
  if (end < 0) throw new Error(`end of ${name} not found`);
  return SQL.slice(start, end);
}
/** The top-level arguments of the call whose "(" is just before `from`: split at commas outside parentheses and quotes; stops at the matching ")". */
function callArgs(text: string, from: number): string[] {
  const args: string[] = []; let depth = 0, quote = false, cur = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { cur += c; if (c === "'") { if (text[i + 1] === "'") { cur += "'"; i++; } else quote = false; } continue; }
    if (c === "'") { quote = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { if (depth === 0) { args.push(cur.trim()); return args; } depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  throw new Error('unterminated call');
}
const UPPER_LITERAL = /'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)'/g;
const literals = (s: string) => [...s.matchAll(UPPER_LITERAL)].map((x) => x[1]);
/** Every reason code passed as the first argument of finance_slip_reason(...) in `text` (also inside a "case when ... then 'A' else 'B' end"), and every
 *  jsonb_build_object('code', 'X'). */
function reasonCodes(text: string): Set<string> {
  const out = new Set<string>();
  for (const mm of text.matchAll(/finance_slip_reason\(/g)) for (const c of literals(callArgs(text, mm.index! + mm[0].length)[0] ?? '')) out.add(c);
  for (const mm of text.matchAll(/jsonb_build_object\(\s*'code'\s*,\s*'([A-Z][A-Z0-9_]+)'/g)) out.add(mm[1]);
  return out;
}
/** The keys of the jsonb_build_object( that starts at `marker` in `text` (every other argument is a key). */
function objectKeys(text: string, marker: string): string[] {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  return callArgs(text, at + marker.length).filter((_, i) => i % 2 === 0).map((k) => k.replace(/^'|'$/g, ''));
}

describe('labels of the review: AI result and stage', () => {
  const RESULTS: AiResult[] = ['match', 'amount_mismatch', 'date_mismatch', 'time_anomaly', 'duplicate_suspected', 'suspicious_slip', 'manual_review'];
  const STAGES: ReviewStage[] = ['slip_submitted', 'ai_completed', 'manual_review', 'confirmed', 'posted', 'rejected', 'more_evidence'];

  it('has exactly the seven AI result ids of the database, each with English and Thai text and a tone', () => {
    expect(Object.keys(AI_RESULT).sort()).toEqual([...RESULTS].sort());
    for (const id of RESULTS) {
      const l = AI_RESULT[id];
      expect(nonEmpty(l.en), `${id} en`).toBe(true); expect(nonEmpty(l.th), `${id} th`).toBe(true); expect(THAI.test(l.th), `${id} th is Thai`).toBe(true);
      expect(['good', 'warn', 'bad', 'info', '']).toContain(l.tone);
    }
  });

  it('uses the agreed wording for the AI results (th in parentheses is the Thai text)', () => {
    expect(AI_RESULT.match.en).toBe('Verified / Match');                 expect(AI_RESULT.match.th).toBe('ตรงกัน');
    expect(AI_RESULT.amount_mismatch.en).toBe('Amount Mismatch');        expect(AI_RESULT.amount_mismatch.th).toBe('ยอดเงินไม่ตรง');
    expect(AI_RESULT.date_mismatch.en).toBe('Date Mismatch');            expect(AI_RESULT.date_mismatch.th).toBe('วันที่ไม่ตรง');
    expect(AI_RESULT.time_anomaly.en).toBe('Time Anomaly');              expect(AI_RESULT.time_anomaly.th).toBe('เวลาผิดปกติ');
    expect(AI_RESULT.duplicate_suspected.en).toBe('Duplicate Suspected'); expect(AI_RESULT.duplicate_suspected.th).toBe('สงสัยสลิปซ้ำ');
    expect(AI_RESULT.suspicious_slip.en).toBe('Suspicious Slip');        expect(AI_RESULT.suspicious_slip.th).toBe('สลิปน่าสงสัย');
    expect(AI_RESULT.manual_review.en).toBe('Manual Review Required');   expect(AI_RESULT.manual_review.th).toBe('ต้องตรวจสอบด้วยตนเอง');
  });

  it('the "match" label carries the caveat that an AI pass is not proof of payment; no other label needs one', () => {
    expect(AI_RESULT.match.hint).toEqual({ en: 'AI check passed — not proof of payment', th: 'AI ตรวจผ่านแล้ว — ไม่ใช่หลักฐานว่าเงินเข้าจริง' });
    for (const id of RESULTS.filter((x) => x !== 'match')) expect((AI_RESULT[id] as { hint?: unknown }).hint).toBeUndefined();
  });

  it('has exactly the seven stage ids of the database, each with English and Thai text and a tone', () => {
    expect(Object.keys(STAGE).sort()).toEqual([...STAGES].sort());
    for (const id of STAGES) {
      const l = STAGE[id];
      expect(nonEmpty(l.en), `${id} en`).toBe(true); expect(nonEmpty(l.th), `${id} th`).toBe(true); expect(THAI.test(l.th), `${id} th is Thai`).toBe(true);
      expect(['good', 'warn', 'bad', 'info', '']).toContain(l.tone);
    }
    expect(STAGE.slip_submitted).toMatchObject({ en: 'Slip Submitted', th: 'ส่งสลิปแล้ว' });
    expect(STAGE.ai_completed).toMatchObject({ en: 'AI Verification Completed', th: 'AI ตรวจแล้ว' });
    expect(STAGE.manual_review).toMatchObject({ en: 'Manual Review Required', th: 'ต้องตรวจสอบด้วยตนเอง' });
    expect(STAGE.confirmed).toMatchObject({ en: 'Payment Confirmed', th: 'ยืนยันการชำระแล้ว' });
    expect(STAGE.posted).toMatchObject({ en: 'Invoice Posted', th: 'ลงรายการแล้ว' });
    expect(STAGE.rejected).toMatchObject({ en: 'Payment Rejected', th: 'ปฏิเสธการชำระ' });
    expect(STAGE.more_evidence).toMatchObject({ en: 'More Evidence Requested', th: 'ขอหลักฐานเพิ่ม' });
  });

  it('the invoice status code 10 (more evidence requested) exists in the shared status table', () => {
    expect(STATUS[10]).toEqual({ en: 'More evidence requested', th: 'ขอหลักฐานเพิ่ม', tone: 'warn' });
  });

  it('the back-office Thai dictionary (TH_BACKOFFICE, used by Tx / T()) says the same as the label tables, so the two cannot drift', () => {
    for (const l of [...Object.values(AI_RESULT), ...Object.values(STAGE)]) expect(t('th', l.en), l.en).toBe(l.th);
    expect(t('th', AI_RESULT.match.hint!.en)).toBe(AI_RESULT.match.hint!.th);
    expect(t('th', STATUS[10].en)).toBe(STATUS[10].th);
    expect(t('th', 'Cash received')).toBe('รับเงินสด');                      // the label of the CASH_RECEIPT ledger event
  });
});

describe('reason texts agree with the classifier in the migration', () => {
  const classifyCodes = (() => {
    const body = fnBody('finance_classify_slip');
    const found = reasonCodes(body);
    // fallback: if the structured read found nothing (the SQL was rewritten), fall back to every upper-case literal of the body that looks like a code
    if (found.size === 0) for (const c of body.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)) found.add(c[1]);
    return found;
  })();
  const allSqlCodes = reasonCodes(SQL);              // the classifier plus finance_analysis_fail (AI_UNAVAILABLE)

  it('the reader of the SQL finds the codes it should (a guard against reading nothing and passing)', () => {
    expect([...classifyCodes].sort()).toEqual([
      'AMOUNT_MISSING', 'AMOUNT_OVER', 'AMOUNT_UNDER', 'DATE_MISSING', 'DATE_OUT_OF_RANGE', 'DUPLICATE_REFERENCE', 'LOW_CONFIDENCE', 'NOT_A_SLIP', 'QR_BAD_CRC',
      'QR_REF_MISMATCH', 'RECEIVER_MISMATCH', 'RECEIVER_UNCLEAR', 'RESUBMITTED_TRANSFER', 'STATUS_NOT_SUCCESS', 'TAMPER_SIGNAL', 'TIME_MISSING', 'TIME_OUT_OF_RANGE', 'UNREADABLE',
    ]);
    expect(allSqlCodes.has('AI_UNAVAILABLE')).toBe(true);
    expect(allSqlCodes.size).toBe(classifyCodes.size + 1);
    // the loose read (every upper-case literal of the classifier that looks like a code) must not find a code the structured read missed: a reason passed in a way the reader does not understand
    const loose = [...fnBody('finance_classify_slip').matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)].map((x) => x[1]);
    expect(loose.filter((c) => !classifyCodes.has(c))).toEqual([]);
  });

  it('every reason code the classifier can emit (and AI_UNAVAILABLE) has its own English and Thai text', () => {
    const missing = [...allSqlCodes].filter((c) => !REASON_CODES.includes(c as never));
    expect(missing, `reason codes in the SQL without a REASON_TEXT entry: ${missing.join(', ')}`).toEqual([]);
    for (const c of allSqlCodes) {
      const t = REASON_TEXT(c);
      expect(nonEmpty(t.en), `${c} en`).toBe(true); expect(nonEmpty(t.th), `${c} th`).toBe(true);
      expect(t.en, `${c} en is a sentence, not the raw code`).not.toBe(c); expect(t.th, `${c} th is not the raw code`).not.toBe(c);
      expect(THAI.test(t.th), `${c} th is Thai`).toBe(true);
    }
  });

  it('the table has no entry for a code the SQL never emits (a stale or invented text)', () => {
    const extra = REASON_CODES.filter((c) => !allSqlCodes.has(c));
    expect(extra, `REASON_TEXT entries without a code in the SQL: ${extra.join(', ')}`).toEqual([]);
  });

  it('an unknown code falls back to the raw code and never throws', () => {
    expect(REASON_TEXT('SOMETHING_NEW')).toEqual({ en: 'SOMETHING_NEW', th: 'SOMETHING_NEW' });
    for (const odd of ['', '   ', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const t = REASON_TEXT(odd);
      expect(t).toEqual({ en: odd, th: odd });                     // never a function from Object.prototype
    }
    expect(() => REASON_TEXT(undefined as unknown as string)).not.toThrow();
    expect(() => REASON_TEXT(null as unknown as string)).not.toThrow();
    expect(() => REASON_TEXT(42 as unknown as string)).not.toThrow();
    expect(REASON_TEXT(undefined as unknown as string)).toEqual({ en: '', th: '' });
  });

  it('a reason value is shown as text whatever the database put there: number, string, boolean, range, list, receiver', () => {
    expect(reasonValueText(350)).toBe('350');
    expect(reasonValueText(0)).toBe('0');                          // zero is a value, not "nothing"
    expect(reasonValueText('The amount could not be read')).toBe('The amount could not be read');
    expect(reasonValueText(null)).toBe('');
    expect(reasonValueText(undefined as never)).toBe('');
    expect(reasonValueText(false)).toBe('false');                  // QR_BAD_CRC: expected true, found false
    expect(reasonValueText({ from: '2026-11-19', to: '2026-11-20' })).toBe('2026-11-19 – 2026-11-20');   // DATE_OUT_OF_RANGE expected
    expect(reasonValueText(['KBANK', 'SCB'])).toBe('KBANK, SCB'); // RECEIVER_MISMATCH expected
    expect(reasonValueText({ name: 'X', account_hint: 'xxx-1' })).toBe('name: X, account_hint: xxx-1');   // RECEIVER_MISMATCH found
  });
});

describe('the TypeScript shapes agree with the SQL', () => {
  it('a review list item has exactly the keys finance_review_list builds', () => {
    const sql = objectKeys(fnBody('finance_review_list'), "jsonb_agg(jsonb_build_object(");
    expect(sql.length).toBe(28);
    expect([...REVIEW_ITEM_KEYS].sort()).toEqual([...sql].sort());
  });
  it('the summary, the detail and the settings have exactly the keys the SQL builds', () => {
    expect([...REVIEW_SUMMARY_KEYS].sort()).toEqual(objectKeys(fnBody('finance_review_summary'), 'select jsonb_build_object(').sort());
    expect([...REVIEW_DETAIL_KEYS].sort()).toEqual(objectKeys(fnBody('finance_review_detail'), 'return jsonb_build_object(').sort());
    expect([...REVIEW_SETTING_KEYS].sort()).toEqual(objectKeys(fnBody('finance_review_settings'), 'return (select jsonb_build_object(').sort());
    expect([...REVIEW_SETTING_KEYS].sort()).toEqual(objectKeys(fnBody('finance_save_review_settings'), 'return jsonb_build_object(').sort());
  });
});

describe('review.analyze is best effort: it never throws and never reads a verdict', () => {
  beforeEach(() => { m.invoke.mockReset(); });

  it('swallows a rejected invoke', async () => {
    m.invoke.mockRejectedValue(new Error('network down'));
    await expect(review.analyze({ evidenceId: 'e1' })).resolves.toEqual({ ok: false });
  });
  it('swallows a synchronous throw', async () => {
    m.invoke.mockImplementation(() => { throw new Error('boom'); });
    await expect(review.analyze({ evidenceId: 'e1' })).resolves.toEqual({ ok: false });
  });
  it('an error answer (HTTP error, not signed in, not found) is ok:false with no status', async () => {
    m.invoke.mockResolvedValue({ data: null, error: { message: 'Edge Function returned a non-2xx status code' } });
    await expect(review.analyze({ invoiceId: 'i1' })).resolves.toEqual({ ok: false });
  });
  it('a malformed answer is ok:false', async () => {
    for (const data of [null, undefined, 'completed', 42, [], {}, { status: 7 }]) {
      m.invoke.mockResolvedValue({ data, error: null });
      await expect(review.analyze({ evidenceId: 'e1' })).resolves.toEqual({ ok: false });
    }
  });
  it('passes the function\'s own status word through', async () => {
    for (const status of ['completed', 'failed', 'nothing_to_do']) {
      m.invoke.mockResolvedValue({ data: { status }, error: null });
      await expect(review.analyze({ evidenceId: 'e1' })).resolves.toEqual({ ok: true, status });
    }
  });
  it('returns nothing but ok and status, even if the function (wrongly) sent a verdict', async () => {
    m.invoke.mockResolvedValue({ data: { status: 'completed', result: 'suspicious_slip', reasons: [{ code: 'TAMPER_SIGNAL' }], error: 'secret detail' }, error: null });
    const r = await review.analyze({ evidenceId: 'e1' });
    expect(r).toEqual({ ok: true, status: 'completed' });
    expect(Object.keys(r).sort()).toEqual(['ok', 'status']);
  });
  it('calls slip-analyze with evidence_id and / or invoice_id; with neither it does not call at all', async () => {
    m.invoke.mockResolvedValue({ data: { status: 'completed' }, error: null });
    await review.analyze({ evidenceId: 'e1' });
    expect(m.invoke).toHaveBeenLastCalledWith('slip-analyze', { body: { evidence_id: 'e1' } });
    await review.analyze({ invoiceId: 'i1' });
    expect(m.invoke).toHaveBeenLastCalledWith('slip-analyze', { body: { invoice_id: 'i1' } });
    await review.analyze({ evidenceId: 'e1', invoiceId: 'i1' });
    expect(m.invoke).toHaveBeenLastCalledWith('slip-analyze', { body: { evidence_id: 'e1', invoice_id: 'i1' } });
    m.invoke.mockClear();
    await expect(review.analyze({})).resolves.toEqual({ ok: false });
    expect(m.invoke).not.toHaveBeenCalled();
  });
});

describe('review wrappers call the right function with the right parameter names', () => {
  beforeEach(() => { m.rpc.mockReset(); m.upload.mockReset(); m.remove.mockReset(); m.getUser.mockReset(); });
  const ok = (data: unknown) => m.rpc.mockResolvedValue({ data, error: null });

  it('list: finance_review_list(p_filter, p_limit, p_offset), default page 50 / 0', async () => {
    ok({ total: 0, items: [] });
    await expect(review.list({ stage: ['confirmed'], search: 'INV-1' }, 25, 50)).resolves.toEqual({ total: 0, items: [] });
    expect(m.rpc).toHaveBeenLastCalledWith('finance_review_list', { p_filter: { stage: ['confirmed'], search: 'INV-1' }, p_limit: 25, p_offset: 50 });
    await review.list({});
    expect(m.rpc).toHaveBeenLastCalledWith('finance_review_list', { p_filter: {}, p_limit: 50, p_offset: 0 });
  });
  it('summary: finance_review_summary(p_from, p_to) with dates or null', async () => {
    ok({ rejected: 0 });
    await review.summary('2026-11-19', '2026-11-19');
    expect(m.rpc).toHaveBeenLastCalledWith('finance_review_summary', { p_from: '2026-11-19', p_to: '2026-11-19' });
    await review.summary(null, null);
    expect(m.rpc).toHaveBeenLastCalledWith('finance_review_summary', { p_from: null, p_to: null });
    await review.summary('', '');                                                   // an empty date box means "no end": the database gets null, never ''
    expect(m.rpc).toHaveBeenLastCalledWith('finance_review_summary', { p_from: null, p_to: null });
  });
  it('detail: finance_review_detail(p_evidence)', async () => {
    ok({ evidence: { id: 'e1' } });
    await review.detail('e1');
    expect(m.rpc).toHaveBeenLastCalledWith('finance_review_detail', { p_evidence: 'e1' });
  });
  it('confirm: finance_confirm_evidence with the values the bank shows', async () => {
    ok({ status: 'confirmed', evidence_id: 'e1', amount: 350 });
    await review.confirm({ evidenceId: 'e1', amount: 350, bankRef: 'REF12345', transferAt: '2026-11-19T07:02:00.000Z', note: 'checked in the app' });
    expect(m.rpc).toHaveBeenLastCalledWith('finance_confirm_evidence', { p_evidence: 'e1', p_amount: 350, p_bank_trans_ref: 'REF12345', p_transfer_at: '2026-11-19T07:02:00.000Z', p_note: 'checked in the app' });
    await review.confirm({ evidenceId: 'e1', amount: 350, bankRef: 'REF12345', transferAt: '2026-11-19T07:02:00.000Z' });
    expect(m.rpc).toHaveBeenLastCalledWith('finance_confirm_evidence', expect.objectContaining({ p_note: null }));
  });
  it('post: finance_post_evidence(p_evidence, p_note), the answer says whether it was a replay', async () => {
    ok({ replay: true, result: 'fully_paid', receipt_no: 'RC-1' });
    await expect(review.post('e1', 'end of day')).resolves.toMatchObject({ replay: true, receipt_no: 'RC-1' });
    expect(m.rpc).toHaveBeenLastCalledWith('finance_post_evidence', { p_evidence: 'e1', p_note: 'end of day' });
    await review.post('e1');
    expect(m.rpc).toHaveBeenLastCalledWith('finance_post_evidence', { p_evidence: 'e1', p_note: null });
    await review.post('e1', '   ');
    expect(m.rpc).toHaveBeenLastCalledWith('finance_post_evidence', { p_evidence: 'e1', p_note: null });
  });
  it('reject, requestMore, requestAnalysis, settings, saveSettings', async () => {
    ok(null);
    await review.reject('e1', 'blurry');
    expect(m.rpc).toHaveBeenLastCalledWith('finance_reject_evidence', { p_evidence: 'e1', p_reason: 'blurry' });
    await review.requestMore('e1', 'please send a clearer slip');
    expect(m.rpc).toHaveBeenLastCalledWith('finance_request_more_evidence', { p_evidence: 'e1', p_message: 'please send a clearer slip' });
    ok('a1');
    await expect(review.requestAnalysis('e1')).resolves.toBe('a1');
    expect(m.rpc).toHaveBeenLastCalledWith('finance_request_analysis', { p_evidence: 'e1' });
    ok({ ai_review_enabled: false, post_requires_manager: false, ai_min_confidence: 0.8, slip_window_before_min: 120, slip_future_tolerance_min: 10 });
    await expect(review.settings()).resolves.toMatchObject({ ai_min_confidence: 0.8 });
    expect(m.rpc).toHaveBeenLastCalledWith('finance_review_settings');
    await review.saveSettings({ post_requires_manager: true });
    expect(m.rpc).toHaveBeenLastCalledWith('finance_save_review_settings', { p_patch: { post_requires_manager: true } });
  });
  it('a database error becomes an Error that names the action and keeps the database code', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_CONFIRMED: this slip is submitted (it must be confirmed before it is posted)' } });
    await expect(review.post('e1')).rejects.toThrow(/^Post payment: NOT_CONFIRMED: this slip is submitted/);
    await expect(review.list({})).rejects.toThrow(/^Load slip review: /);
    await expect(review.detail('e1')).rejects.toThrow(/^Load payment: /);
  });

  it('recordPayment (cash): no file, no reference, no bank account', async () => {
    ok({ evidence_id: 'n1', status: 'confirmed' });
    await expect(review.recordPayment({ invoiceId: 'i1', method: 'cash', amount: 120, receivedAt: '2026-11-19T05:00:00.000Z', note: 'paid at the counter' })).resolves.toEqual({ evidence_id: 'n1', status: 'confirmed' });
    expect(m.rpc).toHaveBeenLastCalledWith('finance_record_payment', {
      p_invoice: 'i1', p_method: 'cash', p_amount: 120, p_received_at: '2026-11-19T05:00:00.000Z', p_bank_trans_ref: null, p_bank_account: null, p_note: 'paid at the counter',
      p_file_path: null, p_sha256: null, p_file_type: null,
    });
    expect(m.upload).not.toHaveBeenCalled();
  });
  it('recordPayment (cash) with a file is refused before anything is uploaded', async () => {
    const f = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], 's.jpg', { type: 'image/jpeg' });
    await expect(review.recordPayment({ invoiceId: 'i1', method: 'cash', amount: 120, receivedAt: '2026-11-19T05:00:00.000Z', note: 'x', file: f })).rejects.toThrow(/cash/i);
    expect(m.upload).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it('recordPayment (transfer) with a slip: uploads into the caller\'s own folder, then records it with the path, hash and real type', async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: 'u-1' } } });
    m.upload.mockResolvedValue({ error: null });
    ok({ evidence_id: 'n2', status: 'confirmed' });
    const f = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], 'whatever.png', { type: 'image/png' });   // the name and declared type lie: the bytes say JPEG
    await review.recordPayment({ invoiceId: 'i1', method: 'transfer', amount: 350, receivedAt: '2026-11-19T05:00:00.000Z', bankRef: 'REF-9999', bankAccountId: 'b1', note: 'from the bank app', file: f });
    const [path, , opts] = m.upload.mock.calls[0];
    expect(path).toMatch(/^u-1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(opts).toMatchObject({ contentType: 'image/jpeg', upsert: false });
    const p = m.rpc.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(m.rpc.mock.calls.at(-1)![0]).toBe('finance_record_payment');
    expect(p).toMatchObject({ p_invoice: 'i1', p_method: 'transfer', p_amount: 350, p_bank_trans_ref: 'REF-9999', p_bank_account: 'b1', p_file_path: path, p_file_type: 'image/jpeg' });
    expect(String(p.p_sha256)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('recordPayment removes the uploaded file when the database refuses the payment', async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: 'u-1' } } });
    m.upload.mockResolvedValue({ error: null });
    m.rpc.mockResolvedValue({ data: null, error: { message: 'EXCEEDS_OUTSTANDING: 500 is more than the 100 that can still be added to this invoice' } });
    const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 's.png', { type: 'image/png' });
    await expect(review.recordPayment({ invoiceId: 'i1', method: 'transfer', amount: 500, receivedAt: '2026-11-19T05:00:00.000Z', bankRef: 'REF-9999', file: f })).rejects.toThrow(/EXCEEDS_OUTSTANDING/);
    expect(m.remove).toHaveBeenCalledWith([m.upload.mock.calls[0][0]]);
  });
  it('recordPayment refuses a file that is not a JPG, PNG or PDF before uploading', async () => {
    const f = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 's.jpg', { type: 'image/jpeg' });
    await expect(review.recordPayment({ invoiceId: 'i1', method: 'transfer', amount: 5, receivedAt: '2026-11-19T05:00:00.000Z', bankRef: 'REF-9999', file: f })).rejects.toThrow(/JPG, PNG or PDF/);
    expect(m.upload).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
});
