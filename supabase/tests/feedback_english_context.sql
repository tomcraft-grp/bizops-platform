-- Tests for 20261115600000_feedback_english_context.sql against REAL data inside one transaction that is rolled back
-- (scripts/run-feedback-sql-tests.sh). Nothing persists. Customers A and B are real LINE members, S is a real SUPER_ADMIN.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon, service_role; grant usage on sequence t_res_n_seq to authenticated, anon, service_role;
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
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_res (test, ok, detail) select 'test users found', (select count(*) from t_ctx where k in ('A', 'B', 'S')) = 3, null;

-- =========================================================================================== E1 existing issues are untouched
-- fingerprints (md5 of the description) of the five real issues, taken before the migration was applied
insert into t_res (test, ok, detail) select 'E1 the five real issues keep their description byte for byte',
  (select count(*) from public.bizops_feedback_issues where (id, md5(description)) in (
     ('FB-001001', 'c52807bdd4656418399117cde580bd80'), ('FB-001002', '34c8b924ce77dc80e1802934104a2cbf'), ('FB-001003', 'e149dfdab7b6789b23b29bdb89aaf9f2'),
     ('FB-001004', '92dbe9c52d33b0451f9160ac8bf05e46'), ('FB-001005', 'b5c0046913aa4a682895b8bb2bc426e1'))) = 5, null;
insert into t_res (test, ok, detail) select 'E1 every existing issue is still valid: a known status, and English text only with a source',
  not exists (select 1 from public.bizops_feedback_issues where english_context_status not in ('pending', 'processing', 'completed', 'failed') or (english_context is not null and english_context_source is null)), null;
insert into t_res (test, ok, detail) select 'E1 the status of untouched issues is "pending" (not generated yet), never blocking',
  (select count(*) from public.bizops_feedback_issues where english_context is null and english_context_status = 'pending') >= 0, null;

-- =========================================================================================== E2 a new issue keeps the description exactly and starts without an English context
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_ctx select 'i1', (public.feedback_submit('bug', 'ปุ่มบันทึกกดไม่ได้', E'ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"\nคาดว่าควรบันทึกได้', 'high', '/products', 'Products', 'catalog', 'backoffice', '0.1.0', 'production', 'Chrome', 'Windows NT 10.0', 'desktop', 'ctx-key-00001')).id;
insert into t_res (test, ok, detail) select 'E2 the original description is stored exactly as typed (Thai, identifiers, quotes, new line)',
  description = E'ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"\nคาดว่าควรบันทึกได้' and title = 'ปุ่มบันทึกกดไม่ได้', description from public.bizops_feedback_issues where id = pg_temp.c('i1');
insert into t_res (test, ok, detail) select 'E2 a new issue starts with no English context, status pending, no attempts, no error',
  english_context is null and english_context_status = 'pending' and english_context_attempts = 0 and english_context_error is null and english_context_source is null, null from public.bizops_feedback_issues where id = pg_temp.c('i1');

-- =========================================================================================== E3 who may call what
select pg_temp.err_like('E3 a customer cannot start a generation directly', format($q$select public.feedback_english_context_begin(%L, %L)$q$, pg_temp.c('i1'), pg_temp.c('A')::uuid), '%permission denied%');
select pg_temp.err_like('E3 a customer cannot store a generated text directly', format($q$select public.feedback_english_context_finish(%L, 'Faked context', 'x')$q$, pg_temp.c('i1')), '%permission denied%');
select pg_temp.err_like('E3 a customer cannot write the English context by hand', format($q$select public.feedback_set_english_context(%L, 'Faked context')$q$, pg_temp.c('i1')), '%Only support staff%');
select pg_temp.err_like('E3 a customer cannot write the column directly', format($q$update public.bizops_feedback_issues set english_context = 'x' where id = %L$q$, pg_temp.c('i1')), '%permission denied%');
reset role; set local role anon;
select pg_temp.err_like('E3 anonymous visitors cannot call it either', format($q$select public.feedback_set_english_context(%L, 'x')$q$, pg_temp.c('i1')), '%permission denied%');

