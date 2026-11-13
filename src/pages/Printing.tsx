import { useMemo, useState } from 'react';
import { Plus, Printer as PrinterIcon, RefreshCcw, Wifi, WifiOff } from 'lucide-react';
import { useDB } from '../domain/store';
import { cancelJob, markPrinted, reprintJob, retryJob, enqueueJob, renderDoc } from '../domain/printing';
import { DOC_LABEL } from '../domain/meta';
import { updateOrg } from '../domain/master';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi, Modal, PageHead, Select, Seg, Tabs, Textarea, useConfirm, useHas, useRun, Tx } from '../ui/kit';
import { DocPreview, PrintModal } from '../ui/shared';
import { dateTimeFmt, relTime } from '../lib/util';
import { printDoc } from '../lib/print';
import type { DocType, ID, Printer, PrintRule, Station } from '../domain/types';

type Tab = 'queue' | 'printers' | 'routing' | 'templates';
export default function Printing() {
  const db = useDB();
  const [tab, setTab] = useState<Tab>('queue');
  const failed = db.printJobs.filter((j) => j.status === 'failed').length;
  const queued = db.printJobs.filter((j) => j.status === 'queued').length;
  return (
    <>
      <PageHead title="Printing" desc="One print service for receipts, kitchen & bar tickets, packing slips, POs and statements — routed by branch, station, order type and document type, with a queue, retries and duplicate protection." />
      <div className="grid g4 mb16">
        <Kpi label="Printers online" value={`${db.printers.filter((p) => p.status === 'online').length}/${db.printers.length}`} sub="agent / browser / PDF" />
        <Kpi label="Queued (waiting)" value={queued} sub="browser jobs need a person to press Print" />
        <Kpi label="Failed" value={failed} tone={failed ? 'bad' : 'good'} sub="retry after fixing the printer" />
        <Kpi label="Printed (all time)" value={db.printJobs.filter((j) => j.status === 'printed').length} sub={<Tx vars={{ n: db.printJobs.length }}>{'{n} jobs'}</Tx>} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'queue', label: 'Print queue', count: failed || queued || '' }, { v: 'printers', label: 'Printers' }, { v: 'routing', label: 'Routing rules' }, { v: 'templates', label: 'Templates & test' }]} />
      {tab === 'queue' && <Queue />}
      {tab === 'printers' && <Printers />}
      {tab === 'routing' && <Routing />}
      {tab === 'templates' && <Templates />}
    </>
  );
}

function Queue() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canCreate = useHas('printing:create');
  const [st, setSt] = useState('');
  const [view, setView] = useState<ID | null>(null);
  const rows = useMemo(() => [...db.printJobs].reverse().filter((j) => !st || j.status === st), [db.printJobs, st]);
  const job = view ? db.printJobs.find((j) => j.id === view) : undefined;
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(j) => j.id} pageSize={12} empty={<Empty icon={<PrinterIcon size={22} />} title="No print jobs" hint="Make a POS sale: a receipt and kitchen/bar tickets are queued automatically." />}
        toolbar={<Select sm style={{ width: 'auto' }} value={st} onChange={(e) => setSt(e.target.value)}><option value="">All statuses</option>{['queued', 'printing', 'printed', 'failed', 'cancelled'].map((s) => <option key={s}>{s}</option>)}</Select>}
        cols={[
          { key: 'd', header: 'Created', render: (j) => <>{dateTimeFmt(j.createdAt)}<div className="sub">{relTime(j.createdAt)}</div></> },
          { key: 't', header: 'Document', render: (j) => <><b><Tx>{DOC_LABEL[j.docType]}</Tx></b>{j.station && <span className="muted"> · {j.station}</span>}<div className="sub">{j.refType} {j.refType === 'order' ? db.orders.find((o) => o.id === j.refId)?.no : ''}{j.reprintOf ? <> · <Tx vars={{ reason: String(j.reprintReason) }}>{'reprint: {reason}'}</Tx></> : ''}</div></> },
          { key: 'p', header: 'Printer', hideSm: true, render: (j) => { const p = db.printers.find((x) => x.id === j.printerId); return p ? <>{p.name}<div className="sub"><Tx>{p.connection}</Tx> · {p.paper}</div></> : <Badge tone="bad"><Tx>no route</Tx></Badge>; } },
          { key: 's', header: 'Status', render: (j) => <><Badge tone={j.status === 'printed' ? 'good' : j.status === 'failed' ? 'bad' : j.status === 'cancelled' ? '' : 'warn'} dot>{j.status}</Badge>{j.error && <div className="sub bad">{j.error}</div>}{j.attempts > 0 && <div className="sub">{j.attempts}{' '}<Tx>attempt(s)</Tx></div>}</> },
          { key: 'a', header: '', render: (j) => <div className="row gap-4">
            <Button size="sm" onClick={() => setView(j.id)}>{j.status === 'queued' && db.printers.find((p) => p.id === j.printerId)?.connection !== 'agent' ? <Tx>{'Print…'}</Tx> : <Tx>{'View'}</Tx>}</Button>
            {j.status === 'failed' && canCreate && <Button size="sm" variant="primary" onClick={() => run((d, c) => retryJob(d, c, j.id), { ok: 'Re-queued' })}><RefreshCcw size={13} />{' '}<Tx>Retry</Tx></Button>}
            {j.status === 'printed' && canCreate && <Button size="sm" variant="ghost" onClick={async () => { const x = await confirm({ title: 'Reprint this document?', body: 'A new job is created; the original stays in history.', reason: 'Reprint reason (required)', confirmLabel: 'Reprint' }); if (x.ok) run((d, c) => reprintJob(d, c, j.id, x.reason), { ok: 'Reprint queued' }); }}><Tx>Reprint</Tx></Button>}
            {(j.status === 'queued' || j.status === 'failed') && canCreate && <Button size="sm" variant="ghost" onClick={() => run((d) => cancelJob(d, j.id), { ok: 'Cancelled' })}><Tx>Cancel</Tx></Button>}</div> },
        ]} />
      {job && <PrintModal docType={job.docType} refId={job.refId} station={job.station} jobId={job.status === 'printed' ? undefined : job.id} title={`${DOC_LABEL[job.docType]} — preview`} onClose={() => setView(null)} />}
    </Card>
  );
}

