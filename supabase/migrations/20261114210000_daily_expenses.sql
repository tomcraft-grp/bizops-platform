-- Daily expenses: employees record, managers approve, accountants review tax treatment and post to the ledger.
--
-- Where things live
--   * This database holds the WORKFLOW: categories (with the chart-of-accounts code each one posts to), claims, receipts,
--     approvals and an append-only audit trail. Nothing here is a journal and nothing here is a financial total.
--   * The general ledger (journals, chart of accounts, period lock, reports) stays in the accounting device, as for every
--     other module. An accountant's device reads APPROVED claims, validates them against the real chart of accounts,
--     posts the journal locally and calls expense_mark_posted(). The unique posted_ref and the local refId check make a
--     double posting impossible from either side. Financial reports are always read from the ledger.
--
-- Principles
--   * Writes happen only through the SECURITY DEFINER functions below (clients have SELECT only, filtered by RLS).
--   * Employees see their own claims; managers, accountants and admins see all. Approval and posting are separate steps;
--     nobody can approve their own claim. VAT and withholding tax are recomputed here, never trusted from the client.
--   * Nothing is ever deleted: a claim is cancelled, a posted claim is reversed in the ledger first (expense_mark_reversed).
--
-- Rollback: supabase/rollbacks/20261114210000_daily_expenses_down.sql

-- ------------------------------------------------------------------------------------------------------ 1. roles
create table public.expense_staff_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('employee', 'manager', 'accountant')),
  granted_by uuid default auth.uid(),
  granted_at timestamptz not null default now()
);

-- SUPER_ADMIN = admin (everything). Otherwise the granted role. A back-office ADMIN without a grant can record own expenses.
create or replace function public.expense_role()
returns text language sql stable security definer set search_path = public as $$
  select case when p.role = 'SUPER_ADMIN' then 'admin'
              when r.role is not null then r.role
              when p.role = 'ADMIN' then 'employee'
              else null end
    from public.profiles p left join public.expense_staff_roles r on r.user_id = p.id
   where p.id = auth.uid() and p.status = 'active'
$$;

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

create or replace function public.expense_require(p_cap text, p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.expense_can(p_cap) then raise exception 'You are not allowed to %', p_what using errcode = '42501'; end if;
end $$;

create or replace function public.expense_actor_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1), 'user') from public.profiles p where p.id = auth.uid()
$$;

