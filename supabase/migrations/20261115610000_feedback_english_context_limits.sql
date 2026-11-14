-- Cost control for the English-context generator (builds on 20261115600000_feedback_english_context).
-- Every customer submission starts one AI call, and feedback_submit itself has no rate limit, so without a cap one signed-in customer could make
-- the project pay for unlimited AI calls. Customers (the reporter, who is not support staff) get:
--   * at most 3 generation attempts per issue (a first try and two retries), and
--   * at most 10 generation starts per hour across all their issues.
-- Support staff are not limited (Regenerate is a deliberate action). The refusal happens BEFORE anything is claimed, so a refused call changes nothing.
-- Only the function body changes; no table, column or grant.
create or replace function public.feedback_english_context_begin(p_issue text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.bizops_feedback_issues; v_staff boolean;
begin
  select * into i from public.bizops_feedback_issues where id = p_issue for update;
  if not found then raise exception 'Feedback not found' using errcode = '42501'; end if;
  v_staff := exists (select 1 from public.profiles p where p.id = p_actor and p.status = 'active' and p.role in ('ADMIN', 'SUPER_ADMIN'));
  if i.reporter_id is distinct from p_actor and not v_staff then raise exception 'Feedback not found' using errcode = '42501'; end if;
  if i.english_context_status = 'processing' and coalesce(i.english_context_started_at, '-infinity') > now() - interval '5 minutes' then
    raise exception 'ALREADY_RUNNING: the English context is being generated'; end if;
  if i.english_context_status = 'completed' and not v_staff then raise exception 'ALREADY_DONE: the English context already exists'; end if;
  if not v_staff then
    if i.english_context_attempts >= 3 then raise exception 'RATE_LIMITED: this issue was already tried 3 times'; end if;
    if (select count(*) from public.bizops_feedback_issues x where x.reporter_id = p_actor and x.english_context_started_at > now() - interval '1 hour') >= 10 then
      raise exception 'RATE_LIMITED: too many requests, try again later'; end if;
  end if;
  update public.bizops_feedback_issues set english_context_status = 'processing', english_context_error = null, english_context_started_at = now(),
    english_context_attempts = english_context_attempts + 1 where id = i.id;
  return jsonb_build_object('id', i.id, 'title', i.title, 'description', i.description, 'category', i.category, 'priority', i.priority, 'source', i.source,
    'page_name', i.page_name, 'page_path', i.page_path, 'module_name', i.module_name, 'app_id', i.app_id, 'app_version', i.app_version,
    'environment', i.environment, 'device_type', i.device_type, 'os_info', i.os_info, 'browser_info', left(coalesce(i.browser_info, ''), 200), 'created_at', i.created_at,
    'attachments', (select coalesce(jsonb_agg(jsonb_build_object('file_name', a.file_name, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes, 'uploaded_at', a.created_at) order by a.created_at), '[]'::jsonb)
                    from public.feedback_attachments a where a.issue_id = i.id and a.comment_id is null));
end $$;

-- create or replace keeps the grants of 20261115600000 (service_role only); stated again so this file is self-checking
revoke execute on function public.feedback_english_context_begin(text, uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.feedback_english_context_begin(text, uuid) to service_role;
  end if;
end $$;
