-- Daily expenses, version 2: products from the catalogue, one accounting-approval step (no separate manager approval), bulk
-- "approve & post to accounting", the bank account each transfer was paid from, and a bank ledger whose balance moves when an
-- expense is posted (and moves back when it is reversed).
--
-- What changes
--   * PRODUCTS. A claim can name a product of the central catalogue (public.sku_registry, the same registry every device syncs
--     from): expense_claims.sku_code. The catalogue's own class decides the category: RM (raw materials, packaging) and WIP go to
--     the "Raw materials & packaging" category, FG (finished / resale goods) to "Goods for resale". A product that is ALSO sold
--     (fresh coconut sugar registered as RM) stays a raw material: being on sale never changes its class. Both categories post to
--     inventory through the ledger's posting roles inv_materials / inv_goods (no account code is hard-wired here).
--   * WORKFLOW. draft -> (optional "reviewed" mark) -> posted. Anyone holding the new capability 'approve_post' (manager,
--     accountant, admin) approves AND posts in one step; the old "submit -> manager approves" stage is no longer needed. Old rows in
--     'submitted' / 'approved' stay valid and can be posted the same way. Old app builds keep working (the 11-argument
--     expense_save, expense_submit, expense_approve and expense_mark_posted are unchanged in behaviour).
--   * POSTING happens HERE, in one database transaction per expense: the claim becomes 'posted', the journal is queued for the
--     accounting device in public.finance_gl_queue (event EXPENSE_PAYMENT, the same queue every customer payment already uses,
--     posted there with the existing engine), and for a bank transfer / QR payment the bank ledger gets its movement. Either all of
--     that happens or none of it. A bulk run reports, per expense, posted / skipped (already posted) / failed with the reason.
--   * BANK LEDGER. public.finance_bank_transactions is append-only (balance before / after, the expense it belongs to, the queue
--     row, an idempotency key); public.finance_bank_balances holds the running balance and can ONLY change through
--     finance_bank_apply(). The key 'EXPENSE:<claim id>' makes a second deduction for the same expense impossible, whatever the
--     clicks, retries or concurrent requests. Balances are visible to finance staff and to those who post expenses, never to
--     customers (public.finance_bank_accounts is readable by customers, so the balance is NOT a column there).
--   * REVERSAL. expense_reverse(): the claim is cancelled, the bank gets the money back with a reversal row that points at the
--     original, and the journal is voided (not yet posted) or reversed by an EXPENSE_REVERSAL queue row (already posted).
--     Nothing is deleted or edited.
--
-- Rollback: supabase/rollbacks/20261128160000_expense_bank_posting_down.sql (refuses once anything was posted this way).

-- ================================================================================================= 1. capability
create or replace function public.expense_can(p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(case p_cap
    when 'create'       then public.expense_role() in ('employee', 'manager', 'accountant', 'admin')
    when 'view_all'     then public.expense_role() in ('manager', 'accountant', 'admin')
    when 'approve'      then public.expense_role() in ('manager', 'admin')
    when 'approve_post' then public.expense_role() in ('manager', 'accountant', 'admin')   -- review + approve & post to accounting (one step)
    when 'post'         then public.expense_role() in ('accountant', 'admin')               -- tax review, reversal of a posted expense
    when 'config'       then public.expense_role() in ('accountant', 'admin')
    when 'manage_roles' then public.expense_role() = 'admin'
    else false end, false)
$$;

-- ================================================================================================= 2. categories for products
alter table public.expense_categories drop constraint expense_categories_treatment_check;
alter table public.expense_categories add constraint expense_categories_treatment_check check (treatment in ('expense', 'fixed_asset', 'inventory'));
alter table public.expense_categories add column posting_role text check (posting_role is null or posting_role in ('inv_materials', 'inv_goods'));
alter table public.expense_categories add column product_class text check (product_class is null or product_class in ('FG', 'RM'));
alter table public.expense_categories add constraint expense_categories_inventory_role check ((treatment = 'inventory') = (posting_role is not null));
create unique index expense_categories_product_class on public.expense_categories (product_class) where product_class is not null and active;

insert into public.expense_categories (code, name_en, name_th, icon, sort, treatment, account_code, posting_role, product_class, hint_en, hint_th) values
  ('stock_materials', 'Raw materials & packaging', 'วัตถุดิบและบรรจุภัณฑ์', 'boxes', 5, 'inventory', null, 'inv_materials', 'RM',
   'Ingredients and packaging for production or stock (chosen from the product list)', 'วัตถุดิบ บรรจุภัณฑ์ ที่ซื้อเข้าผลิตหรือเก็บสต็อก (เลือกจากรายการสินค้า)'),
  ('stock_goods', 'Goods for resale', 'สินค้าซื้อมาเพื่อขาย', 'shopping-bag', 6, 'inventory', null, 'inv_goods', 'FG',
   'Finished goods bought to sell (chosen from the product list)', 'สินค้าสำเร็จรูปที่ซื้อมาเพื่อขาย (เลือกจากรายการสินค้า)')
on conflict (code) do nothing;

-- ================================================================================================= 3. claims: product, bank account, links
alter table public.expense_claims drop constraint expense_claims_treatment_check;
alter table public.expense_claims add constraint expense_claims_treatment_check check (treatment in ('expense', 'fixed_asset', 'inventory'));
alter table public.expense_claims add column sku_code text check (sku_code is null or length(sku_code) between 1 and 40);    -- product of public.sku_registry (checked when saved)
alter table public.expense_claims add column bank_account_id uuid references public.finance_bank_accounts (id) on delete restrict;   -- the account a transfer / QR was paid from
alter table public.expense_claims add column gl_queue_id uuid references public.finance_gl_queue (id) on delete restrict;             -- the queued journal (posted here)
alter table public.expense_claims add column bank_txn_id uuid;                                                                        -- the bank movement (FK below)
alter table public.expense_claims drop constraint expense_posted_has_ref;
alter table public.expense_claims add constraint expense_posted_has_ref
  check (status <> 'posted' or (posted_ref is not null and posted_at is not null and posting_date is not null and (journal_no is not null or gl_queue_id is not null)));
create index expense_claims_bank_idx on public.expense_claims (bank_account_id) where bank_account_id is not null;
create index expense_claims_sku_idx on public.expense_claims (sku_code) where sku_code is not null;

-- Valid moves now also allow draft/submitted -> posted (one-step accounting approval) and draft -> rejected (sent back for a fix).
-- A posted or cancelled claim also keeps its payment method, bank account and product.
create or replace function public.expense_claims_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Expenses are never deleted; cancel them (a posted expense is reversed first)' using errcode = '23001'; end if;
  if new.status is distinct from old.status and not ((old.status, new.status) in (
       ('draft', 'submitted'), ('draft', 'cancelled'), ('submitted', 'approved'), ('submitted', 'rejected'), ('submitted', 'cancelled'),
       ('rejected', 'draft'), ('rejected', 'submitted'), ('rejected', 'cancelled'), ('approved', 'posted'), ('approved', 'rejected'),
       ('approved', 'cancelled'), ('posted', 'cancelled'), ('draft', 'posted'), ('submitted', 'posted'), ('draft', 'rejected'))) then
    raise exception 'An expense cannot go from % to %', old.status, new.status using errcode = '23001';
  end if;
  if old.status in ('posted', 'cancelled') and (new.amount_paid, new.vat_amount, new.wht_amount, new.tax_type, new.treatment, new.account_override, new.expense_date,
       new.category_id, new.posting_date, new.journal_no, new.posted_ref, new.created_by, new.payment_method, new.paid_from, new.bank_account_id, new.sku_code, new.gl_queue_id, new.bank_txn_id) is distinct from
       (old.amount_paid, old.vat_amount, old.wht_amount, old.tax_type, old.treatment, old.account_override, old.expense_date,
       old.category_id, old.posting_date, old.journal_no, old.posted_ref, old.created_by, old.payment_method, old.paid_from, old.bank_account_id, old.sku_code, old.gl_queue_id, old.bank_txn_id) then
    raise exception 'A posted or cancelled expense cannot be changed' using errcode = '23001';
  end if;
  if old.posted_ref is not null and new.posted_ref is distinct from old.posted_ref then raise exception 'The ledger reference of a posted expense cannot change' using errcode = '23001'; end if;
  new.updated_at := now();
  return new;
end $$;

-- ================================================================================================= 4. ledger queue: expense events
alter table public.finance_gl_queue drop constraint finance_gl_queue_event_type_chk;
alter table public.finance_gl_queue add constraint finance_gl_queue_event_type_chk
  check (event_type in ('INVOICE_ISSUE', 'INVOICE_CANCEL', 'BANK_RECEIPT', 'RECEIPT_REAPPLY', 'RECEIPT_REVERSAL', 'WALLET_DEPOSIT', 'WALLET_PAYMENT',
                        'WALLET_REFUND', 'WALLET_ADJUSTMENT', 'WALLET_REVERSAL', 'CASH_RECEIPT', 'EXPENSE_PAYMENT', 'EXPENSE_REVERSAL'));
alter table public.finance_gl_queue add column detail jsonb check (detail is null or jsonb_typeof(detail) = 'object');   -- what the accounting device shows / keeps (expense no., vendor, VAT)

-- ================================================================================================= 5. bank ledger
create sequence public.finance_bank_txn_seq;

create table public.finance_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,                                   -- the order of the ledger
  txn_no text not null unique,
  bank_account_id uuid not null references public.finance_bank_accounts (id) on delete restrict,
  txn_type text not null check (txn_type in ('OPENING', 'EXPENSE', 'EXPENSE_REVERSAL', 'ADJUSTMENT')),
  direction text not null check (direction in ('in', 'out')),                       -- money into / out of the bank account
  amount numeric(14, 2) not null check (amount > 0),
  balance_before numeric(14, 2) not null,
  balance_after numeric(14, 2) not null,
  value_date date not null,                                                         -- the day the money moved (the expense date for an expense)
  ref_type text check (ref_type is null or ref_type in ('expense', 'manual')),
  ref_id uuid, ref_no text,
  gl_queue_id uuid references public.finance_gl_queue (id) on delete restrict,
  reversal_of uuid unique references public.finance_bank_transactions (id) on delete restrict,
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 120),
  note text check (note is null or length(note) <= 500),
  created_by uuid default auth.uid(), created_by_name text,
  created_at timestamptz not null default now(),
  check ((direction = 'in' and balance_after = balance_before + amount) or (direction = 'out' and balance_after = balance_before - amount)),
  check (txn_type <> 'EXPENSE' or (direction = 'out' and ref_type = 'expense' and ref_id is not null)),
  check (txn_type <> 'EXPENSE_REVERSAL' or (direction = 'in' and reversal_of is not null)),
  check (txn_type <> 'OPENING' or direction = 'in')
);
create index finance_bank_txn_bank_idx on public.finance_bank_transactions (bank_account_id, seq desc);
create index finance_bank_txn_ref_idx on public.finance_bank_transactions (ref_type, ref_id);
create unique index finance_bank_txn_one_opening on public.finance_bank_transactions (bank_account_id) where txn_type = 'OPENING';
alter table public.expense_claims add constraint expense_claims_bank_txn_fk foreign key (bank_txn_id) references public.finance_bank_transactions (id) on delete restrict;

