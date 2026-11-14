-- Payment methods (bank accounts), customer wallet with an immutable ledger, wallet deposits, paying invoices from the wallet,
-- and the queue that carries every money event to the general ledger.
--
-- Principles
--   * Reuses the finance module (invoices, evidence/slips, verification, receipts, allocations, roles, audit, private slip bucket).
--     A bank transfer for an INVOICE still goes slip -> staff verification -> receipt/allocation. A bank transfer for a WALLET
--     DEPOSIT is a separate document (finance_wallet_deposits): it never touches an invoice, and uploading a slip never credits anything.
--   * The wallet balance is a projection of the ledger. The ONLY writer is finance_wallet_apply(): it locks the wallet row, checks
--     the balance can never go below zero, appends an immutable ledger row (balance before/after) and updates the balance in one
--     transaction. Direct updates of the balance are blocked by a trigger; ledger rows can never be changed or deleted
--     (corrections are reversal / adjustment rows). finance_wallet_reconcile() proves balance = ledger and an unbroken chain.
--   * The general ledger (journals, chart of accounts, period lock) lives on the accounting device, as for daily expenses.
--     Every money event writes a row into finance_gl_queue IN THE SAME TRANSACTION (so nothing can be forgotten); the accountant's
--     device posts the journal with the existing posting engine (roles bank / ar / customer_credit / sales) and calls
--     finance_gl_mark_posted(); a unique posted_ref makes a double posting impossible from either side.
--       deposit verified        Dr bank (that bank's GL account)   Cr customer credit liability (wallet)
--       wallet pays an invoice  Dr customer credit liability       Cr accounts receivable
--       bank slip verified      Dr bank                            Cr accounts receivable (and customer credit for any overpayment)
--       invoice issued          Dr accounts receivable             Cr sales (VAT split only after the accountant sets the tax mode)
--   * Backward compatible: old app builds keep working (finance_submit_evidence keeps its 8-argument form through a default).

-- ---------------------------------------------------------------------------------------------- settings
create table if not exists public.finance_settings (
  id boolean primary key default true check (id),
  min_deposit numeric(14, 2) not null default 1 check (min_deposit > 0),
  max_deposit numeric(14, 2) not null default 500000 check (max_deposit >= min_deposit),
  max_open_deposits integer not null default 5 check (max_open_deposits between 1 and 50),
  adjustment_limit numeric(14, 2) not null default 5000 check (adjustment_limit >= 0),   -- larger wallet adjustments need a SUPER_ADMIN
  adjustment_role text not null default 'settlement_variance' check (adjustment_role ~ '^[a-z_]{2,40}$'),   -- ledger role that takes the other side of an adjustment
  invoice_vat_mode text not null default 'unset' check (invoice_vat_mode in ('unset', 'none', 'inclusive')),   -- tax treatment of invoices in the ledger: the accountant's decision
  vat_rate numeric(5, 2) not null default 7 check (vat_rate >= 0 and vat_rate < 100),
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.finance_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------- bank accounts (the payment methods)
create table if not exists public.finance_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_]{2,12}$'),
  bank_name_en text not null check (length(bank_name_en) between 1 and 80),
  bank_name_th text not null check (length(bank_name_th) between 1 and 80),
  account_no text not null check (account_no ~ '^[0-9]{6,20}$'),
  account_name text not null check (length(account_name) between 1 and 120),
  branch text check (branch is null or length(branch) <= 80),
  logo_url text check (logo_url is null or logo_url ~ '^https://[^ ]+$'),
  instructions_th text check (instructions_th is null or length(instructions_th) <= 500),
  instructions_en text check (instructions_en is null or length(instructions_en) <= 500),
  gl_account_code text check (gl_account_code is null or gl_account_code ~ '^[0-9]{3,8}$'),   -- null = the ledger's default bank account
  sort_order integer not null default 100,
  active boolean not null default true,
  created_by uuid default auth.uid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists finance_bank_accounts_no on public.finance_bank_accounts (account_no);

-- the shop's own accounts, as given by the owner
insert into public.finance_bank_accounts (code, bank_name_en, bank_name_th, account_no, account_name, instructions_th, instructions_en, sort_order) values
  ('SCB', 'Siam Commercial Bank', 'ธนาคารไทยพาณิชย์', '5194026251', 'ณัฐพล อยู่ยิ้ม',
   'โอนเงินเข้าบัญชีนี้ตามยอดที่ระบุ แล้วอัปโหลดสลิปเพื่อให้ร้านตรวจสอบ ยอดจะอัปเดตหลังร้านตรวจสอบเสร็จ', 'Transfer the amount shown to this account, then upload your slip. Your balance updates once the shop has verified it.', 10),
  ('BBL', 'Bangkok Bank', 'ธนาคารกรุงเทพ', '9380319542', 'ณัฐพร อยู่ยิ้ม',
   'โอนเงินเข้าบัญชีนี้ตามยอดที่ระบุ แล้วอัปโหลดสลิปเพื่อให้ร้านตรวจสอบ ยอดจะอัปเดตหลังร้านตรวจสอบเสร็จ', 'Transfer the amount shown to this account, then upload your slip. Your balance updates once the shop has verified it.', 20)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------------------------- invoice evidence and receipts: bank + wallet
alter table public.finance_payment_evidence add column if not exists bank_account_id uuid references public.finance_bank_accounts (id) on delete restrict;
create index if not exists finance_evidence_bank_idx on public.finance_payment_evidence (bank_account_id) where bank_account_id is not null;

alter table public.finance_receipts add column if not exists bank_account_id uuid references public.finance_bank_accounts (id) on delete restrict;
alter table public.finance_receipts add column if not exists wallet_txn_id uuid;
alter table public.finance_receipts alter column evidence_id drop not null;       -- a wallet payment has no slip
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_receipts_source_chk' and conrelid = 'public.finance_receipts'::regclass) then
    alter table public.finance_receipts add constraint finance_receipts_source_chk check (evidence_id is not null or wallet_txn_id is not null);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------- wallet and ledger
create sequence if not exists public.finance_wallet_txn_seq;
create sequence if not exists public.finance_deposit_seq;

create table if not exists public.finance_wallets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.finance_customers (id) on delete restrict,
  balance numeric(14, 2) not null default 0 check (balance >= 0),                 -- never negative; a projection of the ledger
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.finance_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,                                  -- the order of the ledger: strictly increasing, never ties
  txn_no text not null unique,
  wallet_id uuid not null references public.finance_wallets (id) on delete restrict,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  txn_type text not null check (txn_type in ('DEPOSIT', 'INVOICE_PAYMENT', 'REFUND', 'ADJUSTMENT', 'WITHDRAWAL', 'REVERSAL')),
  direction text not null check (direction in ('credit', 'debit')),
  amount numeric(14, 2) not null check (amount > 0),
  balance_before numeric(14, 2) not null check (balance_before >= 0),
  balance_after numeric(14, 2) not null check (balance_after >= 0),
  ref_type text check (ref_type is null or ref_type in ('deposit', 'invoice', 'receipt', 'wallet_txn', 'manual')),
  ref_id uuid, ref_no text,
  payment_method text check (payment_method is null or payment_method in ('bank_transfer', 'wallet', 'promptpay', 'manual')),
  bank_account_id uuid references public.finance_bank_accounts (id) on delete restrict,
  verification_status text not null default 'not_required' check (verification_status in ('not_required', 'verified')),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 120),
  reversal_of uuid unique references public.finance_wallet_transactions (id) on delete restrict,
  created_by uuid, approved_by uuid,
  remarks text check (remarks is null or length(remarks) <= 500),                  -- internal
  customer_note text check (customer_note is null or length(customer_note) <= 200),   -- what the customer sees
  txn_date timestamptz not null default now(), created_at timestamptz not null default now(),
  check ((direction = 'credit' and balance_after = balance_before + amount) or (direction = 'debit' and balance_after = balance_before - amount)),
  check (txn_type not in ('DEPOSIT', 'REFUND') or direction = 'credit'),
  check (txn_type not in ('INVOICE_PAYMENT', 'WITHDRAWAL') or direction = 'debit')
);
create index if not exists finance_wallet_txn_wallet_idx on public.finance_wallet_transactions (wallet_id, created_at desc);
create index if not exists finance_wallet_txn_ref_idx on public.finance_wallet_transactions (ref_type, ref_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_receipts_wallet_txn_fk') then
    alter table public.finance_receipts add constraint finance_receipts_wallet_txn_fk foreign key (wallet_txn_id) references public.finance_wallet_transactions (id) on delete restrict;
    alter table public.finance_receipts add constraint finance_receipts_wallet_txn_key unique (wallet_txn_id);
  end if;
end $$;

-- the balance can only move through finance_wallet_apply(); ledger rows never change
create or replace function public.finance_guard_wallet()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'A wallet is never deleted'; end if;
  if new.customer_id is distinct from old.customer_id then raise exception 'A wallet cannot change owner'; end if;
  if new.balance is distinct from old.balance and coalesce(current_setting('finance.wallet_write', true), '') <> '1' then
    raise exception 'The wallet balance can only change through a ledger transaction'; end if;
  return new;
end $$;
drop trigger if exists finance_wallets_guard on public.finance_wallets;
create trigger finance_wallets_guard before update or delete on public.finance_wallets for each row execute function public.finance_guard_wallet();

create or replace function public.finance_wallet_txn_immutable()
returns trigger language plpgsql as $$ begin raise exception 'Wallet transactions are never changed or deleted: correct them with a reversal or an adjustment'; end $$;
drop trigger if exists finance_wallet_txn_no_change on public.finance_wallet_transactions;
create trigger finance_wallet_txn_no_change before update or delete on public.finance_wallet_transactions for each row execute function public.finance_wallet_txn_immutable();

-- ---------------------------------------------------------------------------------------------- wallet deposits (a bank transfer INTO the wallet)
create table if not exists public.finance_wallet_deposits (
  id uuid primary key default gen_random_uuid(),
  deposit_no text not null unique,                                                 -- the payment reference the customer puts on the transfer
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  bank_account_id uuid not null references public.finance_bank_accounts (id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),                              -- what the customer says they will send: never what is credited
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  status text not null default 'pending' check (status in ('pending', 'submitted', 'under_review', 'verified', 'rejected', 'cancelled')),
  customer_ref text check (customer_ref is null or length(customer_ref) <= 80),
  file_path text, file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'), file_type text check (file_type is null or file_type in ('image/jpeg', 'image/png', 'application/pdf')),
  claimed_transfer_at timestamptz, submitted_at timestamptz,
  verified_amount numeric(14, 2) check (verified_amount is null or verified_amount > 0),
  bank_trans_ref text check (bank_trans_ref is null or length(bank_trans_ref) between 4 and 80),
  transfer_at timestamptz,
  review_note text, reject_reason text,
  reviewed_by uuid, reviewed_at timestamptz,
  wallet_txn_id uuid unique references public.finance_wallet_transactions (id) on delete restrict,
  created_by uuid default auth.uid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (customer_id, idempotency_key),
  check (status <> 'verified' or (verified_amount is not null and bank_trans_ref is not null and wallet_txn_id is not null)),
  check (status not in ('submitted', 'under_review', 'verified') or file_path is not null)
);
create unique index if not exists finance_deposit_slip_once on public.finance_wallet_deposits (file_sha256) where file_sha256 is not null and status not in ('rejected', 'cancelled');
create unique index if not exists finance_deposit_transref_once on public.finance_wallet_deposits (bank_trans_ref) where status = 'verified';
create index if not exists finance_deposit_queue_idx on public.finance_wallet_deposits (status, created_at);
create index if not exists finance_deposit_customer_idx on public.finance_wallet_deposits (customer_id, created_at desc);

create or replace function public.finance_guard_deposit()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Financial records are never deleted'; end if;
  if new.customer_id is distinct from old.customer_id or new.bank_account_id is distinct from old.bank_account_id or new.amount is distinct from old.amount
     or new.deposit_no is distinct from old.deposit_no or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'A deposit''s customer, bank account, amount and number cannot be changed'; end if;
  if old.status in ('verified', 'rejected', 'cancelled') and new.status is distinct from old.status then raise exception 'This deposit is already %', old.status; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists finance_deposits_guard on public.finance_wallet_deposits;
create trigger finance_deposits_guard before update or delete on public.finance_wallet_deposits for each row execute function public.finance_guard_deposit();

-- ---------------------------------------------------------------------------------------------- general-ledger queue
create table if not exists public.finance_gl_queue (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  event_type text not null check (event_type in ('INVOICE_ISSUE', 'INVOICE_CANCEL', 'BANK_RECEIPT', 'RECEIPT_REAPPLY', 'RECEIPT_REVERSAL', 'WALLET_DEPOSIT', 'WALLET_PAYMENT',
                                                  'WALLET_REFUND', 'WALLET_ADJUSTMENT', 'WALLET_REVERSAL')),
  ref_type text not null, ref_id uuid not null, ref_no text,
  customer_id uuid references public.finance_customers (id) on delete restrict,
  event_date timestamptz not null default now(),
  amount numeric(14, 2) not null check (amount > 0),
  plan jsonb not null check (jsonb_typeof(plan) = 'array' and jsonb_array_length(plan) between 2 and 6),   -- [{side, role, amount, bank_account_id?, wallet?, vat?}]
  depends_on uuid references public.finance_gl_queue (id) on delete restrict,                          -- post this one first (e.g. the invoice before its payment)
  status text not null default 'pending' check (status in ('pending', 'posted', 'void')),
  journal_no text, posted_ref text unique, posted_by uuid, posted_at timestamptz, void_reason text,
  created_at timestamptz not null default now(),
  unique (event_type, ref_id),
  check (status <> 'posted' or (journal_no is not null and posted_ref is not null and posted_at is not null)),
  check (status <> 'void' or void_reason is not null)
);
create index if not exists finance_gl_queue_status_idx on public.finance_gl_queue (status, seq);

create or replace function public.finance_guard_gl_queue()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Ledger queue rows are never deleted'; end if;
  if new.event_type is distinct from old.event_type or new.ref_id is distinct from old.ref_id or new.amount is distinct from old.amount or new.plan is distinct from old.plan
     or new.customer_id is distinct from old.customer_id or new.depends_on is distinct from old.depends_on then
    raise exception 'A ledger queue row cannot be changed (void it and enqueue the correction)'; end if;
  if old.status <> 'pending' and new.status is distinct from old.status then raise exception 'This ledger row is already %', old.status; end if;
  return new;
end $$;
drop trigger if exists finance_gl_queue_guard on public.finance_gl_queue;
create trigger finance_gl_queue_guard before update or delete on public.finance_gl_queue for each row execute function public.finance_guard_gl_queue();

-- internal: add a row (idempotent per event + document)
create or replace function public.finance_gl_enqueue(p_type text, p_ref_type text, p_ref_id uuid, p_ref_no text, p_customer uuid, p_amount numeric, p_plan jsonb, p_depends uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.finance_gl_queue (event_type, ref_type, ref_id, ref_no, customer_id, amount, plan, depends_on)
    values (p_type, p_ref_type, p_ref_id, p_ref_no, p_customer, p_amount, p_plan, p_depends)
    on conflict (event_type, ref_id) do nothing returning id into v_id;
  return v_id;
end $$;

-- the invoice row that must be in the ledger before a payment on it can be (null when it is already posted)
create or replace function public.finance_gl_issue_dep(p_invoice uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = p_invoice and status = 'pending'
$$;

-- an invoice is a sale on credit: Dr receivable / Cr sales. Cancelled before it was posted: both rows disappear; after: reversed.
create or replace function public.finance_gl_invoice_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_issue uuid;
begin
  if tg_op = 'INSERT' then
    perform public.finance_gl_enqueue('INVOICE_ISSUE', 'invoice', new.id, new.invoice_no, new.customer_id, new.amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', new.amount), jsonb_build_object('side', 'cr', 'role', 'sales', 'amount', new.amount, 'vat', 'split')));
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    select id into v_issue from public.finance_gl_queue where event_type = 'INVOICE_ISSUE' and ref_id = new.id;
    if v_issue is not null and (select status from public.finance_gl_queue where id = v_issue) = 'pending' then
      update public.finance_gl_queue set status = 'void', void_reason = 'The invoice was cancelled before it was posted' where id = v_issue;
    elsif v_issue is not null then
      perform public.finance_gl_enqueue('INVOICE_CANCEL', 'invoice', new.id, new.invoice_no, new.customer_id, new.amount,
        jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'sales', 'amount', new.amount, 'vat', 'split'), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', new.amount)), v_issue);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists finance_invoices_gl on public.finance_invoices;
create trigger finance_invoices_gl after insert or update of status on public.finance_invoices for each row execute function public.finance_gl_invoice_trigger();

-- ---------------------------------------------------------------------------------------------- helpers
create or replace function public.finance_ensure_customer()
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_prof public.profiles;
begin
  if v_uid is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select id into v_id from public.finance_customers where profile_id = v_uid;
  if v_id is not null then return v_id; end if;
  select * into v_prof from public.profiles where id = v_uid and status = 'active';
  if not found then raise exception 'This account is not active' using errcode = '42501'; end if;
  insert into public.finance_customers (code, name, profile_id, created_by)
    values ('LINE-' || upper(substr(replace(v_uid::text, '-', ''), 1, 10)), coalesce(nullif(btrim(v_prof.display_name), ''), 'Customer'), v_uid, v_uid)
    returning id into v_id;
  return v_id;
end $$;

-- THE ONLY WRITER OF A WALLET BALANCE. Locks the wallet, refuses to go below zero, appends the ledger row, updates the balance.
-- Retrying with the same idempotency key returns the original row and changes nothing.
create or replace function public.finance_wallet_apply(p_customer uuid, p_type text, p_direction text, p_amount numeric, p_key text, p_ref_type text, p_ref_id uuid, p_ref_no text,
  p_method text, p_bank uuid, p_status text, p_by uuid, p_approved_by uuid, p_remarks text, p_note text default null, p_reversal_of uuid default null)
returns public.finance_wallet_transactions language plpgsql security definer set search_path = public as $$
declare v_w public.finance_wallets; v_t public.finance_wallet_transactions; v_after numeric;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT' using errcode = '22023'; end if;
  insert into public.finance_wallets (customer_id) values (p_customer) on conflict (customer_id) do nothing;
  select * into v_w from public.finance_wallets where customer_id = p_customer for update;           -- serialises every movement of this wallet
  select * into v_t from public.finance_wallet_transactions where idempotency_key = p_key;
  if found then
    if v_t.customer_id <> p_customer or v_t.amount <> p_amount or v_t.txn_type <> p_type then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return v_t;
  end if;
  v_after := case when p_direction = 'credit' then v_w.balance + p_amount else v_w.balance - p_amount end;
  if v_after < 0 then raise exception 'INSUFFICIENT_FUNDS' using errcode = '23514', detail = v_w.balance::text; end if;
  perform set_config('finance.wallet_write', '1', true);
  update public.finance_wallets set balance = v_after, updated_at = now() where id = v_w.id;
  perform set_config('finance.wallet_write', '0', true);
  insert into public.finance_wallet_transactions (txn_no, wallet_id, customer_id, txn_type, direction, amount, balance_before, balance_after, ref_type, ref_id, ref_no, payment_method,
      bank_account_id, verification_status, idempotency_key, reversal_of, created_by, approved_by, remarks, customer_note)
    values ('WT-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_wallet_txn_seq')::text, 5, '0'), v_w.id, p_customer, p_type, p_direction, p_amount,
            v_w.balance, v_after, p_ref_type, p_ref_id, p_ref_no, p_method, p_bank, p_status, p_key, p_reversal_of, p_by, p_approved_by, nullif(btrim(p_remarks), ''), nullif(btrim(p_note), ''))
    returning * into v_t;
  perform public.finance_log('wallet', v_t.id, 'wallet.' || lower(p_type), jsonb_build_object('no', v_t.txn_no, 'direction', p_direction, 'amount', p_amount, 'before', v_w.balance, 'after', v_after,
    'customer', p_customer, 'ref', p_ref_no));
  return v_t;
end $$;

-- ---------------------------------------------------------------------------------------------- bank accounts: read + manage
create or replace function public.finance_payment_methods()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_cust uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  v_cust := public.finance_my_customer();
  return jsonb_build_object(
    'banks', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'bank_name_en', b.bank_name_en, 'bank_name_th', b.bank_name_th, 'account_no', b.account_no,
        'account_name', b.account_name, 'logo_url', b.logo_url, 'instructions_th', b.instructions_th, 'instructions_en', b.instructions_en) order by b.sort_order, b.code), '[]'::jsonb)
      from public.finance_bank_accounts b where b.active),
    'promptpay', exists (select 1 from public.finance_payment_accounts where is_default and active),
    'wallet', jsonb_build_object('balance', coalesce((select w.balance from public.finance_wallets w where w.customer_id = v_cust), 0),
      'min_deposit', (select min_deposit from public.finance_settings where id), 'max_deposit', (select max_deposit from public.finance_settings where id)));
