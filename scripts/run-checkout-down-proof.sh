#!/bin/bash
# Proves the checkout (slip + optional address) rollback inside ONE transaction that always rolls back (nothing persists):
#   migrations 1-3 -> schema fingerprint -> migration 4 -> [guard scenario: a delivery order without an address] -> rollback -> comparison.
#   scripts/run-checkout-down-proof.sh           # the rollback must restore the schema exactly (expects "CHECKOUT_DOWN_PROOF n of n passed")
#   scripts/run-checkout-down-proof.sh guard     # the rollback must REFUSE because a delivery order has no address
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-clean}"
# This proof compares the schema before and after "migration + rollback" INSIDE a rolled-back transaction, so it only means something while the
# live database does not have the migration yet. Once it is applied, the "before" snapshot already contains it: refuse instead of reporting nonsense.
APPLIED=$(bash "$(dirname "$0")/db-readonly.sh" "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shop_settings' and column_name = 'require_payment_slip') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the checkout migration is already applied to the live database, so this proof can no longer be run here (it passed before it was applied; see the commit message)." >&2; exit 3;; esac
GUARD=$(mktemp); trap 'rm -f "$GUARD"' EXIT
if [ "$MODE" = "guard" ]; then
  # the rollback refuses once a delivery order has no address. Placing an order needs a login, so insert a minimal one directly (these rows exist
  # only inside this transaction, which is rolled back) and expect the refusal.
  cat > "$GUARD" <<'SQL'
do $g$ declare v_p uuid; v_c uuid; v_i uuid;
begin
  select id into v_p from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1;
  insert into public.finance_customers (code, name, profile_id) values ('GUARD-TEST', 'Guard test', v_p) on conflict do nothing;
  select id into v_c from public.finance_customers where profile_id = v_p order by created_at limit 1;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount) values ('INV-GUARD-1', v_c, current_date, current_date, 10) returning id into v_i;
  insert into public.shop_orders (order_no, profile_id, customer_id, idempotency_key, request_hash, fulfilment, contact_name, contact_phone, subtotal, total, invoice_id)
    values ('SO-GUARD-1', v_p, v_c, 'guard-key-0001', 'x', 'delivery', 'x', '0812345678', 10, 10, v_i);
end $g$;
SQL
else
  printf "%s\n" "select 1;" > "$GUARD"
fi
exec "$(dirname "$0")/run-sql-tests.sh" CHECKOUT_DOWN_PROOF \
  supabase/migrations/20261115100000_customer_shop.sql supabase/migrations/20261115200000_wallet_payments.sql supabase/migrations/20261115300000_online_ordering.sql \
  supabase/tests/checkout_down_pre.sql supabase/migrations/20261115400000_checkout_slip_pickup.sql "$GUARD" supabase/rollbacks/20261115400000_checkout_slip_pickup_down.sql supabase/tests/checkout_down_post.sql
