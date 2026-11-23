-- Rolls back 20261124110000_own_slip_reader.sql. Readings already stored stay in finance_slip_analysis (history is never changed).
drop function if exists public.finance_store_reading(uuid, jsonb, jsonb, numeric, text, text);
drop function if exists public.finance_set_own_reader(boolean);
drop function if exists public.finance_own_reader();
alter table public.finance_settings drop column if exists own_reader_enabled;
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
