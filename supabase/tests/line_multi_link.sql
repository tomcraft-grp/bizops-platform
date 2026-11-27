-- Tests for 20261128120000_line_multi_link.sql, run after the migration in ONE transaction that always rolls back (scripts/run-line-multi-link-sql-tests.sh).
-- Real data: S = a real SUPER_ADMIN, A1 / A2 / A3 = the three real ADMIN accounts, U = a real customer, and real 'new' orders (accepted inside the transaction only). The LINE accounts are test ids
-- (only inside this transaction). "Can this person act" is probed with the card's "reject" button (it answers 'ask_reason' without changing the order) wherever an order must stay new.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, m ilike p_pat, m); end;
end $$;
-- (line_act sets the old-style claim.sub too and auth.uid() reads it first, so both are set here)
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', uid::text, true), set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into t_ctx values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.sv(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.sx(p_sql text) returns void language plpgsql security definer as $$ begin execute p_sql; end $$;
-- a staff member makes a 6-digit code (as the Settings page does) and a LINE account types it to the bot (as the Edge Function does)
create or replace function pg_temp.mk(p uuid, p_kind text default 'staff') returns text language plpgsql security definer as $$
begin perform pg_temp.as_user(p); return public.line_link_code(p_kind) ->> 'code'; end $$;
create or replace function pg_temp.link(p uuid, p_line text, p_name text) returns text language plpgsql security definer as $$
declare c text; begin c := pg_temp.mk(p); return (public.line_redeem_code(p_line, p_name, c) ->> 'result'); end $$;
-- the card button a LINE account taps on the order number i (1-based in the order the fixtures were chosen)
create or replace function pg_temp.tap(p_line text, p_action text, i int) returns jsonb language plpgsql security definer as $$
declare o text := pg_temp.c('O' || i); cd text := pg_temp.c('C' || i); begin return public.line_act(p_line, p_action, o::uuid, cd::uuid, 0, null); end $$;
create or replace function pg_temp.links_of(p uuid) returns integer language sql as $$ select pg_temp.sv(format('select count(*) from public.line_staff_links where profile_id = %L', p))::int $$;
create or replace function pg_temp.linked(p_line text) returns uuid language sql as $$ select pg_temp.sv(format('select profile_id::text from public.line_staff_links where line_user_id = %L', p_line))::uuid $$;

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('A1', (select id::text from public.profiles where role = 'ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('A2', (select id::text from public.profiles where role = 'ADMIN' and status = 'active' and id <> pg_temp.c('A1')::uuid order by created_at limit 1));
select pg_temp.put('A3', (select id::text from public.profiles where role = 'ADMIN' and status = 'active' and id not in (pg_temp.c('A1')::uuid, pg_temp.c('A2')::uuid) order by created_at limit 1));
select pg_temp.put('S2', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' and id <> pg_temp.c('S')::uuid order by created_at limit 1));
select pg_temp.put('U', (select id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1));
-- six real orders that are still new, each with the card the group got (a missing card is added inside this transaction)
do $$ declare r record; i int := 0; grp text := coalesce((select group_id from public.line_settings where id), 'Ctestgroup0000000000');
begin
  for r in select id from public.shop_orders where status = 'new' order by created_at limit 6 loop
    i := i + 1;
    insert into public.line_outbox (event, order_id, target_type, target_id, payload) select 'order_new', r.id, 'group', grp, '{}'::jsonb
      where not exists (select 1 from public.line_outbox where order_id = r.id and event = 'order_new');
    perform pg_temp.put('O' || i, r.id::text);
    perform pg_temp.put('C' || i, (select id::text from public.line_outbox where order_id = r.id and event = 'order_new' order by created_at limit 1));
  end loop;
end $$;
select pg_temp.chk('F0 fixtures: two super admins, three admins, a customer and six new orders with cards', (select count(*) from t_ctx where v is not null) = 18, (select count(*) from t_ctx where v is not null)::text);
select pg_temp.put('links_before', pg_temp.sv('select count(*) from public.line_staff_links'));
select pg_temp.put('real_link', pg_temp.sv('select line_user_id from public.line_staff_links order by linked_at limit 1'));
select pg_temp.put('real_owner', pg_temp.sv('select profile_id::text from public.line_staff_links order by linked_at limit 1'));

-- ================================================================================================ the table
select pg_temp.chk('M1 a LINE account is the key; a staff account may hold several', pg_get_constraintdef((select oid from pg_constraint where conname = 'line_staff_links_pkey')) = 'PRIMARY KEY (line_user_id)'
  and not exists (select 1 from pg_constraint where conname = 'line_staff_links_line_user_id_key'));
select pg_temp.chk('M1 the staff account is indexed', exists (select 1 from pg_indexes where indexname = 'line_staff_links_profile_idx'));
select pg_temp.chk('M1 every link that existed is still there', pg_temp.c('links_before')::int >= 1 and pg_temp.sv(format($q$select count(*) from public.line_staff_links where line_user_id = %L and profile_id = %L$q$, pg_temp.c('real_link'), pg_temp.c('real_owner')))::int = 1);

-- ================================================================================================ THE BUG: one staff account, several people
select pg_temp.chk('B1 the first LINE account is linked under the staff account A1', pg_temp.link(pg_temp.c('A1')::uuid, 'Utest-multi-0000001', 'Somsri') = 'linked' and pg_temp.links_of(pg_temp.c('A1')::uuid) = 1);
select pg_temp.chk('B1 a second person typing a code made by the SAME staff account does not remove the first', pg_temp.link(pg_temp.c('A1')::uuid, 'Utest-multi-0000002', 'Malee') = 'linked'
  and pg_temp.links_of(pg_temp.c('A1')::uuid) = 2 and pg_temp.linked('Utest-multi-0000001') = pg_temp.c('A1')::uuid and pg_temp.linked('Utest-multi-0000002') = pg_temp.c('A1')::uuid);
select pg_temp.chk('B1 and a third', pg_temp.link(pg_temp.c('A1')::uuid, 'Utest-multi-0000003', 'Noi') = 'linked' and pg_temp.links_of(pg_temp.c('A1')::uuid) = 3);
select pg_temp.chk('B1 the link that existed before is untouched by all of this', pg_temp.sv(format($q$select count(*) from public.line_staff_links where line_user_id = %L and profile_id = %L$q$, pg_temp.c('real_link'), pg_temp.c('real_owner')))::int = 1
  or pg_temp.c('real_owner') = pg_temp.c('A1'));
select pg_temp.chk('B2 all three can use the card (the reject button answers for each, nothing changes)', (pg_temp.tap('Utest-multi-0000001', 'reject_ask', 1) ->> 'result') = 'ask_reason'
  and (pg_temp.tap('Utest-multi-0000002', 'reject_ask', 1) ->> 'result') = 'ask_reason' and (pg_temp.tap('Utest-multi-0000003', 'reject_ask', 1) ->> 'result') = 'ask_reason');
select pg_temp.chk('B3 the first person accepts an order', (pg_temp.tap('Utest-multi-0000001', 'accept', 1) ->> 'result') = 'done' and pg_temp.sv(format($q$select status from public.shop_orders where id = %L$q$, pg_temp.c('O1'))) = 'confirmed');
select pg_temp.chk('B3 the second person accepts another order, named with her own LINE name', (pg_temp.tap('Utest-multi-0000002', 'accept', 2) ->> 'by') like '% (Malee)' and pg_temp.sv(format($q$select status from public.shop_orders where id = %L$q$, pg_temp.c('O2'))) = 'confirmed');
select pg_temp.chk('B3 the order history carries who tapped', pg_temp.sv(format($q$select detail ->> 'by_label' from public.shop_events where entity = 'order' and entity_id = %L and action = 'order.line'$q$, pg_temp.c('O2'))) like '% (Malee)');
select pg_temp.chk('B4 a second tap on an accepted order says who accepted it (with her LINE name)', (pg_temp.tap('Utest-multi-0000003', 'accept', 2) ->> 'result') = 'already_done' and (pg_temp.tap('Utest-multi-0000003', 'accept', 2) ->> 'by') like '% (Malee)');
select pg_temp.chk('B4 "accepted by" on the web page of the order says the same', pg_temp.sv(format($q$select public.line_last_action(%L::uuid) ->> 'by'$q$, pg_temp.c('O2'))) like '% (Malee)');

-- ================================================================================================ three admins, one account each
select pg_temp.chk('C1 admin 2 and admin 3 link their own LINE accounts under their own staff accounts', pg_temp.link(pg_temp.c('A2')::uuid, 'Utest-multi-0000004', 'Admin Two') = 'linked'
  and pg_temp.link(pg_temp.c('A3')::uuid, 'Utest-multi-0000005', 'Admin Three') = 'linked');
select pg_temp.chk('C1 all three admins are authorized at the same time', (pg_temp.tap('Utest-multi-0000001', 'reject_ask', 3) ->> 'result') = 'ask_reason' and (pg_temp.tap('Utest-multi-0000004', 'reject_ask', 3) ->> 'result') = 'ask_reason'
  and (pg_temp.tap('Utest-multi-0000005', 'reject_ask', 3) ->> 'result') = 'ask_reason');
select pg_temp.chk('C2 admin 2 types a new code (the same LINE account again): nobody else is affected', pg_temp.link(pg_temp.c('A2')::uuid, 'Utest-multi-0000004', 'Admin Two') = 'linked'
  and pg_temp.links_of(pg_temp.c('A2')::uuid) = 1 and pg_temp.links_of(pg_temp.c('A1')::uuid) = 3 and pg_temp.links_of(pg_temp.c('A3')::uuid) = 1);
select pg_temp.chk('C2 admin 3 does the same: admin 1 (three people) and admin 2 keep their access', pg_temp.link(pg_temp.c('A3')::uuid, 'Utest-multi-0000005', 'Admin Three') = 'linked'
  and (pg_temp.tap('Utest-multi-0000002', 'reject_ask', 3) ->> 'result') = 'ask_reason' and (pg_temp.tap('Utest-multi-0000004', 'reject_ask', 3) ->> 'result') = 'ask_reason');
select pg_temp.chk('C3 each accepts a different order (alone, one staff account): the name is the staff name with no LINE name', (pg_temp.tap('Utest-multi-0000004', 'accept', 3) ->> 'by') not like '%(%'
  and (pg_temp.tap('Utest-multi-0000005', 'accept', 4) ->> 'result') = 'done' and pg_temp.sv(format($q$select count(*) from public.shop_orders where id in (%L, %L) and status = 'confirmed'$q$, pg_temp.c('O3'), pg_temp.c('O4')))::int = 2);
select pg_temp.chk('C4 switching between them in any order keeps everyone authorized', (pg_temp.tap('Utest-multi-0000005', 'reject_ask', 5) ->> 'result') = 'ask_reason' and (pg_temp.tap('Utest-multi-0000001', 'reject_ask', 5) ->> 'result') = 'ask_reason'
  and (pg_temp.tap('Utest-multi-0000004', 'reject_ask', 5) ->> 'result') = 'ask_reason' and (pg_temp.tap('Utest-multi-0000003', 'reject_ask', 5) ->> 'result') = 'ask_reason');

-- ================================================================================================ one LINE account, one staff account
select pg_temp.chk('D1 a LINE account that types a code from another staff account MOVES there (it is never in two places)', pg_temp.link(pg_temp.c('A3')::uuid, 'Utest-multi-0000003', 'Noi') = 'linked'
  and pg_temp.linked('Utest-multi-0000003') = pg_temp.c('A3')::uuid and pg_temp.links_of(pg_temp.c('A1')::uuid) = 2 and pg_temp.links_of(pg_temp.c('A3')::uuid) = 2);
select pg_temp.chk('D1 the others of the first staff account were not touched', pg_temp.linked('Utest-multi-0000001') = pg_temp.c('A1')::uuid and pg_temp.linked('Utest-multi-0000002') = pg_temp.c('A1')::uuid);

-- ================================================================================================ who may not
select pg_temp.chk('R1 a LINE account nobody linked is refused', (pg_temp.tap('Uunknown-line-0000001', 'accept', 6) ->> 'result') = 'not_linked' and pg_temp.sv(format($q$select status from public.shop_orders where id = %L$q$, pg_temp.c('O6'))) = 'new');
select pg_temp.sx(format($q$insert into public.line_staff_links (profile_id, line_user_id, display_name) values (%L, 'Utest-multi-customer1', 'A customer')$q$, pg_temp.c('U')));
select pg_temp.chk('R1 a link of a customer account (not ADMIN / SUPER_ADMIN) is refused', (pg_temp.tap('Utest-multi-customer1', 'accept', 6) ->> 'result') = 'not_allowed' and pg_temp.sv(format($q$select status from public.shop_orders where id = %L$q$, pg_temp.c('O6'))) = 'new');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.sx(format($q$update public.profiles set status = 'disabled' where id = %L$q$, pg_temp.c('A3')));
select pg_temp.chk('R1 a disabled staff account is refused, for every LINE account under it', (pg_temp.tap('Utest-multi-0000005', 'accept', 6) ->> 'result') = 'not_allowed' and (pg_temp.tap('Utest-multi-0000003', 'accept', 6) ->> 'result') = 'not_allowed'
  and pg_temp.sv(format($q$select status from public.shop_orders where id = %L$q$, pg_temp.c('O6'))) = 'new');
select pg_temp.chk('R1 ...while the other staff accounts still can', (pg_temp.tap('Utest-multi-0000001', 'reject_ask', 6) ->> 'result') = 'ask_reason' and (pg_temp.tap('Utest-multi-0000004', 'reject_ask', 6) ->> 'result') = 'ask_reason');
select pg_temp.chk('R2 a wrong code is refused', (public.line_redeem_code('Utest-multi-0000009', 'Nobody', '000000') ->> 'result') = 'bad_code' and pg_temp.links_of(pg_temp.c('A1')::uuid) = 2);
select pg_temp.put('used_code', pg_temp.mk(pg_temp.c('A2')::uuid));
select pg_temp.chk('R2 a code works once: the second use is refused', (public.line_redeem_code('Utest-multi-0000006', 'Six', pg_temp.c('used_code')) ->> 'result') = 'linked' and (public.line_redeem_code('Utest-multi-0000007', 'Seven', pg_temp.c('used_code')) ->> 'result') = 'bad_code'
  and pg_temp.linked('Utest-multi-0000007') is null);
select pg_temp.put('old_code', pg_temp.mk(pg_temp.c('A2')::uuid));
select pg_temp.sx($q$update public.line_bind_codes set expires_at = now() - interval '1 minute' where used_at is null$q$);
select pg_temp.chk('R2 an expired code is refused', (public.line_redeem_code('Utest-multi-0000008', 'Eight', pg_temp.c('old_code')) ->> 'result') = 'bad_code' and pg_temp.linked('Utest-multi-0000008') is null);
select pg_temp.as_user(pg_temp.c('U')::uuid);
set local role authenticated;
select pg_temp.err_like('R2 ...it is refused for the staff link', $q$select public.line_link_code('staff')$q$, '%not allowed%');
reset role;

-- ================================================================================================ taking a LINE account back
select pg_temp.as_user(pg_temp.c('A1')::uuid);
set local role authenticated;
select pg_temp.chk('U1 staff take back ONE of their LINE accounts: the other stays', (select true from (select public.line_unlink_account('Utest-multi-0000001')) x) and true);
reset role;
select pg_temp.chk('U1 only that one is gone', pg_temp.linked('Utest-multi-0000001') is null and pg_temp.linked('Utest-multi-0000002') = pg_temp.c('A1')::uuid and pg_temp.links_of(pg_temp.c('A1')::uuid) = 1);
select pg_temp.chk('U1 the account that was taken back can no longer act, the one left can', (pg_temp.tap('Utest-multi-0000001', 'reject_ask', 6) ->> 'result') = 'not_linked' and (pg_temp.tap('Utest-multi-0000002', 'reject_ask', 6) ->> 'result') = 'ask_reason');
set local role authenticated; select pg_temp.as_user(pg_temp.c('A2')::uuid);
select pg_temp.err_like('U2 an admin cannot take back someone else''s LINE account', $q$select public.line_unlink_account('Utest-multi-0000002')$q$, '%not allowed%');
select pg_temp.chk('U2 taking back a LINE account that is not linked changes nothing and does not fail', (select true from (select public.line_unlink_account('Unobody-linked-000001')) x));
reset role;
select pg_temp.chk('U2 nothing changed by that attempt', pg_temp.linked('Utest-multi-0000002') = pg_temp.c('A1')::uuid);
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('U3 a SUPER_ADMIN can take back anyone''s LINE account', (select true from (select public.line_unlink_account('Utest-multi-0000002')) x));
reset role;
select pg_temp.chk('U3 and it is gone', pg_temp.linked('Utest-multi-0000002') is null and pg_temp.links_of(pg_temp.c('A1')::uuid) = 0);
select pg_temp.chk('U3 every take-back is in the history, with the LINE name', pg_temp.sv($q$select count(*) from public.shop_events where entity = 'line' and action = 'line.unlink' and detail ->> 'line_name' in ('Somsri', 'Malee')$q$)::int = 2);
select pg_temp.sx(format($q$insert into public.line_staff_links (profile_id, line_user_id, display_name) values (%L, 'Utest-multi-0000010', 'One'), (%L, 'Utest-multi-0000011', 'Two')$q$, pg_temp.c('A1'), pg_temp.c('A1')));
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('U4 the old call (take back a whole staff account) still removes every LINE account of it', (select true from (select public.line_unlink(pg_temp.c('A1')::uuid)) x));
reset role;
select pg_temp.chk('U4 and only that staff account lost them', pg_temp.links_of(pg_temp.c('A1')::uuid) = 0 and pg_temp.links_of(pg_temp.c('A2')::uuid) >= 1);

-- ================================================================================================ the Settings page data
select pg_temp.sx(format($q$insert into public.line_staff_links (profile_id, line_user_id, display_name, linked_at) values (%L, 'Utest-multi-0000012', 'First', now() - interval '1 minute'), (%L, 'Utest-multi-0000013', 'Second', now())$q$, pg_temp.c('A1'), pg_temp.c('A1')));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A1')::uuid);
select pg_temp.put('st_a1', public.line_admin_settings()::text);
select pg_temp.chk('P1 the settings answer works with several LINE accounts (no "more than one row" error)', pg_temp.c('st_a1')::jsonb ? 'my_link' and pg_temp.c('st_a1')::jsonb ? 'my_links');
select pg_temp.chk('P1 my_links lists each of mine with its LINE name; my_link (the old key) is the newest one', jsonb_array_length(pg_temp.c('st_a1')::jsonb -> 'my_links') = 2
  and pg_temp.c('st_a1')::jsonb -> 'my_link' ->> 'display_name' = 'Second' and (select array_agg(x ->> 'display_name' order by x ->> 'display_name') from jsonb_array_elements(pg_temp.c('st_a1')::jsonb -> 'my_links') x) = array['First', 'Second']);
select pg_temp.chk('P1 an ADMIN does not see the list of everybody', pg_temp.c('st_a1')::jsonb -> 'links' = 'null'::jsonb);
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.put('st_s', public.line_admin_settings()::text);
select pg_temp.chk('P2 a SUPER_ADMIN sees one row per LINE account with the staff account, the LINE name and the id to take it back', (select count(*) from jsonb_array_elements(pg_temp.c('st_s')::jsonb -> 'links') x where x ->> 'profile_id' = pg_temp.c('A1')) = 2
  and (select bool_and(x ? 'line_user_id' and x ? 'line_name') from jsonb_array_elements(pg_temp.c('st_s')::jsonb -> 'links') x));
reset role;

-- ================================================================================================ preorder messages to an employee reach each of their LINE accounts
select pg_temp.sx($q$update public.line_settings set enabled = true, events = events || '{"preorder_staff": true}'::jsonb$q$);
select pg_temp.put('before_out', pg_temp.sv($q$select count(*) from public.line_outbox where event = 'preorder'$q$));
select pg_temp.sx(format($q$select public.preorder_notify('assigned', %L::uuid, 'staff', 'multi-link-test-1', '{}'::jsonb, %L::uuid, true)$q$, pg_temp.c('O1'), pg_temp.c('A1')));
select pg_temp.chk('N1 a message for an employee with two LINE accounts is queued for both', pg_temp.sv(format($q$select count(*) from public.line_outbox where event = 'preorder' and target_type = 'user' and target_id in ('Utest-multi-0000012', 'Utest-multi-0000013')$q$))::int = 2);
select pg_temp.sx(format($q$select public.preorder_notify('assigned', %L::uuid, 'staff', 'multi-link-test-2', '{}'::jsonb, %L::uuid, true)$q$, pg_temp.c('O1'), pg_temp.c('S2')));
select pg_temp.chk('N1 an employee with no LINE account gets no LINE message, and the in-app notice is kept', pg_temp.sv(format($q$select count(*) from public.preorder_notices where dedupe_key = 'multi-link-test-2'$q$))::int = 1
  and pg_temp.sv($q$select count(*) from public.line_outbox where event = 'preorder'$q$)::int = pg_temp.c('before_out')::int + 2);

-- ================================================================================================ nothing else changed
select pg_temp.chk('Z2 the grants: the new take-back function is for signed-in users only, the helper for nobody', not has_function_privilege('anon', 'public.line_unlink_account(text)', 'execute') and has_function_privilege('authenticated', 'public.line_unlink_account(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.line_person_via(uuid, text)', 'execute'));

do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'LINE_MULTI_LINK_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
