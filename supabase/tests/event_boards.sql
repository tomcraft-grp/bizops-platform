-- Tests for 20261121110000_event_boards.sql (event boards: events, boards, selections, claims, Super Admin operations), run inside ONE transaction that is
-- rolled back (scripts/run-event-boards-sql-tests.sh; locally: node scripts/local-pg/run.mjs <core> <migration> <this file>):
--   <core migration> ; <event boards migration> ; <this file>
-- Nothing persists: the last statement raises an exception that carries the result table. Entitlements ("rights to pick") are inserted directly as the table owner
-- (they normally come from settle, which has its own suite). Real members act through set local role authenticated + request.jwt.claims.
-- The race itself (parallel claims on separate connections) cannot run in one transaction: scripts/local-pg/boards-concurrency.mjs does that.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;

create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
-- expects an error whose message matches p_pat (and, when given, whose SQLSTATE is p_state); the failed statement is rolled back (sub-block)
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text, p_state text default null) returns void language plpgsql as $$
declare m text; d text; st text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then
    get stacked diagnostics d = pg_exception_detail; st := sqlstate; m := sqlerrm || coalesce(' | ' || d, '');
    perform pg_temp.chk(p_test, m ilike p_pat and (p_state is null or st = p_state), m || ' [' || st || ']');
  end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into t_ctx values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.j(k text) returns jsonb language sql as $$ select v::jsonb from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.who(k text) returns void language sql as $$ select pg_temp.as_user(pg_temp.c(k)::uuid) $$;
-- reads internals as the table owner while a test is acting as a member
create or replace function pg_temp.q(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.cell(b jsonb, p_n int) returns jsonb language sql as $$ select e from jsonb_array_elements(b -> 'numbers') e where (e ->> 'n')::int = p_n $$;
create or replace function pg_temp.board_of(st jsonb, p_slot int) returns jsonb language sql as $$ select b from jsonb_array_elements(st -> 'boards') b where (b ->> 'slot')::int = p_slot $$;
create or replace function pg_temp.keys(j jsonb) returns text language sql as $$ select string_agg(k, ',' order by k) from jsonb_object_keys(j) k $$;
create or replace function pg_temp.st(ev text) returns jsonb language sql as $$ select public.rw_board_state(pg_temp.c(ev)::uuid) $$;
create or replace function pg_temp.cl(ev text, bd text, n int, key text) returns text language sql as $$
  select format('select public.rw_claim_number(%L, %L, %s, %L)', pg_temp.c(ev), pg_temp.c(bd), n, key) $$;
create or replace function pg_temp.claim(ev text, bd text, n int, key text) returns jsonb language sql as $$
  select public.rw_claim_number(pg_temp.c(ev)::uuid, pg_temp.c(bd)::uuid, n, key) $$;
-- the revision a customer would poll for one board
create or replace function pg_temp.rev(ev text, bd text) returns int language sql as $$
  select (b ->> 'rev')::int from jsonb_array_elements(public.rw_board_rev(pg_temp.c(ev)::uuid) -> 'boards') b where b ->> 'id' = pg_temp.c(bd) $$;
-- fixtures (run as the owner): an event with its three boards (ctx keys <k>, <k>A, <k>B, <k>C) and one board-pick rule (<k>rule)
create or replace function pg_temp.mk_event(p_key text, p_name text, p_patch jsonb default '{}'::jsonb) returns void language plpgsql as $$
declare e uuid;
begin
  insert into public.rw_events (name) values (p_name) returning id into e;
  update public.rw_events set status = coalesce(p_patch ->> 'status', 'active'), hold_minutes = coalesce((p_patch ->> 'hold')::int, hold_minutes),
    max_per_customer = case when p_patch ? 'maxpc' then (p_patch ->> 'maxpc')::int else max_per_customer end,
    number_min = coalesce((p_patch ->> 'nmin')::int, number_min), number_max = coalesce((p_patch ->> 'nmax')::int, number_max),
    starts_at = case when p_patch ? 'starts' then (p_patch ->> 'starts')::timestamptz else starts_at end,
    ends_at = case when p_patch ? 'ends' then (p_patch ->> 'ends')::timestamptz else ends_at end
  where id = e;
  perform pg_temp.put(p_key, e::text);
  perform pg_temp.put(p_key || 'A', (select id::text from public.rw_boards where event_id = e and slot = 1));
  perform pg_temp.put(p_key || 'B', (select id::text from public.rw_boards where event_id = e and slot = 2));
  perform pg_temp.put(p_key || 'C', (select id::text from public.rw_boards where event_id = e and slot = 3));
  perform pg_temp.mk_rule(p_key || 'rule', p_key, null);
end $$;
create or replace function pg_temp.mk_rule(p_key text, p_event text, p_slots int[]) returns void language plpgsql as $$
declare r uuid;
begin
  insert into public.rw_rules (kind, name, spend_step, reward_amount, event_id, board_slots) values ('board_pick', 'pick rule ' || p_key, 300, 1, pg_temp.c(p_event)::uuid, p_slots) returning id into r;
  perform pg_temp.put(p_key, r::text);
end $$;
-- p_n rights for a member on an event (oldest first by creation); p_rule null = the event's own rule
create or replace function pg_temp.picks(p_who text, p_event text, p_n int, p_rule text default null) returns void language plpgsql as $$
declare ord uuid := gen_random_uuid(); rule uuid := coalesce(pg_temp.c(p_rule)::uuid, pg_temp.c(p_event || 'rule')::uuid);
begin
  insert into public.rw_entitlements (rule_id, profile_id, event_id, source_order_id, seq, created_at)
  select rule, pg_temp.c(p_who)::uuid, pg_temp.c(p_event)::uuid, ord, g, clock_timestamp() from generate_series(1, p_n) g;
end $$;
create or replace function pg_temp.n_ent(p_who text, p_event text, p_status text) returns int language sql as $$
  select pg_temp.q(format($f$select count(*) from public.rw_entitlements where profile_id = %L and event_id = %L and status = %L$f$, pg_temp.c(p_who), pg_temp.c(p_event), p_status))::int $$;
create or replace function pg_temp.sel_status(p_id text) returns text language sql as $$ select pg_temp.q(format($f$select status from public.rw_selections where id = %L$f$, p_id)) $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'C', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 2 limit 1;
insert into t_ctx select 'D', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 3 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'M', id::text from public.profiles where role = 'ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'nameA', display_name from public.profiles where id = pg_temp.c('A')::uuid;
insert into t_ctx select 'nameS', display_name from public.profiles where id = pg_temp.c('S')::uuid;
insert into t_ctx select 'phoneA', phone from public.profiles where id = pg_temp.c('A')::uuid;
insert into t_ctx select 'emailA', email from public.profiles where id = pg_temp.c('A')::uuid;
select pg_temp.chk('B0 test users found: 4 members, a Super Admin, an Admin', (select count(*) from t_ctx where k in ('A', 'B', 'C', 'D', 'S', 'M') and v is not null) = 6);
select pg_temp.chk('B0 the members have a display name and a phone number', pg_temp.c('nameA') is not null and pg_temp.c('phoneA') is not null, pg_temp.c('nameA') || ' / ' || coalesce(pg_temp.c('phoneA'), '-'));

-- rewards switched on the way the rest of the suite needs them (the real default is OFF; B19 tests the off states)
update public.rw_settings set enabled = true, boards_enabled = true;
select pg_temp.mk_event('E1', 'Lucky numbers');
select pg_temp.mk_rule('E1rule3', 'E1', array[3]);
select pg_temp.picks('A', 'E1', 3);
select pg_temp.picks('B', 'E1', 2);
select pg_temp.picks('C', 'E1', 1, 'E1rule3');
select pg_temp.mk_event('E5', 'Raw inserts', '{"status":"draft"}');     -- a draft event of its own for the direct-insert checks (B3, B10)

-- =========================================================================================== B0 what an event looks like when it is created
select pg_temp.chk('B0 an event gets exactly three boards, slots 1-3, named Board A/B/C', (select string_agg(slot || ':' || name, ',' order by slot) from public.rw_boards where event_id = pg_temp.c('E1')::uuid) = '1:Board A,2:Board B,3:Board C');
select pg_temp.chk('B0 boards start exclusive, open, revision 0', not exists (select 1 from public.rw_boards where event_id = pg_temp.c('E1')::uuid and (mode <> 'exclusive' or state <> 'open' or rev <> 0)));
select pg_temp.chk('B0 defaults: numbers 0-99, no hold, no limit; an event is a draft until staff activate it', (select number_min = 0 and number_max = 99 and hold_minutes = 0 and max_per_customer is null from public.rw_events where id = pg_temp.c('E1')::uuid)
  and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'rw_events' and column_name = 'status') like '%draft%');
select pg_temp.err_like('B0 a board colour must be a colour', format($q$update public.rw_boards set color = 'red' where id = %L$q$, pg_temp.c('E1A')), '%violates check constraint%', '23514');
select pg_temp.err_like('B0 an entitlement cannot point at an event that does not exist (foreign key added by this migration)',
  format($q$insert into public.rw_entitlements (rule_id, profile_id, event_id, source_order_id, seq) values (%L, %L, gen_random_uuid(), gen_random_uuid(), 1)$q$, pg_temp.c('E1rule'), pg_temp.c('A')), '%foreign key%', '23503');
select pg_temp.err_like('B0 a rule cannot point at an event that does not exist', format($q$insert into public.rw_rules (kind, name, spend_step, reward_amount, event_id) values ('board_pick', 'x', 300, 1, gen_random_uuid())$q$), '%foreign key%', '23503');

