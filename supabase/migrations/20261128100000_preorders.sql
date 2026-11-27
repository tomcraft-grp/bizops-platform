-- Preorder / scheduled pickup (design: docs/superpowers/specs/2026-11-27-preorders-design.md, guide: docs/preorders.md).
-- A preorder is a pick-up order WITH a schedule: shop_orders.order_type = 'preorder' + pickup_at. Payment, invoice, slip, wallet, rewards, the status engine, the audit trail
-- (shop_events) and the LINE group card are the existing ones. Additive and backward compatible: every existing order is 'regular'; the feature is OFF (preorder_settings.enabled = false)
-- until a SUPER_ADMIN saves the opening hours and switches it on. No stock is reserved or deducted (there is no central stock; availability is sold-out + max per order + slot capacity).
-- Rollback: supabase/rollbacks/20261128100000_preorders_down.sql (refuses once a preorder exists).

-- ================================================================================================ A. tables
create table if not exists public.preorder_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  configured_at timestamptz,                                    -- set when a SUPER_ADMIN has saved the opening hours: the defaults below are never served unreviewed
  slot_minutes integer not null default 30 check (slot_minutes between 5 and 240),
  lead_minutes integer not null default 120 check (lead_minutes between 0 and 10080),          -- the earliest pickup is now + this
  max_advance_days integer not null default 14 check (max_advance_days between 1 and 90),
  weekly_hours jsonb not null default '[{"dow":0,"closed":false,"open":"09:00","close":"18:00"},{"dow":1,"closed":false,"open":"09:00","close":"18:00"},{"dow":2,"closed":false,"open":"09:00","close":"18:00"},{"dow":3,"closed":false,"open":"09:00","close":"18:00"},{"dow":4,"closed":false,"open":"09:00","close":"18:00"},{"dow":5,"closed":false,"open":"09:00","close":"18:00"},{"dow":6,"closed":false,"open":"09:00","close":"18:00"}]'::jsonb,
  max_orders_per_slot integer not null default 4 check (max_orders_per_slot between 1 and 500),
  max_units_per_slot integer check (max_units_per_slot is null or max_units_per_slot between 1 and 100000),
  max_units_per_day integer check (max_units_per_day is null or max_units_per_day between 1 and 1000000),
  change_cutoff_minutes integer not null default 180 check (change_cutoff_minutes between 0 and 10080),   -- the customer can change or cancel until pickup minus this
  prep_lead_minutes integer not null default 90 check (prep_lead_minutes between 0 and 10080),            -- staff are warned when a preorder is not started by pickup minus this
  reminder_minutes integer not null default 120 check (reminder_minutes between 0 and 10080),             -- the customer reminder goes out this long before pickup
  grace_minutes integer not null default 30 check (grace_minutes between 0 and 1440),                     -- "waiting for pickup" is raised this long after the pickup time
  large_order_units integer not null default 50 check (large_order_units between 1 and 100000),
  customer_note text check (customer_note is null or length(customer_note) <= 400),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
insert into public.preorder_settings (id) values (true) on conflict (id) do nothing;

-- single dates that differ from the weekly hours: a holiday / closure, or special hours
create table if not exists public.preorder_days (
  day date primary key,
  kind text not null check (kind in ('closed', 'special')),
  open_time time,
  close_time time,
  reason text check (reason is null or length(reason) <= 200),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint preorder_days_hours check (kind = 'closed' or (open_time is not null and close_time is not null and open_time < close_time))
);

-- who is responsible for an order (staff-only data, so it is not a column of the customer-readable shop_orders)
create table if not exists public.preorder_assignments (
  order_id uuid primary key references public.shop_orders (id) on delete restrict,
  assigned_to uuid not null references public.profiles (id),
  assigned_by uuid references public.profiles (id),
  assigned_at timestamptz not null default now()
);

-- the preparation checklist: one row per ticked order line (who, when). Un-ticking deletes the row; every tick and un-tick is also in shop_events.
create table if not exists public.preorder_prep_checks (
  order_id uuid not null references public.shop_orders (id) on delete restrict,
  line_no integer not null,
  checked_by uuid references public.profiles (id),
  checked_at timestamptz not null default now(),
  primary key (order_id, line_no)
);

-- the in-app inbox and the history of every preorder message. dedupe_key is unique: nothing is ever said twice. The Thai text is what LINE carries; the apps render kind + data in either language.
create table if not exists public.preorder_notices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.shop_orders (id) on delete restrict,
  audience text not null check (audience in ('customer', 'staff')),
  profile_id uuid references public.profiles (id),             -- customer: the customer; staff: the person it is addressed to (null = all staff / the group)
  kind text not null,
  dedupe_key text not null unique,
  data jsonb not null default '{}'::jsonb,
  text_th text,
  outbox_id uuid references public.line_outbox (id) on delete set null,   -- the LINE message, when one was queued (its delivery status is in the delivery log)
  created_at timestamptz not null default now()
);
create index if not exists preorder_notices_order_idx on public.preorder_notices (order_id, created_at);
create index if not exists preorder_notices_staff_idx on public.preorder_notices (audience, created_at desc);

