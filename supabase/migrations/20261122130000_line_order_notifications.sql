-- LINE OA order notifications with in-LINE approval.
-- Design: docs/superpowers/specs/2026-11-22-line-order-notifications-design.md   Plan: docs/superpowers/plans/2026-11-22-line-order-notifications.md
-- Rollback: supabase/rollbacks/20261122130000_line_order_notifications_down.sql
--
-- Ships DARK for LINE: line_settings.enabled and quick_approve_enabled are false, so nothing is queued and no LINE action is possible until a SUPER_ADMIN
-- configures it. NOT dark (owner's decision, 2026-11-22): the bank reference becomes optional at Confirm and Post (section B); it applies as soon as this
-- migration is live. Every statement is idempotent (the test runner may send the file again after it is live).
--
-- Sections: A settings / credentials / linking / webhook dedupe, B finance (optional reference, quick confirm), C card data / line_act / queue.

-- ================================================================================================= A settings, credentials, linking
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- A1 settings: one row; credentials are NOT here (Vault), only when and by whom they were set
create table if not exists public.line_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  group_id text, group_name text, group_bound_at timestamptz, group_bound_by uuid, group_left_at timestamptz,
  events jsonb not null default '{"order_new":true,"slip_new":true,"order_status":true,"payment_issue":true,"customer_notify":false}'::jsonb,
  quick_approve_enabled boolean not null default false,
  quick_approve_max_amount numeric(14, 2) not null default 3000 check (quick_approve_max_amount > 0),
  reject_reasons text[] not null default array['สลิปไม่ถูกต้อง', 'ยอดเงินไม่ตรง', 'สินค้าหมด', 'ลูกค้าขอยกเลิก'],
  app_url text not null default 'https://tomcraft-grp.github.io/bizops-platform/',
  secret_set_at timestamptz, secret_set_by uuid, token_set_at timestamptz, token_set_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);
insert into public.line_settings (id) values (true) on conflict (id) do nothing;

-- A2 staff LINE accounts (separate from profiles.line_user_id, which is the CUSTOMER login identity with its own unique index)
create table if not exists public.line_staff_links (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  line_user_id text not null unique check (length(line_user_id) between 10 and 64),
  display_name text,
  linked_at timestamptz not null default now()
);
-- A3 one-time codes (only the sha256 is stored) and the wrong-code counter
create table if not exists public.line_bind_codes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('staff', 'group')),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists line_bind_codes_hash_idx on public.line_bind_codes (code_hash) where used_at is null;
create table if not exists public.line_code_attempts (id bigserial primary key, line_user_id text not null, at timestamptz not null default now());
create index if not exists line_code_attempts_user_idx on public.line_code_attempts (line_user_id, at);
-- A4 webhook deliveries already handled (LINE redelivers on timeouts; webhookEventId is the dedupe key)
create table if not exists public.line_webhook_events (
  webhook_event_id text primary key, received_at timestamptz not null default now(), type text, source_type text
);
-- A5 outbox = the queue AND the delivery log (section C fills and drains it)
create table if not exists public.line_outbox (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in ('order_new', 'slip_new', 'order_status', 'payment_issue', 'customer_notify')),
  order_id uuid references public.shop_orders(id) on delete restrict,
  evidence_id uuid,
  target_type text not null check (target_type in ('group', 'user')),
  target_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'dead', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  line_request_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists line_outbox_card_once on public.line_outbox (event, order_id, coalesce(evidence_id, '00000000-0000-0000-0000-000000000000'::uuid), target_id)
  where event in ('order_new', 'slip_new');
create index if not exists line_outbox_due_idx on public.line_outbox (status, next_attempt_at);
create index if not exists line_outbox_order_idx on public.line_outbox (order_id, created_at);

