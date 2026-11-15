// Issue Detail sections for the back office: A) the original feedback, B) the English version, C) evidence & attachments.
// The original description is shown exactly as written and is never edited here. The English version is a separate column (english_context): a plain
// translation made on THIS computer with the browser's built-in translator (free, no key, nothing is sent anywhere), or typed by hand by staff.
// It can be copied for Claude Code or any other developer tool.
import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Languages, Paperclip, PenLine } from 'lucide-react';
import {
  FeedbackAttachment, FeedbackIssue, attachmentsForCopy, contextWithAttachments, detectLanguage, englishContextCopy, parseContext, setEnglishContext,
} from '../lib/feedbackApi';
import { TranslatorState, googleTranslateUrl, translateInBrowser, translatorState } from '../lib/feedbackTranslate';
import { copyText } from '../wallet/bank';
import { dateTimeFmt } from '../lib/util';
import { t } from '../lib/i18n';
import { toast, useLang } from '../domain/store';
import { Badge, Banner, Button, Card, KV, Textarea, useConfirm } from './kit';
import { AttachmentList } from './feedbackParts';

const LANG_LABEL = { th: 'Thai', en: 'English', mixed: 'Thai and English', unknown: '—' } as const;

/** Section A: what the reporter wrote, untouched, with the facts that identify the report. */
export function OriginalFeedbackCard({ issue }: { issue: FeedbackIssue }) {
  const lang = useLang();
  return (
    <Card title="Original feedback" sub="Exactly as the reporter wrote it. This text is never changed.">
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} data-testid="original-description">{issue.description}</div>
      {issue.remark && <div className="muted mt8" style={{ whiteSpace: 'pre-wrap' }}>{issue.remark}</div>}
      <div className="mt8">
        <KV items={[
          ['Original language', t(lang, LANG_LABEL[detectLanguage(`${issue.title} ${issue.description}`)])],
          ['Reporter', `${issue.submitter_label} (${t(lang, issue.source === 'customer' ? 'Customer' : 'Staff')})`],
          ['Submitted on', dateTimeFmt(issue.created_at)],
        ]} />
      </div>
    </Card>
  );
}

/** Section C: the screenshots and files that came with the report. */
export function EvidenceCard({ attachments, loading }: { attachments: FeedbackAttachment[]; loading: boolean }) {
  const lang = useLang();
  return (
    <Card title="Evidence & attachments" sub={loading ? undefined : t(lang, '{n} file(s) attached to the original report', { n: attachments.length })}>
      {loading ? <div className="center" style={{ padding: 12 }}><div className="spinner" /></div>
        : attachments.length ? <AttachmentList items={attachments} evidence />
          : <div className="muted"><Paperclip size={13} style={{ verticalAlign: -2 }} /> {t(lang, 'No screenshots or files were attached.')}</div>}
    </Card>
  );
}

