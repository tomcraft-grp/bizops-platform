-- The slip check the customer sees BEFORE ordering gets its own switch (it runs on the customer's own phone: it warns and asks them to confirm, it stores and decides nothing).
-- Until now it followed own_reader_enabled; the new switch starts with that value, so nothing changes by itself. Rollback: supabase/rollbacks/20261124120000_checkout_slip_check_down.sql.
do $m$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings' and column_name = 'checkout_check_enabled') then
    alter table public.finance_settings add column checkout_check_enabled boolean not null default false;
    update public.finance_settings set checkout_check_enabled = own_reader_enabled where id;
  end if;
end $m$;

-- as before, plus the customer's switch and how far from now a slip may be dated (the two numbers of the Review settings card: the phone judges a date with the shop's own rule)
create or replace function public.finance_own_reader()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.finance_settings;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into s from public.finance_settings where id;
  return jsonb_build_object('enabled', coalesce(s.own_reader_enabled, false), 'can_read', coalesce(public.finance_can('verify'), false), 'can_manage', coalesce(public.finance_can('manage'), false),
    'checkout', coalesce(s.checkout_check_enabled, false), 'before_min', coalesce(s.slip_window_before_min, 120), 'after_min', coalesce(s.slip_future_tolerance_min, 10));
end $$;

create or replace function public.finance_set_checkout_check(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old boolean;
begin
  perform public.finance_require('manage', 'change the review settings');
  if p_on is null then raise exception 'INVALID_SETTING' using errcode = '22023'; end if;
  select checkout_check_enabled into v_old from public.finance_settings where id for update;
  update public.finance_settings set checkout_check_enabled = p_on where id;
  perform public.finance_log('settings', gen_random_uuid(), 'settings.checkout_check', jsonb_build_object('from', v_old, 'to', p_on));
  return public.finance_own_reader();
end $$;
revoke execute on function public.finance_set_checkout_check(boolean) from public, anon;
grant execute on function public.finance_set_checkout_check(boolean) to authenticated;
