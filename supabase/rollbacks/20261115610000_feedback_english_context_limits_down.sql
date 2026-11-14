-- Rolls back 20261115610000_feedback_english_context_limits.sql: feedback_english_context_begin goes back to its body from
-- 20261115600000 (no attempt / hourly limits). Nothing else was changed by the migration, so there is nothing else to undo and no data to protect.
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
  update public.bizops_feedback_issues set english_context_status = 'processing', english_context_error = null, english_context_started_at = now(),
    english_context_attempts = english_context_attempts + 1 where id = i.id;
  return jsonb_build_object('id', i.id, 'title', i.title, 'description', i.description, 'category', i.category, 'priority', i.priority, 'source', i.source,
    'page_name', i.page_name, 'page_path', i.page_path, 'module_name', i.module_name, 'app_id', i.app_id, 'app_version', i.app_version,
    'environment', i.environment, 'device_type', i.device_type, 'os_info', i.os_info, 'browser_info', left(coalesce(i.browser_info, ''), 200), 'created_at', i.created_at,
    'attachments', (select coalesce(jsonb_agg(jsonb_build_object('file_name', a.file_name, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes, 'uploaded_at', a.created_at) order by a.created_at), '[]'::jsonb)
                    from public.feedback_attachments a where a.issue_id = i.id and a.comment_id is null));
end $$;
revoke execute on function public.feedback_english_context_begin(text, uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.feedback_english_context_begin(text, uuid) to service_role;
  end if;
end $$;
