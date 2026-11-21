-- SKU registry change feed: devices sync the central SKU registry incrementally with a cursor and can never miss a committed change.
--
-- Design
--   * public.sku_registry_changes   append-only log: one row per registry write that changed a registry-owned column (name_full, brand, product_type, domain,
--                                   pack_qty, unit_en, unit_th, barcode, status, the six prices, needs_review, review_notes): sku_code, actor, changes = {field: {old, new}}.
--                                   Its id is the sync CURSOR. No client role can touch the table (RLS on, no policy, no grant): staff read it only through the functions.
--   * CURSOR SAFETY (the hard part). A plain bigserial can hand id 5 to a transaction that commits AFTER id 6 was already committed and read: a device holding cursor 6
--     would skip change 5 forever. Therefore the id is taken by hand (the column has NO default) and only after a transaction-scoped advisory lock on a constant key:
--     ids are handed out in lock order and the lock is held until COMMIT, so id order = commit order and a reader that has seen id N has seen every change below N
--     (a rolled-back transaction leaves a harmless hole). PostgreSQL makes a transaction visible before it releases its locks, so the next writer's snapshot-mates see
--     the earlier one as well. Registry writes are rare staff actions; serialising them is fine.
--       - a BEFORE STATEMENT trigger on sku_registry takes the lock before any row is touched: a transaction that writes several rows never holds a row lock while it
--         waits for the advisory lock, so two multi-row writers cannot deadlock on (row lock, advisory lock);
--       - the AFTER ROW trigger takes it again (re-entrant, free) before nextval, so the order never depends on the statement trigger;
--       - the functions below take it first, before any SELECT ... FOR UPDATE.
--     RULE for later code: a transaction that writes the registry AND calls sku_issue() must call sku_issue() FIRST (sku_issue locks its counter row, then writes the
--     registry; the other order could deadlock with a concurrent sku_issue). Proof: scripts/local-pg/sku-sync-concurrency.mjs.
--   * sku_registry_touch   BEFORE UPDATE: maintains updated_at (only when something really changed and the statement did not set it itself).
--   * sku_registry_log     AFTER INSERT OR UPDATE: writes the diff. sku_issue() inserts the new app SKU through the same trigger, so it appears in the feed.
--   * They coexist with sku_registry_guard (codes immutable, rows never deleted), which is untouched.
--   * sku_changes_since(cursor)  staff; null cursor = every row of every origin (full = true); otherwise the rows whose id is above the cursor, one (latest) row per SKU.
--                                A cursor ahead of the server (restored or foreign database) also gets the full snapshot.
--   * sku_set_status / sku_set_details  staff; the only writes a device makes. sku_code_history gets two new actions (deactivated, reactivated) so the reason is kept.
--   * sku_change_log(code, limit, offset)  staff; newest first.
-- Error contract: 'CODE: detail' (BAD_STATUS, REASON_REQUIRED, NOT_FOUND, BAD_FIELD, BAD_VALUE, BARCODE_TAKEN); non-staff = errcode 42501.
--
-- Rollback: supabase/rollbacks/20261121120000_sku_registry_sync_down.sql (refuses once the log holds rows: it is an audit log)

-- 1. The log ---------------------------------------------------------------------------------------------------------------------------------------
create table public.sku_registry_changes (
  id       bigint primary key,                                      -- no default: only the trigger hands out ids, under the lock (see above)
  at       timestamptz not null default clock_timestamp(),
  sku_code text not null,
  actor    uuid,                                                    -- auth.uid(); null for a direct database / migration write
  changes  jsonb not null check (jsonb_typeof(changes) = 'object' and changes <> '{}'::jsonb)
);
create sequence public.sku_registry_changes_id_seq as bigint owned by public.sku_registry_changes.id;
create index sku_registry_changes_code_idx on public.sku_registry_changes (sku_code, id desc);
alter table public.sku_registry_changes enable row level security;    -- no policy: nobody reads it directly
revoke all on public.sku_registry_changes from public, anon, authenticated;
revoke all on sequence public.sku_registry_changes_id_seq from public, anon, authenticated;
comment on table public.sku_registry_changes is 'Append-only change log of sku_registry; id = sync cursor, handed out in commit order under an advisory lock. Read through sku_changes_since / sku_change_log only.';