function Printers() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('printing:edit');
  const [edit, setEdit] = useState<Printer | 'new' | null>(null);
  return (
    <div className="col gap-16">
      <Banner tone="warn"><b><Tx>Silent printing is not available in every browser or device.</Tx></b>{' '}<Tx>“Agent” printers use a local print agent (ESC/POS) that authenticates to your organization and branch; “Browser” printers show the print dialog; “PDF” saves a document. Test every real printer model, operating system and connection before go-live. Here the agent is simulated — toggle a printer offline to watch jobs fail and retry.</Tx></Banner>
      <div className="grid g-auto">
        {db.printers.map((p) => (
          <Card key={p.id} title={p.name} sub={`${p.model} · ${db.branches.find((b) => b.id === p.branchId)?.name}`} actions={<Badge tone={p.status === 'online' ? 'good' : 'bad'} dot>{p.status === 'online' ? <Wifi size={11} /> : <WifiOff size={11} />} <Tx>{p.status}</Tx></Badge>}>
            <div className="row wrap gap-6 mb8"><Badge>{p.paper}</Badge><Badge tone="info">{p.connection}</Badge>{p.agentName && <Badge><Tx>agent:</Tx>{' '}{p.agentName}</Badge>}</div>
            <div className="muted" style={{ fontSize: 12 }}>{p.lastSeen ? <Tx vars={{ when: relTime(p.lastSeen) }}>{'Last print {when}'}</Tx> : <Tx>{'No jobs yet'}</Tx>} · {db.printJobs.filter((j) => j.printerId === p.id && j.status === 'failed').length}{' '}<Tx>failed ·</Tx>{' '}{db.printJobs.filter((j) => j.printerId === p.id && j.status === 'queued').length}{' '}<Tx>queued</Tx></div>
            {canEdit && <div className="row mt8"><Button size="sm" onClick={() => run((d) => { const x = d.printers.find((y) => y.id === p.id)!; x.status = x.status === 'online' ? 'offline' : 'online'; }, { ok: `${p.name} is now ${p.status === 'online' ? 'offline' : 'online'}` })}>{p.status === 'online' ? <Tx>{'Simulate offline'}</Tx> : <Tx>{'Bring online'}</Tx>}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(p)}><Tx>Edit</Tx></Button></div>}
          </Card>
        ))}
      </div>
      {canEdit && <div><Button onClick={() => setEdit('new')}><Plus size={15} />{' '}<Tx>Add printer</Tx></Button></div>}
      {edit && <PrinterModal p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function PrinterModal({ p, onClose }: { p: Printer | null; onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [f, setF] = useState<Printer>(p ?? { id: '', name: '', model: '', branchId: db.branches[0].id, paper: '80mm', connection: 'agent', status: 'online' });
  return (
    <Modal title={p ? 'Edit printer' : 'Add printer'} onClose={onClose} footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={!f.name} onClick={() => run((d) => { if (p) Object.assign(d.printers.find((x) => x.id === p.id)!, f); else d.printers.push({ ...f, id: 'PT' + (d.printers.length + 10) }); }, { ok: 'Printer saved', perm: 'printing:edit', onOk: onClose })}><Tx>Save</Tx></Button></>}>
      <div className="form-grid">
        <Field label="Name" full><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Model"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{db.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Paper"><Select value={f.paper} onChange={(e) => setF({ ...f, paper: e.target.value as Printer['paper'] })}><option>58mm</option><option>80mm</option><option>A4</option></Select></Field>
        <Field label="Connection"><Select value={f.connection} onChange={(e) => setF({ ...f, connection: e.target.value as Printer['connection'] })}><option value="agent">Local print agent (ESC/POS)</option><option value="browser">Browser print dialog</option><option value="pdf">PDF</option></Select></Field>
        {f.connection === 'agent' && <Field label="Agent name" full><Input value={f.agentName ?? ''} onChange={(e) => setF({ ...f, agentName: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}

function Routing() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('printing:edit');
  const [f, setF] = useState<Omit<PrintRule, 'id'>>({ docType: 'receipt', printerId: db.printers[0].id, priority: 10 });
  return (
    <div className="grid g-main">
      <Card flush title="Routing rules" sub="The most specific matching rule wins (station > branch > order type), then priority.">
        <DataTable rows={[...db.printRules].sort((a, b) => a.docType.localeCompare(b.docType))} rowKey={(r) => r.id} pageSize={14}
          cols={[{ key: 'd', header: 'Document', render: (r) => <Tx>{DOC_LABEL[r.docType]}</Tx> }, { key: 's', header: 'Station', render: (r) => r.station ?? <span className="muted"><Tx>any</Tx></span> }, { key: 'b', header: 'Branch', render: (r) => (r.branchId ? db.branches.find((b) => b.id === r.branchId)?.name : <span className="muted"><Tx>any</Tx></span>) }, { key: 'o', header: 'Order type', hideSm: true, render: (r) => r.orderType ?? <span className="muted"><Tx>any</Tx></span> }, { key: 'p', header: 'Printer', render: (r) => <b>{db.printers.find((p) => p.id === r.printerId)?.name}</b> },
            { key: 'x', header: '', render: (r) => canEdit && <Button size="sm" variant="ghost" onClick={() => run((d) => { d.printRules = d.printRules.filter((x) => x.id !== r.id); }, { ok: 'Rule removed' })}><Tx>Remove</Tx></Button> }]} />
      </Card>
      {canEdit && (
        <Card title="Add rule">
          <div className="col">
            <Field label="Document"><Select value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value as DocType })}>{Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Station"><Select value={f.station ?? ''} onChange={(e) => setF({ ...f, station: (e.target.value || undefined) as Station | undefined })}><option value="">Any</option><option value="kitchen">Kitchen</option><option value="beverage">Beverage</option></Select></Field>
            <Field label="Branch"><Select value={f.branchId ?? ''} onChange={(e) => setF({ ...f, branchId: e.target.value || undefined })}><option value="">Any</option>{db.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Printer"><Select value={f.printerId} onChange={(e) => setF({ ...f, printerId: e.target.value })}>{db.printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Button variant="primary" onClick={() => run((d) => { d.printRules.push({ ...f, id: 'PRL' + (d.printRules.length + 20) }); }, { ok: 'Rule added', perm: 'printing:edit' })}><Tx>Add rule</Tx></Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Templates() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('printing:edit');
  const [paper, setPaper] = useState<'58mm' | '80mm'>('80mm');
  const [f, setF] = useState({ name: db.org.name, address: db.org.address, taxId: db.org.taxId, phone: db.org.phone, receiptFooter: db.org.receiptFooter });
  const lastPos = [...db.orders].reverse().find((o) => o.channel === 'POS');
  const doc = useMemo(() => {
    if (!lastPos) return null;
    const d = renderDoc({ ...db, org: { ...db.org, ...f } }, 'receipt', lastPos.id, { paper });
    return d;
  }, [db, f, paper, lastPos]);
  return (
    <div className="grid g2">
      <Card title="Receipt template">
        <div className="col">
          <Field label="Shop name"><Input value={f.name} disabled={!canEdit} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Address"><Input value={f.address} disabled={!canEdit} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <div className="form-grid"><Field label="Tax ID"><Input value={f.taxId} disabled={!canEdit} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field><Field label="Phone"><Input value={f.phone} disabled={!canEdit} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field></div>
          <Field label="Footer message"><Textarea style={{ minHeight: 50 }} value={f.receiptFooter} disabled={!canEdit} onChange={(e) => setF({ ...f, receiptFooter: e.target.value })} /></Field>
          <div className="row"><Button variant="primary" disabled={!canEdit} onClick={() => run((d, c) => updateOrg(d, c, f), { ok: 'Template saved', perm: 'printing:edit' })}><Tx>Save template</Tx></Button>
            {doc && <Button onClick={() => printDoc(doc)}><PrinterIcon size={15} />{' '}<Tx>Print test page</Tx></Button>}</div>
          <div className="muted" style={{ fontSize: 12 }}><Tx>Document types supported:</Tx>{' '}{Object.values(DOC_LABEL).join(', ')}<Tx>. Thermal widths 58 mm / 80 mm and A4 are built in; templates render from the same data for preview, browser print and the agent.</Tx></div>
        </div>
      </Card>
      <Card title="Live preview" actions={<Seg value={paper} onChange={setPaper} options={[{ v: '58mm', label: '58 mm' }, { v: '80mm', label: '80 mm' }]} />}>
        {doc ? <div style={{ background: 'var(--surface-3)', padding: 14, borderRadius: 12 }}><DocPreview doc={doc} /></div> : <Empty title="Make a POS sale to preview a receipt" />}
      </Card>
    </div>
  );
}
export const _pr = [markPrinted, enqueueJob];
