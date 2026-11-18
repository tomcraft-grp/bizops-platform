-- AI-assisted slip review with end-of-day approval.
-- Design: docs/superpowers/specs/2026-11-19-slip-review-eod-design.md   Plan: docs/superpowers/plans/2026-11-19-slip-review-eod.md
-- Rollback: supabase/rollbacks/20261120100000_slip_review_down.sql (sections there undo these ones in reverse order).
--
-- Ships DARK: ai_review_enabled and post_requires_manager are false, so with this migration alone nothing a customer or a staff member does today
-- behaves differently. Every statement is idempotent (the test runner may send the file again after it is live).
--
-- Sections (each task appends its own): 1 schema, 2 analysis, 3 workflow, 4 reads.

-- ================================================================================================= 1 schema
-- 1a settings: five knobs on the existing one-row table (a manager edits them through finance_save_review_settings, section 3)
alter table public.finance_settings
  add column if not exists ai_review_enabled boolean not null default false,                       -- the AI reads every new slip
  add column if not exists post_requires_manager boolean not null default false,                    -- Post (and so the old one-step verify) needs a manager
  add column if not exists ai_min_confidence numeric(3, 2) not null default 0.80
    constraint finance_settings_ai_min_confidence_chk check (ai_min_confidence between 0 and 1),   -- below this the AI result is "manual review"
  add column if not exists slip_window_before_min integer not null default 120
    constraint finance_settings_slip_window_before_min_chk check (slip_window_before_min between 0 and 1440),         -- a transfer may precede its order by this many minutes
  add column if not exists slip_future_tolerance_min integer not null default 10
    constraint finance_settings_slip_future_tolerance_min_chk check (slip_future_tolerance_min between 0 and 1440);   -- ...and follow the slip's upload by this many

-- 1b evidence: one row = one payment event (a customer's slip, or a payment a staff member recorded at the back office)
alter table public.finance_payment_evidence
  add column if not exists source text not null default 'customer_slip'
    constraint finance_payment_evidence_source_chk check (source in ('customer_slip', 'staff_entry')),
  add column if not exists method text not null default 'transfer'
    constraint finance_payment_evidence_method_chk check (method in ('transfer', 'cash')),
  add column if not exists recorded_by uuid,                                                        -- the staff member who typed a staff_entry in
  add column if not exists confirmed_by uuid,                                                       -- Confirm: the amount, reference and time the BANK shows
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_amount numeric(14, 2)
    constraint finance_payment_evidence_confirmed_amount_chk check (confirmed_amount is null or confirmed_amount > 0),
  add column if not exists confirmed_bank_ref text
    constraint finance_payment_evidence_confirmed_bank_ref_chk check (confirmed_bank_ref is null or length(confirmed_bank_ref) between 4 and 80),
  add column if not exists confirmed_transfer_at timestamptz,
  add column if not exists confirm_note text
    constraint finance_payment_evidence_confirm_note_chk check (confirm_note is null or length(confirm_note) <= 500),
  add column if not exists posted_by uuid,                                                          -- Post: the money is officially received (status verified)
  add column if not exists posted_at timestamptz,
  add column if not exists request_message text
    constraint finance_payment_evidence_request_message_chk check (request_message is null or length(request_message) <= 300),   -- "please send a clearer slip"
  add column if not exists requested_by uuid,
  add column if not exists requested_at timestamptz;

-- a slip written by a customer always has its file; a staff_entry may have none (cash at the counter) but never half of one
alter table public.finance_payment_evidence alter column file_path drop not null, alter column file_sha256 drop not null, alter column file_type drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_evidence_file_required_chk' and conrelid = 'public.finance_payment_evidence'::regclass) then
    alter table public.finance_payment_evidence add constraint finance_evidence_file_required_chk check (
      (file_path is not null and file_sha256 is not null and file_type is not null)
      or (source = 'staff_entry' and file_path is null and file_sha256 is null and file_type is null));
  end if;
end $$;

-- the statuses: submitted -> confirmed -> verified (= posted), plus more_evidence and rejected. The old check has a generated name that we do not
-- assume: every single-column check on "status" is looked up in pg_constraint and dropped before the wider one is added.
do $$ declare c record; begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.finance_payment_evidence'::regclass and con.contype = 'c'
              and con.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = con.conrelid and a.attname = 'status')]
  loop execute format('alter table public.finance_payment_evidence drop constraint %I', c.conname); end loop;
  alter table public.finance_payment_evidence add constraint finance_payment_evidence_status_chk
    check (status in ('submitted', 'confirmed', 'more_evidence', 'verified', 'rejected'));
