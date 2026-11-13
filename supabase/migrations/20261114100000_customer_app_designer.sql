-- DEV APP Customer: layout configuration for customer-facing apps, with versions, approval, deployment
-- history and rollback.
--
-- How it works
--   * A layout is structured JSON (theme, branding, navigation, home-page sections) validated on the client
--     (src/devapp/schema.ts) AND here. It never contains HTML or script; the app renders it with a fixed
--     allow-list of components.
--   * Versions are append-only. Only drafts can be edited; every other status change goes through the
--     SECURITY DEFINER functions below, which check the caller's DEV APP role.
--   * "Deploy" moves customer_apps.published_version_id. The customer app reads that version at start-up,
--     so publishing needs no frontend build. The previous published version is kept (status 'superseded')
--     and can be restored with customer_app_rollback.
--
-- Roles (customer_app_staff_roles; a SUPER_ADMIN profile is always 'admin'):
--   viewer    view layouts and previews
--   designer  + create / edit / delete drafts, templates, upload images
--   approver  + approve or reject applied versions
--   publisher + apply and deploy / roll back
--   admin     everything, including granting roles
-- Each role includes the ones above it in this list.

-- ---------------------------------------------------------------------------------------------- tables
create table if not exists public.customer_apps (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null,
  description text,
  published_version_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_app_layouts (
  id uuid primary key default gen_random_uuid(),
  app_id text not null references public.customer_apps(id) on delete restrict,
  version_no integer not null,
  status text not null default 'draft'
    check (status in ('draft', 'applied', 'approved', 'published', 'superseded', 'rejected')),
  name text not null default '' check (length(name) <= 120),
  note text check (note is null or length(note) <= 1000),
  config jsonb not null,
  schema_version integer not null default 1,
  based_on uuid references public.customer_app_layouts(id) on delete set null,
  created_by uuid default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_by uuid, applied_at timestamptz,
  reviewed_by uuid, reviewed_at timestamptz, review_note text,
  published_by uuid, published_at timestamptz,
  unique (app_id, version_no)
);
create index if not exists customer_app_layouts_app_idx on public.customer_app_layouts (app_id, version_no desc);

alter table public.customer_apps drop constraint if exists customer_apps_published_fk;
alter table public.customer_apps
  add constraint customer_apps_published_fk foreign key (published_version_id)
  references public.customer_app_layouts(id) on delete restrict;

create table if not exists public.customer_app_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  description text,
  config jsonb not null,
  created_by uuid default auth.uid(),
  created_by_email text,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_app_deployments (
  id uuid primary key default gen_random_uuid(),
  app_id text not null references public.customer_apps(id) on delete restrict,
  version_id uuid references public.customer_app_layouts(id) on delete restrict,
  from_version_id uuid references public.customer_app_layouts(id) on delete restrict,
  action text not null check (action in ('deploy', 'rollback')),
  status text not null check (status in ('succeeded', 'failed')),
  message text,
  error text,
  actor uuid default auth.uid(),
  actor_email text,
  created_at timestamptz not null default now()
);
create index if not exists customer_app_deployments_app_idx on public.customer_app_deployments (app_id, created_at desc);

create table if not exists public.customer_app_staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('viewer', 'designer', 'approver', 'publisher', 'admin')),
  granted_by uuid default auth.uid(),
  granted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------- role helpers
create or replace function public.customer_app_role()
returns text language sql stable security definer set search_path = public as $$
  select case
    when p.role = 'SUPER_ADMIN' then 'admin'
    else (select r.role from public.customer_app_staff_roles r where r.user_id = p.id)
  end
  from public.profiles p
  where p.id = auth.uid() and p.status = 'active'
$$;

create or replace function public.customer_app_can(p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (array_position(array['viewer', 'designer', 'approver', 'publisher', 'admin'], public.customer_app_role()))
    >= (case p_cap when 'view' then 1 when 'edit' then 2 when 'approve' then 3 when 'deploy' then 4 when 'admin' then 5 else 99 end),
    false)
$$;

create or replace function public.customer_app_my_role()
returns text language sql stable security definer set search_path = public as $$
  select public.customer_app_role()
$$;

create or replace function public.customer_app_current_email()
returns text language sql stable security definer set search_path = public as $$
  select email from public.profiles where id = auth.uid()
$$;

