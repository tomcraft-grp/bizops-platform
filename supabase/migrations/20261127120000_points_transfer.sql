-- Customer-to-customer loyalty points transfer (request, reserve, recipient accepts). Design: docs/superpowers/specs/2026-11-27-points-transfer-design.md.
--
-- What exists (checked on the live project, 2026-11-27): the server-side rewards (migration 20261121100000, ON): rw_points_ledger is append-only and a customer's balance is SUM(points) per profile;
-- rw_settle_profile rewrites every source that is not exactly 'adjust' to what the paid bills say (it would REVERSE any other source), so transfer rows are ordinary 'adjust' rows
-- (kind 'adjust', source_key 'adjust') and settle never touches them; the Super Admin adjustment takes the same per-profile advisory lock and refuses a balance below zero.
-- Nothing here changes an earning rule, the settle function, a bill or a payment.
--
-- Design
--   * RESERVATION (option A) is table state, not a ledger row: a pending transfer reserves its points. available = balance - sum(pending, not expired). The ledger is touched only when the recipient accepts
--     (two rows: sender -n, recipient +n), so a request that is never accepted leaves no trace in the balance. Rejected, cancelled and expired transfers release the points by leaving 'pending'.
--   * One atomic function per decision. Accept: FOR UPDATE on the transfer, then the advisory locks of BOTH profiles in a fixed order (the same lock settle and the Super Admin adjustment take), re-checks the
--     status, the expiry and the sender's balance, writes both ledger rows and the new status in one transaction: any error rolls back all of it. A second accept is a replay (nothing moves twice).
--   * Idempotent requests: (sender, key) is unique; the same key with another recipient or amount is refused (KEY_REUSED).
--   * The recipient is found by a NEW member code (rw_members), not by an e-mail or phone: 8 characters from an alphabet without I, O, 0, 1 (32^8). Lookups that miss are rate limited (20 per hour per customer,
--     counted in rw_events_log). The preview shows a shortened name and a masked code, never a phone, e-mail or full name.
--   * Notices (rw_transfer_notices) are written in their own exception-safe block AFTER the points moved: a notice that fails or repeats can never change a point. Unique per (transfer, customer, kind).
--   * Expiry is lazy (no job): a pending transfer past its time is marked expired the next time either customer looks or acts; it stops reserving at the moment it expires.
--   * Ships DARK: rw_transfer_settings.transfers_enabled defaults to false; a Super Admin switches it on (and sets the limits). With it off no function here moves points; reject and cancel still work.
--   * Every table has RLS and no grant: clients reach them only through the SECURITY DEFINER functions below, which check the caller again.
--   * rw_admin_adjust_points is replaced by a copy of the live function that also refuses to take away points that a pending transfer reserves (POINTS_RESERVED). The migration refuses to run if the live text of
--     that function is not the one this copy was made from.
-- Rollback: supabase/rollbacks/20261127120000_points_transfer_down.sql (refuses once a transfer exists).

-- 0 ------------------------------------------------------------------------------------------------------------------------------------------------------
do $$ begin
  if md5(pg_get_functiondef('public.rw_admin_adjust_points(uuid, integer, text)'::regprocedure)) <> 'ec2400ca889a5351aa57a08332b0b099' then
    raise exception 'rw_admin_adjust_points changed since this migration was written: copy the live definition again and re-add the reserved-points check'; end if;
end $$;

-- 1 settings ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.rw_transfer_settings (
  id boolean primary key default true check (id),
  transfers_enabled boolean not null default false,
  min_points integer not null default 1 check (min_points >= 1),
  max_points integer not null default 1000 check (max_points >= min_points),
  daily_max_points integer not null default 5000 check (daily_max_points >= max_points),
  max_pending integer not null default 10 check (max_pending between 1 and 100),
  expire_days integer not null default 7 check (expire_days between 1 and 90),
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.rw_transfer_settings (id) values (true);

-- 2 member codes -----------------------------------------------------------------------------------------------------------------------------------------
create table public.rw_members (
  profile_id uuid primary key references public.profiles (id) on delete restrict,
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_at timestamptz not null default now()
);

-- 3 transfers --------------------------------------------------------------------------------------------------------------------------------------------
create sequence public.rw_transfer_seq;
create table public.rw_point_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_no text not null unique,
  sender_id uuid not null references public.profiles (id) on delete restrict,
  recipient_id uuid not null references public.profiles (id) on delete restrict,
  points integer not null check (points > 0),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  message text check (message is null or length(message) <= 140),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz, decided_by uuid, decision_reason text,
  out_ledger_id bigint references public.rw_points_ledger (id) on delete restrict,
  in_ledger_id bigint references public.rw_points_ledger (id) on delete restrict,
  sender_balance_before integer, recipient_balance_before integer,
  check (sender_id <> recipient_id),
  check ((status = 'accepted') = (out_ledger_id is not null and in_ledger_id is not null)),
  unique (sender_id, idempotency_key)
);
create index rw_point_transfers_recipient_idx on public.rw_point_transfers (recipient_id, status, created_at desc);
create index rw_point_transfers_sender_idx on public.rw_point_transfers (sender_id, status, created_at desc);
create index rw_point_transfers_pending_idx on public.rw_point_transfers (sender_id) where status = 'pending';

