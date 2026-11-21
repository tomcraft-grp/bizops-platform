-- Rolls back 20261121100000_rewards_core.sql: removes the three settle triggers, every rw_ function and the seven tables of the rewards core
-- (rw_settings, promo_packs, promo_pack_items, rw_rules, rw_points_ledger, rw_entitlements, rw_events_log). Nothing outside those objects is changed, except
-- that the SKUs of promotion packs created through the feature are voided (status 'inactive' + a 'void' row in sku_code_history): the registry never deletes a
-- code, and an orphaned pack SKU would otherwise stay in the shop as a plain product.
--
-- REFUSES to run once the feature holds records that would be destroyed or orphaned:
--   * any points-ledger row or any right (entitlement): they are the customers' balances and picks, and a ledger is never deleted;
--   * a promotion pack that has been sold (an order line carries its SKU), its contents and sales history would lose their meaning;
--   * the event-boards migration (20261121110000) still applied: roll that back first (it owns the foreign key to rw_events and the claim functions).
-- Settings, rules, unsold packs and the audit log carry no customer value; they are dropped with the tables.

do $guard$ begin
  if to_regclass('public.rw_points_ledger') is not null then
    if exists (select 1 from public.rw_points_ledger) then
      raise exception 'Reward points exist: the points ledger is a record and cannot be rolled back.'; end if;
  end if;
  if to_regclass('public.rw_entitlements') is not null then
    if exists (select 1 from public.rw_entitlements) then
      raise exception 'Board-pick rights exist: they are records and cannot be rolled back.'; end if;
  end if;
  if to_regclass('public.promo_packs') is not null then
    if exists (select 1 from public.promo_packs pk join public.shop_order_items i on i.sku_code = pk.pack_sku_code) then
      raise exception 'A promotion pack has been sold: it cannot be rolled back (switch it off in the back office instead).'; end if;
  end if;
  if to_regclass('public.rw_events') is not null or to_regclass('public.rw_selections') is not null or to_regclass('public.rw_boards') is not null then
    raise exception 'The event boards are still installed: roll back 20261121110000_event_boards first.'; end if;
end $guard$;

-- 1 the triggers that call settle (callers first). DROP TRIGGER takes an ACCESS EXCLUSIVE lock on the three busiest tables: fail fast instead of queuing behind payments.
set local lock_timeout = '3s';
drop trigger if exists rw_settle_after_receipt on public.finance_receipts;
drop trigger if exists rw_settle_after_allocation on public.finance_allocations;
drop trigger if exists rw_settle_after_order on public.shop_orders;

-- 2 void the pack SKUs this feature issued (unsold ones only: the guard above refused otherwise)
do $void$ begin
  if to_regclass('public.promo_packs') is not null then
    if to_regclass('public.sku_code_history') is not null then
      insert into public.sku_code_history (sku_code, action, note)
        select pk.pack_sku_code, 'void', 'Promotion pack removed by the rollback of 20261121100000_rewards_core' from public.promo_packs pk join public.sku_registry s on s.sku_code = pk.pack_sku_code where s.status = 'active';
    end if;
    update public.sku_registry set status = 'inactive', updated_at = now() where sku_code in (select pack_sku_code from public.promo_packs) and status = 'active';
  end if;
end $void$;