-- ---------------------------------------------------------------------------------------------- validation
-- Structural checks that must hold whatever client sent the data. The detailed per-field validation lives in
-- src/devapp/schema.ts; this is the server-side backstop (shape, size, allow-listed section types, no markup).
create or replace function public.customer_app_validate(p_config jsonb)
returns text language plpgsql immutable set search_path = public as $$
declare
  s jsonb;
  ids text[] := '{}';
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then return 'config must be an object'; end if;
  if (p_config ->> 'schemaVersion') is distinct from '1' then return 'unsupported schemaVersion'; end if;
  if pg_column_size(p_config) > 200000 then return 'config is too large'; end if;
  if jsonb_typeof(p_config -> 'theme') <> 'object' then return 'theme is missing'; end if;
  if jsonb_typeof(p_config -> 'brand') <> 'object' then return 'brand is missing'; end if;
  if jsonb_typeof(p_config -> 'nav') <> 'array' or jsonb_array_length(p_config -> 'nav') = 0 then return 'nav is missing'; end if;
  if jsonb_typeof(p_config -> 'home') <> 'array' then return 'home sections are missing'; end if;
  if jsonb_array_length(p_config -> 'home') > 60 then return 'too many sections'; end if;
  if jsonb_typeof(p_config -> 'onboarding') <> 'object' or jsonb_typeof(p_config -> 'onboarding' -> 'slides') <> 'array'
     or jsonb_array_length(p_config -> 'onboarding' -> 'slides') > 8 then return 'intro pop-up settings are invalid'; end if;
  if p_config::text ~* '(<\s*script|javascript:|\mon[a-z]+\s*=\s*\\?["'']|<\s*iframe)' then return 'markup or script is not allowed'; end if;
  for s in select * from jsonb_array_elements(p_config -> 'home') loop
    if (s ->> 'type') is null or (s ->> 'type') not in
      ('memberCard', 'outstandingNotice', 'myCoupons', 'offers', 'categories', 'couponStrip', 'banner', 'heading', 'text', 'image', 'button',
       'card', 'spacer', 'divider', 'announcement', 'sectionHeader', 'carousel')
      then return 'unknown section type: ' || coalesce(s ->> 'type', 'null'); end if;
    if (s ->> 'id') is null or (s ->> 'id') = any (ids) then return 'section ids must be unique'; end if;
    ids := ids || (s ->> 'id');
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------- triggers
create or replace function public.customer_app_layout_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('customer_app_layouts:' || new.app_id));
  select coalesce(max(version_no), 0) + 1 into new.version_no from public.customer_app_layouts where app_id = new.app_id;
  new.status := 'draft';
  new.created_by := auth.uid();
  new.created_by_email := public.customer_app_current_email();
  new.created_at := now(); new.updated_at := now();
  new.applied_by := null; new.applied_at := null; new.reviewed_by := null; new.reviewed_at := null; new.review_note := null;
  new.published_by := null; new.published_at := null;
  return new;
end $$;
drop trigger if exists customer_app_layout_before_insert on public.customer_app_layouts;
create trigger customer_app_layout_before_insert before insert on public.customer_app_layouts
  for each row execute function public.customer_app_layout_before_insert();

-- Direct updates (RLS: drafts only) may change name / note / config. Status and audit columns are only
-- changed by the workflow functions, which set app.customer_app_workflow for the transaction.
create or replace function public.customer_app_layout_before_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('app.customer_app_workflow', true), '') <> 'on' then
    if old.status <> 'draft' then raise exception 'only draft versions can be edited (version % is %)', old.version_no, old.status; end if;
    if new.status is distinct from old.status or new.app_id is distinct from old.app_id or new.version_no is distinct from old.version_no
       or new.created_by is distinct from old.created_by or new.published_at is distinct from old.published_at then
      raise exception 'status and audit columns are changed through the workflow functions only';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists customer_app_layout_before_update on public.customer_app_layouts;
create trigger customer_app_layout_before_update before update on public.customer_app_layouts
  for each row execute function public.customer_app_layout_before_update();

create or replace function public.customer_app_template_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_by := auth.uid();
  new.created_by_email := public.customer_app_current_email();
  return new;
end $$;
drop trigger if exists customer_app_template_before_insert on public.customer_app_templates;
create trigger customer_app_template_before_insert before insert on public.customer_app_templates
  for each row execute function public.customer_app_template_before_insert();

-- ---------------------------------------------------------------------------------------------- workflow
-- Apply: validate a draft and lock it for review. It can then be previewed in the real customer app
-- (staff-only preview link) before it is approved and deployed.
create or replace function public.customer_app_apply(p_version uuid)
returns public.customer_app_layouts language plpgsql security definer set search_path = public as $$
declare v public.customer_app_layouts; err text;
begin
  if not public.customer_app_can('deploy') then raise exception 'Only a publisher or administrator can apply a layout'; end if;
  select * into v from public.customer_app_layouts where id = p_version for update;
  if not found then raise exception 'Version not found'; end if;
  if v.status <> 'draft' then raise exception 'Only a draft can be applied (this version is %)', v.status; end if;
  err := public.customer_app_validate(v.config);
  if err is not null then raise exception 'Layout is not valid: %', err; end if;
  perform set_config('app.customer_app_workflow', 'on', true);
  update public.customer_app_layouts set status = 'applied', applied_by = auth.uid(), applied_at = now() where id = p_version returning * into v;
  return v;
