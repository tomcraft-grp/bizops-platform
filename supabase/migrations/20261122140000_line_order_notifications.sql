-- LINE OA order notifications with in-LINE approval.
-- Design: docs/superpowers/specs/2026-11-22-line-order-notifications-design.md   Plan: docs/superpowers/plans/2026-11-22-line-order-notifications.md
-- Rollback: supabase/rollbacks/20261122140000_line_order_notifications_down.sql
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
  if p_name not like 'line\_%' then raise exception 'Only LINE secrets'; end if;
  select id into v from vault.secrets where name = p_name;
  if v is null then perform vault.create_secret(p_value, p_name, 'LINE OA (bizops)');
  else perform vault.update_secret(v, p_value); end if;
end $$;
create or replace function public.line_vault_get(p_name text)
returns text language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name and p_name like 'line\_%' limit 1
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
do $$ begin     -- the Vault helpers are internal even for the service role (it would otherwise read any LINE secret by name through the API)
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public.line_vault_put(text, text), public.line_vault_get(text), public.line_code_hash(text) from service_role;
  end if;
end $$;
revoke execute on function public.line_admin_settings(), public.line_admin_save_settings(jsonb), public.line_admin_set_credentials(text, text),
  public.line_link_code(text), public.line_unlink(uuid), public.line_is_super(), public.line_require_super(text) from public, anon;
grant execute on function public.line_admin_settings(), public.line_admin_save_settings(jsonb), public.line_admin_set_credentials(text, text),
  public.line_link_code(text), public.line_unlink(uuid) to authenticated;

-- ================================================================================================= B finance: optional bank reference, quick confirm
-- Owner's decision (2026-11-22): the bank reference is optional at Confirm and at Post for a transfer slip. With a reference, every existing reuse check runs as
-- before. Without one, a payment with the same amount, the same receiving account and a transfer time in the same minute is a suspected duplicate
-- (DUPLICATE_SUSPECT, SQLSTATE 23505); entering a reference is how a person proceeds anyway. The legacy one-step finance_verify_evidence still requires one.
-- The four functions below are copied from 20261120100000_slip_review.sql and changed only where marked "-- LINE:".

alter table public.finance_payment_evidence add column if not exists confirmed_via text
  constraint finance_payment_evidence_confirmed_via_chk check (confirmed_via is null or confirmed_via in ('web', 'line_quick'));
create index if not exists finance_evidence_quickdup_idx on public.finance_payment_evidence (bank_account_id, date_trunc('minute', coalesce(transfer_at, confirmed_transfer_at) at time zone 'UTC'))
  where status in ('confirmed', 'verified');

-- B1 the duplicate rule by amount + receiving account + time: 'evidence' / 'receipt' / 'deposit' when another payment matches, otherwise null.
--   The time matches within one minute either way (minute buckets), because one side may be a customer-given time that is a minute off.
--   p_no_ref_only = the new payment HAS a bank reference: then only payments WITHOUT one can be the same transfer (two payments that both carry references are
--   compared by reference, as before). Without this direction a transfer saved without a reference could be recorded again later with its reference.
--   Rejected slips, reversed receipts and unverified deposits never count.
create or replace function public.finance_quick_dup(p_amount numeric, p_bank_account uuid, p_transfer_at timestamptz, p_except uuid, p_no_ref_only boolean default false)
returns text language sql stable security definer set search_path = public as $$
  with w as (select date_trunc('minute', p_transfer_at at time zone 'UTC') as m)
  select coalesce(
    (select 'evidence' from public.finance_payment_evidence x, w
      where x.id is distinct from p_except and x.status in ('confirmed', 'verified') and x.method = 'transfer'
        and x.bank_account_id is not distinct from p_bank_account
        and coalesce(x.verified_amount, x.confirmed_amount) = p_amount
        and date_trunc('minute', coalesce(x.transfer_at, x.confirmed_transfer_at) at time zone 'UTC') between w.m - interval '1 minute' and w.m + interval '1 minute'
        and (not p_no_ref_only or (x.confirmed_bank_ref is null and x.bank_trans_ref is null)) limit 1),
    (select 'receipt' from public.finance_receipts r, w
      where r.method = 'bank_transfer' and r.status = 'posted' and r.evidence_id is distinct from p_except and r.bank_account_id is not distinct from p_bank_account and r.amount = p_amount
        and date_trunc('minute', r.received_at at time zone 'UTC') between w.m - interval '1 minute' and w.m + interval '1 minute'
        and (not p_no_ref_only or r.bank_trans_ref is null) limit 1),
    (select 'deposit' from public.finance_wallet_deposits d, w
      where not p_no_ref_only and d.id is distinct from p_except and d.status = 'verified' and d.bank_account_id is not distinct from p_bank_account and d.verified_amount = p_amount
        and date_trunc('minute', d.transfer_at at time zone 'UTC') between w.m - interval '1 minute' and w.m + interval '1 minute' limit 1))
$$;
-- a payment the person explicitly declared a different transfer (p_distinct): the core skips the rule for this transaction only
create or replace function public.finance_dup_check(p_amount numeric, p_bank_account uuid, p_transfer_at timestamptz, p_except uuid, p_has_ref boolean)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if current_setting('finance.dup_override', true) = 'on' then return; end if;
  if public.finance_quick_dup(p_amount, p_bank_account, p_transfer_at, p_except, p_has_ref) is not null then
    raise exception 'DUPLICATE_SUSPECT: a payment of % to the same account within a minute of this one is already recorded%; check the bank statement, and if these are two different transfers say so',
      p_amount, case when p_has_ref then ' without a bank reference' else '' end using errcode = '23505';
  end if;
end $$;

-- B2 the core: a null reference for a transfer is accepted only on the Confirm -> Post path (p_from_status = 'confirmed')
create or replace function public.finance_verify_core(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz,
  p_note text, p_via text, p_from_status text default 'submitted', p_method text default 'transfer')
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; st jsonb; outstanding numeric; rc public.finance_receipts; result text; v_alloc numeric := 0;
        v_rid uuid := gen_random_uuid(); v_rno text; v_excess numeric := 0; v_t public.finance_wallet_transactions;
        v_cash boolean := p_method = 'cash'; v_ref text := case when p_method = 'cash' then null else nullif(trim(p_bank_trans_ref), '') end;   -- LINE: '' is no reference