create or replace function public.rw_transfers_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'A points transfer is never deleted'; end if;
  if new.id is distinct from old.id or new.transfer_no is distinct from old.transfer_no or new.sender_id is distinct from old.sender_id or new.recipient_id is distinct from old.recipient_id
     or new.points is distinct from old.points or new.idempotency_key is distinct from old.idempotency_key or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
    raise exception 'The parties, the amount and the times of a points transfer cannot be changed'; end if;
  if old.status <> 'pending' then raise exception 'This transfer is already %', old.status; end if;
  return new;
end $$;
create trigger rw_transfers_guard before update or delete on public.rw_point_transfers for each row execute function public.rw_transfers_guard();
create or replace function public.rw_transfers_no_truncate() returns trigger language plpgsql as $$ begin raise exception 'Points transfers are never truncated'; end $$;
create trigger rw_transfers_no_truncate before truncate on public.rw_point_transfers for each statement execute function public.rw_transfers_no_truncate();

-- 4 notices ----------------------------------------------------------------------------------------------------------------------------------------------
create table public.rw_transfer_notices (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  transfer_id uuid not null references public.rw_point_transfers (id) on delete restrict,
  kind text not null check (kind in ('incoming', 'accepted', 'rejected', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (transfer_id, profile_id, kind)
);
create index rw_transfer_notices_profile_idx on public.rw_transfer_notices (profile_id, created_at desc);

alter table public.rw_transfer_settings enable row level security;
alter table public.rw_members enable row level security;
alter table public.rw_point_transfers enable row level security;
alter table public.rw_transfer_notices enable row level security;
revoke all on public.rw_transfer_settings, public.rw_members, public.rw_point_transfers, public.rw_transfer_notices from public, anon, authenticated;
revoke all on sequence public.rw_transfer_seq from public, anon, authenticated;

-- 5 helpers (internal: no client can call them) ------------------------------------------------------------------------------------------------------------
create or replace function public.rw_transfers_on() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from public.rw_settings where id), false) and coalesce((select transfers_enabled from public.rw_transfer_settings where id), false) $$;

create or replace function public.rw_points_balance(p_profile uuid) returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(points), 0)::integer from public.rw_points_ledger where profile_id = p_profile $$;

-- points held by pending transfers that have not expired
create or replace function public.rw_points_reserved(p_profile uuid) returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(points), 0)::integer from public.rw_point_transfers where sender_id = p_profile and status = 'pending' and expires_at > now() $$;

-- THE number to spend from: any redemption or transfer must use this, not the bare balance
create or replace function public.rw_points_available(p_profile uuid) returns integer language sql stable security definer set search_path = public as $$
  select public.rw_points_balance(p_profile) - public.rw_points_reserved(p_profile) $$;

create or replace function public.rw_norm_member_code(p text) returns text language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;
create or replace function public.rw_fmt_member_code(p text) returns text language sql immutable set search_path = public as $$
  select case when length(p) = 8 then substr(p, 1, 4) || '-' || substr(p, 5) else p end $$;
create or replace function public.rw_mask_member_code(p text) returns text language sql immutable set search_path = public as $$
  select case when length(p) = 8 then substr(p, 1, 2) || '••••' || substr(p, 7) else '••••' end $$;

-- "Somchai J.": the first word of the name and the first letter of the next one, never an e-mail or a phone
create or replace function public.rw_short_name(p_id uuid) returns text language plpgsql stable security definer set search_path = public as $$
declare n text; w text[];
begin
  select btrim(display_name) into n from public.profiles where id = p_id;
  if n is null or n = '' then return 'Member'; end if;
  w := regexp_split_to_array(n, '\s+');
  return case when array_length(w, 1) > 1 then w[1] || ' ' || left(w[2], 1) || '.' else w[1] end;
