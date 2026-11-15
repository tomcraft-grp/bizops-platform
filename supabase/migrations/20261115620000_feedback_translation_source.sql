-- A plain English translation made on the staff member's own computer (Chrome's built-in translator, no AI service, no key) is saved in the same
-- english_context column. It must not be recorded as "written by hand", so this adds the source 'translation' (builds on 20261115600000).
--   * english_context_source may now also be 'translation';
--   * feedback_set_english_context gets an optional third argument p_source ('manual' by default, so every existing 2-argument call is unchanged);
--     the history entry says "Translated on the staff computer" for a translation and still "Written by hand" otherwise.
-- Nothing is deleted or rewritten: existing issues and their English contexts are untouched.
alter table public.bizops_feedback_issues drop constraint if exists feedback_ctx_source_check;
alter table public.bizops_feedback_issues add constraint feedback_ctx_source_check
  check (english_context_source is null or english_context_source in ('ai', 'manual', 'translation'));

-- one function only: the old 2-argument version is replaced (two overloads with a default would make a 2-argument call ambiguous)
drop function if exists public.feedback_set_english_context(text, text);
create or replace function public.feedback_set_english_context(p_issue text, p_context text, p_source text default 'manual')
returns public.bizops_feedback_issues language plpgsql security definer set search_path = public as $$
declare i public.bizops_feedback_issues;
begin
  if not public.feedback_is_staff() then raise exception 'Only support staff can change the English context' using errcode = '42501'; end if;
  if p_source is null or p_source not in ('manual', 'translation') then raise exception 'Unknown source'; end if;
  if p_context is null or btrim(p_context) = '' or length(p_context) > 20000 then raise exception 'The English context must be 1 to 20,000 characters'; end if;
  update public.bizops_feedback_issues set english_context = btrim(p_context), english_context_status = 'completed', english_context_error = null, english_context_at = now(),
    english_context_source = p_source, english_context_model = null where id = p_issue returning * into i;
  if i.id is null then raise exception 'Feedback not found' using errcode = '42501'; end if;
  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, note, customer_visible) values (i.id, auth.uid(), public.feedback_actor_label(), 'english_context',
    case when p_source = 'translation' then 'Translated on the staff computer' else 'Written by hand' end, false);
  return i;
end $$;

revoke execute on function public.feedback_set_english_context(text, text, text) from public, anon;
grant execute on function public.feedback_set_english_context(text, text, text) to authenticated;
