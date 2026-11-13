-- LINE members: a customer is identified by their LINE account; we keep only a display name, a phone
-- number (so staff can find the member at the POS) and the PDPA consent time. No email/password.

alter table public.profiles
  add column if not exists phone text,
  add column if not exists line_user_id text,
  add column if not exists pdpa_consent_at timestamptz;

alter table public.profiles
  add constraint profiles_phone_format check (phone is null or phone ~ '^0[0-9]{8,9}$');

-- One profile per LINE account; phone is looked up by staff (not unique: families may share a number).
create unique index if not exists profiles_line_user_id_key on public.profiles (line_user_id) where line_user_id is not null;
create index if not exists profiles_phone_idx on public.profiles (phone) where phone is not null;

-- Users may edit their own display_name / phone / pdpa_consent_at (existing RLS "self or admin can update").
-- line_user_id is set only by the line-auth Edge Function (service role, auth.uid() is null) and is otherwise
-- immutable, so nobody can attach their profile to someone else's LINE account.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.email is distinct from old.email then
    raise exception 'email cannot be changed on profiles directly';
  end if;
  if new.line_user_id is distinct from old.line_user_id and auth.uid() is not null then
    raise exception 'line_user_id cannot be changed';
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