create table public.finance_bank_balances (
  bank_account_id uuid primary key references public.finance_bank_accounts (id) on delete restrict,
  balance numeric(14, 2) not null default 0,                                        -- a projection of the ledger; may go below zero (an opening balance not entered yet)
  last_txn_id uuid references public.finance_bank_transactions (id) on delete restrict,
  updated_at timestamptz not null default now()
);
insert into public.finance_bank_balances (bank_account_id) select id from public.finance_bank_accounts on conflict do nothing;

create or replace function public.finance_bank_txn_immutable()
returns trigger language plpgsql as $$ begin raise exception 'Bank transactions are never changed or deleted: correct them with a reversal or an adjustment'; end $$;
create trigger finance_bank_txn_no_change before update or delete on public.finance_bank_transactions for each row execute function public.finance_bank_txn_immutable();

create or replace function public.finance_bank_balance_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'A bank balance is never deleted'; end if;
  if new.bank_account_id is distinct from old.bank_account_id then raise exception 'A bank balance cannot move to another account'; end if;
  if (new.balance, new.last_txn_id) is distinct from (old.balance, old.last_txn_id) and coalesce(current_setting('finance.bank_write', true), '') <> '1' then
    raise exception 'A bank balance can only change through a bank transaction'; end if;
  return new;
end $$;
create trigger finance_bank_balances_guard before update or delete on public.finance_bank_balances for each row execute function public.finance_bank_balance_guard();

-- the ONLY writer of a bank balance: lock the balance row, append the movement, move the balance. Idempotent per key.
create or replace function public.finance_bank_apply(p_bank uuid, p_type text, p_dir text, p_amount numeric, p_value_date date, p_ref_type text, p_ref_id uuid, p_ref_no text,
  p_key text, p_reversal_of uuid default null, p_gl_queue uuid default null, p_note text default null)
returns public.finance_bank_transactions language plpgsql security definer set search_path = public as $$
declare t public.finance_bank_transactions; v_amt numeric := round(p_amount, 2); v_bal numeric;
begin
  if v_amt is null or v_amt <= 0 then raise exception 'The bank amount must be greater than zero'; end if;
  if not exists (select 1 from public.finance_bank_accounts where id = p_bank) then raise exception 'Bank account not found'; end if;
  insert into public.finance_bank_balances (bank_account_id) values (p_bank) on conflict do nothing;
  select balance into v_bal from public.finance_bank_balances where bank_account_id = p_bank for update;
  select * into t from public.finance_bank_transactions where idempotency_key = p_key;       -- after the lock: a concurrent call with the same key is visible now
  if found then
    if t.bank_account_id <> p_bank or t.amount <> v_amt or t.direction <> p_dir then raise exception 'BANK_IDEMPOTENCY_CONFLICT: % was already used for a different movement', p_key; end if;
    return t;
  end if;
  insert into public.finance_bank_transactions (txn_no, bank_account_id, txn_type, direction, amount, balance_before, balance_after, value_date, ref_type, ref_id, ref_no,
      gl_queue_id, reversal_of, idempotency_key, note, created_by_name)
    values ('BTX-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYY') || '-' || lpad(nextval('public.finance_bank_txn_seq')::text, 6, '0'), p_bank, p_type, p_dir, v_amt, v_bal,
      case p_dir when 'in' then v_bal + v_amt else v_bal - v_amt end, coalesce(p_value_date, (now() at time zone 'Asia/Bangkok')::date), p_ref_type, p_ref_id, p_ref_no,
      p_gl_queue, p_reversal_of, p_key, nullif(left(btrim(coalesce(p_note, '')), 500), ''), public.expense_actor_name())
    returning * into t;
  perform set_config('finance.bank_write', '1', true);
  update public.finance_bank_balances set balance = t.balance_after, last_txn_id = t.id, updated_at = now() where bank_account_id = p_bank;
  perform set_config('finance.bank_write', '', true);
  return t;
