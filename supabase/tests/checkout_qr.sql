-- Tests for 20261123100000_checkout_qr.sql, run inside one transaction that is rolled back (scripts/run-checkout-qr-sql-tests.sh, or the local harness):
--   <migration> ; <this file>
-- Nothing persists: the last statement raises an exception that carries the result table.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;

create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text;
begin
  begin execute p_sql; insert into t_res (test, ok, detail) values (p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; insert into t_res (test, ok, detail) values (p_test, m ilike p_pat, m);
  end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.items(n int) returns jsonb language sql as $$ select jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', n)) $$;

-- a known QR (a made-up e-wallet id, only inside this transaction), so nothing of the shop's real account is printed and the expected text can be computed
update public.finance_payment_accounts set is_default = false where is_default;
create or replace function pg_temp.qr_base() returns text language sql as $$
  select b || public.finance_crc16(b) from (select '000201' || '010211' || '2939' || '0016A000000677010111' || '0315' || '004999000000001' || '5303764' || '5802TH' || '6304' as b) x $$;
insert into public.finance_payment_accounts (label, qr_payload, kind, target, target_type, merchant_name, is_default)
  values ('TEST ACCOUNT', pg_temp.qr_base(), 'promptpay', '004999000000001', 'e_wallet', 'TEST MERCHANT', true);
insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'sku', sku_code from public.shop_sellable where available and coalesce(max_qty, 99) >= 3 order by sku_seq limit 1;
update public.shop_settings set shop_open = true, delivery_enabled = true, pickup_enabled = true, shipping_fee = 50, free_shipping_min = null where id;
insert into t_ctx select 'before', md5(concat_ws('|', (select count(*) from public.shop_orders), (select count(*) from public.finance_invoices), (select count(*) from public.finance_payment_requests), (select count(*) from public.finance_payment_evidence)));
insert into t_res (test, ok, detail) select 'C0 there is a shop member and a product', pg_temp.c('A') is not null and pg_temp.c('sku') is not null, null;

-- =========================================================================================== access
set local role anon;
select pg_temp.err_like('C1 anon cannot run it', $q$select public.shop_checkout_qr('[]'::jsonb, 'pickup')$q$, '%permission denied%');
reset role; set local role authenticated;
select set_config('request.jwt.claims', '{}', true);
select pg_temp.err_like('C1 without a signed-in user it refuses', $q$select public.shop_checkout_qr('[]'::jsonb, 'pickup')$q$, '%sign in%');
select pg_temp.as_user(pg_temp.c('A')::uuid);

-- =========================================================================================== the amount is the order's amount
insert into t_ctx select 'p1', public.shop_checkout_qr(pg_temp.items(1), 'pickup')::text;
insert into t_ctx select 'p2', public.shop_checkout_qr(pg_temp.items(2), 'pickup')::text;
insert into t_ctx select 'd2', public.shop_checkout_qr(pg_temp.items(2), 'delivery')::text;
insert into t_res (test, ok, detail) select 'C2 amount = the quote the customer sees (pick-up)', (pg_temp.c('p2')::jsonb ->> 'amount')::numeric = (public.shop_quote(pg_temp.items(2), 'pickup') ->> 'total')::numeric, pg_temp.c('p2')::jsonb ->> 'amount';
insert into t_res (test, ok, detail) select 'C2 amount = the quote the customer sees (delivery)', (pg_temp.c('d2')::jsonb ->> 'amount')::numeric = (public.shop_quote(pg_temp.items(2), 'delivery') ->> 'total')::numeric, pg_temp.c('d2')::jsonb ->> 'amount';
insert into t_res (test, ok, detail) select 'C2 delivery adds the fee', (pg_temp.c('d2')::jsonb ->> 'amount')::numeric = (pg_temp.c('p2')::jsonb ->> 'amount')::numeric + 50, null;
insert into t_res (test, ok, detail) select 'C2 an amount or account sent by the caller is ignored',
  public.shop_checkout_qr(jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', 1, 'unit_price', 0.01, 'amount', 1, 'qr_payload', 'x')), 'pickup') = pg_temp.c('p1')::jsonb, null;
insert into t_res (test, ok, detail) select 'C2 exactly four fields, nothing else leaks', (select array_agg(k order by k) from jsonb_object_keys(pg_temp.c('p1')::jsonb) k) = array['account_label', 'amount', 'merchant_name', 'qr_payload'], null;
insert into t_res (test, ok, detail) select 'C2 the label and merchant are the account''s', pg_temp.c('p1')::jsonb ->> 'account_label' = 'TEST ACCOUNT' and pg_temp.c('p1')::jsonb ->> 'merchant_name' = 'TEST MERCHANT', null;

-- =========================================================================================== refusals
select pg_temp.err_like('C3 an empty cart', $q$select public.shop_checkout_qr('[]'::jsonb, 'pickup')$q$, 'CART_EMPTY%');
select pg_temp.err_like('C3 an unknown product', $q$select public.shop_checkout_qr('[{"sku_code":"NOPE-1","qty":1}]'::jsonb, 'pickup')$q$, 'CART_INVALID%');
select pg_temp.err_like('C3 a bad quantity', format($q$select public.shop_checkout_qr('[{"sku_code":"%s","qty":0}]'::jsonb, 'pickup')$q$, pg_temp.c('sku')), 'CART_INVALID%');
select pg_temp.err_like('C3 a bad way of getting the order', format($q$select public.shop_checkout_qr('[{"sku_code":"%s","qty":1}]'::jsonb, 'teleport')$q$, pg_temp.c('sku')), 'CART_INVALID%');
reset role;

-- =========================================================================================== the QR itself: valid, for this account, with this amount
insert into t_res (test, ok, detail) select 'C4 a valid Thai QR (checksum, currency, country) with an amount', (public.finance_qr_describe(pg_temp.c('d2')::jsonb ->> 'qr_payload') ->> 'has_amount')::boolean, null;
insert into t_res (test, ok, detail) select 'C4 it pays the shop''s default account', public.finance_qr_describe(pg_temp.c('d2')::jsonb ->> 'qr_payload') ->> 'target' = '004999000000001', null;
insert into t_res (test, ok, detail) select 'C4 tag 54 is the amount', (select val from public.finance_qr_fields(pg_temp.c('d2')::jsonb ->> 'qr_payload') where tag = '54') = to_char((pg_temp.c('d2')::jsonb ->> 'amount')::numeric, 'FM9999999990.00'), (select val from public.finance_qr_fields(pg_temp.c('d2')::jsonb ->> 'qr_payload') where tag = '54');
insert into t_res (test, ok, detail) select 'C4 the same text the invoice QR would carry', pg_temp.c('d2')::jsonb ->> 'qr_payload' = public.finance_qr_with_amount(pg_temp.qr_base(), (pg_temp.c('d2')::jsonb ->> 'amount')::numeric), null;

-- =========================================================================================== it writes nothing
insert into t_res (test, ok, detail) select 'C5 no order, invoice, payment request or slip was created',
  pg_temp.c('before') = md5(concat_ws('|', (select count(*) from public.shop_orders), (select count(*) from public.finance_invoices), (select count(*) from public.finance_payment_requests), (select count(*) from public.finance_payment_evidence))), null;
insert into t_res (test, ok, detail) select 'C5 it is declared STABLE and SECURITY DEFINER', provolatile = 's' and prosecdef, null from pg_proc where proname = 'shop_checkout_qr';

-- =========================================================================================== end to end: pay first with the QR
update public.shop_settings set require_payment_slip = true where id;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'ord', public.shop_place_order('qr-test-key-0001', pg_temp.items(2), 'delivery', 'Test', '0812345678', null, null, (pg_temp.c('d2')::jsonb ->> 'amount')::numeric, 'qr',
  pg_temp.c('A') || '/orders/qr-test-key-0001.png', md5('qr-a') || md5('qr-b'), 'image/png', null, null)::text;
select pg_temp.err_like('C6 the slip rule still stands for a QR order', format($q$select public.shop_place_order('qr-test-key-0002', %L::jsonb, 'delivery', 'Test', '0812345678', null, null, null, 'qr')$q$, pg_temp.items(2)), 'SLIP_REQUIRED%');
reset role;
insert into t_res (test, ok, detail) select 'C6 order total = the QR amount, payment choice qr', (pg_temp.c('ord')::jsonb #>> '{order,total}')::numeric = (pg_temp.c('d2')::jsonb ->> 'amount')::numeric and pg_temp.c('ord')::jsonb #>> '{order,payment_pref}' = 'qr', pg_temp.c('ord')::jsonb #>> '{order,total}';
insert into t_res (test, ok, detail) select 'C6 the slip waits for staff, nothing is paid', (pg_temp.c('ord')::jsonb #>> '{order,invoice,status_code}')::int = 3 and (pg_temp.c('ord')::jsonb #>> '{order,invoice,paid}')::numeric = 0, pg_temp.c('ord')::jsonb #>> '{order,invoice,status_code}';
insert into t_res (test, ok, detail) select 'C6 the slip names PromptPay and the server''s amount', count(*) = 1 and bool_and(e.claimed_bank = 'PromptPay' and e.claimed_amount = (pg_temp.c('d2')::jsonb ->> 'amount')::numeric), max(e.claimed_bank)
  from public.finance_payment_evidence e where e.invoice_id = (pg_temp.c('ord')::jsonb #>> '{order,invoice,id}')::uuid;

-- =========================================================================================== shop closed / no account
update public.shop_settings set shop_open = false where id;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('C7 a closed shop gives no QR', format($q$select public.shop_checkout_qr(%L::jsonb, 'pickup')$q$, pg_temp.items(1)), 'SHOP_CLOSED%');
reset role; update public.shop_settings set shop_open = true where id; update public.finance_payment_accounts set is_default = false where is_default;
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('C7 no payment account: no QR (never an invented one)', format($q$select public.shop_checkout_qr(%L::jsonb, 'pickup')$q$, pg_temp.items(1)), 'NO_PAYMENT_ACCOUNT%');
insert into t_res (test, ok, detail) select 'C7 the payment methods say so too', not (public.finance_payment_methods() ->> 'promptpay')::boolean, null;
reset role;

-- =========================================================================================== the rollback removes exactly this function
drop function if exists public.shop_checkout_qr(jsonb, text);
insert into t_res (test, ok, detail) select 'C8 after the rollback the function is gone and the rest stays', not exists (select 1 from pg_proc where proname = 'shop_checkout_qr')
  and exists (select 1 from pg_proc where proname = 'shop_quote_internal') and exists (select 1 from pg_proc where proname = 'finance_qr_with_amount'), null;

do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'CHECKOUT_QR_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
