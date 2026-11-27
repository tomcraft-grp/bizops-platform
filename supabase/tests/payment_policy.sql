-- Tests for 20261127100000_customer_payment_policy.sql and 20261127110000_wallet_deposit_qr.sql, after both migrations in ONE transaction that always rolls back
-- (scripts/run-payment-policy-sql-tests.sh). S = a real SUPER_ADMIN (finance manager); A and B = the app profiles of two real central customers; U = a real USER profile with no finance role.
-- Invoices, wallets, deposits, payments and events created here disappear with the rollback.
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
-- a sha256-looking value that is unique per call
create or replace function pg_temp.sha(n text) returns text language sql as $$ select md5('policy-test-' || n) || md5('policy-test-b-' || n) $$;

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('U', (select p.id::text from public.profiles p where p.role = 'USER' and p.status = 'active' and not exists (select 1 from public.finance_customers c where c.profile_id = p.id)
                           and not exists (select 1 from public.finance_staff_roles r where r.user_id = p.id) order by p.created_at limit 1));
select pg_temp.put('CA', (select c.id::text from public.finance_customers c join public.profiles p on p.id = c.profile_id where p.status = 'active' and p.role = 'USER' order by c.created_at limit 1));
select pg_temp.put('CB', (select c.id::text from public.finance_customers c join public.profiles p on p.id = c.profile_id where p.status = 'active' and p.role = 'USER' and c.id <> pg_temp.c('CA')::uuid order by c.created_at limit 1));
select pg_temp.put('A', (select profile_id::text from public.finance_customers where id = pg_temp.c('CA')::uuid));
select pg_temp.put('B', (select profile_id::text from public.finance_customers where id = pg_temp.c('CB')::uuid));
select pg_temp.chk('fixtures ready', (select count(*) from t_ctx where v is not null) = 6, (select string_agg(k || '=' || coalesce(v, 'NULL'), ',') from t_ctx));
-- the invoices: PA (partial-policy slip tests), PF (full-policy slip tests), PW (wallet), PC (cancelled), PB (customer B's)
insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description) values
  ('TEST-PP-A', pg_temp.c('CA')::uuid, current_date - 1, current_date + 30, 1000, 'partial slip tests'),
  ('TEST-PP-F', pg_temp.c('CA')::uuid, current_date - 1, current_date + 30, 1000, 'full slip tests'),
  ('TEST-PP-W', pg_temp.c('CA')::uuid, current_date - 1, current_date + 30, 1000, 'wallet tests'),
  ('TEST-PP-C', pg_temp.c('CA')::uuid, current_date - 1, current_date + 30, 1000, 'cancelled'),
  ('TEST-PP-S', pg_temp.c('CA')::uuid, current_date - 1, current_date + 30, 1000, 'staff entry'),
  ('TEST-PP-G', pg_temp.c('CA')::uuid, current_date - 1, current_date + 30, 1000, 'full over-claim'),
  ('TEST-PP-B', pg_temp.c('CB')::uuid, current_date - 1, current_date + 30, 500, 'other customer');
