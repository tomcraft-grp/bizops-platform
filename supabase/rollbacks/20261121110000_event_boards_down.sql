-- Rolls back 20261121110000_event_boards.sql: removes the event board tables, their guards, the three foreign keys the migration added to the core tables and every function it
-- created, and puts the three hook functions of 20261121100000_rewards_core.sql back to their empty bodies (no boards exist, so "my numbers" is empty).
--
-- REFUSES to run once any number was ever picked or reset (selections and resets are records: they are never deleted) and once any rule or any right points at an event
-- (dropping the events table would leave them pointing at nothing). Event and board CONFIGURATION that nobody has used (names, windows, ranges) is dropped with the tables;
-- the audit rows in rw_events_log stay (append-only, no foreign key to anything here).
-- The core migration (rewards_core) is NOT rolled back by this file; its own rollback file refuses while ledger or right rows exist.

do $guard$ begin
  if to_regclass('public.rw_selections') is not null then
    if exists (select 1 from public.rw_selections) then
      raise exception 'Board selections exist: they are records and cannot be rolled back.'; end if;
  end if;
  if to_regclass('public.rw_board_resets') is not null then
    if exists (select 1 from public.rw_board_resets) then
      raise exception 'Board resets exist: they are records and cannot be rolled back.'; end if;
  end if;
  if exists (select 1 from public.rw_rules where event_id is not null) then
    raise exception 'A rule points at an event: it cannot be rolled back (rules are never deleted).'; end if;
  if exists (select 1 from public.rw_entitlements where event_id is not null) then
    raise exception 'Rights to pick belong to an event: they cannot be rolled back.'; end if;
end $guard$;

-- ---------------------------------------------------------------------------------------------- functions (client API first, then helpers)
drop function if exists public.rw_board_rev(uuid);
drop function if exists public.rw_board_state(uuid);
drop function if exists public.rw_claim_number(uuid, uuid, integer, text);
drop function if exists public.rw_confirm_selection(uuid);
drop function if exists public.rw_admin_events();
drop function if exists public.rw_admin_save_event(uuid, jsonb);
drop function if exists public.rw_admin_set_event_status(uuid, text, text);
drop function if exists public.rw_admin_save_board(uuid, jsonb);
drop function if exists public.rw_admin_board(uuid);
drop function if exists public.rw_admin_log(uuid, integer, integer);
drop function if exists public.rw_sweep_holds(uuid);
drop function if exists public.rw_board_lock(uuid, text);
drop function if exists public.rw_board_unlock(uuid, text);
drop function if exists public.rw_board_set_mode(uuid, text, text);
drop function if exists public.rw_release_selection(uuid, text);
drop function if exists public.rw_board_reset(uuid, text, boolean, text);
drop function if exists public.rw_board_undo_reset(uuid, text);

-- the hooks go back to what the core migration shipped (identical definitions, privileges are kept by CREATE OR REPLACE)
create or replace function public.rw_selections_json(p_profile uuid)
returns jsonb language sql stable security definer set search_path = public as $$ select '[]'::jsonb $$;
create or replace function public.rw_review_selection_info(p_selection uuid)
returns jsonb language sql stable security definer set search_path = public as $$ select null::jsonb $$;
create or replace function public.rw_release_selection_for_review(p_selection uuid, p_reason text)
returns void language sql security definer set search_path = public as $$ select $$ ;

drop function if exists public.rw_sweep_board(uuid);
drop function if exists public.rw_return_pick(uuid, uuid);
drop function if exists public.rw_admin_board_json(uuid);
drop function if exists public.rw_event_json(uuid);
drop function if exists public.rw_board_view(uuid, uuid);
drop function if exists public.rw_board_json(uuid);
drop function if exists public.rw_event_rights(uuid, uuid);
drop function if exists public.rw_selection_json(public.rw_selections);
drop function if exists public.rw_lock_board(uuid);
drop function if exists public.rw_lock_profiles(uuid[]);
drop function if exists public.rw_settle_quiet(uuid, text);
drop function if exists public.rw_board_log(uuid, text, text, uuid, jsonb);
drop function if exists public.rw_need_reason(text);
drop function if exists public.rw_current_event();
drop function if exists public.rw_person_name(uuid);
drop function if exists public.rw_boards_live();

-- ---------------------------------------------------------------------------------------------- foreign keys on the core tables, then the tables (children first)
alter table public.rw_rules drop constraint if exists rw_rules_event_fk;
alter table public.rw_entitlements drop constraint if exists rw_entitlements_used_selection_fk;
alter table public.rw_entitlements drop constraint if exists rw_entitlements_event_fk;

drop table if exists public.rw_selections;
drop table if exists public.rw_board_resets;
drop table if exists public.rw_boards;
drop table if exists public.rw_events;

-- trigger functions (their triggers went with the tables)
drop function if exists public.rw_selections_mixed();
drop function if exists public.rw_selections_guard();
drop function if exists public.rw_resets_guard();
drop function if exists public.rw_events_make_boards();
drop function if exists public.rw_boards_guard();
drop function if exists public.rw_events_guard();