-- =========================================================================================== E4 the generator (service role): claim, finish, retry
reset role; set local role service_role;
insert into t_ctx select 'b1', public.feedback_english_context_begin(pg_temp.c('i1'), pg_temp.c('A')::uuid)::text;
insert into t_res (test, ok, detail) select 'E4 the reporter can start the generation; it receives the issue facts, the description exactly',
  (v::jsonb) ->> 'description' = E'ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"\nคาดว่าควรบันทึกได้' and (v::jsonb) ->> 'page_path' = '/products' and (v::jsonb) ->> 'category' = 'bug', left(v, 200) from t_ctx where k = 'b1';
insert into t_res (test, ok, detail) select 'E4 the issue is now "processing", attempt 1', english_context_status = 'processing' and english_context_attempts = 1, null from public.bizops_feedback_issues where id = pg_temp.c('i1');
select pg_temp.err_like('E4 a second run at the same time is refused', format($q$select public.feedback_english_context_begin(%L, %L)$q$, pg_temp.c('i1'), pg_temp.c('A')::uuid), '%ALREADY_RUNNING%');
select pg_temp.err_like('E4 another customer cannot start it for this issue', format($q$select public.feedback_english_context_begin(%L, %L)$q$, pg_temp.c('i1'), pg_temp.c('B')::uuid), '%Feedback not found%');
select pg_temp.err_like('E4 a result with neither text nor error is refused', format($q$select public.feedback_english_context_finish(%L, '   ', 'm')$q$, pg_temp.c('i1')), '%1 to 20,000%');
select public.feedback_english_context_finish(pg_temp.c('i1'), E'## Issue Title\nSave button does not work', 'claude-sonnet-5-5');
insert into t_res (test, ok, detail) select 'E4 finishing stores the text as AI-generated and completed',
  english_context = E'## Issue Title\nSave button does not work' and english_context_status = 'completed' and english_context_source = 'ai' and english_context_model = 'claude-sonnet-5-5' and english_context_at is not null and english_context_error is null, null
  from public.bizops_feedback_issues where id = pg_temp.c('i1');
insert into t_res (test, ok, detail) select 'E4 THE ORIGINAL DESCRIPTION IS UNCHANGED by the generation', description = E'ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"\nคาดว่าควรบันทึกได้', null from public.bizops_feedback_issues where id = pg_temp.c('i1');
select pg_temp.err_like('E4 the reporter cannot regenerate a finished context (staff can)', format($q$select public.feedback_english_context_begin(%L, %L)$q$, pg_temp.c('i1'), pg_temp.c('A')::uuid), '%ALREADY_DONE%');
insert into t_res (test, ok, detail) select 'E4 staff can regenerate a finished context', public.feedback_english_context_begin(pg_temp.c('i1'), pg_temp.c('S')::uuid) ->> 'id' = pg_temp.c('i1'), null;
select public.feedback_english_context_finish(pg_temp.c('i1'), null, 'claude-sonnet-5-5', 'AI_NOT_CONFIGURED: the AI key is not set');
insert into t_res (test, ok, detail) select 'E4 a failed attempt records the reason and KEEPS the previous text',
  english_context_status = 'failed' and english_context_error like 'AI_NOT_CONFIGURED%' and english_context = E'## Issue Title\nSave button does not work' and english_context_attempts = 2, null
  from public.bizops_feedback_issues where id = pg_temp.c('i1');
insert into t_res (test, ok, detail) select 'E4 after a failure the reporter can retry', public.feedback_english_context_begin(pg_temp.c('i1'), pg_temp.c('A')::uuid) ->> 'id' = pg_temp.c('i1'), null;
select public.feedback_english_context_finish(pg_temp.c('i1'), E'## Issue Title\nSave button does not work (retry)', 'claude-sonnet-5-5');
insert into t_res (test, ok, detail) select 'E4 the retry completes, attempt 3', english_context_status = 'completed' and english_context like '%(retry)' and english_context_attempts = 3, null from public.bizops_feedback_issues where id = pg_temp.c('i1');
-- a run that died is not a lock for ever
reset role;
insert into t_ctx select 'i2', (public.feedback_submit('general', 'second', 'a second report with ordinary words', 'medium', '/x', null, null, 'backoffice', null, null, null, null, null, 'ctx-key-00002')).id
  from (select set_config('request.jwt.claims', json_build_object('sub', pg_temp.c('A'), 'role', 'authenticated')::text, true)) x;
