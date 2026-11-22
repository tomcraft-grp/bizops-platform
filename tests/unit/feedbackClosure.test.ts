// Closure tracking helpers (src/lib/feedbackApi.ts): overdue rule, the reporter's progress step, the closing note, and that every new label has Thai.
import { describe, expect, it } from 'vitest';
import { FEEDBACK_SLA_DAYS, FEEDBACK_STATUSES, REPORTER_STATUS_TEXT, REPORTER_STEPS, closingNote, isOverdue, reporterStep, type FeedbackStatus } from '../../src/lib/feedbackApi';
import { TH_FEEDBACK } from '../../src/lib/i18n.feedback';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('isOverdue', () => {
  it('uses the SLA of the priority, measured from submission', () => {
    expect(isOverdue({ status: 'submitted', priority: 'critical', created_at: daysAgo(1.1) }, NOW)).toBe(true);
    expect(isOverdue({ status: 'submitted', priority: 'critical', created_at: daysAgo(0.9) }, NOW)).toBe(false);
    expect(isOverdue({ status: 'in_progress', priority: 'medium', created_at: daysAgo(FEEDBACK_SLA_DAYS.medium + 0.1) }, NOW)).toBe(true);
    expect(isOverdue({ status: 'in_progress', priority: 'low', created_at: daysAgo(10) }, NOW)).toBe(false);
  });
  it('never counts finished issues or issues waiting for the reporter', () => {
    for (const status of ['resolved', 'closed', 'rejected', 'waiting_info'] as FeedbackStatus[]) {
      expect(isOverdue({ status, priority: 'critical', created_at: daysAgo(100) }, NOW)).toBe(false);
    }
  });
});

describe('reporter view', () => {
  it('maps every status onto the four-step path', () => {
    expect(REPORTER_STEPS).toEqual(['Submitted', 'In progress', 'Resolved', 'Closed']);
    expect(reporterStep('submitted')).toBe(0);
    for (const s of ['under_review', 'accepted', 'in_progress', 'waiting_info'] as FeedbackStatus[]) expect(reporterStep(s)).toBe(1);
    expect(reporterStep('resolved')).toBe(2);
    expect(reporterStep('closed')).toBe(3);
    expect(reporterStep('rejected')).toBe(3);
  });
  it('has a plain-language message, in Thai too, for every status', () => {
    for (const s of FEEDBACK_STATUSES) {
      expect(REPORTER_STATUS_TEXT[s.v]).toBeTruthy();
      expect(TH_FEEDBACK[REPORTER_STATUS_TEXT[s.v]], REPORTER_STATUS_TEXT[s.v]).toBeTruthy();
    }
  });
  it('closingNote takes the note of the LAST close (or rejection) and nothing for open issues', () => {
    const ev = [
      { id: 1, kind: 'status', to_value: 'closed', note: 'first close' },
      { id: 2, kind: 'status', to_value: 'under_review', note: 'reopened' },
      { id: 3, kind: 'status', to_value: 'closed', note: '  Confirmed fixed  ' },
      { id: 4, kind: 'comment', to_value: 'reply', note: null },
    ];
    expect(closingNote(ev, 'closed')).toBe('Confirmed fixed');
    expect(closingNote(ev, 'in_progress')).toBeNull();
    expect(closingNote([{ id: 9, kind: 'status', to_value: 'rejected', note: 'Works as designed' }], 'rejected')).toBe('Works as designed');
    expect(closingNote([{ id: 9, kind: 'status', to_value: 'closed', note: null }], 'closed')).toBeNull();
  });
});

describe('Thai labels for the new screens', () => {
  it.each([
    'Progress', 'Current status', 'Last status update', 'Handled by', 'Closing note', 'Resolution & closure', 'Last status change', 'Start work (In progress)',
    'Mark resolved', 'Close issue', 'Overdue (open)', 'Not closed yet', 'Assigned to me', 'Reported by me', 'feedback updates for you',
    'Closing note (shown to the reporter, optional)', 'Why it is reopened (shown to the reporter, optional)',
  ])('%s', (k) => { expect(TH_FEEDBACK[k]).toBeTruthy(); });
});
