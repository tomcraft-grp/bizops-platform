-- Customer payment policy: which customers may pay an invoice in parts (partial) and which must pay the whole outstanding amount in ONE payment (full).
-- Design: docs/superpowers/specs/2026-11-27-payment-policy-wallet-qr-reorder-purchasing-design.md (§1).
-- Owner request (2026-11-27). The rule is enforced HERE, in the database, at the two ways a customer pays an invoice by themselves; the screens only mirror it.
--   1. finance_customers.payment_policy text NOT NULL DEFAULT 'partial' (partial | full). Every existing customer becomes 'partial' = exactly what they can do today.
--   2. finance_set_payment_policy(customer, policy, reason): finance manager only; the change (old -> new + reason + who) is written to finance_events and never overwritten.
--   3. finance_my_payment_policy(): the signed-in customer's own policy (never null: a customer without a record is 'partial').
--      finance_customer_policies(ids): staff (finance 'view') read the policy and what each customer owes, for the screens.
--   4. finance_submit_evidence (customer slip) and finance_pay_invoice_with_wallet are replaced by copies of the live definitions with the policy added:
--        policy full  -> the claimed amount may not be LESS than the outstanding amount (the wallet pays exactly the outstanding amount), and no other slip of that invoice may be waiting (FULL_PAYMENT_REQUIRED, PAYMENT_ALREADY_PENDING)
--        policy partial -> unchanged (the slip amount is still only a claim that staff verify; money already sent is never refused at the door, an excess is credited to the wallet as before)
--        (a slip for MORE than is owed is still accepted: the excess is credited to the wallet by the owner's rule, and a slip made for an older QR amount must not strand money already sent;
--         a slip for LESS is refused with FULL_PAYMENT_REQUIRED and the customer is told to contact the shop so staff enter what was really received)
--      Both already take the invoice row lock (FOR UPDATE) before reading the outstanding amount, so two concurrent payments are serialised and the second sees the first.
--      The slip function also now refuses an amount that is not a positive baht-and-satang number (INVALID_AMOUNT) instead of a raw check violation.
--   5. Staff entries (finance_record_payment / finance_receive_payment) are NOT blocked: staff record money that was physically received (cash, split tenders). An AFTER INSERT trigger
--      writes 'policy.partial_by_staff' to finance_events when a full-payment customer's entry is less than what the invoice owes, so the exception is visible in the history.
--      The trigger can never stop a payment: any error inside it is swallowed.
-- Nothing is deleted or rewritten except the two functions above (their bodies are copies with the marked additions). finance_verify_core / confirm / post / review_list / deposit_verify are NOT touched.
-- Rollback: supabase/rollbacks/20261127100000_customer_payment_policy_down.sql

-- 0 ------------------------------------------------------------------------------------------------------------------------------------------------------
-- The two functions below are copies of the LIVE definitions as they were on 2026-11-27. Another session also changes finance functions: if either one changed since, this migration must not
-- silently put the old text back. It refuses, and the copy is redone from the live definition.
do $$ begin
  if md5(pg_get_functiondef('public.finance_submit_evidence(uuid, text, text, text, numeric, timestamptz, text, text, uuid)'::regprocedure)) <> 'd5653219bfacd656b8ed9ec1bf9d6ddb' then
    raise exception 'finance_submit_evidence changed since this migration was written: copy the live definition again and re-add the policy lines'; end if;
  if md5(pg_get_functiondef('public.finance_pay_invoice_with_wallet(uuid, numeric, text)'::regprocedure)) <> 'c5cff23c0d38386c7f80330e5709f506' then
    raise exception 'finance_pay_invoice_with_wallet changed since this migration was written: copy the live definition again and re-add the policy lines'; end if;
end $$;

-- 1 ------------------------------------------------------------------------------------------------------------------------------------------------------
alter table public.finance_customers add column if not exists payment_policy text not null default 'partial';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_customers_payment_policy_chk') then
    alter table public.finance_customers add constraint finance_customers_payment_policy_chk check (payment_policy in ('partial', 'full'));
  end if;
end $$;