end $$;

create or replace function public.finance_save_bank_account(p_id uuid, p_code text, p_bank_name_en text, p_bank_name_th text, p_account_no text, p_account_name text,
  p_branch text, p_logo_url text, p_instructions_th text, p_instructions_en text, p_gl_account_code text, p_sort_order integer, p_active boolean)
returns public.finance_bank_accounts language plpgsql security definer set search_path = public as $$
declare v_old public.finance_bank_accounts; v_new public.finance_bank_accounts; v_used boolean;
begin
  perform public.finance_require('manage', 'manage bank accounts');
  if p_id is null then
    insert into public.finance_bank_accounts (code, bank_name_en, bank_name_th, account_no, account_name, branch, logo_url, instructions_th, instructions_en, gl_account_code, sort_order, active)
      values (upper(btrim(p_code)), btrim(p_bank_name_en), btrim(p_bank_name_th), regexp_replace(coalesce(p_account_no, ''), '[^0-9]', '', 'g'), btrim(p_account_name), nullif(btrim(p_branch), ''),
              nullif(btrim(p_logo_url), ''), nullif(btrim(p_instructions_th), ''), nullif(btrim(p_instructions_en), ''), nullif(btrim(p_gl_account_code), ''), coalesce(p_sort_order, 100), coalesce(p_active, true))
      returning * into v_new;
    perform public.finance_log('bank_account', v_new.id, 'bank.create', jsonb_build_object('code', v_new.code, 'account_no', v_new.account_no));
    return v_new;
  end if;
  select * into v_old from public.finance_bank_accounts where id = p_id for update;
  if not found then raise exception 'Bank account not found'; end if;
  v_used := exists (select 1 from public.finance_wallet_deposits where bank_account_id = p_id) or exists (select 1 from public.finance_payment_evidence where bank_account_id = p_id)
         or exists (select 1 from public.finance_receipts where bank_account_id = p_id);
  if v_used and (regexp_replace(coalesce(p_account_no, ''), '[^0-9]', '', 'g') <> v_old.account_no or btrim(p_account_name) <> v_old.account_name or upper(btrim(p_code)) <> v_old.code) then
    raise exception 'Payments are recorded on this account: add a new account and deactivate this one instead of changing its number, holder or code'; end if;
  update public.finance_bank_accounts set code = upper(btrim(p_code)), bank_name_en = btrim(p_bank_name_en), bank_name_th = btrim(p_bank_name_th),
    account_no = regexp_replace(coalesce(p_account_no, ''), '[^0-9]', '', 'g'), account_name = btrim(p_account_name), branch = nullif(btrim(p_branch), ''), logo_url = nullif(btrim(p_logo_url), ''),
    instructions_th = nullif(btrim(p_instructions_th), ''), instructions_en = nullif(btrim(p_instructions_en), ''), gl_account_code = nullif(btrim(p_gl_account_code), ''),
    sort_order = coalesce(p_sort_order, sort_order), active = coalesce(p_active, active), updated_at = now()
    where id = p_id returning * into v_new;
  perform public.finance_log('bank_account', p_id, 'bank.update', jsonb_build_object('code', v_new.code, 'active', v_new.active, 'gl', v_new.gl_account_code));
  return v_new;
