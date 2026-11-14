-- Payments received against the opening AR balances.
--
-- Additive only. The opening balance (ar_open_items.outstanding_amount) is never edited: the balance that is
-- still owed is   outstanding_amount - (sum of allocations of POSTED receipts).
--
--   ar_receipts             one row per payment received from a customer (never updated except to void, never deleted)
--   ar_receipt_allocations  how a receipt is split across open items (never updated, never deleted)
--   ar_receive_payment()    staff-only, transactional; FIFO (oldest document first) or explicit allocations
--   ar_void_receipt()       staff-only; keeps the receipt, records who/why, and releases its allocations
--
-- Not supported yet (rejected with a clear message): paying MORE than the customer owes. That would need a customer
-- credit ledger, which does not exist in the database yet.

create sequence public.ar_receipt_seq;

create table public.ar_receipts (
  id               uuid primary key default gen_random_uuid(),
  receipt_no       text not null unique,
  customer_id      uuid not null references public.customers (id) on delete restrict,
  received_date    date not null,
  amount           numeric(14, 2) not null check (amount > 0),
  currency         char(3) not null default 'THB',
  method           text not null check (method in ('cash', 'transfer', 'promptpay', 'other')),
  reference        text,
  note             text,
  status           text not null default 'posted' check (status in ('posted', 'voided')),
  idempotency_key  text unique,
  created_by       uuid references auth.users (id) on delete set null,
  created_by_label text not null,
  created_at       timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        uuid references auth.users (id) on delete set null,
  void_reason      text,
  constraint ar_receipts_void_complete check ((status = 'voided') = (voided_at is not null and void_reason is not null))
);
create index ar_receipts_customer_idx on public.ar_receipts (customer_id, received_date desc);

create table public.ar_receipt_allocations (
  id           uuid primary key default gen_random_uuid(),
  receipt_id   uuid not null references public.ar_receipts (id) on delete restrict,
  open_item_id uuid not null references public.ar_open_items (id) on delete restrict,
  amount       numeric(14, 2) not null check (amount > 0),
  created_at   timestamptz not null default now(),
  unique (receipt_id, open_item_id)
);
create index ar_receipt_alloc_item_idx on public.ar_receipt_allocations (open_item_id);

-- ------------------------------------------------------------- integrity
-- No hard deletes; receipts keep their money fields forever (only the void columns may change, once).
create function public.ar_receipts_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'AR receipts and allocations cannot be deleted; void the receipt instead'; end if;
  if tg_table_name = 'ar_receipt_allocations' then raise exception 'AR receipt allocations cannot be changed'; end if;
  if (new.id, new.receipt_no, new.customer_id, new.received_date, new.amount, new.currency, new.method, new.created_at)
     is distinct from (old.id, old.receipt_no, old.customer_id, old.received_date, old.amount, old.currency, old.method, old.created_at)
     or old.status = 'voided' then
    raise exception 'AR receipts cannot be edited; void the receipt and post a new one';
  end if;
  return new;
end $$;
create trigger ar_receipts_no_edit   before update or delete on public.ar_receipts            for each row execute function public.ar_receipts_immutable();
create trigger ar_allocs_no_edit     before update or delete on public.ar_receipt_allocations for each row execute function public.ar_receipts_immutable();

-- An item can never be allocated beyond what it still owes, even if someone inserts directly (not through the RPC).
create function public.ar_alloc_guard() returns trigger language plpgsql as $$
declare v_out numeric; v_used numeric; v_cust uuid; v_rcust uuid;
begin
  select outstanding_amount, customer_id into v_out, v_cust from public.ar_open_items where id = new.open_item_id for update;
  select customer_id into v_rcust from public.ar_receipts where id = new.receipt_id;
  if v_cust is distinct from v_rcust then raise exception 'Allocation customer does not match the receipt customer'; end if;
  select coalesce(sum(a.amount), 0) into v_used
  from public.ar_receipt_allocations a join public.ar_receipts r on r.id = a.receipt_id
  where a.open_item_id = new.open_item_id and r.status = 'posted';
  if v_used + new.amount > v_out then
    raise exception 'Allocation of % exceeds the remaining balance % on this item', new.amount, v_out - v_used;
  end if;
  return new;