do $$ declare t text; begin
  foreach t in array array['preorder_settings', 'preorder_days', 'preorder_assignments', 'preorder_prep_checks', 'preorder_notices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- the order itself
alter table public.shop_orders
  add column if not exists order_type text not null default 'regular',
  add column if not exists pickup_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists preparing_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists cancel_kind text,
  add column if not exists reschedule_count integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_order_type_chk') then
    alter table public.shop_orders add constraint shop_orders_order_type_chk check (order_type in ('regular', 'preorder'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_preorder_chk') then
    alter table public.shop_orders add constraint shop_orders_preorder_chk
      check ((order_type = 'regular' and pickup_at is null) or (order_type = 'preorder' and pickup_at is not null and fulfilment = 'pickup'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_orders_cancel_kind_chk') then
    alter table public.shop_orders add constraint shop_orders_cancel_kind_chk check (cancel_kind is null or cancel_kind in ('customer', 'rejected', 'staff'));
  end if;
end $$;
create index if not exists shop_orders_pickup_idx on public.shop_orders (pickup_at) where order_type = 'preorder';

-- the order type can never change after the order exists (the amounts, customer and fulfilment were already frozen)
create or replace function public.shop_guard_order()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.order_no is distinct from old.order_no or new.profile_id is distinct from old.profile_id or new.customer_id is distinct from old.customer_id
     or new.invoice_id is distinct from old.invoice_id or new.subtotal is distinct from old.subtotal or new.discount is distinct from old.discount
     or new.shipping_fee is distinct from old.shipping_fee or new.total is distinct from old.total or new.fulfilment is distinct from old.fulfilment
     or new.idempotency_key is distinct from old.idempotency_key or new.request_hash is distinct from old.request_hash or new.order_type is distinct from old.order_type then
    raise exception 'An order''s number, customer and amounts cannot be changed (cancel it and place a new one)'; end if;
  return new;
end $$;

-- ================================================================================================ B. schedule helpers (internal: no client can call them)
create or replace function public.preorder_local_day(p_ts timestamptz) returns date language sql stable set search_path = public as $$
  select (p_ts at time zone 'Asia/Bangkok')::date
$$;

-- the opening hours of one date: a closure or special hours override the weekly hours
create or replace function public.preorder_hours(p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d public.preorder_days; s public.preorder_settings; w jsonb;
begin
  select * into d from public.preorder_days where day = p_day;
  if found then
    if d.kind = 'closed' then return jsonb_build_object('closed', true, 'special', true, 'reason', d.reason); end if;
    return jsonb_build_object('closed', false, 'special', true, 'reason', d.reason, 'open', to_char(d.open_time, 'HH24:MI'), 'close', to_char(d.close_time, 'HH24:MI'));
  end if;
  select * into s from public.preorder_settings where id;
  select e into w from jsonb_array_elements(s.weekly_hours) e where (e ->> 'dow')::int = extract(dow from p_day)::int limit 1;
  if w is null or coalesce((w ->> 'closed')::boolean, false) then return jsonb_build_object('closed', true, 'special', false, 'reason', null); end if;
  return jsonb_build_object('closed', false, 'special', false, 'reason', null, 'open', w ->> 'open', 'close', w ->> 'close');
end $$;

-- every slot start of one date (a slot must fit completely inside the opening hours)
create or replace function public.preorder_grid(p_day date) returns setof timestamptz
language plpgsql stable security definer set search_path = public as $$
declare s public.preorder_settings; h jsonb; t timestamp; c timestamp;
begin
  select * into s from public.preorder_settings where id;
  h := public.preorder_hours(p_day);
  if coalesce((h ->> 'closed')::boolean, true) then return; end if;
  t := p_day + (h ->> 'open')::time; c := p_day + (h ->> 'close')::time;
  while t + make_interval(mins => s.slot_minutes) <= c loop
    return next (t at time zone 'Asia/Bangkok');
    t := t + make_interval(mins => s.slot_minutes);
  end loop;
end $$;

-- what is already booked in the slot that starts at p_slot (active preorders: not cancelled / returned); p_exclude leaves one order out (when it is being moved)
create or replace function public.preorder_load(p_slot timestamptz, p_exclude uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('orders', count(o.id), 'units', coalesce(sum(u.n), 0))
  from public.shop_orders o
  left join lateral (select sum(i.qty) n from public.shop_order_items i where i.order_id = o.id) u on true
  where o.order_type = 'preorder' and o.status not in ('cancelled', 'returned') and o.id is distinct from p_exclude
    and o.pickup_at >= p_slot and o.pickup_at < p_slot + make_interval(mins => (select slot_minutes from public.preorder_settings where id))
$$;

create or replace function public.preorder_day_units(p_day date, p_exclude uuid default null) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(i.qty), 0)::int from public.shop_orders o join public.shop_order_items i on i.order_id = o.id
  where o.order_type = 'preorder' and o.status not in ('cancelled', 'returned') and o.id is distinct from p_exclude
    and o.pickup_at >= (p_day::timestamp at time zone 'Asia/Bangkok') and o.pickup_at < ((p_day + 1)::timestamp at time zone 'Asia/Bangkok')
$$;

-- THE rule for a pickup time. Raises a coded error unless p_at is a bookable slot. It takes a lock for the pickup DAY first, so two transactions can never both take the last place.
--   customer (p_staff = false): the feature is on, p_at is not sooner than now + lead, not beyond the furthest day, it is on the grid of an open day, and capacity is left.
--   staff (p_staff = true): the feature may be off, p_at only has to be in the future and on the grid; p_force also ignores capacity (the caller records why).
create or replace function public.preorder_check_slot(p_at timestamptz, p_units integer, p_exclude uuid default null, p_staff boolean default false, p_force boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare s public.preorder_settings; d date; ld jsonb; today date := public.preorder_local_day(now()); v_units integer := greatest(coalesce(p_units, 0), 0);
begin
  select * into s from public.preorder_settings where id;
  if not p_staff and not s.enabled then raise exception 'PREORDER_OFF' using errcode = '22023'; end if;
  if p_at is null then raise exception 'SLOT_REQUIRED' using errcode = '22023'; end if;
  d := public.preorder_local_day(p_at);
  perform pg_advisory_xact_lock(hashtextextended('preorder:' || d::text, 0));
  if p_staff then
    if p_at < now() then raise exception 'SLOT_PAST' using errcode = '22023'; end if;
  else
    if p_at < now() + make_interval(mins => s.lead_minutes) then raise exception 'SLOT_TOO_SOON' using errcode = '22023'; end if;
    if d > today + s.max_advance_days then raise exception 'SLOT_TOO_FAR' using errcode = '22023'; end if;
  end if;
  if not exists (select 1 from public.preorder_grid(d) g where g = p_at) then
    if coalesce((public.preorder_hours(d) ->> 'closed')::boolean, true) then raise exception 'SLOT_CLOSED' using errcode = '22023'; end if;
    raise exception 'SLOT_INVALID' using errcode = '22023';
  end if;
  if p_force then return; end if;
  ld := public.preorder_load(p_at, p_exclude);
  if (ld ->> 'orders')::int >= s.max_orders_per_slot then raise exception 'SLOT_FULL' using errcode = '22023'; end if;
  if s.max_units_per_slot is not null and (ld ->> 'units')::int + v_units > s.max_units_per_slot then
    raise exception 'SLOT_UNITS_FULL' using errcode = '22023', detail = format('%s left', greatest(s.max_units_per_slot - (ld ->> 'units')::int, 0)); end if;
  if s.max_units_per_day is not null and public.preorder_day_units(d, p_exclude) + v_units > s.max_units_per_day then raise exception 'DAY_UNITS_FULL' using errcode = '22023'; end if;
end $$;

-- ================================================================================================ C. messages and notices
-- the Thai text LINE carries for each kind of notice
create or replace function public.preorder_msg(p_kind text, p_order uuid, p_data jsonb default '{}'::jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; w text; u integer; why text := nullif(btrim(coalesce(p_data ->> 'reason', '')), ''); old_w text;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  w := to_char(o.pickup_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI') || ' น.';
  select coalesce(sum(qty), 0) into u from public.shop_order_items where order_id = o.id;
  old_w := case when p_data ? 'from' then to_char((p_data ->> 'from')::timestamptz at time zone 'Asia/Bangkok', 'DD/MM HH24:MI') || ' น.' end;
  return case p_kind
    when 'placed' then format('ร้านได้รับพรีออเดอร์ %s แล้ว นัดรับ %s รอร้านยืนยัน', o.order_no, w)
    when 'confirmed' then format('ร้านยืนยันพรีออเดอร์ %s แล้ว นัดรับ %s', o.order_no, w)
    when 'preparing' then format('ร้านกำลังเตรียมออเดอร์ %s นัดรับ %s', o.order_no, w)
    when 'ready' then format('✅ ออเดอร์ %s พร้อมให้รับแล้ว มารับที่ร้านได้เลย (นัด %s)', o.order_no, w)
    when 'completed' then format('ขอบคุณที่มารับออเดอร์ %s', o.order_no)
    when 'rejected' then format('ขออภัย ร้านไม่สามารถรับพรีออเดอร์ %s ได้%s', o.order_no, coalesce(' เหตุผล: ' || why, ''))
    when 'cancelled_by_shop' then format('ร้านยกเลิกออเดอร์ %s (นัดรับ %s)%s', o.order_no, w, coalesce(' เหตุผล: ' || why, ''))
    when 'rescheduled_by_shop' then format('ร้านเปลี่ยนเวลารับออเดอร์ %s เป็น %s%s%s', o.order_no, w, coalesce(' (เดิม ' || old_w || ')', ''), coalesce(' เหตุผล: ' || why, ''))
    when 'reminder' then format('⏰ เตือน: นัดรับออเดอร์ %s วันที่ %s', o.order_no, w)
    when 'new' then format('🆕 พรีออเดอร์ %s นัดรับ %s · %s ชิ้น', o.order_no, w, u)
    when 'changed' then format('🔁 ลูกค้าเปลี่ยนนัดรับ %s: %s → %s%s', o.order_no, coalesce(old_w, '-'), w, case when p_data ? 'note_changed' then ' (แก้คำสั่งพิเศษ)' else '' end)
    when 'cancelled_by_customer' then format('❌ ลูกค้ายกเลิกพรีออเดอร์ %s (นัดรับ %s)', o.order_no, w)
    when 'request' then format('💬 ลูกค้าขอแก้ไข/ยกเลิก %s (นัดรับ %s): %s', o.order_no, w, coalesce(p_data ->> 'message', '-'))
    when 'assigned' then format('👤 มอบหมายให้คุณ: %s นัดรับ %s · %s ชิ้น', o.order_no, w, u)
    when 'rescheduled_assignee' then format('🔁 เปลี่ยนเวลานัดรับ %s เป็น %s%s', o.order_no, w, coalesce(' (เดิม ' || old_w || ')', ''))
    when 'due_soon' then format('⏰ %s นัดรับ %s ยังไม่ได้เริ่มเตรียม', o.order_no, w)
    when 'late' then format('🚨 %s ถึงเวลานัดรับแล้ว (%s) แต่ยังไม่พร้อม', o.order_no, w)
    when 'overdue_pickup' then format('⌛ %s พร้อมแล้วแต่ลูกค้ายังไม่มารับ (นัด %s)', o.order_no, w)
    when 'slot_near' then format('📊 ช่วง %s ใกล้เต็มแล้ว', w)
    when 'slot_full' then format('📊 ช่วง %s เต็มแล้ว', w)
    when 'large' then format('📦 ออเดอร์ใหญ่ %s: %s ชิ้น นัดรับ %s', o.order_no, u, w)
    else format('%s %s', p_kind, o.order_no) end;
end $$;

-- ONE place that says something about a preorder: writes the in-app notice (once: dedupe_key) and, when LINE is on and the switch for that audience is on, queues the LINE message.
-- Both steps are best effort in their own sub-transaction: a notice or LINE problem is a warning in the log, never a failed order.
--   audience 'customer' -> the order's customer; 'staff' + p_profile null -> the admin group; 'staff' + p_profile -> that employee (their linked LINE)
create or replace function public.preorder_notify(p_kind text, p_order uuid, p_audience text, p_dedupe text, p_data jsonb default '{}'::jsonb, p_profile uuid default null, p_line boolean default true) returns void
language plpgsql security definer set search_path = public as $$
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
end $$;

-- the employee the order is assigned to, or null
create or replace function public.preorder_assignee(p_order uuid) returns uuid language sql stable security definer set search_path = public as $$
  select assigned_to from public.preorder_assignments where order_id = p_order
$$;

-- tell the group and (when there is one) the assigned employee
create or replace function public.preorder_notify_staff(p_kind text, p_order uuid, p_dedupe text, p_data jsonb default '{}'::jsonb, p_line boolean default true, p_assignee_kind text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a uuid := public.preorder_assignee(p_order);
begin
  perform public.preorder_notify(p_kind, p_order, 'staff', p_dedupe || ':g', p_data, null, p_line);
  if a is not null then perform public.preorder_notify(coalesce(p_assignee_kind, p_kind), p_order, 'staff', p_dedupe || ':a', p_data, a, p_line); end if;
end $$;

-- ================================================================================================ D. flags and compact rows (staff screens)
create or replace function public.preorder_flags(o public.shop_orders, s public.preorder_settings, p_pay integer, p_units integer) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare f jsonb := '[]'::jsonb;
begin
  if o.order_type <> 'preorder' or o.status in ('cancelled', 'returned', 'completed') then return f; end if;
  if o.status = 'new' and now() > o.created_at + interval '30 minutes' then f := f || jsonb_build_array('unconfirmed'); end if;
  if coalesce(p_pay, 0) not in (5, 6) and o.pickup_at < now() + interval '24 hours' then f := f || jsonb_build_array('unpaid_soon'); end if;
  if o.status in ('new', 'confirmed') and now() >= o.pickup_at - make_interval(mins => s.prep_lead_minutes) and now() < o.pickup_at then f := f || jsonb_build_array('not_started'); end if;
  if o.status in ('new', 'confirmed', 'preparing', 'packed') and now() >= o.pickup_at then f := f || jsonb_build_array('late'); end if;
  if o.status = 'ready' and now() > o.pickup_at + make_interval(mins => s.grace_minutes) then f := f || jsonb_build_array('overdue_pickup'); end if;
  if p_units >= s.large_order_units then f := f || jsonb_build_array('large'); end if;
  if exists (select 1 from public.preorder_days d where d.day = public.preorder_local_day(o.pickup_at) and d.kind = 'closed') then f := f || jsonb_build_array('closed_day'); end if;
  return f;
end $$;

create or replace function public.preorder_row(p_order uuid, p_items boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; s public.preorder_settings; units integer; n_lines integer; n_checked integer; pay integer; a public.preorder_assignments; v_name text;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  select * into s from public.preorder_settings where id;
  select coalesce(sum(qty), 0), count(*) into units, n_lines from public.shop_order_items where order_id = o.id;
  select count(*) into n_checked from public.preorder_prep_checks where order_id = o.id;
  pay := (public.finance_invoice_state_raw(o.invoice_id) ->> 'status_code')::int;
  select * into a from public.preorder_assignments where order_id = o.id;
  if found then select coalesce(nullif(btrim(display_name), ''), email) into v_name from public.profiles where id = a.assigned_to; end if;
  return jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'status', o.status, 'contact_name', o.contact_name, 'contact_phone', o.contact_phone, 'note', o.note, 'status_note', o.status_note,
    'created_at', o.created_at, 'pickup_at', o.pickup_at, 'total', o.total, 'lines', n_lines, 'units', units, 'pay_code', pay,
    'assigned_to', a.assigned_to, 'assigned_name', v_name, 'prep', jsonb_build_object('checked', n_checked, 'total', n_lines),
    'cancel_kind', o.cancel_kind, 'reschedule_count', o.reschedule_count, 'flags', public.preorder_flags(o, s, pay, units),
    'items', case when p_items then (select coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'sku_code', i.sku_code, 'name', i.name, 'unit', i.unit, 'qty', i.qty,
        'image_url', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = i.sku_code),
        'checked', exists (select 1 from public.preorder_prep_checks k where k.order_id = i.order_id and k.line_no = i.line_no)) order by i.line_no), '[]'::jsonb)
      from public.shop_order_items i where i.order_id = o.id) end);
end $$;

-- what the customer may still do with a preorder (the server decides; the app only shows it)
create or replace function public.preorder_change_rules(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; s public.preorder_settings; dl timestamptz; ok_time boolean;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found or o.order_type <> 'preorder' then return null; end if;
  select * into s from public.preorder_settings where id;
  dl := o.pickup_at - make_interval(mins => s.change_cutoff_minutes);
  ok_time := now() <= dl;
  return jsonb_build_object('deadline', dl, 'can_reschedule', ok_time and o.status in ('new', 'confirmed') and o.reschedule_count < 3,
    'can_cancel_time', ok_time and o.status = 'new', 'reschedules_left', greatest(3 - o.reschedule_count, 0));
end $$;

-- ================================================================================================ E. the order JSON (adds fields; every existing key is unchanged)
create or replace function public.shop_order_json(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; st jsonb;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  st := public.finance_invoice_state_raw(o.invoice_id);
  return jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'status', o.status, 'fulfilment', o.fulfilment, 'channel', o.channel,
    'contact_name', o.contact_name, 'contact_phone', o.contact_phone, 'delivery_address', o.delivery_address, 'note', o.note,
    'subtotal', o.subtotal, 'discount', o.discount, 'shipping_fee', o.shipping_fee, 'total', o.total, 'payment_pref', o.payment_pref,
    'created_at', o.created_at, 'updated_at', o.updated_at, 'status_note', o.status_note, 'cancel_reason', o.cancel_reason, 'cancelled_at', o.cancelled_at,
    'order_type', o.order_type, 'pickup_at', o.pickup_at, 'confirmed_at', o.confirmed_at, 'preparing_at', o.preparing_at, 'ready_at', o.ready_at, 'completed_at', o.completed_at,
    'cancel_kind', o.cancel_kind, 'reschedule_count', o.reschedule_count,
    'prep', case when o.order_type = 'preorder' then jsonb_build_object('checked', (select count(*) from public.preorder_prep_checks c where c.order_id = o.id),
        'total', (select count(*) from public.shop_order_items i where i.order_id = o.id)) end,
    'change', public.preorder_change_rules(o.id),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'sku_code', i.sku_code, 'name', i.name, 'unit', i.unit, 'unit_price', i.unit_price,
        'qty', i.qty, 'line_total', i.line_total,
        'image_url', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = i.sku_code)) order by i.line_no), '[]'::jsonb)
      from public.shop_order_items i where i.order_id = o.id),
    'invoice', (select jsonb_build_object('id', v.id, 'invoice_no', v.invoice_no, 'issue_date', v.issue_date, 'due_date', v.due_date,
        'description', v.description, 'customer_name', c.name) || coalesce(st, '{}'::jsonb)
      from public.finance_invoices v join public.finance_customers c on c.id = v.customer_id where v.id = o.invoice_id));
end $$;

-- ================================================================================================ F. placing a preorder
-- shop_place_order gains ONE optional last parameter, p_pickup_at: given -> a preorder (pick-up only, capacity-checked under the day lock). Without it the function behaves exactly as before.
drop function if exists public.shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text);
create or replace function public.shop_place_order(p_key text, p_items jsonb, p_fulfilment text, p_name text, p_phone text, p_address text, p_note text, p_expected_total numeric default null,
  p_payment_method text default null, p_slip_path text default null, p_slip_sha256 text default null, p_slip_type text default null, p_slip_transfer_at timestamptz default null, p_slip_ref text default null,
  p_pickup_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid; prof public.profiles; s public.shop_settings; q jsonb; norm jsonb; hash text; existing public.shop_orders; pm text;
        fin uuid; ono text; oid uuid := gen_random_uuid(); inv public.finance_invoices; phone text; nm text; addr text; nt text; n integer; ln integer := 0; l jsonb;
        v_bank_id uuid; v_bank_code text; v_units integer;
begin
  uid := public.shop_require_user();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_key, 0));    -- serialises retries of the same checkout

  select * into s from public.shop_settings where id;
  nm := btrim(coalesce(p_name, '')); phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  addr := nullif(btrim(coalesce(p_address, '')), ''); nt := nullif(btrim(coalesce(p_note, '')), ''); pm := nullif(btrim(coalesce(p_payment_method, '')), '');
  if p_pickup_at is not null and p_fulfilment is distinct from 'pickup' then raise exception 'PREORDER_PICKUP_ONLY' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sku', k, 'qty', t) order by k), '[]'::jsonb) into norm from (
    select e ->> 'sku_code' k, sum(case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::int else 0 end) t
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) e group by 1) z;
  -- (the payment choice, the slip and the pickup time join the hash only when given, so a checkout without them hashes exactly as before)
  hash := md5((jsonb_build_object('items', norm, 'f', p_fulfilment, 'n', nm, 'p', phone, 'a', addr, 'note', nt)
               || case when pm is null then '{}'::jsonb else jsonb_build_object('pm', pm) end
               || case when p_slip_sha256 is null then '{}'::jsonb else jsonb_build_object('slip', lower(p_slip_sha256)) end
               || case when p_pickup_at is null then '{}'::jsonb else jsonb_build_object('pu', extract(epoch from p_pickup_at)::bigint) end)::text);

  -- a retry of the same checkout returns the order it already created (never a second one)
  select * into existing from public.shop_orders where profile_id = uid and idempotency_key = p_key;
  if found then
    if existing.request_hash <> hash then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return jsonb_build_object('replay', true, 'order', public.shop_order_json(existing.id));
  end if;

  if not s.shop_open then raise exception 'SHOP_CLOSED'; end if;
  if not (exists (select 1 from public.finance_payment_accounts where is_default and active) or exists (select 1 from public.finance_bank_accounts where active)) then raise exception 'NO_PAYMENT_ACCOUNT'; end if;
  if pm is not null and not (pm = 'wallet'
       or (pm = 'qr' and exists (select 1 from public.finance_payment_accounts where is_default and active))
       or (pm like 'bank:%' and exists (select 1 from public.finance_bank_accounts where active and code = substr(pm, 6)))) then
    raise exception 'INVALID_PAYMENT_METHOD' using errcode = '22023'; end if;
  -- the transfer slip comes with the order (only an order paid from the wallet needs none)
  if s.require_payment_slip and pm is distinct from 'wallet' and (p_slip_path is null or p_slip_sha256 is null) then
    raise exception 'SLIP_REQUIRED' using errcode = '22023'; end if;
  if (select count(*) from public.shop_orders where profile_id = uid and created_at > now() - interval '1 hour') >= 10 then raise exception 'TOO_MANY_ORDERS'; end if;

  if length(nm) not between 1 and 100 then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if phone !~ '^0[0-9]{8,9}$' then raise exception 'INVALID_PHONE' using errcode = '22023'; end if;
  if p_fulfilment = 'pickup' then addr := null; end if;
  if addr is not null and length(addr) > 400 then raise exception 'INVALID_ADDRESS' using errcode = '22023'; end if;     -- optional, but not unbounded
  if nt is not null and length(nt) > 300 then raise exception 'INVALID_NOTE' using errcode = '22023'; end if;

  q := public.shop_quote_internal(p_items, p_fulfilment);
  if not (q ->> 'ok')::boolean then raise exception 'CART_INVALID' using detail = (q -> 'problems')::text; end if;
  if p_expected_total is not null and p_expected_total <> (q ->> 'total')::numeric then
    raise exception 'PRICE_CHANGED' using detail = (q ->> 'total'); end if;
  -- the pickup time: the day lock is taken here and held to the end of this transaction, so the place counted below is really this order's
  if p_pickup_at is not null then
    select coalesce(sum((x ->> 'qty')::int), 0) into v_units from jsonb_array_elements(q -> 'lines') x;
    perform public.preorder_check_slot(p_pickup_at, v_units, null, false, false);
  end if;

  select * into prof from public.profiles where id = uid;
  select id into fin from public.finance_customers where profile_id = uid;
  if fin is null then
    insert into public.finance_customers (code, name, profile_id, created_by)
      values ('LINE-' || upper(substr(replace(uid::text, '-', ''), 1, 10)), coalesce(nullif(btrim(prof.display_name), ''), nm), uid, uid)
      returning id into fin;
    perform public.shop_log('customer', fin::text, 'customer.create', jsonb_build_object('profile', uid));
  end if;

  ono := public.next_doc_no('ORDER');
  perform set_config('finance.defer_gl', 'on', true);          -- the receivable is queued when staff confirm the order (or when a payment is verified)
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref, created_by)
    values (public.next_doc_no('INVOICE'),
            fin, (now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date, (q ->> 'total')::numeric,
            case when p_pickup_at is null then 'Online order ' else 'Online preorder ' end || ono, ono, uid)
    returning * into inv;
  perform set_config('finance.defer_gl', 'off', true);
  perform public.finance_log('invoice', inv.id, 'invoice.issue', jsonb_build_object('no', inv.invoice_no, 'amount', inv.amount, 'customer', fin, 'order', ono, 'source', 'shop'));

  insert into public.shop_orders (id, order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone,
      delivery_address, note, subtotal, discount, shipping_fee, total, invoice_id, payment_pref, order_type, pickup_at)
    values (oid, ono, uid, fin, p_key, hash, p_fulfilment, nm, phone, addr, nt, (q ->> 'subtotal')::numeric, (q ->> 'discount')::numeric,
            (q ->> 'shipping_fee')::numeric, (q ->> 'total')::numeric, inv.id, pm, case when p_pickup_at is null then 'regular' else 'preorder' end, p_pickup_at);
  for l in select * from jsonb_array_elements(q -> 'lines') loop
    ln := ln + 1;
    insert into public.shop_order_items (order_id, line_no, sku_code, name, unit, unit_price, qty, line_total)
      values (oid, ln, l ->> 'sku_code', l ->> 'name', l ->> 'unit', (l ->> 'unit_price')::numeric, (l ->> 'qty')::int, (l ->> 'line_total')::numeric);
  end loop;
  -- the slip: checked by the same function a customer uses on the payment screen (own folder, no path tricks, one use per file), with the
  -- amount the SERVER priced. Any refusal rolls back the whole order. The invoice becomes "awaiting verification", never "paid".
  if p_slip_path is not null then
    if pm like 'bank:%' then select id, code into v_bank_id, v_bank_code from public.finance_bank_accounts where active and code = substr(pm, 6); end if;
    perform public.finance_submit_evidence(inv.id, p_slip_path, p_slip_sha256, coalesce(p_slip_type, 'image/jpeg'), (q ->> 'total')::numeric, p_slip_transfer_at,
      coalesce(v_bank_code, case when pm = 'qr' then 'PromptPay' end), p_slip_ref, v_bank_id);
  end if;
  perform public.shop_log('order', oid::text, 'order.place', jsonb_build_object('no', ono, 'total', q -> 'total', 'lines', ln, 'invoice', inv.invoice_no, 'fulfilment', p_fulfilment,
    'payment_pref', pm, 'slip', p_slip_path is not null) || case when p_pickup_at is null then '{}'::jsonb else jsonb_build_object('pickup_at', p_pickup_at, 'order_type', 'preorder') end);
  if p_pickup_at is not null then perform public.preorder_after_place(oid); end if;
  return jsonb_build_object('replay', false, 'order', public.shop_order_json(oid));
end $$;

-- what a new preorder sets in motion (best effort: never fails the order)
create or replace function public.preorder_after_place(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.shop_orders; s public.preorder_settings; ld jsonb; units integer; slot timestamptz; n integer;
begin
  begin
    select * into o from public.shop_orders where id = p_order;
    select * into s from public.preorder_settings where id;
    select coalesce(sum(qty), 0) into units from public.shop_order_items where order_id = o.id;
    perform public.preorder_notify('placed', o.id, 'customer', 'placed:' || o.id);
    perform public.preorder_notify_staff('new', o.id, 'new:' || o.id, '{}'::jsonb, false);          -- the LINE card of the new order is already sent by the order trigger
    if units >= s.large_order_units then perform public.preorder_notify_staff('large', o.id, 'large:' || o.id); end if;
    -- capacity: tell the group when the slot is full or nearly (once per slot and level)
    select g into slot from public.preorder_grid(public.preorder_local_day(o.pickup_at)) g where g <= o.pickup_at order by g desc limit 1;
    if slot is not null then
      ld := public.preorder_load(slot, null); n := (ld ->> 'orders')::int;
      if n >= s.max_orders_per_slot or (s.max_units_per_slot is not null and (ld ->> 'units')::int >= s.max_units_per_slot) then
        perform public.preorder_notify('slot_full', o.id, 'staff', 'slot:' || extract(epoch from slot)::bigint || ':full', '{}'::jsonb, null, true);
      elsif n >= ceil(s.max_orders_per_slot * 0.8) and s.max_orders_per_slot > 1 then
        perform public.preorder_notify('slot_near', o.id, 'staff', 'slot:' || extract(epoch from slot)::bigint || ':near', '{}'::jsonb, null, true);
      end if;
    end if;
  exception when others then raise warning 'preorder follow-up skipped (order %): %', p_order, sqlerrm; end;
end $$;

-- ================================================================================================ G. customer functions
create or replace function public.preorder_options() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.preorder_settings; sh public.shop_settings; d date; today date := public.preorder_local_day(now()); days jsonb := '[]'::jsonb; h jsonb; free integer; i integer;
begin
  perform public.shop_require_user();
  select * into s from public.preorder_settings where id;
  select * into sh from public.shop_settings where id;
  if not s.enabled or not sh.pickup_enabled or not sh.shop_open then return jsonb_build_object('enabled', false); end if;
  for i in 0..s.max_advance_days loop
    d := today + i; h := public.preorder_hours(d); free := 0;
    if not coalesce((h ->> 'closed')::boolean, true) then
      select count(*) into free from public.preorder_grid(d) g
       where g >= now() + make_interval(mins => s.lead_minutes)
         and (public.preorder_load(g, null) ->> 'orders')::int < s.max_orders_per_slot;
    end if;
    days := days || jsonb_build_array(jsonb_build_object('day', d, 'closed', coalesce((h ->> 'closed')::boolean, true), 'open', h ->> 'open', 'close', h ->> 'close',
      'reason', h ->> 'reason', 'free_slots', free));
  end loop;
  return jsonb_build_object('enabled', true, 'slot_minutes', s.slot_minutes, 'lead_minutes', s.lead_minutes, 'max_advance_days', s.max_advance_days,
    'change_cutoff_minutes', s.change_cutoff_minutes, 'note', s.customer_note, 'now', now(), 'days', days);
end $$;

-- the slots of one day for a cart of p_units units: each is ok, or why not (soon / full / units)
create or replace function public.preorder_slots(p_day date, p_units integer default 1) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.preorder_settings; sh public.shop_settings; today date := public.preorder_local_day(now()); h jsonb; out jsonb := '[]'::jsonb; g timestamptz; ld jsonb; st text;
        v_units integer := greatest(coalesce(p_units, 1), 1); day_units integer; oleft integer; uleft integer;
begin
  perform public.shop_require_user();
  select * into s from public.preorder_settings where id;
  select * into sh from public.shop_settings where id;
  if not s.enabled or not sh.pickup_enabled or not sh.shop_open then raise exception 'PREORDER_OFF' using errcode = '22023'; end if;
  if p_day is null or p_day < today then raise exception 'SLOT_PAST' using errcode = '22023'; end if;
  if p_day > today + s.max_advance_days then raise exception 'SLOT_TOO_FAR' using errcode = '22023'; end if;
  h := public.preorder_hours(p_day);
  day_units := public.preorder_day_units(p_day, null);
  for g in select * from public.preorder_grid(p_day) loop
    ld := public.preorder_load(g, null);
    oleft := s.max_orders_per_slot - (ld ->> 'orders')::int;
    uleft := case when s.max_units_per_slot is null then null else s.max_units_per_slot - (ld ->> 'units')::int end;
    st := case when g < now() + make_interval(mins => s.lead_minutes) then 'soon'
               when oleft <= 0 then 'full'
               when uleft is not null and uleft < v_units then 'units'
               when s.max_units_per_day is not null and day_units + v_units > s.max_units_per_day then 'units'
               else 'ok' end;
    out := out || jsonb_build_array(jsonb_build_object('at', g, 'time', to_char(g at time zone 'Asia/Bangkok', 'HH24:MI'), 'state', st, 'orders_left', greatest(oleft, 0), 'units_left', uleft));
  end loop;
  return jsonb_build_object('day', p_day, 'closed', coalesce((h ->> 'closed')::boolean, true), 'open', h ->> 'open', 'close', h ->> 'close', 'reason', h ->> 'reason', 'slots', out);
end $$;

-- the customer changes the pickup time and / or the instructions of their own preorder (items and amounts are frozen records: a different basket is cancel + order again)
create or replace function public.preorder_change_my_order(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; o public.shop_orders; s public.preorder_settings; new_at timestamptz; new_note text; moved boolean; note_changed boolean; units integer;
begin
  uid := public.shop_require_user();
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'NOTHING_TO_CHANGE' using errcode = '22023'; end if;
  select * into o from public.shop_orders where id = p_id and profile_id = uid for update;
  if not found then raise exception 'Order not found' using errcode = '42501'; end if;
  if o.order_type <> 'preorder' then raise exception 'NOT_PREORDER' using errcode = '22023'; end if;
  select * into s from public.preorder_settings where id;
  if o.status not in ('new', 'confirmed') then raise exception 'ORDER_IN_PROGRESS' using errcode = '22023'; end if;
  if now() > o.pickup_at - make_interval(mins => s.change_cutoff_minutes) then raise exception 'TOO_LATE_TO_CHANGE' using errcode = '22023'; end if;
  new_at := case when p_patch ? 'pickup_at' then (p_patch ->> 'pickup_at')::timestamptz else o.pickup_at end;
  new_note := case when p_patch ? 'note' then nullif(btrim(coalesce(p_patch ->> 'note', '')), '') else o.note end;
  if new_note is not null and length(new_note) > 300 then raise exception 'INVALID_NOTE' using errcode = '22023'; end if;
  moved := new_at is distinct from o.pickup_at; note_changed := new_note is distinct from o.note;
  if not moved and not note_changed then return public.shop_order_json(o.id); end if;
  if moved then
    if o.reschedule_count >= 3 then raise exception 'RESCHEDULE_LIMIT' using errcode = '22023'; end if;
    select coalesce(sum(qty), 0) into units from public.shop_order_items where order_id = o.id;
    perform public.preorder_check_slot(new_at, units, o.id, false, false);
  end if;
  update public.shop_orders set pickup_at = new_at, note = new_note, reschedule_count = reschedule_count + case when moved then 1 else 0 end, updated_at = now() where id = o.id;
  perform public.shop_log('order', o.id::text, 'preorder.change', jsonb_build_object('by', 'customer', 'pickup_from', o.pickup_at, 'pickup_to', new_at, 'note_from', o.note, 'note_to', new_note));
  perform public.preorder_notify_staff('changed', o.id, 'chg:' || o.id || ':' || gen_random_uuid(), jsonb_build_object('from', o.pickup_at, 'note_changed', note_changed), true, 'rescheduled_assignee');
  return public.shop_order_json(o.id);
end $$;

-- "I need something else" (other items, cancel after payment): a message to the shop, never an automatic change. Once per 10 minutes per order.
create or replace function public.preorder_request_change(p_id uuid, p_message text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; o public.shop_orders; m text := btrim(coalesce(p_message, ''));
begin
  uid := public.shop_require_user();
  select * into o from public.shop_orders where id = p_id and profile_id = uid for update;
  if not found then raise exception 'Order not found' using errcode = '42501'; end if;
  if o.order_type <> 'preorder' then raise exception 'NOT_PREORDER' using errcode = '22023'; end if;
  if o.status in ('cancelled', 'returned', 'completed') then raise exception 'ORDER_CLOSED' using errcode = '22023'; end if;
  if length(m) not between 3 and 300 then raise exception 'INVALID_MESSAGE' using errcode = '22023'; end if;
  if exists (select 1 from public.preorder_notices where order_id = o.id and kind = 'request' and created_at > now() - interval '10 minutes') then raise exception 'TOO_MANY_REQUESTS' using errcode = '22023'; end if;
  perform public.shop_log('order', o.id::text, 'preorder.request', jsonb_build_object('by', 'customer', 'message', m));
  perform public.preorder_notify_staff('request', o.id, 'req:' || o.id || ':' || gen_random_uuid(), jsonb_build_object('message', m), true);
  return jsonb_build_object('ok', true);
end $$;

-- my orders: the filter 'preorder' = scheduled pickups that are still to come. Same function as before otherwise.
create or replace function public.shop_my_orders(p_filter text default 'all', p_limit integer default 20, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid; lim integer := least(greatest(coalesce(p_limit, 20), 1), 50); off integer := greatest(coalesce(p_offset, 0), 0); res jsonb;
begin
  uid := public.shop_require_user();
  with mine as (
    select o.id, o.created_at, o.status, o.order_type, o.pickup_at, (public.finance_invoice_state_raw(o.invoice_id) ->> 'status_code')::int as pay
    from public.shop_orders o where o.profile_id = uid),
  f as (
    select m.*, count(*) over () as total from mine m
    where case coalesce(p_filter, 'all')
      when 'unpaid' then m.status <> 'cancelled' and m.pay in (0, 1, 3, 4, 7, 9, 10)
      when 'to_ship' then m.status in ('new', 'confirmed', 'preparing', 'packed') and m.pay in (5, 6)
      when 'to_receive' then m.status in ('shipped', 'ready')
      when 'done' then m.status = 'completed'
      when 'cancelled' then m.status in ('cancelled', 'returned')
      when 'preorder' then m.order_type = 'preorder' and m.status not in ('completed', 'cancelled', 'returned')
      else true end
    order by case when p_filter = 'preorder' then m.pickup_at end asc nulls last, m.created_at desc limit lim offset off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0),
    'orders', coalesce(jsonb_agg(public.shop_order_json(f.id) order by case when p_filter = 'preorder' then f.pickup_at end asc nulls last, f.created_at desc), '[]'::jsonb)) into res from f;
  return res;
end $$;

-- one order: also the updates the customer was told about (no staff notes or internal reasons)
create or replace function public.shop_my_order(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid; o public.shop_orders;
begin
  uid := public.shop_require_user();
  select * into o from public.shop_orders where id = p_id and profile_id = uid;
  if not found then raise exception 'Order not found' using errcode = '42501'; end if;
  -- only the milestones: staff notes and override reasons in the audit detail are internal
  return public.shop_order_json(o.id) || jsonb_build_object('events', (
    select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'action', e.action, 'to', e.detail ->> 'to') order by e.at), '[]'::jsonb)
    from public.shop_events e where e.entity = 'order' and e.entity_id = o.id::text and e.action in ('order.place', 'order.status', 'order.cancel')),
    'notices', (select coalesce(jsonb_agg(jsonb_build_object('at', n.created_at, 'kind', n.kind, 'data', n.data - 'message', 'text_th', n.text_th) order by n.created_at), '[]'::jsonb)
      from public.preorder_notices n where n.order_id = o.id and n.audience = 'customer'));
end $$;

create or replace function public.shop_settings_public()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.shop_settings; p public.preorder_settings;
begin
  perform public.shop_require_user();
  select * into s from public.shop_settings where id;
  select * into p from public.preorder_settings where id;
  return jsonb_build_object('shop_open', s.shop_open and (exists (select 1 from public.finance_payment_accounts where is_default and active) or exists (select 1 from public.finance_bank_accounts where active)),
    'require_payment_slip', s.require_payment_slip, 'closed_message', s.closed_message, 'delivery_enabled', s.delivery_enabled, 'pickup_enabled', s.pickup_enabled, 'pickup_note', s.pickup_note,
    'shipping_fee', s.shipping_fee, 'free_shipping_min', s.free_shipping_min,
    'preorder_enabled', coalesce(p.enabled, false) and s.pickup_enabled and s.shop_open);
end $$;

-- ================================================================================================ H. status moves and cancellation (the same functions as before, preorder rules added)
create or replace function public.shop_cancel_order_internal(p_order uuid, p_reason text, p_by_customer boolean)
returns void language plpgsql security definer set search_path = public as $$
declare o public.shop_orders; s public.preorder_settings; v_kind text;
begin
  select * into o from public.shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('cancelled', 'completed', 'returned') then raise exception 'This order is already %', o.status; end if;
  if p_by_customer and o.status <> 'new' then raise exception 'ORDER_IN_PROGRESS'; end if;
  if p_by_customer and o.order_type = 'preorder' then
    select * into s from public.preorder_settings where id;
    if now() > o.pickup_at - make_interval(mins => s.change_cutoff_minutes) then raise exception 'TOO_LATE_TO_CHANGE'; end if;
  end if;
  perform 1 from public.finance_invoices where id = o.invoice_id for update;          -- serialises with payment verification
  if exists (select 1 from public.finance_receipts where invoice_id = o.invoice_id and status = 'posted') then
    raise exception 'PAYMENT_RECORDED'; end if;
  if exists (select 1 from public.finance_payment_evidence where invoice_id = o.invoice_id and status in ('submitted', 'confirmed', 'more_evidence')) then
    raise exception 'SLIP_PENDING'; end if;
  v_kind := case when p_by_customer then 'customer' when o.status = 'new' then 'rejected' else 'staff' end;
  update public.finance_invoices set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = 'Order cancelled: ' || left(p_reason, 200)
    where id = o.invoice_id and status = 'open';
  update public.finance_payment_requests set status = 'cancelled' where invoice_id = o.invoice_id and status = 'awaiting';
  update public.shop_orders set status = 'cancelled', cancel_kind = v_kind, cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(p_reason, 200), updated_at = now() where id = o.id;
  perform public.finance_log('invoice', o.invoice_id, 'invoice.cancel', jsonb_build_object('reason', left(p_reason, 200), 'order', o.order_no, 'source', 'shop'));
  perform public.shop_log('order', o.id::text, 'order.cancel', jsonb_build_object('by', case when p_by_customer then 'customer' else 'staff' end, 'reason', left(p_reason, 200), 'kind', v_kind));
  if o.order_type = 'preorder' then
    begin
      if p_by_customer then
        perform public.preorder_notify_staff('cancelled_by_customer', o.id, 'cx:' || o.id, '{}'::jsonb);
      else
        perform public.preorder_notify(case when v_kind = 'rejected' then 'rejected' else 'cancelled_by_shop' end, o.id, 'customer', 'cx:' || o.id, jsonb_build_object('reason', left(p_reason, 200)));
        if public.preorder_assignee(o.id) is not null and public.preorder_assignee(o.id) is distinct from auth.uid() then
          perform public.preorder_notify('cancelled_by_customer', o.id, 'staff', 'cx:' || o.id || ':a', '{}'::jsonb, public.preorder_assignee(o.id), true);
        end if;
      end if;
    exception when others then raise warning 'preorder cancel follow-up skipped (order %): %', o.order_no, sqlerrm; end;
  end if;
end $$;

create or replace function public.shop_admin_set_status(p_order uuid, p_status text, p_note text default null, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.shop_orders; st jsonb; code integer; ok boolean; overridden boolean := false; n_lines integer; n_checked integer;
        v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_why text := nullif(btrim(coalesce(p_override_reason, '')), '');
begin
  perform public.shop_require_staff('change an order');
  if p_status = 'cancelled' then
    if v_note is null then raise exception 'A reason is required'; end if;
    perform public.shop_cancel_order_internal(p_order, v_note, false);
    return public.shop_order_json(p_order);
  end if;
  select * into o from public.shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  ok := case o.status
    when 'new' then p_status = 'confirmed'
    when 'confirmed' then p_status = 'preparing'
    when 'preparing' then p_status = 'packed' or (o.order_type = 'preorder' and p_status = 'ready')     -- a preorder may go straight to ready (the checklist replaces the packing step)
    when 'packed' then (p_status = 'shipped' and o.fulfilment = 'delivery') or (p_status = 'ready' and o.fulfilment = 'pickup')
    when 'ready' then p_status = 'completed'
    when 'shipped' then p_status in ('completed', 'returned')
    when 'completed' then p_status = 'returned'
    else false end;
  if not ok then raise exception 'An order that is % cannot become %', o.status, p_status; end if;
  if p_status = 'returned' and v_note is null then raise exception 'A reason is required'; end if;
  if o.order_type = 'preorder' then
    if p_status = 'confirmed' and o.pickup_at < now() then raise exception 'PICKUP_PASSED'; end if;
    if p_status = 'ready' then
      select count(*) into n_lines from public.shop_order_items where order_id = o.id;
      select count(*) into n_checked from public.preorder_prep_checks where order_id = o.id;
      if n_checked < n_lines then raise exception 'PREP_INCOMPLETE: % of % items ticked', n_checked, n_lines; end if;
    end if;
  end if;
  if p_status <> 'confirmed' and p_status <> 'returned' then
    st := public.finance_invoice_state_raw(o.invoice_id);
    code := (st ->> 'status_code')::int;
    if code not in (5, 6) then
      if v_why is null then raise exception 'PAYMENT_REQUIRED'; end if;
      overridden := true;
    end if;
  end if;
  update public.shop_orders set status = p_status, status_note = coalesce(v_note, status_note), updated_at = now(),
      confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end,
      preparing_at = case when p_status = 'preparing' then now() else preparing_at end,
      ready_at = case when p_status = 'ready' then now() else ready_at end,
      completed_at = case when p_status = 'completed' then now() else completed_at end
    where id = o.id;
  perform public.finance_gl_ensure_invoice_issue(o.invoice_id);        -- a confirmed sale: the receivable goes to the accountant's queue (once)
  perform public.shop_log('order', o.id::text, 'order.status', jsonb_build_object('from', o.status, 'to', p_status, 'note', v_note,
    'payment_override', overridden, 'override_reason', case when overridden then v_why end));
  if o.order_type = 'preorder' then
    -- whoever starts the preparation owns it unless somebody was named
    if p_status = 'preparing' and auth.uid() is not null and not exists (select 1 from public.preorder_assignments where order_id = o.id) then
      insert into public.preorder_assignments (order_id, assigned_to, assigned_by) values (o.id, auth.uid(), auth.uid()) on conflict do nothing;
    end if;
    if p_status in ('confirmed', 'preparing', 'ready', 'completed') then
      perform public.preorder_notify(p_status, o.id, 'customer', p_status || ':' || o.id);
    end if;
  end if;
  return public.shop_order_json(o.id);
end $$;

-- ================================================================================================ I. staff functions
create or replace function public.preorder_admin_staff() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_staff('see the team');
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(btrim(p.display_name), ''), p.email), 'role', p.role) order by coalesce(nullif(btrim(p.display_name), ''), p.email))
    from public.profiles p where p.status = 'active' and p.role in ('ADMIN', 'SUPER_ADMIN')), '[]'::jsonb);