end $$;

-- who may see balances and movements: finance staff and the people who post expenses
create or replace function public.finance_bank_can_view()
returns boolean language sql stable security definer set search_path = public as $$
  select public.finance_can('view') or public.expense_can('approve_post')
$$;

alter table public.finance_bank_transactions enable row level security;
alter table public.finance_bank_balances enable row level security;
create policy "bank transactions: finance or posters" on public.finance_bank_transactions for select to authenticated using (public.finance_bank_can_view());
create policy "bank balances: finance or posters" on public.finance_bank_balances for select to authenticated using (public.finance_bank_can_view());
revoke all on public.finance_bank_transactions, public.finance_bank_balances from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.finance_bank_transactions, public.finance_bank_balances from authenticated;
grant select on public.finance_bank_transactions, public.finance_bank_balances to authenticated;
revoke all on sequence public.finance_bank_txn_seq from public, anon, authenticated;

-- balance = sum of the ledger, and every row continues the previous one
create or replace function public.finance_bank_reconcile()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.finance_bank_can_view() then raise exception 'You are not allowed to see bank balances' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('bank_account_id', b.id, 'code', b.code, 'balance', coalesce(bb.balance, 0),
      'ledger', coalesce((select sum(case t.direction when 'in' then t.amount else -t.amount end) from public.finance_bank_transactions t where t.bank_account_id = b.id), 0),
      'chain_breaks', (select count(*) from (select t.balance_before, lag(t.balance_after) over (order by t.seq) prev, row_number() over (order by t.seq) rn
                                               from public.finance_bank_transactions t where t.bank_account_id = b.id) x where (x.rn = 1 and x.balance_before <> 0) or (x.rn > 1 and x.balance_before <> x.prev)),
      'ok', coalesce(bb.balance, 0) = coalesce((select sum(case t.direction when 'in' then t.amount else -t.amount end) from public.finance_bank_transactions t where t.bank_account_id = b.id), 0))
    order by b.sort_order, b.code) from public.finance_bank_accounts b left join public.finance_bank_balances bb on bb.bank_account_id = b.id), '[]'::jsonb);
end $$;

-- accounts with their balance (finance staff / expense posters)
create or replace function public.finance_bank_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.finance_bank_can_view() then raise exception 'You are not allowed to see bank balances' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'bank_name_th', b.bank_name_th, 'bank_name_en', b.bank_name_en, 'account_name', b.account_name,
      'last4', right(b.account_no, 4), 'active', b.active, 'balance', coalesce(bb.balance, 0), 'updated_at', bb.updated_at,
      'has_opening', exists (select 1 from public.finance_bank_transactions t where t.bank_account_id = b.id and t.txn_type = 'OPENING'),
      'txns', (select count(*) from public.finance_bank_transactions t where t.bank_account_id = b.id),
      'expense_out', coalesce((select sum(t.amount) from public.finance_bank_transactions t where t.bank_account_id = b.id and t.txn_type = 'EXPENSE'), 0))
    order by b.sort_order, b.code) from public.finance_bank_accounts b left join public.finance_bank_balances bb on bb.bank_account_id = b.id), '[]'::jsonb);
end $$;

-- one account's movements, newest first, each with the expense it belongs to and whether it was reversed
create or replace function public.finance_bank_ledger(p_bank uuid, p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.finance_bank_can_view() then raise exception 'You are not allowed to see bank movements' using errcode = '42501'; end if;
  return jsonb_build_object(
    'balance', (select balance from public.finance_bank_balances where bank_account_id = p_bank),
    'total', (select count(*) from public.finance_bank_transactions where bank_account_id = p_bank),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'txn_no', t.txn_no, 'txn_type', t.txn_type, 'direction', t.direction, 'amount', t.amount,
        'balance_before', t.balance_before, 'balance_after', t.balance_after, 'value_date', t.value_date, 'created_at', t.created_at, 'created_by_name', t.created_by_name,
        'note', t.note, 'ref_type', t.ref_type, 'ref_id', t.ref_id, 'ref_no', t.ref_no,
        'expense', (select jsonb_build_object('id', c.id, 'expense_no', c.expense_no, 'description', c.description, 'status', c.status, 'expense_date', c.expense_date)
                      from public.expense_claims c where t.ref_type = 'expense' and c.id = t.ref_id),
        'reversal_of_no', (select o.txn_no from public.finance_bank_transactions o where o.id = t.reversal_of),
        'reversed_by_no', (select r.txn_no from public.finance_bank_transactions r where r.reversal_of = t.id)) order by t.seq desc)
      from (select * from public.finance_bank_transactions where bank_account_id = p_bank order by seq desc
             limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) t), '[]'::jsonb));
end $$;

-- the balance the account had when the bank ledger starts (once per account; later corrections are adjustments)
create or replace function public.finance_bank_opening(p_bank uuid, p_amount numeric, p_date date, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.finance_bank_transactions;
begin
  perform public.finance_require('manage', 'set a bank opening balance');
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the opening balance (greater than zero)'; end if;
  if p_date is null or p_date > (now() at time zone 'Asia/Bangkok')::date then raise exception 'The opening date cannot be in the future'; end if;
  if exists (select 1 from public.finance_bank_transactions where bank_account_id = p_bank and txn_type = 'OPENING') then raise exception 'This account already has an opening balance: correct it with an adjustment'; end if;
  t := public.finance_bank_apply(p_bank, 'OPENING', 'in', p_amount, p_date, 'manual', null, null, 'OPENING:' || p_bank::text, null, null, coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Opening balance'));
  perform public.finance_log('bank', p_bank, 'bank.opening', jsonb_build_object('txn_no', t.txn_no, 'amount', t.amount, 'date', p_date));
  return to_jsonb(t);
end $$;

-- a correction to match the bank statement (money in or out that has no document here), always with a reason
create or replace function public.finance_bank_adjust(p_bank uuid, p_direction text, p_amount numeric, p_reason text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.finance_bank_transactions;
begin
  perform public.finance_require('manage', 'adjust a bank balance');
  if p_direction not in ('in', 'out') then raise exception 'Choose money in or money out'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount greater than zero'; end if;
  if coalesce(length(btrim(p_reason)), 0) < 10 then raise exception 'REASON_TOO_SHORT'; end if;
  if coalesce(length(p_key), 0) not between 8 and 100 then raise exception 'A request key is required'; end if;
  t := public.finance_bank_apply(p_bank, 'ADJUSTMENT', p_direction, p_amount, null, 'manual', null, null, 'ADJ:' || p_key, null, null, p_reason);
  perform public.finance_log('bank', p_bank, 'bank.adjust', jsonb_build_object('txn_no', t.txn_no, 'direction', p_direction, 'amount', t.amount, 'reason', btrim(p_reason)));
  return to_jsonb(t);
end $$;

-- ================================================================================================= 6. pickers for the expense screen
-- active bank accounts, enough to tell them apart (bank, account name, last 4 digits) and nothing more
create or replace function public.expense_bank_options()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.expense_require('create', 'record expenses');
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'bank_name_th', b.bank_name_th, 'bank_name_en', b.bank_name_en, 'account_name', b.account_name,
      'last4', right(b.account_no, 4), 'active', b.active) order by b.sort_order, b.code)
    from public.finance_bank_accounts b where b.active), '[]'::jsonb);
