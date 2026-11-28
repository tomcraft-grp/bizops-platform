-- Rollback of 20261128160000_expense_bank_posting.sql. Restores the daily-expense functions exactly as 20261114210000_daily_expenses.sql defined them,
-- the old ledger-queue event list and constraints, and removes the bank ledger, the product categories and the new claim columns.
-- It REFUSES once anything was recorded the new way (a claim with a product, a bank account or a queued journal, a bank movement, an expense queue row,
-- or a claim in a product category): those are financial records and are never thrown away. Reverse them first, then decide.
do $$
declare n_claims int; n_bank int; n_queue int; n_cat int;
begin
  select count(*) into n_claims from public.expense_claims where sku_code is not null or bank_account_id is not null or gl_queue_id is not null or bank_txn_id is not null;
  select count(*) into n_bank from public.finance_bank_transactions;
  select count(*) into n_queue from public.finance_gl_queue where event_type in ('EXPENSE_PAYMENT', 'EXPENSE_REVERSAL');
  select count(*) into n_cat from public.expense_claims c join public.expense_categories k on k.id = c.category_id where k.code in ('stock_materials', 'stock_goods');
  if n_claims + n_bank + n_queue + n_cat > 0 then
    raise exception 'REFUSING: % claims use a product / bank account / queued journal, % bank movements, % expense ledger rows, % claims in product categories exist', n_claims, n_bank, n_queue, n_cat;
  end if;
end $$;

-- functions that only the migration added
drop function public.expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text, text, uuid);
drop function public.expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text);
drop function public.expense_save_core(uuid, date, uuid, text, numeric, text, text, text, text, text, text, text, uuid, boolean);
drop function public.expense_bank_options();
drop function public.expense_product_options();
drop function public.expense_category_for_class(text);
drop function public.expense_mark_reviewed(uuid[], text);
drop function public.expense_post_preview(uuid[]);
drop function public.expense_post_bulk(uuid[], text);
drop function public.expense_post_one(uuid);
drop function public.expense_post_problem(public.expense_claims);
drop function public.expense_reverse(uuid, text);
drop function public.expense_claim_links(uuid);
drop function public.finance_bank_reconcile();
drop function public.finance_bank_overview();
drop function public.finance_bank_ledger(uuid, integer, integer);
drop function public.finance_bank_opening(uuid, numeric, date, text);
drop function public.finance_bank_adjust(uuid, text, numeric, text, text);
drop function public.finance_bank_apply(uuid, text, text, numeric, date, text, uuid, text, text, uuid, uuid, text);

-- the claim columns, then the bank ledger
alter table public.expense_claims drop constraint expense_claims_bank_txn_fk;
drop index public.expense_claims_bank_idx;
drop index public.expense_claims_sku_idx;
alter table public.expense_claims drop constraint expense_posted_has_ref;
alter table public.expense_claims drop column sku_code, drop column bank_account_id, drop column gl_queue_id, drop column bank_txn_id;
alter table public.expense_claims add constraint expense_posted_has_ref check (status <> 'posted' or (posted_ref is not null and journal_no is not null and posted_at is not null and posting_date is not null));
alter table public.expense_claims drop constraint expense_claims_treatment_check;
alter table public.expense_claims add constraint expense_claims_treatment_check check (treatment in ('expense', 'fixed_asset'));

drop table public.finance_bank_balances;
drop table public.finance_bank_transactions;
drop function public.finance_bank_balance_guard();
drop function public.finance_bank_txn_immutable();
drop function public.finance_bank_can_view();
drop sequence public.finance_bank_txn_seq;

