-- Feedback & Issue system (round 1).
-- Evolves the existing public.bizops_feedback_issues table (it was written by the anonymous role with no
-- identity) into a real, authenticated issue tracker shared by the customer app (LINE members) and the
-- back office. Nothing is hard-deleted: issues, comments, attachments and the event trail are append-only
-- for clients; there are no DELETE policies, and issues can only be archived.
--
-- Access model
--   * staff    = an active profile with role ADMIN or SUPER_ADMIN (round 1: every ADMIN acts as Support).
--   * customer = any other signed-in profile (LINE members are role USER); sees only issues they reported.
--   * anon     = no access at all (the old open anon policies are dropped).
-- All writes go through SECURITY DEFINER functions that take identity from auth.uid(), never from the client.

-- ------------------------------------------------------------------------------------------------ helpers
create or replace function public.feedback_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role in ('ADMIN', 'SUPER_ADMIN'))
$$;

create or replace function public.feedback_actor_label()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(p.display_name), ''), split_part(p.email, '@', 1), 'user') from public.profiles p where p.id = auth.uid()
$$;

-- Keep only the path of a URL: drop the query string, the fragment and anything that looks like a token.
create or replace function public.feedback_clean_path(p text)
returns text language sql immutable as $$
  select left(regexp_replace(split_part(split_part(coalesce(p, ''), '?', 1), '#', 1), '(access_token|refresh_token|token|code)=[^&/]*', '', 'gi'), 300)
$$;

-- ------------------------------------------------------------------------------------------------ issues
create sequence if not exists public.feedback_issue_seq start 1001;

alter table public.bizops_feedback_issues
  add column if not exists reporter_id uuid references auth.users (id) on delete set null,
  add column if not exists source text not null default 'staff',
  add column if not exists app_id text not null default 'backoffice',
  add column if not exists assigned_to uuid references auth.users (id) on delete set null,
  add column if not exists root_cause text,
  add column if not exists resolution text,
  add column if not exists app_version text,
  add column if not exists os_info text,
  add column if not exists device_type text,
  add column if not exists last_activity_at timestamptz not null default now(),
  add column if not exists archived_at timestamptz;

-- Map the old vocabularies onto the new ones before constraining them.
update public.bizops_feedback_issues set status = case status
    when 'new' then 'submitted' when 'reviewing' then 'under_review' when 'need_info' then 'waiting_info'
    when 'completed' then 'resolved' else status end
  where status in ('new', 'reviewing', 'need_info', 'completed');
update public.bizops_feedback_issues set category = case category
    when 'performance' then 'bug' when 'question' then 'general' else category end
  where category in ('performance', 'question');
alter table public.bizops_feedback_issues alter column status set default 'submitted';

alter table public.bizops_feedback_issues
  add constraint feedback_status_check check (status in ('submitted', 'under_review', 'accepted', 'in_progress', 'waiting_info', 'resolved', 'closed', 'rejected')),
  add constraint feedback_category_check check (category in ('bug', 'feature_request', 'general', 'ui_ux', 'data_issue', 'other')),
  add constraint feedback_priority_check check (priority in ('low', 'medium', 'high', 'critical')),
  add constraint feedback_source_check check (source in ('staff', 'customer')),
  add constraint feedback_device_type_check check (device_type is null or device_type in ('mobile', 'tablet', 'desktop'));

create index if not exists feedback_issues_reporter_idx on public.bizops_feedback_issues (reporter_id, created_at desc);
create index if not exists feedback_issues_status_idx on public.bizops_feedback_issues (status, priority);
create index if not exists feedback_issues_assignee_idx on public.bizops_feedback_issues (assigned_to) where assigned_to is not null;
create index if not exists feedback_issues_activity_idx on public.bizops_feedback_issues (last_activity_at desc);

