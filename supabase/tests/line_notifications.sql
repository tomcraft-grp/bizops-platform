-- LINE OA order notifications, tested against REAL data (real catalogue, real profiles, real bank accounts) inside ONE transaction that is rolled back
-- (scripts/run-line-sql-tests.sh sends prod_dry_run_prelude.sql, the new migration and this file). Nothing persists: the last statement raises an exception
-- that carries the result table.
-- People: S = the oldest active SUPER_ADMIN (finance manager), ADM = the ADMIN promoted by the prelude (shop staff, NO finance role), A = a customer.
-- Sections: L1 settings / credentials / linking / webhook dedupe, L2 finance (optional reference, quick confirm), L3 card data, line_act, queue.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon, service_role; grant usage on sequence t_res_n_seq to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; d text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then
    get stacked diagnostics d = pg_exception_detail; m := sqlerrm || coalesce(' | ' || d, ''); perform pg_temp.chk(p_test, m ilike p_pat, m);
  end;
end $$;
create or replace function pg_temp.err_state(p_test text, p_sql text, p_state text) returns void language plpgsql as $$
declare s text;
begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected SQLSTATE ' || p_state || ')');
  exception when others then get stacked diagnostics s = returned_sqlstate; perform pg_temp.chk(p_test, s = p_state, s || ' ' || sqlerrm);
  end;
end $$;
create or replace function pg_temp.q(p_test text, p_sql text) returns void language plpgsql as $$
declare b boolean; m text;
begin
  begin execute p_sql into b; perform pg_temp.chk(p_test, b, case when b is true then null else 'returned ' || coalesce(b::text, 'null') end);
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, false, m);
  end;
end $$;
-- auth.uid() reads request.jwt.claim.sub FIRST, then request.jwt.claims; line_redeem_code / line_act set both (transaction-local), so the helper sets both too
create or replace function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true), set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
-- the code a staff member would read on the screen (the function returns it in clear once; only its hash is stored)
create or replace function pg_temp.code(p_kind text) returns text language plpgsql as $$
declare r jsonb; begin r := public.line_link_code(p_kind); return r ->> 'code'; end $$;

insert into t_ctx select 'A', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'S', id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1;
insert into t_ctx select 'ADM', id::text from public.profiles where role = 'ADMIN' and status = 'active' order by created_at limit 1;
delete from public.finance_staff_roles where user_id = pg_temp.c('ADM')::uuid;      -- ADM is shop staff only (no finance role) in every scenario below

-- ================================================================================================= L1 settings, credentials, linking, webhook dedupe
select pg_temp.q('L1.1 defaults: off, quick approve off, cap 3000, four reasons, app url',
  $q$ select enabled = false and quick_approve_enabled = false and quick_approve_max_amount = 3000
       and reject_reasons = array['สลิปไม่ถูกต้อง','ยอดเงินไม่ตรง','สินค้าหมด','ลูกค้าขอยกเลิก']
       and app_url = 'https://tomcraft-grp.github.io/bizops-platform/' and group_id is null from public.line_settings $q$);

set local role authenticated;
select pg_temp.as_user(pg_temp.c('A')::uuid);
select pg_temp.err_state('L1.2 a customer cannot read the LINE settings', 'select public.line_admin_settings()', '42501');
select pg_temp.as_user(pg_temp.c('ADM')::uuid);
select pg_temp.q('L1.2 staff read the settings: credential flags only, no credential keys',
  $q$ select (s ? 'secret_set') and (s ? 'token_set') and not (s ? 'channel_secret') and not (s ? 'access_token') and (s ->> 'secret_set') = 'false'
       and (s ->> 'can_edit') = 'false' and s -> 'links' = 'null'::jsonb from (select public.line_admin_settings() s) x $q$);
select pg_temp.err_state('L1.3 ADMIN cannot change settings', $q$ select public.line_admin_save_settings('{"quick_approve_enabled": true}') $q$, '42501');
select pg_temp.err_state('L1.3 ADMIN cannot set credentials', $q$ select public.line_admin_set_credentials('s', 't') $q$, '42501');

select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.line_admin_set_credentials('0123456789abcdef0123456789abcdef', 'TESTTOKEN-line-0123456789-abcdefghij');
select pg_temp.q('L1.4 credentials set: flags true, values never in the settings answer',
  $q$ select (s ->> 'secret_set') = 'true' and (s ->> 'token_set') = 'true' and s::text not like '%TESTTOKEN%' and s::text not like '%0123456789abcdef0123%'
       from (select public.line_admin_settings() s) x $q$);
select pg_temp.err_state('L1.4 a client cannot read the credentials', 'select public.line_credentials_internal()', '42501');
reset role;
set local role service_role;
select pg_temp.q('L1.4 the service role reads the credentials (and a dispatch secret exists)',
  $q$ select c ->> 'channel_secret' = '0123456789abcdef0123456789abcdef' and c ->> 'access_token' = 'TESTTOKEN-line-0123456789-abcdefghij'
       and length(c ->> 'dispatch_secret') >= 32 from (select public.line_credentials_internal() c) x $q$);
reset role;

set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('L1.5 switching on without a bound group is refused', $q$ select public.line_admin_save_settings('{"enabled": true}') $q$, 'LINE_NOT_READY%');
select pg_temp.err_like('L1.5 an unknown setting is refused', $q$ select public.line_admin_save_settings('{"group_id": "x"}') $q$, 'INVALID_SETTING%');
select pg_temp.err_like('L1.5 a cap of zero is refused', $q$ select public.line_admin_save_settings('{"quick_approve_max_amount": 0}') $q$, '%amount%');

select pg_temp.as_user(pg_temp.c('ADM')::uuid);
insert into t_ctx select 'code_adm', pg_temp.code('staff');
select pg_temp.chk('L1.6 a staff link code is 6 digits', pg_temp.c('code_adm') ~ '^[0-9]{6}$', pg_temp.c('code_adm'));
select pg_temp.err_state('L1.6 ADMIN cannot make a group code', $q$ select public.line_link_code('group') $q$, '42501');
reset role;
set local role service_role;
select pg_temp.q('L1.6 redeeming the code in a 1:1 chat links the LINE account',
  format($q$ select public.line_redeem_code('Uadm00000000000000000000000000001', 'Adm on LINE', %L) ->> 'result' = 'linked' $q$, pg_temp.c('code_adm')));