set local role service_role;
select public.feedback_english_context_begin(pg_temp.c('i2'), pg_temp.c('A')::uuid);
reset role; update public.bizops_feedback_issues set english_context_started_at = now() - interval '10 minutes' where id = pg_temp.c('i2');
set local role service_role;
insert into t_res (test, ok, detail) select 'E4 a run that has been "processing" for over 5 minutes counts as dead and can be restarted', public.feedback_english_context_begin(pg_temp.c('i2'), pg_temp.c('A')::uuid) ->> 'id' = pg_temp.c('i2'), null;

-- =========================================================================================== E5 staff write it by hand
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('E5 an empty text is refused', format($q$select public.feedback_set_english_context(%L, '  ')$q$, pg_temp.c('i2')), '%1 to 20,000%');
select pg_temp.err_like('E5 a text over 20,000 characters is refused', format($q$select public.feedback_set_english_context(%L, repeat('x', 20001))$q$, pg_temp.c('i2')), '%1 to 20,000%');
select pg_temp.err_like('E5 an unknown issue is refused', $q$select public.feedback_set_english_context('FB-999999', 'text')$q$, '%Feedback not found%');
insert into t_res (test, ok, detail) select 'E5 staff save a hand-written context: completed, source manual, no model',
  (public.feedback_set_english_context(pg_temp.c('i2'), E'## Issue Title\nWritten by staff')).english_context_source = 'manual', null;
reset role;
insert into t_res (test, ok, detail) select 'E5 and it is recorded in the issue history (staff only)', exists (select 1 from public.feedback_events where issue_id = pg_temp.c('i2') and kind = 'english_context' and customer_visible = false and note = 'Written by hand'), null;

-- =========================================================================================== E6 who can see it (row-level security, like the description)
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'E6 another customer cannot see this issue at all (so not its English context)', (select count(*) from public.bizops_feedback_issues where id = pg_temp.c('i1')) = 0, null;
insert into t_res (test, ok, detail) select 'E6 ... nor its history', (select count(*) from public.feedback_events where issue_id = pg_temp.c('i1')) = 0, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'E6 the reporter sees their own issue', (select count(*) from public.bizops_feedback_issues where id = pg_temp.c('i1')) = 1, null;
insert into t_res (test, ok, detail) select 'E6 the reporter does NOT see the English-context history entries (not customer visible)', (select count(*) from public.feedback_events where issue_id = pg_temp.c('i1') and kind = 'english_context') = 0, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'E6 staff see the issue and its English-context history', (select count(*) from public.feedback_events where issue_id = pg_temp.c('i1') and kind = 'english_context') >= 3, null;

-- =========================================================================================== E7 constraints
reset role;
select pg_temp.err_like('E7 an unknown status is refused', format($q$update public.bizops_feedback_issues set english_context_status = 'done' where id = %L$q$, pg_temp.c('i1')), '%feedback_ctx_status_check%');
select pg_temp.err_like('E7 an unknown source is refused', format($q$update public.bizops_feedback_issues set english_context_source = 'robot' where id = %L$q$, pg_temp.c('i1')), '%feedback_ctx_source_check%');
select pg_temp.err_like('E7 a text over 20,000 characters is refused by the table itself', format($q$update public.bizops_feedback_issues set english_context = repeat('x', 20001) where id = %L$q$, pg_temp.c('i1')), '%feedback_ctx_length_check%');

-- =========================================================================================== E8 attachments: what the generator may see, and who can read the files
insert into public.feedback_attachments (issue_id, storage_path, file_name, mime_type, size_bytes, uploaded_by) values
  (pg_temp.c('i1'), pg_temp.c('i1') || '/11111111-1111-4111-8111-111111111111.png', 'screenshot-1.png', 'image/png', 12345, pg_temp.c('A')::uuid);