-- =========================================================================================== B1 who may call what
set local role anon;
select pg_temp.err_like('B1 anon cannot read a board', $q$select public.rw_board_state(null)$q$, '%permission denied%');
select pg_temp.err_like('B1 anon cannot poll a revision', $q$select public.rw_board_rev(null)$q$, '%permission denied%');
select pg_temp.err_like('B1 anon cannot claim', format($q$select public.rw_claim_number(%L, %L, 1, 'anon-key-0001')$q$, pg_temp.c('E1'), pg_temp.c('E1A')), '%permission denied%');
select pg_temp.err_like('B1 anon cannot read the events admin list', $q$select public.rw_admin_events()$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B1 a member cannot read the selections table', $q$select count(*) from public.rw_selections$q$, '%permission denied%');
select pg_temp.err_like('B1 a member cannot read the boards table', $q$select count(*) from public.rw_boards$q$, '%permission denied%');
select pg_temp.err_like('B1 a member cannot read the events table', $q$select count(*) from public.rw_events$q$, '%permission denied%');
select pg_temp.err_like('B1 a member cannot read the resets table', $q$select count(*) from public.rw_board_resets$q$, '%permission denied%');
select pg_temp.err_like('B1 a member cannot write a selection directly', format($q$insert into public.rw_selections (event_id, board_id, number, profile_id, entitlement_id, exclusive, status) values (%L, %L, 1, %L, gen_random_uuid(), true, 'confirmed')$q$, pg_temp.c('E1'), pg_temp.c('E1A'), pg_temp.c('A')), '%permission denied%');
select pg_temp.err_like('B1 a member cannot read the events admin list', $q$select public.rw_admin_events()$q$, '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot open a board as staff', format($q$select public.rw_admin_board(%L)$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot read the audit log', format($q$select public.rw_admin_log(%L)$q$, pg_temp.c('E1')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot create an event', $q$select public.rw_admin_save_event(null, '{"name":"x"}')$q$, '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot rename a board', format($q$select public.rw_admin_save_board(%L, '{"name":"x"}')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot change an event status', format($q$select public.rw_admin_set_event_status(%L, 'paused', 'x')$q$, pg_temp.c('E1')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot lock a board', format($q$select public.rw_board_lock(%L, 'x')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot unlock a board', format($q$select public.rw_board_unlock(%L, 'x')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot switch a mode', format($q$select public.rw_board_set_mode(%L, 'shared', 'x')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot release a number', format($q$select public.rw_release_selection(%L, 'x')$q$, gen_random_uuid()), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot reset a board', format($q$select public.rw_board_reset(%L, 'x', true, 'Board A')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot undo a reset', format($q$select public.rw_board_undo_reset(%L, 'x')$q$, gen_random_uuid()), '%not allowed%', '42501');
select pg_temp.err_like('B1 a member cannot sweep holds', format($q$select public.rw_sweep_holds(%L)$q$, pg_temp.c('E1')), '%not allowed%', '42501');
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.chk('B1 an Admin can list events and open a board', jsonb_array_length(public.rw_admin_events()) >= 1 and public.rw_admin_board(pg_temp.c('E1A')::uuid) -> 'board' ->> 'id' = pg_temp.c('E1A'));
select pg_temp.err_like('B1 an Admin cannot lock a board', format($q$select public.rw_board_lock(%L, 'x')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 an Admin cannot unlock a board', format($q$select public.rw_board_unlock(%L, 'x')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 an Admin cannot switch a mode', format($q$select public.rw_board_set_mode(%L, 'shared', 'x')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 an Admin cannot release a number', format($q$select public.rw_release_selection(%L, 'x')$q$, gen_random_uuid()), '%not allowed%', '42501');
select pg_temp.err_like('B1 an Admin cannot reset a board', format($q$select public.rw_board_reset(%L, 'x', true, 'Board A')$q$, pg_temp.c('E1A')), '%not allowed%', '42501');
select pg_temp.err_like('B1 an Admin cannot undo a reset', format($q$select public.rw_board_undo_reset(%L, 'x')$q$, gen_random_uuid()), '%not allowed%', '42501');
reset role;
select pg_temp.chk('B1 the internal helpers cannot be called by members or anon',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('rw_board_view', 'rw_board_json', 'rw_event_json', 'rw_event_rights', 'rw_selection_json', 'rw_board_log', 'rw_sweep_board', 'rw_return_pick', 'rw_person_name', 'rw_boards_live', 'rw_admin_board_json', 'rw_current_event')
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))), (select string_agg(proname, ',') from pg_proc where pronamespace = 'public'::regnamespace and proname like 'rw\_%' and has_function_privilege('authenticated', oid, 'execute') and proname !~ '^rw_(admin_|board_(state|rev|lock|unlock|set_mode|reset|undo_reset)|claim_number|confirm_selection|release_selection|sweep_holds|is_|settings|my_|preview|rule|settle|require)'));
select pg_temp.chk('B1 every new table has row level security and no client policy and no client grant',
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('rw_events', 'rw_boards', 'rw_selections', 'rw_board_resets') and c.relrowsecurity) = 4
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('rw_events', 'rw_boards', 'rw_selections', 'rw_board_resets'))
  and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name in ('rw_events', 'rw_boards', 'rw_selections', 'rw_board_resets') and grantee in ('anon', 'authenticated', 'PUBLIC')));
select pg_temp.chk('B1 the client functions are security definer with a fixed search path',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('rw_board_state', 'rw_board_rev', 'rw_claim_number', 'rw_confirm_selection', 'rw_admin_events', 'rw_admin_save_event', 'rw_admin_set_event_status', 'rw_admin_save_board', 'rw_admin_board', 'rw_admin_log', 'rw_board_lock', 'rw_board_unlock', 'rw_board_set_mode', 'rw_release_selection', 'rw_board_reset', 'rw_board_undo_reset', 'rw_sweep_holds')
    and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public'))));
select pg_temp.chk('B1 EVERY function of this migration (client API, helpers, triggers, core hooks) is security definer with search_path = public',
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('rw_board_rev', 'rw_board_state', 'rw_claim_number', 'rw_confirm_selection', 'rw_admin_events', 'rw_admin_save_event', 'rw_admin_set_event_status', 'rw_admin_save_board', 'rw_admin_board', 'rw_admin_log',
     'rw_sweep_holds', 'rw_board_lock', 'rw_board_unlock', 'rw_board_set_mode', 'rw_release_selection', 'rw_board_reset', 'rw_board_undo_reset', 'rw_sweep_board', 'rw_return_pick', 'rw_admin_board_json', 'rw_event_json', 'rw_board_view', 'rw_board_json', 'rw_event_rights',
     'rw_selection_json', 'rw_lock_board', 'rw_board_log', 'rw_need_reason', 'rw_current_event', 'rw_person_name', 'rw_boards_live', 'rw_selections_mixed', 'rw_selections_guard', 'rw_resets_guard', 'rw_events_make_boards', 'rw_boards_guard', 'rw_events_guard',
     'rw_selections_json', 'rw_review_selection_info', 'rw_release_selection_for_review', 'rw_settle_quiet', 'rw_lock_profiles') and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=public')) = 42);
select pg_temp.chk('B1 the two board reads are STABLE so they can never write (rev polling is cheap)',
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('rw_board_state', 'rw_board_rev') and provolatile = 's') = 2);

-- =========================================================================================== B14 the event a customer is looking at when none is named
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B14 no event named: the one active event whose window holds now', public.rw_board_state(null) -> 'event' ->> 'id' = pg_temp.c('E1') and jsonb_array_length(public.rw_board_state(null) -> 'boards') = 3);
select pg_temp.chk('B14 the same for the revision poll', public.rw_board_rev(null) ->> 'event_status' = 'active' and jsonb_array_length(public.rw_board_rev(null) -> 'boards') = 3
  and public.rw_board_rev(null) -> 'boards' -> 0 ->> 'id' = pg_temp.c('E1A'));
select pg_temp.chk('B14 the state lists 100 free numbers per board and my rights (3 earned, none used)',
  jsonb_array_length(pg_temp.board_of(pg_temp.st('E1'), 1) -> 'numbers') = 100 and (pg_temp.board_of(pg_temp.st('E1'), 1) ->> 'taken')::int = 0
  and pg_temp.st('E1') -> 'rights' = '{"earned":3,"used":0,"remaining":3}'::jsonb and (select count(*) from jsonb_array_elements(pg_temp.board_of(pg_temp.st('E1'), 1) -> 'numbers') e where e ->> 's' = 'free' and (e ->> 'c')::int = 0) = 100);
reset role; update public.rw_events set status = 'paused' where id = pg_temp.c('E1')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B14 no ACTIVE event: the most recent PAUSED event is shown read-only (status paused), with its boards (review round 1, item 11)',
  (public.rw_board_state(null) -> 'event' ->> 'status') = 'paused' and (public.rw_board_state(null) -> 'event' ->> 'id') = pg_temp.c('E1')
  and jsonb_array_length(public.rw_board_state(null) -> 'boards') = 3 and public.rw_board_rev(null) ->> 'event_status' = 'paused', public.rw_board_state(null) -> 'event' ->> 'status');
reset role; update public.rw_events set status = 'closed' where id = pg_temp.c('E1')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B14 no active and no paused event (a closed one is not offered): no event, no boards, zero rights', public.rw_board_state(null) -> 'event' = 'null'::jsonb and public.rw_board_state(null) -> 'boards' = '[]'::jsonb
  and public.rw_board_state(null) -> 'rights' = '{"earned":0,"used":0,"remaining":0}'::jsonb and public.rw_board_rev(null) -> 'boards' = '[]'::jsonb and public.rw_board_rev(null) -> 'event_status' = 'null'::jsonb);
reset role; update public.rw_events set status = 'paused' where id = pg_temp.c('E1')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B14 a paused event can still be looked at by its id (read only)', pg_temp.st('E1') -> 'event' ->> 'status' = 'paused');
reset role; update public.rw_events set status = 'active', ends_at = now() - interval '1 hour', starts_at = now() - interval '2 hours' where id = pg_temp.c('E1')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B14 an event whose window has ended is not "the active one"', public.rw_board_state(null) -> 'event' = 'null'::jsonb);
reset role; update public.rw_events set ends_at = null, starts_at = now() + interval '1 hour' where id = pg_temp.c('E1')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B14 neither is one that has not started', public.rw_board_state(null) -> 'event' = 'null'::jsonb);
reset role; update public.rw_events set starts_at = null where id = pg_temp.c('E1')::uuid;

-- =========================================================================================== B2 a claim, happy path
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('rev0', pg_temp.rev('E1', 'E1A')::text);
select pg_temp.put('c1', pg_temp.claim('E1', 'E1A', 7, 'key-A-0007')::text);
select pg_temp.chk('B2 the claim returns replay=false and the selection (confirmed at once: no hold)', (pg_temp.j('c1') ->> 'replay')::boolean = false and pg_temp.j('c1') -> 'selection' ->> 'number' = '7'
  and pg_temp.j('c1') -> 'selection' ->> 'status' = 'confirmed' and pg_temp.j('c1') -> 'selection' ->> 'expires_at' is null and pg_temp.j('c1') -> 'selection' ->> 'board_id' = pg_temp.c('E1A'), pg_temp.c('c1'));
select pg_temp.chk('B2 the answer carries the new board: number 7 is mine, one taken, revision +1', pg_temp.cell(pg_temp.j('c1') -> 'board', 7) = '{"n":7,"s":"mine","c":1}'::jsonb
  and (pg_temp.j('c1') -> 'board' ->> 'taken')::int = 1 and (pg_temp.j('c1') -> 'board' ->> 'rev')::int = pg_temp.c('rev0')::int + 1);
select pg_temp.chk('B2 and my rights: 3 earned, 1 used, 2 left', pg_temp.j('c1') -> 'rights' = '{"earned":3,"used":1,"remaining":2}'::jsonb);
select pg_temp.chk('B2 the selection key names are exactly the contract', pg_temp.keys(pg_temp.j('c1') -> 'selection') = 'board_id,expires_at,id,number,status' and pg_temp.keys(pg_temp.j('c1')) = 'board,replay,rights,selection');
select pg_temp.chk('B2 the same board is what the next read shows', pg_temp.cell(pg_temp.board_of(pg_temp.st('E1'), 1), 7) = '{"n":7,"s":"mine","c":1}'::jsonb and (pg_temp.board_of(pg_temp.st('E1'), 2) ->> 'taken')::int = 0);
select pg_temp.chk('B2 the oldest right was used and it points at the selection', pg_temp.q(format($f$select seq from public.rw_entitlements where profile_id = %L and status = 'used' and used_selection_id = %L$f$, pg_temp.c('A'), pg_temp.j('c1') -> 'selection' ->> 'id')) = '1');
select pg_temp.chk('B2 the selection is exclusive because the board was exclusive at claim time', pg_temp.q(format($f$select exclusive from public.rw_selections where id = %L$f$, pg_temp.j('c1') -> 'selection' ->> 'id')) = 'true');
select pg_temp.chk('B2 the claim is in the audit log with the customer as actor', pg_temp.q(format($f$select count(*) from public.rw_events_log where action = 'claim' and actor = %L and detail ->> 'board_id' = %L and detail ->> 'number' = '7'$f$, pg_temp.c('A'), pg_temp.c('E1A'))) = '1');

-- =========================================================================================== B5 the same key, again
select pg_temp.put('c1b', pg_temp.claim('E1', 'E1A', 7, 'key-A-0007')::text);
select pg_temp.chk('B5 same key and payload: replay=true and the same selection', (pg_temp.j('c1b') ->> 'replay')::boolean and pg_temp.j('c1b') -> 'selection' ->> 'id' = pg_temp.j('c1') -> 'selection' ->> 'id');
select pg_temp.chk('B5 a replay consumes nothing and bumps nothing', pg_temp.j('c1b') -> 'rights' = '{"earned":3,"used":1,"remaining":2}'::jsonb and pg_temp.rev('E1', 'E1A') = pg_temp.c('rev0')::int + 1
  and pg_temp.q(format($f$select count(*) from public.rw_selections where profile_id = %L$f$, pg_temp.c('A'))) = '1');
select pg_temp.err_like('B5 same key, different number: KEY_REUSED', pg_temp.cl('E1', 'E1A', 8, 'key-A-0007'), '%KEY_REUSED%', '23505');
select pg_temp.err_like('B5 same key, different board: KEY_REUSED', pg_temp.cl('E1', 'E1B', 7, 'key-A-0007'), '%KEY_REUSED%', '23505');
select pg_temp.err_like('B5 a key that is too short', pg_temp.cl('E1', 'E1A', 9, 'short'), '%INVALID_KEY%', '22023');
select pg_temp.err_like('B5 a key with forbidden characters', pg_temp.cl('E1', 'E1A', 9, 'bad key with spaces!'), '%INVALID_KEY%', '22023');
select pg_temp.err_like('B5 a key that is too long', pg_temp.cl('E1', 'E1A', 9, repeat('k', 65)), '%INVALID_KEY%', '22023');
select pg_temp.err_like('B5 no key at all', format($q$select public.rw_claim_number(%L, %L, 9, null)$q$, pg_temp.c('E1'), pg_temp.c('E1A')), '%INVALID_KEY%', '22023');
select pg_temp.chk('B5 a refused claim spent nothing', pg_temp.n_ent('A', 'E1', 'used') = 1 and pg_temp.n_ent('A', 'E1', 'available') = 2);
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.chk('B5 another member may use the same key text (keys are per customer)', (pg_temp.claim('E1', 'E1B', 5, 'key-A-0007') ->> 'replay')::boolean = false);

-- =========================================================================================== B3 two people, one exclusive number
select pg_temp.err_like('B3 a second customer cannot take number 7 on board A', pg_temp.cl('E1', 'E1A', 7, 'key-B-0007'), '%NUMBER_TAKEN%');
select pg_temp.chk('B3 the refused customer keeps the right (1 left of 2) and holds only number 5 on board B', pg_temp.n_ent('B', 'E1', 'used') = 1 and pg_temp.n_ent('B', 'E1', 'available') = 1);
select pg_temp.chk('B3 the board did not change for a refused claim', pg_temp.rev('E1', 'E1A') = pg_temp.c('rev0')::int + 1 and (pg_temp.board_of(pg_temp.st('E1'), 1) ->> 'taken')::int = 1);
select pg_temp.chk('B3 the same number on ANOTHER board is a different number (B took 5 on board B, A holds 7 on board A)', pg_temp.cell(pg_temp.board_of(pg_temp.st('E1'), 2), 5) ->> 's' = 'mine'
  and pg_temp.cell(pg_temp.board_of(pg_temp.st('E1'), 1), 7) ->> 's' = 'taken');
select pg_temp.put('selA7', pg_temp.j('c1') -> 'selection' ->> 'id');
reset role;
select pg_temp.put('bRight', (select id::text from public.rw_entitlements where profile_id = pg_temp.c('B')::uuid and status = 'available'));
select pg_temp.err_like('B3 a direct insert that bypasses the function hits the partial unique index', format($q$insert into public.rw_selections (event_id, board_id, number, profile_id, entitlement_id, exclusive, status)
  values (%L, %L, 7, %L, %L, true, 'confirmed')$q$, pg_temp.c('E1'), pg_temp.c('E1A'), pg_temp.c('B'), pg_temp.c('bRight')), '%rw_selections_exclusive_once%', '23505');
select pg_temp.err_like('B3 a right can back only one active selection (index)', format($q$insert into public.rw_selections (event_id, board_id, number, profile_id, entitlement_id, exclusive, status)
  values (%L, %L, 60, %L, (select entitlement_id from public.rw_selections where id = %L), true, 'confirmed')$q$, pg_temp.c('E1'), pg_temp.c('E1A'), pg_temp.c('A'), pg_temp.c('selA7')), '%rw_selections_entitlement_once%', '23505');
select pg_temp.err_like('B3 a selection must belong to the event of its board', format($q$insert into public.rw_selections (event_id, board_id, number, profile_id, entitlement_id, exclusive, status)
  values (%L, %L, 61, %L, %L, true, 'confirmed')$q$, pg_temp.c('E5'), pg_temp.c('E1A'), pg_temp.c('B'), pg_temp.c('bRight')), '%foreign key%', '23503');
select pg_temp.chk('B3 still exactly two active selections after all those attempts', pg_temp.q($f$select count(*) from public.rw_selections where status in ('reserved', 'confirmed')$f$) = '2');

-- =========================================================================================== B4 more claims than rights
set local role authenticated; select pg_temp.who('A');
select pg_temp.claim('E1', 'E1A', 8, 'key-A-0008'); select pg_temp.claim('E1', 'E1A', 9, 'key-A-0009');
select pg_temp.err_like('B4 a fourth claim with three rights: NO_ENTITLEMENT', pg_temp.cl('E1', 'E1A', 10, 'key-A-0010'), '%NO_ENTITLEMENT%');
select pg_temp.chk('B4 the customer holds exactly three numbers and has none left', pg_temp.q(format($f$select count(*) from public.rw_selections where profile_id = %L and status = 'confirmed'$f$, pg_temp.c('A'))) = '3'
  and pg_temp.st('E1') -> 'rights' = '{"earned":3,"used":3,"remaining":0}'::jsonb);
reset role; set local role authenticated; select pg_temp.who('D');
select pg_temp.err_like('B4 a customer with no rights at all: NO_ENTITLEMENT', pg_temp.cl('E1', 'E1A', 11, 'key-D-0011'), '%NO_ENTITLEMENT%');
reset role; set local role authenticated; select pg_temp.who('C');
select pg_temp.err_like('B4 a right that is only valid for board C cannot be used on board A', pg_temp.cl('E1', 'E1A', 12, 'key-C-0012'), '%NO_ENTITLEMENT%');
select pg_temp.err_like('B4 nor on board B', pg_temp.cl('E1', 'E1B', 12, 'key-C-0012'), '%NO_ENTITLEMENT%');
select pg_temp.put('c33', pg_temp.claim('E1', 'E1C', 33, 'key-C-0033')::text);
select pg_temp.chk('B4 on board C it works', pg_temp.j('c33') -> 'selection' ->> 'number' = '33' and pg_temp.st('E1') -> 'rights' = '{"earned":1,"used":1,"remaining":0}'::jsonb, pg_temp.c('c33') || ' / ' || (pg_temp.st('E1') -> 'rights')::text);
select pg_temp.err_like('B4 a claim for a board that is not in that event: NOT_FOUND', format($q$select public.rw_claim_number(%L, %L, 1, 'key-C-nf01')$q$, gen_random_uuid(), pg_temp.c('E1C')), '%NOT_FOUND%');
select pg_temp.err_like('B4 a board id that does not exist: NOT_FOUND', format($q$select public.rw_claim_number(%L, %L, 1, 'key-C-nf02')$q$, pg_temp.c('E1'), gen_random_uuid()), '%NOT_FOUND%');

-- =========================================================================================== B6 event not active / outside its window
reset role;
select pg_temp.mk_event('E4d', 'Draft event', '{"status":"draft"}');
select pg_temp.mk_event('E4p', 'Paused event', '{"status":"paused"}');
select pg_temp.mk_event('E4c', 'Closed event', '{"status":"closed"}');
select pg_temp.mk_event('E4f', 'Not started', jsonb_build_object('starts', (now() + interval '1 day')::text));
select pg_temp.mk_event('E4e', 'Window ended', jsonb_build_object('ends', (now() - interval '1 hour')::text));
select pg_temp.picks('A', 'E4d', 1); select pg_temp.picks('A', 'E4p', 1); select pg_temp.picks('A', 'E4c', 1); select pg_temp.picks('A', 'E4f', 1); select pg_temp.picks('A', 'E4e', 1);
set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B6 a draft event cannot be claimed', pg_temp.cl('E4d', 'E4dA', 1, 'key-A-e4d1'), '%EVENT_NOT_ACTIVE%');
select pg_temp.err_like('B6 a paused event cannot be claimed', pg_temp.cl('E4p', 'E4pA', 1, 'key-A-e4p1'), '%EVENT_NOT_ACTIVE%');
select pg_temp.err_like('B6 a closed event cannot be claimed', pg_temp.cl('E4c', 'E4cA', 1, 'key-A-e4c1'), '%EVENT_NOT_ACTIVE%');
select pg_temp.err_like('B6 an event that has not started cannot be claimed', pg_temp.cl('E4f', 'E4fA', 1, 'key-A-e4f1'), '%EVENT_NOT_ACTIVE%');
select pg_temp.err_like('B6 an event whose window has ended cannot be claimed', pg_temp.cl('E4e', 'E4eA', 1, 'key-A-e4e1'), '%EVENT_NOT_ACTIVE%');
select pg_temp.chk('B6 none of those refusals spent a right', pg_temp.n_ent('A', 'E4d', 'available') = 1 and pg_temp.n_ent('A', 'E4p', 'available') = 1 and pg_temp.n_ent('A', 'E4c', 'available') = 1
  and pg_temp.n_ent('A', 'E4f', 'available') = 1 and pg_temp.n_ent('A', 'E4e', 'available') = 1);
select pg_temp.err_like('B6 a customer cannot look at a draft event', format($q$select public.rw_board_state(%L)$q$, pg_temp.c('E4d')), '%NOT_FOUND%');
select pg_temp.err_like('B6 nor poll its revisions', format($q$select public.rw_board_rev(%L)$q$, pg_temp.c('E4d')), '%NOT_FOUND%');
select pg_temp.chk('B6 a closed event can still be looked at (read only)', pg_temp.st('E4c') -> 'event' ->> 'status' = 'closed' and jsonb_array_length(pg_temp.st('E4c') -> 'boards') = 3);
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.chk('B6 staff can look at a draft event', public.rw_board_state(pg_temp.c('E4d')::uuid) -> 'event' ->> 'status' = 'draft');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B6 resuming a paused event (Super Admin, with a reason) opens it for claims', public.rw_admin_set_event_status(pg_temp.c('E4p')::uuid, 'active', 'resume after the break') ->> 'status' = 'active');
reset role; update public.rw_events set starts_at = now() - interval '1 hour' where id = pg_temp.c('E4f')::uuid; update public.rw_events set ends_at = now() + interval '1 hour' where id = pg_temp.c('E4e')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B6 once resumed it can be claimed', pg_temp.claim('E4p', 'E4pA', 1, 'key-A-e4p2') -> 'selection' ->> 'status' = 'confirmed');
select pg_temp.chk('B6 once its window opens it can be claimed', pg_temp.claim('E4f', 'E4fA', 1, 'key-A-e4f2') -> 'selection' ->> 'status' = 'confirmed');
select pg_temp.chk('B6 a window that is extended opens it again', pg_temp.claim('E4e', 'E4eA', 1, 'key-A-e4e2') -> 'selection' ->> 'status' = 'confirmed');

-- =========================================================================================== B7 number range
reset role; select pg_temp.mk_event('E7', 'Small range', '{"nmin":10,"nmax":12}'); select pg_temp.picks('A', 'E7', 3);
set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B7 below the range', pg_temp.cl('E7', 'E7A', 9, 'key-A-r0009'), '%NUMBER_OUT_OF_RANGE%');
select pg_temp.err_like('B7 above the range', pg_temp.cl('E7', 'E7A', 13, 'key-A-r0013'), '%NUMBER_OUT_OF_RANGE%');
select pg_temp.err_like('B7 negative', pg_temp.cl('E1', 'E1A', -1, 'key-A-rneg1'), '%NUMBER_OUT_OF_RANGE%');
select pg_temp.err_like('B7 100 on a 0-99 board (checked before the rights, A has none left)', pg_temp.cl('E1', 'E1A', 100, 'key-A-r0100'), '%NUMBER_OUT_OF_RANGE%');
select pg_temp.err_like('B7 no number at all', format($q$select public.rw_claim_number(%L, %L, null, 'key-A-rnul1')$q$, pg_temp.c('E1'), pg_temp.c('E1A')), '%NUMBER_OUT_OF_RANGE%');
select pg_temp.chk('B7 the lowest and the highest number of the range are valid', pg_temp.claim('E7', 'E7A', 10, 'key-A-r0010') -> 'selection' ->> 'number' = '10' and pg_temp.claim('E7', 'E7A', 12, 'key-A-r0012') -> 'selection' ->> 'number' = '12');
select pg_temp.chk('B7 the board lists exactly the numbers of the range', (select array_agg((e ->> 'n')::int order by (e ->> 'n')::int) from jsonb_array_elements(pg_temp.board_of(pg_temp.st('E7'), 1) -> 'numbers') e) = array[10, 11, 12]
  and (pg_temp.board_of(pg_temp.st('E7'), 1) ->> 'taken')::int = 2);
select pg_temp.chk('B7 a refused out-of-range claim spent nothing', pg_temp.n_ent('A', 'E7', 'used') = 2 and pg_temp.n_ent('A', 'E7', 'available') = 1);

-- =========================================================================================== B8 at most N numbers per customer
reset role; select pg_temp.mk_event('E3', 'Limit of two', '{"maxpc":2}'); select pg_temp.picks('A', 'E3', 3); select pg_temp.picks('B', 'E3', 1);
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('l1', pg_temp.claim('E3', 'E3A', 1, 'key-A-l0001')::text); select pg_temp.claim('E3', 'E3B', 2, 'key-A-l0002');
select pg_temp.err_like('B8 the third number of a customer with a limit of two: LIMIT_REACHED', pg_temp.cl('E3', 'E3A', 3, 'key-A-l0003'), '%LIMIT_REACHED%');
select pg_temp.chk('B8 the limit counts numbers on every board of the event, and the right stays unspent', pg_temp.n_ent('A', 'E3', 'available') = 1 and pg_temp.n_ent('A', 'E3', 'used') = 2);
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.chk('B8 another customer is not affected', pg_temp.claim('E3', 'E3A', 4, 'key-B-l0004') -> 'selection' ->> 'number' = '4');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B8 a released number frees one place under the limit', public.rw_release_selection((pg_temp.j('l1') -> 'selection' ->> 'id')::uuid, 'asked to move') -> 'board' ->> 'taken' = '1');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B8 so the customer can pick again (and the right was returned)', pg_temp.claim('E3', 'E3A', 3, 'key-A-l0003') -> 'selection' ->> 'number' = '3');
select pg_temp.err_like('B8 and is at the limit again', pg_temp.cl('E3', 'E3A', 9, 'key-A-l0009'), '%LIMIT_REACHED%');

-- =========================================================================================== B9 holds (hold_minutes > 0)
reset role; select pg_temp.mk_event('E2', 'With a hold', '{"hold":10}'); select pg_temp.picks('A', 'E2', 3); select pg_temp.picks('B', 'E2', 1);
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('h1', pg_temp.claim('E2', 'E2A', 5, 'key-A-h0005')::text);
select pg_temp.chk('B9 a claim on an event with a hold is "reserved" with a deadline about 10 minutes away', pg_temp.j('h1') -> 'selection' ->> 'status' = 'reserved'
  and (pg_temp.j('h1') -> 'selection' ->> 'expires_at')::timestamptz between now() + interval '9 minutes' and now() + interval '11 minutes', pg_temp.c('h1'));
select pg_temp.chk('B9 the right is spent during the hold', pg_temp.j('h1') -> 'rights' = '{"earned":3,"used":1,"remaining":2}'::jsonb);
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.err_like('B9 a held number cannot be claimed by someone else', pg_temp.cl('E2', 'E2A', 5, 'key-B-h0005'), '%NUMBER_TAKEN%');
select pg_temp.chk('B9 it shows as taken', pg_temp.cell(pg_temp.board_of(pg_temp.st('E2'), 1), 5) = '{"n":5,"s":"taken","c":1}'::jsonb);
reset role; set local role authenticated; select pg_temp.who('C');
select pg_temp.err_like('B9 only the owner can confirm a hold', format($q$select public.rw_confirm_selection(%L)$q$, pg_temp.j('h1') -> 'selection' ->> 'id'), '%NOT_FOUND%');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.put('rev_h', pg_temp.rev('E2', 'E2A')::text);
select pg_temp.put('h1c', public.rw_confirm_selection((pg_temp.j('h1') -> 'selection' ->> 'id')::uuid)::text);
select pg_temp.chk('B9 confirming makes it confirmed, without a deadline, and bumps the revision', pg_temp.j('h1c') -> 'selection' ->> 'status' = 'confirmed' and pg_temp.j('h1c') -> 'selection' ->> 'expires_at' is null
  and (pg_temp.j('h1c') -> 'board' ->> 'rev')::int = pg_temp.c('rev_h')::int + 1 and pg_temp.keys(pg_temp.j('h1c')) = 'board,rights,selection');
select pg_temp.chk('B9 confirming again is harmless (same answer, no new revision, one audit row)', public.rw_confirm_selection((pg_temp.j('h1') -> 'selection' ->> 'id')::uuid) -> 'selection' ->> 'status' = 'confirmed'
  and pg_temp.rev('E2', 'E2A') = pg_temp.c('rev_h')::int + 1 and pg_temp.q($f$select count(*) from public.rw_events_log where action = 'confirm'$f$) = '1');
select pg_temp.put('h2', pg_temp.claim('E2', 'E2A', 6, 'key-A-h0006')::text);
select pg_temp.put('rev_pre', pg_temp.rev('E2', 'E2A')::text);
reset role; update public.rw_selections set expires_at = now() - interval '1 minute' where id = (pg_temp.j('h2') -> 'selection' ->> 'id')::uuid;      -- the clock moves on
set local role authenticated; select pg_temp.who('B');
select pg_temp.chk('B9 a lapsed hold is free for readers and the revision they poll moves (+1)', pg_temp.cell(pg_temp.board_of(pg_temp.st('E2'), 1), 6) = '{"n":6,"s":"free","c":0}'::jsonb and pg_temp.rev('E2', 'E2A') = pg_temp.c('rev_pre')::int + 1
  and (pg_temp.board_of(pg_temp.st('E2'), 1) ->> 'rev')::int = pg_temp.c('rev_pre')::int + 1 and (pg_temp.board_of(pg_temp.st('E2'), 1) ->> 'taken')::int = 1);
select pg_temp.chk('B9 ... but reading wrote nothing: the row is still "reserved" and the right still spent', pg_temp.sel_status(pg_temp.j('h2') -> 'selection' ->> 'id') = 'reserved' and pg_temp.n_ent('A', 'E2', 'used') = 2);
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B9 the owner cannot confirm a lapsed hold: HOLD_EXPIRED', format($q$select public.rw_confirm_selection(%L)$q$, pg_temp.j('h2') -> 'selection' ->> 'id'), '%HOLD_EXPIRED%');
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.put('h3', pg_temp.claim('E2', 'E2A', 6, 'key-B-h0006')::text);
select pg_temp.chk('B9 someone else can take the number: the claim sweeps the lapsed hold', pg_temp.j('h3') -> 'selection' ->> 'number' = '6' and pg_temp.j('h3') -> 'selection' ->> 'status' = 'reserved');
select pg_temp.chk('B9 the lapsed hold is now "expired" and its pick is back with its owner', pg_temp.sel_status(pg_temp.j('h2') -> 'selection' ->> 'id') = 'expired' and pg_temp.n_ent('A', 'E2', 'available') = 2 and pg_temp.n_ent('A', 'E2', 'used') = 1);
select pg_temp.chk('B9 the revision did not go backwards: +1 for the sweep, +1 for the claim since the poll', pg_temp.rev('E2', 'E2A') = pg_temp.c('rev_pre')::int + 2, pg_temp.rev('E2', 'E2A')::text || ' vs ' || pg_temp.c('rev_pre'));
select pg_temp.chk('B9 the expiry is in the audit log with no actor (the system)', pg_temp.q($f$select count(*) from public.rw_events_log where action = 'expire' and actor is null and detail ->> 'number' = '6'$f$) = '1');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.put('h4', pg_temp.claim('E2', 'E2B', 7, 'key-A-h0007')::text);
reset role; update public.rw_selections set expires_at = now() - interval '2 minutes' where id = (pg_temp.j('h4') -> 'selection' ->> 'id')::uuid;
set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B9 staff can sweep lapsed holds: it reports how many and returns the pick', public.rw_sweep_holds(pg_temp.c('E2')::uuid) = 1 and pg_temp.sel_status(pg_temp.j('h4') -> 'selection' ->> 'id') = 'expired' and pg_temp.n_ent('A', 'E2', 'available') = 2);
select pg_temp.chk('B9 sweeping again finds nothing (and without an event it covers all events)', public.rw_sweep_holds(pg_temp.c('E2')::uuid) = 0 and public.rw_sweep_holds() = 0);

-- =========================================================================================== B10 switching the mode (selections are never rewritten)
create or replace function pg_temp.run(p_sql text) returns void language plpgsql as $$ begin execute p_sql; exception when others then raise exception '% [%]', sqlerrm, p_sql; end $$;
create or replace function pg_temp.ins(ev text, bd text, n int, who text, ent text, excl boolean) returns text language sql as $$
  select format($f$insert into public.rw_selections (event_id, board_id, number, profile_id, entitlement_id, exclusive, status) values (%L, %L, %s, %L, %L, %L, 'confirmed')$f$, pg_temp.c(ev), pg_temp.c(bd), n, pg_temp.c(who), ent, excl) $$;
create or replace function pg_temp.ent(p_who text, p_event text, p_i int) returns text language sql as $$
  select pg_temp.q(format($f$select id from public.rw_entitlements where profile_id = %L and event_id = %L order by seq offset %s limit 1$f$, pg_temp.c(p_who), pg_temp.c(p_event), p_i)) $$;
reset role; select pg_temp.mk_event('E6', 'Mode switching'); select pg_temp.picks('A', 'E6', 3); select pg_temp.picks('B', 'E6', 3); select pg_temp.picks('C', 'E6', 2); select pg_temp.picks('D', 'E6', 2);
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('m1', pg_temp.claim('E6', 'E6A', 7, 'key-A-m0007')::text);
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('rev_m', pg_temp.rev('E6', 'E6A')::text);
select pg_temp.put('sw1', public.rw_board_set_mode(pg_temp.c('E6A')::uuid, 'shared', 'trial of shared numbers')::text);
select pg_temp.chk('B10 switching returns the board in its new mode, revision +1, and keeps its selections', pg_temp.j('sw1') -> 'board' ->> 'mode' = 'shared' and (pg_temp.j('sw1') -> 'board' ->> 'rev')::int = pg_temp.c('rev_m')::int + 1
  and pg_temp.keys(pg_temp.j('sw1')) = 'board,log,numbers,resets' and pg_temp.j('sw1') -> 'numbers' -> 0 ->> 'n' = '7');
select pg_temp.chk('B10 the existing selection is untouched: still exclusive, still confirmed', pg_temp.q(format($f$select exclusive || status from public.rw_selections where id = %L$f$, pg_temp.j('m1') -> 'selection' ->> 'id')) = 'trueconfirmed');
select pg_temp.chk('B10 the change is in the audit log with who, why, old and new', pg_temp.q($f$select count(*) from public.rw_events_log where action = 'set_mode' and detail ->> 'reason' = 'trial of shared numbers' and detail ->> 'from' = 'exclusive' and detail ->> 'to' = 'shared'$f$) = '1');
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.err_like('B10 a number held EXCLUSIVELY cannot be joined, even after the board became shared', pg_temp.cl('E6', 'E6A', 7, 'key-B-m0007'), '%NUMBER_TAKEN%');
select pg_temp.put('m2', pg_temp.claim('E6', 'E6A', 8, 'key-B-m0008')::text);
select pg_temp.chk('B10 on a shared board a claim is a shared selection', pg_temp.q(format($f$select exclusive from public.rw_selections where id = %L$f$, pg_temp.j('m2') -> 'selection' ->> 'id')) = 'false' and pg_temp.cell(pg_temp.j('m2') -> 'board', 8) = '{"n":8,"s":"mine","c":1}'::jsonb);
reset role; set local role authenticated; select pg_temp.who('C');
select pg_temp.put('m3', pg_temp.claim('E6', 'E6A', 8, 'key-C-m0008')::text);
select pg_temp.chk('B10 a second customer can share number 8 (two holders), and sees it as mine with count 2', pg_temp.cell(pg_temp.j('m3') -> 'board', 8) = '{"n":8,"s":"mine","c":2}'::jsonb);
select pg_temp.err_like('B10 the same customer cannot hold the same shared number twice', pg_temp.cl('E6', 'E6A', 8, 'key-C-m8two'), '%NUMBER_TAKEN%');
reset role; set local role authenticated; select pg_temp.who('D');
select pg_temp.chk('B10 a third customer sees 7 as taken (exclusive) and 8 as shared by 2', pg_temp.cell(pg_temp.board_of(pg_temp.st('E6'), 1), 7) = '{"n":7,"s":"taken","c":1}'::jsonb and pg_temp.cell(pg_temp.board_of(pg_temp.st('E6'), 1), 8) = '{"n":8,"s":"shared","c":2}'::jsonb);
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B10 switching back to exclusive keeps both shared rows', public.rw_board_set_mode(pg_temp.c('E6A')::uuid, 'exclusive', 'back to one owner per number') -> 'board' ->> 'mode' = 'exclusive'
  and pg_temp.q($f$select count(*) from public.rw_selections where board_id = (select id from public.rw_boards where name = 'Board A' and event_id = (select id from public.rw_events where name = 'Mode switching')) and not exclusive and status = 'confirmed'$f$) = '2');
reset role; set local role authenticated; select pg_temp.who('D');
select pg_temp.err_like('B10 an exclusive claim on a number that SHARED holders still hold: NUMBER_TAKEN', pg_temp.cl('E6', 'E6A', 8, 'key-D-m0008'), '%NUMBER_TAKEN%');
select pg_temp.put('m4', pg_temp.claim('E6', 'E6A', 9, 'key-D-m0009')::text);
select pg_temp.chk('B10 a free number is claimed exclusively again', pg_temp.q(format($f$select exclusive from public.rw_selections where id = %L$f$, pg_temp.j('m4') -> 'selection' ->> 'id')) = 'true');
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.err_like('B10 a holder of a shared number cannot "re-claim" it on the exclusive board either', pg_temp.cl('E6', 'E6A', 8, 'key-B-m8two'), '%NUMBER_TAKEN%');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('rev_same', pg_temp.rev('E6', 'E6A')::text);
select pg_temp.chk('B10 switching to the mode it already has changes nothing (no revision, no audit row)', public.rw_board_set_mode(pg_temp.c('E6A')::uuid, 'exclusive', 'same again') -> 'board' ->> 'mode' = 'exclusive'
  and pg_temp.rev('E6', 'E6A') = pg_temp.c('rev_same')::int and pg_temp.q($f$select count(*) from public.rw_events_log where action = 'set_mode' and detail ->> 'reason' = 'same again'$f$) = '0');
select pg_temp.err_like('B10 an unknown mode', format($q$select public.rw_board_set_mode(%L, 'half', 'x')$q$, pg_temp.c('E6A')), '%BAD_RULE%');
select pg_temp.err_like('B10 a mode switch needs a reason', format($q$select public.rw_board_set_mode(%L, 'shared', '   ')$q$, pg_temp.c('E6A')), '%REASON_REQUIRED%');
select pg_temp.err_like('B10 a null reason too', format($q$select public.rw_board_set_mode(%L, 'shared', null)$q$, pg_temp.c('E6A')), '%REASON_REQUIRED%');
-- direct writes cannot put an exclusive and a shared holder on one number either (E5 is a draft event only used for this)
reset role; select pg_temp.picks('A', 'E5', 3); select pg_temp.picks('B', 'E5', 3);
select pg_temp.run(pg_temp.ins('E5', 'E5A', 50, 'A', pg_temp.ent('A', 'E5', 0), false));
select pg_temp.err_like('B10 a direct EXCLUSIVE row next to a shared holder is refused', pg_temp.ins('E5', 'E5A', 50, 'B', pg_temp.ent('B', 'E5', 0), true), '%rw_selections_mixed_once%', '23505');
select pg_temp.err_like('B10 a direct second SHARED row of the same customer is refused (index)', pg_temp.ins('E5', 'E5A', 50, 'A', pg_temp.ent('A', 'E5', 1), false), '%rw_selections_shared_once%', '23505');
select pg_temp.run(pg_temp.ins('E5', 'E5A', 50, 'B', pg_temp.ent('B', 'E5', 0), false));
select pg_temp.run(pg_temp.ins('E5', 'E5A', 51, 'B', pg_temp.ent('B', 'E5', 1), true));
select pg_temp.err_like('B10 a direct SHARED row next to an exclusive holder is refused', pg_temp.ins('E5', 'E5A', 51, 'A', pg_temp.ent('A', 'E5', 1), false), '%rw_selections_mixed_once%', '23505');
select pg_temp.chk('B10 two shared holders of one number are fine at database level', pg_temp.q($f$select count(*) from public.rw_selections where number = 50 and not exclusive and status = 'confirmed' and event_id = (select id from public.rw_events where name = 'Raw inserts')$f$) = '2');

-- =========================================================================================== B15 what customers can see
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('viewA', pg_temp.st('E6')::text);
reset role; set local role authenticated; select pg_temp.who('D');
select pg_temp.put('viewD', pg_temp.st('E6')::text);
select pg_temp.chk('B15 two customers see identical boards apart from which numbers are "mine" (same count, same everything else)', not exists (
    select 1 from jsonb_array_elements(pg_temp.j('viewA') -> 'boards') ba cross join jsonb_array_elements(ba -> 'numbers') ca,
                  jsonb_array_elements(pg_temp.j('viewD') -> 'boards') bd cross join jsonb_array_elements(bd -> 'numbers') cd
    where ba ->> 'id' = bd ->> 'id' and ca ->> 'n' = cd ->> 'n' and (ca ->> 'c' <> cd ->> 'c' or (ca ->> 's' <> cd ->> 's' and not ('mine' = any (array[ca ->> 's', cd ->> 's'])))))
  and (select jsonb_agg(b - 'numbers' - 'remaining' order by b ->> 'slot') from jsonb_array_elements(pg_temp.j('viewA') -> 'boards') b) = (select jsonb_agg(b - 'numbers' - 'remaining' order by b ->> 'slot') from jsonb_array_elements(pg_temp.j('viewD') -> 'boards') b)
  and pg_temp.j('viewA') -> 'event' = pg_temp.j('viewD') -> 'event');
select pg_temp.chk('B15 ... and they do differ where it matters: A sees 7 as mine and D sees it as taken; D sees 9 as mine', pg_temp.cell(pg_temp.board_of(pg_temp.j('viewA'), 1), 7) ->> 's' = 'mine' and pg_temp.cell(pg_temp.board_of(pg_temp.j('viewD'), 1), 7) ->> 's' = 'taken'
  and pg_temp.cell(pg_temp.board_of(pg_temp.j('viewD'), 1), 9) ->> 's' = 'mine' and pg_temp.cell(pg_temp.board_of(pg_temp.j('viewA'), 1), 9) ->> 's' = 'taken');
select pg_temp.chk('B15 no identity anywhere in what D sees (no id, name, phone, e-mail of A, B or C)', not exists (select 1 from (select pg_temp.c('viewD') || pg_temp.c('m4') as t) x
  where x.t like '%' || pg_temp.c('A') || '%' or x.t like '%' || pg_temp.c('B') || '%' or x.t like '%' || pg_temp.c('C') || '%' or x.t like '%Member A%' or x.t like '%Member B%' or x.t like '%0811111111%' or x.t like '%a@seed.test%'));
select pg_temp.chk('B15 the shape is exactly the contract: state, board, cell', pg_temp.keys(pg_temp.j('viewD')) = 'boards,event,rights' and pg_temp.keys(pg_temp.board_of(pg_temp.j('viewD'), 1)) = 'color,id,mode,name,numbers,remaining,rev,slot,state,taken'
  and pg_temp.keys(pg_temp.cell(pg_temp.board_of(pg_temp.j('viewD'), 1), 7)) = 'c,n,s' and pg_temp.keys(pg_temp.j('viewD') -> 'event') = 'ends_at,hold_minutes,id,name,number_max,number_min,starts_at,status');
select pg_temp.chk('B15 the revision poll is exactly {event_status, boards:[{id, rev, state}]}', pg_temp.keys(public.rw_board_rev(pg_temp.c('E6')::uuid)) = 'boards,event_status'
  and pg_temp.keys(public.rw_board_rev(pg_temp.c('E6')::uuid) -> 'boards' -> 0) = 'id,rev,state');

-- =========================================================================================== B11 release one number
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('rev_r', pg_temp.rev('E6', 'E6A')::text);
select pg_temp.put('rel1', public.rw_release_selection((pg_temp.j('m1') -> 'selection' ->> 'id')::uuid, 'customer asked by phone')::text);
select pg_temp.chk('B11 release frees the number (selection "released") and the pick goes back to its owner', pg_temp.sel_status(pg_temp.j('m1') -> 'selection' ->> 'id') = 'released' and pg_temp.n_ent('A', 'E6', 'available') = 3 and pg_temp.n_ent('A', 'E6', 'used') = 0);
select pg_temp.chk('B11 it returns the board for staff: number 7 gone, revision +1, audit row with reason and actor', not exists (select 1 from jsonb_array_elements(pg_temp.j('rel1') -> 'numbers') e where e ->> 'n' = '7')
  and (pg_temp.j('rel1') -> 'board' ->> 'rev')::int = pg_temp.c('rev_r')::int + 1
  and exists (select 1 from jsonb_array_elements(pg_temp.j('rel1') -> 'log') l where l ->> 'action' = 'release' and l ->> 'reason' = 'customer asked by phone' and l ->> 'actor_name' = pg_temp.c('nameS')));
select pg_temp.chk('B11 only that number was affected: B and C still hold 8, D holds 9', (pg_temp.j('rel1') -> 'numbers' -> 0 ->> 'n') = '8' and jsonb_array_length(pg_temp.j('rel1') -> 'numbers' -> 0 -> 'holders') = 2 and jsonb_array_length(pg_temp.j('rel1') -> 'numbers') = 2);
select pg_temp.err_like('B11 releasing it again: NOT_FOUND (it is not held any more)', format($q$select public.rw_release_selection(%L, 'again')$q$, pg_temp.j('m1') -> 'selection' ->> 'id'), '%NOT_FOUND%');
select pg_temp.err_like('B11 a release needs a reason', format($q$select public.rw_release_selection(%L, '')$q$, pg_temp.j('m2') -> 'selection' ->> 'id'), '%REASON_REQUIRED%');
select pg_temp.err_like('B11 an unknown selection: NOT_FOUND', format($q$select public.rw_release_selection(%L, 'x')$q$, gen_random_uuid()), '%NOT_FOUND%');
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.chk('B11 the freed number can be taken by someone else at once', pg_temp.claim('E6', 'E6A', 7, 'key-B-m7new') -> 'selection' ->> 'number' = '7');
-- a right whose bill was taken back after the pick is never given back: it is revoked (and the review flag is resolved)
reset role; select pg_temp.mk_event('E10', 'Needs review'); select pg_temp.picks('A', 'E10', 2);
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('n1', pg_temp.claim('E10', 'E10A', 1, 'key-A-n0001')::text); select pg_temp.put('n2', pg_temp.claim('E10', 'E10A', 2, 'key-A-n0002')::text);
reset role; update public.rw_entitlements set needs_review = true where used_selection_id = (pg_temp.j('n1') -> 'selection' ->> 'id')::uuid;
set local role authenticated; select pg_temp.who('S');
select public.rw_release_selection((pg_temp.j('n1') -> 'selection' ->> 'id')::uuid, 'bill was reversed');
select pg_temp.chk('B11 a flagged right is revoked on release, not returned; the number is free', pg_temp.n_ent('A', 'E10', 'revoked') = 1 and pg_temp.n_ent('A', 'E10', 'available') = 0 and pg_temp.n_ent('A', 'E10', 'used') = 1
  and pg_temp.q($f$select count(*) from public.rw_entitlements where needs_review and event_id = (select id from public.rw_events where name = 'Needs review')$f$) = '0');
select public.rw_release_selection((pg_temp.j('n2') -> 'selection' ->> 'id')::uuid, 'second one');
select pg_temp.chk('B11 an ordinary right is returned', pg_temp.n_ent('A', 'E10', 'available') = 1 and pg_temp.n_ent('A', 'E10', 'revoked') = 1);

-- =========================================================================================== B13 revision, lock and unlock (E1 board B holds B's number 5)
select pg_temp.put('rv0', pg_temp.rev('E1', 'E1B')::text);
select pg_temp.put('lk', public.rw_board_lock(pg_temp.c('E1B')::uuid, 'counting the numbers')::text);
select pg_temp.chk('B13 lock: state locked, revision +1, nothing else touched (number 5 is still held)', pg_temp.j('lk') -> 'board' ->> 'state' = 'locked' and (pg_temp.j('lk') -> 'board' ->> 'rev')::int = pg_temp.c('rv0')::int + 1
  and pg_temp.j('lk') -> 'board' ->> 'mode' = 'exclusive' and pg_temp.j('lk') -> 'numbers' -> 0 ->> 'n' = '5');
select pg_temp.chk('B13 locking again changes nothing', public.rw_board_lock(pg_temp.c('E1B')::uuid, 'again') -> 'board' ->> 'rev' = (pg_temp.c('rv0')::int + 1)::text);
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.chk('B13 customers see the lock in the state and in the poll', pg_temp.board_of(pg_temp.st('E1'), 2) ->> 'state' = 'locked' and (select b ->> 'state' from jsonb_array_elements(public.rw_board_rev(pg_temp.c('E1')::uuid) -> 'boards') b where b ->> 'id' = pg_temp.c('E1B')) = 'locked');
select pg_temp.err_like('B13 a locked board refuses claims: BOARD_LOCKED', pg_temp.cl('E1', 'E1B', 6, 'key-B-lk006'), '%BOARD_LOCKED%');
select pg_temp.chk('B13 ... the right was not spent, the other boards of the event still work (board A is just full of A''s numbers)', pg_temp.n_ent('B', 'E1', 'available') = 1);
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('ul', public.rw_board_unlock(pg_temp.c('E1B')::uuid, 'counted')::text);
select pg_temp.chk('B13 unlock: open again, revision +1 more', pg_temp.j('ul') -> 'board' ->> 'state' = 'open' and (pg_temp.j('ul') -> 'board' ->> 'rev')::int = pg_temp.c('rv0')::int + 2);
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.chk('B13 a claim is +1', (pg_temp.claim('E1', 'E1B', 6, 'key-B-lk006') -> 'board' ->> 'rev')::int = pg_temp.c('rv0')::int + 3);
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('rv_rel', (public.rw_release_selection((select (e ->> 'selection_id')::uuid from jsonb_array_elements(public.rw_admin_board(pg_temp.c('E1B')::uuid) -> 'numbers' -> 1 -> 'holders') e limit 1), 'tidy') -> 'board' ->> 'rev'));
select pg_temp.chk('B13 a release is +1', pg_temp.c('rv_rel')::int = pg_temp.c('rv0')::int + 4);
select pg_temp.put('rv_rs', (public.rw_board_reset(pg_temp.c('E1B')::uuid, 'start over', true, 'Board B') -> 'board' ->> 'rev'));
select pg_temp.chk('B13 a reset is +1 (however many numbers it clears)', pg_temp.c('rv_rs')::int = pg_temp.c('rv0')::int + 5);
select pg_temp.put('rv_un', (public.rw_board_undo_reset((public.rw_admin_board(pg_temp.c('E1B')::uuid) -> 'board' ->> 'last_reset_id')::uuid, 'oops') -> 'board' ->> 'rev'));
select pg_temp.chk('B13 an undo is +1', pg_temp.c('rv_un')::int = pg_temp.c('rv0')::int + 6);
select pg_temp.chk('B13 the whole story is in the audit log with the reasons', (select string_agg(l ->> 'action' || ':' || coalesce(l ->> 'reason', ''), ',' order by ord desc) from jsonb_array_elements(public.rw_admin_board(pg_temp.c('E1B')::uuid) -> 'log') with ordinality as t(l, ord)
  where l ->> 'action' in ('lock', 'unlock', 'release', 'reset', 'undo_reset')) = 'lock:counting the numbers,unlock:counted,release:tidy,reset:start over,undo_reset:oops');

-- =========================================================================================== B12 reset a board, and undo it
reset role; select pg_temp.mk_event('E8', 'Reset event'); select pg_temp.picks('A', 'E8', 3); select pg_temp.picks('B', 'E8', 2); select pg_temp.picks('C', 'E8', 1);
set local role authenticated; select pg_temp.who('A'); select pg_temp.put('s1', pg_temp.claim('E8', 'E8A', 1, 'key-A-s0001')::text); select pg_temp.put('s4', pg_temp.claim('E8', 'E8B', 4, 'key-A-s0004')::text);
reset role; set local role authenticated; select pg_temp.who('B'); select pg_temp.put('s2', pg_temp.claim('E8', 'E8A', 2, 'key-B-s0002')::text);
reset role; set local role authenticated; select pg_temp.who('C'); select pg_temp.put('s3', pg_temp.claim('E8', 'E8A', 3, 'key-C-s0003')::text);
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.err_like('B12 an Admin cannot reset, even with the right confirmation', format($q$select public.rw_board_reset(%L, 'new round', true, 'Board A')$q$, pg_temp.c('E8A')), '%not allowed%', '42501');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.err_like('B12 a reset needs a reason', format($q$select public.rw_board_reset(%L, ' ', true, 'Board A')$q$, pg_temp.c('E8A')), '%REASON_REQUIRED%');
select pg_temp.err_like('B12 the confirmation must be the board name exactly (case)', format($q$select public.rw_board_reset(%L, 'new round', true, 'board a')$q$, pg_temp.c('E8A')), '%CONFIRM_MISMATCH%');
select pg_temp.err_like('B12 ... (a trailing space)', format($q$select public.rw_board_reset(%L, 'new round', true, 'Board A ')$q$, pg_temp.c('E8A')), '%CONFIRM_MISMATCH%');
select pg_temp.err_like('B12 ... (another board''s name)', format($q$select public.rw_board_reset(%L, 'new round', true, 'Board B')$q$, pg_temp.c('E8A')), '%CONFIRM_MISMATCH%');
select pg_temp.err_like('B12 ... (nothing typed)', format($q$select public.rw_board_reset(%L, 'new round', true, null)$q$, pg_temp.c('E8A')), '%CONFIRM_MISMATCH%');
select pg_temp.chk('B12 none of those changed anything', pg_temp.q($f$select count(*) from public.rw_selections where status = 'confirmed' and event_id = (select id from public.rw_events where name = 'Reset event')$f$) = '4'
  and pg_temp.q(format($f$select count(*) from public.rw_board_resets where board_id = %L$f$, pg_temp.c('E8A'))) = '0');
select pg_temp.put('rev_e8', pg_temp.rev('E8', 'E8A')::text);
select pg_temp.put('rs1', public.rw_board_reset(pg_temp.c('E8A')::uuid, 'new round', true, 'Board A')::text);
select pg_temp.put('rs1id', pg_temp.j('rs1') -> 'resets' -> 0 ->> 'id');
select pg_temp.chk('B12 reset returns the empty board with its reset record (affected 3, picks returned, who, undo-able)', (pg_temp.j('rs1') -> 'board' ->> 'taken')::int = 0 and pg_temp.j('rs1') -> 'numbers' = '[]'::jsonb
  and (pg_temp.j('rs1') -> 'resets' -> 0 ->> 'affected')::int = 3 and (pg_temp.j('rs1') -> 'resets' -> 0 ->> 'returned_picks')::boolean and pg_temp.j('rs1') -> 'resets' -> 0 ->> 'by_name' = pg_temp.c('nameS')
  and pg_temp.j('rs1') -> 'resets' -> 0 ->> 'reason' = 'new round' and pg_temp.j('rs1') -> 'resets' -> 0 -> 'undone_at' = 'null'::jsonb and pg_temp.j('rs1') -> 'board' ->> 'last_reset_id' = pg_temp.c('rs1id')
  and pg_temp.keys(pg_temp.j('rs1') -> 'resets' -> 0) = 'affected,at,by_name,id,reason,returned_picks,undone_at', pg_temp.c('rs1'));
select pg_temp.chk('B12 revision +1, the rows are kept as "reset" with the reset id (never deleted)', (pg_temp.j('rs1') -> 'board' ->> 'rev')::int = pg_temp.c('rev_e8')::int + 1
  and pg_temp.q(format($f$select count(*) from public.rw_selections where reset_id = %L and status = 'reset'$f$, pg_temp.c('rs1id'))) = '3');
select pg_temp.chk('B12 only that board: A''s number 4 on board B is untouched', pg_temp.sel_status(pg_temp.j('s4') -> 'selection' ->> 'id') = 'confirmed');
select pg_temp.chk('B12 picks returned: A 2 of 3 available (the board B number is still used), B 2 of 2, C 1 of 1', pg_temp.n_ent('A', 'E8', 'available') = 2 and pg_temp.n_ent('A', 'E8', 'used') = 1 and pg_temp.n_ent('B', 'E8', 'available') = 2 and pg_temp.n_ent('C', 'E8', 'available') = 1);
select pg_temp.chk('B12 it is in the audit log', exists (select 1 from jsonb_array_elements(pg_temp.j('rs1') -> 'log') l where l ->> 'action' = 'reset' and l ->> 'reason' = 'new round' and (l -> 'detail' ->> 'affected')::int = 3 and l ->> 'actor_name' = pg_temp.c('nameS')));
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B12 the customer sees the numbers free and can pick again with the returned right', pg_temp.cell(pg_temp.board_of(pg_temp.st('E8'), 1), 1) ->> 's' = 'free' and pg_temp.st('E8') -> 'rights' = '{"earned":3,"used":1,"remaining":2}'::jsonb);
select pg_temp.put('s1b', pg_temp.claim('E8', 'E8A', 1, 'key-A-s0001b')::text);
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.err_like('B12 undo while number 1 has been taken since: RESET_CONFLICT', format($q$select public.rw_board_undo_reset(%L, 'changed my mind')$q$, pg_temp.c('rs1id')), '%RESET_CONFLICT%');
select pg_temp.chk('B12 ... and it changed nothing (all three rows still "reset", not undone)', pg_temp.q(format($f$select count(*) from public.rw_selections where reset_id = %L and status = 'reset'$f$, pg_temp.c('rs1id'))) = '3'
  and pg_temp.q(format($f$select undone_at is null from public.rw_board_resets where id = %L$f$, pg_temp.c('rs1id'))) = 'true');
select public.rw_release_selection((pg_temp.j('s1b') -> 'selection' ->> 'id')::uuid, 'moving it back');
select pg_temp.put('rev_pre_un', pg_temp.rev('E8', 'E8A')::text);
select pg_temp.put('un1', public.rw_board_undo_reset(pg_temp.c('rs1id')::uuid, 'changed my mind')::text);
select pg_temp.chk('B12 undo restores the three numbers, marks the reset undone, +1 revision', (pg_temp.j('un1') -> 'board' ->> 'taken')::int = 3 and pg_temp.j('un1') -> 'resets' -> 0 ->> 'undone_at' is not null and pg_temp.j('un1') -> 'board' -> 'last_reset_id' = 'null'::jsonb
  and (pg_temp.j('un1') -> 'board' ->> 'rev')::int = pg_temp.c('rev_pre_un')::int + 1 and jsonb_array_length(pg_temp.j('un1') -> 'numbers') = 3);
select pg_temp.chk('B12 the same rows are back to "confirmed" and their rights are used again, pointing at them', pg_temp.sel_status(pg_temp.j('s1') -> 'selection' ->> 'id') = 'confirmed' and pg_temp.sel_status(pg_temp.j('s2') -> 'selection' ->> 'id') = 'confirmed'
  and pg_temp.sel_status(pg_temp.j('s3') -> 'selection' ->> 'id') = 'confirmed' and pg_temp.n_ent('A', 'E8', 'used') = 2 and pg_temp.n_ent('B', 'E8', 'used') = 1 and pg_temp.n_ent('C', 'E8', 'used') = 1
  and pg_temp.q(format($f$select count(*) from public.rw_entitlements where used_selection_id = %L$f$, pg_temp.j('s1') -> 'selection' ->> 'id')) = '1');
select pg_temp.err_like('B12 a reset cannot be undone twice', format($q$select public.rw_board_undo_reset(%L, 'again')$q$, pg_temp.c('rs1id')), '%RESET_CONFLICT%');
select pg_temp.err_like('B12 an unknown reset: NOT_FOUND', format($q$select public.rw_board_undo_reset(%L, 'x')$q$, gen_random_uuid()), '%NOT_FOUND%');
select pg_temp.err_like('B12 undo needs a reason', format($q$select public.rw_board_undo_reset(%L, '')$q$, pg_temp.c('rs1id')), '%REASON_REQUIRED%');
-- the returned right is spent somewhere else before the undo: conflict, and still nothing changes
select pg_temp.put('rs2', public.rw_board_reset(pg_temp.c('E8A')::uuid, 'second round', true, 'Board A')::text);
select pg_temp.put('rs2id', pg_temp.j('rs2') -> 'resets' -> 0 ->> 'id');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.claim('E8', 'E8C', 9, 'key-A-s0009');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.err_like('B12 undo when a returned pick has been used elsewhere: RESET_CONFLICT', format($q$select public.rw_board_undo_reset(%L, 'x')$q$, pg_temp.c('rs2id')), '%RESET_CONFLICT%');
select pg_temp.chk('B12 ... all or nothing: B''s and C''s rows were not restored either', pg_temp.q(format($f$select count(*) from public.rw_selections where reset_id = %L and status = 'reset'$f$, pg_temp.c('rs2id'))) = '3');
select pg_temp.chk('B12 ... and the board still lists it as the last reset to undo', public.rw_admin_board(pg_temp.c('E8A')::uuid) -> 'board' ->> 'last_reset_id' = pg_temp.c('rs2id') and jsonb_array_length(public.rw_admin_board(pg_temp.c('E8A')::uuid) -> 'resets') = 2);

-- without returning the picks
reset role; select pg_temp.mk_event('E11', 'Quiet reset'); select pg_temp.picks('A', 'E11', 2);
set local role authenticated; select pg_temp.who('A'); select pg_temp.put('u1', pg_temp.claim('E11', 'E11A', 5, 'key-A-u0005')::text);
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('rs3', public.rw_board_reset(pg_temp.c('E11A')::uuid, 'quiet reset', false, 'Board A')::text);
select pg_temp.chk('B12 reset without returning picks: number cleared, the right stays used', pg_temp.j('rs3') -> 'resets' -> 0 ->> 'returned_picks' = 'false' and (pg_temp.j('rs3') -> 'board' ->> 'taken')::int = 0
  and pg_temp.sel_status(pg_temp.j('u1') -> 'selection' ->> 'id') = 'reset' and pg_temp.n_ent('A', 'E11', 'used') = 1 and pg_temp.n_ent('A', 'E11', 'available') = 1);
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B12 the customer has only the second right left: one more number is possible', pg_temp.claim('E11', 'E11A', 6, 'key-A-u0006') -> 'selection' ->> 'number' = '6');
select pg_temp.err_like('B12 ... and then NO_ENTITLEMENT', pg_temp.cl('E11', 'E11A', 7, 'key-A-u0007'), '%NO_ENTITLEMENT%');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('un3', public.rw_board_undo_reset((pg_temp.j('rs3') -> 'resets' -> 0 ->> 'id')::uuid, 'put it back')::text);
select pg_temp.chk('B12 undo of a no-return reset brings the row back, the right was never touched', pg_temp.sel_status(pg_temp.j('u1') -> 'selection' ->> 'id') = 'confirmed' and (pg_temp.j('un3') -> 'board' ->> 'taken')::int = 2 and pg_temp.n_ent('A', 'E11', 'used') = 2);

-- a hold that lapsed while the board was reset is not brought back
reset role; select pg_temp.mk_event('E12', 'Reset with a hold', '{"hold":10}'); select pg_temp.picks('A', 'E12', 2);
set local role authenticated; select pg_temp.who('A'); select pg_temp.put('x1', pg_temp.claim('E12', 'E12A', 1, 'key-A-x0001')::text);
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.put('rs4', public.rw_board_reset(pg_temp.c('E12A')::uuid, 'quiet', true, 'Board A')::text);
reset role; update public.rw_selections set expires_at = now() - interval '1 minute' where id = (pg_temp.j('x1') -> 'selection' ->> 'id')::uuid;
set local role authenticated; select pg_temp.who('S');
select pg_temp.put('un4', public.rw_board_undo_reset((pg_temp.j('rs4') -> 'resets' -> 0 ->> 'id')::uuid, 'oops')::text);
select pg_temp.chk('B12 undo of a reset whose hold has lapsed: the hold becomes "expired", the number stays free, the pick stays returned', pg_temp.sel_status(pg_temp.j('x1') -> 'selection' ->> 'id') = 'expired'
  and (pg_temp.j('un4') -> 'board' ->> 'taken')::int = 0 and pg_temp.n_ent('A', 'E12', 'available') = 2 and pg_temp.j('un4') -> 'resets' -> 0 ->> 'undone_at' is not null);

-- a right whose bill was taken back is revoked, not returned, by a reset (and put back as flagged by its undo)
reset role; select pg_temp.mk_event('E13', 'Reset with a flagged right'); select pg_temp.picks('A', 'E13', 1);
set local role authenticated; select pg_temp.who('A'); select pg_temp.put('f1', pg_temp.claim('E13', 'E13A', 1, 'key-A-f0001')::text);
reset role; update public.rw_entitlements set needs_review = true where used_selection_id = (pg_temp.j('f1') -> 'selection' ->> 'id')::uuid;
set local role authenticated; select pg_temp.who('S');
select pg_temp.put('rs5', public.rw_board_reset(pg_temp.c('E13A')::uuid, 'bill reversed', true, 'Board A')::text);
select pg_temp.chk('B12 reset with returned picks revokes a flagged right instead of returning it', pg_temp.n_ent('A', 'E13', 'revoked') = 1 and pg_temp.n_ent('A', 'E13', 'available') = 0
  and pg_temp.q(format($f$select pick_returned from public.rw_selections where id = %L$f$, pg_temp.j('f1') -> 'selection' ->> 'id')) = 'revoked');
select public.rw_board_undo_reset((pg_temp.j('rs5') -> 'resets' -> 0 ->> 'id')::uuid, 'undo');
select pg_temp.chk('B12 its undo puts the number back and the right as it was: used and flagged', pg_temp.sel_status(pg_temp.j('f1') -> 'selection' ->> 'id') = 'confirmed' and pg_temp.n_ent('A', 'E13', 'used') = 1
  and pg_temp.q($f$select needs_review from public.rw_entitlements where event_id = (select id from public.rw_events where name = 'Reset with a flagged right')$f$) = 'true');
select pg_temp.chk('B12 resetting an empty board is allowed and records "affected 0"', (public.rw_board_reset(pg_temp.c('E13B')::uuid, 'nothing here', true, 'Board B') -> 'resets' -> 0 ->> 'affected') = '0');

-- =========================================================================================== B16 selections and resets are never deleted or edited in place
reset role;
select pg_temp.err_like('B16 a selection cannot be deleted', format($q$delete from public.rw_selections where id = %L$q$, pg_temp.j('s1') -> 'selection' ->> 'id'), '%never deleted%');
select pg_temp.err_like('B16 a selection''s number cannot be edited', format($q$update public.rw_selections set number = 99 where id = %L$q$, pg_temp.j('s1') -> 'selection' ->> 'id'), '%cannot be changed%');
select pg_temp.err_like('B16 nor its owner', format($q$update public.rw_selections set profile_id = %L where id = %L$q$, pg_temp.c('D'), pg_temp.j('s1') -> 'selection' ->> 'id'), '%cannot be changed%');
select pg_temp.err_like('B16 nor its board', format($q$update public.rw_selections set board_id = %L where id = %L$q$, pg_temp.c('E8B'), pg_temp.j('s1') -> 'selection' ->> 'id'), '%cannot be changed%');
select pg_temp.err_like('B16 nor the right behind it', format($q$update public.rw_selections set entitlement_id = %L where id = %L$q$, pg_temp.ent('A', 'E8', 2), pg_temp.j('s1') -> 'selection' ->> 'id'), '%cannot be changed%');
select pg_temp.err_like('B16 nor the exclusive flag it was claimed with', format($q$update public.rw_selections set exclusive = false where id = %L$q$, pg_temp.j('s1') -> 'selection' ->> 'id'), '%cannot be changed%');
select pg_temp.err_like('B16 nor the idempotency key', format($q$update public.rw_selections set claim_key = 'another-key-1' where id = %L$q$, pg_temp.j('s1') -> 'selection' ->> 'id'), '%cannot be changed%');
select pg_temp.err_like('B16 a released number cannot be brought back by editing the status', format($q$update public.rw_selections set status = 'confirmed' where id = %L$q$, pg_temp.j('m1') -> 'selection' ->> 'id'), '%cannot go from%');
select pg_temp.err_like('B16 a confirmed number cannot silently become "expired"', format($q$update public.rw_selections set status = 'expired' where id = %L$q$, pg_temp.c('selA7')), '%cannot go from%');
select pg_temp.err_like('B16 a reset record cannot be deleted', format($q$delete from public.rw_board_resets where id = %L$q$, pg_temp.c('rs1id')), '%never deleted%');
select pg_temp.err_like('B16 nor have its reason rewritten', format($q$update public.rw_board_resets set reason = 'something else' where id = %L$q$, pg_temp.c('rs2id')), '%cannot be edited%');
select pg_temp.err_like('B16 nor its count', format($q$update public.rw_board_resets set affected = 0 where id = %L$q$, pg_temp.c('rs2id')), '%cannot be edited%');
select pg_temp.err_like('B16 an undone reset stays undone', format($q$update public.rw_board_resets set undone_at = null where id = %L$q$, pg_temp.c('rs1id')), '%already undone%');
select pg_temp.err_like('B16 the selections table cannot be truncated (refused by the guard or by the foreign key from the rights)', 'truncate public.rw_selections', '%');
select pg_temp.err_like('B16 nor the resets table (refused either by the guard or by the foreign key from selections)', 'truncate public.rw_board_resets', '%');
select pg_temp.chk('B16 and every selection is still there after all that', pg_temp.q($f$select count(*) from public.rw_selections$f$)::int > 30);
select pg_temp.err_like('B16 a board cannot be deleted', format($q$delete from public.rw_boards where id = %L$q$, pg_temp.c('E8A')), '%never deleted%');
select pg_temp.err_like('B16 nor moved to another slot', format($q$update public.rw_boards set slot = 3 where id = %L$q$, pg_temp.c('E8A')), '%cannot be changed%');
select pg_temp.err_like('B16 an event cannot be deleted', format($q$delete from public.rw_events where id = %L$q$, pg_temp.c('E8')), '%never deleted%');
set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B16 and a member cannot touch any of it directly', format($q$update public.rw_selections set status = 'released' where id = %L$q$, pg_temp.j('s1') -> 'selection' ->> 'id'), '%permission denied%');
select pg_temp.err_like('B16 not even their own row', format($q$delete from public.rw_selections where id = %L$q$, pg_temp.j('s1') -> 'selection' ->> 'id'), '%permission denied%');

-- =========================================================================================== B17 what staff see
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.put('ab', public.rw_admin_board(pg_temp.c('E1A')::uuid)::text);
select pg_temp.chk('B17 staff see who holds each number: name and the last 4 digits of the phone, status, exclusive, when', pg_temp.j('ab') -> 'numbers' -> 0 ->> 'n' = '7'
  and pg_temp.j('ab') -> 'numbers' -> 0 -> 'holders' -> 0 ->> 'name' = pg_temp.c('nameA') and pg_temp.j('ab') -> 'numbers' -> 0 -> 'holders' -> 0 ->> 'phone_tail' = right(pg_temp.c('phoneA'), 4)
  and pg_temp.j('ab') -> 'numbers' -> 0 -> 'holders' -> 0 ->> 'profile_id' = pg_temp.c('A') and pg_temp.j('ab') -> 'numbers' -> 0 -> 'holders' -> 0 ->> 'status' = 'confirmed'
  and (pg_temp.j('ab') -> 'numbers' -> 0 -> 'holders' -> 0 ->> 'exclusive')::boolean and pg_temp.keys(pg_temp.j('ab') -> 'numbers' -> 0 -> 'holders' -> 0) = 'at,exclusive,name,phone_tail,profile_id,selection_id,status'
  and jsonb_array_length(pg_temp.j('ab') -> 'numbers') = 3 and pg_temp.keys(pg_temp.j('ab')) = 'board,log,numbers,resets' and pg_temp.j('ab') -> 'resets' = '[]'::jsonb);
select pg_temp.chk('B17 a customer''s claim is in the board log with the customer''s name (and no reason)', exists (select 1 from jsonb_array_elements(pg_temp.j('ab') -> 'log') l
  where l ->> 'action' = 'claim' and l ->> 'actor_name' = pg_temp.c('nameA') and l -> 'detail' ->> 'number' = '7' and l -> 'reason' = 'null'::jsonb) and pg_temp.keys(pg_temp.j('ab') -> 'log' -> 0) = 'action,actor_name,at,detail,reason');
select pg_temp.chk('B17 the event log lists the same rows; the system expiry has no actor name', exists (select 1 from jsonb_array_elements(public.rw_admin_log(pg_temp.c('E2')::uuid)) l where l ->> 'action' = 'expire' and l -> 'actor_name' = 'null'::jsonb and l -> 'detail' ->> 'number' = '6')
  and exists (select 1 from jsonb_array_elements(public.rw_admin_log(pg_temp.c('E2')::uuid)) l where l ->> 'action' = 'confirm' and l ->> 'actor_name' = pg_temp.c('nameA'))
  and exists (select 1 from jsonb_array_elements(public.rw_admin_log(pg_temp.c('E6')::uuid)) l where l ->> 'action' = 'set_mode' and l ->> 'actor_name' = pg_temp.c('nameS') and l ->> 'reason' = 'trial of shared numbers'));
select pg_temp.chk('B17 the log pages: limit and offset', jsonb_array_length(public.rw_admin_log(pg_temp.c('E2')::uuid, 2, 0)) = 2 and public.rw_admin_log(pg_temp.c('E2')::uuid, 2, 0) -> 1 = public.rw_admin_log(pg_temp.c('E2')::uuid, 1, 1) -> 0
  and jsonb_array_length(public.rw_admin_log(pg_temp.c('E2')::uuid, 0, 0)) = 1 and jsonb_array_length(public.rw_admin_log(pg_temp.c('E2')::uuid, 5000)) <= 200
  and public.rw_admin_log(pg_temp.c('E2')::uuid, 100, 10000) = '[]'::jsonb);
select pg_temp.chk('B17 the log never mixes in another event', not exists (select 1 from jsonb_array_elements(public.rw_admin_log(pg_temp.c('E2')::uuid, 200)) l where l -> 'detail' ->> 'event_id' <> pg_temp.c('E2')));
select pg_temp.err_like('B17 an unknown board', format($q$select public.rw_admin_board(%L)$q$, gen_random_uuid()), '%NOT_FOUND%');
select pg_temp.err_like('B17 an unknown event log', format($q$select public.rw_admin_log(%L)$q$, gen_random_uuid()), '%NOT_FOUND%');
select pg_temp.chk('B17 the events list has every event with its three boards (taken / total / rev)', (select count(*) from jsonb_array_elements(public.rw_admin_events()) e where jsonb_array_length(e -> 'boards') = 3) = (select count(*) from jsonb_array_elements(public.rw_admin_events()) e)
  and (select (b ->> 'total')::int from jsonb_array_elements(public.rw_admin_events()) e, jsonb_array_elements(e -> 'boards') b where e ->> 'id' = pg_temp.c('E7') and b ->> 'slot' = '1') = 3
  and (select (b ->> 'taken')::int from jsonb_array_elements(public.rw_admin_events()) e, jsonb_array_elements(e -> 'boards') b where e ->> 'id' = pg_temp.c('E7') and b ->> 'slot' = '1') = 2);

-- =========================================================================================== B18 events and boards as staff manage them
create or replace function pg_temp.se(p_id text, p_patch text) returns text language sql as $$ select format('select public.rw_admin_save_event(%L, %L)', nullif(pg_temp.c(p_id), ''), p_patch) $$;
create or replace function pg_temp.sb(p_bd text, p_patch text) returns text language sql as $$ select format('select public.rw_admin_save_board(%L, %L)', pg_temp.c(p_bd), p_patch) $$;
create or replace function pg_temp.revs(p_ev text) returns text language sql as $$
  select pg_temp.q(format($f$select string_agg(b ->> 'rev', ',' order by (b ->> 'slot')::int) from jsonb_array_elements(public.rw_event_json(%L) -> 'boards') b$f$, pg_temp.c(p_ev))) $$;
select pg_temp.put('none', null);
select pg_temp.put('ne', public.rw_admin_save_event(null, '{"name":"  Summer boards ","description":"first","hold_minutes":5}')::text);
select pg_temp.put('neid', pg_temp.j('ne') ->> 'id'); select pg_temp.put('ne', pg_temp.c('neid'));
reset role; select pg_temp.put('neA', (select id::text from public.rw_boards where event_id = pg_temp.c('neid')::uuid and slot = 1)); select pg_temp.put('neB', (select id::text from public.rw_boards where event_id = pg_temp.c('neid')::uuid and slot = 2));
select pg_temp.put('neC', (select id::text from public.rw_boards where event_id = pg_temp.c('neid')::uuid and slot = 3));
set local role authenticated; select pg_temp.who('M');
select pg_temp.put('nej', public.rw_admin_events()::text);
select pg_temp.chk('B18 an Admin creates an event: trimmed name, draft, range 0-99, hold as given, three boards A/B/C at revision 0', (select e ->> 'name' = 'Summer boards' and e ->> 'description' = 'first' and e ->> 'status' = 'draft' and (e ->> 'number_min')::int = 0 and (e ->> 'number_max')::int = 99
    and (e ->> 'hold_minutes')::int = 5 and e -> 'max_per_customer' = 'null'::jsonb and e -> 'starts_at' = 'null'::jsonb and e -> 'ends_at' = 'null'::jsonb
    and (select string_agg((b ->> 'name') || (b ->> 'mode') || (b ->> 'state') || (b ->> 'rev') || (b ->> 'total') || (b ->> 'taken'), ',' order by (b ->> 'slot')::int) from jsonb_array_elements(e -> 'boards') b) = 'Board Aexclusiveopen01000,Board Bexclusiveopen01000,Board Cexclusiveopen01000'
    and pg_temp.keys(e) = 'boards,description,ends_at,hold_minutes,id,max_per_customer,name,number_max,number_min,starts_at,status'
    and pg_temp.keys(e -> 'boards' -> 0) = 'color,event_id,id,last_reset_id,mode,name,rev,slot,state,taken,total'
  from jsonb_array_elements(pg_temp.j('nej')) e where e ->> 'id' = pg_temp.c('neid')));
select pg_temp.err_like('B18 an event needs a name', pg_temp.se('none', '{}'), '%BAD_RULE%');
select pg_temp.err_like('B18 not an empty one', pg_temp.se('none', '{"name":"  "}'), '%BAD_RULE%');
select pg_temp.err_like('B18 nor a null one', pg_temp.se('none', '{"name":null}'), '%BAD_RULE%');
select pg_temp.err_like('B18 nor one over 100 characters', pg_temp.se('none', '{"name":"' || repeat('x', 101) || '"}'), '%BAD_RULE%');
select pg_temp.err_like('B18 the range must not be upside down', pg_temp.se('none', '{"name":"x","number_min":50,"number_max":10}'), '%BAD_RULE%');
select pg_temp.err_like('B18 nor more than 1000 numbers', pg_temp.se('none', '{"name":"x","number_max":2000}'), '%BAD_RULE%');
select pg_temp.err_like('B18 nor negative', pg_temp.se('none', '{"name":"x","number_min":-1}'), '%BAD_RULE%');
select pg_temp.err_like('B18 nor a null range', pg_temp.se('none', '{"name":"x","number_min":null}'), '%BAD_RULE%');
select pg_temp.err_like('B18 a negative hold', pg_temp.se('none', '{"name":"x","hold_minutes":-1}'), '%BAD_RULE%');
select pg_temp.err_like('B18 a hold over a day', pg_temp.se('none', '{"name":"x","hold_minutes":1441}'), '%BAD_RULE%');
select pg_temp.err_like('B18 a fractional hold', pg_temp.se('none', '{"name":"x","hold_minutes":1.5}'), '%BAD_RULE%');
select pg_temp.err_like('B18 a limit of 0 per customer', pg_temp.se('none', '{"name":"x","max_per_customer":0}'), '%BAD_RULE%');
select pg_temp.err_like('B18 an end before the start', pg_temp.se('none', '{"name":"x","starts_at":"2026-12-02T00:00:00Z","ends_at":"2026-12-01T00:00:00Z"}'), '%BAD_RULE%');
select pg_temp.err_like('B18 a date that is not a date', pg_temp.se('none', '{"name":"x","starts_at":"soon"}'), '%BAD_RULE%');
select pg_temp.err_like('B18 an unknown field is refused (BAD_RULE: unknown event field)', pg_temp.se('none', '{"name":"x","colour":"red"}'), '%BAD_RULE: unknown event field colour%');
select pg_temp.err_like('B18 details that are not an object', pg_temp.se('none', '[1]'), '%BAD_RULE%');
select pg_temp.err_like('B18 a new event cannot be created already active (status has its own call)', pg_temp.se('none', '{"name":"x","status":"active"}'), '%BAD_RULE%');
select pg_temp.chk('B18 ... and none of the refused ones created anything', (select count(*) from jsonb_array_elements(public.rw_admin_events()) e where e ->> 'name' in ('x', '')) = 0);
-- partial patches: only the keys that are sent change
select pg_temp.put('r_ne0', pg_temp.revs('ne'));
select pg_temp.put('ne1', public.rw_admin_save_event(pg_temp.c('neid')::uuid, '{"name":"Summer boards 2026"}')::text);
select pg_temp.chk('B18 sending only {name} changes only the name: description, range, hold, window, limit stay', pg_temp.j('ne1') ->> 'name' = 'Summer boards 2026' and pg_temp.j('ne1') ->> 'description' = 'first' and pg_temp.j('ne1') ->> 'number_min' = '0' and pg_temp.j('ne1') ->> 'number_max' = '99'
  and pg_temp.j('ne1') ->> 'hold_minutes' = '5' and pg_temp.j('ne1') -> 'starts_at' = 'null'::jsonb and pg_temp.j('ne1') -> 'ends_at' = 'null'::jsonb and pg_temp.j('ne1') -> 'max_per_customer' = 'null'::jsonb and pg_temp.j('ne1') ->> 'status' = 'draft');
select pg_temp.chk('B18 editing an event bumps the revision of ALL its boards (so customers and other admins notice)', pg_temp.revs('ne') = '1,1,1' and pg_temp.c('r_ne0') = '0,0,0');
select pg_temp.chk('B18 the change is audited with old and new values', exists (select 1 from jsonb_array_elements(public.rw_admin_log(pg_temp.c('neid')::uuid)) l where l ->> 'action' = 'save_event' and l -> 'detail' -> 'changes' -> 'name' = '{"old":"Summer boards","new":"Summer boards 2026"}'::jsonb
  and (select count(*) from jsonb_object_keys(l -> 'detail' -> 'changes')) = 1));
select pg_temp.put('ne1b', public.rw_admin_save_event(pg_temp.c('neid')::uuid, '{"name":"Summer boards 2026","hold_minutes":5}')::text);
select pg_temp.chk('B18 saving the same values again changes nothing (no revision, no audit row)', pg_temp.j('ne1b') ->> 'name' = 'Summer boards 2026' and pg_temp.revs('ne') = '1,1,1'
  and (select count(*) from jsonb_array_elements(public.rw_admin_log(pg_temp.c('neid')::uuid)) l where l ->> 'action' = 'save_event') = 1);
select pg_temp.put('ne2', public.rw_admin_save_event(pg_temp.c('neid')::uuid, '{"max_per_customer":3,"starts_at":"2031-01-01T00:00:00Z","ends_at":"2031-02-01T00:00:00Z"}')::text);
select pg_temp.chk('B18 limit and window can be set ...', pg_temp.j('ne2') ->> 'max_per_customer' = '3' and (pg_temp.j('ne2') ->> 'starts_at')::timestamptz = '2031-01-01T00:00:00Z' and (pg_temp.j('ne2') ->> 'ends_at')::timestamptz = '2031-02-01T00:00:00Z' and pg_temp.j('ne2') ->> 'name' = 'Summer boards 2026');
select pg_temp.put('ne3', public.rw_admin_save_event(pg_temp.c('neid')::uuid, '{"max_per_customer":null,"starts_at":null,"ends_at":null,"description":null}')::text);
select pg_temp.chk('B18 ... and cleared with null (the nullable ones only); everything else stays', pg_temp.j('ne3') -> 'max_per_customer' = 'null'::jsonb and pg_temp.j('ne3') -> 'starts_at' = 'null'::jsonb and pg_temp.j('ne3') -> 'ends_at' = 'null'::jsonb and pg_temp.j('ne3') -> 'description' = 'null'::jsonb
  and pg_temp.j('ne3') ->> 'name' = 'Summer boards 2026' and pg_temp.j('ne3') ->> 'hold_minutes' = '5');
select pg_temp.put('ne4', public.rw_admin_save_event(pg_temp.c('neid')::uuid, '{"number_max":120}')::text);
select pg_temp.chk('B18 before any pick an Admin may change the range: 0-120, 121 numbers per board', pg_temp.j('ne4') ->> 'number_max' = '120' and (pg_temp.j('ne4') -> 'boards' -> 0 ->> 'total') = '121' and pg_temp.j('ne4') ->> 'hold_minutes' = '5');
select pg_temp.err_like('B18 an event that does not exist: NOT_FOUND', format($q$select public.rw_admin_save_event(%L, '{"name":"x"}')$q$, gen_random_uuid()), '%NOT_FOUND%');
-- the status: staff, except closing / reopening which is the Super Admin's
select pg_temp.put('r_st0', pg_temp.revs('ne'));
select pg_temp.put('st1', public.rw_admin_set_event_status(pg_temp.c('neid')::uuid, 'active', 'go live')::text);
select pg_temp.chk('B18 an Admin activates an event with a reason: all boards bump', pg_temp.j('st1') ->> 'status' = 'active' and pg_temp.revs('ne') = (select string_agg((x::int + 1)::text, ',') from unnest(string_to_array(pg_temp.c('r_st0'), ',')) x));
select pg_temp.put('st2', public.rw_admin_set_event_status(pg_temp.c('neid')::uuid, 'active', 'again')::text);
select pg_temp.chk('B18 the same status again changes nothing', pg_temp.j('st2') ->> 'status' = 'active' and pg_temp.revs('ne') = (select string_agg((x::int + 1)::text, ',') from unnest(string_to_array(pg_temp.c('r_st0'), ',')) x));
select pg_temp.err_like('B18 a status change needs a reason', format($q$select public.rw_admin_set_event_status(%L, 'paused', ' ')$q$, pg_temp.c('neid')), '%REASON_REQUIRED%');
select pg_temp.err_like('B18 an unknown status', format($q$select public.rw_admin_set_event_status(%L, 'finished', 'x')$q$, pg_temp.c('neid')), '%BAD_RULE%');
select pg_temp.err_like('B18 an Admin cannot close an event', format($q$select public.rw_admin_set_event_status(%L, 'closed', 'done')$q$, pg_temp.c('neid')), '%not allowed%', '42501');
select pg_temp.chk('B18 an Admin can pause one', public.rw_admin_set_event_status(pg_temp.c('neid')::uuid, 'paused', 'lunch break') ->> 'status' = 'paused');
select pg_temp.err_like('B18 an event that does not exist', format($q$select public.rw_admin_set_event_status(%L, 'paused', 'x')$q$, gen_random_uuid()), '%NOT_FOUND%');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B18 a Super Admin closes it', public.rw_admin_set_event_status(pg_temp.c('neid')::uuid, 'closed', 'event is over') ->> 'status' = 'closed');
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.err_like('B18 an Admin cannot reopen a closed event', format($q$select public.rw_admin_set_event_status(%L, 'active', 'oops')$q$, pg_temp.c('neid')), '%not allowed%', '42501');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B18 a Super Admin can', public.rw_admin_set_event_status(pg_temp.c('neid')::uuid, 'active', 'reopened by mistake') ->> 'status' = 'active');
select pg_temp.chk('B18 every status change is in the audit log with from, to and reason', (select string_agg((l -> 'detail' ->> 'from') || '>' || (l -> 'detail' ->> 'to') || ':' || (l ->> 'reason'), ' | ' order by ord desc) from jsonb_array_elements(public.rw_admin_log(pg_temp.c('neid')::uuid, 50)) with ordinality t(l, ord) where l ->> 'action' = 'set_event_status')
  = 'draft>active:go live | active>paused:lunch break | paused>closed:event is over | closed>active:reopened by mistake');
-- boards: name and colour only, only the keys that are sent
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.put('rb0', pg_temp.revs('ne'));
select pg_temp.put('sb1', public.rw_admin_save_board(pg_temp.c('neA')::uuid, '{"name":"Red board"}')::text);
select pg_temp.chk('B18 renaming a board only renames it: colour, mode and state stay; its revision +1, the other boards unchanged', pg_temp.j('sb1') ->> 'name' = 'Red board' and pg_temp.j('sb1') ->> 'color' = '#2563eb' and pg_temp.j('sb1') ->> 'mode' = 'exclusive' and pg_temp.j('sb1') ->> 'state' = 'open'
  and (pg_temp.j('sb1') ->> 'rev')::int = (string_to_array(pg_temp.c('rb0'), ','))[1]::int + 1 and (string_to_array(pg_temp.revs('ne'), ','))[2] = (string_to_array(pg_temp.c('rb0'), ','))[2] and (string_to_array(pg_temp.revs('ne'), ','))[3] = (string_to_array(pg_temp.c('rb0'), ','))[3]
  and pg_temp.keys(pg_temp.j('sb1')) = 'color,event_id,id,last_reset_id,mode,name,rev,slot,state,taken,total');
select pg_temp.put('sb2', public.rw_admin_save_board(pg_temp.c('neA')::uuid, '{"color":"#FF8800"}')::text);
select pg_temp.chk('B18 sending only {color} changes only the colour (stored lower case)', pg_temp.j('sb2') ->> 'color' = '#ff8800' and pg_temp.j('sb2') ->> 'name' = 'Red board' and (pg_temp.j('sb2') ->> 'rev')::int = (pg_temp.j('sb1') ->> 'rev')::int + 1);
select pg_temp.chk('B18 a board edit is audited with old and new', exists (select 1 from jsonb_array_elements(public.rw_admin_board(pg_temp.c('neA')::uuid) -> 'log') l where l ->> 'action' = 'save_board' and l -> 'detail' -> 'changes' -> 'name' = '{"old":"Board A","new":"Red board"}'::jsonb));
select pg_temp.chk('B18 saving the same board values changes nothing', (public.rw_admin_save_board(pg_temp.c('neA')::uuid, '{"name":"Red board","color":"#ff8800"}') ->> 'rev')::int = (pg_temp.j('sb2') ->> 'rev')::int);
select pg_temp.err_like('B18 a board colour must look like a colour', pg_temp.sb('neA', '{"color":"red"}'), '%BAD_RULE%');
select pg_temp.err_like('B18 a board cannot be given an empty name', pg_temp.sb('neA', '{"name":""}'), '%BAD_RULE%');
select pg_temp.err_like('B18 the mode is not edited here (it has its own Super Admin operation)', pg_temp.sb('neA', '{"mode":"shared"}'), '%BAD_RULE%');
select pg_temp.err_like('B18 nor the lock state', pg_temp.sb('neA', '{"state":"locked"}'), '%BAD_RULE%');
select pg_temp.err_like('B18 a board that does not exist', format($q$select public.rw_admin_save_board(%L, '{"name":"x"}')$q$, gen_random_uuid()), '%NOT_FOUND%');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B18 customers see the rename and the new revisions at once', pg_temp.board_of(pg_temp.st('ne'), 1) ->> 'name' = 'Red board' and pg_temp.board_of(pg_temp.st('ne'), 1) ->> 'color' = '#ff8800'
  and pg_temp.rev('ne', 'neA') = (pg_temp.j('sb2') ->> 'rev')::int);

-- the number range once there are picks (Admin: not any more; Super Admin: expand yes, shrink below a held number no)
reset role; select pg_temp.mk_event('E9', 'Range with picks'); select pg_temp.picks('A', 'E9', 2);
set local role authenticated; select pg_temp.who('A'); select pg_temp.put('e9s', pg_temp.claim('E9', 'E9A', 50, 'key-A-q0050')::text);
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.err_like('B18 an Admin cannot change the range once the event has a pick (expanding)', pg_temp.se('E9', '{"number_max":120}'), '%not allowed%', '42501');
select pg_temp.err_like('B18 nor raise the start', pg_temp.se('E9', '{"number_min":1}'), '%not allowed%', '42501');
select pg_temp.chk('B18 but an Admin can still edit everything else (name, hold, limit)', public.rw_admin_save_event(pg_temp.c('E9')::uuid, '{"name":"Range with picks 2","hold_minutes":3,"max_per_customer":4}') ->> 'name' = 'Range with picks 2');
select pg_temp.chk('B18 and sending the range it already has is not a change', public.rw_admin_save_event(pg_temp.c('E9')::uuid, '{"number_min":0,"number_max":99}') ->> 'hold_minutes' = '3');
reset role; set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B18 a Super Admin may expand it: 0-120, nothing taken away', public.rw_admin_save_event(pg_temp.c('E9')::uuid, '{"number_max":120}') -> 'boards' -> 0 ->> 'total' = '121');
select pg_temp.err_like('B18 shrinking below a held number: NUMBER_OUT_OF_RANGE with the number', pg_temp.se('E9', '{"number_max":40}'), '%NUMBER_OUT_OF_RANGE: number 50 is held%');
select pg_temp.err_like('B18 raising the start above it too', pg_temp.se('E9', '{"number_min":51}'), '%NUMBER_OUT_OF_RANGE: number 50 is held%');
select pg_temp.chk('B18 ... nothing changed', pg_temp.q(format($f$select number_min || '-' || number_max from public.rw_events where id = %L$f$, pg_temp.c('E9'))) = '0-120');
select pg_temp.chk('B18 shrinking to a range that still holds it is fine', public.rw_admin_save_event(pg_temp.c('E9')::uuid, '{"number_max":60}') -> 'boards' -> 0 ->> 'total' = '61');
reset role; update public.rw_events set number_max = 40 where id = pg_temp.c('E9')::uuid;                    -- a legacy inconsistency, to prove that an untouched range is never re-validated
set local role authenticated; select pg_temp.who('M');
select pg_temp.chk('B18 a patch without the range never validates the range against held numbers', public.rw_admin_save_event(pg_temp.c('E9')::uuid, '{"name":"Range with picks 3"}') ->> 'name' = 'Range with picks 3');
reset role; update public.rw_events set number_max = 60 where id = pg_temp.c('E9')::uuid;
set local role authenticated; select pg_temp.who('S');
select public.rw_release_selection((pg_temp.j('e9s') -> 'selection' ->> 'id')::uuid, 'free it');
select pg_temp.chk('B18 once the number is released the range can shrink below it', public.rw_admin_save_event(pg_temp.c('E9')::uuid, '{"number_max":40}') -> 'boards' -> 0 ->> 'total' = '41');
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.err_like('B18 ... but an Admin still cannot, the event has had picks', pg_temp.se('E9', '{"number_max":99}'), '%not allowed%', '42501');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B18 customers see exactly the new range', jsonb_array_length(pg_temp.board_of(pg_temp.st('E9'), 1) -> 'numbers') = 41 and pg_temp.st('E9') -> 'event' ->> 'number_max' = '40');

-- =========================================================================================== B21 confirming a hold (the customer app confirms right after every claim that came back "reserved")
reset role; select pg_temp.mk_event('E14', 'Hold semantics', '{"hold":10}'); select pg_temp.picks('A', 'E14', 2); select pg_temp.picks('B', 'E14', 1);
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('q1', pg_temp.claim('E14', 'E14B', 3, 'key-A-q0003')::text);
select pg_temp.put('q1c', public.rw_confirm_selection((pg_temp.j('q1') -> 'selection' ->> 'id')::uuid)::text);
select pg_temp.chk('B21 the owner confirms a valid hold: confirmed, no deadline, the claim shape minus "replay" (selection, board, rights)', pg_temp.j('q1c') -> 'selection' ->> 'status' = 'confirmed' and pg_temp.j('q1c') -> 'selection' -> 'expires_at' = 'null'::jsonb
  and pg_temp.keys(pg_temp.j('q1c')) = 'board,rights,selection' and pg_temp.keys(pg_temp.j('q1c') -> 'selection') = 'board_id,expires_at,id,number,status' and pg_temp.cell(pg_temp.j('q1c') -> 'board', 3) = '{"n":3,"s":"mine","c":1}'::jsonb
  and pg_temp.j('q1c') -> 'rights' = '{"earned":2,"used":1,"remaining":1}'::jsonb);
select pg_temp.chk('B21 confirming again returns the same, with no second revision or audit row', public.rw_confirm_selection((pg_temp.j('q1') -> 'selection' ->> 'id')::uuid) = pg_temp.j('q1c')
  and pg_temp.q(format($f$select count(*) from public.rw_events_log where action = 'confirm' and detail ->> 'selection_id' = %L$f$, pg_temp.j('q1') -> 'selection' ->> 'id')) = '1');
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.err_like('B21 nobody else can confirm it: exactly NOT_FOUND (the selection is not revealed)', format($q$select public.rw_confirm_selection(%L)$q$, pg_temp.j('q1') -> 'selection' ->> 'id'), 'NOT_FOUND%');
select pg_temp.err_like('B21 ... the same message as for an id that does not exist', format($q$select public.rw_confirm_selection(%L)$q$, gen_random_uuid()), 'NOT_FOUND%');
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B21 a released number cannot be confirmed: NOT_FOUND', format($q$select public.rw_confirm_selection(%L)$q$, pg_temp.j('m1') -> 'selection' ->> 'id'), 'NOT_FOUND%');
-- B's only right sits behind a hold on board B; the hold lapses
reset role; set local role authenticated; select pg_temp.who('B');
select pg_temp.put('q2', pg_temp.claim('E14', 'E14B', 4, 'key-B-q0004')::text);
reset role; update public.rw_selections set expires_at = now() - interval '1 minute' where id = (pg_temp.j('q2') -> 'selection' ->> 'id')::uuid;
set local role authenticated; select pg_temp.who('B');
select pg_temp.err_like('B21 confirming after the deadline: HOLD_EXPIRED', format($q$select public.rw_confirm_selection(%L)$q$, pg_temp.j('q2') -> 'selection' ->> 'id'), '%HOLD_EXPIRED%');
select pg_temp.chk('B21 the lapsed hold is already released for the customer: the number reads free and the pick reads as returned (1 of 1 left)', pg_temp.cell(pg_temp.board_of(pg_temp.st('E14'), 2), 4) ->> 's' = 'free'
  and pg_temp.st('E14') -> 'rights' = '{"earned":1,"used":0,"remaining":1}'::jsonb);
select pg_temp.put('q3', pg_temp.claim('E14', 'E14A', 5, 'key-B-q0005')::text);
select pg_temp.chk('B21 the next claim sweeps it for real, even when it is on ANOTHER board of the event: the pick is back and was used again', pg_temp.j('q3') -> 'selection' ->> 'number' = '5'
  and pg_temp.sel_status(pg_temp.j('q2') -> 'selection' ->> 'id') = 'expired' and pg_temp.j('q3') -> 'rights' = '{"earned":1,"used":1,"remaining":0}'::jsonb and pg_temp.n_ent('B', 'E14', 'used') = 1);
select pg_temp.err_like('B21 an expired (swept) hold stays HOLD_EXPIRED for its owner', format($q$select public.rw_confirm_selection(%L)$q$, pg_temp.j('q2') -> 'selection' ->> 'id'), '%HOLD_EXPIRED%');
select pg_temp.chk('B21 the expiry is audited with the owner in the row and no actor', pg_temp.q(format($f$select count(*) from public.rw_events_log where action = 'expire' and actor is null and profile_id = %L and event_id = %L and board_id = %L$f$, pg_temp.c('B'), pg_temp.c('E14'), pg_temp.c('E14B'))) = '1');

-- =========================================================================================== B22 what the core migration calls back into (real core only): my numbers, the review queue, "release" and "keep"
reset role; select pg_temp.mk_event('E15', 'Review flow'); select pg_temp.picks('A', 'E15', 2);
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('v1', pg_temp.claim('E15', 'E15A', 1, 'key-A-v0001')::text); select pg_temp.put('v2', pg_temp.claim('E15', 'E15A', 2, 'key-A-v0002')::text);
select pg_temp.chk('B22 the audit rows carry the event, board and customer in the core''s own columns', pg_temp.q(format($f$select count(*) from public.rw_events_log where action = 'claim' and entity = 'board' and event_id = %L and board_id = %L and profile_id = %L and actor = %L$f$,
  pg_temp.c('E15'), pg_temp.c('E15A'), pg_temp.c('A'), pg_temp.c('A'))) = '2');
select pg_temp.put('mr', public.rw_my_rewards()::text);
select pg_temp.chk('B22 rw_my_rewards lists my numbers with board name, status and deadline', (select count(*) from jsonb_array_elements(pg_temp.j('mr') -> 'selections') s where s ->> 'event_id' = pg_temp.c('E15')) = 2
  and exists (select 1 from jsonb_array_elements(pg_temp.j('mr') -> 'selections') s where s ->> 'id' = pg_temp.j('v1') -> 'selection' ->> 'id' and s ->> 'number' = '1' and s ->> 'board_name' = 'Board A' and s ->> 'status' = 'confirmed' and s -> 'expires_at' = 'null'::jsonb
    and pg_temp.keys(s) = 'board_id,board_name,event_id,expires_at,id,number,status'));
select pg_temp.chk('B22 ... exactly my active numbers and nobody else''s', jsonb_array_length(pg_temp.j('mr') -> 'selections') = pg_temp.q(format($f$select count(*) from public.rw_selections where profile_id = %L and status in ('confirmed', 'reserved') and (status = 'confirmed' or expires_at > now())$f$, pg_temp.c('A')))::int);
reset role; update public.rw_entitlements set needs_review = true, review_since = now() where used_selection_id = (pg_temp.j('v1') -> 'selection' ->> 'id')::uuid;
select pg_temp.put('ev1', pg_temp.q(format($f$select id from public.rw_entitlements where used_selection_id = %L$f$, pg_temp.j('v1') -> 'selection' ->> 'id')));
set local role authenticated; select pg_temp.who('S');
select pg_temp.chk('B22 the review queue shows which board and number the flagged right sits on', exists (select 1 from jsonb_array_elements(public.rw_admin_review_queue()) i where i ->> 'entitlement_id' = pg_temp.c('ev1') and i ->> 'board_name' = 'Board A' and i ->> 'number' = '1'
  and i ->> 'selection_id' = pg_temp.j('v1') -> 'selection' ->> 'id'));
select pg_temp.put('rev_v', pg_temp.rev('E15', 'E15A')::text);
select public.rw_admin_resolve_review(pg_temp.c('ev1')::uuid, 'release', 'bill was reversed after the pick');
select pg_temp.chk('B22 resolving "release" frees the number, keeps the right revoked (not given back), bumps the revision', pg_temp.sel_status(pg_temp.j('v1') -> 'selection' ->> 'id') = 'released' and pg_temp.n_ent('A', 'E15', 'revoked') = 1
  and pg_temp.rev('E15', 'E15A') = pg_temp.c('rev_v')::int + 1 and pg_temp.q(format($f$select pick_returned from public.rw_selections where id = %L$f$, pg_temp.j('v1') -> 'selection' ->> 'id')) = 'revoked'
  and not exists (select 1 from jsonb_array_elements(public.rw_admin_review_queue()) i where i ->> 'entitlement_id' = pg_temp.c('ev1')));
select pg_temp.chk('B22 ... and it is in the board log as a release with the reason and the Super Admin''s name', exists (select 1 from jsonb_array_elements(public.rw_admin_board(pg_temp.c('E15A')::uuid) -> 'log') l
  where l ->> 'action' = 'release' and l ->> 'reason' = 'bill was reversed after the pick' and l ->> 'actor_name' = pg_temp.c('nameS') and l -> 'detail' ->> 'via' = 'review'));
reset role; update public.rw_entitlements set needs_review = true, review_since = now() where used_selection_id = (pg_temp.j('v2') -> 'selection' ->> 'id')::uuid;
select pg_temp.put('ev2', pg_temp.q(format($f$select id from public.rw_entitlements where used_selection_id = %L$f$, pg_temp.j('v2') -> 'selection' ->> 'id')));
set local role authenticated; select pg_temp.who('S');
select public.rw_admin_resolve_review(pg_temp.c('ev2')::uuid, 'keep', 'the customer paid in cash');
select pg_temp.chk('B22 resolving "keep" leaves the number exactly where it is', pg_temp.sel_status(pg_temp.j('v2') -> 'selection' ->> 'id') = 'confirmed' and pg_temp.n_ent('A', 'E15', 'used') = 1);
reset role; set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B22 the customer sees number 1 free again and number 2 still theirs', pg_temp.cell(pg_temp.board_of(pg_temp.st('E15'), 1), 1) ->> 's' = 'free' and pg_temp.cell(pg_temp.board_of(pg_temp.st('E15'), 1), 2) ->> 's' = 'mine');

-- =========================================================================================== B23 a claim settles FIRST (the customer lock, then the board, then the rights)
-- A bill is paid while rewards are switched OFF, so no trigger earned anything. Switched on, the customer's first claim settles before it looks for a right.
create temp sequence t_seq;
create or replace function pg_temp.mk_order(p_profile uuid, p_amount numeric) returns uuid language plpgsql as $$
declare fin uuid; inv uuid; oid uuid := gen_random_uuid(); n int := nextval('pg_temp.t_seq'); ono text := 'SO-T-' || lpad(n::text, 6, '0'); sku text;
begin
  select sku_code into sku from public.sku_registry where sku_category = 'FG' and status = 'active' order by sku_code limit 1;
  select id into fin from public.finance_customers where profile_id = p_profile;
  if fin is null then insert into public.finance_customers (code, name, profile_id) values ('T-' || substr(replace(p_profile::text, '-', ''), 1, 12), 'Test ' || substr(p_profile::text, 1, 4), p_profile) returning id into fin; end if;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref) values ('INV-T-' || lpad(n::text, 6, '0'), fin, current_date, current_date + 30, p_amount, 'Test order ' || ono, ono) returning id into inv;
  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone, subtotal, shipping_fee, total, invoice_id)
    values (oid, ono, p_profile, fin, 'test-key-' || lpad(n::text, 8, '0'), 'x', 'pickup', 'Test', '0811111111', p_amount, 0, p_amount, inv);
  insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total) values (oid, 1, sku, 'Test ' || sku, 'pcs', p_amount, 1, p_amount);
  return oid;
