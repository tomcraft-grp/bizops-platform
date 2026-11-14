// Small building blocks shared by the customer feedback screens and the back-office issue workspace.
import { DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Download, FileText, Paperclip, X, ZoomIn } from 'lucide-react';
import { useLang } from '../domain/store';
import { t } from '../lib/i18n';
import {
  ATTACHMENT_ACCEPT, FeedbackAttachment, MAX_ATTACHMENTS, attachmentUrl, categoryMeta, checkAttachment, priorityMeta, statusMeta,
} from '../lib/feedbackApi';
import { clipboardHasText, clipboardImages, prepareImage } from '../lib/feedbackImages';
import { dateFmt } from '../lib/util';
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

const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const uploadedAt = (iso: string) => `${dateFmt(iso)}, ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`;

/** Full-size preview of a picture. Esc closes only the preview (not the form or drawer underneath it). */
export function ImageLightbox({ src, name, onClose, onDownload }: { src: string; name: string; onClose: () => void; onDownload?: () => void }) {
  const lang = useLang();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', h, true);   // capture: runs before the modal's own Esc handler
    return () => document.removeEventListener('keydown', h, true);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={name} data-testid="image-lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, zIndex: 150, background: 'rgba(0,0,0,.82)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 }}>
      <img src={src} alt={name} style={{ maxWidth: '96vw', maxHeight: '82vh', objectFit: 'contain', borderRadius: 6, background: '#fff' }} />
      <div className="row gap-6" style={{ color: '#fff', fontSize: 13, alignItems: 'center' }}>
        <span style={{ maxWidth: '60vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {onDownload && <button type="button" className="btn sm" onClick={onDownload}><Download size={14} /> {t(lang, 'Download')}</button>}
        <button type="button" className="btn sm" onClick={onClose} aria-label={t(lang, 'Close preview')}><X size={14} /> {t(lang, 'Close preview')}</button>
      </div>
    </div>, document.body);
}

// The most recently mounted picker is the one Ctrl+V belongs to (a form opened on top of a page wins over the page).
const pasteStack: symbol[] = [];

/** Object URLs for the thumbnails of the chosen pictures; each is released as soon as its file is removed. */
function useObjectUrls(files: File[]): string[] {
  const cache = useRef(new Map<File, string>());
  const urls = files.map((f) => {
    if (!f.type.startsWith('image/')) return '';
    let u = cache.current.get(f);
    if (!u) { u = URL.createObjectURL(f); cache.current.set(f, u); }
    return u;
  });
  useEffect(() => {
    cache.current.forEach((u, f) => { if (!files.includes(f)) { URL.revokeObjectURL(u); cache.current.delete(f); } });
  });
  useEffect(() => () => { cache.current.forEach((u) => URL.revokeObjectURL(u)); cache.current.clear(); }, []);
  return urls;
}

/**
 * Screenshot / file chooser: paste with Ctrl+V (Win+Shift+S, then Ctrl+V), drag and drop, or click to browse. Every chosen file gets a thumbnail with
 * its own remove button. Large pictures are resized before they are uploaded; wrong types and sizes are refused up front with a translated message.
 */
export function AttachmentPicker({ files, onChange, disabled }: { files: File[]; onChange: (f: File[]) => void; disabled?: boolean }) {
  const lang = useLang();
  const input = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(0);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const urls = useObjectUrls(files);

  const add = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return;
    setErr(null); setBusy((n) => n + 1);
    const errors: string[] = [];
    try {
      const next = [...filesRef.current];
      for (const original of incoming) {
        if (next.length >= MAX_ATTACHMENTS) { errors.push(t(lang, 'You can attach up to {n} files', { n: MAX_ATTACHMENTS })); break; }
        const f = await prepareImage(original);              // big pictures are shrunk; anything else comes back unchanged
        const bad = checkAttachment(f);
        if (bad) { errors.push(`${original.name}: ${t(lang, bad)}`); continue; }
        next.push(f);
      }
      filesRef.current = next;
      onChange(next);
    } finally { setBusy((n) => n - 1); }
    if (errors.length) setErr(errors[0]);
  }, [lang, onChange]);
  const addRef = useRef(add);
  addRef.current = add;

  // Ctrl+V anywhere in the open form: attach the picture on the clipboard. A clipboard that also holds text (copied from Word, Excel or a web page)
  // is left alone so normal text pasting into the description keeps working.
  useEffect(() => {
    if (disabled) return;
    const id = Symbol('attachment-picker');
    pasteStack.push(id);
    const onPaste = (e: ClipboardEvent) => {
      if (pasteStack[pasteStack.length - 1] !== id) return;
      const imgs = clipboardImages(e.clipboardData);
      if (!imgs.length || clipboardHasText(e.clipboardData)) return;
      e.preventDefault();
      void addRef.current(imgs);
    };
    document.addEventListener('paste', onPaste);
    return () => { document.removeEventListener('paste', onPaste); const i = pasteStack.indexOf(id); if (i >= 0) pasteStack.splice(i, 1); };
  }, [disabled]);

  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (!disabled) void add(Array.from(e.dataTransfer.files)); };
  const remove = (i: number) => { const next = filesRef.current.filter((_, j) => j !== i); filesRef.current = next; setErr(null); onChange(next); };

  return (
    <div className="col gap-6" data-testid="attachment-picker">
      <div role="button" tabIndex={0} aria-disabled={disabled} data-testid="attachment-dropzone"
        onClick={() => !disabled && input.current?.click()} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        style={{ border: `1.5px dashed ${over ? 'var(--accent, #2a78d6)' : 'var(--border)'}`, background: over ? 'var(--surface-2)' : undefined, borderRadius: 10, padding: '12px 10px', textAlign: 'center', cursor: disabled ? 'default' : 'pointer', fontSize: 13 }}
        className="muted">
        <Paperclip size={15} style={{ verticalAlign: -2 }} /> <b style={{ fontWeight: 600 }}>{t(lang, 'Paste your screenshot here (Ctrl+V) or drag and drop images.')}</b>
        <div style={{ fontSize: 12 }}>{t(lang, 'or click here to choose files')}</div>
        <div style={{ fontSize: 11.5 }}>{t(lang, 'PNG, JPG, WebP or PDF · up to 10 MB each · max {n} files', { n: MAX_ATTACHMENTS })} · {t(lang, 'Large pictures are shrunk automatically before upload.')}</div>
      </div>
      <input ref={input} type="file" multiple accept={ATTACHMENT_ACCEPT} hidden data-testid="attachment-input" onChange={(e) => { setErr(null); void add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      {err && <div role="alert" style={{ color: 'var(--bad-text, #b42318)', fontSize: 12 }}>{err}</div>}
      {busy > 0 && <div className="muted" style={{ fontSize: 12 }}>{t(lang, 'Processing image…')}</div>}
      {files.length > 0 && (
        <>
          <div className="row between" style={{ fontSize: 12.5 }}>
            <span role="status" data-testid="attachment-status" className="row gap-6" style={{ color: 'var(--good-text, #067647)', alignItems: 'center' }}><CheckCircle2 size={14} /> {t(lang, '{n} attached', { n: files.length })}</span>
            {files.length > 1 && <button type="button" className="btn ghost sm" disabled={disabled} onClick={() => { filesRef.current = []; setErr(null); onChange([]); }}>{t(lang, 'Remove all')}</button>}
          </div>
          <div className="row wrap" style={{ gap: 10 }}>
            {files.map((f, i) => (
              <div key={`${f.name}-${f.lastModified}-${i}`} data-testid="attachment-thumb" style={{ position: 'relative', width: 84, fontSize: 11 }}>
                {urls[i]
                  ? <button type="button" onClick={() => setPreview({ src: urls[i], name: f.name })} title={t(lang, 'Preview')} aria-label={`${t(lang, 'Preview')}: ${f.name}`}
                      style={{ padding: 0, border: 0, background: 'none', cursor: 'zoom-in', display: 'block' }}>
                      <img src={urls[i]} alt={f.name} style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} />
                    </button>
                  : <div style={{ width: 84, height: 84, borderRadius: 8, border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}><FileText size={26} /></div>}
                <button type="button" aria-label={t(lang, 'Remove {name}', { name: f.name })} data-testid="attachment-remove" disabled={disabled} onClick={() => remove(i)}
                  style={{ position: 'absolute', top: -7, right: -7, width: 22, height: 22, borderRadius: 11, border: '1px solid var(--border)', background: 'var(--surface)', display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0 }}><X size={13} /></button>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</div>
                <div className="muted">{sizeText(f.size)}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {preview && <ImageLightbox src={preview.src} name={preview.name} onClose={() => setPreview(null)} />}
    </div>
  );
}

/**
 * Attachment thumbnails, opened through short-lived signed URLs (the bucket is private). Pictures open in a full-size preview; PDFs in a new tab.
 * `evidence` shows the larger "Evidence & attachments" layout: file name, size, upload date, Preview and Download.
 */
export function AttachmentList({ items, evidence }: { items: FeedbackAttachment[]; evidence?: boolean }) {
  const lang = useLang();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<FeedbackAttachment | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    Promise.all(items.map(async (a) => [a.id, await attachmentUrl(a.storage_path).catch(() => '')] as const))
      .then((pairs) => { if (on) setUrls(Object.fromEntries(pairs)); });
    return () => { on = false; };
  }, [items.map((a) => a.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return null;

  const download = async (a: FeedbackAttachment) => {
    try {
      const url = await attachmentUrl(a.storage_path, { download: a.file_name });
      const link = document.createElement('a');
      link.href = url; link.download = a.file_name; link.rel = 'noopener noreferrer';
      document.body.appendChild(link); link.click(); link.remove();
      setFailed(null);
    } catch { setFailed(a.file_name); }
  };
  const open = (a: FeedbackAttachment) => { if (a.mime_type.startsWith('image/') && urls[a.id]) setPreview(a); else if (urls[a.id]) window.open(urls[a.id], '_blank', 'noopener,noreferrer'); };
  const size = evidence ? 96 : 84;

  return (
    <div className="col gap-6">
      <div data-testid="attachment-list" style={evidence ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 } : { display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((a) => {
          const url = urls[a.id];
          const img = a.mime_type.startsWith('image/');
          const thumb = (
            <button type="button" onClick={() => open(a)} title={a.file_name} aria-label={`${t(lang, 'Preview')}: ${a.file_name}`} disabled={!url}
              style={{ padding: 0, border: 0, background: 'none', cursor: url ? (img ? 'zoom-in' : 'pointer') : 'default', color: 'inherit', flex: 'none' }}>
              {img && url
                ? <img src={url} alt={a.file_name} style={{ width: size, height: size, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} />
                : <div style={{ width: size, height: size, borderRadius: 8, border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}>{url ? <FileText size={26} /> : <span className="muted">{t(lang, 'Loading…')}</span>}</div>}
            </button>
          );
          if (!evidence) {
            return (
              <div key={a.id} data-testid="attachment-item" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: size, fontSize: 11.5, gap: 3 }}>
                {thumb}
                <span style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }} title={a.file_name}>{a.file_name}</span>
              </div>
            );
          }
          // evidence layout: the picture on the left, name / size / upload date / actions on the right (buttons wrap, so they never overlap the next file)
          return (
            <div key={a.id} data-testid="attachment-item" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
              {thumb}
              <div className="col gap-4" style={{ minWidth: 0, flex: 1, fontSize: 12.5 }}>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.file_name}>{a.file_name}</span>
                <span className="muted">{sizeText(a.size_bytes)}</span>
                <span className="muted">{t(lang, 'Uploaded')} {uploadedAt(a.created_at)}</span>
                <span className="row wrap" style={{ gap: 6 }}>
                  <button type="button" className="btn ghost sm" disabled={!url} onClick={() => open(a)}><ZoomIn size={13} /> {t(lang, 'Preview')}</button>
                  <button type="button" className="btn ghost sm" onClick={() => download(a)}><Download size={13} /> {t(lang, 'Download')}</button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {failed && <div role="alert" style={{ color: 'var(--bad-text, #b42318)', fontSize: 12 }}>{t(lang, 'Could not download the file')}: {failed}</div>}
      {preview && urls[preview.id] && <ImageLightbox src={urls[preview.id]} name={preview.file_name} onClose={() => setPreview(null)} onDownload={() => download(preview)} />}
    </div>
  );
}
