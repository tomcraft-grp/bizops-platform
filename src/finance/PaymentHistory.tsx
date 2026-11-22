// One customer's payment history across invoices (finance_customer_payment_log, migration 20261122120000): every payment, receipt, reversal and wallet top-up with
// who did it, when, the method, the amount and a status of pending / completed / failed / cancelled / reversed. Read only. The drawer is keyed by the customer, and an
// answer that arrives for another customer (the drawer was reopened) is dropped, so one customer's history is never shown under another's name.
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { dateTimeFmt, money } from '../lib/util';
import { Badge, Banner, Drawer, Empty, Skeleton } from '../ui/kit';

export interface PaymentLogItem {
  at: string | null; kind: 'payment' | 'receipt' | 'reversal' | 'wallet_deposit'; txn_id: string; reference: string | null; invoice_no: string | null; amount: number;
  method: string | null; source: string | null; status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'reversed'; detail_status: string; actor_name: string | null; remark: string | null; completed_at: string | null;
}
export interface PaymentLog { customer: { id: string; code: string; name: string }; total: number; items: PaymentLogItem[]; events: { at: string; action: string; entity: string; by: string | null }[] }

export async function customerPaymentLog(customerId: string, limit = 200): Promise<PaymentLog> {
  const r = await supabase.rpc('finance_customer_payment_log', { p_customer: customerId, p_limit: limit, p_offset: 0 });
  if (r.error) {
    if (/could not find the function|schema cache/i.test(r.error.message)) throw new Error('The payment history is not installed in the database yet.');
    throw new Error(r.error.message);
  }
  return r.data as PaymentLog;
}

const TONE: Record<PaymentLogItem['status'], 'good' | 'warn' | 'bad' | 'info' | ''> = { completed: 'good', pending: 'warn', failed: 'bad', cancelled: '', reversed: 'bad' };
const KIND: Record<PaymentLogItem['kind'], string> = { payment: 'Payment', receipt: 'Receipt', reversal: 'Reversal', wallet_deposit: 'Wallet top-up' };
const METHOD: Record<string, string> = { cash: 'Cash', transfer: 'Bank transfer / QR', promptpay_transfer: 'Bank transfer / QR', wallet: 'Wallet' };

export function CustomerPaymentHistory({ customerId, customerName, onClose }: { customerId: string; customerName: string; onClose: () => void }) {
  const lang = useLang();
  const T = (s: string, v?: Record<string, string | number>) => tl(lang, s, v);
  const [log, setLog] = useState<PaymentLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const want = useRef(customerId);
  useEffect(() => {
    want.current = customerId; setLog(null); setError(null);
    customerPaymentLog(customerId).then((l) => { if (want.current === customerId && l.customer.id === customerId) setLog(l); }).catch((e) => { if (want.current === customerId) setError((e as Error).message); });
  }, [customerId]);
  return (
    <Drawer title={T('Payment history')} sub={log ? `${log.customer.name} · ${log.customer.code}` : customerName} onClose={onClose}>
      <div className="col gap-12" data-testid="payment-history" data-customer={customerId}>
        {error && <Banner tone="bad">{T(error)}</Banner>}
        {!log && !error && <Skeleton h={160} />}
        {log && !log.items.length && <Empty title={T('No payments yet')} />}
        {log && log.items.length > 0 && (
          <div className="table-wrap"><table className="t compact">
            <thead><tr><th>{T('Date')}</th><th>{T('Type')}</th><th>{T('Invoice')}</th><th>{T('Method')}</th><th className="r">{T('Amount')}</th><th>{T('Status')}</th><th>{T('By')}</th></tr></thead>
            <tbody>{log.items.map((x) => (
              <tr key={x.kind + x.txn_id + (x.at ?? '')}>
                <td>{x.at ? dateTimeFmt(x.at) : '—'}</td>
                <td>{T(KIND[x.kind] ?? x.kind)}{x.reference && <div className="sub muted mono">{x.reference}</div>}{x.remark && <div className="sub muted">{x.remark}</div>}</td>
                <td className="mono">{x.invoice_no ?? '—'}</td>
                <td>{T(METHOD[x.method ?? ''] ?? x.method ?? '—')}</td>
                <td className="r">{money(x.amount)}</td>
                <td><Badge tone={TONE[x.status]} dot>{T(x.status[0].toUpperCase() + x.status.slice(1))}</Badge></td>
                <td>{x.actor_name ?? '—'}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        {log && log.total > log.items.length && <div className="muted">{T('Showing {n} of {total}.', { n: log.items.length, total: log.total })}</div>}
      </div>
    </Drawer>
  );
}