end $$;

create or replace function public.finance_save_settings(p_patch jsonb)
returns public.finance_settings language plpgsql security definer set search_path = public as $$
declare v_s public.finance_settings;
begin
  perform public.finance_require('manage', 'change the payment settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Nothing to save'; end if;
  update public.finance_settings set
    min_deposit = case when p_patch ? 'min_deposit' then (p_patch ->> 'min_deposit')::numeric else min_deposit end,
    max_deposit = case when p_patch ? 'max_deposit' then (p_patch ->> 'max_deposit')::numeric else max_deposit end,
    max_open_deposits = case when p_patch ? 'max_open_deposits' then (p_patch ->> 'max_open_deposits')::int else max_open_deposits end,
    adjustment_limit = case when p_patch ? 'adjustment_limit' then (p_patch ->> 'adjustment_limit')::numeric else adjustment_limit end,
    adjustment_role = case when p_patch ? 'adjustment_role' then p_patch ->> 'adjustment_role' else adjustment_role end,
    invoice_vat_mode = case when p_patch ? 'invoice_vat_mode' then p_patch ->> 'invoice_vat_mode' else invoice_vat_mode end,
    vat_rate = case when p_patch ? 'vat_rate' then (p_patch ->> 'vat_rate')::numeric else vat_rate end,
    updated_by = auth.uid(), updated_at = now() where id returning * into v_s;
  perform public.finance_log('settings', gen_random_uuid(), 'settings.save', p_patch);
  return v_s;
end $$;

-- ---------------------------------------------------------------------------------------------- customer: deposits
create or replace function public.finance_deposit_create(p_bank uuid, p_amount numeric, p_key text, p_customer_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cust uuid; v_s public.finance_settings; v_d public.finance_wallet_deposits; v_bank public.finance_bank_accounts;
begin
  v_cust := public.finance_ensure_customer();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('deposit:' || v_cust::text || ':' || p_key, 0));
  select * into v_d from public.finance_wallet_deposits where customer_id = v_cust and idempotency_key = p_key;
  if found then
    if v_d.amount <> p_amount or v_d.bank_account_id <> p_bank then raise exception 'KEY_REUSED' using errcode = '23505'; end if;
    return to_jsonb(v_d) - 'created_by' - 'reviewed_by' - 'review_note';
  end if;
  select * into v_s from public.finance_settings where id;
  select * into v_bank from public.finance_bank_accounts where id = p_bank and active;
  if not found then raise exception 'BANK_NOT_AVAILABLE'; end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount < v_s.min_deposit or p_amount > v_s.max_deposit then
    raise exception 'AMOUNT_OUT_OF_RANGE' using detail = v_s.min_deposit::text || '-' || v_s.max_deposit::text; end if;
  if (select count(*) from public.finance_wallet_deposits where customer_id = v_cust and status in ('pending', 'submitted', 'under_review')) >= v_s.max_open_deposits then
    raise exception 'TOO_MANY_OPEN_DEPOSITS'; end if;
  insert into public.finance_wallet_deposits (deposit_no, customer_id, bank_account_id, amount, idempotency_key, customer_ref)
    values ('DP-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMM') || '-' || lpad(nextval('public.finance_deposit_seq')::text, 5, '0'), v_cust, p_bank, p_amount, p_key, nullif(btrim(p_customer_ref), ''))
    returning * into v_d;
  perform public.finance_log('deposit', v_d.id, 'deposit.create', jsonb_build_object('no', v_d.deposit_no, 'amount', p_amount, 'bank', v_bank.code));
  return to_jsonb(v_d) - 'created_by' - 'reviewed_by' - 'review_note';