end $$;
reset role; select pg_temp.mk_event('E16', 'Settle first', '{"hold":10}');
update public.rw_settings set enabled = false;
select pg_temp.put('o16', pg_temp.mk_order(pg_temp.c('D')::uuid, 900)::text);
select pg_temp.put('inv16', pg_temp.q(format($f$select invoice_id from public.shop_orders where id = %L$f$, pg_temp.c('o16'))));
set local role authenticated; select pg_temp.who('S');
select public.finance_post_evidence((public.finance_record_payment(pg_temp.c('inv16')::uuid, 'transfer', 900, now(), 'REF-B23-0001', null, 'payment')::jsonb ->> 'evidence_id')::uuid, null);
reset role; update public.rw_settings set enabled = true;
select pg_temp.chk('B23 setup: the bill is fully paid but earned nothing (rewards were off when it was paid)', (public.finance_invoice_state_raw(pg_temp.c('inv16')::uuid) ->> 'status_code') = '5'
  and pg_temp.q(format($f$select count(*) from public.rw_entitlements where profile_id = %L and event_id = %L$f$, pg_temp.c('D'), pg_temp.c('E16'))) = '0');
set local role authenticated; select pg_temp.who('D');
select pg_temp.put('c16', pg_temp.claim('E16', 'E16A', 5, 'key-D-b23-001')::text);
select pg_temp.chk('B23 the claim settled first: the paid bill of 900 earned 3 rights, one was used for the claim (hold: reserved)', pg_temp.j('c16') -> 'selection' ->> 'status' = 'reserved' and pg_temp.j('c16') -> 'rights' = '{"earned":3,"used":1,"remaining":2}'::jsonb, pg_temp.c('c16'));
select pg_temp.put('rc16', pg_temp.q(format($f$select id from public.finance_receipts where invoice_id = %L and status = 'posted'$f$, pg_temp.c('inv16'))));
reset role; set local role authenticated; select pg_temp.who('S');
select public.finance_reverse_receipt(pg_temp.c('rc16')::uuid, 'B23 reversal');
reset role;
select pg_temp.chk('B23 the reversal (a settle trigger) took the unused rights back and flagged the right already on the number', pg_temp.n_ent('D', 'E16', 'revoked') = 2 and pg_temp.n_ent('D', 'E16', 'used') = 1
  and pg_temp.q(format($f$select needs_review from public.rw_entitlements where profile_id = %L and status = 'used' and event_id = %L$f$, pg_temp.c('D'), pg_temp.c('E16'))) = 'true');
