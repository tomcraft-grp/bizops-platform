#!/bin/bash
# Proves the rollback of the LINE card map migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema -> migration 20261128140000 -> rollback -> comparison.
#   scripts/run-line-card-map-down-proof.sh            # clean: the rollback must restore the schema exactly (expects "LINE_CARD_MAP_DOWN_PROOF n of n passed")
#   scripts/run-line-card-map-down-proof.sh control    # sanity check of the comparison: WITHOUT the rollback it must report differences
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"
PRE=supabase/tests/slip_review_down_pre.sql
MIG=supabase/migrations/20261128140000_line_card_map.sql
DOWN=supabase/rollbacks/20261128140000_line_card_map_down.sql
POST=supabase/tests/line_card_map_down_post.sql
APPLIED=$(bash "$HERE/db-readonly.sh" "select (position('shop_order_delivery' in pg_get_functiondef('public.line_card_data(uuid)'::regprocedure)) > 0) as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the LINE card map migration is already applied to the live database, so this proof can no longer be run here (see docs/line-notifications.md)." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac
GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT
run() { "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1; }
result() { grep -o "LINE_CARD_MAP_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }
printf "%s\n" "select 1;" > "$GUARD"
case "$MODE" in
  clean)
    run LINE_CARD_MAP_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"; cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "^PASS" "$OUT" && ! grep -q "^FAIL" "$OUT"; then echo "PROVEN: the rollback restores the schema exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    run LINE_CARD_MAP_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$POST"; cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  *) echo "usage: $0 [clean | control]" >&2; exit 2 ;;
esac
