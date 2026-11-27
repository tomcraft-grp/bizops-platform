// Screens for central receivables (src/finance/centralAr.ts): link a local customer to a central customer, receive a payment against central invoices (one or
// several invoices, several payments in a row for a split: cash + transfer), and the "Central ledger" panel (orders waiting to be sent, one-time import).
// Every amount owed comes from the server; the form is keyed by the central customer, so changing the customer starts a fresh form and a fresh request key.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Link2, RefreshCw, Search, Send, UserPlus } from 'lucide-react';
import { toast, useDB, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { dateFmt, money, r2 } from '../lib/util';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Modal, NumInput, Select, Seg, Skeleton, Tx, useConfirm } from '../ui/kit';
import type { Customer, ID } from '../domain/types';
import { centralApi, describeCentralError, importOpenBalances, linkLocalCustomer, syncCentral, useCentralAr, type CentralCustomer, type CentralInvoice } from './centralAr';
import { centralCandidates } from '../domain/centralAr';

// ---------------------------------------------------------------------------------------------- link a local customer
export function LinkCustomerPanel({ local, onLinked }: { local: Customer; onLinked: (c: CentralCustomer) => void }) {
  const lang = useLang();
  const T = (s: string, v?: Record<string, string | number>) => tl(lang, s, v);
  const [q, setQ] = useState(local.phone || local.name);
  const [found, setFound] = useState<CentralCustomer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(local.name);
  const [phone, setPhone] = useState(local.phone ?? '');
  const seq = useRef(0);
  const search = async (text: string) => {
    const my = ++seq.current;
    if (text.trim().length < 2) { setFound([]); return; }
    setBusy(true); setError(null);
    try { const r = await centralApi.search(text.trim()); if (my === seq.current) setFound(r); }
    catch (e) { if (my === seq.current) setError(describeCentralError(e)); }
    finally { if (my === seq.current) setBusy(false); }
  };
  useEffect(() => { void search(q); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const link = async (customerId: string | null) => {
    setBusy(true); setError(null);
    try {
      const c = await linkLocalCustomer({ id: local.id, code: local.code, name: local.name }, customerId, customerId ? undefined : { name: name.trim(), phone: phone.trim() || undefined });
      toast('success', T('{name} is linked to the central customer {code}.', { name: local.name, code: c.code }));
      onLinked(c);
    } catch (e) { setError(describeCentralError(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="col gap-12" data-testid="link-customer">
      <Banner tone="info"><b>{local.name}</b>{' '}<Tx>is not linked to a central customer yet. Choose the same person from the central list (search by phone or name), or create them. The same person must never be created twice.</Tx></Banner>
      <div className="row gap-8">
        <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(q); }} placeholder={T('Phone or name')} aria-label={T('Phone or name')} />
        <Button onClick={() => void search(q)} disabled={busy}><Search size={14} />{' '}<Tx>Search</Tx></Button>
      </div>
      {error && <Banner tone="bad">{T(error)}</Banner>}
      {found === null ? <Skeleton h={60} /> : found.length ? (
        <table className="t compact"><thead><tr><th><Tx>Customer</Tx></th><th><Tx>Phone</Tx></th><th className="num"><Tx>Owes</Tx></th><th /></tr></thead>
          <tbody>{found.map((c) => (
            <tr key={c.id}><td><b>{c.name}</b><div className="sub mono">{c.code}{c.has_app ? ` · ${T('uses the app')}` : ''}</div></td><td className="mono">{c.phone ?? '–'}</td>
              <td className="num">{money(c.outstanding)}</td><td className="r"><Button size="sm" variant="primary" disabled={busy} onClick={() => void link(c.id)}><Link2 size={14} />{' '}<Tx>This is the customer</Tx></Button></td></tr>))}</tbody></table>
      ) : <div className="muted"><Tx>No central customer matches.</Tx></div>}
      {!creating ? <Button onClick={() => setCreating(true)}><UserPlus size={14} />{' '}<Tx>Not in the list: create a central customer</Tx></Button> : (
        <Card title={T('New central customer')}>
          <div className="form-grid">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="08xxxxxxxx" /></Field>
          </div>
          <div className="row gap-8 mt8"><Button variant="primary" disabled={busy || !name.trim()} onClick={() => void link(null)}><Tx>Create and link</Tx></Button><Button onClick={() => setCreating(false)}><Tx>Cancel</Tx></Button></div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- receive a payment
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function CentralReceiveModal({ localCustomerId, onClose }: { localCustomerId?: ID; onClose: () => void }) {
  const lang = useLang();
  const T = (s: string, v?: Record<string, string | number>) => tl(lang, s, v);
  const db = useDB();
  const device = useCentralAr((s) => s.device);
  const items = useCentralAr((s) => s.items);
  const [cid, setCid] = useState<ID>(localCustomerId ?? '');
  const local = db.customers.find((c) => c.id === cid);
  const [central, setCentral] = useState<CentralCustomer | null | undefined>(undefined);   // undefined = looking up, null = not linked
  const [invoices, setInvoices] = useState<CentralInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const want = useRef('');
  // the central customer of the chosen local customer; a changed customer drops everything that belonged to the previous one
  useEffect(() => {
    want.current = cid; setCentral(undefined); setInvoices(null); setError(null);
    if (!cid || !device) return;
    centralApi.linksFor(device, [cid]).then((m) => { if (want.current === cid) setCentral(m[cid] ?? null); }).catch((e) => { if (want.current === cid) setError(describeCentralError(e)); });
  }, [cid, device]);
  const reload = async (c: CentralCustomer) => {
    await syncCentral({ onlyCustomer: cid });                            // send this customer's waiting orders first, so their invoices are listed
    const r = await centralApi.openInvoices(c.id);
    if (want.current === cid) { setCentral(r.customer); setInvoices(r.invoices); }
  };
  useEffect(() => { if (central) reload(central).catch((e) => { if (want.current === cid) setError(describeCentralError(e)); }); }, [central?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = Object.values(items).filter((x) => db.orders.find((o) => o.id === x.orderId)?.customerId === cid);
  const since = useCentralAr((s) => s.since);
  // orders of this customer from before central receivables began on this device: still owed here, not sent automatically
  const older = useMemo(() => (cid ? centralCandidates(db, { customerId: cid }).filter((x) => !items[x.order.id] && (!since || x.order.createdAt < since)) : []), [db.orders, db.allocations, cid, items, since]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sending, setSending] = useState(false);
  const sendOlder = async () => {
    setSending(true);
    try { await importOpenBalances(cid); if (central) await reload(central); } catch (e) { setError(describeCentralError(e)); } finally { setSending(false); }
  };
  return (
    <Modal title={local ? `${T('Receive payment')} — ${local.name}` : T('Receive payment')} size="lg" onClose={onClose} footer={<Button onClick={onClose}><Tx>Close</Tx></Button>}>
      <div className="col gap-12" data-testid="central-receive">
        <Banner tone="info"><Tx>Payments are recorded in the central ledger: every device and the online shop see the same balance.</Tx></Banner>
        <Field label="Customer"><Select value={cid} onChange={(e) => setCid(e.target.value)} aria-label={T('Customer')}><option value="">{T('Select…')}</option>{db.customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}</Select></Field>
        {error && <Banner tone="bad">{T(error)}</Banner>}
        {cid && central === undefined && !error && <Skeleton h={80} />}
        {local && central === null && <LinkCustomerPanel key={local.id} local={local} onLinked={(c) => setCentral(c)} />}
        {waiting.some((w) => w.state === 'failed') && <Banner tone="warn"><Tx>Some orders of this customer could not be sent to the central ledger:</Tx>{' '}{waiting.filter((w) => w.state === 'failed').map((w) => `${db.orders.find((o) => o.id === w.orderId)?.no}: ${T(w.error ?? '')}`).join(' · ')}</Banner>}
        {central && older.length > 0 && <Banner tone="warn"><span data-testid="older-orders">{T('{n} older orders of this customer still owe {amount} on this device and are not in the central ledger yet.', { n: older.length, amount: money(r2(older.reduce((s, x) => s + x.owing, 0))) })}</span>{' '}<Button size="sm" variant="primary" disabled={sending} onClick={() => void sendOlder()}><Send size={14} />{' '}<Tx>Send them to the central ledger</Tx></Button></Banner>}
        {central && <CentralPaymentForm key={central.id} customer={central} invoices={invoices} onSaved={() => reload(central)} />}
      </div>
    </Modal>
  );
}

function CentralPaymentForm({ customer, invoices, onSaved }: { customer: CentralCustomer; invoices: CentralInvoice[] | null; onSaved: () => Promise<void> }) {
  const lang = useLang();
  const T = (s: string, v?: Record<string, string | number>) => tl(lang, s, v);
  const [method, setMethod] = useState<'cash' | 'transfer'>('transfer');
  const [amount, setAmountRaw] = useState(0);
  const [typed, setTyped] = useState(false);                // until staff type an amount, it follows what the invoices still owe
  const setAmount = (n: number) => { setTyped(true); setAmountRaw(n); };
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState(nowLocal());
  const [mode, setMode] = useState<'fifo' | 'manual'>('fifo');
  const [manual, setManual] = useState<Record<string, number>>({});
  const [post, setPost] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // oldest first, by issue date then number (the screen does not rely on the order the server sends)
  const open = useMemo(() => (invoices ?? []).filter((i) => i.available > 0.004).sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.invoice_no.localeCompare(b.invoice_no)), [invoices]);
  const available = r2(open.reduce((s, i) => s + i.available, 0));
  useEffect(() => { setAmountRaw((a) => (typed ? Math.min(a, available) : available)); }, [available]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => {
    let left = amount || 0;
    return open.map((i) => {
      const a = mode === 'fifo' ? r2(Math.min(left, i.available)) : r2(Math.min(manual[i.id] || 0, i.available));
      if (mode === 'fifo') left = r2(left - a);
      return { i, a };
    });
  }, [open, amount, mode, manual]);
  const allocated = r2(preview.reduce((s, x) => s + x.a, 0));
  const allocations = preview.filter((x) => x.a > 0).map((x) => ({ invoice: x.i.id, amount: x.a }));
  // one request key per filled-in form: a double click or a retry after a lost answer sends the same key (recorded once); any change makes a new payment
  const key = useMemo(() => crypto.randomUUID(), [customer.id, method, amount, ref, note, when, JSON.stringify(allocations)]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems: string[] = [];
  if (!(amount > 0)) problems.push('Enter the amount received.');
  if (amount > available + 0.004) problems.push('The amount is more than the open invoices still owe. Wallet credit for an excess is not given at the counter.');
  if (Math.abs(allocated - amount) > 0.004) problems.push('Allocate the whole amount to invoices.');
  if (method === 'transfer' && ref.replace(/[^A-Za-z0-9]/g, '').length < 4) problems.push('Enter the bank transaction reference (at least 4 letters or digits).');
  if (method === 'cash' && note.trim().length < 3) problems.push('Say where the cash was received (at least 3 characters).');
  const submit = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await centralApi.receive({ customerId: customer.id, method, amount: r2(amount), receivedAt: new Date(when).toISOString(), ref: method === 'transfer' ? ref.trim() : null,
        note: note.trim() || null, allocations, key, post });
      setDone(r.replay ? T('This payment was already recorded (nothing was added twice).') : r.posted.length ? T('Payment of {amount} recorded and posted.', { amount: money(amount) }) : T('Payment of {amount} recorded; it is posted at the end of the day.', { amount: money(amount) }));
      setRef(''); setNote(''); setManual({}); setTyped(false); setAmountRaw(0); setWhen(nowLocal());
      await onSaved();
    } catch (e) { setError(describeCentralError(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="col gap-12" data-testid="central-payment-form">
      <div className="row between wrap gap-8">
        <div><b>{customer.name}</b> <span className="muted mono">{customer.code}</span>{customer.phone && <span className="muted"> · {customer.phone}</span>}</div>
        <div className="row gap-8"><Badge tone={customer.outstanding > 0 ? 'warn' : 'good'}>{T('Owes')} {money(customer.outstanding)}</Badge>{customer.confirmed_pending > 0 && <Badge tone="info">{T('Waiting to post')} {money(customer.confirmed_pending)}</Badge>}</div>
      </div>
      {done && <Banner tone="good"><CheckCircle2 size={14} />{' '}{done}{' '}<Tx>For a split payment (for example cash and a transfer), record the next part now.</Tx></Banner>}
      {invoices === null ? <Skeleton h={120} /> : !open.length ? <Empty title="Nothing left to receive" hint="All invoices of this customer are paid or waiting to be posted." /> : (
        <>
          <div className="form-grid">
            <Field label="Method"><Seg value={method} onChange={setMethod} options={[{ v: 'transfer', label: 'Bank transfer / QR' }, { v: 'cash', label: 'Cash' }]} /></Field>
            <Field label="Amount received (฿)"><NumInput value={amount || ''} onChange={(n) => setAmount(isNaN(n) ? 0 : r2(n))} aria-label={T('Amount received (฿)')} /></Field>
            {method === 'transfer' ? <Field label="Bank transaction reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={T('From the slip')} aria-label={T('Bank transaction reference')} /></Field>
              : <Field label="Where was the cash received?"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={T('e.g. counter 1, by Nok')} aria-label={T('Where was the cash received?')} /></Field>}
            <Field label="Received at"><Input type="datetime-local" value={when} max={nowLocal()} onChange={(e) => setWhen(e.target.value)} aria-label={T('Received at')} /></Field>
            {method === 'transfer' && <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          </div>
          <div className="row between"><b><Tx>Allocate to invoices</Tx></b><Seg value={mode} onChange={setMode} options={[{ v: 'fifo', label: 'Oldest first' }, { v: 'manual', label: 'Manual' }]} /></div>
          <table className="t compact"><thead><tr><th><Tx>Invoice</Tx></th><th><Tx>From</Tx></th><th><Tx>Due</Tx></th><th className="num"><Tx>Can receive</Tx></th><th className="num"><Tx>Apply</Tx></th></tr></thead>
            <tbody>{preview.map(({ i, a }) => (
              <tr key={i.id}><td><b className="mono">{i.invoice_no}</b><div className="sub">{i.source_ref ?? i.description ?? ''}</div></td>
                <td><Badge>{T(i.origin === 'store' ? 'Store' : i.origin === 'shop' ? 'Online shop' : 'Manual')}</Badge></td><td>{dateFmt(i.due_date)}</td>
                <td className="num">{money(i.available)}{i.confirmed_pending > 0 && <div className="sub">{T('{amount} waiting to post', { amount: money(i.confirmed_pending) })}</div>}</td>
                <td className="num">{mode === 'fifo' ? <b>{a ? money(a) : '–'}</b> : <input className="input sm" style={{ width: 110, textAlign: 'right' }} type="number" min={0} max={i.available} aria-label={`${T('Apply')} ${i.invoice_no}`}
                  value={manual[i.id] ?? ''} onChange={(e) => setManual({ ...manual, [i.id]: Math.min(i.available, Math.max(0, Number(e.target.value))) })} />}</td></tr>))}</tbody>
            <tfoot><tr className="total"><td colSpan={3}><Tx>Total</Tx></td><td className="num">{money(available)}</td><td className="num">{money(allocated)}</td></tr></tfoot></table>
          <label className="row gap-6"><input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} />{' '}<Tx>Post now (otherwise it waits for the end-of-day post; cash is posted by a manager)</Tx></label>
          {problems.length > 0 && amount > 0 && <Banner tone="warn">{problems.map((p) => T(p)).join(' ')}</Banner>}
          {error && <Banner tone="bad">{T(error)}</Banner>}
          <div className="row end"><Button variant="primary" disabled={busy || problems.length > 0} onClick={() => void submit()} data-testid="central-receive-submit"><Tx>Record payment</Tx>{amount > 0 && ` (${money(amount)})`}</Button></div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- the central ledger panel on Receivables
export function CentralLedgerPanel({ onReceive }: { onReceive: (localCustomerId: ID) => void }) {
  const lang = useLang();
  const T = (s: string, v?: Record<string, string | number>) => tl(lang, s, v);
  const db = useDB();
  const confirm = useConfirm();
  const { status, items, syncing, lastSyncAt, error, since } = useCentralAr();
  const [linking, setLinking] = useState<ID | null>(null);
  const older = useMemo(() => centralCandidates(db).filter((x) => !since || x.order.createdAt < since).filter((x) => !items[x.order.id]), [db.orders, db.allocations, since, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = Object.values(items).map((it) => ({ it, o: db.orders.find((o) => o.id === it.orderId) })).filter((x) => x.o);
  const centralOrders = db.orders.filter((o) => o.central && !o.central.cancelled && o.central.outstanding > 0.004);
  if (status !== 'ready') return null;
  const doImport = async () => {
    const total = r2(older.reduce((s, x) => s + x.owing, 0));
    const r = await confirm({ title: T('Send open balances to the central ledger?'), body: T('{n} orders of this device still owe {amount}. Each becomes a central invoice for what it still owes (once; the order number is kept as the reference). Paid history stays on this device. Customers not linked yet wait until you link them.', { n: older.length, amount: money(total) }), confirmLabel: T('Send') });
    if (!r.ok) return;
    const res = await importOpenBalances();
    toast('success', T('{n} orders queued for the central ledger.', { n: res.queued }));
  };
  const linkLocal = linking ? db.customers.find((c) => c.id === linking) : undefined;
  return (
    <div className="col gap-16" data-testid="central-ledger">
      <Banner tone="info"><b><Tx>Store credit sales are billed in the central ledger.</Tx></b>{' '}<Tx>A sale left owing for a customer becomes a central invoice; payments are received with “Receive payment” and the accountant’s queue books them. This device no longer records the cash of those payments, so nothing is counted twice.</Tx></Banner>
      <div className="row gap-8 wrap">
        <Button onClick={() => void syncCentral()} disabled={syncing}><RefreshCw size={14} />{' '}<Tx>{syncing ? 'Sending…' : 'Send now'}</Tx></Button>
        {older.length > 0 && <Button variant="primary" onClick={() => void doImport()}><Send size={14} />{' '}<Tx>Send open balances to the central ledger</Tx>{` (${older.length})`}</Button>}
        {lastSyncAt && <span className="muted">{T('Last sent')} {new Date(lastSyncAt).toLocaleTimeString()}</span>}
      </div>
      {error && <Banner tone="warn">{T(error)}</Banner>}
      <Card title={T('Waiting to be sent')} flush>
        <DataTable rows={rows} rowKey={(x) => x.it.orderId} empty={<Empty title="Nothing waiting" hint="Every credit sale of this device is in the central ledger." />}
          cols={[
            { key: 'o', header: 'Order', render: (x) => <><b>{x.o!.no}</b><div className="sub">{dateFmt(x.o!.createdAt)}</div></> },
            { key: 'c', header: 'Customer', render: (x) => db.customers.find((c) => c.id === x.o!.customerId)?.name ?? '–' },
            { key: 's', header: 'Status', render: (x) => <Badge tone={x.it.state === 'failed' ? 'bad' : x.it.state === 'needs_link' ? 'warn' : 'info'} dot>{T(x.it.state === 'needs_link' ? 'Link the customer' : x.it.state === 'failed' ? 'Could not send' : 'Queued')}</Badge> },
            { key: 'e', header: '', render: (x) => x.it.state === 'needs_link' ? <Button size="sm" onClick={() => setLinking(x.o!.customerId!)}><Link2 size={14} />{' '}<Tx>Link customer</Tx></Button> : x.it.error ? <span className="muted">{T(x.it.error)}</span> : null },
          ]} />
      </Card>
      <Card title={T('Billed in the central ledger (still owing)')} flush>
        <DataTable rows={centralOrders} rowKey={(o) => o.id} pageSize={10} empty={<Empty title="No central invoice is owing" />}
          cols={[
            { key: 'o', header: 'Order', render: (o) => <><b>{o.no}</b><div className="sub mono">{o.central!.invoiceNo}</div></> },
            { key: 'c', header: 'Customer', render: (o) => db.customers.find((c) => c.id === o.customerId)?.name ?? '–' },
            { key: 'a', header: 'Owes', num: true, render: (o) => <>{money(o.central!.outstanding)}{o.central!.pending > 0 && <div className="sub">{T('{amount} waiting to post', { amount: money(o.central!.pending) })}</div>}</> },
            { key: 'x', header: '', render: (o) => <Button size="sm" onClick={() => onReceive(o.customerId!)}><Tx>Receive</Tx></Button> },
          ]} />
      </Card>
      {linkLocal && (
        <Modal title={T('Link customer')} size="lg" onClose={() => setLinking(null)} footer={<Button onClick={() => setLinking(null)}><Tx>Close</Tx></Button>}>
          <LinkCustomerPanel local={linkLocal} onLinked={() => setLinking(null)} />
        </Modal>
      )}
    </div>
  );
}
