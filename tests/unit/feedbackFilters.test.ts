// The summary cards of Feedback & Issue Management are filters: a card's number must always be the length of the list it opens, under any other filter.
import { describe, expect, it } from 'vitest';
import { FEEDBACK_PRIORITIES, FEEDBACK_STATUSES, type FeedbackIssue } from '../../src/lib/feedbackApi';
import { applyFilter, cardCounts, FEEDBACK_CARDS, type FeedbackFilter, NO_FILTER, pressCard, STATUS_OPTIONS, statusLabel } from '../../src/lib/feedbackFilters';
import { t } from '../../src/lib/i18n';

const NOW = Date.parse('2026-11-24T03:00:00Z');
const row = (o: Partial<FeedbackIssue>): FeedbackIssue => ({ id: 'FB-001', title: 'x', description: 'y', submitter_label: 'A', page_name: 'Products', module_name: null, status: 'submitted', priority: 'medium', category: 'bug', source: 'staff', reporter_id: 'me', assigned_to: null, created_at: '2026-11-23T03:00:00Z', ...o } as FeedbackIssue);
// every status x every priority, young and old, from staff and customers
const rows = FEEDBACK_STATUSES.flatMap((s, i) => FEEDBACK_PRIORITIES.flatMap((p, j) => [0, 1].map((k) => row({ id: `FB-${i}${j}${k}`, status: s.v, priority: p.v, source: k ? 'customer' : 'staff', reporter_id: k ? 'other' : 'me', assigned_to: j === 1 ? 'me' : null, category: j % 2 ? 'bug' : 'ui_ux', title: k ? 'old one' : 'new one', created_at: k ? '2026-10-01T00:00:00Z' : '2026-11-24T02:00:00Z' }))));

describe('feedback summary cards', () => {
  const OTHERS: Partial<FeedbackFilter>[] = [{}, { priority: 'critical' }, { priority: 'low' }, { category: 'bug' }, { source: 'mine' }, { source: 'customer' }, { assignee: 'me' }, { assignee: 'none' }, { q: 'old' }, { q: 'fb-3' }, { q: 'nothing like this' }, { priority: 'high', source: 'customer', q: 'old' }];
  it('the number on every card is the length of the list its click shows, with any other filter on', () => {
    for (const o of OTHERS) {
      const f = { ...NO_FILTER, ...o }; const n = cardCounts(rows, f, 'me', NOW);
      FEEDBACK_CARDS.forEach((c, i) => expect(applyFilter(rows, pressCard({ ...f, status: 'rejected' }, c.status), 'me', NOW).length, `${c.label} ${JSON.stringify(o)}`).toBe(n[i]));
    }
  });
  it('each card lists its own statuses and nothing else', () => {
    const got = (s: FeedbackFilter['status']) => [...new Set(applyFilter(rows, { ...NO_FILTER, status: s }, 'me', NOW).map((r) => r.status))].sort();
    expect(got('submitted')).toEqual(['submitted']); expect(got('under_review')).toEqual(['under_review']); expect(got('in_work')).toEqual(['accepted', 'in_progress']); expect(got('waiting_info')).toEqual(['waiting_info']); expect(got('done')).toEqual(['closed', 'resolved']);
    expect(got('critical_open')).toEqual(['accepted', 'in_progress', 'submitted', 'under_review', 'waiting_info']); expect(applyFilter(rows, { ...NO_FILTER, status: 'critical_open' }, 'me', NOW).every((r) => r.priority === 'critical')).toBe(true);
    expect(got('overdue')).toEqual(['accepted', 'in_progress', 'submitted', 'under_review']); expect(applyFilter(rows, { ...NO_FILTER, status: 'overdue' }, 'me', NOW).every((r) => r.title === 'old one')).toBe(true); expect(got('')).toHaveLength(8);
  });
  it('pressing: turns it on, changes card, pressing again shows everything; the other filters stay', () => {
    const f = { ...NO_FILTER, category: 'bug', q: 'old' };
    const a = pressCard(f, 'overdue'); expect(a).toEqual({ ...f, status: 'overdue' }); expect(pressCard(a, 'done').status).toBe('done'); expect(pressCard(a, 'overdue')).toEqual(f); expect(pressCard(f, '').status).toBe('');
  });
  it('"mine" and "me" never match when it is not known who is signed in', () => { expect(applyFilter(rows, { ...NO_FILTER, source: 'mine' }, null, NOW)).toEqual([]); expect(applyFilter(rows, { ...NO_FILTER, assignee: 'me' }, null, NOW)).toEqual([]); });
  it('every card is also in the Status box, so the two always show the same choice; all in Thai', () => {
    for (const c of FEEDBACK_CARDS) { expect(STATUS_OPTIONS.some((o) => o.v === c.status), c.label).toBe(true); expect(t('th', c.label)).not.toBe(c.label); expect(t('th', statusLabel(c.status))).not.toBe(statusLabel(c.status)); }
    expect(new Set(STATUS_OPTIONS.map((o) => o.v)).size).toBe(STATUS_OPTIONS.length);
  });
  it('the status "Submitted" reads "sent", not "sent at"', () => { expect(t('th', 'Submitted')).toBe('ส่งแล้ว'); });
});
