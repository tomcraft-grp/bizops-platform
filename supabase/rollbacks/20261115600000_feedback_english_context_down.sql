-- Rolls back 20261115600000_feedback_english_context.sql: removes the English-context columns, the three functions and the 'english_context' history kind.
-- Refuses to run once an English context exists: a generated or hand-written text, a failed attempt and the history entries are records, never dropped.
-- Nothing in the original feedback data (title, description, comments, attachments, history) is touched either way.
do $guard$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bizops_feedback_issues' and column_name = 'english_context') then
    if exists (select 1 from public.bizops_feedback_issues where english_context is not null or english_context_error is not null or english_context_attempts > 0) then
      raise exception 'English contexts (or generation attempts) exist: they cannot be rolled back. Export them first if they are really not wanted.'; end if;
  end if;
  if exists (select 1 from public.feedback_events where kind = 'english_context') then
    raise exception 'The issue history contains English-context entries: they cannot be rolled back.'; end if;
end $guard$;

drop function if exists public.feedback_english_context_begin(text, uuid);
drop function if exists public.feedback_english_context_finish(text, text, text, text);
drop function if exists public.feedback_set_english_context(text, text);

-- the history kinds as they were before (11 kinds)
alter table public.feedback_events drop constraint if exists feedback_events_kind_check;
alter table public.feedback_events add constraint feedback_events_kind_check check (kind in
  ('created', 'status', 'priority', 'category', 'assigned', 'root_cause', 'resolution', 'comment', 'attachment', 'dev_link', 'archived'));

alter table public.bizops_feedback_issues
  drop constraint if exists feedback_ctx_status_check, drop constraint if exists feedback_ctx_source_check, drop constraint if exists feedback_ctx_length_check;
alter table public.bizops_feedback_issues
  drop column if exists english_context, drop column if exists english_context_status, drop column if exists english_context_error,
  drop column if exists english_context_at, drop column if exists english_context_source, drop column if exists english_context_model,
  drop column if exists english_context_attempts, drop column if exists english_context_started_at;