create or replace function public.sku_registry_changes_guard() returns trigger language plpgsql as $$
begin
  raise exception 'The SKU change log is append-only' using errcode = '23001';
end $$;
create trigger sku_registry_changes_guard    before update or delete on public.sku_registry_changes for each row       execute function public.sku_registry_changes_guard();
create trigger sku_registry_changes_truncate before truncate          on public.sku_registry_changes for each statement execute function public.sku_registry_changes_guard();

-- 2. The lock ----------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.sku_changes_lock() returns void language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtextextended('public.sku_registry_changes', 0))
$$;
revoke all on function public.sku_changes_lock() from public, anon, authenticated;

create or replace function public.sku_registry_lock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sku_changes_lock();          -- before any row of this statement is locked
  return null;
end $$;
create trigger sku_registry_lock before insert or update on public.sku_registry for each statement execute function public.sku_registry_lock();

-- 3. updated_at and the diff ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.sku_registry_touch() returns trigger language plpgsql set search_path = public as $$
begin
  if new.updated_at is not distinct from old.updated_at and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger sku_registry_touch before update on public.sku_registry for each row execute function public.sku_registry_touch();

create or replace function public.sku_registry_log() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new  jsonb := to_jsonb(new);
  v_diff jsonb;
begin
  select jsonb_object_agg(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k)) into v_diff
    from unnest(array['name_full', 'brand', 'product_type', 'domain', 'pack_qty', 'unit_en', 'unit_th', 'barcode', 'status',
                      'cost_price', 'retail_price', 'selling_price', 'friend_price', 'wholesale_price', 'ecommerce_price', 'needs_review', 'review_notes']) as k
   where coalesce(v_old -> k, 'null'::jsonb) is distinct from coalesce(v_new -> k, 'null'::jsonb);
  if v_diff is null then return null; end if;                  -- nothing the feed carries changed
  perform public.sku_changes_lock();                           -- BEFORE nextval: ids are handed out in lock order, the lock lasts until commit
  insert into public.sku_registry_changes (id, at, sku_code, actor, changes)
  values (nextval('public.sku_registry_changes_id_seq'), clock_timestamp(), new.sku_code, auth.uid(), v_diff);
  return null;
end $$;
create trigger sku_registry_log after insert or update on public.sku_registry for each row execute function public.sku_registry_log();

-- 4. History actions for status changes (the reason lives in sku_code_history.note) ------------------------------------------------------------------------
alter table public.sku_code_history drop constraint sku_code_history_action_check;
alter table public.sku_code_history add constraint sku_code_history_action_check check (action in ('migrated', 'issued', 'void', 'deactivated', 'reactivated'));

-- 5. One registry row as the feed shows it ---------------------------------------------------------------------------------------------------------------
create or replace function public.sku_registry_row_json(r public.sku_registry) returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'sku_code', r.sku_code, 'legacy_sku_code', r.legacy_sku_code, 'sku_category', r.sku_category, 'origin', r.origin, 'name_full', r.name_full,
    'brand', r.brand, 'product_type', r.product_type, 'domain', r.domain, 'pack_qty', r.pack_qty, 'unit_en', r.unit_en, 'unit_th', r.unit_th,
    'barcode', r.barcode, 'status', r.status, 'cost_price', r.cost_price, 'retail_price', r.retail_price, 'selling_price', r.selling_price,
    'friend_price', r.friend_price, 'wholesale_price', r.wholesale_price, 'ecommerce_price', r.ecommerce_price,
    'needs_review', r.needs_review, 'review_notes', r.review_notes, 'updated_at', r.updated_at)
$$;
revoke all on function public.sku_registry_row_json(public.sku_registry) from public, anon, authenticated;

