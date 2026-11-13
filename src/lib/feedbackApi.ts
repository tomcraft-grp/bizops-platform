// Centralized feedback store: a real Supabase table (not the local per-browser IndexedDB "DB" the
// rest of this prototype uses), so every tester's submission lands in one place the whole team can see.
//
// DEMO/UAT LIMITATION (documented, not hidden): this prototype has no real server-side authentication,
// so there is no server-side identity to scope RLS to. Access control for who may change status/priority/
// add notes is enforced client-side (see FeedbackIssues.tsx's `feedback:manage` check) using the same
// local role-switcher as the rest of the app. The anon key below is public by design (shipped in the
// bundle) and the table's RLS policies allow the anon role to read/insert/update — anyone with this link
// who opens devtools could call the API directly. Acceptable for a controlled beta/UAT phase; would need
// real auth + RLS scoped to a real user identity before this could hold genuinely sensitive feedback.

const SUPABASE_URL = 'https://hlvravynjalculvplrxc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_H2G8TT0QzfwUPI7HsqDT1g_sBlEJa5V';
const TABLE = 'bizops_feedback_issues';

export type FeedbackStatus = 'new' | 'reviewing' | 'in_progress' | 'need_info' | 'completed' | 'rejected';
export type FeedbackPriority = 'low' | 'medium' | 'high' | 'critical';
export type FeedbackCategory = 'feature_request' | 'bug' | 'ui_ux' | 'performance' | 'question' | 'other';
export interface FeedbackNote { id: string; ts: string; by: string; text: string }
export interface FeedbackIssue {
  id: string; title: string; description: string; remark: string | null; category: FeedbackCategory;
  page_name: string; page_path: string; page_url: string;
  module_name: string | null; feature_name: string | null; function_identifier: string | null;
  submitter_label: string; environment: string; browser_info: string; device_info: string;
  status: FeedbackStatus; priority: FeedbackPriority; notes: FeedbackNote[];
  idempotency_key: string | null; created_at: string; updated_at: string; resolved_at: string | null;
}

export const FEEDBACK_STATUSES: { v: FeedbackStatus; label: string }[] = [
  { v: 'new', label: 'New' }, { v: 'reviewing', label: 'Reviewing' }, { v: 'in_progress', label: 'In progress' },
  { v: 'need_info', label: 'Need more information' }, { v: 'completed', label: 'Completed' }, { v: 'rejected', label: 'Rejected' },
];
export const FEEDBACK_PRIORITIES: { v: FeedbackPriority; label: string }[] = [
  { v: 'low', label: 'Low' }, { v: 'medium', label: 'Medium' }, { v: 'high', label: 'High' }, { v: 'critical', label: 'Critical' },
];
export const FEEDBACK_CATEGORIES: { v: FeedbackCategory; label: string }[] = [
  { v: 'feature_request', label: 'Feature request / requirement' }, { v: 'bug', label: 'Bug report' },
  { v: 'ui_ux', label: 'UI/UX feedback' }, { v: 'performance', label: 'Performance problem' },
  { v: 'question', label: 'Question' }, { v: 'other', label: 'General suggestion' },
];

function headers(extra?: Record<string, string>) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...extra };
}
async function must(r: Response, action: string): Promise<Response> {
  if (!r.ok) throw new Error(`${action} failed (HTTP ${r.status}): ${await r.text().catch(() => '')}`);
  return r;
}

export async function listFeedback(): Promise<FeedbackIssue[]> {
  const r = await must(await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=*&order=created_at.desc`, { headers: headers() }), 'Load feedback');
  return r.json();
}

export interface SubmitFeedbackInput {
  description: string; remark?: string; category: FeedbackCategory; pageName: string; pagePath: string; pageUrl: string;
  moduleName?: string; featureName?: string; functionIdentifier?: string; submitterLabel: string;
  environment: string; browserInfo: string; deviceInfo: string; idempotencyKey: string;
}
export async function submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackIssue> {
  const dupe = await must(await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?idempotency_key=eq.${encodeURIComponent(input.idempotencyKey)}&select=*`, { headers: headers() }), 'Check duplicate feedback');
  const existing: FeedbackIssue[] = await dupe.json();
  if (existing.length) return existing[0];

  const description = input.description.trim().slice(0, 5000);
  if (!description) throw new Error('Please describe the issue or request before submitting.');
  const now = new Date().toISOString();
  const row = {
    id: `FB${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    title: description.length > 80 ? description.slice(0, 77) + '…' : description,
    description, remark: input.remark?.trim().slice(0, 2000) || null, category: input.category,
    page_name: input.pageName, page_path: input.pagePath, page_url: input.pageUrl,
    module_name: input.moduleName ?? null, feature_name: input.featureName ?? null, function_identifier: input.functionIdentifier ?? null,
    submitter_label: input.submitterLabel, environment: input.environment, browser_info: input.browserInfo.slice(0, 500), device_info: input.deviceInfo.slice(0, 200),
    status: 'new' as const, priority: 'medium' as const, notes: [] as FeedbackNote[],
    idempotency_key: input.idempotencyKey, created_at: now, updated_at: now, resolved_at: null,
  };
  const r = await must(await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, { method: 'POST', headers: headers({ Prefer: 'return=representation' }), body: JSON.stringify(row) }), 'Submit feedback');
  const rows: FeedbackIssue[] = await r.json();
  return rows[0];
}

export async function setFeedbackStatus(id: string, status: FeedbackStatus): Promise<void> {
  await must(await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ status, resolved_at: status === 'completed' || status === 'rejected' ? new Date().toISOString() : null, updated_at: new Date().toISOString() }),
  }), 'Update status');
}
export async function setFeedbackPriority(id: string, priority: FeedbackPriority): Promise<void> {
  await must(await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ priority, updated_at: new Date().toISOString() }),
  }), 'Update priority');
}
export async function addFeedbackNote(issue: FeedbackIssue, by: string, text: string): Promise<void> {
  const t = text.trim().slice(0, 2000);
  if (!t) throw new Error('Note cannot be empty.');
  const notes = [...issue.notes, { id: `FBN${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), by, text: t }];
  await must(await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(issue.id)}`, {
    method: 'PATCH', headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ notes, updated_at: new Date().toISOString() }),
  }), 'Add note');
}