-- ------------------------------------------------------------------------------------------------------ 2. configuration
create table public.expense_settings (
  id                       smallint primary key default 1 check (id = 1),
  vat_registered           boolean not null default true,
  vat_rate                 numeric(6, 4) not null default 0.07 check (vat_rate >= 0 and vat_rate <= 0.3),
  wht_account_code         text not null default '2210' check (wht_account_code ~ '^[0-9]{3,8}$'),          -- chart-of-accounts code, validated by the ledger at posting
  fixed_asset_account_code text not null default '1500' check (fixed_asset_account_code ~ '^[0-9]{3,8}$'),
  fixed_asset_warn_amount  numeric(14, 2) not null default 0 check (fixed_asset_warn_amount >= 0),          -- 0 = no warning
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.expense_settings (id) values (1);

create table public.expense_categories (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name_en          text not null check (length(btrim(name_en)) between 1 and 80),
  name_th          text not null check (length(btrim(name_th)) between 1 and 80),
  icon             text not null default 'receipt' check (icon ~ '^[a-z0-9-]{2,30}$'),
  sort             integer not null default 100,
  treatment        text not null default 'expense' check (treatment in ('expense', 'fixed_asset')),
  account_code     text check (account_code is null or account_code ~ '^[0-9]{3,8}$'),                     -- null = NOT MAPPED: claims in this category cannot be posted
  default_tax_type text not null default 'none' check (default_tax_type in ('none', 'vat_included', 'vat_excluded', 'vat_noncreditable')),
  default_wht_rate numeric(5, 2) check (default_wht_rate is null or (default_wht_rate >= 0 and default_wht_rate <= 15)),
  hint_en          text check (hint_en is null or length(hint_en) <= 160),
  hint_th          text check (hint_th is null or length(hint_th) <= 160),
  active           boolean not null default true,
  updated_by       uuid, updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);

-- Account codes below are the accounts that exist in the current chart of accounts (no new accounts are created here):
-- 6200 Rent, 6210 Utilities, 6220 Staff costs, 6130 Marketing & promotions, 6300 Other operating expenses, 6400 Bank charges,
-- 1500 Equipment. Categories without a dedicated account share 6300; an accountant can re-map any of them in the app.
insert into public.expense_categories (code, name_en, name_th, icon, sort, treatment, account_code, hint_en, hint_th) values
  ('office_supplies',  'Office supplies',            'เครื่องใช้สำนักงาน',        'paperclip',      10, 'expense',     '6300', 'Paper, pens, cleaning supplies, small items', 'กระดาษ ปากกา ของใช้ทำความสะอาด ของจิปาถะ'),
  ('electricity',      'Electricity',                'ค่าไฟฟ้า',                  'zap',            20, 'expense',     '6210', 'Electricity bill',                             'ค่าไฟฟ้าร้าน/สำนักงาน'),
  ('water',            'Water',                      'ค่าน้ำประปา',               'droplets',       30, 'expense',     '6210', 'Water bill',                                   'ค่าน้ำประปา'),
  ('internet_phone',   'Internet & telephone',       'ค่าอินเทอร์เน็ตและโทรศัพท์', 'wifi',           40, 'expense',     '6300', 'Internet, mobile and phone bills',             'ค่าเน็ต ค่าโทรศัพท์'),
  ('transportation',   'Transportation',             'ค่าเดินทาง',                'bus',            50, 'expense',     '6300', 'Taxi, bus, parking, tolls',                    'แท็กซี่ รถโดยสาร ที่จอดรถ ทางด่วน'),
  ('fuel',             'Fuel',                       'ค่าน้ำมัน',                 'fuel',           60, 'expense',     '6300', 'Fuel for company vehicles',                    'น้ำมันรถของกิจการ'),
  ('meals',            'Meals & entertainment',      'ค่าอาหารและรับรอง',         'utensils',       70, 'expense',     '6300', 'Meals, client entertainment, refreshments',    'อาหาร ค่ารับรองลูกค้า เครื่องดื่ม'),
  ('employee',         'Employee expenses',          'ค่าใช้จ่ายพนักงาน',         'users',          80, 'expense',     '6220', 'Part-time wages, allowances, staff welfare',   'ค่าแรงรายวัน เบี้ยเลี้ยง สวัสดิการพนักงาน'),
  ('rent',             'Rent',                       'ค่าเช่า',                   'home',           90, 'expense',     '6200', 'Shop, office or warehouse rent',               'ค่าเช่าร้าน สำนักงาน คลังสินค้า'),
  ('repairs',          'Repairs & maintenance',      'ค่าซ่อมแซมและบำรุงรักษา',   'wrench',        100, 'expense',     '6300', 'Repairs and servicing (not new equipment)',    'ค่าซ่อม ค่าบำรุงรักษา (ไม่ใช่ซื้ออุปกรณ์ใหม่)'),
  ('marketing',        'Marketing',                  'ค่าโฆษณาและการตลาด',        'megaphone',     110, 'expense',     '6130', 'Ads, promotions, printing for marketing',      'ค่าโฆษณา โปรโมชั่น ค่าพิมพ์สื่อการตลาด'),
  ('delivery',         'Delivery & shipping',        'ค่าขนส่ง',                  'truck',         120, 'expense',     '6300', 'Courier and freight you pay yourself',         'ค่าขนส่ง ค่าไปรษณีย์ที่กิจการจ่ายเอง'),
  ('bank_fees',        'Bank fees',                  'ค่าธรรมเนียมธนาคาร',        'landmark',      130, 'expense',     '6400', 'Transfer fees, account fees',                  'ค่าธรรมเนียมโอน ค่าธรรมเนียมบัญชี'),
  ('equipment',        'Equipment & assets',         'อุปกรณ์และสินทรัพย์',       'package',       140, 'fixed_asset', '1500', 'Machines and equipment used for more than a year', 'เครื่องจักร อุปกรณ์ที่ใช้งานเกิน 1 ปี (ลงเป็นสินทรัพย์)'),
  ('other',            'Other expenses',             'ค่าใช้จ่ายอื่น ๆ',          'receipt',       999, 'expense',     '6300', 'Anything that does not fit above',             'รายการอื่นที่ไม่เข้าหมวดด้านบน');

-- ------------------------------------------------------------------------------------------------------ 3. claims
create table public.expense_counters (year integer primary key, last_seq integer not null default 0);

create table public.expense_claims (
  id              uuid primary key default gen_random_uuid(),
  expense_no      text unique,                                      -- assigned at first submit (gap-free per year)
  created_by      uuid not null references auth.users(id),
  created_by_name text,
  expense_date    date not null,                                    -- transaction date
  payment_date    date not null,                                    -- when the money left (same day for cash / transfers recorded here)
  category_id     uuid not null references public.expense_categories(id),
  description     text not null check (length(btrim(description)) between 1 and 300),
  vendor          text check (vendor is null or length(vendor) <= 200),
  vendor_tax_id   text check (vendor_tax_id is null or vendor_tax_id ~ '^[0-9]{13}$'),
  reference_no    text check (reference_no is null or length(reference_no) <= 100),
  notes           text check (notes is null or length(notes) <= 1000),
  payment_method  text not null check (payment_method in ('cash', 'bank_transfer', 'qr', 'card')),
  paid_from       text not null check (paid_from in ('cash', 'bank')),
  tax_type        text not null default 'none' check (tax_type in ('none', 'vat_included', 'vat_excluded', 'vat_noncreditable')),
  vat_rate        numeric(6, 4) not null default 0,
  amount_paid     numeric(14, 2) not null check (amount_paid > 0),  -- total money out, VAT included
  vat_amount      numeric(14, 2) not null default 0 check (vat_amount >= 0),
  wht_rate        numeric(5, 2) not null default 0 check (wht_rate >= 0 and wht_rate <= 15),
  wht_amount      numeric(14, 2) not null default 0 check (wht_amount >= 0),
  treatment       text not null default 'expense' check (treatment in ('expense', 'fixed_asset')),
  account_override text check (account_override is null or account_override ~ '^[0-9]{3,8}$'),
  branch_id       text,
  status          text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'posted', 'cancelled')),
  submitted_at    timestamptz,
  approved_by     uuid, approved_at timestamptz, approval_note text,
  rejected_by     uuid, rejected_at timestamptz, reject_reason text,
  reviewed_by     uuid, reviewed_at timestamptz, review_note text,
  posted_by       uuid, posted_at timestamptz, posting_date date, journal_no text, posted_ref text unique,
  cancelled_by    uuid, cancelled_at timestamptz, cancel_reason text, reversal_journal_no text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint expense_vat_within_amount check (vat_amount <= amount_paid),
  constraint expense_wht_within_base    check (wht_amount <= amount_paid - vat_amount),
  constraint expense_posted_has_ref     check (status <> 'posted' or (posted_ref is not null and journal_no is not null and posted_at is not null and posting_date is not null))
);
create index expense_claims_status_date_idx on public.expense_claims (status, expense_date);
create index expense_claims_owner_idx       on public.expense_claims (created_by, expense_date desc);
create index expense_claims_category_idx    on public.expense_claims (category_id, expense_date);
create index expense_claims_date_idx        on public.expense_claims (expense_date);

