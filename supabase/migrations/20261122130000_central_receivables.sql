-- Central receivables for store (back-office) credit sales. Design: docs/superpowers/specs/2026-11-22-categories-and-central-receivables-design.md §3.2 and §6.
-- Owner's decisions (2026-11-22): store credit customers are linked by staff to a central finance_customers record (choose or create, search by phone or name);
-- store credit invoices and their payments go to the accountant's ledger queue like the online shop's (the device moves the receivable out of its own books);
-- customers who use the app see their store invoices and can send a slip, but cannot pay a store invoice from the wallet.
-- Nothing that exists is rewritten except finance_my_invoices (one key added: origin). Every new write goes through SECURITY DEFINER functions with the finance roles.
--   1. finance_customers.phone (optional, normalised 0XXXXXXXXX) for staff search.
--   2. finance_customer_links: which central customer a device's local customer is (two devices give one person different local ids). Never deleted; a relink is logged.
--   3. finance_invoices.source_device / source_order_id: the store order an invoice bills; one OPEN invoice per (device, order), so a retry never bills twice
--      (after a manager cancels a wrong one, the order can be billed again). Fixed once written.
--   4. A store invoice cannot be paid from the wallet (trigger on finance_receipts).
--   5. Functions: finance_customer_search, finance_customer_links_for, finance_link_customer, finance_issue_order_invoice, finance_customer_open_invoices,
--      finance_store_invoice_states, finance_receive_payment (one payment over several invoices of ONE customer, through finance_record_payment, optionally posted at once).
-- Rollback: supabase/rollbacks/20261122130000_central_receivables_down.sql

-- 1 ------------------------------------------------------------------------------------------------------------------------------------------------------
alter table public.finance_customers add column if not exists phone text check (phone is null or phone ~ '^0[0-9]{8,9}$');
create index if not exists finance_customers_phone_idx on public.finance_customers (phone) where phone is not null;
create sequence if not exists public.finance_customer_code_seq;

-- digits only; +66 / 66 becomes 0; null when nothing usable is left
create or replace function public.finance_norm_phone(p text) returns text language sql immutable set search_path = public as $$
  select case when d = '' then null when d ~ '^66[0-9]{8,9}$' then '0' || substr(d, 3) else d end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x
$$;

-- 2 ------------------------------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.finance_customer_links (
  id uuid primary key default gen_random_uuid(),
  device_id text not null check (length(device_id) between 4 and 80),
  local_customer_id text not null check (length(local_customer_id) between 1 and 80),
  local_code text check (local_code is null or length(local_code) <= 40),
  local_name text check (local_name is null or length(local_name) <= 200),
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  linked_by uuid default auth.uid(),
  linked_at timestamptz not null default now(),
  unique (device_id, local_customer_id)
);
create index if not exists finance_customer_links_customer_idx on public.finance_customer_links (customer_id);
alter table public.finance_customer_links enable row level security;
revoke all on public.finance_customer_links from public, anon, authenticated;

create or replace function public.finance_guard_customer_link() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'A customer link is never deleted (link it to the right customer instead)'; end if;
  if new.device_id is distinct from old.device_id or new.local_customer_id is distinct from old.local_customer_id then
    raise exception 'The device and local customer of a link cannot be changed'; end if;
  return new;
end $$;
create trigger finance_customer_links_guard before update or delete on public.finance_customer_links for each row execute function public.finance_guard_customer_link();

-- 3 ------------------------------------------------------------------------------------------------------------------------------------------------------
alter table public.finance_invoices add column if not exists source_device text check (source_device is null or length(source_device) between 4 and 80);
alter table public.finance_invoices add column if not exists source_order_id text check (source_order_id is null or length(source_order_id) between 1 and 80);
alter table public.finance_invoices add constraint finance_invoices_source_pair check ((source_device is null) = (source_order_id is null));
create unique index if not exists finance_invoices_store_order_once on public.finance_invoices (source_device, source_order_id) where source_device is not null and status = 'open';

