-- Permission/workflow tests for 20261114120000_feedback_issue_system.sql.
-- Run as: begin; <migration>; <this file>; rollback;  (nothing persists). Uses real profile IDs of the live project.
-- Last run 2026-11-14: 38/38 expected outcomes (see the commit message).
-- Appended after the migration inside one transaction that is ROLLED BACK. Results go to a temp table.
create temp table t_res (n serial, test text, result text);
grant all on t_res to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;

create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

-- legacy rows migrated
insert into t_res (test, result) select 'legacy statuses', string_agg(id || '=' || status, ', ') from public.bizops_feedback_issues;
insert into t_res (test, result) select 'legacy notes -> internal comments', count(*)::text from public.feedback_comments where kind = 'internal';

-- L1 submits
set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
insert into t_res (test, result) select 'L1 submit', id || ' ' || status || ' ' || source || ' path=' || page_path
  from public.feedback_submit('bug', 'Cannot redeem', 'Button does nothing', 'high', '/app?access_token=SECRET#x', 'Rewards', 'rewards', 'line-liff', '0.1.0', 'production', 'UA', 'Android 14', 'mobile', 'k1');
insert into t_res (test, result) select 'L1 idempotent resubmit returns same id', id
  from public.feedback_submit('bug', 'Cannot redeem', 'Button does nothing', 'high', '/app', null, null, 'line-liff', null, null, null, null, 'mobile', 'k1');
