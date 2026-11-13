// Customer app: Help & Feedback. A LINE member reports a problem or idea, follows its status in "My feedback",
// answers the team's questions, and sees replies. Data is real (Supabase), scoped to the member by RLS.
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bell, CheckCircle2, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { setLang, useLang } from '../../domain/store';
import { t } from '../../lib/i18n';
import {
  FEEDBACK_CATEGORIES, FEEDBACK_PRIORITIES, FeedbackCategory, FeedbackIssue, FeedbackNotification, FeedbackPriority, IssueThread,
  customerMessage, getThread, listFeedback, listNotifications, markNotificationsRead, statusMeta, submitFeedback,
} from '../../lib/feedbackApi';
import { Banner, Button, Empty, Field, Input, Select, Textarea } from '../../ui/kit';
import { AttachmentList, AttachmentPicker, CategoryBadge, StatusBadge } from '../../ui/feedbackParts';
import { dateFmt, dateTimeFmt } from '../../lib/util';

/** Unread feedback notifications for the signed-in member, refreshed every 30 s (used for the tab badge). */
export function useFeedbackNotifications(enabled: boolean) {
  const [items, setItems] = useState<FeedbackNotification[]>([]);
  const refresh = useCallback(() => { if (enabled) listNotifications(30).then(setItems).catch(() => undefined); }, [enabled]);
  useEffect(() => { refresh(); if (!enabled) return; const i = setInterval(refresh, 30_000); return () => clearInterval(i); }, [refresh, enabled]);
  return { items, unread: items.filter((n) => !n.read_at).length, refresh };
}

// Parts of the customer app a member can point at (auto-selected from the tab they came from).
const AREAS = [
  { v: 'home', label: 'Home / member card' }, { v: 'shop', label: 'Shop' }, { v: 'rewards', label: 'Rewards' },
  { v: 'pay', label: 'Payments' }, { v: 'events', label: 'Events' }, { v: 'profile', label: 'My profile' }, { v: 'other', label: 'Other' },
];

type View = { k: 'list' } | { k: 'new' } | { k: 'done'; id: string; failed: string[] } | { k: 'thread'; id: string };