select pg_temp.q('L1.6 the same code cannot be used twice',
  format($q$ select public.line_redeem_code('Uother000000000000000000000000002', 'Other', %L) ->> 'result' = 'bad_code' $q$, pg_temp.c('code_adm')));
reset role;
set local role authenticated;
select pg_temp.as_user(pg_temp.c('ADM')::uuid);
select pg_temp.q('L1.6 the staff member sees their link', $q$ select public.line_admin_settings() -> 'my_link' ->> 'display_name' = 'Adm on LINE' $q$);
reset role;

set local role service_role;
do $$ declare i int; begin for i in 1..5 loop perform public.line_redeem_code('Ubad0000000000000000000000000000x', null, '000000'); end loop; end $$;
select pg_temp.q('L1.7 the sixth wrong code within the hour is rate limited',
  $q$ select public.line_redeem_code('Ubad0000000000000000000000000000x', null, '000001') ->> 'result' = 'rate_limited' $q$);
reset role;

set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'code_grp', pg_temp.code('group');
reset role;
set local role service_role;
select pg_temp.q('L1.8 a group code typed in the group binds that group',
  format($q$ select public.line_redeem_code('Usup00000000000000000000000000003', 'Shop admins', %L, 'Cgroup0000000000000000000000000001') ->> 'result' = 'group_bound' $q$, pg_temp.c('code_grp')));
select pg_temp.q('L1.8 the bound group is stored', $q$ select group_id = 'Cgroup0000000000000000000000000001' and group_name = 'Shop admins' from public.line_settings $q$);
select public.line_group_left('Cgroup0000000000000000000000000001');
select pg_temp.q('L1.8 the bot leaving the group unbinds it', $q$ select group_id is null and group_left_at is not null from public.line_settings $q$);
select pg_temp.q('L1.9 a webhook event is new the first time', $q$ select public.line_webhook_seen('ev-test-1', 'postback', 'group') $q$);
select pg_temp.q('L1.9 the same webhook event is a duplicate the second time', $q$ select not public.line_webhook_seen('ev-test-1', 'postback', 'group') $q$);
reset role;

set local role authenticated;
select pg_temp.as_user(pg_temp.c('ADM')::uuid);
insert into t_ctx select 'code_old', pg_temp.code('staff');
reset role;
update public.line_bind_codes set expires_at = now() - interval '1 minute' where used_at is null;
set local role service_role;
select pg_temp.q('L1.10 an expired code is refused',
  format($q$ select public.line_redeem_code('Uadm00000000000000000000000000001', 'Adm', %L) ->> 'result' = 'bad_code' $q$, pg_temp.c('code_old')));
reset role;

select pg_temp.q('L1.11 the Vault helpers are not callable by the service role either (it would read any secret by name)',
  $q$ select not has_function_privilege('service_role', 'public.line_vault_get(text)', 'execute') and not has_function_privilege('service_role', 'public.line_vault_put(text, text)', 'execute') $q$);

-- ================================================================================================= L2 finance: optional reference, duplicate rule, quick confirm
-- Real orders and slips through the shop's own functions (customer A), every order the same amount; transfer minutes decide what counts as a duplicate.
insert into t_ctx select 'scb', id::text from public.finance_bank_accounts where code = 'SCB';
-- a real sellable SKU (the catalogue changes: never a fixed code) and its server price
insert into t_ctx select 'SKU', sku_code from public.shop_sellable where available and (max_qty is null or max_qty >= 12) order by sku_code limit 1;
insert into t_ctx select 'P1', price::text from public.shop_sellable where sku_code = pg_temp.c('SKU');
insert into t_ctx values ('M1', (date_trunc('minute', now()) - interval '40 minutes')::text);
update public.shop_settings set shop_open = true, pickup_enabled = true, delivery_enabled = true, shipping_fee = 50, free_shipping_min = null, require_payment_slip = false;
-- an order of 2 x FG-000001 (pickup) by A, and its slip claimed at p_at with the receiving account SCB; keys o_<k>, i_<k>, e_<k>
-- (a customer may place at most 10 orders an hour: the orders are spread over customers A to D, recorded as cust_<k>)
insert into t_ctx select 'B', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 1 limit 1;
insert into t_ctx select 'C', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 2 limit 1;
insert into t_ctx select 'D', id::text from public.profiles where role = 'USER' and status = 'active' order by created_at offset 3 limit 1;
create or replace function pg_temp.order_slip(p_key text, p_at timestamptz, p_qty int default 2, p_cust text default 'A') returns void language plpgsql as $$
declare r jsonb;
begin
  insert into t_ctx values ('cust_' || p_key, pg_temp.c(p_cust));
  perform pg_temp.as_user(pg_temp.c(p_cust)::uuid);
  r := public.shop_place_order('line-key-' || p_key, format('[{"sku_code":"%s","qty":%s}]', pg_temp.c('SKU'), p_qty)::jsonb, 'pickup', 'Somchai', '081-234-5678', null, null,
                               p_qty * pg_temp.c('P1')::numeric, 'bank:SCB');
  insert into t_ctx values ('o_' || p_key, r -> 'order' ->> 'id'), ('i_' || p_key, r -> 'order' -> 'invoice' ->> 'id');
  insert into t_ctx select 'e_' || p_key, public.finance_submit_evidence(pg_temp.c('i_' || p_key)::uuid, pg_temp.c(p_cust) || '/line-' || p_key || '.png',
    md5('line-' || p_key) || md5('line-b-' || p_key), 'image/png', p_qty * pg_temp.c('P1')::numeric, p_at, 'SCB', null, pg_temp.c('scb')::uuid)::text;