create table public.expense_attachments (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references public.expense_claims(id) on delete restrict,
  file_path   text not null unique,                                -- <owner uid>/<claim id>/<file> in the private bucket expense-receipts
  file_name   text not null check (length(file_name) between 1 and 200),
  mime        text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')),
  size_bytes  integer not null check (size_bytes between 1 and 5242880),
  uploaded_by uuid not null default auth.uid(),
  uploaded_at timestamptz not null default now()
);
create index expense_attachments_claim_idx on public.expense_attachments (expense_id);

-- Append-only audit trail (claims, roles, categories, settings).
create table public.expense_events (
  id          bigint generated always as identity primary key,
  entity      text not null default 'expense',
  entity_id   text,
  expense_id  uuid references public.expense_claims(id) on delete restrict,
  action      text not null,
  from_status text, to_status text,
  actor       uuid default auth.uid(), actor_name text,
  at          timestamptz not null default now(),
  note        text, detail jsonb
);
create index expense_events_claim_idx on public.expense_events (expense_id, at);

create or replace function public.expense_log(p_entity text, p_entity_id text, p_claim uuid, p_action text, p_from text, p_to text, p_note text, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.expense_events (entity, entity_id, expense_id, action, from_status, to_status, actor, actor_name, note, detail)
  values (p_entity, p_entity_id, p_claim, p_action, p_from, p_to, auth.uid(), public.expense_actor_name(), p_note, p_detail)
$$;

-- ------------------------------------------------------------------------------------------------------ 4. guards
-- Valid status moves only; posted / cancelled claims keep their financial facts; nothing is deleted; the audit trail is append-only.
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
create trigger expense_claims_guard before update or delete on public.expense_claims for each row execute function public.expense_claims_guard();

create or replace function public.expense_append_only() returns trigger language plpgsql as $$
begin raise exception 'This record is append-only' using errcode = '23001'; end $$;
create trigger expense_events_append_only before update or delete on public.expense_events for each row execute function public.expense_append_only();
create trigger expense_attachments_no_update before update on public.expense_attachments for each row execute function public.expense_append_only();

-- ------------------------------------------------------------------------------------------------------ 5. access (RLS)
alter table public.expense_staff_roles enable row level security;
alter table public.expense_settings    enable row level security;
alter table public.expense_categories  enable row level security;
alter table public.expense_counters    enable row level security;
alter table public.expense_claims      enable row level security;
alter table public.expense_attachments enable row level security;
alter table public.expense_events      enable row level security;

create policy "expense roles: own or admin"  on public.expense_staff_roles for select to authenticated using (user_id = auth.uid() or public.expense_can('manage_roles'));
create policy "expense settings: staff"      on public.expense_settings    for select to authenticated using (public.expense_role() is not null);
create policy "expense categories: staff"    on public.expense_categories  for select to authenticated using (public.expense_role() is not null);
create policy "expense claims: own or all"   on public.expense_claims      for select to authenticated using (created_by = auth.uid() or public.expense_can('view_all'));
create policy "expense attachments: via claim" on public.expense_attachments for select to authenticated
  using (exists (select 1 from public.expense_claims c where c.id = expense_id and (c.created_by = auth.uid() or public.expense_can('view_all'))));
create policy "expense events: via claim"    on public.expense_events      for select to authenticated
  using (expense_id is not null and exists (select 1 from public.expense_claims c where c.id = expense_id and (c.created_by = auth.uid() or public.expense_can('view_all')))
         or (expense_id is null and public.expense_can('config')));

do $$
declare t text;
begin
  foreach t in array array['expense_staff_roles', 'expense_settings', 'expense_categories', 'expense_counters', 'expense_claims', 'expense_attachments', 'expense_events'] loop
    execute format('revoke all on public.%I from public, anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
  end loop;
  foreach t in array array['expense_staff_roles', 'expense_settings', 'expense_categories', 'expense_claims', 'expense_attachments', 'expense_events'] loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------------ 6. money
-- amount as typed + VAT mode -> money out and VAT. 'vat_excluded': the typed amount is BEFORE VAT and VAT is added on top.
create or replace function public.expense_calc(p_amount numeric, p_tax_type text, p_rate numeric)
returns table (paid numeric, vat numeric) language sql immutable as $$
  select case p_tax_type when 'vat_excluded' then round(p_amount + round(p_amount * p_rate, 2), 2) else round(p_amount, 2) end,
         case p_tax_type when 'none' then 0::numeric
                         when 'vat_excluded' then round(p_amount * p_rate, 2)
                         else round(p_amount * p_rate / (1 + p_rate), 2) end
$$;

-- ------------------------------------------------------------------------------------------------------ 7. employee actions
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

create or replace function public.expense_add_attachment(p_expense uuid, p_path text, p_name text, p_mime text, p_size integer)
returns public.expense_attachments language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; a public.expense_attachments;
begin
  perform public.expense_require('create', 'attach receipts');
  select * into cl from public.expense_claims where id = p_expense for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.created_by <> auth.uid() then raise exception 'You can only attach files to your own expenses' using errcode = '42501'; end if;
  if cl.status not in ('draft', 'rejected') then raise exception 'Receipts can only be added while the expense is a draft'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> auth.uid()::text or split_part(p_path, '/', 2) <> p_expense::text or split_part(p_path, '/', 3) = '' then
    raise exception 'The receipt must be stored in your own folder for this expense';
  end if;
  if (select count(*) from public.expense_attachments where expense_id = p_expense) >= 5 then raise exception 'At most 5 files per expense'; end if;
  insert into public.expense_attachments (expense_id, file_path, file_name, mime, size_bytes) values (p_expense, p_path, left(p_name, 200), p_mime, p_size) returning * into a;
  perform public.expense_log('expense', p_expense::text, p_expense, 'attachment.added', null, cl.status, left(p_name, 200), jsonb_build_object('mime', p_mime, 'size', p_size));
  return a;
end $$;

create or replace function public.expense_remove_attachment(p_attachment uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.expense_attachments; cl public.expense_claims;
begin
  select * into a from public.expense_attachments where id = p_attachment;
  if not found then raise exception 'Attachment not found'; end if;
  select * into cl from public.expense_claims where id = a.expense_id for update;
  if cl.created_by <> auth.uid() then raise exception 'You can only change your own expenses' using errcode = '42501'; end if;
  if cl.status not in ('draft', 'rejected') then raise exception 'Receipts can only be removed while the expense is a draft'; end if;
  delete from public.expense_attachments where id = p_attachment;
  perform public.expense_log('expense', cl.id::text, cl.id, 'attachment.removed', null, cl.status, a.file_name, null);
end $$;

create or replace function public.expense_submit(p_id uuid)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; cat public.expense_categories; v_year integer := extract(year from (now() at time zone 'Asia/Bangkok'))::integer; v_n integer; v_no text;
begin
  perform public.expense_require('create', 'submit expenses');
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.created_by <> auth.uid() then raise exception 'You can only submit your own expenses' using errcode = '42501'; end if;
  if cl.status not in ('draft', 'rejected') then raise exception 'Only drafts can be submitted (this one is %)', cl.status; end if;
  select * into cat from public.expense_categories where id = cl.category_id;
  if not cat.active then raise exception 'This category is no longer active: pick another one'; end if;
  v_no := cl.expense_no;
  if v_no is null then
    insert into public.expense_counters (year, last_seq) values (v_year, 1) on conflict (year) do update set last_seq = public.expense_counters.last_seq + 1 returning last_seq into v_n;
    v_no := 'EXP-' || v_year || '-' || lpad(v_n::text, 6, '0');
  end if;
  update public.expense_claims set status = 'submitted', submitted_at = now(), expense_no = v_no where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'submitted', 'draft', 'submitted', null, jsonb_build_object('expense_no', v_no));
  return cl;
end $$;

create or replace function public.expense_cancel(p_id uuid, p_reason text)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; own boolean; old_status text;
begin
  perform public.expense_require('create', 'cancel expenses');
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  own := cl.created_by = auth.uid();
  if not own and not (public.expense_can('approve') or public.expense_can('post')) then raise exception 'You can only cancel your own expenses' using errcode = '42501'; end if;
  if cl.status = 'posted' then raise exception 'A posted expense must be reversed in the ledger first (accountant)'; end if;
  if cl.status = 'cancelled' then raise exception 'Already cancelled'; end if;
  if own and cl.status not in ('draft', 'submitted', 'rejected') then raise exception 'Ask a manager or accountant to cancel an approved expense'; end if;
  if (cl.status <> 'draft' or not own) and nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required'; end if;
  old_status := cl.status;
  update public.expense_claims set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'cancelled', old_status, 'cancelled', p_reason, null);
  return cl;
end $$;

-- ------------------------------------------------------------------------------------------------------ 8. manager actions
create or replace function public.expense_approve(p_id uuid, p_note text default null)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims;
begin
  perform public.expense_require('approve', 'approve expenses');
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status <> 'submitted' then raise exception 'Only submitted expenses can be approved (this one is %)', cl.status; end if;
  if cl.created_by = auth.uid() then raise exception 'You cannot approve your own expense: a different person must approve it' using errcode = '42501'; end if;
  update public.expense_claims set status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'approved', 'submitted', 'approved', p_note, null);
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

