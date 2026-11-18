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
