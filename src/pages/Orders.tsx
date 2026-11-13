import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ArrowRight } from 'lucide-react';
import { useDB } from '../domain/store';
import { CHANNEL_LIST, CHANNELS, STATUS_LABEL } from '../domain/meta';
import { allocatedMap, orderBalance, payStatus } from '../domain/payments';
import { advanceOrder, nextStatuses } from '../domain/orders';
import { Badge, Button, Card, ChannelChip, DataTable, Kpi, PageHead, Select, Seg, StatusBadge, useHas, useRun, Tx } from '../ui/kit';
import { useBranchIds } from '../ui/data';
import { OrderDrawer } from './OrderDetail';
import { dateTimeFmt, dayKey, download, money, money0, toCSV } from '../lib/util';
import type { ChannelCode, Order, OrderStatus } from '../domain/types';

type Group = 'all' | 'action' | 'open' | 'unpaid' | 'done' | 'problem';
export default function Orders() {
  const db = useDB();
  const run = useRun();
  const [sp, setSp] = useSearchParams();
  const canExport = useHas('orders:export');
  const canEdit = useHas('orders:edit');
  const branchIds = useBranchIds();
  const [group, setGroup] = useState<Group>('all');
  const [ch, setCh] = useState<ChannelCode | ''>('');
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const alloc = useMemo(() => allocatedMap(db), [db.allocations]);
  const openId = sp.get('o');

  const rows = useMemo(() => {
    let list = db.orders.filter((o) => !branchIds || branchIds.includes(o.branchId));
    if (ch) list = list.filter((o) => o.channel === ch);
    const unpaid = (o: Order) => o.collectedBy === 'merchant' && o.status !== 'cancelled' && orderBalance(o, alloc[o.id] || 0) > 0.004;
    if (group === 'action') list = list.filter((o) => o.channel !== 'POS' && ['new', 'confirmed', 'packed', 'preparing', 'ready'].includes(o.status));
    if (group === 'open') list = list.filter((o) => !['completed', 'cancelled', 'returned'].includes(o.status));
    if (group === 'unpaid') list = list.filter(unpaid);
    if (group === 'done') list = list.filter((o) => o.status === 'completed');
    if (group === 'problem') list = list.filter((o) => ['cancelled', 'returned'].includes(o.status) || o.creditNoted > 0);
    return [...list].reverse();
  }, [db.orders, ch, group, alloc, branchIds]);
  const counts = useMemo(() => ({
    action: db.orders.filter((o) => o.channel !== 'POS' && ['new', 'confirmed', 'packed', 'preparing', 'ready'].includes(o.status)).length,
    unpaid: db.orders.filter((o) => o.collectedBy === 'merchant' && o.status !== 'cancelled' && orderBalance(o, alloc[o.id] || 0) > 0.004).length,
  }), [db.orders, alloc]);
  const today = dayKey(new Date());
  const todays = db.orders.filter((o) => dayKey(o.createdAt) === today && o.status !== 'cancelled');
  const selected = rows.filter((o) => sel[o.id]);
  const advanceable = selected.filter((o) => nextStatuses(o).length);

  const exportCsv = () => download(`orders-${today}.csv`, toCSV([
    ['Order', 'Date', 'Channel', 'External ID', 'Customer', 'Status', 'Subtotal', 'Discount', 'Total', 'Paid', 'Balance'],
    ...rows.map((o) => [o.no, o.createdAt, o.channel, o.externalId ?? '', db.customers.find((c) => c.id === o.customerId)?.name ?? '', o.status, o.subtotal, o.discountTotal, o.total, alloc[o.id] || 0, orderBalance(o, alloc[o.id] || 0)]),
  ]));

  return (
    <>
      <PageHead title="Orders" desc="One unified order model for POS, LINE, Shopee, Lazada, TikTok Shop and LINE MAN — with the original channel IDs preserved."
        actions={canExport && <Button onClick={exportCsv}><Download size={15} />{' '}<Tx>Export CSV</Tx></Button>} />
      <div className="grid g4 mb16">
        <Kpi label="Orders today" value={todays.length} sub={`${money0(todays.reduce((s, o) => s + o.total, 0))} gross`} />
        <Kpi label="Need action" value={counts.action} sub="online orders in progress" tone={counts.action ? undefined : 'good'} />
        <Kpi label="Unpaid / part-paid" value={counts.unpaid} sub="customer-collected orders" />
        <Kpi label="Marketplace orders" value={db.orders.filter((o) => o.collectedBy === 'platform').length} sub="collected by platforms" />
      </div>
      <Card flush>
        <div className="row wrap" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <Seg value={group} onChange={setGroup} options={[{ v: 'all', label: 'All' }, { v: 'action', label: <Tx vars={{ n: counts.action }}>{'Needs action ({n})'}</Tx> }, { v: 'open', label: 'Open' }, { v: 'unpaid', label: <Tx vars={{ n: counts.unpaid }}>{'Unpaid ({n})'}</Tx> }, { v: 'done', label: 'Completed' }, { v: 'problem', label: 'Cancelled / returns' }]} />
          <Select sm style={{ width: 'auto' }} value={ch} onChange={(e) => setCh(e.target.value as ChannelCode | '')}><option value="">All channels</option>{CHANNEL_LIST.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select>
          <div className="grow" />
          {canEdit && advanceable.length > 0 && <Button variant="primary" size="sm" onClick={() => { let n = 0; for (const o of advanceable) run((d, c) => advanceOrder(d, c, o.id), { onOk: () => n++ }); setSel({}); if (n) run(() => undefined, { ok: `Advanced ${n} order(s)` }); }}><Tx>Advance</Tx>{' '}{advanceable.length}{' '}<Tx>selected</Tx>{' '}<ArrowRight size={14} /></Button>}
        </div>
        <DataTable rows={rows} rowKey={(o) => o.id} pageSize={14} onRow={(o) => setSp({ o: o.id })}
          search={(o) => `${o.no} ${o.externalId ?? ''} ${db.customers.find((c) => c.id === o.customerId)?.name ?? ''} ${o.channel}`}
          initialSort={undefined}
          cols={[
            { key: 'sel', header: '', width: 34, render: (o) => nextStatuses(o).length ? <input type="checkbox" checked={!!sel[o.id]} onClick={(e) => e.stopPropagation()} onChange={(e) => setSel({ ...sel, [o.id]: e.target.checked })} aria-label={`Select ${o.no}`} /> : null },
            { key: 'no', header: 'Order', sort: (o) => o.no, render: (o) => <><b>{o.no}</b>{o.externalId && <div className="sub mono">{o.externalId}</div>}</> },
            { key: 'date', header: 'Date', sort: (o) => o.createdAt, render: (o) => dateTimeFmt(o.createdAt) },
            { key: 'ch', header: 'Channel', render: (o) => <ChannelChip c={o.channel} /> },
            { key: 'cust', header: 'Customer', hideSm: true, render: (o) => db.customers.find((c) => c.id === o.customerId)?.name ?? <span className="muted"><Tx>Walk-in</Tx></span> },
            { key: 'st', header: 'Status', render: (o) => <StatusBadge status={o.status as OrderStatus} /> },
            { key: 'pay', header: 'Payment', hideSm: true, render: (o) => { const s = payStatus(o, alloc[o.id] || 0); return s === 'platform' ? <Badge><Tx>via</Tx>{' '}{CHANNELS[o.channel].short}</Badge> : s === 'void' ? <span className="muted">–</span> : <Badge tone={s === 'paid' ? 'good' : s === 'partial' ? 'warn' : s === 'overpaid' ? 'info' : 'bad'} dot>{s}</Badge>; } },
            { key: 'tot', header: 'Total', num: true, sort: (o) => o.total, render: (o) => money(o.total) },
          ]} />
      </Card>
      {openId && <OrderDrawer id={openId} onClose={() => setSp({})} />}
    </>
  );
}
export const _s = STATUS_LABEL;