end $$;

create or replace function public.customer_app_review(p_version uuid, p_approve boolean, p_note text default null)
returns public.customer_app_layouts language plpgsql security definer set search_path = public as $$
declare v public.customer_app_layouts;
begin
  if not public.customer_app_can('approve') then raise exception 'Only an approver, publisher or administrator can review a layout'; end if;
  select * into v from public.customer_app_layouts where id = p_version for update;
  if not found then raise exception 'Version not found'; end if;
  if v.status <> 'applied' then raise exception 'Only an applied version can be reviewed (this version is %)', v.status; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'A reason is required to reject a version'; end if;
  perform set_config('app.customer_app_workflow', 'on', true);
  update public.customer_app_layouts
     set status = case when p_approve then 'approved' else 'rejected' end,
         reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(trim(p_note), '')
   where id = p_version returning * into v;
  return v;
end $$;

-- Deploy: make an approved version the live one. Atomic; the previous live version is kept as 'superseded'.
create or replace function public.customer_app_deploy(p_version uuid, p_message text default null)
returns public.customer_app_deployments language plpgsql security definer set search_path = public as $$
declare v public.customer_app_layouts; a public.customer_apps; d public.customer_app_deployments; err text;
begin
  if not public.customer_app_can('deploy') then raise exception 'Only a publisher or administrator can deploy a layout'; end if;
  select * into v from public.customer_app_layouts where id = p_version for update;
  if not found then raise exception 'Version not found'; end if;
  select * into a from public.customer_apps where id = v.app_id for update;
  if v.status <> 'approved' then raise exception 'Only an approved version can be deployed (this version is %)', v.status; end if;
  begin
    err := public.customer_app_validate(v.config);
    if err is not null then raise exception 'Layout is not valid: %', err; end if;
    perform set_config('app.customer_app_workflow', 'on', true);
    update public.customer_app_layouts set status = 'superseded' where id = a.published_version_id and id <> p_version;
    update public.customer_app_layouts set status = 'published', published_by = auth.uid(), published_at = now() where id = p_version;
    update public.customer_apps set published_version_id = p_version where id = v.app_id;
    insert into public.customer_app_deployments (app_id, version_id, from_version_id, action, status, message, actor_email)
      values (v.app_id, p_version, a.published_version_id, 'deploy', 'succeeded', nullif(trim(p_message), ''), public.customer_app_current_email())
      returning * into d;
  exception when others then
    insert into public.customer_app_deployments (app_id, version_id, from_version_id, action, status, message, error, actor_email)
      values (v.app_id, p_version, a.published_version_id, 'deploy', 'failed', nullif(trim(p_message), ''), sqlerrm, public.customer_app_current_email())
      returning * into d;
  end;
  return d;
end $$;

-- Rollback: make a previously published version live again (immediately, no re-approval: it was approved before).
create or replace function public.customer_app_rollback(p_version uuid, p_message text default null)
returns public.customer_app_deployments language plpgsql security definer set search_path = public as $$
declare v public.customer_app_layouts; a public.customer_apps; d public.customer_app_deployments;
begin
  if not public.customer_app_can('deploy') then raise exception 'Only a publisher or administrator can roll back'; end if;
  select * into v from public.customer_app_layouts where id = p_version for update;
  if not found then raise exception 'Version not found'; end if;
  select * into a from public.customer_apps where id = v.app_id for update;
  if v.published_at is null then raise exception 'Only a version that was published before can be restored'; end if;
  if a.published_version_id = p_version then raise exception 'This version is already live'; end if;
  perform set_config('app.customer_app_workflow', 'on', true);
  update public.customer_app_layouts set status = 'superseded' where id = a.published_version_id;
  update public.customer_app_layouts set status = 'published', published_by = auth.uid(), published_at = now() where id = p_version;
  update public.customer_apps set published_version_id = p_version where id = v.app_id;
  insert into public.customer_app_deployments (app_id, version_id, from_version_id, action, status, message, actor_email)
    values (v.app_id, p_version, a.published_version_id, 'rollback', 'succeeded', nullif(trim(p_message), ''), public.customer_app_current_email())
    returning * into d;
  return d;
end $$;