-- ------------------------------------------------------------------------------------------------------ 9. accountant actions
-- The accountant confirms the tax treatment before posting. VAT is a confirmed amount (it can be 0 if the document is not a
-- valid tax invoice); withholding tax is a rate chosen by the accountant (default none) applied to the amount BEFORE VAT.
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

create or replace function public.expense_mark_posted(p_id uuid, p_journal_no text, p_posting_date date, p_posted_ref text)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims;
begin
  perform public.expense_require('post', 'post expenses');
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if p_posted_ref is distinct from 'EXPCLAIM:' || p_id::text then raise exception 'Unexpected ledger reference'; end if;
  if cl.status = 'posted' then
    if cl.posted_ref = p_posted_ref and cl.journal_no = p_journal_no then return cl; end if;  -- same posting reported twice: fine
    raise exception 'This expense is already posted as journal %', cl.journal_no;
  end if;
  if cl.status <> 'approved' then raise exception 'Only approved expenses can be posted (this one is %)', cl.status; end if;
  if cl.reviewed_at is null then raise exception 'Confirm the tax treatment (review) before posting'; end if;
  if nullif(btrim(coalesce(p_journal_no, '')), '') is null or p_posting_date is null then raise exception 'The journal number and posting date are required'; end if;
  update public.expense_claims set status = 'posted', posted_by = auth.uid(), posted_at = now(), posting_date = p_posting_date, journal_no = p_journal_no, posted_ref = p_posted_ref
    where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'posted', 'approved', 'posted', null, jsonb_build_object('journal_no', p_journal_no, 'posting_date', p_posting_date));
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

