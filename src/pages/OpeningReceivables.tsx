import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, Seg, Select, Skeleton, Tx, useHas } from '../ui/kit';
import { dateFmt, dateTimeFmt, money, money0 } from '../lib/util';
import { toast } from '../domain/store';
import { AR_METHODS, loadOpeningAr, previewFifo, receivePayment, voidReceipt, type ArCustomerBalance, type ArData, type ArMethod, type ArReceipt } from '../lib/arApi';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ArData };
const today = () => new Date().toISOString().slice(0, 10);

// Opening AR balances (and payments received against them) from Supabase. Three explicit states: loading,
// error (with retry), empty (nothing imported). Never shows placeholder numbers.
export default function OpeningReceivables() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [view, setView] = useState<'customer' | 'invoice' | 'receipts'>('customer');
  const [receiveFor, setReceiveFor] = useState<ArCustomerBalance | null>(null);
  const [voiding, setVoiding] = useState<ArReceipt | null>(null);
  const canCreate = useHas('receivables:create');
  const canCancel = useHas('receivables:cancel');

  const load = useCallback((quiet = false) => {
    if (!quiet) setState({ status: 'loading' });
    loadOpeningAr()
      .then((r) => setState(r.error || !r.data ? { status: 'error', message: r.error ?? 'Unknown error' } : { status: 'ready', data: r.data }))
      .catch((e) => setState({ status: 'error', message: String(e?.message ?? e) }));
  }, []);
  useEffect(() => load(), [load]);

  const totals = useMemo(() => {
    if (state.status !== 'ready') return null;
    const c = state.data.customers;
    const sum = (k: 'outstanding_total' | 'original_total' | 'paid_total' | 'received_total' | 'balance_total' | 'open_items') => c.reduce((a, r) => a + r[k], 0);
    return { out: sum('outstanding_total'), orig: sum('original_total'), paid: sum('paid_total'), received: sum('received_total'), balance: sum('balance_total'), items: sum('open_items') };
  }, [state]);

  if (state.status === 'loading') return <div className="col gap-4"><div className="grid g4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={86} />)}</div><Skeleton h={240} /></div>;
  if (state.status === 'error') {
    return <Banner tone="bad"><b><Tx>Could not load opening balances.</Tx></b>{' '}{state.message}{' '}<Button size="sm" onClick={() => load()}><RefreshCw size={14} />{' '}<Tx>Retry</Tx></Button></Banner>;
  }

  const { data } = state;
  if (data.customers.length === 0) {
    return <Card><Empty icon={<Check size={22} />} title="No opening balances yet" hint="Nothing has been imported, or you do not have access. Balances carried forward from the previous system appear here." /></Card>;
  }

  const batch = data.batches[0];
  const rep = batch?.notes?.source_sheet_reported_totals;
  const sheetDiff = (rep?.kratom_difference ?? 0) + (rep?.pod_difference ?? 0);
  const flagged = data.items.filter((i) => i.review_flags.length > 0).length;
  const custName = (id: string) => data.customers.find((c) => c.customer_id === id)?.customer_name ?? '—';
  const posted = data.receipts.filter((r) => r.status === 'posted');
  return (
    <div className="col gap-4">
      <div className="grid g4">
        <Kpi label="Balance still owed" value={money(totals!.balance)} sub={`${data.customers.length} customers · ${data.items.filter((i) => i.balance_amount > 0).length} open items`} />
        <Kpi label="Opening balance" value={money(totals!.out)} sub={`Original ${money0(totals!.orig)} less ${money0(totals!.paid)} paid before`} />
        <Kpi label="Received since import" value={money(totals!.received)} sub={`${posted.length} receipt${posted.length === 1 ? '' : 's'}`} />
        <Kpi label="Needs review" value={String(flagged)} sub="Items with data-quality flags" tone={flagged ? 'bad' : undefined} />
      </div>
      {batch && (
        <Banner tone="info">
          <b><Tx>Source</Tx></b>{' '}{batch.source_file} · {batch.source_sheet} · {batch.batch_code} · <Tx>imported</Tx> {dateTimeFmt(batch.imported_at)}.{' '}
          <Tx>Invoice numbers, due dates and tax are not in the source, so overdue status cannot be calculated; age counts from the document date.</Tx>{' '}
          <Tx>These balances are carried forward from the previous system and are separate from the live ledger shown in the summary above.</Tx>
        </Banner>
      )}
      {sheetDiff !== 0 && (
        <Banner tone="warn" icon={<AlertTriangle size={16} />}>
          <b><Tx>Source sheet totals differ by</Tx>{' '}{money0(sheetDiff)}.</b>{' '}
          <Tx>The imported amount is the sum of the individual rows; the sheet’s own summary cells show less. Please confirm with accounting.</Tx>
        </Banner>
      )}
      <Seg value={view} onChange={setView} options={[{ v: 'customer', label: 'By customer' }, { v: 'invoice', label: 'By document' }, { v: 'receipts', label: `Receipts (${data.receipts.length})` }]} />
      <Card flush>
        {view === 'customer' && (
          <DataTable rows={data.customers} rowKey={(r) => r.customer_id} pageSize={15} search={(r) => r.customer_name + r.customer_code}
            cols={[
              { key: 'n', header: 'Customer', sort: (r) => r.customer_name, render: (r) => <><b>{r.customer_name}</b><div className="sub">{r.customer_code}</div></> },
              { key: 'i', header: 'Open items', num: true, sort: (r) => r.open_items, render: (r) => r.open_items },
              { key: 't', header: 'Opening balance', num: true, sort: (r) => r.outstanding_total, render: (r) => money(r.outstanding_total) },
              { key: 'p', header: 'Received', num: true, sort: (r) => r.received_total, render: (r) => (r.received_total > 0 ? money(r.received_total) : <span className="muted">–</span>) },
              { key: 'b', header: 'Balance', num: true, sort: (r) => r.balance_total, render: (r) => <b>{money(r.balance_total)}</b> },
              { key: 'd', header: 'Oldest document', sort: (r) => r.oldest_doc_date ?? '', render: (r) => (r.oldest_doc_date ? dateFmt(r.oldest_doc_date) : <span className="muted">–</span>) },
              { key: 'a', header: 'Max age (days)', num: true, sort: (r) => r.max_age_days ?? -1, render: (r) => (r.max_age_days == null ? <span className="muted">–</span> : r.max_age_days) },
              { key: 'x', header: '', render: (r) => canCreate && r.balance_total > 0 && <Button size="sm" onClick={() => setReceiveFor(r)}><Tx>Receive</Tx></Button> },
            ]} />
        )}
        {view === 'invoice' && (
          <DataTable rows={data.items} rowKey={(r) => r.id} pageSize={15} search={(r) => `${r.customer_name} ${r.source_ref} ${r.register_no ?? ''}`} initialSort={{ key: 'd', dir: 'asc' }}
            cols={[
              { key: 'n', header: 'Customer', sort: (r) => r.customer_name, render: (r) => <b>{r.customer_name}</b> },
              { key: 'r', header: 'Reference', sort: (r) => r.source_ref, render: (r) => <>{r.register_no != null ? `#${r.register_no}` : r.source_ref}<div className="sub">{r.business_line === 'kratom' ? 'Kratom' : 'POD'} · {r.source_sheet} · row {r.source_row}</div></> },
              { key: 'd', header: 'Document date', sort: (r) => r.doc_date ?? '', render: (r) => (r.doc_date ? dateFmt(r.doc_date) : <span className="muted">{r.doc_date_raw ? `invalid (${r.doc_date_raw.slice(0, 10)})` : '–'}</span>) },
              { key: 'g', header: 'Age', sort: (r) => r.age_days ?? -1, render: (r) => (r.age_days == null ? <span className="muted">–</span> : <Badge tone={r.age_days > 90 ? 'bad' : r.age_days > 30 ? 'warn' : ''}>{r.age_days}{' d'}</Badge>) },
              { key: 'o', header: 'Original', num: true, sort: (r) => r.original_amount, render: (r) => money(r.original_amount) },
              { key: 'p', header: 'Paid before', num: true, sort: (r) => r.paid_amount, render: (r) => (r.paid_amount > 0 ? money(r.paid_amount) : <span className="muted">–</span>) },
              { key: 'v', header: 'Received', num: true, sort: (r) => r.received_amount, render: (r) => (r.received_amount > 0 ? money(r.received_amount) : <span className="muted">–</span>) },
              { key: 't', header: 'Balance', num: true, sort: (r) => r.balance_amount, render: (r) => (r.balance_amount > 0 ? <b>{money(r.balance_amount)}</b> : <Badge tone="good">Paid</Badge>) },
              { key: 'f', header: '', render: (r) => (r.review_flags.length ? <Badge tone="warn">{r.review_flags.join(', ').replace(/_/g, ' ')}</Badge> : null) },
            ]} />
        )}
        {view === 'receipts' && (
          <DataTable rows={data.receipts} rowKey={(r) => r.id} pageSize={15} search={(r) => `${r.receipt_no} ${custName(r.customer_id)} ${r.reference ?? ''}`}
            empty={<Empty title="No payments recorded yet" hint="Use Receive on a customer to record a payment against their opening balance." />}
            cols={[
              { key: 'n', header: 'Receipt', sort: (r) => r.receipt_no, render: (r) => <><b>{r.receipt_no}</b><div className="sub">{dateFmt(r.received_date)}</div></> },
              { key: 'c', header: 'Customer', sort: (r) => custName(r.customer_id), render: (r) => custName(r.customer_id) },
              { key: 'm', header: 'Method', render: (r) => <>{AR_METHODS.find((m) => m.v === r.method)?.label ?? r.method}{r.reference ? <div className="sub">{r.reference}</div> : null}</> },
              { key: 'a', header: 'Amount', num: true, sort: (r) => r.amount, render: (r) => (r.status === 'voided' ? <s className="muted">{money(r.amount)}</s> : <b>{money(r.amount)}</b>) },
              { key: 's', header: 'Status', render: (r) => (r.status === 'voided' ? <Badge tone="bad">Voided</Badge> : <Badge tone="good">Posted</Badge>) },
              { key: 'u', header: 'Recorded by', hideSm: true, render: (r) => <>{r.created_by_label}<div className="sub">{dateTimeFmt(r.created_at)}</div></> },
              { key: 'x', header: '', render: (r) => (r.status === 'voided' ? <span className="sub">{r.void_reason}</span> : canCancel && <Button size="sm" variant="ghost" onClick={() => setVoiding(r)}><Tx>Void</Tx></Button>) },
            ]} />
        )}
      </Card>
      {receiveFor && <ReceiveModal customer={receiveFor} data={data} onClose={() => setReceiveFor(null)} onDone={() => { setReceiveFor(null); setView('receipts'); load(true); }} />}
      {voiding && <VoidModal receipt={voiding} customerName={custName(voiding.customer_id)} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); load(true); }} />}
    </div>
  );
}

