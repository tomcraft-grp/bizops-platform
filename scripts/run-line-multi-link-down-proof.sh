#!/bin/bash
# Proves the rollback of the LINE multi-link migration inside ONE transaction that always rolls back (nothing persists):
#   fingerprint of the whole public schema -> migration 20261128120000 -> rollback -> comparison.
#   scripts/run-line-multi-link-down-proof.sh            # clean: the rollback must restore the schema exactly (expects "LINE_MULTI_LINK_DOWN_PROOF n of n passed")
#   scripts/run-line-multi-link-down-proof.sh control    # sanity check of the comparison: WITHOUT the rollback it must report differences
# Exit code: 0 = proven, 1 = not proven, 3 = refused to run (the migration is already live).
# The fingerprint (supabase/tests/slip_review_down_pre.sql) is generic: every public function, table, column, constraint, index, trigger and policy.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE/.."
MODE="${1:-clean}"
PRE=supabase/tests/slip_review_down_pre.sql
MIG=supabase/migrations/20261128120000_line_multi_link.sql
DOWN=supabase/rollbacks/20261128120000_line_multi_link_down.sql
POST=supabase/tests/line_multi_link_down_post.sql
# Only meaningful while the live database does not have the migration (otherwise the "before" snapshot already contains it).
APPLIED=$(bash "$HERE/db-readonly.sh" "select exists (select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'line_unlink_account') as applied")
case "$APPLIED" in *'"applied":true'*) echo "REFUSING: the LINE multi-link migration is already applied to the live database, so this proof can no longer be run here (see docs/line-notifications.md)." >&2; exit 3;; esac
case "$APPLIED" in *'"applied":false'*) ;; *) echo "REFUSING: could not tell whether the migration is live: $APPLIED" >&2; exit 3;; esac

GUARD=$(mktemp); OUT=$(mktemp); trap 'rm -f "$GUARD" "$OUT"' EXIT

run() { "$HERE/run-sql-tests.sh" "$@" > "$OUT" 2>&1; }
result() { grep -o "LINE_MULTI_LINK_DOWN_PROOF [0-9]* of [0-9]* passed" "$OUT" | head -n 1; }

case "$MODE" in
  clean)
    printf "%s\n" "select 1;" > "$GUARD"
    run LINE_MULTI_LINK_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "NOT PROVEN: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" = "$m" ] && grep -q "^PASS" "$OUT" && ! grep -q "^FAIL" "$OUT"; then echo "PROVEN: the rollback restores the schema exactly ($R)"; exit 0; fi
    echo "NOT PROVEN: $R"; exit 1 ;;
  control)
    printf "%s\n" "select 1;" > "$GUARD"
    run LINE_MULTI_LINK_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$POST"
    cat "$OUT"
    R=$(result); [ -n "$R" ] || { echo "CONTROL FAILED: no result came back"; exit 1; }
    n=$(echo "$R" | awk '{print $2}'); m=$(echo "$R" | awk '{print $4}')
    if [ "$n" -lt "$m" ]; then echo "CONTROL OK: without the rollback the comparison finds the difference ($R)"; exit 0; fi
    echo "CONTROL FAILED: the comparison did not notice the migration ($R)"; exit 1 ;;
  guard)
    cat > "$GUARD" <<'SQL'
-- one real staff account gets a second LINE account (so the old table could not hold them)
insert into public.line_staff_links (profile_id, line_user_id, display_name) select profile_id, 'Utest-down-guard-0001', 'Guard' from public.line_staff_links limit 1;
insert into public.line_staff_links (profile_id, line_user_id, display_name) select profile_id, 'Utest-down-guard-0002', 'Guard two' from public.line_staff_links limit 1;
SQL
    run LINE_MULTI_LINK_DOWN_PROOF "$PRE" "$MIG" "$GUARD" "$DOWN" "$POST"
    if grep -qF "REFUSING: a staff account has more than one LINE account" "$OUT" && ! grep -q "LINE_MULTI_LINK_DOWN_PROOF" "$OUT"; then
      echo "REFUSED: $(grep -F "REFUSING" "$OUT" | head -n 1 | cut -c1-200)"; echo "LINE_MULTI_LINK_DOWN_GUARD 1 of 1 refused"; exit 0
    fi
    echo "NOT REFUSED:"; cut -c1-300 "$OUT" | head -n 6; echo "LINE_MULTI_LINK_DOWN_GUARD 0 of 1 refused"; exit 1 ;;
  *) echo "usage: $0 [clean | control | guard]" >&2; exit 2 ;;
esac
