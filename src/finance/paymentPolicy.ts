// A customer's payment policy (supabase/migrations/20261127100000_customer_payment_policy.sql): 'partial' = the invoice may be paid in instalments (today's behaviour, the default),
// 'full' = the whole outstanding amount in ONE payment. The database enforces it (finance_submit_evidence, finance_pay_invoice_with_wallet); this module only lets the screens
// show the rule and lock the amount, so a customer is not sent to an error. A database without the migration has no policy function: everybody is 'partial'.
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { rpc } from '../shop/api';

export type PaymentPolicy = 'partial' | 'full';
export const POLICIES: PaymentPolicy[] = ['partial', 'full'];
export const normalizePolicy = (v: unknown): PaymentPolicy => (v === 'full' ? 'full' : 'partial');

let cache: { at: number; uid: string | null; v: PaymentPolicy } | null = null;
export const clearPolicyCache = () => { cache = null; };

/** The signed-in customer's own policy. Never throws: no function / no answer reads as 'partial' (the database still decides when money moves). */
export async function fetchMyPaymentPolicy(): Promise<PaymentPolicy> {
  try { return normalizePolicy(await rpc<string>('finance_my_payment_policy')); } catch { return 'partial'; }
}

/** The policy for the screens; `null` until it is known (screens treat that as partial and lock the amount a moment later when it turns out to be full). */
export function useMyPaymentPolicy(): PaymentPolicy | null {
  const uid = useAuth().profile?.id ?? null;
  const fresh = () => !!cache && cache.uid === uid && Date.now() - cache.at < 30_000;
  const [policy, setPolicy] = useState<PaymentPolicy | null>(fresh() ? cache!.v : null);
  useEffect(() => {
    let on = true;
    if (fresh()) { setPolicy(cache!.v); return undefined; }
    void fetchMyPaymentPolicy().then((v) => { cache = { at: Date.now(), uid, v }; if (on) setPolicy(v); });
    return () => { on = false; };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  return policy;
}

export interface PolicyView {
  /** the amount field is read-only and equals the outstanding amount */
  locked: boolean;
  /** the amount the customer can pay in one go */
  amount: number;
  /** a payment for this invoice is already waiting: no second one (full policy) */
  waiting: boolean;
}
/** What a full-payment customer may do with one invoice: pay exactly `outstanding`, once; while a slip waits (status 3) nothing more. */
export function policyView(policy: PaymentPolicy | null, inv: { outstanding: number; status_code: number }): PolicyView {
  const full = policy === 'full';
  return { locked: full, amount: inv.outstanding, waiting: full && inv.status_code === 3 };
}
/** Can the wallet pay it under the policy? Full: the balance must cover the whole outstanding amount. Partial: any positive balance. */
export function walletCanPay(policy: PaymentPolicy | null, balance: number, outstanding: number): boolean {
  return policy === 'full' ? balance + 1e-9 >= outstanding && outstanding > 0 : balance > 0 && outstanding > 0;
}