begin
  if p_via not in ('staff', 'provider', 'bank') then raise exception 'Unknown verification source'; end if;
  if coalesce(p_from_status, '') not in ('submitted', 'confirmed') then raise exception 'Unknown starting status'; end if;
  if coalesce(p_method, '') not in ('transfer', 'cash') then raise exception 'Unknown payment method'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  -- LINE: the reference stays required for the one-step verify (and providers); after a Confirm it is optional
  if not v_cash and v_ref is null and p_from_status <> 'confirmed' then raise exception 'The bank transaction reference is required'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> p_from_status then raise exception 'This slip is already %', e.status; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;   -- serialises settlement of one invoice
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  -- LINE: the exact-reference check only when there is a reference
  if v_ref is not null and (exists (select 1 from public.finance_receipts where bank_trans_ref = v_ref) or exists (select 1 from public.finance_wallet_deposits where bank_trans_ref = v_ref and status = 'verified')) then
    raise exception 'Bank transaction % was already recorded (reused slip?)', v_ref using errcode = '23505'; end if;
  if p_transfer_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The transfer is older than the invoice'; end if;
  -- LINE: the same transfer recorded twice, by amount + account + time (with a reference: against payments that have none), on EVERY path that records money
  if not v_cash then perform public.finance_dup_check(p_amount, e.bank_account_id, p_transfer_at, e.id, v_ref is not null); end if;

  st := public.finance_invoice_state_raw(i.id);
  outstanding := (st ->> 'outstanding')::numeric;
  if v_cash and p_amount > outstanding then
    raise exception 'CASH_OVERPAY: cash of % is more than the % this invoice still owes; cash never makes a wallet credit', p_amount, outstanding; end if;
  v_alloc := least(p_amount, outstanding);
  v_excess := p_amount - v_alloc;
  v_rno := public.next_doc_no('PAYMENT');
  update public.finance_payment_evidence set status = 'verified', verified_via = p_via, verified_amount = p_amount, bank_trans_ref = v_ref,
    transfer_at = p_transfer_at, review_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now(),
    posted_by = case when p_from_status = 'confirmed' then auth.uid() else posted_by end,
    posted_at = case when p_from_status = 'confirmed' then now() else posted_at end where id = e.id;
  -- the part above what the invoice owes is the customer's money: it goes to their wallet (one ledger row, same transaction)
  if v_excess > 0 then
    v_t := public.finance_wallet_apply(i.customer_id, 'DEPOSIT', 'credit', v_excess, 'OVR:' || v_rid::text, 'receipt', v_rid, v_rno, 'bank_transfer', e.bank_account_id, 'verified',
                                       auth.uid(), auth.uid(), 'Paid above invoice ' || i.invoice_no || ' (receipt ' || v_rno || ')',
                                       'โอนเกินยอดใบแจ้งหนี้ เข้ากระเป๋าเงิน / Paid above the invoice, credited to your wallet');
  end if;
  insert into public.finance_receipts (id, receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at, needs_review, method, bank_account_id, credit_txn_id)
    values (v_rid, v_rno, i.customer_id, i.id, e.id, p_amount, v_ref, p_transfer_at, false, case when v_cash then 'cash' else 'bank_transfer' end,
            case when v_cash then null else e.bank_account_id end, v_t.id)
    returning * into rc;
  if v_alloc > 0 then
    insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, i.id, v_alloc);
  end if;
  result := case when v_excess > 0 then 'overpaid_credited' when p_amount = outstanding then 'fully_paid' else 'partially_paid' end;
  if v_cash then
    -- ledger: money in the cash box; it settles the receivable (there is never an overpayment)
    perform public.finance_gl_enqueue('CASH_RECEIPT', 'receipt', rc.id, rc.receipt_no, i.customer_id, p_amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'cash', 'amount', p_amount), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', v_alloc)),
      public.finance_gl_issue_dep(i.id));
  else
    -- ledger: money in the bank; the applied part settles the receivable, any overpayment is customer credit (wallet liability)
    perform public.finance_gl_enqueue('BANK_RECEIPT', 'receipt', rc.id, rc.receipt_no, i.customer_id, p_amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', e.bank_account_id))
        || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
        || case when v_excess > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', v_excess, 'wallet', true)) else '[]'::jsonb end,
      public.finance_gl_issue_dep(i.id));
  end if;
  perform public.finance_log('evidence', e.id, 'evidence.verify', jsonb_build_object('via', p_via, 'amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', v_ref, 'bank_account', e.bank_account_id)
    || case when v_cash then jsonb_build_object('method', 'cash') else '{}'::jsonb end);
  perform public.finance_log('receipt', rc.id, 'receipt.post', jsonb_build_object('invoice', i.id, 'amount', p_amount, 'outstanding_before', outstanding, 'result', result, 'credited_to_wallet', v_excess));
  return jsonb_build_object('result', result, 'receipt_no', rc.receipt_no, 'credited_to_wallet', v_excess, 'state', public.finance_invoice_state_raw(i.id));
end $$;

-- B3 Confirm: the reference may be empty; p_distinct = the person checked the statement and says a suspected duplicate is a different transfer (LINE: changed lines marked)
drop function if exists public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text);
create or replace function public.finance_confirm_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz, p_note text default null,
  p_distinct boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; v_ref text := nullif(trim(p_bank_trans_ref), ''); v_note text := nullif(trim(p_note), '');   -- LINE: '' is no reference
begin
  perform public.finance_require('verify', 'confirm payments');
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  -- LINE: the reference is optional; when given it is validated as before
  if v_ref is not null and (length(public.finance_slip_ref(v_ref)) < 4 or length(v_ref) > 80) then raise exception 'The bank transaction reference must have 4 to 80 letters or digits'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  if p_transfer_at > now() + interval '10 minutes' then raise exception 'The payment time is in the future'; end if;   -- the same limit and words as Record payment
  if length(v_note) > 500 then raise exception 'The note is too long (500 characters at most)'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> 'submitted' then raise exception 'This slip is already %', e.status; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;   -- serialises with every other payment on the invoice
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  if v_ref is not null and public.finance_ref_in_use(v_ref, e.id) is not null then                                           -- LINE: only with a reference
    raise exception 'Bank transaction % was already recorded (reused slip?)', v_ref using errcode = '23505'; end if;
  if coalesce(p_distinct, false) then                                                                                          -- LINE: the duplicate rule, both directions
    if public.finance_quick_dup(p_amount, e.bank_account_id, p_transfer_at, e.id, v_ref is not null) is not null then
      perform public.finance_log('evidence', e.id, 'evidence.dup_override', jsonb_build_object('amount', p_amount, 'trans_ref', v_ref, 'at', p_transfer_at)); end if;
  else
    perform public.finance_dup_check(p_amount, e.bank_account_id, p_transfer_at, e.id, v_ref is not null);
  end if;
  if p_transfer_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The transfer is older than the invoice'; end if;
  update public.finance_payment_evidence set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), confirmed_amount = p_amount, confirmed_bank_ref = v_ref,
    confirmed_transfer_at = p_transfer_at, confirm_note = v_note, confirmed_via = 'web' where id = e.id;                    -- LINE: confirmed_via
  perform public.finance_log('evidence', e.id, 'evidence.confirm', jsonb_build_object('amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', v_ref, 'bank_account', e.bank_account_id));
  return jsonb_build_object('status', 'confirmed', 'evidence_id', e.id, 'amount', p_amount);