export default function FeedbackCenter({ fromArea, notes }: { fromArea: string; notes: ReturnType<typeof useFeedbackNotifications> }) {
  const lang = useLang();
  const [view, setView] = useState<View>({ k: 'list' });
  const [rows, setRows] = useState<FeedbackIssue[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { listFeedback().then((r) => { setRows(r); setErr(null); }).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load]);

  const openThread = (id: string) => {
    setView({ k: 'thread', id });
    const unread = notes.items.filter((n) => n.issue_id === id && !n.read_at).map((n) => n.id);
    if (unread.length) markNotificationsRead(unread).then(notes.refresh).catch(() => undefined);
  };

  const header = (
    <div className="row between" style={{ alignItems: 'center' }}>
      <h2 style={{ margin: 0 }}>{t(lang, 'Help & feedback')}</h2>
      <div className="row gap-4" role="group" aria-label="Language">
        {(['th', 'en'] as const).map((l) => (
          <button key={l} type="button" onClick={() => setLang(l)} aria-pressed={lang === l}
            style={{ border: '1px solid var(--border)', background: lang === l ? 'var(--surface-2)' : 'transparent', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: lang === l ? 700 : 400, cursor: 'pointer', color: 'inherit' }}>
            {l === 'th' ? 'ไทย' : 'EN'}
          </button>
        ))}
      </div>
    </div>
  );

  if (view.k === 'new') return <>{header}<NewFeedback fromArea={fromArea} onCancel={() => setView({ k: 'list' })} onDone={(id, failed) => { load(); notes.refresh(); setView({ k: 'done', id, failed }); }} /></>;
  if (view.k === 'done') {
    return (
      <>{header}
        <div className="center col gap-6" style={{ padding: '18px 0' }}>
          <CheckCircle2 size={44} color="#047a3b" style={{ margin: '0 auto' }} />
          <h3 style={{ margin: 0 }}>{t(lang, 'Thank you! We received your feedback')}</h3>
          <div className="muted">{t(lang, 'Reference number')}: <b className="mono">{view.id}</b></div>
          <div className="muted" style={{ fontSize: 13 }}>{t(lang, 'You can follow its progress in My feedback.')}</div>
          {view.failed.length > 0 && <Banner tone="warn">{t(lang, 'Some files could not be uploaded')}: {view.failed.join(', ')}</Banner>}
        </div>
        <Button variant="primary" className="block" onClick={() => openThread(view.id)}>{t(lang, 'View this feedback')}</Button>
        <Button className="block" onClick={() => setView({ k: 'list' })}>{t(lang, 'Back to My feedback')}</Button>
      </>
    );
  }
  if (view.k === 'thread') {
    const issue = rows?.find((r) => r.id === view.id);
    return <>{header}<Thread issueId={view.id} issue={issue} onBack={() => { load(); setView({ k: 'list' }); }} onChanged={load} /></>;
  }

  const unread = notes.items.filter((n) => !n.read_at);
  return (
    <>
      {header}
      <div className="muted" style={{ fontSize: 13 }}>{t(lang, 'Found a problem or have an idea? Tell us — the team reads every message.')}</div>
      <Button variant="primary" className="block" onClick={() => setView({ k: 'new' })}><MessageSquarePlus size={16} /> {t(lang, 'Send feedback')}</Button>
      {unread.length > 0 && (
        <div className="card card-b col gap-6" style={{ background: 'var(--surface-2)' }}>
          <div className="row between"><b className="row gap-6"><Bell size={15} /> {t(lang, 'Updates for you')} ({unread.length})</b>
            <button type="button" className="muted" style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 12 }} onClick={() => markNotificationsRead().then(notes.refresh)}>{t(lang, 'Mark all as read')}</button></div>
          {unread.slice(0, 5).map((n) => (
            <button key={n.id} type="button" className="menu-item" onClick={() => openThread(n.issue_id)}>
              <div className="grow" style={{ textAlign: 'left' }}><div style={{ fontWeight: 600 }}>{t(lang, n.title)}</div><div className="muted" style={{ fontSize: 12 }}>{n.issue_id} · {n.kind === 'status' && n.body ? t(lang, statusMeta(n.body).label) : n.body}</div></div>
            </button>
          ))}
        </div>
      )}
      <div className="row between" style={{ marginTop: 4 }}>
        <b>{t(lang, 'My feedback')}</b>
        <button type="button" aria-label={t(lang, 'Refresh')} onClick={load} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit' }}><RefreshCw size={15} /></button>
      </div>
      {err && <Banner tone="bad">{t(lang, 'Could not load your feedback')}: {err}</Banner>}
      {!rows && !err && <div className="center" style={{ padding: 16 }}><div className="spinner" /></div>}
      {rows && !rows.length && <Empty title={t(lang, 'No feedback yet')} hint={t(lang, 'Anything you send will appear here with its status.')} />}
      {rows?.map((r) => {
        const hasUnread = notes.items.some((n) => n.issue_id === r.id && !n.read_at);
        return (
          <button key={r.id} type="button" className="menu-item" onClick={() => openThread(r.id)} style={{ alignItems: 'flex-start' }}>
            <div className="grow col gap-4" style={{ textAlign: 'left', minWidth: 0 }}>
              <div className="row between" style={{ gap: 6 }}>
                <span className="mono muted" style={{ fontSize: 11.5 }}>{r.id}{hasUnread && <span aria-label={t(lang, 'New update')} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: 'var(--crit, #d92d20)', marginLeft: 6 }} />}</span>
                <StatusBadge status={r.status} />
              </div>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
              <div className="row wrap" style={{ gap: 6, fontSize: 12 }}><CategoryBadge category={r.category} /><span className="muted">{t(lang, 'Sent')} {dateFmt(r.created_at)} · {t(lang, 'Updated')} {dateTimeFmt(r.last_activity_at)}</span></div>
              {r.resolution && (r.status === 'resolved' || r.status === 'closed') && <div className="muted" style={{ fontSize: 12.5 }}>✓ {r.resolution.slice(0, 120)}</div>}
            </div>
          </button>
        );
      })}
    </>
  );
}