-- Customers (and anyone) read only the live layout of an app.
create or replace function public.get_published_customer_layout(p_app text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('version_id', l.id, 'version_no', l.version_no, 'published_at', l.published_at, 'config', l.config)
  from public.customer_apps a join public.customer_app_layouts l on l.id = a.published_version_id
  where a.id = p_app
$$;

-- Staff list for the Access tab (admins only): back-office profiles and their DEV APP role.
create or replace function public.customer_app_staff()
returns table (user_id uuid, email text, display_name text, profile_role text, app_role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.customer_app_can('admin') then raise exception 'Only an administrator can manage DEV APP access'; end if;
  return query
    select p.id, p.email, p.display_name, p.role,
           case when p.role = 'SUPER_ADMIN' then 'admin' else r.role end
    from public.profiles p left join public.customer_app_staff_roles r on r.user_id = p.id
    where p.role in ('ADMIN', 'SUPER_ADMIN') or r.role is not null
    order by p.email;
end $$;

create or replace function public.customer_app_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.customer_app_can('admin') then raise exception 'Only an administrator can manage DEV APP access'; end if;
  if p_user = auth.uid() then raise exception 'You cannot change your own DEV APP role'; end if;
  if exists (select 1 from public.profiles where id = p_user and role = 'SUPER_ADMIN') then raise exception 'A SUPER_ADMIN always has full access'; end if;
  if p_role is null then delete from public.customer_app_staff_roles where user_id = p_user; return; end if;
  if p_role not in ('viewer', 'designer', 'approver', 'publisher', 'admin') then raise exception 'Unknown role %', p_role; end if;
  insert into public.customer_app_staff_roles (user_id, role) values (p_user, p_role)
    on conflict (user_id) do update set role = excluded.role, granted_by = auth.uid(), granted_at = now();
end $$;

-- ---------------------------------------------------------------------------------------------- RLS
alter table public.customer_apps enable row level security;
alter table public.customer_app_layouts enable row level security;
alter table public.customer_app_templates enable row level security;
alter table public.customer_app_deployments enable row level security;
alter table public.customer_app_staff_roles enable row level security;

drop policy if exists "staff read apps" on public.customer_apps;
create policy "staff read apps" on public.customer_apps for select to authenticated using (public.customer_app_can('view'));
drop policy if exists "admin manage apps" on public.customer_apps;
create policy "admin manage apps" on public.customer_apps for insert to authenticated with check (public.customer_app_can('admin') and published_version_id is null);

drop policy if exists "staff read layouts" on public.customer_app_layouts;
create policy "staff read layouts" on public.customer_app_layouts for select to authenticated using (public.customer_app_can('view'));
drop policy if exists "designers create drafts" on public.customer_app_layouts;
create policy "designers create drafts" on public.customer_app_layouts for insert to authenticated with check (public.customer_app_can('edit'));
drop policy if exists "designers edit drafts" on public.customer_app_layouts;
create policy "designers edit drafts" on public.customer_app_layouts for update to authenticated
  using (public.customer_app_can('edit') and status = 'draft') with check (status = 'draft');
drop policy if exists "designers delete drafts" on public.customer_app_layouts;
create policy "designers delete drafts" on public.customer_app_layouts for delete to authenticated
  using (public.customer_app_can('edit') and status = 'draft');

drop policy if exists "staff read templates" on public.customer_app_templates;
create policy "staff read templates" on public.customer_app_templates for select to authenticated using (public.customer_app_can('view'));
drop policy if exists "designers write templates" on public.customer_app_templates;
create policy "designers write templates" on public.customer_app_templates for insert to authenticated with check (public.customer_app_can('edit'));
drop policy if exists "designers delete templates" on public.customer_app_templates;
create policy "designers delete templates" on public.customer_app_templates for delete to authenticated using (public.customer_app_can('edit'));

drop policy if exists "staff read deployments" on public.customer_app_deployments;
create policy "staff read deployments" on public.customer_app_deployments for select to authenticated using (public.customer_app_can('view'));

drop policy if exists "read own or admin roles" on public.customer_app_staff_roles;
create policy "read own or admin roles" on public.customer_app_staff_roles for select to authenticated
  using (user_id = auth.uid() or public.customer_app_can('admin'));

grant execute on function public.get_published_customer_layout(text) to anon, authenticated;
grant execute on function public.customer_app_my_role() to authenticated;
revoke execute on function public.customer_app_apply(uuid), public.customer_app_review(uuid, boolean, text),
  public.customer_app_deploy(uuid, text), public.customer_app_rollback(uuid, text),
  public.customer_app_staff(), public.customer_app_set_role(uuid, text) from anon;

-- ---------------------------------------------------------------------------------------------- assets
-- Public-read bucket for logos and banners. Raster images only (no SVG: it can carry script), max 2 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-app-assets', 'customer-app-assets', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "designers upload customer app assets" on storage.objects;
create policy "designers upload customer app assets" on storage.objects for insert to authenticated
  with check (bucket_id = 'customer-app-assets' and public.customer_app_can('edit'));

-- ---------------------------------------------------------------------------------------------- seed
insert into public.customer_apps (id, name, description)
values ('line-liff', 'LINE member app (LIFF)', 'Customer app opened inside LINE: membership, shop, rewards, payments and events')
on conflict (id) do nothing;
