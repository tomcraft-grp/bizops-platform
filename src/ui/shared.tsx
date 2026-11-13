import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Printer, Search, UserPlus } from 'lucide-react';
import type { DB, DocType, ID, MediaFile } from '../domain/types';
import { Block, PrintDoc, renderDoc } from '../domain/printing';
import { qrSvg, printDoc, downloadDocHtml } from '../lib/print';
import { Badge, Button, Empty, Field, Input, Modal, Select, useRun, SearchBox, Tx } from './kit';
import { useDB, useLang } from '../domain/store';
import { addCustomer, linkLineMember } from '../domain/master';
import { supabase } from '../lib/supabase';
import { customerLifetimeSpend, pointsBalance, tierFor } from '../domain/loyalty';
import { customerCredit, customerOutstanding } from '../domain/payments';
import { loadMediaUrl } from '../lib/media';
import { cx, money } from '../lib/util';
import { enqueueJob, markPrinted } from '../domain/printing';
import { t as tl } from '../lib/i18n';

export function QR({ data, size = 140 }: { data: string; size?: number }) {
  const lang = useLang();
  const [svg, setSvg] = useState('');
  useEffect(() => { let on = true; qrSvg(data, size).then((s) => on && setSvg(s)).catch(() => undefined); return () => { on = false; }; }, [data, size]);
  return <div className="qr-box" style={{ width: size, height: size, background: '#fff', padding: 6, borderRadius: 8, display: 'inline-block', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label={tl(lang, 'QR code')} />;
}

export function DocPreview({ doc }: { doc: PrintDoc }) {
  const cls = doc.paper === '58mm' ? 'w58' : doc.paper === '80mm' ? 'w80' : 'wA4';
  return (
    <div className={cx('receipt-paper', cls)}>
      {doc.blocks.map((b, i) => <BlockView key={i} b={b} />)}
    </div>
  );
}
function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'title': return <div style={{ marginBottom: 8 }}><div style={{ fontSize: 20, fontWeight: 700 }}>{b.text}</div>{b.sub && <div style={{ color: '#666' }}>{b.sub}</div>}</div>;
    case 'center': return <div style={{ textAlign: 'center', fontWeight: b.bold ? 700 : 400, fontSize: b.big ? 15 : undefined }}>{b.text}</div>;
    case 'text': return <div style={{ fontWeight: b.bold ? 700 : 400 }}>{b.text}</div>;
    case 'row': return <div className="r-row" style={{ fontWeight: b.bold ? 700 : 400 }}><span>{b.l}</span><span>{b.r}</span></div>;
    case 'hr': return <hr />;
    case 'blank': return <br />;
    case 'qr': return <div style={{ textAlign: 'center', margin: '6px 0' }}><QR data={b.data} size={96} /></div>;
    case 'table': return (
      <table><thead><tr>{b.head.map((h, i) => <th key={i} style={{ textAlign: b.align?.[i] === 'r' ? 'right' : b.align?.[i] === 'c' ? 'center' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ textAlign: b.align?.[j] === 'r' ? 'right' : b.align?.[j] === 'c' ? 'center' : 'left' }}>{c}</td>)}</tr>)}</tbody></table>
    );
  }
}

/** Modal that previews a document and prints it through the browser (real window.print) */
export function PrintModal({ docType, refId, onClose, station, jobId, title }: { docType: DocType; refId: ID; onClose: () => void; station?: 'kitchen' | 'beverage'; jobId?: ID; title?: string }) {
  const db = useDB();
  const run = useRun();
  const doc = useMemo(() => { try { return renderDoc(db, docType, refId, { station }); } catch { return null; } }, [db, docType, refId, station]);
  const [paper, setPaper] = useState<'58mm' | '80mm' | 'A4' | ''>('');
  const eff = useMemo(() => (doc && paper ? { ...doc, paper } : doc), [doc, paper]);
  if (!eff) return <Modal title="Document unavailable" onClose={onClose}><Empty title="This document could not be rendered" /></Modal>;
  return (
    <Modal title={title ?? eff.title} size={eff.paper === 'A4' ? 'lg' : undefined} onClose={onClose}
      footer={<>
        {eff.paper !== 'A4' && <Select sm style={{ width: 110 }} value={paper || eff.paper} onChange={(e) => setPaper(e.target.value as '58mm' | '80mm')}><option value="58mm">58 mm</option><option value="80mm">80 mm</option></Select>}
        <Button onClick={() => downloadDocHtml(eff)}><Tx>Save as HTML/PDF</Tx></Button>
        <Button variant="primary" onClick={async () => { await printDoc(eff); if (jobId) run((d, c) => markPrinted(d, c, jobId)); }}><Printer size={16} />{' '}<Tx>Print</Tx></Button>
      </>}>
      <div style={{ background: 'var(--surface-3)', padding: 16, borderRadius: 12 }}><DocPreview doc={eff} /></div>
    </Modal>
  );
}
export function usePrintDoc() {
  const [st, setSt] = useState<{ docType: DocType; refId: ID; station?: 'kitchen' | 'beverage' } | null>(null);
  return { open: (docType: DocType, refId: ID, station?: 'kitchen' | 'beverage') => setSt({ docType, refId, station }), node: st ? <PrintModal {...st} onClose={() => setSt(null)} /> : null };
}
export const enqueueFromUI = enqueueJob;

