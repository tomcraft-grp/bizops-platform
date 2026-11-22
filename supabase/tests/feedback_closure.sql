-- Tests for 20261122100000_feedback_closure_tracking.sql, run after the migration inside ONE transaction that always rolls back
-- (scripts/run-feedback-closure-sql-tests.sh). Uses real profiles of the live project: L1 and L2 are customers (role USER), STAFF is a SUPER_ADMIN.
create temp table t_res (n serial, test text, ok boolean, detail text);
grant all on t_res to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create temp table t_ids (k text primary key, id text);
grant all on t_ids to authenticated;
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

-- ------------------------------------------------------------------------------------------------ back-fill
insert into t_res (test, ok, detail) select 'C1 every existing issue has status_changed_at',
  count(*) filter (where status_changed_at is null) = 0, count(*) filter (where status_changed_at is null) || ' without' from public.bizops_feedback_issues;
insert into t_res (test, ok, detail) select 'C1 existing issues keep their status (no data changed)',
  count(*) filter (where status <> 'submitted') = 0, string_agg(distinct status, ',') from public.bizops_feedback_issues;
insert into t_res (test, ok, detail) select 'C1 stamp trigger cannot be called by clients',
  not has_function_privilege('authenticated', 'public.feedback_stamp_issue()', 'execute'), null;

-- ------------------------------------------------------------------------------------------------ L1 reports two issues
set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
insert into t_ids select 'a', id from public.feedback_submit('bug', 'Closure test A', 'Something broke', 'high', '/app', null, null, 'line-liff', null, null, null, null, 'mobile', 'closure-test-a');
insert into t_ids select 'b', id from public.feedback_submit('bug', 'Closure test B', 'Something else', 'low', '/app', null, null, 'line-liff', null, null, null, null, 'mobile', 'closure-test-b');
insert into t_res (test, ok, detail) select 'C2 new issue: submitted, status_changed_at set, nothing closed',
  status = 'submitted' and status_changed_at is not null and closed_at is null and resolved_by_label is null, status from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a');
