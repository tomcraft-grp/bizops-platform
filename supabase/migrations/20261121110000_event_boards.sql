-- Event boards (Task 2 of docs/superpowers/plans/2026-11-21-rewards-boards-sku-sync.md): events, three boards per event, selections, race-proof claims and the
-- Super Admin board operations. Builds on 20261121100000_rewards_core.sql (rw_settings, rw_rules, rw_entitlements, rw_events_log, rw_is_staff / rw_is_super, rw_require_*).
--
-- Principles
--   * Additive: new tables and functions, plus three foreign keys on columns the core migration created as plain uuids (rw_entitlements.event_id, rw_entitlements.used_selection_id
--     and rw_rules.event_id). Nothing existing is changed or rewritten.
--   * The database decides who owns a number. A claim locks the BOARD ROW (select ... for update) and, for the customer, takes the same per-profile advisory lock as settle
--     ('rw:' || profile), so one customer's claims and a settle of that customer are serialised too. Partial unique indexes are the backstop:
--       rw_selections_exclusive_once    (board_id, number)              where exclusive and status in (reserved, confirmed)
--       rw_selections_shared_once       (board_id, number, profile_id)  where not exclusive and status in (reserved, confirmed)
--       rw_selections_entitlement_once  (entitlement_id)                where status in (reserved, confirmed)   -- a right backs one active number at most
--     and a trigger refuses an exclusive row next to a shared one on the same number (the one case two plain indexes cannot express).
--   * Lock order everywhere (the core's settle and review resolution take the first lock too): the customer's advisory lock -> the board rows (slot order) -> the entitlement rows.
--     rw_claim_number and rw_confirm_selection call settle FIRST (so a payment just verified earns its pick, one just reversed has taken it back or flagged it), then lock the board.
--     The Super Admin operations that touch rights (release, reset, undo) take the customer locks of the owners (id order) BEFORE the board row (rw_lock_profiles); a reset that finds
--     a customer who picked in the meantime asks once and says "try again" rather than wait for them with the board locked. The sweep of lapsed holds runs with a board locked and
--     may reach other customers' rights, so it never WAITS for a right (skip locked): a hold whose right is busy is swept by the next sweep (the one thing that holds a right
--     while wanting a board is a review resolution of that same right). rw_release_selection_for_review is called by that resolution with the customer lock and the right already held.
--     The event row is only ever locked FOR NO KEY UPDATE, which does not conflict with the KEY SHARE lock a selection insert takes through its foreign key.
--     scripts/local-pg/boards-concurrency.mjs (scenarios 6 and 7) mixes all of these on real connections and sees no deadlock.
--   * Selections, resets and events are never deleted and a selection's identity (board, number, customer, right, exclusive, key) never changes (guard triggers).
--     A board is never "cleaned": reset marks rows 'reset' with a reset id so that it can be undone.
--   * A hold (event.hold_minutes > 0) is a 'reserved' selection with expires_at. Reads (rw_board_state, rw_board_rev) are STABLE and write nothing: they treat a lapsed hold
--     as free and add the number of lapsed-but-unswept holds to the revision they report, so pollers notice an expiry. Sweeping (status 'expired', pick returned, revision
--     bumped by the number swept, so the reported revision does not move backwards) happens inside a claim, a reset, a release and rw_sweep_holds (staff).
--   * Customers see no identities: a cell is free / taken / mine / shared plus how many hold it.
--   * Everything is audited in rw_events_log (entity 'board' or 'event', detail carries event_id / board_id / reason / old and new values); actor is null for the system (hold expiry).

-- ---------------------------------------------------------------------------------------------- tables
create table if not exists public.rw_events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  description text check (description is null or length(description) <= 1000),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'closed')),
  starts_at timestamptz,
  ends_at timestamptz,
  number_min integer not null default 0 check (number_min >= 0),
  number_max integer not null default 99,
  hold_minutes integer not null default 0 check (hold_minutes between 0 and 1440),
  max_per_customer integer check (max_per_customer is null or max_per_customer >= 1),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (number_max >= number_min and number_max - number_min < 1000),
  check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create table if not exists public.rw_boards (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.rw_events (id) on delete restrict,
  slot integer not null check (slot between 1 and 3),
  name text not null check (length(btrim(name)) between 1 and 60),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  mode text not null default 'exclusive' check (mode in ('exclusive', 'shared')),
  state text not null default 'open' check (state in ('open', 'locked')),
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, slot),
  unique (id, event_id)
);

create table if not exists public.rw_board_resets (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null,
  event_id uuid not null,
  at timestamptz not null default clock_timestamp(),
  by_profile uuid,
  reason text not null check (length(btrim(reason)) > 0),
  returned_picks boolean not null,
  affected integer not null check (affected >= 0),
  undone_at timestamptz,
  undone_by uuid,
  undo_reason text,
  foreign key (board_id, event_id) references public.rw_boards (id, event_id) on delete restrict
);
create index if not exists rw_board_resets_board_idx on public.rw_board_resets (board_id, at desc);

create table if not exists public.rw_selections (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  board_id uuid not null,
  number integer not null check (number >= 0),
  profile_id uuid not null references public.profiles (id) on delete restrict,
  entitlement_id uuid not null references public.rw_entitlements (id) on delete restrict,
  exclusive boolean not null,                                           -- copied from the board at claim time; a later mode switch never rewrites it
  status text not null check (status in ('reserved', 'confirmed', 'released', 'reset', 'expired')),
  expires_at timestamptz,                                               -- only a reserved hold has a deadline (kept as a record once it is expired / reset)
  claim_key text,                                                       -- idempotency key of the claim (per customer) and a hash of what was asked
  request_hash text,
  reset_id uuid references public.rw_board_resets (id) on delete restrict,
  status_before_reset text check (status_before_reset in ('reserved', 'confirmed')),
  pick_returned text check (pick_returned in ('available', 'revoked')), -- what happened to the right when the number was freed (null = the right stayed used)
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  ended_at timestamptz,
  ended_by uuid,
  end_reason text,
  foreign key (board_id, event_id) references public.rw_boards (id, event_id) on delete restrict,
  check (status <> 'reserved' or expires_at is not null),
  check (status <> 'confirmed' or expires_at is null),
  check (status <> 'reset' or reset_id is not null),
  check (claim_key is null or request_hash is not null)
);
create unique index if not exists rw_selections_exclusive_once on public.rw_selections (board_id, number) where exclusive and status in ('reserved', 'confirmed');
create unique index if not exists rw_selections_shared_once on public.rw_selections (board_id, number, profile_id) where not exclusive and status in ('reserved', 'confirmed');
create unique index if not exists rw_selections_entitlement_once on public.rw_selections (entitlement_id) where status in ('reserved', 'confirmed');
create unique index if not exists rw_selections_claim_key_once on public.rw_selections (profile_id, claim_key) where claim_key is not null;
create index if not exists rw_selections_board_idx on public.rw_selections (board_id, number) where status in ('reserved', 'confirmed');
create index if not exists rw_selections_expiry_idx on public.rw_selections (board_id) where status = 'reserved';
create index if not exists rw_selections_profile_idx on public.rw_selections (profile_id, event_id);
create index if not exists rw_selections_reset_idx on public.rw_selections (reset_id) where reset_id is not null;

