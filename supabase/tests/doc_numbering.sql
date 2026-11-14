-- Tests for 20261115500000_document_numbering.sql against REAL data inside one transaction that is rolled back (scripts/run-numbering-sql-tests.sh).
-- The counters are cleared INSIDE this transaction (a fresh system), so the first document of every type must be number 1; the real counters and the
-- real documents are untouched because everything rolls back. Customers A and B are real LINE members, C gets a verifier role, S is a SUPER_ADMIN.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; d text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then
    get stacked diagnostics d = pg_exception_detail; m := sqlerrm || coalesce(' | ' || d, ''); perform pg_temp.chk(p_test, m ilike p_pat, m);
  end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
-- (owner only) where a counter stands
create or replace function pg_temp.last(p_type text, p_period text default '') returns bigint language sql as $$
  select coalesce((select last_seq from public.doc_counters where doc_type = p_type and period_key = p_period), 0) $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'C', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 2 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into public.finance_staff_roles (user_id, role) values (pg_temp.c('C')::uuid, 'verifier');
insert into t_ctx select 'scb', id::text from public.finance_bank_accounts where code = 'SCB';
insert into t_res (test, ok, detail) select 'test users found', (select count(*) from t_ctx where k in ('A', 'B', 'C', 'S', 'scb')) = 5, null;
-- a fresh system: no counters, an open shop, no slip rule (the slip rule has its own tests)
select set_config('finance.counter_reset', 'on', true);
delete from public.doc_counters;
select set_config('finance.counter_reset', 'off', true);
update public.shop_settings set shop_open = true, pickup_enabled = true, delivery_enabled = true, shipping_fee = 0, free_shipping_min = null, require_payment_slip = false;

-- =========================================================================================== N1 the old numbering is gone, the central one is configured
insert into t_res (test, ok, detail) select 'N1 the six old sequences are retired', to_regclass('public.shop_order_seq') is null and to_regclass('public.finance_invoice_seq') is null and to_regclass('public.finance_receipt_seq') is null
  and to_regclass('public.finance_wallet_txn_seq') is null and to_regclass('public.finance_deposit_seq') is null and to_regclass('public.ar_receipt_seq') is null, null;
insert into t_res (test, ok, detail) select 'N1 no function still takes a number from an old sequence', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'
  and pg_get_functiondef(p.oid) ~ 'shop_order_seq|finance_invoice_seq|finance_receipt_seq|finance_wallet_txn_seq|finance_deposit_seq|ar_receipt_seq'), null;
insert into t_res (test, ok, detail) select 'N1 the formats are exactly ORD / INV / PAY / WAL / DEP / AR-RC, six digits, one continuous series each',
  (select string_agg(doc_type || '=' || prefix || ':' || period_mode || ':' || digits, ' ' order by doc_type) from public.doc_number_formats) = 'AR_RECEIPT=AR-RC:none:6 DEPOSIT=DEP:none:6 INVOICE=INV:none:6 ORDER=ORD:none:6 PAYMENT=PAY:none:6 WALLET=WAL:none:6',
  (select string_agg(doc_type || '=' || prefix || ':' || period_mode || ':' || digits, ' ' order by doc_type) from public.doc_number_formats);

-- =========================================================================================== N4 the generator and its formats
select set_config('finance.counter_reset', 'on', true); delete from public.doc_counters; select set_config('finance.counter_reset', 'off', true);
insert into t_res (test, ok, detail) select 'N4 first numbers of a fresh system for every type',
  public.next_doc_no('ORDER') = 'ORD-000001' and public.next_doc_no('INVOICE') = 'INV-000001' and public.next_doc_no('PAYMENT') = 'PAY-000001' and public.next_doc_no('WALLET') = 'WAL-000001'
  and public.next_doc_no('DEPOSIT') = 'DEP-000001' and public.next_doc_no('AR_RECEIPT') = 'AR-RC-000001', null;
