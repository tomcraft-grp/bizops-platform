-- Rollback for 20261114200000_sku_auto_codes.sql. Run as postgres (service role), in one transaction.
--
-- It restores public.sku_master as a real table holding the ORIGINAL codes, exactly as before the migration, and removes
-- the automatic-code machinery. It REFUSES to run if any code has been issued from the app since (those rows have no legacy
-- code and would be lost): in that case export them first and decide deliberately.
-- public.sku_master_backup_20261114 is left in place on purpose.

do $$
declare v_app bigint;
begin
  select count(*) into v_app from public.sku_registry where origin = 'app';
  if v_app > 0 then
    raise exception 'Refusing to roll back: % SKU code(s) were issued from the app and would be lost', v_app;
  end if;
end $$;

drop view if exists public.sku_master;
drop trigger if exists sku_registry_guard on public.sku_registry;
drop function if exists public.sku_registry_guard();
drop function if exists public.sku_reserve(text, text, uuid);
drop function if exists public.sku_peek(text);
drop function if exists public.sku_void(text, text);
drop function if exists public.sku_issue(text, text, uuid, uuid);

alter table public.sku_registry
  drop constraint sku_registry_code_format_chk, drop constraint sku_registry_category_chk, drop constraint sku_registry_seq_chk,
  drop constraint sku_registry_seq_key, drop constraint sku_registry_legacy_key, drop constraint sku_registry_client_ref_key;
drop index if exists public.sku_registry_category_idx;

update public.sku_registry set sku_code = legacy_sku_code where legacy_sku_code is not null;

alter table public.sku_registry
  drop column legacy_sku_code, drop column sku_category, drop column sku_seq, drop column origin, drop column client_ref, drop column created_by;
alter table public.sku_registry alter column source_code set not null, alter column migration_key set not null;
alter policy "sku_registry: staff read" on public.sku_registry rename to "sku_master: staff read";
alter table public.sku_registry rename constraint sku_registry_pkey to sku_master_pkey;
alter table public.sku_registry rename constraint sku_registry_migration_key_key to sku_master_migration_key_key;
alter index public.sku_registry_domain_idx rename to sku_master_domain_idx;
alter index public.sku_registry_barcode_key rename to sku_master_barcode_key;
alter table public.sku_registry rename to sku_master;

drop function if exists public.sku_format(text, bigint);
drop table if exists public.sku_counters;
drop table if exists public.sku_code_history;