-- the core migration created these columns as plain uuids; now the tables they point at exist
-- The core migration could not check event ids (the table did not exist yet). If it was applied alone earlier and a rule or a right already names an event that does not
-- exist, say exactly which, instead of failing on the constraint with a raw error (nothing is half applied either way: the migration is one transaction).
do $orphans$ declare v text; begin
  select string_agg('rule "' || r.name || '" (' || r.id || ') -> event ' || r.event_id, '; ') into v
    from public.rw_rules r where r.event_id is not null and not exists (select 1 from public.rw_events e where e.id = r.event_id);
  if v is not null then raise exception 'Cannot add the event link: rules point to events that do not exist: %. Fix or remove those rules first (rules are never deleted: switch them off and point them at a real event).', v; end if;
  select string_agg(distinct x.event_id::text, ', ') into v
    from public.rw_entitlements x where x.event_id is not null and not exists (select 1 from public.rw_events e where e.id = x.event_id);
  if v is not null then raise exception 'Cannot add the event link: pick rights point to events that do not exist: %.', v; end if;
end $orphans$;
alter table public.rw_entitlements drop constraint if exists rw_entitlements_event_fk;
alter table public.rw_entitlements add constraint rw_entitlements_event_fk foreign key (event_id) references public.rw_events (id) on delete restrict;
alter table public.rw_rules drop constraint if exists rw_rules_event_fk;
alter table public.rw_rules add constraint rw_rules_event_fk foreign key (event_id) references public.rw_events (id) on delete restrict;
alter table public.rw_entitlements drop constraint if exists rw_entitlements_used_selection_fk;
alter table public.rw_entitlements add constraint rw_entitlements_used_selection_fk foreign key (used_selection_id) references public.rw_selections (id) on delete restrict;

-- ---------------------------------------------------------------------------------------------- guards
create or replace function public.rw_events_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Events are never deleted (close the event instead)'; end if;
  return new;
end $$;
drop trigger if exists rw_events_guard on public.rw_events;
create trigger rw_events_guard before delete on public.rw_events for each row execute function public.rw_events_guard();

create or replace function public.rw_boards_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Boards are never deleted'; end if;
  if new.id is distinct from old.id or new.event_id is distinct from old.event_id or new.slot is distinct from old.slot then
    raise exception 'A board''s event and slot cannot be changed'; end if;
  return new;
end $$;
drop trigger if exists rw_boards_guard on public.rw_boards;
create trigger rw_boards_guard before update or delete on public.rw_boards for each row execute function public.rw_boards_guard();

-- three boards per event, always (also for a direct insert)
create or replace function public.rw_events_make_boards() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.rw_boards (event_id, slot, name, color)
    values (new.id, 1, 'Board A', '#2563eb'), (new.id, 2, 'Board B', '#16a34a'), (new.id, 3, 'Board C', '#d97706');
  return new;
end $$;
drop trigger if exists rw_events_make_boards on public.rw_events;
create trigger rw_events_make_boards after insert on public.rw_events for each row execute function public.rw_events_make_boards();

create or replace function public.rw_resets_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'Board resets are never deleted'; end if;
  if new.id is distinct from old.id or new.board_id is distinct from old.board_id or new.event_id is distinct from old.event_id or new.at is distinct from old.at
     or new.by_profile is distinct from old.by_profile or new.reason is distinct from old.reason or new.returned_picks is distinct from old.returned_picks
     or new.affected is distinct from old.affected then
    raise exception 'A board reset cannot be edited (undo it instead)'; end if;
  if old.undone_at is not null then raise exception 'This reset was already undone'; end if;
  return new;
end $$;
drop trigger if exists rw_board_resets_guard on public.rw_board_resets;
create trigger rw_board_resets_guard before update or delete on public.rw_board_resets for each row execute function public.rw_resets_guard();
drop trigger if exists rw_board_resets_no_truncate on public.rw_board_resets;
create trigger rw_board_resets_no_truncate before truncate on public.rw_board_resets for each statement execute function public.rw_resets_guard();

create or replace function public.rw_selections_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'Selections are never deleted (release or reset them instead)'; end if;
  if new.id is distinct from old.id or new.event_id is distinct from old.event_id or new.board_id is distinct from old.board_id or new.number is distinct from old.number
     or new.profile_id is distinct from old.profile_id or new.entitlement_id is distinct from old.entitlement_id or new.exclusive is distinct from old.exclusive
     or new.claim_key is distinct from old.claim_key or new.request_hash is distinct from old.request_hash or new.created_at is distinct from old.created_at then
    raise exception 'A selection''s board, number, customer and right cannot be changed (release it and pick again)'; end if;
  if new.status is distinct from old.status and not (
        (old.status = 'reserved' and new.status in ('confirmed', 'released', 'reset', 'expired'))
     or (old.status = 'confirmed' and new.status in ('released', 'reset'))
     or (old.status = 'reset' and (new.status = old.status_before_reset or new.status = 'expired'))) then
    raise exception 'A selection cannot go from % to %', old.status, new.status; end if;
  return new;
end $$;
drop trigger if exists rw_selections_guard on public.rw_selections;
create trigger rw_selections_guard before update or delete on public.rw_selections for each row execute function public.rw_selections_guard();
drop trigger if exists rw_selections_no_truncate on public.rw_selections;
create trigger rw_selections_no_truncate before truncate on public.rw_selections for each statement execute function public.rw_selections_guard();

-- an exclusive holder and a shared holder of the same number can never coexist, whoever writes the row (the unique indexes cover same-kind duplicates)
create or replace function public.rw_selections_mixed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('reserved', 'confirmed') and (tg_op = 'INSERT' or old.status not in ('reserved', 'confirmed')) then
    perform 1 from public.rw_boards where id = new.board_id for update;                 -- the same lock a claim takes: a direct writer serialises with the claims
    if exists (select 1 from public.rw_selections s where s.board_id = new.board_id and s.number = new.number and s.id <> new.id
                 and s.status in ('reserved', 'confirmed') and s.exclusive <> new.exclusive) then
      raise exception 'rw_selections_mixed_once: number % on this board is already held in the other mode', new.number using errcode = '23505', constraint = 'rw_selections_mixed_once';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rw_selections_mixed on public.rw_selections;
create trigger rw_selections_mixed before insert or update of status on public.rw_selections for each row execute function public.rw_selections_mixed();

-- ---------------------------------------------------------------------------------------------- internal helpers (no client grant)
create or replace function public.rw_boards_live() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.enabled and s.boards_enabled from public.rw_settings s limit 1), false) $$;

create or replace function public.rw_person_name(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.email), '')) from public.profiles p where p.id = p_id $$;

-- the event customers see when they name none: active, window open now (deterministic if staff leave several active: latest start first); when none is running, the most
-- recent PAUSED one, so a paused event shows its board read-only ("paused") instead of vanishing. A closed event is only reached through the customer's own selections.
create or replace function public.rw_current_event() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select e.id from public.rw_events e
      where e.status = 'active' and (e.starts_at is null or e.starts_at <= now()) and (e.ends_at is null or now() < e.ends_at)
      order by e.starts_at desc nulls last, e.created_at desc, e.id limit 1),
    (select e.id from public.rw_events e where e.status = 'paused' order by e.created_at desc, e.id limit 1)) $$;

create or replace function public.rw_need_reason(p_reason text) returns text
language plpgsql immutable security definer set search_path = public as $$
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'REASON_REQUIRED'; end if;
  return left(btrim(p_reason), 500);
end $$;