// ---------- customer picker
// ---------- LINE members (real, in Supabase `profiles`) at the POS
// Staff type the member's phone number; once it is a full Thai number (9–10 digits) we look it up among LINE
// members. RLS lets ADMIN/SUPER_ADMIN read profiles. Picking a hit links it to a local customer record
// (created on first use) so the existing POS/loyalty engine can be used unchanged.
export interface LineMemberHit { id: string; display_name: string | null; phone: string; line_user_id: string }

function useLineMemberLookup(q: string) {
  const [state, setState] = useState<{ hits: LineMemberHit[]; searching: boolean; error: string | null }>({ hits: [], searching: false, error: null });
  const digits = q.replace(/\D/g, '');
  const phone = /^0\d{8,9}$/.test(digits) ? digits : null;
  useEffect(() => {
    if (!phone) { setState({ hits: [], searching: false, error: null }); return; }
    let on = true;
    setState((s) => ({ ...s, searching: true, error: null }));
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.from('profiles')
        .select('id, display_name, phone, line_user_id')
        .eq('phone', phone).eq('status', 'active').not('line_user_id', 'is', null).limit(5);
      if (on) setState({ hits: (data ?? []) as LineMemberHit[], searching: false, error: error?.message ?? null });
    }, 250);
    return () => { on = false; clearTimeout(timer); };
  }, [phone]);
  return state;
}

