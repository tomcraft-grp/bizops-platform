-- Tests for 20261128150000_slip_recipient_check.sql, run inside one transaction that is rolled back (the local harness, see docs/slip-recipient-check.md):
--   node scripts/local-pg/run.mjs supabase/tests/slip_recipient_check.sql
-- Scenarios A to J of the request are marked; tests/unit/slipRecipient.test.ts runs the SAME name and layout cases (section M) through the TypeScript twin of the matcher.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon, service_role; grant usage on sequence t_res_n_seq to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm || ' ' || sqlstate; perform pg_temp.chk(p_test, m ilike p_pat, m); end;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'V', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 2 limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'sku', sku_code from public.shop_sellable where available and coalesce(max_qty, 99) >= 3 order by sku_seq limit 1;
update public.shop_settings set shop_open = true, pickup_enabled = true, require_payment_slip = true;
update public.finance_settings set ai_review_enabled = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10, own_reader_enabled = true, checkout_check_enabled = true;
-- the shop's accounts as they are live: SCB ณัฐพล อยู่ยิ้ม, BBL ณัฐพร อยู่ยิ้ม, and the QR (an e-wallet) of ณัฐพร อยู่ยิ้ม
update public.finance_bank_accounts set active = (code in ('SCB', 'BBL')), account_name = case code when 'SCB' then 'ณัฐพล อยู่ยิ้ม' when 'BBL' then 'ณัฐพร อยู่ยิ้ม' else account_name end;
select pg_temp.chk('Z00 (precondition) the two accounts of the live shop', (select count(*) from public.finance_bank_accounts where active and ((code = 'SCB' and account_no = '5194026251') or (code = 'BBL' and account_no = '9380319542'))) = 2);
update public.finance_payment_accounts set is_default = false where is_default;
create or replace function pg_temp.qr_base() returns text language sql as $$
  select b || public.finance_crc16(b) from (select '000201' || '010211' || '2939' || '0016A000000677010111' || '0315' || '004999000000001' || '5303764' || '5802TH' || '6304' as b) x $$;
insert into public.finance_payment_accounts (label, qr_payload, kind, target, target_type, merchant_name, is_default) values ('KASIKORN BANK', pg_temp.qr_base(), 'promptpay', '004999000000001', 'e_wallet', 'ณัฐพร อยู่ยิ้ม', true);
insert into public.finance_staff_roles (user_id, role) values (pg_temp.c('B')::uuid, 'clerk'), (pg_temp.c('V')::uuid, 'verifier')
  on conflict (user_id) do update set role = excluded.role;

