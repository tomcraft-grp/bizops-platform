import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TH } from '../../src/lib/i18n';
import { attemptKey, forgetAttempt } from '../../src/shop/cart';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';
import { ShopError } from '../../src/shop/api';
import { bankBrand, copyableAccountNo, formatAccountNo } from '../../src/wallet/bank';
import { walletCode } from '../../src/wallet/api';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

describe('bank account display', () => {
  it('the two configured accounts are formatted for reading and copied as digits only', () => {
    expect(formatAccountNo('5194026251')).toBe('519-4-02625-1');
    expect(formatAccountNo('9380319542')).toBe('938-0-31954-2');
    expect(copyableAccountNo('519-4-02625-1')).toBe('5194026251');
    expect(copyableAccountNo('938 0 31954 2')).toBe('9380319542');
    expect(copyableAccountNo(formatAccountNo('5194026251'))).toBe('5194026251');            // what is shown and what is copied are the same number
  });
  it('other lengths are grouped without losing a digit', () => {
    expect(copyableAccountNo(formatAccountNo('123456789012'))).toBe('123456789012');
    expect(formatAccountNo('123456789012')).toBe('1234-5678-9012');
  });
  it('a bank without a logo gets a readable badge, an unknown code gets a neutral one', () => {
    expect(bankBrand('scb').bg).toMatch(/^#/); expect(bankBrand('BBL').fg).toBe('#ffffff'); expect(bankBrand('ZZZ').bg).toMatch(/^#/);
  });
});

describe('bank accounts are configuration, not code', () => {
  it('the app never hardcodes an account number or holder (the database owns them)', () => {
    for (const f of ['src/wallet/ui.tsx', 'src/wallet/Wallet.tsx', 'src/wallet/PayInvoice.tsx', 'src/wallet/PaymentsAdmin.tsx', 'src/wallet/bank.ts', 'src/finance/CustomerInvoices.tsx', 'src/shop/i18n.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/5194026251|9380319542|519-4-02625-1|938-0-31954-2/);
      expect(src, f).not.toMatch(/ณัฐพล อยู่ยิ้ม|ณัฐพร อยู่ยิ้ม/);
    }
  });
  it('the migration seeds exactly the two accounts requested, once', () => {
    const sql = read('supabase/migrations/20261115200000_wallet_payments.sql');
    expect(sql).toMatch(/'SCB'[^;]*'Siam Commercial Bank'[^;]*'ธนาคารไทยพาณิชย์'[^;]*'5194026251'[^;]*'ณัฐพล อยู่ยิ้ม'/s);
    expect(sql).toMatch(/'BBL'[^;]*'Bangkok Bank'[^;]*'ธนาคารกรุงเทพ'[^;]*'9380319542'[^;]*'ณัฐพร อยู่ยิ้ม'/s);
    expect(sql.match(/5194026251/g)).toHaveLength(1); expect(sql.match(/9380319542/g)).toHaveLength(1);
    expect(sql).toMatch(/on conflict[^;]*do nothing/i);                                    // re-running never duplicates or overwrites staff edits
  });
});

describe('request keys of the wallet flows', () => {
  it('deposit, wallet payment and checkout keep separate keys for the same customer', () => {
    const s = mem(); let n = 0; const gen = () => `key-${++n}-aaaaaaaa`;
    const shop = attemptKey(s, 'u1', 'x', gen), dep = attemptKey(s, 'u1', 'x', gen, 'wallet'), pay = attemptKey(s, 'u1', 'x', gen, 'walletpay');
    expect(new Set([shop, dep, pay]).size).toBe(3);
    expect(attemptKey(s, 'u1', 'x', gen, 'wallet')).toBe(dep);                              // a retry of the same deposit reuses its key
    expect(attemptKey(s, 'u1', 'y', gen, 'wallet')).not.toBe(dep);                          // a different amount is a different request
    forgetAttempt(s, 'u1', 'walletpay'); expect(attemptKey(s, 'u1', 'x', gen, 'wallet')).not.toBe(pay); expect(attemptKey(s, 'u2', 'x', gen, 'wallet')).not.toBe(dep);
  });
});

describe('wallet error messages', () => {
  const CUSTOMER_CODES = ['INSUFFICIENT_FUNDS', 'AMOUNT_OUT_OF_RANGE', 'BANK_NOT_AVAILABLE', 'TOO_MANY_OPEN_DEPOSITS', 'DEPOSIT_NOT_PENDING', 'DEPOSIT_NOT_CANCELLABLE', 'SLIP_ALREADY_USED', 'AMOUNT_EXCEEDS_OUTSTANDING', 'NOTHING_OUTSTANDING', 'INVOICE_NOT_OPEN', 'PAYMENT_UNDER_REVIEW', 'KEY_REUSED'];
  it('every refusal a customer can meet has a Thai and an English sentence', () => {
    for (const c of CUSTOMER_CODES) for (const l of ['th', 'en'] as const) expect(tr(l, `we.${c}` as never), `${c} ${l}`).not.toBe(`we.${c}`);
  });
  it('and every one of them is really raised by the database (no stale or invented codes)', () => {
    const sql = read('supabase/migrations/20261115200000_wallet_payments.sql') + read('supabase/migrations/20261115100000_customer_shop.sql');
    for (const c of CUSTOMER_CODES) expect(sql, c).toContain(c);
  });
  it('the code is read from the database message, "CODE: text" or "CODE"', () => {
    expect(walletCode(new ShopError('INSUFFICIENT_FUNDS: balance 10', 'INSUFFICIENT_FUNDS'))).toBe('INSUFFICIENT_FUNDS');
    expect(walletCode(new Error('Failed to fetch'))).toBe('NETWORK'); expect(walletCode(new Error('weird'))).toBe('ERROR'); expect(walletCode('x')).toBe('ERROR');
  });
  it('wallet texts are part of the customer text table (Thai and English, same placeholders)', () => {
    for (const k of ['w.title', 'w.balance', 'dep.title', 'pm.wallet', 'bank.copy', 'bank.copied', 'wp.pay', 'we.INSUFFICIENT_FUNDS']) expect(SHOP_KEYS, k).toContain(k);
  });
});

describe('back-office text', () => {
  it('every sentence of the Payments & wallet page has Thai, with the same placeholders', () => {
    const src = read('src/wallet/PaymentsAdmin.tsx');
    const found = new Set<string>();
    for (const m of src.matchAll(/\bT\(\s*'((?:[^'\\\n]|\\.)*)'/g)) found.add(m[1].replace(/\\'/g, "'"));
    for (const m of src.matchAll(/\b(?:STATUS_LABEL|KIND_LABEL|TYPE_LABEL)\b[^=]*=\s*\{([^}]*)\}/g)) for (const v of m[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) found.add(v[1]);
    expect(found.size).toBeGreaterThan(80);
    const missing = [...found].filter((k) => !(k in TH));
    expect(missing).toEqual([]);
    for (const k of found) expect([...(TH[k].match(/\{\w+\}/g) ?? [])].sort(), k).toEqual([...(k.match(/\{\w+\}/g) ?? [])].sort());
  });
  it('the posting messages shown to the accountant have Thai too', () => {
    const src = read('src/domain/financeLedger.ts');
    for (const m of src.matchAll(/(?:errors\.push|fail\([^,]+,)\s*\(?\s*'((?:[^'\\]|\\.)*)'/g)) expect(m[1] in TH, m[1]).toBe(true);
    for (const m of src.matchAll(/^\s+[A-Z_]+:\s*'((?:[^'\\]|\\.)*)'/gm)) if (/^[A-Z][a-z]/.test(m[1])) expect(m[1] in TH, m[1]).toBe(true);
  });
});

