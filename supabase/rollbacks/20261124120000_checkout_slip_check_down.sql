-- Rolls back 20261124120000_checkout_slip_check.sql: the customer's check follows own_reader_enabled again (an app that does not find "checkout" reads "enabled").
drop function if exists public.finance_set_checkout_check(boolean);
create or replace function public.finance_own_reader()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  return jsonb_build_object('enabled', coalesce((select s.own_reader_enabled from public.finance_settings s where s.id), false),
    'can_read', coalesce(public.finance_can('verify'), false), 'can_manage', coalesce(public.finance_can('manage'), false));
end $$;
alter table public.finance_settings drop column if exists checkout_check_enabled;
