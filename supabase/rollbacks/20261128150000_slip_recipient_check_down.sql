-- Rolls back 20261128150000_slip_recipient_check.sql: the classifier, the AI reader's completion, the own reader and finance_own_reader get back the definitions they had
-- before it (copied from a database built without it; tests: supabase/tests/slip_recipient_check_down_post.sql), and the functions it added are dropped.
-- KEPT on purpose, so that nothing anyone recorded is lost: the columns decision / recipient / rules_version of finance_slip_analysis (append-only history), the tables
-- finance_slip_feedback and finance_slip_name_variants (staff judgements, approved spellings). Nothing reads them once this has run. Section 3 removes them too, and refuses
-- while they hold anything.

-- 1 the functions as they were
CREATE OR REPLACE FUNCTION public.finance_classify_slip(p_evidence uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_signals jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e public.finance_payment_evidence; inv public.finance_invoices; s public.finance_settings;
  v_exp numeric; v_order_at timestamptz; v_from timestamptz; v_to timestamptz; v_expected jsonb; v_reasons jsonb := '[]'::jsonb; v_min numeric;
  v_is_slip boolean; v_amount numeric; v_ts text; v_at timestamptz; v_time_known boolean;
  v_ref text; v_qref text; v_refs text[]; v_status text; sig jsonb;
  h record; v_dup_an text[] := '{}'; v_dup_rc text[] := '{}'; v_dup_ev text[] := '{}'; v_dup_wd text[] := '{}'; v_soft uuid[] := '{}'; v_ev uuid;
  v_digits text; v_name text; v_has_digits boolean; v_has_name boolean; v_ok boolean; rcv record;
  d_t date; d_from date; d_to date;
  f_manual boolean := false; f_dup boolean := false; f_susp boolean := false; f_amount boolean := false; f_date boolean := false; f_time boolean := false; f_conf boolean := false;
begin
  select * into e from public.finance_payment_evidence where id = p_evidence;
  if not found then raise exception 'NOT_FOUND: slip not found'; end if;
  select * into inv from public.finance_invoices where id = e.invoice_id;
  select * into s from public.finance_settings where id;

  -- what the order expects: the payment request this slip was made for, else what is still outstanding (posted receipts only)
  if e.request_id is not null then select r.amount into v_exp from public.finance_payment_requests r where r.id = e.request_id; end if;
  if v_exp is null then
    select greatest(inv.amount - coalesce(sum(a.amount), 0), 0) into v_exp from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id
      where a.invoice_id = inv.id and a.active and r.status = 'posted';
  end if;
  select o.created_at into v_order_at from public.shop_orders o where o.invoice_id = inv.id;
  v_order_at := coalesce(v_order_at, inv.created_at);
  v_from := v_order_at - make_interval(mins => s.slip_window_before_min);
  v_to := e.created_at + make_interval(mins => s.slip_future_tolerance_min);
  v_expected := jsonb_build_object('amount', v_exp, 'order_created_at', v_order_at, 'window_from', v_from, 'window_to', v_to,
    'receivers', (select coalesce(jsonb_agg(jsonb_build_object('label', r.label, 'bank', r.bank, 'name', r.account_name,
                                            'account_no_masked_digits', case when r.digits is null then null else 'xxxxxx' || right(r.digits, 4) end) order by r.label), '[]'::jsonb)
                    from public.finance_slip_receivers() r));

  -- rule 1, part 1: nothing usable. Nothing else is judged: the values of a picture that is not a slip mean nothing.
  if jsonb_typeof(p_extracted) = 'object' and jsonb_typeof(p_extracted -> 'is_slip') = 'boolean' then v_is_slip := (p_extracted ->> 'is_slip')::boolean; end if;
  if v_is_slip is null then
    return jsonb_build_object('result', 'manual_review', 'expected', v_expected, 'reasons', jsonb_build_array(
      public.finance_slip_reason('UNREADABLE', 'warn', 'image', null, null, 'The reader gave no usable answer; a person has to look at the slip.')));
  elsif not v_is_slip then
    return jsonb_build_object('result', 'manual_review', 'expected', v_expected, 'reasons', jsonb_build_array(
      public.finance_slip_reason('NOT_A_SLIP', 'high', 'image', null, null, 'The reader says this picture is not a transfer slip.')));
  end if;

  -- what was read (a value of the wrong type counts as missing; the date is read as Bangkok time when it carries no offset)
  if jsonb_typeof(p_extracted -> 'amount') = 'number' then v_amount := round((p_extracted ->> 'amount')::numeric, 2); if v_amount <= 0 then v_amount := null; end if; end if;   -- read to the satang
  if jsonb_typeof(p_extracted -> 'time_known') = 'boolean' then v_time_known := (p_extracted ->> 'time_known')::boolean; end if;
  v_ts := nullif(btrim(p_extracted ->> 'transfer_at'), '');
  if v_ts ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
    begin
      if v_ts ~ '[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?\s*([zZ]|[+-][0-9]{2}(:?[0-9]{2})?)$' then v_at := v_ts::timestamptz;
      else v_at := v_ts::timestamp at time zone 'Asia/Bangkok'; end if;
    exception when others then v_at := null;
    end;
  end if;

  -- rule 1, part 2: a missing amount or date
  if v_amount is null then
    f_manual := true;
    v_reasons := v_reasons || public.finance_slip_reason('AMOUNT_MISSING', 'warn', 'amount', to_jsonb(v_exp), to_jsonb(left(p_extracted ->> 'amount', 300)), 'The amount could not be read from the slip.');
  end if;
  if v_at is null then
    f_manual := true;
    v_reasons := v_reasons || public.finance_slip_reason('DATE_MISSING', 'warn', 'transfer_at', null, to_jsonb(left(p_extracted ->> 'transfer_at', 300)), 'The transfer date could not be read from the slip.');
  end if;

  -- rule 2: the bank reference (printed on the slip and in its QR) was already seen: another finished analysis, a receipt, another slip, a wallet deposit.
  -- (each source is looked up with "ref column is not null" next to the normalised comparison, so the planner can use the partial expression indexes of 2g)
  -- Exception: an EARLIER slip of the same customer on the same invoice that was sent back (rejected / more evidence) and has no receipt is the customer resending
  -- the same transfer: an info reason (RESUBMITTED_TRANSFER) and the other rules decide. Every other hit (another invoice or customer, a receipt, a wallet deposit,
  -- a slip that is still live: submitted, confirmed or posted) is a suspected duplicate, and one such hit is enough.
  v_ref := public.finance_slip_ref(p_extracted ->> 'trans_ref');
  v_qref := public.finance_slip_ref(p_qr ->> 'trans_ref');
  v_refs := array(select distinct q.r from unnest(array[v_ref, v_qref]) as q(r) where length(q.r) >= 4);        -- a shorter one counts as absent
  if coalesce(array_length(v_refs, 1), 0) > 0 then
    for h in
      select q.r as ref, 'analysis'::text as src, a.evidence_id as ev from unnest(v_refs) as q(r) join public.finance_slip_analysis a
        on a.status = 'done' and a.evidence_id <> e.id and (public.finance_slip_ref(a.extracted ->> 'trans_ref') = q.r or public.finance_slip_ref(a.qr ->> 'trans_ref') = q.r)
      union all
      select q.r, 'receipt', c.evidence_id from unnest(v_refs) as q(r) join public.finance_receipts c
        on c.evidence_id is distinct from e.id and c.bank_trans_ref is not null and public.finance_slip_ref(c.bank_trans_ref) = q.r
      union all
      select q.r, 'evidence', x.id from unnest(v_refs) as q(r) join public.finance_payment_evidence x
        on x.id <> e.id and ((x.bank_trans_ref is not null and public.finance_slip_ref(x.bank_trans_ref) = q.r) or (x.confirmed_bank_ref is not null and public.finance_slip_ref(x.confirmed_bank_ref) = q.r))
      union all
      select q.r, 'deposit', null::uuid from unnest(v_refs) as q(r) join public.finance_wallet_deposits d on d.bank_trans_ref is not null and public.finance_slip_ref(d.bank_trans_ref) = q.r
    loop
      if h.src in ('analysis', 'evidence') and exists (select 1 from public.finance_payment_evidence p
           where p.id = h.ev and p.invoice_id = e.invoice_id and p.customer_id = e.customer_id and p.status in ('rejected', 'more_evidence')
             and not exists (select 1 from public.finance_receipts c where c.evidence_id = p.id)) then
        v_soft := array_append(v_soft, h.ev);
      elsif h.src = 'analysis' then v_dup_an := array_append(v_dup_an, h.ref);
      elsif h.src = 'receipt' then v_dup_rc := array_append(v_dup_rc, h.ref);
      elsif h.src = 'evidence' then v_dup_ev := array_append(v_dup_ev, h.ref);
      else v_dup_wd := array_append(v_dup_wd, h.ref);
      end if;
    end loop;
    if cardinality(v_dup_an) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_an) as u), ', '), 300)), 'This bank reference was already read on another slip.');
    end if;
    if cardinality(v_dup_rc) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_rc) as u), ', '), 300)), 'This bank reference is already on a receipt.');
    end if;
    if cardinality(v_dup_ev) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_ev) as u), ', '), 300)), 'This bank reference is already on another payment slip.');
    end if;
    if cardinality(v_dup_wd) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_wd) as u), ', '), 300)), 'This bank reference is already on a wallet deposit.');
    end if;
    for v_ev in select distinct u from unnest(v_soft) as u loop
      v_reasons := v_reasons || public.finance_slip_reason('RESUBMITTED_TRANSFER', 'info', 'trans_ref', null, to_jsonb(v_ev::text),
        'This transfer was already sent on an earlier slip of this order that was sent back or rejected: the customer resent it.');
    end loop;
  end if;

  -- rule 3: signs of tampering, a QR that disagrees with the slip, a receiver that is not ours, a transfer that did not succeed
  if jsonb_typeof(p_signals) = 'array' then
    for sig in select j.value from jsonb_array_elements(p_signals) as j where j.value ->> 'severity' = 'high' loop
      f_susp := true;
      v_reasons := v_reasons || public.finance_slip_reason('TAMPER_SIGNAL', 'high', 'image', null, to_jsonb(left(coalesce(sig ->> 'code', 'unknown'), 300)),
        left(coalesce(nullif(btrim(sig ->> 'detail'), ''), 'The reader found a sign that the picture was edited.'), 300));
    end loop;
  end if;
  if coalesce(p_qr ->> 'file_sha256', '') ~ '^[0-9a-f]{64}$' then
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
  if jsonb_typeof(p_qr -> 'crc_ok') = 'boolean' and not (p_qr ->> 'crc_ok')::boolean then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('QR_BAD_CRC', 'high', 'qr', to_jsonb(true), to_jsonb(false), 'The checksum of the QR code on the slip is wrong.');
  end if;
  if length(v_ref) >= 4 and length(v_qref) >= 4 and v_ref <> v_qref then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('QR_REF_MISMATCH', 'high', 'trans_ref', to_jsonb(left(v_ref, 300)), to_jsonb(left(v_qref, 300)), 'The reference in the QR code is not the reference printed on the slip.');
  end if;
  -- receiver: the visible account digits (3 or more) are an ordered subsequence of one of our accounts, or the name (titles stripped) is the start of an account name
  v_digits := left(regexp_replace(coalesce(p_extracted -> 'receiver' ->> 'account_hint', ''), '[^0-9]', '', 'g'), 20);   -- more than any account has can match none
  v_name := public.finance_slip_name(p_extracted -> 'receiver' ->> 'name');
  v_has_digits := length(v_digits) >= 3;
  v_has_name := length(v_name) >= 3;
  if v_has_digits or v_has_name then
    v_ok := false;
    for rcv in select r.digits, r.account_name from public.finance_slip_receivers() r loop
      if v_has_digits and rcv.digits is not null and length(v_digits) <= length(rcv.digits) and rcv.digits ~ regexp_replace(v_digits, '(.)', '\1[0-9]*', 'g') then v_ok := true; end if;
      if v_has_name and rcv.account_name is not null and position(v_name in public.finance_slip_name(rcv.account_name)) = 1 then v_ok := true; end if;
      exit when v_ok;
    end loop;
    if not v_ok then
      f_susp := true;
      v_reasons := v_reasons || public.finance_slip_reason('RECEIVER_MISMATCH', 'high', 'receiver', (select jsonb_agg(r.label order by r.label) from public.finance_slip_receivers() r),
        jsonb_build_object('name', left(p_extracted -> 'receiver' ->> 'name', 300), 'account_hint', left(p_extracted -> 'receiver' ->> 'account_hint', 300)), 'The slip shows a receiver that is not one of the shop''s accounts.');
    end if;
  else
    v_reasons := v_reasons || public.finance_slip_reason('RECEIVER_UNCLEAR', 'warn', 'receiver', null, null, 'The receiver could not be read well enough to compare with the shop''s accounts.');
  end if;
  v_status := nullif(btrim(p_extracted ->> 'status_text'), '');
  if v_status is not null and v_status ~* 'ไม่สำเร็จ|ล้มเหลว|ไม่ผ่าน|ยกเลิก|fail|unsuccess|reject|cancel|pending' then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('STATUS_NOT_SUCCESS', 'high', 'status_text', null, to_jsonb(left(v_status, 300)), 'The slip does not say that the transfer succeeded.');
  end if;

  -- rule 4: the amount, exact to the satang
  if v_amount is not null and v_amount <> v_exp then
    f_amount := true;
    v_reasons := v_reasons || public.finance_slip_reason(case when v_amount < v_exp then 'AMOUNT_UNDER' else 'AMOUNT_OVER' end, 'high', 'amount', to_jsonb(v_exp), to_jsonb(v_amount),
      case when v_amount < v_exp then 'The slip shows less than the order expects.' else 'The slip shows more than the order expects.' end);
  end if;

  -- rule 5: the Bangkok calendar day first (date_mismatch); then the time of day (time_anomaly), which is also what an unknown time is
  if v_at is not null then
    d_t := (v_at at time zone 'Asia/Bangkok')::date;
    d_from := (v_from at time zone 'Asia/Bangkok')::date;
    d_to := (v_to at time zone 'Asia/Bangkok')::date;
    if d_t < d_from or d_t > d_to then
      f_date := true;
      v_reasons := v_reasons || public.finance_slip_reason('DATE_OUT_OF_RANGE', 'high', 'transfer_at', jsonb_build_object('from', d_from, 'to', d_to), to_jsonb(d_t),
        'The transfer is on a different day from the order.');
    elsif v_time_known is not true then
      f_time := true;
      v_reasons := v_reasons || public.finance_slip_reason('TIME_MISSING', 'warn', 'time', jsonb_build_object('from', v_from, 'to', v_to), null, 'The slip shows no time of day.');
    elsif v_at < v_from or v_at > v_to then
      f_time := true;
      v_reasons := v_reasons || public.finance_slip_reason('TIME_OUT_OF_RANGE', 'warn', 'time', jsonb_build_object('from', v_from, 'to', v_to), to_jsonb(v_at),
        'The transfer time is outside the allowed window around the order.');
    end if;
  end if;

  -- rule 6: how sure the reader is (overall, and about the amount)
  v_min := s.ai_min_confidence;
  if p_confidence is null or p_confidence < v_min then
    f_conf := true;
    v_reasons := v_reasons || public.finance_slip_reason('LOW_CONFIDENCE', 'warn', 'overall_confidence', to_jsonb(v_min), to_jsonb(p_confidence), 'The reader is not sure enough about this slip.');
  end if;
  if jsonb_typeof(p_extracted #> '{field_confidence,amount}') = 'number' and (p_extracted #>> '{field_confidence,amount}')::numeric < v_min then
    f_conf := true;
    v_reasons := v_reasons || public.finance_slip_reason('LOW_CONFIDENCE', 'warn', 'amount', to_jsonb(v_min), p_extracted #> '{field_confidence,amount}', 'The reader is not sure enough about the amount.');
  end if;

  return jsonb_build_object('expected', v_expected, 'reasons', v_reasons, 'result', case
    when f_manual then 'manual_review'
    when f_dup then 'duplicate_suspected'
    when f_susp then 'suspicious_slip'
    when f_amount then 'amount_mismatch'
    when f_date then 'date_mismatch'
    when f_time then 'time_anomaly'
    when f_conf then 'manual_review'
    else 'match' end);
end $function$;

CREATE OR REPLACE FUNCTION public.finance_analysis_complete(p_analysis uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_signals jsonb, p_engine text, p_prompt_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.finance_slip_analysis; v jsonb; v_conf numeric := round(p_confidence, 3);
begin
  select * into a from public.finance_slip_analysis where id = p_analysis for update;
  if not found then raise exception 'NOT_FOUND: analysis not found'; end if;
  if a.status in ('done', 'failed') then raise exception 'ALREADY_DONE: this analysis is already finished'; end if;
  if v_conf is not null and v_conf not between 0 and 1 then raise exception 'INVALID_CONFIDENCE: the confidence must be between 0 and 1'; end if;
  v := public.finance_classify_slip(a.evidence_id, p_extracted, p_qr, p_confidence, coalesce(p_signals, '[]'::jsonb));   -- judged as reported; only the stored copy is rounded
  update public.finance_slip_analysis set status = 'done', engine = nullif(btrim(p_engine), ''), prompt_version = nullif(btrim(p_prompt_version), ''),
    extracted = p_extracted, qr = p_qr, expected = v -> 'expected', overall_confidence = v_conf, signals = coalesce(p_signals, '[]'::jsonb),
    result = v ->> 'result', reasons = v -> 'reasons', error = null, finished_at = now() where id = a.id;
  perform public.finance_log('evidence', a.evidence_id, 'evidence.analysis', jsonb_build_object('result', v ->> 'result', 'confidence', v_conf));
  return jsonb_build_object('result', v ->> 'result', 'reasons', v -> 'reasons');
end $function$;

CREATE OR REPLACE FUNCTION public.finance_store_reading(p_evidence uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_text text, p_engine text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.finance_own_reader()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.finance_settings;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into s from public.finance_settings where id;
  return jsonb_build_object('enabled', coalesce(s.own_reader_enabled, false), 'can_read', coalesce(public.finance_can('verify'), false), 'can_manage', coalesce(public.finance_can('manage'), false),
    'checkout', coalesce(s.checkout_check_enabled, false), 'before_min', coalesce(s.slip_window_before_min, 120), 'after_min', coalesce(s.slip_future_tolerance_min, 10));
end $function$;

-- 2 what 20261128150000 added
drop function if exists public.finance_slip_learning(integer);
drop function if exists public.finance_slip_variant_retire(uuid, text);
drop function if exists public.finance_slip_variant_add(text, text, text, text, text);
drop function if exists public.finance_slip_variant_impact(text, text);
drop function if exists public.finance_slip_recipients();
drop function if exists public.finance_slip_feedback_add(uuid, text, text, text, text, text);
drop function if exists public.finance_slip_decision(text, jsonb, jsonb);
drop function if exists public.finance_recipient_check(jsonb, integer);
drop function if exists public.finance_recipient_candidates(text);
drop function if exists public.finance_recipient_match(text, text);
drop function if exists public.finance_slip_holders();
drop function if exists public.finance_name_parts(text);
drop function if exists public.finance_name_dist(text, text);
drop function if exists public.finance_name_key(text);
drop function if exists public.finance_name_untitle(text);
drop function if exists public.finance_name_tidy(text);

-- 3 (only when nobody recorded anything) the tables and the columns
do $$ begin
  if exists (select 1 from public.finance_slip_feedback) or exists (select 1 from public.finance_slip_name_variants)
     or exists (select 1 from public.finance_slip_analysis where decision is not null or recipient is not null or rules_version is not null) then
    raise notice 'slip recipient check: feedback, spellings or outcomes were recorded; the tables and columns are kept';
  else
    drop table public.finance_slip_feedback;
    drop function if exists public.finance_guard_slip_feedback();
    drop table public.finance_slip_name_variants;
    drop function if exists public.finance_guard_name_variant();
    alter table public.finance_slip_analysis drop column decision, drop column recipient, drop column rules_version;
  end if;
end $$;