alter table public.finance_gl_queue drop column detail;
alter table public.finance_gl_queue drop constraint finance_gl_queue_event_type_chk;
alter table public.finance_gl_queue add constraint finance_gl_queue_event_type_chk
  check (event_type in ('INVOICE_ISSUE', 'INVOICE_CANCEL', 'BANK_RECEIPT', 'RECEIPT_REAPPLY', 'RECEIPT_REVERSAL', 'WALLET_DEPOSIT', 'WALLET_PAYMENT',
                        'WALLET_REFUND', 'WALLET_ADJUSTMENT', 'WALLET_REVERSAL', 'CASH_RECEIPT'));

-- the product categories (unused: checked above). Their audit rows, if any, stay (append-only, they hold no reference).
delete from public.expense_categories where code in ('stock_materials', 'stock_goods');
drop index public.expense_categories_product_class;
alter table public.expense_categories drop constraint expense_categories_inventory_role;
alter table public.expense_categories drop column posting_role, drop column product_class;
alter table public.expense_categories drop constraint expense_categories_treatment_check;
alter table public.expense_categories add constraint expense_categories_treatment_check check (treatment in ('expense', 'fixed_asset'));

-- the functions the migration replaced, exactly as 20261114210000_daily_expenses.sql defined them
create or replace function public.expense_can(p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(case p_cap
    when 'create'       then public.expense_role() in ('employee', 'manager', 'accountant', 'admin')
    when 'view_all'     then public.expense_role() in ('manager', 'accountant', 'admin')
    when 'approve'      then public.expense_role() in ('manager', 'admin')
    when 'post'         then public.expense_role() in ('accountant', 'admin')
    when 'config'       then public.expense_role() in ('accountant', 'admin')
    when 'manage_roles' then public.expense_role() = 'admin'
    else false end, false)
$$;

create or replace function public.expense_claims_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Expenses are never deleted; cancel them (a posted expense is reversed first)' using errcode = '23001'; end if;
  if new.status is distinct from old.status and not ((old.status, new.status) in (
       ('draft', 'submitted'), ('draft', 'cancelled'), ('submitted', 'approved'), ('submitted', 'rejected'), ('submitted', 'cancelled'),
       ('rejected', 'draft'), ('rejected', 'submitted'), ('rejected', 'cancelled'), ('approved', 'posted'), ('approved', 'rejected'),
       ('approved', 'cancelled'), ('posted', 'cancelled'))) then
    raise exception 'An expense cannot go from % to %', old.status, new.status using errcode = '23001';
  end if;
  if old.status in ('posted', 'cancelled') and (new.amount_paid, new.vat_amount, new.wht_amount, new.tax_type, new.treatment, new.account_override, new.expense_date,
       new.category_id, new.posting_date, new.journal_no, new.posted_ref, new.created_by) is distinct from
       (old.amount_paid, old.vat_amount, old.wht_amount, old.tax_type, old.treatment, old.account_override, old.expense_date,
       old.category_id, old.posting_date, old.journal_no, old.posted_ref, old.created_by) then
    raise exception 'A posted or cancelled expense cannot be changed' using errcode = '23001';
  end if;
  if old.posted_ref is not null and new.posted_ref is distinct from old.posted_ref then raise exception 'The ledger reference of a posted expense cannot change' using errcode = '23001'; end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.expense_save(
  p_id uuid, p_expense_date date, p_category uuid, p_description text, p_amount numeric, p_tax_type text,
  p_payment_method text, p_vendor text, p_vendor_tax_id text, p_reference_no text, p_notes text)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cat public.expense_categories;
  st public.expense_settings;
  cl public.expense_claims;
  v_paid numeric; v_vat numeric; v_rate numeric;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform public.expense_require('create', 'record expenses');
  select * into cat from public.expense_categories where id = p_category;
  if not found or not cat.active then raise exception 'Choose an active expense category'; end if;
  if p_expense_date is null or p_expense_date > v_today then raise exception 'The expense date cannot be in the future'; end if;
  if nullif(btrim(coalesce(p_description, '')), '') is null then raise exception 'Describe what the money was spent on'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 99999999 then raise exception 'Enter an amount greater than zero'; end if;
  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer', 'qr', 'card') then raise exception 'Choose how it was paid'; end if;
  if p_tax_type is null or p_tax_type not in ('none', 'vat_included', 'vat_excluded', 'vat_noncreditable') then raise exception 'Choose the tax type'; end if;
  select * into st from public.expense_settings where id = 1;
  if p_tax_type <> 'none' and not st.vat_registered then raise exception 'VAT is not enabled for this business: choose “No VAT”'; end if;
  v_rate := case when p_tax_type = 'none' then 0 else st.vat_rate end;
  select c.paid, c.vat into v_paid, v_vat from public.expense_calc(p_amount, p_tax_type, v_rate) c;

  if p_id is null then
    insert into public.expense_claims (created_by, created_by_name, expense_date, payment_date, category_id, description, vendor, vendor_tax_id, reference_no, notes,
        payment_method, paid_from, tax_type, vat_rate, amount_paid, vat_amount, treatment)
    values (me, public.expense_actor_name(), p_expense_date, p_expense_date, p_category, btrim(p_description), nullif(btrim(coalesce(p_vendor, '')), ''), nullif(btrim(coalesce(p_vendor_tax_id, '')), ''),
        nullif(btrim(coalesce(p_reference_no, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
        p_payment_method, case p_payment_method when 'cash' then 'cash' else 'bank' end, p_tax_type, v_rate, v_paid, v_vat, cat.treatment)
    returning * into cl;
    perform public.expense_log('expense', cl.id::text, cl.id, 'created', null, 'draft', null, jsonb_build_object('amount_paid', v_paid, 'category', cat.code));
  else
    select * into cl from public.expense_claims where id = p_id for update;
    if not found then raise exception 'Expense not found'; end if;
    if cl.created_by <> me then raise exception 'You can only edit your own expenses' using errcode = '42501'; end if;
    if cl.status not in ('draft', 'rejected') then raise exception 'Only drafts and rejected expenses can be edited (this one is %)', cl.status; end if;
    update public.expense_claims set expense_date = p_expense_date, payment_date = p_expense_date, category_id = p_category, description = btrim(p_description),
        vendor = nullif(btrim(coalesce(p_vendor, '')), ''), vendor_tax_id = nullif(btrim(coalesce(p_vendor_tax_id, '')), ''),
        reference_no = nullif(btrim(coalesce(p_reference_no, '')), ''), notes = nullif(btrim(coalesce(p_notes, '')), ''),
        payment_method = p_payment_method, paid_from = case p_payment_method when 'cash' then 'cash' else 'bank' end,
        tax_type = p_tax_type, vat_rate = v_rate, amount_paid = v_paid, vat_amount = v_vat, wht_rate = 0, wht_amount = 0, treatment = cat.treatment, account_override = null,
        status = 'draft'
      where id = p_id returning * into cl;
    perform public.expense_log('expense', cl.id::text, cl.id, 'edited', null, cl.status, null, jsonb_build_object('amount_paid', v_paid, 'category', cat.code));
  end if;
  return cl;
end $$;

create or replace function public.expense_reject(p_id uuid, p_reason text)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; old_status text;
begin
  if not (public.expense_can('approve') or public.expense_can('post')) then raise exception 'You are not allowed to reject expenses' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required'; end if;
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status = 'submitted' and not public.expense_can('approve') then raise exception 'Only a manager can reject a submitted expense' using errcode = '42501'; end if;
  if cl.status = 'approved' and not public.expense_can('post') then raise exception 'Only an accountant can send an approved expense back' using errcode = '42501'; end if;
  if cl.status not in ('submitted', 'approved') then raise exception 'Only submitted or approved expenses can be rejected (this one is %)', cl.status; end if;
  old_status := cl.status;
  update public.expense_claims set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), reject_reason = btrim(p_reason),
      approved_by = null, approved_at = null, approval_note = null, reviewed_by = null, reviewed_at = null, review_note = null where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'rejected', old_status, 'rejected', p_reason, null);
  return cl;
end $$;

create or replace function public.expense_review(
  p_id uuid, p_tax_type text, p_vat_amount numeric, p_wht_rate numeric, p_treatment text, p_account_override text, p_branch text, p_note text default null)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; st public.expense_settings; v_vat numeric; v_rate numeric; v_wht numeric;
begin
  perform public.expense_require('post', 'review expenses for posting');
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status <> 'approved' then raise exception 'Only approved expenses can be reviewed (this one is %)', cl.status; end if;
  if p_tax_type is null or p_tax_type not in ('none', 'vat_included', 'vat_excluded', 'vat_noncreditable') then raise exception 'Choose the tax type'; end if;
  if p_treatment is null or p_treatment not in ('expense', 'fixed_asset') then raise exception 'Choose the accounting treatment'; end if;
  select * into st from public.expense_settings where id = 1;
  if p_tax_type <> 'none' and not st.vat_registered then raise exception 'VAT is not enabled for this business'; end if;
  v_vat := case when p_tax_type = 'none' then 0 else round(coalesce(p_vat_amount, 0), 2) end;
  if v_vat < 0 or v_vat >= cl.amount_paid then raise exception 'VAT must be at least 0 and less than the amount paid'; end if;
  v_rate := round(coalesce(p_wht_rate, 0), 2);
  if v_rate < 0 or v_rate > 15 then raise exception 'Withholding tax rate must be between 0 and 15 percent'; end if;
  v_wht := round((cl.amount_paid - v_vat) * v_rate / 100, 2);
  update public.expense_claims set tax_type = p_tax_type, vat_amount = v_vat, vat_rate = case when p_tax_type = 'none' then 0 else st.vat_rate end,
      wht_rate = v_rate, wht_amount = v_wht, treatment = p_treatment, account_override = nullif(btrim(coalesce(p_account_override, '')), ''),
      branch_id = nullif(btrim(coalesce(p_branch, '')), ''), reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'reviewed', 'approved', 'approved', p_note,
    jsonb_build_object('tax_type', p_tax_type, 'vat', v_vat, 'wht_rate', v_rate, 'wht', v_wht, 'treatment', p_treatment, 'account_override', p_account_override));
  return cl;
end $$;

create or replace function public.expense_mark_reversed(p_id uuid, p_reversal_journal_no text, p_reason text)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims;
begin
  perform public.expense_require('post', 'reverse expenses');
  if nullif(btrim(coalesce(p_reason, '')), '') is null or nullif(btrim(coalesce(p_reversal_journal_no, '')), '') is null then raise exception 'The reversal journal and a reason are required'; end if;
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status <> 'posted' then raise exception 'Only posted expenses can be reversed (this one is %)', cl.status; end if;
  update public.expense_claims set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason), reversal_journal_no = p_reversal_journal_no
    where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'reversed', 'posted', 'cancelled', p_reason, jsonb_build_object('reversal_journal_no', p_reversal_journal_no, 'journal_no', cl.journal_no));
  return cl;