set local role authenticated; select pg_temp.who('D');
select pg_temp.chk('B23 confirming settles first too and still works: the number stays the customer''s (only a Super Admin decides on a flagged right)', public.rw_confirm_selection((pg_temp.j('c16') -> 'selection' ->> 'id')::uuid) -> 'selection' ->> 'status' = 'confirmed');
select pg_temp.err_like('B23 a further claim is refused: nothing of the reversed bill is spendable', pg_temp.cl('E16', 'E16A', 6, 'key-D-b23-002'), '%NO_ENTITLEMENT%');
select pg_temp.put('ent16', pg_temp.q(format($f$select id from public.rw_entitlements where profile_id = %L and needs_review and event_id = %L$f$, pg_temp.c('D'), pg_temp.c('E16'))));
reset role; set local role authenticated; select pg_temp.who('S');
select public.rw_admin_resolve_review(pg_temp.c('ent16')::uuid, 'release', 'the payment was reversed');
reset role; set local role authenticated; select pg_temp.who('D');
select pg_temp.chk('B23 after the review "release" the number is free again and the right stays revoked (3 revoked, none available)', pg_temp.cell(pg_temp.board_of(pg_temp.st('E16'), 1), 5) ->> 's' = 'free' and pg_temp.n_ent('D', 'E16', 'revoked') = 3 and pg_temp.n_ent('D', 'E16', 'available') = 0
  and pg_temp.sel_status(pg_temp.j('c16') -> 'selection' ->> 'id') = 'released');