function NewFeedback({ fromArea, onCancel, onDone }: { fromArea: string; onCancel: () => void; onDone: (id: string, failed: string[]) => void }) {
  const lang = useLang();
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [area, setArea] = useState(AREAS.some((a) => a.v === fromArea) ? fromArea : 'other');
  const [priority, setPriority] = useState<FeedbackPriority>('medium');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const idem = useMemo(() => crypto.randomUUID(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!category) return setErr(t(lang, 'Please choose what kind of feedback this is'));
    if (!description.trim()) return setErr(t(lang, 'Please describe the problem or suggestion'));
    setBusy(true); setErr(null);
    try {
      const areaLabel = AREAS.find((a) => a.v === area)?.label ?? area;
      const { issue, failedFiles } = await submitFeedback({ category, subject, description, priority, pageName: areaLabel, module: area, appId: 'line-liff', idempotencyKey: idem, files });
      onDone(issue.id, failedFiles);
    } catch (e2) {
      setErr((e2 as Error).message || t(lang, 'Could not send — check your connection and try again'));
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="col">
      <button type="button" onClick={onCancel} className="row gap-6 muted" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 13 }}><ArrowLeft size={14} /> {t(lang, 'Back')}</button>
      {err && <Banner tone="bad">{err}</Banner>}
      <Field label={t(lang, 'What kind of feedback?')}>
        <div className="col gap-4" role="radiogroup">
          {FEEDBACK_CATEGORIES.map((c) => (
            <label key={c.v} className="row gap-6" style={{ alignItems: 'flex-start', padding: '6px 8px', borderRadius: 8, border: `1px solid ${category === c.v ? '#047a3b' : 'var(--border)'}`, cursor: 'pointer' }}>
              <input type="radio" name="fb-cat" checked={category === c.v} onChange={() => setCategory(c.v)} style={{ marginTop: 3 }} />
              <span><b style={{ fontSize: 13.5 }}>{t(lang, c.label)}</b><div className="muted" style={{ fontSize: 12 }}>{t(lang, c.hint)}</div></span>
            </label>
          ))}
        </div>
      </Field>
      <Field label={t(lang, 'Subject')}><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder={t(lang, 'A short summary (optional)')} /></Field>
      <Field label={t(lang, 'Details')}><Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} required placeholder={t(lang, 'What happened, what you expected, or what you would like…')} /></Field>
      <Field label={t(lang, 'Which part of the app?')}>
        <Select value={area} onChange={(e) => setArea(e.target.value)}>{AREAS.map((a) => <option key={a.v} value={a.v}>{t(lang, a.label)}</option>)}</Select>
      </Field>
      <Field label={t(lang, 'How much does this affect you?')}>
        <Select value={priority} onChange={(e) => setPriority(e.target.value as FeedbackPriority)}>{FEEDBACK_PRIORITIES.map((p) => <option key={p.v} value={p.v}>{t(lang, p.label)}</option>)}</Select>
      </Field>
      <AttachmentPicker files={files} onChange={setFiles} disabled={busy} />
      <div className="muted" style={{ fontSize: 11.5 }}>{t(lang, 'Your device and app version are attached automatically to help us investigate. Please do not include passwords or card numbers.')}</div>
      <Button type="submit" variant="primary" className="block" loading={busy} disabled={busy}>{t(lang, 'Send feedback')}</Button>
    </form>
  );
}

const EVENT_TEXT: Record<string, string> = { created: 'Feedback submitted', attachment: 'File attached', resolution: 'Resolution recorded' };

