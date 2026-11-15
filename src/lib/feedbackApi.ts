// Feedback & Issue system: one Supabase-backed tracker shared by the customer app (LINE members) and the
// back office. Every call runs as the signed-in user (supabase-js session), so Postgres RLS decides what each
// person can read; every write goes through a SECURITY DEFINER function that takes identity from auth.uid()
// and enforces the workflow (supabase/migrations/20261114120000_feedback_issue_system.sql). Nothing here can
// widen access: a customer who edits the URL or calls these functions directly still sees only their own issues.
import { supabase } from './supabase';
import { translateInBrowser, translatorState } from './feedbackTranslate';

declare const __APP_VERSION__: string | undefined;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export type FeedbackStatus = 'submitted' | 'under_review' | 'accepted' | 'in_progress' | 'waiting_info' | 'resolved' | 'closed' | 'rejected';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';
export type FeedbackCategory = 'bug' | 'feature_request' | 'general' | 'ui_ux' | 'data_issue' | 'other';
export type CommentKind = 'internal' | 'reply' | 'customer';
export type EnglishContextStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type DevLinkKind = 'project' | 'module' | 'branch' | 'commit' | 'pull_request' | 'release' | 'deployment';
type Tone = 'good' | 'warn' | 'bad' | 'info' | 'serious' | '';

