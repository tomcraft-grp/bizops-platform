-- The whole online-ordering journey against REAL data (real catalogue, real profiles, real bank accounts) inside one transaction that is
-- rolled back (scripts/run-ordering-sql-tests.sh). Nothing persists: the last statement raises an exception that carries the result table.
-- Customers A and B are real LINE members, C gets a verifier role, S is a real SUPER_ADMIN (a finance manager).
-- Scenarios: O1 browsing and prices, O2 placing orders (duplicates, tampering), O3 payment and slips, O4 staff verification and accounting,
-- O5 the receivable follows confirmation, O6 overpayment to the wallet, O7 reversal and refund, O8 cancelling, O9 security, O10 integrity.
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
-- (owner only) ledger-queue rows of a document
create or replace function pg_temp.qn(p_ref uuid, p_type text, p_status text default null) returns bigint language sql as $$
  select count(*) from public.finance_gl_queue where ref_id = p_ref and event_type = p_type and (p_status is null or status = p_status) $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'C', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 2 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into public.finance_staff_roles (user_id, role) values (pg_temp.c('C')::uuid, 'verifier');
insert into t_ctx select 'scb', id::text from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'bbl', id::text from public.finance_bank_accounts where code = 'BBL';
insert into t_ctx select 'P1', coalesce(nullif(ecommerce_price, 0), nullif(selling_price, 0), nullif(retail_price, 0))::text from public.sku_registry where sku_code = 'FG-000001';
insert into t_res (test, ok, detail) select 'test users and a priced real SKU found', (select count(*) from t_ctx where k in ('A', 'B', 'C', 'S', 'scb', 'bbl', 'P1')) = 7 and pg_temp.c('P1')::numeric > 0, (select string_agg(k, ',') from t_ctx);
-- the shop is closed in production until staff open it: open it inside this transaction (pickup, so the totals have no shipping)
update public.shop_settings set shop_open = true, pickup_enabled = true, delivery_enabled = true, shipping_fee = 50, free_shipping_min = null;

-- =========================================================================================== O1 browsing and prices
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'O1 the catalogue lists real active products', (public.shop_catalog() ->> 'total')::int > 100, public.shop_catalog() ->> 'total';
insert into t_res (test, ok, detail) select 'O1 the product page shows the database price', (public.shop_product('FG-000001') ->> 'price')::numeric = pg_temp.c('P1')::numeric, public.shop_product('FG-000001') ->> 'price';
insert into t_ctx select 'catalog', (public.shop_catalog(null, null, null, 'recommended', 60, 0) -> 'items')::text;
reset role;                                                                      -- the registry itself is staff-only: compare as the owner
insert into t_res (test, ok, detail) select 'O1 every listed product is active, finished goods and carries the database price',
  jsonb_array_length(pg_temp.c('catalog')::jsonb) > 0
  and not exists (select 1 from jsonb_array_elements(pg_temp.c('catalog')::jsonb) i
              where not exists (select 1 from public.sku_registry s where s.sku_code = i ->> 'sku_code' and s.status = 'active' and s.sku_category = 'FG')
                 or (i ->> 'price')::numeric is distinct from (select coalesce(nullif(s.ecommerce_price, 0), nullif(s.selling_price, 0), nullif(s.retail_price, 0)) from public.sku_registry s where s.sku_code = i ->> 'sku_code')), jsonb_array_length(pg_temp.c('catalog')::jsonb)::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'O1 the quote ignores any price the frontend sends',
  (public.shop_quote('[{"sku_code":"FG-000001","qty":2,"price":1,"unit_price":1,"line_total":2}]', 'pickup') ->> 'total')::numeric = 2 * pg_temp.c('P1')::numeric, public.shop_quote('[{"sku_code":"FG-000001","qty":2,"price":1}]', 'pickup') ->> 'total';
insert into t_res (test, ok, detail) select 'O1 delivery adds the server shipping fee', (public.shop_quote('[{"sku_code":"FG-000001","qty":1}]', 'delivery') ->> 'shipping_fee')::numeric = 50, null;

