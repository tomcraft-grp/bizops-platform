-- Rolls back 20261120100000_slip_review.sql: drops the slip-analysis table and every column, index and constraint the migration added, and puts the
-- earlier checks back (evidence statuses submitted/verified/rejected, ledger-queue event types without CASH_RECEIPT, file columns NOT NULL).
-- The sections undo the migration in REVERSE order: the section of a later task (4 reads, 3 workflow, 2 analysis) goes ABOVE "1 schema" in this file, so
-- the functions and triggers that use the new columns are removed before the columns are.
--
-- REFUSES to run once the new objects hold records, because dropping them would destroy financial history: any analysis row, any staff-recorded
-- payment, any evidence that is confirmed / waiting for more evidence, or that carries a confirm / post / request / recorder stamp (a posted slip that
-- went through Confirm keeps who confirmed it and when), and any CASH_RECEIPT ledger row (the old check could not take it back).

do $guard$ begin
  if to_regclass('public.finance_slip_analysis') is not null then
    if exists (select 1 from public.finance_slip_analysis) then
      raise exception 'Slip analyses exist: they are records and cannot be rolled back.'; end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'finance_payment_evidence' and column_name = 'source') then
    if exists (select 1 from public.finance_payment_evidence
                where source = 'staff_entry' or status in ('confirmed', 'more_evidence')
                   or confirmed_by is not null or posted_by is not null or requested_by is not null or recorded_by is not null) then
      raise exception 'Payments were recorded, confirmed or sent back for more evidence: they cannot be rolled back.'; end if;
  end if;
  if exists (select 1 from public.finance_gl_queue where event_type = 'CASH_RECEIPT') then
    raise exception 'Cash receipts are queued for the ledger: they cannot be rolled back.'; end if;
end $guard$;

-- ================================================================================================= 1 schema (undo)
-- 1d ledger queue: the event types as they were (the original check had the generated name finance_gl_queue_event_type_check)
alter table public.finance_gl_queue drop constraint if exists finance_gl_queue_event_type_chk;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_gl_queue_event_type_check' and conrelid = 'public.finance_gl_queue'::regclass) then
    alter table public.finance_gl_queue add constraint finance_gl_queue_event_type_check
      check (event_type in ('INVOICE_ISSUE', 'INVOICE_CANCEL', 'BANK_RECEIPT', 'RECEIPT_REAPPLY', 'RECEIPT_REVERSAL', 'WALLET_DEPOSIT', 'WALLET_PAYMENT',
                            'WALLET_REFUND', 'WALLET_ADJUSTMENT', 'WALLET_REVERSAL'));
  end if;
end $$;

-- 1c the analysis table (its trigger, policy and constraints go with it)
drop table if exists public.finance_slip_analysis;
drop function if exists public.finance_guard_slip_analysis();

-- 1b evidence: index, checks, file columns, new columns (dropping a column drops the checks that only used it)
drop index if exists public.finance_evidence_confirmed_ref_once;
alter table public.finance_payment_evidence drop constraint if exists finance_payment_evidence_status_chk;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'finance_payment_evidence_status_check' and conrelid = 'public.finance_payment_evidence'::regclass) then
    alter table public.finance_payment_evidence add constraint finance_payment_evidence_status_check check (status in ('submitted', 'verified', 'rejected'));
  end if;
end $$;
alter table public.finance_payment_evidence drop constraint if exists finance_evidence_file_required_chk;
alter table public.finance_payment_evidence alter column file_path set not null, alter column file_sha256 set not null, alter column file_type set not null;
alter table public.finance_payment_evidence
  drop column if exists source, drop column if exists method, drop column if exists recorded_by,
  drop column if exists confirmed_by, drop column if exists confirmed_at, drop column if exists confirmed_amount, drop column if exists confirmed_bank_ref,
  drop column if exists confirmed_transfer_at, drop column if exists confirm_note,
  drop column if exists posted_by, drop column if exists posted_at,
  drop column if exists request_message, drop column if exists requested_by, drop column if exists requested_at;

-- 1a settings
alter table public.finance_settings
  drop column if exists ai_review_enabled, drop column if exists post_requires_manager, drop column if exists ai_min_confidence,
  drop column if exists slip_window_before_min, drop column if exists slip_future_tolerance_min;

-- 1e receipts: nothing was changed (finance_receipts.method has no check), so there is nothing to undo.