-- an order paid with the QR and a slip (returns nothing; its invoice and total are kept under n)
create or replace function pg_temp.sha(n int) returns text language sql as $$ select md5('rc' || n) || md5('rd' || n) $$;
create or replace function pg_temp.place(n int) returns void language plpgsql as $$
declare r jsonb;
begin
  update public.shop_orders set created_at = created_at - interval '2 hours' where profile_id = pg_temp.c('A')::uuid;      -- (the 10-orders-an-hour limit)
  perform pg_temp.as_user(pg_temp.c('A')::uuid);
  r := public.shop_place_order('rcp-key-000' || n, jsonb_build_array(jsonb_build_object('sku_code', pg_temp.c('sku'), 'qty', 1)), 'pickup', 'Test', '0812345678', null, null, null, 'qr',
    pg_temp.c('A') || '/orders/rcp-' || n || '.png', pg_temp.sha(n), 'image/png', null, null);
  insert into t_ctx values ('inv' || n, r #>> '{order,invoice,id}'), ('tot' || n, r #>> '{order,total}');
end $$;
create or replace function pg_temp.ev(n int) returns uuid language sql as $$ select id from public.finance_payment_evidence where invoice_id = pg_temp.c('inv' || n)::uuid order by created_at desc, id desc limit 1 $$;
create or replace function pg_temp.ex(n int, p jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('is_slip', true, 'amount', pg_temp.c('tot' || n)::numeric, 'transfer_at', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00', 'time_known', true, 'bank', '004',
    'sender', jsonb_build_object('name', null), 'receiver', jsonb_build_object('name', null), 'trans_ref', 'RCPREF00000' || n, 'trans_id', null, 'status_text', 'สำเร็จ',
    'field_confidence', jsonb_build_object('amount', 0.95, 'date', 0.95, 'time', 0.95, 'receiver', 0, 'ref', 0.95)) || p $$;
-- three passes of the reader (separated by a form feed), each the same slip text unless given
create or replace function pg_temp.slip(p_receiver text) returns text language sql as $$
  select 'โอนเงินสำเร็จ' || E'\n' || 'จาก นาย ลูกค้า ทดสอบ' || E'\n' || 'xxx-x-x5555-x' || E'\n' || 'ไปยัง ' || p_receiver || E'\n' || 'จำนวนเงิน 100.00 บาท' $$;
create or replace function pg_temp.three(p1 text, p2 text default null, p3 text default null) returns text language sql as $$
  select concat_ws(chr(12), pg_temp.slip(p1), pg_temp.slip(coalesce(p2, p1)), pg_temp.slip(coalesce(p3, p1))) $$;
create or replace function pg_temp.store(n int, p_text text, p jsonb default '{}', p_conf numeric default 0.95, p_qr jsonb default '{}') returns jsonb language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.c('S')::uuid);
  return public.finance_store_reading(pg_temp.ev(n), pg_temp.ex(n, p), jsonb_build_object('found', true, 'crc_ok', true, 'sending_bank', '004', 'trans_ref', 'RCPREF00000' || n, 'file_sha256', pg_temp.sha(n)) || p_qr,
    p_conf, p_text, 'browser-ocr/2');
end $$;
create or replace function pg_temp.an(n int) returns public.finance_slip_analysis language sql as $$ select * from public.finance_slip_analysis where evidence_id = pg_temp.ev(n) order by attempt desc limit 1 $$;
create or replace function pg_temp.codes(n int) returns text language sql as $$ select string_agg(r ->> 'code', ',' order by r ->> 'code') from jsonb_array_elements((pg_temp.an(n)).reasons) r $$;
create or replace function pg_temp.told(n int) returns jsonb language plpgsql as $$ begin perform pg_temp.as_user(pg_temp.c('A')::uuid); return public.finance_my_slip_check(pg_temp.c('inv' || n)::uuid); end $$;
create or replace function pg_temp.m(p text) returns text language sql as $$ select public.finance_recipient_match(p, null) ->> 'verdict' $$;
create or replace function pg_temp.cand(p text) returns text language sql as $$ select string_agg(coalesce(x ->> 'name', '-') || '|' || coalesce(x ->> 'account_hint', '-') || '|' || (x ->> 'how'), ' / ') from jsonb_array_elements(public.finance_recipient_candidates(p)) x $$;

-- the report before this suite adds anything (a live database already has readings: section K compares what this suite ADDED)
select pg_temp.as_user(pg_temp.c('S')::uuid); insert into t_ctx select 'k0', public.finance_slip_learning(30)::text; reset role;
create or replace function pg_temp.kd(p text) returns int language sql as $$
  select (public.finance_slip_learning(30) #>> string_to_array(p, '.'))::int - coalesce((pg_temp.c('k0')::jsonb #>> string_to_array(p, '.'))::int, 0) $$;

-- =========================================================================================== M the names (pure; the same cases are in tests/unit/fixtures/recipient-cases.json)
select pg_temp.chk('M01 A: ณัฐพร อยู่ยิ้ม is ours', pg_temp.m('ณัฐพร อยู่ยิ้ม') = 'match');
select pg_temp.chk('M02 B: ณัฐพล อยู่ยิ้ม is ours', pg_temp.m('ณัฐพล อยู่ยิ้ม') = 'match');
select pg_temp.chk('M03 the two holders stay apart', public.finance_recipient_match('ณัฐพร อยู่ยิ้ม', null) ->> 'holder' = 'ณัฐพร อยู่ยิ้ม' and public.finance_recipient_match('ณัฐพล อยู่ยิ้ม', null) ->> 'holder' = 'ณัฐพล อยู่ยิ้ม');
select pg_temp.chk('M04 C: a title and double spaces', pg_temp.m('น.ส.  ณัฐพร   อยู่ยิ้ม') = 'match');
select pg_temp.chk('M05 C: no space at all', pg_temp.m('ณัฐพรอยู่ยิ้ม') = 'match');
select pg_temp.chk('M06 C: a space inside the surname', pg_temp.m('ณัฐพร อยู่ ยิ้ม') = 'match');
select pg_temp.chk('M07 C: sara am split by OCR and a zero-width space', pg_temp.m('นาย' || chr(8203) || 'ณัฐพล อยู่ยิ้ม') = 'match');
select pg_temp.chk('M08 a surname the bank masked (อ.)', pg_temp.m('นาย ณัฐพล อ.') = 'match');
select pg_temp.chk('M09 ... (อ***)', pg_temp.m('น.ส. ณัฐพร อ***') = 'match');
select pg_temp.chk('M10 ... a cut surname (ณัฐพลอยู่)', pg_temp.m('ณัฐพลอยู่') = 'match');
select pg_temp.chk('M11 D: one Thai letter misread is near, not a match', pg_temp.m('ณัฐพธ อยู่ยิ้ม') = 'near');
select pg_temp.chk('M12 D: lost tone marks are near, not a match', pg_temp.m('ณัฐพร อยูยิม') = 'near');
select pg_temp.chk('M13 D: a similar but different name (ณัฐพง) is near: a person decides', pg_temp.m('ณัฐพง อยู่ยิ้ม') = 'near');
select pg_temp.chk('M14 E: someone else', pg_temp.m('นาย สมชาย ใจดี') = 'other');
select pg_temp.chk('M15 E: our first name with another surname is someone else', pg_temp.m('ณัฐพร ใจดี') = 'other');
select pg_temp.chk('M16 our first name alone is only partial', pg_temp.m('ณัฐพร') = 'partial');
select pg_temp.chk('M17 a masked surname with another initial is near (a person decides)', pg_temp.m('ณัฐพร ใ.') = 'near');
select pg_temp.chk('M18 a Latin name is not compared with Thai names', pg_temp.m('MS. NATTHAPORN Y') = 'none');
select pg_temp.chk('M19 too short to judge', pg_temp.m('ณั') = 'none' and pg_temp.m(null) = 'none' and pg_temp.m('') = 'none');
select pg_temp.chk('M20 the digits rule is unchanged: xxx-x-x9542-x is the BBL account', public.finance_recipient_match(null, 'xxx-x-x9542-x') ->> 'verdict' = 'match'
  and public.finance_recipient_match(null, '123-4-56789-0') ->> 'verdict' = 'other');
select pg_temp.chk('M21 a near name is not made ours by our digits beside it', public.finance_recipient_match('ณัฐพง อยู่ยิ้ม', 'xxx-x-x9542-x') ->> 'verdict' = 'match'
  and public.finance_recipient_match('ณัฐพง อยู่ยิ้ม', 'xxx-x-x9542-x') ->> 'name_verdict' = 'near');
select pg_temp.chk('M22 the weighted distance: a look-alike letter or a mark costs half', public.finance_name_dist('ณัฐพร', 'ณัฐพธ') = 0.5 and public.finance_name_dist('อยู่', 'อยู') = 0.5 and public.finance_name_dist('abc', 'abd') = 1);

-- =========================================================================================== L where the receiver is on the slip
select pg_temp.chk('L01 the receiver after its label, not the sender', pg_temp.cand(pg_temp.slip('นาย ณัฐพล อยู่ยิ้ม')) = 'นาย ณัฐพล อยู่ยิ้ม|-|label', pg_temp.cand(pg_temp.slip('นาย ณัฐพล อยู่ยิ้ม')));
select pg_temp.chk('L02 KBank: no labels, the second titled name, the masked number two lines below',
  pg_temp.cand(E'โอนเงินสำเร็จ\nนาย สมชาย ใจดี\nธ.กสิกรไทย\nxxx-x-x1234-x\nน.ส. ณัฐพร อยู่ยิ้ม\nธ.กรุงเทพ\nxxx-x-x9542-x\nเลขที่รายการ: 015332') = 'น.ส. ณัฐพร อยู่ยิ้ม|xxx-x-x9542-x|order');
select pg_temp.chk('L03 a label alone on its line: the next line', pg_temp.cand(E'From\nMR. SOMCHAI JAIDEE\nTo\nMS. NATTHAPORN Y\nxxx-x-x9542-x') = 'ms. natthaporn y|xxx-x-x9542-x|label');
select pg_temp.chk('L04 "ผู้รับเงิน:" and the number after "เลขบัญชี"', pg_temp.cand(E'ผู้รับเงิน: นางสาว ณัฐพร อ***\nเลขบัญชี xxx-x-x9542-x') = 'นางสาว ณัฐพร อ***|xxx-x-x9542-x|label');
select pg_temp.chk('L05 our name in a memo does not count: the receiver is the second name', pg_temp.cand(E'โอนเงินสำเร็จ\nนาย สมชาย ใจดี\nนาย คนอื่น ใจดี\nบันทึกช่วยจำ ณัฐพร อยู่ยิ้ม') = 'นาย คนอื่น ใจดี|-|order');
select pg_temp.chk('L06 our name as the SENDER does not count', pg_temp.cand(E'จาก น.ส. ณัฐพร อยู่ยิ้ม\nไปยัง นาย สมชาย ใจดี') = 'นาย สมชาย ใจดี|-|label');
select pg_temp.chk('L07 three titled names and no label: nobody is guessed', pg_temp.cand(E'นาย ก ข\nนาย ค ง\nนาย จ ฉ') is null);
select pg_temp.chk('L08 one candidate per pass', jsonb_array_length(public.finance_recipient_candidates(pg_temp.three('ณัฐพร อยู่ยิ้ม'))) = 3);
select pg_temp.chk('L10 a field line after an unreadable label is not a name, and its reference is not an account', pg_temp.cand(E'ไปยัง\nเลขที่รายการ 015332123456789\nจำนวนเงิน 100.00') is null
  and pg_temp.cand(E'ไปยัง ณ\nจำนวนเงิน 100.00 บาท') is null, pg_temp.cand(E'ไปยัง\nเลขที่รายการ 015332123456789\nจำนวนเงิน 100.00'));
select pg_temp.chk('L11 only a masked number after the label: the digits are kept', pg_temp.cand('ไปยัง xxx-x-x9542-1 จำนวน') like '-|xxx-x-x9542-1%|label', pg_temp.cand('ไปยัง xxx-x-x9542-1 จำนวน'));
-- what the real engine read from tests/shop-e2e/slips/invented-430-th.jpg (the receiver there is called "ทดสอบ ผู้รับ")
select pg_temp.chk('L12 a label word inside a NAME is not a label (only at the start of a line)', pg_temp.cand(E'โอนเงินสำเร็จ\nน.ส. สมหญิง รักดี\n0๐62%1234-%<\nแล\nน.ส. ทดสอบ ผู้รับ\n200๐(๐๐๐2625-1\nเลขที่รายการ:') = 'น.ส. ทดสอบ ผู้รับ|-|order',
  pg_temp.cand(E'โอนเงินสำเร็จ\nน.ส. สมหญิง รักดี\n0๐62%1234-%<\nแล\nน.ส. ทดสอบ ผู้รับ\n200๐(๐๐๐2625-1\nเลขที่รายการ:'));
select pg_temp.chk('L13 OCR noise after the name (the QR beside it) is cut off', pg_temp.cand(E'น.ส. สมหญิง รักดี - -- -\n3200๐๐๐1234-% [ต15 [ต]\n: รบั\nโป ] ร\nน.ส. ทดสอบ ผู้รับ -= เล\n๐๐๐๐9625-1 [อต] [77!') = 'น.ส. ทดสอบ ผู้รับ|-|order',
  pg_temp.cand(E'น.ส. สมหญิง รักดี - -- -\n3200๐๐๐1234-% [ต15 [ต]\n: รบั\nโป ] ร\nน.ส. ทดสอบ ผู้รับ -= เล\n๐๐๐๐9625-1 [อต] [77!'));
select pg_temp.chk('L14 a stray short word after first name and surname is dropped; a masked initial is kept', pg_temp.cand('ไปยัง นาย ณัฐพล อยู่ยิ้ม เล') = 'นาย ณัฐพล อยู่ยิ้ม|-|label'
  and pg_temp.cand('ไปยัง นาย ณัฐพล อ') = 'นาย ณัฐพล อ|-|label');
select pg_temp.chk('M23 a name clearly someone else''s beside digits that look like ours is a conflict for a person, not ours', public.finance_recipient_match('นาย สมชาย ใจดี', 'xxx-x-x9542-x') ->> 'verdict' = 'conflict'
  and public.finance_recipient_check('[{"name": "นาย สมชาย ใจดี", "account_hint": "xxx-x-x9542-x"}]', 1) ->> 'status' = 'uncertain');
select pg_temp.chk('L09 a number on the name line is cut off', pg_temp.cand('ไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x') = 'นาง ณัฐพร อ***|*** xxx-x-x1111-x|label' or pg_temp.cand('ไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x') like 'นาง ณัฐพร อ***|%|label',
  pg_temp.cand('ไปยัง นาง ณัฐพร อ*** xxx-x-x1111-x'));

-- =========================================================================================== O the own reader, end to end (scenarios A to H)
select pg_temp.place(1);
select pg_temp.chk('O01 A: ณัฐพร อยู่ยิ้ม, everything else right: verified', (pg_temp.store(1, pg_temp.three('น.ส. ณัฐพร อยู่ยิ้ม')) ->> 'decision') = 'verified' and (pg_temp.an(1)).result = 'match', pg_temp.codes(1));
select pg_temp.chk('O02 A: the stored attempt says who was paid and how it was decided', (pg_temp.an(1)).recipient ->> 'status' = 'match' and (pg_temp.an(1)).recipient ->> 'holder' = 'ณัฐพร อยู่ยิ้ม'
  and (pg_temp.an(1)).decision = 'verified' and (pg_temp.an(1)).rules_version = 'rules-2026-11-28' and (pg_temp.an(1)).prompt_version = 'own-v2' and jsonb_array_length((pg_temp.an(1)).recipient -> 'candidates') = 3);
select pg_temp.chk('O03 A: verified moves no money: the slip still waits for a person, nothing is paid', (select status from public.finance_payment_evidence where id = pg_temp.ev(1)) = 'submitted'
  and (public.finance_invoice_state_raw(pg_temp.c('inv1')::uuid) ->> 'paid')::numeric = 0 and not exists (select 1 from public.finance_receipts where evidence_id = pg_temp.ev(1)));
select pg_temp.chk('O04 A: the text that was read is not stored (only the receiver candidates)', (pg_temp.an(1)).extracted::text not like '%จำนวนเงิน%' and (pg_temp.an(1)).extracted::text not like '%ลูกค้า%');
select pg_temp.place(2);
select pg_temp.chk('O05 B: ณัฐพล อยู่ยิ้ม: verified, paid to ณัฐพล', (pg_temp.store(2, pg_temp.three('นาย ณัฐพล อยู่ยิ้ม')) ->> 'decision') = 'verified' and (pg_temp.an(2)).recipient ->> 'holder' = 'ณัฐพล อยู่ยิ้ม', pg_temp.codes(2));
select pg_temp.place(3);
select pg_temp.chk('O06 C: spacing differs in every pass: verified', (pg_temp.store(3, pg_temp.three('ณัฐพร  อยู่ยิ้ม', 'ณัฐพรอยู่ยิ้ม', 'ณัฐพร อยู่ ยิ้ม')) ->> 'decision') = 'verified', pg_temp.codes(3));
select pg_temp.place(4);
select pg_temp.chk('O07 D: a misread letter in every pass: a person decides, never verified', (pg_temp.store(4, pg_temp.three('ณัฐพธ อยู่ยิ้ม')) ->> 'decision') = 'review_required'
  and (pg_temp.an(4)).result = 'manual_review' and pg_temp.codes(4) = 'RECEIVER_UNCERTAIN', pg_temp.codes(4));
select pg_temp.place(5);
select pg_temp.chk('O08 D: one pass right, another misread: still ours (no pass says someone else)', (pg_temp.store(5, pg_temp.three('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม', 'ณ')) ->> 'decision') = 'verified', pg_temp.codes(5));
select pg_temp.place(6);
select pg_temp.chk('O09 E: someone else in every pass: rejected', (pg_temp.store(6, pg_temp.three('นาย สมชาย ใจดี')) ->> 'decision') = 'rejected' and (pg_temp.an(6)).result = 'suspicious_slip'
  and pg_temp.codes(6) = 'RECEIVER_MISMATCH', pg_temp.codes(6));
select pg_temp.place(7);
select pg_temp.chk('O10 E: someone else, with the amount right and a confidence of 0.99: still rejected (no score outweighs the receiver)',
  (pg_temp.store(7, pg_temp.three('นาย สมชาย ใจดี'), '{"field_confidence": {"amount": 0.99, "date": 0.99, "time": 0.99, "receiver": 0.99, "ref": 0.99}}', 0.99) ->> 'decision') = 'rejected', pg_temp.codes(7));
select pg_temp.chk('O11 E: the customer is told what a clean slip is told (a forger learns nothing)', pg_temp.told(7) = '{"state": "review"}'::jsonb and pg_temp.told(1) = '{"state": "review"}'::jsonb, pg_temp.told(7)::text);
select pg_temp.place(8);
select pg_temp.chk('O12 E: someone else in ONE pass only: a person decides (one bad OCR pass cannot reject)', (pg_temp.store(8, pg_temp.three('นาย สมชาย ใจดี', 'ณ', 'ณ')) ->> 'decision') = 'review_required'
  and pg_temp.codes(8) = 'RECEIVER_UNCERTAIN', pg_temp.codes(8));
select pg_temp.place(9);
select pg_temp.chk('O13 E: ours in one pass and someone else in another: a person decides', (pg_temp.store(9, pg_temp.three('ณัฐพร อยู่ยิ้ม', 'นาย สมชาย ใจดี', 'นาย สมชาย ใจดี')) ->> 'decision') = 'review_required', pg_temp.codes(9));
select pg_temp.place(10);
select pg_temp.chk('O14 F: no receiver found: review required, never verified', (pg_temp.store(10, concat_ws(chr(12), 'โอนเงินสำเร็จ', 'จำนวนเงิน 100.00', 'xx')) ->> 'decision') = 'review_required'
  and (pg_temp.an(10)).recipient ->> 'status' = 'unclear' and pg_temp.codes(10) = 'RECEIVER_UNCLEAR', pg_temp.codes(10));
select pg_temp.place(11);
select pg_temp.chk('O15 F: our first name only: review required', (pg_temp.store(11, pg_temp.three('ณัฐพร')) ->> 'decision') = 'review_required', pg_temp.codes(11));
select pg_temp.place(12);
select pg_temp.chk('O16 G: the right receiver and another amount, read with certainty: rejected', (pg_temp.store(12, pg_temp.three('ณัฐพร อยู่ยิ้ม'), '{"amount": 1.00}') ->> 'decision') = 'rejected'
  and (pg_temp.an(12)).result = 'amount_mismatch', pg_temp.codes(12));
select pg_temp.place(13);
select pg_temp.chk('O17 G: ... read without certainty: review required (never verified)', (pg_temp.store(13, pg_temp.three('ณัฐพร อยู่ยิ้ม'), '{"amount": 1.00, "field_confidence": {"amount": 0.7, "date": 0.95, "time": 0.95, "receiver": 0, "ref": 0.9}}', 0.7) ->> 'decision') = 'review_required', pg_temp.codes(13));
select pg_temp.place(14);
select pg_temp.chk('O18 H: the right receiver and the reference of another slip: rejected as a duplicate',
  (pg_temp.store(14, pg_temp.three('ณัฐพร อยู่ยิ้ม'), '{"trans_ref": "RCPREF000001"}', 0.95, '{"trans_ref": "RCPREF000001"}') ->> 'decision') = 'rejected' and (pg_temp.an(14)).result = 'duplicate_suspected', pg_temp.codes(14));
select pg_temp.place(15);
select pg_temp.chk('O19 H: the same file as another slip: rejected', (pg_temp.store(15, pg_temp.three('ณัฐพร อยู่ยิ้ม'), '{}', 0.95, jsonb_build_object('file_sha256', pg_temp.sha(1))) ->> 'decision') = 'rejected', pg_temp.codes(15));
-- H: the payment itself cannot be confirmed twice with the same bank reference (the unique index of 20261120100000 still guards it)
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_confirm_evidence(pg_temp.ev(1), pg_temp.c('tot1')::numeric, 'BANKREF-RCP-0001', now() - interval '1 minute');
select pg_temp.err_like('O20 H: a second confirmation with the same bank reference is refused', format($q$select public.finance_confirm_evidence(%L, %s, 'BANKREF-RCP-0001', now() - interval '30 seconds')$q$, pg_temp.ev(14), pg_temp.c('tot14')), '%23505%');
select pg_temp.place(16);
select pg_temp.chk('O21 a receiver the browser claims is ignored: the database reads the text', (pg_temp.store(16, pg_temp.three('นาย สมชาย ใจดี'),
  '{"receiver": {"name": "ณัฐพร อยู่ยิ้ม", "account_hint": "9380319542"}, "receiver_candidates": [{"name": "ณัฐพร อยู่ยิ้ม"}, {"name": "ณัฐพร อยู่ยิ้ม"}]}') ->> 'decision') = 'rejected', pg_temp.codes(16));
select pg_temp.place(17);
select pg_temp.chk('O22 our name in the memo and the sender line does not make a slip ours',
  (pg_temp.store(17, concat_ws(chr(12), E'จาก น.ส. ณัฐพร อยู่ยิ้ม\nไปยัง นาย สมชาย ใจดี\nบันทึกช่วยจำ ณัฐพร อยู่ยิ้ม', E'จาก น.ส. ณัฐพร อยู่ยิ้ม\nไปยัง นาย สมชาย ใจดี', 'x')) ->> 'decision') = 'rejected', pg_temp.codes(17));
select pg_temp.place(18); select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('O23 an old reader (one text, browser-ocr/1) can never reject on the receiver alone', (select public.finance_store_reading(pg_temp.ev(18), pg_temp.ex(18), jsonb_build_object('found', true, 'crc_ok', true, 'sending_bank', '004', 'trans_ref', 'RCPREF0000018', 'file_sha256', pg_temp.sha(18)),
  0.95, pg_temp.slip('นาย สมชาย ใจดี'), 'browser-ocr/1') ->> 'decision') = 'review_required', pg_temp.codes(18));

-- =========================================================================================== R the AI reader (one name read): the same receiver rule
update public.finance_settings set ai_review_enabled = true; select pg_temp.place(19); select pg_temp.place(20); select pg_temp.place(21);
select pg_temp.chk('R01 the AI reads our name: verified', (select public.finance_analysis_complete(id, pg_temp.ex(19, '{"receiver": {"name": "นางสาว ณัฐพร อยู่ยิ้ม", "account_hint": null}}'), '{"found": false}', 0.95, '[]', 'claude-haiku-5-5', 'v1') ->> 'decision'
  from public.finance_slip_analysis where evidence_id = pg_temp.ev(19)) = 'verified', pg_temp.codes(19));
select pg_temp.chk('R02 the AI reads someone else: rejected (one clear name is enough for it)', (select public.finance_analysis_complete(id, pg_temp.ex(20, '{"receiver": {"name": "นาย สมชาย ใจดี", "account_hint": null}}'), '{"found": false}', 0.97, '[]', 'claude-haiku-5-5', 'v1') ->> 'decision'
  from public.finance_slip_analysis where evidence_id = pg_temp.ev(20)) = 'rejected', pg_temp.codes(20));
select pg_temp.chk('R03 the AI cannot hand in receiver candidates of its own; no receiver read is review (it was "match" before)',
  (select public.finance_analysis_complete(id, pg_temp.ex(21, '{"receiver_candidates": [{"name": "ณัฐพร อยู่ยิ้ม"}]}'), '{"found": false}', 0.97, '[]', 'claude-haiku-5-5', 'v1') ->> 'decision'
   from public.finance_slip_analysis where evidence_id = pg_temp.ev(21)) = 'review_required' and not ((pg_temp.an(21)).extracted ? 'receiver_candidates') and pg_temp.codes(21) = 'RECEIVER_UNCLEAR', pg_temp.codes(21));
update public.finance_settings set ai_review_enabled = false;

-- =========================================================================================== P the outcome rules (pure)
select pg_temp.chk('P01 a critical failure beats a match result', public.finance_slip_decision('match', '[{"code": "RECEIVER_MISMATCH", "severity": "high"}]', null) ->> 'decision' = 'rejected');
select pg_temp.chk('P02 match with nothing in doubt is verified; an info note does not matter', public.finance_slip_decision('match', '[{"code": "RESUBMITTED_TRANSFER", "severity": "info"}]', null) ->> 'decision' = 'verified');
select pg_temp.chk('P03 match with a warning is review', public.finance_slip_decision('match', '[{"code": "TIME_MISSING", "severity": "warn"}]', null) ->> 'decision' = 'review_required');
select pg_temp.chk('P04 an amount read without certainty is review, with certainty rejected',
  public.finance_slip_decision('amount_mismatch', '[{"code": "AMOUNT_OVER", "severity": "high"}]', '{"field_confidence": {"amount": 0.7}}') ->> 'decision' = 'review_required'
  and public.finance_slip_decision('amount_mismatch', '[{"code": "AMOUNT_OVER", "severity": "high"}]', '{"field_confidence": {"amount": 0.95}}') ->> 'decision' = 'rejected');
select pg_temp.chk('P05 the critical codes are listed', public.finance_slip_decision('duplicate_suspected', '[{"code": "DUPLICATE_FILE", "severity": "high"}, {"code": "QR_BAD_CRC", "severity": "high"}]', null) -> 'critical' = '["DUPLICATE_FILE", "QR_BAD_CRC"]'::jsonb);
select pg_temp.chk('P06 a QR reference that differs is review (OCR misreads references), not rejected', public.finance_slip_decision('suspicious_slip', '[{"code": "QR_REF_MISMATCH", "severity": "high"}]', null) ->> 'decision' = 'review_required');

-- =========================================================================================== I feedback and learning (scenario I)
-- two slips where the reader keeps reading ณัฐพธ: staff say the receiver was ณัฐพร, the bank confirmed both
select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('I01 a clerk cannot judge a reading', format($q$select public.finance_slip_feedback_add(%L, 'correct')$q$, (pg_temp.an(1)).id), '%not allowed%');
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('I02 nor can a customer', format($q$select public.finance_slip_feedback_add(%L, 'correct')$q$, (pg_temp.an(1)).id), '%not allowed%');
select pg_temp.as_user(pg_temp.c('V')::uuid);
select pg_temp.chk('I03 a verifier says a reading was right', (public.finance_slip_feedback_add((pg_temp.an(1)).id, 'correct') ->> 'correct_decision') = 'verified');
select pg_temp.err_like('I04 "wrong" must say what was wrong', format($q$select public.finance_slip_feedback_add(%L, 'wrong')$q$, (pg_temp.an(4)).id), 'FEEDBACK_INCOMPLETE%');
select pg_temp.err_like('I05 the receiver must be one of our holders (or OTHER)', format($q$select public.finance_slip_feedback_add(%L, 'wrong', null, 'นาย สมชาย ใจดี')$q$, (pg_temp.an(4)).id), 'INVALID_RECIPIENT%');
select pg_temp.chk('I06 a verifier corrects the receiver of slip 4', (public.finance_slip_feedback_add((pg_temp.an(4)).id, 'wrong', 'verified', 'ณัฐพร อยู่ยิ้ม', 'น.ส. ณัฐพร อยู่ยิ้ม', 'OCR read ธ for ร') ->> 'recipient_truth') = 'ณัฐพร อยู่ยิ้ม');
select pg_temp.err_like('I07 feedback is never changed', format($q$update public.finance_slip_feedback set verdict = 'correct' where analysis_id = %L$q$, (pg_temp.an(4)).id), '%never changed%');
reset role;
select pg_temp.err_like('I08 ... nor deleted, even by the owner', format($q$delete from public.finance_slip_feedback where analysis_id = %L$q$, (pg_temp.an(4)).id), '%never changed or deleted%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('I09 one correction is not a proposal', not exists (select 1 from jsonb_array_elements(public.finance_slip_learning(30) -> 'corrections') c where (c ->> 'proposed')::boolean));
select pg_temp.chk('I10 a correction on a slip that is not posted yet is not counted as bank-confirmed', exists (select 1 from jsonb_array_elements(public.finance_slip_learning(30) -> 'corrections') c
  where c ->> 'read' = 'ณัฐพธ อยู่ยิ้ม' and (c ->> 'slips')::int = 1 and (c ->> 'posted')::int = 0), (public.finance_slip_learning(30) -> 'corrections')::text);
select pg_temp.place(22);
select pg_temp.store(22, pg_temp.three('ณัฐพธ อยู่ยิ้ม'));
select pg_temp.as_user(pg_temp.c('V')::uuid);
select public.finance_slip_feedback_add((pg_temp.an(22)).id, 'wrong', 'verified', 'ณัฐพร อยู่ยิ้ม');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('I11 two corrections, neither posted: still no proposal (a correction alone is not bank truth)', not exists (select 1 from jsonb_array_elements(public.finance_slip_learning(30) -> 'corrections') c where (c ->> 'proposed')::boolean));
select public.finance_confirm_evidence(pg_temp.ev(4), pg_temp.c('tot4')::numeric, 'BANKREF-RCP-0004', now() - interval '1 minute'); select public.finance_post_evidence(pg_temp.ev(4));
select public.finance_confirm_evidence(pg_temp.ev(22), pg_temp.c('tot22')::numeric, 'BANKREF-RCP-0022', now() - interval '1 minute'); select public.finance_post_evidence(pg_temp.ev(22));
select pg_temp.chk('I12 two corrections on two slips the bank confirmed: ณัฐพธ อยู่ยิ้ม is PROPOSED (not applied)', exists (select 1 from jsonb_array_elements(public.finance_slip_learning(30) -> 'corrections') c
  where c ->> 'read' = 'ณัฐพธ อยู่ยิ้ม' and c ->> 'holder' = 'ณัฐพร อยู่ยิ้ม' and (c ->> 'proposed')::boolean and (c ->> 'posted')::int = 2), (public.finance_slip_learning(30) -> 'corrections')::text);
select pg_temp.place(23);
select pg_temp.chk('I13 a proposal changes nothing by itself: the same reading is still review', (pg_temp.store(23, pg_temp.three('ณัฐพธ อยู่ยิ้ม')) ->> 'decision') = 'review_required');
select pg_temp.chk('I14 the impact of the spelling is shown before approving it', (public.finance_slip_variant_impact('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม') ->> 'posted')::int = 2
  and (public.finance_slip_variant_impact('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม') ->> 'rejected')::int = 0, public.finance_slip_variant_impact('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม')::text);
select pg_temp.as_user(pg_temp.c('V')::uuid);
select pg_temp.err_like('I15 a verifier cannot approve a spelling', $q$select public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม', 'ocr')$q$, '%not allowed%');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.chk('I16 a manager approves it', (public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม', 'ocr', 'read twice on confirmed slips', 'learned') ->> 'status') = 'active');
select pg_temp.chk('I17 ... and that is in the audit trail with its impact', exists (select 1 from public.finance_events where action = 'recipient.variant_add' and (detail -> 'impact' ->> 'posted')::int = 2));
select pg_temp.place(24);
select pg_temp.chk('I18 from now on that reading is ours (an approved OCR variant)', (pg_temp.store(24, pg_temp.three('ณัฐพธ อยู่ยิ้ม')) ->> 'decision') = 'verified' and (pg_temp.an(24)).recipient ->> 'method' = 'variant', pg_temp.codes(24));
select pg_temp.chk('I19 the readings of before keep what they said (history is not rewritten)', (pg_temp.an(23)).decision = 'review_required' and (pg_temp.an(4)).decision = 'review_required');
select pg_temp.err_like('I20 an OCR variant far from the name is refused', $q$select public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'สมชาย ใจดี', 'ocr')$q$, 'VARIANT_TOO_FAR%');
select pg_temp.err_like('I21 an English spelling with Thai letters is refused', $q$select public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'ณัฐพร Y', 'english')$q$, 'INVALID_VARIANT%');
select pg_temp.err_like('I22 a holder without an account is refused', $q$select public.finance_slip_variant_add('นาย สมชาย ใจดี', 'SOMCHAI J', 'english')$q$, 'INVALID_RECIPIENT%');
select pg_temp.err_like('I23 a spelling that exists already is refused', $q$select public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'น.ส. ณัฐพธ อยู่ยิ้ม', 'ocr')$q$, 'VARIANT_EXISTS%');
-- a name read on a slip staff REJECTED can never be approved: it may be the very name a forger uses
select pg_temp.place(25); select pg_temp.store(25, pg_temp.three('ณัฐพง อยู่ยิ้ม')); select public.finance_reject_evidence(pg_temp.ev(25), 'not our transfer');
select pg_temp.err_like('I24 a spelling read on a rejected slip is refused', $q$select public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'ณัฐพง อยู่ยิ้ม', 'ocr')$q$, 'VARIANT_SEEN_ON_REJECTED%');
select public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'NATTHAPORN YOOYIM', 'english');
select pg_temp.chk('I25 an English spelling for slips that print one', pg_temp.m('MS. NATTHAPORN Y') = 'match', public.finance_recipient_match('MS. NATTHAPORN Y', null)::text || ' ' || (select string_agg(holder || '=' || name || '/' || src, '; ') from public.finance_slip_holders()));
select public.finance_slip_variant_retire((select id from public.finance_slip_name_variants where variant = 'ณัฐพธ อยู่ยิ้ม'), 'the reader was fixed');
select pg_temp.chk('I26 a manager retires a spelling: it stops counting', (select status from public.finance_slip_name_variants where variant = 'ณัฐพธ อยู่ยิ้ม') = 'retired' and pg_temp.m('ณัฐพธ อยู่ยิ้ม') = 'near',
  public.finance_recipient_match('ณัฐพธ อยู่ยิ้ม', null)::text);