insert into t_res (test, ok, detail) select 'N4 each type counts on its own', public.next_doc_no('ORDER') = 'ORD-000002' and public.next_doc_no('ORDER') = 'ORD-000003' and public.next_doc_no('INVOICE') = 'INV-000002', null;
select pg_temp.err_like('N4 an unknown document type is refused', $q$select public.next_doc_no('NOPE')$q$, '%Unknown document type%');
-- periods
update public.doc_number_formats set period_mode = 'year' where doc_type = 'ORDER';
insert into t_res (test, ok, detail) select 'N4 year: a new year starts again at 1', public.next_doc_no('ORDER', date '2026-03-01') = 'ORD-2026-000001' and public.next_doc_no('ORDER', date '2026-12-31') = 'ORD-2026-000002' and public.next_doc_no('ORDER', date '2027-01-01') = 'ORD-2027-000001', null;
update public.doc_number_formats set period_mode = 'month' where doc_type = 'ORDER';
insert into t_res (test, ok, detail) select 'N4 month: a new month starts again at 1', public.next_doc_no('ORDER', date '2026-11-15') = 'ORD-202611-000001' and public.next_doc_no('ORDER', date '2026-11-30') = 'ORD-202611-000002' and public.next_doc_no('ORDER', date '2026-12-01') = 'ORD-202612-000001', null;
update public.doc_number_formats set period_mode = 'fiscal_year' where doc_type = 'ORDER';
insert into t_res (test, ok, detail) select 'N4 fiscal year starting in January is the calendar year', public.next_doc_no('ORDER', date '2026-06-01') = 'ORD-FY2026-000001', null;
update public.doc_number_settings set fiscal_year_start_month = 10;
insert into t_res (test, ok, detail) select 'N4 fiscal year starting in October: 30 Sep belongs to FY2026, 1 Oct starts FY2027 (named after the year it ends)',
  public.next_doc_no('ORDER', date '2026-09-30') = 'ORD-FY2026-000002' and public.next_doc_no('ORDER', date '2026-10-01') = 'ORD-FY2027-000001' and public.next_doc_no('ORDER', date '2027-03-01') = 'ORD-FY2027-000002', null;
update public.doc_number_settings set fiscal_year_start_month = 1;
update public.doc_number_formats set period_mode = 'none', digits = 3 where doc_type = 'DEPOSIT';
insert into t_res (test, ok, detail) select 'N4 digits are configurable, and a number longer than the width is never cut off',
  (select string_agg(public.next_doc_no('DEPOSIT'), ' ') from generate_series(1, 3)) = 'DEP-002 DEP-003 DEP-004', null;
select set_config('finance.counter_reset', 'on', true);                                           -- a deliberate reset (the only way a counter can jump)
update public.doc_counters set last_seq = 998 where doc_type = 'DEPOSIT';
select set_config('finance.counter_reset', 'off', true);
insert into t_res (test, ok, detail) select 'N4 past the width: DEP-999 then DEP-1000, not DEP-100', public.next_doc_no('DEPOSIT') = 'DEP-999' and public.next_doc_no('DEPOSIT') = 'DEP-1000', null;
update public.doc_number_formats set digits = 6 where doc_type = 'DEPOSIT';
-- back to the default formats and a clean slate before documents are created
update public.doc_number_formats set period_mode = 'none', digits = 6 where doc_type in ('ORDER', 'DEPOSIT');
update public.doc_number_settings set fiscal_year_start_month = 1;
select set_config('finance.counter_reset', 'on', true); delete from public.doc_counters; select set_config('finance.counter_reset', 'off', true);