end $$;
set local role authenticated;
select pg_temp.order_slip('21', pg_temp.c('M1')::timestamptz + interval '5 seconds');
select pg_temp.order_slip('22', pg_temp.c('M1')::timestamptz + interval '35 seconds');
select pg_temp.order_slip('23', pg_temp.c('M1')::timestamptz + interval '3 minutes');
select pg_temp.order_slip('24', pg_temp.c('M1')::timestamptz + interval '4 minutes');
select pg_temp.order_slip('25', pg_temp.c('M1')::timestamptz + interval '5 minutes');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.q('L2.1 Confirm without a bank reference works',
  format($q$ select public.finance_confirm_evidence(%L, %s, '', %L) ->> 'status' = 'confirmed' $q$, pg_temp.c('e_21'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '5 seconds'));
reset role;
select pg_temp.q('L2.1 it is stored without a reference and marked as confirmed on the web',
  format($q$ select confirmed_bank_ref is null and confirmed_via = 'web' and status = 'confirmed' from public.finance_payment_evidence where id = %L $q$, pg_temp.c('e_21')));
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('L2.2 same amount, account and minute without a reference is a suspected duplicate',
  format($q$ select public.finance_confirm_evidence(%L, %s, '', %L) $q$, pg_temp.c('e_22'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '35 seconds'), 'DUPLICATE_SUSPECT%');
select pg_temp.err_state('L2.2 the duplicate refusal is SQLSTATE 23505',
  format($q$ select public.finance_confirm_evidence(%L, %s, null, %L) $q$, pg_temp.c('e_22'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '35 seconds'), '23505');
select pg_temp.err_like('L2.3 a reference does NOT get past a twin that has no reference (one transfer could settle two orders)',
  format($q$ select public.finance_confirm_evidence(%L, %s, 'LINETEST000022', %L) $q$, pg_temp.c('e_22'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '35 seconds'), 'DUPLICATE_SUSPECT%');
select pg_temp.q('L2.3 "these are two different transfers" (p_distinct) confirms it',
  format($q$ select public.finance_confirm_evidence(%L, %s, 'LINETEST000022', %L, null, true) ->> 'status' = 'confirmed' $q$, pg_temp.c('e_22'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '35 seconds'));
reset role;
select pg_temp.q('L2.3 the override is in the audit trail', format($q$ select exists (select 1 from public.finance_events where entity_id = %L::uuid and action = 'evidence.dup_override') $q$, pg_temp.c('e_22')));
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('L2.4 a reference already used is still refused as before',
  format($q$ select public.finance_confirm_evidence(%L, %s, 'linetest-000022', %L) $q$, pg_temp.c('e_23'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '3 minutes'), 'Bank transaction % was already recorded%');
select public.finance_confirm_evidence(pg_temp.c('e_23')::uuid, 2 * pg_temp.c('P1')::numeric, '', pg_temp.c('M1')::timestamptz + interval '3 minutes');
select pg_temp.q('L2.5 Post without any reference creates the receipt',
  format($q$ select (public.finance_post_evidence(%L) ->> 'receipt_no') is not null $q$, pg_temp.c('e_23')));
reset role;
select pg_temp.q('L2.5 the slip is posted, the receipt has no reference, one bank receipt is queued for the ledger',
  format($q$ select e.status = 'verified' and e.bank_trans_ref is null and r.bank_trans_ref is null
       and (select count(*) from public.finance_gl_queue g where g.ref_id = r.id and g.event_type = 'BANK_RECEIPT') = 1
       from public.finance_payment_evidence e join public.finance_receipts r on r.evidence_id = e.id where e.id = %L $q$, pg_temp.c('e_23')));
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('L2.5 Post without a reference re-checks the duplicate rule (a same-minute twin was confirmed meanwhile)',
  format($q$ select public.finance_post_evidence(%L) $q$, pg_temp.c('e_21')), 'DUPLICATE_SUSPECT%');
select pg_temp.q('L2.6 Post may add the reference from the bank statement',
  format($q$ select (public.finance_post_evidence(%L, null, 'LINETEST000021') ->> 'receipt_no') is not null $q$, pg_temp.c('e_21')));
reset role;
select pg_temp.q('L2.6 the added reference is on the slip and on the receipt',
  format($q$ select e.confirmed_bank_ref = 'LINETEST000021' and r.bank_trans_ref = 'LINETEST000021'
       from public.finance_payment_evidence e join public.finance_receipts r on r.evidence_id = e.id where e.id = %L $q$, pg_temp.c('e_21')));
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('L2.7 the legacy one-step verify still requires a reference',
  format($q$ select public.finance_verify_evidence(%L, %s, '', %L) $q$, pg_temp.c('e_24'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '4 minutes'),
  'The bank transaction reference is required%');
select pg_temp.err_state('L2.8 clients cannot call the LINE quick confirm', format($q$ select public.finance_quick_confirm_evidence(%L) $q$, pg_temp.c('e_25')), '42501');
reset role;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.q('L2.8 quick confirm (internal, as a manager) confirms at the claimed amount and time, without a reference',
  format($q$ select public.finance_quick_confirm_evidence(%L) ->> 'status' = 'confirmed' $q$, pg_temp.c('e_25')));
select pg_temp.q('L2.8 the quick-confirmed slip carries line_quick, the claimed amount and time, no reference',
  format($q$ select confirmed_via = 'line_quick' and confirmed_amount = claimed_amount and confirmed_transfer_at = claimed_transfer_at and confirmed_bank_ref is null
       and confirm_note = 'LINE quick approve' and confirmed_by = %L::uuid from public.finance_payment_evidence where id = %L $q$, pg_temp.c('S'), pg_temp.c('e_25')));
select pg_temp.q('L2.8 the confirm is logged with via line_quick',
  format($q$ select exists (select 1 from public.finance_events where entity_id = %L::uuid and action = 'evidence.confirm' and detail ->> 'via' = 'line_quick') $q$, pg_temp.c('e_25')));
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.q('L2.9 the review list filters LINE quick approvals and carries confirmed_via and no_ref',
  format($q$ select exists (select 1 from jsonb_array_elements(public.finance_review_list('{"via":"line_quick"}', 200) -> 'items') x
       where x ->> 'evidence_id' = %L and x ->> 'confirmed_via' = 'line_quick' and (x ->> 'no_ref')::boolean)
       and not exists (select 1 from jsonb_array_elements(public.finance_review_list('{"via":"line_quick"}', 200) -> 'items') x where x ->> 'evidence_id' = %L) $q$,
     pg_temp.c('e_25'), pg_temp.c('e_22')));
reset role;

-- the duplicate rule in BOTH directions: a payment saved WITHOUT a reference is found by later paths that HAVE one (review finding C1), ±1 minute, wallet deposits
set local role authenticated;
select pg_temp.order_slip('26', pg_temp.c('M1')::timestamptz + interval '3 minutes 20 seconds');
select pg_temp.order_slip('27', pg_temp.c('M1')::timestamptz + interval '3 minutes 40 seconds');
select pg_temp.order_slip('28', pg_temp.c('M1')::timestamptz + interval '4 minutes 10 seconds');
select pg_temp.order_slip('29', pg_temp.c('M1')::timestamptz + interval '30 minutes 10 seconds');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select pg_temp.err_like('L2.10 Confirm WITH a reference is refused when the same transfer was posted without one',
  format($q$ select public.finance_confirm_evidence(%L, %s, 'LINETEST000026', %L) $q$, pg_temp.c('e_26'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '3 minutes 20 seconds'), 'DUPLICATE_SUSPECT%');
select pg_temp.q('L2.10 ...and goes through when the person says they are two transfers',
  format($q$ select public.finance_confirm_evidence(%L, %s, 'LINETEST000026', %L, null, true) ->> 'status' = 'confirmed' $q$, pg_temp.c('e_26'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '3 minutes 20 seconds'));
select pg_temp.err_like('L2.10 Post of that slip without the override is refused too (the core checks)', format($q$ select public.finance_post_evidence(%L) $q$, pg_temp.c('e_26')), 'DUPLICATE_SUSPECT%');
select pg_temp.q('L2.10 Post with the override works', format($q$ select (public.finance_post_evidence(%L, null, null, true) ->> 'receipt_no') is not null $q$, pg_temp.c('e_26')));
select pg_temp.err_like('L2.11 the one-step verify with a reference is refused against a posted payment without one',
  format($q$ select public.finance_verify_evidence(%L, %s, 'LINETEST000027', %L) $q$, pg_temp.c('e_27'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '3 minutes 40 seconds'), 'DUPLICATE_SUSPECT%');
select pg_temp.err_like('L2.12 one minute apart still counts (a customer-given time can be a minute off)',
  format($q$ select public.finance_confirm_evidence(%L, %s, '', %L) $q$, pg_temp.c('e_28'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '4 minutes 10 seconds'), 'DUPLICATE_SUSPECT%');
-- a wallet top-up of the same amount to the same account: verified WITH a reference -> an order slip without one is refused; and the other way round
select pg_temp.as_user(pg_temp.c('B')::uuid);
insert into t_ctx select 'dep1', (public.finance_deposit_create(pg_temp.c('scb')::uuid, 2 * pg_temp.c('P1')::numeric, 'line-dep-key-0001')) ->> 'id';
select public.finance_deposit_submit_slip(pg_temp.c('dep1')::uuid, pg_temp.c('B') || '/line-dep1.png', md5('line-dep1') || md5('line-dep1b'), 'image/png', pg_temp.c('M1')::timestamptz + interval '30 minutes');
insert into t_ctx select 'dep2', (public.finance_deposit_create(pg_temp.c('scb')::uuid, 2 * pg_temp.c('P1')::numeric, 'line-dep-key-0002')) ->> 'id';
select public.finance_deposit_submit_slip(pg_temp.c('dep2')::uuid, pg_temp.c('B') || '/line-dep2.png', md5('line-dep2') || md5('line-dep2b'), 'image/png', pg_temp.c('M1')::timestamptz + interval '3 minutes 50 seconds');
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_deposit_verify(pg_temp.c('dep1')::uuid, 2 * pg_temp.c('P1')::numeric, 'LINETEST-DEP-1', pg_temp.c('M1')::timestamptz + interval '30 minutes');
select pg_temp.err_like('L2.13 an order slip without a reference is refused next to a verified wallet top-up of the same transfer',
  format($q$ select public.finance_confirm_evidence(%L, %s, '', %L) $q$, pg_temp.c('e_29'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '30 minutes 10 seconds'), 'DUPLICATE_SUSPECT%');
select pg_temp.err_like('L2.13 a wallet top-up WITH a reference is refused next to an order payment posted without one',
  format($q$ select public.finance_deposit_verify(%L, %s, 'LINETEST-DEP-2', %L) $q$, pg_temp.c('dep2'), 2 * pg_temp.c('P1')::numeric, pg_temp.c('M1')::timestamptz + interval '3 minutes 50 seconds'), 'DUPLICATE_SUSPECT%');
reset role;

-- cash is never a "duplicate": central receivables splits ONE cash payment over several invoices (same amount, same time, no reference, no bank account)
set local role authenticated;
select pg_temp.order_slip('46', null, 2, 'B');
select pg_temp.order_slip('47', null, 2, 'B');
select pg_temp.as_user(pg_temp.c('S')::uuid);
insert into t_ctx select 'cash46', public.finance_record_payment(p_invoice => pg_temp.c('i_46')::uuid, p_method => 'cash', p_amount => 100, p_received_at => pg_temp.c('M1')::timestamptz + interval '35 minutes',
  p_bank_trans_ref => null, p_bank_account => null, p_note => 'Cash at the counter', p_file_path => null, p_sha256 => null, p_file_type => null, p_idempotency_key => 'line-cash-split-46') ->> 'evidence_id';
insert into t_ctx select 'cash47', public.finance_record_payment(p_invoice => pg_temp.c('i_47')::uuid, p_method => 'cash', p_amount => 100, p_received_at => pg_temp.c('M1')::timestamptz + interval '35 minutes',
  p_bank_trans_ref => null, p_bank_account => null, p_note => 'Cash at the counter', p_file_path => null, p_sha256 => null, p_file_type => null, p_idempotency_key => 'line-cash-split-47') ->> 'evidence_id';
select pg_temp.q('L2.14 two equal cash parts at the same time both post (cash is not checked for duplicates)',
  format($q$ select (public.finance_post_evidence(%L, 'part 1') ->> 'receipt_no') is not null and (public.finance_post_evidence(%L, 'part 2') ->> 'receipt_no') is not null $q$,
    pg_temp.c('cash46'), pg_temp.c('cash47')));
reset role;

-- ================================================================================================= L3 card data, line_act, queue
-- shorthands: the outbox rows of an order; the card (order_new row) of an order; a LINE action as the webhook would send it (service role)
create or replace function pg_temp.ob(p_key text, p_event text) returns bigint language sql as $$
  select count(*) from public.line_outbox where order_id = pg_temp.c('o_' || p_key)::uuid and event = p_event $$;
create or replace function pg_temp.card(p_key text) returns uuid language sql as $$
  select id from public.line_outbox where order_id = pg_temp.c('o_' || p_key)::uuid and event = 'order_new' limit 1 $$;
create or replace function pg_temp.act(p_user text, p_action text, p_key text, p_reason int default null) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role service_role;
  r := public.line_act(p_user, p_action, pg_temp.c('o_' || p_key)::uuid, pg_temp.card(p_key), p_reason, 'ev-' || p_action || '-' || p_key);
  reset role;
  -- in production each tap is its own transaction; this whole file is ONE transaction, so forget the tap's "via LINE" flag and identity afterwards
  perform set_config('line.via_line', '', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
  return r;
exception when others then reset role; return jsonb_build_object('result', 'EXCEPTION', 'message', sqlerrm);
end $$;
grant all on t_res, t_ctx to service_role;
insert into t_ctx values ('UADM', 'Uadm00000000000000000000000000001'), ('US', 'Usup00000000000000000000000000003'), ('UX', 'Unobody0000000000000000000000000x');

select pg_temp.order_slip('30', pg_temp.c('M1')::timestamptz + interval '9 minutes', 2, 'B');
select pg_temp.q('L3.1 with LINE off, an order queues nothing', $q$ select pg_temp.ob('30', 'order_new') = 0 $q$);
-- switch LINE on inside this run: credentials were set in L1.4, bind the group, link S
update public.line_settings set group_id = 'Cgroup0000000000000000000000000001', group_name = 'Shop admins', group_left_at = null where id;
insert into public.line_staff_links (profile_id, line_user_id, display_name) values (pg_temp.c('S')::uuid, pg_temp.c('US'), 'Boss on LINE') on conflict do nothing;
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.line_admin_save_settings('{"enabled": true}');
select pg_temp.order_slip('31', pg_temp.c('M1')::timestamptz + interval '10 minutes', 2, 'B');
select pg_temp.order_slip('32', pg_temp.c('M1')::timestamptz + interval '12 minutes', 2, 'B');
select pg_temp.order_slip('33', pg_temp.c('M1')::timestamptz + interval '13 minutes', 8, 'B');
select pg_temp.order_slip('34', null, 2, 'B');
select pg_temp.order_slip('35', pg_temp.c('M1')::timestamptz + interval '12 minutes 20 seconds', 2, 'C');
select pg_temp.order_slip('36', pg_temp.c('M1')::timestamptz + interval '14 minutes', 2, 'C');
select pg_temp.order_slip('37', pg_temp.c('M1')::timestamptz + interval '15 minutes', 2, 'C');
select pg_temp.order_slip('38', pg_temp.c('M1')::timestamptz + interval '16 minutes', 2, 'C');
select pg_temp.order_slip('39', pg_temp.c('M1')::timestamptz + interval '17 minutes', 2, 'C');
select pg_temp.order_slip('40', pg_temp.c('M1')::timestamptz + interval '18 minutes', 2, 'D');
reset role;

select pg_temp.q('L3.2 with LINE on, one card per order', $q$ select pg_temp.ob('31', 'order_new') = 1 and pg_temp.ob('32', 'order_new') = 1 $q$);
select pg_temp.q('L3.2 the slip sent with the order is not announced twice', $q$ select pg_temp.ob('31', 'slip_new') = 0 $q$);
select pg_temp.q('L3.2 the card goes to the bound group', $q$ select target_type = 'group' and target_id = 'Cgroup0000000000000000000000000001' and status = 'queued'
  from public.line_outbox where id = pg_temp.card('31') $q$);
-- a later slip on an order placed earlier (the order is back-dated: inside one transaction now() never moves)
update public.shop_orders set created_at = now() - interval '1 hour' where id = pg_temp.c('o_30')::uuid;
set local role authenticated;
select pg_temp.as_user(pg_temp.c('B')::uuid);
select public.finance_submit_evidence(pg_temp.c('i_30')::uuid, pg_temp.c('B') || '/line-30b.png', md5('line-30b') || md5('line-30bb'), 'image/png', 2 * pg_temp.c('P1')::numeric,
  pg_temp.c('M1')::timestamptz + interval '9 minutes 30 seconds', 'SCB', null, pg_temp.c('scb')::uuid);
reset role;
select pg_temp.q('L3.2 a slip added to an existing order is announced once', $q$ select pg_temp.ob('30', 'slip_new') = 1 $q$);

-- card data: an order of five different products
insert into t_ctx select 'SKU' || n, sku_code from (select sku_code, row_number() over (order by sku_code) n from public.shop_sellable where available limit 5) x;
set local role authenticated;
select pg_temp.as_user(pg_temp.c('D')::uuid);
insert into t_ctx select 'o_41', public.shop_place_order('line-key-41', jsonb_build_array(
    jsonb_build_object('sku_code', pg_temp.c('SKU1'), 'qty', 1), jsonb_build_object('sku_code', pg_temp.c('SKU2'), 'qty', 2), jsonb_build_object('sku_code', pg_temp.c('SKU3'), 'qty', 1),
    jsonb_build_object('sku_code', pg_temp.c('SKU4'), 'qty', 1), jsonb_build_object('sku_code', pg_temp.c('SKU5'), 'qty', 1)), 'pickup', 'Somchai', '081-234-5678', null, null, null, 'bank:SCB')
  -> 'order' ->> 'id';
reset role;
select pg_temp.q('L3.3 card data: 3 item lines shown, 2 more, 6 pieces, the order total, no slip yet',
  $q$ select jsonb_array_length(d -> 'items') = 3 and (d ->> 'more_count')::int = 2 and (d ->> 'item_count')::int = 6
       and (d ->> 'total')::numeric = (select total from public.shop_orders where id = pg_temp.c('o_41')::uuid) and (d -> 'payment' ->> 'has_slip')::boolean = false
       and d ->> 'status' = 'new' and d ->> 'app_url' = 'https://tomcraft-grp.github.io/bizops-platform/' and d ->> 'phone' = '0812345678'
     from (select public.line_card_data(pg_temp.c('o_41')::uuid) d) x $q$);
select pg_temp.q('L3.3 card data of an order with a slip: has_slip, bank SCB, the transfer time, the slip id',
  $q$ select (d -> 'payment' ->> 'has_slip')::boolean and d -> 'payment' ->> 'bank' = 'SCB' and d -> 'payment' ->> 'method' = 'transfer'
       and (d -> 'payment' ->> 'transfer_at')::timestamptz = pg_temp.c('M1')::timestamptz + interval '10 minutes' and d -> 'payment' ->> 'evidence_id' = pg_temp.c('e_31')
     from (select public.line_card_data(pg_temp.c('o_31')::uuid) d) x $q$);

-- accept
select pg_temp.q('L3.4 an unlinked LINE account gets not_linked', $q$ select pg_temp.act(pg_temp.c('UX'), 'accept', '31') ->> 'result' = 'not_linked' $q$);
select pg_temp.q('L3.4 ...and the order did not change', $q$ select status = 'new' from public.shop_orders where id = pg_temp.c('o_31')::uuid $q$);
select pg_temp.q('L3.5 a linked ADMIN accepts the order', $q$ select r ->> 'result' = 'done' and r ->> 'action' = 'accept' and r ->> 'order_no' is not null
  from (select pg_temp.act(pg_temp.c('UADM'), 'accept', '31') r) x $q$);
select pg_temp.q('L3.5 the order is confirmed and the event names the ADMIN', $q$ select o.status = 'confirmed' and e.actor = pg_temp.c('ADM')::uuid and e.detail ->> 'from' = 'new'
  from public.shop_orders o join lateral (select * from public.shop_events where entity = 'order' and entity_id = o.id::text and action = 'order.status' order by id desc limit 1) e on true
  where o.id = pg_temp.c('o_31')::uuid $q$);
select pg_temp.q('L3.5 an action from LINE does not queue a follow-up (the reply announces it)', $q$ select pg_temp.ob('31', 'order_status') = 0 $q$);
select pg_temp.q('L3.5 the order history says the action came from LINE', $q$ select exists (select 1 from public.shop_events where entity = 'order' and entity_id = pg_temp.c('o_31')
  and action = 'order.line' and detail ->> 'via' = 'line' and detail ->> 'action' = 'accept' and actor = pg_temp.c('ADM')::uuid) $q$);
select pg_temp.q('L3.6 a second tap on the same card says who accepted it', $q$ select r ->> 'result' = 'already_done' and r ->> 'status' = 'confirmed' and r ->> 'by' is not null
  and r ->> 'by' = (select coalesce(nullif(btrim(display_name), ''), email) from public.profiles where id = pg_temp.c('ADM')::uuid)
  from (select pg_temp.act(pg_temp.c('US'), 'accept', '31') r) x $q$);
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_reject_evidence(pg_temp.c('e_39')::uuid, 'test');
select public.shop_admin_set_status(pg_temp.c('o_39')::uuid, 'cancelled', 'Customer phoned to cancel');
select public.shop_admin_set_status(pg_temp.c('o_40')::uuid, 'confirmed');
reset role;
select pg_temp.q('L3.6 a tap on an order cancelled on the web says it is cancelled', $q$ select r ->> 'result' = 'already_done' and r ->> 'status' = 'cancelled'
  from (select pg_temp.act(pg_temp.c('UADM'), 'accept', '39') r) x $q$);
select pg_temp.q('L3.7 a confirm on the web queues one follow-up for the group', $q$ select pg_temp.ob('40', 'order_status') = 1 and (select payload ->> 'status' from public.line_outbox
  where order_id = pg_temp.c('o_40')::uuid and event = 'order_status') = 'confirmed' $q$);
select pg_temp.q('L3.7 a web reject of a slip queues a payment issue', $q$ select pg_temp.ob('39', 'payment_issue') = 1 $q$);

-- quick approve
select pg_temp.q('L3.8 quick approve while it is switched off is refused', $q$ select r ->> 'result' = 'refused' and r ->> 'code' = 'QUICK_OFF'
  from (select pg_temp.act(pg_temp.c('US'), 'quick_confirm', '32') r) x $q$);
update public.line_settings set quick_approve_enabled = true where id;
select pg_temp.q('L3.9 an ADMIN without a finance role cannot quick approve', $q$ select r ->> 'result' = 'not_allowed' and r ->> 'why' = 'not_verifier'
  from (select pg_temp.act(pg_temp.c('UADM'), 'quick_confirm', '32') r) x $q$);
select pg_temp.q('L3.9 ...and nothing changed', $q$ select o.status = 'new' and e.status = 'submitted' from public.shop_orders o, public.finance_payment_evidence e
  where o.id = pg_temp.c('o_32')::uuid and e.id = pg_temp.c('e_32')::uuid $q$);
select pg_temp.q('L3.10 quick_ask returns what will be approved', $q$ select r ->> 'result' = 'ask_quick' and (r ->> 'amount')::numeric = 2 * pg_temp.c('P1')::numeric
  and r ->> 'bank' = 'SCB' and (r ->> 'transfer_at')::timestamptz = pg_temp.c('M1')::timestamptz + interval '12 minutes'
  from (select pg_temp.act(pg_temp.c('US'), 'quick_ask', '32') r) x $q$);
select pg_temp.q('L3.10 the card offers quick approve for this order', $q$ select (public.line_card_data(pg_temp.c('o_32')::uuid) -> 'quick' ->> 'ok')::boolean $q$);
select pg_temp.q('L3.10 a manager quick approves', $q$ select r ->> 'result' = 'done' and r ->> 'action' = 'quick_confirm'
  from (select pg_temp.act(pg_temp.c('US'), 'quick_confirm', '32') r) x $q$);
select pg_temp.q('L3.10 slip confirmed via LINE, order confirmed, finance event names the manager', $q$ select e.status = 'confirmed' and e.confirmed_via = 'line_quick' and o.status = 'confirmed'
  and exists (select 1 from public.finance_events f where f.entity_id = e.id and f.action = 'evidence.confirm' and f.actor = pg_temp.c('S')::uuid and f.detail ->> 'via' = 'line_quick')
  from public.finance_payment_evidence e, public.shop_orders o where e.id = pg_temp.c('e_32')::uuid and o.id = pg_temp.c('o_32')::uuid $q$);
select pg_temp.q('L3.11 above the cap: refused OVER_CAP, and the card hides quick approve', $q$ select r ->> 'code' = 'OVER_CAP'
  and not (public.line_card_data(pg_temp.c('o_33')::uuid) -> 'quick' ->> 'ok')::boolean from (select pg_temp.act(pg_temp.c('US'), 'quick_confirm', '33') r) x $q$);
select pg_temp.q('L3.11 no transfer time: refused NO_TRANSFER_TIME', $q$ select pg_temp.act(pg_temp.c('US'), 'quick_confirm', '34') ->> 'code' = 'NO_TRANSFER_TIME' $q$);
select pg_temp.q('L3.11 same amount, account and minute as an approved slip: refused DUPLICATE_SUSPECT', $q$ select pg_temp.act(pg_temp.c('US'), 'quick_confirm', '35') ->> 'code' = 'DUPLICATE_SUSPECT' $q$);
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_reject_evidence(pg_temp.c('e_36')::uuid, 'Blurred');
select pg_temp.as_user(pg_temp.c('C')::uuid);
select public.finance_submit_evidence(pg_temp.c('i_36')::uuid, pg_temp.c('C') || '/line-36b.png', md5('line-36b') || md5('line-36bb'), 'image/png', 2 * pg_temp.c('P1')::numeric,
  null, 'SCB', null, pg_temp.c('scb')::uuid);
reset role;
select pg_temp.q('L3.12 after the customer replaced the slip, the new slip is judged (no transfer time)', $q$ select pg_temp.act(pg_temp.c('US'), 'quick_confirm', '36') ->> 'code' = 'NO_TRANSFER_TIME' $q$);

-- reject
select pg_temp.q('L3.13 reject_ask offers the reasons', $q$ select r ->> 'result' = 'ask_reason' and r -> 'reasons' = to_jsonb(array['สลิปไม่ถูกต้อง','ยอดเงินไม่ตรง','สินค้าหมด','ลูกค้าขอยกเลิก'])
  from (select pg_temp.act(pg_temp.c('UADM'), 'reject_ask', '37') r) x $q$);
select pg_temp.q('L3.13 an ADMIN without a finance role cannot reject an order whose slip waits', $q$ select pg_temp.act(pg_temp.c('UADM'), 'reject', '37', 1) ->> 'why' = 'not_verifier' $q$);
select pg_temp.q('L3.13 a manager rejects with reason 1', $q$ select r ->> 'result' = 'done' and r ->> 'reason' = 'ยอดเงินไม่ตรง' from (select pg_temp.act(pg_temp.c('US'), 'reject', '37', 1) r) x $q$);
select pg_temp.q('L3.13 slip rejected with that reason, order cancelled', $q$ select e.status = 'rejected' and e.reject_reason = 'ยอดเงินไม่ตรง' and o.status = 'cancelled' and o.cancel_reason = 'ยอดเงินไม่ตรง'
  from public.finance_payment_evidence e, public.shop_orders o where e.id = pg_temp.c('e_37')::uuid and o.id = pg_temp.c('o_37')::uuid $q$);
select pg_temp.q('L3.13 a reason number out of range is refused', $q$ select pg_temp.act(pg_temp.c('US'), 'reject', '38', 9) ->> 'code' = 'BAD_REASON' $q$);
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_confirm_evidence(pg_temp.c('e_38')::uuid, 2 * pg_temp.c('P1')::numeric, 'LINETEST000038', pg_temp.c('M1')::timestamptz + interval '16 minutes');
select public.finance_post_evidence(pg_temp.c('e_38')::uuid);
reset role;
select pg_temp.q('L3.14 rejecting an order whose payment is posted is refused', $q$ select r ->> 'result' = 'refused' and r ->> 'code' = 'PAYMENT_RECORDED'
  from (select pg_temp.act(pg_temp.c('US'), 'reject', '38', 0) r) x $q$);
select pg_temp.q('L3.14 ...and the order is still new', $q$ select status = 'new' from public.shop_orders where id = pg_temp.c('o_38')::uuid $q$);

-- the dispatcher's side
set local role service_role;
insert into t_ctx select 'claimed', public.line_claim_outbox(50)::text;
reset role;
select pg_temp.q('L3.15 claim returns due rows with their card and marks them sending', $q$ select jsonb_array_length(pg_temp.c('claimed')::jsonb) >= 1
  and exists (select 1 from jsonb_array_elements(pg_temp.c('claimed')::jsonb) x where x ->> 'id' = pg_temp.card('32')::text and x -> 'card' ->> 'order_no' is not null)
  and (select status from public.line_outbox where id = pg_temp.card('32')) = 'sending' $q$);
set local role service_role;
select public.line_complete_outbox(pg_temp.card('32'), false, true, 'HTTP 500', null);
reset role;
select pg_temp.q('L3.15 a retryable failure: failed, attempt 1, next try in about a minute', $q$ select status = 'failed' and attempts = 1 and last_error = 'HTTP 500'
  and next_attempt_at between now() + interval '55 seconds' and now() + interval '65 seconds' from public.line_outbox where id = pg_temp.card('32') $q$);
set local role service_role;
select public.line_complete_outbox(pg_temp.card('32'), false, true, 'HTTP 500', null) from generate_series(1, 5);
select public.line_complete_outbox(pg_temp.card('33'), false, false, 'HTTP 400 bad request', null);
select public.line_complete_outbox(pg_temp.card('31'), true, false, null, 'req-123');
reset role;
select pg_temp.q('L3.15 the sixth failure is dead', $q$ select status = 'dead' and attempts = 6 from public.line_outbox where id = pg_temp.card('32') $q$);
select pg_temp.q('L3.15 a non-retryable failure is dead at once', $q$ select status = 'dead' and attempts = 1 from public.line_outbox where id = pg_temp.card('33') $q$);
select pg_temp.q('L3.15 a success is sent with the request id', $q$ select status = 'sent' and sent_at is not null and line_request_id = 'req-123' from public.line_outbox where id = pg_temp.card('31') $q$);
insert into t_ctx select 'card32', pg_temp.card('32')::text;          -- (clients cannot read the outbox table: keep the id before acting as staff)
set local role authenticated;
select pg_temp.as_user(pg_temp.c('ADM')::uuid);
select pg_temp.q('L3.15 staff see the failed deliveries', $q$ select exists (select 1 from jsonb_array_elements(public.line_admin_outbox('failed')) x where x ->> 'id' = pg_temp.c('card32')) $q$);
select public.line_admin_resend(pg_temp.c('card32')::uuid);
reset role;
select pg_temp.q('L3.15 send again puts it back in the queue', $q$ select status = 'queued' and attempts = 0 from public.line_outbox where id = pg_temp.card('32') $q$);

-- customer notification
update public.line_settings set events = events || '{"customer_notify": true}' where id;
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
update public.profiles set line_user_id = 'Ucustomer000000000000000000000001' where id = pg_temp.c('B')::uuid and line_user_id is null;
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.shop_admin_set_status(pg_temp.c('o_30')::uuid, 'confirmed');
reset role;
select pg_temp.q('L3.16 the customer is told on LINE when switched on', $q$ select exists (select 1 from public.line_outbox where order_id = pg_temp.c('o_30')::uuid and event = 'customer_notify'
  and target_type = 'user' and target_id = (select line_user_id from public.profiles where id = pg_temp.c('B')::uuid)) $q$);

-- review findings: LINE can never break checkout (I1); a slip already handled on the web is named (I2); "accepted by" is who accepted (M7); a replaced slip is not
-- announced as rejected (M12)
update public.line_settings set events = events || '{"order_new": "maybe"}'::jsonb where id;          -- a broken setting: casting it fails inside the trigger
set local role authenticated;
select pg_temp.as_user(pg_temp.c('D')::uuid);
select pg_temp.q('L3.18 a broken LINE setting does not stop an order from being placed',
  format($q$ select (public.shop_place_order('line-key-44', '[{"sku_code":"%s","qty":1}]'::jsonb, 'pickup', 'Somchai', '081-234-5678', null, null, null, 'bank:SCB') -> 'order' ->> 'id') is not null $q$, pg_temp.c('SKU')));
reset role;
update public.line_settings set events = events || '{"order_new": true}'::jsonb where id;
select pg_temp.order_slip('42', pg_temp.c('M1')::timestamptz + interval '25 minutes', 2, 'D');
select pg_temp.order_slip('43', pg_temp.c('M1')::timestamptz + interval '27 minutes', 2, 'D');
set local role authenticated;
select pg_temp.as_user(pg_temp.c('S')::uuid);
select public.finance_confirm_evidence(pg_temp.c('e_42')::uuid, 2 * pg_temp.c('P1')::numeric, 'LINETEST000042', pg_temp.c('M1')::timestamptz + interval '25 minutes');
select public.shop_admin_set_status(pg_temp.c('o_31')::uuid, 'preparing', null, 'test: moving on without payment');
select public.finance_request_more_evidence(pg_temp.c('e_43')::uuid, 'Please send the full slip');
select pg_temp.as_user(pg_temp.c('D')::uuid);
select public.finance_submit_evidence(pg_temp.c('i_43')::uuid, pg_temp.c('D') || '/line-43b.png', md5('line-43b') || md5('line-43bb'), 'image/png', 2 * pg_temp.c('P1')::numeric,
  pg_temp.c('M1')::timestamptz + interval '27 minutes', 'SCB', null, pg_temp.c('scb')::uuid);
reset role;
select pg_temp.q('L3.19 quick approve of a slip already confirmed on the web says who confirmed it', $q$ select r ->> 'result' = 'slip_done' and r ->> 'status' = 'confirmed'
  and r ->> 'by' = (select coalesce(nullif(btrim(display_name), ''), email) from public.profiles where id = pg_temp.c('S')::uuid) and r ->> 'at' is not null
  from (select pg_temp.act(pg_temp.c('US'), 'quick_confirm', '42') r) x $q$);
select pg_temp.q('L3.20 "already accepted by" names who accepted, not who moved it on later', $q$ select r ->> 'result' = 'already_done' and r ->> 'status' = 'preparing'
  and r ->> 'by' = (select coalesce(nullif(btrim(display_name), ''), email) from public.profiles where id = pg_temp.c('ADM')::uuid)
  from (select pg_temp.act(pg_temp.c('US'), 'accept', '31') r) x $q$);
select pg_temp.q('L3.21 asking for more evidence is announced once; the replaced slip is not announced as rejected', $q$ select pg_temp.ob('43', 'payment_issue') = 1
  and (select payload ->> 'kind' from public.line_outbox where order_id = pg_temp.c('o_43')::uuid and event = 'payment_issue') = 'more_evidence' $q$);

select pg_temp.q('L3.17 the dispatch job is scheduled every minute', $q$ select exists (select 1 from cron.job where jobname = 'line-dispatch' and schedule = '* * * * *') $q$);
select pg_temp.q('L3.17 the LINE internals are not callable by clients',
  $q$ select not has_function_privilege('authenticated', 'public.line_act(text, text, uuid, uuid, integer, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.line_claim_outbox(integer)', 'execute')
       and not has_function_privilege('authenticated', 'public.line_complete_outbox(uuid, boolean, boolean, text, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.line_kick()', 'execute')
       and not has_function_privilege('authenticated', 'public.line_card_data(uuid)', 'execute')
       and has_function_privilege('service_role', 'public.line_act(text, text, uuid, uuid, integer, text)', 'execute') $q$);

-- =========================================================================================== result
do $$ declare r text; bad int; tot int;
begin
  select count(*) filter (where ok is not true), count(*) into bad, tot from t_res;
  select string_agg(format('%s [%s] %s%s', case when ok is true then 'PASS' else 'FAIL' end, n, test, case when ok is true then '' else ' => ' || coalesce(detail, '') end), E'\n' order by n) into r from t_res;
  raise exception E'LINE_TESTS % of % passed\n%', tot - bad, tot, r;
end $$;
