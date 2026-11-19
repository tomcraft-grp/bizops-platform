-- AI-assisted slip review with end-of-day approval, tested against REAL data (real catalogue, real profiles, real bank accounts) inside one
-- transaction that is rolled back (scripts/run-slip-review-sql-tests.sh sends the new migration followed by this file). Nothing persists: the last
-- statement raises an exception that carries the result table.
-- Customers A and B are real LINE members, C gets a verifier role, S is a real SUPER_ADMIN (a finance manager).
-- Scenarios: S1 schema (settings, evidence columns, analysis table, ledger queue, receipts, RLS).
--            S2 analysis (the queue trigger, the classifier, begin / complete / fail, request, who may call what).
--            S3 workflow (Confirm, Post, Reject, Request more evidence, Record payment, the one-step verify kept as it was, reports, RLS, grants).
--            S4 reads (the review list, summary and detail, the settings read, the derived stage, and the cancel guard for a confirmed payment).
--            S5 customer order list (shop_my_orders: an order that asks the customer for more evidence is in the To pay chip).
-- Later tasks append their sections above the result block at the bottom.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
-- the statement must FAIL with a message that matches the pattern (an inner BEGIN/EXCEPTION block = a savepoint, so the run goes on)
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; d text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then
    get stacked diagnostics d = pg_exception_detail; m := sqlerrm || coalesce(' | ' || d, ''); perform pg_temp.chk(p_test, m ilike p_pat, m);
  end;
end $$;
-- the statement must SUCCEED (a failure, for instance a missing column, is recorded as a failed check instead of aborting the run)
create or replace function pg_temp.runs_ok(p_test text, p_sql text) returns void language plpgsql as $$
declare m text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, true);
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, false, m);
  end;
end $$;
-- the query must return ONE boolean that is true (a missing column or table is a recorded failure, not an aborted run)
create or replace function pg_temp.q(p_test text, p_sql text) returns void language plpgsql as $$
declare b boolean; m text;
begin
  begin execute p_sql into b; perform pg_temp.chk(p_test, b, case when b is true then null else 'returned ' || coalesce(b::text, 'null') end);
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, false, m);
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
update public.shop_settings set shop_open = true, pickup_enabled = true, delivery_enabled = true, shipping_fee = 50, free_shipping_min = null, require_payment_slip = false;

-- =========================================================================================== S1 schema
-- one real order and one real slip (through the shop's own functions) to hang the schema checks on
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o1', public.shop_place_order('slip-key-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, null, 2 * pg_temp.c('P1')::numeric, 'bank:SCB')::text;
insert into t_ctx select 'i1id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o1';
insert into t_ctx select 'ev1', public.finance_submit_evidence(pg_temp.c('i1id')::uuid, pg_temp.c('A') || '/slip-s1a.png', repeat('1', 64), 'image/png', 2 * pg_temp.c('P1')::numeric, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
reset role;
insert into t_ctx select 'cust', customer_id::text from public.finance_invoices where id = pg_temp.c('i1id')::uuid;
insert into t_res (test, ok, detail) select 'S1 a real order and slip exist to test against', pg_temp.c('ev1') is not null and pg_temp.c('cust') is not null, null;

-- ---- settings: five new columns, all dark by default
select pg_temp.q('S1 settings: ai_review_enabled is a boolean, not null, default false',
  $$select data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false' from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings' and column_name = 'ai_review_enabled'$$);
select pg_temp.q('S1 settings: post_requires_manager is a boolean, not null, default false',
  $$select data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false' from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings' and column_name = 'post_requires_manager'$$);
select pg_temp.q('S1 settings: ai_min_confidence is numeric, not null, default 0.80',
  $$select data_type = 'numeric' and is_nullable = 'NO' and column_default::numeric = 0.80 from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings' and column_name = 'ai_min_confidence'$$);
select pg_temp.q('S1 settings: slip_window_before_min is an integer, not null, default 120',
  $$select data_type = 'integer' and is_nullable = 'NO' and column_default = '120' from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings' and column_name = 'slip_window_before_min'$$);
select pg_temp.q('S1 settings: slip_future_tolerance_min is an integer, not null, default 10',
  $$select data_type = 'integer' and is_nullable = 'NO' and column_default = '10' from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings' and column_name = 'slip_future_tolerance_min'$$);
select pg_temp.err_like('S1 settings: a confidence above 1 is refused', $q$update public.finance_settings set ai_min_confidence = 1.5$q$, '%violates check constraint "finance_settings_ai_min_confidence_chk"%');
select pg_temp.err_like('S1 settings: a negative confidence is refused', $q$update public.finance_settings set ai_min_confidence = -0.1$q$, '%violates check constraint "finance_settings_ai_min_confidence_chk"%');
select pg_temp.err_like('S1 settings: a negative slip window is refused', $q$update public.finance_settings set slip_window_before_min = -1$q$, '%violates check constraint "finance_settings_slip_window_before_min_chk"%');
select pg_temp.err_like('S1 settings: a negative future tolerance is refused', $q$update public.finance_settings set slip_future_tolerance_min = -1$q$, '%violates check constraint "finance_settings_slip_future_tolerance_min_chk"%');
-- the tests below run with the shipped (dark) values whatever the live row says today
select pg_temp.runs_ok('S1 settings: the dark defaults are accepted (and pinned for the rest of this run)',
  $q$update public.finance_settings set ai_review_enabled = false, post_requires_manager = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10$q$);

-- ---- evidence: new columns
select pg_temp.q('S1 evidence: the 14 new columns exist',
  $$select count(*) = 14 from information_schema.columns where table_schema = 'public' and table_name = 'finance_payment_evidence'
      and column_name in ('source', 'method', 'recorded_by', 'confirmed_by', 'confirmed_at', 'confirmed_amount', 'confirmed_bank_ref', 'confirmed_transfer_at', 'confirm_note',
                          'posted_by', 'posted_at', 'request_message', 'requested_by', 'requested_at')$$);
select pg_temp.q('S1 evidence: a slip that already exists reads as a customer slip paid by transfer, not yet confirmed or posted',
  format($$select source = 'customer_slip' and method = 'transfer' and confirmed_by is null and confirmed_at is null and posted_at is null and requested_at is null from public.finance_payment_evidence where id = %L$$, pg_temp.c('ev1')));
select pg_temp.err_like('S1 evidence: an unknown source is refused', format($q$update public.finance_payment_evidence set source = 'bogus' where id = %L$q$, pg_temp.c('ev1')), '%violates check constraint "finance_payment_evidence_source_chk"%');
select pg_temp.err_like('S1 evidence: an unknown method is refused', format($q$update public.finance_payment_evidence set method = 'bogus' where id = %L$q$, pg_temp.c('ev1')), '%violates check constraint "finance_payment_evidence_method_chk"%');
select pg_temp.err_like('S1 evidence: a confirmed amount of zero is refused', format($q$update public.finance_payment_evidence set confirmed_amount = 0 where id = %L$q$, pg_temp.c('ev1')), '%violates check constraint "finance_payment_evidence_confirmed_amount_chk"%');

-- ---- evidence: statuses (the five of the spec; no new column is used here, so this fails on the status list alone)
select pg_temp.runs_ok('S1 evidence status: confirmed is accepted', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status)
  values (%L, %L, 'S1/status-confirmed', %L, 'image/png', 100, 'confirmed')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('2', 64)));
select pg_temp.runs_ok('S1 evidence status: more_evidence is accepted', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status)
  values (%L, %L, 'S1/status-more', %L, 'image/png', 100, 'more_evidence')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('3', 64)));
select pg_temp.runs_ok('S1 evidence status: verified (= posted) is still accepted', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status)
  values (%L, %L, 'S1/status-verified', %L, 'image/png', 100, 'verified')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('4', 64)));
select pg_temp.runs_ok('S1 evidence status: rejected is still accepted', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status)
  values (%L, %L, 'S1/status-rejected', %L, 'image/png', 100, 'rejected')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('5', 64)));
select pg_temp.err_like('S1 evidence status: an unknown status is refused on insert', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status)
  values (%L, %L, 'S1/status-bogus', %L, 'image/png', 100, 'bogus')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('6', 64)), '%violates check constraint "finance_payment_evidence_status_chk"%');
select pg_temp.err_like('S1 evidence status: an unknown status is refused on update', format($q$update public.finance_payment_evidence set status = 'bogus' where id = %L$q$, pg_temp.c('ev1')), '%violates check constraint "finance_payment_evidence_status_chk"%');
select pg_temp.q('S1 evidence status: exactly one check constraint lists the statuses, and it is the new five-value one (the old three-value one is gone)',
  $$select count(*) filter (where pg_get_constraintdef(c.oid) ilike '%submitted%') = 1 and count(*) filter (where pg_get_constraintdef(c.oid) ilike '%more_evidence%') = 1
    from pg_constraint c where c.conrelid = 'public.finance_payment_evidence'::regclass and c.contype = 'c'$$);

-- ---- evidence: the file is required unless a staff member recorded the payment
select pg_temp.runs_ok('S1 evidence file: a staff_entry without any file is accepted (cash at the counter)', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, claimed_amount, status, source, method, recorded_by)
  values (%L, %L, 100, 'confirmed', 'staff_entry', 'cash', %L)$q$, pg_temp.c('i1id'), pg_temp.c('cust'), pg_temp.c('S')::uuid));
select pg_temp.runs_ok('S1 evidence file: a staff_entry with a complete file (path, hash, type) is accepted', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, source, method)
  values (%L, %L, 'S1/staff-with-file', %L, 'image/png', 100, 'confirmed', 'staff_entry', 'transfer')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('7', 64)));
select pg_temp.err_like('S1 evidence file: a customer_slip without a file is refused (the default source)', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, claimed_amount, status)
  values (%L, %L, 100, 'submitted')$q$, pg_temp.c('i1id'), pg_temp.c('cust')), '%violates check constraint "finance_evidence_file_required_chk"%');
select pg_temp.err_like('S1 evidence file: a customer_slip without a file is refused (source named)', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, claimed_amount, status, source)
  values (%L, %L, 100, 'submitted', 'customer_slip')$q$, pg_temp.c('i1id'), pg_temp.c('cust')), '%violates check constraint "finance_evidence_file_required_chk"%');
select pg_temp.err_like('S1 evidence file: a staff_entry cannot carry half a file (a path without its hash)', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, claimed_amount, status, source)
  values (%L, %L, 'S1/half-file', 100, 'confirmed', 'staff_entry')$q$, pg_temp.c('i1id'), pg_temp.c('cust')), '%violates check constraint "finance_evidence_file_required_chk"%');
select pg_temp.err_like('S1 evidence file: a customer_slip cannot lose its file by an update', format($q$update public.finance_payment_evidence set file_path = null, file_sha256 = null, file_type = null where id = %L$q$, pg_temp.c('ev1')), '%violates check constraint "finance_evidence_file_required_chk"%');
select pg_temp.err_like('S1 evidence file: a bad file hash is still refused', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, source)
  values (%L, %L, 'S1/bad-hash', 'xyz', 'image/png', 100, 'confirmed', 'staff_entry')$q$, pg_temp.c('i1id'), pg_temp.c('cust')), '%violates check constraint "finance_payment_evidence_file_sha256_check"%');

-- ---- evidence: one bank reference can back only one confirmed or posted payment
select pg_temp.runs_ok('S1 bank ref: the first confirmed payment with a reference is accepted', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, confirmed_amount, confirmed_bank_ref)
  values (%L, %L, 'S1/ref-first', %L, 'image/png', 100, 'confirmed', 100, 'SLIPREF-0001')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('8', 64)));
select pg_temp.err_like('S1 bank ref: a second CONFIRMED payment with the same reference is refused', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, confirmed_amount, confirmed_bank_ref)
  values (%L, %L, 'S1/ref-second', %L, 'image/png', 100, 'confirmed', 100, 'SLIPREF-0001')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('9', 64)), '%finance_evidence_confirmed_ref_once%');
select pg_temp.err_like('S1 bank ref: a second VERIFIED (posted) payment with the same reference is refused', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, confirmed_amount, confirmed_bank_ref)
  values (%L, %L, 'S1/ref-verified', %L, 'image/png', 100, 'verified', 100, 'SLIPREF-0001')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('a', 64)), '%finance_evidence_confirmed_ref_once%');
select pg_temp.runs_ok('S1 bank ref: the same reference on a REJECTED payment is allowed', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, confirmed_amount, confirmed_bank_ref)
  values (%L, %L, 'S1/ref-rejected', %L, 'image/png', 100, 'rejected', 100, 'SLIPREF-0001')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('b', 64)));
select pg_temp.runs_ok('S1 bank ref: the first payment can be rejected', $q$update public.finance_payment_evidence set status = 'rejected' where file_path = 'S1/ref-first'$q$);
select pg_temp.q('S1 bank ref: the first payment is now rejected', $$select count(*) = 1 from public.finance_payment_evidence where file_path = 'S1/ref-first' and status = 'rejected'$$);
select pg_temp.runs_ok('S1 bank ref: rejecting it freed the reference for a new confirmation', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, confirmed_amount, confirmed_bank_ref)
  values (%L, %L, 'S1/ref-again', %L, 'image/png', 100, 'confirmed', 100, 'SLIPREF-0001')$q$, pg_temp.c('i1id'), pg_temp.c('cust'), repeat('c', 64)));
select pg_temp.q('S1 bank ref: exactly one confirmed row holds the reference now',
  $$select count(*) = 1 from public.finance_payment_evidence where confirmed_bank_ref = 'SLIPREF-0001' and status in ('confirmed', 'verified')$$);
select pg_temp.err_like('S1 bank ref: a reference shorter than 4 characters is refused', format($q$update public.finance_payment_evidence set confirmed_bank_ref = 'ab' where id = %L$q$, pg_temp.c('ev1')), '%violates check constraint "finance_payment_evidence_confirmed_bank_ref_chk"%');
select pg_temp.runs_ok('S1 bank ref: cash needs no reference (two cash payments without one do not clash)', format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, claimed_amount, status, source, method, confirmed_amount)
  values (%L, %L, 50, 'confirmed', 'staff_entry', 'cash', 50), (%L, %L, 50, 'confirmed', 'staff_entry', 'cash', 50)$q$, pg_temp.c('i1id'), pg_temp.c('cust'), pg_temp.c('i1id'), pg_temp.c('cust')));

-- ---- slip analysis: append-only attempts per evidence
select pg_temp.q('S1 analysis: the table exists with every column of the design',
  $$select count(*) = 18 from information_schema.columns where table_schema = 'public' and table_name = 'finance_slip_analysis'
      and column_name in ('id', 'evidence_id', 'attempt', 'status', 'engine', 'prompt_version', 'extracted', 'qr', 'expected', 'overall_confidence', 'signals', 'result', 'reasons', 'error',
                          'requested_by', 'created_at', 'started_at', 'finished_at')$$);
select pg_temp.runs_ok('S1 analysis: a queued attempt can be added for a slip', format($q$insert into public.finance_slip_analysis (evidence_id, attempt) values (%L, 1)$q$, pg_temp.c('ev1')));
select pg_temp.q('S1 analysis: a new attempt starts queued, with no result and empty reasons and signals',
  format($$select status = 'queued' and result is null and reasons = '[]'::jsonb and signals = '[]'::jsonb and finished_at is null from public.finance_slip_analysis where evidence_id = %L and attempt = 1$$, pg_temp.c('ev1')));
select pg_temp.err_like('S1 analysis: attempt numbers are unique per slip', format($q$insert into public.finance_slip_analysis (evidence_id, attempt) values (%L, 1)$q$, pg_temp.c('ev1')), '%finance_slip_analysis_attempt_once%');
select pg_temp.runs_ok('S1 analysis: the next attempt of the same slip is a new row (history is kept)', format($q$insert into public.finance_slip_analysis (evidence_id, attempt) values (%L, 2)$q$, pg_temp.c('ev1')));
select pg_temp.err_like('S1 analysis: attempt 0 is refused', format($q$insert into public.finance_slip_analysis (evidence_id, attempt) values (%L, 0)$q$, pg_temp.c('ev1')), '%violates check constraint "finance_slip_analysis_attempt_chk"%');
select pg_temp.err_like('S1 analysis: an analysis needs a real slip', $q$insert into public.finance_slip_analysis (evidence_id, attempt) values (gen_random_uuid(), 1)$q$, '%violates foreign key constraint%');
select pg_temp.err_like('S1 analysis: an unknown status is refused', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status) values (%L, 3, 'bogus')$q$, pg_temp.c('ev1')), '%violates check constraint "finance_slip_analysis_status_chk"%');
select pg_temp.err_like('S1 analysis: an unknown result is refused', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status, result) values (%L, 3, 'done', 'bogus')$q$, pg_temp.c('ev1')), '%violates check constraint "finance_slip_analysis_result_chk"%');
select pg_temp.err_like('S1 analysis: a finished analysis must carry a result', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status) values (%L, 3, 'done')$q$, pg_temp.c('ev1')), '%violates check constraint "finance_slip_analysis_done_chk"%');
select pg_temp.err_like('S1 analysis: a failed analysis must carry the error', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status) values (%L, 3, 'failed')$q$, pg_temp.c('ev1')), '%violates check constraint "finance_slip_analysis_failed_chk"%');
select pg_temp.err_like('S1 analysis: a confidence above 1 is refused', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, overall_confidence) values (%L, 3, 1.5)$q$, pg_temp.c('ev1')), '%violates check constraint "finance_slip_analysis_confidence_chk"%');
select pg_temp.runs_ok('S1 analysis: a failed attempt with its error is accepted', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status, error, result) values (%L, 3, 'failed', 'no API key', 'manual_review')$q$, pg_temp.c('ev1')));
insert into t_ctx select 'evC', id::text from public.finance_payment_evidence where file_path = 'S1/status-confirmed';
select pg_temp.runs_ok('S1 analysis: all seven result codes are accepted', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status, result)
  select %L::uuid, t.n, 'done', t.code from unnest(array['match', 'amount_mismatch', 'date_mismatch', 'time_anomaly', 'duplicate_suspected', 'suspicious_slip', 'manual_review']) with ordinality as t(code, n)$q$, pg_temp.c('evC')));
select pg_temp.q('S1 analysis: the seven result rows were stored', format($$select count(*) = 7 and count(distinct result) = 7 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('evC')));
-- a queued attempt moves to running and then to done...
select pg_temp.runs_ok('S1 analysis: a queued attempt can start running', format($q$update public.finance_slip_analysis set status = 'running', started_at = now() where evidence_id = %L and attempt = 1$q$, pg_temp.c('ev1')));
select pg_temp.runs_ok('S1 analysis: a running attempt can finish with its result', format($q$update public.finance_slip_analysis set status = 'done', result = 'match', overall_confidence = 0.95, engine = 'claude-haiku-5-5', prompt_version = 'v1',
  extracted = '{"amount": 100}'::jsonb, qr = '{"found": false}'::jsonb, expected = '{"amount": 100}'::jsonb, reasons = '[]'::jsonb, signals = '[]'::jsonb, finished_at = now() where evidence_id = %L and attempt = 1$q$, pg_temp.c('ev1')));
-- ...and from then on it never changes again
select pg_temp.err_like('S1 analysis: a finished row cannot be edited', format($q$update public.finance_slip_analysis set result = 'amount_mismatch' where evidence_id = %L and attempt = 1$q$, pg_temp.c('ev1')), '%finished slip analysis is never changed%');
select pg_temp.err_like('S1 analysis: a finished row cannot be re-opened', format($q$update public.finance_slip_analysis set status = 'queued' where evidence_id = %L and attempt = 1$q$, pg_temp.c('ev1')), '%finished slip analysis is never changed%');
select pg_temp.err_like('S1 analysis: a failed row cannot be edited either', format($q$update public.finance_slip_analysis set error = 'other' where evidence_id = %L and attempt = 3$q$, pg_temp.c('ev1')), '%finished slip analysis is never changed%');
select pg_temp.err_like('S1 analysis: a finished row cannot be deleted', format($q$delete from public.finance_slip_analysis where evidence_id = %L and attempt = 1$q$, pg_temp.c('ev1')), '%never deleted%');
select pg_temp.err_like('S1 analysis: a queued row cannot be deleted', format($q$delete from public.finance_slip_analysis where evidence_id = %L and attempt = 2$q$, pg_temp.c('ev1')), '%never deleted%');
select pg_temp.err_like('S1 analysis: the slip and attempt number of a queued row cannot be changed', format($q$update public.finance_slip_analysis set attempt = 9 where evidence_id = %L and attempt = 2$q$, pg_temp.c('ev1')), '%cannot be changed%');
select pg_temp.q('S1 analysis: the finished attempt kept what it stored',
  format($$select result = 'match' and overall_confidence = 0.95 and engine = 'claude-haiku-5-5' and (extracted ->> 'amount')::numeric = 100 from public.finance_slip_analysis where evidence_id = %L and attempt = 1$$, pg_temp.c('ev1')));

-- ---- ledger queue and receipts: cash
select pg_temp.runs_ok('S1 ledger queue: CASH_RECEIPT is an accepted event type (Dr cash / Cr receivable)', $q$insert into public.finance_gl_queue (event_type, ref_type, ref_id, ref_no, amount, plan)
  values ('CASH_RECEIPT', 'receipt', gen_random_uuid(), 'RC-S1-CASH', 100, jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'cash', 'amount', 100), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 100)))$q$);
select pg_temp.runs_ok('S1 ledger queue: the earlier event types are still accepted (BANK_RECEIPT)', $q$insert into public.finance_gl_queue (event_type, ref_type, ref_id, ref_no, amount, plan)
  values ('BANK_RECEIPT', 'receipt', gen_random_uuid(), 'RC-S1-BANK', 100, jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', 100), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 100)))$q$);
select pg_temp.err_like('S1 ledger queue: an unknown event type is still refused', $q$insert into public.finance_gl_queue (event_type, ref_type, ref_id, ref_no, amount, plan)
  values ('CASH_BOGUS', 'receipt', gen_random_uuid(), 'RC-S1-BOGUS', 100, jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'cash', 'amount', 100), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 100)))$q$, '%violates check constraint "finance_gl_queue_event_type_chk"%');
select pg_temp.q('S1 ledger queue: exactly one check constraint lists the event types, and it includes CASH_RECEIPT (the old one is gone)',
  $$select count(*) = 1 and bool_or(pg_get_constraintdef(c.oid) like '%CASH_RECEIPT%') from pg_constraint c
    where c.conrelid = 'public.finance_gl_queue'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%event_type%'$$);
select pg_temp.runs_ok('S1 receipts: a cash receipt (method = cash) is accepted', format($q$insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, method, received_at)
  select 'RC-S1-CASH', %L::uuid, %L::uuid, e.id, 100, 'cash', now() from public.finance_payment_evidence e where e.source = 'staff_entry' and e.file_path is null and e.invoice_id = %L::uuid limit 1$q$,
  pg_temp.c('cust'), pg_temp.c('i1id'), pg_temp.c('i1id')));
select pg_temp.q('S1 receipts: the cash receipt was stored with method cash', $$select count(*) = 1 from public.finance_receipts where receipt_no = 'RC-S1-CASH' and method = 'cash'$$);

-- ---- who can read the analysis: staff only (the AI result is never shown to customers)
do $$ begin   -- (a block, so that a missing table is a failed check below and not an aborted run)
  insert into t_ctx select 'an_n', count(*)::text from public.finance_slip_analysis;
exception when others then insert into t_ctx values ('an_n', '0');
end $$;
insert into t_res (test, ok, detail) select 'S1 RLS: there are analysis rows to look at (owner count)', pg_temp.c('an_n')::int > 0, pg_temp.c('an_n');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);                -- the customer whose slip it is
select pg_temp.q('S1 RLS: customer A sees no analysis rows, not even of their own slip', $$select count(*) = 0 from public.finance_slip_analysis$$);
select pg_temp.q('S1 RLS: customer A still sees their own evidence row', format($$select count(*) = 1 from public.finance_payment_evidence where id = %L$$, pg_temp.c('ev1')));
select pg_temp.err_like('S1 RLS: a customer cannot add an analysis', format($q$insert into public.finance_slip_analysis (evidence_id, attempt) values (%L, 50)$q$, pg_temp.c('ev1')), '%permission denied%');
select pg_temp.err_like('S1 RLS: a customer cannot change an analysis', $q$update public.finance_slip_analysis set status = 'queued'$q$, '%permission denied%');
select pg_temp.err_like('S1 RLS: a customer cannot delete an analysis', $q$delete from public.finance_slip_analysis$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);                -- another customer
select pg_temp.q('S1 RLS: customer B sees no analysis rows', $$select count(*) = 0 from public.finance_slip_analysis$$);
reset role; set local role anon;
select pg_temp.err_like('S1 RLS: a signed-out visitor cannot read analysis rows', $q$select count(*) from public.finance_slip_analysis$q$, '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);                -- a verifier
select pg_temp.q('S1 RLS: a verifier sees every analysis row', format($$select count(*) = %s from public.finance_slip_analysis$$, pg_temp.c('an_n')));
select pg_temp.err_like('S1 RLS: a verifier cannot write analysis rows directly either', format($q$insert into public.finance_slip_analysis (evidence_id, attempt) values (%L, 50)$q$, pg_temp.c('ev1')), '%permission denied%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);                -- a finance manager
select pg_temp.q('S1 RLS: a manager sees every analysis row', format($$select count(*) = %s from public.finance_slip_analysis$$, pg_temp.c('an_n')));
reset role;

-- =========================================================================================== S2 analysis
-- The queue trigger, the classifier, begin / complete / fail, a staff re-run, and who may call what. Every statement that uses a function of this
-- section goes through keep / q / err_like / runs_ok / cl, so a missing function is a recorded failed check and the run goes on. Production already holds
-- real invoices and slips: every check below places its own orders and slips (real functions) and looks only at those, never at absolute table counts.
reset role;
grant all on t_res, t_ctx to service_role; grant usage on sequence t_res_n_seq to service_role;
-- keep the text result of a statement in t_ctx (a failure is a recorded failed check, not an aborted run)
create or replace function pg_temp.keep(p_key text, p_sql text) returns void language plpgsql as $$
declare v text;
begin
  begin execute p_sql into v; insert into t_ctx values (p_key, v) on conflict (k) do update set v = excluded.v;
  exception when others then insert into t_ctx values (p_key, null) on conflict (k) do update set v = null; perform pg_temp.chk('S2 setup ' || p_key, false, sqlerrm);
  end;
end $$;
-- a synthetic slip row (carrying a printed or confirmed bank reference) on one of this section's invoices
create or replace function pg_temp.mkev(p_key text, p_invoice text, p_bank_ref text default null, p_conf_ref text default null, p_customer text default 'cust') returns void language plpgsql as $$
declare v uuid;
begin
  begin
    insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, bank_trans_ref, confirmed_bank_ref)
      values (pg_temp.c(p_invoice)::uuid, pg_temp.c(p_customer)::uuid, 'S2/' || p_key, md5('s2-' || p_key) || md5('s2b-' || p_key), 'image/png', 10, p_bank_ref, p_conf_ref) returning id into v;
    insert into t_ctx values (p_key, v::text);
  exception when others then perform pg_temp.chk('S2 setup ' || p_key, false, sqlerrm);
  end;
end $$;
create or replace function pg_temp.aid(p_ev text, p_attempt integer default 1) returns uuid language plpgsql security definer as $$
declare v uuid;
begin
  begin select id into v from public.finance_slip_analysis where evidence_id = pg_temp.c(p_ev)::uuid and attempt = p_attempt;
  exception when others then v := null;       -- (no analysis table: the checks that need the id fail on their own)
  end;
  return v;
end $$;
create or replace function pg_temp.ca(p_user text, p_cap text) returns boolean language plpgsql as $$
begin return public.finance_can_as(pg_temp.c(p_user)::uuid, p_cap); end $$;
-- the slip as the reader would return it (everything right for invoice i3), with overrides; and the QR a slip would carry
create or replace function pg_temp.t3() returns numeric language sql as $$ select v::numeric from t_ctx where k = 'T3' $$;
create or replace function pg_temp.ex(p_over jsonb default '{}'::jsonb) returns jsonb language sql as $$ select (select v::jsonb from t_ctx where k = 'base') || p_over $$;
create or replace function pg_temp.exr(p_ref text) returns jsonb language sql as $$ select pg_temp.ex(jsonb_build_object('trans_ref', p_ref)) $$;
create or replace function pg_temp.qrok(p_over jsonb default '{}'::jsonb) returns jsonb language sql as $$ select '{"found": true, "crc_ok": true, "sending_bank": "014", "trans_ref": "S2REF000000A1"}'::jsonb || p_over $$;
create or replace function pg_temp.qrr(p_ref text) returns jsonb language sql as $$ select pg_temp.qrok(jsonb_build_object('trans_ref', p_ref)) $$;
create or replace function pg_temp.rc(p_receiver jsonb) returns jsonb language sql as $$ select pg_temp.ex(jsonb_build_object('receiver', p_receiver)) $$;
create or replace function pg_temp.hint(p_name text, p_hint text) returns jsonb language sql as $$ select jsonb_build_object('name', p_name, 'bank', 'SCB', 'account_hint', p_hint) $$;
-- classify and compare: the result, the reason codes that must / must not be present, and (optionally) the exact number of reasons
create or replace function pg_temp.cl(p_test text, p_ex jsonb, p_result text, p_codes text[] default '{}', p_absent text[] default '{}', p_qr jsonb default '"dflt"'::jsonb,
                                      p_conf numeric default 0.95, p_sig jsonb default '[]'::jsonb, p_ev text default 'ev3', p_n integer default null) returns void language plpgsql as $$
declare v jsonb; codes text[]; m text;
begin
  begin
    v := public.finance_classify_slip(pg_temp.c(p_ev)::uuid, p_ex, case when p_qr = '"dflt"'::jsonb then pg_temp.qrok() else p_qr end, p_conf, p_sig);
    select coalesce(array_agg(r ->> 'code'), '{}') into codes from jsonb_array_elements(v -> 'reasons') r;
    perform pg_temp.chk(p_test, v ->> 'result' = p_result and codes @> p_codes and not (codes && p_absent) and (p_n is null or jsonb_array_length(v -> 'reasons') = p_n),
      'result=' || coalesce(v ->> 'result', 'null') || ' reasons=' || codes::text);
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, false, m);
  end;
end $$;

-- ---- fixtures. The shop's receiving accounts the classifier compares with: the real bank accounts plus a payment account made for this test (the real default is set
-- aside here and put back at the end of the section).
insert into t_ctx select 'pa_prev', id::text from public.finance_payment_accounts where is_default and active;
update public.finance_payment_accounts set is_default = false where is_default;
insert into public.finance_payment_accounts (label, qr_payload, kind, target, target_type, merchant_name, is_default, active)
  values ('S2 PromptPay', 'S2-not-a-real-qr', 'promptpay', '0066891234567', 'phone', 'Tomcraft Test Shop', true, true);
insert into t_ctx select 'pa_s2', id::text from public.finance_payment_accounts where label = 'S2 PromptPay';
-- order o2 and its slip while the AI review is still off (the dark default)
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o2', public.shop_place_order('slip-key-0002', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, null, 2 * pg_temp.c('P1')::numeric, 'bank:SCB')::text;
insert into t_ctx select 'i2id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o2';
insert into t_ctx select 'ev2', public.finance_submit_evidence(pg_temp.c('i2id')::uuid, pg_temp.c('A') || '/s2-ev2.png', md5('s2-ev2') || md5('s2-ev2b'), 'image/png', 2 * pg_temp.c('P1')::numeric, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
reset role;

-- ---- S2a the queue trigger: a new slip is queued only when the AI review is on and the payment has a file
select pg_temp.q('S2 queue: with the AI review off a new slip queues nothing', format($$select count(*) = 0 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('ev2')));
select pg_temp.runs_ok('S2 queue: the AI review can be switched on (inside this run)', $q$update public.finance_settings set ai_review_enabled = true$q$);
-- o3 and its slips ev3 (the slip every classifier case is judged against), ev5 and ev6; each by customer A through the shop's own functions
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'o3', public.shop_place_order('slip-key-0003', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, null, 2 * pg_temp.c('P1')::numeric, 'bank:SCB')::text;
insert into t_ctx select 'i3id', (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o3';
insert into t_ctx select 'ev3', public.finance_submit_evidence(pg_temp.c('i3id')::uuid, pg_temp.c('A') || '/s2-ev3.png', md5('s2-ev3') || md5('s2-ev3b'), 'image/png', 2 * pg_temp.c('P1')::numeric, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
insert into t_ctx select 'ev5', public.finance_submit_evidence(pg_temp.c('i3id')::uuid, pg_temp.c('A') || '/s2-ev5.png', md5('s2-ev5') || md5('s2-ev5b'), 'image/png', 2 * pg_temp.c('P1')::numeric, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
insert into t_ctx select 'ev6', public.finance_submit_evidence(pg_temp.c('i3id')::uuid, pg_temp.c('A') || '/s2-ev6.png', md5('s2-ev6') || md5('s2-ev6b'), 'image/png', 2 * pg_temp.c('P1')::numeric, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
-- two manual invoices (no shop order) by manager S: i4 for the expected-amount checks, i5 to claim an analysis by invoice
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'i4id', (public.finance_create_invoice(pg_temp.c('cust')::uuid, 500.00, date '2026-11-18', date '2026-11-18', 'S2 test invoice 4', 'S2-INV-0004')).id::text;
insert into t_ctx select 'i5id', (public.finance_create_invoice(pg_temp.c('cust')::uuid, 120.00, date '2026-11-18', date '2026-11-18', 'S2 test invoice 5', 'S2-INV-0005')).id::text;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'ev4', public.finance_submit_evidence(pg_temp.c('i4id')::uuid, pg_temp.c('A') || '/s2-ev4.png', md5('s2-ev4') || md5('s2-ev4b'), 'image/png', 500.00, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
insert into t_ctx select 'ev7', public.finance_submit_evidence(pg_temp.c('i5id')::uuid, pg_temp.c('A') || '/s2-ev7.png', md5('s2-ev7') || md5('s2-ev7b'), 'image/png', 120.00, now(), 'SCB', null, pg_temp.c('scb')::uuid)::text;
reset role;
-- fixed clock for the classifier: order and invoice 14:00, slip uploaded 14:05 (Bangkok); the manual invoice 10:00, its slip 10:05
update public.shop_orders set created_at = timestamptz '2026-11-18 14:00:00+07' where invoice_id = pg_temp.c('i3id')::uuid;
update public.finance_invoices set created_at = timestamptz '2026-11-18 14:00:00+07' where id = pg_temp.c('i3id')::uuid;
update public.finance_payment_evidence set created_at = timestamptz '2026-11-18 14:05:00+07' where id = pg_temp.c('ev3')::uuid;
update public.finance_invoices set created_at = timestamptz '2026-11-18 10:00:00+07' where id = pg_temp.c('i4id')::uuid;
update public.finance_payment_evidence set created_at = timestamptz '2026-11-18 10:05:00+07' where id = pg_temp.c('ev4')::uuid;
insert into t_ctx select 'T3', total::text from public.shop_orders where invoice_id = pg_temp.c('i3id')::uuid;
insert into t_res (test, ok, detail) select 'S2 setup: the orders, invoices and slips of this section exist', (select count(*) from t_ctx where k in ('ev2', 'ev3', 'ev4', 'ev5', 'ev6', 'ev7', 'i3id', 'i4id', 'i5id', 'T3') and v is not null) = 10, null;

select pg_temp.q('S2 queue: with the AI review on a new slip queues attempt 1, waiting, with no result and nobody as the requester',
  format($$select count(*) = 1 and bool_and(attempt = 1 and status = 'queued' and requested_by is null and result is null and extracted is null and finished_at is null) from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('ev3')));
select pg_temp.q('S2 queue: each further slip is queued on its own (ev5, ev6, ev4, ev7)',
  format($$select count(*) = 4 and bool_and(attempt = 1 and status = 'queued') from public.finance_slip_analysis where evidence_id in (%L, %L, %L, %L)$$, pg_temp.c('ev5'), pg_temp.c('ev6'), pg_temp.c('ev4'), pg_temp.c('ev7')));
select pg_temp.q('S2 queue: the slip made while the AI review was off is not queued retroactively', format($$select count(*) = 0 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('ev2')));
select pg_temp.q('S2 queue: queueing changes nothing on the slip (still submitted, no review stamp)',
  format($$select status = 'submitted' and reviewed_by is null and confirmed_by is null and posted_at is null from public.finance_payment_evidence where id = %L$$, pg_temp.c('ev3')));
select pg_temp.keep('evCash', format($q$with ins as (insert into public.finance_payment_evidence (invoice_id, customer_id, claimed_amount, status, source, method, recorded_by)
  values (%L, %L, 50, 'confirmed', 'staff_entry', 'cash', %L) returning id) select id::text from ins$q$, pg_temp.c('i3id'), pg_temp.c('cust'), pg_temp.c('S')));
select pg_temp.q('S2 queue: a staff-recorded payment without a file queues nothing', format($$select count(*) = 0 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('evCash')));
select pg_temp.keep('evDirect', format($q$with ins as (insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount)
  values (%L, %L, 'S2/direct', %L, 'image/png', 10) returning id) select id::text from ins$q$, pg_temp.c('i3id'), pg_temp.c('cust'), md5('s2-direct') || md5('s2b-direct')));
select pg_temp.q('S2 queue: any way of adding a slip with a file queues it (a row inserted directly)', format($$select count(*) = 1 and bool_and(attempt = 1 and status = 'queued') from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('evDirect')));
select pg_temp.runs_ok('S2 queue: switched off again', $q$update public.finance_settings set ai_review_enabled = false$q$);
select pg_temp.mkev('evOff', 'i3id');
select pg_temp.q('S2 queue: switched off, a new slip queues nothing again', format($$select count(*) = 0 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('evOff')));
select pg_temp.runs_ok('S2 queue: switched on again', $q$update public.finance_settings set ai_review_enabled = true$q$);

-- ---- S2b finance_can_as: the same ladder as finance_can, for an explicit user
select pg_temp.q('S2 can_as: a verifier may view, invoice and verify, but not manage', $$select pg_temp.ca('C', 'view') and pg_temp.ca('C', 'invoice') and pg_temp.ca('C', 'verify') and not pg_temp.ca('C', 'manage')$$);
select pg_temp.q('S2 can_as: a manager (SUPER_ADMIN) may do everything', $$select pg_temp.ca('S', 'view') and pg_temp.ca('S', 'invoice') and pg_temp.ca('S', 'verify') and pg_temp.ca('S', 'manage')$$);
select pg_temp.q('S2 can_as: customers A and B, who are not staff, may do nothing',
  $$select not (pg_temp.ca('A', 'view') or pg_temp.ca('A', 'invoice') or pg_temp.ca('A', 'verify') or pg_temp.ca('A', 'manage') or pg_temp.ca('B', 'view') or pg_temp.ca('B', 'manage'))$$);
select pg_temp.q('S2 can_as: no user, an unknown user and an unknown capability all mean no',
  $$select public.finance_can_as(null, 'view') is false and public.finance_can_as(gen_random_uuid(), 'view') is false and not pg_temp.ca('S', 'anything')$$);
do $$ declare u text; cap text; bad text := '';
begin
  foreach u in array array['A', 'B', 'C', 'S'] loop
    foreach cap in array array['view', 'invoice', 'verify', 'manage', 'bogus'] loop
      perform pg_temp.as_user(pg_temp.c(u)::uuid);
      if public.finance_can(cap) is distinct from public.finance_can_as(pg_temp.c(u)::uuid, cap) then bad := bad || u || ':' || cap || ' '; end if;
    end loop;
  end loop;
  perform pg_temp.chk('S2 can_as: gives the same answer as finance_can for a manager, a verifier and two customers, for every capability', bad = '', nullif(bad, ''));
exception when others then perform pg_temp.chk('S2 can_as: gives the same answer as finance_can for a manager, a verifier and two customers, for every capability', false, sqlerrm);
end $$;
select pg_temp.runs_ok('S2 can_as: the verifier''s profile is disabled (inside this run)', format($q$update public.profiles set status = 'disabled' where id = %L$q$, pg_temp.c('C')));
select pg_temp.q('S2 can_as: a disabled profile has no capability, like finance_role', $$select not pg_temp.ca('C', 'view') and not pg_temp.ca('C', 'verify')$$);
select pg_temp.runs_ok('S2 can_as: the profile is active again', format($q$update public.profiles set status = 'active' where id = %L$q$, pg_temp.c('C')));
select pg_temp.q('S2 can_as: ...and the verifier can verify again', $$select pg_temp.ca('C', 'verify')$$);

-- ---- S2c the classifier. Fixtures first: the reader's answer for a perfect slip of invoice i3, the hints of the real receiving accounts, refs already seen elsewhere
insert into t_ctx select 'scb_no', account_no from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'bbl_no', account_no from public.finance_bank_accounts where code = 'BBL';
insert into t_ctx select 'hint_scb', 'xxx-x-x' || substr(account_no, 5, 3) || '-' || substr(account_no, 8, 1) || 'x' from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'hint_bbl', 'xxx-x-x' || substr(account_no, 5, 3) || '-' || substr(account_no, 8, 1) || 'x' from public.finance_bank_accounts where code = 'BBL';
insert into t_ctx select 'hint_sub', substr(account_no, 1, 1) || 'x' || substr(account_no, 3, 1) || 'xxx' || substr(account_no, 7, 1) || 'xx' || substr(account_no, 10, 1) from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'hint_rev', substr(account_no, 10, 1) || 'x' || substr(account_no, 7, 1) || 'x' || substr(account_no, 3, 1) || 'x' || substr(account_no, 1, 1) from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'nm_title', 'นาย ' || split_part(account_name, ' ', 1) || ' ' || left(split_part(account_name, ' ', 2), 1) || '.' from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'nm_attached', 'นาย' || split_part(account_name, ' ', 1) || ' ' || left(split_part(account_name, ' ', 2), 1) from public.finance_bank_accounts where code = 'SCB';
insert into t_ctx select 'nm_plain', split_part(account_name, ' ', 1) || ' ' || left(split_part(account_name, ' ', 2), 1) from public.finance_bank_accounts where code = 'SCB';
-- four visible digits that are an ordered subsequence of none of our accounts (the active bank accounts and the test payment account's phone number)
insert into t_ctx select 'hint_none', 'xxx-x-x' || substr(d, 1, 2) || '-' || substr(d, 3, 2) || 'x' from (
  select n::text as d from generate_series(1000, 9999) n
   where not exists (select 1 from (select account_no as a from public.finance_bank_accounts where active union all select '0891234567') z where z.a ~ regexp_replace(n::text, '(.)', '\1[0-9]*', 'g')) limit 1) w;
insert into t_ctx select 'base', jsonb_build_object('amount', pg_temp.t3(), 'transfer_at', '2026-11-18T14:03:00+07:00', 'time_known', true, 'is_slip', true, 'bank', 'SCB',
  'sender', jsonb_build_object('name', 'นาย สมชาย ใ', 'bank', 'KBANK', 'account_hint', 'xxx-x-x123-4x'),
  'receiver', jsonb_build_object('name', pg_temp.c('nm_title'), 'bank', 'SCB', 'account_hint', pg_temp.c('hint_scb')),
  'trans_ref', 'S2REF000000A1', 'trans_id', null, 'status_text', 'โอนเงินสำเร็จ',
  'field_confidence', jsonb_build_object('amount', 0.95, 'date', 0.95, 'time', 0.95, 'receiver', 0.95, 'ref', 0.95))::text;
insert into t_res (test, ok, detail) select 'S2 setup: the hints and the base slip were built from the real accounts', (select count(*) from t_ctx where k in ('scb_no', 'bbl_no', 'hint_scb', 'hint_bbl', 'hint_sub', 'hint_rev', 'nm_title', 'nm_attached', 'nm_plain', 'hint_none', 'base') and v is not null) = 11, (select v from t_ctx where k = 'hint_none');
-- refs seen elsewhere: a posted receipt, a slip with a printed ref, a slip with a confirmed ref, a wallet deposit
select pg_temp.mkev('evR', 'i3id');
select pg_temp.mkev('evE1', 'i3id', 'S2-DUP-EV-0001');
select pg_temp.mkev('evE2', 'i3id', null, 'S2DUPCF0001');
select pg_temp.mkev('evS', 'i3id', 'S2SELFREF0001');
select pg_temp.runs_ok('S2 setup: a receipt carries a bank reference', format($q$insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at)
  values ('RC-S2-DUP1', %L, %L, %L, 10, 'S2DUPREC0001', now())$q$, pg_temp.c('cust'), pg_temp.c('i3id'), pg_temp.c('evR')));
select pg_temp.runs_ok('S2 setup: a slip has a receipt of its own with a reference', format($q$insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at)
  values ('RC-S2-SELF', %L, %L, %L, 10, 'S2SELFREF0002', now())$q$, pg_temp.c('cust'), pg_temp.c('i3id'), pg_temp.c('evS')));
select pg_temp.runs_ok('S2 setup: a wallet deposit carries a bank reference', format($q$insert into public.finance_wallet_deposits (deposit_no, customer_id, bank_account_id, amount, idempotency_key, status, bank_trans_ref)
  values ('DEP-S2-0001', %L, %L, 10, 's2-deposit-key-1', 'pending', 'S2DUPWD0001')$q$, pg_temp.c('cust'), pg_temp.c('scb')));
update public.finance_payment_evidence set created_at = timestamptz '2026-11-18 14:05:00+07' where id = pg_temp.c('evS')::uuid;

-- match
select pg_temp.cl('S2 classify: a perfect slip is a match, with no reason at all', pg_temp.ex(), 'match', p_n => 0);
select pg_temp.cl('S2 classify: a slip without a QR code still matches', pg_temp.ex(), 'match', p_qr => '{"found": false, "crc_ok": null, "sending_bank": null, "trans_ref": null}', p_n => 0);
select pg_temp.cl('S2 classify: a low-severity signal alone changes nothing', pg_temp.ex(), 'match', p_sig => '[{"code": "blurry", "severity": "low", "detail": "slightly blurry"}]', p_n => 0);
select pg_temp.cl('S2 classify: a slip that prints no reference at all is judged on the other rules', pg_temp.ex('{"trans_ref": null}'), 'match', p_qr => '{"found": false}', p_n => 0);
-- amount: exact to the satang
select pg_temp.cl('S2 classify: 1 satang under the expected amount is an amount mismatch (AMOUNT_UNDER)', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() - 0.01)), 'amount_mismatch', array['AMOUNT_UNDER'], array['AMOUNT_OVER']);
select pg_temp.cl('S2 classify: 1 satang over the expected amount is an amount mismatch (AMOUNT_OVER)', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() + 0.01)), 'amount_mismatch', array['AMOUNT_OVER'], array['AMOUNT_UNDER']);
select pg_temp.cl('S2 classify: far under is AMOUNT_UNDER', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() / 2)), 'amount_mismatch', array['AMOUNT_UNDER']);
select pg_temp.cl('S2 classify: far over is AMOUNT_OVER', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() * 2)), 'amount_mismatch', array['AMOUNT_OVER']);
select pg_temp.cl('S2 classify: extra trailing zeros are the same amount (99.00 = 99.00000)', pg_temp.ex(jsonb_build_object('amount', (pg_temp.t3()::text || '000')::numeric)), 'match', p_n => 0);
select pg_temp.cl('S2 classify: a missing amount needs a person (AMOUNT_MISSING)', pg_temp.ex('{"amount": null}'), 'manual_review', array['AMOUNT_MISSING'], array['AMOUNT_UNDER', 'AMOUNT_OVER']);
select pg_temp.cl('S2 classify: an amount of zero is a missing amount', pg_temp.ex('{"amount": 0}'), 'manual_review', array['AMOUNT_MISSING']);
select pg_temp.cl('S2 classify: an amount that is not a number is a missing amount', pg_temp.ex('{"amount": "one hundred"}'), 'manual_review', array['AMOUNT_MISSING']);
select pg_temp.keep('clsA', format($q$select public.finance_classify_slip(%L, %L::jsonb, %L::jsonb, 0.95, '[]'::jsonb)::text$q$, pg_temp.c('ev3'), pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() - 0.01))::text, pg_temp.qrok()::text));
select pg_temp.q('S2 classify: an amount reason says what was expected and what was found (and carries the six fields)',
  $$select count(*) = 1 and bool_and(r ->> 'code' = 'AMOUNT_UNDER' and r ->> 'severity' = 'high' and r ->> 'field' = 'amount' and (r ->> 'expected')::numeric = pg_temp.t3()
         and (r ->> 'found')::numeric = pg_temp.t3() - 0.01 and r ?& array['code', 'severity', 'field', 'expected', 'found', 'message'] and length(r ->> 'message') > 5)
    from t_ctx, jsonb_array_elements((v::jsonb) -> 'reasons') r where k = 'clsA'$$);
-- date and time: window = [order - 120 min, slip uploaded + 10 min] = 12:00 to 14:15 on 18 Nov, Bangkok
select pg_temp.cl('S2 classify: a transfer 3 days before the order is a date mismatch', pg_temp.ex('{"transfer_at": "2026-11-15T14:00:00+07:00"}'), 'date_mismatch', array['DATE_OUT_OF_RANGE'], array['TIME_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: a transfer the day after the slip was uploaded is a date mismatch', pg_temp.ex('{"transfer_at": "2026-11-19T10:00:00+07:00"}'), 'date_mismatch', array['DATE_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: a transfer 3 hours before the order (same day, window 120) is a time anomaly', pg_temp.ex('{"transfer_at": "2026-11-18T11:00:00+07:00"}'), 'time_anomaly', array['TIME_OUT_OF_RANGE'], array['DATE_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: a transfer 30 minutes after the slip was uploaded is a time anomaly', pg_temp.ex('{"transfer_at": "2026-11-18T14:35:00+07:00"}'), 'time_anomaly', array['TIME_OUT_OF_RANGE'], array['DATE_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: exactly at the start of the window passes', pg_temp.ex('{"transfer_at": "2026-11-18T12:00:00+07:00"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: exactly at the end of the window passes', pg_temp.ex('{"transfer_at": "2026-11-18T14:15:00+07:00"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: a minute before the window is a time anomaly', pg_temp.ex('{"transfer_at": "2026-11-18T11:59:00+07:00"}'), 'time_anomaly', array['TIME_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: a minute after the window is a time anomaly', pg_temp.ex('{"transfer_at": "2026-11-18T14:16:00+07:00"}'), 'time_anomaly', array['TIME_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: the calendar day is the Bangkok day, not the UTC day (00:30 Bangkok = 17:30Z the day before: still a time anomaly)',
  pg_temp.ex('{"transfer_at": "2026-11-17T17:30:00Z"}'), 'time_anomaly', array['TIME_OUT_OF_RANGE'], array['DATE_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: a time without an offset is read as Bangkok time', pg_temp.ex('{"transfer_at": "2026-11-18T14:03:00"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: the same instant written in UTC matches too', pg_temp.ex('{"transfer_at": "2026-11-18T07:03:00Z"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: a slip whose time is unknown (date in range) is a time anomaly (TIME_MISSING)', pg_temp.ex('{"time_known": false}'), 'time_anomaly', array['TIME_MISSING'], array['DATE_OUT_OF_RANGE', 'TIME_OUT_OF_RANGE']);
select pg_temp.cl('S2 classify: an unknown time with the date out of range is a date mismatch first', pg_temp.ex('{"time_known": false, "transfer_at": "2026-11-15T00:00:00+07:00"}'), 'date_mismatch', array['DATE_OUT_OF_RANGE'], array['TIME_MISSING']);
select pg_temp.cl('S2 classify: a missing date needs a person (DATE_MISSING)', pg_temp.ex('{"transfer_at": null}'), 'manual_review', array['DATE_MISSING']);
select pg_temp.cl('S2 classify: a date that cannot be read needs a person too', pg_temp.ex('{"transfer_at": "yesterday evening"}'), 'manual_review', array['DATE_MISSING']);
select pg_temp.runs_ok('S2 classify: the window can be widened (settings)', $q$update public.finance_settings set slip_window_before_min = 240, slip_future_tolerance_min = 60$q$);
select pg_temp.cl('S2 classify: with a window of 240 minutes, 3 hours before the order is fine', pg_temp.ex('{"transfer_at": "2026-11-18T11:00:00+07:00"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: with a tolerance of 60 minutes, 30 minutes after the upload is fine', pg_temp.ex('{"transfer_at": "2026-11-18T14:35:00+07:00"}'), 'match', p_n => 0);
select pg_temp.runs_ok('S2 classify: the window is back to 120 and 10 minutes', $q$update public.finance_settings set slip_window_before_min = 120, slip_future_tolerance_min = 10$q$);
-- expected snapshot
select pg_temp.keep('cls1', format($q$select public.finance_classify_slip(%L, %L::jsonb, %L::jsonb, 0.95, '[]'::jsonb)::text$q$, pg_temp.c('ev3'), pg_temp.ex()::text, pg_temp.qrok()::text));
select pg_temp.q('S2 classify: the snapshot holds the amount the invoice asks for', $$select ((v::jsonb) -> 'expected' ->> 'amount')::numeric = pg_temp.t3() from t_ctx where k = 'cls1'$$);
select pg_temp.q('S2 classify: the snapshot holds the order time and the window (order - 120 min, upload + 10 min)',
  $$select ((v::jsonb) -> 'expected' ->> 'order_created_at')::timestamptz = timestamptz '2026-11-18 14:00:00+07'
        and ((v::jsonb) -> 'expected' ->> 'window_from')::timestamptz = timestamptz '2026-11-18 12:00:00+07'
        and ((v::jsonb) -> 'expected' ->> 'window_to')::timestamptz = timestamptz '2026-11-18 14:15:00+07' from t_ctx where k = 'cls1'$$);
select pg_temp.q('S2 classify: the snapshot lists the receivers (the bank accounts and the default payment account) by label, bank and name',
  $$select exists (select 1 from t_ctx, jsonb_array_elements((v::jsonb) -> 'expected' -> 'receivers') r where k = 'cls1' and r ->> 'label' = 'SCB' and r ->> 'bank' is not null and r ->> 'name' is not null)
        and exists (select 1 from t_ctx, jsonb_array_elements((v::jsonb) -> 'expected' -> 'receivers') r where k = 'cls1' and r ->> 'label' = 'BBL')
        and exists (select 1 from t_ctx, jsonb_array_elements((v::jsonb) -> 'expected' -> 'receivers') r where k = 'cls1' and r ->> 'label' = 'S2 PromptPay' and r ->> 'name' = 'Tomcraft Test Shop')$$);
select pg_temp.q('S2 classify: the snapshot never carries a full account number (masked digits only)',
  $$select position(pg_temp.c('scb_no') in v) = 0 and position(pg_temp.c('bbl_no') in v) = 0 and position('0891234567' in v) = 0 and position('0066891234567' in v) = 0
        and exists (select 1 from jsonb_array_elements((v::jsonb) -> 'expected' -> 'receivers') r where r ->> 'label' = 'SCB' and r ->> 'account_no_masked_digits' = 'xxxxxx' || right(pg_temp.c('scb_no'), 4))
     from t_ctx where k = 'cls1'$$);
select pg_temp.q('S2 classify: the real default payment account that was set aside is not a receiver while the test account is the default',
  $$select (select v from t_ctx where k = 'cls1') is not null and not exists (select 1 from t_ctx x, public.finance_payment_accounts a, jsonb_array_elements((select v::jsonb from t_ctx where k = 'cls1') -> 'expected' -> 'receivers') r
                        where x.k = 'pa_prev' and a.id = x.v::uuid and r ->> 'label' = a.label)$$);
-- expected amount of a manual invoice (no shop order): the invoice's own time, the invoice amount minus the posted allocations, or the payment request
select pg_temp.keep('cls4a', format($q$select public.finance_classify_slip(%L, %L::jsonb, '{"found": false}'::jsonb, 0.95, '[]'::jsonb)::text$q$, pg_temp.c('ev4'), pg_temp.ex()::text));
select pg_temp.q('S2 classify: a manual invoice expects its full amount and counts from the invoice time',
  $$select ((v::jsonb) -> 'expected' ->> 'amount')::numeric = 500 and ((v::jsonb) -> 'expected' ->> 'order_created_at')::timestamptz = timestamptz '2026-11-18 10:00:00+07'
        and ((v::jsonb) -> 'expected' ->> 'window_from')::timestamptz = timestamptz '2026-11-18 08:00:00+07' from t_ctx where k = 'cls4a'$$);
select pg_temp.mkev('evA1', 'i4id');
select pg_temp.mkev('evA2', 'i4id');
select pg_temp.mkev('evA3', 'i4id');
select pg_temp.runs_ok('S2 expected: a posted receipt of 200 is allocated to the invoice', format($q$with r as (insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, received_at, status)
  values ('RC-S2-P1', %L, %L, %L, 200, now(), 'posted') returning id) insert into public.finance_allocations (receipt_id, invoice_id, amount, active) select id, %L::uuid, 200, true from r$q$,
  pg_temp.c('cust'), pg_temp.c('i4id'), pg_temp.c('evA1'), pg_temp.c('i4id')));
select pg_temp.runs_ok('S2 expected: a reversed receipt of 100 (allocation switched off) is recorded too', format($q$with r as (insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, received_at, status)
  values ('RC-S2-P2', %L, %L, %L, 100, now(), 'reversed') returning id) insert into public.finance_allocations (receipt_id, invoice_id, amount, active) select id, %L::uuid, 100, false from r$q$,
  pg_temp.c('cust'), pg_temp.c('i4id'), pg_temp.c('evA2'), pg_temp.c('i4id')));
select pg_temp.runs_ok('S2 expected: a reversed receipt of 50 whose allocation was left active by mistake is recorded too', format($q$with r as (insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, received_at, status)
  values ('RC-S2-P3', %L, %L, %L, 50, now(), 'reversed') returning id) insert into public.finance_allocations (receipt_id, invoice_id, amount, active) select id, %L::uuid, 50, true from r$q$,
  pg_temp.c('cust'), pg_temp.c('i4id'), pg_temp.c('evA3'), pg_temp.c('i4id')));
select pg_temp.cl('S2 expected: without a payment request the expected amount is what is still outstanding (500 - 200 = 300; only posted receipts count, whatever their allocations say)',
  pg_temp.ex('{"amount": 300, "transfer_at": "2026-11-18T10:03:00+07:00"}'), 'match', p_qr => '{"found": false}', p_ev => 'ev4', p_n => 0);
select pg_temp.cl('S2 expected: the full invoice amount is now too much', pg_temp.ex('{"amount": 500, "transfer_at": "2026-11-18T10:03:00+07:00"}'), 'amount_mismatch', array['AMOUNT_OVER'], p_qr => '{"found": false}', p_ev => 'ev4');
select pg_temp.runs_ok('S2 expected: the slip is tied to a payment request for 250', format($q$with pr as (insert into public.finance_payment_requests (ref, invoice_id, customer_id, account_id, amount, qr_payload, expires_at)
  values ('PRS2TEST0001', %L, %L, %L, 250, 'S2-not-a-real-qr', now() + interval '1 day') returning id) update public.finance_payment_evidence set request_id = (select id from pr) where id = %L$q$,
  pg_temp.c('i4id'), pg_temp.c('cust'), pg_temp.c('pa_s2'), pg_temp.c('ev4')));
select pg_temp.cl('S2 expected: with a payment request the expected amount is the request amount (250)', pg_temp.ex('{"amount": 250, "transfer_at": "2026-11-18T10:03:00+07:00"}'), 'match', p_qr => '{"found": false}', p_ev => 'ev4', p_n => 0);
select pg_temp.cl('S2 expected: the outstanding amount no longer matches once the request says 250', pg_temp.ex('{"amount": 300, "transfer_at": "2026-11-18T10:03:00+07:00"}'), 'amount_mismatch', array['AMOUNT_OVER'], p_qr => '{"found": false}', p_ev => 'ev4');
-- duplicates (the normalised reference: upper-case letters and digits only)
select pg_temp.cl('S2 classify: a reference already on a receipt is a suspected duplicate', pg_temp.exr('S2DUPREC0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['QR_REF_MISMATCH'], p_qr => pg_temp.qrr('S2DUPREC0001'));
select pg_temp.cl('S2 classify: a reference already printed on another slip is a suspected duplicate (written in another case and without dashes)', pg_temp.exr('s2dupev0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('s2dupev0001'));
select pg_temp.cl('S2 classify: a reference already confirmed on another slip is a suspected duplicate', pg_temp.exr('S2DUPCF0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2DUPCF0001'));
select pg_temp.cl('S2 classify: a reference already on a wallet deposit is a suspected duplicate', pg_temp.exr('S2DUPWD0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2DUPWD0001'));
select pg_temp.cl('S2 classify: a reference written with spaces and dots is still recognised (s2 dup.rec 0001)', pg_temp.exr('s2 dup.rec 0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2DUPREC0001'));
select pg_temp.cl('S2 classify: the QR alone can reveal the duplicate (nothing printed, QR reference on a receipt)', pg_temp.exr(null), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2DUPREC0001'));
select pg_temp.cl('S2 classify: the QR alone can reveal it on a wallet deposit too', pg_temp.exr(null), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2DUPWD0001'));
select pg_temp.cl('S2 classify: the printed reference alone, with a QR holding another fresh reference, is a duplicate AND a QR mismatch', pg_temp.exr('S2DUPREC0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE', 'QR_REF_MISMATCH'], p_qr => pg_temp.qrr('S2REF000000B2'));
select pg_temp.cl('S2 classify: the slip under test is not a duplicate of its own printed reference or its own receipt', pg_temp.exr('S2SELFREF0001'), 'match', p_qr => pg_temp.qrr('S2SELFREF0001'), p_ev => 'evS', p_n => 0);
select pg_temp.cl('S2 classify: ...nor of the receipt made from it', pg_temp.exr('S2SELFREF0002'), 'match', p_qr => pg_temp.qrr('S2SELFREF0002'), p_ev => 'evS', p_n => 0);
select pg_temp.cl('S2 classify: but another slip with that reference is a duplicate of it', pg_temp.exr('S2SELFREF0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2SELFREF0001'));
select pg_temp.cl('S2 classify: a reference of fewer than 4 characters is treated as absent (no duplicate scan, no QR comparison)', pg_temp.exr('ab1'), 'match', p_qr => pg_temp.qrr('XYZ99999'), p_n => 0);
-- a customer who was sent back (rejected / more evidence requested) and resends the same transfer is not a suspected duplicate of their OWN earlier slip on the
-- SAME invoice: an info reason (RESUBMITTED_TRANSFER) and the other rules decide. Anything else stays a duplicate: another invoice, another customer, a receipt,
-- a wallet deposit, an earlier slip that is still live (submitted, confirmed, posted), or an earlier slip that already has a receipt.
insert into public.finance_customers (code, name) values ('S2-OTHER', 'S2 other customer');
insert into t_ctx select 'cust2', id::text from public.finance_customers where code = 'S2-OTHER';
select pg_temp.mkev('evRs1', 'i3id', 'S2RESUB0001');
select pg_temp.mkev('evRs2', 'i3id', null, 'S2RESUB0002');
select pg_temp.mkev('evRs3', 'i3id');
select pg_temp.mkev('evRs4', 'i3id');
select pg_temp.mkev('evHd1', 'i4id', 'S2RESUB0005');
select pg_temp.mkev('evHd2', 'i3id', 'S2RESUB0006', null, 'cust2');
select pg_temp.mkev('evHd3', 'i3id', null, 'S2RESUB0007');
select pg_temp.mkev('evHd4', 'i3id');
select pg_temp.mkev('evHd5', 'i4id');
select pg_temp.mkev('evLv', 'i3id', 'S2RESUB0011');
select pg_temp.runs_ok('S2 setup: seven earlier slips are rejected', format($q$update public.finance_payment_evidence set status = 'rejected' where id in (%L, %L, %L, %L, %L, %L, %L)$q$,
  pg_temp.c('evRs1'), pg_temp.c('evRs3'), pg_temp.c('evHd1'), pg_temp.c('evHd2'), pg_temp.c('evHd3'), pg_temp.c('evHd4'), pg_temp.c('evHd5')));
select pg_temp.runs_ok('S2 setup: two earlier slips were sent back for more evidence', format($q$update public.finance_payment_evidence set status = 'more_evidence' where id in (%L, %L)$q$, pg_temp.c('evRs2'), pg_temp.c('evRs4')));
select pg_temp.runs_ok('S2 setup: three earlier slips carry a finished analysis with a reference (printed / QR only / printed)',
  format($q$update public.finance_slip_analysis a set status = 'done', result = 'match', finished_at = now(), extracted = v.ex, qr = v.qr
    from (values (%L::uuid, '{"trans_ref": "S2RESUB0003"}'::jsonb, '{"found": false}'::jsonb),
                 (%L::uuid, '{"trans_ref": null}'::jsonb, '{"found": true, "trans_ref": "S2RESUB0004"}'::jsonb),
                 (%L::uuid, '{"trans_ref": "S2RESUB0010"}'::jsonb, '{"found": false}'::jsonb)) as v(ev, ex, qr)
    where a.evidence_id = v.ev and a.attempt = 1$q$, pg_temp.c('evRs3'), pg_temp.c('evRs4'), pg_temp.c('evHd5')));
select pg_temp.runs_ok('S2 setup: a rejected slip that nevertheless has a receipt (evHd3, no reference on it) and one whose receipt carries a reference (evHd4)',
  format($q$insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at)
    values ('RC-S2-HD3', %L, %L, %L, 10, null, now()), ('RC-S2-HD4', %L, %L, %L, 10, 'S2RESUB0008', now())$q$,
    pg_temp.c('cust'), pg_temp.c('i3id'), pg_temp.c('evHd3'), pg_temp.c('cust'), pg_temp.c('i3id'), pg_temp.c('evHd4')));
select pg_temp.cl('S2 resubmit: the same transfer on a slip of mine that was rejected (same invoice, same customer) is RESUBMITTED_TRANSFER, not a duplicate',
  pg_temp.exr('S2RESUB0001'), 'match', array['RESUBMITTED_TRANSFER'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2RESUB0001'), p_n => 1);
select pg_temp.cl('S2 resubmit: ...also for a slip sent back for more evidence (a confirmed reference on it)', pg_temp.exr('S2RESUB0002'), 'match', array['RESUBMITTED_TRANSFER'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2RESUB0002'), p_n => 1);
select pg_temp.cl('S2 resubmit: ...found through the earlier slip''s analysis (the printed reference)', pg_temp.exr('S2RESUB0003'), 'match', array['RESUBMITTED_TRANSFER'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2RESUB0003'), p_n => 1);
select pg_temp.cl('S2 resubmit: ...found through the earlier analysis''s QR reference alone', pg_temp.exr(null), 'match', array['RESUBMITTED_TRANSFER'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2RESUB0004'), p_n => 1);
select pg_temp.keep('clsRs', format($q$select public.finance_classify_slip(%L, %L::jsonb, %L::jsonb, 0.95, '[]'::jsonb)::text$q$, pg_temp.c('ev3'), pg_temp.exr('S2RESUB0001')::text, pg_temp.qrr('S2RESUB0001')::text));
select pg_temp.q('S2 resubmit: the reason is info, names the transfer reference field and carries the earlier slip''s id',
  $$select count(*) = 1 and bool_and(r ->> 'code' = 'RESUBMITTED_TRANSFER' and r ->> 'severity' = 'info' and r ->> 'field' = 'trans_ref' and r ->> 'found' = pg_temp.c('evRs1') and length(r ->> 'message') > 5
         and r ?& array['code', 'severity', 'field', 'expected', 'found', 'message']) from t_ctx, jsonb_array_elements((v::jsonb) -> 'reasons') r where k = 'clsRs'$$);
select pg_temp.cl('S2 resubmit: the other rules still decide (an amount mismatch on the resent slip)', pg_temp.exr('S2RESUB0001') || jsonb_build_object('amount', pg_temp.t3() + 5), 'amount_mismatch',
  array['RESUBMITTED_TRANSFER', 'AMOUNT_OVER'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2RESUB0001'));
select pg_temp.cl('S2 resubmit: an earlier rejected slip on ANOTHER invoice (same customer) is a duplicate', pg_temp.exr('S2RESUB0005'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0005'));
select pg_temp.cl('S2 resubmit: an earlier rejected slip of ANOTHER customer (same invoice) is a duplicate', pg_temp.exr('S2RESUB0006'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0006'));
select pg_temp.cl('S2 resubmit: an earlier rejected slip that has a receipt is a duplicate', pg_temp.exr('S2RESUB0007'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0007'));
select pg_temp.cl('S2 resubmit: a reference on a RECEIPT is always a duplicate, even when it belongs to a rejected slip of mine', pg_temp.exr('S2RESUB0008'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0008'));
select pg_temp.cl('S2 resubmit: an earlier rejected slip on another invoice, found through its analysis, is a duplicate', pg_temp.exr('S2RESUB0010'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0010'));
select pg_temp.cl('S2 resubmit: a wallet deposit with the reference makes it a duplicate even when an earlier rejected slip of mine has it too',
  pg_temp.exr('S2RESUB0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE', 'RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2DUPWD0001'));
select pg_temp.cl('S2 resubmit: ...and so does a receipt', pg_temp.exr('S2RESUB0001'), 'duplicate_suspected', array['DUPLICATE_REFERENCE', 'RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2DUPREC0001'));
-- the status of the earlier slip on the same invoice decides: live = duplicate, sent back = resubmitted
select pg_temp.cl('S2 resubmit: an earlier slip that is still submitted is a duplicate', pg_temp.exr('S2RESUB0011'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0011'));
select pg_temp.runs_ok('S2 setup: the earlier slip is confirmed', format($q$update public.finance_payment_evidence set status = 'confirmed' where id = %L$q$, pg_temp.c('evLv')));
select pg_temp.cl('S2 resubmit: ...confirmed is still a duplicate', pg_temp.exr('S2RESUB0011'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0011'));
select pg_temp.runs_ok('S2 setup: the earlier slip is posted (verified)', format($q$update public.finance_payment_evidence set status = 'verified' where id = %L$q$, pg_temp.c('evLv')));
select pg_temp.cl('S2 resubmit: ...posted is still a duplicate', pg_temp.exr('S2RESUB0011'), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], array['RESUBMITTED_TRANSFER'], p_qr => pg_temp.qrr('S2RESUB0011'));
select pg_temp.runs_ok('S2 setup: the earlier slip is sent back for more evidence', format($q$update public.finance_payment_evidence set status = 'more_evidence' where id = %L$q$, pg_temp.c('evLv')));
select pg_temp.cl('S2 resubmit: ...sent back is a resubmission', pg_temp.exr('S2RESUB0011'), 'match', array['RESUBMITTED_TRANSFER'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2RESUB0011'), p_n => 1);
select pg_temp.runs_ok('S2 setup: the earlier slip is rejected', format($q$update public.finance_payment_evidence set status = 'rejected' where id = %L$q$, pg_temp.c('evLv')));
select pg_temp.cl('S2 resubmit: ...rejected is a resubmission', pg_temp.exr('S2RESUB0011'), 'match', array['RESUBMITTED_TRANSFER'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2RESUB0011'), p_n => 1);
-- suspicious: QR, tamper, status
select pg_temp.cl('S2 classify: a QR reference different from the printed one is suspicious (QR_REF_MISMATCH)', pg_temp.ex(), 'suspicious_slip', array['QR_REF_MISMATCH'], array['DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2REF000000B2'));
select pg_temp.cl('S2 classify: a QR reference that differs only in case and dashes is the same reference', pg_temp.ex(), 'match', p_qr => pg_temp.qrr('s2-ref-000000-a1'), p_n => 0);
select pg_temp.cl('S2 classify: a QR with a bad checksum is suspicious (QR_BAD_CRC)', pg_temp.ex(), 'suspicious_slip', array['QR_BAD_CRC'], array['QR_REF_MISMATCH'], p_qr => pg_temp.qrok('{"crc_ok": false}'));
select pg_temp.cl('S2 classify: a QR whose checksum was not checked (null) is not a problem', pg_temp.ex(), 'match', p_qr => pg_temp.qrok('{"crc_ok": null}'), p_n => 0);
select pg_temp.cl('S2 classify: a high tamper signal is suspicious (TAMPER_SIGNAL)', pg_temp.ex(), 'suspicious_slip', array['TAMPER_SIGNAL'], p_sig => '[{"code": "font_mismatch", "severity": "high", "detail": "the amount uses another font"}]');
select pg_temp.cl('S2 classify: one reason per high signal, none for the low ones', pg_temp.ex(), 'suspicious_slip', array['TAMPER_SIGNAL'], p_n => 2,
  p_sig => '[{"code": "font_mismatch", "severity": "high", "detail": "a"}, {"code": "edited_pixels", "severity": "high", "detail": "b"}, {"code": "blurry", "severity": "low", "detail": "c"}]');
select pg_temp.keep('clsT', format($q$select public.finance_classify_slip(%L, %L::jsonb, %L::jsonb, 0.95, %L::jsonb)::text$q$, pg_temp.c('ev3'), pg_temp.ex()::text, pg_temp.qrok()::text,
  '[{"code": "font_mismatch", "severity": "high", "detail": "the amount uses another font"}]'));
select pg_temp.q('S2 classify: the tamper reason names the signal and carries its detail', $$select count(*) = 1 and bool_and(r ->> 'code' = 'TAMPER_SIGNAL' and r ->> 'severity' = 'high' and r ->> 'found' = 'font_mismatch' and r ->> 'message' like '%another font%')
  from t_ctx, jsonb_array_elements((v::jsonb) -> 'reasons') r where k = 'clsT'$$);
select pg_temp.cl('S2 classify: a status text that says the transfer failed is suspicious (ไม่สำเร็จ)', pg_temp.ex('{"status_text": "ไม่สำเร็จ"}'), 'suspicious_slip', array['STATUS_NOT_SUCCESS']);
select pg_temp.cl('S2 classify: ...whatever the words around it (รายการล้มเหลว)', pg_temp.ex('{"status_text": "รายการล้มเหลว"}'), 'suspicious_slip', array['STATUS_NOT_SUCCESS']);
select pg_temp.cl('S2 classify: ...an English failure (Transaction FAILED)', pg_temp.ex('{"status_text": "Transaction FAILED"}'), 'suspicious_slip', array['STATUS_NOT_SUCCESS']);
select pg_temp.cl('S2 classify: ...a pending transfer (Pending)', pg_temp.ex('{"status_text": "Pending"}'), 'suspicious_slip', array['STATUS_NOT_SUCCESS']);
select pg_temp.cl('S2 classify: ...a cancelled one (ยกเลิก)', pg_temp.ex('{"status_text": "ยกเลิกรายการ"}'), 'suspicious_slip', array['STATUS_NOT_SUCCESS']);
select pg_temp.cl('S2 classify: ...an unsuccessful one', pg_temp.ex('{"status_text": "Unsuccessful"}'), 'suspicious_slip', array['STATUS_NOT_SUCCESS']);
select pg_temp.cl('S2 classify: a Thai success text (โอนเงินสำเร็จ) is NOT a failure', pg_temp.ex('{"status_text": "โอนเงินสำเร็จ"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: another Thai success text (ทำรายการสำเร็จ) passes', pg_temp.ex('{"status_text": "ทำรายการสำเร็จ"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: English success texts pass (Transfer successful)', pg_temp.ex('{"status_text": "Transfer successful"}'), 'match', p_n => 0);
select pg_temp.cl('S2 classify: a slip with no status text passes', pg_temp.ex('{"status_text": null}'), 'match', p_n => 0);
-- receiver: the visible digits are an ordered subsequence (3 or more) of one of our accounts, or the name (titles stripped) is a prefix of the account name
select pg_temp.cl('S2 receiver: digits shown like the SCB account (xxx-x-x402-6x) are ours', pg_temp.rc(pg_temp.hint(null, pg_temp.c('hint_scb'))), 'match', array[]::text[], array['RECEIVER_MISMATCH', 'RECEIVER_UNCLEAR'], p_n => 0);
select pg_temp.cl('S2 receiver: digits shown like the BBL account are ours', pg_temp.rc(pg_temp.hint(null, pg_temp.c('hint_bbl'))), 'match', array[]::text[], array['RECEIVER_MISMATCH'], p_n => 0);
select pg_temp.cl('S2 receiver: the PromptPay phone number (089-xxx-4567) is ours', pg_temp.rc(pg_temp.hint(null, '089-xxx-4567')), 'match', array[]::text[], array['RECEIVER_MISMATCH'], p_n => 0);
select pg_temp.cl('S2 receiver: the digits are an ordered SUBSEQUENCE, not necessarily next to each other', pg_temp.rc(pg_temp.hint(null, pg_temp.c('hint_sub'))), 'match', array[]::text[], array['RECEIVER_MISMATCH'], p_n => 0);
select pg_temp.q('S2 receiver: (precondition) the same digits in the reverse order are a subsequence of none of our accounts',
  $$select not exists (select 1 from (select account_no as a from public.finance_bank_accounts where active union all select '0891234567') z
                        where z.a ~ regexp_replace(regexp_replace(pg_temp.c('hint_rev'), '[^0-9]', '', 'g'), '(.)', '\1[0-9]*', 'g'))$$);
select pg_temp.cl('S2 receiver: ...the order matters (the digits reversed are not ours)', pg_temp.rc(pg_temp.hint(null, pg_temp.c('hint_rev'))), 'suspicious_slip', array['RECEIVER_MISMATCH']);
select pg_temp.cl('S2 receiver: three visible digits are enough (xxx-x-x402-xx)', pg_temp.rc(pg_temp.hint(null, 'xxx-x-x' || substr(pg_temp.c('scb_no'), 5, 3) || '-xx')), 'match', array[]::text[], array['RECEIVER_MISMATCH', 'RECEIVER_UNCLEAR'], p_n => 0);
select pg_temp.cl('S2 receiver: the name with its title and a masked surname is ours', pg_temp.rc(pg_temp.hint(pg_temp.c('nm_title'), null)), 'match', array[]::text[], array['RECEIVER_MISMATCH', 'RECEIVER_UNCLEAR'], p_n => 0);
select pg_temp.cl('S2 receiver: ...with the title written without a space', pg_temp.rc(pg_temp.hint(pg_temp.c('nm_attached'), null)), 'match', p_n => 0);
select pg_temp.cl('S2 receiver: ...without a title', pg_temp.rc(pg_temp.hint(pg_temp.c('nm_plain'), null)), 'match', p_n => 0);
select pg_temp.cl('S2 receiver: ...in other case and with the English title MR. (MR. TOMCRAFT TE for Tomcraft Test Shop)', pg_temp.rc(pg_temp.hint('MR. TOMCRAFT TE', null)), 'match', p_n => 0);
select pg_temp.cl('S2 receiver: ...the whole name too (Miss Tomcraft Test Shop)', pg_temp.rc(pg_temp.hint('Miss Tomcraft Test Shop', null)), 'match', p_n => 0);
select pg_temp.cl('S2 receiver: a different name and no digits is clearly not ours (RECEIVER_MISMATCH)', pg_temp.rc(pg_temp.hint('นาย สมชาย ใจดี', null)), 'suspicious_slip', array['RECEIVER_MISMATCH'], array['RECEIVER_UNCLEAR']);
select pg_temp.cl('S2 receiver: digits of another account and no name is clearly not ours', pg_temp.rc(pg_temp.hint(null, pg_temp.c('hint_none'))), 'suspicious_slip', array['RECEIVER_MISMATCH'], array['RECEIVER_UNCLEAR']);
select pg_temp.cl('S2 receiver: other digits AND another name is not ours either', pg_temp.rc(pg_temp.hint('นาย สมชาย ใจดี', pg_temp.c('hint_none'))), 'suspicious_slip', array['RECEIVER_MISMATCH']);
select pg_temp.cl('S2 receiver: the name matches although the digits do not (either is enough)', pg_temp.rc(pg_temp.hint(pg_temp.c('nm_title'), pg_temp.c('hint_none'))), 'match', array[]::text[], array['RECEIVER_MISMATCH'], p_n => 0);
select pg_temp.cl('S2 receiver: the digits match although the name does not (either is enough)', pg_temp.rc(pg_temp.hint('นาย สมชาย ใจดี', pg_temp.c('hint_scb'))), 'match', array[]::text[], array['RECEIVER_MISMATCH'], p_n => 0);
select pg_temp.cl('S2 receiver: no receiver at all is unclear, and the other rules decide (RECEIVER_UNCLEAR, match)', pg_temp.ex('{"receiver": null}'), 'match', array['RECEIVER_UNCLEAR'], array['RECEIVER_MISMATCH'], p_n => 1);
select pg_temp.cl('S2 receiver: an empty receiver is unclear too', pg_temp.ex('{"receiver": {}}'), 'match', array['RECEIVER_UNCLEAR'], array['RECEIVER_MISMATCH'], p_n => 1);
select pg_temp.cl('S2 receiver: two visible digits are too few to judge (unclear, not a mismatch)', pg_temp.rc(pg_temp.hint(null, 'xxx-x-x40x-xx')), 'match', array['RECEIVER_UNCLEAR'], array['RECEIVER_MISMATCH'], p_n => 1);
select pg_temp.cl('S2 receiver: a name that is only a title is unclear', pg_temp.rc(pg_temp.hint('น.ส.', null)), 'match', array['RECEIVER_UNCLEAR'], array['RECEIVER_MISMATCH'], p_n => 1);
select pg_temp.cl('S2 receiver: a two-character name is too short to judge', pg_temp.rc(pg_temp.hint('ณั', null)), 'match', array['RECEIVER_UNCLEAR'], array['RECEIVER_MISMATCH'], p_n => 1);
select pg_temp.cl('S2 receiver: an unclear receiver does not hide an amount mismatch', pg_temp.ex(jsonb_build_object('receiver', null, 'amount', pg_temp.t3() / 2)), 'amount_mismatch', array['RECEIVER_UNCLEAR', 'AMOUNT_UNDER']);
select pg_temp.runs_ok('S2 receiver: the BBL account is switched off (inside this run)', $q$update public.finance_bank_accounts set active = false where code = 'BBL'$q$);
select pg_temp.cl('S2 receiver: an account that is switched off is not a receiver (the BBL digits are now not ours)', pg_temp.rc(pg_temp.hint(null, pg_temp.c('hint_bbl'))), 'suspicious_slip', array['RECEIVER_MISMATCH']);
select pg_temp.runs_ok('S2 receiver: the BBL account is back on', $q$update public.finance_bank_accounts set active = true where code = 'BBL'$q$);
-- not a slip, unreadable, low confidence
select pg_temp.cl('S2 classify: not a slip needs a person (NOT_A_SLIP) and nothing else is judged', pg_temp.ex('{"is_slip": false}'), 'manual_review', array['NOT_A_SLIP'], p_n => 1);
select pg_temp.cl('S2 classify: an answer that does not say whether it is a slip is unreadable', pg_temp.ex() - 'is_slip', 'manual_review', array['UNREADABLE'], p_n => 1);
select pg_temp.cl('S2 classify: an answer that is not an object is unreadable', '"just text"'::jsonb, 'manual_review', array['UNREADABLE'], p_n => 1);
select pg_temp.q('S2 classify: no answer at all (null) is unreadable, manual review', format($$select public.finance_classify_slip(%L, null, null, null, null) ->> 'result' = 'manual_review'
  and public.finance_classify_slip(%L, null, null, null, null) -> 'reasons' -> 0 ->> 'code' = 'UNREADABLE'$$, pg_temp.c('ev3'), pg_temp.c('ev3')));
select pg_temp.cl('S2 classify: confidence 0.79 with everything else right is manual review (LOW_CONFIDENCE)', pg_temp.ex(), 'manual_review', array['LOW_CONFIDENCE'], p_conf => 0.79);
select pg_temp.cl('S2 classify: confidence exactly at the threshold (0.80) passes', pg_temp.ex(), 'match', p_conf => 0.80, p_n => 0);
select pg_temp.cl('S2 classify: confidence 1 passes', pg_temp.ex(), 'match', p_conf => 1, p_n => 0);
-- (E) the amount is read to the satang: a stray third decimal does not make a mismatch, but a whole satang does
select pg_temp.cl('S2 amount: 0.004 over the expected amount rounds to the same amount (match)', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() + 0.004)), 'match', p_n => 0);
select pg_temp.cl('S2 amount: 0.004 under rounds to the same amount (match)', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() - 0.004)), 'match', p_n => 0);
select pg_temp.cl('S2 amount: 0.006 over rounds to one satang over (AMOUNT_OVER)', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() + 0.006)), 'amount_mismatch', array['AMOUNT_OVER'], array['AMOUNT_UNDER']);
select pg_temp.cl('S2 amount: 0.006 under rounds to one satang under (AMOUNT_UNDER)', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() - 0.006)), 'amount_mismatch', array['AMOUNT_UNDER'], array['AMOUNT_OVER']);
select pg_temp.cl('S2 amount: an amount that rounds to zero (0.004) is a missing amount', pg_temp.ex('{"amount": 0.004}'), 'manual_review', array['AMOUNT_MISSING']);
-- (B) the threshold is applied to the confidence as the reader reported it; only the stored copy is rounded to 3 decimals
select pg_temp.cl('S2 confidence: 0.7995 is below the minimum of 0.80 (not rounded up to it)', pg_temp.ex(), 'manual_review', array['LOW_CONFIDENCE'], p_conf => 0.7995);
select pg_temp.cl('S2 confidence: 0.8004 passes', pg_temp.ex(), 'match', p_conf => 0.8004, p_n => 0);
-- (C) a long visible-digit string cannot break or slow the receiver comparison
select pg_temp.cl('S2 receiver: the full 10-digit account number shown is ours', pg_temp.rc(pg_temp.hint(null, pg_temp.c('scb_no'))), 'match', array[]::text[], array['RECEIVER_MISMATCH'], p_n => 0);
select pg_temp.cl('S2 receiver: one digit more than the account has cannot be a subsequence (not ours)', pg_temp.rc(pg_temp.hint(null, pg_temp.c('scb_no') || '1')), 'suspicious_slip', array['RECEIVER_MISMATCH']);
select pg_temp.cl('S2 receiver: a 200-digit account hint is no error and is not ours', pg_temp.rc(pg_temp.hint(null, repeat('1234567890', 20))), 'suspicious_slip', array['RECEIVER_MISMATCH']);
select pg_temp.cl('S2 receiver: a 30000-digit account hint is no error and is not ours either', pg_temp.rc(pg_temp.hint(null, repeat('7', 30000))), 'suspicious_slip', array['RECEIVER_MISMATCH']);
select pg_temp.cl('S2 receiver: a long digit string does not hide a matching name', pg_temp.rc(pg_temp.hint(pg_temp.c('nm_title'), repeat('7', 200))), 'match', array[]::text[], array['RECEIVER_MISMATCH'], p_n => 0);
-- (D) text that comes from the reader is cut to 300 characters wherever it lands in a reason
select pg_temp.keep('clsD', format($q$select public.finance_classify_slip(%L, %L::jsonb, %L::jsonb, 0.95, %L::jsonb)::text$q$, pg_temp.c('ev3'),
  (pg_temp.ex(jsonb_build_object('status_text', repeat('x', 1000) || ' failed', 'amount', repeat('a', 1000), 'transfer_at', repeat('y', 1000), 'trans_ref', repeat('R', 1000),
     'receiver', pg_temp.hint(repeat('ก', 1000), null))))::text,
  pg_temp.qrok(jsonb_build_object('trans_ref', repeat('Q', 1000)))::text,
  jsonb_build_array(jsonb_build_object('code', repeat('c', 1000), 'severity', 'high', 'detail', repeat('d', 1000)))::text));
select pg_temp.q('S2 text caps: every reason the reader''s text lands in is present (tamper, status, receiver, missing amount and date, QR mismatch)',
  $$select (select array_agg(r ->> 'code') from t_ctx, jsonb_array_elements((v::jsonb) -> 'reasons') r where k = 'clsD') @> array['TAMPER_SIGNAL', 'STATUS_NOT_SUCCESS', 'RECEIVER_MISMATCH', 'AMOUNT_MISSING', 'DATE_MISSING', 'QR_REF_MISMATCH']$$);
select pg_temp.q('S2 text caps: no string in the reasons is longer than 300 characters, and the cut ones are exactly 300 (cut, not dropped)',
  $$select max(length(x #>> '{}')) = 300 from t_ctx, jsonb_path_query((v::jsonb) -> 'reasons', '$.**') x where k = 'clsD' and jsonb_typeof(x) = 'string'$$);
-- (F) the duplicate scan has an index on the normalised reference for every source
select pg_temp.q('S2 indexes: every source of the duplicate scan has an expression index on finance_slip_ref',
  $$select count(*) = 6 and bool_and(indexdef like '%finance_slip_ref%') from pg_indexes where schemaname = 'public'
      and indexname in ('finance_receipts_slipref_idx', 'finance_evidence_slipref_idx', 'finance_evidence_confslipref_idx', 'finance_deposits_slipref_idx', 'finance_analysis_slipref_idx', 'finance_analysis_qrslipref_idx')$$);
select pg_temp.q('S2 indexes: the analysis indexes cover finished analyses only, the others rows that have a reference',
  $$select (select count(*) = 2 from pg_indexes where indexname in ('finance_analysis_slipref_idx', 'finance_analysis_qrslipref_idx') and indexdef like '%status = ''done''%')
        and (select count(*) = 4 from pg_indexes where indexname in ('finance_receipts_slipref_idx', 'finance_evidence_slipref_idx', 'finance_evidence_confslipref_idx', 'finance_deposits_slipref_idx') and indexdef like '%IS NOT NULL%')$$);
select pg_temp.q('S2 classify: no confidence reported is manual review too',
  format($$select public.finance_classify_slip(%L, %L::jsonb, %L::jsonb, null, '[]'::jsonb) ->> 'result' = 'manual_review'$$, pg_temp.c('ev3'), pg_temp.ex()::text, pg_temp.qrok()::text));
select pg_temp.cl('S2 classify: a low confidence on the AMOUNT alone (0.79) is manual review, whatever the overall confidence', pg_temp.ex('{"field_confidence": {"amount": 0.79, "date": 0.95, "time": 0.95, "receiver": 0.95, "ref": 0.95}}'), 'manual_review', array['LOW_CONFIDENCE']);
select pg_temp.cl('S2 classify: the amount confidence exactly at the threshold passes', pg_temp.ex('{"field_confidence": {"amount": 0.80, "date": 0.95, "time": 0.95, "receiver": 0.95, "ref": 0.95}}'), 'match', p_n => 0);
select pg_temp.runs_ok('S2 classify: the minimum confidence can be raised (settings)', $q$update public.finance_settings set ai_min_confidence = 0.90$q$);
select pg_temp.cl('S2 classify: with a minimum of 0.90, a confidence of 0.85 is manual review', pg_temp.ex('{"field_confidence": {"amount": 0.95, "date": 0.95, "time": 0.95, "receiver": 0.95, "ref": 0.95}}'), 'manual_review', array['LOW_CONFIDENCE'], p_conf => 0.85);
select pg_temp.cl('S2 classify: ...and 0.90 exactly passes', pg_temp.ex('{"field_confidence": {"amount": 0.95, "date": 0.95, "time": 0.95, "receiver": 0.95, "ref": 0.95}}'), 'match', p_conf => 0.90, p_n => 0);
select pg_temp.runs_ok('S2 classify: the minimum confidence is back to 0.80', $q$update public.finance_settings set ai_min_confidence = 0.80$q$);
-- precedence: a missing field, then duplicate, then suspicious, then amount, then date, then time, then confidence; every applicable code is listed
select pg_temp.cl('S2 precedence: a duplicate beats suspicious signals and an amount mismatch (all three are listed)', pg_temp.exr('S2DUPREC0001') || jsonb_build_object('amount', pg_temp.t3() / 2), 'duplicate_suspected',
  array['DUPLICATE_REFERENCE', 'QR_REF_MISMATCH', 'AMOUNT_UNDER'], p_qr => pg_temp.qrr('S2REF000000B2'));
select pg_temp.cl('S2 precedence: suspicious beats an amount mismatch', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() + 5)), 'suspicious_slip', array['TAMPER_SIGNAL', 'AMOUNT_OVER'], array['DUPLICATE_REFERENCE'],
  p_sig => '[{"code": "edited", "severity": "high", "detail": "edited"}]');
select pg_temp.cl('S2 precedence: an amount mismatch beats a date mismatch', pg_temp.ex(jsonb_build_object('amount', pg_temp.t3() / 2, 'transfer_at', '2026-11-15T14:00:00+07:00')), 'amount_mismatch', array['AMOUNT_UNDER', 'DATE_OUT_OF_RANGE']);
select pg_temp.cl('S2 precedence: a date mismatch beats low confidence', pg_temp.ex('{"transfer_at": "2026-11-15T14:00:00+07:00"}'), 'date_mismatch', array['DATE_OUT_OF_RANGE', 'LOW_CONFIDENCE'], p_conf => 0.5);
select pg_temp.cl('S2 precedence: a time anomaly beats low confidence', pg_temp.ex('{"time_known": false}'), 'time_anomaly', array['TIME_MISSING', 'LOW_CONFIDENCE'], p_conf => 0.5);
select pg_temp.cl('S2 precedence: a missing amount comes first, but a duplicate is still listed', pg_temp.exr('S2DUPREC0001') || '{"amount": null}', 'manual_review', array['AMOUNT_MISSING', 'DUPLICATE_REFERENCE'], p_qr => pg_temp.qrr('S2DUPREC0001'));
select pg_temp.cl('S2 precedence: a missing date comes before a QR problem, which is still listed', pg_temp.ex('{"transfer_at": null}'), 'manual_review', array['DATE_MISSING', 'QR_BAD_CRC'], p_qr => pg_temp.qrok('{"crc_ok": false}'));
select pg_temp.keep('clsAll', format($q$select public.finance_classify_slip(%L, %L::jsonb, %L::jsonb, 0.5, %L::jsonb)::text$q$, pg_temp.c('ev3'),
  (pg_temp.exr('S2DUPREC0001') || jsonb_build_object('amount', pg_temp.t3() + 5, 'transfer_at', '2026-11-15T14:00:00+07:00', 'status_text', 'ไม่สำเร็จ', 'receiver', pg_temp.hint('นาย สมชาย ใจดี', pg_temp.c('hint_none'))))::text,
  pg_temp.qrok('{"crc_ok": false, "trans_ref": "S2REF000000B2"}')::text, '[{"code": "edited", "severity": "high", "detail": "edited"}]'));
select pg_temp.q('S2 precedence: a slip with everything wrong lists every applicable code, and the duplicate decides',
  $$select (v::jsonb) ->> 'result' = 'duplicate_suspected'
        and (select array_agg(r ->> 'code') from jsonb_array_elements((v::jsonb) -> 'reasons') r) @> array['DUPLICATE_REFERENCE', 'QR_REF_MISMATCH', 'QR_BAD_CRC', 'TAMPER_SIGNAL', 'RECEIVER_MISMATCH', 'STATUS_NOT_SUCCESS', 'AMOUNT_OVER', 'DATE_OUT_OF_RANGE', 'LOW_CONFIDENCE']
     from t_ctx where k = 'clsAll'$$);
select pg_temp.q('S2 precedence: every reason has the six fields, a valid severity and a message',
  $$select count(*) >= 9 and bool_and(r ?& array['code', 'severity', 'field', 'expected', 'found', 'message'] and r ->> 'severity' in ('info', 'warn', 'high') and length(r ->> 'message') > 5 and r ->> 'code' ~ '^[A-Z_]+$')
     from t_ctx, jsonb_array_elements((v::jsonb) -> 'reasons') r where k = 'clsAll'$$);
select pg_temp.q('S2 classify: classifying is a pure reading (no analysis row, event or evidence change was made by the cases above)',
  format($$select count(*) = 1 and bool_and(status = 'queued') from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('ev3')));

-- ---- S2d who may call what: begin / complete / fail / classify / can_as are for the service role only (and the internal ones for nobody on the API)
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('S2 permissions: a customer cannot start an analysis', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev3'), pg_temp.c('A')), '%permission denied%');
select pg_temp.err_like('S2 permissions: a customer cannot store an analysis result', format($q$select public.finance_analysis_complete(%L, '{}'::jsonb, '{}'::jsonb, 0.9, '[]'::jsonb, 'x', 'v1')$q$, pg_temp.c('ev3')), '%permission denied%');
select pg_temp.err_like('S2 permissions: a customer cannot mark an analysis failed', format($q$select public.finance_analysis_fail(%L, 'x', 'x')$q$, pg_temp.c('ev3')), '%permission denied%');
select pg_temp.err_like('S2 permissions: a customer cannot run the classifier', format($q$select public.finance_classify_slip(%L, '{}'::jsonb, '{}'::jsonb, 0.9, '[]'::jsonb)$q$, pg_temp.c('ev3')), '%permission denied%');
select pg_temp.err_like('S2 permissions: a customer cannot ask what a user may do', format($q$select public.finance_can_as(%L, 'manage')$q$, pg_temp.c('A')), '%permission denied%');
select pg_temp.err_like('S2 permissions: a customer cannot ask for a re-run', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('ev3')), '%not allowed%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('S2 permissions: not even a manager can call the service-role functions (begin)', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev3'), pg_temp.c('S')), '%permission denied%');
select pg_temp.err_like('S2 permissions: ...or classify a slip by hand', format($q$select public.finance_classify_slip(%L, '{}'::jsonb, '{}'::jsonb, 0.9, '[]'::jsonb)$q$, pg_temp.c('ev3')), '%permission denied%');
reset role; set local role anon;
select pg_temp.err_like('S2 permissions: a signed-out visitor cannot start an analysis', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev3'), pg_temp.c('A')), '%permission denied%');
select pg_temp.err_like('S2 permissions: a signed-out visitor cannot ask for a re-run', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('ev3')), '%permission denied%');
reset role; set local role service_role;
select pg_temp.err_like('S2 permissions: the service role cannot run the internal classifier directly', format($q$select public.finance_classify_slip(%L, '{}'::jsonb, '{}'::jsonb, 0.9, '[]'::jsonb)$q$, pg_temp.c('ev3')), '%permission denied%');
select pg_temp.err_like('S2 permissions: ...nor the internal capability check', format($q$select public.finance_can_as(%L, 'view')$q$, pg_temp.c('S')), '%permission denied%');
reset role;
select pg_temp.q('S2 permissions: the grants are exactly: begin, complete and fail to the service role only; request to signed-in users; the internal functions to nobody on the API',
  $$select has_function_privilege('service_role', 'public.finance_analysis_begin(uuid, uuid, uuid)', 'execute') and not has_function_privilege('authenticated', 'public.finance_analysis_begin(uuid, uuid, uuid)', 'execute')
        and has_function_privilege('service_role', 'public.finance_analysis_complete(uuid, jsonb, jsonb, numeric, jsonb, text, text)', 'execute') and not has_function_privilege('anon', 'public.finance_analysis_complete(uuid, jsonb, jsonb, numeric, jsonb, text, text)', 'execute')
        and has_function_privilege('service_role', 'public.finance_analysis_fail(uuid, text, text)', 'execute') and not has_function_privilege('authenticated', 'public.finance_analysis_fail(uuid, text, text)', 'execute')
        and has_function_privilege('authenticated', 'public.finance_request_analysis(uuid)', 'execute') and not has_function_privilege('anon', 'public.finance_request_analysis(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb)', 'execute') and not has_function_privilege('service_role', 'public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb)', 'execute')
        and not has_function_privilege('authenticated', 'public.finance_can_as(uuid, text)', 'execute') and not has_function_privilege('anon', 'public.finance_can_as(uuid, text)', 'execute')$$);

-- ---- S2e begin: claim an analysis once
select pg_temp.keep('st3_before', format($q$select public.finance_invoice_state_raw(%L)::text$q$, pg_temp.c('i3id')));
reset role; set local role service_role;
select pg_temp.keep('b3', format($q$select public.finance_analysis_begin(%L, null, %L)::text$q$, pg_temp.c('ev3'), pg_temp.c('A')));
reset role;
select pg_temp.q('S2 begin: the customer who owns the invoice claims the slip and gets the analysis, the slip, the file path and its type',
  format($$select (v::jsonb) ->> 'analysis_id' = %L and (v::jsonb) ->> 'evidence_id' = %L and (v::jsonb) ->> 'file_path' = %L and (v::jsonb) ->> 'file_type' = 'image/png' from t_ctx where k = 'b3'$$,
    pg_temp.aid('ev3', 1), pg_temp.c('ev3'), pg_temp.c('A') || '/s2-ev3.png'));
select pg_temp.q('S2 begin: the attempt is running, with a start time', format($$select status = 'running' and started_at is not null and finished_at is null and result is null from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev3', 1)));
reset role; set local role service_role;
select pg_temp.err_like('S2 begin: a second call while it is running has nothing to do', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev3'), pg_temp.c('A')), '%NOTHING_TO_DO%');
select pg_temp.err_like('S2 begin: a slip that is not on the invoice named is not found', format($q$select public.finance_analysis_begin(%L, %L, %L)$q$, pg_temp.c('ev5'), pg_temp.c('i4id'), pg_temp.c('A')), '%NOT_FOUND%');
select pg_temp.err_like('S2 begin: naming nothing is not found', format($q$select public.finance_analysis_begin(null, null, %L)$q$, pg_temp.c('A')), '%NOT_FOUND%');
select pg_temp.err_like('S2 begin: an unknown slip is not found', format($q$select public.finance_analysis_begin(gen_random_uuid(), null, %L)$q$, pg_temp.c('A')), '%NOT_FOUND%');
select pg_temp.err_like('S2 begin: with no actor nothing is found', format($q$select public.finance_analysis_begin(%L, null, null)$q$, pg_temp.c('ev5')), '%NOT_FOUND%');
select pg_temp.err_like('S2 begin: another customer cannot claim the slip (not found, not "forbidden")', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev5'), pg_temp.c('B')), '%NOT_FOUND%');
reset role;
select pg_temp.q('S2 begin: ...and it did not claim anything', format($$select status = 'queued' and started_at is null from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev5', 1)));
select pg_temp.runs_ok('S2 begin: customer A''s profile is disabled (inside this run)', format($q$update public.profiles set status = 'disabled' where id = %L$q$, pg_temp.c('A')));
reset role; set local role service_role;
select pg_temp.err_like('S2 begin: a customer whose profile is disabled cannot claim their own slip (not found)', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev5'), pg_temp.c('A')), '%NOT_FOUND%');
reset role;
select pg_temp.runs_ok('S2 begin: customer A''s profile is active again', format($q$update public.profiles set status = 'active' where id = %L$q$, pg_temp.c('A')));
select pg_temp.q('S2 begin: ...and the refused call claimed nothing', format($$select status = 'queued' and started_at is null from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev5', 1)));
select pg_temp.runs_ok('S2 begin: the AI review is switched off while slips are waiting', $q$update public.finance_settings set ai_review_enabled = false$q$);
reset role; set local role service_role;
select pg_temp.err_like('S2 begin: with the AI review off nothing is started (AI_DISABLED), whoever asks', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev6'), pg_temp.c('A')), '%AI_DISABLED%');
reset role;
select pg_temp.runs_ok('S2 begin: the AI review is on again', $q$update public.finance_settings set ai_review_enabled = true$q$);
select pg_temp.q('S2 begin: ...the refused call claimed nothing', format($$select status = 'queued' from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev6', 1)));
reset role; set local role service_role;
select pg_temp.keep('b5', format($q$select public.finance_analysis_begin(%L, null, %L)::text$q$, pg_temp.c('ev5'), pg_temp.c('C')));
select pg_temp.keep('b7', format($q$select public.finance_analysis_begin(null, %L, %L)::text$q$, pg_temp.c('i5id'), pg_temp.c('A')));
reset role;
select pg_temp.q('S2 begin: a staff member who can view finance claims a slip they do not own', format($$select (v::jsonb) ->> 'analysis_id' = %L and (v::jsonb) ->> 'evidence_id' = %L from t_ctx where k = 'b5'$$, pg_temp.aid('ev5', 1), pg_temp.c('ev5')));
select pg_temp.q('S2 begin: naming the invoice claims the invoice''s slip', format($$select (v::jsonb) ->> 'analysis_id' = %L and (v::jsonb) ->> 'evidence_id' = %L from t_ctx where k = 'b7'$$, pg_temp.aid('ev7', 1), pg_temp.c('ev7')));
-- a run that died is not a lock for ever
select pg_temp.runs_ok('S2 setup: the run of ev5 started 4 minutes ago', $q$update public.finance_slip_analysis set started_at = now() - interval '4 minutes' where id = pg_temp.aid('ev5', 1)$q$);
reset role; set local role service_role;
select pg_temp.err_like('S2 begin: a run that started 4 minutes ago is still running', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev5'), pg_temp.c('A')), '%NOTHING_TO_DO%');
reset role;
select pg_temp.runs_ok('S2 setup: the run of ev5 started 6 minutes ago', $q$update public.finance_slip_analysis set started_at = now() - interval '6 minutes' where id = pg_temp.aid('ev5', 1)$q$);
reset role; set local role service_role;
select pg_temp.keep('b5b', format($q$select public.finance_analysis_begin(%L, null, %L)::text$q$, pg_temp.c('ev5'), pg_temp.c('A')));
reset role;
select pg_temp.q('S2 begin: a run that has been "running" for over 5 minutes counts as dead and is claimed again (same attempt, fresh start)',
  format($$select (v::jsonb) ->> 'analysis_id' = %L and (select started_at > now() - interval '1 minute' and status = 'running' from public.finance_slip_analysis where id = %L) from t_ctx where k = 'b5b'$$, pg_temp.aid('ev5', 1), pg_temp.aid('ev5', 1)));

-- ---- S2f complete: the classifier decides, everything is stored, one event is written, a second completion is refused
select pg_temp.keep('c3_ref', format($q$select count(*)::text from public.finance_events where entity = 'evidence' and entity_id = %L and action = 'evidence.analysis'$q$, pg_temp.c('ev3')));
reset role; set local role service_role;
select pg_temp.keep('cm3', format($q$select public.finance_analysis_complete(%L, %L::jsonb, %L::jsonb, 0.95, '[]'::jsonb, 'claude-haiku-5-5', 'v1')::text$q$, pg_temp.aid('ev3', 1), pg_temp.ex()::text, pg_temp.qrok()::text));
reset role;
select pg_temp.q('S2 complete: it answers with the result and the reasons', $$select (v::jsonb) ->> 'result' = 'match' and jsonb_array_length((v::jsonb) -> 'reasons') = 0 from t_ctx where k = 'cm3'$$);
select pg_temp.q('S2 complete: the attempt is done and holds what the reader read, the QR, the engine, the prompt version, the confidence and the finish time',
  format($$select status = 'done' and result = 'match' and engine = 'claude-haiku-5-5' and prompt_version = 'v1' and overall_confidence = 0.950 and error is null and finished_at is not null
       and extracted = %L::jsonb and qr = %L::jsonb and signals = '[]'::jsonb and reasons = '[]'::jsonb from public.finance_slip_analysis where id = %L$$, pg_temp.ex()::text, pg_temp.qrok()::text, pg_temp.aid('ev3', 1)));
select pg_temp.q('S2 complete: the attempt keeps the snapshot of what the order expected',
  format($$select (expected ->> 'amount')::numeric = pg_temp.t3() and (expected ->> 'window_from')::timestamptz = timestamptz '2026-11-18 12:00:00+07'
       and jsonb_array_length(expected -> 'receivers') >= 3 from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev3', 1)));
select pg_temp.q('S2 complete: one evidence.analysis event was written with the result and the confidence',
  format($$select count(*) = (select v::int from t_ctx where k = 'c3_ref') + 1 and bool_or(detail ->> 'result' = 'match' and (detail ->> 'confidence')::numeric = 0.95)
       from public.finance_events where entity = 'evidence' and entity_id = %L and action = 'evidence.analysis'$$, pg_temp.c('ev3')));
select pg_temp.q('S2 complete: THE AI CHANGES NO MONEY STATE: the slip is still submitted and the invoice state is exactly as before',
  format($$select (select status = 'submitted' and reviewed_by is null and verified_amount is null from public.finance_payment_evidence where id = %L)
       and exists (select 1 from public.finance_slip_analysis where id = pg_temp.aid('ev3', 1) and status = 'done')
       and public.finance_invoice_state_raw(%L)::text = (select v from t_ctx where k = 'st3_before')
       and not exists (select 1 from public.finance_receipts where invoice_id = %L and evidence_id = %L)$$, pg_temp.c('ev3'), pg_temp.c('i3id'), pg_temp.c('i3id'), pg_temp.c('ev3')));
reset role; set local role service_role;
select pg_temp.err_like('S2 complete: a finished analysis cannot be completed twice', format($q$select public.finance_analysis_complete(%L, %L::jsonb, %L::jsonb, 0.95, '[]'::jsonb, 'claude-haiku-5-5', 'v1')$q$, pg_temp.aid('ev3', 1), pg_temp.ex()::text, pg_temp.qrok()::text), '%ALREADY_DONE%');
select pg_temp.err_like('S2 complete: an unknown analysis is not found', format($q$select public.finance_analysis_complete(gen_random_uuid(), %L::jsonb, %L::jsonb, 0.95, '[]'::jsonb, 'x', 'v1')$q$, pg_temp.ex()::text, pg_temp.qrok()::text), '%NOT_FOUND%');
select pg_temp.err_like('S2 complete: a confidence above 1 is refused', format($q$select public.finance_analysis_complete(%L, %L::jsonb, %L::jsonb, 1.5, '[]'::jsonb, 'x', 'v1')$q$, pg_temp.aid('ev5', 1), pg_temp.ex()::text, pg_temp.qrok()::text), '%confidence%');
reset role;
select pg_temp.q('S2 complete: ...and left that attempt as it was (still running)', format($$select status = 'running' and result is null from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev5', 1)));
-- a slip that is not a slip, claimed by invoice
reset role; set local role service_role;
select pg_temp.keep('cm7', format($q$select public.finance_analysis_complete(%L, '{"is_slip": false, "amount": null}'::jsonb, '{"found": false}'::jsonb, 0.5, '[{"code": "screenshot", "severity": "low", "detail": "a screenshot of a chat"}]'::jsonb, 'claude-haiku-5-5', 'v1')::text$q$, pg_temp.aid('ev7', 1)));
reset role;
select pg_temp.q('S2 complete: a picture that is not a slip is stored as manual review with its reason, signals and low confidence, and the returned reasons are the stored ones',
  format($$select status = 'done' and result = 'manual_review' and overall_confidence = 0.500 and reasons -> 0 ->> 'code' = 'NOT_A_SLIP' and signals -> 0 ->> 'code' = 'screenshot'
       and (select (v::jsonb) -> 'reasons' = reasons and (v::jsonb) ->> 'result' = result from t_ctx where k = 'cm7') from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev7', 1)));
select pg_temp.q('S2 complete: ...and for a manual invoice with no shop order the snapshot counts from the invoice time',
  format($$select (expected ->> 'order_created_at')::timestamptz = (select created_at from public.finance_invoices where id = %L) from public.finance_slip_analysis where id = %L$$, pg_temp.c('i5id'), pg_temp.aid('ev7', 1)));
reset role; set local role service_role;
select pg_temp.err_like('S2 begin: after completion the slip is reported as already analysed', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('ev3'), pg_temp.c('A')), '%ALREADY_DONE%');
select pg_temp.err_like('S2 begin: ...also when the invoice is named', format($q$select public.finance_analysis_begin(null, %L, %L)$q$, pg_temp.c('i5id'), pg_temp.c('A')), '%ALREADY_DONE%');
reset role;
-- a reader that sent no QR, no signals and no confidence: stored as such, and the slip needs a person
select pg_temp.mkev('evNull', 'i3id');
reset role; set local role service_role;
select pg_temp.keep('cmN', format($q$select public.finance_analysis_complete(%L, %L::jsonb, null, null, null, 'claude-haiku-5-5', 'v1')::text$q$, pg_temp.aid('evNull', 1), pg_temp.exr('S2REF000000N1')::text));
select pg_temp.err_like('S2 begin: a payment recorded by staff has no slip image to read', format($q$select public.finance_analysis_begin(%L, null, %L)$q$, pg_temp.c('evCash'), pg_temp.c('C')), '%NOTHING_TO_DO%');
reset role;
select pg_temp.q('S2 complete: no QR, no signals and no confidence are stored as null / [] / null, and the slip is manual review (LOW_CONFIDENCE) - completing a waiting attempt directly is allowed',
  format($$select status = 'done' and result = 'manual_review' and qr is null and signals = '[]'::jsonb and overall_confidence is null and reasons @> '[{"code": "LOW_CONFIDENCE"}]'::jsonb from public.finance_slip_analysis where id = %L$$, pg_temp.aid('evNull', 1)));
-- (B) complete judges the confidence as the reader reported it and stores it rounded to 3 decimals
select pg_temp.mkev('evB', 'i3id');
reset role; set local role service_role;
select pg_temp.keep('cmB', format($q$select public.finance_analysis_complete(%L, %L::jsonb, %L::jsonb, 0.7995, '[]'::jsonb, 'claude-haiku-5-5', 'v1')::text$q$, pg_temp.aid('evB', 1), pg_temp.exr('S2REF000000B7')::text, pg_temp.qrr('S2REF000000B7')::text));
reset role;
select pg_temp.q('S2 complete: a confidence of 0.7995 is judged as reported (below 0.80: manual review, LOW_CONFIDENCE) and stored rounded to 0.800',
  format($$select status = 'done' and result = 'manual_review' and overall_confidence = 0.800 and reasons @> '[{"code": "LOW_CONFIDENCE"}]'::jsonb from public.finance_slip_analysis where id = %L$$, pg_temp.aid('evB', 1)));
-- duplicates against another slip's finished analysis
select pg_temp.cl('S2 classify: a reference read on another slip''s finished analysis (printed) is a suspected duplicate', pg_temp.ex(), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_ev => 'ev5');
select pg_temp.cl('S2 classify: ...also when only the QR reference matches it', pg_temp.exr(null), 'duplicate_suspected', array['DUPLICATE_REFERENCE'], p_ev => 'ev5');
select pg_temp.cl('S2 classify: the slip that was analysed is not a duplicate of its own analysis (a re-run)', pg_temp.ex(), 'match', p_n => 0);
select pg_temp.cl('S2 classify: a different slip with another reference is not a duplicate of it', pg_temp.exr('S2REF000000Z9'), 'match', p_qr => pg_temp.qrr('S2REF000000Z9'), p_ev => 'ev5', p_n => 0);

-- ---- S2g re-run by staff: a new attempt, the old ones stay
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: a slip that is waiting for the reader cannot be queued again (ALREADY_QUEUED)', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('ev6')), '%ALREADY_QUEUED%');
select pg_temp.err_like('S2 request: ...nor one that is being read right now', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('ev5')), '%ALREADY_QUEUED%');
select pg_temp.err_like('S2 request: an unknown slip is not found', $q$select public.finance_request_analysis(gen_random_uuid())$q$, '%NOT_FOUND%');
select pg_temp.err_like('S2 request: a payment recorded by staff has no slip image to read', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('evCash')), '%NOTHING_TO_DO%');
-- a worker that died (timeout, out of memory) leaves its attempt "running" for ever. After the same 5 minutes begin uses to claim such a run again, a staff re-run
-- closes it as failed (so it is not a lock for ever) and queues a new attempt; a fresh run, or a waiting one, is still refused; the 5-attempt cap still applies.
reset role;
select pg_temp.mkev('evStale', 'i3id');
select pg_temp.runs_ok('S2 setup: the attempt of a new slip has been running for 4 minutes', format($q$update public.finance_slip_analysis set status = 'running', started_at = now() - interval '4 minutes' where id = %L$q$, pg_temp.aid('evStale', 1)));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: a run that started 4 minutes ago is still running (ALREADY_QUEUED)', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('evStale')), '%ALREADY_QUEUED%');
reset role;
select pg_temp.q('S2 request: ...and nothing was closed or queued', format($$select count(*) = 1 and bool_and(attempt = 1 and status = 'running' and result is null and error is null) from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('evStale')));
select pg_temp.runs_ok('S2 setup: the run of the new slip has now been running for 6 minutes (its worker died)', format($q$update public.finance_slip_analysis set started_at = now() - interval '6 minutes' where id = %L$q$, pg_temp.aid('evStale', 1)));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.keep('raS', format($q$select public.finance_request_analysis(%L)::text$q$, pg_temp.c('evStale')));
reset role;
select pg_temp.q('S2 request: a run stuck for over 5 minutes is closed as failed (manual review, WORKER_STOPPED, reason AI_UNAVAILABLE, a finish time, no engine)',
  format($$select status = 'failed' and result = 'manual_review' and error like 'WORKER_STOPPED:%%' and finished_at is not null and engine is null and extracted is null
       and reasons -> 0 ->> 'code' = 'AI_UNAVAILABLE' and jsonb_array_length(reasons) = 1 from public.finance_slip_analysis where id = %L$$, pg_temp.aid('evStale', 1)));
select pg_temp.q('S2 request: ...and a new attempt 2 is queued, asked by the verifier, next to the old one (the history is kept)',
  format($$select count(*) = 2 and bool_and(case attempt when 1 then status = 'failed' else id::text = (select v from t_ctx where k = 'raS') and status = 'queued' and requested_by = %L and result is null end) from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('C'), pg_temp.c('evStale')));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: with the new attempt waiting, another request is refused (ALREADY_QUEUED)', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('evStale')), '%ALREADY_QUEUED%');
reset role;
select pg_temp.runs_ok('S2 setup: the waiting attempt is an hour old (waiting is not the same as dead: begin claims it)', format($q$update public.finance_slip_analysis set created_at = now() - interval '1 hour' where id::text = %L$q$, pg_temp.c('raS')));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: ...a waiting attempt is never closed, however old (ALREADY_QUEUED)', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('evStale')), '%ALREADY_QUEUED%');
reset role;
select pg_temp.q('S2 request: ...and it is still waiting', format($$select status = 'queued' and finished_at is null from public.finance_slip_analysis where id::text = %L$$, pg_temp.c('raS')));
-- the cap still applies: a stale 5th run is not closed and replaced (the refusal undoes everything, so it stays running)
select pg_temp.mkev('evCap', 'i3id');
select pg_temp.runs_ok('S2 setup: attempt 1 of a slip is failed', format($q$update public.finance_slip_analysis set status = 'failed', result = 'manual_review', error = 'test', finished_at = now() where id = %L$q$, pg_temp.aid('evCap', 1)));
select pg_temp.runs_ok('S2 setup: attempts 2-4 are failed too', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status, result, error, finished_at) select %L::uuid, n, 'failed', 'manual_review', 'test', now() from generate_series(2, 4) n$q$, pg_temp.c('evCap')));
select pg_temp.runs_ok('S2 setup: attempt 5 has been running for 6 minutes', format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status, started_at) values (%L::uuid, 5, 'running', now() - interval '6 minutes')$q$, pg_temp.c('evCap')));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: a slip already read 5 times is refused (TOO_MANY_ATTEMPTS) even when its last run is stale', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('evCap')), '%TOO_MANY_ATTEMPTS%');
reset role;
select pg_temp.q('S2 request: ...and nothing changed (still 5 attempts, the 5th still running)', format($$select count(*) = 5 and count(*) filter (where attempt = 5 and status = 'running') = 1 and count(*) filter (where status = 'failed') = 4 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('evCap')));
-- begin still reclaims a stale run too (the other way out), and a customer cannot use the re-run to close anything
select pg_temp.mkev('evCust', 'i3id');
select pg_temp.runs_ok('S2 setup: another slip whose run died 6 minutes ago', format($q$update public.finance_slip_analysis set status = 'running', started_at = now() - interval '6 minutes' where id = %L$q$, pg_temp.aid('evCust', 1)));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('S2 request: a customer cannot re-run, so cannot close a stale run either', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('evCust')), '%not allowed%');
reset role;
select pg_temp.q('S2 request: ...and that run is untouched', format($$select status = 'running' and result is null from public.finance_slip_analysis where id = %L$$, pg_temp.aid('evCust', 1)));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.keep('ra2', format($q$select public.finance_request_analysis(%L)::text$q$, pg_temp.c('ev3')));
reset role;
select pg_temp.q('S2 request: a verifier queues a new attempt (number 2, waiting, asked by them)',
  format($$select count(*) = 1 and bool_and(id::text = (select v from t_ctx where k = 'ra2') and status = 'queued' and requested_by = %L and result is null) from public.finance_slip_analysis where evidence_id = %L and attempt = 2$$, pg_temp.c('C'), pg_temp.c('ev3')));
select pg_temp.q('S2 request: THE OLD ATTEMPT IS KEPT unchanged (history)', format($$select status = 'done' and result = 'match' and overall_confidence = 0.950 and extracted = %L::jsonb from public.finance_slip_analysis where evidence_id = %L and attempt = 1$$, pg_temp.ex()::text, pg_temp.c('ev3')));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: a second request while attempt 2 waits is refused (ALREADY_QUEUED)', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('ev3')), '%ALREADY_QUEUED%');
reset role; set local role service_role;
select pg_temp.keep('b3b', format($q$select public.finance_analysis_begin(%L, null, %L)::text$q$, pg_temp.c('ev3'), pg_temp.c('C')));
reset role;
select pg_temp.q('S2 begin: with attempt 1 done, the next begin claims the NEW attempt (2)', format($$select (v::jsonb) ->> 'analysis_id' = %L from t_ctx where k = 'b3b'$$, pg_temp.aid('ev3', 2)));
-- fail: the reader could not do it
reset role; set local role service_role;
select pg_temp.runs_ok('S2 fail: the service role records that the reader failed', format($q$select public.finance_analysis_fail(%L, 'ANTHROPIC_API_KEY is not set', 'claude-haiku-5-5')$q$, pg_temp.aid('ev3', 2)));
reset role;
select pg_temp.q('S2 fail: the attempt is failed with manual review, the reason AI_UNAVAILABLE, the error text and a finish time',
  format($$select status = 'failed' and result = 'manual_review' and error = 'ANTHROPIC_API_KEY is not set' and engine = 'claude-haiku-5-5' and finished_at is not null
       and reasons -> 0 ->> 'code' = 'AI_UNAVAILABLE' and reasons -> 0 ->> 'severity' = 'warn' and jsonb_array_length(reasons) = 1 and extracted is null from public.finance_slip_analysis where id = %L$$, pg_temp.aid('ev3', 2)));
reset role; set local role service_role;
select pg_temp.err_like('S2 fail: a failed attempt cannot be failed again', format($q$select public.finance_analysis_fail(%L, 'again', 'x')$q$, pg_temp.aid('ev3', 2)), '%ALREADY_DONE%');
select pg_temp.err_like('S2 fail: ...nor completed', format($q$select public.finance_analysis_complete(%L, %L::jsonb, %L::jsonb, 0.95, '[]'::jsonb, 'x', 'v1')$q$, pg_temp.aid('ev3', 2), pg_temp.ex()::text, pg_temp.qrok()::text), '%ALREADY_DONE%');
select pg_temp.err_like('S2 fail: a finished (done) attempt cannot be failed either', format($q$select public.finance_analysis_fail(%L, 'late', 'x')$q$, pg_temp.aid('ev3', 1)), '%ALREADY_DONE%');
select pg_temp.err_like('S2 fail: an unknown analysis is not found', $q$select public.finance_analysis_fail(gen_random_uuid(), 'x', 'x')$q$, '%NOT_FOUND%');
select pg_temp.runs_ok('S2 fail: an attempt that never started can be failed too (an empty error text becomes "unknown error")', format($q$select public.finance_analysis_fail(%L, '   ', null)$q$, pg_temp.aid('evDirect', 1)));
reset role;
select pg_temp.q('S2 fail: ...with the error stored', format($$select status = 'failed' and error = 'unknown error' and result = 'manual_review' and engine is null from public.finance_slip_analysis where id = %L$$, pg_temp.aid('evDirect', 1)));
select pg_temp.q('S2 fail: attempt 1 of the slip is still exactly as it was completed', format($$select status = 'done' and result = 'match' from public.finance_slip_analysis where evidence_id = %L and attempt = 1$$, pg_temp.c('ev3')));
-- after a failure a new request is allowed; at most 5 attempts per slip; and nothing is requested while the AI review is off
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.keep('ra3', format($q$select public.finance_request_analysis(%L)::text$q$, pg_temp.c('ev3')));
reset role;
select pg_temp.q('S2 request: after a failure a new attempt (3) can be queued', format($$select attempt = 3 and status = 'queued' from public.finance_slip_analysis where id::text = (select v from t_ctx where k = 'ra3')$$));
select pg_temp.runs_ok('S2 setup: attempt 3 is marked failed (a waiting attempt can fail)', $q$update public.finance_slip_analysis set status = 'failed', result = 'manual_review', error = 'test', finished_at = now() where id::text = (select v from t_ctx where k = 'ra3')$q$);
select pg_temp.runs_ok('S2 setup: attempts 4 and 5 exist (failed)', $q$insert into public.finance_slip_analysis (evidence_id, attempt, status, result, error, finished_at) select pg_temp.c('ev3')::uuid, n, 'failed', 'manual_review', 'test', now() from generate_series(4, 5) n$q$);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: a slip can be read at most 5 times (TOO_MANY_ATTEMPTS)', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('ev3')), '%TOO_MANY_ATTEMPTS%');
reset role;
select pg_temp.runs_ok('S2 request: the AI review is switched off', $q$update public.finance_settings set ai_review_enabled = false$q$);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.err_like('S2 request: with the AI review off a re-run is refused (AI_DISABLED)', format($q$select public.finance_request_analysis(%L)$q$, pg_temp.c('evDirect')), '%AI_DISABLED%');
reset role;
select pg_temp.q('S2 request: ...and queued nothing', format($$select count(*) = 1 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('evDirect')));

-- ---- S2h who can read the analyses of this section
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.q('S2 RLS: customer A sees none of the analyses, not even of their own slips', $$select count(*) = 0 from public.finance_slip_analysis$$);
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.q('S2 RLS: customer B cannot read A''s analysis', format($$select count(*) = 0 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('ev3')));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('C')::uuid);
select pg_temp.q('S2 RLS: a verifier sees all five attempts of the slip', format($$select count(*) = 5 and count(*) filter (where status = 'done') = 1 and count(*) filter (where status = 'failed') = 4 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('ev3')));
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.q('S2 RLS: a manager sees them too', format($$select count(*) = 5 from public.finance_slip_analysis where evidence_id = %L$$, pg_temp.c('ev3')));
reset role;

-- ---- put back what this section changed in the shared setup: the real default payment account and the dark settings
update public.finance_payment_accounts set is_default = false, active = false where id = pg_temp.c('pa_s2')::uuid;
update public.finance_payment_accounts set is_default = true where id = (select v::uuid from t_ctx where k = 'pa_prev');
select pg_temp.runs_ok('S2 cleanup: the settings are back to the dark defaults', $q$update public.finance_settings set ai_review_enabled = false, post_requires_manager = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10$q$);
select pg_temp.q('S2 cleanup: the real default payment account is the default again (or there was none), the test account is off, the settings are dark',
  $$select (select count(*) from public.finance_payment_accounts where is_default and active) = (select count(*) from t_ctx where k = 'pa_prev' and v is not null)
      and not exists (select 1 from public.finance_payment_accounts where id = pg_temp.c('pa_s2')::uuid and (is_default or active))
      and (select not ai_review_enabled and not post_requires_manager and ai_min_confidence = 0.80 and slip_window_before_min = 120 and slip_future_tolerance_min = 10 from public.finance_settings)$$);

-- =========================================================================================== S3 workflow
-- Confirm (verifier+) then Post (verifier+, or a manager when post_requires_manager) is what makes money officially received; Reject and Request more evidence send a
-- slip back to the customer; Record payment lets staff enter a transfer or a cash payment at the back office. The old one-step finance_verify_evidence must go on
-- behaving exactly as before (S3a). Every call goes through keep / q / err_like / runs_ok, so a missing function is a recorded failure and the run goes on.
-- All invoices are manual ones made here by manager S for customer A's finance customer (plus three shop orders for the cancel checks), and every look-up is by this
-- section's own ids: production holds real invoices and slips, so there are no absolute table counts. A fourth real user D becomes a clerk (to prove a clerk cannot).
reset role;
-- sign in as one of the test users (the role switch is local to the transaction, like the top-level statements of the earlier sections)
create or replace function pg_temp.asu(p_key text) returns void language plpgsql as $$
begin
  execute 'reset role'; execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.c(p_key)::uuid, 'role', 'authenticated')::text, true);
end $$;
-- look-ups with owner rights (they work whoever is signed in): the state of an invoice, a column of an evidence row or of its receipt, ledger rows, audit rows
create or replace function pg_temp.sv(p_inv text, p_key text) returns text language sql security definer as $$
  select public.finance_invoice_state_raw(pg_temp.c(p_inv)::uuid) ->> p_key $$;
create or replace function pg_temp.ev(p_ev text, p_col text) returns text language plpgsql security definer as $$
declare v text;
begin execute format('select %I::text from public.finance_payment_evidence where id = %L', p_col, pg_temp.c(p_ev)) into v; return v; end $$;
create or replace function pg_temp.rcol(p_ev text, p_col text) returns text language plpgsql security definer as $$
declare v text;
begin execute format('select %I::text from public.finance_receipts where evidence_id = %L', p_col, pg_temp.c(p_ev)) into v; return v; end $$;
create or replace function pg_temp.nrc(p_ev text) returns bigint language sql security definer as $$
  select count(*) from public.finance_receipts where evidence_id = pg_temp.c(p_ev)::uuid $$;
create or replace function pg_temp.alloc(p_ev text) returns numeric language sql security definer as $$
  select coalesce(sum(a.amount), 0) from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id where r.evidence_id = pg_temp.c(p_ev)::uuid and a.active $$;
create or replace function pg_temp.qplan(p_ev text, p_type text) returns jsonb language sql security definer as $$
  select q.plan from public.finance_gl_queue q join public.finance_receipts r on r.id = q.ref_id where r.evidence_id = pg_temp.c(p_ev)::uuid and q.event_type = p_type $$;
create or replace function pg_temp.nq(p_ev text, p_type text) returns bigint language sql security definer as $$
  select count(*) from public.finance_gl_queue q join public.finance_receipts r on r.id = q.ref_id where r.evidence_id = pg_temp.c(p_ev)::uuid and q.event_type = p_type $$;
create or replace function pg_temp.nev(p_ev text, p_action text, p_actor text default null) returns bigint language sql security definer as $$
  select count(*) from public.finance_events where entity = 'evidence' and entity_id = pg_temp.c(p_ev)::uuid and action = p_action and (p_actor is null or actor = pg_temp.c(p_actor)::uuid) $$;
create or replace function pg_temp.nevr(p_ev text, p_action text, p_actor text default null) returns bigint language sql security definer as $$
  select count(*) from public.finance_events e join public.finance_receipts r on r.id = e.entity_id where e.entity = 'receipt' and r.evidence_id = pg_temp.c(p_ev)::uuid and e.action = p_action and (p_actor is null or e.actor = pg_temp.c(p_actor)::uuid) $$;
create or replace function pg_temp.nrows(p_inv text) returns bigint language sql security definer as $$
  select count(*) from public.finance_payment_evidence where invoice_id = pg_temp.c(p_inv)::uuid $$;
-- actions, each by the user who is signed in. A manual invoice, a slip of the customer, a confirmation, a post, a recorded payment (the SQL of a call is also
-- available as text for err_like)
create or replace function pg_temp.mkinv(p_key text, p_amount numeric) returns void language plpgsql as $$
begin
  perform pg_temp.keep(p_key, format($q$select (public.finance_create_invoice(%L, %s, current_date, current_date, %L, %L)).id::text$q$, pg_temp.c('cust'), p_amount, 'S3 test invoice ' || p_key, 'S3-' || p_key));
end $$;
create or replace function pg_temp.mkslip(p_key text, p_inv text, p_amount numeric) returns void language plpgsql as $$
begin
  perform pg_temp.keep(p_key, format($q$select public.finance_submit_evidence(%L, %L, %L, 'image/png', %s, now(), 'SCB', null, %L)::text$q$,
    pg_temp.c(p_inv), pg_temp.c('A') || '/s3-' || p_key || '.png', md5('s3-' || p_key) || md5('s3b-' || p_key), p_amount, pg_temp.c('scb')));
end $$;
create or replace function pg_temp.conf(p_key text, p_ev text, p_amount numeric, p_ref text, p_note text default 'S3 test') returns void language plpgsql as $$
begin
  perform pg_temp.keep(p_key, format($q$select public.finance_confirm_evidence(%L, %s, %L, now(), %L)::text$q$, pg_temp.c(p_ev), p_amount, p_ref, p_note));
end $$;
create or replace function pg_temp.post(p_key text, p_ev text) returns void language plpgsql as $$
begin perform pg_temp.keep(p_key, format($q$select public.finance_post_evidence(%L)::text$q$, pg_temp.c(p_ev))); end $$;
create or replace function pg_temp.recx(p_inv text, p_method text, p_amount text, p_ref text default null, p_note text default 'S3 test entry', p_at text default 'now()', p_bank text default null,
                                        p_file text default null, p_sha text default null, p_type text default null) returns text language sql as $$
  select format($q$public.finance_record_payment(%L, %L, %s, %s, %L, %L, %L, %L, %L, %L)$q$, pg_temp.c(p_inv), p_method, p_amount, p_at, p_ref, case when p_bank = 'scb' then pg_temp.c('scb') end, p_note, p_file, p_sha, p_type) $$;
create or replace function pg_temp.rec(p_key text, p_inv text, p_method text, p_amount numeric, p_ref text default null, p_note text default 'S3 test entry', p_bank text default null) returns void language plpgsql as $$
begin perform pg_temp.keep(p_key, 'select ' || pg_temp.recx(p_inv, p_method, p_amount::text, p_ref, p_note, 'now()', p_bank) || '::text'); end $$;
-- the statement must fail with this SQLSTATE (the clients tell a reused reference 23505 from other refusals by it)
create or replace function pg_temp.err_state(p_test text, p_sql text, p_state text) returns void language plpgsql as $$
declare s text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected SQLSTATE ' || p_state || ')');
  exception when others then get stacked diagnostics s = returned_sqlstate; perform pg_temp.chk(p_test, s = p_state, s || ' ' || sqlerrm);
  end;
end $$;
create or replace function pg_temp.jb(p_key text, p_path text) returns text language sql as $$ select (select v::jsonb from t_ctx where k = p_key) ->> p_path $$;

-- ---- fixtures
insert into t_ctx select 'D', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 3 limit 1;
insert into public.finance_staff_roles (user_id, role) select pg_temp.c('D')::uuid, 'clerk' where pg_temp.c('D') is not null;
insert into t_res (test, ok, detail) select 'S3 setup: a fourth real user exists and is now a clerk', (select role from public.finance_staff_roles where user_id = pg_temp.c('D')::uuid) = 'clerk', null;
select pg_temp.runs_ok('S3 setup: the settings start at the dark defaults', $q$update public.finance_settings set ai_review_enabled = false, post_requires_manager = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10$q$);
select pg_temp.asu('S');
select pg_temp.mkinv('ia', 100); select pg_temp.mkinv('ib', 100); select pg_temp.mkinv('ix', 100);
select pg_temp.mkinv('ic', 300); select pg_temp.mkinv('id', 200); select pg_temp.mkinv('ie', 300); select pg_temp.mkinv('ie2', 100);
select pg_temp.mkinv('if', 200); select pg_temp.mkinv('ig', 350); select pg_temp.mkinv('ih', 300); select pg_temp.mkinv('ii', 500);
select pg_temp.mkinv('ij', 120); select pg_temp.mkinv('ik', 120); select pg_temp.mkinv('il', 50); select pg_temp.mkinv('im', 100);
reset role;
-- a verified wallet deposit that carries a bank reference (made by the wallet's own functions)
select pg_temp.asu('A');
select pg_temp.keep('depj', $q$select public.finance_deposit_create(pg_temp.c('scb')::uuid, 1000, 'dep-key-s3-0001', 'S3')::text$q$);
select pg_temp.keep('depid', $q$select (v::jsonb) ->> 'id' from t_ctx where k = 'depj'$q$);
select pg_temp.keep('depsub', format($q$select public.finance_deposit_submit_slip(%L, %L, %L, 'image/png', now())::text$q$, pg_temp.c('depid'), pg_temp.c('A') || '/s3-deposit.png', md5('s3-deposit') || md5('s3b-deposit')));
reset role;
select pg_temp.asu('C');
select pg_temp.keep('depver', format($q$select public.finance_deposit_verify(%L, 1000, 'S3WDREF0001', now())::text$q$, pg_temp.c('depid')));
reset role;
select pg_temp.asu('A');
select pg_temp.mkslip('ea', 'ia', 100); select pg_temp.mkslip('eb', 'ib', 130); select pg_temp.mkslip('ex1', 'ix', 100);
reset role;
insert into t_res (test, ok, detail) select 'S3 setup: the invoices, the slips and a verified wallet deposit exist',
  (select count(*) from t_ctx where k in ('ia', 'ib', 'ix', 'ic', 'id', 'ie', 'ie2', 'if', 'ig', 'ih', 'ii', 'ij', 'ik', 'il', 'im', 'ea', 'eb', 'ex1', 'depid', 'depver') and v is not null) = 20,
  (select string_agg(k, ',') from t_ctx where k in ('ia', 'ib', 'ix', 'ic', 'id', 'ie', 'ie2', 'if', 'ig', 'ih', 'ii', 'ij', 'ik', 'il', 'im', 'ea', 'eb', 'ex1', 'depid', 'depver') and v is null);

-- ---- S3a: the one-step verify with the settings off (the shipped, dark state): same answer, same receipt, same allocation, same ledger rows as before
select pg_temp.asu('C');
select pg_temp.keep('va', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-A0001', now(), 'checked', 'staff')::text$q$, pg_temp.c('ea')));
select pg_temp.keep('vb', format($q$select public.finance_verify_evidence(%L, 130, 'S3-REF-B0001', now())::text$q$, pg_temp.c('eb')));
reset role;
select pg_temp.q('S3a verify: the answer has exactly the keys result, receipt_no, credited_to_wallet, state',
  $$select (select array_agg(kk order by kk) from jsonb_object_keys(v::jsonb) kk) = array['credited_to_wallet', 'receipt_no', 'result', 'state'] from t_ctx where k = 'va'$$);
select pg_temp.q('S3a verify: a fresh slip is fully paid in one step (result, receipt number, nothing credited, state 5)',
  $$select pg_temp.jb('va', 'result') = 'fully_paid' and pg_temp.jb('va', 'receipt_no') = pg_temp.rcol('ea', 'receipt_no') and pg_temp.jb('va', 'credited_to_wallet')::numeric = 0
       and pg_temp.jb('va', 'state') is not null and (pg_temp.jb('va', 'state')::jsonb ->> 'status_code')::int = 5 and (pg_temp.jb('va', 'state')::jsonb ->> 'paid')::numeric = 100$$);
select pg_temp.q('S3a verify: one receipt (bank transfer, the bank of the slip, the reference, 100, posted) and one active allocation of 100',
  $$select pg_temp.nrc('ea') = 1 and pg_temp.rcol('ea', 'method') = 'bank_transfer' and pg_temp.rcol('ea', 'bank_account_id') = pg_temp.c('scb') and pg_temp.rcol('ea', 'bank_trans_ref') = 'S3-REF-A0001'
       and pg_temp.rcol('ea', 'amount')::numeric = 100 and pg_temp.rcol('ea', 'status') = 'posted' and pg_temp.rcol('ea', 'needs_review') = 'false' and pg_temp.alloc('ea') = 100$$);
select pg_temp.q('S3a verify: the ledger row is BANK_RECEIPT, Dr bank (the slip''s bank) 100 / Cr receivable 100, exactly as before, and no cash row',
  $$select pg_temp.qplan('ea', 'BANK_RECEIPT') = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', 100, 'bank_account_id', pg_temp.c('scb')),
        jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 100)) and pg_temp.nq('ea', 'CASH_RECEIPT') = 0$$);
select pg_temp.q('S3a verify: the slip is verified by staff with the bank values; the one-step path leaves no confirm or post stamps',
  $$select pg_temp.ev('ea', 'status') = 'verified' and pg_temp.ev('ea', 'verified_via') = 'staff' and pg_temp.ev('ea', 'verified_amount')::numeric = 100 and pg_temp.ev('ea', 'bank_trans_ref') = 'S3-REF-A0001'
       and pg_temp.ev('ea', 'reviewed_by') = pg_temp.c('C') and pg_temp.ev('ea', 'review_note') = 'checked' and pg_temp.ev('ea', 'posted_at') is null and pg_temp.ev('ea', 'confirmed_by') is null$$);
select pg_temp.q('S3a verify: the audit log has evidence.verify and receipt.post with the verifier as the actor',
  $$select pg_temp.nev('ea', 'evidence.verify', 'C') = 1 and pg_temp.nevr('ea', 'receipt.post', 'C') = 1$$);
select pg_temp.q('S3a overpay: 130 against 100 is credited to the wallet (30), 100 is allocated, the answer says overpaid_credited',
  $$select pg_temp.jb('vb', 'result') = 'overpaid_credited' and pg_temp.jb('vb', 'credited_to_wallet')::numeric = 30 and pg_temp.alloc('eb') = 100 and pg_temp.rcol('eb', 'amount')::numeric = 130 and pg_temp.rcol('eb', 'credit_txn_id') is not null$$);
select pg_temp.q('S3a overpay: the wallet row is a DEPOSIT credit of 30; the ledger row is Dr bank 130 / Cr receivable 100 / Cr customer credit 30 (wallet), as before',
  $$select (select count(*) from public.finance_wallet_transactions t where t.id::text = pg_temp.rcol('eb', 'credit_txn_id') and t.txn_type = 'DEPOSIT' and t.direction = 'credit' and t.amount = 30) = 1
       and pg_temp.qplan('eb', 'BANK_RECEIPT') = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', 130, 'bank_account_id', pg_temp.c('scb')),
         jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 100), jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', 30, 'wallet', true))$$);
-- the refusals of the old function are the old refusals (all on one slip that stays submitted)
select pg_temp.asu('C');
select pg_temp.err_like('S3a verify: an amount of zero is refused', format($q$select public.finance_verify_evidence(%L, 0, 'S3-REF-X1', now())$q$, pg_temp.c('ex1')), '%amount shown by the bank%');
select pg_temp.err_like('S3a verify: three decimals are refused', format($q$select public.finance_verify_evidence(%L, 10.005, 'S3-REF-X1', now())$q$, pg_temp.c('ex1')), '%amount shown by the bank%');
select pg_temp.err_like('S3a verify: no reference is refused', format($q$select public.finance_verify_evidence(%L, 100, '  ', now())$q$, pg_temp.c('ex1')), '%reference is required%');
select pg_temp.err_like('S3a verify: no transfer time is refused', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-X1', null)$q$, pg_temp.c('ex1')), '%date and time are required%');
select pg_temp.err_like('S3a verify: an unknown source is refused', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-X1', now(), null, 'bogus')$q$, pg_temp.c('ex1')), '%Unknown verification source%');
select pg_temp.err_like('S3a verify: a reference that is already on a receipt is refused (23505)', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-A0001', now())$q$, pg_temp.c('ex1')), '%already recorded%');
select pg_temp.err_like('S3a verify: a transfer older than the invoice is refused', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-X1', now() - interval '5 days')$q$, pg_temp.c('ex1')), '%older than the invoice%');
select pg_temp.err_like('S3a verify: a slip that is already verified is refused', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-X1', now())$q$, pg_temp.c('ea')), '%already verified%');
select pg_temp.err_like('S3a verify: an unknown slip is refused', $q$select public.finance_verify_evidence(gen_random_uuid(), 100, 'S3-REF-X1', now())$q$, '%Evidence not found%');
select pg_temp.asu('D');
select pg_temp.err_like('S3a verify: a clerk may not verify', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-X1', now())$q$, pg_temp.c('ex1')), '%not allowed%');
select pg_temp.asu('A');
select pg_temp.err_like('S3a verify: a customer may not verify', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-X1', now())$q$, pg_temp.c('ex1')), '%not allowed%');
reset role;
select pg_temp.q('S3a verify: after all those refusals the slip is still submitted and has no receipt', $$select pg_temp.ev('ex1', 'status') = 'submitted' and pg_temp.nrc('ex1') = 0$$);
select pg_temp.q('S3a state: the keys of the old state are all still there, plus confirmed_pending and more_evidence_message (12 in all)',
  $$select (select array_agg(kk order by kk) from jsonb_object_keys(public.finance_invoice_state_raw(pg_temp.c('ib')::uuid)) kk)
       = array['amount', 'confirmed_pending', 'invoice_id', 'more_evidence_message', 'outstanding', 'paid', 'pending_evidence', 'refunded', 'request', 'status', 'status_code', 'unapplied']$$);
select pg_temp.q('S3a state: an invoice nobody has touched is unpaid (0) with nothing pending, nothing confirmed and no message',
  $$select pg_temp.sv('im', 'status_code')::int = 0 and pg_temp.sv('im', 'status') = 'unpaid' and pg_temp.sv('im', 'pending_evidence')::int = 0 and pg_temp.sv('im', 'confirmed_pending')::numeric = 0
       and pg_temp.sv('im', 'more_evidence_message') is null and public.finance_invoice_state_raw(pg_temp.c('im')::uuid) -> 'more_evidence_message' = 'null'::jsonb$$);

-- ---- S3m: finance_save_review_settings (manager only; whitelisted keys; ranges; one log row)
select pg_temp.asu('S');
select pg_temp.keep('sv1', $q$select public.finance_save_review_settings('{"ai_min_confidence": 0.9, "slip_window_before_min": 60, "slip_future_tolerance_min": 5}'::jsonb)::text$q$);
reset role;
select pg_temp.q('S3m settings: the answer lists the five settings, the three changed ones with their new values',
  $$select (select array_agg(kk order by kk) from jsonb_object_keys(v::jsonb) kk) = array['ai_min_confidence', 'ai_review_enabled', 'post_requires_manager', 'slip_future_tolerance_min', 'slip_window_before_min']
       and pg_temp.jb('sv1', 'ai_min_confidence')::numeric = 0.9 and pg_temp.jb('sv1', 'slip_window_before_min')::int = 60 and pg_temp.jb('sv1', 'slip_future_tolerance_min')::int = 5
       and pg_temp.jb('sv1', 'ai_review_enabled') = 'false' and pg_temp.jb('sv1', 'post_requires_manager') = 'false' from t_ctx where k = 'sv1'$$);
select pg_temp.q('S3m settings: they are stored, nothing else changed, and the manager is recorded as the editor',
  $$select ai_min_confidence = 0.90 and slip_window_before_min = 60 and slip_future_tolerance_min = 5 and not ai_review_enabled and not post_requires_manager and updated_by = pg_temp.c('S')::uuid from public.finance_settings$$);
select pg_temp.q('S3m settings: the save is in the audit log with the manager as the actor and the patch as the detail',
  $$select count(*) = 1 from public.finance_events where action = 'settings.review' and actor = pg_temp.c('S')::uuid and (detail ->> 'ai_min_confidence')::numeric = 0.9$$);
select pg_temp.asu('S');
select pg_temp.err_like('S3m settings: a confidence above 1 is refused', $q$select public.finance_save_review_settings('{"ai_min_confidence": 1.5}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a negative confidence is refused', $q$select public.finance_save_review_settings('{"ai_min_confidence": -0.1}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a negative window is refused', $q$select public.finance_save_review_settings('{"slip_window_before_min": -1}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a window above 1440 minutes is refused', $q$select public.finance_save_review_settings('{"slip_window_before_min": 1441}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a fractional number of minutes is refused', $q$select public.finance_save_review_settings('{"slip_window_before_min": 12.5}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a future tolerance above 1440 is refused', $q$select public.finance_save_review_settings('{"slip_future_tolerance_min": 1441}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a switch must be true or false (a string is refused)', $q$select public.finance_save_review_settings('{"ai_review_enabled": "yes"}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a switch must be true or false (a number is refused)', $q$select public.finance_save_review_settings('{"post_requires_manager": 1}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: a number must be a number (a string is refused)', $q$select public.finance_save_review_settings('{"ai_min_confidence": "high"}')$q$, '%INVALID_SETTING%');
select pg_temp.err_like('S3m settings: only the five settings can be changed (an unknown key is refused)', $q$select public.finance_save_review_settings('{"min_deposit": 5}')$q$, '%UNKNOWN_SETTING%');
select pg_temp.err_like('S3m settings: one bad key refuses the whole patch', $q$select public.finance_save_review_settings('{"ai_min_confidence": 0.5, "bogus": 1}')$q$, '%UNKNOWN_SETTING%');
select pg_temp.err_like('S3m settings: an empty patch is refused', $q$select public.finance_save_review_settings('{}')$q$, '%Nothing to save%');
select pg_temp.err_like('S3m settings: a patch that is not an object is refused', $q$select public.finance_save_review_settings('[1]')$q$, '%Nothing to save%');
select pg_temp.err_like('S3m settings: no patch is refused', $q$select public.finance_save_review_settings(null)$q$, '%Nothing to save%');
select pg_temp.asu('C');
select pg_temp.err_like('S3m settings: a verifier may not change them', $q$select public.finance_save_review_settings('{"post_requires_manager": true}')$q$, '%not allowed%');
select pg_temp.asu('D');
select pg_temp.err_like('S3m settings: a clerk may not change them', $q$select public.finance_save_review_settings('{"post_requires_manager": true}')$q$, '%not allowed%');
select pg_temp.asu('A');
select pg_temp.err_like('S3m settings: a customer may not change them', $q$select public.finance_save_review_settings('{"post_requires_manager": true}')$q$, '%not allowed%');
reset role; set local role anon;
select pg_temp.err_like('S3m settings: a signed-out visitor may not call it', $q$select public.finance_save_review_settings('{"post_requires_manager": true}')$q$, '%permission denied%');
reset role;
select pg_temp.q('S3m settings: after all the refusals the stored values are exactly as saved (a refused patch changes nothing)',
  $$select ai_min_confidence = 0.90 and slip_window_before_min = 60 and slip_future_tolerance_min = 5 and not ai_review_enabled and not post_requires_manager from public.finance_settings$$);
select pg_temp.asu('S');
select pg_temp.runs_ok('S3m settings: the manager puts the three values back to their defaults', $q$select public.finance_save_review_settings('{"ai_min_confidence": 0.8, "slip_window_before_min": 120, "slip_future_tolerance_min": 10}')$q$);
reset role;
select pg_temp.q('S3m settings: back to the defaults', $$select ai_min_confidence = 0.80 and slip_window_before_min = 120 and slip_future_tolerance_min = 10 from public.finance_settings$$);

-- ---- S3b: Confirm records what the bank shows and touches no money
create or replace function pg_temp.eid(p_key text, p_from text) returns void language plpgsql as $$
begin perform pg_temp.keep(p_key, format($q$select (v::jsonb) ->> 'evidence_id' from t_ctx where k = %L$q$, p_from)); end $$;
select pg_temp.asu('A');
select pg_temp.mkslip('ec', 'ic', 300); select pg_temp.mkslip('ed', 'id', 150); select pg_temp.mkslip('ed2', 'id', 50); select pg_temp.mkslip('el', 'il', 50);
reset role;
select pg_temp.asu('C');
select pg_temp.conf('cc', 'ec', 300, 'S3-REF-C0001');
reset role;
select pg_temp.q('S3b confirm: the answer is status confirmed, the slip id and the amount',
  $$select pg_temp.jb('cc', 'status') = 'confirmed' and pg_temp.jb('cc', 'evidence_id') = pg_temp.c('ec') and pg_temp.jb('cc', 'amount')::numeric = 300$$);
select pg_temp.q('S3b confirm: in the books nothing is paid (paid 0, outstanding 300) but the invoice shows as pending verification (3) with 300 confirmed',
  $$select pg_temp.sv('ic', 'paid')::numeric = 0 and pg_temp.sv('ic', 'outstanding')::numeric = 300 and pg_temp.sv('ic', 'status_code')::int = 3 and pg_temp.sv('ic', 'status') = 'pending_verification'
       and pg_temp.sv('ic', 'confirmed_pending')::numeric = 300 and pg_temp.sv('ic', 'pending_evidence')::int = 1 and pg_temp.sv('ic', 'more_evidence_message') is null$$);
select pg_temp.q('S3b confirm: no receipt and no allocation exist for the invoice',
  $$select pg_temp.nrc('ec') = 0 and not exists (select 1 from public.finance_receipts where invoice_id = pg_temp.c('ic')::uuid) and not exists (select 1 from public.finance_allocations where invoice_id = pg_temp.c('ic')::uuid)$$);
select pg_temp.q('S3b confirm: the slip holds the confirmed values, who and when; nothing is verified, reviewed or posted yet',
  $$select pg_temp.ev('ec', 'status') = 'confirmed' and pg_temp.ev('ec', 'confirmed_by') = pg_temp.c('C') and pg_temp.ev('ec', 'confirmed_amount')::numeric = 300 and pg_temp.ev('ec', 'confirmed_bank_ref') = 'S3-REF-C0001'
       and pg_temp.ev('ec', 'confirmed_at') is not null and pg_temp.ev('ec', 'confirmed_transfer_at') is not null and pg_temp.ev('ec', 'confirm_note') = 'S3 test'
       and pg_temp.ev('ec', 'verified_amount') is null and pg_temp.ev('ec', 'reviewed_by') is null and pg_temp.ev('ec', 'posted_at') is null and pg_temp.ev('ec', 'bank_trans_ref') is null$$);
select pg_temp.q('S3b confirm: the audit log has evidence.confirm with the verifier as the actor', $$select pg_temp.nev('ec', 'evidence.confirm', 'C') = 1$$);
-- the same input rules as verify, and the reference must be new
select pg_temp.asu('C');
select pg_temp.err_like('S3b confirm: an amount of zero is refused', format($q$select public.finance_confirm_evidence(%L, 0, 'S3-REF-D0001', now())$q$, pg_temp.c('ed')), '%amount shown by the bank%');
select pg_temp.err_like('S3b confirm: three decimals are refused', format($q$select public.finance_confirm_evidence(%L, 10.005, 'S3-REF-D0001', now())$q$, pg_temp.c('ed')), '%amount shown by the bank%');
select pg_temp.err_like('S3b confirm: no amount is refused', format($q$select public.finance_confirm_evidence(%L, null, 'S3-REF-D0001', now())$q$, pg_temp.c('ed')), '%amount shown by the bank%');
select pg_temp.err_like('S3b confirm: a blank reference is refused', format($q$select public.finance_confirm_evidence(%L, 150, '  ', now())$q$, pg_temp.c('ed')), '%reference is required%');
select pg_temp.err_like('S3b confirm: no reference is refused', format($q$select public.finance_confirm_evidence(%L, 150, null, now())$q$, pg_temp.c('ed')), '%reference is required%');
select pg_temp.err_like('S3b confirm: a reference with fewer than 4 letters or digits is refused', format($q$select public.finance_confirm_evidence(%L, 150, 'a-b', now())$q$, pg_temp.c('ed')), '%4 to 80%');
select pg_temp.err_like('S3b confirm: no transfer time is refused', format($q$select public.finance_confirm_evidence(%L, 150, 'S3-REF-D0001', null)$q$, pg_temp.c('ed')), '%date and time are required%');
select pg_temp.err_like('S3b confirm: a transfer older than the invoice is refused', format($q$select public.finance_confirm_evidence(%L, 150, 'S3-REF-D0001', now() - interval '5 days')$q$, pg_temp.c('ed')), '%older than the invoice%');
select pg_temp.err_like('S3b confirm: a note of more than 500 characters is refused', format($q$select public.finance_confirm_evidence(%L, 150, 'S3-REF-D0001', now(), repeat('x', 501))$q$, pg_temp.c('ed')), '%too long%');
select pg_temp.err_like('S3b confirm: a reference that is on a receipt is refused (23505)', format($q$select public.finance_confirm_evidence(%L, 150, 'S3-REF-A0001', now())$q$, pg_temp.c('ed')), '%already recorded%');
select pg_temp.err_state('S3b confirm: ...with SQLSTATE 23505, which is how a client tells a reused reference from other refusals', format($q$select public.finance_confirm_evidence(%L, 150, 'S3-REF-A0001', now())$q$, pg_temp.c('ed')), '23505');
select pg_temp.err_like('S3b confirm: ...even written differently (case, dashes, spaces)', format($q$select public.finance_confirm_evidence(%L, 150, 's3 ref-a0001', now())$q$, pg_temp.c('ed')), '%already recorded%');
select pg_temp.err_like('S3b confirm: a reference that is on a verified wallet deposit is refused', format($q$select public.finance_confirm_evidence(%L, 150, 'S3WDREF0001', now())$q$, pg_temp.c('ed')), '%already recorded%');
select pg_temp.err_like('S3b confirm: a verified wallet deposit is found when the reference is written differently too', format($q$select public.finance_confirm_evidence(%L, 150, 's3wd-ref 0001', now())$q$, pg_temp.c('ed')), '%already recorded%');
reset role;
-- a receipt whose own slip holds no reference (made directly, a reversed one: it still holds its bank transaction), to look the receipt source up on its own
select pg_temp.keep('esyn', format($q$with ins as (insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status)
  values (%L, %L, 'S3/syn-receipt', %L, 'image/png', 10, 'rejected') returning id) select id::text from ins$q$, pg_temp.c('ix'), pg_temp.c('cust'), md5('s3-syn') || md5('s3b-syn')));
select pg_temp.runs_ok('S3b setup: a reversed receipt that carries a bank reference (its slip carries none)', format($q$insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, method, bank_trans_ref, received_at, status)
  values ('RC-S3-SYN', %L, %L, %L, 10, 'bank_transfer', 'S3SYNREC-0001', now(), 'reversed')$q$, pg_temp.c('cust'), pg_temp.c('ix'), pg_temp.c('esyn')));
select pg_temp.asu('C');
select pg_temp.err_like('S3b confirm: a receipt is found when the reference is written differently (case, dashes, spaces)', format($q$select public.finance_confirm_evidence(%L, 150, 's3synrec 0001', now())$q$, pg_temp.c('ed')), '%already recorded%');
select pg_temp.err_like('S3b record: the same receipt reference written differently is refused by Record payment too', 'select ' || pg_temp.recx('id', 'transfer', '10', 's3synrec-0001', 'x', 'now()', 'scb'), '%already recorded%');
select pg_temp.err_like('S3b confirm: a reference that is on another CONFIRMED slip is refused', format($q$select public.finance_confirm_evidence(%L, 150, 'S3-REF-C0001', now())$q$, pg_temp.c('ed')), '%already recorded%');
select pg_temp.err_like('S3b confirm: an unknown slip is refused', $q$select public.finance_confirm_evidence(gen_random_uuid(), 150, 'S3-REF-D0001', now())$q$, '%Evidence not found%');
select pg_temp.asu('S');
select pg_temp.runs_ok('S3b setup: invoice il is cancelled (a slip is waiting on it)', format($q$select public.finance_cancel_invoice(%L, 'S3 cancel')$q$, pg_temp.c('il')));
select pg_temp.asu('C');
select pg_temp.err_like('S3b confirm: a slip of a cancelled invoice cannot be confirmed', format($q$select public.finance_confirm_evidence(%L, 50, 'S3-REF-L0001', now())$q$, pg_temp.c('el')), '%invoice is cancelled%');
reset role;
select pg_temp.q('S3b confirm: all those refusals left both slips submitted', $$select pg_temp.ev('ed', 'status') = 'submitted' and pg_temp.ev('el', 'status') = 'submitted' and pg_temp.ev('ed', 'confirmed_by') is null$$);
select pg_temp.asu('C');
select pg_temp.conf('cd', 'ed', 150, 'S3-REF-D0001');
select pg_temp.err_like('S3k confirm: a second Confirm of the same slip is refused', format($q$select public.finance_confirm_evidence(%L, 150, 'S3-REF-D0009', now())$q$, pg_temp.c('ed')), '%already confirmed%');
select pg_temp.err_like('S3b confirm: the reference of a confirmed slip cannot be used by another slip, written differently either', format($q$select public.finance_confirm_evidence(%L, 50, 's3ref d0001', now())$q$, pg_temp.c('ed2')), '%already recorded%');
select pg_temp.conf('cd2', 'ed2', 50, 'S3-REF-D0002');
reset role;
select pg_temp.q('S3b confirm: two slips of 150 and 50 are confirmed on a 200 invoice (pending verification, 200 confirmed, 2 pending, nothing paid)',
  $$select pg_temp.sv('id', 'status_code')::int = 3 and pg_temp.sv('id', 'confirmed_pending')::numeric = 200 and pg_temp.sv('id', 'pending_evidence')::int = 2 and pg_temp.sv('id', 'paid')::numeric = 0$$);

-- ---- S3c: Post creates the receipt, the allocation and the ledger row, once
select pg_temp.asu('C');
select pg_temp.post('pc', 'ec');
select pg_temp.post('pc2', 'ec');
reset role;
select pg_temp.q('S3c post: the answer is the core answer (fully paid, the receipt number, nothing credited, state 5) and replay false',
  $$select pg_temp.jb('pc', 'result') = 'fully_paid' and pg_temp.jb('pc', 'receipt_no') = pg_temp.rcol('ec', 'receipt_no') and pg_temp.jb('pc', 'credited_to_wallet')::numeric = 0
       and pg_temp.jb('pc', 'replay') = 'false' and (pg_temp.jb('pc', 'state')::jsonb ->> 'status_code')::int = 5$$);
select pg_temp.q('S3c post: exactly one receipt (bank transfer, the slip''s bank, the CONFIRMED reference, the confirmed amount) and one allocation of 300',
  $$select pg_temp.nrc('ec') = 1 and pg_temp.rcol('ec', 'method') = 'bank_transfer' and pg_temp.rcol('ec', 'bank_account_id') = pg_temp.c('scb') and pg_temp.rcol('ec', 'bank_trans_ref') = 'S3-REF-C0001'
       and pg_temp.rcol('ec', 'amount')::numeric = 300 and pg_temp.rcol('ec', 'status') = 'posted' and pg_temp.alloc('ec') = 300
       and pg_temp.rcol('ec', 'received_at') = pg_temp.ev('ec', 'confirmed_transfer_at')$$);
select pg_temp.q('S3c post: exactly one BANK_RECEIPT ledger row, Dr bank 300 / Cr receivable 300',
  $$select pg_temp.nq('ec', 'BANK_RECEIPT') = 1 and pg_temp.qplan('ec', 'BANK_RECEIPT') = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', 300, 'bank_account_id', pg_temp.c('scb')),
        jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 300))$$);
select pg_temp.q('S3c post: the invoice is fully paid (5): paid 300, outstanding 0, nothing confirmed or pending any more',
  $$select pg_temp.sv('ic', 'status_code')::int = 5 and pg_temp.sv('ic', 'status') = 'fully_paid' and pg_temp.sv('ic', 'paid')::numeric = 300 and pg_temp.sv('ic', 'outstanding')::numeric = 0
       and pg_temp.sv('ic', 'confirmed_pending')::numeric = 0 and pg_temp.sv('ic', 'pending_evidence')::int = 0$$);
select pg_temp.q('S3c post: the slip is verified (= posted) with who and when, the bank values, and the confirmation is kept on the row',
  $$select pg_temp.ev('ec', 'status') = 'verified' and pg_temp.ev('ec', 'posted_by') = pg_temp.c('C') and pg_temp.ev('ec', 'posted_at') is not null and pg_temp.ev('ec', 'verified_amount')::numeric = 300
       and pg_temp.ev('ec', 'verified_via') = 'staff' and pg_temp.ev('ec', 'bank_trans_ref') = 'S3-REF-C0001' and pg_temp.ev('ec', 'reviewed_by') = pg_temp.c('C')
       and pg_temp.ev('ec', 'confirmed_by') = pg_temp.c('C') and pg_temp.ev('ec', 'confirmed_amount')::numeric = 300$$);
select pg_temp.q('S3l post: the audit log has evidence.post, evidence.verify (the core) and receipt.post, all by the verifier',
  $$select pg_temp.nev('ec', 'evidence.post', 'C') = 1 and pg_temp.nev('ec', 'evidence.verify', 'C') = 1 and pg_temp.nevr('ec', 'receipt.post', 'C') = 1$$);
select pg_temp.q('S3d post: a second Post says replay true with the same receipt and creates nothing (one receipt, one allocation, one ledger row, one post event)',
  $$select pg_temp.jb('pc2', 'replay') = 'true' and pg_temp.jb('pc2', 'receipt_no') = pg_temp.rcol('ec', 'receipt_no') and pg_temp.jb('pc2', 'result') = 'fully_paid'
       and pg_temp.nrc('ec') = 1 and pg_temp.alloc('ec') = 300 and pg_temp.nq('ec', 'BANK_RECEIPT') = 1 and pg_temp.nev('ec', 'evidence.post') = 1 and pg_temp.nevr('ec', 'receipt.post') = 1$$);
select pg_temp.asu('C');
select pg_temp.err_like('S3d post: a slip that was never confirmed cannot be posted (NOT_CONFIRMED)', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('el')), '%NOT_CONFIRMED%');
select pg_temp.err_like('S3d post: an unknown slip is refused', $q$select public.finance_post_evidence(gen_random_uuid())$q$, '%Evidence not found%');
reset role;
select pg_temp.q('S3d post: the refused post left the slip submitted with no receipt', $$select pg_temp.ev('el', 'status') = 'submitted' and pg_temp.nrc('el') = 0$$);
-- the part of a post above what is owed is credited to the wallet, exactly as the one-step verify does it (the invoice ic is already paid in full)
select pg_temp.asu('A'); select pg_temp.mkslip('ec2', 'ic', 300); reset role;
select pg_temp.asu('C'); select pg_temp.conf('cc2', 'ec2', 300, 'S3-REF-C0002'); select pg_temp.post('pc3', 'ec2'); reset role;
select pg_temp.q('S3c post: money above what is owed is credited to the wallet (overpaid_credited, 300), nothing is allocated',
  $$select pg_temp.jb('pc3', 'result') = 'overpaid_credited' and pg_temp.jb('pc3', 'credited_to_wallet')::numeric = 300 and pg_temp.alloc('ec2') = 0 and pg_temp.rcol('ec2', 'credit_txn_id') is not null and pg_temp.rcol('ec2', 'needs_review') = 'false'$$);
select pg_temp.q('S3c post: ...and the ledger row is Dr bank 300 / Cr customer credit 300 (wallet), with no receivable line',
  $$select pg_temp.qplan('ec2', 'BANK_RECEIPT') = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', 300, 'bank_account_id', pg_temp.c('scb')),
        jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', 300, 'wallet', true))$$);
-- the two slips of invoice id are posted: 150 (partly paid) then 50 (the rest)
select pg_temp.asu('C'); select pg_temp.post('pd', 'ed'); select pg_temp.post('pd2', 'ed2'); reset role;
select pg_temp.q('S3c post: 150 then 50 on a 200 invoice: partially_paid, then fully_paid; the invoice is fully paid (5)',
  $$select pg_temp.jb('pd', 'result') = 'partially_paid' and pg_temp.jb('pd2', 'result') = 'fully_paid' and pg_temp.sv('id', 'status_code')::int = 5 and pg_temp.sv('id', 'paid')::numeric = 200$$);

-- ---- S3e: post_requires_manager: a verifier can Confirm but not Post, and not use the one-step verify; a manager can do both
select pg_temp.asu('A'); select pg_temp.mkslip('ee1', 'ie', 100); select pg_temp.mkslip('ee2', 'ie', 50); select pg_temp.mkslip('ee3', 'ie', 150); select pg_temp.mkslip('ee4', 'ie2', 100); reset role;
select pg_temp.asu('S');
select pg_temp.runs_ok('S3e setup: the manager switches post_requires_manager on', $q$select public.finance_save_review_settings('{"post_requires_manager": true}')$q$);
reset role;
select pg_temp.q('S3e setup: the switch is on', $$select post_requires_manager from public.finance_settings$$);
select pg_temp.asu('C');
select pg_temp.conf('ce1', 'ee1', 100, 'S3-REF-E0001');
select pg_temp.err_like('S3e a verifier cannot Post', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('ee1')), '%not allowed%');
select pg_temp.err_like('S3e a verifier cannot use the one-step verify either', format($q$select public.finance_verify_evidence(%L, 50, 'S3-REF-E0002', now())$q$, pg_temp.c('ee2')), '%not allowed%');
reset role;
select pg_temp.q('S3e a verifier can Confirm (the slip is confirmed) and the refused calls changed nothing',
  $$select pg_temp.jb('ce1', 'status') = 'confirmed' and pg_temp.ev('ee1', 'status') = 'confirmed' and pg_temp.nrc('ee1') = 0 and pg_temp.ev('ee2', 'status') = 'submitted' and pg_temp.nrc('ee2') = 0$$);
select pg_temp.asu('S');
select pg_temp.post('pe1', 'ee1');
select pg_temp.keep('ve3', format($q$select public.finance_verify_evidence(%L, 150, 'S3-REF-E0003', now())::text$q$, pg_temp.c('ee3')));
select pg_temp.conf('ce2', 'ee2', 50, 'S3-REF-E0002');
select pg_temp.post('pe2', 'ee2');
reset role;
select pg_temp.q('S3e a manager can Post (100 of 300: partially_paid) and use the one-step verify (150: partially_paid) and Confirm and Post (50: fully_paid)',
  $$select pg_temp.jb('pe1', 'result') = 'partially_paid' and pg_temp.jb('ve3', 'result') = 'partially_paid' and pg_temp.jb('pe2', 'result') = 'fully_paid'
       and pg_temp.ev('ee1', 'posted_by') = pg_temp.c('S') and pg_temp.ev('ee2', 'confirmed_by') = pg_temp.c('S') and pg_temp.ev('ee2', 'posted_by') = pg_temp.c('S') and pg_temp.sv('ie', 'status_code')::int = 5$$);
select pg_temp.asu('S');
select pg_temp.runs_ok('S3e setup: the manager switches it off again', $q$select public.finance_save_review_settings('{"post_requires_manager": false}')$q$);
select pg_temp.asu('C');
select pg_temp.conf('ce4', 'ee4', 100, 'S3-REF-E0004');
select pg_temp.post('pe4', 'ee4');
reset role;
select pg_temp.q('S3e with the switch off a verifier can Post again (the same as before)', $$select not (select post_requires_manager from public.finance_settings) and pg_temp.jb('pe4', 'result') = 'fully_paid' and pg_temp.ev('ee4', 'posted_by') = pg_temp.c('C')$$);

-- ---- S3f: who may not: a clerk, the customer, another customer, a signed-out visitor
select pg_temp.asu('A'); select pg_temp.mkslip('ef1', 'if', 100); select pg_temp.mkslip('ef2', 'if', 60); reset role;
select pg_temp.asu('C'); select pg_temp.conf('cf2', 'ef2', 60, 'S3-REF-F0002'); reset role;
create or replace function pg_temp.deny(p_who text) returns void language plpgsql as $$
begin
  perform pg_temp.err_like('S3f ' || p_who || ': cannot confirm', format($q$select public.finance_confirm_evidence(%L, 100, 'S3-REF-F0001', now())$q$, pg_temp.c('ef1')), '%not allowed%');
  perform pg_temp.err_like('S3f ' || p_who || ': cannot post', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('ef2')), '%not allowed%');
  perform pg_temp.err_like('S3f ' || p_who || ': cannot reject', format($q$select public.finance_reject_evidence(%L, 'no')$q$, pg_temp.c('ef1')), '%not allowed%');
  perform pg_temp.err_like('S3f ' || p_who || ': cannot ask for more evidence', format($q$select public.finance_request_more_evidence(%L, 'please send more')$q$, pg_temp.c('ef1')), '%not allowed%');
  perform pg_temp.err_like('S3f ' || p_who || ': cannot use the one-step verify', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-F0001', now())$q$, pg_temp.c('ef1')), '%not allowed%');
  perform pg_temp.err_like('S3f ' || p_who || ': cannot record a payment', 'select ' || pg_temp.recx('if', 'cash', '10', null, 'cash at the counter'), '%not allowed%');
  perform pg_temp.err_like('S3f ' || p_who || ': cannot change the review settings', $q$select public.finance_save_review_settings('{"ai_min_confidence": 0.5}')$q$, '%not allowed%');
end $$;
select pg_temp.asu('D'); select pg_temp.deny('a clerk');
select pg_temp.asu('A'); select pg_temp.deny('the customer');
select pg_temp.asu('B'); select pg_temp.deny('another customer');
reset role; set local role anon;
select pg_temp.err_like('S3f a signed-out visitor cannot confirm', format($q$select public.finance_confirm_evidence(%L, 100, 'S3-REF-F0001', now())$q$, pg_temp.c('ef1')), '%permission denied%');
select pg_temp.err_like('S3f a signed-out visitor cannot post', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('ef2')), '%permission denied%');
select pg_temp.err_like('S3f a signed-out visitor cannot ask for more evidence', format($q$select public.finance_request_more_evidence(%L, 'please send more')$q$, pg_temp.c('ef1')), '%permission denied%');
select pg_temp.err_like('S3f a signed-out visitor cannot record a payment', 'select ' || pg_temp.recx('if', 'cash', '10', null, 'cash at the counter'), '%permission denied%');
reset role;
select pg_temp.q('S3f after every refusal the invoice holds the two slips it had (one submitted, one confirmed) and no receipt',
  $$select pg_temp.nrows('if') = 2 and pg_temp.ev('ef1', 'status') = 'submitted' and pg_temp.ev('ef2', 'status') = 'confirmed' and not exists (select 1 from public.finance_receipts where invoice_id = pg_temp.c('if')::uuid)$$);

-- ---- S3g: a payment in parts, finished with cash recorded at the back office
select pg_temp.asu('A'); select pg_temp.mkslip('eg1', 'ig', 200); reset role;
select pg_temp.asu('C'); select pg_temp.conf('cg1', 'eg1', 200, 'S3-REF-G0001'); select pg_temp.post('pg1', 'eg1'); reset role;
select pg_temp.q('S3g partial: 200 of 350 is confirmed and posted: partially paid (4), outstanding 150',
  $$select pg_temp.jb('pg1', 'result') = 'partially_paid' and pg_temp.sv('ig', 'status_code')::int = 4 and pg_temp.sv('ig', 'status') = 'partially_paid' and pg_temp.sv('ig', 'paid')::numeric = 200
       and pg_temp.sv('ig', 'outstanding')::numeric = 150 and pg_temp.alloc('eg1') = 200$$);
select pg_temp.asu('C');
select pg_temp.err_like('S3g record: 151 against 150 outstanding is refused (EXCEEDS_OUTSTANDING)', 'select ' || pg_temp.recx('ig', 'cash', '151', null, 'cash at the counter'), '%EXCEEDS_OUTSTANDING%');
select pg_temp.err_like('S3g record: cash without a note is refused (NOTE_REQUIRED)', 'select ' || pg_temp.recx('ig', 'cash', '150', null, null), '%NOTE_REQUIRED%');
select pg_temp.err_like('S3g record: cash with a 2-character note is refused (NOTE_REQUIRED)', 'select ' || pg_temp.recx('ig', 'cash', '150', null, 'ab'), '%NOTE_REQUIRED%');
select pg_temp.err_like('S3g record: cash with a blank note is refused (NOTE_REQUIRED)', 'select ' || pg_temp.recx('ig', 'cash', '150', null, '    '), '%NOTE_REQUIRED%');
select pg_temp.err_like('S3g record: a transfer without a reference is refused (REFERENCE_REQUIRED)', 'select ' || pg_temp.recx('ig', 'transfer', '150', null, 'bank line', 'now()', 'scb'), '%REFERENCE_REQUIRED%');
select pg_temp.err_like('S3g record: a transfer with a 3-character reference is refused (REFERENCE_REQUIRED)', 'select ' || pg_temp.recx('ig', 'transfer', '150', 'abc', 'bank line', 'now()', 'scb'), '%REFERENCE_REQUIRED%');
select pg_temp.err_like('S3g record: a reference of 81 characters is refused (REFERENCE_REQUIRED)', 'select ' || pg_temp.recx('ig', 'transfer', '150', repeat('R', 81), 'bank line', 'now()', 'scb'), '%REFERENCE_REQUIRED%');
reset role;
select pg_temp.q('S3g record: none of those refusals created a payment row (the invoice still has only its one slip)', $$select pg_temp.nrows('ig') = 1$$);
select pg_temp.asu('C');
select pg_temp.rec('rg', 'ig', 'cash', 150, null, 'cash at the counter');
select pg_temp.eid('erg', 'rg');
reset role;
select pg_temp.q('S3g record: the answer is the new slip id and status confirmed', $$select pg_temp.c('erg') is not null and pg_temp.jb('rg', 'status') = 'confirmed' and (select count(*) from jsonb_object_keys(v::jsonb)) = 2 from t_ctx where k = 'rg'$$);
select pg_temp.q('S3g record: the row is a staff entry paid in cash, already confirmed by the person who typed it, with no file, no reference and no bank',
  $$select pg_temp.ev('erg', 'source') = 'staff_entry' and pg_temp.ev('erg', 'method') = 'cash' and pg_temp.ev('erg', 'status') = 'confirmed' and pg_temp.ev('erg', 'recorded_by') = pg_temp.c('C')
       and pg_temp.ev('erg', 'confirmed_by') = pg_temp.c('C') and pg_temp.ev('erg', 'confirmed_amount')::numeric = 150 and pg_temp.ev('erg', 'claimed_amount')::numeric = 150
       and pg_temp.ev('erg', 'confirmed_bank_ref') is null and pg_temp.ev('erg', 'file_path') is null and pg_temp.ev('erg', 'bank_account_id') is null and pg_temp.ev('erg', 'confirm_note') = 'cash at the counter'
       and pg_temp.ev('erg', 'confirmed_at') is not null and pg_temp.ev('erg', 'confirmed_transfer_at') is not null and pg_temp.ev('erg', 'customer_id') = pg_temp.c('cust')$$);
select pg_temp.q('S3l record: the audit log has evidence.record with the verifier as the actor', $$select pg_temp.nev('erg', 'evidence.record', 'C') = 1$$);
select pg_temp.q('S3g record: the 150 is confirmed but not posted: nothing more is paid (200), the invoice shows pending verification (3) with 150 confirmed; no receipt yet',
  $$select pg_temp.sv('ig', 'status_code')::int = 3 and pg_temp.sv('ig', 'paid')::numeric = 200 and pg_temp.sv('ig', 'outstanding')::numeric = 150 and pg_temp.sv('ig', 'confirmed_pending')::numeric = 150
       and pg_temp.sv('ig', 'pending_evidence')::int = 1 and pg_temp.nrc('erg') = 0$$);
select pg_temp.asu('C');
select pg_temp.err_like('S3g record: the 150 that is confirmed but not posted counts: even 1 more is refused (EXCEEDS_OUTSTANDING)', 'select ' || pg_temp.recx('ig', 'cash', '1', null, 'cash at the counter'), '%EXCEEDS_OUTSTANDING%');
select pg_temp.post('pg2', 'erg');
select pg_temp.post('pg3', 'erg');
reset role;
select pg_temp.q('S3g post cash: the invoice is fully paid (5), the answer says fully_paid', $$select pg_temp.jb('pg2', 'result') = 'fully_paid' and pg_temp.jb('pg2', 'replay') = 'false' and pg_temp.sv('ig', 'status_code')::int = 5 and pg_temp.sv('ig', 'paid')::numeric = 350$$);
select pg_temp.q('S3g post cash: the receipt is a CASH receipt: no bank, no reference, 150, posted, with one allocation of 150',
  $$select pg_temp.nrc('erg') = 1 and pg_temp.rcol('erg', 'method') = 'cash' and pg_temp.rcol('erg', 'bank_account_id') is null and pg_temp.rcol('erg', 'bank_trans_ref') is null
       and pg_temp.rcol('erg', 'amount')::numeric = 150 and pg_temp.rcol('erg', 'status') = 'posted' and pg_temp.alloc('erg') = 150 and pg_temp.rcol('erg', 'needs_review') = 'false'$$);
select pg_temp.q('S3g post cash: the ledger row is CASH_RECEIPT, Dr cash 150 / Cr receivable 150, and there is no BANK_RECEIPT for it',
  $$select pg_temp.nq('erg', 'CASH_RECEIPT') = 1 and pg_temp.nq('erg', 'BANK_RECEIPT') = 0
       and pg_temp.qplan('erg', 'CASH_RECEIPT') = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'cash', 'amount', 150), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 150))$$);
select pg_temp.q('S3g post cash: the slip is verified (posted) by the verifier; its bank reference stays empty',
  $$select pg_temp.ev('erg', 'status') = 'verified' and pg_temp.ev('erg', 'posted_by') = pg_temp.c('C') and pg_temp.ev('erg', 'posted_at') is not null and pg_temp.ev('erg', 'verified_amount')::numeric = 150
       and pg_temp.ev('erg', 'bank_trans_ref') is null and pg_temp.ev('erg', 'confirmed_by') = pg_temp.c('C')$$);
select pg_temp.q('S3g post cash: a second Post is a replay and adds no receipt and no ledger row',
  $$select pg_temp.jb('pg3', 'replay') = 'true' and pg_temp.jb('pg3', 'receipt_no') = pg_temp.rcol('erg', 'receipt_no') and pg_temp.nrc('erg') = 1 and pg_temp.nq('erg', 'CASH_RECEIPT') = 1$$);
select pg_temp.asu('C');
select pg_temp.err_like('S3g record: once the invoice is fully paid nothing more can be recorded (EXCEEDS_OUTSTANDING)', 'select ' || pg_temp.recx('ig', 'cash', '1', null, 'cash at the counter'), '%EXCEEDS_OUTSTANDING%');
reset role;

-- ---- S3g2: confirmed-but-unposted payments of every kind reduce what can still be recorded; a transfer can be recorded too; a cash reference is ignored
select pg_temp.asu('C');
select pg_temp.rec('rh1', 'ih', 'cash', 100, 'IGNORED-REF-1', 'cash drawer');
select pg_temp.eid('erh1', 'rh1');
select pg_temp.err_like('S3g2 record: 201 in cash against 200 that can still be added is refused', 'select ' || pg_temp.recx('ih', 'cash', '201', null, 'cash drawer'), '%EXCEEDS_OUTSTANDING%');
select pg_temp.err_like('S3g2 record: 201 by transfer against 200 that can still be added is refused', 'select ' || pg_temp.recx('ih', 'transfer', '201', 'S3-REF-H0002', 'bank line', 'now()', 'scb'), '%EXCEEDS_OUTSTANDING%');
select pg_temp.rec('rh2', 'ih', 'transfer', 200, 'S3-REF-H0001', 'bank statement line 7', 'scb');
select pg_temp.eid('erh2', 'rh2');
select pg_temp.err_like('S3g2 record: with 100 cash and 200 transfer confirmed the invoice has nothing left to add', 'select ' || pg_temp.recx('ih', 'cash', '1', null, 'cash drawer'), '%EXCEEDS_OUTSTANDING%');
reset role;
select pg_temp.q('S3g2 record: a cash entry ignores the reference it was given (nothing stored)', $$select pg_temp.ev('erh1', 'confirmed_bank_ref') is null and pg_temp.ev('erh1', 'claimed_ref') is null and pg_temp.ev('erh1', 'bank_trans_ref') is null$$);
select pg_temp.q('S3g2 record: the transfer entry holds its reference, the chosen bank, the amount, and no file',
  $$select pg_temp.ev('erh2', 'source') = 'staff_entry' and pg_temp.ev('erh2', 'method') = 'transfer' and pg_temp.ev('erh2', 'status') = 'confirmed' and pg_temp.ev('erh2', 'confirmed_bank_ref') = 'S3-REF-H0001'
       and pg_temp.ev('erh2', 'bank_account_id') = pg_temp.c('scb') and pg_temp.ev('erh2', 'confirmed_amount')::numeric = 200 and pg_temp.ev('erh2', 'file_path') is null and pg_temp.ev('erh2', 'recorded_by') = pg_temp.c('C')$$);
select pg_temp.q('S3g2 record: 300 is confirmed on the 300 invoice and nothing is posted yet (pending verification, 300 confirmed, 0 paid)',
  $$select pg_temp.sv('ih', 'status_code')::int = 3 and pg_temp.sv('ih', 'confirmed_pending')::numeric = 300 and pg_temp.sv('ih', 'paid')::numeric = 0 and pg_temp.sv('ih', 'pending_evidence')::int = 2$$);
select pg_temp.asu('C'); select pg_temp.post('ph2', 'erh2'); select pg_temp.post('ph1', 'erh1'); reset role;
select pg_temp.q('S3g2 post: the transfer posts as a BANK receipt (200 of 300), the cash then settles the rest (100): the invoice is fully paid',
  $$select pg_temp.jb('ph2', 'result') = 'partially_paid' and pg_temp.jb('ph1', 'result') = 'fully_paid' and pg_temp.sv('ih', 'status_code')::int = 5 and pg_temp.sv('ih', 'paid')::numeric = 300
       and pg_temp.rcol('erh2', 'method') = 'bank_transfer' and pg_temp.rcol('erh2', 'bank_account_id') = pg_temp.c('scb') and pg_temp.rcol('erh2', 'bank_trans_ref') = 'S3-REF-H0001' and pg_temp.rcol('erh1', 'method') = 'cash'$$);
select pg_temp.q('S3g2 post: the ledger rows are BANK_RECEIPT (Dr bank 200 / Cr receivable 200) and CASH_RECEIPT (Dr cash 100 / Cr receivable 100)',
  $$select pg_temp.qplan('erh2', 'BANK_RECEIPT') = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', 200, 'bank_account_id', pg_temp.c('scb')), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 200))
       and pg_temp.qplan('erh1', 'CASH_RECEIPT') = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'cash', 'amount', 100), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', 100))$$);

-- ---- S3g3: duplicate references, input rules, time rules, the bank, optional file (transfer only)
select pg_temp.asu('A'); select pg_temp.mkslip('ei1', 'ii', 50); reset role;
select pg_temp.asu('C');
select pg_temp.err_like('S3g3 record: a reference that is on a receipt is refused (23505)', 'select ' || pg_temp.recx('ii', 'transfer', '100', 'S3-REF-H0001', 'bank line', 'now()', 'scb'), '%already recorded%');
select pg_temp.err_state('S3g3 record: ...with SQLSTATE 23505', 'select ' || pg_temp.recx('ii', 'transfer', '100', 'S3-REF-H0001', 'bank line', 'now()', 'scb'), '23505');
select pg_temp.err_like('S3g3 record: ...even written differently (case, dashes, spaces)', 'select ' || pg_temp.recx('ii', 'transfer', '100', 's3 ref h0001', 'bank line', 'now()', 'scb'), '%already recorded%');
select pg_temp.err_like('S3g3 record: a reference that is on a verified wallet deposit is refused', 'select ' || pg_temp.recx('ii', 'transfer', '100', 'S3WDREF0001', 'bank line', 'now()', 'scb'), '%already recorded%');
select pg_temp.rec('ri1', 'ii', 'transfer', 100, 'S3-REF-I0001', null, 'scb');
select pg_temp.eid('eri1', 'ri1');
select pg_temp.err_like('S3g3 record: a reference that is on another confirmed payment is refused', 'select ' || pg_temp.recx('ii', 'transfer', '100', 'S3-REF-I0001', 'bank line', 'now()', 'scb'), '%already recorded%');
select pg_temp.err_like('S3g3 record: ...written differently too', 'select ' || pg_temp.recx('ii', 'transfer', '100', 's3-ref-i0001', 'bank line', 'now()', 'scb'), '%already recorded%');
select pg_temp.err_like('S3g3 confirm: a customer slip cannot be confirmed with the reference of a recorded payment', format($q$select public.finance_confirm_evidence(%L, 50, 'S3-REF-I0001', now())$q$, pg_temp.c('ei1')), '%already recorded%');
select pg_temp.err_like('S3g3 record: an unknown method is refused', 'select ' || pg_temp.recx('ii', 'card', '10', 'S3-REF-I0009', 'x'), '%INVALID_METHOD%');
select pg_temp.err_like('S3g3 record: an amount of zero is refused', 'select ' || pg_temp.recx('ii', 'cash', '0', null, 'cash note'), '%INVALID_AMOUNT%');
select pg_temp.err_like('S3g3 record: a negative amount is refused', 'select ' || pg_temp.recx('ii', 'cash', '-5', null, 'cash note'), '%INVALID_AMOUNT%');
select pg_temp.err_like('S3g3 record: three decimals are refused', 'select ' || pg_temp.recx('ii', 'cash', '10.005', null, 'cash note'), '%INVALID_AMOUNT%');
select pg_temp.err_like('S3g3 record: no amount is refused', 'select ' || pg_temp.recx('ii', 'cash', 'null', null, 'cash note'), '%INVALID_AMOUNT%');
select pg_temp.err_like('S3g3 record: no date is refused', 'select ' || pg_temp.recx('ii', 'cash', '10', null, 'cash note', 'null'), '%date and time are required%');
select pg_temp.err_like('S3g3 record: a payment time in the future (11 minutes) is refused', 'select ' || pg_temp.recx('ii', 'cash', '10', null, 'cash note', $$now() + interval '11 minutes'$$), '%future%');
select pg_temp.err_like('S3g3 record: a payment older than the invoice is refused', 'select ' || pg_temp.recx('ii', 'cash', '10', null, 'cash note', $$now() - interval '3 days'$$), '%older than the invoice%');
select pg_temp.err_like('S3g3 record: an unknown invoice is refused', $q$select public.finance_record_payment(gen_random_uuid(), 'cash', 10, now(), null, null, 'cash note')$q$, '%Invoice not found%');
select pg_temp.err_like('S3g3 record: a cancelled invoice is refused', 'select ' || pg_temp.recx('il', 'cash', '10', null, 'cash note'), '%invoice is cancelled%');
select pg_temp.err_like('S3g3 record: a bank that does not exist is refused', $q$select public.finance_record_payment(pg_temp.c('ii')::uuid, 'transfer', 10, now(), 'S3-REF-I0008', gen_random_uuid(), 'x')$q$, '%BANK_NOT_AVAILABLE%');
select pg_temp.err_like('S3g3 record: a note of more than 500 characters is refused', 'select ' || pg_temp.recx('ii', 'cash', '10', null, repeat('n', 501)), '%too long%');
select pg_temp.keep('rcb', 'select ' || pg_temp.recx('ii', 'cash', '5', null, 'cash five', $$now() + interval '9 minutes'$$) || '::text');
select pg_temp.eid('ercb', 'rcb');
reset role;
select pg_temp.q('S3g3 record: a time 9 minutes ahead is accepted (the limit is 10)', $$select pg_temp.ev('ercb', 'status') = 'confirmed' and pg_temp.ev('ercb', 'method') = 'cash'$$);
select pg_temp.q('S3g3 record: the customer slip and the two entries are the only rows of the invoice (every refusal above left nothing behind)', $$select pg_temp.nrows('ii') = 3$$);
-- the optional file of a transfer: the rules of a customer's upload, and the AI reader is queued by the trigger when it is on
select pg_temp.runs_ok('S3g3 setup: the AI review is switched on', $q$update public.finance_settings set ai_review_enabled = true$q$);
select pg_temp.asu('C');
select pg_temp.keep('rf1', 'select ' || pg_temp.recx('ii', 'transfer', '50', 'S3-REF-I0002', 'bank line 3', 'now()', 'scb', pg_temp.c('C') || '/s3-rec1.png', md5('s3-rec1') || md5('s3b-rec1'), 'image/png') || '::text');
select pg_temp.eid('erf1', 'rf1');
select pg_temp.err_like('S3g3 record file: the same file again is refused (23505)', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('C') || '/s3-rec1b.png', md5('s3-rec1') || md5('s3b-rec1'), 'image/png'), '%already submitted%');
select pg_temp.err_state('S3g3 record file: ...with SQLSTATE 23505', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('C') || '/s3-rec1b.png', md5('s3-rec1') || md5('s3b-rec1'), 'image/png'), '23505');
select pg_temp.err_state('S3g3 record file: an invalid file is refused with SQLSTATE 22023', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('A') || '/s3-x.png', md5('s3-rec2') || md5('s3b-rec2'), 'image/png'), '22023');
select pg_temp.err_like('S3g3 record file: a file of another user''s folder is refused', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('A') || '/s3-x.png', md5('s3-rec2') || md5('s3b-rec2'), 'image/png'), '%Invalid file%');
select pg_temp.err_like('S3g3 record file: a path that climbs out of the folder is refused', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('C') || '/../x.png', md5('s3-rec3') || md5('s3b-rec3'), 'image/png'), '%Invalid file%');
select pg_temp.err_like('S3g3 record file: a path without its hash and type (half a file) is refused', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('C') || '/s3-x.png'), '%Invalid file%');
select pg_temp.err_like('S3g3 record file: a file type that is not an image or PDF is refused', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('C') || '/s3-x.txt', md5('s3-rec4') || md5('s3b-rec4'), 'text/plain'), '%Invalid file%');
select pg_temp.err_like('S3g3 record file: a bad hash is refused', 'select ' || pg_temp.recx('ii', 'transfer', '10', 'S3-REF-I0003', 'x', 'now()', 'scb', pg_temp.c('C') || '/s3-x.png', 'xyz', 'image/png'), '%Invalid file%');
select pg_temp.err_like('S3g3 record file: cash has no slip file (FILE_NOT_ALLOWED)', 'select ' || pg_temp.recx('ii', 'cash', '10', null, 'cash note', 'now()', null, pg_temp.c('C') || '/s3-cash.png', md5('s3-rec5') || md5('s3b-rec5'), 'image/png'), '%FILE_NOT_ALLOWED%');
reset role;
select pg_temp.q('S3g3 record file: the slip row carries the file; the AI reader was queued (attempt 1, waiting, nobody as the requester) because the review is on',
  $$select pg_temp.ev('erf1', 'file_path') = pg_temp.c('C') || '/s3-rec1.png' and pg_temp.ev('erf1', 'source') = 'staff_entry' and pg_temp.ev('erf1', 'status') = 'confirmed'
       and (select count(*) = 1 and bool_and(a.attempt = 1 and a.status = 'queued' and a.requested_by is null) from public.finance_slip_analysis a where a.evidence_id = pg_temp.c('erf1')::uuid)$$);
select pg_temp.runs_ok('S3g3 setup: the AI review is switched off', $q$update public.finance_settings set ai_review_enabled = false$q$);
select pg_temp.asu('C');
select pg_temp.keep('rf2', 'select ' || pg_temp.recx('ii', 'transfer', '40', 'S3-REF-I0004', 'bank line 4', 'now()', 'scb', pg_temp.c('C') || '/s3-rec6.png', md5('s3-rec6') || md5('s3b-rec6'), 'image/png') || '::text');
select pg_temp.eid('erf2', 'rf2');
reset role;
select pg_temp.q('S3g3 record file: with the review off a recorded slip with a file queues nothing', $$select pg_temp.ev('erf2', 'file_path') is not null and not exists (select 1 from public.finance_slip_analysis where evidence_id = pg_temp.c('erf2')::uuid)$$);
-- a staff entry is not an AI case for anybody else: and it is limited per invoice by the same rule
select pg_temp.asu('C');
select pg_temp.rec('rm1', 'im', 'cash', 100, null, 'cash for im');
select pg_temp.eid('erm1', 'rm1');
select pg_temp.err_like('S3g3 record: invoice im has its 100 reserved by the confirmed cash entry', 'select ' || pg_temp.recx('im', 'cash', '1', null, 'cash again'), '%EXCEEDS_OUTSTANDING%');
reset role;

-- ---- S3h: reversing a cash receipt credits cash, a bank receipt still credits the bank
select pg_temp.asu('C');
select pg_temp.err_like('S3h reverse: a verifier may not reverse a receipt', format($q$select public.finance_reverse_receipt(%L, 'S3 test reason')$q$, pg_temp.rcol('erg', 'id')), '%not allowed%');
select pg_temp.asu('S');
select pg_temp.runs_ok('S3h reverse: the manager reverses the cash receipt', format($q$select public.finance_reverse_receipt(%L, 'counted wrong at the counter')$q$, pg_temp.rcol('erg', 'id')));
select pg_temp.runs_ok('S3h reverse: and a bank receipt', format($q$select public.finance_reverse_receipt(%L, 'bank returned the transfer')$q$, pg_temp.rcol('ea', 'id')));
reset role;
select pg_temp.q('S3h reverse: the cash reversal credits CASH (Cr cash 150 / Dr receivable 150), never the bank, and has no bank account line',
  $$select pg_temp.nq('erg', 'RECEIPT_REVERSAL') = 1 and pg_temp.qplan('erg', 'RECEIPT_REVERSAL') = jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'cash', 'amount', 150), jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', 150))$$);
select pg_temp.q('S3h reverse: the bank reversal is as before (Cr bank 100 with the bank account / Dr receivable 100)',
  $$select pg_temp.nq('ea', 'RECEIPT_REVERSAL') = 1 and pg_temp.qplan('ea', 'RECEIPT_REVERSAL') = jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'bank', 'amount', 100, 'bank_account_id', pg_temp.c('scb')), jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', 100))$$);
select pg_temp.q('S3h reverse: the cash receipt is reversed, its allocation is inactive, the invoice owes the 150 again (partially paid, 4)',
  $$select pg_temp.rcol('erg', 'status') = 'reversed' and pg_temp.alloc('erg') = 0 and pg_temp.sv('ig', 'status_code')::int = 4 and pg_temp.sv('ig', 'paid')::numeric = 200 and pg_temp.sv('ig', 'outstanding')::numeric = 150$$);
select pg_temp.q('S3l reverse: the audit log has receipt.reverse with the manager as the actor', $$select pg_temp.nevr('erg', 'receipt.reverse', 'S') = 1 and pg_temp.nevr('ea', 'receipt.reverse', 'S') = 1$$);

-- ---- S3c2: money safety on Post: a cash entry can never create a wallet credit, and a reference taken in the meantime stops the post
select pg_temp.keep('eov', format($q$with ins as (insert into public.finance_payment_evidence (invoice_id, customer_id, claimed_amount, status, source, method, recorded_by, confirmed_by, confirmed_at, confirmed_amount, confirmed_transfer_at, confirm_note)
  values (%L, %L, 500, 'confirmed', 'staff_entry', 'cash', %L, %L, now(), 500, now(), 'synthetic: more cash than the invoice owes') returning id) select id::text from ins$q$, pg_temp.c('ix'), pg_temp.c('cust'), pg_temp.c('S'), pg_temp.c('S')));
select pg_temp.asu('C');
select pg_temp.err_like('S3c2 post cash: 500 cash against 100 outstanding is refused (CASH_OVERPAY): cash never makes a wallet credit', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('eov')), '%CASH_OVERPAY%');
reset role;
select pg_temp.q('S3c2 post cash: the refused post left the entry confirmed, with no receipt, no wallet credit and no ledger row',
  $$select pg_temp.ev('eov', 'status') = 'confirmed' and pg_temp.nrc('eov') = 0$$);
select pg_temp.asu('A'); select pg_temp.mkslip('ex2', 'ix', 100); reset role;
select pg_temp.asu('C');
select pg_temp.conf('cx1', 'ex1', 100, 'S3-REF-X0001');
select pg_temp.keep('vx2', format($q$select public.finance_verify_evidence(%L, 100, 'S3-REF-X0001', now())::text$q$, pg_temp.c('ex2')));
select pg_temp.err_like('S3c2 post: the bank transaction was recorded by another slip in the meantime: Post refuses it (23505), money is never counted twice', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('ex1')), '%already recorded%');
reset role;
select pg_temp.q('S3c2 post: ...the first slip stays confirmed, the invoice has the one receipt (of the other slip)', $$select pg_temp.ev('ex1', 'status') = 'confirmed' and pg_temp.nrc('ex1') = 0 and pg_temp.nrc('ex2') = 1 and pg_temp.sv('ix', 'paid')::numeric = 100$$);
-- a confirmed slip whose invoice is cancelled before it is posted cannot be posted
select pg_temp.asu('S'); select pg_temp.mkinv('io', 40); reset role;
select pg_temp.asu('A'); select pg_temp.mkslip('eo', 'io', 40); reset role;
select pg_temp.asu('C'); select pg_temp.conf('co', 'eo', 40, 'S3-REF-O0001'); reset role;
-- (the manager's finance_cancel_invoice refuses this since the review reads, see S4h: a payment that is confirmed and waits to be posted blocks the cancel. A confirmed
-- slip on a cancelled invoice can still exist, for instance in data from before that guard, and Post must refuse it: the invoice is set to cancelled directly here)
reset role;
select pg_temp.runs_ok('S3c2 setup: the invoice is cancelled behind the back of its confirmed slip (as old data could be)', format($q$update public.finance_invoices set status = 'cancelled', cancelled_at = now(), cancel_reason = 'S3 cancel after confirm' where id = %L$q$, pg_temp.c('io')));
select pg_temp.asu('C');
select pg_temp.err_like('S3c2 post: a confirmed slip of a cancelled invoice cannot be posted', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('eo')), '%invoice is cancelled%');
reset role;
select pg_temp.q('S3c2 post: ...the slip stays confirmed and no receipt was made', $$select pg_temp.ev('eo', 'status') = 'confirmed' and pg_temp.nrc('eo') = 0$$);
-- the same bank transfer typed differently: confirmed on one slip, then recorded by the one-step verify on another slip (reference written with spaces / lower case)
-- before the first one is posted. The core only compares exactly, so Post itself must look at the normalised form, or one transfer would get two receipts.
select pg_temp.asu('S'); select pg_temp.mkinv('iq', 100); reset role;
select pg_temp.asu('A'); select pg_temp.mkslip('eq1', 'iq', 100); select pg_temp.mkslip('eq2', 'iq', 100); reset role;
select pg_temp.asu('C');
select pg_temp.conf('cq1', 'eq1', 100, 'S3-REF-Q1');
select pg_temp.keep('vq2', format($q$select public.finance_verify_evidence(%L, 100, 's3 ref q1', now())::text$q$, pg_temp.c('eq2')));
select pg_temp.err_state('S3c2 post: the same transfer written differently on another slip stops Post with SQLSTATE 23505', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('eq1')), '23505');
select pg_temp.err_like('S3c2 post: ...and says the bank transaction was already recorded', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('eq1')), '%already recorded%');
reset role;
select pg_temp.q('S3c2 post: ...one transfer, one receipt: the one-step slip has the receipt, the confirmed slip stays confirmed with none, the invoice is paid once',
  $$select pg_temp.jb('vq2', 'result') = 'fully_paid' and pg_temp.nrc('eq2') = 1 and pg_temp.nrc('eq1') = 0 and pg_temp.ev('eq1', 'status') = 'confirmed' and pg_temp.ev('eq1', 'posted_at') is null
       and (select count(*) from public.finance_receipts where invoice_id = pg_temp.c('iq')::uuid) = 1 and pg_temp.sv('iq', 'paid')::numeric = 100$$);

-- ---- S3i: Reject (a confirmed slip too) and Request more evidence
select pg_temp.asu('A'); select pg_temp.mkslip('ej', 'ij', 120); reset role;
select pg_temp.asu('C');
select pg_temp.conf('cj', 'ej', 120, 'S3-REF-J0001');
select pg_temp.err_like('S3i reject: a reason is required', format($q$select public.finance_reject_evidence(%L, '  ')$q$, pg_temp.c('ej')), '%reason is required%');
select pg_temp.runs_ok('S3i reject: a CONFIRMED slip can be rejected', format($q$select public.finance_reject_evidence(%L, 'the bank shows no such transfer')$q$, pg_temp.c('ej')));
reset role;
select pg_temp.q('S3i reject: the slip is rejected with the reason and the reviewer; what was confirmed stays on the row as history',
  $$select pg_temp.ev('ej', 'status') = 'rejected' and pg_temp.ev('ej', 'reject_reason') = 'the bank shows no such transfer' and pg_temp.ev('ej', 'reviewed_by') = pg_temp.c('C') and pg_temp.ev('ej', 'reviewed_at') is not null
       and pg_temp.ev('ej', 'confirmed_by') = pg_temp.c('C') and pg_temp.ev('ej', 'confirmed_amount')::numeric = 120 and pg_temp.nrc('ej') = 0$$);
select pg_temp.q('S3i reject: the invoice shows rejected (7): nothing paid, nothing pending, nothing confirmed',
  $$select pg_temp.sv('ij', 'status_code')::int = 7 and pg_temp.sv('ij', 'status') = 'rejected' and pg_temp.sv('ij', 'paid')::numeric = 0 and pg_temp.sv('ij', 'pending_evidence')::int = 0 and pg_temp.sv('ij', 'confirmed_pending')::numeric = 0$$);
select pg_temp.q('S3l reject: the audit log has evidence.reject with the verifier as the actor and the reason', $$select count(*) = 1 from public.finance_events where entity = 'evidence' and entity_id = pg_temp.c('ej')::uuid and action = 'evidence.reject' and actor = pg_temp.c('C')::uuid and detail ->> 'reason' = 'the bank shows no such transfer'$$);
select pg_temp.asu('A');
select pg_temp.q('S3i reject: the customer can read the reason on their own slip', format($$select reject_reason = 'the bank shows no such transfer' and status = 'rejected' from public.finance_payment_evidence where id = %L$$, pg_temp.c('ej')));
select pg_temp.mkslip('ej2', 'ij', 120);
reset role;
select pg_temp.q('S3i reject: the customer sends a new slip on the SAME invoice (no new invoice), which shows pending verification (3) again',
  $$select pg_temp.nrows('ij') = 2 and pg_temp.ev('ej2', 'invoice_id') = pg_temp.c('ij') and pg_temp.sv('ij', 'status_code')::int = 3 and pg_temp.sv('ij', 'pending_evidence')::int = 1$$);
select pg_temp.asu('C');
select pg_temp.conf('cj2', 'ej2', 120, 'S3-REF-J0001');
select pg_temp.post('pj2', 'ej2');
select pg_temp.err_like('S3k post: a rejected slip cannot be posted (NOT_CONFIRMED)', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('ej')), '%NOT_CONFIRMED%');
select pg_temp.err_like('S3k reject: a rejected slip cannot be rejected again', format($q$select public.finance_reject_evidence(%L, 'again')$q$, pg_temp.c('ej')), '%already rejected%');
select pg_temp.err_like('S3k reject: a posted slip cannot be rejected', format($q$select public.finance_reject_evidence(%L, 'too late')$q$, pg_temp.c('ej2')), '%already verified%');
select pg_temp.err_like('S3k confirm: a rejected slip cannot be confirmed', format($q$select public.finance_confirm_evidence(%L, 120, 'S3-REF-J0005', now())$q$, pg_temp.c('ej')), '%already rejected%');
reset role;
select pg_temp.q('S3i reject: the reference of the rejected slip was free again: the new slip confirmed with it and was posted (fully paid, 5)',
  $$select pg_temp.jb('cj2', 'status') = 'confirmed' and pg_temp.jb('pj2', 'result') = 'fully_paid' and pg_temp.sv('ij', 'status_code')::int = 5 and pg_temp.rcol('ej2', 'bank_trans_ref') = 'S3-REF-J0001'$$);

select pg_temp.asu('A'); select pg_temp.mkslip('ek', 'ik', 120); reset role;
select pg_temp.asu('C');
select pg_temp.err_like('S3i request: a message is required (nothing)', format($q$select public.finance_request_more_evidence(%L, null)$q$, pg_temp.c('ek')), '%MESSAGE_REQUIRED%');
select pg_temp.err_like('S3i request: a message is required (blank)', format($q$select public.finance_request_more_evidence(%L, '    ')$q$, pg_temp.c('ek')), '%MESSAGE_REQUIRED%');
select pg_temp.err_like('S3i request: a message of 2 characters is too short', format($q$select public.finance_request_more_evidence(%L, 'ab')$q$, pg_temp.c('ek')), '%MESSAGE_REQUIRED%');
select pg_temp.err_like('S3i request: a message of 301 characters is too long', format($q$select public.finance_request_more_evidence(%L, repeat('m', 301))$q$, pg_temp.c('ek')), '%MESSAGE_REQUIRED%');
select pg_temp.runs_ok('S3i request: ask for more evidence of a submitted slip', format($q$select public.finance_request_more_evidence(%L, 'Please send a clearer slip of the transfer')$q$, pg_temp.c('ek')));
reset role;
select pg_temp.q('S3i request: the slip is now more_evidence with the message, who asked and when',
  $$select pg_temp.ev('ek', 'status') = 'more_evidence' and pg_temp.ev('ek', 'request_message') = 'Please send a clearer slip of the transfer' and pg_temp.ev('ek', 'requested_by') = pg_temp.c('C') and pg_temp.ev('ek', 'requested_at') is not null$$);
select pg_temp.q('S3i request: the invoice shows more evidence requested (code 10, status more_evidence) with the message; nothing is pending or paid',
  $$select pg_temp.sv('ik', 'status_code')::int = 10 and pg_temp.sv('ik', 'status') = 'more_evidence' and pg_temp.sv('ik', 'more_evidence_message') = 'Please send a clearer slip of the transfer' and pg_temp.sv('ik', 'pending_evidence')::int = 0 and pg_temp.sv('ik', 'paid')::numeric = 0$$);
select pg_temp.q('S3l request: the audit log has evidence.request_more with the verifier as the actor', $$select pg_temp.nev('ek', 'evidence.request_more', 'C') = 1$$);
select pg_temp.asu('A');
select pg_temp.q('S3i request: the customer reads the message on their own slip and in the state of the invoice (what they see: code 10 and the message)',
  format($$select request_message = 'Please send a clearer slip of the transfer' and status = 'more_evidence' from public.finance_payment_evidence where id = %L$$, pg_temp.c('ek')));
select pg_temp.q('S3i request: ...through the customer''s own state function too',
  format($$select (public.finance_invoice_state(%L) ->> 'status_code')::int = 10 and public.finance_invoice_state(%L) ->> 'more_evidence_message' = 'Please send a clearer slip of the transfer'$$, pg_temp.c('ik'), pg_temp.c('ik')));
select pg_temp.mkslip('ek2', 'ik', 120);
reset role;
select pg_temp.q('S3i request: the customer sends a new slip: the state returns to pending verification (3) and the message is gone',
  $$select pg_temp.sv('ik', 'status_code')::int = 3 and pg_temp.sv('ik', 'status') = 'pending_verification' and pg_temp.sv('ik', 'more_evidence_message') is null and pg_temp.sv('ik', 'pending_evidence')::int = 1$$);
select pg_temp.asu('C');
select pg_temp.err_like('S3i request: a slip that is already waiting for more evidence is refused', format($q$select public.finance_request_more_evidence(%L, 'Please send a clearer slip')$q$, pg_temp.c('ek')), '%already more_evidence%');
select pg_temp.err_like('S3i request: a posted slip is refused', format($q$select public.finance_request_more_evidence(%L, 'Please send a clearer slip')$q$, pg_temp.c('ec')), '%already verified%');
select pg_temp.err_like('S3i request: a rejected slip is refused', format($q$select public.finance_request_more_evidence(%L, 'Please send a clearer slip')$q$, pg_temp.c('ej')), '%already rejected%');
select pg_temp.err_like('S3i request: a payment recorded by staff has no customer slip to ask for (NO_CUSTOMER_SLIP)', format($q$select public.finance_request_more_evidence(%L, 'Please send a clearer slip')$q$, pg_temp.c('ercb')), '%NO_CUSTOMER_SLIP%');
select pg_temp.err_like('S3k post: a slip waiting for more evidence cannot be posted (NOT_CONFIRMED)', format($q$select public.finance_post_evidence(%L)$q$, pg_temp.c('ek')), '%NOT_CONFIRMED%');
select pg_temp.err_like('S3k confirm: a slip waiting for more evidence cannot be confirmed', format($q$select public.finance_confirm_evidence(%L, 120, 'S3-REF-K0001', now())$q$, pg_temp.c('ek')), '%already more_evidence%');
select pg_temp.conf('ck2', 'ek2', 120, 'S3-REF-K0002');
select pg_temp.runs_ok('S3i request: a CONFIRMED slip can be sent back for more evidence too', format($q$select public.finance_request_more_evidence(%L, 'abc')$q$, pg_temp.c('ek2')));
reset role;
select pg_temp.q('S3i request: a message of exactly 3 characters is accepted; the slip left confirmed (nothing confirmed any more)',
  $$select pg_temp.ev('ek2', 'status') = 'more_evidence' and pg_temp.ev('ek2', 'request_message') = 'abc' and pg_temp.sv('ik', 'confirmed_pending')::numeric = 0$$);
select pg_temp.asu('A'); select pg_temp.mkslip('ek3', 'ik', 120); select pg_temp.mkslip('ek4', 'ik', 120); reset role;
select pg_temp.asu('C');
select pg_temp.runs_ok('S3i request: a message of exactly 300 characters is accepted', format($q$select public.finance_request_more_evidence(%L, repeat('m', 300))$q$, pg_temp.c('ek4')));
select pg_temp.conf('ck3', 'ek3', 120, 'S3-REF-K0002');
reset role;
select pg_temp.q('S3i request: sending a confirmed slip back freed its reference: another slip was confirmed with it', $$select pg_temp.jb('ck3', 'status') = 'confirmed' and pg_temp.ev('ek3', 'confirmed_bank_ref') = 'S3-REF-K0002'$$);
-- how the staff list shows the new statuses (the old catch-all showed every status that was not submitted or verified as rejected)
select pg_temp.asu('C');
select pg_temp.keep('ov', $q$select public.finance_payments_overview('invoice_slip', null, null, null, 200, 0)::text$q$);
reset role;
create or replace function pg_temp.ovs(p_ev text) returns text language sql as $$
  select i ->> 'status' from jsonb_array_elements((select v::jsonb from t_ctx where k = 'ov') -> 'items') i where i ->> 'id' = pg_temp.c(p_ev) $$;
select pg_temp.q('S3 overview: the payments list says confirmed for a confirmed slip, more_evidence for a slip sent back, and still submitted / verified / rejected for the old statuses',
  $$select pg_temp.ovs('ek3') = 'confirmed' and pg_temp.ovs('ek') = 'more_evidence' and pg_temp.ovs('ef1') = 'submitted' and pg_temp.ovs('ec') = 'verified' and pg_temp.ovs('ej') = 'rejected' and pg_temp.ovs('erf1') = 'confirmed'$$);
select pg_temp.asu('C');
select pg_temp.runs_ok('S3k reject: a slip waiting for more evidence can be rejected', format($q$select public.finance_reject_evidence(%L, 'no answer from the customer')$q$, pg_temp.c('ek')));
select pg_temp.runs_ok('S3k reject: ...and a second one', format($q$select public.finance_reject_evidence(%L, 'no answer from the customer')$q$, pg_temp.c('ek2')));
select pg_temp.runs_ok('S3k reject: ...and a confirmed one', format($q$select public.finance_reject_evidence(%L, 'bank has no such transfer')$q$, pg_temp.c('ek3')));
select pg_temp.runs_ok('S3k reject: a recorded payment is cancelled by rejecting it', format($q$select public.finance_reject_evidence(%L, 'typed on the wrong invoice')$q$, pg_temp.c('erm1')));
select pg_temp.rec('rm2', 'im', 'cash', 100, null, 'cash for im again');
reset role;
select pg_temp.q('S3k reject: rejecting the recorded cash entry released its 100: the same amount could be recorded again',
  $$select pg_temp.ev('erm1', 'status') = 'rejected' and pg_temp.jb('rm2', 'status') = 'confirmed'$$);

-- ---- S3j: a customer cannot cancel an order while a slip is submitted, confirmed or waiting for more evidence; they can once it is rejected
select pg_temp.asu('A');
select pg_temp.keep('oj1', format($q$select public.shop_place_order('slip-key-s3-j1', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')));
select pg_temp.keep('oj1inv', $q$select ((v::jsonb) -> 'order' -> 'invoice' ->> 'id') from t_ctx where k = 'oj1'$q$);
select pg_temp.keep('oj1id', $q$select ((v::jsonb) -> 'order' ->> 'id') from t_ctx where k = 'oj1'$q$);
select pg_temp.mkslip('ej1', 'oj1inv', pg_temp.c('P1')::numeric);
select pg_temp.err_like('S3j cancel: with the slip submitted the customer cannot cancel (SLIP_PENDING)', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oj1id')), '%SLIP_PENDING%');
select pg_temp.asu('C'); select pg_temp.conf('cj1', 'ej1', pg_temp.c('P1')::numeric, 'S3-REF-J1001');
select pg_temp.q('S3j setup: the slip of the order is confirmed', $$select pg_temp.ev('ej1', 'status') = 'confirmed'$$);
select pg_temp.asu('A');
select pg_temp.err_like('S3j cancel: with the slip CONFIRMED the customer cannot cancel (SLIP_PENDING)', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oj1id')), '%SLIP_PENDING%');
select pg_temp.asu('C');
select pg_temp.runs_ok('S3j setup: the confirmed slip is sent back for more evidence', format($q$select public.finance_request_more_evidence(%L, 'Please send the slip again')$q$, pg_temp.c('ej1')));
select pg_temp.q('S3j setup: the slip of the order now waits for more evidence', $$select pg_temp.ev('ej1', 'status') = 'more_evidence'$$);
select pg_temp.asu('A');
select pg_temp.err_like('S3j cancel: with more evidence requested the customer cannot cancel (SLIP_PENDING)', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oj1id')), '%SLIP_PENDING%');
select pg_temp.asu('C');
select pg_temp.runs_ok('S3j setup: the slip is rejected', format($q$select public.finance_reject_evidence(%L, 'not a payment to us')$q$, pg_temp.c('ej1')));
select pg_temp.asu('A');
select pg_temp.runs_ok('S3j cancel: once the slip is rejected the customer can cancel the order', format($q$select public.shop_cancel_my_order(%L)$q$, pg_temp.c('oj1id')));
reset role;
select pg_temp.q('S3j cancel: the order and its invoice are cancelled', format($$select o.status = 'cancelled' and i.status = 'cancelled' from public.shop_orders o join public.finance_invoices i on i.id = o.invoice_id where o.id = %L$$, pg_temp.c('oj1id')));
-- an order with a rejected, then a new slip: the same order and invoice (no new order)
select pg_temp.asu('A');
select pg_temp.keep('oj2', format($q$select public.shop_place_order('slip-key-s3-j2', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')));
select pg_temp.keep('oj2inv', $q$select ((v::jsonb) -> 'order' -> 'invoice' ->> 'id') from t_ctx where k = 'oj2'$q$);
select pg_temp.mkslip('ej3', 'oj2inv', pg_temp.c('P1')::numeric);
select pg_temp.asu('C'); select pg_temp.conf('cj3', 'ej3', pg_temp.c('P1')::numeric, 'S3-REF-J3001');
select pg_temp.runs_ok('S3j setup: the confirmed slip is rejected', format($q$select public.finance_reject_evidence(%L, 'amount does not match')$q$, pg_temp.c('ej3')));
select pg_temp.asu('A');
select pg_temp.mkslip('ej4', 'oj2inv', pg_temp.c('P1')::numeric);
reset role;
select pg_temp.q('S3i order: after a rejection the customer pays the same order again: one order, one invoice, a second slip, state pending verification (3)',
  $$select (select count(*) from public.shop_orders where invoice_id = pg_temp.c('oj2inv')::uuid) = 1 and pg_temp.nrows('oj2inv') = 2 and pg_temp.sv('oj2inv', 'status_code')::int = 3
       and (select status from public.shop_orders where invoice_id = pg_temp.c('oj2inv')::uuid) = 'new'$$);

-- ---- S3r: reports. A cash receipt has no bank account: the daily report shows it on its own CASH line (it used to fall into PROMPTPAY/OTHER and its ledger row was
-- looked up as a BANK_RECEIPT, so it could never show as posted); the ledger queue lists the CASH_RECEIPT row
create or replace function pg_temp.cashsum() returns numeric language sql security definer as $$
  select coalesce(sum(amount), 0) from public.finance_receipts where method = 'cash' and status = 'posted' and wallet_txn_id is null and (received_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date $$;
create or replace function pg_temp.cashn() returns bigint language sql security definer as $$
  select count(*) from public.finance_receipts where method = 'cash' and status = 'posted' and wallet_txn_id is null and (received_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date $$;
create or replace function pg_temp.othsum() returns numeric language sql security definer as $$
  select coalesce(sum(amount), 0) from public.finance_receipts where method <> 'cash' and bank_account_id is null and status = 'posted' and wallet_txn_id is null and (received_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date $$;
create or replace function pg_temp.rrow(p_key text, p_code text, p_field text) returns text language sql as $$
  select r ->> p_field from jsonb_array_elements((select v::jsonb from t_ctx where k = p_key)) r where r ->> 'bank_code' = p_code $$;
select pg_temp.asu('C');
select pg_temp.keep('rep1', $q$select public.finance_bank_daily_report((now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date)::text$q$);
select pg_temp.keep('glp', $q$select public.finance_gl_pending('pending', 500)::text$q$);
reset role;
select pg_temp.q('S3r report: the posted cash receipts are one CASH line (no bank account, no deposits) with their count and amount',
  $$select pg_temp.cashn() >= 1 and pg_temp.rrow('rep1', 'CASH', 'invoice_amount')::numeric = pg_temp.cashsum() and pg_temp.rrow('rep1', 'CASH', 'invoice_transfers')::int = pg_temp.cashn()
       and pg_temp.rrow('rep1', 'CASH', 'bank_account_id') is null and pg_temp.rrow('rep1', 'CASH', 'deposits')::int = 0 and pg_temp.rrow('rep1', 'CASH', 'total')::numeric = pg_temp.cashsum()$$);
select pg_temp.q('S3r report: cash is not counted in the PROMPTPAY/OTHER line any more (that line holds only receipts without a bank that are not cash)',
  $$select coalesce(pg_temp.rrow('rep1', 'PROMPTPAY/OTHER', 'invoice_amount')::numeric, 0) = pg_temp.othsum()$$);
select pg_temp.q('S3r report: the cash is waiting for the ledger (nothing posted yet)', $$select pg_temp.rrow('rep1', 'CASH', 'in_ledger')::numeric = 0 and pg_temp.rrow('rep1', 'CASH', 'waiting_for_ledger')::numeric = pg_temp.cashsum()$$);
select pg_temp.q('S3r ledger queue: the CASH_RECEIPT row is listed (plan Dr cash / Cr receivable, no bank account line)',
  $$select (select count(*) from jsonb_array_elements((select v::jsonb from t_ctx where k = 'glp') -> 'items') i where i ->> 'event_type' = 'CASH_RECEIPT' and i ->> 'ref_no' = pg_temp.rcol('erh1', 'receipt_no')
        and i -> 'plan' -> 0 ->> 'role' = 'cash' and i -> 'plan' -> 1 ->> 'role' = 'ar' and not (i -> 'plan' -> 0 ? 'bank_account_id')) = 1$$);
select pg_temp.keep('qiss', format($q$select id::text from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = %L$q$, pg_temp.c('ih')));
select pg_temp.keep('qcash', format($q$select q.id::text from public.finance_gl_queue q join public.finance_receipts r on r.id = q.ref_id where q.event_type = 'CASH_RECEIPT' and r.evidence_id = %L$q$, pg_temp.c('erh1')));
select pg_temp.asu('C');
select pg_temp.runs_ok('S3r ledger: the accountant posts the invoice row and then the cash row (the cash row waits for the invoice)', format($q$select public.finance_gl_mark_posted(%L, 'JV-S3-0001', 'S3-POSTED-REF-1'), public.finance_gl_mark_posted(%L, 'JV-S3-0002', 'S3-POSTED-REF-2')$q$, pg_temp.c('qiss'), pg_temp.c('qcash')));
select pg_temp.keep('rep2', $q$select public.finance_bank_daily_report((now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date)::text$q$);
reset role;
select pg_temp.q('S3r report: once the CASH_RECEIPT row is posted the CASH line shows it in the ledger',
  $$select pg_temp.rrow('rep2', 'CASH', 'in_ledger')::numeric = 100 and pg_temp.rrow('rep2', 'CASH', 'waiting_for_ledger')::numeric = pg_temp.cashsum() - 100$$);
select pg_temp.q('S3r report: the bank transfer receipts of the same day are still reported on their bank line (SCB), as before',
  $$select pg_temp.rrow('rep2', 'SCB', 'invoice_transfers')::int >= 3$$);

-- ---- S3x: what the customer can and cannot see
select pg_temp.asu('A');
select pg_temp.q('S3x RLS: customer A reads the new columns of their own slip (what was confirmed and posted, source and method)',
  format($$select count(*) = 1 from public.finance_payment_evidence where id = %L and confirmed_amount = 300 and confirmed_bank_ref = 'S3-REF-C0001' and confirm_note = 'S3 test' and source = 'customer_slip' and method = 'transfer'
       and posted_at is not null and confirmed_at is not null$$, pg_temp.c('ec')));
select pg_temp.q('S3x RLS: customer A sees the payments staff recorded on their invoices (both on ih: one cash, one transfer)',
  format($$select count(*) = 2 and count(*) filter (where method = 'cash') = 1 from public.finance_payment_evidence where invoice_id = %L and source = 'staff_entry'$$, pg_temp.c('ih')));
select pg_temp.q('S3x RLS: customer A sees no AI analysis, even of the slip file a staff member recorded, and no audit rows',
  $$select (select count(*) from public.finance_slip_analysis) = 0 and (select count(*) from public.finance_events) = 0$$);
select pg_temp.err_like('S3x RLS: customer A cannot change a slip directly', format($q$update public.finance_payment_evidence set status = 'verified' where id = %L$q$, pg_temp.c('ef1')), '%permission denied%');
select pg_temp.q('S3x state: what the customer sees of an invoice has no key about the AI (the 12 keys of the state, nothing else)',
  format($$select (select array_agg(kk order by kk) from jsonb_object_keys(public.finance_invoice_state(%L)) kk)
       = array['amount', 'confirmed_pending', 'invoice_id', 'more_evidence_message', 'outstanding', 'paid', 'pending_evidence', 'refunded', 'request', 'status', 'status_code', 'unapplied']$$, pg_temp.c('ii')));
select pg_temp.q('S3x state: the customer''s invoice list and the order JSON never mention an analysis or an AI result',
  $$select position('analysis' in lower(public.finance_my_invoices()::text)) = 0 and position('duplicate_suspected' in lower(public.finance_my_invoices()::text)) = 0 and position('manual_review' in lower(public.finance_my_invoices()::text)) = 0$$);
select pg_temp.asu('B');
select pg_temp.q('S3x RLS: another customer sees none of A''s slips, staff entries or analyses',
  format($$select (select count(*) from public.finance_payment_evidence where invoice_id in (%L, %L, %L, %L)) = 0 and (select count(*) from public.finance_slip_analysis) = 0
       and (select count(*) from public.finance_receipts where invoice_id in (%L, %L)) = 0$$, pg_temp.c('ic'), pg_temp.c('ih'), pg_temp.c('ik'), pg_temp.c('ii'), pg_temp.c('ic'), pg_temp.c('ih')));
select pg_temp.q('S3x RLS: another customer gets no state for A''s invoice', format($$select public.finance_invoice_state(%L) is null$$, pg_temp.c('ik')));
reset role;
select pg_temp.q('S3x RLS: there are analysis rows (the one of the recorded slip), so the zero counts above mean something', $$select count(*) >= 1 from public.finance_slip_analysis where evidence_id = pg_temp.c('erf1')::uuid$$);

-- ---- S3p: who can call what, and that no function was left twice
select pg_temp.q('S3p grants: the core, and the reference check, cannot be called by any client role (not even the service role)',
  $$select not has_function_privilege('authenticated', 'public.finance_verify_core(uuid, numeric, text, timestamptz, text, text, text, text)', 'execute')
       and not has_function_privilege('anon', 'public.finance_verify_core(uuid, numeric, text, timestamptz, text, text, text, text)', 'execute')
       and not has_function_privilege('service_role', 'public.finance_verify_core(uuid, numeric, text, timestamptz, text, text, text, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.finance_ref_in_use(text, uuid)', 'execute') and not has_function_privilege('anon', 'public.finance_ref_in_use(text, uuid)', 'execute')
       and not has_function_privilege('service_role', 'public.finance_ref_in_use(text, uuid)', 'execute')$$);
select pg_temp.q('S3p grants: Confirm, Post, Request more, Record and Save settings are for signed-in users only (each checks the role itself); anon cannot call them',
  $$select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) from unnest(array[
       'public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text)', 'public.finance_post_evidence(uuid, text)', 'public.finance_request_more_evidence(uuid, text)',
       'public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text)', 'public.finance_save_review_settings(jsonb)',
       'public.finance_verify_evidence(uuid, numeric, text, timestamptz, text, text)', 'public.finance_reject_evidence(uuid, text)', 'public.finance_reverse_receipt(uuid, text)']) f$$);
select pg_temp.q('S3p grants: the state and cancel helpers stay internal, as before',
  $$select not has_function_privilege('authenticated', 'public.finance_invoice_state_raw(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.shop_cancel_order_internal(uuid, text, boolean)', 'execute')$$);
select pg_temp.q('S3p api: every function of this section exists exactly once (no stray overload next to a replaced one)',
  $$select bool_and((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f) = 1) from unnest(array[
       'finance_verify_core', 'finance_verify_evidence', 'finance_confirm_evidence', 'finance_post_evidence', 'finance_reject_evidence', 'finance_request_more_evidence', 'finance_record_payment',
       'finance_invoice_state_raw', 'shop_cancel_order_internal', 'finance_reverse_receipt', 'finance_save_review_settings', 'finance_ref_in_use', 'finance_payments_overview', 'finance_bank_daily_report']) f$$);
select pg_temp.q('S3p api: the old one-step function keeps its old signature (the app and every older build call it with these six arguments)',
  $$select pg_get_function_arguments('public.finance_verify_evidence(uuid, numeric, text, timestamptz, text, text)'::regprocedure) = 'p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamp with time zone, p_note text DEFAULT NULL::text, p_via text DEFAULT ''staff''::text'$$);

-- ---- S3l: one look at the audit trail: every action of this section left a row with its actor
select pg_temp.q('S3l audit: confirm, post, record, reject, request more, reverse and settings each wrote a row with the person who did it',
  $$select pg_temp.nev('ec', 'evidence.confirm', 'C') = 1 and pg_temp.nev('ec', 'evidence.post', 'C') = 1 and pg_temp.nev('erg', 'evidence.record', 'C') = 1 and pg_temp.nev('ej', 'evidence.reject', 'C') = 1
       and pg_temp.nev('ek', 'evidence.request_more', 'C') = 1 and pg_temp.nevr('erg', 'receipt.reverse', 'S') = 1
       and (select count(*) from public.finance_events where action = 'settings.review' and actor = pg_temp.c('S')::uuid) >= 4 and pg_temp.nev('ee2', 'evidence.confirm', 'S') = 1 and pg_temp.nev('ee2', 'evidence.post', 'S') = 1$$);

-- ---- put back what this section changed in the shared setup
select pg_temp.runs_ok('S3 cleanup: the settings are back to the dark defaults', $q$update public.finance_settings set ai_review_enabled = false, post_requires_manager = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10$q$);
select pg_temp.q('S3 cleanup: the settings are dark', $$select not ai_review_enabled and not post_requires_manager and ai_min_confidence = 0.80 and slip_window_before_min = 120 and slip_future_tolerance_min = 10 from public.finance_settings$$);

-- =========================================================================================== S4 reads
-- The review list, summary and detail (staff only: customers and signed-out visitors are refused), the settings read, the derived stage of a payment, the guard that stops a
-- manager cancelling an invoice whose payment is confirmed but not posted, and the indexes. Production already holds real slips, so:
--   * the fixtures of this section sit on fixed dates in March 2031 (no real record is there): a list with from/to inside that window holds exactly the 18 slips made here;
--   * everything that has no date (the unresolved counts of the summary) is compared as a before/after difference and with an independent recount in plain SQL;
--   * every call of a function of this section goes through keep4 / q / err_like / runs_ok, so a missing function is a recorded failure and the run goes on.
reset role;
create or replace function pg_temp.keep4(p_key text, p_sql text) returns void language plpgsql as $$
declare v text;
begin
  begin execute p_sql into v; insert into t_ctx values (p_key, v) on conflict (k) do update set v = excluded.v;
  exception when others then insert into t_ctx values (p_key, null) on conflict (k) do update set v = null; perform pg_temp.chk('S4 call ' || p_key, false, sqlerrm);
  end;
end $$;
-- the three reads as a given user (default: manager S); the answer is kept under a key; the role is reset afterwards
create or replace function pg_temp.rl(p_key text, p_filter jsonb default '{}'::jsonb, p_limit integer default 200, p_off integer default 0, p_user text default 'S') returns void language plpgsql as $$
begin
  perform pg_temp.asu(p_user);
  perform pg_temp.keep4(p_key, format($q$select public.finance_review_list(%L::jsonb, %s, %s)::text$q$, p_filter::text, p_limit, p_off));
  execute 'reset role';
end $$;
create or replace function pg_temp.rs(p_key text, p_from text default null, p_to text default null, p_user text default 'S') returns void language plpgsql as $$
begin
  perform pg_temp.asu(p_user);
  perform pg_temp.keep4(p_key, format($q$select public.finance_review_summary(%L::date, %L::date)::text$q$, p_from, p_to));
  execute 'reset role';
end $$;
create or replace function pg_temp.rd(p_key text, p_ev text, p_user text default 'S') returns void language plpgsql as $$
begin
  perform pg_temp.asu(p_user);
  perform pg_temp.keep4(p_key, format($q$select public.finance_review_detail(%L)::text$q$, pg_temp.c(p_ev)));
  execute 'reset role';
end $$;
-- readers of a stored answer: the total, the number of items, a field of one slip's item, the ids in order, and which fixture slips (keys s4_...) are in it
create or replace function pg_temp.lt(p_key text) returns bigint language sql as $$ select (v::jsonb ->> 'total')::bigint from t_ctx where k = p_key $$;
create or replace function pg_temp.ln(p_key text) returns integer language sql as $$ select jsonb_array_length(v::jsonb -> 'items') from t_ctx where k = p_key $$;
create or replace function pg_temp.li(p_key text, p_ev text, p_field text) returns text language sql as $$
  select i ->> p_field from t_ctx x, jsonb_array_elements(x.v::jsonb -> 'items') i where x.k = p_key and i ->> 'evidence_id' = pg_temp.c(p_ev) $$;
create or replace function pg_temp.lj(p_key text, p_ev text, p_field text) returns jsonb language sql as $$
  select i -> p_field from t_ctx x, jsonb_array_elements(x.v::jsonb -> 'items') i where x.k = p_key and i ->> 'evidence_id' = pg_temp.c(p_ev) $$;
create or replace function pg_temp.lids(p_key text) returns text[] language sql as $$
  select coalesce(array_agg(i ->> 'evidence_id' order by o), '{}') from t_ctx x, jsonb_array_elements(x.v::jsonb -> 'items') with ordinality as t(i, o) where x.k = p_key $$;
create or replace function pg_temp.ks(variadic p_keys text[]) returns text language sql as $$ select coalesce(string_agg(k, ',' order by k collate "C"), '') from unnest(p_keys) k $$;
create or replace function pg_temp.lset(p_key text) returns text language sql as $$
  select coalesce(string_agg(f.k, ',' order by f.k collate "C"), '') from t_ctx f
   where left(f.k, 3) = 's4_' and f.v = any (pg_temp.lids(p_key)) $$;
create or replace function pg_temp.s4all() returns text language sql as $$
  select pg_temp.ks('s4_a', 's4_c', 's4_d', 's4_e', 's4_early', 's4_f', 's4_k', 's4_l', 's4_m', 's4_n', 's4_next', 's4_o1', 's4_o2', 's4_p', 's4_q', 's4_r', 's4_s', 's4_t') $$;
-- a stored summary / detail: a value at a path (numbers: sj / sd for a difference of two summaries)
create or replace function pg_temp.sj(p_key text, p_path text) returns numeric language sql as $$ select (v::jsonb #>> string_to_array(p_path, '.'))::numeric from t_ctx where k = p_key $$;
create or replace function pg_temp.sd(p_a text, p_b text, p_path text) returns numeric language sql as $$ select pg_temp.sj(p_b, p_path) - pg_temp.sj(p_a, p_path) $$;
create or replace function pg_temp.dj(p_key text, p_path text) returns text language sql as $$ select (v::jsonb #>> string_to_array(p_path, '.')) from t_ctx where k = p_key $$;
create or replace function pg_temp.dv(p_key text, p_path text) returns jsonb language sql as $$ select (v::jsonb #> string_to_array(p_path, '.')) from t_ctx where k = p_key $$;
-- the look-up of a column of an invoice by key, with owner rights
create or replace function pg_temp.inv(p_inv text, p_col text) returns text language plpgsql security definer as $$
declare v text;
begin execute format('select %I::text from public.finance_invoices where id = %L', p_col, pg_temp.c(p_inv)) into v; return v; end $$;
-- id of the newest attempt of a slip's analysis
create or replace function pg_temp.aidl(p_ev text) returns uuid language plpgsql security definer as $$
declare v uuid;
begin
  begin select id into v from public.finance_slip_analysis where evidence_id = pg_temp.c(p_ev)::uuid order by attempt desc limit 1;
  exception when others then v := null; end;
  return v;
end $$;
-- one check on a field of one list item: as text, or as a number
create or replace function pg_temp.eqf(p_test text, p_key text, p_ev text, p_field text, p_expected text) returns void language plpgsql as $$
declare v text;
begin v := pg_temp.li(p_key, p_ev, p_field); perform pg_temp.chk(p_test, v is not distinct from p_expected, coalesce(v, 'null') || ' (expected ' || coalesce(p_expected, 'null') || ')'); exception when others then perform pg_temp.chk(p_test, false, sqlerrm); end $$;
create or replace function pg_temp.eqn(p_test text, p_key text, p_ev text, p_field text, p_expected numeric) returns void language plpgsql as $$
declare v text;
begin v := pg_temp.li(p_key, p_ev, p_field); perform pg_temp.chk(p_test, v::numeric is not distinct from p_expected, coalesce(v, 'null') || ' (expected ' || coalesce(p_expected::text, 'null') || ')'); exception when others then perform pg_temp.chk(p_test, false, sqlerrm); end $$;
-- the window of the fixtures, and a filter inside it
create or replace function pg_temp.w(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$ select '{"from": "2031-03-09", "to": "2031-03-12"}'::jsonb || p_extra $$;
-- what the fixtures need: a slip of customer A (with an optional claimed reference); the dates of the fixtures; an analysis result written by the service role
create or replace function pg_temp.s4slip(p_key text, p_inv text, p_amount numeric, p_ref text default null) returns void language plpgsql as $$
begin
  perform pg_temp.keep(p_key, format($q$select public.finance_submit_evidence(%L, %L, %L, 'image/png', %s, now(), 'SCB', %L, %L)::text$q$,
    pg_temp.c(p_inv), pg_temp.c('A') || '/s4-' || p_key || '.png', md5('s4-' || p_key) || md5('s4b-' || p_key), p_amount, p_ref, pg_temp.c('scb')));
end $$;
create or replace function pg_temp.s4times() returns void language plpgsql as $$
begin
  update public.shop_orders set created_at = timestamptz '2031-03-10 14:00:00+07' where invoice_id in (select v::uuid from t_ctx where left(k, 3) = 'v4_');
  update public.finance_invoices set created_at = timestamptz '2031-03-10 14:00:00+07' where id in (select v::uuid from t_ctx where left(k, 3) = 'v4_');
  update public.finance_payment_evidence e set created_at = d.at
    from (values ('s4_m', timestamptz '2031-03-10 14:05:00+07'), ('s4_a', timestamptz '2031-03-10 14:06:00+07'), ('s4_d', timestamptz '2031-03-10 14:07:00+07'),
                 ('s4_s', timestamptz '2031-03-10 14:08:00+07'), ('s4_f', timestamptz '2031-03-10 14:09:00+07'), ('s4_c', timestamptz '2031-03-10 14:10:00+07'),
                 ('s4_p', timestamptz '2031-03-10 14:11:00+07'), ('s4_r', timestamptz '2031-03-10 14:12:00+07'), ('s4_e', timestamptz '2031-03-10 14:13:00+07'),
                 ('s4_k', timestamptz '2031-03-10 14:14:00+07'), ('s4_n', timestamptz '2031-03-10 14:15:00+07'), ('s4_q', timestamptz '2031-03-10 14:16:00+07'),
                 ('s4_t', timestamptz '2031-03-10 14:17:00+07'), ('s4_l', timestamptz '2031-03-10 14:18:00+07'), ('s4_o1', timestamptz '2031-03-10 14:19:00+07'),
                 ('s4_o2', timestamptz '2031-03-10 23:59:59.999999+07'), ('s4_early', timestamptz '2031-03-10 06:30:00+07'), ('s4_next', timestamptz '2031-03-11 00:00:00+07')) d(k, at)
   where e.id = pg_temp.c(d.k)::uuid;
end $$;
create or replace function pg_temp.s4done(p_key text, p_ev text, p_amount numeric, p_ref text, p_conf numeric default 0.95, p_over jsonb default '{}'::jsonb, p_qr jsonb default null) returns void language plpgsql as $$
declare v_aid uuid := pg_temp.aidl(p_ev); v_ex text := pg_temp.ex(jsonb_build_object('amount', p_amount, 'trans_ref', p_ref, 'transfer_at', '2031-03-10T14:03:00+07:00') || p_over)::text;
        v_qr text := coalesce(p_qr, pg_temp.qrr(p_ref))::text;
begin
  execute 'reset role'; execute 'set local role service_role';
  perform pg_temp.keep(p_key, format($q$select public.finance_analysis_complete(%L, %L::jsonb, %L::jsonb, %s, '[]'::jsonb, 'claude-haiku-5-5', 'v1')::text$q$, v_aid, v_ex, v_qr, p_conf));
  execute 'reset role';
end $$;
-- the summary worked out in plain SQL, written differently from the function (max() sub-selects instead of lateral joins, calendar days instead of timestamps)
create or replace function pg_temp.recount(p_from date default null, p_to date default null) returns jsonb language plpgsql as $$
begin return (
  with a as (
    select e.id, e.status, e.claimed_amount, e.confirmed_amount, e.verified_amount,
           (select x.status from public.finance_slip_analysis x where x.evidence_id = e.id and x.attempt = (select max(y.attempt) from public.finance_slip_analysis y where y.evidence_id = e.id)) as ns,
           (select x.result from public.finance_slip_analysis x where x.evidence_id = e.id and x.attempt = (select max(y.attempt) from public.finance_slip_analysis y where y.evidence_id = e.id)) as nr,
           (select case when jsonb_typeof(x.extracted -> 'amount') = 'number' then (x.extracted ->> 'amount')::numeric end from public.finance_slip_analysis x
             where x.evidence_id = e.id and x.status = 'done' and x.attempt = (select max(y.attempt) from public.finance_slip_analysis y where y.evidence_id = e.id and y.status = 'done')) as ai,
           coalesce(
             (select case when jsonb_typeof(x.expected -> 'amount') = 'number' then (x.expected ->> 'amount')::numeric end from public.finance_slip_analysis x
               where x.evidence_id = e.id and x.status = 'done' and x.attempt = (select max(y.attempt) from public.finance_slip_analysis y where y.evidence_id = e.id and y.status = 'done')),
             (select r.amount from public.finance_payment_requests r where r.id = e.request_id),
             (select greatest(i.amount - coalesce((select sum(al.amount) from public.finance_allocations al join public.finance_receipts rc on rc.id = al.receipt_id
                                                    where al.invoice_id = i.id and al.active and rc.status = 'posted'), 0), 0) from public.finance_invoices i where i.id = e.invoice_id)) as exp,
           (coalesce(e.posted_at, e.reviewed_at) at time zone 'Asia/Bangkok')::date as posted_day, (e.reviewed_at at time zone 'Asia/Bangkok')::date as reviewed_day
      from public.finance_payment_evidence e)
  select jsonb_build_object(
    'awaiting', jsonb_build_object('count', (select count(*) from a where status in ('submitted', 'confirmed')),
                                   'expected_total', (select coalesce(sum(exp), 0) from a where status in ('submitted', 'confirmed')),
                                   'ai_total', (select coalesce(sum(ai), 0) from a where status in ('submitted', 'confirmed'))),
    'ai_verified', (select count(*) from a where status = 'submitted' and ns = 'done' and nr = 'match'),
    'manual_review', (select count(*) from a where status = 'submitted' and (ns = 'failed' or (ns = 'done' and nr <> 'match' and nr not in ('duplicate_suspected', 'suspicious_slip')))),
    'suspicious', (select count(*) from a where status = 'submitted' and ns = 'done' and nr in ('duplicate_suspected', 'suspicious_slip')),
    'confirmed', jsonb_build_object('count', (select count(*) from a where status = 'confirmed'), 'amount', (select coalesce(sum(coalesce(confirmed_amount, claimed_amount)), 0) from a where status = 'confirmed')),
    'posted', jsonb_build_object('count', (select count(*) from a where status = 'verified' and (p_from is null or posted_day >= p_from) and (p_to is null or posted_day <= p_to)),
                                 'amount', (select coalesce(sum(coalesce(verified_amount, confirmed_amount, claimed_amount)), 0) from a where status = 'verified' and (p_from is null or posted_day >= p_from) and (p_to is null or posted_day <= p_to))),
    'rejected', (select count(*) from a where status = 'rejected' and (p_from is null or reviewed_day >= p_from) and (p_to is null or reviewed_day <= p_to)),
    'more_evidence', (select count(*) from a where status = 'more_evidence'))); end $$;
create or replace function pg_temp.same(p_test text, p_key text, p_from date default null, p_to date default null) returns void language plpgsql as $$
declare mine jsonb; got jsonb;
begin
  mine := pg_temp.recount(p_from, p_to);
  select v::jsonb into got from t_ctx where k = p_key;
  perform pg_temp.chk(p_test, got is not distinct from mine, 'function: ' || coalesce(got::text, 'null') || ' recount: ' || mine::text);
exception when others then perform pg_temp.chk(p_test, false, sqlerrm);
end $$;

-- ---- S4a the stage of a payment is derived (never stored) from the status, the newest analysis and its result
do $$ declare r record; bad text := ''; got text;
begin
  for r in select * from (values
      ('submitted', null, null, 'slip_submitted'), ('submitted', 'queued', null, 'slip_submitted'), ('submitted', 'running', null, 'slip_submitted'),
      ('submitted', 'done', 'match', 'ai_completed'), ('submitted', 'done', 'amount_mismatch', 'manual_review'), ('submitted', 'done', 'date_mismatch', 'manual_review'),
      ('submitted', 'done', 'time_anomaly', 'manual_review'), ('submitted', 'done', 'duplicate_suspected', 'manual_review'), ('submitted', 'done', 'suspicious_slip', 'manual_review'),
      ('submitted', 'done', 'manual_review', 'manual_review'), ('submitted', 'failed', 'manual_review', 'manual_review'), ('submitted', 'failed', null, 'manual_review'),
      ('confirmed', null, null, 'confirmed'), ('confirmed', 'done', 'match', 'confirmed'), ('confirmed', 'failed', 'manual_review', 'confirmed'), ('confirmed', 'queued', null, 'confirmed'),
      ('verified', null, null, 'posted'), ('verified', 'done', 'duplicate_suspected', 'posted'), ('rejected', null, null, 'rejected'), ('rejected', 'done', 'match', 'rejected'),
      ('more_evidence', null, null, 'more_evidence'), ('more_evidence', 'queued', null, 'more_evidence'), ('bogus', null, null, null), (null, null, null, null)) t(s, a, res, expected) loop
    got := public.finance_evidence_stage(r.s, r.a, r.res);
    if got is distinct from r.expected then bad := bad || coalesce(r.s, 'null') || '/' || coalesce(r.a, 'null') || '/' || coalesce(r.res, 'null') || '=' || coalesce(got, 'null') || ' '; end if;
  end loop;
  perform pg_temp.chk('S4a stage: every status / analysis status / result gives the stage of the design (24 cases; a stage is never stored)', bad = '', nullif(bad, ''));
exception when others then perform pg_temp.chk('S4a stage: every status / analysis status / result gives the stage of the design (24 cases; a stage is never stored)', false, sqlerrm);
end $$;
select pg_temp.q('S4a stage: it is immutable, has a fixed search_path, and is not callable from the API (not even with the service key)',
  $$select p.provolatile = 'i' and p.proconfig @> array['search_path=public']
       and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
     from pg_proc p where p.oid = to_regprocedure('public.finance_evidence_stage(text, text, text)')$$);

-- ---- S4b fixtures, phase A: three slips (one match, one duplicate, one confirmed): the summary is taken before and after, for numbers worked out by hand
reset role;
select pg_temp.runs_ok('S4 setup: the AI review is switched on, the other settings are the defaults (inside this run)',
  $q$update public.finance_settings set ai_review_enabled = true, post_requires_manager = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10$q$);
select pg_temp.runs_ok('S4 setup: the customer''s profile has a phone number different from the one given at checkout (so the two sources of a phone can be told apart)',
  format($q$update public.profiles set phone = '0899990000' where id = (select profile_id from public.finance_customers where id = %L)$q$, pg_temp.c('cust')));
select pg_temp.rs('sum0'); select pg_temp.keep4('rc0', $q$select pg_temp.recount()::text$q$);       -- the recount at the same moment
select pg_temp.asu('S'); select pg_temp.mkinv('v4_d', 210); select pg_temp.mkinv('v4_c', 240); reset role;
select pg_temp.asu('A');
select pg_temp.keep('o4_m', format($q$select public.shop_place_order('s4-key-0001', '[{"sku_code":"FG-000001","qty":2}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, 2 * pg_temp.c('P1')::numeric));
select pg_temp.keep('v4_m', $q$select (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o4_m'$q$);
select pg_temp.s4slip('s4_m', 'v4_m', 2 * pg_temp.c('P1')::numeric); select pg_temp.s4slip('s4_d', 'v4_d', 210); select pg_temp.s4slip('s4_c', 'v4_c', 235);
reset role;
select pg_temp.s4times();
insert into t_ctx select 'T1', total::text from public.shop_orders where invoice_id = pg_temp.c('v4_m')::uuid;
select pg_temp.s4done('dm', 's4_m', pg_temp.c('T1')::numeric, 'S4REF-M-0001');
select pg_temp.s4done('dd', 's4_d', 200, 'S4REF-M-0001');                 -- the same bank reference as the first slip, and 200 on a 210 invoice
select pg_temp.s4done('dc', 's4_c', 240, 'S4REF-C-0001');
select pg_temp.asu('C'); select pg_temp.conf('cc4', 's4_c', 240, 'S4-CONF-REF-1', 'S4 test'); reset role;
select pg_temp.rs('sum1');
select pg_temp.q('S4 setup: the three analyses came out as planned: a match, a duplicate (the same reference as the first slip), a match',
  $$select (select result from public.finance_slip_analysis where evidence_id = pg_temp.c('s4_m')::uuid) = 'match' and (select result from public.finance_slip_analysis where evidence_id = pg_temp.c('s4_d')::uuid) = 'duplicate_suspected'
       and (select result from public.finance_slip_analysis where evidence_id = pg_temp.c('s4_c')::uuid) = 'match' and pg_temp.ev('s4_c', 'status') = 'confirmed'$$);
select pg_temp.q('S4 summary A: 3 slips (a match, a duplicate, a confirmed one) change the counts by 3 awaiting, 1 AI verified, 0 manual review (the duplicate is counted as suspicious only), 1 suspicious, 1 confirmed, and nothing else',
  $$select pg_temp.sd('sum0', 'sum1', 'awaiting.count') = 3 and pg_temp.sd('sum0', 'sum1', 'ai_verified') = 1 and pg_temp.sd('sum0', 'sum1', 'manual_review') = 0 and pg_temp.sd('sum0', 'sum1', 'suspicious') = 1
       and pg_temp.sd('sum0', 'sum1', 'confirmed.count') = 1 and pg_temp.sd('sum0', 'sum1', 'posted.count') = 0 and pg_temp.sd('sum0', 'sum1', 'rejected') = 0 and pg_temp.sd('sum0', 'sum1', 'more_evidence') = 0
       and pg_temp.sd('sum0', 'sum1', 'posted.amount') = 0$$);
select pg_temp.q('S4 summary A: ...the money: expected = the order total + 210 + 240, what the AI read = the order total + 200 + 240, confirmed = 240',
  $$select pg_temp.sd('sum0', 'sum1', 'awaiting.expected_total') = pg_temp.c('T1')::numeric + 210 + 240 and pg_temp.sd('sum0', 'sum1', 'awaiting.ai_total') = pg_temp.c('T1')::numeric + 200 + 240
       and pg_temp.sd('sum0', 'sum1', 'confirmed.amount') = 240$$);
select pg_temp.q('S4 summary A: the summary equals an independent recount in plain SQL over the same rows (taken at the same moment, before the section)', $$select (select v::jsonb from t_ctx where k = 'sum0') = (select v::jsonb from t_ctx where k = 'rc0')$$);
select pg_temp.same('S4 summary A: ...and after the three slips', 'sum1');

-- ---- S4c fixtures, phase B: the rest of the 18 slips
reset role;
select pg_temp.runs_ok('S4 setup: the AI review is off for the first slips of phase B (they have no analysis at all)', $q$update public.finance_settings set ai_review_enabled = false$q$);
select pg_temp.asu('S');
select pg_temp.mkinv('v4_n', 290); select pg_temp.mkinv('v4_x1', 100); select pg_temp.mkinv('v4_x2', 110); select pg_temp.mkinv('v4_l', 330);
select pg_temp.mkinv('v4_s', 220); select pg_temp.mkinv('v4_f', 230); select pg_temp.mkinv('v4_p', 250); select pg_temp.mkinv('v4_r', 260); select pg_temp.mkinv('v4_e', 270);
select pg_temp.mkinv('v4_k', 280); select pg_temp.mkinv('v4_q', 300); select pg_temp.mkinv('v4_t', 310); select pg_temp.mkinv('v4_o', 320);
reset role;
select pg_temp.asu('A');
select pg_temp.s4slip('s4_n', 'v4_n', 290); select pg_temp.s4slip('s4_early', 'v4_x1', 100); select pg_temp.s4slip('s4_next', 'v4_x2', 110); select pg_temp.s4slip('s4_l', 'v4_l', 330);
reset role;
select pg_temp.runs_ok('S4 setup: the AI review is on again', $q$update public.finance_settings set ai_review_enabled = true$q$);
select pg_temp.asu('A');
select pg_temp.keep('o4_a', format($q$select public.shop_place_order('s4-key-0002', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')::numeric));
select pg_temp.keep('v4_a', $q$select (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'o4_a'$q$);
select pg_temp.s4slip('s4_a', 'v4_a', 2 * pg_temp.c('P1')::numeric);       -- the customer shows twice the order's total
select pg_temp.s4slip('s4_s', 'v4_s', 220); select pg_temp.s4slip('s4_f', 'v4_f', 230); select pg_temp.s4slip('s4_p', 'v4_p', 245); select pg_temp.s4slip('s4_r', 'v4_r', 260);
select pg_temp.s4slip('s4_e', 'v4_e', 270); select pg_temp.s4slip('s4_q', 'v4_q', 300, 'S4CLAIM-0001'); select pg_temp.s4slip('s4_t', 'v4_t', 310);
select pg_temp.s4slip('s4_o1', 'v4_o', 320); select pg_temp.s4slip('s4_o2', 'v4_o', 320);
reset role;
select pg_temp.s4times();
select pg_temp.s4done('da', 's4_a', 2 * pg_temp.c('P1')::numeric, 'S4REF-A-0001');
select pg_temp.s4done('ds', 's4_s', 220, 'S4REF-S-0001', 0.95, '{}'::jsonb, pg_temp.qrok(jsonb_build_object('trans_ref', 'S4REF-S-0001', 'crc_ok', false)));
reset role; set local role service_role;
select pg_temp.keep('df', format($q$select public.finance_analysis_fail(%L, 'S4 no API key', 'claude-haiku-5-5')::text$q$, pg_temp.aidl('s4_f')));
reset role;
select pg_temp.s4done('dp', 's4_p', 250, 'S4REF-P-0001');
select pg_temp.s4done('dr', 's4_r', 260, 'S4REF-R-0001');
select pg_temp.s4done('dt1', 's4_t', 300, 'S4REF-T-0001');                 -- attempt 1: the slip shows 300 on a 310 invoice
select pg_temp.asu('C'); select pg_temp.keep('rt2', format($q$select public.finance_request_analysis(%L)::text$q$, pg_temp.c('s4_t'))); reset role;
select pg_temp.s4done('dt2', 's4_t', 310, 'S4REF-T-0001');                 -- attempt 2: the same slip read again, now right
select pg_temp.rl('L_t2', pg_temp.w());
select pg_temp.asu('C'); select pg_temp.keep('rt3', format($q$select public.finance_request_analysis(%L)::text$q$, pg_temp.c('s4_t'))); reset role;   -- attempt 3 waits
select pg_temp.asu('C');
select pg_temp.conf('cp4', 's4_p', 250, 'S4-POST-REF-1', 'S4 test');
select pg_temp.post('pp4', 's4_p');
select pg_temp.runs_ok('S4 setup: s4_r is rejected', format($q$select public.finance_reject_evidence(%L, 'S4 not our transfer')$q$, pg_temp.c('s4_r')));
select pg_temp.runs_ok('S4 setup: s4_e is sent back for more evidence', format($q$select public.finance_request_more_evidence(%L, 'S4 please send a clearer slip')$q$, pg_temp.c('s4_e')));
select pg_temp.runs_ok('S4 setup: s4_o1 is rejected', format($q$select public.finance_reject_evidence(%L, 'S4 wrong order')$q$, pg_temp.c('s4_o1')));
select pg_temp.keep('vl4', format($q$select public.finance_verify_evidence(%L, 200, 'S4-LEGACY-0001', now(), 'legacy one step')::text$q$, pg_temp.c('s4_l')));
select pg_temp.rec('rk4', 'v4_k', 'cash', 80, null, 'S4 cash at the counter');
reset role;
select pg_temp.eid('s4_k', 'rk4');
select pg_temp.s4times();                        -- (the cash entry has its key only now)
-- the days of the money events, on the Bangkok clock: posted (Post) on the 10th at the last microsecond, the legacy one-step slip (no posted_at) on the 11th at midnight,
-- rejected on the 10th at midnight and on the 11th at the last microsecond
select pg_temp.runs_ok('S4 setup: s4_p was posted at 2031-03-10 23:59:59.999999+07', format($q$update public.finance_payment_evidence set posted_at = timestamptz '2031-03-10 23:59:59.999999+07', reviewed_at = timestamptz '2031-03-10 23:59:59.999999+07' where id = %L$q$, pg_temp.c('s4_p')));
select pg_temp.runs_ok('S4 setup: s4_l (one-step, no posted_at) was verified at 2031-03-11 00:00:00+07', format($q$update public.finance_payment_evidence set reviewed_at = timestamptz '2031-03-11 00:00:00+07' where id = %L$q$, pg_temp.c('s4_l')));
select pg_temp.runs_ok('S4 setup: s4_r was rejected at 2031-03-10 00:00:00+07', format($q$update public.finance_payment_evidence set reviewed_at = timestamptz '2031-03-10 00:00:00+07' where id = %L$q$, pg_temp.c('s4_r')));
select pg_temp.runs_ok('S4 setup: s4_o1 was rejected at 2031-03-11 23:59:59.999999+07', format($q$update public.finance_payment_evidence set reviewed_at = timestamptz '2031-03-11 23:59:59.999999+07' where id = %L$q$, pg_temp.c('s4_o1')));
select pg_temp.rs('sum2');
select pg_temp.rl('L_all', pg_temp.w());
select pg_temp.q('S4 setup: the 18 slips, their 17 invoices and the 15 analysis rows (10 finished or failed, 5 waiting) exist',
  $$select (select count(*) from t_ctx where left(k, 3) = 's4_' and v is not null) = 18 and (select count(*) from t_ctx where left(k, 3) = 'v4_' and v is not null) = 17
       and (select count(*) from public.finance_slip_analysis where evidence_id in (select v::uuid from t_ctx where left(k, 3) = 's4_')) = 15$$);

-- ---- S4d who may read: staff only (viewer and up). Customers (also for their own slip) and signed-out visitors are refused.
select pg_temp.asu('A');
select pg_temp.err_like('S4d customer: A cannot read the review list', $q$select public.finance_review_list('{}'::jsonb, 50, 0)$q$, '%not allowed%');
select pg_temp.err_like('S4d customer: A cannot read the review summary', $q$select public.finance_review_summary(null, null)$q$, '%not allowed%');
select pg_temp.err_like('S4d customer: A cannot read the detail of their own slip', format($q$select public.finance_review_detail(%L)$q$, pg_temp.c('s4_m')), '%not allowed%');
select pg_temp.err_like('S4d customer: A cannot read the detail of an unknown slip either (the refusal does not tell whether it exists)', $q$select public.finance_review_detail(gen_random_uuid())$q$, '%not allowed%');
select pg_temp.err_like('S4d customer: A cannot read the review settings', $q$select public.finance_review_settings()$q$, '%not allowed%');
select pg_temp.err_like('S4d customer: a bad filter is still "not allowed" (the permission is checked first)', $q$select public.finance_review_list('[1]'::jsonb, 50, 0)$q$, '%not allowed%');
select pg_temp.asu('B');
select pg_temp.err_like('S4d customer: B cannot read the review list', $q$select public.finance_review_list('{}'::jsonb, 50, 0)$q$, '%not allowed%');
select pg_temp.err_like('S4d customer: B cannot read the review summary', $q$select public.finance_review_summary(null, null)$q$, '%not allowed%');
select pg_temp.err_like('S4d customer: B cannot read the detail of A''s slip', format($q$select public.finance_review_detail(%L)$q$, pg_temp.c('s4_m')), '%not allowed%');
select pg_temp.err_like('S4d customer: B cannot read the review settings', $q$select public.finance_review_settings()$q$, '%not allowed%');
reset role; set local role anon;
select pg_temp.err_like('S4d anon: a signed-out visitor cannot read the review list', $q$select public.finance_review_list('{}'::jsonb, 50, 0)$q$, '%permission denied%');
select pg_temp.err_like('S4d anon: ...nor the summary', $q$select public.finance_review_summary(null, null)$q$, '%permission denied%');
select pg_temp.err_like('S4d anon: ...nor the detail', $q$select public.finance_review_detail(gen_random_uuid())$q$, '%permission denied%');
select pg_temp.err_like('S4d anon: ...nor the settings', $q$select public.finance_review_settings()$q$, '%permission denied%');
reset role;
select pg_temp.asu('D');       -- a clerk
select pg_temp.runs_ok('S4d staff: a clerk can read the list', $q$select public.finance_review_list('{}'::jsonb, 5, 0)$q$);
select pg_temp.runs_ok('S4d staff: a clerk can read the summary', $q$select public.finance_review_summary(null, null)$q$);
select pg_temp.runs_ok('S4d staff: a clerk can read the detail', format($q$select public.finance_review_detail(%L)$q$, pg_temp.c('s4_m')));
select pg_temp.runs_ok('S4d staff: a clerk can read the settings', $q$select public.finance_review_settings()$q$);
reset role;
select pg_temp.runs_ok('S4d setup: the clerk becomes a viewer (the lowest staff role)', format($q$update public.finance_staff_roles set role = 'viewer' where user_id = %L$q$, pg_temp.c('D')));
select pg_temp.asu('D');
select pg_temp.runs_ok('S4d staff: a viewer can read the list', $q$select public.finance_review_list('{}'::jsonb, 5, 0)$q$);
select pg_temp.runs_ok('S4d staff: a viewer can read the summary', $q$select public.finance_review_summary(null, null)$q$);
select pg_temp.runs_ok('S4d staff: a viewer can read the detail', format($q$select public.finance_review_detail(%L)$q$, pg_temp.c('s4_m')));
select pg_temp.runs_ok('S4d staff: a viewer can read the settings', $q$select public.finance_review_settings()$q$);
select pg_temp.err_like('S4d staff: a viewer still cannot change the settings (the writer is the manager''s)', $q$select public.finance_save_review_settings('{"post_requires_manager": true}')$q$, '%not allowed%');
select pg_temp.asu('C');       -- a verifier
select pg_temp.runs_ok('S4d staff: a verifier can read the list', $q$select public.finance_review_list('{}'::jsonb, 5, 0)$q$);
select pg_temp.runs_ok('S4d staff: a verifier can read the detail', format($q$select public.finance_review_detail(%L)$q$, pg_temp.c('s4_m')));
select pg_temp.asu('S');       -- a manager
select pg_temp.runs_ok('S4d staff: a manager can read the list', $q$select public.finance_review_list('{}'::jsonb, 5, 0)$q$);
select pg_temp.runs_ok('S4d staff: a manager can read the summary', $q$select public.finance_review_summary(null, null)$q$);
reset role;
select pg_temp.runs_ok('S4d setup: the viewer is a clerk again', format($q$update public.finance_staff_roles set role = 'clerk' where user_id = %L$q$, pg_temp.c('D')));
-- a staff member whose profile is disabled has no finance role at all (the verifier C and the clerk D, each with the role row still there): all four reads refuse them
select pg_temp.as_user(pg_temp.c('S')::uuid);       -- (the signed-in claims are the manager's: only a SUPER_ADMIN may change another user's status)
select pg_temp.runs_ok('S4d setup: the verifier''s and the clerk''s profiles are disabled (inside this run; their staff role rows stay)', format($q$update public.profiles set status = 'disabled' where id in (%L, %L)$q$, pg_temp.c('C'), pg_temp.c('D')));
select pg_temp.asu('C');
select pg_temp.err_like('S4d disabled: a verifier with a disabled profile cannot read the list', $q$select public.finance_review_list('{}'::jsonb, 5, 0)$q$, '%not allowed%');
select pg_temp.err_like('S4d disabled: ...nor the summary', $q$select public.finance_review_summary(null, null)$q$, '%not allowed%');
select pg_temp.err_like('S4d disabled: ...nor the detail', format($q$select public.finance_review_detail(%L)$q$, pg_temp.c('s4_m')), '%not allowed%');
select pg_temp.err_like('S4d disabled: ...nor the settings', $q$select public.finance_review_settings()$q$, '%not allowed%');
select pg_temp.asu('D');
select pg_temp.err_like('S4d disabled: a clerk with a disabled profile cannot read the list', $q$select public.finance_review_list('{}'::jsonb, 5, 0)$q$, '%not allowed%');
select pg_temp.err_like('S4d disabled: ...nor the summary', $q$select public.finance_review_summary(null, null)$q$, '%not allowed%');
select pg_temp.err_like('S4d disabled: ...nor the detail', format($q$select public.finance_review_detail(%L)$q$, pg_temp.c('s4_m')), '%not allowed%');
select pg_temp.err_like('S4d disabled: ...nor the settings', $q$select public.finance_review_settings()$q$, '%not allowed%');
reset role;
select pg_temp.as_user(pg_temp.c('S')::uuid);       -- (the signed-in claims are the manager's: only a SUPER_ADMIN may change another user's status)
select pg_temp.runs_ok('S4d setup: the profiles are active again', format($q$update public.profiles set status = 'active' where id in (%L, %L)$q$, pg_temp.c('C'), pg_temp.c('D')));
select pg_temp.asu('C');
select pg_temp.runs_ok('S4d disabled: ...and the verifier reads again once the profile is active', $q$select public.finance_review_list('{}'::jsonb, 5, 0)$q$);
reset role;

-- ---- S4e the list: stages, fields, ordering. First the newest-attempt rule, before a third attempt was asked for
select pg_temp.q('S4e newest attempt: while attempt 2 of s4_t is done and matched the stage is ai_completed (the newest attempt decides), with the result of attempt 2 and no reasons',
  $$select pg_temp.li('L_t2', 's4_t', 'stage') = 'ai_completed' and pg_temp.li('L_t2', 's4_t', 'ai_result') = 'match' and pg_temp.li('L_t2', 's4_t', 'ai_status') = 'done'
       and pg_temp.lj('L_t2', 's4_t', 'reasons') = '[]'::jsonb$$);
select pg_temp.q('S4e: the window holds exactly the 18 slips of this section, and the total says so',
  $$select pg_temp.lset('L_all') = pg_temp.s4all() and pg_temp.lt('L_all') = 18 and pg_temp.ln('L_all') = 18$$);
select pg_temp.q('S4e: an item has exactly the 28 keys of the contract',
  $$select (select array_agg(k order by k) from jsonb_object_keys((select (v::jsonb -> 'items' -> 0) from t_ctx where k = 'L_all')) k)
       = array['ai_amount', 'ai_confidence', 'ai_result', 'ai_status', 'ai_transfer_at', 'claimed_amount', 'confirmed_amount', 'confirmed_bank_ref', 'created_at', 'customer_name', 'customer_phone',
               'evidence_id', 'expected_amount', 'invoice_amount', 'invoice_id', 'invoice_no', 'method', 'order_created_at', 'order_id', 'order_no', 'order_total', 'outstanding', 'paid', 'posted_at',
               'reasons', 'source', 'stage', 'status']$$);
select pg_temp.q('S4e order: newest first by created_at, then by id (the same order as a plain SQL select over the window)',
  $$select pg_temp.lids('L_all') = (select array_agg(id::text order by created_at desc, id) from public.finance_payment_evidence where created_at >= timestamptz '2031-03-09 00:00:00+07' and created_at < timestamptz '2031-03-13 00:00:00+07')$$);
-- the stage of every slip
do $$ declare r record;
begin
  for r in select * from (values ('s4_n', 'slip_submitted'), ('s4_q', 'slip_submitted'), ('s4_early', 'slip_submitted'), ('s4_next', 'slip_submitted'), ('s4_o2', 'slip_submitted'),
        ('s4_t', 'slip_submitted'), ('s4_m', 'ai_completed'), ('s4_a', 'manual_review'), ('s4_d', 'manual_review'), ('s4_s', 'manual_review'), ('s4_f', 'manual_review'),
        ('s4_c', 'confirmed'), ('s4_k', 'confirmed'), ('s4_p', 'posted'), ('s4_l', 'posted'), ('s4_r', 'rejected'), ('s4_o1', 'rejected'), ('s4_e', 'more_evidence')) t(k, st) loop
    perform pg_temp.eqf('S4e stage: ' || r.k || ' is ' || r.st, 'L_all', r.k, 'stage', r.st);
  end loop;
end $$;
select pg_temp.q('S4e stage: before any analysis (no analysis row, or one still queued) the slip is slip_submitted; after a match ai_completed; after an amount mismatch manual_review; after Confirm confirmed; after Post posted',
  $$select pg_temp.li('L_all', 's4_n', 'stage') = 'slip_submitted' and pg_temp.li('L_all', 's4_q', 'stage') = 'slip_submitted' and pg_temp.li('L_all', 's4_m', 'stage') = 'ai_completed'
       and pg_temp.li('L_all', 's4_a', 'stage') = 'manual_review' and pg_temp.li('L_all', 's4_a', 'ai_result') = 'amount_mismatch' and pg_temp.li('L_all', 's4_c', 'stage') = 'confirmed' and pg_temp.li('L_all', 's4_p', 'stage') = 'posted'$$);
select pg_temp.q('S4e newest attempt: s4_t has 3 attempts, the third is waiting: the stage goes back to slip_submitted and the status is queued, while the amount and time still come from the newest finished one (attempt 2)',
  $$select pg_temp.li('L_all', 's4_t', 'stage') = 'slip_submitted' and pg_temp.li('L_all', 's4_t', 'ai_status') = 'queued' and pg_temp.li('L_all', 's4_t', 'ai_result') is null
       and pg_temp.li('L_all', 's4_t', 'ai_amount')::numeric = 310 and pg_temp.li('L_all', 's4_t', 'ai_confidence')::numeric = 0.95 and pg_temp.li('L_all', 's4_t', 'ai_transfer_at') like '2031-03-10T14:03%'$$);
-- the fields of the AI slips
select pg_temp.eqf('S4e fields: s4_m status', 'L_all', 's4_m', 'status', 'submitted');
select pg_temp.eqf('S4e fields: s4_m is a customer slip paid by transfer', 'L_all', 's4_m', 'source', 'customer_slip');
select pg_temp.eqf('S4e fields: s4_m method', 'L_all', 's4_m', 'method', 'transfer');
select pg_temp.eqf('S4e fields: s4_m AI result', 'L_all', 's4_m', 'ai_result', 'match');
select pg_temp.eqf('S4e fields: s4_m AI status', 'L_all', 's4_m', 'ai_status', 'done');
select pg_temp.eqn('S4e fields: s4_m AI confidence', 'L_all', 's4_m', 'ai_confidence', 0.95);
select pg_temp.eqn('S4e fields: s4_m AI amount is the order total', 'L_all', 's4_m', 'ai_amount', (select total from public.shop_orders where invoice_id = pg_temp.c('v4_m')::uuid));
select pg_temp.q('S4e fields: s4_m AI transfer time is the text the reader gave (normalised on the server), the reasons are an empty list',
  $$select pg_temp.li('L_all', 's4_m', 'ai_transfer_at') = '2031-03-10T14:03:00+07:00' and pg_temp.lj('L_all', 's4_m', 'reasons') = '[]'::jsonb$$);
select pg_temp.eqn('S4e fields: s4_m claimed amount', 'L_all', 's4_m', 'claimed_amount', 2 * pg_temp.c('P1')::numeric);
select pg_temp.eqn('S4e fields: s4_m expected amount (the newest finished analysis''s snapshot)', 'L_all', 's4_m', 'expected_amount', pg_temp.c('T1')::numeric);
select pg_temp.q('S4e fields: s4_m has a shop order: id, number, date and total come from the order; the customer''s phone is the order''s contact phone',
  format($$select pg_temp.li('L_all', 's4_m', 'order_id') = o.id::text and pg_temp.li('L_all', 's4_m', 'order_no') = o.order_no and pg_temp.li('L_all', 's4_m', 'order_total')::numeric = o.total
       and (pg_temp.li('L_all', 's4_m', 'order_created_at'))::timestamptz = o.created_at and pg_temp.li('L_all', 's4_m', 'customer_phone') = '0812345678'
       from public.shop_orders o where o.invoice_id = %L$$, pg_temp.c('v4_m')));
select pg_temp.q('S4e fields: invoice number and amount, customer name, nothing paid and everything outstanding for s4_m',
  $$select pg_temp.li('L_all', 's4_m', 'invoice_no') = pg_temp.inv('v4_m', 'invoice_no') and pg_temp.li('L_all', 's4_m', 'invoice_id') = pg_temp.c('v4_m') and pg_temp.li('L_all', 's4_m', 'invoice_amount')::numeric = pg_temp.inv('v4_m', 'amount')::numeric
       and pg_temp.li('L_all', 's4_m', 'customer_name') = (select name from public.finance_customers where id = pg_temp.c('cust')::uuid)
       and pg_temp.li('L_all', 's4_m', 'paid')::numeric = 0 and pg_temp.li('L_all', 's4_m', 'outstanding')::numeric = pg_temp.inv('v4_m', 'amount')::numeric$$);
select pg_temp.q('S4e fields: a manual invoice (s4_d) has no order: the four order fields are null; the phone is the customer profile''s',
  $$select pg_temp.lj('L_all', 's4_d', 'order_id') = 'null'::jsonb and pg_temp.lj('L_all', 's4_d', 'order_no') = 'null'::jsonb and pg_temp.lj('L_all', 's4_d', 'order_created_at') = 'null'::jsonb and pg_temp.lj('L_all', 's4_d', 'order_total') = 'null'::jsonb
       and pg_temp.lj('L_all', 's4_d', 'customer_phone') = to_jsonb('0899990000'::text)$$);
select pg_temp.eqf('S4e fields: s4_d is a duplicate', 'L_all', 's4_d', 'ai_result', 'duplicate_suspected');
select pg_temp.q('S4e fields: s4_d lists its reason codes (the duplicate and the amount under, both applied), what the AI read (200) and what the invoice expects (210)',
  $$select pg_temp.lj('L_all', 's4_d', 'reasons') @> '["DUPLICATE_REFERENCE"]'::jsonb and pg_temp.lj('L_all', 's4_d', 'reasons') @> '["AMOUNT_UNDER"]'::jsonb and pg_temp.li('L_all', 's4_d', 'ai_amount')::numeric = 200
       and pg_temp.li('L_all', 's4_d', 'expected_amount')::numeric = 210 and pg_temp.li('L_all', 's4_d', 'claimed_amount')::numeric = 210$$);
select pg_temp.q('S4e fields: s4_a (twice the order) reads AMOUNT_OVER, the AI amount is twice and the expected amount the order''s',
  $$select pg_temp.lj('L_all', 's4_a', 'reasons') @> '["AMOUNT_OVER"]'::jsonb and pg_temp.li('L_all', 's4_a', 'ai_amount')::numeric = 2 * pg_temp.c('P1')::numeric and pg_temp.li('L_all', 's4_a', 'expected_amount')::numeric = pg_temp.c('P1')::numeric$$);
select pg_temp.q('S4e fields: s4_s is a suspicious slip with QR_BAD_CRC among its reasons', $$select pg_temp.li('L_all', 's4_s', 'ai_result') = 'suspicious_slip' and pg_temp.lj('L_all', 's4_s', 'reasons') @> '["QR_BAD_CRC"]'::jsonb$$);
select pg_temp.q('S4e fields: s4_f (the reader failed) is manual review with AI status failed, no amount, no confidence, the reason AI_UNAVAILABLE, and the invoice amount expected',
  $$select pg_temp.li('L_all', 's4_f', 'ai_status') = 'failed' and pg_temp.li('L_all', 's4_f', 'ai_result') = 'manual_review' and pg_temp.lj('L_all', 's4_f', 'ai_amount') = 'null'::jsonb and pg_temp.lj('L_all', 's4_f', 'ai_confidence') = 'null'::jsonb
       and pg_temp.lj('L_all', 's4_f', 'ai_transfer_at') = 'null'::jsonb and pg_temp.lj('L_all', 's4_f', 'reasons') = '["AI_UNAVAILABLE"]'::jsonb and pg_temp.li('L_all', 's4_f', 'expected_amount')::numeric = 230$$);
select pg_temp.q('S4e fields: s4_n (made while the AI review was off) has no analysis at all: every AI field is null, the reasons are an empty list, the invoice amount is expected',
  $$select pg_temp.lj('L_all', 's4_n', 'ai_status') = 'null'::jsonb and pg_temp.lj('L_all', 's4_n', 'ai_result') = 'null'::jsonb and pg_temp.lj('L_all', 's4_n', 'ai_amount') = 'null'::jsonb and pg_temp.lj('L_all', 's4_n', 'ai_confidence') = 'null'::jsonb
       and pg_temp.lj('L_all', 's4_n', 'reasons') = '[]'::jsonb and pg_temp.li('L_all', 's4_n', 'expected_amount')::numeric = 290$$);
select pg_temp.q('S4e fields: s4_q (waiting for the reader) has an AI status queued and nothing else from the AI; its claimed reference was kept on the slip',
  $$select pg_temp.li('L_all', 's4_q', 'ai_status') = 'queued' and pg_temp.lj('L_all', 's4_q', 'ai_result') = 'null'::jsonb and pg_temp.lj('L_all', 's4_q', 'ai_amount') = 'null'::jsonb and pg_temp.ev('s4_q', 'claimed_ref') = 'S4CLAIM-0001'$$);
select pg_temp.q('S4e fields: s4_c (confirmed) shows what the customer claimed (235) next to what the bank showed (240), nothing paid yet, 240 outstanding, not posted',
  $$select pg_temp.li('L_all', 's4_c', 'confirmed_amount')::numeric = 240 and pg_temp.li('L_all', 's4_c', 'claimed_amount')::numeric = 235 and pg_temp.li('L_all', 's4_c', 'confirmed_bank_ref') = 'S4-CONF-REF-1' and pg_temp.lj('L_all', 's4_c', 'posted_at') = 'null'::jsonb
       and pg_temp.li('L_all', 's4_c', 'paid')::numeric = 0 and pg_temp.li('L_all', 's4_c', 'outstanding')::numeric = 240 and pg_temp.li('L_all', 's4_c', 'expected_amount')::numeric = 240$$);
select pg_temp.q('S4e fields: s4_p (posted) shows what the customer claimed (245) next to the confirmed values (250), the time it was posted, 250 paid and nothing outstanding',
  $$select pg_temp.li('L_all', 's4_p', 'status') = 'verified' and pg_temp.li('L_all', 's4_p', 'confirmed_amount')::numeric = 250 and pg_temp.li('L_all', 's4_p', 'claimed_amount')::numeric = 245 and pg_temp.li('L_all', 's4_p', 'confirmed_bank_ref') = 'S4-POST-REF-1'
       and (pg_temp.li('L_all', 's4_p', 'posted_at'))::timestamptz = timestamptz '2031-03-10 23:59:59.999999+07' and pg_temp.li('L_all', 's4_p', 'paid')::numeric = 250 and pg_temp.li('L_all', 's4_p', 'outstanding')::numeric = 0
       and pg_temp.li('L_all', 's4_p', 'expected_amount')::numeric = 250$$);
select pg_temp.q('S4e fields: s4_l (the old one-step verify: verified, no posted_at) is posted with a part payment: 200 paid, 130 outstanding (and, with no analysis, 130 is also what it expects: what the invoice still owes)',
  $$select pg_temp.li('L_all', 's4_l', 'status') = 'verified' and pg_temp.lj('L_all', 's4_l', 'posted_at') = 'null'::jsonb and pg_temp.li('L_all', 's4_l', 'paid')::numeric = 200 and pg_temp.li('L_all', 's4_l', 'outstanding')::numeric = 130
       and pg_temp.li('L_all', 's4_l', 'expected_amount')::numeric = 130$$);
select pg_temp.q('S4e fields: s4_k (cash recorded by staff) is a staff entry paid in cash, confirmed with 80, no analysis, the invoice''s 280 outstanding',
  $$select pg_temp.li('L_all', 's4_k', 'source') = 'staff_entry' and pg_temp.li('L_all', 's4_k', 'method') = 'cash' and pg_temp.li('L_all', 's4_k', 'status') = 'confirmed' and pg_temp.li('L_all', 's4_k', 'confirmed_amount')::numeric = 80
       and pg_temp.li('L_all', 's4_k', 'claimed_amount')::numeric = 80 and pg_temp.lj('L_all', 's4_k', 'ai_status') = 'null'::jsonb and pg_temp.li('L_all', 's4_k', 'outstanding')::numeric = 280 and pg_temp.li('L_all', 's4_k', 'expected_amount')::numeric = 280$$);
select pg_temp.q('S4e fields: the created_at of an item is the slip''s own', $$select (pg_temp.li('L_all', 's4_early', 'created_at'))::timestamptz = timestamptz '2031-03-10 06:30:00+07' and (pg_temp.li('L_all', 's4_o2', 'created_at'))::timestamptz = timestamptz '2031-03-10 23:59:59.999999+07'$$);

-- ---- S4f the filters. Every one is used inside the window of the fixtures, so the answers are exact.
select pg_temp.rl('L_st1', pg_temp.w('{"stage": ["slip_submitted"]}')); select pg_temp.rl('L_st2', pg_temp.w('{"stage": ["ai_completed"]}')); select pg_temp.rl('L_st3', pg_temp.w('{"stage": ["manual_review"]}'));
select pg_temp.rl('L_st4', pg_temp.w('{"stage": ["confirmed"]}')); select pg_temp.rl('L_st5', pg_temp.w('{"stage": ["posted"]}')); select pg_temp.rl('L_st6', pg_temp.w('{"stage": ["rejected"]}'));
select pg_temp.rl('L_st7', pg_temp.w('{"stage": ["more_evidence"]}')); select pg_temp.rl('L_st8', pg_temp.w('{"stage": ["confirmed", "posted"]}')); select pg_temp.rl('L_st9', pg_temp.w('{"stage": "manual_review"}'));
select pg_temp.q('S4f stage: slip_submitted narrows the 18 to the 6 that wait for the AI or have no analysis', $$select pg_temp.lset('L_st1') = pg_temp.ks('s4_n', 's4_q', 's4_t', 's4_early', 's4_next', 's4_o2') and pg_temp.lt('L_st1') = 6$$);
select pg_temp.q('S4f stage: ai_completed is the one matched slip', $$select pg_temp.lset('L_st2') = 's4_m' and pg_temp.lt('L_st2') = 1$$);
select pg_temp.q('S4f stage: manual_review is the amount mismatch, the duplicate, the suspicious slip and the failed reader', $$select pg_temp.lset('L_st3') = pg_temp.ks('s4_a', 's4_d', 's4_s', 's4_f') and pg_temp.lt('L_st3') = 4$$);
select pg_temp.q('S4f stage: confirmed is the confirmed slip and the cash entry', $$select pg_temp.lset('L_st4') = pg_temp.ks('s4_c', 's4_k') and pg_temp.lt('L_st4') = 2$$);
select pg_temp.q('S4f stage: posted is the posted slip and the one-step verified one', $$select pg_temp.lset('L_st5') = pg_temp.ks('s4_p', 's4_l') and pg_temp.lt('L_st5') = 2$$);
select pg_temp.q('S4f stage: rejected', $$select pg_temp.lset('L_st6') = pg_temp.ks('s4_r', 's4_o1') and pg_temp.lt('L_st6') = 2$$);
select pg_temp.q('S4f stage: more_evidence', $$select pg_temp.lset('L_st7') = 's4_e' and pg_temp.lt('L_st7') = 1$$);
select pg_temp.q('S4f stage: two stages together are an OR', $$select pg_temp.lset('L_st8') = pg_temp.ks('s4_c', 's4_k', 's4_p', 's4_l') and pg_temp.lt('L_st8') = 4$$);
select pg_temp.q('S4f stage: a single string works like a list of one', $$select pg_temp.lset('L_st9') = pg_temp.lset('L_st3') and pg_temp.lt('L_st9') = 4$$);
select pg_temp.q('S4f stage: the seven stages are a partition of the 18 slips (6 + 1 + 4 + 2 + 2 + 2 + 1)', $$select pg_temp.lt('L_st1') + pg_temp.lt('L_st2') + pg_temp.lt('L_st3') + pg_temp.lt('L_st4') + pg_temp.lt('L_st5') + pg_temp.lt('L_st6') + pg_temp.lt('L_st7') = 18$$);
select pg_temp.rl('L_ar1', pg_temp.w('{"ai_result": ["match"]}')); select pg_temp.rl('L_ar2', pg_temp.w('{"ai_result": ["amount_mismatch"]}'));
select pg_temp.rl('L_ar3', pg_temp.w('{"ai_result": ["duplicate_suspected", "suspicious_slip"]}')); select pg_temp.rl('L_ar4', pg_temp.w('{"ai_result": ["manual_review"]}')); select pg_temp.rl('L_ar5', pg_temp.w('{"ai_result": ["date_mismatch", "time_anomaly"]}'));
select pg_temp.q('S4f ai_result: match is judged by the newest attempt (s4_t''s third attempt waits, so it is not there; the confirmed, posted and rejected slips that matched are)', $$select pg_temp.lset('L_ar1') = pg_temp.ks('s4_m', 's4_c', 's4_p', 's4_r') and pg_temp.lt('L_ar1') = 4$$);
select pg_temp.q('S4f ai_result: amount_mismatch', $$select pg_temp.lset('L_ar2') = 's4_a' and pg_temp.lt('L_ar2') = 1$$);
select pg_temp.q('S4f ai_result: duplicate_suspected or suspicious_slip', $$select pg_temp.lset('L_ar3') = pg_temp.ks('s4_d', 's4_s') and pg_temp.lt('L_ar3') = 2$$);
select pg_temp.q('S4f ai_result: manual_review is the failed reader''s result', $$select pg_temp.lset('L_ar4') = 's4_f' and pg_temp.lt('L_ar4') = 1$$);
select pg_temp.q('S4f ai_result: results nobody has give an empty answer with a total of 0', $$select pg_temp.lset('L_ar5') = '' and pg_temp.lt('L_ar5') = 0 and pg_temp.ln('L_ar5') = 0$$);
select pg_temp.rl('L_rs1', pg_temp.w('{"reason": "AMOUNT_OVER"}')); select pg_temp.rl('L_rs2', pg_temp.w('{"reason": "DUPLICATE_REFERENCE"}')); select pg_temp.rl('L_rs3', pg_temp.w('{"reason": "QR_BAD_CRC"}'));
select pg_temp.rl('L_rs4', pg_temp.w('{"reason": "AI_UNAVAILABLE"}')); select pg_temp.rl('L_rs5', pg_temp.w('{"reason": "AMOUNT_UNDER"}')); select pg_temp.rl('L_rs6', pg_temp.w('{"reason": "NO_SUCH_REASON"}'));
select pg_temp.q('S4f reason: AMOUNT_OVER', $$select pg_temp.lset('L_rs1') = 's4_a' and pg_temp.lt('L_rs1') = 1$$);
select pg_temp.q('S4f reason: DUPLICATE_REFERENCE', $$select pg_temp.lset('L_rs2') = 's4_d' and pg_temp.lt('L_rs2') = 1$$);
select pg_temp.q('S4f reason: QR_BAD_CRC', $$select pg_temp.lset('L_rs3') = 's4_s' and pg_temp.lt('L_rs3') = 1$$);
select pg_temp.q('S4f reason: AI_UNAVAILABLE (the failed reader)', $$select pg_temp.lset('L_rs4') = 's4_f' and pg_temp.lt('L_rs4') = 1$$);
select pg_temp.q('S4f reason: only the newest attempt counts (attempt 1 of s4_t said AMOUNT_UNDER, but the newest attempt has no reasons; s4_d''s newest says AMOUNT_UNDER)', $$select pg_temp.lset('L_rs5') = 's4_d' and pg_temp.lt('L_rs5') = 1$$);
select pg_temp.q('S4f reason: a code nobody has gives nothing', $$select pg_temp.lt('L_rs6') = 0 and pg_temp.ln('L_rs6') = 0$$);
select pg_temp.rl('L_so1', pg_temp.w('{"source": "staff_entry"}')); select pg_temp.rl('L_so2', pg_temp.w('{"source": ["customer_slip"]}')); select pg_temp.rl('L_so3', pg_temp.w('{"method": "cash"}'));
select pg_temp.rl('L_so4', pg_temp.w('{"method": ["transfer"]}')); select pg_temp.rl('L_so5', pg_temp.w('{"source": ["customer_slip", "staff_entry"], "method": ["cash", "transfer"]}')); select pg_temp.rl('L_so6', pg_temp.w('{"source": "customer_slip", "method": "cash"}'));
select pg_temp.q('S4f source: staff_entry is the cash entry', $$select pg_temp.lset('L_so1') = 's4_k' and pg_temp.lt('L_so1') = 1$$);
select pg_temp.q('S4f source: customer_slip is the other 17', $$select pg_temp.lt('L_so2') = 17 and pg_temp.lset('L_so2') not like '%s4_k%'$$);
select pg_temp.q('S4f method: cash is the cash entry; transfer the other 17', $$select pg_temp.lset('L_so3') = 's4_k' and pg_temp.lt('L_so4') = 17 and pg_temp.lset('L_so4') not like '%s4_k%'$$);
select pg_temp.q('S4f source and method: both values of both give all 18; a customer slip paid in cash does not exist', $$select pg_temp.lt('L_so5') = 18 and pg_temp.lt('L_so6') = 0$$);

-- dates are calendar dates in Bangkok, inclusive, on the slip's created_at (s4_early is 06:30 on the 10th = 23:30 UTC of the 9th; s4_next is exactly 00:00 on the 11th = 17:00 UTC of the 10th)
select pg_temp.rl('L_d1', '{"from": "2031-03-10", "to": "2031-03-10"}'); select pg_temp.rl('L_d2', '{"from": "2031-03-11", "to": "2031-03-11"}'); select pg_temp.rl('L_d3', '{"from": "2031-03-09", "to": "2031-03-09"}');
select pg_temp.rl('L_d4', '{"from": "2031-03-10"}'); select pg_temp.rl('L_d5', '{"from": "2031-03-10", "to": "2031-03-11"}'); select pg_temp.rl('L_d6', '{"from": "2031-03-11", "to": "2031-03-10"}');
select pg_temp.rl('L_d7', '{"to": "2031-03-09"}'); select pg_temp.rl('L_d8', '{"to": "2031-03-10"}'); select pg_temp.rl('L_d9', '{"from": "2031-03-12"}');
select pg_temp.q('S4f date: the 10th holds the 17 slips of that Bangkok day, the early one (23:30 UTC of the 9th) and the one at 23:59:59 included, the one at midnight of the 11th not',
  $$select pg_temp.lt('L_d1') = 17 and pg_temp.lset('L_d1') = pg_temp.ks('s4_a', 's4_c', 's4_d', 's4_e', 's4_early', 's4_f', 's4_k', 's4_l', 's4_m', 's4_n', 's4_o1', 's4_o2', 's4_p', 's4_q', 's4_r', 's4_s', 's4_t')$$);
select pg_temp.q('S4f date: the 11th holds only the slip made exactly at 00:00 Bangkok (the start of a day is inclusive)', $$select pg_temp.lset('L_d2') = 's4_next' and pg_temp.lt('L_d2') = 1$$);
select pg_temp.q('S4f date: the 9th holds none of them (the early slip belongs to the 10th, not to its UTC date)', $$select pg_temp.lset('L_d3') = '' and pg_temp.lt('L_d3') = 0$$);
select pg_temp.q('S4f date: from alone and from..to over two days hold all 18', $$select pg_temp.lset('L_d4') = pg_temp.s4all() and pg_temp.lt('L_d4') = 18 and pg_temp.lset('L_d5') = pg_temp.s4all() and pg_temp.lt('L_d5') = 18$$);
select pg_temp.q('S4f date: from after to is an empty answer, not an error', $$select pg_temp.lt('L_d6') = 0 and pg_temp.ln('L_d6') = 0$$);
select pg_temp.q('S4f date: to alone is open at the start: it holds every earlier record (a plain SQL count over the same Bangkok days agrees) and none of the section''s slips for the 9th, all but one for the 10th',
  $$select pg_temp.lset('L_d7') = '' and pg_temp.lt('L_d7') = (select count(*) from public.finance_payment_evidence where created_at < timestamptz '2031-03-10 00:00:00+07')
       and pg_temp.lt('L_d8') = (select count(*) from public.finance_payment_evidence where created_at < timestamptz '2031-03-11 00:00:00+07')
       and pg_temp.lset('L_d8') = pg_temp.ks('s4_a', 's4_c', 's4_d', 's4_e', 's4_early', 's4_f', 's4_k', 's4_l', 's4_m', 's4_n', 's4_o1', 's4_o2', 's4_p', 's4_q', 's4_r', 's4_s', 's4_t') $$);
select pg_temp.q('S4f date: nothing is on or after the 12th yet', $$select pg_temp.lt('L_d9') = 0$$);

-- search: order number, invoice number, customer name (ilike), the confirmed / claimed / AI reference (also written differently); a wildcard is not a wildcard
select pg_temp.rl('L_q1', pg_temp.w(jsonb_build_object('search', (select order_no from public.shop_orders where invoice_id = pg_temp.c('v4_m')::uuid))));
select pg_temp.rl('L_q2', pg_temp.w(jsonb_build_object('search', lower((select order_no from public.shop_orders where invoice_id = pg_temp.c('v4_a')::uuid)))));
select pg_temp.rl('L_q3', pg_temp.w(jsonb_build_object('search', pg_temp.inv('v4_d', 'invoice_no'))));
select pg_temp.rl('L_q4', pg_temp.w(jsonb_build_object('search', (select name from public.finance_customers where id = pg_temp.c('cust')::uuid))));
select pg_temp.rl('L_q5', pg_temp.w(jsonb_build_object('search', upper((select name from public.finance_customers where id = pg_temp.c('cust')::uuid)))));
select pg_temp.rl('L_q6', pg_temp.w('{"search": "S4-CONF-REF-1"}')); select pg_temp.rl('L_q7', pg_temp.w('{"search": "s4-conf-ref"}')); select pg_temp.rl('L_q8', pg_temp.w('{"search": "s4 conf ref 1"}'));
select pg_temp.rl('L_q9', pg_temp.w('{"search": "S4CLAIM"}')); select pg_temp.rl('L_q10', pg_temp.w('{"search": "S4REF-M-0001"}')); select pg_temp.rl('L_q11', pg_temp.w('{"search": "s4ref-t"}'));
select pg_temp.rl('L_q12', pg_temp.w('{"search": "%"}')); select pg_temp.rl('L_q13', pg_temp.w('{"search": "S4%"}')); select pg_temp.rl('L_q14', pg_temp.w('{"search": "_"}')); select pg_temp.rl('L_q15', pg_temp.w('{"search": "   "}'));
select pg_temp.rl('L_q16', pg_temp.w('{"search": "  S4-POST-REF-1  "}')); select pg_temp.rl('L_q17', pg_temp.w('{"search": "S4-LEGACY-0001"}')); select pg_temp.rl('L_q18', pg_temp.w('{"search": "nothing-like-this-9f3a"}'));
select pg_temp.q('S4f search: an order number finds the slips of that order', $$select pg_temp.lset('L_q1') = 's4_m' and pg_temp.lt('L_q1') = 1$$);
select pg_temp.q('S4f search: an order number in lower case finds it too (ilike)', $$select pg_temp.lset('L_q2') = 's4_a' and pg_temp.lt('L_q2') = 1$$);
select pg_temp.q('S4f search: an invoice number', $$select pg_temp.lset('L_q3') = 's4_d' and pg_temp.lt('L_q3') = 1$$);
select pg_temp.q('S4f search: a customer name (and in upper case) finds every slip of that customer', $$select pg_temp.lset('L_q4') = pg_temp.s4all() and pg_temp.lt('L_q4') = 18 and pg_temp.lt('L_q5') = 18$$);
select pg_temp.q('S4f search: a confirmed bank reference, in lower case as part of it, and written with spaces', $$select pg_temp.lset('L_q6') = 's4_c' and pg_temp.lset('L_q7') = 's4_c' and pg_temp.lset('L_q8') = 's4_c'$$);
select pg_temp.q('S4f search: the reference the customer claimed', $$select pg_temp.lset('L_q9') = 's4_q' and pg_temp.lt('L_q9') = 1$$);
select pg_temp.q('S4f search: the reference the AI read (the first slip and its duplicate both carry it); in lower case as a part',
  $$select pg_temp.lset('L_q10') = pg_temp.ks('s4_m', 's4_d') and pg_temp.lset('L_q11') = 's4_t'$$);
select pg_temp.q('S4f search: a % is a plain character, not a wildcard (it finds nothing; S4% finds nothing either)', $$select pg_temp.lt('L_q12') = 0 and pg_temp.lt('L_q13') = 0$$);
select pg_temp.q('S4f search: a _ is a plain character too', $$select pg_temp.lt('L_q14') = 0$$);
select pg_temp.q('S4f search: only spaces mean no search, and spaces around a word are ignored', $$select pg_temp.lt('L_q15') = 18 and pg_temp.lset('L_q16') = 's4_p'$$);
select pg_temp.q('S4f search: the reference of the one-step verified slip (its verified bank reference) is found too; a text nobody has finds nothing', $$select pg_temp.lset('L_q17') = 's4_l' and pg_temp.lt('L_q18') = 0$$);
select pg_temp.rl('L_c1', pg_temp.w('{"stage": ["manual_review"], "ai_result": ["duplicate_suspected", "suspicious_slip"]}')); select pg_temp.rl('L_c2', pg_temp.w('{"stage": ["slip_submitted"], "source": "customer_slip", "search": "S4"}'));
select pg_temp.rl('L_c3', pg_temp.w('{"stage": ["confirmed"], "method": "cash", "from": "2031-03-10", "to": "2031-03-10"}')); select pg_temp.rl('L_c4', pg_temp.w('{"stage": ["posted"], "ai_result": ["match"], "reason": "AMOUNT_OVER"}'));
select pg_temp.q('S4f combined: filters together are an AND', $$select pg_temp.lset('L_c1') = pg_temp.ks('s4_d', 's4_s') and pg_temp.lset('L_c3') = 's4_k' and pg_temp.lt('L_c4') = 0$$);
select pg_temp.q('S4f combined: stage + source + a search: the two slips still waiting whose claimed / AI reference contains S4 (s4_q claimed one; s4_t''s newest finished attempt read one)', $$select pg_temp.lset('L_c2') = pg_temp.ks('s4_q', 's4_t') and pg_temp.lt('L_c2') = 2$$);
select pg_temp.rl('L_e1', '{"stage": null, "ai_result": [], "from": "", "to": "", "reason": null, "search": "", "source": [], "method": null}'::jsonb);
select pg_temp.rl('L_e2', pg_temp.w('{"stage": null, "ai_result": [], "reason": null, "search": "", "source": [], "method": null}'));
select pg_temp.q('S4f empty values (null, "", []) mean no filter: all slips, as with {}', $$select pg_temp.lset('L_e2') = pg_temp.s4all() and pg_temp.lt('L_e2') = 18 and pg_temp.lt('L_e1') = (select count(*) from public.finance_payment_evidence)$$);

-- paging: the total is the count before paging, whatever the page
select pg_temp.rl('L_p1', pg_temp.w(), 5, 0); select pg_temp.rl('L_p2', pg_temp.w(), 5, 5); select pg_temp.rl('L_p3', pg_temp.w(), 5, 10); select pg_temp.rl('L_p4', pg_temp.w(), 5, 15); select pg_temp.rl('L_p5', pg_temp.w(), 5, 100);
select pg_temp.rl('L_p6', pg_temp.w(), 0, 0); select pg_temp.rl('L_p7', pg_temp.w(), -3, -7); select pg_temp.rl('L_p8', pg_temp.w(), 1000, 0); select pg_temp.rl('L_p9', pg_temp.w(), 200, 17);
select pg_temp.q('S4f paging: pages of 5 hold 5, 5, 5, 3 and 0 items, and every page says the total is 18', $$select pg_temp.ln('L_p1') = 5 and pg_temp.ln('L_p2') = 5 and pg_temp.ln('L_p3') = 5 and pg_temp.ln('L_p4') = 3 and pg_temp.ln('L_p5') = 0
       and pg_temp.lt('L_p1') = 18 and pg_temp.lt('L_p2') = 18 and pg_temp.lt('L_p3') = 18 and pg_temp.lt('L_p4') = 18 and pg_temp.lt('L_p5') = 18$$);
select pg_temp.q('S4f paging: the pages put together are the whole list in the same order, with no slip twice and none missing', $$select pg_temp.lids('L_p1') || pg_temp.lids('L_p2') || pg_temp.lids('L_p3') || pg_temp.lids('L_p4') = pg_temp.lids('L_all')$$);
select pg_temp.q('S4f paging: a limit of 0 or less gives one item, a negative offset counts as 0, a limit above 200 is capped (the whole 18 here), an offset of 17 leaves one item',
  $$select pg_temp.ln('L_p6') = 1 and pg_temp.ln('L_p7') = 1 and pg_temp.lids('L_p7') = pg_temp.lids('L_p6') and pg_temp.lids('L_p6') = (pg_temp.lids('L_p1'))[1:1] and pg_temp.ln('L_p8') = 18 and pg_temp.ln('L_p9') = 1 and pg_temp.lt('L_p9') = 18$$);
select pg_temp.asu('S'); select pg_temp.keep4('L_nul', $q$select public.finance_review_list(null, null, null)::text$q$); select pg_temp.keep4('L_def', $q$select public.finance_review_list()::text$q$); reset role;
select pg_temp.q('S4f paging: a null filter, limit and offset (and no arguments at all) mean no filter, 50 items from the start; the total is every slip there is',
  $$select pg_temp.lt('L_nul') = (select count(*) from public.finance_payment_evidence) and pg_temp.ln('L_nul') = least(50, (select count(*) from public.finance_payment_evidence)) and pg_temp.lt('L_def') = pg_temp.lt('L_nul')
       and pg_temp.ln('L_def') = pg_temp.ln('L_nul') and pg_temp.lids('L_def') = pg_temp.lids('L_nul')$$);

-- a bad filter is an error that says so, never a silent "everything"
select pg_temp.asu('S');
select pg_temp.err_like('S4f invalid: an unknown filter key is refused', $q$select public.finance_review_list('{"bogus": 1}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%bogus%');
select pg_temp.err_like('S4f invalid: an unknown stage is refused', $q$select public.finance_review_list('{"stage": ["nope"]}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: an unknown AI result is refused (also next to a good one)', $q$select public.finance_review_list('{"ai_result": ["match", "nope"]}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: an unknown source is refused', $q$select public.finance_review_list('{"source": "nope"}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: an unknown method is refused', $q$select public.finance_review_list('{"method": ["card"]}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a list of numbers is refused', $q$select public.finance_review_list('{"stage": [1, 2]}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a date written as words is refused (yesterday is a Postgres special value)', $q$select public.finance_review_list('{"from": "yesterday"}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a date that does not exist is refused', $q$select public.finance_review_list('{"to": "2031-02-31"}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a date with slashes is refused', $q$select public.finance_review_list('{"from": "2031/03/10"}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a date given as a number is refused', $q$select public.finance_review_list('{"from": 20310310}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a search that is not text is refused', $q$select public.finance_review_list('{"search": 5}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a reason that is a list is refused', $q$select public.finance_review_list('{"reason": ["AMOUNT_OVER"]}'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a filter that is an array is refused', $q$select public.finance_review_list('[]'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.err_like('S4f invalid: a filter that is a string is refused', $q$select public.finance_review_list('"x"'::jsonb, 50, 0)$q$, '%INVALID_FILTER%');
select pg_temp.runs_ok('S4f invalid: a JSON null as the filter is the same as {}', $q$select public.finance_review_list('null'::jsonb, 5, 0)$q$);
-- a list filter holds at most 20 values (there are 7 stages, 7 results, 2 sources, 2 methods): more is refused, whatever the values are
select pg_temp.err_like('S4f invalid: 21 stages are refused', format($q$select public.finance_review_list(%L::jsonb, 5, 0)$q$, (select jsonb_build_object('stage', jsonb_agg('posted'::text))::text from generate_series(1, 21))), '%INVALID_FILTER%stage%');
select pg_temp.err_like('S4f invalid: 21 AI results are refused', format($q$select public.finance_review_list(%L::jsonb, 5, 0)$q$, (select jsonb_build_object('ai_result', jsonb_agg('match'::text))::text from generate_series(1, 21))), '%INVALID_FILTER%ai_result%');
select pg_temp.err_like('S4f invalid: 21 sources are refused', format($q$select public.finance_review_list(%L::jsonb, 5, 0)$q$, (select jsonb_build_object('source', jsonb_agg('staff_entry'::text))::text from generate_series(1, 21))), '%INVALID_FILTER%source%');
select pg_temp.err_like('S4f invalid: 21 methods are refused', format($q$select public.finance_review_list(%L::jsonb, 5, 0)$q$, (select jsonb_build_object('method', jsonb_agg('cash'::text))::text from generate_series(1, 21))), '%INVALID_FILTER%method%');
select pg_temp.err_like('S4f invalid: 1000 values are refused', format($q$select public.finance_review_list(%L::jsonb, 5, 0)$q$, (select jsonb_build_object('stage', jsonb_agg('posted'::text))::text from generate_series(1, 1000))), '%INVALID_FILTER%stage%');
select pg_temp.runs_ok('S4f invalid: exactly 20 values are accepted', format($q$select public.finance_review_list(%L::jsonb, 5, 0)$q$, (select jsonb_build_object('stage', jsonb_agg('posted'::text))::text from generate_series(1, 20))));
reset role;

-- ---- S4g the summary. The unresolved counts ignore the date range; posted and rejected use the money event's day (Bangkok); the numbers are worked out by hand
select pg_temp.rs('sum_def', null, null); select pg_temp.rs('sum_d1', '2031-03-10', '2031-03-10'); select pg_temp.rs('sum_d2', '2031-03-11', '2031-03-11'); select pg_temp.rs('sum_d12', '2031-03-10', '2031-03-11');
select pg_temp.rs('sum_d3', '2031-03-12', '2031-03-12'); select pg_temp.rs('sum_rev', '2031-03-11', '2031-03-10'); select pg_temp.rs('sum_from', '2031-03-11', null); select pg_temp.rs('sum_to', null, '2031-03-10');
select pg_temp.q('S4g summary: the answer has exactly the eight parts of the contract, with their own keys',
  $$select (select array_agg(k order by k) from jsonb_object_keys((select v::jsonb from t_ctx where k = 'sum2')) k) = array['ai_verified', 'awaiting', 'confirmed', 'manual_review', 'more_evidence', 'posted', 'rejected', 'suspicious']
       and (select array_agg(k order by k) from jsonb_object_keys((select v::jsonb -> 'awaiting' from t_ctx where k = 'sum2')) k) = array['ai_total', 'count', 'expected_total']
       and (select array_agg(k order by k) from jsonb_object_keys((select v::jsonb -> 'confirmed' from t_ctx where k = 'sum2')) k) = array['amount', 'count']
       and (select array_agg(k order by k) from jsonb_object_keys((select v::jsonb -> 'posted' from t_ctx where k = 'sum2')) k) = array['amount', 'count']$$);
select pg_temp.q('S4g summary: every part is a number (zero when there is nothing, never null), also for a range with nothing in it',
  $$select (select bool_and(jsonb_typeof(x) = 'number') from t_ctx c, jsonb_path_query(c.v::jsonb, 'strict $.**') x where c.k = 'sum_d3' and jsonb_typeof(x) <> 'object')
       and pg_temp.sj('sum_d3', 'posted.count') = 0 and pg_temp.sj('sum_d3', 'posted.amount') = 0 and pg_temp.sj('sum_d3', 'rejected') = 0$$);
select pg_temp.q('S4g summary: no arguments at all (both dates optional) is the same as no range',
  $$select (select v from t_ctx where k = 'sum_def')::jsonb = (select v from t_ctx where k = 'sum2')::jsonb$$);
select pg_temp.q('S4g summary: the 18 slips of the section against the summary taken before them: 13 awaiting, 1 AI verified, 2 manual review (the amount mismatch and the failed reader), 2 suspicious (the duplicate and the bad QR), 2 confirmed for 320, 1 sent back for more evidence, 2 posted for 450, 2 rejected',
  $$select pg_temp.sd('sum0', 'sum2', 'awaiting.count') = 13 and pg_temp.sd('sum0', 'sum2', 'ai_verified') = 1 and pg_temp.sd('sum0', 'sum2', 'manual_review') = 2 and pg_temp.sd('sum0', 'sum2', 'suspicious') = 2
       and pg_temp.sd('sum0', 'sum2', 'confirmed.count') = 2 and pg_temp.sd('sum0', 'sum2', 'confirmed.amount') = 320 and pg_temp.sd('sum0', 'sum2', 'more_evidence') = 1
       and pg_temp.sd('sum0', 'sum2', 'posted.count') = 2 and pg_temp.sd('sum0', 'sum2', 'posted.amount') = 450 and pg_temp.sd('sum0', 'sum2', 'rejected') = 2$$);
select pg_temp.q('S4g summary: ...the money of the 13 awaiting slips: expected = 3 x the price + 2610 (the order totals, then each invoice or finished analysis), what the AI read = 4 x the price + 970',
  $$select pg_temp.sd('sum0', 'sum2', 'awaiting.expected_total') = 3 * pg_temp.c('P1')::numeric + 2610 and pg_temp.sd('sum0', 'sum2', 'awaiting.ai_total') = 4 * pg_temp.c('P1')::numeric + 970$$);
select pg_temp.q('S4g summary: the three AI tiles never overlap: AI verified + manual review + suspicious is exactly the number of submitted slips whose newest analysis is finished or failed (a plain SQL count; waiting and unanalysed slips are in none), for the whole and for the 18 slips (5: s4_m; s4_a and s4_f; s4_d and s4_s)',
  $$select pg_temp.sj('sum2', 'ai_verified') + pg_temp.sj('sum2', 'manual_review') + pg_temp.sj('sum2', 'suspicious')
         = (select count(*) from public.finance_payment_evidence e where e.status = 'submitted'
              and (select x.status from public.finance_slip_analysis x where x.evidence_id = e.id order by x.attempt desc limit 1) in ('done', 'failed'))
       and pg_temp.sd('sum0', 'sum2', 'ai_verified') + pg_temp.sd('sum0', 'sum2', 'manual_review') + pg_temp.sd('sum0', 'sum2', 'suspicious') = 5$$);
select pg_temp.q('S4g summary: ...the manual review tile excludes the suspicious ones: it is the list total for stage manual_review less those whose newest result is duplicate_suspected or suspicious_slip (the section''s 4 slips in that stage, 2 of them suspicious)',
  $$select pg_temp.lt('L_st3') = 4 and pg_temp.lt('L_c1') = 2 and pg_temp.sd('sum0', 'sum2', 'manual_review') = pg_temp.lt('L_st3') - pg_temp.lt('L_c1') and pg_temp.sd('sum0', 'sum2', 'suspicious') = pg_temp.lt('L_c1')$$);
select pg_temp.same('S4g summary: the whole summary equals an independent recount in plain SQL (no range)', 'sum2');
select pg_temp.same('S4g summary: ...for the 10th', 'sum_d1', date '2031-03-10', date '2031-03-10');
select pg_temp.same('S4g summary: ...for the 11th', 'sum_d2', date '2031-03-11', date '2031-03-11');
select pg_temp.same('S4g summary: ...for the 10th to the 11th', 'sum_d12', date '2031-03-10', date '2031-03-11');
select pg_temp.same('S4g summary: ...for the 12th (nothing money-wise happened)', 'sum_d3', date '2031-03-12', date '2031-03-12');
select pg_temp.same('S4g summary: ...for from after to', 'sum_rev', date '2031-03-11', date '2031-03-10');
select pg_temp.same('S4g summary: ...with only a from', 'sum_from', date '2031-03-11', null);
select pg_temp.same('S4g summary: ...with only a to', 'sum_to', null, date '2031-03-10');
select pg_temp.q('S4g summary range: on the 10th one slip was posted (s4_p, 250, at 23:59:59.999999) and one rejected (s4_r, at 00:00:00)',
  $$select pg_temp.sj('sum_d1', 'posted.count') = 1 and pg_temp.sj('sum_d1', 'posted.amount') = 250 and pg_temp.sj('sum_d1', 'rejected') = 1$$);
select pg_temp.q('S4g summary range: on the 11th one slip was posted (s4_l: the one-step slip has no posted_at, so its reviewed_at, exactly 00:00:00, counts) for 200 and one rejected (s4_o1, at 23:59:59.999999)',
  $$select pg_temp.sj('sum_d2', 'posted.count') = 1 and pg_temp.sj('sum_d2', 'posted.amount') = 200 and pg_temp.sj('sum_d2', 'rejected') = 1$$);
select pg_temp.q('S4g summary range: the two days together: 2 posted for 450, 2 rejected; the 12th: nothing; from after to: nothing',
  $$select pg_temp.sj('sum_d12', 'posted.count') = 2 and pg_temp.sj('sum_d12', 'posted.amount') = 450 and pg_temp.sj('sum_d12', 'rejected') = 2
       and pg_temp.sj('sum_d3', 'posted.count') = 0 and pg_temp.sj('sum_d3', 'rejected') = 0 and pg_temp.sj('sum_rev', 'posted.count') = 0 and pg_temp.sj('sum_rev', 'rejected') = 0$$);
select pg_temp.q('S4g summary range: from alone (the 11th) counts what happened from then on; to alone (the 10th) counts everything dated up to then: all earlier history, but not the one-step slip of the 11th and not a slip without a date (so more than the section''s one, fewer than all)',
  $$select pg_temp.sj('sum_from', 'posted.count') = 1 and pg_temp.sj('sum_from', 'rejected') = 1 and pg_temp.sj('sum_to', 'posted.count') >= 1 and pg_temp.sj('sum_to', 'posted.count') < pg_temp.sj('sum2', 'posted.count')$$);
select pg_temp.q('S4g summary range: THE UNRESOLVED COUNTS IGNORE THE RANGE: for every range the awaiting numbers, AI verified, manual review, suspicious, confirmed and more evidence are those of the whole',
  $$select bool_and((x.v::jsonb - 'posted' - 'rejected') = ((select v::jsonb from t_ctx where k = 'sum2') - 'posted' - 'rejected')) from t_ctx x where x.k in ('sum_d1', 'sum_d2', 'sum_d12', 'sum_d3', 'sum_rev', 'sum_from', 'sum_to', 'sum_def')$$);
select pg_temp.asu('C'); select pg_temp.rs('sum_c'); reset role;
select pg_temp.q('S4g summary: a verifier gets the same numbers as the manager', $$select (select v from t_ctx where k = 'sum_c')::jsonb = (select v from t_ctx where k = 'sum2')::jsonb$$);

-- ---- S4h the detail of one payment
select pg_temp.rd('D_t', 's4_t'); select pg_temp.rd('D_m', 's4_m'); select pg_temp.rd('D_d', 's4_d'); select pg_temp.rd('D_p', 's4_p'); select pg_temp.rd('D_c', 's4_c'); select pg_temp.rd('D_k', 's4_k');
select pg_temp.rd('D_e', 's4_e'); select pg_temp.rd('D_r', 's4_r'); select pg_temp.rd('D_n', 's4_n'); select pg_temp.rd('D_f', 's4_f'); select pg_temp.rd('D_o1', 's4_o1'); select pg_temp.rd('D_o2', 's4_o2'); select pg_temp.rd('D_l', 's4_l');
select pg_temp.q('S4h detail: eight parts, exactly: evidence, analyses, order, invoice, customer, receipts, other_evidence, events',
  $$select (select array_agg(k order by k) from jsonb_object_keys((select v::jsonb from t_ctx where k = 'D_m')) k) = array['analyses', 'customer', 'events', 'evidence', 'invoice', 'order', 'other_evidence', 'receipts']$$);
select pg_temp.q('S4h detail: the evidence part is the whole row (status, amounts, the file, who confirmed, who posted, ...) and adds the stage and the expected amount',
  $$select (select v::jsonb -> 'evidence' from t_ctx where k = 'D_c') ?& array['id', 'invoice_id', 'customer_id', 'file_path', 'file_sha256', 'file_type', 'claimed_amount', 'claimed_ref', 'status', 'verified_amount', 'bank_trans_ref', 'transfer_at',
         'review_note', 'reject_reason', 'reviewed_by', 'reviewed_at', 'created_at', 'bank_account_id', 'source', 'method', 'recorded_by', 'confirmed_by', 'confirmed_at', 'confirmed_amount', 'confirmed_bank_ref', 'confirmed_transfer_at',
         'confirm_note', 'posted_by', 'posted_at', 'request_message', 'requested_by', 'requested_at', 'stage', 'expected_amount']$$);
select pg_temp.q('S4h evidence: a confirmed customer slip: its file (for the signed URL), the values confirmed, who confirmed, stage confirmed, 240 expected',
  $$select pg_temp.dj('D_c', 'evidence.id') = pg_temp.c('s4_c') and pg_temp.dj('D_c', 'evidence.status') = 'confirmed' and pg_temp.dj('D_c', 'evidence.stage') = 'confirmed' and pg_temp.dj('D_c', 'evidence.file_path') = pg_temp.c('A') || '/s4-s4_c.png'
       and pg_temp.dj('D_c', 'evidence.file_type') = 'image/png' and pg_temp.dj('D_c', 'evidence.file_sha256') = md5('s4-s4_c') || md5('s4b-s4_c') and pg_temp.dj('D_c', 'evidence.confirmed_amount')::numeric = 240
       and pg_temp.dj('D_c', 'evidence.confirmed_bank_ref') = 'S4-CONF-REF-1' and pg_temp.dj('D_c', 'evidence.confirm_note') = 'S4 test' and pg_temp.dj('D_c', 'evidence.confirmed_by') = pg_temp.c('C') and pg_temp.dj('D_c', 'evidence.expected_amount')::numeric = 240$$);
select pg_temp.q('S4h evidence: a cash entry made by staff has no file (null), source staff_entry, method cash, who recorded it, stage confirmed, no analysis, the invoice''s 280 expected',
  $$select pg_temp.dv('D_k', 'evidence.file_path') = 'null'::jsonb and pg_temp.dv('D_k', 'evidence.file_type') = 'null'::jsonb and pg_temp.dj('D_k', 'evidence.source') = 'staff_entry' and pg_temp.dj('D_k', 'evidence.method') = 'cash'
       and pg_temp.dj('D_k', 'evidence.recorded_by') = pg_temp.c('C') and pg_temp.dj('D_k', 'evidence.stage') = 'confirmed' and pg_temp.dv('D_k', 'analyses') = '[]'::jsonb and pg_temp.dj('D_k', 'evidence.expected_amount')::numeric = 280
       and pg_temp.dj('D_k', 'evidence.confirm_note') = 'S4 cash at the counter'$$);
select pg_temp.q('S4h evidence: a slip sent back carries the message, who asked and the stage; a rejected one its reason and who rejected it',
  $$select pg_temp.dj('D_e', 'evidence.status') = 'more_evidence' and pg_temp.dj('D_e', 'evidence.request_message') = 'S4 please send a clearer slip' and pg_temp.dj('D_e', 'evidence.requested_by') = pg_temp.c('C') and pg_temp.dj('D_e', 'evidence.stage') = 'more_evidence'
       and pg_temp.dj('D_r', 'evidence.status') = 'rejected' and pg_temp.dj('D_r', 'evidence.reject_reason') = 'S4 not our transfer' and pg_temp.dj('D_r', 'evidence.reviewed_by') = pg_temp.c('C') and pg_temp.dj('D_r', 'evidence.stage') = 'rejected'$$);
select pg_temp.q('S4h evidence: a posted slip has who posted and when; the stage is posted',
  $$select pg_temp.dj('D_p', 'evidence.stage') = 'posted' and pg_temp.dj('D_p', 'evidence.status') = 'verified' and pg_temp.dj('D_p', 'evidence.posted_by') = pg_temp.c('C') and (pg_temp.dj('D_p', 'evidence.posted_at'))::timestamptz = timestamptz '2031-03-10 23:59:59.999999+07'$$);
-- the analyses of s4_t: three attempts, newest first
select pg_temp.q('S4h analyses: three attempts of s4_t, newest first (3, 2, 1), the newest still waiting', $$select jsonb_array_length(pg_temp.dv('D_t', 'analyses')) = 3 and pg_temp.dj('D_t', 'analyses.0.attempt') = '3' and pg_temp.dj('D_t', 'analyses.1.attempt') = '2'
       and pg_temp.dj('D_t', 'analyses.2.attempt') = '1' and pg_temp.dj('D_t', 'analyses.0.status') = 'queued' and pg_temp.dj('D_t', 'analyses.1.status') = 'done' and pg_temp.dj('D_t', 'analyses.2.status') = 'done'
       and pg_temp.dv('D_t', 'analyses.0.result') = 'null'::jsonb and pg_temp.dv('D_t', 'analyses.0.extracted') = 'null'::jsonb and pg_temp.dj('D_t', 'analyses.0.requested_by') = pg_temp.c('C')$$);
select pg_temp.q('S4h analyses: attempt 2 in full: what was read, the QR, what was expected, the confidence, no signals, no reasons, the engine, the prompt version, who asked for it',
  $$select pg_temp.dj('D_t', 'analyses.1.result') = 'match' and pg_temp.dj('D_t', 'analyses.1.extracted.amount')::numeric = 310 and pg_temp.dj('D_t', 'analyses.1.extracted.trans_ref') = 'S4REF-T-0001'
       and pg_temp.dj('D_t', 'analyses.1.extracted.receiver.bank') = 'SCB' and pg_temp.dj('D_t', 'analyses.1.qr.trans_ref') = 'S4REF-T-0001' and (pg_temp.dj('D_t', 'analyses.1.qr.crc_ok')) = 'true'
       and pg_temp.dj('D_t', 'analyses.1.expected.amount')::numeric = 310 and pg_temp.dv('D_t', 'analyses.1.expected.receivers') <> '[]'::jsonb and pg_temp.dj('D_t', 'analyses.1.overall_confidence')::numeric = 0.95
       and pg_temp.dv('D_t', 'analyses.1.signals') = '[]'::jsonb and pg_temp.dv('D_t', 'analyses.1.reasons') = '[]'::jsonb and pg_temp.dj('D_t', 'analyses.1.engine') = 'claude-haiku-5-5'
       and pg_temp.dj('D_t', 'analyses.1.prompt_version') = 'v1' and pg_temp.dv('D_t', 'analyses.1.error') = 'null'::jsonb and pg_temp.dj('D_t', 'analyses.1.requested_by') = pg_temp.c('C') and pg_temp.dj('D_t', 'analyses.1.finished_at') is not null$$);
select pg_temp.q('S4h analyses: attempt 1: the mismatch, with its reason, the amount it read (300), the amount it expected (310), made by the system (nobody asked)',
  $$select pg_temp.dj('D_t', 'analyses.2.result') = 'amount_mismatch' and pg_temp.dj('D_t', 'analyses.2.reasons.0.code') = 'AMOUNT_UNDER' and pg_temp.dj('D_t', 'analyses.2.reasons.0.severity') = 'high' and pg_temp.dj('D_t', 'analyses.2.extracted.amount')::numeric = 300
       and pg_temp.dj('D_t', 'analyses.2.expected.amount')::numeric = 310 and pg_temp.dv('D_t', 'analyses.2.requested_by') = 'null'::jsonb$$);
select pg_temp.q('S4h analyses: each attempt has the 17 keys of the analysis (the slip''s id is not repeated)',
  $$select bool_and((select array_agg(k order by k) from jsonb_object_keys(a) k) = array['attempt', 'created_at', 'engine', 'error', 'expected', 'extracted', 'finished_at', 'id', 'overall_confidence', 'prompt_version', 'qr', 'reasons', 'requested_by', 'result', 'signals', 'started_at', 'status'])
     from t_ctx x, jsonb_array_elements(x.v::jsonb -> 'analyses') a where x.k = 'D_t'$$);
select pg_temp.q('S4h analyses: a failed reader shows the failure (status, the error, manual_review, the AI_UNAVAILABLE reason); the stage is manual review',
  $$select jsonb_array_length(pg_temp.dv('D_f', 'analyses')) = 1 and pg_temp.dj('D_f', 'analyses.0.status') = 'failed' and pg_temp.dj('D_f', 'analyses.0.error') = 'S4 no API key' and pg_temp.dj('D_f', 'analyses.0.result') = 'manual_review'
       and pg_temp.dj('D_f', 'analyses.0.reasons.0.code') = 'AI_UNAVAILABLE' and pg_temp.dj('D_f', 'evidence.stage') = 'manual_review'$$);
select pg_temp.q('S4h analyses: a slip with no analysis has an empty list, the stage slip_submitted and the invoice amount as the expected amount',
  $$select pg_temp.dv('D_n', 'analyses') = '[]'::jsonb and pg_temp.dj('D_n', 'evidence.stage') = 'slip_submitted' and pg_temp.dj('D_n', 'evidence.expected_amount')::numeric = 290$$);
-- the order
select pg_temp.q('S4h order: a shop order has its number, status, fulfilment, contact, total and its items (sku, name, unit, price, quantity, line total), and none of the internal keys',
  format($$select pg_temp.dj('D_m', 'order.order_no') = o.order_no and pg_temp.dj('D_m', 'order.id') = o.id::text and pg_temp.dj('D_m', 'order.status') = 'new' and pg_temp.dj('D_m', 'order.fulfilment') = 'pickup' and pg_temp.dj('D_m', 'order.contact_phone') = '0812345678'
       and pg_temp.dj('D_m', 'order.contact_name') = 'Somchai' and pg_temp.dj('D_m', 'order.total')::numeric = o.total and not (pg_temp.dv('D_m', 'order') ? 'idempotency_key') and not (pg_temp.dv('D_m', 'order') ? 'request_hash')
       and jsonb_array_length(pg_temp.dv('D_m', 'order.items')) = 1 and pg_temp.dj('D_m', 'order.items.0.sku_code') = 'FG-000001' and pg_temp.dj('D_m', 'order.items.0.qty') = '2' and pg_temp.dj('D_m', 'order.items.0.line_no') = '1'
       and pg_temp.dj('D_m', 'order.items.0.line_total')::numeric = o.total and pg_temp.dj('D_m', 'order.items.0.unit_price')::numeric * 2 = o.total
       and (select array_agg(k order by k) from jsonb_object_keys(pg_temp.dv('D_m', 'order.items.0')) k) = array['line_no', 'line_total', 'name', 'qty', 'sku_code', 'unit', 'unit_price']
       from public.shop_orders o where o.invoice_id = %L$$, pg_temp.c('v4_m')));
select pg_temp.q('S4h order: an invoice that is not a shop order has order = null', $$select pg_temp.dv('D_d', 'order') = 'null'::jsonb and pg_temp.dv('D_k', 'order') = 'null'::jsonb$$);
-- the invoice: its state
select pg_temp.q('S4h invoice: the shop order''s invoice with its state: pending verification (3), one slip pending, nothing paid, all outstanding',
  $$select pg_temp.dj('D_m', 'invoice.id') = pg_temp.c('v4_m') and pg_temp.dj('D_m', 'invoice.invoice_no') = pg_temp.inv('v4_m', 'invoice_no') and pg_temp.dj('D_m', 'invoice.invoice_status') = 'open' and pg_temp.dj('D_m', 'invoice.status_code') = '3'
       and pg_temp.dj('D_m', 'invoice.status') = 'pending_verification' and pg_temp.dj('D_m', 'invoice.pending_evidence') = '1' and pg_temp.dj('D_m', 'invoice.paid')::numeric = 0 and pg_temp.dj('D_m', 'invoice.outstanding')::numeric = pg_temp.c('T1')::numeric
       and pg_temp.dj('D_m', 'invoice.amount')::numeric = pg_temp.c('T1')::numeric and pg_temp.dj('D_m', 'invoice.issue_date') is not null and pg_temp.dj('D_m', 'invoice.due_date') is not null$$);
select pg_temp.q('S4h invoice: a posted slip''s invoice is fully paid (5): 250 paid, 0 outstanding; a confirmed slip''s invoice shows 240 confirmed and waiting',
  $$select pg_temp.dj('D_p', 'invoice.status_code') = '5' and pg_temp.dj('D_p', 'invoice.status') = 'fully_paid' and pg_temp.dj('D_p', 'invoice.paid')::numeric = 250 and pg_temp.dj('D_p', 'invoice.outstanding')::numeric = 0
       and pg_temp.dj('D_c', 'invoice.confirmed_pending')::numeric = 240 and pg_temp.dj('D_c', 'invoice.pending_evidence') = '1' and pg_temp.dj('D_c', 'invoice.paid')::numeric = 0$$);
select pg_temp.q('S4h invoice: a part-paid invoice (the one-step slip: 200 of 330) is partially paid (4) with 130 outstanding', $$select pg_temp.dj('D_l', 'invoice.status_code') = '4' and pg_temp.dj('D_l', 'invoice.paid')::numeric = 200 and pg_temp.dj('D_l', 'invoice.outstanding')::numeric = 130$$);
-- the customer
select pg_temp.q('S4h customer: name and phone (the order''s contact phone for a shop order, the profile''s for a manual invoice), code and id',
  $$select pg_temp.dj('D_m', 'customer.name') = (select name from public.finance_customers where id = pg_temp.c('cust')::uuid) and pg_temp.dj('D_m', 'customer.id') = pg_temp.c('cust')
       and pg_temp.dj('D_m', 'customer.code') = (select code from public.finance_customers where id = pg_temp.c('cust')::uuid) and pg_temp.dj('D_m', 'customer.phone') = '0812345678'
       and pg_temp.dv('D_d', 'customer.phone') = to_jsonb('0899990000'::text)
       and (select array_agg(k order by k) from jsonb_object_keys(pg_temp.dv('D_m', 'customer')) k) = array['code', 'id', 'name', 'phone']$$);
-- receipts and the other payments of the invoice
select pg_temp.q('S4h receipts: the posted slip''s invoice has its one receipt (number, amount, method, the slip it came from, the bank reference); a slip with no receipt has an empty list',
  $$select jsonb_array_length(pg_temp.dv('D_p', 'receipts')) = 1 and pg_temp.dj('D_p', 'receipts.0.receipt_no') = pg_temp.rcol('s4_p', 'receipt_no') and pg_temp.dj('D_p', 'receipts.0.amount')::numeric = 250 and pg_temp.dj('D_p', 'receipts.0.method') = 'bank_transfer'
       and pg_temp.dj('D_p', 'receipts.0.evidence_id') = pg_temp.c('s4_p') and pg_temp.dj('D_p', 'receipts.0.bank_trans_ref') = 'S4-POST-REF-1' and pg_temp.dj('D_p', 'receipts.0.status') = 'posted'
       and jsonb_array_length(pg_temp.dv('D_l', 'receipts')) = 1 and pg_temp.dj('D_l', 'receipts.0.amount')::numeric = 200 and pg_temp.dv('D_m', 'receipts') = '[]'::jsonb and pg_temp.dv('D_c', 'receipts') = '[]'::jsonb$$);
select pg_temp.q('S4h other evidence: the other slips of the same invoice (not itself), with id, status, amount and time: s4_o2 sees the rejected s4_o1 and the other way round; a slip alone on its invoice sees none',
  $$select jsonb_array_length(pg_temp.dv('D_o2', 'other_evidence')) = 1 and pg_temp.dj('D_o2', 'other_evidence.0.id') = pg_temp.c('s4_o1') and pg_temp.dj('D_o2', 'other_evidence.0.status') = 'rejected' and pg_temp.dj('D_o2', 'other_evidence.0.amount')::numeric = 320
       and pg_temp.dj('D_o2', 'other_evidence.0.created_at') is not null and jsonb_array_length(pg_temp.dv('D_o1', 'other_evidence')) = 1 and pg_temp.dj('D_o1', 'other_evidence.0.id') = pg_temp.c('s4_o2') and pg_temp.dj('D_o1', 'other_evidence.0.status') = 'submitted'
       and pg_temp.dv('D_m', 'other_evidence') = '[]'::jsonb$$);
-- the audit trail
select pg_temp.q('S4h events: the audit rows of the slip, newest first: the confirmation, the analysis and the submission, each with its time, actor, actor e-mail, action and detail; the confirmation is by the verifier',
  $$select (select array_agg(e ->> 'action') from jsonb_array_elements(pg_temp.dv('D_c', 'events')) e) = array['evidence.confirm', 'evidence.analysis', 'evidence.submit'] and pg_temp.dj('D_c', 'events.0.actor') = pg_temp.c('C')
       and pg_temp.dj('D_c', 'events.0.detail.trans_ref') = 'S4-CONF-REF-1' and pg_temp.dj('D_c', 'events.1.detail.result') = 'match' and pg_temp.dj('D_c', 'events.2.actor') = pg_temp.c('A')
       and (select bool_and((select array_agg(k order by k) from jsonb_object_keys(e) k) = array['action', 'actor', 'actor_email', 'at', 'detail', 'id']) from jsonb_array_elements(pg_temp.dv('D_c', 'events')) e)$$);
select pg_temp.q('S4h events: the audit rows of OTHER slips are not mixed in (s4_p shows its own, newest first: post, verify (the core), confirm, analysis, submit)',
  $$select (select array_agg(e ->> 'action') from jsonb_array_elements(pg_temp.dv('D_p', 'events')) e) = array['evidence.post', 'evidence.verify', 'evidence.confirm', 'evidence.analysis', 'evidence.submit']$$);
reset role;
select pg_temp.runs_ok('S4h setup: 35 more audit rows on s4_m (numbered 1 to 35)', format($q$select public.finance_log('evidence', %L, 'test.event', jsonb_build_object('n', g)) from generate_series(1, 35) g$q$, pg_temp.c('s4_m')));
select pg_temp.rd('D_m2', 's4_m');
select pg_temp.q('S4h events: only the last 30 are returned, newest first (35 down to 6)',
  $$select jsonb_array_length(pg_temp.dv('D_m2', 'events')) = 30 and pg_temp.dj('D_m2', 'events.0.detail.n') = '35' and pg_temp.dj('D_m2', 'events.29.detail.n') = '6'$$);
select pg_temp.asu('S');
select pg_temp.err_like('S4h detail: an unknown slip is "Evidence not found"', $q$select public.finance_review_detail(gen_random_uuid())$q$, '%Evidence not found%');
select pg_temp.err_like('S4h detail: no slip is "Evidence not found"', $q$select public.finance_review_detail(null)$q$, '%Evidence not found%');
reset role;
create or replace function pg_temp.rows_state() returns text language plpgsql security definer as $$
begin return
  (select count(*) from public.finance_events) || '/' || (select count(*) from public.finance_slip_analysis) || '/' || (select count(*) from public.finance_payment_evidence) || '/'
    || (select count(*) from public.finance_receipts) || '/' || (select count(*) from public.finance_invoices) || '/'
    || md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.finance_payment_evidence x), '')) || '/' || md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.finance_slip_analysis x), '')); end $$;
select pg_temp.keep('ev_n0', $q$select pg_temp.rows_state()$q$);
select pg_temp.rl('L_ro', pg_temp.w()); select pg_temp.rs('sum_ro'); select pg_temp.rd('D_ro', 's4_m'); select pg_temp.rd('D_ro2', 's4_t');
select pg_temp.q('S4h reading changes nothing: after the list, the summary and two details the audit log, the analysis rows, the evidence rows, the receipts and the invoices are exactly as before (their counts, and a hash of every evidence and analysis row)',
  $$select (select v from t_ctx where k = 'ev_n0') = pg_temp.rows_state() and (select v from t_ctx where k = 'ev_n0') is not null and pg_temp.lt('L_ro') = 18 and pg_temp.dj('D_ro2', 'evidence.id') = pg_temp.c('s4_t')$$);

-- ---- S4i the settings read
select pg_temp.asu('C'); select pg_temp.keep4('set0', $q$select public.finance_review_settings()::text$q$); reset role;
select pg_temp.q('S4i settings: the five settings, exactly, with the values of the settings row (the AI review is on in this run)',
  $$select (select array_agg(k order by k) from jsonb_object_keys((select v::jsonb from t_ctx where k = 'set0')) k) = array['ai_min_confidence', 'ai_review_enabled', 'post_requires_manager', 'slip_future_tolerance_min', 'slip_window_before_min']
       and (select v::jsonb from t_ctx where k = 'set0') = (select jsonb_build_object('ai_review_enabled', s.ai_review_enabled, 'post_requires_manager', s.post_requires_manager, 'ai_min_confidence', s.ai_min_confidence,
            'slip_window_before_min', s.slip_window_before_min, 'slip_future_tolerance_min', s.slip_future_tolerance_min) from public.finance_settings s)
       and pg_temp.dj('set0', 'ai_review_enabled') = 'true' and pg_temp.dj('set0', 'post_requires_manager') = 'false' and pg_temp.dj('set0', 'ai_min_confidence')::numeric = 0.80
       and pg_temp.dj('set0', 'slip_window_before_min') = '120' and pg_temp.dj('set0', 'slip_future_tolerance_min') = '10'$$);
select pg_temp.asu('S');
select pg_temp.keep('sv4', $q$select public.finance_save_review_settings('{"ai_min_confidence": 0.9, "slip_window_before_min": 60, "slip_future_tolerance_min": 5, "post_requires_manager": true}'::jsonb)::text$q$);
reset role;
select pg_temp.asu('D'); select pg_temp.keep4('set1', $q$select public.finance_review_settings()::text$q$); reset role;
select pg_temp.q('S4i settings: what the manager saved is what a viewer or clerk reads (and the switch he did not touch is unchanged)',
  $$select pg_temp.dj('set1', 'ai_min_confidence')::numeric = 0.90 and pg_temp.dj('set1', 'slip_window_before_min') = '60' and pg_temp.dj('set1', 'slip_future_tolerance_min') = '5' and pg_temp.dj('set1', 'post_requires_manager') = 'true' and pg_temp.dj('set1', 'ai_review_enabled') = 'true'$$);
select pg_temp.asu('S');
select pg_temp.runs_ok('S4i settings: the manager puts the values back', $q$select public.finance_save_review_settings('{"ai_min_confidence": 0.8, "slip_window_before_min": 120, "slip_future_tolerance_min": 10, "post_requires_manager": false}'::jsonb)$q$);
reset role;
select pg_temp.q('S4i settings: back to the defaults', $$select ai_min_confidence = 0.80 and slip_window_before_min = 120 and slip_future_tolerance_min = 10 and not post_requires_manager from public.finance_settings$$);

-- ---- S4j carry-over: finance_cancel_invoice (manager) refuses while a payment of the invoice is confirmed and waits to be posted
select pg_temp.runs_ok('S4j setup: the AI review is off (no analysis rows are needed here)', $q$update public.finance_settings set ai_review_enabled = false$q$);
select pg_temp.asu('S');
select pg_temp.mkinv('v4h1', 100); select pg_temp.mkinv('v4h2', 100); select pg_temp.mkinv('v4h3', 100); select pg_temp.mkinv('v4h4', 100); select pg_temp.mkinv('v4h5', 100); select pg_temp.mkinv('v4h6', 100); select pg_temp.mkinv('v4h7', 100);
reset role;
select pg_temp.asu('A');
select pg_temp.s4slip('s4h1', 'v4h1', 100); select pg_temp.s4slip('s4h4', 'v4h4', 100); select pg_temp.s4slip('s4h5', 'v4h5', 100); select pg_temp.s4slip('s4h6', 'v4h6', 100); select pg_temp.s4slip('s4h7a', 'v4h7', 100); select pg_temp.s4slip('s4h7b', 'v4h7', 100);
reset role;
select pg_temp.asu('C');
select pg_temp.conf('ch1', 's4h1', 100, 'S4-H1-REF-0001');
select pg_temp.rec('rh2', 'v4h2', 'cash', 40, null, 'S4 cash for the cancel test');
select pg_temp.runs_ok('S4j setup: s4h5 is sent back for more evidence', format($q$select public.finance_request_more_evidence(%L, 'S4 more please')$q$, pg_temp.c('s4h5')));
select pg_temp.conf('ch6', 's4h6', 100, 'S4-H6-REF-0001'); select pg_temp.post('ph6', 's4h6');
select pg_temp.conf('ch7', 's4h7a', 100, 'S4-H7-REF-0001');
select pg_temp.runs_ok('S4j setup: the other slip of invoice h7 is rejected', format($q$select public.finance_reject_evidence(%L, 'S4 not ours')$q$, pg_temp.c('s4h7b')));
reset role;
select pg_temp.eid('s4h2', 'rh2');
select pg_temp.q('S4j setup: the slips are in the statuses the cases need (confirmed, a confirmed cash entry, submitted, more_evidence, verified, confirmed next to a rejected one)',
  $$select pg_temp.ev('s4h1', 'status') = 'confirmed' and pg_temp.ev('s4h2', 'status') = 'confirmed' and pg_temp.ev('s4h2', 'source') = 'staff_entry' and pg_temp.ev('s4h4', 'status') = 'submitted' and pg_temp.ev('s4h5', 'status') = 'more_evidence'
       and pg_temp.ev('s4h6', 'status') = 'verified' and pg_temp.ev('s4h7a', 'status') = 'confirmed' and pg_temp.ev('s4h7b', 'status') = 'rejected'$$);
select pg_temp.asu('S');
select pg_temp.err_like('S4j cancel: a confirmed payment that waits to be posted blocks the cancel (SLIP_PENDING)', format($q$select public.finance_cancel_invoice(%L, 'S4 cancel test')$q$, pg_temp.c('v4h1')), '%SLIP_PENDING%');
select pg_temp.err_like('S4j cancel: ...also a cash entry that staff recorded and nobody posted', format($q$select public.finance_cancel_invoice(%L, 'S4 cancel test')$q$, pg_temp.c('v4h2')), '%SLIP_PENDING%');
select pg_temp.err_like('S4j cancel: ...also when another slip of the invoice was rejected', format($q$select public.finance_cancel_invoice(%L, 'S4 cancel test')$q$, pg_temp.c('v4h7')), '%SLIP_PENDING%');
reset role;
select pg_temp.q('S4j cancel: ...the refused cancels changed nothing: the invoices are open, unstamped, with no cancel row in the audit log, and the slips are still confirmed',
  $$select pg_temp.inv('v4h1', 'status') = 'open' and pg_temp.inv('v4h2', 'status') = 'open' and pg_temp.inv('v4h7', 'status') = 'open' and pg_temp.inv('v4h1', 'cancelled_at') is null and pg_temp.inv('v4h1', 'cancel_reason') is null
       and not exists (select 1 from public.finance_events where action = 'invoice.cancel' and entity_id in (pg_temp.c('v4h1')::uuid, pg_temp.c('v4h2')::uuid, pg_temp.c('v4h7')::uuid))
       and pg_temp.ev('s4h1', 'status') = 'confirmed' and pg_temp.ev('s4h2', 'status') = 'confirmed' and pg_temp.ev('s4h7a', 'status') = 'confirmed'$$);
select pg_temp.asu('C');
select pg_temp.err_like('S4j cancel: a verifier may not cancel (the manager''s right is checked first)', format($q$select public.finance_cancel_invoice(%L, 'S4 cancel test')$q$, pg_temp.c('v4h1')), '%not allowed%');
select pg_temp.asu('A');
select pg_temp.err_like('S4j cancel: a customer may not cancel', format($q$select public.finance_cancel_invoice(%L, 'S4 cancel test')$q$, pg_temp.c('v4h1')), '%not allowed%');
select pg_temp.asu('S');
select pg_temp.runs_ok('S4j cancel: an invoice with no payment at all is cancelled as before (while another invoice has a confirmed one)', format($q$select public.finance_cancel_invoice(%L, 'S4 nothing paid')$q$, pg_temp.c('v4h3')));
select pg_temp.err_like('S4j cancel: ...a reason is still required', format($q$select public.finance_cancel_invoice(%L, '   ')$q$, pg_temp.c('v4h4')), '%A reason is required%');
select pg_temp.runs_ok('S4j cancel: an invoice whose only slip is still submitted is cancelled as before (the guard is for CONFIRMED payments)', format($q$select public.finance_cancel_invoice(%L, 'S4 only submitted')$q$, pg_temp.c('v4h4')));
select pg_temp.runs_ok('S4j cancel: an invoice whose slip waits for more evidence is cancelled as before', format($q$select public.finance_cancel_invoice(%L, 'S4 more evidence')$q$, pg_temp.c('v4h5')));
select pg_temp.err_like('S4j cancel: an invoice with a posted payment still says "reverse them first" (not SLIP_PENDING)', format($q$select public.finance_cancel_invoice(%L, 'S4 posted')$q$, pg_temp.c('v4h6')), '%Payments are recorded on this invoice%');
reset role;
select pg_temp.q('S4j cancel: ...those invoices are cancelled with their reasons, and the posted one is open',
  $$select pg_temp.inv('v4h3', 'status') = 'cancelled' and pg_temp.inv('v4h3', 'cancel_reason') = 'S4 nothing paid' and pg_temp.inv('v4h4', 'status') = 'cancelled' and pg_temp.inv('v4h5', 'status') = 'cancelled' and pg_temp.inv('v4h6', 'status') = 'open'$$);
select pg_temp.asu('C');
select pg_temp.runs_ok('S4j cancel: the confirmed slip of h1 is rejected', format($q$select public.finance_reject_evidence(%L, 'S4 not received')$q$, pg_temp.c('s4h1')));
select pg_temp.runs_ok('S4j cancel: the cash entry of h2 is rejected', format($q$select public.finance_reject_evidence(%L, 'S4 cash not received')$q$, pg_temp.c('s4h2')));
select pg_temp.runs_ok('S4j cancel: the confirmed slip of h7 is rejected', format($q$select public.finance_reject_evidence(%L, 'S4 not received')$q$, pg_temp.c('s4h7a')));
select pg_temp.asu('S');
select pg_temp.runs_ok('S4j cancel: once the slip is rejected the manager can cancel h1', format($q$select public.finance_cancel_invoice(%L, 'S4 after the reject')$q$, pg_temp.c('v4h1')));
select pg_temp.runs_ok('S4j cancel: ...and h2 (the cash entry rejected)', format($q$select public.finance_cancel_invoice(%L, 'S4 after the reject')$q$, pg_temp.c('v4h2')));
select pg_temp.runs_ok('S4j cancel: ...and h7 (both slips rejected)', format($q$select public.finance_cancel_invoice(%L, 'S4 after the reject')$q$, pg_temp.c('v4h7')));
reset role;
select pg_temp.q('S4j cancel: ...they are cancelled, with the reason and one cancel row each in the audit log, unchanged behaviour',
  $$select pg_temp.inv('v4h1', 'status') = 'cancelled' and pg_temp.inv('v4h2', 'status') = 'cancelled' and pg_temp.inv('v4h7', 'status') = 'cancelled' and pg_temp.inv('v4h1', 'cancel_reason') = 'S4 after the reject'
       and (select count(*) from public.finance_events where action = 'invoice.cancel' and entity_id = pg_temp.c('v4h1')::uuid and detail ->> 'reason' = 'S4 after the reject') = 1$$);

-- ---- S4k who may call what, how the functions are made, the indexes
select pg_temp.q('S4k grants: list, summary, detail and settings are for signed-in users and refused to anon',
  $$select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')) from unnest(array[
       'public.finance_review_list(jsonb, integer, integer)', 'public.finance_review_summary(date, date)', 'public.finance_review_detail(uuid)', 'public.finance_review_settings()']) f$$);
select pg_temp.q('S4k grants: the internal helpers (the stage, the expected amount, the filter readers) are not callable by authenticated, anon, public or even the service role',
  $$select bool_and(not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('service_role', f, 'execute')) from unnest(array[
       'public.finance_evidence_stage(text, text, text)', 'public.finance_review_expected(uuid)', 'public.finance_review_arr(jsonb, text, text[])', 'public.finance_review_date(jsonb, text)']) f$$);
select pg_temp.q('S4k make: the four reads and the expected amount are security definer with a fixed search_path; the reads are STABLE (read-only: a stable function cannot write); the helpers fix their search_path too',
  $$select bool_and(p.prosecdef and p.proconfig @> array['search_path=public'] and p.provolatile = 's') filter (where p.proname in ('finance_review_list', 'finance_review_summary', 'finance_review_detail', 'finance_review_settings', 'finance_review_expected'))
       and bool_and(p.proconfig @> array['search_path=public']) filter (where p.proname in ('finance_evidence_stage', 'finance_review_arr', 'finance_review_date'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('finance_review_list', 'finance_review_summary', 'finance_review_detail', 'finance_review_settings', 'finance_review_expected', 'finance_evidence_stage', 'finance_review_arr', 'finance_review_date')$$);
select pg_temp.q('S4k api: every function of this section exists exactly once (no stray overload), and so does the guarded cancel',
  $$select bool_and((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f) = 1) from unnest(array[
       'finance_review_list', 'finance_review_summary', 'finance_review_detail', 'finance_review_settings', 'finance_review_expected', 'finance_evidence_stage', 'finance_review_arr', 'finance_review_date', 'finance_cancel_invoice']) f$$);
select pg_temp.q('S4k api: the cancel keeps its signature and answer type (the app calls it with these two arguments)',
  $$select pg_get_function_arguments('public.finance_cancel_invoice(uuid, text)'::regprocedure) = 'p_invoice uuid, p_reason text' and pg_get_function_result('public.finance_cancel_invoice(uuid, text)'::regprocedure) = 'void'
       and has_function_privilege('authenticated', 'public.finance_cancel_invoice(uuid, text)', 'execute') and not has_function_privilege('anon', 'public.finance_cancel_invoice(uuid, text)', 'execute')$$);
select pg_temp.q('S4k indexes: the list is ordered by created_at desc, id and the lookups by invoice: both indexes exist on the evidence table (the (status, created_at) one of the baseline stays)',
  $$select (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'finance_evidence_created_idx') like '%finance_payment_evidence%(created_at DESC, id)%'
       and (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'finance_evidence_invoice_idx') like '%finance_payment_evidence%(invoice_id, created_at DESC)%'
       and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'finance_evidence_queue_idx')$$);

-- ---- S4l paging cap: 205 slips on one day; a limit of 1000 is cut to 200 and the total still says 205
select pg_temp.rs('sum2b');
-- the AI tiles are about SUBMITTED slips: a slip that is already confirmed-and-posted, rejected, or sent back for more evidence does not count in them, whatever its newest analysis says
select pg_temp.runs_ok('S4g setup: finished analyses on slips that are no longer submitted (posted: suspicious_slip, more evidence: duplicate_suspected, rejected: amount_mismatch, another rejected: a failed reader)',
  format($q$insert into public.finance_slip_analysis (evidence_id, attempt, status, result, error, reasons, extracted, expected, finished_at)
    select e.id, 1, case when e.id = %L::uuid then 'failed' else 'done' end,
           case e.id when %L::uuid then 'suspicious_slip' when %L::uuid then 'duplicate_suspected' when %L::uuid then 'amount_mismatch' else 'manual_review' end,
           case when e.id = %L::uuid then 'S4 reader down' end, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
      from public.finance_payment_evidence e where e.id in (%L, %L, %L, %L)$q$,
    pg_temp.c('s4h7a'), pg_temp.c('s4h6'), pg_temp.c('s4h5'), pg_temp.c('s4h1'), pg_temp.c('s4h7a'), pg_temp.c('s4h6'), pg_temp.c('s4h5'), pg_temp.c('s4h1'), pg_temp.c('s4h7a')));
select pg_temp.rs('sum2c');
select pg_temp.q('S4g summary tiles: analyses on posted, rejected and sent-back slips change none of the three AI tiles (nor anything else in the summary)',
  $$select (select v::jsonb from t_ctx where k = 'sum2c') = (select v::jsonb from t_ctx where k = 'sum2b')$$);
select pg_temp.same('S4g summary tiles: ...and the summary still equals the recount', 'sum2c');
select pg_temp.runs_ok('S4l setup: 205 more slips on one invoice, on 2031-03-20',
  format($q$insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, created_at)
    select %L::uuid, %L::uuid, 'S4/bulk-' || g, md5('s4-bulk-' || g) || md5('s4b-bulk-' || g), 'image/png', 1, timestamptz '2031-03-20 12:00:00+07' + g * interval '1 second' from generate_series(1, 205) g$q$, pg_temp.c('v4_o'), pg_temp.c('cust')));
select pg_temp.rl('L_b1', '{"from": "2031-03-20", "to": "2031-03-20"}', 1000, 0); select pg_temp.rl('L_b2', '{"from": "2031-03-20", "to": "2031-03-20"}', 1000, 200); select pg_temp.rl('L_b3', '{"from": "2031-03-20", "to": "2031-03-20"}', 200, 0);
select pg_temp.asu('S'); select pg_temp.keep4('L_b4', $q$select public.finance_review_list('{"from": "2031-03-20", "to": "2031-03-20"}'::jsonb)::text$q$); reset role;
select pg_temp.q('S4l cap: a limit of 1000 returns 200 items (never more), the total says 205, and an offset of 200 leaves the last 5; the default page is 50',
  $$select pg_temp.ln('L_b1') = 200 and pg_temp.lt('L_b1') = 205 and pg_temp.ln('L_b2') = 5 and pg_temp.lt('L_b2') = 205 and pg_temp.ln('L_b3') = 200 and pg_temp.ln('L_b4') = 50 and pg_temp.lt('L_b4') = 205$$);
select pg_temp.q('S4l cap: the two pages together are the 205 slips, newest first, none twice', $$select cardinality(pg_temp.lids('L_b1') || pg_temp.lids('L_b2')) = 205 and (select count(distinct x) from unnest(pg_temp.lids('L_b1') || pg_temp.lids('L_b2')) x) = 205
       and pg_temp.lids('L_b1') || pg_temp.lids('L_b2') = (select array_agg(id::text order by created_at desc, id) from public.finance_payment_evidence where created_at >= timestamptz '2031-03-20 00:00:00+07' and created_at < timestamptz '2031-03-21 00:00:00+07')$$);
select pg_temp.rs('sum3'); select pg_temp.same('S4l summary: with 205 more awaiting slips the summary still equals the recount', 'sum3');
select pg_temp.q('S4l summary: ...205 more awaiting slips, each expecting the invoice''s 320, and nothing else moved',
  $$select pg_temp.sd('sum2b', 'sum3', 'awaiting.count') = 205 and pg_temp.sd('sum2b', 'sum3', 'awaiting.expected_total') = 205 * 320 and pg_temp.sd('sum2b', 'sum3', 'awaiting.ai_total') = 0 and pg_temp.sd('sum2b', 'sum3', 'ai_verified') = 0
       and pg_temp.sd('sum2b', 'sum3', 'manual_review') = 0 and pg_temp.sd('sum2b', 'sum3', 'confirmed.count') = 0 and pg_temp.sd('sum2b', 'sum3', 'posted.count') = 0 and pg_temp.sd('sum2b', 'sum3', 'rejected') = 0$$);

-- ---- put back what this section changed in the shared setup
select pg_temp.runs_ok('S4 cleanup: the settings are back to the dark defaults', $q$update public.finance_settings set ai_review_enabled = false, post_requires_manager = false, ai_min_confidence = 0.80, slip_window_before_min = 120, slip_future_tolerance_min = 10$q$);
select pg_temp.q('S4 cleanup: the settings are dark', $$select not ai_review_enabled and not post_requires_manager and ai_min_confidence = 0.80 and slip_window_before_min = 120 and slip_future_tolerance_min = 10 from public.finance_settings$$);


-- =========================================================================================== S5 customer order list
-- shop_my_orders filters the customer's "unpaid" chip ("To pay") by the state of the order's invoice. An order whose invoice is in state 10 (more evidence requested: the
-- customer has to act) must be in that chip. Five own orders of customer A, one in each state, found by their ids; no absolute counts (A may have real orders).
reset role;
create or replace function pg_temp.mo(p_key text, p_filter text, p_user text default 'A') returns void language plpgsql as $$
begin
  perform pg_temp.asu(p_user);
  perform pg_temp.keep4(p_key, format($q$select public.shop_my_orders(%L, 50, 0)::text$q$, p_filter));
  execute 'reset role';
end $$;
-- is the order (key) in the stored answer
create or replace function pg_temp.inmo(p_key text, p_ord text) returns boolean language sql as $$
  select exists (select 1 from t_ctx x, jsonb_array_elements(x.v::jsonb -> 'orders') o where x.k = p_key and o ->> 'id' = pg_temp.c(p_ord)) $$;
-- how many of the five fixture orders are in the stored answer
create or replace function pg_temp.nmo(p_key text) returns integer language sql as $$
  select count(*)::int from t_ctx k where k.k in ('q5a', 'q5b', 'q5c', 'q5d', 'q5e') and pg_temp.inmo(p_key, k.k) $$;
select pg_temp.runs_ok('S5 setup: the settings are the dark defaults', $q$update public.finance_settings set ai_review_enabled = false, post_requires_manager = false$q$);
-- the shop allows 10 orders per customer per hour and the earlier sections already placed nine for A: they are made three hours old (this run only), so the five below can be placed
select pg_temp.runs_ok('S5 setup: the orders placed by customer A in the earlier sections are made three hours old', format($q$update public.shop_orders set created_at = now() - interval '3 hours' where profile_id = %L and created_at > now() - interval '1 hour'$q$, pg_temp.c('A')));
select pg_temp.asu('A');
select pg_temp.keep('r5a', format($q$select public.shop_place_order('s5-key-0001', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')::numeric));
select pg_temp.keep('r5b', format($q$select public.shop_place_order('s5-key-0002', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')::numeric));
select pg_temp.keep('r5c', format($q$select public.shop_place_order('s5-key-0003', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')::numeric));
select pg_temp.keep('r5d', format($q$select public.shop_place_order('s5-key-0004', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')::numeric));
select pg_temp.keep('r5e', format($q$select public.shop_place_order('s5-key-0005', '[{"sku_code":"FG-000001","qty":1}]', 'pickup', 'Somchai', '081-234-5678', null, null, %s, 'bank:SCB')::text$q$, pg_temp.c('P1')::numeric));
reset role;
select pg_temp.keep('q5a', $q$select (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'r5a'$q$); select pg_temp.keep('w5a', $q$select (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'r5a'$q$);
select pg_temp.keep('q5b', $q$select (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'r5b'$q$); select pg_temp.keep('w5b', $q$select (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'r5b'$q$);
select pg_temp.keep('q5c', $q$select (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'r5c'$q$); select pg_temp.keep('w5c', $q$select (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'r5c'$q$);
select pg_temp.keep('q5d', $q$select (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'r5d'$q$); select pg_temp.keep('w5d', $q$select (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'r5d'$q$);
select pg_temp.keep('q5e', $q$select (v::jsonb) -> 'order' ->> 'id' from t_ctx where k = 'r5e'$q$); select pg_temp.keep('w5e', $q$select (v::jsonb) -> 'order' -> 'invoice' ->> 'id' from t_ctx where k = 'r5e'$q$);
-- a: a slip that staff sent back for more evidence (state 10)   b: a slip waiting to be checked (state 3)   c: a slip verified for the whole amount (state 5, fully paid)
-- d: nothing done yet (state 0 or 1)   e: cancelled by the customer (state 8, order cancelled)
select pg_temp.asu('A'); select pg_temp.s4slip('s5a', 'w5a', pg_temp.c('P1')::numeric); select pg_temp.s4slip('s5b', 'w5b', pg_temp.c('P1')::numeric); select pg_temp.s4slip('s5c', 'w5c', pg_temp.c('P1')::numeric); reset role;
select pg_temp.asu('C');
select pg_temp.runs_ok('S5 setup: the slip of order a is sent back for more evidence', format($q$select public.finance_request_more_evidence(%L, 'S5 please send a clearer slip')$q$, pg_temp.c('s5a')));
select pg_temp.keep('v5c', format($q$select public.finance_verify_evidence(%L, %s, 'S5-REF-C0001', now(), 'S5')::text$q$, pg_temp.c('s5c'), pg_temp.c('P1')::numeric));
reset role;
select pg_temp.runs_ok('S5 setup: order e is cancelled (it has no slip)', format($q$select public.shop_cancel_order_internal(%L, 'S5 test', true)$q$, pg_temp.c('q5e')));
select pg_temp.q('S5 setup: the five orders are in the states the cases need: a = 10 (more evidence requested), b = 3 (slip pending), c = 5 (fully paid), d = 0 or 1 (nothing done), e = 8 (cancelled)',
  $$select pg_temp.sv('w5a', 'status_code')::int = 10 and pg_temp.sv('w5b', 'status_code')::int = 3 and pg_temp.sv('w5c', 'status_code')::int = 5 and pg_temp.sv('w5d', 'status_code')::int in (0, 1)
       and pg_temp.sv('w5e', 'status_code')::int = 8 and (select status from public.shop_orders where id = pg_temp.c('q5e')::uuid) = 'cancelled' and (select status from public.shop_orders where id = pg_temp.c('q5a')::uuid) = 'new'$$);

select pg_temp.mo('M_all', 'all'); select pg_temp.mo('M_unpaid', 'unpaid'); select pg_temp.mo('M_ship', 'to_ship'); select pg_temp.mo('M_recv', 'to_receive'); select pg_temp.mo('M_done', 'done'); select pg_temp.mo('M_canc', 'cancelled');
select pg_temp.q('S5 my orders: an order whose invoice asks for more evidence (state 10) is in "To pay" (unpaid) and in "All"',
  $$select pg_temp.inmo('M_unpaid', 'q5a') and pg_temp.inmo('M_all', 'q5a')$$);
select pg_temp.q('S5 my orders: ...and in no other chip (it is not shippable, not to receive, not done, not cancelled)',
  $$select not pg_temp.inmo('M_ship', 'q5a') and not pg_temp.inmo('M_recv', 'q5a') and not pg_temp.inmo('M_done', 'q5a') and not pg_temp.inmo('M_canc', 'q5a')$$);
select pg_temp.q('S5 my orders: a slip pending (state 3) and an order with nothing paid or sent (0 or 1) are still in "To pay"', $$select pg_temp.inmo('M_unpaid', 'q5b') and pg_temp.inmo('M_unpaid', 'q5d')$$);
select pg_temp.q('S5 my orders: a fully paid order (state 5) is NOT in "To pay", but is "To ship" (new order, paid) and in "All"',
  $$select not pg_temp.inmo('M_unpaid', 'q5c') and pg_temp.inmo('M_ship', 'q5c') and pg_temp.inmo('M_all', 'q5c')$$);
select pg_temp.q('S5 my orders: a cancelled order is not in "To pay" and not in "To ship", it is in "Cancelled" and in "All"',
  $$select not pg_temp.inmo('M_unpaid', 'q5e') and not pg_temp.inmo('M_ship', 'q5e') and pg_temp.inmo('M_canc', 'q5e') and pg_temp.inmo('M_all', 'q5e')$$);
select pg_temp.q('S5 my orders: the other chips are as before for the sample: To ship holds only the paid order, Cancelled only the cancelled one, To receive and Done none of the five',
  $$select pg_temp.nmo('M_ship') = 1 and pg_temp.nmo('M_canc') = 1 and pg_temp.nmo('M_recv') = 0 and pg_temp.nmo('M_done') = 0 and pg_temp.nmo('M_all') = 5 and pg_temp.nmo('M_unpaid') = 3$$);
select pg_temp.q('S5 my orders: the five orders split between To pay (3: states 10, 3, 0 or 1), To ship (1) and Cancelled (1), none in two chips',
  $$select pg_temp.nmo('M_unpaid') + pg_temp.nmo('M_ship') + pg_temp.nmo('M_canc') = 5$$);
select pg_temp.q('S5 my orders: the total of "To pay" counts the state-10 order (relative: it is at least the 3 unpaid ones here)', $$select (select (v::jsonb ->> 'total')::int from t_ctx where k = 'M_unpaid') >= 3$$);
select pg_temp.mo('M_unpaid_b', 'unpaid', 'B');
select pg_temp.q('S5 my orders: another customer sees none of these orders in any list', $$select pg_temp.nmo('M_unpaid_b') = 0$$);
select pg_temp.q('S5 my orders: the function keeps its signature, its answer and its grants (signed-in customers only), stable, security definer, fixed search_path, defined once',
  $$select pg_get_function_arguments(p.oid) = 'p_filter text DEFAULT ''all''::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0' and pg_get_function_result(p.oid) = 'jsonb' and p.provolatile = 's' and p.prosecdef
       and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
       and (select count(*) from pg_proc q join pg_namespace n on n.oid = q.pronamespace where n.nspname = 'public' and q.proname = 'shop_my_orders') = 1
     from pg_proc p where p.oid = to_regprocedure('public.shop_my_orders(text, integer, integer)')$$);

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'SLIPREVIEW_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
