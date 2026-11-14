-- Automatic, backend-generated SKU codes:  FG-000001 / RM-000001 / WIP-000001  (one running number per category).
--
-- Design
--   * public.sku_registry   = the central SKU table (the former public.sku_master, renamed; no row is deleted or lost).
--       sku_code          NEW code, derived from (sku_category, sku_seq) and enforced by a CHECK, so it can never be typed in by hand.
--       legacy_sku_code   the original code, kept for history, audit, migration validation and backward compatibility.
--   * public.sku_counters   = one monotonic counter per category. Numbers are only handed out by sku_issue() inside a
--                             transaction (row lock), so concurrent requests get distinct numbers, a failed request rolls its
--                             increment back (no gap, nothing reused) and a committed number is never issued twice.
--   * public.sku_issue()    internal (no execute grant). public.sku_reserve() is the staff-only RPC the app calls when a
--                             product is SAVED; client_ref makes retries / double clicks idempotent (same code, no number burned).
--   * public.sku_peek()     shows the next number without reserving it (preview only; the final number is assigned on save).
--   * public.sku_master     is now a read-only COMPATIBILITY VIEW that returns the legacy codes in the old shape, so the app
--                             build that is already deployed keeps working unchanged. Drop it once every client is updated.
--   * public.sku_master_backup_20261114 is a full copy of the table as it was before this migration (never dropped here).
--
-- Rollback: supabase/rollbacks/20261114200000_sku_auto_codes_down.sql

-- 0. Safety copy of the data before anything changes -------------------------------------------------------------------
create table public.sku_master_backup_20261114 as table public.sku_master;
alter table public.sku_master_backup_20261114 enable row level security;           -- no policy: only service role / postgres can read it
revoke all on public.sku_master_backup_20261114 from public, anon, authenticated;

-- 1. The real table gets its final name; everything (rows, indexes, policy, grants) moves with it ------------------------
alter table public.sku_master rename to sku_registry;
alter policy "sku_master: staff read" on public.sku_registry rename to "sku_registry: staff read";
alter table public.sku_registry rename constraint sku_master_pkey to sku_registry_pkey;
alter table public.sku_registry rename constraint sku_master_migration_key_key to sku_registry_migration_key_key;
alter index public.sku_master_domain_idx rename to sku_registry_domain_idx;
alter index public.sku_master_barcode_key rename to sku_registry_barcode_key;
revoke references, trigger on public.sku_registry from authenticated;

-- Rows registered from the app are not workbook imports: relax the two import-only NOT NULLs.
alter table public.sku_registry alter column source_code drop not null, alter column migration_key drop not null;
alter table public.sku_registry
  add column legacy_sku_code text,
  add column sku_category    text,
  add column sku_seq         bigint,
  add column origin          text not null default 'app' check (origin in ('import', 'app')),
  add column client_ref      uuid,
  add column created_by      uuid;

-- 2. Code format (single place to change it). Immutable so it can be used in a CHECK. Never truncates past 6 digits. ------
create or replace function public.sku_format(p_category text, p_seq bigint)
returns text language sql immutable as $$
  select p_category || '-' || case when p_seq < 1000000 then lpad(p_seq::text, 6, '0') else p_seq::text end
$$;

-- 3. Counters, history ----------------------------------------------------------------------------------------------------
create table public.sku_counters (
  category   text primary key check (category in ('FG', 'RM', 'WIP')),
  last_seq   bigint not null default 0 check (last_seq >= 0),
  updated_at timestamptz not null default now()
);
insert into public.sku_counters (category, last_seq) values ('FG', 0), ('RM', 0), ('WIP', 0);
alter table public.sku_counters enable row level security;                          -- no policy: only the SECURITY DEFINER functions touch it
revoke all on public.sku_counters from public, anon, authenticated;

create table public.sku_code_history (
  id              bigint generated always as identity primary key,
  sku_code        text not null,
  legacy_sku_code text,
  action          text not null check (action in ('migrated', 'issued', 'void')),
  note            text,
  actor           uuid,
  at              timestamptz not null default now()
);
create index sku_code_history_code_idx on public.sku_code_history (sku_code);
alter table public.sku_code_history enable row level security;
create policy "sku_code_history: staff read" on public.sku_code_history for select to authenticated using (public.feedback_is_staff());
revoke all on public.sku_code_history from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.sku_code_history from authenticated;
grant select on public.sku_code_history to authenticated;