-- ------------------------------------------------------------------------------------------------ comments
-- kind: internal = staff-only note; reply = staff message the reporter sees; customer = message from the reporter.
create table if not exists public.feedback_comments (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references public.bizops_feedback_issues (id) on delete restrict,
  author_id uuid references auth.users (id) on delete set null,
  author_label text not null,
  kind text not null check (kind in ('internal', 'reply', 'customer')),
  body text not null check (length(body) between 1 and 5000),
  requests_info boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists feedback_comments_issue_idx on public.feedback_comments (issue_id, created_at);

-- The old notes JSON becomes internal comments (the column is kept, read-only, for backward compatibility).
insert into public.feedback_comments (issue_id, author_label, kind, body, created_at)
select i.id, coalesce(n->>'by', 'staff'), 'internal', left(n->>'text', 5000), coalesce((n->>'ts')::timestamptz, i.updated_at)
from public.bizops_feedback_issues i, jsonb_array_elements(coalesce(i.notes, '[]'::jsonb)) n
where coalesce(n->>'text', '') <> '';

-- ------------------------------------------------------------------------------------------------ attachments
create table if not exists public.feedback_attachments (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references public.bizops_feedback_issues (id) on delete restrict,
  comment_id uuid references public.feedback_comments (id) on delete restrict,
  storage_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 200),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists feedback_attachments_issue_idx on public.feedback_attachments (issue_id);

-- ------------------------------------------------------------------------------------------------ event trail
create table if not exists public.feedback_events (
  id bigint generated always as identity primary key,
  issue_id text not null references public.bizops_feedback_issues (id) on delete restrict,
  actor_id uuid references auth.users (id) on delete set null,
  actor_label text not null,
  kind text not null check (kind in ('created', 'status', 'priority', 'category', 'assigned', 'root_cause', 'resolution', 'comment', 'attachment', 'dev_link', 'archived')),
  from_value text,
  to_value text,
  note text,
  customer_visible boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists feedback_events_issue_idx on public.feedback_events (issue_id, created_at);

insert into public.feedback_events (issue_id, actor_label, kind, to_value, note, created_at)
select id, submitter_label, 'created', status, 'Imported from the earlier feedback widget', created_at from public.bizops_feedback_issues
where not exists (select 1 from public.feedback_events e where e.issue_id = bizops_feedback_issues.id);

-- ------------------------------------------------------------------------------------------------ development links
create table if not exists public.feedback_dev_links (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references public.bizops_feedback_issues (id) on delete restrict,
  kind text not null check (kind in ('project', 'module', 'branch', 'commit', 'pull_request', 'release', 'deployment')),
  ref text not null check (length(ref) between 1 and 200),
  url text check (url is null or url ~ '^https://'),
  environment text check (environment is null or environment in ('DEV', 'TEST', 'PRODUCTION')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists feedback_dev_links_issue_idx on public.feedback_dev_links (issue_id);

-- ------------------------------------------------------------------------------------------------ notifications
create table if not exists public.feedback_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users (id) on delete cascade,
  issue_id text not null references public.bizops_feedback_issues (id) on delete restrict,
  kind text not null check (kind in ('submitted', 'new_issue', 'critical', 'status', 'reply', 'info_requested', 'assigned', 'customer_message')),
  title text not null,
  body text,
  dedupe_key text not null unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists feedback_notifications_recipient_idx on public.feedback_notifications (recipient_id, read_at, created_at desc);

create or replace function public.feedback_notify(p_recipient uuid, p_issue text, p_kind text, p_title text, p_body text, p_dedupe text)
returns void language sql security definer set search_path = public as $$
  insert into public.feedback_notifications (recipient_id, issue_id, kind, title, body, dedupe_key)
  select p_recipient, p_issue, p_kind, p_title, p_body, p_dedupe
  where p_recipient is not null and p_recipient is distinct from auth.uid()
  on conflict (dedupe_key) do nothing
$$;

create or replace function public.feedback_notify_staff(p_issue text, p_kind text, p_title text, p_body text, p_dedupe text)
returns void language sql security definer set search_path = public as $$
  select public.feedback_notify(p.id, p_issue, p_kind, p_title, p_body, p_dedupe || ':' || p.id)
  from public.profiles p where p.status = 'active' and p.role in ('ADMIN', 'SUPER_ADMIN')
$$;

-- ------------------------------------------------------------------------------------------------ workflow
create or replace function public.feedback_transition_ok(p_from text, p_to text)
returns boolean language sql immutable as $$
  select case p_from
    when 'submitted'    then p_to in ('under_review', 'accepted', 'in_progress', 'waiting_info', 'rejected')
    when 'under_review' then p_to in ('accepted', 'in_progress', 'waiting_info', 'rejected')
    when 'accepted'     then p_to in ('in_progress', 'waiting_info', 'rejected')
    when 'in_progress'  then p_to in ('waiting_info', 'resolved', 'accepted')
    when 'waiting_info' then p_to in ('under_review', 'in_progress', 'rejected')
    when 'resolved'     then p_to in ('closed', 'in_progress')
    when 'closed'       then p_to in ('under_review')
    when 'rejected'     then p_to in ('under_review')
    else false end
$$;

create or replace function public.feedback_submit(
  p_category text, p_subject text, p_description text, p_priority text default 'medium',
  p_page_path text default null, p_page_name text default null, p_module text default null,
  p_app_id text default 'line-liff', p_app_version text default null, p_environment text default null,
  p_browser text default null, p_os text default null, p_device_type text default null,
  p_idempotency_key text default null
) returns public.bizops_feedback_issues
language plpgsql security definer set search_path = public as $$
declare
  me public.profiles;
  v_issue public.bizops_feedback_issues;
  is_staff boolean := public.feedback_is_staff();
  v_subject text := left(trim(coalesce(p_subject, '')), 120);
  v_desc text := left(trim(coalesce(p_description, '')), 5000);
begin
  select * into me from public.profiles where id = auth.uid() and status = 'active';
  if me.id is null then raise exception 'Please sign in to send feedback' using errcode = '42501'; end if;
  if v_desc = '' then raise exception 'Please describe the problem or suggestion'; end if;
  if v_subject = '' then v_subject := left(v_desc, 80); end if;
  if p_idempotency_key is not null then
    select * into v_issue from public.bizops_feedback_issues where idempotency_key = p_idempotency_key and reporter_id = me.id;
    if v_issue.id is not null then return v_issue; end if;
  end if;

  insert into public.bizops_feedback_issues (
    id, title, description, category, priority, status, source, app_id, reporter_id,
    page_name, page_path, page_url, module_name, submitter_label, environment, browser_info, device_info,
    os_info, device_type, app_version, idempotency_key, notes)
  values (
    'FB-' || lpad(nextval('public.feedback_issue_seq')::text, 6, '0'), v_subject, v_desc, p_category, coalesce(p_priority, 'medium'), 'submitted',
    case when is_staff then 'staff' else 'customer' end, coalesce(left(p_app_id, 40), 'line-liff'), me.id,
    coalesce(left(p_page_name, 120), ''), public.feedback_clean_path(p_page_path), public.feedback_clean_path(p_page_path), left(p_module, 80),
    public.feedback_actor_label(), coalesce(left(p_environment, 40), 'production'), coalesce(left(p_browser, 300), ''), coalesce(left(p_device_type, 20), ''),
    left(p_os, 80), p_device_type, left(p_app_version, 40), left(p_idempotency_key, 80), '[]'::jsonb)
  returning * into v_issue;

  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, to_value, customer_visible)
  values (v_issue.id, me.id, v_issue.submitter_label, 'created', 'submitted', true);

  insert into public.feedback_notifications (recipient_id, issue_id, kind, title, body, dedupe_key)
  values (me.id, v_issue.id, 'submitted', 'Feedback received', v_issue.title, v_issue.id || ':submitted') on conflict (dedupe_key) do nothing;
  perform public.feedback_notify_staff(v_issue.id, case when v_issue.priority = 'critical' then 'critical' else 'new_issue' end,
    case when v_issue.priority = 'critical' then 'Critical issue reported' else 'New feedback' end, v_issue.id || ' · ' || v_issue.title, v_issue.id || ':new');
  return v_issue;
end $$;

-- Staff: change status / priority / category / assignee / root cause / resolution in one call. Each change is logged.
create or replace function public.feedback_staff_update(
  p_issue text, p_status text default null, p_priority text default null, p_category text default null,
  p_assigned_to uuid default null, p_unassign boolean default false,
  p_root_cause text default null, p_resolution text default null, p_reason text default null
) returns public.bizops_feedback_issues
language plpgsql security definer set search_path = public as $$
declare
  cur public.bizops_feedback_issues;
  who text := public.feedback_actor_label();
begin
  if not public.feedback_is_staff() then raise exception 'Only support staff can update issues' using errcode = '42501'; end if;
  select * into cur from public.bizops_feedback_issues where id = p_issue for update;
  if cur.id is null then raise exception 'Issue % not found', p_issue; end if;

  if p_status is not null and p_status <> cur.status then
    if not public.feedback_transition_ok(cur.status, p_status) then
      raise exception 'Cannot move an issue from % to %', cur.status, p_status;
    end if;
    if p_status = 'rejected' and coalesce(trim(p_reason), '') = '' then raise exception 'Give the customer a reason for rejecting'; end if;
    if p_status = 'resolved' and coalesce(trim(coalesce(p_resolution, cur.resolution)), '') = '' then raise exception 'Record the resolution before marking the issue resolved'; end if;
    insert into public.feedback_events (issue_id, actor_id, actor_label, kind, from_value, to_value, note, customer_visible)
    values (cur.id, auth.uid(), who, 'status', cur.status, p_status, left(p_reason, 2000), true);
    perform public.feedback_notify(cur.reporter_id, cur.id, 'status', 'Status updated', p_status, cur.id || ':status:' || p_status || ':' || extract(epoch from now())::bigint);
    update public.bizops_feedback_issues set status = p_status,
      resolved_at = case when p_status in ('resolved', 'closed', 'rejected') then coalesce(resolved_at, now()) else null end
    where id = cur.id;
  end if;
  if p_priority is not null and p_priority <> cur.priority then
    insert into public.feedback_events (issue_id, actor_id, actor_label, kind, from_value, to_value) values (cur.id, auth.uid(), who, 'priority', cur.priority, p_priority);
    update public.bizops_feedback_issues set priority = p_priority where id = cur.id;
  end if;
  if p_category is not null and p_category <> cur.category then
    insert into public.feedback_events (issue_id, actor_id, actor_label, kind, from_value, to_value) values (cur.id, auth.uid(), who, 'category', cur.category, p_category);
    update public.bizops_feedback_issues set category = p_category where id = cur.id;
  end if;
  if p_unassign or (p_assigned_to is not null and p_assigned_to is distinct from cur.assigned_to) then
    if p_assigned_to is not null and not exists (select 1 from public.profiles where id = p_assigned_to and status = 'active' and role in ('ADMIN', 'SUPER_ADMIN')) then
      raise exception 'Issues can only be assigned to active staff';
    end if;
    insert into public.feedback_events (issue_id, actor_id, actor_label, kind, from_value, to_value)
    values (cur.id, auth.uid(), who, 'assigned', cur.assigned_to::text, case when p_unassign then null else p_assigned_to::text end);
    update public.bizops_feedback_issues set assigned_to = case when p_unassign then null else p_assigned_to end where id = cur.id;
    if not p_unassign then
      perform public.feedback_notify(p_assigned_to, cur.id, 'assigned', 'Issue assigned to you', cur.id || ' · ' || cur.title, cur.id || ':assigned:' || p_assigned_to || ':' || extract(epoch from now())::bigint);
    end if;
  end if;
  if p_root_cause is not null and p_root_cause is distinct from cur.root_cause then
    insert into public.feedback_events (issue_id, actor_id, actor_label, kind, note) values (cur.id, auth.uid(), who, 'root_cause', left(p_root_cause, 2000));
    update public.bizops_feedback_issues set root_cause = left(p_root_cause, 5000) where id = cur.id;
  end if;
  if p_resolution is not null and p_resolution is distinct from cur.resolution then
    insert into public.feedback_events (issue_id, actor_id, actor_label, kind, note, customer_visible) values (cur.id, auth.uid(), who, 'resolution', left(p_resolution, 2000), true);
    update public.bizops_feedback_issues set resolution = left(p_resolution, 5000) where id = cur.id;
  end if;

  update public.bizops_feedback_issues set updated_at = now(), last_activity_at = now() where id = cur.id returning * into cur;
  return cur;
end $$;

-- Staff: internal note or customer-visible reply (optionally asking the customer for more information).
create or replace function public.feedback_staff_comment(p_issue text, p_kind text, p_body text, p_requests_info boolean default false)
returns public.feedback_comments
language plpgsql security definer set search_path = public as $$
declare
  cur public.bizops_feedback_issues;
  c public.feedback_comments;
begin
  if not public.feedback_is_staff() then raise exception 'Only support staff can comment' using errcode = '42501'; end if;
  if p_kind not in ('internal', 'reply') then raise exception 'Unknown comment type %', p_kind; end if;
  if p_requests_info and p_kind <> 'reply' then raise exception 'Requests for information must be sent as a reply to the customer'; end if;
  select * into cur from public.bizops_feedback_issues where id = p_issue for update;
  if cur.id is null then raise exception 'Issue % not found', p_issue; end if;

  insert into public.feedback_comments (issue_id, author_id, author_label, kind, body, requests_info)
  values (cur.id, auth.uid(), public.feedback_actor_label(), p_kind, left(trim(p_body), 5000), p_requests_info)
  returning * into c;
  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, to_value, customer_visible)
  values (cur.id, auth.uid(), c.author_label, 'comment', p_kind, p_kind = 'reply');

  if p_kind = 'reply' then
    if p_requests_info and cur.status <> 'waiting_info' and public.feedback_transition_ok(cur.status, 'waiting_info') then
      insert into public.feedback_events (issue_id, actor_id, actor_label, kind, from_value, to_value, customer_visible)
      values (cur.id, auth.uid(), c.author_label, 'status', cur.status, 'waiting_info', true);
      update public.bizops_feedback_issues set status = 'waiting_info', resolved_at = null where id = cur.id;
    end if;
    perform public.feedback_notify(cur.reporter_id, cur.id, case when p_requests_info then 'info_requested' else 'reply' end,
      case when p_requests_info then 'More information needed' else 'New reply' end, left(c.body, 140), cur.id || ':comment:' || c.id);
  end if;
  update public.bizops_feedback_issues set updated_at = now(), last_activity_at = now() where id = cur.id;
  return c;
end $$;

-- Reporter: add a message (e.g. the information that was requested). Waiting-for-information issues go back to review.
create or replace function public.feedback_customer_message(p_issue text, p_body text)
returns public.feedback_comments
language plpgsql security definer set search_path = public as $$
declare
  cur public.bizops_feedback_issues;
  c public.feedback_comments;
begin
  select * into cur from public.bizops_feedback_issues where id = p_issue and reporter_id = auth.uid() for update;
  if cur.id is null then raise exception 'Feedback not found' using errcode = '42501'; end if;
  if cur.status in ('closed', 'rejected') then raise exception 'This feedback is closed. Please send new feedback instead.'; end if;
  insert into public.feedback_comments (issue_id, author_id, author_label, kind, body)
  values (cur.id, auth.uid(), public.feedback_actor_label(), 'customer', left(trim(p_body), 5000)) returning * into c;
  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, to_value, customer_visible)
  values (cur.id, auth.uid(), c.author_label, 'comment', 'customer', true);
  if cur.status = 'waiting_info' then
    insert into public.feedback_events (issue_id, actor_id, actor_label, kind, from_value, to_value, note, customer_visible)
    values (cur.id, auth.uid(), c.author_label, 'status', 'waiting_info', 'under_review', 'Customer provided more information', true);
    update public.bizops_feedback_issues set status = 'under_review' where id = cur.id;
  end if;
  if cur.assigned_to is not null then
    perform public.feedback_notify(cur.assigned_to, cur.id, 'customer_message', 'Customer replied', cur.id || ' · ' || left(c.body, 120), cur.id || ':comment:' || c.id);
  else
    perform public.feedback_notify_staff(cur.id, 'customer_message', 'Customer replied', cur.id || ' · ' || left(c.body, 120), cur.id || ':comment:' || c.id);
  end if;
  update public.bizops_feedback_issues set updated_at = now(), last_activity_at = now() where id = cur.id;
  return c;
end $$;

-- Record an uploaded file. The object must already be in the private bucket under "<issue id>/", uploaded by the caller.
create or replace function public.feedback_add_attachment(p_issue text, p_path text, p_name text, p_mime text, p_size integer, p_comment uuid default null)
returns public.feedback_attachments
language plpgsql security definer set search_path = public, storage as $$
declare
  cur public.bizops_feedback_issues;
  a public.feedback_attachments;
begin
  select * into cur from public.bizops_feedback_issues where id = p_issue and (reporter_id = auth.uid() or public.feedback_is_staff());
  if cur.id is null then raise exception 'Feedback not found' using errcode = '42501'; end if;
  if split_part(p_path, '/', 1) <> cur.id then raise exception 'Attachment path does not belong to this issue'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'feedback-attachments' and o.name = p_path and (o.owner_id = auth.uid()::text or o.owner = auth.uid())) then
    raise exception 'Upload the file before attaching it';
  end if;
  insert into public.feedback_attachments (issue_id, comment_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (cur.id, p_comment, p_path, left(p_name, 200), p_mime, p_size, auth.uid()) returning * into a;
  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, to_value, customer_visible)
  values (cur.id, auth.uid(), public.feedback_actor_label(), 'attachment', a.file_name, true);
  update public.bizops_feedback_issues set updated_at = now(), last_activity_at = now() where id = cur.id;
  return a;
