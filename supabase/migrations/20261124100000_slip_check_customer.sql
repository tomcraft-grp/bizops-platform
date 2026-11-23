-- Payment slips: what the customer is told while their slip is checked, who the QR pays, the file the reader really received, and a place for the QR picture.
-- Builds on 20261120100000_slip_review.sql (the reader, the rules, the staff dashboard). It adds NO new status and changes no money rule:
--   * nothing here confirms, posts or rejects a payment. A slip image never proves that money arrived: only a person who checked the bank record makes a payment
--     official (Confirm, then Post), exactly as before.
--   * with ai_review_enabled off (today) the new answer is always {"state": "none"} and the screens look as they do now.
-- Rollback: supabase/rollbacks/20261124100000_slip_check_customer_down.sql.

-- ================================================================================================= 1 who the QR pays
-- The shop's PromptPay QR carries an e-wallet number and no name, so (a) the customer saw only the label staff typed, and (b) the rules had neither a name nor the digits a
-- slip prints to compare the receiver with, so every slip paid by that QR would have been flagged RECEIVER_MISMATCH. A manager writes the name as slips print it, and
-- when slips print it in another language, that one too.
alter table public.finance_payment_accounts add column if not exists slip_name_alt text;
alter table public.finance_payment_accounts drop constraint if exists finance_payment_accounts_slip_name_alt_chk;
alter table public.finance_payment_accounts add constraint finance_payment_accounts_slip_name_alt_chk check (slip_name_alt is null or length(slip_name_alt) between 3 and 120);

create or replace function public.finance_set_payment_account_name(p_account uuid, p_name text, p_name_alt text default null)
returns public.finance_payment_accounts language plpgsql security definer set search_path = public as $$
declare v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', ' ', 'g')), ''); v_alt text := nullif(btrim(regexp_replace(coalesce(p_name_alt, ''), '[[:cntrl:]]', ' ', 'g')), '');
        v_old public.finance_payment_accounts; a public.finance_payment_accounts;
begin
  perform public.finance_require('manage', 'change the shop payment account');
  select * into v_old from public.finance_payment_accounts where id = p_account for update;
  if not found then raise exception 'Account not found'; end if;
  -- a name that compares as less than three letters would match almost any slip (finance_slip_name strips titles, spaces and masks)
  if length(coalesce(v_name, '')) not between 3 and 120 or length(public.finance_slip_name(v_name)) < 3 then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if v_alt is not null and (length(v_alt) not between 3 and 120 or length(public.finance_slip_name(v_alt)) < 3) then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  update public.finance_payment_accounts set merchant_name = v_name, slip_name_alt = v_alt where id = p_account returning * into a;
  perform public.finance_log('account', a.id, 'account.name', jsonb_build_object('from', v_old.merchant_name, 'to', a.merchant_name, 'alt_from', v_old.slip_name_alt, 'alt_to', a.slip_name_alt));
  return a;
end $$;
revoke execute on function public.finance_set_payment_account_name(uuid, text, text) from public, anon;
grant execute on function public.finance_set_payment_account_name(uuid, text, text) to authenticated;

-- the accounts a customer may pay into (as before), plus the second spelling of the QR account's name
create or replace function public.finance_slip_receivers()
returns table (label text, bank text, digits text, account_name text) language sql stable security definer set search_path = public as $$
  select b.code, b.bank_name_en, b.account_no, b.account_name from public.finance_bank_accounts b where b.active
  union all
  select a.label, 'PromptPay'::text,
         case when a.target_type = 'phone' and a.target like '0066%' then '0' || substr(a.target, 5) else nullif(regexp_replace(a.target, '[^0-9]', '', 'g'), '') end,
         a.merchant_name
    from public.finance_payment_accounts a where a.is_default and a.active
  union all
  select a.label, 'PromptPay'::text, null::text, a.slip_name_alt from public.finance_payment_accounts a where a.is_default and a.active and a.slip_name_alt is not null
$$;

-- ================================================================================================= 2 the file the reader really received
-- The browser sends the fingerprint (sha256) of the slip it uploads; until now nothing compared it with the stored file. The reader now reports the fingerprint of the bytes it
-- downloaded (p_qr.file_sha256). A different one means the declaration was false (a way around "this slip was already submitted"); the same bytes on another slip are a duplicate.
do $p$ declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb)'::regprocedure);
  a := $a$  if jsonb_typeof(p_qr -> 'crc_ok') = 'boolean' and not (p_qr ->> 'crc_ok')::boolean then$a$;
  b := $b$  if coalesce(p_qr ->> 'file_sha256', '') ~ '^[0-9a-f]{64}$' then
    if (p_qr ->> 'file_sha256') <> lower(coalesce(e.file_sha256, '')) then
      f_susp := true;
      v_reasons := v_reasons || public.finance_slip_reason('FILE_HASH_MISMATCH', 'high', 'image', null, null, 'The stored file is not the file the app declared.');
    end if;
    if exists (select 1 from public.finance_slip_analysis x join public.finance_payment_evidence pe on pe.id = x.evidence_id
                where x.status = 'done' and x.evidence_id <> e.id and x.qr ->> 'file_sha256' = p_qr ->> 'file_sha256'
                  and not (pe.invoice_id = e.invoice_id and pe.customer_id = e.customer_id and pe.status in ('rejected', 'more_evidence')
                           and not exists (select 1 from public.finance_receipts c where c.evidence_id = pe.id))) then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_FILE', 'high', 'image', null, null, 'The same file was already sent as another payment slip.');
    end if;
  end if;
