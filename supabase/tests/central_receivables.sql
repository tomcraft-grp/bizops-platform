-- Tests for 20261122130000_central_receivables.sql, after the migration in ONE transaction that always rolls back (scripts/run-central-receivables-sql-tests.sh).
-- S = a real SUPER_ADMIN (finance manager), U = a real USER profile without a finance role, A = the app profile of an existing central customer (for the customer view).
-- Everything created here (customers, links, invoices, payments, ledger-queue rows, counters) disappears with the rollback.
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

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('U', (select p.id::text from public.profiles p where p.role = 'USER' and p.status = 'active' and not exists (select 1 from public.finance_staff_roles r where r.user_id = p.id) order by created_at limit 1));
select pg_temp.put('CA', (select c.id::text from public.finance_customers c join public.profiles p on p.id = c.profile_id where p.status = 'active' order by c.created_at limit 1));
select pg_temp.put('A', (select profile_id::text from public.finance_customers where id = pg_temp.c('CA')::uuid));
-- TEST-ONLY (rolled back): lets the checks read an invoice's balance while acting as staff; the functions under test are SECURITY DEFINER and do not need it
grant execute on function public.finance_invoice_state_raw(uuid) to authenticated;
select pg_temp.chk('fixtures ready', (select count(*) from t_ctx where v is not null) = 4, (select string_agg(k || '=' || coalesce(v, 'NULL'), ',') from t_ctx));

-- ------------------------------------------------------------------------------------------------ linking customers
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.put('L1', public.finance_link_customer('test-device-1', 'C-LOCAL-1', 'CUS-001', 'Somchai Test', null, '{"name": "Somchai Test", "phone": "+66 81-234-5678"}')::text);
select pg_temp.put('C1', pg_temp.c('L1')::jsonb ->> 'id');
select pg_temp.chk('L1 a new central customer is created with a store code and the phone normalised',
  (pg_temp.c('L1')::jsonb ->> 'code') like 'ST%' and (pg_temp.c('L1')::jsonb ->> 'phone') = '0812345678' and (pg_temp.c('L1')::jsonb ->> 'outstanding')::numeric = 0, pg_temp.c('L1'));
select pg_temp.err_like('L2 a second customer with the same phone is refused and the first one is named',
  $q$select public.finance_link_customer('test-device-2', 'C-LOCAL-9', 'X', 'Other name', null, '{"name": "Other name", "phone": "081 234 5678"}')$q$, '%PHONE_TAKEN%Somchai Test%');
select pg_temp.err_like('L2 a bad phone is refused', $q$select public.finance_link_customer('test-device-2', 'C-LOCAL-9', 'X', 'Y', null, '{"name": "Y", "phone": "12"}')$q$, '%INVALID_PHONE%');
select pg_temp.err_like('L2 choosing AND creating at once is refused', format($q$select public.finance_link_customer('test-device-2', 'C-LOCAL-9', 'X', 'Y', %L::uuid, '{"name": "Y"}')$q$, pg_temp.c('C1')), '%CHOOSE_ONE%');
select pg_temp.chk('L3 search by part of the phone finds the customer', (select bool_or(x ->> 'id' = pg_temp.c('C1')) from jsonb_array_elements(public.finance_customer_search('2345678')) x));
select pg_temp.chk('L3 search by name finds the customer', (select bool_or(x ->> 'id' = pg_temp.c('C1')) from jsonb_array_elements(public.finance_customer_search('somchai')) x));
select pg_temp.chk('L3 search by the phone of an app account finds that customer',
  (select p.phone is null or exists (select 1 from jsonb_array_elements(public.finance_customer_search(p.phone)) x where x ->> 'id' = pg_temp.c('CA'))
     from public.profiles p where p.id = pg_temp.c('A')::uuid));
select pg_temp.chk('L3 one letter searches nothing', jsonb_array_length(public.finance_customer_search('s')) = 0);
-- the second device links its own local id for the same person to the existing customer
select public.finance_link_customer('test-device-2', 'C-OTHER-ID', 'CUS-077', 'Somchai T.', pg_temp.c('C1')::uuid);
select pg_temp.chk('L4 links_for gives each device its own mapping to the same customer',
  (public.finance_customer_links_for('test-device-1', array['C-LOCAL-1', 'nope']) -> 'C-LOCAL-1' ->> 'id') = pg_temp.c('C1')
  and (public.finance_customer_links_for('test-device-2', array['C-OTHER-ID']) -> 'C-OTHER-ID' ->> 'id') = pg_temp.c('C1')
  and public.finance_customer_links_for('test-device-1', array['C-OTHER-ID']) = '{}'::jsonb);
