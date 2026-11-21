-- Rewards core (server-side): points, promotion packs, per-bill board picks, one settle function that reconciles them with what is currently paid.
--
-- Principles
--   * Additive and dark. New tables and functions only; nothing existing is changed except three AFTER triggers (finance_receipts, finance_allocations,
--     shop_orders) that only call the settle function. rw_settings.enabled = false (the default) makes every one of them return at once, so the live
--     system behaves exactly as before. Price, total, invoice and receipt of an order are never touched by anything here.
--   * Rewards are a pure function of money: points and board-pick rights are recomputed from "this bill is fully paid (finance_invoice_state_raw 5/6) and
--     not cancelled / returned" and written as differences to append-only rows. A repeated, parallel or retried settle therefore creates nothing new, and a
--     reversed payment, a cancellation or a return takes back what that bill gave.
--   * PER BILL: a bill earns floor(eligible bill amount / spend_step) x reward_amount, in numeric arithmetic (299.99 -> 0, 300.00 -> 1). Bills are never
--     combined. Rights are one row per (rule, bill, seq), UNIQUE, so no code path can create a second right for the same bill and place in the sequence.
--   * A reward error must never block a payment: the triggers call settle inside an exception block, log 'settle_error' and carry on.
--   * Settle only READS invoices, receipts and orders (no row lock on them), so it cannot deadlock with the payment functions. Its one lock is an advisory
--     lock per customer. The reward tables therefore keep NO foreign key to shop_orders (a foreign-key check would take a row lock on the order).
--   * Rows of the ledger, the audit log and the rights are never deleted or edited in place (guard triggers). Rules are never deleted.
--   * Every function is SECURITY DEFINER with search_path = public; clients get EXECUTE only on the functions they call, every table has RLS and no policy.
--
-- Rollback: supabase/rollbacks/20261121100000_rewards_core_down.sql (refuses once any ledger or right row exists).