end $$;

-- the product a claim names -> the category its catalogue class maps to (WIP is bought like a raw material)
create or replace function public.expense_category_for_class(p_sku_category text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.expense_categories where active and product_class = case when p_sku_category = 'FG' then 'FG' else 'RM' end limit 1
$$;

-- the active products of the central catalogue (no prices or costs), each with the category it maps to
create or replace function public.expense_product_options()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.expense_require('create', 'record expenses');
  return coalesce((select jsonb_agg(jsonb_build_object('sku_code', r.sku_code, 'name_th', coalesce(nullif(btrim(r.name_th), ''), nullif(btrim(r.name_full), ''), r.name_en),
      'name_en', coalesce(nullif(btrim(r.name_en), ''), nullif(btrim(r.name_full), ''), r.name_th), 'brand', r.brand, 'unit_th', r.unit_th, 'unit_en', r.unit_en,
      'sku_category', r.sku_category, 'product_type', r.product_type, 'category_id', public.expense_category_for_class(r.sku_category))
    order by case r.sku_category when 'RM' then 0 when 'WIP' then 1 else 2 end, coalesce(r.name_th, r.name_en), r.sku_code)
    from public.sku_registry r where r.status = 'active'), '[]'::jsonb);
end $$;

-- ================================================================================================= 7. saving a claim
create or replace function public.expense_save_core(
  p_id uuid, p_expense_date date, p_category uuid, p_description text, p_amount numeric, p_tax_type text,
  p_payment_method text, p_vendor text, p_vendor_tax_id text, p_reference_no text, p_notes text, p_sku text, p_bank_account uuid, p_legacy boolean)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cat public.expense_categories;
  st public.expense_settings;
  cl public.expense_claims;
  sku public.sku_registry;
  v_paid numeric; v_vat numeric; v_rate numeric; v_cat uuid := p_category; v_sku text; v_bank uuid; v_desc text;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform public.expense_require('create', 'record expenses');
  if p_id is not null then
    select * into cl from public.expense_claims where id = p_id for update;
    if not found then raise exception 'Expense not found'; end if;
    if cl.created_by <> me then raise exception 'You can only edit your own expenses' using errcode = '42501'; end if;
    if cl.status not in ('draft', 'rejected') then raise exception 'Only drafts and rejected expenses can be edited (this one is %)', cl.status; end if;
  end if;

  -- the product (an old app build cannot send one: it keeps what the claim had)
  if p_legacy then v_sku := cl.sku_code;
  else
    v_sku := nullif(btrim(coalesce(p_sku, '')), '');
    if v_sku is not null then
      select * into sku from public.sku_registry where sku_code = v_sku;
      if not found then raise exception 'This product is not in the product list'; end if;
      if sku.status <> 'active' and v_sku is distinct from cl.sku_code then raise exception 'This product is no longer active: choose another one'; end if;
      if v_cat is null then v_cat := public.expense_category_for_class(sku.sku_category); end if;
    end if;
  end if;

  select * into cat from public.expense_categories where id = v_cat;
  if not found or not cat.active then raise exception 'Choose an active expense category'; end if;
  if p_expense_date is null or p_expense_date > v_today then raise exception 'The expense date cannot be in the future'; end if;
  v_desc := coalesce(nullif(btrim(coalesce(p_description, '')), ''), case when v_sku is not null then coalesce(nullif(btrim(sku.name_th), ''), nullif(btrim(sku.name_full), ''), sku.name_en) end);
  if v_desc is null then raise exception 'Describe what the money was spent on'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 99999999 then raise exception 'Enter an amount greater than zero'; end if;
  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer', 'qr', 'card') then raise exception 'Choose how it was paid'; end if;
  if p_tax_type is null or p_tax_type not in ('none', 'vat_included', 'vat_excluded', 'vat_noncreditable') then raise exception 'Choose the tax type'; end if;

  -- the bank account: required for a transfer or QR payment (an old app build cannot send one: posting will ask for it)
  if p_payment_method in ('bank_transfer', 'qr') then
    if p_legacy then v_bank := case when cl.payment_method in ('bank_transfer', 'qr') then cl.bank_account_id end;
    else
      if p_bank_account is null then raise exception 'Choose the bank account the money was paid from'; end if;
      if not exists (select 1 from public.finance_bank_accounts where id = p_bank_account and active) then raise exception 'Choose an active bank account'; end if;
      v_bank := p_bank_account;
    end if;
  end if;

  select * into st from public.expense_settings where id = 1;
  if p_tax_type <> 'none' and not st.vat_registered then raise exception 'VAT is not enabled for this business: choose “No VAT”'; end if;
  v_rate := case when p_tax_type = 'none' then 0 else st.vat_rate end;
  select c.paid, c.vat into v_paid, v_vat from public.expense_calc(p_amount, p_tax_type, v_rate) c;

  if p_id is null then
    insert into public.expense_claims (created_by, created_by_name, expense_date, payment_date, category_id, description, vendor, vendor_tax_id, reference_no, notes,
        payment_method, paid_from, tax_type, vat_rate, amount_paid, vat_amount, treatment, sku_code, bank_account_id)
    values (me, public.expense_actor_name(), p_expense_date, p_expense_date, v_cat, left(v_desc, 300), nullif(btrim(coalesce(p_vendor, '')), ''), nullif(btrim(coalesce(p_vendor_tax_id, '')), ''),
        nullif(btrim(coalesce(p_reference_no, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
        p_payment_method, case p_payment_method when 'cash' then 'cash' else 'bank' end, p_tax_type, v_rate, v_paid, v_vat, cat.treatment, v_sku, v_bank)
    returning * into cl;
    perform public.expense_log('expense', cl.id::text, cl.id, 'created', null, 'draft', null,
      jsonb_build_object('amount_paid', v_paid, 'category', cat.code, 'sku_code', v_sku, 'bank_account_id', v_bank, 'payment_method', p_payment_method));
  else
    update public.expense_claims set expense_date = p_expense_date, payment_date = p_expense_date, category_id = v_cat, description = left(v_desc, 300),
        vendor = nullif(btrim(coalesce(p_vendor, '')), ''), vendor_tax_id = nullif(btrim(coalesce(p_vendor_tax_id, '')), ''),
        reference_no = nullif(btrim(coalesce(p_reference_no, '')), ''), notes = nullif(btrim(coalesce(p_notes, '')), ''),
        payment_method = p_payment_method, paid_from = case p_payment_method when 'cash' then 'cash' else 'bank' end,
        tax_type = p_tax_type, vat_rate = v_rate, amount_paid = v_paid, vat_amount = v_vat, wht_rate = 0, wht_amount = 0, treatment = cat.treatment, account_override = null,
        sku_code = v_sku, bank_account_id = v_bank, reviewed_by = null, reviewed_at = null, review_note = null,   -- changed after a review: it must be checked again
        status = 'draft'
      where id = p_id returning * into cl;
    perform public.expense_log('expense', cl.id::text, cl.id, 'edited', null, cl.status, null,
      jsonb_build_object('amount_paid', v_paid, 'category', cat.code, 'sku_code', v_sku, 'bank_account_id', v_bank, 'payment_method', p_payment_method));
  end if;
  return cl;
end $$;

-- the current app: product and bank account
create or replace function public.expense_save(
  p_id uuid, p_expense_date date, p_category uuid, p_description text, p_amount numeric, p_tax_type text,
  p_payment_method text, p_vendor text, p_vendor_tax_id text, p_reference_no text, p_notes text, p_sku text, p_bank_account uuid)
returns public.expense_claims language sql security definer set search_path = public as $$
  select * from public.expense_save_core(p_id, p_expense_date, p_category, p_description, p_amount, p_tax_type, p_payment_method, p_vendor, p_vendor_tax_id, p_reference_no, p_notes, p_sku, p_bank_account, false)
$$;

-- old app builds (11 arguments): same as before; a claim keeps the product / bank account it already had
create or replace function public.expense_save(
  p_id uuid, p_expense_date date, p_category uuid, p_description text, p_amount numeric, p_tax_type text,
  p_payment_method text, p_vendor text, p_vendor_tax_id text, p_reference_no text, p_notes text)
returns public.expense_claims language sql security definer set search_path = public as $$
  select * from public.expense_save_core(p_id, p_expense_date, p_category, p_description, p_amount, p_tax_type, p_payment_method, p_vendor, p_vendor_tax_id, p_reference_no, p_notes, null, null, true)
$$;

-- ================================================================================================= 8. review, send back, tax review
-- "Reviewed" is a mark, not a stage: the posting step does not require it.
create or replace function public.expense_mark_reviewed(p_ids uuid[], p_note text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_n integer := 0; v_st text;
begin
  perform public.expense_require('approve_post', 'review expenses');
  if p_ids is null or cardinality(p_ids) = 0 then raise exception 'Choose at least one expense'; end if;
  if cardinality(p_ids) > 500 then raise exception 'At most 500 expenses at a time'; end if;
  for v_id, v_st in
    update public.expense_claims set reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), review_note)
     where id = any(p_ids) and status in ('draft', 'submitted', 'approved') returning id, status
  loop
    v_n := v_n + 1;
    perform public.expense_log('expense', v_id::text, v_id, 'reviewed', v_st, v_st, p_note, jsonb_build_object('mark', true));
  end loop;
  return v_n;
end $$;

create or replace function public.expense_reject(p_id uuid, p_reason text)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; old_status text;
begin
  if not public.expense_can('approve_post') then raise exception 'You are not allowed to send expenses back' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'A reason is required'; end if;
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status not in ('draft', 'submitted', 'approved') then raise exception 'Only expenses that are not posted yet can be sent back (this one is %)', cl.status; end if;
  if cl.status = 'draft' and cl.created_by = auth.uid() then raise exception 'This is your own draft: edit it instead of sending it back'; end if;
  old_status := cl.status;
  update public.expense_claims set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), reject_reason = btrim(p_reason),
      approved_by = null, approved_at = null, approval_note = null, reviewed_by = null, reviewed_at = null, review_note = null where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'rejected', old_status, 'rejected', p_reason, null);
  return cl;
end $$;

-- The accountant confirms the tax treatment (VAT, withholding tax, account). Allowed on any claim that is not posted yet.
create or replace function public.expense_review(
  p_id uuid, p_tax_type text, p_vat_amount numeric, p_wht_rate numeric, p_treatment text, p_account_override text, p_branch text, p_note text default null)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; st public.expense_settings; cat public.expense_categories; v_vat numeric; v_rate numeric; v_wht numeric;
begin
  perform public.expense_require('post', 'review expenses for posting');
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status not in ('draft', 'submitted', 'approved') then raise exception 'Only expenses that are not posted yet can be reviewed (this one is %)', cl.status; end if;
  if p_tax_type is null or p_tax_type not in ('none', 'vat_included', 'vat_excluded', 'vat_noncreditable') then raise exception 'Choose the tax type'; end if;
  select * into cat from public.expense_categories where id = cl.category_id;
  if cat.treatment = 'inventory' then
    if p_treatment is distinct from 'inventory' then raise exception 'A product bought for stock stays inventory: change the category instead'; end if;
  elsif p_treatment is null or p_treatment not in ('expense', 'fixed_asset') then raise exception 'Choose the accounting treatment'; end if;
  select * into st from public.expense_settings where id = 1;
  if p_tax_type <> 'none' and not st.vat_registered then raise exception 'VAT is not enabled for this business'; end if;
  v_vat := case when p_tax_type = 'none' then 0 else round(coalesce(p_vat_amount, 0), 2) end;
  if v_vat < 0 or v_vat >= cl.amount_paid then raise exception 'VAT must be at least 0 and less than the amount paid'; end if;
  v_rate := round(coalesce(p_wht_rate, 0), 2);
  if v_rate < 0 or v_rate > 15 then raise exception 'Withholding tax rate must be between 0 and 15 percent'; end if;
  v_wht := round((cl.amount_paid - v_vat) * v_rate / 100, 2);
  update public.expense_claims set tax_type = p_tax_type, vat_amount = v_vat, vat_rate = case when p_tax_type = 'none' then 0 else st.vat_rate end,
      wht_rate = v_rate, wht_amount = v_wht, treatment = p_treatment, account_override = case when p_treatment = 'inventory' then null else nullif(btrim(coalesce(p_account_override, '')), '') end,
      branch_id = nullif(btrim(coalesce(p_branch, '')), ''), reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'reviewed', cl.status, cl.status, p_note,
    jsonb_build_object('tax_type', p_tax_type, 'vat', v_vat, 'wht_rate', v_rate, 'wht', v_wht, 'treatment', p_treatment, 'account_override', p_account_override));
  return cl;