end $$;

create or replace function public.preorder_admin_dashboard(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_day, public.preorder_local_day(now())); r record; att jsonb := '[]'::jsonb; row jsonb; res jsonb; s public.preorder_settings;
begin
  perform public.shop_require_staff('see preorders');
  select * into s from public.preorder_settings where id;
  select jsonb_build_object(
    'total', count(*) filter (where public.preorder_local_day(o.pickup_at) = d),
    'pending', count(*) filter (where public.preorder_local_day(o.pickup_at) = d and o.status = 'new'),
    'confirmed', count(*) filter (where public.preorder_local_day(o.pickup_at) = d and o.status = 'confirmed'),
    'preparing', count(*) filter (where public.preorder_local_day(o.pickup_at) = d and o.status in ('preparing', 'packed')),
    'ready', count(*) filter (where public.preorder_local_day(o.pickup_at) = d and o.status = 'ready'),
    'completed', count(*) filter (where public.preorder_local_day(o.pickup_at) = d and o.status = 'completed'),
    'cancelled', count(*) filter (where public.preorder_local_day(o.pickup_at) = d and o.status in ('cancelled', 'returned')),
    'upcoming', count(*) filter (where public.preorder_local_day(o.pickup_at) > d and o.status not in ('cancelled', 'returned', 'completed')),
    'pending_all', count(*) filter (where o.status = 'new'),
    'units_today', coalesce(sum((select sum(i.qty) from public.shop_order_items i where i.order_id = o.id)) filter (where public.preorder_local_day(o.pickup_at) = d and o.status not in ('cancelled', 'returned')), 0))
    into res from public.shop_orders o where o.order_type = 'preorder';
  for r in select o.id from public.shop_orders o where o.order_type = 'preorder' and o.status not in ('cancelled', 'returned', 'completed') order by o.pickup_at, o.created_at loop
    row := public.preorder_row(r.id);
    if jsonb_array_length(row -> 'flags') > 0 then att := att || jsonb_build_array(row); end if;
    exit when jsonb_array_length(att) >= 50;
  end loop;
  return res || jsonb_build_object('day', d, 'enabled', s.enabled, 'attention', att, 'attention_count', jsonb_array_length(att),
    'capacity', jsonb_build_object('max_orders_per_slot', s.max_orders_per_slot, 'max_units_per_slot', s.max_units_per_slot, 'max_units_per_day', s.max_units_per_day, 'day_units', public.preorder_day_units(d, null)));
