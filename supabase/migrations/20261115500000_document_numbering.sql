-- One central, database-owned numbering system for business documents (builds on 20261115100000..400000).
--
-- Why: numbers came from six separate sequences (shop_order_seq, finance_invoice_seq, finance_receipt_seq, finance_wallet_txn_seq, finance_deposit_seq,
-- ar_receipt_seq), each with its own hard-coded format. A sequence never gives a number back: every rolled-back transaction (a failed checkout, a
-- refused slip, a test) burns one, so numbers have gaps and "the first order" is already SO-...-00181. This replaces them with ONE mechanism:
--   * doc_number_formats : per document type a prefix, a period rule (none | year | month | fiscal_year) and the digit count: change the format here
--     (finance_save_doc_format), never in code.
--   * doc_counters       : the last number per type and period. next_doc_no() takes the next one with a row lock, INSIDE the transaction of the
--     document: if the transaction fails, the number is not consumed. Numbers are gap-free and can never be issued twice, even under concurrency.
-- Formats from now on:  ORD-000001 (order), INV-000001 (invoice), PAY-000001 (customer payment), WAL-000001 (wallet transaction), DEP-000001 (wallet
-- deposit), AR-RC-000001 (receipt against the opening receivables). Documents that already exist keep their numbers (they are records).
--
-- RESET: the six old sequences are retired (dropped) and the new counters start at zero, so the next new document of each type is number 1.
-- NO ROW IS DELETED: orders, invoices and receipts that exist stay exactly as they are (finance records are never deleted).
-- Counters are append-only: a trigger refuses to lower them (only an explicit, logged reset by the owner can, see finance.counter_reset).
-- Lock order: the document numbers a function takes are always (order) < (invoice) < (payment) < (the wallet row) < (wallet / deposit number), so two
-- concurrent payments can never wait for each other in a circle.