insert into t_res (test, result) select 'L1 sees own issues', count(*)::text from public.bizops_feedback_issues;
insert into t_res (test, result) select 'L1 notifications', string_agg(kind, ',') from public.feedback_notifications;
do $$ begin
  begin update public.bizops_feedback_issues set status = 'resolved'; insert into t_res (test, result) values ('L1 direct UPDATE', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('L1 direct UPDATE blocked', sqlerrm); end;
  begin perform public.feedback_staff_update((select id from public.bizops_feedback_issues limit 1), 'resolved'); insert into t_res (test, result) values ('L1 staff_update', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('L1 staff_update blocked', sqlerrm); end;
end $$;
reset role;

-- L2 cannot see or touch L1's issue
set local role authenticated;
select pg_temp.as_user('5b6b3ddf-2ec5-4d47-9b0e-47f2d991aa84');
insert into t_res (test, result) select 'L2 sees issues', count(*)::text from public.bizops_feedback_issues;
do $$ begin
  begin perform public.feedback_customer_message((select max(id) from public.bizops_feedback_issues), 'hi');
    insert into t_res (test, result) values ('L2 message on L1 issue', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('L2 message on L1 issue blocked', sqlerrm); end;
end $$;
reset role;
-- (the max(id) above ran as L2 and saw nothing, so also try with the real id)
create temp table t_ids as select id from public.bizops_feedback_issues where reporter_id = 'c540e31a-eb9b-4c2c-a481-d449866b1e74';
grant select on t_ids to authenticated;
set local role authenticated;
select pg_temp.as_user('5b6b3ddf-2ec5-4d47-9b0e-47f2d991aa84');
do $$ begin
  begin perform public.feedback_customer_message((select id from t_ids), 'hi');
    insert into t_res (test, result) values ('L2 message with L1 real id', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('L2 message with L1 real id blocked', sqlerrm); end;
end $$;
reset role;

-- staff (ADMIN) works the issue
set local role authenticated;
select pg_temp.as_user('d6bd07da-8481-47cb-88b6-9f176d8b9105');
insert into t_res (test, result) select 'staff sees issues', count(*)::text from public.bizops_feedback_issues;
insert into t_res (test, result) select 'staff internal note', kind from public.feedback_staff_comment((select id from t_ids), 'internal', 'Looks like a null customer id', false);
insert into t_res (test, result) select 'staff ask info', kind || ' requests=' || requests_info from public.feedback_staff_comment((select id from t_ids), 'reply', 'Which reward?', true);
insert into t_res (test, result) select 'status after info request', status from public.bizops_feedback_issues where id = (select id from t_ids);
do $$ begin
  begin perform public.feedback_staff_update((select id from t_ids), 'closed'); insert into t_res (test, result) values ('illegal transition', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('illegal transition blocked', sqlerrm); end;
  begin perform public.feedback_staff_update((select id from t_ids), 'rejected'); insert into t_res (test, result) values ('reject without reason', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('reject without reason blocked', sqlerrm); end;
end $$;
reset role;

-- L1 answers; sees reply but not the internal note
set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
insert into t_res (test, result) select 'L1 visible comments', string_agg(kind, ',' order by created_at) from public.feedback_comments;
insert into t_res (test, result) select 'L1 visible events', string_agg(kind || ':' || coalesce(to_value, ''), ',' order by id) from public.feedback_events;
insert into t_res (test, result) select 'L1 answers', kind from public.feedback_customer_message((select id from t_ids), 'The coffee one');
insert into t_res (test, result) select 'status after customer answer', status from public.bizops_feedback_issues;
insert into t_res (test, result) select 'L1 unread notifications', count(*)::text from public.feedback_notifications where read_at is null;
insert into t_res (test, result) select 'L1 mark read', public.feedback_mark_read(null)::text;
reset role;

-- staff resolves properly
set local role authenticated;
select pg_temp.as_user('d6bd07da-8481-47cb-88b6-9f176d8b9105');
insert into t_res (test, result) select 'to in_progress + assign', status || ' assigned=' || (assigned_to is not null)
  from public.feedback_staff_update((select id from t_ids), 'in_progress', p_assigned_to => 'a95c6a21-03b3-4b79-83c9-0731add9bfa1');
do $$ begin
  begin perform public.feedback_staff_update((select id from t_ids), 'resolved'); insert into t_res (test, result) values ('resolve w/o resolution', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('resolve w/o resolution blocked', sqlerrm); end;
end $$;
insert into t_res (test, result) select 'resolve with resolution', status || ' resolved_at=' || (resolved_at is not null)
  from public.feedback_staff_update((select id from t_ids), 'resolved', p_resolution => 'Fixed in 0.1.1', p_root_cause => 'null id');
insert into t_res (test, result) select 'dev link', kind from public.feedback_add_dev_link((select id from t_ids), 'commit', 'abc1234', 'https://github.com/x/y/commit/abc1234', 'PRODUCTION');
reset role;

-- anon has nothing
set local role anon;
do $$ begin
  begin perform count(*) from public.bizops_feedback_issues; insert into t_res (test, result) values ('anon select', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('anon select blocked', sqlerrm); end;
end $$;
reset role;

insert into t_res (test, result) select 'event trail rows for issue', count(*)::text from public.feedback_events where issue_id = (select id from t_ids);
insert into t_res (test, result) select 'notifications by kind', string_agg(kind || '→' || left(recipient_id::text, 4), ', ' order by created_at) from public.feedback_notifications where issue_id = (select id from t_ids);
-- storage + attachment permissions (appended after feedback-tests.sql, still inside the rolled-back transaction)
set local role authenticated;
select pg_temp.as_user('c540e31a-eb9b-4c2c-a481-d449866b1e74');
do $$ declare iid text := (select id from t_ids); begin
  begin insert into storage.objects (bucket_id, name, owner, owner_id) values ('feedback-attachments', iid || '/a.png', auth.uid(), auth.uid()::text);
    insert into t_res (test, result) values ('L1 upload to own issue', 'ok');
  exception when others then insert into t_res (test, result) values ('L1 upload to own issue FAILED', sqlerrm); end;
  begin perform public.feedback_add_attachment(iid, iid || '/a.png', 'shot.png', 'image/png', 1234);
    insert into t_res (test, result) values ('L1 record attachment', 'ok');
  exception when others then insert into t_res (test, result) values ('L1 record attachment FAILED', sqlerrm); end;
  begin perform public.feedback_add_attachment(iid, iid || '/missing.png', 'x.png', 'image/png', 1);
    insert into t_res (test, result) values ('record attachment w/o upload', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('record attachment w/o upload blocked', sqlerrm); end;
  begin perform public.feedback_add_attachment(iid, iid || '/a.svg', 'x.svg', 'image/svg+xml', 1);
    insert into t_res (test, result) values ('svg attachment', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('svg attachment blocked', left(sqlerrm, 60)); end;
end $$;
reset role;
set local role authenticated;
select pg_temp.as_user('5b6b3ddf-2ec5-4d47-9b0e-47f2d991aa84');
do $$ declare iid text := (select id from t_ids); begin
  begin insert into storage.objects (bucket_id, name, owner, owner_id) values ('feedback-attachments', iid || '/evil.png', auth.uid(), auth.uid()::text);
    insert into t_res (test, result) values ('L2 upload into L1 issue', 'ALLOWED (BAD)');
  exception when others then insert into t_res (test, result) values ('L2 upload into L1 issue blocked', left(sqlerrm, 80)); end;
end $$;
insert into t_res (test, result) select 'L2 sees L1 attachments (rows)', count(*)::text from public.feedback_attachments;
insert into t_res (test, result) select 'L2 sees L1 files (storage)', count(*)::text from storage.objects where bucket_id = 'feedback-attachments';
reset role;
set local role authenticated;
select pg_temp.as_user('d6bd07da-8481-47cb-88b6-9f176d8b9105');
insert into t_res (test, result) select 'staff sees attachments', count(*)::text from public.feedback_attachments;
reset role;
select n, test, result from t_res where n > 30 order by n;