-- ------------------------------------------------------------------------------------------------------ 10. configuration actions
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

create or replace function public.expense_settings_save(p_vat_registered boolean, p_vat_rate numeric, p_wht_account text, p_fixed_asset_account text, p_warn_amount numeric)
returns public.expense_settings language plpgsql security definer set search_path = public as $$
declare s public.expense_settings;
begin
  perform public.expense_require('config', 'change expense settings');
  update public.expense_settings set vat_registered = p_vat_registered, vat_rate = p_vat_rate, wht_account_code = p_wht_account, fixed_asset_account_code = p_fixed_asset_account,
      fixed_asset_warn_amount = coalesce(p_warn_amount, 0), updated_by = auth.uid(), updated_at = now() where id = 1 returning * into s;
  perform public.expense_log('settings', '1', null, 'settings.updated', null, null, null, to_jsonb(s));
  return s;
end $$;

create or replace function public.expense_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.expense_require('manage_roles', 'manage expense access');
  if p_user = auth.uid() then raise exception 'You cannot change your own expense role'; end if;
  if exists (select 1 from public.profiles where id = p_user and role = 'SUPER_ADMIN') then raise exception 'A SUPER_ADMIN always has full access'; end if;
  if not exists (select 1 from public.profiles where id = p_user and status = 'active') then raise exception 'Choose an active user'; end if;
  if p_role is null then delete from public.expense_staff_roles where user_id = p_user;
  else
    if p_role not in ('employee', 'manager', 'accountant') then raise exception 'Unknown role %', p_role; end if;
    insert into public.expense_staff_roles (user_id, role) values (p_user, p_role)
      on conflict (user_id) do update set role = excluded.role, granted_by = auth.uid(), granted_at = now();
  end if;
  perform public.expense_log('role', p_user::text, null, 'role.set', null, null, null, jsonb_build_object('role', p_role));