function Thread({ issueId, issue, onBack, onChanged }: { issueId: string; issue?: FeedbackIssue; onBack: () => void; onChanged: () => void }) {
  const lang = useLang();
  const [th, setTh] = useState<IssueThread | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { getThread(issueId, false).then(setTh).catch((e) => setErr((e as Error).message)); }, [issueId]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!msg.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const failed = await customerMessage(issueId, msg, files);
      setMsg(''); setFiles([]);
      if (failed.length) setErr(`${t(lang, 'Some files could not be uploaded')}: ${failed.join(', ')}`);
      load(); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // One timeline: messages plus customer-visible events (comment events are represented by the messages themselves).
  type Item = { at: string; key: string; node: JSX.Element };
  const items: Item[] = [];
  for (const c of th?.comments ?? []) {
    const mine = c.kind === 'customer';
    items.push({ at: c.created_at, key: 'c' + c.id, node: (
      <div style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', background: mine ? '#e7f6ec' : 'var(--surface-2)', color: mine ? '#0b3d1f' : 'inherit', borderRadius: 12, padding: '8px 10px' }}>
        <div className="muted" style={{ fontSize: 11, color: mine ? '#2c6b44' : undefined }}>{mine ? t(lang, 'You') : `${t(lang, 'Support team')} · ${c.author_label}`} · {dateTimeFmt(c.created_at)}</div>
        {c.requests_info && <div style={{ fontSize: 12, fontWeight: 700 }}>{t(lang, 'The team needs more information')}</div>}
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{c.body}</div>
        <AttachmentList items={(th?.attachments ?? []).filter((a) => a.comment_id === c.id)} />
      </div>
    ) });
  }
  for (const e of th?.events ?? []) {
    if (e.kind === 'comment') continue;
    const text = e.kind === 'status' ? `${t(lang, 'Status')}: ${t(lang, statusMeta(e.to_value ?? '').label)}` : t(lang, EVENT_TEXT[e.kind] ?? e.kind);
    const note = e.kind === 'attachment' ? e.to_value : e.note;
    items.push({ at: e.created_at, key: 'e' + e.id, node: (
      <div className="center muted" style={{ fontSize: 12 }}>— {text}{note ? ` · ${note}` : ''} · {dateTimeFmt(e.created_at)} —</div>
    ) });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  const closed = issue?.status === 'closed' || issue?.status === 'rejected';

  return (
    <div className="col">
      <button type="button" onClick={onBack} className="row gap-6 muted" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 13 }}><ArrowLeft size={14} /> {t(lang, 'My feedback')}</button>
      {issue && (
        <div className="col gap-4">
          <div className="row between"><span className="mono muted" style={{ fontSize: 12 }}>{issue.id}</span><StatusBadge status={issue.status} /></div>
          <h3 style={{ margin: 0 }}>{issue.title}</h3>
          <div className="row wrap" style={{ gap: 6 }}><CategoryBadge category={issue.category} /><span className="muted" style={{ fontSize: 12 }}>{dateTimeFmt(issue.created_at)}</span></div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{issue.description}</div>
          <AttachmentList items={(th?.attachments ?? []).filter((a) => !a.comment_id)} />
          {issue.status === 'waiting_info' && <Banner tone="warn">{t(lang, 'The team needs more information from you. Please reply below.')}</Banner>}
          {issue.resolution && (issue.status === 'resolved' || issue.status === 'closed') && <Banner tone="good"><b>{t(lang, 'Resolution')}:</b> {issue.resolution}</Banner>}
        </div>
      )}
      {err && <Banner tone="bad">{err}</Banner>}
      {!th && !err && <div className="center" style={{ padding: 12 }}><div className="spinner" /></div>}
      <div className="col gap-6">{items.map((i) => <div key={i.key} className="col">{i.node}</div>)}</div>
      {closed ? (
        <div className="muted center" style={{ fontSize: 13 }}>{t(lang, 'This feedback is closed. Send new feedback if you need more help.')}</div>
      ) : (
        <div className="col gap-6">
          <Textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={5000} placeholder={t(lang, 'Write a message to the team…')} />
          <AttachmentPicker files={files} onChange={setFiles} disabled={busy} />
          <Button variant="primary" className="block" loading={busy} disabled={!msg.trim() || busy} onClick={send}>{t(lang, 'Send message')}</Button>
        </div>
      )}
    </div>
  );
}
