// Small building blocks shared by the customer feedback screens and the back-office issue workspace.
import { DragEvent, useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { useLang } from '../domain/store';
import { t } from '../lib/i18n';
import {
  ATTACHMENT_ACCEPT, FeedbackAttachment, MAX_ATTACHMENTS, attachmentUrl, categoryMeta, checkAttachment, priorityMeta, statusMeta,
} from '../lib/feedbackApi';
import { Badge } from './kit';

export function StatusBadge({ status }: { status: string }) {
  const lang = useLang();
  const m = statusMeta(status);
  return <Badge tone={m.tone} dot>{t(lang, m.label)}</Badge>;
}
export function PriorityBadge({ priority }: { priority: string }) {
  const lang = useLang();
  const m = priorityMeta(priority);
  return <Badge tone={m.tone}>{t(lang, m.label)}</Badge>;
}
export function CategoryBadge({ category }: { category: string }) {
  const lang = useLang();
  const m = categoryMeta(category);
  return <Badge tone={m.tone}>{t(lang, m.label)}</Badge>;
}

/** File chooser with drag-and-drop. Rejects wrong types/sizes up front with a translated message. */
export function AttachmentPicker({ files, onChange, disabled }: { files: File[]; onChange: (f: File[]) => void; disabled?: boolean }) {
  const lang = useLang();
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const add = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      const bad = checkAttachment(f);
      if (bad) { setErr(`${f.name}: ${t(lang, bad)}`); continue; }
      if (next.length >= MAX_ATTACHMENTS) { setErr(t(lang, 'You can attach up to {n} files', { n: MAX_ATTACHMENTS })); break; }
      next.push(f);
    }
    onChange(next);
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (!disabled) { setErr(null); add(e.dataTransfer.files); } };
  return (
    <div className="col gap-6">
      <div role="button" tabIndex={0} aria-disabled={disabled}
        onClick={() => !disabled && input.current?.click()} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) input.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        style={{ border: `1.5px dashed ${over ? 'var(--accent, #2a78d6)' : 'var(--border)'}`, borderRadius: 10, padding: '12px 10px', textAlign: 'center', cursor: disabled ? 'default' : 'pointer', fontSize: 13 }}
        className="muted">
        <Paperclip size={15} style={{ verticalAlign: -2 }} /> {t(lang, 'Add screenshots or files (tap or drop here)')}
        <div style={{ fontSize: 11.5 }}>{t(lang, 'PNG, JPG, WebP or PDF · up to 10 MB each · max {n} files', { n: MAX_ATTACHMENTS })}</div>
      </div>
      <input ref={input} type="file" multiple accept={ATTACHMENT_ACCEPT} hidden onChange={(e) => { setErr(null); add(e.target.files); e.target.value = ''; }} />
      {err && <div style={{ color: 'var(--bad-text, #b42318)', fontSize: 12 }}>{err}</div>}
      {files.map((f, i) => (
        <div key={i} className="row between" style={{ fontSize: 13 }}>
          <span className="row gap-6" style={{ minWidth: 0 }}><FileText size={14} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span><span className="muted">{Math.ceil(f.size / 1024)} KB</span></span>
          <button type="button" className="btn ghost sm" aria-label={t(lang, 'Remove')} disabled={disabled} onClick={() => onChange(files.filter((_, j) => j !== i))}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

/** Attachment thumbnails/links, opened through short-lived signed URLs (the bucket is private). */
export function AttachmentList({ items }: { items: FeedbackAttachment[] }) {
  const lang = useLang();
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let on = true;
    Promise.all(items.map(async (a) => [a.id, await attachmentUrl(a.storage_path).catch(() => '')] as const))
      .then((pairs) => { if (on) setUrls(Object.fromEntries(pairs)); });
    return () => { on = false; };
  }, [items.map((a) => a.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return null;
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      {items.map((a) => {
        const url = urls[a.id];
        const img = a.mime_type.startsWith('image/');
        return (
          <a key={a.id} href={url || undefined} target="_blank" rel="noopener noreferrer" title={a.file_name}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 84, fontSize: 11, textDecoration: 'none', color: 'inherit' }}>
            {img && url
              ? <img src={url} alt={a.file_name} style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
              : <div style={{ width: 84, height: 84, borderRadius: 8, border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}><FileText size={26} /></div>}
            <span style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{url ? a.file_name : t(lang, 'Loading…')}</span>
          </a>
        );
      })}
    </div>
  );
}