end $$;
create trigger ar_alloc_guard_trg before insert on public.ar_receipt_allocations for each row execute function public.ar_alloc_guard();

-- --------------------------------------------------------------------- RLS
alter table public.ar_receipts enable row level security;
alter table public.ar_receipt_allocations enable row level security;
create policy "ar receipts: staff read" on public.ar_receipts            for select to authenticated using (public.feedback_is_staff());
create policy "ar allocs: staff read"   on public.ar_receipt_allocations for select to authenticated using (public.feedback_is_staff());
-- No write policies: all writes go through the functions below.

-- ------------------------------------------------------------------ views
-- Same columns as before plus received/balance appended at the end (backward compatible).
create or replace view public.ar_open_item_status with (security_invoker = true) as
select
  i.*,
  c.customer_code,
  c.name as customer_name,
  b.batch_code,
  case when i.doc_date is not null then current_date - i.doc_date end as age_days,
  case
    when i.doc_date is null then 'unknown'
    when current_date - i.doc_date <= 30 then '0-30'
    when current_date - i.doc_date <= 60 then '31-60'
    when current_date - i.doc_date <= 90 then '61-90'
    else '90+'
  end as aging_bucket,
  case when i.due_date is not null then current_date > i.due_date end as is_overdue,
  coalesce(rc.received, 0)::numeric(14, 2)                       as received_amount,
  (i.outstanding_amount - coalesce(rc.received, 0))::numeric(14, 2) as balance_amount
from public.ar_open_items i
join public.customers c on c.id = i.customer_id
join public.ar_import_batches b on b.id = i.batch_id
left join lateral (
  select sum(a.amount) as received
  from public.ar_receipt_allocations a join public.ar_receipts r on r.id = a.receipt_id
  where a.open_item_id = i.id and r.status = 'posted'
) rc on true
where b.status = 'completed';

create or replace view public.ar_customer_balances with (security_invoker = true) as
select
  c.id as customer_id,
  c.customer_code,
  c.name as customer_name,
  count(s.id)                   as open_items,
  sum(s.original_amount)        as original_total,
  sum(s.paid_amount)            as paid_total,
  sum(s.outstanding_amount)     as outstanding_total,
  min(s.doc_date)               as oldest_doc_date,
  max(s.doc_date)               as newest_doc_date,
  max(s.age_days)               as max_age_days,
  count(*) filter (where s.is_overdue) as overdue_items,
  sum(s.received_amount)        as received_total,
  sum(s.balance_amount)         as balance_total
from public.customers c
join public.ar_open_item_status s on s.customer_id = c.id
group by c.id, c.customer_code, c.name;

