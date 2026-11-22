-- Rolls back 20261122100000_feedback_closure_tracking.sql: removes the trigger and the five tracking columns.
-- Safe at any time: the columns only copy information that the event trail (public.feedback_events) also keeps, so nothing is lost.
-- Afterwards delete version 20261122100000 from supabase_migrations.schema_migrations.
drop trigger if exists feedback_stamp_issue on public.bizops_feedback_issues;
drop function if exists public.feedback_stamp_issue();
drop index if exists public.feedback_issues_status_changed_idx;
alter table public.bizops_feedback_issues
  drop column if exists status_changed_at,
  drop column if exists resolved_by_label,
  drop column if exists closed_at,
  drop column if exists closed_by_label,
  drop column if exists handler_label;