end $$;

create or replace function public.expense_category_save(
  p_id uuid, p_code text, p_name_en text, p_name_th text, p_icon text, p_sort integer, p_treatment text, p_account_code text,
  p_default_tax_type text, p_default_wht_rate numeric, p_hint_en text, p_hint_th text, p_active boolean)
returns public.expense_categories language plpgsql security definer set search_path = public as $$
declare c public.expense_categories;
begin
  perform public.expense_require('config', 'change expense categories');
  if p_id is null then
    insert into public.expense_categories (code, name_en, name_th, icon, sort, treatment, account_code, default_tax_type, default_wht_rate, hint_en, hint_th, active, updated_by)
    values (p_code, btrim(p_name_en), btrim(p_name_th), coalesce(p_icon, 'receipt'), coalesce(p_sort, 100), coalesce(p_treatment, 'expense'), nullif(btrim(coalesce(p_account_code, '')), ''),
            coalesce(p_default_tax_type, 'none'), p_default_wht_rate, nullif(btrim(coalesce(p_hint_en, '')), ''), nullif(btrim(coalesce(p_hint_th, '')), ''), coalesce(p_active, true), auth.uid())
    returning * into c;
  else
    update public.expense_categories set name_en = btrim(p_name_en), name_th = btrim(p_name_th), icon = coalesce(p_icon, icon), sort = coalesce(p_sort, sort),
        treatment = coalesce(p_treatment, treatment), account_code = nullif(btrim(coalesce(p_account_code, '')), ''), default_tax_type = coalesce(p_default_tax_type, default_tax_type),
        default_wht_rate = p_default_wht_rate, hint_en = nullif(btrim(coalesce(p_hint_en, '')), ''), hint_th = nullif(btrim(coalesce(p_hint_th, '')), ''),
        active = coalesce(p_active, active), updated_by = auth.uid(), updated_at = now()
      where id = p_id returning * into c;
    if not found then raise exception 'Category not found'; end if;
  end if;
  perform public.expense_log('category', c.id::text, null, case when p_id is null then 'category.created' else 'category.updated' end, null, null, null,
    jsonb_build_object('code', c.code, 'account_code', c.account_code, 'treatment', c.treatment, 'active', c.active, 'default_wht_rate', c.default_wht_rate));
  return c;
