-- PromptPay QR for a wallet top-up (FB-001042: "topping up a customer's wallet has no QR Code payment option").
--
-- Why: the invoice screen and the checkout already show the shop's PromptPay QR with the amount filled in (finance_request_payment, shop_checkout_qr), but the wallet top-up only
-- offered bank account numbers. A wallet deposit must be booked to ONE of the shop's bank accounts (finance_wallet_deposits.bank_account_id, required, never changed), and the shop's QR
-- account (finance_payment_accounts) is a different table with no link to a bank account (on 2026-11-27 the QR is a KASIKORN e-wallet while the bank accounts are SCB and BBL). Showing a QR
-- under a bank the customer picked would book the money to the wrong account and break the bank reconciliation. So the link is made explicit:
--   1. finance_payment_accounts.bank_account_id (nullable): the bank account the QR pays into. A manager sets it with finance_set_payment_account_bank. Until it is set the top-up shows no QR.
--   2. finance_deposit_qr_bank(): what the customer app asks first: is there a QR for top-ups, and which bank account does the deposit have to be created with? (null = no QR option)
--   3. finance_deposit_qr(deposit): the QR for the amount of the caller's OWN pending deposit, put into the shop's default QR with the SAME function the invoice QR uses (finance_qr_with_amount).
--      It refuses unless the deposit was created with the QR's own bank account, so a QR is never shown for a deposit that would be booked elsewhere. It writes nothing.
-- The wallet is still credited only after the customer sends the slip and staff verify it (finance_deposit_verify, unchanged); the slip checker already accepts the QR account as a receiver.
-- No existing function or policy changes. Rollback: supabase/rollbacks/20261127110000_wallet_deposit_qr_down.sql (refuses while a QR account is linked: unlink it first).

alter table public.finance_payment_accounts add column if not exists bank_account_id uuid references public.finance_bank_accounts (id) on delete restrict;

create or replace function public.finance_set_payment_account_bank(p_account uuid, p_bank uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.finance_payment_accounts; v_old uuid;
begin
  perform public.finance_require('manage', 'link the shop QR to a bank account');
  select * into a from public.finance_payment_accounts where id = p_account for update;
  if not found then raise exception 'NOT_FOUND: payment account'; end if;
  if p_bank is not null and not exists (select 1 from public.finance_bank_accounts where id = p_bank and active) then raise exception 'BANK_NOT_AVAILABLE'; end if;
  v_old := a.bank_account_id;
  if v_old is not distinct from p_bank then return jsonb_build_object('id', a.id, 'bank_account_id', a.bank_account_id, 'changed', false); end if;
  update public.finance_payment_accounts set bank_account_id = p_bank where id = a.id returning * into a;
  perform public.finance_log('account', a.id, 'account.bank_link', jsonb_build_object('from', v_old, 'to', p_bank));
  return jsonb_build_object('id', a.id, 'bank_account_id', a.bank_account_id, 'changed', true);
end $$;
revoke execute on function public.finance_set_payment_account_bank(uuid, uuid) from public, anon;
grant execute on function public.finance_set_payment_account_bank(uuid, uuid) to authenticated;

create or replace function public.finance_deposit_qr_bank()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare acct public.finance_payment_accounts;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into acct from public.finance_payment_accounts where is_default and active;
  if not found or acct.bank_account_id is null or not exists (select 1 from public.finance_bank_accounts where id = acct.bank_account_id and active) then return null; end if;
  return jsonb_build_object('bank_account_id', acct.bank_account_id, 'account_label', acct.label, 'merchant_name', acct.merchant_name);
end $$;
revoke execute on function public.finance_deposit_qr_bank() from public, anon;
grant execute on function public.finance_deposit_qr_bank() to authenticated;

create or replace function public.finance_deposit_qr(p_deposit uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.finance_wallet_deposits; acct public.finance_payment_accounts;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into d from public.finance_wallet_deposits where id = p_deposit and customer_id = public.finance_my_customer();
  if not found then raise exception 'Deposit not found' using errcode = '42501'; end if;
  if d.status <> 'pending' then raise exception 'DEPOSIT_NOT_PAYABLE: this deposit is %', d.status; end if;
  select * into acct from public.finance_payment_accounts where is_default and active;
  if not found then raise exception 'NO_PAYMENT_ACCOUNT'; end if;
  if acct.bank_account_id is null then raise exception 'QR_NOT_LINKED: the shop has not linked its QR to a bank account yet'; end if;
  if d.bank_account_id is distinct from acct.bank_account_id then raise exception 'QR_NOT_FOR_THIS_BANK: this deposit was created for another bank account'; end if;
  return jsonb_build_object('amount', d.amount, 'qr_payload', public.finance_qr_with_amount(acct.qr_payload, d.amount), 'deposit_no', d.deposit_no,
    'account_label', acct.label, 'merchant_name', acct.merchant_name);
end $$;
revoke execute on function public.finance_deposit_qr(uuid) from public, anon;
grant execute on function public.finance_deposit_qr(uuid) to authenticated;