-- 3 the functions (before the tables: several take the rw_rules row type)
drop function if exists public.rw_admin_adjust_points(uuid, integer, text);
drop function if exists public.rw_admin_create_pack(uuid, text, numeric, jsonb, jsonb);
drop function if exists public.rw_admin_customer(uuid);
drop function if exists public.rw_admin_customer_search(text, integer);
drop function if exists public.rw_admin_packs();
drop function if exists public.rw_admin_resettle(uuid);
drop function if exists public.rw_admin_resolve_review(uuid, text, text);
drop function if exists public.rw_admin_review_queue();
drop function if exists public.rw_admin_rules();
drop function if exists public.rw_admin_save_pack(text, jsonb);
drop function if exists public.rw_admin_save_rule(uuid, jsonb);
drop function if exists public.rw_admin_save_settings(jsonb);
drop function if exists public.rw_admin_set_rule_active(uuid, boolean);
drop function if exists public.rw_admin_simulate(jsonb, uuid);
drop function if exists public.rw_admin_sku_search(text, boolean, integer);
drop function if exists public.rw_apply_picks(public.rw_rules, uuid, uuid, integer);
drop function if exists public.rw_bills(uuid);
drop function if exists public.rw_check_include_skus(text[]);
drop function if exists public.rw_check_pack_items(jsonb);
drop function if exists public.rw_items_sig(jsonb);
drop function if exists public.rw_j_money(jsonb, text, text);
drop function if exists public.rw_j_texts(jsonb, text, text);
drop function if exists public.rw_j_whole(jsonb, text, integer, text);
drop function if exists public.rw_log(text, text, text, uuid, text, jsonb, uuid, uuid);
drop function if exists public.rw_my_rewards();
drop function if exists public.rw_next_in(public.rw_rules, numeric);
drop function if exists public.rw_next_total(public.rw_rules, numeric);
drop function if exists public.rw_norm_items(jsonb);
drop function if exists public.rw_pack_json(text);
drop function if exists public.rw_pick_json(public.rw_rules, uuid);
drop function if exists public.rw_points_targets(uuid);
drop function if exists public.rw_preview_cart(jsonb);
drop function if exists public.rw_release_selection_for_review(uuid, text);
drop function if exists public.rw_review_items(uuid);
drop function if exists public.rw_review_selection_info(uuid);
drop function if exists public.rw_reward_for(public.rw_rules, numeric);
drop function if exists public.rw_rewards_json(uuid, boolean);
drop function if exists public.rw_rule_amount(public.rw_rules, jsonb);
drop function if exists public.rw_rule_amount_for(public.rw_rules, uuid, jsonb);
drop function if exists public.rw_rule_counts(public.rw_rules, uuid, uuid, timestamp with time zone);
drop function if exists public.rw_rule_applies(public.rw_rules, uuid, timestamp with time zone);
drop function if exists public.rw_rule_json(public.rw_rules);
drop function if exists public.rw_selections_json(uuid);
drop function if exists public.rw_settings_public();
drop function if exists public.rw_settle_profile(uuid);
drop function if exists public.rw_trigger_settle(uuid, uuid, text);
drop function if exists public.rw_trg_allocation();
drop function if exists public.rw_trg_order();
drop function if exists public.rw_trg_receipt();

-- 4 the tables (their guard triggers go with them), children first
drop table if exists public.rw_bill_eligible;
drop table if exists public.rw_entitlements;
drop table if exists public.rw_points_ledger;
-- the audit log is a record of who did what: keep a copy (staff-only, no client access) instead of destroying it
create table if not exists public.rw_events_log_archive as table public.rw_events_log;
alter table public.rw_events_log_archive enable row level security;
revoke all on table public.rw_events_log_archive from public, anon, authenticated;
drop table if exists public.rw_events_log;
drop table if exists public.rw_rules;
drop table if exists public.promo_pack_items;
drop table if exists public.promo_packs;
drop table if exists public.rw_settings;

-- 5 the functions the tables' triggers used (after the tables, which no longer reference them)
drop function if exists public.rw_guard_entitlement();
drop function if exists public.rw_guard_pack();
drop function if exists public.rw_guard_pack_item();
drop function if exists public.rw_guard_rule();
drop function if exists public.rw_stamp_rule_activation();
drop function if exists public.rw_no_change();
drop function if exists public.rw_pack_sold(text);
drop function if exists public.rw_rule_used(uuid);
drop function if exists public.rw_is_staff();
drop function if exists public.rw_is_super();
drop function if exists public.rw_require_staff(text);
drop function if exists public.rw_require_super(text);

-- 6 nothing of the feature may be left behind
do $left$ declare v text; begin
  select string_agg(p.oid::regprocedure::text, ', ') into v from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'rw\_%';
  if v is not null then raise exception 'Rollback incomplete, functions left: %', v; end if;
  select string_agg(c.relname, ', ') into v from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'S', 'v') and (c.relname like 'rw\_%' or c.relname like 'promo\_pack%')
     and c.relname <> 'rw_events_log_archive';              -- the one thing kept ON PURPOSE: the audit trail of what staff did (staff-only, no client access)
  if v is not null then raise exception 'Rollback incomplete, relations left: %', v; end if;
end $left$;
