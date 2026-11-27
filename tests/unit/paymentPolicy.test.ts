// The customer payment policy on the screens' side (src/finance/paymentPolicy.ts). The database rules (full = no less than the whole outstanding amount, no second slip in flight,
// wallet pays exactly the outstanding amount, staff are not blocked but noted) are proven against the real database by supabase/tests/payment_policy.sql.
import { describe, expect, it } from 'vitest';
import { normalizePolicy, policyView, walletCanPay } from '../../src/finance/paymentPolicy';
import { TH } from '../../src/lib/i18n';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';
import { thaiForError } from '../../src/lib/errorText';

describe('normalizePolicy: never ambiguous', () => {
  it('only "full" means full; anything else (null, unknown, an old database) is partial', () => {
    expect(normalizePolicy('full')).toBe('full');
    for (const v of ['partial', null, undefined, '', 'FULL', 'monthly', 1, {}]) expect(normalizePolicy(v)).toBe('partial');
  });
});

describe('policyView', () => {
  it('full: the amount is locked to the outstanding amount', () => {
    expect(policyView('full', { outstanding: 640, status_code: 0 })).toEqual({ locked: true, amount: 640, waiting: false });
    expect(policyView('full', { outstanding: 640, status_code: 4 })).toEqual({ locked: true, amount: 640, waiting: false });   // partly paid by staff: the rest, in one go
  });
  it('full: while a slip waits for the shop (status 3) nothing more can be paid', () => {
    expect(policyView('full', { outstanding: 640, status_code: 3 }).waiting).toBe(true);
  });
  it('partial and not-yet-known policies are not locked and never "waiting"', () => {
    for (const p of ['partial', null] as const) expect(policyView(p, { outstanding: 640, status_code: 3 })).toEqual({ locked: false, amount: 640, waiting: false });
  });
});

describe('walletCanPay', () => {
  it('full: the balance must cover the whole outstanding amount', () => {
    expect(walletCanPay('full', 639.99, 640)).toBe(false);
    expect(walletCanPay('full', 640, 640)).toBe(true);
    expect(walletCanPay('full', 1000, 640)).toBe(true);
    expect(walletCanPay('full', 1000, 0)).toBe(false);
  });
  it('partial: any positive balance can pay part', () => {
    expect(walletCanPay('partial', 10, 640)).toBe(true);
    expect(walletCanPay('partial', 0, 640)).toBe(false);
    expect(walletCanPay(null, 10, 640)).toBe(true);
  });
});

describe('words', () => {
  it('the customer texts exist in both languages and say the amount', () => {
    for (const k of ['pol.full', 'pol.locked', 'pol.waiting', 'wp.full', 'we.FULL_PAYMENT_REQUIRED', 'we.PAYMENT_ALREADY_PENDING', 'dep.qrTitle', 'dep.qrOr'] as const) {
      expect(SHOP_KEYS).toContain(k);
      expect(tr('th', k, { amount: 'THB 1' })).toMatch(/[ก-๿]/);
      expect(tr('en', k, { amount: 'THB 1' })).not.toMatch(/[ก-๿]/);
    }
    expect(tr('th', 'pol.full', { amount: 'THB 640' })).toContain('THB 640');
  });
  it('the staff screens are translated', () => {
    for (const k of ['Partial payments allowed', 'Full payment required', 'Payment policy', 'PromptPay QR for wallet top-ups', 'Not linked (no QR option for top-ups)']) expect(TH[k], k).toMatch(/[ก-๿]/);
  });
  it('the database refusals read in Thai', () => {
    expect(thaiForError('FULL_PAYMENT_REQUIRED: this account must pay the whole outstanding amount (1000.00) in one payment')).toMatch(/เต็มจำนวน/);
    expect(thaiForError('PAYMENT_ALREADY_PENDING: a payment for this invoice is already waiting to be checked')).toBe('มีการชำระเงินของใบแจ้งหนี้นี้รอร้านตรวจสอบอยู่แล้ว จึงยังชำระซ้ำไม่ได้');
    expect(thaiForError('QR_NOT_LINKED: the shop has not linked its QR to a bank account yet')).toMatch(/QR/);
  });
});
