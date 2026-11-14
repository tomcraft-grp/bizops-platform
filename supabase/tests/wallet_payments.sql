-- Tests for 20261115200000_wallet_payments.sql, run against REAL data inside one transaction that is rolled back
-- (scripts/run-wallet-sql-tests.sh). Nothing persists: the last statement raises an exception that carries the result table.
-- Real profiles: customers A and B, a verifier C and a (non-super) manager D that the test grants a finance role, and a SUPER_ADMIN S.
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

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'C', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 2 limit 1;
insert into t_ctx select 'D', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 3 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
-- these suites place orders without a slip (the slip rule has its own tests in online_ordering.sql, section O11)
update public.shop_settings set require_payment_slip = false;
insert into public.finance_staff_roles (user_id, role) values (pg_temp.c('C')::uuid, 'verifier'), (pg_temp.c('D')::uuid, 'manager');
insert into t_ctx select 'scb', id::text from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'bbl', id::text from public.finance_bank_accounts where code = 'BBL';
insert into t_res (test, ok, detail) select 'test users found', count(*) = 5, string_agg(k, ',') from t_ctx where k in ('A', 'B', 'C', 'D', 'S');

-- =========================================================================================== W1 payment methods (bank accounts)
set local role anon;
select pg_temp.err_like('W1 anon cannot read payment methods', $q$select public.finance_payment_methods()$q$, '%permission denied%');
select pg_temp.err_like('W1 anon cannot read bank accounts', $q$select count(*) from public.finance_bank_accounts$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'methods', public.finance_payment_methods()::text;
insert into t_res (test, ok, detail) select 'W1 two active banks, SCB first', jsonb_array_length((v::jsonb) -> 'banks') = 2 and (v::jsonb) -> 'banks' -> 0 ->> 'code' = 'SCB' and (v::jsonb) -> 'banks' -> 1 ->> 'code' = 'BBL', v from t_ctx where k = 'methods';
insert into t_res (test, ok, detail) select 'W1 SCB details are exactly as configured', (v::jsonb) -> 'banks' -> 0 ->> 'account_no' = '5194026251' and (v::jsonb) -> 'banks' -> 0 ->> 'account_name' = 'ณัฐพล อยู่ยิ้ม'
  and (v::jsonb) -> 'banks' -> 0 ->> 'bank_name_th' = 'ธนาคารไทยพาณิชย์' and (v::jsonb) -> 'banks' -> 0 ->> 'bank_name_en' = 'Siam Commercial Bank', null from t_ctx where k = 'methods';
insert into t_res (test, ok, detail) select 'W1 BBL details are exactly as configured', (v::jsonb) -> 'banks' -> 1 ->> 'account_no' = '9380319542' and (v::jsonb) -> 'banks' -> 1 ->> 'account_name' = 'ณัฐพร อยู่ยิ้ม'
  and (v::jsonb) -> 'banks' -> 1 ->> 'bank_name_th' = 'ธนาคารกรุงเทพ' and (v::jsonb) -> 'banks' -> 1 ->> 'bank_name_en' = 'Bangkok Bank', null from t_ctx where k = 'methods';
insert into t_res (test, ok, detail) select 'W1 a new customer sees a zero wallet and the deposit limits', ((v::jsonb) -> 'wallet' ->> 'balance')::numeric = 0 and ((v::jsonb) -> 'wallet' ->> 'max_deposit')::numeric = 500000, null from t_ctx where k = 'methods';
select pg_temp.err_like('W1 customer cannot insert a bank account', $q$insert into public.finance_bank_accounts (code, bank_name_en, bank_name_th, account_no, account_name) values ('X1', 'x', 'x', '123456', 'x')$q$, '%permission denied%');
select pg_temp.err_like('W1 customer cannot change an account number', $q$update public.finance_bank_accounts set account_no = '1111111111'$q$, '%permission denied%');
select pg_temp.err_like('W1 customer cannot call the bank account editor', $q$select public.finance_save_bank_account(null, 'KB', 'Kasikorn', 'กสิกร', '1234567890', 'x', null, null, null, null, null, 30, true)$q$, '%not allowed%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('W1 a verifier cannot manage bank accounts', $q$select public.finance_save_bank_account(null, 'KB', 'Kasikorn', 'กสิกร', '1234567890', 'x', null, null, null, null, null, 30, true)$q$, '%not allowed%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'kb', (public.finance_save_bank_account(null, 'kb', 'Kasikorn Bank', 'ธนาคารกสิกรไทย', '123-4-56789-0', 'Test Holder', null, null, null, null, '1115', 30, true)).id::text;
insert into t_res (test, ok, detail) select 'W1 a manager adds a bank account (digits normalised, code upper-cased)', (select account_no || code from public.finance_bank_accounts where id = pg_temp.c('kb')::uuid) = '1234567890KB', null;
select public.finance_save_bank_account(pg_temp.c('kb')::uuid, 'KB', 'Kasikorn Bank', 'ธนาคารกสิกรไทย', '1234567890', 'Test Holder', null, null, null, null, '1115', 30, false);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'W1 a deactivated account disappears for customers', jsonb_array_length(public.finance_payment_methods() -> 'banks') = 2 and (select count(*) from public.finance_bank_accounts) = 2, null;

-- =========================================================================================== W2 deposit lifecycle
select pg_temp.err_like('W2 bad key refused', format($q$select public.finance_deposit_create(%L, 5000, 'x')$q$, pg_temp.c('scb')), '%INVALID_KEY%');
select pg_temp.err_like('W2 amount below the minimum refused', format($q$select public.finance_deposit_create(%L, 0.5, 'dep-key-low1')$q$, pg_temp.c('scb')), '%AMOUNT_OUT_OF_RANGE%');
select pg_temp.err_like('W2 amount above the maximum refused', format($q$select public.finance_deposit_create(%L, 600000, 'dep-key-high')$q$, pg_temp.c('scb')), '%AMOUNT_OUT_OF_RANGE%');
select pg_temp.err_like('W2 satang beyond 2 decimals refused', format($q$select public.finance_deposit_create(%L, 100.123, 'dep-key-dec1')$q$, pg_temp.c('scb')), '%AMOUNT_OUT_OF_RANGE%');
select pg_temp.err_like('W2 a deactivated bank cannot be chosen', format($q$select public.finance_deposit_create(%L, 1000, 'dep-key-bank')$q$, pg_temp.c('kb')), '%BANK_NOT_AVAILABLE%');
insert into t_ctx select 'd1', public.finance_deposit_create(pg_temp.c('scb')::uuid, 5000, 'dep-key-0001', 'my transfer')::text;
insert into t_ctx select 'd1id', (v::jsonb) ->> 'id' from t_ctx where k = 'd1';
insert into t_res (test, ok, detail) select 'W2 a new deposit is pending with a payment reference', (v::jsonb) ->> 'status' = 'pending' and (v::jsonb) ->> 'deposit_no' ~ '^DEP-[0-9]{6}$' and ((v::jsonb) ->> 'amount')::numeric = 5000, v from t_ctx where k = 'd1';
insert into t_res (test, ok, detail) select 'W2 the deposit never leaks reviewer ids', not ((v::jsonb) ? 'reviewed_by' or (v::jsonb) ? 'review_note' or (v::jsonb) ? 'created_by'), null from t_ctx where k = 'd1';
insert into t_res (test, ok, detail) select 'W2 retry with the same key returns the same deposit', public.finance_deposit_create(pg_temp.c('scb')::uuid, 5000, 'dep-key-0001') ->> 'id' = pg_temp.c('d1id'), null;
select pg_temp.err_like('W2 same key, different amount is refused', format($q$select public.finance_deposit_create(%L, 6000, 'dep-key-0001')$q$, pg_temp.c('scb')), '%KEY_REUSED%');
insert into t_res (test, ok, detail) select 'W2 a pending deposit does not touch the wallet', ((public.finance_my_wallet() ->> 'balance')::numeric = 0) and ((public.finance_my_wallet() ->> 'pending_deposits')::numeric = 5000), null;
select pg_temp.err_like('W2 a slip from another customer''s folder is refused', format($q$select public.finance_deposit_submit_slip(%L, %L, repeat('1', 64), 'image/png', now())$q$, pg_temp.c('d1id'), pg_temp.c('B') || '/s.png'), '%Invalid file%');
select pg_temp.err_like('W2 a path with .. is refused', format($q$select public.finance_deposit_submit_slip(%L, %L, repeat('1', 64), 'image/png', now())$q$, pg_temp.c('d1id'), pg_temp.c('A') || '/../s.png'), '%Invalid file%');
select pg_temp.err_like('W2 a file type that is not an image or PDF is refused', format($q$select public.finance_deposit_submit_slip(%L, %L, repeat('1', 64), 'text/html', now())$q$, pg_temp.c('d1id'), pg_temp.c('A') || '/s.html'), '%Invalid file%');
select pg_temp.err_like('W2 a malformed checksum is refused', format($q$select public.finance_deposit_submit_slip(%L, %L, 'abc', 'image/png', now())$q$, pg_temp.c('d1id'), pg_temp.c('A') || '/s.png'), '%Invalid file%');
select pg_temp.err_like('W2 a transfer time in the future is refused', format($q$select public.finance_deposit_submit_slip(%L, %L, repeat('1', 64), 'image/png', now() + interval '2 days')$q$, pg_temp.c('d1id'), pg_temp.c('A') || '/s.png'), '%future%');
insert into t_res (test, ok, detail) select 'W2 submitting the slip makes the deposit "submitted"', public.finance_deposit_submit_slip(pg_temp.c('d1id')::uuid, pg_temp.c('A') || '/slip-d1.png', repeat('1', 64), 'image/png', now(), null) ->> 'status' = 'submitted', null;
insert into t_res (test, ok, detail) select 'W2 UPLOADING A SLIP DOES NOT CREDIT THE WALLET', (public.finance_my_wallet() ->> 'balance')::numeric = 0 and (public.finance_my_wallet_transactions() ->> 'total')::int = 0, null;
select pg_temp.err_like('W2 a slip cannot be submitted twice on one deposit', format($q$select public.finance_deposit_submit_slip(%L, %L, repeat('2', 64), 'image/png', now())$q$, pg_temp.c('d1id'), pg_temp.c('A') || '/s2.png'), '%DEPOSIT_NOT_PENDING%');
insert into t_ctx select 'd2id', public.finance_deposit_create(pg_temp.c('bbl')::uuid, 1000, 'dep-key-0002')::json ->> 'id';
select pg_temp.err_like('W2 the same slip file cannot back a second deposit', format($q$select public.finance_deposit_submit_slip(%L, %L, repeat('1', 64), 'image/png', now())$q$, pg_temp.c('d2id'), pg_temp.c('A') || '/slip-copy.png'), '%SLIP_ALREADY_USED%');
select pg_temp.err_like('W2 the customer cannot verify their own deposit', format($q$select public.finance_deposit_verify(%L, 5000, 'BANKREF-FAKE', now())$q$, pg_temp.c('d1id')), '%not allowed%');
select pg_temp.err_like('W2 the customer cannot reject deposits', format($q$select public.finance_deposit_reject(%L, 'x')$q$, pg_temp.c('d1id')), '%not allowed%');
select pg_temp.err_like('W2 the customer cannot write deposits directly', $q$update public.finance_wallet_deposits set status = 'verified'$q$, '%permission denied%');
select pg_temp.err_like('W2 the customer cannot write the wallet directly', $q$update public.finance_wallets set balance = 1000000$q$, '%permission denied%');
select pg_temp.err_like('W2 the customer cannot write ledger rows directly', $q$insert into public.finance_wallet_transactions (txn_no) values ('X')$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'W2 customer B sees nothing of A''s deposits or wallet', jsonb_array_length(public.finance_my_deposits()) = 0 and (public.finance_my_wallet() ->> 'balance')::numeric = 0
  and (select count(*) from public.finance_wallet_deposits) = 0 and (select count(*) from public.finance_wallets) = 0, null;
select pg_temp.err_like('W2 customer B cannot submit a slip for A''s deposit', format($q$select public.finance_deposit_submit_slip(%L, %L, repeat('9', 64), 'image/png', now())$q$, pg_temp.c('d1id'), pg_temp.c('B') || '/s.png'), '%Deposit not found%');
select pg_temp.err_like('W2 customer B cannot cancel A''s deposit', format($q$select public.finance_deposit_cancel(%L)$q$, pg_temp.c('d1id')), '%Deposit not found%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_deposit_start_review(pg_temp.c('d1id')::uuid);
insert into t_res (test, ok, detail) select 'W2 staff put the deposit under review', (select status from public.finance_wallet_deposits where id = pg_temp.c('d1id')::uuid) = 'under_review', null;
select pg_temp.err_like('W2 the bank reference is required', format($q$select public.finance_deposit_verify(%L, 4990, '', now())$q$, pg_temp.c('d1id')), '%reference is required%');
select pg_temp.err_like('W2 the verified amount must be positive', format($q$select public.finance_deposit_verify(%L, 0, 'BANKREF-D1', now())$q$, pg_temp.c('d1id')), '%amount shown by the bank%');
insert into t_ctx select 'ver1', public.finance_deposit_verify(pg_temp.c('d1id')::uuid, 4990, 'BANKREF-D1', now(), 'matches the statement')::text;
insert into t_res (test, ok, detail) select 'W2 verification credits what the BANK shows (4990), not the claim (5000)', (select balance from public.finance_wallets where customer_id = (select customer_id from public.finance_wallet_deposits where id = pg_temp.c('d1id')::uuid)) = 4990
  and ((v::jsonb) ->> 'balance')::numeric = 4990, v from t_ctx where k = 'ver1';
insert into t_res (test, ok, detail) select 'W2 the ledger row is complete', (select (txn_type = 'DEPOSIT' and direction = 'credit' and amount = 4990 and balance_before = 0 and balance_after = 4990 and ref_type = 'deposit' and payment_method = 'bank_transfer'
    and bank_account_id = pg_temp.c('scb')::uuid and verification_status = 'verified' and created_by = pg_temp.c('A')::uuid and approved_by = pg_temp.c('S')::uuid and txn_no ~ '^WAL-[0-9]{6}$' and ref_no like 'DEP-%')
  from public.finance_wallet_transactions where ref_id = pg_temp.c('d1id')::uuid), null;
select pg_temp.err_like('W2 a verified deposit cannot be verified again (no duplicate credit)', format($q$select public.finance_deposit_verify(%L, 4990, 'BANKREF-D1', now())$q$, pg_temp.c('d1id')), '%DEPOSIT_NOT_REVIEWABLE%');
select pg_temp.err_like('W2 a verified deposit cannot be rejected', format($q$select public.finance_deposit_reject(%L, 'late')$q$, pg_temp.c('d1id')), '%Only a submitted deposit%');
-- a second transfer: rejected, so nothing is credited
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select public.finance_deposit_submit_slip(pg_temp.c('d2id')::uuid, pg_temp.c('A') || '/slip-d2.png', repeat('2', 64), 'image/png', now(), null);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('W2 a bank reference that is already used cannot verify another deposit', format($q$select public.finance_deposit_verify(%L, 1000, 'BANKREF-D1', now())$q$, pg_temp.c('d2id')), '%already recorded%');
select pg_temp.err_like('W2 rejecting needs a reason', format($q$select public.finance_deposit_reject(%L, ' ')$q$, pg_temp.c('d2id')), '%reason is required%');
select public.finance_deposit_reject(pg_temp.c('d2id')::uuid, 'The amount on the slip does not match');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'W2 REJECTED DEPOSIT: the wallet is not credited', (public.finance_my_wallet() ->> 'balance')::numeric = 4990, null;
insert into t_res (test, ok, detail) select 'W2 the customer sees the rejection and its reason', (select d ->> 'status' = 'rejected' and d ->> 'reject_reason' like 'The amount%' from jsonb_array_elements(public.finance_my_deposits()) d where d ->> 'id' = pg_temp.c('d2id')), null;
select pg_temp.err_like('W2 a rejected deposit cannot be cancelled', format($q$select public.finance_deposit_cancel(%L)$q$, pg_temp.c('d2id')), '%DEPOSIT_NOT_CANCELLABLE%');
insert into t_ctx select 'd3id', public.finance_deposit_create(pg_temp.c('scb')::uuid, 300, 'dep-key-0003')::json ->> 'id';
insert into t_res (test, ok, detail) select 'W2 the customer can cancel a pending deposit', public.finance_deposit_cancel(pg_temp.c('d3id')::uuid) ->> 'status' = 'cancelled', null;
reset role;
select pg_temp.err_like('W2 a deposit amount cannot be edited', format($q$update public.finance_wallet_deposits set amount = 1 where id = %L$q$, pg_temp.c('d1id')), '%cannot be changed%');
select pg_temp.err_like('W2 a deposit cannot be deleted', format($q$delete from public.finance_wallet_deposits where id = %L$q$, pg_temp.c('d1id')), '%never deleted%');
select pg_temp.err_like('W2 a verified deposit cannot go back to pending', format($q$update public.finance_wallet_deposits set status = 'pending' where id = %L$q$, pg_temp.c('d1id')), '%already verified%');
select pg_temp.err_like('W2 the bank account of a used deposit cannot get a new number', format($q$select public.finance_save_bank_account(%L, 'SCB', 'Siam Commercial Bank', 'ธนาคารไทยพาณิชย์', '9999999999', 'x', null, null, null, null, null, 10, true)$q$, pg_temp.c('scb')), '%not allowed%');
-- ledger: the GL queue got the deposit
insert into t_res (test, ok, detail) select 'W2 the deposit is queued for the ledger: Dr bank (that bank) / Cr customer credit', (select q.event_type = 'WALLET_DEPOSIT' and q.status = 'pending' and q.amount = 4990
    and q.plan -> 0 ->> 'side' = 'dr' and q.plan -> 0 ->> 'role' = 'bank' and q.plan -> 0 ->> 'bank_account_id' = pg_temp.c('scb') and q.plan -> 1 ->> 'side' = 'cr' and q.plan -> 1 ->> 'role' = 'customer_credit' and (q.plan -> 1 ->> 'wallet')::boolean
  from public.finance_gl_queue q where q.event_type = 'WALLET_DEPOSIT'), null;

-- =========================================================================================== W3 paying an invoice from the wallet
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'cust', (select id::text from public.finance_customers where profile_id = pg_temp.c('A')::uuid);
insert into t_ctx select 'inv1', (public.finance_create_invoice(pg_temp.c('cust')::uuid, 2000, null, null, 'Test invoice 1', 'TEST-1')).id::text;
insert into t_ctx select 'inv2', (public.finance_create_invoice(pg_temp.c('cust')::uuid, 9000, null, null, 'Test invoice 2 (too big for the wallet)', 'TEST-2')).id::text;
insert into t_ctx select 'inv3', (public.finance_create_invoice(pg_temp.c('cust')::uuid, 700, null, null, 'Test invoice 3 (paid by bank)', 'TEST-3')).id::text;
reset role;
insert into t_res (test, ok, detail) select 'W3 each invoice is queued for the ledger: Dr receivable / Cr sales', (select count(*) from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and status = 'pending') = 3
  and (select plan -> 0 ->> 'role' = 'ar' and plan -> 1 ->> 'role' = 'sales' and plan -> 1 ->> 'vat' = 'split' from public.finance_gl_queue where ref_id = pg_temp.c('inv1')::uuid), null;
set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('W3 customer B cannot pay A''s invoice from a wallet', format($q$select public.finance_pay_invoice_with_wallet(%L, 100, 'inv-pay-by-B1')$q$, pg_temp.c('inv1')), '%Invoice not found%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W3 an invalid key is refused', format($q$select public.finance_pay_invoice_with_wallet(%L, 100, 'x')$q$, pg_temp.c('inv1')), '%INVALID_KEY%');
select pg_temp.err_like('W3 more than the invoice owes is refused', format($q$select public.finance_pay_invoice_with_wallet(%L, 2500, 'inv-pay-over-01')$q$, pg_temp.c('inv1')), '%AMOUNT_EXCEEDS_OUTSTANDING%');
select pg_temp.err_like('W3 a negative amount is refused', format($q$select public.finance_pay_invoice_with_wallet(%L, -5, 'inv-pay-neg-01')$q$, pg_temp.c('inv1')), '%INVALID_AMOUNT%');
select pg_temp.err_like('W3 INSUFFICIENT WALLET BALANCE: the payment is refused', format($q$select public.finance_pay_invoice_with_wallet(%L, 9000, 'inv-pay-short1')$q$, pg_temp.c('inv2')), '%INSUFFICIENT_FUNDS%');
insert into t_res (test, ok, detail) select 'W3 a refused payment changes nothing (balance, invoice, ledger)', (public.finance_my_wallet() ->> 'balance')::numeric = 4990 and (select (public.finance_invoice_state(pg_temp.c('inv2')::uuid) ->> 'paid')::numeric) = 0
  and (public.finance_my_wallet_transactions() ->> 'total')::int = 1, null;
insert into t_ctx select 'pay1', public.finance_pay_invoice_with_wallet(pg_temp.c('inv1')::uuid, 2000, 'inv-pay-ok-0001')::text;
insert into t_res (test, ok, detail) select 'W3 PAYING 2000 FROM THE WALLET: balance 4990 -> 2990 and the invoice is fully paid', ((v::jsonb) ->> 'balance')::numeric = 2990 and ((v::jsonb) -> 'state' ->> 'status_code')::int = 5 and ((v::jsonb) -> 'state' ->> 'paid')::numeric = 2000, v from t_ctx where k = 'pay1';
insert into t_ctx select 'pay1r', public.finance_pay_invoice_with_wallet(pg_temp.c('inv1')::uuid, 2000, 'inv-pay-ok-0001')::text;
insert into t_res (test, ok, detail) select 'W3 the retry of the same payment does not charge twice', ((v::jsonb) ->> 'replay')::boolean and (public.finance_my_wallet() ->> 'balance')::numeric = 2990
  and (public.finance_my_wallet_transactions() ->> 'total')::int = 2, v from t_ctx where k = 'pay1r';
select pg_temp.err_like('W3 a paid invoice cannot be paid again with a new key', format($q$select public.finance_pay_invoice_with_wallet(%L, 100, 'inv-pay-again1')$q$, pg_temp.c('inv1')), '%NOTHING_OUTSTANDING%');
insert into t_ctx select 'part', public.finance_pay_invoice_with_wallet(pg_temp.c('inv3')::uuid, 200, 'inv-pay-part-01')::text;
insert into t_res (test, ok, detail) select 'W3 a partial payment is allowed', (((v::jsonb) -> 'state' ->> 'outstanding')::numeric = 500) and (public.finance_my_wallet() ->> 'balance')::numeric = 2790, v from t_ctx where k = 'part';
reset role;
insert into t_res (test, ok, detail) select 'W3 the wallet payment row is complete', (select (txn_type = 'INVOICE_PAYMENT' and direction = 'debit' and amount = 2000 and balance_before = 4990 and balance_after = 2990 and ref_type = 'invoice' and ref_no like 'INV-%'
    and payment_method = 'wallet' and created_by = pg_temp.c('A')::uuid) from public.finance_wallet_transactions where ref_id = pg_temp.c('inv1')::uuid and txn_type = 'INVOICE_PAYMENT'), null;
insert into t_res (test, ok, detail) select 'W3 the receipt says "wallet", has no slip, and is linked to the ledger row', (select r.method = 'wallet' and r.evidence_id is null and r.wallet_txn_id is not null and r.bank_account_id is null
    from public.finance_receipts r where r.invoice_id = pg_temp.c('inv1')::uuid), null;
insert into t_res (test, ok, detail) select 'W3 the wallet payment is queued: Dr customer credit / Cr receivable, after its invoice', (select q.plan -> 0 ->> 'role' = 'customer_credit' and (q.plan -> 0 ->> 'wallet')::boolean and q.plan -> 0 ->> 'side' = 'dr' and q.plan -> 1 ->> 'role' = 'ar' and q.plan -> 1 ->> 'side' = 'cr'
    and q.depends_on = (select id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = pg_temp.c('inv1')::uuid) from public.finance_gl_queue q where q.event_type = 'WALLET_PAYMENT' and q.amount = 2000), null;

-- invoice paid by BANK transfer to BBL: the wallet is NOT touched
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'ev3', public.finance_submit_evidence(pg_temp.c('inv3')::uuid, pg_temp.c('A') || '/slip-inv3.png', repeat('3', 64), 'image/png', 500, now(), 'BBL', 'REF-3', pg_temp.c('bbl')::uuid)::text;
insert into t_res (test, ok, detail) select 'W3 the invoice slip records the receiving bank', (select bank_account_id from public.finance_payment_evidence where id = pg_temp.c('ev3')::uuid) = pg_temp.c('bbl')::uuid, null;
select pg_temp.err_like('W3 an unknown bank on a slip is refused', format($q$select public.finance_submit_evidence(%L, %L, repeat('4', 64), 'image/png', 500, now(), 'BBL', 'REF-4', %L)$q$, pg_temp.c('inv3'), pg_temp.c('A') || '/s4.png', gen_random_uuid()), '%BANK_NOT_AVAILABLE%');
select pg_temp.err_like('W3 a slip already used for a deposit cannot back an invoice', format($q$select public.finance_submit_evidence(%L, %L, repeat('1', 64), 'image/png', 500, now(), 'SCB', 'REF-5')$q$, pg_temp.c('inv3'), pg_temp.c('A') || '/s5.png'), '%already submitted%');
insert into t_res (test, ok, detail) select 'W3 an OLD app build (8 arguments) can still submit a slip', public.finance_submit_evidence(pg_temp.c('inv3')::uuid, pg_temp.c('A') || '/slip-old.png', repeat('5', 64), 'image/png', 100, now(), 'old', 'old') is not null, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_verify_evidence(pg_temp.c('ev3')::uuid, 500, 'BANKREF-INV3', now(), null, 'staff');
reset role;
insert into t_res (test, ok, detail) select 'W3 verified bank slip: receipt records the BBL account and settles the invoice', (select r.bank_account_id = pg_temp.c('bbl')::uuid and r.method = 'bank_transfer' and r.wallet_txn_id is null from public.finance_receipts r where r.evidence_id = pg_temp.c('ev3')::uuid)
  and (public.finance_invoice_state_raw(pg_temp.c('inv3')::uuid) ->> 'status_code')::int = 5, null;
insert into t_res (test, ok, detail) select 'W3 A BANK PAYMENT NEVER CREDITS THE WALLET (no double use of the same money)', (select balance from public.finance_wallets where customer_id = pg_temp.c('cust')::uuid) = 2790
  and (select count(*) from public.finance_wallet_transactions where customer_id = pg_temp.c('cust')::uuid) = 3, null;
insert into t_res (test, ok, detail) select 'W3 the bank receipt is queued: Dr BBL / Cr receivable', (select q.plan -> 0 ->> 'role' = 'bank' and q.plan -> 0 ->> 'bank_account_id' = pg_temp.c('bbl') and q.plan -> 1 ->> 'role' = 'ar' and jsonb_array_length(q.plan) = 2
  from public.finance_gl_queue q where q.event_type = 'BANK_RECEIPT'), null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('W3 a bank reference already used by a deposit cannot verify an invoice slip', format($q$select public.finance_verify_evidence((select id from public.finance_payment_evidence where file_sha256 = repeat('5', 64)), 100, 'BANKREF-D1', now(), null, 'staff')$q$), '%already recorded%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'd4id', public.finance_deposit_create(pg_temp.c('scb')::uuid, 300, 'dep-key-0004')::json ->> 'id';
select public.finance_deposit_submit_slip(pg_temp.c('d4id')::uuid, pg_temp.c('A') || '/slip-d4.png', repeat('6', 64), 'image/png', now(), null);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('W3 a bank reference already used by an invoice receipt cannot verify a deposit', format($q$select public.finance_deposit_verify(%L, 300, 'BANKREF-INV3', now())$q$, pg_temp.c('d4id')), '%already recorded%');
select public.finance_deposit_reject(pg_temp.c('d4id')::uuid, 'Test clean-up: this transfer reference belongs to an invoice payment');
reset role;

-- =========================================================================================== W4 the balance can only move through the ledger
select pg_temp.err_like('W4 direct balance update blocked', $q$update public.finance_wallets set balance = balance + 1000$q$, '%can only change through a ledger transaction%');
select pg_temp.err_like('W4 a wallet cannot be deleted', $q$delete from public.finance_wallets$q$, '%never deleted%');
select pg_temp.err_like('W4 a wallet cannot change owner', format($q$update public.finance_wallets set customer_id = gen_random_uuid() where customer_id = %L$q$, pg_temp.c('cust')), '%cannot change owner%');
select pg_temp.err_like('W4 a ledger row cannot be edited', $q$update public.finance_wallet_transactions set amount = 1$q$, '%never changed or deleted%');
select pg_temp.err_like('W4 a ledger row cannot be deleted', $q$delete from public.finance_wallet_transactions$q$, '%never changed or deleted%');
select pg_temp.err_like('W4 a negative balance is impossible at the table level too', format($q$insert into public.finance_wallets (customer_id, balance) values (gen_random_uuid(), -1)$q$), '%violates%');
select pg_temp.err_like('W4 a ledger row with inconsistent balances is refused', format($q$insert into public.finance_wallet_transactions (txn_no, wallet_id, customer_id, txn_type, direction, amount, balance_before, balance_after, idempotency_key)
  select 'WT-X', w.id, w.customer_id, 'DEPOSIT', 'credit', 100, 0, 50, 'bad-chain-key-1' from public.finance_wallets w limit 1$q$), '%violates check constraint%');
select pg_temp.err_like('W4 a DEPOSIT row cannot be a debit', format($q$insert into public.finance_wallet_transactions (txn_no, wallet_id, customer_id, txn_type, direction, amount, balance_before, balance_after, idempotency_key)
  select 'WT-Y', w.id, w.customer_id, 'DEPOSIT', 'debit', 100, 500, 400, 'bad-dir-key-001' from public.finance_wallets w limit 1$q$), '%violates check constraint%');
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W4 customers cannot call the internal wallet writer', format($q$select public.finance_wallet_apply(%L, 'DEPOSIT', 'credit', 1000, 'hack-key-00001', null, null, null, 'manual', null, 'verified', null, null, 'x')$q$, pg_temp.c('cust')), '%permission denied%');
select pg_temp.err_like('W4 customers cannot enqueue ledger rows', $q$select public.finance_gl_enqueue('WALLET_DEPOSIT', 'x', gen_random_uuid(), 'x', null, 1, '[]')$q$, '%permission denied%');
select pg_temp.err_like('W4 customers cannot read the staff ledger view', format($q$select public.finance_wallet_ledger(%L)$q$, pg_temp.c('cust')), '%not allowed%');
select pg_temp.err_like('W4 customers cannot read the ledger table', $q$select count(*) / (select count(*) from public.finance_wallet_transactions) from public.finance_wallet_transactions$q$, '%division by zero%');

-- =========================================================================================== W5 staff: adjustments, reversals, refunds
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W5 UNAUTHORIZED ADJUSTMENT: a customer is refused', format($q$select public.finance_wallet_adjust(%L, 'credit', 100, 'trying to give myself money', 'adj-by-cust-01')$q$, pg_temp.c('cust')), '%not allowed%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('W5 UNAUTHORIZED ADJUSTMENT: a verifier is refused', format($q$select public.finance_wallet_adjust(%L, 'credit', 100, 'verifier is not a manager', 'adj-by-verif-1')$q$, pg_temp.c('cust')), '%not allowed%');
select pg_temp.err_like('W5 a verifier cannot refund', format($q$select public.finance_wallet_refund(gen_random_uuid(), 1, 'x', 'refund-key-001')$q$), '%not allowed%');
select pg_temp.err_like('W5 a verifier cannot reverse', format($q$select public.finance_wallet_reverse(gen_random_uuid(), 'a long enough reason')$q$), '%not allowed%');
select pg_temp.err_like('W5 a verifier cannot change settings', $q$select public.finance_save_settings('{"adjustment_limit": 99999999}')$q$, '%not allowed%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.err_like('W5 a manager needs a real reason (10+ characters)', format($q$select public.finance_wallet_adjust(%L, 'credit', 100, 'short', 'adj-short-0001')$q$, pg_temp.c('cust')), '%REASON_TOO_SHORT%');
select pg_temp.err_like('W5 a manager above the limit needs a SUPER_ADMIN', format($q$select public.finance_wallet_adjust(%L, 'credit', 6000, 'goodwill credit for the delayed order', 'adj-big-000001')$q$, pg_temp.c('cust')), '%ADJUSTMENT_NEEDS_SUPER_ADMIN%');
insert into t_res (test, ok, detail) select 'W5 a manager adjusts within the limit (credit 500)', (public.finance_wallet_adjust(pg_temp.c('cust')::uuid, 'credit', 500, 'goodwill credit for the delayed order', 'adj-ok-0000001', 'ของขวัญจากร้าน') ->> 'balance')::numeric = 3290, null;
insert into t_res (test, ok, detail) select 'W5 the same adjustment key does not apply twice', (public.finance_wallet_adjust(pg_temp.c('cust')::uuid, 'credit', 500, 'goodwill credit for the delayed order', 'adj-ok-0000001', 'ของขวัญจากร้าน') ->> 'balance')::numeric = 3290
  and (select balance from public.finance_wallets where customer_id = pg_temp.c('cust')::uuid) = 3290, null;
select pg_temp.err_like('W5 the same key with another amount is refused', format($q$select public.finance_wallet_adjust(%L, 'credit', 900, 'goodwill credit for the delayed order', 'adj-ok-0000001')$q$, pg_temp.c('cust')), '%KEY_REUSED%');
select pg_temp.err_like('W5 a debit adjustment cannot take the wallet below zero', format($q$select public.finance_wallet_adjust(%L, 'debit', 4000, 'correct a wrong credit by mistake', 'adj-debit-00001')$q$, pg_temp.c('cust')), '%INSUFFICIENT_FUNDS%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'W5 a SUPER_ADMIN can adjust above the limit', (public.finance_wallet_adjust(pg_temp.c('cust')::uuid, 'credit', 6000, 'approved compensation for a lost parcel', 'adj-big-super-1') ->> 'balance')::numeric = 9290, null;
insert into t_ctx select 'adjtxn', (select id::text from public.finance_wallet_transactions where idempotency_key = 'ADJ:adj-big-super-1');
insert into t_res (test, ok, detail) select 'W5 the adjustment records who did it and why', (select created_by = pg_temp.c('S')::uuid and approved_by = pg_temp.c('S')::uuid and remarks like 'approved compensation%' and txn_type = 'ADJUSTMENT' from public.finance_wallet_transactions where id = pg_temp.c('adjtxn')::uuid), null;
insert into t_res (test, ok, detail) select 'W5 every wallet movement is in the audit trail', (select count(*) from public.finance_events where entity = 'wallet') = (select count(*) from public.finance_wallet_transactions), (select count(*) from public.finance_events where entity = 'wallet') || ' events / ' || (select count(*) from public.finance_wallet_transactions) || ' txns';
select pg_temp.err_like('W5 a reversal needs a reason', format($q$select public.finance_wallet_reverse(%L, 'oops')$q$, pg_temp.c('adjtxn')), '%REASON_TOO_SHORT%');
insert into t_ctx select 'rev1', public.finance_wallet_reverse(pg_temp.c('adjtxn')::uuid, 'the compensation was approved by mistake')::text;
insert into t_res (test, ok, detail) select 'W5 a mistaken adjustment is corrected by a reversal row (not an edit)', ((v::jsonb) ->> 'balance')::numeric = 3290
  and (select count(*) from public.finance_wallet_transactions where reversal_of = pg_temp.c('adjtxn')::uuid and txn_type = 'REVERSAL' and direction = 'debit') = 1, v from t_ctx where k = 'rev1';
select pg_temp.err_like('W5 a transaction can be reversed only once', format($q$select public.finance_wallet_reverse(%L, 'trying to reverse it again')$q$, pg_temp.c('adjtxn')), '%already reversed%');
select pg_temp.err_like('W5 a reversal cannot be reversed', format($q$select public.finance_wallet_reverse((select id from public.finance_wallet_transactions where reversal_of = %L), 'reverse the reversal now')$q$, pg_temp.c('adjtxn')), '%reversal cannot be reversed%');
select pg_temp.err_like('W5 an invoice payment is corrected through its receipt', format($q$select public.finance_wallet_reverse((select id from public.finance_wallet_transactions where ref_id = %L and txn_type = 'INVOICE_PAYMENT'), 'wrong invoice was paid')$q$, pg_temp.c('inv1')), '%USE_RECEIPT_REVERSAL%');
select pg_temp.err_like('W5 reversing a deposit is refused when the money is already spent', format($q$select public.finance_wallet_reverse((select id from public.finance_wallet_transactions where txn_type = 'DEPOSIT'), 'deposit was credited by mistake')$q$), '%INSUFFICIENT_FUNDS%');
-- the receipt of a wallet payment is reversed: the money goes back into the wallet
insert into t_ctx select 'rrev', public.finance_reverse_receipt((select id from public.finance_receipts where invoice_id = pg_temp.c('inv1')::uuid and wallet_txn_id is not null), 'paid the wrong invoice')::text;
insert into t_res (test, ok, detail) select 'W5 reversing a wallet receipt returns the money to the wallet and reopens the invoice', (((v::jsonb) ->> 'outstanding')::numeric = 2000)
  and (select balance from public.finance_wallets where customer_id = pg_temp.c('cust')::uuid) = 5290, v from t_ctx where k = 'rrev';
select pg_temp.err_like('W5 a refund is not needed after a wallet receipt reversal', format($q$select public.finance_wallet_refund((select id from public.finance_receipts where invoice_id = %L and wallet_txn_id is not null), 100, 'again', 'refund-wallet-01')$q$, pg_temp.c('inv1')), '%REFUND_NOT_NEEDED%');
-- a bank receipt: reverse it, then keep the money as wallet credit
select pg_temp.err_like('W5 a refund needs the receipt to be reversed first', format($q$select public.finance_wallet_refund((select id from public.finance_receipts where evidence_id = %L), 100, 'refund', 'refund-bank-0001')$q$, pg_temp.c('ev3')), '%REFUND_NEEDS_REVERSED_RECEIPT%');
select public.finance_reverse_receipt((select id from public.finance_receipts where evidence_id = pg_temp.c('ev3')::uuid), 'slip was for a different order');
select pg_temp.err_like('W5 a refund cannot exceed the reversed receipt', format($q$select public.finance_wallet_refund((select id from public.finance_receipts where evidence_id = %L), 501, 'too much', 'refund-bank-0002')$q$, pg_temp.c('ev3')), '%AMOUNT_EXCEEDS_REFUNDABLE%');
insert into t_res (test, ok, detail) select 'W5 refund of a reversed bank receipt credits the wallet (REFUND, via the same bank)', (public.finance_wallet_refund((select id from public.finance_receipts where evidence_id = pg_temp.c('ev3')::uuid), 500, 'keep the money as credit', 'refund-bank-0003') ->> 'balance')::numeric = 5790, null;
insert into t_res (test, ok, detail) select 'W5 the same refund key does not credit twice', (public.finance_wallet_refund((select id from public.finance_receipts where evidence_id = pg_temp.c('ev3')::uuid), 500, 'keep the money as credit', 'refund-bank-0003') ->> 'balance')::numeric = 5790, null;
select pg_temp.err_like('W5 nothing left to refund', format($q$select public.finance_wallet_refund((select id from public.finance_receipts where evidence_id = %L), 1, 'more', 'refund-bank-0004')$q$, pg_temp.c('ev3')), '%AMOUNT_EXCEEDS_REFUNDABLE%');
reset role;
insert into t_res (test, ok, detail) select 'W5 the refund is queued: Dr BBL / Cr customer credit', (select q.plan -> 0 ->> 'role' = 'bank' and q.plan -> 0 ->> 'bank_account_id' = pg_temp.c('bbl') and q.plan -> 1 ->> 'role' = 'customer_credit' and q.plan -> 0 ->> 'side' = 'dr'
  from public.finance_gl_queue q where q.event_type = 'WALLET_REFUND'), null;

-- =========================================================================================== W6 reconciliation: ledger = balance, and ledger = GL queue
insert into t_ctx select 'rec', public.finance_wallet_reconcile()::text from (select set_config('request.jwt.claims', json_build_object('sub', pg_temp.c('S'), 'role', 'authenticated')::text, true)) z;
insert into t_res (test, ok, detail) select 'W6 wallet balances equal the ledger and the chain is unbroken', jsonb_array_length((v::jsonb) -> 'problems') = 0 and ((v::jsonb) ->> 'balance_total')::numeric = ((v::jsonb) ->> 'ledger_total')::numeric, v from t_ctx where k = 'rec';
insert into t_ctx select 'glrec', public.finance_gl_reconciliation()::text;
insert into t_res (test, ok, detail) select 'W6 wallet money in the ledger queue equals the wallet balances (difference 0)', ((v::jsonb) ->> 'difference')::numeric = 0 and ((v::jsonb) ->> 'wallet_balances')::numeric = 5790, v from t_ctx where k = 'glrec';
insert into t_res (test, ok, detail) select 'W6 every queued plan balances (debits = credits)', (select bool_and((select sum((l ->> 'amount')::numeric) filter (where l ->> 'side' = 'dr') = sum((l ->> 'amount')::numeric) filter (where l ->> 'side' = 'cr') from jsonb_array_elements(q.plan) l)) from public.finance_gl_queue q where q.event_type not in ('INVOICE_ISSUE', 'INVOICE_CANCEL')), null;
insert into t_res (test, ok, detail) select 'W6 each wallet ledger row has its ledger-queue row', (select count(*) from public.finance_wallet_transactions t where not exists (select 1 from public.finance_gl_queue q where q.ref_type = 'wallet_txn' and q.ref_id = t.id)) = 0, null;
-- A spend of the whole remaining balance leaves exactly zero, never below
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'inv4', (public.finance_create_invoice(pg_temp.c('cust')::uuid, 5790, null, null, 'Test invoice 4 = the whole wallet', 'TEST-4')).id::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'W6 spending the whole balance leaves exactly 0', (public.finance_pay_invoice_with_wallet(pg_temp.c('inv4')::uuid, 5790, 'inv-pay-all-0001') ->> 'balance')::numeric = 0, null;
select pg_temp.err_like('W6 an empty wallet pays nothing', format($q$select public.finance_pay_invoice_with_wallet(%L, 1, 'inv-pay-empty-1')$q$, pg_temp.c('inv2')), '%INSUFFICIENT_FUNDS%');

-- =========================================================================================== W7 customer-facing history
insert into t_ctx select 'hist', public.finance_my_wallet_transactions(50, 0)::text;
insert into t_res (test, ok, detail) select 'W7 history shows every movement (9), newest first, with balances', ((v::jsonb) ->> 'total')::int = 9 and (v::jsonb) -> 'items' -> 0 ->> 'txn_type' = 'INVOICE_PAYMENT'
  and ((v::jsonb) -> 'items' -> 0 ->> 'balance_after')::numeric = 0, v from t_ctx where k = 'hist';
insert into t_res (test, ok, detail) select 'W7 history never exposes internal remarks or staff ids', not ((v::text) ~ 'created_by|approved_by|remarks|goodwill|compensation|reversed by mistake|wrong invoice'), null from t_ctx where k = 'hist';
insert into t_res (test, ok, detail) select 'W7 totals: deposits and payments', ((public.finance_my_wallet() ->> 'total_deposits')::numeric = 4990) and ((public.finance_my_wallet() ->> 'total_payments')::numeric = 2000 + 200 + 5790 + 0), public.finance_my_wallet()::text;
insert into t_res (test, ok, detail) select 'W7 pagination works', jsonb_array_length(public.finance_my_wallet_transactions(3, 0) -> 'items') = 3 and public.finance_my_wallet_transactions(3, 0) -> 'items' -> 0 ->> 'id' <> public.finance_my_wallet_transactions(3, 3) -> 'items' -> 0 ->> 'id', null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'W7 customer B''s wallet and history are empty', (public.finance_my_wallet() ->> 'balance')::numeric = 0 and jsonb_array_length(public.finance_my_wallet_transactions() -> 'items') = 0, null;
insert into t_res (test, ok, detail) select 'W7 customer B cannot read A''s ledger, wallet or queue rows directly', (select count(*) from public.finance_wallet_transactions) = 0 and (select count(*) from public.finance_wallets) = 0 and (select count(*) from public.finance_gl_queue) = 0
  and (select count(*) from public.finance_wallet_deposits) = 0 and (select count(*) from public.finance_settings) = 0, null;
select pg_temp.err_like('W7 customer B cannot see the staff overview', $q$select public.finance_wallets_overview()$q$, '%not allowed%');
select pg_temp.err_like('W7 customer B cannot see the payments overview', $q$select public.finance_payments_overview()$q$, '%not allowed%');
select pg_temp.err_like('W7 customer B cannot see the bank report', $q$select public.finance_bank_daily_report(current_date - 30, current_date)$q$, '%not allowed%');
select pg_temp.err_like('W7 customer B cannot read the ledger queue', $q$select public.finance_gl_pending()$q$, '%not allowed%');

-- =========================================================================================== W8 ledger queue: dependencies, idempotent posting, voiding
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'glp', public.finance_gl_pending('pending', 200)::text;
insert into t_res (test, ok, detail) select 'W8 staff see the pending rows with who they wait for', (select count(*) from jsonb_array_elements((v::jsonb) -> 'items') i where i -> 'blocked_by' <> 'null'::jsonb) >= 1, null from t_ctx where k = 'glp';
select pg_temp.err_like('W8 a payment cannot be marked posted before its invoice', format($q$select public.finance_gl_mark_posted((select id from public.finance_gl_queue where event_type = 'WALLET_PAYMENT' and amount = 2000), 'JV-1', 'FINQ:pay')$q$), '%DEPENDENCY_NOT_POSTED%');
select public.finance_gl_mark_posted((select id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = pg_temp.c('inv1')::uuid), 'JV-100', 'FINQ:inv1');
select public.finance_gl_mark_posted((select id from public.finance_gl_queue where event_type = 'WALLET_PAYMENT' and amount = 2000), 'JV-101', 'FINQ:pay1');
insert into t_res (test, ok, detail) select 'W8 once its invoice is posted the payment can be', (select status = 'posted' and journal_no = 'JV-101' from public.finance_gl_queue where event_type = 'WALLET_PAYMENT' and amount = 2000), null;
select public.finance_gl_mark_posted((select id from public.finance_gl_queue where event_type = 'WALLET_PAYMENT' and amount = 2000), 'JV-101', 'FINQ:pay1');
insert into t_res (test, ok, detail) select 'W8 confirming the same posting twice is harmless (same row, same journal)', (select status = 'posted' and journal_no = 'JV-101' and posted_ref = 'FINQ:pay1' from public.finance_gl_queue where event_type = 'WALLET_PAYMENT' and amount = 2000), null;
select pg_temp.err_like('W8 a different posting reference on a posted row is refused (no double posting)', format($q$select public.finance_gl_mark_posted((select id from public.finance_gl_queue where event_type = 'WALLET_PAYMENT' and amount = 2000), 'JV-999', 'FINQ:other')$q$), '%ALREADY_POSTED%');
select pg_temp.err_like('W8 one posting reference cannot be used for two rows', format($q$select public.finance_gl_mark_posted((select id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = %L), 'JV-102', 'FINQ:pay1')$q$, pg_temp.c('inv2')), '%duplicate key%');
select pg_temp.err_like('W8 a posted row cannot be voided', format($q$select public.finance_gl_void((select id from public.finance_gl_queue where event_type = 'WALLET_PAYMENT' and amount = 2000), 'trying to hide a posted row')$q$), '%Only a row that has not been posted%');
select pg_temp.err_like('W8 a queue row cannot be edited through the API', $q$update public.finance_gl_queue set amount = 1$q$, '%permission denied%');
select pg_temp.err_like('W8 a queue row cannot be deleted through the API', $q$delete from public.finance_gl_queue$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W8 a customer cannot mark rows posted', $q$select public.finance_gl_mark_posted(gen_random_uuid(), 'JV-1', 'x')$q$, '%not allowed%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
-- cancelling an invoice that is not yet in the ledger removes it from the queue; cancelling a posted one queues a reversal
insert into t_ctx select 'inv5', (public.finance_create_invoice(pg_temp.c('cust')::uuid, 123, null, null, 'To be cancelled early', 'TEST-5')).id::text;
select public.finance_cancel_invoice(pg_temp.c('inv5')::uuid, 'created by mistake');
select public.finance_cancel_invoice(pg_temp.c('inv2')::uuid, 'customer changed their mind');
reset role;
insert into t_res (test, ok, detail) select 'W8 an invoice cancelled BEFORE posting is voided in the queue (nothing reaches the ledger)', (select status = 'void' from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = pg_temp.c('inv5')::uuid)
  and not exists (select 1 from public.finance_gl_queue where event_type = 'INVOICE_CANCEL' and ref_id = pg_temp.c('inv5')::uuid), null;
-- (inv2 was never posted either: also void)
insert into t_res (test, ok, detail) select 'W8 the same for an unposted invoice with no payments', (select status = 'void' from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = pg_temp.c('inv2')::uuid), null;

-- =========================================================================================== W9 staff reports
set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
insert into t_res (test, ok, detail) select 'W9 a verifier can see payments, filtered by bank', (public.finance_payments_overview(p_bank => pg_temp.c('bbl')::uuid) ->> 'total')::int >= 1
  and (select bool_and(i ->> 'bank_code' = 'BBL') from jsonb_array_elements(public.finance_payments_overview(p_bank => pg_temp.c('bbl')::uuid) -> 'items') i), null;
insert into t_res (test, ok, detail) select 'W9 filter by status (rejected) finds the rejected deposit only', (select bool_and(i ->> 'status' = 'rejected') from jsonb_array_elements(public.finance_payments_overview(p_status => 'rejected') -> 'items') i)
  and (public.finance_payments_overview(p_status => 'rejected') ->> 'total')::int >= 1, null;
insert into t_res (test, ok, detail) select 'W9 search by invoice number', (public.finance_payments_overview(p_search => (select invoice_no from public.finance_invoices where id = pg_temp.c('inv3')::uuid)) ->> 'total')::int >= 2, null;
insert into t_res (test, ok, detail) select 'W9 search by customer name', (public.finance_payments_overview(p_search => (select left(name, 3) from public.finance_customers where id = pg_temp.c('cust')::uuid)) ->> 'total')::int >= 4, null;
insert into t_res (test, ok, detail) select 'W9 filter by kind', (select bool_and(i ->> 'kind' = 'wallet_payment') from jsonb_array_elements(public.finance_payments_overview(p_kind => 'wallet_payment') -> 'items') i), null;
insert into t_res (test, ok, detail) select 'W9 search treats % literally', (public.finance_payments_overview(p_search => '%') ->> 'total')::int = 0, null;
insert into t_res (test, ok, detail) select 'W9 wallet overview shows balances and totals', (public.finance_wallets_overview() ->> 'total')::int >= 1 and ((public.finance_wallets_overview() ->> 'sum_balance')::numeric = 0), public.finance_wallets_overview()::text;
insert into t_res (test, ok, detail) select 'W9 the ledger of one customer, with who did what', (public.finance_wallet_ledger(pg_temp.c('cust')::uuid, 100, 0) ->> 'total')::int = (select count(*) from public.finance_wallet_transactions)
  and (select bool_or(i ->> 'approved_by_email' is not null) from jsonb_array_elements(public.finance_wallet_ledger(pg_temp.c('cust')::uuid, 100, 0) -> 'items') i), null;
insert into t_ctx select 'bank', public.finance_bank_daily_report(current_date - 1, current_date + 1)::text;
insert into t_res (test, ok, detail) select 'W9 daily bank report: SCB deposit 4990 and the BBL invoice transfer (reversed receipts excluded)', (select (r ->> 'deposit_amount')::numeric = 4990 from jsonb_array_elements((v::jsonb)) r where r ->> 'bank_code' = 'SCB')
  and not exists (select 1 from jsonb_array_elements((v::jsonb)) r where r ->> 'bank_code' = 'BBL' and (r ->> 'invoice_amount')::numeric > 0), v from t_ctx where k = 'bank';
insert into t_res (test, ok, detail) select 'W9 the bank report says what is not yet in the ledger', (select (r ->> 'waiting_for_ledger')::numeric = 4990 from jsonb_array_elements((v::jsonb)) r where r ->> 'bank_code' = 'SCB'), null from t_ctx where k = 'bank';
reset role;

-- =========================================================================================== W10 shop integration and old clients
insert into t_res (test, ok, detail) select 'W10 the shop treats an active bank account as a way to get paid', (select (public.shop_admin_settings() ->> 'payment_account_ready')::boolean from (select set_config('request.jwt.claims', json_build_object('sub', pg_temp.c('S'), 'role', 'authenticated')::text, true)) z), null;
insert into t_res (test, ok, detail) select 'W10 existing finance data was not touched by the migration', (select count(*) from public.finance_payment_accounts) = 0, null;

-- =========================================================================================== W11 limits
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
do $$ begin for i in 1..5 loop perform public.finance_deposit_create((select id from public.finance_bank_accounts where code = 'SCB'), 10 + i, 'open-key-000' || i); end loop; end $$;
select pg_temp.err_like('W11 too many open deposits are refused', format($q$select public.finance_deposit_create(%L, 99, 'open-key-0009')$q$, pg_temp.c('scb')), '%TOO_MANY_OPEN_DEPOSITS%');
reset role;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'WALLET_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