-- relink device 1's customer to the app customer and back: logged, still one link row
select public.finance_link_customer('test-device-1', 'C-LOCAL-1', 'CUS-001', 'Somchai Test', pg_temp.c('CA')::uuid);
select public.finance_link_customer('test-device-1', 'C-LOCAL-1', 'CUS-001', 'Somchai Test', pg_temp.c('C1')::uuid);
reset role;
select pg_temp.chk('L4 a relink keeps one row per device and local customer and is logged',
  (select count(*) from public.finance_customer_links where device_id = 'test-device-1' and local_customer_id = 'C-LOCAL-1') = 1
  and (select count(*) from public.finance_events where action = 'customer.relink' and detail ->> 'device' = 'test-device-1') = 2);
select pg_temp.err_like('L5 a link cannot be deleted', $q$delete from public.finance_customer_links where device_id = 'test-device-1'$q$, '%never deleted%');
select pg_temp.err_like('L5 a link cannot move to another device', $q$update public.finance_customer_links set device_id = 'test-device-x' where device_id = 'test-device-1'$q$, '%cannot be changed%');
select pg_temp.chk('L5 the link table has RLS and no client grants',
  (select relrowsecurity from pg_class where oid = 'public.finance_customer_links'::regclass)
  and not exists (select 1 from information_schema.role_table_grants where table_name = 'finance_customer_links' and grantee in ('anon', 'authenticated')));

-- ------------------------------------------------------------------------------------------------ store credit sale -> central invoice
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.put('I1', public.finance_issue_order_invoice(pg_temp.c('C1')::uuid, 'test-device-1', 'O-1001', 'POS-0001', 1000, current_date - 1, current_date + 30)::text);
select pg_temp.put('INV1', pg_temp.c('I1')::jsonb -> 'invoice' ->> 'id');
select pg_temp.chk('I1 the invoice bills the store order: source, order number, amount, not a replay',
  (pg_temp.c('I1')::jsonb ->> 'replay')::boolean = false and (pg_temp.c('I1')::jsonb -> 'invoice' ->> 'source_device') = 'test-device-1'
  and (pg_temp.c('I1')::jsonb -> 'invoice' ->> 'source_ref') = 'POS-0001' and (pg_temp.c('I1')::jsonb -> 'invoice' ->> 'amount')::numeric = 1000, pg_temp.c('I1'));
select pg_temp.chk('I2 the same order again returns the same invoice (replay)',
  (select (r ->> 'replay')::boolean and r -> 'invoice' ->> 'id' = pg_temp.c('INV1') from (select public.finance_issue_order_invoice(pg_temp.c('C1')::uuid, 'test-device-1', 'O-1001', 'POS-0001', 1000, current_date - 1, current_date + 30) r) q));
select pg_temp.err_like('I3 the same order with another amount is refused', format('select public.finance_issue_order_invoice(%L::uuid, %L, %L, %L, 999)', pg_temp.c('C1'), 'test-device-1', 'O-1001', 'POS-0001'), '%ORDER_ALREADY_INVOICED%');
select pg_temp.err_like('I3 the same order for another customer is refused', format('select public.finance_issue_order_invoice(%L::uuid, %L, %L, %L, 1000)', pg_temp.c('CA'), 'test-device-1', 'O-1001', 'POS-0001'), '%ORDER_ALREADY_INVOICED%');
select pg_temp.put('INV2', public.finance_issue_order_invoice(pg_temp.c('C1')::uuid, 'test-device-2', 'O-1001', 'POS-0001', 500, current_date, current_date + 7) -> 'invoice' ->> 'id');
select pg_temp.chk('I4 the same local order id on ANOTHER device is another invoice', pg_temp.c('INV2') is not null and pg_temp.c('INV2') <> pg_temp.c('INV1'));
select pg_temp.put('C9', public.finance_link_customer('test-device-9', 'C-9', 'C9', 'Cancel Test', null, '{"name": "Cancel Test"}') ->> 'id');
select pg_temp.put('INV9', public.finance_issue_order_invoice(pg_temp.c('C9')::uuid, 'test-device-9', 'O-9', 'POS-9', 75) -> 'invoice' ->> 'id');
select public.finance_cancel_invoice(pg_temp.c('INV9')::uuid, 'wrong amount (test)');
select pg_temp.chk('I4 after a manager cancels the invoice, the same order can be billed again (new invoice)',
  (select r -> 'invoice' ->> 'id' <> pg_temp.c('INV9') and not (r ->> 'replay')::boolean from (select public.finance_issue_order_invoice(pg_temp.c('C9')::uuid, 'test-device-9', 'O-9', 'POS-9', 70) r) q));
