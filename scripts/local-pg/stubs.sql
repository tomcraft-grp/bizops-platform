-- Supabase environment stubs for the LOCAL throw-away PostgreSQL (scripts/local-pg). Never applied to the real project.
-- What the migrations and tests expect from a Supabase database but a plain PostgreSQL does not have:
--   * roles anon / authenticated / service_role (+ authenticator, supabase_admin), default privileges of the public schema
--   * schema auth: users, uid() / role() / email() / jwt() reading the request.jwt.claims setting (like PostgREST sets it)
--   * schema storage: buckets, objects (RLS on), foldername() / filename() / extension()
--   * schema extensions with pgcrypto / uuid-ossp / pg_trgm
-- Run as the superuser "postgres" BEFORE the migrations (the baseline migration references auth.users and creates an event trigger).

-- ---------------------------------------------------------------------------------------------------------------- roles
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator noinherit login; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin superuser login; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;
-- Supabase puts the extension functions on the search path of every API role
alter role postgres set search_path = "$user", public, extensions;
alter role anon set search_path = "$user", public, extensions;
alter role authenticated set search_path = "$user", public, extensions;
alter role service_role set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------------------------------------------- extensions
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------------------------------------------- public schema defaults
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres, anon, authenticated, service_role;
-- Supabase default privileges: every table / sequence / function created in public is open to the API roles (RLS and explicit REVOKEs in the migrations do the filtering)
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------- auth
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text unique,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);
create unique index if not exists users_email_key on auth.users (lower(email));

create table if not exists auth.identities (
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  email text generated always as (lower(identity_data ->> 'email')) stored,
  id uuid not null default gen_random_uuid() primary key,
  unique (provider_id, provider)
);

-- PostgREST publishes the verified JWT as the setting request.jwt.claims; the tests set it with set_config('request.jwt.claims', ..., true)
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------- storage
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text,
  owner_id text,
  user_metadata jsonb
);
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

create or replace function storage.filename(name text) returns text language plpgsql as $$
declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[array_length(_parts, 1)]; end $$;
create or replace function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[1:array_length(_parts, 1) - 1]; end $$;
create or replace function storage.extension(name text) returns text language plpgsql as $$
declare _parts text[]; _filename text;
begin select string_to_array(name, '/') into _parts; select _parts[array_length(_parts, 1)] into _filename; return reverse(split_part(reverse(_filename), '.', 1)); end $$;
grant execute on function storage.filename(text), storage.foldername(text), storage.extension(text) to anon, authenticated, service_role;