do $$ begin
  begin perform public.feedback_staff_update((select id from t_ids where k = 'a'), 'closed'); insert into t_res (test, ok, detail) values ('C3 reporter cannot close', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('C3 reporter cannot close', sqlstate = '42501', sqlerrm); end;
  begin update public.bizops_feedback_issues set closed_at = now(), closed_by_label = 'me' where id = (select id from t_ids where k = 'a');
    insert into t_res (test, ok, detail) values ('C3 reporter cannot write the tracking columns', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('C3 reporter cannot write the tracking columns', true, sqlerrm); end;
end $$;
reset role;

-- ------------------------------------------------------------------------------------------------ STAFF works issue A to the end
set local role authenticated;
select pg_temp.as_user('d6bd07da-8481-47cb-88b6-9f176d8b9105');
select public.feedback_staff_update((select id from t_ids where k = 'a'), p_assigned_to => 'd6bd07da-8481-47cb-88b6-9f176d8b9105');
insert into t_res (test, ok, detail) select 'C4 assigning fills handler_label', handler_label is not null and handler_label = public.feedback_actor_label(), handler_label
  from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a');
do $$ begin
  begin perform public.feedback_staff_update((select id from t_ids where k = 'a'), 'closed'); insert into t_res (test, ok, detail) values ('C5 submitted -> closed refused', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('C5 submitted -> closed refused', sqlerrm like 'Cannot move%', sqlerrm); end;
end $$;
select public.feedback_staff_update((select id from t_ids where k = 'a'), 'in_progress');
do $$ begin
  begin perform public.feedback_staff_update((select id from t_ids where k = 'a'), 'resolved'); insert into t_res (test, ok, detail) values ('C6 resolving without a resolution refused', false, 'ALLOWED');
  exception when others then insert into t_res (test, ok, detail) values ('C6 resolving without a resolution refused', sqlerrm like 'Record the resolution%', sqlerrm); end;
end $$;
select public.feedback_staff_update((select id from t_ids where k = 'a'), 'resolved', p_resolution => 'Fixed the redeem button in build 0.1.1');
insert into t_res (test, ok, detail) select 'C7 resolved: resolved_by_label, resolved_at, resolution stored',
  status = 'resolved' and resolved_by_label = public.feedback_actor_label() and resolved_at is not null and resolution like 'Fixed%' and closed_at is null, resolved_by_label
  from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a');
select public.feedback_staff_update((select id from t_ids where k = 'a'), 'closed', p_reason => 'Confirmed working with the customer');
insert into t_res (test, ok, detail) select 'C8 closed: closed_at + closed_by_label set, resolver kept',
  status = 'closed' and closed_at is not null and closed_by_label = public.feedback_actor_label() and resolved_by_label is not null, coalesce(closed_by_label, 'null')
  from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a');
insert into t_res (test, ok, detail) select 'C8 status history has submitted -> in_progress -> resolved -> closed',
  string_agg(to_value, '>' order by id) = 'submitted>in_progress>resolved>closed', string_agg(to_value, '>' order by id)
  from public.feedback_events where issue_id = (select id from t_ids where k = 'a') and kind in ('created', 'status');
reset role;

-- ------------------------------------------------------------------------------------------------ L1 sees the outcome; L2 sees nothing
set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
insert into t_res (test, ok, detail) select 'C9 reporter reads status, resolution, resolver, closer, handler, times',
  status = 'closed' and resolution is not null and resolved_by_label is not null and closed_by_label is not null and closed_at is not null and handler_label is not null and status_changed_at is not null, null
  from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a');
insert into t_res (test, ok, detail) select 'C9 reporter sees the closing note in the visible history',
  exists (select 1 from public.feedback_events where issue_id = (select id from t_ids where k = 'a') and kind = 'status' and to_value = 'closed' and note = 'Confirmed working with the customer'), null;
insert into t_res (test, ok, detail) select 'C9 reporter got a notification for every status change (in_progress, resolved, closed)',
  count(*) = 3, string_agg(body, ',' order by created_at) from public.feedback_notifications where issue_id = (select id from t_ids where k = 'a') and kind = 'status';
insert into t_res (test, ok, detail) select 'C9 reporter does not see the assignment event (internal)',
  not exists (select 1 from public.feedback_events where issue_id = (select id from t_ids where k = 'a') and kind = 'assigned'), null;
reset role;
set local role authenticated;
select pg_temp.as_user('5b6b3ddf-2ec5-4d47-9b0e-47f2d991aa84');
insert into t_res (test, ok, detail) select 'C10 another customer cannot read the issue or its history',
  (select count(*) from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a')) = 0
  and (select count(*) from public.feedback_events where issue_id = (select id from t_ids where k = 'a')) = 0, null;
reset role;

-- ------------------------------------------------------------------------------------------------ reopen clears the closure
set local role authenticated;
select pg_temp.as_user('d6bd07da-8481-47cb-88b6-9f176d8b9105');
select public.feedback_staff_update((select id from t_ids where k = 'a'), 'under_review', p_reason => 'Customer says it is back');
insert into t_res (test, ok, detail) select 'C11 reopened: closed_at / closed_by / resolved_by cleared, resolved_at cleared',
  status = 'under_review' and closed_at is null and closed_by_label is null and resolved_by_label is null and resolved_at is null, null
  from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a');
-- rejection of issue B: not closed, reason visible
select public.feedback_staff_update((select id from t_ids where k = 'b'), 'rejected', p_reason => 'Works as designed');
insert into t_res (test, ok, detail) select 'C12 rejected: closed_at stays empty, status_changed_at set',
  status = 'rejected' and closed_at is null and status_changed_at is not null, null from public.bizops_feedback_issues where id = (select id from t_ids where k = 'b');
-- unassigning clears the handler
select public.feedback_staff_update((select id from t_ids where k = 'a'), p_unassign => true);
insert into t_res (test, ok, detail) select 'C13 unassigning clears handler_label', handler_label is null, handler_label from public.bizops_feedback_issues where id = (select id from t_ids where k = 'a');
reset role;

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'FEEDBACK_CLOSURE_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