-- =========================================================================================== B19 rewards / boards switched off
reset role; update public.rw_settings set boards_enabled = false;
set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B19 boards off: customers cannot read the state', $q$select public.rw_board_state(null)$q$, '%BOARDS_OFF%');
select pg_temp.err_like('B19 nor poll', $q$select public.rw_board_rev(null)$q$, '%BOARDS_OFF%');
select pg_temp.err_like('B19 nor claim', pg_temp.cl('E1', 'E1A', 40, 'key-A-off001'), '%BOARDS_OFF%');
select pg_temp.err_like('B19 nor confirm', format($q$select public.rw_confirm_selection(%L)$q$, pg_temp.j('h1') -> 'selection' ->> 'id'), '%BOARDS_OFF%');
select pg_temp.err_like('B19 not even a replay of an earlier claim', pg_temp.cl('E1', 'E1A', 7, 'key-A-0007'), '%BOARDS_OFF%');
reset role; set local role authenticated; select pg_temp.who('M');
select pg_temp.chk('B19 staff can still set everything up while it is dark', jsonb_array_length(public.rw_admin_events()) > 5 and public.rw_admin_board(pg_temp.c('E1A')::uuid) -> 'board' ->> 'id' = pg_temp.c('E1A'));
reset role; update public.rw_settings set enabled = false, boards_enabled = true;
set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B19 the master switch off: boards are off as well', $q$select public.rw_board_state(null)$q$, '%BOARDS_OFF%');
select pg_temp.err_like('B19 ... also for a claim', pg_temp.cl('E1', 'E1A', 40, 'key-A-off002'), '%BOARDS_OFF%');
reset role; update public.rw_settings set enabled = true, boards_enabled = true;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B19 switched on again, everything is back and nothing was lost', pg_temp.cell(pg_temp.board_of(pg_temp.st('E1'), 1), 7) ->> 's' = 'mine');

