-- Tests for 20261127120000_points_transfer.sql, after the migration in ONE transaction that always rolls back (scripts/run-points-transfer-sql-tests.sh).
-- A, B, C, D = four real active customer profiles that have no points yet; S = a real SUPER_ADMIN. Their test points, transfers, notices and member codes disappear with the rollback.
-- Customers act through `set local role authenticated` + their jwt claims, exactly as the app does; internal numbers are read as the owner.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated; grant usage on sequence t_res_n_seq to authenticated;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, m ilike p_pat, m); end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into t_ctx values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.bal(k text) returns integer language sql as $$ select public.rw_points_balance(pg_temp.c(k)::uuid) $$;
create or replace function pg_temp.avail(k text) returns integer language sql as $$ select public.rw_points_available(pg_temp.c(k)::uuid) $$;

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
do $$ declare r record; i integer := 0; l text[] := array['A', 'B', 'C', 'D'];
begin
  for r in select p.id from public.profiles p where p.status = 'active' and p.role = 'USER' and not exists (select 1 from public.rw_points_ledger x where x.profile_id = p.id) order by p.created_at limit 4 loop
    i := i + 1; perform pg_temp.put(l[i], r.id::text);
  end loop;
end $$;
select pg_temp.chk('fixtures: S, A, B, C, D', (select count(*) from t_ctx where v is not null) = 5, (select string_agg(k, ',') from t_ctx));
-- the rewards are on in the live project; make it certain for the test, and switch the transfers on (they ship off)
update public.rw_settings set enabled = true;
insert into public.rw_points_ledger (profile_id, points, kind, source_key, note) values (pg_temp.c('A')::uuid, 7, 'adjust', 'adjust', 'test seed'), (pg_temp.c('B')::uuid, 10, 'adjust', 'adjust', 'test seed'), (pg_temp.c('C')::uuid, 3, 'adjust', 'adjust', 'test seed');

