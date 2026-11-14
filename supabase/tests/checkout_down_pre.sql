-- Proof that supabase/rollbacks/20261115400000_checkout_slip_pickup_down.sql really undoes the migration. Run through
-- scripts/run-checkout-down-proof.sh inside ONE transaction that always rolls back (nothing persists):
--   migrations 1-3 -> THIS FILE (fingerprint) -> migration 4 -> the rollback -> checkout_down_post.sql (compare).
create temp table d_funcs as
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as h   -- line-ending style is ignored; the text of every function must be identical
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f';
create temp table d_cols as
  select table_name, column_name, is_nullable, data_type from information_schema.columns
  where table_schema = 'public' and table_name in ('shop_orders', 'shop_settings', 'finance_payment_evidence');
create temp table d_con as
  select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid in ('public.shop_orders'::regclass, 'public.shop_settings'::regclass);
create temp table d_rels as
  select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'S', 'v', 'm');
create temp table d_trg as
  select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal;