-- =========================================================================================== B24 review round 1: the most restricted right is spent first, a dead replay is not success, kept is cleared
reset role; select pg_temp.mk_event('E24', 'Restrictive first');
select pg_temp.mk_rule('E24r3', 'E24', array[3]);                                    -- a rule whose rights are valid on board 3 only (newer than the event's own any-board rule)
select pg_temp.picks('A', 'E24', 1);                                                -- right 1: any board (older)
select pg_temp.picks('A', 'E24', 1, 'E24r3');                                       -- right 2: board 3 only (newer)
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('r24a', pg_temp.claim('E24', 'E24C', 5, 'key-r24-0001')::text);   -- board 3 first: must spend the board-3-only right
select pg_temp.put('r24b', pg_temp.claim('E24', 'E24A', 6, 'key-r24-0002')::text);   -- then board 1: the any-board right must still be there
select pg_temp.chk('B24 a board-3-only right and an any-board right: claiming board 3 and then board 1 both succeed (the restricted right goes first)',
  (pg_temp.j('r24a') -> 'selection' ->> 'status') = 'confirmed' and (pg_temp.j('r24b') -> 'selection' ->> 'status') = 'confirmed', pg_temp.c('r24b'));
reset role; select pg_temp.chk('B24 ... and the board-3-only right is the one that backs the board-3 number',
  (select r.board_slots = array[3] from public.rw_selections s join public.rw_entitlements e on e.id = s.entitlement_id join public.rw_rules r on r.id = e.rule_id
    where s.id = (pg_temp.j('r24a') -> 'selection' ->> 'id')::uuid), null);

reset role; select pg_temp.mk_event('E25', 'Replay of a dead hold', '{"hold": 5}'); select pg_temp.picks('A', 'E25', 2);
set local role authenticated; select pg_temp.who('A');
select pg_temp.put('rp1', pg_temp.claim('E25', 'E25A', 9, 'key-rp-00001')::text);
select pg_temp.chk('B24 a hold claim is reserved first', (pg_temp.j('rp1') -> 'selection' ->> 'status') = 'reserved', pg_temp.c('rp1'));
select pg_temp.chk('B24 replaying the key while the hold is valid returns the same selection (replay = true)',
  (pg_temp.claim('E25', 'E25A', 9, 'key-rp-00001') ->> 'replay')::boolean and (pg_temp.claim('E25', 'E25A', 9, 'key-rp-00001') -> 'selection' ->> 'id') = (pg_temp.j('rp1') -> 'selection' ->> 'id'), null);
reset role; update public.rw_selections set expires_at = now() - interval '1 minute' where id = (pg_temp.j('rp1') -> 'selection' ->> 'id')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.err_like('B24 replaying the key of a LAPSED hold is HOLD_EXPIRED, not success', pg_temp.cl('E25', 'E25A', 9, 'key-rp-00001'), '%HOLD_EXPIRED%');
select pg_temp.err_like('B24 ... a different payload on that key is still KEY_REUSED', pg_temp.cl('E25', 'E25A', 11, 'key-rp-00001'), '%KEY_REUSED%');

reset role; select pg_temp.mk_event('E26', 'Kept cleared'); select pg_temp.picks('A', 'E26', 1);
select pg_temp.put('k_ent', pg_temp.ent('A', 'E26', 0));
select pg_temp.run(pg_temp.ins('E26', 'E26A', 4, 'A', pg_temp.c('k_ent'), true));
select pg_temp.put('k_sel', pg_temp.q(format($f$select id from public.rw_selections where entitlement_id = %L$f$, pg_temp.c('k_ent'))));
update public.rw_entitlements set status = 'used', used_selection_id = pg_temp.c('k_sel')::uuid, kept = true where id = pg_temp.c('k_ent')::uuid;
select pg_temp.put('k_before', (select status || '/kept=' || kept || '/sel=' || coalesce(used_selection_id::text, 'null') from public.rw_entitlements where id = pg_temp.c('k_ent')::uuid));
select pg_temp.put('k_ret', coalesce(public.rw_return_pick(pg_temp.c('k_ent')::uuid, pg_temp.c('k_sel')::uuid), 'null'));
select pg_temp.chk('B24 a KEPT right whose pick is returned comes back available and is no longer kept (so a later take-back flags it again)',
  pg_temp.c('k_ret') = 'available' and (select status = 'available' and not kept from public.rw_entitlements where id = pg_temp.c('k_ent')::uuid),
  'before ' || pg_temp.c('k_before') || ' returned ' || pg_temp.c('k_ret') || ' after ' || (select status || '/kept=' || kept from public.rw_entitlements where id = pg_temp.c('k_ent')::uuid));

-- =========================================================================================== B25 per-board remaining picks, own numbers of a closed event (review round 1, item 11)
reset role; select pg_temp.mk_event('E27', 'Per-board rights');
select pg_temp.mk_rule('E27r2', 'E27', array[2]);                          -- a rule whose rights are valid on board 2 only
select pg_temp.picks('A', 'E27', 2, 'E27r2');                              -- A owns 2 rights, both only for board 2
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B25 event-wide rights say 2 remaining, but only board 2 can spend them (remaining per board: 0, 2, 0)',
  pg_temp.st('E27') -> 'rights' = '{"earned":2,"used":0,"remaining":2}'::jsonb
  and (pg_temp.board_of(pg_temp.st('E27'), 1) ->> 'remaining')::int = 0 and (pg_temp.board_of(pg_temp.st('E27'), 2) ->> 'remaining')::int = 2 and (pg_temp.board_of(pg_temp.st('E27'), 3) ->> 'remaining')::int = 0,
  pg_temp.st('E27')::text);