end $$;

-- one bank transaction can back only one confirmed or posted payment (a rejected one releases its reference)
create unique index if not exists finance_evidence_confirmed_ref_once on public.finance_payment_evidence (confirmed_bank_ref) where status in ('confirmed', 'verified');

-- 1c what the AI read: append-only attempts per slip. A finished attempt (done or failed) never changes; a re-run is a new row, so the history stays.
create table if not exists public.finance_slip_analysis (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.finance_payment_evidence (id) on delete restrict,
  attempt integer not null constraint finance_slip_analysis_attempt_chk check (attempt >= 1),
  status text not null default 'queued' constraint finance_slip_analysis_status_chk check (status in ('queued', 'running', 'done', 'failed')),
  engine text check (engine is null or length(engine) <= 80),
  prompt_version text check (prompt_version is null or length(prompt_version) <= 40),
  extracted jsonb,                                                                                   -- what the reader found on the slip (normalised by the function)
  qr jsonb,                                                                                          -- what the slip's QR code held
  expected jsonb,                                                                                    -- snapshot of what the order expected when the result was decided
  overall_confidence numeric(4, 3) constraint finance_slip_analysis_confidence_chk check (overall_confidence is null or overall_confidence between 0 and 1),
  signals jsonb not null default '[]'::jsonb,                                                        -- tamper / quality signals
  result text constraint finance_slip_analysis_result_chk
    check (result is null or result in ('match', 'amount_mismatch', 'date_mismatch', 'time_anomaly', 'duplicate_suspected', 'suspicious_slip', 'manual_review')),
  reasons jsonb not null default '[]'::jsonb,                                                        -- every rule that applied, not only the first
  error text check (error is null or length(error) <= 500),
  requested_by uuid,                                                                                 -- who asked for it (null = the system, after a submission)
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint finance_slip_analysis_attempt_once unique (evidence_id, attempt),
  constraint finance_slip_analysis_done_chk check (status <> 'done' or result is not null),
  constraint finance_slip_analysis_failed_chk check (status <> 'failed' or error is not null)
);

create or replace function public.finance_guard_slip_analysis()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'A slip analysis is never deleted'; end if;
  if old.status not in ('queued', 'running') then raise exception 'A finished slip analysis is never changed: start a new attempt'; end if;
  if new.evidence_id is distinct from old.evidence_id or new.attempt is distinct from old.attempt then
    raise exception 'The slip and the attempt number of an analysis cannot be changed'; end if;
  return new;
end $$;
drop trigger if exists finance_slip_analysis_guard on public.finance_slip_analysis;
create trigger finance_slip_analysis_guard before update or delete on public.finance_slip_analysis for each row execute function public.finance_guard_slip_analysis();
revoke execute on function public.finance_guard_slip_analysis() from public, anon, authenticated;

-- staff read it; nobody writes it from a client (the service-role functions of section 2 do). Customers never see what the AI found.
alter table public.finance_slip_analysis enable row level security;
drop policy if exists "finance analysis: staff" on public.finance_slip_analysis;
create policy "finance analysis: staff" on public.finance_slip_analysis for select to authenticated using (public.finance_can('view'));
revoke all on public.finance_slip_analysis from anon, authenticated;
grant select on public.finance_slip_analysis to authenticated;

