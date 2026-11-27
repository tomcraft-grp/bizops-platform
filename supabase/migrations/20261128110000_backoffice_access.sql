-- Back-office access for a LINE member: a SUPER_ADMIN gives (or takes back) the ADMIN role of one LINE member from the LINE members page.
-- Until now the database already let a SUPER_ADMIN change another profile's role (the protect_profile_columns trigger), but no screen did it and nothing recorded it.
-- This adds ONE function, nothing else: no table, no column, no policy. It can only move a LINE member between USER and ADMIN (never SUPER_ADMIN, never yourself,
-- never an account without a LINE id), it refuses a disabled member, and every change is written to auth_audit_logs (action 'role_change', as the earlier manual change was).
-- The role is read by the database on every call (RLS and the staff functions), so taking access back works at once; the app reads it when the member opens it again.
-- Rollback: supabase/rollbacks/20261128110000_backoffice_access_down.sql (only drops the function; roles already given stay as they are).

create or replace function public.line_member_set_access(p_profile uuid, p_grant boolean, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.profiles; why text := nullif(btrim(coalesce(p_reason, '')), ''); new_role text;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  if not public.line_is_super() then raise exception 'Only a SUPER_ADMIN can give or take back back-office access' using errcode = '42501'; end if;
  if p_grant is null then raise exception 'BAD_VALUE' using errcode = '22023'; end if;
  if why is not null and length(why) > 200 then raise exception 'REASON_TOO_LONG' using errcode = '22023'; end if;
  select * into t from public.profiles where id = p_profile for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  if t.id = auth.uid() then raise exception 'SELF_CHANGE' using errcode = '22023'; end if;
  if t.role = 'SUPER_ADMIN' then raise exception 'SUPER_ADMIN_FIXED' using errcode = '22023'; end if;
  if t.line_user_id is null then raise exception 'NOT_LINE_MEMBER' using errcode = '22023'; end if;
  new_role := case when p_grant then 'ADMIN' else 'USER' end;
  if t.role = new_role then return jsonb_build_object('changed', false, 'role', t.role); end if;
  if p_grant and t.status <> 'active' then raise exception 'MEMBER_DISABLED' using errcode = '22023'; end if;
  update public.profiles set role = new_role where id = t.id;          -- the profiles guard trigger checks the caller again (a SUPER_ADMIN, not the member)
  insert into public.auth_audit_logs (actor_id, action, detail)
    values (auth.uid(), 'role_change', jsonb_build_object('target', t.id, 'target_name', t.display_name, 'from', t.role, 'to', new_role, 'via', 'line_members', 'reason', why));
  return jsonb_build_object('changed', true, 'role', new_role);
end $$;

revoke execute on function public.line_member_set_access(uuid, boolean, text) from public, anon;
grant execute on function public.line_member_set_access(uuid, boolean, text) to authenticated;