-- One audit row. The actor is passed explicitly (null = the system, e.g. a hold that expired; the column default auth.uid() would otherwise name whoever happened to
-- trigger the sweep). event_id / board_id / profile_id / reason go to the columns the core migration gave rw_events_log; the same values stay in detail.
create or replace function public.rw_board_log(p_actor uuid, p_action text, p_entity text, p_entity_id uuid, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.rw_events_log (actor, action, entity, entity_id, event_id, board_id, profile_id, reason, detail)
  values (p_actor, p_action, p_entity, p_entity_id::text, (p_detail ->> 'event_id')::uuid, (p_detail ->> 'board_id')::uuid, (p_detail ->> 'profile_id')::uuid, p_detail ->> 'reason', coalesce(p_detail, '{}'::jsonb)) $$;

-- Settle for the customer a call is about, the way the core does it for rw_my_rewards: whatever is paid now is counted now. A reward error is logged and swallowed (a settle
-- problem must never stop a claim; the same 'settle_error' row the core writes).
create or replace function public.rw_settle_quiet(p_profile uuid, p_source text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.rw_settle_profile(p_profile);
exception when others then
  begin
    insert into public.rw_events_log (action, entity, entity_id, profile_id, detail)
      values ('settle_error', 'profile', p_profile::text, p_profile, jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm, 'source', p_source));
  exception when others then null;
  end;
end $$;

-- The customer locks (the key settle takes) of several customers, in id order, so two callers locking the same customers can never wait for each other in a circle.
-- For the Super Admin operations that touch the rights of customers: they call it BEFORE they lock a board row, like a claim does for its own customer.
create or replace function public.rw_lock_profiles(p_profiles uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare p uuid;
begin
  for p in select distinct x from unnest(coalesce(p_profiles, '{}'::uuid[])) x where x is not null order by x loop
    perform pg_advisory_xact_lock(hashtextextended('rw:' || p::text, 0));
  end loop;
end $$;

create or replace function public.rw_lock_board(p_board uuid) returns public.rw_boards
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards;
begin
  select * into b from public.rw_boards where id = p_board for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  return b;
end $$;

create or replace function public.rw_selection_json(s public.rw_selections) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'board_id', s.board_id, 'number', s.number, 'status', s.status, 'expires_at', s.expires_at) $$;

-- earned = rights not revoked, used = used, remaining = available (for one customer and one event).
-- A right behind a LAPSED hold (reserved, past its deadline, not swept yet) counts as already given back: that is what the sweep will do to it (or, for a right whose
-- bill was taken back, revoke it), so a customer never sees a pick as spent because nobody has swept yet.
create or replace function public.rw_event_rights(p_event uuid, p_uid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'earned', count(*) filter (where e.status <> 'revoked' and not (lp.lapsed and e.needs_review)),
    'used', count(*) filter (where e.status = 'used' and not lp.lapsed),
    'remaining', count(*) filter (where e.status = 'available' or (e.status = 'used' and lp.lapsed and not e.needs_review)))
  from public.rw_entitlements e
  cross join lateral (select exists (select 1 from public.rw_selections s where s.id = e.used_selection_id and s.status = 'reserved' and s.expires_at <= now()) as lapsed) lp
  where e.profile_id = p_uid and e.event_id = p_event $$;

-- Board as staff list it. 'rev' = stored revision + lapsed holds not yet swept (see the header), 'taken' = numbers with an active holder.
create or replace function public.rw_board_json(p_board uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'event_id', b.event_id, 'slot', b.slot, 'name', b.name, 'color', b.color, 'mode', b.mode, 'state', b.state,
    'rev', b.rev + x.lapsed, 'taken', x.taken, 'total', e.number_max - e.number_min + 1,
    'last_reset_id', (select r.id from public.rw_board_resets r where r.board_id = b.id and r.undone_at is null order by r.at desc, r.id desc limit 1))
  from public.rw_boards b join public.rw_events e on e.id = b.event_id
  cross join lateral (select (count(distinct s.number) filter (where s.status = 'confirmed' or (s.status = 'reserved' and s.expires_at > now())))::int as taken,
                             (count(*) filter (where s.status = 'reserved' and s.expires_at <= now()))::int as lapsed
                      from public.rw_selections s where s.board_id = b.id) x
  where b.id = p_board $$;

-- Board as a customer sees it: ONE statement (one snapshot), so revision, taken and every cell always agree. No identity anywhere.
create or replace function public.rw_board_view(p_board uuid, p_uid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with b as (
    select bd.id, bd.event_id, bd.slot, bd.name, bd.color, bd.mode, bd.state, bd.rev, e.number_min, e.number_max
    from public.rw_boards bd join public.rw_events e on e.id = bd.event_id where bd.id = p_board),
  held as (
    select s.number, count(*)::int as c, bool_or(s.profile_id = p_uid) as mine, bool_or(s.exclusive) as ex
    from public.rw_selections s
    where s.board_id = p_board and (s.status = 'confirmed' or (s.status = 'reserved' and s.expires_at > now())) group by s.number),
  lapsed as (select count(*)::int as n from public.rw_selections s where s.board_id = p_board and s.status = 'reserved' and s.expires_at <= now()),
  cells as (
    select g.n, coalesce(h.c, 0) as c, coalesce(h.mine, false) as mine, coalesce(h.ex, false) as ex
    from b cross join generate_series(b.number_min, b.number_max) as g(n) left join held h on h.number = g.n)
  select jsonb_build_object('id', b.id, 'slot', b.slot, 'name', b.name, 'color', b.color, 'mode', b.mode, 'state', b.state,
    'rev', b.rev + (select n from lapsed),
    'taken', (select count(*) from cells where c > 0),
    -- the picks THIS customer can spend on THIS board (a right is valid on the slots of its rule; `rights` of the state is event-wide): counts like rw_event_rights,
    -- a right behind a lapsed hold is already given back
    'remaining', (select count(*)::int from public.rw_entitlements en join public.rw_rules ru on ru.id = en.rule_id
                   where en.profile_id = p_uid and en.event_id = b.event_id and (ru.board_slots is null or b.slot = any (ru.board_slots))
                     and (en.status = 'available' or (en.status = 'used' and not en.needs_review
                          and exists (select 1 from public.rw_selections ls where ls.id = en.used_selection_id and ls.status = 'reserved' and ls.expires_at <= now())))),
    'numbers', (select jsonb_agg(jsonb_build_object('n', n, 's', case when mine then 'mine' when ex then 'taken' when c > 0 then 'shared' else 'free' end, 'c', c) order by n) from cells))
  from b $$;

create or replace function public.rw_event_json(p_event uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', e.id, 'name', e.name, 'description', e.description, 'status', e.status, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
    'number_min', e.number_min, 'number_max', e.number_max, 'hold_minutes', e.hold_minutes, 'max_per_customer', e.max_per_customer,
    'boards', coalesce((select jsonb_agg(public.rw_board_json(b.id) order by b.slot) from public.rw_boards b where b.event_id = e.id), '[]'::jsonb))
  from public.rw_events e where e.id = p_event $$;

create or replace function public.rw_admin_board_json(p_board uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('board', public.rw_board_json(b.id),
    'numbers', coalesce((select jsonb_agg(jsonb_build_object('n', h.number, 'holders', h.holders) order by h.number) from (
        select s.number, jsonb_agg(jsonb_build_object('selection_id', s.id, 'profile_id', s.profile_id, 'name', public.rw_person_name(s.profile_id), 'phone_tail', right(p.phone, 4),
                 'status', s.status, 'exclusive', s.exclusive, 'at', s.created_at) order by s.created_at, s.id) as holders
        from public.rw_selections s join public.profiles p on p.id = s.profile_id
        where s.board_id = b.id and (s.status = 'confirmed' or (s.status = 'reserved' and s.expires_at > now())) group by s.number) h), '[]'::jsonb),
    'resets', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'at', r.at, 'by_name', public.rw_person_name(r.by_profile), 'reason', r.reason, 'returned_picks', r.returned_picks,
                 'affected', r.affected, 'undone_at', r.undone_at) order by r.at desc, r.id desc) from public.rw_board_resets r where r.board_id = b.id), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'actor_name', public.rw_person_name(l.actor), 'action', l.action, 'reason', coalesce(l.reason, l.detail ->> 'reason'), 'detail', l.detail) order by l.at desc, l.id desc)
        from (select * from public.rw_events_log g
              where g.entity in ('board', 'event') and g.event_id = b.event_id and (g.board_id is null or g.board_id = b.id)
              order by g.at desc, g.id desc limit 100) l), '[]'::jsonb))
  from public.rw_boards b where b.id = p_board $$;