-- 1d ledger queue: a posted cash payment is Dr cash / Cr receivable (the ledger role "cash" is account 1100). Same lookup as the status check above.
do $$ declare c record; begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.finance_gl_queue'::regclass and con.contype = 'c'
              and con.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = con.conrelid and a.attname = 'event_type')]
  loop execute format('alter table public.finance_gl_queue drop constraint %I', c.conname); end loop;
  alter table public.finance_gl_queue add constraint finance_gl_queue_event_type_chk
    check (event_type in ('INVOICE_ISSUE', 'INVOICE_CANCEL', 'BANK_RECEIPT', 'RECEIPT_REAPPLY', 'RECEIPT_REVERSAL', 'WALLET_DEPOSIT', 'WALLET_PAYMENT',
                          'WALLET_REFUND', 'WALLET_ADJUSTMENT', 'WALLET_REVERSAL', 'CASH_RECEIPT'));
end $$;

-- 1e receipts: finance_receipts.method is free text with NO check constraint (text not null default 'promptpay_transfer', checked against pg_constraint on
-- 2026-11-19), so 'cash' needs no schema change; S1 keeps a test that a cash receipt is accepted.

-- ================================================================================================= 2 analysis
-- The queue of slips for the AI reader, the deterministic classifier that labels what the reader found, and the three service-role functions the Edge
-- Function uses (begin / complete / fail). The AI is a reader and a risk flagger: nothing in this section touches a receipt, an invoice, an order or the
-- status of a slip. Customers can neither read an analysis nor call any of these functions.