-- =========================================================================================== N2 every document takes its number from it, starting at 1
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o1', public.shop_place_order('num-order-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '0812345678', null, null)::text;
insert into t_ctx select 'o2', public.shop_place_order('num-order-0002', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null)::text;
insert into t_res (test, ok, detail) select 'N2 the FIRST order of a fresh system is ORD-000001 and its invoice INV-000001', (v::jsonb) -> 'order' ->> 'order_no' = 'ORD-000001' and (v::jsonb) -> 'order' -> 'invoice' ->> 'invoice_no' = 'INV-000001', left(v, 160) from t_ctx where k = 'o1';
insert into t_res (test, ok, detail) select 'N2 the second order is ORD-000002 / INV-000002 (no gap, no repeat)', (v::jsonb) -> 'order' ->> 'order_no' = 'ORD-000002' and (v::jsonb) -> 'order' -> 'invoice' ->> 'invoice_no' = 'INV-000002', null from t_ctx where k = 'o2';
insert into t_ctx select 'i1', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o1';
insert into t_ctx select 'i2', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o2';
reset role;
insert into t_ctx select 'fcA', id::text from public.finance_customers where profile_id = pg_temp.c('A')::uuid;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'N2 an invoice issued by staff shares the invoice series: INV-000003',
  (public.finance_create_invoice(pg_temp.c('fcA')::uuid, 100, null, null, 'manual invoice', null)).invoice_no = 'INV-000003', null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'ev1', public.finance_submit_evidence(pg_temp.c('i1')::uuid, pg_temp.c('A') || '/slip-n1.png', repeat('1', 64), 'image/png', 640, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'N2 the first customer payment is PAY-000001', public.finance_verify_evidence(pg_temp.c('ev1')::uuid, 640, 'NUM-BANKREF-1', now(), null, 'staff') ->> 'receipt_no' = 'PAY-000001', null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'dep1', public.finance_deposit_create(pg_temp.c('scb')::uuid, 1000, 'num-dep-00001')::text;
insert into t_res (test, ok, detail) select 'N2 the first wallet deposit is DEP-000001', (v::jsonb) ->> 'deposit_no' = 'DEP-000001', v from t_ctx where k = 'dep1';
insert into t_ctx select 'dep1id', (v::jsonb) ->> 'id' from t_ctx where k = 'dep1';
select public.finance_deposit_submit_slip(pg_temp.c('dep1id')::uuid, pg_temp.c('A') || '/slip-d1.png', repeat('2', 64), 'image/png', now());
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'N2 the first wallet transaction is WAL-000001', public.finance_deposit_verify(pg_temp.c('dep1id')::uuid, 1000, 'NUM-BANKREF-2', now()) ->> 'txn_no' = 'WAL-000001', null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'wp', public.finance_pay_invoice_with_wallet(pg_temp.c('i2')::uuid, 100, 'num-wpay-0001')::text;
reset role;
insert into t_res (test, ok, detail) select 'N2 paying from the wallet takes PAY-000002 and WAL-000002 (fixed lock order: payment, wallet row, wallet number)',
  (v::jsonb) ->> 'receipt_no' = 'PAY-000002' and (select txn_no from public.finance_wallet_transactions where txn_type = 'INVOICE_PAYMENT') = 'WAL-000002', v from t_ctx where k = 'wp';
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
-- an overpayment takes a payment number and a wallet number in the same transaction
insert into t_ctx select 'o3', public.shop_place_order('num-order-0003', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null)::text;
insert into t_ctx select 'i3', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o3';
insert into t_ctx select 'ev3', public.finance_submit_evidence(pg_temp.c('i3')::uuid, pg_temp.c('A') || '/slip-n3.png', repeat('3', 64), 'image/png', 400, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'ov3', public.finance_verify_evidence(pg_temp.c('ev3')::uuid, 400, 'NUM-BANKREF-3', now(), null, 'staff')::text;
insert into t_res (test, ok, detail) select 'N2 an overpayment: receipt PAY-000003 and wallet credit WAL-000003',
  (v::jsonb) ->> 'receipt_no' = 'PAY-000003' and (select txn_no from public.finance_wallet_transactions where ref_no = 'PAY-000003') = 'WAL-000003', left(v, 120) from t_ctx where k = 'ov3';
reset role;
insert into t_res (test, ok, detail) select 'N2 the counters stand exactly at the number of documents issued', pg_temp.last('ORDER') = 3 and pg_temp.last('INVOICE') = 4 and pg_temp.last('PAYMENT') = 3 and pg_temp.last('WALLET') = 3 and pg_temp.last('DEPOSIT') = 1,
  format('order %s invoice %s payment %s wallet %s deposit %s', pg_temp.last('ORDER'), pg_temp.last('INVOICE'), pg_temp.last('PAYMENT'), pg_temp.last('WALLET'), pg_temp.last('DEPOSIT'));

-- =========================================================================================== N3 a failed transaction does not use up a number
update public.shop_settings set require_payment_slip = true;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('N3 a refused checkout (no slip) fails', $q$select public.shop_place_order('num-fail-0001', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Malee', '0891112222', null, null, null, 'bank:SCB')$q$, '%SLIP_REQUIRED%');
select pg_temp.err_like('N3 a refused slip (someone else''s folder) fails after the order number was taken', format($q$select public.shop_place_order('num-fail-0002', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Malee', '0891112222', null, null, null, 'bank:SCB', %L, repeat('4', 64), 'image/png', now(), null)$q$, pg_temp.c('A') || '/slip.png'), '%Invalid file%');
reset role;
insert into t_res (test, ok, detail) select 'N3 neither failure consumed an order or invoice number', pg_temp.last('ORDER') = 3 and pg_temp.last('INVOICE') = 4, format('order %s invoice %s', pg_temp.last('ORDER'), pg_temp.last('INVOICE'));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'N3 the next real order is ORD-000004 / INV-000005: no gap left by the failures',
  public.shop_place_order('num-ok-00001', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Malee', '0891112222', null, null, null, 'bank:SCB', pg_temp.c('B') || '/orders/num-ok-00001.png', repeat('5', 64), 'image/png', now(), null) -> 'order' ->> 'order_no' = 'ORD-000004', null;
reset role;
-- a rolled-back savepoint gives its number back too
do $$ begin
  begin perform public.next_doc_no('WALLET'); raise exception 'undo'; exception when others then null; end;
end $$;
insert into t_res (test, ok, detail) select 'N3 a number taken and rolled back is given back (WALLET counter unchanged)', pg_temp.last('WALLET') = 3, null;

-- =========================================================================================== N5 counters can only move forward; clients cannot touch anything
select pg_temp.err_like('N5 a counter cannot be lowered', $q$update public.doc_counters set last_seq = 0 where doc_type = 'INVOICE'$q$, '%only moves forward by one%');
select pg_temp.err_like('N5 a counter cannot jump', $q$update public.doc_counters set last_seq = last_seq + 5 where doc_type = 'INVOICE'$q$, '%only moves forward by one%');
select pg_temp.err_like('N5 a counter cannot be deleted', $q$delete from public.doc_counters where doc_type = 'INVOICE'$q$, '%never deleted%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('N5 a customer cannot take a number', $q$select public.next_doc_no('ORDER')$q$, '%permission denied%');
select pg_temp.err_like('N5 a customer cannot write a counter', $q$update public.doc_counters set last_seq = 0$q$, '%permission denied%');
select pg_temp.err_like('N5 a customer cannot change a format', $q$update public.doc_number_formats set prefix = 'X'$q$, '%permission denied%');
select pg_temp.err_like('N5 a customer cannot read the numbering overview', $q$select public.doc_numbering_overview()$q$, '%not allowed%');
insert into t_res (test, ok, detail) select 'N5 a customer sees no counter rows', (select count(*) from public.doc_counters) = 0, null;
reset role; set local role anon;
select pg_temp.err_like('N5 anonymous visitors cannot read the formats', $q$select count(*) from public.doc_number_formats$q$, '%permission denied%');

-- =========================================================================================== N6 staff: overview, and changing a format
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);                 -- a verifier
insert into t_res (test, ok, detail) select 'N6 a verifier sees the formats and counters', jsonb_array_length(public.doc_numbering_overview() -> 'formats') = 6, null;
select pg_temp.err_like('N6 a verifier cannot change a format', $q$select public.finance_save_doc_format('ORDER', 'SO', 'none', 6)$q$, '%not allowed%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);                 -- a finance manager
select pg_temp.err_like('N6 a prefix must be letters, digits and single hyphens', $q$select public.finance_save_doc_format('ORDER', 'a b', 'none', 6)$q$, '%prefix is letters%');
select pg_temp.err_like('N6 two types cannot share a prefix', $q$select public.finance_save_doc_format('ORDER', 'INV', 'none', 6)$q$, '%already uses the prefix%');
select pg_temp.err_like('N6 the period must be a known rule', $q$select public.finance_save_doc_format('ORDER', 'ORD', 'weekly', 6)$q$, '%period must be%');
select pg_temp.err_like('N6 the digits must be 3 to 12', $q$select public.finance_save_doc_format('ORDER', 'ORD', 'none', 2)$q$, '%digits must be%');
select pg_temp.err_like('N6 an unknown type is refused', $q$select public.finance_save_doc_format('NOPE', 'NOPE', 'none', 6)$q$, '%Unknown document type%');
insert into t_ctx select 'ov', public.finance_save_doc_format('ORDER', 'SALE', 'year', 5)::text;
reset role;
insert into t_res (test, ok, detail) select 'N6 a manager changes a format; it applies to the NEXT document only', public.next_doc_no('ORDER', date '2026-05-05') = 'SALE-2026-00001', null;
insert into t_res (test, ok, detail) select 'N6 the change is written to the audit log', exists (select 1 from public.finance_events where entity = 'numbering' and action = 'numbering.format' and detail ->> 'prefix' = 'SALE'), null;

-- =========================================================================================== N7 uniqueness, and what already exists is untouched
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
do $$ begin for i in 1..60 loop perform public.finance_create_invoice((select id from public.finance_customers where profile_id = (select v from t_ctx where k = 'A')::uuid), 10 + i, null, null, 'bulk ' || i, null); end loop; end $$;
reset role;
insert into t_res (test, ok, detail) select 'N7 60 invoices in a row: all numbers unique and consecutive', (select count(distinct invoice_no) from public.finance_invoices where description like 'bulk %') = 60
  and (select max(substring(invoice_no from '[0-9]+$')::int) - min(substring(invoice_no from '[0-9]+$')::int) from public.finance_invoices where description like 'bulk %') = 59, null;
insert into t_res (test, ok, detail) select 'N7 every order, invoice, receipt and wallet number in the database is unique',
  (select count(*) = count(distinct order_no) from public.shop_orders) and (select count(*) = count(distinct invoice_no) from public.finance_invoices)
  and (select count(*) = count(distinct receipt_no) from public.finance_receipts) and (select count(*) = count(distinct txn_no) from public.finance_wallet_transactions), null;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'NUMBERING_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