-- 2 ------------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.finance_set_payment_policy(p_customer uuid, p_policy text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.finance_customers; v_old text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.finance_require('manage', 'change a customer''s payment policy');
  if p_policy is null or p_policy not in ('partial', 'full') then raise exception 'INVALID_POLICY: choose partial or full' using errcode = '22023'; end if;
  if v_reason is null or length(v_reason) < 3 then raise exception 'REASON_REQUIRED: say why the policy changes (at least 3 characters)'; end if;
  if length(v_reason) > 300 then raise exception 'REASON_TOO_LONG: 300 characters at most'; end if;
  select * into c from public.finance_customers where id = p_customer for update;
  if not found then raise exception 'NOT_FOUND: customer'; end if;
  v_old := c.payment_policy;
  if v_old = p_policy then return jsonb_build_object('id', c.id, 'payment_policy', c.payment_policy, 'changed', false); end if;
  update public.finance_customers set payment_policy = p_policy where id = c.id returning * into c;
  perform public.finance_log('customer', c.id, 'customer.payment_policy', jsonb_build_object('from', v_old, 'to', p_policy, 'reason', v_reason));
  return jsonb_build_object('id', c.id, 'payment_policy', c.payment_policy, 'changed', true);
end $$;
revoke all on function public.finance_set_payment_policy(uuid, text, text) from public, anon;
grant execute on function public.finance_set_payment_policy(uuid, text, text) to authenticated;

-- 3 ------------------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.finance_my_payment_policy()
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  return coalesce((select c.payment_policy from public.finance_customers c where c.profile_id = auth.uid()), 'partial');
end $$;
revoke all on function public.finance_my_payment_policy() from public, anon;
grant execute on function public.finance_my_payment_policy() to authenticated;

-- staff screens: every customer (or the given ones) with the policy and what they owe on open invoices
create or replace function public.finance_customer_policies(p_ids uuid[] default null, p_search text default null, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 500); v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public.finance_require('view', 'see customers'' payment policies');
  return coalesce((select jsonb_agg(x order by x ->> 'name', x ->> 'code') from (
      select jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'payment_policy', c.payment_policy,
               'open_invoices', (select count(*) from public.finance_invoices i where i.customer_id = c.id and i.status = 'open'),
               'open_amount', coalesce((select sum((public.finance_invoice_state_raw(i.id) ->> 'outstanding')::numeric) from public.finance_invoices i where i.customer_id = c.id and i.status = 'open'), 0)) as x
        from public.finance_customers c
       where (p_ids is null or c.id = any (p_ids)) and (v_q is null or c.name ilike '%' || v_q || '%' or c.code ilike '%' || v_q || '%')
       order by c.name, c.code limit v_lim) q), '[]'::jsonb);
end $$;
revoke all on function public.finance_customer_policies(uuid[], text, integer) from public, anon;
grant execute on function public.finance_customer_policies(uuid[], text, integer) to authenticated;