end $$;

create or replace function public.feedback_add_dev_link(p_issue text, p_kind text, p_ref text, p_url text default null, p_environment text default null)
returns public.feedback_dev_links
language plpgsql security definer set search_path = public as $$
declare l public.feedback_dev_links;
begin
  if not public.feedback_is_staff() then raise exception 'Only support staff can link development work' using errcode = '42501'; end if;
  insert into public.feedback_dev_links (issue_id, kind, ref, url, environment, created_by)
  values (p_issue, p_kind, trim(p_ref), nullif(trim(p_url), ''), p_environment, auth.uid()) returning * into l;
  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, to_value, note)
  values (p_issue, auth.uid(), public.feedback_actor_label(), 'dev_link', p_kind, l.ref);
  update public.bizops_feedback_issues set updated_at = now(), last_activity_at = now() where id = p_issue;
  return l;
end $$;

-- Archive instead of delete.
create or replace function public.feedback_archive(p_issue text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.feedback_is_staff() then raise exception 'Only support staff can archive issues' using errcode = '42501'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for archiving'; end if;
  update public.bizops_feedback_issues set archived_at = now(), updated_at = now() where id = p_issue and archived_at is null;
  insert into public.feedback_events (issue_id, actor_id, actor_label, kind, note) values (p_issue, auth.uid(), public.feedback_actor_label(), 'archived', left(p_reason, 2000));
end $$;

create or replace function public.feedback_mark_read(p_ids uuid[] default null)
returns integer language sql security definer set search_path = public as $$
  with u as (
    update public.feedback_notifications set read_at = now()
    where recipient_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
    returning 1)
  select count(*)::int from u
$$;

-- Staff picker for assignment.
create or replace function public.feedback_staff_list()
returns table (id uuid, display_name text, email text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.feedback_is_staff() then raise exception 'Only support staff can list staff' using errcode = '42501'; end if;
  return query select p.id, p.display_name, p.email, p.role from public.profiles p
    where p.status = 'active' and p.role in ('ADMIN', 'SUPER_ADMIN') order by coalesce(p.display_name, p.email);
end $$;

-- ------------------------------------------------------------------------------------------------ RLS
drop policy if exists anon_insert_bizops_feedback on public.bizops_feedback_issues;
drop policy if exists anon_select_bizops_feedback on public.bizops_feedback_issues;
drop policy if exists anon_update_bizops_feedback on public.bizops_feedback_issues;

alter table public.bizops_feedback_issues enable row level security;
alter table public.feedback_comments enable row level security;
alter table public.feedback_attachments enable row level security;
alter table public.feedback_events enable row level security;
alter table public.feedback_dev_links enable row level security;
alter table public.feedback_notifications enable row level security;

create policy "feedback: staff or reporter reads issues" on public.bizops_feedback_issues for select to authenticated
  using (public.feedback_is_staff() or reporter_id = auth.uid());
create policy "feedback: staff reads all comments, reporter reads non-internal" on public.feedback_comments for select to authenticated
  using (public.feedback_is_staff() or (kind <> 'internal' and exists (select 1 from public.bizops_feedback_issues i where i.id = issue_id and i.reporter_id = auth.uid())));
create policy "feedback: staff or reporter reads attachments" on public.feedback_attachments for select to authenticated
  using (public.feedback_is_staff() or exists (select 1 from public.bizops_feedback_issues i where i.id = issue_id and i.reporter_id = auth.uid()));
create policy "feedback: staff reads events, reporter reads visible ones" on public.feedback_events for select to authenticated
  using (public.feedback_is_staff() or (customer_visible and exists (select 1 from public.bizops_feedback_issues i where i.id = issue_id and i.reporter_id = auth.uid())));
create policy "feedback: staff reads dev links" on public.feedback_dev_links for select to authenticated
  using (public.feedback_is_staff());
create policy "feedback: own notifications" on public.feedback_notifications for select to authenticated
  using (recipient_id = auth.uid());

-- Clients never write these tables directly; the functions above are the only write path.
revoke insert, update, delete, truncate on public.bizops_feedback_issues, public.feedback_comments, public.feedback_attachments,
  public.feedback_events, public.feedback_dev_links, public.feedback_notifications from anon, authenticated;
revoke all on public.bizops_feedback_issues, public.feedback_comments, public.feedback_attachments,
  public.feedback_events, public.feedback_dev_links, public.feedback_notifications from anon;
revoke all on sequence public.feedback_issue_seq from anon, authenticated;

revoke execute on function public.feedback_notify(uuid, text, text, text, text, text), public.feedback_notify_staff(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.feedback_submit(text, text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.feedback_staff_update(text, text, text, text, uuid, boolean, text, text, text), public.feedback_staff_comment(text, text, text, boolean),
  public.feedback_customer_message(text, text), public.feedback_add_attachment(text, text, text, text, integer, uuid),
  public.feedback_add_dev_link(text, text, text, text, text), public.feedback_archive(text, text), public.feedback_mark_read(uuid[]),
  public.feedback_staff_list() from public, anon;
grant execute on function public.feedback_submit(text, text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.feedback_staff_update(text, text, text, text, uuid, boolean, text, text, text), public.feedback_staff_comment(text, text, text, boolean),
  public.feedback_customer_message(text, text), public.feedback_add_attachment(text, text, text, text, integer, uuid),
  public.feedback_add_dev_link(text, text, text, text, text), public.feedback_archive(text, text), public.feedback_mark_read(uuid[]),
  public.feedback_staff_list(), public.feedback_is_staff() to authenticated;

-- ------------------------------------------------------------------------------------------------ storage
-- Private bucket: files are only reachable through short-lived signed URLs. Raster images and PDF, max 10 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-attachments', 'feedback-attachments', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "feedback attachments: upload to own issue" on storage.objects;
create policy "feedback attachments: upload to own issue" on storage.objects for insert to authenticated
  with check (bucket_id = 'feedback-attachments' and exists (
    select 1 from public.bizops_feedback_issues i
    where i.id = split_part(name, '/', 1) and (i.reporter_id = auth.uid() or public.feedback_is_staff())));
drop policy if exists "feedback attachments: read own issue" on storage.objects;
create policy "feedback attachments: read own issue" on storage.objects for select to authenticated
  using (bucket_id = 'feedback-attachments' and exists (
    select 1 from public.bizops_feedback_issues i
    where i.id = split_part(name, '/', 1) and (i.reporter_id = auth.uid() or public.feedback_is_staff())));