end $$;

create or replace function public.finance_deposit_submit_slip(p_deposit uuid, p_file_path text, p_sha256 text, p_file_type text, p_transfer_at timestamptz, p_customer_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d public.finance_wallet_deposits; v_cust uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  v_cust := public.finance_my_customer();
  select * into v_d from public.finance_wallet_deposits where id = p_deposit for update;
  if not found or v_d.customer_id is distinct from v_cust then raise exception 'Deposit not found' using errcode = '42501'; end if;
  if v_d.status <> 'pending' then raise exception 'DEPOSIT_NOT_PENDING'; end if;
  if p_file_path is null or split_part(p_file_path, '/', 1) <> auth.uid()::text or p_file_path ~ '\.\.' then raise exception 'Invalid file' using errcode = '22023'; end if;
  if p_file_type not in ('image/jpeg', 'image/png', 'application/pdf') or p_sha256 !~ '^[0-9a-fA-F]{64}$' then raise exception 'Invalid file' using errcode = '22023'; end if;
  if exists (select 1 from public.finance_wallet_deposits where file_sha256 = lower(p_sha256) and status not in ('rejected', 'cancelled'))
     or exists (select 1 from public.finance_payment_evidence where file_sha256 = lower(p_sha256) and status <> 'rejected') then
    raise exception 'SLIP_ALREADY_USED' using errcode = '23505'; end if;
  if p_transfer_at is not null and p_transfer_at > now() + interval '10 minutes' then raise exception 'The transfer time is in the future'; end if;
  update public.finance_wallet_deposits set status = 'submitted', file_path = p_file_path, file_sha256 = lower(p_sha256), file_type = p_file_type, claimed_transfer_at = p_transfer_at,
    customer_ref = coalesce(nullif(btrim(p_customer_ref), ''), customer_ref), submitted_at = now() where id = p_deposit returning * into v_d;
  perform public.finance_log('deposit', v_d.id, 'deposit.submit', jsonb_build_object('no', v_d.deposit_no));
  return to_jsonb(v_d) - 'created_by' - 'reviewed_by' - 'review_note';
end $$;

create or replace function public.finance_deposit_cancel(p_deposit uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d public.finance_wallet_deposits;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into v_d from public.finance_wallet_deposits where id = p_deposit for update;
  if not found or v_d.customer_id is distinct from public.finance_my_customer() then raise exception 'Deposit not found' using errcode = '42501'; end if;
  if v_d.status not in ('pending', 'submitted') then raise exception 'DEPOSIT_NOT_CANCELLABLE'; end if;
  update public.finance_wallet_deposits set status = 'cancelled' where id = p_deposit returning * into v_d;
  perform public.finance_log('deposit', v_d.id, 'deposit.cancel', jsonb_build_object('no', v_d.deposit_no));
  return to_jsonb(v_d) - 'created_by' - 'reviewed_by' - 'review_note';
end $$;

-- ---------------------------------------------------------------------------------------------- staff: deposit review
create or replace function public.finance_deposit_start_review(p_deposit uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_require('verify', 'review deposits');
  update public.finance_wallet_deposits set status = 'under_review', reviewed_by = auth.uid() where id = p_deposit and status = 'submitted';
  if not found then raise exception 'Only a submitted deposit can be put under review'; end if;
  perform public.finance_log('deposit', p_deposit, 'deposit.review', '{}'::jsonb);
end $$;

-- Verify against the bank record: the wallet is credited with the amount the BANK shows, never with the customer's claim.
create or replace function public.finance_deposit_verify(p_deposit uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d public.finance_wallet_deposits; v_t public.finance_wallet_transactions; v_bank public.finance_bank_accounts; v_cust public.finance_customers;
begin
  perform public.finance_require('verify', 'verify deposits');
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if coalesce(trim(p_bank_trans_ref), '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  select * into v_d from public.finance_wallet_deposits where id = p_deposit for update;
  if not found then raise exception 'Deposit not found'; end if;
  if v_d.status not in ('submitted', 'under_review') then raise exception 'DEPOSIT_NOT_REVIEWABLE: this deposit is %', v_d.status; end if;
  if exists (select 1 from public.finance_receipts where bank_trans_ref = trim(p_bank_trans_ref)) or exists (select 1 from public.finance_wallet_deposits where bank_trans_ref = trim(p_bank_trans_ref) and status = 'verified') then
    raise exception 'Bank transaction % was already recorded (reused slip?)', trim(p_bank_trans_ref) using errcode = '23505'; end if;
  if p_transfer_at < v_d.created_at - interval '1 day' then raise exception 'The transfer is older than the deposit request'; end if;
  select * into v_bank from public.finance_bank_accounts where id = v_d.bank_account_id;
  select * into v_cust from public.finance_customers where id = v_d.customer_id;
  v_t := public.finance_wallet_apply(v_d.customer_id, 'DEPOSIT', 'credit', p_amount, 'DEP:' || v_d.id::text, 'deposit', v_d.id, v_d.deposit_no, 'bank_transfer', v_d.bank_account_id, 'verified',
                                     v_cust.profile_id, auth.uid(), 'Verified bank transfer ' || trim(p_bank_trans_ref), null);
  update public.finance_wallet_deposits set status = 'verified', verified_amount = p_amount, bank_trans_ref = trim(p_bank_trans_ref), transfer_at = p_transfer_at,
    review_note = nullif(btrim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now(), wallet_txn_id = v_t.id where id = p_deposit returning * into v_d;
  perform public.finance_gl_enqueue('WALLET_DEPOSIT', 'wallet_txn', v_t.id, v_t.txn_no, v_d.customer_id, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', v_d.bank_account_id),
                      jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true)));
  perform public.finance_log('deposit', v_d.id, 'deposit.verify', jsonb_build_object('no', v_d.deposit_no, 'claimed', v_d.amount, 'verified', p_amount, 'trans_ref', trim(p_bank_trans_ref), 'txn', v_t.txn_no));
  return jsonb_build_object('deposit', to_jsonb(v_d), 'txn_no', v_t.txn_no, 'balance', v_t.balance_after);
end $$;

create or replace function public.finance_deposit_reject(p_deposit uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_require('verify', 'reject deposits');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  update public.finance_wallet_deposits set status = 'rejected', reject_reason = trim(p_reason), reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_deposit and status in ('submitted', 'under_review');
  if not found then raise exception 'Only a submitted deposit can be rejected'; end if;
  perform public.finance_log('deposit', p_deposit, 'deposit.reject', jsonb_build_object('reason', trim(p_reason)));
end $$;

-- ---------------------------------------------------------------------------------------------- customer: pay an invoice from the wallet
create or replace function public.finance_pay_invoice_with_wallet(p_invoice uuid, p_amount numeric, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cust uuid; v_i public.finance_invoices; v_st jsonb; v_out numeric; v_t public.finance_wallet_transactions; v_rc public.finance_receipts; v_key text; v_existing public.finance_receipts;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  v_cust := public.finance_my_customer();
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  v_key := 'INVPAY:' || coalesce(v_cust::text, '-') || ':' || p_key;
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  select * into v_i from public.finance_invoices where id = p_invoice for update;                       -- invoice first, wallet last (one lock order everywhere)
  if not found or v_cust is null or v_i.customer_id is distinct from v_cust then raise exception 'Invoice not found' using errcode = '42501'; end if;
  select r.* into v_existing from public.finance_receipts r join public.finance_wallet_transactions t on t.id = r.wallet_txn_id where t.idempotency_key = v_key;
  if found then
    return jsonb_build_object('replay', true, 'receipt_no', v_existing.receipt_no, 'state', public.finance_invoice_state_raw(p_invoice),
      'balance', (select balance from public.finance_wallets where customer_id = v_cust));
  end if;
  if v_i.status <> 'open' then raise exception 'INVOICE_NOT_OPEN: this invoice is %', v_i.status; end if;
  v_st := public.finance_invoice_state_raw(p_invoice);
  v_out := (v_st ->> 'outstanding')::numeric;
  if (v_st ->> 'status_code')::int = 6 then raise exception 'PAYMENT_UNDER_REVIEW'; end if;
  if v_out <= 0 then raise exception 'NOTHING_OUTSTANDING'; end if;
  if p_amount is null then p_amount := v_out; end if;
  if p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT' using errcode = '22023'; end if;
  if p_amount > v_out then raise exception 'AMOUNT_EXCEEDS_OUTSTANDING' using detail = v_out::text; end if;
  v_t := public.finance_wallet_apply(v_cust, 'INVOICE_PAYMENT', 'debit', p_amount, v_key, 'invoice', v_i.id, v_i.invoice_no, 'wallet', null, 'not_required', auth.uid(), null, 'Paid from the wallet', null);
  insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, wallet_txn_id, amount, method, received_at, needs_review)
    values ('RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0'), v_cust, v_i.id, null, v_t.id, p_amount, 'wallet', now(), false)
    returning * into v_rc;
  insert into public.finance_allocations (receipt_id, invoice_id, amount) values (v_rc.id, v_i.id, p_amount);
  perform public.finance_gl_enqueue('WALLET_PAYMENT', 'wallet_txn', v_t.id, v_t.txn_no, v_cust, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', p_amount)),
    public.finance_gl_issue_dep(v_i.id));
  perform public.finance_log('receipt', v_rc.id, 'receipt.post', jsonb_build_object('invoice', v_i.id, 'amount', p_amount, 'outstanding_before', v_out, 'result', 'wallet', 'wallet_txn', v_t.txn_no));
  return jsonb_build_object('replay', false, 'receipt_no', v_rc.receipt_no, 'txn_no', v_t.txn_no, 'balance', v_t.balance_after, 'state', public.finance_invoice_state_raw(p_invoice));
end $$;

-- ---------------------------------------------------------------------------------------------- invoice slips: now know which bank was paid
drop function if exists public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text);
create or replace function public.finance_submit_evidence(p_invoice uuid, p_file_path text, p_sha256 text, p_file_type text,
  p_claimed_amount numeric, p_transfer_at timestamptz, p_bank text, p_ref text, p_bank_account uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices; e uuid; req uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into i from public.finance_invoices where id = p_invoice for update;
  if not found or (i.customer_id is distinct from public.finance_my_customer() and not public.finance_can('invoice')) then
    raise exception 'Invoice not found' using errcode = '42501'; end if;
  if i.status <> 'open' then raise exception 'This invoice is %', i.status; end if;
  if p_bank_account is not null and not exists (select 1 from public.finance_bank_accounts where id = p_bank_account and active) then raise exception 'BANK_NOT_AVAILABLE'; end if;
  if p_file_path is null or split_part(p_file_path, '/', 1) <> auth.uid()::text or p_file_path ~ '\.\.' then raise exception 'Invalid file' using errcode = '22023'; end if;
  if (select count(*) from public.finance_payment_evidence where invoice_id = p_invoice and status = 'submitted') >= 5 then
    raise exception 'Several slips for this invoice are already waiting to be checked'; end if;
  if exists (select 1 from public.finance_payment_evidence where file_sha256 = lower(p_sha256) and status <> 'rejected')
     or exists (select 1 from public.finance_wallet_deposits where file_sha256 = lower(p_sha256) and status not in ('rejected', 'cancelled')) then
    raise exception 'This slip was already submitted' using errcode = '23505'; end if;
  if p_transfer_at is not null and p_transfer_at > now() + interval '10 minutes' then raise exception 'The transfer time is in the future'; end if;
  select id into req from public.finance_payment_requests where invoice_id = p_invoice order by created_at desc limit 1;
  insert into public.finance_payment_evidence (invoice_id, customer_id, request_id, file_path, file_sha256, file_type, claimed_amount,
      claimed_transfer_at, claimed_bank, claimed_ref, bank_account_id)
    values (p_invoice, i.customer_id, req, p_file_path, lower(p_sha256), p_file_type, p_claimed_amount, p_transfer_at, nullif(trim(p_bank), ''), nullif(trim(p_ref), ''), p_bank_account)
    returning id into e;
  perform public.finance_log('evidence', e, 'evidence.submit', jsonb_build_object('invoice', p_invoice, 'claimed_amount', p_claimed_amount, 'bank_account', p_bank_account));
  return e;
end $$;

-- Verification now records which bank received the money and queues the ledger entry.
create or replace function public.finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz,
  p_note text default null, p_via text default 'staff')
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; st jsonb; outstanding numeric; rc public.finance_receipts; result text; v_alloc numeric := 0;
begin
  perform public.finance_require('verify', 'verify payments');
  if p_via not in ('staff', 'provider', 'bank') then raise exception 'Unknown verification source'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if coalesce(trim(p_bank_trans_ref), '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> 'submitted' then raise exception 'This slip is already %', e.status; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;   -- serialises settlement of one invoice
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  if exists (select 1 from public.finance_receipts where bank_trans_ref = trim(p_bank_trans_ref)) or exists (select 1 from public.finance_wallet_deposits where bank_trans_ref = trim(p_bank_trans_ref) and status = 'verified') then
    raise exception 'Bank transaction % was already recorded (reused slip?)', trim(p_bank_trans_ref) using errcode = '23505'; end if;
  if p_transfer_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The transfer is older than the invoice'; end if;

  st := public.finance_invoice_state_raw(i.id);
  outstanding := (st ->> 'outstanding')::numeric;
  update public.finance_payment_evidence set status = 'verified', verified_via = p_via, verified_amount = p_amount, bank_trans_ref = trim(p_bank_trans_ref),
    transfer_at = p_transfer_at, review_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now() where id = e.id;
  insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at, needs_review, method, bank_account_id)
    values ('RC-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.finance_receipt_seq')::text, 5, '0'),
            i.customer_id, i.id, e.id, p_amount, trim(p_bank_trans_ref), p_transfer_at, p_amount > outstanding, 'bank_transfer', e.bank_account_id)
    returning * into rc;
  if p_amount <= outstanding then
    insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, i.id, p_amount);
    v_alloc := p_amount;
    result := case when p_amount = outstanding then 'fully_paid' else 'partially_paid' end;
  else
    result := 'overpaid_review';
  end if;
  -- ledger: money in the bank; the applied part settles the receivable, any overpayment is a customer credit until staff decide
  perform public.finance_gl_enqueue('BANK_RECEIPT', 'receipt', rc.id, rc.receipt_no, i.customer_id, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', e.bank_account_id))
      || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
      || case when p_amount - v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', p_amount - v_alloc)) else '[]'::jsonb end,
    public.finance_gl_issue_dep(i.id));
  perform public.finance_log('evidence', e.id, 'evidence.verify', jsonb_build_object('via', p_via, 'amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', trim(p_bank_trans_ref), 'bank_account', e.bank_account_id));
  perform public.finance_log('receipt', rc.id, 'receipt.post', jsonb_build_object('invoice', i.id, 'amount', p_amount, 'outstanding_before', outstanding, 'result', result));
  return jsonb_build_object('result', result, 'receipt_no', rc.receipt_no, 'state', public.finance_invoice_state_raw(i.id));
