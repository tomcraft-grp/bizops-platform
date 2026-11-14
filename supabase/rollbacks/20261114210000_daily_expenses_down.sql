-- Rollback for 20261114210000_daily_expenses.sql. Run as postgres (service role) in one transaction.
--
-- Refuses to run while any expense is waiting for a decision, approved or posted (that would orphan ledger journals that
-- point at these claims): finish or cancel them first. Drafts, rejected and cancelled claims are only workflow history and
-- are dropped. The private storage bucket expense-receipts is left in place (Supabase does not allow deleting a bucket
-- that still holds files from SQL); remove it from the dashboard if it is empty and no longer needed.

do $$
declare n bigint;
begin
  select count(*) into n from public.expense_claims where status in ('submitted', 'approved', 'posted');
  if n > 0 then raise exception 'Refusing to roll back: % expense(s) are submitted, approved or posted', n; end if;
end $$;

drop policy if exists "expense receipts: upload own folder" on storage.objects;
drop policy if exists "expense receipts: read own or reviewers" on storage.objects;

drop function if exists public.expense_dashboard(date, date, text, uuid, text, uuid);
drop function if exists public.expense_staff();
drop function if exists public.expense_set_role(uuid, text);
drop function if exists public.expense_settings_save(boolean, numeric, text, text, numeric);
drop function if exists public.expense_category_save(uuid, text, text, text, text, integer, text, text, text, numeric, text, text, boolean);
drop function if exists public.expense_mark_reversed(uuid, text, text);
drop function if exists public.expense_mark_posted(uuid, text, date, text);
drop function if exists public.expense_review(uuid, text, numeric, numeric, text, text, text, text);
drop function if exists public.expense_reject(uuid, text);
drop function if exists public.expense_approve(uuid, text);
drop function if exists public.expense_cancel(uuid, text);
drop function if exists public.expense_submit(uuid);
drop function if exists public.expense_remove_attachment(uuid);
drop function if exists public.expense_add_attachment(uuid, text, text, text, integer);
drop function if exists public.expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text);

drop table if exists public.expense_events;          -- policies and triggers go with the tables
drop table if exists public.expense_attachments;
drop table if exists public.expense_claims;
drop table if exists public.expense_counters;
drop table if exists public.expense_categories;
drop table if exists public.expense_settings;
drop table if exists public.expense_staff_roles;

drop function if exists public.expense_append_only();
drop function if exists public.expense_claims_guard();
drop function if exists public.expense_log(text, text, uuid, text, text, text, text, jsonb);
drop function if exists public.expense_calc(numeric, text, numeric);
drop function if exists public.expense_actor_name();
drop function if exists public.expense_require(text, text);
drop function if exists public.expense_can(text);
drop function if exists public.expense_role();