select pg_temp.err_like('B25 ... and a claim on board 1 really is refused (NO_ENTITLEMENT), which is what the screen now says before the tap', pg_temp.cl('E27', 'E27A', 4, 'key-r27-0001'), '%NO_ENTITLEMENT%');
select pg_temp.put('r27', pg_temp.claim('E27', 'E27B', 4, 'key-r27-0002')::text);
select pg_temp.chk('B25 a claim on board 2 works and the per-board remaining drops to 1; a stranger sees remaining 0 everywhere',
  (pg_temp.board_of(pg_temp.st('E27'), 2) ->> 'remaining')::int = 1 and (pg_temp.j('r27') -> 'board' ->> 'remaining')::int = 1, pg_temp.c('r27'));
reset role; set local role authenticated; select pg_temp.who('D');
select pg_temp.chk('B25 another customer without rights has remaining 0 on every board', (select bool_and((b ->> 'remaining')::int = 0) from jsonb_array_elements(pg_temp.st('E27') -> 'boards') b), null);
-- the event is closed: the customer still sees the number they hold in rw_my_rewards
reset role; update public.rw_events set status = 'closed' where id = pg_temp.c('E27')::uuid;
set local role authenticated; select pg_temp.who('A');
select pg_temp.chk('B25 a CLOSED event does not hide the customer''s own number: rw_my_rewards still lists it', exists (
  select 1 from jsonb_array_elements(public.rw_my_rewards() -> 'selections') s where s ->> 'event_id' = pg_temp.c('E27') and (s ->> 'number')::int = 4 and s ->> 'status' = 'confirmed'), (public.rw_my_rewards() -> 'selections')::text);

-- =========================================================================================== B20 grants
reset role;
select pg_temp.chk('B20 the client API is executable by signed-in members and by nobody anonymous',
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('rw_board_state', 'rw_board_rev', 'rw_claim_number', 'rw_confirm_selection', 'rw_admin_events', 'rw_admin_save_event', 'rw_admin_set_event_status', 'rw_admin_save_board', 'rw_admin_board', 'rw_admin_log',
     'rw_board_lock', 'rw_board_unlock', 'rw_board_set_mode', 'rw_release_selection', 'rw_board_reset', 'rw_board_undo_reset', 'rw_sweep_holds') and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')) = 17);
select pg_temp.chk('B20 the trigger functions are not callable by clients', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('rw_events_guard', 'rw_boards_guard', 'rw_events_make_boards', 'rw_resets_guard', 'rw_selections_guard', 'rw_selections_mixed')
  and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))));

-- =========================================================================================== result
reset role;
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'EVENT_BOARDS_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