-- --------------------------------------------------------------- functions
create function public.ar_receive_payment(
  p_customer uuid, p_amount numeric, p_method text, p_date date default current_date,
  p_reference text default null, p_note text default null, p_allocations jsonb default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me        public.profiles;
  v_rc        public.ar_receipts;
  v_amount    numeric(14, 2) := round(coalesce(p_amount, 0), 2);
  v_left      numeric(14, 2);
  v_take      numeric(14, 2);
  v_total_bal numeric(14, 2);
  v_item      record;
  v_alloc     jsonb;
  v_sum       numeric(14, 2) := 0;
  v_out       jsonb := '[]'::jsonb;
begin
  select * into v_me from public.profiles where id = auth.uid() and status = 'active' and role in ('ADMIN', 'SUPER_ADMIN');
  if v_me.id is null then raise exception 'Only staff can record payments' using errcode = '42501'; end if;
  if v_amount <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  if p_method not in ('cash', 'transfer', 'promptpay', 'other') then raise exception 'Unknown payment method %', p_method; end if;
  if p_date is null or p_date > current_date then raise exception 'Payment date cannot be in the future'; end if;
  if not exists (select 1 from public.customers where id = p_customer) then raise exception 'Unknown customer'; end if;

  perform pg_advisory_xact_lock(hashtext('ar_customer:' || p_customer::text));

  if p_idempotency_key is not null then
    select * into v_rc from public.ar_receipts where idempotency_key = p_idempotency_key;
    if v_rc.id is not null then
      return jsonb_build_object('receipt_id', v_rc.id, 'receipt_no', v_rc.receipt_no, 'amount', v_rc.amount, 'already_recorded', true);
    end if;
  end if;

  select coalesce(sum(balance_amount), 0) into v_total_bal from public.ar_open_item_status where customer_id = p_customer;
  if v_amount > v_total_bal then
    raise exception 'Payment of % is more than the customer owes (%). Overpayment/credit is not supported yet.', v_amount, v_total_bal;
  end if;

  insert into public.ar_receipts (receipt_no, customer_id, received_date, amount, method, reference, note, idempotency_key, created_by, created_by_label)
  values ('AR-RC-' || lpad(nextval('public.ar_receipt_seq')::text, 6, '0'), p_customer, p_date, v_amount, p_method,
          left(nullif(trim(p_reference), ''), 120), left(nullif(trim(p_note), ''), 500), left(p_idempotency_key, 80),
          v_me.id, coalesce(v_me.display_name, v_me.email))
  returning * into v_rc;

  if p_allocations is null then
    -- FIFO: oldest document first (undated last), then source row order.
    v_left := v_amount;
    for v_item in
      select id, balance_amount from public.ar_open_item_status
      where customer_id = p_customer and balance_amount > 0
      order by doc_date asc nulls last, source_row asc
    loop
      exit when v_left <= 0;
      v_take := least(v_left, v_item.balance_amount);
      insert into public.ar_receipt_allocations (receipt_id, open_item_id, amount) values (v_rc.id, v_item.id, v_take);
      v_out := v_out || jsonb_build_object('open_item_id', v_item.id, 'amount', v_take);
      v_left := v_left - v_take;
    end loop;
    v_sum := v_amount - v_left;
  else
    for v_alloc in select * from jsonb_array_elements(p_allocations) loop
      v_take := round((v_alloc->>'amount')::numeric, 2);
      if v_take is null or v_take <= 0 then raise exception 'Each allocation must be greater than zero'; end if;
      insert into public.ar_receipt_allocations (receipt_id, open_item_id, amount) values (v_rc.id, (v_alloc->>'open_item_id')::uuid, v_take);
      v_out := v_out || jsonb_build_object('open_item_id', v_alloc->>'open_item_id', 'amount', v_take);
      v_sum := v_sum + v_take;
    end loop;
  end if;

  if v_sum <> v_amount then raise exception 'Allocations (%) must add up to the payment amount (%)', v_sum, v_amount; end if;

  insert into public.auth_audit_logs (actor_id, action, detail)
  values (v_me.id, 'ar.receipt.posted', jsonb_build_object('receipt_no', v_rc.receipt_no, 'customer_id', p_customer, 'amount', v_amount, 'method', p_method));

  return jsonb_build_object('receipt_id', v_rc.id, 'receipt_no', v_rc.receipt_no, 'amount', v_amount, 'allocations', v_out, 'already_recorded', false);
end $$;

create function public.ar_void_receipt(p_receipt uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_me public.profiles; v_rc public.ar_receipts;
begin
  select * into v_me from public.profiles where id = auth.uid() and status = 'active' and role in ('ADMIN', 'SUPER_ADMIN');
  if v_me.id is null then raise exception 'Only staff can void receipts' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required to void a receipt'; end if;
  select * into v_rc from public.ar_receipts where id = p_receipt for update;
  if v_rc.id is null then raise exception 'Receipt not found'; end if;
  if v_rc.status = 'voided' then raise exception 'Receipt % is already voided', v_rc.receipt_no; end if;
  update public.ar_receipts set status = 'voided', voided_at = now(), voided_by = v_me.id, void_reason = left(trim(p_reason), 500) where id = p_receipt;
  insert into public.auth_audit_logs (actor_id, action, detail)
  values (v_me.id, 'ar.receipt.voided', jsonb_build_object('receipt_no', v_rc.receipt_no, 'amount', v_rc.amount, 'reason', left(trim(p_reason), 500)));
  return jsonb_build_object('receipt_id', v_rc.id, 'receipt_no', v_rc.receipt_no, 'status', 'voided');
end $$;

revoke all on function public.ar_receive_payment(uuid, numeric, text, date, text, text, jsonb, text) from public, anon;
revoke all on function public.ar_void_receipt(uuid, text) from public, anon;
grant execute on function public.ar_receive_payment(uuid, numeric, text, date, text, text, jsonb, text) to authenticated;
grant execute on function public.ar_void_receipt(uuid, text) to authenticated;
