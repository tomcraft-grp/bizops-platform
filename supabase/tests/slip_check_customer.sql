-- Tests for 20261124100000_slip_check_customer.sql, run inside one transaction that is rolled back: <migration> ; <this file>  (the local harness, see docs/premium-qr-slip-check.md)
-- Nothing persists: the last statement raises an exception that carries the result table.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon, service_role; grant usage on sequence t_res_n_seq to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, m ilike p_pat, m); end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'sku', sku_code from public.shop_sellable where available and coalesce(max_qty, 99) >= 3 order by sku_seq limit 1;
update public.shop_settings set shop_open = true, pickup_enabled = true, require_payment_slip = true;
update public.finance_settings set ai_review_enabled = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10;
-- the shop's QR account as it is live: an e-wallet number and no name
update public.finance_payment_accounts set is_default = false where is_default;
create or replace function pg_temp.qr_base() returns text language sql as $$
  select b || public.finance_crc16(b) from (select '000201' || '010211' || '2939' || '0016A000000677010111' || '0315' || '004999000000001' || '5303764' || '5802TH' || '6304' as b) x $$;
insert into public.finance_payment_accounts (label, qr_payload, kind, target, target_type, merchant_name, is_default) values ('KASIKORN BANK', pg_temp.qr_base(), 'promptpay', '004999000000001', 'e_wallet', null, true);
insert into t_ctx select 'acc', id::text from public.finance_payment_accounts where is_default and active;

