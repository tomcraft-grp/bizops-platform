-- (since 20261128150000 the receiver label must start a line, as OCR prints it: the slip texts below have the line break)
-- Tests for 20261124110000_own_slip_reader.sql, run inside one transaction that is rolled back: <migration> ; <this file>  (the local harness, see docs/own-slip-reader.md)
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
insert into public.finance_payment_accounts (label, qr_payload, kind, target, target_type, merchant_name, is_default) values ('KASIKORN BANK', pg_temp.qr_base(), 'promptpay', '004999000000001', 'e_wallet', 'ณัฐพร อยู่ยิ้ม', true);
insert into t_ctx select 'acc', id::text from public.finance_payment_accounts where is_default and active;

-- an order paid first with the QR and a slip; returns the evidence id. n makes the file unique
create or replace function pg_temp.sha(n int) returns text language sql as $$ select md5('of' || n) || md5('og' || n) $$;
create or replace function pg_temp.place(n int) returns void language plpgsql as $$
declare r jsonb;
begin
  update public.shop_orders set created_at = created_at - interval '2 hours' where profile_id = pg_temp.c('A')::uuid;      -- (the 10-orders-an-hour limit)
  perform pg_temp.as_user(pg_temp.c('A')::uuid);
  r := public.shop_place_order('own-key-000' || n, jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', 1)), 'pickup', 'Test', '0812345678', null, null, null, 'qr',
    pg_temp.c('A') || '/orders/own-' || n || '.png', pg_temp.sha(n), 'image/png', null, null);
  insert into t_ctx values ('inv' || n, r #>> '{order,invoice,id}'), ('tot' || n, r #>> '{order,total}');
end $$;
create or replace function pg_temp.ev(n int) returns uuid language sql as $$ select id from public.finance_payment_evidence where invoice_id = pg_temp.c('inv' || n)::uuid order by created_at desc, id desc limit 1 $$;

create or replace function pg_temp.ex(n int, p jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('is_slip', true, 'amount', pg_temp.c('tot' || n)::numeric, 'transfer_at', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00', 'time_known', true, 'bank', '004',
    'sender', jsonb_build_object('name', 'x'), 'receiver', jsonb_build_object('name', null), 'trans_ref', 'OWNREF00000' || n, 'trans_id', null, 'status_text', 'สำเร็จ',
    'field_confidence', jsonb_build_object('amount', 0.95, 'date', 0.95, 'time', 0.95, 'receiver', 0, 'ref', 0.95)) || p $$;
create or replace function pg_temp.store(n int, p jsonb default '{}', p_text text default E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', p_conf numeric default 0.95, p_qr jsonb default '{}', p_engine text default 'browser-ocr/1') returns text language plpgsql as $$
begin return public.finance_store_reading(pg_temp.ev(n), pg_temp.ex(n, p), jsonb_build_object('found', true, 'crc_ok', true, 'sending_bank', '004', 'trans_ref', 'OWNREF00000' || n, 'file_sha256', pg_temp.sha(n)) || p_qr, p_conf, p_text, p_engine) ->> 'result'; end $$;
create or replace function pg_temp.codes(n int) returns text language sql as $$ select string_agg(r ->> 'code', ',' order by r ->> 'code') from public.finance_slip_analysis a, jsonb_array_elements(a.reasons) r where a.evidence_id = pg_temp.ev(n) $$;
create or replace function pg_temp.told(n int) returns jsonb language plpgsql as $$ begin perform pg_temp.as_user(pg_temp.c('A')::uuid); return public.finance_my_slip_check(pg_temp.c('inv' || n)::uuid); end $$;
create or replace function pg_temp.staff() returns void language sql as $$ select pg_temp.as_user(pg_temp.c('S')::uuid) $$;
insert into public.finance_staff_roles (user_id, role) values (pg_temp.c('B')::uuid, 'clerk');

-- =========================================================================================== dark, and who may do what
select pg_temp.place(1);
select pg_temp.staff();
select pg_temp.err_like('D1 while it is off nothing is stored', $q$select pg_temp.store(1)$q$, 'READER_OFF%');
set local role anon;
select pg_temp.err_like('A1 anon', $q$select public.finance_own_reader()$q$, '%permission denied%');
select pg_temp.err_like('A1 anon', $q$select public.finance_set_own_reader(true)$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('A2 a customer learns only whether it is on', public.finance_own_reader() @> '{"enabled": false, "can_read": false, "can_manage": false}'::jsonb, public.finance_own_reader()::text);
select pg_temp.err_like('A3 a customer cannot switch it on', $q$select public.finance_set_own_reader(true)$q$, '%allowed%');
reset role; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('A4 a customer cannot store a reading of their own slip', $q$select pg_temp.store(1)$q$, '%allowed%');
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('A5 nor can a clerk', $q$select pg_temp.store(1)$q$, '%allowed%');
select pg_temp.staff();
select pg_temp.chk('A6 a manager switches it on', (public.finance_set_own_reader(true) ->> 'enabled')::boolean);
select pg_temp.chk('A7 and that is in the audit trail', exists (select 1 from public.finance_events where action = 'settings.own_reader'));

-- =========================================================================================== a good slip
select pg_temp.chk('G1 amount, day, receiver and reference all agree', pg_temp.store(1) = 'match', pg_temp.codes(1));
select pg_temp.chk('G2 money did not move: the slip still waits for a person', (select status from public.finance_payment_evidence where id = pg_temp.ev(1)) = 'submitted' and (public.finance_invoice_state_raw(pg_temp.c('inv1')::uuid) ->> 'paid')::numeric = 0);
select pg_temp.chk('G3 the customer is told a person checks it', pg_temp.told(1) = '{"state": "review"}'::jsonb, pg_temp.told(1)::text);
select pg_temp.chk('G4 it is in the log with the engine and who asked, and the text that was read is not kept', exists (select 1 from public.finance_slip_analysis where evidence_id = pg_temp.ev(1) and engine = 'browser-ocr/1' and requested_by = pg_temp.c('S')::uuid and finished_at is not null and extracted::text not like '%ไปยัง%'));

-- =========================================================================================== the receiver is found by the database, never taken from the browser
select pg_temp.place(2); select pg_temp.staff();
-- (since 20261128150000 the receiver is found by its place on the slip: "นาย คนอื่น ใจดี" is read as the receiver; one reading of an old reader cannot call it someone else's, so a person decides)
select pg_temp.chk('R1 a receiver the browser claims is ignored; not found in the text = never a match', pg_temp.store(2, '{"receiver": {"name": "ณัฐพร อยู่ยิ้ม", "account_hint": "9380319542"}}', E'โอนเงินสำเร็จ\nไปยัง นาย คนอื่น ใจดี') = 'manual_review' and pg_temp.codes(2) like '%RECEIVER_UNCERTAIN%', pg_temp.codes(2));
select pg_temp.place(3); select pg_temp.staff();
select pg_temp.chk('R2 by the last digits of one of our accounts', (select pg_temp.store(3, '{}', 'ไปยัง xxx-x-x' || substr(right(account_no, 5), 1, 4) || '-' || right(account_no, 1) || ' จำนวน') from public.finance_bank_accounts where active and code = 'BBL') = 'match', pg_temp.codes(3));
select pg_temp.place(4); select pg_temp.staff();
select pg_temp.chk('R3 those digits inside a longer number (a reference) are not an account', (select pg_temp.store(4, '{}', 'อ้างอิง 2026' || right(account_no, 5) || '778899') from public.finance_bank_accounts where active and code = 'BBL') = 'manual_review', pg_temp.codes(4));

-- =========================================================================================== amount, day, duplicates
select pg_temp.place(5); select pg_temp.staff();
select pg_temp.chk('V1 another amount, surely read: told to the customer', pg_temp.store(5, '{"amount": 1.00}') = 'amount_mismatch' and pg_temp.told(5) ->> 'code' = 'AMOUNT', pg_temp.told(5)::text);
select pg_temp.place(6); select pg_temp.staff();
select pg_temp.chk('V2 another amount, NOT surely read: staff see it, the customer is not told a number that may be wrong', pg_temp.store(6, '{"amount": 1.00, "field_confidence": {"amount": 0.7, "date": 0.95, "time": 0.95, "receiver": 0, "ref": 0.9}}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 0.7) = 'amount_mismatch' and pg_temp.told(6) = '{"state": "review"}'::jsonb, pg_temp.told(6)::text);
select pg_temp.place(7); select pg_temp.staff();
select pg_temp.chk('V3 nothing could be read: a person checks it, the customer is not blamed', pg_temp.store(7, '{"amount": null, "transfer_at": null}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 0) = 'manual_review' and pg_temp.told(7) = '{"state": "review"}'::jsonb, pg_temp.told(7)::text);
select pg_temp.place(8); select pg_temp.staff();
select pg_temp.chk('V4 two days ago', pg_temp.store(8, jsonb_build_object('transfer_at', to_char((now() - interval '2 days') at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00')) = 'date_mismatch' and pg_temp.told(8) ->> 'code' = 'DATE_PAST', pg_temp.told(8)::text);
select pg_temp.place(9); select pg_temp.staff();
select pg_temp.chk('V5 the reference of another slip', pg_temp.store(9, '{"trans_ref": "OWNREF000001"}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 0.95, '{"trans_ref": "OWNREF000001"}') = 'duplicate_suspected' and pg_temp.told(9) ->> 'code' = 'DUPLICATE', pg_temp.codes(9));
select pg_temp.place(10); select pg_temp.staff();
select pg_temp.chk('V6 the same file as another slip', pg_temp.store(10, '{}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 0.95, jsonb_build_object('file_sha256', pg_temp.sha(1))) = 'duplicate_suspected' and pg_temp.codes(10) like '%DUPLICATE_FILE%', pg_temp.codes(10));
select pg_temp.place(11); select pg_temp.staff();
select pg_temp.chk('V7 a slip QR with a wrong checksum', pg_temp.store(11, '{}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 0.95, '{"crc_ok": false}') = 'suspicious_slip' and pg_temp.told(11) = pg_temp.told(1), pg_temp.codes(11));
select pg_temp.place(12); select pg_temp.staff();
select pg_temp.chk('V8 the QR names another transfer than the printed reference', pg_temp.store(12, '{}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 0.95, '{"trans_ref": "SOMETHINGELSE1"}') = 'suspicious_slip' and pg_temp.codes(12) like '%QR_REF_MISMATCH%', pg_temp.codes(12));

-- =========================================================================================== refusals
select pg_temp.place(13); select pg_temp.staff();
select pg_temp.err_like('X1 an engine name that is not ours', $q$select pg_temp.store(13, '{}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 0.95, '{}', 'claude-haiku-5-5')$q$, 'INVALID_READING%');
select pg_temp.err_like('X2 a confidence above 1', $q$select pg_temp.store(13, '{}', E'โอนเงินสำเร็จ\nไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x', 1.5)$q$, 'INVALID_READING%');
select pg_temp.err_like('X3 an oversized reading', $q$select pg_temp.store(13, jsonb_build_object('x', repeat('a', 7000)))$q$, 'INVALID_READING%');
select pg_temp.err_like('X4 an unknown slip', $q$select public.finance_store_reading(gen_random_uuid(), '{}', '{}', 0.5, '', 'browser-ocr/1')$q$, 'NOT_FOUND%');
do $$ begin for k in 1..5 loop perform pg_temp.store(13); end loop; end $$;
select pg_temp.err_like('X5 at most five attempts for one slip', $q$select pg_temp.store(13)$q$, 'TOO_MANY_ATTEMPTS%');
select pg_temp.chk('X6 attempts are numbered', (select array_agg(attempt order by attempt) from public.finance_slip_analysis where evidence_id = pg_temp.ev(13)) = array[1, 2, 3, 4, 5]);
select public.finance_reject_evidence(pg_temp.ev(12), 'x');
select pg_temp.err_like('X7 a slip that is finished', $q$select pg_temp.store(12)$q$, 'NOTHING_TO_DO%');
update public.finance_settings set ai_review_enabled = true; select pg_temp.place(14); select pg_temp.staff();
select pg_temp.err_like('X8 not while the AI reader has it', $q$select pg_temp.store(14)$q$, 'ALREADY_QUEUED%');
select pg_temp.chk('X9 an unreadable AI answer is still told to the customer', (select public.finance_analysis_complete(id, '{"is_slip": false}', '{"found": false}', 0.9, '[]', 'claude-haiku-5-5', 'v1') is not null from public.finance_slip_analysis where evidence_id = pg_temp.ev(14)) and pg_temp.told(14) ->> 'code' = 'NOT_A_SLIP', pg_temp.told(14)::text);

do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'OWN_READER_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
