-- Rolls back 20261122140000_line_order_notifications.sql (proof: scripts/run-line-down-proof.sh).
-- Undeploy the Edge Functions line-webhook and line-dispatch FIRST (otherwise they call functions that no longer exist), then run this file, then delete version
-- 20261122140000 from supabase_migrations.schema_migrations. The extensions pg_net and pg_cron are left installed (harmless, and other features may use them).
-- What is lost: the LINE settings, staff links, delivery log and webhook log (the audit trail of every action stays in shop_events / finance_events).
-- REFUSES while a transfer is confirmed without a bank reference: the restored Post requires one, so such a payment could not be posted any more. Post (with a
-- reference) or reject those payments first.
do $$ begin
  if exists (select 1 from public.finance_payment_evidence where status = 'confirmed' and method = 'transfer' and confirmed_bank_ref is null) then
    raise exception 'REFUSING: Confirmed transfers without a bank reference exist (%); post them with a reference or reject them first',
      (select count(*) from public.finance_payment_evidence where status = 'confirmed' and method = 'transfer' and confirmed_bank_ref is null);
  end if;
end $$;

-- C
do $$ begin
  if exists (select 1 from cron.job where jobname = 'line-dispatch') then perform cron.unschedule('line-dispatch'); end if;
end $$;
drop trigger if exists line_order_new on public.shop_orders;
drop trigger if exists line_order_status on public.shop_orders;
drop trigger if exists line_evidence_new on public.finance_payment_evidence;
drop trigger if exists line_evidence_issue on public.finance_payment_evidence;
drop trigger if exists line_analysis_issue on public.finance_slip_analysis;
drop function if exists public.line_admin_resend(uuid);
drop function if exists public.line_admin_outbox(text, integer);
drop function if exists public.line_act(text, text, uuid, uuid, integer, text);
drop function if exists public.line_claim_outbox(integer);
drop function if exists public.line_complete_outbox(uuid, boolean, boolean, text, text);
drop function if exists public.line_card_data(uuid);
drop function if exists public.line_quick_check(uuid);
drop function if exists public.line_last_action(uuid);
drop function if exists public.line_slip_done(uuid);
drop function if exists public.line_person(uuid);
drop function if exists public.line_enqueue(text, uuid, uuid, jsonb);
drop function if exists public.line_trg_order_new();
drop function if exists public.line_trg_order_status();
drop function if exists public.line_trg_evidence();
drop function if exists public.line_trg_analysis();

-- B: the four finance functions exactly as 20261120100000_slip_review.sql defines them, the 2-argument Post with its grant, and no confirmed_via
drop function if exists public.finance_quick_confirm_evidence(uuid);
drop function if exists public.finance_post_evidence(uuid, text, text, boolean);
drop function if exists public.finance_post_evidence(uuid, text, text);
drop function if exists public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text, boolean);
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