-- ------------------------------------------------------------------------------------------------ ships dark, closed to clients
select pg_temp.chk('M1 the transfers ship OFF', (select transfers_enabled = false from public.rw_transfer_settings where id));
select pg_temp.chk('M1 the four new tables have RLS and no client grants',
  (select count(*) = 4 and bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.rw_transfer_settings'::regclass, 'public.rw_members'::regclass, 'public.rw_point_transfers'::regclass, 'public.rw_transfer_notices'::regclass))
  and not exists (select 1 from information_schema.role_table_grants g where g.table_name in ('rw_transfer_settings', 'rw_members', 'rw_point_transfers', 'rw_transfer_notices') and g.grantee in ('anon', 'authenticated')));
select pg_temp.chk('M1 anon runs none of the new functions',
  not has_function_privilege('anon', 'public.rw_transfer_create(text, integer, text, text)', 'execute') and not has_function_privilege('anon', 'public.rw_transfer_accept(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.rw_transfer_overview()', 'execute') and not has_function_privilege('anon', 'public.rw_admin_transfers(text, text, integer, integer)', 'execute'));
select pg_temp.chk('M1 a customer cannot call the internal helpers',
  not has_function_privilege('authenticated', 'public.rw_points_available(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.rw_points_balance(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.rw_transfer_note(uuid, uuid, text)', 'execute'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('M2 off: a customer cannot read the tables directly', $q$select * from public.rw_point_transfers$q$, '%permission denied%');
select pg_temp.chk('M3 off: the overview says disabled and moves nothing', (public.rw_transfer_overview() ->> 'enabled')::boolean = false);
select pg_temp.err_like('M3 off: no transfer', $q$select public.rw_transfer_create('AAAAAAAA', 1, 'transfer-key-off-1', null)$q$, '%TRANSFERS_OFF%');
select pg_temp.err_like('M3 off: no lookup', $q$select public.rw_transfer_lookup('AAAAAAAA')$q$, '%TRANSFERS_OFF%');
reset role;
update public.rw_transfer_settings set transfers_enabled = true;

-- ------------------------------------------------------------------------------------------------ member codes and the lookup preview
set local role authenticated;
select pg_temp.as_user(pg_temp.c('A')::uuid); select pg_temp.put('OA', public.rw_transfer_overview()::text);
select pg_temp.as_user(pg_temp.c('B')::uuid); select pg_temp.put('OB', public.rw_transfer_overview()::text);
select pg_temp.as_user(pg_temp.c('C')::uuid); select pg_temp.put('OC', public.rw_transfer_overview()::text);
select pg_temp.as_user(pg_temp.c('D')::uuid); select pg_temp.put('OD', public.rw_transfer_overview()::text);
reset role;
select pg_temp.put('CA', replace(pg_temp.c('OA')::jsonb ->> 'member_code', '-', '')); select pg_temp.put('CB', replace(pg_temp.c('OB')::jsonb ->> 'member_code', '-', ''));
select pg_temp.put('CC', replace(pg_temp.c('OC')::jsonb ->> 'member_code', '-', '')); select pg_temp.put('CD', replace(pg_temp.c('OD')::jsonb ->> 'member_code', '-', ''));
select pg_temp.chk('C1 every customer gets a member code: 8 characters from the alphabet without I O 0 1, shown as XXXX-XXXX, all different',
  (select bool_and(pg_temp.c(k) ~ '^[A-HJ-NP-Z2-9]{8}$') and count(distinct pg_temp.c(k)) = 4 from (values ('CA'), ('CB'), ('CC'), ('CD')) v(k)) and (pg_temp.c('OA')::jsonb ->> 'member_code') ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$', pg_temp.c('OA'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('C1 the code is stable: asking again returns the same one', replace(public.rw_transfer_overview() ->> 'member_code', '-', '') = pg_temp.c('CA'));
select pg_temp.put('LK', public.rw_transfer_lookup(pg_temp.c('CB'))::text);
select pg_temp.chk('C2 lookup: found, a SHORT name and a MASKED code; no phone, no e-mail, no ids',
  (pg_temp.c('LK')::jsonb ->> 'found')::boolean and (pg_temp.c('LK')::jsonb ->> 'code') like '%••••%' and (pg_temp.c('LK')::jsonb ->> 'code') <> pg_temp.c('CB')
  and not (pg_temp.c('LK')::jsonb ?| array['phone', 'email', 'id', 'profile_id', 'display_name']) and not (pg_temp.c('LK')::jsonb ->> 'is_self')::boolean, pg_temp.c('LK'));
select pg_temp.chk('C2 lookup accepts the code in any case, with dashes and spaces', (public.rw_transfer_lookup(substr(lower(pg_temp.c('CB')), 1, 4) || ' - ' || substr(pg_temp.c('CB'), 5)) ->> 'found')::boolean);
select pg_temp.chk('C2 lookup of an unknown code: found false and nothing else', public.rw_transfer_lookup('ZZZZZZZZ') = '{"found": false}'::jsonb);
select pg_temp.chk('C2 lookup of my own code says it is me', (public.rw_transfer_lookup(pg_temp.c('CA')) ->> 'is_self')::boolean);
select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.chk('C3 20 unknown codes in an hour are allowed...', (select count(*) = 20 from (select public.rw_transfer_lookup('ZZZZZZ' || lpad(g::text, 2, '2')) from generate_series(1, 20) g) q));
select pg_temp.err_like('C3 ...the 21st is refused: somebody is guessing', $q$select public.rw_transfer_lookup('ZZZZZZZZ')$q$, '%TOO_MANY_LOOKUPS%');
select pg_temp.err_like('C3 and a transfer to a guessed code is refused too', $q$select public.rw_transfer_create('ZZZZZZZZ', 1, 'transfer-key-guess-1', null)$q$, '%TOO_MANY_LOOKUPS%');
reset role;

-- ------------------------------------------------------------------------------------------------ the normal case: B sends 3 to A, A accepts (A: 7 + 3 = 10)
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('T1', public.rw_transfer_create(pg_temp.c('CA'), 3, 'transfer-key-0001', 'for your reward')::text);
select pg_temp.put('T1ID', pg_temp.c('T1')::jsonb ->> 'id');
reset role;
select pg_temp.chk('N1 created pending: the sender sees an outgoing request; the points are RESERVED, not moved',
  pg_temp.c('T1')::jsonb ->> 'status' = 'pending' and pg_temp.c('T1')::jsonb ->> 'direction' = 'out' and (pg_temp.c('T1')::jsonb ->> 'points')::int = 3 and (pg_temp.c('T1')::jsonb ->> 'transfer_no') like 'PT-%', pg_temp.c('T1'));
select pg_temp.chk('N1 B: balance 10 still, 3 reserved, 7 available; A: 7 untouched', pg_temp.bal('B') = 10 and public.rw_points_reserved(pg_temp.c('B')::uuid) = 3 and pg_temp.avail('B') = 7 and pg_temp.bal('A') = 7 and pg_temp.avail('A') = 7);
select pg_temp.chk('N1 no ledger row yet; the recipient has an incoming notice', (select count(*) from public.rw_points_ledger where note like 'Transfer %') = 0
  and exists (select 1 from public.rw_transfer_notices where profile_id = pg_temp.c('A')::uuid and transfer_id = pg_temp.c('T1ID')::uuid and kind = 'incoming'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('OA2', public.rw_transfer_overview()::text);
select pg_temp.chk('N2 A sees it as an incoming request with the sender as a short name and a masked code', jsonb_array_length(pg_temp.c('OA2')::jsonb -> 'incoming') = 1
  and pg_temp.c('OA2')::jsonb -> 'incoming' -> 0 ->> 'direction' = 'in' and (pg_temp.c('OA2')::jsonb -> 'incoming' -> 0 -> 'counterparty' ->> 'code') like '%••••%' and (pg_temp.c('OA2')::jsonb ->> 'unread')::int >= 1);
select pg_temp.put('AC1', public.rw_transfer_accept(pg_temp.c('T1ID')::uuid)::text);
reset role;
select pg_temp.chk('N3 accepted: A has 10, B has 7, nothing is reserved any more', pg_temp.c('AC1')::jsonb ->> 'status' = 'accepted' and pg_temp.bal('A') = 10 and pg_temp.bal('B') = 7 and public.rw_points_reserved(pg_temp.c('B')::uuid) = 0, pg_temp.c('AC1'));
select pg_temp.chk('N3 two ledger rows of kind adjust / source adjust (the settle function never touches them), linked from the transfer',
  (select count(*) = 2 and bool_and(kind = 'adjust' and source_key = 'adjust') from public.rw_points_ledger where note like 'Transfer PT-%')
  and (select out_ledger_id is not null and in_ledger_id is not null and sender_balance_before = 10 and recipient_balance_before = 7 from public.rw_point_transfers where id = pg_temp.c('T1ID')::uuid)
  and (select l.points from public.rw_points_ledger l join public.rw_point_transfers t on t.out_ledger_id = l.id where t.id = pg_temp.c('T1ID')::uuid) = -3);
select pg_temp.chk('N3 both customers are told it completed (and the incoming notice stays)', (select count(*) from public.rw_transfer_notices where transfer_id = pg_temp.c('T1ID')::uuid and kind = 'accepted') = 2
  and (select count(*) from public.rw_transfer_notices where transfer_id = pg_temp.c('T1ID')::uuid) = 3);
select pg_temp.chk('N3 the audit log has the request and the acceptance', (select count(*) from public.rw_events_log where entity_id = pg_temp.c('T1ID') and action in ('transfer.create', 'transfer.accept')) = 2);
select pg_temp.chk('N4 reward compatibility: A has the 10 points a 10-point reward needs, as the customer sees it too (rw_my_rewards) and as the one number to spend from',
  pg_temp.avail('A') >= 10);
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('N4 rw_my_rewards shows 10 points and the transfer in the history (no staff note shown)', (public.rw_my_rewards() ->> 'points')::int = 10 and jsonb_array_length(public.rw_my_rewards() -> 'points_history') >= 1);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('AC2', public.rw_transfer_accept(pg_temp.c('T1ID')::uuid)::text);
reset role;
select pg_temp.chk('N5 accepting twice: a replay, the points moved ONCE (A 10, B 7, two ledger rows, one accepted notice each)',
  (pg_temp.c('AC2')::jsonb ->> 'replay')::boolean and pg_temp.bal('A') = 10 and pg_temp.bal('B') = 7 and (select count(*) from public.rw_points_ledger where note like 'Transfer PT-%') = 2
  and (select count(*) from public.rw_transfer_notices where transfer_id = pg_temp.c('T1ID')::uuid and kind = 'accepted') = 2);
select pg_temp.chk('N6 the settle function leaves the transfer rows alone (it would reverse any other source)', public.rw_settle_profile(pg_temp.c('A')::uuid) >= 0 and public.rw_settle_profile(pg_temp.c('B')::uuid) >= 0
  and pg_temp.bal('A') = 10 and pg_temp.bal('B') = 7);

-- ------------------------------------------------------------------------------------------------ who may do what
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('T2', public.rw_transfer_create(pg_temp.c('CA'), 2, 'transfer-key-0002', null)::text); select pg_temp.put('T2ID', pg_temp.c('T2')::jsonb ->> 'id');
select pg_temp.err_like('W1 the sender cannot accept their own transfer', format('select public.rw_transfer_accept(%L::uuid)', pg_temp.c('T2ID')), '%NOT_FOUND%');
select pg_temp.err_like('W1 the sender cannot reject it either', format('select public.rw_transfer_reject(%L::uuid, null)', pg_temp.c('T2ID')), '%NOT_FOUND%');
select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.err_like('W2 a third customer cannot accept it', format('select public.rw_transfer_accept(%L::uuid)', pg_temp.c('T2ID')), '%NOT_FOUND%');
select pg_temp.err_like('W2 nor cancel it', format('select public.rw_transfer_cancel(%L::uuid)', pg_temp.c('T2ID')), '%NOT_FOUND%');
select pg_temp.chk('W2 and sees nothing of it in their overview', jsonb_array_length(public.rw_transfer_overview() -> 'incoming') = 0 and jsonb_array_length(public.rw_transfer_overview() -> 'outgoing') = 0 and jsonb_array_length(public.rw_transfer_overview() -> 'history') = 0);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W3 the recipient cannot cancel (only the sender)', format('select public.rw_transfer_cancel(%L::uuid)', pg_temp.c('T2ID')), '%NOT_FOUND%');
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('CX', public.rw_transfer_cancel(pg_temp.c('T2ID')::uuid)::text);
reset role;
select pg_temp.chk('W4 the sender cancels: status cancelled, the 2 reserved points are free, the recipient is told, balances unchanged',
  pg_temp.c('CX')::jsonb ->> 'status' = 'cancelled' and pg_temp.avail('B') = 7 and pg_temp.bal('B') = 7 and pg_temp.bal('A') = 10
  and exists (select 1 from public.rw_transfer_notices where transfer_id = pg_temp.c('T2ID')::uuid and profile_id = pg_temp.c('A')::uuid and kind = 'cancelled'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W4 a cancelled transfer cannot be accepted', format('select public.rw_transfer_accept(%L::uuid)', pg_temp.c('T2ID')), '%TRANSFER_NOT_PENDING%');
reset role;

-- ------------------------------------------------------------------------------------------------ validation
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('V1 zero points are refused', format('select public.rw_transfer_create(%L, 0, %L, null)', pg_temp.c('CA'), 'transfer-key-v1-0001'), '%POINTS_OUT_OF_RANGE%');
select pg_temp.err_like('V1 negative points are refused', format('select public.rw_transfer_create(%L, -5, %L, null)', pg_temp.c('CA'), 'transfer-key-v1-0002'), '%POINTS_OUT_OF_RANGE%');
select pg_temp.err_like('V1 more than the largest transfer is refused', format('select public.rw_transfer_create(%L, 1001, %L, null)', pg_temp.c('CA'), 'transfer-key-v1-0003'), '%POINTS_OUT_OF_RANGE%');
select pg_temp.err_like('V1 null points are refused', format('select public.rw_transfer_create(%L, null, %L, null)', pg_temp.c('CA'), 'transfer-key-v1-0004'), '%POINTS_OUT_OF_RANGE%');
select pg_temp.err_like('V1 a fraction is not an integer (the type refuses it)', format('select public.rw_transfer_create(%L, %L::integer, %L, null)', pg_temp.c('CA'), '2.5', 'transfer-key-v1-0005'), '%invalid input syntax%');
select pg_temp.err_like('V2 sending to myself is refused', format('select public.rw_transfer_create(%L, 1, %L, null)', pg_temp.c('CB'), 'transfer-key-v2-0001'), '%SELF_TRANSFER%');
select pg_temp.err_like('V3 an unknown member ID is refused', format('select public.rw_transfer_create(%L, 1, %L, null)', 'ABCDEFGH', 'transfer-key-v3-0001'), '%RECIPIENT_NOT_FOUND%');
select pg_temp.err_like('V3 an empty member ID is refused', format('select public.rw_transfer_create(%L, 1, %L, null)', '', 'transfer-key-v3-0002'), '%RECIPIENT_NOT_FOUND%');
select pg_temp.err_like('V4 a short or missing request key is refused', format('select public.rw_transfer_create(%L, 1, %L, null)', pg_temp.c('CA'), 'short'), '%INVALID_KEY%');
select pg_temp.err_like('V4 a message over 140 characters is refused', format('select public.rw_transfer_create(%L, 1, %L, %L)', pg_temp.c('CA'), 'transfer-key-v4-0002', repeat('x', 141)), '%MESSAGE_TOO_LONG%');
select pg_temp.err_like('V5 more points than available are refused, with the number that is available (B has 7)', format('select public.rw_transfer_create(%L, 8, %L, null)', pg_temp.c('CA'), 'transfer-key-v5-0001'), '%INSUFFICIENT_POINTS%7%');
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('V5 C has 3 and wants to send 5: refused', format('select public.rw_transfer_create(%L, 5, %L, null)', pg_temp.c('CA'), 'transfer-key-v5-0002'), '%INSUFFICIENT_POINTS%3%');
reset role;
select pg_temp.chk('V6 every refusal left nothing behind: no reservation, no transfer beyond the two made above', (select count(*) from public.rw_point_transfers) = 2 and public.rw_points_reserved(pg_temp.c('B')::uuid) = 0 and public.rw_points_reserved(pg_temp.c('C')::uuid) = 0);
-- the recipient must be able to receive
select pg_temp.as_user(pg_temp.c('S')::uuid);                                              -- the profile guard lets only a Super Admin change a status
update public.profiles set status = 'disabled' where id = pg_temp.c('D')::uuid;
select set_config('request.jwt.claims', '', true);
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('V7 a member whose account is not active cannot receive', format('select public.rw_transfer_create(%L, 1, %L, null)', pg_temp.c('CD'), 'transfer-key-v7-0001'), '%RECIPIENT_NOT_FOUND%');
reset role;
select pg_temp.as_user(pg_temp.c('S')::uuid);
update public.profiles set status = 'active' where id = pg_temp.c('D')::uuid;
select set_config('request.jwt.claims', '', true);

-- ------------------------------------------------------------------------------------------------ the same request twice
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('I1', public.rw_transfer_create(pg_temp.c('CA'), 1, 'transfer-key-idem-1', null)::text);
select pg_temp.put('I2', public.rw_transfer_create(pg_temp.c('CA'), 1, 'transfer-key-idem-1', null)::text);
select pg_temp.err_like('I2 the same key with another amount is refused', format('select public.rw_transfer_create(%L, 2, %L, null)', pg_temp.c('CA'), 'transfer-key-idem-1'), '%KEY_REUSED%');
select pg_temp.err_like('I2 the same key with another recipient is refused', format('select public.rw_transfer_create(%L, 1, %L, null)', pg_temp.c('CC'), 'transfer-key-idem-1'), '%KEY_REUSED%');
reset role;
select pg_temp.chk('I1 a retry returns the same transfer (replay) and reserves once', pg_temp.c('I1')::jsonb ->> 'id' = pg_temp.c('I2')::jsonb ->> 'id' and (pg_temp.c('I2')::jsonb ->> 'replay')::boolean
  and (select count(*) from public.rw_point_transfers where idempotency_key = 'transfer-key-idem-1') = 1 and public.rw_points_reserved(pg_temp.c('B')::uuid) = 1);
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid); select public.rw_transfer_cancel((pg_temp.c('I1')::jsonb ->> 'id')::uuid); reset role;

-- ------------------------------------------------------------------------------------------------ a partial transfer, and the reservation that stops double spending
insert into public.rw_points_ledger (profile_id, points, kind, source_key, note) values (pg_temp.c('B')::uuid, 3, 'adjust', 'adjust', 'test top-up so that B has 10 again');
select pg_temp.chk('R0 B has 10 again', pg_temp.bal('B') = 10 and pg_temp.avail('B') = 10);
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('R1', public.rw_transfer_create(pg_temp.c('CA'), 6, 'transfer-key-res-001', null)::text);
select pg_temp.err_like('R1 B has 10: 6 to A is pending, so 5 more to C is refused (only 4 are available)', format('select public.rw_transfer_create(%L, 5, %L, null)', pg_temp.c('CC'), 'transfer-key-res-002'), '%INSUFFICIENT_POINTS%4%');
select pg_temp.put('R3', public.rw_transfer_create(pg_temp.c('CC'), 4, 'transfer-key-res-003', null)::text);
select pg_temp.chk('R1 4 to C fits: B now has everything reserved (6 + 4)', (public.rw_transfer_overview() ->> 'available')::int = 0 and (public.rw_transfer_overview() ->> 'reserved')::int = 10);
select pg_temp.err_like('R1 and one more point is refused', format('select public.rw_transfer_create(%L, 1, %L, null)', pg_temp.c('CA'), 'transfer-key-res-004'), '%INSUFFICIENT_POINTS%0%');
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('R1R', public.rw_transfer_reject((pg_temp.c('R1')::jsonb ->> 'id')::uuid, 'not needed')::text);
reset role;
select pg_temp.chk('R2 A rejects: B gets the 6 points back to spend (4 still held for C), A and B balances unchanged, B is told',
  pg_temp.c('R1R')::jsonb ->> 'status' = 'rejected' and pg_temp.avail('B') = 6 and pg_temp.bal('B') = 10 and pg_temp.bal('A') = 10
  and exists (select 1 from public.rw_transfer_notices where transfer_id = (pg_temp.c('R1')::jsonb ->> 'id')::uuid and profile_id = pg_temp.c('B')::uuid and kind = 'rejected'));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('R2 rejecting twice is a replay', (public.rw_transfer_reject((pg_temp.c('R1')::jsonb ->> 'id')::uuid, null) ->> 'replay')::boolean);
select pg_temp.err_like('R2 a rejected transfer cannot be accepted afterwards', format('select public.rw_transfer_accept(%L::uuid)', pg_temp.c('R1')::jsonb ->> 'id'), '%TRANSFER_NOT_PENDING%');
select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.put('R3A', public.rw_transfer_accept((pg_temp.c('R3')::jsonb ->> 'id')::uuid)::text);   -- the PARTIAL transfer: 4 of B's 10
reset role;
select pg_temp.chk('R3 the partial transfer: B keeps 6, C has 3 + 4 = 7', pg_temp.bal('B') = 6 and pg_temp.bal('C') = 7 and pg_temp.avail('B') = 6);

-- ------------------------------------------------------------------------------------------------ staff cannot take away held points
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('H1', public.rw_transfer_create(pg_temp.c('CA'), 3, 'transfer-key-hold-01', null)::text);
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('H1 a Super Admin cannot remove points a pending transfer holds (B: 6, 3 held, removing 5 would cut into them)', format('select public.rw_admin_adjust_points(%L::uuid, -5, %L)', pg_temp.c('B'), 'test removal'), '%POINTS_RESERVED%');
select pg_temp.chk('H1 removing what is free works (B: 6, 3 held, remove 3 -> 3, the 3 still held)', public.rw_admin_adjust_points(pg_temp.c('B')::uuid, -3, 'test removal') = 3);
select pg_temp.err_like('H1 the old rule still holds: never below zero', format('select public.rw_admin_adjust_points(%L::uuid, -50, %L)', pg_temp.c('B'), 'test removal'), '%LIMIT_REACHED%');
select pg_temp.chk('H1 adding points still works', public.rw_admin_adjust_points(pg_temp.c('B')::uuid, 4, 'test grant') = 7);
reset role;
-- a legacy path cuts the balance below the held amount behind the request (B: 7, 3 held; now 1): accepting cannot be honoured and says so, nothing moves
insert into public.rw_points_ledger (profile_id, points, kind, source_key, note) values (pg_temp.c('B')::uuid, -6, 'adjust', 'adjust', 'test: points removed outside the transfer rules');
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('H2', public.rw_transfer_accept((pg_temp.c('H1')::jsonb ->> 'id')::uuid)::text);
reset role;
select pg_temp.chk('H2 sender balance changed: the request is cancelled (kept, with the reason), no point moved, both are told',
  pg_temp.c('H2')::jsonb ->> 'status' = 'cancelled' and pg_temp.c('H2')::jsonb ->> 'reason' = 'SENDER_BALANCE_CHANGED' and pg_temp.bal('B') = 1 and pg_temp.bal('A') = 10
  and (select count(*) from public.rw_transfer_notices where transfer_id = (pg_temp.c('H1')::jsonb ->> 'id')::uuid and kind = 'cancelled') = 2, pg_temp.c('H2'));

-- ------------------------------------------------------------------------------------------------ expiry
insert into public.rw_points_ledger (profile_id, points, kind, source_key, note) values (pg_temp.c('B')::uuid, 9, 'adjust', 'adjust', 'test top-up (B: 10)');
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('E1', public.rw_transfer_create(pg_temp.c('CA'), 5, 'transfer-key-exp-001', null)::text);
select pg_temp.put('E2', public.rw_transfer_create(pg_temp.c('CC'), 4, 'transfer-key-exp-002', null)::text);
reset role;
select pg_temp.chk('E0 two pending: 9 held, 1 available', public.rw_points_reserved(pg_temp.c('B')::uuid) = 9 and pg_temp.avail('B') = 1);
alter table public.rw_point_transfers disable trigger rw_transfers_guard;
update public.rw_point_transfers set expires_at = now() - interval '1 minute' where id = (pg_temp.c('E1')::jsonb ->> 'id')::uuid;
update public.rw_point_transfers set expires_at = now() - interval '1 minute' where id = (pg_temp.c('E2')::jsonb ->> 'id')::uuid;
alter table public.rw_point_transfers enable trigger rw_transfers_guard;
select pg_temp.chk('E1 an expired request stops holding points at once (even before anybody looks)', pg_temp.avail('B') = 10);
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('E1A', public.rw_transfer_accept((pg_temp.c('E1')::jsonb ->> 'id')::uuid)::text);
reset role;
select pg_temp.chk('E2 accepting too late: recorded as expired (kept, not an error), nothing moved, both told', pg_temp.c('E1A')::jsonb ->> 'status' = 'expired' and pg_temp.bal('B') = 10 and pg_temp.bal('A') = 10
  and (select status from public.rw_point_transfers where id = (pg_temp.c('E1')::jsonb ->> 'id')::uuid) = 'expired'
  and (select count(*) from public.rw_transfer_notices where transfer_id = (pg_temp.c('E1')::jsonb ->> 'id')::uuid and kind = 'expired') = 2);
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('EO', public.rw_transfer_overview()::text);
reset role;
select pg_temp.chk('E3 the other one expired when B looked: not pending any more, in the history as expired', jsonb_array_length(pg_temp.c('EO')::jsonb -> 'outgoing') = 0
  and exists (select 1 from jsonb_array_elements(pg_temp.c('EO')::jsonb -> 'history') h where h ->> 'transfer_no' = (select transfer_no from public.rw_point_transfers where id = (pg_temp.c('E2')::jsonb ->> 'id')::uuid) and h ->> 'status' = 'expired'));

-- ------------------------------------------------------------------------------------------------ limits
update public.rw_transfer_settings set max_pending = 2;
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select public.rw_transfer_create(pg_temp.c('CA'), 1, 'transfer-key-lim-001', null); select public.rw_transfer_create(pg_temp.c('CA'), 1, 'transfer-key-lim-002', null);
select pg_temp.err_like('L1 more pending transfers than the limit are refused', format('select public.rw_transfer_create(%L, 1, %L, null)', pg_temp.c('CA'), 'transfer-key-lim-003'), '%TOO_MANY_PENDING%');
reset role;
update public.rw_transfer_settings set max_pending = 10, max_points = 5, daily_max_points = 5;
set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select public.rw_transfer_create(pg_temp.c('CA'), 3, 'transfer-key-day-001', null);
select pg_temp.err_like('L2 the daily limit counts what was already sent today (3 + 3 > 5)', format('select public.rw_transfer_create(%L, 3, %L, null)', pg_temp.c('CA'), 'transfer-key-day-002'), '%DAILY_LIMIT%');
reset role;
update public.rw_transfer_settings set max_points = 1000, daily_max_points = 5000;

-- ------------------------------------------------------------------------------------------------ all or nothing, and notices never decide
create or replace function public.zz_boom() returns trigger language plpgsql as $$ begin raise exception 'forced failure while crediting'; end $$;
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('F1', public.rw_transfer_create(pg_temp.c('CD'), 2, 'transfer-key-fail-01', null)::text);
reset role;
select pg_temp.put('FB', pg_temp.bal('B')::text); select pg_temp.put('FD', pg_temp.bal('D')::text); select pg_temp.put('FL', (select count(*) from public.rw_points_ledger)::text);
create trigger zz_boom before insert on public.rw_points_ledger for each row when (new.points > 0 and new.note like 'Transfer PT-%') execute function public.zz_boom();
set local role authenticated; select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.err_like('X1 an error while CREDITING the recipient (after the sender was already deducted in the same function) fails the whole accept', format('select public.rw_transfer_accept(%L::uuid)', pg_temp.c('F1')::jsonb ->> 'id'), '%forced failure%');
reset role;
drop trigger zz_boom on public.rw_points_ledger;
select pg_temp.chk('X1 ... and NOTHING of it stayed: the sender was not deducted, the recipient not credited, no ledger row, the transfer is still pending and still reserves its points',
  pg_temp.bal('B') = pg_temp.c('FB')::int and pg_temp.bal('D') = pg_temp.c('FD')::int and (select count(*) from public.rw_points_ledger) = pg_temp.c('FL')::int
  and (select status from public.rw_point_transfers where id = (pg_temp.c('F1')::jsonb ->> 'id')::uuid) = 'pending' and public.rw_points_reserved(pg_temp.c('B')::uuid) >= 2
  and not exists (select 1 from public.rw_transfer_notices where transfer_id = (pg_temp.c('F1')::jsonb ->> 'id')::uuid and kind = 'accepted'));
-- a notice that cannot be written must not stop the points
create or replace function public.zz_notice_boom() returns trigger language plpgsql as $$ begin raise exception 'forced notice failure'; end $$;
create trigger zz_notice_boom before insert on public.rw_transfer_notices for each row when (new.kind = 'accepted') execute function public.zz_notice_boom();
set local role authenticated; select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.put('F2', public.rw_transfer_accept((pg_temp.c('F1')::jsonb ->> 'id')::uuid)::text);
reset role;
drop trigger zz_notice_boom on public.rw_transfer_notices;
select pg_temp.chk('X2 a notice that fails never changes a point: the transfer is accepted and the points moved (B -2, D +2); the failure is in the audit log',
  pg_temp.c('F2')::jsonb ->> 'status' = 'accepted' and pg_temp.bal('B') = pg_temp.c('FB')::int - 2 and pg_temp.bal('D') = pg_temp.c('FD')::int + 2
  and exists (select 1 from public.rw_events_log where action = 'transfer.notice_error' and entity_id = (pg_temp.c('F1')::jsonb ->> 'id')));

-- ------------------------------------------------------------------------------------------------ staff
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('S1 a customer cannot audit transfers', $q$select public.rw_admin_transfers(null, null, 10, 0)$q$, '%not allowed%');
select pg_temp.err_like('S1 nor change the settings', $q$select public.rw_admin_save_transfer_settings('{"transfers_enabled": false}')$q$, '%not allowed%');
select pg_temp.err_like('S1 nor read them', $q$select public.rw_admin_transfer_settings()$q$, '%not allowed%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.put('AT', public.rw_admin_transfers('accepted', null, 50, 0)::text);
select pg_temp.chk('S2 the audit lists the accepted transfers with both parties, their member codes, the ledger rows and the balances before',
  (pg_temp.c('AT')::jsonb ->> 'total')::int >= 3 and (select bool_and(x ->> 'sender' is not null and x ->> 'recipient' is not null and x ->> 'out_ledger_id' is not null and x ->> 'in_ledger_id' is not null and x ->> 'sender_before' is not null)
     from jsonb_array_elements(pg_temp.c('AT')::jsonb -> 'items') x));
select pg_temp.chk('S2 filter by status and search by number', (select count(*) from jsonb_array_elements(public.rw_admin_transfers('pending', (pg_temp.c('H1')::jsonb ->> 'transfer_no'), 10, 0) -> 'items')) = 0
  and (select count(*) from jsonb_array_elements(public.rw_admin_transfers(null, (pg_temp.c('T1')::jsonb ->> 'transfer_no'), 10, 0) -> 'items')) = 1);
select pg_temp.err_like('S3 an unknown setting is refused', $q$select public.rw_admin_save_transfer_settings('{"nope": 1}')$q$, '%BAD_FIELD%');
select pg_temp.err_like('S3 limits that do not fit together are refused (largest 10 above the daily 5)', $q$select public.rw_admin_save_transfer_settings('{"max_points": 10, "daily_max_points": 5}')$q$, '%BAD_VALUE%');
select pg_temp.err_like('S3 a fraction is refused', $q$select public.rw_admin_save_transfer_settings('{"max_points": 2.5}')$q$, '%BAD_VALUE%');
select pg_temp.put('SV', public.rw_admin_save_transfer_settings('{"expire_days": 3, "max_pending": 4}')::text);
select pg_temp.chk('S3 a valid change is saved and returned', (pg_temp.c('SV')::jsonb ->> 'expire_days')::int = 3 and (pg_temp.c('SV')::jsonb ->> 'max_pending')::int = 4, pg_temp.c('SV'));
select pg_temp.chk('S3 and read back by the next call', (public.rw_admin_transfer_settings() ->> 'max_pending')::int = 4);
reset role;
-- an admin cancel of a pending one
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.put('K1', public.rw_transfer_create(pg_temp.c('CA'), 1, 'transfer-key-adm-001', null)::text);
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('S4 a reason is required', format('select public.rw_admin_cancel_transfer(%L::uuid, %L)', pg_temp.c('K1')::jsonb ->> 'id', ' '), '%REASON_REQUIRED%');
select pg_temp.chk('S4 a Super Admin cancels a pending transfer with a reason', (public.rw_admin_cancel_transfer((pg_temp.c('K1')::jsonb ->> 'id')::uuid, 'test cancel') ->> 'status') = 'cancelled');
select pg_temp.err_like('S4 an accepted transfer is never undone this way', format('select public.rw_admin_cancel_transfer(%L::uuid, %L)', pg_temp.c('T1ID'), 'test cancel'), '%TRANSFER_NOT_PENDING%');
reset role;
select pg_temp.chk('S4 released and recorded', (select decision_reason from public.rw_point_transfers where id = (pg_temp.c('K1')::jsonb ->> 'id')::uuid) like 'ADMIN:%'
  and (select count(*) from public.rw_transfer_notices where transfer_id = (pg_temp.c('K1')::jsonb ->> 'id')::uuid and kind = 'cancelled') = 2);

-- ------------------------------------------------------------------------------------------------ read and the records never change
select pg_temp.err_like('Z1 a transfer cannot be deleted', $q$delete from public.rw_point_transfers$q$, '%never deleted%');
select pg_temp.err_like('Z1 nor truncated', $q$truncate public.rw_point_transfers$q$, '%truncat%');
select pg_temp.err_like('Z1 an accepted transfer cannot be changed', format('update public.rw_point_transfers set status = %L where id = %L', 'pending', pg_temp.c('T1ID')), '%already accepted%');
select pg_temp.err_like('Z1 the amount of a transfer cannot be changed', format('update public.rw_point_transfers set points = 99 where id = %L', pg_temp.c('H1')::jsonb ->> 'id'), '%cannot be changed%');
select pg_temp.chk('Z2 the books agree: for every accepted transfer the two ledger rows are equal and opposite and belong to its parties',
  (select bool_and(o.points = -i.points and o.points = -t.points and o.profile_id = t.sender_id and i.profile_id = t.recipient_id)
     from public.rw_point_transfers t join public.rw_points_ledger o on o.id = t.out_ledger_id join public.rw_points_ledger i on i.id = t.in_ledger_id where t.status = 'accepted'));
select pg_temp.chk('Z3 transfers moved points between customers and created none: the total of the transfer rows is 0', (select coalesce(sum(points), 0) from public.rw_points_ledger where note like 'Transfer PT-%') = 0);
select pg_temp.chk('Z4 nobody is over-reserved: for every customer the held points are within the balance (or the transfer already expired)',
  (select bool_and(public.rw_points_reserved(p) <= greatest(public.rw_points_balance(p), 0) + 0) from (select distinct sender_id p from public.rw_point_transfers) q));

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'POINTS_TRANSFER_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