end $$;

-- ================================================================================================= 9. approve & post to accounting
-- Why a claim cannot be posted right now (null = it can). "CODE: text"; the app translates the code.
create or replace function public.expense_post_problem(cl public.expense_claims)
returns text language plpgsql stable security definer set search_path = public as $$
declare cat public.expense_categories;
begin
  if cl.status = 'posted' then return 'EXP_ALREADY_POSTED: This expense is already posted'; end if;
  if cl.status = 'cancelled' then return 'EXP_CANCELLED: This expense was cancelled'; end if;
  if cl.status = 'rejected' then return 'EXP_SENT_BACK: This expense was sent back to the employee to fix'; end if;
  if cl.status not in ('draft', 'submitted', 'approved') then return 'EXP_STATUS: This expense cannot be posted (' || cl.status || ')'; end if;
  if cl.expense_date > (now() at time zone 'Asia/Bangkok')::date then return 'EXP_FUTURE_DATE: The expense date is in the future'; end if;
  if not (cl.amount_paid > 0) or cl.vat_amount < 0 or cl.vat_amount >= cl.amount_paid or cl.wht_amount > cl.amount_paid - cl.vat_amount then return 'EXP_BAD_AMOUNT: The amounts are not consistent'; end if;
  select * into cat from public.expense_categories where id = cl.category_id;
  if coalesce(cl.account_override, cat.posting_role, cat.account_code) is null then return 'EXP_NOT_MAPPED: The category “' || cat.name_en || '” has no account yet (Settings → Categories)'; end if;
  if cl.payment_method in ('bank_transfer', 'qr') then
    if cl.bank_account_id is null then return 'EXP_BANK_REQUIRED: Choose the bank account the money was paid from'; end if;
    if not exists (select 1 from public.finance_bank_accounts where id = cl.bank_account_id and active) then return 'EXP_BANK_INACTIVE: The bank account is no longer active'; end if;
  end if;
  return null;