create or replace function public.finance_guard_invoice_origin() returns trigger language plpgsql set search_path = public as $$
begin
  if new.source_device is distinct from old.source_device or new.source_order_id is distinct from old.source_order_id then
    raise exception 'The store order an invoice bills cannot be changed'; end if;
  return new;
end $$;
create trigger finance_invoices_origin_guard before update of source_device, source_order_id on public.finance_invoices for each row execute function public.finance_guard_invoice_origin();

-- 4 ------------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.finance_store_invoice_no_wallet() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.wallet_txn_id is not null and exists (select 1 from public.finance_invoices i where i.id = new.invoice_id and i.source_device is not null) then
    raise exception 'STORE_INVOICE_NO_WALLET: a store invoice is paid at the store or by bank transfer, not from the wallet' using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function public.finance_store_invoice_no_wallet() from public, anon, authenticated;
create trigger finance_receipt_store_no_wallet before insert on public.finance_receipts for each row execute function public.finance_store_invoice_no_wallet();

-- 5 ------------------------------------------------------------------------------------------------------------------------------------------------------
-- what a customer owes over all open invoices (posted payments only) and how much is confirmed but not posted yet
create or replace function public.finance_customer_owing(p_customer uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('open_count', count(*) filter (where s.outstanding > 0), 'outstanding', coalesce(sum(s.outstanding), 0), 'confirmed_pending', coalesce(sum(s.pending), 0))
  from (select greatest(i.amount - coalesce((select sum(a.amount) from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id
                                               where a.invoice_id = i.id and a.active and r.status = 'posted'), 0), 0) as outstanding,
               coalesce((select sum(e.confirmed_amount) from public.finance_payment_evidence e where e.invoice_id = i.id and e.status = 'confirmed'), 0) as pending
          from public.finance_invoices i where i.customer_id = p_customer and i.status = 'open') s
$$;
revoke all on function public.finance_customer_owing(uuid) from public, anon, authenticated;

create or replace function public.finance_customer_json(c public.finance_customers) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'phone', coalesce(c.phone, public.finance_norm_phone(p.phone)), 'tax_id', c.tax_id,
                            'has_app', c.profile_id is not null) || public.finance_customer_owing(c.id)
  from (select 1) one left join public.profiles p on p.id = c.profile_id
$$;
revoke all on function public.finance_customer_json(public.finance_customers) from public, anon, authenticated;

-- staff search by name, code or phone (the customer's own phone or the phone of their app account)
create or replace function public.finance_customer_search(p_q text, p_limit integer default 20) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := btrim(coalesce(p_q, '')); v_ph text := public.finance_norm_phone(p_q); v_lim integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  perform public.finance_require('invoice', 'search customers');
  if length(v_q) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(public.finance_customer_json(c) order by c.name, c.code) from (
      select c.* from public.finance_customers c left join public.profiles p on p.id = c.profile_id
       where c.name ilike '%' || v_q || '%' or c.code ilike '%' || v_q || '%'
          or (v_ph is not null and length(v_ph) >= 3 and (c.phone like '%' || v_ph || '%' or public.finance_norm_phone(p.phone) like '%' || v_ph || '%'))
       order by c.name, c.code limit v_lim) c), '[]'::jsonb);
end $$;

-- the central customers already linked to these local customers of one device: {local_id: customer}
create or replace function public.finance_customer_links_for(p_device text, p_local_ids text[]) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see customer links');
  return coalesce((select jsonb_object_agg(l.local_customer_id, public.finance_customer_json(c))
                     from public.finance_customer_links l join public.finance_customers c on c.id = l.customer_id
                    where l.device_id = p_device and l.local_customer_id = any (coalesce(p_local_ids, '{}'))), '{}'::jsonb);
end $$;

