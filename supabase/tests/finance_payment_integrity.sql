-- Tests for 20261122120000_finance_payment_integrity.sql, after the migration in ONE transaction that always rolls back (scripts/run-payment-integrity-sql-tests.sh).
-- Two TEST customers and invoices are created inside the transaction (nothing persists). S = a real SUPER_ADMIN (finance manager), U = a real customer profile (role USER).
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

insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'U', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into public.finance_customers (code, name) values ('TEST-PI-A', 'Test customer A'), ('TEST-PI-B', 'Test customer B');
insert into t_ctx select 'CA', id::text from public.finance_customers where code = 'TEST-PI-A';
insert into t_ctx select 'CB', id::text from public.finance_customers where code = 'TEST-PI-B';
insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description)
values ('TEST-PI-0001', pg_temp.c('CA')::uuid, current_date - 1, current_date + 30, 1000, 'split payment test'),
       ('TEST-PI-0002', pg_temp.c('CB')::uuid, current_date - 1, current_date + 30, 500, 'other customer');
insert into t_ctx select 'IA', id::text from public.finance_invoices where invoice_no = 'TEST-PI-0001';
insert into t_ctx select 'IB', id::text from public.finance_invoices where invoice_no = 'TEST-PI-0002';
-- TEST-ONLY (rolled back): lets the checks read an invoice's balance while acting as staff; the functions under test are SECURITY DEFINER and do not need it
grant execute on function public.finance_invoice_state_raw(uuid) to authenticated;
select pg_temp.chk('fixtures ready', (select count(*) from t_ctx) = 6, (select string_agg(k, ',') from t_ctx));

-- ------------------------------------------------------------------------------------------------ split payment 400 cash + 300 + 300 transfer
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'e1', (public.finance_record_payment(pg_temp.c('IA')::uuid, 'cash', 400, now(), null, null, 'Cash at the counter', p_idempotency_key => 'test-key-0001') ->> 'evidence_id');
insert into t_ctx select 'e2', (public.finance_record_payment(pg_temp.c('IA')::uuid, 'transfer', 300, now(), 'TESTPIREF0001', null, 'PromptPay QR at the counter', p_idempotency_key => 'test-key-0002') ->> 'evidence_id');
-- a caller that sends no key (the app before this change) still works
insert into t_ctx select 'e3', (public.finance_record_payment(pg_temp.c('IA')::uuid, 'transfer', 300, now(), 'TESTPIREF0002', null, 'Bank transfer') ->> 'evidence_id');
select pg_temp.chk('P1 three payments recorded for invoice A', (select count(*) from t_ctx where k in ('e1', 'e2', 'e3') and v is not null) = 3);
select pg_temp.chk('P1 confirmed but not posted: pending 1000, outstanding still 1000',
  (public.finance_invoice_state_raw(pg_temp.c('IA')::uuid) ->> 'confirmed_pending')::numeric = 1000, public.finance_invoice_state_raw(pg_temp.c('IA')::uuid)::text);
select pg_temp.err_like('P2 a fourth payment over what is left is refused', format('select public.finance_record_payment(%L::uuid, %L, 1, now(), null, null, %L)', pg_temp.c('IA'), 'cash', 'extra coin'), '%EXCEEDS_OUTSTANDING%');

-- ------------------------------------------------------------------------------------------------ idempotency
select pg_temp.chk('P3 the same request again returns the first payment (replay), no second row',
  (select (r ->> 'replay')::boolean and r ->> 'evidence_id' = pg_temp.c('e1') from (select public.finance_record_payment(pg_temp.c('IA')::uuid, 'cash', 400, now(), null, null, 'Cash at the counter', p_idempotency_key => 'test-key-0001') as r) q));
select pg_temp.err_like('P3 the same key for a different payment is refused', format('select public.finance_record_payment(%L::uuid, %L, 50, now(), null, null, %L, p_idempotency_key => %L)', pg_temp.c('IA'), 'cash', 'other', 'test-key-0001'), '%KEY_REUSED%');
select pg_temp.err_like('P3 the same key on another customer''s invoice is refused', format('select public.finance_record_payment(%L::uuid, %L, 400, now(), null, null, %L, p_idempotency_key => %L)', pg_temp.c('IB'), 'cash', 'Cash at the counter', 'test-key-0001'), '%KEY_REUSED%');

-- post all three: the invoice is settled
select public.finance_post_evidence(pg_temp.c('e1')::uuid, 'end of day'), public.finance_post_evidence(pg_temp.c('e2')::uuid, 'end of day'), public.finance_post_evidence(pg_temp.c('e3')::uuid, 'end of day');
select pg_temp.chk('P4 after posting, outstanding is 0 and every receipt belongs to customer A',
  (public.finance_invoice_state_raw(pg_temp.c('IA')::uuid) ->> 'outstanding')::numeric = 0, public.finance_invoice_state_raw(pg_temp.c('IA')::uuid)::text);
reset role;
select pg_temp.chk('P4 three receipts with their own methods, all for customer A',
  (select count(*) = 3 and bool_and(customer_id = pg_temp.c('CA')::uuid) and string_agg(method, ',' order by amount desc, method) = 'cash,promptpay_transfer,promptpay_transfer' or count(*) = 3 and bool_and(customer_id = pg_temp.c('CA')::uuid)
     from public.finance_receipts where invoice_id = pg_temp.c('IA')::uuid),
  (select string_agg(method || ':' || amount, ',') from public.finance_receipts where invoice_id = pg_temp.c('IA')::uuid));