end $$;

-- What the confirmation shows before anything is done: each chosen expense with its problem (if any), and the totals.
create or replace function public.expense_post_preview(p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.expense_require('approve_post', 'approve and post expenses to accounting');
  if p_ids is null or cardinality(p_ids) > 500 then raise exception 'At most 500 expenses at a time'; end if;
  return (with x as (
      select c.id, c.expense_no, c.description, c.expense_date, c.amount_paid, c.wht_amount, c.payment_method, c.bank_account_id, c.status, c.created_by_name,
             public.expense_post_problem(c) problem, b.code bank_code, b.bank_name_th, b.bank_name_en, right(b.account_no, 4) bank_last4
        from public.expense_claims c left join public.finance_bank_accounts b on b.id = c.bank_account_id
       where c.id = any(p_ids))
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(to_jsonb(x) order by x.expense_date, x.id) from x), '[]'::jsonb),
      'missing', (select count(*) from unnest(p_ids) i where not exists (select 1 from x where x.id = i)),
      'ok_count', (select count(*) from x where problem is null),
      'ok_total', (select coalesce(sum(amount_paid), 0) from x where problem is null),
      'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', payment_method, 'n', n, 'amount', amt)) from (select payment_method, count(*) n, sum(amount_paid) amt from x where problem is null group by 1) m), '[]'::jsonb),
      'by_bank', coalesce((select jsonb_agg(jsonb_build_object('bank_account_id', bank_account_id, 'code', bank_code, 'bank_name_th', bank_name_th, 'bank_name_en', bank_name_en, 'last4', bank_last4, 'n', n, 'out', amt,
                     'balance', case when public.finance_bank_can_view() then (select balance from public.finance_bank_balances bb where bb.bank_account_id = q.bank_account_id) end))
                   from (select bank_account_id, bank_code, bank_name_th, bank_name_en, bank_last4, count(*) n, sum(amount_paid - wht_amount) amt from x
                          where problem is null and bank_account_id is not null and payment_method in ('bank_transfer', 'qr') group by 1, 2, 3, 4, 5) q), '[]'::jsonb)));
end $$;

-- Post ONE claim: claim -> posted, journal queued, bank moved, audit. Raises (nothing done) when it cannot be posted. Internal.
create or replace function public.expense_post_one(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); cl public.expense_claims; cat public.expense_categories; st public.expense_settings; bt public.finance_bank_transactions;
  v_prob text; v_paid numeric; v_vat numeric; v_wht numeric; v_creditable boolean; v_target text; v_plan jsonb; v_pay jsonb; v_q uuid; v_no text; v_n integer; v_from text;
  v_year integer := extract(year from (now() at time zone 'Asia/Bangkok'))::integer;
begin
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'EXP_NOT_FOUND: Expense not found'; end if;
  if cl.status = 'posted' then return jsonb_build_object('id', cl.id, 'result', 'already_posted', 'expense_no', cl.expense_no, 'amount', cl.amount_paid); end if;
  v_prob := public.expense_post_problem(cl);
  if v_prob is not null then raise exception using message = v_prob; end if;   -- already "EXP_CODE: text" (expense_post_problem)
  select * into cat from public.expense_categories where id = cl.category_id;
  select * into st from public.expense_settings where id = 1;
  v_paid := cl.amount_paid; v_vat := cl.vat_amount; v_wht := cl.wht_amount; v_from := cl.status;
  v_creditable := v_vat > 0 and cl.tax_type in ('vat_included', 'vat_excluded');           -- VAT that cannot be claimed stays in the cost
  v_target := coalesce(cl.account_override, cat.posting_role, cat.account_code);

  v_no := cl.expense_no;
  if v_no is null then
    insert into public.expense_counters (year, last_seq) values (v_year, 1) on conflict (year) do update set last_seq = public.expense_counters.last_seq + 1 returning last_seq into v_n;
    v_no := 'EXP-' || v_year || '-' || lpad(v_n::text, 6, '0');
  end if;

  -- the journal, as the accounting device will post it: Dr expense/stock (+ input VAT) / Cr cash or that bank (+ withholding tax payable)
  v_plan := jsonb_build_array(jsonb_build_object('side', 'dr', 'role', v_target, 'amount', case when v_creditable then v_paid - v_vat else v_paid end));
  if v_creditable then v_plan := v_plan || jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'input_vat', 'amount', v_vat)); end if;
  v_pay := jsonb_build_object('side', 'cr', 'role', case cl.paid_from when 'cash' then 'cash' else 'bank' end, 'amount', v_paid - v_wht);
  if cl.paid_from = 'bank' and cl.bank_account_id is not null then v_pay := v_pay || jsonb_build_object('bank_account_id', cl.bank_account_id); end if;
  v_plan := v_plan || jsonb_build_array(v_pay);
  if v_wht > 0 then v_plan := v_plan || jsonb_build_array(jsonb_build_object('side', 'cr', 'role', st.wht_account_code, 'amount', v_wht)); end if;

  insert into public.finance_gl_queue (event_type, ref_type, ref_id, ref_no, event_date, amount, plan, detail)
    values ('EXPENSE_PAYMENT', 'expense', cl.id, v_no, (cl.expense_date + time '12:00') at time zone 'Asia/Bangkok', v_paid, v_plan,
      jsonb_build_object('expense_no', v_no, 'description', cl.description, 'vendor', cl.vendor, 'vendor_tax_id', cl.vendor_tax_id, 'category_code', cat.code,
        'category_name_en', cat.name_en, 'category_name_th', cat.name_th, 'treatment', cl.treatment, 'tax_type', cl.tax_type, 'vat', case when v_creditable then v_vat else 0 end,
        'wht', v_wht, 'paid_from', cl.paid_from, 'payment_method', cl.payment_method, 'expense_date', cl.expense_date, 'branch_id', cl.branch_id, 'sku_code', cl.sku_code,
        'debit_account', v_target, 'claim_id', cl.id))
    returning id into v_q;

  if cl.bank_account_id is not null and cl.payment_method in ('bank_transfer', 'qr') then
    bt := public.finance_bank_apply(cl.bank_account_id, 'EXPENSE', 'out', v_paid - v_wht, cl.expense_date, 'expense', cl.id, v_no, 'EXPENSE:' || cl.id::text, null, v_q, left(cl.description, 200));
  end if;

  update public.expense_claims set status = 'posted', expense_no = v_no, posted_by = me, posted_at = now(), posting_date = cl.expense_date, posted_ref = 'EXPCLAIM:' || cl.id::text,
      gl_queue_id = v_q, bank_txn_id = bt.id, approved_by = coalesce(approved_by, me), approved_at = coalesce(approved_at, now())
    where id = cl.id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'posted', v_from, 'posted', null,
    jsonb_build_object('via', 'accounting_approval', 'gl_queue_id', v_q, 'bank_txn_no', bt.txn_no, 'bank_account_id', cl.bank_account_id, 'bank_out', bt.amount,
      'balance_after', bt.balance_after, 'amount', v_paid, 'self_posted', cl.created_by = me));
  return jsonb_build_object('id', cl.id, 'result', 'posted', 'expense_no', v_no, 'amount', v_paid, 'description', cl.description,
    'bank_txn_no', bt.txn_no, 'bank_out', bt.amount, 'bank_balance_after', case when public.finance_bank_can_view() then bt.balance_after end);
