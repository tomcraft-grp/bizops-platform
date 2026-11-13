import { useMemo, useState } from 'react';
import { Check, ChefHat, Flame, Clock, CupSoda, Printer } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { kdsAllDone, setKds } from '../domain/orders';
import { Badge, Button, Card, ChannelChip, Empty, PageHead, Seg, useHas, useRun, Tx } from '../ui/kit';
import { useTicker } from '../ui/data';
import { cx, timeFmt } from '../lib/util';
import type { Order, Station } from '../domain/types';
import { enqueueJob } from '../domain/printing';
import { t as tl } from '../lib/i18n';

export default function KDS() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('kds:edit');
  const now = useTicker(15000);
  const [station, setStation] = useState<Station>('beverage');
  const [branch, setBranch] = useState('B1');
  const orders = useMemo(() => {
    const cutoff = Date.now() - 36 * 3600000;
    return db.orders
      .filter((o) => o.branchId === branch && o.status !== 'cancelled' && new Date(o.createdAt).getTime() > cutoff && o.lines.some((l) => l.station === station && l.kds && l.kds !== 'done'))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [db.orders, station, branch]);
  const counts = useMemo(() => {
    const c = { kitchen: 0, beverage: 0 };
    for (const o of db.orders) if (o.branchId === branch && o.status !== 'cancelled' && new Date(o.createdAt).getTime() > Date.now() - 36 * 3600000) for (const l of o.lines) if (l.kds && l.kds !== 'done' && l.station) c[l.station]++;
    return c;
  }, [db.orders, branch]);

  return (
    <>
      <PageHead title="Kitchen & beverage display" desc="Orders appear by station. Tap an item to move it new → preparing → ready → done. Waiting time is tracked; printed tickets are the fallback."
        actions={<>
          <select className="select sm" style={{ width: 'auto' }} value={branch} onChange={(e) => setBranch(e.target.value)}>{db.branches.filter((b) => b.type === 'kitchen' || b.type === 'store').map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <Seg value={station} onChange={setStation} options={[{ v: 'beverage', label: <span className="row gap-6"><CupSoda size={14} />{' '}<Tx>Beverage (</Tx>{counts.beverage})</span> }, { v: 'kitchen', label: <span className="row gap-6"><ChefHat size={14} />{' '}<Tx>Kitchen (</Tx>{counts.kitchen})</span> }]} />
        </>} />
      {orders.length === 0 ? (
        <Card><Empty icon={<Check size={22} />} title="No open tickets" hint="New POS and LINE MAN orders for this station will appear here. Make a sale in POS to see one." /></Card>
      ) : (
        <div className="kds">
          {orders.map((o) => <Ticket key={o.id} o={o} station={station} now={now} canEdit={canEdit} run={run} />)}
        </div>
      )}
    </>
  );
}

function Ticket({ o, station, now, canEdit, run }: { o: Order; station: Station; now: number; canEdit: boolean; run: ReturnType<typeof useRun> }) {
  const lang = useLang();
  const mins = Math.max(0, Math.floor((now - new Date(o.createdAt).getTime()) / 60000));
  const cls = mins >= 15 ? 'late' : mins >= 8 ? 'mid' : '';
  const lines = o.lines.filter((l) => l.station === station && l.kds);
  const next = { new: 'preparing', preparing: 'ready', ready: 'done', done: 'done' } as const;
  return (
    <div className={cx('ticket', cls)}>
      <div className="ticket-h"><span>{o.no} {o.tableNo && `· T${o.tableNo}`}</span><span className="row gap-6"><Clock size={14} />{mins < 90 ? <Tx vars={{ n: mins }}>{'{n} min'}</Tx> : timeFmt(o.createdAt)}</span></div>
      <div style={{ padding: '6px 12px' }} className="row between"><ChannelChip c={o.channel} /><span className="muted" style={{ fontSize: 12 }}><Tx>{o.orderType.replace('_', ' ')}</Tx></span></div>
      {lines.map((l) => (
        <div key={l.id} className="ticket-i" style={{ opacity: l.kds === 'done' ? 0.45 : 1 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 15 }}>{l.qty}× {l.name}</div>
            {l.modifiers.map((m) => <div key={m.option} className="muted" style={{ fontSize: 12.5 }}>— {m.option}</div>)}
            {l.note && <div style={{ fontSize: 12.5, color: 'var(--crit-text)', fontWeight: 600 }}><Tx>NOTE:</Tx>{' '}{l.note}</div>}
          </div>
          <Button size="sm" disabled={!canEdit || l.kds === 'done'} variant={l.kds === 'ready' ? 'primary' : l.kds === 'preparing' ? 'soft' : undefined} onClick={() => run((d, c) => setKds(d, c, o.id, l.id, next[l.kds!]))}>
            {l.kds === 'new' ? <Tx>{'Start'}</Tx> : l.kds === 'preparing' ? <><Flame size={13} />{' '}<Tx>Ready</Tx></> : l.kds === 'ready' ? <Tx>{'Serve'}</Tx> : <Tx>{'Done'}</Tx>}
          </Button>
        </div>
      ))}
      <div className="row between" style={{ padding: '8px 12px', borderTop: '1px solid var(--hairline)' }}>
        <Badge tone={lines.every((l) => l.kds === 'ready') ? 'good' : lines.some((l) => l.kds === 'preparing') ? 'warn' : 'info'} dot>{lines.every((l) => l.kds === 'ready') ? <Tx>{'all ready'}</Tx> : lines.some((l) => l.kds === 'preparing') ? <Tx>{'preparing'}</Tx> : <Tx>{'waiting'}</Tx>}</Badge>
        <div className="row gap-6">
          <Button size="sm" variant="ghost" title={tl(lang, 'Reprint ticket')} onClick={() => run((d, c) => enqueueJob(d, c, { docType: station === 'kitchen' ? 'kitchen_ticket' : 'beverage_ticket', refType: 'order', refId: o.id, station, branchId: o.branchId, orderType: o.orderType, reprintOf: 'KDS', reason: 'Reprint from KDS' }), { ok: 'Ticket re-queued' })}><Printer size={14} /></Button>
          <Button size="sm" disabled={!canEdit} onClick={() => run((d, c) => kdsAllDone(d, c, o.id), { ok: 'Order bumped' })}><Tx>Bump all</Tx></Button>
        </div>
      </div>
    </div>
  );
}