select pg_temp.err_like('I27 a retired spelling is never changed again', $q$update public.finance_slip_name_variants set status = 'active' where variant = 'ณัฐพธ อยู่ยิ้ม'$q$, '%never changed%');
select pg_temp.err_like('I28 a spelling is never deleted', $q$delete from public.finance_slip_name_variants where variant = 'ณัฐพธ อยู่ยิ้ม'$q$, '%never deleted%');
select pg_temp.chk('I29 a variant of a holder whose account is closed stops counting', (select count(*) from public.finance_slip_holders() where src = 'english') = 1);
update public.finance_payment_accounts set active = false where label = 'KASIKORN BANK'; update public.finance_bank_accounts set active = false where code = 'BBL';
select pg_temp.chk('I30 ... (ณัฐพร has no active account now)', (select count(*) from public.finance_slip_holders() where src = 'english') = 0 and pg_temp.m('ณัฐพร อยู่ยิ้ม') = 'near');
update public.finance_payment_accounts set active = true where label = 'KASIKORN BANK'; update public.finance_bank_accounts set active = true where code = 'BBL';

-- =========================================================================================== K the report, measured only on what people established
select pg_temp.chk('K01 the report counts the outcomes of the newest reading per slip', pg_temp.kd('decisions.verified') >= 5 and pg_temp.kd('decisions.rejected') >= 5);
select pg_temp.chk('K02 a slip the reader verified but no person posted is "open", not counted as right', pg_temp.kd('outcomes.open') > 0 and pg_temp.kd('outcomes.verified_posted') = 0,
  (public.finance_slip_learning(30) -> 'outcomes')::text);
