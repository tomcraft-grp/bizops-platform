import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Download, FileUp, RefreshCw, Settings2 } from 'lucide-react';
import { useDB, useLang } from '../domain/store';
import { CHANNEL_LIST, CHANNELS } from '../domain/meta';
import { importCSVRows, mapSku, retryExternal, simulateSync } from '../domain/channels';
import { createSettlement, receiveSettlement, settleable } from '../domain/payments';
import { Badge, Banner, Button, Card, ChannelChip, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, Textarea, useHas, useRun, Tx } from '../ui/kit';
import { dateTimeFmt, dayKey, download, money, money0, mulberry32, parseCSV, relTime, addDays } from '../lib/util';
import type { ChannelAccount, ChannelCode } from '../domain/types';
import { useAlerts } from '../ui/data';
import { t as tl } from '../lib/i18n';

type Tab = 'overview' | 'mapping' | 'errors' | 'settlements' | 'log';
const SAMPLE = `order_id,sku,name,qty,price,voucher,created_at
SP2611999001,SPE-F02,House Blend 250 g,2,209,0,
SP2611999001,SPE-R05,Paper filters,1,185,10,
SP2611999002,SPE-NEWSKU,Seasonal gift set,1,499,0,
`;

export default function Channels() {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => setSp({ tab: t });
  const canEdit = useHas('channels:edit');
  const alerts = useAlerts();
  const [edit, setEdit] = useState<ChannelAccount | null>(null);
  const [csvFor, setCsvFor] = useState<ChannelCode | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const week = dayKey(addDays(new Date(), -6));

  return (
    <>
      <PageHead title="Sales channels" desc="Connectors import orders into the unified model, map channel SKUs to internal products, track fees and reconcile platform settlements." />
      <div className="mb16"><Banner tone="warn"><b><Tx>Simulated connectors.</Tx></b>{' '}<Tx>Marketplace and delivery API access, scopes, approval requirements and commercial terms must be verified with each platform before real integration.</Tx>{' '}<b><Tx>CSV import</Tx></b>{' '}<Tx>works today as the fallback. Fee rates below are illustrative — enter your contract rates.</Tx></Banner></div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { v: 'overview', label: 'Overview' }, { v: 'mapping', label: 'SKU mapping', count: db.mappings.filter((m) => !m.productId).length || '' },
        { v: 'errors', label: 'Sync errors', count: alerts.syncErrors.length || '' }, { v: 'settlements', label: 'Settlements', count: alerts.pendingSettle.length || '' }, { v: 'log', label: 'Sync log' },
      ]} />

      {tab === 'overview' && (
        <div className="grid g-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(330px, 100%), 1fr))' }}>
          {db.channelAccounts.map((a) => {
            const m = CHANNELS[a.channel];
            const orders = db.orders.filter((o) => o.channel === a.channel && dayKey(o.createdAt) >= week);
            const errs = db.externalOrders.filter((e) => e.channel === a.channel && e.status === 'error').length;
            const external = m.kind === 'marketplace' || m.kind === 'delivery';
            return (
              <Card key={a.channel} title={<span className="row gap-6"><i className="ch-dot" style={{ background: m.color, width: 12, height: 12 }} /><Tx>{m.label}</Tx></span>} sub={a.shopName}
                actions={canEdit && external && <Button size="sm" variant="ghost" icon onClick={() => setEdit(a)} aria-label={tl(lang, 'Edit fees')}><Settings2 size={15} /></Button>}>
                <div className="row wrap gap-6 mb8">
                  <Badge tone={a.connection === 'native' ? 'good' : a.verified ? 'good' : 'warn'} dot>{a.connection === 'native' ? <Tx>{'Native channel'}</Tx> : a.verified ? <Tx>{'API verified'}</Tx> : a.connection === 'api' ? <Tx>{'API: verification pending'}</Tx> : <Tx>{'CSV import only'}</Tx>}</Badge>
                  {errs > 0 && <Badge tone="bad">{errs}{' '}<Tx>errors</Tx></Badge>}
                </div>
                <div className="grid g2" style={{ gap: 10 }}>
                  <div><div className="muted" style={{ fontSize: 12 }}><Tx>Orders (7 d)</Tx></div><b style={{ fontSize: 20 }}>{orders.length}</b></div>
                  <div><div className="muted" style={{ fontSize: 12 }}><Tx>Gross (7 d)</Tx></div><b style={{ fontSize: 20 }}>{money0(orders.reduce((s, o) => s + o.total, 0))}</b></div>
                </div>
                {external && (
                  <>
                    <div className="divider" />
                    <div className="row between" style={{ fontSize: 13 }}><span className="muted"><Tx>Commission / payment fee</Tx></span><span>{a.commissionPct}% / {a.paymentFeePct}%</span></div>
                    <div className="row between" style={{ fontSize: 13 }}><span className="muted"><Tx>Shipping subsidy · payout</Tx></span><span>{money(a.shippingSubsidy)} · T+{a.settlementDays}</span></div>
                    <div className="row between" style={{ fontSize: 13 }}><span className="muted"><Tx>Last sync</Tx></span><span>{a.lastSyncAt ? relTime(a.lastSyncAt) : <Tx>{'never'}</Tx>}</span></div>
                    {canEdit && (
                      <div className="row mt8">
                        <Button size="sm" variant="primary" onClick={() => run((d, c) => simulateSync(d, c, a.channel, mulberry32(Date.now() & 0xffff), 6), { ok: `Synced ${m.short}` })}><RefreshCw size={14} />{' '}<Tx>Sync now</Tx></Button>
                        <Button size="sm" onClick={() => setCsvFor(a.channel)}><FileUp size={14} />{' '}<Tx>Import CSV</Tx></Button>
                      </div>
                    )}
                  </>
                )}
                {!external && <div className="muted mt8" style={{ fontSize: 13 }}>{a.channel === 'POS' ? <Tx>{'Staff-operated point of sale.'}</Tx> : <Tx>{'Customer orders placed in the LINE LIFF app arrive here directly.'}</Tx>}</div>}
              </Card>
            );
          })}
        </div>
      )}

      {tab === 'mapping' && (
        <Card flush title="Channel SKU → internal product" sub="Unmapped SKUs park incoming orders in the error queue until mapped; mapping a SKU retries them automatically." >
          <DataTable rows={db.mappings} rowKey={(m) => m.id} pageSize={16} search={(m) => `${m.externalSku} ${m.externalName} ${m.channel}`}
            cols={[
              { key: 'c', header: 'Channel', render: (m) => <ChannelChip c={m.channel} /> },
              { key: 's', header: 'Channel SKU', sort: (m) => m.externalSku, render: (m) => <span className="mono">{m.externalSku}</span> },
              { key: 'n', header: 'Listing name', render: (m) => m.externalName },
              { key: 'p', header: 'Internal product', render: (m) => (
                <Select sm value={m.productId ?? ''} disabled={!canEdit} onChange={(e) => run((d, c) => mapSku(d, c, m.id, e.target.value || null), { ok: 'Mapping saved' })} style={{ minWidth: 220, borderColor: m.productId ? undefined : 'var(--warn)' }}>
                  <option value="">— Unmapped —</option>
                  {db.products.filter((p) => ['resale', 'finished', 'menu'].includes(p.kind)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>) },
              { key: 'st', header: '', render: (m) => (m.productId ? <Badge tone="good"><Tx>mapped</Tx></Badge> : <Badge tone="warn"><Tx>needs mapping</Tx></Badge>) },
            ]} />
        </Card>
      )}

      {tab === 'errors' && (
        <Card flush title="Error queue & duplicate events" sub="Nothing is silently dropped. Retry after fixing the cause.">
          <DataTable rows={[...db.externalOrders].filter((e) => e.status !== 'imported').reverse()} rowKey={(e) => e.id} pageSize={12}
            empty={<Empty icon={<CheckCircle2 size={22} />} title="No sync problems" hint="Unmapped SKUs and import failures will appear here." />}
            cols={[
              { key: 't', header: 'Received', render: (e) => dateTimeFmt(e.receivedAt) },
              { key: 'c', header: 'Channel', render: (e) => <ChannelChip c={e.channel} /> },
              { key: 'id', header: 'External ID', render: (e) => <span className="mono">{e.externalId}</span> },
              { key: 'src', header: 'Source', render: (e) => <Badge>{e.source}</Badge> },
              { key: 's', header: 'Result', render: (e) => (e.status === 'duplicate' ? <Badge tone="info"><Tx>duplicate ignored</Tx></Badge> : <Badge tone="bad" dot><Tx>error</Tx></Badge>) },
              { key: 'm', header: 'Detail', render: (e) => e.error ?? (e.status === 'duplicate' ? 'Already imported — idempotency key matched' : '') },
              { key: 'a', header: '', render: (e) => <div className="row gap-6">{e.status === 'error' && canEdit && <Button size="sm" onClick={() => run((d, c) => { const r = retryExternal(d, c, e.id); if (r !== 'imported') throw new Error(d.externalOrders.find((x) => x.id === e.id)?.error ?? 'Still failing'); }, { ok: 'Imported' })}><Tx>Retry</Tx></Button>}<Button size="sm" variant="ghost" onClick={() => setRaw(e.raw)}><Tx>Payload</Tx></Button></div> },
            ]} />
        </Card>
      )}

      {tab === 'settlements' && <Settlements />}

      {tab === 'log' && (
        <Card flush title="Sync history">
          <DataTable rows={[...db.syncJobs].reverse()} rowKey={(j) => j.id} pageSize={12} empty={<Empty title="No syncs yet" hint="Use “Sync now” on a channel to pull orders." />}
            cols={[
              { key: 't', header: 'Time', render: (j) => dateTimeFmt(j.ts) }, { key: 'c', header: 'Channel', render: (j) => <ChannelChip c={j.channel} /> }, { key: 's', header: 'Source', render: (j) => <Badge>{j.source}</Badge> },
              { key: 'f', header: 'Fetched', num: true, render: (j) => j.fetched }, { key: 'i', header: 'Imported', num: true, render: (j) => j.imported }, { key: 'd', header: 'Duplicates', num: true, render: (j) => j.duplicates },
              { key: 'e', header: 'Errors', num: true, render: (j) => (j.errors ? <span className="bad">{j.errors}</span> : 0) }, { key: 'ms', header: 'Duration', num: true, render: (j) => `${j.durationMs} ms` },
            ]} />
        </Card>
      )}

      {edit && <FeeModal a={edit} onClose={() => setEdit(null)} />}
      {csvFor && <CsvModal channel={csvFor} onClose={() => setCsvFor(null)} />}
      {raw != null && <Modal title="Source payload" onClose={() => setRaw(null)}><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(raw, null, 2)}</pre></Modal>}
    </>
  );
}