end $$;

-- Bulk: each expense is posted in its own sub-transaction (all of its records or none of them); the result lists every one.
create or replace function public.expense_post_bulk(p_ids uuid[], p_request text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; r jsonb; v_posted jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb; v_failed jsonb := '[]'::jsonb; v_total numeric := 0; m text;
begin
  perform public.expense_require('approve_post', 'approve and post expenses to accounting');
  if p_ids is null or cardinality(p_ids) = 0 then raise exception 'Choose at least one expense'; end if;
  if cardinality(p_ids) > 500 then raise exception 'At most 500 expenses at a time'; end if;
  for v_id in select distinct i from unnest(p_ids) i order by 1 loop                     -- one fixed order: two concurrent runs never deadlock
    begin
      r := public.expense_post_one(v_id);
      if r ->> 'result' = 'posted' then v_posted := v_posted || jsonb_build_array(r); v_total := v_total + (r ->> 'amount')::numeric;
      else v_skipped := v_skipped || jsonb_build_array(r); end if;
    exception when others then
      m := sqlerrm;
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('id', v_id, 'code', coalesce(substring(m from '^(EXP_[A-Z_]+):'), 'ERROR'), 'reason', m,
        'expense_no', (select expense_no from public.expense_claims where id = v_id), 'description', (select description from public.expense_claims where id = v_id),
        'amount', (select amount_paid from public.expense_claims where id = v_id)));
    end;
  end loop;
  perform public.expense_log('batch', left(coalesce(p_request, ''), 100), null, 'post.batch', null, null, null,
    jsonb_build_object('requested', cardinality(p_ids), 'posted', jsonb_array_length(v_posted), 'skipped', jsonb_array_length(v_skipped), 'failed', jsonb_array_length(v_failed), 'total', v_total));
  return jsonb_build_object('posted', v_posted, 'skipped', v_skipped, 'failed', v_failed, 'total_posted', v_total, 'request', p_request);
end $$;

-- ================================================================================================= 10. reversal
create or replace function public.expense_reverse(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims; q public.finance_gl_queue; ot public.finance_bank_transactions; bt public.finance_bank_transactions; v_rq uuid; v_plan jsonb; v_voided boolean := false;
begin
  perform public.expense_require('post', 'reverse posted expenses');
  if coalesce(length(btrim(p_reason)), 0) < 5 then raise exception 'A reason is required (at least 5 characters)'; end if;
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status = 'cancelled' and cl.posted_ref is not null then raise exception 'EXP_ALREADY_REVERSED: This expense was already reversed'; end if;
  if cl.status <> 'posted' then raise exception 'Only posted expenses can be reversed (this one is %)', cl.status; end if;
  if cl.gl_queue_id is null then raise exception 'EXP_LEDGER_DEVICE: This expense was posted on the accounting device: reverse it there'; end if;

  select * into q from public.finance_gl_queue where id = cl.gl_queue_id for update;
  if q.status = 'posted' then
    select jsonb_agg(l || jsonb_build_object('side', case l ->> 'side' when 'dr' then 'cr' else 'dr' end)) into v_plan from jsonb_array_elements(q.plan) l;
    insert into public.finance_gl_queue (event_type, ref_type, ref_id, ref_no, amount, plan, depends_on, detail)
      values ('EXPENSE_REVERSAL', 'expense', cl.id, cl.expense_no, q.amount, v_plan, q.id,
        coalesce(q.detail, '{}'::jsonb) || jsonb_build_object('reason', btrim(p_reason), 'reverses_queue_id', q.id, 'reverses_journal_no', q.journal_no))
      returning id into v_rq;
  elsif q.status = 'pending' then
    update public.finance_gl_queue set status = 'void', void_reason = left('Expense reversed before it reached the ledger: ' || btrim(p_reason), 500) where id = q.id;
    v_voided := true;
  end if;

  if cl.bank_txn_id is not null then
    select * into ot from public.finance_bank_transactions where id = cl.bank_txn_id;
    bt := public.finance_bank_apply(ot.bank_account_id, 'EXPENSE_REVERSAL', 'in', ot.amount, null, 'expense', cl.id, cl.expense_no, 'EXPENSE_REV:' || cl.id::text, ot.id, v_rq,
      left('Reversal of ' || ot.txn_no || ': ' || btrim(p_reason), 500));
  end if;

  update public.expense_claims set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason) where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'reversed', 'posted', 'cancelled', p_reason,
    jsonb_build_object('gl_voided', v_voided, 'reversal_queue_id', v_rq, 'bank_txn_no', bt.txn_no, 'bank_back', bt.amount, 'balance_after', bt.balance_after));
  return jsonb_build_object('id', cl.id, 'status', cl.status, 'gl_voided', v_voided, 'reversal_queue_id', v_rq, 'bank_txn_no', bt.txn_no, 'bank_back', bt.amount);
end $$;

-- the device-ledger reversal of the old flow cannot be used on a claim posted here (its bank movement would be left behind)
create or replace function public.expense_mark_reversed(p_id uuid, p_reversal_journal_no text, p_reason text)
returns public.expense_claims language plpgsql security definer set search_path = public as $$
declare cl public.expense_claims;
begin
  perform public.expense_require('post', 'reverse expenses');
  if nullif(btrim(coalesce(p_reason, '')), '') is null or nullif(btrim(coalesce(p_reversal_journal_no, '')), '') is null then raise exception 'The reversal journal and a reason are required'; end if;
  select * into cl from public.expense_claims where id = p_id for update;
  if not found then raise exception 'Expense not found'; end if;
  if cl.status <> 'posted' then raise exception 'Only posted expenses can be reversed (this one is %)', cl.status; end if;
  if cl.gl_queue_id is not null then raise exception 'This expense was posted through the accounting queue: use “Reverse posting” on the expense'; end if;
  update public.expense_claims set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason), reversal_journal_no = p_reversal_journal_no
    where id = p_id returning * into cl;
  perform public.expense_log('expense', cl.id::text, cl.id, 'reversed', 'posted', 'cancelled', p_reason, jsonb_build_object('reversal_journal_no', p_reversal_journal_no, 'journal_no', cl.journal_no));
  return cl;
end $$;