-- 4 ------------------------------------------------------------------------------------------------------------------------------------------------------
-- the customer's slip for an invoice (copy of the live function + the policy; marked "POLICY")
create or replace function public.finance_submit_evidence(p_invoice uuid, p_file_path text, p_sha256 text, p_file_type text, p_claimed_amount numeric, p_transfer_at timestamp with time zone, p_bank text, p_ref text, p_bank_account uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare i public.finance_invoices; e uuid; req uuid; v_policy text; v_out numeric;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into i from public.finance_invoices where id = p_invoice for update;
  if not found or (i.customer_id is distinct from public.finance_my_customer() and not public.finance_can('invoice')) then
    raise exception 'Invoice not found' using errcode = '42501'; end if;
  if i.status <> 'open' then raise exception 'This invoice is %', i.status; end if;
  if p_claimed_amount is null or p_claimed_amount <= 0 or p_claimed_amount <> round(p_claimed_amount, 2) then raise exception 'INVALID_AMOUNT: enter the amount in baht and satang' using errcode = '22023'; end if;   -- POLICY (clear message)
  -- POLICY: a customer paying their own invoice under the full-payment policy sends the whole outstanding amount, once. (Staff entering a slip for a customer are not bound by it.)
  if i.customer_id is not distinct from public.finance_my_customer() then
    v_policy := coalesce((select c.payment_policy from public.finance_customers c where c.id = i.customer_id), 'partial');
    if v_policy = 'full' then
      v_out := (public.finance_invoice_state_raw(p_invoice) ->> 'outstanding')::numeric;
      if v_out <= 0 then raise exception 'NOTHING_OUTSTANDING: this invoice has nothing left to pay'; end if;
      if p_claimed_amount < v_out then        -- an excess is credited to the wallet by the owner's rule: only LESS than the whole amount is refused
        raise exception 'FULL_PAYMENT_REQUIRED: this account must pay the whole outstanding amount (%) in one payment', v_out using detail = v_out::text; end if;
      if exists (select 1 from public.finance_payment_evidence where invoice_id = p_invoice and status in ('submitted', 'confirmed')) then
        raise exception 'PAYMENT_ALREADY_PENDING: a payment for this invoice is already waiting to be checked'; end if;
    end if;
  end if;
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
end $function$;

-- paying an invoice from the wallet (copy of the live function + the policy)
create or replace function public.finance_pay_invoice_with_wallet(p_invoice uuid, p_amount numeric, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cust uuid; v_i public.finance_invoices; v_st jsonb; v_out numeric; v_t public.finance_wallet_transactions; v_rc public.finance_receipts; v_key text; v_existing public.finance_receipts; v_rno text; v_policy text;
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
  -- POLICY: under the full-payment policy the wallet pays the whole outstanding amount, nothing less
  v_policy := coalesce((select c.payment_policy from public.finance_customers c where c.id = v_cust), 'partial');
  if v_policy = 'full' and p_amount <> v_out then
    raise exception 'FULL_PAYMENT_REQUIRED: this account must pay the whole outstanding amount (%) in one payment', v_out using detail = v_out::text; end if;
  v_rno := public.next_doc_no('PAYMENT');          -- numbers are always taken in one fixed order (payment, wallet row, wallet number): no deadlock between concurrent payments
  v_t := public.finance_wallet_apply(v_cust, 'INVOICE_PAYMENT', 'debit', p_amount, v_key, 'invoice', v_i.id, v_i.invoice_no, 'wallet', null, 'not_required', auth.uid(), null, 'Paid from the wallet', null);
  insert into public.finance_receipts (receipt_no, customer_id, invoice_id, evidence_id, wallet_txn_id, amount, method, received_at, needs_review)
    values (v_rno, v_cust, v_i.id, null, v_t.id, p_amount, 'wallet', now(), false)
    returning * into v_rc;
  insert into public.finance_allocations (receipt_id, invoice_id, amount) values (v_rc.id, v_i.id, p_amount);
  perform public.finance_gl_enqueue('WALLET_PAYMENT', 'wallet_txn', v_t.id, v_t.txn_no, v_cust, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', p_amount)),
    public.finance_gl_issue_dep(v_i.id));
  perform public.finance_log('receipt', v_rc.id, 'receipt.post', jsonb_build_object('invoice', v_i.id, 'amount', p_amount, 'outstanding_before', v_out, 'result', 'wallet', 'wallet_txn', v_t.txn_no));
  return jsonb_build_object('replay', false, 'receipt_no', v_rc.receipt_no, 'txn_no', v_t.txn_no, 'balance', v_t.balance_after, 'state', public.finance_invoice_state_raw(p_invoice));
end $function$;

-- 5 ------------------------------------------------------------------------------------------------------------------------------------------------------
-- Audit lines for the cases the policy cannot block. Both triggers only READ (no lock) and can never stop a payment: an error becomes a WARNING and the payment goes on.
create or replace function public.finance_policy_note() returns trigger language plpgsql security definer set search_path = public as $$
declare v_st jsonb; v_out numeric; v_pending numeric;
begin
  if new.source is distinct from 'staff_entry' then return new; end if;
  if coalesce((select c.payment_policy from public.finance_customers c where c.id = new.customer_id), 'partial') <> 'full' then return new; end if;
  v_st := public.finance_invoice_state_raw(new.invoice_id);
  v_out := (v_st ->> 'outstanding')::numeric;
  v_pending := (v_st ->> 'confirmed_pending')::numeric;       -- everything staff entered and not posted yet, this entry included
  if v_pending < v_out then                                   -- the entries so far do not settle the invoice (it may be one part of a split payment: the last part is not flagged)
    perform public.finance_log('evidence', new.id, 'policy.partial_by_staff', jsonb_build_object('invoice', new.invoice_id, 'amount', coalesce(new.confirmed_amount, new.claimed_amount),
      'entered_so_far', v_pending, 'outstanding', v_out, 'method', new.method, 'note', 'staff part payment (may be one part of a split payment)'));
  end if;
  return new;
exception when others then
  raise warning 'finance_policy_note: %', sqlerrm;
  return new;      -- an audit line must never stop a payment
end $$;
revoke all on function public.finance_policy_note() from public, anon, authenticated;
drop trigger if exists finance_evidence_policy_note on public.finance_payment_evidence;
create trigger finance_evidence_policy_note after insert on public.finance_payment_evidence for each row execute function public.finance_policy_note();

-- a payment was POSTED (verified by staff, from the wallet, a staff entry) and a full-payment customer still owes part of the invoice: what reached the invoice was less than the whole
-- (staff can verify a lower amount than the customer claimed). The remainder is then the new "whole outstanding amount" the customer pays in one go.
create or replace function public.finance_policy_short_note() returns trigger language plpgsql security definer set search_path = public as $$
declare v_cust uuid; v_out numeric;
begin
  if not new.active then return new; end if;
  select r.customer_id into v_cust from public.finance_receipts r where r.id = new.receipt_id;
  if coalesce((select c.payment_policy from public.finance_customers c where c.id = v_cust), 'partial') <> 'full' then return new; end if;
  v_out := (public.finance_invoice_state_raw(new.invoice_id) ->> 'outstanding')::numeric;
  if v_out > 0 then
    perform public.finance_log('receipt', new.receipt_id, 'policy.balance_left', jsonb_build_object('invoice', new.invoice_id, 'allocated', new.amount, 'outstanding', v_out));
  end if;
  return new;
exception when others then
  raise warning 'finance_policy_short_note: %', sqlerrm;
  return new;
end $$;
revoke all on function public.finance_policy_short_note() from public, anon, authenticated;
drop trigger if exists finance_allocation_policy_note on public.finance_allocations;
create trigger finance_allocation_policy_note after insert on public.finance_allocations for each row execute function public.finance_policy_short_note();