-- ====================================================================================================================== 1 helpers
create or replace function public.rw_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role in ('ADMIN', 'SUPER_ADMIN')) $$;
create or replace function public.rw_is_super()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.role = 'SUPER_ADMIN') $$;
create or replace function public.rw_require_staff(p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
begin if not public.rw_is_staff() then raise exception 'You are not allowed to %', p_what using errcode = '42501'; end if; end $$;
create or replace function public.rw_require_super(p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
begin if not public.rw_is_super() then raise exception 'You are not allowed to % (Super Admin only)', p_what using errcode = '42501'; end if; end $$;

-- strict readers of JSON values (the patches come from the browser): a whole number, money in baht and satang, a list of texts
create or replace function public.rw_j_whole(p jsonb, p_field text, p_min integer, p_code text default 'BAD_RULE')
returns integer language plpgsql immutable security definer set search_path = public as $$
begin
  if jsonb_typeof(p) is distinct from 'number' or (p #>> '{}')::numeric <> trunc((p #>> '{}')::numeric) or (p #>> '{}')::numeric < p_min or (p #>> '{}')::numeric > 1000000 then
    raise exception '%: % must be a whole number, at least %', p_code, p_field, p_min; end if;
  return (p #>> '{}')::integer;
end $$;
create or replace function public.rw_j_money(p jsonb, p_field text, p_code text default 'BAD_RULE')
returns numeric language plpgsql immutable security definer set search_path = public as $$
begin
  if jsonb_typeof(p) is distinct from 'number' or (p #>> '{}')::numeric <= 0 or (p #>> '{}')::numeric <> round((p #>> '{}')::numeric, 2) or (p #>> '{}')::numeric > 10000000 then
    raise exception '%: % must be an amount in baht and satang, more than 0', p_code, p_field; end if;
  return (p #>> '{}')::numeric;
end $$;
create or replace function public.rw_j_texts(p jsonb, p_field text, p_code text default 'BAD_RULE')
returns text[] language plpgsql immutable security definer set search_path = public as $$
declare r text[];
begin
  if jsonb_typeof(p) = 'null' then return '{}'::text[]; end if;
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) > 200 or exists (select 1 from jsonb_array_elements(p) e where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 80) then
    raise exception '%: % must be a list of codes', p_code, p_field; end if;
  select coalesce(array_agg(x order by o), '{}') into r from (select distinct on (btrim(e #>> '{}')) btrim(e #>> '{}') x, o from jsonb_array_elements(p) with ordinality t(e, o) order by btrim(e #>> '{}'), o) z;
  return r;
end $$;

-- ====================================================================================================================== 2 tables
create table public.rw_settings (
  id boolean primary key default true check (id),                          -- a single row
  enabled boolean not null default false,                                  -- master switch: false = nothing in this feature has any effect
  boards_enabled boolean not null default false,                           -- the event boards (used by the next migration)
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.rw_settings (id) values (true);

create table public.promo_packs (
  pack_sku_code text primary key references public.sku_registry (sku_code) on update cascade on delete restrict,
  active boolean not null default true,                                    -- only controls the admin lists: settle recognises a pack by being in this table
  eligible_value numeric(14, 2) constraint promo_packs_eligible_chk check (eligible_value is null or eligible_value > 0),   -- null = the price paid
  points_per_pack integer constraint promo_packs_points_chk check (points_per_pack is null or points_per_pack >= 0),       -- null = follow the rules, 0 = earns no points
  created_by uuid, created_at timestamptz not null default now(), updated_by uuid, updated_at timestamptz not null default now()
);
create table public.promo_pack_items (
  pack_sku_code text not null references public.promo_packs (pack_sku_code) on update cascade on delete restrict,
  component_sku_code text not null references public.sku_registry (sku_code) on update cascade on delete restrict,
  qty integer not null check (qty between 1 and 999),
  primary key (pack_sku_code, component_sku_code),
  check (pack_sku_code <> component_sku_code)
);
create index promo_pack_items_component_idx on public.promo_pack_items (component_sku_code);

create table public.rw_rules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('points', 'board_pick')),
  name text not null check (length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  starts_at timestamptz, ends_at timestamptz,                              -- checked against the order's creation time
  spend_step numeric(14, 2) not null constraint rw_rules_spend_step_chk check (spend_step > 0),
  reward_amount integer not null constraint rw_rules_reward_chk check (reward_amount >= 1),
  basis text not null default 'per_bill' check (basis in ('per_bill', 'cumulative')),
  max_per_order integer constraint rw_rules_max_chk check (max_per_order is null or max_per_order >= 1),
  category_codes text[] not null default '{}', include_skus text[] not null default '{}', exclude_skus text[] not null default '{}',
  include_packs boolean not null default false,
  only_profile_ids uuid[] check (only_profile_ids is null or cardinality(only_profile_ids) > 0),   -- null = everyone
  event_id uuid,                                                           -- board_pick only; the foreign key to rw_events is added by the event-boards migration
  board_slots integer[] check (board_slots is null or (cardinality(board_slots) > 0 and board_slots <@ array[1, 2, 3])),
  created_by uuid, created_at timestamptz not null default now(), updated_by uuid, updated_at timestamptz not null default now(),
  check (kind = 'points' or basis = 'per_bill'),                           -- bills are never combined for number picks
  check (kind = 'board_pick' or (event_id is null and board_slots is null)),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

create table public.rw_points_ledger (                                     -- append-only; the balance is the sum
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  points integer not null check (points <> 0),
  kind text not null check (kind in ('earn', 'reverse', 'adjust')),
  source_key text not null,                                                -- 'rule:<rule id>' | 'pack:<pack sku>' | 'adjust'
  rule_id uuid references public.rw_rules (id) on delete restrict,
  order_id uuid,                                                           -- no foreign key on purpose (see the header); null for cumulative rules and adjustments
  note text,
  created_by uuid, created_at timestamptz not null default now(),
  check ((kind = 'earn' and points > 0) or (kind = 'reverse' and points < 0) or kind = 'adjust')
);
create index rw_points_ledger_profile_idx on public.rw_points_ledger (profile_id, source_key, order_id);
create index rw_points_ledger_rule_idx on public.rw_points_ledger (rule_id) where rule_id is not null;

create table public.rw_entitlements (                                      -- one row = one right to pick a number
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.rw_rules (id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  event_id uuid,                                                           -- plain uuid here; the event-boards migration adds the foreign key
  source_order_id uuid not null,                                           -- the bill (no foreign key on purpose, see the header)
  seq integer not null check (seq >= 1),
  status text not null default 'available' check (status in ('available', 'used', 'revoked')),
  used_selection_id uuid,                                                  -- set by the event-boards migration's claim
  revoked_reason text, revoked_at timestamptz,
  needs_review boolean not null default false,                             -- a USED right whose bill was taken back: a Super Admin decides
  review_since timestamptz,
  kept boolean not null default false,                                     -- a Super Admin decided to keep it: settle never flags or revokes it again
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint rw_entitlements_once unique (rule_id, source_order_id, seq),
  check (not needs_review or status = 'used')
);
create index rw_entitlements_profile_idx on public.rw_entitlements (profile_id, rule_id, status);
create index rw_entitlements_review_idx on public.rw_entitlements (review_since) where needs_review;

create table public.rw_events_log (                                        -- append-only audit of every reward and board action
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  action text not null,
  entity text, entity_id text,
  event_id uuid, board_id uuid, profile_id uuid,
  reason text,
  detail jsonb not null default '{}'::jsonb
);
create index rw_events_log_event_idx on public.rw_events_log (event_id, id desc) where event_id is not null;
create index rw_events_log_action_idx on public.rw_events_log (action, id desc);

-- The eligible amount of a bill for a rule, written ONCE by the first settle that counts the bill (an active rule, a paid bill). From then on that bill's rewards come from
-- this number, so a later change of the catalogue (a SKU's product type, status or price) can never revoke or grant rewards for a bill that was already counted.
-- Like the ledger it is append-only; there is no foreign key to shop_orders (a foreign-key check would lock the order row, see the header).
create table public.rw_bill_eligible (
  rule_id uuid not null references public.rw_rules (id) on delete restrict,
  order_id uuid not null,
  eligible_amount numeric(14, 2) not null check (eligible_amount >= 0),
  at timestamptz not null default now(),
  primary key (rule_id, order_id)
);

-- no client may read or write any of them: the browser only ever calls the functions below
do $$ declare t text; begin
  foreach t in array array['rw_settings', 'promo_packs', 'promo_pack_items', 'rw_rules', 'rw_points_ledger', 'rw_entitlements', 'rw_events_log', 'rw_bill_eligible'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.rw_points_ledger_id_seq, public.rw_events_log_id_seq from public, anon, authenticated;

-- ====================================================================================================================== 3 guards
create or replace function public.rw_no_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin raise exception 'Reward ledger, rights and audit rows are never deleted or edited in place (add a correcting row instead)'; end $$;
create trigger rw_points_ledger_guard before update or delete on public.rw_points_ledger for each row execute function public.rw_no_change();
create trigger rw_points_ledger_no_truncate before truncate on public.rw_points_ledger for each statement execute function public.rw_no_change();
create trigger rw_bill_eligible_guard before update or delete on public.rw_bill_eligible for each row execute function public.rw_no_change();
create trigger rw_bill_eligible_no_truncate before truncate on public.rw_bill_eligible for each statement execute function public.rw_no_change();
create trigger rw_events_log_guard before update or delete on public.rw_events_log for each row execute function public.rw_no_change();
create trigger rw_events_log_no_truncate before truncate on public.rw_events_log for each statement execute function public.rw_no_change();
create trigger rw_entitlements_no_delete before delete on public.rw_entitlements for each row execute function public.rw_no_change();
create trigger rw_entitlements_no_truncate before truncate on public.rw_entitlements for each statement execute function public.rw_no_change();

create or replace function public.rw_guard_entitlement()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.rule_id is distinct from old.rule_id or new.profile_id is distinct from old.profile_id or new.source_order_id is distinct from old.source_order_id
     or new.seq is distinct from old.seq or new.event_id is distinct from old.event_id or new.created_at is distinct from old.created_at then
    raise exception 'A right''s rule, owner, bill and place cannot be changed'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger rw_entitlements_guard before update on public.rw_entitlements for each row execute function public.rw_guard_entitlement();

-- a rule is "used" once any ledger or right row references it
create or replace function public.rw_rule_used(p_rule uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rw_points_ledger where rule_id = p_rule) or exists (select 1 from public.rw_entitlements where rule_id = p_rule) $$;

create or replace function public.rw_guard_rule()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Rules are never deleted: switch the rule off instead'; end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.created_at is distinct from old.created_at then
    raise exception 'BAD_RULE: the kind of a rule cannot change: duplicate the rule instead'; end if;
  if public.rw_rule_used(old.id) then
    -- clarification 2: only the name, the on/off switch and an EXTENDED end stay editable (max_per_order is frozen too: it changes what a bill earns)
    if (new.spend_step, new.reward_amount, new.basis, new.max_per_order, new.category_codes, new.include_skus, new.exclude_skus, new.include_packs, new.only_profile_ids, new.event_id, new.board_slots, new.starts_at)
       is distinct from (old.spend_step, old.reward_amount, old.basis, old.max_per_order, old.category_codes, old.include_skus, old.exclude_skus, old.include_packs, old.only_profile_ids, old.event_id, old.board_slots, old.starts_at)
       or (new.ends_at is distinct from old.ends_at and new.ends_at is not null and (old.ends_at is null or new.ends_at < old.ends_at)) then
      raise exception 'BAD_RULE: RULE_USED'; end if;
  end if;
  return new;
end $$;
create trigger rw_rules_guard before update or delete on public.rw_rules for each row execute function public.rw_guard_rule();

-- Switching a rule on (also draft -> active) restarts its window at that moment: bills created while the rule was off must never earn after it is switched on again.
-- Triggers of one event run in name order, so this runs AFTER rw_rules_guard (the guard has already judged the edit; the stamp is the system's own change).
create or replace function public.rw_stamp_rule_activation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.active and not old.active then new.starts_at := greatest(coalesce(new.starts_at, now()), now()); end if;
  return new;
end $$;
create trigger rw_rules_stamp before update on public.rw_rules for each row execute function public.rw_stamp_rule_activation();

-- packs: never deleted; the contents of a pack that has been sold are frozen; a pack cannot contain a pack
create or replace function public.rw_pack_sold(p_sku text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shop_order_items where sku_code = p_sku) $$;

create or replace function public.rw_guard_pack()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'BAD_PACK: a pack is never deleted: switch it off instead'; end if;
  if tg_op = 'INSERT' then
    if (select sku_category from public.sku_registry where sku_code = new.pack_sku_code) is distinct from 'FG' then raise exception 'BAD_PACK: a pack is a finished-goods SKU'; end if;
    if exists (select 1 from public.promo_pack_items where component_sku_code = new.pack_sku_code) then raise exception 'BAD_PACK: this SKU is part of another pack'; end if;
    return new;
  end if;
  if new.pack_sku_code is distinct from old.pack_sku_code then raise exception 'BAD_PACK: the code of a pack cannot change'; end if;
  if public.rw_pack_sold(old.pack_sku_code) and (new.eligible_value is distinct from old.eligible_value or new.points_per_pack is distinct from old.points_per_pack) then
    raise exception 'BAD_PACK: this pack has been sold, so its eligible value and points are locked (create a new pack instead)'; end if;
  return new;
end $$;
create trigger rw_packs_guard before insert or update or delete on public.promo_packs for each row execute function public.rw_guard_pack();

create or replace function public.rw_guard_pack_item()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pack text := coalesce(new.pack_sku_code, old.pack_sku_code);
begin
  if public.rw_pack_sold(v_pack) then raise exception 'BAD_PACK: this pack has been sold, so its contents are locked (create a new pack instead)'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if exists (select 1 from public.promo_packs where pack_sku_code = new.component_sku_code) then raise exception 'BAD_PACK: a pack cannot contain another pack'; end if;
  if (select sku_category from public.sku_registry where sku_code = new.component_sku_code) is distinct from 'FG' then raise exception 'BAD_PACK: only finished goods can be in a pack'; end if;
  return new;
end $$;
create trigger rw_pack_items_guard before insert or update or delete on public.promo_pack_items for each row execute function public.rw_guard_pack_item();

-- ====================================================================================================================== 4 audit helper
create or replace function public.rw_log(p_action text, p_entity text, p_entity_id text, p_profile uuid, p_reason text, p_detail jsonb,
  p_event uuid default null, p_board uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into public.rw_events_log (action, entity, entity_id, profile_id, reason, detail, event_id, board_id)
  values (p_action, p_entity, p_entity_id, p_profile, p_reason, coalesce(p_detail, '{}'::jsonb), p_event, p_board) $$;

-- ====================================================================================================================== 5 settings
create or replace function public.rw_settings_public()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_user();
  return (select jsonb_build_object('enabled', s.enabled, 'boards_enabled', s.boards_enabled) from public.rw_settings s where s.id);
end $$;

create or replace function public.rw_admin_save_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text; cur public.rw_settings; r public.rw_settings;
begin
  perform public.rw_require_super('change the rewards master switch');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_RULE: nothing to save'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('enabled', 'boards_enabled') then raise exception 'BAD_RULE: unknown setting %', k; end if;
    if jsonb_typeof(p_patch -> k) <> 'boolean' then raise exception 'BAD_RULE: % must be true or false', k; end if;
  end loop;
  select * into cur from public.rw_settings where id for update;
  update public.rw_settings set enabled = coalesce((p_patch ->> 'enabled')::boolean, enabled), boards_enabled = coalesce((p_patch ->> 'boards_enabled')::boolean, boards_enabled),
    updated_by = auth.uid(), updated_at = now() where id returning * into r;
  perform public.rw_log('settings.save', 'settings', 'rewards', null, null, jsonb_build_object('patch', p_patch, 'before', jsonb_build_object('enabled', cur.enabled, 'boards_enabled', cur.boards_enabled)));
  return jsonb_build_object('enabled', r.enabled, 'boards_enabled', r.boards_enabled);
end $$;

-- ====================================================================================================================== 6 rules
create or replace function public.rw_rule_json(r public.rw_rules)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'kind', r.kind, 'name', r.name, 'active', r.active, 'starts_at', r.starts_at, 'ends_at', r.ends_at,
    'spend_step', r.spend_step, 'reward_amount', r.reward_amount, 'basis', r.basis, 'max_per_order', r.max_per_order,
    'category_codes', to_jsonb(r.category_codes), 'include_skus', to_jsonb(r.include_skus), 'exclude_skus', to_jsonb(r.exclude_skus), 'include_packs', r.include_packs,
    'only_profile_ids', to_jsonb(r.only_profile_ids), 'event_id', r.event_id, 'board_slots', to_jsonb(r.board_slots),
    'stats', jsonb_build_object(
      'bills', case when r.kind = 'points'
                 then (select count(*) from (select l.order_id from public.rw_points_ledger l where l.rule_id = r.id and l.order_id is not null group by l.order_id having sum(l.points) > 0) z)
                 else (select count(distinct e.source_order_id) from public.rw_entitlements e where e.rule_id = r.id and e.status in ('available', 'used')) end,
      'granted', case when r.kind = 'points' then coalesce((select sum(l.points) from public.rw_points_ledger l where l.rule_id = r.id), 0)
                 else (select count(*) from public.rw_entitlements e where e.rule_id = r.id and e.status in ('available', 'used')) end)) $$;

create or replace function public.rw_admin_rules()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.rw_require_staff('see the reward rules');
  return coalesce((select jsonb_agg(public.rw_rule_json(r) order by r.created_at, r.id) from public.rw_rules r), '[]'::jsonb);
end $$;

-- every SKU in an include list must exist, be active and be a finished good
create or replace function public.rw_check_include_skus(p_skus text[])
returns void language plpgsql stable security definer set search_path = public as $$
declare c text; s public.sku_registry;
begin
  foreach c in array coalesce(p_skus, '{}') loop
    select * into s from public.sku_registry where sku_code = c;
    if not found or s.status <> 'active' then raise exception 'INACTIVE_SKU: %', c; end if;
    if s.sku_category <> 'FG' then raise exception 'BAD_RULE: % is not a finished good', c; end if;
  end loop;
end $$;

create or replace function public.rw_admin_save_rule(p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cur public.rw_rules; r public.rw_rules; k text; v jsonb; ids uuid[]; u text; bad text;
        allowed text[] := array['kind', 'name', 'active', 'starts_at', 'ends_at', 'spend_step', 'reward_amount', 'basis', 'max_per_order', 'category_codes', 'include_skus',
                                'exclude_skus', 'include_packs', 'only_profile_ids', 'event_id', 'board_slots'];
begin
  perform public.rw_require_staff('change reward rules');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_RULE: nothing to save'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (allowed)) then raise exception 'BAD_RULE: unknown field %', k; end if;
  end loop;
  if p_id is null then
    r.id := gen_random_uuid(); r.active := true; r.basis := 'per_bill'; r.include_packs := false;
    r.category_codes := '{}'; r.include_skus := '{}'; r.exclude_skus := '{}';
    if not (p_patch ? 'kind') then raise exception 'BAD_RULE: choose the kind of rule'; end if;
  else
    select * into cur from public.rw_rules where id = p_id for no key update;
    if not found then raise exception 'NOT_FOUND'; end if;
    r := cur;
  end if;

  if p_patch ? 'kind' then
    if jsonb_typeof(p_patch -> 'kind') <> 'string' or (p_patch ->> 'kind') not in ('points', 'board_pick') then raise exception 'BAD_RULE: the kind must be points or board_pick'; end if;
    if cur.id is not null and (p_patch ->> 'kind') <> cur.kind then raise exception 'BAD_RULE: the kind of a rule cannot change: duplicate the rule instead'; end if;
    r.kind := p_patch ->> 'kind';
  end if;
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch -> 'name') <> 'string' or length(btrim(p_patch ->> 'name')) not between 1 and 80 then raise exception 'BAD_RULE: give the rule a name (80 characters at most)'; end if;
    r.name := btrim(p_patch ->> 'name');
  end if;
  if p_patch ? 'active' then
    if jsonb_typeof(p_patch -> 'active') <> 'boolean' then raise exception 'BAD_RULE: active must be true or false'; end if;
    r.active := (p_patch ->> 'active')::boolean;
  end if;
  if p_patch ? 'include_packs' then
    if jsonb_typeof(p_patch -> 'include_packs') <> 'boolean' then raise exception 'BAD_RULE: include_packs must be true or false'; end if;
    r.include_packs := (p_patch ->> 'include_packs')::boolean;
  end if;
  foreach k in array array['starts_at', 'ends_at'] loop
    if p_patch ? k then
      v := p_patch -> k;
      if jsonb_typeof(v) = 'null' then
        if k = 'starts_at' then r.starts_at := null; else r.ends_at := null; end if;
      elsif jsonb_typeof(v) = 'string' then
        begin
          if k = 'starts_at' then r.starts_at := (v #>> '{}')::timestamptz; else r.ends_at := (v #>> '{}')::timestamptz; end if;
        exception when others then raise exception 'BAD_RULE: % is not a date and time', k; end;
      else raise exception 'BAD_RULE: % is not a date and time', k; end if;
    end if;
  end loop;
  if r.starts_at is null then r.starts_at := now(); end if;          -- clarification 1: a rule never reaches back to older bills unless staff choose an earlier start
  if p_patch ? 'spend_step' then r.spend_step := public.rw_j_money(p_patch -> 'spend_step', 'the amount per step'); end if;
  if p_patch ? 'reward_amount' then r.reward_amount := public.rw_j_whole(p_patch -> 'reward_amount', 'the reward', 1); end if;
  if p_patch ? 'max_per_order' then
    r.max_per_order := case when jsonb_typeof(p_patch -> 'max_per_order') = 'null' then null else public.rw_j_whole(p_patch -> 'max_per_order', 'the limit per bill', 1) end;
  end if;
  if p_patch ? 'basis' then
    if jsonb_typeof(p_patch -> 'basis') <> 'string' or (p_patch ->> 'basis') not in ('per_bill', 'cumulative') then raise exception 'BAD_RULE: basis must be per_bill or cumulative'; end if;
    r.basis := p_patch ->> 'basis';
  end if;
  if p_patch ? 'category_codes' then r.category_codes := public.rw_j_texts(p_patch -> 'category_codes', 'the categories'); end if;
  if p_patch ? 'exclude_skus' then r.exclude_skus := public.rw_j_texts(p_patch -> 'exclude_skus', 'the excluded SKUs'); end if;
  if p_patch ? 'include_skus' then
    r.include_skus := public.rw_j_texts(p_patch -> 'include_skus', 'the included SKUs');
    if cur.id is null or r.include_skus is distinct from cur.include_skus then perform public.rw_check_include_skus(r.include_skus); end if;
  end if;
  if p_patch ? 'only_profile_ids' then
    v := p_patch -> 'only_profile_ids';
    if jsonb_typeof(v) = 'null' then r.only_profile_ids := null;
    else
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) = 0 or jsonb_array_length(v) > 500
         or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        raise exception 'BAD_RULE: the customer list must be a non-empty list of customer ids (use null for everyone)'; end if;
      select array_agg(distinct (e #>> '{}')::uuid) into ids from jsonb_array_elements(v) e;
      select string_agg(x::text, ', ') into bad from unnest(ids) x where not exists (select 1 from public.profiles p where p.id = x);
      if bad is not null then raise exception 'BAD_RULE: not a customer: %', bad; end if;
      r.only_profile_ids := ids;
    end if;
  end if;
  if p_patch ? 'event_id' then
    if jsonb_typeof(p_patch -> 'event_id') = 'null' then r.event_id := null;
    elsif jsonb_typeof(p_patch -> 'event_id') = 'string' and (p_patch ->> 'event_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then r.event_id := (p_patch ->> 'event_id')::uuid;
    else raise exception 'BAD_RULE: event_id is not an id'; end if;
  end if;
  if p_patch ? 'board_slots' then
    v := p_patch -> 'board_slots';
    if jsonb_typeof(v) = 'null' then r.board_slots := null;
    else
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 3 or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'number' or (e #>> '{}') not in ('1', '2', '3')) then
        raise exception 'BAD_RULE: boards are numbered 1, 2 and 3'; end if;
      select array_agg(distinct (e #>> '{}')::int order by (e #>> '{}')::int) into r.board_slots from jsonb_array_elements(v) e;
    end if;
  end if;

  -- cross checks
  if r.kind = 'board_pick' then
    if r.basis <> 'per_bill' then raise exception 'BAD_RULE: number picks are counted per bill (bills are never added together)'; end if;
    if r.event_id is null then raise exception 'BAD_RULE: choose the event the picks are for'; end if;
  else
    if r.event_id is not null or r.board_slots is not null then raise exception 'BAD_RULE: only number picks belong to an event'; end if;
  end if;
  if r.spend_step is null or r.reward_amount is null then raise exception 'BAD_RULE: the amount per step and the reward are required'; end if;
  if r.name is null then raise exception 'BAD_RULE: give the rule a name'; end if;
  if r.ends_at is not null and r.ends_at < r.starts_at then raise exception 'BAD_RULE: the end cannot be before the start'; end if;

  if cur.id is null then
    insert into public.rw_rules (id, kind, name, active, starts_at, ends_at, spend_step, reward_amount, basis, max_per_order, category_codes, include_skus, exclude_skus, include_packs,
        only_profile_ids, event_id, board_slots, created_by, updated_by)
      values (r.id, r.kind, r.name, r.active, r.starts_at, r.ends_at, r.spend_step, r.reward_amount, r.basis, r.max_per_order, r.category_codes, r.include_skus, r.exclude_skus, r.include_packs,
        r.only_profile_ids, r.event_id, r.board_slots, auth.uid(), auth.uid());
  else
    update public.rw_rules set name = r.name, active = r.active, starts_at = r.starts_at, ends_at = r.ends_at, spend_step = r.spend_step, reward_amount = r.reward_amount, basis = r.basis,
        max_per_order = r.max_per_order, category_codes = r.category_codes, include_skus = r.include_skus, exclude_skus = r.exclude_skus, include_packs = r.include_packs,
        only_profile_ids = r.only_profile_ids, event_id = r.event_id, board_slots = r.board_slots, updated_by = auth.uid(), updated_at = now()
      where id = r.id;                                                  -- the guard trigger answers BAD_RULE: RULE_USED for a frozen field of a used rule
  end if;
  perform public.rw_log('rule.save', 'rule', r.id::text, null, null, jsonb_build_object('created', cur.id is null, 'patch', p_patch, 'before', case when cur.id is null then null else to_jsonb(cur) end));
  select * into r from public.rw_rules where id = r.id;
  return public.rw_rule_json(r);
end $$;

create or replace function public.rw_admin_set_rule_active(p_id uuid, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.rw_rules;
begin
  perform public.rw_require_staff('switch a reward rule on or off');
  if p_active is null then raise exception 'BAD_RULE: active must be true or false'; end if;
  select * into r from public.rw_rules where id = p_id for no key update;
  if not found then raise exception 'NOT_FOUND'; end if;
  update public.rw_rules set active = p_active, updated_by = auth.uid(), updated_at = now() where id = p_id returning * into r;
  perform public.rw_log('rule.active', 'rule', r.id::text, null, null, jsonb_build_object('active', p_active));
  return public.rw_rule_json(r);
end $$;

-- ====================================================================================================================== 7 the scope rule (ONE function used by settle, simulate and preview)
-- p_items = [{"sku_code": ..., "qty": n, "line_total": baht}]. A line is in scope when its SKU is not excluded and (no include list and no category list exist, or
-- the SKU is in the include list, or its shop category is in the category list). A pack line (SKU in promo_packs, active or not) is in scope only if the rule
-- includes packs; it counts at eligible_value x packs (the price paid when no eligible value is set); a pack with points_per_pack set stays out of every POINTS
-- rule's step arithmetic (its points are their own ledger source). The registry (not the shop view) is read, so an SKU that is inactive today still counts on an
-- old paid bill. Shipping is not in the items, so it is never counted.
create or replace function public.rw_rule_amount(p_rule public.rw_rules, p_items jsonb)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when pk.pack_sku_code is not null then coalesce(pk.eligible_value * l.qty, l.line_total) else l.line_total end), 0)
  from jsonb_to_recordset(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as l(sku_code text, qty integer, line_total numeric)
  join public.sku_registry s on s.sku_code = l.sku_code
  left join public.promo_packs pk on pk.pack_sku_code = l.sku_code
  where not (l.sku_code = any (p_rule.exclude_skus))
    and ((cardinality(p_rule.include_skus) = 0 and cardinality(p_rule.category_codes) = 0) or l.sku_code = any (p_rule.include_skus)
         or public.shop_category_of(s.product_type, s.domain) = any (p_rule.category_codes))
    and (pk.pack_sku_code is null or (p_rule.include_packs and not (p_rule.kind = 'points' and pk.points_per_pack is not null)))
$$;

-- reward = least(floor(amount / step) x reward, max per bill): NUMERIC arithmetic, floor, never a float and never rounded up (299.99 / 300 -> 0).
-- A safety ceiling of 1,000,000 keeps an absurd rule from overflowing an integer.
create or replace function public.rw_reward_for(p_rule public.rw_rules, p_amount numeric)
returns integer language sql immutable security definer set search_path = public as $$
  select case when p_amount is null or p_amount <= 0 then 0
         else least(floor(p_amount / p_rule.spend_step) * p_rule.reward_amount,
                    case when p_rule.basis = 'per_bill' then coalesce(p_rule.max_per_order, 1000000) else 1000000 end, 1000000)::integer end $$;

-- The amount a bill counts for a rule: the snapshot taken when the bill was first counted, else (a bill not counted yet: unpaid, display) the live scope rule.
create or replace function public.rw_rule_amount_for(p_rule public.rw_rules, p_order uuid, p_items jsonb)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select s.eligible_amount from public.rw_bill_eligible s where s.rule_id = p_rule.id and s.order_id = p_order), public.rw_rule_amount(p_rule, p_items)) $$;

-- how much more eligible spend earns the next reward (null when the per-bill limit is reached)
create or replace function public.rw_next_in(p_rule public.rw_rules, p_amount numeric)
returns numeric language sql immutable security definer set search_path = public as $$
  select case when p_rule.basis = 'per_bill' and p_rule.max_per_order is not null and floor(coalesce(p_amount, 0) / p_rule.spend_step) * p_rule.reward_amount >= p_rule.max_per_order then null
         else (floor(greatest(coalesce(p_amount, 0), 0) / p_rule.spend_step) + 1) * p_rule.spend_step - greatest(coalesce(p_amount, 0), 0) end $$;

-- the total reward the bill would earn once it reaches the next step (null at the per-bill limit, like next_reward_in)
create or replace function public.rw_next_total(p_rule public.rw_rules, p_amount numeric)
returns integer language sql immutable security definer set search_path = public as $$
  select case when p_rule.basis = 'per_bill' and p_rule.max_per_order is not null and floor(coalesce(p_amount, 0) / p_rule.spend_step) * p_rule.reward_amount >= p_rule.max_per_order then null
         else least((floor(greatest(coalesce(p_amount, 0), 0) / p_rule.spend_step) + 1) * p_rule.reward_amount,
                    case when p_rule.basis = 'per_bill' then coalesce(p_rule.max_per_order, 1000000) else 1000000 end, 1000000)::integer end $$;

-- does the rule apply to this customer and to a bill created at p_created? (the window is checked against the ORDER's creation time)
create or replace function public.rw_rule_applies(p_rule public.rw_rules, p_profile uuid, p_created timestamptz)
returns boolean language sql immutable security definer set search_path = public as $$
  select (p_rule.only_profile_ids is null or p_profile = any (p_rule.only_profile_ids))
     and (p_rule.starts_at is null or p_created >= p_rule.starts_at) and (p_rule.ends_at is null or p_created <= p_rule.ends_at) $$;

-- Does the rule still count this bill? In its window and for this customer (rw_rule_applies) OR the bill was already counted (it has a snapshot): once a bill
-- earned, moving the rule's start forward (switching the rule off and on stamps a new start) must never push it out and take its rewards back.
create or replace function public.rw_rule_counts(p_rule public.rw_rules, p_profile uuid, p_order uuid, p_created timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select public.rw_rule_applies(p_rule, p_profile, p_created) or exists (select 1 from public.rw_bill_eligible s where s.rule_id = p_rule.id and s.order_id = p_order) $$;

-- ====================================================================================================================== 8 the bills of a customer
-- eligible = the order is not cancelled / returned AND its invoice is fully paid (status 5) or paid with a review flag (6) AND nothing is outstanding (code 6
-- alone does not prove it: in the ledger a flagged receipt beats the outstanding test), read from the same ledger logic as
-- the shop. items carry the line totals after any order discount (spread in proportion; 0 today); shipping is not in them.
create or replace function public.rw_bills(p_profile uuid)
returns table (order_id uuid, order_no text, created_at timestamptz, status text, pay_code integer, eligible boolean, items jsonb)
language sql stable security definer set search_path = public as $$
  select o.id, o.order_no, o.created_at, o.status, x.code, (o.status not in ('cancelled', 'returned') and coalesce(x.code, -1) in (5, 6) and coalesce(x.outstanding, 1) <= 0),
         (select coalesce(jsonb_agg(jsonb_build_object('sku_code', i.sku_code, 'qty', i.qty,
                   'line_total', i.line_total * (o.subtotal - o.discount) / o.subtotal) order by i.line_no), '[]'::jsonb)
            from public.shop_order_items i where i.order_id = o.id)
  from public.shop_orders o
  cross join lateral (select (q.st ->> 'status_code')::integer as code, (q.st ->> 'outstanding')::numeric as outstanding
                        from (select case when o.status in ('cancelled', 'returned') then null::jsonb else public.finance_invoice_state_raw(o.invoice_id) end as st) q) x
  where o.profile_id = p_profile $$;

-- ====================================================================================================================== 9 points: what every (source, bill) should have earned
-- source_key 'rule:<id>' (order_id null for a cumulative rule) and 'pack:<sku>'. Pack points are their own source, independent of the rules.
create or replace function public.rw_points_targets(p_profile uuid)
returns table (source_key text, rule_id uuid, order_id uuid, target integer)
language sql stable security definer set search_path = public as $$
  with b as (select * from public.rw_bills(p_profile))
  select 'rule:' || r.id::text, r.id, b.order_id,
         case when b.eligible then public.rw_reward_for(r, public.rw_rule_amount_for(r, b.order_id, b.items)) else 0 end
    from public.rw_rules r join b on public.rw_rule_counts(r, p_profile, b.order_id, b.created_at)
   where r.kind = 'points' and r.basis = 'per_bill'
  union all
  select 'rule:' || r.id::text, r.id, null::uuid,
         public.rw_reward_for(r, coalesce((select sum(public.rw_rule_amount_for(r, b.order_id, b.items)) from b where b.eligible and public.rw_rule_counts(r, p_profile, b.order_id, b.created_at)), 0))
    from public.rw_rules r
   where r.kind = 'points' and r.basis = 'cumulative' and (r.only_profile_ids is null or p_profile = any (r.only_profile_ids))
  union all
  select 'pack:' || l.sku_code, null::uuid, b.order_id, case when b.eligible then (pk.points_per_pack * sum(l.qty))::integer else 0 end
    from b cross join lateral jsonb_to_recordset(b.items) as l(sku_code text, qty integer, line_total numeric)
    join public.promo_packs pk on pk.pack_sku_code = l.sku_code and pk.points_per_pack is not null
   group by l.sku_code, b.order_id, b.eligible, pk.points_per_pack $$;

-- ====================================================================================================================== 10 picks: bring ONE bill's rights to the target
-- Counted rights = available + used. Below the target: revoked rows of that bill come back first (lowest place first), then new places are appended.
-- Above it: unused rights are revoked newest first; if that is not enough, the surplus USED rights are flagged needs_review (the number is never touched).
-- A right a Super Admin chose to keep (kept) is never flagged or revoked by settle. Returns the number of rows changed.
create or replace function public.rw_apply_picks(p_rule public.rw_rules, p_profile uuid, p_order uuid, p_target integer)
returns integer language plpgsql security definer set search_path = public as $$
declare c integer; need integer; got integer; mx integer; changed integer := 0; surplus integer;
begin
  select count(*)::integer into c from public.rw_entitlements where rule_id = p_rule.id and source_order_id = p_order and status in ('available', 'used');
  if c < p_target then
    need := p_target - c;
    with up as (update public.rw_entitlements set status = 'available', revoked_reason = null, revoked_at = null
                 where id in (select id from public.rw_entitlements where rule_id = p_rule.id and source_order_id = p_order and status = 'revoked' order by seq limit need) returning 1)
    select count(*)::integer into got from up;
    changed := changed + got; need := need - got;
    if need > 0 then
      select coalesce(max(seq), 0) into mx from public.rw_entitlements where rule_id = p_rule.id and source_order_id = p_order;
      insert into public.rw_entitlements (rule_id, profile_id, event_id, source_order_id, seq, status)
        select p_rule.id, p_profile, p_rule.event_id, p_order, mx + g, 'available' from generate_series(1, need) g
        on conflict (rule_id, source_order_id, seq) do nothing;
      get diagnostics got = row_count;
      changed := changed + got;
    end if;
  elsif c > p_target then
    surplus := c - p_target;
    with rv as (update public.rw_entitlements set status = 'revoked', revoked_reason = 'bill no longer counts', revoked_at = now()
                 where id in (select id from public.rw_entitlements where rule_id = p_rule.id and source_order_id = p_order and status = 'available' order by seq desc limit surplus) returning 1)
    select count(*)::integer into got from rv;
    changed := changed + got;
  end if;
  -- what is still above the target can only be USED rights: flag the newest that are not kept, clear the flag on all others
  select count(*)::integer into c from public.rw_entitlements where rule_id = p_rule.id and source_order_id = p_order and status in ('available', 'used');
  surplus := greatest(c - p_target, 0);
  with ranked as (select id, row_number() over (order by seq desc) as rn from public.rw_entitlements
                   where rule_id = p_rule.id and source_order_id = p_order and status = 'used' and not kept)
  update public.rw_entitlements e set needs_review = (rk.rn <= surplus), review_since = case when rk.rn <= surplus then coalesce(e.review_since, now()) else null end
    from ranked rk where e.id = rk.id and e.needs_review is distinct from (rk.rn <= surplus);
  get diagnostics got = row_count;
  changed := changed + got;
  return changed;
end $$;

-- ====================================================================================================================== 11 settle
-- Idempotent. Takes one advisory lock per customer, READS (never locks) orders, invoices and receipts, and writes only differences.
-- Rules switched off may only LOWER a bill's target (a reversal), never raise it; a window that has ended does not revoke past bills.
create or replace function public.rw_settle_profile(p_profile uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare changed integer := 0; t record; b record; r public.rw_rules; tgt integer; have integer; diff integer; act boolean; v_note text;
begin
  if p_profile is null then return 0; end if;
  if not coalesce((select enabled from public.rw_settings where id), false) then return 0; end if;
  if not exists (select 1 from public.profiles where id = p_profile) then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('rw:' || p_profile::text, 0));

  -- freeze what every paid bill counts for every ACTIVE rule that applies to it, once: from here on a catalogue edit cannot change it (insert-only, first writer wins)
  insert into public.rw_bill_eligible (rule_id, order_id, eligible_amount)
    select ru.id, bl.order_id, public.rw_rule_amount(ru, bl.items)
      from public.rw_bills(p_profile) bl join public.rw_rules ru on ru.active and public.rw_rule_applies(ru, p_profile, bl.created_at)
     where bl.eligible
    on conflict (rule_id, order_id) do nothing;

  -- points: one ledger row for every (source, bill) whose total differs from its target
  for t in
    select coalesce(d.source_key, e.source_key) as source_key, coalesce(d.rule_id, e.rule_id) as rule_id, coalesce(d.order_id, e.order_id) as order_id,
           coalesce(d.target, 0) as target, coalesce(e.have, 0) as have
      from public.rw_points_targets(p_profile) d
      full join (select l.source_key, max(l.rule_id::text)::uuid as rule_id, l.order_id, sum(l.points)::integer as have,
                        coalesce(l.order_id, '00000000-0000-0000-0000-000000000000'::uuid) as order_key
                   from public.rw_points_ledger l where l.profile_id = p_profile and l.source_key <> 'adjust' group by l.source_key, l.order_id) e
        on d.source_key = e.source_key and coalesce(d.order_id, '00000000-0000-0000-0000-000000000000'::uuid) = e.order_key
  loop
    tgt := t.target;
    if t.rule_id is not null then
      select active into act from public.rw_rules where id = t.rule_id;
      if act is false then tgt := least(tgt, t.have); end if;
    end if;
    diff := tgt - t.have;
    if diff <> 0 then
      v_note := case when t.rule_id is not null then (select name from public.rw_rules where id = t.rule_id)
                      else (select btrim(regexp_replace(s.name_full, '^[0-9]+\s+', '')) from public.sku_registry s where s.sku_code = substr(t.source_key, 6)) end;
      insert into public.rw_points_ledger (profile_id, points, kind, source_key, rule_id, order_id, note)
        values (p_profile, diff, case when diff > 0 then 'earn' else 'reverse' end, t.source_key, t.rule_id, t.order_id, v_note);
      changed := changed + 1;
    end if;
  end loop;

  -- picks: per bill and rule
  for b in select * from public.rw_bills(p_profile) loop
    for r in select * from public.rw_rules where kind = 'board_pick' order by created_at, id loop
      if public.rw_rule_counts(r, p_profile, b.order_id, b.created_at) or exists (select 1 from public.rw_entitlements e where e.rule_id = r.id and e.source_order_id = b.order_id) then
        if b.eligible and public.rw_rule_counts(r, p_profile, b.order_id, b.created_at) then
          tgt := least(public.rw_reward_for(r, public.rw_rule_amount_for(r, b.order_id, b.items)), 1000);       -- 1000 rights per bill is a safety ceiling
        else tgt := 0; end if;
        if not r.active then
          select count(*)::integer into have from public.rw_entitlements where rule_id = r.id and source_order_id = b.order_id and status in ('available', 'used');
          tgt := least(tgt, have);
        end if;
        changed := changed + public.rw_apply_picks(r, p_profile, b.order_id, tgt);
      end if;
    end loop;
  end loop;

  if changed > 0 then
    perform public.rw_log('settle', 'profile', p_profile::text, p_profile, null, jsonb_build_object('changed', changed));
  end if;
  return changed;
end $$;

-- the safe entry for triggers: a reward error is logged and swallowed, the payment (or status change) that fired it carries on.
-- The advisory lock of the customer is waited for at most 400 ms (less than the 1 s of deadlock_timeout): a payment must never sit in a lock queue, and
-- a lock cycle with a wallet or invoice lock held by another payment must end HERE (as a logged 55P03 "settle_error", healed by the next read or re-settle),
-- never as a deadlock that aborts the payment.
create or replace function public.rw_trigger_settle(p_profile uuid, p_invoice uuid, p_source text)
returns void language plpgsql security definer set search_path = public as $$
declare v_profile uuid := p_profile; v_prev text;
begin
  if not coalesce((select enabled from public.rw_settings where id), false) then return; end if;
  begin
    v_prev := current_setting('lock_timeout');
    perform set_config('lock_timeout', '400ms', true);
    if v_profile is null then select o.profile_id into v_profile from public.shop_orders o where o.invoice_id = p_invoice; end if;
    if v_profile is not null then perform public.rw_settle_profile(v_profile); end if;
    perform set_config('lock_timeout', v_prev, true);
  exception when others then
    begin
      insert into public.rw_events_log (action, entity, entity_id, profile_id, detail)
        values ('settle_error', 'profile', coalesce(v_profile::text, p_invoice::text), v_profile, jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm, 'source', p_source));
    exception when others then null;
    end;
  end;
end $$;

create or replace function public.rw_trg_receipt()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.rw_trigger_settle(null, new.invoice_id, 'finance_receipts'); return null; end $$;
create or replace function public.rw_trg_allocation()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.rw_trigger_settle(null, new.invoice_id, 'finance_allocations'); return null; end $$;
-- Rewards depend on an order's status only through "cancelled" / "returned" (the payment decides the rest), so the ordinary fulfilment steps
-- (confirmed, preparing, packed, shipped, completed) must not pay for a settle.
create or replace function public.rw_trg_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('cancelled', 'returned') then perform public.rw_trigger_settle(new.profile_id, new.invoice_id, 'shop_orders'); end if;
  return null;
end $$;

-- A receipt is inserted BEFORE its allocation, and a reversal deactivates the allocation BEFORE it flips the receipt: money only counts once the allocation
-- exists, so the allocation is watched as well as the receipt (the receipt trigger covers a receipt that is posted or reversed on its own).
create trigger rw_settle_after_receipt after insert or update of status on public.finance_receipts for each row execute function public.rw_trg_receipt();
create trigger rw_settle_after_allocation after insert or update of active on public.finance_allocations for each row execute function public.rw_trg_allocation();
create trigger rw_settle_after_order after update of status on public.shop_orders for each row when (old.status is distinct from new.status) execute function public.rw_trg_order();

-- ====================================================================================================================== 12 hooks the event-boards migration replaces
-- (create or replace there.) Here no board exists yet.
create or replace function public.rw_selections_json(p_profile uuid)
returns jsonb language sql stable security definer set search_path = public as $$ select '[]'::jsonb $$;
create or replace function public.rw_review_selection_info(p_selection uuid)
returns jsonb language sql stable security definer set search_path = public as $$ select null::jsonb $$;
create or replace function public.rw_release_selection_for_review(p_selection uuid, p_reason text)
returns void language sql security definer set search_path = public as $$ select $$ ;

-- ====================================================================================================================== 13 packs
create or replace function public.rw_pack_json(p_sku text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('pack_sku_code', pk.pack_sku_code, 'name', btrim(regexp_replace(s.name_full, '^[0-9]+\s+', '')),
    'price', coalesce(public.shop_price_of(s.ecommerce_price, s.selling_price, s.retail_price), 0), 'status', s.status, 'active', pk.active,
    'eligible_value', pk.eligible_value, 'points_per_pack', pk.points_per_pack,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('sku_code', i.component_sku_code, 'name', btrim(regexp_replace(c.name_full, '^[0-9]+\s+', '')), 'qty', i.qty, 'status', c.status)
                                         order by i.component_sku_code), '[]'::jsonb)
                from public.promo_pack_items i join public.sku_registry c on c.sku_code = i.component_sku_code where i.pack_sku_code = pk.pack_sku_code),
    'sold_packs', coalesce((select sum(it.qty) from public.shop_order_items it where it.sku_code = pk.pack_sku_code), 0))      -- every order line counts, cancelled or not: the same rule that locks the contents
  from public.promo_packs pk join public.sku_registry s on s.sku_code = pk.pack_sku_code where pk.pack_sku_code = p_sku $$;

-- validates [{sku_code, qty}] and returns the normalised list (components must be active finished goods and no pack)
create or replace function public.rw_check_pack_items(p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e jsonb; s public.sku_registry; seen text[] := '{}'; res jsonb := '[]'::jsonb; q integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'BAD_PACK: a pack needs 1 to 20 products'; end if;
  for e in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'sku_code') is distinct from 'string' then raise exception 'BAD_PACK: every product needs a sku_code and a quantity'; end if;
    q := public.rw_j_whole(e -> 'qty', 'the quantity', 1, 'BAD_PACK');
    if (e ->> 'sku_code') = any (seen) then raise exception 'BAD_PACK: % is listed twice: change its quantity instead', e ->> 'sku_code'; end if;
    seen := seen || (e ->> 'sku_code');
    select * into s from public.sku_registry where sku_code = e ->> 'sku_code';
    if not found or s.status <> 'active' then raise exception 'INACTIVE_SKU: %', e ->> 'sku_code'; end if;
    if s.sku_category <> 'FG' then raise exception 'BAD_PACK: % is not a finished good', s.sku_code; end if;
    if exists (select 1 from public.promo_packs where pack_sku_code = s.sku_code) then raise exception 'BAD_PACK: % is a pack: a pack cannot contain a pack', s.sku_code; end if;
    res := res || jsonb_build_array(jsonb_build_object('sku_code', s.sku_code, 'qty', q));
  end loop;
  return res;
end $$;

create or replace function public.rw_items_sig(p_items jsonb)
returns text language sql immutable security definer set search_path = public as $$
  select coalesce(string_agg((e ->> 'sku_code') || ':' || ((e ->> 'qty')::integer)::text, ',' order by e ->> 'sku_code'), '') from jsonb_array_elements(p_items) e $$;

create or replace function public.rw_admin_packs()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.rw_require_staff('see the promotion packs');
  return coalesce((select jsonb_agg(public.rw_pack_json(pk.pack_sku_code) order by pk.created_at desc, pk.pack_sku_code) from public.promo_packs pk), '[]'::jsonb);
end $$;

create or replace function public.rw_admin_create_pack(p_key uuid, p_name text, p_price numeric, p_items jsonb, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare nm text := btrim(coalesce(p_name, '')); items jsonb; prev public.sku_registry; first_c public.sku_registry; v_code text; k text; patch jsonb := coalesce(p_patch, '{}'::jsonb);
        ev numeric; pp integer; act boolean := true;
begin
  perform public.rw_require_staff('create promotion packs');
  if p_key is null then raise exception 'INVALID_KEY'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rw:pack:' || p_key::text, 0));
  if length(nm) not between 1 and 200 then raise exception 'BAD_PACK: give the pack a name (200 characters at most)'; end if;
  if p_price is null or p_price <= 0 or p_price <> round(p_price, 2) or p_price > 10000000 then raise exception 'BAD_PACK: the price must be an amount in baht and satang, more than 0'; end if;
  if jsonb_typeof(patch) <> 'object' then raise exception 'BAD_PACK: the options must be an object'; end if;
  for k in select jsonb_object_keys(patch) loop
    if k not in ('active', 'eligible_value', 'points_per_pack') then raise exception 'BAD_PACK: unknown option %', k; end if;
  end loop;
  if patch ? 'active' then
    if jsonb_typeof(patch -> 'active') <> 'boolean' then raise exception 'BAD_PACK: active must be true or false'; end if;
    act := (patch ->> 'active')::boolean;
  end if;
  if patch ? 'eligible_value' and jsonb_typeof(patch -> 'eligible_value') <> 'null' then ev := public.rw_j_money(patch -> 'eligible_value', 'the eligible value', 'BAD_PACK'); end if;
  if patch ? 'points_per_pack' and jsonb_typeof(patch -> 'points_per_pack') <> 'null' then pp := public.rw_j_whole(patch -> 'points_per_pack', 'the points per pack', 0, 'BAD_PACK'); end if;
  if ev is not null and ev > p_price then raise exception 'BAD_PACK: the eligible value cannot be more than the price'; end if;

  -- a retry of the same request returns the pack it already made (a different request under the same key is refused)
  select * into prev from public.sku_registry where client_ref = p_key;
  if found then
    if not exists (select 1 from public.promo_packs where pack_sku_code = prev.sku_code) then raise exception 'KEY_REUSED'; end if;
    items := public.rw_check_pack_items(p_items);
    if btrim(regexp_replace(prev.name_full, '^[0-9]+\s+', '')) <> nm or coalesce(public.shop_price_of(prev.ecommerce_price, prev.selling_price, prev.retail_price), 0) <> p_price
       or (select string_agg(i.component_sku_code || ':' || i.qty::text, ',' order by i.component_sku_code) from public.promo_pack_items i where i.pack_sku_code = prev.sku_code) is distinct from public.rw_items_sig(items) then
      raise exception 'KEY_REUSED'; end if;
    return public.rw_pack_json(prev.sku_code);
  end if;

  items := public.rw_check_pack_items(p_items);
  select * into first_c from public.sku_registry where sku_code = items -> 0 ->> 'sku_code';
  select i.code into v_code from public.sku_issue('FG', nm, p_key, auth.uid()) i;
  -- the pack takes product type, domain, brand and unit of its first component, so the shop shows it in the same category
  update public.sku_registry set product_type = first_c.product_type, domain = first_c.domain, brand = first_c.brand, unit_en = first_c.unit_en, unit_th = first_c.unit_th,
         selling_price = p_price, updated_at = now() where sku_code = v_code;
  insert into public.promo_packs (pack_sku_code, active, eligible_value, points_per_pack, created_by, updated_by) values (v_code, act, ev, pp, auth.uid(), auth.uid());
  insert into public.promo_pack_items (pack_sku_code, component_sku_code, qty) select v_code, e ->> 'sku_code', (e ->> 'qty')::integer from jsonb_array_elements(items) e;
  perform public.rw_log('pack.create', 'pack', v_code, null, null, jsonb_build_object('name', nm, 'price', p_price, 'items', items, 'eligible_value', ev, 'points_per_pack', pp));
  return public.rw_pack_json(v_code);
end $$;

create or replace function public.rw_admin_save_pack(p_pack text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pk public.promo_packs; s public.sku_registry; k text; sold boolean; v_ev numeric; v_pp integer; v_act boolean; v_name text; v_price numeric; v_items jsonb; before jsonb;
begin
  perform public.rw_require_staff('change promotion packs');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_PACK: nothing to save'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('active', 'eligible_value', 'points_per_pack', 'price', 'name', 'items') then raise exception 'BAD_PACK: unknown field %', k; end if;
  end loop;
  select * into pk from public.promo_packs where pack_sku_code = p_pack for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into s from public.sku_registry where sku_code = p_pack;
  sold := public.rw_pack_sold(p_pack);
  before := public.rw_pack_json(p_pack);
  v_ev := pk.eligible_value; v_pp := pk.points_per_pack; v_act := pk.active; v_name := btrim(regexp_replace(s.name_full, '^[0-9]+\s+', ''));
  v_price := coalesce(public.shop_price_of(s.ecommerce_price, s.selling_price, s.retail_price), 0);

  if p_patch ? 'active' then
    if jsonb_typeof(p_patch -> 'active') <> 'boolean' then raise exception 'BAD_PACK: active must be true or false'; end if;
    v_act := (p_patch ->> 'active')::boolean;
  end if;
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch -> 'name') <> 'string' or length(btrim(p_patch ->> 'name')) not between 1 and 200 then raise exception 'BAD_PACK: give the pack a name (200 characters at most)'; end if;
    v_name := btrim(p_patch ->> 'name');
  end if;
  if p_patch ? 'price' then v_price := public.rw_j_money(p_patch -> 'price', 'the price', 'BAD_PACK'); end if;
  if p_patch ? 'eligible_value' then
    v_ev := case when jsonb_typeof(p_patch -> 'eligible_value') = 'null' then null else public.rw_j_money(p_patch -> 'eligible_value', 'the eligible value', 'BAD_PACK') end;
    if sold and v_ev is distinct from pk.eligible_value then raise exception 'BAD_PACK: this pack has been sold, so its eligible value is locked (create a new pack instead)'; end if;
  end if;
  if p_patch ? 'points_per_pack' then
    v_pp := case when jsonb_typeof(p_patch -> 'points_per_pack') = 'null' then null else public.rw_j_whole(p_patch -> 'points_per_pack', 'the points per pack', 0, 'BAD_PACK') end;
    if sold and v_pp is distinct from pk.points_per_pack then raise exception 'BAD_PACK: this pack has been sold, so its points are locked (create a new pack instead)'; end if;
  end if;
  if p_patch ? 'items' then
    v_items := public.rw_check_pack_items(p_patch -> 'items');
    if public.rw_items_sig(v_items) is distinct from (select coalesce(string_agg(i.component_sku_code || ':' || i.qty::text, ',' order by i.component_sku_code), '') from public.promo_pack_items i where i.pack_sku_code = p_pack) then
      if sold then raise exception 'BAD_PACK: this pack has been sold, so its contents are locked (create a new pack instead)'; end if;
      delete from public.promo_pack_items where pack_sku_code = p_pack;
      insert into public.promo_pack_items (pack_sku_code, component_sku_code, qty) select p_pack, e ->> 'sku_code', (e ->> 'qty')::integer from jsonb_array_elements(v_items) e;
    end if;
  end if;
  if v_ev is not null and v_ev > v_price then raise exception 'BAD_PACK: the eligible value cannot be more than the price'; end if;

  update public.promo_packs set active = v_act, eligible_value = v_ev, points_per_pack = v_pp, updated_by = auth.uid(), updated_at = now() where pack_sku_code = p_pack;
  update public.sku_registry set name_full = v_name, selling_price = v_price, ecommerce_price = case when nullif(ecommerce_price, 0) is not null then v_price else ecommerce_price end, updated_at = now()
    where sku_code = p_pack and (name_full is distinct from v_name or selling_price is distinct from v_price or (nullif(ecommerce_price, 0) is not null and ecommerce_price is distinct from v_price));
  perform public.rw_log('pack.save', 'pack', p_pack, null, null, jsonb_build_object('patch', p_patch, 'before', before));
  return public.rw_pack_json(p_pack);
end $$;

-- ====================================================================================================================== 14 staff searches
create or replace function public.rw_admin_sku_search(p_q text, p_only_active boolean default true, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_q, '')), ''); pat text; lim integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  perform public.rw_require_staff('search products');
  if q is not null then q := left(q, 80); pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('sku_code', x.sku_code, 'name', btrim(regexp_replace(x.name_full, '^[0-9]+\s+', '')), 'status', x.status,
            'price', public.shop_price_of(x.ecommerce_price, x.selling_price, x.retail_price), 'category', public.shop_category_of(x.product_type, x.domain), 'brand', x.brand,
            'is_pack', exists (select 1 from public.promo_packs pk where pk.pack_sku_code = x.sku_code), 'origin', x.origin) order by x.rk, x.sku_seq)
      from (select s.*, case when q is not null and s.sku_code = q then 0 else 1 end as rk
              from public.sku_registry s
             where s.sku_category = 'FG' and (not coalesce(p_only_active, true) or s.status = 'active')
               and (q is null or s.sku_code ilike pat or s.name_full ilike pat or s.name_th ilike pat or s.name_en ilike pat or s.brand ilike pat or s.barcode ilike pat)
             order by case when q is not null and s.sku_code = q then 0 else 1 end, s.sku_seq limit lim) x), '[]'::jsonb);
end $$;

-- name, phone digits or e-mail; at least 2 characters (a shorter query answers an empty list), at most 20 rows
create or replace function public.rw_admin_customer_search(p_q text, p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q text := btrim(coalesce(p_q, '')); pat text; digits text; lim integer := least(greatest(coalesce(p_limit, 10), 1), 20); by_phone boolean;
begin
  perform public.rw_require_staff('search customers');
  if length(q) < 2 then return '[]'::jsonb; end if;
  q := left(q, 80);
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  digits := regexp_replace(q, '[^0-9]', '', 'g');
  by_phone := q ~ '^[0-9 +()-]+$' and length(digits) >= 2;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.display_name, 'phone', x.phone, 'email', x.email) order by x.display_name nulls last, x.id)
      from (select p.id, p.display_name, p.phone, p.email from public.profiles p
             where p.status = 'active' and (p.display_name ilike pat or p.email ilike pat or (by_phone and regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') like '%' || digits || '%'))
             order by p.display_name nulls last, p.id limit lim) x), '[]'::jsonb);
end $$;

-- ====================================================================================================================== 15 preview and simulate (read-only)
create or replace function public.rw_norm_items(p_items jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('sku_code', x.sku, 'qty', x.q, 'line_total', x.q * v.price) order by x.sku), '[]'::jsonb)
    from (select e.e ->> 'sku_code' as sku, sum((e.e ->> 'qty')::integer) as q
            from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality e(e, o)
           where e.o <= 40 and jsonb_typeof(e.e) = 'object' and (e.e ->> 'qty') ~ '^[0-9]{1,3}$' group by e.e ->> 'sku_code') x
    join public.shop_sellable v on v.sku_code = x.sku
   where x.q between 1 and 99 $$;

create or replace function public.rw_preview_cart(p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid; s public.rw_settings; items jsonb; lines jsonb;
begin
  uid := public.shop_require_user();
  select * into s from public.rw_settings where id;
  if not s.enabled then return jsonb_build_object('enabled', false, 'lines', '[]'::jsonb); end if;
  items := public.rw_norm_items(p_items);
  select coalesce(jsonb_agg(z.l order by z.ord, z.ca, z.id), '[]'::jsonb) into lines from (
    select jsonb_build_object('kind', r.kind, 'name', r.name, 'eligible_amount', a.v, 'reward', public.rw_reward_for(r, a.v), 'next_reward_in', public.rw_next_in(r, a.v), 'next_reward_total', public.rw_next_total(r, a.v)) as l,
           1 as ord, r.created_at as ca, r.id::text as id
      from public.rw_rules r cross join lateral (select public.rw_rule_amount(r, items) as v) a
     where r.active and public.rw_rule_applies(r, uid, now()) and (r.kind = 'points' or s.boards_enabled) and a.v > 0
    union all
    select jsonb_build_object('kind', 'points', 'name', btrim(regexp_replace(sk.name_full, '^[0-9]+\s+', '')), 'eligible_amount', coalesce(pk.eligible_value * l.qty, l.line_total),
           'reward', pk.points_per_pack * l.qty, 'next_reward_in', null, 'next_reward_total', null), 2, pk.created_at, l.sku_code
      from jsonb_to_recordset(items) as l(sku_code text, qty integer, line_total numeric)
      join public.promo_packs pk on pk.pack_sku_code = l.sku_code and coalesce(pk.points_per_pack, 0) > 0
      join public.sku_registry sk on sk.sku_code = l.sku_code) z;
  return jsonb_build_object('enabled', true, 'lines', lines);
end $$;

-- staff: the same arithmetic for every rule (also switched-off or out-of-window ones, with a note and a reward of 0); pack points come as extra rows whose
-- rule_id is 'pack:<sku>'
create or replace function public.rw_admin_simulate(p_items jsonb, p_profile uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare items jsonb;
begin
  perform public.rw_require_staff('test the reward rules');
  items := public.rw_norm_items(p_items);
  return coalesce((select jsonb_agg(z.l order by z.ord, z.ca, z.id) from (
    select jsonb_build_object('rule_id', r.id, 'rule_name', r.name, 'kind', r.kind, 'eligible_amount', a.v,
             'reward', case when ok.v then public.rw_reward_for(r, a.v) else 0 end, 'next_reward_in', case when ok.v then public.rw_next_in(r, a.v) end,
             'note', case when not r.active then 'inactive'
                          when r.starts_at is not null and r.starts_at > now() then 'not started yet'
                          when r.ends_at is not null and r.ends_at < now() then 'ended'
                          when p_profile is not null and r.only_profile_ids is not null and not (p_profile = any (r.only_profile_ids)) then 'not for this customer'
                          when r.basis = 'cumulative' then 'counts total spend: shown as if this were all the customer spent'
                          when r.only_profile_ids is not null then 'only for selected customers' end) as l,
           1 as ord, r.created_at as ca, r.id::text as id
      from public.rw_rules r cross join lateral (select public.rw_rule_amount(r, items) as v) a
      cross join lateral (select r.active and (r.starts_at is null or r.starts_at <= now()) and (r.ends_at is null or r.ends_at >= now())
                                 and (p_profile is null or r.only_profile_ids is null or p_profile = any (r.only_profile_ids)) as v) ok
    union all
    select jsonb_build_object('rule_id', 'pack:' || l.sku_code, 'rule_name', btrim(regexp_replace(sk.name_full, '^[0-9]+\s+', '')), 'kind', 'points',
           'eligible_amount', coalesce(pk.eligible_value * l.qty, l.line_total), 'reward', pk.points_per_pack * l.qty, 'next_reward_in', null, 'note', 'pack points'), 2, pk.created_at, l.sku_code
      from jsonb_to_recordset(items) as l(sku_code text, qty integer, line_total numeric)
      join public.promo_packs pk on pk.pack_sku_code = l.sku_code and coalesce(pk.points_per_pack, 0) > 0
      join public.sku_registry sk on sk.sku_code = l.sku_code) z), '[]'::jsonb);
end $$;

-- ====================================================================================================================== 16 what a customer (or staff, about a customer) sees
create or replace function public.rw_pick_json(r public.rw_rules, p_profile uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('rule_id', r.id, 'rule_name', r.name, 'event_id', r.event_id, 'spend_step', r.spend_step, 'reward_amount', r.reward_amount,
    'earned', (select count(*) from public.rw_entitlements e where e.rule_id = r.id and e.profile_id = p_profile and e.status in ('available', 'used')),
    'used', (select count(*) from public.rw_entitlements e where e.rule_id = r.id and e.profile_id = p_profile and e.status = 'used'),
    'remaining', (select count(*) from public.rw_entitlements e where e.rule_id = r.id and e.profile_id = p_profile and e.status = 'available'),
    'bills', coalesce((select jsonb_agg(x.j order by x.ca desc, x.ono desc) from (
        select jsonb_build_object('order_id', b.order_id, 'order_no', b.order_no, 'created_at', b.created_at, 'eligible_amount', amt.v, 'rights', case when b.eligible then rt.n else 0 end,
                 'state', case when b.eligible then 'counted' when rt.any_row or b.status in ('cancelled', 'returned') then 'taken_back' else 'waiting_payment' end) as j,
               b.created_at as ca, b.order_no as ono
          from public.rw_bills(p_profile) b
          cross join lateral (select public.rw_rule_amount_for(r, b.order_id, b.items) as v) amt
          cross join lateral (select count(*) filter (where e.status in ('available', 'used'))::integer as n, count(*) > 0 as any_row
                                from public.rw_entitlements e where e.rule_id = r.id and e.source_order_id = b.order_id) rt
         where (public.rw_rule_counts(r, p_profile, b.order_id, b.created_at) and amt.v > 0 and (b.eligible or rt.any_row or b.status not in ('cancelled', 'returned'))) or rt.any_row
         order by b.created_at desc limit 50) x), '[]'::jsonb)) $$;

create or replace function public.rw_review_items(p_profile uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('entitlement_id', e.id, 'profile_id', e.profile_id, 'profile_name', p.display_name, 'rule_name', r.name,
           'selection_id', e.used_selection_id, 'board_name', sel.x ->> 'board_name', 'number', (sel.x ->> 'number')::integer, 'since', e.review_since) order by e.review_since, e.id), '[]'::jsonb)
  from public.rw_entitlements e join public.rw_rules r on r.id = e.rule_id left join public.profiles p on p.id = e.profile_id
  left join lateral (select public.rw_review_selection_info(e.used_selection_id) as x) sel on true
  where e.needs_review and (p_profile is null or e.profile_id = p_profile) $$;

-- p_staff: staff see the reason of a point adjustment, customers do not; customers see picks only while the boards are switched on
create or replace function public.rw_rewards_json(p_profile uuid, p_staff boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.rw_settings; picks jsonb := '[]'::jsonb; hist jsonb; pts integer;
begin
  select * into s from public.rw_settings where id;
  select coalesce(sum(points), 0)::integer into pts from public.rw_points_ledger where profile_id = p_profile;
  select coalesce(jsonb_agg(jsonb_build_object('at', x.created_at, 'points', x.points, 'kind', x.kind, 'note', case when x.kind = 'adjust' and not p_staff then null else x.note end, 'order_no', o.order_no)
                            order by x.id desc), '[]'::jsonb) into hist
    from (select * from public.rw_points_ledger where profile_id = p_profile order by id desc limit 20) x left join public.shop_orders o on o.id = x.order_id;
  if s.boards_enabled or p_staff then
    select coalesce(jsonb_agg(public.rw_pick_json(r, p_profile) order by r.created_at, r.id), '[]'::jsonb) into picks from public.rw_rules r
     where r.kind = 'board_pick' and (exists (select 1 from public.rw_entitlements e where e.rule_id = r.id and e.profile_id = p_profile)
            or (r.active and (r.only_profile_ids is null or p_profile = any (r.only_profile_ids)) and (r.ends_at is null or r.ends_at >= now())));
  end if;
  return jsonb_build_object('enabled', s.enabled, 'boards_enabled', s.boards_enabled, 'points', pts, 'points_history', hist, 'picks', picks, 'selections', public.rw_selections_json(p_profile));
end $$;

create or replace function public.rw_my_rewards()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; s public.rw_settings;
begin
  uid := public.shop_require_user();
  select * into s from public.rw_settings where id;
  if not s.enabled then
    return jsonb_build_object('enabled', false, 'boards_enabled', s.boards_enabled, 'points', 0, 'points_history', '[]'::jsonb, 'picks', '[]'::jsonb, 'selections', '[]'::jsonb); end if;
  begin
    perform public.rw_settle_profile(uid);                              -- self-heal: whatever is paid now is counted now
  exception when others then
    begin
      insert into public.rw_events_log (action, entity, entity_id, profile_id, detail)
        values ('settle_error', 'profile', uid::text, uid, jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm, 'source', 'rw_my_rewards'));
    exception when others then null; end;
  end;
  return public.rw_rewards_json(uid, false);
end $$;

-- ====================================================================================================================== 17 staff: customers, points, review queue
create or replace function public.rw_admin_customer(p_profile uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  perform public.rw_require_staff('see a customer''s rewards');
  select * into p from public.profiles where id = p_profile;
  if not found then raise exception 'NOT_FOUND'; end if;
  begin perform public.rw_settle_profile(p_profile);
  exception when others then
    begin
      insert into public.rw_events_log (action, entity, entity_id, profile_id, detail)
        values ('settle_error', 'profile', p_profile::text, p_profile, jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm, 'source', 'rw_admin_customer'));
    exception when others then null; end;
  end;
  return public.rw_rewards_json(p_profile, true) || jsonb_build_object('profile', jsonb_build_object('id', p.id, 'name', p.display_name, 'phone', p.phone),
           'needs_review', public.rw_review_items(p_profile));
end $$;

create or replace function public.rw_admin_adjust_points(p_profile uuid, p_points integer, p_reason text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_reason text := btrim(coalesce(p_reason, '')); bal integer;
begin
  perform public.rw_require_super('adjust points');
  if length(v_reason) < 3 then raise exception 'REASON_REQUIRED'; end if;
  if not coalesce((select enabled from public.rw_settings where id), false) then raise exception 'REWARDS_OFF'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 100000 then raise exception 'LIMIT_REACHED: an adjustment is between 1 and 100000 points'; end if;
  if not exists (select 1 from public.profiles where id = p_profile) then raise exception 'NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rw:' || p_profile::text, 0));
  select coalesce(sum(points), 0)::integer into bal from public.rw_points_ledger where profile_id = p_profile;
  if bal + p_points < 0 then raise exception 'LIMIT_REACHED: the balance (%) cannot go below zero', bal; end if;
  insert into public.rw_points_ledger (profile_id, points, kind, source_key, note, created_by) values (p_profile, p_points, 'adjust', 'adjust', left(v_reason, 300), auth.uid());
  perform public.rw_log('points.adjust', 'profile', p_profile::text, p_profile, v_reason, jsonb_build_object('points', p_points, 'balance_before', bal));
  return bal + p_points;
end $$;

create or replace function public.rw_admin_resettle(p_profile uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ids uuid[]; x uuid; changed integer := 0; total integer := 1;
begin
  perform public.rw_require_staff('re-settle rewards');
  if not coalesce((select enabled from public.rw_settings where id), false) then raise exception 'REWARDS_OFF'; end if;
  if p_profile is not null then ids := array[p_profile];
  else
    -- at most 100 customers per call (most recent buyers first): every customer's advisory lock is held until this transaction ends, so an unbounded list would make
    -- every payment settle of those customers wait (and time out) and could exhaust lock memory. `remaining` says how many were left; each customer is also healed
    -- by their own next visit to Rewards.
    select count(distinct o.profile_id)::integer into total from public.shop_orders o where o.created_at > now() - interval '90 days';
    select coalesce(array_agg(q.profile_id), '{}') into ids
      from (select o.profile_id from public.shop_orders o where o.created_at > now() - interval '90 days' group by o.profile_id order by max(o.created_at) desc, o.profile_id limit 100) q;
  end if;
  foreach x in array ids loop changed := changed + public.rw_settle_profile(x); end loop;
  perform public.rw_log('resettle', 'profile', coalesce(p_profile::text, 'recent'), p_profile, null,
    jsonb_build_object('profiles', cardinality(ids), 'changed', changed, 'remaining', greatest(total - cardinality(ids), 0)));
  return jsonb_build_object('profiles', cardinality(ids), 'changed', changed, 'remaining', greatest(total - cardinality(ids), 0));
end $$;

create or replace function public.rw_admin_review_queue()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.rw_require_staff('see the rewards review queue');
  return public.rw_review_items(null);
end $$;

create or replace function public.rw_admin_resolve_review(p_entitlement uuid, p_action text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.rw_entitlements; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public.rw_require_super('resolve a rewards review');
  if length(v_reason) < 3 then raise exception 'REASON_REQUIRED'; end if;
  if p_action is null or p_action not in ('keep', 'release') then raise exception 'BAD_RULE: the action is keep or release'; end if;
  select * into e from public.rw_entitlements where id = p_entitlement;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rw:' || e.profile_id::text, 0));          -- the same lock settle takes
  select * into e from public.rw_entitlements where id = p_entitlement for update;
  if not e.needs_review then raise exception 'NOT_FOUND'; end if;
  if p_action = 'keep' then
    update public.rw_entitlements set kept = true, needs_review = false, review_since = null where id = e.id;
  else
    update public.rw_entitlements set status = 'revoked', needs_review = false, review_since = null, revoked_reason = left('released by staff: ' || v_reason, 300), revoked_at = now() where id = e.id;
    if e.used_selection_id is not null then perform public.rw_release_selection_for_review(e.used_selection_id, v_reason); end if;
  end if;
  perform public.rw_log('review.' || p_action, 'entitlement', e.id::text, e.profile_id, v_reason, jsonb_build_object('selection', e.used_selection_id, 'rule', e.rule_id));
  return public.rw_review_items(null);
end $$;

-- ====================================================================================================================== 18 privileges
-- Every function starts with no access for anyone; only the functions a signed-in client calls are opened to members (each checks the role itself).
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function
  public.rw_settings_public(), public.rw_admin_save_settings(jsonb), public.rw_admin_rules(), public.rw_admin_save_rule(uuid, jsonb), public.rw_admin_set_rule_active(uuid, boolean),
  public.rw_admin_packs(), public.rw_admin_create_pack(uuid, text, numeric, jsonb, jsonb), public.rw_admin_save_pack(text, jsonb), public.rw_admin_sku_search(text, boolean, integer),
  public.rw_admin_customer_search(text, integer), public.rw_preview_cart(jsonb), public.rw_admin_simulate(jsonb, uuid), public.rw_my_rewards(), public.rw_admin_customer(uuid),
  public.rw_admin_adjust_points(uuid, integer, text), public.rw_admin_resettle(uuid), public.rw_admin_review_queue(), public.rw_admin_resolve_review(uuid, text, text)
  to authenticated;
