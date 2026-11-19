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
-- assume: the single-column checks on "status" that list the statuses (they mention 'submitted') are looked up in pg_constraint and dropped before the wider
-- one is added. (An unrelated check on the same column is left alone, so sending this file again can never drop something it did not create.)
do $$ declare c record; begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.finance_payment_evidence'::regclass and con.contype = 'c'
              and con.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = con.conrelid and a.attname = 'status')]
              and pg_get_constraintdef(con.oid) ilike '%submitted%'
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

-- 1d ledger queue: a posted cash payment is Dr cash / Cr receivable (the ledger role "cash" is account 1100). Same lookup as the status check above (only the
-- single-column check that lists the event types, which mentions 'BANK_RECEIPT').
do $$ declare c record; begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.finance_gl_queue'::regclass and con.contype = 'c'
              and con.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = con.conrelid and a.attname = 'event_type')]
              and pg_get_constraintdef(con.oid) ilike '%BANK_RECEIPT%'
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
--   1 not a slip / unreadable / amount or date missing -> manual_review      2 reference already seen -> duplicate_suspected (a transfer the customer resent
--     after a rejection / request for more evidence is only an info reason, see rule 2 below)
--   3 tamper signal, QR reference or checksum, receiver not ours, status not success -> suspicious_slip     4 amount differs -> amount_mismatch
--   5 date outside the window -> date_mismatch; time outside the window or unknown -> time_anomaly           6 low confidence -> manual_review     7 match
-- p_extracted / p_qr / p_signals follow the contract of the Edge Function; the expected values come from the database, never from the reader.
create or replace function public.finance_classify_slip(p_evidence uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_signals jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
  if not (exists (select 1 from public.finance_customers c join public.profiles pr on pr.id = c.profile_id
                   where c.id = inv.customer_id and c.profile_id = p_actor and pr.status = 'active') or public.finance_can_as(p_actor, 'view')) then
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
  v := public.finance_classify_slip(a.evidence_id, p_extracted, p_qr, p_confidence, coalesce(p_signals, '[]'::jsonb));   -- judged as reported; only the stored copy is rounded
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

-- 2g indexes for the duplicate scan of the classifier: every source is looked up by the normalised reference (the immutable function finance_slip_ref), so each
-- gets an expression index on exactly that expression (only rows that have a reference / a finished analysis). Plain CREATE INDEX: a brief lock on small tables.
create index if not exists finance_receipts_slipref_idx on public.finance_receipts (public.finance_slip_ref(bank_trans_ref)) where bank_trans_ref is not null;
create index if not exists finance_evidence_slipref_idx on public.finance_payment_evidence (public.finance_slip_ref(bank_trans_ref)) where bank_trans_ref is not null;
create index if not exists finance_evidence_confslipref_idx on public.finance_payment_evidence (public.finance_slip_ref(confirmed_bank_ref)) where confirmed_bank_ref is not null;
create index if not exists finance_deposits_slipref_idx on public.finance_wallet_deposits (public.finance_slip_ref(bank_trans_ref)) where bank_trans_ref is not null;
create index if not exists finance_analysis_slipref_idx on public.finance_slip_analysis (public.finance_slip_ref(extracted ->> 'trans_ref')) where status = 'done';
create index if not exists finance_analysis_qrslipref_idx on public.finance_slip_analysis (public.finance_slip_ref(qr ->> 'trans_ref')) where status = 'done';

-- ================================================================================================= 3 workflow
-- Confirm -> Post makes money officially received in two steps by two people (or the same person when post_requires_manager is off); Reject and Request more
-- evidence send a slip back to the customer; Record payment lets staff enter a transfer or a cash payment at the back office. All the money arithmetic stays in ONE
-- place, finance_verify_core: it is the body of the one-step finance_verify_evidence that is live today, moved here with the same checks, receipt, allocation, wallet
-- credit of any excess and ledger row for a bank transfer, and the old function is now a thin wrapper around it (same signature, same answer). With the settings off
-- nothing a customer or a staff member does today behaves differently.
-- (the bodies below start from the definitions that are LIVE, i.e. the migrations of 2026-11-15 with the numbering swap of 20261115500000 applied: receipt numbers
-- come from next_doc_no('PAYMENT'), not from the old sequence)

-- 3a where is this bank reference already used? (internal; used by Confirm and Record payment). Compared as letters and digits only, so the same transfer typed with
-- dashes, spaces or in lower case is found; sources are receipts, verified wallet deposits, and other confirmed / posted slips. Returns the kind of the first hit.
create or replace function public.finance_ref_in_use(p_ref text, p_except uuid default null)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select 'receipt' from public.finance_receipts c
      where c.bank_trans_ref is not null and public.finance_slip_ref(c.bank_trans_ref) = public.finance_slip_ref(p_ref) limit 1),
    (select 'deposit' from public.finance_wallet_deposits d
      where d.bank_trans_ref is not null and d.status = 'verified' and public.finance_slip_ref(d.bank_trans_ref) = public.finance_slip_ref(p_ref) limit 1),
    (select 'evidence' from public.finance_payment_evidence x
      where x.status in ('confirmed', 'verified') and x.id is distinct from p_except
        and ((x.confirmed_bank_ref is not null and public.finance_slip_ref(x.confirmed_bank_ref) = public.finance_slip_ref(p_ref))
          or (x.bank_trans_ref is not null and public.finance_slip_ref(x.bank_trans_ref) = public.finance_slip_ref(p_ref))) limit 1))