end $$;

create or replace function public.finance_resolve_overpayment(p_receipt uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rc public.finance_receipts; outstanding numeric; apply numeric; v_alloc uuid;
begin
  perform public.finance_require('verify', 'resolve overpayments');
  if coalesce(trim(p_note), '') = '' then raise exception 'Write what was agreed with the customer'; end if;
  select * into rc from public.finance_receipts where id = p_receipt for update;
  if not found or rc.status <> 'posted' or not rc.needs_review then raise exception 'Nothing to resolve on this receipt'; end if;
  perform 1 from public.finance_invoices where id = rc.invoice_id for update;
  outstanding := (public.finance_invoice_state_raw(rc.invoice_id) ->> 'outstanding')::numeric;
  apply := least(outstanding, rc.amount - coalesce((select sum(amount) from public.finance_allocations where receipt_id = rc.id and active), 0));
  if apply > 0 then
    insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, rc.invoice_id, apply) returning id into v_alloc;
    -- the overpaid money was held as customer credit: applying it moves it to the receivable
    perform public.finance_gl_enqueue('RECEIPT_REAPPLY', 'allocation', v_alloc, rc.receipt_no, rc.customer_id, apply,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', apply), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', apply)),
      public.finance_gl_issue_dep(rc.invoice_id));
  end if;
  update public.finance_receipts set needs_review = false where id = rc.id;
  perform public.finance_log('receipt', rc.id, 'receipt.resolve_overpayment', jsonb_build_object('applied', apply, 'credit', rc.amount - apply, 'note', trim(p_note)));
  return public.finance_invoice_state_raw(rc.invoice_id);
end $$;

-- Reversing a receipt: a wallet payment returns the money to the wallet (a REVERSAL row); a bank receipt is reversed in the ledger only.
create or replace function public.finance_reverse_receipt(p_receipt uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rc public.finance_receipts; v_alloc numeric; v_unapplied numeric; v_orig public.finance_wallet_transactions; v_t public.finance_wallet_transactions;
begin
  perform public.finance_require('manage', 'reverse receipts');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into rc from public.finance_receipts where id = p_receipt for update;
  if not found then raise exception 'Receipt not found'; end if;
  if rc.status <> 'posted' then raise exception 'Receipt is already %', rc.status; end if;
  perform 1 from public.finance_invoices where id = rc.invoice_id for update;
  v_alloc := coalesce((select sum(amount) from public.finance_allocations where receipt_id = rc.id and active), 0);
  v_unapplied := rc.amount - v_alloc;
  update public.finance_allocations set active = false, deactivated_by = auth.uid(), deactivated_at = now(), deactivate_reason = 'receipt reversed: ' || trim(p_reason)
    where receipt_id = rc.id and active;
  update public.finance_receipts set status = 'reversed', needs_review = false, reversed_by = auth.uid(), reversed_at = now(), reverse_reason = trim(p_reason) where id = rc.id;
  if rc.wallet_txn_id is not null then
    select * into v_orig from public.finance_wallet_transactions where id = rc.wallet_txn_id;
    v_t := public.finance_wallet_apply(rc.customer_id, 'REVERSAL', 'credit', rc.amount, 'REV:' || v_orig.id::text, 'wallet_txn', v_orig.id, v_orig.txn_no, 'wallet', null, 'not_required',
                                       auth.uid(), auth.uid(), 'Receipt ' || rc.receipt_no || ' reversed: ' || trim(p_reason), 'ยกเลิกการชำระ / Payment reversed', v_orig.id);
    perform public.finance_gl_enqueue('WALLET_REVERSAL', 'wallet_txn', v_t.id, v_t.txn_no, rc.customer_id, rc.amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', rc.amount), jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', rc.amount, 'wallet', true)));
  else
    perform public.finance_gl_enqueue('RECEIPT_REVERSAL', 'receipt', rc.id, rc.receipt_no, rc.customer_id, rc.amount,
      jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'bank', 'amount', rc.amount, 'bank_account_id', rc.bank_account_id))
        || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
        || case when v_unapplied > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', v_unapplied)) else '[]'::jsonb end);
  end if;
  perform public.finance_log('receipt', rc.id, 'receipt.reverse', jsonb_build_object('reason', trim(p_reason), 'amount', rc.amount));
  return public.finance_invoice_state_raw(rc.invoice_id);
