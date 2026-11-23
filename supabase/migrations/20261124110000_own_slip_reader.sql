-- The shop's own slip reader: no AI service, no key, no picture leaves the shop. The staff browser reads the slip (OCR and the slip's own QR) and stores what it read here; the SAME rules
-- as for the AI reader (finance_classify_slip) judge it and the SAME log (finance_slip_analysis) keeps it. Nothing here confirms, posts or rejects a payment.
-- Dark: own_reader_enabled is off until a manager switches it on. Rollback: supabase/rollbacks/20261124110000_own_slip_reader_down.sql.

alter table public.finance_settings add column if not exists own_reader_enabled boolean not null default false;

-- is it on, and what may the caller do with it? (a customer learns only whether it is on: their phone may then warn them about their own slip)
create or replace function public.finance_own_reader()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  return jsonb_build_object('enabled', coalesce((select s.own_reader_enabled from public.finance_settings s where s.id), false),
    'can_read', coalesce(public.finance_can('verify'), false), 'can_manage', coalesce(public.finance_can('manage'), false));
end $$;

create or replace function public.finance_set_own_reader(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old boolean;
begin
  perform public.finance_require('manage', 'change the review settings');
  if p_on is null then raise exception 'INVALID_SETTING' using errcode = '22023'; end if;
  select own_reader_enabled into v_old from public.finance_settings where id for update;
  update public.finance_settings set own_reader_enabled = p_on where id;
  perform public.finance_log('settings', gen_random_uuid(), 'settings.own_reader', jsonb_build_object('from', v_old, 'to', p_on));
  return public.finance_own_reader();
end $$;

/*
  Stores one reading. p_extracted / p_qr follow the contract of the AI reader. What is NOT taken from the browser:
    - the receiver: OCR garbles Thai names, so the browser sends the text it read (p_text, never stored) and the database looks for one of the shop's own names or account numbers in it.
      Found: that account is the receiver. Not found: the receiver stays unclear and the result can never be "match" (the confidence is held below the limit).
    - the expected amount, date and receiver: they come from the order, as always.
  The row is written already finished, so the LINE alert for a finished AI reading does not fire: the person who pressed the button is looking at the result.
*/
create or replace function public.finance_store_reading(p_evidence uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_text text, p_engine text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; s public.finance_settings; a public.finance_slip_analysis; v jsonb; v_n integer; v_x jsonb; v_conf numeric; v_flat text; v_digits text; r record; v_name text; v_tok text;
begin
  perform public.finance_require('verify', 'read a payment slip');
  select * into s from public.finance_settings where id;
  if not coalesce(s.own_reader_enabled, false) then raise exception 'READER_OFF: the slip reader is switched off'; end if;
  if coalesce(p_engine, '') !~ '^browser-ocr/[0-9a-z.]{1,12}$' or jsonb_typeof(p_extracted) is distinct from 'object' or jsonb_typeof(p_qr) is distinct from 'object'
     or length(p_extracted::text) > 6000 or length(p_qr::text) > 1000 or length(coalesce(p_text, '')) > 12000 or p_confidence is null or p_confidence not between 0 and 1 then
    raise exception 'INVALID_READING' using errcode = '22023'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;                      -- serialises the attempt numbers of one slip
  if not found then raise exception 'NOT_FOUND: slip not found'; end if;
  if e.file_path is null then raise exception 'NOTHING_TO_DO: this payment has no slip image'; end if;
  if e.status not in ('submitted', 'confirmed') then raise exception 'NOTHING_TO_DO: this slip is already %', e.status; end if;
  select * into a from public.finance_slip_analysis where evidence_id = e.id order by attempt desc limit 1;
  if found and a.status in ('queued', 'running') and a.created_at > now() - interval '5 minutes' then raise exception 'ALREADY_QUEUED: an analysis of this slip is already waiting or running'; end if;
  select count(*) into v_n from public.finance_slip_analysis where evidence_id = e.id;
  if v_n >= 5 then raise exception 'TOO_MANY_ATTEMPTS: this slip has already been analysed % times', v_n; end if;

  -- who is paid: one of our names (the first name, at least four letters) or the last five digits of one of our accounts standing on their own
  v_flat := regexp_replace(lower(coalesce(p_text, '')), '[\s.,''"_*•-]+', '', 'g');
  v_digits := regexp_replace(coalesce(p_text, ''), '[\s.-]+', '', 'g');
  for r in select x.digits, x.account_name from public.finance_slip_receivers() x loop
    v_tok := lower(split_part(regexp_replace(btrim(coalesce(r.account_name, '')), '^(นางสาว|นาง|น\.\s*ส\.?|คุณ|นาย|(mrs|mr|ms|miss)(\.|\s+))\s*', '', 'i'), ' ', 1));
    if length(v_tok) >= 4 and position(v_tok in v_flat) > 0 then v_name := r.account_name; end if;
    if v_name is null and length(coalesce(r.digits, '')) >= 8 and v_digits ~ ('(^|[^0-9])' || right(r.digits, 5) || '([^0-9]|$)') then v_name := coalesce(r.account_name, ''); end if;
    exit when v_name is not null;
  end loop;
  v_x := p_extracted || jsonb_build_object('sender', jsonb_build_object('name', null, 'bank', null, 'account_hint', null),
    'receiver', jsonb_build_object('name', nullif(v_name, ''), 'bank', null, 'account_hint', null));
  v_conf := case when v_name is null then least(p_confidence, greatest(s.ai_min_confidence - 0.01, 0)) else p_confidence end;
  v := public.finance_classify_slip(e.id, v_x, p_qr, v_conf, '[]'::jsonb);
  insert into public.finance_slip_analysis (evidence_id, attempt, status, engine, prompt_version, extracted, qr, expected, overall_confidence, signals, result, reasons, requested_by, started_at, finished_at)
    values (e.id, coalesce(a.attempt, 0) + 1, 'done', p_engine, 'own-v1', v_x, p_qr, v -> 'expected', round(v_conf, 3), '[]'::jsonb, v ->> 'result', v -> 'reasons', auth.uid(), now(), now());
  perform public.finance_log('evidence', e.id, 'evidence.analysis', jsonb_build_object('result', v ->> 'result', 'confidence', round(v_conf, 3), 'engine', p_engine));
  return jsonb_build_object('result', v ->> 'result', 'receiver_found', v_name is not null);
end $$;
revoke execute on function public.finance_own_reader(), public.finance_set_own_reader(boolean), public.finance_store_reading(uuid, jsonb, jsonb, numeric, text, text) from public, anon;
grant execute on function public.finance_own_reader(), public.finance_set_own_reader(boolean), public.finance_store_reading(uuid, jsonb, jsonb, numeric, text, text) to authenticated;

-- what the customer is told (as in 20261124100000), but a reading of our own reader is only passed on when it is sure of that very value: OCR that could not read something says nothing
-- about the customer's slip, so "unreadable" and "not a slip" from it mean "a person checks it".
create or replace function public.finance_my_slip_check(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare i public.finance_invoices; e public.finance_payment_evidence; a public.finance_slip_analysis; v_codes text[]; v_at date; v_to date; v_own boolean;
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
    v_own := coalesce(a.engine, '') like 'browser-ocr/%';
    if not v_own and 'NOT_A_SLIP' = any (v_codes) then return jsonb_build_object('state', 'attention', 'code', 'NOT_A_SLIP'); end if;
    if not v_own and v_codes && array['UNREADABLE', 'AMOUNT_MISSING', 'DATE_MISSING'] then return jsonb_build_object('state', 'attention', 'code', 'UNREADABLE'); end if;
    if v_codes && array['DUPLICATE_REFERENCE', 'DUPLICATE_FILE'] then return jsonb_build_object('state', 'attention', 'code', 'DUPLICATE'); end if;
    if v_codes && array['AMOUNT_UNDER', 'AMOUNT_OVER'] and (not v_own or coalesce((a.extracted #>> '{field_confidence,amount}')::numeric, 0) >= 0.9) then
      return jsonb_build_object('state', 'attention', 'code', 'AMOUNT', 'slip_amount', a.extracted -> 'amount', 'expected_amount', a.expected -> 'amount');
    end if;
    if 'DATE_OUT_OF_RANGE' = any (v_codes) and (not v_own or coalesce((a.extracted #>> '{field_confidence,date}')::numeric, 0) >= 0.9) then
      begin v_at := ((a.extracted ->> 'transfer_at')::timestamptz at time zone 'Asia/Bangkok')::date; exception when others then v_at := null; end;
      v_to := ((a.expected ->> 'window_to')::timestamptz at time zone 'Asia/Bangkok')::date;
      return jsonb_build_object('state', 'attention', 'code', case when v_at > v_to then 'DATE_FUTURE' else 'DATE_PAST' end, 'slip_date', v_at, 'expected_date', v_to);
    end if;
  end if;
  return jsonb_build_object('state', 'review');
end $$;