$$;

-- 3b the core: settles a slip. No role check (the callers check it); not callable from the API.
--   p_from_status  'submitted' (the one-step verify: the values come from the caller) or 'confirmed' (Post: the values were confirmed earlier and are read back)
--   p_method       'transfer' (as before) or 'cash': no reference or duplicate check, no bank account, receipt method 'cash', never a wallet credit (more cash than the
--                  invoice owes is refused, CASH_OVERPAY), ledger row CASH_RECEIPT Dr cash / Cr receivable
-- A post (from 'confirmed') also stamps who posted it and when.
create or replace function public.finance_verify_core(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz,
  p_note text, p_via text, p_from_status text default 'submitted', p_method text default 'transfer')
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; st jsonb; outstanding numeric; rc public.finance_receipts; result text; v_alloc numeric := 0;
        v_rid uuid := gen_random_uuid(); v_rno text; v_excess numeric := 0; v_t public.finance_wallet_transactions;
        v_cash boolean := p_method = 'cash'; v_ref text := case when p_method = 'cash' then null else trim(p_bank_trans_ref) end;
begin
  if p_via not in ('staff', 'provider', 'bank') then raise exception 'Unknown verification source'; end if;
  if coalesce(p_from_status, '') not in ('submitted', 'confirmed') then raise exception 'Unknown starting status'; end if;
  if coalesce(p_method, '') not in ('transfer', 'cash') then raise exception 'Unknown payment method'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if not v_cash and coalesce(trim(p_bank_trans_ref), '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> p_from_status then raise exception 'This slip is already %', e.status; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;   -- serialises settlement of one invoice
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  if not v_cash and (exists (select 1 from public.finance_receipts where bank_trans_ref = trim(p_bank_trans_ref)) or exists (select 1 from public.finance_wallet_deposits where bank_trans_ref = trim(p_bank_trans_ref) and status = 'verified')) then
    raise exception 'Bank transaction % was already recorded (reused slip?)', trim(p_bank_trans_ref) using errcode = '23505'; end if;
  if p_transfer_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The transfer is older than the invoice'; end if;

  st := public.finance_invoice_state_raw(i.id);
  outstanding := (st ->> 'outstanding')::numeric;
  if v_cash and p_amount > outstanding then
    raise exception 'CASH_OVERPAY: cash of % is more than the % this invoice still owes; cash never makes a wallet credit', p_amount, outstanding; end if;
  v_alloc := least(p_amount, outstanding);
  v_excess := p_amount - v_alloc;
  v_rno := public.next_doc_no('PAYMENT');
  update public.finance_payment_evidence set status = 'verified', verified_via = p_via, verified_amount = p_amount, bank_trans_ref = v_ref,
    transfer_at = p_transfer_at, review_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now(),
    posted_by = case when p_from_status = 'confirmed' then auth.uid() else posted_by end,
    posted_at = case when p_from_status = 'confirmed' then now() else posted_at end where id = e.id;
  -- the part above what the invoice owes is the customer's money: it goes to their wallet (one ledger row, same transaction)
  if v_excess > 0 then
    v_t := public.finance_wallet_apply(i.customer_id, 'DEPOSIT', 'credit', v_excess, 'OVR:' || v_rid::text, 'receipt', v_rid, v_rno, 'bank_transfer', e.bank_account_id, 'verified',
                                       auth.uid(), auth.uid(), 'Paid above invoice ' || i.invoice_no || ' (receipt ' || v_rno || ')',
                                       'โอนเกินยอดใบแจ้งหนี้ เข้ากระเป๋าเงิน / Paid above the invoice, credited to your wallet');
  end if;
  insert into public.finance_receipts (id, receipt_no, customer_id, invoice_id, evidence_id, amount, bank_trans_ref, received_at, needs_review, method, bank_account_id, credit_txn_id)
    values (v_rid, v_rno, i.customer_id, i.id, e.id, p_amount, v_ref, p_transfer_at, false, case when v_cash then 'cash' else 'bank_transfer' end,
            case when v_cash then null else e.bank_account_id end, v_t.id)
    returning * into rc;
  if v_alloc > 0 then
    insert into public.finance_allocations (receipt_id, invoice_id, amount) values (rc.id, i.id, v_alloc);
  end if;
  result := case when v_excess > 0 then 'overpaid_credited' when p_amount = outstanding then 'fully_paid' else 'partially_paid' end;
  if v_cash then
    -- ledger: money in the cash box; it settles the receivable (there is never an overpayment)
    perform public.finance_gl_enqueue('CASH_RECEIPT', 'receipt', rc.id, rc.receipt_no, i.customer_id, p_amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'cash', 'amount', p_amount), jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', v_alloc)),
      public.finance_gl_issue_dep(i.id));
  else
    -- ledger: money in the bank; the applied part settles the receivable, any overpayment is customer credit (wallet liability)
    perform public.finance_gl_enqueue('BANK_RECEIPT', 'receipt', rc.id, rc.receipt_no, i.customer_id, p_amount,
      jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', e.bank_account_id))
        || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
        || case when v_excess > 0 then jsonb_build_array(jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', v_excess, 'wallet', true)) else '[]'::jsonb end,
      public.finance_gl_issue_dep(i.id));
  end if;
  perform public.finance_log('evidence', e.id, 'evidence.verify', jsonb_build_object('via', p_via, 'amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', v_ref, 'bank_account', e.bank_account_id)
    || case when v_cash then jsonb_build_object('method', 'cash') else '{}'::jsonb end);
  perform public.finance_log('receipt', rc.id, 'receipt.post', jsonb_build_object('invoice', i.id, 'amount', p_amount, 'outstanding_before', outstanding, 'result', result, 'credited_to_wallet', v_excess));
  return jsonb_build_object('result', result, 'receipt_no', rc.receipt_no, 'credited_to_wallet', v_excess, 'state', public.finance_invoice_state_raw(i.id));
end $$;

-- 3c the one-step verify: the same signature and the same answer as before; the role check is the only thing that stays here (a verifier, or a manager when
-- post_requires_manager is on: the one-step verify posts money, so it is subject to the same rule as Post)
create or replace function public.finance_verify_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz,
  p_note text default null, p_via text default 'staff')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.finance_require(case when coalesce((select s.post_requires_manager from public.finance_settings s where s.id), false) then 'manage' else 'verify' end, 'verify payments');
  return public.finance_verify_core(p_evidence, p_amount, p_bank_trans_ref, p_transfer_at, p_note, p_via, 'submitted', 'transfer');
