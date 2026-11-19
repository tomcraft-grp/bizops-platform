// The customer side of the slip review, as code (no browser): the customer's reads of their own payment events ask for an explicit list of columns that leaves the
// staff-only ones out, and customer code can reach the AI reader only through `review.analyze` (which never returns what the AI found). The supabase client is a FAKE.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const m = vi.hoisted(() => ({ select: vi.fn(), from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: m.from, functions: { invoke: vi.fn() } } }));

import { CUSTOMER_EVIDENCE_COLUMNS, finance } from '../../src/finance/api';

/** What a customer may read of their own payment event (the brief of the slip review, Task 8). */
const ALLOWED = ['id', 'invoice_id', 'status', 'created_at', 'claimed_amount', 'claimed_transfer_at', 'claimed_bank', 'claimed_ref', 'file_type', 'reject_reason', 'request_message', 'verified_amount', 'transfer_at', 'bank_trans_ref', 'reviewed_at', 'source', 'method'];
/** Columns only staff may see: who decided, the shop's own notes, what staff confirmed, the file itself. */
const STAFF_ONLY = ['review_note', 'confirm_note', 'reviewed_by', 'confirmed_by', 'recorded_by', 'requested_by', 'posted_by', 'verified_via', 'confirmed_amount', 'confirmed_bank_ref', 'confirmed_transfer_at', 'file_path', 'file_sha256'];

beforeEach(() => {
  m.select.mockReset(); m.from.mockReset();
  m.from.mockImplementation(() => ({ select: (cols: string) => { m.select(cols); return { eq: () => ({ order: () => Promise.resolve({ data: [{ id: 'e1' }], error: null }) }) }; } }));
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
