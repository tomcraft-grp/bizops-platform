// Back office: Feedback & Issue Management. One workspace for feedback from the customer app (LINE members) and
// from staff (the Feedback button). Data is real (Supabase); every action is a server-side function that checks
// the caller is support staff, enforces the status workflow and writes the audit trail (feedback_events).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Bell, Download, GitBranch, Link2, MessageSquarePlus, RefreshCw, Send, StickyNote } from 'lucide-react';
import {
  DEV_LINK_KINDS, DevLinkKind, FEEDBACK_CATEGORIES, FEEDBACK_PRIORITIES, FEEDBACK_STATUSES, FeedbackCategory, FeedbackIssue, FeedbackNotification,
  FeedbackPriority, FeedbackStatus, IssueThread, NEXT_STATUSES, OPEN_STATUSES, StaffMember,
  addDevLink, archiveIssue, getThread, issuesToCsv, listFeedback, listNotifications, listStaff, markNotificationsRead, staffComment, staffUpdate, statusMeta,
} from '../lib/feedbackApi';
import { toast, useLang } from '../domain/store';
import { Banner, Button, Card, DataTable, Drawer, Empty, Field, Input, KV, Kpi, PageHead, Popover, Select, Tabs, Textarea, Tx, useConfirm } from '../ui/kit';
import { AttachmentList, AttachmentPicker, CategoryBadge, PriorityBadge, StatusBadge } from '../ui/feedbackParts';
import { dateTimeFmt } from '../lib/util';
import { t } from '../lib/i18n';

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export default function FeedbackIssues() {
  const lang = useLang();
  const [rows, setRows] = useState<FeedbackIssue[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [notes, setNotes] = useState<FeedbackNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ status: 'open', priority: '', category: '', assignee: '', source: '' });
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listFeedback().then((r) => { setRows(r); setErr(null); }).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false));
    listNotifications(40).then(setNotes).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    listStaff().then(setStaff).catch(() => undefined);
    const i = setInterval(refresh, 30_000);
    return () => clearInterval(i);
  }, [refresh]);

  const staffName = useCallback((id: string | null) => (id ? staff.find((s) => s.id === id)?.display_name || staff.find((s) => s.id === id)?.email || '—' : ''), [staff]);
  const filtered = useMemo(() => rows.filter((r) =>
    (f.status === '' || (f.status === 'open' ? OPEN_STATUSES.includes(r.status) : r.status === f.status))
    && (!f.priority || r.priority === f.priority) && (!f.category || r.category === f.category) && (!f.source || r.source === f.source)
    && (!f.assignee || (f.assignee === 'none' ? !r.assigned_to : r.assigned_to === f.assignee))), [rows, f]);

  const count = (s: FeedbackStatus) => rows.filter((r) => r.status === s).length;
  const unread = notes.filter((n) => !n.read_at);
  const exportCsv = () => {
    const blob = new Blob([issuesToCsv(filtered, staffName)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `feedback-issues-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const open = (id: string) => {
    setOpenId(id);
    const ids = unread.filter((n) => n.issue_id === id).map((n) => n.id);
    if (ids.length) markNotificationsRead(ids).then(refresh).catch(() => undefined);
  };

  return (
    <>
      <PageHead title="Feedback & Issue Management" desc="Feedback from customers (LINE app) and staff, managed as trackable issues: triage, assign, reply, resolve."
        actions={<>
          <Popover width={340} trigger={(_o, tg) => (
            <Button onClick={tg} aria-label={t(lang, 'Notifications')} style={{ position: 'relative' }}><Bell size={14} />{' '}<Tx>Notifications</Tx>{unread.length > 0 && <b style={{ marginLeft: 4, color: 'var(--crit, #d92d20)' }}>{unread.length}</b>}</Button>
          )}>
            {(close) => (
              <div className="col gap-6" style={{ padding: 10, maxHeight: 380, overflow: 'auto' }}>
                <div className="row between"><b><Tx>Notifications</Tx></b>{unread.length > 0 && <Button size="sm" variant="ghost" onClick={() => markNotificationsRead().then(refresh)}><Tx>Mark all as read</Tx></Button>}</div>
                {!notes.length && <div className="muted"><Tx>Nothing yet.</Tx></div>}
                {notes.map((n) => (
                  <button key={n.id} type="button" className="menu-item" onClick={() => { close(); open(n.issue_id); }} style={{ opacity: n.read_at ? 0.6 : 1 }}>
                    <div className="grow" style={{ textAlign: 'left' }}><div style={{ fontWeight: n.read_at ? 400 : 650 }}>{t(lang, n.title)}</div><div className="muted" style={{ fontSize: 12 }}>{n.body} · {dateTimeFmt(n.created_at)}</div></div>
                  </button>
                ))}
              </div>
            )}
          </Popover>
          <Button onClick={exportCsv} disabled={!filtered.length}><Download size={14} />{' '}<Tx>Export to Excel (CSV)</Tx></Button>
          <Button onClick={refresh}><RefreshCw size={14} />{' '}<Tx>Refresh</Tx></Button>
        </>} />
      {err && <div className="mb16"><Banner tone="bad"><Tx>Could not load issues:</Tx>{' '}{err}</Banner></div>}
      <div className="grid g4 mb16">
        <Kpi label="Total feedback" value={rows.length} />
        <Kpi label="New (submitted)" value={count('submitted')} tone={count('submitted') ? 'bad' : 'good'} />
        <Kpi label="Under review" value={count('under_review')} />
        <Kpi label="In progress" value={count('in_progress') + count('accepted')} />
        <Kpi label="Waiting for information" value={count('waiting_info')} />
        <Kpi label="Resolved / closed" value={count('resolved') + count('closed')} tone="good" />
        <Kpi label="Critical (open)" value={rows.filter((r) => r.priority === 'critical' && OPEN_STATUSES.includes(r.status)).length} tone={rows.some((r) => r.priority === 'critical' && OPEN_STATUSES.includes(r.status)) ? 'bad' : 'good'} />
        <Kpi label="From customers" value={rows.filter((r) => r.source === 'customer').length} />
      </div>
      <Card flush>
        <DataTable
          rows={filtered} rowKey={(r) => r.id} onRow={(r) => open(r.id)} pageSize={15}
          search={(r) => `${r.id} ${r.title} ${r.description} ${r.submitter_label} ${r.page_name} ${r.module_name ?? ''}`}
          toolbar={
            <div className="row gap-6 wrap">
              <Select sm style={{ width: 'auto' }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label={t(lang, 'Status')}>
                <option value="open">{t(lang, 'Open issues')}</option><option value="">{t(lang, 'All statuses')}</option>
                {FEEDBACK_STATUSES.map((s) => <option key={s.v} value={s.v}>{t(lang, s.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} aria-label={t(lang, 'Priority')}>
                <option value="">{t(lang, 'All priorities')}</option>{FEEDBACK_PRIORITIES.map((p) => <option key={p.v} value={p.v}>{t(lang, p.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label={t(lang, 'Category')}>
                <option value="">{t(lang, 'All categories')}</option>{FEEDBACK_CATEGORIES.map((c) => <option key={c.v} value={c.v}>{t(lang, c.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} aria-label={t(lang, 'Assigned to')}>
                <option value="">{t(lang, 'Anyone')}</option><option value="none">{t(lang, 'Unassigned')}</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.display_name || s.email}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} aria-label={t(lang, 'Source')}>
                <option value="">{t(lang, 'Customers and staff')}</option><option value="customer">{t(lang, 'Customers only')}</option><option value="staff">{t(lang, 'Staff only')}</option>
              </Select>
            </div>
          }
          empty={<Empty icon={<MessageSquarePlus size={22} />} title={loading ? 'Loading…' : 'No issues match'} hint="Feedback from the customer app and the Feedback button shows up here." />}
          cols={[
            { key: 'id', header: 'Issue ID', render: (r) => <span className="mono">{r.id}</span>, sort: (r) => r.created_at },
            { key: 't', header: 'Subject', render: (r) => <div><b>{r.title}</b><div className="sub">{r.page_name}{r.module_name ? ` · ${r.module_name}` : ''}</div></div> },
            { key: 'by', header: 'Submitted by', render: (r) => <div>{r.submitter_label}<div className="sub">{t(lang, r.source === 'customer' ? 'Customer' : 'Staff')}</div></div>, hideSm: true },
            { key: 'cat', header: 'Category', render: (r) => <CategoryBadge category={r.category} />, hideSm: true },
            { key: 'pr', header: 'Priority', render: (r) => <PriorityBadge priority={r.priority} />, sort: (r) => PRIORITY_RANK[r.priority] ?? 0 },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} />, sort: (r) => r.status },
            { key: 'as', header: 'Assigned to', render: (r) => staffName(r.assigned_to) || <span className="muted">—</span>, hideSm: true },
            { key: 'c', header: 'Created', render: (r) => dateTimeFmt(r.created_at), sort: (r) => r.created_at, hideSm: true },
            { key: 'u', header: 'Last updated', render: (r) => dateTimeFmt(r.last_activity_at), sort: (r) => r.last_activity_at },
          ]}
          initialSort={{ key: 'u', dir: 'desc' }}
        />
      </Card>
      {openId && <IssueDrawer issueId={openId} issue={rows.find((r) => r.id === openId)} staff={staff} staffName={staffName} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

function IssueDrawer({ issueId, issue, staff, staffName, onClose, onChanged }: {
  issueId: string; issue?: FeedbackIssue; staff: StaffMember[]; staffName: (id: string | null) => string; onClose: () => void; onChanged: () => void;
}) {
  const lang = useLang();
  const confirm = useConfirm();
  const [th, setTh] = useState<IssueThread | null>(null);
  const [tab, setTab] = useState<'conversation' | 'internal' | 'timeline' | 'dev'>('conversation');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(''); const [msgFiles, setMsgFiles] = useState<File[]>([]); const [askInfo, setAskInfo] = useState(false);
  const [note, setNote] = useState('');
  const [rootCause, setRootCause] = useState(issue?.root_cause ?? ''); const [resolution, setResolution] = useState(issue?.resolution ?? '');
  const [link, setLink] = useState<{ kind: DevLinkKind; ref: string; url: string; env: string }>({ kind: 'commit', ref: '', url: '', env: '' });
  const load = useCallback(() => { getThread(issueId, true).then(setTh).catch((e) => toast('error', (e as Error).message)); }, [issueId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setRootCause(issue?.root_cause ?? ''); setResolution(issue?.resolution ?? ''); }, [issue?.root_cause, issue?.resolution]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast('success', t(lang, ok)); load(); onChanged(); return true; }
    catch (e) { toast('error', (e as Error).message); return false; }
    finally { setBusy(false); }
  };
  if (!issue) return <Drawer title={issueId} onClose={onClose}><div className="center" style={{ padding: 20 }}><div className="spinner" /></div></Drawer>;

  const changeStatus = async (to: FeedbackStatus) => {
    let reason: string | undefined;
    if (to === 'rejected' || to === 'closed' || to === 'waiting_info') {
      const r = await confirm({ title: t(lang, 'Change status to "{s}"?', { s: t(lang, statusMeta(to).label) }), body: to === 'rejected' ? t(lang, 'The customer will see this reason.') : undefined, reason: to === 'rejected' ? t(lang, 'Reason (shown to the customer)') : false, confirmLabel: t(lang, 'Change status') });
      if (!r.ok) return;
      reason = r.reason || undefined;
    }
    await run(() => staffUpdate(issue.id, { status: to, reason, resolution: to === 'resolved' ? resolution : undefined }), 'Status updated');
  };
  const conversation = (th?.comments ?? []).filter((c) => c.kind !== 'internal');
  const internal = (th?.comments ?? []).filter((c) => c.kind === 'internal');

  return (
    <Drawer title={<><span className="mono muted" style={{ fontSize: 13 }}>{issue.id}</span> {issue.title}</>} sub={`${issue.submitter_label} · ${dateTimeFmt(issue.created_at)}`} onClose={onClose}>
      <div className="col gap-16">
        <div className="row wrap" style={{ gap: 8 }}><StatusBadge status={issue.status} /><PriorityBadge priority={issue.priority} /><CategoryBadge category={issue.category} /></div>
        <Card title="Original feedback">
          <div style={{ whiteSpace: 'pre-wrap' }}>{issue.description}</div>
          {issue.remark && <div className="muted mt8" style={{ whiteSpace: 'pre-wrap' }}>{issue.remark}</div>}
          <div className="mt8"><AttachmentList items={(th?.attachments ?? []).filter((a) => !a.comment_id)} /></div>
        </Card>

        <Card title="Workflow">
          <div className="form-grid">
            <Field label="Status">
              <Select disabled={busy} value="" onChange={(e) => e.target.value && changeStatus(e.target.value as FeedbackStatus)}>
                <option value="">{t(lang, statusMeta(issue.status).label)} — {t(lang, 'change to…')}</option>
                {NEXT_STATUSES[issue.status].map((s) => <option key={s} value={s}>{t(lang, statusMeta(s).label)}</option>)}
              </Select>
            </Field>
            <Field label="Priority">
              <Select disabled={busy} value={issue.priority} onChange={(e) => run(() => staffUpdate(issue.id, { priority: e.target.value as FeedbackPriority }), 'Priority updated')}>
                {FEEDBACK_PRIORITIES.map((p) => <option key={p.v} value={p.v}>{t(lang, p.label)}</option>)}
              </Select>
            </Field>
            <Field label="Category">
              <Select disabled={busy} value={issue.category} onChange={(e) => run(() => staffUpdate(issue.id, { category: e.target.value as FeedbackCategory }), 'Category updated')}>
                {FEEDBACK_CATEGORIES.map((c) => <option key={c.v} value={c.v}>{t(lang, c.label)}</option>)}
              </Select>
            </Field>
            <Field label="Assigned to">
              <Select disabled={busy} value={issue.assigned_to ?? ''} onChange={(e) => run(() => staffUpdate(issue.id, { assignedTo: e.target.value || null }), 'Assignment updated')}>
                <option value="">{t(lang, 'Unassigned')}</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.display_name || s.email}</option>)}
              </Select>
            </Field>
          </div>
          <div className="form-grid mt8">
            <Field label="Root cause" hint="Internal only."><Textarea rows={2} value={rootCause} onChange={(e) => setRootCause(e.target.value)} /></Field>
            <Field label="Resolution" hint="Shown to the customer when the issue is resolved."><Textarea rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
          </div>
          <div className="row mt8" style={{ justifyContent: 'space-between' }}>
            <Button size="sm" disabled={busy || (rootCause === (issue.root_cause ?? '') && resolution === (issue.resolution ?? ''))}
              onClick={() => run(() => staffUpdate(issue.id, { rootCause: rootCause !== (issue.root_cause ?? '') ? rootCause : undefined, resolution: resolution !== (issue.resolution ?? '') ? resolution : undefined }), 'Saved')}><Tx>Save root cause & resolution</Tx></Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
              const r = await confirm({ title: t(lang, 'Archive {id}?', { id: issue.id }), body: t(lang, 'Archived issues are hidden from the list but never deleted.'), reason: t(lang, 'Reason'), confirmLabel: t(lang, 'Archive') });
              if (r.ok && await run(() => archiveIssue(issue.id, r.reason), 'Archived')) onClose();
            }}><Archive size={13} />{' '}<Tx>Archive</Tx></Button>
          </div>
        </Card>

        <Tabs value={tab} onChange={setTab} tabs={[
          { v: 'conversation', label: t(lang, 'Customer conversation'), count: conversation.length },
          { v: 'internal', label: t(lang, 'Internal notes'), count: internal.length },
          { v: 'timeline', label: t(lang, 'History'), count: th?.events.length },
          { v: 'dev', label: t(lang, 'Development'), count: th?.links.length },
        ]} />

        {tab === 'conversation' && (
          <div className="col">
            {!conversation.length && <div className="muted"><Tx>No messages yet.</Tx></div>}
            {conversation.map((c) => (
              <div key={c.id} className="card card-b" style={{ background: c.kind === 'customer' ? 'var(--surface-2)' : undefined }}>
                <div className="muted" style={{ fontSize: 11.5 }}>{c.kind === 'customer' ? t(lang, 'Customer') : t(lang, 'Reply')} · {c.author_label} · {dateTimeFmt(c.created_at)}{c.requests_info && <> · <b>{t(lang, 'requested more information')}</b></>}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                <AttachmentList items={(th?.attachments ?? []).filter((a) => a.comment_id === c.id)} />
              </div>
            ))}
            {issue.reporter_id ? (
              <div className="col gap-6">
                <Textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={t(lang, 'Reply to the customer (they will see this)…')} />
                <AttachmentPicker files={msgFiles} onChange={setMsgFiles} disabled={busy} />
                <label className="row gap-6" style={{ fontSize: 13 }}><input type="checkbox" checked={askInfo} onChange={(e) => setAskInfo(e.target.checked)} /> <Tx>This asks the customer for more information (status becomes "Waiting for information")</Tx></label>
                <div><Button variant="primary" size="sm" disabled={!msg.trim() || busy} onClick={() => run(async () => { const failed = await staffComment(issue.id, 'reply', msg, askInfo, msgFiles); if (failed.length) toast('error', `${t(lang, 'Some files could not be uploaded')}: ${failed.join(', ')}`); setMsg(''); setMsgFiles([]); setAskInfo(false); }, 'Reply sent')}><Send size={13} />{' '}<Tx>Send reply</Tx></Button></div>
              </div>
            ) : <div className="muted"><Tx>This feedback has no linked account, so replies cannot be delivered.</Tx></div>}
          </div>
        )}

        {tab === 'internal' && (
          <div className="col">
            <Banner><Tx>Internal notes are visible only to staff — never to the customer.</Tx></Banner>
            {internal.map((c) => (
              <div key={c.id} className="card card-b" style={{ background: 'var(--surface-2)' }}>
                <div className="muted" style={{ fontSize: 11.5 }}>{c.author_label} · {dateTimeFmt(c.created_at)}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
              </div>
            ))}
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t(lang, 'Add an investigation note or internal remark…')} />
            <div><Button size="sm" disabled={!note.trim() || busy} onClick={() => run(async () => { await staffComment(issue.id, 'internal', note); setNote(''); }, 'Note added')}><StickyNote size={13} />{' '}<Tx>Add note</Tx></Button></div>
          </div>
        )}

        {tab === 'timeline' && (
          <div className="col gap-6">
            {(th?.events ?? []).map((e) => (
              <div key={e.id} style={{ fontSize: 13 }}>
                <span className="muted">{dateTimeFmt(e.created_at)}</span> · <b>{e.actor_label}</b> · {t(lang, e.kind)}
                {(e.from_value || e.to_value) && <> : {e.kind === 'assigned' ? `${staffName(e.from_value) || '—'} → ${staffName(e.to_value) || '—'}` : `${e.from_value ? t(lang, statusMeta(e.from_value).label) + ' → ' : ''}${e.to_value ? t(lang, statusMeta(e.to_value).label) : ''}`}</>}
                {e.note && <span className="muted"> — {e.note}</span>}
                {e.customer_visible && <span className="muted"> · {t(lang, 'visible to customer')}</span>}
              </div>
            ))}
          </div>
        )}

        {tab === 'dev' && (
          <div className="col">
            {(th?.links ?? []).map((l) => (
              <div key={l.id} className="row gap-6" style={{ fontSize: 13 }}>
                <GitBranch size={13} /><b>{t(lang, DEV_LINK_KINDS.find((k) => k.v === l.kind)?.label ?? l.kind)}</b>
                {l.url ? <a href={l.url} target="_blank" rel="noopener noreferrer" className="mono">{l.ref}</a> : <span className="mono">{l.ref}</span>}
                {l.environment && <span className="muted">· {l.environment}</span>}<span className="muted">· {dateTimeFmt(l.created_at)}</span>
              </div>
            ))}
            <div className="form-grid">
              <Field label="Type"><Select value={link.kind} onChange={(e) => setLink({ ...link, kind: e.target.value as DevLinkKind })}>{DEV_LINK_KINDS.map((k) => <option key={k.v} value={k.v}>{t(lang, k.label)}</option>)}</Select></Field>
              <Field label="Reference"><Input value={link.ref} onChange={(e) => setLink({ ...link, ref: e.target.value })} placeholder="e.g. 480442a, #12, v0.2.0" /></Field>
              <Field label="Link (https, optional)"><Input value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} placeholder="https://github.com/…" /></Field>
              <Field label="Environment"><Select value={link.env} onChange={(e) => setLink({ ...link, env: e.target.value })}><option value="">—</option><option>DEV</option><option>TEST</option><option>PRODUCTION</option></Select></Field>
            </div>
            <div className="muted" style={{ fontSize: 12 }}><Tx>Linking code does not resolve the issue — resolve it only after review, testing and deployment.</Tx></div>
            <div><Button size="sm" disabled={!link.ref.trim() || busy || (!!link.url && !/^https:\/\//.test(link.url))} onClick={() => run(async () => { await addDevLink(issue.id, link.kind, link.ref, link.url, link.env); setLink({ ...link, ref: '', url: '' }); }, 'Link added')}><Link2 size={13} />{' '}<Tx>Add link</Tx></Button></div>
          </div>
        )}

        <Card title="Reporter and context (captured automatically)">
          <KV items={[
            ['Submitted by', `${issue.submitter_label} (${t(lang, issue.source === 'customer' ? 'Customer' : 'Staff')})`],
            ['App', issue.app_id],
            ['Page / area', `${issue.page_name || '—'}${issue.module_name ? ` · ${issue.module_name}` : ''}`],
            ['Route', <span className="mono">{issue.page_path || '—'}</span>],
            ['Device', `${issue.device_type ?? '—'} · ${issue.os_info ?? '—'}`],
            ['App version', `${issue.app_version ?? '—'} (${issue.environment})`],
            ['Browser', <span style={{ wordBreak: 'break-all', fontSize: 12 }}>{issue.browser_info || '—'}</span>],
            ['Resolved at', issue.resolved_at ? dateTimeFmt(issue.resolved_at) : '—'],
          ]} />
        </Card>
      </div>
    </Drawer>
  );
}