$b$ || a;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'finance_classify_slip changed: anchor not found once'; end if;
  execute replace(d, a, b);
end $p$;
create index if not exists finance_slip_analysis_file_idx on public.finance_slip_analysis ((qr ->> 'file_sha256')) where status = 'done' and qr ? 'file_sha256';

-- ================================================================================================= 3 what the customer is told
-- Only about the customer's OWN newest slip, and only what they can see on it themselves: {"state"}
--   none        nothing to say (no slip, the reader is off, or the payment is past this stage: the invoice state already tells the customer)
--   processing  the slip is being read
--   attention   something the customer can fix: the amount, the day, a picture that is not a slip, a slip already used ("code" says which)
--   review      a person at the shop checks it. ON PURPOSE the same answer for a clean reading, an unclear one, a failed one and a SUSPICIOUS one: a customer must not be able
--               to learn from this whether an edited slip passes. No confidence, no signal, no receiver and no reference ever leave the database here.
-- There is no "verified" from a reading: the customer sees "paid" only when the payment is posted (invoice state 5), after the shop checked its bank record.
create or replace function public.finance_my_slip_check(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare i public.finance_invoices; e public.finance_payment_evidence; a public.finance_slip_analysis; v_codes text[]; v_at date; v_to date;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into i from public.finance_invoices where id = p_invoice and customer_id = public.finance_my_customer();
  if not found then raise exception 'Invoice not found' using errcode = '42501'; end if;
  select * into e from public.finance_payment_evidence where invoice_id = i.id and file_path is not null and source = 'customer_slip' order by created_at desc, id desc limit 1;
  if not found or e.status not in ('submitted', 'confirmed') then return jsonb_build_object('state', 'none'); end if;
  select * into a from public.finance_slip_analysis where evidence_id = e.id order by attempt desc limit 1;
  if not found then return jsonb_build_object('state', 'none'); end if;
  if e.status = 'confirmed' then return jsonb_build_object('state', 'review'); end if;
  if a.status in ('queued', 'running') then
    return jsonb_build_object('state', case when a.created_at > now() - interval '3 minutes' then 'processing' else 'review' end);       -- a reader that died never leaves "processing" for ever
  end if;
  if a.status = 'done' then
    -- judged by the individual findings, NOT by the overall result: the answer is the same whether or not the slip also looks suspicious
    v_codes := array(select r ->> 'code' from jsonb_array_elements(coalesce(a.reasons, '[]'::jsonb)) r);
    if 'NOT_A_SLIP' = any (v_codes) then return jsonb_build_object('state', 'attention', 'code', 'NOT_A_SLIP'); end if;
    if v_codes && array['UNREADABLE', 'AMOUNT_MISSING', 'DATE_MISSING'] then return jsonb_build_object('state', 'attention', 'code', 'UNREADABLE'); end if;
    if v_codes && array['DUPLICATE_REFERENCE', 'DUPLICATE_FILE'] then return jsonb_build_object('state', 'attention', 'code', 'DUPLICATE'); end if;
    if v_codes && array['AMOUNT_UNDER', 'AMOUNT_OVER'] then
      return jsonb_build_object('state', 'attention', 'code', 'AMOUNT', 'slip_amount', a.extracted -> 'amount', 'expected_amount', a.expected -> 'amount');
    end if;
    if 'DATE_OUT_OF_RANGE' = any (v_codes) then
      begin v_at := ((a.extracted ->> 'transfer_at')::timestamptz at time zone 'Asia/Bangkok')::date; exception when others then v_at := null; end;
      v_to := ((a.expected ->> 'window_to')::timestamptz at time zone 'Asia/Bangkok')::date;
      return jsonb_build_object('state', 'attention', 'code', case when v_at > v_to then 'DATE_FUTURE' else 'DATE_PAST' end, 'slip_date', v_at, 'expected_date', v_to);
    end if;
  end if;
  return jsonb_build_object('state', 'review');
end $$;
revoke execute on function public.finance_my_slip_check(uuid) from public, anon;
grant execute on function public.finance_my_slip_check(uuid) to authenticated;

-- ================================================================================================= 4 the QR picture as a real file
-- LINE's in-app browser cannot download a picture a page made itself. The app puts the PNG here (one file per customer, overwritten every time) and opens a short-lived signed
-- link in the phone's own browser, which can save it. Private, PNG only, 1 MB, only the customer's own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-qr', 'payment-qr', false, 1048576, array['image/png'])
on conflict (id) do nothing;
drop policy if exists "payment qr: add own" on storage.objects;
create policy "payment qr: add own" on storage.objects for insert to authenticated with check (bucket_id = 'payment-qr' and name = auth.uid()::text || '/payment-qr.png');
drop policy if exists "payment qr: replace own" on storage.objects;
create policy "payment qr: replace own" on storage.objects for update to authenticated
  using (bucket_id = 'payment-qr' and name = auth.uid()::text || '/payment-qr.png') with check (bucket_id = 'payment-qr' and name = auth.uid()::text || '/payment-qr.png');
drop policy if exists "payment qr: read own" on storage.objects;
create policy "payment qr: read own" on storage.objects for select to authenticated using (bucket_id = 'payment-qr' and name = auth.uid()::text || '/payment-qr.png');
