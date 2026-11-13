import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEEDBACK_CATEGORIES, FEEDBACK_PRIORITIES, FEEDBACK_STATUSES, NEXT_STATUSES, issuesToCsv, type FeedbackIssue } from '../../src/lib/feedbackApi';
import { TH_FEEDBACK } from '../../src/lib/i18n.feedback';

const sql = readFileSync(new URL('../../supabase/migrations/20261114120000_feedback_issue_system.sql', import.meta.url), 'utf8');
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

describe('feedback: client rules mirror the database', () => {
  it('status transitions in the UI match public.feedback_transition_ok', () => {
    const fn = sql.slice(sql.indexOf('function public.feedback_transition_ok'), sql.indexOf('function public.feedback_submit'));
    const fromSql: Record<string, string[]> = {};
    for (const m of fn.matchAll(/when '([a-z_]+)'\s+then p_to in \(([^)]*)\)/g)) fromSql[m[1]] = quoted(m[2]).sort();
    const fromUi = Object.fromEntries(Object.entries(NEXT_STATUSES).map(([k, v]) => [k, [...v].sort()]));
    expect(fromUi).toEqual(fromSql);
  });
  it('statuses, categories and priorities match the check constraints', () => {
    const check = (name: string) => quoted(sql.slice(sql.indexOf(`constraint ${name}`)).split('\n')[0]).sort();
    expect(FEEDBACK_STATUSES.map((s) => s.v).sort()).toEqual(check('feedback_status_check'));
    expect(FEEDBACK_CATEGORIES.map((s) => s.v).sort()).toEqual(check('feedback_category_check'));
    expect(FEEDBACK_PRIORITIES.map((s) => s.v).sort()).toEqual(check('feedback_priority_check'));
  });
  it('every customer-facing label has a Thai translation', () => {
    for (const x of [...FEEDBACK_STATUSES, ...FEEDBACK_CATEGORIES, ...FEEDBACK_PRIORITIES]) expect(TH_FEEDBACK[x.label], x.label).toBeTruthy();
    for (const c of FEEDBACK_CATEGORIES) expect(TH_FEEDBACK[c.hint], c.hint).toBeTruthy();
  });
});

describe('feedback: Excel export', () => {
  it('writes a UTF-8 BOM and escapes commas, quotes and new lines', () => {
    const row = { id: 'FB-001001', title: 'Says "hi", then\nbreaks', category: 'bug', priority: 'high', status: 'submitted', source: 'customer', submitter_label: 'สมชาย', assigned_to: 'u1', page_path: '/app', module_name: 'rewards', created_at: '2026-11-14', last_activity_at: '2026-11-14', resolved_at: null, root_cause: null, resolution: null } as unknown as FeedbackIssue;
    const csv = issuesToCsv([row], (id) => (id === 'u1' ? 'Ake' : ''));
    expect(csv.startsWith('﻿Issue ID,')).toBe(true);
    expect(csv).toContain('"Says ""hi"", then\nbreaks"');
    expect(csv).toContain(',สมชาย,Ake,');
  });
});