-- Gives a number's right back (or, if its bill was taken back after the pick, revokes it instead: a reversed payment never earns a second pick). Returns what it did.
create or replace function public.rw_return_pick(p_entitlement uuid, p_selection uuid) returns text
language plpgsql security definer set search_path = public as $$
declare e public.rw_entitlements;
begin
  select * into e from public.rw_entitlements where id = p_entitlement for update;
  if not found or e.status <> 'used' or e.used_selection_id is distinct from p_selection then return null; end if;
  if e.needs_review then
    update public.rw_entitlements set status = 'revoked', revoked_reason = 'BILL_TAKEN_BACK', revoked_at = now(), needs_review = false, review_since = null, used_selection_id = null where id = e.id;
    return 'revoked';
  end if;
  -- a right that goes back to 'available' is no longer a kept one: if it is used again and its bill is taken back later, it must be flagged for review again
  update public.rw_entitlements set status = 'available', used_selection_id = null, kept = false where id = e.id;
  return 'available';
end $$;

-- Expires the lapsed holds of one board (the caller normally holds the board lock; this takes it too). Bumps the revision by the number swept.
-- The sweep runs with the board row locked and may reach the rights of OTHER customers (their customer lock is not held), so it never WAITS for a right: if another
-- transaction has the right locked (a review resolution of the same right is the only thing that does, it holds the customer lock and then wants this board), that hold is
-- left for the next sweep. The lapsed hold stays invisible to readers meanwhile; a claim of its number is told NUMBER_TAKEN once and succeeds on the retry.
create or replace function public.rw_sweep_board(p_board uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare r public.rw_selections; n integer := 0; pr text; ev uuid;
begin
  select event_id into ev from public.rw_boards where id = p_board for update;
  if not found then return 0; end if;
  for r in select * from public.rw_selections where board_id = p_board and status = 'reserved' and expires_at <= now() order by entitlement_id, id for update loop
    perform 1 from public.rw_entitlements where id = r.entitlement_id for update skip locked;
    if not found then continue; end if;
    pr := public.rw_return_pick(r.entitlement_id, r.id);
    update public.rw_selections set status = 'expired', ended_at = now(), end_reason = 'hold expired', pick_returned = pr where id = r.id;
    perform public.rw_board_log(null, 'expire', 'board', p_board, jsonb_build_object('event_id', ev, 'board_id', p_board, 'selection_id', r.id, 'number', r.number, 'profile_id', r.profile_id, 'pick_returned', pr));
    n := n + 1;
  end loop;
  if n > 0 then update public.rw_boards set rev = rev + n, updated_at = now() where id = p_board; end if;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------- customer: read
create or replace function public.rw_board_rev(p_event uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid; ev uuid; est text;
begin
  uid := public.shop_require_user();
  if not public.rw_boards_live() then raise exception 'BOARDS_OFF'; end if;
  ev := coalesce(p_event, public.rw_current_event());
  if ev is null then return jsonb_build_object('event_status', null, 'boards', '[]'::jsonb); end if;
  select status into est from public.rw_events where id = ev;
  if not found or (est = 'draft' and not public.rw_is_staff()) then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('event_status', est, 'boards', coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'rev', b.rev + (select count(*)::int from public.rw_selections s where s.board_id = b.id and s.status = 'reserved' and s.expires_at <= now()), 'state', b.state) order by b.slot)
    from public.rw_boards b where b.event_id = ev), '[]'::jsonb));
end $$;

