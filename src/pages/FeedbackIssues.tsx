// Back office: Feedback & Issue Management. One workspace for feedback from the customer app (LINE members) and
// from staff (the Feedback button). Data is real (Supabase); every action is a server-side function that checks
// the caller is support staff, enforces the status workflow and writes the audit trail (feedback_events).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Bell, Download, GitBranch, Link2, MessageSquarePlus, RefreshCw, Send, StickyNote, X } from 'lucide-react';
import {
  DEV_LINK_KINDS, DevLinkKind, FEEDBACK_CATEGORIES, FEEDBACK_PRIORITIES, FeedbackCategory, FeedbackIssue, FeedbackNotification,
  FeedbackPriority, FeedbackStatus, IssueThread, NEXT_STATUSES, StaffMember, FEEDBACK_SLA_DAYS, closingNote, isOverdue,
  addDevLink, archiveIssue, getIssue, getThread, issuesToCsv, listFeedback, listNotifications, listStaff, markNotificationsRead, staffComment, staffUpdate, statusMeta,
} from '../lib/feedbackApi';
import { applyFilter, cardCounts, FEEDBACK_CARDS, FeedbackFilter, NO_FILTER, pressCard, STATUS_OPTIONS, StatusFilter, statusLabel } from '../lib/feedbackFilters';
import { toast, useLang } from '../domain/store';
import { Badge, Banner, Button, Card, DataTable, Drawer, Empty, ErrText, Field, Input, KV, Kpi, PageHead, Popover, Select, Tabs, Textarea, Tx, useConfirm } from '../ui/kit';
import { AttachmentList, AttachmentPicker, CategoryBadge, PriorityBadge, StatusBadge } from '../ui/feedbackParts';
import { EnglishContextCard, EvidenceCard, OriginalFeedbackCard } from '../ui/FeedbackContext';
import { dateTimeFmt } from '../lib/util';
import { t } from '../lib/i18n';
import { useAuth } from '../auth/AuthProvider';

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export default function FeedbackIssues() {
  const lang = useLang();
  const { profile } = useAuth();
  const myId = profile?.id ?? null;
  const [rows, setRows] = useState<FeedbackIssue[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [notes, setNotes] = useState<FeedbackNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<FeedbackFilter>({ ...NO_FILTER, status: 'open' });
  const listRef = useRef<HTMLDivElement>(null);
  const ready = !loading && !(err && !rows.length);
  const seq = useRef(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const id = ++seq.current;                          // an older answer that arrives late never replaces a newer one
    listFeedback().then((r) => { if (id === seq.current) { setRows(r); setErr(null); } }).catch((e) => { if (id === seq.current) setErr((e as Error).message); }).finally(() => setLoading(false));
    listNotifications(40).then(setNotes).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    listStaff().then(setStaff).catch(() => undefined);
    const i = setInterval(refresh, 30_000);
    return () => clearInterval(i);
  }, [refresh]);

  const staffName = useCallback((id: string | null) => (id ? staff.find((s) => s.id === id)?.display_name || staff.find((s) => s.id === id)?.email || '' : ''), [staff]);   // '' when unknown: the callers fall back to the name stored with the issue
  const filtered = useMemo(() => applyFilter(rows, f, myId), [rows, f, myId]);
  const counts = useMemo(() => cardCounts(rows, f, myId), [rows, f, myId]);
  const others = !!(f.priority || f.category || f.assignee || f.source || f.q.trim());
  const pickCard = (s: StatusFilter) => {
    setF((x) => pressCard(x, s));
    if (window.matchMedia('(max-width: 900px)').matches) setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);   // the cards fill a phone: show what was filtered
  };
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
                    <div className="grow" style={{ textAlign: 'left' }}><div style={{ fontWeight: n.read_at ? 400 : 650 }}>{t(lang, n.title)}</div><div className="muted" style={{ fontSize: 12 }}>{n.issue_id} · {n.kind === 'status' && n.body ? t(lang, statusMeta(n.body).label) : n.body} · {dateTimeFmt(n.created_at)}</div></div>
                  </button>
                ))}
              </div>
            )}
          </Popover>
          <Button onClick={exportCsv} disabled={!filtered.length}><Download size={14} />{' '}<Tx>Export to Excel (CSV)</Tx></Button>
          <Button onClick={refresh}><RefreshCw size={14} />{' '}<Tx>Refresh</Tx></Button>
        </>} />
      {err && <div className="mb16"><Banner tone="bad"><Tx>Could not load issues:</Tx>{' '}<ErrText>{err}</ErrText></Banner></div>}
      <div className="grid g4 mb16" style={{ gridAutoRows: '1fr' }} role="group" aria-label={t(lang, 'Filter by summary card')} data-testid="feedback-cards">
        {FEEDBACK_CARDS.map((c, i) => (
          <Kpi key={c.label} label={c.label} value={ready ? counts[i] : '–'} tone={ready ? c.tone(counts[i]) : undefined} active={f.status === c.status} onClick={() => pickCard(c.status)}
            sub={c.sla ? t(lang, 'Critical {c} d · High {h} d · Medium {m} d · Low {l} d', { c: FEEDBACK_SLA_DAYS.critical, h: FEEDBACK_SLA_DAYS.high, m: FEEDBACK_SLA_DAYS.medium, l: FEEDBACK_SLA_DAYS.low }) : undefined} />
        ))}
      </div>
      <div ref={listRef} style={{ scrollMarginTop: 70 }}>
      <div className="row between wrap mb8" style={{ gap: 8, minHeight: 30 }} role="status" data-testid="feedback-showing">
        <span>{t(lang, 'Showing')}: <b>{t(lang, f.status === '' ? 'All feedback' : statusLabel(f.status))}</b>{ready && <> · {t(lang, '{n} of {m}', { n: filtered.length, m: counts[0] })}</>}{others && <span className="muted"> · {t(lang, 'with the other filters below')}</span>}</span>
        {(f.status !== '' || others) && <Button size="sm" onClick={() => setF(NO_FILTER)}><X size={13} />{' '}<Tx>Show all feedback</Tx></Button>}
      </div>
      <Card flush>
        <DataTable
          rows={filtered} rowKey={(r) => r.id} onRow={(r) => open(r.id)} pageSize={15} query={f.q} onQuery={(q) => setF((x) => ({ ...x, q }))} resetKey={JSON.stringify(f)}
          toolbar={
            <div className="row gap-6 wrap">
              <Select sm style={{ width: 'auto' }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as StatusFilter })} aria-label={t(lang, 'Status')}>
                {STATUS_OPTIONS.map((s) => <option key={s.v} value={s.v}>{t(lang, s.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} aria-label={t(lang, 'Priority')}>
                <option value="">{t(lang, 'All priorities')}</option>{FEEDBACK_PRIORITIES.map((p) => <option key={p.v} value={p.v}>{t(lang, p.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label={t(lang, 'Category')}>
                <option value="">{t(lang, 'All categories')}</option>{FEEDBACK_CATEGORIES.map((c) => <option key={c.v} value={c.v}>{t(lang, c.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} aria-label={t(lang, 'Assigned to')}>
                <option value="">{t(lang, 'Anyone')}</option><option value="me">{t(lang, 'Assigned to me')}</option><option value="none">{t(lang, 'Unassigned')}</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.display_name || s.email}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} aria-label={t(lang, 'Source')}>
                <option value="">{t(lang, 'Customers and staff')}</option><option value="customer">{t(lang, 'Customers only')}</option><option value="staff">{t(lang, 'Staff only')}</option><option value="mine">{t(lang, 'Reported by me')}</option>
              </Select>
            </div>
          }
          empty={<Empty icon={<MessageSquarePlus size={22} />} title={loading ? 'Loading…' : err && !rows.length ? 'Could not load issues:' : 'No issues match'} hint={rows.length ? 'Change the filters, or show all feedback.' : 'Feedback from the customer app and the Feedback button shows up here.'} />}
          cols={[
            { key: 'id', header: 'Issue ID', render: (r) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{r.id}</span>, sort: (r) => r.created_at },
            { key: 't', header: 'Subject', render: (r) => <div><b>{r.title}</b><div className="sub">{r.page_name}{r.module_name ? ` · ${r.module_name}` : ''}</div></div> },
            { key: 'by', header: 'Submitted by', render: (r) => <div>{r.submitter_label}<div className="sub">{t(lang, r.source === 'customer' ? 'Customer' : 'Staff')}</div></div>, hideSm: true },
            { key: 'cat', header: 'Category', render: (r) => <CategoryBadge category={r.category} />, hideSm: true },
            { key: 'pr', header: 'Priority', render: (r) => <PriorityBadge priority={r.priority} />, sort: (r) => PRIORITY_RANK[r.priority] ?? 0 },
            { key: 's', header: 'Status', render: (r) => <div className="row gap-4" style={{ flexWrap: 'wrap' }}><StatusBadge status={r.status} />{isOverdue(r) && <Badge tone="bad">{t(lang, 'Overdue')}</Badge>}</div>, sort: (r) => r.status },
            { key: 'as', header: 'Assigned to', render: (r) => staffName(r.assigned_to) || r.handler_label || <span className="muted">—</span>, hideSm: true },
            { key: 'c', header: 'Created', render: (r) => dateTimeFmt(r.created_at), sort: (r) => r.created_at, hideSm: true },
            { key: 'u', header: 'Last updated', render: (r) => dateTimeFmt(r.last_activity_at), sort: (r) => r.last_activity_at, hideSm: true },
          ]}
          initialSort={{ key: 'u', dir: 'desc' }}
        />
      </Card>
      </div>
      {openId && <IssueDrawer issueId={openId} issue={rows.find((r) => r.id === openId)} staff={staff} staffName={staffName} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

function IssueDrawer({ issueId, issue: rowIssue, staff, staffName, onClose, onChanged }: {
  issueId: string; issue?: FeedbackIssue; staff: StaffMember[]; staffName: (id: string | null) => string; onClose: () => void; onChanged: () => void;
}) {
  const lang = useLang();
  const confirm = useConfirm();
  const [th, setTh] = useState<IssueThread | null>(null);
  const [tab, setTab] = useState<'conversation' | 'internal' | 'timeline' | 'dev'>('conversation');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(''); const [msgFiles, setMsgFiles] = useState<File[]>([]); const [askInfo, setAskInfo] = useState(false);
  const [note, setNote] = useState('');
  const [rootCause, setRootCause] = useState(rowIssue?.root_cause ?? ''); const [resolution, setResolution] = useState(rowIssue?.resolution ?? '');
  const [link, setLink] = useState<{ kind: DevLinkKind; ref: string; url: string; env: string }>({ kind: 'commit', ref: '', url: '', env: '' });
  const load = useCallback(() => { getThread(issueId, true).then(setTh).catch((e) => toast('error', (e as Error).message)); }, [issueId]);
  useEffect(() => { load(); }, [load]);
  // an issue that is not in the list (it was archived, so its notifications still point to it) is read on its own; null = it cannot be opened
  const [fetched, setFetched] = useState<FeedbackIssue | null | undefined>(undefined);
  const loadIssue = useCallback(() => { getIssue(issueId).then(setFetched).catch((e) => { toast('error', (e as Error).message); setFetched(null); }); }, [issueId]);
  useEffect(() => { if (!rowIssue) loadIssue(); }, [rowIssue, loadIssue]);
  const issue = rowIssue ?? fetched ?? undefined;
  useEffect(() => { setRootCause(issue?.root_cause ?? ''); setResolution(issue?.resolution ?? ''); }, [issue?.root_cause, issue?.resolution]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast('success', t(lang, ok)); load(); onChanged(); if (!rowIssue) loadIssue(); return true; }
    catch (e) { toast('error', (e as Error).message); return false; }
    finally { setBusy(false); }
  };
  if (!issue) return (
    <Drawer title={issueId} onClose={onClose}>
      {fetched === null ? <Banner tone="warn"><Tx>This issue could not be opened. It may not exist, or you may not have access to it.</Tx></Banner> : <div className="center" style={{ padding: 20 }}><div className="spinner" /></div>}
    </Drawer>
  );

  const changeStatus = async (to: FeedbackStatus) => {
    let reason: string | undefined;
    if (to === 'resolved' && !resolution.trim()) { toast('error', t(lang, 'Write the resolution first: what was changed, fixed or completed. The reporter sees it.')); return; }
    const reopening = (issue.status === 'closed' || issue.status === 'resolved' || issue.status === 'rejected') && to !== 'closed';
    if (to === 'rejected' || to === 'closed' || to === 'waiting_info' || to === 'resolved' || reopening) {
      const reasonLabel = to === 'rejected' ? t(lang, 'Reason (shown to the customer)') : to === 'closed' ? t(lang, 'Closing note (shown to the reporter, optional)') : reopening ? t(lang, 'Why it is reopened (shown to the reporter, optional)') : false;
      const r = await confirm({
        title: t(lang, 'Change status to "{s}"?', { s: t(lang, statusMeta(to).label) }),
        body: to === 'rejected' ? t(lang, 'The customer will see this reason.')
          : to === 'resolved' ? <><div>{t(lang, 'The reporter is notified and sees this resolution:')}</div><div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}><b>{resolution}</b></div></>
          : to === 'closed' ? t(lang, 'Closing officially completes the issue. The reporter is notified and can no longer reply; it can be reopened later if needed.') : undefined,
        reason: reasonLabel, reasonOptional: to !== 'rejected', confirmLabel: t(lang, 'Change status'),
      });
      if (!r.ok) return;
      reason = r.reason || undefined;
    }
    await run(() => staffUpdate(issue.id, { status: to, reason, resolution: to === 'resolved' ? resolution : undefined }), 'Status updated');
  };
  const issueFiles = (th?.attachments ?? []).filter((a) => !a.comment_id);   // what came with the original report (comment attachments stay in the conversation)
  const conversation = (th?.comments ?? []).filter((c) => c.kind !== 'internal');
  const internal = (th?.comments ?? []).filter((c) => c.kind === 'internal');
  const closeNote = closingNote(th?.events ?? [], issue.status);

  return (
    <Drawer title={<><span className="mono muted" style={{ fontSize: 13 }}>{issue.id}</span> {issue.title}</>} sub={`${issue.submitter_label} · ${dateTimeFmt(issue.created_at)}`} onClose={onClose}>
      <div className="col gap-16">
        {issue.archived_at && <Banner tone="warn"><Tx>This issue is archived. It is hidden from the list but never deleted.</Tx> {dateTimeFmt(issue.archived_at)}</Banner>}
        <div className="row wrap" style={{ gap: 8 }}><StatusBadge status={issue.status} /><PriorityBadge priority={issue.priority} /><CategoryBadge category={issue.category} /></div>
        <OriginalFeedbackCard issue={issue} />
        <EnglishContextCard issue={issue} attachments={issueFiles} onChanged={onChanged} />
        <EvidenceCard attachments={issueFiles} loading={!th} />

        <Card title="Resolution & closure">
          <KV items={[
            ['Status', <StatusBadge key="s" status={issue.status} />],
            ['Last status change', issue.status_changed_at ? dateTimeFmt(issue.status_changed_at) : '—'],
            ['Handled by', staffName(issue.assigned_to) || issue.handler_label || '—'],
            ['Resolved', issue.resolved_at && (issue.status === 'resolved' || issue.status === 'closed') ? `${dateTimeFmt(issue.resolved_at)}${issue.resolved_by_label ? ' · ' + issue.resolved_by_label : ''}` : '—'],
            ['Closed', issue.closed_at ? `${dateTimeFmt(issue.closed_at)}${issue.closed_by_label ? ' · ' + issue.closed_by_label : ''}` : '—'],
            ...(closeNote ? [[issue.status === 'rejected' ? 'Reason' : 'Closing note', closeNote] as [string, string]] : []),
          ]} />
          <div className="row wrap mt8" style={{ gap: 8 }}>
            {NEXT_STATUSES[issue.status].includes('in_progress') && <Button size="sm" disabled={busy} onClick={() => changeStatus('in_progress')}><Tx>Start work (In progress)</Tx></Button>}
            {NEXT_STATUSES[issue.status].includes('resolved') && <Button size="sm" variant="primary" disabled={busy} onClick={() => changeStatus('resolved')}><Tx>Mark resolved</Tx></Button>}
            {NEXT_STATUSES[issue.status].includes('closed') && <Button size="sm" variant="primary" disabled={busy} onClick={() => changeStatus('closed')}><Tx>Close issue</Tx></Button>}
          </div>
          {NEXT_STATUSES[issue.status].includes('resolved') && <div className="muted mt8" style={{ fontSize: 12 }}><Tx>Write the resolution in the Workflow card below before marking the issue resolved.</Tx></div>}
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
                {issue.assigned_to && !staff.some((s) => s.id === issue.assigned_to) && <option value={issue.assigned_to}>{issue.handler_label || '—'} {t(lang, '(no longer active)')}</option>}
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
