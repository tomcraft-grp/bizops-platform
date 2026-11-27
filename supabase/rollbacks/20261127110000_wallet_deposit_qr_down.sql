-- Rolls back 20261127110000_wallet_deposit_qr.sql: the three functions and the bank_account_id column of finance_payment_accounts go.
-- Refuses while a QR account is linked to a bank account (that setting would be lost): unlink it first with finance_set_payment_account_bank(account, null).
-- Afterwards delete version 20261127110000 from supabase_migrations.schema_migrations.
do $$ begin
  if exists (select 1 from public.finance_payment_accounts where bank_account_id is not null) then raise exception 'REFUSING: a QR account is linked to a bank account (unlink it first)'; end if;
end $$;
drop function public.finance_deposit_qr(uuid);
drop function public.finance_deposit_qr_bank();
drop function public.finance_set_payment_account_bank(uuid, uuid);
alter table public.finance_payment_accounts drop column bank_account_id;
