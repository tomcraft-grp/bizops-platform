-- Data fingerprint taken BEFORE 20261128160000_expense_bank_posting.sql in the rollback proof (the schema fingerprint is supabase/tests/slip_review_down_pre.sql).
create temp table d_cats as select * from public.expense_categories;
create temp table d_claims as select * from public.expense_claims;
create temp table d_banks as select * from public.finance_bank_accounts;
