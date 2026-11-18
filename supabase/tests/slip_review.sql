-- AI-assisted slip review with end-of-day approval, tested against REAL data (real catalogue, real profiles, real bank accounts) inside one
-- transaction that is rolled back (scripts/run-slip-review-sql-tests.sh sends the new migration followed by this file). Nothing persists: the last
-- statement raises an exception that carries the result table.
-- Customers A and B are real LINE members, C gets a verifier role, S is a real SUPER_ADMIN (a finance manager).
-- Scenarios: S1 schema (settings, evidence columns, analysis table, ledger queue, receipts, RLS).
-- Later tasks append S2 analysis, S3 workflow, S4 reads above the result block at the bottom.
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

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'SLIPREVIEW_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