end $$;

create or replace function public.rw_new_member_code() returns text language plpgsql volatile as $$
declare alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex'); r text := ''; i integer;
begin
  for i in 0 .. 7 loop r := r || substr(alphabet, (get_byte(b, i) % 32) + 1, 1); end loop;
  return r;
end $$;

-- the caller's own code, made the first time it is asked for (a collision is retried)
create or replace function public.rw_member_code_of(p_profile uuid) returns text language plpgsql security definer set search_path = public as $$
declare c text; n integer := 0;
begin
  select code into c from public.rw_members where profile_id = p_profile;
  if c is not null then return c; end if;
  loop
    n := n + 1;
    begin
      insert into public.rw_members (profile_id, code) values (p_profile, public.rw_new_member_code()) on conflict (profile_id) do nothing;
      select code into c from public.rw_members where profile_id = p_profile;
      if c is not null then return c; end if;
    exception when unique_violation then
      if n >= 20 then raise exception 'Could not make a member ID, try again'; end if;
    end;
    if n >= 20 then raise exception 'Could not make a member ID, try again'; end if;
  end loop;
end $$;

-- a notice is a convenience: any failure here is swallowed, and a repeat is ignored by the unique key
create or replace function public.rw_transfer_note(p_transfer uuid, p_profile uuid, p_kind text) returns void language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.rw_transfer_notices (profile_id, transfer_id, kind) values (p_profile, p_transfer, p_kind) on conflict (transfer_id, profile_id, kind) do nothing;
  exception when others then
    begin perform public.rw_log('transfer.notice_error', 'transfer', p_transfer::text, p_profile, null, jsonb_build_object('kind', p_kind, 'sqlstate', sqlstate)); exception when others then null; end;
  end;
end $$;

create or replace function public.rw_transfer_json(t public.rw_point_transfers, p_viewer uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_other uuid := case when t.sender_id = p_viewer then t.recipient_id else t.sender_id end; v_code text;
begin
  select code into v_code from public.rw_members where profile_id = v_other;
  return jsonb_build_object('id', t.id, 'transfer_no', t.transfer_no, 'direction', case when t.sender_id = p_viewer then 'out' else 'in' end, 'status',
    case when t.status = 'pending' and t.expires_at <= now() then 'expired' else t.status end, 'points', t.points, 'message', t.message,
    'created_at', t.created_at, 'expires_at', t.expires_at, 'decided_at', t.decided_at, 'reason', t.decision_reason,
    'counterparty', jsonb_build_object('name', public.rw_short_name(v_other), 'code', public.rw_mask_member_code(v_code)));
end $$;

-- pending transfers of this customer (as sender or recipient) that ran out of time: expired, the points stop being reserved, both are told
create or replace function public.rw_transfer_expire(p_profile uuid) returns integer language plpgsql security definer set search_path = public as $$
declare t public.rw_point_transfers; n integer := 0;
begin
  for t in select * from public.rw_point_transfers where status = 'pending' and expires_at <= now() and (sender_id = p_profile or recipient_id = p_profile) for update skip locked loop
    update public.rw_point_transfers set status = 'expired', decided_at = now(), decision_reason = 'EXPIRED' where id = t.id and status = 'pending';
    perform public.rw_transfer_note(t.id, t.sender_id, 'expired'); perform public.rw_transfer_note(t.id, t.recipient_id, 'expired');
    perform public.rw_log('transfer.expire', 'transfer', t.id::text, t.sender_id, null, jsonb_build_object('transfer_no', t.transfer_no, 'points', t.points));
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.rw_transfers_on(), public.rw_points_balance(uuid), public.rw_points_reserved(uuid), public.rw_points_available(uuid), public.rw_norm_member_code(text), public.rw_fmt_member_code(text),
  public.rw_mask_member_code(text), public.rw_short_name(uuid), public.rw_new_member_code(), public.rw_member_code_of(uuid), public.rw_transfer_note(uuid, uuid, text),
  public.rw_transfer_json(public.rw_point_transfers, uuid), public.rw_transfer_expire(uuid) from public, anon, authenticated;

-- 6 the staff points adjustment never takes away points a pending transfer holds (copy of the live function + the marked lines) -----------------------------------------
create or replace function public.rw_admin_adjust_points(p_profile uuid, p_points integer, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_reason text := btrim(coalesce(p_reason, '')); bal integer; v_res integer;
begin
  perform public.rw_require_super('adjust points');
  if length(v_reason) < 3 then raise exception 'REASON_REQUIRED'; end if;
  if not coalesce((select enabled from public.rw_settings where id), false) then raise exception 'REWARDS_OFF'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 100000 then raise exception 'LIMIT_REACHED: an adjustment is between 1 and 100000 points'; end if;
  if not exists (select 1 from public.profiles where id = p_profile) then raise exception 'NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rw:' || p_profile::text, 0));
  select coalesce(sum(points), 0)::integer into bal from public.rw_points_ledger where profile_id = p_profile;
  if bal + p_points < 0 then raise exception 'LIMIT_REACHED: the balance (%) cannot go below zero', bal; end if;
  v_res := public.rw_points_reserved(p_profile);                                                                   -- TRANSFER: points held by a pending transfer cannot be taken away
  if p_points < 0 and bal - v_res + p_points < 0 then raise exception 'POINTS_RESERVED: % points are held by pending transfers (balance %)', v_res, bal; end if;
  insert into public.rw_points_ledger (profile_id, points, kind, source_key, note, created_by) values (p_profile, p_points, 'adjust', 'adjust', left(v_reason, 300), auth.uid());
  perform public.rw_log('points.adjust', 'profile', p_profile::text, p_profile, v_reason, jsonb_build_object('points', p_points, 'balance_before', bal));
  return bal + p_points;