-- 2a queue: every new slip that has a file gets attempt 1 when the AI review is switched on. A payment recorded by staff without a file has nothing to read.
-- (Dark by default: with the setting off this trigger does nothing, so today's behaviour is unchanged.)
create or replace function public.finance_evidence_queue_analysis()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.file_path is not null and coalesce((select s.ai_review_enabled from public.finance_settings s where s.id), false) then
    insert into public.finance_slip_analysis (evidence_id, attempt, status) values (new.id, 1, 'queued');
  end if;
  return new;
end $$;
drop trigger if exists finance_evidence_queue_analysis on public.finance_payment_evidence;
create trigger finance_evidence_queue_analysis after insert on public.finance_payment_evidence for each row execute function public.finance_evidence_queue_analysis();

-- 2b helpers (internal: not callable from the API)
-- what finance_can answers for an explicit user (the Edge Function verified the caller's JWT and passes the user in): the same ladder as finance_role / finance_can
create or replace function public.finance_can_as(p_user uuid, p_cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(array_position(array['viewer', 'clerk', 'verifier', 'manager'],
      (select case when p.role = 'SUPER_ADMIN' then 'manager' else (select r.role from public.finance_staff_roles r where r.user_id = p.id) end
         from public.profiles p where p.id = p_user and p.status = 'active'))
    >= case p_cap when 'view' then 1 when 'invoice' then 2 when 'verify' then 3 when 'manage' then 4 else 99 end, false)
$$;

-- a bank reference as it is compared: letters and digits only, upper case (the same transfer is printed with dashes or spaces by different banks)
create or replace function public.finance_slip_ref(p text)
returns text language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- a person's name as it is compared: lower case, one leading title stripped, no spaces, dots, dashes or mask characters
create or replace function public.finance_slip_name(p text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(
           regexp_replace(lower(btrim(coalesce(p, ''))), '^(นางสาว|นาง|น\.\s*ส\.?|คุณ|นาย|(mrs|mr|ms|miss)(\.|\s+))\s*', ''),
           '[\s.,''"_*•-]+', '', 'g')
$$;

create or replace function public.finance_slip_reason(p_code text, p_severity text, p_field text, p_expected jsonb, p_found jsonb, p_message text)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object('code', p_code, 'severity', p_severity, 'field', p_field, 'expected', p_expected, 'found', p_found, 'message', p_message)
$$;

-- the accounts a customer may pay into: every active bank account, and the default active payment account (PromptPay: the phone number / id as digits)
create or replace function public.finance_slip_receivers()
returns table (label text, bank text, digits text, account_name text) language sql stable security definer set search_path = public as $$
  select b.code, b.bank_name_en, b.account_no, b.account_name from public.finance_bank_accounts b where b.active
  union all
  select a.label, 'PromptPay'::text,
         case when a.target_type = 'phone' and a.target like '0066%' then '0' || substr(a.target, 5) else nullif(regexp_replace(a.target, '[^0-9]', '', 'g'), '') end,
         a.merchant_name
    from public.finance_payment_accounts a where a.is_default and a.active
$$;

-- 2c the classifier (pure rules, first match wins, every applicable reason is recorded). Result precedence:
--   1 not a slip / unreadable / amount or date missing -> manual_review      2 reference already seen -> duplicate_suspected
--   3 tamper signal, QR reference or checksum, receiver not ours, status not success -> suspicious_slip     4 amount differs -> amount_mismatch
--   5 date outside the window -> date_mismatch; time outside the window or unknown -> time_anomaly           6 low confidence -> manual_review     7 match
-- p_extracted / p_qr / p_signals follow the contract of the Edge Function; the expected values come from the database, never from the reader.
create or replace function public.finance_classify_slip(p_evidence uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_signals jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  e public.finance_payment_evidence; inv public.finance_invoices; s public.finance_settings;
  v_exp numeric; v_order_at timestamptz; v_from timestamptz; v_to timestamptz; v_expected jsonb; v_reasons jsonb := '[]'::jsonb; v_min numeric;
  v_is_slip boolean; v_amount numeric; v_ts text; v_at timestamptz; v_time_known boolean;
  v_ref text; v_qref text; v_refs text[]; v_hit text[]; v_status text; sig jsonb;
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
  if jsonb_typeof(p_extracted -> 'amount') = 'number' then v_amount := (p_extracted ->> 'amount')::numeric; if v_amount <= 0 then v_amount := null; end if; end if;
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
    v_reasons := v_reasons || public.finance_slip_reason('AMOUNT_MISSING', 'warn', 'amount', to_jsonb(v_exp), p_extracted -> 'amount', 'The amount could not be read from the slip.');
  end if;
  if v_at is null then
    f_manual := true;
    v_reasons := v_reasons || public.finance_slip_reason('DATE_MISSING', 'warn', 'transfer_at', null, p_extracted -> 'transfer_at', 'The transfer date could not be read from the slip.');
  end if;

  -- rule 2: the bank reference (printed on the slip and in its QR) was already seen: another finished analysis, a receipt, another slip, a wallet deposit
  v_ref := public.finance_slip_ref(p_extracted ->> 'trans_ref');
  v_qref := public.finance_slip_ref(p_qr ->> 'trans_ref');
  v_refs := array(select distinct q.r from unnest(array[v_ref, v_qref]) as q(r) where length(q.r) >= 4);        -- a shorter one counts as absent
  if coalesce(array_length(v_refs, 1), 0) > 0 then
    select array_agg(q.r) into v_hit from unnest(v_refs) as q(r) where exists (select 1 from public.finance_slip_analysis a where a.status = 'done' and a.evidence_id <> e.id
      and (public.finance_slip_ref(a.extracted ->> 'trans_ref') = q.r or public.finance_slip_ref(a.qr ->> 'trans_ref') = q.r));
    if v_hit is not null then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null, to_jsonb(array_to_string(v_hit, ', ')), 'This bank reference was already read on another slip.');
    end if;
    select array_agg(q.r) into v_hit from unnest(v_refs) as q(r) where exists (select 1 from public.finance_receipts c where c.evidence_id is distinct from e.id and public.finance_slip_ref(c.bank_trans_ref) = q.r);
    if v_hit is not null then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null, to_jsonb(array_to_string(v_hit, ', ')), 'This bank reference is already on a receipt.');
    end if;
    select array_agg(q.r) into v_hit from unnest(v_refs) as q(r) where exists (select 1 from public.finance_payment_evidence x where x.id <> e.id
      and (public.finance_slip_ref(x.bank_trans_ref) = q.r or public.finance_slip_ref(x.confirmed_bank_ref) = q.r));
    if v_hit is not null then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null, to_jsonb(array_to_string(v_hit, ', ')), 'This bank reference is already on another payment slip.');
    end if;
    select array_agg(q.r) into v_hit from unnest(v_refs) as q(r) where exists (select 1 from public.finance_wallet_deposits d where public.finance_slip_ref(d.bank_trans_ref) = q.r);
    if v_hit is not null then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null, to_jsonb(array_to_string(v_hit, ', ')), 'This bank reference is already on a wallet deposit.');
    end if;
  end if;

  -- rule 3: signs of tampering, a QR that disagrees with the slip, a receiver that is not ours, a transfer that did not succeed
  if jsonb_typeof(p_signals) = 'array' then
    for sig in select j.value from jsonb_array_elements(p_signals) as j where j.value ->> 'severity' = 'high' loop
      f_susp := true;
      v_reasons := v_reasons || public.finance_slip_reason('TAMPER_SIGNAL', 'high', 'image', null, to_jsonb(coalesce(sig ->> 'code', 'unknown')),
        coalesce(nullif(btrim(sig ->> 'detail'), ''), 'The reader found a sign that the picture was edited.'));
    end loop;
  end if;
  if jsonb_typeof(p_qr -> 'crc_ok') = 'boolean' and not (p_qr ->> 'crc_ok')::boolean then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('QR_BAD_CRC', 'high', 'qr', to_jsonb(true), to_jsonb(false), 'The checksum of the QR code on the slip is wrong.');
  end if;
  if length(v_ref) >= 4 and length(v_qref) >= 4 and v_ref <> v_qref then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('QR_REF_MISMATCH', 'high', 'trans_ref', to_jsonb(v_ref), to_jsonb(v_qref), 'The reference in the QR code is not the reference printed on the slip.');
  end if;
  -- receiver: the visible account digits (3 or more) are an ordered subsequence of one of our accounts, or the name (titles stripped) is the start of an account name
  v_digits := regexp_replace(coalesce(p_extracted -> 'receiver' ->> 'account_hint', ''), '[^0-9]', '', 'g');
  v_name := public.finance_slip_name(p_extracted -> 'receiver' ->> 'name');
  v_has_digits := length(v_digits) >= 3;
  v_has_name := length(v_name) >= 3;
  if v_has_digits or v_has_name then
    v_ok := false;
    for rcv in select r.digits, r.account_name from public.finance_slip_receivers() r loop
      if v_has_digits and rcv.digits is not null and rcv.digits ~ regexp_replace(v_digits, '(.)', '\1[0-9]*', 'g') then v_ok := true; end if;
      if v_has_name and rcv.account_name is not null and position(v_name in public.finance_slip_name(rcv.account_name)) = 1 then v_ok := true; end if;
      exit when v_ok;
    end loop;
    if not v_ok then
      f_susp := true;
      v_reasons := v_reasons || public.finance_slip_reason('RECEIVER_MISMATCH', 'high', 'receiver', (select jsonb_agg(r.label order by r.label) from public.finance_slip_receivers() r),
        jsonb_build_object('name', p_extracted -> 'receiver' ->> 'name', 'account_hint', p_extracted -> 'receiver' ->> 'account_hint'), 'The slip shows a receiver that is not one of the shop''s accounts.');
    end if;
  else
    v_reasons := v_reasons || public.finance_slip_reason('RECEIVER_UNCLEAR', 'warn', 'receiver', null, null, 'The receiver could not be read well enough to compare with the shop''s accounts.');
  end if;
  v_status := nullif(btrim(p_extracted ->> 'status_text'), '');
  if v_status is not null and v_status ~* 'ไม่สำเร็จ|ล้มเหลว|ไม่ผ่าน|ยกเลิก|fail|unsuccess|reject|cancel|pending' then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('STATUS_NOT_SUCCESS', 'high', 'status_text', null, to_jsonb(v_status), 'The slip does not say that the transfer succeeded.');
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
end $$;

-- 2d the service-role functions of the Edge Function (it verifies the caller's JWT and passes the user in)
-- Claims the waiting attempt of a slip (or one that has been "running" for over 5 minutes: that run died). Named by slip, or by invoice = its newest slip with a file.
create or replace function public.finance_analysis_begin(p_evidence uuid, p_invoice uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; inv public.finance_invoices; a public.finance_slip_analysis; v_last text;
begin
  if p_actor is null or (p_evidence is null and p_invoice is null) then raise exception 'NOT_FOUND: slip not found'; end if;
  if p_evidence is not null then
    select * into e from public.finance_payment_evidence where id = p_evidence and (p_invoice is null or invoice_id = p_invoice);
  else
    select * into e from public.finance_payment_evidence where invoice_id = p_invoice and file_path is not null order by created_at desc, id desc limit 1;
  end if;
  if not found then raise exception 'NOT_FOUND: slip not found'; end if;
  select * into inv from public.finance_invoices where id = e.invoice_id;
  -- the customer the invoice belongs to, or finance staff; anyone else is told "not found", not "forbidden"
  if not (exists (select 1 from public.finance_customers c where c.id = inv.customer_id and c.profile_id = p_actor) or public.finance_can_as(p_actor, 'view')) then
    raise exception 'NOT_FOUND: slip not found'; end if;
  if not coalesce((select s.ai_review_enabled from public.finance_settings s where s.id), false) then raise exception 'AI_DISABLED: the AI review is switched off'; end if;
  if e.file_path is null then raise exception 'NOTHING_TO_DO: this payment has no slip image'; end if;
  select * into a from public.finance_slip_analysis
    where evidence_id = e.id and (status = 'queued' or (status = 'running' and coalesce(started_at, created_at) < now() - interval '5 minutes'))
    order by attempt desc limit 1 for update;
  if not found then
    select status into v_last from public.finance_slip_analysis where evidence_id = e.id order by attempt desc limit 1;
    if v_last = 'done' then raise exception 'ALREADY_DONE: this slip has already been analysed'; end if;
    raise exception 'NOTHING_TO_DO: no analysis is waiting for this slip';            -- being read right now, failed (staff re-run it), or never queued
  end if;
  update public.finance_slip_analysis set status = 'running', started_at = now() where id = a.id;
  return jsonb_build_object('analysis_id', a.id, 'evidence_id', e.id, 'file_path', e.file_path, 'file_type', e.file_type);
end $$;

-- Stores what the reader found, lets the classifier decide, and finishes the attempt. Nothing else changes: the AI never moves money or a status.
create or replace function public.finance_analysis_complete(p_analysis uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_signals jsonb, p_engine text, p_prompt_version text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.finance_slip_analysis; v jsonb; v_conf numeric := round(p_confidence, 3);
begin
  select * into a from public.finance_slip_analysis where id = p_analysis for update;
  if not found then raise exception 'NOT_FOUND: analysis not found'; end if;
  if a.status in ('done', 'failed') then raise exception 'ALREADY_DONE: this analysis is already finished'; end if;
  if v_conf is not null and v_conf not between 0 and 1 then raise exception 'INVALID_CONFIDENCE: the confidence must be between 0 and 1'; end if;
  v := public.finance_classify_slip(a.evidence_id, p_extracted, p_qr, v_conf, coalesce(p_signals, '[]'::jsonb));
  update public.finance_slip_analysis set status = 'done', engine = nullif(btrim(p_engine), ''), prompt_version = nullif(btrim(p_prompt_version), ''),
    extracted = p_extracted, qr = p_qr, expected = v -> 'expected', overall_confidence = v_conf, signals = coalesce(p_signals, '[]'::jsonb),
    result = v ->> 'result', reasons = v -> 'reasons', error = null, finished_at = now() where id = a.id;
  perform public.finance_log('evidence', a.evidence_id, 'evidence.analysis', jsonb_build_object('result', v ->> 'result', 'confidence', v_conf));
  return jsonb_build_object('result', v ->> 'result', 'reasons', v -> 'reasons');
end $$;

-- The reader could not do its job (no key, an outage, an unusable reply): the attempt is failed and the slip shows as manual review. Nobody is blocked.
create or replace function public.finance_analysis_fail(p_analysis uuid, p_error text, p_engine text)
returns void language plpgsql security definer set search_path = public as $$
declare a public.finance_slip_analysis; v_err text := left(coalesce(nullif(btrim(p_error), ''), 'unknown error'), 500);
begin
  select * into a from public.finance_slip_analysis where id = p_analysis for update;
  if not found then raise exception 'NOT_FOUND: analysis not found'; end if;
  if a.status in ('done', 'failed') then raise exception 'ALREADY_DONE: this analysis is already finished'; end if;
  update public.finance_slip_analysis set status = 'failed', result = 'manual_review', error = v_err, engine = nullif(btrim(p_engine), ''), finished_at = now(),
    reasons = jsonb_build_array(public.finance_slip_reason('AI_UNAVAILABLE', 'warn', 'analysis', null, null, 'The AI reader did not produce a result: ' || left(v_err, 200)))
    where id = a.id;
end $$;

-- 2e a staff re-run: a NEW attempt (the old ones stay), at most 5 per slip, only while the AI review is on
create or replace function public.finance_request_analysis(p_evidence uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; a public.finance_slip_analysis; v_n integer; v_id uuid;
begin
  perform public.finance_require('verify', 'ask for a new slip analysis');
  if not coalesce((select s.ai_review_enabled from public.finance_settings s where s.id), false) then raise exception 'AI_DISABLED: the AI review is switched off'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;           -- serialises the attempt numbers of one slip
  if not found then raise exception 'NOT_FOUND: slip not found'; end if;
  if e.file_path is null then raise exception 'NOTHING_TO_DO: this payment has no slip image'; end if;
  select * into a from public.finance_slip_analysis where evidence_id = e.id order by attempt desc limit 1;
  if found and a.status in ('queued', 'running') then raise exception 'ALREADY_QUEUED: an analysis of this slip is already waiting or running'; end if;
  select count(*) into v_n from public.finance_slip_analysis where evidence_id = e.id;
  if v_n >= 5 then raise exception 'TOO_MANY_ATTEMPTS: this slip has already been analysed % times', v_n; end if;
  insert into public.finance_slip_analysis (evidence_id, attempt, status, requested_by) values (e.id, coalesce(a.attempt, 0) + 1, 'queued', auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- 2f who may call what. The classifier and its helpers are internal (the API cannot call them, not even with the service key); begin / complete / fail are
-- for the service role only; the re-run is for signed-in staff (it checks the role itself).
revoke execute on function public.finance_evidence_queue_analysis() from public, anon, authenticated;
revoke execute on function public.finance_can_as(uuid, text), public.finance_slip_ref(text), public.finance_slip_name(text),
  public.finance_slip_reason(text, text, text, jsonb, jsonb, text), public.finance_slip_receivers(),
  public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb) from public, anon, authenticated;
revoke execute on function public.finance_analysis_begin(uuid, uuid, uuid), public.finance_analysis_complete(uuid, jsonb, jsonb, numeric, jsonb, text, text),
  public.finance_analysis_fail(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.finance_request_analysis(uuid) from public, anon;
grant execute on function public.finance_request_analysis(uuid) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public.finance_evidence_queue_analysis(), public.finance_can_as(uuid, text), public.finance_slip_ref(text), public.finance_slip_name(text),
      public.finance_slip_reason(text, text, text, jsonb, jsonb, text), public.finance_slip_receivers(), public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb) from service_role;
    grant execute on function public.finance_analysis_begin(uuid, uuid, uuid) to service_role;
    grant execute on function public.finance_analysis_complete(uuid, jsonb, jsonb, numeric, jsonb, text, text) to service_role;
    grant execute on function public.finance_analysis_fail(uuid, text, text) to service_role;
  end if;
end $$;