end $$;

-- ---------------------------------------------------------------------------------------------- staff: refund / adjustment / reversal of wallet money
-- Refund a reversed BANK receipt into the customer's wallet (the money stayed in the bank): Dr bank / Cr customer credit.
create or replace function public.finance_wallet_refund(p_receipt uuid, p_amount numeric, p_reason text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rc public.finance_receipts; v_done numeric; v_t public.finance_wallet_transactions; v_inv text;
begin
  perform public.finance_require('manage', 'refund to a wallet');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if p_key is null or length(p_key) < 8 then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  select * into rc from public.finance_receipts where id = p_receipt for update;
  if not found then raise exception 'Receipt not found'; end if;
  if rc.status <> 'reversed' then raise exception 'REFUND_NEEDS_REVERSED_RECEIPT: reverse the receipt first'; end if;
  if rc.wallet_txn_id is not null then raise exception 'REFUND_NOT_NEEDED: reversing a wallet payment already returned the money to the wallet'; end if;
  -- (a retry of the same refund has the same key: it is not counted here, so it reaches the ledger's replay protection and returns the original)
  select coalesce(sum(amount), 0) into v_done from public.finance_wallet_transactions where txn_type = 'REFUND' and ref_type = 'receipt' and ref_id = rc.id and idempotency_key <> 'REFUND:' || p_key;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > rc.amount - v_done then raise exception 'AMOUNT_EXCEEDS_REFUNDABLE' using detail = (rc.amount - v_done)::text; end if;
  v_t := public.finance_wallet_apply(rc.customer_id, 'REFUND', 'credit', p_amount, 'REFUND:' || p_key, 'receipt', rc.id, rc.receipt_no, 'bank_transfer', rc.bank_account_id, 'verified',
                                     auth.uid(), auth.uid(), trim(p_reason), 'คืนเงินเข้ากระเป๋า / Refund to wallet');
  perform public.finance_gl_enqueue('WALLET_REFUND', 'wallet_txn', v_t.id, v_t.txn_no, rc.customer_id, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', rc.bank_account_id),
                      jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true)));
  return jsonb_build_object('txn_no', v_t.txn_no, 'balance', v_t.balance_after);
end $$;

create or replace function public.finance_wallet_adjust(p_customer uuid, p_direction text, p_amount numeric, p_reason text, p_key text, p_customer_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_s public.finance_settings; v_t public.finance_wallet_transactions; v_super boolean; v_role text;
begin
  perform public.finance_require('manage', 'adjust a wallet');
  if p_direction not in ('credit', 'debit') then raise exception 'INVALID_DIRECTION' using errcode = '22023'; end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then raise exception 'REASON_TOO_SHORT: describe why in at least 10 characters'; end if;
  if p_key is null or length(p_key) < 8 then raise exception 'INVALID_KEY' using errcode = '22023'; end if;
  if not exists (select 1 from public.finance_customers where id = p_customer) then raise exception 'Customer not found'; end if;
  select * into v_s from public.finance_settings where id;
  v_super := exists (select 1 from public.profiles where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'active');
  if p_amount > v_s.adjustment_limit and not v_super then raise exception 'ADJUSTMENT_NEEDS_SUPER_ADMIN: adjustments above % need a SUPER_ADMIN', v_s.adjustment_limit; end if;
  v_role := v_s.adjustment_role;
  v_t := public.finance_wallet_apply(p_customer, 'ADJUSTMENT', p_direction, p_amount, 'ADJ:' || p_key, 'manual', null, null, 'manual', null, 'not_required', auth.uid(), auth.uid(), trim(p_reason), p_customer_note);
  perform public.finance_gl_enqueue('WALLET_ADJUSTMENT', 'wallet_txn', v_t.id, v_t.txn_no, p_customer, p_amount,
    case when p_direction = 'credit'
      then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', v_role, 'amount', p_amount), jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true))
      else jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true), jsonb_build_object('side', 'cr', 'role', v_role, 'amount', p_amount)) end);
  return jsonb_build_object('txn_no', v_t.txn_no, 'balance', v_t.balance_after);
end $$;

-- Correct a mistake in the ledger: an opposite row (never an edit). Invoice payments are corrected by reversing their receipt.
create or replace function public.finance_wallet_reverse(p_txn uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_o public.finance_wallet_transactions; v_t public.finance_wallet_transactions; v_dir text; v_q public.finance_gl_queue;
begin
  perform public.finance_require('manage', 'reverse a wallet transaction');
  if coalesce(length(trim(p_reason)), 0) < 10 then raise exception 'REASON_TOO_SHORT: describe why in at least 10 characters'; end if;
  select * into v_o from public.finance_wallet_transactions where id = p_txn;
  if not found then raise exception 'Transaction not found'; end if;
  if v_o.txn_type in ('REVERSAL') or v_o.reversal_of is not null then raise exception 'A reversal cannot be reversed'; end if;
  if v_o.txn_type = 'INVOICE_PAYMENT' then raise exception 'USE_RECEIPT_REVERSAL: reverse the receipt of this invoice payment instead'; end if;
  if exists (select 1 from public.finance_wallet_transactions where reversal_of = v_o.id) then raise exception 'This transaction was already reversed'; end if;
  v_dir := case when v_o.direction = 'credit' then 'debit' else 'credit' end;
  v_t := public.finance_wallet_apply(v_o.customer_id, 'REVERSAL', v_dir, v_o.amount, 'REV:' || v_o.id::text, 'wallet_txn', v_o.id, v_o.txn_no, v_o.payment_method, v_o.bank_account_id, 'not_required',
                                     auth.uid(), auth.uid(), trim(p_reason), null, v_o.id);
  select * into v_q from public.finance_gl_queue where ref_type = 'wallet_txn' and ref_id = v_o.id;
  if v_q.id is not null then
    perform public.finance_gl_enqueue('WALLET_REVERSAL', 'wallet_txn', v_t.id, v_t.txn_no, v_o.customer_id, v_o.amount,
      (select jsonb_agg(l || jsonb_build_object('side', case when l ->> 'side' = 'dr' then 'cr' else 'dr' end)) from jsonb_array_elements(v_q.plan) l), null);
  end if;
  return jsonb_build_object('txn_no', v_t.txn_no, 'balance', v_t.balance_after);
end $$;

-- ---------------------------------------------------------------------------------------------- reads: customer
create or replace function public.finance_my_wallet()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_cust uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  v_cust := public.finance_my_customer();
  return jsonb_build_object(
    'balance', coalesce((select balance from public.finance_wallets where customer_id = v_cust), 0),
    'total_deposits', coalesce((select sum(amount) from public.finance_wallet_transactions where customer_id = v_cust and txn_type = 'DEPOSIT'), 0),
    'total_payments', coalesce((select sum(amount) from public.finance_wallet_transactions where customer_id = v_cust and txn_type = 'INVOICE_PAYMENT'), 0),
    'total_refunds', coalesce((select sum(amount) from public.finance_wallet_transactions where customer_id = v_cust and txn_type in ('REFUND', 'REVERSAL') and direction = 'credit'), 0),
    'pending_deposits', coalesce((select sum(amount) from public.finance_wallet_deposits where customer_id = v_cust and status in ('pending', 'submitted', 'under_review')), 0));
end $$;

create or replace function public.finance_my_wallet_transactions(p_limit integer default 20, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_cust uuid; v_lim integer := least(greatest(coalesce(p_limit, 20), 1), 100); v_off integer := greatest(coalesce(p_offset, 0), 0);
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  v_cust := public.finance_my_customer();
  return jsonb_build_object(
    'total', (select count(*) from public.finance_wallet_transactions where customer_id = v_cust),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'txn_no', t.txn_no, 'txn_type', t.txn_type, 'direction', t.direction, 'amount', t.amount,
        'balance_before', t.balance_before, 'balance_after', t.balance_after, 'ref_no', t.ref_no, 'payment_method', t.payment_method, 'verification_status', t.verification_status,
        'bank', (select jsonb_build_object('code', b.code, 'bank_name_th', b.bank_name_th, 'bank_name_en', b.bank_name_en) from public.finance_bank_accounts b where b.id = t.bank_account_id),
        'note', t.customer_note, 'txn_date', t.txn_date) order by t.seq desc)
      from (select * from public.finance_wallet_transactions where customer_id = v_cust order by seq desc limit v_lim offset v_off) t), '[]'::jsonb));
end $$;