end $function$;

-- 7 customer functions ---------------------------------------------------------------------------------------------------------------------------------------
-- too many misses in an hour: somebody is guessing codes
create or replace function public.rw_transfer_lookup_guard(p_profile uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.rw_events_log where action = 'transfer.lookup' and profile_id = p_profile and at > now() - interval '1 hour' and detail ->> 'found' = 'false') >= 20 then
    raise exception 'TOO_MANY_LOOKUPS: too many unknown member IDs in the last hour. Try again later'; end if;
end $$;
revoke all on function public.rw_transfer_lookup_guard(uuid) from public, anon, authenticated;

create or replace function public.rw_transfer_lookup(p_code text) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; v_code text; v_p uuid;
begin
  uid := public.shop_require_user();
  if not public.rw_transfers_on() then raise exception 'TRANSFERS_OFF: points transfers are not available'; end if;
  perform public.rw_transfer_lookup_guard(uid);
  v_code := public.rw_norm_member_code(p_code);
  select m.profile_id into v_p from public.rw_members m join public.profiles p on p.id = m.profile_id and p.status = 'active' where m.code = v_code;
  perform public.rw_log('transfer.lookup', 'member', null, uid, null, jsonb_build_object('found', v_p is not null));
  if v_p is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'is_self', v_p = uid, 'name', public.rw_short_name(v_p), 'code', public.rw_mask_member_code(v_code));
end $$;

