-- Opening Accounts Receivable (AR) balances carried forward from the
-- "TOM CRAFT จำกัด 2024" workbook (extracted to 01_MASTER_DATA.xlsx / Customer_AR).
--
-- Additive only: creates new tables, a view and an import function.
-- Nothing existing is altered or deleted.
--
-- Design
--   customers          one row per customer (code = source Migration_Key)
--   ar_import_batches  one row per import run: source file, checksum, totals, who/when
--   ar_open_items      one row per open receivable carried forward; only the
--                      REMAINING unpaid amount is outstanding
--                      (outstanding_amount = original_amount - paid_amount, enforced)
--   ar_open_item_status / ar_customer_balances   read views (age, totals per customer)
--   ar_import_opening(batch, customers, items, dry_run)   validated, idempotent import

-- ---------------------------------------------------------------- customers
create table public.customers (
  id            uuid primary key default gen_random_uuid(),
  customer_code text not null unique,
  name          text not null,
  profile_id    uuid references public.profiles (id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'inactive')),
  source_ref    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.customers is 'Customers. customer_code is the migration key from the source master data; profile_id links a LINE member when known.';

-- ---------------------------------------------------------- import batches
create table public.ar_import_batches (
  id                 uuid primary key default gen_random_uuid(),
  batch_code         text not null unique,
  kind               text not null default 'opening_balance' check (kind in ('opening_balance')),
  source_file        text not null,
  source_sheet       text not null,
  source_sha256      text not null unique,
  status             text not null default 'completed' check (status in ('completed', 'voided')),
  record_count       integer not null,
  original_total     numeric(14, 2) not null,
  paid_total         numeric(14, 2) not null,
  outstanding_total  numeric(14, 2) not null,
  currency           char(3) not null default 'THB',
  notes              jsonb not null default '{}'::jsonb,
  imported_by        uuid references auth.users (id) on delete set null,
  imported_by_label  text not null default current_user,
  imported_at        timestamptz not null default now()
);
comment on table public.ar_import_batches is 'Audit record of each AR import run (source file checksum, totals, reconciliation notes).';

-- ------------------------------------------------------------- open items
create table public.ar_open_items (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references public.ar_import_batches (id) on delete restrict,
  customer_id        uuid not null references public.customers (id) on delete restrict,
  entry_type         text not null default 'opening_balance' check (entry_type in ('opening_balance')),
  source_ref         text not null unique,          -- e.g. AR03-R1341, idempotency key
  register_no        integer,                       -- debtor register number, when the source has one
  document_no        text,                          -- invoice number: not present in the source
  business_line      text not null check (business_line in ('kratom', 'pod')),
  doc_date           date,
  doc_date_raw       text,                          -- original value when the date was invalid
  due_date           date,                          -- not present in the source
  original_amount    numeric(14, 2) not null check (original_amount >= 0),
  paid_amount        numeric(14, 2) not null default 0 check (paid_amount >= 0),
  outstanding_amount numeric(14, 2) not null check (outstanding_amount > 0),
  currency           char(3) not null default 'THB',
  source_workbook    text not null,
  source_sheet       text not null,
  source_row         integer not null,
  source_table       text,
  source_status      text,                          -- status text from the source formula
  review_flags       text[] not null default '{}',
  created_at         timestamptz not null default now(),
  constraint ar_open_items_outstanding_calc check (outstanding_amount = original_amount - paid_amount),
  constraint ar_open_items_source_unique unique (source_workbook, source_sheet, source_row)
);
create index ar_open_items_customer_idx on public.ar_open_items (customer_id);
create index ar_open_items_batch_idx on public.ar_open_items (batch_id);
comment on table public.ar_open_items is 'Opening AR balances carried forward, one per source receivable. outstanding_amount is what the customer still owes at import time.';

-- ------------------------------------------------------------------ views
create view public.ar_open_item_status with (security_invoker = true) as
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
  case when i.due_date is not null then current_date > i.due_date end as is_overdue
