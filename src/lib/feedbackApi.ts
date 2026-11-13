// Feedback & Issue system: one Supabase-backed tracker shared by the customer app (LINE members) and the
// back office. Every call runs as the signed-in user (supabase-js session), so Postgres RLS decides what each
// person can read; every write goes through a SECURITY DEFINER function that takes identity from auth.uid()
// and enforces the workflow (supabase/migrations/20261114120000_feedback_issue_system.sql). Nothing here can
// widen access: a customer who edits the URL or calls these functions directly still sees only their own issues.
import { supabase } from './supabase';

declare const __APP_VERSION__: string | undefined;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export type FeedbackStatus = 'submitted' | 'under_review' | 'accepted' | 'in_progress' | 'waiting_info' | 'resolved' | 'closed' | 'rejected';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';
export type FeedbackCategory = 'bug' | 'feature_request' | 'general' | 'ui_ux' | 'data_issue' | 'other';
export type CommentKind = 'internal' | 'reply' | 'customer';
export type DevLinkKind = 'project' | 'module' | 'branch' | 'commit' | 'pull_request' | 'release' | 'deployment';
type Tone = 'good' | 'warn' | 'bad' | 'info' | 'serious' | '';

export interface FeedbackIssue {
  id: string; title: string; description: string; category: FeedbackCategory; priority: FeedbackPriority; status: FeedbackStatus;
  source: 'staff' | 'customer'; app_id: string; reporter_id: string | null; submitter_label: string; assigned_to: string | null;
  page_name: string; page_path: string; module_name: string | null; environment: string; browser_info: string;
  os_info: string | null; device_type: string | null; app_version: string | null;
  root_cause: string | null; resolution: string | null; remark: string | null;
  created_at: string; updated_at: string; last_activity_at: string; resolved_at: string | null; archived_at: string | null;
}
export interface FeedbackComment { id: string; issue_id: string; author_id: string | null; author_label: string; kind: CommentKind; body: string; requests_info: boolean; created_at: string }
export interface FeedbackAttachment { id: string; issue_id: string; comment_id: string | null; storage_path: string; file_name: string; mime_type: string; size_bytes: number; created_at: string }
export interface FeedbackEvent { id: number; issue_id: string; actor_label: string; kind: string; from_value: string | null; to_value: string | null; note: string | null; customer_visible: boolean; created_at: string }
export interface FeedbackDevLink { id: string; issue_id: string; kind: DevLinkKind; ref: string; url: string | null; environment: string | null; created_at: string }
export interface FeedbackNotification { id: string; issue_id: string; kind: string; title: string; body: string | null; read_at: string | null; created_at: string }
export interface StaffMember { id: string; display_name: string | null; email: string; role: string }

// Labels are English source strings; Thai comes from the shared dictionary via t()/Tx (lib/i18n.feedback.ts).
export const FEEDBACK_CATEGORIES: { v: FeedbackCategory; label: string; hint: string; tone: Tone }[] = [
  { v: 'bug', label: 'Bug report', hint: 'Something is broken or behaves unexpectedly', tone: 'bad' },
  { v: 'feature_request', label: 'Feature request', hint: 'A new feature or an improvement', tone: 'info' },
  { v: 'general', label: 'General feedback', hint: 'Opinions or general comments', tone: '' },
  { v: 'ui_ux', label: 'UI/UX improvement', hint: 'Make a screen easier or nicer to use', tone: 'warn' },
  { v: 'data_issue', label: 'Data issue', hint: 'Information is wrong, missing or inconsistent', tone: 'serious' },
  { v: 'other', label: 'Other', hint: 'Anything else', tone: '' },
];
export const FEEDBACK_STATUSES: { v: FeedbackStatus; label: string; tone: Tone }[] = [
  { v: 'submitted', label: 'Submitted', tone: 'info' },
  { v: 'under_review', label: 'Under review', tone: 'warn' },
  { v: 'accepted', label: 'Accepted', tone: 'info' },
  { v: 'in_progress', label: 'In progress', tone: 'warn' },
  { v: 'waiting_info', label: 'Waiting for information', tone: 'serious' },
  { v: 'resolved', label: 'Resolved', tone: 'good' },
  { v: 'closed', label: 'Closed', tone: '' },
  { v: 'rejected', label: 'Rejected', tone: '' },
];
export const FEEDBACK_PRIORITIES: { v: FeedbackPriority; label: string; tone: Tone }[] = [
  { v: 'low', label: 'Low', tone: '' }, { v: 'medium', label: 'Medium', tone: 'info' },
  { v: 'high', label: 'High', tone: 'warn' }, { v: 'critical', label: 'Critical', tone: 'bad' },
];
export const DEV_LINK_KINDS: { v: DevLinkKind; label: string }[] = [
  { v: 'project', label: 'Project' }, { v: 'module', label: 'Module' }, { v: 'branch', label: 'Git branch' }, { v: 'commit', label: 'Commit' },
  { v: 'pull_request', label: 'Pull request' }, { v: 'release', label: 'Release version' }, { v: 'deployment', label: 'Deployment' },
];
export const OPEN_STATUSES: FeedbackStatus[] = ['submitted', 'under_review', 'accepted', 'in_progress', 'waiting_info'];