export function CustomerPicker({ onPick, onClose, allowNone }: { onPick: (id: ID | undefined) => void; onClose: () => void; allowNone?: boolean }) {
  const lang = useLang();
  const db = useDB();
  const run = useRun();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', phone: '' });
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/[\s-]/g, '');
    return db.customers.filter((c) => !s || (c.name + c.phone + c.code).toLowerCase().includes(s) || (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits))).slice(0, 40);
  }, [db.customers, q]);
  const line = useLineMemberLookup(q);
  // A LINE member already linked to a local record shows up in `list` (with a LINE badge); don't list it twice.
  const lineHits = line.hits.filter((m) => !db.customers.some((c) => c.lineUserId === m.line_user_id));
  const pickLine = (m: LineMemberHit) => run((d, c) => linkLineMember(d, c, { lineUserId: m.line_user_id, name: m.display_name, phone: m.phone }), { onOk: (id) => onPick(id) });
  return (
    <Modal title="Select customer" onClose={onClose} footer={allowNone ? <Button onClick={() => onPick(undefined)}><Tx>Walk-in (no customer)</Tx></Button> : undefined}>
      {!adding ? (
        <>
          <div className="row"><div className="grow"><SearchBox value={q} onChange={setQ} placeholder="Name, phone or member code" /></div><Button onClick={() => setAdding(true)}><UserPlus size={16} />{' '}<Tx>New</Tx></Button></div>
          <div className="col gap-4 mt8" style={{ maxHeight: 380, overflow: 'auto' }}>
            {lineHits.map((m) => (
              <button key={m.id} className="menu-item" onClick={() => pickLine(m)}>
                <div className="grow"><div style={{ fontWeight: 600 }}>{m.display_name ?? '—'}</div><div className="muted" style={{ fontSize: 12 }}>{m.phone}</div></div>
                <Badge tone="good">สมาชิก LINE</Badge>
              </button>
            ))}
            {line.searching && <div className="muted" style={{ fontSize: 12, padding: '2px 4px' }}>กำลังค้นหาสมาชิก LINE…</div>}
            {line.error && <div className="muted" style={{ fontSize: 12, padding: '2px 4px' }}>ค้นหาสมาชิก LINE ไม่ได้: {line.error}</div>}
            {list.map((c) => {
              const t = tierFor(db, customerLifetimeSpend(db, c.id));
              return (
                <button key={c.id} className="menu-item" onClick={() => onPick(c.id)}>
                  <div className="grow"><div style={{ fontWeight: 600 }}>{c.name}{c.lineUserId && <>{' '}<Badge tone="good">LINE</Badge></>}</div><div className="muted" style={{ fontSize: 12 }}>{c.code} · {c.phone}</div></div>
                  <div style={{ textAlign: 'right', fontSize: 12 }}><Badge tone={c.group === 'wholesale' ? 'info' : ''}>{c.group === 'wholesale' ? <Tx>{'Wholesale'}</Tx> : t.name}</Badge><div className="muted">{pointsBalance(db, c.id)}{' '}<Tx>pts</Tx></div></div>
                </button>
              );
            })}
            {!list.length && !lineHits.length && !line.searching && <Empty title="No customer found" hint="Create a new customer with the button above." />}
          </div>
        </>
      ) : (
        <div className="col">
          <Field label="Name"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder={tl(lang, '08x-xxx-xxxx')} /></Field>
          <div className="row"><Button onClick={() => setAdding(false)}><Tx>Back</Tx></Button><Button variant="primary" onClick={() => run((d, c) => addCustomer(d, c, { name: f.name, phone: f.phone, marketing: false }), { ok: 'Customer created', onOk: (id) => onPick(id) })}><Tx>Create & select</Tx></Button></div>
        </div>
      )}
    </Modal>
  );
}
export function CustomerSummary({ id }: { id: ID }) {
  const db = useDB();
  const c = db.customers.find((x) => x.id === id);
  if (!c) return null;
  const t = tierFor(db, customerLifetimeSpend(db, c.id));
  const out = customerOutstanding(db, id);
  const cred = customerCredit(db, id);
  return (
    <div className="row wrap gap-6" style={{ fontSize: 12 }}>
      <Badge tone="info">{c.group === 'wholesale' ? <Tx>{'Wholesale'}</Tx> : t.name}</Badge>
      <span className="chip">{pointsBalance(db, id).toLocaleString()}{' '}<Tx>pts</Tx></span>
      {out > 0 && <span className="chip" style={{ color: 'var(--crit-text)' }}><Tx>Owes</Tx>{' '}{money(out)}</span>}
      {cred > 0 && <span className="chip" style={{ color: 'var(--good-text)' }}><Tx>Credit</Tx>{' '}{money(cred)}</span>}
    </div>
  );
}

// ---------- media image
export function useMediaSrc(m?: MediaFile, variant: 'thumb' | 'web' | 'original' = 'web') {
  const [src, setSrc] = useState<string | null>(m?.dataUrl ?? null);
  useEffect(() => {
    let url: string | null = null;
    let on = true;
    if (!m) { setSrc(null); return; }
    loadMediaUrl(m, variant).then((u) => { url = u; if (on) setSrc(u); });
    return () => { on = false; if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [m?.id, m?.dataUrl, variant]); // eslint-disable-line react-hooks/exhaustive-deps
  return src;
}
export function MediaImg({ m, variant = 'thumb', size = 44, fallback }: { m?: MediaFile; variant?: 'thumb' | 'web'; size?: number; fallback?: ReactNode }) {
  const src = useMediaSrc(m, variant);
  if (!m || !src) return <span className="img-thumb" style={{ width: size, height: size }}>{fallback}</span>;
  return <img className="img-thumb" style={{ width: size, height: size }} src={src} alt={m.name} />;
}

export function ProductEmoji({ p, size = 40 }: { p: DB['products'][number]; size?: number }) {
  const db = useDB();
  const main = p.mediaIds.length ? db.media.find((m) => m.id === p.mediaIds[0] && m.status === 'available') : undefined;
  if (main) return <MediaImg m={main} size={size} />;
  return <span className="img-thumb" style={{ width: size, height: size, background: p.color + '22', fontSize: size * 0.5 }}>{p.emoji}</span>;
}
export const _search = Search;