function FeeModal({ a, onClose }: { a: ChannelAccount; onClose: () => void }) {
  const run = useRun();
  const [f, setF] = useState({ commissionPct: a.commissionPct, paymentFeePct: a.paymentFeePct, shippingSubsidy: a.shippingSubsidy, settlementDays: a.settlementDays });
  return (
    <Modal title={`${CHANNELS[a.channel].label} — fee schedule`} size="sm" onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" onClick={() => run((d) => { Object.assign(d.channelAccounts.find((x) => x.channel === a.channel)!, f); }, { ok: 'Saved — applies to new orders (estimates)', perm: 'channels:edit', onOk: onClose })}><Tx>Save</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Commission %"><NumInput value={f.commissionPct} onChange={(n) => setF({ ...f, commissionPct: n })} /></Field>
        <Field label="Payment fee %"><NumInput value={f.paymentFeePct} onChange={(n) => setF({ ...f, paymentFeePct: n })} /></Field>
        <Field label="Shipping subsidy / order (฿)"><NumInput value={f.shippingSubsidy} onChange={(n) => setF({ ...f, shippingSubsidy: n })} /></Field>
        <Field label="Payout delay (days)"><NumInput value={f.settlementDays} onChange={(n) => setF({ ...f, settlementDays: n })} /></Field>
        <div className="full muted" style={{ fontSize: 12 }}><Tx>These are used to ESTIMATE profit until the actual settlement arrives; actual fees replace the estimate order-by-order.</Tx></div>
      </div>
    </Modal>
  );
}

