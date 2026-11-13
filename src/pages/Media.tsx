import { useMemo, useRef, useState } from 'react';
import { Download, Eye, FileText, ShieldAlert, Upload } from 'lucide-react';
import { useDB, toast } from '../domain/store';
import { Badge, Banner, Button, Card, DataTable, Empty, Kpi, Modal, PageHead, Select, Tabs, useHas, Tx } from '../ui/kit';
import { MediaImg, useMediaSrc } from '../ui/shared';
import { signedUrl, uploadMedia } from '../ui/upload';
import { retentionYears } from '../lib/media';
import { addDays, dateFmt, dateTimeFmt } from '../lib/util';
import type { ID, MediaFile } from '../domain/types';

const KINDS: { v: MediaFile['kind']; label: string }[] = [
  { v: 'product_image', label: 'Product image' }, { v: 'customer_upload', label: 'Customer upload' }, { v: 'payment_slip', label: 'Payment slip' }, { v: 'supplier_doc', label: 'Supplier document' },
  { v: 'purchase_invoice', label: 'Purchase invoice' }, { v: 'accounting_doc', label: 'Accounting document' }, { v: 'production_image', label: 'Production image' }, { v: 'event_image', label: 'Event image' },
];
export default function Media() {
  const db = useDB();
  const canCreate = useHas('media:create');
  const canDownload = useHas('media:download') || useHas('media:*');
  const [tab, setTab] = useState<'files' | 'access' | 'policy'>('files');
  const [kind, setKind] = useState('');
  const [upKind, setUpKind] = useState<MediaFile['kind']>('purchase_invoice');
  const [view, setView] = useState<ID | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => db.media.filter((m) => !kind || m.kind === kind).slice().reverse(), [db.media, kind]);
  const m = view ? db.media.find((x) => x.id === view) : undefined;
  const total = db.media.reduce((s, x) => s + x.size, 0);
  return (
    <>
      <PageHead title="Media & documents" desc="Files live in object storage (Cloudflare R2 in production; IndexedDB in this prototype). Only metadata and links are stored in the database. Private by default, with signed short-lived access and an access log." />
      <div className="grid g4 mb16">
        <Kpi label="Files" value={db.media.length} sub={`${(total / 1048576).toFixed(1)} MB`} />
        <Kpi label="Private" value={db.media.filter((x) => x.private).length} sub="slips, invoices, uploads" />
        <Kpi label="Quarantined" value={db.media.filter((x) => x.status === 'quarantined').length} tone={db.media.some((x) => x.status === 'quarantined') ? 'bad' : 'good'} sub="failed scan" />
        <Kpi label="Access events" value={db.mediaAccess.length} sub="signed-URL log" />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'files', label: 'Files' }, { v: 'access', label: 'Access log', count: db.mediaAccess.length || '' }, { v: 'policy', label: 'Security & retention' }]} />
      {tab === 'files' && (
        <>
          {canCreate && (
            <Card className="mb16" title="Upload a document">
              <div className="row wrap">
                <Select style={{ width: 220 }} value={upKind} onChange={(e) => setUpKind(e.target.value as MediaFile['kind'])}>{KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}</Select>
                <input ref={file} type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy(true); try { await uploadMedia(f, upKind); toast('success', `${f.name} stored — scanning…`); } catch (err) { toast('error', (err as Error).message); } setBusy(false); }} />
                <Button variant="primary" onClick={() => file.current?.click()}><Upload size={15} /> {busy ? <Tx>{'Processing…'}</Tx> : <Tx>{'Choose file'}</Tx>}</Button>
                <span className="muted" style={{ fontSize: 12 }}><Tx>JPEG / PNG / WebP / PDF, ≤ 8 MB. The real file type is detected from its bytes; disguised files are rejected; exact duplicates of slips/invoices are blocked.</Tx></span>
              </div>
            </Card>
          )}
          <Card flush>
            <DataTable rows={rows} rowKey={(x) => x.id} pageSize={12} search={(x) => x.name + x.kind} empty={<Empty title="No files yet" />}
              toolbar={<Select sm style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option>{KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}</Select>}
              cols={[
                { key: 'i', header: '', width: 56, render: (x) => (x.mime.startsWith('image') ? <MediaImg m={x.private ? undefined : x} size={40} fallback="🔒" /> : <span className="img-thumb" style={{ width: 40, height: 40 }}><FileText size={18} /></span>) },
                { key: 'n', header: 'File', render: (x) => <><b>{x.name}</b><div className="sub"><Tx>{KINDS.find((k) => k.v === x.kind)?.label}</Tx> · {(x.size / 1024).toFixed(0)}{' '}<Tx>KB ·</Tx>{' '}{x.mime}</div></> },
                { key: 'st', header: 'Status', render: (x) => <Badge tone={x.status === 'available' ? 'good' : x.status === 'scanning' ? 'warn' : 'bad'} dot>{x.status}</Badge> },
                { key: 'p', header: 'Access', hideSm: true, render: (x) => (x.private ? <Badge tone="info"><Tx>private</Tx></Badge> : <Badge><Tx>public</Tx></Badge>) },
                { key: 'c', header: 'SHA-256', hideSm: true, render: (x) => <span className="mono muted">{x.checksum.slice(0, 12)}…</span> },
                { key: 'd', header: 'Uploaded', hideSm: true, render: (x) => dateFmt(x.createdAt) },
                { key: 'a', header: '', render: (x) => <Button size="sm" onClick={() => setView(x.id)}><Tx>Open</Tx></Button> },
              ]} />
          </Card>
        </>
      )}
      {tab === 'access' && (
        <Card flush><DataTable rows={[...db.mediaAccess].reverse()} rowKey={(a) => a.id} pageSize={14} empty={<Empty icon={<Eye size={22} />} title="No access events" hint="Every open of a private file through a signed URL is recorded here." />}
          cols={[{ key: 't', header: 'When', render: (a) => dateTimeFmt(a.ts) }, { key: 'u', header: 'User', render: (a) => db.users.find((u) => u.id === a.userId)?.name }, { key: 'f', header: 'File', render: (a) => db.media.find((x) => x.id === a.mediaId)?.name }, { key: 'x', header: 'Action', render: (a) => <Badge>{a.action}</Badge> }]} /></Card>
      )}
      {tab === 'policy' && (
        <div className="grid g2">
          <Card title="Security controls"><div className="col gap-6">{['Private by default (slips, invoices, uploads)', 'Stable media IDs & storage keys — no hard-coded public URLs', 'Signed URLs that expire after 60 seconds; every access logged', 'Real content-type detection from file bytes; MIME/extension mismatch rejected', 'Size limit 8 MB; image optimisation to WebP + thumbnails in a background job', 'Malware scan before availability (prototype detects the EICAR test signature)', 'Organization-level isolation; encryption in transit & at rest (storage layer)', 'A slip image alone never confirms a payment — review & approval are separate steps'].map((t) => <div key={t} className="row gap-6"><ShieldAlert size={14} color="var(--good)" /><Tx>{t}</Tx></div>)}</div></Card>
          <Card title="Retention (proposed — needs owner approval)" flush><table className="t compact"><thead><tr><th><Tx>Type</Tx></th><th className="num"><Tx>Keep</Tx></th></tr></thead><tbody>{KINDS.map((k) => <tr key={k.v}><td><Tx>{k.label}</Tx></td><td className="num">{retentionYears[k.v] ? <Tx vars={{ n: retentionYears[k.v] }}>{'{n} years'}</Tx> : <Tx>{'while product exists'}</Tx>}</td></tr>)}</tbody></table></Card>
        </div>
      )}
      {m && <FileModal m={m} canDownload={canDownload} onClose={() => setView(null)} />}
    </>
  );
}