create or replace function public.rw_board_state(p_event uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid; ev public.rw_events; evid uuid;
begin
  uid := public.shop_require_user();
  if not public.rw_boards_live() then raise exception 'BOARDS_OFF'; end if;
  evid := coalesce(p_event, public.rw_current_event());
  if evid is null then return jsonb_build_object('event', null, 'boards', '[]'::jsonb, 'rights', jsonb_build_object('earned', 0, 'used', 0, 'remaining', 0)); end if;
  select * into ev from public.rw_events where id = evid;
  if not found or (ev.status = 'draft' and not public.rw_is_staff()) then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object(
    'event', jsonb_build_object('id', ev.id, 'name', ev.name, 'status', ev.status, 'number_min', ev.number_min, 'number_max', ev.number_max, 'hold_minutes', ev.hold_minutes, 'starts_at', ev.starts_at, 'ends_at', ev.ends_at),
    'boards', coalesce((select jsonb_agg(public.rw_board_view(b.id, uid) order by b.slot) from public.rw_boards b where b.event_id = ev.id), '[]'::jsonb),
    'rights', public.rw_event_rights(ev.id, uid));
end $$;

-- ---------------------------------------------------------------------------------------------- customer: claim and confirm
create or replace function public.rw_claim_number(p_event uuid, p_board uuid, p_number integer, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; b public.rw_boards; ev public.rw_events; ent public.rw_entitlements; sel public.rw_selections; existing public.rw_selections;
        hash text; cand uuid; got boolean := false; cn text; i integer; bx uuid;
begin
  uid := public.shop_require_user();
  if not public.rw_boards_live() then raise exception 'BOARDS_OFF'; end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  if p_event is null or p_board is null then raise exception 'NOT_FOUND'; end if;
  -- LOCK ORDER (the same everywhere, see the header): this customer's advisory lock (the key settle takes), then the board rows, then the entitlement rows.
  -- Settle runs FIRST, so a payment that was just verified earns its pick before the claim looks for one, and a reversal that was just posted has already taken
  -- its pick back or flagged it.
  perform pg_advisory_xact_lock(hashtextextended('rw:' || uid::text, 0));       -- settle takes it too; taking it here covers the case where settle returns early
  perform public.rw_settle_quiet(uid, 'rw_claim_number');

  hash := md5(jsonb_build_object('event', p_event, 'board', p_board, 'number', p_number)::text);
  select * into existing from public.rw_selections where profile_id = uid and claim_key = p_key;
  if found then
    if existing.request_hash <> hash then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    -- a replay answers with the selection the first call made ONLY while it is still the customer's: a hold that lapsed, or a pick that was released or reset since,
    -- is not success any more (the client would show "done" for a number the customer does not hold)
    if existing.status not in ('reserved', 'confirmed') or (existing.status = 'reserved' and existing.expires_at is not null and existing.expires_at <= now()) then
      raise exception 'HOLD_EXPIRED';
    end if;
    return jsonb_build_object('replay', true, 'selection', public.rw_selection_json(existing), 'board', public.rw_board_view(existing.board_id, uid), 'rights', public.rw_event_rights(existing.event_id, uid));
  end if;

  -- THE lock: the board rows of the event, always in slot order (so two claims, a reset and an event edit can never wait for each other in a circle). Everything below on these
  -- boards is one at a time. All three are locked, not only the claimed one, because the sweep below may return a lapsed hold of this customer on ANOTHER board of the event.
  perform 1 from public.rw_boards where event_id = p_event order by slot for update;
  select * into b from public.rw_boards where id = p_board and event_id = p_event;
  if not found then raise exception 'NOT_FOUND'; end if;
  for bx in select x.id from public.rw_boards x where x.event_id = p_event order by x.slot loop
    perform public.rw_sweep_board(bx);                                                            -- lapsed holds free their numbers and picks
  end loop;
  select * into b from public.rw_boards where id = p_board;                                         -- re-read: the sweep bumped the revision
  select * into ev from public.rw_events where id = p_event;
  if ev.status <> 'active' or (ev.starts_at is not null and ev.starts_at > now()) or (ev.ends_at is not null and ev.ends_at <= now()) then raise exception 'EVENT_NOT_ACTIVE'; end if;
  if b.state = 'locked' then raise exception 'BOARD_LOCKED'; end if;
  if p_number is null or p_number < ev.number_min or p_number > ev.number_max then raise exception 'NUMBER_OUT_OF_RANGE'; end if;
  if ev.max_per_customer is not null and (select count(*) from public.rw_selections s where s.event_id = ev.id and s.profile_id = uid
       and (s.status = 'confirmed' or (s.status = 'reserved' and s.expires_at > now()))) >= ev.max_per_customer then raise exception 'LIMIT_REACHED'; end if;

  -- the customer's oldest AVAILABLE right that is valid for this board's slot: deterministic order, then locked and re-checked (a settle or an admin may have moved it)
  for i in 1..3 loop
    select e.id into cand from public.rw_entitlements e join public.rw_rules r on r.id = e.rule_id
      where e.profile_id = uid and e.event_id = ev.id and e.status = 'available' and (r.board_slots is null or b.slot = any (r.board_slots))
      -- the MOST RESTRICTED right first (a right valid on one board only is spent before one valid anywhere), so a customer is never refused while a right
      -- that fits this board still exists; then the oldest
      order by coalesce(cardinality(r.board_slots), 9), e.created_at, e.seq, e.id limit 1;
    exit when cand is null;
    select * into ent from public.rw_entitlements where id = cand and status = 'available' for update;
    if found then got := true; exit; end if;
  end loop;
  if not got then raise exception 'NO_ENTITLEMENT'; end if;

  -- occupancy (the partial unique indexes and the mixed-mode trigger repeat this as a backstop)
  if b.mode = 'exclusive' then
    if exists (select 1 from public.rw_selections s where s.board_id = b.id and s.number = p_number and s.status in ('reserved', 'confirmed')) then raise exception 'NUMBER_TAKEN'; end if;
  else
    if exists (select 1 from public.rw_selections s where s.board_id = b.id and s.number = p_number and s.status in ('reserved', 'confirmed') and (s.exclusive or s.profile_id = uid)) then raise exception 'NUMBER_TAKEN'; end if;
  end if;

  begin
    insert into public.rw_selections (event_id, board_id, number, profile_id, entitlement_id, exclusive, status, expires_at, claim_key, request_hash)
      values (ev.id, b.id, p_number, uid, ent.id, b.mode = 'exclusive', case when ev.hold_minutes > 0 then 'reserved' else 'confirmed' end,
              case when ev.hold_minutes > 0 then now() + make_interval(mins => ev.hold_minutes) end, p_key, hash)
      returning * into sel;
  exception when unique_violation then
    get stacked diagnostics cn = constraint_name;
    if cn in ('rw_selections_exclusive_once', 'rw_selections_shared_once', 'rw_selections_mixed_once', 'rw_selections_entitlement_once') then raise exception 'NUMBER_TAKEN'; end if;
    raise;
  end;
  update public.rw_entitlements set status = 'used', used_selection_id = sel.id where id = ent.id;
  update public.rw_boards set rev = rev + 1, updated_at = now() where id = b.id;
  perform public.rw_board_log(uid, 'claim', 'board', b.id, jsonb_build_object('event_id', ev.id, 'board_id', b.id, 'board', b.name, 'selection_id', sel.id, 'number', p_number,
    'profile_id', uid, 'status', sel.status, 'exclusive', sel.exclusive, 'entitlement_id', ent.id));
  return jsonb_build_object('replay', false, 'selection', public.rw_selection_json(sel), 'board', public.rw_board_view(b.id, uid), 'rights', public.rw_event_rights(ev.id, uid));
end $$;

create or replace function public.rw_confirm_selection(p_selection uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; bid uuid; b public.rw_boards; sel public.rw_selections; ev public.rw_events;
begin
  uid := public.shop_require_user();
  if not public.rw_boards_live() then raise exception 'BOARDS_OFF'; end if;
  select board_id into bid from public.rw_selections where id = p_selection and profile_id = uid;
  if not found then raise exception 'NOT_FOUND'; end if;                         -- someone else's selection looks exactly like one that does not exist
  perform pg_advisory_xact_lock(hashtextextended('rw:' || uid::text, 0));       -- lock order: this customer, then the board (see the header); settle first
  perform public.rw_settle_quiet(uid, 'rw_confirm_selection');
  b := public.rw_lock_board(bid);
  select * into sel from public.rw_selections where id = p_selection for update;
  if sel.status = 'confirmed' then
    return jsonb_build_object('selection', public.rw_selection_json(sel), 'board', public.rw_board_view(b.id, uid), 'rights', public.rw_event_rights(sel.event_id, uid));
  end if;
  if sel.status = 'expired' or (sel.status = 'reserved' and sel.expires_at <= now()) then raise exception 'HOLD_EXPIRED'; end if;
  if sel.status <> 'reserved' then raise exception 'NOT_FOUND'; end if;
  select * into ev from public.rw_events where id = sel.event_id;
  if ev.status <> 'active' or (ev.ends_at is not null and ev.ends_at <= now()) then raise exception 'EVENT_NOT_ACTIVE'; end if;
  update public.rw_selections set status = 'confirmed', expires_at = null, confirmed_at = now() where id = sel.id returning * into sel;
  update public.rw_boards set rev = rev + 1, updated_at = now() where id = b.id;
  perform public.rw_board_log(uid, 'confirm', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'selection_id', sel.id, 'number', sel.number, 'profile_id', uid));
  return jsonb_build_object('selection', public.rw_selection_json(sel), 'board', public.rw_board_view(b.id, uid), 'rights', public.rw_event_rights(sel.event_id, uid));
end $$;

-- ---------------------------------------------------------------------------------------------- staff: events and boards
create or replace function public.rw_admin_events() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.rw_require_staff('read the events');
  return coalesce((select jsonb_agg(public.rw_event_json(e.id) order by e.created_at desc, e.id) from public.rw_events e), '[]'::jsonb);
end $$;

create or replace function public.rw_admin_save_event(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ev public.rw_events; k text; creating boolean := (p_id is null); old_j jsonb := '{}'::jsonb; new_j jsonb; changes jsonb; old_min integer; old_max integer; held integer; b record; sw integer;
begin
  perform public.rw_require_staff('manage events');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_RULE: the event details must be an object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('id', 'boards', 'status', 'name', 'description', 'starts_at', 'ends_at', 'number_min', 'number_max', 'hold_minutes', 'max_per_customer') then
      raise exception 'BAD_RULE: unknown event field %', k; end if;
  end loop;
  if creating then
    if not (p_patch ? 'name') then raise exception 'BAD_RULE: an event needs a name'; end if;
    ev.status := 'draft'; ev.number_min := 0; ev.number_max := 99; ev.hold_minutes := 0;
  else
    select * into ev from public.rw_events where id = p_id for no key update;                 -- NO KEY UPDATE: a claim's foreign-key check (KEY SHARE) is not blocked by it
    if not found then raise exception 'NOT_FOUND'; end if;
    old_j := to_jsonb(ev);
  end if;
  old_min := ev.number_min; old_max := ev.number_max;
  if p_patch ? 'status' and p_patch ->> 'status' is distinct from ev.status then
    raise exception 'BAD_RULE: change the status with rw_admin_set_event_status'; end if;

  begin
    if p_patch ? 'name' then
      if jsonb_typeof(p_patch -> 'name') <> 'string' then raise exception 'BAD_RULE: the name must be text'; end if;
      ev.name := btrim(p_patch ->> 'name');
    end if;
    if p_patch ? 'description' then ev.description := nullif(btrim(p_patch ->> 'description'), ''); end if;
    if p_patch ? 'starts_at' then ev.starts_at := (p_patch ->> 'starts_at')::timestamptz; end if;
    if p_patch ? 'ends_at' then ev.ends_at := (p_patch ->> 'ends_at')::timestamptz; end if;
    foreach k in array array['number_min', 'number_max', 'hold_minutes'] loop
      if p_patch ? k then
        if jsonb_typeof(p_patch -> k) <> 'number' or (p_patch ->> k)::numeric <> trunc((p_patch ->> k)::numeric) then raise exception 'BAD_RULE: % must be a whole number', k; end if;
        if k = 'number_min' then ev.number_min := (p_patch ->> k)::integer;
        elsif k = 'number_max' then ev.number_max := (p_patch ->> k)::integer;
        else ev.hold_minutes := (p_patch ->> k)::integer; end if;
      end if;
    end loop;
    if p_patch ? 'max_per_customer' then
      if jsonb_typeof(p_patch -> 'max_per_customer') = 'null' then ev.max_per_customer := null;
      elsif jsonb_typeof(p_patch -> 'max_per_customer') <> 'number' or (p_patch ->> 'max_per_customer')::numeric <> trunc((p_patch ->> 'max_per_customer')::numeric) then
        raise exception 'BAD_RULE: max_per_customer must be a whole number or empty';
      else ev.max_per_customer := (p_patch ->> 'max_per_customer')::integer; end if;
    end if;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'BAD_RULE: a value in the event details is not valid';
  end;

  if ev.name is null or length(ev.name) not between 1 and 100 then raise exception 'BAD_RULE: the name must be 1-100 characters'; end if;
  if ev.description is not null and length(ev.description) > 1000 then raise exception 'BAD_RULE: the description is too long'; end if;
  if ev.number_min < 0 or ev.number_max < ev.number_min or ev.number_max - ev.number_min >= 1000 then raise exception 'BAD_RULE: the number range must be from 0 up, with at most 1000 numbers'; end if;
  if ev.hold_minutes not between 0 and 1440 then raise exception 'BAD_RULE: the hold time must be 0-1440 minutes'; end if;
  if ev.max_per_customer is not null and ev.max_per_customer < 1 then raise exception 'BAD_RULE: max_per_customer must be at least 1'; end if;
  if ev.starts_at is not null and ev.ends_at is not null and ev.ends_at <= ev.starts_at then raise exception 'BAD_RULE: the end must be after the start'; end if;

  if creating then
    insert into public.rw_events (name, description, status, starts_at, ends_at, number_min, number_max, hold_minutes, max_per_customer)
      values (ev.name, ev.description, 'draft', ev.starts_at, ev.ends_at, ev.number_min, ev.number_max, ev.hold_minutes, ev.max_per_customer) returning * into ev;
    perform public.rw_board_log(auth.uid(), 'create_event', 'event', ev.id, jsonb_build_object('event_id', ev.id, 'name', ev.name));
    return public.rw_event_json(ev.id);
  end if;

  if ev.number_min <> old_min or ev.number_max <> old_max then
    -- every board of the event, in slot order, before anything is read: claims on any board wait here, so no number can be taken outside the new range in between
    for b in select id from public.rw_boards where event_id = ev.id order by slot for update loop
      sw := public.rw_sweep_board(b.id);
    end loop;
    if exists (select 1 from public.rw_selections where event_id = ev.id) then
      perform public.rw_require_super('change the number range of an event that already has picks');
    end if;
    select number into held from public.rw_selections where event_id = ev.id and status in ('reserved', 'confirmed') and (number < ev.number_min or number > ev.number_max) order by number limit 1;
    if found then raise exception 'NUMBER_OUT_OF_RANGE: number % is held on a board; release or reset it first', held; end if;
  end if;

  update public.rw_events set name = ev.name, description = ev.description, starts_at = ev.starts_at, ends_at = ev.ends_at, number_min = ev.number_min, number_max = ev.number_max,
    hold_minutes = ev.hold_minutes, max_per_customer = ev.max_per_customer, updated_at = now() where id = ev.id returning * into ev;
  new_j := to_jsonb(ev);
  select coalesce(jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value)), '{}'::jsonb) into changes
    from jsonb_each(new_j) n left join jsonb_each(old_j) o on o.key = n.key where n.key <> 'updated_at' and n.value is distinct from o.value;
  if changes <> '{}'::jsonb then
    update public.rw_boards set rev = rev + 1, updated_at = now() where event_id = ev.id;
    perform public.rw_board_log(auth.uid(), 'save_event', 'event', ev.id, jsonb_build_object('event_id', ev.id, 'changes', changes));
  end if;
  return public.rw_event_json(ev.id);
end $$;

create or replace function public.rw_admin_set_event_status(p_id uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ev public.rw_events; why text; old_status text;
begin
  perform public.rw_require_staff('change an event''s status');
  if p_status is null or p_status not in ('draft', 'active', 'paused', 'closed') then raise exception 'BAD_RULE: unknown event status'; end if;
  select * into ev from public.rw_events where id = p_id for no key update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_status = 'closed' or ev.status = 'closed' then perform public.rw_require_super('close or reopen an event'); end if;
  why := public.rw_need_reason(p_reason);
  if ev.status = p_status then return public.rw_event_json(ev.id); end if;
  perform 1 from public.rw_boards where event_id = ev.id order by slot for update;
  old_status := ev.status;
  update public.rw_events set status = p_status, updated_at = now() where id = ev.id;
  update public.rw_boards set rev = rev + 1, updated_at = now() where event_id = ev.id;
  perform public.rw_board_log(auth.uid(), 'set_event_status', 'event', ev.id, jsonb_build_object('event_id', ev.id, 'reason', why, 'from', old_status, 'to', p_status));
  return public.rw_event_json(ev.id);
end $$;

create or replace function public.rw_admin_save_board(p_board uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards; k text; nm text; col text; changes jsonb := '{}'::jsonb;
begin
  perform public.rw_require_staff('edit a board');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_RULE: the board details must be an object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('name', 'color') then raise exception 'BAD_RULE: only the name and the colour of a board can be edited here (lock, mode and numbers have their own operations)'; end if;
  end loop;
  b := public.rw_lock_board(p_board);
  nm := b.name; col := b.color;
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch -> 'name') <> 'string' then raise exception 'BAD_RULE: the name must be text'; end if;
    nm := btrim(p_patch ->> 'name');
    if length(nm) not between 1 and 60 then raise exception 'BAD_RULE: the board name must be 1-60 characters'; end if;
  end if;
  if p_patch ? 'color' then
    if jsonb_typeof(p_patch -> 'color') <> 'string' or (p_patch ->> 'color') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'BAD_RULE: the colour must look like #2563eb'; end if;
    col := lower(p_patch ->> 'color');
  end if;
  if nm <> b.name then changes := changes || jsonb_build_object('name', jsonb_build_object('old', b.name, 'new', nm)); end if;
  if col <> b.color then changes := changes || jsonb_build_object('color', jsonb_build_object('old', b.color, 'new', col)); end if;
  if changes <> '{}'::jsonb then
    update public.rw_boards set name = nm, color = col, rev = rev + 1, updated_at = now() where id = b.id;
    perform public.rw_board_log(auth.uid(), 'save_board', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'changes', changes));
  end if;
  return public.rw_board_json(b.id);
end $$;

create or replace function public.rw_admin_board(p_board uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.rw_require_staff('read a board');
  if not exists (select 1 from public.rw_boards where id = p_board) then raise exception 'NOT_FOUND'; end if;
  return public.rw_admin_board_json(p_board);
end $$;

create or replace function public.rw_admin_log(p_event uuid, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.rw_require_staff('read the audit log');
  if not exists (select 1 from public.rw_events where id = p_event) then raise exception 'NOT_FOUND'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'actor_name', public.rw_person_name(l.actor), 'action', l.action, 'reason', coalesce(l.reason, l.detail ->> 'reason'), 'detail', l.detail) order by l.at desc, l.id desc)
    from (select * from public.rw_events_log g where g.entity in ('board', 'event') and g.event_id = p_event
          order by g.at desc, g.id desc limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))) l), '[]'::jsonb);