select pg_temp.chk('K03 posted slips the reader sent to a person are counted as such', pg_temp.kd('outcomes.review_posted') = 2, (public.finance_slip_learning(30) -> 'outcomes')::text);
select pg_temp.chk('K04 a rejected slip the reader rejected too', pg_temp.kd('outcomes.review_rejected') = 1, (public.finance_slip_learning(30) -> 'outcomes')::text);
select pg_temp.chk('K05 feedback and receiver counts', pg_temp.kd('feedback.recipient_corrected') = 2 and pg_temp.kd('recipient.mismatch') >= 3);
select pg_temp.chk('K06 the amount read on posted slips is compared with the bank', pg_temp.kd('amount_on_posted.right') = 2, (public.finance_slip_learning(30) -> 'amount_on_posted')::text);
select pg_temp.chk('K07 weeks, calibration bands and reasons are there', jsonb_array_length(public.finance_slip_learning(30) -> 'weeks') >= 1 and jsonb_array_length(public.finance_slip_learning(30) -> 'calibration') >= 1
  and jsonb_array_length(public.finance_slip_learning(30) -> 'reasons') >= 3);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('K08 a customer cannot read the report', $q$select public.finance_slip_learning(30)$q$, '%not allowed%');
select pg_temp.err_like('K09 nor the recipients list', $q$select public.finance_slip_recipients()$q$, '%not allowed%');