end $$;

-- B4 Post: an optional reference fills in a missing one; the duplicate rule runs again in the core (hours may have passed since Confirm); p_distinct as in Confirm
drop function if exists public.finance_post_evidence(uuid, text);
drop function if exists public.finance_post_evidence(uuid, text, text);
create or replace function public.finance_post_evidence(p_evidence uuid, p_note text default null, p_bank_ref text default null, p_distinct boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; rc public.finance_receipts; v jsonb; v_add text := nullif(trim(p_bank_ref), '');   -- LINE: p_bank_ref
begin
  perform public.finance_require(case when coalesce((select s.post_requires_manager from public.finance_settings s where s.id), false) then 'manage' else 'verify' end, 'post payments');
  select * into e from public.finance_payment_evidence where id = p_evidence for update;     -- the evidence first, then the invoice (the order the core uses)
  if not found then raise exception 'Evidence not found'; end if;
  if e.method = 'cash' then perform public.finance_require('manage', 'post cash payments'); end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;
  if e.status = 'verified' then
    select * into rc from public.finance_receipts where evidence_id = e.id;
    if found then
      return jsonb_build_object('replay', true,
        'result', coalesce((select ev.detail ->> 'result' from public.finance_events ev where ev.entity = 'receipt' and ev.entity_id = rc.id and ev.action = 'receipt.post' order by ev.id limit 1), 'already_posted'),
        'receipt_no', rc.receipt_no, 'credited_to_wallet', coalesce((select t.amount from public.finance_wallet_transactions t where t.id = rc.credit_txn_id), 0),
        'state', public.finance_invoice_state_raw(e.invoice_id));
    end if;
  end if;
  if e.status <> 'confirmed' then raise exception 'NOT_CONFIRMED: this slip is % (it must be confirmed before it is posted)', e.status; end if;
  -- LINE: a reference typed at Post (from the bank statement) fills in a slip confirmed without one; it is validated and checked like one typed at Confirm
  if e.method = 'transfer' and e.confirmed_bank_ref is null and v_add is not null then
    if length(public.finance_slip_ref(v_add)) < 4 or length(v_add) > 80 then raise exception 'The bank transaction reference must have 4 to 80 letters or digits'; end if;
    if public.finance_ref_in_use(v_add, e.id) is not null then raise exception 'Bank transaction % was already recorded (reused slip?)', v_add using errcode = '23505'; end if;
    update public.finance_payment_evidence set confirmed_bank_ref = v_add where id = e.id returning * into e;
    perform public.finance_log('evidence', e.id, 'evidence.ref_added', jsonb_build_object('trans_ref', v_add));
  end if;
  -- Confirm checked that the reference was new, but hours can pass before Post (end-of-day approval): the one-step verify may have recorded the same transfer on
  -- another slip meanwhile, typed differently (the core only compares exactly). Look again, in the normalised form, before any money is recorded.
  if e.method = 'transfer' and e.confirmed_bank_ref is not null and public.finance_ref_in_use(e.confirmed_bank_ref, e.id) is not null then
    raise exception 'Bank transaction % was already recorded (reused slip?)', e.confirmed_bank_ref using errcode = '23505'; end if;
  -- LINE: the duplicate rule runs in the core; a person who says it is a different transfer lets this Post through (and it is logged)
  if coalesce(p_distinct, false) and e.method = 'transfer' then
    perform set_config('finance.dup_override', 'on', true);
    if public.finance_quick_dup(e.confirmed_amount, e.bank_account_id, e.confirmed_transfer_at, e.id, e.confirmed_bank_ref is not null) is not null then
      perform public.finance_log('evidence', e.id, 'evidence.dup_override', jsonb_build_object('amount', e.confirmed_amount, 'trans_ref', e.confirmed_bank_ref, 'at', e.confirmed_transfer_at)); end if;
  end if;
  v := public.finance_verify_core(e.id, e.confirmed_amount, case when e.method = 'cash' then null else e.confirmed_bank_ref end, e.confirmed_transfer_at, p_note, 'staff', 'confirmed', e.method);
  perform set_config('finance.dup_override', '', true);                                                                          -- LINE: the override covers this Post only
  perform public.finance_log('evidence', e.id, 'evidence.post', jsonb_build_object('receipt_no', v ->> 'receipt_no', 'amount', e.confirmed_amount, 'note', nullif(trim(p_note), '')));
  return v || jsonb_build_object('replay', false);
end $$;

-- B5 LINE quick confirm: the claimed amount and time, no reference. Called only by line_act (section C), acting as the staff member; the role is checked here,
-- the order-level guards (cap, transfer time, windows, AI) in line_quick_check.
create or replace function public.finance_quick_confirm_evidence(p_evidence uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices;
begin
  perform public.finance_require('verify', 'confirm payments');
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> 'submitted' then raise exception 'This slip is already %', e.status; end if;
  if e.method <> 'transfer' or e.claimed_transfer_at is null then raise exception 'NOT_ELIGIBLE: a transfer with its transfer time is needed'; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  perform public.finance_dup_check(e.claimed_amount, e.bank_account_id, e.claimed_transfer_at, e.id, false);     -- no override from LINE: a suspect goes to the web
  update public.finance_payment_evidence set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), confirmed_amount = e.claimed_amount, confirmed_bank_ref = null,
    confirmed_transfer_at = e.claimed_transfer_at, confirm_note = 'LINE quick approve', confirmed_via = 'line_quick' where id = e.id;
  perform public.finance_log('evidence', e.id, 'evidence.confirm', jsonb_build_object('amount', e.claimed_amount, 'claimed', e.claimed_amount, 'trans_ref', null,
    'bank_account', e.bank_account_id, 'via', 'line_quick'));
  return jsonb_build_object('status', 'confirmed', 'evidence_id', e.id, 'amount', e.claimed_amount);
end $$;

-- B6 the review list: confirmed_via and no_ref on every row, and the filter "via" (LINE: changed lines marked)
create or replace function public.finance_review_list(p_filter jsonb default '{}'::jsonb, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  f jsonb := coalesce(p_filter, '{}'::jsonb); k text;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_stage text[]; v_result text[]; v_source text[]; v_method text[]; v_reason text; v_q text; v_pat text; v_qref text;
  v_from date; v_to date; v_from_ts timestamptz; v_to_ts timestamptz; v_res jsonb;
  v_via text[];                                                                                                                     -- LINE
begin
  perform public.finance_require('view', 'see the slip review');
  if jsonb_typeof(f) = 'null' then f := '{}'::jsonb; end if;
  if jsonb_typeof(f) <> 'object' then raise exception 'INVALID_FILTER: the filter must be an object'; end if;
  for k in select jsonb_object_keys(f) loop
    if k not in ('stage', 'ai_result', 'from', 'to', 'reason', 'source', 'method', 'search', 'via') then raise exception 'INVALID_FILTER: unknown filter %', k; end if;   -- LINE: via
  end loop;
  v_stage := public.finance_review_arr(f -> 'stage', 'stage', array['slip_submitted', 'ai_completed', 'manual_review', 'confirmed', 'posted', 'rejected', 'more_evidence']);
  v_result := public.finance_review_arr(f -> 'ai_result', 'ai_result', array['match', 'amount_mismatch', 'date_mismatch', 'time_anomaly', 'duplicate_suspected', 'suspicious_slip', 'manual_review']);
  v_source := public.finance_review_arr(f -> 'source', 'source', array['customer_slip', 'staff_entry']);
  v_method := public.finance_review_arr(f -> 'method', 'method', array['transfer', 'cash']);
  v_via := public.finance_review_arr(f -> 'via', 'via', array['web', 'line_quick']);                                                -- LINE
  v_from := public.finance_review_date(f -> 'from', 'from');
  v_to := public.finance_review_date(f -> 'to', 'to');
  if jsonb_typeof(f -> 'reason') not in ('string', 'null') or jsonb_typeof(f -> 'search') not in ('string', 'null') then
    raise exception 'INVALID_FILTER: reason and search must be text'; end if;
  v_reason := nullif(btrim(f ->> 'reason'), '');
  v_q := nullif(btrim(coalesce(f ->> 'search', '')), '');
  if v_q is not null then
    v_pat := '%' || replace(replace(replace(left(v_q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if length(public.finance_slip_ref(left(v_q, 80))) >= 4 then v_qref := public.finance_slip_ref(left(v_q, 80)); end if;
  end if;
  v_from_ts := v_from::timestamp at time zone 'Asia/Bangkok';                  -- the start of the first day ...
  v_to_ts := (v_to + 1)::timestamp at time zone 'Asia/Bangkok';                -- ... up to (not including) the start of the day after the last one

  with base as (
    select ev.id, ev.created_at, ev.source, ev.method, ev.status, ev.invoice_id, ev.claimed_amount, ev.claimed_ref, ev.bank_trans_ref, ev.confirmed_amount, ev.confirmed_bank_ref, ev.posted_at,
           ev.confirmed_via,                                                                                                      -- LINE
           i.invoice_no, i.amount as invoice_amount, c.name as customer_name, c.profile_id,
           o.id as order_id, o.order_no, o.created_at as order_created_at, o.total as order_total, nullif(btrim(o.contact_phone), '') as contact_phone,
           na.status as a_status, na.result as a_result, na.reasons as a_reasons, dn.extracted as d_extracted, dn.qr as d_qr, dn.overall_confidence as d_conf,
           public.finance_evidence_stage(ev.status, na.status, na.result) as stage
      from public.finance_payment_evidence ev
      join public.finance_invoices i on i.id = ev.invoice_id
      join public.finance_customers c on c.id = ev.customer_id
      left join public.shop_orders o on o.invoice_id = ev.invoice_id
      left join lateral (select a.status, a.result, a.reasons from public.finance_slip_analysis a where a.evidence_id = ev.id order by a.attempt desc limit 1) na on true
      left join lateral (select a.extracted, a.qr, a.overall_confidence from public.finance_slip_analysis a where a.evidence_id = ev.id and a.status = 'done' order by a.attempt desc limit 1) dn on true
     where (v_from_ts is null or ev.created_at >= v_from_ts) and (v_to_ts is null or ev.created_at < v_to_ts)
       and (v_source is null or ev.source = any (v_source)) and (v_method is null or ev.method = any (v_method))
       and (v_via is null or ev.confirmed_via = any (v_via))                                                                    -- LINE
  ), flt as (
    select b.* from base b
     where (v_stage is null or b.stage = any (v_stage)) and (v_result is null or b.a_result = any (v_result))
       and (v_reason is null or b.a_reasons @> jsonb_build_array(jsonb_build_object('code', v_reason)))
       and (v_pat is null
            or b.order_no ilike v_pat or b.invoice_no ilike v_pat or b.customer_name ilike v_pat
            or b.confirmed_bank_ref ilike v_pat or b.claimed_ref ilike v_pat or b.bank_trans_ref ilike v_pat
            or (b.d_extracted ->> 'trans_ref') ilike v_pat or (b.d_qr ->> 'trans_ref') ilike v_pat
            or (v_qref is not null and (public.finance_slip_ref(b.confirmed_bank_ref) like '%' || v_qref || '%' or public.finance_slip_ref(b.claimed_ref) like '%' || v_qref || '%'
                                        or public.finance_slip_ref(b.bank_trans_ref) like '%' || v_qref || '%' or public.finance_slip_ref(b.d_extracted ->> 'trans_ref') like '%' || v_qref || '%'
                                        or public.finance_slip_ref(b.d_qr ->> 'trans_ref') like '%' || v_qref || '%')))
  ), tot as (
    select count(*) as n from flt
  ), page as (
    select * from flt order by created_at desc, id limit v_lim offset v_off
  )
  select jsonb_build_object('total', (select n from tot), 'items', coalesce(jsonb_agg(jsonb_build_object(
      'evidence_id', page.id, 'created_at', page.created_at, 'source', page.source, 'method', page.method, 'status', page.status, 'stage', page.stage,
      'order_id', page.order_id, 'order_no', page.order_no, 'order_created_at', page.order_created_at, 'order_total', page.order_total,
      'invoice_id', page.invoice_id, 'invoice_no', page.invoice_no, 'invoice_amount', page.invoice_amount,
      'paid', (s.st ->> 'paid')::numeric, 'outstanding', (s.st ->> 'outstanding')::numeric,
      'customer_name', page.customer_name, 'customer_phone', coalesce(page.contact_phone, (select p.phone from public.profiles p where p.id = page.profile_id)),
      'expected_amount', public.finance_review_expected(page.id), 'claimed_amount', page.claimed_amount,
      'ai_amount', case when jsonb_typeof(page.d_extracted -> 'amount') = 'number' then (page.d_extracted ->> 'amount')::numeric end,
      'ai_transfer_at', page.d_extracted ->> 'transfer_at', 'ai_result', page.a_result, 'ai_confidence', page.d_conf, 'ai_status', page.a_status,
      'reasons', coalesce((select jsonb_agg(r.value ->> 'code' order by r.ord) from jsonb_array_elements(page.a_reasons) with ordinality as r(value, ord)), '[]'::jsonb),
      'confirmed_amount', page.confirmed_amount, 'confirmed_bank_ref', page.confirmed_bank_ref, 'posted_at', page.posted_at,
      'confirmed_via', page.confirmed_via,                                                                                         -- LINE
      'no_ref', page.method = 'transfer' and page.confirmed_bank_ref is null and page.bank_trans_ref is null)                       -- LINE
      order by page.created_at desc, page.id), '[]'::jsonb))
    into v_res
    from page cross join lateral (select public.finance_invoice_state_raw(page.invoice_id) as st) s;
  return v_res;
end $$;

-- B6b a wallet top-up recorded WITH a reference must not be the transfer an order payment was already recorded with WITHOUT one (copied from
-- 20261115200000_wallet_payments.sql, changed only where marked)
create or replace function public.finance_deposit_verify(p_deposit uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d public.finance_wallet_deposits; v_t public.finance_wallet_transactions; v_bank public.finance_bank_accounts; v_cust public.finance_customers;
begin
  perform public.finance_require('verify', 'verify deposits');
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if coalesce(trim(p_bank_trans_ref), '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  select * into v_d from public.finance_wallet_deposits where id = p_deposit for update;
  if not found then raise exception 'Deposit not found'; end if;
  if v_d.status not in ('submitted', 'under_review') then raise exception 'DEPOSIT_NOT_REVIEWABLE: this deposit is %', v_d.status; end if;
  if exists (select 1 from public.finance_receipts where bank_trans_ref = trim(p_bank_trans_ref)) or exists (select 1 from public.finance_wallet_deposits where bank_trans_ref = trim(p_bank_trans_ref) and status = 'verified') then
    raise exception 'Bank transaction % was already recorded (reused slip?)', trim(p_bank_trans_ref) using errcode = '23505'; end if;
  perform public.finance_dup_check(p_amount, v_d.bank_account_id, p_transfer_at, v_d.id, true);                   -- LINE: against order payments recorded without a reference
  if p_transfer_at < v_d.created_at - interval '1 day' then raise exception 'The transfer is older than the deposit request'; end if;
  select * into v_bank from public.finance_bank_accounts where id = v_d.bank_account_id;
  select * into v_cust from public.finance_customers where id = v_d.customer_id;
  v_t := public.finance_wallet_apply(v_d.customer_id, 'DEPOSIT', 'credit', p_amount, 'DEP:' || v_d.id::text, 'deposit', v_d.id, v_d.deposit_no, 'bank_transfer', v_d.bank_account_id, 'verified',
                                     v_cust.profile_id, auth.uid(), 'Verified bank transfer ' || trim(p_bank_trans_ref), null);
  update public.finance_wallet_deposits set status = 'verified', verified_amount = p_amount, bank_trans_ref = trim(p_bank_trans_ref), transfer_at = p_transfer_at,
    review_note = nullif(btrim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now(), wallet_txn_id = v_t.id where id = p_deposit returning * into v_d;
  perform public.finance_gl_enqueue('WALLET_DEPOSIT', 'wallet_txn', v_t.id, v_t.txn_no, v_d.customer_id, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', v_d.bank_account_id),
                      jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true)));
  perform public.finance_log('deposit', v_d.id, 'deposit.verify', jsonb_build_object('no', v_d.deposit_no, 'claimed', v_d.amount, 'verified', p_amount, 'trans_ref', trim(p_bank_trans_ref), 'txn', v_t.txn_no));
  return jsonb_build_object('deposit', to_jsonb(v_d), 'txn_no', v_t.txn_no, 'balance', v_t.balance_after);
end $$;

-- B7 grants: the new Confirm and Post signatures get the grants the old ones had; the duplicate rule and the quick confirm are internal
revoke execute on function public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text, boolean), public.finance_post_evidence(uuid, text, text, boolean) from public, anon;
grant execute on function public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text, boolean), public.finance_post_evidence(uuid, text, text, boolean) to authenticated;
revoke execute on function public.finance_quick_dup(numeric, uuid, timestamptz, uuid, boolean), public.finance_dup_check(numeric, uuid, timestamptz, uuid, boolean),
  public.finance_quick_confirm_evidence(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public.finance_verify_core(uuid, numeric, text, timestamptz, text, text, text, text), public.finance_quick_dup(numeric, uuid, timestamptz, uuid, boolean),
      public.finance_dup_check(numeric, uuid, timestamptz, uuid, boolean), public.finance_quick_confirm_evidence(uuid) from service_role;
  end if;
end $$;

-- ================================================================================================= C card data, line_act, queue
-- C1 who did the last thing to an order (for "already accepted by A at 14:05")
create or replace function public.line_person(p uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(display_name), ''), email) from public.profiles where id = p
$$;
create or replace function public.line_last_action(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('by', coalesce(public.line_person(e.actor), e.actor_email, 'ระบบ'), 'at', e.at)
    from public.shop_events e where e.entity = 'order' and e.entity_id = p_order::text
      and ((e.action = 'order.status' and e.detail ->> 'from' = 'new') or e.action = 'order.cancel')   -- who took it out of "new" (not who moved it on later)
    order by e.id desc limit 1
$$;
-- the payment of an order already handled on the web (confirmed, posted or rejected) and by whom, for a quick-approve tap that comes too late
create or replace function public.line_slip_done(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('result', 'slip_done', 'order_no', o.order_no, 'status', e.status,
           'by', coalesce(public.line_person(case e.status when 'verified' then coalesce(e.posted_by, e.reviewed_by) when 'confirmed' then e.confirmed_by else e.reviewed_by end), 'ระบบ'),
           'at', case e.status when 'verified' then coalesce(e.posted_at, e.reviewed_at) when 'confirmed' then e.confirmed_at else e.reviewed_at end)
    from public.shop_orders o join public.finance_payment_evidence e on e.invoice_id = o.invoice_id
   where o.id = p_order and e.status in ('confirmed', 'verified', 'rejected')
     and not exists (select 1 from public.finance_payment_evidence s where s.invoice_id = o.invoice_id and s.status = 'submitted')
   order by coalesce(e.posted_at, e.confirmed_at, e.reviewed_at, e.created_at) desc limit 1
$$;

-- C2 the order-level guards of quick approve (the tapper's role is checked in line_act). why: QUICK_OFF | NOT_NEW | NO_SLIP | MANY_SLIPS | NOT_TRANSFER |
-- NO_TRANSFER_TIME | OVER_CAP | AMOUNT_MISMATCH | OUT_OF_WINDOW | DUPLICATE_SUSPECT | AI_MISMATCH
create or replace function public.line_quick_check(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.line_settings; fs public.finance_settings; o public.shop_orders; e public.finance_payment_evidence; i public.finance_invoices; n int; v_out numeric; v_bank text;
        a record;
begin
  select * into s from public.line_settings where id;
  select * into o from public.shop_orders where id = p_order;
  if not coalesce(s.quick_approve_enabled, false) then return jsonb_build_object('ok', false, 'why', 'QUICK_OFF'); end if;
  if o.id is null or o.status <> 'new' then return jsonb_build_object('ok', false, 'why', 'NOT_NEW'); end if;
  select count(*) into n from public.finance_payment_evidence where invoice_id = o.invoice_id and status = 'submitted';
  if n = 0 then return jsonb_build_object('ok', false, 'why', 'NO_SLIP'); end if;
  if n > 1 then return jsonb_build_object('ok', false, 'why', 'MANY_SLIPS'); end if;
  select * into e from public.finance_payment_evidence where invoice_id = o.invoice_id and status = 'submitted';
  if e.method <> 'transfer' or e.source <> 'customer_slip' then return jsonb_build_object('ok', false, 'why', 'NOT_TRANSFER'); end if;
  if e.claimed_transfer_at is null then return jsonb_build_object('ok', false, 'why', 'NO_TRANSFER_TIME'); end if;
  if e.claimed_amount > s.quick_approve_max_amount then return jsonb_build_object('ok', false, 'why', 'OVER_CAP'); end if;
  v_out := (public.finance_invoice_state_raw(o.invoice_id) ->> 'outstanding')::numeric;
  if e.claimed_amount <> v_out then return jsonb_build_object('ok', false, 'why', 'AMOUNT_MISMATCH'); end if;
  select * into fs from public.finance_settings where id;
  select * into i from public.finance_invoices where id = o.invoice_id;
  if e.claimed_transfer_at < o.created_at - make_interval(mins => coalesce(fs.slip_window_before_min, 120))
     or e.claimed_transfer_at > e.created_at + make_interval(mins => coalesce(fs.slip_future_tolerance_min, 10))
     or e.claimed_transfer_at < i.issue_date::timestamptz - interval '1 day' then
    return jsonb_build_object('ok', false, 'why', 'OUT_OF_WINDOW'); end if;
  if public.finance_quick_dup(e.claimed_amount, e.bank_account_id, e.claimed_transfer_at, e.id) is not null then return jsonb_build_object('ok', false, 'why', 'DUPLICATE_SUSPECT'); end if;
  select x.status, x.result into a from public.finance_slip_analysis x where x.evidence_id = e.id order by x.attempt desc limit 1;
  if found and not (a.status = 'done' and a.result = 'match') then return jsonb_build_object('ok', false, 'why', 'AI_MISMATCH'); end if;
  select code into v_bank from public.finance_bank_accounts where id = e.bank_account_id;
  return jsonb_build_object('ok', true, 'why', null, 'evidence_id', e.id, 'amount', e.claimed_amount, 'bank', coalesce(v_bank, e.claimed_bank), 'transfer_at', e.claimed_transfer_at);
end $$;

-- C3 what a card shows, read at SEND time (so a card that goes out late shows the current status)
create or replace function public.line_card_data(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; e public.finance_payment_evidence; s public.line_settings; n int; q jsonb; v_bank text; v_method text;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  select * into s from public.line_settings where id;
  select * into e from public.finance_payment_evidence where invoice_id = o.invoice_id and source = 'customer_slip' and status <> 'rejected'
    order by created_at desc, id desc limit 1;
  select count(*) into n from public.shop_order_items where order_id = o.id;
  v_method := case when o.payment_pref = 'wallet' then 'wallet' when o.payment_pref = 'qr' then 'qr' when o.payment_pref like 'bank:%' or e.id is not null then 'transfer' else 'unpaid' end;
  v_bank := coalesce((select b.code from public.finance_bank_accounts b where b.id = e.bank_account_id), case when o.payment_pref like 'bank:%' then substr(o.payment_pref, 6) end);
  q := public.line_quick_check(o.id);
  return jsonb_build_object(
    'order_id', o.id, 'order_no', o.order_no, 'customer_name', o.contact_name, 'phone', o.contact_phone, 'created_at', o.created_at,
    'item_count', (select coalesce(sum(qty), 0) from public.shop_order_items where order_id = o.id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', it.name, 'qty', it.qty, 'price', it.unit_price,
               'image', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = it.sku_code)) order by it.line_no)
             from (select * from public.shop_order_items where order_id = o.id order by line_no limit 3) it), '[]'::jsonb),
    'more_count', greatest(n - 3, 0),
    'total', o.total, 'fulfilment', o.fulfilment,
    'payment', jsonb_build_object('method', v_method, 'bank', v_bank, 'has_slip', e.id is not null, 'transfer_at', e.claimed_transfer_at, 'evidence_id', e.id),
    'status', o.status, 'quick', jsonb_build_object('ok', (q ->> 'ok')::boolean, 'why', q ->> 'why'), 'app_url', s.app_url);
end $$;

-- C4 one tap from LINE, acting AS the linked staff member: the existing functions do the work and their own role checks; their audit rows name that person.
-- result: not_linked | not_allowed {why} | already_done {status, by, at} | refused {code, message} | ask_quick {...} | ask_reason {reasons} | done {action, ...}
create or replace function public.line_act(p_line_user text, p_action text, p_order uuid, p_card uuid, p_reason integer default null, p_event_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles; o public.shop_orders; s public.line_settings; q jsonb; v_name text; v_reason text; v_last jsonb; ev uuid; m text; st text;
begin
  if p_action not in ('accept', 'quick_ask', 'quick_confirm', 'reject_ask', 'reject') then return jsonb_build_object('result', 'refused', 'code', 'UNKNOWN_ACTION'); end if;
  if p_card is null or not exists (select 1 from public.line_outbox where id = p_card and order_id = p_order) then
    return jsonb_build_object('result', 'refused', 'code', 'UNKNOWN_CARD'); end if;
  select pr.* into p from public.line_staff_links l join public.profiles pr on pr.id = l.profile_id where l.line_user_id = p_line_user;
  if not found then return jsonb_build_object('result', 'not_linked'); end if;
  if p.status <> 'active' or p.role not in ('ADMIN', 'SUPER_ADMIN') then return jsonb_build_object('result', 'not_allowed', 'why', 'not_staff'); end if;
  -- from here on auth.uid() is this staff member (both settings: auth.uid() reads claim.sub first), for this transaction only
  perform set_config('request.jwt.claim.sub', p.id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p.id, 'role', 'authenticated', 'email', p.email)::text, true);
  perform set_config('line.via_line', 'on', true);
  v_name := public.line_person(p.id);
  select * into s from public.line_settings where id;
  select * into o from public.shop_orders where id = p_order for update;              -- two taps at the same moment: the second waits here, then sees the new status
  if not found then return jsonb_build_object('result', 'refused', 'code', 'NOT_FOUND'); end if;
  if o.status <> 'new' then
    v_last := public.line_last_action(o.id);
    return jsonb_build_object('result', 'already_done', 'order_no', o.order_no, 'status', o.status, 'by', v_last ->> 'by', 'at', v_last ->> 'at');
  end if;
  if p_action = 'reject_ask' then
    return jsonb_build_object('result', 'ask_reason', 'order_no', o.order_no, 'reasons', to_jsonb(s.reject_reasons)); end if;
  begin
    if p_action = 'accept' then
      perform public.shop_admin_set_status(o.id, 'confirmed');
      perform public.shop_log('order', o.id::text, 'order.line', jsonb_build_object('via', 'line', 'action', 'accept'));
      return jsonb_build_object('result', 'done', 'action', 'accept', 'order_no', o.order_no, 'by', v_name, 'at', now());
    elsif p_action in ('quick_ask', 'quick_confirm') then
      if not public.finance_can('verify') then return jsonb_build_object('result', 'not_allowed', 'why', 'not_verifier'); end if;
      q := public.line_slip_done(o.id);                                                  -- the payment was already handled on the web: say by whom
      if q is not null then return q; end if;
      q := public.line_quick_check(o.id);
      if not (q ->> 'ok')::boolean then return jsonb_build_object('result', 'refused', 'code', q ->> 'why'); end if;
      if p_action = 'quick_ask' then
        return jsonb_build_object('result', 'ask_quick', 'order_no', o.order_no, 'amount', q -> 'amount', 'bank', q ->> 'bank', 'transfer_at', q ->> 'transfer_at'); end if;
      perform public.finance_quick_confirm_evidence((q ->> 'evidence_id')::uuid);
      perform public.shop_admin_set_status(o.id, 'confirmed');
      perform public.shop_log('order', o.id::text, 'order.line', jsonb_build_object('via', 'line', 'action', 'quick_confirm', 'evidence', q ->> 'evidence_id', 'amount', q -> 'amount'));
      return jsonb_build_object('result', 'done', 'action', 'quick_confirm', 'order_no', o.order_no, 'by', v_name, 'at', now(), 'amount', q -> 'amount');
    else -- reject
      if p_reason is null or p_reason < 0 or p_reason >= coalesce(array_length(s.reject_reasons, 1), 0) then
        return jsonb_build_object('result', 'refused', 'code', 'BAD_REASON'); end if;
      v_reason := s.reject_reasons[p_reason + 1];
      if exists (select 1 from public.finance_payment_evidence where invoice_id = o.invoice_id and status in ('submitted', 'confirmed', 'more_evidence'))
         and not public.finance_can('verify') then
        return jsonb_build_object('result', 'not_allowed', 'why', 'not_verifier'); end if;
      for ev in select id from public.finance_payment_evidence where invoice_id = o.invoice_id and status in ('submitted', 'confirmed', 'more_evidence') order by created_at loop
        perform public.finance_reject_evidence(ev, v_reason);
      end loop;
      perform public.shop_admin_set_status(o.id, 'cancelled', v_reason);
      perform public.shop_log('order', o.id::text, 'order.line', jsonb_build_object('via', 'line', 'action', 'reject', 'reason', v_reason));
      return jsonb_build_object('result', 'done', 'action', 'reject', 'order_no', o.order_no, 'by', v_name, 'at', now(), 'reason', v_reason);
    end if;
  exception when others then                                                          -- everything this block did is undone (a sub-transaction)
    get stacked diagnostics m = message_text, st = returned_sqlstate;
    if m like 'This slip is already %' then                                              -- confirmed on the web between the check and the tap
      q := public.line_slip_done(o.id);
      if q is not null then return q; end if;
    end if;
    return jsonb_build_object('result', case when st = '42501' then 'not_allowed' else 'refused' end,
      'code', case when m like 'PAYMENT_RECORDED%' then 'PAYMENT_RECORDED' when m like 'DUPLICATE_SUSPECT%' then 'DUPLICATE_SUSPECT' when m like 'PAYMENT_REQUIRED%' then 'PAYMENT_REQUIRED'
                   when st = '42501' then 'NOT_ALLOWED' else 'ERROR' end,
      'why', case when st = '42501' then 'not_staff' end, 'message', left(m, 300));
  end;
end $$;

-- C5 the queue: enqueue (a no-op while LINE is off, no group is bound, or the event is switched off)
create or replace function public.line_enqueue(p_event text, p_order uuid, p_evidence uuid, p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s public.line_settings; v_target text; v_type text := 'group';
begin
  select * into s from public.line_settings where id;
  if s.id is null or not s.enabled or s.group_id is null then return; end if;
  if not coalesce((s.events ->> p_event)::boolean, false) then return; end if;
  if p_event = 'customer_notify' then
    select pr.line_user_id into v_target from public.shop_orders o join public.profiles pr on pr.id = o.profile_id where o.id = p_order;
    if v_target is null then return; end if;
    v_type := 'user';
  else
    v_target := s.group_id;
  end if;
  insert into public.line_outbox (event, order_id, evidence_id, target_type, target_id, payload) values (p_event, p_order, p_evidence, v_type, v_target, coalesce(p_payload, '{}'::jsonb))
    on conflict do nothing;
end $$;

-- Every LINE trigger is guarded: whatever goes wrong in LINE (a broken setting, Vault, pg_net) is a warning in the log, never a failed order, slip or status change.
create or replace function public.line_trg_order_new()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin perform public.line_enqueue('order_new', new.id, null);
  exception when others then raise warning 'LINE notification skipped (order %): %', new.order_no, sqlerrm; end;
  return null;
end $$;
drop trigger if exists line_order_new on public.shop_orders;
create trigger line_order_new after insert on public.shop_orders for each row execute function public.line_trg_order_new();

create or replace function public.line_trg_order_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_payload jsonb;
begin
  begin
    v_payload := jsonb_build_object('order_no', new.order_no, 'status', new.status, 'by', coalesce(public.line_person(auth.uid()), 'ระบบ'), 'at', now(),
      'reason', case when new.status = 'cancelled' then new.cancel_reason end);
    if current_setting('line.via_line', true) is distinct from 'on' then perform public.line_enqueue('order_status', new.id, null, v_payload); end if;
    perform public.line_enqueue('customer_notify', new.id, null, v_payload);
  exception when others then raise warning 'LINE notification skipped (order %): %', new.order_no, sqlerrm; end;
  return null;
end $$;
drop trigger if exists line_order_status on public.shop_orders;
create trigger line_order_status after update of status on public.shop_orders for each row
  when (old.status is distinct from new.status and new.status in ('confirmed', 'cancelled')) execute function public.line_trg_order_status();

create or replace function public.line_trg_evidence()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.shop_orders;
begin
  begin
    select * into o from public.shop_orders where invoice_id = new.invoice_id;
    if not found then return null; end if;
    if tg_op = 'INSERT' then
      if new.source = 'customer_slip' and o.created_at <> now() then perform public.line_enqueue('slip_new', o.id, new.id); end if;   -- same transaction as the order: the card covers it
    elsif new.status in ('rejected', 'more_evidence') and current_setting('line.via_line', true) is distinct from 'on'
          and new.reject_reason is distinct from 'Replaced by a newer slip' then                                   -- a replaced slip is not a problem: the new slip is announced
      perform public.line_enqueue('payment_issue', o.id, new.id, jsonb_build_object('order_no', o.order_no, 'kind', new.status,
        'reason', case when new.status = 'rejected' then new.reject_reason else new.request_message end));
    end if;
  exception when others then raise warning 'LINE notification skipped (slip %): %', new.id, sqlerrm; end;
  return null;
end $$;
drop trigger if exists line_evidence_new on public.finance_payment_evidence;
create trigger line_evidence_new after insert on public.finance_payment_evidence for each row execute function public.line_trg_evidence();
drop trigger if exists line_evidence_issue on public.finance_payment_evidence;
create trigger line_evidence_issue after update of status on public.finance_payment_evidence for each row
  when (old.status is distinct from new.status and new.status in ('rejected', 'more_evidence')) execute function public.line_trg_evidence();

create or replace function public.line_trg_analysis()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.shop_orders;
begin
  begin
    select so.* into o from public.finance_payment_evidence e join public.shop_orders so on so.invoice_id = e.invoice_id where e.id = new.evidence_id;
    if found then
      perform public.line_enqueue('payment_issue', o.id, new.evidence_id, jsonb_build_object('order_no', o.order_no, 'kind', 'ai', 'reason', new.result));
    end if;
  exception when others then raise warning 'LINE notification skipped (analysis %): %', new.id, sqlerrm; end;
  return null;
end $$;
drop trigger if exists line_analysis_issue on public.finance_slip_analysis;
create trigger line_analysis_issue after update of status on public.finance_slip_analysis for each row
  when (new.status = 'done' and old.status is distinct from 'done' and new.result is distinct from 'match') execute function public.line_trg_analysis();

-- C6 the dispatcher's side: claim due rows (with the card read now), record the outcome, kick the dispatcher
create or replace function public.line_claim_outbox(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not coalesce((select enabled from public.line_settings where id), false) then return '[]'::jsonb; end if;
  with c as (
    select id from public.line_outbox
     where (status in ('queued', 'failed') and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '5 minutes')
     order by created_at limit least(greatest(coalesce(p_limit, 20), 1), 50) for update skip locked
  ), u as (
    update public.line_outbox o set status = 'sending', updated_at = now() from c where o.id = c.id returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'event', u.event, 'target_type', u.target_type, 'target_id', u.target_id, 'attempts', u.attempts,
           'card', case when u.order_id is not null then public.line_card_data(u.order_id) end, 'payload', u.payload) order by u.created_at), '[]'::jsonb) into v from u;
  return v;
end $$;

create or replace function public.line_complete_outbox(p_id uuid, p_ok boolean, p_retryable boolean, p_error text, p_request_id text)
returns void language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_ok then
    update public.line_outbox set status = 'sent', sent_at = now(), last_error = null, line_request_id = left(p_request_id, 100), updated_at = now() where id = p_id;
    return;
  end if;
  update public.line_outbox set attempts = attempts + 1, last_error = left(p_error, 500), updated_at = now() where id = p_id returning attempts into n;
  if not found then return; end if;
  if not coalesce(p_retryable, false) or n >= 6 then
    update public.line_outbox set status = 'dead' where id = p_id;
  else
    update public.line_outbox set status = 'failed', next_attempt_at = now() + make_interval(mins => (array[1, 2, 5, 15, 60])[n]) where id = p_id;
  end if;
end $$;

create or replace function public.line_kick()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.line_outbox where (status in ('queued', 'failed') and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '5 minutes')) then
    return; end if;
  perform net.http_post(url := 'https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-dispatch', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-line-dispatch-secret', public.line_vault_get('line_dispatch_secret')), timeout_milliseconds := 10000);
end $$;
create or replace function public.line_trg_outbox_kick()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin perform public.line_kick();
  exception when others then raise warning 'LINE dispatcher not kicked: %', sqlerrm; end;        -- the minute job sends it anyway
  return null;
end $$;
drop trigger if exists line_outbox_kick on public.line_outbox;
create trigger line_outbox_kick after insert on public.line_outbox for each statement execute function public.line_trg_outbox_kick();
do $$ begin
  if exists (select 1 from cron.job where jobname = 'line-dispatch') then perform cron.unschedule('line-dispatch'); end if;
  perform cron.schedule('line-dispatch', '* * * * *', 'select public.line_kick()');
end $$;

-- C7 staff: the delivery log and "send again"
create or replace function public.line_admin_outbox(p_filter text default 'all', p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_staff('see the LINE delivery log');
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'order_id', x.order_id, 'order_no', o.order_no, 'target_type', x.target_type, 'status', x.status,
      'attempts', x.attempts, 'last_error', x.last_error, 'created_at', x.created_at, 'sent_at', x.sent_at, 'next_attempt_at', x.next_attempt_at) order by x.created_at desc)
    from (select * from public.line_outbox where coalesce(p_filter, 'all') = 'all' or (p_filter = 'failed' and status in ('failed', 'dead'))
          order by created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x
    left join public.shop_orders o on o.id = x.order_id), '[]'::jsonb);
end $$;

create or replace function public.line_admin_resend(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.shop_require_staff('send a LINE message again');
  update public.line_outbox set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, updated_at = now()
   where id = p_id and status in ('failed', 'dead', 'skipped');
  if not found then raise exception 'This message is not waiting to be sent again'; end if;
  perform public.shop_log('line', p_id::text, 'line.resend', '{}'::jsonb);
  perform public.line_kick();
end $$;

-- C8 grants
revoke execute on function public.line_person(uuid), public.line_last_action(uuid), public.line_slip_done(uuid), public.line_quick_check(uuid), public.line_card_data(uuid),
  public.line_act(text, text, uuid, uuid, integer, text), public.line_enqueue(text, uuid, uuid, jsonb), public.line_claim_outbox(integer),
  public.line_complete_outbox(uuid, boolean, boolean, text, text), public.line_kick(), public.line_trg_order_new(), public.line_trg_order_status(),
  public.line_trg_evidence(), public.line_trg_analysis(), public.line_trg_outbox_kick() from public, anon, authenticated;
grant execute on function public.line_act(text, text, uuid, uuid, integer, text), public.line_claim_outbox(integer),
  public.line_complete_outbox(uuid, boolean, boolean, text, text) to service_role;
revoke execute on function public.line_admin_outbox(text, integer), public.line_admin_resend(uuid) from public, anon;
grant execute on function public.line_admin_outbox(text, integer), public.line_admin_resend(uuid) to authenticated;
