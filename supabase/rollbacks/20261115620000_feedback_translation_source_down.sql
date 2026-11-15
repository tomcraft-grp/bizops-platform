-- Rolls back 20261115620000_feedback_translation_source.sql: feedback_set_english_context goes back to its 2-argument body from 20261115600000 and the
-- source constraint to ('ai', 'manual'). Refuses to run once a translation is stored (a record, never dropped or relabelled).
do $guard$ begin
  if exists (select 1 from public.bizops_feedback_issues where english_context_source = 'translation')
     or exists (select 1 from public.feedback_events where kind = 'english_context' and note = 'Translated on the staff computer') then
    raise exception 'Translations are stored: they cannot be rolled back. Export them first if they are really not wanted.'; end if;
end $guard$;

drop function if exists public.feedback_set_english_context(text, text, text);
create or replace function public.feedback_set_english_context(p_issue text, p_context text)
returns public.bizops_feedback_issues language plpgsql security definer set search_path = public as $$
declare i public.bizops_feedback_issues;
begin
  if not public.feedback_is_staff() then raise exception 'Only support staff can change the English context' using errcode = '42501'; end if;
  if p_context is null or btrim(p_context) = '' or length(p_context) > 20000 then raise exception 'The English context must be 1 to 20,000 characters'; end if;
  update public.bizops_feedback_issues set english_context = btrim(p_context), english_context_status = 'completed', english_context_error = null, english_context_at = now(),
    english_context_source = 'manual', english_context_model = null where id = p_issue returning * into i;
  if i.id is null then raise exception 'Feedback not found' using errcode = '42501'; end if;
  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, note, customer_visible) values (i.id, auth.uid(), public.feedback_actor_label(), 'english_context', 'Written by hand', false);
  return i;
end $$;
revoke execute on function public.feedback_set_english_context(text, text) from public, anon;
grant execute on function public.feedback_set_english_context(text, text) to authenticated;

alter table public.bizops_feedback_issues drop constraint if exists feedback_ctx_source_check;
alter table public.bizops_feedback_issues add constraint feedback_ctx_source_check check (english_context_source is null or english_context_source in ('ai', 'manual'));