function ReceiveModal({ customer, data, onClose, onDone }: { customer: ArCustomerBalance; data: ArData; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState<ArMethod>('transfer');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per opened dialog: pressing the button twice (or a retry after a timeout) can never post two receipts.
  const key = useRef(typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random()}`);
  const items = useMemo(() => data.items.filter((i) => i.customer_id === customer.customer_id), [data.items, customer.customer_id]);
  const over = amount > customer.balance_total + 0.004;
  const invalid = !(amount > 0) || over || !date || date > today() || busy;
  const prev = amount > 0 && !over ? previewFifo(items, amount) : null;
  const submit = async () => {
    setBusy(true); setError(null);
    const r = await receivePayment({ customerId: customer.customer_id, amount, method, date, reference, note, idempotencyKey: key.current });
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    toast('success', `Recorded ${r.receiptNo}`);
    onDone();
  };
  return (
    <Modal title="Receive payment" size="sm" onClose={onClose}
      footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={invalid} onClick={submit}>{busy ? '…' : <Tx>Record payment</Tx>}</Button></>}>
      <div className="col gap-3">
        <div><b>{customer.customer_name}</b><div className="sub">{customer.customer_code} · <Tx>owes</Tx> {money(customer.balance_total)} <Tx>across</Tx> {items.filter((i) => i.balance_amount > 0).length} <Tx>documents</Tx></div></div>
        <Field label="Amount received"><NumInput value={amount || ''} onChange={setAmount} min={0} step={1} autoFocus /></Field>
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as ArMethod)}>{AR_METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}</Select></Field>
        <Field label="Date received"><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Reference (optional)"><Input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Transfer ref, slip no." /></Field>
        <Field label="Note (optional)"><Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        {over && <Banner tone="bad"><Tx>This is more than the customer owes. Overpayment/credit is not supported yet.</Tx></Banner>}
        {prev && <Banner tone="info"><Tx>Applied to the oldest documents first:</Tx> {prev.cleared} <Tx>cleared</Tx>{prev.partial ? <>, <Tx>1 partly paid</Tx></> : null}. <Tx>Balance after:</Tx> <b>{money(customer.balance_total - amount)}</b></Banner>}
        {error && <Banner tone="bad">{error}</Banner>}
      </div>
    </Modal>
  );
}

function VoidModal({ receipt, customerName, onClose, onDone }: { receipt: ArReceipt; customerName: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    const r = await voidReceipt(receipt.id, reason.trim());
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    toast('success', `Voided ${receipt.receipt_no}`);
    onDone();
  };
  return (
    <Modal title="Void receipt" size="sm" onClose={onClose}
      footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="danger" disabled={reason.trim().length < 3 || busy} onClick={submit}>{busy ? '…' : <Tx>Void receipt</Tx>}</Button></>}>
      <div className="col gap-3">
        <Banner tone="warn"><b>{receipt.receipt_no}</b> · {customerName} · {money(receipt.amount)}. <Tx>The receipt is kept for the record and the amount becomes owed again.</Tx></Banner>
        <Field label="Reason (required)"><Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        {error && <Banner tone="bad">{error}</Banner>}
      </div>
    </Modal>
  );
}
