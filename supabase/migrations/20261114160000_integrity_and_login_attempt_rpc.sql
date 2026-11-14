-- Data-integrity hardening. Additive and backward compatible: nothing is dropped or rewritten.
--
-- B. bizops_feedback_issues.app_id only accepts the two apps that exist (matches feedbackApi.ts appId type).
-- C. User-reference columns of the customer-app designer now point at auth.users (ON DELETE SET NULL,
--    like the feedback tables), so they can no longer hold ids that belong to nobody.
-- E. login attempts are recorded through a validated, rate-capped function instead of a direct anon INSERT.
--    The old "anon can record login attempts" policy is intentionally NOT dropped here: the deployed client still
--    inserts directly. Drop it (and revoke INSERT) in a later migration once the client calling
--    record_login_attempt() is deployed.

-- B
alter table public.bizops_feedback_issues
  add constraint bizops_feedback_issues_app_id_check check (app_id in ('line-liff', 'backoffice'));

-- C
alter table public.customer_app_layouts
  add constraint customer_app_layouts_created_by_fkey   foreign key (created_by)   references auth.users (id) on delete set null,
  add constraint customer_app_layouts_applied_by_fkey   foreign key (applied_by)   references auth.users (id) on delete set null,
  add constraint customer_app_layouts_reviewed_by_fkey  foreign key (reviewed_by)  references auth.users (id) on delete set null,
  add constraint customer_app_layouts_published_by_fkey foreign key (published_by) references auth.users (id) on delete set null;
alter table public.customer_app_templates
  add constraint customer_app_templates_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;
alter table public.customer_app_deployments
  add constraint customer_app_deployments_actor_fkey foreign key (actor) references auth.users (id) on delete set null;
alter table public.customer_app_staff_roles
  add constraint customer_app_staff_roles_granted_by_fkey foreign key (granted_by) references auth.users (id) on delete set null;

-- E
create function public.record_login_attempt(p_email text, p_success boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email text := trim(coalesce(p_email, ''));
begin
  -- Ignore junk: not an email shape or absurdly long (the email is stored exactly as typed, like the old insert,
  -- so recent_login_failures(p_email) keeps matching).
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' or p_success is null then return; end if;
  -- Flood cap: at most 20 recorded attempts per email per minute.
  if (select count(*) from public.login_attempts where email = v_email and created_at > now() - interval '1 minute') >= 20 then return; end if;
  insert into public.login_attempts (email, success) values (v_email, p_success);
end $$;

revoke all on function public.record_login_attempt(text, boolean) from public;
grant execute on function public.record_login_attempt(text, boolean) to anon, authenticated;