create or replace function public.finance_my_deposits(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_cust uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  v_cust := public.finance_my_customer();
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'deposit_no', d.deposit_no, 'status', d.status, 'amount', d.amount, 'verified_amount', d.verified_amount, 'created_at', d.created_at,
      'submitted_at', d.submitted_at, 'reject_reason', d.reject_reason, 'has_slip', d.file_path is not null, 'customer_ref', d.customer_ref,
      'bank', (select jsonb_build_object('id', b.id, 'code', b.code, 'bank_name_th', b.bank_name_th, 'bank_name_en', b.bank_name_en, 'account_no', b.account_no, 'account_name', b.account_name) from public.finance_bank_accounts b where b.id = d.bank_account_id))
      order by d.created_at desc)
    from (select * from public.finance_wallet_deposits where customer_id = v_cust order by created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 100)) d), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------- reads: staff
create or replace function public.finance_payments_overview(p_kind text default null, p_status text default null, p_bank uuid default null, p_search text default null,
  p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0); v_q text := nullif(btrim(coalesce(p_search, '')), ''); v_pat text; v_res jsonb;
begin
  perform public.finance_require('view', 'see payments');
  if v_q is not null then v_pat := '%' || replace(replace(replace(left(v_q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with u as (
    select 'deposit'::text kind, d.id, d.deposit_no no, d.customer_id, null::text invoice_no, d.amount, d.verified_amount, d.status, d.bank_account_id, d.created_at, d.file_path, d.bank_trans_ref
      from public.finance_wallet_deposits d
    union all
    select 'invoice_slip', e.id, i.invoice_no, e.customer_id, i.invoice_no, e.claimed_amount, e.verified_amount,
           case e.status when 'submitted' then 'submitted' when 'verified' then 'verified' else 'rejected' end, e.bank_account_id, e.created_at, e.file_path, e.bank_trans_ref
      from public.finance_payment_evidence e join public.finance_invoices i on i.id = e.invoice_id
    union all
    select 'wallet_payment', r.id, r.receipt_no, r.customer_id, i.invoice_no, r.amount, r.amount, case r.status when 'posted' then 'verified' else 'cancelled' end, null, r.created_at, null, null
      from public.finance_receipts r join public.finance_invoices i on i.id = r.invoice_id where r.wallet_txn_id is not null),
  f as (
    select u.*, c.name customer_name, c.code customer_code, b.code bank_code, b.bank_name_th, b.bank_name_en, count(*) over () total
    from u join public.finance_customers c on c.id = u.customer_id left join public.finance_bank_accounts b on b.id = u.bank_account_id
    where (nullif(p_kind, '') is null or u.kind = p_kind) and (nullif(p_status, '') is null or u.status = p_status) and (p_bank is null or u.bank_account_id = p_bank)
      and (v_q is null or c.name ilike v_pat or c.code ilike v_pat or u.no ilike v_pat or u.invoice_no ilike v_pat or u.bank_trans_ref ilike v_pat)
    order by u.created_at desc limit v_lim offset v_off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0), 'items', coalesce(jsonb_agg(to_jsonb(f) - 'total' order by f.created_at desc), '[]'::jsonb)) into v_res from f;
  return v_res;
end $$;

create or replace function public.finance_wallets_overview(p_search text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0); v_q text := nullif(btrim(coalesce(p_search, '')), ''); v_pat text; v_res jsonb;
begin
  perform public.finance_require('view', 'see wallets');
  if v_q is not null then v_pat := '%' || replace(replace(replace(left(v_q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with f as (
    select w.id wallet_id, c.id customer_id, c.code, c.name, w.balance,
           coalesce((select sum(amount) from public.finance_wallet_transactions t where t.wallet_id = w.id and t.txn_type = 'DEPOSIT'), 0) total_deposits,
           coalesce((select sum(amount) from public.finance_wallet_transactions t where t.wallet_id = w.id and t.txn_type = 'INVOICE_PAYMENT'), 0) total_payments,
           (select max(created_at) from public.finance_wallet_transactions t where t.wallet_id = w.id) last_activity, count(*) over () total
    from public.finance_wallets w join public.finance_customers c on c.id = w.customer_id
    where v_q is null or c.name ilike v_pat or c.code ilike v_pat
    order by w.balance desc, c.name limit v_lim offset v_off)
  select jsonb_build_object('total', coalesce((select max(total) from f), 0), 'sum_balance', coalesce((select sum(balance) from public.finance_wallets), 0),
    'items', coalesce(jsonb_agg(to_jsonb(f) - 'total'), '[]'::jsonb)) into v_res from f;
  return v_res;
end $$;

create or replace function public.finance_wallet_ledger(p_customer uuid, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.finance_require('view', 'see wallets');
  return jsonb_build_object('balance', coalesce((select balance from public.finance_wallets where customer_id = p_customer), 0),
    'total', (select count(*) from public.finance_wallet_transactions where customer_id = p_customer),
    'items', coalesce((select jsonb_agg(to_jsonb(t) - 'wallet_id' || jsonb_build_object('bank_code', (select code from public.finance_bank_accounts b where b.id = t.bank_account_id),
        'created_by_email', (select email from public.profiles p where p.id = t.created_by), 'approved_by_email', (select email from public.profiles p where p.id = t.approved_by)) order by t.seq desc)
      from (select * from public.finance_wallet_transactions where customer_id = p_customer order by seq desc limit v_lim offset v_off) t), '[]'::jsonb));
end $$;

-- balance = ledger, and the chain of balance_before/after is unbroken. Returns the problems (an empty list is healthy).
create or replace function public.finance_wallet_reconcile()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'reconcile wallets');
  return jsonb_build_object(
    'wallets', (select count(*) from public.finance_wallets),
    'balance_total', coalesce((select sum(balance) from public.finance_wallets), 0),
    'ledger_total', coalesce((select sum(case when direction = 'credit' then amount else -amount end) from public.finance_wallet_transactions), 0),
    'problems', coalesce((select jsonb_agg(p) from (
      select jsonb_build_object('customer_id', w.customer_id, 'problem', 'balance_differs_from_ledger', 'balance', w.balance,
             'ledger', coalesce((select sum(case when t.direction = 'credit' then t.amount else -t.amount end) from public.finance_wallet_transactions t where t.wallet_id = w.id), 0)) p
        from public.finance_wallets w
       where w.balance <> coalesce((select sum(case when t.direction = 'credit' then t.amount else -t.amount end) from public.finance_wallet_transactions t where t.wallet_id = w.id), 0)
      union all
      select jsonb_build_object('customer_id', x.customer_id, 'problem', 'chain_broken', 'txn_no', x.txn_no)
        from (select t.customer_id, t.txn_no, t.balance_before, lag(t.balance_after, 1, 0::numeric) over (partition by t.wallet_id order by t.seq) prev from public.finance_wallet_transactions t) x
       where x.balance_before <> x.prev) q), '[]'::jsonb));
end $$;

-- Daily payment report by bank account: what should appear on that bank's statement (verified deposits + verified invoice transfers), and whether the ledger has it.
create or replace function public.finance_bank_daily_report(p_from date, p_to date, p_bank uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see the bank report');
  return coalesce((select jsonb_agg(r order by r ->> 'day' desc, r ->> 'bank_code') from (
    select jsonb_build_object('day', (x.at at time zone 'Asia/Bangkok')::date, 'bank_code', coalesce(b.code, 'PROMPTPAY/OTHER'), 'bank_account_id', x.bank,
      'deposits', count(*) filter (where x.kind = 'deposit'), 'deposit_amount', coalesce(sum(x.amount) filter (where x.kind = 'deposit'), 0),
      'invoice_transfers', count(*) filter (where x.kind = 'receipt'), 'invoice_amount', coalesce(sum(x.amount) filter (where x.kind = 'receipt'), 0),
      'total', sum(x.amount), 'in_ledger', coalesce(sum(x.amount) filter (where x.posted), 0), 'waiting_for_ledger', coalesce(sum(x.amount) filter (where not x.posted), 0)) r
    from (
      select 'deposit' kind, d.transfer_at at, d.bank_account_id bank, d.verified_amount amount,
             coalesce((select q.status = 'posted' from public.finance_gl_queue q where q.event_type = 'WALLET_DEPOSIT' and q.ref_id = d.wallet_txn_id), false) posted
        from public.finance_wallet_deposits d where d.status = 'verified'
      union all
      select 'receipt', rc.received_at, rc.bank_account_id, rc.amount,
             coalesce((select q.status = 'posted' from public.finance_gl_queue q where q.event_type = 'BANK_RECEIPT' and q.ref_id = rc.id), false)
        from public.finance_receipts rc where rc.status = 'posted' and rc.wallet_txn_id is null) x
    left join public.finance_bank_accounts b on b.id = x.bank
    where (x.at at time zone 'Asia/Bangkok')::date between p_from and p_to and (p_bank is null or x.bank = p_bank)
    group by (x.at at time zone 'Asia/Bangkok')::date, b.code, x.bank) q), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------- ledger queue: reads and posting confirmation
create or replace function public.finance_gl_pending(p_status text default 'pending', p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see the ledger queue');
  return jsonb_build_object(
    'settings', (select to_jsonb(s) - 'updated_by' from public.finance_settings s where id),
    'items', coalesce((select jsonb_agg(to_jsonb(q) || jsonb_build_object(
        'customer_name', (select name from public.finance_customers c where c.id = q.customer_id),
        'blocked_by', (select jsonb_build_object('id', d.id, 'ref_no', d.ref_no, 'status', d.status) from public.finance_gl_queue d where d.id = q.depends_on and d.status <> 'posted'),
        'banks', (select coalesce(jsonb_object_agg(b.id::text, jsonb_build_object('code', b.code, 'gl_account_code', b.gl_account_code)), '{}'::jsonb) from public.finance_bank_accounts b
                  where b.id::text in (select l ->> 'bank_account_id' from jsonb_array_elements(q.plan) l where l ? 'bank_account_id'))) order by q.seq)
      from (select * from public.finance_gl_queue where status = coalesce(nullif(p_status, ''), 'pending') order by seq limit least(greatest(coalesce(p_limit, 100), 1), 500)) q), '[]'::jsonb));
end $$;

create or replace function public.finance_gl_mark_posted(p_id uuid, p_journal_no text, p_posted_ref text)
returns void language plpgsql security definer set search_path = public as $$
declare v_q public.finance_gl_queue;
begin
  perform public.finance_require('verify', 'record a ledger posting');
  if coalesce(trim(p_journal_no), '') = '' or coalesce(trim(p_posted_ref), '') = '' then raise exception 'The journal number and reference are required'; end if;
  select * into v_q from public.finance_gl_queue where id = p_id for update;
  if not found then raise exception 'Ledger row not found'; end if;
  if v_q.status = 'posted' then
    if v_q.posted_ref = trim(p_posted_ref) then return; end if;                    -- the same posting confirmed twice: fine
    raise exception 'ALREADY_POSTED' using errcode = '23505';
  end if;
  if v_q.status <> 'pending' then raise exception 'This ledger row is %', v_q.status; end if;
  if v_q.depends_on is not null and (select status from public.finance_gl_queue where id = v_q.depends_on) not in ('posted', 'void') then
    raise exception 'DEPENDENCY_NOT_POSTED: post % first', (select ref_no from public.finance_gl_queue where id = v_q.depends_on); end if;
  update public.finance_gl_queue set status = 'posted', journal_no = trim(p_journal_no), posted_ref = trim(p_posted_ref), posted_by = auth.uid(), posted_at = now() where id = p_id;
  perform public.finance_log('gl', p_id, 'gl.posted', jsonb_build_object('type', v_q.event_type, 'ref', v_q.ref_no, 'journal', trim(p_journal_no)));
end $$;

create or replace function public.finance_gl_void(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_require('manage', 'void a ledger row');
  if coalesce(length(trim(p_reason)), 0) < 10 then raise exception 'REASON_TOO_SHORT'; end if;
  update public.finance_gl_queue set status = 'void', void_reason = trim(p_reason) where id = p_id and status = 'pending';
  if not found then raise exception 'Only a row that has not been posted can be voided'; end if;
  perform public.finance_log('gl', p_id, 'gl.void', jsonb_build_object('reason', trim(p_reason)));
end $$;

-- Wallet money in the ledger vs the wallet ledger: the liability movements of wallet events (posted / waiting) against the sum of balances.
create or replace function public.finance_gl_reconciliation()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_posted numeric; v_pending numeric;
begin
  perform public.finance_require('view', 'reconcile the ledger');
  select coalesce(sum(case when l ->> 'side' = 'cr' then (l ->> 'amount')::numeric else -(l ->> 'amount')::numeric end) filter (where q.status = 'posted'), 0),
         coalesce(sum(case when l ->> 'side' = 'cr' then (l ->> 'amount')::numeric else -(l ->> 'amount')::numeric end) filter (where q.status = 'pending'), 0)
    into v_posted, v_pending
    from public.finance_gl_queue q, jsonb_array_elements(q.plan) l where coalesce((l ->> 'wallet')::boolean, false);
  return jsonb_build_object('wallet_balances', coalesce((select sum(balance) from public.finance_wallets), 0), 'wallet_ledger', coalesce((select sum(case when direction = 'credit' then amount else -amount end) from public.finance_wallet_transactions), 0),
    'gl_wallet_liability_posted', v_posted, 'gl_wallet_liability_waiting', v_pending, 'difference', coalesce((select sum(balance) from public.finance_wallets), 0) - (v_posted + v_pending),
    'rows_waiting', (select count(*) from public.finance_gl_queue where status = 'pending'), 'rows_blocked', (select count(*) from public.finance_gl_queue q where q.status = 'pending' and q.depends_on is not null and (select status from public.finance_gl_queue d where d.id = q.depends_on) = 'pending'));
end $$;

-- ---------------------------------------------------------------------------------------------- shop: bank transfer counts as a way to get paid
do $$
declare f text; def text; old constant text := 'exists (select 1 from public.finance_payment_accounts where is_default and active)';
begin
  foreach f in array array['public.shop_settings_public()', 'public.shop_place_order(text, jsonb, text, text, text, text, text, numeric)', 'public.shop_admin_settings()'] loop
    if to_regprocedure(f) is not null then
      def := pg_get_functiondef(to_regprocedure(f));
      if position(old in def) > 0 and position('finance_bank_accounts' in def) = 0 then
        execute replace(def, old, '(' || old || ' or exists (select 1 from public.finance_bank_accounts where active))');
      end if;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------- RLS and grants
alter table public.finance_settings enable row level security;
alter table public.finance_bank_accounts enable row level security;
alter table public.finance_wallets enable row level security;
alter table public.finance_wallet_transactions enable row level security;
alter table public.finance_wallet_deposits enable row level security;
alter table public.finance_gl_queue enable row level security;

drop policy if exists "finance settings: staff" on public.finance_settings;
create policy "finance settings: staff" on public.finance_settings for select to authenticated using (public.finance_can('view'));
drop policy if exists "finance banks: active or staff" on public.finance_bank_accounts;
create policy "finance banks: active or staff" on public.finance_bank_accounts for select to authenticated using (active or public.finance_can('view'));
drop policy if exists "finance wallets: staff or own" on public.finance_wallets;
create policy "finance wallets: staff or own" on public.finance_wallets for select to authenticated using (public.finance_can('view') or customer_id = public.finance_my_customer());
-- customers read their ledger through finance_my_wallet_transactions (no internal remarks, no staff ids); staff read the table
drop policy if exists "finance wallet txns: staff" on public.finance_wallet_transactions;
create policy "finance wallet txns: staff" on public.finance_wallet_transactions for select to authenticated using (public.finance_can('view'));
drop policy if exists "finance deposits: staff" on public.finance_wallet_deposits;
create policy "finance deposits: staff" on public.finance_wallet_deposits for select to authenticated using (public.finance_can('view'));
drop policy if exists "finance gl queue: staff" on public.finance_gl_queue;
create policy "finance gl queue: staff" on public.finance_gl_queue for select to authenticated using (public.finance_can('view'));

do $$ declare t text; begin
  foreach t in array array['finance_settings', 'finance_bank_accounts', 'finance_wallets', 'finance_wallet_transactions', 'finance_wallet_deposits', 'finance_gl_queue'] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;
revoke all on sequence public.finance_wallet_txn_seq, public.finance_deposit_seq from anon, authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'finance_guard_wallet()', 'finance_wallet_txn_immutable()', 'finance_guard_deposit()', 'finance_guard_gl_queue()', 'finance_gl_invoice_trigger()',
    'finance_gl_enqueue(text, text, uuid, text, uuid, numeric, jsonb, uuid)', 'finance_gl_issue_dep(uuid)', 'finance_ensure_customer()',
    'finance_wallet_apply(uuid, text, text, numeric, text, text, uuid, text, text, uuid, text, uuid, uuid, text, text, uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'finance_payment_methods()', 'finance_save_bank_account(uuid, text, text, text, text, text, text, text, text, text, text, integer, boolean)', 'finance_save_settings(jsonb)',
    'finance_deposit_create(uuid, numeric, text, text)', 'finance_deposit_submit_slip(uuid, text, text, text, timestamptz, text)', 'finance_deposit_cancel(uuid)',
    'finance_deposit_start_review(uuid)', 'finance_deposit_verify(uuid, numeric, text, timestamptz, text)', 'finance_deposit_reject(uuid, text)',
    'finance_pay_invoice_with_wallet(uuid, numeric, text)', 'finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text, uuid)',
    'finance_verify_evidence(uuid, numeric, text, timestamptz, text, text)', 'finance_resolve_overpayment(uuid, text)', 'finance_reverse_receipt(uuid, text)',
    'finance_wallet_refund(uuid, numeric, text, text)', 'finance_wallet_adjust(uuid, text, numeric, text, text, text)', 'finance_wallet_reverse(uuid, text)',
    'finance_my_wallet()', 'finance_my_wallet_transactions(integer, integer)', 'finance_my_deposits(integer)',
    'finance_payments_overview(text, text, uuid, text, integer, integer)', 'finance_wallets_overview(text, integer, integer)', 'finance_wallet_ledger(uuid, integer, integer)',
    'finance_wallet_reconcile()', 'finance_bank_daily_report(date, date, uuid)', 'finance_gl_pending(text, integer)', 'finance_gl_mark_posted(uuid, text, text)',
    'finance_gl_void(uuid, text)', 'finance_gl_reconciliation()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
