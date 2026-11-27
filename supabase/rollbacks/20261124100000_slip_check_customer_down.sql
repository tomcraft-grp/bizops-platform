-- Rolls back 20261124100000_slip_check_customer.sql. The names a manager wrote (merchant_name) stay: they are the shop's data and the column existed before. The QR pictures bucket is removed
-- only when it is empty. Finished analyses that carry the new reasons stay as they are (history is never changed); an older app shows an unknown reason as its code.
drop function if exists public.finance_my_slip_check(uuid);
drop function if exists public.finance_set_payment_account_name(uuid, text, text);
create or replace function public.finance_slip_receivers()
returns table (label text, bank text, digits text, account_name text) language sql stable security definer set search_path = public as $$
  select b.code, b.bank_name_en, b.account_no, b.account_name from public.finance_bank_accounts b where b.active
  union all
  select a.label, 'PromptPay'::text,
         case when a.target_type = 'phone' and a.target like '0066%' then '0' || substr(a.target, 5) else nullif(regexp_replace(a.target, '[^0-9]', '', 'g'), '') end,
         a.merchant_name
    from public.finance_payment_accounts a where a.is_default and a.active
$$;
alter table public.finance_payment_accounts drop constraint if exists finance_payment_accounts_slip_name_alt_chk;
alter table public.finance_payment_accounts drop column if exists slip_name_alt;
drop index if exists public.finance_slip_analysis_file_idx;
do $p$ declare d text; s integer; e integer;
begin
  d := pg_get_functiondef('public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb)'::regprocedure);
  s := position($a$  if coalesce(p_qr ->> 'file_sha256', '') ~$a$ in d);
  e := position($a$  if jsonb_typeof(p_qr -> 'crc_ok') = 'boolean' and not$a$ in d);
  if s = 0 or e <= s then raise exception 'finance_classify_slip changed: the block to remove was not found'; end if;
  execute substr(d, 1, s - 1) || substr(d, e);
end $p$;
drop policy if exists "payment qr: add own" on storage.objects;
drop policy if exists "payment qr: replace own" on storage.objects;
drop policy if exists "payment qr: read own" on storage.objects;
delete from storage.buckets b where b.id = 'payment-qr' and not exists (select 1 from storage.objects o where o.bucket_id = b.id);