describe('online ordering text and contract', () => {
  it('the checkout payment texts exist in Thai and English', () => {
    for (const l of ['th', 'en'] as const) for (const k of ['co.paymentHint', 'co.paymentLater', 'co.confirmBody']) expect(tr(l, k as never), k).not.toBe(k);
    expect(tr('th', 'co.paymentLater' as never)).toMatch(/[฀-๿]/);
  });
  it('the staff strings added for the payment choice and overpayments have Thai', () => {
    for (const k of ['Customer plans to pay by', 'Wallet', "If this is more than the invoice owes, the extra is credited to the customer's wallet.", "Recorded: invoice fully paid. {n} above the invoice was credited to the customer's wallet"]) expect(k in TH, k).toBe(true);
  });
  it('the migration keeps the promises the screens make (receivable follows confirmation, overpayment to the wallet, refunded, optional payment choice)', () => {
    const sql = read('supabase/migrations/20261115300000_online_ordering.sql');
    expect(sql).toContain("set_config('finance.defer_gl', 'on', true)");                   // an order is not an accounting event
    expect(sql).toContain('finance_gl_ensure_invoice_issue(o.invoice_id)');                // ... until staff confirm it
    expect(sql).toContain("'overpaid_credited'");                                           // the excess goes to the wallet
    expect(sql).toContain("'refunded', refunded");                                          // the customer sees a refunded status
    expect(sql).toMatch(/p_expected_total numeric default null, p_payment_method text default null/);   // optional last parameter: older builds keep working
    expect(sql).not.toMatch(/p_price|p_unit_price|p_total/);                              // the app can never send a price
  });
  it('the app sends the payment choice only when there is one, and never a price or a balance', () => {
    const src = read('src/shop/api.ts');
    expect(src).toContain("...(i.paymentMethod ? { p_payment_method: i.paymentMethod } : {})");
    const place = src.slice(src.indexOf('async placeOrder'), src.indexOf('async placeOrder') + 700);
    expect(place).not.toMatch(/p_price|p_amount|p_balance|p_status/);
  });
});