select pg_temp.err_like('I4 a due date before the issue date is refused', format('select public.finance_issue_order_invoice(%L::uuid, %L, %L, %L, 10, current_date, current_date - 1)', pg_temp.c('C1'), 'test-device-1', 'O-2', 'POS-2'), '%INVALID_DUE_DATE%');
reset role;
select pg_temp.chk('I5 the invoice is in the accountant''s ledger queue (receivable / sales)',
  exists (select 1 from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = pg_temp.c('INV1')::uuid and amount = 1000));
select pg_temp.err_like('I6 the store order of an invoice cannot be changed', format('update public.finance_invoices set source_order_id = %L where id = %L', 'O-9', pg_temp.c('INV1')), '%cannot be changed%');
set local role authenticated; select pg_temp.as_user(pg_temp.c('U')::uuid);
select pg_temp.err_like('I7 a user without a finance role cannot issue', format('select public.finance_issue_order_invoice(%L::uuid, %L, %L, %L, 10)', pg_temp.c('C1'), 'test-device-1', 'O-3', 'POS-3'), '%not allowed%');
select pg_temp.err_like('I7 a user without a finance role cannot link', $q$select public.finance_link_customer('test-device-1', 'C-LOCAL-5', 'X', 'Y', null, '{"name": "Y"}')$q$, '%not allowed%');
select pg_temp.err_like('I7 a user without a finance role cannot search', $q$select public.finance_customer_search('somchai')$q$, '%not allowed%');
reset role;
select pg_temp.chk('I7 anon can run none of the new functions',
  not has_function_privilege('anon', 'public.finance_issue_order_invoice(uuid, text, text, text, numeric, date, date, text)', 'execute')
  and not has_function_privilege('anon', 'public.finance_receive_payment(uuid, text, numeric, timestamptz, text, uuid, text, jsonb, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.finance_link_customer(text, text, text, text, uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.finance_customer_search(text, integer)', 'execute'));

-- ------------------------------------------------------------------------------------------------ open invoices and one payment over several invoices
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.put('OPEN', public.finance_customer_open_invoices(pg_temp.c('C1')::uuid)::text);
select pg_temp.chk('O1 the customer''s open invoices from both devices, marked store, owing 1500',
  jsonb_array_length(pg_temp.c('OPEN')::jsonb -> 'invoices') = 2 and (select bool_and(x ->> 'origin' = 'store') from jsonb_array_elements(pg_temp.c('OPEN')::jsonb -> 'invoices') x)
  and (pg_temp.c('OPEN')::jsonb -> 'customer' ->> 'outstanding')::numeric = 1500, pg_temp.c('OPEN'));
