-- Rolls back 20261127120000_points_transfer.sql: rw_admin_adjust_points returns to its previous definition (verbatim, as the live database printed it), every new function, table and the sequence go.
-- Refuses once a transfer exists (that history would be lost). Member codes and notices are dropped with it. Afterwards delete version 20261127120000 from supabase_migrations.schema_migrations.
do $$ begin
  if exists (select 1 from public.rw_point_transfers) then raise exception 'REFUSING: points transfers exist (the history would be lost)'; end if;
end $$;

CREATE OR REPLACE FUNCTION public.rw_admin_adjust_points(p_profile uuid, p_points integer, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_reason text := btrim(coalesce(p_reason, '')); bal integer;
begin
  perform public.rw_require_super('adjust points');
  if length(v_reason) < 3 then raise exception 'REASON_REQUIRED'; end if;
  if not coalesce((select enabled from public.rw_settings where id), false) then raise exception 'REWARDS_OFF'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 100000 then raise exception 'LIMIT_REACHED: an adjustment is between 1 and 100000 points'; end if;
  if not exists (select 1 from public.profiles where id = p_profile) then raise exception 'NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rw:' || p_profile::text, 0));
  select coalesce(sum(points), 0)::integer into bal from public.rw_points_ledger where profile_id = p_profile;
  if bal + p_points < 0 then raise exception 'LIMIT_REACHED: the balance (%) cannot go below zero', bal; end if;
  insert into public.rw_points_ledger (profile_id, points, kind, source_key, note, created_by) values (p_profile, p_points, 'adjust', 'adjust', left(v_reason, 300), auth.uid());
  perform public.rw_log('points.adjust', 'profile', p_profile::text, p_profile, v_reason, jsonb_build_object('points', p_points, 'balance_before', bal));
  return bal + p_points;
end $function$;

drop function public.rw_admin_cancel_transfer(uuid, text);
drop function public.rw_admin_transfers(text, text, integer, integer);
drop function public.rw_admin_save_transfer_settings(jsonb);
drop function public.rw_admin_transfer_settings();
drop function public.rw_transfer_mark_read();
drop function public.rw_transfer_overview();
drop function public.rw_transfer_cancel(uuid);
drop function public.rw_transfer_reject(uuid, text);
drop function public.rw_transfer_accept(uuid);
drop function public.rw_transfer_create(text, integer, text, text);
drop function public.rw_transfer_lookup(text);
drop function public.rw_transfer_lookup_guard(uuid);
drop function public.rw_transfer_expire(uuid);
drop function public.rw_transfer_json(public.rw_point_transfers, uuid);
drop function public.rw_transfer_note(uuid, uuid, text);
drop function public.rw_member_code_of(uuid);
drop function public.rw_new_member_code();
drop function public.rw_short_name(uuid);
drop function public.rw_mask_member_code(text);
drop function public.rw_fmt_member_code(text);
drop function public.rw_norm_member_code(text);
drop function public.rw_points_available(uuid);
drop function public.rw_points_reserved(uuid);
drop function public.rw_points_balance(uuid);
drop function public.rw_transfers_on();
drop table public.rw_transfer_notices;
drop table public.rw_point_transfers;
drop function public.rw_transfers_guard();
drop function public.rw_transfers_no_truncate();
drop sequence public.rw_transfer_seq;
drop table public.rw_members;
drop table public.rw_transfer_settings;
