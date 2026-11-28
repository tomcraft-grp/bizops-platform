-- Tests for 20261128160000_expense_bank_posting.sql, run after the migration in ONE transaction that always rolls back (scripts/run-expense-bank-sql-tests.sh).
-- Real data: S = a real SUPER_ADMIN, M = a real expense manager (expense_staff_roles), E = a real USER profile given the employee role for the test, the shop's real
-- bank accounts (SCB, BBL), a real active FG product and a real inactive product of the catalogue. One raw material ("fresh coconut sugar") is issued through the
-- real sku_issue() and put on sale, to prove a raw material that is also sold stays a raw material. Everything written here disappears with the rollback.
create temp table t_res (n serial, test text, ok boolean, detail text);
create temp table t_ctx (k text primary key, v text);
grant all on t_res, t_ctx to authenticated, anon; grant usage on sequence t_res_n_seq to authenticated, anon;
create or replace function pg_temp.chk(p_test text, p_ok boolean, p_detail text default null) returns void language sql as $$ insert into t_res (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.err_like(p_test text, p_sql text, p_pat text) returns void language plpgsql as $$
declare m text; begin
  begin execute p_sql; perform pg_temp.chk(p_test, false, 'no error (expected ' || p_pat || ')');
  exception when others then m := sqlerrm; perform pg_temp.chk(p_test, m ilike p_pat, m); end;
end $$;
create or replace function pg_temp.as_user(uid text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true) $$;
create or replace function pg_temp.c(k text) returns text language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
create or replace function pg_temp.put(k text, v text) returns void language sql as $$ insert into t_ctx values (k, v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.sv(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.sx(p_sql text) returns void language plpgsql security definer as $$ begin execute p_sql; end $$;
create or replace function pg_temp.bal(p_bank text) returns numeric language sql as $$ select pg_temp.sv(format('select balance from public.finance_bank_balances where bank_account_id = %L', p_bank))::numeric $$;
create or replace function pg_temp.ntx() returns integer language sql as $$ select pg_temp.sv('select count(*) from public.finance_bank_transactions')::int $$;
-- save a claim as the current user (13-argument form): date today, no VAT unless given
create or replace function pg_temp.save(p_desc text, p_cat text, p_amount numeric, p_method text, p_sku text, p_bank text, p_tax text default 'none') returns text language sql as $$
  select (public.expense_save(null, (now() at time zone 'Asia/Bangkok')::date, p_cat::uuid, p_desc, p_amount, p_tax, p_method, null, null, null, null, p_sku, p_bank::uuid)).id::text $$;
create or replace function pg_temp.claim(p_id text, p_col text) returns text language sql as $$ select pg_temp.sv(format('select %I::text from public.expense_claims where id = %L', p_col, p_id)) $$;

select pg_temp.put('S', (select id::text from public.profiles where role = 'SUPER_ADMIN' and status = 'active' order by created_at limit 1));
select pg_temp.put('M', (select r.user_id::text from public.expense_staff_roles r join public.profiles p on p.id = r.user_id where r.role = 'manager' and p.status = 'active' and p.role <> 'SUPER_ADMIN' order by r.granted_at limit 1));
select pg_temp.put('E', (select id::text from public.profiles p where role = 'USER' and status = 'active' and not exists (select 1 from public.expense_staff_roles r where r.user_id = p.id) order by created_at limit 1));
select pg_temp.put('SCB', (select id::text from public.finance_bank_accounts where code = 'SCB' and active));
select pg_temp.put('BBL', (select id::text from public.finance_bank_accounts where code = 'BBL' and active));
select pg_temp.put('FG', (select sku_code from public.sku_registry where status = 'active' and sku_category = 'FG' order by sku_seq limit 1));
select pg_temp.put('OFF', (select sku_code from public.sku_registry where status = 'inactive' order by sku_seq limit 1));
select pg_temp.put('LEGACY', (select id::text from public.expense_claims where status = 'posted' and journal_no is not null order by created_at limit 1));
select pg_temp.chk('F0 fixtures: admin, manager, employee, both banks, an active and an inactive product, a real posted claim', (select count(*) from t_ctx where v is not null) = 8,
  (select string_agg(k || '=' || coalesce(v, 'NULL'), ',') from t_ctx));
-- the employee role for E (as the admin, through the real function); the raw material, issued for real and put on sale
select pg_temp.as_user(pg_temp.c('S'));
select public.expense_set_role(pg_temp.c('E')::uuid, 'employee');
select pg_temp.put('RM', (select i.code from public.sku_issue('RM', 'น้ำตาลสด (ทดสอบ)', gen_random_uuid(), pg_temp.c('S')::uuid) i));
select pg_temp.sx(format('insert into public.shop_sku_content (sku_code, visible, available) values (%L, true, true) on conflict (sku_code) do update set visible = true, available = true', pg_temp.c('RM')));
select pg_temp.put('cat_rm', (select id::text from public.expense_categories where code = 'stock_materials'));
select pg_temp.put('cat_fg', (select id::text from public.expense_categories where code = 'stock_goods'));
select pg_temp.put('cat_office', (select id::text from public.expense_categories where code = 'office_supplies'));
select pg_temp.put('n_claims0', (select count(*)::text from public.expense_claims));
select pg_temp.put('legacy_fp', (select md5(string_agg(to_jsonb(c)::text, '|' order by id)) from public.expense_claims c));
select pg_temp.put('q0', (select count(*)::text from public.finance_gl_queue));

-- ================================================================================================ M. what the migration did
select pg_temp.chk('M1 two product categories: raw materials -> inventory role inv_materials, goods for resale -> inv_goods',
  (select count(*) from public.expense_categories where (code, treatment, posting_role, product_class) in (('stock_materials', 'inventory', 'inv_materials', 'RM'), ('stock_goods', 'inventory', 'inv_goods', 'FG'))) = 2);
select pg_temp.chk('M1 every real bank account has a balance row at 0 and the bank ledger is empty',
  (select count(*) from public.finance_bank_balances) = (select count(*) from public.finance_bank_accounts) and (select sum(abs(balance)) from public.finance_bank_balances) = 0 and pg_temp.ntx() = 0);
select pg_temp.chk('M1 the real posted claims got no product, bank account or queue row', (select count(*) from public.expense_claims where sku_code is not null or bank_account_id is not null or gl_queue_id is not null) = 0);
select pg_temp.chk('M1 the old 11-argument expense_save is still there for old app builds, next to the new 13-argument one',
  (select count(*) from pg_proc where proname = 'expense_save' and pronamespace = 'public'::regnamespace) = 2);
select pg_temp.chk('M2 anon can call none of the new functions',
  not has_function_privilege('anon', 'public.expense_post_bulk(uuid[], text)', 'execute') and not has_function_privilege('anon', 'public.expense_bank_options()', 'execute')
  and not has_function_privilege('anon', 'public.finance_bank_overview()', 'execute') and not has_function_privilege('anon', 'public.expense_save(uuid, date, uuid, text, numeric, text, text, text, text, text, text, text, uuid)', 'execute'));
select pg_temp.chk('M2 a signed-in user cannot call the internal writers (bank apply, post one, save core)',
  not has_function_privilege('authenticated', 'public.finance_bank_apply(uuid, text, text, numeric, date, text, uuid, text, text, uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.expense_post_one(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.expense_save_core(uuid, date, uuid, text, numeric, text, text, text, text, text, text, text, uuid, boolean)', 'execute'));
select pg_temp.chk('M2 nobody signed in can write the bank tables directly',
  not has_table_privilege('authenticated', 'public.finance_bank_transactions', 'insert') and not has_table_privilege('authenticated', 'public.finance_bank_balances', 'update')
  and not has_table_privilege('anon', 'public.finance_bank_transactions', 'select'));

-- ================================================================================================ P. products from the catalogue
select pg_temp.as_user(pg_temp.c('E'));
select pg_temp.put('opts', public.expense_product_options()::text);
select pg_temp.chk('P1 the employee gets the real active products, each with its mapped category, and no price or cost',
  (select count(*) from jsonb_array_elements(pg_temp.c('opts')::jsonb)) = (select count(*) from public.sku_registry where status = 'active')
  and not exists (select 1 from jsonb_array_elements(pg_temp.c('opts')::jsonb) o where o ? 'cost_price' or o ? 'retail_price' or o ? 'selling_price'));
select pg_temp.chk('P1 the raw material that is also on sale maps to "Raw materials", the FG product to "Goods for resale"',
  (select o ->> 'category_id' from jsonb_array_elements(pg_temp.c('opts')::jsonb) o where o ->> 'sku_code' = pg_temp.c('RM')) = pg_temp.c('cat_rm')
  and (select o ->> 'category_id' from jsonb_array_elements(pg_temp.c('opts')::jsonb) o where o ->> 'sku_code' = pg_temp.c('FG')) = pg_temp.c('cat_fg')
  and pg_temp.sv(format('select visible::text from public.shop_sku_content where sku_code = %L', pg_temp.c('RM'))) = 'true');
select pg_temp.chk('P1 inactive products are not offered', not exists (select 1 from jsonb_array_elements(pg_temp.c('opts')::jsonb) o where o ->> 'sku_code' = pg_temp.c('OFF')));
select pg_temp.put('c_rm', pg_temp.save('', null, 2500, 'bank_transfer', pg_temp.c('RM'), pg_temp.c('SCB')));
select pg_temp.chk('P2 a product without a category: the category comes from the catalogue class, the description from the product name, treatment inventory',
  pg_temp.claim(pg_temp.c('c_rm'), 'category_id') = pg_temp.c('cat_rm') and pg_temp.claim(pg_temp.c('c_rm'), 'treatment') = 'inventory'
  and pg_temp.claim(pg_temp.c('c_rm'), 'description') = 'น้ำตาลสด (ทดสอบ)' and pg_temp.claim(pg_temp.c('c_rm'), 'sku_code') = pg_temp.c('RM'));
select pg_temp.put('c_fg', pg_temp.save('FG restock', null, 300, 'cash', pg_temp.c('FG'), null));
select pg_temp.chk('P3 a finished-goods product maps to "Goods for resale"', pg_temp.claim(pg_temp.c('c_fg'), 'category_id') = pg_temp.c('cat_fg'));
select pg_temp.put('c_ovr', pg_temp.save('Sugar for the office', pg_temp.c('cat_office'), 45, 'cash', pg_temp.c('RM'), null));
select pg_temp.chk('P4 the employee can review and change the category before saving (kept as chosen, product still linked)',
  pg_temp.claim(pg_temp.c('c_ovr'), 'category_id') = pg_temp.c('cat_office') and pg_temp.claim(pg_temp.c('c_ovr'), 'sku_code') = pg_temp.c('RM'));
select pg_temp.err_like('P5 an inactive product is refused', format($q$select pg_temp.save('x', null, 10, 'cash', %L, null)$q$, pg_temp.c('OFF')), '%no longer active%');
select pg_temp.err_like('P5 an unknown product is refused', $q$select pg_temp.save('x', null, 10, 'cash', 'NOPE-0000', null)$q$, '%not in the product list%');

-- ================================================================================================ B. bank account on a transfer
select pg_temp.put('bopts', public.expense_bank_options()::text);
select pg_temp.chk('B1 the employee sees the real active bank accounts with the last 4 digits only (no account number)',
  (select count(*) from jsonb_array_elements(pg_temp.c('bopts')::jsonb)) = (select count(*) from public.finance_bank_accounts where active)
  and not exists (select 1 from jsonb_array_elements(pg_temp.c('bopts')::jsonb) o where o ? 'account_no' or o ? 'gl_account_code')
  and (select o ->> 'last4' from jsonb_array_elements(pg_temp.c('bopts')::jsonb) o where o ->> 'code' = 'SCB') = (select right(account_no, 4) from public.finance_bank_accounts where code = 'SCB'));
select pg_temp.err_like('B2 a bank transfer without a bank account is refused', format($q$select pg_temp.save('x', %L, 10, 'bank_transfer', null, null)$q$, pg_temp.c('cat_office')), '%bank account the money was paid from%');
select pg_temp.err_like('B2 a QR payment without a bank account is refused', format($q$select pg_temp.save('x', %L, 10, 'qr', null, null)$q$, pg_temp.c('cat_office')), '%bank account the money was paid from%');
select pg_temp.err_like('B2 a made-up bank account is refused', format($q$select pg_temp.save('x', %L, 10, 'bank_transfer', null, %L)$q$, pg_temp.c('cat_office'), gen_random_uuid()), '%active bank account%');
select pg_temp.put('c_cash', pg_temp.save('Coffee', pg_temp.c('cat_office'), 100, 'cash', null, pg_temp.c('SCB')));
select pg_temp.chk('B3 cash ignores a bank account that was sent along', pg_temp.claim(pg_temp.c('c_cash'), 'bank_account_id') is null);
select pg_temp.put('c_vat', pg_temp.save('Printer paper', pg_temp.c('cat_office'), 107, 'cash', null, null, 'vat_included'));
select pg_temp.put('c_draft', pg_temp.save('Still a draft', pg_temp.c('cat_office'), 999, 'bank_transfer', null, pg_temp.c('BBL')));
-- an old app build (11 arguments) records a transfer: it cannot name the bank
select pg_temp.put('c_old', (public.expense_save(null, (now() at time zone 'Asia/Bangkok')::date, pg_temp.c('cat_office')::uuid, 'Old app transfer', 50, 'none', 'bank_transfer', null, null, null, null)).id::text);
select pg_temp.chk('B4 an old app build still saves (the claim simply has no bank account yet)', pg_temp.claim(pg_temp.c('c_old'), 'status') = 'draft' and pg_temp.claim(pg_temp.c('c_old'), 'bank_account_id') is null);

-- ================================================================================================ W. who may do what
select pg_temp.err_like('W1 an employee cannot approve & post', format($q$select public.expense_post_bulk(array[%L::uuid])$q$, pg_temp.c('c_cash')), '%not allowed%');
select pg_temp.err_like('W1 an employee cannot preview a posting', format($q$select public.expense_post_preview(array[%L::uuid])$q$, pg_temp.c('c_cash')), '%not allowed%');
select pg_temp.err_like('W1 an employee cannot see bank balances', 'select public.finance_bank_overview()', '%not allowed%');
set local role authenticated;
select pg_temp.chk('W2 RLS: an employee reads no bank balance and no bank movement', (select count(*) from public.finance_bank_balances) = 0 and (select count(*) from public.finance_bank_transactions) = 0);
reset role;
select pg_temp.as_user(pg_temp.c('M'));
set local role authenticated;
select pg_temp.chk('W2 RLS: a manager who posts expenses reads the balances', (select count(*) from public.finance_bank_balances) = (select count(*) from public.finance_bank_accounts));
reset role;
select pg_temp.err_like('W3 a manager cannot set an opening balance (finance managers only)', format($q$select public.finance_bank_opening(%L, 100000, (now() at time zone 'Asia/Bangkok')::date)$q$, pg_temp.c('SCB')), '%not allowed%');

-- the admin enters the real-world starting point of SCB: 100,000 (the owner's example)
select pg_temp.as_user(pg_temp.c('S'));
select public.finance_bank_opening(pg_temp.c('SCB')::uuid, 100000, (now() at time zone 'Asia/Bangkok')::date - 1, 'Opening balance (test)');
select pg_temp.chk('O1 the opening balance is a ledger row and the balance follows it', pg_temp.bal(pg_temp.c('SCB')) = 100000 and pg_temp.ntx() = 1);
select pg_temp.err_like('O1 a second opening balance is refused', format($q$select public.finance_bank_opening(%L, 5, (now() at time zone 'Asia/Bangkok')::date)$q$, pg_temp.c('SCB')), '%already has an opening balance%');

-- ================================================================================================ D. approve & post (manager, no approval stage)
select pg_temp.as_user(pg_temp.c('M'));
select pg_temp.put('pv', public.expense_post_preview(array[pg_temp.c('c_rm'), pg_temp.c('c_cash'), pg_temp.c('c_old'), pg_temp.c('LEGACY')]::uuid[])::text);
select pg_temp.chk('D1 the preview: 2 can be posted (2,600), the old-app transfer needs a bank, the real posted claim is already posted',
  (pg_temp.c('pv')::jsonb ->> 'ok_count')::int = 2 and (pg_temp.c('pv')::jsonb ->> 'ok_total')::numeric = 2600
  and (select x ->> 'problem' from jsonb_array_elements(pg_temp.c('pv')::jsonb -> 'items') x where x ->> 'id' = pg_temp.c('c_old')) like 'EXP_BANK_REQUIRED%'
  and (select x ->> 'problem' from jsonb_array_elements(pg_temp.c('pv')::jsonb -> 'items') x where x ->> 'id' = pg_temp.c('LEGACY')) like 'EXP_ALREADY_POSTED%', pg_temp.c('pv'));
select pg_temp.chk('D1 the preview shows the bank involved, the money going out and its current balance',
  (select (b ->> 'out')::numeric = 2500 and (b ->> 'balance')::numeric = 100000 and b ->> 'code' = 'SCB' from jsonb_array_elements(pg_temp.c('pv')::jsonb -> 'by_bank') b), pg_temp.c('pv')::jsonb ->> 'by_bank');
select pg_temp.put('r1', public.expense_post_bulk(array[pg_temp.c('c_rm'), pg_temp.c('c_cash'), pg_temp.c('c_old'), pg_temp.c('LEGACY')]::uuid[], 'test-run-1')::text);
select pg_temp.chk('D2 bulk result: 2 posted, 1 skipped (already posted), 1 failed with its reason, total 2,600',
  jsonb_array_length(pg_temp.c('r1')::jsonb -> 'posted') = 2 and jsonb_array_length(pg_temp.c('r1')::jsonb -> 'skipped') = 1 and jsonb_array_length(pg_temp.c('r1')::jsonb -> 'failed') = 1
  and (pg_temp.c('r1')::jsonb ->> 'total_posted')::numeric = 2600 and (pg_temp.c('r1')::jsonb -> 'failed' -> 0 ->> 'code') = 'EXP_BANK_REQUIRED', pg_temp.c('r1'));
select pg_temp.chk('D2 a draft went straight to posted, with a number and the manager as approver',
  pg_temp.claim(pg_temp.c('c_rm'), 'status') = 'posted' and pg_temp.claim(pg_temp.c('c_rm'), 'expense_no') like 'EXP-%' and pg_temp.claim(pg_temp.c('c_rm'), 'approved_by') = pg_temp.c('M')
  and pg_temp.claim(pg_temp.c('c_rm'), 'posted_by') = pg_temp.c('M') and pg_temp.claim(pg_temp.c('c_rm'), 'journal_no') is null);
select pg_temp.chk('D3 SCB: 100,000 - 2,500 = 97,500', pg_temp.bal(pg_temp.c('SCB')) = 97500, pg_temp.bal(pg_temp.c('SCB'))::text);
select pg_temp.put('bt1', pg_temp.claim(pg_temp.c('c_rm'), 'bank_txn_id'));
select pg_temp.chk('D3 the bank movement: EXPENSE, out 2,500, 100,000 -> 97,500, pointing at the expense and its queued journal',
  pg_temp.sv(format($q$select (txn_type = 'EXPENSE' and direction = 'out' and amount = 2500 and balance_before = 100000 and balance_after = 97500 and ref_type = 'expense'
      and ref_id = %L and gl_queue_id = %L and idempotency_key = 'EXPENSE:' || %L)::text from public.finance_bank_transactions where id = %L$q$,
    pg_temp.c('c_rm'), pg_temp.claim(pg_temp.c('c_rm'), 'gl_queue_id'), pg_temp.c('c_rm'), pg_temp.c('bt1'))) = 'true');
select pg_temp.chk('D3 the queued journal: Dr inventory raw materials 2,500 / Cr bank (SCB) 2,500, waiting for the accounting device',
  pg_temp.sv(format($q$select (event_type = 'EXPENSE_PAYMENT' and status = 'pending' and amount = 2500 and ref_id = %L
      and plan = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', 'inv_materials', 'amount', 2500), jsonb_build_object('side', 'cr', 'role', 'bank', 'amount', 2500, 'bank_account_id', %L))
      and detail ->> 'expense_no' like 'EXP-%%')::text from public.finance_gl_queue where id = %L$q$, pg_temp.c('c_rm'), pg_temp.c('SCB'), pg_temp.claim(pg_temp.c('c_rm'), 'gl_queue_id'))) = 'true');
select pg_temp.chk('D3 a cash expense moves no bank and queues Dr expense / Cr cash',
  pg_temp.claim(pg_temp.c('c_cash'), 'bank_txn_id') is null and pg_temp.sv(format($q$select plan::text from public.finance_gl_queue where ref_id = %L$q$, pg_temp.c('c_cash')))::jsonb
    = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', '6300', 'amount', 100), jsonb_build_object('side', 'cr', 'role', 'cash', 'amount', 100)));
select pg_temp.chk('D4 a draft bank transfer did not touch BBL', pg_temp.bal(pg_temp.c('BBL')) = 0 and pg_temp.claim(pg_temp.c('c_draft'), 'status') = 'draft');
select pg_temp.put('ntx1', pg_temp.ntx()::text);
select pg_temp.put('r2', public.expense_post_bulk(array[pg_temp.c('c_rm'), pg_temp.c('c_cash'), pg_temp.c('c_rm')]::uuid[], 'test-run-2')::text);
select pg_temp.chk('D5 posting the same expenses again (and twice in one request): all skipped, no second deduction, no new movement',
  jsonb_array_length(pg_temp.c('r2')::jsonb -> 'posted') = 0 and jsonb_array_length(pg_temp.c('r2')::jsonb -> 'skipped') = 2 and pg_temp.bal(pg_temp.c('SCB')) = 97500 and pg_temp.ntx() = pg_temp.c('ntx1')::int, pg_temp.c('r2'));
select pg_temp.chk('D6 the bank writer itself is idempotent: the same key returns the same movement',
  pg_temp.sv(format($q$select (public.finance_bank_apply(%L, 'EXPENSE', 'out', 2500, current_date, 'expense', %L, null, 'EXPENSE:' || %L)).id::text$q$, pg_temp.c('SCB'), pg_temp.c('c_rm'), pg_temp.c('c_rm'))) = pg_temp.c('bt1')
  and pg_temp.bal(pg_temp.c('SCB')) = 97500 and pg_temp.ntx() = pg_temp.c('ntx1')::int);
select pg_temp.err_like('D6 a second movement with the same key cannot be inserted at all (unique key)',
  format($q$select pg_temp.sx(format('insert into public.finance_bank_transactions (txn_no, bank_account_id, txn_type, direction, amount, balance_before, balance_after, value_date, ref_type, ref_id, idempotency_key) values (''BTX-DUP'', %%L, ''EXPENSE'', ''out'', 2500, 97500, 95000, current_date, ''expense'', %%L, %%L)', %L, %L, 'EXPENSE:' || %L))$q$,
    pg_temp.c('SCB'), pg_temp.c('c_rm'), pg_temp.c('c_rm')), '%duplicate key%');
select pg_temp.as_user(pg_temp.c('E'));
select pg_temp.err_like('D7 the employee cannot edit a posted expense', format($q$select public.expense_save(%L, current_date, null, 'changed', 1, 'none', 'cash', null, null, null, null, null, null)$q$, pg_temp.c('c_rm')), '%Only drafts and rejected%');
select pg_temp.as_user(pg_temp.c('M'));
select pg_temp.err_like('D7 not even a direct update can move a posted expense to another bank', format($q$select pg_temp.sx(format('update public.expense_claims set bank_account_id = %%L where id = %%L', %L, %L))$q$, pg_temp.c('BBL'), pg_temp.c('c_rm')), '%cannot be changed%');
select pg_temp.err_like('D8 a bank movement cannot be edited', format($q$select pg_temp.sx(format('update public.finance_bank_transactions set amount = 1 where id = %%L', %L))$q$, pg_temp.c('bt1')), '%never changed or deleted%');
select pg_temp.err_like('D8 a bank movement cannot be deleted', format($q$select pg_temp.sx(format('delete from public.finance_bank_transactions where id = %%L', %L))$q$, pg_temp.c('bt1')), '%never changed or deleted%');
select pg_temp.err_like('D8 a balance cannot be overwritten', format($q$select pg_temp.sx(format('update public.finance_bank_balances set balance = 1 where bank_account_id = %%L', %L))$q$, pg_temp.c('SCB')), '%only change through a bank transaction%');
select pg_temp.chk('D9 every balance equals its ledger and the chain is unbroken', not exists (select 1 from jsonb_array_elements(public.finance_bank_reconcile()) r where not (r ->> 'ok')::boolean or (r ->> 'chain_breaks')::int <> 0));
select pg_temp.chk('D10 the audit trail: who posted, how, the bank movement and the run',
  pg_temp.sv(format($q$select count(*)::text from public.expense_events where expense_id = %L and action = 'posted' and actor = %L and detail ->> 'via' = 'accounting_approval' and detail ->> 'bank_txn_no' like 'BTX-%%'$q$, pg_temp.c('c_rm'), pg_temp.c('M'))) = '1'
  and pg_temp.sv($q$select count(*)::text from public.expense_events where action = 'post.batch' and entity_id = 'test-run-1'$q$) = '1');
select pg_temp.chk('D11 traceable from the bank: the ledger row names the expense', (select (i -> 'expense' ->> 'id') = pg_temp.c('c_rm') from jsonb_array_elements(public.finance_bank_ledger(pg_temp.c('SCB')::uuid) -> 'items') i where i ->> 'txn_type' = 'EXPENSE'));
select pg_temp.as_user(pg_temp.c('E'));
select pg_temp.put('ln', public.expense_claim_links(pg_temp.c('c_rm')::uuid)::text);
select pg_temp.chk('D11 traceable from the expense: its bank account, queued journal and bank movement (the employee does not see the balance)',
  pg_temp.c('ln')::jsonb -> 'bank_account' ->> 'code' = 'SCB' and pg_temp.c('ln')::jsonb -> 'gl' -> 0 ->> 'event_type' = 'EXPENSE_PAYMENT'
  and pg_temp.c('ln')::jsonb -> 'bank' -> 0 ->> 'txn_no' like 'BTX-%' and pg_temp.c('ln')::jsonb -> 'bank' -> 0 -> 'balance_after' = 'null'::jsonb, pg_temp.c('ln'));

-- ================================================================================================ V. VAT, review, send back
select pg_temp.as_user(pg_temp.c('M'));
select public.expense_post_bulk(array[pg_temp.c('c_vat')]::uuid[]);
select pg_temp.chk('V1 VAT included (107): Dr expense 100 + Dr input VAT 7 / Cr cash 107',
  pg_temp.sv(format($q$select plan::text from public.finance_gl_queue where ref_id = %L$q$, pg_temp.c('c_vat')))::jsonb = jsonb_build_array(jsonb_build_object('side', 'dr', 'role', '6300', 'amount', 100),
    jsonb_build_object('side', 'dr', 'role', 'input_vat', 'amount', 7), jsonb_build_object('side', 'cr', 'role', 'cash', 'amount', 107)));
select pg_temp.chk('X1 the manager marks drafts reviewed (a mark, not a stage)', public.expense_mark_reviewed(array[pg_temp.c('c_draft'), pg_temp.c('c_rm')]::uuid[], 'checked') = 1
  and pg_temp.claim(pg_temp.c('c_draft'), 'reviewed_by') = pg_temp.c('M') and pg_temp.claim(pg_temp.c('c_draft'), 'status') = 'draft');
select public.expense_reject(pg_temp.c('c_fg')::uuid, 'Wrong amount, please check the receipt');
select pg_temp.chk('X2 the manager can send a draft back with a reason', pg_temp.claim(pg_temp.c('c_fg'), 'status') = 'rejected');
select pg_temp.as_user(pg_temp.c('E'));
select public.expense_save(pg_temp.c('c_draft')::uuid, current_date, pg_temp.c('cat_office')::uuid, 'Still a draft', 998, 'none', 'bank_transfer', null, null, null, null, null, pg_temp.c('BBL')::uuid);
select public.expense_save(pg_temp.c('c_fg')::uuid, current_date, null, 'FG restock', 280, 'none', 'cash', null, null, null, null, pg_temp.c('FG'), null);
select pg_temp.chk('X3 an edit after review clears the review; a sent-back expense is a draft again after the fix',
  pg_temp.claim(pg_temp.c('c_draft'), 'reviewed_at') is null and pg_temp.claim(pg_temp.c('c_fg'), 'status') = 'draft' and pg_temp.claim(pg_temp.c('c_fg'), 'amount_paid') = '280.00');
select pg_temp.as_user(pg_temp.c('M'));
select pg_temp.put('c_mine', pg_temp.save('Manager own taxi', pg_temp.c('cat_office'), 80, 'cash', null, null));
select pg_temp.err_like('X4 a manager cannot "send back" his own draft (he edits it)', format($q$select public.expense_reject(%L, 'own draft reason')$q$, pg_temp.c('c_mine')), '%your own draft%');
select pg_temp.chk('X5 the dashboard counts drafts as spending (recorded, waiting for accounting)',
  (public.expense_dashboard(current_date, current_date) -> 'by_status' -> 'draft' ->> 'n')::int >= 3
  and (public.expense_dashboard(current_date, current_date) ->> 'range_total')::numeric >= 998 + 280 + 80 + 2500 + 100 + 107);

-- ================================================================================================ R. reversal
select pg_temp.err_like('R1 a manager cannot reverse a posted expense (accountant / admin)', format($q$select public.expense_reverse(%L, 'Wrong supplier')$q$, pg_temp.c('c_rm')), '%not allowed%');
select pg_temp.as_user(pg_temp.c('S'));
select pg_temp.put('rv1', public.expense_reverse(pg_temp.c('c_rm')::uuid, 'Paid from the wrong account')::text);
select pg_temp.chk('R2 reversed before the journal was posted: the queue row is voided, SCB gets 2,500 back (97,500 -> 100,000), the claim is cancelled',
  (pg_temp.c('rv1')::jsonb ->> 'gl_voided')::boolean and pg_temp.bal(pg_temp.c('SCB')) = 100000 and pg_temp.claim(pg_temp.c('c_rm'), 'status') = 'cancelled'
  and pg_temp.sv(format($q$select status from public.finance_gl_queue where ref_id = %L and event_type = 'EXPENSE_PAYMENT'$q$, pg_temp.c('c_rm'))) = 'void', pg_temp.c('rv1'));
select pg_temp.chk('R2 the reversal is its own movement pointing at the original, which stays as it was',
  pg_temp.sv(format($q$select (txn_type = 'EXPENSE_REVERSAL' and direction = 'in' and amount = 2500 and reversal_of = %L)::text from public.finance_bank_transactions where ref_id = %L and txn_type = 'EXPENSE_REVERSAL'$q$, pg_temp.c('bt1'), pg_temp.c('c_rm'))) = 'true'
  and pg_temp.sv(format($q$select (amount = 2500 and balance_after = 97500)::text from public.finance_bank_transactions where id = %L$q$, pg_temp.c('bt1'))) = 'true');
select pg_temp.put('ntx2', pg_temp.ntx()::text);
select pg_temp.err_like('R3 a second reversal is refused and moves nothing', format($q$select public.expense_reverse(%L, 'Paid from the wrong account')$q$, pg_temp.c('c_rm')), '%already reversed%');
select pg_temp.chk('R3 ... balance and ledger unchanged', pg_temp.bal(pg_temp.c('SCB')) = 100000 and pg_temp.ntx() = pg_temp.c('ntx2')::int);
-- a transfer whose journal the accounting device has already posted
select pg_temp.as_user(pg_temp.c('E'));
select pg_temp.put('c_bbl', pg_temp.save('Packaging boxes', null, 1200, 'qr', pg_temp.c('RM'), pg_temp.c('BBL')));
select pg_temp.as_user(pg_temp.c('S'));
select public.expense_post_bulk(array[pg_temp.c('c_bbl')]::uuid[]);
select pg_temp.chk('R4 a QR payment from BBL (no opening balance yet) goes below zero and says so: 0 -> -1,200', pg_temp.bal(pg_temp.c('BBL')) = -1200);
select public.finance_gl_mark_posted(pg_temp.claim(pg_temp.c('c_bbl'), 'gl_queue_id')::uuid, 'JV-TEST-1', 'finance_event:test-1');
select public.expense_reverse(pg_temp.c('c_bbl')::uuid, 'Supplier refunded the order');
select pg_temp.chk('R4 reversed after the journal was posted: a reversal journal is queued after it, with every side flipped; BBL back to 0',
  pg_temp.sv(format($q$select (r.depends_on = o.id and r.amount = o.amount and r.status = 'pending'
      and r.plan = (select jsonb_agg(l || jsonb_build_object('side', case l ->> 'side' when 'dr' then 'cr' else 'dr' end)) from jsonb_array_elements(o.plan) l)
      and r.detail ->> 'reverses_journal_no' = 'JV-TEST-1')::text
    from public.finance_gl_queue o join public.finance_gl_queue r on r.ref_id = o.ref_id and r.event_type = 'EXPENSE_REVERSAL' where o.ref_id = %L and o.event_type = 'EXPENSE_PAYMENT'$q$, pg_temp.c('c_bbl'))) = 'true'
  and pg_temp.bal(pg_temp.c('BBL')) = 0);
select pg_temp.err_like('R5 an expense posted the old way (device ledger) is reversed on the device, not here', format($q$select public.expense_reverse(%L, 'Some reason')$q$, pg_temp.c('LEGACY')), '%accounting device%');
select pg_temp.err_like('R5 the old device reversal cannot be used on an expense posted here', format($q$select public.expense_mark_reversed(%L, 'JV-X', 'Some reason')$q$, pg_temp.c('c_cash')), '%accounting queue%');
select pg_temp.chk('R6 balances still equal their ledgers after every reversal', not exists (select 1 from jsonb_array_elements(public.finance_bank_reconcile()) r where not (r ->> 'ok')::boolean or (r ->> 'chain_breaks')::int <> 0));

-- ================================================================================================ A. adjustments
select pg_temp.as_user(pg_temp.c('S'));
select public.finance_bank_adjust(pg_temp.c('BBL')::uuid, 'in', 5000, 'Customer transfers not recorded yet (statement 28/11)', 'adj-test-0001');
select public.finance_bank_adjust(pg_temp.c('BBL')::uuid, 'in', 5000, 'Customer transfers not recorded yet (statement 28/11)', 'adj-test-0001');
select pg_temp.chk('A1 an adjustment with a reason moves the balance once, even when sent twice', pg_temp.bal(pg_temp.c('BBL')) = 5000);
select pg_temp.err_like('A1 an adjustment needs a real reason', format($q$select public.finance_bank_adjust(%L, 'out', 10, 'short', 'adj-test-0002')$q$, pg_temp.c('BBL')), '%REASON_TOO_SHORT%');

-- ================================================================================================ Z. nothing else moved
select pg_temp.chk('Z1 the real claims are exactly as they were (fingerprint taken before the test)',
  (select md5(string_agg(to_jsonb(c)::text, '|' order by id)) from public.expense_claims c where c.created_at < now()) = pg_temp.c('legacy_fp')
  and (select count(*) from public.expense_claims where created_at < now()) = pg_temp.c('n_claims0')::int);
select pg_temp.chk('Z1 the real ledger-queue rows are untouched (only expense rows were added)',
  (select count(*) from public.finance_gl_queue where event_type not in ('EXPENSE_PAYMENT', 'EXPENSE_REVERSAL')) = pg_temp.c('q0')::int);

-- the result
do $$ declare r text; begin
  select string_agg(case when ok then 'ok   ' else 'FAIL ' end || test || coalesce(' [' || detail || ']', ''), E'\n' order by n) into r from t_res;
  raise exception E'EXPENSE_BANK_TESTS % of % passed\n%', (select count(*) filter (where ok) from t_res), (select count(*) from t_res), r;
end $$;