-- link a device's local customer to a central customer: an existing one (p_customer) or a new one (p_new {name, phone, tax_id, address}). A phone that already
-- belongs to another central customer is refused with that customer named, so a duplicate is a person's decision, never a guess.
create or replace function public.finance_link_customer(p_device text, p_local_id text, p_local_code text, p_local_name text, p_customer uuid, p_new jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.finance_customers; v_old uuid; v_name text; v_phone text; v_tax text; v_code text; v_other public.finance_customers;
begin
  perform public.finance_require('invoice', 'link customers');
  if p_device is null or length(btrim(p_device)) < 4 or length(p_device) > 80 then raise exception 'INVALID_DEVICE'; end if;
  if p_local_id is null or length(btrim(p_local_id)) = 0 or length(p_local_id) > 80 then raise exception 'INVALID_LOCAL_CUSTOMER'; end if;
  if (p_customer is null) = (p_new is null) then raise exception 'CHOOSE_ONE: choose an existing customer or enter a new one'; end if;
  if p_customer is not null then
    select * into c from public.finance_customers where id = p_customer;
    if not found then raise exception 'NOT_FOUND: customer'; end if;
  else
    v_name := btrim(coalesce(p_new ->> 'name', ''));
    if length(v_name) < 1 or length(v_name) > 200 then raise exception 'NAME_REQUIRED: enter the customer''s name'; end if;
    v_phone := public.finance_norm_phone(p_new ->> 'phone');
    if v_phone is not null and v_phone !~ '^0[0-9]{8,9}$' then raise exception 'INVALID_PHONE: enter a Thai phone number (9 or 10 digits)'; end if;
    v_tax := nullif(regexp_replace(coalesce(p_new ->> 'tax_id', ''), '[^0-9]', '', 'g'), '');
    if v_tax is not null and v_tax !~ '^[0-9]{13}$' then raise exception 'INVALID_TAX_ID: a tax id has 13 digits'; end if;
    if v_phone is not null then
      select c2.* into v_other from public.finance_customers c2 left join public.profiles p on p.id = c2.profile_id
       where c2.phone = v_phone or public.finance_norm_phone(p.phone) = v_phone limit 1;
      if found then raise exception 'PHONE_TAKEN: % (%) already has this phone number; choose that customer instead', v_other.name, v_other.code using errcode = '23505'; end if;
    end if;
    loop
      v_code := 'ST' || lpad(nextval('public.finance_customer_code_seq')::text, 5, '0');
      exit when not exists (select 1 from public.finance_customers where code = v_code);
    end loop;
    insert into public.finance_customers (code, name, tax_id, billing_address, phone, local_customer_id)
      values (v_code, v_name, v_tax, nullif(btrim(left(coalesce(p_new ->> 'address', ''), 500)), ''), v_phone, left(p_local_id, 80))
      returning * into c;
    perform public.finance_log('customer', c.id, 'customer.create', jsonb_build_object('code', c.code, 'name', c.name, 'phone', c.phone, 'from_device', p_device, 'local_id', p_local_id));
  end if;
  select customer_id into v_old from public.finance_customer_links where device_id = p_device and local_customer_id = p_local_id for update;
  if found then
    update public.finance_customer_links set customer_id = c.id, local_code = left(p_local_code, 40), local_name = left(p_local_name, 200), linked_by = auth.uid(), linked_at = now()
      where device_id = p_device and local_customer_id = p_local_id;
  else
    insert into public.finance_customer_links (device_id, local_customer_id, local_code, local_name, customer_id)
      values (p_device, p_local_id, left(p_local_code, 40), left(p_local_name, 200), c.id);
  end if;
  if v_old is distinct from c.id then
    perform public.finance_log('customer', c.id, case when v_old is null then 'customer.link' else 'customer.relink' end,
      jsonb_build_object('device', p_device, 'local_id', p_local_id, 'local_name', p_local_name, 'previous_customer', v_old));
  end if;
  return public.finance_customer_json(c);
end $$;

-- the central invoice for the unpaid part of a store credit sale. One open invoice per (device, order): a retry with the same customer and amount returns it.
create or replace function public.finance_issue_order_invoice(p_customer uuid, p_device text, p_order_id text, p_order_no text, p_amount numeric,
  p_issue date default null, p_due date default null, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices; v_issue date := coalesce(p_issue, current_date); v_due date := coalesce(p_due, coalesce(p_issue, current_date));
begin
  perform public.finance_require('invoice', 'issue invoices');
  if p_device is null or length(btrim(p_device)) < 4 or length(p_device) > 80 then raise exception 'INVALID_DEVICE'; end if;
  if p_order_id is null or length(btrim(p_order_id)) = 0 or length(p_order_id) > 80 then raise exception 'INVALID_ORDER'; end if;
  if p_order_no is null or length(btrim(p_order_no)) = 0 or length(p_order_no) > 80 then raise exception 'INVALID_ORDER'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT: enter the amount in baht and satang'; end if;
  if v_due < v_issue then raise exception 'INVALID_DUE_DATE: the due date is before the issue date'; end if;
  if v_issue > current_date + 1 then raise exception 'INVALID_ISSUE_DATE: the issue date is in the future'; end if;
  if not exists (select 1 from public.finance_customers where id = p_customer) then raise exception 'NOT_FOUND: customer'; end if;
  perform pg_advisory_xact_lock(hashtext('finance_issue_order_invoice'), hashtext(p_device || ':' || p_order_id));
  select * into i from public.finance_invoices where source_device = p_device and source_order_id = p_order_id and status = 'open';
  if found then
    if i.customer_id <> p_customer or i.amount <> p_amount then
      raise exception 'ORDER_ALREADY_INVOICED: order % already has invoice % for % (another customer or amount)', p_order_no, i.invoice_no, i.amount using errcode = '23505'; end if;
    return jsonb_build_object('invoice', to_jsonb(i), 'replay', true);
  end if;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount, description, source_ref, source_device, source_order_id)
    values (public.next_doc_no('INVOICE', v_issue), p_customer, v_issue, v_due, p_amount,
            coalesce(nullif(btrim(left(p_description, 500)), ''), 'Store sale ' || btrim(p_order_no)), left(btrim(p_order_no), 80), p_device, p_order_id)
    returning * into i;
  perform public.finance_log('invoice', i.id, 'invoice.issue', jsonb_build_object('no', i.invoice_no, 'amount', i.amount, 'customer', i.customer_id, 'store_order', p_order_no, 'device', p_device));
  return jsonb_build_object('invoice', to_jsonb(i), 'replay', false);
end $$;

-- one customer's open invoices from every device and the online shop, with what the server says is still owed
create or replace function public.finance_customer_open_invoices(p_customer uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.finance_customers;
begin
  perform public.finance_require('view', 'see a customer''s invoices');
  select * into c from public.finance_customers where id = p_customer;
  if not found then raise exception 'NOT_FOUND: customer'; end if;
  return jsonb_build_object('customer', public.finance_customer_json(c),
    'invoices', coalesce((select jsonb_agg(x order by x ->> 'issue_date', x ->> 'invoice_no') from (
        select jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'issue_date', i.issue_date, 'due_date', i.due_date, 'amount', i.amount,
                 'description', i.description, 'source_ref', i.source_ref, 'origin', case when i.source_device is not null then 'store' when i.source_ref is not null then 'shop' else 'manual' end,
                 'outstanding', (s ->> 'outstanding')::numeric, 'confirmed_pending', (s ->> 'confirmed_pending')::numeric,
                 'available', greatest((s ->> 'outstanding')::numeric - (s ->> 'confirmed_pending')::numeric, 0), 'status', s ->> 'status') as x
          from public.finance_invoices i cross join lateral (select public.finance_invoice_state_raw(i.id) as s) st
         where i.customer_id = p_customer and i.status = 'open' and (s ->> 'outstanding')::numeric > 0) q), '[]'::jsonb));
end $$;

-- what a device's store invoices still owe, so the device shows the right balance and credit limit for orders it sent to the central ledger
create or replace function public.finance_store_invoice_states(p_device text, p_order_ids text[] default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see store invoices');
  return coalesce((select jsonb_agg(jsonb_build_object('order_id', i.source_order_id, 'invoice_id', i.id, 'invoice_no', i.invoice_no, 'customer_id', i.customer_id,
                       'amount', i.amount, 'status', i.status, 'outstanding', (s ->> 'outstanding')::numeric, 'confirmed_pending', (s ->> 'confirmed_pending')::numeric))
                     from public.finance_invoices i cross join lateral (select public.finance_invoice_state_raw(i.id) as s) st
                    where i.source_device = p_device and (p_order_ids is null or i.source_order_id = any (p_order_ids))), '[]'::jsonb);
end $$;

-- one payment of ONE customer over one or several of their invoices (p_allocations [{invoice, amount}], summing to p_amount): each part goes through
-- finance_record_payment (same checks, same end-of-day posting) with the request key + part number, so a retry replays every part and records nothing twice.
-- A transfer over several invoices keeps the bank reference on the first part and marks the others "(part k of n)", because one bank reference is accepted once.
-- p_post: post at once (cash needs a manager, as in finance_post_evidence). Invoices are locked in a fixed order, so two payments never deadlock.
create or replace function public.finance_receive_payment(p_customer uuid, p_method text, p_amount numeric, p_received_at timestamptz, p_ref text, p_bank_account uuid,
  p_note text, p_allocations jsonb, p_key text, p_post boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_key text := nullif(btrim(coalesce(p_key, '')), ''); v_n integer; v_k integer := 0; v_sum numeric := 0; a record; r jsonb; v_parts jsonb := '[]'::jsonb;
        v_ref text; v_posted jsonb := '[]'::jsonb; v_inv public.finance_invoices; v_replay boolean := true;
begin
  perform public.finance_require('verify', 'record payments');
  if v_key is null or length(v_key) < 8 or length(v_key) > 72 then raise exception 'INVALID_KEY: the request key must be 8 to 72 characters'; end if;
  if not exists (select 1 from public.finance_customers where id = p_customer) then raise exception 'NOT_FOUND: customer'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT: enter the amount in baht and satang'; end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then raise exception 'ALLOCATION_REQUIRED: choose the invoices this payment is for'; end if;
  if jsonb_array_length(p_allocations) > 50 then raise exception 'TOO_MANY_INVOICES: 50 invoices at most in one payment'; end if;
  v_n := jsonb_array_length(p_allocations);
  if (select count(distinct x ->> 'invoice') from jsonb_array_elements(p_allocations) x) <> v_n then raise exception 'DUPLICATE_INVOICE: an invoice appears twice'; end if;
  for a in select (x ->> 'invoice')::uuid as invoice, (x ->> 'amount')::numeric as amount from jsonb_array_elements(p_allocations) x loop
    if a.invoice is null then raise exception 'ALLOCATION_REQUIRED: an invoice is missing'; end if;
    if a.amount is null or a.amount <= 0 or a.amount <> round(a.amount, 2) then raise exception 'INVALID_AMOUNT: every part must be a positive amount in baht and satang'; end if;
    v_sum := v_sum + a.amount;
  end loop;
  if v_sum <> p_amount then raise exception 'ALLOCATION_MISMATCH: the parts add up to % but the payment is %', v_sum, p_amount; end if;
  if p_method = 'transfer' and v_n > 1 and length(btrim(coalesce(p_ref, ''))) > 60 then raise exception 'REFERENCE_TOO_LONG: 60 characters at most when one transfer pays several invoices'; end if;
  for a in select (x ->> 'invoice')::uuid as invoice, (x ->> 'amount')::numeric as amount from jsonb_array_elements(p_allocations) x order by (x ->> 'invoice')::uuid loop
    v_k := v_k + 1;
    select * into v_inv from public.finance_invoices where id = a.invoice;
    if not found then raise exception 'NOT_FOUND: invoice'; end if;
    if v_inv.customer_id <> p_customer then raise exception 'CUSTOMER_MISMATCH: invoice % belongs to another customer', v_inv.invoice_no using errcode = '23514'; end if;
    v_ref := case when p_method = 'transfer' and v_k > 1 then btrim(p_ref) || ' (part ' || v_k || ' of ' || v_n || ')' else p_ref end;
    r := public.finance_record_payment(a.invoice, p_method, a.amount, p_received_at, v_ref, p_bank_account, p_note, null, null, null, v_key || ':' || v_k);
    v_replay := v_replay and coalesce((r ->> 'replay')::boolean, false);
    v_parts := v_parts || jsonb_build_array(r || jsonb_build_object('invoice_id', a.invoice, 'invoice_no', v_inv.invoice_no, 'amount', a.amount));
  end loop;
  if p_post then
    for r in select x from jsonb_array_elements(v_parts) x loop
      v_posted := v_posted || jsonb_build_array(public.finance_post_evidence((r ->> 'evidence_id')::uuid, p_note) || jsonb_build_object('evidence_id', r ->> 'evidence_id'));
    end loop;
  end if;
  if not v_replay then
    perform public.finance_log('customer', p_customer, 'payment.receive', jsonb_build_object('method', p_method, 'amount', p_amount, 'parts', v_n, 'post', coalesce(p_post, false),
      'evidence', (select jsonb_agg(x ->> 'evidence_id') from jsonb_array_elements(v_parts) x)));
  end if;
  return jsonb_build_object('customer_id', p_customer, 'replay', v_replay, 'parts', v_parts, 'posted', v_posted, 'owing', public.finance_customer_owing(p_customer));
end $$;

-- the customer's own invoices: unchanged except the "origin" key, so the app offers no wallet payment on a store invoice
create or replace function public.finance_my_invoices()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'issue_date', i.issue_date, 'due_date', i.due_date,
      'description', i.description, 'customer_name', c.name, 'source_ref', i.source_ref, 'origin', case when i.source_device is not null then 'store' else 'shop' end) || public.finance_invoice_state(i.id) order by i.issue_date desc, i.invoice_no desc), '[]'::jsonb)
  from public.finance_invoices i join public.finance_customers c on c.id = i.customer_id
  where i.customer_id = public.finance_my_customer()
