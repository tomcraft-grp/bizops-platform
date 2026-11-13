import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MessageSquarePlus } from 'lucide-react';
import { FEEDBACK_CATEGORIES, FEEDBACK_PRIORITIES, FeedbackCategory, FeedbackPriority, submitFeedback } from '../lib/feedbackApi';
import { pageMetaFor } from '../domain/meta';
import { Button, Field, Input, Modal, Select, Textarea } from './kit';
import { AttachmentPicker } from './feedbackParts';
import { toast, useLang } from '../domain/store';
import { t } from '../lib/i18n';

// Global floating feedback button for staff, mounted once in Shell. Page/module context is read from the route,
// not typed by the user. Submissions become issues in the shared Feedback & Issue system (lib/feedbackApi.ts),
// recorded under the signed-in staff account by the server.
export function FeedbackButton() {
  const loc = useLocation();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [priority, setPriority] = useState<FeedbackPriority>('medium');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [idemKey, setIdemKey] = useState('');

  const openModal = () => { setSubject(''); setDesc(''); setCategory('bug'); setPriority('medium'); setFiles([]); setIdemKey(crypto.randomUUID()); setOpen(true); };
  const meta = pageMetaFor(loc.pathname);

  const submit = async () => {
    if (!desc.trim() || busy) return;
    setBusy(true);
    try {
      const { issue, failedFiles } = await submitFeedback({
        category, subject, description: desc, priority, pageName: meta.page, module: meta.module, appId: 'backoffice', idempotencyKey: idemKey, files,
      });
      toast('success', `${t(lang, 'Thanks — your feedback was recorded.')} (${issue.id})`);
      if (failedFiles.length) toast('error', `${t(lang, 'Some files could not be uploaded')}: ${failedFiles.join(', ')}`);
      setOpen(false);
    } catch (e) {
      toast('error', (e as Error).message || t(lang, 'Could not send feedback — check your connection and try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="feedback-fab" onClick={openModal} aria-label={t(lang, 'Send feedback or report an issue on this page')}>
        <MessageSquarePlus size={18} /><span>{t(lang, 'Feedback')}</span>
      </button>
      {open && (
        <Modal title="Send feedback" desc={`${t(lang, 'Reporting from:')} ${t(lang, meta.page)}`} onClose={() => setOpen(false)}
          footer={<><Button onClick={() => setOpen(false)}>{t(lang, 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!desc.trim() || busy} onClick={submit}>{t(lang, 'Submit')}</Button></>}>
          <div className="col">
            <div className="form-grid">
              <Field label="Category">
                <Select value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategory)}>
                  {FEEDBACK_CATEGORIES.map((c) => <option key={c.v} value={c.v}>{t(lang, c.label)}</option>)}
                </Select>
              </Field>
              <Field label="Priority / impact">
                <Select value={priority} onChange={(e) => setPriority(e.target.value as FeedbackPriority)}>
                  {FEEDBACK_PRIORITIES.map((p) => <option key={p.v} value={p.v}>{t(lang, p.label)}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Subject"><Input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} placeholder={t(lang, 'A short summary (optional)')} /></Field>
            <Field label="Description" hint="What's the issue, idea, or additional feature you'd like to see on this page?">
              <Textarea autoFocus rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe what you noticed or what you'd like changed…" />
            </Field>
            <AttachmentPicker files={files} onChange={setFiles} disabled={busy} />
          </div>
        </Modal>
      )}
    </>
  );
}
