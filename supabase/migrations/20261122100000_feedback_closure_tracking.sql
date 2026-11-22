-- Feedback closure tracking (adds to 20261114120000_feedback_issue_system.sql; nothing in it is replaced).
-- The workflow (statuses, allowed moves, who may move them, the event trail, the reporter's notifications) already exists and stays as it is.
-- What was missing is a record ON THE ISSUE of who resolved it, when and by whom it was closed, when its status last changed and who handles it,
-- in a form the reporter is allowed to read (reporters may read their own issue row, but not staff profiles or internal events).
--
-- One BEFORE UPDATE trigger fills the new columns, so every path that changes a status (feedback_staff_update, the "waiting for information"
-- reply in feedback_staff_comment, the reporter's answer in feedback_customer_message) is covered without rewriting those functions.
-- Labels are display names (like author_label / actor_label elsewhere), never e-mail addresses beyond what feedback_actor_label already shows.
-- No row is deleted; existing issues are back-filled from their own event trail.

alter table public.bizops_feedback_issues
  add column if not exists status_changed_at timestamptz,
  add column if not exists resolved_by_label text,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by_label text,
  add column if not exists handler_label text;

-- back-fill from the event trail (the latest status event wins); issues that never changed status keep their creation time
update public.bizops_feedback_issues i set
  status_changed_at = coalesce((select max(e.created_at) from public.feedback_events e where e.issue_id = i.id and e.kind = 'status'), i.created_at),
  resolved_by_label = case when i.status in ('resolved', 'closed') then
    (select e.actor_label from public.feedback_events e where e.issue_id = i.id and e.kind = 'status' and e.to_value = 'resolved' order by e.id desc limit 1) end,
  closed_at = case when i.status = 'closed' then
    (select e.created_at from public.feedback_events e where e.issue_id = i.id and e.kind = 'status' and e.to_value = 'closed' order by e.id desc limit 1) end,
  closed_by_label = case when i.status = 'closed' then
    (select e.actor_label from public.feedback_events e where e.issue_id = i.id and e.kind = 'status' and e.to_value = 'closed' order by e.id desc limit 1) end,
  handler_label = (select coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1)) from public.profiles p where p.id = i.assigned_to)
where i.status_changed_at is null;

alter table public.bizops_feedback_issues alter column status_changed_at set default now();

create or replace function public.feedback_stamp_issue()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    if new.status = 'resolved' then new.resolved_by_label := coalesce(public.feedback_actor_label(), 'staff'); end if;
    if new.status not in ('resolved', 'closed') then new.resolved_by_label := null; end if;   -- reopened: the earlier resolution no longer stands
    if new.status = 'closed' then
      new.closed_at := now(); new.closed_by_label := coalesce(public.feedback_actor_label(), 'staff');
    else
      new.closed_at := null; new.closed_by_label := null;
    end if;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    new.handler_label := (select coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1)) from public.profiles p where p.id = new.assigned_to);
  end if;
  return new;
end $$;
revoke execute on function public.feedback_stamp_issue() from public, anon, authenticated;

drop trigger if exists feedback_stamp_issue on public.bizops_feedback_issues;
create trigger feedback_stamp_issue before update of status, assigned_to on public.bizops_feedback_issues
  for each row execute function public.feedback_stamp_issue();

create index if not exists feedback_issues_status_changed_idx on public.bizops_feedback_issues (status_changed_at desc);