export interface FeedbackIssue {
  id: string; title: string; description: string; category: FeedbackCategory; priority: FeedbackPriority; status: FeedbackStatus;
  source: 'staff' | 'customer'; app_id: string; reporter_id: string | null; submitter_label: string; assigned_to: string | null;
  page_name: string; page_path: string; module_name: string | null; environment: string; browser_info: string;
  os_info: string | null; device_type: string | null; app_version: string | null;
  root_cause: string | null; resolution: string | null; remark: string | null;
  created_at: string; updated_at: string; last_activity_at: string; resolved_at: string | null; archived_at: string | null;
  // English technical context (migration 20261115600000): absent/null on issues that were never processed; the description above is never changed by it
  english_context?: string | null; english_context_status?: EnglishContextStatus; english_context_error?: string | null; english_context_at?: string | null;
  english_context_source?: 'ai' | 'manual' | 'translation' | null; english_context_model?: string | null; english_context_attempts?: number; english_context_started_at?: string | null;
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

export const COPY_LINK_TTL_SECONDS = 24 * 60 * 60;
/** A short-lived signed link (the bucket is private). `download` makes the browser save the file under that name instead of showing it. */
export async function attachmentUrl(path: string, opts: { expiresIn?: number; download?: string } = {}): Promise<string> {
  const { data, error } = await supabase.storage.from('feedback-attachments').createSignedUrl(path, opts.expiresIn ?? 300, opts.download ? { download: opts.download } : undefined);
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

// ------------------------------------------------------------------------------------------------ English technical context
// The English version is produced by the Edge Function feedback-english-context (it holds the AI key; the browser never sees one). Submitting
// feedback never waits for it and never fails because of it: the issue is saved first, the generation is asked for afterwards.
export interface ContextResult { status: EnglishContextStatus; error?: string; already?: boolean }

/** Asks the server to generate (or regenerate) the English context. Never throws: a problem comes back as { status: 'failed', error: 'CODE: message' }. */
export async function requestEnglishContext(issueId: string): Promise<ContextResult> {
  try {
    const { data, error } = await supabase.functions.invoke('feedback-english-context', { body: { issue_id: issueId } });
    if (!error) return (data ?? { status: 'failed', error: 'AI_UNAVAILABLE: empty answer' }) as ContextResult;
    const res = (error as { context?: Response }).context;
    const body = res && typeof res.json === 'function' ? await res.json().catch(() => null) as { error?: string } | null : null;
    if (body?.error) return { status: 'failed', error: String(body.error) };
    if (res?.status === 404) return { status: 'failed', error: 'AI_NOT_DEPLOYED: the English-context service is not installed yet' };
    return { status: 'failed', error: 'AI_UNAVAILABLE: the English-context service could not be reached' };
  } catch (e) {
    return { status: 'failed', error: `AI_UNAVAILABLE: ${(e as Error).message}` };
  }
}

/**
 * Staff save the English text (kept apart from the original description, which is never touched): typed by hand ('manual', the default) or the
 * plain translation made in this browser ('translation'). Only a translation sends the source, so a database without that option still takes hand-written text.
 */
export async function setEnglishContext(issueId: string, text: string, source: 'manual' | 'translation' = 'manual'): Promise<FeedbackIssue> {
  const args: Record<string, unknown> = { p_issue: issueId, p_context: text };
  if (source !== 'manual') args.p_source = source;
  const { data, error } = await supabase.rpc('feedback_set_english_context', args);
  fail(error);
  return data as FeedbackIssue;
}

/**
 * After a staff member submits feedback: if the Thai language pack is already on this computer, translate the report and save it (never throws, never
 * blocks the submission). If the pack still has to be downloaded the translation waits: it needs a click in the issue screen.
 */
export async function autoTranslateIssue(issue: Pick<FeedbackIssue, 'id' | 'title' | 'description'>): Promise<boolean> {
  try {
    if ((await translatorState()) !== 'available') return false;
    await setEnglishContext(issue.id, await translateInBrowser(issue), 'translation');
    return true;
  } catch { return false; }
}

/** A generation that has been "processing" for more than 5 minutes has died (the database allows a new one after the same time). */
export const CONTEXT_STALE_MS = 5 * 60 * 1000;
export function contextState(i: Pick<FeedbackIssue, 'english_context_status' | 'english_context_started_at' | 'english_context_error'>, now = Date.now()): { status: EnglishContextStatus; error: string | null } {
  const status = i.english_context_status ?? 'pending';
  if (status === 'processing') {
    const started = i.english_context_started_at ? Date.parse(i.english_context_started_at) : 0;
    if (!started || now - started > CONTEXT_STALE_MS) return { status: 'failed', error: 'AI_TIMEOUT: the previous attempt did not finish' };
  }
  return { status, error: i.english_context_error ?? null };
}

/** Thai / English / both, from the share of Thai letters: only used to label the original text, never to change it. */
export function detectLanguage(text: string): 'th' | 'en' | 'mixed' | 'unknown' {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 'unknown';
  const thai = letters.filter((c) => /[\u0E00-\u0E7F]/.test(c)).length / letters.length;
  return thai >= 0.6 ? 'th' : thai <= 0.05 ? 'en' : 'mixed';
}

/** The nine sections of the English context, in order (the Edge Function produces exactly these; tests/unit/feedbackContext.test.ts keeps both lists equal). */
export const ENGLISH_CONTEXT_SECTIONS = ['Issue Title', 'Background', 'Problem Description', 'Expected Behavior', 'Actual Behavior', 'Impact', 'Technical Evidence', 'Implementation Requirements', 'Acceptance Criteria'] as const;
/** A starting point for writing the English context by hand. */
export const englishContextTemplate = () => ENGLISH_CONTEXT_SECTIONS.map((s) => `## ${s}\nNot provided`).join('\n\n');

/** Splits a stored English context into its "## Heading" sections for display; null when it has none (e.g. free text written by hand). */
export function parseContext(text: string | null | undefined): { title: string; body: string }[] | null {
  const src = (text ?? '').replace(/\r\n/g, '\n');
  const parts = src.split(/^## +(.+?) *$/m);
  if (parts.length < 3) return null;
  const out: { title: string; body: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ title: parts[i], body: (parts[i + 1] ?? '').trim() });
  return out;
}

/** Text for "Copy English Context": exactly what is stored (headings and bullets included), nothing added. */
export const englishContextCopy = (i: Pick<FeedbackIssue, 'english_context'>) => (i.english_context ?? '').trim();

export interface CopyAttachment { file_name: string; mime_type: string; size_bytes: number; created_at: string; url: string }
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Text for "Copy Context + Attachments": the English context followed by a list of the attached files with private links. The images are NOT
 * embedded in the text and the text says so; the links stop working after COPY_LINK_TTL_SECONDS.
 */
export function contextWithAttachments(issue: Pick<FeedbackIssue, 'id' | 'english_context'>, atts: CopyAttachment[], now = new Date()): string {
  const expires = new Date(now.getTime() + COPY_LINK_TTL_SECONDS * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const head = atts.length
    ? [`## Attachments (${atts.length})`, `These files are attached to issue ${issue.id}. They are NOT embedded in this text: open each link to view the file. The links are private and stop working after ${expires}.`]
    : ['## Attachments', `No files are attached to issue ${issue.id}.`];
  const lines = atts.map((a, i) => `${i + 1}. ${a.file_name} (${a.mime_type}, ${kb(a.size_bytes)}, uploaded ${a.created_at.slice(0, 10)}) - ${a.url}`);
  return [englishContextCopy(issue), '', ...head, ...lines].join('\n').trim() + '\n';
}

/** Signed links (24 h) for the attachments of an issue, for "Copy Context + Attachments". Files whose link cannot be made are listed without one. */
export async function attachmentsForCopy(items: FeedbackAttachment[]): Promise<CopyAttachment[]> {
  return Promise.all(items.map(async (a) => ({
    file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes, created_at: a.created_at,
    url: await attachmentUrl(a.storage_path, { expiresIn: COPY_LINK_TTL_SECONDS }).catch(() => '(link unavailable)'),
  })));
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
