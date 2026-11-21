-- Rolls back 20261121120000_sku_registry_sync.sql: the change log, its three registry triggers (lock, updated_at, diff), the four client functions and the internal helpers go;
-- sku_code_history gets its original three-action check back. sku_registry itself, sku_registry_guard, sku_issue / sku_reserve / sku_peek / sku_void and every row are untouched.
-- The change log is an AUDIT log: this refuses once it holds a row (or sku_code_history holds a deactivated / reactivated row, which the old check would reject). Export the rows
-- and clear them by hand first if you really want to roll back after the feature was used. Run in the same order as the migration's objects, children first.

do $$
begin
  if exists (select 1 from public.sku_registry_changes) then
    raise exception 'The SKU change log holds rows (an audit log); refusing to drop it. Export them first, then drop the table by hand if you really mean to roll back.';
  end if;
  if exists (select 1 from public.sku_code_history where action in ('deactivated', 'reactivated')) then
    raise exception 'sku_code_history holds deactivated / reactivated rows that the original action check would reject; refusing to roll back.';
  end if;
end $$;

-- DROP TRIGGER needs an ACCESS EXCLUSIVE lock on the registry: fail fast instead of queuing behind (and blocking) customers
set local lock_timeout = '3s';
drop trigger sku_registry_log   on public.sku_registry;
drop trigger sku_registry_touch on public.sku_registry;
drop trigger sku_registry_lock  on public.sku_registry;

drop function public.sku_change_log(text, integer, integer);
drop function public.sku_set_details(text, jsonb);
drop function public.sku_set_status(text, text, text);
drop function public.sku_changes_since(bigint);
drop function public.sku_registry_row_json(public.sku_registry);
drop function public.sku_registry_log();
drop function public.sku_registry_touch();
drop function public.sku_registry_lock();
drop function public.sku_changes_lock();

drop table public.sku_registry_changes;                 -- takes its index, its two guard triggers and its id sequence with it
drop function public.sku_registry_changes_guard();

alter table public.sku_code_history drop constraint sku_code_history_action_check;
alter table public.sku_code_history add constraint sku_code_history_action_check check (action in ('migrated', 'issued', 'void'));
