#!/bin/bash
# Proves the rollback of the delivery-pin migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema -> migration 20261128130000 -> rollback -> comparison.
#   scripts/run-delivery-pin-down-proof.sh            # clean: the rollback must restore the schema exactly (expects "DELIVERY_PIN_DOWN_PROOF n of n passed")
#   scripts/run-delivery-pin-down-proof.sh control    # sanity check of the comparison: WITHOUT the rollback it must report differences
#   scripts/run-delivery-pin-down-proof.sh guard      # the rollback must REFUSE while a saved address exists
#   scripts/run-delivery-pin-down-proof.sh guard-pin  # ... and while an order carries a delivery pin
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"
PRE=supabase/tests/slip_review_down_pre.sql
MIG=supabase/migrations/20261128130000_delivery_pin.sql
DOWN=supabase/rollbacks/20261128130000_delivery_pin_down.sql
POST=supabase/tests/delivery_pin_down_post.sql
APPLIED=$(bash "$HERE/db-readonly.sh" "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'shop_order_delivery') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the delivery pin migration is already applied to the live database, so this proof can no longer be run here (see docs/delivery-pin.md)." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac

GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT
run() { "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1; }
result() { grep -o "DELIVERY_PIN_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }

case "$MODE" in
  clean)
    printf "%s\n" "select 1;" > "$GUARD"
    run DELIVERY_PIN_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "^PASS" "$OUT" && ! grep -q "^FAIL" "$OUT"; then echo "PROVEN: the rollback restores the schema exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    printf "%s\n" "select 1;" > "$GUARD"
    run DELIVERY_PIN_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  guard|guard-pin)
    if [ "$MODE" = guard ]; then
      cat > "$GUARD" <<'SQL'
-- a real customer saves one delivery address
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1), 'role', 'authenticated')::text, true);
select public.shop_address_save(null, '{"lat":13.77,"lng":100.33,"confirmed":true,"pin_source":"tap","recipient_name":"Guard","recipient_phone":"0891234567","address_line":"12345 Guard Road"}'::jsonb, 'Guard');
SQL
      EXPECT="REFUSING: 1 saved delivery addresses exist"
    else
      cat > "$GUARD" <<'SQL'
-- a real customer places one delivery order with a pin
update public.shop_settings set shop_open = true, delivery_enabled = true, require_payment_slip = false, shipping_fee = 0, free_shipping_min = null where id;
select set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where role = 'USER' and status = 'active' order by created_at limit 1), 'role', 'authenticated')::text, true);
select public.shop_place_order('guard-pin-0001', jsonb_build_array(jsonb_build_object('sku_code', (select sku_code from public.shop_sellable where available order by sku_seq limit 1), 'qty', 1)), 'delivery', 'Guard', '0891234567', null, null, null, null, null, null, null, null, null, null,
  '{"lat":13.77,"lng":100.33,"confirmed":true,"pin_source":"tap","recipient_name":"Guard","recipient_phone":"0891234567","address_line":"12345 Guard Road"}'::jsonb);
SQL
      EXPECT="REFUSING: 1 orders carry a delivery pin"
    fi
    run DELIVERY_PIN_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    if grep -qF "$EXPECT" "$OUT" && ! grep -q "DELIVERY_PIN_DOWN_PROOF" "$OUT"; then
      echo "REFUSED: $(grep -F "REFUSING" "$OUT" | head -n 1 | cut -c1-200)"; echo "DELIVERY_PIN_DOWN_GUARD 1 of 1 refused"; exit 0
    fi
    echo "NOT REFUSED:"; cut -c1-300 "$OUT" | head -n 8; echo "DELIVERY_PIN_DOWN_GUARD 0 of 1 refused"; exit 1 ;;
  *) echo "usage: $0 [clean | control | guard | guard-pin]" >&2; exit 2 ;;
esac
