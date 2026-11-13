-- Baseline schema for Supabase project tomcraft_app (ref hlvravynjalculvplrxc).
-- Generated on 2026-11-13 from the live database with read-only catalog queries, so the
-- schema that was created by hand in the dashboard is now in version control.
-- It describes what already exists; do not re-run it against the live project.
-- Grants are Supabase defaults (anon/authenticated have table privileges; RLS does the filtering).

-- ===== Tables =====
create table public.auth_audit_logs (
  id bigint generated always as identity not null,
  actor_id uuid,
  action text not null,
  detail jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint auth_audit_logs_pkey PRIMARY KEY (id),
  constraint auth_audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL
);

create table public.bizops_feedback_issues (
  id text not null,
  title text not null,
  description text not null,
  remark text,
  page_name text not null,
  page_path text not null,
  page_url text not null,
  module_name text,
  feature_name text,
  function_identifier text,
  submitter_label text not null,
  environment text not null,
  browser_info text not null,
  device_info text not null,
  status text default 'new'::text not null,
  priority text default 'medium'::text not null,
  notes jsonb default '[]'::jsonb not null,
  idempotency_key text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  resolved_at timestamptz,
  category text default 'other'::text not null,
  constraint bizops_feedback_issues_pkey PRIMARY KEY (id)
);

create table public.login_attempts (
  id bigint generated always as identity not null,
  email text not null,
  success boolean not null,
  created_at timestamptz default now() not null,
  constraint login_attempts_pkey PRIMARY KEY (id)
);

create table public.profiles (
  id uuid not null,
  email text not null,
  display_name text,
  role text default 'USER'::text not null,
  status text default 'active'::text not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint profiles_pkey PRIMARY KEY (id),
  constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint profiles_role_check CHECK ((role = ANY (ARRAY['SUPER_ADMIN'::text, 'ADMIN'::text, 'USER'::text]))),
  constraint profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

-- ===== Indexes =====
CREATE INDEX login_attempts_email_idx ON public.login_attempts USING btree (email, created_at DESC);
CREATE INDEX profiles_role_idx ON public.profiles USING btree (role);
CREATE UNIQUE INDEX bizops_feedback_issues_idem_key ON public.bizops_feedback_issues USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

-- ===== Functions =====
CREATE OR REPLACE FUNCTION public.current_profile_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from public.profiles where id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data->>'display_name');
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.protect_profile_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.email is distinct from old.email then
    raise exception 'email cannot be changed on profiles directly';
  end if;
  if new.role is distinct from old.role or new.status is distinct from old.status then
    if old.role = 'SUPER_ADMIN' then
      raise exception 'a SUPER_ADMIN role/status cannot be changed';
    end if;
    if auth.uid() = old.id then
      raise exception 'you cannot change your own role or status';
    end if;
    if public.current_profile_role() is distinct from 'SUPER_ADMIN' then
      raise exception 'only SUPER_ADMIN can change another user''s role or status';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.recent_login_failures(p_email text, p_minutes integer DEFAULT 15)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::int from public.login_attempts
  where email = p_email and success = false and created_at > now() - (p_minutes || ' minutes')::interval;
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- ===== Triggers =====
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER protect_profile_columns_trg BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.protect_profile_columns();

-- Event trigger: turns on RLS automatically for every new table in public.
create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();

-- ===== Row level security =====
alter table public.auth_audit_logs enable row level security;
alter table public.bizops_feedback_issues enable row level security;
alter table public.login_attempts enable row level security;
alter table public.profiles enable row level security;

create policy "admin can read audit logs" on public.auth_audit_logs
  as permissive for select to authenticated
  using ((current_profile_role() = ANY (ARRAY['ADMIN'::text, 'SUPER_ADMIN'::text])));

create policy "authenticated can write audit logs" on public.auth_audit_logs
  as permissive for insert to authenticated
  with check ((actor_id = auth.uid()));

create policy "anon_insert_bizops_feedback" on public.bizops_feedback_issues
  as permissive for insert to anon
  with check (true);

create policy "anon_select_bizops_feedback" on public.bizops_feedback_issues
  as permissive for select to anon
  using (true);

create policy "anon_update_bizops_feedback" on public.bizops_feedback_issues
  as permissive for update to anon
  using (true);

create policy "admin can read login attempts" on public.login_attempts
  as permissive for select to authenticated
  using ((current_profile_role() = ANY (ARRAY['ADMIN'::text, 'SUPER_ADMIN'::text])));

create policy "anon can record login attempts" on public.login_attempts
  as permissive for insert to anon, authenticated
  with check (true);

create policy "self or admin can select profiles" on public.profiles
  as permissive for select to authenticated
  using (((id = auth.uid()) OR (current_profile_role() = ANY (ARRAY['ADMIN'::text, 'SUPER_ADMIN'::text]))));

create policy "self or admin can update profiles" on public.profiles
  as permissive for update to authenticated
  using (((id = auth.uid()) OR (current_profile_role() = ANY (ARRAY['ADMIN'::text, 'SUPER_ADMIN'::text]))));