select pg_temp.put('R1', public.finance_receive_payment(pg_temp.c('C1')::uuid, 'transfer', 1200, now(), 'TESTCRREF0001', null, 'one transfer for two bills',
  jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV1'), 'amount', 1000), jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 200)), 'test-cr-key-0001', true)::text);
select pg_temp.chk('R1 one transfer over two invoices: two parts, both posted, 300 left', jsonb_array_length(pg_temp.c('R1')::jsonb -> 'parts') = 2
  and jsonb_array_length(pg_temp.c('R1')::jsonb -> 'posted') = 2 and (pg_temp.c('R1')::jsonb -> 'owing' ->> 'outstanding')::numeric = 300, pg_temp.c('R1'));
select pg_temp.chk('R1 invoice 1 is paid, invoice 2 owes 300',
  (public.finance_invoice_state_raw(pg_temp.c('INV1')::uuid) ->> 'outstanding')::numeric = 0 and (public.finance_invoice_state_raw(pg_temp.c('INV2')::uuid) ->> 'outstanding')::numeric = 300);
reset role;
select pg_temp.chk('R1 the bank reference stays on the first part, the second is marked part 2 of 2',
  (select string_agg(bank_trans_ref, ' | ' order by bank_trans_ref) from public.finance_receipts where invoice_id in (pg_temp.c('INV1')::uuid, pg_temp.c('INV2')::uuid)) = 'TESTCRREF0001 | TESTCRREF0001 (part 2 of 2)',
  (select string_agg(bank_trans_ref, ' | ' order by bank_trans_ref) from public.finance_receipts where invoice_id in (pg_temp.c('INV1')::uuid, pg_temp.c('INV2')::uuid)));
select pg_temp.chk('R1 the payments are in the accountant''s ledger queue', (select count(*) from public.finance_gl_queue g join public.finance_receipts r on r.id = g.ref_id
  where g.event_type = 'BANK_RECEIPT' and r.invoice_id in (pg_temp.c('INV1')::uuid, pg_temp.c('INV2')::uuid)) = 2);
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('R2 the same request again changes nothing (replay)',
  (select (r ->> 'replay')::boolean from (select public.finance_receive_payment(pg_temp.c('C1')::uuid, 'transfer', 1200, now(), 'TESTCRREF0001', null, 'one transfer for two bills',
     jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV1'), 'amount', 1000), jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 200)), 'test-cr-key-0001', true) r) q)
  and (select count(*) from public.finance_receipts where invoice_id in (pg_temp.c('INV1')::uuid, pg_temp.c('INV2')::uuid)) = 2);
select pg_temp.err_like('R3 parts that do not add up to the payment are refused',
  format('select public.finance_receive_payment(%L::uuid, %L, 300, now(), null, null, %L, %L::jsonb, %L)', pg_temp.c('C1'), 'cash', 'at the counter', jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 200)), 'test-cr-key-0002'), '%ALLOCATION_MISMATCH%');
select pg_temp.put('INV3', public.finance_issue_order_invoice(pg_temp.c('CA')::uuid, 'test-device-1', 'O-1002', 'POS-0002', 250, current_date, current_date + 7) -> 'invoice' ->> 'id');
select pg_temp.err_like('R4 another customer''s invoice in the payment is refused',
  format('select public.finance_receive_payment(%L::uuid, %L, 250, now(), null, null, %L, %L::jsonb, %L)', pg_temp.c('C1'), 'cash', 'at the counter', jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV3'), 'amount', 250)), 'test-cr-key-0003'), '%CUSTOMER_MISMATCH%');
select pg_temp.err_like('R5 more than the invoice still owes is refused',
  format('select public.finance_receive_payment(%L::uuid, %L, 400, now(), null, null, %L, %L::jsonb, %L)', pg_temp.c('C1'), 'cash', 'at the counter', jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 400)), 'test-cr-key-0004'), '%EXCEEDS_OUTSTANDING%');
select pg_temp.err_like('R5 an invoice twice in one payment is refused',
  format('select public.finance_receive_payment(%L::uuid, %L, 20, now(), null, null, %L, %L::jsonb, %L)', pg_temp.c('C1'), 'cash', 'at the counter',
    jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 10), jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 10)), 'test-cr-key-0005'), '%DUPLICATE_INVOICE%');
select pg_temp.err_like('R7 the same bank reference in a new payment is refused',
  format('select public.finance_receive_payment(%L::uuid, %L, 100, now(), %L, null, null, %L::jsonb, %L)', pg_temp.c('C1'), 'transfer', 'TESTCRREF0001', jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 100)), 'test-cr-key-0006'), '%already recorded%');
select pg_temp.err_like('R7 a key that is too short is refused',
  format('select public.finance_receive_payment(%L::uuid, %L, 100, now(), null, null, %L, %L::jsonb, %L)', pg_temp.c('C1'), 'cash', 'counter', jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 100)), 'short'), '%INVALID_KEY%');