-- 6. The feed --------------------------------------------------------------------------------------------------------------------------------------------
-- STABLE: every statement inside sees the caller's one snapshot, so the highest id and the rows are read together. (Even a snapshot taken per statement would be safe:
-- ids are bounded by the highest one read first, and a later snapshot sees at least as much.)
create or replace function public.sku_changes_since(p_cursor bigint default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_max  bigint;
  v_full boolean;
  v_rows jsonb;
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can read the SKU change feed' using errcode = '42501'; end if;
  select coalesce(max(c.id), 0) into v_max from public.sku_registry_changes c;
  v_full := p_cursor is null or p_cursor > v_max;              -- a cursor from the future (restored / other database): start over
  if v_full then
    select coalesce(jsonb_agg(public.sku_registry_row_json(r) order by r.sku_category, r.sku_seq), '[]'::jsonb) into v_rows from public.sku_registry r;
  else
    select coalesce(jsonb_agg(public.sku_registry_row_json(r) order by l.last_id), '[]'::jsonb) into v_rows
      from (select c.sku_code, max(c.id) as last_id from public.sku_registry_changes c where c.id > p_cursor and c.id <= v_max group by c.sku_code) l
      join public.sku_registry r on r.sku_code = l.sku_code;
  end if;
  return jsonb_build_object('cursor', v_max, 'full', v_full, 'rows', v_rows);
end $$;

-- 7. Status: the Active switch ------------------------------------------------------------------------------------------------------------------------------
create or replace function public.sku_set_status(p_code text, p_status text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  r public.sku_registry;
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can change a SKU status' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('active', 'inactive') then raise exception 'BAD_STATUS: the status must be active or inactive'; end if;
  if v_reason is null then raise exception 'REASON_REQUIRED: say why the status changes'; end if;
  perform public.sku_changes_lock();                           -- first, before the row lock below
  select * into r from public.sku_registry where sku_code = p_code for no key update;
  if not found then raise exception 'NOT_FOUND: %', coalesce(p_code, '(none)'); end if;
  if r.status <> p_status then                                 -- the same status again changes nothing and logs nothing
    update public.sku_registry s set status = p_status where s.sku_code = p_code returning * into r;
    insert into public.sku_code_history (sku_code, legacy_sku_code, action, actor, note)
    values (p_code, r.legacy_sku_code, case p_status when 'inactive' then 'deactivated' else 'reactivated' end, auth.uid(), left(v_reason, 500));
  end if;
  return public.sku_registry_row_json(r);
end $$;

-- 8. Details: name, prices, barcode ... --------------------------------------------------------------------------------------------------------------------
-- Allowed keys: name_full, brand, unit_th, barcode, product_type (text), cost_price, selling_price, retail_price, ecommerce_price (number >= 0), pack_qty (number > 0).
-- JSON null clears brand, barcode, unit_th, product_type and pack_qty; the name and the four prices cannot be cleared. The whole patch applies or none of it.
create or replace function public.sku_set_details(p_code text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_text  constant text[] := array['name_full', 'brand', 'unit_th', 'barcode', 'product_type'];
  v_money constant text[] := array['cost_price', 'selling_price', 'retail_price', 'ecommerce_price'];
  r public.sku_registry;
  k text; j jsonb; s text; n numeric; v_other text;
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can change SKU details' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_VALUE: the patch must be a JSON object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (v_text) or k = any (v_money) or k = 'pack_qty') then raise exception 'BAD_FIELD: "%" cannot be changed here', k; end if;
  end loop;
  perform public.sku_changes_lock();                           -- first, before the row lock below
  select * into r from public.sku_registry where sku_code = p_code for no key update;
  if not found then raise exception 'NOT_FOUND: %', coalesce(p_code, '(none)'); end if;

  for k, j in select e.key, e.value from jsonb_each(p_patch) e loop
    if k = any (v_text) then
      if jsonb_typeof(j) = 'null' then s := null;
      elsif jsonb_typeof(j) = 'string' then s := nullif(btrim(j #>> '{}'), '');
      else raise exception 'BAD_VALUE: % must be text', k;
      end if;
      if s is not null and length(s) > 500 then raise exception 'BAD_VALUE: % is too long (500 characters at most)', k; end if;
      if k = 'name_full' and s is null then raise exception 'BAD_VALUE: the name cannot be empty'; end if;
      if    k = 'name_full'    then r.name_full := s;
      elsif k = 'brand'        then r.brand := s;
      elsif k = 'unit_th'      then r.unit_th := s;
      elsif k = 'barcode'      then r.barcode := s;
      else                          r.product_type := s;
      end if;
    elsif k = any (v_money) then
      if jsonb_typeof(j) <> 'number' then raise exception 'BAD_VALUE: % must be a number (a price cannot be cleared)', k; end if;
      n := (j #>> '{}')::numeric;
      if n < 0 or n > 9999999999.99 then raise exception 'BAD_VALUE: % must be between 0 and 9999999999.99', k; end if;
      if n <> round(n, 2) then raise exception 'BAD_VALUE: % must have at most 2 decimals (baht and satang), it is never rounded silently', k; end if;
      if    k = 'cost_price'    then r.cost_price := n;
      elsif k = 'selling_price' then r.selling_price := n;
      elsif k = 'retail_price'  then r.retail_price := n;
      else                           r.ecommerce_price := n;
      end if;
    else                                                       -- pack_qty
      if jsonb_typeof(j) = 'null' then r.pack_qty := null;
      elsif jsonb_typeof(j) = 'number' and (j #>> '{}')::numeric > 0 and (j #>> '{}')::numeric <= 1000000 then r.pack_qty := (j #>> '{}')::numeric;
      else raise exception 'BAD_VALUE: pack_qty must be a number above 0';
      end if;
    end if;
  end loop;

  if p_patch ? 'barcode' and r.barcode is not null then
    select s2.sku_code into v_other from public.sku_registry s2 where s2.barcode = r.barcode and s2.sku_code <> p_code limit 1;
    if found then raise exception 'BARCODE_TAKEN: % is already used by %', r.barcode, v_other; end if;
  end if;

  begin
    update public.sku_registry s set
      name_full = r.name_full, brand = r.brand, unit_th = r.unit_th, barcode = r.barcode, product_type = r.product_type, pack_qty = r.pack_qty,
      cost_price = r.cost_price, selling_price = r.selling_price, retail_price = r.retail_price, ecommerce_price = r.ecommerce_price
     where s.sku_code = p_code returning * into r;
  exception when unique_violation then
    raise exception 'BARCODE_TAKEN: % is already used by another product', r.barcode;
  end;
  return public.sku_registry_row_json(r);
end $$;

-- 9. The log, for the screen ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.sku_change_log(p_code text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.feedback_is_staff() then raise exception 'Only staff can read the SKU change log' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'at', x.at, 'sku_code', x.sku_code, 'actor_name', x.actor_name, 'changes', x.changes) order by x.id desc)
      from (select c.id, c.at, c.sku_code, c.changes, coalesce(nullif(btrim(p.display_name), ''), nullif(split_part(p.email, '@', 1), '')) as actor_name
              from public.sku_registry_changes c left join public.profiles p on p.id = c.actor
             where p_code is null or c.sku_code = p_code
             order by c.id desc limit v_limit offset v_offset) x), '[]'::jsonb);
end $$;

revoke all on function public.sku_changes_since(bigint) from public, anon;
revoke all on function public.sku_set_status(text, text, text) from public, anon;
revoke all on function public.sku_set_details(text, jsonb) from public, anon;
revoke all on function public.sku_change_log(text, integer, integer) from public, anon;
grant execute on function public.sku_changes_since(bigint) to authenticated;
grant execute on function public.sku_set_status(text, text, text) to authenticated;
grant execute on function public.sku_set_details(text, jsonb) to authenticated;
grant execute on function public.sku_change_log(text, integer, integer) to authenticated;
