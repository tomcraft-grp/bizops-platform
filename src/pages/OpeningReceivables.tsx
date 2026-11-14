import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import { Badge, Banner, Button, Card, DataTable, Empty, Kpi, Seg, Skeleton, Tx } from '../ui/kit';
import { dateFmt, dateTimeFmt, money, money0 } from '../lib/util';
import { loadOpeningAr, type ArData } from '../lib/arApi';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ArData };

// Opening AR balances from Supabase. Three explicit states: loading, error (with retry), empty (nothing imported).
// Never shows placeholder numbers.
export default function OpeningReceivables() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [view, setView] = useState<'customer' | 'invoice'>('customer');
  const load = useCallback(() => {
    setState({ status: 'loading' });
    loadOpeningAr()
      .then((r) => setState(r.error || !r.data ? { status: 'error', message: r.error ?? 'Unknown error' } : { status: 'ready', data: r.data }))
      .catch((e) => setState({ status: 'error', message: String(e?.message ?? e) }));
  }, []);
  useEffect(load, [load]);

  const totals = useMemo(() => {
    if (state.status !== 'ready') return null;
    const c = state.data.customers;
    return { out: c.reduce((a, r) => a + r.outstanding_total, 0), orig: c.reduce((a, r) => a + r.original_total, 0), paid: c.reduce((a, r) => a + r.paid_total, 0), items: c.reduce((a, r) => a + r.open_items, 0) };
  }, [state]);

  if (state.status === 'loading') return <div className="col gap-4"><div className="grid g4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={86} />)}</div><Skeleton h={240} /></div>;
  if (state.status === 'error') {
    return <Banner tone="bad"><b><Tx>Could not load opening balances.</Tx></b>{' '}{state.message}{' '}<Button size="sm" onClick={load}><RefreshCw size={14} />{' '}<Tx>Retry</Tx></Button></Banner>;
  }

  const { data } = state;
  if (data.customers.length === 0) {
    return <Card><Empty icon={<Check size={22} />} title="No opening balances yet" hint="Nothing has been imported, or you do not have access. Balances carried forward from the previous system appear here." /></Card>;
  }

  const batch = data.batches[0];
  const rep = batch?.notes?.source_sheet_reported_totals;
  const sheetDiff = (rep?.kratom_difference ?? 0) + (rep?.pod_difference ?? 0);
  const flagged = data.items.filter((i) => i.review_flags.length > 0).length;
  return (
    <div className="col gap-4">
      <div className="grid g4">
        <Kpi label="Opening AR outstanding" value={money(totals!.out)} sub={`${data.customers.length} customers · ${totals!.items} open items`} />
        <Kpi label="Original amount" value={money(totals!.orig)} sub="Before payments" />
        <Kpi label="Already paid" value={money(totals!.paid)} sub="Deducted from the opening balance" />
        <Kpi label="Needs review" value={String(flagged)} sub="Items with data-quality flags" tone={flagged ? 'bad' : undefined} />
      </div>
      {batch && (
        <Banner tone="info">
          <b><Tx>Source</Tx></b>{' '}{batch.source_file} · {batch.source_sheet} · {batch.batch_code} · <Tx>imported</Tx> {dateTimeFmt(batch.imported_at)}.{' '}
          <Tx>Invoice numbers, due dates and tax are not in the source, so overdue status cannot be calculated; age counts from the document date.</Tx>{' '}<Tx>These balances are carried forward from the previous system and are separate from the live ledger shown in the summary above.</Tx>
        </Banner>
      )}
      {sheetDiff !== 0 && (
        <Banner tone="warn" icon={<AlertTriangle size={16} />}>
          <b><Tx>Source sheet totals differ by</Tx>{' '}{money0(sheetDiff)}.</b>{' '}
          <Tx>The imported amount is the sum of the individual rows; the sheet’s own summary cells show less. Please confirm with accounting.</Tx>
        </Banner>
      )}
      <Seg value={view} onChange={setView} options={[{ v: 'customer', label: 'By customer' }, { v: 'invoice', label: 'By document' }]} />
      <Card flush>
        {view === 'customer' ? (
          <DataTable rows={data.customers} rowKey={(r) => r.customer_id} pageSize={15} search={(r) => r.customer_name + r.customer_code}
            cols={[
              { key: 'n', header: 'Customer', sort: (r) => r.customer_name, render: (r) => <><b>{r.customer_name}</b><div className="sub">{r.customer_code}</div></> },
              { key: 'i', header: 'Open items', num: true, sort: (r) => r.open_items, render: (r) => r.open_items },
              { key: 'o', header: 'Original', num: true, sort: (r) => r.original_total, render: (r) => money(r.original_total) },
              { key: 'p', header: 'Paid', num: true, sort: (r) => r.paid_total, render: (r) => (r.paid_total > 0 ? money(r.paid_total) : <span className="muted">–</span>) },
              { key: 't', header: 'Outstanding', num: true, sort: (r) => r.outstanding_total, render: (r) => <b>{money(r.outstanding_total)}</b> },
              { key: 'd', header: 'Oldest document', sort: (r) => r.oldest_doc_date ?? '', render: (r) => (r.oldest_doc_date ? dateFmt(r.oldest_doc_date) : <span className="muted">–</span>) },
              { key: 'a', header: 'Max age (days)', num: true, sort: (r) => r.max_age_days ?? -1, render: (r) => (r.max_age_days == null ? <span className="muted">–</span> : r.max_age_days) },
            ]} />
        ) : (
          <DataTable rows={data.items} rowKey={(r) => r.id} pageSize={15} search={(r) => `${r.customer_name} ${r.source_ref} ${r.register_no ?? ''}`} initialSort={{ key: 'd', dir: 'asc' }}
            cols={[
              { key: 'n', header: 'Customer', sort: (r) => r.customer_name, render: (r) => <b>{r.customer_name}</b> },
              { key: 'r', header: 'Reference', sort: (r) => r.source_ref, render: (r) => <>{r.register_no != null ? `#${r.register_no}` : r.source_ref}<div className="sub">{r.business_line === 'kratom' ? 'Kratom' : 'POD'} · {r.source_sheet} · row {r.source_row}</div></> },
              { key: 'd', header: 'Document date', sort: (r) => r.doc_date ?? '', render: (r) => (r.doc_date ? dateFmt(r.doc_date) : <span className="muted">{r.doc_date_raw ? `invalid (${r.doc_date_raw.slice(0, 10)})` : '–'}</span>) },
              { key: 'g', header: 'Age', sort: (r) => r.age_days ?? -1, render: (r) => (r.age_days == null ? <span className="muted">–</span> : <Badge tone={r.age_days > 90 ? 'bad' : r.age_days > 30 ? 'warn' : ''}>{r.age_days}{' d'}</Badge>) },
              { key: 'o', header: 'Original', num: true, sort: (r) => r.original_amount, render: (r) => money(r.original_amount) },
              { key: 'p', header: 'Paid', num: true, sort: (r) => r.paid_amount, render: (r) => (r.paid_amount > 0 ? money(r.paid_amount) : <span className="muted">–</span>) },
              { key: 't', header: 'Outstanding', num: true, sort: (r) => r.outstanding_amount, render: (r) => <b>{money(r.outstanding_amount)}</b> },
              { key: 'f', header: '', render: (r) => (r.review_flags.length ? <Badge tone="warn">{r.review_flags.join(', ').replace(/_/g, ' ')}</Badge> : null) },
            ]} />
        )}
      </Card>
    </div>
  );
}
