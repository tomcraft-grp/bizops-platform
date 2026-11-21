-- Tests for 20261121120000_sku_registry_sync.sql (SKU registry change feed), run inside ONE transaction that is rolled back:
--   <migration> ; <this file>          (scripts/run-sku-registry-sync-sql-tests.sh; locally: node scripts/local-pg/run.mjs <migration> <this file>)
-- Nothing persists: the last statement raises an exception that carries the result table.
-- Every check goes through pg_temp helpers that catch errors, so a missing function shows up as FAIL rows (red phase), never as an aborted run.
-- The multi-session guarantee (a cursor can never skip a committed change) cannot be shown in one transaction: see scripts/local-pg/sku-sync-concurrency.mjs.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;

-- t(test, expr): PASS when `select (expr)` is true. An error is a FAIL that carries the message.
create or replace function pg_temp.t(p_test text, p_expr text) returns void language plpgsql as $$
declare v boolean;
begin
  execute 'select coalesce((' || p_expr || ')::boolean, false)' into v;
  insert into t_res (test, ok, detail) values (p_test, v, case when v then null else 'false: ' || left(p_expr, 300) end);
exception when others then
  insert into t_res (test, ok, detail) values (p_test, false, 'error ' || sqlstate || ': ' || left(sqlerrm, 300));
end $$;
-- eq(test, expr, expected): PASS when `select (expr)::text` equals the expected text.
create or replace function pg_temp.eq(p_test text, p_expr text, p_expected text) returns void language plpgsql as $$
declare v text;
begin
  execute 'select (' || p_expr || ')::text' into v;
  insert into t_res (test, ok, detail) values (p_test, v is not distinct from p_expected, 'got ' || coalesce(v, '(null)') || ', expected ' || coalesce(p_expected, '(null)'));
exception when others then
  insert into t_res (test, ok, detail) values (p_test, false, 'error ' || sqlstate || ': ' || left(sqlerrm, 300));
end $$;
-- err(test, sql, sqlstate, pattern): PASS when the statement fails with that SQLSTATE and (when given) a message matching the pattern.
create or replace function pg_temp.err(p_test text, p_sql text, p_state text, p_pat text default null) returns void language plpgsql as $$
declare m text; s text;
begin
  begin execute p_sql; insert into t_res (test, ok, detail) values (p_test, false, 'no error (expected ' || p_state || ')');
  exception when others then
    get stacked diagnostics s = returned_sqlstate, m = message_text;
    insert into t_res (test, ok, detail) values (p_test, s = p_state and (p_pat is null or m ilike p_pat), s || ': ' || m);
  end;
end $$;
-- setc(k, sql): stores the text result of a statement in t_ctx (errors are stored as 'ERR ...' so the checks that use them fail instead of aborting).
create or replace function pg_temp.setc(p_k text, p_sql text) returns void language plpgsql as $$
declare v text;
begin
  begin execute p_sql into v; exception when others then v := 'ERR ' || sqlstate || ': ' || sqlerrm; end;
  insert into t_ctx values (p_k, v) on conflict (k) do update set v = excluded.v;
end $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
-- number of change rows (as the owner; the helper is not security definer, so call it while the role is the owner)
create or replace function pg_temp.nchg(p_code text default null) returns bigint language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from public.sku_registry_changes where $1 is null or sku_code = $1' into v using p_code;
  return v;
exception when others then return -1;
end $$;

-- =========================================================================================== context (owner)
insert into t_ctx select 'ADMIN', id::text from public.profiles where role = 'ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'SUPER', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'n_reg', count(*)::text from public.sku_registry;
insert into t_ctx select 'n_import', count(*)::text from public.sku_registry where origin = 'import';
insert into t_ctx select 'n_import_master', count(*)::text from public.sku_master;
insert into t_ctx select 'price3', selling_price::text from public.sku_registry where sku_code = 'FG-000003';
insert into t_ctx select 'price11', selling_price::text from public.sku_registry where sku_code = 'FG-000011';
insert into t_ctx select 'upd2', updated_at::text from public.sku_registry where sku_code = 'FG-000002';
insert into t_ctx select 'admin_name', coalesce(nullif(btrim(display_name), ''), split_part(email, '@', 1)) from public.profiles where role = 'ADMIN' and status = 'active' order by created_at limit 1;
insert into t_res (test, ok, detail) select 'K0 the seed has an admin, a super admin, a member and 145 registry rows to work with',
  pg_temp.c('ADMIN') is not null and pg_temp.c('SUPER') is not null and pg_temp.c('A') is not null and pg_temp.c('n_reg')::int >= 145, pg_temp.c('n_reg');

-- =========================================================================================== K0 structure and privileges (owner)
select pg_temp.t('K0 table sku_registry_changes exists with row-level security on and NO policy (staff read it only through the functions)',
  $q$(select relrowsecurity from pg_class where oid = 'public.sku_registry_changes'::regclass) and not exists (select 1 from pg_policies where tablename = 'sku_registry_changes')$q$);
select pg_temp.t('K0 no client role has any privilege on the change log table',
  $q$not has_table_privilege('authenticated', 'public.sku_registry_changes', 'select, insert, update, delete') and not has_table_privilege('anon', 'public.sku_registry_changes', 'select, insert, update, delete')$q$);