create table if not exists public.doc_number_settings (
  id boolean primary key default true check (id),
  fiscal_year_start_month integer not null default 1 check (fiscal_year_start_month between 1 and 12),     -- 1 = the fiscal year is the calendar year; 10 = it starts in October
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.doc_number_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.doc_number_formats (
  doc_type text primary key check (doc_type ~ '^[A-Z][A-Z_]{1,29}$'),
  prefix text not null check (prefix ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and length(prefix) <= 12),
  period_mode text not null default 'none' check (period_mode in ('none', 'year', 'month', 'fiscal_year')),
  digits integer not null default 6 check (digits between 3 and 12),
  description text,
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.doc_number_formats (doc_type, prefix, period_mode, digits, description) values
  ('ORDER',      'ORD',   'none', 6, 'Online order'),
  ('INVOICE',    'INV',   'none', 6, 'Invoice / payment request'),
  ('PAYMENT',    'PAY',   'none', 6, 'Customer payment (receipt)'),
  ('WALLET',     'WAL',   'none', 6, 'Wallet transaction'),
  ('DEPOSIT',    'DEP',   'none', 6, 'Wallet deposit'),
  ('AR_RECEIPT', 'AR-RC', 'none', 6, 'Receipt against the opening receivables')
on conflict (doc_type) do nothing;

create table if not exists public.doc_counters (
  doc_type text not null references public.doc_number_formats (doc_type) on delete restrict,
  period_key text not null default '',
  last_seq bigint not null default 0 check (last_seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (doc_type, period_key)
);

-- counters only move forward, one at a time; nothing deletes them. (A deliberate, logged reset sets finance.counter_reset for its own transaction.)
create or replace function public.doc_counter_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('finance.counter_reset', true), '') = 'on' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then raise exception 'Document counters are never deleted'; end if;
  if new.doc_type is distinct from old.doc_type or new.period_key is distinct from old.period_key or new.last_seq <> old.last_seq + 1 then
    raise exception 'A document counter only moves forward by one'; end if;
  return new;
end $$;
drop trigger if exists doc_counters_guard on public.doc_counters;
create trigger doc_counters_guard before update or delete on public.doc_counters for each row execute function public.doc_counter_guard();

-- THE number generator. Takes the next number of a type (and period) with a row lock held until the calling transaction ends.
create or replace function public.next_doc_no(p_type text, p_date date default null)
returns text language plpgsql security definer set search_path = public as $$
declare f public.doc_number_formats; s public.doc_number_settings; d date; pk text; n bigint; m integer;
begin
  select * into f from public.doc_number_formats where doc_type = p_type;
  if not found then raise exception 'Unknown document type %', p_type; end if;
  d := coalesce(p_date, (now() at time zone 'Asia/Bangkok')::date);
  select * into s from public.doc_number_settings where id;
  m := coalesce(s.fiscal_year_start_month, 1);
  pk := case f.period_mode
    when 'none' then ''
    when 'year' then to_char(d, 'YYYY')
    when 'month' then to_char(d, 'YYYYMM')
    else 'FY' || (extract(year from d)::int + case when m > 1 and extract(month from d)::int >= m then 1 else 0 end)::text      -- named after the year the fiscal year ENDS
  end;
  insert into public.doc_counters (doc_type, period_key, last_seq) values (p_type, pk, 1)
    on conflict (doc_type, period_key) do update set last_seq = public.doc_counters.last_seq + 1, updated_at = now()
    returning last_seq into n;
  return f.prefix || '-' || case when pk <> '' then pk || '-' else '' end || case when length(n::text) >= f.digits then n::text else lpad(n::text, f.digits, '0') end;
end $$;
revoke execute on function public.next_doc_no(text, date) from public, anon, authenticated;

-- staff: see the formats and where each counter stands; managers change a format (it applies to the NEXT document; old numbers are untouched)
create or replace function public.doc_numbering_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see the document numbering');
  return jsonb_build_object('fiscal_year_start_month', (select fiscal_year_start_month from public.doc_number_settings where id),
    'formats', (select coalesce(jsonb_agg(jsonb_build_object('doc_type', f.doc_type, 'prefix', f.prefix, 'period_mode', f.period_mode, 'digits', f.digits, 'description', f.description,
        'counters', (select coalesce(jsonb_agg(jsonb_build_object('period', c.period_key, 'last', c.last_seq) order by c.period_key), '[]'::jsonb) from public.doc_counters c where c.doc_type = f.doc_type)) order by f.doc_type), '[]'::jsonb)
      from public.doc_number_formats f));
end $$;

create or replace function public.finance_save_doc_format(p_type text, p_prefix text, p_period text, p_digits integer, p_fiscal_start integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_require('manage', 'change the document numbering');
  if not exists (select 1 from public.doc_number_formats where doc_type = p_type) then raise exception 'Unknown document type %', p_type; end if;
  if p_prefix is null or p_prefix !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' or length(p_prefix) > 12 then raise exception 'The prefix is letters and digits (and single hyphens), at most 12 characters'; end if;
  if p_period not in ('none', 'year', 'month', 'fiscal_year') then raise exception 'The period must be none, year, month or fiscal_year'; end if;
  if p_digits is null or p_digits not between 3 and 12 then raise exception 'The number of digits must be 3 to 12'; end if;
  if exists (select 1 from public.doc_number_formats where doc_type <> p_type and prefix = p_prefix) then raise exception 'Another document type already uses the prefix %', p_prefix; end if;
  update public.doc_number_formats set prefix = p_prefix, period_mode = p_period, digits = p_digits, updated_by = auth.uid(), updated_at = now() where doc_type = p_type;
  if p_fiscal_start is not null then
    if p_fiscal_start not between 1 and 12 then raise exception 'The fiscal year start month is 1 to 12'; end if;
    update public.doc_number_settings set fiscal_year_start_month = p_fiscal_start, updated_by = auth.uid(), updated_at = now() where id;
  end if;
  perform public.finance_log('numbering', md5('doc_number_formats:' || p_type)::uuid, 'numbering.format', jsonb_build_object('prefix', p_prefix, 'period', p_period, 'digits', p_digits, 'fiscal_start', p_fiscal_start));
  return public.doc_numbering_overview();
end $$;

-- RLS and grants: staff read, nobody writes from a client (functions only)
alter table public.doc_number_settings enable row level security;
alter table public.doc_number_formats enable row level security;
alter table public.doc_counters enable row level security;
drop policy if exists "doc numbering settings: staff" on public.doc_number_settings;
create policy "doc numbering settings: staff" on public.doc_number_settings for select to authenticated using (public.finance_can('view'));
drop policy if exists "doc numbering formats: staff" on public.doc_number_formats;
create policy "doc numbering formats: staff" on public.doc_number_formats for select to authenticated using (public.finance_can('view'));
drop policy if exists "doc numbering counters: staff" on public.doc_counters;
create policy "doc numbering counters: staff" on public.doc_counters for select to authenticated using (public.finance_can('view'));
do $$ declare t text; begin
  foreach t in array array['doc_number_settings', 'doc_number_formats', 'doc_counters'] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
  revoke execute on function public.doc_counter_guard() from public, anon, authenticated;
  revoke execute on function public.doc_numbering_overview() from public, anon;
  grant execute on function public.doc_numbering_overview() to authenticated;
  revoke execute on function public.finance_save_doc_format(text, text, text, integer, integer) from public, anon;
  grant execute on function public.finance_save_doc_format(text, text, text, integer, integer) to authenticated;
end $$;

-- ---------------------------------------------------------------------------------------------- move every document onto it
-- Each place that took a number from an old sequence is rewritten from its LIVE definition (so nothing else in those functions can drift). Every
-- rewrite must find its text exactly the expected number of times, and afterwards no function may mention an old sequence.
create or replace function pg_temp.swap(p_old text, p_new text, p_expect integer) returns void language plpgsql as $$
declare r record; d text; hits integer := 0;
begin
  for r in select p.oid, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and position(p_old in pg_get_functiondef(p.oid)) > 0 loop
    d := replace(r.def, p_old, p_new);
    execute d;
    hits := hits + 1;
  end loop;
  if hits <> p_expect then raise exception 'numbering swap: expected % function(s) containing %, found %', p_expect, left(p_old, 60), hits; end if;
end $$;

-- paying an invoice from the wallet: take the payment number BEFORE the wallet row is locked (the fixed lock order above)
select pg_temp.swap($a$declare v_cust uuid; v_i public.finance_invoices; v_st jsonb; v_out numeric; v_t public.finance_wallet_transactions; v_rc public.finance_receipts; v_key text; v_existing public.finance_receipts;$a$,
                    $b$declare v_cust uuid; v_i public.finance_invoices; v_st jsonb; v_out numeric; v_t public.finance_wallet_transactions; v_rc public.finance_receipts; v_key text; v_existing public.finance_receipts; v_rno text;$b$, 1);
select pg_temp.swap($a$  v_t := public.finance_wallet_apply(v_cust, 'INVOICE_PAYMENT', 'debit', p_amount, v_key,$a$,
                    $b$  v_rno := public.next_doc_no('PAYMENT');          -- numbers are always taken in one fixed order (payment, wallet row, wallet number): no deadlock between concurrent payments
  v_t := public.finance_wallet_apply(v_cust, 'INVOICE_PAYMENT', 'debit', p_amount, v_key,$b$, 1);
select pg_temp.swap($a$values ('RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0'), v_cust, v_i.id, null, v_t.id, p_amount, 'wallet', now(), false)$a$,
                    $b$values (v_rno, v_cust, v_i.id, null, v_t.id, p_amount, 'wallet', now(), false)$b$, 1);

select pg_temp.swap($a$'SO-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.shop_order_seq')::text, 5, '0')$a$, $b$public.next_doc_no('ORDER')$b$, 1);
select pg_temp.swap($a$'INV-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_invoice_seq')::text, 5, '0')$a$, $b$public.next_doc_no('INVOICE')$b$, 1);
select pg_temp.swap($a$'INV-' || to_char(coalesce(p_issue, current_date), 'YYYYMM') || '-' || lpad(nextval('public.finance_invoice_seq')::text, 5, '0')$a$, $b$public.next_doc_no('INVOICE', coalesce(p_issue, current_date))$b$, 1);
select pg_temp.swap($a$'RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0')$a$, $b$public.next_doc_no('PAYMENT')$b$, 1);
select pg_temp.swap($a$'WT-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_wallet_txn_seq')::text, 5, '0')$a$, $b$public.next_doc_no('WALLET')$b$, 1);
select pg_temp.swap($a$'DP-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_deposit_seq')::text, 5, '0')$a$, $b$public.next_doc_no('DEPOSIT')$b$, 1);
select pg_temp.swap($a$'AR-RC-' || lpad(nextval('public.ar_receipt_seq')::text, 6, '0')$a$, $b$public.next_doc_no('AR_RECEIPT')$b$, 1);

do $$ declare r text; begin
  select string_agg(p.oid::regprocedure::text, ', ') into r from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ 'shop_order_seq|finance_invoice_seq|finance_receipt_seq|finance_wallet_txn_seq|finance_deposit_seq|ar_receipt_seq';
  if r is not null then raise exception 'an old numbering sequence is still used by: %', r; end if;
end $$;

-- RETIRE the old numbering: from here on only the central counters decide a document number
drop sequence if exists public.shop_order_seq, public.finance_invoice_seq, public.finance_receipt_seq, public.finance_wallet_txn_seq, public.finance_deposit_seq, public.ar_receipt_seq;
