#!/bin/bash
# Proves the rollback of the preorder migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema -> migration 20261128100000 -> [guard scenario] -> rollback -> comparison (+ the preorder cron job and the LINE switches gone).
#   scripts/run-preorders-down-proof.sh            # clean: the rollback must restore the schema exactly (expects "PREORDERS_DOWN_PROOF n of n passed")
#   scripts/run-preorders-down-proof.sh guard      # the rollback must REFUSE while a preorder exists
#   scripts/run-preorders-down-proof.sh control    # sanity check of the comparison: WITHOUT the rollback it must report differences
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live).
# The fingerprint (supabase/tests/slip_review_down_pre.sql) is generic: every public function, table, column, constraint, index, trigger and policy.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"
PRE=supabase/tests/slip_review_down_pre.sql
MIG=supabase/migrations/20261128100000_preorders.sql
DOWN=supabase/rollbacks/20261128100000_preorders_down.sql
POST=supabase/tests/preorders_down_post.sql
# Only meaningful while the live database does not have the migration (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$HERE/db-readonly.sh" "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'preorder_settings') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the preorder migration is already applied to the live database, so this proof can no longer be run here (see docs/preorders.md)." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac
GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT
EXPECT="REFUSING: preorders exist"

run() { "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1; }
result() { grep -o "PREORDERS_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }

case "$MODE" in
  clean)
    printf "%s\n" "select 1;" > "$GUARD"
    run PREORDERS_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "^PASS" "$OUT" && ! grep -q "^FAIL" "$OUT"; then echo "PROVEN: the rollback restores the schema exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    printf "%s\n" "select 1;" > "$GUARD"
    run PREORDERS_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  guard)
    cat > "$GUARD" <<'SQL'
-- one real pick-up order becomes a preorder (the guard trigger is switched off for this one statement only, inside the rolled-back transaction)
alter table public.shop_orders disable trigger shop_orders_guard;
update public.shop_orders set order_type = 'preorder', pickup_at = now() + interval '3 days' where id = (select id from public.shop_orders where fulfilment = 'pickup' order by created_at limit 1);
alter table public.shop_orders enable trigger shop_orders_guard;
SQL
    run PREORDERS_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    if grep -qF "$EXPECT" "$OUT" && ! grep -q "PREORDERS_DOWN_PROOF" "$OUT"; then
      echo "REFUSED: $(grep -F "$EXPECT" "$OUT" | head -n 1 | cut -c1-200)"; echo "PREORDERS_DOWN_GUARD 1 of 1 refused"; exit 0
    fi
    echo "NOT REFUSED (expected: $EXPECT):"; cut -c1-300 "$OUT" | head -n 6; echo "PREORDERS_DOWN_GUARD 0 of 1 refused"; exit 1 ;;
  *) echo "usage: $0 [clean | control | guard]" >&2; exit 2 ;;
esac