-- 4. Backfill: every existing code is kept in legacy_sku_code, and gets a new FG code (all 145 current rows are finished
--    goods: "Kratom drink (Stock FG)" and "POD / vape (Ref POD)"). Order = migration_key, so the result is stable. ----------
do $$
declare v_unknown text;
begin
  select string_agg(distinct domain, ', ') into v_unknown from public.sku_registry
   where domain not in ('Kratom drink (Stock FG)', 'POD / vape (Ref POD)');
  if v_unknown is not null then
    raise exception 'Unmapped SKU domain(s), refusing to guess a category: %', v_unknown;
  end if;
  if exists (select 1 from public.sku_registry where sku_code ~ '^(FG|RM|WIP)-[0-9]{6,}$') then
    raise exception 'An existing code already looks like a new-format code; refusing to renumber';
  end if;
end $$;

with ordered as (
  select sku_code as old_code, row_number() over (order by migration_key, sku_code) as rn
    from public.sku_registry
)
update public.sku_registry r
   set legacy_sku_code = r.sku_code,
       sku_category    = 'FG',
       sku_seq         = o.rn,
       sku_code        = public.sku_format('FG', o.rn),
       origin          = 'import'
  from ordered o
 where r.sku_code = o.old_code;

insert into public.sku_code_history (sku_code, legacy_sku_code, action, note)
select sku_code, legacy_sku_code, 'migrated', 'Renumbered by 20261114200000_sku_auto_codes' from public.sku_registry order by sku_seq;

update public.sku_counters c set last_seq = coalesce((select max(r.sku_seq) from public.sku_registry r where r.sku_category = c.category), 0);

-- 5. Constraints and indexes (after the backfill) -------------------------------------------------------------------------
alter table public.sku_registry
  alter column sku_category set not null,
  alter column sku_seq set not null,
  add constraint sku_registry_category_chk    check (sku_category in ('FG', 'RM', 'WIP')),
  add constraint sku_registry_seq_chk         check (sku_seq > 0),
  add constraint sku_registry_code_format_chk check (sku_code = public.sku_format(sku_category, sku_seq)),
  add constraint sku_registry_seq_key         unique (sku_category, sku_seq),
  add constraint sku_registry_legacy_key      unique (legacy_sku_code),
  add constraint sku_registry_client_ref_key  unique (client_ref);
create index sku_registry_category_idx on public.sku_registry (sku_category, sku_seq);

-- Codes are immutable and rows are never deleted (a code that is not needed any more is voided, never reused).
create or replace function public.sku_registry_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'SKU codes are never deleted; void the code instead' using errcode = '23001';
  end if;
  if new.sku_code is distinct from old.sku_code or new.sku_category is distinct from old.sku_category
     or new.sku_seq is distinct from old.sku_seq or new.legacy_sku_code is distinct from old.legacy_sku_code then
    raise exception 'SKU codes and legacy codes are immutable' using errcode = '23001';
  end if;
  return new;
end $$;
create trigger sku_registry_guard before update or delete on public.sku_registry for each row execute function public.sku_registry_guard();