end $$;

create or replace function public.expense_dashboard(
  p_from date default null, p_to date default null, p_status text default null, p_category uuid default null, p_method text default null, p_employee uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid(); v_all boolean := public.expense_can('view_all');
  v_today date := (now() at time zone 'Asia/Bangkok')::date; v_month date := date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date; res jsonb;
begin
  if public.expense_role() is null then raise exception 'You are not allowed to see expenses' using errcode = '42501'; end if;
  with base as (
    select c.* from public.expense_claims c
     where (v_all or c.created_by = me) and (p_employee is null or c.created_by = p_employee)
       and (p_category is null or c.category_id = p_category) and (p_method is null or c.payment_method = p_method)
  ), ranged as (
    select * from base where (p_from is null or expense_date >= p_from) and (p_to is null or expense_date <= p_to) and (p_status is null or status = p_status)
  ), counted as (select * from ranged where status in ('submitted', 'approved', 'posted'))
  select jsonb_build_object(
    'today_total', (select coalesce(sum(amount_paid), 0) from base where status in ('submitted', 'approved', 'posted') and expense_date = v_today),
    'month_total', (select coalesce(sum(amount_paid), 0) from base where status in ('submitted', 'approved', 'posted') and expense_date >= v_month and expense_date <= v_today),
    'range_total', (select coalesce(sum(amount_paid), 0) from counted),
    'by_status',   (select coalesce(jsonb_object_agg(status, jsonb_build_object('n', n, 'amount', amt)), '{}'::jsonb) from (select status, count(*) n, sum(amount_paid) amt from ranged group by status) s),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category_id', s.category_id, 'code', k.code, 'name_en', k.name_en, 'name_th', k.name_th, 'icon', k.icon, 'n', s.n, 'amount', s.amt) order by s.amt desc), '[]'::jsonb)
                      from (select category_id, count(*) n, sum(amount_paid) amt from counted group by 1) s join public.expense_categories k on k.id = s.category_id),
    'by_method',   (select coalesce(jsonb_agg(jsonb_build_object('method', method, 'n', n, 'amount', amt) order by amt desc), '[]'::jsonb)
                      from (select payment_method as method, count(*) n, sum(amount_paid) amt from counted group by 1) s)
  ) into res;
  return res;
end $$;

-- privileges of the restored 11-argument expense_save (dropping it removed them)
revoke all on function public.expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text) from public, anon;
grant execute on function public.expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text) to authenticated;