-- =========================================================================================== O2 placing orders
select pg_temp.err_like('O2 an unknown payment method is refused', $q$select public.shop_place_order('ord-key-bad001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '0812345678', null, null, null, 'cash')$q$, '%INVALID_PAYMENT_METHOD%');
select pg_temp.err_like('O2 a bank that is not configured is refused', $q$select public.shop_place_order('ord-key-bad002', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '0812345678', null, null, null, 'bank:ZZZ')$q$, '%INVALID_PAYMENT_METHOD%');
select pg_temp.err_like('O2 the QR is refused while no PromptPay account is set up', $q$select public.shop_place_order('ord-key-bad003', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '0812345678', null, null, null, 'qr')$q$, '%INVALID_PAYMENT_METHOD%');
select pg_temp.err_like('O2 a tampered expected total is refused, nothing is created', $q$select public.shop_place_order('ord-key-bad004', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '0812345678', null, null, 1, 'bank:SCB')$q$, '%PRICE_CHANGED%');
insert into t_ctx select 'o1', public.shop_place_order('ord-key-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, 'please pack carefully', 2 * pg_temp.c('P1')::numeric, 'bank:SCB')::text;
insert into t_ctx select 'o1id', (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'o1';
insert into t_ctx select 'i1id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o1';
insert into t_res (test, ok, detail) select 'O2 the order is saved with a unique number, status new, the server total and the payment choice',
  (v::jsonb) -> 'order' ->> 'order_no' ~ '^SO-[0-9]{6}-[0-9]{5}$' and (v::jsonb) -> 'order' ->> 'status' = 'new' and ((v::jsonb) -> 'order' ->> 'total')::numeric = 2 * pg_temp.c('P1')::numeric
  and (v::jsonb) -> 'order' ->> 'payment_pref' = 'bank:SCB' and (v::jsonb) -> 'order' ->> 'contact_phone' = '0812345678', left(v, 300) from t_ctx where k = 'o1';
insert into t_res (test, ok, detail) select 'O2 the invoice (payment request) bills exactly the order total and is unpaid',
  ((v::jsonb) -> 'order' -> 'invoice' ->> 'amount')::numeric = 2 * pg_temp.c('P1')::numeric and ((v::jsonb) -> 'order' -> 'invoice' ->> 'status_code')::int = 0 and ((v::jsonb) -> 'order' -> 'invoice' ->> 'paid')::numeric = 0
  and (v::jsonb) -> 'order' -> 'invoice' ->> 'invoice_no' ~ '^INV-[0-9]{6}-[0-9]{5}$', null from t_ctx where k = 'o1';
do $$ begin for i in 1..5 loop perform public.shop_place_order('ord-key-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, 'please pack carefully', null, 'bank:SCB'); end loop; end $$;
insert into t_res (test, ok, detail) select 'O2 FIVE submissions of the same checkout create ONE order', (select count(*) from public.shop_orders where profile_id = pg_temp.c('A')::uuid) = 1, null;
insert into t_res (test, ok, detail) select 'O2 a repeat returns the same order and says it is a replay',
  (public.shop_place_order('ord-key-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, 'please pack carefully', null, 'bank:SCB') ->> 'replay')::boolean
  and public.shop_place_order('ord-key-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, 'please pack carefully', null, 'bank:SCB') -> 'order' ->> 'id' = pg_temp.c('o1id'), null;
select pg_temp.err_like('O2 the same key with another payment method is refused', $q$select public.shop_place_order('ord-key-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, 'please pack carefully', null, 'bank:BBL')$q$, '%KEY_REUSED%');
select pg_temp.err_like('O2 the same key with another cart is refused', $q$select public.shop_place_order('ord-key-0001', '[{"sku_code":"FG-000001","qty":9}]', 'pickup', 'Somchai', '081-234-5678', null, 'please pack carefully', null, 'bank:SCB')$q$, '%KEY_REUSED%');
insert into t_res (test, ok, detail) select 'O2 an order without a payment choice still works (older app builds)',
  public.shop_place_order('ord-key-0002', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null) -> 'order' ->> 'payment_pref' is null, null;
reset role;
insert into t_res (test, ok, detail) select 'O2 NO ACCOUNTING ENTRY exists for an order that was only submitted (nothing queued for either invoice)',
  (select count(*) from public.finance_gl_queue where ref_type = 'invoice' and customer_id = (select id from public.finance_customers where profile_id = pg_temp.c('A')::uuid)) = 0, null;

-- =========================================================================================== O3 payment request and slip
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'O3 the payment screen offers both banks with the exact details and the wallet',
  jsonb_array_length(public.finance_payment_methods() -> 'banks') = 2 and public.finance_payment_methods() -> 'banks' -> 0 ->> 'account_no' = '5194026251' and public.finance_payment_methods() -> 'banks' -> 1 ->> 'account_no' = '9380319542'
  and (public.finance_payment_methods() -> 'wallet' ->> 'balance')::numeric = 0 and not (public.finance_payment_methods() ->> 'promptpay')::boolean, public.finance_payment_methods()::text;
insert into t_res (test, ok, detail) select 'O3 the amount to pay comes from the invoice, not from the customer',
  (select (x ->> 'outstanding')::numeric from jsonb_array_elements(public.finance_my_invoices()) x where x ->> 'id' = pg_temp.c('i1id')) = 2 * pg_temp.c('P1')::numeric, null;
insert into t_ctx select 'ev1', public.finance_submit_evidence(pg_temp.c('i1id')::uuid, pg_temp.c('A') || '/slip-o1a.png', repeat('a', 64), 'image/png', 2 * pg_temp.c('P1')::numeric, now(), 'SCB', 'my ref', pg_temp.c('scb')::uuid)::text;
insert into t_res (test, ok, detail) select 'O3 a slip makes the invoice "pending verification" and NOT paid',
  (select (x ->> 'status_code')::int = 3 and (x ->> 'paid')::numeric = 0 and (x ->> 'outstanding')::numeric = 2 * pg_temp.c('P1')::numeric from jsonb_array_elements(public.finance_my_invoices()) x where x ->> 'id' = pg_temp.c('i1id')), null;
insert into t_res (test, ok, detail) select 'O3 the order is still "new" after a slip', (public.shop_my_order(pg_temp.c('o1id')::uuid) ->> 'status') = 'new', null;
select pg_temp.err_like('O3 the customer cannot verify their own slip', format($q$select public.finance_verify_evidence(%L, 100, 'BANKREF-SELF', now(), null, 'staff')$q$, pg_temp.c('ev1')), '%not allowed%');
select pg_temp.err_like('O3 the customer cannot change the order', $q$update public.shop_orders set total = 1$q$, '%permission denied%');
select pg_temp.err_like('O3 the customer cannot change the invoice', $q$update public.finance_invoices set amount = 1$q$, '%permission denied%');
select pg_temp.err_like('O3 the customer cannot write a receipt', $q$insert into public.finance_receipts (receipt_no, customer_id, invoice_id, amount, bank_trans_ref, received_at) values ('RC-X', gen_random_uuid(), gen_random_uuid(), 1, 'x', now())$q$, '%permission denied%');
select pg_temp.err_like('O3 the customer cannot cancel an order that has a slip waiting', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('o1id')), '%SLIP_PENDING%');

-- =========================================================================================== O4 staff verification and accounting
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);                -- a verifier
insert into t_res (test, ok, detail) select 'O4 a verifier sees the incoming slip with the bank the customer chose', exists (select 1 from public.finance_payment_evidence e where e.id = pg_temp.c('ev1')::uuid and e.status = 'submitted' and e.bank_account_id = pg_temp.c('scb')::uuid), null;
select pg_temp.err_like('O4 a verifier cannot confirm or move an order (staff only)', format($q$select public.shop_admin_set_status(%L, 'confirmed')$q$, pg_temp.c('o1id')), '%not allowed%');
select pg_temp.err_like('O4 the bank transaction reference is required', format($q$select public.finance_verify_evidence(%L, 300, '', now(), null, 'staff')$q$, pg_temp.c('ev1')), '%reference is required%');
insert into t_ctx select 'v1', public.finance_verify_evidence(pg_temp.c('ev1')::uuid, 300, 'SCB-BANKREF-0001', now(), 'bank shows 300', 'staff')::text;
insert into t_res (test, ok, detail) select 'O4 a verified PARTIAL payment: partially paid, the balance is recalculated',
  (v::jsonb) ->> 'result' = 'partially_paid' and ((v::jsonb) -> 'state' ->> 'paid')::numeric = 300 and ((v::jsonb) -> 'state' ->> 'outstanding')::numeric = 2 * pg_temp.c('P1')::numeric - 300 and ((v::jsonb) -> 'state' ->> 'status_code')::int = 4, left(v, 200) from t_ctx where k = 'v1';
select pg_temp.err_like('O4 the same bank reference cannot be recorded twice', format($q$select public.finance_verify_evidence(%L, 100, 'SCB-BANKREF-0001', now(), null, 'staff')$q$, pg_temp.c('ev1')), '%already%');
reset role;
insert into t_ctx select 'rc1', id::text from public.finance_receipts where invoice_id = pg_temp.c('i1id')::uuid and status = 'posted';
insert into t_res (test, ok, detail) select 'O4 the receipt is for the right customer and invoice, on the bank the customer chose, allocated in full',
  (select r.customer_id = (select id from public.finance_customers where profile_id = pg_temp.c('A')::uuid) and r.amount = 300 and r.bank_account_id = pg_temp.c('scb')::uuid and r.method = 'bank_transfer'
          and (select sum(amount) from public.finance_allocations where receipt_id = r.id and invoice_id = pg_temp.c('i1id')::uuid and active) = 300 from public.finance_receipts r where r.id = pg_temp.c('rc1')::uuid), null;
insert into t_res (test, ok, detail) select 'O4 a payment on a not-yet-confirmed order queues the receivable FIRST (once) and the bank receipt depends on it',
  pg_temp.qn(pg_temp.c('i1id')::uuid, 'INVOICE_ISSUE') = 1 and (select depends_on from public.finance_gl_queue where event_type = 'BANK_RECEIPT' and ref_id = pg_temp.c('rc1')::uuid) = (select id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = pg_temp.c('i1id')::uuid), null;
insert into t_res (test, ok, detail) select 'O4 the bank receipt posts Dr that bank / Cr receivable',
  (select plan from public.finance_gl_queue where event_type = 'BANK_RECEIPT' and ref_id = pg_temp.c('rc1')::uuid) = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', 300, 'bank_account_id', pg_temp.c('scb')), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 300)),
  (select plan::text from public.finance_gl_queue where event_type = 'BANK_RECEIPT' and ref_id = pg_temp.c('rc1')::uuid);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'ev2', public.finance_submit_evidence(pg_temp.c('i1id')::uuid, pg_temp.c('A') || '/slip-o1b.png', repeat('b', 64), 'image/png', 2 * pg_temp.c('P1')::numeric - 300, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);                -- a finance manager (SUPER_ADMIN)
insert into t_ctx select 'v2', public.finance_verify_evidence(pg_temp.c('ev2')::uuid, 2 * pg_temp.c('P1')::numeric - 300, 'SCB-BANKREF-0002', now(), null, 'staff')::text;
insert into t_res (test, ok, detail) select 'O4 the second payment settles the invoice: fully paid, nothing outstanding',
  (v::jsonb) ->> 'result' = 'fully_paid' and ((v::jsonb) -> 'state' ->> 'outstanding')::numeric = 0 and ((v::jsonb) -> 'state' ->> 'status_code')::int = 5 and ((v::jsonb) -> 'state' ->> 'paid')::numeric = 2 * pg_temp.c('P1')::numeric, left(v, 200) from t_ctx where k = 'v2';
select public.shop_admin_set_status(pg_temp.c('o1id')::uuid, 'confirmed');
reset role;
insert into t_res (test, ok, detail) select 'O4 confirming the order does not queue the receivable a second time', pg_temp.qn(pg_temp.c('i1id')::uuid, 'INVOICE_ISSUE') = 1, null;
insert into t_res (test, ok, detail) select 'O4 receipts and allocations add up to the invoice (no duplicate payment records)',
  (select sum(amount) from public.finance_receipts where invoice_id = pg_temp.c('i1id')::uuid and status = 'posted') = 2 * pg_temp.c('P1')::numeric
  and (select sum(amount) from public.finance_allocations where invoice_id = pg_temp.c('i1id')::uuid and active) = 2 * pg_temp.c('P1')::numeric
  and (select count(*) from public.finance_receipts where invoice_id = pg_temp.c('i1id')::uuid) = 2
  and (select count(*) from public.finance_gl_queue where event_type = 'BANK_RECEIPT' and ref_id in (select id from public.finance_receipts where invoice_id = pg_temp.c('i1id')::uuid)) = 2, null;
insert into t_res (test, ok, detail) select 'O4 the receivable is Dr receivable / Cr sales for the invoice amount',
  (select plan from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = pg_temp.c('i1id')::uuid) = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', 2 * pg_temp.c('P1')::numeric), jsonb_build_object('side', 'cr', 'role', 'sales', 'amount', 2 * pg_temp.c('P1')::numeric, 'vat', 'split')), null;

-- =========================================================================================== O5 the receivable follows confirmation
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o3', public.shop_place_order('ord-key-0003', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null, null, 'bank:BBL')::text;
insert into t_ctx select 'o3id', (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'o3';
insert into t_ctx select 'i3id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o3';
reset role;
insert into t_res (test, ok, detail) select 'O5 a new order has nothing in the ledger queue', pg_temp.qn(pg_temp.c('i3id')::uuid, 'INVOICE_ISSUE') = 0, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_set_status(pg_temp.c('o3id')::uuid, 'confirmed');
reset role;
insert into t_res (test, ok, detail) select 'O5 confirming the order queues the receivable once, waiting for the accountant', pg_temp.qn(pg_temp.c('i3id')::uuid, 'INVOICE_ISSUE', 'pending') = 1, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('O5 an unpaid order cannot go to preparing without a recorded reason', format($q$select public.shop_admin_set_status(%L, 'preparing')$q$, pg_temp.c('o3id')), '%PAYMENT_REQUIRED%');

-- =========================================================================================== O6 overpayment goes to the wallet
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'ev3', public.finance_submit_evidence(pg_temp.c('i3id')::uuid, pg_temp.c('A') || '/slip-o3.png', repeat('c', 64), 'image/png', pg_temp.c('P1')::numeric + 80, now(), 'BBL', null, pg_temp.c('bbl')::uuid)::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'v3', public.finance_verify_evidence(pg_temp.c('ev3')::uuid, pg_temp.c('P1')::numeric + 80, 'BBL-BANKREF-0003', now(), null, 'staff')::text;
insert into t_res (test, ok, detail) select 'O6 a transfer above the invoice settles it and credits the excess to the wallet',
  (v::jsonb) ->> 'result' = 'overpaid_credited' and ((v::jsonb) ->> 'credited_to_wallet')::numeric = 80 and ((v::jsonb) -> 'state' ->> 'status_code')::int = 5 and ((v::jsonb) -> 'state' ->> 'outstanding')::numeric = 0, left(v, 250) from t_ctx where k = 'v3';
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'O6 the customer sees the credit in their wallet, with the bank and the receipt',
  (public.finance_my_wallet() ->> 'balance')::numeric = 80 and (select x ->> 'txn_type' = 'DEPOSIT' and x -> 'bank' ->> 'code' = 'BBL' and (x ->> 'amount')::numeric = 80 from jsonb_array_elements(public.finance_my_wallet_transactions() -> 'items') x limit 1), public.finance_my_wallet()::text;
reset role;
insert into t_ctx select 'rc3', id::text from public.finance_receipts where invoice_id = pg_temp.c('i3id')::uuid and status = 'posted';
insert into t_res (test, ok, detail) select 'O6 the bank receipt posts Dr bank (all) / Cr receivable (owed) / Cr customer wallet liability (excess)',
  (select plan from public.finance_gl_queue where event_type = 'BANK_RECEIPT' and ref_id = pg_temp.c('rc3')::uuid)
   = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', pg_temp.c('P1')::numeric + 80, 'bank_account_id', pg_temp.c('bbl')),
                       jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', pg_temp.c('P1')::numeric),
                       jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', 80, 'wallet', true)), (select plan::text from public.finance_gl_queue where event_type = 'BANK_RECEIPT' and ref_id = pg_temp.c('rc3')::uuid);
insert into t_res (test, ok, detail) select 'O6 the receipt is linked to the wallet credit', (select credit_txn_id from public.finance_receipts where id = pg_temp.c('rc3')::uuid) = (select id from public.finance_wallet_transactions where ref_id = pg_temp.c('rc3')::uuid and txn_type = 'DEPOSIT'), null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'O6 wallet ledger and accounting queue agree (difference 0, no wallet problems)',
  (public.finance_gl_reconciliation() ->> 'difference')::numeric = 0 and jsonb_array_length(public.finance_wallet_reconcile() -> 'problems') = 0, public.finance_gl_reconciliation()::text;
-- the customer spends part of the credit on the other order; reversing the overpaid receipt must then be refused (never a negative wallet)
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o4', public.shop_place_order('ord-key-0004', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null, null, 'wallet')::text;
insert into t_ctx select 'i4id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o4';
insert into t_res (test, ok, detail) select 'O6 paying part of an invoice from the wallet works and is traceable', (public.finance_pay_invoice_with_wallet(pg_temp.c('i4id')::uuid, 50, 'wp-key-00002') ->> 'balance')::numeric = 30, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('O6 reversing the overpaid receipt is refused while the customer has spent the credit', format($q$select public.finance_reverse_receipt(%L, 'customer asked for a refund')$q$, pg_temp.c('rc3')), '%CREDIT_ALREADY_USED%');
insert into t_res (test, ok, detail) select 'O6 the refusal changed nothing (receipt still posted, wallet unchanged)',
  (select status from public.finance_receipts where id = pg_temp.c('rc3')::uuid) = 'posted' and (public.finance_wallet_ledger((select id from public.finance_customers where profile_id = pg_temp.c('A')::uuid)) ->> 'balance')::numeric = 30, null;
insert into t_ctx select 'fcA', id::text from public.finance_customers where profile_id = pg_temp.c('A')::uuid;
select public.finance_wallet_adjust(pg_temp.c('fcA')::uuid, 'credit', 50, 'goodwill credit so the receipt can be reversed', 'adj-key-00001', null);
select public.finance_reverse_receipt(pg_temp.c('rc3')::uuid, 'transfer was made by mistake');
insert into t_res (test, ok, detail) select 'O6 reversing the overpaid receipt also takes the credit back; the invoice is owed again',
  (public.finance_wallet_ledger(pg_temp.c('fcA')::uuid) ->> 'balance')::numeric = 0
  and ((select x from jsonb_array_elements(public.finance_invoice_overview(null)) x where x ->> 'id' = pg_temp.c('i3id')) ->> 'outstanding')::numeric = pg_temp.c('P1')::numeric, null;
reset role;
insert into t_res (test, ok, detail) select 'O6 the reversal posts Cr bank / Dr receivable / Dr customer wallet liability',
  (select plan from public.finance_gl_queue where event_type = 'RECEIPT_REVERSAL' and ref_id = pg_temp.c('rc3')::uuid)
   = jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'bank', 'amount', pg_temp.c('P1')::numeric + 80, 'bank_account_id', pg_temp.c('bbl')),
                       jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', pg_temp.c('P1')::numeric),
                       jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', 80, 'wallet', true)), (select plan::text from public.finance_gl_queue where event_type = 'RECEIPT_REVERSAL' and ref_id = pg_temp.c('rc3')::uuid);

-- =========================================================================================== O7 refund
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'ev5', public.finance_submit_evidence(pg_temp.c('i3id')::uuid, pg_temp.c('A') || '/slip-o3b.png', repeat('d', 64), 'image/png', pg_temp.c('P1')::numeric, now(), 'BBL', null, pg_temp.c('bbl')::uuid)::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_verify_evidence(pg_temp.c('ev5')::uuid, pg_temp.c('P1')::numeric, 'BBL-BANKREF-0005', now(), null, 'staff');
reset role;
insert into t_ctx select 'rc5', id::text from public.finance_receipts where invoice_id = pg_temp.c('i3id')::uuid and status = 'posted';
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_reverse_receipt(pg_temp.c('rc5')::uuid, 'goods could not be delivered');
select public.finance_wallet_refund(pg_temp.c('rc5')::uuid, pg_temp.c('P1')::numeric, 'order not deliverable: refund to wallet', 'refund-key-0001');
insert into t_res (test, ok, detail) select 'O7 the customer sees the invoice as REFUNDED (to the wallet) and unpaid',
  (select (x ->> 'refunded')::numeric = pg_temp.c('P1')::numeric and (x ->> 'outstanding')::numeric = pg_temp.c('P1')::numeric from jsonb_array_elements(public.finance_invoice_overview(null)) x where x ->> 'id' = pg_temp.c('i3id')), null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'O7 the refund is in the wallet, once', (public.finance_my_wallet() ->> 'balance')::numeric = pg_temp.c('P1')::numeric, public.finance_my_wallet()::text;
insert into t_res (test, ok, detail) select 'O7 the customer''s own invoice list carries the refunded amount', (select (x ->> 'refunded')::numeric = pg_temp.c('P1')::numeric from jsonb_array_elements(public.finance_my_invoices()) x where x ->> 'id' = pg_temp.c('i3id')), null;

-- =========================================================================================== O8 cancelling
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o5', public.shop_place_order('ord-key-0005', '[{"sku_code":"FG-000020","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null)::text;
insert into t_ctx select 'o5id', (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'o5';
insert into t_ctx select 'i5id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o5';
select public.shop_cancel_my_order(pg_temp.c('o5id')::uuid, 'changed my mind');
reset role;
insert into t_res (test, ok, detail) select 'O8 an order the customer cancelled before confirmation leaves NO accounting trace',
  (select status from public.shop_orders where id = pg_temp.c('o5id')::uuid) = 'cancelled' and (select status from public.finance_invoices where id = pg_temp.c('i5id')::uuid) = 'cancelled'
  and (select count(*) from public.finance_gl_queue where ref_id = pg_temp.c('i5id')::uuid) = 0, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o6', public.shop_place_order('ord-key-0006', '[{"sku_code":"FG-000020","qty":1}]', 'pickup', 'Somchai', '0812345678', null, null)::text;
insert into t_ctx select 'o6id', (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'o6';
insert into t_ctx select 'i6id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o6';
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_set_status(pg_temp.c('o6id')::uuid, 'confirmed');
select pg_temp.err_like('O8 staff cancelling needs a reason', format($q$select public.shop_admin_set_status(%L, 'cancelled')$q$, pg_temp.c('o6id')), '%reason is required%');
select public.shop_admin_set_status(pg_temp.c('o6id')::uuid, 'cancelled', 'out of stock, sorry');
reset role;
insert into t_res (test, ok, detail) select 'O8 rejecting a confirmed order before it was posted voids its queued receivable (nothing to reverse)',
  pg_temp.qn(pg_temp.c('i6id')::uuid, 'INVOICE_ISSUE', 'void') = 1 and pg_temp.qn(pg_temp.c('i6id')::uuid, 'INVOICE_CANCEL') = 0, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('O8 an order with a payment cannot be cancelled (reverse the payment first)', format($q$select public.shop_admin_set_status(%L, 'cancelled', 'x')$q$, pg_temp.c('o1id')), '%PAYMENT_RECORDED%');

-- =========================================================================================== O9 security
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('O9 customer B cannot read customer A''s order', format($q$select public.shop_my_order(%L)$q$, pg_temp.c('o1id')), '%Order not found%');
insert into t_res (test, ok, detail) select 'O9 customer B''s order list and invoice list contain none of A''s',
  not exists (select 1 from jsonb_array_elements(public.shop_my_orders('all', 50, 0) -> 'orders') x where x ->> 'id' in (pg_temp.c('o1id'), pg_temp.c('o3id'), pg_temp.c('o4id')))
  and not exists (select 1 from jsonb_array_elements(public.finance_my_invoices()) x where x ->> 'id' in (pg_temp.c('i1id'), pg_temp.c('i3id'))), null;
select pg_temp.err_like('O9 customer B cannot cancel A''s order', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('o3id')), '%not found%');
select pg_temp.err_like('O9 customer B cannot attach a slip to A''s invoice', format($q$select public.finance_submit_evidence(%L, %L, repeat('e', 64), 'image/png', 1, now(), null, null, null)$q$, pg_temp.c('i3id'), pg_temp.c('B') || '/s.png'), '%Invoice not found%');
select pg_temp.err_like('O9 customer B cannot pay A''s invoice from their own wallet', format($q$select public.finance_pay_invoice_with_wallet(%L, 10, 'wp-key-B0001')$q$, pg_temp.c('i3id')), '%not found%');
insert into t_res (test, ok, detail) select 'O9 customer B sees an empty wallet, not A''s', (public.finance_my_wallet() ->> 'balance')::numeric = 0, null;
select pg_temp.err_like('O9 a customer cannot change order status', format($q$select public.shop_admin_set_status(%L, 'completed')$q$, pg_temp.c('o3id')), '%not allowed%');
select pg_temp.err_like('O9 a customer cannot queue ledger entries', format($q$select public.finance_gl_ensure_invoice_issue(%L)$q$, pg_temp.c('i3id')), '%permission denied%');
insert into t_res (test, ok, detail) select 'O9 a customer sees no ledger-queue rows at all (staff only)', (select count(*) from public.finance_gl_queue) = 0, null;
select pg_temp.err_like('O9 a customer cannot reverse or refund', format($q$select public.finance_reverse_receipt(%L, 'x')$q$, pg_temp.c('rc1')), '%not allowed%');
reset role; set local role anon;
select pg_temp.err_like('O9 anonymous visitors cannot place orders', $q$select public.shop_place_order('anon-key-0001', '[]', 'pickup', 'x', '0812345678', null, null, null, null)$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('O9 a verifier cannot reverse a receipt (manager only)', format($q$select public.finance_reverse_receipt(%L, 'x')$q$, pg_temp.c('rc1')), '%not allowed%');
select pg_temp.err_like('O9 a verifier cannot adjust a wallet', format($q$select public.finance_wallet_adjust(%L, 'credit', 10, 'sneaking in a credit now', 'adj-key-sneak', null)$q$, pg_temp.c('fcA')), '%not allowed%');

-- =========================================================================================== O10 integrity
reset role;
insert into t_res (test, ok, detail) select 'O10 order and invoice numbers are unique', (select count(*) = count(distinct order_no) from public.shop_orders) and (select count(*) = count(distinct invoice_no) from public.finance_invoices), null;
insert into t_res (test, ok, detail) select 'O10 every queued ledger entry balances (debits = credits)',
  not exists (select 1 from public.finance_gl_queue q where (select coalesce(sum((l ->> 'amount')::numeric) filter (where l ->> 'side' = 'dr'), 0) from jsonb_array_elements(q.plan) l)
                                                          <> (select coalesce(sum((l ->> 'amount')::numeric) filter (where l ->> 'side' = 'cr'), 0) from jsonb_array_elements(q.plan) l)), null;
insert into t_res (test, ok, detail) select 'O10 every wallet balance equals the sum of its ledger',
  not exists (select 1 from public.finance_wallets w where w.balance <> (select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0) from public.finance_wallet_transactions t where t.wallet_id = w.id)), null;
insert into t_res (test, ok, detail) select 'O10 no invoice is paid beyond its amount',
  not exists (select 1 from public.finance_invoices i where (select coalesce(sum(a.amount), 0) from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id where a.invoice_id = i.id and a.active and r.status = 'posted') > i.amount), null;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'ORDERING_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