select pg_temp.t('K0 the four client functions exist; authenticated may execute them, anon and PUBLIC may not',
  $q$(select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('sku_changes_since', 'sku_set_status', 'sku_set_details', 'sku_change_log')
        and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
        and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)) = 4$q$);
select pg_temp.t('K0 every function of this migration is security definer with a fixed search_path',
  $q$(select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('sku_changes_since', 'sku_set_status', 'sku_set_details', 'sku_change_log')
        and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 4$q$);
select pg_temp.t('K0 the registry keeps its code guard and gains the change-log, updated_at and lock triggers',
  $q$(select count(*) from pg_trigger t where t.tgrelid = 'public.sku_registry'::regclass and not t.tgisinternal and t.tgname in ('sku_registry_guard', 'sku_registry_touch', 'sku_registry_log', 'sku_registry_lock')) = 4$q$);

-- =========================================================================================== K1 the first call is a full snapshot (every origin, every column)
-- an app-created SKU first (through the real issuing function, as the New product flow does)
select pg_temp.setc('app1', $q$select code from public.sku_issue('FG', 'Sync test app product', gen_random_uuid(), (select v::uuid from t_ctx where k = 'ADMIN'))$q$);
select pg_temp.t('K1 sku_issue created an app SKU (setup)', $q$pg_temp.c('app1') ~ '^FG-[0-9]{6}$'$q$);
select pg_temp.t('K1 the new app SKU got a change row from sku_issue (it goes through the same trigger)',
  $q$pg_temp.nchg(pg_temp.c('app1')) = 1 and (select changes -> 'name_full' ->> 'new' from public.sku_registry_changes where sku_code = pg_temp.c('app1')) = 'Sync test app product'$q$);

set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('full0', $q$select public.sku_changes_since(null)::text$q$);
select pg_temp.eq('K1 the first call (null cursor) says full = true', $q$(pg_temp.c('full0')::jsonb) ->> 'full'$q$, 'true');
select pg_temp.t('K1 the full snapshot has every registry row of every origin',
  $q$jsonb_array_length(pg_temp.c('full0')::jsonb -> 'rows') = pg_temp.c('n_reg')::int + 1$q$);   -- + the app SKU created above
select pg_temp.t('K1 the snapshot includes the app-origin row and the import rows',
  $q$exists (select 1 from jsonb_array_elements(pg_temp.c('full0')::jsonb -> 'rows') r where r ->> 'sku_code' = pg_temp.c('app1') and r ->> 'origin' = 'app')
     and (select count(*) from jsonb_array_elements(pg_temp.c('full0')::jsonb -> 'rows') r where r ->> 'origin' = 'import') = pg_temp.c('n_import')::int$q$);
select pg_temp.t('K1 every row carries exactly the 22 contract keys (and no source_code)',
  $q$not exists (select 1 from jsonb_array_elements(pg_temp.c('full0')::jsonb -> 'rows') r
      where (select array_agg(k order by k) from jsonb_object_keys(r) k) is distinct from
            array['barcode','brand','cost_price','domain','ecommerce_price','friend_price','legacy_sku_code','name_full','needs_review','origin','pack_qty','product_type','retail_price','review_notes','selling_price','sku_category','sku_code','status','unit_en','unit_th','updated_at','wholesale_price'])$q$);
select pg_temp.t('K1 prices and status come through with the right types (number or null, active/inactive)',
  $q$exists (select 1 from jsonb_array_elements(pg_temp.c('full0')::jsonb -> 'rows') r where r ->> 'sku_code' = 'FG-000003' and jsonb_typeof(r -> 'selling_price') = 'number'
       and (r ->> 'selling_price')::numeric = (select v::numeric from t_ctx where k = 'price3') and r ->> 'status' = 'active')$q$);
reset role;
select pg_temp.t('K1 the cursor is the highest change id (the one change row of the app SKU)',
  $q$((pg_temp.c('full0')::jsonb) ->> 'cursor')::bigint = (select max(id) from public.sku_registry_changes)$q$);
select pg_temp.setc('cur0', $q$select (pg_temp.c('full0')::jsonb) ->> 'cursor'$q$);

-- =========================================================================================== K2 no change = empty rows, same cursor
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('same0', $q$select public.sku_changes_since(pg_temp.c('cur0')::bigint)::text$q$);
select pg_temp.t('K2 nothing changed: an empty rows array, full = false, the SAME cursor',
  $q$(pg_temp.c('same0')::jsonb) ->> 'cursor' = pg_temp.c('cur0') and (pg_temp.c('same0')::jsonb) ->> 'full' = 'false' and (pg_temp.c('same0')::jsonb) -> 'rows' = '[]'::jsonb$q$);

-- =========================================================================================== K3 status flip appears once with the right diff
select pg_temp.setc('flip', $q$select public.sku_set_status('FG-000002', 'inactive', 'K3 test flip')::text$q$);
select pg_temp.eq('K3 sku_set_status returns the registry row with the new status', $q$(pg_temp.c('flip')::jsonb) ->> 'status'$q$, 'inactive');
select pg_temp.setc('feed3', $q$select public.sku_changes_since(pg_temp.c('cur0')::bigint)::text$q$);
select pg_temp.t('K3 the feed returns that one SKU once, with status inactive',
  $q$jsonb_array_length(pg_temp.c('feed3')::jsonb -> 'rows') = 1 and (pg_temp.c('feed3')::jsonb) -> 'rows' -> 0 ->> 'sku_code' = 'FG-000002' and (pg_temp.c('feed3')::jsonb) -> 'rows' -> 0 ->> 'status' = 'inactive'
     and (pg_temp.c('feed3')::jsonb) ->> 'full' = 'false'$q$);
select pg_temp.t('K3 the cursor moved forward by exactly the one change', $q$((pg_temp.c('feed3')::jsonb) ->> 'cursor')::bigint = pg_temp.c('cur0')::bigint + 1$q$);
reset role;
select pg_temp.eq('K3 the change row holds exactly the status diff old -> new', $q$(select changes::text from public.sku_registry_changes where sku_code = 'FG-000002')$q$, '{"status": {"new": "inactive", "old": "active"}}');
select pg_temp.eq('K3 the change row names the staff member who did it', $q$(select actor::text from public.sku_registry_changes where sku_code = 'FG-000002')$q$, pg_temp.c('ADMIN'));
select pg_temp.t('K3 updated_at was maintained by the trigger (now)', $q$(select updated_at from public.sku_registry where sku_code = 'FG-000002') = now() and now()::text <> pg_temp.c('upd2')$q$);
select pg_temp.setc('cur3', $q$select (pg_temp.c('feed3')::jsonb) ->> 'cursor'$q$);

-- =========================================================================================== K4 price change appears once with the right diff
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('det4', $q$select public.sku_set_details('FG-000003', '{"selling_price": 123.5}')::text$q$);
select pg_temp.t('K4 sku_set_details returns the row with the new price', $q$((pg_temp.c('det4')::jsonb) ->> 'selling_price')::numeric = 123.5$q$);
select pg_temp.setc('feed4', $q$select public.sku_changes_since(pg_temp.c('cur3')::bigint)::text$q$);
select pg_temp.t('K4 the feed returns that SKU once, with the new price',
  $q$jsonb_array_length(pg_temp.c('feed4')::jsonb -> 'rows') = 1 and (pg_temp.c('feed4')::jsonb) -> 'rows' -> 0 ->> 'sku_code' = 'FG-000003' and ((pg_temp.c('feed4')::jsonb) -> 'rows' -> 0 ->> 'selling_price')::numeric = 123.5$q$);
reset role;
select pg_temp.t('K4 the change row holds only selling_price, old = the earlier price, new = 123.5',
  $q$(select (select array_agg(k) from jsonb_object_keys(changes) k) = array['selling_price'] and (changes -> 'selling_price' ->> 'old')::numeric = pg_temp.c('price3')::numeric
         and (changes -> 'selling_price' ->> 'new')::numeric = 123.5 from public.sku_registry_changes where sku_code = 'FG-000003')$q$);
select pg_temp.setc('cur4', $q$select max(id)::text from public.sku_registry_changes$q$);

-- =========================================================================================== K5 several changes to one SKU between two syncs: ONE row, latest state
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('x5', $q$select public.sku_set_details('FG-000011', '{"selling_price": 77}')::text$q$);
select pg_temp.setc('x5b', $q$select public.sku_set_status('FG-000011', 'inactive', 'K5 two changes in a row')::text$q$);
select pg_temp.setc('feed5', $q$select public.sku_changes_since(pg_temp.c('cur4')::bigint)::text$q$);
select pg_temp.t('K5 two changes to one SKU come back as ONE row carrying the latest values',
  $q$jsonb_array_length(pg_temp.c('feed5')::jsonb -> 'rows') = 1 and (pg_temp.c('feed5')::jsonb) -> 'rows' -> 0 ->> 'sku_code' = 'FG-000011'
     and ((pg_temp.c('feed5')::jsonb) -> 'rows' -> 0 ->> 'selling_price')::numeric = 77 and (pg_temp.c('feed5')::jsonb) -> 'rows' -> 0 ->> 'status' = 'inactive'$q$);
select pg_temp.t('K5 the cursor covers both changes', $q$((pg_temp.c('feed5')::jsonb) ->> 'cursor')::bigint = pg_temp.c('cur4')::bigint + 2$q$);
reset role;
select pg_temp.eq('K5 each change is its own log row', $q$pg_temp.nchg('FG-000011')$q$, '2');
select pg_temp.setc('cur5', $q$select max(id)::text from public.sku_registry_changes$q$);

-- =========================================================================================== K6 a NEW app SKU appears in the feed (sku_reserve, the staff RPC the New product flow calls)
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('app2', $q$select code from public.sku_reserve('FG', 'Sync test reserved product', gen_random_uuid())$q$);
select pg_temp.setc('feed6', $q$select public.sku_changes_since(pg_temp.c('cur5')::bigint)::text$q$);
select pg_temp.t('K6 the reserved app SKU is in the feed: origin app, active, named, no price yet',
  $q$jsonb_array_length(pg_temp.c('feed6')::jsonb -> 'rows') = 1 and (pg_temp.c('feed6')::jsonb) -> 'rows' -> 0 ->> 'sku_code' = pg_temp.c('app2') and (pg_temp.c('feed6')::jsonb) -> 'rows' -> 0 ->> 'origin' = 'app'
     and (pg_temp.c('feed6')::jsonb) -> 'rows' -> 0 ->> 'status' = 'active' and (pg_temp.c('feed6')::jsonb) -> 'rows' -> 0 ->> 'name_full' = 'Sync test reserved product'
     and (pg_temp.c('feed6')::jsonb) -> 'rows' -> 0 -> 'selling_price' = 'null'::jsonb$q$);
reset role;
select pg_temp.t('K6 the insert diff has old = null for every field that was set',
  $q$(select changes -> 'name_full' = '{"old": null, "new": "Sync test reserved product"}'::jsonb and changes -> 'status' = '{"old": null, "new": "active"}'::jsonb and not changes ? 'selling_price'
        from public.sku_registry_changes where sku_code = pg_temp.c('app2'))$q$);
select pg_temp.setc('cur6', $q$select max(id)::text from public.sku_registry_changes$q$);

-- =========================================================================================== K7 the "create pack" flow: sku_issue, then the price set in the same transaction
select pg_temp.setc('app3', $q$select code from public.sku_issue('FG', 'Sync test pack product', gen_random_uuid(), (select v::uuid from t_ctx where k = 'ADMIN'))$q$);
update public.sku_registry set selling_price = 300 where sku_code = pg_temp.c('app3');
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('feed7', $q$select public.sku_changes_since(pg_temp.c('cur6')::bigint)::text$q$);
select pg_temp.t('K7 a SKU issued and priced in one go appears once, already with its price',
  $q$jsonb_array_length(pg_temp.c('feed7')::jsonb -> 'rows') = 1 and (pg_temp.c('feed7')::jsonb) -> 'rows' -> 0 ->> 'sku_code' = pg_temp.c('app3')
     and ((pg_temp.c('feed7')::jsonb) -> 'rows' -> 0 ->> 'selling_price')::numeric = 300$q$);
reset role;
select pg_temp.setc('cur7', $q$select max(id)::text from public.sku_registry_changes$q$);

-- =========================================================================================== K8 only staff
select pg_temp.setc('code_n', $q$select count(*)::text from public.sku_registry_changes$q$);
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err('K8 a shop member (USER) cannot read the feed', $q$select public.sku_changes_since(null)$q$, '42501');
select pg_temp.err('K8 a shop member cannot change a status', $q$select public.sku_set_status('FG-000002', 'active', 'nope')$q$, '42501');
select pg_temp.err('K8 a shop member cannot change details', $q$select public.sku_set_details('FG-000002', '{"selling_price": 1}')$q$, '42501');
select pg_temp.err('K8 a shop member cannot read the change log', $q$select public.sku_change_log()$q$, '42501');
select pg_temp.err('K8 a member cannot read the log table directly', $q$select count(*) from public.sku_registry_changes$q$, '42501');
reset role; set local role authenticated; select set_config('request.jwt.claims', '', true);
select pg_temp.err('K8 a session with no signed-in user is refused (feed)', $q$select public.sku_changes_since(null)$q$, '42501');
select pg_temp.err('K8 a session with no signed-in user is refused (status)', $q$select public.sku_set_status('FG-000002', 'active', 'nope')$q$, '42501');
reset role; set local role anon;
select pg_temp.err('K8 anon cannot call the feed', $q$select public.sku_changes_since(null)$q$, '42501', '%permission denied%');
select pg_temp.err('K8 anon cannot call sku_set_status', $q$select public.sku_set_status('FG-000002', 'active', 'nope')$q$, '42501', '%permission denied%');
select pg_temp.err('K8 anon cannot call sku_set_details', $q$select public.sku_set_details('FG-000002', '{}')$q$, '42501', '%permission denied%');
select pg_temp.err('K8 anon cannot call sku_change_log', $q$select public.sku_change_log()$q$, '42501', '%permission denied%');
reset role;
select pg_temp.eq('K8 none of the refused calls wrote anything', $q$(select count(*) from public.sku_registry_changes)$q$, pg_temp.c('code_n'));
select pg_temp.eq('K8 FG-000002 is still inactive after the refused status change (member and anon)', $q$(select status from public.sku_registry where sku_code = 'FG-000002')$q$, 'inactive');

-- =========================================================================================== K9 codes can never change
select pg_temp.err('K9 the registry guard still refuses a changed code (23001)', $q$update public.sku_registry set sku_code = 'FG-999999' where sku_code = 'FG-000005'$q$, '23001');
select pg_temp.err('K9 ... a changed legacy code', $q$update public.sku_registry set legacy_sku_code = 'X' where sku_code = 'FG-000005'$q$, '23001');
select pg_temp.err('K9 ... and a deleted row', $q$delete from public.sku_registry where sku_code = 'FG-000005'$q$, '23001');
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.err('K9 sku_set_details has no way to send a code', $q$select public.sku_set_details('FG-000005', '{"sku_code": "FG-999999"}')$q$, 'P0001', 'BAD_FIELD%');
select pg_temp.err('K9 ... nor a category, a legacy code or a status', $q$select public.sku_set_details('FG-000005', '{"sku_category": "RM"}')$q$, 'P0001', 'BAD_FIELD%');
select pg_temp.err('K9 ... nor status (that has its own audited function)', $q$select public.sku_set_details('FG-000005', '{"status": "inactive"}')$q$, 'P0001', 'BAD_FIELD%');
reset role;
select pg_temp.eq('K9 FG-000005 has no change row and is unchanged', $q$pg_temp.nchg('FG-000005')::text || '/' || (select status from public.sku_registry where sku_code = 'FG-000005')$q$, '0/active');

-- =========================================================================================== K10 sku_set_status: idempotent, reason required, validated, audited
select pg_temp.setc('h0', $q$select count(*)::text from public.sku_code_history where sku_code = 'FG-000002'$q$);
select pg_temp.t('K10 the flip of K3 wrote a sku_code_history row: action deactivated, the reason as note, the staff member as actor',
  $q$(select count(*) = 1 from public.sku_code_history where sku_code = 'FG-000002' and action = 'deactivated' and note = 'K3 test flip' and actor = pg_temp.c('ADMIN')::uuid)$q$);
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('same', $q$select public.sku_set_status('FG-000002', 'inactive', 'K10 again')::text$q$);
select pg_temp.eq('K10 the same status again still returns the row', $q$(pg_temp.c('same')::jsonb) ->> 'status'$q$, 'inactive');
reset role;
select pg_temp.eq('K10 ... and writes NO new change row', $q$pg_temp.nchg('FG-000002')$q$, '1');
select pg_temp.eq('K10 ... and NO new history row', $q$(select count(*)::text from public.sku_code_history where sku_code = 'FG-000002')$q$, pg_temp.c('h0'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.err('K10 a reason is required (null)', $q$select public.sku_set_status('FG-000002', 'active', null)$q$, 'P0001', 'REASON_REQUIRED%');
select pg_temp.err('K10 a reason is required (empty)', $q$select public.sku_set_status('FG-000002', 'active', '')$q$, 'P0001', 'REASON_REQUIRED%');
select pg_temp.err('K10 a reason is required (blanks)', $q$select public.sku_set_status('FG-000002', 'active', '   ')$q$, 'P0001', 'REASON_REQUIRED%');
select pg_temp.err('K10 a reason is required even when nothing would change', $q$select public.sku_set_status('FG-000002', 'inactive', '')$q$, 'P0001', 'REASON_REQUIRED%');
select pg_temp.err('K10 an unknown status is refused', $q$select public.sku_set_status('FG-000002', 'deleted', 'x')$q$, 'P0001', 'BAD_STATUS%');
select pg_temp.err('K10 an unknown code is refused', $q$select public.sku_set_status('FG-999999', 'active', 'x')$q$, 'P0001', 'NOT_FOUND%');
select pg_temp.setc('react', $q$select public.sku_set_status('FG-000002', 'active', 'K10 back on sale')::text$q$);
select pg_temp.eq('K10 re-activating works', $q$(pg_temp.c('react')::jsonb) ->> 'status'$q$, 'active');
reset role;
select pg_temp.t('K10 re-activating is logged as reactivated with its reason',
  $q$(select count(*) = 1 from public.sku_code_history where sku_code = 'FG-000002' and action = 'reactivated' and note = 'K10 back on sale')$q$);
select pg_temp.eq('K10 two change rows for FG-000002 in total (off, on)', $q$pg_temp.nchg('FG-000002')$q$, '2');

-- =========================================================================================== K11a prices are never rounded silently (review round 1)
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.err('K11a a price with 3 decimals is refused, not rounded', $q$select public.sku_set_details('FG-000006', '{"selling_price": 12.345}')$q$, 'P0001', '%BAD_VALUE%2 decimals%');
select pg_temp.err('K11a a cost with 3 decimals is refused', $q$select public.sku_set_details('FG-000006', '{"cost_price": 0.001}')$q$, 'P0001', '%BAD_VALUE%2 decimals%');
select pg_temp.t('K11a two decimals (baht and satang) are accepted', $q$((public.sku_set_details('FG-000006', '{"selling_price": 12.35}')) ->> 'selling_price')::numeric = 12.35$q$);

-- =========================================================================================== K11 sku_set_details
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('d1', $q$select public.sku_set_details('FG-000006', '{"brand": "KBrand", "barcode": "K11-BC-1", "unit_th": "ขวด", "name_full": "K11 renamed", "cost_price": 10, "retail_price": 99, "ecommerce_price": 88, "product_type": "K11 type", "pack_qty": 4}')::text$q$);
select pg_temp.t('K11 all ten allowed keys can be set at once',
  $q$(pg_temp.c('d1')::jsonb) ->> 'brand' = 'KBrand' and (pg_temp.c('d1')::jsonb) ->> 'barcode' = 'K11-BC-1' and (pg_temp.c('d1')::jsonb) ->> 'unit_th' = 'ขวด' and (pg_temp.c('d1')::jsonb) ->> 'name_full' = 'K11 renamed'
     and ((pg_temp.c('d1')::jsonb) ->> 'cost_price')::numeric = 10 and ((pg_temp.c('d1')::jsonb) ->> 'retail_price')::numeric = 99 and ((pg_temp.c('d1')::jsonb) ->> 'ecommerce_price')::numeric = 88
     and (pg_temp.c('d1')::jsonb) ->> 'product_type' = 'K11 type' and ((pg_temp.c('d1')::jsonb) ->> 'pack_qty')::numeric = 4$q$);
select pg_temp.setc('d2', $q$select public.sku_set_details('FG-000006', '{"brand": null, "barcode": null}')::text$q$);
select pg_temp.t('K11 JSON null CLEARS brand and barcode (what the client sends)',
  $q$(pg_temp.c('d2')::jsonb) -> 'brand' = 'null'::jsonb and (pg_temp.c('d2')::jsonb) -> 'barcode' = 'null'::jsonb and (pg_temp.c('d2')::jsonb) ->> 'name_full' = 'K11 renamed'$q$);
select pg_temp.setc('d2b', $q$select public.sku_set_details('FG-000006', '{"brand": "KBrand", "barcode": "K11-BC-1"}')::text$q$);
select pg_temp.setc('d2c', $q$select public.sku_set_details('FG-000006', '{"brand": "  ", "barcode": ""}')::text$q$);
select pg_temp.t('K11 blank text also clears brand and barcode',
  $q$(pg_temp.c('d2c')::jsonb) -> 'brand' = 'null'::jsonb and (pg_temp.c('d2c')::jsonb) -> 'barcode' = 'null'::jsonb$q$);
reset role;
select pg_temp.t('K11 the clearing is in the log as old -> null',
  $q$(select changes -> 'brand' = '{"old": "KBrand", "new": null}'::jsonb and changes -> 'barcode' = '{"old": "K11-BC-1", "new": null}'::jsonb from public.sku_registry_changes
        where sku_code = 'FG-000006' order by id desc limit 1)$q$);
reset role;
select pg_temp.setc('n6', $q$select pg_temp.nchg('FG-000006')::text$q$);
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('noop', $q$select public.sku_set_details('FG-000006', '{"name_full": "K11 renamed", "cost_price": 10, "pack_qty": 4}')::text$q$);
reset role;
select pg_temp.eq('K11 sending the values a SKU already has writes no change row', $q$pg_temp.nchg('FG-000006')::text$q$, pg_temp.c('n6'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('empty', $q$select public.sku_set_details('FG-000006', '{}')::text$q$);
select pg_temp.eq('K11 an empty patch returns the row unchanged', $q$(pg_temp.c('empty')::jsonb) ->> 'name_full'$q$, 'K11 renamed');
select pg_temp.err('K11 an unknown key is refused', $q$select public.sku_set_details('FG-000006', '{"colour": "red"}')$q$, 'P0001', 'BAD_FIELD%');
select pg_temp.err('K11 ... and the known keys beside it are NOT applied (all or nothing)', $q$select public.sku_set_details('FG-000006', '{"name_full": "K11 must not stick", "colour": "red"}')$q$, 'P0001', 'BAD_FIELD%');
select pg_temp.err('K11 a key the registry owns but this function does not edit (friend price)', $q$select public.sku_set_details('FG-000006', '{"friend_price": 1}')$q$, 'P0001', 'BAD_FIELD%');
select pg_temp.err('K11 a negative selling price is refused', $q$select public.sku_set_details('FG-000006', '{"selling_price": -1}')$q$, 'P0001', 'BAD_VALUE%');
select pg_temp.err('K11 a negative cost is refused', $q$select public.sku_set_details('FG-000006', '{"cost_price": -0.01}')$q$, 'P0001', 'BAD_VALUE%');
select pg_temp.err('K11 a price that is not a number is refused', $q$select public.sku_set_details('FG-000006', '{"selling_price": "free"}')$q$, 'P0001', 'BAD_VALUE%');
select pg_temp.err('K11 a price cannot be cleared with null (that would silently take the SKU off sale)', $q$select public.sku_set_details('FG-000006', '{"selling_price": null}')$q$, 'P0001', 'BAD_VALUE%');
select pg_temp.err('K11 the name cannot be cleared', $q$select public.sku_set_details('FG-000006', '{"name_full": null}')$q$, 'P0001', 'BAD_VALUE%');
select pg_temp.err('K11 the name cannot be blank', $q$select public.sku_set_details('FG-000006', '{"name_full": "  "}')$q$, 'P0001', 'BAD_VALUE%');
select pg_temp.err('K11 a patch that is not an object is refused', $q$select public.sku_set_details('FG-000006', '[1]')$q$, 'P0001', 'BAD_VALUE%');
select pg_temp.err('K11 an unknown code is refused', $q$select public.sku_set_details('FG-999999', '{"brand": "x"}')$q$, 'P0001', 'NOT_FOUND%');
select pg_temp.setc('b1', $q$select public.sku_set_details('FG-000007', '{"barcode": "K11-BC-2"}')::text$q$);
select pg_temp.err('K11 a barcode another SKU already has is refused cleanly', $q$select public.sku_set_details('FG-000008', '{"barcode": "K11-BC-2"}')$q$, 'P0001', 'BARCODE_TAKEN%FG-000007%');
select pg_temp.setc('b2', $q$select public.sku_set_details('FG-000007', '{"barcode": null}')::text$q$);
select pg_temp.setc('b3', $q$select public.sku_set_details('FG-000008', '{"barcode": "K11-BC-2"}')::text$q$);
select pg_temp.eq('K11 after the first SKU clears it, the barcode can move to another SKU', $q$(pg_temp.c('b3')::jsonb) ->> 'barcode'$q$, 'K11-BC-2');
reset role;
select pg_temp.eq('K11 the refused patches changed nothing (name still K11 renamed)', $q$(select name_full from public.sku_registry where sku_code = 'FG-000006')$q$, 'K11 renamed');
select pg_temp.eq('K11 ... and added no change rows to FG-000006', $q$pg_temp.nchg('FG-000006')::text$q$, pg_temp.c('n6'));
select pg_temp.err('K11 the table CHECK still refuses a negative price written directly', $q$update public.sku_registry set selling_price = -5 where sku_code = 'FG-000006'$q$, '23514');

-- =========================================================================================== K12 the change log is append-only and not readable except through the functions
select pg_temp.err('K12 a change row cannot be updated (even by the owner)', $q$update public.sku_registry_changes set sku_code = 'X'$q$, '23001');
select pg_temp.err('K12 a change row cannot be deleted', $q$delete from public.sku_registry_changes$q$, '23001');
select pg_temp.err('K12 the log cannot be truncated', $q$truncate public.sku_registry_changes$q$, '23001');
select pg_temp.t('K12 the log id has no default: nothing can take an id without the change-log lock',
  $q$(select column_default is null from information_schema.columns where table_schema = 'public' and table_name = 'sku_registry_changes' and column_name = 'id')$q$);
select pg_temp.t('K12 a registry write holds the transaction-scoped advisory lock (ids are handed out in lock order, held until commit)',
  $q$exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted)$q$);

-- =========================================================================================== K13 sku_change_log
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('log11', $q$select public.sku_change_log('FG-000011')::text$q$);
select pg_temp.t('K13 the log of one SKU lists its two changes, newest first',
  $q$jsonb_array_length(pg_temp.c('log11')::jsonb) = 2 and (pg_temp.c('log11')::jsonb) -> 0 -> 'changes' ? 'status' and (pg_temp.c('log11')::jsonb) -> 1 -> 'changes' ? 'selling_price'
     and ((pg_temp.c('log11')::jsonb) -> 0 ->> 'id')::bigint > ((pg_temp.c('log11')::jsonb) -> 1 ->> 'id')::bigint$q$);
select pg_temp.t('K13 each entry has id, at, sku_code, actor_name, changes and nothing else',
  $q$(select array_agg(k order by k) from jsonb_object_keys((pg_temp.c('log11')::jsonb) -> 0) k) = array['actor_name', 'at', 'changes', 'id', 'sku_code']$q$);
select pg_temp.eq('K13 actor_name is the staff member''s name', $q$(pg_temp.c('log11')::jsonb) -> 0 ->> 'actor_name'$q$, pg_temp.c('admin_name'));
select pg_temp.t('K13 without a code the log is newest first across all SKUs',
  $q$(select bool_and((a ->> 'id')::bigint > (b ->> 'id')::bigint) from (select e as a, lead(e) over (order by ord) as b from jsonb_array_elements(public.sku_change_log()) with ordinality t(e, ord)) x where b is not null)$q$);
select pg_temp.eq('K13 p_limit and p_offset page through it', $q$jsonb_array_length(public.sku_change_log(null, 2, 1))$q$, '2');
select pg_temp.t('K13 the default page is at most 50 entries and a huge limit is capped', $q$jsonb_array_length(public.sku_change_log()) <= 50 and jsonb_array_length(public.sku_change_log(null, 100000, 0)) <= 200$q$);
select pg_temp.eq('K13 a SKU with no changes has an empty log', $q$public.sku_change_log('FG-000100')::text$q$, '[]');
reset role;

-- =========================================================================================== K14 updated_at, columns the feed does not carry, several rows in one statement
select pg_temp.setc('upd9', $q$select updated_at::text from public.sku_registry where sku_code = 'FG-000009'$q$);
select pg_temp.setc('n9', $q$select pg_temp.nchg('FG-000009')::text$q$);
update public.sku_registry set selling_price = selling_price where sku_code = 'FG-000009';
select pg_temp.t('K14 an update that changes nothing keeps updated_at (not bumped to now) and writes no row',
  $q$(select updated_at::text from public.sku_registry where sku_code = 'FG-000009') = pg_temp.c('upd9') and pg_temp.c('upd9') <> now()::text and pg_temp.nchg('FG-000009')::text = pg_temp.c('n9')$q$);
update public.sku_registry set tax_category = 'K14' where sku_code = 'FG-000009';
select pg_temp.t('K14 a column the feed does not carry (tax_category) writes NO change row but does bump updated_at',
  $q$pg_temp.nchg('FG-000009')::text = pg_temp.c('n9') and (select updated_at from public.sku_registry where sku_code = 'FG-000009') = now()$q$);
select set_config('request.jwt.claims', '', true);                       -- a service-role / migration connection: no signed-in user
select pg_temp.setc('m0', $q$select max(id)::text from public.sku_registry_changes$q$);
update public.sku_registry set cost_price = coalesce(cost_price, 0) + 1 where sku_code in ('FG-000030', 'FG-000031', 'FG-000032');
select pg_temp.t('K14 one UPDATE of three rows writes three change rows with strictly increasing ids, no gap',
  $q$(select count(*) = 3 and max(id) - min(id) = 2 and min(id) = pg_temp.c('m0')::bigint + 1 from public.sku_registry_changes where id > pg_temp.c('m0')::bigint)$q$);
select pg_temp.t('K14 a direct (service-role) change has no actor',
  $q$(select count(*) = 3 from public.sku_registry_changes where id > pg_temp.c('m0')::bigint and actor is null)$q$);
select pg_temp.t('K14 the ids are handed out in order of the writes', $q$(select array_agg(sku_code order by id) = array['FG-000030', 'FG-000031', 'FG-000032'] from public.sku_registry_changes where id > pg_temp.c('m0')::bigint)$q$);

-- =========================================================================================== K15 a cursor from the future (restored or other database) means start over
select pg_temp.setc('n_distinct', $q$select count(distinct sku_code)::text from public.sku_registry_changes$q$);
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('future', $q$select public.sku_changes_since(999999999999)::text$q$);
select pg_temp.t('K15 a cursor ahead of the server gets a full snapshot and the real cursor',
  $q$(pg_temp.c('future')::jsonb) ->> 'full' = 'true' and jsonb_array_length((pg_temp.c('future')::jsonb) -> 'rows') >= 145 and ((pg_temp.c('future')::jsonb) ->> 'cursor')::bigint < 999999999999$q$);
select pg_temp.setc('c0', $q$select public.sku_changes_since(0)::text$q$);
select pg_temp.t('K15 cursor 0 is a normal incremental call (only SKUs that have a change, one row each)',
  $q$(pg_temp.c('c0')::jsonb) ->> 'full' = 'false' and jsonb_array_length((pg_temp.c('c0')::jsonb) -> 'rows') = pg_temp.c('n_distinct')::int$q$);
reset role;

-- =========================================================================================== K16 existing behaviour is unchanged
select pg_temp.t('K16 sku_master (compatibility view) still lists exactly the import rows with legacy codes',
  $q$(select count(*) from public.sku_master) = pg_temp.c('n_import_master')::int
     and not exists (select 1 from public.sku_master m where not exists (select 1 from public.sku_registry r where r.legacy_sku_code = m.sku_code and r.origin = 'import'))
     and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sku_master') = 27$q$);
select pg_temp.t('K16 shop_sellable follows the registry: FG-000010 is on sale', $q$exists (select 1 from public.shop_sellable where sku_code = 'FG-000010')$q$);
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('s10', $q$select public.sku_set_status('FG-000010', 'inactive', 'K16 leaves the shop')::text$q$);
reset role;
select pg_temp.t('K16 a deactivated SKU leaves the shop', $q$not exists (select 1 from public.shop_sellable where sku_code = 'FG-000010')$q$);
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('s10b', $q$select public.sku_set_status('FG-000010', 'active', 'K16 back')::text$q$);
select pg_temp.setc('p10', $q$select public.sku_set_details('FG-000010', '{"ecommerce_price": 222}')::text$q$);
reset role;
select pg_temp.t('K16 reactivated and re-priced: the shop sells it at the new e-commerce price',
  $q$(select price = 222 from public.shop_sellable where sku_code = 'FG-000010')$q$);
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('v1', $q$select public.sku_void(pg_temp.c('app2'), 'K16 never saved')::text$q$);
select pg_temp.setc('feed16', $q$select public.sku_changes_since(pg_temp.c('cur7')::bigint)::text$q$);
select pg_temp.t('K16 the voided SKU shows up in the feed as inactive',
  $q$exists (select 1 from jsonb_array_elements(pg_temp.c('feed16')::jsonb -> 'rows') r where r ->> 'sku_code' = pg_temp.c('app2') and r ->> 'status' = 'inactive')$q$);
select pg_temp.err('K16 sku_void still refuses an imported code', $q$select public.sku_void('FG-000001', 'x')$q$, '22023');
reset role;
select pg_temp.t('K16 sku_void still works: inactive, history row void, change row status active -> inactive',
  $q$(select status = 'inactive' from public.sku_registry where sku_code = pg_temp.c('app2'))
     and exists (select 1 from public.sku_code_history where sku_code = pg_temp.c('app2') and action = 'void' and note = 'K16 never saved')
     and (select changes -> 'status' = '{"old": "active", "new": "inactive"}'::jsonb from public.sku_registry_changes where sku_code = pg_temp.c('app2') order by id desc limit 1)$q$);
select pg_temp.eq('K16 the voided SKU has two change rows (created, voided)', $q$pg_temp.nchg(pg_temp.c('app2'))$q$, '2');
set local role authenticated; select pg_temp.as_user(pg_temp.c('ADMIN')::uuid);
select pg_temp.setc('v2', $q$select public.sku_void(pg_temp.c('app2'), 'K16 twice')::text$q$);
reset role;
select pg_temp.eq('K16 voiding a code that is already void is harmless: no extra change row', $q$pg_temp.nchg(pg_temp.c('app2'))$q$, '2');
select pg_temp.t('K16 sku_issue / sku_reserve / sku_peek keep their signatures and grants',
  $q$has_function_privilege('authenticated', 'public.sku_reserve(text, text, uuid)', 'execute') and has_function_privilege('authenticated', 'public.sku_peek(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.sku_issue(text, text, uuid, uuid)', 'execute') and has_function_privilege('authenticated', 'public.sku_void(text, text)', 'execute')$q$);
select pg_temp.t('K16 the history check accepts the new actions and still refuses an unknown one',
  $q$(select pg_get_constraintdef(oid) like '%deactivated%' and pg_get_constraintdef(oid) like '%reactivated%' and pg_get_constraintdef(oid) like '%migrated%'
        from pg_constraint where conrelid = 'public.sku_code_history'::regclass and contype = 'c' and conname = 'sku_code_history_action_check')$q$);
select pg_temp.err('K16 ... an unknown action is still refused', $q$insert into public.sku_code_history (sku_code, action) values ('FG-000001', 'bogus')$q$, '23514');

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'SKU_SYNC_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