/** Section B: the English version, with Translate / Copy / Edit. */
export function EnglishContextCard({ issue, attachments, onChanged }: { issue: FeedbackIssue; attachments: FeedbackAttachment[]; onChanged: () => void }) {
  const lang = useLang();
  const confirm = useConfirm();
  const [support, setSupport] = useState<TranslatorState | null>(null);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const text = issue.english_context ?? '';
  const hasText = text.trim() !== '';
  const sections = parseContext(text);
  const status = working ? 'processing' : hasText ? 'completed' : localError ? 'failed' : 'pending';

  useEffect(() => { let on = true; translatorState().then((s) => { if (on) setSupport(s); }); return () => { on = false; }; }, []);

  // translate and save: one action. The browser only downloads the Thai language pack right after a click, so the first time needs the button.
  const translate = async () => {
    setWorking(true); setLocalError(null); setProgress(null);
    try {
      const english = await translateInBrowser({ title: issue.title, description: issue.description }, (f) => setProgress(f));
      await setEnglishContext(issue.id, english, 'translation');
      toast('success', t(lang, 'Translated and saved'));
      onChanged();
    } catch (e) { setLocalError((e as Error).message || 'The translation failed'); }
    finally { setWorking(false); setProgress(null); }
  };
  const translateRef = useRef(translate);
  translateRef.current = translate;

  // when the language pack is already on this computer no click is needed: translate an untranslated issue as soon as staff open it
  const autoTried = useRef<string | null>(null);
  useEffect(() => {
    if (support !== 'available' || hasText || autoTried.current === issue.id) return;
    autoTried.current = issue.id;
    void translateRef.current();
  }, [support, hasText, issue.id]);

  const retranslate = async () => {
    if (hasText && issue.english_context_source === 'manual') {
      const r = await confirm({ title: t(lang, 'Replace the text staff wrote?'), body: t(lang, 'Translating again overwrites the English text that staff typed. The original feedback is not changed.'), confirmLabel: t(lang, 'Translate again') });
      if (!r.ok) return;
    }
    await translate();
  };

  const finishCopy = (ok: boolean, okText: string, copied: string) => {
    if (ok) { toast('success', okText); setManualCopy(null); } else { toast('error', t(lang, 'Could not copy automatically — the text is shown below so you can copy it by hand.')); setManualCopy(copied); }
  };
  const copyContext = async () => { const s = englishContextCopy(issue); finishCopy(await copyText(s), t(lang, 'English text copied to the clipboard'), s); };
  const copyWithFiles = async () => {
    setCopying(true);
    try {
      const atts = await attachmentsForCopy(attachments);
      const s = contextWithAttachments(issue, atts);
      finishCopy(await copyText(s), t(lang, 'Copied the English text and {n} attachment link(s). Images are linked, not embedded.', { n: atts.length }), s);
    } finally { setCopying(false); }
  };

  const save = async () => {
    setSaving(true);
    try { await setEnglishContext(issue.id, draft); toast('success', t(lang, 'English text saved')); setEditing(false); onChanged(); }
    catch (e) { toast('error', (e as Error).message); }
    finally { setSaving(false); }
  };

  const badge = status === 'completed' ? <Badge tone="good" dot>{t(lang, 'Ready')}</Badge>
    : status === 'processing' ? <Badge tone="warn" dot>{t(lang, 'Translating…')}</Badge>
      : status === 'failed' ? <Badge tone="bad" dot>{t(lang, 'Failed')}</Badge>
        : <Badge tone="info" dot>{t(lang, 'Not translated yet')}</Badge>;
  const sourceLabel = !hasText ? null
    : issue.english_context_source === 'translation' ? t(lang, 'Translated on this computer')
      : issue.english_context_source === 'ai' ? `${t(lang, 'Generated by AI')}${issue.english_context_model ? ` · ${issue.english_context_model}` : ''}`
        : t(lang, 'Written by hand');
  const cannotTranslate = support === 'unsupported' || support === 'unavailable';
  const original = `${issue.title}\n\n${issue.description}`;

  return (
    <Card title="English version" sub="A plain English translation of the report, made on this computer. The original feedback above is not changed." actions={<span data-testid="ctx-status" data-status={status}>{badge}</span>}>
      <div className="col gap-8">
        {status === 'failed' && <div data-testid="ctx-error"><Banner tone="bad">{`${t(lang, 'The translation did not work')}: ${t(lang, localError ?? '')}`}</Banner></div>}
        {status === 'processing' && (
          <div className="row gap-6 muted" style={{ fontSize: 13 }} data-testid="ctx-working">
            <div className="spinner" style={{ width: 14, height: 14 }} />
            {progress !== null && progress < 1 ? t(lang, 'Downloading the Thai language pack to this computer… {n}%', { n: Math.round(progress * 100) }) : t(lang, 'Translating…')}
          </div>
        )}
        {!hasText && !working && cannotTranslate && (
          <div data-testid="ctx-unsupported">
            <Banner tone="warn">{t(lang, 'This browser cannot translate on the computer (it needs Chrome 138 or newer, on a computer). You can write the English text by hand, or open the report in Google Translate and paste the result.')}</Banner>
          </div>
        )}
        {!hasText && !working && !cannotTranslate && status === 'pending' && <div className="muted" data-testid="ctx-pending">{t(lang, 'There is no English version of this report yet.')}</div>}

        {editing ? (
          <>
            <Textarea rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="ctx-editor" />
            <div className="muted" style={{ fontSize: 12 }}>{t(lang, 'Write only what the report says.')}</div>
            <div className="row gap-6">
              <Button variant="primary" size="sm" loading={saving} disabled={!draft.trim() || saving} onClick={save} data-testid="ctx-save">{t(lang, 'Save English text')}</Button>
              <Button size="sm" disabled={saving} onClick={() => setEditing(false)}>{t(lang, 'Cancel')}</Button>
            </div>
          </>
        ) : hasText && (
          <div data-testid="ctx-text" style={{ overflowWrap: 'anywhere' }}>
            {sourceLabel && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{sourceLabel}{issue.english_context_at ? ` · ${dateTimeFmt(issue.english_context_at)}` : ''}</div>}
            {sections ? sections.map((s) => (
              <div key={s.title} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11.5, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.03em' }} className="muted">{s.title}</div>
                <div style={{ whiteSpace: 'pre-wrap' }} className={s.body === 'Not provided' ? 'muted' : undefined}>{s.body || 'Not provided'}</div>
              </div>
            )) : <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>}
          </div>
        )}

        {!editing && (
          <div className="row wrap" style={{ gap: 8 }}>
            {!cannotTranslate && (
              <Button size="sm" variant={hasText ? undefined : 'primary'} disabled={working || support === null} loading={working} onClick={hasText ? retranslate : translate} data-testid="ctx-translate">
                <Languages size={13} />{' '}{t(lang, hasText ? 'Translate again' : 'Translate to English')}
              </Button>
            )}
            <Button size="sm" variant={hasText ? 'primary' : undefined} disabled={!hasText || working} onClick={copyContext} data-testid="ctx-copy"><Copy size={13} />{' '}{t(lang, 'Copy English Context')}</Button>
            <Button size="sm" disabled={!hasText || working || copying} loading={copying} onClick={copyWithFiles} data-testid="ctx-copy-files"><Paperclip size={13} />{' '}{t(lang, 'Copy Context + Attachments')}</Button>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => { setDraft(hasText ? text : ''); setEditing(true); }} data-testid="ctx-edit"><PenLine size={13} />{' '}{t(lang, hasText ? 'Edit' : 'Write by hand')}</Button>
            {!hasText && cannotTranslate && (
              <a className="btn ghost sm" href={googleTranslateUrl(original)} target="_blank" rel="noopener noreferrer" data-testid="ctx-google"><ExternalLink size={13} /> {t(lang, 'Open in Google Translate')}</a>
            )}
          </div>
        )}
        {!editing && !hasText && !cannotTranslate && support === 'downloadable' && !working && <div className="muted" style={{ fontSize: 12 }}>{t(lang, 'The first time, the browser downloads the Thai language pack to this computer (one time only). Nothing is sent to any server.')}</div>}
        {!editing && hasText && <div className="muted" style={{ fontSize: 12 }}>{t(lang, 'Attachment links are private, expire after 24 hours, and the images are not embedded in the copied text.')}</div>}
        {manualCopy !== null && <Textarea readOnly rows={8} value={manualCopy} onFocus={(e) => e.currentTarget.select()} data-testid="ctx-manual-copy" />}
      </div>
    </Card>
  );
}