-- ================================================================================================= 11. traceability: expense -> journal -> bank
create or replace function public.expense_claim_links(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare cl public.expense_claims; v_bal boolean := public.finance_bank_can_view();
begin
  select * into cl from public.expense_claims where id = p_id;
  if not found or not (cl.created_by = auth.uid() or public.expense_can('view_all')) then raise exception 'Expense not found'; end if;
  return jsonb_build_object(
    'bank_account', (select jsonb_build_object('id', b.id, 'code', b.code, 'bank_name_th', b.bank_name_th, 'bank_name_en', b.bank_name_en, 'account_name', b.account_name, 'last4', right(b.account_no, 4), 'active', b.active)
                       from public.finance_bank_accounts b where b.id = cl.bank_account_id),
    'product', (select jsonb_build_object('sku_code', r.sku_code, 'name_th', coalesce(nullif(btrim(r.name_th), ''), nullif(btrim(r.name_full), ''), r.name_en),
                  'name_en', coalesce(nullif(btrim(r.name_en), ''), nullif(btrim(r.name_full), ''), r.name_th), 'sku_category', r.sku_category, 'status', r.status)
                  from public.sku_registry r where r.sku_code = cl.sku_code),
    'gl', (select jsonb_agg(jsonb_build_object('event_type', q.event_type, 'status', q.status, 'journal_no', q.journal_no, 'posted_at', q.posted_at, 'void_reason', q.void_reason, 'created_at', q.created_at) order by q.seq)
             from public.finance_gl_queue q where q.ref_type = 'expense' and q.ref_id = cl.id),
    'bank', (select jsonb_agg(jsonb_build_object('txn_no', t.txn_no, 'txn_type', t.txn_type, 'direction', t.direction, 'amount', t.amount, 'value_date', t.value_date, 'created_at', t.created_at,
                 'bank_code', b.code, 'balance_after', case when v_bal then t.balance_after end) order by t.seq)
               from public.finance_bank_transactions t join public.finance_bank_accounts b on b.id = t.bank_account_id where t.ref_type = 'expense' and t.ref_id = cl.id));
end $$;

-- ================================================================================================= 12. dashboard and categories
-- "Expenses" now include drafts (recorded, waiting for accounting approval); rejected and cancelled are not spending.
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
  ), counted as (select * from ranged where status in ('draft', 'submitted', 'approved', 'posted'))
  select jsonb_build_object(
    'today_total', (select coalesce(sum(amount_paid), 0) from base where status in ('draft', 'submitted', 'approved', 'posted') and expense_date = v_today),
    'month_total', (select coalesce(sum(amount_paid), 0) from base where status in ('draft', 'submitted', 'approved', 'posted') and expense_date >= v_month and expense_date <= v_today),
    'range_total', (select coalesce(sum(amount_paid), 0) from counted),
    'by_status',   (select coalesce(jsonb_object_agg(status, jsonb_build_object('n', n, 'amount', amt)), '{}'::jsonb) from (select status, count(*) n, sum(amount_paid) amt from ranged group by status) s),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category_id', s.category_id, 'code', k.code, 'name_en', k.name_en, 'name_th', k.name_th, 'icon', k.icon, 'n', s.n, 'amount', s.amt) order by s.amt desc), '[]'::jsonb)
                      from (select category_id, count(*) n, sum(amount_paid) amt from counted group by 1) s join public.expense_categories k on k.id = s.category_id),
    'by_method',   (select coalesce(jsonb_agg(jsonb_build_object('method', method, 'n', n, 'amount', amt) order by amt desc), '[]'::jsonb)
                      from (select payment_method as method, count(*) n, sum(amount_paid) amt from counted group by 1) s)
  ) into res;
  return res;
end $$;

-- A product category (inventory) keeps its treatment when edited from the settings screen, which only knows expense / fixed asset.
create or replace function public.expense_category_save(
  p_id uuid, p_code text, p_name_en text, p_name_th text, p_icon text, p_sort integer, p_treatment text, p_account_code text,
  p_default_tax_type text, p_default_wht_rate numeric, p_hint_en text, p_hint_th text, p_active boolean)
returns public.expense_categories language plpgsql security definer set search_path = public as $$
declare c public.expense_categories;
begin
  perform public.expense_require('config', 'change expense categories');
  if p_treatment = 'inventory' and p_id is null then raise exception 'Product categories (stock) are built in: create an expense or fixed-asset category'; end if;
  if p_id is null then
    insert into public.expense_categories (code, name_en, name_th, icon, sort, treatment, account_code, default_tax_type, default_wht_rate, hint_en, hint_th, active, updated_by)
    values (p_code, btrim(p_name_en), btrim(p_name_th), coalesce(p_icon, 'receipt'), coalesce(p_sort, 100), coalesce(p_treatment, 'expense'), nullif(btrim(coalesce(p_account_code, '')), ''),
            coalesce(p_default_tax_type, 'none'), p_default_wht_rate, nullif(btrim(coalesce(p_hint_en, '')), ''), nullif(btrim(coalesce(p_hint_th, '')), ''), coalesce(p_active, true), auth.uid())
    returning * into c;
  else
    update public.expense_categories set name_en = btrim(p_name_en), name_th = btrim(p_name_th), icon = coalesce(p_icon, icon), sort = coalesce(p_sort, sort),
        treatment = case when posting_role is not null then 'inventory' else coalesce(nullif(p_treatment, 'inventory'), treatment) end,
        account_code = nullif(btrim(coalesce(p_account_code, '')), ''), default_tax_type = coalesce(p_default_tax_type, default_tax_type),
        default_wht_rate = p_default_wht_rate, hint_en = nullif(btrim(coalesce(p_hint_en, '')), ''), hint_th = nullif(btrim(coalesce(p_hint_th, '')), ''),
        active = coalesce(p_active, active), updated_by = auth.uid(), updated_at = now()
      where id = p_id returning * into c;
    if not found then raise exception 'Category not found'; end if;
  end if;
  perform public.expense_log('category', c.id::text, null, case when p_id is null then 'category.created' else 'category.updated' end, null, null, null,
    jsonb_build_object('code', c.code, 'account_code', c.account_code, 'treatment', c.treatment, 'active', c.active, 'default_wht_rate', c.default_wht_rate));
  return c;
end $$;

-- ================================================================================================= 13. function access
revoke all on function public.expense_save_core(uuid, date, uuid, text, numeric, text, text, text, text, text, text, text, uuid, boolean), public.expense_post_one(uuid),
  public.expense_post_problem(public.expense_claims), public.expense_category_for_class(text),
  public.finance_bank_apply(uuid, text, text, numeric, date, text, uuid, text, text, uuid, uuid, text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text, text, uuid)', 'expense_bank_options()', 'expense_product_options()',
    'expense_mark_reviewed(uuid[], text)', 'expense_post_preview(uuid[])', 'expense_post_bulk(uuid[], text)', 'expense_reverse(uuid, text)', 'expense_claim_links(uuid)',
    'finance_bank_reconcile()', 'finance_bank_overview()', 'finance_bank_ledger(uuid, integer, integer)', 'finance_bank_opening(uuid, numeric, date, text)',
    'finance_bank_adjust(uuid, text, numeric, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
-- RLS policies call this as the signed-in user (it only reveals a boolean)
revoke all on function public.finance_bank_can_view() from public, anon;
grant execute on function public.finance_bank_can_view() to authenticated;
