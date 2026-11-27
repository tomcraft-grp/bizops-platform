-- Rolls back 20261128120000_line_multi_link.sql: the replaced functions return to their previous definitions (verbatim, as the live database printed them just before this migration), the two new
-- functions go, and a staff account is limited to one LINE account again. REFUSES while a staff account has more than one LINE account (the old table cannot hold them): unlink the extra ones first.
-- Afterwards delete version 20261128120000 from supabase_migrations.schema_migrations.
do $$ begin
  if exists (select 1 from public.line_staff_links group by profile_id having count(*) > 1) then
    raise exception 'REFUSING: a staff account has more than one LINE account (unlink the extra ones first)'; end if;
end $$;

CREATE OR REPLACE FUNCTION public.line_redeem_code(p_line_user text, p_display_name text, p_code text, p_group text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_code text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g'); b public.line_bind_codes; p public.profiles;
        v_kind text := case when p_group is null then 'staff' else 'group' end;
begin
  if coalesce(p_line_user, '') = '' then return jsonb_build_object('result', 'bad_code'); end if;
  if (select count(*) from public.line_code_attempts where line_user_id = p_line_user and at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('result', 'rate_limited'); end if;
  if v_code ~ '^[0-9]{6}$' then
    select * into b from public.line_bind_codes where code_hash = public.line_code_hash(v_code) and used_at is null and expires_at > now() and kind = v_kind
      order by created_at desc limit 1 for update;
  end if;
  if b.id is not null then
    select * into p from public.profiles where id = b.profile_id and status = 'active'
      and role = any (case when v_kind = 'group' then array['SUPER_ADMIN'] else array['ADMIN', 'SUPER_ADMIN'] end);
  end if;
  if b.id is null or p.id is null then
    insert into public.line_code_attempts (line_user_id) values (p_line_user);
    return jsonb_build_object('result', 'bad_code');
  end if;
  update public.line_bind_codes set used_at = now() where id = b.id;
  -- the audit rows name the person who made the code
  perform set_config('request.jwt.claim.sub', p.id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p.id, 'role', 'authenticated', 'email', p.email)::text, true);
  if v_kind = 'staff' then
    delete from public.line_staff_links where line_user_id = p_line_user or profile_id = p.id;
    insert into public.line_staff_links (profile_id, line_user_id, display_name) values (p.id, p_line_user, left(p_display_name, 120));
    perform public.shop_log('line', p.id::text, 'line.link', jsonb_build_object('line_name', left(p_display_name, 120)));
    return jsonb_build_object('result', 'linked', 'name', coalesce(p.display_name, p.email));
  end if;
  update public.line_settings set group_id = p_group, group_name = left(p_display_name, 120), group_bound_at = now(), group_bound_by = p.id, group_left_at = null where id;
  perform public.shop_log('line', 'settings', 'line.group_bind', jsonb_build_object('group_name', left(p_display_name, 120)));
  return jsonb_build_object('result', 'group_bound', 'name', coalesce(p.display_name, p.email));
end $function$;

CREATE OR REPLACE FUNCTION public.line_act(p_line_user text, p_action text, p_order uuid, p_card uuid, p_reason integer DEFAULT NULL::integer, p_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p public.profiles; o public.shop_orders; s public.line_settings; q jsonb; v_name text; v_reason text; v_last jsonb; ev uuid; m text; st text;
begin
  if p_action not in ('accept', 'quick_ask', 'quick_confirm', 'reject_ask', 'reject') then return jsonb_build_object('result', 'refused', 'code', 'UNKNOWN_ACTION'); end if;
  if p_card is null or not exists (select 1 from public.line_outbox where id = p_card and order_id = p_order) then
    return jsonb_build_object('result', 'refused', 'code', 'UNKNOWN_CARD'); end if;
  select pr.* into p from public.line_staff_links l join public.profiles pr on pr.id = l.profile_id where l.line_user_id = p_line_user;
  if not found then return jsonb_build_object('result', 'not_linked'); end if;
  if p.status <> 'active' or p.role not in ('ADMIN', 'SUPER_ADMIN') then return jsonb_build_object('result', 'not_allowed', 'why', 'not_staff'); end if;
  -- from here on auth.uid() is this staff member (both settings: auth.uid() reads claim.sub first), for this transaction only
  perform set_config('request.jwt.claim.sub', p.id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p.id, 'role', 'authenticated', 'email', p.email)::text, true);
  perform set_config('line.via_line', 'on', true);
  v_name := public.line_person(p.id);
  select * into s from public.line_settings where id;
  select * into o from public.shop_orders where id = p_order for update;              -- two taps at the same moment: the second waits here, then sees the new status
  if not found then return jsonb_build_object('result', 'refused', 'code', 'NOT_FOUND'); end if;
  if o.status <> 'new' then
    v_last := public.line_last_action(o.id);
    return jsonb_build_object('result', 'already_done', 'order_no', o.order_no, 'status', o.status, 'by', v_last ->> 'by', 'at', v_last ->> 'at');
  end if;
  if p_action = 'reject_ask' then
    return jsonb_build_object('result', 'ask_reason', 'order_no', o.order_no, 'reasons', to_jsonb(s.reject_reasons)); end if;
  begin
    if p_action = 'accept' then
      perform public.shop_admin_set_status(o.id, 'confirmed');
      perform public.shop_log('order', o.id::text, 'order.line', jsonb_build_object('via', 'line', 'action', 'accept'));
      return jsonb_build_object('result', 'done', 'action', 'accept', 'order_no', o.order_no, 'by', v_name, 'at', now());
    elsif p_action in ('quick_ask', 'quick_confirm') then
      if not public.finance_can('verify') then return jsonb_build_object('result', 'not_allowed', 'why', 'not_verifier'); end if;
      q := public.line_slip_done(o.id);                                                  -- the payment was already handled on the web: say by whom
      if q is not null then return q; end if;
      q := public.line_quick_check(o.id);
      if not (q ->> 'ok')::boolean then return jsonb_build_object('result', 'refused', 'code', q ->> 'why'); end if;
      if p_action = 'quick_ask' then
        return jsonb_build_object('result', 'ask_quick', 'order_no', o.order_no, 'amount', q -> 'amount', 'bank', q ->> 'bank', 'transfer_at', q ->> 'transfer_at'); end if;
      perform public.finance_quick_confirm_evidence((q ->> 'evidence_id')::uuid);
      perform public.shop_admin_set_status(o.id, 'confirmed');
      perform public.shop_log('order', o.id::text, 'order.line', jsonb_build_object('via', 'line', 'action', 'quick_confirm', 'evidence', q ->> 'evidence_id', 'amount', q -> 'amount'));
      return jsonb_build_object('result', 'done', 'action', 'quick_confirm', 'order_no', o.order_no, 'by', v_name, 'at', now(), 'amount', q -> 'amount');
    else -- reject
      if p_reason is null or p_reason < 0 or p_reason >= coalesce(array_length(s.reject_reasons, 1), 0) then
        return jsonb_build_object('result', 'refused', 'code', 'BAD_REASON'); end if;
      v_reason := s.reject_reasons[p_reason + 1];
      if exists (select 1 from public.finance_payment_evidence where invoice_id = o.invoice_id and status in ('submitted', 'confirmed', 'more_evidence'))
         and not public.finance_can('verify') then
        return jsonb_build_object('result', 'not_allowed', 'why', 'not_verifier'); end if;
      for ev in select id from public.finance_payment_evidence where invoice_id = o.invoice_id and status in ('submitted', 'confirmed', 'more_evidence') order by created_at loop
        perform public.finance_reject_evidence(ev, v_reason);
      end loop;
      perform public.shop_admin_set_status(o.id, 'cancelled', v_reason);
      perform public.shop_log('order', o.id::text, 'order.line', jsonb_build_object('via', 'line', 'action', 'reject', 'reason', v_reason));
      return jsonb_build_object('result', 'done', 'action', 'reject', 'order_no', o.order_no, 'by', v_name, 'at', now(), 'reason', v_reason);
    end if;
  exception when others then                                                          -- everything this block did is undone (a sub-transaction)
    get stacked diagnostics m = message_text, st = returned_sqlstate;
    if m like 'This slip is already %' then                                              -- confirmed on the web between the check and the tap
      q := public.line_slip_done(o.id);
      if q is not null then return q; end if;
    end if;
    return jsonb_build_object('result', case when st = '42501' then 'not_allowed' else 'refused' end,
      'code', case when m like 'PAYMENT_RECORDED%' then 'PAYMENT_RECORDED' when m like 'DUPLICATE_SUSPECT%' then 'DUPLICATE_SUSPECT' when m like 'PAYMENT_REQUIRED%' then 'PAYMENT_REQUIRED'
                   when st = '42501' then 'NOT_ALLOWED' else 'ERROR' end,
      'why', case when st = '42501' then 'not_staff' end, 'message', left(m, 300));
  end;
end $function$;

CREATE OR REPLACE FUNCTION public.line_last_action(p_order uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object('by', coalesce(public.line_person(e.actor), e.actor_email, 'ระบบ'), 'at', e.at)
    from public.shop_events e where e.entity = 'order' and e.entity_id = p_order::text
      and ((e.action = 'order.status' and e.detail ->> 'from' = 'new') or e.action = 'order.cancel')   -- who took it out of "new" (not who moved it on later)
    order by e.id desc limit 1
$function$;

CREATE OR REPLACE FUNCTION public.line_admin_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.line_settings; sup boolean;
begin
  perform public.shop_require_staff('see the LINE settings');
  select * into s from public.line_settings where id;
  sup := public.line_is_super();
  return jsonb_build_object(
    'enabled', s.enabled,
    'group', case when s.group_id is null then null else jsonb_build_object('name', s.group_name, 'bound_at', s.group_bound_at) end,
    'group_left_at', s.group_left_at,
    'events', s.events, 'quick_approve_enabled', s.quick_approve_enabled, 'quick_approve_max_amount', s.quick_approve_max_amount,
    'reject_reasons', to_jsonb(s.reject_reasons), 'app_url', s.app_url,
    'secret_set', s.secret_set_at is not null, 'secret_set_at', s.secret_set_at,
    'token_set', s.token_set_at is not null, 'token_set_at', s.token_set_at,
    'can_edit', sup,
    'my_link', (select jsonb_build_object('display_name', l.display_name, 'linked_at', l.linked_at) from public.line_staff_links l where l.profile_id = auth.uid()),
    'links', case when sup then coalesce((select jsonb_agg(jsonb_build_object('profile_id', l.profile_id, 'name', coalesce(p.display_name, p.email), 'email', p.email,
               'line_name', l.display_name, 'linked_at', l.linked_at) order by l.linked_at)
             from public.line_staff_links l join public.profiles p on p.id = l.profile_id), '[]'::jsonb) else null end,
    'webhook_url', 'https://hlvravynjalculvplrxc.supabase.co/functions/v1/line-webhook');
end $function$;

CREATE OR REPLACE FUNCTION public.preorder_notify(p_kind text, p_order uuid, p_audience text, p_dedupe text, p_data jsonb DEFAULT '{}'::jsonb, p_profile uuid DEFAULT NULL::uuid, p_line boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.shop_orders; nid uuid; v_text text; s public.line_settings; v_target text; v_type text; ev text; ob uuid;
begin
  begin
    select * into o from public.shop_orders where id = p_order;
    if not found then return; end if;
    v_text := public.preorder_msg(p_kind, p_order, p_data);
    insert into public.preorder_notices (order_id, audience, profile_id, kind, dedupe_key, data, text_th)
      values (p_order, p_audience, case when p_audience = 'customer' then o.profile_id else p_profile end, p_kind, p_dedupe, coalesce(p_data, '{}'::jsonb), v_text)
      on conflict (dedupe_key) do nothing returning id into nid;
  exception when others then
    raise warning 'preorder notice skipped (order %, %): %', p_order, p_kind, sqlerrm; return;
  end;
  if nid is null or not p_line then return; end if;
  begin
    select * into s from public.line_settings where id;
    if s.id is null or not s.enabled then return; end if;
    if p_audience = 'customer' then
      ev := 'preorder_customer'; v_type := 'user'; select line_user_id into v_target from public.profiles where id = o.profile_id;
    elsif p_profile is not null then
      ev := 'preorder_staff'; v_type := 'user'; select line_user_id into v_target from public.line_staff_links where profile_id = p_profile;
    else
      ev := 'preorder'; v_type := 'group'; v_target := s.group_id;
    end if;
    if v_target is null or not coalesce((s.events ->> ev)::boolean, false) then return; end if;
    insert into public.line_outbox (event, order_id, target_type, target_id, payload)
      values ('preorder', p_order, v_type, v_target, jsonb_build_object('kind', p_kind, 'order_no', o.order_no, 'text', v_text, 'audience', p_audience)) returning id into ob;
    update public.preorder_notices set outbox_id = ob where id = nid;
  exception when others then
    raise warning 'preorder LINE message skipped (order %, %): %', p_order, p_kind, sqlerrm;
  end;
end $function$;

drop function if exists public.line_unlink_account(text);
drop function if exists public.line_person_via(uuid, text);
drop index if exists public.line_staff_links_profile_idx;
alter table public.line_staff_links drop constraint line_staff_links_pkey;
alter table public.line_staff_links add constraint line_staff_links_line_user_id_key unique (line_user_id);
alter table public.line_staff_links add constraint line_staff_links_pkey primary key (profile_id);