$function$;

revoke all on function public.finance_norm_phone(text) from public, anon;
grant execute on function public.finance_norm_phone(text) to authenticated;
revoke all on function public.finance_customer_search(text, integer) from public, anon;
grant execute on function public.finance_customer_search(text, integer) to authenticated;
revoke all on function public.finance_customer_links_for(text, text[]) from public, anon;
grant execute on function public.finance_customer_links_for(text, text[]) to authenticated;
revoke all on function public.finance_link_customer(text, text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.finance_link_customer(text, text, text, text, uuid, jsonb) to authenticated;
revoke all on function public.finance_issue_order_invoice(uuid, text, text, text, numeric, date, date, text) from public, anon;
grant execute on function public.finance_issue_order_invoice(uuid, text, text, text, numeric, date, date, text) to authenticated;
revoke all on function public.finance_customer_open_invoices(uuid) from public, anon;
grant execute on function public.finance_customer_open_invoices(uuid) to authenticated;
revoke all on function public.finance_store_invoice_states(text, text[]) from public, anon;
grant execute on function public.finance_store_invoice_states(text, text[]) to authenticated;
revoke all on function public.finance_receive_payment(uuid, text, numeric, timestamptz, text, uuid, text, jsonb, text, boolean) from public, anon;
grant execute on function public.finance_receive_payment(uuid, text, numeric, timestamptz, text, uuid, text, jsonb, text, boolean) to authenticated;