select pg_temp.put('IA', (select id::text from public.finance_invoices where invoice_no = 'TEST-PP-A'));
select pg_temp.put('IF', (select id::text from public.finance_invoices where invoice_no = 'TEST-PP-F'));
select pg_temp.put('IW', (select id::text from public.finance_invoices where invoice_no = 'TEST-PP-W'));
select pg_temp.put('IC', (select id::text from public.finance_invoices where invoice_no = 'TEST-PP-C'));
select pg_temp.put('IS', (select id::text from public.finance_invoices where invoice_no = 'TEST-PP-S'));
select pg_temp.put('IB', (select id::text from public.finance_invoices where invoice_no = 'TEST-PP-B'));
select pg_temp.put('IG', (select id::text from public.finance_invoices where invoice_no = 'TEST-PP-G'));
-- TEST-ONLY (rolled back): lets the checks read an invoice's balance while acting as a user; the functions under test are SECURITY DEFINER and do not need it
grant execute on function public.finance_invoice_state_raw(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------ migration defaults
select pg_temp.chk('M1 every existing customer is on the partial policy (today''s behaviour)', (select count(*) from public.finance_customers where payment_policy <> 'partial') = 0
  and (select count(*) from public.finance_customers) > 0);
select pg_temp.chk('M1 the column is NOT NULL and only partial/full are accepted',
  (select is_nullable = 'NO' from information_schema.columns where table_name = 'finance_customers' and column_name = 'payment_policy'));
select pg_temp.err_like('M1 a direct write of another value is refused', format('update public.finance_customers set payment_policy = %L where id = %L', 'sometimes', pg_temp.c('CA')), '%payment_policy_chk%');

-- ------------------------------------------------------------------------------------------------ who may read and change the policy
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('P1 a customer sees their own policy (partial by default)', public.finance_my_payment_policy() = 'partial');
select pg_temp.err_like('P1 a customer cannot change a policy', format('select public.finance_set_payment_policy(%L::uuid, %L, %L)', pg_temp.c('CA'), 'full', 'I want it'), '%not allowed%');
select pg_temp.err_like('P1 a customer cannot list policies', $q$select public.finance_customer_policies()$q$, '%not allowed%');
select pg_temp.as_user(pg_temp.c('U')::uuid);
select pg_temp.err_like('P1 a user without a finance role cannot change a policy', format('select public.finance_set_payment_policy(%L::uuid, %L, %L)', pg_temp.c('CA'), 'full', 'no role'), '%not allowed%');
select pg_temp.chk('P1 a user who is not a customer gets partial (never null)', public.finance_my_payment_policy() = 'partial');
reset role;
select pg_temp.chk('P1 anon can run none of the new functions',
  not has_function_privilege('anon', 'public.finance_set_payment_policy(uuid, text, text)', 'execute') and not has_function_privilege('anon', 'public.finance_my_payment_policy()', 'execute')
  and not has_function_privilege('anon', 'public.finance_customer_policies(uuid[], text, integer)', 'execute') and not has_function_privilege('anon', 'public.finance_deposit_qr(uuid)', 'execute'));

set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('P2 an unknown policy is refused', format('select public.finance_set_payment_policy(%L::uuid, %L, %L)', pg_temp.c('CA'), 'monthly', 'valid reason'), '%INVALID_POLICY%');
select pg_temp.err_like('P2 a reason is required', format('select public.finance_set_payment_policy(%L::uuid, %L, %L)', pg_temp.c('CA'), 'full', ' '), '%REASON_REQUIRED%');
select pg_temp.err_like('P2 an unknown customer is refused', format('select public.finance_set_payment_policy(%L::uuid, %L, %L)', gen_random_uuid(), 'full', 'valid reason'), '%NOT_FOUND%');
select pg_temp.chk('P2 setting the same policy changes nothing', (public.finance_set_payment_policy(pg_temp.c('CA')::uuid, 'partial', 'same again') ->> 'changed')::boolean = false);
select pg_temp.put('OA0', (select (x ->> 'open_amount') from jsonb_array_elements(public.finance_customer_policies(array[pg_temp.c('CA')::uuid])) x));
select pg_temp.chk('P3 the manager lists customers with their policy and what they owe (the customer may have real open invoices too)',
  (select (x ->> 'payment_policy') = 'partial' and (x ->> 'open_amount')::numeric >= 6000 from jsonb_array_elements(public.finance_customer_policies(array[pg_temp.c('CA')::uuid])) x));
reset role;
select pg_temp.chk('P2 an unchanged policy writes no event', not exists (select 1 from public.finance_events where action = 'customer.payment_policy' and entity_id = pg_temp.c('CA')::uuid));

-- ------------------------------------------------------------------------------------------------ partial policy: slips as before
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('S1 partial: a slip for part of the invoice is accepted (as today)',
  public.finance_submit_evidence(pg_temp.c('IA')::uuid, pg_temp.c('A') || '/2026-11-27/a1.png', pg_temp.sha('a1'), 'image/png', 300, now(), 'TEST', 'REF1', null) is not null);
select pg_temp.chk('S1 partial: a second slip while the first waits is accepted (up to 5, as today)',
  public.finance_submit_evidence(pg_temp.c('IA')::uuid, pg_temp.c('A') || '/2026-11-27/a2.png', pg_temp.sha('a2'), 'image/png', 700, now(), 'TEST', 'REF2', null) is not null);
select pg_temp.err_like('S2 an amount with fractions of a satang is refused', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 100.005, now(), null, null, null)', pg_temp.c('IA'), pg_temp.c('A') || '/2026-11-27/a3.png', pg_temp.sha('a3'), 'image/png'), '%INVALID_AMOUNT%');
select pg_temp.err_like('S2 a zero amount is refused', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 0, now(), null, null, null)', pg_temp.c('IA'), pg_temp.c('A') || '/2026-11-27/a4.png', pg_temp.sha('a4'), 'image/png'), '%INVALID_AMOUNT%');
select pg_temp.err_like('S3 another customer''s invoice is refused', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 100, now(), null, null, null)', pg_temp.c('IB'), pg_temp.c('A') || '/2026-11-27/a5.png', pg_temp.sha('a5'), 'image/png'), '%Invoice not found%');
reset role;

-- ------------------------------------------------------------------------------------------------ full policy: slips
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('F0 the manager sets the full-payment policy', (public.finance_set_payment_policy(pg_temp.c('CA')::uuid, 'full', 'wholesale terms') ->> 'changed')::boolean);
reset role;
select pg_temp.chk('F0 the change is in the history: from, to, reason',
  (select detail ->> 'from' = 'partial' and detail ->> 'to' = 'full' and detail ->> 'reason' = 'wholesale terms' from public.finance_events where action = 'customer.payment_policy' and entity_id = pg_temp.c('CA')::uuid));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('F0 the customer now sees full', public.finance_my_payment_policy() = 'full');
select pg_temp.err_like('F1 a slip for part of the invoice is refused, the message says what is owed', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 300, now(), null, null, null)', pg_temp.c('IF'), pg_temp.c('A') || '/2026-11-27/f1.png', pg_temp.sha('f1'), 'image/png'), '%FULL_PAYMENT_REQUIRED%1000%');
select pg_temp.chk('F1 a slip for MORE than is owed is accepted (the excess is credited to the wallet at verification: money already sent is never refused)',
  public.finance_submit_evidence(pg_temp.c('IG')::uuid, pg_temp.c('A') || '/2026-11-27/f2.png', pg_temp.sha('f2'), 'image/png', 1500, now(), 'TEST', 'REFF2', null) is not null);
select pg_temp.chk('F2 a slip for exactly the outstanding amount is accepted',
  public.finance_submit_evidence(pg_temp.c('IF')::uuid, pg_temp.c('A') || '/2026-11-27/f3.png', pg_temp.sha('f3'), 'image/png', 1000, now(), 'TEST', 'REFF3', null) is not null);
select pg_temp.err_like('F3 a second slip for the same invoice while the first waits is refused (no double payment)', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 1000, now(), null, null, null)', pg_temp.c('IF'), pg_temp.c('A') || '/2026-11-27/f4.png', pg_temp.sha('f4'), 'image/png'), '%PAYMENT_ALREADY_PENDING%');
select pg_temp.err_like('F4 the same slip file again is still refused as a duplicate', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 1000, now(), null, null, null)', pg_temp.c('IW'), pg_temp.c('A') || '/2026-11-27/f5.png', pg_temp.sha('f3'), 'image/png'), '%already submitted%');
select pg_temp.err_like('F5 another customer''s invoice is still refused', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 500, now(), null, null, null)', pg_temp.c('IB'), pg_temp.c('A') || '/2026-11-27/f6.png', pg_temp.sha('f6'), 'image/png'), '%Invoice not found%');
reset role;
-- staff reject the waiting slip: the customer may send a new one (the rule is about slips in flight, not about history)
update public.finance_payment_evidence set status = 'rejected', reject_reason = 'test', reviewed_by = pg_temp.c('S')::uuid, reviewed_at = now() where invoice_id = pg_temp.c('IF')::uuid;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('F6 after the slip is rejected a new full slip is accepted',
  public.finance_submit_evidence(pg_temp.c('IF')::uuid, pg_temp.c('A') || '/2026-11-27/f7.png', pg_temp.sha('f7'), 'image/png', 1000, now(), 'TEST', 'REFF7', null) is not null);
reset role;

-- ------------------------------------------------------------------------------------------------ the wallet (full policy first, then partial)
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_wallet_adjust(pg_temp.c('CA')::uuid, 'credit', 5000, 'test credit for the policy tests', 'policy-test-key-0001', null);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W1 full: paying part of the invoice from the wallet is refused', format('select public.finance_pay_invoice_with_wallet(%L::uuid, 300, %L)', pg_temp.c('IW'), 'policy-wallet-key-01'), '%FULL_PAYMENT_REQUIRED%1000%');
select pg_temp.chk('W1 nothing was charged by the refused payment', (select balance = 5000 from public.finance_wallets where customer_id = pg_temp.c('CA')::uuid));
select pg_temp.put('W2', public.finance_pay_invoice_with_wallet(pg_temp.c('IW')::uuid, null, 'policy-wallet-key-02')::text);
select pg_temp.chk('W2 full: paying without an amount pays the whole outstanding amount from the wallet',
  (pg_temp.c('W2')::jsonb ->> 'replay')::boolean = false and (pg_temp.c('W2')::jsonb ->> 'balance')::numeric = 4000 and (public.finance_invoice_state_raw(pg_temp.c('IW')::uuid) ->> 'outstanding')::numeric = 0, pg_temp.c('W2'));
select pg_temp.chk('W3 the same request again is a replay: charged once (balance still 4000)',
  (select (r ->> 'replay')::boolean and (r ->> 'balance')::numeric = 4000 from (select public.finance_pay_invoice_with_wallet(pg_temp.c('IW')::uuid, null, 'policy-wallet-key-02') as r) q));
select pg_temp.err_like('W3 a new request on the fully paid invoice is refused (nothing left to pay)', format('select public.finance_pay_invoice_with_wallet(%L::uuid, null, %L)', pg_temp.c('IW'), 'policy-wallet-key-03'), '%NOTHING_OUTSTANDING%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_cancel_invoice(pg_temp.c('IC')::uuid, 'cancelled for the test');
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('W4 a cancelled invoice cannot be paid from the wallet', format('select public.finance_pay_invoice_with_wallet(%L::uuid, null, %L)', pg_temp.c('IC'), 'policy-wallet-key-04'), '%INVOICE_NOT_OPEN%');
select pg_temp.err_like('W4 nor with a slip', format('select public.finance_submit_evidence(%L::uuid, %L, %L, %L, 1000, now(), null, null, null)', pg_temp.c('IC'), pg_temp.c('A') || '/2026-11-27/c1.png', pg_temp.sha('c1'), 'image/png'), '%cancelled%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_set_payment_policy(pg_temp.c('CA')::uuid, 'partial', 'back to instalments');
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.put('W5', public.finance_pay_invoice_with_wallet(pg_temp.c('IA')::uuid, 300, 'policy-wallet-key-05')::text);
select pg_temp.chk('W5 partial: a part payment from the wallet works as before (300 of 1000)',
  (pg_temp.c('W5')::jsonb ->> 'balance')::numeric = 3700 and (public.finance_invoice_state_raw(pg_temp.c('IA')::uuid) ->> 'outstanding')::numeric = 700, pg_temp.c('W5') || ' / ' || public.finance_invoice_state_raw(pg_temp.c('IA')::uuid)::text);
select pg_temp.err_like('W5 partial: still never more than the outstanding amount', format('select public.finance_pay_invoice_with_wallet(%L::uuid, 701, %L)', pg_temp.c('IA'), 'policy-wallet-key-06'), '%AMOUNT_EXCEEDS_OUTSTANDING%');
select pg_temp.put('W6', public.finance_pay_invoice_with_wallet(pg_temp.c('IA')::uuid, 700, 'policy-wallet-key-07')::text);
select pg_temp.chk('W5 partial: the rest in a second payment closes the invoice (instalments 300 + 700)',
  (pg_temp.c('W6')::jsonb ->> 'balance')::numeric = 3000 and (public.finance_invoice_state_raw(pg_temp.c('IA')::uuid) ->> 'outstanding')::numeric = 0, pg_temp.c('W6'));
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('W7 the staff list counts what is still owed, not the invoice amounts (A and W paid, C cancelled: 3000 less than at the start)',
  (select (x ->> 'open_amount')::numeric = pg_temp.c('OA0')::numeric - 3000 from jsonb_array_elements(public.finance_customer_policies(array[pg_temp.c('CA')::uuid])) x), (select (x ->> 'open_amount') from jsonb_array_elements(public.finance_customer_policies(array[pg_temp.c('CA')::uuid])) x) || ' vs start ' || pg_temp.c('OA0'));
reset role;

-- ------------------------------------------------------------------------------------------------ staff entries are not blocked, but the exception is on the record
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_set_payment_policy(pg_temp.c('CA')::uuid, 'full', 'staff entry test');
select pg_temp.put('SE', public.finance_record_payment(pg_temp.c('IS')::uuid, 'cash', 400, now(), null, null, 'Cash at the counter', p_idempotency_key => 'policy-staff-key-0001') ->> 'evidence_id');
select pg_temp.chk('T1 staff can record part of a full-payment customer''s invoice (real money was received)', pg_temp.c('SE') is not null);
reset role;
select pg_temp.chk('T1 and the exception is in the history, with what was entered and what was owed',
  (select (detail ->> 'outstanding')::numeric = 1000 and (detail ->> 'entered_so_far')::numeric = 400 from public.finance_events where action = 'policy.partial_by_staff' and entity_id = pg_temp.c('SE')::uuid),
  (select detail::text from public.finance_events where action = 'policy.partial_by_staff' and entity_id = pg_temp.c('SE')::uuid));
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.put('SE2', public.finance_record_payment(pg_temp.c('IS')::uuid, 'transfer', 600, now(), 'POLICYREF0001', null, 'Transfer for the rest', p_idempotency_key => 'policy-staff-key-0002') ->> 'evidence_id');
reset role;
select pg_temp.chk('T2 the entry that completes the invoice is not flagged', not exists (select 1 from public.finance_events where action = 'policy.partial_by_staff' and entity_id = pg_temp.c('SE2')::uuid));

-- ------------------------------------------------------------------------------------------------ a payment that leaves a balance for a full-payment customer is on the record
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_post_evidence(pg_temp.c('SE')::uuid, 'end of day'), public.finance_post_evidence(pg_temp.c('SE2')::uuid, 'end of day');
reset role;
select pg_temp.chk('T3 posting the 400 left 600 owed (logged); posting the 600 that settled the invoice logged nothing more',
  (select count(*) = 1 and bool_and((e.detail ->> 'outstanding')::numeric = 600) from public.finance_events e where e.action = 'policy.balance_left' and (e.detail ->> 'invoice')::uuid = pg_temp.c('IS')::uuid),
  (select string_agg(e.detail::text, ' | ') from public.finance_events e where e.action = 'policy.balance_left' and (e.detail ->> 'invoice')::uuid = pg_temp.c('IS')::uuid));

-- ------------------------------------------------------------------------------------------------ PromptPay QR for a wallet top-up (linked to a bank account by a manager)
select pg_temp.put('QRP', (select qr_payload from public.finance_payment_accounts where is_default and active));   -- read as the owner: customers cannot read this table
select pg_temp.put('QA', (select id::text from public.finance_payment_accounts where is_default and active));
select pg_temp.put('BK1', (select id::text from public.finance_bank_accounts where active order by sort_order, code limit 1));
select pg_temp.put('BK2', (select id::text from public.finance_bank_accounts where active order by sort_order desc, code desc limit 1));
select pg_temp.chk('Q0 two different bank accounts exist for the test', pg_temp.c('BK1') <> pg_temp.c('BK2'));
select pg_temp.chk('Q0 the live QR account is not linked yet (so no QR option shows until a manager links it)', (select bank_account_id is null from public.finance_payment_accounts where id = pg_temp.c('QA')::uuid));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('Q0 unlinked: the customer app is told there is no QR top-up', public.finance_deposit_qr_bank() is null);
select pg_temp.put('D0', (public.finance_deposit_create(pg_temp.c('BK1')::uuid, 100, 'policy-deposit-key-00', null) ->> 'id'));
select pg_temp.err_like('Q0 unlinked: no QR for a deposit', format('select public.finance_deposit_qr(%L::uuid)', pg_temp.c('D0')), '%QR_NOT_LINKED%');
select pg_temp.err_like('Q1 a customer cannot link the QR to a bank', format('select public.finance_set_payment_account_bank(%L::uuid, %L::uuid)', pg_temp.c('QA'), pg_temp.c('BK1')), '%not allowed%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('Q1 an unknown bank is refused', format('select public.finance_set_payment_account_bank(%L::uuid, gen_random_uuid())', pg_temp.c('QA')), '%BANK_NOT_AVAILABLE%');
select pg_temp.chk('Q1 the manager links the QR to a bank account', (public.finance_set_payment_account_bank(pg_temp.c('QA')::uuid, pg_temp.c('BK1')::uuid) ->> 'changed')::boolean);
select pg_temp.chk('Q1 linking the same bank again changes nothing', not (public.finance_set_payment_account_bank(pg_temp.c('QA')::uuid, pg_temp.c('BK1')::uuid) ->> 'changed')::boolean);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('Q2 linked: the customer app learns which bank account a QR deposit must use', (public.finance_deposit_qr_bank() ->> 'bank_account_id') = pg_temp.c('BK1'));
select pg_temp.put('D1', (public.finance_deposit_create(pg_temp.c('BK1')::uuid, 250, 'policy-deposit-key-01', null) ->> 'id'));
select pg_temp.put('Q1', public.finance_deposit_qr(pg_temp.c('D1')::uuid)::text);
select pg_temp.chk('Q2 the customer gets the shop''s PromptPay QR with the deposit amount in it',
  (pg_temp.c('Q1')::jsonb ->> 'amount')::numeric = 250 and (pg_temp.c('Q1')::jsonb ->> 'qr_payload') like '%250.00%' and (pg_temp.c('Q1')::jsonb ->> 'qr_payload') like '000201%'
  and (pg_temp.c('Q1')::jsonb ->> 'deposit_no') is not null, pg_temp.c('Q1'));
select pg_temp.chk('Q2 it is exactly the QR the invoice QR function builds for 250',
  (pg_temp.c('Q1')::jsonb ->> 'qr_payload') = public.finance_qr_with_amount(pg_temp.c('QRP'), 250));
select pg_temp.chk('Q3 a deposit created for the QR''s own bank account gets the QR', (public.finance_deposit_qr(pg_temp.c('D0')::uuid) ->> 'amount')::numeric = 100);
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_set_payment_account_bank(pg_temp.c('QA')::uuid, pg_temp.c('BK2')::uuid);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('Q3 once the QR belongs to ANOTHER bank account, a deposit created for the first one gets no QR (it would be booked to the wrong account)',
  format('select public.finance_deposit_qr(%L::uuid)', pg_temp.c('D0')), '%QR_NOT_FOR_THIS_BANK%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_set_payment_account_bank(pg_temp.c('QA')::uuid, pg_temp.c('BK1')::uuid);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('Q4 another customer cannot ask for this deposit''s QR', format('select public.finance_deposit_qr(%L::uuid)', pg_temp.c('D1')), '%Deposit not found%');
select pg_temp.as_user(pg_temp.c('A')::uuid);
select public.finance_deposit_cancel(pg_temp.c('D1')::uuid);
select pg_temp.err_like('Q5 a cancelled deposit has no QR', format('select public.finance_deposit_qr(%L::uuid)', pg_temp.c('D1')), '%DEPOSIT_NOT_PAYABLE%');
reset role;
select pg_temp.chk('Q5 asking for a QR changed nothing: one deposit per key, none created by the QR calls',
  (select count(*) from public.finance_wallet_deposits where customer_id = pg_temp.c('CA')::uuid and idempotency_key in ('policy-deposit-key-00', 'policy-deposit-key-01')) = 2);
select pg_temp.chk('Q5 the link is in the history', exists (select 1 from public.finance_events where action = 'account.bank_link' and entity_id = pg_temp.c('QA')::uuid));
update public.finance_payment_accounts set is_default = false where is_default;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('Q6 without a default QR account the app is told there is no QR top-up', public.finance_deposit_qr_bank() is null);
select pg_temp.err_like('Q6 and the deposit has no QR (the bank details stay)', format('select public.finance_deposit_qr(%L::uuid)', pg_temp.c('D0')), '%NO_PAYMENT_ACCOUNT%');
reset role;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'PAYMENT_POLICY_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