-- the rest in cash, recorded and NOT posted: pending until the end-of-day post
select pg_temp.put('R6', public.finance_receive_payment(pg_temp.c('C1')::uuid, 'cash', 300, now(), null, null, 'Cash at the counter',
  jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV2'), 'amount', 300)), 'test-cr-key-0007', false)::text);
select pg_temp.chk('R6 a cash part not posted yet: confirmed 300 pending, still owing 300, nothing more can be added',
  (pg_temp.c('R6')::jsonb -> 'owing' ->> 'confirmed_pending')::numeric = 300 and (pg_temp.c('R6')::jsonb -> 'owing' ->> 'outstanding')::numeric = 300
  and (select (x ->> 'available')::numeric = 0 from jsonb_array_elements(public.finance_customer_open_invoices(pg_temp.c('C1')::uuid) -> 'invoices') x where x ->> 'id' = pg_temp.c('INV2')), pg_temp.c('R6'));
select public.finance_post_evidence((pg_temp.c('R6')::jsonb -> 'parts' -> 0 ->> 'evidence_id')::uuid, 'end of day');
select pg_temp.chk('R6 after the end-of-day post the customer owes nothing and has no open invoice',
  jsonb_array_length(public.finance_customer_open_invoices(pg_temp.c('C1')::uuid) -> 'invoices') = 0);
select pg_temp.put('ST', public.finance_store_invoice_states('test-device-1', null)::text);
select pg_temp.chk('S1 the device sees what its orders still owe centrally (O-1001 paid, O-1002 owes 250)',
  (select (x ->> 'outstanding')::numeric from jsonb_array_elements(pg_temp.c('ST')::jsonb) x where x ->> 'order_id' = 'O-1001') = 0
  and (select (x ->> 'outstanding')::numeric from jsonb_array_elements(pg_temp.c('ST')::jsonb) x where x ->> 'order_id' = 'O-1002') = 250, pg_temp.c('ST'));
select pg_temp.chk('S1 another device''s orders are not in the list', (select count(*) from jsonb_array_elements(public.finance_store_invoice_states('test-device-2', null)) x) = 1);
select pg_temp.chk('S1 the cancelled invoice and its replacement are both listed for the device, one cancelled',
  (select count(*) = 2 and count(*) filter (where x ->> 'status' = 'cancelled') = 1 from jsonb_array_elements(public.finance_store_invoice_states('test-device-9', null)) x));
select pg_temp.chk('P1 the customer''s payment history has the parts and the receipts',
  (public.finance_customer_payment_log(pg_temp.c('C1')::uuid) ->> 'total')::int = 6, public.finance_customer_payment_log(pg_temp.c('C1')::uuid) ->> 'total');
reset role;

-- ------------------------------------------------------------------------------------------------ the customer's view
select pg_temp.err_like('W1 a store invoice cannot be paid from the wallet (even by a direct write)',
  format('insert into public.finance_receipts (receipt_no, customer_id, invoice_id, wallet_txn_id, amount, method, received_at) values (%L, %L, %L, gen_random_uuid(), 10, %L, now())',
    'TEST-CR-W1', pg_temp.c('CA'), pg_temp.c('INV3'), 'wallet'), '%STORE_INVOICE_NO_WALLET%');
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('A1 the customer sees the store invoice in the app, marked store',
  (select x ->> 'origin' from jsonb_array_elements(public.finance_my_invoices()) x where x ->> 'id' = pg_temp.c('INV3')) = 'store');
select pg_temp.chk('A1 the customer''s other invoices are marked shop', (select bool_and(x ->> 'origin' = 'shop') from jsonb_array_elements(public.finance_my_invoices()) x where x ->> 'id' <> pg_temp.c('INV3')));
select pg_temp.chk('A2 the customer does not see Somchai''s invoices', not exists (select 1 from jsonb_array_elements(public.finance_my_invoices()) x where x ->> 'id' in (pg_temp.c('INV1'), pg_temp.c('INV2'))));
select pg_temp.err_like('A3 a customer cannot record a payment', format('select public.finance_receive_payment(%L::uuid, %L, 10, now(), null, null, %L, %L::jsonb, %L)', pg_temp.c('CA'), 'cash', 'x', jsonb_build_array(jsonb_build_object('invoice', pg_temp.c('INV3'), 'amount', 10)), 'test-cr-key-0009'), '%not allowed%');
select pg_temp.err_like('A3 a customer cannot read the open invoices of anyone', format('select public.finance_customer_open_invoices(%L::uuid)', pg_temp.c('CA')), '%not allowed%');
reset role;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'CENTRAL_RECEIVABLES_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