do $$ declare t text; begin
  foreach t in array array['line_settings', 'line_staff_links', 'line_bind_codes', 'line_code_attempts', 'line_webhook_events', 'line_outbox'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- A6 helpers
create or replace function public.line_is_super()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role = 'SUPER_ADMIN')
$$;
create or replace function public.line_require_super(p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.line_is_super() then raise exception 'You are not allowed to %', p_what using errcode = '42501'; end if;
end $$;
create or replace function public.line_vault_put(p_name text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from vault.secrets where name = p_name;
  if v is null then perform vault.create_secret(p_value, p_name, 'LINE OA (bizops)');
  else perform vault.update_secret(v, p_value); end if;
end $$;
create or replace function public.line_vault_get(p_name text)
returns text language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1
$$;
-- the dispatcher's shared secret (pg_net sends it, line-dispatch checks it): created once, never shown
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'line_dispatch_secret') then
    perform public.line_vault_put('line_dispatch_secret', encode(extensions.gen_random_bytes(32), 'hex'));
  end if;
end $$;
create or replace function public.line_code_hash(p_code text)
returns text language sql immutable set search_path = public as $$ select encode(extensions.digest(p_code, 'sha256'), 'hex') $$;

-- A7 staff reads and SUPER_ADMIN writes
create or replace function public.line_admin_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.line_settings; sup boolean;
begin
  perform public.shop_require_staff('see the LINE settings');
  select * into s from public.line_settings where id;
  sup := public.line_is_super();
  return jsonb_build_object(
    'enabled', s.enabled,
    'group', case when s.group_id is null then null else jsonb_build_object('name', s.group_name, 'bound_at', s.group_bound_at) end,
    'group_left_at', s.group_left_at,
    'events', s.events, 'quick_approve_enabled', s.quick_approve_enabled, 'quick_approve_max_amount', s.quick_approve_max_amount,
    'reject_reasons', to_jsonb(s.reject_reasons), 'app_url', s.app_url,
    'secret_set', s.secret_set_at is not null, 'secret_set_at', s.secret_set_at,
    'token_set', s.token_set_at is not null, 'token_set_at', s.token_set_at,
    'can_edit', sup,
    'my_link', (select jsonb_build_object('display_name', l.display_name, 'linked_at', l.linked_at) from public.line_staff_links l where l.profile_id = auth.uid()),
    'links', case when sup then coalesce((select jsonb_agg(jsonb_build_object('profile_id', l.profile_id, 'name', coalesce(p.display_name, p.email), 'email', p.email,
               'line_name', l.display_name, 'linked_at', l.linked_at) order by l.linked_at)
             from public.line_staff_links l join public.profiles p on p.id = l.profile_id), '[]'::jsonb) else null end,
    'webhook_url', 'https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-webhook');
end $$;

create or replace function public.line_admin_save_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text; s public.line_settings; v_amount numeric; v_reasons text[]; ev text;
begin
  perform public.line_require_super('change the LINE settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_SETTING: send an object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('enabled', 'events', 'quick_approve_enabled', 'quick_approve_max_amount', 'reject_reasons') then raise exception 'INVALID_SETTING: unknown setting %', k; end if;
  end loop;
  select * into s from public.line_settings where id for update;
  if p_patch ? 'events' then
    if jsonb_typeof(p_patch -> 'events') <> 'object' then raise exception 'INVALID_SETTING: events must be an object'; end if;
    for ev in select jsonb_object_keys(p_patch -> 'events') loop
      if ev not in ('order_new', 'slip_new', 'order_status', 'payment_issue', 'customer_notify') or jsonb_typeof(p_patch -> 'events' -> ev) <> 'boolean' then
        raise exception 'INVALID_SETTING: unknown event %', ev; end if;
    end loop;
    s.events := s.events || (p_patch -> 'events');
  end if;
  if p_patch ? 'quick_approve_max_amount' then
    v_amount := (p_patch ->> 'quick_approve_max_amount')::numeric;
    if v_amount is null or v_amount <= 0 or v_amount > 1000000 or v_amount <> round(v_amount, 2) then raise exception 'INVALID_SETTING: the maximum amount must be between 0.01 and 1,000,000'; end if;
    s.quick_approve_max_amount := v_amount;
  end if;
  if p_patch ? 'reject_reasons' then
    if jsonb_typeof(p_patch -> 'reject_reasons') <> 'array' then raise exception 'INVALID_SETTING: reject_reasons must be a list'; end if;
    select array_agg(btrim(x) order by o) into v_reasons from jsonb_array_elements_text(p_patch -> 'reject_reasons') with ordinality r(x, o);
    if coalesce(array_length(v_reasons, 1), 0) not between 1 and 10 or exists (select 1 from unnest(v_reasons) x where x = '' or length(x) > 80) then
      raise exception 'INVALID_SETTING: give 1 to 10 reasons of at most 80 characters'; end if;
    s.reject_reasons := v_reasons;
  end if;
  if p_patch ? 'quick_approve_enabled' then s.quick_approve_enabled := (p_patch ->> 'quick_approve_enabled')::boolean; end if;
  if p_patch ? 'enabled' then
    s.enabled := (p_patch ->> 'enabled')::boolean;
    if s.enabled and (s.secret_set_at is null or s.token_set_at is null or s.group_id is null) then
      raise exception 'LINE_NOT_READY: enter the channel secret and access token and bind the admin group first'; end if;
  end if;
  update public.line_settings set enabled = s.enabled, events = s.events, quick_approve_enabled = s.quick_approve_enabled,
    quick_approve_max_amount = s.quick_approve_max_amount, reject_reasons = s.reject_reasons, updated_at = now(), updated_by = auth.uid() where id;
  perform public.shop_log('line', 'settings', 'line.settings', p_patch);
  return public.line_admin_settings();
end $$;

create or replace function public.line_admin_set_credentials(p_channel_secret text, p_access_token text)
returns void language plpgsql security definer set search_path = public as $$
declare v_secret text := nullif(btrim(coalesce(p_channel_secret, '')), ''); v_token text := nullif(btrim(coalesce(p_access_token, '')), '');
begin
  perform public.line_require_super('set the LINE credentials');
  if v_secret is not null and length(v_secret) not between 16 and 128 then raise exception 'The channel secret does not look right'; end if;
  if v_token is not null and length(v_token) not between 20 and 1000 then raise exception 'The channel access token does not look right'; end if;
  if v_secret is not null then
    perform public.line_vault_put('line_channel_secret', v_secret);
    update public.line_settings set secret_set_at = now(), secret_set_by = auth.uid() where id;
  end if;
  if v_token is not null then
    perform public.line_vault_put('line_channel_token', v_token);
    update public.line_settings set token_set_at = now(), token_set_by = auth.uid() where id;
  end if;
  perform public.shop_log('line', 'settings', 'line.credentials', jsonb_build_object('secret', v_secret is not null, 'token', v_token is not null));   -- never the values
end $$;

-- A8 linking: a code shown once on the screen, sent to the OA in LINE, redeemed by the webhook
create or replace function public.line_link_code(p_kind text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_code text; v_exp timestamptz := now() + interval '10 minutes'; i int := 0;
begin
  if p_kind = 'staff' then perform public.shop_require_staff('link a LINE account');
  elsif p_kind = 'group' then perform public.line_require_super('bind the LINE admin group');
  else raise exception 'Unknown code kind'; end if;
  delete from public.line_bind_codes where profile_id = auth.uid() and kind = p_kind and used_at is null;
  loop
    v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.line_bind_codes where code_hash = public.line_code_hash(v_code) and used_at is null and expires_at > now());
    i := i + 1; if i > 10 then raise exception 'Could not make a code, try again'; end if;
  end loop;
  insert into public.line_bind_codes (kind, profile_id, code_hash, expires_at) values (p_kind, auth.uid(), public.line_code_hash(v_code), v_exp);
  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end $$;

create or replace function public.line_unlink(p_profile uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_target uuid := coalesce(p_profile, auth.uid());
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  if v_target <> auth.uid() then perform public.line_require_super('unlink another person''s LINE'); end if;
  delete from public.line_staff_links where profile_id = v_target;
  perform public.shop_log('line', v_target::text, 'line.unlink', '{}'::jsonb);
end $$;

-- A9 service role only (Edge Functions)
create or replace function public.line_credentials_internal()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('channel_secret', public.line_vault_get('line_channel_secret'), 'access_token', public.line_vault_get('line_channel_token'),
    'dispatch_secret', public.line_vault_get('line_dispatch_secret'))
$$;

create or replace function public.line_webhook_seen(p_event_id text, p_type text, p_source text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if coalesce(p_event_id, '') = '' then return true; end if;          -- no id (very old events): cannot dedupe, the action itself is idempotent anyway
  insert into public.line_webhook_events (webhook_event_id, type, source_type) values (p_event_id, p_type, p_source) on conflict do nothing;
  get diagnostics n = row_count;
  if random() < 0.02 then delete from public.line_webhook_events where received_at < now() - interval '30 days'; end if;
  return n = 1;
end $$;

create or replace function public.line_redeem_code(p_line_user text, p_display_name text, p_code text, p_group text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_code text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g'); b public.line_bind_codes; p public.profiles;
        v_kind text := case when p_group is null then 'staff' else 'group' end;
begin
  if coalesce(p_line_user, '') = '' then return jsonb_build_object('result', 'bad_code'); end if;
  if (select count(*) from public.line_code_attempts where line_user_id = p_line_user and at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('result', 'rate_limited'); end if;
  if v_code ~ '^[0-9]{6}$' then
    select * into b from public.line_bind_codes where code_hash = public.line_code_hash(v_code) and used_at is null and expires_at > now() and kind = v_kind
      order by created_at desc limit 1 for update;
  end if;
  if b.id is not null then
    select * into p from public.profiles where id = b.profile_id and status = 'active'
      and role = any (case when v_kind = 'group' then array['SUPER_ADMIN'] else array['ADMIN', 'SUPER_ADMIN'] end);
  end if;
  if b.id is null or p.id is null then
    insert into public.line_code_attempts (line_user_id) values (p_line_user);
    return jsonb_build_object('result', 'bad_code');
  end if;
  update public.line_bind_codes set used_at = now() where id = b.id;
  -- the audit rows name the person who made the code
  perform set_config('request.jwt.claim.sub', p.id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p.id, 'role', 'authenticated', 'email', p.email)::text, true);
  if v_kind = 'staff' then
    delete from public.line_staff_links where line_user_id = p_line_user or profile_id = p.id;
    insert into public.line_staff_links (profile_id, line_user_id, display_name) values (p.id, p_line_user, left(p_display_name, 120));
    perform public.shop_log('line', p.id::text, 'line.link', jsonb_build_object('line_name', left(p_display_name, 120)));
    return jsonb_build_object('result', 'linked', 'name', coalesce(p.display_name, p.email));
  end if;
  update public.line_settings set group_id = p_group, group_name = left(p_display_name, 120), group_bound_at = now(), group_bound_by = p.id, group_left_at = null where id;
  perform public.shop_log('line', 'settings', 'line.group_bind', jsonb_build_object('group_name', left(p_display_name, 120)));
  return jsonb_build_object('result', 'group_bound', 'name', coalesce(p.display_name, p.email));
end $$;

create or replace function public.line_group_left(p_group text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.line_settings set group_id = null, group_name = null, group_left_at = now() where id and group_id = p_group;
end $$;

-- A10 grants: clients call the admin RPCs; the Edge Functions (service role) call the internal ones; helpers are callable by no client
revoke execute on function public.line_vault_put(text, text), public.line_vault_get(text), public.line_credentials_internal(), public.line_webhook_seen(text, text, text),
  public.line_redeem_code(text, text, text, text), public.line_group_left(text), public.line_code_hash(text) from public, anon, authenticated;
grant execute on function public.line_credentials_internal(), public.line_webhook_seen(text, text, text), public.line_redeem_code(text, text, text, text),
  public.line_group_left(text) to service_role;
revoke execute on function public.line_admin_settings(), public.line_admin_save_settings(jsonb), public.line_admin_set_credentials(text, text),
  public.line_link_code(text), public.line_unlink(uuid), public.line_is_super(), public.line_require_super(text) from public, anon;
grant execute on function public.line_admin_settings(), public.line_admin_save_settings(jsonb), public.line_admin_set_credentials(text, text),
  public.line_link_code(text), public.line_unlink(uuid) to authenticated;
