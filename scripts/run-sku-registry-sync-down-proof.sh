#!/bin/bash
# Proves the rollback of the SKU registry change-feed migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema -> migration 20261121120000 -> [guard scenario] -> rollback -> comparison.
#   scripts/run-sku-registry-sync-down-proof.sh                 # clean: the rollback must restore the schema exactly (expects "SKU_SYNC_DOWN_PROOF n of n passed")
#   scripts/run-sku-registry-sync-down-proof.sh guard           # the rollback must REFUSE once a change-log row exists; expects "SKU_SYNC_DOWN_GUARD 1 of 1 refused"
#   scripts/run-sku-registry-sync-down-proof.sh control         # sanity check of the comparison: WITHOUT the rollback it must report differences
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live, see below).
# NOT YET RUN: written for the files' final locations (supabase/migrations/..., supabase/rollbacks/...), which the coordinator creates from supabase/wip/.
# Local equivalents (real PostgreSQL, never the Supabase project), as run during development:
#   node scripts/local-pg/run.mjs --skip sku_registry_sync supabase/tests/sku_registry_sync_down_pre.sql <migration> <down> supabase/tests/sku_registry_sync_down_post.sql
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"
MIG=supabase/migrations/20261121120000_sku_registry_sync.sql
DOWN=supabase/rollbacks/20261121120000_sku_registry_sync_down.sql
# This proof compares the schema before and after "migration + rollback" INSIDE a rolled-back transaction, so it only means something while the live database
# does not have the migration yet. Once it is applied, the "before" snapshot already contains it: refuse instead of reporting nonsense.
APPLIED=$(bash "$HERE/db-readonly.sh" "select to_regclass('public.sku_registry_changes') is not null as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the SKU registry sync migration is already applied to the live database, so this proof can no longer be run here." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac
GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT

run() { "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1; }       # the text of the answer goes to $OUT
result() { grep -o "SKU_SYNC_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }

case "$MODE" in
  clean)
    printf "%s\n" "select 1;" > "$GUARD"
    run SKU_SYNC_DOWN_PROOF supabase/tests/sku_registry_sync_down_pre.sql "$MIG" "$GUARD" "$DOWN" supabase/tests/sku_registry_sync_down_post.sql
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "^PASS" "$OUT" && ! grep -q "^FAIL" "$OUT"; then echo "PROVEN: the rollback restores the schema exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    printf "%s\n" "select 1;" > "$GUARD"
    run SKU_SYNC_DOWN_PROOF supabase/tests/sku_registry_sync_down_pre.sql "$MIG" "$GUARD" supabase/tests/sku_registry_sync_down_post.sql
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  guard)
    # One registry change (a price) between the migration and the rollback writes one change-log row (the rows exist only inside this transaction).
    printf "%s\n" "update public.sku_registry set selling_price = coalesce(selling_price, 0) + 1 where sku_code = (select min(sku_code) from public.sku_registry);" > "$GUARD"
    EXPECT="The SKU change log holds rows"
    run SKU_SYNC_DOWN_PROOF supabase/tests/sku_registry_sync_down_pre.sql "$MIG" "$GUARD" "$DOWN" supabase/tests/sku_registry_sync_down_post.sql
    if grep -qF "$EXPECT" "$OUT" && ! grep -q "SKU_SYNC_DOWN_PROOF" "$OUT"; then
      echo "REFUSED: $(grep -F "$EXPECT" "$OUT" | head -n 1 | cut -c1-200)"; echo "SKU_SYNC_DOWN_GUARD 1 of 1 refused"; exit 0
    fi
    echo "NOT REFUSED (expected: $EXPECT):"; cut -c1-300 "$OUT" | head -n 6
    echo "SKU_SYNC_DOWN_GUARD 0 of 1 refused"; exit 1 ;;
  *) echo "usage: $0 [clean | control | guard]" >&2; exit 2 ;;
esac