create or replace function public.rw_transfer_create(p_code text, p_points integer, p_key text, p_message text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; s public.rw_transfer_settings; v_code text; v_rcpt uuid; v_old public.rw_point_transfers; t public.rw_point_transfers; v_bal integer; v_res integer;
        v_msg text := nullif(btrim(coalesce(p_message, '')), ''); v_day integer;
begin
  uid := public.shop_require_user();
  if not public.rw_transfers_on() then raise exception 'TRANSFERS_OFF: points transfers are not available'; end if;
  select * into s from public.rw_transfer_settings where id;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  if p_points is null or p_points < s.min_points or p_points > s.max_points then raise exception 'POINTS_OUT_OF_RANGE: a transfer is between % and % points', s.min_points, s.max_points; end if;
  if v_msg is not null and length(v_msg) > 140 then raise exception 'MESSAGE_TOO_LONG: 140 characters at most'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rw:' || uid::text, 0));
  v_code := public.rw_norm_member_code(p_code);
  select * into v_old from public.rw_point_transfers where sender_id = uid and idempotency_key = p_key;
  if found then
    select profile_id into v_rcpt from public.rw_members where code = v_code;
    if v_old.recipient_id is distinct from v_rcpt or v_old.points <> p_points then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return public.rw_transfer_json(v_old, uid) || jsonb_build_object('replay', true);
  end if;
  perform public.rw_transfer_lookup_guard(uid);
  select m.profile_id into v_rcpt from public.rw_members m join public.profiles p on p.id = m.profile_id and p.status = 'active' where m.code = v_code;     -- a disabled account is simply not found (as in the lookup)
  perform public.rw_log('transfer.lookup', 'member', null, uid, null, jsonb_build_object('found', v_rcpt is not null, 'via', 'create'));
  if v_rcpt is null then raise exception 'RECIPIENT_NOT_FOUND: check the member ID'; end if;
  if v_rcpt = uid then raise exception 'SELF_TRANSFER: you cannot send points to yourself'; end if;
  perform public.rw_transfer_expire(uid);
  if (select count(*) from public.rw_point_transfers where sender_id = uid and status = 'pending') >= s.max_pending then raise exception 'TOO_MANY_PENDING: you already have % pending transfers', s.max_pending; end if;
  select coalesce(sum(points), 0)::integer into v_day from public.rw_point_transfers where sender_id = uid and status in ('pending', 'accepted') and created_at > now() - interval '24 hours';
  if v_day + p_points > s.daily_max_points then raise exception 'DAILY_LIMIT: at most % points can be sent per day', s.daily_max_points; end if;
  v_bal := public.rw_points_balance(uid); v_res := public.rw_points_reserved(uid);
  if p_points > v_bal - v_res then raise exception 'INSUFFICIENT_POINTS: % points are available (balance %, held by pending transfers %)', v_bal - v_res, v_bal, v_res using detail = (v_bal - v_res)::text; end if;
  insert into public.rw_point_transfers (transfer_no, sender_id, recipient_id, points, idempotency_key, message, expires_at)
    values ('PT-' || lpad(nextval('public.rw_transfer_seq')::text, 6, '0'), uid, v_rcpt, p_points, p_key, v_msg, now() + make_interval(days => s.expire_days)) returning * into t;
  perform public.rw_log('transfer.create', 'transfer', t.id::text, uid, null, jsonb_build_object('transfer_no', t.transfer_no, 'points', p_points, 'recipient', v_rcpt, 'available_before', v_bal - v_res));
  perform public.rw_transfer_note(t.id, v_rcpt, 'incoming');
  return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', false);
end $$;

-- the recipient accepts. Everything or nothing; a second accept changes nothing.
create or replace function public.rw_transfer_accept(p_transfer uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; t public.rw_point_transfers; v_a uuid; v_b uuid; v_sb integer; v_rb integer; v_out bigint; v_in bigint; v_scode text; v_rcode text;
begin
  uid := public.shop_require_user();
  if not public.rw_transfers_on() then raise exception 'TRANSFERS_OFF: points transfers are not available'; end if;
  select * into t from public.rw_point_transfers where id = p_transfer and recipient_id = uid for update;
  if not found then raise exception 'NOT_FOUND: transfer' using errcode = '42501'; end if;
  if t.status = 'accepted' then return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', true); end if;
  if t.status <> 'pending' then raise exception 'TRANSFER_NOT_PENDING: this transfer is %', t.status; end if;
  if t.expires_at <= now() then                                                    -- too late: recorded as expired (kept, not an error), the points are free again
    update public.rw_point_transfers set status = 'expired', decided_at = now(), decision_reason = 'EXPIRED' where id = t.id returning * into t;
    perform public.rw_transfer_note(t.id, t.sender_id, 'expired'); perform public.rw_transfer_note(t.id, t.recipient_id, 'expired');
    perform public.rw_log('transfer.expire', 'transfer', t.id::text, t.sender_id, null, jsonb_build_object('transfer_no', t.transfer_no, 'points', t.points));
    return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', false);
  end if;
  -- both customers' points locks, always in the same order (the settle function and the Super Admin adjustment take the same lock): no deadlock between two transfers
  v_a := least(t.sender_id, t.recipient_id); v_b := greatest(t.sender_id, t.recipient_id);
  perform pg_advisory_xact_lock(hashtextextended('rw:' || v_a::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('rw:' || v_b::text, 0));
  v_sb := public.rw_points_balance(t.sender_id); v_rb := public.rw_points_balance(t.recipient_id);
  if v_sb < t.points then                                                          -- the sender's points were removed behind the request: it cannot be honoured, and says so
    update public.rw_point_transfers set status = 'cancelled', decided_at = now(), decided_by = uid, decision_reason = 'SENDER_BALANCE_CHANGED' where id = t.id returning * into t;
    perform public.rw_transfer_note(t.id, t.sender_id, 'cancelled'); perform public.rw_transfer_note(t.id, t.recipient_id, 'cancelled');
    perform public.rw_log('transfer.cancel', 'transfer', t.id::text, t.sender_id, 'SENDER_BALANCE_CHANGED', jsonb_build_object('transfer_no', t.transfer_no, 'balance', v_sb, 'points', t.points));
    return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', false);
  end if;
  v_scode := public.rw_fmt_member_code((select code from public.rw_members where profile_id = t.sender_id));
  v_rcode := public.rw_fmt_member_code((select code from public.rw_members where profile_id = t.recipient_id));
  insert into public.rw_points_ledger (profile_id, points, kind, source_key, note, created_by) values (t.sender_id, -t.points, 'adjust', 'adjust', 'Transfer ' || t.transfer_no || ' to ' || coalesce(v_rcode, 'member'), uid) returning id into v_out;
  insert into public.rw_points_ledger (profile_id, points, kind, source_key, note, created_by) values (t.recipient_id, t.points, 'adjust', 'adjust', 'Transfer ' || t.transfer_no || ' from ' || coalesce(v_scode, 'member'), uid) returning id into v_in;
  update public.rw_point_transfers set status = 'accepted', decided_at = now(), decided_by = uid, out_ledger_id = v_out, in_ledger_id = v_in, sender_balance_before = v_sb, recipient_balance_before = v_rb where id = t.id returning * into t;
  perform public.rw_log('transfer.accept', 'transfer', t.id::text, uid, null, jsonb_build_object('transfer_no', t.transfer_no, 'points', t.points, 'sender', t.sender_id, 'sender_before', v_sb, 'recipient_before', v_rb));
  perform public.rw_transfer_note(t.id, t.sender_id, 'accepted'); perform public.rw_transfer_note(t.id, t.recipient_id, 'accepted');
  return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', false, 'balance', v_rb + t.points);
end $$;

create or replace function public.rw_transfer_reject(p_transfer uuid, p_reason text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; t public.rw_point_transfers; v_r text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
begin
  uid := public.shop_require_user();
  select * into t from public.rw_point_transfers where id = p_transfer and recipient_id = uid for update;
  if not found then raise exception 'NOT_FOUND: transfer' using errcode = '42501'; end if;
  if t.status = 'rejected' then return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', true); end if;
  if t.status <> 'pending' then raise exception 'TRANSFER_NOT_PENDING: this transfer is %', t.status; end if;
  update public.rw_point_transfers set status = 'rejected', decided_at = now(), decided_by = uid, decision_reason = coalesce(v_r, 'REJECTED') where id = t.id returning * into t;
  perform public.rw_log('transfer.reject', 'transfer', t.id::text, uid, v_r, jsonb_build_object('transfer_no', t.transfer_no, 'points', t.points));
  perform public.rw_transfer_note(t.id, t.sender_id, 'rejected');
  return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', false);
end $$;

create or replace function public.rw_transfer_cancel(p_transfer uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; t public.rw_point_transfers;
begin
  uid := public.shop_require_user();
  select * into t from public.rw_point_transfers where id = p_transfer and sender_id = uid for update;
  if not found then raise exception 'NOT_FOUND: transfer' using errcode = '42501'; end if;
  if t.status = 'cancelled' then return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', true); end if;
  if t.status <> 'pending' then raise exception 'TRANSFER_NOT_PENDING: this transfer is %', t.status; end if;
  update public.rw_point_transfers set status = 'cancelled', decided_at = now(), decided_by = uid, decision_reason = 'CANCELLED_BY_SENDER' where id = t.id returning * into t;
  perform public.rw_log('transfer.cancel', 'transfer', t.id::text, uid, null, jsonb_build_object('transfer_no', t.transfer_no, 'points', t.points));
  perform public.rw_transfer_note(t.id, t.recipient_id, 'cancelled');
  return public.rw_transfer_json(t, uid) || jsonb_build_object('replay', false);
end $$;

-- everything the transfer screen needs in one call: the numbers, the code, what waits for the customer, what they sent, the history, the unread notices
create or replace function public.rw_transfer_overview() returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; s public.rw_transfer_settings; v_on boolean; v_bal integer; v_res integer; v_day integer;
begin
  uid := public.shop_require_user();
  select * into s from public.rw_transfer_settings where id;
  v_on := public.rw_transfers_on();
  if not v_on then return jsonb_build_object('enabled', false); end if;
  perform public.rw_transfer_expire(uid);
  v_bal := public.rw_points_balance(uid); v_res := public.rw_points_reserved(uid);
  select coalesce(sum(points), 0)::integer into v_day from public.rw_point_transfers where sender_id = uid and status in ('pending', 'accepted') and created_at > now() - interval '24 hours';
  return jsonb_build_object('enabled', true, 'member_code', public.rw_fmt_member_code(public.rw_member_code_of(uid)), 'balance', v_bal, 'reserved', v_res, 'available', v_bal - v_res,
    'limits', jsonb_build_object('min', s.min_points, 'max', s.max_points, 'daily_max', s.daily_max_points, 'sent_today', v_day, 'max_pending', s.max_pending, 'expire_days', s.expire_days),
    'incoming', coalesce((select jsonb_agg(public.rw_transfer_json(x, uid) order by x.created_at desc) from public.rw_point_transfers x where x.recipient_id = uid and x.status = 'pending'), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(public.rw_transfer_json(x, uid) order by x.created_at desc) from public.rw_point_transfers x where x.sender_id = uid and x.status = 'pending'), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(public.rw_transfer_json(x, uid) order by coalesce(x.decided_at, x.created_at) desc) from
        (select * from public.rw_point_transfers where (sender_id = uid or recipient_id = uid) and status <> 'pending' order by coalesce(decided_at, created_at) desc limit 50) x), '[]'::jsonb),
    'unread', (select count(*) from public.rw_transfer_notices where profile_id = uid and read_at is null));
end $$;

create or replace function public.rw_transfer_mark_read() returns integer language plpgsql security definer set search_path = public as $$
declare uid uuid := public.shop_require_user(); n integer;
begin
  update public.rw_transfer_notices set read_at = now() where profile_id = uid and read_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- 8 staff ---------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.rw_admin_transfer_settings() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.rw_require_staff('see the points transfer settings');
  return (select to_jsonb(s) - 'id' - 'updated_by' from public.rw_transfer_settings s where id) || jsonb_build_object('rewards_enabled', coalesce((select enabled from public.rw_settings where id), false));
end $$;

create or replace function public.rw_admin_save_transfer_settings(p_patch jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.rw_transfer_settings; k text; allowed text[] := array['transfers_enabled', 'min_points', 'max_points', 'daily_max_points', 'max_pending', 'expire_days'];
begin
  perform public.rw_require_super('change the points transfer settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_VALUE: nothing to save'; end if;
  for k in select jsonb_object_keys(p_patch) loop if not k = any (allowed) then raise exception 'BAD_FIELD: % cannot be changed here', k; end if; end loop;
  select * into s from public.rw_transfer_settings where id for update;
  if p_patch ? 'transfers_enabled' then
    if jsonb_typeof(p_patch -> 'transfers_enabled') <> 'boolean' then raise exception 'BAD_VALUE: transfers_enabled is on or off'; end if;
    s.transfers_enabled := (p_patch ->> 'transfers_enabled')::boolean; end if;
  if p_patch ? 'min_points' then s.min_points := public.rw_j_whole(p_patch -> 'min_points', 'the smallest transfer', 1, 'BAD_VALUE'); end if;
  if p_patch ? 'max_points' then s.max_points := public.rw_j_whole(p_patch -> 'max_points', 'the largest transfer', 1, 'BAD_VALUE'); end if;
  if p_patch ? 'daily_max_points' then s.daily_max_points := public.rw_j_whole(p_patch -> 'daily_max_points', 'the daily limit', 1, 'BAD_VALUE'); end if;
  if p_patch ? 'max_pending' then s.max_pending := public.rw_j_whole(p_patch -> 'max_pending', 'pending transfers', 1, 'BAD_VALUE'); end if;
  if p_patch ? 'expire_days' then s.expire_days := public.rw_j_whole(p_patch -> 'expire_days', 'days until a request expires', 1, 'BAD_VALUE'); end if;
  if s.max_points < s.min_points or s.daily_max_points < s.max_points or s.max_pending > 100 or s.expire_days > 90 then raise exception 'BAD_VALUE: the limits do not fit together (smallest <= largest <= daily, at most 100 pending, 90 days)'; end if;
  update public.rw_transfer_settings set transfers_enabled = s.transfers_enabled, min_points = s.min_points, max_points = s.max_points, daily_max_points = s.daily_max_points, max_pending = s.max_pending,
    expire_days = s.expire_days, updated_by = auth.uid(), updated_at = now() where id;
  perform public.rw_log('transfer.settings', 'settings', null, null, null, p_patch);
  return public.rw_admin_transfer_settings();
end $$;

create or replace function public.rw_admin_transfers(p_status text default null, p_search text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0); v_q text := nullif(btrim(coalesce(p_search, '')), ''); v_total integer;
begin
  perform public.rw_require_staff('audit points transfers');
  select count(*) into v_total from public.rw_point_transfers t where (p_status is null or t.status = p_status)
    and (v_q is null or t.transfer_no ilike '%' || v_q || '%' or public.rw_person_name(t.sender_id) ilike '%' || v_q || '%' or public.rw_person_name(t.recipient_id) ilike '%' || v_q || '%');
  return jsonb_build_object('total', v_total, 'items', coalesce((select jsonb_agg(x order by x ->> 'created_at' desc) from (
    select jsonb_build_object('id', t.id, 'transfer_no', t.transfer_no, 'status', t.status, 'points', t.points, 'message', t.message, 'created_at', t.created_at, 'expires_at', t.expires_at, 'decided_at', t.decided_at,
             'reason', t.decision_reason, 'sender_id', t.sender_id, 'sender', public.rw_person_name(t.sender_id), 'sender_code', public.rw_fmt_member_code((select code from public.rw_members where profile_id = t.sender_id)),
             'recipient_id', t.recipient_id, 'recipient', public.rw_person_name(t.recipient_id), 'recipient_code', public.rw_fmt_member_code((select code from public.rw_members where profile_id = t.recipient_id)),
             'out_ledger_id', t.out_ledger_id, 'in_ledger_id', t.in_ledger_id, 'sender_before', t.sender_balance_before, 'recipient_before', t.recipient_balance_before) as x
      from public.rw_point_transfers t where (p_status is null or t.status = p_status)
       and (v_q is null or t.transfer_no ilike '%' || v_q || '%' or public.rw_person_name(t.sender_id) ilike '%' || v_q || '%' or public.rw_person_name(t.recipient_id) ilike '%' || v_q || '%')
      order by t.created_at desc limit v_lim offset v_off) q), '[]'::jsonb));
end $$;

-- a Super Admin can cancel a pending transfer (it frees the sender's points); an accepted one is never undone here (adjust the points with a reason instead)
create or replace function public.rw_admin_cancel_transfer(p_transfer uuid, p_reason text) returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.rw_point_transfers; v_r text := btrim(coalesce(p_reason, ''));
begin
  perform public.rw_require_super('cancel a points transfer');
  if length(v_r) < 3 then raise exception 'REASON_REQUIRED'; end if;
  select * into t from public.rw_point_transfers where id = p_transfer for update;
  if not found then raise exception 'NOT_FOUND: transfer'; end if;
  if t.status <> 'pending' then raise exception 'TRANSFER_NOT_PENDING: this transfer is %', t.status; end if;
  update public.rw_point_transfers set status = 'cancelled', decided_at = now(), decided_by = auth.uid(), decision_reason = left('ADMIN: ' || v_r, 200) where id = t.id returning * into t;
  perform public.rw_log('transfer.cancel', 'transfer', t.id::text, t.sender_id, v_r, jsonb_build_object('transfer_no', t.transfer_no, 'by_admin', true));
  perform public.rw_transfer_note(t.id, t.sender_id, 'cancelled'); perform public.rw_transfer_note(t.id, t.recipient_id, 'cancelled');
  return jsonb_build_object('id', t.id, 'status', t.status);
end $$;

-- 9 grants -----------------------------------------------------------------------------------------------------------------------------------------------------
revoke all on function public.rw_transfer_lookup(text), public.rw_transfer_create(text, integer, text, text), public.rw_transfer_accept(uuid), public.rw_transfer_reject(uuid, text), public.rw_transfer_cancel(uuid),
  public.rw_transfer_overview(), public.rw_transfer_mark_read(), public.rw_admin_transfer_settings(), public.rw_admin_save_transfer_settings(jsonb),
  public.rw_admin_transfers(text, text, integer, integer), public.rw_admin_cancel_transfer(uuid, text) from public, anon;
grant execute on function public.rw_transfer_lookup(text), public.rw_transfer_create(text, integer, text, text), public.rw_transfer_accept(uuid), public.rw_transfer_reject(uuid, text), public.rw_transfer_cancel(uuid),
  public.rw_transfer_overview(), public.rw_transfer_mark_read(), public.rw_admin_transfer_settings(), public.rw_admin_save_transfer_settings(jsonb),
  public.rw_admin_transfers(text, text, integer, integer), public.rw_admin_cancel_transfer(uuid, text) to authenticated;