end $$;

-- 3d Confirm: a verifier records what the BANK shows (amount, reference, time) against a submitted slip. It touches no receipt, no allocation and no ledger row:
-- the invoice still owes the money until somebody posts it. The reference must be new.
create or replace function public.finance_confirm_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; v_ref text := trim(p_bank_trans_ref); v_note text := nullif(trim(p_note), '');
begin
  perform public.finance_require('verify', 'confirm payments');
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if coalesce(v_ref, '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if length(public.finance_slip_ref(v_ref)) < 4 or length(v_ref) > 80 then raise exception 'The bank transaction reference must have 4 to 80 letters or digits'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  if length(v_note) > 500 then raise exception 'The note is too long (500 characters at most)'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status <> 'submitted' then raise exception 'This slip is already %', e.status; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;   -- serialises with every other payment on the invoice
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  if public.finance_ref_in_use(v_ref, e.id) is not null then
    raise exception 'Bank transaction % was already recorded (reused slip?)', v_ref using errcode = '23505'; end if;
  if p_transfer_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The transfer is older than the invoice'; end if;
  update public.finance_payment_evidence set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), confirmed_amount = p_amount, confirmed_bank_ref = v_ref,
    confirmed_transfer_at = p_transfer_at, confirm_note = v_note where id = e.id;
  perform public.finance_log('evidence', e.id, 'evidence.confirm', jsonb_build_object('amount', p_amount, 'claimed', e.claimed_amount, 'trans_ref', v_ref, 'bank_account', e.bank_account_id));
  return jsonb_build_object('status', 'confirmed', 'evidence_id', e.id, 'amount', p_amount);
end $$;