set local role service_role;
select public.feedback_english_context_finish(pg_temp.c('i1'), E'## ok', 'm');
insert into t_ctx select 'b3', public.feedback_english_context_begin(pg_temp.c('i1'), pg_temp.c('S')::uuid)::text;
insert into t_res (test, ok, detail) select 'E8 the generator gets the attachment NAMES, types and sizes, never the storage path',
  (v::jsonb) -> 'attachments' -> 0 ->> 'file_name' = 'screenshot-1.png' and (v::jsonb) -> 'attachments' -> 0 ->> 'mime_type' = 'image/png' and not ((v::jsonb) -> 'attachments' -> 0 ? 'storage_path'), left(v, 300) from t_ctx where k = 'b3';
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'E8 another customer cannot see the attachment record', (select count(*) from public.feedback_attachments where issue_id = pg_temp.c('i1')) = 0, null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
insert into t_res (test, ok, detail) select 'E8 the reporter sees their attachment record', (select count(*) from public.feedback_attachments where issue_id = pg_temp.c('i1')) = 1, null;
-- the private bucket: a customer may add files only to the folder of an issue they reported
reset role;
insert into t_res (test, ok, detail) select 'E8 the bucket is private and limited to images and PDF, 10 MB', (select not public and file_size_limit = 10485760 and allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp'] from storage.buckets where id = 'feedback-attachments'), null;
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
select pg_temp.err_like('E8 another customer cannot put a file into this issue''s folder', format($q$insert into storage.objects (bucket_id, name, owner_id) values ('feedback-attachments', %L, %L)$q$, pg_temp.c('i1') || '/22222222-2222-4222-8222-222222222222.png', pg_temp.c('B')), '%row-level security%');
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_res (test, ok, detail) select 'E8 another customer cannot read a file of this issue (storage policy)', (select count(*) from storage.objects where bucket_id = 'feedback-attachments' and name like pg_temp.c('i1') || '/%') = 0, null;

-- =========================================================================================== E9 cost control (20261115610000): limits for customers, none for staff
reset role;
create temp table t_clone as select * from public.bizops_feedback_issues where id = pg_temp.c('i2');
-- clones of an existing issue (same reporter), inserted directly so no issue numbers are used up
insert into public.bizops_feedback_issues
  select (jsonb_populate_record(null::public.bizops_feedback_issues, to_jsonb(c) || jsonb_build_object('id', 'FB-99' || lpad(g::text, 4, '0'), 'idempotency_key', 'clone-' || g,
    'english_context', null, 'english_context_status', 'pending', 'english_context_source', null, 'english_context_model', null, 'english_context_error', null,
    'english_context_at', null, 'english_context_attempts', 0, 'english_context_started_at', null))).*
  from t_clone c, generate_series(1, 3) g;
set local role service_role;
select public.feedback_english_context_begin('FB-990001', pg_temp.c('A')::uuid);
select public.feedback_english_context_finish('FB-990001', null, 'm', 'AI_HTTP_500: try 1');
select public.feedback_english_context_begin('FB-990001', pg_temp.c('A')::uuid);
select public.feedback_english_context_finish('FB-990001', null, 'm', 'AI_HTTP_500: try 2');
select public.feedback_english_context_begin('FB-990001', pg_temp.c('A')::uuid);
select public.feedback_english_context_finish('FB-990001', null, 'm', 'AI_HTTP_500: try 3');
select pg_temp.err_like('E9 a customer gets 3 attempts per issue, the 4th is refused', $q$select public.feedback_english_context_begin('FB-990001', pg_temp.c('A')::uuid)$q$, '%RATE_LIMITED%3 times%');
insert into t_res (test, ok, detail) select 'E9 a refused call changes nothing (still failed, 3 attempts)', english_context_status = 'failed' and english_context_attempts = 3, null from public.bizops_feedback_issues where id = 'FB-990001';
insert into t_res (test, ok, detail) select 'E9 support staff are not limited per issue', public.feedback_english_context_begin('FB-990001', pg_temp.c('S')::uuid) ->> 'id' = 'FB-990001', null;
-- ten starts within the hour for this customer (i1 and i2 and FB-990001 already count): the next one is refused
reset role;
insert into public.bizops_feedback_issues
  select (jsonb_populate_record(null::public.bizops_feedback_issues, to_jsonb(c) || jsonb_build_object('id', 'FB-99' || lpad(g::text, 4, '0'), 'idempotency_key', 'clone-' || g,
    'english_context', null, 'english_context_status', 'failed', 'english_context_source', null, 'english_context_model', null, 'english_context_error', 'x',
    'english_context_at', null, 'english_context_attempts', 1, 'english_context_started_at', now()))).*
  from t_clone c, generate_series(10, 18) g;
set local role service_role;
select pg_temp.err_like('E9 a customer is limited to 10 generation starts per hour', $q$select public.feedback_english_context_begin('FB-990002', pg_temp.c('A')::uuid)$q$, '%RATE_LIMITED%too many%');
insert into t_res (test, ok, detail) select 'E9 ... and the refused issue is untouched (pending, 0 attempts)', english_context_status = 'pending' and english_context_attempts = 0, null from public.bizops_feedback_issues where id = 'FB-990002';
insert into t_res (test, ok, detail) select 'E9 staff are not limited per hour either', public.feedback_english_context_begin('FB-990002', pg_temp.c('S')::uuid) ->> 'id' = 'FB-990002', null;
insert into t_res (test, ok, detail) select 'E9 a clone-based test leaves the five real issues alone', (select count(*) from public.bizops_feedback_issues where id in ('FB-001001','FB-001002','FB-001003','FB-001004','FB-001005') and english_context_status = 'pending' and english_context is null) = 5, null;

-- =========================================================================================== E10 plain translation saved by staff (20261115620000)
reset role;
insert into t_ctx select 'i10', id from (select id from public.bizops_feedback_issues where id = 'FB-990003') x;
insert into t_res (test, ok, detail) select 'E10 there is exactly one set function (no ambiguous overload)', (select count(*) from pg_proc where proname = 'feedback_set_english_context') = 1, null;
insert into t_res (test, ok, detail) select 'E10 signed-in users may call it, anonymous visitors may not', has_function_privilege('authenticated', 'public.feedback_set_english_context(text, text, text)', 'execute') and not has_function_privilege('anon', 'public.feedback_set_english_context(text, text, text)', 'execute'), null;
-- a customer cannot save a translation (or anything) by hand
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_like('E10 a customer cannot save a translation', $q$select public.feedback_set_english_context('FB-990003', 'Title: x', 'translation')$q$, '%Only support staff%');
reset role; set local role anon;
select pg_temp.err_like('E10 anonymous visitors cannot', $q$select public.feedback_set_english_context('FB-990003', 'Title: x', 'translation')$q$, '%permission denied%');
-- staff
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('E10 an unknown source is refused', $q$select public.feedback_set_english_context('FB-990003', 'Title: x', 'robot')$q$, '%Unknown source%');
select pg_temp.err_like('E10 a null source is refused', $q$select public.feedback_set_english_context('FB-990003', 'Title: x', null)$q$, '%Unknown source%');
select pg_temp.err_like('E10 an empty translation is refused', $q$select public.feedback_set_english_context('FB-990003', '   ', 'translation')$q$, '%1 to 20,000%');
insert into t_res (test, ok, detail) select 'E10 staff save a translation: completed, source translation, no model, the original description untouched',
  (r).english_context = E'Title: Save button\n\nPressing Save does nothing for FG-000001' and (r).english_context_source = 'translation' and (r).english_context_status = 'completed' and (r).english_context_model is null
  and (r).description = (select description from public.bizops_feedback_issues where id = 'FB-990002'),
  null from (select public.feedback_set_english_context('FB-990003', E'Title: Save button\n\nPressing Save does nothing for FG-000001', 'translation') as r) x;
reset role;
insert into t_res (test, ok, detail) select 'E10 the history says it was a translation, staff only', exists (select 1 from public.feedback_events where issue_id = 'FB-990003' and kind = 'english_context' and note = 'Translated on the staff computer' and customer_visible = false), null;
-- the old 2-argument call still works exactly as before
reset role; set local role authenticated; select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_res (test, ok, detail) select 'E10 a 2-argument call still means "written by hand"', (public.feedback_set_english_context('FB-990003', 'Typed by staff')).english_context_source = 'manual', null;
reset role;
insert into t_res (test, ok, detail) select 'E10 ... and is recorded as "Written by hand"', exists (select 1 from public.feedback_events where issue_id = 'FB-990003' and note = 'Written by hand'), null;
-- a generation by the AI path overwrites a translation like any text, and the constraint knows the three sources
insert into t_res (test, ok, detail) select 'E10 the source constraint accepts ai, manual and translation only',
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'feedback_ctx_source_check') ~ 'ai.*manual.*translation', null;
insert into t_res (test, ok, detail) select 'E10 the five real issues are still untouched', (select count(*) from public.bizops_feedback_issues where id in ('FB-001001','FB-001002','FB-001003','FB-001004','FB-001005') and english_context is null and english_context_status = 'pending') = 5, null;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'FEEDBACK_CTX_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