end $$;

create or replace function public.expense_staff()
returns table (user_id uuid, email text, display_name text, profile_role text, expense_role text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.expense_require('manage_roles', 'see expense access');
  return query select p.id, p.email, p.display_name, p.role, case when p.role = 'SUPER_ADMIN' then 'admin' else r.role end
                 from public.profiles p left join public.expense_staff_roles r on r.user_id = p.id where p.status = 'active' order by p.role, p.email;
end $$;

-- ------------------------------------------------------------------------------------------------------ 11. dashboard numbers
-- "Expenses" = submitted + approved + posted claims (drafts, rejected and cancelled are not spending). Dates are Bangkok dates.
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

-- ------------------------------------------------------------------------------------------------------ 12. function access
revoke all on function public.expense_role(), public.expense_can(text), public.expense_require(text, text), public.expense_actor_name(), public.expense_log(text, text, uuid, text, text, text, text, jsonb),
  public.expense_calc(numeric, text, numeric) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text)', 'expense_add_attachment(uuid, text, text, text, integer)', 'expense_remove_attachment(uuid)',
    'expense_submit(uuid)', 'expense_cancel(uuid, text)', 'expense_approve(uuid, text)', 'expense_reject(uuid, text)',
    'expense_review(uuid, text, numeric, numeric, text, text, text, text)', 'expense_mark_posted(uuid, text, date, text)', 'expense_mark_reversed(uuid, text, text)',
    'expense_category_save(uuid, text, text, text, text, integer, text, text, text, numeric, text, text, boolean)', 'expense_settings_save(boolean, numeric, text, text, numeric)',
    'expense_set_role(uuid, text)', 'expense_staff()', 'expense_dashboard(date, date, text, uuid, text, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
-- RLS policies call these as the signed-in user, so they need to be executable (they only reveal the caller's own role / a boolean)
grant execute on function public.expense_role() to authenticated;
grant execute on function public.expense_can(text) to authenticated;

-- ------------------------------------------------------------------------------------------------------ 13. receipts (private bucket)
-- Photos and PDF up to 5 MB, stored under <user id>/<claim id>/. Only the owner uploads; the owner and managers/accountants/admins read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expense-receipts', 'expense-receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "expense receipts: upload own folder" on storage.objects;
create policy "expense receipts: upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'expense-receipts' and (storage.foldername(name))[1] = auth.uid()::text and public.expense_can('create'));
drop policy if exists "expense receipts: read own or reviewers" on storage.objects;
create policy "expense receipts: read own or reviewers" on storage.objects for select to authenticated
  using (bucket_id = 'expense-receipts' and ((storage.foldername(name))[1] = auth.uid()::text or public.expense_can('view_all')));