end $$;

create or replace function public.preorder_admin_list(p_search text default null, p_status text default null, p_pay text default null, p_from date default null, p_to date default null,
  p_time_from text default null, p_time_to text default null, p_assigned text default null, p_sort text default 'pickup_asc', p_limit integer default 30, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lim integer := least(greatest(coalesce(p_limit, 30), 1), 100); off integer := greatest(coalesce(p_offset, 0), 0); q text := nullif(btrim(coalesce(p_search, '')), ''); pat text; res jsonb;
        tf time := nullif(p_time_from, '')::time; tt time := nullif(p_time_to, '')::time;
begin
  perform public.shop_require_staff('see preorders');
  if q is not null then pat := '%' || replace(replace(replace(left(q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with base as (
    select o.id, o.pickup_at, o.created_at, o.total, o.order_no, (public.finance_invoice_state_raw(o.invoice_id) ->> 'status_code')::int as pay
    from public.shop_orders o
    where o.order_type = 'preorder'
      and (nullif(p_status, '') is null or o.status = p_status)
      and (p_from is null or public.preorder_local_day(o.pickup_at) >= p_from) and (p_to is null or public.preorder_local_day(o.pickup_at) <= p_to)
      and (tf is null or (o.pickup_at at time zone 'Asia/Bangkok')::time >= tf) and (tt is null or (o.pickup_at at time zone 'Asia/Bangkok')::time <= tt)
      and (q is null or o.order_no ilike pat or o.contact_name ilike pat or o.contact_phone ilike pat)
      and (nullif(p_assigned, '') is null
           or (p_assigned = 'none' and not exists (select 1 from public.preorder_assignments a where a.order_id = o.id))
           or (case when p_assigned ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then exists (select 1 from public.preorder_assignments a where a.order_id = o.id and a.assigned_to = p_assigned::uuid) else false end))),
  f as (
    select b.*, count(*) over () as total_rows from base b
    where case coalesce(nullif(p_pay, ''), 'all') when 'paid' then b.pay in (5, 6) when 'unpaid' then coalesce(b.pay, 0) in (0, 1, 7, 9, 10) when 'review' then b.pay in (3, 4) else true end
    order by case when p_sort = 'pickup_desc' then b.pickup_at end desc, case when p_sort = 'created_desc' then b.created_at end desc, case when p_sort = 'total_desc' then b.total end desc,
             case when p_sort not in ('pickup_desc', 'created_desc', 'total_desc') then b.pickup_at end asc, b.created_at
    limit lim offset off)
  select jsonb_build_object('total', coalesce((select max(total_rows) from f), 0),
    'orders', coalesce(jsonb_agg(public.preorder_row(f.id) order by case when p_sort = 'pickup_desc' then f.pickup_at end desc, case when p_sort = 'created_desc' then f.created_at end desc,
      case when p_sort = 'total_desc' then f.total end desc, case when p_sort not in ('pickup_desc', 'created_desc', 'total_desc') then f.pickup_at end asc, f.created_at), '[]'::jsonb)) into res from f;
  return res;
end $$;

-- the timeline of one day: every grid slot (so a free slot is visible) plus any pickup time that is not on the grid (the grid was changed after the order)
create or replace function public.preorder_admin_schedule(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_day, public.preorder_local_day(now())); s public.preorder_settings; h jsonb; slots jsonb;
begin
  perform public.shop_require_staff('see preorders');
  select * into s from public.preorder_settings where id;
  h := public.preorder_hours(d);
  with g as (select g from public.preorder_grid(d) g),
  os as (select o.id, o.pickup_at, o.created_at from public.shop_orders o where o.order_type = 'preorder' and public.preorder_local_day(o.pickup_at) = d and o.status not in ('cancelled', 'returned')),
  times as (select g as t from g union select pickup_at from os)
  select coalesce(jsonb_agg(jsonb_build_object('at', t.t, 'time', to_char(t.t at time zone 'Asia/Bangkok', 'HH24:MI'), 'in_grid', exists (select 1 from g where g.g = t.t),
      'load', public.preorder_load(t.t, null),
      'orders', (select coalesce(jsonb_agg(public.preorder_row(os.id) order by os.created_at), '[]'::jsonb) from os where os.pickup_at = t.t)) order by t.t), '[]'::jsonb) into slots from times t;
  return jsonb_build_object('day', d, 'hours', h, 'slot_minutes', s.slot_minutes, 'max_orders_per_slot', s.max_orders_per_slot, 'max_units_per_slot', s.max_units_per_slot,
    'max_units_per_day', s.max_units_per_day, 'day_units', public.preorder_day_units(d, null), 'slots', slots,
    'cancelled', (select count(*) from public.shop_orders o where o.order_type = 'preorder' and public.preorder_local_day(o.pickup_at) = d and o.status in ('cancelled', 'returned')));
end $$;

-- the employee board: what has to be prepared (and handed over) from now on, plus anything overdue. p_mine = only the orders assigned to me.
create or replace function public.preorder_prep_board(p_mine boolean default false, p_days integer default 2) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := public.preorder_local_day(now()); r record; rows jsonb := '[]'::jsonb;
begin
  perform public.shop_require_staff('see the pickup board');
  for r in
    select o.id from public.shop_orders o
    where o.order_type = 'preorder' and o.status in ('new', 'confirmed', 'preparing', 'packed', 'ready')
      and public.preorder_local_day(o.pickup_at) <= today + (least(greatest(coalesce(p_days, 2), 1), 14) - 1)
      and (not coalesce(p_mine, false) or exists (select 1 from public.preorder_assignments a where a.order_id = o.id and a.assigned_to = auth.uid()))
    order by o.pickup_at, o.created_at limit 100
  loop rows := rows || jsonb_build_array(public.preorder_row(r.id, true)); end loop;
  return jsonb_build_object('now', now(), 'me', auth.uid(), 'orders', rows);
end $$;

create or replace function public.preorder_admin_assign(p_order uuid, p_profile uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.shop_orders; prev uuid;
begin
  perform public.shop_require_staff('assign a preorder');
  select * into o from public.shop_orders where id = p_order for update;
  if not found or o.order_type <> 'preorder' then raise exception 'Order not found'; end if;
  if o.status in ('cancelled', 'returned', 'completed') then raise exception 'ORDER_CLOSED' using errcode = '22023'; end if;
  prev := public.preorder_assignee(o.id);
  if p_profile is not null and not exists (select 1 from public.profiles where id = p_profile and status = 'active' and role in ('ADMIN', 'SUPER_ADMIN')) then
    raise exception 'INVALID_ASSIGNEE' using errcode = '22023'; end if;
  if p_profile is null then delete from public.preorder_assignments where order_id = o.id;
  else insert into public.preorder_assignments (order_id, assigned_to, assigned_by) values (o.id, p_profile, auth.uid())
    on conflict (order_id) do update set assigned_to = excluded.assigned_to, assigned_by = excluded.assigned_by, assigned_at = now(); end if;
  if prev is distinct from p_profile then
    perform public.shop_log('order', o.id::text, 'preorder.assign', jsonb_build_object('from', prev, 'to', p_profile));
    if p_profile is not null and p_profile is distinct from auth.uid() then
      perform public.preorder_notify('assigned', o.id, 'staff', 'asg:' || o.id || ':' || p_profile || ':' || gen_random_uuid(), '{}'::jsonb, p_profile, true);
    end if;
  end if;
  return public.preorder_row(o.id, true);
end $$;

-- staff move a preorder to another slot (with a reason); p_force also lets them exceed the capacity, which is recorded
create or replace function public.preorder_admin_reschedule(p_order uuid, p_pickup_at timestamptz, p_reason text, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.shop_orders; why text := nullif(btrim(coalesce(p_reason, '')), ''); units integer;
begin
  perform public.shop_require_staff('change a pickup time');
  if why is null then raise exception 'A reason is required'; end if;
  select * into o from public.shop_orders where id = p_order for update;
  if not found or o.order_type <> 'preorder' then raise exception 'Order not found'; end if;
  if o.status not in ('new', 'confirmed', 'preparing') then raise exception 'ORDER_IN_PROGRESS' using errcode = '22023'; end if;
  if p_pickup_at is not distinct from o.pickup_at then raise exception 'NOTHING_TO_CHANGE' using errcode = '22023'; end if;
  select coalesce(sum(qty), 0) into units from public.shop_order_items where order_id = o.id;
  perform public.preorder_check_slot(p_pickup_at, units, o.id, true, coalesce(p_force, false));
  update public.shop_orders set pickup_at = p_pickup_at, updated_at = now() where id = o.id;
  perform public.shop_log('order', o.id::text, 'preorder.reschedule', jsonb_build_object('by', 'staff', 'pickup_from', o.pickup_at, 'pickup_to', p_pickup_at, 'reason', left(why, 200), 'capacity_override', coalesce(p_force, false)));
  perform public.preorder_notify('rescheduled_by_shop', o.id, 'customer', 'rsc:' || o.id || ':' || gen_random_uuid(), jsonb_build_object('from', o.pickup_at, 'reason', left(why, 200)));
  if public.preorder_assignee(o.id) is not null and public.preorder_assignee(o.id) is distinct from auth.uid() then
    perform public.preorder_notify('rescheduled_assignee', o.id, 'staff', 'rsc:' || o.id || ':' || gen_random_uuid() || ':a', jsonb_build_object('from', o.pickup_at), public.preorder_assignee(o.id), true);
  end if;
  return public.preorder_row(o.id, true);
end $$;

-- the checklist: tick (or un-tick) one line, or every line when p_line is null
create or replace function public.preorder_prep_set(p_order uuid, p_line integer, p_checked boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.shop_orders; n integer;
begin
  perform public.shop_require_staff('prepare a preorder');
  select * into o from public.shop_orders where id = p_order for update;
  if not found or o.order_type <> 'preorder' then raise exception 'Order not found'; end if;
  if o.status not in ('confirmed', 'preparing', 'packed') then raise exception 'NOT_PREPARING' using errcode = '22023'; end if;
  if p_line is not null and not exists (select 1 from public.shop_order_items where order_id = o.id and line_no = p_line) then raise exception 'Line not found'; end if;
  if coalesce(p_checked, true) then
    insert into public.preorder_prep_checks (order_id, line_no, checked_by) select o.id, i.line_no, auth.uid() from public.shop_order_items i
      where i.order_id = o.id and (p_line is null or i.line_no = p_line) on conflict do nothing;
  else
    delete from public.preorder_prep_checks where order_id = o.id and (p_line is null or line_no = p_line);
  end if;
  select count(*) into n from public.preorder_prep_checks where order_id = o.id;
  perform public.shop_log('order', o.id::text, 'preorder.prep', jsonb_build_object('line', p_line, 'checked', coalesce(p_checked, true), 'ticked', n));
  return public.preorder_row(o.id, true);
end $$;

create or replace function public.shop_admin_order(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders;
begin
  perform public.shop_require_staff('see online orders');
  select * into o from public.shop_orders where id = p_id;
  if not found then raise exception 'Order not found'; end if;
  return public.shop_order_json(o.id) || jsonb_build_object(
    'customer', (select jsonb_build_object('code', c.code, 'name', c.name, 'phone', p.phone, 'line_user_id', p.line_user_id)
      from public.finance_customers c left join public.profiles p on p.id = o.profile_id where c.id = o.customer_id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor_email', e.actor_email, 'action', e.action, 'detail', e.detail) order by e.at), '[]'::jsonb)
      from public.shop_events e where e.entity = 'order' and e.entity_id = o.id::text),
    'preorder', case when o.order_type = 'preorder' then public.preorder_row(o.id, true) end,
    'notices', (select coalesce(jsonb_agg(jsonb_build_object('at', n.created_at, 'audience', n.audience, 'kind', n.kind, 'data', n.data, 'text_th', n.text_th,
        'line', (select b.status from public.line_outbox b where b.id = n.outbox_id)) order by n.created_at), '[]'::jsonb)
      from public.preorder_notices n where n.order_id = o.id));
end $$;

-- the staff inbox: the latest messages about preorders (and whether LINE delivered them)
create or replace function public.preorder_admin_notices(p_limit integer default 40) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_staff('see preorder notices');
  return coalesce((select jsonb_agg(z.x order by z.at desc) from (
    select n.created_at as at, jsonb_build_object('at', n.created_at, 'order_id', n.order_id, 'order_no', o.order_no, 'audience', n.audience, 'kind', n.kind, 'data', n.data, 'text_th', n.text_th,
        'for_profile', n.profile_id, 'line', (select b.status from public.line_outbox b where b.id = n.outbox_id), 'line_error', (select b.last_error from public.line_outbox b where b.id = n.outbox_id)) as x
    from public.preorder_notices n join public.shop_orders o on o.id = n.order_id
    order by n.created_at desc limit least(greatest(coalesce(p_limit, 40), 1), 200)) z), '[]'::jsonb);
end $$;

-- settings (SUPER_ADMIN) and closures (any staff)
create or replace function public.preorder_admin_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.preorder_settings; sh public.shop_settings;
begin
  perform public.shop_require_staff('see the preorder settings');
  select * into s from public.preorder_settings where id; select * into sh from public.shop_settings where id;
  return jsonb_build_object('enabled', s.enabled, 'configured', s.configured_at is not null, 'slot_minutes', s.slot_minutes, 'lead_minutes', s.lead_minutes, 'max_advance_days', s.max_advance_days,
    'weekly_hours', s.weekly_hours, 'max_orders_per_slot', s.max_orders_per_slot, 'max_units_per_slot', s.max_units_per_slot, 'max_units_per_day', s.max_units_per_day,
    'change_cutoff_minutes', s.change_cutoff_minutes, 'prep_lead_minutes', s.prep_lead_minutes, 'reminder_minutes', s.reminder_minutes, 'grace_minutes', s.grace_minutes,
    'large_order_units', s.large_order_units, 'customer_note', s.customer_note, 'updated_at', s.updated_at,
    'can_edit', public.line_is_super(), 'shop_open', sh.shop_open, 'pickup_enabled', sh.pickup_enabled,
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'kind', d.kind, 'open', to_char(d.open_time, 'HH24:MI'), 'close', to_char(d.close_time, 'HH24:MI'), 'reason', d.reason,
        'orders', (select count(*) from public.shop_orders o where o.order_type = 'preorder' and o.status not in ('cancelled', 'returned', 'completed') and public.preorder_local_day(o.pickup_at) = d.day)) order by d.day)
      from public.preorder_days d where d.day >= public.preorder_local_day(now()) - 7), '[]'::jsonb));
end $$;

create or replace function public.preorder_admin_save_settings(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text; cur public.preorder_settings; sh public.shop_settings; wh jsonb; e jsonb; seen integer[] := '{}'; dow integer; ok boolean;
begin
  if not public.line_is_super() then raise exception 'Only a SUPER_ADMIN can change the preorder settings' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_SETTING: send an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('enabled', 'slot_minutes', 'lead_minutes', 'max_advance_days', 'weekly_hours', 'max_orders_per_slot', 'max_units_per_slot', 'max_units_per_day',
                 'change_cutoff_minutes', 'prep_lead_minutes', 'reminder_minutes', 'grace_minutes', 'large_order_units', 'customer_note') then
      raise exception 'INVALID_SETTING: unknown setting %', k using errcode = '22023'; end if;
  end loop;
  select * into cur from public.preorder_settings where id for update;
  if p_patch ? 'weekly_hours' then
    wh := p_patch -> 'weekly_hours';
    if jsonb_typeof(wh) <> 'array' or jsonb_array_length(wh) <> 7 then raise exception 'INVALID_SETTING: give the hours of all 7 days' using errcode = '22023'; end if;
    for e in select * from jsonb_array_elements(wh) loop
      begin
        dow := (e ->> 'dow')::int;
        ok := dow between 0 and 6 and not (dow = any (seen))
          and (coalesce((e ->> 'closed')::boolean, false) or ((e ->> 'open') ~ '^[0-2][0-9]:[0-5][0-9]$' and (e ->> 'close') ~ '^[0-2][0-9]:[0-5][0-9]$' and (e ->> 'open')::time < (e ->> 'close')::time));
      exception when others then ok := false; end;
      if not ok then raise exception 'INVALID_SETTING: each day needs closed, or an opening time before its closing time (HH:MM)' using errcode = '22023'; end if;
      seen := seen || dow;
    end loop;
  end if;
  begin
    update public.preorder_settings set
      slot_minutes = case when p_patch ? 'slot_minutes' then (p_patch ->> 'slot_minutes')::int else slot_minutes end,
      lead_minutes = case when p_patch ? 'lead_minutes' then (p_patch ->> 'lead_minutes')::int else lead_minutes end,
      max_advance_days = case when p_patch ? 'max_advance_days' then (p_patch ->> 'max_advance_days')::int else max_advance_days end,
      weekly_hours = case when p_patch ? 'weekly_hours' then p_patch -> 'weekly_hours' else weekly_hours end,
      configured_at = case when p_patch ? 'weekly_hours' then coalesce(configured_at, now()) else configured_at end,
      max_orders_per_slot = case when p_patch ? 'max_orders_per_slot' then (p_patch ->> 'max_orders_per_slot')::int else max_orders_per_slot end,
      max_units_per_slot = case when p_patch ? 'max_units_per_slot' then nullif(p_patch ->> 'max_units_per_slot', '')::int else max_units_per_slot end,
      max_units_per_day = case when p_patch ? 'max_units_per_day' then nullif(p_patch ->> 'max_units_per_day', '')::int else max_units_per_day end,
      change_cutoff_minutes = case when p_patch ? 'change_cutoff_minutes' then (p_patch ->> 'change_cutoff_minutes')::int else change_cutoff_minutes end,
      prep_lead_minutes = case when p_patch ? 'prep_lead_minutes' then (p_patch ->> 'prep_lead_minutes')::int else prep_lead_minutes end,
      reminder_minutes = case when p_patch ? 'reminder_minutes' then (p_patch ->> 'reminder_minutes')::int else reminder_minutes end,
      grace_minutes = case when p_patch ? 'grace_minutes' then (p_patch ->> 'grace_minutes')::int else grace_minutes end,
      large_order_units = case when p_patch ? 'large_order_units' then (p_patch ->> 'large_order_units')::int else large_order_units end,
      customer_note = case when p_patch ? 'customer_note' then nullif(btrim(p_patch ->> 'customer_note'), '') else customer_note end,
      updated_by = auth.uid(), updated_at = now()
    where id;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'INVALID_SETTING: a value is out of range' using errcode = '22023';
  end;
  if p_patch ? 'enabled' then
    if (p_patch ->> 'enabled')::boolean then
      select * into cur from public.preorder_settings where id; select * into sh from public.shop_settings where id;
      if cur.configured_at is null then raise exception 'PREORDER_NOT_CONFIGURED: save the opening hours first' using errcode = '22023'; end if;
      if not sh.pickup_enabled then raise exception 'PICKUP_DISABLED: switch on pick-up in the Online shop settings first' using errcode = '22023'; end if;
    end if;
    update public.preorder_settings set enabled = (p_patch ->> 'enabled')::boolean where id;
  end if;
  perform public.shop_log('preorder', 'settings', 'preorder.settings', p_patch);
  return public.preorder_admin_settings();
end $$;

-- a closure or special hours for one date (any staff). Refuses when active preorders would no longer fit unless p_force; the affected orders then show on the attention list.
create or replace function public.preorder_admin_save_day(p_day date, p_kind text, p_open text default null, p_close text default null, p_reason text default null, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.preorder_settings; o_t time; c_t time; n integer; why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.shop_require_staff('change the preorder calendar');
  if p_day is null or p_day < public.preorder_local_day(now()) then raise exception 'INVALID_DAY: choose today or a later date' using errcode = '22023'; end if;
  if p_kind not in ('closed', 'special') then raise exception 'INVALID_DAY: closed or special hours' using errcode = '22023'; end if;
  if why is not null and length(why) > 200 then raise exception 'INVALID_DAY: the reason is too long' using errcode = '22023'; end if;
  select * into s from public.preorder_settings where id;
  if p_kind = 'special' then
    begin o_t := p_open::time; c_t := p_close::time; exception when others then raise exception 'INVALID_DAY: give opening and closing times (HH:MM)' using errcode = '22023'; end;
    if o_t is null or c_t is null or o_t >= c_t then raise exception 'INVALID_DAY: the opening time must be before the closing time' using errcode = '22023'; end if;
  end if;
  select count(*) into n from public.shop_orders o
    where o.order_type = 'preorder' and o.status not in ('cancelled', 'returned', 'completed') and public.preorder_local_day(o.pickup_at) = p_day
      and (p_kind = 'closed' or (o.pickup_at at time zone 'Asia/Bangkok')::time < o_t or ((o.pickup_at at time zone 'Asia/Bangkok')::time + make_interval(mins => s.slot_minutes)) > c_t);
  if n > 0 and not coalesce(p_force, false) then raise exception 'DAY_HAS_ORDERS: % active preorder(s) would no longer fit', n using errcode = '22023'; end if;
  insert into public.preorder_days (day, kind, open_time, close_time, reason, created_by) values (p_day, p_kind, o_t, c_t, why, auth.uid())
    on conflict (day) do update set kind = excluded.kind, open_time = excluded.open_time, close_time = excluded.close_time, reason = excluded.reason, created_by = excluded.created_by;
  perform public.shop_log('preorder', p_day::text, 'preorder.day', jsonb_build_object('kind', p_kind, 'open', p_open, 'close', p_close, 'reason', why, 'orders_affected', n, 'forced', coalesce(p_force, false)));
  return jsonb_build_object('ok', true, 'orders_affected', n);
end $$;

create or replace function public.preorder_admin_remove_day(p_day date) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.shop_require_staff('change the preorder calendar');
  delete from public.preorder_days where day = p_day;
  perform public.shop_log('preorder', p_day::text, 'preorder.day', jsonb_build_object('kind', 'removed'));
  return jsonb_build_object('ok', true);
end $$;

-- ================================================================================================ J. time-based notices (pg_cron, every 5 minutes)
create or replace function public.preorder_sweep() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.preorder_settings; o public.shop_orders; stamp text; n integer := 0;
begin
  select * into s from public.preorder_settings where id;
  if not s.enabled then return jsonb_build_object('skipped', 'off'); end if;
  for o in select * from public.shop_orders where order_type = 'preorder' and status not in ('cancelled', 'returned', 'completed') and pickup_at < now() + interval '3 days' loop
    stamp := ':' || extract(epoch from o.pickup_at)::bigint;       -- a rescheduled order is a new occasion: its alerts are due again
    begin
      if o.status in ('confirmed', 'preparing', 'ready') and now() >= o.pickup_at - make_interval(mins => s.reminder_minutes) and now() < o.pickup_at then
        perform public.preorder_notify('reminder', o.id, 'customer', 'rem:' || o.id || stamp); n := n + 1; end if;
      if o.status in ('new', 'confirmed') and now() >= o.pickup_at - make_interval(mins => s.prep_lead_minutes) and now() < o.pickup_at then
        perform public.preorder_notify_staff('due_soon', o.id, 'due:' || o.id || stamp); n := n + 1; end if;
      if o.status in ('new', 'confirmed', 'preparing', 'packed') and now() >= o.pickup_at then
        perform public.preorder_notify_staff('late', o.id, 'late:' || o.id || stamp); n := n + 1; end if;
      if o.status = 'ready' and now() > o.pickup_at + make_interval(mins => s.grace_minutes) then
        perform public.preorder_notify_staff('overdue_pickup', o.id, 'pick:' || o.id || stamp); n := n + 1; end if;
    exception when others then raise warning 'preorder sweep skipped (order %): %', o.order_no, sqlerrm; end;
  end loop;
  return jsonb_build_object('checked', n);
end $$;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'preorder-sweep') then perform cron.unschedule('preorder-sweep'); end if;
  perform cron.schedule('preorder-sweep', '*/5 * * * *', 'select public.preorder_sweep()');
end $$;

-- ================================================================================================ K. LINE integration
-- the new event, its three switches (all on; nothing is sent while LINE or the preorder feature is off), the card data, and the settings validator that knows the switches
alter table public.line_outbox drop constraint if exists line_outbox_event_check;
alter table public.line_outbox add constraint line_outbox_event_check check (event in ('order_new', 'slip_new', 'order_status', 'payment_issue', 'customer_notify', 'preorder'));
update public.line_settings set events = events || jsonb_build_object('preorder', true, 'preorder_staff', true, 'preorder_customer', true)
  where not (events ? 'preorder') and not (events ? 'preorder_staff') and not (events ? 'preorder_customer');

create or replace function public.line_admin_save_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text; s public.line_settings; v_amount numeric; v_reasons text[]; ev text;
begin
  perform public.line_require_super('change the LINE settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_SETTING: send an object'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('enabled', 'events', 'quick_approve_enabled', 'quick_approve_max_amount', 'reject_reasons') then raise exception 'INVALID_SETTING: unknown setting %', k; end if;
  end loop;
  select * into s from public.line_settings where id for update;
  if p_patch ? 'events' then
    if jsonb_typeof(p_patch -> 'events') <> 'object' then raise exception 'INVALID_SETTING: events must be an object'; end if;
    for ev in select jsonb_object_keys(p_patch -> 'events') loop
      if ev not in ('order_new', 'slip_new', 'order_status', 'payment_issue', 'customer_notify', 'preorder', 'preorder_staff', 'preorder_customer') or jsonb_typeof(p_patch -> 'events' -> ev) <> 'boolean' then
        raise exception 'INVALID_SETTING: unknown event %', ev; end if;
    end loop;
    s.events := s.events || (p_patch -> 'events');
  end if;
  if p_patch ? 'quick_approve_max_amount' then
    v_amount := (p_patch ->> 'quick_approve_max_amount')::numeric;
    if v_amount is null or v_amount <= 0 or v_amount > 1000000 or v_amount <> round(v_amount, 2) then raise exception 'INVALID_SETTING: the maximum amount must be between 0.01 and 1,000,000'; end if;
    s.quick_approve_max_amount := v_amount;
  end if;
  if p_patch ? 'reject_reasons' then
    if jsonb_typeof(p_patch -> 'reject_reasons') <> 'array' then raise exception 'INVALID_SETTING: reject_reasons must be a list'; end if;
    select array_agg(btrim(x) order by o) into v_reasons from jsonb_array_elements_text(p_patch -> 'reject_reasons') with ordinality r(x, o);
    if coalesce(array_length(v_reasons, 1), 0) not between 1 and 10 or exists (select 1 from unnest(v_reasons) x where x = '' or length(x) > 80) then
      raise exception 'INVALID_SETTING: give 1 to 10 reasons of at most 80 characters'; end if;
    s.reject_reasons := v_reasons;
  end if;
  if p_patch ? 'quick_approve_enabled' then s.quick_approve_enabled := (p_patch ->> 'quick_approve_enabled')::boolean; end if;
  if p_patch ? 'enabled' then
    s.enabled := (p_patch ->> 'enabled')::boolean;
    if s.enabled and (s.secret_set_at is null or s.token_set_at is null or s.group_id is null) then
      raise exception 'LINE_NOT_READY: enter the channel secret and access token and bind the admin group first'; end if;
  end if;
  update public.line_settings set enabled = s.enabled, events = s.events, quick_approve_enabled = s.quick_approve_enabled,
    quick_approve_max_amount = s.quick_approve_max_amount, reject_reasons = s.reject_reasons, updated_at = now(), updated_by = auth.uid() where id;
  perform public.shop_log('line', 'settings', 'line.settings', p_patch);
  return public.line_admin_settings();
end $$;

-- the order card also tells the group when a pick-up is a scheduled preorder (the Edge Function shows it; an older Edge Function ignores the two new keys)
create or replace function public.line_card_data(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o public.shop_orders; e public.finance_payment_evidence; s public.line_settings; n int; q jsonb; v_bank text; v_method text;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  select * into s from public.line_settings where id;
  select * into e from public.finance_payment_evidence where invoice_id = o.invoice_id and source = 'customer_slip' and status <> 'rejected'
    order by created_at desc, id desc limit 1;
  select count(*) into n from public.shop_order_items where order_id = o.id;
  v_method := case when o.payment_pref = 'wallet' then 'wallet' when o.payment_pref = 'qr' then 'qr' when o.payment_pref like 'bank:%' or e.id is not null then 'transfer' else 'unpaid' end;
  v_bank := coalesce((select b.code from public.finance_bank_accounts b where b.id = e.bank_account_id), case when o.payment_pref like 'bank:%' then substr(o.payment_pref, 6) end);
  q := public.line_quick_check(o.id);
  return jsonb_build_object(
    'order_id', o.id, 'order_no', o.order_no, 'customer_name', o.contact_name, 'phone', o.contact_phone, 'created_at', o.created_at,
    'item_count', (select coalesce(sum(qty), 0) from public.shop_order_items where order_id = o.id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', it.name, 'qty', it.qty, 'price', it.unit_price,
               'image', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = it.sku_code)) order by it.line_no)
             from (select * from public.shop_order_items where order_id = o.id order by line_no limit 3) it), '[]'::jsonb),
    'more_count', greatest(n - 3, 0),
    'total', o.total, 'fulfilment', o.fulfilment, 'order_type', o.order_type, 'pickup_at', o.pickup_at,
    'payment', jsonb_build_object('method', v_method, 'bank', v_bank, 'has_slip', e.id is not null, 'transfer_at', e.claimed_transfer_at, 'evidence_id', e.id),
    'status', o.status, 'quick', jsonb_build_object('ok', (q ->> 'ok')::boolean, 'why', q ->> 'why'), 'app_url', s.app_url);
end $$;

-- ================================================================================================ L. grants
do $$ declare f text; begin
  -- internal helpers: no client (and no anon) can call them; the SECURITY DEFINER functions below reach them as their owner
  foreach f in array array[
    'preorder_local_day(timestamptz)', 'preorder_hours(date)', 'preorder_grid(date)', 'preorder_load(timestamptz, uuid)', 'preorder_day_units(date, uuid)',
    'preorder_check_slot(timestamptz, integer, uuid, boolean, boolean)', 'preorder_msg(text, uuid, jsonb)', 'preorder_notify(text, uuid, text, text, jsonb, uuid, boolean)',
    'preorder_assignee(uuid)', 'preorder_notify_staff(text, uuid, text, jsonb, boolean, text)', 'preorder_flags(shop_orders, preorder_settings, integer, integer)',
    'preorder_row(uuid, boolean)', 'preorder_change_rules(uuid)', 'preorder_after_place(uuid)', 'preorder_sweep()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  -- what the apps call
  foreach f in array array[
    'preorder_options()', 'preorder_slots(date, integer)', 'preorder_change_my_order(uuid, jsonb)', 'preorder_request_change(uuid, text)',
    'preorder_admin_staff()', 'preorder_admin_dashboard(date)', 'preorder_admin_list(text, text, text, date, date, text, text, text, text, integer, integer)', 'preorder_admin_schedule(date)',
    'preorder_prep_board(boolean, integer)', 'preorder_admin_assign(uuid, uuid)', 'preorder_admin_reschedule(uuid, timestamptz, text, boolean)', 'preorder_prep_set(uuid, integer, boolean)',
    'preorder_admin_notices(integer)', 'preorder_admin_settings()', 'preorder_admin_save_settings(jsonb)', 'preorder_admin_save_day(date, text, text, text, text, boolean)',
    'preorder_admin_remove_day(date)',
    'shop_place_order(text, jsonb, text, text, text, text, text, numeric, text, text, text, text, timestamptz, text, timestamptz)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