end $$;

-- Staff-callable sweep: expires every lapsed hold (of one event, or of all events) and gives the picks back. Returns how many.
create or replace function public.rw_sweep_holds(p_event uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare b record; n integer := 0;
begin
  perform public.rw_require_staff('sweep expired holds');
  for b in select distinct s.board_id from public.rw_selections s where s.status = 'reserved' and s.expires_at <= now() and (p_event is null or s.event_id = p_event) order by 1 loop
    n := n + public.rw_sweep_board(b.board_id);
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------- Super Admin operations (each: reason required, audited with old/new, bumps rev, returns the board)
create or replace function public.rw_board_lock(p_board uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards; why text;
begin
  perform public.rw_require_super('lock a board');
  why := public.rw_need_reason(p_reason);
  b := public.rw_lock_board(p_board);
  if b.state <> 'locked' then
    update public.rw_boards set state = 'locked', rev = rev + 1, updated_at = now() where id = b.id;
    perform public.rw_board_log(auth.uid(), 'lock', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'reason', why, 'from', b.state, 'to', 'locked'));
  end if;
  return public.rw_admin_board_json(b.id);
end $$;

create or replace function public.rw_board_unlock(p_board uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards; why text;
begin
  perform public.rw_require_super('unlock a board');
  why := public.rw_need_reason(p_reason);
  b := public.rw_lock_board(p_board);
  if b.state <> 'open' then
    update public.rw_boards set state = 'open', rev = rev + 1, updated_at = now() where id = b.id;
    perform public.rw_board_log(auth.uid(), 'unlock', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'reason', why, 'from', b.state, 'to', 'open'));
  end if;
  return public.rw_admin_board_json(b.id);
end $$;

-- Switching the mode changes the mode and nothing else: the existing selections keep the `exclusive` flag they were claimed with.
create or replace function public.rw_board_set_mode(p_board uuid, p_mode text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards; why text;
begin
  perform public.rw_require_super('change the mode of a board');
  why := public.rw_need_reason(p_reason);
  if p_mode is null or p_mode not in ('exclusive', 'shared') then raise exception 'BAD_RULE: the mode must be exclusive or shared'; end if;
  b := public.rw_lock_board(p_board);
  if b.mode <> p_mode then
    update public.rw_boards set mode = p_mode, rev = rev + 1, updated_at = now() where id = b.id;
    perform public.rw_board_log(auth.uid(), 'set_mode', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'reason', why, 'from', b.mode, 'to', p_mode));
  end if;
  return public.rw_admin_board_json(b.id);
end $$;

create or replace function public.rw_release_selection(p_selection uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards; s public.rw_selections; bid uuid; owner uuid; why text; pr text;
begin
  perform public.rw_require_super('release a number');
  why := public.rw_need_reason(p_reason);
  select board_id, profile_id into bid, owner from public.rw_selections where id = p_selection;      -- (the owner of a selection never changes)
  if not found then raise exception 'NOT_FOUND'; end if;
  perform public.rw_lock_profiles(array[owner]);                                                    -- lock order: the owner's customer lock, then the board, then the right
  b := public.rw_lock_board(bid);
  perform public.rw_sweep_board(b.id);
  select * into s from public.rw_selections where id = p_selection for update;
  if s.status not in ('reserved', 'confirmed') then raise exception 'NOT_FOUND: this number is not held any more'; end if;
  update public.rw_selections set status = 'released', ended_at = now(), ended_by = auth.uid(), end_reason = why where id = s.id;
  pr := public.rw_return_pick(s.entitlement_id, s.id);
  update public.rw_selections set pick_returned = pr where id = s.id;
  update public.rw_boards set rev = rev + 1, updated_at = now() where id = b.id;
  perform public.rw_board_log(auth.uid(), 'release', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'reason', why, 'selection_id', s.id,
    'number', s.number, 'profile_id', s.profile_id, 'was', s.status, 'pick_returned', pr));
  return public.rw_admin_board_json(b.id);
end $$;

create or replace function public.rw_board_reset(p_board uuid, p_reason text, p_return_picks boolean, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards; why text; rid uuid := gen_random_uuid(); n integer; s public.rw_selections; pr text; ret boolean := coalesce(p_return_picks, false); owner uuid;
begin
  perform public.rw_require_super('reset a board');
  why := public.rw_need_reason(p_reason);
  -- lock order: the customer locks of everyone who holds a number here (in id order), then the board, then the rights
  perform public.rw_lock_profiles((select array_agg(distinct profile_id) from public.rw_selections where board_id = p_board and status in ('reserved', 'confirmed')));
  b := public.rw_lock_board(p_board);
  if p_confirm is distinct from b.name then raise exception 'CONFIRM_MISMATCH'; end if;
  -- a customer who picked a number between the read above and the board lock is not locked yet; never WAIT for them while holding the board (that is the wrong order): ask once and
  -- say "try again" if they are in the middle of something
  for owner in select distinct profile_id from public.rw_selections where board_id = b.id and status in ('reserved', 'confirmed') loop
    if not pg_try_advisory_xact_lock(hashtextextended('rw:' || owner::text, 0)) then
      raise exception 'RESET_CONFLICT: a customer is picking a number on this board right now, try again'; end if;
  end loop;
  perform public.rw_sweep_board(b.id);                                                              -- a lapsed hold is expired, not reset
  select count(*) into n from public.rw_selections where board_id = b.id and status in ('reserved', 'confirmed');
  insert into public.rw_board_resets (id, board_id, event_id, by_profile, reason, returned_picks, affected) values (rid, b.id, b.event_id, auth.uid(), why, ret, n);
  for s in select * from public.rw_selections where board_id = b.id and status in ('reserved', 'confirmed') order by entitlement_id, id for update loop
    update public.rw_selections set status = 'reset', status_before_reset = s.status, reset_id = rid, ended_at = now(), ended_by = auth.uid(), end_reason = why where id = s.id;
    if ret then
      pr := public.rw_return_pick(s.entitlement_id, s.id);
      update public.rw_selections set pick_returned = pr where id = s.id;
    end if;
  end loop;
  update public.rw_boards set rev = rev + 1, updated_at = now() where id = b.id;
  perform public.rw_board_log(auth.uid(), 'reset', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'reason', why, 'reset_id', rid, 'affected', n, 'returned_picks', ret));
  return public.rw_admin_board_json(b.id);
end $$;

-- Undo restores exactly the rows that reset cleared, but only if every number is still free and every returned right is still where the reset left it; otherwise RESET_CONFLICT
-- and nothing changes. A hold that lapsed while the board was reset is not brought back: it becomes 'expired' (its pick is returned if the reset had not already).
create or replace function public.rw_board_undo_reset(p_reset uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rs public.rw_board_resets; b public.rw_boards; ev public.rw_events; s public.rw_selections; e public.rw_entitlements; why text; bid uuid; restored integer := 0; lapsed integer := 0; pr text;
begin
  perform public.rw_require_super('undo a reset');
  why := public.rw_need_reason(p_reason);
  select board_id into bid from public.rw_board_resets where id = p_reset;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform public.rw_lock_profiles((select array_agg(distinct profile_id) from public.rw_selections where reset_id = p_reset));      -- lock order: customers, then the board, then the rights
  b := public.rw_lock_board(bid);
  select * into rs from public.rw_board_resets where id = p_reset for update;
  if rs.undone_at is not null then raise exception 'RESET_CONFLICT: this reset was already undone'; end if;
  select * into ev from public.rw_events where id = b.event_id;
  for s in select * from public.rw_selections where reset_id = p_reset and status = 'reset' order by entitlement_id, id for update loop
    if s.status_before_reset = 'reserved' and s.expires_at <= now() then continue; end if;
    if s.number < ev.number_min or s.number > ev.number_max then raise exception 'RESET_CONFLICT: number % is outside the number range now', s.number; end if;
    if exists (select 1 from public.rw_selections o where o.board_id = s.board_id and o.number = s.number and o.id <> s.id and o.status in ('reserved', 'confirmed')
                 and (s.exclusive or o.exclusive or o.profile_id = s.profile_id)) then
      raise exception 'RESET_CONFLICT: number % has been taken since', s.number;
    end if;
    select * into e from public.rw_entitlements where id = s.entitlement_id for update;
    if not found
       or (s.pick_returned = 'available' and not (e.status = 'available' and e.used_selection_id is null))
       or (s.pick_returned = 'revoked' and not (e.status = 'revoked' and e.revoked_reason = 'BILL_TAKEN_BACK'))
       or (s.pick_returned is null and not (e.status = 'used' and e.used_selection_id = s.id)) then
      raise exception 'RESET_CONFLICT: the pick of number % has been used elsewhere since', s.number;
    end if;
  end loop;
  for s in select * from public.rw_selections where reset_id = p_reset and status = 'reset' order by entitlement_id, id for update loop
    if s.status_before_reset = 'reserved' and s.expires_at <= now() then
      pr := s.pick_returned;
      if pr is null then pr := public.rw_return_pick(s.entitlement_id, s.id); end if;
      update public.rw_selections set status = 'expired', ended_at = now(), end_reason = 'hold expired while the board was reset', pick_returned = pr where id = s.id;
      lapsed := lapsed + 1;
    else
      update public.rw_selections set status = s.status_before_reset, ended_at = null, ended_by = null, end_reason = null, pick_returned = null where id = s.id;
      if s.pick_returned = 'available' then
        update public.rw_entitlements set status = 'used', used_selection_id = s.id where id = s.entitlement_id;
      elsif s.pick_returned = 'revoked' then
        update public.rw_entitlements set status = 'used', used_selection_id = s.id, revoked_reason = null, revoked_at = null, needs_review = true, review_since = now() where id = s.entitlement_id;
      end if;
      restored := restored + 1;
    end if;
  end loop;
  update public.rw_board_resets set undone_at = now(), undone_by = auth.uid(), undo_reason = why where id = rs.id;
  update public.rw_boards set rev = rev + 1, updated_at = now() where id = b.id;
  perform public.rw_board_log(auth.uid(), 'undo_reset', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'reason', why, 'reset_id', rs.id,
    'restored', restored, 'lapsed', lapsed));
  return public.rw_admin_board_json(b.id);
end $$;

-- ---------------------------------------------------------------------------------------------- hooks the core migration leaves empty ("create or replace there")
-- My numbers, as rw_my_rewards() lists them: active only (a lapsed hold is not mine any more), no identities of anyone else.
create or replace function public.rw_selections_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'event_id', s.event_id, 'board_id', s.board_id, 'board_name', b.name, 'number', s.number, 'status', s.status, 'expires_at', s.expires_at)
                           order by s.created_at, s.id), '[]'::jsonb)
  from public.rw_selections s join public.rw_boards b on b.id = s.board_id
  -- every event the customer has a live number in, whatever its status: a paused or CLOSED event must not hide the numbers they hold
  where s.profile_id = p_profile and (s.status = 'confirmed' or (s.status = 'reserved' and s.expires_at > now())) $$;