-- 3e Post: the confirmed payment becomes official: one receipt, its allocation and its ledger row, through the core, once. Pressing Post twice (or two people at the
-- same time: the second waits for the lock) answers replay = true and creates nothing. Anything that is not confirmed is refused (NOT_CONFIRMED).
create or replace function public.finance_post_evidence(p_evidence uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; rc public.finance_receipts; v jsonb;
begin
  perform public.finance_require(case when coalesce((select s.post_requires_manager from public.finance_settings s where s.id), false) then 'manage' else 'verify' end, 'post payments');
  select * into e from public.finance_payment_evidence where id = p_evidence for update;     -- the evidence first, then the invoice (the order the core uses)
  if not found then raise exception 'Evidence not found'; end if;
  select * into i from public.finance_invoices where id = e.invoice_id for update;
  if e.status = 'verified' then
    select * into rc from public.finance_receipts where evidence_id = e.id;
    if found then
      return jsonb_build_object('replay', true,
        'result', coalesce((select ev.detail ->> 'result' from public.finance_events ev where ev.entity = 'receipt' and ev.entity_id = rc.id and ev.action = 'receipt.post' order by ev.id limit 1), 'already_posted'),
        'receipt_no', rc.receipt_no, 'credited_to_wallet', coalesce((select t.amount from public.finance_wallet_transactions t where t.id = rc.credit_txn_id), 0),
        'state', public.finance_invoice_state_raw(e.invoice_id));
    end if;
  end if;
  if e.status <> 'confirmed' then raise exception 'NOT_CONFIRMED: this slip is % (it must be confirmed before it is posted)', e.status; end if;
  -- Confirm checked that the reference was new, but hours can pass before Post (end-of-day approval): the one-step verify may have recorded the same transfer on
  -- another slip meanwhile, typed differently (the core only compares exactly). Look again, in the normalised form, before any money is recorded.
  if e.method = 'transfer' and e.confirmed_bank_ref is not null and public.finance_ref_in_use(e.confirmed_bank_ref, e.id) is not null then
    raise exception 'Bank transaction % was already recorded (reused slip?)', e.confirmed_bank_ref using errcode = '23505'; end if;
  v := public.finance_verify_core(e.id, e.confirmed_amount, case when e.method = 'cash' then null else e.confirmed_bank_ref end, e.confirmed_transfer_at, p_note, 'staff', 'confirmed', e.method);
  perform public.finance_log('evidence', e.id, 'evidence.post', jsonb_build_object('receipt_no', v ->> 'receipt_no', 'amount', e.confirmed_amount, 'note', nullif(trim(p_note), '')));
  return v || jsonb_build_object('replay', false);
end $$;

-- 3f Reject: a slip that is submitted, confirmed or waiting for more evidence (it used to be: submitted only). A rejected slip frees its bank reference.
create or replace function public.finance_reject_evidence(p_evidence uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence;
begin
  perform public.finance_require('verify', 'reject payments');
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status not in ('submitted', 'confirmed', 'more_evidence') then raise exception 'This slip is already %', e.status; end if;
  update public.finance_payment_evidence set status = 'rejected', reject_reason = trim(p_reason), reviewed_by = auth.uid(), reviewed_at = now() where id = p_evidence;
  perform public.finance_log('evidence', p_evidence, 'evidence.reject', jsonb_build_object('reason', trim(p_reason)));
end $$;

-- 3g Request more evidence: the customer sees the message and sends a new slip on the same invoice. Only for a slip a customer sent.
create or replace function public.finance_request_more_evidence(p_evidence uuid, p_message text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; v_msg text := btrim(coalesce(p_message, ''));
begin
  perform public.finance_require('verify', 'ask for more evidence');
  if length(v_msg) not between 3 and 300 then raise exception 'MESSAGE_REQUIRED: tell the customer what is needed (3 to 300 characters)'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;
  if not found then raise exception 'Evidence not found'; end if;
  if e.status not in ('submitted', 'confirmed') then raise exception 'This slip is already %', e.status; end if;
  if e.source = 'staff_entry' then raise exception 'NO_CUSTOMER_SLIP: a payment recorded by staff has no customer slip to ask for'; end if;
  update public.finance_payment_evidence set status = 'more_evidence', request_message = v_msg, requested_by = auth.uid(), requested_at = now() where id = e.id;
  perform public.finance_log('evidence', e.id, 'evidence.request_more', jsonb_build_object('message', v_msg, 'was', e.status));
end $$;

-- 3h Record payment: staff enter a payment at the back office (a bank transfer or cash) against an invoice. It is created already confirmed (by the person who
-- typed it) and still has to be posted. It can never be more than the invoice still owes, counting what is confirmed but not posted yet.
-- Cash needs a note (where it was received) and has no reference, bank or file; a transfer needs a bank reference that is new, may name the bank, and may carry
-- the slip file (the rules of a customer's upload: own folder, no "..", a new file hash; the AI reader is queued for it when the review is on).
create or replace function public.finance_record_payment(p_invoice uuid, p_method text, p_amount numeric, p_received_at timestamptz, p_bank_trans_ref text, p_bank_account uuid, p_note text,
  p_file_path text default null, p_sha256 text default null, p_file_type text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.finance_invoices; st jsonb; v_ref text := nullif(trim(p_bank_trans_ref), ''); v_note text := nullif(trim(p_note), ''); v_limit numeric; v_id uuid;
        v_cash boolean := p_method = 'cash'; v_bank uuid := p_bank_account;
begin
  perform public.finance_require('verify', 'record payments');
  if p_method is null or p_method not in ('transfer', 'cash') then raise exception 'INVALID_METHOD: choose transfer or cash'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'INVALID_AMOUNT: enter the amount in baht and satang'; end if;
  if p_received_at is null then raise exception 'The payment date and time are required'; end if;
  if p_received_at > now() + interval '10 minutes' then raise exception 'The payment time is in the future'; end if;
  if length(v_note) > 500 then raise exception 'The note is too long (500 characters at most)'; end if;
  if v_cash then
    if v_note is null or length(v_note) < 3 then raise exception 'NOTE_REQUIRED: say where the cash was received (at least 3 characters)'; end if;
    if p_file_path is not null or p_sha256 is not null or p_file_type is not null then raise exception 'FILE_NOT_ALLOWED: a cash payment has no slip file'; end if;
    v_ref := null; v_bank := null;                      -- cash has no bank reference and no bank account
  else
    if v_ref is null or length(public.finance_slip_ref(v_ref)) < 4 or length(v_ref) > 80 then
      raise exception 'REFERENCE_REQUIRED: enter the bank transaction reference (4 to 80 letters or digits)'; end if;
    if v_bank is not null and not exists (select 1 from public.finance_bank_accounts where id = v_bank and active) then raise exception 'BANK_NOT_AVAILABLE'; end if;
    if p_file_path is not null or p_sha256 is not null or p_file_type is not null then
      if p_file_path is null or p_sha256 is null or p_file_type is null or split_part(p_file_path, '/', 1) <> auth.uid()::text or p_file_path ~ '\.\.'
         or p_file_type not in ('image/jpeg', 'image/png', 'application/pdf') or p_sha256 !~ '^[0-9a-fA-F]{64}$' then raise exception 'Invalid file' using errcode = '22023'; end if;
    end if;
  end if;
  select * into i from public.finance_invoices where id = p_invoice for update;      -- serialises with every other payment on the invoice
  if not found then raise exception 'Invoice not found'; end if;
  if i.status <> 'open' then raise exception 'The invoice is %', i.status; end if;
  if p_received_at < i.issue_date::timestamptz - interval '1 day' then raise exception 'The payment is older than the invoice'; end if;
  st := public.finance_invoice_state_raw(i.id);
  v_limit := (st ->> 'outstanding')::numeric - (st ->> 'confirmed_pending')::numeric;   -- what the invoice owes, less what is confirmed and waits to be posted
  if p_amount > v_limit then
    raise exception 'EXCEEDS_OUTSTANDING: % is more than the % that can still be added to this invoice', p_amount, greatest(v_limit, 0); end if;
  if not v_cash then
    if public.finance_ref_in_use(v_ref, null) is not null then raise exception 'Bank transaction % was already recorded (reused slip?)', v_ref using errcode = '23505'; end if;
    if p_file_path is not null and (exists (select 1 from public.finance_payment_evidence where file_sha256 = lower(p_sha256) and status <> 'rejected')
         or exists (select 1 from public.finance_wallet_deposits where file_sha256 = lower(p_sha256) and status not in ('rejected', 'cancelled'))) then
      raise exception 'This slip was already submitted' using errcode = '23505'; end if;
  end if;
  insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, claimed_transfer_at, claimed_ref, bank_account_id,
      status, source, method, recorded_by, confirmed_by, confirmed_at, confirmed_amount, confirmed_bank_ref, confirmed_transfer_at, confirm_note)
    values (i.id, i.customer_id, p_file_path, lower(p_sha256), p_file_type, p_amount, p_received_at, v_ref, v_bank,
      'confirmed', 'staff_entry', p_method, auth.uid(), auth.uid(), now(), p_amount, v_ref, p_received_at, v_note)
    returning id into v_id;
  perform public.finance_log('evidence', v_id, 'evidence.record', jsonb_build_object('invoice', i.id, 'method', p_method, 'amount', p_amount, 'trans_ref', v_ref, 'bank_account', v_bank,
    'file', p_file_path is not null, 'note', v_note));
  return jsonb_build_object('evidence_id', v_id, 'status', 'confirmed');
end $$;

-- 3i the state of an invoice: every key and every computation as before; added: confirmed_pending (the sum of what is confirmed and not yet posted), more_evidence_message
-- (what staff asked the customer for), code 10 = more evidence requested. Pending now counts slips that are submitted OR confirmed (a confirmed payment is not money
-- yet); code 10 comes after "pending" (a newer slip that waits wins) and before "partly paid".
create or replace function public.finance_invoice_state_raw(p_invoice uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare inv public.finance_invoices; paid numeric; outstanding numeric; review boolean; pending integer; req public.finance_payment_requests;
        last_ev public.finance_payment_evidence; code integer; credit numeric; refunded numeric; v_confirmed numeric;
begin
  select * into inv from public.finance_invoices where id = p_invoice;
  if not found then return null; end if;
  select coalesce(sum(a.amount), 0) into paid from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id
    where a.invoice_id = p_invoice and a.active and r.status = 'posted';
  outstanding := inv.amount - paid;
  select exists (select 1 from public.finance_receipts where invoice_id = p_invoice and status = 'posted' and needs_review) into review;
  select coalesce(sum(r.amount - coalesce((select sum(a.amount) from public.finance_allocations a where a.receipt_id = r.id and a.active), 0)), 0) into credit
    from public.finance_receipts r where r.invoice_id = p_invoice and r.status = 'posted';
  -- money given back to the customer's wallet: refunds of reversed bank receipts + wallet payments that were reversed
  select coalesce((select sum(t.amount) from public.finance_wallet_transactions t join public.finance_receipts r on r.id = t.ref_id
                    where t.txn_type = 'REFUND' and t.ref_type = 'receipt' and r.invoice_id = p_invoice), 0)
       + coalesce((select sum(r.amount) from public.finance_receipts r where r.invoice_id = p_invoice and r.status = 'reversed' and r.wallet_txn_id is not null), 0)
    into refunded;
  select count(*) into pending from public.finance_payment_evidence where invoice_id = p_invoice and status in ('submitted', 'confirmed');
  select coalesce(sum(confirmed_amount), 0) into v_confirmed from public.finance_payment_evidence where invoice_id = p_invoice and status = 'confirmed';
  select * into req from public.finance_payment_requests where invoice_id = p_invoice and status = 'awaiting' order by created_at desc limit 1;
  select * into last_ev from public.finance_payment_evidence where invoice_id = p_invoice order by created_at desc limit 1;
  code := case
    when inv.status = 'cancelled' then 8
    when review then 6
    when outstanding <= 0 then 5
    when pending > 0 then 3
    when last_ev.id is not null and last_ev.status = 'more_evidence' then 10
    when paid > 0 then 4
    when last_ev.id is not null and last_ev.status = 'rejected' and (req.id is null or req.created_at < last_ev.reviewed_at) then 7
    when req.id is not null and req.expires_at > now() then 1
    when req.id is not null then 9
    else 0 end;
  return jsonb_build_object('invoice_id', inv.id, 'amount', inv.amount, 'paid', paid, 'outstanding', greatest(outstanding, 0),
    'unapplied', credit, 'refunded', refunded, 'status_code', code,
    'status', (array['unpaid', 'awaiting_payment', 'payment_submitted', 'pending_verification', 'partially_paid', 'fully_paid', 'overpaid', 'rejected', 'cancelled', 'expired', 'more_evidence'])[code + 1],
    'pending_evidence', pending,
    'confirmed_pending', v_confirmed,
    'more_evidence_message', case when code = 10 then last_ev.request_message end,
    'request', case when req.id is null then null else jsonb_build_object('ref', req.ref, 'amount', req.amount, 'qr_payload', req.qr_payload, 'expires_at', req.expires_at, 'expired', req.expires_at <= now()) end);
end $$;

-- 3j a customer (or staff) cannot cancel an order while a slip of it is submitted, confirmed or waiting for more evidence
create or replace function public.shop_cancel_order_internal(p_order uuid, p_reason text, p_by_customer boolean)
returns void language plpgsql security definer set search_path = public as $$
declare o public.shop_orders;
begin
  select * into o from public.shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('cancelled', 'completed', 'returned') then raise exception 'This order is already %', o.status; end if;
  if p_by_customer and o.status <> 'new' then raise exception 'ORDER_IN_PROGRESS'; end if;
  perform 1 from public.finance_invoices where id = o.invoice_id for update;          -- serialises with payment verification
  if exists (select 1 from public.finance_receipts where invoice_id = o.invoice_id and status = 'posted') then
    raise exception 'PAYMENT_RECORDED'; end if;
  if exists (select 1 from public.finance_payment_evidence where invoice_id = o.invoice_id and status in ('submitted', 'confirmed', 'more_evidence')) then
    raise exception 'SLIP_PENDING'; end if;
  update public.finance_invoices set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = 'Order cancelled: ' || left(p_reason, 200)
    where id = o.invoice_id and status = 'open';
  update public.finance_payment_requests set status = 'cancelled' where invoice_id = o.invoice_id and status = 'awaiting';
  update public.shop_orders set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(p_reason, 200), updated_at = now() where id = o.id;
  perform public.finance_log('invoice', o.invoice_id, 'invoice.cancel', jsonb_build_object('reason', left(p_reason, 200), 'order', o.order_no, 'source', 'shop'));
  perform public.shop_log('order', o.id::text, 'order.cancel', jsonb_build_object('by', case when p_by_customer then 'customer' else 'staff' end, 'reason', left(p_reason, 200)));
end $$;

-- 3k reversing a receipt: a cash receipt is reversed against CASH (it never went through a bank); every other receipt is reversed exactly as before
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
    if rc.credit_txn_id is not null then
      select * into v_orig from public.finance_wallet_transactions where id = rc.credit_txn_id;
      begin
        v_t := public.finance_wallet_apply(rc.customer_id, 'REVERSAL', 'debit', v_orig.amount, 'REV:' || v_orig.id::text, 'wallet_txn', v_orig.id, v_orig.txn_no, 'wallet', null, 'not_required',
                                           auth.uid(), auth.uid(), 'Receipt ' || rc.receipt_no || ' reversed: ' || trim(p_reason), 'ยกเลิกยอดเกินที่เข้ากระเป๋า / Overpayment credit reversed', v_orig.id);
      exception when sqlstate '23514' then
        raise exception 'CREDIT_ALREADY_USED: the customer already spent the wallet credit made from this receipt (%): correct the wallet first', v_orig.amount using errcode = '23514';
      end;
    end if;
    perform public.finance_gl_enqueue('RECEIPT_REVERSAL', 'receipt', rc.id, rc.receipt_no, rc.customer_id, rc.amount,
      jsonb_build_array(jsonb_build_object('side', 'cr', 'role', case when rc.method = 'cash' then 'cash' else 'bank' end, 'amount', rc.amount)
                          || case when rc.method = 'cash' then '{}'::jsonb else jsonb_build_object('bank_account_id', rc.bank_account_id) end)
        || case when v_alloc > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'ar', 'amount', v_alloc)) else '[]'::jsonb end
        || case when v_unapplied > 0 then jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'customer_credit', 'amount', v_unapplied) || case when rc.credit_txn_id is not null then jsonb_build_object('wallet', true) else '{}'::jsonb end) else '[]'::jsonb end);
  end if;
  perform public.finance_log('receipt', rc.id, 'receipt.reverse', jsonb_build_object('reason', trim(p_reason), 'amount', rc.amount));
  return public.finance_invoice_state_raw(rc.invoice_id);
end $$;

-- 3l the five settings of the review, saved by a manager: only these keys, each checked for its type and range, all or nothing, one audit row
create or replace function public.finance_save_review_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; n numeric; s public.finance_settings;
begin
  perform public.finance_require('manage', 'change the slip review settings');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then raise exception 'Nothing to save'; end if;
  for k, v in select j.key, j.value from jsonb_each(p_patch) j loop
    n := case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric end;
    if k not in ('ai_review_enabled', 'post_requires_manager', 'ai_min_confidence', 'slip_window_before_min', 'slip_future_tolerance_min') then
      raise exception 'UNKNOWN_SETTING: % cannot be changed here', k; end if;
    if k in ('ai_review_enabled', 'post_requires_manager') and jsonb_typeof(v) <> 'boolean' then raise exception 'INVALID_SETTING: % must be true or false', k; end if;
    if k = 'ai_min_confidence' and (n is null or n not between 0 and 1) then raise exception 'INVALID_SETTING: ai_min_confidence must be a number from 0 to 1'; end if;
    if k in ('slip_window_before_min', 'slip_future_tolerance_min') and (n is null or n <> trunc(n) or n not between 0 and 1440) then
      raise exception 'INVALID_SETTING: % must be a whole number of minutes from 0 to 1440', k; end if;
  end loop;
  update public.finance_settings set
    ai_review_enabled = case when p_patch ? 'ai_review_enabled' then (p_patch ->> 'ai_review_enabled')::boolean else ai_review_enabled end,
    post_requires_manager = case when p_patch ? 'post_requires_manager' then (p_patch ->> 'post_requires_manager')::boolean else post_requires_manager end,
    ai_min_confidence = case when p_patch ? 'ai_min_confidence' then round((p_patch ->> 'ai_min_confidence')::numeric, 2) else ai_min_confidence end,
    slip_window_before_min = case when p_patch ? 'slip_window_before_min' then (p_patch ->> 'slip_window_before_min')::numeric::integer else slip_window_before_min end,
    slip_future_tolerance_min = case when p_patch ? 'slip_future_tolerance_min' then (p_patch ->> 'slip_future_tolerance_min')::numeric::integer else slip_future_tolerance_min end,
    updated_by = auth.uid(), updated_at = now() where id returning * into s;
  perform public.finance_log('settings', gen_random_uuid(), 'settings.review', p_patch);
  return jsonb_build_object('ai_review_enabled', s.ai_review_enabled, 'post_requires_manager', s.post_requires_manager, 'ai_min_confidence', s.ai_min_confidence,
    'slip_window_before_min', s.slip_window_before_min, 'slip_future_tolerance_min', s.slip_future_tolerance_min);
end $$;

-- 3m reports. (1) The daily bank report put a receipt without a bank account on the "PROMPTPAY/OTHER" line and looked its ledger row up as a BANK_RECEIPT: a cash
-- receipt now has its own CASH line and its CASH_RECEIPT row counts as posted when the accountant posts it. Everything else in the report is as before.
create or replace function public.finance_bank_daily_report(p_from date, p_to date, p_bank uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see the bank report');
  return coalesce((select jsonb_agg(r order by r ->> 'day' desc, r ->> 'bank_code') from (
    select jsonb_build_object('day', (x.at at time zone 'Asia/Bangkok')::date, 'bank_code', case when x.cash then 'CASH' else coalesce(b.code, 'PROMPTPAY/OTHER') end, 'bank_account_id', x.bank,
      'deposits', count(*) filter (where x.kind = 'deposit'), 'deposit_amount', coalesce(sum(x.amount) filter (where x.kind = 'deposit'), 0),
      'invoice_transfers', count(*) filter (where x.kind = 'receipt'), 'invoice_amount', coalesce(sum(x.amount) filter (where x.kind = 'receipt'), 0),
      'total', sum(x.amount), 'in_ledger', coalesce(sum(x.amount) filter (where x.posted), 0), 'waiting_for_ledger', coalesce(sum(x.amount) filter (where not x.posted), 0)) r
    from (
      select 'deposit' kind, d.transfer_at at, d.bank_account_id bank, d.verified_amount amount,
             coalesce((select q.status = 'posted' from public.finance_gl_queue q where q.event_type = 'WALLET_DEPOSIT' and q.ref_id = d.wallet_txn_id), false) posted, false as cash
        from public.finance_wallet_deposits d where d.status = 'verified'
      union all
      select 'receipt', rc.received_at, rc.bank_account_id, rc.amount,
             coalesce((select q.status = 'posted' from public.finance_gl_queue q where q.event_type in ('BANK_RECEIPT', 'CASH_RECEIPT') and q.ref_id = rc.id), false), rc.method = 'cash'
        from public.finance_receipts rc where rc.status = 'posted' and rc.wallet_txn_id is null) x
    left join public.finance_bank_accounts b on b.id = x.bank
    where (x.at at time zone 'Asia/Bangkok')::date between p_from and p_to and (p_bank is null or x.bank = p_bank)
    group by (x.at at time zone 'Asia/Bangkok')::date, b.code, x.bank, x.cash) q), '[]'::jsonb);
end $$;

-- (2) the staff payments list showed every status other than submitted / verified as "rejected": a confirmed slip or one waiting for more evidence now shows as itself
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
           case e.status when 'submitted' then 'submitted' when 'verified' then 'verified' when 'confirmed' then 'confirmed' when 'more_evidence' then 'more_evidence' else 'rejected' end, e.bank_account_id, e.created_at, e.file_path, e.bank_trans_ref
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

-- 3n who may call what. The core and the reference check are internal (not even the service role); the new actions are for signed-in users, and each checks the
-- finance role itself. (The replaced functions keep the grants they already had.)
revoke execute on function public.finance_verify_core(uuid, numeric, text, timestamptz, text, text, text, text), public.finance_ref_in_use(text, uuid) from public, anon, authenticated;
revoke execute on function public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text), public.finance_post_evidence(uuid, text), public.finance_request_more_evidence(uuid, text),
  public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text), public.finance_save_review_settings(jsonb) from public, anon;
grant execute on function public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text), public.finance_post_evidence(uuid, text), public.finance_request_more_evidence(uuid, text),
  public.finance_record_payment(uuid, text, numeric, timestamptz, text, uuid, text, text, text, text), public.finance_save_review_settings(jsonb) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public.finance_verify_core(uuid, numeric, text, timestamptz, text, text, text, text), public.finance_ref_in_use(text, uuid) from service_role;
  end if;
end $$;