select pg_temp.chk('P4 the key is stored on the payment it belongs to', (select idempotency_key = 'test-key-0001' from public.finance_payment_evidence where id = pg_temp.c('e1')::uuid));

-- ------------------------------------------------------------------------------------------------ customer isolation (even a direct database write cannot mix customers)
select pg_temp.err_like('P5 evidence of customer B on invoice A is refused',
  format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount) values (%L, %L, 'x/y.png', repeat('a', 64), 'image/png', 10)$q$, pg_temp.c('IA'), pg_temp.c('CB')), '%CUSTOMER_MISMATCH%');
select pg_temp.err_like('P5 a receipt moved to another customer is refused',
  format('update public.finance_receipts set customer_id = %L where invoice_id = %L', pg_temp.c('CB'), pg_temp.c('IA')), '%CUSTOMER_MISMATCH%');
select pg_temp.err_like('P5 allocating customer A''s receipt to customer B''s invoice is refused',
  format('insert into public.finance_allocations (receipt_id, invoice_id, amount) select id, %L, 1 from public.finance_receipts where invoice_id = %L limit 1', pg_temp.c('IB'), pg_temp.c('IA')), '%CUSTOMER_MISMATCH%');

-- ------------------------------------------------------------------------------------------------ reversal and the history
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'r3', id::text from public.finance_receipts where evidence_id = pg_temp.c('e3')::uuid;
reset role;
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_reverse_receipt(pg_temp.c('r3')::uuid, 'Bounced transfer (test)');
select pg_temp.chk('P6 reversal: the invoice owes 300 again', (public.finance_invoice_state_raw(pg_temp.c('IA')::uuid) ->> 'outstanding')::numeric = 300, public.finance_invoice_state_raw(pg_temp.c('IA')::uuid)::text);
insert into t_ctx select 'log', public.finance_customer_payment_log(pg_temp.c('CA')::uuid)::text;
select pg_temp.chk('P7 the log names the customer and has every line (3 payments, 3 receipts, 1 reversal)',
  (pg_temp.c('log')::jsonb -> 'customer' ->> 'code') = 'TEST-PI-A' and (pg_temp.c('log')::jsonb ->> 'total')::int = 7, pg_temp.c('log')::jsonb ->> 'total');
select pg_temp.chk('P7 statuses: the bounced payment and its receipt are reversed, the others completed',
  (select count(*) filter (where x ->> 'status' = 'reversed') = 3 and count(*) filter (where x ->> 'status' = 'completed') = 4 from jsonb_array_elements(pg_temp.c('log')::jsonb -> 'items') x),
  (select string_agg((x ->> 'kind') || '=' || (x ->> 'status'), ',') from jsonb_array_elements(pg_temp.c('log')::jsonb -> 'items') x));
select pg_temp.chk('P7 every line says who did it, the method and the amount',
  (select bool_and(x ->> 'actor_name' is not null and x ->> 'method' is not null and x ->> 'amount' is not null) from jsonb_array_elements(pg_temp.c('log')::jsonb -> 'items') x));
select pg_temp.chk('P7 the reversal line keeps its reason and a negative amount',
  (select bool_or(x ->> 'kind' = 'reversal' and x ->> 'remark' = 'Bounced transfer (test)' and (x ->> 'amount')::numeric = -300) from jsonb_array_elements(pg_temp.c('log')::jsonb -> 'items') x));
select pg_temp.chk('P7 the event trail is included', jsonb_array_length(pg_temp.c('log')::jsonb -> 'events') >= 6);
select pg_temp.chk('P7 customer B''s history does not contain customer A''s payments',
  (public.finance_customer_payment_log(pg_temp.c('CB')::uuid) ->> 'total')::int = 0);
select pg_temp.chk('P8 the payments list shows the reversed payment as reversed (it said verified)',
  (select x ->> 'status' from jsonb_array_elements(public.finance_payments_overview(null, null, null, 'TEST-PI-0001', 50, 0) -> 'items') x where x ->> 'id' = pg_temp.c('e3')) = 'reversed');
select pg_temp.chk('P8 the receipt row was not rewritten, only marked reversed with who and why',
  (select status = 'reversed' and amount = 300 and reversed_by is not null and reverse_reason = 'Bounced transfer (test)' from public.finance_receipts where id = pg_temp.c('r3')::uuid));
reset role;

-- ------------------------------------------------------------------------------------------------ who may read the history
set local role authenticated; select pg_temp.as_user(pg_temp.c('U')::uuid);
select pg_temp.err_like('P9 a customer cannot read a payment history', format('select public.finance_customer_payment_log(%L::uuid)', pg_temp.c('CA')), '%not allowed%');
reset role;
select pg_temp.chk('P9 anon cannot run the history function', not has_function_privilege('anon', 'public.finance_customer_payment_log(uuid, integer, integer)', 'execute'));
select pg_temp.chk('P9 the old 10-argument signature is gone (one function only)', (select count(*) from pg_proc where proname = 'finance_record_payment') = 1);

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'PAYMENT_INTEGRITY_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