/** Mirrors public.feedback_transition_ok (the server is the authority; this only shapes the UI). */
export const NEXT_STATUSES: Record<FeedbackStatus, FeedbackStatus[]> = {
  submitted: ['under_review', 'accepted', 'in_progress', 'waiting_info', 'rejected'],
  under_review: ['accepted', 'in_progress', 'waiting_info', 'rejected'],
  accepted: ['in_progress', 'waiting_info', 'rejected'],
  in_progress: ['waiting_info', 'resolved', 'accepted'],
  waiting_info: ['under_review', 'in_progress', 'rejected'],
  resolved: ['closed', 'in_progress'],
  closed: ['under_review'],
  rejected: ['under_review'],
};

export const statusMeta = (s: string) => FEEDBACK_STATUSES.find((x) => x.v === s) ?? { v: s as FeedbackStatus, label: s, tone: '' as Tone };
export const priorityMeta = (p: string) => FEEDBACK_PRIORITIES.find((x) => x.v === p) ?? { v: p as FeedbackPriority, label: p, tone: '' as Tone };
export const categoryMeta = (c: string) => FEEDBACK_CATEGORIES.find((x) => x.v === c) ?? { v: c as FeedbackCategory, label: c, hint: '', tone: '' as Tone };

// ------------------------------------------------------------------------------------------------ context
/** What the system captures by itself. Only the path is sent (the server strips query strings and tokens too). */
export function captureContext() {
  const ua = navigator.userAgent;
  const os = /Android\s[\d.]+/.exec(ua)?.[0] ?? /iPhone OS [\d_]+|iPad; CPU OS [\d_]+/.exec(ua)?.[0]?.replace(/_/g, '.') ?? /Windows NT [\d.]+/.exec(ua)?.[0]
    ?? /Mac OS X [\d_]+/.exec(ua)?.[0]?.replace(/_/g, '.') ?? (/Linux/.test(ua) ? 'Linux' : 'Unknown');
  const deviceType = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  const hashPath = window.location.hash.replace(/^#/, '').split('?')[0];
  return { pagePath: hashPath || window.location.pathname, browser: ua.slice(0, 300), os, deviceType, appVersion: APP_VERSION, environment: import.meta.env.MODE };
}

// ------------------------------------------------------------------------------------------------ attachments
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
const ALLOWED: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const ATTACHMENT_ACCEPT = Object.keys(ALLOWED).join(',');

/** Returns an English error message (translate with t()) or null when the file is acceptable. */
export function checkAttachment(f: File): string | null {
  if (!ALLOWED[f.type]) return 'Only PNG, JPG, WebP images or PDF files can be attached';
  if (f.size > MAX_ATTACHMENT_BYTES) return 'Each file must be 10 MB or smaller';
  if (f.size === 0) return 'The file is empty';
  return null;
}

async function uploadAttachments(issueId: string, files: File[], commentId?: string): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files.slice(0, MAX_ATTACHMENTS)) {
    if (checkAttachment(f)) { failed.push(f.name); continue; }
    const path = `${issueId}/${crypto.randomUUID()}.${ALLOWED[f.type]}`;
    const up = await supabase.storage.from('feedback-attachments').upload(path, f, { contentType: f.type, upsert: false });
    if (up.error) { failed.push(f.name); continue; }
    const rec = await supabase.rpc('feedback_add_attachment', { p_issue: issueId, p_path: path, p_name: f.name.slice(0, 200), p_mime: f.type, p_size: f.size, p_comment: commentId ?? null });
    if (rec.error) failed.push(f.name);
  }
  return failed;
}

export async function attachmentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('feedback-attachments').createSignedUrl(path, 300);
  if (error || !data) throw new Error(error?.message ?? 'Could not open the file');
  return data.signedUrl;
}

// ------------------------------------------------------------------------------------------------ calls
const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

export interface SubmitInput {
  category: FeedbackCategory; subject: string; description: string; priority: FeedbackPriority;
  pageName?: string; module?: string; appId: 'line-liff' | 'backoffice'; idempotencyKey: string; files?: File[];
}
/** Creates the issue, then uploads attachments. Returns the issue and the names of any files that failed. */
export async function submitFeedback(i: SubmitInput): Promise<{ issue: FeedbackIssue; failedFiles: string[] }> {
  const ctx = captureContext();
  const { data, error } = await supabase.rpc('feedback_submit', {
    p_category: i.category, p_subject: i.subject, p_description: i.description, p_priority: i.priority,
    p_page_path: ctx.pagePath, p_page_name: i.pageName ?? null, p_module: i.module ?? null, p_app_id: i.appId,
    p_app_version: ctx.appVersion, p_environment: ctx.environment, p_browser: ctx.browser, p_os: ctx.os,
    p_device_type: ctx.deviceType, p_idempotency_key: i.idempotencyKey,
  });
  fail(error);
  const issue = data as FeedbackIssue;
  const failedFiles = i.files?.length ? await uploadAttachments(issue.id, i.files) : [];
  return { issue, failedFiles };
}