-- What the staff review queue shows for the number behind a right whose bill was taken back (any status of the selection: it may have been released since).
create or replace function public.rw_review_selection_info(p_selection uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('board_name', b.name, 'number', s.number) from public.rw_selections s join public.rw_boards b on b.id = s.board_id where s.id = p_selection $$;

-- Called by rw_admin_resolve_review('release') AFTER it revoked the right (so the right is already gone: nothing to give back). Frees the number, audited like any release.
create or replace function public.rw_release_selection_for_review(p_selection uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b public.rw_boards; s public.rw_selections; bid uuid; why text := left(btrim(coalesce(p_reason, '')), 500);
begin
  select board_id into bid from public.rw_selections where id = p_selection;
  if not found then return; end if;
  b := public.rw_lock_board(bid);
  select * into s from public.rw_selections where id = p_selection for update;
  if s.status not in ('reserved', 'confirmed') then return; end if;
  update public.rw_selections set status = 'released', ended_at = now(), ended_by = auth.uid(), end_reason = why, pick_returned = 'revoked' where id = s.id;
  update public.rw_boards set rev = rev + 1, updated_at = now() where id = b.id;
  perform public.rw_board_log(auth.uid(), 'release', 'board', b.id, jsonb_build_object('event_id', b.event_id, 'board_id', b.id, 'board', b.name, 'reason', why, 'selection_id', s.id,
    'number', s.number, 'profile_id', s.profile_id, 'was', s.status, 'pick_returned', 'revoked', 'via', 'review'));
end $$;

-- ---------------------------------------------------------------------------------------------- RLS and grants
alter table public.rw_events enable row level security;
alter table public.rw_boards enable row level security;
alter table public.rw_selections enable row level security;
alter table public.rw_board_resets enable row level security;
revoke all on public.rw_events, public.rw_boards, public.rw_selections, public.rw_board_resets from public, anon, authenticated;

-- Functions: nothing for anon; the internal ones are not callable by clients at all; the client API is granted to authenticated.
do $$ declare f text; begin
  foreach f in array array[
    'rw_events_guard()', 'rw_boards_guard()', 'rw_events_make_boards()', 'rw_resets_guard()', 'rw_selections_guard()', 'rw_selections_mixed()',
    'rw_boards_live()', 'rw_person_name(uuid)', 'rw_current_event()', 'rw_need_reason(text)', 'rw_board_log(uuid, text, text, uuid, jsonb)', 'rw_lock_board(uuid)',
    'rw_selection_json(public.rw_selections)', 'rw_event_rights(uuid, uuid)', 'rw_board_json(uuid)', 'rw_board_view(uuid, uuid)', 'rw_event_json(uuid)', 'rw_admin_board_json(uuid)',
    'rw_return_pick(uuid, uuid)', 'rw_sweep_board(uuid)', 'rw_settle_quiet(uuid, text)', 'rw_lock_profiles(uuid[])', 'rw_selections_json(uuid)', 'rw_review_selection_info(uuid)', 'rw_release_selection_for_review(uuid, text)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'rw_board_rev(uuid)', 'rw_board_state(uuid)', 'rw_claim_number(uuid, uuid, integer, text)', 'rw_confirm_selection(uuid)',
    'rw_admin_events()', 'rw_admin_save_event(uuid, jsonb)', 'rw_admin_set_event_status(uuid, text, text)', 'rw_admin_save_board(uuid, jsonb)', 'rw_admin_board(uuid)',
    'rw_admin_log(uuid, integer, integer)', 'rw_sweep_holds(uuid)', 'rw_board_lock(uuid, text)', 'rw_board_unlock(uuid, text)', 'rw_board_set_mode(uuid, text, text)',
    'rw_release_selection(uuid, text)', 'rw_board_reset(uuid, text, boolean, text)', 'rw_board_undo_reset(uuid, text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