-- an order paid first with the QR and a slip; returns the evidence id. n makes the file unique
create or replace function pg_temp.sha(n int) returns text language sql as $$ select md5('f' || n) || md5('g' || n) $$;
create or replace function pg_temp.place(n int) returns void language plpgsql as $$
declare r jsonb;
begin
  update public.shop_orders set created_at = created_at - interval '2 hours' where profile_id = pg_temp.c('A')::uuid;      -- (the 10-orders-an-hour limit)
  perform pg_temp.as_user(pg_temp.c('A')::uuid);
  r := public.shop_place_order('chk-key-000' || n, jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', 1)), 'pickup', 'Test', '0812345678', null, null, null, 'qr',
    pg_temp.c('A') || '/orders/chk-' || n || '.png', pg_temp.sha(n), 'image/png', null, null);
  insert into t_ctx values ('inv' || n, r #>> '{order,invoice,id}'), ('tot' || n, r #>> '{order,total}');
end $$;
create or replace function pg_temp.ev(n int) returns uuid language sql as $$ select id from public.finance_payment_evidence where invoice_id = pg_temp.c('inv' || n)::uuid order by created_at desc, id desc limit 1 $$;
-- what the reader would report for a good slip of order n; p overrides fields
create or replace function pg_temp.ex(n int, p jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('is_slip', true, 'amount', pg_temp.c('tot' || n)::numeric, 'transfer_at', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00', 'time_known', true, 'bank', 'KBank',
    'sender', jsonb_build_object('name', 'x', 'bank', null, 'account_hint', null), 'receiver', jsonb_build_object('name', 'นาย ทดสอบ รับเงิน', 'bank', 'KBank', 'account_hint', 'xxx-x-x1111-x'),
    'trans_ref', 'REFCHK00000' || n, 'trans_id', null, 'status_text', 'โอนเงินสำเร็จ', 'field_confidence', jsonb_build_object('amount', 0.99, 'date', 0.99, 'time', 0.99, 'receiver', 0.99, 'ref', 0.99)) || p $$;
create or replace function pg_temp.read_slip(n int, p jsonb default '{}', p_sha text default null, p_signals jsonb default '[]', p_conf numeric default 0.95) returns text language plpgsql as $$
declare a uuid; r jsonb;
begin
  select id into a from public.finance_slip_analysis where evidence_id = pg_temp.ev(n) and status in ('queued', 'running') order by attempt desc limit 1;
  r := public.finance_analysis_complete(a, pg_temp.ex(n, p), jsonb_build_object('found', false, 'crc_ok', null, 'sending_bank', null, 'trans_ref', null, 'file_sha256', coalesce(p_sha, pg_temp.sha(n))), p_conf, p_signals, 'test', 'v1');
  return r ->> 'result';
end $$;
create or replace function pg_temp.told(n int) returns jsonb language plpgsql as $$ begin perform pg_temp.as_user(pg_temp.c('A')::uuid); return public.finance_my_slip_check(pg_temp.c('inv' || n)::uuid); end $$;
create or replace function pg_temp.codes(n int) returns text language sql as $$ select string_agg(r ->> 'code', ',' order by r ->> 'code') from public.finance_slip_analysis a, jsonb_array_elements(a.reasons) r where a.evidence_id = pg_temp.ev(n) $$;

-- =========================================================================================== dark: the reader is off
select pg_temp.place(1);
select pg_temp.chk('D1 with the reader off the customer is told nothing new', pg_temp.told(1) = '{"state": "none"}'::jsonb, pg_temp.told(1)::text);
update public.finance_settings set ai_review_enabled = true;

-- =========================================================================================== access
select pg_temp.place(2);
set local role anon;
select pg_temp.err_like('A1 anon cannot ask', format($q$select public.finance_my_slip_check(%L)$q$, pg_temp.c('inv2')), '%permission denied%');
select pg_temp.err_like('A1 anon cannot name the account', format($q$select public.finance_set_payment_account_name(%L, 'abc')$q$, pg_temp.c('acc')), '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('A2 another customer is told "not found"', format($q$select public.finance_my_slip_check(%L)$q$, pg_temp.c('inv2')), '%not found%');
select pg_temp.err_like('A3 a customer cannot name the account', format($q$select public.finance_set_payment_account_name(%L, 'Somebody Else')$q$, pg_temp.c('acc')), '%allowed%');
select pg_temp.chk('A4 a customer still cannot read an analysis row', (select count(*) from public.finance_slip_analysis) = 0);
reset role;

-- =========================================================================================== the receiver of a QR payment
select pg_temp.chk('R1 processing while the slip waits for the reader', pg_temp.told(2) = '{"state": "processing"}'::jsonb, pg_temp.told(2)::text);
select pg_temp.chk('R2 WITHOUT a name a correct QR slip is flagged as paid to somebody else (why the name exists)', pg_temp.read_slip(2) = 'suspicious_slip' and pg_temp.codes(2) like '%RECEIVER_MISMATCH%', pg_temp.codes(2));
select pg_temp.chk('R3 ...and the customer is not told that', pg_temp.told(2) = '{"state": "review"}'::jsonb, pg_temp.told(2)::text);
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('R4 a name that would match any slip is refused', format($q$select public.finance_set_payment_account_name(%L, 'นาย')$q$, pg_temp.c('acc')), 'INVALID_NAME%');
select pg_temp.err_like('R4 an unknown account', $q$select public.finance_set_payment_account_name(gen_random_uuid(), 'ทดสอบ รับเงิน')$q$, '%not found%');
select pg_temp.chk('R5 a manager writes both spellings', (public.finance_set_payment_account_name(pg_temp.c('acc')::uuid, ' ทดสอบ รับเงิน ', 'Thotsob Rapngoen')).merchant_name = 'ทดสอบ รับเงิน');
reset role;
select pg_temp.chk('R6 it is in the audit trail', exists (select 1 from public.finance_events where entity_id = pg_temp.c('acc')::uuid and action = 'account.name'));
select pg_temp.place(3);
select pg_temp.chk('R7 now the same slip matches', pg_temp.read_slip(3) = 'match', pg_temp.codes(3));
select pg_temp.place(4);
select pg_temp.chk('R8 and so does the other spelling', pg_temp.read_slip(4, '{"receiver": {"name": "MR. THOTSOB R", "bank": "KBank", "account_hint": null}}') = 'match', pg_temp.codes(4));
select pg_temp.place(5);
select pg_temp.chk('R9 a different receiver is still caught', pg_temp.read_slip(5, '{"receiver": {"name": "นาย คนอื่น", "bank": "SCB", "account_hint": "xxx-x-x9999-x"}}') = 'suspicious_slip', pg_temp.codes(5));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('R10 the checkout QR now carries the name the customer should see in the bank app', public.shop_checkout_qr(jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', 1)), 'pickup') ->> 'merchant_name' = 'ทดสอบ รับเงิน');
reset role;

-- =========================================================================================== what the customer is told
select pg_temp.chk('T1 a clean reading is "a person checks it", never "verified"', pg_temp.told(3) = '{"state": "review"}'::jsonb, pg_temp.told(3)::text);
select pg_temp.chk('T2 and the money rules did not move: the slip still waits, nothing is paid', (select status from public.finance_payment_evidence where id = pg_temp.ev(3)) = 'submitted' and (public.finance_invoice_state_raw(pg_temp.c('inv3')::uuid) ->> 'paid')::numeric = 0);
select pg_temp.place(6);
select pg_temp.chk('T3 one satang less', pg_temp.read_slip(6, jsonb_build_object('amount', pg_temp.c('tot6')::numeric - 0.01)) = 'amount_mismatch');
select pg_temp.chk('T3 the customer sees both amounts, the expected one from the database', pg_temp.told(6) ->> 'code' = 'AMOUNT' and (pg_temp.told(6) ->> 'expected_amount')::numeric = pg_temp.c('tot6')::numeric and (pg_temp.told(6) ->> 'slip_amount')::numeric = pg_temp.c('tot6')::numeric - 0.01, pg_temp.told(6)::text);
select pg_temp.place(7);
select pg_temp.chk('T4 yesterday', pg_temp.read_slip(7, jsonb_build_object('transfer_at', to_char((now() - interval '2 days') at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00')) = 'date_mismatch' and pg_temp.told(7) ->> 'code' = 'DATE_PAST' and pg_temp.told(7) ? 'slip_date', pg_temp.told(7)::text);
select pg_temp.place(8);
select pg_temp.chk('T5 a future day', pg_temp.read_slip(8, jsonb_build_object('transfer_at', to_char((now() + interval '2 days') at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00')) = 'date_mismatch' and pg_temp.told(8) ->> 'code' = 'DATE_FUTURE', pg_temp.told(8)::text);
select pg_temp.place(9);
select pg_temp.chk('T6 no date on the slip', pg_temp.read_slip(9, '{"transfer_at": null}') = 'manual_review' and pg_temp.told(9) = '{"state": "attention", "code": "UNREADABLE"}'::jsonb, pg_temp.told(9)::text);
select pg_temp.place(10);
select pg_temp.chk('T7 not a slip', pg_temp.read_slip(10, '{"is_slip": false}') = 'manual_review' and pg_temp.told(10) = '{"state": "attention", "code": "NOT_A_SLIP"}'::jsonb, pg_temp.told(10)::text);
select pg_temp.place(11);
select pg_temp.chk('T8 a reference already used', pg_temp.read_slip(11, '{"trans_ref": "REFCHK000003"}') = 'duplicate_suspected' and pg_temp.told(11) = '{"state": "attention", "code": "DUPLICATE"}'::jsonb, pg_temp.told(11)::text);
select pg_temp.place(12);
select pg_temp.chk('T9 low confidence', pg_temp.read_slip(12, '{}', null, '[]', 0.4) = 'manual_review' and pg_temp.told(12) = '{"state": "review"}'::jsonb, pg_temp.told(12)::text);
select pg_temp.place(13);
select pg_temp.chk('T10 an edited slip that reads right: staff see it is suspicious, the customer cannot tell it from a clean one', pg_temp.read_slip(13, '{}', null, '[{"code": "font_mismatch", "severity": "high", "detail": "x"}]') = 'suspicious_slip' and pg_temp.told(13) = pg_temp.told(3), pg_temp.told(13)::text);
select pg_temp.place(14);
select pg_temp.chk('T11 edited AND a wrong amount: the same answer as a wrong amount alone', pg_temp.read_slip(14, jsonb_build_object('amount', 1), null, '[{"code": "font_mismatch", "severity": "high", "detail": "x"}]') = 'suspicious_slip' and pg_temp.told(14) ->> 'code' = 'AMOUNT', pg_temp.told(14)::text);
select pg_temp.chk('T12 the answer never carries a confidence, a signal, a receiver, a reference or a reason', not exists (select 1 from generate_series(3, 14) n, jsonb_object_keys(pg_temp.told(n)) k where k not in ('state', 'code', 'slip_amount', 'expected_amount', 'slip_date', 'expected_date')));
select pg_temp.place(15);
select public.finance_analysis_fail((select id from public.finance_slip_analysis where evidence_id = pg_temp.ev(15)), 'AI_HTTP_529: overloaded', 'test');
select pg_temp.chk('T13 the reader is unavailable: a person checks it, nothing is paid', pg_temp.told(15) = '{"state": "review"}'::jsonb and (public.finance_invoice_state_raw(pg_temp.c('inv15')::uuid) ->> 'status_code')::int = 3, pg_temp.told(15)::text);
-- (a queued attempt that nobody picked up)
select pg_temp.place(16);
delete from t_ctx where k = 'x';
update public.finance_slip_analysis set created_at = now() - interval '4 minutes' where evidence_id = pg_temp.ev(16);
select pg_temp.chk('T14 a reader that never answers does not leave the customer on "processing"', pg_temp.told(16) = '{"state": "review"}'::jsonb, pg_temp.told(16)::text);
set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_reject_evidence(pg_temp.ev(6), 'ยอดไม่ตรง');
reset role;
select pg_temp.chk('T15 once staff rejected it the invoice state speaks, not the reading', pg_temp.told(6) = '{"state": "none"}'::jsonb, pg_temp.told(6)::text);

-- =========================================================================================== the file the reader received
select pg_temp.place(17);
select pg_temp.chk('H1 a declared fingerprint that is not the stored file', pg_temp.read_slip(17, '{}', pg_temp.sha(900)) = 'suspicious_slip' and pg_temp.codes(17) like '%FILE_HASH_MISMATCH%', pg_temp.codes(17));
select pg_temp.place(18);
select pg_temp.chk('H2 the same bytes as another slip, sent under a false fingerprint', pg_temp.read_slip(18, '{}', pg_temp.sha(3)) = 'duplicate_suspected' and pg_temp.codes(18) like '%DUPLICATE_FILE%', pg_temp.codes(18));
select pg_temp.place(19);
select pg_temp.chk('H3 an older reader that reports no fingerprint still works', (public.finance_analysis_complete((select id from public.finance_slip_analysis where evidence_id = pg_temp.ev(19)), pg_temp.ex(19), '{"found": false}', 0.95, '[]', 'test', 'v1')) ->> 'result' = 'match', pg_temp.codes(19));

-- =========================================================================================== the QR picture bucket
select pg_temp.chk('B1 private, PNG only, small', exists (select 1 from storage.buckets where id = 'payment-qr' and not public and allowed_mime_types = array['image/png'] and file_size_limit <= 1048576));
set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into storage.objects (bucket_id, name) values ('payment-qr', pg_temp.c('A') || '/payment-qr.png');
select pg_temp.chk('B2 a customer keeps one picture in their own folder', (select count(*) from storage.objects where bucket_id = 'payment-qr') = 1);
select pg_temp.err_like('B3 not any other name', format($q$insert into storage.objects (bucket_id, name) values ('payment-qr', %L)$q$, pg_temp.c('A') || '/other.png'), '%row-level security%');
select pg_temp.err_like('B3 not in another folder', format($q$insert into storage.objects (bucket_id, name) values ('payment-qr', %L)$q$, pg_temp.c('B') || '/payment-qr.png'), '%row-level security%');
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.chk('B4 another customer does not see it', (select count(*) from storage.objects where bucket_id = 'payment-qr') = 0);
reset role;

do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'SLIP_CHECK_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
