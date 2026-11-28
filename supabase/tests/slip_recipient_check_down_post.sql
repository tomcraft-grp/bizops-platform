-- After the rollback of 20261128150000 (run on a database that has it, in one transaction that is rolled back):
--   node scripts/local-pg/run.mjs supabase/rollbacks/20261128150000_slip_recipient_check_down.sql supabase/tests/slip_recipient_check_down_post.sql
-- The four functions are back to the text they had before it (compared without carriage returns: the same SQL is stored with CRLF or LF depending on the machine that sent it).
create temp table t_res (n serial, test text, ok boolean, detail text);
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.h(p text) returns text language sql as $$ select md5(replace(pg_get_functiondef(p::regprocedure), chr(13), '')) $$;

select pg_temp.chk('D1 the classifier is the one of before', pg_temp.h('public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb)') = 'cc14cef69600f272bb96142fbfdf6500', pg_temp.h('public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb)'));
select pg_temp.chk('D2 the AI completion is the one of before', pg_temp.h('public.finance_analysis_complete(uuid, jsonb, jsonb, numeric, jsonb, text, text)') = 'ebfaaf7b06884b46e31dd690a8908b25');
select pg_temp.chk('D3 the own reader is the one of before (= live before the change)', pg_temp.h('public.finance_store_reading(uuid, jsonb, jsonb, numeric, text, text)') = '48ea39a979973b5dace13267fe0b30b1');
select pg_temp.chk('D4 finance_own_reader is the one of before (= live before the change)', pg_temp.h('public.finance_own_reader()') = '779a80c9b297e286e1bd5bc95cf398fd');
select pg_temp.chk('D5 every function the migration added is gone', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  and p.proname in ('finance_slip_learning', 'finance_slip_variant_retire', 'finance_slip_variant_add', 'finance_slip_variant_impact', 'finance_slip_recipients', 'finance_slip_feedback_add',
                    'finance_slip_decision', 'finance_recipient_check', 'finance_recipient_candidates', 'finance_recipient_match', 'finance_slip_holders', 'finance_name_parts', 'finance_name_dist',
                    'finance_name_key', 'finance_name_untitle', 'finance_name_tidy')));
select pg_temp.chk('D6 with nothing recorded, the tables and columns are gone too', to_regclass('public.finance_slip_feedback') is null and to_regclass('public.finance_slip_name_variants') is null
  and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_slip_analysis' and column_name in ('decision', 'recipient', 'rules_version')));
select pg_temp.chk('D7 the grants of before: the classifier stays internal, the own reader is for signed-in users',
  not has_function_privilege('authenticated', 'public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.finance_store_reading(uuid, jsonb, jsonb, numeric, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.finance_own_reader()', 'execute'));

do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'RECIPIENT_DOWN_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