function CsvModal({ channel, onClose }: { channel: ChannelCode; onClose: () => void }) {
  const run = useRun();
  const [text, setText] = useState(SAMPLE.replace(/SPE-/g, { SHOPEE: 'SPE-', LAZADA: 'LZD-', TIKTOK: 'TTS-', LINEMAN: 'LMN-', LINE: 'SPE-', POS: 'SPE-' }[channel]).replace('SP2611999', channel.slice(0, 2) + '26119' + String(Date.now()).slice(-3)));
  const file = useRef<HTMLInputElement>(null);
  return (
    <Modal title={`Import ${CHANNELS[channel].label} orders from CSV`} size="lg" onClose={onClose}
      footer={<><Button onClick={() => download('sample-orders.csv', SAMPLE)}><Download size={14} />{' '}<Tx>Sample file</Tx></Button><div className="grow" /><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" onClick={() => run((d, c) => importCSVRows(d, c, channel, parseCSV(text)), { perm: 'channels:edit', ok: 'CSV processed — check the sync log and error queue', onOk: onClose })}><Tx>Import</Tx></Button></>}>
      <div className="col">
        <div className="muted"><Tx>Columns:</Tx>{' '}<span className="mono"><Tx>order_id, sku, name, qty, price, voucher, created_at</Tx></span><Tx>. Re-importing the same order id is ignored (idempotent). Unknown SKUs go to the error queue.</Tx></div>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <Button onClick={() => file.current?.click()}><FileUp size={14} />{' '}<Tx>Choose a CSV file…</Tx></Button>
        <Textarea className="mono" style={{ minHeight: 200 }} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
    </Modal>
  );
}

function Settlements() {
  const db = useDB();
  const run = useRun();
  const canAcct = useHas('accounting:create') || useHas('receivables:approve') || useHas('channels:edit');
  const [recv, setRecv] = useState<{ id: string; amount: number } | null>(null);
  const ext = CHANNEL_LIST.filter((c) => c.collectedBy === 'platform');
  const eligible = useMemo(() => ext.map((c) => ({ c, orders: settleable(db, c.code) })), [db.orders]); // eslint-disable-line
  const pending = db.settlements.filter((s) => s.status === 'pending');
  const unsettledTotal = eligible.reduce((s, e) => s + e.orders.reduce((a, o) => a + o.total - o.creditNoted, 0), 0);
  return (
    <div className="col gap-16">
      <div className="grid g3">
        <Kpi label="Awaiting statement" value={money0(unsettledTotal)} sub={<Tx vars={{ n: eligible.reduce((s, e) => s + e.orders.length, 0) }}>{'{n} completed orders not yet settled'}</Tx>} />
        <Kpi label="Statements awaiting bank" value={money0(pending.reduce((s, x) => s + x.net, 0))} sub={<Tx vars={{ n: pending.length }}>{'{n} statement(s)'}</Tx>} />
        <Kpi label="Received (all time)" value={money0(db.settlements.filter((s) => s.status === 'received').reduce((s, x) => s + (x.receivedAmount ?? 0), 0))} sub={`${db.settlements.filter((s) => s.status === 'received').length} settlements`} />
      </div>
      <Card title="Create settlement statement" sub="Group completed orders into the payout statement you receive from the platform. Fees default to the estimate; replace with the statement's actual numbers." flush>
        <DataTable rows={eligible.filter((e) => e.orders.length)} rowKey={(e) => e.c.code} empty={<Empty title="Nothing to settle" hint="Completed marketplace/delivery orders appear here." />}
          cols={[
            { key: 'c', header: 'Channel', render: (e) => <ChannelChip c={e.c.code} /> }, { key: 'n', header: 'Orders', num: true, render: (e) => e.orders.length },
            { key: 'g', header: 'Gross', num: true, render: (e) => money(e.orders.reduce((s, o) => s + o.total - o.creditNoted, 0)) },
            { key: 'f', header: 'Est. fees', num: true, render: (e) => money(e.orders.reduce((s, o) => s + o.fees.commission + o.fees.paymentFee + o.fees.shippingSubsidy, 0)) },
            { key: 'p', header: 'Oldest', render: (e) => dateTimeFmt(e.orders[0]?.createdAt) },
            { key: 'a', header: '', render: (e) => canAcct && <Button size="sm" variant="primary" onClick={() => run((d, c) => createSettlement(d, c, { channel: e.c.code, orderIds: e.orders.map((o) => o.id) }), { ok: 'Settlement statement created' })}><Tx>Create statement</Tx></Button> },
          ]} />
      </Card>
      <Card title="Settlement statements" flush>
        <DataTable rows={[...db.settlements].reverse()} rowKey={(s) => s.id} pageSize={10} empty={<Empty title="No settlements yet" />}
          cols={[
            { key: 'no', header: 'Statement', render: (s) => <b>{s.no}</b> }, { key: 'c', header: 'Channel', render: (s) => <ChannelChip c={s.channel} /> },
            { key: 'n', header: 'Orders', num: true, render: (s) => s.orderIds.length }, { key: 'g', header: 'Gross', num: true, render: (s) => money(s.gross) },
            { key: 'f', header: 'Fees', num: true, render: (s) => '−' + money(s.commission + s.paymentFee + s.shippingSubsidy) }, { key: 'net', header: 'Net payout', num: true, render: (s) => <b>{money(s.net)}</b> },
            { key: 'st', header: 'Status', render: (s) => (s.status === 'received' ? <><Badge tone="good" dot><Tx>received</Tx></Badge>{s.variance ? <div className="sub bad"><Tx>variance</Tx>{' '}{money(s.variance)}</div> : null}</> : <Badge tone="warn" dot><Tx>awaiting bank</Tx></Badge>) },
            { key: 'a', header: '', render: (s) => s.status === 'pending' && canAcct && <Button size="sm" onClick={() => setRecv({ id: s.id, amount: s.net })}><Tx>Mark received</Tx></Button> },
          ]} />
      </Card>
      {recv && (
        <Modal title="Record bank receipt" size="sm" onClose={() => setRecv(null)} footer={<><Button onClick={() => setRecv(null)}><Tx>Cancel</Tx></Button><Button variant="primary" onClick={() => run((d, c) => receiveSettlement(d, c, recv.id, recv.amount), { ok: 'Settlement posted — order fees are now final', onOk: () => setRecv(null) })}><Tx>Post to bank</Tx></Button></>}>
          <Field label="Amount received in bank" hint={`Expected ${money(db.settlements.find((s) => s.id === recv.id)?.net ?? 0)}. Any difference is posted to bank charges / settlement variance.`}><NumInput value={recv.amount} onChange={(n) => setRecv({ ...recv, amount: n })} /></Field>
        </Modal>
      )}
    </div>
  );
}
export const _x = [AlertTriangle, Input];
