#!/bin/bash
# Proves the rollback of the LINE OA migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema -> migration 20261122140000 -> [guard scenario] -> rollback -> comparison (+ cron job and Vault secrets gone).
#   scripts/run-line-down-proof.sh            # clean: the rollback must restore the schema exactly (expects "LINE_DOWN_PROOF n of n passed")
#   scripts/run-line-down-proof.sh guard      # the rollback must REFUSE while a transfer is confirmed without a bank reference (the old Post could not post it)
#   scripts/run-line-down-proof.sh control    # sanity check of the comparison: WITHOUT the rollback it must report differences
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live).
# The fingerprint (supabase/tests/slip_review_down_pre.sql) is generic: every public function, table, column, constraint, index, trigger and policy.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"
PRE=supabase/tests/slip_review_down_pre.sql
MIG=supabase/migrations/20261122140000_line_order_notifications.sql
DOWN=supabase/rollbacks/20261122140000_line_order_notifications_down.sql
POST=supabase/tests/line_down_post.sql
# Only meaningful while the live database does not have the migration (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$HERE/db-readonly.sh" "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'line_settings') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the LINE migration is already applied to the live database, so this proof can no longer be run here (see docs/line-notifications.md)." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac
GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT
EXPECT="Confirmed transfers without a bank reference exist"

run() { "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1; }
result() { grep -o "LINE_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }

case "$MODE" in
  clean)
    printf "%s\n" "select 1;" > "$GUARD"
    run LINE_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "^PASS" "$OUT" && ! grep -q "^FAIL" "$OUT"; then echo "PROVEN: the rollback restores the schema exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    printf "%s\n" "select 1;" > "$GUARD"
    run LINE_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  guard)
    cat > "$GUARD" <<'SQL'
do $g$ declare v_c uuid; v_i uuid;
begin
  insert into public.finance_customers (code, name) values ('LINE-DOWN-GUARD', 'Line down guard test') returning id into v_c;
  insert into public.finance_invoices (invoice_no, customer_id, issue_date, due_date, amount) values ('INV-LINE-DOWN-GUARD', v_c, current_date, current_date, 100) returning id into v_i;
  insert into public.finance_payment_evidence (invoice_id, customer_id, file_path, file_sha256, file_type, claimed_amount, status, method, confirmed_amount, confirmed_transfer_at, confirmed_via)
    values (v_i, v_c, 'line-down-guard/a', repeat('f', 64), 'image/png', 100, 'confirmed', 'transfer', 100, now(), 'line_quick');
end $g$;
SQL
    run LINE_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    if grep -qF "$EXPECT" "$OUT" && ! grep -q "LINE_DOWN_PROOF" "$OUT"; then
      echo "REFUSED: $(grep -F "$EXPECT" "$OUT" | head -n 1 | cut -c1-200)"; echo "LINE_DOWN_GUARD 1 of 1 refused"; exit 0
    fi
    echo "NOT REFUSED (expected: $EXPECT):"; cut -c1-300 "$OUT" | head -n 6; echo "LINE_DOWN_GUARD 0 of 1 refused"; exit 1 ;;
  *) echo "usage: $0 [clean | control | guard]" >&2; exit 2 ;;
esac