/** RLS returns only the caller's own issues for customers, and everything for staff. */
export async function listFeedback(opts: { includeArchived?: boolean } = {}): Promise<FeedbackIssue[]> {
  let q = supabase.from('bizops_feedback_issues').select('*').order('last_activity_at', { ascending: false }).limit(1000);
  if (!opts.includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q;
  fail(error);
  return (data ?? []) as FeedbackIssue[];
}

export interface IssueThread { comments: FeedbackComment[]; attachments: FeedbackAttachment[]; events: FeedbackEvent[]; links: FeedbackDevLink[] }
export async function getThread(issueId: string, staff: boolean): Promise<IssueThread> {
  const [c, a, e, l] = await Promise.all([
    supabase.from('feedback_comments').select('*').eq('issue_id', issueId).order('created_at'),
    supabase.from('feedback_attachments').select('*').eq('issue_id', issueId).order('created_at'),
    supabase.from('feedback_events').select('*').eq('issue_id', issueId).order('id'),
    staff ? supabase.from('feedback_dev_links').select('*').eq('issue_id', issueId).order('created_at') : Promise.resolve({ data: [], error: null }),
  ]);
  fail(c.error); fail(a.error); fail(e.error); fail(l.error);
  return { comments: (c.data ?? []) as FeedbackComment[], attachments: (a.data ?? []) as FeedbackAttachment[], events: (e.data ?? []) as FeedbackEvent[], links: (l.data ?? []) as FeedbackDevLink[] };
}

export async function customerMessage(issueId: string, body: string, files: File[] = []): Promise<string[]> {
  const { data, error } = await supabase.rpc('feedback_customer_message', { p_issue: issueId, p_body: body });
  fail(error);
  return files.length ? uploadAttachments(issueId, files, (data as FeedbackComment).id) : [];
}

export async function staffComment(issueId: string, kind: 'internal' | 'reply', body: string, requestsInfo = false, files: File[] = []): Promise<string[]> {
  const { data, error } = await supabase.rpc('feedback_staff_comment', { p_issue: issueId, p_kind: kind, p_body: body, p_requests_info: requestsInfo });
  fail(error);
  return files.length ? uploadAttachments(issueId, files, (data as FeedbackComment).id) : [];
}

export async function staffUpdate(issueId: string, p: { status?: FeedbackStatus; priority?: FeedbackPriority; category?: FeedbackCategory; assignedTo?: string | null; rootCause?: string; resolution?: string; reason?: string }): Promise<FeedbackIssue> {
  const { data, error } = await supabase.rpc('feedback_staff_update', {
    p_issue: issueId, p_status: p.status ?? null, p_priority: p.priority ?? null, p_category: p.category ?? null,
    p_assigned_to: p.assignedTo ?? null, p_unassign: p.assignedTo === null,
    p_root_cause: p.rootCause ?? null, p_resolution: p.resolution ?? null, p_reason: p.reason ?? null,
  });
  fail(error);
  return data as FeedbackIssue;
}

export async function addDevLink(issueId: string, kind: DevLinkKind, ref: string, url?: string, environment?: string): Promise<void> {
  const { error } = await supabase.rpc('feedback_add_dev_link', { p_issue: issueId, p_kind: kind, p_ref: ref, p_url: url || null, p_environment: environment || null });
  fail(error);
}

export async function archiveIssue(issueId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('feedback_archive', { p_issue: issueId, p_reason: reason });
  fail(error);
}

export async function listStaff(): Promise<StaffMember[]> {
  const { data, error } = await supabase.rpc('feedback_staff_list');
  fail(error);
  return (data ?? []) as StaffMember[];
}

export async function listNotifications(limit = 30): Promise<FeedbackNotification[]> {
  const { data, error } = await supabase.from('feedback_notifications').select('*').order('created_at', { ascending: false }).limit(limit);
  fail(error);
  return (data ?? []) as FeedbackNotification[];
}
export async function markNotificationsRead(ids?: string[]): Promise<void> {
  const { error } = await supabase.rpc('feedback_mark_read', { p_ids: ids ?? null });
  fail(error);
}

/** CSV (UTF-8 with BOM, so Excel shows Thai correctly) of the given issues. */
export function issuesToCsv(rows: FeedbackIssue[], staffName: (id: string | null) => string): string {
  const head = ['Issue ID', 'Subject', 'Category', 'Priority', 'Status', 'Source', 'Submitted by', 'Assigned to', 'Page', 'Module', 'Created', 'Last updated', 'Resolved', 'Root cause', 'Resolution'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map((r) => [r.id, r.title, r.category, r.priority, r.status, r.source, r.submitter_label, staffName(r.assigned_to), r.page_path, r.module_name, r.created_at, r.last_activity_at, r.resolved_at, r.root_cause, r.resolution].map(esc).join(','));
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}
