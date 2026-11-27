-- Rolls back 20261122130000_central_receivables.sql. finance_my_invoices returns to its previous definition (verbatim, as the live database printed it), the new
-- functions, triggers, link table, columns, index and sequence go. Refuses once real use exists: a store invoice, a customer link, or a customer created with a phone
-- (that history would be lost). Afterwards delete version 20261122130000 from supabase_migrations.schema_migrations.
do $$ begin
  if exists (select 1 from public.finance_invoices where source_device is not null) then raise exception 'REFUSING: store invoices exist (central receivables are in use)'; end if;
  if exists (select 1 from public.finance_customer_links) then raise exception 'REFUSING: customer links exist (central receivables are in use)'; end if;
  if exists (select 1 from public.finance_customers where phone is not null) then raise exception 'REFUSING: customers with a phone number exist'; end if;
end $$;

CREATE OR REPLACE FUNCTION public.finance_my_invoices()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_no', i.invoice_no, 'issue_date', i.issue_date, 'due_date', i.due_date,
      'description', i.description, 'customer_name', c.name, 'source_ref', i.source_ref) || public.finance_invoice_state(i.id) order by i.issue_date desc, i.invoice_no desc), '[]'::jsonb)
  from public.finance_invoices i join public.finance_customers c on c.id = i.customer_id
  where i.customer_id = public.finance_my_customer()
$function$;

drop function public.finance_receive_payment(uuid, text, numeric, timestamptz, text, uuid, text, jsonb, text, boolean);
drop function public.finance_store_invoice_states(text, text[]);
drop function public.finance_customer_open_invoices(uuid);
drop function public.finance_issue_order_invoice(uuid, text, text, text, numeric, date, date, text);
drop function public.finance_link_customer(text, text, text, text, uuid, jsonb);
drop function public.finance_customer_links_for(text, text[]);
drop function public.finance_customer_search(text, integer);
drop function public.finance_customer_json(public.finance_customers);
drop function public.finance_customer_owing(uuid);
drop trigger finance_receipt_store_no_wallet on public.finance_receipts;
drop function public.finance_store_invoice_no_wallet();
drop trigger finance_invoices_origin_guard on public.finance_invoices;
drop function public.finance_guard_invoice_origin();
drop index public.finance_invoices_store_order_once;
alter table public.finance_invoices drop constraint finance_invoices_source_pair;
alter table public.finance_invoices drop column source_order_id;
alter table public.finance_invoices drop column source_device;
drop table public.finance_customer_links;
drop function public.finance_guard_customer_link();
drop function public.finance_norm_phone(text);
drop sequence public.finance_customer_code_seq;
drop index public.finance_customers_phone_idx;
alter table public.finance_customers drop column phone;