from public.ar_open_items i
join public.customers c on c.id = i.customer_id
join public.ar_import_batches b on b.id = i.batch_id
where b.status = 'completed';

create view public.ar_customer_balances with (security_invoker = true) as
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
  count(*) filter (where s.is_overdue) as overdue_items
from public.customers c
join public.ar_open_item_status s on s.customer_id = c.id
group by c.id, c.customer_code, c.name;

-- -------------------------------------------------------------------- RLS
alter table public.customers enable row level security;
alter table public.ar_import_batches enable row level security;
alter table public.ar_open_items enable row level security;

create policy "customers: staff read" on public.customers
  for select to authenticated using (public.feedback_is_staff());
create policy "ar batches: staff read" on public.ar_import_batches
  for select to authenticated using (public.feedback_is_staff());
create policy "ar items: staff read" on public.ar_open_items
  for select to authenticated using (public.feedback_is_staff());
-- No insert/update/delete policies: writes go only through ar_import_opening.

-- ------------------------------------------------------------ import RPC
-- p_batch     {batch_code, source_file, source_sheet, source_sha256, notes}
-- p_customers [{customer_code, name, source_ref}]
-- p_items     [{source_ref, customer_code, register_no, business_line, doc_date, doc_date_raw,
--               original_amount, paid_amount, outstanding_amount, currency,
--               source_workbook, source_sheet, source_row, source_table, source_status, review_flags}]
-- p_dry_run   true = validate and report only, nothing is written
-- Runs in one transaction; any validation error aborts the real import.
create function public.ar_import_opening(p_batch jsonb, p_customers jsonb, p_items jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_batch_id   uuid;
  v_existing   public.ar_import_batches;
  v_errors     jsonb := '[]'::jsonb;
  v_total      int := jsonb_array_length(p_items);
  v_dups       int;
  v_new_cust   int;
  v_matched    int;
  v_unmatched  int;
  v_inserted   int := 0;
  v_orig       numeric; v_paid numeric; v_out numeric;
begin
  perform pg_advisory_xact_lock(hashtext('ar_import_opening'));

  select * into v_existing from public.ar_import_batches where source_sha256 = p_batch->>'source_sha256';

  -- validation, row by row
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_errors from (
    select jsonb_build_object('source_ref', i->>'source_ref', 'error', err) e
    from jsonb_array_elements(p_items) i,
    lateral (values
      (case when coalesce(i->>'source_ref', '') = '' then 'missing source_ref' end),
      (case when not exists (select 1 from jsonb_array_elements(p_customers) c where c->>'customer_code' = i->>'customer_code')
             and not exists (select 1 from public.customers c where c.customer_code = i->>'customer_code')
            then 'unknown customer_code ' || coalesce(i->>'customer_code', 'NULL') end),
      (case when (i->>'original_amount')::numeric < 0 or coalesce((i->>'paid_amount')::numeric, 0) < 0 then 'negative amount' end),
      (case when (i->>'outstanding_amount')::numeric
                 <> (i->>'original_amount')::numeric - coalesce((i->>'paid_amount')::numeric, 0)
            then 'outstanding <> original - paid' end),
      (case when (i->>'outstanding_amount')::numeric <= 0 then 'not an open item (outstanding <= 0)' end)
    ) v(err)
    where err is not null
    union all
    select jsonb_build_object('source_ref', k, 'error', 'source_ref repeated in file')
    from (select i->>'source_ref' k from jsonb_array_elements(p_items) i group by 1 having count(*) > 1) d
  ) x;

  select count(*) into v_dups from jsonb_array_elements(p_items) i
  where exists (select 1 from public.ar_open_items o where o.source_ref = i->>'source_ref');

  select count(distinct i->>'customer_code') filter (where exists (select 1 from public.customers c where c.customer_code = i->>'customer_code')),
         count(distinct i->>'customer_code') filter (where not exists (select 1 from public.customers c where c.customer_code = i->>'customer_code'))
    into v_matched, v_new_cust
  from jsonb_array_elements(p_items) i;

  select count(*) into v_unmatched from jsonb_array_elements(p_items) i
  where not exists (select 1 from jsonb_array_elements(p_customers) c where c->>'customer_code' = i->>'customer_code')
    and not exists (select 1 from public.customers c where c.customer_code = i->>'customer_code');

  select sum((i->>'original_amount')::numeric), sum(coalesce((i->>'paid_amount')::numeric, 0)), sum((i->>'outstanding_amount')::numeric)
    into v_orig, v_paid, v_out
  from jsonb_array_elements(p_items) i;

  if not p_dry_run then
    if not (current_user in ('postgres', 'supabase_admin', 'service_role') or public.current_profile_role() = 'SUPER_ADMIN') then
      raise exception 'Only a super admin can import AR opening balances' using errcode = '42501';
    end if;
    if jsonb_array_length(v_errors) > 0 then
      raise exception 'AR import aborted: % validation error(s): %', jsonb_array_length(v_errors), v_errors;
    end if;

    if v_existing.id is not null then
      v_batch_id := v_existing.id;            -- same file again: reuse batch, items dedupe below
    else
      insert into public.ar_import_batches (batch_code, source_file, source_sheet, source_sha256, record_count,
        original_total, paid_total, outstanding_total, notes, imported_by, imported_by_label)
      values (p_batch->>'batch_code', p_batch->>'source_file', p_batch->>'source_sheet', p_batch->>'source_sha256', 0,
        0, 0, 0, coalesce(p_batch->'notes', '{}'::jsonb), auth.uid(),
        coalesce((select email from public.profiles where id = auth.uid()), current_user))
      returning id into v_batch_id;
    end if;

    -- customers: insert new only, never overwrite an existing customer
    insert into public.customers (customer_code, name, source_ref)
    select c->>'customer_code', c->>'name', c->>'source_ref'
    from jsonb_array_elements(p_customers) c
    on conflict (customer_code) do nothing;

    insert into public.ar_open_items (batch_id, customer_id, source_ref, register_no, business_line, doc_date, doc_date_raw,
      original_amount, paid_amount, outstanding_amount, currency, source_workbook, source_sheet, source_row,
      source_table, source_status, review_flags)
    select v_batch_id, c.id, i->>'source_ref', (i->>'register_no')::int, i->>'business_line',
      (i->>'doc_date')::date, i->>'doc_date_raw',
      (i->>'original_amount')::numeric, coalesce((i->>'paid_amount')::numeric, 0), (i->>'outstanding_amount')::numeric,
      coalesce(i->>'currency', 'THB'), i->>'source_workbook', i->>'source_sheet', (i->>'source_row')::int,
      i->>'source_table', i->>'source_status',
      coalesce(array(select jsonb_array_elements_text(i->'review_flags')), '{}')
    from jsonb_array_elements(p_items) i
    join public.customers c on c.customer_code = i->>'customer_code'
    on conflict (source_ref) do nothing;
    get diagnostics v_inserted = row_count;

    update public.ar_import_batches b set
      record_count      = s.n,
      original_total    = s.o,
      paid_total        = s.p,
      outstanding_total = s.t
    from (select count(*) n, coalesce(sum(original_amount), 0) o, coalesce(sum(paid_amount), 0) p, coalesce(sum(outstanding_amount), 0) t
          from public.ar_open_items where batch_id = v_batch_id) s
    where b.id = v_batch_id;
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'batch_id', v_batch_id,
    'batch_already_imported', v_existing.id is not null,
    'total_source_records', v_total,
    'customers_existing', v_matched,
    'customers_new', v_new_cust,
    'unmatched_customer_records', v_unmatched,
    'original_total', v_orig,
    'paid_total', v_paid,
    'outstanding_total', v_out,
    'duplicate_records', v_dups,
    'import_errors', jsonb_array_length(v_errors),
    'errors', v_errors,
    'imported', v_inserted
  );
end $$;

revoke all on function public.ar_import_opening(jsonb, jsonb, jsonb, boolean) from public, anon, authenticated;
