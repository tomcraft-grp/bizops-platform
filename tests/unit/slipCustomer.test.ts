// The customer side of the slip review, as code (no browser): the customer's reads of their own payment events ask for an explicit list of columns that leaves the
// staff-only ones out, and customer code can reach the AI reader only through `review.analyze` (which never returns what the AI found). The supabase client is a FAKE.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const m = vi.hoisted(() => ({ select: vi.fn(), from: vi.fn(), answers: [] as { data: unknown; error: unknown }[] }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: m.from, functions: { invoke: vi.fn() } } }));

import { CUSTOMER_EVIDENCE_COLUMNS, CUSTOMER_EVIDENCE_COLUMNS_BASE, finance } from '../../src/finance/api';

/** What a customer may read of their own payment event (the brief of the slip review, Task 8). */
const ALLOWED = ['id', 'invoice_id', 'status', 'created_at', 'claimed_amount', 'claimed_transfer_at', 'claimed_bank', 'claimed_ref', 'file_type', 'reject_reason', 'request_message', 'verified_amount', 'transfer_at', 'bank_trans_ref', 'reviewed_at', 'source', 'method'];
/** Columns only staff may see: who decided, the shop's own notes, what staff confirmed, the file itself. */
const STAFF_ONLY = ['review_note', 'confirm_note', 'reviewed_by', 'confirmed_by', 'recorded_by', 'requested_by', 'posted_by', 'verified_via', 'confirmed_amount', 'confirmed_bank_ref', 'confirmed_transfer_at', 'file_path', 'file_sha256'];

const OK = { data: [{ id: 'e1' }], error: null };
const unknownColumn = (code: string) => ({ data: null, error: { code, message: 'column finance_payment_evidence.request_message does not exist' } });
/** The columns of the base list: the 17 without the three the slip-review migration added. */
const BASE = ALLOWED.filter((c) => !['request_message', 'source', 'method'].includes(c));
const colsOf = (call: number) => String(m.select.mock.calls[call][0]).split(',').map((c) => c.trim());
beforeEach(() => {
  m.select.mockReset(); m.from.mockReset(); m.answers = [OK];
  // each read gets the next prepared answer (the last one repeats)
  m.from.mockImplementation(() => ({ select: (cols: string) => { m.select(cols); const a = m.answers.length > 1 ? m.answers.shift()! : m.answers[0]; return { eq: () => ({ order: () => Promise.resolve(a) }) }; } }));
});

describe('finance.myEvidence', () => {
  it('asks for an explicit column list (never *) that has no staff-only column', async () => {
    const rows = await finance.myEvidence('inv-1');
    expect(rows).toEqual([{ id: 'e1' }]);
    expect(m.from).toHaveBeenCalledWith('finance_payment_evidence');
    expect(m.select).toHaveBeenCalledTimes(1);
    const cols = String(m.select.mock.calls[0][0]).split(',').map((c) => c.trim());
    expect(cols).not.toContain('*');
    expect([...cols].sort()).toEqual([...ALLOWED].sort());
    for (const c of STAFF_ONLY) expect(cols, c).not.toContain(c);
  });
  it('the exported list is the one that is sent', () => {
    expect(CUSTOMER_EVIDENCE_COLUMNS.split(',').map((c) => c.trim()).sort()).toEqual([...ALLOWED].sort());
  });
});

describe('finance.myEvidence on a database without the slip-review migration', () => {
  it('the base list is the 14 columns the old table has: no request_message / source / method, no staff-only column, never *', () => {
    const cols = CUSTOMER_EVIDENCE_COLUMNS_BASE.split(',').map((c) => c.trim());
    expect(cols).toHaveLength(14);
    expect([...cols].sort()).toEqual([...BASE].sort());
    expect(cols).not.toContain('*');
    for (const c of [...STAFF_ONLY, 'request_message', 'source', 'method']) expect(cols, c).not.toContain(c);
  });
  for (const code of ['42703', 'PGRST204']) {
    it(`an unknown-column error (${code}) is answered by ONE retry with the base list, and the rows come back`, async () => {
      m.answers = [unknownColumn(code), OK];
      expect(await finance.myEvidence('inv-1')).toEqual([{ id: 'e1' }]);
      expect(m.select).toHaveBeenCalledTimes(2);
      expect([...colsOf(0)].sort()).toEqual([...ALLOWED].sort());          // first the full explicit list
      expect([...colsOf(1)].sort()).toEqual([...BASE].sort());             // then the base list
      for (const i of [0, 1]) expect(colsOf(i)).not.toContain('*');
    });
  }
  it('it retries only once: a second failure is thrown', async () => {
    m.answers = [unknownColumn('42703'), unknownColumn('42703')];
    await expect(finance.myEvidence('inv-1')).rejects.toThrow(/Load slips: column/);
    expect(m.select).toHaveBeenCalledTimes(2);
  });
  it('any other error is thrown at once, without a retry (a timeout, a permission error, a lost network)', async () => {
    for (const error of [{ code: '57014', message: 'canceling statement due to statement timeout' }, { code: '42501', message: 'permission denied' }, { message: 'Failed to fetch' }]) {
      m.select.mockClear(); m.answers = [{ data: null, error }];
      await expect(finance.myEvidence('inv-1')).rejects.toThrow(/Load slips:/);
      expect(m.select).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the pay status pill wraps, nothing else does', () => {
  const root = path.resolve(__dirname, '../..');
  const css = fs.readFileSync(path.join(root, 'src/shop/shop.css'), 'utf8');
  const rule = (selector: string) => css.split(/\r?\n/).find((l) => l.startsWith(`${selector} {`)) ?? '';
  it('.sp-pill keeps white-space: nowrap (order and deposit pills); only .sp-pill.sp-pay wraps', () => {
    expect(rule('.sp-pill')).toContain('white-space: nowrap');
    expect(rule('.sp-pill.sp-pay')).toContain('white-space: normal');
  });
  it('PayBadge puts sp-pay on its pill; the order and deposit pills do not have it', () => {
    const ui = fs.readFileSync(path.join(root, 'src/shop/ui.tsx'), 'utf8');
    expect(ui).toContain("cx('sp-pill', 'sp-pay', p.tone)");
    expect(ui).toContain("cx('sp-pill', ORDER_TONE[status])");
    expect(fs.readFileSync(path.join(root, 'src/wallet/Wallet.tsx'), 'utf8')).not.toContain('sp-pay');
  });
});

describe('customer code never reads or shows what the AI found', () => {
  const root = path.resolve(__dirname, '../..');
  const files = [
    ...fs.readdirSync(path.join(root, 'src/shop')).filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'ShopAdmin.tsx').map((f) => `src/shop/${f}`),   // ShopAdmin is the staff page
    'src/finance/CustomerInvoices.tsx',
  ];
  it('the files of the customer shop are found', () => { expect(files.length).toBeGreaterThan(8); expect(files).toContain('src/shop/CartPage.tsx'); });
  for (const f of files) {
    it(`${f}: only review.analyze is used, and none of the staff labels, reasons or analysis fields`, () => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src, 'review.* other than analyze').not.toMatch(/\breview\.(?!analyze\b)\w+/);
      expect(src).not.toMatch(/\b(AI_RESULT|REASON_TEXT|REASON_CODES|REVIEW_[A-Z_]+|ReviewDetail|ReviewItem|SlipAnalysis)\b/);
      expect(src).not.toMatch(/finance_slip_analysis|finance_review_|finance_request_analysis|ai_result|ai_confidence|ai_amount|overall_confidence/);
    });
  }
});
