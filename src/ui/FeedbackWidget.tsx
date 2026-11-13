import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MessageSquarePlus } from 'lucide-react';
import { FEEDBACK_CATEGORIES, FeedbackCategory, submitFeedback } from '../lib/feedbackApi';
import { pageMetaFor } from '../domain/meta';
import { Button, Field, Modal, Select, Textarea } from './kit';
import { toast, useLang } from '../domain/store';
import { t } from '../lib/i18n';
import { useAuth } from '../auth/AuthProvider';

// Global, reusable floating feedback button — mounted once in Shell so it is available on every
// internal page without any per-page wiring. Page/module context is read from the route, not typed
// by the user (QA addendum §3: "users should not need to manually identify which page they are reporting").
// Submissions go to a centralized Supabase table (src/lib/feedbackApi.ts), not the local per-browser
// IndexedDB "DB" the rest of this prototype uses, so every tester's feedback lands in one shared place.
export function FeedbackButton() {
  const loc = useLocation();
  const lang = useLang();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [remark, setRemark] = useState('');
  const [category, setCategory] = useState<FeedbackCategory>('feature_request');
  const [busy, setBusy] = useState(false);
  const [idemKey, setIdemKey] = useState('');

  const openModal = () => { setDesc(''); setRemark(''); setCategory('feature_request'); setIdemKey(crypto.randomUUID()); setOpen(true); };
  const meta = pageMetaFor(loc.pathname);

  const submit = async () => {
    if (!desc.trim() || busy) return;
    setBusy(true);
    try {
      await submitFeedback({
        description: desc, remark: remark || undefined, category,
        pageName: meta.page, pagePath: loc.pathname, pageUrl: window.location.href,
        moduleName: meta.module, featureName: meta.feature,
        submitterLabel: `${profile?.display_name || profile?.email || 'unknown'} (${profile?.role ?? '?'})`,
        environment: import.meta.env.MODE, browserInfo: navigator.userAgent, deviceInfo: `${window.innerWidth}×${window.innerHeight}`,
        idempotencyKey: idemKey,
      });
      toast('success', 'Thanks — your feedback was recorded.');
      setOpen(false);
    } catch (e) {
      toast('error', (e as Error).message || 'Could not send feedback — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="feedback-fab" onClick={openModal} aria-label="Send feedback or report an issue on this page">
        <MessageSquarePlus size={18} /><span>{t(lang, 'Feedback')}</span>
      </button>
      {open && (
        <Modal title="Send feedback" desc={`${t(lang, 'Reporting from:')} ${t(lang, meta.page)}`} onClose={() => setOpen(false)}
          footer={<><Button onClick={() => setOpen(false)}>{t(lang, 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!desc.trim() || busy} onClick={submit}>{t(lang, 'Submit')}</Button></>}>
          <div className="col">
            <Field label="Category" hint="Helps the team route this to the right person and fix it at the right place.">
              <Select value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategory)}>
                {FEEDBACK_CATEGORIES.map((c) => <option key={c.v} value={c.v}>{t(lang, c.label)}</option>)}
              </Select>
            </Field>
            <Field label="Description" hint="What's the issue, idea, or additional feature you'd like to see on this page?">
              <Textarea autoFocus rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe what you noticed or what you'd like changed…" />
            </Field>
            <Field label="Remark / additional notes" hint="Optional — any extra context for the team.">
              <Textarea rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
