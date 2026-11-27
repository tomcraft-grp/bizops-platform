// Filters of Feedback & Issue Management. The summary cards and the Status box are the SAME filter (one value), so they can never disagree; priority, category, assignee, source and search are
// separate and work on top of it. A card shows how many issues its click would list: its number always equals the length of the list it opens.
import { FEEDBACK_STATUSES, type FeedbackIssue, type FeedbackStatus, isOverdue, OPEN_STATUSES } from './feedbackApi';

/** '' = all. The groups are what the cards stand for; the rest is one exact status. */
export type StatusFilter = '' | 'open' | 'unresolved' | 'overdue' | 'in_work' | 'done' | 'critical_open' | FeedbackStatus;
export interface FeedbackFilter { status: StatusFilter; priority: string; category: string; assignee: string; source: string; q: string }
export const NO_FILTER: FeedbackFilter = { status: '', priority: '', category: '', assignee: '', source: '', q: '' };

type Row = Pick<FeedbackIssue, 'id' | 'title' | 'description' | 'submitter_label' | 'page_name' | 'module_name' | 'status' | 'priority' | 'category' | 'source' | 'reporter_id' | 'assigned_to' | 'created_at'>;

export function matchesStatus(r: Row, s: StatusFilter, now = Date.now()): boolean {
  switch (s) {
    case '': return true;
    case 'open': return OPEN_STATUSES.includes(r.status);
    case 'unresolved': return r.status !== 'closed' && r.status !== 'rejected';
    case 'overdue': return isOverdue(r, now);
    case 'in_work': return r.status === 'in_progress' || r.status === 'accepted';
    case 'done': return r.status === 'resolved' || r.status === 'closed';
    case 'critical_open': return r.priority === 'critical' && OPEN_STATUSES.includes(r.status);
    default: return r.status === s;
  }
}
/** Everything except the status. */
export function matchesRest(r: Row, f: FeedbackFilter, myId: string | null): boolean {
  if (f.priority && r.priority !== f.priority) return false;
  if (f.category && r.category !== f.category) return false;
  if (f.source && !(f.source === 'mine' ? !!myId && r.reporter_id === myId : r.source === f.source)) return false;
  if (f.assignee && !(f.assignee === 'none' ? !r.assigned_to : f.assignee === 'me' ? !!myId && r.assigned_to === myId : r.assigned_to === f.assignee)) return false;
  const q = f.q.trim().toLowerCase();
  return !q || `${r.id} ${r.title} ${r.description} ${r.submitter_label} ${r.page_name} ${r.module_name ?? ''}`.toLowerCase().includes(q);
}
export const applyFilter = <T extends Row>(rows: T[], f: FeedbackFilter, myId: string | null, now = Date.now()): T[] => rows.filter((r) => matchesRest(r, f, myId) && matchesStatus(r, f.status, now));

export interface FeedbackCard { status: StatusFilter; label: string; tone: (n: number) => 'good' | 'bad' | undefined; sla?: boolean }
export const FEEDBACK_CARDS: FeedbackCard[] = [
  { status: '', label: 'Total feedback', tone: () => undefined },
  { status: 'submitted', label: 'New (submitted)', tone: (n) => (n ? 'bad' : 'good') },
  { status: 'under_review', label: 'Under review', tone: () => undefined },
  { status: 'in_work', label: 'In progress', tone: () => undefined },
  { status: 'waiting_info', label: 'Waiting for information', tone: () => undefined },
  { status: 'done', label: 'Resolved / closed', tone: () => 'good' },
  { status: 'critical_open', label: 'Critical (open)', tone: (n) => (n ? 'bad' : 'good') },
  { status: 'overdue', label: 'Overdue (open)', tone: (n) => (n ? 'bad' : 'good'), sla: true },
];
/** The number on each card, under the other filters that are on now. */
export function cardCounts(rows: Row[], f: FeedbackFilter, myId: string | null, now = Date.now()): number[] {
  const rest = rows.filter((r) => matchesRest(r, f, myId));
  return FEEDBACK_CARDS.map((c) => rest.filter((r) => matchesStatus(r, c.status, now)).length);
}
/** Pressing a card: its filter; pressing the card that is on again: everything. The other filters stay. */
export const pressCard = (f: FeedbackFilter, card: StatusFilter): FeedbackFilter => ({ ...f, status: f.status === card ? '' : card });

export const STATUS_OPTIONS: { v: StatusFilter; label: string }[] = [
  { v: '', label: 'All statuses' }, { v: 'open', label: 'Open issues' }, { v: 'unresolved', label: 'Not closed yet' }, { v: 'overdue', label: 'Overdue' }, { v: 'critical_open', label: 'Critical (open)' },
  ...FEEDBACK_STATUSES.map((s) => ({ v: s.v as StatusFilter, label: s.label })),
  { v: 'in_work', label: 'Accepted or in progress' }, { v: 'done', label: 'Resolved / closed' },
];
export const statusLabel = (s: StatusFilter): string => STATUS_OPTIONS.find((x) => x.v === s)?.label ?? s;