create or replace function public.finance_confirm_evidence(p_evidence uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; v_ref text := trim(p_bank_trans_ref); v_note text := nullif(trim(p_note), '');
begin
  perform public.finance_require('verify', 'confirm payments');
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if coalesce(v_ref, '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if length(public.finance_slip_ref(v_ref)) < 4 or length(v_ref) > 80 then raise exception 'The bank transaction reference must have 4 to 80 letters or digits'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  if p_transfer_at > now() + interval '10 minutes' then raise exception 'The payment time is in the future'; end if;   -- the same limit and words as Record payment
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

create or replace function public.finance_post_evidence(p_evidence uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; i public.finance_invoices; rc public.finance_receipts; v jsonb;
begin
  perform public.finance_require(case when coalesce((select s.post_requires_manager from public.finance_settings s where s.id), false) then 'manage' else 'verify' end, 'post payments');
  select * into e from public.finance_payment_evidence where id = p_evidence for update;     -- the evidence first, then the invoice (the order the core uses)
  if not found then raise exception 'Evidence not found'; end if;
  if e.method = 'cash' then perform public.finance_require('manage', 'post cash payments'); end if;
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

create or replace function public.finance_review_list(p_filter jsonb default '{}'::jsonb, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  f jsonb := coalesce(p_filter, '{}'::jsonb); k text;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200); v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_stage text[]; v_result text[]; v_source text[]; v_method text[]; v_reason text; v_q text; v_pat text; v_qref text;
  v_from date; v_to date; v_from_ts timestamptz; v_to_ts timestamptz; v_res jsonb;
begin
  perform public.finance_require('view', 'see the slip review');
  if jsonb_typeof(f) = 'null' then f := '{}'::jsonb; end if;
  if jsonb_typeof(f) <> 'object' then raise exception 'INVALID_FILTER: the filter must be an object'; end if;
  for k in select jsonb_object_keys(f) loop
    if k not in ('stage', 'ai_result', 'from', 'to', 'reason', 'source', 'method', 'search') then raise exception 'INVALID_FILTER: unknown filter %', k; end if;
  end loop;
  v_stage := public.finance_review_arr(f -> 'stage', 'stage', array['slip_submitted', 'ai_completed', 'manual_review', 'confirmed', 'posted', 'rejected', 'more_evidence']);
  v_result := public.finance_review_arr(f -> 'ai_result', 'ai_result', array['match', 'amount_mismatch', 'date_mismatch', 'time_anomaly', 'duplicate_suspected', 'suspicious_slip', 'manual_review']);
  v_source := public.finance_review_arr(f -> 'source', 'source', array['customer_slip', 'staff_entry']);
  v_method := public.finance_review_arr(f -> 'method', 'method', array['transfer', 'cash']);
  v_from := public.finance_review_date(f -> 'from', 'from');
  v_to := public.finance_review_date(f -> 'to', 'to');
  if jsonb_typeof(f -> 'reason') not in ('string', 'null') or jsonb_typeof(f -> 'search') not in ('string', 'null') then
    raise exception 'INVALID_FILTER: reason and search must be text'; end if;
  v_reason := nullif(btrim(f ->> 'reason'), '');
  v_q := nullif(btrim(coalesce(f ->> 'search', '')), '');
  if v_q is not null then
    v_pat := '%' || replace(replace(replace(left(v_q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if length(public.finance_slip_ref(left(v_q, 80))) >= 4 then v_qref := public.finance_slip_ref(left(v_q, 80)); end if;
  end if;
  v_from_ts := v_from::timestamp at time zone 'Asia/Bangkok';                  -- the start of the first day ...
  v_to_ts := (v_to + 1)::timestamp at time zone 'Asia/Bangkok';                -- ... up to (not including) the start of the day after the last one

  with base as (
    select ev.id, ev.created_at, ev.source, ev.method, ev.status, ev.invoice_id, ev.claimed_amount, ev.claimed_ref, ev.bank_trans_ref, ev.confirmed_amount, ev.confirmed_bank_ref, ev.posted_at,
           i.invoice_no, i.amount as invoice_amount, c.name as customer_name, c.profile_id,
           o.id as order_id, o.order_no, o.created_at as order_created_at, o.total as order_total, nullif(btrim(o.contact_phone), '') as contact_phone,
           na.status as a_status, na.result as a_result, na.reasons as a_reasons, dn.extracted as d_extracted, dn.qr as d_qr, dn.overall_confidence as d_conf,
           public.finance_evidence_stage(ev.status, na.status, na.result) as stage
      from public.finance_payment_evidence ev
      join public.finance_invoices i on i.id = ev.invoice_id
      join public.finance_customers c on c.id = ev.customer_id
      left join public.shop_orders o on o.invoice_id = ev.invoice_id
      left join lateral (select a.status, a.result, a.reasons from public.finance_slip_analysis a where a.evidence_id = ev.id order by a.attempt desc limit 1) na on true
      left join lateral (select a.extracted, a.qr, a.overall_confidence from public.finance_slip_analysis a where a.evidence_id = ev.id and a.status = 'done' order by a.attempt desc limit 1) dn on true
     where (v_from_ts is null or ev.created_at >= v_from_ts) and (v_to_ts is null or ev.created_at < v_to_ts)
       and (v_source is null or ev.source = any (v_source)) and (v_method is null or ev.method = any (v_method))
  ), flt as (
    select b.* from base b
     where (v_stage is null or b.stage = any (v_stage)) and (v_result is null or b.a_result = any (v_result))
       and (v_reason is null or b.a_reasons @> jsonb_build_array(jsonb_build_object('code', v_reason)))
       and (v_pat is null
            or b.order_no ilike v_pat or b.invoice_no ilike v_pat or b.customer_name ilike v_pat
            or b.confirmed_bank_ref ilike v_pat or b.claimed_ref ilike v_pat or b.bank_trans_ref ilike v_pat
            or (b.d_extracted ->> 'trans_ref') ilike v_pat or (b.d_qr ->> 'trans_ref') ilike v_pat
            or (v_qref is not null and (public.finance_slip_ref(b.confirmed_bank_ref) like '%' || v_qref || '%' or public.finance_slip_ref(b.claimed_ref) like '%' || v_qref || '%'
                                        or public.finance_slip_ref(b.bank_trans_ref) like '%' || v_qref || '%' or public.finance_slip_ref(b.d_extracted ->> 'trans_ref') like '%' || v_qref || '%'
                                        or public.finance_slip_ref(b.d_qr ->> 'trans_ref') like '%' || v_qref || '%')))
  ), tot as (
    select count(*) as n from flt
  ), page as (
    select * from flt order by created_at desc, id limit v_lim offset v_off
  )
  select jsonb_build_object('total', (select n from tot), 'items', coalesce(jsonb_agg(jsonb_build_object(
      'evidence_id', page.id, 'created_at', page.created_at, 'source', page.source, 'method', page.method, 'status', page.status, 'stage', page.stage,
      'order_id', page.order_id, 'order_no', page.order_no, 'order_created_at', page.order_created_at, 'order_total', page.order_total,
      'invoice_id', page.invoice_id, 'invoice_no', page.invoice_no, 'invoice_amount', page.invoice_amount,
      'paid', (s.st ->> 'paid')::numeric, 'outstanding', (s.st ->> 'outstanding')::numeric,
      'customer_name', page.customer_name, 'customer_phone', coalesce(page.contact_phone, (select p.phone from public.profiles p where p.id = page.profile_id)),
      'expected_amount', public.finance_review_expected(page.id), 'claimed_amount', page.claimed_amount,
      'ai_amount', case when jsonb_typeof(page.d_extracted -> 'amount') = 'number' then (page.d_extracted ->> 'amount')::numeric end,
      'ai_transfer_at', page.d_extracted ->> 'transfer_at', 'ai_result', page.a_result, 'ai_confidence', page.d_conf, 'ai_status', page.a_status,
      'reasons', coalesce((select jsonb_agg(r.value ->> 'code' order by r.ord) from jsonb_array_elements(page.a_reasons) with ordinality as r(value, ord)), '[]'::jsonb),
      'confirmed_amount', page.confirmed_amount, 'confirmed_bank_ref', page.confirmed_bank_ref, 'posted_at', page.posted_at) order by page.created_at desc, page.id), '[]'::jsonb))
    into v_res
    from page cross join lateral (select public.finance_invoice_state_raw(page.invoice_id) as st) s;
  return v_res;
end $$;

revoke execute on function public.finance_post_evidence(uuid, text), public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text) from public, anon;
grant execute on function public.finance_post_evidence(uuid, text), public.finance_confirm_evidence(uuid, numeric, text, timestamptz, text) to authenticated;
drop function if exists public.finance_dup_check(numeric, uuid, timestamptz, uuid, boolean);
drop function if exists public.finance_quick_dup(numeric, uuid, timestamptz, uuid, boolean);
drop function if exists public.finance_quick_dup(numeric, uuid, timestamptz, uuid);
drop index if exists public.finance_evidence_quickdup_idx;
alter table public.finance_payment_evidence drop constraint if exists finance_payment_evidence_confirmed_via_chk;
alter table public.finance_payment_evidence drop column if exists confirmed_via;

-- the wallet top-up verify exactly as 20261115200000_wallet_payments.sql defines it
create or replace function public.finance_deposit_verify(p_deposit uuid, p_amount numeric, p_bank_trans_ref text, p_transfer_at timestamptz, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d public.finance_wallet_deposits; v_t public.finance_wallet_transactions; v_bank public.finance_bank_accounts; v_cust public.finance_customers;
begin
  perform public.finance_require('verify', 'verify deposits');
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount shown by the bank'; end if;
  if coalesce(trim(p_bank_trans_ref), '') = '' then raise exception 'The bank transaction reference is required'; end if;
  if p_transfer_at is null then raise exception 'The transfer date and time are required'; end if;
  select * into v_d from public.finance_wallet_deposits where id = p_deposit for update;
  if not found then raise exception 'Deposit not found'; end if;
  if v_d.status not in ('submitted', 'under_review') then raise exception 'DEPOSIT_NOT_REVIEWABLE: this deposit is %', v_d.status; end if;
  if exists (select 1 from public.finance_receipts where bank_trans_ref = trim(p_bank_trans_ref)) or exists (select 1 from public.finance_wallet_deposits where bank_trans_ref = trim(p_bank_trans_ref) and status = 'verified') then
    raise exception 'Bank transaction % was already recorded (reused slip?)', trim(p_bank_trans_ref) using errcode = '23505'; end if;
  if p_transfer_at < v_d.created_at - interval '1 day' then raise exception 'The transfer is older than the deposit request'; end if;
  select * into v_bank from public.finance_bank_accounts where id = v_d.bank_account_id;
  select * into v_cust from public.finance_customers where id = v_d.customer_id;
  v_t := public.finance_wallet_apply(v_d.customer_id, 'DEPOSIT', 'credit', p_amount, 'DEP:' || v_d.id::text, 'deposit', v_d.id, v_d.deposit_no, 'bank_transfer', v_d.bank_account_id, 'verified',
                                     v_cust.profile_id, auth.uid(), 'Verified bank transfer ' || trim(p_bank_trans_ref), null);
  update public.finance_wallet_deposits set status = 'verified', verified_amount = p_amount, bank_trans_ref = trim(p_bank_trans_ref), transfer_at = p_transfer_at,
    review_note = nullif(btrim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now(), wallet_txn_id = v_t.id where id = p_deposit returning * into v_d;
  perform public.finance_gl_enqueue('WALLET_DEPOSIT', 'wallet_txn', v_t.id, v_t.txn_no, v_d.customer_id, p_amount,
    jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'bank', 'amount', p_amount, 'bank_account_id', v_d.bank_account_id),
                      jsonb_build_object('side', 'cr', 'role', 'customer_credit', 'amount', p_amount, 'wallet', true)));
  perform public.finance_log('deposit', v_d.id, 'deposit.verify', jsonb_build_object('no', v_d.deposit_no, 'claimed', v_d.amount, 'verified', p_amount, 'trans_ref', trim(p_bank_trans_ref), 'txn', v_t.txn_no));
  return jsonb_build_object('deposit', to_jsonb(v_d), 'txn_no', v_t.txn_no, 'balance', v_t.balance_after);
end $$;

-- A (tables first: the outbox trigger depends on its function)
drop table if exists public.line_outbox;
drop table if exists public.line_webhook_events;
drop table if exists public.line_code_attempts;
drop table if exists public.line_bind_codes;
drop table if exists public.line_staff_links;
drop table if exists public.line_settings;
drop function if exists public.line_kick();
drop function if exists public.line_trg_outbox_kick();
drop function if exists public.line_admin_settings();
drop function if exists public.line_admin_save_settings(jsonb);
drop function if exists public.line_admin_set_credentials(text, text);
drop function if exists public.line_link_code(text);
drop function if exists public.line_unlink(uuid);
drop function if exists public.line_credentials_internal();
drop function if exists public.line_webhook_seen(text, text, text);
drop function if exists public.line_redeem_code(text, text, text, text);
drop function if exists public.line_group_left(text);
drop function if exists public.line_code_hash(text);
drop function if exists public.line_vault_put(text, text);
drop function if exists public.line_vault_get(text);
drop function if exists public.line_require_super(text);
drop function if exists public.line_is_super();
delete from vault.secrets where name in ('line_channel_secret', 'line_channel_token', 'line_dispatch_secret');