-- 6. Issuing codes ---------------------------------------------------------------------------------------------------------
create or replace function public.sku_issue(p_category text, p_name text, p_client_ref uuid, p_actor uuid)
returns table (code text, seq bigint, reused boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_seq   bigint;
  v_code  text;
  v_label text;
  v_row   public.sku_registry%rowtype;
begin
  if p_category is null or p_category not in ('FG', 'RM', 'WIP') then
    raise exception 'Unknown SKU category: %', coalesce(p_category, '(null)') using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'A product name is required to issue a SKU code' using errcode = '22023';
  end if;
  v_label := case p_category when 'FG' then 'Finished goods (FG)' when 'RM' then 'Raw materials (RM)' else 'Work in process (WIP)' end;

  -- Idempotent retry: the same request id always returns the code it already got.
  if p_client_ref is not null then
    select * into v_row from public.sku_registry r where r.client_ref = p_client_ref;
    if found then
      if v_row.sku_category <> p_category then
        raise exception 'This request id was already used for category %', v_row.sku_category using errcode = '22023';
      end if;
      return query select v_row.sku_code, v_row.sku_seq, true;
      return;
    end if;
  end if;

  begin
    update public.sku_counters c set last_seq = c.last_seq + 1, updated_at = now()
     where c.category = p_category returning c.last_seq into v_seq;
    if v_seq is null then raise exception 'SKU counter for % is missing', p_category; end if;
    v_code := public.sku_format(p_category, v_seq);
    insert into public.sku_registry (sku_code, sku_category, sku_seq, name_full, domain, origin, status, client_ref, created_by)
    values (v_code, p_category, v_seq, btrim(p_name), v_label, 'app', 'active', p_client_ref, p_actor);
    insert into public.sku_code_history (sku_code, action, actor, note) values (v_code, 'issued', p_actor, btrim(p_name));
  exception when unique_violation then
    -- A concurrent request with the same client_ref committed first. This sub-transaction (and its counter bump) is rolled
    -- back, so no number is burned; return the winner's code.
    select * into v_row from public.sku_registry r where r.client_ref = p_client_ref;
    if not found then raise; end if;
    return query select v_row.sku_code, v_row.sku_seq, true;
    return;
  end;
  return query select v_code, v_seq, false;
end $$;

create or replace function public.sku_reserve(p_category text, p_name text, p_client_ref uuid default null)
returns table (code text, seq bigint, reused boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.feedback_is_staff() then
    raise exception 'Only staff can issue SKU codes' using errcode = '42501';
  end if;
  return query select i.code, i.seq, i.reused from public.sku_issue(p_category, p_name, p_client_ref, auth.uid()) i;
end $$;

create or replace function public.sku_peek(p_category text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_last bigint;
begin
  if not public.feedback_is_staff() then
    raise exception 'Only staff can preview SKU codes' using errcode = '42501';
  end if;
  select c.last_seq into v_last from public.sku_counters c where c.category = p_category;
  if v_last is null then raise exception 'Unknown SKU category: %', coalesce(p_category, '(null)') using errcode = '22023'; end if;
  return public.sku_format(p_category, v_last + 1);
end $$;

-- A reserved code whose product was never saved is voided, not reused.
create or replace function public.sku_void(p_code text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.feedback_is_staff() then
    raise exception 'Only staff can void SKU codes' using errcode = '42501';
  end if;
  update public.sku_registry set status = 'inactive', updated_at = now() where sku_code = p_code and origin = 'app';
  if not found then raise exception 'Only codes created in the app can be voided: %', p_code using errcode = '22023'; end if;
  insert into public.sku_code_history (sku_code, action, actor, note) values (p_code, 'void', auth.uid(), nullif(btrim(coalesce(p_reason, '')), ''));
end $$;

revoke all on function public.sku_issue(text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.sku_reserve(text, text, uuid) from public, anon;
revoke all on function public.sku_peek(text) from public, anon;
revoke all on function public.sku_void(text, text) from public, anon;
grant execute on function public.sku_reserve(text, text, uuid) to authenticated;
grant execute on function public.sku_peek(text) to authenticated;
grant execute on function public.sku_void(text, text) to authenticated;

-- 7. Compatibility view for the already-deployed client: same name, same columns, LEGACY codes, imports only. -------------
create view public.sku_master with (security_invoker = true) as
select legacy_sku_code as sku_code, source_code, migration_key, domain, brand, name_en, name_th, name_full, product_type, pack_qty,
       unit_en, unit_th, cost_price, retail_price, selling_price, friend_price, wholesale_price, ecommerce_price, barcode, status,
       tax_category, needs_review, review_notes, source_sheet, source_row, imported_at, updated_at
  from public.sku_registry
 where origin = 'import';
revoke all on public.sku_master from public, anon, authenticated;
grant select on public.sku_master to authenticated;
comment on view public.sku_master is 'DEPRECATED compatibility view for app builds from before 2026-11-14: exposes the LEGACY codes. Drop it once every client reads public.sku_registry.';
comment on table public.sku_registry is 'Central SKU registry. sku_code = new automatic code (FG-/RM-/WIP- + running number); legacy_sku_code = original code. Rows are never deleted.';