function FileModal({ m, onClose, canDownload }: { m: MediaFile; onClose: () => void; canDownload: boolean }) {
  const src = useMediaSrc(m.private ? undefined : m, 'web');
  const [url, setUrl] = useState<string | null>(null);
  const [exp, setExp] = useState(0);
  return (
    <Modal title={m.name} size="lg" onClose={onClose} footer={canDownload && m.status !== 'quarantined' ? <Button variant="primary" onClick={async () => { const u = await signedUrl(m.id, 'view'); if (!u) { toast('error', 'File is not available'); return; } setUrl(u); setExp(Date.now() + 60000); }}><Eye size={15} />{' '}<Tx>Generate signed link (60 s)</Tx></Button> : undefined}>
      <div className="grid g2">
        <div style={{ background: 'var(--surface-3)', borderRadius: 12, padding: 12, display: 'grid', placeItems: 'center', minHeight: 220 }}>
          {m.mime.startsWith('image') ? (m.private && !url ? <div className="muted center"><ShieldAlert size={28} /><div><Tx>Private file — generate a signed link to view.</Tx></div></div> : <img src={url ?? src ?? m.dataUrl} alt={m.name} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8 }} />) : (m.private && !url ? <div className="muted center"><Tx>Private PDF — generate a signed link.</Tx></div> : <a href={url ?? '#'} target="_blank" rel="noreferrer"><Tx>Open PDF</Tx></a>)}
        </div>
        <div className="col gap-6">
          <div className="row between"><span className="muted"><Tx>Status</Tx></span><Badge tone={m.status === 'available' ? 'good' : m.status === 'scanning' ? 'warn' : 'bad'} dot>{m.status}</Badge></div>
          <div className="row between"><span className="muted"><Tx>Type</Tx></span><span>{m.mime}</span></div><div className="row between"><span className="muted"><Tx>Size</Tx></span><span>{(m.size / 1024).toFixed(1)}{' '}<Tx>KB</Tx></span></div>
          {m.width && <div className="row between"><span className="muted"><Tx>Dimensions</Tx></span><span>{m.width}×{m.height}</span></div>}
          <div className="row between"><span className="muted"><Tx>Variants</Tx></span><span>{m.variants.map((v) => `${v.name} ${v.width}px`).join(', ') || '–'}</span></div>
          <div className="row between"><span className="muted"><Tx>SHA-256</Tx></span><span className="mono">{m.checksum.slice(0, 16)}…</span></div>
          <div className="row between"><span className="muted"><Tx>Retain until</Tx></span><span>{retentionYears[m.kind] ? dateFmt(addDays(m.createdAt, retentionYears[m.kind] * 365).toISOString()) : 'n/a'}</span></div>
          {m.scanNote && <Banner tone={m.status === 'quarantined' ? 'bad' : 'info'}>{m.scanNote}</Banner>}
          {url && <Banner tone="good"><Tx>Signed link active until</Tx>{' '}{new Date(exp).toLocaleTimeString()}{' '}<Tx>(access logged).</Tx>{' '}<a href={url} download={m.name}><Download size={12} />{' '}<Tx>Download</Tx></a></Banner>}
        </div>
      </div>
    </Modal>
  );
}