-- =========================================================================================== S security and the customer's phone
reset role; insert into t_ctx select 'an1', (pg_temp.an(1)).id::text; insert into t_ctx select 'ev1', pg_temp.ev(1)::text;
set local role anon;
select pg_temp.err_like('S01 anon cannot read the report', $q$select public.finance_slip_learning(30)$q$, '%permission denied%');
select pg_temp.err_like('S02 anon cannot give feedback', format($q$select public.finance_slip_feedback_add(%L, 'correct')$q$, pg_temp.c('an1')), '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('S03 the receiver check is internal, even for a manager', $q$select public.finance_recipient_check('[]', 1)$q$, '%permission denied%');
select pg_temp.err_like('S04 ... and so is the list of holders with account numbers', $q$select * from public.finance_slip_holders()$q$, '%permission denied%');
select pg_temp.err_like('S05 ... and the classifier', format($q$select public.finance_classify_slip(%L, '{}', '{}', 0.9, '[]')$q$, pg_temp.c('ev1')), '%permission denied%');
select pg_temp.chk('S07 staff read the spellings table; a customer sees no row of it', (select count(*) from public.finance_slip_name_variants) >= 2);
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('S06 a customer cannot approve a spelling', $q$select public.finance_slip_variant_add('ณัฐพร อยู่ยิ้ม', 'ณัฐพธ อยู่ยิ้ม', 'ocr')$q$, '%not allowed%');
select pg_temp.chk('S08 ...', (select count(*) from public.finance_slip_name_variants) = 0 and (select count(*) from public.finance_slip_feedback) = 0);
select pg_temp.chk('S09 the phone gets the names the payment card shows, never an OCR variant and never a number',
  (public.finance_own_reader() -> 'recipients') @> '["ณัฐพร อยู่ยิ้ม", "ณัฐพล อยู่ยิ้ม", "NATTHAPORN YOOYIM"]'::jsonb and not ((public.finance_own_reader() -> 'recipients')::text ~ '[0-9]{4}')
  and not ((public.finance_own_reader() -> 'recipients') @> '["ณัฐพธ อยู่ยิ้ม"]'::jsonb), (public.finance_own_reader() -> 'recipients')::text);
reset role; update public.finance_settings set checkout_check_enabled = false; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.chk('S10 ... and nothing while the check before ordering is off', public.finance_own_reader() -> 'recipients' = '[]'::jsonb);
reset role;
select pg_temp.chk('S11 every new attempt is logged with its outcome', (select count(*) from public.finance_events where action = 'evidence.analysis' and detail ? 'decision') >= 20);
select pg_temp.chk('S12 the tables refuse a value outside their lists', not exists (select 1 from public.finance_slip_analysis where decision is not null and decision not in ('verified', 'review_required', 'rejected')));

do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'RECIPIENT_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
